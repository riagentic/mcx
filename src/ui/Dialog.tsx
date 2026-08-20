/** The one modal. Every mc prompt is one of four shapes, so there is one
 *  component and one keyboard contract: Enter confirms, Esc cancels. */

import { afterRender, useRef } from "aio/air";
import { ui } from "../cell/ui.ts";
import { setOption, submit } from "./commands.ts";

/** What has been typed into the dialog that is open, on the CLIENT.
 *
 *  Not round-tripped per keystroke, and this is the whole point: sending every
 *  character to the server and reading it back is a race that Enter wins.
 *  Typing a path and pressing Enter quickly submitted the value from before the
 *  last few characters — or, on a fast typist, an empty one, which is why
 *  "quick cd does nothing" and "Save as does nothing" looked intermittent.
 *
 *  Keyed by dialog id so a new dialog starts from ITS prefill rather than from
 *  the last one's text. */
let typed: { id: string; value: string } | null = null;

/** The value a submit should act on: what was typed, or the prefill if the
 *  dialog was accepted untouched. */
export function dialogValue(): string {
  const d = ui.dialog;
  if (!d) return "";
  return typed && typed.id === d.id ? typed.value : d.value;
}

/** Forget it — on close, and whenever a different dialog opens. */
export function clearDialogValue(): void {
  typed = null;
}

export function Dialog() {
  const input = useRef<HTMLInputElement | null>(null);

  // Focus the field every time a dialog is on screen — not with `autoFocus`.
  //
  // `autoFocus` applies when an element is INSERTED, and the renderer reuses
  // this one: the second dialog of a session gets the same `<input>` node as
  // the first, so the attribute never fires again and the field opens dead.
  // Everything typed into it went to the key handler instead, which swallows
  // printable keys while a dialog is open — so the dialog looked broken:
  // "Save as does nothing", "F7 does nothing", from the second one onwards.
  //
  // The caret goes to the END, which is what a prefilled destination wants
  // (`Copy … to: /other/panel` + a filename), rather than selecting the text
  // and having the first keystroke wipe it.
  afterRender(() => {
    const el = input.current;
    if (!el || typeof document === "undefined") return;
    if (document.activeElement === el) return;
    el.focus();
    const end = el.value.length;
    try {
      el.setSelectionRange(end, end);
    } catch { /* not a field with a caret */ }
  });

  const d = ui.dialog;
  if (!d) {
    clearDialogValue();
    return null;
  }
  if (typed && typed.id !== d.id) clearDialogValue();

  return (
    <div class="modal-scrim" onClick={() => ui.close()}>
      <div
        class={`modal ${d.danger ? "danger" : ""}`}
        onClick={(e: Event) => e.stopPropagation()}
        t={`dialog-${d.id}`}
      >
        <h2>{d.title}</h2>

        {d.kind === "message" && <pre class="modal-text">{d.label}</pre>}
        {d.kind === "confirm" && <p class="modal-text">{d.label}</p>}

        {d.kind === "prompt" && (
          <label class="modal-field">
            <span>{d.label}</span>
            <input
              t="dialog-input"
              ref={input}
              value={d.value}
              onInput={(e: Event) => {
                typed = {
                  id: d.id,
                  value: (e.target as HTMLInputElement).value,
                };
              }}
            />
          </label>
        )}

        {
          /* A prompt's switches — mc's "Files only", "Case sensitive". They
            answer this dialog only, so they flip in the dialog's own state. */
        }
        {d.kind === "prompt" && d.choices.length > 0 && (
          <ul class="modal-list toggles" t="dialog-choices">
            {d.choices.map((c) => (
              <li
                key={c.id}
                class={c.on ? "on" : ""}
                t={`opt-${c.id}`}
                onClick={() => ui.setDialogChoice(c.id, !c.on)}
              >
                <span>
                  <span class="check">{c.on ? "[×]" : "[ ]"}</span> {c.label}
                </span>
              </li>
            ))}
          </ul>
        )}

        {d.kind === "toggles" && (
          <ul class="modal-list toggles">
            {d.choices.map((c, i) => (
              <li
                key={c.id}
                // Two independent things: whether the switch is ON, and which
                // row the keyboard is on. Space flips the one under the cursor.
                class={`${c.on ? "on" : ""} ${i === d.index ? "sel" : ""}`}
                onMouseEnter={() => ui.moveChoice(i - d.index)}
                onClick={() => setOption(c.id, !c.on)}
              >
                <span>
                  <span class="check">{c.on ? "[×]" : "[ ]"}</span> {c.label}
                </span>
                {c.hint && <em>{c.hint}</em>}
              </li>
            ))}
          </ul>
        )}

        {d.kind === "menu" && (
          <ul class="modal-list">
            {d.choices.map((c, i) => (
              <li
                key={c.id}
                class={i === d.index ? "sel" : ""}
                onClick={() => submit(c.id)}
              >
                <span>{c.label}</span>
                {c.hint && <em>{c.hint}</em>}
              </li>
            ))}
          </ul>
        )}

        <div class="modal-buttons">
          {d.kind !== "message" && (
            <button
              type="button"
              t="dialog-cancel"
              onClick={() => ui.close()}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            class="primary"
            t="dialog-ok"
            onClick={() => submit()}
          >
            {d.ok}
          </button>
        </div>
      </div>
    </div>
  );
}
