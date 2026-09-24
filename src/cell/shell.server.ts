// Server-only: running a command and streaming its output back line by line.

export type Line = { text: string; err: boolean };

/** The one shell process every command runs in — mc's "subshell".
 *
 *  This is what makes `export FOO=1` still true in the next command, what makes
 *  `cd` move both the shell and the panel, and what makes an alias or a
 *  `source ~/.bashrc` mean anything. A shell spawned per command cannot do any
 *  of that: it is a different shell every time, and mc users notice within a
 *  minute.
 *
 *  No PTY, deliberately: a pseudo-terminal would bring full-screen programs
 *  (vim, top) into a window that cannot draw them. Commands that need a
 *  terminal are the one thing this cannot host, exactly as mc's own
 *  non-subshell mode cannot. */
let subshell: {
  child: Deno.ChildProcess;
  stdin: WritableStreamDefaultWriter<Uint8Array>;
  stdout: ReadableStreamDefaultReader<Uint8Array>;
  stderr: ReadableStreamDefaultReader<Uint8Array>;
} | null = null;

/** Marks the end of one command's output, and carries its exit status. Random
 *  enough that a command cannot print it by accident. */
const SENTINEL = "__mcx_done_9f3a__";

function startSubshell(cwd: string): typeof subshell {
  const shell = Deno.env.get("SHELL") || "/bin/sh";
  try {
    const child = new Deno.Command(shell, {
      // NOT `-i`. An interactive shell without a terminal writes its prompt
      // into stdout and complains about job control on every command — the
      // output of `echo hello` arrives with three lines of shell noise around
      // it. Reading commands from a pipe keeps everything that matters here
      // (the environment, the working directory, shell functions defined
      // along the way) and none of the noise.
      args: [],
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { ...Deno.env.toObject(), PS1: "", TERM: "dumb" },
    }).spawn();
    subshell = {
      child,
      stdin: child.stdin.getWriter(),
      stdout: child.stdout.getReader(),
      stderr: child.stderr.getReader(),
    };
    return subshell;
  } catch {
    return null;
  }
}

/** Stop it — on quit, or when it has died and a fresh one is wanted. */
export function stopSubshell(): void {
  if (!subshell) return;
  try {
    subshell.stdin.close();
    subshell.child.kill("SIGTERM");
  } catch { /* already gone */ }
  subshell = null;
}

/** Run one command in the persistent shell, streaming its output.
 *
 *  Returns the exit status and the shell's working directory afterwards, so a
 *  `cd` inside a script — not just a bare `cd` — still moves the panel. */
export async function runPersistent(
  command: string,
  cwd: string,
  onLine: (l: Line) => void,
  signal: AbortSignal,
): Promise<{ code: number; cwd: string } | null> {
  const sh = subshell ?? startSubshell(cwd);
  if (!sh) return null;

  const dec = new TextDecoder();
  let out = "";
  let done = false;

  // stderr is drained in the background: it has no sentinel of its own, and a
  // command that writes only to stderr must still be readable.
  const pumpErr = (async () => {
    let carry = "";
    while (!done) {
      const r = await sh.stderr.read().catch(() => ({
        done: true,
        value: undefined,
      }));
      if (r.done || !r.value) return;
      carry += dec.decode(r.value, { stream: true });
      const parts = carry.split("\n");
      carry = parts.pop() ?? "";
      for (const text of parts) onLine({ text, err: true });
    }
  })();

  try {
    // `cd` first so a command that changes directory starts where the panel is;
    // then the command; then the sentinel, carrying the status and the pwd.
    await sh.stdin.write(
      new TextEncoder().encode(
        `cd ${JSON.stringify(cwd)} 2>/dev/null\n${command}\n` +
          `printf '%s %s %s\\n' "${SENTINEL}" "$?" "$PWD"\n`,
      ),
    );
  } catch {
    stopSubshell();
    return null;
  }

  let carry = "";
  let code = 0;
  let finalCwd = cwd;
  while (!signal.aborted) {
    const r = await sh.stdout.read().catch(() => ({
      done: true,
      value: undefined,
    }));
    if (r.done || !r.value) {
      // The shell itself ended — `exit 3`, or it died. Its status is the
      // command's status, and the next command starts a fresh one.
      const status = await sh.child.status.catch(() => ({ code: 0 }));
      code = status.code;
      subshell = null;
      break;
    }
    carry += dec.decode(r.value, { stream: true });
    const parts = carry.split("\n");
    carry = parts.pop() ?? "";
    let finished = false;
    for (const text of parts) {
      if (text.startsWith(SENTINEL)) {
        const [, status, ...rest] = text.split(" ");
        code = Number(status) || 0;
        finalCwd = rest.join(" ") || cwd;
        finished = true;
        break;
      }
      onLine({ text, err: false });
      out += text;
    }
    if (finished) break;
  }

  done = true;
  await Promise.race([pumpErr, new Promise((r) => setTimeout(r, 50))]);
  if (signal.aborted) {
    // The command is still running in the shell; interrupting it means killing
    // the shell, and a fresh one starts on the next command.
    stopSubshell();
    return { code: 130, cwd: finalCwd };
  }
  return { code, cwd: finalCwd };
}

/** Run `command` through the user's shell in `cwd`, feeding lines to `onLine`
 *  as they arrive. Streaming matters: a build that prints for two minutes must
 *  be readable while it runs, not after it exits. */
