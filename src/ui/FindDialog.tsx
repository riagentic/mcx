/** Find file (M-?): the query, the live progress, and the results as a list
 *  you can walk with the same keys as a panel. */

import { find } from "../cell/find.ts";
import { afterRender, useRef, useSignal } from "aio/air";
import { basename, dirname } from "../lib/path.ts";

export function FindDialog() {
  const mask = useSignal(find.mask);
  const content = useSignal(find.content);
  const maskField = useRef<HTMLInputElement | null>(null);

  // Focused here rather than with `autoFocus`, for the reason Dialog.tsx spells
  // out: the attribute fires when the element is inserted, and the second time
  // this dialog opens the renderer reuses the same node. Only the mask, and
  // only when nothing else in the dialog has focus — otherwise Tab could never
  // reach the second field.
  afterRender(() => {
    const el = maskField.current;
    if (!el || typeof document === "undefined" || !find.visible) return;
    const active = document.activeElement;
    if (
      active && active !== document.body && el.ownerDocument.contains(active)
    ) {
      if (active.closest(".modal.find")) return;
    }
    el.focus();
    const end = el.value.length;
    try {
      el.setSelectionRange(end, end);
    } catch { /* not a field with a caret */ }
  });

  if (!find.visible) return null;

  const root = useSignal(find.root);
  const start = () =>
    find.start(root.value || find.root, mask.value, content.value);

  /** mc's switches, in mc's two groups: what to walk and what to match. */
  const SWITCHES: Array<{ id: string; label: string; on: boolean }> = [
    { id: "recursive", label: "Find recursively", on: find.recursive },
    { id: "followSymlinks", label: "Follow symlinks", on: find.followSymlinks },
    { id: "skipHidden", label: "Skip hidden", on: find.skipHidden },
    { id: "nameCase", label: "Case sensitive", on: !find.caseInsensitive },
    {
      id: "contentCase",
      label: "Content case sensitive",
      on: !find.contentCaseInsensitive,
    },
    { id: "wholeWords", label: "Whole words", on: find.wholeWords },
    { id: "firstHit", label: "First hit only", on: find.firstHit },
  ];

  return (
    <div class="modal-scrim" onClick={() => find.hide()}>
      <div
        class="modal find"
        onClick={(e: Event) => e.stopPropagation()}
        t="find"
      >
        <h2>Find file</h2>

        <div class="find-form">
          <label class="modal-field">
            <span>File mask:</span>
            <input
              t="find-mask"
              ref={maskField}
              value={mask.value}
              onInput={(e: Event) =>
                mask.set((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="modal-field">
            <span>Containing text:</span>
            <input
              t="find-content"
              value={content.value}
              onInput={(e: Event) =>
                content.set((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="modal-field">
            <span>Start at:</span>
            <input
              t="find-root"
              value={root.value}
              onInput={(e: Event) =>
                root.set((e.target as HTMLInputElement).value)}
            />
          </label>
        </div>

        <ul class="modal-list toggles find-switches" t="find-switches">
          {SWITCHES.map((sw) => (
            <li
              key={sw.id}
              class={sw.on ? "on" : ""}
              t={`find-opt-${sw.id}`}
              onClick={() => find.setOption(sw.id, !sw.on)}
            >
              <span>
                <span class="check">{sw.on ? "[×]" : "[ ]"}</span> {sw.label}
              </span>
            </li>
          ))}
        </ul>

        {find.running && <div class="find-scan">scanning {find.scanning}</div>}

        <ul class="modal-list find-hits" t="find-hits">
          {find.hits.map((h, i) => (
            <li
              key={`${h.path}:${h.line}`}
              class={i === find.cursor ? "sel" : ""}
              onClick={() => find.setCursor(i)}
              onDblClick={() => find.goto(i)}
            >
              <span>
                <strong>{basename(h.path)}</strong>
                <em class="hit-dir">{dirname(h.path)}</em>
              </span>
              {h.line > 0 && <em>{h.line}: {h.text.trim().slice(0, 60)}</em>}
            </li>
          ))}
        </ul>

        {find.truncated && (
          <div class="find-scan">…more matches were not listed</div>
        )}

        <div class="modal-buttons">
          {find.running
            ? (
              <button type="button" t="find-stop" onClick={() => find.stop()}>
                Stop
              </button>
            )
            : (
              <button type="button" t="find-start" onClick={start}>
                Search
              </button>
            )}
          <button
            type="button"
            t="find-panelize"
            disabled={find.hits.length === 0}
            onClick={() => find.panelize()}
          >
            Panelize
          </button>
          <button type="button" onClick={() => find.hide()}>Close</button>
          <button
            type="button"
            class="primary"
            t="find-goto"
            disabled={find.hits.length === 0}
            onClick={() => find.goto()}
          >
            Go to
          </button>
        </div>
      </div>
    </div>
  );
}
