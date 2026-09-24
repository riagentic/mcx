// Copy, move and delete — with the progress, the questions and the JOB LIST
// that make them usable on real trees.
//
// The engine lives in `fileops.server.ts`; this cell owns the state a user
// sees (what is happening, how far along, what is being asked) and the policy
// the engine defers to (overwrite this one / all / none).
//
// Several operations can be in flight at once, which is mc's C-x j: a copy of
// something large goes to the background and the panels stay usable, while a
// second copy starts beside it. That is why the state is a LIST of jobs rather
// than one set of counters — a single slot cannot represent two answers to
// "how far along?", and mirroring the front one into top-level fields would be
// two truths about the same operation.
import { cell, type MethodDraftMeta } from "aio";
import { panels } from "./panels.ts";
import { ui } from "./ui.ts";
import { basename } from "../lib/path.ts";
import type { Collision, Decision } from "./fileops.server.ts";
import { isRemote } from "../lib/remote.ts";

export type OpKind = "copy" | "move" | "delete";

/** The two things a file operation stops to ask.
 *
 *  `overwrite` carries both files, because mc's "Older" and "Size differs"
 *  are answers ABOUT them. `recursive` is mc's second delete question, the one
 *  that stands between F8 on a directory you thought was empty and its whole
 *  subtree. Both carry `dst`, so "what is it asking about" needs no narrowing. */
export type Question =
  | ({ kind: "overwrite" } & Collision)
  | { kind: "recursive"; dst: string }
  /** Something failed. mc offers Retry here, and the Retry is the point: a
   *  copy that died on a full disk can be finished after making room. */
  | { kind: "error"; dst: string; message: string };

/** Every button mc's "File exists" dialog has.
 *
 *  The first four answer THIS file; the five after them are policies that hold
 *  for the rest of the operation, which is why mc puts them under a second
 *  heading ("Overwrite all files?"). `cancel` is its Abort. */
export type Answer =
  | "overwrite"
  | "skip"
  | "append"
  | "reget"
  | "overwriteAll"
  | "skipAll"
  | "older"
  | "smaller"
  | "sizeDiffers"
  | "retry"
  | "cancel";

/** The five that hold for the whole operation. */
type Policy = "all" | "none" | "older" | "smaller" | "sizeDiffers";

const POLICY: Partial<Record<Answer, Policy>> = {
  overwriteAll: "all",
  skipAll: "none",
  older: "older",
  smaller: "smaller",
  sizeDiffers: "sizeDiffers",
};

/** One operation in flight. */
export type Job = {
  id: string;
  kind: OpKind;
  /** Destination directory (copy/move). */
  dest: string;
  /** The file being worked on right now. */
  current: string;
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  /** Set while the job waits for a decision. A job with a question is stuck
   *  until someone answers it, which is why the job list says so and the
   *  status line nags. */
  question: Question | null;
  /** mc's "Don't overwrite with zero length file" checkbox: it sits under the
   *  policy buttons and qualifies every one of them, so it belongs to the
   *  operation rather than to one answer. */
  zeroGuard: boolean;
  errors: string[];
  startedAt: number;
};

type FileopsState = {
  jobs: Job[];
  /** The job whose progress dialog is on screen. `null` means every job is in
   *  the background and the panels are free. */
  front: string | null;
  /** The errors of the operation that finished most recently — kept after the
   *  job itself is gone, because "what went wrong" outlives "what is running". */
  errors: string[];
};

/** Per-job plumbing that is not state: a resolver for the question on screen
 *  and a controller for cancelling THAT job.
 *
 *  Deferred promises rather than `until(() => …)`: `until` is a SERVER-side
 *  export of "aio" and is absent from the browser bundle, so a static import of
 *  it in this cell link-failed the client at boot with a blank screen — a
 *  failure no headless test can see (docs/build/imports.md). It is also
 *  strictly better here: the answer arrives on the dispatch that carries it,
 *  instead of on the next 25ms poll.
 *
 *  Keyed by job id, because with two copies running there are two of each. */
const resolvers = new Map<string, (a: Answer) => void>();
const controllers = new Map<string, AbortController>();

let counter = 0;

/** How often progress reaches the client. 60ms is under a frame at 15fps and
 *  far above the cost of a broadcast — fast enough to look live, rare enough
 *  that copying 10_000 small files is not 10_000 renders. */
const TICK_MS = 60;

const newJob = (kind: OpKind, dest: string): Job => ({
  id: `${kind}-${++counter}`,
  kind,
  dest,
  current: "scanning…",
  doneBytes: 0,
  totalBytes: 0,
  doneFiles: 0,
  totalFiles: 0,
  question: null,
  zeroGuard: false,
  errors: [],
  startedAt: Date.now(),
});

