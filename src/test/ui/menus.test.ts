// The pulldown menus, as the keyboard sees them.
//
// These are the rules F9 navigation is built on: separators are scenery, the
// ends of a menu hold, and the bar itself wraps. They are worth pinning because
// a menu that can only be reached with the mouse is not this application's
// menu — mc's is walkable, and this one has to be too.
import { assert, assertEquals } from "@std/assert";
import {
  firstItem,
  menuAt,
  MENUS,
  stepItem,
  stepMenu,
} from "../../ui/menus.ts";
import { KEYMAP } from "../../lib/keys.ts";

const left = menuAt("left")!;

Deno.test("every menu item is a command run() actually handles", () => {
  const src = Deno.readTextFileSync(
    new URL("../../ui/commands.ts", import.meta.url),
  );
  for (const m of MENUS) {
    for (const it of m.items) {
      if (it === "separator") continue;
      assert(
        src.includes(`case "${it.cmd}"`),
        `${m.id} → ${it.label} runs ${it.cmd}, which run() does not handle`,
      );
    }
  }
});

Deno.test("the highlight opens on a real item, never a separator", () => {
  for (const m of MENUS) {
    assert(m.items[firstItem(m)] !== "separator", `${m.id} opens on a rule`);
  }
});

Deno.test("stepping over a separator lands on the item beyond it", () => {
  // "Tree" ends the first group of the Left menu; a separator follows it.
  const tree = left.items.findIndex((i) =>
    i !== "separator" && i.label === "Tree"
  );
  assertEquals(left.items[tree + 1], "separator");

  const next = stepItem(left, tree, 1);
  assertEquals(next, tree + 2);
  assert(left.items[next] !== "separator");
  assertEquals(stepItem(left, next, -1), tree); // …and back again
});

Deno.test("the ends of a menu hold instead of wrapping", () => {
  const first = firstItem(left);
  assertEquals(stepItem(left, first, -1), first);
  const last = stepItem(left, left.items.length, -1);
  assertEquals(stepItem(left, last, 1), last);
});

Deno.test("the menu bar itself wraps in both directions", () => {
  const ids = MENUS.map((m) => m.id);
  assertEquals(stepMenu(ids[0]!, -1), ids[ids.length - 1]);
  assertEquals(stepMenu(ids[ids.length - 1]!, 1), ids[0]);
});

Deno.test("F9 is what opens the menu", () => {
  assertEquals(KEYMAP["F9"], "menu.open");
});

/** mc's own menu entries (src/filemanager/filemanager.c) → the mcx menu item
 *  that answers each, or the reason there is none. The same ledger the keymap
 *  parity test keeps, for the surface a keymap cannot describe: a user who
 *  knows mc reaches for F9 and expects to find these.
 *
 *  Read from mc's source rather than retyped, so an upstream entry that appears
 *  shows up here as a failure rather than as nothing at all. */
const MENU_PORTED: Record<string, string> = {
  // Left / Right
  "File listin&g": "File listing",
  "&Quick view": "Quick view",
  "&Info": "Info",
  "&Tree": "Tree",
  "&Listing format...": "Listing mode",
  "&Sort order...": "Sort order…",
  "&Filter...": "Filter…",
  "&Encoding...": "Encoding…",
  "&Rescan": "Rescan",
  // File
  "&View": "View",
  "Vie&w file...": "View raw",
  "&Filtered view": "Filtered view",
  "&Edit": "Edit",
  "&Copy": "Copy",
  "C&hmod": "Chmod",
  "&Link": "Hard link",
  "&Symlink": "Symlink",
  "Relative symlin&k": "Relative symlink",
  "Edit s&ymlink": "Edit symlink",
  "Ch&own": "Chown",
  "Cha&ttr": "Attributes",
  "&Rename/Move": "Rename or move",
  "&Mkdir": "Make directory",
  "&Delete": "Delete",
  "&Quick cd": "Quick cd",
  "Select &group": "Select group",
  "U&nselect group": "Unselect group",
  "&Invert selection": "Invert selection",
  "E&xit": "Quit",
  // Command
  "&User menu": "User menu",
  "&Directory tree": "Directory tree",
  "&Find file": "Find file",
  "S&wap panels": "Swap panels",
  "Switch &panels on/off": "Switch panels on/off",
  "&Compare directories": "Compare directories",
  "C&ompare files": "Compare files",
  "E&xternal panelize": "External panelize",
  "Show directory s&izes": "Show directory sizes",
  "Command &history": "Command history",
  "Viewed/edited files hi&story": "Viewed and edited files",
  "Di&rectory hotlist": "Directory hotlist",
  "&Active VFS list": "Active VFS list",
  "&Background jobs": "Background jobs",
  "Screen lis&t": "Screen list",
  "Edit &extension file": "Edit extension file",
  "Edit &menu file": "Edit menu file",
  // Options
  "&Configuration...": "Configuration…",
  "&Layout...": "Layout…",
  "&Panel options...": "Panel options…",
  "C&onfirmation...": "Confirmation…",
  "&Appearance...": "Appearance…",
  "A&bout...": "About",
};

