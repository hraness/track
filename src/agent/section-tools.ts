/**
 * Agent tools for song structure (0.5): `list_sections`, `edit_section`,
 * `set_form` and `add_transition`. They build the same commands the prompt
 * runs (src/commands/arrange.ts), so a tool call and `section …` / `form …`
 * / `build …` agree, and their operations are the score diff.
 *
 * Bars here count from 1 like the prompt and the bar ruler; the score and
 * the SDK store 0-based `startBar`.
 */
import { diffScores } from "../../core/diff.ts";
import { SCORE_LIMITS } from "../../core/score.ts";
import {
  arrangedBars,
  DROP_CUT_MIN,
  FILL_BEATS_MIN,
  FILL_STYLES,
  formatForm,
  type FillStyle,
} from "../../core/sections.ts";
import {
  applySectionCommand,
  describeArrangement,
  type SectionCommand,
} from "../commands/arrange.ts";
import type { AgentTool, ToolContext, ToolPlan } from "./tools.ts";
import { ToolArgumentError } from "./tools.ts";

const SECTION_ACTIONS = [
  "mark",
  "add",
  "duplicate",
  "move",
  "rename",
  "delete",
  "unmark",
  "mute",
  "unmute",
  "vary",
  "reset",
  "loop",
  "unloop",
] as const;

type SectionAction = (typeof SECTION_ACTIONS)[number];

const name = {
  type: "string",
  minLength: 1,
  maxLength: 32,
  description: "Section name: intro, verse, pre, chorus, build, drop, …",
} as const;

const bar = (description: string) =>
  ({
    type: "integer",
    minimum: 1,
    maximum: SCORE_LIMITS.maxBars,
    description,
  }) as const;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ToolArgumentError(`${field} must be a non-empty string`);
  return value.trim();
}

function count(value: unknown, field: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new ToolArgumentError(`${field} must be an integer 1..${max}`);
  return value;
}

function optionalBar(value: unknown, field: string): number | undefined {
  return value === undefined
    ? undefined
    : count(value, field, SCORE_LIMITS.maxBars) - 1;
}

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new ToolArgumentError(`${field} must be true or false`);
  return value;
}

/** Apply a prompt command and turn its result into a score plan. */
function plan(
  context: ToolContext,
  command: SectionCommand,
): ToolPlan & { kind: "score" } {
  const result = applySectionCommand(
    context.score,
    context.focusedTrackId,
    command,
  );
  if (!result.ok) throw new ToolArgumentError(result.message);
  return {
    kind: "score",
    operations: result.next ? diffScores(context.score, result.next) : [],
    trackId: context.focusedTrackId,
    summary: result.message,
  };
}

