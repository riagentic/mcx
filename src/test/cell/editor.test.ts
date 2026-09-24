// The editor, driven the way a user drives it, asserted against the file that
// ends up on disk.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { editor } from "../../cell/editor.ts";
import { ui } from "../../cell/ui.ts";

async function withFile(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mcx-edit-" });
  const path = `${dir}/file.ts`;
  await Deno.writeTextFile(path, content);
  const h = await bootCells([ui, editor]);
  try {
    await fn(path);
  } finally {
    editor.close();
    h.dispose();
  }
}

Deno.test("opening publishes a window, not the document", () =>
  withFile("a\nb\nc\nd\ne\n", async (path) => {
    await editor.setViewport(3);
    await editor.open(path);
    assertEquals(editor.visible, true);
    assertEquals(editor.rows, ["a", "b", "c"]);
    assertEquals(editor.lineCount, 5);
    assertEquals(editor.modified, false);
  }));

Deno.test("typing inserts at the cursor and marks the buffer modified", () =>
  withFile("hello\n", async (path) => {
    await editor.open(path);
    await editor.moveTo(0, 5);
    await editor.insert(" world");
    assertEquals(editor.rows[0], "hello world");
    assertEquals(editor.modified, true);
    assertEquals(editor.cursor, { line: 0, col: 11 });
  }));

Deno.test("Enter carries the indentation", () =>
  withFile("    indented\n", async (path) => {
    await editor.open(path);
    await editor.lineEdge(true);
    await editor.newline();
    assertEquals(editor.rows[1], "    ");
    assertEquals(editor.cursor, { line: 1, col: 4 });
  }));

Deno.test("backspace joins lines; delete pulls the next line up", () =>
  withFile("ab\ncd\n", async (path) => {
    await editor.open(path);
    await editor.moveTo(1, 0);
    await editor.erase(false);
    assertEquals(editor.rows, ["abcd"]);
    assertEquals(editor.cursor, { line: 0, col: 2 });
  }));

Deno.test("backspace at the very start does nothing and costs no undo", () =>
  withFile("abc\n", async (path) => {
    await editor.open(path);
    await editor.moveTo(0, 0);
    await editor.erase(false);
    assertEquals(editor.rows, ["abc"]);
    await editor.undoEdit();
    assert(ui.status.includes("Nothing to undo"), `status was: ${ui.status}`);
  }));

Deno.test("undo and redo walk the edit history", () =>
  withFile("one\n", async (path) => {
    await editor.open(path);
    await editor.lineEdge(true);
    await editor.insert(" two");
    await editor.insert(" three");
    assertEquals(editor.rows[0], "one two three");

    await editor.undoEdit();
    assertEquals(editor.rows[0], "one two");
    await editor.undoEdit();
    assertEquals(editor.rows[0], "one");
    await editor.redoEdit();
    assertEquals(editor.rows[0], "one two");
  }));

Deno.test("an edit that changes nothing leaves redo reachable", () =>
  withFile("one\n", async (path) => {
    await editor.open(path);
    await editor.lineEdge(true);
    await editor.insert(" two");
    await editor.undoEdit();
    assertEquals(editor.rows[0], "one");

    // Both of these erase nothing. Recording them would clear the redo stack
    // and strand " two" — the edit is still undone, and now unrecoverable.
    await editor.moveTo(0, 0);
    await editor.erase(false);
    await editor.replaceAll("absent", "x");

    await editor.redoEdit();
    assertEquals(editor.rows[0], "one two");
  }));

Deno.test("select, cut and paste move text", () =>
  withFile("hello world\n", async (path) => {
    await editor.open(path);
    await editor.moveTo(0, 0);
    await editor.toggleMark();
    await editor.moveTo(0, 6, true);
    await editor.cutSelection();
    assertEquals(editor.rows[0], "world");

    await editor.lineEdge(true);
    await editor.paste();
    assertEquals(editor.rows[0], "worldhello ");
  }));