/** Entries mcx answers differently, each with the reason. */
const MENU_NOT_APPLICABLE: Record<string, string> = {
  "Paneli&ze": "mcx panelizes from the Find dialog and from C-x !, both of " +
    "which are in the Command menu; mc's Left-menu entry re-shows the last one",
  "FT&P link...": "mcx reaches a remote by typing its URL into the panel " +
    "(`cd ftp://host/path`), so there is no second way in to keep in a menu",
  "S&hell link...": "as FTP link — `cd sh://host/path`",
  "SFTP li&nk...": "as FTP link — `cd sftp://host/path`",
  "&Advanced chown":
    "mc's per-bit chown+chmod grid; mcx has Chmod and Chown, and " +
    "the grid is a third way to say what those two already say",
  "Edit hi&ghlighting group file":
    "mcx colours the listing from the skin, not from a separate " +
    "filehighlight.ini, so there is no such file to edit",
  "Learn &keys...":
    "mc learns terminal escape sequences; a window reports its keys directly",
  "&Virtual FS...":
    "mc's VFS timeout and ftpfs settings; mcx's remotes are ssh and curl, " +
    "configured in ~/.ssh/config where they already are",
  "&Save setup": "mcx saves every setting as it changes",
};

Deno.test("the menu ledger accounts for every mc menu entry", () => {
  let source: string;
  try {
    source = Deno.readTextFileSync(
      new URL("../../../mc/src/filemanager/filemanager.c", import.meta.url),
    );
  } catch {
    return; // upstream tree not checked out — the rest of the suite stands
  }
  const entries = [...source.matchAll(/menu_entry_new \(_ \("([^"]+)"\)/g)]
    .map((m) => m[1]!);
  assert(entries.length > 40, `only ${entries.length} mc menu entries parsed`);

  const labels = new Set(
    MENUS.flatMap((m) => m.items).filter((i) => i !== "separator").map((i) =>
      (i as { label: string }).label
    ),
  );

  const missing: string[] = [];
  for (const e of new Set(entries)) {
    if (MENU_NOT_APPLICABLE[e]) continue;
    const want = MENU_PORTED[e];
    if (!want) missing.push(`${e} — not in the ledger`);
    else if (!labels.has(want)) missing.push(`${e} → "${want}" is in no menu`);
  }
  const total = new Set(entries).size;
  console.log(
    `    mc menu parity: ${total - missing.length}/${total} entries (${
      Math.round(((total - missing.length) / total) * 100)
    }%), ${Object.keys(MENU_NOT_APPLICABLE).length} answered differently`,
  );
  assertEquals(missing, [], `menu entries unaccounted for`);
});

Deno.test("Left and Right configure their own panel, not the active one", () => {
  assertEquals(menuAt("left")!.side, "left");
  assertEquals(menuAt("right")!.side, "right");
  // …and they offer the same things, because they are the same menu twice.
  const labels = (id: string) =>
    menuAt(id)!.items.filter((i) => i !== "separator").map((i) =>
      (i as { label: string }).label
    );
  assertEquals(labels("left"), labels("right"));
  // The menus that are about the program have no side at all.
  for (const id of ["file", "command", "options"]) {
    assertEquals(menuAt(id)!.side, undefined, id);
  }
});

Deno.test("the chmod dialog offers mc's twelve bits, checked to match the file", () => {
  // The dialog is built from a table in commands.ts; this holds that table to
  // the twelve bits `ls -l` shows and to their values, because a grid that
  // says "sticky" and sets setgid is worse than no grid.
  const src = Deno.readTextFileSync(
    new URL("../../ui/commands.ts", import.meta.url),
  );
  const table = src.slice(
    src.indexOf("const MODE_BITS"),
    src.indexOf("];", src.indexOf("const MODE_BITS")),
  );
  const bits = [...table.matchAll(/\[(0o[0-7]+), "([^"]+)"\]/g)].map((m) =>
    [
      parseInt(m[1]!.slice(2), 8),
      m[2]!,
    ] as [number, string]
  );

  assertEquals(bits.length, 12);
  // Every bit distinct, and together exactly the twelve mode bits.
  assertEquals(new Set(bits.map(([b]) => b)).size, 12);
  assertEquals(bits.reduce((m, [b]) => m | b, 0), 0o7777);
  // In mc's order: the special three first, then owner, group, other.
  assertEquals(bits[0]![0], 0o4000);
  assertEquals(bits[3]![0], 0o0400);
  assertEquals(bits[11]![0], 0o0001);
});
