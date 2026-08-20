/** Command id → what it does. The single place a keystroke, a menu item and a
 *  clicked button all meet, so the three can never drift apart. */

import { diff } from "../cell/diff.ts";
import { editor } from "../cell/editor.ts";
import { fileops } from "../cell/fileops.ts";
import { find } from "../cell/find.ts";
import { ops } from "../cell/ops.ts";
import { type CompareMethod, panels } from "../cell/panels.ts";
import { shell } from "../cell/shell.ts";
import { tree } from "../cell/tree.ts";
import { type DialogChoice, ui } from "../cell/ui.ts";
import { viewer } from "../cell/viewer.ts";
import type { Command } from "../lib/keys.ts";
import { basename, entryPath } from "../lib/path.ts";
import { isRemote } from "../lib/remote.ts";
import { shellArgs, shellQuote } from "../lib/shell.ts";
import type { ListMode, PanelSide, SortKey } from "../type/panel.ts";
import { CHARSETS } from "../lib/charsets.ts";
import { clearCommandLine, commandLineText } from "./CommandLine.tsx";
import { dialogValue } from "./Dialog.tsx";
import { firstItem, MENUS } from "./menus.ts";

const MODES: ListMode[] = ["brief", "full", "long"];

/** The panel a command acts on.
 *
 *  Normally the active one — but mc's Left and Right menus configure THEIR
 *  panel whichever one has focus, which is the whole reason there are two of
 *  them. `runFor` sets this for the duration of one dispatch; every case body
 *  reads the side through `side()`, so none of them has to know. */
let forSide: PanelSide | null = null;

const active = () => panels[forSide ?? panels.active];
const side = (): PanelSide => forSide ?? panels.active;
const otherSide =
  (): PanelSide => (panels.active === "left" ? "right" : "left");

/** Rows in one column — the unit left/right arrows move by in brief mode. */
function columnStep(): number {
  const p = active();
  return Math.max(1, Math.floor(p.viewport / Math.max(1, p.columns)));
}

const current = () => panels.current();
const otherPath = () => panels.inactivePanel().path;
/** "3 files" or the one filename — what the dialogs put in their sentence. */
const label = () => panels.operandLabel();

/** Append to the command line, quoted, with the trailing space that lets the
 *  next insert land as its own argument — mc's `command_insert`. Nothing is
 *  inserted for an empty operand, so a missing link target cannot leave a
 *  stray `''` on the line. */
function insert(text: string | readonly string[]): void {
  const s = Array.isArray(text) ? shellArgs(text) : shellQuote(text as string);
  if (!text.length) return;
  // Appended to what is on the line NOW — otherwise inserting a filename after
  // typing would drop whatever had not round-tripped yet.
  ui.setCmdline(`${commandLineText()}${s} `);
  clearCommandLine();
}

/** The twelve mode bits, in mc's order: the special three, then owner, group
 *  and other. Named as mc's chmod dialog names them, because that is what the
 *  user is comparing against `ls -l`. */
const MODE_BITS: ReadonlyArray<[number, string]> = [
  [0o4000, "set user ID on execution"],
  [0o2000, "set group ID on execution"],
  [0o1000, "sticky bit"],
  [0o0400, "read by owner"],
  [0o0200, "write by owner"],
  [0o0100, "execute/search by owner"],
  [0o0040, "read by group"],
  [0o0020, "write by group"],
  [0o0010, "execute/search by group"],
  [0o0004, "read by others"],
  [0o0002, "write by others"],
  [0o0001, "execute/search by others"],
];

/** mc's Select/Unselect-group switches, with mc's defaults: files only, and
 *  case folded the way the panel's own sort is folded. */
const maskOptions = () => [
  { id: "filesOnly", label: "Files only", on: true },
  {
    id: "maskCase",
    label: "Case sensitive",
    on: panels.activePanel().caseSensitive,
  },
];

/** …and how they came back. Read from the dialog's own checkboxes, captured
 *  before it closes, so the answer is the one that was on screen. */
const maskAnswers = (cs: readonly DialogChoice[]) => {
  const on = (id: string, fallback: boolean) =>
    cs.find((c) => c.id === id)?.on ?? fallback;
  return {
    filesOnly: on("filesOnly", true),
    caseSensitive: on("maskCase", panels.activePanel().caseSensitive),
  };
};

/** F5 on an empty panel (or on `..`) must say so rather than open a dialog
 *  that can only disappoint. */
function haveOperands(what: string): boolean {
  if (panels.operandCount() > 0) return true;
  ui.say(`${what}: nothing selected`);
  return false;
}

/** Run `fn` with the files the operation acts on.
 *
 *  The list is asked of the server rather than computed here: `marked` is
 *  server-only state, so in the browser this code can see how MANY files are
 *  marked but not WHICH — and a copy that acted on the client's guess would
 *  quietly move one file instead of fifty. */
