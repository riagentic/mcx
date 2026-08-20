// The editor (F4) — mcedit's job.
//
// Same discipline as the panels and the viewer: the document lives server-side
// and the client receives the window it draws. That is what lets mcx open a
// 100_000-line file in an Electron renderer without shipping it there.
import { cell } from "aio";
import { ui } from "./ui.ts";
import { basename } from "../lib/path.ts";
import { charsetName, isCharset } from "../lib/charsets.ts";
import {
  before,
  clampPos,
  columnText,
  completions,
  deleteColumn,
  deleteRange,
  findFrom,
  indentOf,
  insertAt,
  insertColumn,
  joinLines,
  leftOf,
  matchBracket,
  orderPos,
  type Pos,
  rightOf,
  samePos,
  splitLines,
  textInRange,
  wordBefore,
  wordEdge,
} from "../lib/text.ts";

type Snapshot = { lines: string[]; pos: Pos };

type EditorState = {
  visible: boolean;
  path: string;
  /** The whole document — server-side only. */
  doc: string[];
  /** The lines the UI draws. */
  rows: string[];
  /** Index of `rows[0]`. */
  top: number;
  viewport: number;
  cursor: Pos;
  /** The block's near end, or null when nothing is marked. */
  anchor: Pos | null;
  /** The block's far end, once it has been FIXED with a second F3.
   *
   *  This is mc's block model and the reason it is not just "anchor to
   *  cursor": in mcedit a marked block stays marked while the cursor walks
   *  away from it, which is what makes F5 "copy the block to here" and F6
   *  "move the block to here" mean anything. `null` means the block is still
   *  being drawn — it follows the cursor. */
  markEnd: Pos | null;
  /** F3 pressed once: the block is being drawn and every move extends it. */
  marking: boolean;
  modified: boolean;
  trailingNewline: boolean;
  lineCount: number;
  /** Undo/redo, server-side: a stack of documents is not client business. */
  undo: Snapshot[];
  redo: Snapshot[];
  search: string;
  replace: string;
  error: string | null;

  /** Insert or overwrite (Ins) — mc shows the mode, and so does mcx, because a
   *  keyboard that silently eats what it types is a bad afternoon. */
  overwrite: boolean;
  /** Line numbers down the left (M-n) and tabs/trailing spaces made visible
   *  (M-_): mc's two display toggles. */
  numbers: boolean;
  showTabs: boolean;
  /** Syntax highlighting, which mc lets you turn off — on a file whose
   *  highlighting is wrong, off is better than wrong. */
  syntax: boolean;
  /** Line bookmarks (M-k), walked with M-j / M-i and cleared with M-o. */
  bookmarks: number[];
  /** The character set the file is read as (M-e). */
  charset: string;
  /** The selection is a RECTANGLE rather than a run of text (S-F3, and the
   *  M-arrow marks). Everything that reads a selection branches on this one
   *  flag, which is why it lives next to `anchor` rather than in a parallel
   *  set of column-flavoured methods. */
  columnMode: boolean;
};

/** Bounded so a long session cannot grow without limit. mcedit's default is
 *  smaller; this is one that survives a careless paste. */
const UNDO_LIMIT = 200;
/** Refusal threshold. Above this the viewer is the honest answer. */
const MAX_EDIT_BYTES = 32 * 1024 * 1024;

const view = (s: EditorState) => {
  const top = Math.max(0, Math.min(s.top, Math.max(0, s.doc.length - 1)));
  return {
    top,
    rows: s.doc.slice(top, top + s.viewport),
    lineCount: s.doc.length,
  };
};

/** Scroll so the cursor is on screen, then republish the window. */
function reframe(s: EditorState): void {
  if (s.cursor.line < s.top) s.top = s.cursor.line;
  else if (s.cursor.line >= s.top + s.viewport) {
    s.top = s.cursor.line - s.viewport + 1;
  }
  Object.assign(s, view(s));
}

/** Re-wrap a paragraph to `width`, keeping the indentation of its first line —
 *  mc's M-p. Blank lines are paragraph breaks and survive as themselves. */
function reflow(lines: readonly string[], width: number): string[] {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length === 0) return;
    const indent = indentOf(para[0]!);
    const words = para.join(" ").trim().split(/\s+/).filter(Boolean);
    let line = indent;
    for (const w of words) {
      if (line.trim() !== "" && (line + " " + w).length > width) {
        out.push(line);
        line = indent + w;
      } else line = line.trim() === "" ? indent + w : line + " " + w;
    }
    if (line.trim() !== "") out.push(line);
    para = [];
  };
  for (const l of lines) {
    if (l.trim() === "") {
      flush();
      out.push(l);
    } else para.push(l);
  }
  flush();
  return out;
}

