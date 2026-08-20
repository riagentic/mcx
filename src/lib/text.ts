/** Pure document editing. Every mutation is a function from (lines, position)
 *  to new lines + new position, so the editor cell holds no logic and every
 *  rule here is testable without a UI, a file, or a keystroke. */

export type Pos = { line: number; col: number };

/** Split a file into lines, remembering how it ended so saving round-trips.
 *  A file that gains or loses a trailing newline every time it is opened is a
 *  file that produces noise in every diff. */
export function splitLines(
  text: string,
): { lines: string[]; trailingNewline: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines: lines.length === 0 ? [""] : lines, trailingNewline };
}

export const joinLines = (
  lines: readonly string[],
  trailingNewline: boolean,
): string => lines.join("\n") + (trailingNewline ? "\n" : "");

export const clampPos = (lines: readonly string[], p: Pos): Pos => {
  const line = Math.max(0, Math.min(lines.length - 1, p.line));
  return {
    line,
    col: Math.max(0, Math.min((lines[line] ?? "").length, p.col)),
  };
};

/** Is `a` before `b` in the document? */
export const before = (a: Pos, b: Pos): boolean =>
  a.line < b.line || (a.line === b.line && a.col < b.col);

export const samePos = (a: Pos, b: Pos): boolean =>
  a.line === b.line && a.col === b.col;

/** Order two positions — selections are stored as anchor+cursor, which the
 *  user can build in either direction. */
export const orderPos = (
  a: Pos,
  b: Pos,
): [Pos, Pos] => (before(b, a) ? [b, a] : [a, b]);

/** Insert `text` (which may contain newlines) at `at`. */
export function insertAt(
  lines: readonly string[],
  at: Pos,
  text: string,
): { lines: string[]; pos: Pos } {
  const p = clampPos(lines, at);
  const out = [...lines];
  const cur = out[p.line] ?? "";
  const head = cur.slice(0, p.col);
  const tail = cur.slice(p.col);
  const parts = text.replace(/\r\n/g, "\n").split("\n");

  if (parts.length === 1) {
    out[p.line] = head + parts[0] + tail;
    return { lines: out, pos: { line: p.line, col: p.col + parts[0]!.length } };
  }

  const last = parts[parts.length - 1]!;
  const middle = parts.slice(1, -1);
  out.splice(
    p.line,
    1,
    head + parts[0],
    ...middle,
    last + tail,
  );
  return {
    lines: out,
    pos: { line: p.line + parts.length - 1, col: last.length },
  };
}

/** Remove everything between two positions, returning what was removed so the
 *  undo stack can put it back. */
export function deleteRange(
  lines: readonly string[],
  from: Pos,
  to: Pos,
): { lines: string[]; pos: Pos; removed: string } {
  const [a, b] = orderPos(clampPos(lines, from), clampPos(lines, to));
  if (samePos(a, b)) return { lines: [...lines], pos: a, removed: "" };

  const out = [...lines];
  const first = out[a.line] ?? "";
  const last = out[b.line] ?? "";

  const removed = a.line === b.line ? first.slice(a.col, b.col) : [
    first.slice(a.col),
    ...out.slice(a.line + 1, b.line),
    last.slice(0, b.col),
  ].join("\n");

  out.splice(
    a.line,
    b.line - a.line + 1,
    first.slice(0, a.col) + last.slice(b.col),
  );
  return { lines: out, pos: a, removed };
}

export function textInRange(
  lines: readonly string[],
  from: Pos,
  to: Pos,
): string {
  return deleteRange(lines, from, to).removed;
}

/** One position left, stepping over a line break. */
export function leftOf(lines: readonly string[], p: Pos): Pos {
  if (p.col > 0) return { line: p.line, col: p.col - 1 };
  if (p.line === 0) return p;
  return { line: p.line - 1, col: (lines[p.line - 1] ?? "").length };
}

/** One position right, stepping over a line break. */
export function rightOf(lines: readonly string[], p: Pos): Pos {
  const len = (lines[p.line] ?? "").length;
  if (p.col < len) return { line: p.line, col: p.col + 1 };
  if (p.line >= lines.length - 1) return p;
  return { line: p.line + 1, col: 0 };
}

