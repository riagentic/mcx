// The tree panel (mc's Left/Right → Tree).
//
// Same discipline as the file panels: the flattened tree lives here on the
// server, and the client receives the window it draws. A home directory with
// 20_000 folders under it costs the client exactly as much as an empty one.
//
// mc's behaviour, kept: the arrows walk the tree, `+`/`-` open and close a
// branch, and Enter takes the OTHER panel to the selected directory — the tree
// is a navigator for its partner, not a second file list.
import { cell } from "aio";
import { basename, dirname } from "../lib/path.ts";
import { clamp, scrollTo } from "../lib/panel.ts";
import { ui } from "./ui.ts";

/** One line of the drawn tree. */
export type TreeRow = {
  path: string;
  /** Last path segment, or the path itself at the root. */
  name: string;
  /** Indentation level — 0 is the root. */
  depth: number;
  open: boolean;
  /** False once a `readdir` has come back empty: no twisty, no wasted click. */
  branch: boolean;
  index: number;
};

type TreeState = {
  root: string;
  /** Directories whose children are shown. Persisted: a tree that forgets what
   *  you opened is a tree you open twice. */
  expanded: string[];
  /** `path → immediate subdirectory names`, filled as branches open.
   *  Server-side only — this is the whole tree, and it grows. */
  children: Record<string, string[]>;
  /** The flattened tree. Server-side only. */
  nodes: TreeRow[];
  /** The window the UI draws. */
  rows: TreeRow[];
  offset: number;
  viewport: number;
  cursor: number;
  count: number;
  showHidden: boolean;
  loading: boolean;
  /** mc's F4 "toggle navigation": when on, moving the cursor takes the other
   *  panel with it, instead of waiting for Enter. Useful for browsing a tree
   *  you do not know; noisy in one you do, which is why it is a toggle. */
  follow: boolean;
};

/** Flatten the tree: every expanded node followed by its children. */
function flatten(s: TreeState): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (path: string, depth: number): void => {
    const kids = s.children[path];
    // The root is the tree: it is always open, and collapsing it would leave
    // one unusable line on screen.
    const open = depth === 0 || s.expanded.includes(path);
    out.push({
      path,
      name: depth === 0 ? path : basename(path),
      depth,
      open,
      // Unknown until opened once — assume a branch, so the twisty is there to
      // click. `kids` is only empty after a `readdir` said so.
      branch: kids === undefined || kids.length > 0,
      index: out.length,
    });
    if (!open || !kids) return;
    for (const k of kids) {
      walk(path === "/" ? `/${k}` : `${path}/${k}`, depth + 1);
    }
  };
  walk(s.root, 0);
  return out;
}

/** The directory under the cursor, read from whatever draft is passed in — so
 *  a caller that has just moved the cursor gets the row it moved TO. */
const selectedPath = (s: TreeState): string | undefined =>
  s.rows.find((r) => r.index === s.cursor)?.path;

/** Take the OTHER panel there. A different cell, so this is an ordinary
 *  cross-cell call; what it must not do is re-read this cell's cursor. */
async function revealIn(path: string | undefined): Promise<void> {
  if (!path) return;
  const { panels } = await import("./panels.ts");
  await panels.chdir(panels.active === "left" ? "right" : "left", path);
}

/** Republish the window and the counters after any change to the tree. */
function reframe(s: TreeState): void {
  s.nodes = flatten(s);
  s.count = s.nodes.length;
  s.cursor = clamp(s.cursor, 0, Math.max(0, s.count - 1));
  s.offset = scrollTo(s.cursor, s.offset, s.viewport, s.count);
  s.rows = s.nodes.slice(s.offset, s.offset + s.viewport);
}

/** Every ancestor of `path` from the root down, `path` included — empty when
 *  `path` is not under `root` at all.
 *
 *  "Under" is tested at a path BOUNDARY: `/home/user2` starts with `/home/u`
 *  without being anywhere inside it, and a plain prefix test walked a chain of
 *  directories the tree does not contain, expanding rows that were never in it
 *  (and persisting them). */
function ancestors(root: string, path: string): string[] {
  const under = root.endsWith("/") ? root : `${root}/`;
  const chain: string[] = [];
  for (let p = path; p === root || p.startsWith(under); p = dirname(p)) {
    chain.unshift(p);
    if (p === root || p === "/") break;
  }
  return chain;
}

/** Read the children of `dirs` and record them.
 *
 *  A plain function rather than a method the other methods call: a nested
 *  dispatch sees its caller's writes only after they commit, so a `reveal`
 *  invoked from `setShowHidden` would have re-read the OLD hidden-file policy
 *  and refetched exactly what it was asked to replace. Everything it needs is
 *  an argument. */
async function readInto(
  s: TreeState,
  dirs: string[],
  showHidden: boolean,
): Promise<void> {
  const io = await import("./tree.server.ts");
  const kids = await Promise.all(dirs.map((d) => io.subdirs(d, showHidden)));
  // aiol-ok: writing the result of the IO is the point, and `children` is
  // keyed by path — a concurrent read of another branch cannot collide.
  for (const [i, dir] of dirs.entries()) s.children[dir] = kids[i]!;
}

