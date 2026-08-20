/** The user-menu file format — `~/.mcx/menu`, or a `.mcx.menu` beside the
 *  files.
 *
 *  It is mc's format, deliberately: thirty years of documented syntax, and a
 *  file anyone can copy across in one command. What mcx does not do is read
 *  mc's copy of it — the profile is mcx's own (`cell/profile.server.ts`).
 *
 *  Pure: parsing, deciding which entries apply, and expanding the macros are
 *  all functions of their inputs. The one place this touches the world is the
 *  shell command that comes out the other end, and that is the caller's job.
 *
 *  The format, from mc's own `mc.menu`:
 *
 *      shell_patterns=0          a directive
 *      # a comment
 *      + f \.tar$ | f \.tgz$     a condition: this entry applies when…
 *      x   Extract this archive  an ENTRY: hotkey, whitespace, label
 *          tar xf %f             …and its indented command lines
 */

export type MenuEntry = {
  /** The character that picks it — mc puts it in the left column. */
  hotkey: string;
  label: string;
  /** Shell lines, in order, with the macros still in them. */
  commands: string[];
  /** The `+`/`=` condition, unparsed, or "" for an entry that always applies. */
  condition: string;
  /** `=` marks the entry mc pre-selects. */
  isDefault: boolean;
};

/** What an entry is tested against. */
export type MenuContext = {
  /** The file under the cursor. */
  name: string;
  /** `f` regular file, `d` directory, `l` link, `x` executable. */
  type: string;
  /** Anything marked? — mc's `t` and `n` conditions. */
  tagged: boolean;
};

/** Split a menu file into entries.
 *
 *  An entry starts at column 0 with its hotkey; everything indented after it is
 *  its command. Conditions attach to the entry that FOLLOWS them, which is why
 *  they are held in `pending` rather than applied as they are read. */
export function parseMenu(text: string): MenuEntry[] {
  const out: MenuEntry[] = [];
  let pending = "";
  let pendingDefault = false;
  let current: MenuEntry | null = null;

  for (const raw of text.split("\n")) {
    if (raw.trim() === "" && !current) continue;
    if (raw.startsWith("#")) continue;
    // `shell_patterns=` and friends: directives, not entries.
    if (/^\w+=/.test(raw) && !raw.startsWith(" ") && !raw.startsWith("\t")) {
      continue;
    }

    // An indented line belongs to the entry above it.
    if (/^[ \t]/.test(raw)) {
      if (current) current.commands.push(raw.replace(/^[ \t]+/, ""));
      continue;
    }

    // A condition line: `+ …`, `= …`, `=+ …`.
    if (raw.startsWith("+") || raw.startsWith("=")) {
      const isDefault = raw.startsWith("=");
      const body = raw.replace(/^=\+?|^\+/, "").trim();
      pending = body;
      pendingDefault = isDefault;
      continue;
    }

    // Otherwise: an entry. The hotkey is the first character, the label is
    // what follows the whitespace after it.
    const m = /^(\S)\s+(.*)$/.exec(raw);
    if (!m) continue;
    current = {
      hotkey: m[1]!,
      label: m[2]!.trim(),
      commands: [],
      condition: pending,
      isDefault: pendingDefault,
    };
    out.push(current);
    pending = "";
    pendingDefault = false;
  }
  return out.filter((e) => e.commands.length > 0);
}

/** One term of a condition: `f <regex>`, `t <letters>`, or `y`/`x` forms mcx
 *  does not model (which are treated as unmet rather than as true — an entry
 *  offered for the wrong file is worse than one missing). */
function term(t: string, ctx: MenuContext): boolean {
  const s = t.trim();
  if (s === "") return true;
  const kind = s[0];
  const rest = s.slice(1).trim();
  if (kind === "f") {
    try {
      return new RegExp(rest).test(ctx.name);
    } catch {
      return false; // an unparsable pattern matches nothing
    }
  }
  if (kind === "t") {
    // Any of the listed type letters. `t` = something is tagged, `n` = nothing.
    for (const c of rest) {
      if (c === "t" && ctx.tagged) return true;
      if (c === "n" && !ctx.tagged) return true;
      if (ctx.type.includes(c)) return true;
    }
    return false;
  }
  return false;
}