/** Whitespace that starts a line — what Enter should reproduce, because
 *  re-indenting by hand after every newline is the difference between an
 *  editor and a text box. */
export const indentOf = (line: string): string =>
  line.match(/^[ \t]*/)?.[0] ?? "";

/** Find `needle` from `from`, wrapping once. Returns the match position, or
 *  null when the document does not contain it at all. */
export function findFrom(
  lines: readonly string[],
  needle: string,
  from: Pos,
  caseInsensitive: boolean,
  backwards = false,
): Pos | null {
  if (!needle) return null;
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const n = fold(needle);
  const count = lines.length;

  for (let k = 0; k <= count; k++) {
    const li = backwards
      ? (from.line - k + count * 2) % count
      : (from.line + k) % count;
    const hay = fold(lines[li] ?? "");
    let at: number;
    if (backwards) {
      const limit = k === 0 ? from.col - 1 : hay.length;
      at = limit < 0 ? -1 : hay.lastIndexOf(n, limit);
    } else {
      at = hay.indexOf(n, k === 0 ? from.col : 0);
    }
    if (at >= 0) return { line: li, col: at };
  }
  return null;
}

/** A rectangle of text, given two corners: the lines between them, each cut to
 *  the same column span. mc calls it a column block, and it is the tool for
 *  everything laid out in fixed columns — a table, a diff, a list of paths.
 *
 *  The corners are normalised here rather than by the caller: dragging up-left
 *  and dragging down-right describe the same rectangle. */
export function columnRange(a: Pos, b: Pos): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  return {
    top: Math.min(a.line, b.line),
    bottom: Math.max(a.line, b.line),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  };
}

/** The text of a column block — one line per row, short lines padded to
 *  nothing rather than to spaces, so a block copied from ragged text does not
 *  come back with invented whitespace. */
export function columnText(
  lines: readonly string[],
  a: Pos,
  b: Pos,
): string {
  const { top, bottom, left, right } = columnRange(a, b);
  const out: string[] = [];
  for (let i = top; i <= bottom; i++) {
    out.push((lines[i] ?? "").slice(left, right));
  }
  return out.join("\n");
}

/** Cut a column block out, closing the gap on every line it crossed. */
export function deleteColumn(
  lines: readonly string[],
  a: Pos,
  b: Pos,
): string[] {
  const { top, bottom, left, right } = columnRange(a, b);
  return lines.map((l, i) =>
    i < top || i > bottom ? l : l.slice(0, left) + l.slice(right)
  );
}

/** Paste text as a rectangle: line one at the cursor, line two directly below
 *  it in the same column, and so on. Lines that run out are padded so the block
 *  lands square — pasting a column into short lines is the normal case, not an
 *  error. */
export function insertColumn(
  lines: readonly string[],
  at: Pos,
  text: string,
): string[] {
  const block = text.split("\n");
  const out = [...lines];
  for (const [i, piece] of block.entries()) {
    const row = at.line + i;
    const line = out[row] ?? "";
    const padded = line.length < at.col
      ? line + " ".repeat(at.col - line.length)
      : line;
    out[row] = padded.slice(0, at.col) + piece + padded.slice(at.col);
  }
  return out;
}

/** What counts as part of a word. Deliberately not `\w`: a filename or an
 *  identifier with a digit or an underscore in it is one word, and stopping in
 *  the middle of `read_dir_2` is not what C-Right is for. */
const WORD = /[A-Za-z0-9_]/;

/** The position one word away, in the direction `dir` (+1 right, -1 left).
 *
 *  The rule is the one every editor converges on: skip whatever separators are
 *  under you, then cross the run of word characters. Crossing a line boundary
 *  is allowed, so holding C-Right walks the file rather than sticking at the
 *  end of a line. */
