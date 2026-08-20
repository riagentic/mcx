/** Minimal syntax highlighting: enough to read code by, cheap enough to run on
 *  every visible line of every render. Pure — no aio, no DOM.
 *
 *  Deliberately a lexer for ONE line at a time. Real block comments and
 *  multi-line strings need parser state the panel does not have; the trade is
 *  a rare mis-colour against never blocking a render, and reading is what this
 *  is for. */

export type TokenKind =
  | "text"
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "type";
export type Token = { kind: TokenKind; text: string };

type Lang = {
  keywords: Set<string>;
  types?: Set<string>;
  line: string[];
  strings: string[];
};

const set = (s: string) => new Set(s.split(" "));

const C_LIKE: Lang = {
  keywords: set(
    "if else for while do switch case break continue return function const let var class new " +
      "import export from as async await try catch finally throw typeof instanceof extends " +
      "implements interface type enum struct impl fn pub use mod match loop where self static " +
      "public private protected void null undefined true false this super yield in of default",
  ),
  types: set(
    "string number boolean object bigint symbol never unknown any i32 i64 u8 u32 usize f64 bool str String Vec Option Result",
  ),
  line: ["//", "#"],
  strings: ['"', "'", "`"],
};

const SHELL: Lang = {
  keywords: set(
    "if then else elif fi for while until do done case esac function return export local " +
      "readonly declare typeset set unset shift echo printf cd exit source trap eval exec test in",
  ),
  line: ["#"],
  strings: ['"', "'"],
};

/** Python is not shell, and colouring it as shell was worse than leaving it
 *  plain: `def` and `class` stayed grey while `echo` and `fi` lit up. */
const PYTHON: Lang = {
  keywords: set(
    "def class lambda return yield if elif else for while break continue pass raise try except " +
      "finally with as import from global nonlocal del assert async await in is not and or None " +
      "True False self match case",
  ),
  types: set(
    "int float str bytes bool list dict set tuple frozenset object type Any Optional Union " +
      "Iterable Sequence Mapping Callable",
  ),
  line: ["#"],
  strings: ['"', "'"],
};

const RUBY: Lang = {
  keywords: set(
    "def class module end if elsif else unless while until for do return yield begin rescue " +
      "ensure raise require require_relative attr_accessor attr_reader attr_writer self nil " +
      "true false and or not then case when next break super lambda proc puts",
  ),
  line: ["#"],
  strings: ['"', "'"],
};

const LUA: Lang = {
  keywords: set(
    "and break do else elseif end false for function goto if in local nil not or repeat return " +
      "then true until while self",
  ),
  line: ["--"],
  strings: ['"', "'"],
};

const SQL: Lang = {
  keywords: set(
    "SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX VIEW DROP ALTER " +
      "ADD JOIN LEFT RIGHT INNER OUTER FULL ON GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL AS " +
      "AND OR NOT NULL IS IN LIKE BETWEEN DISTINCT PRIMARY KEY FOREIGN REFERENCES CONSTRAINT " +
      "UNIQUE DEFAULT BEGIN COMMIT ROLLBACK WITH RETURNING " +
      "select from where insert into values update set delete create table index view drop " +
      "alter add join left right inner outer full on group by order having limit offset union " +
      "all as and or not null is in like between distinct with returning",
  ),
  types: set(
    "INTEGER INT BIGINT SMALLINT TEXT VARCHAR CHAR BOOLEAN BOOL REAL DOUBLE DECIMAL NUMERIC " +
      "DATE TIME TIMESTAMP BLOB JSON JSONB SERIAL UUID",
  ),
  line: ["--"],
  strings: ["'", '"'],
};

/** Markup: the tag names are the structure, so they are what gets the colour.
 *  The one-line lexer cannot see a comment that closes three lines down — the
 *  trade this module's header describes. */
const MARKUP: Lang = {
  keywords: set(
    "html head body div span a p ul ol li table tr td th form input button script style link " +
      "meta title header footer nav section article aside main img svg path h1 h2 h3 h4 h5 h6 " +
      "xml DOCTYPE doctype",
  ),
  line: [],
  strings: ['"', "'"],
};

const MARKDOWN: Lang = {
  keywords: set(""),
  line: [],
  strings: ["`"],
};

const MAKE: Lang = {
  keywords: set(
    "ifeq ifneq ifdef ifndef else endif include define endef export unexport override " +
      "vpath PHONY SUFFIXES DEFAULT",
  ),
  line: ["#"],
  strings: ['"', "'"],
};

