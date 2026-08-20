/** Global key routing. One listener, three audiences: an open dialog, a focused
 *  text field, or the panels. The order matters and is the whole of the logic. */

import { diff } from "../cell/diff.ts";
import { editor } from "../cell/editor.ts";
import { find } from "../cell/find.ts";
import { panels } from "../cell/panels.ts";
import { tree } from "../cell/tree.ts";
import { shell } from "../cell/shell.ts";
import { ui } from "../cell/ui.ts";
import { viewer } from "../cell/viewer.ts";
import { chord, resolve } from "../lib/keys.ts";
import { resolveAsk, run, runFor, setOption, submit } from "./commands.ts";
import { firstItem, menuAt, stepItem, stepMenu } from "./menus.ts";

/** The editor owns every key while it is up, including the printable ones —
 *  it is a text editor, and anything less would be a text box. */
function editorKey(c: string, e: KeyboardEvent): boolean {
  if (!editor.visible) return false;
  const shift = e.shiftKey;

  switch (c) {
    case "Up":
    case "S-Up":
      editor.move(-1, 0, shift);
      return true;
    case "Down":
    case "S-Down":
      editor.move(1, 0, shift);
      return true;
    case "Left":
    case "S-Left":
      editor.move(0, -1, shift);
      return true;
    case "Right":
    case "S-Right":
      editor.move(0, 1, shift);
      return true;
    case "PgUp":
    case "S-PgUp":
      editor.move(-editor.viewport, 0, shift);
      return true;
    case "PgDn":
    case "S-PgDn":
      editor.move(editor.viewport, 0, shift);
      return true;
    case "Home":
    case "S-Home":
      editor.lineEdge(false, shift);
      return true;
    case "End":
    case "S-End":
      editor.lineEdge(true, shift);
      return true;
    case "C-Home":
      editor.jump(false);
      return true;
    case "C-End":
      editor.jump(true);
      return true;
    case "Enter":
      editor.newline();
      return true;
    case "BS":
      editor.erase(false);
      return true;
    case "Del":
      editor.erase(true);
      return true;
    case "Tab":
      editor.insert("  ");
      return true;
    case "C-z":
      editor.undoEdit();
      return true;
    case "C-y":
      editor.deleteLine();
      return true;
    case "C-S-z":
    case "S-C-z":
      editor.redoEdit();
      return true;
    case "C-c":
      editor.copySelection();
      return true;
    case "C-x":
      editor.cutSelection();
      return true;
    case "C-v":
      editor.paste();
      return true;
    case "C-s":
    case "F2":
      editor.save();
      return true;
    case "F3":
      editor.toggleMark();
      return true;
    case "F5":
      // mc's "Copy": the block is duplicated AT THE CURSOR. Copying to the
      // clipboard is C-Ins, as in mc.
      editor.copyBlock();
      return true;
    case "F6":
      // mc's "Move": the block goes to the cursor. Cut is S-Del, as in mc.
      editor.moveBlock();
      return true;
    case "F7":
      ui.prompt("edit-search", "Search", "Text:", editor.search, "Find");
      return true;
    case "F8":
      // mc's "Remove": the block goes away. Paste is S-Ins, as in mc.
      editor.deleteBlock();
      return true;
    case "F4":
      ui.prompt(
        "edit-replace",
        "Replace",
        `Replace "${editor.search}" with:`,
        editor.replace,
        "Replace all",
      );
      return true;
    case "F10":
    case "Esc":
      if (editor.modified) {
        ui.confirm(
          "edit-discard",
          "Unsaved changes",
          "Discard them and close the editor?",
          "Discard",
        );
      } else {
        editor.close();
      }
      return true;
    case "Space":
      editor.insert(" ");
      return true;

    // ── mc's editor bindings ────────────────────────────────────────
    case "C-Left":
    case "S-C-Left":
    case "C-S-Left":
      editor.moveWord(-1, shift);
      return true;
    case "C-Right":
    case "S-C-Right":
    case "C-S-Right":
      editor.moveWord(1, shift);
      return true;
    case "M-BS":
      editor.eraseWord(-1);
      return true;
    case "M-d":
      editor.eraseWord(1);
      return true;
    case "C-k":
      editor.deleteToEnd();
      return true;
    case "C-Up":
      editor.scroll(-1);
      return true;
    case "C-Down":
      editor.scroll(1);
      return true;
    case "C-PgUp":
      editor.onScreen("top");
      return true;
    case "C-PgDn":
      editor.onScreen("bottom");
      return true;
    case "Ins":
      editor.toggleOverwrite();
      return true;
    case "M-l":
      ui.prompt("edit-goto", "Go to line", "Line:", "", "Go");
      return true;
    case "M-b":
      editor.matchBracket();
      return true;
    case "M-n":
      editor.toggleNumbers();
      return true;
    case "M-_":
      editor.toggleTabs();
      return true;
    case "M-s":
      // mc puts the syntax toggle on C-s; C-s is Save here and in every other
      // editor a user of this one has open, so the toggle moves rather than the
      // save. The only deliberate divergence in this table.
      editor.toggleSyntax();
      return true;
    case "M-k":
      editor.toggleBookmark();
      return true;
    case "M-j":
      editor.stepBookmark(1);
      return true;
    case "M-i":
      editor.stepBookmark(-1);
      return true;
    case "M-o":
      editor.clearBookmarks();
      return true;
    case "M-Tab":
      editor.complete();
      return true;
    case "M-+":
      editor.stepFile(1);
      return true;
    case "M--":
      editor.stepFile(-1);
      return true;
    case "M-E":
      run("history.files");
      return true;
    case "F12":
      ui.prompt("edit-save-as", "Save as", "File name:", editor.path, "Save");
      return true;
    case "C-n":
      ui.prompt("edit-new", "Edit new file", "Name:", "", "Edit");
      return true;
    case "C-f":
      ui.prompt("edit-block-save", "Save block", "File name:", "", "Save");
      return true;
    case "S-F5":
      ui.prompt("edit-insert-file", "Insert file", "File name:", "", "Insert");
      return true;
    case "S-F7":
      editor.find(editor.search);
      return true;
    case "S-F4":
      editor.replaceAll(editor.search, editor.replace);
      return true;
    case "C-q":
      ui.prompt(
        "edit-literal",
        "Insert literal",
        "Character, or a code like 0x0c:",
        "",
        "Insert",
      );
      return true;
    case "C-l":
      return true; // a redraw: this renderer is always current
    case "F1":
      run("help");
      return true;
    case "F9":
      run("menu.open");
      return true;
    case "F11":
      run("menu.user");
      return true;
    case "C-o":
      editor.close();
      run("shell.toggle");
      return true;
    // mc's own clipboard chords, alongside the CUA ones above.
    case "C-Ins":
      editor.copySelection();
      return true;
    case "S-Ins":
      editor.paste();
      return true;
    case "S-Del":
      editor.cutSelection();
      return true;
    case "C-u":
      editor.undoEdit();
      return true;
    case "M-r":
      editor.redoEdit();
      return true;
    // Selecting to the ends of the file, the screen, or by scrolling.
    case "C-S-Home":
      editor.jump(false, true);
      return true;
    case "C-S-End":
      editor.jump(true, true);
      return true;
    case "C-S-PgUp":
      editor.onScreen("top", true);
      return true;
    case "C-S-PgDn":
      editor.onScreen("bottom", true);
      return true;
    case "C-S-Up":
      editor.move(-1, 0, true);
      return true;
    case "C-S-Down":
      editor.move(1, 0, true);
      return true;
    case "M-e":
      run("charset");
      return true;
    case "M-m":
      ui.prompt("edit-mail", "Mail this file", "To:", "", "Send");
      return true;
    case "C-p":
      editor.spell();
      return true;
    case "M-Enter":
      editor.findWord();
      return true;

    // Column (rectangular) blocks.
    case "S-F3":
      editor.toggleColumnMode();
      return true;
    case "M-Up":
      editor.markColumn(-1, 0);
      return true;
    case "M-Down":
      editor.markColumn(1, 0);
      return true;
    case "M-Left":
      editor.markColumn(0, -1);
      return true;
    case "M-Right":
      editor.markColumn(0, 1);
      return true;
    case "M-PgUp":
      editor.markColumn(-editor.viewport, 0);
      return true;
    case "M-PgDn":
      editor.markColumn(editor.viewport, 0);
      return true;

    // The block tools.
    case "M-t":
      editor.transformBlock("sort");
      return true;
    case "M-p":
      editor.transformBlock("format");
      return true;
    case "M-u":
      ui.prompt(
        "edit-filter",
        "Run block through a command",
        "Command:",
        "sort -u",
        "Run",
      );
      return true;
    // A terminal spells Shift+F1/F2 as F11/F12, and mc's keymap uses those
    // names; a window has both, so both are bound.
    case "S-F1":
      run("menu.user");
      return true;
    case "S-F2":
    case "C-F2":
      ui.prompt("edit-save-as", "Save as", "File name:", editor.path, "Save");
      return true;
    case "S-Enter":
      // mc's Return: a newline with no auto-indent, for when the indentation
      // the editor would guess is not the one you want.
      editor.insert("\n");
      return true;
  }

  // Anything that is one printable character is typing.
  if (c.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    editor.insert(c);
    return true;
  }
  return false;
}

