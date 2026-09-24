// Server-only: turning a directory into panel rows.
//
// The split that matters for responsiveness — `Deno` does the syscalls, wasm
// does the CPU work (sorting, mask matching). Neither side waits on the other
// doing what it is bad at.
import type { FileEntry, FileKind } from "../type/fs.ts";
import { UP_DIR } from "../type/fs.ts";
import type { PanelState } from "../type/panel.ts";
import { arrangeIndex } from "./core.server.ts";
import { normalize } from "../lib/path.ts";

function kindOf(i: Deno.FileInfo): FileKind {
  if (i.isSymlink) return "link";
  if (i.isDirectory) return "dir";
  if (i.isFile) return "file";
  if (i.isFifo) return "fifo";
  if (i.isSocket) return "socket";
  if (i.isBlockDevice) return "block";
  if (i.isCharDevice) return "char";
  return "unknown";
}

/** `lstat` never follows — that is the point: a symlink's own row shows the
 *  link, and a second (failable) `stat` decides how it is painted. */
async function toEntry(dir: string, name: string): Promise<FileEntry> {
  const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
  try {
    const st = await Deno.lstat(path);
    const e: FileEntry = {
      name,
      kind: kindOf(st),
      size: st.size,
      mtime: st.mtime?.getTime() ?? 0,
      mode: (st.mode ?? 0) & 0o7777,
      uid: st.uid ?? 0,
      gid: st.gid ?? 0,
      nlink: st.nlink ?? 1,
    };
    if (e.kind === "link") {
      try {
        e.target = await Deno.readLink(path);
      } catch { /* unreadable link — still a link */ }
      try {
        e.linkKind = kindOf(await Deno.stat(path));
      } catch {
        e.broken = true;
      }
    }
    return e;
  } catch {
    // Raced with a delete, or unreadable: show the name rather than dropping a
    // row the user can see in a terminal.
    return {
      name,
      kind: "unknown",
      size: 0,
      mtime: 0,
      mode: 0,
      uid: 0,
      gid: 0,
      nlink: 0,
    };
  }
}

/** Bounded parallel map — one `lstat` per entry, but not 100_000 in flight. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export type RawListing = { entries: FileEntry[]; error: string | null };

/** What mc's info panel says about the filesystem the panel is on. */
export type DiskStats = {
  free: number;
  total: number;
  nodesFree: number;
  nodesTotal: number;
  device: string;
  fstype: string;
};

/** Directories big enough that stat'ing every entry before the first paint is
 *  felt. Measured, not guessed: ~3.4µs per `lstat` through Deno's op layer, so
 *  2000 entries is the ~7ms where a second phase starts earning its keep. */
export const TWO_PHASE_THRESHOLD = 2000;

/** Phase one: names and kinds only, straight from `readdir`.
 *
 *  `readdir` alone is ~5× faster than `readdir` + one `lstat` per entry
 *  (98ms vs 440ms for 100_000 entries on this machine), and it already carries
 *  everything needed to DRAW the panel — the name, and whether it is a
 *  directory. Sizes and times arrive in phase two, while the user is already
 *  looking at their files. */
