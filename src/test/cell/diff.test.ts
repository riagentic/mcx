// The diff viewer against real files: what it publishes, what it merges, and
// what it writes.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { diff } from "../../cell/diff.ts";
import { ui } from "../../cell/ui.ts";

async function withFiles(
  a: string,
  b: string,
  fn: (pa: string, pb: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mcx-diff-" });
  const pa = `${dir}/a.txt`, pb = `${dir}/b.txt`;
  await Deno.writeTextFile(pa, a);
  await Deno.writeTextFile(pb, b);
  const h = await bootCells([ui, diff]);
  try {
    await diff.setViewport(50);
    await fn(pa, pb);
  } finally {
    diff.close();
    h.dispose();
  }
}

Deno.test("comparing publishes a window, not the two files", () =>
  withFiles("a\nb\nc\n", "a\nB\nc\n", async (pa, pb) => {
    await diff.setViewport(2);
    await diff.open(pa, pb);
    assertEquals(diff.visible, true);
    assertEquals(diff.hunks, 1);
    assertEquals(diff.count, 3);
    // The client sees two rows because two fit — never the whole comparison.
    assertEquals(diff.rows.length, 2);
  }));

Deno.test("identical files say so instead of showing nothing", () =>
  withFiles("same\n", "same\n", async (pa, pb) => {
    await diff.open(pa, pb);
    assertEquals(diff.hunks, 0);
    assert(ui.status.includes("identical"), ui.status);
  }));

Deno.test("n and p step between differences, and stop at the ends", () =>
  withFiles("x1\nsame\ny1\n", "x2\nsame\ny2\n", async (pa, pb) => {
    await diff.open(pa, pb);
    assertEquals(diff.hunks, 2);
    assertEquals(diff.atHunk, 1); // the cursor starts on the first row
    await diff.stepHunk(1);
    assertEquals(diff.atHunk, 2);
    await diff.stepHunk(1);
    assert(ui.status.includes("Last difference"), ui.status);
    await diff.stepHunk(-1);
    assertEquals(diff.atHunk, 1);
  }));

Deno.test("F5 merges a difference and F2 writes it", () =>
  withFiles("keep\nmine\n", "keep\ntheirs\n", async (pa, pb) => {
    await diff.open(pa, pb);
    await diff.merge("left"); // take the left version into the right file
    assertEquals(diff.hunks, 0); // they now agree
    assertEquals(diff.modified, "right");

    // Nothing is written until it is asked for.
    assertEquals(await Deno.readTextFile(pb), "keep\ntheirs\n");
    await diff.save();
    assertEquals(await Deno.readTextFile(pb), "keep\nmine\n");
    assertEquals(diff.modified, "");
    // …and the file that was not merged into is untouched.
    assertEquals(await Deno.readTextFile(pa), "keep\nmine\n");
  }));

Deno.test("merging the other way writes the other file", () =>
  withFiles("keep\nmine\n", "keep\ntheirs\n", async (pa, pb) => {
    await diff.open(pa, pb);
    await diff.merge("right");
    assertEquals(diff.modified, "left");
    await diff.save();
    assertEquals(await Deno.readTextFile(pa), "keep\ntheirs\n");
  }));

Deno.test("C-u swaps the sides, merges and all", () =>
  withFiles("left\n", "right\n", async (pa, pb) => {
    await diff.open(pa, pb);
    assertEquals(diff.rows[0]!.left, "left");
    await diff.swap();
    assertEquals(diff.rows[0]!.left, "right");
    assertEquals(diff.leftPath, pb);
  }));

Deno.test("a directory is refused with a message, not a crash", () =>
  withFiles("a\n", "b\n", async (pa) => {
    const dir = pa.slice(0, pa.lastIndexOf("/"));
    await diff.open(pa, dir);
    assert(ui.status.includes("Cannot compare"), ui.status);
    assertEquals(diff.visible, false);
  }));

Deno.test("F7 finds the difference containing a string", () =>
  // Two differences with a matching line between them: adjacent changed lines
  // are ONE difference, so a second one needs something in between.
  withFiles(
    "a\nb\nsame\nneedle\n",
    "a\nB\nsame\nhaystack\n",
    async (pa, pb) => {
      await diff.open(pa, pb);
      assertEquals(diff.hunks, 2);
      assertEquals(diff.atHunk, 1); // opens on the first
      await diff.find("haystack");
      assertEquals(diff.atHunk, 2); // …and the search moved to the second
    },
  ));

Deno.test("a run of changed lines is one difference, not one per line", () =>
  withFiles("a\nb\nc\n", "A\nB\nC\n", async (pa, pb) => {
    await diff.open(pa, pb);
    assertEquals(diff.hunks, 1);
    assertEquals(diff.count, 3);
  }));
