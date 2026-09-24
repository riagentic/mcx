// Server-only: the file-viewing session.
//
// A viewer that reads the whole file into memory is a viewer that cannot open
// a log. This one keeps ONE open handle plus a line index it extends lazily as
// the user scrolls, so opening a 2 GB file costs a stat and one 1 MiB read.
// The index and the buffer live here — module state, not cell state — because
// they are megabytes that no client should ever receive.
import { countBinary, lineIndex, search } from "./core.server.ts";

const CHUNK = 1 << 20;
/** Bytes sampled to decide text-vs-binary — mc looks at the head too. */
const SNIFF = 4096;

type Session = {
  path: string;
  file: Deno.FsFile;
  size: number;
  /** Byte offset of each line start, extended on demand. */
  index: number[];
  /** How far the index has been built. */
  indexed: number;
  /** True once the index covers the whole file. */
  complete: boolean;
  binary: boolean;
};

let session: Session | null = null;

/** The decoder in use. Rebuilt only when the charset changes: constructing one
 *  per window would be a per-keystroke allocation on a file being scrolled. */
let dec = new TextDecoder(undefined, { fatal: false });
let charset = "utf-8";

/** M-e — read the SAME bytes as a different character set. Nothing on disk
 *  changes; a file that was mojibake a moment ago is simply being decoded the
 *  way it was written. */
export function setCharset(label: string): void {
  if (label === charset) return;
  try {
    dec = new TextDecoder(label, { fatal: false });
    charset = label;
  } catch {
    dec = new TextDecoder(undefined, { fatal: false });
    charset = "utf-8";
  }
}

export type OpenResult = {
  size: number;
  binary: boolean;
  error: string | null;
};

export async function open(path: string): Promise<OpenResult> {
  close();
  try {
    const st = await Deno.stat(path);
    if (st.isDirectory) {
      return { size: 0, binary: false, error: "is a directory" };
    }
    const file = await Deno.open(path, { read: true });
    const head = new Uint8Array(Math.min(SNIFF, st.size));
    if (head.length > 0) await file.read(head);
    // A handful of control bytes in the first 4 KiB is what "binary" means in
    // practice — one stray NUL in a UTF-16 file should not force hex mode, and
    // a real ELF header trips this instantly.
    const binary = head.length > 0 && countBinary(head) / head.length > 0.05;
    session = {
      path,
      file,
      size: st.size,
      index: [0],
      indexed: 0,
      complete: st.size === 0,
      binary,
    };
    return { size: st.size, binary, error: null };
  } catch (e) {
    return {
      size: 0,
      binary: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function close(): void {
  if (!session) return;
  try {
    session.file.close();
  } catch { /* already closed */ }
  session = null;
}

async function readAt(
  s: Session,
  offset: number,
  len: number,
): Promise<Uint8Array> {
  const n = Math.max(0, Math.min(len, s.size - offset));
  const buf = new Uint8Array(n);
  if (n === 0) return buf;
  await s.file.seek(offset, Deno.SeekMode.Start);
  let got = 0;
  while (got < n) {
    const r = await s.file.read(buf.subarray(got));
    if (r === null) break;
    got += r;
  }
  return buf.subarray(0, got);
}

/** Extend the line index until it holds `want` lines or the file ends. */
async function ensureLines(s: Session, want: number): Promise<void> {
  while (!s.complete && s.index.length < want) {
    const chunk = await readAt(s, s.indexed, CHUNK);
    if (chunk.length === 0) {
      s.complete = true;
      break;
    }
    // `lineIndex` reports offsets relative to the chunk, including 0 — which is
    // already known as the previous chunk's tail, so it is dropped.
    const rel = lineIndex(chunk, chunk.length + 1);
    for (let i = 1; i < rel.length; i++) s.index.push(s.indexed + rel[i]!);
    s.indexed += chunk.length;
    if (s.indexed >= s.size) s.complete = true;
  }
}

export type TextWindow = {
  lines: string[];
  /** Index of the first returned line. */
  first: number;
  /** Lines known so far (a lower bound until `complete`). */
  known: number;
  complete: boolean;
};

/** `count` lines starting at line `from`. */
export async function textWindow(
  from: number,
  count: number,
): Promise<TextWindow> {
  const s = session;
  if (!s) return { lines: [], first: 0, known: 0, complete: true };

  await ensureLines(s, from + count + 1);
  const first = Math.max(0, Math.min(from, Math.max(0, s.index.length - 1)));
  const start = s.index[first] ?? 0;
  const endLine = Math.min(s.index.length, first + count);
  const end = endLine < s.index.length ? s.index[endLine]! : s.size;

  const buf = await readAt(s, start, end - start);
  const text = dec.decode(buf);
  const lines = text.split("\n");
  // `split` leaves a trailing empty element for a text ending in a newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return {
    lines: lines.slice(0, count).map((l) => l.replace(/\r$/, "")),
    first,
    known: s.index.length,
    complete: s.complete,
  };
}

/** A word byte, for "Whole words" — the same rule the file search uses. */
const isWordByte = (b: number | undefined): boolean =>
  b !== undefined &&
  ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) ||
    b === 95 || b >= 128);

export type HexRow = { offset: number; bytes: number[]; text: string };

