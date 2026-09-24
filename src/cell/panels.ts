// The two panels — mcx's core state.
//
// Everything the user does to a listing lands here as one method. The listing
// itself (`all`) and the mark set never leave the server: the panel publishes a
// WINDOW (`rows`) sized to what actually fits on screen, so paging through
// 100_000 files costs the same as paging through 10 (docs/persistence/delta.md).
import { cell } from "aio";
import { ui } from "./ui.ts";
import type {
  PanelSide,
  PanelState,
  PanelView,
  SortKey,
  ViewOpts,
} from "../type/panel.ts";
import type { ListMode } from "../type/panel.ts";
import type { FileEntry } from "../type/fs.ts";
import { UP_DIR } from "../type/fs.ts";
import { clamp, derive, markable } from "../lib/panel.ts";
import { basename, dirname, entryPath, resolve } from "../lib/path.ts";
import { isRemote, remoteJoin, remoteParent } from "../lib/remote.ts";

/** mc's three answers to "Select compare method". */
export type CompareMethod = "quick" | "size" | "thorough";

/** The `..` row a remote listing needs. The local loader adds its own; a
 *  remote one is parsed from `ls`, which is asked not to include it (its
 *  metadata would be the remote directory's, not the parent's). */
const upDirEntry = (): FileEntry => ({
  name: UP_DIR,
  kind: "dir",
  size: 0,
  mtime: 0,
  mode: 0o755,
  uid: 0,
  gid: 0,
  nlink: 1,
});

const emptyPanel = (path: string): PanelState => ({
  path,
  error: null,
  raw: [],
  order: [],
  all: [],
  markedNames: [],
  virtual: [],
  quick: "",
  history: [],
  historyPos: -1,
  vfs: null,
  inArchive: false,
  rows: [],
  offset: 0,
  hscroll: 0,
  viewport: 20,
  columns: 1,
  cursor: 0,
  count: 0,
  sort: "name",
  reverse: false,
  dirsFirst: true,
  caseSensitive: false,
  showHidden: false,
  filter: "",
  mode: "full",
  view: "list",
  preview: [],
  nodesFree: 0,
  nodesTotal: 0,
  device: "",
  fstype: "",
  details: null,
  markedCount: 0,
  markedBytes: 0,
  markedFirst: "",
  totalBytes: 0,
  free: 0,
  total: 0,
  loading: false,
  generation: 0,
});

type PanelsState = {
  left: PanelState;
  right: PanelState;
  active: PanelSide;
};

const other = (s: PanelSide): PanelSide => (s === "left" ? "right" : "left");

/** Index a panel by side, loudly.
 *
 *  Every method here takes a side from somewhere outside itself — a keystroke,
 *  a menu, `am dispatch`, a client whose state is a version behind. Without
 *  this, a wrong value surfaced as "Cannot read properties of undefined
 *  (reading 'viewport')" three frames later; with it, the error names the
 *  argument and the method. */
/** The half of `listing.server.ts` the view pipeline needs. Named as a type so
 *  the dynamic `import()` that keeps `Deno` out of the browser bundle still
 *  type-checks at every call site. */
type ViewIO = {
  arrangeOrder: (entries: readonly FileEntry[], o: ViewOpts) => number[];
  project: (
    entries: readonly FileEntry[],
    order: readonly number[],
  ) => FileEntry[];
};

/** Re-apply the panel's view options — hidden files, mask, sort — to the RAW
 *  listing, and republish `all`.
 *
 *  Always from `raw`, never from `all`: an arrangement that consumed its own
 *  output could not undo a filter, which is why `M-.` and the filter box used
 *  to cost a `readdir`. */
function applyView(p: PanelState, io: ViewIO): void {
  p.order = io.arrangeOrder(p.raw, p);
  p.all = io.project(p.raw, p.order);
}

/** The only writer of `p.vfs` — because the client needs the same fact and
 *  never receives `vfs` itself. Two assignments that can drift are one bug. */
function setVfs(p: PanelState, vfs: PanelState["vfs"]): void {
  p.vfs = vfs;
  p.inArchive = vfs !== null;
}

/** How many directories a panel remembers. mc keeps its history bounded for
 *  the same reason: a trail nobody will ever walk back along is just state. */
const MAX_DIR_HISTORY = 128;

/** Record a directory on the panel's trail, the way a browser records a page:
 *  stepping back and then going somewhere new discards the forward branch,
 *  because it is no longer where the user came from. Re-reading the directory
 *  you are already in (C-r) records nothing. */
function remember(p: PanelState, path: string): void {
  if (p.history[p.historyPos] === path) return;
  p.history = [...p.history.slice(0, p.historyPos + 1), path].slice(
    -MAX_DIR_HISTORY,
  );
  p.historyPos = p.history.length - 1;
}

function panelOf(s: PanelsState, side: PanelSide, method: string): PanelState {
  const p = s[side];
  if (!p) {
    throw new Error(
      `panels:${method} — no panel "${side}" (expected "left" or "right")`,
    );
  }
  return p;
}

