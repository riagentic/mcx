// mcx's profile: `~/.mcx`, seeded once, never read from anywhere else.
import { assert, assertEquals } from "@std/assert";
import { DEFAULT_MENU } from "../../lib/defaults.ts";

/** Point the app directories at a temp profile, so a test can never touch a
 *  real one. `AIO_APPS_DIR` is the same lever the framework's own harness
 *  uses. */
async function withProfile(
  fn: (
    home: string,
    io: typeof import("../../cell/profile.server.ts"),
  ) => void | Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "mcx-profile-" });
  const old = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", root);
  try {
    // Imported AFTER the variable is set: `appDirs` reads it when asked, but
    // the module is cached, so each test gets the same instance and asks again.
    const io = await import("../../cell/profile.server.ts");
    await fn(`${root}/mcx`, io);
  } finally {
    if (old === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", old);
  }
}

Deno.test("a first run writes the profile, and everything is under ~/.mcx", () =>
  withProfile(async (home, io) => {
    assertEquals(io.profileDir(), home);
    await io.ensureProfile();

    assert((await Deno.stat(`${home}/menu`)).isFile);
    assert((await Deno.stat(`${home}/ext.ini`)).isFile);
    assert((await Deno.stat(`${home}/skins`)).isDirectory);
    const skins = await io.skins();
    assert(skins.length >= 4, `only ${skins.length} skins seeded`);
    assert(
      skins.every((s) => s.path.startsWith(`${home}/skins/`)),
      "outside the profile",
    );
  }));

Deno.test("what the user edits is never written over", () =>
  withProfile(async (home, io) => {
    await io.ensureProfile();
    await Deno.writeTextFile(`${home}/menu`, "x   Mine\n        echo mine\n");
    await Deno.remove(`${home}/skins/nord.ini`);

    // A second run: mcx must not restore either decision.
    await io.ensureProfile();
    assertEquals(
      await Deno.readTextFile(`${home}/menu`),
      "x   Mine\n        echo mine\n",
    );
    assertEquals(
      (await io.skins()).some((s) => s.name === "nord"),
      false,
      "a deleted skin came back",
    );
  }));

Deno.test("the seeded menu is a menu that parses and applies", () =>
  withProfile(async (home, io) => {
    await io.ensureProfile();
    const menu = await io.userMenu(home);
    assert(menu, "no menu found");
    assertEquals(menu!.source, `${home}/menu`);
    assert(menu!.entries.length > 5, `only ${menu!.entries.length} entries`);
    // Every entry has something to run.
    for (const e of menu!.entries) assert(e.commands.length > 0, e.label);
  }));

Deno.test("a .mcx.menu beside the files wins over the profile's", () =>
  withProfile(async (_home, io) => {
    await io.ensureProfile();
    const dir = await Deno.makeTempDir({ prefix: "mcx-project-" });
    await Deno.writeTextFile(
      `${dir}/.mcx.menu`,
      "p   Project command\n        make test\n",
    );
    const menu = await io.userMenu(dir);
    assertEquals(menu!.source, `${dir}/.mcx.menu`);
    assertEquals(menu!.entries[0]!.label, "Project command");
  }));

Deno.test("associations come from the profile and match by suffix and pattern", () =>
  withProfile(async (_home, io) => {
    await io.ensureProfile();
    const list = await io.associations();
    assert(list.length > 0, "no associations seeded");
    assert(io.associationFor(list, "holiday.JPG"), "case-insensitive match");
    assert(io.associationFor(list, "paper.pdf"), "pdf");
    assert(io.associationFor(list, "app.desktop"), "suffix match");
    assertEquals(io.associationFor(list, "notes.txt"), null);
  }));

Deno.test("ext.ini speaks mc's whole dialect, so mc's own file can be copied in", () =>
  withProfile((_home, io) => {
    const list = io.parseExt(`
[Include/archive]
Open=extract %f

[gzip]
Shell=.gz
Include=archive

[makefile]
Shell=Makefile
Open=make

[gzip-by-content]
Type=^gzip compressed
Open=zcat %f

[Default]
Open=xdg-open %f
`);

    // Include= fills in what the section did not say itself.
    assertEquals(io.associationFor(list, "a.tar.gz")?.open, "extract %f");

    // A Shell= without a leading dot is the WHOLE name: `GNUmakefile` is not
    // `Makefile`, however much it ends with it.
    assertEquals(io.associationFor(list, "Makefile")?.open, "make");
    assertEquals(io.associationFor(list, "GNUmakefile")?.section, "Default");

    // Type= matches what `file` said — and only when it is offered, because
    // finding out costs a subprocess.
    assertEquals(io.associationFor(list, "mystery")?.section, "Default");
    assertEquals(
      io.associationFor(list, "mystery", "gzip compressed data")?.open,
      "zcat %f",
    );

    // [Default] catches what nothing else claimed, wherever it sits.
    assertEquals(io.associationFor(list, "notes.txt")?.open, "xdg-open %f");
  }));

Deno.test("an Include that points at itself is a hang, so it is bounded", () =>
  withProfile((_home, io) => {
    const list = io.parseExt(`
[Include/a]
Include=b

[Include/b]
Include=a
Open=eventually %f

[thing]
Shell=.thing
Include=a
`);
    assertEquals(io.associationFor(list, "x.thing")?.open, "eventually %f");
  }));

Deno.test("a skin outside the profile is refused, however it is named", () =>
  withProfile(async (home, io) => {
    await io.ensureProfile();
    // The path comes from a list mcx made; a stale or crafted one must not be
    // able to read a file elsewhere on the disk.
    assertEquals(await io.skinCss("/etc/passwd"), {});
    assertEquals(await io.skinCss(`${home}/skins/../../../etc/passwd`), {});
    const ours = (await io.skins())[0]!;
    assert(Object.keys(await io.skinCss(ours.path)).length > 0, ours.name);
  }));

Deno.test("nothing in the source reads mc's configuration", async () => {
  // The rule this whole file exists for. `mc/` in the repo is the upstream
  // source, read by the parity TESTS as a specification — the running program
  // must never look at a user's mc profile.
  for await (
    const entry of Deno.readDir(new URL("../../cell", import.meta.url))
  ) {
    if (!entry.isFile) continue;
    const source = await Deno.readTextFile(
      new URL(`../../cell/${entry.name}`, import.meta.url),
    );
    // Comments are stripped first: this very rule is explained in a comment in
    // profile.server.ts, and a test that reads its own documentation as a
    // violation is a test nobody can satisfy.
    const text = source
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
    for (const bad of [".config/mc", "/usr/share/mc", "/etc/mc", ".mc.menu"]) {
      assert(
        !text.includes(bad),
        `${entry.name} reaches into mc's configuration (${bad})`,
      );
    }
  }
});

Deno.test("the seeded defaults are the ones compiled in", () => {
  // Not read from the repo at runtime: a compiled binary has no repo.
  assert(DEFAULT_MENU.includes("%f"), "the menu format is documented in it");
  assert(DEFAULT_MENU.length > 500, "the default menu is substantial");
});

Deno.test("the profile is the whole footprint: nothing is written elsewhere", () =>
  withProfile(async (home, io) => {
    await io.ensureProfile();
    // Every path the profile hands out is inside it — including the cache,
    // which is where extracted archive members and fetched remote files go.
    const cache = await io.cacheDir("archives");
    assert(cache.startsWith(home), `${cache} is outside ${home}`);
    for (const s of await io.skins()) assert(s.path.startsWith(home), s.path);
  }));
