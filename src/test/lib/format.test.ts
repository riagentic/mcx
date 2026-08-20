import { assertEquals } from "@std/assert";
import {
  ellipsize,
  formatEta,
  formatMode,
  formatSize,
  formatTime,
  groupDigits,
  humanSize,
  typeChar,
} from "../../lib/format.ts";
import type { FileEntry } from "../../type/fs.ts";

const entry = (p: Partial<FileEntry> = {}): FileEntry => ({
  name: "f",
  kind: "file",
  size: 0,
  mtime: 0,
  mode: 0o644,
  uid: 0,
  gid: 0,
  nlink: 1,
  ...p,
});

Deno.test("formatMode renders ls-style permission strings", () => {
  assertEquals(formatMode("file", 0o644), "-rw-r--r--");
  assertEquals(formatMode("dir", 0o755), "drwxr-xr-x");
  assertEquals(formatMode("link", 0o777), "lrwxrwxrwx");
  // setuid/setgid/sticky fold into the x column, upper-case when x is unset
  assertEquals(formatMode("file", 0o4755), "-rwsr-xr-x");
  assertEquals(formatMode("file", 0o4644), "-rwSr--r--");
  assertEquals(formatMode("dir", 0o1777), "drwxrwxrwt");
});

Deno.test("formatSize uses mc's directory markers", () => {
  assertEquals(formatSize(entry({ name: ".." })), "UP--DIR");
  assertEquals(formatSize(entry({ kind: "dir" })), "SUB-DIR");
  assertEquals(formatSize(entry({ kind: "link", linkKind: "dir" })), "SUB-DIR");
  assertEquals(formatSize(entry({ kind: "link" })), "SYMLINK");
  assertEquals(formatSize(entry({ size: 1234567 })), "1 234 567");
});

Deno.test("groupDigits groups from the right", () => {
  assertEquals(groupDigits(0), "0");
  assertEquals(groupDigits(999), "999");
  assertEquals(groupDigits(1000), "1 000");
  assertEquals(groupDigits(1234567890), "1 234 567 890");
});

Deno.test("humanSize is compact and binary", () => {
  assertEquals(humanSize(0), "0B");
  assertEquals(humanSize(1023), "1023B");
  assertEquals(humanSize(1024), "1.0K");
  assertEquals(humanSize(1536), "1.5K");
  assertEquals(humanSize(1024 * 1024 * 3), "3.0M");
});

Deno.test("formatTime switches to a year past six months", () => {
  const now = Date.UTC(2026, 7, 13, 12, 0, 0);
  const recent = new Date(2026, 6, 4, 9, 5).getTime();
  assertEquals(formatTime(recent, now), "Jul  4 09:05");
  const old = new Date(2024, 0, 2, 3, 4).getTime();
  assertEquals(formatTime(old, now), "Jan  2  2024");
});

Deno.test("formatTime prints nothing for an unknown time", () => {
  // Phase one of a two-phase load, and `..`, both carry mtime 0.
  assertEquals(formatTime(0, Date.UTC(2026, 7, 13)), "");
});

Deno.test("typeChar marks kinds the way ls -F does", () => {
  assertEquals(typeChar(entry({ kind: "dir" })), "/");
  assertEquals(typeChar(entry({ kind: "link" })), "@");
  assertEquals(typeChar(entry({ mode: 0o755 })), "*");
  assertEquals(typeChar(entry()), "");
});

Deno.test("ellipsize keeps the discriminating tail", () => {
  assertEquals(ellipsize("short", 10), "short");
  assertEquals(ellipsize("report-2024-final.tar.gz", 12), "~inal.tar.gz");
  assertEquals(ellipsize("report-2024-final.tar.gz", 12).length, 12);
});

Deno.test("formatEta answers only when it can", () => {
  // 1 MB of 4 MB in 2s → 3 more MB at 2 s/MB → 6s.
  assertEquals(formatEta(1_000_000, 4_000_000, 2000), "6s left");
  assertEquals(formatEta(10, 130, 10_000), "2:00 left");
  assertEquals(formatEta(1, 3601, 1000), "1:00:00 left");
  // Not enough evidence: no history, nothing done, already finished.
  assertEquals(formatEta(1, 100, 100), "");
  assertEquals(formatEta(0, 100, 5000), "");
  assertEquals(formatEta(100, 100, 5000), "");
  // A slow start must not promise a month.
  assertEquals(formatEta(1, 10_000_000, 60_000), "");
});
