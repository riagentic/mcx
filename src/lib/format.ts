/** Pure formatters for the panel columns. mc's exact conventions, because
 *  muscle memory reads these columns without looking. No aio imports. */

import type { FileEntry, FileKind } from "../type/fs.ts";
import { UP_DIR } from "../type/fs.ts";

const KIND_CHAR: Record<FileKind, string> = {
  file: "-",
  dir: "d",
  link: "l",
  fifo: "p",
  socket: "s",
  block: "b",
  char: "c",
  unknown: "?",
};

const RWX = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];

/** `drwxr-xr-x` — kind char plus three permission triples, with setuid/setgid/
 *  sticky folded into the x positions exactly as `ls -l` does. */
export function formatMode(kind: FileKind, mode: number): string {
  const u = RWX[(mode >> 6) & 7]!,
    g = RWX[(mode >> 3) & 7]!,
    o = RWX[mode & 7]!;
  const setuid = (mode & 0o4000) !== 0;
  const setgid = (mode & 0o2000) !== 0;
  const sticky = (mode & 0o1000) !== 0;
  const swap = (t: string, on: boolean, ch: string) =>
    on ? t.slice(0, 2) + (t[2] === "x" ? ch : ch.toUpperCase()) : t;
  return (
    KIND_CHAR[kind] +
    swap(u, setuid, "s") +
    swap(g, setgid, "s") +
    swap(o, sticky, "t")
  );
}

/** mc's size column: directories read `UP--DIR` / `SUB-DIR`, not a byte count
 *  that means nothing. */
export function formatSize(e: FileEntry): string {
  if (e.name === UP_DIR) return "UP--DIR";
  // A directory that has been counted (C-Space) shows what it counted. That is
  // the whole point of asking.
  if (e.sized) return groupDigits(e.size);
  const dirish = e.kind === "dir" ||
    (e.kind === "link" && e.linkKind === "dir");
  if (dirish) return "SUB-DIR";
  if (e.kind === "link") return "SYMLINK";
  return groupDigits(e.size);
}

export function groupDigits(n: number): string {
  const s = Math.trunc(n).toString();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += " ";
    out += s[i];
  }
  return out;
}

const UNITS = ["B", "K", "M", "G", "T", "P"];

/** Compact size for tight columns and the status bar (mc's "SI" size display). */
export function humanSize(bytes: number): string {
  let n = Math.max(0, bytes);
  let u = 0;
  while (n >= 1024 && u < UNITS.length - 1) {
    n /= 1024;
    u++;
  }
  const s = u === 0
    ? String(Math.round(n))
    : n < 10
    ? n.toFixed(1)
    : String(Math.round(n));
  return `${s}${UNITS[u]}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const SIX_MONTHS_MS = 15_552_000_000;

/** `Aug 13 23:39` when recent, `Aug 13  2024` when older — the `ls`/mc rule.
 *  `now` is a parameter so this stays pure and testable.
 *
 *  A zero mtime is this codebase's "not known yet": phase one of a big
 *  directory load carries names and kinds only, and an unreadable entry keeps
 *  its zeros. Rendering it as `Jan  1  1970` filled the column with a date that
 *  is not the file's, so unknown prints as nothing at all. */
export function formatTime(mtime: number, now: number = Date.now()): string {
  if (mtime === 0) return "";
  const d = new Date(mtime);
  const mon = MONTHS[d.getMonth()]!;
  const day = String(d.getDate()).padStart(2, " ");
  if (Math.abs(now - mtime) > SIX_MONTHS_MS) {
    return `${mon} ${day}  ${d.getFullYear()}`;
  }
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mon} ${day} ${hh}:${mm}`;
}

/** How much longer an operation has, at the rate it has managed so far.
 *
 *  `""` when there is not enough evidence to say — under half a second of
 *  history, nothing transferred yet, or an answer so large it is obviously an
 *  artefact of a slow start. A confident wrong number is worse than no number,
 *  and this is the line a user watches when deciding whether to wait.
 *
 *  Pure, `elapsed` being a parameter, for the same reason `formatTime` takes
 *  `now`: it is the only way to test it. */
export function formatEta(
  done: number,
  total: number,
  elapsedMs: number,
): string {
  if (elapsedMs < 500 || done <= 0 || total <= done) return "";
  const secs = Math.round((total - done) * (elapsedMs / done) / 1000);
  if (secs > 24 * 3600) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (secs < 60) return `${secs}s left`;
  if (secs < 3600) return `${Math.floor(secs / 60)}:${pad(secs % 60)} left`;
  return `${Math.floor(secs / 3600)}:${pad(Math.floor(secs / 60) % 60)}:${
    pad(secs % 60)
  } left`;
}

/** The trailing character mc appends in listings: `/` dir, `@` link, `*` exec. */
export function typeChar(e: FileEntry): string {
  if (e.kind === "dir") return "/";
  if (e.kind === "link") return "@";
  if (e.kind === "fifo") return "|";
  if (e.kind === "socket") return "=";
  if (e.kind === "file" && (e.mode & 0o111) !== 0) return "*";
  return "";
}

/** Truncate to `width` keeping the tail visible — a filename's discriminating
 *  half is usually its end (`report-2024-final.tar.gz`). */
export function ellipsize(s: string, width: number): string {
  if (width <= 0 || s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return "~" + s.slice(s.length - (width - 1));
}
