// Server-only: the actual bytes. Everything here is cancellable, streams
// rather than slurps, and reports progress often enough that a 4 GB file does
// not look like a hang.
import { dirname } from "../lib/path.ts";

export type WalkItem = {
  /** Absolute source path. */
  path: string;
  /** Path relative to the operation root, so the destination can mirror it. */
  rel: string;
  kind: "file" | "dir" | "link";
  size: number;
  mode: number;
  mtime: number | null;
};

const CHUNK = 1 << 20; // 1 MiB — big enough to stream at disk speed

async function statOf(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch {
    return null;
  }
}

/** Depth-first expansion of the operation's sources. Directories come before
 *  their contents so the destination tree can be created on the way down. */
export async function walk(
  roots: string[],
  signal?: AbortSignal,
): Promise<WalkItem[]> {
  const out: WalkItem[] = [];

  async function visit(path: string, rel: string): Promise<void> {
    if (signal?.aborted) return;
    const st = await statOf(path);
    if (!st) return;
    const kind = st.isSymlink ? "link" : st.isDirectory ? "dir" : "file";
    out.push({
      path,
      rel,
      kind,
      size: kind === "file" ? st.size : 0,
      mode: (st.mode ?? 0o644) & 0o7777,
      mtime: st.mtime?.getTime() ?? null,
    });
    if (kind !== "dir") return;
    try {
      for await (const e of Deno.readDir(path)) {
        if (signal?.aborted) return;
        await visit(`${path}/${e.name}`, `${rel}/${e.name}`);
      }
    } catch { /* unreadable subtree — reported per-file by the caller */ }
  }

  for (const root of roots) {
    const name = root.split("/").filter(Boolean).pop() ?? root;
    await visit(root, name);
  }
  return out;
}

export const totalBytes = (items: WalkItem[]): number =>
  items.reduce((n, i) => n + i.size, 0);

export async function exists(path: string): Promise<boolean> {
  return (await statOf(path)) !== null;
}

/** Are these two paths the same bytes on disk?
 *
 *  `dev`+`ino`, never the spelling: `/tmp/./a`, a symlinked parent and a second
 *  hard link all name one file. It matters because the destination is opened
 *  with `truncate` — copying a file onto itself emptied it before the first
 *  read, and reported success. */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([statOf(a), statOf(b)]);
  return !!x && !!y && x.ino !== null && x.ino === y.ino && x.dev === y.dev;
}

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** Copy one file, streaming, reporting bytes as they land. Preserves mode and
 *  mtime — a copy that loses the executable bit is a broken copy.
 *
 *  `append` is mc's two other answers to "this file exists". Both add to the
 *  destination instead of replacing it: "Append" from the start of the source,
 *  "Reget" from `from` bytes in, which is how a copy that died halfway is
 *  finished rather than started again. Neither stamps the destination with the
 *  SOURCE's mode and time — the result is a file neither of them describes. */
export async function copyFile(
  src: string,
  dst: string,
  item: WalkItem,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
  append?: { from: number },
): Promise<void> {
  const inf = await Deno.open(src, { read: true });
  try {
    if (append && append.from > 0) {
      await inf.seek(append.from, Deno.SeekMode.Start);
    }
    const outf = await Deno.open(dst, {
      write: true,
      create: true,
      append: !!append,
      truncate: !append,
    });
    try {
      const buf = new Uint8Array(CHUNK);
      for (;;) {
        if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
        const n = await inf.read(buf);
        if (n === null) break;
        let written = 0;
        while (written < n) {
          written += await outf.write(buf.subarray(written, n));
        }
        onBytes(n);
      }
    } finally {
      outf.close();
    }
  } finally {
    inf.close();
  }
  if (append) return;
  await Deno.chmod(dst, item.mode).catch(() => {});
  if (item.mtime !== null) {
    await Deno.utime(dst, new Date(item.mtime), new Date(item.mtime)).catch(
      () => {},
    );
  }
}

