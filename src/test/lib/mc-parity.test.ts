// Parity with mc, checked against mc itself.
//
// `mc/misc/mc.default.keymap` is the upstream source of truth for what key does
// what in the file manager. This test parses it and holds mcx's KEYMAP to it,
// so "1:1 port" is a property the suite enforces rather than a claim in a
// README. PORTED says which mc command each mcx command answers; NOT_YET names
// the ones that are still missing, each with the reason — a gap that is written
// down is a plan, a gap that is not is a surprise.
//
// When a binding lands, move it from NOT_YET to PORTED and the test starts
// demanding it stays.
import { assert, assertEquals } from "@std/assert";
import type { Command } from "../../lib/keys.ts";
import { KEYMAP } from "../../lib/keys.ts";

const KEYMAP_FILE = new URL(
  "../../../mc/misc/mc.default.keymap",
  import.meta.url,
);

/** mc's key spellings → the chord strings `chord()` produces. */
const NAMED: Record<string, string> = {
  tab: "Tab",
  enter: "Enter",
  esc: "Esc",
  insert: "Ins",
  delete: "Del",
  backspace: "BS",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pgup: "PgUp",
  pgdn: "PgDn",
  home: "Home",
  end: "End",
  question: "?",
  backslash: "\\",
  dot: ".",
  comma: ",",
  exclamation: "!",
  plus: "+",
  minus: "-",
  asterisk: "*",
  equal: "=",
  lt: "<",
  gt: ">",
  underscore: "_",
  kpplus: "+",
  kpminus: "-",
  kpasterisk: "*",
  slash: "/",
  prime: "`",
  lparenthesis: "(",
  rparenthesis: ")",
  lbrace: "{",
  rbrace: "}",
};

/** A terminal reports shifted function keys as F13–F20. Everyone means
 *  Shift+F3…Shift+F10 by them, including mc's own documentation. */
function functionKey(n: number): string | null {
  if (n >= 1 && n <= 10) return `F${n}`;
  if (n >= 11 && n <= 20) return `S-F${n - 10}`;
  return null;
}

/** One mc key spelling → one mcx chord, or null when it is something this
 *  keyboard layer does not model (the keypad's `a1`/`c1`, say). */
export function toChord(spec: string): string | null {
  let ctrl = false, alt = false, shift = false;
  let k = spec.trim().toLowerCase();
  for (;;) {
    if (k.startsWith("ctrl-")) {
      ctrl = true;
      k = k.slice(5);
      continue;
    }
    if (k.startsWith("alt-")) {
      alt = true;
      k = k.slice(4);
      continue;
    }
    if (k.startsWith("shift-")) {
      shift = true;
      k = k.slice(6);
      continue;
    }
    break;
  }

  const fn = /^f(\d{1,2})$/.exec(k);
  let base = fn ? functionKey(Number(fn[1])) : (NAMED[k] ?? k);
  if (base === null) return null;
  if (base.length > 1 && !/^F\d+$/.test(base) && !NAMED[k] && !fn) return null;

  // Shift on a printable character has already changed the character, which is
  // how `chord()` spells it; on a named key it stays a prefix.
  const named = base.length > 1;
  if (shift && !named) {
    base = base.toUpperCase();
    shift = false;
  }
  return `${ctrl ? "C-" : ""}${alt ? "M-" : ""}${shift ? "S-" : ""}${base}`;
}

