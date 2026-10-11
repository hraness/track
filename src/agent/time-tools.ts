/**
 * Agent tool for the tempo map, meter changes, fermatas and track time
 * (`core/tempo.ts`): `set_time`. Each call is one revision built by the same
 * code as the typed `tempo`, `rit`, `accel`, `fermata`, `meter` and
 * `track rate|phase|cycle|phasing` commands (`src/commands/time.ts`).
 */
import { diffScores } from "../../core/diff.ts";
import { SCORE_LIMITS } from "../../core/score.ts";
import { TIME_LIMITS, type TempoRamp } from "../../core/tempo.ts";
import {
  applyTimeCommand,
  FERMATA_DEFAULT_BEATS,
  type TimeCommand,
  type TimePosition,
} from "../commands/time.ts";
import type { AgentTool, ToolContext } from "./tools.ts";
import { ToolArgumentError } from "./tools.ts";

const ACTIONS = [
  "tempo",
  "rit",
  "accel",
  "a_tempo",
  "tempo_primo",
  "fermata",
  "meter",
  "track",
  "phasing",
  "remove_tempo",
  "remove_fermata",
  "remove_meter",
  "clear",
] as const;
type Action = (typeof ACTIONS)[number];

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function num(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ToolArgumentError(`${key} must be a number`);
  if (value < min || value > max)
    throw new ToolArgumentError(`${key} must be between ${min} and ${max}`);
  return value;
}

function positionOf(
  args: Record<string, unknown>,
  required: boolean,
): TimePosition | undefined {
  const beat = num(args, "beat", 0, 1_000_000);
  const bar = num(args, "bar", 1, SCORE_LIMITS.maxBars);
  if (beat !== undefined && bar !== undefined)
    throw new ToolArgumentError("give beat or bar, not both");
  if (bar !== undefined) {
    if (!Number.isInteger(bar))
      throw new ToolArgumentError("bar must be an integer");
    return { bar };
  }
  if (beat !== undefined) return { beat };
  if (required) throw new ToolArgumentError("needs beat or bar");
  return undefined;
}

function rampOf(args: Record<string, unknown>): TempoRamp | undefined {
  const ramp = args.ramp;
  if (ramp === undefined || ramp === null || ramp === "step") return undefined;
  if (ramp === "linear" || ramp === "exp") return ramp;
  throw new ToolArgumentError("ramp must be step, linear or exp");
}

function trackIdOf(args: Record<string, unknown>, context: ToolContext) {
  const trackId = args.trackId ?? context.focusedTrackId;
  if (typeof trackId !== "string" || !ID_PATTERN.test(trackId))
    throw new ToolArgumentError("trackId must be an existing track id");
  if (!context.score.tracks.some((track) => track.id === trackId))
    throw new ToolArgumentError(`no track ${trackId}`);
  return trackId;
}

/** Builds the typed command for `set_time` arguments. */
export function timeToolCommand(args: Record<string, unknown>): TimeCommand {
  const action = args.action as Action;
  if (!ACTIONS.includes(action))
    throw new ToolArgumentError(`action must be one of ${ACTIONS.join(", ")}`);
  const bpm = () => num(args, "bpm", TIME_LIMITS.minBpm, TIME_LIMITS.maxBpm);
  switch (action) {
    case "tempo": {
      const value = bpm();
      if (value === undefined) throw new ToolArgumentError("tempo needs bpm");
      const ramp = rampOf(args);
      return {
        type: "tempo-at",
        bpm: value,
        at: positionOf(args, true)!,
        ...(ramp ? { ramp } : {}),
      };
    }
    case "rit":
    case "accel": {
      const bars = num(args, "bars", 0.25, SCORE_LIMITS.maxBars);
      const beats = num(args, "beats", 0.25, 100_000);
      if (bars !== undefined && beats !== undefined)
        throw new ToolArgumentError("give bars or beats, not both");
      const value = bpm();
      const at = positionOf(args, false);
      return {
        type: "gradual",
        direction: action,
        length: beats ?? bars ?? 2,
        unit: beats !== undefined ? "beats" : "bars",
        ...(value !== undefined ? { bpm: value } : {}),
        ...(at ? { at } : {}),
        curve: rampOf(args) ?? "linear",
      };
    }
    case "a_tempo":
    case "tempo_primo": {
      const at = positionOf(args, false);
      return {
        type: "tempo-return",
        primo: action === "tempo_primo",
        ...(at ? { at } : {}),
      };
    }
    case "fermata": {
      const at = positionOf(args, false);
      return {
        type: "fermata",
        ...(at ? { at } : {}),
        beats:
          num(args, "beats", 0.25, TIME_LIMITS.maxFermataBeats) ??
          FERMATA_DEFAULT_BEATS,
      };
    }
    case "meter": {
      const meter = args.meter;
      const match =
        typeof meter === "string" ? /^(\d+)\/(\d+)$/.exec(meter) : null;
      if (!match) throw new ToolArgumentError("meter must look like 7/8");
      const bar = num(args, "bar", 1, SCORE_LIMITS.maxBars);
      return {
        type: "meter-at",
        beatsPerBar: Number(match[1]),
        beatUnit: Number(match[2]),
        ...(bar !== undefined ? { bar: Math.round(bar) } : {}),
      };
    }
    case "remove_tempo":
      return { type: "tempo-remove", at: positionOf(args, true)! };
    case "remove_fermata":
      return { type: "fermata-remove", at: positionOf(args, true)! };
    case "remove_meter": {
      const bar = num(args, "bar", 1, SCORE_LIMITS.maxBars);
      if (bar === undefined)
        throw new ToolArgumentError("remove_meter needs bar");
      return { type: "meter-remove", bar: Math.round(bar) };
    }
    case "phasing": {
      const cycle = num(args, "cycle", 0.25, 100_000);
      if (cycle === undefined)
        throw new ToolArgumentError("phasing needs cycle (beats)");
      const over = num(args, "over", 0.25, 1_000_000);
      return {
        type: "track-phasing",
        cycle,
        ...(over !== undefined ? { over } : {}),
        cycles: num(args, "cycles", -64, 64) ?? 1,
        ...stepArgs(args),
      };
    }
    case "track":
    case "clear":
      throw new ToolArgumentError("handled separately");
  }
}

