// Copy/move/delete against real files. Every assertion is "what is on disk
// afterwards", because that is the only thing a file manager promises.
//
// `bootCells` rather than `testCell`: an operation legitimately talks to the
// panels (reload when it finishes) and to the status line, so the test boots
// the same three cells the app does instead of pretending they are absent.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { fileops } from "../../cell/fileops.ts";
import { panels } from "../../cell/panels.ts";
import { ui } from "../../cell/ui.ts";
import { submit } from "../../ui/commands.ts";

async function tree(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "mcx-ops-" });
  await Deno.mkdir(`${root}/src/nested`, { recursive: true });
  await Deno.mkdir(`${root}/dst`);
  await Deno.writeTextFile(`${root}/src/a.txt`, "A".repeat(100));
  await Deno.writeTextFile(`${root}/src/nested/b.txt`, "B".repeat(50));
  await Deno.writeTextFile(`${root}/loose.txt`, "loose");
  return root;
}

const exists = async (p: string) => {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
};

/** The question the job in front is asking, if any. Several jobs can run at
 *  once now, so "the question" is always a question OF something. */
const question = (): string | null => fileops.frontJob()?.question?.dst ?? null;

/** Wait for a blocking question. `settle()` cannot do this: the method is
 *  deliberately parked until the test answers it. */
async function waitForQuestion(): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (question() !== null) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the overwrite question never appeared");
}

/** One booted app per test, disposed after. */
async function withApp(fn: (root: string) => Promise<void>): Promise<void> {
  const h = await bootCells([panels, ui, fileops]);
  try {
    await fn(await tree());
  } finally {
    h.dispose();
  }
}

Deno.test("copy duplicates a tree and leaves the source alone", () =>
  withApp(async (root) => {
    await fileops.run("copy", [`${root}/src`], `${root}/dst`);
    assertEquals(
      await Deno.readTextFile(`${root}/dst/src/a.txt`),
      "A".repeat(100),
    );
    assertEquals(
      await Deno.readTextFile(`${root}/dst/src/nested/b.txt`),
      "B".repeat(50),
    );
    assert(await exists(`${root}/src/a.txt`), "source must survive a copy");
    assertEquals(fileops.running(), false);
    assertEquals(fileops.errors.length, 0);
  }));

Deno.test("copying a file onto itself refuses instead of emptying it", () =>
  withApp(async (root) => {
    // Both panels on one directory is an ordinary state, and F5 there used to
    // open the destination with `truncate` before reading the source: 100
    // bytes became 0, and the status line said "Copied 1 of 1".
    await fileops.run("copy", [`${root}/src/a.txt`], `${root}/src`);
    assertEquals(
      await Deno.readTextFile(`${root}/src/a.txt`),
      "A".repeat(100),
    );
    assertEquals(fileops.errors.length, 1);

    // The same file reached by a different spelling is still the same file.
    await fileops.run("copy", [`${root}/src/a.txt`], `${root}/src/nested/..`);
    assertEquals((await Deno.stat(`${root}/src/a.txt`)).size, 100);
  }));

Deno.test("a directory cannot be copied into itself", () =>
  withApp(async (root) => {
    await fileops.run("copy", [`${root}/src`], `${root}/src/nested`);
    assert(!await exists(`${root}/src/nested/src`));
    assertEquals(fileops.errors.length, 1);
  }));

Deno.test("copy preserves the executable bit", () =>
  withApp(async (root) => {
    await Deno.chmod(`${root}/src/a.txt`, 0o755);
    await fileops.run("copy", [`${root}/src/a.txt`], `${root}/dst`);
    const st = await Deno.stat(`${root}/dst/a.txt`);
    assertEquals((st.mode ?? 0) & 0o777, 0o755);
  }));

Deno.test("copy preserves mtime", () =>
  withApp(async (root) => {
    const when = new Date(Date.now() - 86_400_000);
    await Deno.utime(`${root}/src/a.txt`, when, when);
    await fileops.run("copy", [`${root}/src/a.txt`], `${root}/dst`);
    const st = await Deno.stat(`${root}/dst/a.txt`);
    assertEquals(
      Math.round((st.mtime?.getTime() ?? 0) / 1000),
      Math.round(when.getTime() / 1000),
    );
  }));

Deno.test("copy reproduces symlinks as links, not as their targets", () =>
  withApp(async (root) => {
    await Deno.symlink("a.txt", `${root}/src/link`);
    await fileops.run("copy", [`${root}/src`], `${root}/dst`);
    const st = await Deno.lstat(`${root}/dst/src/link`);
    assert(st.isSymlink, "a copied symlink must still be a symlink");
    assertEquals(await Deno.readLink(`${root}/dst/src/link`), "a.txt");
  }));

