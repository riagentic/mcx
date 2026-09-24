// The file viewer (F3) — mcview's job, without its limits.
//
// The cell holds only what is on screen: a window of lines (or hex rows), the
// position, and the search state. The file, its line index and every byte not
// currently visible stay in `viewer.server.ts`.
import { cell } from "aio";
import { ui } from "./ui.ts";
import { basename } from "../lib/path.ts";
import { stripOverstrike } from "../lib/text.ts";
import { charsetName, isCharset } from "../lib/charsets.ts";
import type { HexRow } from "./viewer.server.ts";

export type ViewMode = "text" | "hex";

type ViewerState = {
  /** Whether the overlay is up. Named `visible`, not `open`, because a cell
   *  exposes its methods and its state on the same object — and `open()` is a
   *  method here. */
  visible: boolean;
  path: string;
  size: number;
  mode: ViewMode;
  wrap: boolean;
  /** First visible line (text mode). */
  line: number;
  /** First visible byte (hex mode). */
  byte: number;
  viewport: number;
  lines: string[];
  hex: HexRow[];
  /** Lines known so far — a lower bound while the index is still growing. */
  knownLines: number;
  complete: boolean;
  search: string;
  caseInsensitive: boolean;
  /** mc's "Whole words" — a hit inside a longer word is not a hit. */
  wholeWords: boolean;
  /** Byte offset of the last hit, so "find next" resumes past it. */
  lastHit: number;
  /** First visible COLUMN when lines are not wrapped — mc scrolls sideways
   *  rather than truncating, because the interesting part of a long line is
   *  often past the right edge. */
  column: number;
  /** mc's `r` / `m`: one remembered position per file, and the way back to it
   *  after a search has taken you elsewhere. Null until something is stored. */
  bookmark: { line: number; byte: number } | null;
  /** The character set the bytes are being read as (M-e). */
  charset: string;
  /** F9 — read a man page as a man page: overstrike collapsed to plain text
   *  instead of `X^HX`. */
  nroff: boolean;
  /** mc's hex editor (F2 in hex mode). The cursor is a BYTE offset, not a line,
   *  and `hexColumn` is which half of the display it is in — Tab moves between
   *  them, as mc's ToggleNavigation does. */
  hexEdit: boolean;
  hexCursor: number;
  hexColumn: "hex" | "text";
  /** Which nibble of the byte under the cursor the next hex digit fills. */
  hexNibble: 0 | 1;
  /** Edited bytes that are not on disk yet, by absolute offset. Kept until F6
   *  writes them, so the view shows what the file WILL be and Esc can still
   *  walk away from the lot. */
  changes: Record<number, number>;
  /** A column ruler across the view (M-r) — for counting into fixed-width
   *  records, which is most of what a hex/text viewer gets used for. */
  ruler: boolean;
  error: string | null;
};

const HEX_COLS = 16;

type Window = Pick<
  ViewerState,
  "lines" | "hex" | "line" | "knownLines" | "complete"
>;

/** The newest window read in flight. A held PgDn starts reads faster than the
 *  disk answers them, and the answers need not arrive in order. */
let windowSeq = 0;

/** Read the visible window — or `null` once a newer read has started, so a
 *  late answer can never paint a position the user has already left.
 *  `Object.assign(s, null)` is a no-op, which keeps every call site one line.
 *
 *  A plain function, not a `refresh` METHOD the other methods call: a nested
 *  dispatch sees the caller's writes only after they commit, so a `refresh`
 *  that re-read `s.mode`/`s.line` would render the position the user just left.
 *  Everything it needs is an argument; the caller assigns the result. */
async function readWindow(
  mode: ViewMode,
  line: number,
  byte: number,
  viewport: number,
  nroff = false,
  changes: Record<number, number> = {},
): Promise<Window | null> {
  const seq = ++windowSeq;
  const io = await import("./viewer.server.ts");
  const w: Window = mode === "hex"
    ? {
      lines: [],
      hex: await io.hexWindow(byte, viewport, changes),
      line,
      knownLines: 0,
      complete: true,
    }
    : await io.textWindow(line, viewport).then((t) => ({
      lines: nroff ? t.lines.map(stripOverstrike) : t.lines,
      hex: [],
      line: t.first,
      knownLines: t.known,
      complete: t.complete,
    }));
  return seq === windowSeq ? w : null;
}

/** Open a file in the viewer — the body of `open`, as a plain function, so
 *  `setCharset` can re-read the file in the SAME transaction as the write that
 *  changed the decoding. */