export function wordEdge(
  lines: readonly string[],
  p: Pos,
  dir: 1 | -1,
): Pos {
  let { line, col } = clampPos(lines, p);
  const at = (l: number, c: number) => (lines[l] ?? "")[c] ?? "";
  const step = (): boolean => {
    if (dir > 0) {
      if (col < (lines[line] ?? "").length) col++;
      else if (line < lines.length - 1) {
        line++;
        col = 0;
      } else return false;
    } else {
      if (col > 0) col--;
      else if (line > 0) {
        line--;
        col = (lines[line] ?? "").length;
      } else return false;
    }
    return true;
  };
  // The character we are about to cross is the one BEHIND the cursor when
  // moving left, and the one under it when moving right. A line boundary reads
  // as a separator rather than as the end of the text — otherwise the cursor
  // stops at the end of every line, which is precisely what C-Right is for
  // getting past. Only the ends of the DOCUMENT are "".
  const done = () =>
    dir > 0
      ? line === lines.length - 1 && col >= (lines[line] ?? "").length
      : line === 0 && col === 0;
  const facing = () => {
    if (done()) return "";
    const c = dir > 0 ? at(line, col) : at(line, col - 1);
    return c === "" ? "\n" : c;
  };

  while (facing() !== "" && !WORD.test(facing())) {
    if (!step()) return { line, col };
  }
  while (facing() !== "" && WORD.test(facing())) {
    if (!step()) return { line, col };
  }
  return { line, col };
}

const OPEN = "([{";
const CLOSE = ")]}";

/** The bracket matching the one under the cursor, or null.
 *
 *  Counts nesting rather than looking for the next bracket of the same shape,
 *  which is the difference between landing on the right one and landing on the
 *  first one. Searches forward from an opener and backward from a closer, the
 *  way the pair is written. */
export function matchBracket(
  lines: readonly string[],
  p: Pos,
): Pos | null {
  const ch = (lines[p.line] ?? "")[p.col] ?? "";
  const openIdx = OPEN.indexOf(ch);
  const closeIdx = CLOSE.indexOf(ch);
  if (openIdx < 0 && closeIdx < 0) return null;
  const dir = openIdx >= 0 ? 1 : -1;
  const want = openIdx >= 0 ? CLOSE[openIdx]! : OPEN[closeIdx]!;
  let depth = 0;
  let { line, col } = p;
  for (;;) {
    const c = (lines[line] ?? "")[col];
    if (c === ch) depth++;
    else if (c === want) {
      depth--;
      if (depth === 0) return { line, col };
    }
    col += dir;
    if (col < 0) {
      line--;
      if (line < 0) return null;
      col = (lines[line] ?? "").length - 1;
    } else if (col >= (lines[line] ?? "").length) {
      line++;
      if (line >= lines.length) return null;
      col = 0;
    }
  }
}

/** The word being typed, immediately before `p` — what completion completes. */
export function wordBefore(lines: readonly string[], p: Pos): string {
  const line = lines[p.line] ?? "";
  let i = p.col;
  while (i > 0 && WORD.test(line[i - 1] ?? "")) i--;
  return line.slice(i, p.col);
}

/** Every distinct word in the document that begins with `prefix`, nearest
 *  first — M-Tab's candidates. The document is its own dictionary, which is
 *  what makes completion useful in a file the editor knows nothing about. */
export function completions(
  lines: readonly string[],
  prefix: string,
  from: number,
): string[] {
  if (prefix === "") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Outward from the cursor's line: the word you want is usually near.
  const order: number[] = [];
  for (let d = 0; d < lines.length; d++) {
    if (from - d >= 0) order.push(from - d);
    if (d > 0 && from + d < lines.length) order.push(from + d);
  }
  for (const i of order) {
    for (const w of (lines[i] ?? "").match(/[A-Za-z0-9_]+/g) ?? []) {
      if (w !== prefix && w.startsWith(prefix) && !seen.has(w)) {
        seen.add(w);
        out.push(w);
      }
    }
  }
  return out;
}

/** Flatten nroff overstrike, the way `man` produces it for a terminal that has
 *  no attributes: `X\bX` is X in bold, `_\bX` is X underlined. Left alone it
 *  renders as literal backspaces and doubled letters, which is why mc has a
 *  mode for it.
 *
 *  Pure, and applied to the WINDOW rather than the file: the bytes on disk are
 *  never touched, so switching the mode back shows exactly what is there. */
export function stripOverstrike(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    // A backspace means "the character before me was overstruck by the one
    // after me" — keep the one that survives on paper.
    if (line[i + 1] === "\b") {
      const kept = line[i + 2] ?? "";
      out += line[i] === "_" ? kept : line[i]!;
      i += 2;
      continue;
    }
    out += line[i];
  }
  return out;
}
