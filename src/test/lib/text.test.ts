import { assertEquals } from "@std/assert";
import {
  clampPos,
  columnText,
  completions,
  deleteColumn,
  deleteRange,
  findFrom,
  indentOf,
  insertAt,
  insertColumn,
  joinLines,
  leftOf,
  matchBracket,
  orderPos,
  rightOf,
  splitLines,
  stripOverstrike,
  textInRange,
  wordBefore,
  wordEdge,
} from "../../lib/text.ts";

Deno.test("splitLines remembers how the file ended", () => {
  assertEquals(splitLines("a\nb\n"), {
    lines: ["a", "b"],
    trailingNewline: true,
  });
  assertEquals(splitLines("a\nb"), {
    lines: ["a", "b"],
    trailingNewline: false,
  });
  assertEquals(splitLines(""), { lines: [""], trailingNewline: false });
  // CRLF is normalized on the way in, so editing does not mix line endings
  assertEquals(splitLines("a\r\nb\r\n").lines, ["a", "b"]);
});

Deno.test("join round-trips split", () => {
  for (const text of ["a\nb\n", "a\nb", "", "\n", "one"]) {
    const { lines, trailingNewline } = splitLines(text);
    assertEquals(
      joinLines(lines, trailingNewline),
      text.replace(/\r\n/g, "\n"),
    );
  }
});

Deno.test("insertAt inserts within a line", () => {
  const r = insertAt(["hello world"], { line: 0, col: 5 }, ",");
  assertEquals(r.lines, ["hello, world"]);
  assertEquals(r.pos, { line: 0, col: 6 });
});

Deno.test("insertAt splits a line on a newline", () => {
  const r = insertAt(["hello world"], { line: 0, col: 5 }, "\n");
  assertEquals(r.lines, ["hello", " world"]);
  assertEquals(r.pos, { line: 1, col: 0 });
});

Deno.test("insertAt handles multi-line pastes", () => {
  const r = insertAt(["ab", "cd"], { line: 0, col: 1 }, "X\nY\nZ");
  assertEquals(r.lines, ["aX", "Y", "Zb", "cd"]);
  assertEquals(r.pos, { line: 2, col: 1 });
});

Deno.test("deleteRange within and across lines, returning what it removed", () => {
  const one = deleteRange(["hello world"], { line: 0, col: 5 }, {
    line: 0,
    col: 11,
  });
  assertEquals(one.lines, ["hello"]);
  assertEquals(one.removed, " world");

  const many = deleteRange(["ab", "cd", "ef"], { line: 0, col: 1 }, {
    line: 2,
    col: 1,
  });
  assertEquals(many.lines, ["af"]);
  assertEquals(many.removed, "b\ncd\ne");
  assertEquals(many.pos, { line: 0, col: 1 });
});

Deno.test("deleteRange accepts its positions in either order", () => {
  const a = deleteRange(["abcdef"], { line: 0, col: 4 }, { line: 0, col: 1 });
  assertEquals(a.lines, ["aef"]);
  assertEquals(a.removed, "bcd");
});

Deno.test("an empty range removes nothing", () => {
  const r = deleteRange(["abc"], { line: 0, col: 1 }, { line: 0, col: 1 });
  assertEquals(r.lines, ["abc"]);
  assertEquals(r.removed, "");
});

Deno.test("textInRange reads without mutating", () => {
  const lines = ["ab", "cd"];
  assertEquals(
    textInRange(lines, { line: 0, col: 1 }, { line: 1, col: 1 }),
    "b\nc",
  );
  assertEquals(lines, ["ab", "cd"]);
});

Deno.test("left/right step over line breaks and stop at the ends", () => {
  const lines = ["ab", "cd"];
  assertEquals(leftOf(lines, { line: 1, col: 0 }), { line: 0, col: 2 });
  assertEquals(leftOf(lines, { line: 0, col: 0 }), { line: 0, col: 0 });
  assertEquals(rightOf(lines, { line: 0, col: 2 }), { line: 1, col: 0 });
  assertEquals(rightOf(lines, { line: 1, col: 2 }), { line: 1, col: 2 });
});

Deno.test("clampPos keeps a position inside the document", () => {
  assertEquals(clampPos(["ab", "c"], { line: 9, col: 9 }), { line: 1, col: 1 });
  assertEquals(clampPos(["ab"], { line: -3, col: -3 }), { line: 0, col: 0 });
});

