// The README's screenshot, made reproducibly: `deno task shot`.
//
// Both panels are pointed at directories this script creates, so the image can
// never contain anything of the developer's own — no real home directory, no
// real filenames, nothing to redact before publishing.

import { haveChromium, startApp } from "../src/test/e2e/driver.ts";

/** A plausible project for the left panel, and a downloads-ish directory for
 *  the right. Sizes and dates are set explicitly so the columns have something
 *  to show and the picture is the same every time it is taken. */
async function demoTrees(): Promise<{ left: string; right: string }> {
  const root = await Deno.makeTempDir({ prefix: "mcx-shot-" });
  // The left panel lives INSIDE the demo home, so the title bar shortens it to
  // `~/code/aurora` — a temp path in a published screenshot is just noise.
  const right = `${root}/home`;
  const left = `${right}/code/aurora`;

  const files: Array<[string, number, string]> = [
    // path, size in bytes, ISO date
    ["src/main.rs", 8_214, "2026-08-14T09:12:00"],
    ["src/parser.rs", 24_880, "2026-08-11T17:41:00"],
    ["src/lexer.rs", 12_006, "2026-08-11T17:38:00"],
    ["src/codegen.rs", 41_337, "2026-08-15T11:02:00"],
    ["tests/parser_test.rs", 6_120, "2026-08-09T08:20:00"],
    ["Cargo.toml", 412, "2026-07-30T14:05:00"],
    ["Cargo.lock", 18_744, "2026-07-30T14:05:00"],
    ["README.md", 3_180, "2026-08-16T10:30:00"],
    ["LICENSE", 1_064, "2026-06-02T09:00:00"],
    ["notes.txt", 2_048, "2026-08-18T22:14:00"],
    ["build.sh", 631, "2026-08-05T12:00:00"],
  ];
  for (const [rel, size, when] of files) {
    const path = `${left}/${rel}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, "x".repeat(size));
    const t = new Date(when);
    await Deno.utime(path, t, t);
  }
  await Deno.chmod(`${left}/build.sh`, 0o755);
  await Deno.mkdir(`${left}/target`, { recursive: true });
  await Deno.mkdir(`${left}/docs`, { recursive: true });

  const home: Array<[string, number, string]> = [
    ["aurora-0.4.1.tar.gz", 1_244_180, "2026-08-17T19:20:00"],
    ["dataset.csv", 8_912_004, "2026-08-16T13:45:00"],
    ["paper.pdf", 620_114, "2026-08-12T21:03:00"],
    ["todo.md", 1_412, "2026-08-19T07:55:00"],
    ["backup.zip", 3_301_776, "2026-08-02T16:30:00"],
  ];
  for (const [name, size, when] of home) {
    await Deno.mkdir(right, { recursive: true });
    await Deno.writeTextFile(`${right}/${name}`, "x".repeat(size));
    const t = new Date(when);
    await Deno.utime(`${right}/${name}`, t, t);
  }
  for (const d of ["code", "documents", "music", "pictures"]) {
    await Deno.mkdir(`${right}/${d}`, { recursive: true });
  }
  return { left, right };
}

if (!haveChromium()) {
  console.error("no chromium — install it, or take the screenshot by hand");
  Deno.exit(1);
}

const { left, right } = await demoTrees();
const { app, stop } = await startApp({ cwd: left, home: right });
try {
  await app.waitFor(`!!document.querySelector('.panel .row')`, "the panels");
  // Something to look at: three marked FILES, so the mark colour and a real
  // byte total in the status line are both in the picture. `Insert` marks and
  // steps down, exactly as mc does, so three of them mark three rows.
  for (let i = 0; i < 5; i++) await app.key("ArrowDown"); // past the directories
  await app.key("Insert");
  await app.key("Insert");
  await app.key("Insert");
  await new Promise((r) => setTimeout(r, 700));
  await Deno.mkdir("docs", { recursive: true });
  await app.screenshot("docs/screenshot.png");
  const { size } = await Deno.stat("docs/screenshot.png");
  console.log(`docs/screenshot.png  ${(size / 1024).toFixed(0)} KB`);
} finally {
  await stop();
  await Deno.remove(left, { recursive: true }).catch(() => {});
  await Deno.remove(right, { recursive: true }).catch(() => {});
}