/** The viewer is a mode: while it is up it owns the keyboard, exactly as
 *  mcview does inside mc — and with mcview's bindings, which are the reason a
 *  `less` user can drive it without being told: `/` and `?` search, `n` and
 *  `N` repeat, `d` and `u` are half pages, `g` and `G` are the ends.
 *
 *  Returns true when the key was consumed. */
/** mc's `[viewer:hex]` — a keymap of its own, because hex mode is a different
 *  thing to be looking at. The cursor is a byte, not a line; Tab moves between
 *  the hex columns and the text; and with F2 on, the letters that navigate a
 *  hex VIEW are the digits that edit a hex FILE.
 *
 *  Returns true when the key belonged to hex mode. */
function hexKey(c: string, e: KeyboardEvent): boolean {
  if (!viewer.visible || viewer.mode !== "hex") return false;
  const row = 16;
  const page = Math.max(1, viewer.viewport) * row;

  switch (c) {
    case "F2":
      viewer.toggleHexEdit();
      return true;
    case "F6":
      viewer.saveHex();
      return true;
    case "Tab":
      // mc offers this only while editing; outside it there is no cursor for
      // the two columns to mean anything about.
      if (!viewer.hexEdit) return false;
      viewer.toggleHexColumn();
      return true;
  }

  // Below here everything moves the cursor, which only exists while editing.
  if (!viewer.hexEdit) return false;

  switch (c) {
    case "Left":
      viewer.moveHex(-1);
      return true;
    case "Right":
      viewer.moveHex(1);
      return true;
    case "Up":
      viewer.moveHex(-row);
      return true;
    case "Down":
      viewer.moveHex(row);
      return true;
    case "PgUp":
      viewer.moveHex(-page);
      return true;
    case "PgDn":
      viewer.moveHex(page);
      return true;
    case "Home":
    case "C-a":
      viewer.showByte(viewer.hexCursor - (viewer.hexCursor % row));
      return true;
    case "End":
    case "C-e":
      viewer.showByte(viewer.hexCursor - (viewer.hexCursor % row) + row - 1);
      return true;
    case "C-Home":
      viewer.showByte(0);
      return true;
    case "C-End":
      viewer.showByte(Math.max(0, viewer.size - 1));
      return true;
  }

  // A printable key edits the byte under the cursor. Ctrl and Alt keep their
  // meanings, so the rest of the viewer's chords still work while editing.
  if (c.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    viewer.typeHex(c);
    return true;
  }
  return false;
}

