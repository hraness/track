/**
 * The TUI's history wiring (design §3.2, §4.3, §10): one `HistoryHandle`
 * for the pane (agent host, process sink), the `ContextSource` adapter and
 * the `/comment`, `/comments`, `/history` handlers. main.ts calls
 * `wireHistory` once with getters for its state and routes typed history
 * commands through `runHistoryLine`.
 *
 * Every function here is total: a missing or read-only database turns the
 * handle into a no-op and the commands into one warning line.
 */
import { newId } from "../../core/ids.ts";
import type { TrackScore } from "../../core/score.ts";
import { barStartTick } from "../../core/tempo.ts";
import {
  parseHistoryCommand,
  type HistoryCommand,
} from "../commands/comment.ts";
import type { PresenceEntry } from "../session/protocol.ts";
import {
  commentAppend,
  commentsFilter,
  resolveCommentRef,
  writeComment,
  type CommentAuthor,
} from "./comments.ts";
import { captureContext, contextLabel, type ContextSource } from "./context.ts";
import type { HistoryDb } from "./db.ts";
import { parseHistoryFilterWords } from "./filter.ts";
import { formatDetail, formatHistoryLine } from "./format.ts";
import { noopHistoryHandle } from "./noop.ts";
import { openHistory } from "./open.ts";
import { setHistorySink } from "./sink.ts";
import type { CommentContext, HistoryHandle, HistoryRow } from "./types.ts";

/** What the pane knows right now; every getter is cheap and pure. */
export type HistoryHost = Readonly<{
  workspace: string;
  sessionId(): string;
  revision(): number;
  score(): TrackScore;
  clientId(): string | undefined;
  actorId(): string | undefined;
  /** This pane's presence entry (letter, screen, param, focus). */
  presence(): PresenceEntry | undefined;
  /** The focused track id (also when no daemon reports presence). */
  focusedTrack(): string | undefined;
  /** Score beat under the playhead, or undefined before any play. */
  playheadBeat(): number | undefined;
  playing(): boolean;
  focusedParam(): string | undefined;
  patchNode(): string | undefined;
  /** The open screen (`home`, `sound`, `patch`…). */
  screen(): string;
  ascii(): boolean;
}>;

/** The loop range in score beats, from the score's `loop` bars. */
export function loopBeats(
  score: TrackScore,
): { from: number; to: number } | undefined {
  const loop = score.loop;
  if (!loop || loop.bars <= 0) return undefined;
  try {
    return {
      from: barStartTick(score, loop.startBar) / score.ticksPerBeat,
      to: barStartTick(score, loop.startBar + loop.bars) / score.ticksPerBeat,
    };
  } catch {
    return undefined;
  }
}

/** The adapter design §3.2 asks main.ts for. */
export function contextSource(host: HistoryHost): ContextSource {
  const own = host.presence();
  const presence: PresenceEntry | undefined = {
    clientId: own?.clientId ?? host.clientId() ?? "local",
    pid: own?.pid ?? process.pid,
    label: own?.label ?? "",
    ...own,
    focusedTrackId: host.focusedTrack() ?? own?.focusedTrackId ?? null,
    screen: host.screen(),
    ...(host.focusedParam() !== undefined
      ? { param: host.focusedParam() }
      : {}),
  };
  const score = host.score();
  return {
    presence,
    score,
    revision: host.revision(),
    playheadBeat: host.playheadBeat(),
    loop: loopBeats(score),
    selection: undefined,
    focusedParam: host.focusedParam(),
    patchNode: host.patchNode(),
    transport: {
      playing: host.playing(),
      recording: own?.recording !== undefined,
    },
  };
}

