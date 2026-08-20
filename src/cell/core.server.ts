// Bindings to rust/mcx-core (wasm). Server-only: cell methods run on the
// server, so this module is reached exclusively through dynamic `import()`
// and never enters the browser bundle (docs/build/imports.md §2).
//
// The module is instantiated from BYTES rather than imported as an ES module.
// A static `import … from "*.wasm"` would put the binary in the TypeScript
// module graph, where aio's client-graph validator parses it as source and
// blocks the browser build on `Unexpected "\x00"`. Reading the file keeps the
// wasm out of that graph, and `deno compile` embeds every `.wasm` in the
// project as a data asset regardless (src/build/build-compile.ts), so the
// compiled binary still finds it next to this module.
import type { FileEntry } from "../type/fs.ts";
import { UP_DIR } from "../type/fs.ts";
import type { SortKey } from "../type/panel.ts";

type Core = {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  sort_index(
    names: number,
    namesLen: number,
    offs: number,
    count: number,
    sizes: number,
    mtimes: number,
    flags: number,
    key: number,
    opts: number,
    out: number,
    scratch: number,
  ): number;
  scratch_per_entry(): number;
  glob_match(p: number, pl: number, s: number, sl: number, ci: number): number;
  glob_filter(
    names: number,
    namesLen: number,
    offs: number,
    count: number,
    pat: number,
    patLen: number,
    ci: number,
    out: number,
  ): number;
  arrange_index(
    names: number,
    namesLen: number,
    offs: number,
    count: number,
    sizes: number,
    mtimes: number,
    flags: number,
    pat: number,
    patLen: number,
    key: number,
    opts: number,
    out: number,
    scratch: number,
  ): number;
  search_bytes(
    h: number,
    hl: number,
    n: number,
    nl: number,
    from: number,
    ci: number,
  ): bigint;
  rsearch_bytes(
    h: number,
    hl: number,
    n: number,
    nl: number,
    from: number,
    ci: number,
  ): bigint;
  line_index(buf: number, len: number, out: number, max: number): number;
  count_binary(buf: number, len: number): number;
};

const WASM_URL = new URL("../wasm/mcx_core.wasm", import.meta.url);

/** Fail loud, with the fix. A missing core is a broken build, not a reason to
 *  quietly fall back to a slow path nobody would ever notice was taken. */
async function load(): Promise<Core> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await Deno.readFile(WASM_URL);
  } catch (e) {
    throw new Error(
      `mcx-core: ${WASM_URL.pathname} is missing — run \`deno task wasm\` ` +
        `(cause: ${e instanceof Error ? e.message : e})`,
    );
  }
  // compile-then-instantiate: the single-argument overload is unambiguous,
  // where `instantiate(bytes)` types as the module form under Deno's lib.
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(bytes),
    {},
  );
  return instance.exports as unknown as Core;
}

const wasm = await load();
const enc = new TextEncoder();

/** One wasm allocation carved into aligned sub-buffers.
 *
 *  Two reasons this exists rather than one `alloc` per array: allocation is the
 *  only thing that can grow linear memory (invalidating every JS view), and
 *  `Float64Array` refuses a byteOffset that is not a multiple of 8 — which
 *  `Vec<u8>`'s pointer has no reason to be.
 *
 *  An arena hands out OFFSETS, and every view onto them is made fresh at the
 *  moment of use. That is not fastidiousness: a `Vec` inside the module can
 *  grow linear memory, and growing it detaches every `TypedArray` JS is holding
 *  — so a view cached across a wasm call is a `TypeError` waiting for a
 *  directory one page bigger than the last one. */
class Arena {
  readonly ptr: number;
  readonly size: number;
  private off = 0;
  constructor(size: number) {
    // Slack covers the worst-case padding of every sub-buffer in one arena
    // (up to 7 bytes before each 8-aligned view, 3 before each 4-aligned one).
    this.size = size + 64;
    this.ptr = wasm.alloc(this.size);
    if (this.ptr === 0) throw new Error("mcx-core: wasm allocation failed");
  }
  /** Reserve `bytes` at `align`, returning the offset into linear memory. */
  take(bytes: number, align: number): number {
    const base = this.ptr + this.off;
    const pad = (align - (base % align)) % align;
    const at = base + pad;
    this.off += pad + bytes;
    if (this.off > this.size) throw new Error("mcx-core: arena overflow");
    return at;
  }
  free(): void {
    wasm.dealloc(this.ptr, this.size);
  }
}

/** Fresh views onto linear memory — never stored, always made at the point of
 *  use, for the reason `Arena` documents. */
const u8 = (at: number, n: number) => new Uint8Array(wasm.memory.buffer, at, n);
const u32 = (at: number, n: number) =>
  new Uint32Array(wasm.memory.buffer, at, n);
const f64 = (at: number, n: number) =>
  new Float64Array(wasm.memory.buffer, at, n);

const SORT_KEY: Record<SortKey, number> = {
  name: 0,
  ext: 1,
  size: 2,
  mtime: 3,
  unsorted: 4,
  version: 5,
};