export async function readDirFast(
  path: string,
  signal?: AbortSignal,
): Promise<RawListing> {
  const entries: FileEntry[] = [];
  try {
    for await (const e of Deno.readDir(path)) {
      if (signal?.aborted) break;
      entries.push({
        name: e.name,
        kind: e.isSymlink
          ? "link"
          : e.isDirectory
          ? "dir"
          : e.isFile
          ? "file"
          : "unknown",
        size: 0,
        mtime: 0,
        mode: 0,
        uid: 0,
        gid: 0,
        nlink: 1,
      });
    }
  } catch (e) {
    return {
      entries: [upDir()],
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (path !== "/") entries.unshift(upDir());
  return { entries, error: null };
}

/** Phase two: the metadata for one slice of a listing. */
export async function statSlice(
  dir: string,
  entries: readonly FileEntry[],
  from: number,
  count: number,
): Promise<FileEntry[]> {
  const slice = entries.slice(from, from + count);
  return await pooled(slice, 64, async (e) => {
    if (e.name === UP_DIR) return e;
    return await toEntry(dir, e.name);
  });
}

/** Read a directory. Errors are data, not exceptions: an unreadable directory
 *  still shows `..` so the user is never trapped. */
export async function readDir(
  path: string,
  signal?: AbortSignal,
): Promise<RawListing> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(path)) {
      if (signal?.aborted) break;
      names.push(e.name);
    }
  } catch (e) {
    return {
      entries: [upDir()],
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const entries = await pooled(names, 64, (n) => toEntry(path, n));
  if (path !== "/") entries.unshift(upDir());
  return { entries, error: null };
}

/** Build a listing from an explicit list of paths — the panelized view. The
 *  NAME is the full path, because a flat list of `index.ts` × 40 is useless. */
export async function readPaths(paths: string[]): Promise<RawListing> {
  const entries = await pooled(paths, 64, async (p) => {
    const dir = p.slice(0, p.lastIndexOf("/")) || "/";
    const e = await toEntry(dir, p.slice(p.lastIndexOf("/") + 1));
    return { ...e, name: p };
  });
  return { entries: [upDir(), ...entries], error: null };
}

/** `du -s` for one directory: the byte total of everything under it.
 *
 *  Iterative rather than recursive, because a deep tree must not be able to
 *  overflow the stack, and it keeps no list of what it counted — the answer is
 *  one number, and materialising a hundred thousand entries to reach it is how
 *  "how big is this?" turns into a memory spike. Symlinks are counted as links,
 *  never followed: a link into a parent directory would otherwise never end. */
export async function dirSize(
  path: string,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    if (signal?.aborted) break;
    const dir = stack.pop()!;
    try {
      for await (const e of Deno.readDir(dir)) {
        if (signal?.aborted) break;
        const p = dir === "/" ? `/${e.name}` : `${dir}/${e.name}`;
        if (e.isDirectory && !e.isSymlink) {
          stack.push(p);
          continue;
        }
        try {
          total += (await Deno.lstat(p)).size;
        } catch { /* raced with a delete — it counts for nothing */ }
      }
    } catch { /* unreadable directory — the rest of the total still stands */ }
  }
  return total;
}

function upDir(): FileEntry {
  return {
    name: UP_DIR,
    kind: "dir",
    size: 0,
    mtime: 0,
    mode: 0o755,
    uid: 0,
    gid: 0,
    nlink: 1,
  };
}

type ViewOpts = Pick<
  PanelState,
  "sort" | "reverse" | "dirsFirst" | "caseSensitive" | "showHidden" | "filter"
>;

/** Filter + sort — the pure "raw listing → what the panel shows" step.
 *
 *  Always applied to the RAW listing the disk gave us, never to its own output:
 *  that is what lets `M-.` and a filter mask be undone without a second
 *  `readdir`. One wasm call does hidden-file removal, the mask and the sort
 *  together, so nothing is packed into linear memory twice. */
export function arrange(
  entries: readonly FileEntry[],
  o: ViewOpts,
): FileEntry[] {
  return project(entries, arrangeOrder(entries, o));
}

/** `arrange`, stopping at the permutation.
 *
 *  The panel keeps this: with the raw listing and the order it is showing it
 *  in, re-publishing rows after a metadata chunk lands is an array walk, not a
 *  re-sort. */
export function arrangeOrder(
  entries: readonly FileEntry[],
  o: ViewOpts,
): number[] {
  return [...arrangeIndex(entries, {
    key: o.sort,
    reverse: o.reverse,
    dirsFirst: o.dirsFirst,
    caseSensitive: o.caseSensitive,
    showHidden: o.showHidden,
    filter: o.filter.trim(),
  })];
}

/** Apply an order to a raw listing. */
export function project(
  entries: readonly FileEntry[],
  order: readonly number[],
): FileEntry[] {
  const out: FileEntry[] = new Array(order.length);
  for (let i = 0; i < order.length; i++) out[i] = entries[order[i]!]!;
  return out;
}

/** Filesystem free/total for the status line. `df` is the portable answer —
 *  Deno has no statvfs — and a failure just means the panel shows no figure. */
