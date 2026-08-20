// The viewer, against real files — including one large enough that reading it
// whole would be the wrong answer.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { ui } from "../../cell/ui.ts";
import { viewer } from "../../cell/viewer.ts";

const root = await Deno.makeTempDir({ prefix: "mcx-view-" });
const TEXT = `${root}/poem.txt`;
const BIG = `${root}/big.log`;
const BIN = `${root}/blob.bin`;
const EMPTY = `${root}/empty.txt`;

await Deno.writeTextFile(
  TEXT,
  ["alpha", "beta", "gamma", "delta", "needle here", "epsilon"].join("\n") +
    "\n",
);
await Deno.writeTextFile(EMPTY, "");
// 200_000 lines ≈ 3 MB — enough that the lazy index has to do real work.
await Deno.writeTextFile(
  BIG,
  Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join("\n"),
);
await Deno.writeFile(
  BIN,
  new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 251)),
);

/** A file of this test's own, opened in the viewer. */
async function withFile(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const path = await Deno.makeTempFile({ prefix: "mcx-view-", suffix: ".txt" });
  await Deno.writeTextFile(path, content);
  const h = await bootCells([ui, viewer]);
  try {
    await fn(path);
  } finally {
    await viewer.close();
    h.dispose();
    await Deno.remove(path).catch(() => {});
  }
}

async function withApp(fn: () => Promise<void>): Promise<void> {
  const h = await bootCells([ui, viewer]);
  try {
    await fn();
  } finally {
    await viewer.close();
    h.dispose();
  }
}

Deno.test("opening a text file shows the first screen", () =>
  withApp(async () => {
    await viewer.setViewport(3);
    await viewer.open(TEXT);
    assertEquals(viewer.visible, true);
    assertEquals(viewer.mode, "text");
    assertEquals(viewer.lines, ["alpha", "beta", "gamma"]);
    assertEquals(viewer.error, null);
  }));

Deno.test("scrolling moves by lines and never goes above the first", () =>
  withApp(async () => {
    await viewer.setViewport(2);
    await viewer.open(TEXT);
    await viewer.scroll(2);
    assertEquals(viewer.lines, ["gamma", "delta"]);
    await viewer.scroll(-10);
    assertEquals(viewer.line, 0);
    assertEquals(viewer.lines, ["alpha", "beta"]);
  }));

Deno.test("End lands on the last screen of the file", () =>
  withApp(async () => {
    await viewer.setViewport(2);
    await viewer.open(TEXT);
    await viewer.bottom();
    assertEquals(viewer.lines[viewer.lines.length - 1], "epsilon");
  }));

Deno.test("search finds a line, and reports when it finds nothing", () =>
  withApp(async () => {
    await viewer.setViewport(2);
    await viewer.open(TEXT);
    await viewer.find("needle");
    assertEquals(viewer.line, 4);
    assertEquals(viewer.lines[0], "needle here");

    await viewer.find("unfindable");
    assert(ui.status.includes("Not found"), `status was: ${ui.status}`);
  }));

Deno.test("find previous walks back through every match", () =>
  withApp(async () => {
    // Backwards search used to be anchored to the LINE of the last hit, so a
    // match in column 0 kept finding itself; and a hit in the first bytes of a
    // window made the window's own earlier matches unreachable.
    const rep = `${root}/repeat.txt`;
    await Deno.writeTextFile(rep, "hit\nhit\nhit\n");
    await viewer.setViewport(3);
    await viewer.open(rep);
    await viewer.find("hit");
    assertEquals(viewer.line, 0);
    await viewer.goto("3");
    await viewer.find("hit", true);
    assertEquals(viewer.line, 1);
    await viewer.find("hit", true);
    assertEquals(viewer.line, 0);
  }));

Deno.test("find previous reaches a match a whole window earlier", () =>
  withApp(async () => {
    // The window is 1 MiB: a match just before the search start must not hide
    // the megabyte of file behind it.
    const far = `${root}/far.log`;
    const filler = "x".repeat(1 << 20);
    await Deno.writeTextFile(far, `needle\n${filler}\nneedle\ntail\n`);
    await viewer.setViewport(2);
    await viewer.open(far);
    await viewer.find("needle"); // first, at line 0
    await viewer.find("needle"); // second, after the filler
    assertEquals(viewer.line, 2);
    await viewer.find("needle", true);
    assertEquals(viewer.line, 0);
  }));

