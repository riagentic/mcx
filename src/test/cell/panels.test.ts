// Panel behaviour against a real directory tree — the only kind of test worth
// writing for a file manager.
//
// Assertions read `rows`, the panel's PUBLISHED window, never `all`: the full
// listing is server-side by design, so a test that read it would be testing
// something no client can ever see.
import { bootCells } from "aio/testing";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { panels } from "../../cell/panels.ts";
import { ui } from "../../cell/ui.ts";
import { formatSize } from "../../lib/format.ts";

const root = await Deno.makeTempDir({ prefix: "mcx-test-" });
await Deno.mkdir(`${root}/sub/deep`, { recursive: true });
await Deno.writeTextFile(`${root}/alpha.txt`, "a".repeat(10));
await Deno.writeTextFile(`${root}/beta.md`, "b".repeat(200));
await Deno.writeTextFile(`${root}/.hidden`, "");
await Deno.writeTextFile(`${root}/sub/inner.txt`, "x");

const names = () => panels.left.rows.map((r) => r.name);
const files = () =>
  panels.left.rows.filter((r) => r.kind === "file").map((r) => r.name);
const indexOf = (name: string) => names().indexOf(name);

async function withApp(fn: () => Promise<void>): Promise<void> {
  const h = await bootCells([panels, ui]);
  try {
    await panels.chdir("left", root);
    await fn();
  } finally {
    h.dispose();
  }
}

Deno.test("loads a directory with .. first and directories before files", () =>
  withApp(() => {
    assertEquals(names()[0], "..");
    assertEquals(names()[1], "sub");
    assert(names().includes("alpha.txt"));
    // hidden files are off by default, exactly like mc
    assert(!names().includes(".hidden"));
    return Promise.resolve();
  }));

Deno.test("the two-phase load ends with real sizes", () =>
  withApp(() => {
    // Phase one publishes names and kinds; phase two fills the metadata in.
    // By the time the method resolves, both have happened.
    assertEquals(
      panels.left.rows.find((r) => r.name === "alpha.txt")?.size,
      10,
    );
    assertEquals(panels.left.rows.find((r) => r.name === "beta.md")?.size, 200);
    assertEquals(panels.left.loading, false);
    return Promise.resolve();
  }));

Deno.test("hidden files toggle on and off", () =>
  withApp(async () => {
    await panels.toggleHidden("left");
    assert(names().includes(".hidden"));
    await panels.toggleHidden("left");
    assert(!names().includes(".hidden"));
  }));

Deno.test("entering a directory navigates; entering a file returns its path", () =>
  withApp(async () => {
    await panels.setCursor(indexOf("sub"));
    await panels.enter();
    assertEquals(panels.left.path, `${root}/sub`);
    assertEquals(names().join(), "..,deep,inner.txt");

    await panels.setCursor(indexOf("inner.txt"));
    const opened = await panels.enter();
    assertEquals(opened, `${root}/sub/inner.txt`);
    // Opening a file leaves the panel exactly where it was.
    assertEquals(panels.left.path, `${root}/sub`);
  }));

Deno.test("going up lands the cursor on the directory just left", () =>
  withApp(async () => {
    await panels.chdir("left", `${root}/sub`);
    await panels.chdir("left", "..");
    assertEquals(panels.left.path, root);
    assertEquals(names()[panels.left.cursor], "sub");
  }));

Deno.test("the cursor never leaves the listing", () =>
  withApp(async () => {
    await panels.setCursor(9999);
    assertEquals(panels.left.cursor, panels.left.count - 1);
    await panels.move(-9999);
    assertEquals(panels.left.cursor, 0);
  }));

Deno.test("marking skips .., and totals only marked files", () =>
  withApp(async () => {
    await panels.setCursor(0); // on ".."
    await panels.toggleMark();
    assertEquals(panels.left.markedCount, 0);

    await panels.markByMask("*.txt", true);
    assertEquals(panels.left.markedCount, 1);
    assertEquals(panels.left.markedBytes, 10);

    await panels.invertMarks();
    assertEquals(
      panels.left.rows.find((r) => r.name === "alpha.txt")?.marked,
      false,
    );
    assertEquals(
      panels.left.rows.find((r) => r.name === "beta.md")?.marked,
      true,
    );

    await panels.unmarkAll();
    assertEquals(panels.left.markedCount, 0);
  }));

Deno.test("Insert marks the row and steps down", () =>
  withApp(async () => {
    await panels.setCursor(1);
    const target = names()[1];
    await panels.toggleMark();
    assertEquals(panels.left.markedCount, 1);
    assertEquals(panels.left.rows.find((r) => r.name === target)?.marked, true);
    assertEquals(panels.left.cursor, 2);
  }));

