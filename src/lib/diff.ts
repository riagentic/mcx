/** Line diff — the engine behind `C-x C-d`.
 *
 *  Myers' greedy algorithm, which finds a SHORTEST edit script: the fewest
 *  insertions and deletions that turn one file into the other. That matters
 *  more than it sounds. A cheaper "walk both sides and resynchronise" diff
 *  produces a correct-but-useless answer on the common case — one line inserted
 *  near the top makes every later line look changed — and a reviewer cannot
 *  tell a real edit from an alignment artefact.
 *
 *  Pure, so it is testable without files, and so the same function can serve a
 *  side-by-side view, a merge and a test oracle. */

export type EditKind = "same" | "del" | "add";

/** One step of the edit script. `a`/`b` are line indices into the two inputs;
 *  `same` carries both, `del` only `a`, `add` only `b`. */
export type Edit = {
  kind: EditKind;
  a: number;
  b: number;
};

/** Above this many lines the O(ND) search is abandoned for a cheap alignment.
 *  Diffing two 200 000-line files is not what a file manager is for, and an
 *  editor that hangs is worse than one that says "these are very different". */
const MAX_D = 40_000;

/**
 * The shortest edit script from `a` to `b`.
 *
 * The implementation is the standard greedy Myers walk: `v[k]` is the furthest
 * `x` reached on diagonal `k` after `d` edits, each round is saved so the path
 * can be walked back, and the backtrack turns that trace into edits.
 */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
): Edit[] {
  const n = a.length;
  const m = b.length;

  // Identical, empty, or one side empty — answers worth having without a search.
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((_, i) => ({ kind: "add" as const, a: 0, b: i }));
  if (m === 0) return a.map((_, i) => ({ kind: "del" as const, a: i, b: 0 }));

  const max = Math.min(n + m, MAX_D);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];

  let found = -1;
  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // Take the better of "down" (an insertion) and "right" (a deletion).
      let x = (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!))
        ? v[offset + k + 1]!
        : v[offset + k - 1]! + 1;
      let y = x - k;
      // Slide down the diagonal for as long as the lines agree — this is the
      // part that makes the algorithm fast on files that mostly match.
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }

  // The search was abandoned: report it as a wholesale replacement rather than
  // a wrong alignment.
  if (found < 0) {
    return [
      ...a.map((_, i) => ({ kind: "del" as const, a: i, b: 0 })),
      ...b.map((_, i) => ({ kind: "add" as const, a: n, b: i })),
    ];
  }

  // Walk the trace backwards, emitting edits, then reverse.
  const out: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const down = k === -d ||
      (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!);
    const kPrev = down ? k + 1 : k - 1;
    const xStart = vd[offset + kPrev]!;
    const yStart = xStart - kPrev;
    const xMid = down ? xStart : xStart + 1;
    const yMid = xMid - k;

    while (x > xMid && y > yMid) {
      x--;
      y--;
      out.push({ kind: "same", a: x, b: y });
    }
    if (d > 0) {
      if (down) {
        y--;
        out.push({ kind: "add", a: x, b: y });
      } else {
        x--;
        out.push({ kind: "del", a: x, b: y });
      }
    }
    x = xStart;
    y = yStart;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push({ kind: "same", a: x, b: y });
  }
  return out.reverse();
}

/** One line of a side-by-side view. A `null` side is padding — the other file
 *  has no line here, and the gap is what makes the two columns line up. */
export type DiffRow = {
  left: string | null;
  right: string | null;
  /** 1-based line numbers, or null on a padded side. */
  leftNo: number | null;
  rightNo: number | null;
  kind: "same" | "add" | "del" | "change";
  /** Index of the difference this row belongs to, or -1 when the sides agree.
   *  Numbering them is what `n`/`p` step through and what a merge acts on. */
  hunk: number;
};

/**
 * Turn an edit script into aligned rows.
 *
 * Runs of deletions and insertions that touch are paired up into `change`
 * rows — a modified line reads as one row with both versions on it, not as a
 * deletion followed by an insertion three rows later.
 */
export function alignRows(
  a: readonly string[],
  b: readonly string[],
  edits: readonly Edit[],
): DiffRow[] {
  const rows: DiffRow[] = [];
  let hunk = -1;
  let i = 0;

  while (i < edits.length) {
    const e = edits[i]!;
    if (e.kind === "same") {
      rows.push({
        left: a[e.a] ?? "",
        right: b[e.b] ?? "",
        leftNo: e.a + 1,
        rightNo: e.b + 1,
        kind: "same",
        hunk: -1,
      });
      i++;
      continue;
    }

    // A run of changes: every deletion and insertion up to the next match.
    const dels: Edit[] = [];
    const adds: Edit[] = [];
    while (i < edits.length && edits[i]!.kind !== "same") {
      (edits[i]!.kind === "del" ? dels : adds).push(edits[i]!);
      i++;
    }
    hunk++;
    const pairs = Math.max(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      const d = dels[p];
      const ad = adds[p];
      rows.push({
        left: d ? a[d.a] ?? "" : null,
        right: ad ? b[ad.b] ?? "" : null,
        leftNo: d ? d.a + 1 : null,
        rightNo: ad ? ad.b + 1 : null,
        kind: d && ad ? "change" : d ? "del" : "add",
        hunk,
      });
    }
  }
  return rows;
}

/** The rows of one difference, in order. */
export const hunkRows = (rows: readonly DiffRow[], hunk: number): DiffRow[] =>
  rows.filter((r) => r.hunk === hunk);

/** How many differences there are. */
export const hunkCount = (rows: readonly DiffRow[]): number =>
  rows.reduce((n, r) => Math.max(n, r.hunk + 1), 0);

/** The row index of the first row of hunk `n`, or -1. */
export const hunkStart = (rows: readonly DiffRow[], n: number): number =>
  rows.findIndex((r) => r.hunk === n);

/**
 * Apply one difference from one side to the other, returning the new lines of
 * the receiving file — mc's F5 "merge".
 *
 * Expressed as "rebuild the receiving side from the rows" rather than as a
 * splice: after a merge the two files agree on that hunk, and the simplest way
 * to be sure of that is to write out what the view is already showing.
 */
export function mergeHunk(
  rows: readonly DiffRow[],
  hunk: number,
  from: "left" | "right",
): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const take = r.hunk === hunk ? from : (from === "left" ? "right" : "left");
    const line = take === "left" ? r.left : r.right;
    if (line !== null) out.push(line);
  }
  return out;
}
