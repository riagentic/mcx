import { assertEquals } from "@std/assert";
import { chord, KEYMAP, PREFIXES, resolve } from "../../lib/keys.ts";

Deno.test("chord names keys the way the keymap spells them", () => {
  assertEquals(chord({ key: "ArrowUp" }), "Up");
  assertEquals(chord({ key: "PageDown" }), "PgDn");
  assertEquals(chord({ key: "Insert" }), "Ins");
  assertEquals(chord({ key: "F5" }), "F5");
  assertEquals(chord({ key: "r", ctrlKey: true }), "C-r");
  assertEquals(chord({ key: ".", altKey: true }), "M-.");
  assertEquals(chord({ key: "F6", shiftKey: true }), "S-F6");
  // shift on a printable key is already in the character
  assertEquals(chord({ key: "+", shiftKey: true }), "+");
});

Deno.test("resolve maps chords to commands", () => {
  assertEquals(resolve("F5", null), "file.copy");
  assertEquals(resolve("Tab", null), "panel.switch");
  assertEquals(resolve("zzz", null), null);
});

Deno.test("two-key sequences hold a prefix", () => {
  assertEquals(PREFIXES.has("C-x"), true);
  assertEquals(resolve("C-x", null), "prefix");
  assertEquals(resolve("c", "C-x"), "file.chmod");
  assertEquals(resolve("q", "C-x"), "view.quick");
  assertEquals(resolve("d", "C-x"), "panel.compare");
  assertEquals(resolve("o", "C-x"), "file.chown");
  // an unbound continuation is not a fallback to the bare key
  assertEquals(resolve("Z", "C-x"), null);
});

Deno.test("every bound command is one the app can actually run", async () => {
  // The keymap and the command table are two lists that must agree; a chord
  // bound to a command nobody implements is a key that silently does nothing,
  // which is the exact failure this union type exists to prevent.
  const src = await Deno.readTextFile(
    new URL("../../ui/commands.ts", import.meta.url),
  );
  for (const cmd of new Set(Object.values(KEYMAP))) {
    assertEquals(
      src.includes(`case "${cmd}"`),
      true,
      `${cmd} is bound to a key but has no case in run()`,
    );
  }
});

Deno.test("the function row is fully bound", () => {
  for (let i = 1; i <= 10; i++) {
    assertEquals(typeof KEYMAP[`F${i}`], "string", `F${i} must be bound`);
  }
});
