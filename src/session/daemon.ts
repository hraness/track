import { appendFile, rm, stat, truncate } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  applyScoreOperation,
  scoreFromJSON,
  type ScoreOperation,
  type TrackScore,
} from "../../core/score.ts";
import { DiffError, diffScores } from "../../core/diff.ts";
import { TransportClock, transportMapFor } from "../audio/clock.ts";
import { AudioEngine } from "../audio/engine.ts";
import {
  SampleLibrary,
  hasSamplerTracks,
  type SampleBank,
} from "../audio/samples.ts";
import { PackStore } from "../audio/packs.ts";
import { historyHook } from "../history/hook.ts";
import { acquireSessionLock } from "./lock.ts";
import { LiveHost } from "./live-host.ts";
import {
  compositionAt,
  MAX_REBASE_DISTANCE,
  rebaseOperations,
} from "./rebase.ts";
import {
  compositionDigest,
  daemonLockPath,
  daemonLogPath,
  daemonSocketPath,
  encodeFrame,
  LineDecoder,
  MAX_CLIENT_FRAME_BYTES,
  DAEMON_CAPS,
  monotonicEpochMs,
  negotiateProtocol,
  parseClientMessage,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  ProtocolError,
  type ApplyResult,
  chooseTrack,
  claimOrDraft,
  type ClientMessage,
  type PresenceEntry,
  type ServerMessage,
  type TransportState,
} from "./protocol.ts";
import {
  appendSessionEvent,
  loadSession,
  SessionConflictError,
  sessionPaths,
  updateSessionMeta,
  type EventActor,
  type SessionPaths,
  type SessionRecord,
} from "./store.ts";

/** A slow client that stops reading is dropped rather than buffered forever. */
const MAX_CLIENT_BACKLOG_BYTES = 32 * 1024 * 1024;
const DEFAULT_GRACE_MS = 30_000;
const DISK_POLL_MS = 750;
const MAX_LOG_BYTES = 256 * 1024;

type Composition = ReturnType<TrackScore["toJSON"]>;

type Client = {
  socket: Socket;
  decoder: LineDecoder;
  ready: boolean;
  presence?: PresenceEntry;
  /** Negotiated protocol revision (1 for clients that sent no range). */
  protocol?: number;
};

/** The lowest free pane letter (A, B, C in join order, reused when freed). */
export function freePaneLetter(taken: ReadonlySet<string>): string {
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    if (!taken.has(letter)) return letter;
  }
  return "Z";
}

/** Retry-dedupe key for an intent: (actor, client, seq). */
function seqKey(actorId: string | undefined, clientId: string, seq: number) {
  return `${actorId ?? "-"}\u0000${clientId}\u0000${seq}`;
}

export type DaemonOptions = {
  workspace: string;
  sessionId: string;
  graceMs?: number;
};

/**
 * dawgd: the single writer and the single audio transport for one session.
 * Clients send intents; the daemon applies them through the core reducer,
 * persists them with the existing atomic store, and broadcasts the result.
 */
export class DawgDaemon {
  private readonly paths: SessionPaths;
  private readonly socketPath: string;
  private readonly graceMs: number;
  private readonly clients = new Set<Client>();
  private readonly keys = new Map<string, number>();
  /** (actor, client, seq) to the revision it produced; see `seqKey`. */
  private readonly seqs = new Map<string, number>();
  private readonly clock = new TransportClock();
  private readonly audio: AudioEngine;
  private readonly live: LiveHost;
  private samples: SampleBank | undefined;
  private sampleLibrary: SampleLibrary | undefined;
  private record!: SessionRecord<Composition>;
  private score!: TrackScore;
  private digest = "";
  private seq = 0;
  private server: Server | undefined;
  private releaseLock: (() => Promise<void>) | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private diskTimer: ReturnType<typeof setInterval> | undefined;
  private diskMtime = 0;
  private stopping: Promise<void> | undefined;

  public constructor(options: DaemonOptions) {
    this.paths = sessionPaths(options.workspace, options.sessionId);
    this.socketPath = daemonSocketPath(this.paths);
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.audio = new AudioEngine({
      lockPath: `${this.paths.record}.audio.lock`,
      projectRoot: options.workspace,
      onStatus: (status) => {
        void this.log(`audio: ${status.message}`);
        // A player that keeps dying must not leave a silent "playing" transport.
        if (status.state === "stopped" && this.clock.playing) {
          this.clock.pause();
          this.broadcastTransport();
        }
        this.broadcast({
          v: 1,
          type: "error",
          code: "audio",
          message: status.message,
        });
      },
    });
    this.workspace = options.workspace;
    this.live = new LiveHost({
      sink: this.audio,
      score: () => this.score,
      samples: () => this.samples,
      transportBeatAt: (ms) =>
        this.clock.playing ? this.clock.beatAt(ms) : undefined,
      toMonotonic: (epochMs) => epochMs - performance.timeOrigin,
      log: (line) => void this.log(line),
    });
  }

