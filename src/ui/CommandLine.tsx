/** The shell command line under the panels — mc's, including the prompt shape. */

import { signal } from "aio/air";
import { panels } from "../cell/panels.ts";
import { ui } from "../cell/ui.ts";
import { tildify } from "../lib/path.ts";

/** What is on the command line right now, on the CLIENT.
 *
 *  The line is not round-tripped per keystroke, and it renders from here rather
 *  than from the cell. Both halves of that matter, and each fixed a real bug:
 *
 *  - Rendering from the cell meant every re-render rewrote the field with
 *    whatever the last round trip had delivered. The panels re-render
 *    constantly while a directory's metadata arrives, so typing at speed lost
 *    characters — `touch notes.txt` arrived as `tuch note.txt`.
 *  - Reading the cell on Enter meant the command that ran was the text from a
 *    few characters ago, or an empty one, which reads as "it just didn't run".
 *
 *  `null` means "nobody has typed since the cell last set this", and the cell's
 *  value is then the truth — which is how `M-Enter` inserting a filename, and
 *  clearing the line after a command, still show up.
 *
 *  A SIGNAL, not a plain variable: clearing it has to repaint the field. As a
 *  variable it did not, and the line kept showing a command that had already
 *  run. */
const live = signal<string | null>(null);

/** The text Enter should run, and the text the field shows. */
export const commandLineText = (): string => live.value ?? ui.cmdline;

/** Hand control back to the cell — after the line has been run, or replaced. */
export function clearCommandLine(): void {
  live.set(null);
}

export function CommandLine() {
  const p = panels.activePanel();
  return (
    <div class="cmdline">
      {
        /* Shortened the way the panel title is, and for the same reason: a
          prompt that is 90 characters of absolute path leaves no room for the
          command. */
      }
      <span class="prompt">{tildify(p.path, ui.home)}$</span>
      <input
        t="cmdline"
        value={commandLineText()}
        spellcheck={false}
        autoComplete="off"
        onInput={(e: Event) => {
          live.set((e.target as HTMLInputElement).value);
        }}
        // No key handler: Enter belongs to the keymap, which runs the command
        // line when it has text and enters the directory when it does not (mc's
        // rule). A handler here as well ran the command AND entered the
        // directory.
      />
    </div>
  );
}
