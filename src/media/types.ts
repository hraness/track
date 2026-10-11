/**
 * Shared types for the local media tools (`download_audio`, `split_stems`,
 * `analyze_audio`, `transcribe_notes`, `import_sample`, `transcribe_lyrics`).
 *
 * Nothing here imports the agent, so `src/agent/tools.ts` can reference these
 * types without a cycle. Every tool runs through a `MediaRunContext` that the
 * host supplies (project root, focused track slug, subprocess runner, fetch),
 * which is what lets tests script yt-dlp, ffprobe, demucs and StemDeck.
 */
import type { ChopHistory } from "../audio/chop/types.ts";
import type { CommandRunner } from "../auth/runner.ts";

/** One transcribed note or drum hit, in source seconds. */
export type TimedNote = Readonly<{
  pitch: number;
  startSeconds: number;
  endSeconds: number;
  /** 0..1, the scale `note()` and `hit()` use. */
  velocity: number;
  /** Model confidence 0..1 when the transcriber reports one. */
  confidence?: number;
  /** Heuristic ranking score 0..1 for classifier output. */
  heuristicScore?: number;
}>;

/** A beat grid in source seconds; `bars` mark downbeats by beat index. */
export type BeatGrid = Readonly<{
  beats: readonly number[];
  bars: readonly Readonly<{ beat: number; beatsPerBar: number }>[];
  durationSeconds: number;
  bpm?: number;
  detector?: string;
  confidence?: number;
  intervalCv?: number;
}>;

/**
 * Services the agent host lends the media tools. The project root and track
 * slug come from the workspace tools (`AgentHost.workspace` and the focused
 * track), so media outputs share their write scope.
 */
export type MediaServices = Readonly<{
  runner: CommandRunner;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  /** Overrides `$HOME` for model caches (`~/.cache/dawg`). */
  homeDir?: string;
  /**
   * History handle for the audio toolkit's asset rows (`audio`, `exec`).
   * Unset means the process-global `historySink()`.
   */
  chopHistory?: ChopHistory;
}>;

/** What every media tool runs with. Paths are absolute. */
export type MediaHost = MediaServices &
  Readonly<{
    /** Workspace root; media outputs live under `tracks/<slug>/downloads/`. */
    projectRoot: string;
    /** `trackSlug()` of the focused track's name, as the workspace tools use. */
    trackSlug: string;
  }>;

export type MediaRunContext = MediaHost &
  Readonly<{
    signal: AbortSignal;
    /** Short progress line for the activity feed, e.g. `demucs 42%`. */
    progress: (line: string) => void;
  }>;

/** What a finished media tool reports; `content` goes back to the model. */
export type MediaResult = Readonly<{
  /** One line for the activity card. */
  summary: string;
  /** JSON-serialisable result, bounded by the tool. */
  content: Record<string, unknown>;
  /** Project-relative output paths, so the model can chain tools. */
  outputs: readonly string[];
}>;

export const MEDIA_LIMITS = Object.freeze({
  downloadTimeoutMs: 15 * 60_000,
  downloadMaxBytes: 500 * 1024 * 1024,
  stemsTimeoutMs: 20 * 60_000,
  analyzeTimeoutMs: 5 * 60_000,
  notesTimeoutMs: 10 * 60_000,
  sampleTimeoutMs: 2 * 60_000,
  lyricsTimeoutMs: 10 * 60_000,
  /** Largest file any tool reads whole into memory. */
  maxWavBytes: 256 * 1024 * 1024,
  maxNotes: 2048,
  waveformBuckets: 240,
  /** Bound on captured stdout/stderr of every helper process. */
  maxToolOutputBytes: 1024 * 1024,
  /** Model files announced before download (whisper). */
  whisperModelBytes: 148_000_000,
});