function viewerKey(c: string, e: KeyboardEvent): boolean {
  if (!viewer.visible) return false;
  if (hexKey(c, e)) return true;
  const half = Math.max(1, Math.floor(viewer.viewport / 2));
  switch (c) {
    // ── moving ──────────────────────────────────────────────────────
    case "Up":
    case "C-p":
    case "k":
    case "y":
    case "Ins":
      viewer.scroll(-1);
      return true;
    case "Down":
    case "C-n":
    case "j":
    case "e":
    case "Del":
    case "Enter":
      viewer.scroll(1);
      return true;
    case "PgUp":
    case "M-v":
    case "b":
    case "BS":
      viewer.scroll(-viewer.viewport);
      return true;
    case "PgDn":
    case "C-v":
    case "Space":
    case "f":
      viewer.scroll(viewer.viewport);
      return true;
    case "d":
      viewer.scroll(half);
      return true;
    case "u":
      viewer.scroll(-half);
      return true;
    case "Home":
    case "C-Home":
    case "C-PgUp":
    case "M-<":
    case "g":
      viewer.top();
      return true;
    case "End":
    case "C-End":
    case "C-PgDn":
    case "M->":
    case "G":
      viewer.bottom();
      return true;
    case "C-a":
      viewer.scrollColumn(-viewer.column); // to column 0, mc's Home
      return true;
    case "C-e":
      // mc's End: the far end of the longest line in view, so the tail of a
      // wide record is one keystroke away.
      viewer.scrollColumn(viewer.lineEnd());
      return true;
    case "Left":
    case "h":
      viewer.scrollColumn(-1);
      return true;
    case "Right":
    case "l":
      viewer.scrollColumn(1);
      return true;
    case "C-Left":
      viewer.scrollColumn(-half);
      return true;
    case "C-Right":
      viewer.scrollColumn(half);
      return true;

    // ── what it looks like ──────────────────────────────────────────
    case "F2":
      viewer.toggleWrap();
      return true;
    case "F4":
      viewer.toggleMode();
      return true;
    case "M-r":
      viewer.toggleRuler();
      return true;
    case "M-e":
      run("charset");
      return true;
    case "F9":
      viewer.toggleNroff();
      return true;
    case "C-f":
      viewer.stepFile(1);
      return true;
    case "C-b":
      viewer.stepFile(-1);
      return true;
    case "F1":
      run("help");
      return true;
    case "M-E":
      run("history.files");
      return true;
    case "C-o":
      // mc drops to the shell from the viewer; here the shell is a view, so
      // the overlay steps aside for it.
      viewer.close();
      run("shell.toggle");
      return true;

    // ── finding things ──────────────────────────────────────────────
    case "F7":
      ui.prompt(
        "view-search",
        "Search",
        "Text:",
        viewer.search,
        "Find",
        searchSwitches(),
      );
      return true;
    case "/":
      ui.prompt(
        "view-search",
        "Search forward",
        "Text:",
        viewer.search,
        "Find",
        searchSwitches(),
      );
      return true;
    case "?":
      ui.prompt(
        "view-search-back",
        "Search backward",
        "Text:",
        viewer.search,
        "Find",
        searchSwitches(),
      );
      return true;
    case "n":
    case "S-F7":
    case "C-s":
      viewer.find(viewer.search);
      return true;
    case "N":
    case "C-r":
      viewer.find(viewer.search, true);
      return true;
    case "F5":
      ui.prompt("view-goto", "Go to", "Line, or N%:", "", "Go");
      return true;

    // ── places ──────────────────────────────────────────────────────
    case "r":
      viewer.mark();
      return true;
    case "m":
      viewer.toMark();
      return true;

    // ── leaving ─────────────────────────────────────────────────────
    case "F3":
    case "F10":
    case "Esc":
    case "q":
      viewer.close();
      return true;
  }
  // Digits and anything else fall through to the panel bindings below only if
  // they are not printable: a stray letter must not reach the file manager and
  // start a copy.
  return c.length === 1 && !e.ctrlKey && !e.altKey;
}

