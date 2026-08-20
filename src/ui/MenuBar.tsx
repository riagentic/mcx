/** The pulldown menus (F9). The items themselves live in `menus.ts`, because
 *  the keyboard walks the same table this draws. */

import { ui } from "../cell/ui.ts";
import { run, runFor } from "./commands.ts";
import { chordFor, MENUS } from "./menus.ts";

export function MenuBar() {
  return (
    <nav class="menubar" t="menubar">
      {MENUS.map((m) => (
        <div class="menu" key={m.id}>
          <button
            type="button"
            class={ui.menu === m.id ? "open" : ""}
            t={`menu-${m.id}`}
            onClick={() => ui.openMenu(ui.menu === m.id ? null : m.id)}
          >
            {m.label}
          </button>

          {ui.menu === m.id && (
            <ul class="dropdown">
              {m.items.map((it, i) =>
                it === "separator" ? <li class="sep" key={i} /> : (
                  <li
                    key={it.label}
                    class={i === ui.menuIndex ? "sel" : ""}
                    onMouseEnter={() => ui.setMenuIndex(i)}
                    onClick={() => {
                      ui.openMenu(null);
                      if (m.side) runFor(m.side, it.cmd);
                      else run(it.cmd);
                    }}
                  >
                    <span>{it.label}</span>
                    <em>{chordFor(it.cmd)}</em>
                  </li>
                )
              )}
            </ul>
          )}
        </div>
      ))}

      <div class="menu-spacer" />
      <span class="menu-status">{ui.status}</span>
    </nav>
  );
}
