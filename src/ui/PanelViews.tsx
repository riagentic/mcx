/** The panel modes that are not a file list: Info and Quick view (mc's C-x i
 *  and C-x q). Both read the OTHER panel — that is the whole point of them. */

import { effect, useDimensions, useRef } from "aio/air";
import { panels } from "../cell/panels.ts";
import { tree } from "../cell/tree.ts";
import {
  formatMode,
  formatTime,
  groupDigits,
  humanSize,
} from "../lib/format.ts";
import type { PanelSide } from "../type/panel.ts";
import { ROW_H } from "./metrics.ts";

const other = (s: PanelSide): PanelSide => (s === "left" ? "right" : "left");

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div class="info-row">
      <span class="info-label">{label}</span>
      <span class="info-value">{value}</span>
    </div>
  );
}

export function InfoView({ side }: { side: PanelSide }) {
  const src = panels[other(side)];
  const cur = src.rows.find((r) => r.index === src.cursor);

  // Re-stat whenever the other panel's cursor (or directory) changes, and only
  // then — the same guard QuickView documents below, and for the same reason:
  // `loadDetails` writes into the state this effect watches.
  const shown = useRef("");
  effect(() => {
    const subject = `${src.generation}:${src.path}:${src.cursor}`;
    if (shown.current === subject) return;
    shown.current = subject;
    panels.loadDetails(side);
  });

  const d = panels[side].details;
  const hex = (n: number) => n.toString(16);
  const pct = (part: number, whole: number) =>
    whole > 0 ? ` (${Math.round((part / whole) * 100)}%)` : "";

  return (
    <div class="infoview" t={`info-${side}`}>
      {cur
        ? (
          <>
            <Field label="File" value={cur.name} />
            <Field label="Type" value={cur.kind} />
            <Field
              label="Size"
              value={`${groupDigits(cur.size)} (${humanSize(cur.size)})`}
            />
            {
              /* mc prints the mode both ways, because one of them is what you
                read and the other is what you type into chmod. */
            }
            <Field
              label="Mode"
              value={`${formatMode(cur.kind, cur.mode)} (${
                (cur.mode & 0o7777).toString(8).padStart(4, "0")
              })`}
            />
            <Field
              label="Owner"
              value={d ? `${d.owner}/${d.group}` : `${cur.uid}/${cur.gid}`}
            />
            <Field label="Links" value={String(cur.nlink)} />
            <Field label="Modified" value={formatTime(cur.mtime)} />
            {d && <Field label="Accessed" value={formatTime(d.atime)} />}
            {d && <Field label="Changed" value={formatTime(d.ctime)} />}
            {d && (
              <Field
                label="Location"
                value={`${hex(d.dev)}h:${hex(d.inode)}h`}
              />
            )}
            {cur.target && <Field label="Points to" value={cur.target} />}
          </>
        )
        : <div class="info-empty">No file selected</div>}

      <hr />
      <Field label="Directory" value={src.path} />
      <Field label="Files" value={`${src.count}`} />
      <Field label="Total size" value={humanSize(src.totalBytes)} />
      {src.device !== "" && <Field label="Device" value={src.device} />}
      {src.fstype !== "" && <Field label="Filesystem" value={src.fstype} />}
      <Field
        label="Free space"
        value={src.total > 0
          ? `${humanSize(src.free)} / ${humanSize(src.total)}${
            pct(src.free, src.total)
          }`
          : "unknown"}
      />
      {src.nodesTotal > 0 && (
        <Field
          label="Free nodes"
          value={`${groupDigits(src.nodesFree)} / ${
            groupDigits(src.nodesTotal)
          }${pct(src.nodesFree, src.nodesTotal)}`}
        />
      )}
    </div>
  );
}

/** mc's tree panel: the directory tree of the filesystem, walked with the
 *  arrows, opened and closed with `+`/`-`, and — with F4's "toggle navigation"
 *  on — dragging the other panel along as the cursor moves. */
export function TreeView({ side }: { side: PanelSide }) {
  const dims = useDimensions();

  // One report per geometry, not one per wake — the same measurement loop
  // Panel.tsx documents at length, and the same reason for `last`.
  const last = useRef(0);
  effect(() => {
    const h = dims.height.value;
    if (!Number.isFinite(h) || h <= 0) return;
    const rows = Math.max(1, Math.floor(h / ROW_H));
    if (last.current === rows) return;
    last.current = rows;
    tree.setViewport(rows);
  });

  return (
    <div class="treeview" t={`tree-${side}`}>
      {tree.rows.map((r) => (
        <div
          key={r.path}
          class={`trow ${r.index === tree.cursor ? "current" : ""}`}
          style={{ paddingLeft: `${r.depth}ch` }}
          onClick={() => tree.setCursor(r.index)}
          onDblClick={() => tree.toggle()}
        >
          {
            /* A twisty only where there is something to open: a leaf with a
              `+` in front of it is a promise the tree cannot keep. */
          }
          <span class="twisty">{r.branch ? (r.open ? "-" : "+") : " "}</span>
          <span class="tname">{r.name}</span>
        </div>
      ))}
      {tree.count === 0 && <div class="info-empty">Reading the tree…</div>}
    </div>
  );
}

export function QuickView({ side }: { side: PanelSide }) {
  const src = panels[other(side)];

  // Re-preview whenever the other panel's cursor (or directory) changes — and
  // ONLY then. The effect wakes on every panels broadcast, and `loadPreview`
  // writes `preview` into that same state, so an unguarded call re-triggered
  // the effect that made it: 290 previews of one file in a second, until the
  // server's rate limiter dropped the client. Naming the subject the preview is
  // OF, and skipping when it has not changed, breaks the cycle at the source —
  // the file is read once per file, which is also the only time it is useful.
  const shown = useRef("");
  effect(() => {
    const subject = `${src.generation}:${src.path}:${src.cursor}`;
    if (shown.current === subject) return;
    shown.current = subject;
    panels.loadPreview(side);
  });

  const lines = panels[side].preview;

  return (
    <div class="quickview" t={`quick-${side}`}>
      {lines.length === 0
        ? <div class="info-empty">Nothing to preview</div>
        : lines.map((l, i) => (
          <div class="qline" key={i}>{l === "" ? " " : l}</div>
        ))}
    </div>
  );
}