Deno.test("move relocates a file and removes the source", () =>
  withApp(async (root) => {
    await fileops.run("move", [`${root}/loose.txt`], `${root}/dst`);
    assertEquals(await Deno.readTextFile(`${root}/dst/loose.txt`), "loose");
    assertEquals(await exists(`${root}/loose.txt`), false);
  }));

Deno.test("move takes a whole directory with it", () =>
  withApp(async (root) => {
    await fileops.run("move", [`${root}/src`], `${root}/dst`);
    assertEquals(
      await Deno.readTextFile(`${root}/dst/src/nested/b.txt`),
      "B".repeat(50),
    );
    assertEquals(await exists(`${root}/src`), false);
  }));

Deno.test("a file that fails is offered Retry, and Retry can succeed", () =>
  withApp(async (root) => {
    // A destination directory nothing may be written into: the copy fails,
    // mc stops and asks, and the answer that matters is Retry — after making
    // room (here, after making the directory writable) the copy finishes.
    const locked = `${root}/locked`;
    await Deno.mkdir(locked);
    await Deno.chmod(locked, 0o500);

    const running = fileops.run("copy", [`${root}/loose.txt`], locked);
    await waitForQuestion();
    assertEquals(fileops.frontJob()?.question?.kind, "error");

    await Deno.chmod(locked, 0o700);
    await fileops.answerQuestion("retry");
    await running;
    assertEquals(await Deno.readTextFile(`${locked}/loose.txt`), "loose");
    assertEquals(fileops.errors.length, 0);
  }));

Deno.test("'Ignore all' stops asking and finishes the rest", () =>
  withApp(async (root) => {
    const locked = `${root}/locked`;
    await Deno.mkdir(locked);
    await Deno.chmod(locked, 0o500);

    // Two files, both failing: one question, then silence.
    await Deno.writeTextFile(`${root}/second.txt`, "two");
    const running = fileops.run(
      "copy",
      [`${root}/loose.txt`, `${root}/second.txt`],
      locked,
    );
    await waitForQuestion();
    await fileops.answerQuestion("skipAll");
    await running;
    assertEquals(question(), null);
    assertEquals(fileops.errors.length, 2);
    await Deno.chmod(locked, 0o700);
  }));

Deno.test("delete removes files, and asks before removing a tree", () =>
  withApp(async (root) => {
    // mc's second question: "Delete 1 file?" was answered about a NAME, and the
    // name did not say the directory behind it holds a hundred of them.
    const running = fileops.remove([`${root}/loose.txt`, `${root}/src`]);
    await waitForQuestion();
    assertEquals(fileops.frontJob()?.question?.kind, "recursive");
    assertEquals(fileops.frontJob()?.question?.dst, `${root}/src`);
    // The plain file went first and is already gone; the tree is waiting.
    assertEquals(await exists(`${root}/loose.txt`), false);
    assertEquals(await exists(`${root}/src`), true);

    await fileops.answerQuestion("overwrite");
    await running;
    assertEquals(await exists(`${root}/src`), false);
    assertEquals(fileops.errors.length, 0);
    assertEquals(fileops.running(), false);
  }));

Deno.test("answering No to the recursion question keeps the tree", () =>
  withApp(async (root) => {
    const running = fileops.remove([`${root}/src`]);
    await waitForQuestion();
    await fileops.answerQuestion("skip");
    await running;
    assertEquals(await exists(`${root}/src/a.txt`), true);
  }));

Deno.test("'None' answers the recursion question for every later tree", () =>
  withApp(async (root) => {
    await Deno.mkdir(`${root}/second/inner`, { recursive: true });
    const running = fileops.remove([`${root}/src`, `${root}/second`]);
    await waitForQuestion();
    await fileops.answerQuestion("skipAll");
    await running;
    assertEquals(await exists(`${root}/src/a.txt`), true);
    assertEquals(await exists(`${root}/second/inner`), true);
    assertEquals(question(), null);
  }));

Deno.test("an empty directory is deleted without a second question", () =>
  withApp(async (root) => {
    await Deno.mkdir(`${root}/hollow`);
    await fileops.remove([`${root}/hollow`]);
    assertEquals(await exists(`${root}/hollow`), false);
    assertEquals(fileops.errors.length, 0);
  }));

