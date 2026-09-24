/** Panel vocabulary — mc's panel model, named the way mc names it. */

import type { FileDetails, FileEntry } from "./fs.ts";

export type SortKey =
  | "name"
  | "ext"
  | "size"
  | "mtime"
  | "unsorted"
  /** mc's `sort_vers`: `f2` before `f10`. */
  | "version";

/** mc's listing formats (Left/Right menu → Listing mode). */
export type ListMode = "brief" | "full" | "long";

/** What the panel shows instead of a file list (mc: Info / Tree / Quick view). */
export type PanelView = "list" | "info" | "tree" | "quickview";

export type PanelSide = "left" | "right";

/** A row as the UI receives it: the entry, its absolute index in the listing,
 *  and whether it is marked. The panel sends a WINDOW of these — never the
 *  whole directory — which is what keeps a 100k-entry folder as cheap to page
 *  through as a 10-entry one. */
export type RowView = FileEntry & { index: number; marked: boolean };

export type PanelState = {
  path: string;
  error: string | null;

  /** The listing exactly as the disk gave it — unsorted, unfiltered, hidden
   *  files included. Server-side only. Keeping it is what makes `M-.` and the
   *  filter box arithmetic rather than a second `readdir`. */
  raw: FileEntry[];
  /** `all[i] === raw[order[i]]`. Server-side only. Held so a metadata chunk can
   *  republish the rows without re-sorting the directory. */
  order: number[];

  /** The full arranged listing — `raw` with the view options applied.
   *  Server-side only: sending it is the one thing that would make mcx slower
   *  than mc. */
  all: FileEntry[];
  /** Marked names. Server-side only, for the same reason (`select all` in a
   *  huge tree). The UI reads `markedCount`/`markedBytes` and per-row flags.
   *  Named apart from `RowView.marked` on purpose: a `visible.exclude` dot
   *  path strips its field at EVERY depth under the panel, rows included. */
  markedNames: string[];

  /** A panelized result set (mc's "Panelize"): when non-empty the panel shows
   *  THESE paths instead of a directory listing. Server-side only. */
  virtual: string[];
  /** Type-ahead search string (mc's C-s), shown in the mini-status. */
  quick: string;

  /** Where this panel has been, oldest first, and where in that list it
   *  currently stands. Per panel, as mc keeps it: the two sides walk their own
   *  trails, and M-y/M-u step back and forward along this one. A chdir that is
   *  not itself a history step truncates everything ahead of the cursor — the
   *  browser rule, and the only one that does not resurrect a path the user
   *  has walked away from. */
  history: string[];
  historyPos: number;

  /** Set when the panel is inside an archive (mc's VFS). `inner` is the
   *  directory within it. Server-side only — the client sees the composed
   *  `path` and `inArchive`. */
  vfs: { archive: string; kind: "tar" | "zip"; inner: string } | null;
  /** `vfs !== null`, published because the CLIENT has to know: F3 and F5 mean
   *  "extract" inside an archive and "copy" outside it. Inferring it from the
   *  `#` in the composed path made a directory whose name contains a `#` — a
   *  perfectly legal one — silently refuse both. */
  inArchive: boolean;

  /** The window the UI renders. */
  rows: RowView[];
  /** Index of `rows[0]` within the listing. */
  offset: number;
  /** Characters of the NAME column scrolled off to the left (mc's M-( / M-)).
   *  A panel narrower than its filenames otherwise has no way to show their
   *  tails; ellipsis tells you something is missing but not what. */
  hscroll: number;
  /** How many rows fit on screen — the UI reports it, the panel scrolls to it.
   *  In brief mode this counts every CELL across all columns. */
  viewport: number;
  /** Columns the listing is laid out in (1 outside brief mode). Left/right
   *  cursor motion is a column jump, which needs this number server-side. */
  columns: number;
  /** Cursor position within the listing (absolute, not window-relative). */
  cursor: number;
  /** `all.length` — the UI needs the total for the scrollbar without the data. */
  count: number;

  sort: SortKey;
  reverse: boolean;
  dirsFirst: boolean;
  caseSensitive: boolean;
  showHidden: boolean;
  /** Filename mask (`*.ts`) narrowing the listing — mc's panel filter. */
  filter: string;
  mode: ListMode;
  view: PanelView;

  /** Quick-view content: the first lines of the file the OTHER panel's cursor
   *  is on. Empty unless this panel is in quick-view mode. */
  preview: string[];

  markedCount: number;
  markedBytes: number;
  /** Name of the first marked file, `""` when nothing is marked. The client
   *  never receives `markedNames`, and a dialog that says "Copy … to:" still has to
   *  name the one file it is about. */
  markedFirst: string;
  totalBytes: number;

  free: number;
  total: number;
  /** The rest of what mc's info panel says about this filesystem: inodes, the
   *  device it lives on and its type. */
  nodesFree: number;
  nodesTotal: number;
  device: string;
  fstype: string;
  /** The full stat of the file the OTHER panel's cursor is on, loaded only
   *  while this panel is showing the info view — mc re-stats it on every move,
   *  and a listing row does not carry owner names or the other two clocks. */
  details: FileDetails | null;
  loading: boolean;
  /** Bumped on every completed load — the UI's cue that the listing is new. */
  generation: number;
};

/** The view options that turn a raw listing into what the panel shows. */
export type ViewOpts = Pick<
  PanelState,
  "sort" | "reverse" | "dirsFirst" | "caseSensitive" | "showHidden" | "filter"
>;

export type { FileDetails, FileEntry };