const TRACK_FIELDS = ["rate", "phase", "cycle"] as const;

export const TIME_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "set_time",
    description:
      "Tempo map and meter: tempo (ramps), rit/accel, a_tempo, fermata, meter, removes and clear; per-track polytempo (action track) and phasing. Beats count from 0, bars from 1.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        bpm: {
          type: "number",
          minimum: TIME_LIMITS.minBpm,
          maximum: TIME_LIMITS.maxBpm,
        },
        beat: { type: "number", minimum: 0 },
        bar: { type: "integer", minimum: 1, maximum: SCORE_LIMITS.maxBars },
        ramp: { type: "string", enum: ["step", "linear", "exp"] },
        bars: { type: "number", minimum: 0.25 },
        beats: { type: "number", minimum: 0.25 },
        meter: { type: "string", pattern: "^\\d+/\\d+$" },
        what: {
          type: "string",
          enum: ["tempo", "meter", "fermatas", "track", "all"],
        },
        trackId: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
        rate: { type: ["number", "null"] },
        phase: { type: ["number", "null"] },
        cycle: { type: ["number", "null"] },
        over: { type: "number" },
        cycles: { type: "number" },
        hold: { type: "number" },
        drift: { type: "number" },
        shift: { type: "number" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    plan(args, context) {
      let score = context.score;
      const messages: string[] = [];
      const run = (trackId: string, command: TimeCommand) => {
        const result = applyTimeCommand(score, trackId, command);
        if (!result.ok) throw new ToolArgumentError(result.message);
        if (result.next) score = result.next;
        messages.push(result.message);
      };
      const action = args.action;
      let trackId: string | undefined;
      if (action === "track") {
        trackId = trackIdOf(args, context);
        const given = TRACK_FIELDS.filter((field) => field in args);
        if (given.length === 0)
          throw new ToolArgumentError("track needs rate, phase or cycle");
        for (const field of given) {
          const value =
            args[field] === null
              ? null
              : field === "rate"
                ? num(args, field, TIME_LIMITS.minRate, TIME_LIMITS.maxRate)!
                : num(args, field, -100_000, 100_000)!;
          run(trackId, { type: "track-time", field, value });
        }
      } else if (action === "clear") {
        const what = args.what ?? "all";
        if (what === "tempo" || what === "all")
          run("", { type: "tempo-clear" });
        if (what === "meter" || what === "all")
          run("", { type: "meter-clear" });
        if (what === "fermatas" || what === "all")
          run("", { type: "fermata-clear" });
        if (what === "track") {
          trackId = trackIdOf(args, context);
          run(trackId, { type: "track-time-off" });
        }
      } else {
        const command = timeToolCommand(args);
        if (command.type === "track-phasing")
          trackId = trackIdOf(args, context);
        run(trackId ?? "", command);
      }
      return {
        kind: "score",
        operations: diffScores(context.score, score),
        ...(trackId ? { trackId } : {}),
        summary: messages.join(" · "),
      };
    },
  },
]);

/** Stepped-phasing arguments; present ones switch phasing to steps. */
function stepArgs(args: Record<string, unknown>): {
  hold?: number;
  drift?: number;
  shift?: number;
} {
  const out: { hold?: number; drift?: number; shift?: number } = {};
  const hold = num(args, "hold", 0, 64);
  const drift = num(args, "drift", 1, 64);
  const shift = num(args, "shift", 0.0625, 100_000);
  if (hold !== undefined) out.hold = Math.round(hold);
  if (drift !== undefined) out.drift = Math.round(drift);
  if (shift !== undefined) out.shift = shift;
  return out;
}
