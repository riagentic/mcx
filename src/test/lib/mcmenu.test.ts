// mc's user-menu format, tested against mc's own menu file.
import { assert, assertEquals } from "@std/assert";
import {
  applicable,
  conditionHolds,
  expandMacros,
  fillPrompts,
  parseMenu,
  promptsOf,
} from "../../lib/mcmenu.ts";
import { shellQuote } from "../../lib/shell.ts";

const SAMPLE = `shell_patterns=0
# a comment

+ ! t t
@       Do something on the current file
        CMD=%{Enter command}
        $CMD %f

= t d
3       Compress the current subdirectory (tar.gz)
        Pwd=\`basename %d /\`
        tar cf - "$Pwd" | gzip -f9 > "$tar.tar.gz"

=+ f \\.1$ | f \\.man$ & t r
1       Display the file with roff -man
        roff -man %f
`;

Deno.test("entries, their hotkeys, labels and commands come out whole", () => {
  const m = parseMenu(SAMPLE);
  assertEquals(m.length, 3);
  assertEquals(m[0]!.hotkey, "@");
  assertEquals(m[0]!.label, "Do something on the current file");
  assertEquals(m[0]!.commands, ["CMD=%{Enter command}", "$CMD %f"]);
  assertEquals(m[1]!.hotkey, "3");
  assertEquals(m[1]!.isDefault, true);
  // The comment, the blank lines and `shell_patterns=` are not entries.
  assertEquals(m.map((e) => e.hotkey), ["@", "3", "1"]);
});

Deno.test("conditions decide which entries a file sees", () => {
  const m = parseMenu(SAMPLE);
  const file = { name: "readme.1", type: "fr", tagged: false };
  const dir = { name: "src", type: "d", tagged: false };

  // `+ ! t t` — only when nothing is tagged.
  assertEquals(applicable(m, file).map((e) => e.hotkey), ["@", "1"]);
  // `= t d` — the directory entry, and not the man-page one.
  assertEquals(applicable(m, dir).map((e) => e.hotkey), ["@", "3"]);
  // With something tagged, the first entry drops out.
  assertEquals(
    applicable(m, { ...file, tagged: true }).map((e) => e.hotkey),
    ["1"],
  );
});

Deno.test("the condition grammar: not, and, or", () => {
  const f = { name: "a.tar.gz", type: "fr", tagged: false };
  assertEquals(conditionHolds("f \\.gz$", f), true);
  assertEquals(conditionHolds("f \\.zip$", f), false);
  assertEquals(conditionHolds("f \\.zip$ | f \\.gz$", f), true);
  assertEquals(conditionHolds("f \\.gz$ & t r", f), true);
  assertEquals(conditionHolds("f \\.gz$ & t d", f), false);
  assertEquals(conditionHolds("! t t", f), true);
  assertEquals(conditionHolds("", f), true);
  // An unparsable pattern matches nothing rather than everything.
  assertEquals(conditionHolds("f [", f), false);
});

const MACROS = {
  file: "my file.txt",
  dir: "/home/u/docs",
  tagged: ["a.txt", "b c.txt"],
  otherFile: "other.txt",
  otherDir: "/tmp",
  otherTagged: ["z.txt"],
};

Deno.test("macros expand, quoted, with the other panel in upper case", () => {
  const e = (l: string) => expandMacros(l, MACROS, shellQuote);
  assertEquals(e("cat %f"), "cat 'my file.txt'");
  assertEquals(e("cd %d"), "cd /home/u/docs");
  assertEquals(e("cp %t %D"), "cp a.txt 'b c.txt' /tmp");
  assertEquals(e("cat %F"), "cat other.txt");
  assertEquals(e("echo %n and %x"), "echo 'my file' and txt");
  assertEquals(e("100%% done"), "100% done");
});

Deno.test("%0f turns quoting off for one macro", () => {
  assertEquals(expandMacros("tar %0f", MACROS, shellQuote), "tar my file.txt");
  assertEquals(
    expandMacros("tar %1f", MACROS, shellQuote),
    "tar 'my file.txt'",
  );
});

Deno.test("an unknown macro is left alone rather than eaten", () => {
  assertEquals(expandMacros("100%q", MACROS, shellQuote), "100%q");
});

Deno.test("prompts are collected in order and filled back in order", () => {
  const cmds = ["A=%{First}", "B=%{Second}", "run $A $B"];
  assertEquals(promptsOf(cmds), ["First", "Second"]);
  assertEquals(fillPrompts(cmds, ["one", "two"]), [
    "A=one",
    "B=two",
    "run $A $B",
  ]);
});

Deno.test("mc's own menu file parses", () => {
  // The real thing, from the vendored source: 30-odd entries with conditions,
  // macros and multi-line commands. If this parses, the format is understood.
  let text: string;
  try {
    text = Deno.readTextFileSync(
      new URL("../../../mc/misc/mc.menu.in", import.meta.url),
    );
  } catch {
    return; // upstream tree not checked out
  }
  const m = parseMenu(text);
  assert(m.length > 10, `only ${m.length} entries parsed`);
  for (const e of m) {
    assert(e.hotkey.length === 1, `bad hotkey ${JSON.stringify(e.hotkey)}`);
    assert(e.label.length > 0, `entry ${e.hotkey} has no label`);
    assert(e.commands.length > 0, `entry ${e.hotkey} has no command`);
  }
});

Deno.test("a prompt's answer is quoted, so a space in it cannot split it", () => {
  // mc's own idiom: put a whole command in a variable, then run it.
  const cmds = ["CMD=%{Enter command}", "$CMD %f"];
  assertEquals(
    fillPrompts(cmds, ["ls -l"], shellQuote),
    ["CMD='ls -l'", "$CMD %f"],
  );
  // Unquoted, `CMD=ls -l` sets CMD=ls and runs `-l` — which is how this was
  // found: the command ran, and did nothing anyone asked for.
  assertEquals(fillPrompts(cmds, ["ls -l"]), ["CMD=ls -l", "$CMD %f"]);
});
