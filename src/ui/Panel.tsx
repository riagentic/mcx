/** A file panel. Measures itself, tells the cell how many rows fit, and renders
 *  the window the cell sends back — the listing itself never reaches the
 *  browser, so this component costs the same on a 100_000-file directory as on
 *  an empty one. */

import { effect, useDimensions, useRef } from "aio/air";
import { panels } from "../cell/panels.ts";
import { ui } from "../cell/ui.ts";
import { formatSize, humanSize, typeChar } from "../lib/format.ts";
import { tildify } from "../lib/path.ts";
import type { PanelSide, PanelState } from "../type/panel.ts";
import { FileRow } from "./FileRow.tsx";
import { InfoView, QuickView, TreeView } from "./PanelViews.tsx";

/** Row height in px — one number, used for both the CSS box and the arithmetic
 *  that decides how many rows fit, so the two cannot disagree. */
export const ROW_H = 21;
const MIN_COL_W = 190;
/** Rows per wheel notch — three is the desktop convention. */
const WHEEL_ROWS = 3;

const HEADS: Record<string, string[]> = {
  brief: ["Name"],
  full: ["Name", "Size", "Modify time"],
  long: ["Name", "Size", "Permission", "Owner", "Modify time"],
};

function columnsFor(mode: string, width: number): number {
  if (mode !== "brief") return 1;
  return Math.max(1, Math.min(4, Math.floor(width / MIN_COL_W)));
}

/** The one-line summary under the listing: what the cursor is on, or what is
 *  marked. mc puts the marked total ahead of the filename, because when a
 *  selection exists that is the number you are about to act on. */
function MiniStatus({ p }: { p: PanelState }) {
  const cur = p.rows.find((r) => r.index === p.cursor);
  if (p.markedCount > 0) {
    return (
      <div class="mini marked">
        {humanSize(p.markedBytes)} in {p.markedCount} file
        {p.markedCount === 1 ? "" : "s"}
      </div>
    );
  }
  if (!cur) return <div class="mini" />;
  return (
    <div class="mini">
      <span class="mini-name">{cur.name}{typeChar(cur)}</span>
      <span class="mini-size">{formatSize(cur)}</span>
    </div>
  );
}

export function Panel({ side }: { side: PanelSide }) {
  const dims = useDimensions();

  // Report the geometry to the cell — once per geometry, not once per wake.
  //
  // This effect runs ~65 times during a single directory load: every state
  // broadcast (the listing, then each chunk of metadata) re-runs it, and the
  // measurement it reports has not changed in any of them. Two things follow.
  //
  // `Number.isFinite`, because an element measured before it is in the document
  // computes to NaN, and `h <= 0` does not catch NaN. A NaN viewport can never
  // equal the NaN already stored, so the cell's "no-op when unchanged" test
  // failed on every call: each action changed the state, the broadcast re-ran
  // this effect, and mcx sent ~700 actions in 300ms until the server's rate
  // limiter dropped the client and the app froze where it stood.
  //
  // And `last`, rather than comparing against `p.viewport`, because the state
  // is a round trip away: sixty effect runs can happen before the first answer
  // arrives, and each would read the same stale value and send again. What the
  // client must not repeat is what the CLIENT last said.
  const last = useRef({ rows: 0, cols: 0 });
  effect(() => {
    const h = dims.height.value;
    const w = dims.width.value;
    if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0) return;
    const cols = columnsFor(panels[side].mode, w);
    const rows = Math.max(1, Math.floor(h / ROW_H)) * cols;
    if (last.current.rows === rows && last.current.cols === cols) return;
    last.current = { rows, cols };
    panels.setViewport(side, rows, cols);
  });

  const p = panels[side];
  const active = panels.active === side;
  const cols = columnsFor(p.mode, dims.width.value || MIN_COL_W);
  const heads = HEADS[p.mode] ?? HEADS.full!;
  // Brief mode fills top-to-bottom then across, the way mc does — which in CSS
  // grid means fixing the row count and flowing by column.
  const perCol = Math.max(1, Math.floor((dims.height.value || ROW_H) / ROW_H));
  const gridStyle = cols > 1
    ? {
      "grid-auto-flow": "column",
      "grid-template-rows": `repeat(${perCol}, ${ROW_H}px)`,
      "grid-template-columns": `repeat(${cols}, minmax(0, 1fr))`,
    }
    : { "grid-template-columns": "minmax(0, 1fr)" };

  return (
    <section
      class={`panel ${active ? "active" : ""} mode-${p.mode}`}
      onMouseDown={() => panels.activate(side)}
      t={`panel-${side}`}
    >
      <header class="panel-path" title={p.path}>
        {tildify(p.path, ui.home)}
        {p.loading && <span class="spin">…</span>}
      </header>

      {p.view !== "list"
        ? (
          <div class="altview">
            {p.view === "info" && <InfoView side={side} />}
            {p.view === "quickview" && <QuickView side={side} />}
            {p.view === "tree" && <TreeView side={side} />}
          </div>
        )
        : (
          <>
            <div class="heads">
              {heads.map((h) => (
                <span key={h} class={`h-${h.split(" ")[0]!.toLowerCase()}`}>
                  {h}
                </span>
              ))}
            </div>

            <div
              class="list"
              ref={dims.ref}
              style={gridStyle}
              onWheel={(e: WheelEvent) => {
                // A file manager with a keyboard heritage still has to answer the
                // mouse: the wheel scrolls the panel it is over, activating it first
                // so the cursor and the scroll never end up on different sides.
                e.preventDefault();
                panels.activate(side);
                panels.move(e.deltaY > 0 ? WHEEL_ROWS : -WHEEL_ROWS);
              }}
            >
              {p.error
                ? <div class="err">{p.error}</div>
                : p.rows.map((r) => (
                  <FileRow
                    key={`${p.generation}:${r.index}`}
                    row={r}
                    side={side}
                    mode={p.mode}
                    current={r.index === p.cursor && active}
                    height={ROW_H}
                  />
                ))}
            </div>
          </>
        )}

      <MiniStatus p={p} />

      <footer class="panel-free">
        {ui.showFree && p.total > 0
          ? `${humanSize(p.free)} / ${humanSize(p.total)} free`
          : `${p.count} item${p.count === 1 ? "" : "s"}`}
      </footer>
    </section>
  );
}