/** Mark `from`→`to` on one line and FIX the block, mc-style: F3, walk to the
 *  other end, F3 again. A fixed block survives the cursor walking away from
 *  it, which is what F5 and F6 need. */
async function mark(line: number, from: number, to: number): Promise<void> {
  if (editor.selection()) await editor.toggleMark(); // drop any earlier block
  await editor.moveTo(line, from);
  await editor.toggleMark();
  await editor.moveTo(line, to, true);
  await editor.toggleMark();
}

Deno.test("F6 moves the block to the cursor and leaves the clipboard alone", () =>
  withFile("hello world\n", async (path) => {
    await editor.open(path);
    // Something in the clipboard first: mc's Move must not disturb it.
    await mark(0, 6, 11);
    await editor.copySelection(); // "world"

    // Mark "hello ", put the cursor at the end of the line, move it there.
    await mark(0, 0, 6);
    await editor.lineEdge(true);
    await editor.moveBlock();
    assertEquals(editor.rows[0], "worldhello ");

    // The clipboard still holds what was copied, not what was moved.
    await editor.paste();
    assertEquals(editor.rows[0], "worldhello world");
  }));

Deno.test("F6 refuses to move a block onto itself", () =>
  withFile("hello world\n", async (path) => {
    await editor.open(path);
    await mark(0, 0, 11);
    await editor.moveTo(0, 5); // an unshifted move: the block stays marked
    await editor.moveBlock();
    assertEquals(editor.rows[0], "hello world");
    assert(ui.status.includes("inside"), ui.status);
  }));

Deno.test("a fixed block survives the cursor walking away from it", () =>
  withFile("one\ntwo\nthree\n", async (path) => {
    await editor.open(path);
    await mark(0, 0, 3); // "one", fixed
    // Unshifted movement — in mc the block stays; only a shift-move or a new
    // F3 replaces it. This is what F5/F6 "…to the cursor" are built on.
    await editor.moveTo(2, 5);
    assertEquals(editor.selection(), {
      from: { line: 0, col: 0 },
      to: { line: 0, col: 3 },
      column: false,
      left: 0,
      right: 3,
    });

    // A shift-move starts a fresh selection from where the cursor is.
    await editor.moveTo(2, 0, true);
    assertEquals(editor.selection()?.from, { line: 2, col: 0 });

    // F3 on a block that is not being drawn clears it.
    await editor.toggleMark();
    assertEquals(editor.selection(), null);
  }));

Deno.test("typing over a shift-selection replaces it; a fixed block is safe", () =>
  withFile("hello world\n", async (path) => {
    await editor.open(path);
    // A plain shift-selection: the cursor is at one end of it, so typing
    // replaces it — the modern convention, and no surprise.
    await editor.moveTo(0, 0);
    await editor.moveTo(0, 5, true);
    await editor.insert("X");
    assertEquals(editor.rows[0], "X world");

    // A block fixed with F3 is somewhere else on the screen. mc never types
    // over one, and neither does this: the letter lands at the cursor.
    await editor.undoEdit();
    await mark(0, 0, 5);
    await editor.moveTo(0, 11);
    await editor.insert("!");
    assertEquals(editor.rows[0], "hello world!");
    assert(editor.selection(), "the fixed block was lost to a keystroke");
  }));

Deno.test("F5 copies the block to the cursor, mc's Copy", () =>
  withFile("one\ntwo\n", async (path) => {
    await editor.open(path);
    await mark(0, 0, 3); // "one"
    await editor.moveTo(1, 3); // end of "two"
    await editor.copyBlock();
    assertEquals(editor.rows.slice(0, 2), ["one", "twoone"]);
    // One undo step, and the block is gone afterwards.
    await editor.undoEdit();
    assertEquals(editor.rows.slice(0, 2), ["one", "two"]);
  }));

