import { mkdir, readFile } from "node:fs/promises";
import { durableWrite } from "../fs/durable.ts";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireSessionLock } from "./lock.ts";
import { diffRewind, parseRewind, type Rewind } from "./delta.ts";
import {
  applyMetaPatch,
  defaultSessionMeta,
  metaMatches,
  MetaValidationError,
  normalizeSessionName,
  parseSessionMeta,
  type MetaExpect,
  type MetaPatch,
  type SessionMeta,
} from "./meta.ts";

/** Caller payloads; the store keeps history separately in each event's `rewind`. */
const MAX_EVENT_BYTES = 64 * 1024;
/** A rewind larger than this (a wholesale import) is not kept; the edit still lands. */
const MAX_REWIND_BYTES = 1024 * 1024;
const MAX_EVENTS = 2_000;
/**
 * When the log is full, this many of the oldest events are folded away so a
 * long session keeps accepting edits. The composition is the checkpoint;
 * undo still reaches back through the events that remain.
 */
const FOLD_BATCH = 200;
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 64;
const MAX_EVENT_KIND_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;

export class SessionValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SessionValidationError";
  }
}

/**
 * Who made an event. Stamped by the authority from the connection's hello,
 * never trusted from the intent: `actorId` is the person (absent for v1
 * clients and the file fallback), `clientId` the window, `seq` the
 * per-(actor, client) intent number used for retry dedupe.
 */
export type EventActor = {
  actorId?: string;
  clientId: string;
  seq?: number;
};

export type SessionEvent = {
  id: string;
  revision: number;
  /**
   * Opaque to the store: any bounded string is kept and passed through, so a
   * newer peer's event kinds survive an older reader.
   */
  kind: string;
  payload: unknown;
  at: string;
  actor?: EventActor;
  /**
   * The score operations this event applied: sent by an ops intent, or
   * derived by the authority from a composition intent. Folding `ops` from
   * the previous composition reproduces this one. Events without `ops` are
   * snapshots (too large to diff, or not expressible as operations).
   */
  ops?: unknown[];
  /**
   * How to recover the composition this event replaced from the one it
   * produced (see `delta.ts`). Absent once compacted away: the store drops
   * the oldest rewinds first when the record would exceed its size cap, so
   * an edit never fails because of history, and undo reaches as far back as
   * the remaining rewinds form a contiguous suffix.
   */
  rewind?: Rewind;
};

export type SessionRecord<T> = {
  sessionId: string;
  revision: number;
  updatedAt: string;
  composition: T;
  events: SessionEvent[];
  /**
   * Optional (0.7): how many of the oldest events were folded away when the
   * log filled up. `revision === (folded ?? 0) + events.length`, and
   * `events[i].revision === (folded ?? 0) + i + 1`. Absent on records that
   * never filled, so older records load and print unchanged.
   */
  folded?: number;
  /** Name and lineage. Versioned separately so renames keep the revision. */
  meta: SessionMeta;
};

export type SessionPaths = {
  root: string;
  pointer: string;
  record: string;
  lock: string;
};

export class SessionConflictError extends Error {
  public constructor() {
    super(
      "session changed in another dawg window; retry against the latest revision",
    );
    this.name = "SessionConflictError";
  }
}

/** Per-workspace state directory. */
export const STATE_DIR = ".dawg";

/** The workspace state directory, `<workspace>/.dawg`. */
export function stateDir(workspace = process.cwd()): string {
  return join(workspace, STATE_DIR);
}

export function sessionPaths(
  workspace = process.cwd(),
  sessionId: string,
): SessionPaths {
  assertSessionId(sessionId);
  const root = stateDir(workspace);
  return {
    root,
    pointer: join(root, "session"),
    record: join(root, "sessions", `${sessionId}.json`),
    lock: join(root, "sessions", `${sessionId}.lock`),
  };
}