export async function run(
  command: string,
  cwd: string,
  onLine: (l: Line) => void,
  signal: AbortSignal,
): Promise<number> {
  const shell = Deno.env.get("SHELL") || "/bin/sh";
  const child = new Deno.Command(shell, {
    args: ["-c", command],
    cwd,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).spawn();

  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
  };
  signal.addEventListener("abort", kill, { once: true });

  const pump = async (stream: ReadableStream<Uint8Array>, err: boolean) => {
    const dec = new TextDecoder();
    let carry = "";
    for await (const chunk of stream) {
      carry += dec.decode(chunk, { stream: true });
      const parts = carry.split("\n");
      carry = parts.pop() ?? "";
      for (const text of parts) onLine({ text, err });
    }
    if (carry) onLine({ text: carry, err });
  };

  await Promise.all([pump(child.stdout, false), pump(child.stderr, true)]);
  const status = await child.status;
  signal.removeEventListener("abort", kill);
  return status.code;
}

/** Run a command and hand back everything it printed, rather than streaming it
 *  to the shell view: M-! and C-x ! want the OUTPUT itself — one to show in the
 *  viewer, the other to read as a list of filenames.
 *
 *  stdout only. stderr is reported separately, because a `find` that prints
 *  "permission denied" on three directories should still panelize the nine
 *  hundred files it did find. */
export async function capture(
  command: string,
  cwd: string,
): Promise<{ out: string; err: string; code: number }> {
  const shell = Deno.env.get("SHELL") || "/bin/sh";
  const r = await new Deno.Command(shell, {
    args: ["-c", command],
    cwd,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  const dec = new TextDecoder();
  return {
    out: dec.decode(r.stdout),
    err: dec.decode(r.stderr),
    code: r.code,
  };
}

/** Where a command's output goes so the viewer can open it: the viewer opens
 *  files, and output is not one until it is written down. */
export async function captureToFile(
  command: string,
  cwd: string,
): Promise<{ path: string; code: number; err: string }> {
  const { out, err, code } = await capture(command, cwd);
  const path = await Deno.makeTempFile({ prefix: "mcx-out-", suffix: ".txt" });
  await Deno.writeTextFile(path, out + (err ? `\n${err}` : ""));
  return { path, code, err };
}

/** Start something and do not wait for it — a file association usually opens a
 *  window of its own, and holding the panel until it closes would be wrong. */
export function spawnDetached(
  command: string,
  cwd: string,
): void {
  const shell = Deno.env.get("SHELL") || "/bin/sh";
  try {
    const child = new Deno.Command(shell, {
      args: ["-c", command],
      cwd,
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).spawn();
    child.unref();
  } catch { /* nothing to wait for, and nothing to report */ }
}

/** `cd` is not a subprocess — it changes the panel. Returns the resolved
 *  target when the command is a bare `cd`, else null. */
export function cdTarget(command: string): string | null {
  const m = command.trim().match(/^cd(?:\s+(.*))?$/);
  if (!m) return null;
  const rest = (m[1] ?? "~").trim();
  // Only a BARE `cd`. `cd sub && make` merely starts with the word: it is a
  // command for the shell, which will report where it ended up and move the
  // panel that way instead. Taking it here made the panel try to enter a
  // directory called "sub && make".
  // `$VAR` and `~` stay here: the panel expands them exactly as mc's
  // `examine_cd` does. What must go to the shell is anything that makes the
  // line a COMMAND rather than a path.
  if (/[;&|<>()`*?]/.test(rest)) return null;
  return rest.replace(/^["']|["']$/g, "");
}

/** Path completion for mc's `alt-tab`.
 *
 *  Three shapes, because that is what gets typed: an absolute path, a `~` path,
 *  and a bare name relative to the panel. Directories come back with a trailing
 *  slash, so a second alt-tab walks into them instead of stopping at the name.
 *
 *  `common` is the longest prefix every match shares — what a shell inserts
 *  when it cannot finish the job. */
export async function complete(
  word: string,
  cwd: string,
): Promise<{ common: string; matches: string[] }> {
  const home = Deno.env.get("HOME") ?? "";
  const tilde = word.startsWith("~/") && home !== "";
  const expanded = tilde ? home + word.slice(1) : word;

  const cut = expanded.lastIndexOf("/");
  const dir = cut < 0 ? cwd : cut === 0 ? "/" : expanded.slice(0, cut);
  const stem = expanded.slice(cut + 1);
  /** What to put back in front of a match — the part of `word` we did not
   *  search with, spelled as the user spelled it. */
  const prefix = cut < 0 ? "" : word.slice(0, word.lastIndexOf("/") + 1);

  const matches: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.name.startsWith(stem)) continue;
      // A leading dot is only offered once it has been typed, as in a shell.
      if (stem === "" && e.name.startsWith(".")) continue;
      matches.push(prefix + e.name + (e.isDirectory ? "/" : ""));
    }
  } catch {
    return { common: word, matches: [] };
  }
  matches.sort();

  let common = matches[0] ?? word;
  for (const m of matches) {
    let i = 0;
    while (i < common.length && i < m.length && common[i] === m[i]) i++;
    common = common.slice(0, i);
  }
  return { common, matches };
}

/** What `file` says a file is — mc's `Type=` sections match against this.
 *
 *  Only ever asked when no section claimed the NAME, because it is a
 *  subprocess per Enter and the name answers almost every time. An absent or
 *  failing `file` is an empty description, which simply matches nothing. */
export async function fileType(path: string): Promise<string> {
  try {
    const out = await new Deno.Command("file", {
      args: ["-b", "--", path],
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return "";
  }
}
