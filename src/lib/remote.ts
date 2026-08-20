/** Remote paths, and the listings that come back from them.
 *
 *  mc calls these virtual filesystems: `cd sh://user@host/path` and the panel
 *  shows another machine. mcx speaks the same URLs and gets its answers the
 *  same way mc's "shell" VFS does — by running ordinary commands over ssh —
 *  which is why this file is only parsing: the URL going out, and the `ls -l`
 *  coming back. Both are pure, and both are where the bugs would be. */

import type { FileEntry, FileKind } from "../type/fs.ts";

export type RemoteScheme = "sh" | "sftp" | "ftp";

export type RemoteUrl = {
  scheme: RemoteScheme;
  user: string;
  host: string;
  port: number | null;
  /** Always absolute, always without a trailing slash (except at the root). */
  dir: string;
};

const SCHEMES: RemoteScheme[] = ["sh", "sftp", "ftp"];

/** Is this a path on another machine? Cheap enough to call on every reload. */
export const isRemote = (path: string): boolean =>
  SCHEMES.some((s) => path.startsWith(`${s}://`));

/** `sh://user@host:2222/var/log` → its parts, or null if this is a local path.
 *
 *  A missing path means the remote home directory, which is what a bare
 *  `sh://host` should give you — the same thing `ssh host` does. */
export function parseRemote(path: string): RemoteUrl | null {
  const m = /^(sh|sftp|ftp):\/\/([^/]*)(\/.*)?$/.exec(path);
  if (!m) return null;
  const scheme = m[1] as RemoteScheme;
  const authority = m[2] ?? "";
  const at = authority.lastIndexOf("@");
  const user = at >= 0 ? authority.slice(0, at) : "";
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const colon = hostPort.lastIndexOf(":");
  const host = colon > 0 ? hostPort.slice(0, colon) : hostPort;
  const port = colon > 0 ? Number(hostPort.slice(colon + 1)) : null;
  if (!host) return null;
  let dir = m[3] ?? "";
  if (dir.length > 1 && dir.endsWith("/")) dir = dir.slice(0, -1);
  return {
    scheme,
    user,
    host,
    port: Number.isFinite(port) ? port : null,
    dir: dir || "",
  };
}

/** Put one back together — what the panel shows and what `..` walks. */
export function formatRemote(u: RemoteUrl, dir = u.dir): string {
  const auth = `${u.user ? `${u.user}@` : ""}${u.host}${
    u.port ? `:${u.port}` : ""
  }`;
  return `${u.scheme}://${auth}${dir}`;
}

/** The parent of a remote path. At the top of the remote tree there is nowhere
 *  further up but out, so this returns null and the caller goes home. */
export function remoteParent(path: string): string | null {
  const u = parseRemote(path);
  if (!u) return null;
  if (u.dir === "" || u.dir === "/") return null;
  const cut = u.dir.lastIndexOf("/");
  return formatRemote(u, cut <= 0 ? "/" : u.dir.slice(0, cut));
}

/** Resolve a name against a remote directory. */
export function remoteJoin(path: string, name: string): string {
  const u = parseRemote(path);
  if (!u) return name;
  const base = u.dir === "/" ? "" : u.dir;
  return formatRemote(u, `${base}/${name}`);
}

const KIND_OF: Record<string, FileKind> = {
  "-": "file",
  d: "dir",
  l: "link",
  p: "fifo",
  s: "socket",
  b: "block",
  c: "char",
};

/** Permissions from an `ls -l` mode string (`rwxr-xr-x`). */
function modeBits(s: string): number {
  let mode = 0;
  const bit = (i: number, ch: string, v: number) => {
    if (s[i] === ch) mode |= v;
  };
  bit(0, "r", 0o400);
  bit(1, "w", 0o200);
  bit(2, "x", 0o100);
  bit(3, "r", 0o040);
  bit(4, "w", 0o020);
  bit(5, "x", 0o010);
  bit(6, "r", 0o004);
  bit(7, "w", 0o002);
  bit(8, "x", 0o001);
  // setuid/setgid/sticky ride in the x positions as s/t.
  if (s[2] === "s" || s[2] === "S") mode |= 0o4000;
  if (s[5] === "s" || s[5] === "S") mode |= 0o2000;
  if (s[8] === "t" || s[8] === "T") mode |= 0o1000;
  return mode;
}

/**
 * Parse `ls -la --time-style=long-iso`, which is what mcx asks a remote shell
 * for. One line per entry:
 *
 *     drwxr-xr-x 2 alice devs  4096 2026-08-14 09:12 subdir
 *     lrwxrwxrwx 1 alice devs     7 2026-08-14 09:12 link -> target
 *
 * `long-iso` rather than the default because the default omits the year on old
 * files and includes it on new ones — a format that cannot be parsed without
 * knowing today's date, which is the sort of thing that breaks in December.
 */
export function parseLsLong(text: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("total ")) continue;
    // mode links owner group size date time name…
    const m =
      /^([-dlpsbc])([rwxstST-]{9})[.+]?\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.*)$/
        .exec(line);
    if (!m) continue;
    let name = m[9]!;
    let target: string | undefined;
    // A symlink's name is `name -> target`; the arrow cannot appear in an
    // unquoted `ls` name without one.
    const arrow = name.indexOf(" -> ");
    if (m[1] === "l" && arrow >= 0) {
      target = name.slice(arrow + 4);
      name = name.slice(0, arrow);
    }
    if (name === "." || name === "..") continue;
    const entry: FileEntry = {
      name,
      kind: KIND_OF[m[1]!] ?? "unknown",
      size: Number(m[6]),
      mtime: Date.parse(`${m[7]}T${m[8]}:00`),
      mode: modeBits(m[2]!),
      uid: 0,
      gid: 0,
      nlink: Number(m[3]),
    };
    if (target !== undefined) entry.target = target;
    out.push(entry);
  }
  return out;
}

/** Parse an FTP LIST as `curl` returns it. Same shape as `ls -l`, but with the
 *  old three-field date, which is why it is parsed separately rather than by
 *  loosening the pattern above. */
export function parseFtpList(text: string): FileEntry[] {
  const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
  const out: FileEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("total ")) continue;
    const m =
      /^([-dlpsbc])([rwxstST-]{9})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3})\s+(\d{1,2})\s+(\d{4}|\d{2}:\d{2})\s+(.*)$/
        .exec(line);
    if (!m) continue;
    let name = m[10]!;
    let target: string | undefined;
    const arrow = name.indexOf(" -> ");
    if (m[1] === "l" && arrow >= 0) {
      target = name.slice(arrow + 4);
      name = name.slice(0, arrow);
    }
    if (name === "." || name === "..") continue;
    const month = Math.floor(MONTHS.indexOf(m[7]!) / 3);
    const yearOrTime = m[9]!;
    // A listing gives either a year (older than six months) or a time (newer),
    // never both — the same rule `ls` uses, read the same way.
    const now = new Date();
    const date = yearOrTime.includes(":")
      ? new Date(now.getFullYear(), month, Number(m[8]))
      : new Date(Number(yearOrTime), month, Number(m[8]));
    const entry: FileEntry = {
      name,
      kind: KIND_OF[m[1]!] ?? "unknown",
      size: Number(m[6]),
      mtime: date.getTime(),
      mode: modeBits(m[2]!),
      uid: 0,
      gid: 0,
      nlink: Number(m[3]),
    };
    if (target !== undefined) entry.target = target;
    out.push(entry);
  }
  return out;
}