export type SortOpts = {
  key: SortKey;
  reverse: boolean;
  dirsFirst: boolean;
  caseSensitive: boolean;
};

export type ArrangeOpts = SortOpts & {
  /** Filename mask; `""` means "no mask". */
  filter: string;
  showHidden: boolean;
};

/** A listing packed into one wasm arena: names end to end, plus the three
 *  numbers per entry the comparator needs.
 *
 *  Every caller here needs exactly this, and building it is what a 100_000-entry
 *  directory actually costs — so it is built once per call and handed to
 *  whichever entry point the caller wanted. */
type Packed = {
  names: number;
  /** Bytes actually written at `names`. */
  used: number;
  offs: number;
  sizes: number;
  mtimes: number;
  flags: number;
  out: number;
  scratch: number;
};

/** Scratch the sort needs per entry, asked of the module rather than assumed. */
const SCRATCH = wasm.scratch_per_entry();

/** Extra arena bytes a `Packed` needs beyond the name bound, per entry. */
const PER_ENTRY = 8 + 8 + 1 + 4 + 4 + SCRATCH;

/** Names are joined on NUL and encoded in ONE call.
 *
 *  `encodeInto` per name means a fresh `subarray` view per name too, and at
 *  100_000 entries those 200_000 allocations cost more than the sort they feed.
 *  A POSIX filename cannot contain NUL, so the separator is unambiguous and the
 *  boundaries can be recovered by scanning the bytes back. */
function packNames(
  entries: readonly FileEntry[],
  names: Uint8Array,
  offs: Uint32Array,
): number {
  const n = entries.length;
  if (n === 0) return 0;
  let joined = entries[0]!.name;
  for (let i = 1; i < n; i++) joined += "\0" + entries[i]!.name;
  const { written } = enc.encodeInto(joined, names);

  let at = 0, i = 0;
  offs[0] = 0;
  for (let b = 0; b < written; b++) {
    if (names[b] === 0) {
      // The separator is not part of either name: this one ends here, the next
      // starts after it.
      offs[++i] = b + 1 - i;
      continue;
    }
    names[at++] = names[b]!;
  }
  if (i !== n - 1) {
    // Only reachable if the name buffer was undersized and `encodeInto` stopped
    // early. Better a loud bug here than a listing quietly missing its tail.
    throw new Error(`mcx-core: packed ${i + 1} of ${n} names`);
  }
  offs[n] = at;
  return at;
}

function pack(a: Arena, entries: readonly FileEntry[], bound: number): Packed {
  const n = entries.length;
  const p: Packed = {
    names: a.take(bound, 1),
    used: 0,
    offs: a.take((n + 1) * 4, 4),
    sizes: a.take(n * 8, 8),
    mtimes: a.take(n * 8, 8),
    flags: a.take(n, 1),
    out: a.take(n * 4, 4),
    scratch: a.take(n * SCRATCH, 8),
  };

  const sizes = f64(p.sizes, n);
  const mtimes = f64(p.mtimes, n);
  const flags = u8(p.flags, n);
  for (let i = 0; i < n; i++) {
    const e = entries[i]!;
    sizes[i] = e.size;
    mtimes[i] = e.mtime;
    const dirish = e.kind === "dir" ||
      (e.kind === "link" && e.linkKind === "dir");
    flags[i] = (dirish ? 1 : 0) | (e.name === UP_DIR ? 2 : 0);
  }

  p.used = packNames(entries, u8(p.names, bound), u32(p.offs, n + 1));
  return p;
}

/** Upper bound on the UTF-8 size of every name: UTF-8 is at most 3 bytes per
 *  UTF-16 code unit (surrogate pairs are 2 units → 4 bytes, so 3× still
 *  bounds it). */
function nameBytes(entries: readonly FileEntry[]): number {
  let bound = 0;
  for (const e of entries) bound += e.name.length * 3;
  return bound;
}

const optBits = (o: SortOpts & { showHidden?: boolean }): number =>
  (o.reverse ? 1 : 0) | (o.dirsFirst ? 2 : 0) | (o.caseSensitive ? 4 : 0) |
  (o.showHidden ? 8 : 0);

/** Sort a listing, returning the permutation. The entries themselves never
 *  cross into wasm — only their names and three numbers each. */
export function sortIndex(
  entries: readonly FileEntry[],
  o: SortOpts,
): Uint32Array {
  const n = entries.length;
  if (n === 0) return new Uint32Array(0);

  const bound = nameBytes(entries);
  const a = new Arena(bound + n * PER_ENTRY);
  try {
    const p = pack(a, entries, bound);
    const rc = wasm.sort_index(
      p.names,
      p.used,
      p.offs,
      n,
      p.sizes,
      p.mtimes,
      p.flags,
      SORT_KEY[o.key],
      optBits(o),
      p.out,
      p.scratch,
    );
    if (rc < 0) throw new Error("mcx-core: sort_index rejected its input");
    return u32(p.out, n).slice();
  } finally {
    a.free();
  }
}

