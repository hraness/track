/**
 * `.dawg/history.db`: the canonical, append-only, unbounded log of a
 * project's sessions (design §2). One DB per project; sessions are a column.
 *
 * Every append runs in `BEGIN IMMEDIATE`, and `lamport`/`seq` are assigned
 * inside it, so any number of writer connections (the daemon, file-mode
 * panes, the CLI) never mint duplicates. Rows are never updated except by
 * retention nulling rewinds and payloads, and never deleted except `log`
 * rows with no revision and old `focus` rows.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseRewind, type Rewind } from "../session/delta.ts";
import { STATE_DIR } from "../session/store.ts";
import {
  ACTOR_KINDS,
  HISTORY_KINDS,
  newId,
  type ActorKind,
  type CommentContext,
  type HistoryAppend,
  type HistoryFilter,
  type HistoryKind,
  type HistoryPage,
  type HistoryRow,
  type TargetRef,
} from "./types.ts";

export const HISTORY_FILE = "history.db";
export const COMMENTS_FILE = "comments.jsonl";
export const SCHEMA_VERSION = 1;

export const HISTORY_LIMITS = Object.freeze({
  maxSummaryChars: 200,
  maxBodyBytes: 8 * 1024,
  maxPayloadBytes: 64 * 1024,
  maxRewindBytes: 1024 * 1024,
  maxRewindBytesPerSession: 64 * 1024 * 1024,
  maxTargetsPerEvent: 64,
  maxTagsPerEvent: 8,
  maxDbBytes: 256 * 1024 * 1024,
  logRetentionDays: 14,
  focusRetentionDays: 30,
  rewindKeepPerSession: 5_000,
  appendBudgetMs: 2,
  maxQueryLimit: 500,
  defaultQueryLimit: 20,
});

/** Fork lineage caps, mirrored from the store. */
const MAX_FORK_DEPTH = 8;
const MAX_LINEAGE_EVENTS = 2_000;

export class HistoryBusyError extends Error {
  public constructor(message = "history db is busy") {
    super(message);
    this.name = "HistoryBusyError";
  }
}

export type UndoMeta = Readonly<{
  id: string;
  sessionId: string;
  rev: number;
  sub: string;
  payload: unknown;
  clientId?: string;
  hasRewind: boolean;
  identity: boolean;
}>;

export type PruneReport = Readonly<{
  deletedLogs: number;
  deletedFocus: number;
  nulledRewinds: number;
  done: boolean;
}>;

export type OpenOptions = Readonly<{
  readonly?: boolean;
  /** SQLite busy timeout: 50 for panes and the daemon, 2000 for the CLI. */
  busyMs?: number;
  /** Test hook: pretend FTS5 is missing. */
  noFts?: boolean;
}>;

/** What `open` found and did, for the one-line card callers may show. */
export type OpenReport = Readonly<{
  created: boolean;
  quarantined?: string;
  newerSchema: boolean;
}>;

export function historyPath(workspace: string): string {
  return join(workspace, STATE_DIR, HISTORY_FILE);
}

export function commentsPath(workspace: string): string {
  return join(workspace, STATE_DIR, COMMENTS_FILE);
}

const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY, fork_of TEXT, fork_rev INTEGER, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    rev INTEGER,
    score INTEGER NOT NULL DEFAULT 0,
    at_rev INTEGER NOT NULL,
    lamport INTEGER NOT NULL,
    replica_id TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'local',
    parent_id TEXT,
    kind TEXT NOT NULL,
    sub TEXT,
    actor_kind TEXT NOT NULL,
    actor_id TEXT,
    client_id TEXT,
    pane_key TEXT,
    pane TEXT,
    at TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT,
    ops TEXT,
    inverse TEXT,
    rewind BLOB,
    rewind_bytes INTEGER NOT NULL DEFAULT 0,
    context TEXT,
    payload TEXT,
    file TEXT)`,
  `CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS events_session_rev ON events(session_id, rev) WHERE rev IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS events_pane_key ON events(session_id, pane_key, seq)`,
  `CREATE INDEX IF NOT EXISTS events_client ON events(session_id, client_id, seq)`,
  `CREATE INDEX IF NOT EXISTS events_kind ON events(session_id, kind, seq)`,
  `CREATE INDEX IF NOT EXISTS events_actor ON events(session_id, actor_kind, seq)`,
  `CREATE INDEX IF NOT EXISTS events_parent ON events(parent_id)`,
  `CREATE TABLE IF NOT EXISTS targets (
    event_seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
    type TEXT NOT NULL, key TEXT NOT NULL, track_id TEXT, bar_from REAL, bar_to REAL)`,
  `CREATE INDEX IF NOT EXISTS targets_lookup ON targets(type, key, event_seq)`,
  `CREATE INDEX IF NOT EXISTS targets_track ON targets(track_id, event_seq)`,
  `CREATE INDEX IF NOT EXISTS targets_seq ON targets(event_seq)`,
  `CREATE INDEX IF NOT EXISTS targets_bars ON targets(track_id, bar_from, bar_to) WHERE type = 'bars'`,
  `CREATE TABLE IF NOT EXISTS tags (
    event_seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE, tag TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag, event_seq)`,
  `CREATE INDEX IF NOT EXISTS tags_seq ON tags(event_seq)`,
  `CREATE TRIGGER IF NOT EXISTS events_summary_immutable BEFORE UPDATE OF summary, body ON events
    BEGIN SELECT RAISE(ABORT, 'history summary and body are immutable'); END`,
];

const FTS_V1 = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    summary, body, content='events', content_rowid='seq', tokenize='unicode61')`,
  `CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, summary, body) VALUES (new.seq, new.summary, coalesce(new.body, ''));
  END`,
  `CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, summary, body) VALUES ('delete', old.seq, old.summary, coalesce(old.body, ''));
  END`,
];