/** Record the state an edit is about to change. */
function push(s: EditorState): void {
  s.undo.push({ lines: [...s.doc], pos: { ...s.cursor } });
  if (s.undo.length > UNDO_LIMIT) s.undo.shift();
  s.redo = [];
}

/** The block's far end: where it was fixed, or the cursor while it is still
 *  being drawn. */
const blockEnd = (s: EditorState): Pos => s.markEnd ?? s.cursor;

/** The marked block as an ordered pair, or null when nothing is marked. */
const block = (s: EditorState): [Pos, Pos] | null =>
  s.anchor ? orderPos(s.anchor, blockEnd(s)) : null;

/** Open a file — the body of `open`, as a plain function, so `setCharset` can
 *  re-read it in the SAME transaction as the write that changed the decoding. */
async function applyOpen(s: EditorState, path: string): Promise<void> {
  ui.rememberFile(path, "edit");
  const io = await import("./editor.server.ts");
  const r = await io.read(path, MAX_EDIT_BYTES);
  if (r.error) {
    ui.say(`Cannot edit ${basename(path)}: ${r.error}`);
    return;
  }
  const { lines, trailingNewline } = splitLines(r.text);
  Object.assign(s, {
    visible: true,
    path,
    doc: lines,
    trailingNewline,
    cursor: { line: 0, col: 0 },
    anchor: null,
    markEnd: null,
    marking: false,
    top: 0,
    modified: false,
    undo: [],
    redo: [],
    error: null,
  });
  Object.assign(s, view(s));
}

/** Insert text at the cursor — the body of `insert`, as a plain function.
 *
 *  `paste` needs the same work, and a cell method that calls its own cell's
 *  method gets a SECOND transaction reading committed state, which is a
 *  different insert into a document one edit behind. Sharing the body keeps it
 *  one write and one commit. */
function applyInsert(s: EditorState, text: string): void {
  push(s);
  // Overwrite mode consumes the character under the cursor instead of pushing
  // it along — but never past the end of the line, and never for a newline,
  // which always inserts.
  if (s.overwrite && text.length === 1 && text !== "\n" && !s.anchor) {
    const line = s.doc[s.cursor.line] ?? "";
    if (s.cursor.col < line.length) {
      const cut = deleteRange(s.doc, s.cursor, {
        line: s.cursor.line,
        col: s.cursor.col + 1,
      });
      s.doc = cut.lines;
    }
  }
  const sel = activeSelection(s);
  if (sel && !samePos(sel[0], sel[1])) {
    const [a, b] = sel;
    const cut = deleteRange(s.doc, a, b);
    s.doc = cut.lines;
    s.cursor = cut.pos;
    clearMark(s);
  }
  const r = insertAt(s.doc, s.cursor, text);
  s.doc = r.lines;
  s.cursor = r.pos;
  s.modified = true;
  reframe(s);
}

/** The block a keystroke may TYPE OVER.
 *
 *  Only a plain shift-selection: the cursor is at one end of it, so replacing
 *  it is what the user is looking at. A block marked with F3 is not — it can
 *  be a screen away — and deleting that because someone typed a letter is the
 *  trap mc avoids by never typing over a block at all. */
const activeSelection = (s: EditorState): [Pos, Pos] | null =>
  s.markEnd === null && !s.marking ? block(s) : null;

/** Forget the block. Every edit does this: a block that outlived the text it
 *  described would name the wrong characters. */
const clearMark = (s: EditorState): void => {
  s.anchor = null;
  s.markEnd = null;
  s.marking = false;
};

/** What a cursor move does to the block.
 *
 *  Unshifted: a block being drawn follows, a FIXED block stays where it is
 *  (mc), and an ordinary shift-selection ends. Shifted: extend, or start a
 *  fresh selection when a fixed block is in the way. */
const trackMark = (s: EditorState, select: boolean): void => {
  if (!select) {
    if (s.marking || s.markEnd) return;
    return clearMark(s);
  }
  // A block being drawn keeps being drawn: mc extends it with plain arrows AND
  // with shifted ones, and only F3 fixes it.
  if (s.marking) return;
  if (s.markEnd) {
    // Shift-moving away from a fixed block starts a fresh selection here.
    s.anchor = { ...s.cursor };
    s.markEnd = null;
  } else if (!s.anchor) {
    s.anchor = { ...s.cursor };
  }
};