Deno.test("F8 deletes the block without touching the clipboard", () =>
  withFile("hello world\n", async (path) => {
    await editor.open(path);
    await mark(0, 0, 6);
    await editor.copySelection(); // "hello "

    await mark(0, 6, 11); // "world"
    await editor.deleteBlock();
    assertEquals(editor.rows[0], "hello ");

    // Paste still yields what F5 copied — F8 is a delete, not a cut.
    await editor.paste();
    assertEquals(editor.rows[0], "hello hello ");

    // …and the delete was one undo step.
    await editor.undoEdit();
    await editor.undoEdit();
    assertEquals(editor.rows[0], "hello world");
  }));

Deno.test("the clipboard reaches outside the program when it can", async () => {
  // mc leaves `clipboard_store` unset, so an mc nobody configured can only
  // paste into itself. mcx looks for the usual tools. Where none is installed
  // — a container, a CI box — the editor's own clipboard still answers, and
  // that is what this asserts: the feature is never a failure.
  const io = await import("../../cell/editor.server.ts");
  await io.clipboardStore("mcx-clipboard-probe");
  const back = await io.clipboardPaste();
  assert(
    back === "" || back.trimEnd() === "mcx-clipboard-probe",
    `clipboard round trip gave ${JSON.stringify(back)}`,
  );
});

Deno.test("copy and paste still work with no system clipboard at all", () =>
  withFile("hello world\n", async (path) => {
    await editor.open(path);
    await mark(0, 0, 6);
    await editor.copySelection();
    await editor.lineEdge(true);
    await editor.paste();
    // Either the system clipboard took it and gave it back, or the internal
    // one did — the text arrives either way.
    assertEquals(editor.rows[0], "hello worldhello ");
  }));

Deno.test("deleteLine removes the current line, never the last empty one", () =>
  withFile("a\nb\n", async (path) => {
    await editor.open(path);
    await editor.moveTo(0, 0);
    await editor.deleteLine();
    assertEquals(editor.rows, ["b"]);
    await editor.deleteLine();
    assertEquals(editor.rows, [""]);
    assertEquals(editor.lineCount, 1);
  }));

Deno.test("search moves the cursor and reports failure", () =>
  withFile("alpha\nbeta\ngamma\n", async (path) => {
    await editor.open(path);
    await editor.find("gamma");
    assertEquals(editor.cursor, { line: 2, col: 0 });
    await editor.find("absent");
    assert(ui.status.includes("Not found"), `status was: ${ui.status}`);
  }));

Deno.test("replaceAll reports the count and is a single undo step", () =>
  withFile("x x x\ny x\n", async (path) => {
    await editor.open(path);
    await editor.replaceAll("x", "z");
    assertEquals(editor.rows, ["z z z", "y z"]);
    assert(ui.status.includes("Replaced 4"), `status was: ${ui.status}`);
    await editor.undoEdit();
    assertEquals(editor.rows, ["x x x", "y x"]);
  }));

Deno.test("a replace that matched nothing does not un-modify the buffer", () =>
  withFile("x\n", async (path) => {
    // The buffer has real edits in it; a fruitless search-and-replace saying
    // "nothing changed here" would let Esc discard them without asking.
    await editor.open(path);
    await editor.insert("edited ");
    assertEquals(editor.modified, true);
    await editor.replaceAll("absent", "z");
    assert(ui.status.includes("Not found"), `status was: ${ui.status}`);
    assertEquals(editor.modified, true);
  }));

Deno.test("saving writes the file and clears the modified flag", () =>
  withFile("before\n", async (path) => {
    await editor.open(path);
    await editor.lineEdge(true);
    await editor.insert("!");
    await editor.save();
    assertEquals(await Deno.readTextFile(path), "before!\n");
    assertEquals(editor.modified, false);
  }));

Deno.test("saving preserves the file's permissions", () =>
  withFile("#!/bin/sh\n", async (path) => {
    await Deno.chmod(path, 0o755);
    await editor.open(path);
    await editor.insert("x");
    await editor.save();
    assertEquals(((await Deno.stat(path)).mode ?? 0) & 0o777, 0o755);
  }));

