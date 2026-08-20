// Remote paths and remote listings — the two things that must be right before
// mcx sends a single command to another machine.
import { assertEquals } from "@std/assert";
import {
  formatRemote,
  isRemote,
  parseFtpList,
  parseLsLong,
  parseRemote,
  remoteJoin,
  remoteParent,
} from "../../lib/remote.ts";

Deno.test("remote URLs come apart and go back together", () => {
  assertEquals(parseRemote("sh://host/var/log"), {
    scheme: "sh",
    user: "",
    host: "host",
    port: null,
    dir: "/var/log",
  });
  assertEquals(parseRemote("sftp://alice@host:2222/home/alice"), {
    scheme: "sftp",
    user: "alice",
    host: "host",
    port: 2222,
    dir: "/home/alice",
  });
  // A bare host means the remote home directory, as `ssh host` does.
  assertEquals(parseRemote("sh://host")?.dir, "");
  assertEquals(parseRemote("/local/path"), null);
  assertEquals(parseRemote("sh://"), null);
  assertEquals(
    formatRemote(parseRemote("sftp://alice@host:2222/x")!),
    "sftp://alice@host:2222/x",
  );
});

Deno.test("a user name containing an @ still parses", () => {
  const u = parseRemote("ftp://user@example.com@ftp.host/pub");
  assertEquals(u?.user, "user@example.com");
  assertEquals(u?.host, "ftp.host");
});

Deno.test("isRemote tells the two kinds of path apart", () => {
  assertEquals(isRemote("sh://host/x"), true);
  assertEquals(isRemote("ftp://host"), true);
  assertEquals(isRemote("/home/u"), false);
  // A local file whose name merely contains the word is still local.
  assertEquals(isRemote("/home/u/sh://weird"), false);
});

Deno.test("walking up stops at the remote root instead of falling off", () => {
  assertEquals(remoteParent("sh://host/a/b/c"), "sh://host/a/b");
  assertEquals(remoteParent("sh://host/a"), "sh://host/");
  // At the top there is nowhere up but out — the caller goes home.
  assertEquals(remoteParent("sh://host/"), null);
  assertEquals(remoteParent("/local"), null);
});

Deno.test("names join onto a remote directory without doubling slashes", () => {
  assertEquals(remoteJoin("sh://host/var", "log"), "sh://host/var/log");
  assertEquals(remoteJoin("sh://host/", "etc"), "sh://host/etc");
});

const LS = `total 12
drwxr-xr-x 2 alice devs  4096 2026-08-14 09:12 subdir
-rw-r--r-- 1 alice devs   137 2026-01-02 23:04 notes.txt
lrwxrwxrwx 1 alice devs     7 2026-08-14 09:12 link -> ../target
-rwxr-xr-x 1 root  root  1234 2025-12-31 08:00 run.sh
drwxr-xr-x 5 alice devs  4096 2026-08-14 09:12 .
drwxr-xr-x 9 alice devs  4096 2026-08-14 09:12 ..`;

Deno.test("an ls -l listing becomes panel entries", () => {
  const e = parseLsLong(LS);
  // `.` and `..` are dropped: the panel adds its own `..`.
  assertEquals(e.map((x) => x.name), [
    "subdir",
    "notes.txt",
    "link",
    "run.sh",
  ]);
  assertEquals(e[0]!.kind, "dir");
  assertEquals(e[1]!.size, 137);
  assertEquals(e[2]!.kind, "link");
  assertEquals(e[2]!.target, "../target");
  // The mode is real: run.sh is executable, notes.txt is not.
  assertEquals(e[3]!.mode & 0o111, 0o111);
  assertEquals(e[1]!.mode & 0o111, 0);
  assertEquals(e[1]!.mode & 0o777, 0o644);
  // The date parses to the day it says.
  assertEquals(new Date(e[1]!.mtime).getFullYear(), 2026);
});

Deno.test("a line that is not a listing is skipped, not guessed at", () => {
  assertEquals(parseLsLong("ls: cannot open /root: Permission denied"), []);
  assertEquals(parseLsLong(""), []);
});

Deno.test("an FTP listing parses too, old date format and all", () => {
  const e = parseFtpList(`drwxr-xr-x   2 ftp ftp  4096 Aug 14 09:12 pub
-rw-r--r--   1 ftp ftp   512 Dec 31  2024 readme.txt`);
  assertEquals(e.map((x) => x.name), ["pub", "readme.txt"]);
  assertEquals(e[0]!.kind, "dir");
  assertEquals(new Date(e[1]!.mtime).getFullYear(), 2024);
});

Deno.test("setuid and sticky bits survive the trip", () => {
  const e = parseLsLong(
    "-rwsr-xr-x 1 root root 1234 2026-01-01 00:00 sudo\n" +
      "drwxrwxrwt 9 root root 4096 2026-01-01 00:00 tmp",
  );
  assertEquals(e[0]!.mode & 0o4000, 0o4000);
  assertEquals(e[1]!.mode & 0o1000, 0o1000);
});
