/** Root layout. Chrome above, two panels, chrome below — mc's screen, with a
 *  modern skin. Layout and wiring only; every behaviour lives in a cell. */

import { onCleanup, onMount } from "aio/air";
import { panels } from "./cell/panels.ts";
import { ui } from "./cell/ui.ts";
import { shell } from "./cell/shell.ts";
import { ButtonBar } from "./ui/ButtonBar.tsx";
import { FindDialog } from "./ui/FindDialog.tsx";
import { MenuBar } from "./ui/MenuBar.tsx";
import { Shell } from "./ui/Shell.tsx";
import { CommandLine } from "./ui/CommandLine.tsx";
import { Dialog } from "./ui/Dialog.tsx";
import { Panel } from "./ui/Panel.tsx";
import { Progress } from "./ui/Progress.tsx";
import { Viewer } from "./ui/Viewer.tsx";
import { Editor } from "./ui/Editor.tsx";
import { Diff } from "./ui/Diff.tsx";
import { handleKey } from "./ui/keyboard.ts";

export default function App() {
  // The keyboard is the app: it must be attached for as long as the app is on
  // screen. `onCleanup` in a component BODY runs before every re-render, which
  // tore the listener off the moment anything changed and left mcx mouse-only;
  // registered inside `onMount` it runs on unmount alone. On `document`, not
  // `globalThis`, so the listener also exists under `testUI` — both rules are
  // aio's (docs/ui/air-lifecycle.md).
  onMount(() => {
    if (typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => handleKey(e);
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <div
      class="mcx"
      style={{
        // An mc skin's colours, as custom properties on the root of the app.
        // Everything inside — including the fixed-position overlays, which are
        // still descendants — inherits them, so one object repaints the whole
        // program.
        ...ui.skinCss,
        // Only the rows that are actually on screen get a track: hiding the
        // command line must give its height to the panels, not leave a gap.
        "grid-template-rows": [
          ui.showMenubar ? "auto" : "",
          "minmax(0, 1fr)",
          ui.showCmdline ? "auto" : "",
          ui.showKeybar ? "auto" : "",
        ].filter(Boolean).join(" "),
      }}
    >
      {ui.showMenubar && <MenuBar />}

      {ui.shellVisible ? <Shell /> : (
        // The split is one number in one place: the grid gets a track for each
        // panel along whichever axis is in use, and the panels themselves never
        // learn about it.
        <div
          class={`panels ${ui.stacked ? "stacked" : ""}`}
          style={{
            [ui.stacked ? "grid-template-rows" : "grid-template-columns"]:
              `${ui.splitRatio}fr ${1 - ui.splitRatio}fr`,
          }}
        >
          <Panel side="left" />
          <Panel side="right" />
        </div>
      )}

      {ui.showCmdline && <CommandLine />}
      {ui.showKeybar && <ButtonBar />}
      <Dialog />
      <Progress />
      <Viewer />
      <Editor />
      <Diff />
      <FindDialog />
    </div>
  );
}

// Referenced so the module graph pulls these cells into the client bundle even
// before a component reads them.
export { panels, shell };
