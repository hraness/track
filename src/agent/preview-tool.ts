/**
 * `preview_sound`: render a short snippet of a track, or of a candidate
 * change to it, without committing anything. The candidate is a list of
 * ordinary sound tool calls (`set_fx`, `set_synth`, `set_wavetable`, …),
 * planned by those same tools against a copy of the score, so what the
 * agent hears is exactly what committing them would produce.
 *
 * The snippet is the audition loop's score (`previewScore`): the track's
 * own notes over at most four bars, or a short phrase by role. It renders
 * through the normal renderer, so every effect, bus and impulse response
 * sounds as in the song. The result carries loudness, peak and spectral
 * centroid for the committed and the candidate sound, and a one-line
 * description. When a TUI is attached the host plays the candidate once.
 */
import { applyScoreOperations } from "../../core/diff.ts";
import { SCORE_LIMITS, type TrackScore } from "../../core/score.ts";
import {
  MAX_PREVIEW_BARS,
  analyzePcm,
  describeSound,
  previewScore,
  type SoundStats,
} from "../audio/preview.ts";
import { renderScorePcm, type RenderedAudio } from "../audio/wav.ts";
import type { ScoreMeasurement } from "../audio/measure.ts";
import { VOICE_PREVIEWABLE_TOOLS } from "./voice-tools.ts";
import type {
  ActionContext,
  AgentTool,
  ToolContext,
  ToolPlan,
} from "./tools.ts";

/** Tools a candidate may use: the ones that change how a track sounds. */
export const PREVIEWABLE_TOOLS: readonly string[] = Object.freeze([
  "set_instrument",
  "set_mix",
  "set_automation",
  "set_fx",
  "set_rig",
  "set_synth",
  "set_string",
  "set_modal",
  "set_wind",
  "set_sample",
  "fit_sample",
  "set_effects",
  "set_wavetable",
  "set_granular",
  "set_drum_kit",
  "use_sound",
  // 0.7 Voice: flagged per lane in voice-tools.ts.
  ...VOICE_PREVIEWABLE_TOOLS,
]);

const MAX_CHANGES = 8;

/** How the host renders and plays a preview; both optional. */
export type PreviewHost = Readonly<{
  /** Render a preview score (the host adds decoded samples); default in-thread. */
  render?: (score: TrackScore) => Promise<RenderedAudio> | RenderedAudio;
  /** Play the snippet once; returns false when nothing could sound. */
  play?: (audio: RenderedAudio) => boolean | Promise<boolean>;
  /** Play a project file (seconds range) for `audio` audition; false when silent. */
  playFile?: (
    path: string,
    from?: number,
    to?: number,
  ) => boolean | Promise<boolean>;
  /**
   * Render and measure for measure_mix (the host adds decoded samples), at
   * `sampleRate` when given and the score's export rate otherwise.
   */
  measure?: (
    score: TrackScore,
    options?: Readonly<{ sampleRate?: number }>,
  ) => Promise<ScoreMeasurement>;
}>;

/** Thrown for a candidate the tool refuses; nothing is rendered. */
export class PreviewToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewToolError";
  }
}

type Change = Readonly<{ tool: string; args: Record<string, unknown> }>;

function parseChanges(value: unknown): Change[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new PreviewToolError("changes must be a list");
  if (value.length > MAX_CHANGES)
    throw new PreviewToolError(`at most ${MAX_CHANGES} changes`);
  return value.map((entry, index) => {
    const item = entry as { tool?: unknown; args?: unknown } | null;
    if (!item || typeof item.tool !== "string")
      throw new PreviewToolError(`changes[${index}].tool is required`);
    if (!PREVIEWABLE_TOOLS.includes(item.tool))
      throw new PreviewToolError(
        `changes[${index}]: ${item.tool} cannot be previewed; use ${PREVIEWABLE_TOOLS.join(", ")}`,
      );
    const args =
      item.args === undefined
        ? {}
        : typeof item.args === "object" && !Array.isArray(item.args)
          ? (item.args as Record<string, unknown>)
          : undefined;
    if (!args)
      throw new PreviewToolError(`changes[${index}].args must be an object`);
    return { tool: item.tool, args };
  });
}

/** Run each change's own plan on a copy; returns the candidate score. */
async function applyChanges(
  changes: readonly Change[],
  context: ToolContext,
  action: ActionContext,
  lookup: (name: string) => AgentTool | undefined,
): Promise<{ score: TrackScore; summaries: string[] }> {
  let score = context.score;
  const summaries: string[] = [];
  for (const change of changes) {
    const tool = lookup(change.tool);
    if (!tool) throw new PreviewToolError(`unknown tool ${change.tool}`);
    let plan: ToolPlan = tool.plan(change.args, { ...context, score });
    if (plan.kind === "prepare") plan = await plan.run(action);
    if (plan.kind !== "score")
      throw new PreviewToolError(`${change.tool} does not change the score`);
    score = applyScoreOperations(score, plan.operations);
    summaries.push(plan.summary);
  }
  return { score, summaries };
}

function round(stats: SoundStats) {
  return {
    rmsDb: Math.round(stats.rmsDb * 10) / 10,
    peakDb: Math.round(stats.peakDb * 10) / 10,
    centroidHz: Math.round(stats.centroidHz),
    clipped: stats.clipped,
    description: describeSound(stats),
  };
}

