/**
 * The write path from the session store into history (design §2.5).
 *
 * `recordSessionEvent` is the `onCommitted` hook of `appendSessionEvent`:
 * it runs inside the session lock against the composition actually on disk,
 * so rows land in revision order across panes. `reconcileHistory` imports
 * whatever a record holds that the DB lacks (a crash between the JSON
 * commit and the DB insert, an older dawg build, a session never opened
 * with history); it is idempotent by event id.
 */
import { scoreFromJSON, type ScoreOperation } from "../../core/score.ts";
import { isIdentityRewind, rewindComposition } from "../session/delta.ts";
import { receiptParts } from "../session/receipt.ts";
import type { SessionEvent, SessionRecord } from "../session/store.ts";
import type { HistoryDb } from "./db.ts";
import { deriveTargets } from "./targets.ts";
import type { ActorKind, HistoryAppend, HistoryKind } from "./types.ts";

export type ReconcileReport = Readonly<{
  imported: number;
  skipped: number;
  foldedGap: number;
}>;

export type PaneStamp = { letter?: string; paneKey?: string };

/** Sessions whose last mirror failed: reconcile before trusting the DB. */
const dirty = new Set<string>();

export function isHistoryDirty(sessionId: string): boolean {
  return dirty.has(sessionId);
}

export function markHistoryDirty(sessionId: string): void {
  dirty.add(sessionId);
}

export function clearHistoryDirty(sessionId: string): void {
  dirty.delete(sessionId);
}

/** The history `kind` of a session event kind. */
export function historyKindOf(eventKind: string): HistoryKind {
  if (eventKind === "score.undo") return "undo";
  if (eventKind === "score.redo") return "redo";
  if (eventKind === "transport") return "transport";
  return "edit";
}

/** Who made a session event, from its kind and payload. */
export function actorKindOf(
  event: Pick<SessionEvent, "kind" | "payload">,
): ActorKind {
  const payload = isObj(event.payload) ? event.payload : {};
  if (typeof payload.subagent === "string") return "subagent";
  if (event.kind.startsWith("agent.")) return "agent";
  if (event.kind === "files.apply") return "external";
  if (event.kind === "score.fork" || event.kind === "session.migrate")
    return "system";
  return "human";
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function changedFiles(payload: unknown): string[] | undefined {
  if (!isObj(payload)) return undefined;
  const files = payload.files ?? payload.paths;
  if (!Array.isArray(files)) return undefined;
  return files
    .filter((file): file is string => typeof file === "string")
    .slice(0, 32);
}

/** One line for the row: the payload's own summary, else a musical receipt. */
function summarize(
  event: SessionEvent,
  kind: HistoryKind,
  before: unknown,
): string {
  const payload = isObj(event.payload) ? event.payload : {};
  if (kind === "undo" || kind === "redo") {
    const rev = payload.undoneRevision ?? payload.redoneRevision;
    const scope = payload.scope === "all" ? " all" : "";
    return `${kind}${scope}${typeof rev === "number" ? ` rev ${rev}` : ""}`;
  }
  if (kind === "transport") {
    const action =
      typeof payload.action === "string" ? payload.action : "transport";
    return action;
  }
  const own =
    typeof payload.summary === "string" && payload.summary.trim().length > 0
      ? payload.summary
      : undefined;
  if (own !== undefined) {
    const tool = typeof payload.tool === "string" ? `${payload.tool}: ` : "";
    return `${tool}${own}`;
  }
  if (event.ops !== undefined && event.ops.length > 0 && before !== undefined) {
    try {
      const parts = receiptParts(
        scoreFromJSON(before),
        event.ops as ScoreOperation[],
      );
      if (parts.length > 0) return parts.join(" · ");
    } catch {
      // fall through to the kind
    }
  }
  return event.kind;
}

/** The history row for one session event. */
export function sessionEventRow(
  sessionId: string,
  event: SessionEvent,
  before: unknown,
  after: unknown,
  origin: "local" | "imported",
  pane?: PaneStamp,
): HistoryAppend {
  const kind = historyKindOf(event.kind);
  const files = changedFiles(event.payload);
  const scoreChanging = kind === "edit" || kind === "undo" || kind === "redo";
  let targets: HistoryAppend["targets"] = [];
  if (scoreChanging) {
    try {
      targets = deriveTargets(
        event.ops,
        before,
        event.ops !== undefined && event.ops.length > 0 ? undefined : after,
        files,
      );
    } catch {
      targets = [];
    }
  }
  const identity = event.rewind === undefined || isIdentityRewind(event.rewind);
  return {
    id: event.id,
    sessionId,
    kind,
    sub: event.kind,
    rev: event.revision,
    atRev: event.revision,
    actor: {
      kind: actorKindOf(event),
      ...(event.actor?.actorId !== undefined
        ? { actorId: event.actor.actorId }
        : {}),
      ...(event.actor?.clientId !== undefined
        ? { clientId: event.actor.clientId }
        : {}),
      ...(pane?.paneKey !== undefined ? { paneKey: pane.paneKey } : {}),
      ...(pane?.letter !== undefined ? { pane: pane.letter } : {}),
    },
    at: event.at,
    summary: summarize(event, kind, before),
    ...(event.ops !== undefined ? { ops: event.ops } : {}),
    ...(event.rewind !== undefined ? { rewind: event.rewind } : {}),
    payload: event.payload,
    targets,
    origin,
    score: scoreChanging && (!identity || (event.ops?.length ?? 0) > 0),
  };
}

/**
 * Passed as `onCommitted` by both `appendSessionEvent` callers. Never
 * throws: a failure marks the session dirty so the next undo or idle tick
 * reconciles from the JSON record first.
 */
export function recordSessionEvent(
  db: HistoryDb,
  sessionId: string,
  event: SessionEvent,
  diskBefore: SessionRecord<unknown>,
  after: SessionRecord<unknown>,
  pane?: PaneStamp,
): void {
  try {
    if (db.readonly) return;
    db.append(
      sessionEventRow(
        sessionId,
        event,
        diskBefore.composition,
        after.composition,
        "local",
        pane,
      ),
    );
  } catch (error) {
    if (isDuplicate(error)) return;
    dirty.add(sessionId);
  }
}

function isDuplicate(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  );
}

