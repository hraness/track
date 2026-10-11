/**
 * The audition controller: a looping preview of the focused track, and the
 * staged edits it plays. Menus, pickers and `/try` call it; it owns no keys
 * of its own beyond what `auditionKey` maps, so any screen can plug it in.
 *
 *   Space    start or stop the loop (the track solo, or in context)
 *   a        A/B: the committed sound (A) or the staged one (B)
 *   c        context: the track alone or the full mix with it
 *   Enter    keep: every staged edit becomes ONE score operation
 *   Esc      revert the staged edits (then back, as usual)
 *
 * References: Ableton's browser preview and hot-swap (every hovered item is
 * heard on the loop; Esc puts the old one back), Elektron's compare and
 * reload (A/B against the saved kit, one key to restore it), Bitwig's
 * preset audition (the track's own notes, or a phrase when it has none),
 * and the OP-1/Torso habit of never stopping the sound between nudges.
 *
 * Staged edits are prompt commands replayed on top of the committed score,
 * so a staged change and a committed one are made by exactly the same code.
 * When another window commits meanwhile, `rebase` replays the commands on
 * its score (the staged values win on the rows they touch, like a later
 * edit would), and reports commands that no longer apply.
 *
 * Renders go through the host's `play`, which is the ordinary engine and
 * render worker with its stem cache: only the edited track's stem is
 * re-rendered, and the engine swaps the new loop in place at the same
 * position. At most one render is in flight; a held key's repeats coalesce
 * into the newest value, and a burst inside `debounceMs` renders once on
 * its trailing edge.
 */
import type { TrackScore } from "../../core/score.ts";
import {
  meterBar,
  previewScore,
  type Preview,
  type PreviewOptions,
  type SoundLevel,
} from "../audio/preview.ts";

/** What applying one command to a score (without committing) produced. */
export type StageResult = Readonly<{
  /** The new score; undefined when the command changed nothing or failed. */
  next?: TrackScore | undefined;
  ok: boolean;
  message: string;
}>;

export type AuditionHost = {
  /** Apply one prompt command to `base` without committing it. */
  apply(base: TrackScore, command: string): Promise<StageResult>;
  /** Start the loop, or swap the playing one in place. */
  play(score: TrackScore): Promise<void>;
  stop(): void;
  /** How far ahead of now new audio is queued (the engine lead). */
  leadMs(): number;
  now(): number;
  /** Playhead or cursor beat, to pick the bars a long song loops. */
  beat?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Called after any state change the screen should redraw for. */
  changed?(): void;
  /** Level of the loop now playing, for the title's meter. */
  level?(): SoundLevel | undefined;
  /**
   * A phrase that replaces the track's notes for the sound now playing (A:
   * committed, B: staged), or undefined for the usual loop. The chord
   * settings screen plays a progression with its settings this way.
   */
  phrase?(showing: "A" | "B"): PreviewOptions["phrase"];
  /**
   * The drive the song's master solved for its target on the full mix (the
   * last song loop), so previews hear a fixed master gain.
   */
  masterGainDb?(): number | undefined;
};

export type AuditionOptions = Readonly<{
  /** Renders within this window of the last one wait for its trailing edge. */
  debounceMs?: number;
}>;

/** A staged command; hovered items replace the previous hover of a kind. */
type Staged = Readonly<{ command: string; replaceKey?: string | undefined }>;

export type RebaseResult = Readonly<{
  /** Commands that no longer apply to the new score and were dropped. */
  dropped: readonly string[];
}>;

const DEFAULT_DEBOUNCE_MS = 40;
/** A stage still running after this long shows "fetching…". */
const FETCHING_AFTER_MS = 150;
/** The message of a hover skipped because a newer one replaced it. */
export const SUPERSEDED = "superseded";
const LATENCY_SAMPLES = 32;

export class Audition {
  /** True while the loop plays. */
  public looping = false;
  /** Full mix with the track instead of the track alone. */
  public context = false;
  /** Which sound plays while edits are staged: committed (A) or staged (B). */
  public showing: "A" | "B" = "B";
  /** Key-to-hear of the most recent render: render + swap + engine lead. */
  public lastLatencyMs: number | undefined;
  /** What the loop played last (region, notes or a default phrase). */
  public lastPreview: Preview | undefined;
  public readonly latencies: number[] = [];

