// Archives browsed as directories — against real tar and zip files.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { fileops } from "../../cell/fileops.ts";
import { panels } from "../../cell/panels.ts";
import { ui } from "../../cell/ui.ts";
import { archiveKind, levelOf } from "../../cell/vfs.server.ts";

const root = await Deno.makeTempDir({ prefix: "mcx-vfs-" });
await Deno.mkdir(`${root}/tree/sub`, { recursive: true });
await Deno.writeTextFile(`${root}/tree/a.txt`, "alpha\n");
await Deno.writeTextFile(`${root}/tree/sub/b.txt`, "beta\n");

const sh = async (cmd: string, args: string[], cwd: string) =>
  await new Deno.Command(cmd, { args, cwd, stdout: "null", stderr: "null" })
    .output();

await sh("tar", ["czf", "arc.tgz", "tree"], root);
const zipped = await sh("zip", ["-qr", "arc.zip", "tree"], root);

/** The panel's PUBLISHED rows — `all` is server-side by design, so a test
 *  reading it through the cell proxy would be testing something no client can
 *  see. */
const names = () => panels.left.rows.map((r) => r.name);
const rowAt = (name: string) => panels.left.rows.find((r) => r.name === name);

async function withApp(fn: () => Promise<void>): Promise<void> {
  const h = await bootCells([panels, ui, fileops]);
  try {
    await fn();
  } finally {
    h.dispose();
  }
}

Deno.test("archiveKind recognises the formats mc handles", () => {
  assertEquals(archiveKind("x.tar"), "tar");
  assertEquals(archiveKind("x.tar.gz"), "tar");
  assertEquals(archiveKind("x.TGZ"), "tar");
  assertEquals(archiveKind("x.tar.xz"), "tar");
  assertEquals(archiveKind("x.zip"), "zip");
  assertEquals(archiveKind("x.jar"), "zip");
  assertEquals(archiveKind("x.txt"), null);
  assertEquals(archiveKind("tarball"), null);
});

Deno.test("levelOf collapses a flat archive to one directory level", () => {
  const flat = [
    { path: "tree", size: 0, mtime: 0, mode: 0o755, dir: true },
    { path: "tree/a.txt", size: 6, mtime: 0, mode: 0o644, dir: false },
    { path: "tree/sub/b.txt", size: 5, mtime: 0, mode: 0o644, dir: false },
  ];
  assertEquals(levelOf(flat, "").map((e) => e.name), ["tree"]);
  const inner = levelOf(flat, "tree");
  assertEquals(inner.map((e) => e.name).sort(), ["a.txt", "sub"]);
  // `sub` was never an entry of its own — it is synthesised as a directory.
  assertEquals(inner.find((e) => e.name === "sub")?.kind, "dir");
  assertEquals(inner.find((e) => e.name === "a.txt")?.size, 6);
});

Deno.test("entering a tarball lists it like a directory", () =>
  withApp(async () => {
    await panels.chdir("left", root);
    await panels.setCursor(names().indexOf("arc.tgz"));
    await panels.enter();

    assert(
      panels.left.path.includes("arc.tgz#"),
      `path was ${panels.left.path}`,
    );
    assertEquals(names(), ["..", "tree"]);

    await panels.setCursor(1);
    await panels.enter();
    assertEquals(names().sort(), ["..", "a.txt", "sub"]);
    assertEquals(rowAt("a.txt")?.size, 6);
  }));

Deno.test("`..` walks back out of an archive onto the archive file", () =>
  withApp(async () => {
    await panels.chdir("left", root);
    await panels.setCursor(names().indexOf("arc.tgz"));
    await panels.enter();
    await panels.setCursor(1); // "tree"
    await panels.enter();

    await panels.vfsChdir("left", "..");
    assertEquals(names(), ["..", "tree"]);

    await panels.vfsChdir("left", "..");
    assertEquals(panels.left.path, root);
    assertEquals(rowAt("arc.tgz")?.index, panels.left.cursor);
  }));

Deno.test("a member extracts to a real file", () =>
  withApp(async () => {
    await panels.chdir("left", root);
    await panels.setCursor(names().indexOf("arc.tgz"));
    await panels.enter();
    await panels.setCursor(1);
    await panels.enter(); // inside tree/
    await panels.setCursor(names().indexOf("a.txt"));

    const tmp = await panels.extractCurrent();
    assert(tmp, "extractCurrent returned nothing");
    assertEquals(await Deno.readTextFile(tmp!), "alpha\n");
  }));

