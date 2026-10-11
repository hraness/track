/**
 * Agent tools for expression: `set_expression` (articulation, glide, bend
 * and vibrato over a note range) and `set_performance` (a track's glide
 * mode, sustain pedal, velocity curve and seeded humanize). Both validate
 * through core/expression.ts, the same rules the score loader applies.
 */
import {
  ARTICULATIONS,
  ExpressionValidationError,
  GLIDE_MODES,
  PEDAL_STATES,
  SOSTENUTO_STATES,
  VELOCITY_CURVES,
  normalizeArticulation,
  normalizeBend,
  normalizeHumanize,
  normalizeNoteGlide,
  normalizePedal,
  normalizeTrackGlide,
  normalizeVelocityCurve,
  normalizeVibrato,
  normalizeNoteHumanize,
  type NoteExpressionPatch,
  type PedalState,
} from "../../core/expression.ts";
import {
  SCORE_LIMITS,
  type ScoreOperation,
  type TrackPatch,
} from "../../core/score.ts";
import { softPedalNote } from "../../core/keys.ts";
import { loopTicksOf } from "../../core/tempo.ts";
import { BEND_SHAPES, barPedal } from "../commands/expression.ts";
import type { AgentTool, ToolContext } from "./tools.ts";

const MAX_TARGET_NOTES = 512;

class ExpressionToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

function validated<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ExpressionValidationError)
      throw new ExpressionToolError(error.message);
    throw error;
  }
}

function trackOf(args: Record<string, unknown>, context: ToolContext): string {
  const trackId = args.trackId ?? context.focusedTrackId;
  if (typeof trackId !== "string" || trackId.length > SCORE_LIMITS.maxIdLength)
    throw new ExpressionToolError("trackId must be a short string");
  if (!context.score.tracks.some((track) => track.id === trackId))
    throw new ExpressionToolError(`unknown trackId ${trackId.slice(0, 64)}`);
  return trackId;
}

function beat(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new ExpressionToolError(`${key} must be a number >= 0`);
  return value;
}

/** Note ids `args` selects: `noteIds`, else the track's notes in a beat range. */
function selectNotes(
  args: Record<string, unknown>,
  context: ToolContext,
): { trackId: string; noteIds: string[] } {
  const trackId = trackOf(args, context);
  if (args.noteIds !== undefined) {
    if (
      !Array.isArray(args.noteIds) ||
      args.noteIds.length === 0 ||
      args.noteIds.length > MAX_TARGET_NOTES
    )
      throw new ExpressionToolError(
        `noteIds must be an array of 1..${MAX_TARGET_NOTES} ids`,
      );
    const known = new Set(context.score.notes.map((note) => note.id));
    const ids = [...new Set(args.noteIds as unknown[])].map((id, index) => {
      if (typeof id !== "string" || !known.has(id))
        throw new ExpressionToolError(`noteIds[${index}] is not a note id`);
      return id;
    });
    return { trackId, noteIds: ids };
  }
  const tpb = context.score.ticksPerBeat;
  const from = beat(args, "fromBeat") ?? 0;
  const to = beat(args, "toBeat") ?? Infinity;
  if (!(to > from))
    throw new ExpressionToolError("toBeat must be after fromBeat");
  const noteIds = context.score.notes
    .filter(
      (note) =>
        note.trackId === trackId &&
        note.startTick >= Math.round(from * tpb) &&
        note.startTick < to * tpb,
    )
    .map((note) => note.id);
  if (noteIds.length === 0)
    throw new ExpressionToolError(
      `no notes on ${trackId} start in beats ${from}..${to === Infinity ? "end" : to}`,
    );
  if (noteIds.length > MAX_TARGET_NOTES)
    throw new ExpressionToolError(
      `${noteIds.length} notes match; narrow the range to ${MAX_TARGET_NOTES}`,
    );
  return { trackId, noteIds };
}

const noteRange = {
  trackId: { type: "string" },
  noteIds: { type: "array", items: { type: "string" } },
  fromBeat: { type: "number" },
  toBeat: { type: "number" },
};

const bendPoint = {
  type: "object",
  properties: { at: { type: "number" }, cents: { type: "number" } },
};