/** The diff viewer is a mode, like the viewer and the editor: while it is up it
 *  owns the keyboard, with mc's diffviewer bindings — `n`/`p` between
 *  differences, F5 to merge, F2 to save, `s`/`l` for the two display toggles. */
function diffKey(c: string): boolean {
  if (!diff.visible) return false;
  const half = Math.max(1, Math.floor(diff.viewport / 2));
  switch (c) {
    // between differences — the reason the view exists
    case "n":
    case "Enter":
    case "Space":
      diff.stepHunk(1);
      return true;
    case "p":
    case "BS":
      diff.stepHunk(-1);
      return true;

    // line by line
    case "Down":
      diff.move(1);
      return true;
    case "Up":
      diff.move(-1);
      return true;
    case "PgDn":
      diff.move(diff.viewport);
      return true;
    case "PgUp":
      diff.move(-diff.viewport);
      return true;
    case "C-Left":
      diff.move(-half);
      return true;
    case "C-Right":
      diff.move(half);
      return true;
    case "Home":
    case "C-Home":
    case "g":
      diff.jump(false);
      return true;
    case "End":
    case "C-End":
    case "G":
      diff.jump(true);
      return true;

    // merging and saving
    case "F5":
      diff.merge("left");
      return true;
    case "S-F5":
      diff.merge("right");
      return true;
    case "F2":
      diff.save();
      return true;
    case "C-u":
      diff.swap();
      return true;

    // sideways, together
    case "Left":
      diff.scrollColumn(-1);
      return true;
    case "Right":
      diff.scrollColumn(1);
      return true;

    // the divider and the tab stops
    case "f":
      diff.setSplit("full");
      return true;
    case "=":
      diff.setSplit("equal");
      return true;
    case ">":
      diff.setSplit("more");
      return true;
    case "<":
      diff.setSplit("less");
      return true;
    case "2":
    case "3":
    case "4":
    case "8":
      diff.setTabWidth(Number(c));
      return true;

    // what it looks like
    case "s":
    case "M-s":
      diff.toggleSymbols();
      return true;
    case "l":
    case "M-n":
      diff.toggleNumbers();
      return true;

    // the other tools, on the file under the cursor
    case "F4":
      diff.close();
      run("file.edit");
      return true;
    case "S-F4":
      // The OTHER file — mc's F14. Which one that is depends on which panel is
      // active, so switching first is the whole of it.
      diff.close();
      run("panel.switch");
      run("file.edit");
      return true;
    case "F1":
      run("help");
      return true;
    case "F7":
      ui.prompt("diff-search", "Search", "Text:", diff.search, "Find");
      return true;
    case "S-F7":
      diff.find(diff.search);
      return true;
    case "F9":
      diff.toggleWhitespace();
      return true;
    case "M-e":
      run("charset");
      return true;
    case "C-o":
      diff.close();
      run("shell.toggle");
      return true;
    case "C-r":
      diff.swap();
      return true;
    case "F10":
    case "q":
    case "Q":
    case "Esc":
      diff.close();
      return true;
  }
  return false;
}

