// Server-only: the two files a comparison is of.
//
// Reading and writing them lives here for the reason every `*.server.ts` does:
// `Deno.*` in a cell file poisons the browser bundle.
import { joinLines, splitLines } from "../lib/text.ts";

/** Above this the comparison is refused rather than attempted: a diff is a
 *  thing you read, and a file too big to read is too big to diff. */
const MAX_DIFF_BYTES = 16 * 1024 * 1024;

export async function readLines(
  path: string,
): Promise<{ lines: string[]; error: string | null }> {
  try {
    const st = await Deno.stat(path);
    if (st.isDirectory) return { lines: [], error: `${path} is a directory` };
    if (st.size > MAX_DIFF_BYTES) {
      return {
        lines: [],
        error: `${(st.size / 1048576).toFixed(1)} MB is too large to compare`,
      };
    }
    return {
      lines: splitLines(await Deno.readTextFile(path)).lines,
      error: null,
    };
  } catch (e) {
    return { lines: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Write a merged side back, through the editor's atomic path so an
 *  interrupted save cannot leave half a file behind. */
export async function writeLines(
  path: string,
  lines: readonly string[],
): Promise<string | null> {
  const { write } = await import("./editor.server.ts");
  return await write(path, joinLines([...lines], true));
}