const CSS: Lang = {
  keywords: set("import media supports keyframes from to important"),
  line: ["//"],
  strings: ['"', "'"],
};

const BY_EXT: Record<string, Lang> = {
  ts: C_LIKE,
  tsx: C_LIKE,
  js: C_LIKE,
  jsx: C_LIKE,
  mjs: C_LIKE,
  cjs: C_LIKE,
  rs: C_LIKE,
  c: C_LIKE,
  h: C_LIKE,
  cpp: C_LIKE,
  hpp: C_LIKE,
  cc: C_LIKE,
  cxx: C_LIKE,
  go: C_LIKE,
  java: C_LIKE,
  kt: C_LIKE,
  swift: C_LIKE,
  cs: C_LIKE,
  php: C_LIKE,
  scala: C_LIKE,
  dart: C_LIKE,
  zig: C_LIKE,
  json: C_LIKE,
  jsonc: C_LIKE,
  py: PYTHON,
  pyi: PYTHON,
  rb: RUBY,
  lua: LUA,
  sql: SQL,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  fish: SHELL,
  ksh: SHELL,
  toml: SHELL,
  ini: SHELL,
  cfg: SHELL,
  conf: SHELL,
  yaml: SHELL,
  yml: SHELL,
  env: SHELL,
  html: MARKUP,
  htm: MARKUP,
  xml: MARKUP,
  xhtml: MARKUP,
  svg: MARKUP,
  vue: MARKUP,
  md: MARKDOWN,
  markdown: MARKDOWN,
  css: CSS,
  scss: CSS,
  less: CSS,
  mk: MAKE,
};

/** Files mc's syntax table matches by NAME rather than by extension — the ones
 *  with no extension at all, which would otherwise read as plain text. */
const BY_NAME: Record<string, Lang> = {
  makefile: MAKE,
  gnumakefile: MAKE,
  "cmakelists.txt": MAKE,
  dockerfile: SHELL,
  pkgbuild: SHELL,
  ".bashrc": SHELL,
  ".zshrc": SHELL,
  ".profile": SHELL,
  ".gitconfig": SHELL,
};

/** The language for a filename, or null when nothing is known about it — in
 *  which case the editor shows plain text rather than guessing. */
export function langOf(filename: string): Lang | null {
  const name = filename.slice(filename.lastIndexOf("/") + 1).toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  // No extension, or a dotfile BY_NAME did not recognise: plain text, which is
  // honest — a guess here colours prose as code.
  if (dot <= 0) return null;
  return BY_EXT[name.slice(dot + 1)] ?? null;
}

const isWordChar = (c: string) => /[A-Za-z0-9_$]/.test(c);

/** Split one line into coloured spans. */
export function tokenize(line: string, lang: Lang | null): Token[] {
  if (!lang || line === "") return [{ kind: "text", text: line }];
  const out: Token[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };

  for (let i = 0; i < line.length;) {
    const rest = line.slice(i);

    const comment = lang.line.find((c) => rest.startsWith(c));
    if (comment) {
      flush();
      out.push({ kind: "comment", text: rest });
      return out;
    }

    const quote = lang.strings.find((q) => rest.startsWith(q));
    if (quote) {
      flush();
      let j = 1;
      while (j < rest.length) {
        if (rest[j] === "\\") j += 2;
        else if (rest[j] === quote) {
          j++;
          break;
        } else j++;
      }
      out.push({ kind: "string", text: rest.slice(0, j) });
      i += j;
      continue;
    }

    const ch = line[i]!;
    if (/[0-9]/.test(ch) && !isWordChar(line[i - 1] ?? " ")) {
      flush();
      const m = rest.match(/^[0-9][0-9_a-fA-FxXbBoO.]*/)![0];
      out.push({ kind: "number", text: m });
      i += m.length;
      continue;
    }

    if (isWordChar(ch) && !isWordChar(line[i - 1] ?? " ")) {
      const word = rest.match(/^[A-Za-z0-9_$]+/)![0];
      if (lang.keywords.has(word)) {
        flush();
        out.push({ kind: "keyword", text: word });
        i += word.length;
        continue;
      }
      if (lang.types?.has(word)) {
        flush();
        out.push({ kind: "type", text: word });
        i += word.length;
        continue;
      }
      buf += word;
      i += word.length;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}