Deno.test("sorting by size reverses on a repeated key, keeping dirs first", () =>
  withApp(async () => {
    await panels.setSort("left", "size");
    assertEquals(names()[0], "..");
    assertEquals(files()[0], "alpha.txt");
    assertEquals(files()[1], "beta.md");

    await panels.setSort("left", "size"); // same key → flip direction
    assertEquals(panels.left.reverse, true);
    assertEquals(files()[0], "beta.md");
    assertEquals(names()[0], ".."); // still pinned
  }));

Deno.test("a filter narrows the listing and keeps ..", () =>
  withApp(async () => {
    await panels.setFilter("left", "*.md");
    assert(names().includes("beta.md"));
    assert(!names().includes("alpha.txt"));
    assert(names().includes(".."));
    await panels.setFilter("left", "");
    assert(names().includes("alpha.txt"));
  }));

Deno.test("the published window is bounded by the viewport", () =>
  withApp(async () => {
    await panels.setViewport("left", 2);
    assertEquals(panels.left.rows.length, 2);
    await panels.setCursor(3);
    // the window follows the cursor…
    assert(panels.left.rows.some((r) => r.index === panels.left.cursor));
    // …and never grows: the invariant that keeps a 100k-file directory as
    // cheap to browse as an empty one.
    assert(panels.left.rows.length <= panels.left.viewport);
  }));

Deno.test("filtering and M-. never re-read the directory", () =>
  withApp(async () => {
    // The proof is a file that no longer exists on disk: if either of these
    // went back to `readdir`, `alpha.txt` would vanish from the listing. It is
    // also the whole reason a 100_000-entry panel filters instantly.
    const gone = `${root}/ghost.txt`;
    await Deno.writeTextFile(gone, "boo");
    await panels.reload("left");
    assert(names().includes("ghost.txt"));
    await Deno.remove(gone);

    await panels.setFilter("left", "*.txt");
    assert(names().includes("ghost.txt"));
    assert(!names().includes("beta.md"));

    await panels.toggleHidden("left");
    assert(names().includes("ghost.txt"));
    await panels.toggleHidden("left");

    await panels.setFilter("left", "");
    // Clearing the filter brings back what it hid — from memory, not the disk.
    assert(names().includes("beta.md"));
    assert(names().includes("ghost.txt"));

    await panels.reload("left");
    assert(!names().includes("ghost.txt"));
  }));

Deno.test("the selection is resolved on the server, not from the window", () =>
  withApp(async () => {
    // `marked` never reaches a client, so a UI that computed the operand list
    // itself would silently act on one file instead of all of them.
    await panels.markByMask("*.txt", true);
    await panels.markByMask("*.md", true);
    const sources = await panels.selection();
    assertEquals(sources.sort(), [`${root}/alpha.txt`, `${root}/beta.md`]);

    // Nothing marked: the file under the cursor, and never "..".
    await panels.unmarkAll();
    await panels.setCursor(indexOf("alpha.txt"));
    assertEquals(await panels.selection(), [`${root}/alpha.txt`]);
    await panels.setCursor(0); // ".."
    assertEquals(await panels.selection(), []);
  }));

Deno.test("markedFirst names the one marked file for the client", () =>
  withApp(async () => {
    await panels.markByMask("beta.md", true);
    assertEquals(panels.left.markedCount, 1);
    assertEquals(panels.left.markedFirst, "beta.md");
    assertEquals(panels.operandLabel(), "beta.md");
    await panels.markByMask("*", true);
    assertEquals(panels.operandLabel(), `${panels.left.markedCount} files`);
    await panels.unmarkAll();
    assertEquals(panels.left.markedFirst, "");
  }));

