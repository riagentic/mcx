/** One listing row. Kept apart from the panel because it is the component that
 *  exists forty times per panel and re-renders on every cursor move — its cost
 *  is the panel's cost. */

import { panels } from "../cell/panels.ts";
import { formatMode, formatSize, formatTime, typeChar } from "../lib/format.ts";
import type { ListMode, PanelSide, RowView } from "../type/panel.ts";

/** Colour class by file kind — mc's filetype colouring, in CSS. */
function kindClass(r: RowView): string {
  if (r.broken) return "k-broken";
  if (r.kind === "dir" || (r.kind === "link" && r.linkKind === "dir")) {
    return "k-dir";
  }
  if (r.kind === "link") return "k-link";
  if (r.kind === "file" && (r.mode & 0o111) !== 0) return "k-exec";
  if (r.kind !== "file") return "k-special";
  return "k-file";
}

export function FileRow(
  { row, side, mode, current, height }: {
    row: RowView;
    side: PanelSide;
    mode: ListMode;
    current: boolean;
    height: number;
  },
) {
  const cls = [
    "row",
    kindClass(row),
    row.marked ? "marked" : "",
    current ? "cursor" : "",
  ].filter(Boolean).join(" ");

  const select = () => {
    panels.activate(side);
    panels.setCursor(row.index);
  };

  // The name column is a window too when the panel is scrolled sideways.
  const name = panels[side].hscroll > 0
    ? row.name.slice(panels[side].hscroll)
    : row.name;

  return (
    <div
      class={cls}
      style={{ height: `${height}px`, lineHeight: `${height}px` }}
      onClick={select}
      onDblClick={() => {
        select();
        panels.enter();
      }}
      t={`row-${row.name}`}
    >
      <span class="name">
        {name}
        <span class="tc">{typeChar(row)}</span>
      </span>
      {mode !== "brief" && <span class="size">{formatSize(row)}</span>}
      {mode === "full" && <span class="time">{formatTime(row.mtime)}</span>}
      {mode === "long" && (
        <span class="perm">{formatMode(row.kind, row.mode)}</span>
      )}
      {mode === "long" && <span class="owner">{row.uid}:{row.gid}</span>}
      {mode === "long" && <span class="time">{formatTime(row.mtime)}</span>}
    </div>
  );
}