function sectionCommand(args: Record<string, unknown>): SectionCommand {
  const action = args.action as SectionAction;
  if (!SECTION_ACTIONS.includes(action))
    throw new ToolArgumentError(`action must be ${SECTION_ACTIONS.join(", ")}`);
  if (action === "unloop") return { type: "section-loop" };
  if (action === "add") {
    const command: { type: "section-add"; name?: string; bars?: number } = {
      type: "section-add",
    };
    if (args.name !== undefined) command.name = text(args.name, "name");
    if (args.bars !== undefined)
      command.bars = count(args.bars, "bars", SCORE_LIMITS.maxBars);
    return command;
  }
  const section = text(args.name, "name");
  switch (action) {
    case "mark": {
      const startBar = optionalBar(args.fromBar, "fromBar");
      if (startBar === undefined || args.bars === undefined)
        throw new ToolArgumentError("mark needs fromBar and bars");
      return {
        type: "section-mark",
        name: section,
        startBar,
        bars: count(args.bars, "bars", SCORE_LIMITS.maxBars),
      };
    }
    case "duplicate":
      return args.to === undefined
        ? { type: "section-dup", name: section }
        : { type: "section-dup", name: section, as: text(args.to, "to") };
    case "move": {
      if (args.toBar !== undefined)
        return {
          type: "section-move",
          name: section,
          to: { bar: optionalBar(args.toBar, "toBar")! },
        };
      if (args.before !== undefined)
        return {
          type: "section-move",
          name: section,
          to: { before: text(args.before, "before") },
        };
      if (args.after !== undefined)
        return {
          type: "section-move",
          name: section,
          to: { after: text(args.after, "after") },
        };
      throw new ToolArgumentError("move needs toBar, before or after");
    }
    case "rename":
      return { type: "section-rename", name: section, to: text(args.to, "to") };
    case "delete":
      return { type: "section-delete", name: section };
    case "unmark":
      return { type: "section-unmark", name: section };
    case "mute":
    case "unmute": {
      const tracks = Array.isArray(args.tracks) ? args.tracks : undefined;
      if (
        !tracks ||
        tracks.length === 0 ||
        tracks.some((id) => typeof id !== "string")
      )
        throw new ToolArgumentError(`${action} needs tracks: [track ids]`);
      return {
        type: "section-mute",
        name: section,
        tracks: tracks as string[],
        muted: action === "mute",
      };
    }
    case "vary": {
      const command: {
        type: "section-vary";
        name: string;
        track?: string;
        transpose?: number;
        gain?: number;
        off?: boolean;
      } = { type: "section-vary", name: section };
      if (args.trackId !== undefined)
        command.track = text(args.trackId, "trackId");
      if (args.transpose !== undefined) {
        if (
          typeof args.transpose !== "number" ||
          !Number.isInteger(args.transpose)
        )
          throw new ToolArgumentError("transpose must be whole semitones");
        command.transpose = args.transpose;
      }
      if (args.gain !== undefined) {
        if (typeof args.gain !== "number")
          throw new ToolArgumentError("gain must be a number 0..2");
        command.gain = args.gain;
      }
      if (args.transpose === undefined && args.gain === undefined)
        command.off = true;
      return command;
    }
    case "reset":
      return { type: "section-reset", name: section };
    case "loop":
      return { type: "section-loop", name: section };
  }
  throw new ToolArgumentError(`unknown action ${String(action)}`);
}

function transitionCommand(args: Record<string, unknown>): SectionCommand {
  const section =
    args.section === undefined ? undefined : text(args.section, "section");
  const at = optionalBar(args.atBar, "atBar");
  if (args.type === "build") {
    const options: Record<string, unknown> = {};
    if (section !== undefined) options.section = section;
    if (args.into !== undefined) options.into = text(args.into, "into");
    if (at !== undefined) options.startBar = at;
    if (args.bars !== undefined)
      options.bars = count(args.bars, "bars", SCORE_LIMITS.maxBars);
    for (const layer of ["riser", "roll", "sweep", "uplifter"] as const) {
      const value = flag(args[layer], layer);
      if (value !== undefined) options[layer] = value;
    }
    return { type: "build", options };
  }
  if (args.type === "drop") {
    const options: Record<string, unknown> = {};
    if (section !== undefined) options.section = section;
    if (at !== undefined) options.bar = at;
    if (args.cutBeats !== undefined) {
      if (
        typeof args.cutBeats !== "number" ||
        !Number.isFinite(args.cutBeats) ||
        args.cutBeats < DROP_CUT_MIN
      )
        throw new ToolArgumentError(
          "cutBeats must be a number of beats, 0 up to two bars",
        );
      options.cut = args.cutBeats;
    }
    const impact = flag(args.impact, "impact");
    if (impact !== undefined) options.impact = impact;
    return { type: "drop", options };
  }
  if (args.type === "fill") {
    const options: Record<string, unknown> = {};
    if (section !== undefined) options.section = section;
    if (at !== undefined) options.bar = at;
    if (args.beats !== undefined) {
      if (
        typeof args.beats !== "number" ||
        !Number.isFinite(args.beats) ||
        args.beats < FILL_BEATS_MIN
      )
        throw new ToolArgumentError(
          `beats must be a number of beats, ${FILL_BEATS_MIN} up to two bars`,
        );
      options.beats = args.beats;
    }
    if (args.style !== undefined) {
      if (!FILL_STYLES.includes(args.style as FillStyle))
        throw new ToolArgumentError(`style must be ${FILL_STYLES.join(", ")}`);
      options.style = args.style;
    }
    const crash = flag(args.crash, "crash");
    if (crash !== undefined) options.crash = crash;
    return { type: "fill", options };
  }
  throw new ToolArgumentError("type must be build, drop or fill");
}