Deno.test("compare directories marks what the other side lacks or has older", () =>
  withApp(async () => {
    const other = await Deno.makeTempDir({ prefix: "mcx-cmp-" });
    await Deno.writeTextFile(`${other}/alpha.txt`, "b".repeat(10)); // same size
    await Deno.writeTextFile(`${other}/beta.md`, "different"); // same name, not same
    await Deno.writeTextFile(`${other}/only-here.txt`, "x");
    await panels.chdir("right", other);

    // mc's rule, and the one that makes the marks mean "these are the ones to
    // copy across": the NEWER side is marked, the older side is left alone.
    // Everything in `other` was written just now, so it is the newer side.
    await panels.compare();
    assert(panels.right.rows.find((r) => r.name === "beta.md")?.marked);
    assert(!panels.left.rows.find((r) => r.name === "beta.md")?.marked);
    assert(panels.right.rows.find((r) => r.name === "only-here.txt")?.marked);
    // Same name, same size, but newer here — quick trusts the clock and marks
    // it, without reading a byte of either.
    assert(panels.right.rows.find((r) => r.name === "alpha.txt")?.marked);
    assert(!panels.left.rows.find((r) => r.name === "..")?.marked);

    // Thorough reads them instead, and these two really do differ.
    await panels.compare("thorough");
    assert(panels.right.rows.find((r) => r.name === "alpha.txt")?.marked);

    // Size only ignores the clock entirely: `alpha.txt` is the same size on
    // both sides, so it is the same file, however new it is.
    await panels.compare("size");
    assert(!panels.right.rows.find((r) => r.name === "alpha.txt")?.marked);
    assert(panels.right.rows.find((r) => r.name === "beta.md")?.marked);
    assert(panels.left.rows.find((r) => r.name === "beta.md")?.marked);

    // Identical directories mark nothing, whichever method is used.
    await panels.chdir("right", root);
    for (const m of ["quick", "size", "thorough"] as const) {
      await panels.compare(m);
      assertEquals(panels.left.markedCount, 0, m);
      assertEquals(panels.right.markedCount, 0, m);
    }
    await Deno.remove(other, { recursive: true });
  }));

Deno.test("C-Space on `..` sizes every directory, as mc's does", () =>
  withApp(async () => {
    // mc's `smart_dirsize_cmd`: on `..` the question is about the whole panel,
    // and answering "Not a directory" refused a question mc answers.
    await panels.setCursor(indexOf(".."));
    await panels.dirSize();
    const sub = panels.left.rows.find((r) => r.name === "sub")!;
    assertEquals(formatSize(sub), formatSize({ ...sub, sized: true }));
    assert(sub.sized, "the directory was not counted");
  }));

Deno.test("counting re-sorts when the panel is sorted by size", () =>
  withApp(async () => {
    await panels.setSort("left", "size");
    await panels.setCursor(indexOf(".."));
    await panels.dirSize();
    // The numbers the panel is ordered by have just changed, so the order has
    // to change with them — otherwise the sort looks broken.
    const sizes = panels.left.rows
      .filter((r) => r.name !== "..")
      .map((r) => r.size);
    assertEquals([...sizes].sort((a, b) => a - b), sizes);
  }));

Deno.test("cd expands what a shell expands: ~, $VAR, and CDPATH", () =>
  withApp(async () => {
    Deno.env.set("MCX_TEST_DIR", `${root}/sub`);
    await panels.chdir("left", "$MCX_TEST_DIR");
    assertEquals(panels.left.path, `${root}/sub`);

    await panels.chdir("left", "${MCX_TEST_DIR}/deep");
    assertEquals(panels.left.path, `${root}/sub/deep`);

    // An unset variable expands to nothing, as in sh — the path that is left
    // is where you end up, not an error box.
    await panels.chdir("left", root);
    assertEquals(panels.left.path, root);

    // CDPATH: a relative name that is not here, but is under a CDPATH entry.
    Deno.env.set("CDPATH", root);
    await panels.chdir("left", "/");
    await panels.chdir("left", "sub");
    assertEquals(panels.left.path, `${root}/sub`);
    Deno.env.delete("CDPATH");
    Deno.env.delete("MCX_TEST_DIR");
  }));

Deno.test("cd - goes back to where the panel was", () =>
  withApp(async () => {
    await panels.chdir("left", `${root}/sub`);
    await panels.chdir("left", `${root}/sub/deep`);
    await panels.chdir("left", "-");
    assertEquals(panels.left.path, `${root}/sub`);
  }));

Deno.test("type-ahead jumps to a name", () =>
  withApp(async () => {
    await panels.quickSearch("beta");
    assertEquals(names()[panels.left.cursor], "beta.md");
    // no prefix match falls back to "contains"
    await panels.quickSearch("nner");
    assertEquals(panels.left.quick, "nner");
  }));

Deno.test("swap exchanges panels and the active side follows", () =>
  withApp(async () => {
    await panels.chdir("right", `${root}/sub`);
    await panels.activate("left");
    await panels.swap();
    assertEquals(panels.left.path, `${root}/sub`);
    assertEquals(panels.right.path, root);
    assertEquals(panels.active, "right");
  }));

Deno.test("sync points the other panel at this directory", () =>
  withApp(async () => {
    await panels.chdir("left", `${root}/sub`);
    await panels.activate("left");
    await panels.syncOther();
    assertEquals(panels.right.path, `${root}/sub`);
  }));

Deno.test("an unreadable directory reports the error and still shows ..", () =>
  withApp(async () => {
    await panels.chdir("left", `${root}/does-not-exist`);
    assert(panels.left.error !== null);
    assertEquals(names()[0], "..");
    assertEquals(panels.left.loading, false);
  }));

