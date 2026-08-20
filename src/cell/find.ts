// Find file (M-?) — mc's find dialog, including the part that matters: the
// results are a list you can walk, and Enter takes the panel there.
import { cell, type MethodDraftMeta } from "aio";
import { panels } from "./panels.ts";
import { ui } from "./ui.ts";
import { dirname } from "../lib/path.ts";
import type { Hit } from "./find.server.ts";

type FindState = {
  visible: boolean;
  root: string;
  mask: string;
  content: string;
  /** mc's switches, each one persisted: a search you have to re-configure
   *  every time is a search you configure wrong. */
  caseInsensitive: boolean;
  contentCaseInsensitive: boolean;
  skipHidden: boolean;
  recursive: boolean;
  followSymlinks: boolean;
  wholeWords: boolean;
  firstHit: boolean;
  running: boolean;
  /** The directory currently being walked — the only honest progress a
   *  filesystem search can report. */
  scanning: string;
  hits: Hit[];
  cursor: number;
  truncated: boolean;
};

const LIMIT = 5000;

export const find = cell("find", {
  // The QUERY is worth keeping between sessions; the results are not.
  persist: {
    exclude: ["visible", "running", "scanning", "hits", "cursor", "truncated"],
  },
  cancelOn: { start: ["self", "find:stop"] },

  state: {
    visible: false,
    root: "",
    mask: "*",
    content: "",
    caseInsensitive: true,
    contentCaseInsensitive: true,
    skipHidden: true,
    recursive: true,
    followSymlinks: false,
    wholeWords: false,
    firstHit: false,
    running: false,
    scanning: "",
    hits: [] as Hit[],
    cursor: 0,
    truncated: false,
  },

  methods: {
    /** Open the dialog, defaulting the root to the active panel. */
    show(s: FindState, root: string) {
      s.visible = true;
      s.root = root;
      s.hits = [];
      s.cursor = 0;
      s.truncated = false;
    },

    hide(s: FindState) {
      s.visible = false;
    },

    setQuery(s: FindState, mask: string, content: string) {
      s.mask = mask;
      s.content = content;
    },

    /** Flip one of the dialog's switches by name — the UI knows the label, the
     *  cell knows the field, and this is the one place the two meet. */
    setOption(s: FindState, name: string, on: boolean) {
      switch (name) {
        case "recursive":
          s.recursive = on;
          break;
        case "followSymlinks":
          s.followSymlinks = on;
          break;
        case "skipHidden":
          s.skipHidden = on;
          break;
        case "nameCase":
          s.caseInsensitive = !on;
          break;
        case "contentCase":
          s.contentCaseInsensitive = !on;
          break;
        case "wholeWords":
          s.wholeWords = on;
          break;
        case "firstHit":
          s.firstHit = on;
          break;
      }
    },

    /** Where the search starts — mc's "Start at", which is a field rather than
     *  wherever the panel happened to be. */
    setRoot(s: FindState, root: string) {
      s.root = root;
    },

    async start(
      s: FindState & Partial<MethodDraftMeta>,
      root: string,
      mask: string,
      content: string,
    ) {
      const io = await import("./find.server.ts");
      if (s.$signal!.aborted) return;

      Object.assign(s, {
        root,
        mask: mask || "*",
        content,
        hits: [],
        cursor: 0,
        running: true,
        truncated: false,
        scanning: root,
        visible: true,
      });

      // Batched the same way the shell batches output: a search that finds
      // 5000 files must not broadcast 5000 times.
      let pending: Hit[] = [];
      const flush = () => {
        if (pending.length === 0) return;
        s.hits = [...s.hits, ...pending];
        pending = [];
      };
      const timer = setInterval(flush, 100);

      try {
        const n = await io.find(
          {
            root,
            mask: mask || "*",
            content,
            caseInsensitive: s.caseInsensitive,
            contentCaseInsensitive: s.contentCaseInsensitive,
            skipHidden: s.skipHidden,
            recursive: s.recursive,
            followSymlinks: s.followSymlinks,
            wholeWords: s.wholeWords,
            firstHit: s.firstHit,
            limit: LIMIT,
          },
          (h) => pending.push(h),
          (dir) => {
            s.scanning = dir;
          },
          s.$signal!,
        );
        s.truncated = n >= LIMIT;
      } finally {
        clearInterval(timer);
        flush();
        s.running = false;
        s.scanning = "";
      }

      ui.say(
        s.hits.length === 0
          ? `Nothing matched ${mask || "*"}`
          : `${s.hits.length}${s.truncated ? "+" : ""} found`,
      );
    },

    stop(s: FindState) {
      s.running = false;
    },

    move(s: FindState, delta: number) {
      if (s.hits.length === 0) return;
      s.cursor = Math.max(0, Math.min(s.hits.length - 1, s.cursor + delta));
    },

    setCursor(s: FindState, i: number) {
      s.cursor = Math.max(0, Math.min(Math.max(0, s.hits.length - 1), i));
    },

    /** Enter: take the active panel to the hit and put the cursor on it. */
    async goto(s: FindState, index?: number) {
      const hit = s.hits[index ?? s.cursor];
      if (!hit) return;
      s.visible = false;
      const dir = dirname(hit.path);
      // Read the active side ONCE, before any await: after the first one the
      // panel may have changed under us, and the two calls would disagree.
      const side = panels.active;
      await panels.chdir(side, dir);
      await panels.reload(side, dir, hit.path.slice(dir.length + 1));
    },

    /** mc's "Panelize": put the results into the panel as if they were a
     *  directory. The one feature that turns a search into a workflow. */
    async panelize(s: FindState) {
      if (s.hits.length === 0) return void ui.say("Nothing to panelize");
      s.visible = false;
      await panels.panelize(
        panels.active,
        s.hits.map((h) => h.path),
        `find:${s.mask}`,
      );
    },
  },
});
