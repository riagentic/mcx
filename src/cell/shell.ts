// The command line under the panels, and the output it produces (C-o).
//
// mc keeps a live subshell; mcx runs each command in a fresh shell and keeps
// the scrollback. The difference the user notices is that `cd` still works —
// it is intercepted and moves the panel, which is what they meant anyway.
import { cell, type MethodDraftMeta } from "aio";
import { panels } from "./panels.ts";
import { ui } from "./ui.ts";
import type { Line } from "./shell.server.ts";
import { shellQuote as shellQuoteLocal } from "../lib/shell.ts";

type ShellState = {
  lines: Line[];
  running: boolean;
  command: string;
  exitCode: number | null;
  cwd: string;
};

/** Scrollback cap. Enough to read a build log, bounded so a runaway `yes` does
 *  not become a memory leak with a progress bar. */
const MAX_LINES = 2000;

export const shell = cell("shell", {
  persist: "none",
  cancelOn: { exec: ["shell:stop"] },

  state: {
    lines: [] as Line[],
    running: false,
    command: "",
    exitCode: null as number | null,
    cwd: "",
  },

  methods: {
    /** mc's alt-tab, asked of the server because only it can read a directory.
     *  Pure lookup: nothing about the shell's state changes. */
    async complete(
      _s: ShellState,
      word: string,
      cwd: string,
    ): Promise<{ common: string; matches: string[] }> {
      const io = await import("./shell.server.ts");
      return io.complete(word, cwd);
    },

    /** Run a command in the active panel's directory. */
    /** Enter on a plain file — mc's behaviour, in mc's order.
     *
     *  1. An association from `~/.mcx/ext.ini`. That is what makes Enter on a
     *     `.pdf` open a reader, and it is the user's file to edit — mcx seeds
     *     it once and then leaves it alone.
     *  2. Otherwise, if the file is executable, run it.
     *  3. Otherwise nothing — mc does nothing here, and inventing an action
     *     (opening the viewer, say) would surprise the muscle memory. */
    async openFile(_s: ShellState, path: string, executable: boolean) {
      const cfg = await import("./profile.server.ts");
      const io = await import("./shell.server.ts");
      const name = path.slice(path.lastIndexOf("/") + 1);
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";

      // The name first; `file` only if nothing claimed it, because that is a
      // subprocess and the name answers almost every time.
      const list = await cfg.associations();
      const assoc = cfg.associationFor(list, name) ??
        cfg.associationFor(list, name, await io.fileType(path));
      const action = assoc?.open;
      if (action) {
        const { expandMacros } = await import("../lib/mcmenu.ts");
        const { shellQuote } = await import("../lib/shell.ts");
        const command = expandMacros(action, {
          file: name,
          dir,
          tagged: [name],
          otherFile: "",
          otherDir: "",
          otherTagged: [],
        }, shellQuote);
        ui.say(`${assoc.section}: ${command}`);
        // Detached: an association usually starts something with a window of
        // its own, and waiting for it would freeze the panel behind it.
        io.spawnDetached(command, dir);
        return;
      }

      if (executable) {
        ui.toggleShell();
        await shell.exec(shellQuoteLocal(path), dir);
        return;
      }
      ui.say(`No action for ${name} — F3 views it, F4 edits it`);
    },

    /** M-! — run a command and show what it printed in the viewer. mc writes
     *  the output to a temp file and views that; so does this, which is what
     *  gets search, hex and a 2 GB result for free. */
    async viewOutput(_s: ShellState, command: string, cwd: string) {
      const cmd = command.trim();
      if (!cmd) return;
      ui.remember(cmd);
      ui.say(`Running ${cmd}…`);
      const io = await import("./shell.server.ts");
      const { path, code } = await io.captureToFile(cmd, cwd);
      ui.say(code === 0 ? "" : `${cmd} exited ${code}`);
      const { viewer } = await import("./viewer.ts");
      await viewer.open(path);
    },

    /** C-x ! — run a command and put the filenames it printed in the panel
     *  (mc's "External panelize"). Relative names resolve against the panel's
     *  directory, which is where the command ran. */
    async panelizeOutput(_s: ShellState, command: string, cwd: string) {
      const cmd = command.trim();
      if (!cmd) return;
      ui.remember(cmd);
      ui.say(`Running ${cmd}…`);
      const io = await import("./shell.server.ts");
      const { out, err, code } = await io.capture(cmd, cwd);
      const paths = out.split("\n").map((l) => l.trim()).filter(Boolean)
        .map((l) => (l.startsWith("/") ? l : `${cwd}/${l}`.replace("//", "/")));
      if (paths.length === 0) {
        return void ui.say(
          code === 0
            ? `${cmd}: nothing to panelize`
            : `${cmd} exited ${code}: ${err.split("\n")[0] ?? ""}`,
        );
      }
      await panels.panelize(panels.active, paths, `!${cmd}`);
      ui.say(`${paths.length} from ${cmd}`);
    },

    async exec(
      s: ShellState & MethodDraftMeta,
      command: string,
      cwd: string,
    ) {
      const cmd = command.trim();
      if (!cmd) return;
      const io = await import("./shell.server.ts");

      // `cd` moves the panel instead of a doomed subprocess.
      const target = io.cdTarget(cmd);
      if (target !== null) {
        ui.remember(cmd);
        await panels.chdir(panels.active, target);
        return;
      }

      ui.remember(cmd);
      s.command = cmd;
      s.cwd = cwd;
      s.running = true;
      s.exitCode = null;
      s.lines = [...s.lines, { text: `$ ${cmd}`, err: false }].slice(
        -MAX_LINES,
      );

      // Batched so a command printing thousands of lines produces a readable
      // stream of updates rather than one broadcast per line.
      let pending: Line[] = [];
      const flush = () => {
        if (pending.length === 0) return;
        s.lines = [...s.lines, ...pending].slice(-MAX_LINES);
        pending = [];
      };
      // aio-ok: a flush timer scoped to this call, cleared in `finally` — not a
      // schedule other code could observe or cancel.
      const timer = setInterval(flush, 80);

      try {
        // The persistent shell first — that is where `export`, aliases and a
        // `cd` inside a script survive into the next command. A machine whose
        // shell will not start that way falls back to one process per command,
        // which works for everything except remembering anything.
        const persistent = await io.runPersistent(
          cmd,
          cwd,
          (l) => pending.push(l),
          s.$signal,
        );
        if (persistent) {
          s.exitCode = persistent.code;
          // The shell may have moved: `cd` inside a script counts too, which is
          // why this is read back rather than parsed out of the command.
          if (persistent.cwd && persistent.cwd !== cwd) {
            await panels.chdir(panels.active, persistent.cwd);
          }
        } else {
          s.exitCode = await io.run(
            cmd,
            cwd,
            (l) => pending.push(l),
            s.$signal,
          );
        }
      } catch (e) {
        pending.push({
          text: e instanceof Error ? e.message : String(e),
          err: true,
        });
        s.exitCode = -1;
      } finally {
        clearInterval(timer);
        flush();
        s.running = false;
      }

      // aio-ok: reading back this call's own write.
      if (s.exitCode !== 0) ui.say(`Exit ${s.exitCode}`);
      await panels.reload(panels.active);
    },

    stop(s: ShellState) {
      s.running = false;
    },

    clear(s: ShellState) {
      s.lines = [];
      s.exitCode = null;
    },
  },
});
