// The things only a real browser can answer: does the field have focus, does
// what I typed survive, does the button do what its label says.
//
// Run with `deno task e2e`. Skipped when there is no chromium — this suite is
// not part of `deno task test`, because it needs a browser and thirty seconds.
import { assert, assertEquals } from "@std/assert";
import { type App, haveChromium, startApp } from "./driver.ts";

const skip = haveChromium() === null;

/** One app, one temp directory of fixtures, torn down afterwards. */
async function withApp(
  fn: (app: App, dir: string) => Promise<void>,
): Promise<void> {
  const { app, dir, stop } = await startApp();
  try {
    await Deno.writeTextFile(`${dir}/notes.txt`, "first line\nsecond line\n");
    await Deno.writeTextFile(`${dir}/other.txt`, "other\n");
    // Both panels onto the fixtures, and REFUSE to go on if that failed: a
    // test that types into the wrong directory edits the developer's files.
    await app.key("M-c", 600);
    await app.waitFor(`!!document.querySelector('.modal input')`, "quick cd");
    await app.type(dir);
    await app.key("Enter", 800);
    const path = await app.text(".panel.active .panel-path");
    assert(String(path).includes(dir.split("/").pop()!), `panel is ${path}`);
    await fn(app, dir);
  } finally {
    await stop();
  }
}

Deno.test({
  name: "every dialog gets focus, not just the first one opened",
  ignore: skip,
  fn: () =>
    withApp(async (app) => {
      // The bug: `autoFocus` fires when an element is inserted, and the
      // renderer reuses the input, so the second dialog of a session opened
      // dead. Everything typed went to the key handler, which swallows
      // printable keys while a dialog is up.
      for (const round of [1, 2, 3]) {
        await app.key("F7", 500);
        assertEquals(
          await app.text(".modal h2"),
          "Create directory",
          `round ${round}: no dialog`,
        );
        assertEquals(
          await app.ev(
            `document.activeElement === document.querySelector('.modal input')`,
          ),
          true,
          `round ${round}: the field does not have focus`,
        );
        await app.key("Escape", 400);
      }
    }),
});

Deno.test({
  name: "what is typed into a dialog is what gets used, with no pause",
  ignore: skip,
  fn: () =>
    withApp(async (app, dir) => {
      // The bug: the value was round-tripped per keystroke, so Enter — pressed
      // straight after the last character — submitted the value from before it.
      await app.key("F7", 500);
      await app.type("made-by-e2e", 5);
      await app.key("Enter", 1000);
      assert(
        (await Deno.stat(`${dir}/made-by-e2e`)).isDirectory,
        "the directory that was typed was not created",
      );
    }),
});

Deno.test({
  name: "the command line keeps every character when typed at speed",
  ignore: skip,
  fn: () =>
    withApp(async (app, dir) => {
      // The bug: the field rendered from round-tripped state, and the panels
      // re-render constantly while metadata arrives — so a re-render mid-word
      // rewrote the field with a stale value and characters vanished.
      await app.ev(`document.querySelector('.cmdline input').focus()`);
      await app.type("touch typed-at-speed.txt", 5);
      assertEquals(
        await app.ev(`document.querySelector('.cmdline input').value`),
        "touch typed-at-speed.txt",
        "characters were lost while typing",
      );
      await app.key("Enter", 1200);
      assert(
        (await Deno.stat(`${dir}/typed-at-speed.txt`)).isFile,
        "the command did not run in full",
      );
      // …and the line is cleared afterwards.
      assertEquals(
        await app.ev(`document.querySelector('.cmdline input').value`),
        "",
        "the command line still shows what already ran",
      );
    }),
});

Deno.test({
  name: "the editor types, saves, and saves what is on screen",
  ignore: skip,
  fn: () =>
    withApp(async (app, dir) => {
      await app.waitFor(
        `[...document.querySelectorAll('.row')].some(r=>r.textContent.includes('notes.txt'))`,
        "the listing",
      );
      await app.ev(
        `(()=>{const r=[...document.querySelectorAll('.row')].find(e=>e.textContent.includes('notes.txt')); r.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`,
      );
      // Wait for the cursor to actually be there: a click is a round trip, and
      // F4 sent before it lands acts on whatever the cursor was on before —
      // which is `..`, and which mcx correctly refuses to edit.
      await app.waitFor(
        `document.querySelector('.panel.active .row.cursor')?.textContent?.includes('notes.txt')`,
        "the cursor to reach notes.txt",
      );
      await app.key("F4", 1200);
      assertEquals(
        await app.text(".ov-title"),
        "notes.txt",
        `cursor=${await app.text(
          ".panel.active .row.cursor",
        )} status=${await app
          .text(".menu-status")}`,
      );

      await app.key("End");
      await app.type(" EDITED", 10);
      await app.key("F2", 1200);
      assertEquals(
        await Deno.readTextFile(`${dir}/notes.txt`),
        "first line EDITED\nsecond line\n",
      );
      // The button says Save; it must save too.
      await app.type("!", 10);
      await app.ev(
        `(()=>{const b=[...document.querySelectorAll('.overlay .buttonbar button')].find(e=>e.textContent.includes('Save')); b.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`,
      );
      await new Promise((r) => setTimeout(r, 1200));
      assert(
        (await Deno.readTextFile(`${dir}/notes.txt`)).includes("!"),
        "clicking Save did not write the file",
      );
      await app.key("Escape", 600);
    }),
});