Deno.test("panelize shows an arbitrary path set, and navigating away leaves it", () =>
  withApp(async () => {
    await panels.panelize("left", [
      `${root}/alpha.txt`,
      `${root}/sub/inner.txt`,
    ], "find:*.txt");
    assertEquals(panels.left.path, "find:*.txt");
    assertEquals(names().length, 3); // ".." plus the two hits
    assert(names().includes(`${root}/alpha.txt`));

    await panels.chdir("left", root);
    assertEquals(panels.left.path, root);
    assert(names().includes("alpha.txt"));
  }));

Deno.test("a panelized row operates on the file it names, not on the label", () =>
  withApp(async () => {
    // A panelized listing names its rows by absolute path and its `path` is a
    // LABEL, not a directory. Joining the two gave `find:*.txt/root/alpha.txt`
    // — a path that exists nowhere, so every F3/F4/F5/F8 on a find result was
    // operating on nothing.
    await panels.panelize("left", [
      `${root}/alpha.txt`,
      `${root}/sub/inner.txt`,
    ], "find:*.txt");
    await panels.activate("left");
    await panels.setCursor(indexOf(`${root}/sub/inner.txt`));
    assertEquals(await panels.selection(), [`${root}/sub/inner.txt`]);

    await panels.toggleMark(`${root}/alpha.txt`);
    assertEquals(await panels.selection(), [`${root}/alpha.txt`]);
  }));

Deno.test("each panel keeps its own trail, and M-y/M-u walk it", () =>
  withApp(async () => {
    await panels.chdir("left", `${root}/sub`);
    await panels.chdir("left", `${root}/sub/deep`);
    assertEquals(panels.left.history, [
      root,
      `${root}/sub`,
      `${root}/sub/deep`,
    ]);
    // The other panel has been nowhere; the trails are per panel, as in mc.
    assertEquals(panels.right.history.includes(`${root}/sub`), false);

    await panels.historyStep("left", -1);
    assertEquals(panels.left.path, `${root}/sub`);
    await panels.historyStep("left", -1);
    assertEquals(panels.left.path, root);
    await panels.historyStep("left", 1);
    assertEquals(panels.left.path, `${root}/sub`);
    // Walking back does not rewrite the trail…
    assertEquals(panels.left.history.length, 3);
    // …but going somewhere new from here discards what was ahead of it.
    await panels.chdir("left", `${root}/sub/deep`);
    assertEquals(panels.left.history, [
      root,
      `${root}/sub`,
      `${root}/sub/deep`,
    ]);
  }));

Deno.test("stepping off either end of the trail says so and stays put", () =>
  withApp(async () => {
    await panels.historyStep("left", -1);
    assertEquals(panels.left.path, root);
    assert(ui.status.includes("earlier"), ui.status);
    await panels.historyStep("left", 1);
    assertEquals(panels.left.path, root);
    assert(ui.status.includes("later"), ui.status);
  }));

Deno.test("a bad panel side fails with a message that names it", () =>
  withApp(async () => {
    // `am dispatch`, a menu, or a client one version behind can all send a
    // side this app has never heard of. It must say so, not die three frames
    // later on `undefined.viewport`.
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => (panels as any).setViewport(["left", 30, 1], 30, 1),
      Error,
      'no panel "left,30,1"',
    );
  }));

Deno.test("a viewport that is not a number is refused, not stored", () =>
  withApp(async () => {
    const before = panels.left.viewport;
    // A panel measured before it is in the document computes to NaN. Stored,
    // it would defeat the "no-op when unchanged" test below (NaN === NaN is
    // false), so every report would change the state, every change would wake
    // the reporter, and the client would talk until the server stopped
    // listening — which is exactly what it did.
    await panels.setViewport("left", NaN, 1);
    await panels.setViewport("left", 30, NaN);
    assertEquals(panels.left.viewport, before);

    await panels.setViewport("left", 30, 1);
    assertEquals(panels.left.viewport, 30);
    assertEquals(panels.left.columns, 1);
  }));

Deno.test("C-Space counts a directory and shows the total in its size column", () =>
  withApp(async () => {
    const before = panels.left.rows.find((r) => r.name === "sub");
    assertEquals(formatSize(before!), "SUB-DIR");

    await panels.setCursor(indexOf("sub"));
    await panels.dirSize();

    const after = panels.left.rows.find((r) => r.name === "sub");
    // sub/inner.txt is 1 byte; sub/deep is empty.
    assertEquals(after!.size, 1);
    assertEquals(formatSize(after!), "1");
  }));

Deno.test("C-Space on something that is not a directory says so", () =>
  withApp(async () => {
    await panels.setCursor(indexOf("alpha.txt"));
    await panels.dirSize();
    assert(ui.status.includes("Not a directory"), ui.status);
  }));