/** mc command → the mcx command that answers it. */
const PORTED: Record<string, Command> = {
  // [filemanager]
  "filemanager:ChangePanel": "panel.switch",
  "filemanager:Help": "help",
  "filemanager:UserMenu": "menu.user",
  "filemanager:View": "file.view",
  "filemanager:Edit": "file.edit",
  "filemanager:Copy": "file.copy",
  "filemanager:Move": "file.move",
  "filemanager:MakeDir": "file.mkdir",
  "filemanager:Delete": "file.delete",
  "filemanager:Menu": "menu.open",
  "filemanager:Quit": "app.quit",
  "filemanager:QuitQuiet": "app.quitQuiet",
  "filemanager:Find": "find.file",
  "filemanager:CdQuick": "dir.quickCd",
  "filemanager:HotList": "dir.hotlist",
  "filemanager:Reread": "panel.reload",
  "filemanager:Swap": "panel.swap",
  "filemanager:History": "cmd.history",
  "filemanager:ShowHidden": "view.hidden",
  "filemanager:Shell": "shell.toggle",
  "filemanager:PutCurrentPath": "cmd.insertPath",
  "filemanager:PutOtherPath": "cmd.insertOtherPath",
  "filemanager:PutCurrentSelected": "cmd.insertName",
  "filemanager:PutCurrentFullSelected": "cmd.insertFullName",
  "filemanager:Select": "mark.byMask",
  "filemanager:Unselect": "mark.unmarkByMask",
  "filemanager:SelectInvert": "mark.invert",

  // [filemanager:xmap] — the C-x sequences
  "xmap:ChangeMode": "file.chmod",
  "xmap:ChangeOwn": "file.chown",
  "xmap:CompareDirs": "panel.compare",
  "xmap:HotListAdd": "dir.hotAdd",
  "xmap:Link": "file.hardlink",
  "xmap:LinkSymbolic": "file.symlink",
  "xmap:PanelInfo": "view.info",
  "xmap:PanelQuickView": "view.quick",
  "xmap:PutCurrentPath": "cmd.insertPath",
  "xmap:PutOtherPath": "cmd.insertOtherPath",
  "xmap:PutCurrentTagged": "cmd.insertTagged",
  "xmap:PutOtherTagged": "cmd.insertOtherTagged",
  "xmap:PutCurrentLink": "cmd.insertLink",
  "xmap:PutOtherLink": "cmd.insertOtherLink",

  // [panel]
  "panel:CycleListingFormat": "view.mode",
  "panel:Search": "search.quick",
  "panel:Mark": "mark.toggle",
  "panel:MarkUp": "mark.up",
  "panel:MarkDown": "mark.down",
  "panel:Down": "cursor.down",
  "panel:Up": "cursor.up",
  "panel:Left": "cursor.left",
  "panel:Right": "cursor.right",
  "panel:PageUp": "cursor.pageUp",
  "panel:PageDown": "cursor.pageDown",
  "panel:Enter": "panel.enter",
  "panel:PanelOtherCd": "panel.otherCd",
  "panel:PanelOtherCdLink": "panel.otherCdLink",
  "panel:ViewRaw": "file.viewRaw",
  "panel:EditNew": "file.editNew",
  "panel:CopySingle": "file.copySingle",
  "panel:MoveSingle": "file.rename",
  "panel:DeleteSingle": "file.deleteSingle",
  "panel:CdChild": "panel.enter",
  "panel:CdParent": "panel.up",
  "panel:PanelOtherSync": "panel.syncOther",
  "panel:TopOnScreen": "cursor.topScreen",
  "panel:MiddleOnScreen": "cursor.middleScreen",
  "panel:BottomOnScreen": "cursor.bottomScreen",
  "panel:Select": "mark.byMask",
  "panel:Unselect": "mark.unmarkByMask",
  "panel:SelectInvert": "mark.invert",
  "panel:History": "history.dir",
  "filemanager:DirSize": "dir.size",
  "filemanager:MenuLastSelected": "menu.lastSelected",
  "xmap:LinkSymbolicEdit": "file.symlinkEdit",
  "xmap:LinkSymbolicRelative": "file.symlinkRelative",
  "panel:HistoryNext": "history.next",
  "panel:HistoryPrev": "history.prev",
  "filemanager:SplitVertHoriz": "layout.splitToggle",
  "filemanager:SplitEqual": "layout.splitEqual",
  "filemanager:SplitMore": "layout.splitMore",
  "filemanager:SplitLess": "layout.splitLess",
  "filemanager:ViewFiltered": "shell.viewFiltered",
  "filemanager:EditorViewerHistory": "history.files",
  "xmap:ExternalPanelize": "shell.panelize",
  "filemanager:ScreenList": "screen.list",
  "xmap:ChangeAttributes": "file.chattr",
  "xmap:VfsList": "vfs.list",
  "panel:ScrollLeft": "view.scrollLeft",
  "panel:ScrollRight": "view.scrollRight",
  "panel:SelectCodepage": "charset",
  "xmap:Jobs": "jobs",
  "xmap:CompareFiles": "file.compare",
  "panel:Top": "cursor.top",
  "panel:Bottom": "cursor.bottom",
};

