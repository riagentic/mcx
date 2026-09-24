/** Pure panel arithmetic — cursor, scroll window, marking summaries.
 *
 *  Kept out of the cell so every rule here is testable without booting an app,
 *  and so the same functions can run client-side if a view ever needs them. */

import type { FileEntry } from "../type/fs.ts";
import { UP_DIR } from "../type/fs.ts";
import type { RowView } from "../type/panel.ts";

export const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

/** Minimal scroll: move the window only as far as it takes to reveal the
 *  cursor. mc's feel — the list does not jump under you. */
export function scrollTo(
  cursor: number,
  offset: number,
  viewport: number,
  count: number,
): number {
  if (viewport <= 0 || count <= viewport) return 0;
  let o = offset;
  if (cursor < o) o = cursor;
  else if (cursor >= o + viewport) o = cursor - viewport + 1;
  return clamp(o, 0, count - viewport);
}

/** The window the UI renders, with per-row marks resolved. */
export function makeRows(
  all: readonly FileEntry[],
  offset: number,
  viewport: number,
  marked: ReadonlySet<string>,
): RowView[] {
  const end = Math.min(all.length, offset + Math.max(0, viewport));
  const out: RowView[] = [];
  for (let i = Math.max(0, offset); i < end; i++) {
    const e = all[i]!;
    out.push({ ...e, index: i, marked: marked.has(e.name) });
  }
  return out;
}

export type Summary = {
  markedCount: number;
  markedBytes: number;
  /** First marked name in listing order — the only piece of the mark set the
   *  client is allowed to see, and all a one-file dialog needs. */
  markedFirst: string;
  totalBytes: number;
};

/** Status-line arithmetic. `..` counts for nothing, as in mc. */
export function summarize(
  all: readonly FileEntry[],
  marked: ReadonlySet<string>,
): Summary {
  let markedCount = 0, markedBytes = 0, totalBytes = 0, markedFirst = "";
  for (const e of all) {
    if (e.name === UP_DIR) continue;
    if (e.kind === "file") totalBytes += e.size;
    if (marked.has(e.name)) {
      if (markedCount === 0) markedFirst = e.name;
      markedCount++;
      if (e.kind === "file") markedBytes += e.size;
    }
  }
  return { markedCount, markedBytes, markedFirst, totalBytes };
}

/** Index of `name`, or `fallback` clamped into range — the rule that keeps the
 *  cursor on the same FILE across a refresh, rather than on the same ROW. */
export function locate(
  all: readonly FileEntry[],
  name: string | null,
  fallback: number,
): number {
  if (name) {
    const i = all.findIndex((e) => e.name === name);
    if (i >= 0) return i;
  }
  return clamp(fallback, 0, Math.max(0, all.length - 1));
}

/** `..` is never markable — marking it would mean "operate on the parent". */
export const markable = (e: FileEntry | undefined): boolean =>
  !!e && e.name !== UP_DIR;

/** Everything the panel shows that is a FUNCTION of `all` + `marked` + cursor.
 *
 *  One derivation, called after every mutation, is what keeps `rows`, `offset`,
 *  `count` and the mark totals from ever disagreeing with the listing — the
 *  class of bug where the status bar says "3 selected" and no row is
 *  highlighted simply cannot occur.
 *
 *  `keepName` pins the cursor to a FILE rather than a row index, which is what
 *  a refresh must do when files appear or vanish underneath it. */
export function derive(
  p: {
    all: readonly FileEntry[];
    markedNames: readonly string[];
    cursor: number;
    offset: number;
    viewport: number;
  },
  keepName?: string | null,
): Summary & {
  cursor: number;
  offset: number;
  rows: RowView[];
  count: number;
} {
  const marked = new Set(p.markedNames);
  const cursor = locate(p.all, keepName ?? null, p.cursor);
  const offset = scrollTo(cursor, p.offset, p.viewport, p.all.length);
  return {
    cursor,
    offset,
    rows: makeRows(p.all, offset, p.viewport, marked),
    count: p.all.length,
    ...summarize(p.all, marked),
  };
}
