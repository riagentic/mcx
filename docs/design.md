# How mcx is built

The long-form companion to the [README](../README.md): the design decisions, the
parity ledgers, and what the tests pin down.

## Layout

```
src/
  app.ts             aio.run() — wiring only
  App.tsx            layout
  cell/              state + methods (panels, tree, fileops, viewer, editor, find, shell, ui, ops)
    *.server.ts      Deno-only: filesystem, subprocesses, wasm bindings
  lib/               pure functions — formatting, paths, keymap, text editing, syntax
  type/              shared types
  ui/                components
  test/              mirrors the source
rust/mcx-core/       sort · filter · glob · search · line index  →  src/wasm/mcx_core.wasm
```

Four decisions carry the design:

**The listing never leaves the server.** A panel keeps its full directory in
server-side state (`raw`/`all`) and publishes only the window that fits on
screen (`rows`). Paging through 100 000 files costs the same as paging through
ten, and the `visible: { exclude: [...] }` declaration in `cell/panels.ts` is
what enforces it. The tree panel works the same way.

Two things follow from that which are easy to get wrong. The mark set is
server-side too, so **what a file operation acts on is asked of the server**
(`panels.selection()`, a method) rather than computed in the browser — a
selector would have quietly answered "the file under the cursor" and copied one
file out of the fifty you tagged. And the client keeps `markedCount` and
`markedFirst` precisely so no dialog needs the list to describe itself.

**Two-phase directory loads.** `readdir` alone is ~5× faster than `readdir` plus
one `lstat` per entry, and it already carries what the panel needs to _draw_.
mcx paints from it immediately, then fills in sizes, times and modes in chunks,
walking them in the order they are on screen. A 100 000-entry directory is on
screen in ~120 ms — half what `ls -la` takes on the same directory — with the
metadata arriving while the user is already moving.

**The raw listing is kept.** `raw` is what the disk gave us; `all` is `raw` with
the sort, the mask and the hidden-file policy applied. Because the arrangement
never consumes its own output, `M-.` and the filter box are arithmetic — around
13 ms at 100 000 entries — where they used to cost a second `readdir`.

**Rust for what is actually hot.** Sorting, filtering, glob matching, content
search and line indexing run in wasm over flat buffers, batched so the boundary
is crossed once per operation rather than once per entry — hidden files, mask
and sort are a single `arrange_index` call over one packed copy of the names.
Nothing inside the module allocates: a `Vec` that grows linear memory detaches
every view the host holds, which is a bug that waits for a directory one page
bigger than your last one. `deno task bench` prints the numbers, including the
ones where wasm is only at parity with JS — the benchmark is there to be read,
not to flatter.

## Parity with mc, measured

mc's own `misc/mc.default.keymap` is the specification, and
`src/test/lib/mc-parity.test.ts` parses it and holds this port to it — every
binding mc defines is either reproduced, or named in a ledger with the reason it
is not. The suite prints the count on every run:

| Context      | mc commands | mcx  |
| ------------ | ----------: | ---- |
| File manager |          95 | 100% |
| Editor       |          94 | 100% |
| Diff viewer  |          39 | 100% |
| Viewer       |          36 | 100% |
| Tree         |          17 | 100% |
| Input line   |          24 | 100% |
| Hex mode     |          27 | 100% |
| Dialogs      |          26 | 100% |
| F9 menus     |          70 | 100% |

All fifteen sections of mc's keymap file now have a ledger, and a test says so —
for a while the input line, the modals and hex mode had none, which is how each
of them could be missing and the table still read 100%. The last four are held
the same way as the first five. The input line is mc's `[input]` section:
sixteen of its bindings a browser field already does (arrows, Home/End,
shift-selection), and the other eight — `C-k`, `M-d`, `M-BS`, `C-w`, `M-Tab`
completion, `M-p`/`M-n` history — are supplied by `fieldKey` in
`ui/keyboard.ts`, because in a window they do nothing on their own. Hex mode is
its own keymap because its cursor is a byte rather than a line: `F2` edits,
`Tab` moves between the hex columns and the text, `F6` writes the changed bytes
back in place. The menus are read out of mc's `filemanager.c`, so an entry that
appears upstream shows up here as a failing test rather than as a menu that is
quietly one line shorter; nine of them mcx answers differently, each with its
reason in `src/test/ui/menus.test.ts`.

Three of mc's commands have no counterpart here, and the ledger says so rather
than counting them: `C-z` (suspend) returns mc to the shell that started it, and
a window has no such shell; `C-x` is the extended-keymap prefix, which the
dispatcher implements rather than a command; and the viewer's "magic mode" pipes
a file through an `mc.ext` filter, where mcx browses archives as directories
instead.

## Your profile: `~/.mcx`

