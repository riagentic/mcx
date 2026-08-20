import { assertEquals } from "@std/assert";
import {
  clamp,
  derive,
  locate,
  makeRows,
  markable,
  scrollTo,
  summarize,
} from "../../lib/panel.ts";
import type { FileEntry } from "../../type/fs.ts";

const file = (
  name: string,
  size = 0,
  kind: FileEntry["kind"] = "file",
): FileEntry => ({
  name,
  kind,
  size,
  mtime: 0,
  mode: 0o644,
  uid: 0,
  gid: 0,
  nlink: 1,
});

const listing = [
  file(".."),
  file("a", 10),
  file("b", 20),
  file("c", 30),
  file("d", 40),
];

Deno.test("clamp bounds both ends", () => {
  assertEquals(clamp(5, 0, 3), 3);
  assertEquals(clamp(-5, 0, 3), 0);
  assertEquals(clamp(2, 0, 3), 2);
});

Deno.test("scrollTo moves the window minimally", () => {
  // fits entirely: never scrolls
  assertEquals(scrollTo(4, 0, 10, 5), 0);
  // cursor below the window: scroll just enough
  assertEquals(scrollTo(5, 0, 3, 10), 3);
  // cursor above: align to cursor
  assertEquals(scrollTo(2, 5, 3, 10), 2);
  // already visible: unchanged
  assertEquals(scrollTo(6, 5, 3, 10), 5);
  // never past the end
  assertEquals(scrollTo(9, 8, 3, 10), 7);
});

Deno.test("makeRows windows the listing and resolves marks", () => {
  const rows = makeRows(listing, 1, 2, new Set(["b"]));
  assertEquals(rows.map((r) => r.name), ["a", "b"]);
  assertEquals(rows.map((r) => r.index), [1, 2]);
  assertEquals(rows.map((r) => r.marked), [false, true]);
});

Deno.test("summarize ignores .. and counts files only", () => {
  const s = summarize(listing, new Set(["a", "c", ".."]));
  assertEquals(s.markedCount, 2);
  assertEquals(s.markedBytes, 40);
  assertEquals(s.totalBytes, 100);
});

Deno.test("locate pins the cursor to a file, not a row", () => {
  assertEquals(locate(listing, "c", 0), 3);
  // vanished file: fall back to the row, clamped
  assertEquals(locate(listing, "gone", 99), 4);
  assertEquals(locate([], "x", 3), 0);
});

Deno.test("markable refuses ..", () => {
  assertEquals(markable(file("..")), false);
  assertEquals(markable(file("a")), true);
  assertEquals(markable(undefined), false);
});

Deno.test("derive keeps rows, counts and totals in agreement", () => {
  const p = { all: listing, marked: ["b"], cursor: 4, offset: 0, viewport: 2 };
  const d = derive(p);
  assertEquals(d.count, 5);
  assertEquals(d.cursor, 4);
  assertEquals(d.offset, 3); // scrolled to reveal the cursor
  assertEquals(d.rows.map((r) => r.name), ["c", "d"]);
  assertEquals(d.markedCount, 1);
  assertEquals(d.markedBytes, 20);
});

Deno.test("derive with keepName follows the file across a refresh", () => {
  const shrunk = [file(".."), file("c", 30), file("d", 40)];
  const d = derive({
    all: shrunk,
    marked: [],
    cursor: 3,
    offset: 0,
    viewport: 5,
  }, "d");
  assertEquals(d.cursor, 2);
});