/** Commands that cannot apply to this program, with the reason. Distinct from
 *  NOT_YET on purpose: one is work not done, the other is work that would be
 *  wrong to do, and a ledger that confuses them can never reach 100%. */
const NOT_APPLICABLE: Record<string, string> = {
  "filemanager:Suspend":
    "C-z returns mc to the shell that started it; a window has no such shell",
  "filemanager:ExtendedKeyMap":
    "the C-x prefix itself — implemented by resolve(), not as a command",
};

/** Still missing, and why. Every line here is a batch of work, not an excuse. */
const NOT_YET: Record<string, string> = {};

/** The viewer's keymap — mcx's viewer is mcview's job, so it answers to the
 *  same table. These map to `viewerKey` in ui/keyboard.ts rather than to a
 *  Command, because the viewer is a mode that owns the keyboard while it is up;
 *  the chord itself is the assertion. */
const VIEWER_PORTED: Record<string, string> = {
  Help: "the help dialog",
  WrapMode: "viewer.toggleWrap",
  Quit: "viewer.close",
  HexMode: "viewer.toggleMode",
  Goto: "the goto prompt",
  Search: "the search prompt",
  SearchForward: "the search prompt",
  SearchBackward: "the backward search prompt",
  SearchContinue: "viewer.find",
  SearchForwardContinue: "viewer.find",
  SearchBackwardContinue: "viewer.find backwards",
  SearchOppositeContinue: "viewer.find backwards",
  NroffMode: "viewer.toggleNroff",
  Home: "viewer.scrollColumn to 0",
  End: "viewer.scrollColumn to the line end",
  Left: "viewer.scrollColumn",
  Right: "viewer.scrollColumn",
  LeftQuick: "viewer.scrollColumn by half a screen",
  RightQuick: "viewer.scrollColumn by half a screen",
  Up: "viewer.scroll",
  Down: "viewer.scroll",
  PageUp: "viewer.scroll",
  PageDown: "viewer.scroll",
  HalfPageUp: "viewer.scroll",
  HalfPageDown: "viewer.scroll",
  Top: "viewer.top",
  Bottom: "viewer.bottom",
  Bookmark: "viewer.mark",
  BookmarkGoto: "viewer.toMark",
  FileNext: "viewer.stepFile",
  FilePrev: "viewer.stepFile",
  Ruler: "viewer.toggleRuler",
  SelectCodepage: "viewer.setCharset",
  Shell: "the shell view",
  History: "history.files",
};

const VIEWER_NOT_YET: Record<string, string> = {};

/** See NOT_APPLICABLE above. */
const VIEWER_NOT_APPLICABLE: Record<string, string> = {
  MagicMode:
    "mc pipes the file through an mc.ext filter; mcx browses archives as directories instead, which is the same job done differently",
};

type Section = Map<string, string[]>;

/** The keymap file is an ini: `Command = key; key`, `#` comments a line out
 *  (which upstream uses to mean "no default binding"). */
function parse(text: string): Map<string, Section> {
  const out = new Map<string, Section>();
  let current: Section | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      current = new Map();
      out.set(head[1]!, current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || !current) continue;
    const name = line.slice(0, eq).trim();
    const keys = line.slice(eq + 1).split(";").map((k) => k.trim()).filter(
      Boolean,
    );
    if (keys.length > 0) current.set(name, keys);
  }
  return out;
}

const source = (() => {
  try {
    return Deno.readTextFileSync(KEYMAP_FILE);
  } catch {
    return null; // upstream tree not checked out — the rest of the suite stands
  }
})();

const sections = source ? parse(source) : null;

/** The three sections that describe the file manager proper. `xmap` is the
 *  C-x prefix, so its chords are two keys long. */
function fileManagerBindings(): Array<[string, string[]]> {
  if (!sections) return [];
  const out: Array<[string, string[]]> = [];
  for (const [name, keys] of sections.get("filemanager") ?? []) {
    out.push([
      `filemanager:${name}`,
      keys.map(toChord).filter((c): c is string => !!c),
    ]);
  }
  for (const [name, keys] of sections.get("filemanager:xmap") ?? []) {
    out.push([
      `xmap:${name}`,
      keys.map(toChord).filter((c): c is string => !!c).map((c) => `C-x ${c}`),
    ]);
  }
  for (const [name, keys] of sections.get("panel") ?? []) {
    out.push([
      `panel:${name}`,
      keys.map(toChord).filter((c): c is string => !!c),
    ]);
  }
  return out;
}

