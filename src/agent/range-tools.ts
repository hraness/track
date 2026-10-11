/**
 * Agent tool for range edits (op1-ux §6.4): `edit_range` builds the same
 * line the prompt runs (`loop 5-6`, `copy bass 5-6 to 7 x2`, `bars insert
 * 2 at 3`, `section split chorus at 13`) and applies it through
 * src/commands/range.ts or src/commands/arrange.ts, so the tool, the typed
 * command and the menu agree. Its operations are the score diff.
 *
 * Bars count from 1, like the prompt and the bar ruler.
 */
import { diffScores } from "../../core/diff.ts";
import { SCORE_LIMITS, type TrackScore } from "../../core/score.ts";
import {
  applySectionCommand,
  loopSpan,
  parseSectionCommand,
} from "../commands/arrange.ts";
import { parseLoopCommand } from "../commands/grammar.ts";
import { applyRangeCommand, parseRangeCommand } from "../commands/range.ts";
import type { AgentTool, ToolContext, ToolPlan } from "./tools.ts";
import { ToolArgumentError } from "./tool-error.ts";

export const RANGE_ACTIONS = [
  "loop",
  "unloop",
  "copy",
  "move",
  "clear",
  "reverse",
  "insert_bars",
  "remove_bars",
  "split",
  "join",
] as const;

type RangeAction = (typeof RANGE_ACTIONS)[number];

const bar = (description: string) =>
  ({
    type: "integer",
    minimum: 1,
    maximum: SCORE_LIMITS.maxBars,
    description,
  }) as const;

function whole(value: unknown, what: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new ToolArgumentError(`${what} must be a whole number 1..${max}`);
  return value;
}

function word(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[\w .'-]{1,64}$/u.test(value.trim()))
    throw new ToolArgumentError(`${what} must be a name`);
  return value.trim();
}

/** `5-6`, `5`, or a section name: the range words of the typed command. */
function rangeWords(args: Record<string, unknown>): string {
  if (args.section !== undefined) return word(args.section, "section");
  if (args.fromBar === undefined)
    throw new ToolArgumentError("give fromBar (and toBar) or section");
  const from = whole(args.fromBar, "fromBar", SCORE_LIMITS.maxBars);
  const to =
    args.toBar === undefined
      ? from
      : whole(args.toBar, "toBar", SCORE_LIMITS.maxBars);
  if (to < from) throw new ToolArgumentError("toBar comes at or after fromBar");
  return from === to ? `${from}` : `${from}-${to}`;
}

function trackWord(
  args: Record<string, unknown>,
  context: ToolContext,
): string {
  if (args.allTracks === true) return "all";
  const id =
    args.trackId === undefined
      ? context.focusedTrackId
      : word(args.trackId, "trackId");
  if (!context.score.tracks.some((track) => track.id === id))
    throw new ToolArgumentError(`no track ${id}`);
  return id;
}

/** The typed command a call stands for (what show-me would type). */
export function rangeToolCommand(
  args: Record<string, unknown>,
  context: ToolContext,
): string {
  const action = args.action as RangeAction;
  if (!RANGE_ACTIONS.includes(action))
    throw new ToolArgumentError(`action must be ${RANGE_ACTIONS.join(", ")}`);
  switch (action) {
    case "loop":
      return `loop ${rangeWords(args)}`;
    case "unloop":
      return "loop off";
    case "copy":
    case "move": {
      if (args.toBar === undefined && args.atBar === undefined)
        throw new ToolArgumentError(`${action} needs atBar, where it lands`);
      const at = whole(args.atBar, "atBar", SCORE_LIMITS.maxBars);
      const times =
        action === "copy" && args.times !== undefined
          ? ` x${whole(args.times, "times", 64)}`
          : "";
      const mode =
        args.insert === true
          ? " insert"
          : action === "copy" && args.merge === true
            ? " merge"
            : "";
      return `${action} ${trackWord(args, context)} ${rangeWords(args)} to ${at}${times}${mode}`;
    }
    case "clear":
    case "reverse":
      return `${action} ${trackWord(args, context)} ${rangeWords(args)}`;
    case "insert_bars":
      return `bars insert ${whole(args.bars, "bars", SCORE_LIMITS.maxBars)} at ${whole(args.atBar, "atBar", SCORE_LIMITS.maxBars)}`;
    case "remove_bars":
      return `bars remove ${rangeWords(args)}`;
    case "split":
      return `section split ${word(args.section, "section")} at ${whole(args.atBar, "atBar", SCORE_LIMITS.maxBars)}`;
    case "join":
      return `section join ${word(args.section, "section")}`;
  }
}

function run(
  line: string,
  context: ToolContext,
): { next?: TrackScore; message: string } {
  const score = context.score;
  const loop = parseLoopCommand(line);
  if (loop?.type === "loop-bars") {
    const result = loopSpan(score, loop.from, loop.to);
    if (!result.ok) throw new ToolArgumentError(result.message);
    return { next: result.next, message: result.message };
  }
  if (loop?.type === "loop-off")
    return score.loop
      ? { next: score.withLoop(null), message: "loop · off · playing the song" }
      : run("section loop off", context);
  if (loop?.type === "loop-section")
    return run(`section loop ${loop.name}`, context);
  const range = parseRangeCommand(line, score);
  if (range) {
    const result = applyRangeCommand(
      score,
      { trackId: context.focusedTrackId, playheadBar: 0 },
      range,
    );
    if (!result.ok) throw new ToolArgumentError(result.message);
    return {
      ...(result.next ? { next: result.next } : {}),
      message: result.message,
    };
  }
  const section = parseSectionCommand(line, score);
  if (!section) throw new ToolArgumentError(`cannot run: ${line}`);
  const result = applySectionCommand(score, context.focusedTrackId, section);
  if (!result.ok) throw new ToolArgumentError(result.message);
  return {
    ...(result.next ? { next: result.next } : {}),
    message: result.message,
  };
}

export const RANGE_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "edit_range",
    description:
      "Edit bar ranges (fromBar..toBar or a section; bars count from 1): loop, unloop, copy, move, clear, reverse, insert_bars, remove_bars, split, join. One undo step each.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...RANGE_ACTIONS] },
        fromBar: bar("first bar of the range"),
        toBar: bar("last bar of the range (default fromBar)"),
        section: {
          type: "string",
          maxLength: 32,
          description: "a section as the range (split/join: the section)",
        },
        atBar: bar("copy/move: where it lands; insert_bars/split: the bar"),
        bars: bar("insert_bars: how many"),
        times: { type: "integer", minimum: 1, maximum: 64 },
        trackId: {
          type: "string",
          maxLength: SCORE_LIMITS.maxIdLength,
          description: "the track (default: the focused track)",
        },
        allTracks: { type: "boolean" },
        insert: { type: "boolean" },
        merge: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    plan(args, context): ToolPlan {
      const line = rangeToolCommand(args, context);
      const result = run(line, context);
      return {
        kind: "score",
        operations: result.next ? diffScores(context.score, result.next) : [],
        trackId: context.focusedTrackId,
        summary: result.message,
      };
    },
  },
]);