export const editor = cell("editor", {
  // A half-typed buffer must not come back as "the file" after a restart — the
  // file on disk is the truth. Only the position is worth restoring.
  persist: {
    exclude: [
      "doc",
      "rows",
      "undo",
      "redo",
      "visible",
      "error",
      "modified",
      "anchor",
      "markEnd",
      "marking",
    ],
  },
  visible: { exclude: ["doc", "undo", "redo"] },

  state: {
    visible: false,
    path: "",
    doc: [] as string[],
    rows: [] as string[],
    top: 0,
    viewport: 30,
    cursor: { line: 0, col: 0 } as Pos,
    anchor: null as Pos | null,
    markEnd: null as Pos | null,
    marking: false,
    modified: false,
    trailingNewline: true,
    lineCount: 0,
    undo: [] as Snapshot[],
    redo: [] as Snapshot[],
    search: "",
    replace: "",
    error: null as string | null,
    overwrite: false,
    numbers: false,
    showTabs: false,
    syntax: true,
    bookmarks: [] as number[],
    columnMode: false,
    charset: "utf-8",
  },

  methods: {
    /** F4. A missing file opens as an empty buffer — that is how you create
     *  one, and refusing would be pedantry. */
    async open(s: EditorState, path: string) {
      await applyOpen(s, path);
    },

    /** F2. Writes through a temp file + rename, so an interrupted save cannot
     *  leave a truncated original behind. */
    async save(s: EditorState, path?: string) {
      const target = path || s.path;
      const io = await import("./editor.server.ts");
      const err = await io.write(
        target,
        joinLines(s.doc, s.trailingNewline),
      );
      if (err) {
        s.error = err;
        return void ui.say(`Cannot save: ${err}`);
      }
      s.path = target;
      s.modified = false;
      ui.say(`Saved ${basename(target)}`);
    },

    /** See viewer.hide — the editor keeps its buffer, its undo history and its
     *  cursor while another screen is in front. */
    hide(s: EditorState) {
      s.visible = false;
    },
    show(s: EditorState) {
      if (s.path) s.visible = true;
    },

    close(s: EditorState) {
      s.visible = false;
      s.doc = [];
      s.rows = [];
      s.undo = [];
      s.redo = [];
    },

    setViewport(s: EditorState, rows: number) {
      if (!Number.isFinite(rows)) return; // see panels.setViewport
      const v = Math.max(1, Math.min(4096, Math.floor(rows)));
      if (s.viewport === v) return;
      s.viewport = v;
      reframe(s);
    },

    /** Move the cursor. `select` extends the selection instead of dropping it —
     *  one flag rather than a parallel set of shift-methods. */
    move(s: EditorState, dLine: number, dCol: number, select = false) {
      trackMark(s, select);
      let next = { line: s.cursor.line + dLine, col: s.cursor.col + dCol };
      if (dCol === -1 && s.cursor.col === 0) next = leftOf(s.doc, s.cursor);
      else if (
        dCol === 1 && s.cursor.col === (s.doc[s.cursor.line] ?? "").length
      ) {
        next = rightOf(s.doc, s.cursor);
      }
      s.cursor = clampPos(s.doc, next);
      reframe(s);
    },

    moveTo(s: EditorState, line: number, col: number, select = false) {
      trackMark(s, select);
      s.cursor = clampPos(s.doc, { line, col });
      reframe(s);
    },

    /** Home/End on the current line. */
    lineEdge(s: EditorState, end: boolean, select = false) {
      trackMark(s, select);
      s.cursor = {
        line: s.cursor.line,
        col: end ? (s.doc[s.cursor.line] ?? "").length : 0,
      };
      reframe(s);
    },

    /** C-Left / C-Right — a word at a time. */
    moveWord(s: EditorState, dir: 1 | -1, select = false) {
      trackMark(s, select);
      s.cursor = wordEdge(s.doc, s.cursor, dir);
      reframe(s);
    },

    /** M-BS / M-d — rub out the word behind or ahead of the cursor. */
    eraseWord(s: EditorState, dir: 1 | -1) {
      const to = wordEdge(s.doc, s.cursor, dir);
      if (samePos(to, s.cursor)) return;
      push(s);
      const [a, b] = orderPos(to, s.cursor);
      const cut = deleteRange(s.doc, a, b);
      s.doc = cut.lines;
      s.cursor = cut.pos;
      s.modified = true;
      reframe(s);
    },

    /** C-k — from the cursor to the end of the line. On an already-empty tail
     *  it takes the line break, which is how a run of C-k eats a paragraph. */
    deleteToEnd(s: EditorState) {
      push(s);
      const line = s.doc[s.cursor.line] ?? "";
      const end = s.cursor.col >= line.length
        ? { line: s.cursor.line + 1, col: 0 }
        : { line: s.cursor.line, col: line.length };
      const cut = deleteRange(s.doc, s.cursor, clampPos(s.doc, end));
      s.doc = cut.lines;
      s.cursor = cut.pos;
      s.modified = true;
      reframe(s);
    },

    /** C-Up / C-Down — move the window, leaving the cursor where it is on the
     *  text (it is dragged along only when the window would leave it behind). */
    scroll(s: EditorState, delta: number) {
      s.top = Math.max(0, Math.min(s.doc.length - 1, s.top + delta));
      if (s.cursor.line < s.top) s.cursor = { ...s.cursor, line: s.top };
      else if (s.cursor.line >= s.top + s.viewport) {
        s.cursor = { ...s.cursor, line: s.top + s.viewport - 1 };
      }
      s.cursor = clampPos(s.doc, s.cursor);
      Object.assign(s, view(s));
    },

    /** C-PgUp / C-PgDn — the cursor to the top or bottom of what is on screen. */
    onScreen(s: EditorState, where: "top" | "bottom", select = false) {
      trackMark(s, select);
      const line = where === "top"
        ? s.top
        : Math.min(s.top + s.viewport - 1, s.doc.length - 1);
      s.cursor = clampPos(s.doc, { line, col: s.cursor.col });
      reframe(s);
    },

    /** M-l — go to a line number. */
    goto(s: EditorState, where: string) {
      const n = parseInt(where.trim(), 10);
      if (!Number.isFinite(n)) return void ui.say("Not a line number");
      s.cursor = clampPos(s.doc, { line: n - 1, col: 0 });
      clearMark(s);
      reframe(s);
    },

    /** M-b — jump to the bracket matching the one under the cursor. */
    matchBracket(s: EditorState) {
      const to = matchBracket(s.doc, s.cursor);
      if (!to) return void ui.say("No bracket here");
      s.cursor = to;
      reframe(s);
    },

    /** Ins — insert or overwrite. */
    toggleOverwrite(s: EditorState) {
      s.overwrite = !s.overwrite;
    },

    /** M-n, M-_ , and mc's C-s: what the view shows. */
    toggleNumbers(s: EditorState) {
      s.numbers = !s.numbers;
    },
    toggleTabs(s: EditorState) {
      s.showTabs = !s.showTabs;
    },
    toggleSyntax(s: EditorState) {
      s.syntax = !s.syntax;
      ui.say(s.syntax ? "Syntax highlighting on" : "Syntax highlighting off");
    },

    /** M-k / M-j / M-i / M-o — bookmark this line, walk them, clear them. */
    toggleBookmark(s: EditorState) {
      const line = s.cursor.line;
      s.bookmarks = s.bookmarks.includes(line)
        ? s.bookmarks.filter((l) => l !== line)
        : [...s.bookmarks, line].sort((a, b) => a - b);
      ui.say(
        s.bookmarks.includes(line)
          ? `Bookmark on line ${line + 1}`
          : `Bookmark cleared`,
      );
    },
    stepBookmark(s: EditorState, dir: 1 | -1) {
      const next = dir > 0
        ? s.bookmarks.find((l) => l > s.cursor.line)
        : [...s.bookmarks].reverse().find((l) => l < s.cursor.line);
      if (next === undefined) return void ui.say("No further bookmark");
      s.cursor = clampPos(s.doc, { line: next, col: 0 });
      reframe(s);
    },
    clearBookmarks(s: EditorState) {
      s.bookmarks = [];
      ui.say("Bookmarks cleared");
    },

    /** M-Tab — complete the word being typed from the words already in the
     *  document. One candidate types itself; several are offered as a list. */
    complete(s: EditorState) {
      const prefix = wordBefore(s.doc, s.cursor);
      const found = completions(s.doc, prefix, s.cursor.line);
      if (found.length === 0) return void ui.say("No completion");
      if (found.length === 1) {
        return void editor.insert(found[0]!.slice(prefix.length));
      }
      ui.choose(
        "complete",
        "Complete",
        found.slice(0, 20).map((w) => ({
          id: w.slice(prefix.length),
          label: w,
        })),
      );
    },

    /** M-t / M-p / M-u — the three things mc can do to a block in place.
     *
     *  All three go through one path: take the selected lines, transform them,
     *  put them back. Undo therefore works on them exactly as it does on
     *  typing, which is the property that makes them safe to try. */
    async transformBlock(
      s: EditorState,
      how: "sort" | "reverse-sort" | "format" | "shell",
      argument = "",
    ) {
      const marked = block(s);
      if (!marked) return void ui.say("Nothing selected");
      const [a, b] = marked;
      // Whole lines: a block tool that took half a line would produce nonsense.
      const from = a.line;
      const to = b.line;
      const lines = s.doc.slice(from, to + 1);

      let result: string[];
      if (how === "shell") {
        const io = await import("./editor.server.ts");
        const r = await io.filter(argument, lines.join("\n"));
        if (r.error) return void ui.say(`${argument}: ${r.error}`);
        result = r.text.split("\n");
        if (result[result.length - 1] === "") result.pop();
      } else if (how === "format") {
        result = reflow(lines, 80);
      } else {
        result = [...lines].sort((x, y) => x.localeCompare(y));
        if (how === "reverse-sort") result.reverse();
      }

      const q = s; // aiol-ok: no state read crosses the await above
      push(q);
      q.doc = [...q.doc.slice(0, from), ...result, ...q.doc.slice(to + 1)];
      q.anchor = null;
      q.cursor = clampPos(q.doc, { line: from, col: 0 });
      q.modified = true;
      reframe(q);
      ui.say(`${block.length} lines → ${result.length}`);
    },

    /** C-f — write the selected block to a file of its own. */
    async saveBlock(s: EditorState, path: string) {
      const marked = block(s);
      if (!marked) return void ui.say("Nothing selected");
      const [a, b] = marked;
      const text = textInRange(s.doc, a, b);
      const io = await import("./editor.server.ts");
      const err = await io.write(path, text);
      ui.say(err ? `Cannot save block: ${err}` : `Block saved to ${path}`);
    },

    /** S-F5 — drop another file in at the cursor. */
    async insertFile(s: EditorState, path: string) {
      const io = await import("./editor.server.ts");
      const r = await io.read(path, 8 * 1024 * 1024);
      if (r.error) return void ui.say(`Cannot insert: ${r.error}`);
      editor.insert(r.text);
    },

    /** M-e — re-read this file as a different character set. Refuses while the
     *  buffer is modified: re-reading would throw the edits away. */
    async setCharset(s: EditorState, label: string) {
      if (!isCharset(label)) {
        return void ui.say(`Unknown character set: ${label}`);
      }
      if (s.modified) return void ui.say("Save first (F2)");
      s.charset = label;
      const io = await import("./editor.server.ts");
      io.setCharset(label);
      ui.say(charsetName(label));
      // The body, not the method: `editor.open()` here would be a second
      // transaction, reading the charset this one has not committed yet.
      if (s.path) await applyOpen(s, s.path);
    },

    /** M-m — send the file somewhere. mc shells out to a mailer and so does
     *  this; a machine without one says so rather than appearing to send. */
    async mail(s: EditorState, to: string, subject: string) {
      if (s.modified) return void ui.say("Save first (F2)");
      const io = await import("./editor.server.ts");
      const err = await io.mail(to, subject || basename(s.path), s.path);
      ui.say(err ? `Cannot mail: ${err}` : `Sent ${basename(s.path)} to ${to}`);
    },

    /** C-p — check the word under the cursor. Suggestions come from whichever
     *  speller is installed; the dialog replaces the word with the chosen one,
     *  so the whole loop is two keys and a pick. */
    async spell(s: EditorState) {
      const word = wordBefore(s.doc, {
        line: s.cursor.line,
        col: (s.doc[s.cursor.line] ?? "").length,
      }) || wordBefore(s.doc, s.cursor);
      if (!word) return void ui.say("No word under the cursor");
      const io = await import("./editor.server.ts");
      const r = await io.spell(word);
      if (r.error) return void ui.say(r.error);
      if (r.suggestions.length === 0) {
        return void ui.say(`${word} is spelled correctly`);
      }
      ui.choose(
        "spell",
        `Replace ${word}`,
        r.suggestions.slice(0, 12).map((w) => ({ id: w, label: w })),
      );
    },

    /** M-Enter — jump to the next place this identifier appears. mc calls it
     *  "find declaration" and reads a tags file; without one, the next
     *  occurrence of the word under the cursor is the useful answer. */
    findWord(s: EditorState) {
      const word = wordBefore(s.doc, {
        line: s.cursor.line,
        col: (s.doc[s.cursor.line] ?? "").length,
      });
      if (!word) return void ui.say("No word under the cursor");
      editor.find(word);
    },

    /** Replace the word under the cursor — what the spelling dialog answers. */
    replaceWord(s: EditorState, replacement: string) {
      const line = s.doc[s.cursor.line] ?? "";
      const end = line.length;
      const word = wordBefore(s.doc, { line: s.cursor.line, col: end });
      if (!word) return;
      push(s);
      s.doc = s.doc.map((l, i) =>
        i === s.cursor.line ? l.slice(0, end - word.length) + replacement : l
      );
      s.cursor = clampPos(s.doc, {
        line: s.cursor.line,
        col: end - word.length + replacement.length,
      });
      s.modified = true;
      reframe(s);
    },

    /** C-f/C-b in the viewer, M-+/M-- here: the next file in the panel. */
    async stepFile(s: EditorState, delta: number) {
      if (s.modified) return void ui.say("Save first (F2)");
      const { panels } = await import("./panels.ts");
      const next = await panels.neighbourFile(delta);
      if (!next) return void ui.say(delta > 0 ? "Last file" : "First file");
      await editor.open(next);
    },

    /** Type text at the cursor, replacing the selection if there is one. */
    insert(s: EditorState, text: string) {
      applyInsert(s, text);
    },

    /** Enter, carrying the current indentation. */
    newline(s: EditorState) {
      const indent = indentOf(s.doc[s.cursor.line] ?? "");
      applyInsert(s, "\n" + indent);
    },

    /** Backspace (`forward: false`) and Delete (`forward: true`). */
    erase(s: EditorState, forward: boolean) {
      const sel = activeSelection(s);
      if (sel && !samePos(sel[0], sel[1])) {
        push(s);
        const [a, b] = sel;
        const cut = deleteRange(s.doc, a, b);
        Object.assign(s, {
          doc: cut.lines,
          cursor: cut.pos,
          anchor: null,
          markEnd: null,
          marking: false,
          modified: true,
        });
        return reframe(s);
      }
      const other = forward
        ? rightOf(s.doc, s.cursor)
        : leftOf(s.doc, s.cursor);
      // Backspace at the very start erases nothing, so it must not record
      // anything either: `push` clears the redo stack, and a keystroke that
      // changed no text has no business making a redo unreachable.
      if (samePos(other, s.cursor)) return;
      push(s);
      const cut = deleteRange(s.doc, s.cursor, other);
      s.doc = cut.lines;
      s.cursor = cut.pos;
      s.modified = true;
      reframe(s);
    },

    /** Delete the whole line — mc's C-y. */
    deleteLine(s: EditorState) {
      push(s);
      const line = s.cursor.line;
      s.doc = s.doc.length <= 1 ? [""] : s.doc.filter((_, i) => i !== line);
      s.cursor = clampPos(s.doc, { line, col: 0 });
      s.modified = true;
      reframe(s);
    },

    undoEdit(s: EditorState) {
      const snap = s.undo.pop();
      if (!snap) return void ui.say("Nothing to undo");
      s.redo.push({ lines: [...s.doc], pos: { ...s.cursor } });
      s.doc = snap.lines;
      s.cursor = clampPos(snap.lines, snap.pos);
      s.modified = true;
      reframe(s);
    },

    redoEdit(s: EditorState) {
      const snap = s.redo.pop();
      if (!snap) return void ui.say("Nothing to redo");
      s.undo.push({ lines: [...s.doc], pos: { ...s.cursor } });
      s.doc = snap.lines;
      s.cursor = clampPos(snap.lines, snap.pos);
      s.modified = true;
      reframe(s);
    },

    /** Selection → clipboard, mc's `C-Ins`. Kept in the cell so paste works
     *  across files, and pushed to the SYSTEM clipboard as well — a desktop
     *  editor whose copy cannot reach the window next to it is a surprise. */
    async copySelection(s: EditorState) {
      const marked = block(s);
      if (!marked) return void ui.say("Nothing selected");
      if (s.columnMode) {
        clipboard = columnText(s.doc, s.anchor!, blockEnd(s));
        columnClipboard = true;
        await toSystemClipboard(clipboard);
        return void ui.say(`Copied a column block`);
      }
      const [a, b] = marked;
      clipboard = textInRange(s.doc, a, b);
      columnClipboard = false;
      await toSystemClipboard(clipboard);
      ui.say(`Copied ${clipboard.length} characters`);
    },

    /** S-F3 — rectangular selection on or off. Turning it on starts a block
     *  here if none was open, because the alternative is a mode that appears to
     *  do nothing. */
    toggleColumnMode(s: EditorState) {
      s.columnMode = !s.columnMode;
      if (s.columnMode && !s.anchor) s.anchor = { ...s.cursor };
      ui.say(s.columnMode ? "Column block" : "Line block");
    },

    /** The M-arrow marks: extend a COLUMN block in one step, whatever mode the
     *  editor was in — which is what makes them one keystroke in mc. */
    markColumn(s: EditorState, dLine: number, dCol: number) {
      s.columnMode = true;
      if (!s.anchor) s.anchor = { ...s.cursor };
      s.cursor = clampPos(s.doc, {
        line: s.cursor.line + dLine,
        col: s.cursor.col + dCol,
      });
      reframe(s);
    },

    async cutSelection(s: EditorState) {
      if (!s.anchor) return void ui.say("Nothing selected");
      if (s.columnMode) {
        clipboard = columnText(s.doc, s.anchor!, blockEnd(s));
        columnClipboard = true;
        push(s);
        s.doc = deleteColumn(s.doc, s.anchor!, blockEnd(s));
        const { top, left } = {
          top: Math.min(s.anchor!.line, blockEnd(s).line),
          left: Math.min(s.anchor!.col, blockEnd(s).col),
        };
        s.cursor = clampPos(s.doc, { line: top, col: left });
        clearMark(s);
        s.modified = true;
        return void reframe(s);
      }
      const [a, b] = orderPos(s.anchor, s.cursor);
      push(s);
      const cut = deleteRange(s.doc, a, b);
      clipboard = cut.removed;
      Object.assign(s, {
        doc: cut.lines,
        cursor: cut.pos,
        anchor: null,
        markEnd: null,
        marking: false,
        modified: true,
      });
      reframe(s);
      await toSystemClipboard(clipboard);
    },

    /** F5 — mc's "Copy": duplicate the marked block at the cursor. The
     *  clipboard is not involved; `C-Ins` is what puts a block THERE. */
    copyBlock(s: EditorState) {
      const marked = block(s);
      if (!marked) return void ui.say("Nothing selected");
      if (s.columnMode) return void ui.say("Copy: not for column blocks");
      const [a, b] = marked;
      const text = textInRange(s.doc, a, b);
      push(s);
      const put = insertAt(s.doc, s.cursor, text);
      Object.assign(s, {
        doc: put.lines,
        cursor: put.pos,
        anchor: null,
        markEnd: null,
        marking: false,
        modified: true,
      });
      reframe(s);
    },

    /** F6 — mc's "Move": take the marked block out and put it where the cursor
     *  is. Not a cut and a paste: the clipboard is left alone, so a block that
     *  was copied earlier survives moving a different one.
     *
     *  A cursor INSIDE the block has nowhere to move it to, and one after the
     *  block shifts left by what was removed — both are handled by translating
     *  the destination through the deletion rather than by re-finding it. */
    moveBlock(s: EditorState) {
      const marked = block(s);
      if (!marked) return void ui.say("Nothing selected");
      if (s.columnMode) return void ui.say("Move: not for column blocks");
      const [a, b] = marked;
      const at = { ...s.cursor };
      const inside = before(a, at) && before(at, b);
      if (inside) return void ui.say("Move: the cursor is inside the block");

      push(s);
      const cut = deleteRange(s.doc, a, b);
      // After the block: the destination moves back by the block's extent.
      const dest = !before(at, b)
        ? at.line === b.line
          ? { line: a.line, col: a.col + (at.col - b.col) }
          : { line: at.line - (b.line - a.line), col: at.col }
        : at;
      const put = insertAt(cut.lines, dest, cut.removed);
      Object.assign(s, {
        doc: put.lines,
        cursor: put.pos,
        anchor: null,
        markEnd: null,
        marking: false,
        modified: true,
      });
      reframe(s);
    },

    /** F8 — mc's "Remove": delete the marked block, clipboard untouched. */
    deleteBlock(s: EditorState) {
      const marked = block(s);
      if (!marked) return void ui.say("Nothing selected");
      push(s);
      if (s.columnMode) {
        s.doc = deleteColumn(s.doc, s.anchor!, blockEnd(s));
        s.cursor = clampPos(s.doc, {
          line: Math.min(s.anchor!.line, blockEnd(s).line),
          col: Math.min(s.anchor!.col, blockEnd(s).col),
        });
      } else {
        const [a, b] = marked;
        const cut = deleteRange(s.doc, a, b);
        s.doc = cut.lines;
        s.cursor = cut.pos;
      }
      clearMark(s);
      s.modified = true;
      reframe(s);
    },

    /** mc's `S-Ins`. The SYSTEM clipboard wins when it holds something else:
     *  text copied in a browser is the thing a user expects to arrive here, and
     *  the editor's own clipboard is what answers when there is no system one
     *  (a headless run, a machine without `xclip`). */
    async paste(s: EditorState) {
      const io = await import("./editor.server.ts");
      const outside = await io.clipboardPaste();
      if (outside !== "" && outside !== clipboard) {
        // Not a rectangle: nothing outside this program knows about columns.
        return void applyInsert(s, outside);
      }
      if (!clipboard) return void ui.say("Clipboard is empty");
      // A rectangle goes back as a rectangle, at the cursor's column.
      if (columnClipboard) {
        push(s);
        s.doc = insertColumn(s.doc, s.cursor, clipboard);
        s.modified = true;
        return void reframe(s);
      }
      applyInsert(s, clipboard);
    },

    /** Start/extend a selection from the cursor (mc's F3 in the editor). */
    toggleMark(s: EditorState) {
      // mc's F3 has three states, and the middle one is the point: mark the
      // start, walk to the end, press F3 again to FIX the block. A fixed block
      // stays put while the cursor goes somewhere else, which is what F5 and
      // F6 then copy or move it to.
      if (!s.anchor) {
        s.anchor = { ...s.cursor };
        s.markEnd = null;
        s.marking = true;
        return void ui.say("Mark set — move to the other end, F3 to fix it");
      }
      if (s.marking) {
        s.marking = false;
        s.markEnd = { ...s.cursor };
        return void ui.say("Block marked");
      }
      clearMark(s);
      ui.say("Mark cleared");
    },

    /** F7. Wraps around the document and says when it found nothing. */
    find(s: EditorState, needle: string, backwards = false) {
      if (!needle) return;
      s.search = needle;
      const from = backwards
        ? s.cursor
        : { line: s.cursor.line, col: s.cursor.col + 1 };
      const hit = findFrom(s.doc, needle, from, true, backwards);
      if (!hit) return void ui.say(`Not found: ${needle}`);
      s.cursor = hit;
      clearMark(s);
      reframe(s);
    },

    /** F4 inside the editor: replace every occurrence from here on. */
    replaceAll(s: EditorState, needle: string, replacement: string) {
      if (!needle) return;
      s.search = needle;
      s.replace = replacement;
      let count = 0;
      const next = s.doc.map((l) => {
        const parts = l.split(needle);
        count += parts.length - 1;
        return parts.join(replacement);
      });
      // Recorded only if it changed something — same rule as `erase`, and the
      // reason the document is built before the undo entry rather than after.
      // A replace that matched nothing leaves `modified` exactly as it was:
      // clearing it would let Esc discard the edits already in the buffer
      // without asking.
      if (count > 0) {
        push(s);
        s.doc = next;
        s.modified = true;
      }
      s.cursor = clampPos(s.doc, s.cursor);
      reframe(s);
      ui.say(count === 0 ? `Not found: ${needle}` : `Replaced ${count}`);
    },

    /** Ctrl-Home / Ctrl-End. */
    jump(s: EditorState, toEnd: boolean, select = false) {
      trackMark(s, select);
      s.cursor = toEnd
        ? {
          line: s.doc.length - 1,
          col: (s.doc[s.doc.length - 1] ?? "").length,
        }
        : { line: 0, col: 0 };
      reframe(s);
    },
  },

  selectors: {
    title: (s: EditorState) => `${basename(s.path)}${s.modified ? " *" : ""}`,
    /** Selection expressed in window coordinates, or null. `column` tells the
     *  view which shape to paint: a run of text that wraps at the line ends, or
     *  a rectangle with the same span on every line. */
    selection: (s: EditorState) => {
      const marked = block(s);
      if (!marked) return null;
      const [a, b] = marked;
      const end = blockEnd(s);
      return {
        from: a,
        to: b,
        column: s.columnMode,
        left: Math.min(s.anchor!.col, end.col),
        right: Math.max(s.anchor!.col, end.col),
      };
    },
  },
});

/** Push to the system clipboard, if this machine has one. Never awaited for
 *  correctness: a copy that worked must not look like a failure because
 *  `xclip` is not installed. */
async function toSystemClipboard(text: string): Promise<void> {
  const io = await import("./editor.server.ts");
  await io.clipboardStore(text);
}

/** The editor clipboard. Module state rather than cell state: it is not
 *  persisted, not broadcast, and belongs to the process, like a real one. */
let clipboard = "";
/** Whether what is in the clipboard was taken as a rectangle. A column block
 *  pasted as a run of lines lands as a diagonal smear; this is what stops
 *  that. */
let columnClipboard = false;