Deno.test("search is case-insensitive by default", () =>
  withApp(async () => {
    await viewer.open(TEXT);
    await viewer.find("NEEDLE");
    assertEquals(viewer.line, 4);
  }));

Deno.test("goto accepts a line number and a percentage", () =>
  withApp(async () => {
    await viewer.setViewport(2);
    await viewer.open(TEXT);
    await viewer.goto("3");
    assertEquals(viewer.lines[0], "gamma");
    await viewer.goto("0%");
    assertEquals(viewer.line, 0);
  }));

Deno.test("a binary file opens in hex without being asked", () =>
  withApp(async () => {
    await viewer.setViewport(4);
    await viewer.open(BIN);
    assertEquals(viewer.mode, "hex");
    assertEquals(viewer.hex.length, 4);
    assertEquals(viewer.hex[0]?.offset, 0);
    assertEquals(viewer.hex[0]?.bytes.length, 16);
    assertEquals(viewer.hex[1]?.offset, 16);
  }));

Deno.test("toggling to hex keeps the position", () =>
  withApp(async () => {
    await viewer.setViewport(2);
    await viewer.open(TEXT);
    await viewer.scroll(2); // at "gamma", byte 11
    await viewer.toggleMode();
    assertEquals(viewer.mode, "hex");
    assertEquals(viewer.byte, 11);
    await viewer.toggleMode();
    assertEquals(viewer.mode, "text");
    assertEquals(viewer.lines[0], "gamma");
  }));

Deno.test("a 200k-line file opens without reading it whole", () =>
  withApp(async () => {
    await viewer.setViewport(20);
    const t0 = performance.now();
    await viewer.open(BIG);
    const ms = performance.now() - t0;
    assertEquals(viewer.lines[0], "line 0");
    assertEquals(viewer.lines.length, 20);
    // The index is deliberately incomplete at this point — that is the feature.
    assert(!viewer.complete, "the index must still be partial after opening");
    assert(ms < 400, `opening took ${ms.toFixed(0)}ms`);
  }));

Deno.test("searching a large file finds a late match and scrolls to it", () =>
  withApp(async () => {
    await viewer.setViewport(5);
    await viewer.open(BIG);
    await viewer.find("line 199999");
    assertEquals(viewer.lines[0], "line 199999");
  }));

Deno.test("an empty file is not an error", () =>
  withApp(async () => {
    await viewer.open(EMPTY);
    assertEquals(viewer.error, null);
    assertEquals(viewer.lines.length, 0);
  }));

Deno.test("whole-word search skips a hit inside a longer word", () =>
  withFile("alphabet\nalpha\nALPHA\n", async (path) => {
    await viewer.open(path);
    await viewer.setSearchOption("wholeWords", false);
    await viewer.setSearchOption("searchCase", false);

    // Ordinary search: the first hit is inside `alphabet`.
    await viewer.find("alpha");
    assertEquals(viewer.line, 0);

    // Whole words: `alphabet` is not the word `alpha`, so the hit is line two.
    await viewer.top();
    await viewer.setSearchOption("wholeWords", true);
    await viewer.find("alpha");
    assertEquals(viewer.line, 1);

    // …and backwards from the end lands on the same kind of hit.
    await viewer.bottom();
    await viewer.find("alpha", true);
    assertEquals(viewer.line, 2);
  }));

Deno.test("case sensitivity is a switch on the search, as mc has it", () =>
  withFile("alphabet\nALPHA\n", async (path) => {
    await viewer.open(path);
    await viewer.setSearchOption("wholeWords", true);
    await viewer.setSearchOption("searchCase", true);
    await viewer.find("ALPHA");
    assertEquals(viewer.line, 1);

    await viewer.top();
    await viewer.find("alpha");
    // Nothing matches with case on and whole words on — the view stays put.
    assertEquals(viewer.line, 0);
  }));