/** Ordered, additive-only migrations; index i migrates to version i+1. */
const MIGRATIONS: readonly (readonly string[])[] = [SCHEMA_V1];

type RawRow = {
  seq: number;
  id: string;
  session_id: string;
  rev: number | null;
  score: number;
  at_rev: number;
  lamport: number;
  replica_id: string;
  origin: string;
  parent_id: string | null;
  kind: string;
  sub: string | null;
  actor_kind: string;
  actor_id: string | null;
  client_id: string | null;
  pane_key: string | null;
  pane: string | null;
  at: string;
  summary: string;
  body: string | null;
  ops: string | null;
  context: string | null;
  payload: string | null;
  file: string | null;
};

const ROW_COLUMNS =
  "e.seq, e.id, e.session_id, e.rev, e.score, e.at_rev, e.lamport, e.replica_id, e.origin, e.parent_id, e.kind, e.sub, e.actor_kind, e.actor_id, e.client_id, e.pane_key, e.pane, e.at, e.summary, e.body, e.ops, e.context, e.payload, e.file";

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function clipChars(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function oneLine(text: string, max: number): string {
  return clipChars(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * A WAL database cannot be opened `readonly` while no writer holds its
 * `-shm` file (nobody has the project open): fall back to a read-write
 * handle pinned with `query_only`, which never writes rows.
 */
function openReadonly(path: string): Database {
  try {
    const db = new Database(path, { readonly: true });
    db.query("SELECT count(*) FROM sqlite_master").get();
    return db;
  } catch {
    const db = new Database(path, { readwrite: true, create: false });
    db.exec("PRAGMA query_only = 1");
    return db;
  }
}

/** Lowercased `[a-z0-9_-]{1,32}` tags, deduplicated, capped. */
export function cleanTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.replace(/^#/, "").toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= HISTORY_LIMITS.maxTagsPerEvent) break;
  }
  return out;
}

function boundedJson(value: unknown, maxBytes: number): string | null {
  if (value === undefined) return null;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text === undefined) return null;
  if (Buffer.byteLength(text, "utf8") > maxBytes)
    return JSON.stringify({ truncated: true, bytes: Buffer.byteLength(text) });
  return text;
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function isCorrupt(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_CORRUPT|SQLITE_NOTADB|not a database|malformed/i.test(message);
}

/** Relative time ("10m", "2h", "1d", "30s") or ISO to an ISO timestamp. */
export function parseSince(
  value: string,
  now = Date.now(),
): string | undefined {
  const relative = /^(\d+)\s*(s|m|h|d|w)$/.exec(value.trim());
  if (relative) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[
      relative[2] as "s" | "m" | "h" | "d" | "w"
    ];
    return new Date(now - Number(relative[1]) * unit * 1000).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export class HistoryDb {
  public readonly path: string;
  public readonly workspace: string;
  public readonly report: OpenReport;
  public readonly readonly: boolean;
  private readonly db: Database;
  private replica = "";
  private fts = false;
  private newer = false;
  private appendsSincePrune = 0;

  private constructor(
    workspace: string,
    db: Database,
    path: string,
    readonly: boolean,
    report: OpenReport,
  ) {
    this.workspace = workspace;
    this.db = db;
    this.path = path;
    this.readonly = readonly;
    this.report = report;
  }

  /**
   * Opens (creating and migrating when writable) the project's history DB.
   * A damaged file is renamed to `history.db.corrupt-<ts>`, never deleted,
   * and a fresh DB takes its place; callers rebuild it by reconciling.
   */
  public static open(workspace: string, opts: OpenOptions = {}): HistoryDb {
    const path = historyPath(workspace);
    const readonly = opts.readonly === true;
    if (readonly && !existsSync(path))
      throw new Error(`no history db at ${path}`);
    if (!readonly) mkdirSync(dirname(path), { recursive: true });
    const busyMs = opts.busyMs ?? 50;
    try {
      return HistoryDb.openAt(workspace, path, readonly, busyMs, opts, {
        created: !existsSync(path),
        newerSchema: false,
      });
    } catch (error) {
      if (readonly || !isCorrupt(error)) throw error;
      const quarantined = quarantine(path);
      return HistoryDb.openAt(workspace, path, false, busyMs, opts, {
        created: true,
        quarantined,
        newerSchema: false,
      });
    }
  }

  private static openAt(
    workspace: string,
    path: string,
    readonly: boolean,
    busyMs: number,
    opts: OpenOptions,
    report: { created: boolean; quarantined?: string; newerSchema: boolean },
  ): HistoryDb {
    const db = readonly
      ? openReadonly(path)
      : new Database(path, { create: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}`);
      if (!readonly) {
        if (report.created) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = FULL");
      }
      db.exec("PRAGMA foreign_keys = ON");
      // Touch the file so a non-database fails here, not on first use.
      db.query("SELECT count(*) FROM sqlite_master").get();
      const history = new HistoryDb(workspace, db, path, readonly, report);
      history.init(report, opts);
      return history;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private init(
    report: { created: boolean; newerSchema: boolean },
    opts: OpenOptions,
  ): void {
    const hasMeta =
      this.db
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'")
        .get() !== null;
    let version = hasMeta ? Number(this.metaGet("schema_version") ?? "0") : 0;
    if (version > SCHEMA_VERSION) {
      this.newer = true;
      report.newerSchema = true;
    } else if (!this.readonly && version < SCHEMA_VERSION) {
      this.write(() => {
        for (let at = version; at < MIGRATIONS.length; at += 1)
          for (const sql of MIGRATIONS[at]!) this.db.exec(sql);
        version = SCHEMA_VERSION;
        this.metaSet("schema_version", String(SCHEMA_VERSION));
        if (this.metaGet("created_at") === undefined)
          this.metaSet("created_at", new Date().toISOString());
        if (this.metaGet("replica_id") === undefined)
          this.metaSet("replica_id", randomUUID());
      });
    }
    if (!this.readonly && !this.newer && this.metaGet("fts") === undefined) {
      let fts = false;
      if (opts.noFts !== true) {
        try {
          this.db.exec("CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x)");
          this.db.exec("DROP TABLE temp.fts_probe");
          fts = true;
        } catch {
          fts = false;
        }
      }
      this.write(() => {
        if (fts) for (const sql of FTS_V1) this.db.exec(sql);
        this.metaSet("fts", fts ? "1" : "0");
      });
    }
    this.fts = this.metaGet("fts") === "1";
    this.replica = this.metaGet("replica_id") ?? "unknown";
  }

  /** True when this binary is older than the DB's schema (read + insert only). */
  public get newerSchema(): boolean {
    return this.newer;
  }

  public get hasFts(): boolean {
    return this.fts;
  }

  public get replicaId(): string {
    return this.replica;
  }

  public metaGet(key: string): string | undefined {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?",
      )
      .get(key);
    return row?.value;
  }

  public metaSet(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Runs `fn` in `BEGIN IMMEDIATE`; SQLITE_BUSY becomes HistoryBusyError. */
  private write<T>(fn: () => T): T {
    if (this.readonly) throw new Error("history db is read-only");
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isBusy(error)) throw new HistoryBusyError();
      throw error;
    }
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      if (isBusy(error)) throw new HistoryBusyError();
      throw error;
    }
  }

  public has(id: string): boolean {
    return this.db.query("SELECT 1 FROM events WHERE id = ?").get(id) !== null;
  }

  /** Revisions this session already has rows for (import dedupe by rev). */
  public revs(sessionId: string): Set<number> {
    const rows = this.db
      .query<{ rev: number }, [string]>(
        "SELECT rev FROM events WHERE session_id = ? AND rev IS NOT NULL",
      )
      .all(sessionId);
    return new Set(rows.map((row) => row.rev));
  }

  public append(event: HistoryAppend): HistoryRow {
    const seq = this.write(() => this.insert(event));
    this.appendsSincePrune += 1;
    return this.get(seq)!;
  }

  /** Inserts that skip ids (or session revisions) already present. */
  public appendMany(events: readonly HistoryAppend[], batch = 200): number {
    let inserted = 0;
    for (let at = 0; at < events.length; at += batch) {
      const chunk = events.slice(at, at + batch);
      inserted += this.write(() => {
        let count = 0;
        for (const event of chunk) {
          if (event.id !== undefined && this.has(event.id)) continue;
          if (
            event.rev !== undefined &&
            this.db
              .query("SELECT 1 FROM events WHERE session_id = ? AND rev = ?")
              .get(event.sessionId, event.rev) !== null
          )
            continue;
          this.insert(event);
          count += 1;
        }
        return count;
      });
    }
    this.appendsSincePrune += inserted;
    return inserted;
  }

  private insert(event: HistoryAppend): number {
    if (!HISTORY_KINDS.includes(event.kind))
      throw new Error(`unknown history kind: ${String(event.kind)}`);
    const actorKind: ActorKind = ACTOR_KINDS.includes(event.actor.kind)
      ? event.actor.kind
      : "system";
    const lamport =
      (this.db
        .query<{ m: number | null }, []>("SELECT MAX(lamport) AS m FROM events")
        .get()?.m ?? 0) + 1;
    const id = event.id ?? newId("ev");
    let body = event.body;
    let file: string | null = null;
    if (
      body !== undefined &&
      Buffer.byteLength(body, "utf8") > HISTORY_LIMITS.maxBodyBytes
    ) {
      file = this.overflow(event.kind, id, body);
      body = Buffer.from(body, "utf8")
        .subarray(0, HISTORY_LIMITS.maxBodyBytes)
        .toString("utf8");
    }
    let rewindText: string | null = null;
    if (event.rewind !== undefined) {
      const text = JSON.stringify(event.rewind);
      if (Buffer.byteLength(text, "utf8") <= HISTORY_LIMITS.maxRewindBytes)
        rewindText = text;
    }
    const identity = rewindText === null || rewindText === '{"obj":{}}';
    const score =
      event.score ??
      ((event.kind === "edit" ||
        event.kind === "undo" ||
        event.kind === "redo") &&
        (!identity || (event.ops?.length ?? 0) > 0));
    const values: SQLQueryBindings[] = [
      id,
      event.sessionId,
      event.rev ?? null,
      score ? 1 : 0,
      event.atRev,
      lamport,
      this.replica,
      event.origin ?? "local",
      event.parentId ?? null,
      event.kind,
      event.sub ?? null,
      actorKind,
      event.actor.actorId ?? null,
      event.actor.clientId ?? null,
      event.actor.paneKey ?? null,
      event.actor.pane ?? null,
      event.at ?? new Date().toISOString(),
      oneLine(event.summary, HISTORY_LIMITS.maxSummaryChars),
      body ?? null,
      boundedJson(event.ops, HISTORY_LIMITS.maxPayloadBytes * 4),
      boundedJson(event.inverse, HISTORY_LIMITS.maxPayloadBytes * 4),
      rewindText,
      rewindText === null ? 0 : Buffer.byteLength(rewindText, "utf8"),
      boundedJson(event.context, HISTORY_LIMITS.maxPayloadBytes),
      boundedJson(event.payload, HISTORY_LIMITS.maxPayloadBytes),
      file,
    ];
    const result = this.db
      .query(
        `INSERT INTO events (id, session_id, rev, score, at_rev, lamport, replica_id, origin,
          parent_id, kind, sub, actor_kind, actor_id, client_id, pane_key, pane, at, summary,
          body, ops, inverse, rewind, rewind_bytes, context, payload, file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...values);
    const seq = Number(result.lastInsertRowid);
    const targets = (event.targets ?? []).slice(
      0,
      HISTORY_LIMITS.maxTargetsPerEvent,
    );
    if (targets.length > 0) {
      const insertTarget = this.db.query(
        "INSERT INTO targets (event_seq, type, key, track_id, bar_from, bar_to) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const target of targets)
        insertTarget.run(
          seq,
          target.type,
          target.key,
          target.trackId ?? null,
          target.barFrom ?? null,
          target.barTo ?? null,
        );
    }
    const tags = cleanTags(event.tags);
    if (tags.length > 0) {
      const insertTag = this.db.query(
        "INSERT INTO tags (event_seq, tag) VALUES (?, ?)",
      );
      for (const tag of tags) insertTag.run(seq, tag);
    }
    return seq;
  }

  private overflow(kind: string, id: string, body: string): string {
    const relative = join("logs", kind, `${id}.txt`);
    const absolute = join(dirname(this.path), relative);
    mkdirSync(dirname(absolute), { recursive: true });
    const fd = openSync(absolute, "w");
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return relative;
  }

  public get(idOrSeq: string | number): HistoryRow | undefined {
    let raw: RawRow | null;
    if (typeof idOrSeq === "number")
      raw = this.db
        .query<RawRow, [number]>(
          `SELECT ${ROW_COLUMNS} FROM events e WHERE e.seq = ?`,
        )
        .get(idOrSeq);
    else {
      raw = this.db
        .query<RawRow, [string]>(
          `SELECT ${ROW_COLUMNS} FROM events e WHERE e.id = ?`,
        )
        .get(idOrSeq);
      if (raw === null && idOrSeq.length >= 6) {
        const matches = this.db
          .query<RawRow, [string]>(
            `SELECT ${ROW_COLUMNS} FROM events e WHERE e.id LIKE ? ESCAPE '\\' ORDER BY e.seq DESC LIMIT 2`,
          )
          .all(`${escapeLike(idOrSeq)}%`);
        raw = matches.length === 1 ? matches[0]! : null;
      }
    }
    return raw === null ? undefined : this.hydrate([raw])[0];
  }

  /** The row that produced revision `rev` of a session. */
  public byRev(sessionId: string, rev: number): HistoryRow | undefined {
    const raw = this.db
      .query<RawRow, [string, number]>(
        `SELECT ${ROW_COLUMNS} FROM events e WHERE e.session_id = ? AND e.rev = ?`,
      )
      .get(sessionId, rev);
    return raw === null ? undefined : this.hydrate([raw])[0];
  }

  /** Raw stored rewind/inverse/rewind_bytes of one row (tests, show --full). */
  public internals(
    id: string,
  ): { rewindBytes: number; hasRewind: boolean } | undefined {
    const row = this.db
      .query<{ rewind_bytes: number; has: number }, [string]>(
        "SELECT rewind_bytes, rewind IS NOT NULL AS has FROM events WHERE id = ?",
      )
      .get(id);
    return row
      ? { rewindBytes: row.rewind_bytes, hasRewind: row.has === 1 }
      : undefined;
  }

  private hydrate(raws: readonly RawRow[]): HistoryRow[] {
    if (raws.length === 0) return [];
    const seqs = raws.map((raw) => raw.seq);
    const marks = seqs.map(() => "?").join(",");
    const targets = new Map<number, TargetRef[]>();
    for (const row of this.db
      .query<
        {
          event_seq: number;
          type: TargetRef["type"];
          key: string;
          track_id: string | null;
          bar_from: number | null;
          bar_to: number | null;
        },
        number[]
      >(
        `SELECT event_seq, type, key, track_id, bar_from, bar_to FROM targets WHERE event_seq IN (${marks})`,
      )
      .all(...seqs)) {
      const list = targets.get(row.event_seq) ?? [];
      list.push({
        type: row.type,
        key: row.key,
        ...(row.track_id !== null ? { trackId: row.track_id } : {}),
        ...(row.bar_from !== null ? { barFrom: row.bar_from } : {}),
        ...(row.bar_to !== null ? { barTo: row.bar_to } : {}),
      });
      targets.set(row.event_seq, list);
    }
    const tags = new Map<number, string[]>();
    for (const row of this.db
      .query<{ event_seq: number; tag: string }, number[]>(
        `SELECT event_seq, tag FROM tags WHERE event_seq IN (${marks})`,
      )
      .all(...seqs)) {
      const list = tags.get(row.event_seq) ?? [];
      list.push(row.tag);
      tags.set(row.event_seq, list);
    }
    return raws.map((raw) => {
      const ops = parseJson(raw.ops);
      const context = parseJson(raw.context);
      const payload = parseJson(raw.payload);
      const row: HistoryRow = {
        seq: raw.seq,
        id: raw.id,
        sessionId: raw.session_id,
        rev: raw.rev,
        score: raw.score === 1,
        atRev: raw.at_rev,
        lamport: raw.lamport,
        replicaId: raw.replica_id,
        origin: raw.origin === "imported" ? "imported" : "local",
        parentId: raw.parent_id,
        kind: (HISTORY_KINDS.includes(raw.kind as HistoryKind)
          ? raw.kind
          : "log") as HistoryKind,
        sub: raw.sub,
        actor: {
          kind: (ACTOR_KINDS.includes(raw.actor_kind as ActorKind)
            ? raw.actor_kind
            : "system") as ActorKind,
          ...(raw.actor_id !== null ? { actorId: raw.actor_id } : {}),
          ...(raw.client_id !== null ? { clientId: raw.client_id } : {}),
          ...(raw.pane_key !== null ? { paneKey: raw.pane_key } : {}),
          ...(raw.pane !== null ? { pane: raw.pane } : {}),
        },
        at: raw.at,
        summary: raw.summary,
        ...(raw.body !== null ? { body: raw.body } : {}),
        ...(Array.isArray(ops) ? { ops } : {}),
        ...(context !== undefined
          ? { context: context as CommentContext }
          : {}),
        ...(payload !== undefined ? { payload } : {}),
        targets: targets.get(raw.seq) ?? [],
        tags: tags.get(raw.seq) ?? [],
        ...(raw.file !== null ? { file: raw.file } : {}),
      };
      return row;
    });
  }

  public query(filter: HistoryFilter = {}): HistoryPage {
    const where: string[] = [];
    const args: SQLQueryBindings[] = [];
    if (filter.sessionId !== undefined && filter.sessionId !== "*") {
      where.push("e.session_id = ?");
      args.push(filter.sessionId);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`e.kind IN (${filter.kinds.map(() => "?").join(",")})`);
      args.push(...filter.kinds);
    }
    if (filter.actors && filter.actors.length > 0) {
      where.push(`e.actor_kind IN (${filter.actors.map(() => "?").join(",")})`);
      args.push(...filter.actors);
    }
    const target = (sql: string, ...values: SQLQueryBindings[]) => {
      where.push(
        `EXISTS (SELECT 1 FROM targets t WHERE t.event_seq = e.seq AND ${sql})`,
      );
      args.push(...values);
    };
    if (filter.track !== undefined)
      target(
        "(t.track_id = ? OR (t.type = 'track' AND t.key = ?))",
        filter.track,
        filter.track,
      );
    if (filter.instrument !== undefined)
      target("t.type = 'instrument' AND t.key = ?", filter.instrument);
    if (filter.effect !== undefined)
      target("t.type = 'effect' AND t.key = ?", filter.effect);
    if (filter.node !== undefined)
      target("t.type = 'node' AND t.key = ?", filter.node);
    if (filter.param !== undefined)
      target(
        "t.type = 'param' AND (t.key = ? OR t.key LIKE ? ESCAPE '\\' OR t.key LIKE ? ESCAPE '\\')",
        filter.param,
        `${escapeLike(filter.param)}.%`,
        `%.${escapeLike(filter.param)}`,
      );
    if (filter.bars !== undefined)
      target(
        "t.type = 'bars' AND t.bar_from <= ? AND t.bar_to >= ?",
        filter.bars[1],
        filter.bars[0],
      );
    if (filter.pane !== undefined) {
      where.push("(e.pane = ? OR e.pane_key = ? OR e.client_id = ?)");
      args.push(filter.pane, filter.pane, filter.pane);
    }
    if (filter.tag !== undefined) {
      where.push(
        "EXISTS (SELECT 1 FROM tags g WHERE g.event_seq = e.seq AND g.tag = ?)",
      );
      args.push(filter.tag.replace(/^#/, "").toLowerCase());
    }
    if (filter.grep !== undefined && filter.grep.trim().length > 0) {
      if (this.fts) {
        where.push(
          "e.seq IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)",
        );
        args.push(ftsQuery(filter.grep));
      } else {
        where.push(
          "(e.summary LIKE ? ESCAPE '\\' OR coalesce(e.body, '') LIKE ? ESCAPE '\\')",
        );
        const like = `%${escapeLike(filter.grep.trim())}%`;
        args.push(like, like);
      }
    }
    if (filter.sinceSeq !== undefined) {
      where.push("e.seq > ?");
      args.push(filter.sinceSeq);
    }
    if (filter.sinceAt !== undefined) {
      where.push("e.at >= ?");
      args.push(filter.sinceAt);
    }
    if (filter.rev !== undefined) {
      if (typeof filter.rev === "number") {
        where.push("e.rev = ?");
        args.push(filter.rev);
      } else {
        where.push("e.rev BETWEEN ? AND ?");
        args.push(filter.rev[0], filter.rev[1]);
      }
    }
    if (filter.parentId !== undefined) {
      where.push("e.parent_id = ?");
      args.push(filter.parentId);
    }
    const asc = filter.order === "asc";
    const pageWhere = [...where];
    const pageArgs = [...args];
    if (filter.beforeSeq !== undefined) {
      pageWhere.push(asc ? "e.seq > ?" : "e.seq < ?");
      pageArgs.push(filter.beforeSeq);
    }
    const limit = Math.max(
      1,
      Math.min(
        HISTORY_LIMITS.maxQueryLimit,
        Math.floor(filter.limit ?? HISTORY_LIMITS.defaultQueryLimit),
      ),
    );
    const clause =
      pageWhere.length > 0 ? `WHERE ${pageWhere.join(" AND ")}` : "";
    const raws = this.db
      .query<RawRow, SQLQueryBindings[]>(
        `SELECT ${ROW_COLUMNS} FROM events e ${clause} ORDER BY e.seq ${asc ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(...pageArgs, limit + 1);
    const more = raws.length > limit;
    const rows = this.hydrate(raws.slice(0, limit));
    const last = rows.at(-1);
    return more && last ? { rows, next: last.seq } : { rows };
  }

  /** Total rows matching a filter (ignores paging). */
  public count(
    filter: Pick<HistoryFilter, "sessionId" | "kinds"> = {},
  ): number {
    const where: string[] = [];
    const args: SQLQueryBindings[] = [];
    if (filter.sessionId !== undefined && filter.sessionId !== "*") {
      where.push("session_id = ?");
      args.push(filter.sessionId);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`kind IN (${filter.kinds.map(() => "?").join(",")})`);
      args.push(...filter.kinds);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return (
      this.db
        .query<{ n: number }, SQLQueryBindings[]>(
          `SELECT count(*) AS n FROM events ${clause}`,
        )
        .get(...args)?.n ?? 0
    );
  }

  /** Rows per kind, for `dawg history stats`. */
  public stats(): {
    kinds: Record<string, number>;
    sessions: number;
    oldest?: string;
    newest?: string;
    bytes: number;
  } {
    const kinds: Record<string, number> = {};
    for (const row of this.db
      .query<{ kind: string; n: number }, []>(
        "SELECT kind, count(*) AS n FROM events GROUP BY kind",
      )
      .all())
      kinds[row.kind] = row.n;
    const range = this.db
      .query<
        { oldest: string | null; newest: string | null; sessions: number },
        []
      >(
        "SELECT min(at) AS oldest, max(at) AS newest, count(DISTINCT session_id) AS sessions FROM events",
      )
      .get();
    let bytes = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        bytes += statSync(this.path + suffix).size;
      } catch {
        // absent
      }
    }
    return {
      kinds,
      sessions: range?.sessions ?? 0,
      ...(range?.oldest ? { oldest: range.oldest } : {}),
      ...(range?.newest ? { newest: range.newest } : {}),
      bytes,
    };
  }

  public recordSession(
    sessionId: string,
    forkOf?: { sessionId: string; revision: number },
  ): void {
    if (this.readonly) return;
    this.write(() => {
      this.db
        .query(
          `INSERT INTO sessions (session_id, fork_of, fork_rev, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET fork_of = coalesce(sessions.fork_of, excluded.fork_of),
             fork_rev = coalesce(sessions.fork_rev, excluded.fork_rev)`,
        )
        .run(
          sessionId,
          forkOf?.sessionId ?? null,
          forkOf?.revision ?? null,
          new Date().toISOString(),
        );
    });
  }

  public sessionLineage(
    sessionId: string,
  ): { forkOf?: string; forkRev?: number } | undefined {
    const row = this.db
      .query<{ fork_of: string | null; fork_rev: number | null }, [string]>(
        "SELECT fork_of, fork_rev FROM sessions WHERE session_id = ?",
      )
      .get(sessionId);
    if (!row) return undefined;
    return {
      ...(row.fork_of !== null ? { forkOf: row.fork_of } : {}),
      ...(row.fork_rev !== null ? { forkRev: row.fork_rev } : {}),
    };
  }

  /**
   * Metadata of SessionEvent rows (no rewind blobs), ordered by rev. With
   * lineage, the fork ancestors' rows up to each fork revision come first.
   * Rows are tagged with their session so callers can join rewinds by id.
   */
  public undoMeta(
    sessionId: string,
    opts: { withLineage?: boolean; limit?: number } = {},
  ): UndoMeta[] {
    const limit = opts.limit ?? HISTORY_LIMITS.rewindKeepPerSession;
    const own = this.metaRows(sessionId, undefined, limit);
    if (!opts.withLineage) return own;
    const chunks: UndoMeta[][] = [own];
    const seen = new Set([sessionId]);
    let lineage = this.sessionLineage(sessionId);
    let total = own.length;
    for (
      let depth = 0;
      lineage?.forkOf &&
      lineage.forkRev !== undefined &&
      depth < MAX_FORK_DEPTH &&
      total < limit + MAX_LINEAGE_EVENTS;
      depth += 1
    ) {
      if (seen.has(lineage.forkOf)) break;
      seen.add(lineage.forkOf);
      const rows = this.metaRows(
        lineage.forkOf,
        lineage.forkRev,
        MAX_LINEAGE_EVENTS,
      );
      chunks.unshift(rows);
      total += rows.length;
      lineage = this.sessionLineage(lineage.forkOf);
    }
    return chunks.flat();
  }

  private metaRows(
    sessionId: string,
    maxRev: number | undefined,
    limit: number,
  ): UndoMeta[] {
    const raws = this.db
      .query<
        {
          id: string;
          session_id: string;
          rev: number;
          sub: string | null;
          payload: string | null;
          client_id: string | null;
          has: number;
          bytes: number;
          ident: number;
        },
        SQLQueryBindings[]
      >(
        `SELECT id, session_id, rev, sub, payload, client_id, rewind IS NOT NULL AS has, rewind_bytes AS bytes,
           (rewind = '{"obj":{}}') AS ident
         FROM events WHERE session_id = ? AND rev IS NOT NULL ${maxRev !== undefined ? "AND rev <= ?" : ""}
         ORDER BY rev DESC LIMIT ?`,
      )
      .all(
        ...(maxRev !== undefined
          ? [sessionId, maxRev, limit]
          : [sessionId, limit]),
      );
    return raws.reverse().map((raw) => ({
      id: raw.id,
      sessionId: raw.session_id,
      rev: raw.rev,
      sub: raw.sub ?? "",
      payload: parseJson(raw.payload),
      ...(raw.client_id !== null ? { clientId: raw.client_id } : {}),
      hasRewind: raw.has === 1,
      identity: raw.ident === 1,
    }));
  }

  /** Rewind blobs for exactly these ids. */
  public rewinds(ids: readonly string[]): Map<string, Rewind> {
    const out = new Map<string, Rewind>();
    for (let at = 0; at < ids.length; at += 256) {
      const chunk = ids.slice(at, at + 256);
      const rows = this.db
        .query<{ id: string; rewind: string | Uint8Array | null }, string[]>(
          `SELECT id, rewind FROM events WHERE id IN (${chunk.map(() => "?").join(",")}) AND rewind IS NOT NULL`,
        )
        .all(...chunk);
      for (const row of rows) {
        if (row.rewind === null) continue;
        const text =
          typeof row.rewind === "string"
            ? row.rewind
            : Buffer.from(row.rewind).toString("utf8");
        try {
          const rewind = parseRewind(JSON.parse(text) as unknown);
          if (rewind !== undefined) out.set(row.id, rewind);
        } catch {
          // a damaged rewind ends the undo window there
        }
      }
    }
    return out;
  }

  public lastSeq(): number {
    return (
      this.db
        .query<{ m: number | null }, []>("SELECT MAX(seq) AS m FROM events")
        .get()?.m ?? 0
    );
  }

  /** Newest revision with a row for this session, or 0. */
  public lastRev(sessionId: string): number {
    return (
      this.db
        .query<{ m: number | null }, [string]>(
          "SELECT MAX(rev) AS m FROM events WHERE session_id = ?",
        )
        .get(sessionId)?.m ?? 0
    );
  }

  /** True when retention is due (500 appends since the last prune). */
  public get pruneDue(): boolean {
    return this.appendsSincePrune >= 500;
  }

  /**
   * Retention (design §2.8), in short transactions bounded by `budgetMs`.
   * Never deletes comments, edits, undo/redo, transport or assets.
   */
  public prune(now: Date = new Date(), budgetMs = 20): PruneReport {
    if (this.readonly || this.newer)
      return { deletedLogs: 0, deletedFocus: 0, nulledRewinds: 0, done: true };
    const started = performance.now();
    const over = () => performance.now() - started > budgetMs;
    const day = 86_400_000;
    const logCutoff = new Date(
      now.getTime() - HISTORY_LIMITS.logRetentionDays * day,
    ).toISOString();
    const focusCutoff = new Date(
      now.getTime() - HISTORY_LIMITS.focusRetentionDays * day,
    ).toISOString();
    let deletedLogs = 0;
    let deletedFocus = 0;
    let nulledRewinds = 0;
    const slice = (sql: string, ...args: SQLQueryBindings[]) =>
      this.write(() => this.db.query(sql).run(...args).changes);
    while (!over()) {
      const n = slice(
        "DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE kind = 'log' AND rev IS NULL AND at < ? LIMIT 200)",
        logCutoff,
      );
      deletedLogs += n;
      if (n < 200) break;
    }
    while (!over()) {
      const n = slice(
        `DELETE FROM events WHERE seq IN (SELECT e.seq FROM events e WHERE e.kind = 'focus' AND e.at < ?
           AND NOT EXISTS (SELECT 1 FROM events c WHERE c.parent_id = e.id) LIMIT 200)`,
        focusCutoff,
      );
      deletedFocus += n;
      if (n < 200) break;
    }
    const sessions = this.db
      .query<{ session_id: string }, []>(
        "SELECT DISTINCT session_id FROM events WHERE rewind IS NOT NULL",
      )
      .all();
    for (const { session_id } of sessions) {
      if (over()) break;
      nulledRewinds += this.capRewinds(
        session_id,
        HISTORY_LIMITS.rewindKeepPerSession,
        HISTORY_LIMITS.maxRewindBytesPerSession,
      );
    }
    const done = !over();
    if (done) this.appendsSincePrune = 0;
    return { deletedLogs, deletedFocus, nulledRewinds, done };
  }

  /** Nulls rewinds beyond the newest `keep` rows or `maxBytes` of a session. */
  public capRewinds(sessionId: string, keep: number, maxBytes: number): number {
    const rows = this.db
      .query<{ seq: number; bytes: number }, [string]>(
        "SELECT seq, rewind_bytes AS bytes FROM events WHERE session_id = ? AND rewind IS NOT NULL ORDER BY rev DESC",
      )
      .all(sessionId);
    let total = 0;
    const drop: number[] = [];
    rows.forEach((row, index) => {
      total += row.bytes;
      if (index >= keep || total > maxBytes) drop.push(row.seq);
    });
    if (drop.length === 0) return 0;
    return this.write(() => {
      let changed = 0;
      for (let at = 0; at < drop.length; at += 500) {
        const chunk = drop.slice(at, at + 500);
        changed += this.db
          .query(
            `UPDATE events SET rewind = NULL, inverse = NULL, rewind_bytes = 0 WHERE seq IN (${chunk.map(() => "?").join(",")})`,
          )
          .run(...chunk).changes;
      }
      return changed;
    });
  }

  public close(): void {
    try {
      if (!this.readonly) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // another connection holds the WAL
    }
    this.db.close();
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Bare words become quoted prefix terms, so user text never breaks FTS syntax. */
function ftsQuery(text: string): string {
  const words = text
    .split(/\s+/)
    .map((word) => word.replace(/"/g, ""))
    .filter((word) => word.length > 0);
  return words.map((word) => `"${word}"*`).join(" ");
}

/** Renames a damaged DB (and its WAL/SHM) aside; never deletes. */
function quarantine(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.corrupt-${stamp}`;
  renameSync(path, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(path + suffix)) renameSync(path + suffix, target + suffix);
  }
  return target;
}

/** One fsync'd JSON line per comment: the second copy only this file holds. */
export function mirrorComment(workspace: string, row: HistoryRow): void {
  const path = commentsPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  const { targets: _targets, ...rest } = row;
  const line = `${JSON.stringify(rest)}\n`;
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Comments mirrored in `comments.jsonl`, skipping damaged lines. */
export function readMirroredComments(workspace: string): HistoryRow[] {
  let text: string;
  try {
    text = readFileSync(commentsPath(workspace), "utf8");
  } catch {
    return [];
  }
  const out: HistoryRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const row = JSON.parse(line) as HistoryRow;
      if (typeof row.id === "string" && typeof row.sessionId === "string")
        out.push({ ...row, targets: [], tags: row.tags ?? [] });
    } catch {
      // a torn last line after a crash
    }
  }
  return out;
}