Deno.test("mc's key spellings translate to mcx chords", () => {
  assertEquals(toChord("alt-question"), "M-?");
  assertEquals(toChord("ctrl-backslash"), "C-\\");
  assertEquals(toChord("kpplus"), "+");
  assertEquals(toChord("alt-shift-a"), "M-A");
  assertEquals(toChord("shift-up"), "S-Up");
  assertEquals(toChord("f13"), "S-F3");
  assertEquals(toChord("ctrl-space"), "C-Space");
  assertEquals(toChord("alt-lt"), "M-<");
});

Deno.test("every mc file-manager binding mcx claims is bound the same way", () => {
  if (!sections) return; // no upstream tree here
  const missing: string[] = [];
  for (const [name, chords] of fileManagerBindings()) {
    const want = PORTED[name];
    if (!want) continue; // covered by the NOT_YET ledger below
    for (const chord of chords) {
      const got = KEYMAP[chord];
      if (got !== want) {
        missing.push(`${name}: ${chord} is ${got ?? "unbound"}, want ${want}`);
      }
    }
  }
  assertEquals(
    missing,
    [],
    `mc bindings not reproduced:\n${missing.join("\n")}`,
  );
});

Deno.test("the ledger accounts for every mc command, ported or not", () => {
  if (!sections) return;
  const unaccounted: string[] = [];
  for (const [name] of fileManagerBindings()) {
    if (!PORTED[name] && !NOT_YET[name] && !NOT_APPLICABLE[name]) {
      unaccounted.push(name);
    }
  }
  assertEquals(
    unaccounted,
    [],
    `mc commands neither ported nor listed as missing: ${
      unaccounted.join(", ")
    }`,
  );
});

Deno.test("nothing sits in two places in the ledger", () => {
  for (const name of Object.keys(NOT_YET)) {
    assert(!PORTED[name], `${name} is listed as missing but is ported`);
    assert(!NOT_APPLICABLE[name], `${name} is both missing and not applicable`);
  }
  for (const name of Object.keys(NOT_APPLICABLE)) {
    assert(!PORTED[name], `${name} is listed as N/A but is ported`);
  }
});

/** Every binding mc defines for a context, as chords. */
function bindingsOf(section: string): Array<[string, string[]]> {
  if (!sections) return [];
  return [...(sections.get(section) ?? [])].map((
    [name, keys],
  ) => [name, keys.map(toChord).filter((c): c is string => !!c)]);
}

Deno.test("the viewer ledger accounts for every mc viewer command", () => {
  if (!sections) return;
  const unaccounted = bindingsOf("viewer")
    .map(([n]) => n)
    .filter((n) =>
      !VIEWER_PORTED[n] && !VIEWER_NOT_YET[n] && !VIEWER_NOT_APPLICABLE[n]
    );
  assertEquals(unaccounted, [], `unaccounted viewer commands`);
});

Deno.test("every viewer chord mc defines is one the viewer answers", () => {
  if (!sections) return;
  // The chords viewerKey handles, read from the source: the switch IS the
  // table, so the test reads the same thing a reviewer would.
  const src = Deno.readTextFileSync(
    new URL("../../ui/keyboard.ts", import.meta.url),
  );
  const body = src.slice(
    src.indexOf("function viewerKey"),
    src.indexOf("let pending"),
  );
  const handled = new Set(
    [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!),
  );
  const missing: string[] = [];
  for (const [name, chords] of bindingsOf("viewer")) {
    if (!VIEWER_PORTED[name]) continue;
    // One spelling is enough for a command with several: mc gives `Quit` four.
    if (!chords.some((c) => handled.has(c))) {
      missing.push(`${name}: none of ${chords.join(", ")} is handled`);
    }
  }
  assertEquals(
    missing,
    [],
    `viewer chords not handled:\n${missing.join("\n")}`,
  );
});

