// Server-only: talking to another machine.
//
// mc's "shell" VFS works by running ordinary commands down an ssh channel, and
// so does this: `ls -la` to list, `cat` to read, `scp` to copy. That is a
// deliberate choice over implementing SFTP in-process — ssh is already
// installed, already configured, already knows the user's keys, their
// `~/.ssh/config`, their jump hosts and their agent. Reimplementing any of
// that would be a worse ssh that the user has to configure twice.
//
// FTP goes through `curl`, for the same reason.
import type { FileEntry } from "../type/fs.ts";
import {
  formatRemote,
  parseFtpList,
  parseLsLong,
  parseRemote,
  type RemoteUrl,
} from "../lib/remote.ts";
import { shellQuote } from "../lib/shell.ts";

export type RemoteResult = { entries: FileEntry[]; error: string | null };

/** How long any single remote command may take. A machine that is not
 *  answering must not hang the panel: mc's own VFS has the same timeout, for
 *  the same reason. */
const TIMEOUT_MS = 20_000;

/** The ssh command line for a URL — `-p` only when a port was given, so
 *  `~/.ssh/config` still decides everything it normally decides. */
function sshArgs(u: RemoteUrl): string[] {
  const args = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=10`];
  if (u.port) args.push("-p", String(u.port));
  args.push(u.user ? `${u.user}@${u.host}` : u.host);
  return args;
}

async function run(
  cmd: string,
  args: string[],
  stdin?: Uint8Array,
): Promise<{ out: Uint8Array; err: string; code: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const child = new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
      stdin: stdin ? "piped" : "null",
      signal: ac.signal,
    }).spawn();
    if (stdin) {
      const w = child.stdin.getWriter();
      await w.write(stdin);
      await w.close();
    }
    const r = await child.output();
    return {
      out: r.stdout,
      err: new TextDecoder().decode(r.stderr).trim(),
      code: r.code,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      out: new Uint8Array(),
      err: ac.signal.aborted ? `${cmd}: timed out` : message,
      code: -1,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One remote command, as text. */
async function ssh(u: RemoteUrl, command: string): Promise<
  { text: string; error: string | null }
> {
  const r = await run("ssh", [...sshArgs(u), command]);
  const text = new TextDecoder().decode(r.out);
  // A command that printed something AND failed (ls on a directory with one
  // unreadable entry) is a success with a note, not a failure.
  if (r.code !== 0 && text.trim() === "") {
    return { text: "", error: r.err || `ssh exited ${r.code}` };
  }
  return { text, error: null };
}

/** List a remote directory. `-la` with `long-iso` times, because the default
 *  format cannot be parsed without knowing today's date. */
export async function listing(path: string): Promise<RemoteResult> {
  const u = parseRemote(path);
  if (!u) return { entries: [], error: "not a remote path" };

  if (u.scheme === "ftp") {
    const url = `ftp://${u.host}${u.port ? `:${u.port}` : ""}${u.dir || "/"}/`;
    const args = ["-sS", "--connect-timeout", "10", url];
    if (u.user) args.push("--user", u.user);
    const r = await run("curl", args);
    if (r.code !== 0) {
      return { entries: [], error: r.err || `curl exited ${r.code}` };
    }
    return {
      entries: parseFtpList(new TextDecoder().decode(r.out)),
      error: null,
    };
  }

  const dir = u.dir || ".";
  const r = await ssh(
    u,
    `LC_ALL=C ls -la --time-style=long-iso -- ${shellQuote(dir)}`,
  );
  if (r.error) return { entries: [], error: r.error };
  return { entries: parseLsLong(r.text), error: null };
}

/** The remote home directory, for a URL that named no path. */
export async function homeOf(path: string): Promise<string> {
  const u = parseRemote(path);
  if (!u || u.dir !== "") return path;
  if (u.scheme === "ftp") return formatRemote(u, "/");
  const r = await ssh(u, "pwd");
  const dir = r.text.trim().split("\n")[0] ?? "/";
  return formatRemote(u, dir.startsWith("/") ? dir : "/");
}

/** Copy a remote file down to a local path — how F3, F4 and F5 work on a
 *  remote panel: everything else in mcx opens files, and a remote file is not
 *  one until it is here. */
export async function download(
  remote: string,
  localPath: string,
): Promise<string | null> {
  const u = parseRemote(remote);
  if (!u) return "not a remote path";
  if (u.scheme === "ftp") {
    const url = `ftp://${u.host}${u.port ? `:${u.port}` : ""}${u.dir}`;
    const args = ["-sS", "--connect-timeout", "10", "-o", localPath, url];
    if (u.user) args.push("--user", u.user);
    const r = await run("curl", args);
    return r.code === 0 ? null : r.err || `curl exited ${r.code}`;
  }
  const args = ["-q", "-o", "BatchMode=yes"];
  if (u.port) args.push("-P", String(u.port));
  args.push(
    `${u.user ? `${u.user}@` : ""}${u.host}:${u.dir}`,
    localPath,
  );
  const r = await run("scp", args);
  return r.code === 0 ? null : r.err || `scp exited ${r.code}`;
}

/** Fetch a remote file to a temp file of its own and return the local path.
 *
 *  The temp directory is made HERE rather than in the cell: `Deno.*` in a cell
 *  file is compiled into the browser bundle, where it does not exist — the app
 *  then dies at boot with a blank screen, which is a failure no headless test
 *  can see. `deno task lint` catches it, and caught this. */
export async function fetchToTemp(
  remote: string,
  name: string,
): Promise<{ path: string; error: string | null }> {
  const { cacheDir } = await import("./profile.server.ts");
  const dir = await cacheDir("remote");
  const path = `${dir}/${name}`;
  const error = await download(remote, path);
  return { path, error };
}

/** …and back up again. */
export async function upload(
  localPath: string,
  remote: string,
): Promise<string | null> {
  const u = parseRemote(remote);
  if (!u) return "not a remote path";
  if (u.scheme === "ftp") {
    const url = `ftp://${u.host}${u.port ? `:${u.port}` : ""}${u.dir}`;
    const args = ["-sS", "--connect-timeout", "10", "-T", localPath, url];
    if (u.user) args.push("--user", u.user);
    const r = await run("curl", args);
    return r.code === 0 ? null : r.err || `curl exited ${r.code}`;
  }
  const args = ["-q", "-o", "BatchMode=yes", "-r"];
  if (u.port) args.push("-P", String(u.port));
  args.push(localPath, `${u.user ? `${u.user}@` : ""}${u.host}:${u.dir}`);
  const r = await run("scp", args);
  return r.code === 0 ? null : r.err || `scp exited ${r.code}`;
}

/** mkdir, rm and rename on the far side. FTP is read-only here: curl can do
 *  these through quote commands, but the failure modes vary by server enough
 *  that saying so is better than guessing. */
export async function mkdir(remote: string): Promise<string | null> {
  return await simple(remote, (dir) => `mkdir -p -- ${shellQuote(dir)}`);
}

export async function remove(remote: string): Promise<string | null> {
  return await simple(remote, (dir) => `rm -rf -- ${shellQuote(dir)}`);
}

export async function rename(
  remote: string,
  to: string,
): Promise<string | null> {
  return await simple(
    remote,
    (dir) => `mv -- ${shellQuote(dir)} ${shellQuote(to)}`,
  );
}

async function simple(
  remote: string,
  make: (dir: string) => string,
): Promise<string | null> {
  const u = parseRemote(remote);
  if (!u) return "not a remote path";
  if (u.scheme === "ftp") return "this FTP connection is read-only";
  const r = await ssh(u, make(u.dir));
  return r.error;
}
