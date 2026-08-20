// Entry — wiring only.
//
// The `.server.ts` imports are not decoration: `deno compile` embeds only what
// it can see statically, and the cells reach these modules through dynamic
// imports that the compiler cannot follow (docs/build/imports.md §3). Without
// these three lines mcx works in dev and dies in the binary.
import "./cell/core.server.ts";
import "./cell/listing.server.ts";
import "./cell/ops.server.ts";
import "./cell/fileops.server.ts";
import "./cell/viewer.server.ts";
import "./cell/editor.server.ts";
import "./cell/shell.server.ts";
import "./cell/find.server.ts";
import "./cell/vfs.server.ts";
import "./cell/tree.server.ts";
import "./cell/diff.server.ts";
import "./cell/profile.server.ts";
import "./cell/remote.server.ts";

import { panels } from "./cell/panels.ts";
import "./cell/ui.ts";
import "./cell/ops.ts";
import "./cell/fileops.ts";
import "./cell/viewer.ts";
import "./cell/editor.ts";
import "./cell/shell.ts";
import "./cell/find.ts";
import "./cell/tree.ts";
import "./cell/diff.ts";
import { aio } from "aio";

await aio.run({
  // Declared HERE, not only in deno.json: a compiled binary never reads
  // deno.json, and an appId that changes between dev and the build moves the
  // data directory with it (docs/basics/pitfalls.md).
  appId: "mcx",
  ui: { width: 1280, height: 800 },
  onStart: () => {
    panels.boot();
  },
});
