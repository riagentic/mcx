/** The operation overlay: what is being copied, how far along, and the one
 *  question a copy can ask. Shown only while something is running, so the
 *  panels are never covered by a bar that means nothing. */

import { type Answer, fileops, type Job } from "../cell/fileops.ts";
import {
  formatEta,
  formatTime,
  groupDigits,
  humanSize,
} from "../lib/format.ts";
import { basename } from "../lib/path.ts";

const VERB: Record<string, string> = {
  copy: "Copying",
  move: "Moving",
  delete: "Deleting",
};

/** mc's second delete question: the one that stands between F8 on a directory
 *  you thought was empty and everything under it. */
function Recursive({ path }: { path: string }) {
  const answer = (a: Answer) => () => fileops.answerQuestion(a);
  return (
    <div class="ask" t="recursive-question">
      <p>
        <strong>{basename(path)}</strong> is not empty. Delete it recursively?
      </p>
      <div class="ask-buttons">
        <button type="button" t="rm-yes" onClick={answer("overwrite")}>
          Yes
        </button>
        <button type="button" t="rm-no" onClick={answer("skip")}>No</button>
        <button type="button" t="rm-all" onClick={answer("overwriteAll")}>
          All
        </button>
        <button type="button" t="rm-none" onClick={answer("skipAll")}>
          None
        </button>
        <button type="button" t="rm-abort" onClick={answer("cancel")}>
          Abort
        </button>
      </div>
    </div>
  );
}

/** mc's file-error dialog. Retry is first because it is the one that saves the
 *  operation; Abort is last because it ends it. */
function Failure({ path, message }: { path: string; message: string }) {
  const answer = (a: Answer) => () => fileops.answerQuestion(a);
  return (
    <div class="ask" t="error-question">
      <p>
        <strong>{basename(path)}</strong>: {message}
      </p>
      <div class="ask-buttons">
        <button type="button" t="err-retry" onClick={answer("retry")}>
          Retry
        </button>
        <button type="button" t="err-skip" onClick={answer("skip")}>
          Skip
        </button>
        <button type="button" t="err-skipall" onClick={answer("skipAll")}>
          Ignore all
        </button>
        <button type="button" t="err-abort" onClick={answer("cancel")}>
          Abort
        </button>
      </div>
    </div>
  );
}

function Question({ job }: { job: Job }) {
  const q = job.question!;
  if (q.kind === "recursive") return <Recursive path={q.dst} />;
  if (q.kind === "error") {
    return <Failure path={q.dst} message={q.message} />;
  }
  const c = q;
  const when = (t: number) => (t > 0 ? formatTime(t) : "—");
  const answer = (a: Answer) => () => fileops.answerQuestion(a);

  return (
    <div class="ask" t="overwrite-question">
      <p>
        <strong>{basename(c.dst)}</strong> already exists.
      </p>

      {
        /* Both files, as mc shows them: the answer below is a judgement about
          these two numbers, and hiding them makes it a guess. */
      }
      <table class="ask-facts">
        <tr>
          <td>New</td>
          <td class="num">{groupDigits(c.srcSize)}</td>
          <td>{when(c.srcTime)}</td>
        </tr>
        <tr>
          <td>Existing</td>
          <td class="num">{groupDigits(c.dstSize)}</td>
          <td>{when(c.dstTime)}</td>
        </tr>
      </table>

      <p class="ask-heading">Overwrite this file?</p>
      <div class="ask-buttons">
        <button type="button" t="ow-yes" onClick={answer("overwrite")}>
          Overwrite
        </button>
        <button type="button" t="ow-skip" onClick={answer("skip")}>Skip</button>
        {c.canAppend && (
          <button type="button" t="ow-append" onClick={answer("append")}>
            Append
          </button>
        )}
        {c.canReget && (
          <button type="button" t="ow-reget" onClick={answer("reget")}>
            Reget
          </button>
        )}
      </div>

      <p class="ask-heading">Overwrite all files?</p>
      <label class="ask-guard">
        <input
          type="checkbox"
          t="ow-zero"
          checked={job.zeroGuard}
          onChange={(e: Event) =>
            fileops.setZeroGuard((e.target as HTMLInputElement).checked)}
        />
        Don't overwrite with a zero length file
      </label>
      <div class="ask-buttons">
        <button type="button" t="ow-all" onClick={answer("overwriteAll")}>
          All
        </button>
        <button type="button" t="ow-older" onClick={answer("older")}>
          Older
        </button>
        <button type="button" t="ow-none" onClick={answer("skipAll")}>
          None
        </button>
        <button type="button" t="ow-smaller" onClick={answer("smaller")}>
          Smaller
        </button>
        <button type="button" t="ow-size" onClick={answer("sizeDiffers")}>
          Size differs
        </button>
      </div>

      <div class="ask-buttons">
        <button type="button" t="ow-cancel" onClick={answer("cancel")}>
          Abort
        </button>
      </div>
    </div>
  );
}

export function Progress() {
  const job = fileops.frontJob();
  if (!job) return null;
  const pct = fileops.percentOf()(job);
  // Bytes when there are bytes, files for a delete — the same pair `percent`
  // works from, so the bar and the estimate can never tell different stories.
  const byBytes = job.totalBytes > 0;
  const eta = formatEta(
    byBytes ? job.doneBytes : job.doneFiles,
    byBytes ? job.totalBytes : job.totalFiles,
    Date.now() - job.startedAt,
  );

  return (
    <div class="modal-scrim">
      <div class="modal progress" t="progress">
        <h2>{VERB[job.kind]}</h2>

        <div class="prog-file" title={job.current}>
          {basename(job.current)}
        </div>

        <div class="prog-track">
          <div class="prog-bar" style={{ width: `${pct.toFixed(1)}%` }} />
        </div>

        <div class="prog-stats">
          <span>{job.doneFiles} / {job.totalFiles} files</span>
          {job.totalBytes > 0 && (
            <span>
              {humanSize(job.doneBytes)} / {humanSize(job.totalBytes)}
            </span>
          )}
          <span>{pct.toFixed(0)}%</span>
          {eta && <span t="prog-eta">{eta}</span>}
        </div>

        {job.question && <Question job={job} />}

        <div class="modal-buttons">
          {
            /* Backgrounding is what makes a long copy bearable: the work goes
              on, the panels come back, and C-x j brings this dialog back. */
          }
          <button
            type="button"
            t="op-background"
            onClick={() => fileops.background()}
          >
            Background
          </button>
          <button type="button" t="op-cancel" onClick={() => fileops.cancel()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
