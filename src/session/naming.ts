/**
 * Token-efficient session auto-naming.
 *
 * Every accepted turn updates a local *musical fingerprint* (tempo, a key
 * estimate from the pitch-class histogram, each track's role and instrument,
 * note density, register, and effects). A model call happens only when that
 * fingerprint differs from the one the current name was chosen for, and at
 * most every `minTurns` turns unless the track or instrument set changed.
 * The request is ~120 tokens in and 12 out, asks the model to echo the
 * current name when it still fits (hysteresis), and is applied as a
 * conditional write so a user `/rename` always wins.
 */
import { createHash } from "node:crypto";
import type { TrackScore } from "../../core/score.ts";
import { isDrumInstrument } from "../../core/drums.ts";
import { estimateKey } from "../../core/key.ts";

export { estimateKey };
import type { ProviderSelection } from "../agent/provider.ts";
import {
  DEFAULT_SESSION_NAME,
  splitNameNumber,
  uniqueName,
  withNumber,
  type MetaExpect,
  type MetaPatch,
  type SessionMeta,
} from "./meta.ts";

export const NAME_MAX_TOKENS = 12;
export const NAME_TEMPERATURE = 0.3;
const PROMPT_SNIPPET_CHARS = 60;

export type TrackRole = "drums" | "bass" | "keys" | "lead";

export type Fingerprint = {
  /** Human-readable summary sent to the model. */
  line: string;
  /** Hash of `line`; equal scores always hash equally. */
  hash: string;
  /** Hash of the track-and-instrument set only. */
  structure: string;
  bpm: number;
  key: string | null;
  roles: TrackRole[];
  busy: boolean;
};

/**
 * Pure and order-independent: note ids, note order and track names do not
 * affect it, so the same music always yields the same hash.
 */
