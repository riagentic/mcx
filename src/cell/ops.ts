// The single-file operations: the ones that finish before a progress bar could
// finish drawing. Copy/move/delete live in `fileops.ts`, where the progress
// model is the point.
//
// Every method reports through `ui.say` on failure rather than throwing into
// the void: a file manager that silently fails to create a directory is worse
// than one that cannot.
import { cell } from "aio";
import { panels } from "./panels.ts";
import { ui } from "./ui.ts";
import { basename, dirname, entryPath, join, relativeTo } from "../lib/path.ts";
import { isRemote, remoteJoin } from "../lib/remote.ts";

type OpsState = {
  /** Last error, kept so a dialog can show it after the status line moves on. */
  error: string | null;
};

/** Apply one mutation across a selection, collecting failures instead of
 *  stopping at the first: chmod'ing forty files must not give up on file two. */
async function applyAll(
  paths: string[],
  fn: (path: string) => Promise<string | null>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const p of paths) {
    const err = await fn(p);
    if (err) failed.push(`${basename(p)}: ${err}`);
  }
  return failed;
}

/** One sentence about how a bulk operation went. */
function report(
  s: OpsState,
  total: number,
  failed: string[],
  what: string,
): void {
  if (failed.length === 0) {
    ui.say(`${what}: ${total} file${total === 1 ? "" : "s"}`);
  } else {
    ui.say(`${what}: ${total - failed.length} of ${total} — ${failed[0]}`);
  }
  s.error = failed[0] ?? null;
}

export const ops = cell("ops", {
  persist: "none",
  state: { error: null as string | null },

  methods: {
    /** F7. Creates parents too — typing `a/b/c` and being told "no such file
     *  or directory" is a pointless round trip. */
    async mkdir(s: OpsState, name: string) {
      // On a remote panel, `mkdir` happens on the far machine.
      const panel = panels.activePanel();
      if (isRemote(panel.path)) {
        const io = await import("./remote.server.ts");
        const err = await io.mkdir(remoteJoin(panel.path, name));
        s.error = err;
        ui.say(err ? `Cannot create ${name}: ${err}` : `Created ${name}`);
        if (!err) await panels.reload(panels.active, undefined, name);
        return;
      }
      const p = panels.activePanel();
      // An absolute name means what it says — `/tmp/build` under the cursor's
      // directory is not what anyone typing it meant.
      const target = entryPath(p.path, name);
      const io = await import("./ops.server.ts");
      const err = await io.mkdir(target);
      s.error = err;
      if (err) ui.say(`Cannot create ${name}: ${err}`);
      else {
        ui.say(`Created ${name}`);
        await panels.reload(panels.active, undefined, name.split("/")[0]);
      }
    },

    /** Shift-F6. A rename with a `/` in it is a move, and that is on purpose —
     *  it is what the shell does. */
    async rename(s: OpsState, from: string, to: string) {
      const target = to.includes("/") ? to : join(dirname(from), to);
      const io = await import("./fileops.server.ts");
      const err = await io.rename(from, target);
      s.error = err;
      if (err) ui.say(`Cannot rename: ${err}`);
      else await panels.reload(panels.active, undefined, basename(target));
    },

    /** C-x c. Octal, because that is what a file manager's users think in, and
     *  over the whole selection, because that is what mc does with a tagged
     *  group. */
    async chmod(s: OpsState, paths: string[], octal: string) {
      const mode = parseInt(octal.trim(), 8);
      if (!Number.isFinite(mode) || mode < 0 || mode > 0o7777) {
        s.error = `not an octal mode: ${octal}`;
        return void ui.say(s.error);
      }
      const io = await import("./fileops.server.ts");
      const failed = await applyAll(paths, (p) => io.chmod(p, mode));
      report(s, paths.length, failed, "Chmod");
      await panels.reload(panels.active, undefined, basename(paths[0] ?? ""));
    },

    /** C-x o. `user`, `:group` or `user:group`, names or ids — mc's spelling,
     *  and the shell's. */
    async chown(s: OpsState, paths: string[], spec: string) {
      const io = await import("./ops.server.ts");
      const { owner, error } = await io.parseOwner(spec);
      if (error) {
        s.error = error;
        return void ui.say(`Chown: ${error}`);
      }
      const failed = await applyAll(paths, (p) => io.chown(p, owner));
      report(s, paths.length, failed, "Chown");
      await panels.reload(panels.active, undefined, basename(paths[0] ?? ""));
    },

    /** C-x s / C-x l. The link is created in the ACTIVE panel, pointing at the
     *  file under the cursor — mc's arrangement, and the useful one. */
    async link(
      s: OpsState,
      target: string,
      name: string,
      hard: boolean,
      relative = false,
    ) {
      const p = panels.activePanel();
      const path = entryPath(p.path, name);
      const io = await import("./fileops.server.ts");
      // C-x v writes the target relative to where the link lands, so that the
      // link and its target survive being moved — or copied to another machine
      // — as a pair. An absolute target only ever works in one place.
      const to = hard || !relative ? target : relativeTo(dirname(path), target);
      const err = hard
        ? await io.hardlink(to, path)
        : await io.symlink(to, path);
      s.error = err;
      if (err) ui.say(`Cannot link: ${err}`);
      else await panels.reload(panels.active, undefined, basename(path));
    },

    /** C-x e — read the ext2 attributes of the file under the cursor, so the
     *  dialog can open on what they are now. */
    async attrsOf(s: OpsState, name: string): Promise<string> {
      const p = panels.activePanel();
      const io = await import("./ops.server.ts");
      const r = await io.readAttrs(entryPath(p.path, name));
      if (r.error) ui.say(r.error);
      return r.attrs;
    },

    /** …and write them back. */
    async chattr(s: OpsState, paths: string[], attrs: string) {
      const io = await import("./ops.server.ts");
      let failed = 0;
      let last = "";
      for (const path of paths) {
        const err = await io.writeAttrs(path, attrs);
        if (err) {
          failed++;
          last = err;
        }
      }
      s.error = failed ? last : null;
      ui.say(
        failed
          ? `Attributes: ${paths.length - failed} of ${paths.length} — ${last}`
          : `Attributes set on ${paths.length}`,
      );
      await panels.reload(panels.active, undefined, basename(paths[0] ?? ""));
    },

    /** C-x C-s — point an existing symlink somewhere else. Written as a
     *  replacement rather than an edit, because there is no such thing as
     *  editing a symlink in place: the old one is removed and a new one takes
     *  its name. */
    async retarget(s: OpsState, name: string, target: string) {
      const p = panels.activePanel();
      const path = entryPath(p.path, name);
      const io = await import("./fileops.server.ts");
      const err = await io.retarget(path, target);
      s.error = err;
      if (err) ui.say(`Cannot edit link: ${err}`);
      else await panels.reload(panels.active, undefined, name);
    },
  },
});