/** Which chords a mode's switch statement actually handles, read from the
 *  source: the switch IS the table, so the test reads what a reviewer reads. */
function handledChords(fn: string, until: string): Set<string> {
  const src = Deno.readTextFileSync(
    new URL("../../ui/keyboard.ts", import.meta.url),
  );
  const body = src.slice(src.indexOf(fn), src.indexOf(until));
  return new Set([...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!));
}

Deno.test("the editor answers mc's editor keymap", () => {
  if (!sections) return;
  const handled = handledChords("function editorKey", "function viewerKey");
  // The macro layer sits in FRONT of every mode (it has to see the keys it is
  // recording), so its chords are handled outside the editor's own switch.
  for (const c of handledChords("function macroKey", "function inTextField")) {
    handled.add(c);
  }
  const missing: string[] = [];
  for (const [name, chords] of bindingsOf("editor")) {
    if (chords.length === 0) continue;
    if (!chords.some((c) => handled.has(c))) missing.push(name);
  }
  const total = bindingsOf("editor").filter(([, c]) => c.length > 0).length;
  console.log(
    `    mc editor parity: ${total - missing.length}/${total} commands (${
      Math.round(((total - missing.length) / total) * 100)
    }%)`,
  );
  if (missing.length > 0) {
    console.log(`    still missing: ${missing.join(", ")}`);
  }
  assert(
    missing.length <= 12,
    `editor parity went backwards: ${missing.length} missing`,
  );
});

/** mc's `[input]` map — the line editor inside every field.
 *
 *  Half of it a browser `<input>` already does (arrows, Backspace, Delete,
 *  Home/End, shift-selection); the other half it does not, and `fieldKey` in
 *  ui/keyboard.ts supplies it. This test holds BOTH halves to the same table,
 *  because "the browser probably does that" is exactly the assumption that left
 *  `C-k` and `M-d` doing nothing for a year. */
const INPUT_NATIVE: Record<string, string> = {
  Left: "the field's own caret movement",
  Right: "the field's own caret movement",
  Backspace: "the field's own",
  Delete: "the field's own",
  Home: "the field's own",
  End: "the field's own",
  WordLeft: "C-Left, which the field does natively",
  WordRight: "C-Right, which the field does natively",
  MarkLeft: "shift-arrow selection, native",
  MarkRight: "shift-arrow selection, native",
  MarkToWordBegin: "C-S-Left, native",
  MarkToWordEnd: "C-S-Right, native",
  MarkToHome: "S-Home, native",
  MarkToEnd: "S-End, native",
  Store: "M-w — the platform clipboard shortcut copies the selection",
  Yank: "C-y — the platform clipboard shortcut pastes",
};

/** The rest: chords `fieldKey` handles itself. */
const INPUT_PORTED: Record<string, string> = {
  DeleteToWordBegin: "M-BS",
  DeleteToWordEnd: "M-d",
  DeleteToEnd: "C-k",
  Remove: "C-w",
  Complete: "M-Tab",
  HistoryPrev: "M-p",
  HistoryNext: "M-n",
  History: "M-h",
};

Deno.test("the input line answers mc's input keymap", () => {
  if (!sections) return;
  const src = Deno.readTextFileSync(
    new URL("../../ui/keyboard.ts", import.meta.url),
  );
  const body = src.slice(
    src.indexOf("function fieldKey"),
    src.indexOf("async function completeField"),
  );
  const handled = new Set(
    [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!),
  );
  // The command line's history keys are the app's, not the field's.
  for (const chordText of Object.keys(KEYMAP)) handled.add(chordText);

  const missing: string[] = [];
  for (const [name, chords] of bindingsOf("input")) {
    if (INPUT_NATIVE[name]) continue;
    const want = INPUT_PORTED[name];
    if (!want) {
      missing.push(`${name} — not in the ledger`);
    } else if (!chords.includes(want)) {
      missing.push(`${name} → ${want} is not one of mc's ${chords.join(", ")}`);
    } else if (!handled.has(want)) {
      missing.push(`${name} → ${want} is handled nowhere`);
    }
  }
  const total = bindingsOf("input").filter(([, c]) => c.length > 0).length;
  console.log(
    `    mc input parity: ${total - missing.length}/${total} commands (${
      Math.round(((total - missing.length) / total) * 100)
    }%), ${Object.keys(INPUT_NATIVE).length} native to the field`,
  );
  assertEquals(missing, [], `input bindings missing`);
});

