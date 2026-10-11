/**
 * Agent tool `resample` (0.6.1): the `resample` prompt command for the
 * model. Renders a track, an orbit or the master over the song, a section
 * or a bar range to a pinned WAV under the project and adds a sampler (or,
 * with grain, a granular) track that plays it, committed as ordinary score
 * operations.
 */
import { SCORE_LIMITS } from "../../core/score.ts";
import {
  parseResampleCommand,
  runResample,
  type ResampleCommand,
} from "../commands/resample.ts";
import { hasSamplerTracks, SampleLibrary } from "../audio/samples.ts";
import type { AgentTool } from "./tools.ts";

class ResampleToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

/** The tool's arguments as the prompt command they stand for. */
export function resampleToolCommand(
  args: Record<string, unknown>,
  focusedTrackId: string,
): ResampleCommand {
  const words = ["resample"];
  const source = args.source ?? "track";
  if (source === "track") {
    const trackId = args.trackId ?? focusedTrackId;
    if (typeof trackId !== "string" || trackId.length === 0)
      throw new ResampleToolError("trackId must be a track id");
    words.push(trackId);
  } else if (source === "orbit") {
    if (!Number.isInteger(args.orbit))
      throw new ResampleToolError("orbit must be an integer");
    words.push("orbit", String(args.orbit));
  } else if (source === "master") words.push("master");
  else throw new ResampleToolError("source is track, orbit or master");
  if (args.section !== undefined) {
    if (typeof args.section !== "string" || args.section.length === 0)
      throw new ResampleToolError("section must be a section name");
    words.push("section", args.section);
  } else if (args.bars !== undefined) {
    const bars = args.bars;
    if (
      !Array.isArray(bars) ||
      bars.length !== 2 ||
      !bars.every((bar) => Number.isInteger(bar))
    )
      throw new ResampleToolError("bars must be [first, last], 1-based");
    words.push("bars", `${bars[0]}-${bars[1]}`);
  }
  if (args.post === true) words.push("post");
  if (args.grain === true) words.push("grain");
  if (args.as !== undefined) {
    if (typeof args.as !== "string")
      throw new ResampleToolError("as must be a track id");
    words.push("as", args.as);
  }
  const command = parseResampleCommand(words.join(" "));
  if (!command) throw new ResampleToolError(`cannot ${words.join(" ")}`);
  return command;
}

export const RESAMPLE_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "resample",
    description:
      "Bounce a track, orbit or the master (song, section or bars) to a pinned WAV and add a sampler (or granular) track that plays it.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["track", "orbit", "master"] },
        trackId: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
        orbit: { type: "integer", minimum: 1, maximum: 16 },
        section: { type: "string" },
        bars: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          minItems: 2,
          maxItems: 2,
        },
        grain: { type: "boolean" },
        post: { type: "boolean" },
        as: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const command = resampleToolCommand(args, context.focusedTrackId);
      return {
        kind: "prepare",
        summary: "resample",
        run: async (action) => {
          const root = action.workspace?.root ?? process.cwd();
          const samples = hasSamplerTracks(context.score)
            ? await new SampleLibrary({
                projectRoot: root,
                ...(action.packs ? { packs: action.packs } : {}),
              }).load(context.score)
            : undefined;
          const result = await runResample({
            projectRoot: root,
            score: context.score,
            command,
            ...(samples ? { samples } : {}),
          });
          if (!result.ok) throw new ResampleToolError(result.message);
          const track = result.next.tracks.find(
            (t) => t.id === result.trackId,
          )!;
          const notes = result.next.notes.filter(
            (note) => note.trackId === result.trackId,
          );
          return {
            kind: "score",
            operations: [
              { type: "addTrack", track },
              ...notes.map((note) => ({ type: "addNote" as const, note })),
            ],
            summary: result.message,
            trackId: result.trackId,
          };
        },
      };
    },
  },
]);
