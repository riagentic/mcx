/** The pulldown menus, as data.
 *
 *  Apart from the MenuBar because the keyboard needs them too: F9 opens a menu
 *  and then the arrows walk it, which means the key handler has to know what is
 *  in it. One table, read by the component that draws it and the handler that
 *  moves through it — the alternative is a menu whose contents and whose
 *  navigation drift apart. Every item is a `Command`, so the menu can never
 *  offer something the keyboard cannot do. */

import type { Command } from "../lib/keys.ts";
import type { PanelSide } from "../type/panel.ts";
import { KEYMAP } from "../lib/keys.ts";

export type MenuItem = { label: string; cmd: Command } | "separator";
export type Menu = {
  id: string;
  label: string;
  /** The panel this menu configures, for mc's Left and Right menus: their
   *  entries act on THEIR panel, not on whichever one happens to be active.
   *  Absent on the menus that are about the program rather than a panel. */
  side?: PanelSide;
  items: MenuItem[];
};

/** The chord bound to a command, for the hint column — read from the keymap
 *  rather than retyped, so a rebinding shows up here for free. */
export const chordFor = (cmd: Command): string =>
  Object.entries(KEYMAP).find(([, c]) => c === cmd)?.[0] ?? "";

export const MENUS: Menu[] = [
  {
    id: "left",
    label: "Left",
    side: "left",
    items: [
      { label: "File listing", cmd: "view.list" },
      { label: "Quick view", cmd: "view.quick" },
      { label: "Info", cmd: "view.info" },
      { label: "Tree", cmd: "view.tree" },
      "separator",
      { label: "Listing mode", cmd: "view.mode" },
      { label: "Sort order…", cmd: "view.sortOrder" },
      { label: "Filter…", cmd: "view.filter" },
      { label: "Encoding…", cmd: "charset" },
      "separator",
      { label: "Show hidden files", cmd: "view.hidden" },
      { label: "Rescan", cmd: "panel.reload" },
    ],
  },
  {
    id: "file",
    label: "File",
    items: [
      { label: "View", cmd: "file.view" },
      { label: "View raw", cmd: "file.viewRaw" },
      { label: "Filtered view", cmd: "shell.viewFiltered" },
      { label: "Edit", cmd: "file.edit" },
      { label: "Edit new file", cmd: "file.editNew" },
      { label: "Copy", cmd: "file.copy" },
      { label: "Rename or move", cmd: "file.move" },
      { label: "Make directory", cmd: "file.mkdir" },
      { label: "Delete", cmd: "file.delete" },
      { label: "Quick cd", cmd: "dir.quickCd" },
      "separator",
      { label: "Chmod", cmd: "file.chmod" },
      { label: "Chown", cmd: "file.chown" },
      { label: "Attributes", cmd: "file.chattr" },
      { label: "Hard link", cmd: "file.hardlink" },
      { label: "Symlink", cmd: "file.symlink" },
      { label: "Relative symlink", cmd: "file.symlinkRelative" },
      { label: "Edit symlink", cmd: "file.symlinkEdit" },
      "separator",
      { label: "Select group", cmd: "mark.byMask" },
      { label: "Unselect group", cmd: "mark.unmarkByMask" },
      { label: "Invert selection", cmd: "mark.invert" },
      "separator",
      { label: "Quit", cmd: "app.quit" },
    ],
  },
  {
    id: "command",
    label: "Command",
    items: [
      { label: "User menu", cmd: "menu.user" },
      { label: "Directory tree", cmd: "view.tree" },
      { label: "Find file", cmd: "find.file" },
      { label: "Swap panels", cmd: "panel.swap" },
      { label: "Switch panels on/off", cmd: "shell.toggle" },
      { label: "Compare directories", cmd: "panel.compare" },
      { label: "Compare files", cmd: "file.compare" },
      { label: "External panelize", cmd: "shell.panelize" },
      { label: "Show directory sizes", cmd: "dir.size" },
      { label: "Sync other panel", cmd: "panel.syncOther" },
      "separator",
      { label: "Command history", cmd: "cmd.history" },
      { label: "Viewed and edited files", cmd: "history.files" },
      { label: "Directory hotlist", cmd: "dir.hotlist" },
      { label: "Active VFS list", cmd: "vfs.list" },
      { label: "Background jobs", cmd: "jobs" },
      { label: "Screen list", cmd: "screen.list" },
      "separator",
      { label: "Edit extension file", cmd: "file.editExtFile" },
      { label: "Edit menu file", cmd: "file.editMenuFile" },
    ],
  },
  {
    id: "options",
    label: "Options",
    items: [
      { label: "Configuration…", cmd: "options.configuration" },
      { label: "Layout…", cmd: "options.layout" },
      { label: "Panel options…", cmd: "options.panel" },
      { label: "Confirmation…", cmd: "options.confirmation" },
      { label: "Appearance…", cmd: "options.appearance" },
      "separator",
      { label: "Split vertical/horizontal", cmd: "layout.splitToggle" },
      { label: "Equal split", cmd: "layout.splitEqual" },
      "separator",
      { label: "Help", cmd: "help" },
      { label: "About", cmd: "app.about" },
    ],
  },
  {
    id: "right",
    label: "Right",
    side: "right",
    items: [
      { label: "File listing", cmd: "view.list" },
      { label: "Quick view", cmd: "view.quick" },
      { label: "Info", cmd: "view.info" },
      { label: "Tree", cmd: "view.tree" },
      "separator",
      { label: "Listing mode", cmd: "view.mode" },
      { label: "Sort order…", cmd: "view.sortOrder" },
      { label: "Filter…", cmd: "view.filter" },
      { label: "Encoding…", cmd: "charset" },
      "separator",
      { label: "Show hidden files", cmd: "view.hidden" },
      { label: "Rescan", cmd: "panel.reload" },
    ],
  },
];

export const menuAt = (id: string | null): Menu | undefined =>
  MENUS.find((m) => m.id === id);

/** The next selectable row in `menu`, `delta` away from `from`, skipping
 *  separators and stopping at the ends — mc's menus do not wrap. Returns
 *  `from` when there is nowhere to go, so a held arrow key rests at the edge
 *  instead of oscillating. */
export function stepItem(menu: Menu, from: number, delta: number): number {
  for (let i = from + delta; i >= 0 && i < menu.items.length; i += delta) {
    if (menu.items[i] !== "separator") return i;
  }
  return from;
}

/** The first selectable row — where a freshly opened menu puts its highlight. */
export const firstItem = (menu: Menu): number =>
  menu.items.findIndex((i) => i !== "separator");

/** The menu `delta` along the bar, wrapping — Left/Right at the ends of the bar
 *  continue round, which is what mc does. */
export function stepMenu(id: string | null, delta: number): string {
  const i = MENUS.findIndex((m) => m.id === id);
  const next = (i + delta + MENUS.length) % MENUS.length;
  return MENUS[next]!.id;
}
