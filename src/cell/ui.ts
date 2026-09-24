// Chrome state: the status line, the command line, and the one modal dialog.
//
// One generic dialog rather than a cell per dialog. Every mc prompt is the same
// three shapes — ask for a string, confirm a destructive act, pick from a list —
// so they share one state shape and one keyboard contract (Enter confirms, Esc
// cancels), and adding "chmod" later costs a caller, not a component.
import { cell } from "aio";

export type DialogKind = "prompt" | "confirm" | "menu" | "message" | "toggles";

export type DialogChoice = {
  id: string;
  label: string;
  hint?: string;
  /** Set for the `toggles` kind: the checkbox's state. */
  on?: boolean;
};

export type Dialog = {
  kind: DialogKind;
  /** What the submit handler should do — `mkdir`, `delete`, `filter`, … */
  id: string;
  title: string;
  label: string;
  value: string;
  ok: string;
  /** Confirmations that destroy data are painted, and read, differently. */
  danger: boolean;
  choices: DialogChoice[];
  /** Cursor within `choices` for the menu kind. */
  index: number;
};

type UIState = {
  dialog: Dialog | null;
  /** Transient one-line feedback under the panels (mc's message area). */
  status: string;
  /** Shell command line under the panels. */
  cmdline: string;
  /** Newest first, deduplicated — mc's command history (M-h). */
  history: string[];
  /** How far back M-p has walked into it. -1 is "not browsing", which is where
   *  running a command puts it again. */
  historyPos: number;
  /** Bookmarked directories — mc's hotlist (C-\). */
  hotlist: string[];
  /** Files opened in the viewer or the editor, newest first, each tagged with
   *  the tool it was opened in (`view:` / `edit:`) so M-E reopens it where it
   *  was. mc's "Editor/Viewer history". */
  fileHistory: string[];
  /** The user's home directory. Published because the CLIENT shortens the paths
   *  it draws (`~/projects/x`) and a browser has no `$HOME` to ask. */
  home: string;
  /** Which pulldown menu is open, if any. */
  menu: string | null;
  /** Where the user menu on screen came from, and the shell lines behind each
   *  of its entries. Server-side: a menu file's commands are not the client's
   *  business, and one of them is about to be run. */
  menuSource: string;
  menuCommands: string[][];
  /** The highlighted row inside it — the menu is walkable from the keyboard,
   *  so the highlight is state, not a hover. */
  menuIndex: number;
  /** Where the menu was last left, so S-F9 can reopen it there (mc's
   *  MenuLastSelected): a repeated menu command should cost two keys, not
   *  five. Survives closing, which is the whole point. */
  lastMenu: string | null;
  lastMenuIndex: number;
  /** Panels hidden so the shell output fills the screen (C-o). */
  shellVisible: boolean;

  /** What mcx stops to ask about — mc's Options → Confirmation. Every one of
   *  these defaults to ON: a file manager that deletes without asking is one
   *  bad keystroke from a bad day, and the user who turns it off has said so. */
  confirmDelete: boolean;
  confirmOverwrite: boolean;
  confirmExit: boolean;
  /** The skin in force: its name, and the CSS variables it sets. Empty means
   *  mcx's own colours. Persisted, because a theme you have to pick again every
   *  morning is not a theme. */
  skin: string;
  skinCss: Record<string, string>;
  /** What is on screen — mc's Options → Layout. */
  showMenubar: boolean;
  showCmdline: boolean;
  showKeybar: boolean;
  showFree: boolean;

  /** Panels one above the other rather than side by side — mc's M-, . Kept as
   *  "stacked" rather than mc's `horizontal_split`, which names the divider
   *  instead of the arrangement and is read backwards by half its readers. */
  stacked: boolean;
  /** How much of the screen the FIRST panel gets (left, or top when stacked).
   *  A fraction rather than mc's column count, because this window resizes and
   *  a count would mean something different at every size. */
  splitRatio: number;
};

const MAX_HISTORY = 200;

/** The status line and the chooser, as plain functions.
 *
 *  A cell method that calls another method OF ITS OWN CELL gets a second
 *  transaction against committed state — it cannot see the write the caller is
 *  halfway through. Sharing the body instead of the method keeps one write and
 *  one commit, which is what both callers meant. */
const applySay = (s: UIState, text: string): void => {
  s.status = text;
};