/** Filter and sort in ONE crossing — hidden files, the file mask and the sort
 *  order all applied inside wasm, returning the indices that survived in the
 *  order they should be drawn.
 *
 *  The alternative (filter in JS, `globFilter`, then `sortIndex`) packed every
 *  name into linear memory twice and built two throwaway JS arrays in between.
 *  At 100_000 entries that marshalling, not the matching, was the whole cost. */
export function arrangeIndex(
  entries: readonly FileEntry[],
  o: ArrangeOpts,
): Uint32Array {
  const n = entries.length;
  if (n === 0) return new Uint32Array(0);

  const mask = enc.encode(o.filter);
  const bound = nameBytes(entries);
  const a = new Arena(bound + mask.length + n * PER_ENTRY);
  try {
    const p = pack(a, entries, bound);
    const pat = a.take(mask.length, 1);
    u8(pat, mask.length).set(mask);

    const kept = wasm.arrange_index(
      p.names,
      p.used,
      p.offs,
      n,
      p.sizes,
      p.mtimes,
      p.flags,
      pat,
      mask.length,
      SORT_KEY[o.key],
      optBits(o),
      p.out,
      p.scratch,
    );
    if (kept < 0) throw new Error("mcx-core: arrange_index rejected its input");
    return u32(p.out, n).slice(0, kept);
  } finally {
    a.free();
  }
}

/** fnmatch-style mask test (`*.ts`, `[a-c]*`). */
export function globMatch(
  pattern: string,
  s: string,
  caseInsensitive = false,
): boolean {
  const p = enc.encode(pattern);
  const t = enc.encode(s);
  const a = new Arena(p.length + t.length);
  try {
    const pb = a.take(p.length, 1);
    const tb = a.take(t.length, 1);
    u8(pb, p.length).set(p);
    u8(tb, t.length).set(t);
    return wasm.glob_match(
      pb,
      p.length,
      tb,
      t.length,
      caseInsensitive ? 1 : 0,
    ) === 1;
  } finally {
    a.free();
  }
}

/** Match a whole list of names against one mask in a single wasm call.
 *
 *  The one-at-a-time `globMatch` is fine for a mask typed into a dialog; a
 *  panel filtering 100_000 names needs this, because the boundary crossing —
 *  not the matching — is what costs. Returns the indices that matched. */
export function globFilter(
  names: readonly string[],
  pattern: string,
  caseInsensitive = false,
): Uint32Array {
  const n = names.length;
  if (n === 0) return new Uint32Array(0);
  const pat = enc.encode(pattern);

  let bound = 0;
  for (const s of names) bound += s.length * 3;

  const a = new Arena(bound + pat.length + (n + 1) * 4 + n * 4);
  try {
    const bufAt = a.take(bound, 1);
    const offsAt = a.take((n + 1) * 4, 4);
    const patAt = a.take(pat.length, 1);
    const outAt = a.take(n * 4, 4);

    const buf = u8(bufAt, bound);
    const offs = u32(offsAt, n + 1);
    u8(patAt, pat.length).set(pat);

    let at = 0;
    for (let i = 0; i < n; i++) {
      offs[i] = at;
      at += enc.encodeInto(names[i]!, buf.subarray(at)).written;
    }
    offs[n] = at;

    const matched = wasm.glob_filter(
      bufAt,
      at,
      offsAt,
      n,
      patAt,
      pat.length,
      caseInsensitive ? 1 : 0,
      outAt,
    );
    if (matched < 0) {
      throw new Error("mcx-core: glob_filter rejected its input");
    }
    return u32(outAt, n).slice(0, matched);
  } finally {
    a.free();
  }
}

/** Byte offset of `needle` in `hay` at/after `from`, or -1. */
export function search(
  hay: Uint8Array,
  needle: Uint8Array,
  from = 0,
  caseInsensitive = false,
  backwards = false,
): number {
  const a = new Arena(hay.length + needle.length);
  try {
    const hb = a.take(hay.length, 1);
    const nb = a.take(needle.length, 1);
    u8(hb, hay.length).set(hay);
    u8(nb, needle.length).set(needle);
    const fn = backwards ? wasm.rsearch_bytes : wasm.search_bytes;
    return Number(
      fn(hb, hay.length, nb, needle.length, from, caseInsensitive ? 1 : 0),
    );
  } finally {
    a.free();
  }
}

/** Line-start offsets for `buf`, capped at `max` lines. */
export function lineIndex(buf: Uint8Array, max: number): Uint32Array {
  const a = new Arena(buf.length + max * 4);
  try {
    const b = a.take(buf.length, 1);
    const out = a.take(max * 4, 4);
    u8(b, buf.length).set(buf);
    const n = wasm.line_index(b, buf.length, out, max);
    return u32(out, max).slice(0, Math.max(0, n));
  } finally {
    a.free();
  }
}

/** How many of the first bytes look non-textual — the viewer's hex-mode
 *  heuristic. */
export function countBinary(buf: Uint8Array): number {
  const a = new Arena(buf.length);
  try {
    const b = a.take(buf.length, 1);
    u8(b, buf.length).set(buf);
    return wasm.count_binary(b, buf.length);
  } finally {
    a.free();
  }
}