export async function diskFree(
  path: string,
): Promise<DiskStats> {
  const empty: DiskStats = {
    free: 0,
    total: 0,
    nodesFree: 0,
    nodesTotal: 0,
    device: "",
    fstype: "",
  };
  const df = async (flags: string): Promise<string[]> => {
    try {
      const out = await new Deno.Command("df", {
        args: [flags, path],
        stdout: "piped",
        stderr: "null",
      }).output();
      const line = new TextDecoder().decode(out.stdout).trim().split("\n")[1];
      return line?.trim().split(/\s+/) ?? [];
    } catch {
      return [];
    }
  };

  // `-T` prints the filesystem type, which mc's info panel shows; it is a GNU
  // extension, so a run without it is the fallback rather than an error.
  let cols = await df("-kPT");
  const typed = cols.length >= 7;
  if (!typed) cols = await df("-kP");
  if (cols.length === 0) return empty;

  const at = (i: number) => Number(cols[typed ? i + 1 : i]);
  const total = at(1) * 1024;
  const free = at(3) * 1024;
  if (!Number.isFinite(total) || !Number.isFinite(free)) return empty;

  // Inodes are a second question `df` only answers when asked — and mc's
  // "Free nodes" line is the one that explains a full disk with space on it.
  const inodes = await df("-iP");
  return {
    free,
    total,
    nodesFree: Number(inodes[3]) || 0,
    nodesTotal: Number(inodes[1]) || 0,
    device: cols[0] ?? "",
    fstype: typed ? cols[1] ?? "" : "",
  };
}

/** First lines of a file, for the quick-view panel. Bounded twice — bytes read
 *  and lines returned — because a preview must never cost more than the file
 *  being previewed is worth. */
export async function preview(
  path: string,
  maxLines: number,
): Promise<string[]> {
  try {
    const st = await Deno.stat(path);
    if (st.isDirectory) return [];
    const file = await Deno.open(path, { read: true });
    try {
      const buf = new Uint8Array(Math.min(64 * 1024, st.size));
      await file.read(buf);
      const text = new TextDecoder(undefined, { fatal: false }).decode(buf);
      // A binary file previewed as text is noise; say what it is instead.
      if (text.slice(0, 2048).includes("\0")) return ["(binary file)"];
      return text.split("\n").slice(0, maxLines).map((l) =>
        l.replace(/\r$/, "")
      );
    } finally {
      file.close();
    }
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
}

/** mc's `examine_cd` (src/filemanager/cd.c), plus its CDPATH handling.
 *
 *  Three expansions before a path is a path — `~`, `$VAR`/`${VAR}`, and a
 *  backslash-escaped `\$` that means a literal one — and then, for a RELATIVE
 *  name that does not exist where we stand, the directories in `$CDPATH`. All
 *  of it is what a shell would do with the same string, which is the point: the
 *  command line and the quick-cd box should not disagree with each other.
 *
 *  Returns an absolute path. An unset variable expands to nothing, as in sh. */
export async function expandCd(
  target: string,
  cwd: string,
  home: string,
): Promise<string> {
  let out = "";
  let i = 0;
  const t = target;
  while (i < t.length) {
    if (t[i] === "\\" && t[i + 1] === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (t[i] !== "$") {
      out += t[i];
      i++;
      continue;
    }
    i++; // the dollar
    const braced = t[i] === "{";
    if (braced) i++;
    const start = i;
    while (
      i < t.length && (braced ? t[i] !== "}" : /[A-Za-z0-9_]/.test(t[i]!))
    ) i++;
    const name = t.slice(start, i);
    if (braced && t[i] === "}") i++;
    out += Deno.env.get(name) ?? "";
  }

  if (out === "~" || out.startsWith("~/")) {
    return normalize(home + out.slice(1));
  }
  if (out.startsWith("/")) return normalize(out);

  const isDir = async (p: string): Promise<boolean> => {
    try {
      return (await Deno.stat(p)).isDirectory;
    } catch {
      return false;
    }
  };

  const here = normalize(`${cwd}/${out}`);
  if (await isDir(here)) return here;

  // CDPATH: each entry in turn, first hit wins. `.` and `~` in it are expanded
  // the same way the target was, because a shell expands them too.
  for (const entry of (Deno.env.get("CDPATH") ?? "").split(":")) {
    if (entry === "") continue;
    const base = entry === "~" || entry.startsWith("~/")
      ? home + entry.slice(1)
      : entry.startsWith("/")
      ? entry
      : `${cwd}/${entry}`;
    const candidate = normalize(`${base}/${out}`);
    if (await isDir(candidate)) return candidate;
  }
  return here;
}

export function homeDir(): string {
  return Deno.env.get("HOME") ?? "/";
}

export function cwd(): string {
  try {
    return Deno.cwd();
  } catch {
    return homeDir();
  }
}