/** mc's `[dialog]`, `[listbox]` and `[radio]` — the keys that work a modal.
 *
 *  These three had no ledger at all, and it showed: a hotlist of two hundred
 *  directories could be walked one row at a time and no other way, because
 *  nothing was holding the dialog layer to mc's table. */
const MODAL_PORTED: Record<string, string> = {
  // [dialog]
  "dialog:Ok": "Enter",
  "dialog:Cancel": "Esc",
  "dialog:Up": "Up",
  "dialog:Down": "Down",
  // [listbox]
  "listbox:Up": "Up",
  "listbox:Down": "Down",
  "listbox:Top": "Home",
  "listbox:Bottom": "End",
  "listbox:PageUp": "PgUp",
  "listbox:PageDown": "PgDn",
  "listbox:Enter": "Enter",
  // [radio]
  "radio:Up": "Up",
  "radio:Down": "Down",
  "radio:Top": "Home",
  "radio:Bottom": "End",
  "radio:Select": "Space",
};

/** …and the ones a modal in a window answers differently. */
const MODAL_NOT_APPLICABLE: Record<string, string> = {
  "dialog:Help":
    "mcx has one modal slot, so help over a dialog would REPLACE it and lose " +
    "what had been typed into it; F1 is answered from the panels",
  "dialog:Suspend": "C-z returns mc to its shell; a window has no such shell",
  "dialog:Refresh": "the renderer repaints on its own",
  "dialog:ScreenList": "C-x p — the screen list is a command, not a dialog key",
  "dialog:ScreenNext": "as ScreenList",
  "dialog:ScreenPrev": "as ScreenList",
  "listbox:Delete":
    "mcx's lists are read-only; the hotlist is edited with C-x h",
  "listbox:Clear": "as Delete",
  "listbox:View": "F3 in a list opens the panel's file, not the list's row",
  "listbox:Edit": "as View",
};

/** mc's `[viewer:hex]` — hex mode has a keymap of its own because the cursor
 *  is a byte, not a line. Handled by `hexKey`, with the keys hex mode shares
 *  with the text viewer answered by `viewerKey` underneath it. */
const HEX_PORTED: Record<string, string> = {
  HexEditMode: "F2",
  Save: "F6",
  ToggleNavigation: "Tab",
  Left: "Left",
  Right: "Right",
  Up: "Up",
  Down: "Down",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Top: "C-Home",
  Bottom: "C-End",
};

/** The rest of hex mode is the viewer's — same key, same meaning. */
const HEX_SHARED = [
  "Help",
  "Quit",
  "HexMode",
  "Goto",
  "Search",
  "SearchForward",
  "SearchBackward",
  "SearchContinue",
  "SearchForwardContinue",
  "SearchBackwardContinue",
  "SearchOppositeContinue",
  "NroffMode",
  "History",
  "HxSrch",
];

const HEX_NOT_APPLICABLE: Record<string, string> = {
  MagicMode: "as in the text viewer — mcx browses archives as directories",
};

/** mc's `[menu]` — walking the pulldowns. Handled by `menuKey`. */
const MENU_PORTED: Record<string, string> = {
  Left: "Left",
  Right: "Right",
  Up: "Up",
  Down: "Down",
  Home: "Home",
  End: "End",
  Enter: "Enter",
  Quit: "Esc",
};

const MENU_NOT_APPLICABLE: Record<string, string> = {
  Help: "F1 opens the key list; a pulldown has no page of its own",
};

Deno.test("the pulldowns answer mc's menu keymap", () => {
  if (!sections) return;
  const handled = handledChords("function menuKey", "/** The find dialog");
  const missing: string[] = [];
  let total = 0;
  for (const [name, chords] of bindingsOf("menu")) {
    if (chords.length === 0) continue;
    total++;
    if (MENU_NOT_APPLICABLE[name]) continue;
    const want = MENU_PORTED[name];
    if (!want) missing.push(`${name} — not in the ledger`);
    else if (!handled.has(want)) missing.push(`${name} → ${want} not handled`);
  }
  const na = Object.keys(MENU_NOT_APPLICABLE).length;
  console.log(
    `    mc menu-key parity: ${total - missing.length - na}/${
      total - na
    } commands (100%)`
      .replace(
        "(100%)",
        `(${
          Math.round(((total - missing.length - na) / (total - na)) * 100)
        }%)`,
      ),
  );
  assertEquals(missing, [], `menu bindings missing`);
});

