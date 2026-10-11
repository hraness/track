/**
 * Agent tool for the granular instrument: `set_granular` edits a track's
 * `Track.granular` through the same path as the `grain` prompt command, so
 * the command, the ctrl-k menu, the tool and the SDK store the same object.
 */
import {
  GRANULAR_PARAMS,
  GRANULAR_PRESET_NAMES,
  isGranularPreset,
  synthSourceNames,
} from "../../core/granular.ts";
import { SCORE_LIMITS } from "../../core/score.ts";
import {
  applyGranularCommand,
  type GranularCommand,
} from "../commands/granular.ts";
import type { AgentTool, ToolContext } from "./tools.ts";

class GranularToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

function targetTrack(args: Record<string, unknown>, context: ToolContext) {
  const trackId = args.trackId ?? context.focusedTrackId;
  if (typeof trackId !== "string" || trackId.length > SCORE_LIMITS.maxIdLength)
    throw new GranularToolError("trackId must be a short string");
  if (!context.score.tracks.some((track) => track.id === trackId))
    throw new GranularToolError(
      `unknown track ${trackId}; create it with create_track first`,
    );
  return trackId;
}

/** One tool call becomes the `grain` commands it stands for, in order. */
export function granularToolCommands(
  args: Record<string, unknown>,
): GranularCommand[] {
  const commands: GranularCommand[] = [];
  if (args.off === true) return [{ type: "grain-off" }];
  const voice =
    typeof args.voice === "string" && args.voice.length > 0
      ? args.voice.toLowerCase()
      : undefined;
  if (args.preset !== undefined) {
    if (typeof args.preset !== "string" || !isGranularPreset(args.preset))
      throw new GranularToolError(
        `granular presets: ${GRANULAR_PRESET_NAMES.join(", ")}`,
      );
    commands.push({ type: "grain-preset", preset: args.preset, voice });
  } else if (args.reset === true) commands.push({ type: "grain-reset" });
  else commands.push({ type: "grain-on", voice });
  if (args.src !== undefined) {
    if (typeof args.src !== "string")
      throw new GranularToolError("src must be synth:<name>[@note]");
    const text = args.src.startsWith("synth:") ? args.src : `synth:${args.src}`;
    commands.push({ type: "grain-src", synth: text.toLowerCase() });
  }
  if (args.params !== undefined) {
    if (
      typeof args.params !== "object" ||
      args.params === null ||
      Array.isArray(args.params)
    )
      throw new GranularToolError("params must be an object");
    const values: Record<string, number | string | boolean | null> = {};
    for (const [name, value] of Object.entries(args.params)) {
      if (!Object.prototype.hasOwnProperty.call(GRANULAR_PARAMS, name))
        throw new GranularToolError(
          `granular has no parameter ${name}; it takes ${Object.keys(GRANULAR_PARAMS).join(", ")}`,
        );
      if (
        value !== null &&
        typeof value !== "number" &&
        typeof value !== "string" &&
        typeof value !== "boolean"
      )
        throw new GranularToolError(`granular ${name} must be a value`);
      values[name] = value;
    }
    commands.push({ type: "grain-set", values });
  }
  return commands;
}

export const GRANULAR_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "set_granular",
    description:
      "Make a track a granular instrument or shape it: preset, src (synth:<name>[@note] or its sampler voice), params (null unsets), reset, off.",
    parameters: {
      type: "object",
      properties: {
        trackId: { type: "string" },
        preset: { type: "string", enum: [...GRANULAR_PRESET_NAMES] },
        src: { type: "string" },
        voice: { type: "string" },
        reset: { type: "boolean" },
        off: { type: "boolean" },
        params: {
          type: "object",
          additionalProperties: {
            type: ["number", "string", "boolean", "null"],
          },
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      let score = context.score;
      let message = "";
      for (const command of granularToolCommands(args)) {
        const result = applyGranularCommand(score, trackId, command);
        if (!result.ok) throw new GranularToolError(result.message);
        if (result.next) score = result.next;
        message = result.message;
      }
      const next = score.tracks.find((t) => t.id === trackId)!;
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: {
              instrument: next.instrument,
              granular: next.granular ?? null,
            },
          },
        ],
        trackId,
        summary: `${trackId} ${message}`,
      };
    },
  },
]);
