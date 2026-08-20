// Builds rust/mcx-core → src/wasm/mcx_core.wasm.
//
// Wired into `deno task build` / `deno task compile` so a release can never
// ship a stale core, and safe to run by hand during development. It is a build
// step, not a runtime one: the committed .wasm is what `deno task dev` loads,
// so a machine without cargo can still run mcx.
import { dirname, fromFileUrl, join } from "@std/path";

const root = dirname(dirname(fromFileUrl(import.meta.url)));
const crate = join(root, "rust", "mcx-core");
const outDir = join(root, "src", "wasm");
const out = join(outDir, "mcx_core.wasm");
const artifact = join(
  crate,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "mcx_core.wasm",
);

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  const p = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${code}`);
}

if (import.meta.main) {
  try {
    await run("cargo", [
      "build",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
    ], crate);
  } catch (e) {
    // Fail loud with the fix — a silently skipped wasm build is a silently
    // slow app, and the difference only shows up on someone's 100k-file dir.
    console.error(
      `\n  mcx: wasm build failed — ${e instanceof Error ? e.message : e}\n` +
        `  fix: rustup target add wasm32-unknown-unknown\n`,
    );
    Deno.exit(1);
  }

  await Deno.mkdir(outDir, { recursive: true });
  await Deno.copyFile(artifact, out);
  const { size } = await Deno.stat(out);
  console.log(`  mcx: src/wasm/mcx_core.wasm  ${(size / 1024).toFixed(1)} KB`);
}
