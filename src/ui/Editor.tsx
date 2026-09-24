/** The editor overlay (F4). Renders the window the cell publishes, highlights
 *  it, and draws the cursor and selection over it. */

import { effect, useDimensions, useRef } from "aio/air";
import { editor } from "../cell/editor.ts";
import { langOf, tokenize } from "../lib/syntax.ts";
import { ROW_H } from "./metrics.ts";

/** Tabs and trailing spaces made visible (M-_): the two things that are
 *  invisible in a text file and matter in half of them. Only for display — the
 *  characters themselves are untouched. */
function reveal(text: string): string {
  return text.replaceAll("\t", "→   ").replace(
    / +$/,
    (run) => "·".repeat(run.length),
  );
}

/** A line, coloured, with the selection band drawn behind it. */
function Line({ text: raw, index }: { text: string; index: number }) {
  const text = editor.showTabs ? reveal(raw) : raw;
  const lang = langOf(editor.path);
  const sel = editor.selection();
  const cur = editor.cursor;

  const selected = sel && index >= sel.from.line && index <= sel.to.line;
  // A column block spans the same columns on every line it covers; a normal
  // one runs from the first corner to the second, wrapping at the line ends.
  const selStart = !selected
    ? 0
    : sel.column
    ? sel.left
    : (index === sel.from.line ? sel.from.col : 0);
  const selEnd = !selected
    ? 0
    : sel.column
    ? sel.right
    : (index === sel.to.line ? sel.to.col : text.length);

  return (
    <div
      class={`eline ${editor.bookmarks.includes(index) ? "bookmarked" : ""}`}
      style={{ height: `${ROW_H}px`, lineHeight: `${ROW_H}px` }}
    >
      {editor.numbers && (
        <span
          class={`vnum ${editor.bookmarks.includes(index) ? "bookmarked" : ""}`}
        >
          {index + 1}
        </span>
      )}
      <span class="etext">
        {selected && selEnd > selStart && (
          <span
            class="eselect"
            style={{ left: `${selStart}ch`, width: `${selEnd - selStart}ch` }}
          />
        )}
        {index === cur.line && (
          <span class="ecaret" style={{ left: `${cur.col}ch` }} />
        )}
        {editor.syntax
          ? tokenize(text, lang).map((t, i) => (
            <span key={i} class={`t-${t.kind}`}>{t.text}</span>
          ))
          : text}
      </span>
    </div>
  );
}

export function Editor() {
  const dims = useDimensions();

  // Once per geometry — see the note in Panel.tsx.
  const last = useRef(0);
  effect(() => {
    const h = dims.height.value;
    if (!(h > 0) || !editor.visible) return;
    const rows = Math.max(1, Math.floor(h / ROW_H));
    if (last.current === rows) return;
    last.current = rows;
    editor.setViewport(rows);
  });

  if (!editor.visible) return null;

  return (
    <div class="overlay" t="editor">
      <header class="overlay-head">
        <span class="ov-title">{editor.title()}</span>
        <span class="ov-meta">
          {editor.cursor.line + 1}:{editor.cursor.col + 1} of {editor.lineCount}
        </span>
        <span class="ov-pos">
          {editor.overwrite && "OVR · "}
          {editor.bookmarks.length > 0 &&
            `${editor.bookmarks.length} marks · `}
          {editor.modified ? "modified" : "saved"}
        </span>
      </header>

      <div class="overlay-body editorview" ref={dims.ref}>
        {editor.rows.map((l, i) => (
          <Line key={editor.top + i} text={l} index={editor.top + i} />
        ))}
      </div>

      <nav class="buttonbar">
        <button type="button" t="ed-save" onClick={() => editor.save()}>
          <span class="fk">2</span>
          <span class="fl">Save</span>
        </button>
        <button type="button" onClick={() => editor.toggleMark()}>
          <span class="fk">3</span>
          <span class="fl">Mark</span>
        </button>
        <button type="button" onClick={() => editor.copyBlock()}>
          <span class="fk">5</span>
          <span class="fl">Copy</span>
        </button>
        <button type="button" onClick={() => editor.moveBlock()}>
          <span class="fk">6</span>
          <span class="fl">Move</span>
        </button>
        <button type="button" onClick={() => editor.deleteBlock()}>
          <span class="fk">8</span>
          <span class="fl">Delete</span>
        </button>
        <button type="button" t="ed-quit" onClick={() => editor.close()}>
          <span class="fk">10</span>
          <span class="fl">Quit</span>
        </button>
      </nav>
    </div>
  );
}