export const panels = cell("panels", {
  // A directory read on a cold, huge tree is legitimately slow; the method
  // ceiling is for calls that hang, not for filesystems. Declared on the cell
  // rather than as a string in app.ts, so renaming the method cannot orphan it.
  long: ["reload"],

  // Listings and marks are per-session facts about a disk that changes behind
  // our back; the PREFERENCES are what a user expects to survive a restart.
  persist: {
    exclude: [
      "left.raw",
      "left.order",
      "left.all",
      "left.rows",
      "left.markedNames",
      "left.loading",
      "left.error",
      "left.virtual",
      "left.quick",
      "left.vfs",
      "left.inArchive",
      "left.preview",
      "left.details",
      "right.raw",
      "right.order",
      "right.all",
      "right.rows",
      "right.markedNames",
      "right.loading",
      "right.error",
      "right.virtual",
      "right.quick",
      "right.vfs",
      "right.inArchive",
      "right.preview",
      "right.details",
    ],
  },
  // The fields the client must never receive — see the header comment. Every
  // one of them is O(directory); everything the UI draws is O(viewport).
  visible: {
    exclude: [
      "left.raw",
      "left.order",
      "left.all",
      "left.markedNames",
      "left.virtual",
      "left.vfs",
      "right.raw",
      "right.order",
      "right.all",
      "right.markedNames",
      "right.virtual",
      "right.vfs",
    ],
  },

  state: {
    left: emptyPanel(""),
    right: emptyPanel(""),
    active: "left" as PanelSide,
  },

  // A panel showing 100_000 rows in a 40-row window is the case the whole
  // design is for; the boot-time drift check would rather hear it than infer
  // it from an empty array.
  validate: (s: PanelsState) =>
    s.left.rows.length <= s.left.viewport &&
      s.right.rows.length <= s.right.viewport
      ? true
      : "panels: published more rows than fit the viewport",

  methods: {
    /** First paint: the working directory on the left, home on the right —
     *  unless a previous session left paths behind, which persistence restores.
     *  Both paths are passed explicitly, for the reason `reload` documents. */
    async boot(s: PanelsState) {
      // What persistence restored, read before the first await.
      const [left, right] = [s.left.path, s.right.path];
      // The profile first: `~/.mcx` holds the menu, the associations and the
      // skins, and the first run is where they come from.
      await (await import("./profile.server.ts")).ensureProfile();
      const io = await import("./listing.server.ts");
      ui.setHome(io.homeDir());
      await panels.reload("left", left || io.cwd(), "");
      await panels.reload("right", right || io.homeDir(), "");
    },

    /** Re-read a panel's directory from disk, keeping the cursor on the file it
     *  was on rather than the row it was on.
     *
     *  `path` is an ARGUMENT, not a state read, and that is load-bearing: a
     *  caller's writes commit on a microtask, so a nested dispatch that read
     *  `p.path` would read the directory the user just left, then throw the
     *  result away against its own supersession guard. */
    async reload(
      s: PanelsState,
      side: PanelSide,
      target: string | undefined = undefined,
      keepName: string | undefined = undefined,
    ) {
      const p = panelOf(s, side, "reload");
      const path = target ?? p.path;
      // `""` means "this is a new directory — start at the top"; `undefined`
      // means "keep the user where they were".
      const keep = keepName === ""
        ? null
        : (keepName ?? p.all[p.cursor]?.name ?? null);
      if (keepName === "") {
        p.cursor = 0;
        p.offset = 0;
      }
      p.path = path;
      p.loading = true;

      const io = await import("./listing.server.ts");
      // A panelized panel re-reads ITS LIST, not a directory — otherwise every
      // refresh would silently throw the search results away.
      const vfs = p.vfs ? { ...p.vfs } : null;
      const remote = !vfs && isRemote(path);
      const plain = !vfs && !remote && p.virtual.length === 0;

      // Phase one: the fastest listing that can be drawn. On a plain directory
      // that is `readdir` with no `stat` at all — the difference between a
      // 100_000-entry folder appearing in 100ms and in half a second.
      const [raw, df] = await Promise.all([
        vfs
          ? (await import("./vfs.server.ts")).listing(
            vfs.archive,
            vfs.kind,
            vfs.inner,
          )
          : remote
          // Another machine: the listing arrives as text from `ls -la` and is
          // parsed into the same rows a local directory produces, so
          // everything downstream — sorting, marking, the mask — is unchanged.
          ? (await import("./remote.server.ts")).listing(path).then((r) => ({
            entries: [upDirEntry(), ...r.entries],
            error: r.error,
          }))
          : p.virtual.length > 0
          ? io.readPaths([...p.virtual])
          : io.readDirFast(path),
        io.diskFree(
          remote
            ? "/"
            : vfs
            ? vfs.archive
            : p.virtual.length > 0
            ? (p.virtual[0] ?? "/")
            : path,
        ),
      ]);

      // Superseded while we were on disk — the newer load owns the panel.
      if (s[side].path !== path) return;

      const q = s[side];
      q.raw = raw.entries;
      q.error = raw.error;
      q.free = df.free;
      q.total = df.total;
      q.nodesFree = df.nodesFree;
      q.nodesTotal = df.nodesTotal;
      q.device = df.device;
      q.fstype = df.fstype;
      applyView(q, io);
      // Marks survive a refresh of the SAME directory (mc does this, and losing
      // a hand-built selection to an auto-refresh is unforgivable) — but only
      // for files that still exist.
      const present = new Set(q.raw.map((e) => e.name));
      q.markedNames = q.markedNames.filter((n) => present.has(n));
      q.generation++;
      if (plain) remember(q, path);
      Object.assign(q, derive(q, keep));

      // Phase two: sizes, times and modes. Published in chunks so a huge
      // directory fills in visibly rather than freezing, and abandoned the
      // moment the user navigates away.
      //
      // The chunks walk the listing in the order it is DRAWN — `order` is the
      // snapshot taken here, so a filter or a re-sort mid-fill cannot make a
      // later chunk write a row into someone else's slot. Results land in
      // `raw`; `rows` are re-projected through whatever order is current.
      if (plain) {
        const gen = q.generation;
        const fill = [...q.order];
        const total = fill.length;
        const chunk = total > io.TWO_PHASE_THRESHOLD ? 2000 : total;
        for (let at = 0; at < total; at += Math.max(1, chunk)) {
          const target = s[side];
          if (target.path !== path || target.generation !== gen) return; // superseded
          // Plain copies, not the draft's own rows: these cross an `await`,
          // and a live view captured before `raw` is overwritten is a stale
          // reference (aio refuses it, and used to resolve it to the new value
          // silently). The server gets data, which is all it ever wanted.
          const slice = fill.slice(at, at + chunk).map((i) => ({
            ...target.raw[i]!,
          }));
          const filled = await io.statSlice(path, slice, 0, slice.length);
          const now = s[side];
          if (now.path !== path || now.generation !== gen) return;
          const next = [...now.raw];
          for (let i = 0; i < filled.length; i++) {
            next[fill[at + i]!] = filled[i]!;
          }
          now.raw = next;
          now.all = io.project(next, now.order);
          Object.assign(now, derive(now));
        }
        const done = s[side];
        if (done.path !== path || done.generation !== gen) return;
        // Re-arrange once at the end: a sort by size or time was sorting on
        // zeroes until the numbers existed.
        const keepName = done.all[done.cursor]?.name ?? null;
        applyView(done, io);
        Object.assign(done, derive(done, keepName));
      }

      s[side].loading = false;
    },

    /** Change directory. `..` walks up; anything else resolves against `path`. */
    async chdir(s: PanelsState, side: PanelSide, target: string) {
      const p = panelOf(s, side, "chdir");
      const from = p.path;
      const io = await import("./listing.server.ts");
      // Four ways to name where to go: up, a remote URL, a name inside a
      // remote directory, or an ordinary local path.
      // `cd -` is the directory we were in before this one — the panel's own
      // trail already knows it, which is why it is answered here rather than
      // in the expander.
      const back = target === "-" ? p.history[p.historyPos - 1] : undefined;
      const next = isRemote(target)
        ? await (await import("./remote.server.ts")).homeOf(target)
        : target === UP_DIR
        ? (isRemote(from)
          ? (remoteParent(from) ?? io.homeDir())
          : dirname(from))
        : isRemote(from)
        ? remoteJoin(from, target)
        : back ?? (target === "-"
          ? from
          // `$VAR`, `~` and CDPATH — mc's `examine_cd`, so the quick-cd box and
          // the command line resolve a name the same way.
          : await io.expandCd(target, from, io.homeDir()));
      if (next === p.path) return;
      p.path = next;
      p.cursor = 0;
      p.offset = 0;
      p.hscroll = 0;
      p.markedNames = []; // a new directory starts with nothing selected
      p.virtual = []; // leaving a panelized view is just navigating away
      p.quick = "";
      setVfs(p, null); // …and so is leaving an archive
      // Coming up from a subdirectory, land on the directory just left.
      await panels.reload(side, next, target === UP_DIR ? basename(from) : "");
    },

    /** M-y / M-u — back and forward along this panel's trail.
     *
     *  `historyPos` moves BEFORE the reload, which is what stops the reload
     *  from recording the arrival as a new step and truncating everything ahead
     *  of it: `remember` sees the path already sitting at the cursor. */
    async historyStep(s: PanelsState, side: PanelSide, delta: number) {
      const p = panelOf(s, side, "historyStep");
      const next = p.historyPos + delta;
      if (next < 0 || next >= p.history.length) {
        return void ui.say(
          delta < 0 ? "No earlier directory" : "No later directory",
        );
      }
      const path = p.history[next]!;
      p.historyPos = next;
      await panels.reload(side, path, "");
    },

    /** Enter: directories navigate. Files are the caller's business — the panel
     *  reports what was chosen and stays out of policy. */
    async enter(s: PanelsState): Promise<string | null> {
      const side = s.active;
      const p = s[side];
      const e = p.all[p.cursor];
      if (!e) return null;
      // Everything below is decided by what was under the cursor NOW; the
      // awaits that follow must not re-read a panel that may have moved on.
      const dir = p.path;
      const name = e.name;
      const dirish = e.kind === "dir" ||
        (e.kind === "link" && e.linkKind === "dir");

      // Inside an archive, everything is archive navigation.
      if (p.vfs) {
        if (dirish) {
          await panels.vfsChdir(side, name);
          return null;
        }
        return null; // a member is opened through `extractCurrent`
      }

      if (dirish) {
        await panels.chdir(
          side,
          name === UP_DIR
            ? UP_DIR
            : isRemote(dir)
            ? remoteJoin(dir, name)
            : entryPath(dir, name),
        );
        return null;
      }

      // A remote file has to be here before anything can open it.
      if (isRemote(dir)) {
        const local = await panels.fetchCurrent();
        return local;
      }

      // An archive opens as a directory — mc's defining trick.
      const { archiveKind } = await import("./vfs.server.ts");
      const kind = archiveKind(name);
      if (kind) {
        await panels.openArchive(side, entryPath(dir, name), kind);
        return null;
      }
      return entryPath(dir, name);
    },

    /** Enter an archive. The panel's `path` becomes `archive#inner`, which is
     *  what the user sees and what `..` walks back out of. */
    async openArchive(
      s: PanelsState,
      side: PanelSide,
      archive: string,
      kind: "tar" | "zip",
    ) {
      const p = panelOf(s, side, "openArchive");
      setVfs(p, { archive, kind, inner: "" });
      p.virtual = [];
      p.markedNames = [];
      await panels.reload(side, `${archive}#`, "");
    },

    /** Navigate within an archive. `..` at the top leaves it, landing on the
     *  archive file itself. */
    async vfsChdir(s: PanelsState, side: PanelSide, name: string) {
      const p = panelOf(s, side, "vfsChdir");
      if (!p.vfs) return;
      const { archive, kind, inner } = p.vfs;

      if (name === UP_DIR) {
        if (inner === "") {
          const dir = dirname(archive);
          setVfs(p, null);
          p.markedNames = [];
          await panels.reload(side, dir, basename(archive));
          return;
        }
        const up = inner.includes("/")
          ? inner.slice(0, inner.lastIndexOf("/"))
          : "";
        const leaving = basename(inner);
        setVfs(p, { archive, kind, inner: up });
        p.markedNames = [];
        await panels.reload(side, `${archive}#${up}`, leaving);
        return;
      }

      const next = inner ? `${inner}/${name}` : name;
      setVfs(p, { archive, kind, inner: next });
      p.markedNames = [];
      await panels.reload(side, `${archive}#${next}`, "");
    },

    /** Bring the file under the cursor down to a temp file and return its
     *  path. F3, F4 and Enter all need one: everything in mcx opens files, and
     *  a remote file is not one until it is here. */
    async fetchCurrent(s: PanelsState): Promise<string | null> {
      const p = s[s.active];
      const e = p.all[p.cursor];
      if (!e || e.name === UP_DIR || !isRemote(p.path)) return null;
      const remote = remoteJoin(p.path, e.name);
      s[s.active].loading = true;
      const io = await import("./remote.server.ts");
      const r = await io.fetchToTemp(remote, e.name);
      s[s.active].loading = false; // aio-ok: re-read after await
      if (r.error) {
        ui.say(`Cannot fetch ${e.name}: ${r.error}`);
        return null;
      }
      return r.path;
    },

    /** Extract the row under the cursor to a temp file and return its path —
     *  how F3/F4 work on a file inside an archive. */
    async extractCurrent(s: PanelsState): Promise<string | null> {
      const p = s[s.active];
      const e = p.all[p.cursor];
      if (!p.vfs || !e || e.name === UP_DIR) return null;
      const { archive, kind, inner } = p.vfs;
      const member = inner ? `${inner}/${e.name}` : e.name;
      const io = await import("./vfs.server.ts");
      const r = await io.extractToTemp(archive, kind, member);
      if (r.error) {
        ui.say(`Cannot extract ${e.name}: ${r.error}`);
        return null;
      }
      return r.path;
    },

    /** F5 out of an archive, first half: put the selection somewhere real.
     *
     *  The COPY is then an ordinary copy, done by the caller — that is what
     *  gives extraction the overwrite question, the progress bar and the job
     *  list. Extracting straight into the destination had none of them, and
     *  overwrote whatever was already there without a word.
     *
     *  Returns the staged paths; the temp directory is registered as an active
     *  VFS, so `C-x a` frees it like any other. */
    async stageExtract(
      s: PanelsState,
    ): Promise<{ paths: string[]; failed: number }> {
      const p = s[s.active];
      if (!p.vfs) return { paths: [], failed: 0 };
      const { archive, kind, inner } = p.vfs;
      const names = p.markedNames.length > 0
        ? [...p.markedNames]
        : [p.all[p.cursor]?.name].filter((n): n is string =>
          !!n && n !== UP_DIR
        );
      if (names.length === 0) {
        ui.say("Nothing selected");
        return { paths: [], failed: 0 };
      }
      // Whether a member is a directory decides how the archive is asked for
      // it, so it is read from the listing rather than guessed from the name.
      const members = names.map((name) => ({
        member: inner ? `${inner}/${name}` : name,
        dir: p.all.find((e) => e.name === name)?.kind === "dir",
      }));

      const io = await import("./vfs.server.ts");
      const staged = await io.stage(archive, kind, members);
      if (staged.failed > 0) {
        ui.say(`${staged.failed} of ${names.length} could not be extracted`);
      }
      return { paths: staged.paths, failed: staged.failed };
    },

    /** Move the cursor by `delta` rows (clamped, never wrapping — mc's feel). */
    move(s: PanelsState, delta: number) {
      const p = s[s.active];
      p.cursor = clamp(p.cursor + delta, 0, Math.max(0, p.all.length - 1));
      Object.assign(p, derive(p));
    },

    /** Absolute cursor placement — the mouse path, and `home`/`end`. */
    setCursor(s: PanelsState, index: number) {
      const p = s[s.active];
      p.cursor = clamp(index, 0, Math.max(0, p.all.length - 1));
      Object.assign(p, derive(p));
    },

    /** M-( / M-) — slide the name column sideways. Resets on a directory
     *  change, because the reason for scrolling left leaves with the listing. */
    scrollNames(s: PanelsState, delta: number) {
      const p = s[s.active];
      p.hscroll = Math.max(0, Math.min(200, p.hscroll + delta));
    },

    /** M-g / M-r / M-j — the cursor to the top, middle or bottom of what is on
     *  SCREEN. Distinct from Home/End, which go to the ends of the listing:
     *  these three never scroll, they only move within the window already
     *  drawn, which is why mc gives them their own keys. */
    onScreen(s: PanelsState, where: "top" | "middle" | "bottom") {
      const p = s[s.active];
      const last = Math.min(p.offset + p.viewport - 1, p.all.length - 1);
      const row = where === "top"
        ? p.offset
        : where === "bottom"
        ? last
        : p.offset + Math.floor((last - p.offset) / 2);
      p.cursor = clamp(row, 0, Math.max(0, p.all.length - 1));
      Object.assign(p, derive(p));
    },

    /** S-Up / S-Down — mark, then step. Insert marks downward; these do it in
     *  whichever direction the user is travelling, so a run can be selected
     *  from either end. */
    markMove(s: PanelsState, delta: number) {
      const p = s[s.active];
      const e = p.all[p.cursor];
      if (markable(e)) {
        const i = p.markedNames.indexOf(e!.name);
        if (i >= 0) p.markedNames.splice(i, 1);
        else p.markedNames.push(e!.name);
      }
      p.cursor = clamp(p.cursor + delta, 0, Math.max(0, p.all.length - 1));
      Object.assign(p, derive(p));
    },

    /** M-o — take the OTHER panel to the directory under the cursor. On a file
     *  it goes to this panel's parent instead, landing on the directory we are
     *  standing in: mc's way of walking two panels down one tree. Either way
     *  this panel's cursor steps on, so held M-o walks the listing. */
    async otherCd(s: PanelsState) {
      const p = s[s.active];
      const e = p.all[p.cursor];
      if (!e) return;
      const dirish = e.kind === "dir" ||
        (e.kind === "link" && e.linkKind === "dir");
      const to = dirish && e.name !== UP_DIR
        ? entryPath(p.path, e.name)
        : dirname(p.path);
      await panels.chdir(other(s.active), to);
      const q = s[s.active]; // aio-ok: re-read after await
      q.cursor = clamp(q.cursor + 1, 0, Math.max(0, q.all.length - 1));
      Object.assign(q, derive(q));
    },

    /** M-l — the other panel follows the symlink under the cursor: to the
     *  target if it is a directory, otherwise to the directory holding it.
     *  Only symlinks have somewhere to point, so anything else is a no-op. */
    async otherCdLink(s: PanelsState) {
      const p = s[s.active];
      const e = p.all[p.cursor];
      if (!e || e.kind !== "link" || !e.target) {
        return void ui.say("Not a symbolic link");
      }
      const target = resolve(p.path, e.target);
      const dest = e.linkKind === "dir" ? target : dirname(target);
      await panels.chdir(other(s.active), dest);
    },

    /** The UI reports how many cells fit and in how many columns; the panel
     *  scrolls to match. Called on every resize, so it must be a no-op when
     *  nothing changed — otherwise a window drag becomes a broadcast storm. */
    setViewport(s: PanelsState, side: PanelSide, rows: number, columns = 1) {
      const p = panelOf(s, side, "setViewport");
      // A geometry that is not a number is not a geometry. `clamp` passes NaN
      // through unchanged, and a NaN in the state defeats the equality test
      // below — the state would change on every call forever. The client can
      // only send what a measurement gave it; this is where it stops.
      if (!Number.isFinite(rows) || !Number.isFinite(columns)) return;
      const v = clamp(Math.floor(rows), 1, 4096);
      const c = clamp(Math.floor(columns), 1, 16);
      if (p.viewport === v && p.columns === c) return;
      p.viewport = v;
      p.columns = c;
      Object.assign(p, derive(p));
    },

    activate(s: PanelsState, side: PanelSide) {
      panelOf(s, side, "activate");
      s.active = side;
    },

    /** Tab. */
    switchPanel(s: PanelsState) {
      s.active = other(s.active);
    },

    /** Insert: toggle the mark and step down, so a run of files marks with one
     *  held key — the mc muscle memory. */
    toggleMark(s: PanelsState, name = "") {
      const p = s[s.active];
      const e = name ? p.all.find((x) => x.name === name) : p.all[p.cursor];
      if (!markable(e)) return;
      const i = p.markedNames.indexOf(e!.name);
      if (i >= 0) p.markedNames.splice(i, 1);
      else p.markedNames.push(e!.name);
      if (!name) {
        p.cursor = clamp(p.cursor + 1, 0, Math.max(0, p.all.length - 1));
      }
      Object.assign(p, derive(p));
    },

    /** `+` / `-` / `*` — mark, unmark, invert. A mask of `*` is "everything".
     *
     *  `filesOnly` is mc's checkbox of the same name, and mc has it ON: `+`
     *  with `*` means "every file here", not "every file AND the directories,
     *  so the next F5 copies the whole tree". `caseSensitive` likewise defaults
     *  to the panel's sort setting when it is not given. */
    async markByMask(
      s: PanelsState,
      mask: string,
      mark: boolean,
      opts: { filesOnly?: boolean; caseSensitive?: boolean } = {},
    ) {
      const p = s[s.active];
      const filesOnly = opts.filesOnly ?? true;
      const fold = !(opts.caseSensitive ?? p.caseSensitive);
      const { globMatch } = await import("./core.server.ts");
      const set = new Set(p.markedNames);
      for (const e of p.all) {
        if (!markable(e)) continue;
        if (filesOnly && e.kind === "dir") continue;
        if (!globMatch(mask, e.name, fold)) continue;
        if (mark) set.add(e.name);
        else set.delete(e.name);
      }
      p.markedNames = [...set];
      Object.assign(p, derive(p));
    },

    invertMarks(s: PanelsState) {
      const p = s[s.active];
      const set = new Set(p.markedNames);
      p.markedNames = p.all.filter((e) => markable(e) && !set.has(e.name)).map((
        e,
      ) => e.name);
      Object.assign(p, derive(p));
    },

    unmarkAll(s: PanelsState) {
      const p = s[s.active];
      p.markedNames = [];
      Object.assign(p, derive(p));
    },

    /** Sorting and filtering re-arrange the listing in place — no disk read,
     *  because the bytes on disk did not change. */
    async setSort(
      s: PanelsState,
      side: PanelSide,
      key: SortKey,
      reverse: boolean | undefined = undefined,
    ) {
      const p = panelOf(s, side, "setSort");
      // Re-picking the same key flips direction, exactly like clicking a column.
      p.reverse = reverse ?? (p.sort === key ? !p.reverse : false);
      p.sort = key;
      await panels.rearrange(side);
    },

    /** M-. — and it costs an array walk, not a `readdir`: the dotfiles were
     *  never thrown away, only left out of the arrangement. */
    async toggleHidden(s: PanelsState, side: PanelSide) {
      const p = panelOf(s, side, "toggleHidden");
      p.showHidden = !p.showHidden;
      await panels.rearrange(side);
    },

    async setFilter(s: PanelsState, side: PanelSide, mask: string) {
      panelOf(s, side, "setFilter").filter = mask;
      await panels.rearrange(side);
    },

    async setDirsFirst(s: PanelsState, side: PanelSide, on: boolean) {
      panelOf(s, side, "setDirsFirst").dirsFirst = on;
      await panels.rearrange(side);
    },

    /** mc's "case sensitive sort" — off means `Makefile` sorts among the
     *  lower-case names rather than ahead of all of them. */
    async setCaseSensitive(s: PanelsState, side: PanelSide, on: boolean) {
      panelOf(s, side, "setCaseSensitive").caseSensitive = on;
      await panels.rearrange(side);
    },

    setMode(s: PanelsState, side: PanelSide, mode: ListMode) {
      panelOf(s, side, "setMode").mode = mode;
    },

    setView(s: PanelsState, side: PanelSide, view: PanelView) {
      const p = panelOf(s, side, "setView");
      p.view = view;
      if (view !== "quickview") p.preview = [];
      if (view !== "info") p.details = null;
    },

    /** Load the quick-view preview for `side` from the OTHER panel's cursor.
     *  The UI calls this when that cursor moves — the panel showing the preview
     *  is not the panel that knows what to preview. */
    async loadPreview(s: PanelsState, side: PanelSide, lines = 200) {
      const p = panelOf(s, side, "loadPreview");
      if (p.view !== "quickview") return;
      const src = s[other(side)];
      const e = src.rows.find((r) => r.index === src.cursor);
      if (!e || e.name === UP_DIR) {
        p.preview = [];
        return;
      }
      if (e.kind === "dir") {
        p.preview = [`${e.name}/`, "", "(directory)"];
        return;
      }
      const io = await import("./listing.server.ts");
      p.preview = await io.preview(entryPath(src.path, e.name), lines);
    },

    /** Load the info panel's detail block for `side` from the OTHER panel's
     *  cursor. mc re-stats the file on every cursor move, and so does this —
     *  one `lstat` for one file, never for the listing. */
    async loadDetails(s: PanelsState, side: PanelSide) {
      const p = panelOf(s, side, "loadDetails");
      if (p.view !== "info") return;
      const src = s[other(side)];
      const e = src.rows.find((r) => r.index === src.cursor);
      if (!e || e.name === UP_DIR || isRemote(src.path)) {
        p.details = null;
        return;
      }
      const io = await import("./ops.server.ts");
      p.details = await io.details(entryPath(src.path, e.name));
    },

    /** Re-apply sort, filter and hidden-file policy to what is already loaded.
     *  The cheap path, and it must never touch the disk: nothing about the
     *  bytes on disk changed, only which of them are being shown and in what
     *  order. */
    async rearrange(s: PanelsState, side: PanelSide) {
      const p = panelOf(s, side, "rearrange");
      const keep = p.all[p.cursor]?.name ?? null;
      const io = await import("./listing.server.ts");
      const q = panelOf(s, side, "rearrange"); // aio-ok: re-read after await
      applyView(q, io);
      Object.assign(q, derive(q, keep));
    },

    /** mc's "Panelize": show an arbitrary set of paths as if it were a
     *  directory. What turns a find into a workflow. */
    async panelize(
      s: PanelsState,
      side: PanelSide,
      paths: string[],
      label: string,
    ) {
      const p = panelOf(s, side, "panelize");
      p.virtual = paths;
      p.markedNames = [];
      p.cursor = 0;
      p.offset = 0;
      await panels.reload(side, label, "");
    },

    /** C-s type-ahead: extend the search string and jump to the first name
     *  that starts with it. An empty string clears the search. */
    quickSearch(s: PanelsState, text: string) {
      const p = s[s.active];
      p.quick = text;
      if (!text) return;
      const lower = text.toLowerCase();
      // From the CURSOR, wrapping — mc's `do_search`. Searching from the top
      // instead makes the second of three `report-*.txt` unreachable: every
      // keystroke lands back on the first one.
      const n = p.all.length;
      const scan = (hit: (name: string) => boolean): number => {
        for (let i = 0; i < n; i++) {
          const at = (p.cursor + i) % n;
          if (hit(p.all[at]!.name.toLowerCase())) return at;
        }
        return -1;
      };
      const from = scan((name) => name.startsWith(lower));
      // No prefix match: fall back to "contains", which is what a user reaching
      // for type-ahead in a long listing usually means.
      const at = from >= 0 ? from : scan((name) => name.includes(lower));
      if (at >= 0) {
        p.cursor = at;
        Object.assign(p, derive(p));
      }
    },

    /** Ctrl-U — swap the panels whole. */
    swap(s: PanelsState) {
      const l = s.left;
      s.left = s.right;
      s.right = l;
      s.active = other(s.active);
    },

    /** What an operation acts on: the marked files, or — when nothing is
     *  marked — the file under the cursor. mc's rule, and the reason F5 does
     *  the obvious thing whether or not you selected anything.
     *
     *  A METHOD, not a selector, and that is the whole point: selectors run
     *  wherever they are called, and `marked` deliberately never reaches the
     *  client. Called from the browser, a selector would have quietly answered
     *  "just the file under the cursor" and copied one file out of the fifty
     *  the user had marked. A method runs on the server and its return value
     *  crosses the bridge. */
    /** C-x a — what the VFS layer is currently holding: the archives the panels
     *  are inside, and the temp directories that extracting members has left
     *  behind. The second half is the reason mc has this command at all —
     *  those are real bytes, and nothing else would ever remove them. */
    async vfsList(s: PanelsState) {
      const open = [s.left, s.right]
        .filter((p) => p.vfs)
        .map((p) => `${p.vfs!.archive} (open)`);
      const io = await import("./vfs.server.ts");
      const temps = io.activeTemps();
      const items = [...open, ...temps.map((t) => `${t} (extracted)`)];
      if (items.length === 0) {
        return void ui.say("No active virtual filesystems");
      }
      ui.choose(
        "vfs-free",
        "Active virtual filesystems",
        [
          ...items.map((i) => ({ id: "", label: i })),
          {
            id: "free",
            label: `Free ${temps.length} extracted copies`,
            hint: "",
          },
        ],
      );
    },

    /** The Free button of that list. */
    async freeVfs(_s: PanelsState) {
      const io = await import("./vfs.server.ts");
      const n = await io.freeTemps();
      ui.say(n > 0 ? `Freed ${n} extracted copies` : "Nothing to free");
    },

    /** C-Space — count what a directory really holds and put the number in the
     *  size column, in place of `SUB-DIR`. Every marked directory, or the one
     *  under the cursor.
     *
     *  Counted one at a time, publishing each answer as it lands: on a large
     *  tree the interesting behaviour is the first number appearing while the
     *  second is still being counted. */
    async dirSize(s: PanelsState) {
      // The panel and directory this was asked about, fixed before any await:
      // a panel that moves on mid-count must not receive its sizes.
      const side = s.active;
      const p = s[side];
      const base = p.path;
      const dirish = (name: string) => {
        const e = p.all.find((x) => x.name === name);
        return !!e && e.name !== UP_DIR &&
          (e.kind === "dir" || (e.kind === "link" && e.linkKind === "dir"));
      };
      // mc's `smart_dirsize_cmd`: marked directories, or the one under the
      // cursor — unless the cursor is on `..`, which means "all of them". That
      // last one is how you ask a directory what its children weigh, and
      // answering "Not a directory" to it was refusing a question mc answers.
      const onUpDir = p.all[p.cursor]?.name === UP_DIR;
      const names = (p.markedNames.length > 0
        ? [...p.markedNames]
        : onUpDir
        ? p.all.map((e) =>
          e.name
        )
        : [p.all[p.cursor]?.name ?? ""])
        .filter(dirish);

      if (names.length === 0) return void ui.say("Not a directory");
      const io = await import("./listing.server.ts");
      // aio-ok: every read of `s[side]` below is a deliberate re-read, guarded
      // by the panel still being in `base`.
      const here = () => s[side].path === base ? s[side] : null;

      const start = here();
      if (!start) return;
      start.loading = true;
      for (const name of names) {
        const size = await io.dirSize(entryPath(base, name));
        const q = here();
        if (!q) return; // the panel left; its own load owns `loading` now
        for (const e of q.raw) {
          if (e.name === name) {
            e.size = size;
            e.sized = true;
          }
        }
        for (const e of q.all) {
          if (e.name === name) {
            e.size = size;
            e.sized = true;
          }
        }
        Object.assign(q, derive(q));
      }
      const done = here();
      if (!done) return;
      done.loading = false;
      // mc re-sorts when the sizes it just learned are what the panel is sorted
      // by — otherwise the numbers change and the order does not, which reads
      // as a sort that has stopped working.
      if (done.sort === "size") await panels.rearrange(side);
    },

    /** The file after (or before) the cursor in the active panel, skipping
     *  directories: what C-f/C-b in the viewer step through. Moves the panel's
     *  cursor with it, so leaving the viewer leaves you where you stopped. */
    neighbourFile(s: PanelsState, delta: number): string | null {
      const p = s[s.active];
      for (let i = p.cursor + delta; i >= 0 && i < p.all.length; i += delta) {
        const e = p.all[i]!;
        if (e.kind === "dir" || e.name === UP_DIR) continue;
        p.cursor = i;
        Object.assign(p, derive(p));
        return entryPath(p.path, e.name);
      }
      return null;
    },

    /** C-x t / C-x C-t — the names the command line should receive: every
     *  marked file, or the one under the cursor. NAMES, not paths, because
     *  what follows `tar cf x.tar` is names; and asked of the server because
     *  `marked` never crosses the wire. */
    taggedNames(s: PanelsState, side: PanelSide): string[] {
      const p = panelOf(s, side, "taggedNames");
      if (p.markedNames.length > 0) return [...p.markedNames];
      const e = p.all[p.cursor];
      return e && e.name !== UP_DIR ? [e.name] : [];
    },

    selection(s: PanelsState): string[] {
      const p = s[s.active];
      const names = p.markedNames.length > 0
        ? [...p.markedNames]
        : [p.all[p.cursor]?.name].filter((n): n is string =>
          !!n && n !== UP_DIR
        );
      return names.map((n) =>
        isRemote(p.path) ? remoteJoin(p.path, n) : entryPath(p.path, n)
      );
    },

    /** C-x d — mc's "Compare directories", with mc's three methods.
     *
     *  Marks, on BOTH panels, the files this side has that the other side is
     *  missing or holds an OLDER version of. "Older is not marked" is mc's rule
     *  and the useful one: the marks are what you would copy across, so the
     *  side that is behind stays clean and the side that is ahead lights up.
     *
     *  - `quick`    — size, then mtime (mc's default; no file is read)
     *  - `size`     — size alone, mtimes ignored
     *  - `thorough` — same size and time still get compared byte by byte
     *
     *  Directories are left alone, as mc leaves them. */
    async compare(s: PanelsState, method: CompareMethod = "quick") { // aio-ok: post-await reads follow the moved-on guard
      const index = (p: PanelState) => {
        const m = new Map<string, FileEntry>();
        for (const e of p.all) {
          if (e.name !== UP_DIR && e.kind !== "dir") m.set(e.name, e);
        }
        return m;
      };
      const [l, r] = [index(s.left), index(s.right)];
      // Both directories fixed before the first await: the marks belong to
      // THESE listings, and land only if both panels are still showing them.
      const [lp, rp] = [s.left.path, s.right.path];

      /** mc's `compare_dir`, for one file against its counterpart. */
      const differs = async (
        mine: FileEntry,
        theirs: FileEntry | undefined,
        myDir: string,
        theirDir: string,
      ): Promise<boolean> => {
        if (!theirs) return true; // not there at all
        // An older version is never marked — except under "size only", which
        // has no opinion about time.
        if (method !== "size" && mine.mtime < theirs.mtime) return false;
        if (mine.size !== theirs.size) return true;
        if (method === "size") return false;
        if (method === "quick") return mine.mtime > theirs.mtime;
        const io = await import("./fileops.server.ts");
        return !await io.sameContent(
          entryPath(myDir, mine.name),
          entryPath(theirDir, theirs.name),
        );
      };

      const differing = async (
        mine: Map<string, FileEntry>,
        theirs: Map<string, FileEntry>,
        myDir: string,
        theirDir: string,
      ): Promise<string[]> => {
        const out: string[] = [];
        for (const [n, e] of mine) {
          if (await differs(e, theirs.get(n), myDir, theirDir)) out.push(n);
        }
        return out;
      };

      const leftMarks = await differing(l, r, lp, rp);
      const rightMarks = await differing(r, l, rp, lp);
      // aio-ok: the deliberate re-read — did either panel move on meanwhile?
      if (s.left.path !== lp || s.right.path !== rp) {
        return void ui.say("A panel changed directory — compare again");
      }
      s.left.markedNames = leftMarks;
      s.right.markedNames = rightMarks;
      Object.assign(s.left, derive(s.left));
      Object.assign(s.right, derive(s.right));
      ui.say(
        s.left.markedCount + s.right.markedCount === 0
          ? "Directories are identical"
          : `Differing: ${s.left.markedCount} left, ${s.right.markedCount} right`,
      );
    },

    /** Alt-i — point the other panel at this one's directory. */
    async syncOther(s: PanelsState) {
      const { active } = s;
      await panels.chdir(other(active), s[active].path);
    },
  },

  selectors: {
    /** The row under the cursor of the active panel — the subject of every
     *  file operation. Derived, never stored. */
    current: (s: PanelsState) =>
      s[s.active].rows.find((r) => r.index === s[s.active].cursor) ?? null,
    activePanel: (s: PanelsState) => s[s.active],
    inactivePanel: (s: PanelsState) => s[other(s.active)],

    /** How many files an operation would touch, for the confirmation text.
     *  Reads only what the client is given — `markedCount` and the window. */
    operandCount: (s: PanelsState): number => {
      const p = s[s.active];
      if (p.markedCount > 0) return p.markedCount;
      const cur = p.rows.find((r) => r.index === p.cursor);
      return cur && cur.name !== UP_DIR ? 1 : 0;
    },

    /** The name to show when exactly one file is involved. Same rule: every
     *  field it touches survives the `visible` filter, so it answers the same
     *  thing in the browser as on the server. */
    operandLabel: (s: PanelsState): string => {
      const p = s[s.active];
      if (p.markedCount > 1) return `${p.markedCount} files`;
      if (p.markedCount === 1) return p.markedFirst;
      return p.rows.find((r) => r.index === p.cursor)?.name ?? "";
    },
  },
});