Deno.test("orderPos sorts by line then column", () => {
  const [a, b] = orderPos({ line: 2, col: 0 }, { line: 1, col: 9 });
  assertEquals(a, { line: 1, col: 9 });
  assertEquals(b, { line: 2, col: 0 });
});

Deno.test("indentOf reproduces leading whitespace only", () => {
  assertEquals(indentOf("    x"), "    ");
  assertEquals(indentOf("\t\tx"), "\t\t");
  assertEquals(indentOf("x"), "");
});

Deno.test("findFrom searches forward, backward and wraps", () => {
  const lines = ["alpha", "beta needle", "gamma", "needle again"];
  assertEquals(findFrom(lines, "needle", { line: 0, col: 0 }, true), {
    line: 1,
    col: 5,
  });
  assertEquals(findFrom(lines, "needle", { line: 2, col: 0 }, true), {
    line: 3,
    col: 0,
  });
  // wraps around to find the earlier one
  assertEquals(findFrom(lines, "alpha", { line: 2, col: 0 }, true), {
    line: 0,
    col: 0,
  });
  // case-insensitive when asked
  assertEquals(findFrom(lines, "NEEDLE", { line: 0, col: 0 }, true), {
    line: 1,
    col: 5,
  });
  assertEquals(findFrom(lines, "NEEDLE", { line: 0, col: 0 }, false), null);
  assertEquals(findFrom(lines, "absent", { line: 0, col: 0 }, true), null);
});

Deno.test("randomized documents hold every editing invariant", () => {
  // Editing is where a bug costs a user their file, and the interesting cases
  // are the ones nobody writes by hand: an empty document, a line that ends
  // where the selection starts, a tab, a character outside the BMP. So: random
  // documents, random positions, and the properties that must hold for all of
  // them. Seeded, so a failure reproduces exactly.
  let seed = 987654321;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(a: T[]): T => a[int(a.length)]!;
  const CHARS = ["a", "b", " ", "\t", "\n", "é", "中", "\\", '"'];
  const text = (max: number) =>
    Array.from({ length: int(max) }, () => pick(CHARS)).join("");

  for (let round = 0; round < 800; round++) {
    const src = text(40);
    const { lines, trailingNewline } = splitLines(src);
    const doc = () => joinLines(lines, trailingNewline);

    // Reading a file and writing it back changes nothing.
    assertEquals(doc(), src, `round trip, round ${round}`);

    // A clamped position is always inside the document.
    const at = clampPos(lines, { line: int(8) - 2, col: int(12) - 3 });
    assertEquals(
      at.line >= 0 && at.line < lines.length && at.col >= 0 &&
        at.col <= lines[at.line]!.length,
      true,
      `clamp escaped the document: ${JSON.stringify({ lines, at })}`,
    );

    // Typing something and deleting exactly what was typed is the identity —
    // which is the whole contract undo rests on.
    const typed = text(8);
    const after = insertAt(lines, at, typed);
    const undone = deleteRange(after.lines, at, after.pos);
    assertEquals(
      joinLines(undone.lines, trailingNewline),
      doc(),
      `insert then delete changed the document: ${
        JSON.stringify({ lines, at, typed })
      }`,
    );
    assertEquals(undone.removed, typed, "the wrong text came back");

    // Stepping right then left returns to where it started.
    const from = clampPos(lines, { line: int(lines.length), col: int(10) });
    const right = rightOf(lines, from);
    if (right.line !== from.line || right.col !== from.col) {
      assertEquals(leftOf(lines, right), from, "left/right are not inverses");
    }

    // A search hit is really there; no hit means the text really is absent.
    const needle = text(3);
    if (needle && !needle.includes("\n")) {
      const hit = findFrom(lines, needle, at, true, rnd() < 0.5);
      if (hit) {
        assertEquals(
          (lines[hit.line] ?? "").slice(hit.col, hit.col + needle.length)
            .toLowerCase(),
          needle.toLowerCase(),
          `findFrom pointed at the wrong place: ${
            JSON.stringify({ lines, needle, hit })
          }`,
        );
      } else {
        assertEquals(
          lines.some((l) => l.toLowerCase().includes(needle.toLowerCase())),
          false,
          `findFrom missed: ${JSON.stringify({ lines, needle, from: at })}`,
        );
      }
    }
  }
});