async function applyOpen(s: ViewerState, path: string): Promise<void> {
  ui.rememberFile(path, "view");
  const io = await import("./viewer.server.ts");
  const r = await io.open(path);
  s.path = path;
  s.size = r.size;
  s.error = r.error;
  s.visible = true;
  s.line = 0;
  s.byte = 0;
  s.lastHit = -1;
  s.column = 0;
  s.bookmark = null;
  s.mode = r.binary ? "hex" : "text";
  if (r.error) {
    ui.say(`Cannot view ${basename(path)}: ${r.error}`);
    s.visible = false;
    return;
  }
  Object.assign(
    s,
    await readWindow(s.mode, 0, 0, s.viewport, s.nroff, s.changes),
  );
}

/** The hex cursor, as plain functions.
 *
 *  A method that writes state and then calls its OWN cell's method gets a
 *  second transaction reading committed state — `typeHex` would move a cursor
 *  over a window that had not seen the byte it just typed. Sharing the body
 *  keeps the write and the window read in one commit. */
async function applyShowByte(s: ViewerState, at: number): Promise<void> {
  s.hexCursor = at;
  s.hexNibble = 0;
  const rowStart = at - (at % HEX_COLS);
  const span = s.viewport * HEX_COLS;
  if (rowStart < s.byte) s.byte = rowStart;
  else if (rowStart >= s.byte + span) s.byte = rowStart - span + HEX_COLS;
  s.byte = Math.max(0, s.byte - (s.byte % HEX_COLS));
  Object.assign(
    s,
    await readWindow(s.mode, s.line, s.byte, s.viewport, s.nroff, s.changes),
  );
}

async function applyMoveHex(s: ViewerState, delta: number): Promise<void> {
  if (s.mode !== "hex") return;
  const last = Math.max(0, s.size - 1);
  await applyShowByte(s, Math.max(0, Math.min(last, s.hexCursor + delta)));
}