async function withSelection(
  fn: (sources: string[]) => unknown,
): Promise<void> {
  const sources = await panels.selection();
  if (sources.length === 0) return;
  try {
    await fn(sources);
  } finally {
    // The marks come off at the END of the operation, as they do in mc: they
    // stay up while it runs, because they are what the user is watching, and
    // they go whether it succeeded or not.
    //
    // A selection describes ONE operation. Left behind, it silently redirects
    // the next one: mark two files, copy them, then put the cursor on a third
    // and rename THAT — and it is the first marked file that gets renamed,
    // because `selection()` prefers marks over the cursor, while the user is
    // looking at the cursor.
    panels.unmarkAll();
  }
}

/** Flip one setting from an Options dialog. Some belong to the chrome and some
 *  to the panel, and this is the one place that knows which is which — the
 *  dialog itself only knows a name and a checkbox. */
export function setOption(name: string, on: boolean): void {
  ui.setOption(name, on);
  switch (name) {
    case "showHidden":
      panels.toggleHidden(side());
      break;
    case "dirsFirst":
      panels.setDirsFirst(side(), on);
      break;
    case "caseSensitive":
      panels.setCaseSensitive(side(), on);
      break;
    case "reverse":
      panels.setSort(side(), panels.activePanel().sort, on);
      break;
  }
}

/** Run a command as though `which` were the active panel — mc's Left/Right
 *  menus, and nothing else. */
export function runFor(which: PanelSide, cmd: Command): void {
  forSide = which;
  try {
    run(cmd);
  } finally {
    forSide = null;
  }
}

