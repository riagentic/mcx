// Server-only filesystem mutations. Errors come back as strings — the caller
// decides how loud to be, and nothing throws across the cell boundary for a
// condition as ordinary as "permission denied".
import type { FileDetails } from "../type/fs.ts";

export async function mkdir(path: string): Promise<string | null> {
  try {
    await Deno.mkdir(path, { recursive: true });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Resolve a name to an id through the passwd/group databases.
 *
 *  Read straight from `/etc/passwd` and `/etc/group` rather than shelled out to
 *  `id`: it is one small file, it is the same answer, and it costs no process.
 *  A purely numeric spelling is taken as an id, which is what `chown 1000:1000`
 *  means everywhere else. */
async function lookup(name: string, file: string): Promise<number | null> {
  if (/^\d+$/.test(name)) return Number(name);
  try {
    const text = await Deno.readTextFile(file);
    for (const line of text.split("\n")) {
      const [n, , id] = line.split(":");
      if (n === name) return Number(id);
    }
  } catch { /* no passwd/group database — fall through */ }
  return null;
}

export type Owner = { uid: number | null; gid: number | null };

/** Parse mc's chown spelling: `user`, `:group` or `user:group`. An empty half
 *  means "leave it alone", which is what `-1` means to the syscall. */
export async function parseOwner(
  spec: string,
): Promise<{ owner: Owner; error: string | null }> {
  const [user = "", group = ""] = spec.trim().split(":");
  const uid = user === "" ? null : await lookup(user, "/etc/passwd");
  const gid = group === "" ? null : await lookup(group, "/etc/group");
  if (user !== "" && uid === null) {
    return { owner: { uid: null, gid: null }, error: `no such user: ${user}` };
  }
  if (group !== "" && gid === null) {
    return {
      owner: { uid: null, gid: null },
      error: `no such group: ${group}`,
    };
  }
  if (uid === null && gid === null) {
    return { owner: { uid: null, gid: null }, error: "nothing to change" };
  }
  return { owner: { uid, gid }, error: null };
}

/** `null` leaves that half of the ownership alone — Deno maps it to -1. */
export async function chown(
  path: string,
  o: Owner,
): Promise<string | null> {
  try {
    await Deno.chown(path, o.uid, o.gid);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** ext2/3/4 file attributes — mc's C-x e.
 *
 *  Through `lsattr`/`chattr` rather than an ioctl, because Deno has no ioctl:
 *  the flags live behind `FS_IOC_GETFLAGS`, which is not reachable from here.
 *  That makes this the one operation in mcx that depends on a binary being
 *  installed, so the absence of one is reported as itself rather than as a
 *  mysterious failure. */
export async function readAttrs(
  path: string,
): Promise<{ attrs: string; error: string | null }> {
  try {
    const r = await new Deno.Command("lsattr", {
      args: ["-d", "--", path],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!r.success) {
      return {
        attrs: "",
        error: new TextDecoder().decode(r.stderr).trim() || "lsattr failed",
      };
    }
    // `----------------- /path`: the flags are the first field.
    const line = new TextDecoder().decode(r.stdout).split("\n")[0] ?? "";
    return {
      attrs: (line.split(/\s+/)[0] ?? "").replaceAll("-", ""),
      error: null,
    };
  } catch {
    return { attrs: "", error: "lsattr is not installed" };
  }
}

/** Apply a set of attribute letters (`ai` for append-only + immutable), turning
 *  off everything not named. Both halves are sent in one call so the result is
 *  exactly what was asked for rather than what was added to what was there. */
export async function writeAttrs(
  path: string,
  attrs: string,
): Promise<string | null> {
  const ALL = "aAcCdDeijPsStTu";
  const want = [...new Set(attrs.replace(/[^a-zA-Z]/g, ""))].join("");
  const off = [...ALL].filter((c) => !want.includes(c)).join("");
  const args: string[] = [];
  if (want) args.push(`+${want}`);
  if (off) args.push(`-${off}`);
  args.push("--", path);
  try {
    const r = await new Deno.Command("chattr", {
      args,
      stdout: "null",
      stderr: "piped",
    }).output();
    return r.success
      ? null
      : new TextDecoder().decode(r.stderr).trim() || "chattr failed";
  } catch {
    return "chattr is not installed";
  }
}

/** id → name, through the same two files `lookup` reads, and cached: an info
 *  panel asks for the same handful of owners on every cursor move. */
const nameCache = new Map<string, Map<number, string>>();

async function nameOf(id: number, file: string): Promise<string> {
  let table = nameCache.get(file);
  if (!table) {
    table = new Map();
    try {
      for (const line of (await Deno.readTextFile(file)).split("\n")) {
        const [n, , i] = line.split(":");
        if (n && i !== undefined) table.set(Number(i), n);
      }
    } catch { /* no database — ids it is */ }
    nameCache.set(file, table);
  }
  return table.get(id) ?? String(id);
}

export async function details(path: string): Promise<FileDetails | null> {
  try {
    const st = await Deno.lstat(path);
    const [owner, group] = await Promise.all([
      nameOf(st.uid ?? 0, "/etc/passwd"),
      nameOf(st.gid ?? 0, "/etc/group"),
    ]);
    return {
      path,
      size: st.size,
      mode: (st.mode ?? 0) & 0o7777,
      nlink: st.nlink ?? 1,
      owner,
      group,
      atime: st.atime?.getTime() ?? 0,
      mtime: st.mtime?.getTime() ?? 0,
      ctime: st.ctime?.getTime() ?? 0,
      inode: Number(st.ino ?? 0),
      dev: Number(st.dev ?? 0),
      target: st.isSymlink ? await Deno.readLink(path).catch(() => null) : null,
      error: null,
    };
  } catch (e) {
    return {
      path,
      size: 0,
      mode: 0,
      nlink: 0,
      owner: "",
      group: "",
      atime: 0,
      mtime: 0,
      ctime: 0,
      inode: 0,
      dev: 0,
      target: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