export const EXPRESSION_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "set_expression",
    description:
      "Per-note expression on noteIds, or a track's notes in [fromBeat, toBeat): articulation, glide, bend, vibrato, humanize; null clears. Overrides the synth's slide, penv, vib.",
    parameters: {
      type: "object",
      properties: {
        ...noteRange,
        articulation: {
          type: ["string", "null"],
          enum: [...ARTICULATIONS, null],
        },
        glide: { type: ["number", "null"] },
        bend: { type: ["array", "string", "null"], items: bendPoint },
        vibrato: {
          type: ["object", "null"],
          properties: {
            rate: { type: "number" },
            depth: { type: "number" },
            delay: { type: "number" },
          },
        },
        humanize: {
          type: ["object", "null"],
          properties: {
            timing: { type: "number" },
            velocity: { type: "number" },
            length: { type: "number" },
          },
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const patch: Record<string, unknown> = {};
      if (args.articulation !== undefined)
        patch.articulation =
          args.articulation === null
            ? null
            : validated(() => normalizeArticulation(args.articulation));
      if (args.glide !== undefined)
        patch.glide =
          args.glide === null
            ? null
            : validated(() => normalizeNoteGlide(args.glide));
      if (args.bend !== undefined)
        patch.bend =
          args.bend === null
            ? null
            : typeof args.bend === "string"
              ? (BEND_SHAPES[args.bend] ??
                (() => {
                  throw new ExpressionToolError(
                    `bend shape must be one of ${Object.keys(BEND_SHAPES).join(", ")}`,
                  );
                })())
              : (validated(() => normalizeBend(args.bend)) ?? null);
      if (args.vibrato !== undefined)
        patch.vibrato =
          args.vibrato === null
            ? null
            : validated(() => normalizeVibrato(args.vibrato));
      if (args.humanize !== undefined)
        patch.humanize =
          args.humanize === null
            ? null
            : validated(() => normalizeNoteHumanize(args.humanize));
      if (Object.keys(patch).length === 0)
        throw new ExpressionToolError(
          "set at least one of articulation, glide, bend, vibrato, humanize",
        );
      const { trackId, noteIds } = selectNotes(args, context);
      const operations: ScoreOperation[] = noteIds.map((noteId) => ({
        type: "updateNote",
        noteId,
        patch: patch as NoteExpressionPatch,
      }));
      const fields = Object.entries(patch)
        .map(([key, value]) =>
          value === null
            ? `${key} off`
            : typeof value === "string" || typeof value === "number"
              ? `${key} ${value}`
              : key,
        )
        .join(", ");
      return {
        kind: "score",
        operations,
        trackId,
        summary: `${fields} · ${noteIds.length} note${noteIds.length === 1 ? "" : "s"}`,
      };
    },
  },
  {
    name: "set_performance",
    description:
      "A track's performance; null clears: glide {time, mode legato|mono|poly}, pedal, velocityCurve, humanize (keep the seed for the same take).",
    parameters: {
      type: "object",
      properties: {
        trackId: { type: "string" },
        glide: {
          type: ["object", "null"],
          properties: {
            time: { type: "number" },
            mode: { type: "string", enum: GLIDE_MODES },
          },
        },
        pedal: {
          type: ["array", "string", "null"],
          items: {
            type: "object",
            properties: {
              beat: { type: "number" },
              state: { type: "string", enum: PEDAL_STATES },
            },
          },
        },
        velocityCurve: {
          type: ["object", "null"],
          properties: {
            curve: { type: "string", enum: VELOCITY_CURVES },
            fixed: { type: "number" },
          },
        },
        humanize: {
          type: ["object", "null"],
          properties: {
            timing: { type: "number" },
            velocity: { type: "number" },
            length: { type: "number" },
            seed: { type: "integer" },
          },
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = trackOf(args, context);
      const track = context.score.tracks.find((item) => item.id === trackId)!;
      const score = context.score;
      const patch: Record<string, unknown> = {};
      if (args.glide !== undefined)
        patch.glide =
          args.glide === null
            ? null
            : validated(() =>
                normalizeTrackGlide({
                  ...(track.glide ?? {}),
                  ...(args.glide as Record<string, unknown>),
                }),
              );
      if (args.pedal !== undefined) {
        const maxTick = loopTicksOf(score);
        if (args.pedal === null) patch.pedal = null;
        else if (args.pedal === "bars") patch.pedal = barPedal(score);
        else {
          if (!Array.isArray(args.pedal))
            throw new ExpressionToolError(
              'pedal must be an array, "bars" or null',
            );
          const events = args.pedal.map((value: unknown, index) => {
            const event = value as Record<string, unknown>;
            const at = beat(event ?? {}, "beat");
            if (at === undefined)
              throw new ExpressionToolError(`pedal[${index}].beat is required`);
            return {
              tick: Math.round(at * score.ticksPerBeat),
              state: event.state,
            };
          });
          patch.pedal =
            validated(() => normalizePedal(events, maxTick)) ?? null;
        }
      }
      if (args.velocityCurve !== undefined)
        patch.velocityCurve =
          args.velocityCurve === null
            ? null
            : (validated(() => normalizeVelocityCurve(args.velocityCurve)) ??
              null);
      if (args.humanize !== undefined)
        patch.humanize =
          args.humanize === null
            ? null
            : (validated(() =>
                normalizeHumanize({
                  ...(track.humanize ?? { seed: 1 }),
                  ...(args.humanize as Record<string, unknown>),
                }),
              ) ?? null);
      if (Object.keys(patch).length === 0)
        throw new ExpressionToolError(
          "set at least one of glide, pedal, velocityCurve, humanize",
        );
      return {
        kind: "score",
        operations: [
          { type: "updateTrack", trackId, patch: patch as TrackPatch },
        ],
        trackId,
        summary: `${trackId} ${Object.entries(patch)
          .map(([key, value]) => (value === null ? `${key} off` : key))
          .join(", ")}`,
      };
    },
  },
  {
    // keys-electric (0.6.1): the modelled piano's soft and middle pedals.
    name: "set_piano_pedals",
    description:
      'Modeled piano soft (una corda: fewer strings, softer, darker) and sostenuto (holds only keys down when it presses) pedals. Each: [{beat, state}], "bars" (whole loop) or null. Sostenuto has no half.',
    parameters: {
      type: "object",
      properties: {
        trackId: { type: "string" },
        soft: pedalSchema(PEDAL_STATES),
        sostenuto: pedalSchema(SOSTENUTO_STATES),
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = trackOf(args, context);
      const score = context.score;
      const patch: Record<string, unknown> = {};
      if (args.soft !== undefined)
        patch.softPedal = pedalLane(args.soft, "soft", score, PEDAL_STATES);
      if (args.sostenuto !== undefined)
        patch.sostenuto = pedalLane(
          args.sostenuto,
          "sostenuto",
          score,
          SOSTENUTO_STATES,
        );
      if (Object.keys(patch).length === 0)
        throw new ExpressionToolError("set soft, sostenuto or both");
      const track = score.tracks.find((candidate) => candidate.id === trackId);
      const silent =
        patch.softPedal && track ? softPedalNote(track) : undefined;
      if (silent) throw new ExpressionToolError(`soft pedal · ${silent}`);
      return {
        kind: "score",
        operations: [
          { type: "updateTrack", trackId, patch: patch as TrackPatch },
        ],
        trackId,
        summary: `${trackId} ${Object.entries(patch)
          .map(([key, value]) => (value === null ? `${key} off` : key))
          .join(", ")}`,
      };
    },
  },
] satisfies AgentTool[]);

function pedalSchema(states: readonly string[]) {
  return {
    type: ["array", "string", "null"],
    items: {
      type: "object",
      properties: {
        beat: { type: "number" },
        state: { type: "string", enum: states },
      },
    },
  };
}

/** A soft or sostenuto lane from tool arguments: events, "bars" or null. */
function pedalLane(
  value: unknown,
  label: string,
  score: ToolContext["score"],
  states: readonly PedalState[],
): unknown {
  if (value === null) return null;
  // Soft and sostenuto hold through the loop (no re-pedal at each bar).
  if (value === "bars")
    return [
      { tick: 0, state: "down" },
      { tick: loopTicksOf(score), state: "up" },
    ];
  if (!Array.isArray(value))
    throw new ExpressionToolError(`${label} must be an array, "bars" or null`);
  const events = value.map((item: unknown, index) => {
    const event = (item ?? {}) as Record<string, unknown>;
    const at = beat(event, "beat");
    if (at === undefined)
      throw new ExpressionToolError(`${label}[${index}].beat is required`);
    return { tick: Math.round(at * score.ticksPerBeat), state: event.state };
  });
  return (
    validated(() =>
      normalizePedal(events, loopTicksOf(score), label, states),
    ) ?? null
  );
}
