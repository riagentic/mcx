/** The function-key row. Clickable, because a modern app should not require
 *  knowing that F5 copies — and labelled, because an mc user should not have to
 *  look. */

import type { Command } from "../lib/keys.ts";
import { run } from "./commands.ts";

const KEYS: ReadonlyArray<[string, string, Command]> = [
  ["1", "Help", "help"],
  ["2", "Menu", "menu.user"],
  ["3", "View", "file.view"],
  ["4", "Edit", "file.edit"],
  ["5", "Copy", "file.copy"],
  ["6", "Move", "file.move"],
  ["7", "Mkdir", "file.mkdir"],
  ["8", "Delete", "file.delete"],
  ["9", "PullDn", "menu.open"],
  ["10", "Quit", "app.quit"],
];

export function ButtonBar() {
  return (
    <nav class="buttonbar">
      {KEYS.map(([n, label, cmd]) => (
        <button
          key={n}
          type="button"
          onClick={() => run(cmd)}
          t={`fkey-${n}`}
        >
          <span class="fk">{n}</span>
          <span class="fl">{label}</span>
        </button>
      ))}
    </nav>
  );
}
