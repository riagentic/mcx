// Server-only: reading and writing the edited file.

export type ReadResult = { text: string; error: string | null };

/** Read a file for editing. A file that does not exist is an empty buffer —
 *  that is how a new file gets created. A file too large to hold is refused
 *  with a reason, not truncated behind the user's back. */
export async function read(
  path: string,
  maxBytes: number,
): Promise<ReadResult> {
  try {
    const st = await Deno.stat(path);
    if (st.isDirectory) return { text: "", error: "is a directory" };
    if (st.size > maxBytes) {
      return {
        text: "",
        error: `${
          (st.size / 1048576).toFixed(1)
        } MB is too large to edit — use the viewer (F3)`,
      };
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      return { text: "", error: e instanceof Error ? e.message : String(e) };
    }
    return { text: "", error: null }; // new file
  }
  try {
    // Decoded rather than `readTextFile`, so a file written in Latin-1 or
    // KOI8-R can be edited as what it is. `fatal: false` because a viewer that
    // refuses to show a file with one bad byte in it is useless.
    const bytes = await Deno.readFile(path);
    return {
      text: new TextDecoder(charset, { fatal: false }).decode(bytes),
      error: null,
    };
  } catch (e) {
    return { text: "", error: e instanceof Error ? e.message : String(e) };
  }
}

/** The character set this editor reads and writes. */
let charset = "utf-8";
export function setCharset(label: string): void {
  charset = label;
}

/** Encode text back to the file's character set. `TextEncoder` only speaks
 *  UTF-8, so anything else goes out through the one place that can: the
 *  platform's decoder tables run one way only, which means a non-UTF-8 save is
 *  refused rather than silently written as UTF-8 under the old name. */
export function encodeFor(
  text: string,
): { bytes: Uint8Array; error: string | null } {
  if (charset === "utf-8") {
    return { bytes: new TextEncoder().encode(text), error: null };
  }
  return {
    bytes: new Uint8Array(),
    error: `saving as ${charset} is not supported — reopen as UTF-8 to save`,
  };
}

/** Write via a sibling temp file and rename.
 *
 *  The rename is atomic on POSIX, so a crash (or a full disk) mid-save leaves
 *  the ORIGINAL intact rather than a half-written file. The permissions of the
 *  existing file are carried over, because a save must not turn a script into
 *  a non-executable one. */
