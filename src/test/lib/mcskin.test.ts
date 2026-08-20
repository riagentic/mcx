// mc's skins, checked against the skins mc itself ships.
import { assert, assertEquals } from "@std/assert";
import { parseSkin, skinColor, skinToCss } from "../../lib/mcskin.ts";

Deno.test("colour words become CSS colours", () => {
  assertEquals(skinColor("white"), "#ffffff");
  assertEquals(skinColor("brightcyan"), "#6cc7f5");
  // Unset is a real value in a skin: leave the colour alone.
  assertEquals(skinColor(""), "");
  assertEquals(skinColor("default"), "");
  // Nonsense does not become black by accident.
  assertEquals(skinColor("chartreuse"), "");
});

Deno.test("the 256-colour forms are computed, not tabulated", () => {
  assertEquals(skinColor("color16"), "#000000"); // first cube entry
  assertEquals(skinColor("color231"), "#ffffff"); // last cube entry
  assertEquals(skinColor("color232"), "#080808"); // grey ramp starts
  assertEquals(skinColor("color255"), "#eeeeee"); // …and ends
  assertEquals(skinColor("rgb000"), "#000000");
  assertEquals(skinColor("rgb555"), "#ffffff");
  assertEquals(skinColor("#ff8800"), "#ff8800");
});

Deno.test("a skin's sections and pairs are read", () => {
  const s = parseSkin(`
[skin]
    description = Test skin
[core]
    _default_ = lightgray;black
    selected = white;blue
    marked = yellow;
[filehighlight]
    directory = brightcyan;
`);
  assertEquals(s.description, "Test skin");
  assertEquals(s.sections.core!._default_, {
    fg: "#c0c0c0",
    bg: "#1c1c1c",
  });
  // A pair with an empty half leaves that half unset.
  assertEquals(s.sections.core!.marked!.bg, "");
  assertEquals(s.sections.filehighlight!.directory!.fg, "#6cc7f5");
});

Deno.test("a skin sets only what it names", () => {
  const css = skinToCss(`
[core]
    _default_ = white;black
`);
  assertEquals(css["--fg"], "#ffffff");
  assertEquals(css["--bg"], "#1c1c1c");
  // Nothing was said about directories, so mcx keeps its own colour.
  assertEquals(css["--k-dir"], undefined);
});

Deno.test("every skin mc ships translates to something usable", () => {
  let names: string[];
  try {
    names = [...Deno.readDirSync(
      new URL("../../../mc/misc/skins", import.meta.url),
    )]
      .filter((e) => e.name.endsWith(".ini"))
      .map((e) => e.name);
  } catch {
    return; // upstream tree not checked out
  }
  assert(names.length > 5, `only ${names.length} skins found`);

  for (const name of names) {
    const text = Deno.readTextFileSync(
      new URL(`../../../mc/misc/skins/${name}`, import.meta.url),
    );
    const css = skinToCss(text);
    // A foreground is the one thing every skin must give. A background is
    // not: the `-defbg` skins deliberately say `default`, meaning "whatever
    // the terminal already had" — mcx keeps its own, which is the same idea.
    assert(css["--fg"], `${name}: no foreground`);
    assert(
      !css["--bg"] || css["--fg"] !== css["--bg"],
      `${name}: text the colour of the page`,
    );
    for (const [k, v] of Object.entries(css)) {
      assert(/^#[0-9a-f]{6}$/.test(v), `${name}: ${k} is ${JSON.stringify(v)}`);
    }
  }
});

Deno.test("an alias may name another alias, and three-digit hex works", () => {
  const s = parseSkin(`
[aliases]
    MarkedFg = #ff5
    HeaderFg = MarkedFg
[core]
    _default_ = HeaderFg;#992005
`);
  assertEquals(s.sections.core!._default_, {
    fg: "#ffff55",
    bg: "#992005",
  });
});

Deno.test("a cycle in the aliases stops instead of hanging", () => {
  const s = parseSkin(`
[aliases]
    a = b
    b = a
[core]
    _default_ = a;white
`);
  assertEquals(s.sections.core!._default_!.fg, "");
});
