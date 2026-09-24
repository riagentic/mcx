/** The diff overlay (C-x C-d): two files side by side, differences marked, and
 *  a cursor that steps between them. */

import { effect, useDimensions, useRef } from "aio/air";
import { diff } from "../cell/diff.ts";
import type { DiffRow } from "../lib/diff.ts";
import { ROW_H } from "./metrics.ts";

/** mc's gutter marks: what happened to this line, in one character. */
const SYMBOL: Record<DiffRow["kind"], string> = {
  same: " ",
  add: "+",
  del: "-",
  change: "!",
};

/** Tabs expanded to the chosen stop, and the shared horizontal offset applied.
 *  Both are display concerns: the documents keep their tabs and their columns,
 *  so a merge writes back what was really there. */
function shown(text: string): string {
  const tabbed = text.includes("\t")
    ? text.replaceAll("\t", " ".repeat(diff.tabWidth))
    : text;
  return diff.column > 0 ? tabbed.slice(diff.column) : tabbed;
}

function Side(
  { text, no, kind, side }: {
    text: string | null;
    no: number | null;
    kind: DiffRow["kind"];
    side: "left" | "right";
  },
) {
  // A null side is padding: the other file has a line here and this one does
  // not. It is drawn as an empty band so the two columns stay in step.
  return (
    <div class={`dside d-${text === null ? "pad" : kind} d-${side}`}>
      {diff.showNumbers && <span class="vnum">{no ?? ""}</span>}
      {diff.showSymbols && (
        <span class="dsym">{text === null ? " " : SYMBOL[kind]}</span>
      )}
      <span class="dtext">{text === null ? "" : shown(text)}</span>
    </div>
  );
}

function Row({ row, index }: { row: DiffRow; index: number }) {
  // `f` gives one side the screen; otherwise the divider sits where `>` and
  // `<` have put it.
  const columns = diff.full === "left"
    ? "1fr 0"
    : diff.full === "right"
    ? "0 1fr"
    : `${diff.ratio}fr ${1 - diff.ratio}fr`;

  return (
    <div
      class={`drow ${index === diff.cursor ? "current" : ""}`}
      style={{
        height: `${ROW_H}px`,
        lineHeight: `${ROW_H}px`,
        "grid-template-columns": columns,
      }}
    >
      <Side text={row.left} no={row.leftNo} kind={row.kind} side="left" />
      <Side text={row.right} no={row.rightNo} kind={row.kind} side="right" />
    </div>
  );
}

export function Diff() {
  const dims = useDimensions();

  // Once per geometry — see the note in Panel.tsx.
  const last = useRef(0);
  effect(() => {
    const h = dims.height.value;
    if (!(h > 0) || !diff.visible) return;
    const rows = Math.max(1, Math.floor(h / ROW_H));
    if (last.current === rows) return;
    last.current = rows;
    diff.setViewport(rows);
  });

  if (!diff.visible) return null;

  return (
    <div class="overlay" t="diff">
      <header class="overlay-head">
        <span class="ov-title">{diff.title()}</span>
        <span class="ov-meta">
          {diff.hunks === 0
            ? "identical"
            : `difference ${diff.atHunk} of ${diff.hunks}`}
        </span>
        <span class="ov-pos">
          {diff.ignoreWhitespace && "ignoring space · "}
          {diff.modified ? "unsaved merge" : ""}
        </span>
      </header>

      {diff.error
        ? <div class="err">{diff.error}</div>
        : (
          <div class="overlay-body diffview" ref={dims.ref}>
            {diff.rows.map((r, i) => (
              <Row key={diff.top + i} row={r} index={diff.top + i} />
            ))}
          </div>
        )}

      <nav class="buttonbar">
        <button type="button" onClick={() => diff.save()}>
          <span class="fk">2</span>
          <span class="fl">Save</span>
        </button>
        <button type="button" onClick={() => diff.merge("left")}>
          <span class="fk">5</span>
          <span class="fl">Merge →</span>
        </button>
        <button type="button" onClick={() => diff.merge("right")}>
          <span class="fk">15</span>
          <span class="fl">← Merge</span>
        </button>
        <button type="button" onClick={() => diff.stepHunk(1)}>
          <span class="fk">n</span>
          <span class="fl">Next</span>
        </button>
        <button type="button" onClick={() => diff.stepHunk(-1)}>
          <span class="fk">p</span>
          <span class="fl">Prev</span>
        </button>
        <button type="button" t="diff-quit" onClick={() => diff.close()}>
          <span class="fk">10</span>
          <span class="fl">Quit</span>
        </button>
      </nav>
    </div>
  );
}