export const tree = cell("tree", {
  // What you opened is worth restoring; what it contained is not — the disk
  // has moved on since.
  persist: { exclude: ["children", "nodes", "rows", "loading"] },
  visible: { exclude: ["children", "nodes"] },

  state: {
    root: "/",
    expanded: [] as string[],
    children: {} as Record<string, string[]>,
    nodes: [] as TreeRow[],
    rows: [] as TreeRow[],
    offset: 0,
    viewport: 20,
    cursor: 0,
    count: 0,
    showHidden: false,
    loading: false,
    follow: false,
  },

  methods: {
    /** Re-root the tree. `/` is mc's answer and the default; anything else is
     *  for a caller that wants a subtree (and for tests, which want one that
     *  fits in a temp directory). */
    async setRoot(s: TreeState, path: string) {
      if (s.root === path) return;
      const { showHidden } = s;
      Object.assign(s, {
        root: path,
        children: {},
        expanded: [],
        cursor: 0,
        offset: 0,
      });
      await readInto(s, [path], showHidden);
      reframe(s);
    },

    /** Show the tree with `path` revealed and selected — what switching a panel
     *  into tree view means. Every ancestor is opened on the way down. */
    async reveal(s: TreeState, path: string) {
      // Read before the first await — every await is a commit point.
      const { root, showHidden } = s;
      const chain = ancestors(root, path);
      s.loading = true;

      await readInto(s, chain, showHidden);

      // Every ancestor opens; `path` itself does not, unless it already was —
      // revealing a directory should not also unfold it.
      for (const dir of chain.slice(0, -1)) {
        if (!s.expanded.includes(dir)) s.expanded.push(dir);
      }
      reframe(s);
      const at = s.nodes.findIndex((n) => n.path === path);
      if (at >= 0) s.cursor = at;
      reframe(s);
      s.loading = false;
    },

    /** Open a branch, reading its children the first time. */
    async expand(s: TreeState, path: string) {
      if (!path) return;
      if (!s.children[path]) await readInto(s, [path], s.showHidden);
      if (!s.expanded.includes(path)) s.expanded.push(path);
      reframe(s);
    },

    collapse(s: TreeState, path: string) {
      s.expanded = s.expanded.filter((p) => p !== path);
      reframe(s);
    },

    /** `+` / `-` / Left / Right / Space on the row under the cursor. */
    async toggle(s: TreeState, index?: number) {
      const node = s.nodes[index ?? s.cursor];
      if (!node) return;
      if (node.open) tree.collapse(node.path);
      else await tree.expand(node.path);
    },

    move(s: TreeState, delta: number) {
      s.cursor = clamp(s.cursor + delta, 0, Math.max(0, s.count - 1));
      reframe(s);
      // The path is read from the LIVE draft — the cursor moved a line ago.
      // Calling `tree.showSelected()` here would run as its own transaction
      // against committed state and reveal the directory we just left.
      if (s.follow) void revealIn(selectedPath(s));
    },

    /** F4 — whether the other panel follows the cursor. */
    toggleFollow(s: TreeState) {
      s.follow = !s.follow;
      ui.say(s.follow ? "Tree: other panel follows" : "Tree: Enter to open");
      if (s.follow) void revealIn(selectedPath(s));
    },

    /** Take the other panel to the selected directory — what Enter does, and
     *  what every cursor move does while `follow` is on. */
    async showSelected(s: TreeState) {
      await revealIn(selectedPath(s));
    },

    setCursor(s: TreeState, index: number) {
      s.cursor = clamp(index, 0, Math.max(0, s.count - 1));
      reframe(s);
    },

    setViewport(s: TreeState, rows: number) {
      if (!Number.isFinite(rows)) return; // see panels.setViewport
      const v = clamp(Math.floor(rows), 1, 4096);
      if (s.viewport === v) return;
      s.viewport = v;
      reframe(s);
    },

    /** M-. reaches the tree too: every open branch is re-read under the new
     *  policy, so a dotted directory appears exactly where it belongs. */
    /** F2 — re-read the open branches from disk. The tree caches what it has
     *  walked, which is what makes it quick; this is how you tell it the disk
     *  has moved on. */
    async reread(s: TreeState) {
      const open = [s.root, ...s.expanded];
      s.children = {};
      const io = await import("./tree.server.ts");
      for (const dir of open) {
        s.children[dir] = await io.subdirs(dir, s.showHidden);
      }
      reframe(s);
      ui.say("Tree re-read");
    },

    /** F3 — forget a branch: drop it from the cache and close it. mc calls it
     *  "Forget", and it is how you make the tree stop showing a directory that
     *  is slow, huge, or gone. */
    forget(s: TreeState) {
      const path = s.rows.find((r) => r.index === s.cursor)?.path;
      if (!path || path === s.root) {
        return void ui.say("Cannot forget the root");
      }
      s.expanded = s.expanded.filter((p) =>
        p !== path && !p.startsWith(path + "/")
      );
      delete s.children[path];
      reframe(s);
      ui.say(`Forgot ${path}`);
    },

    async setShowHidden(s: TreeState, on: boolean) {
      if (s.showHidden === on) return;
      s.showHidden = on;
      const open = [s.root, ...s.expanded];
      s.children = {};
      await readInto(s, [...new Set(open)], on);
      reframe(s);
    },
  },

  selectors: {
    /** The directory under the cursor — what Enter acts on. Reads `rows`, not
     *  `nodes`, so it answers the same thing in the browser. */
    selected: (s: TreeState): string =>
      s.rows.find((r) => r.index === s.cursor)?.path ?? "",
  },
});
