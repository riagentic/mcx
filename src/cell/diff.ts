// The diff viewer (C-x C-d) — mc's diffviewer.
//
// Same discipline as every other surface here: both files and the full row list
// live server-side, and the client receives the window it draws. Diffing two
// 100_000-line files therefore costs the client the same as diffing two short
// ones.
import { cell } from "aio";
import { ui } from "./ui.ts";
import { basename } from "../lib/path.ts";
import {
  alignRows,
  diffLines,
  type DiffRow,
  hunkCount,
  hunkStart,
  mergeHunk,
} from "../lib/diff.ts";

type DiffState = {
  visible: boolean;
  leftPath: string;
  rightPath: string;
  /** Both files, as lines. Server-side only. */
  leftDoc: string[];
  rightDoc: string[];
  /** Every aligned row. Server-side only — this is the whole comparison. */
  all: DiffRow[];

  /** The window the UI draws. */
  rows: DiffRow[];
  top: number;
  viewport: number;
  /** Row the cursor is on, in `all`. */
  cursor: number;
  count: number;
  hunks: number;
  /** Which difference the cursor is in, 1-based, or 0 between them.
   *
   *  A published FIELD rather than a selector over `all`: `all` is server-side,
   *  and a selector that reads it answers `undefined` in the browser — the
   *  framework refuses the read outright, which is how this was caught. */
  atHunk: number;
  /** Which side a merge takes FROM, and which file has unsaved merges. */
  modified: "" | "left" | "right" | "both";
  /** Display toggles, mc's `s` and `l`. */
  showSymbols: boolean;
  showNumbers: boolean;
  /** The divider between the two columns: a share for the left one, or one
   *  side taken full width (mc's `f`). */
  ratio: number;
  full: "" | "left" | "right";
  /** Tab stops, mc's 2/3/4/8. A diff of a tab-indented file is unreadable at
   *  the wrong width, which is why it is a keystroke rather than a setting. */
  tabWidth: number;
  /** First visible column — the two sides scroll together, because a diff read
   *  at two different offsets is not a diff. */
  column: number;
  /** Compare with whitespace collapsed (mc's diff option): re-indentation is
   *  the commonest change nobody wants to read. */
  ignoreWhitespace: boolean;
  /** What F7 last looked for, so S-F7 can look again. */
  search: string;
  error: string | null;
};

/** Republish the window. */
function view(s: DiffState) {
  const top = Math.max(0, Math.min(s.top, Math.max(0, s.all.length - 1)));
  return {
    top,
    rows: s.all.slice(top, top + s.viewport),
    count: s.all.length,
    hunks: hunkCount(s.all),
    atHunk: (s.all[s.cursor]?.hunk ?? -1) + 1,
  };
}

/** Scroll so the cursor is on screen, then republish. */
function reframe(s: DiffState): void {
  if (s.cursor < s.top) s.top = s.cursor;
  else if (s.cursor >= s.top + s.viewport) s.top = s.cursor - s.viewport + 1;
  Object.assign(s, view(s));
}

/** Recompute the comparison from the two documents. Called after a merge, so
 *  what the view shows is always a diff of what is in the buffers — never a
 *  patched-up copy of the previous one. */
function recompute(s: DiffState): void {
  // Comparison and DISPLAY are separate: with whitespace ignored the diff is
  // computed over normalised lines, but what the view shows is still the real
  // ones. Otherwise the merge would write back the normalised text.
  const key = (l: string) =>
    s.ignoreWhitespace ? l.trim().replace(/\s+/g, " ") : l;
  const a = s.leftDoc.map(key);
  const b = s.rightDoc.map(key);
  s.all = alignRows(s.leftDoc, s.rightDoc, diffLines(a, b));
  reframe(s);
}

