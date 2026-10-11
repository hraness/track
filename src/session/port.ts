import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { TrackScore } from "../../core/score.ts";
import { AudioEngine } from "../audio/engine.ts";
import { historyHook } from "../history/hook.ts";
import { DaemonClient, type DaemonClientOptions } from "./client.ts";
import { FilePresence } from "./presence.ts";
import type { LiveLink } from "./shared-live.ts";
import {
  toLocalTransport,
  type PaneView,
  type PresenceEntry,
  type TransportAction,
  type TransportState,
} from "./protocol.ts";
import type { MetaExpect, MetaPatch, SessionMeta } from "./meta.ts";
import {
  appendSessionEvent,
  loadSession,
  SessionConflictError,
  updateSessionMeta,
  type EventActor,
  type SessionEvent,
  type SessionPaths,
  type SessionRecord,
} from "./store.ts";

/** File-port polling: without fs.watch, and as a backstop with it. */
const POLL_MS = 200;
const WATCHED_POLL_MS = 1_000;
/** Mirrors the protocol's per-intent operation cap. */
const MAX_INTENT_OPERATIONS = 256;

export type PortUpdate<T> =
  | { type: "record"; record: SessionRecord<T> }
  | { type: "transport"; transport: TransportState }
  | { type: "presence"; clients: PresenceEntry[] }
  /** Name or lineage changed; the score revision did not. */
  | { type: "meta"; meta: SessionMeta }
  /** Structured sync state for the header; no activity card. */
  | { type: "sync"; sync: SyncStatus }
  | { type: "status"; message: string };

/**
 * `synced` connected and idle, `syncing` a write is in flight, `conflict` the
 * last write raced another window and must rebase, `offline` dawgd dropped
 * and is reconnecting, `local` file-lock fallback (no daemon).
 */
export type SyncStatus =
  "synced" | "syncing" | "conflict" | "offline" | "local";

export type MetaWriteResult = {
  status: "applied" | "stale";
  /** The metadata now in effect (the winner's, when stale). */
  meta: SessionMeta;
};

/** What a window plays locally. Connected windows never start audio. */
export type WindowPlayer = {
  /** Start at `beat`, or swap a playing loop in place (gapless engine). */
  play(score: TrackScore, beat?: number): Promise<void>;
  stop(): void;
  /** Stops and releases the render worker; the player is done for good. */
  dispose(): Promise<void>;
};

/**
 * The seam between the TUI and session persistence. `daemon` talks to dawgd
 * (single writer, single transport, pushed updates); `file` is the original
 * file-lock path with snapshot polling, kept as the never-break fallback.
 */
export interface SessionPort<T> {
  readonly mode: "daemon" | "file";
  /** This window's presence id, to exclude itself from `presence()`. */
  readonly clientId: string;
  /** Human-readable status for the activity line. */
  readonly status: string;
  readonly player: WindowPlayer;
  readonly sync: SyncStatus;
  /** Appends an event at `current.revision`; throws SessionConflictError when stale. */
  append(
    current: SessionRecord<T>,
    event: Omit<SessionEvent, "id" | "revision" | "at">,
    composition: T,
  ): Promise<SessionRecord<T>>;
  /**
   * Commits score operations validated against `current`. dawgd replays them
   * on a newer score when nothing they touch changed (so a stale base is not
   * a conflict); the file port commits `composition` exactly like `append`.
   * The returned record may therefore be ahead of `composition`.
   */
  appendOperations(
    current: SessionRecord<T>,
    event: Omit<SessionEvent, "id" | "revision" | "at">,
    operations: readonly unknown[],
    composition: T,
  ): Promise<SessionRecord<T>>;
  load(): Promise<SessionRecord<T>>;
  /** Daemon mode only: asks dawgd to change the shared transport. */
  transport(
    action: TransportAction,
    value?: { beat?: number; bpm?: number },
  ): Promise<void>;
  subscribe(listener: (update: PortUpdate<T>) => void): () => void;
  focus(trackId: string | null): Promise<void>;
  /** Atomically claims a track that no other live window has focused. */
  claimTrack(
    trackIds: readonly string[],
    preferred?: string,
  ): Promise<string | null>;
  /**
   * `claimTrack` with a draft fallback: when every track is focused, reserve
   * a new `track-N` id (not yet in the score) for this window.
   */
  claimOrDraft(
    trackIds: readonly string[],
    preferred?: string,
  ): Promise<{ trackId: string; draft: boolean }>;
  presence(): Promise<PresenceEntry[]>;
  /** This pane's letter (daemon mode, assigned by dawgd). */
  readonly pane: string | undefined;
  /** Reports what this pane shows; others see it in presence. */
  setView(view: PaneView): void;
  /**
   * The machine's shared live engine (daemon with the `live` capability),
   * or undefined: the pane then plays through its own monitor engine.
   */
  liveLink(): LiveLink | undefined;
  /**
   * Conditional metadata write: applies only while `expect` matches the
   * stored metadata, so a user rename always beats an in-flight auto-name.
   */
  updateMeta(patch: MetaPatch, expect?: MetaExpect): Promise<MetaWriteResult>;
  close(): Promise<void>;
}

