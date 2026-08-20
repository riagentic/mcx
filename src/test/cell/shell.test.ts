// The shell — and specifically the thing that makes it mc's shell rather than a
// command runner: ONE process, so what a command changes is still true for the
// next one.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { panels } from "../../cell/panels.ts";
import { shell } from "../../cell/shell.ts";
import { ui } from "../../cell/ui.ts";

async function withShell(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "mcx-shell-" });
  const h = await bootCells([ui, panels, shell]);
  try {
    await panels.chdir("left", root);
    await fn(root);
  } finally {
    const io = await import("../../cell/shell.server.ts");
    io.stopSubshell();
    h.dispose();
  }
}

/** The output lines, without the echoed `$ command` header. */
const output = () =>
  shell.lines.filter((l) => !l.text.startsWith("$ ")).map((l) => l.text);

Deno.test("a command's output comes back", () =>
  withShell(async (root) => {
    await shell.exec("echo hello", root);
    assert(output().includes("hello"), JSON.stringify(output()));
    assertEquals(shell.exitCode, 0);
  }));

Deno.test("an exit status is reported, not swallowed", () =>
  withShell(async (root) => {
    await shell.exec("exit 3", root);
    assertEquals(shell.exitCode, 3);
  }));

Deno.test("a variable set in one command is still set in the next", () =>
  withShell(async (root) => {
    // The whole point of a subshell. Two separate processes cannot do this.
    await shell.exec("MCX_TEST_VAR=persisted", root);
    await shell.exec("echo $MCX_TEST_VAR", root);
    assert(output().includes("persisted"), JSON.stringify(output()));
  }));

Deno.test("a cd inside a script moves the panel with it", () =>
  withShell(async (root) => {
    await Deno.mkdir(`${root}/sub`);
    // Not a bare `cd` (which is handled separately) — a cd inside a command.
    await shell.exec("cd sub && pwd", root);
    assertEquals(
      await Deno.realPath(panels.left.path),
      await Deno.realPath(`${root}/sub`),
    );
  }));

Deno.test("stderr is shown, and marked as stderr", () =>
  withShell(async (root) => {
    await shell.exec("echo oops >&2", root);
    const err = shell.lines.filter((l) => l.err).map((l) => l.text);
    assert(err.includes("oops"), JSON.stringify(shell.lines));
  }));

Deno.test("a bare cd moves the panel without running anything", () =>
  withShell(async (root) => {
    await Deno.mkdir(`${root}/elsewhere`);
    await shell.exec(`cd ${root}/elsewhere`, root);
    assertEquals(
      await Deno.realPath(panels.left.path),
      await Deno.realPath(`${root}/elsewhere`),
    );
  }));

Deno.test("a compound command that starts with cd is not mistaken for one", () =>
  withShell(async (root) => {
    // `cd sub && …` is a command for the shell, not a panel navigation. Taking
    // it as one made the panel try to enter a directory called "sub && pwd".
    const io = await import("../../cell/shell.server.ts");
    assertEquals(io.cdTarget("cd /tmp"), "/tmp");
    assertEquals(io.cdTarget("cd"), "~");
    assertEquals(io.cdTarget("cd sub && pwd"), null);
    // `$VAR` stays a cd: the panel expands it exactly as mc's `examine_cd`
    // does, so `cd $HOME` moves the panel rather than the subshell.
    assertEquals(io.cdTarget("cd $HOME"), "$HOME");
    assertEquals(io.cdTarget("cd -"), "-");
    assertEquals(io.cdTarget("cd x; rm -rf y"), null);
    assertEquals(io.cdTarget("ls"), null);
    await Deno.mkdir(`${root}/two words`);
    assertEquals(io.cdTarget('cd "two words"'), "two words");
  }));

Deno.test("the shell exiting is reported, and the next command still works", () =>
  withShell(async (root) => {
    await shell.exec("exit 3", root);
    assertEquals(shell.exitCode, 3);
    // A fresh shell starts underneath — mc restarts its subshell too.
    await shell.exec("echo alive", root);
    assert(output().includes("alive"), JSON.stringify(output()));
    assertEquals(shell.exitCode, 0);
  }));

Deno.test("alt-tab completes a path the way a shell does", async () => {
  const h = await bootCells([panels, ui, shell]);
  const root = await Deno.makeTempDir({ prefix: "mcx-complete-" });
  try {
    await Deno.mkdir(`${root}/reports`);
    await Deno.writeTextFile(`${root}/report.txt`, "");
    await Deno.writeTextFile(`${root}/readme.md`, "");
    await Deno.writeTextFile(`${root}/.hidden`, "");

    // Several matches: the longest prefix they share, and the list.
    const many = await shell.complete("re", root);
    assertEquals(many.matches, ["readme.md", "report.txt", "reports/"]);
    assertEquals(many.common, "re");

    // One match: the whole name, with a slash when it is a directory — so a
    // second alt-tab walks into it rather than stopping at the name.
    const one = await shell.complete("reports", root);
    assertEquals(one.matches, ["reports/"]);

    const shared = await shell.complete("report", root);
    assertEquals(shared.common, "report");
    assertEquals(shared.matches, ["report.txt", "reports/"]);

    // A dotfile is offered only once the dot has been typed.
    assertEquals(
      (await shell.complete("", root)).matches.includes(".hidden"),
      false,
    );
    assertEquals((await shell.complete(".h", root)).matches, [".hidden"]);

    // An absolute path completes against ITS directory, not the panel's, and
    // the answer keeps the spelling that was typed.
    const abs = await shell.complete(`${root}/reports`, "/");
    assertEquals(abs.matches, [`${root}/reports/`]);

    // A directory that cannot be read is no completions, not a crash.
    assertEquals((await shell.complete("/nope/x", root)).matches, []);
  } finally {
    await Deno.remove(root, { recursive: true });
    h.dispose();
  }
});
