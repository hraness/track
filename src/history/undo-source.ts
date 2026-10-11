/**
 * Where undo and redo read their events from (design §2.6). The undo
 * engine (`src/commands/history.ts`) is unchanged; this module serves it a
 * longer window: the DB's rows for this session (and its fork ancestors)
 * joined with the JSON record's events by revision, cut at the first gap so
 * a gapped list never reaches the engine. Rewinds load lazily from the DB,
 * so a deep window costs only the rewinds undo actually walks.
 *
 * Without a DB it returns `historyEvents(workspace, record)`, the record
 * path, exactly as before.
 */
import type { HistoryEvent } from "../commands/history.ts";
import { historyEvents } from "../session/attach.ts";
import type { Rewind } from "../session/delta.ts";
import type { SessionEvent, SessionRecord } from "../session/store.ts";
import type { HistoryDb, UndoMeta } from "./db.ts";
import { isHistoryDirty, reconcileHistory } from "./record.ts";

const IDENTITY: Rewind = Object.freeze({ obj: {} }) as Rewind;
const PAGE = 64;
const MAX_DEPTH = 8;

type Segment = HistoryEvent[];

function fromRecord(event: SessionEvent): HistoryEvent {
  return {
    revision: event.revision,
    kind: event.kind,
    rewind: event.rewind,
    payload: event.payload,
    actor:
      event.actor?.clientId !== undefined
        ? { clientId: event.actor.clientId }
        : undefined,
  };
}

/** Rewinds for DB rows, fetched in pages from the newest row down. */
class LazyRewinds {
  private readonly cache = new Map<string, Rewind | null>();
  public constructor(
    private readonly db: HistoryDb,
    private readonly order: readonly string[],
  ) {}

  public get(id: string): Rewind | undefined {
    if (!this.cache.has(id)) this.load(id);
    return this.cache.get(id) ?? undefined;
  }

  private load(id: string): void {
    const at = this.order.indexOf(id);
    const from = Math.max(0, at - PAGE + 1);
    const ids = this.order
      .slice(from, at + 1)
      .filter((each) => !this.cache.has(each));
    if (!ids.includes(id)) ids.push(id);
    const found = this.db.rewinds(ids);
    for (const each of ids) this.cache.set(each, found.get(each) ?? null);
  }
}

function fromMeta(meta: UndoMeta, rewinds: LazyRewinds): HistoryEvent {
  const kind = meta.sub.length > 0 ? meta.sub : "score.edit";
  const event: Record<string, unknown> = {
    revision: meta.rev,
    kind,
    payload: meta.payload,
    actor:
      meta.clientId !== undefined ? { clientId: meta.clientId } : undefined,
  };
  Object.defineProperty(event, "rewind", {
    enumerable: true,
    get(): Rewind | undefined {
      if (!meta.hasRewind) return undefined;
      if (meta.identity) return IDENTITY;
      return rewinds.get(meta.id);
    },
  });
  return event as HistoryEvent;
}

/** The contiguous run of `events` (sorted by revision) ending at `top`. */
function contiguousTo(events: Segment, top: number): Segment {
  let end = events.length - 1;
  while (end >= 0 && events[end]!.revision > top) end -= 1;
  if (end < 0 || events[end]!.revision !== top) return [];
  let start = end;
  while (
    start > 0 &&
    events[start - 1]!.revision === events[start]!.revision - 1
  )
    start -= 1;
  return events.slice(start, end + 1);
}

/**
 * One session's events up to `top`: the DB's rows, with the record's
 * events (which carry their own rewinds) taking precedence revision by
 * revision. A record event whose rewind was compacted away borrows the
 * DB's copy, so undo reaches past the record's byte cap.
 */
function segment(
  db: HistoryDb,
  sessionId: string,
  top: number,
  record: SessionRecord<unknown> | undefined,
): Segment {
  const metas = db
    .undoMeta(sessionId)
    .filter((meta) => meta.sessionId === sessionId && meta.rev <= top);
  const rewinds = new LazyRewinds(
    db,
    metas.map((meta) => meta.id),
  );
  const byRev = new Map<number, HistoryEvent>();
  const metaByRev = new Map<number, UndoMeta>();
  for (const meta of metas) {
    metaByRev.set(meta.rev, meta);
    byRev.set(meta.rev, fromMeta(meta, rewinds));
  }
  for (const event of record?.events ?? []) {
    if (event.revision > top) continue;
    const own = fromRecord(event);
    const meta = metaByRev.get(event.revision);
    // Compacted out of the record but kept in the DB: use the DB's row.
    if (own.rewind === undefined && meta?.hasRewind && meta.id === event.id)
      continue;
    byRev.set(event.revision, own);
  }
  const sorted = [...byRev.values()].sort((a, b) => a.revision - b.revision);
  return contiguousTo(sorted, top);
}

/**
 * The events undo and redo replay, oldest first: fork ancestors' prefixes,
 * then this session's events, contiguous by revision within each session.
 */
export async function undoEvents(
  db: HistoryDb | undefined,
  workspace: string,
  record: SessionRecord<unknown>,
): Promise<HistoryEvent[]> {
  if (db === undefined)
    return (await historyEvents(workspace, record)).map(fromRecord);
  try {
    if (isHistoryDirty(record.sessionId)) reconcileHistory(db, record);
    const own = segment(db, record.sessionId, record.revision, record);
    const recordLowest = record.events[0]?.revision ?? record.revision + 1;
    const ownLowest = own[0]?.revision ?? record.revision + 1;
    // The DB cannot see this session's whole log: keep the record path,
    // which is never shorter than what the record holds.
    if (record.events.length > 0 && ownLowest > recordLowest)
      return (await historyEvents(workspace, record)).map(fromRecord);
    const complete = own.length === 0 ? record.revision === 0 : ownLowest === 1;
    const fork = record.meta.forkOf;
    if (!complete || fork === undefined) return own;
    const chunks: Segment[] = [own];
    const seen = new Set([record.sessionId]);
    let parent: { sessionId: string; revision: number } | undefined = fork;
    for (let depth = 0; parent && depth < MAX_DEPTH; depth += 1) {
      if (seen.has(parent.sessionId)) break;
      seen.add(parent.sessionId);
      const prefix = segment(db, parent.sessionId, parent.revision, undefined);
      if (prefix.length === 0 && parent.revision > 0) {
        // The DB never saw this ancestor: the record path has the chain.
        const inherited = await historyEvents(workspace, record);
        const ancestors = inherited.slice(
          0,
          inherited.length - record.events.length,
        );
        if (depth === 0) return [...ancestors.map(fromRecord), ...own];
        break;
      }
      chunks.unshift(prefix);
      if (prefix.length > 0 && prefix[0]!.revision !== 1) break;
      const lineage = db.sessionLineage(parent.sessionId);
      parent =
        lineage?.forkOf !== undefined && lineage.forkRev !== undefined
          ? { sessionId: lineage.forkOf, revision: lineage.forkRev }
          : undefined;
    }
    return chunks.flat();
  } catch {
    return (await historyEvents(workspace, record)).map(fromRecord);
  }
}