Deno.test("a file without a trailing newline keeps it that way", () =>
  withFile("no newline", async (path) => {
    await editor.open(path);
    await editor.save();
    assertEquals(await Deno.readTextFile(path), "no newline");
  }));

Deno.test("opening a file that does not exist gives an empty buffer", () =>
  withFile("", async (path) => {
    const fresh = `${path}.new`;
    await editor.open(fresh);
    assertEquals(editor.visible, true);
    assertEquals(editor.rows, [""]);
    await editor.insert("created");
    await editor.save();
    assertEquals(await Deno.readTextFile(fresh), "created");
  }));

Deno.test("the window follows the cursor", () =>
  withFile(
    Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
    async (path) => {
      await editor.setViewport(5);
      await editor.open(path);
      await editor.moveTo(50, 0);
      assert(
        editor.top <= 50 && 50 < editor.top + 5,
        `window ${editor.top} misses the cursor`,
      );
      assertEquals(editor.rows.length, 5);
      assertEquals(editor.rows[editor.cursor.line - editor.top], "line 50");
    },
  ));

Deno.test("a directory is refused", () =>
  withFile("", async (path) => {
    await editor.open(path.slice(0, path.lastIndexOf("/")));
    assertEquals(editor.visible, false);
    assert(ui.status.includes("Cannot edit"), `status was: ${ui.status}`);
  }));

Deno.test("M-t sorts the selected block and undo puts it back", () =>
  withFile("c\na\nb\nkeep\n", async (path) => {
    await editor.setViewport(10);
    await editor.open(path);
    await editor.moveTo(0, 0);
    await editor.moveTo(2, 1, true); // select the first three lines
    await editor.transformBlock("sort");
    assertEquals(editor.rows.slice(0, 4), ["a", "b", "c", "keep"]);
    assertEquals(ui.status, "3 lines → 3"); // the block's lines, not an arity
    await editor.undoEdit();
    assertEquals(editor.rows.slice(0, 4), ["c", "a", "b", "keep"]);
  }));

Deno.test("M-p re-wraps a paragraph and keeps its indentation", () =>
  withFile(
    "  one two three four five six seven eight nine ten eleven twelve\n\n",
    async (path) => {
      await editor.setViewport(10);
      await editor.open(path);
      await editor.moveTo(0, 0);
      await editor.moveTo(0, 5, true);
      await editor.transformBlock("format");
      assertEquals(editor.rows[0]!.startsWith("  one"), true);
      // Nothing is lost: the words are all still there, in order.
      assertEquals(
        editor.rows.join(" ").split(/\s+/).filter(Boolean).join(" "),
        "one two three four five six seven eight nine ten eleven twelve",
      );
    },
  ));

Deno.test("M-u runs the block through a command", () =>
  withFile("b\na\nb\n", async (path) => {
    await editor.setViewport(10);
    await editor.open(path);
    await editor.moveTo(0, 0);
    await editor.moveTo(2, 1, true);
    await editor.transformBlock("shell", "sort -u");
    assertEquals(editor.rows, ["a", "b"]);
  }));

Deno.test("a command that fails leaves the block alone and says why", () =>
  withFile("x\n", async (path) => {
    await editor.setViewport(10);
    await editor.open(path);
    await editor.moveTo(0, 0);
    await editor.moveTo(0, 1, true);
    await editor.transformBlock("shell", "exit 3");
    assertEquals(editor.rows, ["x"]);
    assert(
      ui.status.includes("exit 3") || ui.status.includes("exited"),
      ui.status,
    );
  }));

Deno.test("an edit that lands during a save stays unsaved", () =>
  withFile("a\n", async (path) => {
    await editor.setViewport(10);
    await editor.open(path);
    const saving = editor.save();
    await editor.insert("b"); // lands while the write is in flight
    await saving;
    assertEquals(await Deno.readTextFile(path), "a\n");
    assertEquals(editor.modified, true); // "b" is not on disk
  }));