/** Pending first key of a two-key sequence (`C-x` …). Module-level because it
 *  belongs to the keyboard, not to any component that may re-render. */
let pending: string | null = null;

/** Keyboard macros (C-r in the editor), mc's flow exactly: C-r starts
 *  recording, C-r stops it and then the NEXT key pressed becomes the macro's
 *  hotkey. Pressing that key afterwards replays the chords.
 *
 *  Module-level, like `pending`, and for the same reason: this belongs to the
 *  keyboard. Replay goes back through `handleKey`, so a macro can do anything a
 *  user can — including opening a dialog, which is why replay stops at one. */
let recording: string[] | null = null;
let awaitingHotkey: string[] | null = null;
const macros = new Map<string, string[]>();
let replaying = false;

function macroKey(c: string, e: KeyboardEvent): boolean {
  // Waiting to be told which key this macro answers to.
  if (awaitingHotkey) {
    if (c === "Esc") {
      awaitingHotkey = null;
      ui.say("Macro discarded");
      return true;
    }
    macros.set(c, awaitingHotkey);
    ui.say(`Macro on ${c} — ${awaitingHotkey.length} keys`);
    awaitingHotkey = null;
    return true;
  }

  // C-r toggles recording while the editor is up.
  if (c === "C-r" && editor.visible) {
    if (recording) {
      awaitingHotkey = recording;
      recording = null;
      ui.say("Press the key this macro should answer to (Esc to discard)");
    } else {
      recording = [];
      ui.say("Recording a macro — C-r again to stop");
    }
    return true;
  }

  if (recording) recording.push(c);

  const macro = macros.get(c);
  if (macro && !replaying) {
    replaying = true;
    try {
      for (const chord of macro) {
        handleKey({ ...e, key: chord, __chord: chord } as never);
      }
    } finally {
      replaying = false;
    }
    return true;
  }
  return false;
}

/** Type-ahead buffer (C-s). Null when type-ahead is not active — the panel
 *  shows the buffer, so the user can always see what they are searching for. */
let quick: string | null = null;

/** An open pulldown owns the keyboard, as it does in mc: Left/Right walk the
 *  bar, Up/Down the items, Enter runs the highlighted one, Esc gives up. A menu
 *  you can only reach with the mouse is not this application's menu. */