export async function readCurrentSessionId(
  workspace = process.cwd(),
): Promise<string | undefined> {
  try {
    const id = (
      await readFile(join(stateDir(workspace), "session"), "utf8")
    ).trim();
    if (id.length === 0) return undefined;
    assertSessionId(id);
    return id;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function ensureSession<T>(
  initial: T,
  options: {
    workspace?: string;
    sessionId?: string;
    setCurrent?: boolean;
    /** Name for a newly created session; ignored when it already exists. */
    name?: string;
  } = {},
): Promise<{ paths: SessionPaths; record: SessionRecord<T> }> {
  const workspace = options.workspace ?? process.cwd();
  const root = stateDir(workspace);
  await mkdir(root, { recursive: true });
  // Serialize pointer selection and first-record creation. Without this,
  // two windows launched together can each choose a different random session
  // and race to overwrite `.dawg/session`.
  const initLock = join(root, ".init.lock");
  const release = await acquireSessionLock(initLock);
  try {
    const sessionId =
      options.sessionId ??
      (await readCurrentSessionId(workspace)) ??
      randomUUID();
    const paths = sessionPaths(workspace, sessionId);
    await mkdir(dirname(paths.record), { recursive: true });
    const existing = await readRecordIfPresent<T>(paths.record);
    if (existing) {
      if (options.setCurrent !== false)
        await writeAtomic(paths.pointer, `${sessionId}`);
      return { paths, record: existing };
    }
    if (options.setCurrent !== false)
      await writeAtomic(paths.pointer, `${sessionId}`);
    try {
      const at = new Date().toISOString();
      const record: SessionRecord<T> = {
        sessionId,
        revision: 0,
        updatedAt: at,
        composition: initial,
        events: [],
        meta: defaultSessionMeta(
          at,
          options.name === undefined
            ? undefined
            : normalizeSessionName(options.name),
        ),
      };
      const validated = validateSessionRecord<T>(record);
      await writeAtomic(paths.record, JSON.stringify(validated));
      return { paths, record: validated };
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      // A concurrent external creator can win only if it does not use the
      // init lock. Read it and validate rather than replacing its record.
      const record = await readRecordIfPresent<T>(paths.record);
      if (!record) throw error;
      return { paths, record };
    }
  } finally {
    await release();
  }
}

export async function appendSessionEvent<T>(
  paths: SessionPaths,
  current: SessionRecord<T>,
  event: Omit<SessionEvent, "id" | "revision" | "at" | "rewind"> & {
    id?: string;
  },
  composition: T,
  /**
   * Runs after the atomic rename and before the lock is released, with the
   * appended event (its rewind uncompacted), the record that was on disk
   * and the one just written: session history mirrors edits here so rows
   * land in revision order across panes. Its errors are swallowed, never
   * rethrown: the edit has already committed.
   */
  onCommitted?: (
    event: SessionEvent,
    diskBefore: SessionRecord<unknown>,
    after: SessionRecord<unknown>,
  ) => void,
): Promise<SessionRecord<T>> {
  // dawgd passes the client's idempotency key as the durable event id so a
  // retried intent stays a no-op across daemon restarts.
  if (event.id !== undefined) assertSessionId(event.id);
  // History is the store's job: a `before` composition in the payload (the
  // pre-rewind convention) is dropped rather than persisted in full.
  const payload = stripBefore(event.payload);
  const payloadJson = stringifyJson(
    event.ops === undefined ? payload : [payload, event.ops],
    "session event payload",
  );
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  if (payloadBytes > MAX_EVENT_BYTES)
    throw new Error(`session event exceeds ${MAX_EVENT_BYTES} bytes`);
  if (
    typeof event.kind !== "string" ||
    event.kind.length === 0 ||
    event.kind.length > MAX_EVENT_KIND_LENGTH
  )
    throw new SessionValidationError("session event kind is invalid");
  stringifyJson(composition, "session composition");
  const release = await acquireSessionLock(paths.lock);
  try {
    const disk = await readRecord<T>(paths.record);
    if (disk.revision !== current.revision) throw new SessionConflictError();
    // A full log folds its oldest events away instead of refusing the edit.
    const fold = disk.events.length >= MAX_EVENTS ? FOLD_BATCH : 0;
    const folded = (disk.folded ?? 0) + fold;
    const revision = disk.revision + 1;
    const at = new Date().toISOString();
    const appended: SessionEvent = {
      kind: event.kind,
      payload,
      id: event.id ?? randomUUID(),
      revision,
      at,
    };
    if (event.actor !== undefined) appended.actor = { ...event.actor };
    if (event.ops !== undefined) appended.ops = [...event.ops];
    const rewind = diffRewind(disk.composition, composition);
    if (Buffer.byteLength(JSON.stringify(rewind), "utf8") <= MAX_REWIND_BYTES)
      appended.rewind = rewind;
    const next: SessionRecord<T> = {
      sessionId: disk.sessionId,
      revision,
      updatedAt: at,
      composition,
      events: [...disk.events.slice(fold), appended],
      ...(folded > 0 ? { folded } : {}),
      // Metadata always comes from disk so a rename written by another window
      // between this caller's read and its write is never reverted.
      meta: disk.meta,
    };
    const validated = validateSessionRecord<T>(next);
    const { record, json } = compactRecord(validated);
    await writeAtomic(paths.record, json);
    if (onCommitted) {
      try {
        onCommitted(
          appended,
          disk as SessionRecord<unknown>,
          record as SessionRecord<unknown>,
        );
      } catch {
        // The hook owns its reporting (history marks itself dirty and
        // reconciles from this record later); never fail a committed edit.
      }
    }
    return record;
  } finally {
    await release();
  }
}

/**
 * Keeps the record under its size cap by dropping the oldest events'
 * rewinds, oldest first, so the rewinds that remain are always the newest
 * contiguous run. The appended (last) event's rewind is dropped only when
 * nothing else is left to drop, so undo of the edit just made keeps working
 * whenever its rewind fits on its own. Only the composition and the bounded
 * payloads are irreducible; a record that still does not fit is rejected.
 */
function compactRecord<T>(record: SessionRecord<T>): {
  record: SessionRecord<T>;
  json: string;
} {
  let current = record;
  let json = JSON.stringify(current);
  let bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= MAX_RECORD_BYTES) return { record: current, json };
  const events = [...current.events];
  const last = events.length - 1;
  // Measured sizes let the loop strip exactly as many rewinds as needed with
  // one final stringify instead of one per batch.
  // The appended event comes last, after every older rewind is gone.
  for (let index = 0; index <= last && bytes > MAX_RECORD_BYTES; index += 1) {
    const event = events[index]!;
    if (event.rewind === undefined) continue;
    const { rewind, ...rest } = event;
    // `,"rewind":<json>` is what dropping the field saves.
    bytes -= Buffer.byteLength(JSON.stringify(rewind), "utf8") + 10;
    events[index] = rest;
  }
  current = { ...current, events };
  json = JSON.stringify(current);
  if (Buffer.byteLength(json, "utf8") > MAX_RECORD_BYTES)
    throw new SessionValidationError(
      `session record exceeds ${MAX_RECORD_BYTES} bytes`,
    );
  return { record: current, json };
}

function stripBefore(payload: unknown): unknown {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("before" in payload)
  )
    return payload;
  const { before: _before, ...rest } = payload as Record<string, unknown>;
  return rest;
}