/** Every section of mc's keymap file, and where it is answered.
 *
 *  The point of this one is COVERAGE of the ledgers themselves: for a year the
 *  input line, the modals and hex mode each had no ledger, so each was "100%
 *  ported" in a table that had never looked at them. A new section upstream now
 *  fails here rather than passing unnoticed. */
const SECTION_LEDGER: Record<string, string> = {
  "filemanager": "PORTED / NOT_APPLICABLE, above",
  "filemanager:xmap": "PORTED, above (the C-x prefix)",
  "panel": "PORTED, above",
  "dialog": "MODAL_PORTED",
  "menu": "MENU_PORTED",
  "input": "INPUT_PORTED / INPUT_NATIVE",
  "listbox": "MODAL_PORTED",
  "radio": "MODAL_PORTED",
  "tree": "checked against treeKey",
  "help": "mcx's F1 is one page of bindings, not mc's hypertext help — " +
    "there are no nodes to walk, so its keymap has nothing to answer",
  "chattr": "mcx sets attributes from a text field (C-x e), not mc's grid",
  "editor": "checked against editorKey",
  "viewer": "VIEWER_PORTED",
  "viewer:hex": "HEX_PORTED / HEX_SHARED",
  "diffviewer": "checked against diffKey",
};

Deno.test("every section of mc's keymap is accounted for somewhere", () => {
  if (!sections) return;
  const unaccounted = [...sections.keys()].filter((s) => !SECTION_LEDGER[s]);
  assertEquals(
    unaccounted,
    [],
    `mc keymap sections with no ledger: ${unaccounted.join(", ")}`,
  );
  // …and nothing in the ledger that upstream no longer has.
  const stale = Object.keys(SECTION_LEDGER).filter((s) => !sections.has(s));
  assertEquals(stale, [], `ledger names sections mc does not have`);
  console.log(
    `    mc keymap sections: ${sections.size}/${sections.size} accounted for`,
  );
});

Deno.test("hex mode answers mc's viewer:hex keymap", () => {
  if (!sections) return;
  const src = Deno.readTextFileSync(
    new URL("../../ui/keyboard.ts", import.meta.url),
  );
  const hexBody = src.slice(
    src.indexOf("function hexKey"),
    src.indexOf("function viewerKey"),
  );
  const viewBody = src.slice(
    src.indexOf("function viewerKey"),
    src.indexOf("let pending"),
  );
  const handled = new Set(
    [...`${hexBody}${viewBody}`.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!),
  );

  const missing: string[] = [];
  let total = 0;
  for (const [name, chords] of bindingsOf("viewer:hex")) {
    if (chords.length === 0) continue;
    total++;
    if (HEX_NOT_APPLICABLE[name]) continue;
    if (HEX_SHARED.includes(name)) {
      // Shared with the text viewer: one spelling handled is enough.
      if (!chords.some((k) => handled.has(k))) {
        missing.push(`${name}: none of ${chords.join(", ")} is handled`);
      }
      continue;
    }
    const want = HEX_PORTED[name];
    if (!want) missing.push(`${name} — not in the ledger`);
    else if (!handled.has(want)) missing.push(`${name} → ${want} not handled`);
  }
  const na = Object.keys(HEX_NOT_APPLICABLE).length;
  console.log(
    `    mc viewer:hex parity: ${total - missing.length - na}/${
      total - na
    } commands (${
      Math.round(((total - missing.length - na) / (total - na)) * 100)
    }%), ${na} not applicable`,
  );
  assertEquals(missing, [], `hex bindings missing`);
});

