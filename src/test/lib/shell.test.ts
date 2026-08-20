// Quoting, which is the difference between deleting a folder and deleting two
// files that do not exist.
import { assertEquals } from "@std/assert";
import { shellArgs, shellQuote } from "../../lib/shell.ts";

Deno.test("ordinary names go through untouched", () => {
  assertEquals(shellQuote("README.md"), "README.md");
  assertEquals(shellQuote("src/lib/keys.ts"), "src/lib/keys.ts");
  assertEquals(shellQuote("a-b_c.2024+x@host"), "a-b_c.2024+x@host");
});

Deno.test("anything a shell would read as syntax is quoted", () => {
  assertEquals(shellQuote("My Documents"), "'My Documents'");
  assertEquals(shellQuote("a;rm -rf /"), "'a;rm -rf /'");
  assertEquals(shellQuote("$HOME"), "'$HOME'");
  assertEquals(shellQuote("`whoami`"), "'`whoami`'");
  assertEquals(shellQuote("a*b?c[d]"), "'a*b?c[d]'");
  assertEquals(shellQuote("new\nline"), "'new\nline'");
});

/** The assertion that actually matters: hand the quoted text to a real shell
 *  and see whether it hands back exactly the name we started with. Any escaping
 *  that survives this is correct; one that matches a hand-computed string but
 *  fails here is not — which is how the first version of this test was wrong
 *  while the code was right. */
async function roundTrip(name: string): Promise<string> {
  const { stdout } = await new Deno.Command("/bin/sh", {
    args: ["-c", `printf %s ${shellQuote(name)}`],
  }).output();
  return new TextDecoder().decode(stdout);
}

Deno.test("a real shell reads back exactly what was quoted", async () => {
  const nasty = [
    "it's",
    "''",
    "My Documents",
    "$HOME",
    "`whoami`",
    "a;rm -rf /",
    'say "hi"',
    "back\\slash",
    "tab\there",
    "a*b?c[d]",
    "~root",
    "-rf",
    "#comment",
    "a|b&c",
    "(paren)",
    "naïve — ünïcode",
    "",
  ];
  for (const name of nasty) {
    assertEquals(await roundTrip(name), name, `round trip failed for ${name}`);
  }
});

Deno.test("the empty string stays an argument", () => {
  // Without this it would vanish and shift every argument after it along.
  assertEquals(shellQuote(""), "''");
});

Deno.test("a marked set becomes one command line", () => {
  assertEquals(
    shellArgs(["a.txt", "two words.txt", "c.txt"]),
    "a.txt 'two words.txt' c.txt",
  );
  assertEquals(shellArgs([]), "");
});