  private committedScore: TrackScore;
  private stagedScore: TrackScore | undefined;
  private staged: Staged[] = [];
  private work: Promise<unknown> = Promise.resolve();
  private rendering = false;
  /** The song master's solved drive when the loop started (see host). */
  private masterGainDb: number | undefined;
  private dirty = false;
  private pendingKeyAt: number | undefined;
  private lastRenderAt = -Infinity;
  private timer: unknown;
  private readonly debounceMs: number;
  private readonly hoverSeq = new Map<string, number>();
  private pendingStages = 0;
  private pendingSince: number | undefined;
  /** Renders actually started (coalesced repeats do not count). */
  public renders = 0;

  public constructor(
    private readonly host: AuditionHost,
    committed: TrackScore,
    public trackId: string,
    options: AuditionOptions = {},
  ) {
    this.committedScore = committed;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** The committed score staged edits are made on. */
  public get committed(): TrackScore {
    return this.committedScore;
  }

  /** The staged score, or the committed one when nothing is staged. */
  public get score(): TrackScore {
    return this.stagedScore ?? this.committedScore;
  }

  /** What the loop plays now: A (committed) or B (staged). */
  public get sounding(): TrackScore {
    return this.showing === "A" ? this.committedScore : this.score;
  }

  public get dirtyEdits(): boolean {
    return this.stagedScore !== undefined && this.staged.length > 0;
  }

  public get commands(): readonly string[] {
    return this.staged.map((entry) => entry.command);
  }

  /** Edits stage (instead of committing) while the loop plays or some are staged. */
  public get staging(): boolean {
    return this.looping || this.dirtyEdits;
  }

  /** Resolves once every queued stage/rebase has finished. */
  public settled(): Promise<void> {
    return this.work.then(() => undefined);
  }

  // ── the loop ────────────────────────────────────────────────────────

  public start(): void {
    if (this.looping) return;
    this.masterGainDb = this.host.masterGainDb?.();
    this.looping = true;
    this.lastRenderAt = -Infinity;
    this.request();
  }

  public stop(): void {
    if (!this.looping) return;
    this.looping = false;
    this.dirty = false;
    this.pendingKeyAt = undefined;
    this.cancelTimer();
    this.host.stop();
    this.host.changed?.();
  }

  public toggle(): void {
    if (this.looping) this.stop();
    else this.start();
  }

  public toggleContext(): void {
    this.context = !this.context;
    this.request();
    this.host.changed?.();
  }

  /**
   * Whether the loop plays the full mix: the `c` toggle, or forced while a
   * master edit is staged, because the master works on the whole mix and a
   * solo track says nothing about its loudness.
   */
  public get inContext(): boolean {
    return (
      this.context ||
      this.staged.some((entry) => MASTER_COMMAND.test(entry.command))
    );
  }

  /** A/B; a no-op (stays on B) while nothing is staged. */
  public toggleAB(): void {
    if (!this.dirtyEdits) {
      this.showing = "B";
      return;
    }
    this.showing = this.showing === "A" ? "B" : "A";
    this.request();
    this.host.changed?.();
  }

  /** Focus moved to another track: staged edits stay with their track. */
  public focus(trackId: string): void {
    if (trackId === this.trackId) return;
    this.trackId = trackId;
    this.request();
  }

  // ── staging ─────────────────────────────────────────────────────────

  /**
   * Stage `command` on top of the staged score. With `replaceKey`, a
   * previous staged command with the same key is replaced instead (moving
   * through a picker auditions one item at a time, not a stack of them).
   */
  public stage(
    command: string,
    options: { replaceKey?: string; superseded?: () => boolean } = {},
  ): Promise<StageResult> {
    const keyAt = this.host.now();
    if (this.pendingStages++ === 0) this.pendingSince = keyAt;
    const run = this.work.then(async (): Promise<StageResult> => {
      if (options.superseded?.()) return { ok: false, message: SUPERSEDED };
      const replaceKey = options.replaceKey;
      const replacing =
        replaceKey !== undefined &&
        this.staged.some((entry) => entry.replaceKey === replaceKey);
      if (replacing) {
        const kept = this.staged.filter(
          (entry) => entry.replaceKey !== replaceKey,
        );
        const replay = await this.replay(this.committedScore, kept);
        const result = await this.host.apply(replay.score, command);
        if (options.superseded?.()) return { ok: false, message: SUPERSEDED };
        if (!result.ok) return result;
        this.staged = [...replay.kept, { command, replaceKey }];
        this.stagedScore = result.next ?? replay.score;
      } else {
        const result = await this.host.apply(this.score, command);
        if (options.superseded?.()) return { ok: false, message: SUPERSEDED };
        if (!result.ok || !result.next) return result;
        this.staged.push({ command, replaceKey });
        this.stagedScore = result.next;
      }
      this.showing = "B";
      this.request(keyAt);
      this.host.changed?.();
      return { ok: true, message: command, next: this.stagedScore };
    });
    const done = run.finally(() => {
      if (--this.pendingStages === 0) this.pendingSince = undefined;
    });
    this.work = done.catch(() => undefined);
    return done;
  }

  /**
   * Audition a picker's highlighted item: it replaces the previous hover
   * of `key`, and a hover overtaken by a newer one before it ran is
   * skipped, so moving fast through a list (or a slow pack fetch) never
   * queues a backlog: the latest item plays.
   */
  public hover(command: string, key: string): Promise<StageResult> {
    const seq = (this.hoverSeq.get(key) ?? 0) + 1;
    this.hoverSeq.set(key, seq);
    return this.stage(command, {
      replaceKey: key,
      superseded: () => this.hoverSeq.get(key) !== seq,
    });
  }

  /** Leave a picker without choosing: drop its hover, keep other edits. */
  public unhover(key: string): Promise<void> {
    this.hoverSeq.set(key, (this.hoverSeq.get(key) ?? 0) + 1);
    const run = this.work.then(async () => {
      if (!this.staged.some((entry) => entry.replaceKey === key)) return;
      const replay = await this.replay(
        this.committedScore,
        this.staged.filter((entry) => entry.replaceKey !== key),
      );
      this.staged = replay.kept;
      this.stagedScore = replay.kept.length ? replay.score : undefined;
      this.showing = "B";
      this.request();
      this.host.changed?.();
    });
    this.work = run.catch(() => undefined);
    return run;
  }

  /** Choosing a hovered item makes it an ordinary staged edit. */
  public settle(key: string): void {
    this.hoverSeq.set(key, (this.hoverSeq.get(key) ?? 0) + 1);
    this.staged = this.staged.map((entry) =>
      entry.replaceKey === key ? { command: entry.command } : entry,
    );
  }

  /** A stage (a pack fetch, say) has been running long enough to show. */
  public get fetching(): boolean {
    return (
      this.pendingSince !== undefined &&
      this.host.now() - this.pendingSince >= FETCHING_AFTER_MS
    );
  }

  /** Drop every staged edit; the loop plays the committed sound again. */
  public revert(): void {
    const had = this.dirtyEdits;
    this.staged = [];
    this.stagedScore = undefined;
    this.showing = "B";
    if (had) this.request();
    this.host.changed?.();
  }

  /**
   * Take the staged edits for one commit, leaving nothing staged. The caller
   * commits `score` as one operation, then calls `committedNow` with it.
   */
  public take(): { score: TrackScore; commands: string[] } | undefined {
    if (!this.dirtyEdits || !this.stagedScore) return undefined;
    const taken = { score: this.stagedScore, commands: [...this.commands] };
    this.staged = [];
    this.stagedScore = undefined;
    this.showing = "B";
    return taken;
  }

  /** The committed score moved (this window's commit, undo, a reload). */
  public committedNow(score: TrackScore): void {
    if (score === this.committedScore) return;
    this.committedScore = score;
    if (!this.dirtyEdits) this.request();
  }

  /**
   * Another window committed: replay the staged commands on its score.
   * Commands that fail there are dropped and reported.
   */
  public rebase(score: TrackScore): Promise<RebaseResult> {
    const run = this.work.then(async (): Promise<RebaseResult> => {
      this.committedScore = score;
      if (this.staged.length === 0) {
        this.stagedScore = undefined;
        this.request();
        return { dropped: [] };
      }
      const replay = await this.replay(score, this.staged);
      this.staged = replay.kept;
      this.stagedScore = replay.kept.length ? replay.score : undefined;
      if (!this.stagedScore) this.showing = "B";
      this.request();
      this.host.changed?.();
      return { dropped: replay.dropped };
    });
    this.work = run.catch(() => undefined);
    return run;
  }

  private async replay(
    base: TrackScore,
    entries: readonly Staged[],
  ): Promise<{ score: TrackScore; kept: Staged[]; dropped: string[] }> {
    let score = base;
    const kept: Staged[] = [];
    const dropped: string[] = [];
    for (const entry of entries) {
      const result = await this.host.apply(score, entry.command);
      if (!result.ok) {
        dropped.push(entry.command);
        continue;
      }
      kept.push(entry);
      if (result.next) score = result.next;
    }
    return { score, kept, dropped };
  }

  // ── rendering ───────────────────────────────────────────────────────

  /** Re-render the loop (when it plays), debounced and coalesced. */
  public request(keyAt = this.host.now()): void {
    if (!this.looping) return;
    this.pendingKeyAt ??= keyAt;
    if (this.rendering) {
      this.dirty = true;
      return;
    }
    const wait = this.lastRenderAt + this.debounceMs - this.host.now();
    if (wait > 0 && this.host.setTimer) {
      if (this.timer === undefined)
        this.timer = this.host.setTimer(() => {
          this.timer = undefined;
          void this.flush();
        }, wait);
      return;
    }
    void this.flush();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.host.clearTimer?.(this.timer);
    this.timer = undefined;
  }

  private async flush(): Promise<void> {
    if (!this.looping || this.rendering) return;
    this.cancelTimer();
    const phrase = this.host.phrase?.(this.dirtyEdits ? this.showing : "A");
    // A staged master edit re-solves its target on the mix; otherwise the
    // master plays at the song's solved drive, so a track edit is audible.
    const masterStaged = this.staged.some((entry) =>
      MASTER_COMMAND.test(entry.command),
    );
    const preview = previewScore(this.sounding, this.trackId, {
      context: this.inContext,
      beat: this.host.beat?.() ?? 0,
      ...(phrase ? { phrase } : {}),
      ...(this.masterGainDb !== undefined && !masterStaged
        ? { masterGainDb: this.masterGainDb }
        : {}),
    });
    if (!preview) return;
    this.rendering = true;
    this.dirty = false;
    const keyAt = this.pendingKeyAt;
    this.pendingKeyAt = undefined;
    this.lastRenderAt = this.host.now();
    this.renders += 1;
    this.lastPreview = preview;
    try {
      await this.host.play(preview.score);
      if (keyAt !== undefined && this.looping) {
        const latency = this.host.now() - keyAt + this.host.leadMs();
        this.lastLatencyMs = latency;
        this.latencies.push(latency);
        if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift();
      }
    } catch {
      // A failed render keeps the previous loop; the next edit retries.
    } finally {
      this.rendering = false;
    }
    this.host.changed?.();
    if (this.dirty && this.looping) this.request(this.pendingKeyAt);
  }

  // ── what the screen shows ───────────────────────────────────────────

  /**
   * One status line: `♪ solo · B staged 2 · 42 ms`, or undefined when the
   * loop is off and nothing is staged.
   */
  public status(): string | undefined {
    if (!this.looping && !this.dirtyEdits && !this.fetching) return undefined;
    const parts: string[] = [];
    if (this.looping) parts.push(`♪ ${this.inContext ? "in context" : "solo"}`);
    else parts.push("loop off");
    if (this.fetching) parts.push("fetching…");
    if (this.dirtyEdits)
      parts.push(
        this.showing === "A" ? "A committed" : `B staged ${this.staged.length}`,
      );
    if (this.looping && this.lastLatencyMs !== undefined)
      parts.push(`${Math.round(this.lastLatencyMs)} ms`);
    const level = this.looping ? this.host.level?.() : undefined;
    if (level) parts.push(levelMeter(level));
    return parts.join(" · ");
  }

  /** Footer keys for an auditioning screen (fits 80 columns). */
  public hint(): string {
    const loop = this.looping ? "space stop" : "space hear";
    return this.dirtyEdits
      ? ` ${loop} · a A/B · c context · enter keep · esc revert · ? keys `
      : ` ${loop} · ←→ adjust · c context · esc back · ? keys `;
  }
}

/**
 * `█████··· -9 dB`: RMS as an 8-cell bar over -48..0 dBFS, the peak as a
 * number, and `!` in the last cell when the loop clips.
 */
export function levelMeter(level: SoundLevel): string {
  const peak = level.peakDb <= -119 ? "-∞" : String(Math.round(level.peakDb));
  return `${meterBar(level.rmsDb, 8, level.clipped > 0)} ${peak} dB`;
}

/** What an audition key does in a screen that hosts the controller. */
export type AuditionKey = "loop" | "ab" | "context";

/** Space, `a` and `c`; undefined for every other key. */
export function auditionKey(value: string): AuditionKey | undefined {
  if (value === " ") return "loop";
  if (value === "a") return "ab";
  if (value === "c") return "context";
  return undefined;
}

/**
 * Commands that change how the focused track sounds, and so stage while
 * auditioning; everything else (transport, notes, tracks, tempo) runs as
 * before.
 */
const STAGEABLE =
  /^\/?(?:(clip|fx|effects|filter|lowpass|vocoder(?!\s+new\s*$)|formant|vowel|synth|string|bowed|modal|wind|sing|note\s+vowel|wt|wavetable|grain|kit|instrument|vol|volume|pan|gain|speed|warpmode|root|pattern|euclid|art|articulation|bend|vibrato|glide|portamento|velcurve|vel-curve|pedal|sustain|humanize|tuning|tune|master|keys|piano|epiano|rhodes|wurli|wurlitzer|clav|clavinet)\s+\S|pack\s+use\s+\S|(?:piano|grand|upright|felt|honkytonk|prepared|ballad)(?:\s+piano)?\s*$|(?:epiano|rhodes|suitcase|dyno|wurli|wurlitzer|clav|clavinet|funkclav)\s*$|(?:tonewheel|hammond|b3|gospel|jazzorgan|combo|farfisa|vox|pipe|church|pipeorgan|churchorgan|flutes|cornet|reeds|celeste)(?:\s+\S.*)?$|rotary\s+(?:slow|fast|stop)\s*$|patch\s+(?:add|set|knob|wire|unwire|rm|macro|rate)\s+\S|preset\s+(?!(?:list|ls|find|search|info|show|similar|fav|favs|favorites|starred|browse)\b)[a-z0-9][a-z0-9-]*\s*$)/i;
/** Subcommands that list or show instead of changing the sound. */
const READ_ONLY = /^\/?\S+\s+(list|show|info|help|measure|meter|presets?)\s*$/i;
/** `master <unit>` alone only shows the unit. */
const MASTER_SHOW = /^\/?master\s+(eq|glue|tape|width|limiter)\s*$/i;
const MASTER_COMMAND = /^\/?master\s/i;

export function isStageable(command: string): boolean {
  const text = command.trim();
  return (
    STAGEABLE.test(text) && !READ_ONLY.test(text) && !MASTER_SHOW.test(text)
  );
}

/**
 * Chord settings and the song key, which stage only in the chord settings
 * screen: its loop plays a progression with them (`AuditionHost.phrase`),
 * while elsewhere they would change nothing audible.
 */
export function isChordStageable(command: string): boolean {
  return (
    /^\/chords\s+\S/i.test(command.trim()) || /^key\s+\S/i.test(command.trim())
  );
}