export function musicalFingerprint(score: TrackScore): Fingerprint {
  const bpm = Math.round(score.tempoBpm);
  const bars = Math.max(1, score.bars);
  const histogram = new Array<number>(12).fill(0);
  const parts: string[] = [];
  const roles: TrackRole[] = [];
  const effects = new Set<string>();
  let busy = false;
  const tracks = [...score.tracks].sort((a, b) => a.id.localeCompare(b.id));
  for (const track of tracks) {
    const notes = score.notes.filter((note) => note.trackId === track.id);
    const drums = isDrumInstrument(track.instrument);
    if (!drums)
      for (const note of notes)
        histogram[note.pitch % 12]! += note.durationTicks / score.ticksPerBeat;
    const perBar = notes.length / bars;
    const density =
      notes.length === 0
        ? "empty"
        : perBar < 2
          ? "sparse"
          : perBar < 6
            ? "steady"
            : "busy";
    if (density === "busy") busy = true;
    const pitches = notes.map((note) => note.pitch).sort((a, b) => a - b);
    const median = pitches.length ? pitches[pitches.length >> 1]! : 60;
    const register = median < 48 ? "low" : median <= 72 ? "mid" : "high";
    const role: TrackRole = drums
      ? "drums"
      : register === "low"
        ? "bass"
        : register === "high"
          ? "lead"
          : "keys";
    if (notes.length > 0) roles.push(role);
    if (track.filter) effects.add("filter");
    if (track.delay) effects.add("delay");
    if (track.reverb) effects.add("reverb");
    for (const name of Object.keys(track.fx ?? {})) effects.add(name);
    if (track.volumeAutomation.length || track.panAutomation.length)
      effects.add("automation");
    if (
      track.filterAutomation?.length ||
      track.resonanceAutomation?.length ||
      track.delayFeedbackAutomation?.length ||
      track.delayMixAutomation?.length ||
      Object.keys(track.fxAutomation ?? {}).length
    )
      effects.add("sweep");
    const instrument = track.instrument.toLowerCase().slice(0, 24);
    parts.push(
      drums
        ? `drums(${instrument},${density})`
        : `${role}(${instrument},${register},${density})`,
    );
  }
  // A tuned song is named by its tuning (`pelog`), not a guessed 12-TET key.
  const tuned = score.tuning
    ? (score.tuning.name ??
      (score.tuning.edo ? `${score.tuning.edo}-edo` : "tuned"))
    : undefined;
  const key = score.key
    ? score.key.toLowerCase()
    : (tuned?.toLowerCase() ?? estimateKey(histogram));
  const line = [
    `${bpm} bpm`,
    key ?? "no key",
    parts.join(" ") || "no tracks",
    effects.size ? `fx ${[...effects].sort().join(" ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const structure = tracks
    .map((track) => `${track.id}=${track.instrument.toLowerCase()}`)
    .join(",");
  return {
    line,
    hash: shortHash(line),
    structure: shortHash(structure),
    bpm,
    key,
    roles: [...new Set(roles)],
    busy,
  };
}

/** Deterministic offline name, e.g. "a minor bass groove" or "128 bpm drums + keys". */
export function localName(fingerprint: Fingerprint): string {
  const roles = fingerprint.roles;
  if (roles.length === 0) return DEFAULT_SESSION_NAME;
  const pitched = roles.filter((role) => role !== "drums");
  if (fingerprint.key && pitched.length > 0) {
    const lead = pitched.includes("bass") ? "bass" : pitched[0]!;
    const vibe =
      roles.includes("drums") || fingerprint.busy ? "groove" : "loop";
    return `${fingerprint.key} ${lead} ${vibe}`;
  }
  return `${fingerprint.bpm} bpm ${roles.join(" + ")}`;
}

/**
 * Validates untrusted model output: lowercase, only `[a-z0-9 '-]`, 3 to 32
 * characters, at most 4 words. Returns undefined when it does not fit.
 */
export function sanitizeGeneratedName(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const firstLine = text.slice(0, 256).split(/\r?\n/)[0] ?? "";
  const name = firstLine
    .toLowerCase()
    .replace(/^name\s*:\s*/, "")
    .replace(/[^a-z0-9 '-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^['\s-]+|['\s-]+$/g, "")
    .trim();
  if (name.length < 3 || name.length > 32) return undefined;
  if (name.split(" ").length > 4) return undefined;
  return name;
}

export function namingPrompt(
  fingerprint: Fingerprint,
  recentPrompts: readonly string[],
  currentName: string,
): string {
  const recent = recentPrompts
    .slice(-2)
    .map((prompt) => {
      const flat = prompt.replace(/\s+/g, " ").trim();
      return `"${flat.length > PROMPT_SNIPPET_CHARS ? flat.slice(0, PROMPT_SNIPPET_CHARS) : flat}"`;
    })
    .join(" | ");
  return [
    "Name this music session: 2-4 lowercase words evoking the vibe; reply with the current name exactly if it still fits; no quotes.",
    `music: ${fingerprint.line}`,
    `recent: ${recent || "none"}`,
    `current name: ${currentName === DEFAULT_SESSION_NAME ? "none" : currentName}`,
  ].join("\n");
}

/** The model seam. Implementations must not throw synchronously. */
export interface NameGenerator {
  generate(
    prompt: string,
    options: { maxTokens: number; temperature: number; signal: AbortSignal },
  ): Promise<string>;
}

/**
 * Default generator: `generateText` on the configured provider (gateway
 * haiku-4.5 or the selected xcb account). It throws when offline, which the
 * namer turns into the local fingerprint name. `generateText` has no
 * temperature knob, so `temperature` is advisory here.
 */
export function providerNameGenerator(
  selection: () => Promise<ProviderSelection>,
  timeoutMs = 15_000,
): NameGenerator {
  return {
    async generate(prompt, options) {
      const selected = await selection();
      if (selected.kind === "offline") throw new Error(selected.reason);
      const { generateText } = await import("../agent/provider.ts");
      return generateText(prompt, {
        maxTokens: options.maxTokens,
        signal: options.signal,
        timeoutMs,
        selection: selected,
      });
    },
  };
}

/** Where the namer reads and conditionally writes session metadata. */
export interface NamingTarget {
  meta(): SessionMeta;
  updateMeta(
    patch: MetaPatch,
    expect: MetaExpect,
  ): Promise<{ status: "applied" | "stale"; meta: SessionMeta }>;
  /** Names of other sessions in the workspace, for collision suffixes. */
  otherNames(): Promise<string[]>;
  /**
   * The session's score now and its revision. When given, a run names this
   * score and writes only if the revision still matches, so of several
   * windows naming one session, one name per revision wins and a run that
   * read an older score is dropped instead of overwriting a newer name.
   */
  current?(): { score: TrackScore; revision: number };
}

export type AutoNamerOptions = {
  target: NamingTarget;
  /** Omit for offline: names come from the local fingerprint only. */
  generator?: NameGenerator | undefined;
  delayMs?: number;
  minTurns?: number;
  timeoutMs?: number;
  onRename?: (name: string, source: "model" | "local") => void;
};

export type NamerStats = {
  /** Model requests issued. */
  calls: number;
  /** Runs that wrote a name (model or local). */
  renames: number;
  /** Runs skipped because the fingerprint was unchanged. */
  unchanged: number;
  /** Runs deferred by the every-N-turns limit. */
  deferred: number;
  /** In-flight results dropped because the name changed meanwhile. */
  dropped: number;
};

/**
 * Debounced, single-flight auto-namer. `noteTurn` is synchronous and never
 * blocks the prompt; work happens on a timer.
 */
export class AutoNamer {
  public readonly stats: NamerStats = {
    calls: 0,
    renames: 0,
    unchanged: 0,
    deferred: 0,
    dropped: 0,
  };
  private readonly delayMs: number;
  private readonly minTurns: number;
  private readonly timeoutMs: number;
  private readonly recent: string[] = [];
  private score: TrackScore | undefined;
  private turnsSinceName = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private rerun = false;
  /** One retry per trigger after a run went stale on the score revision. */
  private retried = false;
  private disposed = false;
  private readonly controller = new AbortController();

  public constructor(private readonly options: AutoNamerOptions) {
    this.delayMs = options.delayMs ?? 3_000;
    this.minTurns = Math.max(1, options.minTurns ?? 3);
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Call after a turn; `accepted` is false when it committed nothing. */
  public noteTurn(turn: {
    score: TrackScore;
    prompt: string;
    accepted: boolean;
  }): void {
    if (this.disposed || !turn.accepted) return;
    this.recent.push(turn.prompt.slice(0, 256));
    if (this.recent.length > 2) this.recent.shift();
    this.score = turn.score;
    this.turnsSinceName += 1;
    if (this.options.target.meta().nameSource !== "auto") return;
    // Coalesce bursts: each accepted turn restarts the quiet period.
    this.retried = false;
    this.schedule();
  }

  /** After `/rename --auto`: name soon from `score`, bypassing the turn limit. */
  public request(score: TrackScore): void {
    if (this.disposed) return;
    this.score = score;
    this.turnsSinceName = this.minTurns;
    this.retried = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.kick();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Resolves when no run is pending or in flight (for tests and exit). */
  public async idle(): Promise<void> {
    for (;;) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
        await this.kick();
      }
      while (this.running) await this.running;
      if (!this.timer) return;
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller.abort();
  }

  private kick(): Promise<void> {
    if (this.running) {
      // At most one request in flight; fold this trigger into a rerun.
      this.rerun = true;
      return this.running;
    }
    this.running = this.run()
      .catch(() => undefined)
      .finally(() => {
        this.running = undefined;
        if (this.rerun && !this.disposed) {
          this.rerun = false;
          void this.kick();
        }
      });
    return this.running;
  }

  private async run(): Promise<void> {
    if (!this.score || this.disposed) return;
    const now = this.options.target.current?.();
    const score = now?.score ?? this.score;
    const meta = this.options.target.meta();
    if (meta.nameSource !== "auto") return;
    const fingerprint = musicalFingerprint(score);
    if (fingerprint.hash === meta.namedFingerprint) {
      this.stats.unchanged += 1;
      return;
    }
    const structureChanged = fingerprint.structure !== meta.namedStructure;
    if (
      meta.namedFingerprint !== undefined &&
      !structureChanged &&
      this.turnsSinceName < this.minTurns
    ) {
      this.stats.deferred += 1;
      return;
    }
    // Forks keep their ` N` suffix; the model sees only the base.
    const split = meta.forkOf ? splitNameNumber(meta.name) : undefined;
    const currentBase = split && split.n > 1 ? split.base : meta.name;
    let candidate: string | undefined;
    let source: "model" | "local" = "local";
    if (this.options.generator) {
      this.stats.calls += 1;
      try {
        const signal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(this.timeoutMs),
        ]);
        const text = await this.options.generator.generate(
          namingPrompt(fingerprint, this.recent, currentBase),
          {
            maxTokens: NAME_MAX_TOKENS,
            temperature: NAME_TEMPERATURE,
            signal,
          },
        );
        candidate = sanitizeGeneratedName(text);
        if (candidate) source = "model";
      } catch {
        // Offline, unauthorized, timed out: fall back to the local name.
      }
    }
    if (this.disposed) return;
    candidate ??= localName(fingerprint);
    let name =
      candidate === currentBase
        ? meta.name
        : split && split.n > 1
          ? withNumber(candidate, split.n)
          : candidate;
    if (name !== meta.name) {
      const others = await this.options.target.otherNames().catch(() => []);
      name = uniqueName(name, others);
    }
    const patch: MetaPatch = {
      namedFingerprint: fingerprint.hash,
      namedStructure: fingerprint.structure,
    };
    if (name !== meta.name) patch.name = name;
    const expect: MetaExpect = { name: meta.name, nameSource: "auto" };
    if (now) expect.revision = now.revision;
    const result = await this.options.target.updateMeta(patch, expect);
    if (result.status === "stale") {
      this.stats.dropped += 1;
      // Only the score moved on (a newer edit, or play/stop from any
      // window): name the newer revision once more after the quiet period.
      // A changed name or a user rename is final.
      if (
        now &&
        !this.retried &&
        result.meta.name === meta.name &&
        result.meta.nameSource === "auto"
      ) {
        this.retried = true;
        this.schedule();
      }
      return;
    }
    this.turnsSinceName = 0;
    if (patch.name !== undefined) {
      this.stats.renames += 1;
      this.options.onRename?.(patch.name, source);
    }
  }
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
