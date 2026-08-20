# mcx - Midnight Commander X (Enhanced version of Midnight commander written in the aio framework)

## General

- mcx is an improved clone of Midnight Commander, written in the aio framework
  (`dep/aio`)
- performance-critical, CPU-bound work — listing sort, glob matching, content
  search, line indexing — runs in Rust compiled to wasm (`rust/mcx-core` →
  `src/wasm/mcx_core.wasm`); syscalls stay in Deno, which owns the filesystem
- the app follows the aio approaches its own docs prescribe: one cell per
  domain, server-only code behind `*.server.ts`, nothing larger than the visible
  window crossing the wire — `deno task doctor` and `deno task lint` report no
  errors
- mcx is an aio electron app: `deno.json` declares `client: "electron"` and
  `build.targets: ["electron"]`, and `deno task dev` opens a window that renders
  the panels

## Functionality

- mcx reproduces mc's functionality and key bindings — panels, F1-F10, marking,
  file operations, viewer, editor, find file, archive browsing — with a modern
  UI; every binding lives in `src/lib/keys.ts`
- gaps against mc are named in README.md rather than left to be discovered

## Performance

- a directory of 100 000 entries is on screen no slower than `ls -la` on the
  same directory (`deno task bench` prints both; mc itself is measured when it
  is installed)
- cursor movement, paging, sorting and filtering never touch the disk and stay
  under 25ms at 100 000 entries
- the client receives a window bounded by the viewport, never the whole listing
  — enforced by `visible: { exclude: [...] }` in `src/cell/panels.ts` and
  asserted in `src/test/cell/panels.test.ts`

## Configuration

- mcx has its OWN profile in `~/.mcx` — menu, file associations, skins, state,
  cache and logs — and reads nothing from `~/.config/mc` or any other mc
  directory; the defaults are compiled in and written once on first run
- the file FORMATS are mc's (menu, `ext.ini`, skins), so anything can be copied
  across, but the copy lives in the user's mcx profile

## Improvements

- the viewer opens a file of any size without reading it whole, in text and hex,
  with search
- the editor has syntax highlighting, undo/redo, block operations, search and
  replace, and saves atomically