/**
 * Imports every event of `record` the DB lacks, oldest first, with the
 * compositions recovered by walking rewinds back from the record's head.
 * Events the record folded away before the DB existed are counted in
 * `foldedGap`, never invented.
 */
export function reconcileHistory(
  db: HistoryDb,
  record: SessionRecord<unknown>,
): ReconcileReport {
  if (db.readonly)
    return { imported: 0, skipped: record.events.length, foldedGap: 0 };
  if (record.meta.forkOf !== undefined)
    db.recordSession(record.sessionId, record.meta.forkOf);
  else db.recordSession(record.sessionId);
  const have = db.revs(record.sessionId);
  const events = record.events;
  const missing: number[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (!have.has(event.revision) && !db.has(event.id)) missing.push(index);
  }
  const folded = record.folded ?? 0;
  const foldedGap =
    folded > 0 && !have.has(folded) && !have.has(1) ? folded : 0;
  if (missing.length === 0) {
    dirty.delete(record.sessionId);
    return { imported: 0, skipped: events.length, foldedGap };
  }
  // Compositions after each event, recovered newest first. Once a rewind is
  // missing the older compositions are unknown; targets then come from ops.
  const afterOf = new Map<number, unknown>();
  let composition: unknown = record.composition;
  let known = true;
  const oldestMissing = missing[0]!;
  for (let index = events.length - 1; index >= oldestMissing; index -= 1) {
    afterOf.set(index, known ? composition : undefined);
    if (!known) continue;
    const back = rewindComposition(composition, events, index);
    if (back === undefined) known = false;
    else composition = back;
  }
  const rows: HistoryAppend[] = missing.map((index) => {
    const event = events[index]!;
    const after = afterOf.get(index);
    const before = index > 0 ? afterOf.get(index - 1) : undefined;
    const beforeComposition =
      before !== undefined
        ? before
        : after !== undefined && event.rewind !== undefined
          ? rewindComposition(after, [event], 0)
          : undefined;
    return sessionEventRow(
      record.sessionId,
      event,
      beforeComposition,
      after,
      "imported",
    );
  });
  const imported = db.appendMany(rows);
  dirty.delete(record.sessionId);
  return {
    imported,
    skipped: events.length - imported,
    foldedGap,
  };
}