/** `rows` lines of 16 bytes each, starting at byte `offset`. */
export async function hexWindow(
  offset: number,
  rows: number,
  /** Bytes edited but not yet saved, by absolute offset — the window shows
   *  what the file WILL be, which is the only useful thing for it to show. */
  changes: Record<number, number> = {},
): Promise<HexRow[]> {
  const s = session;
  if (!s) return [];
  const start = Math.max(0, Math.min(offset, Math.max(0, s.size - 1)));
  const buf = await readAt(s, start, rows * 16);
  for (const [at, byte] of Object.entries(changes)) {
    const i = Number(at) - start;
    if (i >= 0 && i < buf.length) buf[i] = byte;
  }
  const out: HexRow[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, Math.min(i + 16, buf.length));
    out.push({
      offset: start + i,
      bytes: [...slice],
      text: [...slice].map((
        b,
      ) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join(""),
    });
  }
  return out;
}

/** Search the file for `needle`, scanning in overlapping chunks so a match
 *  straddling a boundary is still found. Forwards, the answer is the first
 *  match starting at or after `fromByte`; backwards, the last one starting
 *  strictly before it — which is what makes repeated "find previous" walk the
 *  file instead of returning the same hit. Returns a byte offset, or -1. */
export async function findBytes(
  needle: string,
  fromByte: number,
  caseInsensitive: boolean,
  backwards: boolean,
  wholeWords = false,
): Promise<number> {
  const s = session;
  if (!s || needle.length === 0) return -1;
  const pat = new TextEncoder().encode(needle);
  const overlap = pat.length;

  /** mc's "Whole words": the bytes on either side of a hit must not be word
   *  bytes. Read one byte EARLIER than the window needs, so the character
   *  before a hit at the window's start is in the buffer to be looked at. */
  const bounded = (buf: Uint8Array, hit: number): boolean =>
    !wholeWords ||
    (!isWordByte(buf[hit - 1]) && !isWordByte(buf[hit + pat.length]));

  if (!backwards) {
    let at = Math.max(0, fromByte);
    while (at < s.size) {
      const pad = at > 0 ? 1 : 0;
      const buf = await readAt(s, at - pad, CHUNK + overlap + pad);
      if (buf.length === 0) break;
      let from = pad;
      for (;;) {
        const hit = search(buf, pat, from, caseInsensitive);
        if (hit < 0) break;
        if (bounded(buf, hit)) return at - pad + hit;
        from = hit + 1;
      }
      at += CHUNK;
    }
    return -1;
  }

  // Windows tile [0, fromByte) exactly — each one reads `overlap - 1` bytes
  // PAST its end so a match straddling the boundary is whole, and is asked for
  // the last match starting inside its own window. Clamping the search to the
  // window instead of filtering its answer is the difference: a hit rejected
  // after the fact abandoned every earlier match in the same megabyte.
  let end = Math.min(s.size, Math.max(0, fromByte));
  while (end > 0) {
    const start = Math.max(0, end - CHUNK);
    const pad = start > 0 ? 1 : 0;
    const buf = await readAt(s, start - pad, end - start + overlap - 1 + pad);
    let limit = Math.min(buf.length - pat.length, end - 1 - start + pad);
    for (;;) {
      const hit = limit < 0
        ? -1
        : search(buf, pat, limit, caseInsensitive, true);
      if (hit < 0 || hit < pad) break;
      if (bounded(buf, hit)) return start - pad + hit;
      limit = hit - 1;
    }
    end = start;
  }
  return -1;
}

/** Which line a byte offset falls on — how a search result becomes a scroll
 *  position in text mode. */
export async function lineOfByte(byte: number): Promise<number> {
  const s = session;
  if (!s) return 0;
  // The index is monotonic, so a binary search is exact once it covers `byte`.
  while (!s.complete && (s.index[s.index.length - 1] ?? 0) < byte) {
    await ensureLines(s, s.index.length + 4096);
  }
  let lo = 0, hi = s.index.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.index[mid]! <= byte) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const byteOfLine = (line: number): number => session?.index[line] ?? 0;
export const currentSize = (): number => session?.size ?? 0;

/** Write pending hex edits back into the file, in place.
 *
 *  In place and byte by byte: a hex edit never changes the length, so there is
 *  nothing to rewrite and no temp file to swap — which is also why the viewer
 *  can do this to a 2 GB file it has never read whole.
 *
 *  Nothing is cached between reads, so the next window shows the new bytes
 *  without anything having to be invalidated. */
export async function writeBytes(
  path: string,
  changes: Record<number, number>,
): Promise<string | null> {
  const entries = Object.entries(changes)
    .map(([at, byte]) => [Number(at), byte] as const)
    .sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) return null;
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true, write: true });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  try {
    // Runs of adjacent bytes go out as one write — a change list from a real
    // edit is almost always a handful of runs, not a scatter.
    let i = 0;
    while (i < entries.length) {
      let j = i + 1;
      while (j < entries.length && entries[j]![0] === entries[j - 1]![0] + 1) {
        j++;
      }
      const run = new Uint8Array(entries.slice(i, j).map(([, b]) => b));
      await file.seek(entries[i]![0], Deno.SeekMode.Start);
      let written = 0;
      while (written < run.length) {
        written += await file.write(run.subarray(written));
      }
      i = j;
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    file.close();
  }
  return null;
}