export const viewer = cell("viewer", {
  // What you were reading is worth restoring; the bytes are not.
  persist: {
    exclude: [
      "lines",
      "hex",
      "visible",
      "error",
      "knownLines",
      "complete",
      // Unsaved bytes are not a preference. A restart that brought them back
      // would be holding an edit the user never made against a file they may
      // have changed since.
      "changes",
      "hexEdit",
    ],
  },

  state: {
    visible: false,
    path: "",
    size: 0,
    mode: "text" as ViewMode,
    wrap: true,
    line: 0,
    byte: 0,
    viewport: 40,
    lines: [] as string[],
    hex: [] as HexRow[],
    knownLines: 0,
    complete: false,
    search: "",
    caseInsensitive: true,
    wholeWords: false,
    lastHit: -1,
    column: 0,
    bookmark: null as { line: number; byte: number } | null,
    ruler: false,
    nroff: false,
    hexEdit: false,
    hexCursor: 0,
    hexColumn: "hex" as "hex" | "text",
    hexNibble: 0 as 0 | 1,
    changes: {} as Record<number, number>,
    charset: "utf-8",
    error: null as string | null,
  },

  methods: {
    /** F3. Binary files open in hex without being asked — that is what the
     *  question would have been for. */
    async open(s: ViewerState, path: string) {
      await applyOpen(s, path);
    },

    /** M-` — step away from the viewer without closing the file. The bytes and
     *  the position stay; only the overlay goes. Coming back is instant, which
     *  is the whole point of a screen list. */
    hide(s: ViewerState) {
      s.visible = false;
    },
    show(s: ViewerState) {
      if (s.path) s.visible = true;
    },

    async close(s: ViewerState) {
      const io = await import("./viewer.server.ts");
      io.close();
      s.visible = false;
      s.lines = [];
      s.hex = [];
    },

    /** Scroll by `delta` rows — lines in text mode, 16-byte rows in hex. */
    async scroll(s: ViewerState, delta: number) { // aio-ok: reads the view as it is now; stale windows drop in readWindow
      if (!s.visible) return;
      if (s.mode === "hex") {
        const max = Math.max(0, s.size - 1);
        s.byte = Math.max(0, Math.min(max, s.byte + delta * HEX_COLS));
      } else {
        s.line = Math.max(0, s.line + delta);
      }
      Object.assign(
        s,
        await readWindow(
          s.mode,
          s.line,
          s.byte,
          s.viewport,
          s.nroff,
          s.changes,
        ),
      );
    },

    async top(s: ViewerState) {
      if (!s.visible) return;
      s.line = 0;
      s.byte = 0;
      Object.assign(
        s,
        await readWindow(s.mode, 0, 0, s.viewport, s.nroff, s.changes),
      );
    },

    /** End of file. In text mode this forces the index to complete — which is
     *  the honest cost of "show me the last line" and nothing more. */
    async bottom(s: ViewerState) { // aio-ok: reads the view as it is now; stale windows drop in readWindow
      const io = await import("./viewer.server.ts");
      if (s.mode === "hex") {
        s.byte = Math.max(0, s.size - s.viewport * HEX_COLS);
      } else {
        const line = await io.lineOfByte(s.size);
        s.line = Math.max(0, line - s.viewport + 1);
      }
      Object.assign(
        s,
        await readWindow(
          s.mode,
          s.line,
          s.byte,
          s.viewport,
          s.nroff,
          s.changes,
        ),
      );
    },

    async setViewport(s: ViewerState, rows: number) {
      if (!Number.isFinite(rows)) return; // see panels.setViewport
      const v = Math.max(1, Math.min(4096, Math.floor(rows)));
      if (s.viewport === v) return;
      s.viewport = v;
      if (!s.visible) return;
      Object.assign(
        s,
        await readWindow(s.mode, s.line, s.byte, v, s.nroff, s.changes),
      );
    },

    /** F4 in mc's viewer, and here: swap between text and hex. */
    async toggleMode(s: ViewerState) { // aio-ok: reads the view as it is now; stale windows drop in readWindow
      if (!s.visible) return;
      const io = await import("./viewer.server.ts");
      if (s.mode === "text") {
        s.byte = io.byteOfLine(s.line);
        s.hexCursor = s.byte;
        s.mode = "hex";
      } else {
        s.hexEdit = false;
        s.line = await io.lineOfByte(s.byte);
        s.mode = "text";
      }
      Object.assign(
        s,
        await readWindow(
          s.mode,
          s.line,
          s.byte,
          s.viewport,
          s.nroff,
          s.changes,
        ),
      );
    },

    /** F2 in hex mode — mc's HexEditMode. Leaving it with edits pending keeps
     *  them: they are still what the file will say, and F6 is still what says
     *  it. */
    async toggleHexEdit(s: ViewerState) {
      if (s.mode !== "hex") return void ui.say("Hex edit is for hex mode (F4)");
      s.hexEdit = !s.hexEdit;
      s.hexNibble = 0;
      if (s.hexEdit && s.hexCursor < s.byte) s.hexCursor = s.byte;
      ui.say(
        s.hexEdit ? "Hex edit — F6 saves, Tab switches column" : "Hex view",
      );
      await applyShowByte(s, s.hexCursor);
    },

    /** Tab — mc's ToggleNavigation, between the hex columns and the text. */
    toggleHexColumn(s: ViewerState) {
      s.hexColumn = s.hexColumn === "hex" ? "text" : "hex";
      s.hexNibble = 0;
    },

    /** Move the hex cursor, scrolling the window to keep it on screen. */
    async moveHex(s: ViewerState, delta: number) {
      await applyMoveHex(s, delta);
    },

    /** Put the hex cursor at `at` and scroll the window the least that keeps
     *  it visible — the same "follow the cursor" rule the editor uses. */
    async showByte(s: ViewerState, at: number) {
      await applyShowByte(s, at);
    },

    /** A keystroke in hex-edit mode. In the hex column it is one nibble of the
     *  byte under the cursor; in the text column it is the byte itself. Either
     *  way the cursor moves on when the byte is complete, which is what makes
     *  typing a run of bytes possible. */
    async typeHex(s: ViewerState, key: string) { // aio-ok: reads the view as it is now; stale windows drop in readWindow
      if (!s.hexEdit || s.mode !== "hex" || s.size === 0) return;
      const at = s.hexCursor;
      const current = s.changes[at] ??
        s.hex.find((r) => at >= r.offset && at < r.offset + HEX_COLS)
          ?.bytes[at % HEX_COLS] ??
        0;

      if (s.hexColumn === "text") {
        const code = key.charCodeAt(0);
        if (key.length !== 1 || code < 0x20 || code > 0x7e) return;
        s.changes = { ...s.changes, [at]: code };
        return void await applyMoveHex(s, 1);
      }

      const digit = parseInt(key, 16);
      if (key.length !== 1 || Number.isNaN(digit)) return;
      const byte = s.hexNibble === 0
        ? (digit << 4) | (current & 0x0f)
        : (current & 0xf0) | digit;
      s.changes = { ...s.changes, [at]: byte };
      if (s.hexNibble === 0) {
        s.hexNibble = 1;
        // Repaint: the high nibble is already part of the file's future.
        Object.assign(
          s,
          await readWindow(
            s.mode,
            s.line,
            s.byte,
            s.viewport,
            s.nroff,
            s.changes,
          ),
        );
        return;
      }
      await applyMoveHex(s, 1);
    },

    /** F6 — write the pending bytes. A hex edit never changes the length, so
     *  this is a seek and a write, even in a file too big to read. */
    async saveHex(s: ViewerState) { // aio-ok: re-reads below are deliberate
      // What gets written is fixed before the first await.
      const written = { ...s.changes };
      const { path } = s;
      const pending = Object.keys(written).length;
      if (pending === 0) return void ui.say("Nothing to save");
      const io = await import("./viewer.server.ts");
      const err = await io.writeBytes(path, written);
      if (err) return void ui.say(`Cannot save: ${err}`);
      // A byte typed during the write is not on disk yet: it stays pending.
      s.changes = Object.fromEntries(
        Object.entries(s.changes).filter(([at, b]) => written[+at] !== b),
      );
      ui.say(`Saved ${pending} byte${pending === 1 ? "" : "s"}`);
      Object.assign(
        s,
        await readWindow(
          s.mode,
          s.line,
          s.byte,
          s.viewport,
          s.nroff,
          s.changes,
        ),
      );
    },

    toggleWrap(s: ViewerState) {
      s.wrap = !s.wrap;
      if (s.wrap) s.column = 0; // wrapped text has nowhere to scroll to
    },

    /** M-e — read the same bytes as a different character set. */
    async setCharset(s: ViewerState, label: string) { // aio-ok: reads the view as it is now; stale windows drop in readWindow
      if (!isCharset(label)) {
        return void ui.say(`Unknown character set: ${label}`);
      }
      s.charset = label;
      const io = await import("./viewer.server.ts");
      io.setCharset(label);
      ui.say(charsetName(label));
      if (!s.visible) return;
      // Re-open, because the line index was built from the old decoding. The
      // body, not the method: `viewer.open()` here would be a second
      // transaction reading the charset this one has not committed yet.
      await applyOpen(s, s.path);
    },

    /** F9 — nroff mode, for man pages. */
    async toggleNroff(s: ViewerState) { // aio-ok: reads the view as it is now; stale windows drop in readWindow
      s.nroff = !s.nroff;
      ui.say(s.nroff ? "Nroff mode" : "Raw text");
      if (!s.visible) return;
      Object.assign(
        s,
        await readWindow(
          s.mode,
          s.line,
          s.byte,
          s.viewport,
          s.nroff,
          s.changes,
        ),
      );
    },

    /** C-f / C-b — the next or previous file in the panel, without going back
     *  to it. Browsing a directory of logs is the case this exists for. */
    async stepFile(_s: ViewerState, delta: number) {
      const { panels } = await import("./panels.ts");
      const next = await panels.neighbourFile(delta);
      if (!next) return void ui.say(delta > 0 ? "Last file" : "First file");
      await viewer.open(next);
    },

    /** M-r — the column ruler. */
    toggleRuler(s: ViewerState) {
      s.ruler = !s.ruler;
    },

    /** Sideways, when the lines are not wrapped. `quick` is mc's C-Left /
     *  C-Right, which move by half a screen rather than a character. */
    scrollColumn(s: ViewerState, delta: number) {
      if (s.wrap) return void ui.say("Unwrap (F2) to scroll sideways");
      s.column = Math.max(0, s.column + delta);
    },

    /** mc's `r`: remember where we are. One mark per file, because a viewer is
     *  a place you are passing through. */
    mark(s: ViewerState) {
      s.bookmark = { line: s.line, byte: s.byte };
      ui.say(`Marked line ${s.line + 1}`);
    },

    /** mc's `m`: go back to it. */
    async toMark(s: ViewerState) { // aio-ok: reads the view as it is now; stale windows drop in readWindow
      if (!s.bookmark) return void ui.say("Nothing marked — press r first");
      s.line = s.bookmark.line;
      s.byte = s.bookmark.byte;
      Object.assign(
        s,
        await readWindow(
          s.mode,
          s.line,
          s.byte,
          s.viewport,
          s.nroff,
          s.changes,
        ),
      );
    },

    /** F7. Searches from the current position; wraps to the top when it finds
     *  nothing ahead, and says so rather than appearing to do nothing. */
    /** mc's search switches, set from the search dialog. */
    setSearchOption(s: ViewerState, name: string, on: boolean) {
      if (name === "searchCase") s.caseInsensitive = !on;
      if (name === "wholeWords") s.wholeWords = on;
    },

    async find(s: ViewerState, needle: string, backwards = false) { // aio-ok: reads the view as it is now; stale windows drop in readWindow
      if (!needle) return;
      s.search = needle;
      const io = await import("./viewer.server.ts");
      // Where this search starts: from the last hit, or from the view when the
      // user has scrolled past it — forwards the first match at or after it,
      // backwards the last one strictly before. `lastHit === -1` needs no
      // special case; it loses both comparisons.
      //
      // Anchoring the backward search to the LINE of the last hit instead left
      // a match in column 0 finding itself, for ever.
      const here = s.mode === "hex" ? s.byte : io.byteOfLine(s.line);
      const from = backwards
        ? Math.max(here, s.lastHit)
        : Math.max(here, s.lastHit + 1);

      let hit = await io.findBytes(
        needle,
        from,
        s.caseInsensitive,
        backwards,
        s.wholeWords,
      );
      if (hit < 0) {
        hit = await io.findBytes(
          needle,
          backwards ? s.size : 0,
          s.caseInsensitive,
          backwards,
          s.wholeWords,
        );
        if (hit >= 0) ui.say("Search wrapped");
      }
      if (hit < 0) {
        s.lastHit = -1;
        return void ui.say(`Not found: ${needle}`);
      }
      s.lastHit = hit;
      if (s.mode === "hex") s.byte = Math.floor(hit / HEX_COLS) * HEX_COLS;
      else s.line = await io.lineOfByte(hit);
      Object.assign(
        s,
        await readWindow(
          s.mode,
          s.line,
          s.byte,
          s.viewport,
          s.nroff,
          s.changes,
        ),
      );
    },

    /** Jump to a line number, or to a percentage of the file. */
    async goto(s: ViewerState, where: string) { // aio-ok: reads the view as it is now; stale windows drop in readWindow
      const io = await import("./viewer.server.ts");
      const text = where.trim();
      const pct = text.endsWith("%");
      // mc's Goto offers four spellings: line, percent, decimal offset and
      // HEXADECIMAL offset. `0x1f4` is how an offset is written everywhere the
      // user got it from — a hex dump, a stack trace, another viewer.
      const hex = /^0x[0-9a-f]+$/i.test(text);
      const n = hex ? parseInt(text.slice(2), 16) : parseInt(text, 10);
      if (!Number.isFinite(n)) return void ui.say(`Not a position: ${where}`);
      if (pct) {
        const byte = Math.floor((Math.max(0, Math.min(100, n)) / 100) * s.size);
        if (s.mode === "hex") s.byte = byte;
        else s.line = await io.lineOfByte(byte);
      } else if (hex || s.mode === "hex") {
        // A hexadecimal number is always an OFFSET, whichever mode is up.
        s.byte = Math.max(0, n);
        if (s.mode !== "hex") s.line = await io.lineOfByte(s.byte);
      } else {
        s.line = Math.max(0, n - 1);
      }
      Object.assign(
        s,
        await readWindow(
          s.mode,
          s.line,
          s.byte,
          s.viewport,
          s.nroff,
          s.changes,
        ),
      );
    },
  },

  selectors: {
    title: (s: ViewerState) => basename(s.path),
    /** How far right there is anything to see: the longest line currently in
     *  view, less what already fits. mc's End, in one number. */
    lineEnd: (s: ViewerState): number => {
      const longest = s.lines.reduce((n, l) => Math.max(n, l.length), 0);
      return Math.max(0, longest - s.column);
    },
    /** Progress through the file, for the header — a percentage is the only
     *  honest position indicator before the index is complete. */
    percent: (s: ViewerState): number => {
      if (s.size === 0) return 100;
      if (s.mode === "hex") return Math.min(100, (s.byte / s.size) * 100);
      if (s.knownLines <= 0) return 0;
      return Math.min(
        100,
        ((s.line + s.viewport) / Math.max(1, s.knownLines)) * 100,
      );
    },
  },
});
