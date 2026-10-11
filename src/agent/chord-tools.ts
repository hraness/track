/**
 * Agent tools for chords: `suggest_progression` (read-only) and
 * `write_chords` (score). Both run core/chords.ts, so the agent gets the
 * same key-mode harmony, voice leading and performance play mode uses.
 */

import {
  BASS_MODES,
  CHORD_PATTERNS,
  findChordPattern,
  type BassMode,
  generateProgression,
  keyName,
  parseKey,
  DEFAULT_STROKE_SPEED,
  GUITAR_TUNING_NAMES,
  PERFORM_MODES,
  PROGRESSION_PRESETS,
  STROKE_PATTERN_NAMES,
  strokeGrid,
  PROGRESSION_STYLES,
  renderProgression,
  resolveChord,
  SPREADS,
  type Chord,
  type Key,
  type PerformMode,
  type Spread,
} from "../../core/chords.ts";
import { midiToPitch } from "../../core/pitch.ts";
import { resolveTuning, snapToTuning } from "../../core/tuning.ts";
import { SCORE_LIMITS, type ScoreOperation } from "../../core/score.ts";
import type { AgentTool, ToolContext } from "./tools.ts";
import {
  applyGuitarCommand,
  parseGuitarCommand,
  planStrum,
  StrumError,
} from "../commands/strum.ts";

/** Most notes one write_chords call may add (arpeggios multiply fast). */
export const MAX_CHORD_NOTES = 512;
const MAX_CHORDS = 32;

class ChordToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

const STYLE_NAMES = [
  ...PROGRESSION_STYLES,
  ...PROGRESSION_PRESETS.map((preset) => preset.name),
];

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;
const keySchema = {
  type: "string",
  description: '"C major", "a dorian"; default song key',
} as const;
const chordsSchema = {
  type: "array",
  items: str,
  description: '"ii7", "bVII", "V/V" or "Cm7", "F/A"',
} as const;
const voicingSchema = {
  inversion: { ...int, description: "-12..12" },
  spread: { type: "string", enum: [...SPREADS] },
} as const;
const progressionSchema = {
  key: keySchema,
  chords: {
    ...chordsSchema,
    description: `${chordsSchema.description}; omit to generate`,
  },
  length: int,
  style: str,
  seed: int,
  sevenths: bool,
  ...voicingSchema,
} as const;

type Progression = Readonly<{ key: Key; chords: Chord[] }>;

function progressionOf(
  args: Record<string, unknown>,
  context: ToolContext,
): Progression {
  const keyText =
    args.key === undefined ? (context.score.key ?? "C major") : args.key;
  const key = parseKey(typeof keyText === "string" ? keyText : undefined);
  if (!key)
    throw new ChordToolError(
      `key must look like "C major", "a minor" or "F# dorian"`,
    );
  if (args.chords !== undefined) {
    if (
      !Array.isArray(args.chords) ||
      args.chords.length === 0 ||
      args.chords.length > MAX_CHORDS
    )
      throw new ChordToolError(`chords must list 1..${MAX_CHORDS} chords`);
    const chords = args.chords.map((value, index) => {
      const chord =
        typeof value === "string" ? resolveChord(key, value) : undefined;
      if (!chord)
        throw new ChordToolError(
          `chords[${index}]: not a roman numeral or chord symbol`,
        );
      return chord;
    });
    return { key, chords };
  }
  const length = integer(args, "length", 1, MAX_CHORDS) ?? 4;
  const style = args.style;
  if (
    style !== undefined &&
    (typeof style !== "string" || !STYLE_NAMES.includes(style))
  )
    throw new ChordToolError(`style must be one of ${STYLE_NAMES.join(", ")}`);
  const sevenths = optionalBoolean(args, "sevenths");
  return {
    key,
    chords: generateProgression({
      key,
      length,
      ...(style !== undefined ? { style } : {}),
      seed: integer(args, "seed", 0, 2 ** 31) ?? 1,
      ...(sevenths !== undefined ? { sevenths } : {}),
    }),
  };
}

