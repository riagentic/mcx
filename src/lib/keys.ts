/** Key handling: a browser KeyboardEvent → a chord string → a command id.
 *
 *  Pure and table-driven on purpose. mc's bindings are muscle memory measured
 *  in decades; they belong in one readable table that a user can diff against
 *  `mc --help`, not scattered across handlers. */

/** The subset of KeyboardEvent this module needs — so it is testable without
 *  a DOM. */
export type KeyLike = {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
};

const NAMED: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Insert: "Ins",
  Delete: "Del",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "BS",
  " ": "Space",
};

/** Canonical chord: `C-` control, `M-` alt (meta), `S-` shift on named keys.
 *  Shift is folded into the character for printable keys (`+`, `*`), because
 *  that is how the user thinks about it. */
export function chord(e: KeyLike): string {
  // A key is either a single printable character or a NAME (`F5`, `PgUp`) —
  // and only names take the `S-` prefix, because shift on a character has
  // already changed the character.
  const base = NAMED[e.key] ?? e.key;
  const named = base.length > 1;
  let out = "";
  if (e.ctrlKey) out += "C-";
  if (e.altKey) out += "M-";
  if (e.shiftKey && named) out += "S-";
  return out + base;
}

/** Every command mcx can be asked to perform. A closed union so a keymap typo
 *  is a type error rather than a key that silently does nothing. */
export type Command =
  // navigation
  | "cursor.up"
  | "cursor.down"
  | "cursor.left"
  | "cursor.right"
  | "cursor.pageUp"
  | "cursor.pageDown"
  | "cursor.top"
  | "cursor.bottom"
  | "cursor.topScreen"
  | "cursor.middleScreen"
  | "cursor.bottomScreen"
  | "view.scrollLeft"
  | "view.scrollRight"
  | "panel.enter"
  | "panel.otherCd"
  | "panel.otherCdLink"
  | "panel.up"
  | "panel.switch"
  | "panel.swap"
  | "panel.reload"
  | "panel.syncOther"
  | "panel.compare"
  | "file.compare"
  | "panel.cdRoot"
  | "panel.cdHome"
  // marking
  | "mark.toggle"
  | "mark.up"
  | "mark.down"
  | "mark.all"
  | "mark.none"
  | "mark.invert"
  | "mark.byMask"
  | "mark.unmarkByMask"
  // view options
  | "view.hidden"
  | "view.mode"
  | "view.sortName"
  | "view.sortExt"
  | "view.sortSize"
  | "view.sortTime"
  | "view.filter"
  | "view.info"
  | "view.tree"
  | "view.quick"
  | "view.list"
  // the function keys
  | "help"
  | "menu.user"
  | "file.view"
  | "file.edit"
  | "file.copy"
  | "file.move"
  | "file.mkdir"
  | "file.delete"
  | "menu.open"
  | "menu.lastSelected"
  | "app.quit"
  // dialogs / chrome
  | "find.file"
  | "dir.hotlist"
  | "dir.hotAdd"
  | "dir.size"
  | "dir.quickCd"
  | "history.dir"
  | "history.next"
  | "history.prev"
  | "cmd.focus"
  | "cmd.history"
  | "cmd.historyPrev"
  | "cmd.historyNext"
  | "search.quick"
  | "screen.refresh"
  | "file.chmod"
  | "file.chown"
  | "file.chattr"
  | "file.symlink"
  | "file.symlinkRelative"
  | "file.symlinkEdit"
  | "file.hardlink"
  | "file.rename"
  | "file.viewRaw"
  | "file.editNew"
  | "file.copySingle"
  | "file.moveSingle"
  | "file.deleteSingle"
  | "cmd.insertName"
  | "cmd.insertFullName"
  | "cmd.insertPath"
  | "cmd.insertOtherPath"
  | "cmd.insertTagged"
  | "cmd.insertOtherTagged"
  | "cmd.insertLink"
  | "cmd.insertOtherLink"
  | "shell.toggle"
  | "shell.viewFiltered"
  | "shell.panelize"
  | "history.files"
  | "screen.list"
  | "charset"
  | "app.about"
  | "file.editExtFile"
  | "file.editMenuFile"
  | "view.sortOrder"
  | "options.configuration"
  | "options.layout"
  | "options.panel"
  | "options.confirmation"
  | "options.appearance"
  | "vfs.list"
  | "jobs"
  | "layout.splitToggle"
  | "layout.splitEqual"
  | "layout.splitMore"
  | "layout.splitLess"
  | "app.quitQuiet"
  | "dialog.cancel"
  | "dialog.ok";

/** mc's default filemanager bindings. Two-key sequences use a space
 *  (`C-x c`), and the dispatcher holds the prefix between keystrokes. */
