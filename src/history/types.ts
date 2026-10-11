/**
 * Session history: the stable types every lane shares (design §2.4, §9).
 *
 * `.dawg/history.db` is the canonical, unbounded, append-only log of a
 * project's sessions: score edits (mirrored from the JSON session records),
 * undo/redo, comments, focus snapshots, agent tool calls and turns, dev logs
 * and written audio assets. These types are the contract; the DB, the CLI
 * and the TUI view build on them.
 */
import type { Rewind } from "../session/delta.ts";

export { newId } from "../../core/ids.ts";

/** Who made a history row. */
export type ActorKind = "human" | "agent" | "subagent" | "external" | "system";

export const ACTOR_KINDS: readonly ActorKind[] = Object.freeze([
  "human",
  "agent",
  "subagent",
  "external",
  "system",
]);

/** The `kind` column (design §2.3). */
export type HistoryKind =
  | "edit"
  | "undo"
  | "redo"
  | "comment"
  | "focus"
  | "transport"
  | "tool"
  | "turn"
  | "log"
  | "asset";

export const HISTORY_KINDS: readonly HistoryKind[] = Object.freeze([
  "edit",
  "undo",
  "redo",
  "comment",
  "focus",
  "transport",
  "tool",
  "turn",
  "log",
  "asset",
]);

/** What a row is about, so queries can filter by track, instrument, param… */
export type TargetRef = Readonly<{
  type:
    | "track"
    | "instrument"
    | "effect"
    | "node"
    | "param"
    | "bars"
    | "file"
    | "sample";
  key: string;
  trackId?: string;
  barFrom?: number;
  barTo?: number;
}>;

/**
 * What a pane was looking at and listening to when a row was made: captured
 * for every comment (and focus snapshot) by `captureContext`.
 */
export type CommentContext = Readonly<{
  /** Pane letter. */
  pane?: string;
  clientId?: string;
  view?: Readonly<{
    screen?: string;
    param?: string;
    pinned?: boolean;
    follow?: string;
  }>;
  focus?: Readonly<{
    trackId?: string;
    trackName?: string;
    /** The focused track's instrument kind. */
    instrument?: string;
    /** Drawer param or selected knob path. */
    param?: string;
    /** Patch node id when the patch screen is open. */
    node?: string;
  }>;
  /** `label` is `bar.beat`, e.g. "12.3". */
  playhead?: Readonly<{
    beat: number;
    bar: number;
    beatInBar: number;
    label: string;
  }>;
  /** `label` e.g. "9.1–17.1". */
  loop?: Readonly<{ fromBeat: number; toBeat: number; label: string }>;
  selection?: Readonly<{
    trackId: string;
    fromBeat: number;
    toBeat: number;
    notes?: number;
  }>;
  transport?: Readonly<{ playing: boolean; recording: boolean; bpm: number }>;
  /** Score revision current when captured. */
  rev: number;
}>;

export type HistoryActor = Readonly<{
  kind: ActorKind;
  actorId?: string;
  clientId?: string;
  paneKey?: string;
  pane?: string;
}>;

export type HistoryRow = Readonly<{
  seq: number;
  id: string;
  sessionId: string;
  rev: number | null;
  score: boolean;
  atRev: number;
  lamport: number;
  replicaId: string;
  origin: "local" | "imported";
  parentId: string | null;
  kind: HistoryKind;
  sub: string | null;
  actor: HistoryActor;
  at: string;
  summary: string;
  body?: string;
  ops?: unknown[];
  context?: CommentContext;
  payload?: unknown;
  targets: readonly TargetRef[];
  tags: readonly string[];
  file?: string;
}>;

/** One row to append; lamport, seq and replica_id are always assigned by the DB. */
export type HistoryAppend = Readonly<{
  /** Default `newId("ev")`. */
  id?: string;
  sessionId: string;
  kind: HistoryKind;
  sub?: string;
  rev?: number;
  atRev: number;
  parentId?: string;
  actor: HistoryRow["actor"];
  at?: string;
  summary: string;
  body?: string;
  ops?: readonly unknown[];
  inverse?: readonly unknown[];
  rewind?: Rewind;
  context?: CommentContext;
  payload?: unknown;
  /** Default: derived from ops/rewind for edits, from context for comments. */
  targets?: readonly TargetRef[];
  tags?: readonly string[];
  /** Import path only: rows mirrored from an existing record. */
  origin?: "local" | "imported";
  /** Score-changing flag; default derived (edits with a non-identity rewind or ops). */
  score?: boolean;
}>;

export type HistoryFilter = Readonly<{
  /** Default current; "*" = all sessions. */
  sessionId?: string;
  kinds?: readonly HistoryKind[];
  actors?: readonly ActorKind[];
  /** Track id (callers resolve names against the score first). */
  track?: string;
  instrument?: string;
  effect?: string;
  node?: string;
  /** Param path, e.g. "volume", "synth.cutoff", "fx.reverb.mix" (prefix match). */
  param?: string;
  bars?: readonly [number, number];
  /** Letter, pane_key or clientId. */
  pane?: string;
  tag?: string;
  /** FTS5 query over summary+body (LIKE fallback without FTS5). */
  grep?: string;
  /** Exclusive. */
  sinceSeq?: number;
  /** ISO timestamp (callers parse relative forms like "10m"). */
  sinceAt?: string;
  rev?: number | readonly [number, number];
  /** Paging cursor: rows with seq below this (newest-first) or above it (asc). */
  beforeSeq?: number;
  /** Default 20, max 500. */
  limit?: number;
  /** Default desc. */
  order?: "desc" | "asc";
  /** Event id or id prefix (>= 6 chars), parent id. */
  parentId?: string;
}>;

export type HistoryPage = Readonly<{
  rows: readonly HistoryRow[];
  /** Pass as `beforeSeq` for the next page; absent on the last page. */
  next?: number;
  total?: number;
}>;

/** What one append through a handle returns. */
export type HistoryAppended = {
  id: string;
  done: Promise<HistoryRow | undefined>;
};

/**
 * What lanes hold. `append` is async (in daemon mode it may go over the
 * socket); the id is assigned client-side and returned at once so callers
 * can set `parentId` without waiting.
 */
export type HistoryHandle = Readonly<{
  append(e: Omit<HistoryAppend, "sessionId" | "atRev">): HistoryAppended;
  /** Sync, read-only. */
  query(f: HistoryFilter): HistoryPage;
  context(): CommentContext;
}>;