const applyChoose = (
  s: UIState,
  id: string,
  title: string,
  choices: DialogChoice[],
  index = 0,
): void => {
  s.dialog = {
    kind: "menu",
    id,
    title,
    label: "",
    value: "",
    ok: "Select",
    danger: false,
    choices,
    index,
  };
};

export const ui = cell("ui", {
  // A dialog left open across a restart is a trap, and a stale status line is
  // a lie. The command history is the one thing worth keeping.
  // `home` is a fact about the machine, not a preference: it is read at boot,
  // and a restored one would be a lie on the first run after a move.
  persist: {
    exclude: [
      "dialog",
      "status",
      "menu",
      "menuSource",
      "menuCommands",
      "cmdline",
      "shellVisible",
      "home",
    ],
  },
  visible: { exclude: ["menuCommands"] },

  state: {
    dialog: null as Dialog | null,
    status: "",
    cmdline: "",
    history: [] as string[],
    historyPos: -1,
    hotlist: [] as string[],
    fileHistory: [] as string[],
    home: "",
    menu: null as string | null,
    menuSource: "",
    menuCommands: [] as string[][],
    menuIndex: 0,
    lastMenu: null as string | null,
    lastMenuIndex: 0,
    shellVisible: false,
    stacked: false,
    splitRatio: 0.5,
    skin: "",
    skinCss: {} as Record<string, string>,
    confirmDelete: true,
    confirmOverwrite: true,
    confirmExit: true,
    showMenubar: true,
    showCmdline: true,
    showKeybar: true,
    showFree: true,
  },

  methods: {
    /** Ask for a string. `id` is what the submit handler switches on.
     *
     *  `choices` are checkboxes shown under the field — mc's Select-group and
     *  Find-file dialogs are a text box plus a handful of switches, and asking
     *  for the mask in one dialog and the switches in another would be a worse
     *  version of both. */
    prompt(
      s: UIState,
      id: string,
      title: string,
      label: string,
      value = "",
      ok = "OK",
      choices: DialogChoice[] = [],
    ) {
      s.dialog = {
        kind: "prompt",
        id,
        title,
        label,
        value,
        ok,
        danger: false,
        choices,
        index: 0,
      };
    },

    /** Where a profile file lives, for the two menu entries that edit them.
     *  The path is the server's to know: `~/.mcx` is resolved there, and the
     *  client has no `$HOME` to resolve it against. */
    async profilePath(_s: UIState, which: "ext" | "menu"): Promise<string> {
      const io = await import("./profile.server.ts");
      return io.profileFile(which);
    },

    /** Flip one of a prompt's checkboxes. It belongs to the dialog rather than
     *  to a setting: "Files only" answers THIS select, not every future one. */
    setDialogChoice(s: UIState, id: string, on: boolean) {
      const c = s.dialog?.choices.find((x) => x.id === id);
      if (c) c.on = on;
    },

    /** Confirm before doing something irreversible. */
    confirm(
      s: UIState,
      id: string,
      title: string,
      label: string,
      ok = "Yes",
      danger = true,
    ) {
      s.dialog = {
        kind: "confirm",
        id,
        title,
        label,
        value: "",
        ok,
        danger,
        choices: [],
        index: 0,
      };
    },

    /** A list of switches — mc's Options dialogs. Enter or a click flips one
     *  and leaves the dialog open, because nobody changes exactly one setting
     *  and the alternative is reopening the menu four times. */
    toggles(s: UIState, id: string, title: string, choices: DialogChoice[]) {
      s.dialog = {
        kind: "toggles",
        id,
        title,
        label: "",
        value: "",
        ok: "Close",
        danger: false,
        choices,
        index: 0,
      };
    },

    /** Flip one setting by name. The dialog re-reads them, so the checkbox and
     *  the setting cannot drift. */
    setOption(s: UIState, name: string, on: boolean) {
      switch (name) {
        case "confirmDelete":
          s.confirmDelete = on;
          break;
        case "confirmOverwrite":
          s.confirmOverwrite = on;
          break;
        case "confirmExit":
          s.confirmExit = on;
          break;
        case "showMenubar":
          s.showMenubar = on;
          break;
        case "showCmdline":
          s.showCmdline = on;
          break;
        case "showKeybar":
          s.showKeybar = on;
          break;
        case "showFree":
          s.showFree = on;
          break;
        case "stacked":
          s.stacked = on;
          break;
        // The panel's own settings live in the panels cell; this only asks.
        case "showHidden":
        case "dirsFirst":
        case "caseSensitive":
        case "reverse":
          break;
      }
      // Repaint the open dialog from the settings themselves.
      if (s.dialog?.kind === "toggles") {
        s.dialog.choices = s.dialog.choices.map((c) =>
          c.id === name ? { ...c, on } : c
        );
      }
    },

    /** Pick one of a list. */
    choose(
      s: UIState,
      id: string,
      title: string,
      choices: DialogChoice[],
      index = 0,
    ) {
      applyChoose(s, id, title, choices, index);
    },

    /** Show something the user must acknowledge — an error, a help page. */
    message(s: UIState, id: string, title: string, label: string) {
      s.dialog = {
        kind: "message",
        id,
        title,
        label,
        value: "",
        ok: "OK",
        danger: false,
        choices: [],
        index: 0,
      };
    },

    /** Set the text of the open dialog from OUTSIDE the client that is typing
     *  into it — `am dispatch`, a script, a test. The dialog itself does not
     *  use this: a round trip per keystroke is a race that Enter wins, so what
     *  the user types stays on the client until they submit it. */
    typed(s: UIState, value: string) {
      if (s.dialog) s.dialog.value = value;
    },

    moveChoice(s: UIState, delta: number) {
      const d = s.dialog;
      if (!d || d.choices.length === 0) return;
      d.index = Math.max(0, Math.min(d.choices.length - 1, d.index + delta));
    },

    /** Esc. It dismisses whatever is in front of the panels — a dialog, or an
     *  open pulldown. mc's Esc always gets you back to the files, and one that
     *  left the F9 menu hanging over them would be a trap. */
    close(s: UIState) {
      s.dialog = null;
      s.menu = null;
    },

    /** The status line. Empty string clears it. */
    say(s: UIState, text: string) {
      applySay(s, text);
    },

    /** mc's M-p / M-n: step the command line back and forward through the
     *  history. `delta` of +1 is one command older.
     *
     *  Walking past the newest entry clears the line rather than sticking on
     *  it — that empty line is where you were before you started walking, and
     *  a history browser you cannot leave is a trap. */
    stepHistory(s: UIState, delta: number) {
      if (s.history.length === 0) return void ui.say("No command history");
      const next = s.historyPos + delta;
      if (next < -1) return;
      s.historyPos = Math.min(next, s.history.length - 1);
      s.cmdline = s.historyPos < 0 ? "" : s.history[s.historyPos]!;
    },

    setCmdline(s: UIState, text: string) {
      s.cmdline = text;
    },

    /** Record a command that was actually run. Newest first, no duplicates —
     *  a history full of `ls` repeated forty times is not a history. */
    remember(s: UIState, command: string) {
      s.historyPos = -1;
      const c = command.trim();
      if (!c) return;
      s.history = [c, ...s.history.filter((h) => h !== c)].slice(
        0,
        MAX_HISTORY,
      );
    },

    /** Record a file the viewer or the editor just opened. Newest first, no
     *  duplicates: reopening a file should move it up the list, not add a
     *  second copy of it. */
    rememberFile(s: UIState, path: string, tool: "view" | "edit") {
      const entry = `${tool}:${path}`;
      s.fileHistory = [entry, ...s.fileHistory.filter((h) => h !== entry)]
        .slice(0, 40);
    },

    /** F2 — the user menu: `.mcx.menu` beside the files if a project ships
     *  one, else `~/.mcx/menu`, which mcx writes on first run and never
     *  touches again. */
    async openUserMenu(
      s: UIState,
      dir: string,
      name: string,
      type: string,
      tagged: boolean,
    ): Promise<boolean> {
      const io = await import("./profile.server.ts");
      const menu = await io.userMenu(dir);
      if (!menu) return false;

      const { applicable } = await import("../lib/mcmenu.ts");
      const entries = applicable(menu.entries, { name, type, tagged });
      if (entries.length === 0) return false;

      s.menuSource = menu.source;
      s.menuCommands = entries.map((e) => e.commands);
      applyChoose(
        s,
        "mcusermenu",
        "User menu",
        entries.map((e, i) => ({
          id: String(i),
          label: e.label,
          hint: e.hotkey,
        })),
      );
      return true;
    },

    /** Run the user-menu entry that was picked. The commands never crossed the
     *  wire — the client chose an index, and this is where that index becomes a
     *  shell command. */
    async runUserMenuEntry(
      s: UIState,
      index: number,
      macros: import("../lib/mcmenu.ts").MenuMacros,
      answers: string[],
    ): Promise<string> {
      const commands = s.menuCommands[index];
      if (!commands) return "";
      const { expandMacros, fillPrompts } = await import("../lib/mcmenu.ts");
      const { shellQuote } = await import("../lib/shell.ts");
      return fillPrompts(commands, answers, shellQuote)
        .map((l) => expandMacros(l, macros, shellQuote))
        .join("\n");
    },

    /** What the entry at `index` will ask for before it runs. */
    async promptsFor(s: UIState, index: number): Promise<string[]> {
      const commands = s.menuCommands[index];
      if (!commands) return [];
      const { promptsOf } = await import("../lib/mcmenu.ts");
      return promptsOf(commands);
    },

    /** Options → Appearance. The skins in `~/.mcx/skins` — the four mcx seeds
     *  there on first run, and anything the user has added. */
    async listSkins(s: UIState) {
      const current = s.skin;
      const io = await import("./profile.server.ts");
      const found = await io.skins();
      if (found.length === 0) return void ui.say("No skins in ~/.mcx/skins");
      ui.choose(
        "skin",
        "Appearance",
        [
          {
            id: "",
            label: "mcx (built in)",
            hint: current === "" ? "current" : "",
          },
          ...found.map((f) => ({
            id: f.path,
            label: f.name,
            hint: current === f.name ? "current" : "",
          })),
        ],
      );
    },

    /** Apply one. An empty path restores mcx's own colours. */
    async setSkin(s: UIState, path: string) {
      if (path === "") {
        s.skin = "";
        s.skinCss = {};
        return void applySay(s, "mcx colours");
      }
      const io = await import("./profile.server.ts");
      const css = await io.skinCss(path);
      if (Object.keys(css).length === 0) {
        return void applySay(s, "That skin sets no colours mcx can use");
      }
      s.skin = path.slice(path.lastIndexOf("/") + 1).replace(/\.ini$/, "");
      s.skinCss = css;
      applySay(s, `Skin: ${s.skin}`);
    },

    /** C-x h — bookmark a directory, or drop it if it is already bookmarked. */
    toggleHot(s: UIState, path: string) {
      s.hotlist = s.hotlist.includes(path)
        ? s.hotlist.filter((p) => p !== path)
        : [...s.hotlist, path].sort();
      s.status = s.hotlist.includes(path) ? `Added ${path}` : `Removed ${path}`;
    },

    /** Set once, at boot, by the only code that can know it. */
    setHome(s: UIState, path: string) {
      s.home = path;
    },

    /** Open a pulldown (or close them all with `null`). `index` is where the
     *  highlight lands — the caller knows which rows are separators. */
    openMenu(s: UIState, name: string | null, index = 0) {
      s.menu = name;
      s.menuIndex = index;
      if (name !== null) {
        s.lastMenu = name;
        s.lastMenuIndex = index;
      }
    },

    /** Put the highlight on a row. Absolute, because which row is NEXT depends
     *  on where the separators are, and that is the menu table's business
     *  (`stepItem` in ui/menus.ts) rather than this cell's. */
    setMenuIndex(s: UIState, index: number) {
      if (!s.menu) return;
      s.menuIndex = index;
      s.lastMenu = s.menu;
      s.lastMenuIndex = index;
    },

    toggleShell(s: UIState) {
      s.shellVisible = !s.shellVisible;
    },

    /** M-, — side by side, or one above the other.
     *
     *  The status line is written HERE, not by the caller: a caller reading
     *  `ui.stacked` straight after this to describe what happened reads the
     *  value from before the write (the round trip has not landed), and says
     *  the opposite of the truth. The writer is the only one who knows. */
    toggleSplit(s: UIState) {
      s.stacked = !s.stacked;
      s.status = s.stacked ? "Panels: stacked" : "Panels: side by side";
    },

    /** M-= / M-S-Right / M-S-Left. `delta` of 0 means "equal", which is a
     *  separate command in mc and the only way back to the middle once the
     *  divider has been nudged. The bounds keep a panel from being reduced to
     *  a sliver that cannot show a filename. */
    resizeSplit(s: UIState, delta: number) {
      s.splitRatio = delta === 0
        ? 0.5
        : Math.max(0.2, Math.min(0.8, s.splitRatio + delta));
    },
  },
});