Deno.test("nroff overstrike collapses to the text a man page means", () => {
  // What `man` emits for a terminal with no attributes.
  assertEquals(stripOverstrike("N\bNA\bAM\bME\bE"), "NAME");
  assertEquals(stripOverstrike("_\bi_\bt_\ba_\bl"), "ital");
  assertEquals(stripOverstrike("plain text"), "plain text");
  assertEquals(stripOverstrike(""), "");
  // A dangling backspace has nothing to overstrike. This is a DISPLAY filter,
  // so it drops rather than passing a control character through to the view.
  assertEquals(stripOverstrike("ab\b"), "ab");
  // The bytes on disk are untouched — turning the mode off shows them again.
});

Deno.test("wordEdge walks words the way C-Left and C-Right should", () => {
  const doc = ["const read_dir_2 = (a, b) => a;"];
  // From the start, right lands after the first word.
  assertEquals(wordEdge(doc, { line: 0, col: 0 }, 1), { line: 0, col: 5 });
  // An identifier with underscores and digits is ONE word.
  assertEquals(wordEdge(doc, { line: 0, col: 5 }, 1), { line: 0, col: 16 });
  // Left again returns to where it started.
  assertEquals(wordEdge(doc, { line: 0, col: 16 }, -1), { line: 0, col: 6 });
});

Deno.test("wordEdge crosses line boundaries instead of sticking", () => {
  const doc = ["one", "two"];
  assertEquals(wordEdge(doc, { line: 0, col: 3 }, 1), { line: 1, col: 3 });
  assertEquals(wordEdge(doc, { line: 1, col: 0 }, -1), { line: 0, col: 0 });
  // …and stops at the ends of the document rather than running off.
  assertEquals(wordEdge(doc, { line: 0, col: 0 }, -1), { line: 0, col: 0 });
  assertEquals(wordEdge(doc, { line: 1, col: 3 }, 1), { line: 1, col: 3 });
});

Deno.test("matchBracket counts nesting rather than finding the nearest", () => {
  const doc = ["f(g(x), h(y))"];
  assertEquals(matchBracket(doc, { line: 0, col: 1 }), { line: 0, col: 12 });
  assertEquals(matchBracket(doc, { line: 0, col: 12 }), { line: 0, col: 1 });
  assertEquals(matchBracket(doc, { line: 0, col: 3 }), { line: 0, col: 5 });
  assertEquals(matchBracket(doc, { line: 0, col: 0 }), null);
});

Deno.test("matchBracket spans lines and gives up honestly", () => {
  const doc = ["if (a) {", "  b();", "}"];
  assertEquals(matchBracket(doc, { line: 0, col: 7 }), { line: 2, col: 0 });
  assertEquals(matchBracket(["("], { line: 0, col: 0 }), null);
});

Deno.test("completion offers the document's own words, nearest first", () => {
  const doc = ["formatSize", "far away", "format", "formatTime"];
  assertEquals(wordBefore(["formatT"], { line: 0, col: 7 }), "formatT");
  const c = completions(doc, "form", 2);
  assertEquals(c[0], "format");
  assertEquals(c.includes("formatSize"), true);
  assertEquals(c.includes("formatTime"), true);
  // The prefix itself is not a completion of itself.
  assertEquals(completions(["format"], "format", 0), []);
  assertEquals(completions(doc, "", 0), []);
});

Deno.test("a column block is the same rectangle whichever way it is dragged", () => {
  const doc = ["abcdef", "ghijkl", "mnopqr"];
  const a = { line: 0, col: 1 }, b = { line: 2, col: 4 };
  assertEquals(columnText(doc, a, b), "bcd\nhij\nnop");
  assertEquals(columnText(doc, b, a), "bcd\nhij\nnop");
});

Deno.test("cutting a column closes the gap on every line it crossed", () => {
  const doc = ["abcdef", "ghijkl", "mnopqr", "keep"];
  const cut = deleteColumn(doc, { line: 0, col: 1 }, { line: 2, col: 4 });
  assertEquals(cut, ["aef", "gkl", "mqr", "keep"]);
});

Deno.test("a short line takes what fits and nothing invented", () => {
  const doc = ["abcdef", "gh"];
  assertEquals(
    columnText(doc, { line: 0, col: 2 }, { line: 1, col: 5 }),
    "cde\n",
  );
});

Deno.test("pasting a column pads short lines so the block lands square", () => {
  const doc = ["ab", "c", ""];
  const out = insertColumn(doc, { line: 0, col: 2 }, "X\nY\nZ");
  assertEquals(out, ["abX", "c Y", "  Z"]);
});