export function run(cmd: Command): void {
  const p = active();
  switch (cmd) {
    // ── cursor ───────────────────────────────────────────────────────
    case "cursor.up":
      return void panels.move(-1);
    case "cursor.down":
      return void panels.move(1);
    case "cursor.left":
      return void panels.move(-columnStep());
    case "cursor.right":
      return void panels.move(columnStep());
    case "cursor.pageUp":
      return void panels.move(-p.viewport);
    case "cursor.pageDown":
      return void panels.move(p.viewport);
    case "cursor.top":
      return void panels.setCursor(0);
    case "cursor.bottom":
      return void panels.setCursor(p.count - 1);
    case "cursor.topScreen":
      return void panels.onScreen("top");
    case "cursor.middleScreen":
      return void panels.onScreen("middle");
    case "cursor.bottomScreen":
      return void panels.onScreen("bottom");

    // ── panels ───────────────────────────────────────────────────────
    case "panel.enter": {
      // mc's rule, and the reason you can type a command without leaving the
      // panel: Enter runs the command line when there is something on it, and
      // enters the directory when there is not. Anything else means Enter does
      // two things at once — which it did, until this existed: the command ran
      // AND the panel walked into the directory under the cursor.
      // What is on the line NOW, not what the last round trip delivered.
      const typed = commandLineText().trim();
      if (typed) {
        clearCommandLine();
        ui.setCmdline("");
        return void shell.exec(typed, p.path);
      }
      // `enter` navigates directories and archives itself, and hands back a
      // plain file for someone to decide about — that decision is mc's
      // association table, and it lives in the shell cell.
      return void panels.enter().then((path) => {
        const f = current();
        if (path) shell.openFile(path, !!f && (f.mode & 0o111) !== 0);
      });
    }
    case "panel.up":
      return void panels.chdir(side(), "..");
    case "panel.switch":
      return void panels.switchPanel();
    case "panel.swap":
      return void panels.swap();
    case "panel.reload":
      return void panels.reload(side());
    case "panel.syncOther":
      return void panels.syncOther();
    case "panel.otherCd":
      return void panels.otherCd();
    case "panel.otherCdLink":
      return void panels.otherCdLink();
    case "panel.cdRoot":
      return void panels.chdir(side(), "/");
    case "panel.cdHome":
      return void panels.chdir(side(), "~");

    // ── marking ──────────────────────────────────────────────────────
    case "mark.toggle":
      return void panels.toggleMark();
    case "mark.up":
      return void panels.markMove(-1);
    case "mark.down":
      return void panels.markMove(1);
    case "mark.all":
      return void panels.markByMask("*", true, { filesOnly: false });
    case "mark.none":
      return void panels.unmarkAll();
    case "mark.invert":
      return void panels.invertMarks();
    case "mark.byMask":
      return void ui.prompt(
        "mark",
        "Select group",
        "Mask:",
        "*",
        "Select",
        maskOptions(),
      );
    case "mark.unmarkByMask":
      return void ui.prompt(
        "unmark",
        "Unselect group",
        "Mask:",
        "*",
        "Unselect",
        maskOptions(),
      );

    // ── view options ─────────────────────────────────────────────────
    case "view.hidden":
      return void panels.toggleHidden(side());
    case "view.mode": {
      // Cycling the listing format on a panel that is showing Info or a tree
      // would change something nobody can see, so this returns it to the
      // listing first — which is also the way back that mc's "Listing mode"
      // menu item gives you.
      if (p.view !== "list") {
        panels.setView(side(), "list");
        return void ui.say(`Listing mode: ${p.mode}`);
      }
      const next = MODES[(MODES.indexOf(p.mode) + 1) % MODES.length]!;
      panels.setMode(side(), next);
      return void ui.say(`Listing mode: ${next}`);
    }
    case "view.list":
      return void panels.setView(side(), "list");
    case "view.info":
      return void panels.setView(side(), p.view === "info" ? "list" : "info");
    case "view.tree": {
      const on = p.view !== "tree";
      panels.setView(side(), on ? "tree" : "list");
      // Opening the tree lands it on the directory the panel was showing —
      // anything else would make the user find their way back.
      return void (on && tree.reveal(p.path));
    }
    case "panel.compare":
      // mc asks which comparison before it makes any marks, because "thorough"
      // reads every byte of both directories and that is not a default.
      return void ui.choose("compare", "Select compare method", [
        { id: "quick", label: "Quick", hint: "size, then time" },
        { id: "size", label: "Size only", hint: "times ignored" },
        { id: "thorough", label: "Thorough", hint: "byte by byte" },
      ]);
    case "file.compare": {
      // The two files under the two cursors — mc's C-x C-d, which is the only
      // pairing a two-panel manager can mean by "compare files".
      const a = panels.current();
      const other = panels.inactivePanel();
      const b = other.rows.find((r) => r.index === other.cursor);
      if (!a || !b || a.kind === "dir" || b.kind === "dir") {
        return void ui.say("Compare: put a file under each cursor");
      }
      return void diff.open(
        entryPath(p.path, a.name),
        entryPath(other.path, b.name),
      );
    }
    case "view.quick":
      return void panels.setView(
        side(),
        p.view === "quickview" ? "list" : "quickview",
      );
    case "view.sortName":
      return void panels.setSort(side(), "name");
    case "view.sortExt":
      return void panels.setSort(side(), "ext");
    case "view.sortSize":
      return void panels.setSort(side(), "size");
    case "view.sortTime":
      return void panels.setSort(side(), "mtime");
    case "view.sortOrder": {
      // mc's "Sort order..." — one dialog for every field, with the one in
      // force marked, and "Reverse" as its own line because it is a modifier
      // rather than a sixth ordering.
      const cur = active().sort;
      const field = (id: SortKey, labelText: string) => ({
        id,
        label: labelText,
        hint: cur === id
          ? (active().reverse ? "current, reversed" : "current")
          : "",
      });
      return void ui.choose("sortorder", "Sort order", [
        field("unsorted", "Unsorted"),
        field("name", "Name"),
        field("version", "Version"),
        field("ext", "Extension"),
        field("size", "Size"),
        field("mtime", "Modify time"),
        {
          id: "reverse",
          label: "Reverse",
          hint: active().reverse ? "on" : "off",
        },
      ]);
    }
    case "cmd.historyPrev":
    case "cmd.historyNext":
      // The cell owns the line while history is being walked, so the client's
      // "what has been typed" override has to let go of it.
      ui.stepHistory(cmd === "cmd.historyPrev" ? 1 : -1);
      return void clearCommandLine();
    case "app.about":
      return void ui.message(
        "about",
        "About mcx",
        [
          "mcx — Midnight Commander X",
          "",
          "An orthodox file manager with mc's keyboard, built on aio.",
          "Its profile is ~/.mcx, and it reads nothing outside it.",
          "",
          "F1 lists the bindings.",
        ].join("\n"),
      );
    case "file.editExtFile":
      return void ui.profilePath("ext").then((path) => editor.open(path));
    case "file.editMenuFile":
      return void ui.profilePath("menu").then((path) => editor.open(path));
    case "view.filter":
      return void ui.prompt(
        "filter",
        "Filter",
        "Show files matching:",
        p.filter,
        "Apply",
      );

    // ── the function-key row ─────────────────────────────────────────
    case "help":
      return void ui.message("help", "mcx help", HELP);
    case "menu.user": {
      const f = current();
      const name = f?.name ?? "";
      // mc's own menu file first — an mc user's F2 is often years of commands.
      // `type` is mc's letters: r regular, d directory, l link, x executable.
      const type = [
        f?.kind === "dir" ? "d" : "",
        f?.kind === "link" ? "l" : "",
        f?.kind === "file" ? "r" : "",
        f && (f.mode & 0o111) !== 0 ? "x" : "",
      ].join("");
      return void ui.openUserMenu(p.path, name, type, p.markedCount > 0).then(
        (found) => {
          if (!found) {
            ui.say("No entries apply here — the menu is ~/.mcx/menu");
          }
        },
      );
    }
    case "file.view": {
      const f = current();
      if (!f || f.kind === "dir") return void ui.say("View: not a file");
      // Inside an archive the member is extracted first — the viewer opens
      // files, and a member is not one until it exists. A remote file is the
      // same problem with a different transport.
      if (p.inArchive) {
        return void panels.extractCurrent().then((tmp) => {
          if (tmp) viewer.open(tmp);
        });
      }
      if (isRemote(p.path)) {
        return void panels.fetchCurrent().then((tmp) => {
          if (tmp) viewer.open(tmp);
        });
      }
      return void viewer.open(entryPath(p.path, f.name));
    }
    case "file.edit": {
      const f = current();
      if (f && f.kind === "dir") return void ui.say("Edit: not a file");
      if (isRemote(p.path)) {
        // Fetched, then edited locally. Saving writes the copy; putting it
        // back is F5, and saying so is better than pretending the edit landed
        // on the far machine.
        return void panels.fetchCurrent().then((tmp) => {
          if (!tmp) return;
          ui.say("Editing a local copy — F5 copies it back");
          editor.open(tmp);
        });
      }
      return void editor.open(entryPath(p.path, f?.name ?? ""));
    }
    case "file.copy":
      if (!haveOperands("Copy")) return;
      return void ui.prompt(
        "copy",
        "Copy",
        `Copy ${label()} to:`,
        otherPath(),
        "Copy",
      );
    case "file.move":
      if (!haveOperands("Move")) return;
      return void ui.prompt(
        "move",
        "Move",
        `Move ${label()} to:`,
        otherPath(),
        "Move",
      );
    case "file.mkdir":
      return void ui.prompt("mkdir", "Create directory", "Name:", "", "Create");
    case "file.delete":
      if (!haveOperands("Delete")) return;
      // Options → Confirmation can turn this off; it is on by default, and the
      // dialog is the only thing between a stray F8 and the files.
      if (!ui.confirmDelete) {
        return void withSelection((src) => fileops.remove(src));
      }
      return void ui.confirm(
        "delete",
        "Delete",
        `Delete ${label()}?`,
        "Delete",
      );
    case "file.rename":
      if (!haveOperands("Rename")) return;
      return void ui.prompt(
        "rename",
        "Rename",
        "New name:",
        current()?.name ?? "",
        "Rename",
      );
    case "file.chmod": {
      if (!haveOperands("Chmod")) return;
      // mc's Chmod is a grid of the twelve bits, checked to match the file, and
      // that is what people read a mode off. The octal box stays: it is how a
      // mode gets TYPED, and `755` is faster than nine clicks. Whichever the
      // user touches last is the one that decides — see submit().
      const mode = (current()?.mode ?? 0) & 0o7777;
      return void ui.prompt(
        "chmod",
        "Chmod",
        `Mode for ${label()} (octal):`,
        mode.toString(8).padStart(4, "0"),
        "Apply",
        MODE_BITS.map(([bit, name]) => ({
          id: `bit-${bit}`,
          label: name,
          on: (mode & bit) !== 0,
        })),
      );
    }
    case "file.chattr": {
      if (!haveOperands("Attributes")) return;
      const f = current();
      if (!f) return;
      // The dialog opens on the attributes the file actually has, which means
      // asking the server first.
      return void ops.attrsOf(f.name).then((attrs) =>
        ui.prompt(
          "chattr",
          "File attributes",
          `Attributes for ${label()} (letters, e.g. ai):`,
          attrs,
          "Apply",
        )
      );
    }
    case "view.scrollLeft":
      return void panels.scrollNames(-8);
    case "view.scrollRight":
      return void panels.scrollNames(8);
    // mc's Options dialogs. Four of them, because mc has four and a user who
    // knows where a setting lives should find it in the same place.
    case "options.configuration":
      return void ui.toggles("options", "Configuration", [
        { id: "confirmDelete", label: "Confirm deletes", on: ui.confirmDelete },
        {
          id: "confirmOverwrite",
          label: "Confirm overwrites",
          on: ui.confirmOverwrite,
        },
        { id: "confirmExit", label: "Confirm quit", on: ui.confirmExit },
      ]);
    case "options.layout":
      return void ui.toggles("options", "Layout", [
        { id: "stacked", label: "Panels one above the other", on: ui.stacked },
        { id: "showMenubar", label: "Menu bar", on: ui.showMenubar },
        { id: "showCmdline", label: "Command line", on: ui.showCmdline },
        { id: "showKeybar", label: "Function key bar", on: ui.showKeybar },
        { id: "showFree", label: "Free space in the panel", on: ui.showFree },
      ]);
    case "options.panel":
      return void ui.toggles("options", "Panel options", [
        { id: "showHidden", label: "Show hidden files", on: p.showHidden },
        { id: "dirsFirst", label: "Directories first", on: p.dirsFirst },
        {
          id: "caseSensitive",
          label: "Case sensitive sort",
          on: p.caseSensitive,
        },
        { id: "reverse", label: "Reverse sort order", on: p.reverse },
      ]);
    case "options.appearance":
      return void ui.listSkins();
    case "options.confirmation":
      return void ui.toggles("options", "Confirmation", [
        { id: "confirmDelete", label: "Delete", on: ui.confirmDelete },
        { id: "confirmOverwrite", label: "Overwrite", on: ui.confirmOverwrite },
        { id: "confirmExit", label: "Quit", on: ui.confirmExit },
      ]);
    case "charset": {
      // One list, three destinations: whichever surface is in front is the one
      // being re-read. The panel is not among them — see the note in submit().
      const current = editor.visible
        ? editor.charset
        : viewer.visible
        ? viewer.charset
        : "utf-8";
      return void ui.choose(
        "charset",
        "Character set",
        CHARSETS.map((c) => ({
          id: c.label,
          label: c.name,
          hint: c.label === current ? "current" : "",
        })),
        Math.max(0, CHARSETS.findIndex((c) => c.label === current)),
      );
    }
    case "screen.list": {
      // mc's screen list. mcx has three: the panels, and whichever of the
      // viewer and the editor are holding a file — they keep their state while
      // another screen is in front, so switching back is instant.
      const items = [{ id: "panels", label: "Panels", hint: "" }];
      if (viewer.path) {
        items.push({
          id: "viewer",
          label: `View: ${viewer.title()}`,
          hint: viewer.visible ? "on screen" : "",
        });
      }
      if (editor.path) {
        items.push({
          id: "editor",
          label: `Edit: ${editor.title()}`,
          hint: editor.visible ? "on screen" : "",
        });
      }
      if (items.length === 1) return void ui.say("Nothing else is open");
      return void ui.choose("screens", "Screens", items);
    }
    case "jobs": {
      const jobs = fileops.jobs;
      if (jobs.length === 0) return void ui.say("No background jobs");
      return void ui.choose(
        "jobs",
        "Background jobs",
        jobs.map((j) => ({
          id: j.id,
          label: `${j.kind} ${basename(j.current)}`,
          hint: j.question
            ? "waiting for an answer"
            : `${fileops.percentOf()(j).toFixed(0)}%`,
        })),
      );
    }
    case "vfs.list":
      return void panels.vfsList();
    case "file.chown": {
      if (!haveOperands("Chown")) return;
      const f = current();
      return void ui.prompt(
        "chown",
        "Chown",
        `Owner for ${label()} (user, :group or user:group):`,
        f ? `${f.uid}:${f.gid}` : "",
        "Apply",
      );
    }
    case "file.symlink":
      if (!haveOperands("Symlink")) return;
      // mc's symlink box defaults the LINK to the other panel's directory —
      // "make a link over there to this file here" is the two-panel idiom, and
      // defaulting to this panel makes a link beside its own target.
      return void ui.prompt(
        "symlink",
        "Symbolic link",
        `Link to ${current()?.name ?? ""}, named:`,
        entryPath(otherPath(), current()?.name ?? ""),
        "Link",
      );
    case "file.symlinkRelative":
      // C-x v. Same dialog; the target is written relative to where the link
      // lands, so the pair survives being moved or shared as a whole.
      if (!haveOperands("Symlink")) return;
      return void ui.prompt(
        "symlink-relative",
        "Relative symbolic link",
        `Link to ${current()?.name ?? ""}, named:`,
        entryPath(otherPath(), current()?.name ?? ""),
        "Link",
      );
    case "file.symlinkEdit": {
      // C-x C-s — retarget an existing link. Only a link has a target to edit,
      // and the prompt opens on the one it has now.
      const f = current();
      if (!f || f.kind !== "link") {
        return void ui.say("Edit symlink: not a symbolic link");
      }
      return void ui.prompt(
        "symlink-edit",
        "Edit symbolic link",
        `${f.name} points to:`,
        f.target ?? "",
        "Save",
      );
    }
    case "file.hardlink":
      if (!haveOperands("Hardlink")) return;
      return void ui.prompt(
        "hardlink",
        "Hard link",
        `Link to ${current()?.name ?? ""}, named:`,
        entryPath(otherPath(), current()?.name ?? ""),
        "Link",
      );
    // mc's shifted row: the same operation, on the cursor file alone. The
    // marked set is deliberately ignored — that is the whole point of them.
    case "file.viewRaw": {
      // mc's S-F3 skips the extension filters that can turn F3 into "run this
      // file through a formatter". mcx has no such filters — the viewer always
      // shows the bytes — so raw view IS view, and the binding exists so the
      // muscle memory lands somewhere rather than nowhere.
      const f = current();
      if (!f || f.kind === "dir") return void ui.say("View: not a file");
      return void viewer.open(entryPath(p.path, f.name));
    }
    case "file.editNew":
      return void ui.prompt("edit-new", "Edit new file", "Name:", "", "Edit");
    case "file.copySingle": {
      const f = current();
      if (!f || f.name === "..") return void ui.say("Copy: nothing selected");
      return void ui.prompt(
        "copy-single",
        "Copy",
        `Copy ${f.name} to:`,
        otherPath(),
        "Copy",
      );
    }
    case "file.deleteSingle": {
      const f = current();
      if (!f || f.name === "..") return void ui.say("Delete: nothing selected");
      if (!ui.confirmDelete) {
        return void fileops.remove([entryPath(p.path, f.name)]);
      }
      return void ui.confirm(
        "delete-single",
        "Delete",
        `Delete ${f.name}?`,
        "Delete",
      );
    }
    case "app.quitQuiet":
      return void globalThis.close();
    case "menu.lastSelected":
      // S-F9 — mc reopens the bar where you left it, which is what makes a
      // repeated menu command two keystrokes instead of five.
      return void ui.openMenu(ui.lastMenu, ui.lastMenuIndex);
    case "menu.open": {
      // F9 opens the bar on its first menu, highlight on the first item that
      // is not a separator — from there the arrows take over (menuKey).
      const first = MENUS[0]!;
      return void ui.openMenu(first.id, firstItem(first));
    }
    case "app.quit":
      if (!ui.confirmExit) return void globalThis.close();
      return void ui.confirm("quit", "Quit", "Leave mcx?", "Quit", false);

    // ── chrome ───────────────────────────────────────────────────────
    case "dir.quickCd":
      return void ui.prompt("cd", "Quick cd", "Directory:", "", "Go");
    case "find.file":
      return void find.show(p.path);
    case "dir.hotlist": {
      const items = ui.hotlist.map((d) => ({ id: d, label: d }));
      if (items.length === 0) {
        return void ui.say(
          "Hotlist is empty — C-x h adds the current directory",
        );
      }
      return void ui.choose("hotlist", "Directory hotlist", items);
    }
    case "dir.size":
      return void panels.dirSize();
    case "history.next":
      return void panels.historyStep(side(), 1);
    case "history.prev":
      return void panels.historyStep(side(), -1);
    case "dir.hotAdd":
      return void ui.toggleHot(p.path);
    case "history.dir": {
      // The trail belongs to the panel, as it does in mc: the two sides have
      // been to different places.
      const items = [...p.history].reverse().slice(0, 40).map((d) => ({
        id: d,
        label: d,
      }));
      if (items.length === 0) return void ui.say("No directory history yet");
      return void ui.choose("dirhistory", "Directory history", items);
    }
    case "cmd.history": {
      const items = ui.history.slice(0, 40).map((c) => ({ id: c, label: c }));
      if (items.length === 0) return void ui.say("No command history yet");
      return void ui.choose("cmdhistory", "Command history", items);
    }
    case "search.quick":
      // The keyboard layer owns type-ahead; this only opens it.
      return void panels.quickSearch("");
    case "cmd.insertName":
      return void insert(current()?.name ?? "");
    case "cmd.insertFullName":
      return void insert(
        current() ? entryPath(p.path, current()!.name) : "",
      );
    case "cmd.insertPath":
      return void insert(p.path);
    case "cmd.insertOtherPath":
      return void insert(otherPath());
    case "cmd.insertTagged":
      return void panels.taggedNames(side()).then(insert);
    case "cmd.insertOtherTagged":
      return void panels.taggedNames(otherSide()).then(insert);
    case "cmd.insertLink":
      return void insert(current()?.target ?? "");
    case "cmd.insertOtherLink": {
      const o = panels.inactivePanel();
      return void insert(
        o.rows.find((r) => r.index === o.cursor)?.target ?? "",
      );
    }
    case "cmd.focus":
      return;
    case "layout.splitToggle":
      // The status line comes from the cell — see the note on toggleSplit.
      return void ui.toggleSplit();
    case "layout.splitEqual":
      return void ui.resizeSplit(0);
    case "layout.splitMore":
      return void ui.resizeSplit(0.05);
    case "layout.splitLess":
      return void ui.resizeSplit(-0.05);
    case "shell.viewFiltered":
      return void ui.prompt(
        "view-filtered",
        "View command output",
        "Command:",
        "",
        "View",
      );
    case "shell.panelize":
      return void ui.prompt(
        "panelize",
        "External panelize",
        "Command whose output is a list of files:",
        "",
        "Panelize",
      );
    case "history.files": {
      const items = ui.fileHistory.map((h) => ({
        id: h,
        label: h.slice(h.indexOf(":") + 1),
        hint: h.startsWith("edit:") ? "edited" : "viewed",
      }));
      if (items.length === 0) {
        return void ui.say("Nothing viewed or edited yet");
      }
      return void ui.choose("filehistory", "Viewed and edited files", items);
    }
    case "shell.toggle":
      return void ui.toggleShell();
    case "screen.refresh":
      return void panels.reload(side());
    case "dialog.cancel":
      return void ui.close();
    case "dialog.ok":
      return;
  }
}

