// Server-only: the directory tree's one syscall.
//
// A tree that stats every entry would take as long as `du`; a tree that only
// asks "which of these are directories" costs one `readdir` per node the user
// actually opened, which is why mc's tree feels instant on a home directory and
// this one has to as well.

/** Immediate subdirectories of `path`, sorted, hidden ones optional.
 *
 *  `readdir` already reports directory-ness, so this never stats. Symlinked
 *  directories are left out on purpose: a tree that follows them is a tree that
 *  can loop. */
export async function subdirs(
  path: string,
  showHidden: boolean,
): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(path)) {
      if (!e.isDirectory) continue;
      if (!showHidden && e.name.startsWith(".")) continue;
      out.push(e.name);
    }
  } catch {
    // Unreadable directory: an empty branch, not an error dialog. The panel
    // beside the tree will say so when the user tries to enter it.
    return [];
  }
  return out.sort((a, b) => a.localeCompare(b));
}
