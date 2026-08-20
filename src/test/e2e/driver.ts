// A small CDP driver: start the app, drive a real browser, assert on the DOM.
//
// The cell tests boot the same cells the app does, which catches everything
// except the half that only exists in a browser — focus, event order, and the
// gap between "the state says X" and "the field on screen says X". Three
// user-visible bugs in one session lived exactly there:
//
//   · a dialog's field was only focused the first time a dialog opened, so
//     everything typed into the second one went nowhere;
//   · the typed value was round-tripped through the server, so Enter submitted
//     the text from a few keystrokes ago, or nothing;
//   · the command line rendered from that round trip, so typing at speed lost
//     characters.
//
// None of them is visible to a cell test. All three are obvious here.

/** Whether this machine can run the suite at all. */
export function haveChromium(): string | null {
  for (const bin of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const p = new Deno.Command("which", { args: [bin], stdout: "piped" });
      const r = p.outputSync();
      if (r.success) return new TextDecoder().decode(r.stdout).trim();
    } catch { /* try the next */ }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Virtual key codes. The ones that matter are the punctuation: `.` is 190,
 *  and its character code (46) is Delete — sending that types nothing and
 *  deletes instead, which cost an hour once. */
const VKEY: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  Insert: 45,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Space: 32,
  ".": 190,
  ",": 188,
  "/": 191,
  "-": 189,
  "_": 189,
  ";": 186,
  "=": 187,
};
for (let i = 1; i <= 12; i++) VKEY[`F${i}`] = 111 + i;

const CODE: Record<string, string> = {
  ".": "Period",
  ",": "Comma",
  "/": "Slash",
  "-": "Minus",
  "_": "Minus",
  " ": "Space",
  "\\": "Backslash",
  "?": "Slash",
  "!": "Digit1",
  "*": "Digit8",
  "+": "Equal",
  "=": "Equal",
};

export type App = {
  /** Evaluate an expression in the page. */
  ev: (expr: string) => Promise<unknown>;
  /** A chord: `F5`, `C-o`, `M-c`, `S-F6`, or a single character. */
  key: (spec: string, wait?: number) => Promise<void>;
  /** Type text one real keystroke at a time. `gap` in ms — small is the point. */
  type: (text: string, gap?: number) => Promise<void>;
  /** Click the first element matching a selector, and wait for the round trip. */
  click: (selector: string) => Promise<string>;
  /** Wait until an expression is truthy, or throw. */
  waitFor: (expr: string, what: string) => Promise<void>;
  text: (selector: string) => Promise<string | null>;
  /** Save a PNG of the window. Used by `deno task shot` for the README. */
  screenshot: (path: string) => Promise<void>;
  close: () => Promise<void>;
};

/** Where the app under test runs and what it calls home — the screenshot needs
 *  both pointed at prepared directories, so nothing of the developer's own
 *  shows up in a published image. */
export type StartOpts = { cwd?: string; home?: string };

/** Start mcx and a browser pointed at it. The profile is redirected into a
 *  temp directory, so a test can never touch the developer's real one. */
export async function startApp(opts: StartOpts = {}): Promise<
  { app: App; dir: string; stop: () => Promise<void> }