Deno.test("the dialog layer answers mc's modal keymaps", () => {
  if (!sections) return;
  const src = Deno.readTextFileSync(
    new URL("../../ui/keyboard.ts", import.meta.url),
  );
  // The dialog branch of handleKey, which is where a modal's keys are decided.
  const body = src.slice(
    src.indexOf("  if (ui.dialog) {"),
    src.indexOf("  // 2. Modal surfaces"),
  );
  const handled = new Set([
    ...[...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!),
    ...[...body.matchAll(/c === "([^"]+)"/g)].map((m) => m[1]!),
    ...[...body.matchAll(/"([^"]+)": -?\d+/g)].map((m) => m[1]!),
  ]);

  const missing: string[] = [];
  let total = 0;
  for (const section of ["dialog", "listbox", "radio"]) {
    for (const [name, chords] of bindingsOf(section)) {
      if (chords.length === 0) continue;
      total++;
      const key = `${section}:${name}`;
      if (MODAL_NOT_APPLICABLE[key]) continue;
      const want = MODAL_PORTED[key];
      if (!want) missing.push(`${key} — not in the ledger`);
      else if (!chords.includes(want)) {
        missing.push(
          `${key} → ${want} is not one of mc's ${chords.join(", ")}`,
        );
      } else if (!handled.has(want)) {
        missing.push(`${key} → ${want} is handled nowhere`);
      }
    }
  }
  const na = Object.keys(MODAL_NOT_APPLICABLE).length;
  console.log(
    `    mc dialog parity: ${total - missing.length - na}/${
      total - na
    } commands (${
      Math.round(((total - missing.length - na) / (total - na)) * 100)
    }%), ${na} answered differently`,
  );
  assertEquals(missing, [], `modal bindings missing`);
});

Deno.test("the diff viewer answers mc's diffviewer keymap", () => {
  if (!sections) return;
  const handled = handledChords("function diffKey", "/** Pending first key");
  const missing = bindingsOf("diffviewer")
    .filter(([, chords]) =>
      chords.length > 0 && !chords.some((c) => handled.has(c))
    )
    .map(([n]) => n);
  const total = bindingsOf("diffviewer").filter(([, c]) => c.length > 0).length;
  console.log(
    `    mc diffviewer parity: ${total - missing.length}/${total} commands (${
      Math.round(((total - missing.length) / total) * 100)
    }%)`,
  );
  if (missing.length > 0) {
    console.log(`    still missing: ${missing.join(", ")}`);
  }
  assert(missing.length <= 9, `diffviewer missing ${missing.length}`);
});

Deno.test("the tree answers mc's tree keymap", () => {
  if (!sections) return;
  const handled = handledChords("function treeKey", "function quickKey");
  const missing = bindingsOf("tree")
    .filter(([, chords]) =>
      chords.length > 0 && !chords.some((c) => handled.has(c))
    )
    .map(([n]) => n);
  const total = bindingsOf("tree").filter(([, c]) => c.length > 0).length;
  console.log(
    `    mc tree parity: ${total - missing.length}/${total} commands (${
      Math.round(((total - missing.length) / total) * 100)
    }%)`,
  );
  if (missing.length > 0) {
    console.log(`    still missing: ${missing.join(", ")}`);
  }
  assert(missing.length === 0, `tree bindings missing: ${missing.join(", ")}`);
});

Deno.test("the viewer parity ledger reports how far along it is", () => {
  if (!sections) return;
  const done = Object.keys(VIEWER_PORTED).length;
  const total = done + Object.keys(VIEWER_NOT_YET).length;
  console.log(
    `    mc viewer parity: ${done}/${total} portable commands (${
      Math.round((done / total) * 100)
    }%), ${Object.keys(VIEWER_NOT_APPLICABLE).length} not applicable`,
  );
  assert(done >= 35, `viewer parity went backwards: ${done}`);
});

Deno.test("the parity ledger reports how far along the port is", () => {
  if (!sections) return;
  const na = Object.keys(NOT_APPLICABLE).length;
  const total = Object.keys(PORTED).length + Object.keys(NOT_YET).length + na;
  const done = Object.keys(PORTED).length;
  // Not an assertion about the number — a printed figure the next batch aims
  // at. The floor stops it going backwards.
  console.log(
    `    mc filemanager parity: ${done}/${total - na} portable commands (${
      Math.round((done / (total - na)) * 100)
    }%), ${na} not applicable, ${Object.keys(NOT_YET).length} left`,
  );
  assert(done >= 93, `parity went backwards: ${done} ported`);
});