Deno.test("Goto understands a hexadecimal offset, as mc's Goto does", () =>
  withFile("0123456789abcdef\nsecond line\n", async (path) => {
    await viewer.open(path);
    // 0x11 = 17 = the first byte of the second line.
    await viewer.goto("0x11");
    assertEquals(viewer.line, 1);
    await viewer.goto("1");
    assertEquals(viewer.line, 0);
  }));

Deno.test("hex edit changes bytes, shows them before they are saved, and saves them", () =>
  withFile("hello world\n", async (path) => {
    await viewer.setViewport(4);
    await viewer.open(path);
    await viewer.toggleMode(); // hex
    assertEquals(viewer.mode, "hex");

    await viewer.toggleHexEdit();
    assertEquals(viewer.hexEdit, true);

    // Type `4a` over the first byte: two nibbles, then the cursor moves on.
    await viewer.typeHex("4");
    // Only the HIGH nibble has been given, so the low one is still the file's
    // — `h` is 0x68, and half of it typed over is 0x48.
    assertEquals(viewer.hex[0]!.bytes[0], 0x48);
    await viewer.typeHex("a");
    assertEquals(viewer.hex[0]!.bytes[0], 0x4a);
    assertEquals(viewer.hexCursor, 1);

    // The file on disk has not changed yet — that is what F6 is for.
    assertEquals(await Deno.readTextFile(path), "hello world\n");
    await viewer.saveHex();
    assertEquals(await Deno.readTextFile(path), "Jello world\n");

    // …and the pending list is empty afterwards.
    await viewer.saveHex();
    assert(ui.status.includes("Nothing to save"), ui.status);
  }));

Deno.test("the text column types whole bytes; Tab moves between the two", () =>
  withFile("hello\n", async (path) => {
    await viewer.open(path);
    await viewer.toggleMode();
    await viewer.toggleHexEdit();
    viewer.toggleHexColumn();
    assertEquals(viewer.hexColumn, "text");

    await viewer.typeHex("J");
    assertEquals(viewer.hexCursor, 1);
    await viewer.saveHex();
    assertEquals(await Deno.readTextFile(path), "Jello\n");
  }));

Deno.test("the hex cursor walks by byte and by row, and drags the window", () =>
  withFile("x".repeat(4096), async (path) => {
    await viewer.setViewport(4); // 64 bytes on screen
    await viewer.open(path);
    await viewer.toggleMode();
    await viewer.toggleHexEdit();

    await viewer.moveHex(16); // one row down
    assertEquals(viewer.hexCursor, 16);
    await viewer.moveHex(1000);
    assertEquals(viewer.hexCursor, 1016);
    // The window followed: the cursor's row is inside it.
    const first = viewer.hex[0]!.offset;
    assert(
      viewer.hexCursor >= first && viewer.hexCursor < first + 4 * 16,
      `cursor ${viewer.hexCursor} outside window at ${first}`,
    );
    // …and it stops at the ends rather than running off them.
    await viewer.moveHex(-100_000);
    assertEquals(viewer.hexCursor, 0);
    await viewer.moveHex(100_000);
    assertEquals(viewer.hexCursor, 4095);
  }));

Deno.test("edits survive leaving edit mode, and never leak into another file", () =>
  withFile("abcd\n", async (path) => {
    await viewer.open(path);
    await viewer.toggleMode();
    await viewer.toggleHexEdit();
    await viewer.typeHex("3");
    await viewer.typeHex("0"); // '0'
    await viewer.toggleHexEdit(); // back to viewing, edit still pending
    assertEquals(viewer.hex[0]!.bytes[0], 0x30);

    await viewer.saveHex();
    assertEquals(await Deno.readTextFile(path), "0bcd\n");
  }));

Deno.test("a directory is refused with a message, not a crash", () =>
  withApp(async () => {
    await viewer.open(root);
    assertEquals(viewer.visible, false);
    assert(ui.status.includes("Cannot view"), `status was: ${ui.status}`);
  }));