export type MetaUpdate<T> =
  | { status: "applied"; record: SessionRecord<T> }
  | { status: "stale"; record: SessionRecord<T> };

/**
 * Conditional metadata write under the session lock. It applies only when
 * `expect` still matches the record on disk, so the latest user rename wins
 * and an in-flight auto-name computed against an older name is dropped.
 * The score revision and event log are untouched.
 */
export async function updateSessionMeta<T>(
  paths: SessionPaths,
  patch: MetaPatch,
  expect?: MetaExpect,
): Promise<MetaUpdate<T>> {
  const release = await acquireSessionLock(paths.lock);
  try {
    const disk = await readRecord<T>(paths.record);
    if (!metaMatches(disk.meta, expect))
      return { status: "stale", record: disk };
    const next: SessionRecord<T> = {
      ...disk,
      meta: applyMetaPatch(disk.meta, patch, new Date().toISOString()),
    };
    const validated = validateSessionRecord<T>(next);
    await writeAtomic(paths.record, JSON.stringify(validated));
    return { status: "applied", record: validated };
  } finally {
    await release();
  }
}

/**
 * Creates a new session holding a snapshot of `source` at its current
 * revision: the composition only, not the event log, with `forkOf` lineage.
 */
export async function createForkSession<T>(
  workspace: string,
  source: SessionRecord<T>,
  name: string,
): Promise<SessionRecord<T>> {
  const sessionId = randomUUID();
  const paths = sessionPaths(workspace, sessionId);
  await mkdir(dirname(paths.record), { recursive: true });
  const at = new Date().toISOString();
  const record = validateSessionRecord<T>({
    sessionId,
    revision: 0,
    updatedAt: at,
    composition: source.composition,
    events: [],
    meta: {
      ...defaultSessionMeta(at, normalizeSessionName(name)),
      nameSource: source.meta.nameSource,
      forkOf: { sessionId: source.sessionId, revision: source.revision },
    },
  });
  await writeAtomic(paths.record, JSON.stringify(record));
  return record;
}

