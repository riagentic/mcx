// The diff engine. Two kinds of test: the properties that must hold for ANY
// pair of files (checked against generated ones), and the specific alignments a
// person would look at and judge.
import { assert, assertEquals } from "@std/assert";
import { alignRows, diffLines, hunkCount, mergeHunk } from "../../lib/diff.ts";

/** The edit script, applied. If this does not reproduce `b`, the diff is
 *  wrong — whatever it looks like on screen. */
function apply(a: readonly string[], edits: ReturnType<typeof diffLines>) {
  const out: string[] = [];
  for (const e of edits) {
    if (e.kind === "del") continue;
    out.push(e.kind === "same" ? a[e.a]! : LAST_B[e.b]!);
  }
  return out;
}
let LAST_B: readonly string[] = [];

function roundTrip(a: string[], b: string[]): string[] {
  LAST_B = b;
  return apply(a, diffLines(a, b));
}

Deno.test("the edit script turns one file into the other", () => {
  assertEquals(roundTrip(["a", "b", "c"], ["a", "x", "c"]), ["a", "x", "c"]);
  assertEquals(roundTrip([], ["a"]), ["a"]);
  assertEquals(roundTrip(["a"], []), []);
  assertEquals(roundTrip([], []), []);
  assertEquals(roundTrip(["a", "b"], ["a", "b"]), ["a", "b"]);
});

Deno.test("randomised files always round-trip", () => {
  // Seeded, so a failure reproduces exactly.
  let seed = 20260814;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const lines = (n: number) =>
    Array.from({ length: n }, () => String(Math.floor(rnd() * 6)));

  for (let i = 0; i < 300; i++) {
    const a = lines(Math.floor(rnd() * 12));
    const b = lines(Math.floor(rnd() * 12));
    assertEquals(
      roundTrip(a, b),
      b,
      `failed for a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
    );
  }
});

Deno.test("an insertion near the top does not misalign the rest", () => {
  // The reason for using Myers rather than a resynchronising walk: everything
  // after the inserted line must still read as unchanged.
  const a = ["one", "two", "three", "four"];
  const b = ["inserted", "one", "two", "three", "four"];
  const rows = alignRows(a, b, diffLines(a, b));
  assertEquals(hunkCount(rows), 1);
  assertEquals(rows.filter((r) => r.kind === "same").length, 4);
  assertEquals(rows[0]!.left, null);
  assertEquals(rows[0]!.right, "inserted");
});

Deno.test("a modified line reads as one row with both versions on it", () => {
  const a = ["keep", "old", "keep2"];
  const b = ["keep", "new", "keep2"];
  const rows = alignRows(a, b, diffLines(a, b));
  assertEquals(rows.length, 3);
  assertEquals(rows[1]!.kind, "change");
  assertEquals(rows[1]!.left, "old");
  assertEquals(rows[1]!.right, "new");
  assertEquals(rows[1]!.leftNo, 2);
  assertEquals(rows[1]!.rightNo, 2);
});

Deno.test("line numbers count the file, not the view", () => {
  const a = ["a", "b", "c"];
  const b = ["a", "c"];
  const rows = alignRows(a, b, diffLines(a, b));
  // The padded side has no number, and the right-hand side keeps counting.
  const deleted = rows.find((r) => r.kind === "del")!;
  assertEquals(deleted.left, "b");
  assertEquals(deleted.leftNo, 2);
  assertEquals(deleted.rightNo, null);
  assertEquals(rows[rows.length - 1]!.rightNo, 2);
});

Deno.test("merging a hunk makes the two sides agree on it", () => {
  const a = ["same", "mine", "tail"];
  const b = ["same", "theirs", "tail"];
  const rows = alignRows(a, b, diffLines(a, b));

  // Take the left version into the right-hand file…
  assertEquals(mergeHunk(rows, 0, "left"), ["same", "mine", "tail"]);
  // …or the other way.
  assertEquals(mergeHunk(rows, 0, "right"), ["same", "theirs", "tail"]);
});

Deno.test("merging one hunk leaves the others alone", () => {
  const a = ["x1", "same", "y1"];
  const b = ["x2", "same", "y2"];
  const rows = alignRows(a, b, diffLines(a, b));
  assertEquals(hunkCount(rows), 2);
  // Take hunk 0 from the left; hunk 1 keeps the right's version.
  assertEquals(mergeHunk(rows, 0, "left"), ["x1", "same", "y2"]);
  assertEquals(mergeHunk(rows, 1, "left"), ["x2", "same", "y1"]);
});

Deno.test("a merged result really is what the diff said it would be", () => {
  // The property that matters: after merging every hunk from the left, the two
  // files are identical.
  const a = ["a", "b", "c", "d"];
  const b = ["a", "B", "c", "D", "e"];
  const rows = alignRows(a, b, diffLines(a, b));
  let merged = b;
  for (let h = 0; h < hunkCount(rows); h++) {
    const r = alignRows(a, merged, diffLines(a, merged));
    merged = mergeHunk(r, 0, "left");
  }
  assertEquals(merged, a);
  assert(hunkCount(alignRows(a, merged, diffLines(a, merged))) === 0);
});