export type OpenPortOptions = {
  paths: SessionPaths;
  sessionId: string;
  label: string;
  focusedTrackId: string | null;
  /** Who is at this window; stamped on events and presence. */
  actor?: { id: string; name: string };
  /** Set false for one-shot commands (demo, export) that must not spawn dawgd. */
  daemon?: boolean;
  daemonArgs?: string[];
  /**
   * File sessions: the backstop poll while fs.watch is live (default 1 s).
   * Tests raise it to prove a change arrived through the watcher.
   */
  watchedPollMs?: number;
};

/** Connects to (or starts) dawgd, falling back to the file-lock path. */
export async function openSessionPort<T>(
  options: OpenPortOptions,
): Promise<SessionPort<T>> {
  if (options.daemon !== false && process.env.DAWG_DAEMON !== "0") {
    try {
      const clientOptions: DaemonClientOptions = {
        workspace: dirname(options.paths.root),
        sessionId: options.sessionId,
        label: options.label,
        focusedTrackId: options.focusedTrackId,
      };
      if (options.actor) clientOptions.actor = options.actor;
      if (options.daemonArgs) clientOptions.daemonArgs = options.daemonArgs;
      const client = await DaemonClient.connect(clientOptions);
      return new DaemonPort<T>(client);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const port = await FilePort.open<T>(options);
      port.status = `dawgd unavailable (${reason}); using file lock`;
      return port;
    }
  }
  const port = await FilePort.open<T>(options);
  port.status = "file session";
  return port;
}

const silentPlayer: WindowPlayer = {
  play: async () => undefined,
  stop: () => undefined,
  dispose: async () => undefined,
};

class DaemonPort<T> implements SessionPort<T> {
  public readonly mode = "daemon" as const;
  public readonly clientId: string;
  public readonly player = silentPlayer;
  public status: string;
  public sync: SyncStatus = "synced";
  private readonly syncListeners = new Set<(sync: SyncStatus) => void>();
  /**
   * (authority clock - this machine's clock), applied to every transport
   * `atMs` before the window sees it. Always 0 on one machine; the hook a
   * future relay fills from its clock-sync exchange.
   */
  public clockOffsetMs = 0;

  public constructor(private readonly client: DaemonClient) {
    this.status = `dawgd pid ${client.daemonPid}`;
    this.clientId = client.clientId;
  }

  private setSync(sync: SyncStatus): void {
    if (this.sync === sync) return;
    this.sync = sync;
    for (const listener of this.syncListeners) listener(sync);
  }

  public async append(
    current: SessionRecord<T>,
    event: Omit<SessionEvent, "id" | "revision" | "at">,
    composition: T,
  ): Promise<SessionRecord<T>> {
    // Transport lives in dawgd's clock, not in the event log, when connected.
    if (event.kind === "transport") return this.record();
    return this.applyIntent(current, event, { composition });
  }

  public async appendOperations(
    current: SessionRecord<T>,
    event: Omit<SessionEvent, "id" | "revision" | "at">,
    operations: readonly unknown[],
    composition: T,
  ): Promise<SessionRecord<T>> {
    if (operations.length === 0 || operations.length > MAX_INTENT_OPERATIONS)
      return this.append(current, event, composition);
    return this.applyIntent(current, event, { operations: [...operations] });
  }

  private async applyIntent(
    current: SessionRecord<T>,
    event: Omit<SessionEvent, "id" | "revision" | "at">,
    body: { composition: T } | { operations: unknown[] },
  ): Promise<SessionRecord<T>> {
    if (this.client.connected) this.setSync("syncing");
    let result;
    try {
      result = await this.client.apply({
        base: current.revision,
        kind: event.kind,
        payload: event.payload,
        ...body,
        key: randomUUID(),
      });
    } catch (error) {
      this.setSync(this.client.connected ? "synced" : "offline");
      throw error;
    }
    if (result.status === "accepted" || result.status === "duplicate") {
      this.setSync("synced");
      // The client's record can already hold a later write from another
      // window; mark which revision is this one's (OwnWrites reads it).
      const record = { ...this.record() };
      WRITTEN_REVISION.set(record, result.revision);
      return record;
    }
    if (result.status === "rebase") {
      this.setSync("conflict");
      throw new SessionConflictError();
    }
    this.setSync("synced");
    throw new Error(`dawgd rejected ${event.kind}: ${result.message}`);
  }