export const SECTION_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "list_sections",
    description:
      "Show the song's sections (bars count from 1), the form, the looped section and the arranged length (or inspect sections).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    plan(_args, context) {
      const score = context.score;
      const sections = score.sections.map((section) => ({
        name: section.name,
        fromBar: section.startBar + 1,
        bars: section.bars,
        ...(section.mute ? { mute: section.mute } : {}),
        ...(section.vary ? { vary: section.vary } : {}),
      }));
      return {
        kind: "action",
        summary: "list sections",
        run: async () => ({
          content: JSON.stringify({
            ok: true,
            sections,
            form: formatForm(score.form) || null,
            loopSection: score.loopSection ?? null,
            arrangedBars: arrangedBars(score),
            text: describeArrangement(score),
          }),
          summary: `${sections.length} sections`,
        }),
      };
    },
  },
  {
    name: "edit_section",
    description:
      "Arrange song sections (named bar ranges; bars count from 1): mark, add, duplicate, move, rename, delete, unmark, mute/unmute, vary, reset, loop, unloop.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...SECTION_ACTIONS] },
        name,
        fromBar: bar("mark: first bar, 1-based"),
        bars: {
          type: "integer",
          minimum: 1,
          maximum: SCORE_LIMITS.maxBars,
          description: "mark/add: length in bars (add defaults to 8)",
        },
        to: {
          type: "string",
          maxLength: 32,
          description: "rename: new name; duplicate: the copy's name",
        },
        toBar: bar("move: the bar the section starts at afterwards"),
        before: { type: "string", maxLength: 32 },
        after: { type: "string", maxLength: 32 },
        tracks: {
          type: "array",
          items: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
          maxItems: 64,
        },
        trackId: {
          type: "string",
          maxLength: SCORE_LIMITS.maxIdLength,
          description: "vary: the track (default: the focused track)",
        },
        transpose: { type: "integer", minimum: -24, maximum: 24 },
        gain: { type: "number", minimum: 0, maximum: 2 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    plan(args, context) {
      return plan(context, sectionCommand(args));
    },
  },
  {
    name: "set_form",
    description:
      'Set the play order of sections with repeats, e.g. "intro verse chorus*2 outro"; empty clears; bake writes it out as plain bars.',
    parameters: {
      type: "object",
      properties: {
        form: { type: "string", maxLength: 1000 },
        bake: { type: "boolean" },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      if (args.bake === true) return plan(context, { type: "form-bake" });
      if (typeof args.form !== "string")
        throw new ToolArgumentError("set_form needs form or bake");
      return plan(context, {
        type: "form-set",
        text: args.form,
      });
    },
  },
  {
    name: "add_transition",
    description:
      "Generate a transition with built-in voices (bars count from 1): build (riser, roll, sweep, uplifter), drop (cut plus impact) or fill (drum fill plus crash), before a section, at a bar or at every boundary.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["build", "drop", "fill"] },
        section: name,
        into: name,
        atBar: bar(
          "build: first bar; drop: the bar it lands on; fill: the bar it leads into",
        ),
        bars: { type: "integer", minimum: 1, maximum: 64 },
        riser: { type: "boolean" },
        roll: { type: "boolean" },
        sweep: { type: "boolean" },
        uplifter: { type: "boolean" },
        cutBeats: { type: "number", minimum: 0 },
        impact: { type: "boolean" },
        beats: { type: "number", minimum: FILL_BEATS_MIN },
        style: { type: "string", enum: [...FILL_STYLES] },
        crash: { type: "boolean" },
      },
      required: ["type"],
      additionalProperties: false,
    },
    plan(args, context) {
      return plan(context, transitionCommand(args));
    },
  },
]);
