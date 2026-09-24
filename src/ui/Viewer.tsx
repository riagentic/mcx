/** The viewer overlay (F3). Full-screen, keyboard-first, and honest about a
 *  file it has not finished indexing. */

import { effect, useDimensions, useRef } from "aio/air";
import { viewer } from "../cell/viewer.ts";
import { humanSize } from "../lib/format.ts";
import { ROW_H } from "./metrics.ts";

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const hex8 = (n: number) => n.toString(16).padStart(8, "0");

function HexRows() {
  // Which byte the cursor is on, and which bytes have been edited but not
  // saved: both have to be visible per BYTE, so the row is drawn as cells
  // rather than as one padded string.
  const editing = viewer.hexEdit;
  const cursor = viewer.hexCursor;
  const changed = viewer.changes;

  return (
    <div class="hexview">
      {viewer.hex.map((r) => (
        <div class="hexrow" key={r.offset} style={{ height: `${ROW_H}px` }}>
          <span class="hex-off">{hex8(r.offset)}</span>
          <span class="hex-bytes">
            {r.bytes.map((b, i) => {
              const at = r.offset + i;
              const cls = [
                changed[at] !== undefined ? "changed" : "",
                editing && at === cursor && viewer.hexColumn === "hex"
                  ? "cur"
                  : "",
              ].join(" ").trim();
              return (
                <span key={at} class={cls || undefined}>
                  {hex2(b)}
                  {i === r.bytes.length - 1 ? "" : " "}
                </span>
              );
            })}
            {/* Keep the text column aligned on a short last row. */}
            {"   ".repeat(Math.max(0, 16 - r.bytes.length))}
          </span>
          <span class="hex-text">
            {[...r.text].map((ch, i) => {
              const at = r.offset + i;
              const cls = [
                changed[at] !== undefined ? "changed" : "",
                editing && at === cursor && viewer.hexColumn === "text"
                  ? "cur"
                  : "",
              ].join(" ").trim();
              return <span key={at} class={cls || undefined}>{ch}</span>;
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Tens and units, the width of the view — for counting into a fixed-width
 *  record, which is most of what anyone unwraps a file for. */
function Ruler({ width }: { width: number }) {
  const from = viewer.column;
  let tens = "", units = "";
  for (let c = from; c < from + width; c++) {
    const n = c + 1;
    units += String(n % 10);
    tens += n % 10 === 0 ? String(Math.floor(n / 10) % 10) : " ";
  }
  return (
    <div class="vruler">
      <span class="vnum" />
      <span class="vtext">{tens}\n{units}</span>
    </div>
  );
}

function TextRows({ width }: { width: number }) {
  return (
    <div class={`textview ${viewer.wrap ? "wrap" : ""}`}>
      {viewer.ruler && <Ruler width={width} />}
      {viewer.lines.map((l, i) => {
        // Unwrapped, the view is a window onto the line as well as onto the
        // file: `column` is where that window starts.
        const text = viewer.wrap ? l : l.slice(viewer.column);
        return (
          <div class="vline" key={viewer.line + i}>
            <span class="vnum">{viewer.line + i + 1}</span>
            <span class="vtext">{text === "" ? " " : text}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Viewer() {
  const dims = useDimensions();

  // Once per geometry — see the note in Panel.tsx: the effect wakes on every
  // broadcast, and each viewport it reports costs a round trip and a re-read.
  const last = useRef(0);
  effect(() => {
    const h = dims.height.value;
    if (!(h > 0) || !viewer.visible) return;
    const rows = Math.max(1, Math.floor(h / ROW_H));
    if (last.current === rows) return;
    last.current = rows;
    viewer.setViewport(rows);
  });

  // Characters across, for the ruler: the body's width in `ch` at this font.
  const cols = (dims.width.value || 800) / 7.8;

  if (!viewer.visible) return null;

  return (
    <div class="overlay" t="viewer">
      <header class="overlay-head">
        <span class="ov-title">{viewer.title()}</span>
        <span class="ov-meta">
          {humanSize(viewer.size)} · {viewer.mode === "hex" ? "hex" : "text"}
          {viewer.mode === "text" && !viewer.complete && " · indexing…"}
        </span>
        <span class="ov-pos">
          {viewer.column > 0 && `col ${viewer.column + 1} · `}
          {viewer.percent().toFixed(0)}%
        </span>
      </header>

      {viewer.error
        ? <div class="err">{viewer.error}</div>
        : (
          <div class="overlay-body" ref={dims.ref}>
            {viewer.mode === "hex"
              ? <HexRows />
              : <TextRows width={Math.max(16, Math.floor(cols))} />}
          </div>
        )}

      <nav class="buttonbar">
        {
          /* mc relabels 2 and 6 in hex mode: what F2 does there is edit, and
            F6 is the save that only a hex edit needs. */
        }
        <button
          type="button"
          onClick={() =>
            viewer.mode === "hex"
              ? viewer.toggleHexEdit()
              : viewer.toggleWrap()}
        >
          <span class="fk">2</span>
          <span class="fl">
            {viewer.mode === "hex"
              ? (viewer.hexEdit ? "View" : "Edit")
              : (viewer.wrap ? "Unwrap" : "Wrap")}
          </span>
        </button>
        {viewer.mode === "hex" && viewer.hexEdit && (
          <button
            type="button"
            t="hex-save"
            onClick={() => viewer.saveHex()}
          >
            <span class="fk">6</span>
            <span class="fl">Save</span>
          </button>
        )}
        <button type="button" onClick={() => viewer.toggleMode()}>
          <span class="fk">4</span>
          <span class="fl">{viewer.mode === "hex" ? "Text" : "Hex"}</span>
        </button>
        <button type="button" onClick={() => viewer.find(viewer.search)}>
          <span class="fk">7</span>
          <span class="fl">Search</span>
        </button>
        <button type="button" t="viewer-quit" onClick={() => viewer.close()}>
          <span class="fk">10</span>
          <span class="fl">Quit</span>
        </button>
      </nav>
    </div>
  );
}