Deno.test({
  name: "Save as writes the name that was typed",
  ignore: skip,
  fn: () =>
    withApp(async (app, dir) => {
      // The flow that was completely broken: F12 opened a dialog whose field
      // had no focus, so the name went nowhere and Enter saved to the prefill
      // — or, with an empty one, to nothing at all.
      await app.waitFor(
        `[...document.querySelectorAll('.row')].some(r=>r.textContent.includes('notes.txt'))`,
        "the listing",
      );
      await app.ev(
        `(()=>{const r=[...document.querySelectorAll('.row')].find(e=>e.textContent.includes('notes.txt')); r.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`,
      );
      await app.waitFor(
        `document.querySelector('.panel.active .row.cursor')?.textContent?.includes('notes.txt')`,
        "the cursor",
      );
      await app.key("F4", 1200);
      await app.key("End");
      await app.type(" v2", 10);

      await app.key("F12", 600);
      assertEquals(await app.text(".modal h2"), "Save as");
      // Replace the prefilled path with a new name.
      await app.ev(
        `(()=>{const i=document.querySelector('.modal input');
          const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
          set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await app.type(`${dir}/saved-as.txt`, 5);
      await app.key("Enter", 1400);
      assertEquals(
        await Deno.readTextFile(`${dir}/saved-as.txt`),
        "first line v2\nsecond line\n",
      );
      await app.key("Escape", 600);
    }),
});

Deno.test({
  name: "the menus work with the mouse and with the keyboard",
  ignore: skip,
  fn: () =>
    withApp(async (app) => {
      // With the mouse.
      assertEquals(await app.click(".menubar button"), "ok");
      assert(await app.ev(`!!document.querySelector('.dropdown')`), "no menu");
      await app.ev(
        `(()=>{const i=[...document.querySelectorAll('.dropdown li span')].find(e=>e.textContent==='Show hidden files'); i.parentElement.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`,
      );
      await new Promise((r) => setTimeout(r, 600));
      assert(
        !(await app.ev(`!!document.querySelector('.dropdown')`)),
        "the menu stayed open after a choice",
      );

      // With the keyboard.
      await app.key("F9", 400);
      assert(await app.ev(`!!document.querySelector('.dropdown')`), "F9");
      await app.key("ArrowRight");
      await app.key("ArrowDown");
      assertEquals(
        await app.text(".menubar button.open"),
        "File",
        "the arrows do not walk the bar",
      );
      await app.key("Escape", 400);
      assert(
        !(await app.ev(`!!document.querySelector('.dropdown')`)),
        "Esc left the menu open",
      );

      // A menu item that opens a dialog: the field must be usable.
      // Quick cd lives in the File menu, one step right of Left.
      await app.key("F9", 400);
      await app.key("ArrowRight");
      await app.ev(
        `(()=>{const i=[...document.querySelectorAll('.dropdown li span')].find(e=>e.textContent==='Quick cd'); i.parentElement.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`,
      );
      await new Promise((r) => setTimeout(r, 700));
      assertEquals(await app.text(".modal h2"), "Quick cd");
      assertEquals(
        await app.ev(
          `document.activeElement === document.querySelector('.modal input')`,
        ),
        true,
        "a dialog opened from the menu has no focus",
      );
      await app.key("Escape", 400);
    }),
});

Deno.test({
  name: "the function-key bar does what its labels say",
  ignore: skip,
  fn: () =>
    withApp(async (app) => {
      const labels = await app.ev(
        `[...document.querySelectorAll('.mcx > .buttonbar button')].map(b=>b.textContent)`,
      ) as string[];
      assertEquals(labels.length, 10);

      await app.ev(
        `(()=>{const b=[...document.querySelectorAll('.mcx > .buttonbar button')][6]; b.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`,
      );
      await new Promise((r) => setTimeout(r, 700));
      assertEquals(await app.text(".modal h2"), "Create directory");
      assertEquals(
        await app.ev(
          `document.activeElement === document.querySelector('.modal input')`,
        ),
        true,
        "the field of a dialog opened from the key bar has no focus",
      );
      await app.key("Escape", 400);

      await app.ev(
        `(()=>{const b=[...document.querySelectorAll('.mcx > .buttonbar button')][0]; b.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`,
      );
      await new Promise((r) => setTimeout(r, 700));
      assertEquals(await app.text(".modal h2"), "mcx help");
      await app.key("Escape", 400);
    }),
});
