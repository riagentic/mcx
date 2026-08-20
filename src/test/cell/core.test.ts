// The wasm core, tested against a plain-TypeScript oracle.
//
// The point is not "does Rust work" — it is that the fast path and the obvious
// path agree. A sort that is quick and subtly different from the specification
// is worse than a slow one.
import { assertEquals } from "@std/assert";
import {
  arrangeIndex,
  countBinary,
  globMatch,
  lineIndex,
  search,
  sortIndex,
} from "../../cell/core.server.ts";
import type { FileEntry } from "../../type/fs.ts";

const e = (
  name: string,
  p: Partial<FileEntry> = {},
): FileEntry => ({
  name,
  kind: "file",
  size: 0,
  mtime: 0,
  mode: 0o644,
  uid: 0,
  gid: 0,
  nlink: 1,
  ...p,
});

const names = (entries: FileEntry[], order: Uint32Array) =>
  [...order].map((i) => entries[i]!.name);

const OPTS = {
  key: "name" as const,
  reverse: false,
  dirsFirst: true,
  caseSensitive: false,
};

Deno.test("sort: .. first, directories before files, then by name", () => {
  const list = [
    e("zeta"),
    e("dir-b", { kind: "dir" }),
    e("Alpha"),
    e(".."),
    e("dir-a", { kind: "dir" }),
  ];
  assertEquals(names(list, sortIndex(list, OPTS)), [
    "..",
    "dir-a",
    "dir-b",
    "Alpha",
    "zeta",
  ]);
});

Deno.test("sort: reverse keeps .. and directories in place", () => {
  const list = [e(".."), e("a"), e("b"), e("d", { kind: "dir" })];
  const order = names(list, sortIndex(list, { ...OPTS, reverse: true }));
  assertEquals(order, ["..", "d", "b", "a"]);
});

Deno.test("sort: case-insensitive by default, case-sensitive on request", () => {
  const list = [e("b"), e("A"), e("a"), e("B")];
  assertEquals(names(list, sortIndex(list, { ...OPTS, dirsFirst: false })), [
    "A",
    "a",
    "B",
    "b",
  ]);
  assertEquals(
    names(
      list,
      sortIndex(list, { ...OPTS, dirsFirst: false, caseSensitive: true }),
    ),
    ["A", "B", "a", "b"],
  );
});

Deno.test("sort: by size, extension and mtime, each tie-broken by name", () => {
  const list = [e("c", { size: 5 }), e("a", { size: 5 }), e("b", { size: 1 })];
  assertEquals(
    names(list, sortIndex(list, { ...OPTS, key: "size", dirsFirst: false })),
    ["b", "a", "c"],
  );

  const exts = [e("x.ts"), e("a.rs"), e("b.ts"), e("noext")];
  assertEquals(
    names(exts, sortIndex(exts, { ...OPTS, key: "ext", dirsFirst: false })),
    ["noext", "a.rs", "b.ts", "x.ts"],
  );

  const times = [
    e("new", { mtime: 300 }),
    e("old", { mtime: 100 }),
    e("mid", { mtime: 200 }),
  ];
  assertEquals(
    names(times, sortIndex(times, { ...OPTS, key: "mtime", dirsFirst: false })),
    ["old", "mid", "new"],
  );
});

Deno.test("sort: unsorted preserves the order the filesystem gave", () => {
  const list = [e("z"), e("a"), e("m")];
  assertEquals(
    names(
      list,
      sortIndex(list, { ...OPTS, key: "unsorted", dirsFirst: false }),
    ),
    ["z", "a", "m"],
  );
});

Deno.test("sort: version order counts, where name order spells", () => {
  // mc's `sort_vers`, and the reason it exists: by name, `f10` comes second.
  const list = [e("f10"), e("f2"), e("f1"), e("f20"), e("f3")];
  assertEquals(
    names(list, sortIndex(list, { ...OPTS, key: "version", dirsFirst: false })),
    ["f1", "f2", "f3", "f10", "f20"],
  );
  assertEquals(
    names(list, sortIndex(list, { ...OPTS, key: "name", dirsFirst: false })),
    ["f1", "f10", "f2", "f20", "f3"],
  );

  // Numbers embedded mid-name, and leading zeros: same value, fewer zeros
  // first, so the order is total rather than "these two are equal".
  const mixed = [
    e("v1.10.0"),
    e("v1.9.0"),
    e("v1.10.1"),
    e("img007"),
    e("img7"),
  ];
  assertEquals(
    names(
      mixed,
      sortIndex(mixed, { ...OPTS, key: "version", dirsFirst: false }),
    ),
    ["img7", "img007", "v1.9.0", "v1.10.0", "v1.10.1"],
  );
});

