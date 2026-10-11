/**
 * Agent tools for generated drum rhythms (`core/euclid.ts`, `core/rhythm.ts`).
 *
 * `set_rhythm` stores Euclidean/T-1 parameters on the track and lets the
 * score regenerate the voice's notes, so the agent edits four numbers
 * instead of sixteen notes and later edits stay one small diff.
 */
import { diffScores } from "../../core/diff.ts";
import {
  RHYTHM_LIMITS,
  normalizeRhythmRow,
  type RhythmRow,
} from "../../core/euclid.ts";
import {
  removeRhythmRow,
  rhythmVoicePitch,
  setRhythmRow,
} from "../../core/rhythm.ts";
import { SCORE_LIMITS, ScoreValidationError } from "../../core/score.ts";
import type { AgentTool, ToolContext } from "./tools.ts";
import { ToolArgumentError } from "./tools.ts";

const int = { type: "integer" } as const;
const num = { type: "number" } as const;
/** Divisions are checked by `normalizeRhythmRow`; the enum stays out of the catalog. */
const division = { type: "string" } as const;

/** Compact on purpose: ranges are checked by `normalizeRhythmRow`. */
const ROW_FIELDS = Object.freeze({
  voice: { type: "string" },
  pulses: int,
  steps: int,
  rotate: int,
  division,
  grid: { type: "string" },
  repeats: int,
  time: division,
  pace: num,
  ramp: num,
  velocity: num,
  accent: num,
  accents: int,
  gate: num,
  legato: { type: "boolean" },
  probability: num,
  seed: int,
  swing: num,
  nudge: num,
  cycles: { type: "array", items: { type: "object" } },
});

function trackOf(args: Record<string, unknown>, context: ToolContext) {
  const trackId = args.trackId ?? context.focusedTrackId;
  if (typeof trackId !== "string" || trackId.length > SCORE_LIMITS.maxIdLength)
    throw new ToolArgumentError("trackId must be a short string");
  const track = context.score.tracks.find((t) => t.id === trackId);
  if (!track)
    throw new ToolArgumentError(
      `unknown track ${trackId}; create it with create_track first`,
    );
  return track;
}

function rowFrom(value: unknown, label: string): RhythmRow {
  try {
    return normalizeRhythmRow(value, label);
  } catch (error) {
    throw new ToolArgumentError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export const RHYTHM_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "set_rhythm",
    description:
      "Preferred for drums: one Euclidean or grid row per voice of a kit track (pulses over steps, rotate, division, grid 'x.X.', repeats, accent, swing, probability); notes regenerate from the row. remove [voices].",
    parameters: {
      type: "object",
      properties: {
        trackId: { type: "string" },
        rows: {
          type: "array",
          maxItems: RHYTHM_LIMITS.maxRows,
          items: {
            type: "object",
            properties: ROW_FIELDS,
            required: ["voice"],
            additionalProperties: false,
          },
        },
        remove: {
          type: "array",
          maxItems: RHYTHM_LIMITS.maxRows,
          items: { type: "string" },
        },
        freeze: { type: "boolean" },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const track = trackOf(args, context);
      const rows = Array.isArray(args.rows) ? args.rows : [];
      const remove = Array.isArray(args.remove) ? args.remove : [];
      if (rows.length === 0 && remove.length === 0)
        throw new ToolArgumentError("set_rhythm needs rows or remove");
      if (rows.length > RHYTHM_LIMITS.maxRows)
        throw new ToolArgumentError(
          `at most ${RHYTHM_LIMITS.maxRows} rows per call`,
        );
      let next = context.score;
      const parts: string[] = [];
      try {
        for (const voice of remove) {
          if (typeof voice !== "string")
            throw new ToolArgumentError("remove holds voice names");
          next = removeRhythmRow(next, track.id, voice, args.freeze === true);
          parts.push(`-${voice}`);
        }
        for (const [index, value] of rows.entries()) {
          const row = rowFrom(value, `rows[${index}]`);
          if (rhythmVoicePitch(track, row.voice) === undefined)
            throw new ToolArgumentError(
              `track ${track.id} has no voice "${row.voice}"`,
            );
          next = setRhythmRow(next, track.id, row);
          parts.push(
            `${row.voice} ${row.grid ? `grid ${row.grid}` : `E(${row.pulses ?? 4},${row.steps ?? 16}${row.rotate ? `,${row.rotate}` : ""})`}`,
          );
        }
      } catch (error) {
        if (error instanceof ScoreValidationError)
          throw new ToolArgumentError(error.message);
        throw error;
      }
      return {
        kind: "score",
        operations: diffScores(context.score, next),
        trackId: track.id,
        summary: `${track.id} ${parts.join(", ")}`,
      };
    },
  },
]);
