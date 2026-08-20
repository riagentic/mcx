// Find file (M-?) against a real tree, because a search is only as good as the
// filesystem it is told about.
//
// The switches are the interesting part: mc's find dialog is a mask, a grep and
// seven checkboxes, and every one of them changes which files come back. A test
// per switch is what stops "Skip hidden" quietly meaning nothing.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { find } from "../../cell/find.ts";
import { panels } from "../../cell/panels.ts";
import { ui } from "../../cell/ui.ts";

const root = await Deno.makeTempDir({ prefix: "mcx-find-" });
await Deno.mkdir(`${root}/sub/deep`, { recursive: true });
await Deno.mkdir(`${root}/.git`);
await Deno.writeTextFile(`${root}/top.txt`, "alpha\nbeta\nalpha again\n");
await Deno.writeTextFile(`${root}/sub/inner.txt`, "ALPHA in a subdirectory\n");
await Deno.writeTextFile(`${root}/sub/deep/deep.txt`, "nothing here\n");
await Deno.writeTextFile(`${root}/.hidden.txt`, "alpha hidden\n");
await Deno.writeTextFile(`${root}/.git/config`, "alpha in git\n");
await Deno.writeTextFile(`${root}/words.txt`, "alphabet\nalpha\n");

const names = () => find.hits.map((h) => h.path.slice(root.length + 1)).sort();

/** The switches a test did not name stay at their defaults. */
const DEFAULTS = {
  recursive: true,
  followSymlinks: false,
  skipHidden: true,
  nameCase: false,
  contentCase: false,
  wholeWords: false,
  firstHit: false,
};

async function withApp(fn: () => Promise<void>): Promise<void> {
  const h = await bootCells([panels, ui, find]);
  try {
    for (const [k, v] of Object.entries(DEFAULTS)) find.setOption(k, v);
    await fn();
  } finally {
    h.dispose();
  }
}

Deno.test("a mask finds files by name, through the whole tree", () =>
  withApp(async () => {
    await find.start(root, "*.txt", "");
    assertEquals(names(), [
      "sub/deep/deep.txt",
      "sub/inner.txt",
      "top.txt",
      "words.txt",
    ]);
  }));

Deno.test("hidden files and hidden directories are skipped unless asked for", () =>
  withApp(async () => {
    await find.start(root, "*", "");
    assert(!names().includes(".hidden.txt"));
    assert(!names().some((n) => n.startsWith(".git/")));

    find.setOption("skipHidden", false);
    await find.start(root, "*", "");
    assert(names().includes(".hidden.txt"));
    assert(names().includes(".git/config"));
  }));

Deno.test("recursion is a switch, and turning it off searches one directory", () =>
  withApp(async () => {
    find.setOption("recursive", false);
    await find.start(root, "*.txt", "");
    assertEquals(names(), ["top.txt", "words.txt"]);
  }));

Deno.test("content search reports EVERY matching line, not just the first", () =>
  withApp(async () => {
    // mc lists each hit; "First hit" is the switch that asks for one per file.
    await find.start(root, "top.txt", "alpha");
    assertEquals(find.hits.map((h) => h.line), [1, 3]);
    assertEquals(find.hits[0]!.text, "alpha");
    assertEquals(find.hits[1]!.text, "alpha again");

    find.setOption("firstHit", true);
    await find.start(root, "top.txt", "alpha");
    assertEquals(find.hits.map((h) => h.line), [1]);
  }));

Deno.test("content case folds by default and stops folding on request", () =>
  withApp(async () => {
    await find.start(root, "inner.txt", "alpha");
    assertEquals(names(), ["sub/inner.txt"]);

    find.setOption("contentCase", true);
    await find.start(root, "inner.txt", "alpha");
    assertEquals(names(), []);
    await find.start(root, "inner.txt", "ALPHA");
    assertEquals(names(), ["sub/inner.txt"]);
  }));

Deno.test("whole words rejects a match inside a longer word", () =>
  withApp(async () => {
    await find.start(root, "words.txt", "alpha");
    assertEquals(find.hits.map((h) => h.text), ["alphabet", "alpha"]);

    find.setOption("wholeWords", true);
    await find.start(root, "words.txt", "alpha");
    assertEquals(find.hits.map((h) => h.text), ["alpha"]);
  }));

Deno.test("the mask folds case unless the switch says otherwise", () =>
  withApp(async () => {
    await find.start(root, "TOP.TXT", "");
    assertEquals(names(), ["top.txt"]);

    find.setOption("nameCase", true);
    await find.start(root, "TOP.TXT", "");
    assertEquals(names(), []);
  }));

Deno.test("panelize turns the results into a panel", () =>
  withApp(async () => {
    await find.start(root, "*.txt", "");
    await find.panelize();
    assertEquals(find.visible, false);
    assert(panels.activePanel().path.startsWith("find:"));
    // Panelized rows name themselves by full path, which is what makes a flat
    // list of four `*.txt` from three directories readable — plus the `..`
    // that is how you leave a panelized listing.
    assertEquals(panels.activePanel().count, 5);
  }));

Deno.test("Enter on a hit takes the panel to it", () =>
  withApp(async () => {
    await find.start(root, "inner.txt", "");
    await find.goto(0);
    assertEquals(find.visible, false);
    assertEquals(panels.activePanel().path, `${root}/sub`);
    const cur = panels.current();
    assertEquals(cur?.name, "inner.txt");
  }));