Everything mcx keeps is in one directory, and mcx reads nothing outside it — not
`~/.config/mc`, not `/usr/share/mc`. It is its own program with its own profile,
and a change you make to mc does not change mcx behind your back.

```
~/.mcx/
  menu          the F2 user menu          (a .mcx.menu beside files wins)
  ext.ini       what Enter opens, by type
  skins/        four to start with; add your own
  data/         settings, panel state, history, hotlist
  cache/        extracted archive members and fetched remote files
  logs/
```

The first run writes `menu`, `ext.ini` and `skins/` and then never touches them
again — delete an entry and it stays deleted. The formats are mc's,
deliberately: they are good, they are documented, and a menu or a skin can be
copied across in one command. That copy is then yours, in your profile.

`F9 → Options` edits the rest — confirmations, layout, panel behaviour and the
skin — and every setting persists in `data/`.

## Not the same as mc

Everything below is a difference someone will hit. The keymap, the menu and the
input line are each held to mc's own tables by a test (see _Parity with mc_), so
what is listed here is what those tables cannot describe.

- **Remote filesystems** work through `ssh`, `scp` and `curl` rather than an
  in-process implementation: `cd sh://user@host/path` lists, views, edits,
  copies in and out, makes directories and deletes. That is a deliberate choice
  — ssh already knows your keys, your `~/.ssh/config`, your jump hosts and your
  agent, and a second implementation of any of that would be a worse ssh you had
  to configure twice. FTP is read-only.
- **The subshell has no PTY.** `export`, `cd` and shell functions persist from
  one command to the next, exactly as in mc; full-screen programs (`vim`, `top`)
  cannot run inside the window, and `F4`/`F3` are the answer for the first of
  those.
- **Editing a remote file** edits a local copy; `F5` puts it back.
- **`C-s` saves** in the editor. mc puts the syntax-highlighting toggle there;
  it moved to `M-s`, because `C-s` is save in every other editor on the machine.
- **Archives** are `tar` (with its usual compressors) and `zip`. mc reaches
  `7z`, `rar`, `cpio`, `iso9660`, `deb`, `rpm`, `lha`, `arj` and more through
  `extfs` helper scripts; mcx browses the two that account for almost every
  archive anyone opens, and shells out for the rest.
- **Sort orders** are unsorted, name, version, extension, size and modify time.
  mc also sorts by access time, change time and inode — three fields the panel
  does not carry, because carrying them for 100 000 entries costs more than the
  ordering is worth.
- **The listing format** is one of mc's three (brief, full, long). mc's fourth —
  a user-defined format string like `half type name | size | perm` — is not
  implemented.
- **Syntax highlighting** is a one-line lexer over about twenty languages, not
  mc's 109 `Syntax` files with their context rules. A block comment that opens
  on one line and closes on another is coloured line by line.
- **`Advanced chown`** (mc's per-bit chown+chmod grid) is not there; `C-x o` and
  `C-x c` say the same things one at a time.
- **File positions are not remembered.** mc reopens a file in the editor at the
  line you left it on; mcx opens it at the top.
- **External panelize** takes a command; mc also keeps a named list of them,
  with Add and Remove, and can re-show the last panelized listing.
- **The hotlist** is a list of directories that `C-x h` adds and removes. mc's
  has labels, groups and a Move — a small filesystem of its own.
- **`F1` is one page**, the bindings. mc's help is hypertext with an index,
  links and Back; there are no nodes here to walk, which is why mcx's `[help]`
  keymap has nothing to answer.
- **Attributes** (`C-x e`) are typed as a string; mc's `chattr` is a grid.

## Testing

`deno task test` — 337 tests, all against real files: real directories, real
archives, real copies, real saves. Cell tests boot the same cells the app does
(`bootCells`), so a green suite means the wiring works, not just the functions.

Two of them are worth knowing about, because they pin down invariants that are
invisible until they break: `panels.test.ts` proves that filtering and `M-.`
never re-read the directory (by filtering after deleting a file from disk and
watching it stay), and `core.test.ts` sorts a listing large enough to move
wasm's linear memory, which is where a cached `TypedArray` view would detach.

`deno task e2e` is separate, and needs a browser. It exists because three
user-visible bugs in one afternoon lived in the half of the program a cell test
cannot see: a dialog field that was only focused the first time a dialog opened,
a typed value that was round-tripped through the server so Enter submitted the
text from a few keystrokes ago, and a command line that rendered from that round
trip and lost characters when typed at speed. None of them is visible to a test
that boots cells; all of them are obvious to one that drives a browser.

Three more are randomized rather than written by hand, because the interesting
inputs are the ones nobody thinks to type: the wasm sort and the wasm glob are
each checked against a plain-TypeScript oracle over hundreds of generated
listings and thousands of generated patterns, and the editing primitives are
held to their invariants (insert-then-delete is the identity, a search hit is
really there) over 800 random documents. All three are seeded, so a failure
reproduces exactly.