> {
  const bin = haveChromium();
  if (!bin) throw new Error("no chromium");

  const profile = await Deno.makeTempDir({ prefix: "mcx-e2e-profile-" });
  const dir = await Deno.makeTempDir({ prefix: "mcx-e2e-" });

  const server = new Deno.Command(Deno.execPath(), {
    // Absolute: `cwd` may be somewhere else entirely (the screenshot runs the
    // app inside the tree it is photographing).
    args: [
      "run",
      "-A",
      new URL("../../app.ts", import.meta.url).pathname,
      "--client=browser",
      "--port=0",
    ],
    env: {
      ...Deno.env.toObject(),
      AIO_APPS_DIR: profile,
      ...(opts.home ? { HOME: opts.home } : {}),
    },
    cwd: opts.cwd ?? new URL("../../..", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // The port comes out of the log line the server prints.
  let port = "";
  const dec = new TextDecoder();
  const reader = server.stdout.getReader();
  const deadline = Date.now() + 30_000;
  let buffer = "";
  while (!port && Date.now() < deadline) {
    const r = await reader.read();
    if (r.done) break;
    buffer += dec.decode(r.value);
    port = /localhost:(\d+)/.exec(buffer)?.[1] ?? "";
  }
  reader.releaseLock();
  if (!port) throw new Error("the app did not report a port");

  const debugPort = 9500 + Math.floor(Number(port) % 400);
  const chrome = new Deno.Command(bin, {
    args: [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--remote-debugging-port=${debugPort}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();

  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`))
        .json();
      target = list.find((t: { type: string }) => t.type === "page");
    } catch { /* not up yet */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("no browser target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m.result);
      pending.delete(m.id);
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const n = ++id;
    ws.send(JSON.stringify({ id: n, method, params }));
    return new Promise<Record<string, unknown>>((r) => pending.set(n, r));
  };

  const ev = async (expr: string): Promise<unknown> => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    }) as { exceptionDetails?: unknown; result?: { value?: unknown } };
    if (r.exceptionDetails) {
      throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails)}`);
    }
    return r.result?.value;
  };

  const key = async (spec: string, wait = 220) => {
    let ctrl = false, alt = false, shift = false, k = spec;
    for (;;) {
      if (k.startsWith("C-")) {
        ctrl = true;
        k = k.slice(2);
        continue;
      }
      if (k.startsWith("M-")) {
        alt = true;
        k = k.slice(2);
        continue;
      }
      if (k.startsWith("S-")) {
        shift = true;
        k = k.slice(2);
        continue;
      }
      break;
    }
    // Ctrl+X, Ctrl+PageUp and Ctrl+PageDown are taken by the browser itself
    // (cut, and switching tabs): they never reach the page as key events, so
    // they are synthesised.
    if (ctrl && (k === "x" || k === "PageUp" || k === "PageDown")) {
      await ev(
        `document.dispatchEvent(new KeyboardEvent('keydown',{key:${
          JSON.stringify(k)
        },ctrlKey:true,bubbles:true,cancelable:true}))`,
      );
      await sleep(wait);
      return;
    }
    const isChar = k.length === 1;
    if (isChar && /[A-Z]/.test(k)) shift = true;
    const code = CODE[k] ??
      (isChar ? (/[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : `Digit${k}`) : k);
    const vk = VKEY[k] ?? (isChar ? k.toUpperCase().charCodeAt(0) : 0);
    const base = {
      key: k,
      code,
      modifiers: (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0),
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    };
    const typing = isChar && !ctrl && !alt;
    await send("Input.dispatchKeyEvent", {
      type: typing ? "keyDown" : "rawKeyDown",
      ...base,
      text: typing ? k : "",
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(wait);
  };

  const app: App = {
    ev,
    key,
    type: async (text, gap = 10) => {
      for (const ch of text) await key(ch, gap);
    },
    click: async (selector) => {
      const r = await ev(
        `(()=>{const e=document.querySelector(${
          JSON.stringify(selector)
        }); if(!e) return 'missing'; e.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 'ok';})()`,
      ) as string;
      await sleep(500); // a click is a round trip, exactly like a keystroke
      return r;
    },
    waitFor: async (expr, what) => {
      for (let i = 0; i < 100; i++) {
        if (await ev(expr)) return;
        await sleep(150);
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    text: async (selector) =>
      await ev(
        `document.querySelector(${
          JSON.stringify(selector)
        })?.textContent ?? null`,
      ) as string | null,
    screenshot: async (path: string) => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      await Deno.writeFile(
        path,
        Uint8Array.from(atob(r.data as string), (c) => c.charCodeAt(0)),
      );
    },
    close: async () => {},
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: `http://localhost:${port}` });
  await app.waitFor(
    `!!document.querySelector('.panel .row')`,
    "the app to start",
  );
  await sleep(400);

  const stop = async () => {
    try {
      ws.close();
    } catch { /* already closed */ }
    try {
      chrome.kill();
      await chrome.status;
    } catch { /* already gone */ }
    try {
      server.kill();
      await server.status;
    } catch { /* already gone */ }
    await Deno.remove(profile, { recursive: true }).catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  };

  return { app, dir, stop };
}