export const fileops = cell("fileops", {
  // An operation in flight is not a fact worth restoring — it is a fact worth
  // finishing or forgetting.
  persist: "none",

  state: {
    jobs: [] as Job[],
    front: null as string | null,
    errors: [] as string[],
  },

  methods: {
    /** F5/F6. `move` renames when it can and falls back to copy+delete when the
     *  destination is on another filesystem. */
    async run(
      s: FileopsState & MethodDraftMeta,
      kind: "copy" | "move",
      sources: string[],
      dest: string,
    ) {
      if (sources.length === 0) return void ui.say("Nothing selected");
      // A copy with a remote end is a different transport, not a different
      // operation: scp does the work, and the job list reports it the same way.
      if (isRemote(dest) || sources.some(isRemote)) {
        return void await fileops.transfer(kind, sources, dest);
      }
      const io = await import("./fileops.server.ts");

      const job = newJob(kind, dest);
      const ac = new AbortController();
      controllers.set(job.id, ac);
      s.jobs = [...s.jobs, job];
      s.front = job.id;
      const id = job.id;

      /** The live draft of this job. Re-read after every await: each one is a
       *  commit point, and another dispatch may have added or removed jobs. */
      const at = (): Job | undefined => s.jobs.find((j) => j.id === id); // aio-ok

      const items = await io.walk(sources, ac.signal);
      const scanned = at(); // aio-ok: re-read after await
      if (!scanned || ac.signal.aborted) return void finish(s, id, [], true);
      scanned.totalFiles = items.length;
      scanned.totalBytes = io.totalBytes(items);

      // Sticky answers live here, not in the engine: "overwrite all" is a
      // decision about this operation, and the engine should not remember
      // anything between calls.
      let policy: Policy | null = null;
      let lastTick = 0;

      const errors = await io.transfer(items, dest, kind === "move", {
        signal: ac.signal,
        onFile: (path, done) => {
          const j = at();
          if (!j) return;
          j.doneFiles = done;
          const now = Date.now();
          if (now - lastTick < TICK_MS) return;
          lastTick = now;
          j.current = path;
        },
        onBytes: (n) => {
          const j = at();
          if (j) j.doneBytes += n;
        },
        onError: async (path, message) => {
          const j = at();
          if (j) j.question = { kind: "error", dst: path, message };
          const waiting = new Promise<Answer>((r) => resolvers.set(id, r));
          ac.signal.addEventListener(
            "abort",
            () => resolvers.get(id)?.("cancel"),
            { once: true },
          );
          const a = await waiting;
          resolvers.delete(id);
          const after = at(); // aio-ok: re-read after await
          if (after) after.question = null;
          return a === "retry"
            ? "retry"
            : a === "skipAll"
            ? "skipAll"
            : a === "cancel"
            ? "cancel"
            : "skip";
        },

        ask: async (c) => {
          // mc's rule, in mc's order: a standing policy answers first, and the
          // zero-length guard qualifies whatever it says.
          const guard = (d: Decision): Decision =>
            at()?.zeroGuard && c.srcSize === 0 ? { action: "skip" } : d;
          const byPolicy = (p: Policy): Decision => {
            switch (p) {
              case "all":
                return guard({ action: "overwrite" });
              case "none":
                return { action: "skip" };
              case "older":
                return c.srcTime > c.dstTime
                  ? guard({ action: "overwrite" })
                  : { action: "skip" };
              case "smaller":
                // mc does NOT apply the zero guard here — a zero-length source
                // is never larger than its destination, so it never gets past.
                return c.srcSize > c.dstSize
                  ? { action: "overwrite" }
                  : { action: "skip" };
              case "sizeDiffers":
                return c.srcSize === c.dstSize
                  ? { action: "skip" }
                  : guard({ action: "overwrite" });
            }
          };
          if (policy) return byPolicy(policy);
          // Options → Confirmation → Overwrite. Off means "yes, all of them",
          // which is a decision the user has made in advance rather than one
          // this code is making for them.
          if (!ui.confirmOverwrite) return { action: "overwrite" };
          const j = at();
          if (j) j.question = { kind: "overwrite", ...c };
          const waiting = new Promise<Answer>((r) => resolvers.set(id, r));
          // Cancelling mid-question answers it, so the engine unwinds instead
          // of waiting for a human who has already given up.
          ac.signal.addEventListener(
            "abort",
            () => resolvers.get(id)?.("cancel"),
            { once: true },
          );
          const a = await waiting;
          resolvers.delete(id);
          const after = at(); // aio-ok: re-read after await
          if (after) after.question = null;
          const p = POLICY[a];
          if (p) {
            policy = p;
            return byPolicy(p);
          }
          switch (a) {
            case "cancel":
              return { action: "cancel" };
            case "skip":
              return { action: "skip" };
            // Append adds the whole source; Reget adds only what is missing,
            // which is how an interrupted copy is finished.
            case "append":
              return { action: "append", from: 0 };
            case "reget":
              // aio-ok: `c` is the conflict the engine asked about, not state
              return { action: "append", from: c.dstSize };
            default:
              return guard({ action: "overwrite" });
          }
        },
      });

      const done = at(); // aio-ok: re-read after await
      const label = `${kind === "copy" ? "Copied" : "Moved"} ${
        done?.doneFiles ?? 0
      } of ${done?.totalFiles ?? 0}`;
      const cancelled = ac.signal.aborted;
      finish(s, id, errors, cancelled);
      if (!cancelled) {
        ui.say(errors.length ? `${label} — ${errors.length} failed` : label);
      }
      await panels.reload("left");
      await panels.reload("right");
    },

    /** F5/F6 with one end on another machine. Files are counted rather than
     *  bytes: scp reports its own progress to a terminal nobody is reading, so
     *  the honest number here is how many of the files are done. */
    async transfer(
      s: FileopsState,
      kind: "copy" | "move",
      sources: string[],
      dest: string,
    ) {
      const io = await import("./remote.server.ts");
      const job = newJob(kind, dest);
      job.totalFiles = sources.length;
      const ac = new AbortController();
      controllers.set(job.id, ac);
      s.jobs = [...s.jobs, job];
      s.front = job.id;
      const id = job.id;
      const at = (): Job | undefined => s.jobs.find((j) => j.id === id); // aio-ok

      const errors: string[] = [];
      for (const [i, src] of sources.entries()) {
        if (ac.signal.aborted) break;
        const j = at(); // aio-ok: re-read after await
        if (!j) break;
        j.current = src;
        j.doneFiles = i;

        const remoteSrc = isRemote(src);
        const name = basename(remoteSrc ? src : src);
        const target = isRemote(dest)
          ? (dest.endsWith("/") ? `${dest}${name}` : `${dest}/${name}`)
          : `${dest}/${name}`;
        const err = remoteSrc
          ? await io.download(src, target)
          : await io.upload(src, target);
        if (err) errors.push(`${name}: ${err}`);
        // A move is a copy that then removes the source — and only if the copy
        // said it worked.
        if (!err && kind === "move") {
          // Removing the local side goes through the file engine, not through
          // `Deno.*`: this file is a cell, and a cell is compiled into the
          // browser bundle too.
          const local = await import("./fileops.server.ts");
          const rm = remoteSrc
            ? await io.remove(src)
            : await local.remove(src, true);
          if (rm) errors.push(`${name}: ${rm}`);
        }
      }

      finish(s, id, errors, ac.signal.aborted);
      ui.say(
        errors.length
          ? `${sources.length - errors.length} of ${sources.length} — ${
            errors[0]
          }`
          : `${kind === "copy" ? "Copied" : "Moved"} ${sources.length}`,
      );
      await panels.reload("left");
      await panels.reload("right");
    },

    /** F8. Deletes are not progress-barred per byte — they are counted, which
     *  is the number that means anything when removing files. */
    async remove(
      s: FileopsState & MethodDraftMeta,
      sources: string[],
    ) {
      if (sources.length === 0) return void ui.say("Nothing selected");
      const io = await import("./fileops.server.ts");

      // Remote deletes go over ssh; local ones through the filesystem.
      const remoteIo = sources.some(isRemote)
        ? await import("./remote.server.ts")
        : null;

      const job = newJob("delete", "");
      job.totalFiles = sources.length;
      const ac = new AbortController();
      controllers.set(job.id, ac);
      s.jobs = [...s.jobs, job];
      s.front = job.id;
      const id = job.id;
      const at = (): Job | undefined => s.jobs.find((j) => j.id === id); // aio-ok

      // mc's second delete question, and the reason it exists: "Delete 1 file?"
      // was answered about a NAME, and the name did not say that the directory
      // behind it holds four hundred of them. `null` means nobody has decided
      // for the whole operation yet.
      let recurse: "all" | "none" | null = null;

      const errors: string[] = [];
      for (const [i, path] of sources.entries()) {
        if (ac.signal.aborted) break;
        const j = at(); // aio-ok: re-read after await
        if (!j) break;
        j.current = path;
        j.doneFiles = i;

        const remote = isRemote(path) && remoteIo;
        if (!remote && ui.confirmDelete && await io.isNonEmptyDir(path)) {
          let answer: Answer = recurse === "all"
            ? "overwrite"
            : recurse === "none"
            ? "skip"
            : "cancel";
          if (recurse === null) {
            const asking = at(); // aio-ok: re-read after await
            if (!asking) break;
            asking.question = { kind: "recursive", dst: path };
            const waiting = new Promise<Answer>((r) => resolvers.set(id, r));
            ac.signal.addEventListener(
              "abort",
              () => resolvers.get(id)?.("cancel"),
              { once: true },
            );
            answer = await waiting;
            resolvers.delete(id);
            const asked = at(); // aio-ok: re-read after await
            if (asked) asked.question = null;
            if (answer === "overwriteAll") recurse = "all";
            if (answer === "skipAll") recurse = "none";
          }
          if (answer === "cancel") break;
          if (answer === "skip" || answer === "skipAll") continue;
        }

        const err = remote
          ? await remoteIo!.remove(path)
          : await io.remove(path, true);
        if (err) errors.push(`${basename(path)}: ${err}`);
      }

      const removed = sources.length - errors.length;
      finish(s, id, errors, ac.signal.aborted);
      ui.say(
        errors.length
          ? `Deleted ${removed} of ${sources.length} — ${errors[0]}`
          : `Deleted ${removed}`,
      );
      await panels.reload("left");
      await panels.reload("right");
    },

    /** mc's "Don't overwrite with zero length file" — a switch on the operation,
     *  flipped from the dialog that is asking about it. */
    setZeroGuard(
      s: FileopsState,
      on: boolean,
      id: string | undefined = undefined,
    ) {
      const target = id ?? s.front ?? s.jobs.find((j) => j.question)?.id;
      const j = s.jobs.find((x) => x.id === target);
      if (j) j.zeroGuard = on;
    },

    /** The overwrite dialog's answer, for the job it belongs to (the one in
     *  front, unless the caller names another). */
    answerQuestion(
      s: FileopsState,
      a: Answer,
      id: string | undefined = undefined,
    ) {
      const target = id ?? s.front ??
        s.jobs.find((j) => j.question !== null)?.id;
      if (!target) return;
      const j = s.jobs.find((x) => x.id === target);
      if (j) j.question = null;
      resolvers.get(target)?.(a);
    },

    /** Cancel: abort the job, and clear its dialog immediately so the button
     *  feels connected to something. Without an id, the job in front. */
    cancel(s: FileopsState, id: string | undefined = undefined) {
      const target = id ?? s.front ?? s.jobs[0]?.id;
      if (!target) return;
      controllers.get(target)?.abort();
      const j = s.jobs.find((x) => x.id === target);
      if (j) j.question = null;
    },

    /** C-x j — put every running job behind the panels. The work continues;
     *  only the dialog goes away. */
    background(s: FileopsState) {
      s.front = null;
    },

    /** …and bring one back. */
    bringToFront(s: FileopsState, id: string) {
      if (s.jobs.some((j) => j.id === id)) s.front = id;
    },
  },

  selectors: {
    /** The job whose dialog is on screen, if any. A job holding a QUESTION
     *  always wins: an operation waiting on an answer nobody can see is the one
     *  way this design could strand a copy for ever. */
    frontJob: (s: FileopsState): Job | null => {
      const asking = s.jobs.find((j) => j.question !== null);
      if (asking) return asking;
      return s.jobs.find((j) => j.id === s.front) ?? null;
    },

    running: (s: FileopsState): boolean => s.jobs.length > 0,

    /** 0–100 for one job. Byte-based when there are bytes, file-based for
     *  deletes. */
    percentOf: (_s: FileopsState) => (j: Job): number => {
      if (j.totalBytes > 0) {
        return Math.min(100, (j.doneBytes / j.totalBytes) * 100);
      }
      if (j.totalFiles > 0) {
        return Math.min(100, (j.doneFiles / j.totalFiles) * 100);
      }
      return 0;
    },
  },
});

/** Retire a job: drop it from the list, remember its errors, and take its
 *  plumbing with it. One place, so a job cannot be left in the list with no
 *  controller behind it. */
function finish(
  s: FileopsState,
  id: string,
  errors: string[],
  _cancelled: boolean,
): void {
  s.jobs = s.jobs.filter((j) => j.id !== id);
  s.errors = errors;
  if (s.front === id) s.front = s.jobs[s.jobs.length - 1]?.id ?? null;
  resolvers.delete(id);
  controllers.delete(id);
}
