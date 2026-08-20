// mcx vs mc — the measurement the kata asks for.
//
// mc is a curses program with no scriptable timing surface, so the comparison
// is made where both do the SAME work on the SAME data: reading a directory of
// N entries and producing a sorted, filtered listing. For mc that is
// `mc --nocolor -P` startup against the same directory, measured end to end;
// for mcx it is the panel pipeline (readdir + stat + wasm sort) invoked
// directly. Where mc cannot be measured, the run says so rather than inventing
// a number.
//
// Run: deno task bench
import { arrange, readDir, readDirFast } from "../src/cell/listing.server.ts";
import {
  arrangeIndex,
  globFilter,
  globMatch,
  sortIndex,
} from "../src/cell/core.server.ts";
import { derive } from "../src/lib/panel.ts";
import type { ViewOpts } from "../src/type/panel.ts";

const SIZES = [1_000, 10_000, 100_000];
const REPEATS = 3;

const opts: ViewOpts = {
  sort: "name",
  reverse: false,
  dirsFirst: true,
  caseSensitive: false,
  showHidden: false,
  filter: "",
};

const ms = (n: number) => `${n.toFixed(1)}ms`;

async function makeTree(n: number): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: `mcx-bench-${n}-` });
  const writes: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    writes.push(
      Deno.writeTextFile(`${dir}/file-${String(i).padStart(6, "0")}.txt`, "x"),
    );
    if (writes.length >= 512) {
      await Promise.all(writes.splice(0));
    }
  }
  await Promise.all(writes);
  return dir;
}

async function timeIt(
  label: string,
  fn: () => Promise<unknown> | unknown,
): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now();
    await fn();
    runs.push(performance.now() - t0);
  }
  const best = Math.min(...runs);
  console.log(`    ${label.padEnd(42)} ${ms(best).padStart(9)}`);
  return best;
}

/** `ls -la` on the same directory — a C program doing the same syscalls and the
 *  same sort. When mc itself is not installed this is the honest C baseline for
 *  "is the panel load comparable", because the panel load IS those syscalls. */
async function timeLs(dir: string): Promise<number | null> {
  try {
    const runs: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const t0 = performance.now();
      const r = await new Deno.Command("ls", {
        args: ["-la", "--color=never", dir],
        stdout: "null",
        stderr: "null",
      }).output();
      if (!r.success) return null;
      runs.push(performance.now() - t0);
    }
    return Math.min(...runs);
  } catch {
    return null;
  }
}

/** mc's own startup on the same directory, if mc is installed. `-P` makes it
 *  print the cwd and exit, which is the shortest path through its own panel
 *  load — the closest apples-to-apples handle mc offers. */
async function timeMc(dir: string): Promise<number | null> {
  try {
    const runs: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const t0 = performance.now();
      const r = await new Deno.Command("mc", {
        args: ["--nocolor", "-P", "/dev/null", dir],
        stdout: "null",
        stderr: "null",
        stdin: "null",
      }).output();
      if (!r.success) return null;
      runs.push(performance.now() - t0);
    }
    return Math.min(...runs);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  console.log("\n  mcx benchmarks — panel pipeline\n");

  for (const n of SIZES) {
    console.log(`  ${n.toLocaleString()} entries`);
    const dir = await makeTree(n);
    try {
      let raw = await readDir(dir);
      await timeIt("phase 1: first paint (readdir)", async () => {
        arrange((await readDirFast(dir)).entries, opts);
      });
      await timeIt("readdir + stat (syscalls, Deno)", async () => {
        raw = await readDir(dir);
      });
      await timeIt("sort + filter (wasm)", () => arrange(raw.entries, opts));
      await timeIt(
        "full panel load",
        async () => arrange((await readDir(dir)).entries, opts),
      );
      // The four operations the kata puts a 25ms ceiling on, each measured on
      // the path the app actually takes. None of them may touch the disk.
      await timeIt(
        "re-sort by size (no disk)",
        () => arrange(raw.entries, { ...opts, sort: "size" }),
      );
      await timeIt(
        "mask filter *.txt (no disk)",
        () => arrange(raw.entries, { ...opts, filter: "*.txt" }),
      );
      await timeIt(
        "show hidden files (no disk)",
        () => arrange(raw.entries, { ...opts, showHidden: true }),
      );
      const listing = arrange(raw.entries, opts);
      const KEYSTROKES = 100;
      const held = await timeIt("cursor move + paging × 100", () => {
        // What a held arrow key costs: one `derive` per keystroke, which
        // rebuilds the published window and the status-line totals.
        for (let i = 0; i < KEYSTROKES; i++) {
          derive({
            all: listing,
            marked: [],
            cursor: i * 37 % listing.length,
            offset: 0,
            viewport: 40,
          });
        }
      });
      console.log(
        `    ${"  → per keystroke".padEnd(42)} ${
          ms(held / KEYSTROKES).padStart(9)
        }`,
      );

      const ls = await timeLs(dir);
      if (ls !== null) {
        console.log(
          `    ${"ls -la (C baseline, incl. spawn)".padEnd(42)} ${
            ms(ls).padStart(9)
          }`,
        );
      }
      const mc = await timeMc(dir);
      console.log(
        mc === null
          ? "    mc not installed — no direct comparison"
          : `    ${"mc --nocolor -P startup".padEnd(42)} ${ms(mc).padStart(9)}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
    console.log("");
  }

  console.log("  wasm primitives\n");

  const entry = (name: string, i: number) => ({
    name,
    kind: "file" as const,
    size: i,
    mtime: i,
    mode: 0o644,
    uid: 0,
    gid: 0,
    nlink: 1,
  });
  const shuffled = (i: number) => (i * 7919) % 100_000;

  // Three name shapes, because the sort's cost depends on where names start to
  // differ and real directories are full of shared leading runs.
  const SHAPES: [string, (i: number) => string][] = [
    ["shared prefix (entry-N.ts)", (i) => `entry-${shuffled(i)}.ts`],
    [
      "photo names (IMG_NNNNNN.jpg)",
      (i) => `IMG_${String(shuffled(i)).padStart(6, "0")}.jpg`,
    ],
    ["nothing in common", (i) => Math.abs(Math.sin(i) * 1e9).toString(36)],
  ];

  const byName = {
    key: "name" as const,
    reverse: false,
    dirsFirst: true,
    caseSensitive: false,
  };

  for (const [label, gen] of SHAPES) {
    const names = Array.from({ length: 100_000 }, (_, i) => entry(gen(i), i));
    await timeIt(`sortIndex 100k — ${label}`, () => sortIndex(names, byName));
    await timeIt(
      `  vs JS Array.sort + localeCompare`,
      () => [...names].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  const names = Array.from(
    { length: 100_000 },
    (_, i) => entry(`entry-${shuffled(i)}.ts`, i),
  );
  await timeIt("globMatch × 100k (one call each)", () => {
    for (const e of names) globMatch("*.ts", e.name, true);
  });
  await timeIt(
    "globFilter 100k (one batched call)",
    () => globFilter(names.map((e) => e.name), "*.ts", true),
  );
  await timeIt(
    "arrangeIndex 100k (filter+sort, 1 call)",
    () => arrangeIndex(names, { ...byName, showHidden: false, filter: "*.ts" }),
  );
  console.log("");
}