export async function write(
  path: string,
  text: string,
): Promise<string | null> {
  // A file opened as Latin-1 cannot be written back as Latin-1 (the platform's
  // encoder only speaks UTF-8), and writing it as UTF-8 under the same name
  // would silently change the file's encoding. Refusing is the honest answer.
  const enc = encodeFor(text);
  if (enc.error) return enc.error;
  const tmp = `${path}.mcx-${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    let mode: number | undefined;
    try {
      mode = (await Deno.stat(path)).mode ?? undefined;
    } catch { /* new file — the umask decides */ }

    await Deno.writeTextFile(tmp, text);
    if (mode !== undefined) await Deno.chmod(tmp, mode & 0o7777);
    await Deno.rename(tmp, path);
    return null;
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    return e instanceof Error ? e.message : String(e);
  }
}

/** Feed text to a command's stdin and take its stdout — mc's M-u, which is how
 *  a block gets sorted by `sort -u`, formatted by `fmt`, or run through
 *  anything else already installed. */
export async function filter(
  command: string,
  input: string,
): Promise<{ text: string; error: string | null }> {
  try {
    const shell = Deno.env.get("SHELL") || "/bin/sh";
    const child = new Deno.Command(shell, {
      args: ["-c", command],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(input));
    await w.close();
    const r = await child.output();
    const dec = new TextDecoder();
    if (r.code !== 0) {
      return {
        text: "",
        error: dec.decode(r.stderr).split("\n")[0] || `exited ${r.code}`,
      };
    }
    return { text: dec.decode(r.stdout), error: null };
  } catch (e) {
    return { text: "", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Hand the file to a mailer. `mail(1)` is the lowest common denominator and
 *  the one mc itself assumes; its absence is reported as itself. */
export async function mail(
  to: string,
  subject: string,
  path: string,
): Promise<string | null> {
  try {
    const file = await Deno.open(path, { read: true });
    const child = new Deno.Command("mail", {
      args: ["-s", subject, to],
      stdin: "piped",
      stderr: "piped",
    }).spawn();
    await file.readable.pipeTo(child.stdin);
    const r = await child.output();
    return r.success
      ? null
      : new TextDecoder().decode(r.stderr).trim() || `mail exited ${r.code}`;
  } catch {
    return "no mail command is installed";
  }
}

/** Spelling suggestions for one word, from whichever speller is present.
 *  `aspell -a` and `hunspell -a` share the ispell pipe protocol, so one parser
 *  serves both: `& word n offset: a, b, c` for a miss, `*` for a hit. */
export async function spell(
  word: string,
): Promise<{ suggestions: string[]; error: string | null }> {
  for (const tool of ["aspell", "hunspell"]) {
    try {
      const child = new Deno.Command(tool, {
        args: ["-a"],
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const w = child.stdin.getWriter();
      await w.write(new TextEncoder().encode(`${word}\n`));
      await w.close();
      const r = await child.output();
      const out = new TextDecoder().decode(r.stdout);
      for (const line of out.split("\n")) {
        if (line.startsWith("*") || line.startsWith("+")) {
          return { suggestions: [], error: null };
        }
        if (line.startsWith("&")) {
          const after = line.slice(line.indexOf(":") + 1);
          return {
            suggestions: after.split(",").map((x) => x.trim()).filter(Boolean),
            error: null,
          };
        }
      }
      return { suggestions: [], error: null };
    } catch { /* try the next speller */ }
  }
  return {
    suggestions: [],
    error: "no speller installed (aspell or hunspell)",
  };
}

/** The system clipboard, through whatever this machine has.
 *
 *  mc does the same thing and calls it `clipboard_store`/`clipboard_paste` —
 *  two commands in its ini, unset by default, so an mc that nobody configured
 *  can only paste into itself. mcx looks for the usual tools instead: a desktop
 *  app whose copy cannot reach the browser next to it is a surprise, and the
 *  tools are the same three everywhere.
 *
 *  Which pair works is decided once and remembered — probing four programs on
 *  every C-Ins would be four subprocesses per keystroke. `null` means "looked,
 *  found nothing": the editor's own clipboard still works, and it is the only
 *  one a headless test ever sees. */
type ClipTool = { store: string[]; paste: string[] };

const CLIP_TOOLS: ClipTool[] = [
  // Wayland first: on a Wayland session xclip may exist and do nothing.
  { store: ["wl-copy"], paste: ["wl-paste", "--no-newline"] },
  {
    store: ["xclip", "-selection", "clipboard"],
    paste: ["xclip", "-selection", "clipboard", "-o"],
  },
  {
    store: ["xsel", "--clipboard", "--input"],
    paste: ["xsel", "--clipboard", "--output"],
  },
  { store: ["pbcopy"], paste: ["pbpaste"] },
];

let clipTool: ClipTool | null | undefined; // undefined = not looked yet

async function findClipTool(): Promise<ClipTool | null> {
  if (clipTool !== undefined) return clipTool;
  clipTool = null;
  for (const tool of CLIP_TOOLS) {
    try {
      // `--help` rather than `which`: it answers "is it runnable", which is the
      // question, and costs the same.
      const p = new Deno.Command(tool.store[0]!, {
        args: ["--help"],
        stdout: "null",
        stderr: "null",
        stdin: "null",
      }).spawn();
      await p.status;
      clipTool = tool;
      break;
    } catch { /* not installed — try the next */ }
  }
  return clipTool;
}

export async function clipboardStore(text: string): Promise<void> {
  const tool = await findClipTool();
  if (!tool) return;
  try {
    const child = new Deno.Command(tool.store[0]!, {
      args: tool.store.slice(1),
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(text));
    await w.close();
    await child.status;
  } catch { /* the clipboard is a convenience, never a failure */ }
}

export async function clipboardPaste(): Promise<string> {
  const tool = await findClipTool();
  if (!tool) return "";
  try {
    const r = await new Deno.Command(tool.paste[0]!, {
      args: tool.paste.slice(1),
      stdout: "piped",
      stderr: "null",
      stdin: "null",
    }).output();
    return new TextDecoder().decode(r.stdout);
  } catch {
    return "";
  }
}