Deno.test("with confirmation off, a tree goes without a word", () =>
  withApp(async (root) => {
    ui.setOption("confirmDelete", false);
    try {
      await fileops.remove([`${root}/src`]);
      assertEquals(await exists(`${root}/src`), false);
    } finally {
      ui.setOption("confirmDelete", true);
    }
  }));

Deno.test("delete reports what it could not remove instead of failing silently", () =>
  withApp(async (root) => {
    await fileops.remove([`${root}/not-there`]);
    assertEquals(fileops.errors.length, 1);
    assert(ui.status.includes("0 of 1"), `status was: ${ui.status}`);
  }));

Deno.test("an existing destination stops and asks", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/dst/loose.txt`, "OLD");
    const running = fileops.run("copy", [`${root}/loose.txt`], `${root}/dst`);

    await waitForQuestion();
    assertEquals(question(), `${root}/dst/loose.txt`);
    // Nothing was touched while the question stood.
    assertEquals(await Deno.readTextFile(`${root}/dst/loose.txt`), "OLD");

    await fileops.answerQuestion("skip");
    await running;
    assertEquals(await Deno.readTextFile(`${root}/dst/loose.txt`), "OLD");
  }));

Deno.test("answering overwrite replaces the destination", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/dst/loose.txt`, "OLD");
    const running = fileops.run("copy", [`${root}/loose.txt`], `${root}/dst`);
    await waitForQuestion();
    await fileops.answerQuestion("overwrite");
    await running;
    assertEquals(await Deno.readTextFile(`${root}/dst/loose.txt`), "loose");
  }));

Deno.test("'overwrite all' answers once for every later collision", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/dst/a.txt`, "OLD");
    await Deno.writeTextFile(`${root}/dst/b.txt`, "OLD");
    await Deno.writeTextFile(`${root}/b.txt`, "new-b");

    const running = fileops.run(
      "copy",
      [`${root}/src/a.txt`, `${root}/b.txt`],
      `${root}/dst`,
    );
    await waitForQuestion();
    await fileops.answerQuestion("overwriteAll");
    await running;

    assertEquals(await Deno.readTextFile(`${root}/dst/a.txt`), "A".repeat(100));
    assertEquals(await Deno.readTextFile(`${root}/dst/b.txt`), "new-b");
    assertEquals(question(), null);
  }));

Deno.test("the question carries both files, because the answers are about them", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/dst/loose.txt`, "OLD");
    const running = fileops.run("copy", [`${root}/loose.txt`], `${root}/dst`);
    await waitForQuestion();
    const q = fileops.frontJob()!.question!;
    assertEquals(q.kind, "overwrite");
    const c = q as Extract<typeof q, { kind: "overwrite" }>;
    assertEquals(c.srcSize, 5); // "loose"
    assertEquals(c.dstSize, 3); // "OLD"
    assert(c.srcTime > 0 && c.dstTime > 0);
    // Append is offered for any file; Reget only when the destination looks
    // like an interrupted copy — shorter than the source, and not empty.
    assertEquals(c.canAppend, true);
    assertEquals(c.canReget, true);
    await fileops.answerQuestion("cancel");
    await running;
  }));

Deno.test("append adds the source to the destination; reget finishes it", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/dst/loose.txt`, "OLD");
    let running = fileops.run("copy", [`${root}/loose.txt`], `${root}/dst`);
    await waitForQuestion();
    await fileops.answerQuestion("append");
    await running;
    assertEquals(await Deno.readTextFile(`${root}/dst/loose.txt`), "OLDloose");

    // Reget resumes: the destination holds the first two bytes of the source,
    // so only the rest is copied — which is the whole point of the button.
    await Deno.writeTextFile(`${root}/dst/a.txt`, "AA");
    running = fileops.run("copy", [`${root}/src/a.txt`], `${root}/dst`);
    await waitForQuestion();
    await fileops.answerQuestion("reget");
    await running;
    assertEquals(await Deno.readTextFile(`${root}/dst/a.txt`), "A".repeat(100));
  }));

Deno.test("'older' overwrites only what this side is newer than", () =>
  withApp(async (root) => {
    // Two collisions: one destination older than its source, one newer.
    const old = new Date(Date.now() - 60_000);
    await Deno.writeTextFile(`${root}/dst/a.txt`, "OLD");
    await Deno.utime(`${root}/dst/a.txt`, old, old);
    await Deno.writeTextFile(`${root}/b.txt`, "new-b");
    await Deno.utime(`${root}/b.txt`, old, old);
    await Deno.writeTextFile(`${root}/dst/b.txt`, "NEWER");

    const running = fileops.run(
      "copy",
      [`${root}/src/a.txt`, `${root}/b.txt`],
      `${root}/dst`,
    );
    await waitForQuestion();
    await fileops.answerQuestion("older");
    await running;

    assertEquals(await Deno.readTextFile(`${root}/dst/a.txt`), "A".repeat(100));
    assertEquals(await Deno.readTextFile(`${root}/dst/b.txt`), "NEWER");
  }));

Deno.test("'size differs' skips the ones that match, byte count only", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/dst/a.txt`, "X".repeat(100)); // same size
    await Deno.writeTextFile(`${root}/b.txt`, "new-b");
    await Deno.writeTextFile(`${root}/dst/b.txt`, "different length");

    const running = fileops.run(
      "copy",
      [`${root}/src/a.txt`, `${root}/b.txt`],
      `${root}/dst`,
    );
    await waitForQuestion();
    await fileops.answerQuestion("sizeDiffers");
    await running;

    assertEquals(await Deno.readTextFile(`${root}/dst/a.txt`), "X".repeat(100));
    assertEquals(await Deno.readTextFile(`${root}/dst/b.txt`), "new-b");
  }));