/** Does this entry apply here?
 *
 *  mc's grammar is `!` for not, `&` for and, `|` for or, evaluated left to
 *  right with `&` binding tighter — which is what splitting on `|` first and
 *  then on `&` gives. */
export function conditionHolds(cond: string, ctx: MenuContext): boolean {
  const c = cond.trim();
  if (c === "") return true;
  // A leading `!` negates the whole condition, as in mc's `+ ! t t`.
  if (c.startsWith("!")) return !conditionHolds(c.slice(1), ctx);
  return c.split("|").some((orPart) =>
    orPart.split("&").every((andPart) => {
      const p = andPart.trim();
      return p.startsWith("!") ? !term(p.slice(1), ctx) : term(p, ctx);
    })
  );
}

/** The entries that apply, in file order. */
export const applicable = (
  entries: readonly MenuEntry[],
  ctx: MenuContext,
): MenuEntry[] => entries.filter((e) => conditionHolds(e.condition, ctx));

/** What a macro can be replaced by. Uppercase letters mean the other panel,
 *  which is why each of these comes in a pair. */
export type MenuMacros = {
  /** The file under the cursor, and the panel's directory. */
  file: string;
  dir: string;
  /** The marked files, or the cursor file when nothing is marked. */
  tagged: string[];
  otherFile: string;
  otherDir: string;
  otherTagged: string[];
};

/** Expand mc's macros in one command line.
 *
 *  `quote` is passed in rather than imported so this module stays free of any
 *  opinion about shells; `%0f` turns quoting off for one macro, which is how
 *  mc lets an entry build a command out of pieces. */
export function expandMacros(
  line: string,
  m: MenuMacros,
  quote: (s: string) => string,
): string {
  const value = (letter: string): string | null => {
    const q = (s: string) => quote(s);
    const list = (xs: string[]) => xs.map(q).join(" ");
    switch (letter) {
      case "f":
      case "p":
        return q(m.file);
      case "F":
      case "P":
        return q(m.otherFile);
      case "d":
        return q(m.dir);
      case "D":
        return q(m.otherDir);
      case "t":
      case "s":
      case "u":
        return list(m.tagged);
      case "T":
      case "S":
      case "U":
        return list(m.otherTagged);
      case "n":
        return q(m.file.replace(/\.[^.]*$/, ""));
      case "x": {
        const dot = m.file.lastIndexOf(".");
        return q(dot > 0 ? m.file.slice(dot + 1) : "");
      }
      default:
        return null;
    }
  };

  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") {
      out += line[i];
      continue;
    }
    const next = line[i + 1];
    if (next === "%") {
      out += "%";
      i++;
      continue;
    }
    // `%0f` / `%1f`: quoting off / on for this one macro.
    if (next === "0" || next === "1") {
      const letter = line[i + 2] ?? "";
      const v = next === "0"
        ? expandMacros(`%${letter}`, m, (s) => s)
        : value(letter);
      if (v === null) {
        out += line[i];
        continue;
      }
      out += v;
      i += 2;
      continue;
    }
    const v = value(next ?? "");
    if (v === null) {
      out += line[i];
      continue;
    }
    out += v;
    i++;
  }
  return out;
}

/** The prompts a command asks for before it runs: mc's `%{Enter command}`.
 *  Returned in order, so the caller can ask for them and substitute the
 *  answers back with `fillPrompts`. */
export function promptsOf(commands: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of commands) {
    for (const m of line.matchAll(/%\{([^}]*)\}/g)) out.push(m[1] ?? "");
  }
  return out;
}

/** Put the answers back, in the order they were asked for.
 *
 *  QUOTED, like every other macro. mc's own menu file shows why: the entry
 *  `CMD=%{Enter command}` followed by `$CMD %f` is meant to put a whole command
 *  in a variable, and an unquoted answer of `ls -l` sets `CMD=ls` and then runs
 *  `-l`. An answer with a space in it is the normal case, not the exception. */
export function fillPrompts(
  commands: readonly string[],
  answers: readonly string[],
  quote: (s: string) => string = (s) => s,
): string[] {
  let i = 0;
  return commands.map((line) =>
    line.replaceAll(/%\{[^}]*\}/g, () => quote(answers[i++] ?? ""))
  );
}
