/** Turning filenames into command-line text. Pure, because getting it wrong is
 *  how a file manager runs the wrong command on the wrong file. */

/** Characters that mean nothing special to a POSIX shell. Anything outside
 *  this set has to be quoted — including the space, which is the common case
 *  and the dangerous one (`rm My Documents` removes two things, neither of
 *  them the folder). */
const SAFE = /^[A-Za-z0-9._\-+=:,@%/]+$/;

/** One shell argument. Quoted only when it has to be, the way mc's
 *  `command_insert` does it: an unnecessary pair of quotes around every name
 *  turns a readable command line into a wall of punctuation.
 *
 *  Single quotes, because inside them the shell expands nothing at all; a name
 *  containing one is closed, given an escaped quote, and reopened — the
 *  `'\''` idiom, which is the only correct way to do this. The empty string
 *  quotes to `''`, because otherwise it would vanish and shift every argument
 *  after it. */
export function shellQuote(s: string): string {
  if (s === "") return "''";
  if (SAFE.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Several arguments, space-separated — the marked set, on its way to the
 *  command line. */
export const shellArgs = (items: readonly string[]): string =>
  items.map(shellQuote).join(" ");