function menuKey(c: string): boolean {
  const menu = menuAt(ui.menu);
  if (!menu) return false;
  switch (c) {
    case "Left":
    case "Right": {
      const next = menuAt(stepMenu(menu.id, c === "Right" ? 1 : -1))!;
      ui.openMenu(next.id, firstItem(next));
      return true;
    }
    case "Up":
      ui.setMenuIndex(stepItem(menu, ui.menuIndex, -1));
      return true;
    case "Down":
      ui.setMenuIndex(stepItem(menu, ui.menuIndex, 1));
      return true;
    case "Home":
      ui.setMenuIndex(firstItem(menu));
      return true;
    case "End":
      ui.setMenuIndex(stepItem(menu, menu.items.length, -1));
      return true;
    case "Enter": {
      const item = menu.items[ui.menuIndex];
      ui.openMenu(null);
      if (item && item !== "separator") {
        // Left/Right act on their own panel, not on the active one.
        if (menu.side) runFor(menu.side, item.cmd);
        else run(item.cmd);
      }
      return true;
    }
    case "Esc":
    case "F9":
      ui.openMenu(null);
      return true;
  }
  return false;
}

/** The find dialog is a mode too: its list takes the arrow keys. */
function findKey(c: string): boolean {
  if (!find.visible) return false;
  switch (c) {
    case "Up":
      find.move(-1);
      return true;
    case "Down":
      find.move(1);
      return true;
    case "Esc":
      find.hide();
      return true;
    case "Enter":
      if (find.hits.length > 0) find.goto();
      else find.start(find.root, find.mask, find.content);
      return true;
  }
  return false;
}

/** The tree panel is a mode inside a panel: while the active side shows the
 *  tree, the arrows walk branches instead of rows, and Enter takes the OTHER
 *  panel to the selected directory — mc's arrangement, where the tree is a
 *  navigator for its partner rather than a second file list. */
function treeKey(c: string): boolean {
  if (panels.activePanel().view !== "tree") return false;
  switch (c) {
    case "Up":
      tree.move(-1);
      return true;
    case "Down":
      tree.move(1);
      return true;
    case "PgUp":
      tree.move(-tree.viewport);
      return true;
    case "PgDn":
      tree.move(tree.viewport);
      return true;
    case "Home":
      tree.setCursor(0);
      return true;
    case "End":
      tree.setCursor(tree.count - 1);
      return true;
    case "Space":
      tree.toggle();
      return true;
    case "Right":
    case "+":
      tree.expand(tree.selected());
      return true;
    case "Left":
    case "-":
      tree.collapse(tree.selected());
      return true;
    case "Enter": {
      const path = tree.selected();
      if (path) {
        panels.chdir(panels.active === "left" ? "right" : "left", path);
        tree.move(1);
      }
      return true;
    }
    case "Esc":
      panels.setView(panels.active, "list");
      return true;

    // mc's [tree] function row.
    case "F1":
      run("help");
      return true;
    case "F2":
    case "C-r":
      tree.reread();
      return true;
    case "F3":
      tree.forget();
      return true;
    case "F4":
      // mc's "Toggle navigation": with it on, the arrows move the OTHER panel
      // as they move here. Here that is what Enter does explicitly, so F4
      // toggles the same idea: follow the cursor, or wait to be told.
      tree.toggleFollow();
      return true;
    case "F5":
      run("file.copy");
      return true;
    case "F6":
      run("file.move");
      return true;
    case "F8":
    case "Del":
      run("file.delete");
      return true;
    case "C-s":
    case "M-s":
      run("search.quick");
      return true;
  }
  return false;
}

/** Type-ahead: printable keys extend the search, Backspace trims it, anything
 *  else ends it. mc's C-s, which is the fastest way to reach a known name. */
function quickKey(c: string, e: KeyboardEvent): boolean {
  if (quick === null) return false;
  if (c === "BS") {
    quick = quick.slice(0, -1);
    panels.quickSearch(quick);
    return true;
  }
  if (c.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    quick += c;
    panels.quickSearch(quick);
    return true;
  }
  // Esc/Enter/arrows leave the mode; the key itself still does its job.
  quick = null;
  panels.quickSearch("");
  return c === "Esc";
}

function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" ||
    el?.isContentEditable === true;
}