Deno.test("copying out of an archive lands the file, not the path inside it", () =>
  withApp(async () => {
    const dest = await Deno.makeTempDir({ prefix: "mcx-out-" });
    await panels.chdir("left", root);
    await panels.setCursor(names().indexOf("arc.tgz"));
    await panels.enter();
    await panels.setCursor(1);
    await panels.enter();
    await panels.setCursor(names().indexOf("a.txt"));

    // What comes out is what the panel is showing — `a.txt`, not the archive's
    // own `tree/a.txt`. mc copies the file you selected; recreating the path
    // inside the archive is the archive's business, not the destination's.
    const staged = await panels.stageExtract();
    assertEquals(staged.failed, 0);
    await fileops.run("copy", staged.paths, dest);
    assertEquals(await Deno.readTextFile(`${dest}/a.txt`), "alpha\n");
    await Deno.remove(dest, { recursive: true });
  }));

Deno.test("copying a DIRECTORY out of a zip brings what is under it", {
  ignore: !zipped.success,
}, () =>
  withApp(async () => {
    // The bug this pins: `unzip` reads a member name as a glob, so asking it
    // for `tree` matched the one empty directory entry — or, in a zip with no
    // entry for the directory at all, nothing — and F5 on a folder extracted
    // zero files and reported success.
    const dest = await Deno.makeTempDir({ prefix: "mcx-zipdir-" });
    await panels.chdir("left", root);
    await panels.setCursor(names().indexOf("arc.zip"));
    await panels.enter();
    await panels.setCursor(names().indexOf("tree"));

    const staged = await panels.stageExtract();
    assertEquals(staged.failed, 0);
    await fileops.run("copy", staged.paths, dest);
    assertEquals(await Deno.readTextFile(`${dest}/tree/a.txt`), "alpha\n");
    assertEquals(await Deno.readTextFile(`${dest}/tree/sub/b.txt`), "beta\n");
    await Deno.remove(dest, { recursive: true });
  }));

Deno.test("extracting onto a file that exists asks first", () =>
  withApp(async () => {
    const dest = await Deno.makeTempDir({ prefix: "mcx-clash-" });
    await Deno.writeTextFile(`${dest}/a.txt`, "MINE");
    await panels.chdir("left", root);
    await panels.setCursor(names().indexOf("arc.tgz"));
    await panels.enter();
    await panels.setCursor(1);
    await panels.enter();
    await panels.setCursor(names().indexOf("a.txt"));

    const staged = await panels.stageExtract();
    const running = fileops.run("copy", staged.paths, dest);
    // The ordinary overwrite question — which a direct `unzip -o` into the
    // destination never asked, and which is the whole reason extraction goes
    // through the copy engine.
    for (let i = 0; i < 600 && !fileops.frontJob()?.question; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assertEquals(fileops.frontJob()?.question?.dst, `${dest}/a.txt`);
    await fileops.answerQuestion("skip");
    await running;
    assertEquals(await Deno.readTextFile(`${dest}/a.txt`), "MINE");
    await Deno.remove(dest, { recursive: true });
  }));

Deno.test("zip archives browse the same way", {
  ignore: !zipped.success,
}, () =>
  withApp(async () => {
    await panels.chdir("left", root);
    await panels.setCursor(names().indexOf("arc.zip"));
    await panels.enter();
    assertEquals(names(), ["..", "tree"]);
    await panels.setCursor(1);
    await panels.enter();
    assertEquals(names().sort(), ["..", "a.txt", "sub"]);
  }));

Deno.test("`inArchive` is the fact, not the `#` in the path", () =>
  withApp(async () => {
    // `#` is a legal character in a directory name. The client decides between
    // "copy" and "extract" from this flag, and inferring it from the composed
    // path made F3 and F5 silently do nothing in a directory called `c#1`.
    const hashed = `${root}/c#1`;
    await Deno.mkdir(hashed, { recursive: true });
    await panels.chdir("left", hashed);
    assertEquals(panels.left.inArchive, false);

    await panels.chdir("left", root);
    await panels.setCursor(names().indexOf("arc.tgz"));
    await panels.enter();
    assertEquals(panels.left.inArchive, true);

    await panels.vfsChdir("left", "..");
    assertEquals(panels.left.inArchive, false);
  }));

Deno.test("a corrupt archive reports an error instead of an empty panel", () =>
  withApp(async () => {
    await Deno.writeTextFile(`${root}/broken.tgz`, "not actually a tarball");
    await panels.chdir("left", root);
    await panels.reload("left");
    await panels.setCursor(names().indexOf("broken.tgz"));
    await panels.enter();
    assert(
      panels.left.error !== null,
      "a corrupt archive must report an error",
    );
    assertEquals(names(), [".."]);
  }));
