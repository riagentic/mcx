// Server-only: the file search behind M-?.
//
// Name matching and content matching both run in wasm — the same glob and the
// same Boyer–Moore the panel and the viewer use, so a search of 100_000 files
// is bounded by the disk, not by the matcher.
import { globMatch, search } from "./core.server.ts";

export type Hit = { path: string; line: number; text: string };

export type FindOpts = {
  root: string;
  /** Filename mask (`*.ts`). Empty means every file. */
  mask: string;
  /** Content to grep for. Empty means "match on the name alone". */
  content: string;
  /** Fold case when matching the NAME — mc keeps this switch separate from the
   *  content one, because a mask and a grep are two different questions. */
  caseInsensitive: boolean;
  /** …and when matching the content. */
  contentCaseInsensitive: boolean;
  skipHidden: boolean;
  /** Walk subdirectories. Off searches the one directory — mc's "Find
   *  recursively", which is on by default and worth being able to turn off in a
   *  tree with a million files in it. */
  recursive: boolean;
  /** Follow symlinked directories. Off by default, as in mc: a link back up the
   *  tree is a search that never ends. */
  followSymlinks: boolean;
  /** Only match the content where it stands as a word of its own. */
  wholeWords: boolean;
  /** Report one line per file rather than every match in it. */
  firstHit: boolean;
  /** Stop after this many hits — a search that returns everything is a search
   *  nobody reads. */
  limit: number;
};

/** Is the byte at `i` part of a word? The test "Whole words" is made of. */
const isWordByte = (b: number | undefined): boolean =>
  b !== undefined &&
  ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) ||
    b === 95 || b >= 128);

/** Files bigger than this are not grepped: a 2 GB core dump is never what the
 *  user meant, and reading it would stall the search for minutes. */
const MAX_GREP_BYTES = 16 * 1024 * 1024;

export async function find(
  o: FindOpts,
  onHit: (h: Hit) => void,
  onDir: (path: string) => void,
  signal: AbortSignal,
): Promise<number> {
  const needle = new TextEncoder().encode(o.content);
  let found = 0;

  async function grep(path: string): Promise<void> {
    let bytes: Uint8Array;
    try {
      const st = await Deno.stat(path);
      if (st.size > MAX_GREP_BYTES) return;
      bytes = await Deno.readFile(path);
    } catch {
      return;
    }
    const dec = new TextDecoder(undefined, { fatal: false });

    // Every match, not just the first — mc reports each line, and "First hit"
    // is the switch that asks for one. The line number is carried forward
    // rather than recounted: matches only ever move right through the file.
    let from = 0;
    let line = 1;
    let counted = 0;
    for (;;) {
      if (signal.aborted || found >= o.limit) return;
      const at = search(bytes, needle, from, o.contentCaseInsensitive);
      if (at < 0) return;
      from = at + Math.max(1, needle.length);
      if (
        o.wholeWords &&
        (isWordByte(bytes[at - 1]) || isWordByte(bytes[at + needle.length]))
      ) {
        continue;
      }
      let start = at;
      while (start > 0 && bytes[start - 1] !== 10) start--;
      let end = at;
      while (end < bytes.length && bytes[end] !== 10) end++;
      for (let i = counted; i < start; i++) if (bytes[i] === 10) line++;
      counted = start;
      onHit({
        path,
        line,
        text: dec.decode(bytes.subarray(start, end)).slice(0, 300),
      });
      found++;
      if (o.firstHit) return;
      // Continue past this LINE: two matches on one line are one result.
      from = Math.max(from, end);
    }
  }

  async function walk(dir: string): Promise<void> {
    if (signal.aborted || found >= o.limit) return;
    onDir(dir);
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return; // unreadable directory: skipped, not fatal
    }
    for (const e of entries) {
      if (signal.aborted || found >= o.limit) return;
      if (o.skipHidden && e.name.startsWith(".")) continue;
      const path = dir === "/" ? `/${e.name}` : `${dir}/${e.name}`;
      if (e.isDirectory && (!e.isSymlink || o.followSymlinks)) {
        if (o.recursive) await walk(path);
        continue;
      }
      if (!e.isFile) continue;
      if (o.mask && !globMatch(o.mask, e.name, o.caseInsensitive)) continue;
      if (o.content) await grep(path);
      else {
        onHit({ path, line: 0, text: "" });
        found++;
      }
    }
  }

  await walk(o.root);
  return found;
}
