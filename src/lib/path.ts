/** Pure POSIX path helpers. Browser-safe by construction: no `@std/path`,
 *  which would drag Deno-only code into the client bundle
 *  (docs/build/imports.md). */

export function dirname(p: string): string {
  if (p === "/") return "/";
  const t = p.endsWith("/") ? p.slice(0, -1) : p;
  const i = t.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return t.slice(0, i);
}

export function basename(p: string): string {
  if (p === "/") return "/";
  const t = p.endsWith("/") ? p.slice(0, -1) : p;
  const i = t.lastIndexOf("/");
  return i < 0 ? t : t.slice(i + 1);
}

export function extname(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

export function join(...parts: string[]): string {
  const joined = parts.filter((p) => p.length > 0).join("/");
  return normalize(joined || ".");
}

/** Resolve `.`/`..` and collapse slashes. Never touches the filesystem, so it
 *  works identically in both bundles. */
export function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const body = out.join("/");
  return abs ? "/" + body : body || ".";
}

export function isAbsolute(p: string): boolean {
  return p.startsWith("/");
}

/** Resolve `p` against `base` (both POSIX). `~` expands against `home`. */
export function resolve(base: string, p: string, home = ""): string {
  if (p === "~" || p.startsWith("~/")) {
    return normalize(join(home || "/", p.slice(1)));
  }
  return isAbsolute(p) ? normalize(p) : normalize(join(base, p));
}

/** Where a panel row actually lives.
 *
 *  A row's name is USUALLY relative to the panel's directory — but a panelized
 *  listing (mc's find → panelize) names its rows by absolute path, because a
 *  flat list of forty `index.ts` is useless, and its `path` is a label
 *  (`find:*.ts`) rather than a directory. Joining the two produced
 *  `find:*.ts/home/u/a.txt`, which every file operation then failed on. */
export const entryPath = (dir: string, name: string): string =>
  isAbsolute(name) ? normalize(name) : join(dir, name);

/** The parent, or `null` at the root — the guard for `..` navigation. */
export function parent(p: string): string | null {
  const d = dirname(p);
  return d === p ? null : d;
}

/** `to` written relative to the directory `from` — `/a/b/c` seen from `/a/x`
 *  is `../b/c`. Both must be absolute; the result never begins with a slash,
 *  which is what makes it a relative link target.
 *
 *  Pure string arithmetic on purpose: it must give the same answer on a path
 *  that does not exist yet, which is exactly when a link is being created. */
export function relativeTo(from: string, to: string): string {
  const f = normalize(from).split("/").filter(Boolean);
  const t = normalize(to).split("/").filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const parts = [...f.slice(i).map(() => ".."), ...t.slice(i)];
  return parts.length === 0 ? "." : parts.join("/");
}

/** Shorten a path for a title bar: `/home/u/projects/x` → `~/projects/x`. */
export function tildify(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home + "/"))) {
    return "~" + p.slice(home.length);
  }
  return p;
}