/** mc's `[input]` keymap, for whichever field has focus.
 *
 *  A browser `<input>` brings some of this for free and none of it reliably:
 *  `C-k`, `M-d` and `M-BS` do nothing on Linux, and in an Electron window `C-w`
 *  is the shortcut that closes it. mc's input line has had these keys since
 *  1994 and the muscle memory is real, so the field gets its own layer.
 *
 *  Returns true when the key was the field's. */
function fieldKey(c: string, target: EventTarget | null): boolean {
  const el = target as HTMLInputElement | null;
  if (!el || el.tagName !== "INPUT" || el.type === "checkbox") return false;

  const value = el.value;
  const at = el.selectionStart ?? value.length;
  const to = el.selectionEnd ?? at;
  /** Replace `[from, until)` with `text` and leave the caret after it. */
  const splice = (from: number, until: number, text = "") => {
    el.value = value.slice(0, from) + text + value.slice(until);
    const caret = from + text.length;
    el.setSelectionRange(caret, caret);
    // The field is a controlled input on the client side of both the command
    // line and the dialog: they read what was TYPED, so a programmatic edit has
    // to look like typing or Enter would submit the value from before it.
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  /** The start of the word to the left of `i`, mc's word rule: skip the run of
   *  separators first, then the run of word characters. */
  const wordLeft = (i: number): number => {
    let j = i;
    while (j > 0 && /\s/.test(value[j - 1]!)) j--;
    while (j > 0 && !/\s/.test(value[j - 1]!)) j--;
    return j;
  };
  const wordRight = (i: number): number => {
    let j = i;
    while (j < value.length && /\s/.test(value[j]!)) j++;
    while (j < value.length && !/\s/.test(value[j]!)) j++;
    return j;
  };

  switch (c) {
    case "C-a":
      el.setSelectionRange(0, 0);
      return true;
    case "C-e":
      el.setSelectionRange(value.length, value.length);
      return true;
    case "C-b":
      el.setSelectionRange(Math.max(0, at - 1), Math.max(0, at - 1));
      return true;
    case "C-f":
      el.setSelectionRange(
        Math.min(value.length, at + 1),
        Math.min(value.length, at + 1),
      );
      return true;
    case "M-b":
      el.setSelectionRange(wordLeft(at), wordLeft(at));
      return true;
    case "M-f":
      el.setSelectionRange(wordRight(at), wordRight(at));
      return true;
    case "C-k":
      splice(at, value.length);
      return true;
    case "M-BS":
      splice(wordLeft(at), at);
      return true;
    case "M-d":
      splice(at, wordRight(at));
      return true;
    case "C-w":
      // mc's Remove: the marked text, or — with nothing marked — the word
      // behind the caret, which is what every shell's C-w does.
      splice(at === to ? wordLeft(at) : at, to);
      return true;
    case "C-h":
      if (at !== to) splice(at, to);
      else if (at > 0) splice(at - 1, at);
      return true;
    case "M-Tab":
      void completeField(el);
      return true;
  }
  return false;
}

/** mc's viewer search switches, which its Search dialog carries and mcx's did
 *  not: a search you cannot make case-sensitive is a search you run twice. */
const searchSwitches = () => [
  { id: "searchCase", label: "Case sensitive", on: !viewer.caseInsensitive },
  { id: "wholeWords", label: "Whole words", on: viewer.wholeWords },
];

/** mc's `Complete = alt-tab`: finish the path under the caret.
 *
 *  One match completes; several insert what they all share and then say what
 *  they were, which is the behaviour of every shell and the reason the key is
 *  worth pressing before you know the answer. */
async function completeField(el: HTMLInputElement): Promise<void> {
  const at = el.selectionStart ?? el.value.length;
  const head = el.value.slice(0, at);
  // The word under the caret, as a shell would take it: up to the last
  // unescaped space.
  const wordAt = head.lastIndexOf(" ") + 1;
  const word = head.slice(wordAt);

  const r = await shell.complete(word, panels.activePanel().path);
  if (r.matches.length === 0) return void ui.say("No completions");

  if (r.common.length > word.length || r.matches.length === 1) {
    const insert = r.matches.length === 1 ? r.matches[0]! : r.common;
    el.value = el.value.slice(0, wordAt) + insert + el.value.slice(at);
    const caret = wordAt + insert.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (r.matches.length > 1) {
    ui.say(
      r.matches.slice(0, 12).join("  ") + (r.matches.length > 12 ? " …" : ""),
    );
  }
}

export function handleKey(e: KeyboardEvent & { __chord?: string }): void {
  // A replayed chord arrives already resolved; a real event is decoded.
  const c = e.__chord ?? chord(e);
  if (!e.__chord && macroKey(c, e)) {
    e.preventDefault?.();
    return;
  }

  // 1. A dialog owns the keyboard while it is open — mc's [dialog] and
  //    [listbox] sections, which is more than Esc and Enter: a hotlist of two
  //    hundred directories that cannot be paged is a list nobody reads.
  if (ui.dialog) {
    // [dialog] Cancel = esc; f10; ctrl-g.
    if (c === "Esc" || c === "F10" || c === "C-g") {
      e.preventDefault();
      // Cancelling a question a user-menu entry asked cancels the entry: a
      // command that needed an answer must not run without one.
      resolveAsk(null);
      return void ui.close();
    }
    if (c === "Enter") {
      e.preventDefault();
      return void submit();
    }
    if (ui.dialog.kind === "menu" || ui.dialog.kind === "toggles") {
      // [listbox] Up/Down/Top/Bottom/PageUp/PageDown. A page is ten rows —
      // what the modal shows before it scrolls.
      const step: Record<string, number> = {
        "Up": -1,
        "C-p": -1,
        "Down": 1,
        "C-n": 1,
        "PgUp": -10,
        "M-v": -10,
        "PgDn": 10,
        "C-v": 10,
      };
      if (c in step) {
        e.preventDefault();
        return void ui.moveChoice(step[c]!);
      }
      if (c === "Home" || c === "M-<") {
        e.preventDefault();
        return void ui.moveChoice(-1e9);
      }
      if (c === "End" || c === "M->") {
        e.preventDefault();
        return void ui.moveChoice(1e9);
      }
      // Space flips the switch under the cursor — mc's [radio] Select, and the
      // only way to work an Options dialog without a mouse.
      if (c === "Space" && ui.dialog.kind === "toggles") {
        e.preventDefault();
        const choice = ui.dialog.choices[ui.dialog.index];
        if (choice) setOption(choice.id, !choice.on);
        return;
      }
    }
    return; // typing goes to the field
  }

  // 2. Modal surfaces, in the order they stack. The pulldown is first: it is
  //    drawn over everything below it, so it must answer first too.
  if (menuKey(c)) {
    e.preventDefault();
    return;
  }
  if (diffKey(c)) {
    e.preventDefault();
    return;
  }
  if (findKey(c)) {
    e.preventDefault();
    return;
  }
  if (quickKey(c, e)) {
    e.preventDefault();
    return;
  }
  if (editorKey(c, e)) {
    e.preventDefault();
    return;
  }
  if (viewerKey(c, e)) {
    e.preventDefault();
    return;
  }
  // The tree is LAST of the four: it is a panel view, not a modal surface, so
  // an editor or a viewer opened over a tree-view panel keeps its arrow keys.
  if (treeKey(c)) {
    e.preventDefault();
    return;
  }

  // 3. A focused text field keeps ordinary typing — one printable character,
  //    unmodified — and mc's own line-editing keys. Everything else — the
  //    function row, Esc, Tab, C-x … — still belongs to the app, as in mc.
  if (!pending && inTextField(e.target) && fieldKey(c, e.target)) {
    e.preventDefault();
    return;
  }
  const cmd = resolve(c, pending);
  // `!pending` because the SECOND key of a two-key sequence belongs to the
  // sequence, not to the field: with the cursor in the command line, `C-x c`
  // would otherwise type a `c` and the chmod dialog would never open.
  if (
    inTextField(e.target) && !e.ctrlKey && !e.altKey && c.length === 1 &&
    !pending
  ) {
    return;
  }

  // 4. Two-key sequences: hold the prefix, swallow the key.
  if (cmd === "prefix") {
    pending = c;
    e.preventDefault();
    return;
  }
  pending = null;

  if (!cmd) return;
  e.preventDefault();
  // C-s opens type-ahead; the buffer lives here, the matching lives in the cell.
  if (cmd === "search.quick") quick = "";
  run(cmd);
}