function author(host: HistoryHost): CommentAuthor {
  const own = host.presence();
  const clientId = host.clientId();
  const actorId = host.actorId();
  return {
    kind: "human",
    ...(actorId !== undefined ? { actorId } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(own?.pane !== undefined ? { pane: own.pane } : {}),
  };
}

export type Wired = Readonly<{
  handle: HistoryHandle;
  /** The database, when one opened writable. */
  db(): HistoryDb | undefined;
}>;

/**
 * Builds the pane's handle and installs it as the process sink. Appends
 * go straight to the workspace database (the daemon socket path of design
 * §3.6 is not used yet; see the PR notes). The id is assigned here so a
 * caller can point `parentId` at a row before it is written.
 */
export function wireHistory(host: HistoryHost): Wired {
  const db = (): HistoryDb | undefined => {
    const open = openHistory(host.workspace);
    return open && !open.readonly ? open : undefined;
  };
  const context = (): CommentContext => captureContext(contextSource(host));
  if (db() === undefined) {
    const noop = noopHistoryHandle(host.revision());
    const handle: HistoryHandle = { ...noop, context };
    setHistorySink(handle);
    return { handle, db };
  }
  const handle: HistoryHandle = Object.freeze({
    append(event) {
      const id = event.id ?? newId("ev");
      const target = db();
      if (target === undefined) return { id, done: Promise.resolve(undefined) };
      try {
        const row = target.append({
          ...event,
          id,
          sessionId: host.sessionId(),
          atRev: host.revision(),
        });
        return { id, done: Promise.resolve(row) };
      } catch {
        return { id, done: Promise.resolve(undefined) };
      }
    },
    query(filter) {
      const target = openHistory(host.workspace);
      if (target === undefined) return { rows: [] };
      try {
        return target.query({ sessionId: host.sessionId(), ...filter });
      } catch {
        return { rows: [] };
      }
    },
    context,
  });
  setHistorySink(handle);
  return { handle, db };
}

/** What a history command asks the pane to do. */
export type HistoryReply =
  | { tone: "ok" | "warn" | "fail"; text: string }
  | {
      tone: "ok";
      text: string;
      view: { title: string; lines: readonly string[] };
    }
  | {
      tone: "ok";
      text: string;
      picker: {
        title: string;
        items: readonly { label: string; value: string; detail?: string }[];
        index: number;
      };
    }
  | {
      tone: "ok" | "warn";
      text: string;
      jump: { beat?: number; trackId?: string };
    };

const NO_HISTORY = "history is off · DAWG_HISTORY=off or no .dawg/history.db";

function trackResolver(score: TrackScore) {
  return (word: string): string | undefined => {
    const lower = word.toLowerCase();
    return (
      score.tracks.find((track) => track.id === word)?.id ??
      score.tracks.find((track) => track.id.toLowerCase() === lower)?.id ??
      score.tracks.find((track) => track.name.toLowerCase() === lower)?.id
    );
  };
}

function trackNamer(score: TrackScore) {
  return (id: string): string | undefined =>
    score.tracks.find((track) => track.id === id)?.name;
}

/** Where a row points: its context playhead or loop, else its first bar. */
export function rowLocator(
  row: HistoryRow,
  score: TrackScore,
): { beat?: number; trackId?: string } {
  const out: { beat?: number; trackId?: string } = {};
  const context = row.context;
  if (context?.loop !== undefined) out.beat = context.loop.fromBeat;
  else if (context?.playhead !== undefined) out.beat = context.playhead.beat;
  else {
    const bars = row.targets.find((target) => target.type === "bars");
    const first = bars ? Number(bars.key.split("-")[0]) : NaN;
    if (Number.isSafeInteger(first) && first >= 1) {
      try {
        out.beat = barStartTick(score, first - 1) / score.ticksPerBeat;
      } catch {
        // A bar past the score's end: no seek.
      }
    }
  }
  const track =
    context?.focus?.trackId ??
    row.targets.find((target) => target.type === "track")?.key;
  if (track !== undefined && score.tracks.some((each) => each.id === track))
    out.trackId = track;
  return out;
}

/**
 * Runs a typed `/comment`, `/comments` or `/history` line; undefined when
 * the line is none of them.
 */
export function runHistoryLine(
  line: string,
  host: HistoryHost,
  wired: Wired,
  width: number,
): HistoryReply | undefined {
  const command = parseHistoryCommand(line);
  if (command === undefined) return undefined;
  return runHistory(command, host, wired, width);
}

export function runHistory(
  command: HistoryCommand,
  host: HistoryHost,
  wired: Wired,
  width: number,
): HistoryReply {
  if (command.type === "comment" && "error" in command)
    return { tone: "fail", text: command.error };
  const db =
    command.type === "comment" ? wired.db() : openHistory(host.workspace);
  if (db === undefined) return { tone: "warn", text: NO_HISTORY };
  const score = host.score();
  const sessionId = host.sessionId();
  const ascii = host.ascii();
  const namer = trackNamer(score);
  switch (command.type) {
    case "comment": {
      const who = author(host);
      const ref = resolveCommentRef(db, sessionId, command.comment.ref, who);
      if ("error" in ref) return { tone: "fail", text: ref.error };
      const context = wired.handle.context();
      let row: HistoryRow;
      try {
        row = writeComment(
          db,
          commentAppend(sessionId, command.comment, who, context, ref.row, {
            beatsPerBar: score.beatsPerBar,
          }),
        );
      } catch (error) {
        return {
          tone: "fail",
          text: `comment not saved · ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const where = contextLabel(row.context);
      const about =
        ref.row?.rev != null
          ? ` · about rev ${ref.row.rev}`
          : ref.row !== undefined
            ? ` · about #${ref.row.seq}`
            : "";
      return {
        tone: "ok",
        text: `${ascii ? "*" : "✎"} commented #${row.seq}${where ? ` · ${where}` : ""}${about}`,
      };
    }
    case "comments": {
      const own = host.presence();
      const built = commentsFilter(
        command.words,
        trackResolver(score),
        host.clientId() ?? own?.pane,
      );
      if ("error" in built) return { tone: "fail", text: built.error };
      const rows = db.query({ sessionId, ...built.filter }).rows;
      if (rows.length === 0)
        return { tone: "warn", text: "no comments yet · /comment <text>" };
      const lines = [...rows].reverse().map((row) =>
        formatHistoryLine(row, Math.max(20, width - 8), {
          ascii,
          trackName: namer,
        }),
      );
      return {
        tone: "ok",
        text: `${rows.length} comment${rows.length === 1 ? "" : "s"}`,
        view: {
          title: "comments · newest last · /comment adds one",
          lines,
        },
      };
    }
    case "history": {
      const built = parseHistoryFilterWords(command.words, score, sessionId);
      if ("error" in built)
        return {
          tone: "fail",
          text: `${built.error} · /history [track bass] [comments] [#tag] [bars 9-16]`,
        };
      const rows = db.query({ limit: 64, ...built.filter, sessionId }).rows;
      if (rows.length === 0)
        return {
          tone: "warn",
          text:
            command.words.length > 0
              ? "no history matches · /history"
              : "no history yet",
        };
      const ordered = [...rows].reverse();
      return {
        tone: "ok",
        text: `history · ${rows.length} row${rows.length === 1 ? "" : "s"} · enter jumps`,
        picker: {
          title: `history${command.words.length > 0 ? ` · ${command.words.join(" ")}` : ""} · newest last`,
          items: ordered.map((row) => ({
            label: formatHistoryLine(row, Math.max(20, width - 10), {
              ascii,
              trackName: namer,
            }),
            value: `/history jump ${row.seq}`,
          })),
          index: ordered.length - 1,
        },
      };
    }
    case "history-jump": {
      const row = db.get(command.seq);
      if (row === undefined || row.sessionId !== sessionId)
        return { tone: "fail", text: `no history row #${command.seq}` };
      const jump = rowLocator(row, score);
      const detail = formatDetail(row, { ascii, trackName: namer })
        .split("\n")[0]!
        .replace(/\s+/g, " ")
        .trim();
      return {
        tone:
          jump.beat === undefined && jump.trackId === undefined ? "warn" : "ok",
        text: detail.slice(0, Math.max(20, width - 4)),
        jump,
      };
    }
  }
}