/** Dialog confirmation. `choice` arrives from the menu kind, where the clicked
 *  item — not the text field — is the answer. */
/** Returns the promise for the dialogs that start an operation, so a caller —
 *  or a test — can wait for it; the UI itself fires and forgets. */
export function submit(choice?: string): void | Promise<void> {
  const d = ui.dialog;
  if (!d) return;
  // A question asked by `askFor` is answered here and goes no further.
  if (d.id === "ask") {
    const value = choice ?? dialogValue();
    ui.close();
    resolveAsk(value);
    return;
  }
  // `dialogValue()` rather than `d.value`: what the user typed lives on the
  // client until they submit it (see Dialog.tsx), because a round trip per
  // keystroke is a race that Enter wins.
  const value = choice ??
    (d.kind === "menu" ? d.choices[d.index]?.id ?? "" : dialogValue());
  // The checkboxes go with the value: `ui.close()` is next, and after it the
  // dialog — and every switch the user set in it — is gone.
  const choices = d.choices;
  ui.close();
  switch (d.id) {
    case "mkdir":
      return void ops.mkdir(value);
    case "copy":
      // Copying OUT of an archive is an extraction followed by an ordinary
      // copy — so it asks before overwriting, shows progress and can be
      // cancelled, exactly as every other F5 does.
      if (panels.activePanel().inArchive) {
        return void panels.stageExtract().then((staged) =>
          staged.paths.length > 0 && fileops.run("copy", staged.paths, value)
        );
      }
      return withSelection((src) => fileops.run("copy", src, value));
    case "move":
      return withSelection((src) => fileops.run("move", src, value));
    case "delete":
      return withSelection((src) => fileops.remove(src));
    case "rename":
      return withSelection((src) =>
        src[0] ? ops.rename(src[0], value) : undefined
      );
    case "chmod": {
      // Two ways to say the same thing, so the answer is whichever one the
      // user actually changed: a typed octal that differs from what the dialog
      // opened with wins, otherwise the checkboxes do.
      const typed = parseInt(value.trim(), 8);
      const opened = parseInt(d.value.trim(), 8);
      if (Number.isFinite(typed) && typed !== opened) {
        return void withSelection((paths) => ops.chmod(paths, value));
      }
      const fromBits = choices.reduce(
        (m, c) => c.on ? m | Number(c.id.slice(4)) : m,
        0,
      );
      return void withSelection((paths) =>
        ops.chmod(paths, fromBits.toString(8))
      );
    }
    case "chown":
      return withSelection((src) => ops.chown(src, value));
    case "chattr":
      return withSelection((src) => ops.chattr(src, value));
    case "screens":
      // Exactly one screen is in front; the others keep their state.
      if (value !== "viewer") viewer.hide();
      if (value !== "editor") editor.hide();
      if (value === "viewer") viewer.show();
      if (value === "editor") editor.show();
      return;
    case "jobs":
      return void fileops.bringToFront(value);
    case "vfs-free":
      return void panels.freeVfs();
    case "symlink":
      return withSelection((src) =>
        src[0] ? ops.link(src[0], value, false) : undefined
      );
    case "symlink-relative":
      return withSelection((src) =>
        src[0] ? ops.link(src[0], value, false, true) : undefined
      );
    case "symlink-edit": {
      const f = panels.current();
      return void (f && ops.retarget(f.name, value));
    }
    case "hardlink":
      return withSelection((src) =>
        src[0] ? ops.link(src[0], value, true) : undefined
      );
    case "edit-new":
      return void (value &&
        editor.open(entryPath(panels.activePanel().path, value)));
    case "copy-single": {
      const f = panels.current();
      if (!f) return;
      const src = entryPath(panels.activePanel().path, f.name);
      return void fileops.run("copy", [src], value);
    }
    case "delete-single": {
      const f = panels.current();
      if (!f) return;
      return void fileops.remove([
        entryPath(panels.activePanel().path, f.name),
      ]);
    }
    case "view-filtered":
      return void shell.viewOutput(value, panels.activePanel().path);
    case "panelize":
      return void shell.panelizeOutput(value, panels.activePanel().path);
    case "filehistory": {
      // The id remembers which tool the file came from, so it reopens where it
      // was — mc's list does the same.
      const path = value.slice(value.indexOf(":") + 1);
      return void (value.startsWith("edit:")
        ? editor.open(path)
        : viewer.open(path));
    }
    case "filter":
      return void panels.setFilter(side(), value);
    case "cd":
    case "dirhistory":
      return void panels.chdir(side(), value);
    case "hotlist":
      return void panels.chdir(side(), value);
    case "compare":
      return void panels.compare(value as CompareMethod);
    case "sortorder":
      return void (value === "reverse"
        ? panels.setSort(
          side(),
          panels.activePanel().sort,
          !panels.activePanel().reverse,
        )
        : panels.setSort(side(), value as SortKey));
    case "cmdhistory":
      return void ui.setCmdline(value);
    case "mcusermenu": {
      // An entry from mc's menu file. Its prompts are asked for first — a
      // command that expects input must not be run without it.
      const index = Number(value);
      const p = panels.activePanel();
      const other = panels.inactivePanel();
      return void (async () => {
        const prompts = await ui.promptsFor(index);
        const answers: string[] = [];
        for (const q of prompts) {
          const a = await askFor(q);
          if (a === null) return; // cancelled — nothing runs
          answers.push(a);
        }
        const [tagged, otherTagged] = await Promise.all([
          panels.taggedNames(panels.active),
          panels.taggedNames(panels.active === "left" ? "right" : "left"),
        ]);
        const script = await ui.runUserMenuEntry(index, {
          file: panels.current()?.name ?? "",
          dir: p.path,
          tagged,
          otherFile: other.rows.find((r) => r.index === other.cursor)?.name ??
            "",
          otherDir: other.path,
          otherTagged,
        }, answers);
        if (!script) return;
        ui.toggleShell();
        shell.exec(script, p.path);
      })();
    }
    case "mark":
      return void panels.markByMask(value || "*", true, maskAnswers(choices));
    case "unmark":
      return void panels.markByMask(value || "*", false, maskAnswers(choices));
    case "quit":
      return void globalThis.close();
    case "help":
      return;
    case "view-search":
    case "view-search-back":
      // The switches first: they decide what the search that follows means.
      for (const c of choices) viewer.setSearchOption(c.id, !!c.on);
      return void viewer.find(value, d.id === "view-search-back");
    case "view-goto":
      return void viewer.goto(value);
    case "edit-search":
      return void editor.find(value);
    case "edit-replace":
      return void editor.replaceAll(editor.search, value);
    case "edit-discard":
      return void editor.close();
    case "edit-goto":
      return void editor.goto(value);
    case "edit-save-as":
      return void (value && editor.save(value));
    case "edit-block-save":
      return void (value && editor.saveBlock(value));
    case "edit-insert-file":
      return void (value && editor.insertFile(value));
    case "edit-literal": {
      // `0x0c`, `12`, or the character itself — mc's C-q, which exists for the
      // control characters a keyboard cannot type.
      const n = /^0x[0-9a-f]+$/i.test(value.trim())
        ? parseInt(value.trim().slice(2), 16)
        : /^\d+$/.test(value.trim())
        ? parseInt(value.trim(), 10)
        : NaN;
      return void editor.insert(
        Number.isFinite(n) ? String.fromCharCode(n) : value,
      );
    }
    case "complete":
      return void editor.insert(value);
    case "diff-search": {
      // Find the next difference whose text contains this. A diff's search is
      // for locating a change, not for reading the file — the viewer is there
      // for that.
      return void diff.find(value);
    }
    case "edit-mail":
      return void (value && editor.mail(value, ""));
    case "spell":
      return void editor.replaceWord(value);
    case "skin":
      return void ui.setSkin(value);
    case "charset":
      // Filenames are NOT re-decodable here: Deno hands them over as strings
      // that have already been through UTF-8, so the original bytes are gone by
      // the time a panel could reinterpret them. The viewer and the editor read
      // files themselves, and both can.
      if (editor.visible) return void editor.setCharset(value);
      if (viewer.visible) return void viewer.setCharset(value);
      return void ui.say("Open a file first — filenames are decoded by the OS");
    case "edit-filter":
      return void editor.transformBlock("shell", value);
    default:
      // A dialog whose answer nothing consumes is a bug, not a shrug.
      return void ui.say(`Unhandled dialog: ${d.id}`);
  }
}