Deno.test("sort: non-ASCII names order by codepoint, not by locale", () => {
  const list = [e("Ünter"), e("apple"), e("Zebra"), e("émile")];
  assertEquals(
    names(list, sortIndex(list, { ...OPTS, dirsFirst: false })),
    ["apple", "Zebra", "Ünter", "émile"],
  );
});

Deno.test("sort: 20k entries stay ordered and fast", () => {
  const list = Array.from(
    { length: 20_000 },
    (_, i) => e(`f${(i * 7919) % 20_000}`),
  );
  const t0 = performance.now();
  const order = sortIndex(list, { ...OPTS, dirsFirst: false });
  const ms = performance.now() - t0;
  assertEquals(order.length, 20_000);
  const out = names(list, order);
  const expected = list.map((x) => x.name).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  assertEquals(out, expected);
  // Generous ceiling: this is a regression tripwire, not a benchmark.
  if (ms > 500) {
    throw new Error(`sortIndex took ${ms.toFixed(1)}ms for 20k entries`);
  }
});

Deno.test("sort: randomized version order agrees with counting", () => {
  // `cmp_version` is hand-written digit-run comparison, so the risk is the
  // arithmetic in it: a run longer than a machine word, leading zeros, a number
  // that runs to the end of the name. Generated names of a known numeric shape
  // let the oracle be the number itself.
  let seed = 987654321;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let round = 0; round < 100; round++) {
    const pad = Math.floor(rnd() * 4); // 0–3 leading zeros
    const nums = new Set<number>();
    while (nums.size < 12) nums.add(Math.floor(rnd() * 100_000));
    const list = [...nums].map((n) =>
      e(`part${String(n).padStart(String(n).length + pad, "0")}.bin`)
    );
    const order = names(
      list,
      sortIndex(list, { ...OPTS, key: "version", dirsFirst: false }),
    );
    assertEquals(
      order,
      [...nums].sort((a, b) => a - b).map((n) =>
        `part${String(n).padStart(String(n).length + pad, "0")}.bin`
      ),
      `round ${round}`,
    );
  }

  // Zero padding is a tie-break, never an equality: the same number written
  // three ways still has one order, and it is the same one every run.
  const zeros = [e("x010"), e("x10"), e("x0010")];
  assertEquals(
    names(
      zeros,
      sortIndex(zeros, { ...OPTS, key: "version", dirsFirst: false }),
    ),
    ["x10", "x010", "x0010"],
  );
});

Deno.test("sort: randomized listings agree with the plain-TypeScript oracle", () => {
  // The name sort has a fast path (an 8-byte key taken past the run every name
  // shares) whose whole risk is that it orders SOME shapes differently from the
  // obvious comparison. So: many small listings, every option combination, the
  // shapes that stress it — a shared prefix, a shared prefix past eight bytes,
  // names differing only in case, non-ASCII — against the oracle every time.
  //
  // Seeded, so a failure reproduces exactly.
  let seed = 20240814;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const shapes = [
    () => `entry-${String(Math.floor(rnd() * 999)).padStart(6, "0")}.ts`,
    () => `IMG_${String(Math.floor(rnd() * 9999)).padStart(4, "0")}.jpg`,
    () => `${pick(["a", "A", "b", "B", "é", "Ü"])}${Math.floor(rnd() * 30)}`,
    () => `.hidden${Math.floor(rnd() * 40)}`,
  ];

  const enc = new TextEncoder();
  const cmpBytes = (a: Uint8Array, b: Uint8Array) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! - b[i]!;
    }
    return a.length - b.length;
  };
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const cmpName = (a: string, b: string, cs: boolean) =>
    cs
      ? cmpBytes(enc.encode(a), enc.encode(b))
      : cmpBytes(enc.encode(fold(a)), enc.encode(fold(b))) ||
        cmpBytes(enc.encode(a), enc.encode(b));

  for (let round = 0; round < 200; round++) {
    const unique = new Set<string>();
    const want = 1 + Math.floor(rnd() * 40);
    while (unique.size < want) unique.add(pick(shapes)());
    const list = [
      e(".."),
      ...[...unique].map((n) => e(n, { kind: rnd() < 0.3 ? "dir" : "file" })),
    ];
    const o = {
      ...OPTS,
      reverse: rnd() < 0.5,
      dirsFirst: rnd() < 0.5,
      caseSensitive: rnd() < 0.5,
      showHidden: rnd() < 0.5,
      filter: "",
    };

    const group = (x: FileEntry) =>
      x.name === ".." ? 0 : (o.dirsFirst && x.kind === "dir" ? 1 : 2);
    const expected = list
      .filter((x) => x.name === ".." || o.showHidden || !x.name.startsWith("."))
      .sort((a, b) =>
        group(a) - group(b) ||
        (o.reverse ? -1 : 1) * cmpName(a.name, b.name, o.caseSensitive)
      )
      .map((x) => x.name);

    assertEquals(
      names(list, arrangeIndex(list, o)),
      expected,
      `round ${round} with ${JSON.stringify(o)}`,
    );
  }
});