export async function mkdirp(path: string, mode?: number): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode });
}

/** Recreate a symlink rather than following it — copying the target would
 *  silently turn a 12-byte link into a 4 GB duplicate. */
export async function copyLink(src: string, dst: string): Promise<void> {
  const target = await Deno.readLink(src);
  await Deno.remove(dst).catch(() => {});
  await Deno.symlink(target, dst);
}

/** Same-filesystem move is a rename: instant, atomic, and the only sane path
 *  for a 4 GB file. Returns false when the kernel refuses (cross-device), which
 *  is the caller's cue to fall back to copy+delete. */
export async function tryRename(src: string, dst: string): Promise<boolean> {
  try {
    await Deno.rename(src, dst);
    return true;
  } catch {
    return false;
  }
}

/** Is this a directory with anything in it? mc's second delete question hangs
 *  on exactly this, and asking it costs one `readDir` of one entry. */
export async function isNonEmptyDir(path: string): Promise<boolean> {
  const st = await statOf(path);
  if (!st?.isDirectory) return false;
  try {
    for await (const _ of Deno.readDir(path)) return true;
  } catch {
    return false;
  }
  return false;
}

export async function remove(
  path: string,
  recursive: boolean,
): Promise<string | null> {
  try {
    await Deno.remove(path, { recursive });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function rename(from: string, to: string): Promise<string | null> {
  try {
    await Deno.rename(from, to);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** What is known about a name that already exists — mc's overwrite dialog
 *  shows all of it, and its "Older"/"Smaller"/"Size differs" answers are
 *  decided from it. */
export type Collision = {
  src: string;
  dst: string;
  srcSize: number;
  srcTime: number;
  dstSize: number;
  dstTime: number;
  /** mc offers Append only when the destination is not a directory, and Reget
   *  only when it is a non-empty file SHORTER than the source — which is what
   *  an interrupted copy leaves behind. */
  canAppend: boolean;
  canReget: boolean;
};

/** What to do about a file that failed. */
export type ErrorChoice = "retry" | "skip" | "skipAll" | "cancel";

/** …and what to do about it. `append.from` is Reget's resume point. */
export type Decision =
  | { action: "overwrite" | "skip" | "cancel" }
  | { action: "append"; from: number };

export type Hooks = {
  /** Called as each item starts, with the running file counter. */
  onFile: (path: string, doneFiles: number) => void;
  /** Called with each chunk of bytes written. */
  onBytes: (n: number) => void;
  /** Something went wrong with one file. mc stops and offers Retry, Skip,
   *  Ignore-all and Abort — the Retry is the point: a copy that died on a full
   *  disk can be finished after making room, and one that only reported the
   *  failure at the end cannot. */
  onError: (path: string, message: string) => Promise<ErrorChoice>;
  /** Ask the user about an existing destination. The caller owns stickiness
   *  ("overwrite all", "older", "size differs") — this module asks once per
   *  collision, hands over both files' facts so the answer can be about them,
   *  and obeys whatever comes back. */
  ask: (c: Collision) => Promise<Decision>;
  signal?: AbortSignal;
};

/** The copy/move engine. Returns per-file errors rather than throwing: one
 *  unreadable file in a 10_000-file tree must not abandon the other 9_999. */
export async function transfer(
  items: WalkItem[],
  destDir: string,
  move: boolean,
  h: Hooks,
): Promise<string[]> {
  const errors: string[] = [];
  let done = 0;

  // mc's rule for the destination box, in both of its halves.
  //
  //  - One FILE plus a name that is not an existing directory means "copy it AS
  //    that name". Without this, `F5` on `notes.txt` with `/tmp/backup.txt`
  //    typed in produced the directory `/tmp/backup.txt/` containing
  //    `notes.txt` — which is nobody's intent.
  //  - One DIRECTORY plus a name that does not exist at all means "put it there
  //    UNDER that name" — mc's `do_move_dir_dir`, which is how `F6` on `src`
  //    with `/tmp/old-src` typed in renames rather than making `/tmp/old-src/src`.
  //    An existing destination directory keeps mc's other rule (dive into it).
  //
  // The roots of the walk are the items whose `rel` has no separator; a
  // directory brings its whole subtree along, so `items.length` cannot answer
  // "how many things did the user pick".
  const roots = items.filter((i) => !i.rel.includes("/"));
  const single = roots.length === 1 ? roots[0]! : null;
  const asName = !!single &&
    (single.kind === "dir" ? !await exists(destDir) : !await isDir(destDir));
  /** Where one item lands, once "as that name" has been decided. */
  const target = (item: WalkItem): string =>
    !asName
      ? `${destDir}/${item.rel}`
      : item.rel === single!.rel
      ? destDir
      : `${destDir}/${item.rel.slice(single!.rel.length + 1)}`;

  // A directory cannot receive itself. The walk is a snapshot, so this would
  // not loop — it would quietly build `/a/sub/a/…` out of the tree the user
  // asked to copy, which is nobody's intent and mc refuses outright.
  const swallowing = items.find((i) =>
    i.kind === "dir" && (destDir === i.path || destDir.startsWith(`${i.path}/`))
  );
  if (swallowing) {
    return [`${swallowing.path}: cannot copy a directory into itself`];
  }

  // Moving a whole directory to a name that does not exist is ONE rename when
  // the filesystem allows it — mc does the same, and the alternative is copying
  // a gigabyte to move it three characters sideways.
  if (move && asName && single!.kind === "dir") {
    await mkdirp(dirname(destDir));
    if (await tryRename(single!.path, destDir)) {
      h.onFile(single!.path, items.length);
      h.onBytes(totalBytes(items));
      return errors;
    }
  }

  /** Set by "Ignore all": from then on a failure is recorded and skipped
   *  without stopping, which is what makes a 10_000-file copy over a flaky
   *  mount finishable. */
  let ignoreAll = false;

  /** What became of one item. `cancel` unwinds the whole operation. */
  type Verdict = "done" | "skipped" | "cancel";

  /** One item, start to finish. Throws on an I/O failure, which the caller
   *  turns into mc's Retry / Skip / Ignore-all / Abort question. */
  const one = async (item: WalkItem, dst: string): Promise<Verdict> => {
    if (item.kind === "dir") {
      await mkdirp(dst, item.mode);
      return "done";
    }

    // Source and destination are one file: there is nothing to copy, and
    // opening the destination would destroy it. mc's "cannot copy a file onto
    // itself", and the reason F5 in a panel pointed at its own directory is
    // safe.
    if (await sameFile(item.path, dst)) {
      errors.push(`${item.path}: source and destination are the same file`);
      h.onBytes(item.size);
      return "done";
    }

    let append: { from: number } | undefined;
    const dstStat = await statOf(dst);
    if (dstStat) {
      const a = await h.ask({
        src: item.path,
        dst,
        srcSize: item.size,
        srcTime: item.mtime ?? 0,
        dstSize: dstStat.size,
        dstTime: dstStat.mtime?.getTime() ?? 0,
        canAppend: !dstStat.isDirectory,
        canReget: !dstStat.isDirectory && dstStat.size > 0 &&
          item.size > dstStat.size,
      });
      if (a.action === "cancel") return "cancel";
      if (a.action === "skip") {
        h.onBytes(item.size); // keep the progress bar honest about the total
        return "skipped";
      }
      if (a.action === "append") append = { from: a.from };
    }

    await mkdirp(dirname(dst));

    if (item.kind === "link") {
      await copyLink(item.path, dst);
      if (move) await Deno.remove(item.path).catch(() => {});
    } else if (move && !append && await tryRename(item.path, dst)) {
      h.onBytes(item.size); // a rename moves every byte at once
    } else {
      await copyFile(item.path, dst, item, h.onBytes, h.signal, append);
      if (move) await Deno.remove(item.path).catch(() => {});
    }
    return "done";
  };

  for (const item of items) {
    if (h.signal?.aborted) break;
    const dst = target(item);
    h.onFile(item.path, done);

    let verdict: Verdict = "skipped";
    // Retry loops here, and nowhere else: everything the attempt needs is
    // recomputed by `one`, so a second go is a genuine second go.
    for (;;) {
      try {
        verdict = await one(item, dst);
        if (verdict !== "cancel") done++;
        break;
      } catch (e) {
        if (h.signal?.aborted) {
          verdict = "cancel";
          break;
        }
        const message = e instanceof Error ? e.message : String(e);
        const choice = ignoreAll ? "skip" : await h.onError(item.path, message);
        if (choice === "retry") continue;
        if (choice === "skipAll") ignoreAll = true;
        errors.push(`${item.path}: ${message}`);
        done++;
        verdict = choice === "cancel" ? "cancel" : "skipped";
        break;
      }
    }
    if (verdict === "cancel") break;
  }

  // A move leaves the source directories behind; remove them deepest-first,
  // and only if they actually emptied — a skipped file must keep its parent.
  if (move && !h.signal?.aborted) {
    for (const item of [...items].reverse()) {
      if (item.kind !== "dir") continue;
      await Deno.remove(item.path).catch(() => {});
    }
  }

  return errors;
}

/** Byte-for-byte equality — mc's "thorough" compare.
 *
 *  Streamed in chunks and short-circuited on the first difference, because the
 *  answer for two files that differ in their first block must not cost two
 *  reads of a gigabyte. Different sizes are answered without opening anything. */
export async function sameContent(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([statOf(a), statOf(b)]);
  if (!x || !y || x.size !== y.size) return false;
  if (x.ino !== null && x.ino === y.ino && x.dev === y.dev) return true;

  const [fa, fb] = await Promise.all([
    Deno.open(a, { read: true }),
    Deno.open(b, { read: true }),
  ]);
  try {
    const ba = new Uint8Array(CHUNK), bb = new Uint8Array(CHUNK);
    for (;;) {
      const na = await readFull(fa, ba);
      const nb = await readFull(fb, bb);
      if (na !== nb) return false;
      if (na === 0) return true;
      for (let i = 0; i < na; i++) if (ba[i] !== bb[i]) return false;
    }
  } finally {
    fa.close();
    fb.close();
  }
}

/** Fill `buf` as far as the file allows — one `read` can return short, and a
 *  short read on one side would otherwise "differ" from a full one on the
 *  other. Returns the number of bytes read, 0 at end of file. */
async function readFull(f: Deno.FsFile, buf: Uint8Array): Promise<number> {
  let n = 0;
  while (n < buf.length) {
    const r = await f.read(buf.subarray(n));
    if (r === null) break;
    n += r;
  }
  return n;
}

export async function chmod(
  path: string,
  mode: number,
): Promise<string | null> {
  try {
    await Deno.chmod(path, mode);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function symlink(
  target: string,
  path: string,
): Promise<string | null> {
  try {
    await Deno.symlink(target, path);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Point an existing symlink somewhere else.
 *
 *  A symlink's target cannot be edited in place, so the old link is removed and
 *  a new one takes its name. The `isSymlink` check is what makes that safe: on
 *  anything else this would be a delete, and C-x C-s on a mistyped row must not
 *  be able to remove a real file. */
export async function retarget(
  path: string,
  target: string,
): Promise<string | null> {
  try {
    if (!(await Deno.lstat(path)).isSymlink) return "not a symbolic link";
    await Deno.remove(path);
    await Deno.symlink(target, path);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function hardlink(
  target: string,
  path: string,
): Promise<string | null> {
  try {
    await Deno.link(target, path);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