  private readonly workspace: string;

  /** Notes each client played through the shared engine (tests read it). */
  public get livePlayed(): ReadonlyMap<string, number> {
    return this.live.played;
  }

  /** Decodes sampler voices for live notes, once per score that needs them. */
  private async loadSamples(): Promise<void> {
    if (!hasSamplerTracks(this.score)) return;
    this.sampleLibrary ??= new SampleLibrary({
      projectRoot: this.workspace,
      packs: new PackStore(),
    });
    try {
      this.samples = await this.sampleLibrary.load(this.score);
    } catch (error) {
      await this.log(`live samples: ${String(error)}`);
    }
  }

  /** Returns false when another live daemon already owns this session. */
  public async start(): Promise<boolean> {
    try {
      this.releaseLock = await acquireSessionLock(
        daemonLockPath(this.paths),
        400,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out"))
        return false;
      throw error;
    }
    try {
      await this.reload();
      this.clock.follow(this.score);
      // We hold the daemon lock, so any socket file left here belongs to a
      // crashed daemon and is safe to reclaim.
      await rm(this.socketPath, { force: true });
      this.server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.socketPath, () => {
          this.server!.off("error", reject);
          resolve();
        });
      });
      this.diskTimer = setInterval(() => void this.pollDisk(), DISK_POLL_MS);
      this.armGrace();
      await this.log(
        `started pid ${process.pid} socket ${this.socketPath} audio ${this.audio.info.backend}`,
      );
      return true;
    } catch (error) {
      await this.releaseLock?.();
      this.releaseLock = undefined;
      throw error;
    }
  }

  public get socket(): string {
    return this.socketPath;
  }

  // Declared before `stopped` so field initialization order keeps the resolver.
  private resolveStopped: () => void = () => undefined;
  /** Resolves once the daemon has shut down for any reason. */
  public readonly stopped: Promise<void> = new Promise((resolve) => {
    this.resolveStopped = resolve;
  });

  public stop(reason = "stop"): Promise<void> {
    this.stopping ??= this.shutdown(reason).finally(() =>
      this.resolveStopped(),
    );
    return this.stopping;
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    await this.audio.dispose();
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    await this.queue.catch(() => undefined);
    // Bun's server.close callback can wait on already-destroyed sockets, so
    // bound it: the socket file is removed below either way.
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      const timer = setTimeout(resolve, 250);
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await rm(this.socketPath, { force: true });
    await this.log(`stopped (${reason})`);
    await this.releaseLock?.();
    this.releaseLock = undefined;
  }

  private accept(socket: Socket): void {
    if (this.stopping) return void socket.destroy();
    const client: Client = {
      socket,
      decoder: new LineDecoder(MAX_CLIENT_FRAME_BYTES),
      ready: false,
    };
    this.clients.add(client);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = client.decoder.push(chunk);
      } catch (error) {
        this.fail(client, error);
        return;
      }
      for (const line of lines) {
        if (line.length === 0) continue;
        let message: ClientMessage;
        try {
          message = parseClientMessage(line);
        } catch (error) {
          this.fail(client, error);
          return;
        }
        this.handle(client, message);
      }
    });
    // Bun does not always emit "close" for a socket that was written to
    // after its peer hung up, so any of these ends the client exactly once.
    const drop = () => {
      if (!this.clients.delete(client)) return;
      socket.destroy();
      if (client.presence) {
        void this.live.drop(client.presence.clientId);
        this.broadcastPresence();
      }
      if (this.clients.size === 0) this.armGrace();
    };
    socket.on("end", drop);
    socket.on("error", drop);
    socket.on("close", drop);
  }

  private fail(client: Client, error: unknown): void {
    const code = error instanceof ProtocolError ? error.code : "invalid";
    const message = error instanceof Error ? error.message : "invalid frame";
    this.send(client, { v: 1, type: "error", code, message });
    client.socket.end();
  }

  private handle(client: Client, message: ClientMessage): void {
    if (message.type === "hello") {
      const protocol = negotiateProtocol(message.vMin, message.vMax);
      if (protocol === undefined) {
        this.fail(
          client,
          new ProtocolError(
            "version",
            `dawgd speaks protocol ${PROTOCOL_MIN}-${PROTOCOL_MAX}`,
          ),
        );
        return;
      }
      client.ready = true;
      client.protocol = protocol;
      const letters = new Set<string>();
      for (const other of this.clients)
        if (other !== client && other.presence?.pane)
          letters.add(other.presence.pane);
      client.presence = {
        clientId: message.clientId,
        pid: message.pid,
        label: message.label,
        focusedTrackId: message.focusedTrackId,
        pane: freePaneLetter(letters),
      };
      if (message.actorId) client.presence.actorId = message.actorId;
      this.send(client, {
        v: 1,
        type: "welcome",
        sessionId: this.record.sessionId,
        pid: process.pid,
        record: this.record,
        digest: this.digest,
        transport: this.transportState(),
        protocol,
        caps: [...DAEMON_CAPS],
      });
      this.broadcastPresence();
      return;
    }
    if (!client.ready) {
      this.fail(client, new ProtocolError("handshake", "send hello first"));
      return;
    }
    if (message.type === "focus") {
      client.presence!.focusedTrackId = message.trackId;
      this.broadcastPresence();
      this.send(client, {
        v: 1,
        type: "claimed",
        id: message.id,
        trackId: message.trackId,
      });
      return;
    }
    if (message.type === "claim") {
      // Synchronous on the single event loop, so two simultaneous claims are
      // serialized and can never pick the same track.
      const taken = new Set<string>();
      for (const other of this.clients)
        if (other !== client && other.presence?.focusedTrackId)
          taken.add(other.presence.focusedTrackId);
      const trackIds = this.score.tracks.map((track) => track.id);
      const claim = message.draft
        ? claimOrDraft(trackIds, taken, message.preferred)
        : {
            trackId: chooseTrack(trackIds, taken, message.preferred),
            draft: false,
          };
      if (claim.trackId !== null)
        client.presence!.focusedTrackId = claim.trackId;
      const reply: ServerMessage = {
        v: 1,
        type: "claimed",
        id: message.id,
        trackId: claim.trackId,
      };
      if (claim.draft) reply.draft = true;
      this.send(client, reply);
      this.broadcastPresence();
      return;
    }
    if (message.type === "ping") {
      this.send(client, { v: 1, type: "pong", id: message.id });
      return;
    }
    if (message.type === "sync") {
      // Queue behind pending writes so the snapshot reflects them.
      this.enqueue(async () => {
        this.send(client, {
          v: 1,
          type: "snapshot",
          record: this.record,
          digest: this.digest,
        });
        this.send(client, {
          v: 1,
          type: "result",
          id: message.id,
          status: "accepted",
          revision: this.record.revision,
        });
      });
      return;
    }
    if (message.type === "meta") {
      // Queued with score writes so a rename never interleaves an append.
      this.enqueue(async () => {
        const result = await updateSessionMeta<Composition>(
          this.paths,
          message.patch,
          message.expect,
        );
        if (result.record.revision !== this.record.revision) {
          // A file-fallback window wrote the score too; adopt everything.
          const previousTempo = this.timeKey();
          await this.reload();
          this.broadcast({
            v: 1,
            type: "snapshot",
            record: this.record,
            digest: this.digest,
          });
          this.afterScoreChange(previousTempo);
        } else {
          this.record = { ...this.record, meta: result.record.meta };
          this.diskMtime = await this.recordMtime();
        }
        // Meta goes out before the result so the requester sees it first.
        if (result.status === "applied")
          this.broadcast({ v: 1, type: "meta", meta: this.record.meta });
        else this.send(client, { v: 1, type: "meta", meta: this.record.meta });
        this.send(
          client,
          result.status === "applied"
            ? {
                v: 1,
                type: "result",
                id: message.id,
                status: "accepted",
                revision: this.record.revision,
              }
            : {
                v: 1,
                type: "result",
                id: message.id,
                status: "rejected",
                code: "stale-meta",
                message: "session name changed since the request began",
              },
        );
      });
      return;
    }
    if (message.type === "view") {
      const presence = client.presence!;
      const { v: _v, type: _type, ...view } = message;
      for (const key of [
        "screen",
        "param",
        "recording",
        "playing",
        "pinned",
        "follow",
      ] as const)
        delete presence[key];
      Object.assign(presence, view);
      this.broadcastPresence();
      return;
    }
    if (message.type === "live") {
      const clientId = client.presence!.clientId;
      if (message.action === "monitor")
        void (async () => {
          if (message.on) await this.loadSamples();
          const status = await this.live.handle(clientId, message);
          if (status)
            this.send(client, {
              v: 1,
              type: "liveStatus",
              id: message.id,
              ...status,
            });
        })();
      else void this.live.handle(clientId, message);
      return;
    }
    if (message.type === "transport") {
      this.enqueue(async () => {
        this.transport(message.action, message.beat, message.bpm);
        this.send(client, {
          v: 1,
          type: "result",
          id: message.id,
          status: "accepted",
          revision: this.record.revision,
        });
      });
      return;
    }
    this.enqueue(async () => {
      const result = await this.apply(message, client);
      this.send(client, { v: 1, type: "result", id: message.id, ...result });
    });
  }

  private enqueue(task: () => Promise<void>): void {
    // One writer, strictly ordered: every intent observes the previous one.
    this.queue = this.queue.then(task).catch(async (error: unknown) => {
      await this.log(`task failed: ${String(error)}`);
    });
  }

  private async apply(
    message: Extract<ClientMessage, { type: "apply" }>,
    client?: Client,
  ): Promise<ApplyResult> {
    const seen = this.keys.get(message.key);
    if (seen !== undefined) return { status: "duplicate", revision: seen };
    // The authority stamps who made the event from the connection, never
    // from the intent body.
    const actor: EventActor | undefined = client?.presence
      ? {
          clientId: client.presence.clientId,
          ...(client.presence.actorId
            ? { actorId: client.presence.actorId }
            : {}),
          ...(message.seq !== undefined ? { seq: message.seq } : {}),
        }
      : undefined;
    const retryKey =
      actor?.seq !== undefined
        ? seqKey(actor.actorId, actor.clientId, actor.seq)
        : undefined;
    const retried = retryKey ? this.seqs.get(retryKey) : undefined;
    if (retried !== undefined)
      return { status: "duplicate", revision: retried };
    let operations: ScoreOperation[] | undefined;
    const stale = message.base !== this.record.revision;
    let rebased = false;
    let next: TrackScore;
    try {
      if (message.operations) {
        operations = message.operations.map(parseOperation);
        if (stale) {
          // Operation intents from an older base replay on the current score
          // when nothing they touch changed in between.
          const base = this.baseScore(message.base);
          if (base === undefined)
            return this.rebaseReply(message.base, "base is not recoverable");
          const result = rebaseOperations(base, this.score, operations);
          if (!result.ok) return this.rebaseReply(message.base, result.reason);
          next = result.next;
          rebased = true;
        } else {
          next = this.score;
          for (const operation of operations)
            next = applyScoreOperation(next, operation);
        }
      } else if (stale) return this.rebaseReply(message.base);
      else next = scoreFromJSON(message.composition);
      // Round-trip through the parser so only canonical score data is stored.
      next = scoreFromJSON(next.toJSON());
      // Composition intents still log as ops, so the log replays as ops.
      operations ??= derivedOperations(
        this.score,
        next,
        MAX_DERIVED_OPS_BYTES -
          Buffer.byteLength(JSON.stringify(message.payload ?? null), "utf8"),
      );
    } catch (error) {
      return {
        status: "rejected",
        code: "invalid-operation",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    // The store records how to rewind every event, so undo and later rebases
    // can recover the score it replaced; a rebased event also notes its base.
    const payload =
      rebased &&
      typeof message.payload === "object" &&
      message.payload !== null &&
      !Array.isArray(message.payload)
        ? {
            ...(message.payload as Record<string, unknown>),
            rebasedFrom: message.base,
          }
        : message.payload;
    const previousTempo = this.timeKey();
    try {
      this.record = await appendSessionEvent(
        this.paths,
        this.record,
        {
          kind: message.kind,
          payload,
          id: message.key,
          ...(actor ? { actor } : {}),
          ...(operations ? { ops: operations } : {}),
        },
        next.toJSON(),
        historyHook(this.workspace, this.record.sessionId, {
          ...(client?.presence?.pane ? { letter: client.presence.pane } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof SessionConflictError) {
        // A file-fallback window wrote directly; adopt the disk state.
        await this.reload();
        this.broadcast({
          v: 1,
          type: "snapshot",
          record: this.record,
          digest: this.digest,
        });
        return {
          status: "rebase",
          baseRevision: message.base,
          currentRevision: this.record.revision,
          message: "session changed on disk; rebase",
        };
      }
      return {
        status: "rejected",
        code: "store",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.score = next;
    this.digest = compositionDigest(this.record.composition);
    this.keys.set(message.key, this.record.revision);
    if (retryKey) this.seqs.set(retryKey, this.record.revision);
    this.diskMtime = await this.recordMtime();
    const event = this.record.events[this.record.events.length - 1]!;
    this.broadcast({
      v: 1,
      type: "commit",
      event,
      composition: this.record.composition,
      digest: this.digest,
    });
    this.afterScoreChange(previousTempo);
    return { status: "accepted", revision: this.record.revision };
  }

  private rebaseReply(base: number, reason?: string): ApplyResult {
    return {
      status: "rebase",
      baseRevision: base,
      currentRevision: this.record.revision,
      message: `session is at rev ${this.record.revision}; rebase from rev ${base}${reason ? ` (${reason})` : ""}`,
    };
  }

  /** The score at an older revision, when the log still vouches for it. */
  private baseScore(revision: number): TrackScore | undefined {
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision >= this.record.revision ||
      this.record.revision - revision > MAX_REBASE_DISTANCE
    )
      return undefined;
    const composition = compositionAt(this.record, revision);
    if (composition === undefined) return undefined;
    try {
      return scoreFromJSON(composition);
    } catch {
      return undefined;
    }
  }

  /** Tempo and tempo map, compared to tell when the transport must follow. */
  private timeKey(): string {
    return JSON.stringify([this.score.tempoBpm, this.score.time ?? null]);
  }

  private afterScoreChange(previousTempo: string): void {
    if (this.timeKey() !== previousTempo) {
      this.clock.follow(this.score);
      this.broadcastTransport();
    }
    // Gapless: a streaming engine swaps the loop at the current beat
    // without restarting the player.
    if (this.clock.playing)
      void this.audio.play(this.score, this.clock.beatAt()).catch(() => {});
  }

  private transport(
    action: "play" | "pause" | "toggle" | "seek" | "tempo",
    beat?: number,
    bpm?: number,
  ): void {
    const play =
      action === "play" || (action === "toggle" && !this.clock.playing);
    const pause =
      action === "pause" || (action === "toggle" && this.clock.playing);
    if (play && !this.clock.playing) {
      this.clock.play();
      void this.audio.play(this.score, this.clock.beatAt()).catch(() => {});
    } else if (pause && this.clock.playing) {
      this.clock.pause();
      this.audio.stop();
    } else if (action === "seek" && beat !== undefined) {
      const now = Date.now();
      this.clock.sync(beat, this.clock.playing, now, now);
      this.audio.seek(this.clock.beatAt());
    } else if (action === "tempo" && bpm !== undefined) {
      this.clock.setTempo(bpm);
      this.clock.setTimeMap(transportMapFor(this.score));
    }
    this.broadcastTransport();
  }

  private transportState(): TransportState {
    const atMs = monotonicEpochMs();
    return {
      seq: this.seq,
      playing: this.clock.playing,
      beat: this.clock.beatAt(),
      bpm: this.score.tempoBpm,
      atMs,
      quantum: this.score.beatsPerBar,
    };
  }

  private broadcastTransport(): void {
    this.seq += 1;
    this.broadcast({ v: 1, type: "transport", ...this.transportState() });
  }

  private presence(): PresenceEntry[] {
    const entries: PresenceEntry[] = [];
    for (const client of this.clients)
      if (client.ready && client.presence) entries.push({ ...client.presence });
    return entries;
  }

  private broadcastPresence(): void {
    this.broadcast({ v: 1, type: "presence", clients: this.presence() });
  }

  private broadcast(message: ServerMessage): void {
    const frame = encodeFrame(message);
    for (const client of this.clients)
      if (client.ready) this.write(client, frame);
  }

  private send(client: Client, message: ServerMessage): void {
    this.write(client, encodeFrame(message));
  }

  private write(client: Client, frame: string): void {
    if (client.socket.destroyed) return;
    if (client.socket.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
      client.socket.destroy();
      return;
    }
    client.socket.write(frame);
  }

  private async reload(): Promise<void> {
    this.record = await loadSession<Composition>(this.paths);
    this.score = scoreFromJSON(this.record.composition);
    this.digest = compositionDigest(this.record.composition);
    this.keys.clear();
    this.seqs.clear();
    for (const event of this.record.events) {
      this.keys.set(event.id, event.revision);
      if (event.actor?.seq !== undefined)
        this.seqs.set(
          seqKey(event.actor.actorId, event.actor.clientId, event.actor.seq),
          event.revision,
        );
    }
    this.diskMtime = await this.recordMtime();
  }

  /** Adopt writes from windows that fell back to the file-lock path. */
  private async pollDisk(): Promise<void> {
    const mtime = await this.recordMtime();
    if (mtime === this.diskMtime) return;
    this.enqueue(async () => {
      const latest = await loadSession<Composition>(this.paths).catch(
        () => undefined,
      );
      this.diskMtime = await this.recordMtime();
      if (!latest) return;
      if (latest.revision <= this.record.revision) {
        // A file-fallback rename changes only metadata.
        if (
          latest.revision === this.record.revision &&
          latest.meta.version > this.record.meta.version
        ) {
          this.record = { ...this.record, meta: latest.meta };
          this.broadcast({ v: 1, type: "meta", meta: latest.meta });
        }
        return;
      }
      const previousTempo = this.timeKey();
      await this.reload();
      this.broadcast({
        v: 1,
        type: "snapshot",
        record: this.record,
        digest: this.digest,
      });
      this.afterScoreChange(previousTempo);
    });
  }

  private async recordMtime(): Promise<number> {
    try {
      return (await stat(this.paths.record)).mtimeMs;
    } catch {
      return 0;
    }
  }

  private armGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      if (this.clients.size === 0) void this.stop("idle");
    }, this.graceMs);
  }

  private async log(line: string): Promise<void> {
    const path = daemonLogPath(this.paths);
    try {
      if ((await stat(path)).size > MAX_LOG_BYTES) await truncate(path, 0);
    } catch {
      // Missing log file is created by the append below.
    }
    await appendFile(path, `${new Date().toISOString()} ${line}\n`).catch(
      () => undefined,
    );
  }
}

const OPERATION_TYPES = new Set([
  "addTrack",
  "addNote",
  "removeNote",
  "updateNote",
  "setTempo",
  "setBars",
  "updateTrack",
  "setAutomation",
  "clearTrack",
  "removeTrack",
  "moveTrack",
  "setKey",
  "setMeter",
  "setTime",
  "setTuning",
  "setMaster",
  "setCalibration",
  "setStyle",
  "setSections",
  "setLoop",
  "setClips",
  "setPatch",
  "setPatchNode",
  "setPatchCable",
  "setPatchMacro",
]);

/** Shape gate before the reducer, which validates every field it reads. */
/**
 * Serialized budget for payload plus derived ops; the store bounds the two
 * together at 64 KiB per event.
 */
const MAX_DERIVED_OPS_BYTES = 60 * 1024;

/**
 * The operations turning `before` into `after`, or undefined (a snapshot
 * event) when the change has no op form or is too large to log as ops.
 */
export function derivedOperations(
  before: TrackScore,
  after: TrackScore,
  budgetBytes = MAX_DERIVED_OPS_BYTES,
): ScoreOperation[] | undefined {
  let ops: readonly ScoreOperation[];
  try {
    ops = diffScores(before, after);
  } catch (error) {
    if (error instanceof DiffError) return undefined;
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(ops), "utf8") > budgetBytes)
    return undefined;
  return [...ops];
}

function parseOperation(value: unknown): ScoreOperation {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { type?: unknown }).type !== "string" ||
    !OPERATION_TYPES.has((value as { type: string }).type)
  )
    throw new Error("unsupported score operation");
  return value as ScoreOperation;
}

/** Entry point used by `src/daemon.ts`. Exits the process when done. */
export async function runDaemon(options: DaemonOptions): Promise<never> {
  const daemon = new DawgDaemon(options);
  // Install signal handlers before listening: a client can connect, finish,
  // and send SIGTERM before start() has returned.
  let started = false;
  let pendingSignal: string | undefined;
  const exit = (signal: string) => {
    if (!started) {
      pendingSignal = signal;
      return;
    }
    void daemon.stop(signal).finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => exit("SIGTERM"));
  process.on("SIGINT", () => exit("SIGINT"));
  process.on("SIGHUP", () => exit("SIGHUP"));
  try {
    started = await daemon.start();
  } catch (error) {
    process.stderr.write(`dawgd: ${String(error)}\n`);
    process.exit(1);
  }
  if (!started) process.exit(0); // Another daemon owns the session.
  if (pendingSignal) exit(pendingSignal);
  await daemon.stopped;
  process.exit(0);
}
