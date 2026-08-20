/** Skin files, translated into this program's colours.
 *
 *  The format is mc's ini of colour pairs, kept because it is a good one and
 *  because a skin written for mc can be dropped into `~/.mcx/skins` unchanged.
 *  mcx reads its own directory only.
 *
 *  A skin is an ini of terminal colour pairs — `selected = white;blue` — and
 *  mcx paints with CSS custom properties. The translation is therefore two
 *  steps: read the pairs, then decide which of them answers each of mcx's
 *  variables. Both are pure, so a skin can be checked without a screen.
 *
 *  Not every mc colour has an equivalent here (mcx has no line-drawing
 *  characters and no shadow), and not every mcx colour is in a skin. What is
 *  missing keeps mcx's own value, which is why loading any skin produces a
 *  usable window rather than a half-painted one. */

/** The 16 names a terminal skin may use, as hex. Chosen to match what a modern
 *  terminal actually shows rather than the 1980s CGA values — a skin that says
 *  `blue` means the blue its author was looking at. */
const NAMED: Record<string, string> = {
  black: "#1c1c1c",
  red: "#c94f4f",
  green: "#5faf5f",
  brown: "#a08040",
  blue: "#3a6ea5",
  magenta: "#a05fa0",
  cyan: "#4f9f9f",
  lightgray: "#c0c0c0",
  gray: "#767676",
  brightred: "#ff6b6b",
  brightgreen: "#7ee787",
  yellow: "#ffd866",
  brightblue: "#6cb6ff",
  brightmagenta: "#d2a8ff",
  brightcyan: "#6cc7f5",
  white: "#ffffff",
  default: "",
};

/** The xterm 256-colour cube, for `color16`…`color255`. The first 16 are the
 *  named ones; 16–231 are a 6×6×6 cube; 232–255 are a grey ramp. */
function xterm256(n: number): string {
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  if (n < 16) return Object.values(NAMED)[n] ?? "";
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(i / 36) % 6]!;
    const g = steps[Math.floor(i / 6) % 6]!;
    const b = steps[i % 6]!;
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  const v = 8 + (n - 232) * 10;
  return `#${hex(v)}${hex(v)}${hex(v)}`;
}

/** One colour word from a skin, as CSS — or "" for "unset", which mc spells as
 *  an empty field and means "leave it alone".
 *
 *  `aliases` are a skin's own names for colours (`[aliases] bgmain = gray22`),
 *  which the 256-colour skins use throughout: without them half of what mc
 *  ships reads as "no colour at all". */
export function skinColor(
  word: string,
  aliases: Record<string, string> = {},
  depth = 0,
): string {
  const w = word.trim().toLowerCase();
  if (w === "" || w === "default") return "";
  // An alias may name another alias (`HeaderFg = MarkedFg`), so this recurses —
  // with a depth limit, because a skin file is user input and `a = b, b = a`
  // must not be a hang.
  if (aliases[w] !== undefined && depth < 8) {
    return skinColor(aliases[w]!, aliases, depth + 1);
  }
  if (NAMED[w] !== undefined) return NAMED[w];
  // `gray0`–`gray23` is the xterm grey ramp by another name.
  const gray = /^gray(\d{1,2})$/.exec(w);
  if (gray && Number(gray[1]) <= 23) return xterm256(232 + Number(gray[1]));
  const c256 = /^color(\d{1,3})$/.exec(w);
  if (c256) return xterm256(Number(c256[1]));
  // mc's rgb000–rgb555 form: three digits of the 6×6×6 cube.
  const rgb = /^rgb([0-5])([0-5])([0-5])$/.exec(w);
  if (rgb) {
    return xterm256(
      16 + Number(rgb[1]) * 36 + Number(rgb[2]) * 6 + Number(rgb[3]),
    );
  }
  if (/^#[0-9a-f]{6}$/.test(w)) return w;
  // `#ffa`, the three-digit form — each digit doubled, as in CSS.
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(w);
  if (short) {
    return `#${short[1]!.repeat(2)}${short[2]!.repeat(2)}${
      short[3]!.repeat(2)
    }`;
  }
  return "";
}

export type SkinPair = { fg: string; bg: string };

/** `[section] key = fg;bg;attrs` → `sections[section][key]`. */
export function parseSkin(text: string): {
  description: string;
  sections: Record<string, Record<string, SkinPair>>;
} {
  const sections: Record<string, Record<string, SkinPair>> = {};
  let description = "";
  let current = "";
  // Aliases are read first: they may be defined after the section that uses
  // them, and a colour that resolves differently depending on line order would
  // be a skin that renders differently for no reason.
  const aliases: Record<string, string> = {};
  {
    let inAliases = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) {
        inAliases = line.toLowerCase() === "[aliases]";
        continue;
      }
      if (!inAliases) continue;
      const eq = line.indexOf("=");
      if (eq > 0) {
        aliases[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1)
          .trim();
      }
    }
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      current = head[1]!.toLowerCase();
      sections[current] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (current === "skin" && key === "description") {
      description = value;
      continue;
    }
    if (current === "skin") continue;
    const [fg = "", bg = ""] = value.split(";");
    sections[current] ??= {};
    sections[current]![key] = {
      fg: skinColor(fg, aliases),
      bg: skinColor(bg, aliases),
    };
  }
  return { description, sections };
}

/** The CSS custom properties a skin sets. Only the ones it actually names:
 *  everything else keeps mcx's own value, so a sparse skin is not a broken
 *  one. */
export function skinToCss(text: string): Record<string, string> {
  const { sections } = parseSkin(text);
  const at = (section: string, key: string): SkinPair | undefined =>
    sections[section]?.[key];

  const out: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value) out[name] = value;
  };

  const core = at("core", "_default_");
  set("--fg", core?.fg);
  set("--bg-panel", core?.bg);
  set("--bg", core?.bg);
  set("--bg-head", at("core", "header")?.bg ?? core?.bg);
  set("--fg-head", at("core", "header")?.fg);

  const selected = at("core", "selected");
  set("--sel-fg", selected?.fg);
  set("--sel-bg", selected?.bg);

  set("--mark", at("core", "marked")?.fg);
  set("--fg-dim", at("core", "disabled")?.fg ?? at("core", "shadow")?.fg);
  set("--border", at("core", "frame")?.fg);
  set("--accent", at("core", "reverse")?.fg ?? at("dialog", "dfocus")?.fg);
  set("--bg-chrome", at("menu", "_default_")?.bg);

  // The file-type colours, which are the ones a user actually recognises a
  // skin by.
  const fh = (key: string) => at("filehighlight", key)?.fg;
  set("--k-dir", fh("directory"));
  set("--k-exec", fh("executable"));
  set("--k-link", fh("symlink"));
  set("--k-broken", fh("stalelink"));
  set("--k-special", fh("device") ?? fh("special"));
  set("--danger", at("error", "_default_")?.fg ?? fh("core"));

  return out;
}
