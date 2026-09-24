/** What has been typed into the dialog that is open, on the CLIENT.
 *
 *  Not round-tripped per keystroke, and this is the whole point: sending every
 *  character to the server and reading it back is a race that Enter wins.
 *  Typing a path and pressing Enter quickly submitted the value from before the
 *  last few characters — or, on a fast typist, an empty one, which is why
 *  "quick cd does nothing" and "Save as does nothing" looked intermittent.
 *
 *  Keyed by dialog id so a new dialog starts from ITS prefill rather than from
 *  the last one's text. Its own module, not `Dialog.tsx`: the commands that
 *  read it are imported BY the dialog, and a value both sides need belongs to
 *  neither. */

import { ui } from "../cell/ui.ts";

let typed: { id: string; value: string } | null = null;

/** The value a submit should act on: what was typed, or the prefill if the
 *  dialog was accepted untouched. */
export function dialogValue(): string {
  const d = ui.dialog;
  if (!d) return "";
  return typed && typed.id === d.id ? typed.value : d.value;
}

/** Record a keystroke's result for dialog `id`. */
export function setDialogValue(id: string, value: string): void {
  typed = { id, value };
}

/** Forget it — on close, and whenever a different dialog opens. */
export function clearDialogValue(): void {
  typed = null;
}

/** Whether what is held belongs to a dialog other than `id`. */
export const heldForOther = (id: string): boolean =>
  typed !== null && typed.id !== id;
