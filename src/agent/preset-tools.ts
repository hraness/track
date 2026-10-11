/**
 * Agent tools for the preset library (core/presets): `preset_catalog`
 * lists, searches and describes presets compactly; `use_preset` loads one
 * on a track (the same as typing `preset <name>`, one undo step).
 */
import { diffScores } from "../../core/diff.ts";
import { PRESET_CATEGORIES } from "../../core/presets/build.ts";
import type { PresetCategory } from "../../core/presets/build.ts";
import { PRESETS, presetByName } from "../../core/presets/index.ts";
import {
  findPresets,
  knobNames,
  presetInfo,
  presetsIn,
  trackPreset,
  usePreset,
} from "../commands/preset.ts";
import type { AgentTool } from "./tools.ts";
import { ToolArgumentError } from "./tool-error.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_ROWS = 40;

/** `warm-pad · pad · Grit Motion Space Bloom · lush detuned pad`. */
function row(name: string): string {
  const preset = presetByName(name)!;
  const knobs = preset.kind === "kit" ? `kit ${preset.kit}` : knobNames(preset);
  return `${preset.name} · ${preset.category} · ${knobs} · ${preset.desc}`;
}

function describe(name: string): string {
  const preset = presetByName(name);
  if (!preset) throw new ToolArgumentError(`no preset ${name.slice(0, 40)}`);
  return [
    ...presetInfo(preset),
    preset.kind === "kit"
      ? "load: use_preset on a drum track"
      : "load: use_preset; turn knobs with patch_edit (patch knob <knob> <0..1>)",
  ].join("\n");
}

export const PRESET_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "preset_catalog",
    description:
      "Browse the built-in preset library: list a category, search by name or tag (fuzzy), or describe one preset (what it shows, its four knobs, similar presets). Read only; use_preset loads one.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...PRESET_CATEGORIES],
          description: "List one category.",
        },
        query: {
          type: "string",
          maxLength: 60,
          description:
            "Search words: a name, tag or knob (e.g. 'warm pad', '808', 'fm').",
        },
        name: {
          type: "string",
          maxLength: 40,
          description: "Describe this preset.",
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      for (const key of Object.keys(args))
        if (!["category", "query", "name"].includes(key))
          throw new ToolArgumentError(`unknown argument ${key}`);
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const category =
        typeof args.category === "string" ? args.category : undefined;
      if (
        category &&
        !(PRESET_CATEGORIES as readonly string[]).includes(category)
      )
        throw new ToolArgumentError(`no category ${category.slice(0, 20)}`);
      let content: string;
      let summary: string;
      if (name) {
        content = describe(name);
        summary = `preset ${name}`;
      } else if (category || query) {
        let list = category ? presetsIn(category as PresetCategory) : PRESETS;
        if (query) {
          const found = new Set(findPresets(query));
          list = list.filter((p) => found.has(p));
        }
        content = list.length
          ? list
              .slice(0, MAX_ROWS)
              .map((p) => row(p.name))
              .join("\n") +
            (list.length > MAX_ROWS ? `\n… ${list.length - MAX_ROWS} more` : "")
          : `nothing matches · categories: ${PRESET_CATEGORIES.join(" ")}`;
        summary = `${list.length} presets`;
      } else {
        const current = trackPreset(
          context.score.tracks.find((t) => t.id === context.focusedTrackId),
        );
        content = [
          `${PRESETS.length} presets · category (count): ${PRESET_CATEGORIES.map((c) => `${c} (${presetsIn(c).length})`).join(", ")}`,
          current
            ? `${context.focusedTrackId} plays ${current.name}`
            : `${context.focusedTrackId} plays no preset`,
          "list a category, or search with query",
        ].join("\n");
        summary = "preset catalog";
      }
      return {
        kind: "action",
        summary,
        async run() {
          return { content, summary };
        },
      };
    },
  },
  {
    name: "use_preset",
    description:
      "Load a built-in preset on a track (same as typing `preset <name>`): an instrument patch with four named knobs, an fx chain added after the track's effects, or a kit on a drum track.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 40, description: "Preset name." },
        trackId: {
          type: "string",
          maxLength: 64,
          description: "Target track id. Defaults to the focused track.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    plan(args, context) {
      for (const key of Object.keys(args))
        if (!["name", "trackId"].includes(key))
          throw new ToolArgumentError(`unknown argument ${key}`);
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!NAME.test(name)) throw new ToolArgumentError("name a preset");
      const preset = presetByName(name);
      if (!preset)
        throw new ToolArgumentError(
          `no preset ${name} · preset_catalog lists them`,
        );
      const trackId =
        typeof args.trackId === "string"
          ? args.trackId
          : context.focusedTrackId;
      const result = usePreset(context.score, trackId, preset);
      if (!result.ok) throw new ToolArgumentError(result.message);
      return {
        kind: "score",
        operations: result.next ? diffScores(context.score, result.next) : [],
        trackId,
        summary: result.message.slice(0, 160),
      };
    },
  },
] satisfies AgentTool[]);