Deno.test("arrange: filter, hidden files and sort in one pass", () => {
  const list = [
    e(".."),
    e(".config", { kind: "dir" }),
    e("notes.md"),
    e("main.ts"),
    e("lib", { kind: "dir" }),
    e("a.ts"),
  ];
  const arranged = (o: Partial<Parameters<typeof arrangeIndex>[1]>) =>
    names(
      list,
      arrangeIndex(list, { ...OPTS, showHidden: false, filter: "", ...o }),
    );

  // `..` survives every filter — a panel you cannot walk out of is a trap.
  assertEquals(arranged({}), ["..", "lib", "a.ts", "main.ts", "notes.md"]);
  assertEquals(arranged({ filter: "*.ts" }), ["..", "a.ts", "main.ts"]);
  assertEquals(arranged({ showHidden: true }), [
    "..",
    ".config",
    "lib",
    "a.ts",
    "main.ts",
    "notes.md",
  ]);
  assertEquals(arranged({ showHidden: true, filter: "*.md" }), [
    "..",
    "notes.md",
  ]);
  // …and it agrees with doing it the long way, which is the whole point of
  // folding three steps into one wasm call.
  assertEquals(arranged({ filter: "*.ts" }), [
    "..",
    ...names(
      list.filter((x) => x.name.endsWith(".ts")),
      sortIndex(list.filter((x) => x.name.endsWith(".ts")), OPTS),
    ),
  ]);
});

Deno.test("a listing big enough to grow linear memory still returns", () => {
  // wasm's own allocations can grow linear memory, and growing it DETACHES
  // every TypedArray the host is holding. A view cached across the call used to
  // fail here with "detached ArrayBuffer" — at a directory size that depended
  // on the page boundary, which is the worst kind of bug to meet in the wild.
  const list = Array.from(
    { length: 60_000 },
    (_, i) => e(`entry-${(i * 7919) % 60_000}.ts`),
  );
  const order = arrangeIndex(list, {
    ...OPTS,
    showHidden: false,
    filter: "*.ts",
  });
  assertEquals(order.length, 60_000);
  assertEquals(names(list, order)[0], "entry-0.ts");
});

Deno.test("glob: the mask syntax mc users type", () => {
  assertEquals(globMatch("*.ts", "main.ts"), true);
  assertEquals(globMatch("*.ts", "main.tsx"), false);
  assertEquals(globMatch("a?c", "abc"), true);
  assertEquals(globMatch("a?c", "ac"), false);
  assertEquals(globMatch("[a-c]*", "banana"), true);
  assertEquals(globMatch("[a-c]*", "durian"), false);
  assertEquals(globMatch("[!a-c]*", "durian"), true);
  assertEquals(globMatch("*", "anything"), true);
  assertEquals(globMatch("", ""), true);
  assertEquals(globMatch("", "x"), false);
  assertEquals(globMatch("\\*.ts", "*.ts"), true);
  assertEquals(globMatch("*.TS", "main.ts", true), true);
  assertEquals(globMatch("*.TS", "main.ts", false), false);
});

