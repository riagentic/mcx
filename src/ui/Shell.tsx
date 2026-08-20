/** The command output view (C-o). mc hides the panels to show the subshell;
 *  mcx shows the scrollback of what it ran, which is the part people actually
 *  wanted to see. */

import { afterRender, useRef } from "aio/air";
import { shell } from "../cell/shell.ts";
import { ui } from "../cell/ui.ts";

export function Shell() {
  const box = useRef<HTMLDivElement | null>(null);

  // Follow the tail while output is arriving — a log that scrolls away from
  // you is worse than no log.
  afterRender(() => {
    const el = box.current;
    if (el && shell.running) el.scrollTop = el.scrollHeight;
  });

  return (
    <section class="shellview" t="shell">
      <header class="panel-path">
        {shell.running ? `running: ${shell.command}` : "command output"}
      </header>

      <div class="shell-out" ref={box}>
        {shell.lines.length === 0
          ? (
            <div class="shell-empty">
              Nothing has been run yet. Type a command below.
            </div>
          )
          : shell.lines.map((l, i) => (
            <div class={`shell-line ${l.err ? "err" : ""}`} key={i}>
              {l.text || " "}
            </div>
          ))}
      </div>

      <footer class="shell-foot">
        {shell.running
          ? (
            <button type="button" t="shell-stop" onClick={() => shell.stop()}>
              Stop
            </button>
          )
          : (
            <>
              <span class="shell-exit">
                {shell.exitCode === null ? "" : `exit ${shell.exitCode}`}
              </span>
              <button
                type="button"
                t="shell-clear"
                onClick={() => shell.clear()}
              >
                Clear
              </button>
            </>
          )}
        <button type="button" t="shell-hide" onClick={() => ui.toggleShell()}>
          Panels (C-o)
        </button>
      </footer>
    </section>
  );
}