function voicingOf(args: Record<string, unknown>): {
  inversion?: number;
  spread?: Spread;
} {
  const inversion = integer(args, "inversion", -12, 12);
  const spread = args.spread;
  if (spread !== undefined && !(SPREADS as readonly unknown[]).includes(spread))
    throw new ChordToolError(`spread must be one of ${SPREADS.join(", ")}`);
  return {
    ...(inversion !== undefined ? { inversion } : {}),
    ...(spread !== undefined ? { spread: spread as Spread } : {}),
  };
}

export const CHORD_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "suggest_progression",
    description:
      "Read-only: voice-led diatonic chords (name, numeral, voicing, bass) from a style walk or a named preset; length ≤32.",
    parameters: {
      type: "object",
      properties: progressionSchema,
      additionalProperties: false,
    },
    plan(args, context) {
      const { key, chords } = progressionOf(args, context);
      const rendered = renderProgression({
        key,
        chords,
        ...voicingOf(args),
        bass: true,
      });
      const result = {
        key: keyName(key),
        chords: rendered.voiced.map((chord) => ({
          name: chord.name,
          roman: chord.roman,
          voicing: chord.pitches.map((pitch) => midiToPitch(pitch)),
          ...(chord.bass !== undefined
            ? { bass: midiToPitch(chord.bass) }
            : {}),
        })),
      };
      const names = rendered.voiced.map((chord) => chord.name).join(" ");
      return {
        kind: "action",
        summary: `${keyName(key)}: ${names}`.slice(0, 160),
        run: async () => ({
          content: JSON.stringify(result),
          summary: `${keyName(key)}: ${names}`.slice(0, 160),
        }),
      };
    },
  },
  {
    name: "write_chords",
    description:
      "Write voice-led chords to a track (one bar each by default), optional bass here or on bassTrackId, with a perform pattern. ≤512 notes.",
    parameters: {
      type: "object",
      properties: {
        trackId: str,
        key: keySchema,
        chords: chordsSchema,
        ...voicingSchema,
        start: num,
        beatsPerChord: num,
        perform: { type: "string", enum: [...PERFORM_MODES] },
        rate: { ...num, description: "arp step, beats" },
        octaves: int,
        strum: { ...num, description: "strum/strum-up gap, beats" },
        strokes: { ...str, description: "perform guitar: see strum_chords" },
        speed: { ...num, description: "perform guitar: ms per stroke" },
        velocity: num,
        pattern: { type: "string", enum: CHORD_PATTERNS.map((p) => p.name) },
        bass: bool,
        bassMode: { type: "string", enum: [...BASS_MODES] },
        bassTrackId: str,
      },
      required: ["chords"],
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = trackOf(args.trackId, context, "trackId");
      if (args.chords === undefined)
        throw new ChordToolError(
          "write_chords needs chords (try suggest_progression)",
        );
      const bassTrackId =
        args.bassTrackId === undefined
          ? undefined
          : trackOf(args.bassTrackId, context, "bassTrackId");
      const { key, chords } = progressionOf(args, context);
      const mode = args.perform;
      if (
        mode !== undefined &&
        !(PERFORM_MODES as readonly unknown[]).includes(mode)
      )
        throw new ChordToolError(
          `perform must be one of ${PERFORM_MODES.join(", ")}`,
        );
      const velocity = finite(args, "velocity", 0, 1);
      const rate = finite(args, "rate", 0.0625, 4);
      const strum = finite(args, "strum", 0, 1);
      const speedMs = finite(args, "speed", 0, 200);
      const strokes = args.strokes;
      if (
        strokes !== undefined &&
        (typeof strokes !== "string" || !strokeGrid(strokes))
      )
        throw new ChordToolError(
          `strokes must be ${STROKE_PATTERN_NAMES.join(", ")} or a grid of D U d u x - .`,
        );
      const octaves = integer(args, "octaves", 1, 4);
      const pattern = args.pattern;
      if (
        pattern !== undefined &&
        (typeof pattern !== "string" || !findChordPattern(pattern))
      )
        throw new ChordToolError(
          `pattern must be one of ${CHORD_PATTERNS.map((p) => p.name).join(", ")}`,
        );
      const bassMode = args.bassMode;
      if (
        bassMode !== undefined &&
        !(BASS_MODES as readonly unknown[]).includes(bassMode)
      )
        throw new ChordToolError(
          `bassMode must be one of ${BASS_MODES.join(", ")}`,
        );
      const rendered = renderProgression({
        key,
        chords,
        start: finite(args, "start", 0, Infinity) ?? 0,
        beatsPerChord:
          finite(args, "beatsPerChord", 1e-3, 64) ?? context.score.beatsPerBar,
        ...voicingOf(args),
        bass: args.bass === true || bassTrackId !== undefined,
        ...(bassMode !== undefined ? { bassMode: bassMode as BassMode } : {}),
        perform: {
          mode: (mode as PerformMode | undefined) ?? "block",
          ...(rate !== undefined ? { rate } : {}),
          ...(strum !== undefined ? { strum } : {}),
          ...(octaves !== undefined ? { octaves } : {}),
          ...(velocity !== undefined ? { velocity } : {}),
          seed: integer(args, "seed", 0, 2 ** 31) ?? 0,
          ...(typeof pattern === "string" ? { pattern } : {}),
          ...(mode === "guitar"
            ? {
                ...(typeof strokes === "string" ? { strokes } : {}),
                speed: (speedMs ?? DEFAULT_STROKE_SPEED * 1000) / 1000,
                tempo: context.score.tempoBpm,
                ...(guitarOf(context, trackId)
                  ? { guitar: guitarOf(context, trackId) }
                  : {}),
              }
            : {}),
        },
      });
      const total = rendered.notes.length + rendered.bass.length;
      if (total > MAX_CHORD_NOTES)
        throw new ChordToolError(
          `${total} notes exceed ${MAX_CHORD_NOTES}; use fewer chords, a slower rate or fewer octaves`,
        );
      const tpb = context.score.ticksPerBeat;
      const tuningOf = (id: string) =>
        resolveTuning(
          context.score.tuning,
          context.score.tracks.find((track) => track.id === id)?.tuning,
          context.score.key,
        );
      const operations: ScoreOperation[] = [];
      const add = (
        notes: readonly {
          pitch: number;
          start: number;
          length: number;
          velocity: number;
        }[],
        target: string,
      ) => {
        const table = tuningOf(target);
        for (const note of notes)
          operations.push({
            type: "addNote",
            note: {
              id: context.newNoteId(target, operations.length),
              trackId: target,
              startTick: Math.round(note.start * tpb),
              durationTicks: Math.max(1, Math.round(note.length * tpb)),
              pitch: snapToTuning(note.pitch, table),
              velocity: note.velocity,
            },
          });
      };
      add(rendered.notes, trackId);
      add(rendered.bass, bassTrackId ?? trackId);
      const names = rendered.voiced.map((chord) => chord.name).join(" ");
      return {
        kind: "score",
        operations,
        trackId,
        summary: `${trackId} chords ${names}`.slice(0, 160),
      };
    },
  },
  {
    name: "strum_chords",
    description:
      "Strum chords as fretted guitar notes (set_guitar); omitted chords strums the track's block chords. strokes name or a DUdux-. grid.",
    parameters: {
      type: "object",
      properties: {
        trackId: str,
        chords: chordsSchema,
        strokes: str,
        speed: num,
        step: num,
        each: num,
        at: num,
        velocity: num,
        seed: int,
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = trackOf(args.trackId, context, "trackId");
      const chords = args.chords;
      if (
        chords !== undefined &&
        (!Array.isArray(chords) ||
          chords.length > MAX_CHORDS ||
          !chords.every((c) => typeof c === "string"))
      )
        throw new ChordToolError(`chords must be up to ${MAX_CHORDS} strings`);
      if (args.strokes !== undefined && typeof args.strokes !== "string")
        throw new ChordToolError("strokes must be a string");
      const speedMs = finite(args, "speed", 0, 200);
      const step = finite(args, "step", 1 / 32, 4);
      const each = finite(args, "each", 1e-3, 64);
      const at = finite(args, "at", 0, Infinity);
      const velocity = finite(args, "velocity", 0, 1);
      const seed = integer(args, "seed", 0, 2 ** 31);
      try {
        const plan = planStrum(
          context.score,
          trackId,
          {
            chords: (chords as string[] | undefined) ?? [],
            ...(typeof args.strokes === "string"
              ? { strokes: args.strokes }
              : {}),
            ...(speedMs !== undefined ? { speedMs } : {}),
            ...(step !== undefined ? { step } : {}),
            ...(each !== undefined ? { each } : {}),
            ...(at !== undefined ? { at } : {}),
            ...(velocity !== undefined ? { velocity } : {}),
            ...(seed !== undefined ? { seed } : {}),
          },
          (index) => context.newNoteId(trackId, index),
          MAX_CHORD_NOTES,
        );
        return {
          kind: "score",
          operations: plan.operations,
          trackId,
          summary: `${trackId} strum ${plan.names.join(" ")}`.slice(0, 160),
        };
      } catch (error) {
        if (error instanceof StrumError)
          throw new ChordToolError(error.message);
        throw error;
      }
    },
  },
  {
    name: "set_guitar",
    description:
      "Guitar fretting for strum: tune (name or notes low-high), capo, hand span, ring, position, reset.",
    parameters: {
      type: "object",
      properties: {
        trackId: str,
        tune: str,
        capo: int,
        hand: int,
        ring: num,
        position: int,
        reset: bool,
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = trackOf(args.trackId, context, "trackId");
      let score = context.score;
      const messages: string[] = [];
      const run = (command: string) => {
        const parsed = parseGuitarCommand(command);
        const result = parsed
          ? applyGuitarCommand(score, trackId, parsed)
          : { ok: false, message: `cannot parse ${command}` };
        if (!result.ok) throw new ChordToolError(result.message);
        if ("next" in result && result.next) score = result.next;
        messages.push(result.message);
      };
      if (args.reset === true) run("guitar reset");
      if (args.tune !== undefined) run(`guitar tune ${String(args.tune)}`);
      for (const field of ["capo", "hand", "ring", "position"] as const)
        if (args[field] !== undefined)
          run(`guitar ${field} ${String(args[field])}`);
      if (messages.length === 0)
        throw new ChordToolError(
          "give tune, capo, hand, ring, position or reset",
        );
      const guitar = score.tracks.find((t) => t.id === trackId)?.guitar;
      return {
        kind: "score",
        operations: [
          { type: "updateTrack", trackId, patch: { guitar: guitar ?? null } },
        ],
        trackId,
        summary: messages.at(-1)!,
      };
    },
  },
]);

function guitarOf(context: ToolContext, trackId: string) {
  return context.score.tracks.find((track) => track.id === trackId)?.guitar;
}

function trackOf(value: unknown, context: ToolContext, label: string): string {
  const trackId = value ?? context.focusedTrackId;
  if (typeof trackId !== "string" || trackId.length > SCORE_LIMITS.maxIdLength)
    throw new ChordToolError(`${label} must be a short string`);
  if (!context.score.tracks.some((track) => track.id === trackId))
    throw new ChordToolError(
      `unknown track ${trackId}; create it with create_track first`,
    );
  return trackId;
}

function finite(
  args: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new ChordToolError(
      `${name} must be a number in ${min}..${max === Infinity ? "∞" : max}`,
    );
  return value;
}

function integer(
  args: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const value = finite(args, name, min, max);
  if (value !== undefined && !Number.isInteger(value))
    throw new ChordToolError(`${name} must be an integer`);
  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new ChordToolError(`${name} must be true or false`);
  return value;
}
