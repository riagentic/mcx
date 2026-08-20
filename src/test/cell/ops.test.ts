// The single-file operations, against real files.
//
// Ownership is the one thing here a test cannot freely change: only root may
// give a file away. So `chown` is tested for the half that is always
// exercisable — parsing mc's `user:group` spelling, and reporting rather than
// throwing when the kernel says no.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { ops } from "../../cell/ops.ts";
import { panels } from "../../cell/panels.ts";
import { ui } from "../../cell/ui.ts";
import { parseOwner } from "../../cell/ops.server.ts";

async function withApp(fn: (root: string) => Promise<void>): Promise<void> {
  const h = await bootCells([panels, ui, ops]);
  const root = await Deno.makeTempDir({ prefix: "mcx-ops-" });
  await Deno.writeTextFile(`${root}/a.txt`, "a");
  await Deno.writeTextFile(`${root}/b.txt`, "b");
  try {
    await panels.chdir("left", root);
    await fn(root);
  } finally {
    h.dispose();
    await Deno.remove(root, { recursive: true });
  }
}

const mode = async (p: string) => ((await Deno.stat(p)).mode ?? 0) & 0o7777;

Deno.test("mkdir creates parents too", () =>
  withApp(async (root) => {
    await ops.mkdir("deep/er/still");
    assert((await Deno.stat(`${root}/deep/er/still`)).isDirectory);
  }));

Deno.test("chmod applies to every selected file, not just the first", () =>
  withApp(async (root) => {
    await ops.chmod([`${root}/a.txt`, `${root}/b.txt`], "600");
    assertEquals(await mode(`${root}/a.txt`), 0o600);
    assertEquals(await mode(`${root}/b.txt`), 0o600);
  }));

Deno.test("chmod refuses something that is not an octal mode", () =>
  withApp(async (root) => {
    const before = await mode(`${root}/a.txt`);
    await ops.chmod([`${root}/a.txt`], "rwxr");
    assert(ops.error?.includes("not an octal mode"), `error: ${ops.error}`);
    assertEquals(await mode(`${root}/a.txt`), before);
  }));

Deno.test("chmod keeps going after a failure and names the first one", () =>
  withApp(async (root) => {
    await ops.chmod([`${root}/gone.txt`, `${root}/b.txt`], "700");
    assertEquals(await mode(`${root}/b.txt`), 0o700);
    assert(ui.status.includes("1 of 2"), `status was: ${ui.status}`);
  }));

Deno.test("chown parses mc's user:group spelling", async () => {
  const me = Deno.uid() ?? 0;
  // Numeric ids pass straight through; a bare name is looked up.
  assertEquals((await parseOwner(`${me}:`)).owner, { uid: me, gid: null });
  assertEquals((await parseOwner(":0")).owner, { uid: null, gid: 0 });
  assertEquals((await parseOwner("0:0")).owner, { uid: 0, gid: 0 });
  assertEquals((await parseOwner("root")).owner.uid, 0);
  assertEquals(
    (await parseOwner("definitely-no-such-user")).error,
    "no such user: definitely-no-such-user",
  );
  assertEquals((await parseOwner("")).error, "nothing to change");
});

Deno.test("chown to your own ownership succeeds and says so", () =>
  withApp(async (root) => {
    const me = `${Deno.uid() ?? 0}:${Deno.gid() ?? 0}`;
    await ops.chown([`${root}/a.txt`], me);
    assertEquals(ops.error, null);
    assert(ui.status.startsWith("Chown: 1 file"), `status was: ${ui.status}`);
  }));

Deno.test("chown reports a bad user instead of throwing", () =>
  withApp(async (root) => {
    await ops.chown([`${root}/a.txt`], "definitely-no-such-user");
    assert(ops.error?.includes("no such user"), `error: ${ops.error}`);
  }));

Deno.test("rename with a slash in it is a move, as it is in a shell", () =>
  withApp(async (root) => {
    await Deno.mkdir(`${root}/sub`);
    await ops.rename(`${root}/a.txt`, `${root}/sub/moved.txt`);
    assertEquals(await Deno.readTextFile(`${root}/sub/moved.txt`), "a");
  }));

Deno.test("symlink and hard link both land in the active panel", () =>
  withApp(async (root) => {
    await ops.link(`${root}/a.txt`, "soft", false);
    assertEquals(await Deno.readLink(`${root}/soft`), `${root}/a.txt`);
    await ops.link(`${root}/a.txt`, "hard", true);
    assertEquals((await Deno.stat(`${root}/hard`)).nlink, 2);
  }));

Deno.test("Esc closes an open pulldown, not only a dialog", async () => {
  const h = await bootCells([ui]);
  try {
    ui.openMenu("left");
    assertEquals(ui.menu, "left");
    // `dialog.cancel` is Esc, and in mc Esc always gets you back to the files.
    ui.close();
    assertEquals(ui.menu, null);
    assertEquals(ui.dialog, null);
  } finally {
    h.dispose();
  }
});

Deno.test("C-x v writes a symlink whose target is relative to it", () =>
  withApp(async (root) => {
    await Deno.mkdir(`${root}/sub`);
    await panels.chdir("left", `${root}/sub`);
    // The link lands in sub/, pointing at a file one level up.
    await ops.link(`${root}/a.txt`, "rel.txt", false, true);
    assertEquals(await Deno.readLink(`${root}/sub/rel.txt`), "../a.txt");
    // …and it resolves: relative is only useful if it actually points there.
    assertEquals(await Deno.readTextFile(`${root}/sub/rel.txt`), "a");
  }));

Deno.test("C-x C-s points an existing symlink somewhere else", () =>
  withApp(async (root) => {
    await Deno.symlink(`${root}/a.txt`, `${root}/link`);
    await panels.chdir("left", root);
    await ops.retarget("link", `${root}/b.txt`);
    assertEquals(await Deno.readLink(`${root}/link`), `${root}/b.txt`);
    assertEquals(await Deno.readTextFile(`${root}/link`), "b");
  }));

Deno.test("retargeting refuses anything that is not a symlink", () =>
  withApp(async (root) => {
    await panels.chdir("left", root);
    await ops.retarget("a.txt", "/etc/passwd");
    // The file is still there — the check is what stops this being a delete.
    assertEquals(await Deno.readTextFile(`${root}/a.txt`), "a");
    assert(ui.status.includes("not a symbolic link"), ui.status);
  }));
