// Server-only: archives browsed as directories.
//
// mc delegates most archive formats to external helpers (extfs); mcx does the
// same, for the same reason — `tar` and `unzip` already handle every corner of
// every format, and reimplementing them would be worse at it. What mcx adds is
// the parsing, so the panel gets real entries with real sizes and modes.
import type { FileEntry, FileKind } from "../type/fs.ts";

export type ArchiveKind = "tar" | "zip";

/** Recognise an archive by name. Extension-based on purpose: reading magic
 *  bytes for every row of a listing would cost a read per file. */
export function archiveKind(name: string): ArchiveKind | null {
  const n = name.toLowerCase();
  if (/\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst)$/.test(n)) {
    return "tar";
  }
  if (/\.(zip|jar|war|apk|xpi)$/.test(n)) return "zip";
  return null;
}

export type ArchiveEntry = {
  /** Path inside the archive, no leading slash. */
  path: string;
  size: number;
  mtime: number;
  mode: number;
  dir: boolean;
};

async function runTool(
  cmd: string,
  args: string[],
): Promise<{ out: string; error: string | null }> {
  try {
    const r = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout);
    if (!r.success && out.trim() === "") {
      return {
        out: "",
        error: new TextDecoder().decode(r.stderr).trim() || `${cmd} failed`,
      };
    }
    return { out, error: null };
  } catch (e) {
    return {
      out: "",
      error: e instanceof Deno.errors.NotFound
        ? `${cmd} is not installed — mcx needs it to read this archive`
        : e instanceof Error
        ? e.message
        : String(e),
    };
  }
}

const MODE_CHARS: Record<string, number> = { r: 4, w: 2, x: 1, s: 1, t: 1 };

/** `rwxr-xr-x` → 0o755. */
function parseMode(s: string): number {
  let mode = 0;
  for (let g = 0; g < 3; g++) {
    let bits = 0;
    for (let i = 0; i < 3; i++) bits |= MODE_CHARS[s[g * 3 + i] ?? "-"] ?? 0;
    mode = (mode << 3) | bits;
  }
  return mode;
}

const stamp = (date: string, time: string): number => {
  const t = Date.parse(`${date}T${time.length === 5 ? time + ":00" : time}`);
  return Number.isFinite(t) ? t : 0;
};

/** `tar -tvf` output. The name is the LAST field and may contain spaces, so it
 *  is taken by offset rather than by splitting. */
function parseTar(out: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(
      /^([dlrwxsSt-]{10})\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.*)$/,
    );
    if (!m) continue;
    const [, perms, size, date, time, rawName] = m;
    // `tar` prints "link -> target"; the row is the link itself.
    const name = rawName!.split(" -> ")[0]!;
    const dir = perms!.startsWith("d") || name.endsWith("/");
    entries.push({
      path: name.replace(/\/$/, ""),
      size: Number(size),
      mtime: stamp(date!, time!),
      mode: parseMode(perms!.slice(1)),
      dir,
    });
  }
  return entries;
}

/** `unzip -l` output: length, date, time, name. */
function parseZip(out: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(
      /^\s*(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.*)$/,
    );
    if (!m) continue;
    const [, size, date, time, rawName] = m;
    const name = rawName!;
    if (name === "" || name.startsWith("---")) continue;
    entries.push({
      path: name.replace(/\/$/, ""),
      size: Number(size),
      mtime: stamp(date!, time!),
      // zip listings carry no unix mode; a readable default beats a wrong one.
      mode: name.endsWith("/") ? 0o755 : 0o644,
      dir: name.endsWith("/"),
    });
  }
  return entries;
}

/** Every entry in the archive, flat. */
export async function list(
  archive: string,
  kind: ArchiveKind,
): Promise<{ entries: ArchiveEntry[]; error: string | null }> {
  const r = kind === "tar"
    ? await runTool("tar", ["-tvf", archive])
    : await runTool("unzip", ["-l", archive]);
  if (r.error) return { entries: [], error: r.error };
  return {
    entries: kind === "tar" ? parseTar(r.out) : parseZip(r.out),
    error: null,
  };
}

/** The rows for ONE directory inside the archive — the flat list, collapsed to
 *  the level the user is looking at, with intermediate directories synthesised
 *  (a tar need not contain an entry for a directory whose files it holds). */
export function levelOf(entries: ArchiveEntry[], inner: string): FileEntry[] {
  const prefix = inner === "" ? "" : inner.replace(/\/$/, "") + "/";
  const seen = new Map<string, FileEntry>();

  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (rest === "") continue;
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const isDir = slash >= 0 || e.dir;
    const existing = seen.get(name);
    if (existing && !(existing.kind === "dir" && !isDir)) continue;
    seen.set(name, {
      name,
      kind: (isDir ? "dir" : "file") as FileKind,
      size: isDir ? 0 : e.size,
      mtime: e.mtime,
      mode: e.mode,
      uid: 0,
      gid: 0,
      nlink: 1,
    });
  }

  return [...seen.values()];
}

/** Panel-ready listing for one level of an archive, `..` included so the user
 *  can always walk back out. */
