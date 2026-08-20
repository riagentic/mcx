/** Filesystem vocabulary. Zero dependencies — this crosses server and browser. */

export type FileKind =
  | "file"
  | "dir"
  | "link"
  | "fifo"
  | "socket"
  | "block"
  | "char"
  | "unknown";

/** One row of a panel. Deliberately flat and numeric: this is the object that
 *  exists 100_000 times over and travels the wire on every directory change. */
export type FileEntry = {
  name: string;
  kind: FileKind;
  /** Bytes. For directories, mc shows a marker instead — see `formatSize`. */
  size: number;
  /** Epoch millis. */
  mtime: number;
  /** Unix mode bits (permissions only, kind lives in `kind`). */
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  /** Symlink target, when `kind === "link"`. */
  target?: string;
  /** A symlink whose target does not resolve — mc paints these differently. */
  broken?: boolean;
  /** Resolved kind behind a symlink, so `dir` styling follows the target. */
  linkKind?: FileKind;
  /** A directory whose contents have been counted (mc's C-Space): `size` is
   *  then a real byte total and the column shows it instead of `SUB-DIR`.
   *  Deliberately not a separate field — the number belongs where every other
   *  size lives, so sorting by size sorts a counted directory correctly. */
  sized?: boolean;
};

/** What `..` looks like. A real row, so cursor/selection logic has no special
 *  case beyond "you cannot mark it". */
export const UP_DIR = "..";

export type DirListing = {
  path: string;
  entries: FileEntry[];
  /** Directories that could not be read produce an error row, not a crash. */
  error: string | null;
  /** Free/total bytes of the filesystem holding `path`, for the status line. */
  free: number;
  total: number;
};

/** Everything mc's info panel prints about ONE file (src/filemanager/info.c),
 *  which is more than a listing row carries: the panel keeps names, sizes,
 *  times and modes for every entry, and this fills in the rest — owner names,
 *  the other two timestamps, the inode — for the one under the cursor. */
export type FileDetails = {
  path: string;
  size: number;
  mode: number;
  nlink: number;
  owner: string;
  group: string;
  atime: number;
  mtime: number;
  ctime: number;
  inode: number;
  dev: number;
  target: string | null;
  error: string | null;
};
