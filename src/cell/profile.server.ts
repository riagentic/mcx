// Server-only: mcx's own profile.
//
// Everything mcx keeps about itself lives under `~/.mcx` — the state database,
// the logs, and the three files a user edits: the menu, the file associations
// and the skins. Nothing is read from `~/.config/mc`.
//
// That is a deliberate line. Reading another program's configuration means
// inheriting its upgrades, its defaults and its bugs, and it means a user who
// changes something in mc finds mcx changed too. mcx understands mc's FILE
// FORMATS, so anyone can copy a menu or a skin across in one command — but the
// copy is theirs, in their own profile, and mcx never reaches outside it.
import { appDirs } from "aio/server";
import { type MenuEntry, parseMenu } from "../lib/mcmenu.ts";
import { DEFAULT_EXT, DEFAULT_MENU, DEFAULT_SKINS } from "../lib/defaults.ts";

/** `~/.mcx` — or wherever `AIO_APPS_DIR` puts it, which is what the test
 *  harness uses to keep its hands off a real profile. */
export const profileDir = (): string => appDirs("mcx").home;

const read = async (path: string): Promise<string | null> => {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
};

/** Write a file only if it is not there.
 *
 *  The whole seeding policy, in one function: mcx writes each default once and
 *  never again. A user who deletes an entry from their menu must not find it
 *  back tomorrow, and a user who has edited a skin must not lose it to an
 *  upgrade. */
async function seed(path: string, contents: string): Promise<void> {
  try {
    await Deno.stat(path);
    return; // theirs now
  } catch { /* not there yet */ }
  try {
    await Deno.writeTextFile(path, contents);
  } catch { /* an unwritable profile is not a reason to fail to start */ }
}

/** Create the profile if this is the first run. Called once, at boot. */
export async function ensureProfile(): Promise<void> {
  const home = profileDir();
  // The directory before the files in it. aio creates `~/.mcx` for its own
  // state before the cells boot, so a missing one only ever showed up on a
  // genuinely fresh profile — which is the one case this function is for.
  try {
    await Deno.mkdir(home, { recursive: true });
  } catch { /* already there */ }
  await seed(`${home}/menu`, DEFAULT_MENU);
  await seed(`${home}/ext.ini`, DEFAULT_EXT);

  // The skins are seeded as a SET, when the directory does not yet exist —
  // not file by file. Seeding each one would restore any skin the user had
  // deleted, every time mcx started: "mcx writes its defaults once" has to
  // mean once for a directory too, or deleting something is not a decision a
  // user is allowed to make.
  try {
    await Deno.stat(`${home}/skins`);
    return;
  } catch { /* first run */ }
  try {
    await Deno.mkdir(`${home}/skins`, { recursive: true });
    for (const [name, text] of Object.entries(DEFAULT_SKINS)) {
      await seed(`${home}/skins/${name}`, text);
    }
  } catch { /* an unwritable profile is not a reason to fail to start */ }
}

/** The user menu: the one beside the files if there is one, else the profile's.
 *
 *  A `.mcx.menu` in a directory is how a project ships its own commands with
 *  it — mc's idea, and a good one. */
export async function userMenu(
  dir: string,
): Promise<{ entries: MenuEntry[]; source: string } | null> {
  for (const path of [`${dir}/.mcx.menu`, `${profileDir()}/menu`]) {
    const text = await read(path);
    if (text === null) continue;
    const entries = parseMenu(text);
    if (entries.length > 0) return { entries, source: path };
  }
  return null;
}

/** The profile file behind a menu entry — mc's "Edit extension file" and
 *  "Edit menu file", which are how those two files are meant to be changed. */
export const profileFile = (which: "ext" | "menu"): string =>
  `${profileDir()}/${which === "ext" ? "ext.ini" : "menu"}`;

/** File associations from `~/.mcx/ext.ini`, in mc's own format.
 *
 *  mc's format is four ways of saying "this section is about that file" and
 *  three of saying what to do with it:
 *
 *      [gzip]
 *      Shell=.gz            an extension (leading dot) or a whole filename
 *      Regex=\.t?gz$        a regular expression over the name
 *      Type=^gzip           a regular expression over `file`'s description
 *      Include=archive      merge in the keys of [Include/archive]
 *      Open=…  View=…  Edit=…
 *
 *  and a `[Default]` section for everything nothing else claimed. Any of the
 *  match keys may carry `/i` for a case-insensitive comparison. */
export type Association = {
  section: string;
  regex: RegExp | null;
  /** `Shell=` — an extension when it starts with a dot, else a whole name. */
  shell: string | null;
  shellFold: boolean;
  /** `Type=` — matched against what `file` says, which costs a subprocess and
   *  is therefore only asked when nothing cheaper matched. */
  type: RegExp | null;
  open: string | null;
  view: string | null;
  edit: string | null;
  /** `[Include/x]` sections are not associations; they are what `Include=x`
   *  pulls in. */
  include: string | null;
  isInclude: boolean;
  isDefault: boolean;
};

const emptyAssoc = (section: string): Association => ({
  section,
  regex: null,
  shell: null,
  shellFold: false,
  type: null,
  open: null,
  view: null,
  edit: null,
  include: null,
  isInclude: section.startsWith("Include/"),
  isDefault: section === "Default",
});