export async function listing(
  archive: string,
  kind: ArchiveKind,
  inner: string,
): Promise<{ entries: FileEntry[]; error: string | null }> {
  const r = await list(archive, kind);
  if (r.error) return { entries: [upEntry()], error: r.error };
  return { entries: [upEntry(), ...levelOf(r.entries, inner)], error: null };
}

const upEntry = (): FileEntry => ({
  name: "..",
  kind: "dir",
  size: 0,
  mtime: 0,
  mode: 0o755,
  uid: 0,
  gid: 0,
  nlink: 1,
});

/** Extract one member into a fresh temp directory and return the file's path —
 *  what F3/F4 need, since the viewer and editor open files, and an archive
 *  member is not one until it exists.
 *
 *  Lives here rather than in the cell because `Deno.*` in a cell file poisons
 *  the browser bundle (docs/build/imports.md §1; `deno task doctor` catches it). */
/** Every temp directory an extraction has created this session.
 *
 *  mc calls these "active VFS" and gives you a list and a Free button, because
 *  they are real bytes on a real disk: viewing forty files out of an archive
 *  leaves forty copies behind, and nothing else would ever remove them. */
const extracted: string[] = [];

/** C-x a — what is currently held, for the VFS list. */
export function activeTemps(): string[] {
  return [...extracted];
}

/** Everything under the profile's cache, whoever put it there — archive
 *  members and fetched remote files alike. Freeing is a promise about disk
 *  space, and it would be a poor one if it only covered half of them. */
export async function cachedBytes(): Promise<number> {
  const { profileDir } = await import("./profile.server.ts");
  const { dirSize } = await import("./listing.server.ts");
  const root = `${profileDir()}/cache`;
  try {
    await Deno.stat(root);
  } catch {
    return 0;
  }
  return await dirSize(root);
}

/** Release them. Returns how many were removed; a directory that has already
 *  gone is a success, not an error. */
export async function freeTemps(): Promise<number> {
  let n = 0;
  for (const dir of extracted.splice(0)) {
    try {
      await Deno.remove(dir, { recursive: true });
      n++;
    } catch { /* already gone, or never ours */ }
  }
  // …and anything left in the cache from an earlier run, which nothing else
  // would ever remove.
  const { profileDir } = await import("./profile.server.ts");
  const root = `${profileDir()}/cache`;
  try {
    for await (const kind of Deno.readDir(root)) {
      for await (const e of Deno.readDir(`${root}/${kind.name}`)) {
        await Deno.remove(`${root}/${kind.name}/${e.name}`, { recursive: true })
          .then(() => n++)
          .catch(() => {});
      }
    }
  } catch { /* no cache yet */ }
  return n;
}

export async function extractToTemp(
  archive: string,
  kind: ArchiveKind,
  member: string,
): Promise<{ path: string; error: string | null }> {
  // Inside the profile's cache rather than /tmp: mcx's whole footprint is one
  // directory, and this is the half of it that can be deleted at any time.
  const { cacheDir } = await import("./profile.server.ts");
  const dir = await cacheDir("archives");
  extracted.push(dir);
  const error = await extract(archive, kind, member, dir);
  return { path: `${dir}/${member}`, error };
}

/** Extract one member to `dest` (a directory). Used by F5 out of an archive
 *  and by the viewer, which needs a real file to open.
 *
 *  `dir` is load-bearing for zip. `tar` takes a member name as a PREFIX, so
 *  naming a directory brings its whole subtree; `unzip` takes it as a glob, so
 *  naming a directory matched the one empty entry and, in a zip that has no
 *  entry for the directory at all, matched nothing — F5 on a folder inside a
 *  `.zip` extracted zero files and said it had succeeded. */
export async function extract(
  archive: string,
  kind: ArchiveKind,
  member: string,
  dest: string,
  dir = false,
): Promise<string | null> {
  if (kind === "tar") {
    return (await runTool("tar", ["-xf", archive, "-C", dest, member])).error;
  }
  const pattern = dir ? `${member}/*` : member;
  const r = await runTool("unzip", ["-o", "-q", archive, pattern, "-d", dest]);
  // A directory with nothing under it matches no pattern; the directory itself
  // is still what was asked for.
  if (r.error && dir) {
    await Deno.mkdir(`${dest}/${member}`, { recursive: true }).catch(() => {});
    return null;
  }
  return r.error;
}

/** Extract a selection into a temp directory and return what landed there.
 *
 *  F5 out of an archive goes through the ORDINARY copy from here — which is
 *  what gives it the overwrite question, the progress bar, the job list and
 *  cancellation, none of which a direct `unzip -o` into the destination has.
 *  The archive member is written twice for that, and it is worth it: silently
 *  overwriting a file the user has is the one outcome F5 must never have. */
export async function stage(
  archive: string,
  kind: ArchiveKind,
  members: { member: string; dir: boolean }[],
): Promise<{ dir: string; paths: string[]; failed: number }> {
  const { cacheDir } = await import("./profile.server.ts");
  const dir = await cacheDir("archives");
  extracted.push(dir);
  const paths: string[] = [];
  let failed = 0;
  for (const m of members) {
    if (await extract(archive, kind, m.member, dir, m.dir)) failed++;
    else paths.push(`${dir}/${m.member}`);
  }
  return { dir, paths, failed };
}