/** Fork ancestry walked for undo, and the inherited event budget. */
export const MAX_FORK_DEPTH = 8;
export const MAX_INHERITED_EVENTS = MAX_EVENTS;

/**
 * The event log a fork inherits for undo: each ancestor's events up to the
 * revision it was forked at, oldest ancestor first, via the `forkOf` chain.
 * Nothing is copied at fork time; the parent prefix is append-only, so it is
 * immutable and safe to read later. Bounded by depth, by total events (the
 * oldest are dropped first) and by cycle detection. A missing, unreadable or
 * inconsistent ancestor (forked past its own revision) ends the chain there.
 */
export async function inheritedEvents(
  workspace: string,
  meta: SessionMeta,
  selfId: string,
): Promise<SessionEvent[]> {
  const chunks: SessionEvent[][] = [];
  const seen = new Set([selfId]);
  let fork = meta.forkOf;
  let total = 0;
  for (
    let depth = 0;
    fork && depth < MAX_FORK_DEPTH && total < MAX_INHERITED_EVENTS;
    depth += 1
  ) {
    if (seen.has(fork.sessionId)) break;
    seen.add(fork.sessionId);
    let parent: SessionRecord<unknown> | undefined;
    try {
      parent = await readRecordIfPresent<unknown>(
        sessionPaths(workspace, fork.sessionId).record,
      );
    } catch {
      break;
    }
    if (!parent || fork.revision > parent.revision) break;
    // Events folded out of the parent are gone; what remains still ends at
    // the fork point.
    const prefix = parent.events.slice(
      0,
      Math.max(0, fork.revision - (parent.folded ?? 0)),
    );
    chunks.unshift(prefix.slice(-(MAX_INHERITED_EVENTS - total)));
    total += prefix.length;
    fork = parent.meta.forkOf;
  }
  return chunks.flat().slice(-MAX_INHERITED_EVENTS);
}

/** Points `.dawg/session` at `sessionId` so plain `dawg` resumes it. */
export async function setCurrentSession(
  workspace: string,
  sessionId: string,
): Promise<void> {
  const paths = sessionPaths(workspace, sessionId);
  await mkdir(paths.root, { recursive: true });
  await writeAtomic(paths.pointer, sessionId);
}

export async function loadSession<T>(
  paths: SessionPaths,
): Promise<SessionRecord<T>> {
  return readRecord<T>(paths.record);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  if (Buffer.byteLength(contents, "utf8") > MAX_RECORD_BYTES)
    throw new SessionValidationError(
      `session record exceeds ${MAX_RECORD_BYTES} bytes`,
    );
  // Durable before it is visible: the data reaches the disk before the
  // rename publishes it, and the directory is synced so the rename survives
  // a power loss too.
  await durableWrite(path, `${contents}\n`, { mkdir: false });
}

async function readRecord<T>(path: string): Promise<SessionRecord<T>> {
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents, "utf8") > MAX_RECORD_BYTES)
    throw new SessionValidationError(
      `session record exceeds ${MAX_RECORD_BYTES} bytes`,
    );
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new SessionValidationError("session record contains invalid JSON");
  }
  return validateSessionRecord<T>(value);
}