export const KEYMAP: Readonly<Record<string, Command>> = {
  // movement — the second spelling of each is mc's emacs-flavoured alias,
  // which its own default keymap ships (`Down = down; ctrl-n`).
  "Up": "cursor.up",
  "C-p": "cursor.up",
  "Down": "cursor.down",
  "C-n": "cursor.down",
  "Left": "cursor.left",
  "Right": "cursor.right",
  "PgUp": "cursor.pageUp",
  "M-v": "cursor.pageUp",
  "PgDn": "cursor.pageDown",
  "C-v": "cursor.pageDown",
  "Home": "cursor.top",
  "M-<": "cursor.top",
  "End": "cursor.bottom",
  "M->": "cursor.bottom",
  "M-g": "cursor.topScreen",
  "M-r": "cursor.middleScreen",
  "M-j": "cursor.bottomScreen",
  "C-Home": "panel.cdRoot",
  "C-End": "panel.cdHome",
  "C-PgUp": "panel.up",
  "C-PgDn": "panel.enter",
  "Enter": "panel.enter",
  "Tab": "panel.switch",
  "C-i": "panel.switch",
  "C-u": "panel.swap",
  "C-r": "panel.reload",
  "M-i": "panel.syncOther",
  "M-o": "panel.otherCd",
  "M-l": "panel.otherCdLink",
  "C-x d": "panel.compare",
  "C-x C-d": "file.compare",

  // marking
  "Ins": "mark.toggle",
  "C-t": "mark.toggle",
  "S-Up": "mark.up",
  "S-Down": "mark.down",
  "+": "mark.byMask",
  "M-+": "mark.byMask",
  "*": "mark.invert",
  "-": "mark.unmarkByMask",
  "M--": "mark.unmarkByMask",
  "M-*": "mark.invert",

  // view
  "M-.": "view.hidden",
  "M-t": "view.mode",
  "C-x q": "view.quick",
  "C-x i": "view.info",
  "M-s": "search.quick",
  "C-s": "search.quick",
  "C-l": "screen.refresh",

  // function keys — the row every mc user reads without looking
  "F1": "help",
  "F2": "menu.user",
  "F3": "file.view",
  "F4": "file.edit",
  "F5": "file.copy",
  "F6": "file.move",
  "F7": "file.mkdir",
  "F8": "file.delete",
  "F9": "menu.open",
  "S-F9": "menu.lastSelected",
  "F10": "app.quit",
  "Del": "file.delete",
  // mc's shifted function row: the same operations on the file under the
  // cursor ALONE, ignoring whatever is marked. F13–F20 are how a terminal
  // spells S-F3…S-F10, which is why mc's keymap names them that way.
  "S-F3": "file.viewRaw",
  "S-F4": "file.editNew",
  "S-F5": "file.copySingle",
  "S-F6": "file.rename",
  "S-F8": "file.deleteSingle",
  "S-F10": "app.quitQuiet",

  // dialogs
  "M-?": "find.file",
  "C-\\": "dir.hotlist",
  "C-x h": "dir.hotAdd",
  "C-Space": "dir.size",
  "M-H": "history.dir",
  "M-u": "history.next",
  "M-y": "history.prev",
  "M-c": "dir.quickCd",
  "M-h": "cmd.history",
  "M-p": "cmd.historyPrev",
  "M-n": "cmd.historyNext",
  // What goes onto the command line, mc's spellings exactly: a name, a full
  // path, the marked set, or where a link points — for this panel and (with
  // control, or a capital) for the other one.
  "M-Enter": "cmd.insertName",
  "C-Enter": "cmd.insertName",
  "C-S-Enter": "cmd.insertFullName",
  "M-a": "cmd.insertPath",
  "M-A": "cmd.insertOtherPath",
  "C-x p": "cmd.insertPath",
  "C-x C-p": "cmd.insertOtherPath",
  "C-x t": "cmd.insertTagged",
  "C-x C-t": "cmd.insertOtherTagged",
  "C-x r": "cmd.insertLink",
  "C-x C-r": "cmd.insertOtherLink",
  "C-o": "shell.toggle",
  "M-!": "shell.viewFiltered",
  "C-x !": "shell.panelize",
  "M-E": "history.files",
  "M-`": "screen.list",
  "M-e": "charset",
  "M-(": "view.scrollLeft",
  "M-)": "view.scrollRight",
  // the panel split
  "M-,": "layout.splitToggle",
  "M-=": "layout.splitEqual",
  "M-S-Right": "layout.splitMore",
  "M-S-Left": "layout.splitLess",
  "C-x c": "file.chmod",
  "C-x o": "file.chown",
  "C-x e": "file.chattr",
  "C-x a": "vfs.list",
  "C-x j": "jobs",
  "C-x l": "file.hardlink",
  "C-x s": "file.symlink",
  "C-x v": "file.symlinkRelative",
  "C-x C-s": "file.symlinkEdit",
  "Esc": "dialog.cancel",
};

/** Chords that begin a two-key sequence — the dispatcher must swallow these
 *  rather than treat them as unbound. */
export const PREFIXES: ReadonlySet<string> = new Set(
  Object.keys(KEYMAP).filter((k) => k.includes(" ")).map((k) =>
    k.split(" ")[0]!
  ),
);

/** Resolve a chord (with any pending prefix) to a command.
 *  Returns the command, `"prefix"` when more input is expected, or null. */
export function resolve(
  c: string,
  pending: string | null,
): Command | "prefix" | null {
  if (pending) return KEYMAP[`${pending} ${c}`] ?? null;
  if (PREFIXES.has(c)) return "prefix";
  return KEYMAP[c] ?? null;
}