/** One clause comparing two renders: louder/quieter, brighter/darker. */
export function compareSounds(before: SoundStats, after: SoundStats): string {
  const parts: string[] = [];
  const level = after.rmsDb - before.rmsDb;
  if (Math.abs(level) >= 0.5)
    parts.push(
      `${Math.abs(level).toFixed(1)} dB ${level > 0 ? "louder" : "quieter"}`,
    );
  if (before.centroidHz > 0 && after.centroidHz > 0) {
    const ratio = after.centroidHz / before.centroidHz;
    if (ratio >= 1.08) parts.push(`brighter (×${ratio.toFixed(2)} centroid)`);
    else if (ratio <= 1 / 1.08)
      parts.push(`darker (×${ratio.toFixed(2)} centroid)`);
  }
  if (after.clipped > 0 && before.clipped === 0) parts.push("now clips");
  return parts.length ? parts.join(", ") : "about the same level and tone";
}

export function previewSoundTool(
  lookup: (name: string) => AgentTool | undefined,
): AgentTool {
  return {
    name: "preview_sound",
    description:
      "Hear a track, or candidate sound tool calls (changes: [{tool, args}]), without committing: returns loudness, brightness and a one-line description for current and candidate, and plays it once.",
    parameters: {
      type: "object",
      properties: {
        trackId: {
          type: "string",
          maxLength: SCORE_LIMITS.maxIdLength,
          description: "Track to hear. Defaults to the focused track.",
        },
        changes: {
          type: "array",
          maxItems: MAX_CHANGES,
          items: {
            type: "object",
            properties: {
              tool: { type: "string", enum: [...PREVIEWABLE_TOOLS] },
              args: { type: "object" },
            },
            required: ["tool"],
          },
        },
        bars: { type: "integer", minimum: 1, maximum: MAX_PREVIEW_BARS },
        context: {
          type: "boolean",
          description: "Hear the whole mix with the track (default: solo).",
        },
        play: {
          type: "boolean",
          description: "Play it in the user's window (default true).",
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId =
        typeof args.trackId === "string" && args.trackId
          ? args.trackId
          : context.focusedTrackId;
      const changes = parseChanges(args.changes);
      // A candidate may create the track (set_instrument on a new id).
      if (
        changes.length === 0 &&
        !context.score.tracks.some((track) => track.id === trackId)
      )
        throw new PreviewToolError(`unknown track ${trackId}`);
      const bars =
        typeof args.bars === "number" && Number.isInteger(args.bars)
          ? Math.max(1, Math.min(MAX_PREVIEW_BARS, args.bars))
          : undefined;
      const inContext = args.context === true;
      const play = args.play !== false;
      return {
        kind: "action",
        summary: changes.length
          ? `preview ${trackId} · ${changes.map((change) => change.tool).join(", ")}`
          : `preview ${trackId}`,
        run: async (action) => {
          const candidate = await applyChanges(
            changes,
            { ...context, focusedTrackId: trackId },
            action,
            lookup,
          );
          const after = previewScore(candidate.score, trackId, {
            context: inContext,
          });
          if (!after) throw new PreviewToolError(`unknown track ${trackId}`);
          const region = bars
            ? { startBar: after.region.startBar, bars }
            : after.region;
          const render =
            action.preview?.render ?? ((value) => renderScorePcm(value));
          const snippet = async (value: TrackScore, masterGainDb?: number) => {
            const preview = previewScore(value, trackId, {
              context: inContext,
              region,
              ...(masterGainDb === undefined ? {} : { masterGainDb }),
            });
            if (!preview) return undefined;
            const audio = await render(preview.score);
            return { audio, stats: analyzePcm(audio.pcm, audio.sampleRate) };
          };
          const before =
            changes.length > 0 &&
            context.score.tracks.some((track) => track.id === trackId)
              ? await snippet(context.score)
              : undefined;
          // The after snippet plays the master at the drive the before one
          // used, so a level change is not normalized away by the target
          // (unless the change is to the master itself).
          const fixedGain = changes.some(
            (change) => change.tool === "set_master",
          )
            ? undefined
            : before?.audio.master?.gainDb;
          const next = await snippet(candidate.score, fixedGain);
          if (!next) throw new PreviewToolError(`unknown track ${trackId}`);
          let played = false;
          if (play && action.preview?.play)
            played = await action.preview.play(next.audio);
          const describe = describeSound(next.stats);
          const comparison = before
            ? compareSounds(before.stats, next.stats)
            : undefined;
          const content = JSON.stringify({
            ok: true,
            committed: false,
            trackId,
            bars: region.bars,
            fromBar: region.startBar + 1,
            source: after.source,
            ...(after.role ? { phrase: after.role } : {}),
            mode: inContext ? "in context" : "solo",
            ...(candidate.summaries.length
              ? { candidate: candidate.summaries }
              : {}),
            sound: round(next.stats),
            ...(before ? { current: round(before.stats), comparison } : {}),
            played,
            next: changes.length
              ? "commit with the same tool calls if it sounds right"
              : undefined,
          });
          return {
            content,
            summary: `${played ? "♪ " : ""}preview ${trackId} · ${comparison ?? describe}`,
          };
        },
      };
    },
  };
}