  public async load(): Promise<SessionRecord<T>> {
    await this.client.sync();
    return this.record();
  }

  public async transport(
    action: TransportAction,
    value?: { beat?: number; bpm?: number },
  ): Promise<void> {
    await this.client.setTransport(action, value);
  }

  public subscribe(listener: (update: PortUpdate<T>) => void): () => void {
    listener({
      type: "transport",
      transport: toLocalTransport(this.client.transport, this.clockOffsetMs),
    });
    const onSync = (sync: SyncStatus) => listener({ type: "sync", sync });
    this.syncListeners.add(onSync);
    const unsubscribe = this.client.subscribe((update) => {
      if (update.type === "record") {
        // A fresh record means this window has caught up after a conflict.
        if (this.sync === "conflict") this.setSync("synced");
        listener({ type: "record", record: update.record as SessionRecord<T> });
      } else if (update.type === "status") {
        this.status = update.message;
        this.setSync(update.connected ? "synced" : "offline");
        listener({ type: "status", message: update.message });
      } else if (update.type === "transport")
        listener({
          type: "transport",
          transport: toLocalTransport(update.transport, this.clockOffsetMs),
        });
      else listener(update);
    });
    return () => {
      this.syncListeners.delete(onSync);
      unsubscribe();
    };
  }

  public focus(trackId: string | null): Promise<void> {
    return this.client.focus(trackId);
  }

  public claimTrack(
    _trackIds: readonly string[],
    preferred?: string,
  ): Promise<string | null> {
    // dawgd claims against its own authoritative score order.
    return this.client.claimTrack(preferred);
  }

  public claimOrDraft(
    _trackIds: readonly string[],
    preferred?: string,
  ): Promise<{ trackId: string; draft: boolean }> {
    return this.client.claimOrDraft(preferred);
  }

  public async presence(): Promise<PresenceEntry[]> {
    return this.client.presence;
  }

  public get pane(): string | undefined {
    return this.client.self?.pane;
  }

  public setView(view: PaneView): void {
    if (this.client.caps.includes("panes")) this.client.setView(view);
  }

  public liveLink(): LiveLink | undefined {
    if (!this.client.sharedLive) return undefined;
    const client = this.client;
    const port = this;
    return (this.link ??= {
      liveMonitor: (on) => client.liveMonitor(on),
      live: (message) => client.live(message),
      get clockOffsetMs() {
        return port.clockOffsetMs;
      },
    });
  }
  private link: LiveLink | undefined;

  public async updateMeta(
    patch: MetaPatch,
    expect?: MetaExpect,
  ): Promise<MetaWriteResult> {
    const status = await this.client.updateMeta(patch, expect);
    return { status, meta: this.client.record.meta };
  }

  public async close(): Promise<void> {
    this.client.close();
  }

  private record(): SessionRecord<T> {
    return this.client.record as SessionRecord<T>;
  }
}

/**
 * The revision an append produced, for records whose last event may be a
 * newer write from elsewhere (a daemon window's record follows the log).
 */
export const WRITTEN_REVISION = new WeakMap<object, number>();

class FilePort<T> implements SessionPort<T> {
  public readonly mode = "file" as const;
  public readonly clientId = randomUUID();
  public status = "file session";
  public readonly sync = "local" as const;
  public readonly player: WindowPlayer;
  private readonly presenceStore: FilePresence;
  private readonly statusListeners = new Set<(update: PortUpdate<T>) => void>();
  /** File sessions have no pane letters or shared engine (§12.3). */
  public readonly pane = undefined;

  public setView(_view: PaneView): void {}

  public liveLink(): LiveLink | undefined {
    return undefined;
  }

  private constructor(private readonly options: OpenPortOptions) {
    this.player = new AudioEngine({
      lockPath: `${options.paths.record}.audio.lock`,
      projectRoot: dirname(options.paths.root),
      onStatus: (status) => {
        for (const listener of this.statusListeners)
          listener({ type: "status", message: status.message });
      },
    });
    this.presenceStore = new FilePresence(options.paths, {
      clientId: this.clientId,
      pid: process.pid,
      label: options.label.slice(0, 128),
      focusedTrackId: options.focusedTrackId,
      ...(options.actor ? { actorId: options.actor.id } : {}),
    });
  }

