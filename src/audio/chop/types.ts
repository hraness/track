/**
 * The audio chop toolkit's public shapes, shared by its three doors: the
 * agent `audio` tool, typed `/chop …` and `dawg media chop …`. Every door
 * calls `runChop(op, args, ctx)` (`run.ts`), so behaviour is identical.
 */
import type { HistoryActor, HistoryHandle } from "../../history/types.ts";
import type { CommandRunner } from "../../auth/runner.ts";
import type { Tempo, TimeSpec } from "./time.ts";

export type { Tempo, TimeSpec };

export const CHOP_OPS = Object.freeze([
  "info",
  "peaks",
  "onsets",
  "beats",
  "segments",
  "find",
  "cut",
  "slice",
  "trim",
  "pad",
  "shift",
  "loop",
  "concat",
  "mix",
  "stretch",
  "pitch",
  "fade",
  "normalize",
  "gain",
  "reverse",
  "filter",
  "convert",
  "resample",
  "split",
  "audition",
] as const);
export type ChopOp = (typeof CHOP_OPS)[number];

/** Ops that only read; they never write a file. */
export const CHOP_ANALYSIS_OPS: ReadonlySet<ChopOp> = new Set<ChopOp>([
  "info",
  "peaks",
  "onsets",
  "beats",
  "segments",
  "find",
  "audition",
]);

export const CHOP_SNAPS = Object.freeze([
  "zero",
  "onset",
  "beat",
  "none",
] as const);
export const CHOP_METHODS = Object.freeze([
  "silence",
  "onset",
  "section",
  "beats",
  "grid",
] as const);
export const CHOP_CURVES = Object.freeze([
  "linear",
  "exp",
  "log",
  "scurve",
] as const);
export const CHOP_FILTERS = Object.freeze([
  "highpass",
  "lowpass",
  "bandpass",
] as const);
export const CHOP_FORMATS = Object.freeze(["wav", "flac", "mp3"] as const);

export type ChopArgs = Readonly<{
  /** Project-relative (or downloads-relative) path; WAV natively, other formats via ffmpeg. */
  input?: string;
  /** Default `<outDir>/<stem>-<op>[-n].wav`; must be inside the write scope. */
  output?: string;
  from?: TimeSpec;
  to?: TimeSpec;
  /** Default zero for cut/slice/trim/loop. */
  snap?: (typeof CHOP_SNAPS)[number];
  method?: (typeof CHOP_METHODS)[number];
  /** slice/segments: N regions (grid) or a cap; find: top N; peaks: bins (≤ 200). */
  count?: number;
  thresholdDb?: number;
  minMs?: number;
  /** stretch: duration multiplier 0.25..4. */
  ratio?: number;
  fromBpm?: number;
  toBpm?: number;
  /** pitch: -24..24 (fractional = cents). */
  semitones?: number;
  preserve?: "formant" | "none";
  fadeIn?: TimeSpec;
  fadeOut?: TimeSpec;
  curve?: (typeof CHOP_CURVES)[number];
  targetDb?: number;
  /** normalize: true = rms instead of peak. */
  rms?: boolean;
  db?: number;
  offset?: TimeSpec;
  crossfadeMs?: number;
  type?: (typeof CHOP_FILTERS)[number];
  hz?: number;
  q?: number;
  format?: (typeof CHOP_FORMATS)[number];
  sampleRate?: number;
  channels?: 1 | 2;
  inputs?: readonly string[];
  gains?: readonly number[];
  offsets?: readonly TimeSpec[];
  reference?: Readonly<{ input?: string; from: TimeSpec; to: TimeSpec }>;
  /** slice: also build sampler voices on this track (doors that can commit). */
  track?: string;
  /** slice with track: also write trigger notes at the original onsets. */
  pattern?: boolean;
  sensitivity?: number;
}>;

export type ChopOutput = Readonly<{
  path: string;
  sha256: string;
  seconds: number;
  peakDb: number;
  /** slice: where this piece sat in the input, seconds. */
  from?: number;
  to?: number;
}>;

export type ChopPoint = Readonly<{
  t: number;
  end?: number;
  strength?: number;
  score?: number;
  label?: string;
}>;

export type AudioInfo = Readonly<{
  path: string;
  seconds: number;
  sampleRate: number;
  channels: number;
  format: string;
  peakDb: number;
  rmsDb: number;
  bpm?: number;
  sha256: string;
}>;

export type ChopResult = Readonly<{
  op: ChopOp;
  outputs: readonly ChopOutput[];
  points?: readonly ChopPoint[];
  /** ≤ 2 KiB: bins plus a one-line strip so a model can "see" the file. */
  peaks?: Readonly<{ bins: readonly number[]; text: string }>;
  info?: AudioInfo;
  bpm?: number;
  /** Set only when a file was longer than the 30 min hard cap. */
  truncated?: Readonly<{ analysedSeconds: number; totalSeconds: number }>;
  backend: "ts" | "ffmpeg" | "rubberband";
  /** One line. */
  summary: string;
  /** Overwritten files: where the prior copy went. */
  trashed?: readonly Readonly<{ path: string; copy: string; sha256: string }>[];
}>;

/**
 * History (lane hist, `src/history/types.ts`): the subset of
 * `HistoryHandle` the toolkit needs. Doors pass a handle when they hold
 * one; otherwise `historySink()` (set when a session opens) is used, and
 * with neither nothing is recorded.
 */
export type ChopHistory = Pick<HistoryHandle, "append">;

export type ChopActor = HistoryActor;

export type ChopContext = Readonly<{
  /** Absolute project root. */
  root: string;
  /** Project-relative output check; default refuses .dawg/, .git/, node_modules/. */
  writeScope?: (rel: string) => boolean;
  runner: CommandRunner;
  signal: AbortSignal;
  /** Default output folder, project-relative (default `samples`). */
  outDir?: string;
  /** Focused track slug, so `tracks/<slug>/downloads/<file>` resolves. */
  trackSlug?: string;
  tempo?: Tempo;
  history?: ChopHistory;
  actor?: ChopActor;
  /** Plays a file (or a range) through the preview player; absent = no audio. */
  audition?: (path: string, from?: number, to?: number) => Promise<void>;
  /** ASCII-only peak strip (NO_COLOR/mono terminals use it too). */
  ascii?: boolean;
  progress?: (line: string) => void;
}>;