export async function associations(): Promise<Association[]> {
  const text = await read(`${profileDir()}/ext.ini`);
  return text === null ? [] : parseExt(text);
}

/** Split `Key/i` into its name and whether it folds case. */
const keyOf = (raw: string): { key: string; fold: boolean } => {
  const lower = raw.trim().toLowerCase();
  return lower.endsWith("/i")
    ? { key: lower.slice(0, -2), fold: true }
    : { key: lower, fold: false };
};

export function parseExt(text: string): Association[] {
  const out: Association[] = [];
  let cur: Association | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      cur = emptyAssoc(head[1]!);
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const { key, fold } = keyOf(line.slice(0, eq));
    const value = line.slice(eq + 1).trim();
    const re = (pattern: string): RegExp | null => {
      try {
        return new RegExp(pattern, fold ? "i" : "");
      } catch {
        return null; // a pattern this engine cannot read matches nothing
      }
    };
    switch (key) {
      case "regex":
      case "directory":
        cur.regex = re(value);
        break;
      case "type":
        cur.type = re(value);
        break;
      case "shell":
        cur.shell = value;
        cur.shellFold = fold;
        break;
      case "include":
        cur.include = value;
        break;
      case "open":
        cur.open = value;
        break;
      case "view":
        cur.view = value;
        break;
      case "edit":
        cur.edit = value;
        break;
    }
  }
  return out;
}

/** Does this section's match key claim this name? `[Default]` claims nothing —
 *  it is the fallback, chosen by `associationFor` after everything else. */
function claims(a: Association, name: string): boolean {
  if (a.isInclude || a.isDefault) return false;
  if (a.shell !== null) {
    const [n, s] = a.shellFold
      ? [name.toLowerCase(), a.shell.toLowerCase()]
      : [name, a.shell];
    // A leading dot means "this extension"; anything else is the whole name,
    // so `Shell=Makefile` does not also claim `GNUmakefile`.
    return s.startsWith(".") ? n.endsWith(s) : n === s;
  }
  if (a.regex) return a.regex.test(name);
  return false;
}

/** Fold `Include=` into a section: the included keys fill in whatever the
 *  including section did not say itself, which is mc's precedence. */
function resolveInclude(
  a: Association,
  all: readonly Association[],
  depth = 0,
): Association {
  if (!a.include || depth > 8) return a; // depth: an Include cycle is a hang
  const inc = all.find((x) => x.section === `Include/${a.include}`);
  if (!inc) return a;
  const merged: Association = {
    ...a,
    open: a.open ?? inc.open,
    view: a.view ?? inc.view,
    edit: a.edit ?? inc.edit,
    include: inc.include,
  };
  return resolveInclude(merged, all, depth + 1);
}

/** The association for a filename, or null. First match wins, so the specific
 *  sections belong at the top of the file — and `[Default]` is consulted only
 *  when nothing else claimed the name, wherever in the file it sits.
 *
 *  `fileType` is what `file` said about the contents, for sections that match
 *  on `Type=`. It is optional because finding out costs a subprocess: pass it
 *  when the answer is already known, leave it out to skip those sections. */
export function associationFor(
  list: readonly Association[],
  name: string,
  fileType?: string,
): Association | null {
  const usable = (a: Association) => {
    const r = resolveInclude(a, list);
    return r.open || r.view || r.edit ? r : null;
  };
  for (const a of list) {
    if (claims(a, name)) {
      const r = usable(a);
      if (r) return r;
    }
  }
  if (fileType !== undefined) {
    for (const a of list) {
      if (a.isInclude || a.isDefault || !a.type) continue;
      if (a.type.test(fileType)) {
        const r = usable(a);
        if (r) return r;
      }
    }
  }
  const fallback = list.find((a) => a.isDefault);
  return fallback ? usable(fallback) : null;
}

/** The skins in `~/.mcx/skins`. mcx seeds four; anything else in the directory
 *  is the user's, including a file copied over from mc — the format is the
 *  same, which is the point of keeping it. */
export async function skins(): Promise<{ name: string; path: string }[]> {
  const dir = `${profileDir()}/skins`;
  const out: { name: string; path: string }[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".ini")) continue;
      out.push({ name: e.name.slice(0, -4), path: `${dir}/${e.name}` });
    }
  } catch { /* no profile yet */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** One skin, as the CSS variables it sets. */
export async function skinCss(path: string): Promise<Record<string, string>> {
  // Only inside the profile: a skin is a path from a list mcx made, and this is
  // what stops a stale or crafted one naming a file elsewhere on the disk.
  if (!path.startsWith(`${profileDir()}/skins/`)) return {};
  const { skinToCss } = await import("../lib/mcskin.ts");
  const text = await read(path);
  return text === null ? {} : skinToCss(text);
}

/** Where extracted archive members and fetched remote files go: regenerable
 *  bulk, inside the profile, so mcx's whole footprint is one directory and the
 *  VFS list can free it. */
export async function cacheDir(kind: string): Promise<string> {
  const dir = `${appDirs("mcx").cache}/${kind}`;
  await Deno.mkdir(dir, { recursive: true });
  return await Deno.makeTempDir({ dir });
}