/** Ask one question and wait for the answer.
 *
 *  The dialog is the same one every prompt uses; this wraps it in a promise so
 *  a menu entry with three `%{…}` macros can ask three questions in order
 *  rather than all at once. */
let pendingAsk: ((v: string | null) => void) | null = null;

function askFor(question: string): Promise<string | null> {
  ui.prompt("ask", question, question, "", "OK");
  return new Promise((resolve) => {
    pendingAsk = resolve;
  });
}

/** Answer (or cancel) the question `askFor` is waiting on. */
export function resolveAsk(value: string | null): boolean {
  if (!pendingAsk) return false;
  pendingAsk(value);
  pendingAsk = null;
  return true;
}

const HELP = [
  "F1 help · F2 user menu · F3 view · F4 edit · F5 copy · F6 move",
  "F7 mkdir · F8 delete · F9 menu · F10 quit · S-F6 rename",
  "S-F3/4/5/8 act on the cursor file alone, ignoring what is marked",
  "Tab switch panel · Ins mark · S-Up/Down mark and move · + - * by mask",
  "M-. hidden · M-t listing mode · M-i sync · M-o other panel here · C-u swap",
  "M-, split vertical/horizontal · M-= equal · M-S-Left/Right move the divider",
  "C-PgUp up · C-PgDn enter · C-Home root · C-End home · M-g/M-r/M-j on screen",
  "C-Space directory size · M-y/M-u back and forward · M-H directory history",
  "C-s type-ahead · M-c quick cd · C-\\ hotlist · M-? find file · C-o shell",
  "M-! view a command's output · C-x ! panelize one · C-x j background jobs",
  "C-x c chmod · C-x o chown · C-x e attributes · C-x s/v/l links · C-x d compare",
  "C-x C-d compare two files · C-x q quick view · C-x i info · C-x a active VFS",
  "M-a path · M-Enter name · C-x t tagged · M-` screens · M-e character set",
  "cd sh://user@host/path opens another machine over ssh",
].join("\n");