  public static async open<T>(options: OpenPortOptions): Promise<FilePort<T>> {
    const port = new FilePort<T>(options);
    if (options.daemon !== false)
      await port.presenceStore.start().catch(() => undefined);
    return port;
  }

  public append(
    current: SessionRecord<T>,
    event: Omit<SessionEvent, "id" | "revision" | "at">,
    composition: T,
  ): Promise<SessionRecord<T>> {
    const actor: EventActor = { clientId: this.clientId };
    if (this.options.actor) actor.actorId = this.options.actor.id;
    return appendSessionEvent(
      this.options.paths,
      current,
      { ...event, actor },
      composition,
      historyHook(dirname(this.options.paths.root), current.sessionId),
    );
  }

  /**
   * No daemon to rebase against: commit the full composition, and keep the
   * operations on the event so the log still replays as ops.
   */
  public appendOperations(
    current: SessionRecord<T>,
    event: Omit<SessionEvent, "id" | "revision" | "at">,
    operations: readonly unknown[],
    composition: T,
  ): Promise<SessionRecord<T>> {
    return this.append(
      current,
      operations.length > 0 && operations.length <= MAX_INTENT_OPERATIONS
        ? { ...event, ops: [...operations] }
        : event,
      composition,
    );
  }

  public load(): Promise<SessionRecord<T>> {
    return loadSession<T>(this.options.paths);
  }

  public async transport(): Promise<void> {
    throw new Error("file sessions drive transport locally");
  }

  /**
   * Without dawgd, changes arrive by watching the session directory (the
   * record is replaced by atomic rename, so the file itself cannot be watched)
   * and re-reading on each event: renames and edits from other windows show up
   * immediately. Polling stays on as the fallback, fast when fs.watch is
   * unavailable and slow as a backstop for filesystems that drop events.
   */
  public subscribe(listener: (update: PortUpdate<T>) => void): () => void {
    let revision = -1;
    let metaVersion = -1;
    let busy = false;
    let again = false;
    let closed = false;
    const check = (): void => {
      if (closed) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      void this.load()
        .then((record) => {
          if (closed) return;
          if (record.revision > revision) listener({ type: "record", record });
          else if (metaVersion >= 0 && record.meta.version > metaVersion)
            listener({ type: "meta", meta: record.meta });
          revision = Math.max(revision, record.revision);
          metaVersion = Math.max(metaVersion, record.meta.version);
        })
        // A partially written or concurrently replaced snapshot is retried next tick.
        .catch(() => undefined)
        .finally(() => {
          busy = false;
          if (again) {
            again = false;
            check();
          }
        });
    };
    const recordName = basename(this.options.paths.record);
    // macOS coalesces the temp write and the rename into events named after
    // the temp file (`<record>.<pid>.<n>.tmp`), so match that too, but not the
    // sibling `.audio.lock` / `.daemon.log` files that share the prefix.
    const recordFile = new RegExp(
      `^${recordName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:(?:\\.\\d+)+\\.tmp)?$`,
    );
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(dirname(this.options.paths.record), (_event, file) => {
        // Re-check shortly after in case the event preceded the rename.
        if (file !== null && !recordFile.test(String(file))) return;
        check();
        setTimeout(check, 40).unref?.();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
      watcher.unref?.();
    } catch {
      watcher = undefined;
    }
    const timer = setInterval(
      check,
      watcher ? (this.options.watchedPollMs ?? WATCHED_POLL_MS) : POLL_MS,
    );
    this.statusListeners.add(listener);
    check();
    return () => {
      closed = true;
      this.statusListeners.delete(listener);
      clearInterval(timer);
      watcher?.close();
    };
  }

  public focus(trackId: string | null): Promise<void> {
    return this.presenceStore.focus(trackId);
  }

  public claimTrack(
    trackIds: readonly string[],
    preferred?: string,
  ): Promise<string | null> {
    return this.presenceStore.claim(trackIds, preferred);
  }

  public claimOrDraft(
    trackIds: readonly string[],
    preferred?: string,
  ): Promise<{ trackId: string; draft: boolean }> {
    return this.presenceStore.claimOrDraft(trackIds, preferred);
  }

  public presence(): Promise<PresenceEntry[]> {
    return this.presenceStore.list();
  }

  public async updateMeta(
    patch: MetaPatch,
    expect?: MetaExpect,
  ): Promise<MetaWriteResult> {
    const result = await updateSessionMeta<T>(
      this.options.paths,
      patch,
      expect,
    );
    return { status: result.status, meta: result.record.meta };
  }

  public async close(): Promise<void> {
    void this.player.dispose();
    await this.presenceStore.stop();
  }
}
