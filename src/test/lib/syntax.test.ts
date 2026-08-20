// Syntax highlighting — the lexer and the language it picks.
//
// The bug this file exists to prevent is the quiet one: a language mapped to
// the WRONG table still highlights, so the editor looks like it works while
// `def` stays grey and `fi` lights up in a Python file.
import { assertEquals } from "@std/assert";
import { langOf, tokenize } from "../../lib/syntax.ts";

const kinds = (line: string, name: string) =>
  tokenize(line, langOf(name)).filter((t) => t.text.trim() !== "").map((t) =>
    `${t.kind}:${t.text}`
  );

Deno.test("a language is chosen by extension, and by name when there is none", () => {
  // Same word, three languages, three answers.
  assertEquals(kinds("def x", "a.py").includes("keyword:def"), true);
  assertEquals(kinds("def x", "a.rb").includes("keyword:def"), true);
  assertEquals(kinds("def x", "a.ts").includes("keyword:def"), false);

  // Files with no extension at all — mc matches these by name too.
  assertEquals(kinds("ifeq (a,b)", "Makefile").includes("keyword:ifeq"), true);
  assertEquals(
    kinds("export A=1", "Dockerfile").includes("keyword:export"),
    true,
  );
  assertEquals(langOf("README"), null);
  assertEquals(langOf("notes"), null);
});

Deno.test("Python is Python, not shell", () => {
  // The regression: `py` used to share the shell table, so this line came back
  // with `echo`-shaped keywords and none of Python's own.
  const py = kinds("class A: pass", "a.py");
  assertEquals(py.includes("keyword:class"), true);
  assertEquals(py.includes("keyword:pass"), true);
  assertEquals(kinds("fi", "a.py").includes("keyword:fi"), false);
  assertEquals(kinds("fi", "a.sh").includes("keyword:fi"), true);
});

Deno.test("comments run to the end of the line, in each language's spelling", () => {
  assertEquals(tokenize("x = 1 // done", langOf("a.ts")).at(-1), {
    kind: "comment",
    text: "// done",
  });
  assertEquals(tokenize("x = 1 -- done", langOf("a.lua")).at(-1), {
    kind: "comment",
    text: "-- done",
  });
  assertEquals(tokenize("x = 1 # done", langOf("a.py")).at(-1), {
    kind: "comment",
    text: "# done",
  });
  // …and `--` is not a comment where it is an operator.
  assertEquals(
    tokenize("i--", langOf("a.c")).some((t) => t.kind === "comment"),
    false,
  );
});

Deno.test("strings and numbers are found, and a keyword inside one is not", () => {
  assertEquals(kinds(`s = "if else"`, "a.py"), [
    "text:s = ",
    `string:"if else"`,
  ]);
  assertEquals(kinds("x = 0xFF", "a.c").includes("number:0xFF"), true);
  // A number that is part of an identifier is part of the identifier.
  assertEquals(kinds("utf8 = 1", "a.py").includes("number:8"), false);
});

Deno.test("an unknown extension is plain text, not a guess", () => {
  assertEquals(langOf("photo.jpeg"), null);
  assertEquals(tokenize("class if def", null), [
    { kind: "text", text: "class if def" },
  ]);
});

Deno.test("tokenizing never loses or reorders a character", () => {
  // The invariant the editor depends on: the spans it draws, concatenated, are
  // the line it was given. A lexer that drops one byte silently corrupts the
  // display of every line after it.
  let seed = 424242;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = `abcXY_09 "'\`#/-*(){}[];:=.,\\`;
  const names = ["a.ts", "a.py", "a.sh", "a.sql", "a.html", "a.md", "Makefile"];

  for (let i = 0; i < 400; i++) {
    let line = "";
    const len = Math.floor(rnd() * 40);
    for (let j = 0; j < len; j++) {
      line += alphabet[Math.floor(rnd() * alphabet.length)];
    }
    const name = names[Math.floor(rnd() * names.length)]!;
    assertEquals(
      tokenize(line, langOf(name)).map((t) => t.text).join(""),
      line,
      `${name}: ${JSON.stringify(line)}`,
    );
  }
});