Deno.test("glob: randomized patterns agree with a reference matcher", () => {
  // The matcher here is the linear-backtracking one; the reference is the
  // naive exponential recursion, which is obviously right and far too slow for
  // a panel. On patterns this short they must agree on every input — including
  // the shapes nobody tests by hand: an unterminated `[`, a trailing `\\`, a
  // `-` at the edge of a class, a `]` in first position.
  let seed = 4242;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(a: T[]): T => a[int(a.length)]!;

  const ref = (pat: string, s: string, ci: boolean): boolean => {
    const fold = (c: string) => (ci ? c.toLowerCase() : c);
    const go = (p: number, i: number): boolean => {
      if (p === pat.length) return i === s.length;
      const c = pat[p]!;
      if (c === "*") return go(p + 1, i) || (i < s.length && go(p, i + 1));
      if (i >= s.length) return false;
      if (c === "?") return go(p + 1, i + 1);
      if (c === "\\" && p + 1 < pat.length) {
        return fold(pat[p + 1]!) === fold(s[i]!) && go(p + 2, i + 1);
      }
      if (c === "[") {
        let q = p + 1;
        const neg = pat[q] === "!" || pat[q] === "^";
        if (neg) q++;
        let matched = false, first = true, closed = -1;
        while (q < pat.length) {
          if (pat[q] === "]" && !first) {
            closed = q;
            break;
          }
          first = false;
          let lo = pat[q]!;
          if (lo === "\\" && q + 1 < pat.length) lo = pat[++q]!;
          if (q + 2 < pat.length && pat[q + 1] === "-" && pat[q + 2] !== "]") {
            const ch = fold(s[i]!);
            if (fold(lo) <= ch && ch <= fold(pat[q + 2]!)) matched = true;
            q += 3;
          } else {
            if (fold(lo) === fold(s[i]!)) matched = true;
            q += 1;
          }
        }
        // An unterminated class is a literal `[`, as fnmatch has it.
        if (closed < 0) return fold("[") === fold(s[i]!) && go(p + 1, i + 1);
        return matched !== neg && go(closed + 1, i + 1);
      }
      return fold(c) === fold(s[i]!) && go(p + 1, i + 1);
    };
    return go(0, 0);
  };

  const PAT = ["a", "b", "A", ".", "*", "?", "[", "]", "-", "!", "\\", "t"];
  const SUB = ["a", "b", "A", ".", "t", "-", "[", "]"];
  for (let round = 0; round < 4000; round++) {
    const pat = Array.from({ length: 1 + int(6) }, () => pick(PAT)).join("");
    const s = Array.from({ length: int(6) }, () => pick(SUB)).join("");
    const ci = rnd() < 0.5;
    assertEquals(
      globMatch(pat, s, ci),
      ref(pat, s, ci),
      `pattern ${JSON.stringify(pat)} against ${JSON.stringify(s)} (ci=${ci})`,
    );
  }
});

Deno.test("glob: pathological patterns do not blow up", () => {
  const pat = "*a*a*a*a*a*a*a*b";
  const subject = "a".repeat(200);
  const t0 = performance.now();
  assertEquals(globMatch(pat, subject), false);
  if (performance.now() - t0 > 100) {
    throw new Error("glob backtracking is superlinear");
  }
});

const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test("search: forward, backward, missing, case folding", () => {
  const hay = bytes("the quick brown fox jumps over the lazy dog");
  assertEquals(search(hay, bytes("quick")), 4);
  assertEquals(search(hay, bytes("the"), 1), 31);
  assertEquals(search(hay, bytes("cat")), -1);
  assertEquals(search(hay, bytes("QUICK"), 0, true), 4);
  assertEquals(search(hay, bytes("QUICK"), 0, false), -1);
  assertEquals(search(hay, bytes("the"), hay.length - 1, false, true), 31);
});

Deno.test("lineIndex gives one offset per line start", () => {
  const buf = bytes("alpha\nbeta\n\ngamma");
  assertEquals([...lineIndex(buf, 100)], [0, 6, 11, 12]);
  // a trailing newline does not open a line that has no content
  assertEquals([...lineIndex(bytes("a\n"), 100)], [0]);
  assertEquals([...lineIndex(bytes(""), 100)], [0]);
  // the cap is respected
  assertEquals(lineIndex(buf, 2).length, 2);
});

Deno.test("countBinary separates text from binary", () => {
  assertEquals(countBinary(bytes("plain text\nwith newlines\t")), 0);
  assertEquals(countBinary(new Uint8Array([0, 1, 2, 65, 66])), 3);
});