Deno.test("'smaller' overwrites only where the source is bigger", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/dst/a.txt`, "tiny"); // source is bigger
    await Deno.writeTextFile(`${root}/b.txt`, "b");
    await Deno.writeTextFile(
      `${root}/dst/b.txt`,
      "much longer than the source",
    );

    const running = fileops.run(
      "copy",
      [`${root}/src/a.txt`, `${root}/b.txt`],
      `${root}/dst`,
    );
    await waitForQuestion();
    await fileops.answerQuestion("smaller");
    await running;

    assertEquals(await Deno.readTextFile(`${root}/dst/a.txt`), "A".repeat(100));
    assertEquals(
      await Deno.readTextFile(`${root}/dst/b.txt`),
      "much longer than the source",
    );
  }));

Deno.test("the zero-length guard qualifies every policy", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/empty.txt`, "");
    await Deno.writeTextFile(`${root}/dst/empty.txt`, "REAL CONTENT");

    const running = fileops.run("copy", [`${root}/empty.txt`], `${root}/dst`);
    await waitForQuestion();
    fileops.setZeroGuard(true);
    await fileops.answerQuestion("overwriteAll");
    await running;

    // "All" said yes; the guard said not with nothing, and the guard wins.
    assertEquals(
      await Deno.readTextFile(`${root}/dst/empty.txt`),
      "REAL CONTENT",
    );
  }));

