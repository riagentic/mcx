// The tree panel against a real directory tree.
//
// Assertions read `rows` — the window the client is given — for the same
// reason the panel tests do: the flattened tree stays on the server, so a test
// that read `nodes` would be testing something no client can see.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { tree } from "../../cell/tree.ts";

const root = await Deno.makeTempDir({ prefix: "mcx-tree-" });
await Deno.mkdir(`${root}/alpha/one`, { recursive: true });
await Deno.mkdir(`${root}/alpha/two`, { recursive: true });
await Deno.mkdir(`${root}/beta`, { recursive: true });
await Deno.mkdir(`${root}/.hidden`, { recursive: true });
await Deno.writeTextFile(`${root}/not-a-dir.txt`, "x");

const names = () => tree.rows.map((r) => r.name);
const paths = () => tree.rows.map((r) => r.path);

async function withTree(fn: () => Promise<void>): Promise<void> {
  const h = await bootCells([tree]);
  try {
    await tree.setRoot(root);
    await fn();
  } finally {
    h.dispose();
  }
}

Deno.test("the root opens showing its subdirectories, and only those", () =>
  withTree(() => {
    assertEquals(names()[0], root);
    assert(names().includes("alpha"));
    assert(names().includes("beta"));
    // Files are not part of a directory tree, and dotfiles follow mc's default.
    assert(!names().includes("not-a-dir.txt"));
    assert(!names().includes(".hidden"));
    return Promise.resolve();
  }));

Deno.test("a branch opens and closes, and the rows follow", () =>
  withTree(async () => {
    assert(!names().includes("one"));
    await tree.expand(`${root}/alpha`);
    assertEquals(names().slice(1), ["alpha", "one", "two", "beta"]);
    assertEquals(tree.rows[1]?.open, true);
    assertEquals(tree.rows[2]?.depth, 2);

    await tree.collapse(`${root}/alpha`);
    assert(!names().includes("one"));
    // A leaf says so, so the UI can leave the twisty off.
    await tree.expand(`${root}/beta`);
    assertEquals(tree.rows.find((r) => r.name === "beta")?.branch, false);
  }));

Deno.test("revealing a directory opens every ancestor and lands on it", () =>
  withTree(async () => {
    await tree.reveal(`${root}/alpha/two`);
    assertEquals(tree.selected(), `${root}/alpha/two`);
    assert(paths().includes(`${root}/alpha`));
    // Revealing does not unfold what it landed on.
    assertEquals(
      tree.rows.find((r) => r.path === `${root}/alpha/two`)?.open,
      false,
    );
  }));

Deno.test("revealing a path outside the root changes nothing", () =>
  withTree(async () => {
    // `${root}x` shares every character of the root without being under it.
    // A plain prefix test walked its parents as if they were tree rows and
    // left them in `expanded`, which is persisted.
    const sibling = `${root}x/inside`;
    await Deno.mkdir(sibling, { recursive: true });
    const before = paths().join();
    await tree.reveal(sibling);
    assertEquals(paths().join(), before);
    await Deno.remove(`${root}x`, { recursive: true });
  }));

Deno.test("the published window is bounded by the viewport", () =>
  withTree(async () => {
    await tree.expand(`${root}/alpha`);
    await tree.setViewport(2);
    assertEquals(tree.rows.length, 2);
    await tree.setCursor(3);
    assert(tree.rows.some((r) => r.index === tree.cursor));
    assert(tree.rows.length <= tree.viewport);
  }));

Deno.test("the cursor never leaves the tree", () =>
  withTree(async () => {
    await tree.setCursor(9999);
    assertEquals(tree.cursor, tree.count - 1);
    await tree.move(-9999);
    assertEquals(tree.cursor, 0);
  }));

Deno.test("hidden directories appear only when asked for", () =>
  withTree(async () => {
    await tree.setShowHidden(true);
    assert(names().includes(".hidden"));
    await tree.setShowHidden(false);
    assert(!names().includes(".hidden"));
  }));