export const diff = cell("diff", {
  // A comparison is a question about two files as they are now; restoring a
  // stale one would be a lie about both.
  persist: "none",
  visible: { exclude: ["leftDoc", "rightDoc", "all"] },

  state: {
    visible: false,
    leftPath: "",
    rightPath: "",
    leftDoc: [] as string[],
    rightDoc: [] as string[],
    all: [] as DiffRow[],
    rows: [] as DiffRow[],
    top: 0,
    viewport: 30,
    cursor: 0,
    count: 0,
    hunks: 0,
    atHunk: 0,
    modified: "" as "" | "left" | "right" | "both",
    showSymbols: true,
    showNumbers: true,
    ratio: 0.5,
    full: "" as "" | "left" | "right",
    tabWidth: 8,
    column: 0,
    ignoreWhitespace: false,
    search: "",
    error: null as string | null,
  },

  methods: {
    /** C-x C-d — compare the file under the cursor in each panel. */
    async open(s: DiffState, left: string, right: string) { // aio-ok: post-await reads are own writes or a deliberate dirty check
      const io = await import("./diff.server.ts");
      const [a, b] = await Promise.all([
        io.readLines(left),
        io.readLines(right),
      ]);
      if (a.error || b.error) {
        s.error = a.error ?? b.error;
        return void ui.say(`Cannot compare: ${s.error}`);
      }
      Object.assign(s, {
        visible: true,
        leftPath: left,
        rightPath: right,
        leftDoc: a.lines,
        rightDoc: b.lines,
        cursor: 0,
        top: 0,
        modified: "",
        error: null,
      });
      recompute(s);
      // Open ON the first difference rather than at the top of the file. It is
      // what the comparison was opened to see, and it means F5 has something to
      // merge without a navigation step first.
      const first = hunkStart(s.all, 0);
      if (first >= 0) {
        s.cursor = first;
        reframe(s);
      }
      // An answer of "they are the same" is worth saying out loud rather than
      // leaving the user to scroll through looking for a difference.
      if (s.hunks === 0) {
        ui.say(`${basename(left)} and ${basename(right)} are identical`);
      }
    },

    close(s: DiffState) {
      s.visible = false;
      s.leftDoc = [];
      s.rightDoc = [];
      s.all = [];
      s.rows = [];
    },

    setViewport(s: DiffState, rows: number) {
      if (!Number.isFinite(rows)) return; // see panels.setViewport
      const v = Math.max(1, Math.min(4096, Math.floor(rows)));
      if (s.viewport === v) return;
      s.viewport = v;
      Object.assign(s, view(s));
    },

    move(s: DiffState, delta: number) {
      s.cursor = Math.max(0, Math.min(s.all.length - 1, s.cursor + delta));
      reframe(s);
    },

    jump(s: DiffState, toEnd: boolean) {
      s.cursor = toEnd ? Math.max(0, s.all.length - 1) : 0;
      reframe(s);
    },

    /** `n` / `p` — the next and previous difference. The whole point of the
     *  view: nobody reads a diff line by line. */
    stepHunk(s: DiffState, dir: 1 | -1) {
      const here = s.all[s.cursor]?.hunk ?? -1;
      const next = dir > 0
        ? s.all.findIndex((r, i) =>
          i > s.cursor && r.hunk >= 0 && r.hunk !== here
        )
        : (() => {
          for (let i = s.cursor - 1; i >= 0; i--) {
            const r = s.all[i]!;
            if (r.hunk >= 0 && r.hunk !== here) return hunkStart(s.all, r.hunk);
          }
          return -1;
        })();
      if (next < 0) {
        return void ui.say(dir > 0 ? "Last difference" : "First difference");
      }
      s.cursor = next;
      reframe(s);
      const h = s.all[s.cursor]?.hunk ?? 0;
      ui.say(`Difference ${h + 1} of ${s.hunks}`);
    },

    /** F5 / F15 — take the difference under the cursor from one side into the
     *  other. The buffers change; nothing is written until F2. */
    merge(s: DiffState, from: "left" | "right") {
      const hunk = s.all[s.cursor]?.hunk ?? -1;
      if (hunk < 0) return void ui.say("Not on a difference");
      const merged = mergeHunk(s.all, hunk, from);
      if (from === "left") {
        s.rightDoc = merged;
        s.modified = s.modified === "left" || s.modified === "both"
          ? "both"
          : "right";
      } else {
        s.leftDoc = merged;
        s.modified = s.modified === "right" || s.modified === "both"
          ? "both"
          : "left";
      }
      recompute(s);
      ui.say(`Merged difference ${hunk + 1} — F2 to save`);
    },

    /** F2 — write back whichever side a merge changed. */
    async save(s: DiffState) { // aio-ok: post-await reads are own writes or a deliberate dirty check
      // What gets written is fixed before the first await.
      const { modified, leftPath, rightPath } = s;
      if (!modified) return void ui.say("Nothing to save");
      const left = modified !== "right" ? [...s.leftDoc] : null;
      const right = modified !== "left" ? [...s.rightDoc] : null;
      const io = await import("./diff.server.ts");
      const errs: string[] = [];
      if (left) {
        const e = await io.writeLines(leftPath, left);
        if (e) errs.push(e);
      }
      if (right) {
        const e = await io.writeLines(rightPath, right);
        if (e) errs.push(e);
      }
      if (errs.length > 0) return void ui.say(`Cannot save: ${errs[0]}`);
      // aio-ok: a merge that landed during the write is not on disk — only the
      // sides still equal to what was written are clean.
      const clean = (doc: readonly string[], wrote: readonly string[] | null) =>
        wrote !== null && doc.length === wrote.length &&
        doc.every((l, i) => l === wrote[i]);
      const now = s.modified;
      const l = (now === "left" || now === "both") && !clean(s.leftDoc, left);
      const r = (now === "right" || now === "both") &&
        !clean(s.rightDoc, right);
      s.modified = l && r ? "both" : l ? "left" : r ? "right" : "";
      ui.say("Saved");
    },

    /** F7 — the next row containing this text, from the cursor, wrapping.
     *  S-F7 repeats it, which is why the needle is remembered. */
    find(s: DiffState, needle: string) {
      if (!needle) return void ui.say("Nothing to search for");
      s.search = needle;
      const has = (i: number) => {
        const r = s.all[i]!;
        return (r.left ?? "").includes(needle) ||
          (r.right ?? "").includes(needle);
      };
      for (let n = 1; n <= s.all.length; n++) {
        const i = (s.cursor + n) % s.all.length;
        if (has(i)) {
          s.cursor = i;
          reframe(s);
          if (i <= s.cursor && n === s.all.length) ui.say("Search wrapped");
          return;
        }
      }
      ui.say(`Not found: ${needle}`);
    },

    /** C-u — put the files the other way round. A diff read in the wrong
     *  direction is the commonest reason to want this. */
    swap(s: DiffState) {
      const { leftPath, rightPath, leftDoc, rightDoc } = s;
      Object.assign(s, {
        leftPath: rightPath,
        rightPath: leftPath,
        leftDoc: rightDoc,
        rightDoc: leftDoc,
        modified: s.modified === "left"
          ? "right"
          : s.modified === "right"
          ? "left"
          : s.modified,
      });
      recompute(s);
    },

    /** `f` / `=` / `>` / `<` — the divider between the columns. `f` gives one
     *  side the whole width, which is how you read a long line in a diff. */
    setSplit(s: DiffState, what: "full" | "equal" | "more" | "less") {
      if (what === "full") {
        s.full = s.full === "" ? "left" : s.full === "left" ? "right" : "";
        return;
      }
      s.full = "";
      s.ratio = what === "equal" ? 0.5 : Math.max(
        0.2,
        Math.min(0.8, s.ratio + (what === "more" ? 0.05 : -0.05)),
      );
    },

    /** 2 / 3 / 4 / 8 — tab stops. */
    setTabWidth(s: DiffState, n: number) {
      s.tabWidth = Math.max(1, Math.min(16, Math.floor(n)));
    },

    /** Left / Right — both columns together. */
    scrollColumn(s: DiffState, delta: number) {
      s.column = Math.max(0, s.column + delta);
    },

    /** F9 — compare ignoring whitespace, or not. The comparison is redone from
     *  the documents, so the answer is always current. */
    toggleWhitespace(s: DiffState) {
      s.ignoreWhitespace = !s.ignoreWhitespace;
      recompute(s);
      ui.say(
        s.ignoreWhitespace ? "Ignoring whitespace" : "Comparing whitespace too",
      );
    },

    /** `s` and `l` — mc's two display toggles. */
    toggleSymbols(s: DiffState) {
      s.showSymbols = !s.showSymbols;
    },
    toggleNumbers(s: DiffState) {
      s.showNumbers = !s.showNumbers;
    },
  },

  selectors: {
    title: (s: DiffState) =>
      `${basename(s.leftPath)} ↔ ${basename(s.rightPath)}${
        s.modified ? " *" : ""
      }`,
  },
});