Deno.test("'skip all' leaves every colliding destination untouched", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/dst/a.txt`, "OLD-A");
    await Deno.writeTextFile(`${root}/dst/b.txt`, "OLD-B");
    await Deno.writeTextFile(`${root}/b.txt`, "new-b");

    const running = fileops.run(
      "copy",
      [`${root}/src/a.txt`, `${root}/b.txt`],
      `${root}/dst`,
    );
    await waitForQuestion();
    await fileops.answerQuestion("skipAll");
    await running;

    assertEquals(await Deno.readTextFile(`${root}/dst/a.txt`), "OLD-A");
    assertEquals(await Deno.readTextFile(`${root}/dst/b.txt`), "OLD-B");
  }));

Deno.test("one file to a name that is not a directory is a rename", () =>
  withApp(async (root) => {
    // mc's destination box: type a filename and the file is copied AS it.
    // Treating it as a directory produced `backup.txt/loose.txt`, which is
    // nobody's intent.
    await fileops.run("copy", [`${root}/loose.txt`], `${root}/dst/backup.txt`);
    assertEquals(await Deno.readTextFile(`${root}/dst/backup.txt`), "loose");
    assertEquals(await exists(`${root}/dst/backup.txt/loose.txt`), false);

    // …and an existing directory still means "put it in there".
    await fileops.run("copy", [`${root}/loose.txt`], `${root}/dst`);
    assertEquals(await Deno.readTextFile(`${root}/dst/loose.txt`), "loose");
  }));

Deno.test("one directory plus a name that does not exist lands AS that name", () =>
  withApp(async (root) => {
    // mc's rule, in its own words (file.c, copy_dir_dir): "say /bla exists, if
    // we copy /tmp/* to /bla, we get /bla/tmp/*; or ( /bla doesn't exist )
    // /tmp/* to /bla -> /bla/*". It is what makes F6 on a directory with a new
    // path typed in a rename rather than a nesting.
    await fileops.run("copy", [`${root}/src`], `${root}/dst/copy`);
    assertEquals(
      await Deno.readTextFile(`${root}/dst/copy/a.txt`),
      "A".repeat(100),
    );
    assertEquals(await exists(`${root}/dst/copy/src`), false);

    // An EXISTING destination directory keeps the other half of that rule.
    await Deno.mkdir(`${root}/dst/into`);
    await fileops.run("copy", [`${root}/src`], `${root}/dst/into`);
    assertEquals(
      await Deno.readTextFile(`${root}/dst/into/src/a.txt`),
      "A".repeat(100),
    );
  }));

Deno.test("moving one directory to a new name renames it", () =>
  withApp(async (root) => {
    await fileops.run("move", [`${root}/src`], `${root}/renamed`);
    assertEquals(
      await Deno.readTextFile(`${root}/renamed/a.txt`),
      "A".repeat(100),
    );
    assertEquals(await exists(`${root}/src`), false);
    assertEquals(await exists(`${root}/renamed/src`), false);
  }));

Deno.test("an empty selection is refused, loudly", () =>
  withApp(async () => {
    await fileops.run("copy", [], "/tmp");
    assertEquals(fileops.running(), false);
    assert(ui.status.includes("Nothing selected"), `status was: ${ui.status}`);
  }));

Deno.test("the cell returns to idle after an operation", () =>
  withApp(async (root) => {
    await fileops.run("copy", [`${root}/src`], `${root}/dst`);
    assertEquals(fileops.running(), false);
    assertEquals(question(), null);
    assertEquals(fileops.frontJob(), null);
  }));

Deno.test("an operation consumes the selection, so the next one cannot inherit it", () =>
  withApp(async (root) => {
    // The trap this pins down: mark two files, act on them, then put the
    // cursor on a third and act again. `selection()` prefers marks over the
    // cursor, so marks left behind would send the second operation at the
    // first operation's files while the user watches the cursor.
    await panels.chdir("left", root);
    panels.toggleMark("loose.txt");
    assertEquals(panels.left.markedCount, 1);

    ui.confirm("delete", "Delete", "Delete loose.txt?", "Delete");
    await submit();

    assertEquals(await exists(`${root}/loose.txt`), false);
    assertEquals(panels.left.markedCount, 0);
  }));

Deno.test("two operations run at once, and each is cancellable on its own", () =>
  withApp(async (root) => {
    await Deno.mkdir(`${root}/dst2`);
    // Both copies target the same existing name, so both park on a question —
    // which is the only way to hold two jobs still long enough to look at them.
    await Deno.writeTextFile(`${root}/dst/loose.txt`, "old");
    await Deno.writeTextFile(`${root}/dst2/loose.txt`, "old");

    const a = fileops.run("copy", [`${root}/loose.txt`], `${root}/dst`);
    await waitForQuestion();
    const first = fileops.frontJob()!.id;

    // The second starts while the first is still waiting: one slot could not
    // have held both.
    const b = fileops.run("copy", [`${root}/loose.txt`], `${root}/dst2`);
    for (let i = 0; i < 600 && fileops.jobs.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assertEquals(fileops.jobs.length, 2);

    // Answer the first by id; the second is untouched by it.
    await fileops.answerQuestion("overwrite", first);
    await a;
    assertEquals(await Deno.readTextFile(`${root}/dst/loose.txt`), "loose");

    // …and cancel the other, which leaves its destination as it was.
    const second = fileops.jobs[0]?.id;
    if (second) await fileops.cancel(second);
    await fileops.answerQuestion("cancel", second);
    await b;
    assertEquals(await Deno.readTextFile(`${root}/dst2/loose.txt`), "old");
    assertEquals(fileops.jobs.length, 0);
  }));

Deno.test("backgrounding leaves the work running and takes only the dialog", () =>
  withApp(async (root) => {
    await Deno.writeTextFile(`${root}/dst/loose.txt`, "old");
    const op = fileops.run("copy", [`${root}/loose.txt`], `${root}/dst`);
    await waitForQuestion();

    await fileops.background();
    // A job holding a question comes back to the front by itself: an operation
    // waiting on an answer nobody can see would be stranded for ever.
    assertEquals(fileops.frontJob()?.question?.dst, `${root}/dst/loose.txt`);
    assertEquals(fileops.jobs.length, 1);

    await fileops.answerQuestion("skip");
    await op;
    assertEquals(await Deno.readTextFile(`${root}/dst/loose.txt`), "old");
  }));