async function readRecordIfPresent<T>(
  path: string,
): Promise<SessionRecord<T> | undefined> {
  try {
    return await readRecord<T>(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function validateSessionRecord<T>(value: unknown): SessionRecord<T> {
  if (typeof value !== "object" || value === null)
    throw new SessionValidationError("session record must be an object");
  const record = value as Record<string, unknown>;
  assertSessionId(record.sessionId);
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0)
    throw new SessionValidationError("session revision must be a safe integer");
  if (
    typeof record.updatedAt !== "string" ||
    record.updatedAt.length === 0 ||
    record.updatedAt.length > MAX_TIMESTAMP_LENGTH
  )
    throw new SessionValidationError("session updatedAt is invalid");
  if (!Array.isArray(record.events) || record.events.length > MAX_EVENTS)
    throw new SessionValidationError(
      `session has more than ${MAX_EVENTS} events`,
    );
  const folded = record.folded ?? 0;
  if (
    !Number.isSafeInteger(folded) ||
    (folded as number) < 0 ||
    (record.folded !== undefined && folded === 0)
  )
    throw new SessionValidationError("session folded count is invalid");
  const base = folded as number;
  if (record.revision !== base + record.events.length)
    throw new SessionValidationError(
      "session revision does not match its event log",
    );
  if (!("composition" in record))
    throw new SessionValidationError("session composition is missing");
  if (record.composition === undefined)
    throw new SessionValidationError("session composition is not JSON data");
  const events = record.events.map((event, index) => {
    if (typeof event !== "object" || event === null)
      throw new SessionValidationError("session event must be an object");
    const candidate = event as Record<string, unknown>;
    assertSessionId(candidate.id);
    if (
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision !== base + index + 1
    )
      throw new SessionValidationError("session event revisions are invalid");
    if (
      typeof candidate.kind !== "string" ||
      candidate.kind.length === 0 ||
      candidate.kind.length > MAX_EVENT_KIND_LENGTH
    )
      throw new SessionValidationError("session event kind is invalid");
    if (
      typeof candidate.at !== "string" ||
      candidate.at.length > MAX_TIMESTAMP_LENGTH
    )
      throw new SessionValidationError("session event timestamp is invalid");
    const payloadJson = stringifyJson(
      candidate.ops === undefined
        ? candidate.payload
        : [candidate.payload, candidate.ops],
      "session event payload",
    );
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_EVENT_BYTES)
      throw new SessionValidationError(
        `session event exceeds ${MAX_EVENT_BYTES} bytes`,
      );
    let rewind: Rewind | undefined;
    try {
      rewind = parseRewind(candidate.rewind);
    } catch (error) {
      throw new SessionValidationError(
        error instanceof Error
          ? error.message
          : "session event rewind is invalid",
      );
    }
    const parsed: SessionEvent = {
      id: candidate.id,
      revision: candidate.revision,
      kind: candidate.kind,
      payload: candidate.payload,
      at: candidate.at,
    };
    if (rewind !== undefined) parsed.rewind = rewind;
    if (candidate.actor !== undefined)
      parsed.actor = parseEventActor(candidate.actor);
    if (candidate.ops !== undefined) {
      if (!Array.isArray(candidate.ops))
        throw new SessionValidationError("session event ops are invalid");
      parsed.ops = candidate.ops;
    }
    return parsed;
  });
  let meta: SessionMeta;
  try {
    meta = parseSessionMeta(record.meta, {
      sessionId: record.sessionId,
      updatedAt: record.updatedAt,
    });
  } catch (error) {
    if (error instanceof MetaValidationError)
      throw new SessionValidationError(error.message);
    throw error;
  }
  return {
    sessionId: record.sessionId,
    revision: record.revision as number,
    updatedAt: record.updatedAt,
    composition: record.composition as T,
    events,
    ...(base > 0 ? { folded: base } : {}),
    meta,
  };
}

export function assertSessionId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SESSION_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new SessionValidationError(
      "session id contains unsafe path characters",
    );
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function stringifyJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new SessionValidationError(`${label} must be JSON data`);
    return encoded;
  } catch (error) {
    if (error instanceof SessionValidationError) throw error;
    throw new SessionValidationError(`${label} must be JSON data`);
  }
}

function parseEventActor(value: unknown): EventActor {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SessionValidationError("session event actor is invalid");
  const actor = value as Record<string, unknown>;
  const valid =
    typeof actor.clientId === "string" &&
    actor.clientId.length > 0 &&
    actor.clientId.length <= 64 &&
    (actor.actorId === undefined ||
      (typeof actor.actorId === "string" &&
        /^a_[a-z2-7]{22}$/.test(actor.actorId))) &&
    (actor.seq === undefined ||
      (Number.isSafeInteger(actor.seq) && (actor.seq as number) >= 1));
  if (!valid)
    throw new SessionValidationError("session event actor is invalid");
  const parsed: EventActor = { clientId: actor.clientId as string };
  if (actor.actorId !== undefined) parsed.actorId = actor.actorId as string;
  if (actor.seq !== undefined) parsed.seq = actor.seq as number;
  return parsed;
}
