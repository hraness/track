import { portableSchema } from "./portable-schema.ts";
import { midiToPitch } from "../../core/pitch.ts";
import { isGuideInstrument, vocalChainPatch } from "../../core/clips.ts";
import { INSTRUMENT_WORDS } from "../../core/instruments.ts";
import type { TrackVocoder } from "../../core/vocoder.ts";
import {
  DEFAULT_STRING_PRESET,
  STRING_INSTRUMENT,
} from "../../core/strings.ts";
import {
  instrumentPatchForWord,
  MODAL_ALIASES,
  MODAL_MALLET_NAMES,
  MODAL_PARAMS,
  MODAL_PRESET_NAMES,
  modalParamName,
  modalPresetFor,
  type TrackModal,
} from "../../core/resonators.ts";
import { applyModalCommand, type ModalCommand } from "../commands/modal.ts";
import { applyWindCommand, type WindCommand } from "../commands/wind.ts";
import {
  type TrackWind,
  WIND_ALIASES,
  WIND_PARAMS,
  WIND_PRESET_NAMES,
  windParamName,
  windPresetFor,
} from "../../core/winds.ts";
import {
  AUTOMATION_PARAMETERS,
  automationPoints,
  automationRange,
  SCORE_LIMITS,
  type AutomationParameter,
  type ScoreOperation,
  type TrackScore,
} from "../../core/score.ts";
import { loopTicksOf } from "../../core/tempo.ts";
import { AVAILABLE_INSTRUMENTS } from "../audio/wav.ts";
import {
  SYNTH_PRESETS,
  SYNTH_SIMPLE,
  isSynthPreset,
  synthParamName,
} from "../../core/synth.ts";
import { applySynthCommand, type SynthCommand } from "../commands/synth.ts";
import { applyStringCommand, type StringCommand } from "../commands/string.ts";
import {
  STRING_PARAMS,
  STRING_PRESET_NAMES,
  stringParamName,
  stringPresetName,
} from "../../core/strings.ts";
import {
  applyKeysCommand,
  keysPresetPatch,
  type KeysCommand,
} from "../commands/keys.ts";
import {
  KEYS_PRESETS,
  ORGAN_ALIASES,
  KEYS_SIMPLE,
  isKeysPreset,
  keysParamName,
  pianoWrite,
} from "../../core/keys.ts";
import {
  setSampleControls,
  type SampleControlValue,
} from "../commands/sample.ts";
import {
  EFFECT_NAMES,
  FX_PRESETS,
  RIG_STAGES,
  effectSpec,
  type EffectName,
} from "../../core/fx.ts";
import {
  RIG_PRESET_NAMES,
  applyRigCommand,
  parseRigCommand,
  rigTrackFields,
  rigWordPatch,
} from "../commands/rig.ts";
import {
  applyFxCommand,
  effectPatch,
  effectValues,
  FORMANT_VOWEL_HINT,
  formantGotVowel,
  parseEffectName,
  parseParamName,
  parseFxCommand,
  type FxCommand,
  type FxResult,
} from "../commands/fx.ts";
import type { ChatTool } from "./gateway.ts";
import { MEDIA_TOOLS } from "../media/tools.ts";
import { PACK_TOOLS, PackToolError } from "./pack-tools.ts";
import {
  PreviewToolError,
  previewSoundTool,
  type PreviewHost,
} from "./preview-tool.ts";
import { PackError, type PackStore } from "../audio/packs.ts";
import { RHYTHM_TOOLS } from "./rhythm-tools.ts";
import { CHORD_TOOLS } from "./chord-tools.ts";
import { EXPRESSION_TOOLS } from "./expression-tools.ts";
import { TUNING_TOOLS } from "./tuning-tools.ts";
import { CALIBRATION_TOOLS } from "./calibration-tools.ts";
import { MASTER_TOOLS } from "./master-tools.ts";
import { PATCH_TOOLS } from "./patch-tools.ts";
import { STYLE_TOOLS } from "./style-tools.ts";
import { DRUM_TOOLS } from "./drum-tools.ts";
import { TIME_TOOLS } from "./time-tools.ts";
import { SECTION_TOOLS } from "./section-tools.ts";
import { RANGE_TOOLS } from "./range-tools.ts";
import { GRANULAR_TOOLS } from "./granular-tools.ts";
import { RESAMPLE_TOOLS } from "./resample-tool.ts";
import { VOICE_TOOLS } from "./voice-tools.ts";
import type { MediaResult, MediaRunContext } from "../media/types.ts";
import { instrumentPatch, pitchToMidi } from "./ops.ts";
import { TUNING_LIMITS } from "../../core/tuning.ts";
import {
  DRUM_VOICES,
  drumVoicePitch,
  isDrumInstrument,
  parseDrumVoice,
  type DrumVoice,
} from "../../core/drums.ts";
import { trackSlug } from "../../core/slug.ts";
import {
  editFile,
  listFiles,
  readFile,
  WORKSPACE_LIMITS,
  WorkspaceError,
  writeFile,
  type WorkspaceScope,
} from "./workspace.ts";
import {
  fetchUrl,
  FETCH_LIMITS,
  formatFetchedPage,
  type Lookup,
} from "../web/fetch.ts";
import { WebError, type FetchLike } from "../web/http.ts";
import {
  describeSearchProvider,
  formatSearchResults,
  SEARCH_LIMITS,
  webSearch,
  type SearchSpend,
} from "../web/search.ts";

/** Instrument words the tools accept: legacy voices, `string`, 0.6 words. */
const INSTRUMENT_ENUM: string[] = [
  ...AVAILABLE_INSTRUMENTS,
  STRING_INSTRUMENT,
  ...INSTRUMENT_WORDS.map((row) => row.word),
].filter((word, index, all) => all.indexOf(word) === index);

/** What a validated tool call asks the host to do. */
export type ScorePlan = Readonly<{
  kind: "score";
  operations: readonly ScoreOperation[];
  summary: string;
  trackId?: string;
}>;

export type ToolPlan =
  | Readonly<{
      kind: "score";
      operations: readonly ScoreOperation[];
      summary: string;
      trackId?: string;
    }>
  | Readonly<{
      kind: "transport";
      action: "play" | "pause" | "toggle";
      summary: string;
    }>
  | Readonly<{ kind: "explain"; text: string; summary: string }>
  | Readonly<{
      kind: "action";
      summary: string;
      /** Side effects outside the score (files, network); bounded and async. */
      run: (context: ActionContext) => Promise<ActionResult>;
    }>
  /**
   * Score edits that need async work first (fetching a pack sound); `run`
   * returns the score plan, committed like any other.
   */
  | Readonly<{
      kind: "prepare";
      summary: string;
      run: (context: ActionContext) => Promise<ScorePlan>;
    }>
  /** A long-running local media job (download, stems, analysis, …). */
  | Readonly<{
      kind: "media";
      summary: string;
      run: (context: MediaRunContext) => Promise<MediaResult>;
    }>;

/** The project directory the workspace tools operate in. */
export type WorkspaceHost = Readonly<{ root: string }>;

/** Injection points for the web tools; defaults are the real network. */
export type WebHost = Readonly<{
  fetch?: FetchLike;
  lookup?: Lookup;
  /** Brave Web Search API key; defaults to `BRAVE_SEARCH_API_KEY` and overrides the chain. */
  braveApiKey?: string;
  /** AI Gateway key of the active provider; enables gateway search tools. */
  gatewayApiKey?: string;
  gatewayBaseUrl?: string;
  /** Gateway search tool; defaults to `DAWG_WEB_SEARCH`, then `exa`. */
  searchTool?: string;
  /** OpenRouter key; defaults to `OPENROUTER_API_KEY`. */
  openRouterApiKey?: string;
  openRouterBaseUrl?: string;
  /**
   * Billed searches (gateway tools, OpenRouter web plugin) are reported here
   * so the host can add them to its spend ledger (`webHostFor` in
   * `src/agent/usage.ts`).
   */
  onSpend?: (spend: SearchSpend) => void;
}>;

/** What an `action` plan receives from the host when it runs. */
export type ActionContext = Readonly<{
  workspace?: WorkspaceHost;
  /**
   * Called after a successful `write_file`/`edit_file` with the
   * project-relative path. Returned text (for example typecheck
   * diagnostics) is appended to the tool result.
   */
  onWorkspaceWrite?: (path: string) => Promise<string | void> | string | void;
  web?: WebHost;
  signal?: AbortSignal;
  /** Sample packs for list_packs/search_sounds/use_sound; default the user cache. */
  packs?: PackStore;
  /** Render and play hooks for preview_sound; absent renders in-thread, silent. */
  preview?: PreviewHost;
}>;

export type ActionResult = Readonly<{
  /** What the model reads; already bounded by the tool. */
  content: string;
  /** One line for the activity card. */
  summary: string;
  /** True when something outside the score changed (a file write). */
  mutated?: boolean;
}>;

export type ToolContext = Readonly<{
  score: TrackScore;
  focusedTrackId: string;
  revision: number;
  /** Deterministic per-call note ID factory. */
  newNoteId: (trackId: string, index: number) => string;
}>;

export type AgentTool = Readonly<{
  name: string;
  description: string;
  /**
   * Callable but not advertised: a duplicate kept so older transcripts and
   * models still work. `chatTools` and the xcb catalog leave it out.
   */
  hidden?: boolean;
  parameters: Record<string, unknown>;
  plan: (args: Record<string, unknown>, context: ToolContext) => ToolPlan;
}>;

import { ToolArgumentError } from "./tool-error.ts";
export { ToolArgumentError };

const MAX_NOTES_PER_CALL = 128;
const MAX_EXPLAIN_CHARS = 2_000;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const trackIdSchema = {
  type: "string",
  description: "Target track id. Defaults to the focused track.",
  maxLength: SCORE_LIMITS.maxIdLength,
};
const beatSchema = (description: string) => ({
  type: "number",
  minimum: 0,
  description,
});

/**
 * One tool per score operation family. Add a new family by appending an entry
 * here; the agent loop, schemas, and validation pick it up automatically.
 */
export const AGENT_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "add_notes",
    description:
      "Add notes to one track. Times are in beats from the loop start; pitch is MIDI 0..127 or a name like C4/F#2.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        notes: {
          type: "array",
          minItems: 1,
          maxItems: MAX_NOTES_PER_CALL,
          items: {
            type: "object",
            properties: {
              pitch: {
                anyOf: [
                  { type: "integer", minimum: 0, maximum: 127 },
                  { type: "string", maxLength: 4 },
                ],
              },
              start: beatSchema("Start in beats"),
              duration: {
                type: "number",
                exclusiveMinimum: 0,
                description: "Length in beats",
              },
              velocity: { type: "number", minimum: 0, maximum: 1 },
              cents: {
                type: "number",
                minimum: -TUNING_LIMITS.maxNoteCents,
                maximum: TUNING_LIMITS.maxNoteCents,
                description: "Detune from the tuned pitch (microtones)",
              },
            },
            required: ["pitch", "start", "duration"],
            additionalProperties: false,
          },
        },
      },
      required: ["notes"],
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const notes = list(args, "notes", 1, MAX_NOTES_PER_CALL);
      const tpb = context.score.ticksPerBeat;
      const operations = notes.map((value, index): ScoreOperation => {
        const note = record(value, `notes[${index}]`);
        const start = number(note, "start", { min: 0 });
        const duration = number(note, "duration", { min: 0, exclusive: true });
        const velocity = optionalNumber(note, "velocity", { min: 0, max: 1 });
        const cents = optionalNumber(note, "cents", {
          min: -TUNING_LIMITS.maxNoteCents,
          max: TUNING_LIMITS.maxNoteCents,
        });
        return {
          type: "addNote",
          note: {
            id: context.newNoteId(trackId, index),
            trackId,
            startTick: Math.round(start * tpb),
            durationTicks: Math.max(1, Math.round(duration * tpb)),
            pitch: pitch(note.pitch, `notes[${index}].pitch`),
            velocity: velocity ?? 0.8,
            ...(cents ? { cents } : {}),
          },
        };
      });
      return {
        kind: "score",
        operations,
        trackId,
        summary: `+${operations.length} ${trackId} note${operations.length === 1 ? "" : "s"}`,
      };
    },
  },
  {
    name: "remove_notes",
    description:
      "Remove notes by id, or every note on a track with all=true. Note ids come from the composition brief.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        noteIds: {
          type: "array",
          maxItems: MAX_NOTES_PER_CALL,
          items: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
        },
        all: { type: "boolean" },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      if (args.all === true) {
        const trackId = targetTrack(args, context);
        return {
          kind: "score",
          operations: [{ type: "clearTrack", trackId }],
          trackId,
          summary: `cleared ${trackId}`,
        };
      }
      const ids = list(args, "noteIds", 1, MAX_NOTES_PER_CALL).map((id, i) =>
        knownNoteId(id, context, `noteIds[${i}]`),
      );
      return {
        kind: "score",
        operations: ids.map((noteId) => ({ type: "removeNote", noteId })),
        summary: `−${ids.length} note${ids.length === 1 ? "" : "s"}`,
      };
    },
  },
  {
    name: "update_notes",
    description:
      "Move, resize, transpose, re-velocity or detune existing notes by id (times in beats). Prefer transpose (semitones relative) over an absolute pitch.",
    parameters: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          minItems: 1,
          maxItems: MAX_NOTES_PER_CALL,
          items: {
            type: "object",
            properties: {
              noteId: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
              start: beatSchema("New start in beats"),
              duration: { type: "number", exclusiveMinimum: 0 },
              pitch: {
                anyOf: [
                  { type: "integer", minimum: 0, maximum: 127 },
                  { type: "string", maxLength: 4 },
                ],
              },
              transpose: {
                type: "integer",
                minimum: -127,
                maximum: 127,
                description:
                  "Semitones relative to the current pitch (not with pitch)",
              },
              velocity: { type: "number", minimum: 0, maximum: 1 },
              cents: {
                type: "number",
                minimum: -TUNING_LIMITS.maxNoteCents,
                maximum: TUNING_LIMITS.maxNoteCents,
                description: "Detune from the tuned pitch; 0 clears it",
              },
            },
            required: ["noteId"],
            additionalProperties: false,
          },
        },
      },
      required: ["updates"],
      additionalProperties: false,
    },
    plan(args, context) {
      const tpb = context.score.ticksPerBeat;
      // Pitch changes as before→after, so the model sees what it did and
      // does not transpose again from the refreshed brief.
      const moves: string[] = [];
      const operations = list(args, "updates", 1, MAX_NOTES_PER_CALL).map(
        (value, index): ScoreOperation => {
          const update = record(value, `updates[${index}]`);
          const noteId = knownNoteId(
            update.noteId,
            context,
            `updates[${index}].noteId`,
          );
          const patch: Record<string, number> = {};
          const start = optionalNumber(update, "start", { min: 0 });
          if (start !== undefined) patch.startTick = Math.round(start * tpb);
          const duration = optionalNumber(update, "duration", {
            min: 0,
            exclusive: true,
          });
          if (duration !== undefined)
            patch.durationTicks = Math.max(1, Math.round(duration * tpb));
          const before = context.score.notes.find((n) => n.id === noteId);
          if (update.pitch !== undefined)
            patch.pitch = pitch(update.pitch, `updates[${index}].pitch`);
          // Small models fill every field: transpose 0 beside a pitch means
          // no shift, and a pitch that equals the transposed note agrees.
          if (
            patch.pitch !== undefined &&
            update.transpose !== undefined &&
            update.transpose !== 0 &&
            patch.pitch !== (before?.pitch ?? 0) + Number(update.transpose)
          )
            throw new ToolArgumentError(
              `updates[${index}] sets both pitch and transpose; use one`,
            );
          if (update.transpose !== undefined && patch.pitch === undefined) {
            const shift = update.transpose;
            if (typeof shift !== "number" || !Number.isInteger(shift))
              throw new ToolArgumentError(
                `updates[${index}].transpose must be whole semitones`,
              );
            const moved = (before?.pitch ?? 0) + shift;
            if (moved < 0 || moved > 127)
              throw new ToolArgumentError(
                `updates[${index}].transpose moves ${noteId} to MIDI ${moved}, outside 0..127`,
              );
            patch.pitch = moved;
          }
          if (
            patch.pitch !== undefined &&
            before &&
            patch.pitch !== before.pitch
          )
            moves.push(
              `${noteId} ${midiToPitch(before.pitch)}→${midiToPitch(patch.pitch)}`,
            );
          const velocity = optionalNumber(update, "velocity", {
            min: 0,
            max: 1,
          });
          if (velocity !== undefined) patch.velocity = velocity;
          const cents = optionalNumber(update, "cents", {
            min: -TUNING_LIMITS.maxNoteCents,
            max: TUNING_LIMITS.maxNoteCents,
          });
          if (cents !== undefined) patch.cents = cents;
          if (Object.keys(patch).length === 0)
            throw new ToolArgumentError(`updates[${index}] changes nothing`);
          return { type: "updateNote", noteId, patch };
        },
      );
      return {
        kind: "score",
        operations,
        summary: `~${operations.length} note${operations.length === 1 ? "" : "s"}${
          moves.length === 0
            ? ""
            : ` · pitch ${moves.slice(0, 8).join(", ")}${moves.length > 8 ? ` +${moves.length - 8} more` : ""}`
        }`,
      };
    },
  },
  {
    name: "set_instrument",
    description:
      "Change a track's instrument voice (mallets and bells: set_modal shapes them; electric keys: set_keys; winds and brass: set_wind).",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        instrument: { type: "string", enum: INSTRUMENT_ENUM },
      },
      required: ["instrument"],
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      // piano/grand/upright/felt…: a new write is the modelled piano.
      const track = context.score.tracks.find((t) => t.id === trackId);
      if (track && typeof args.instrument === "string") {
        const word = args.instrument.toLowerCase();
        // `rhodes`, `wurlitzer`, `clavinet` name their electric presets.
        const preset = pianoWrite(word)?.preset ?? word;
        if (isKeysPreset(preset)) {
          const patch = keysPresetPatch(track, preset);
          return {
            kind: "score",
            operations: [{ type: "updateTrack", trackId, patch }],
            trackId,
            summary: `${trackId} → ${patch.instrument} (${preset})`,
          };
        }
      }
      const patch = instrumentName(args.instrument);
      // A guitar alias (`jangle`, `gtr-metal`…) also loads its rig.
      const rig = rigWordPatch(String(args.instrument), track?.fx);
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: {
              // `vocal` (0.7): the vocal chain fills unset effects.
              ...(isGuideInstrument(patch.instrument)
                ? vocalChainPatch(track)
                : {}),
              ...patch,
              ...rig,
            },
          },
        ],
        trackId,
        summary:
          patch.instrument === "marimba" && !patch.modal
            ? `${trackId} → marimba (legacy tone) · set_modal preset marimba for the mallet engine`
            : `${trackId} → ${patch.string?.preset ?? patch.modal?.preset ?? patch.wind?.preset ?? patch.instrument}`,
      };
    },
  },
  {
    name: "set_mix",
    description:
      "Set a track's static volume (0..1), pan (-1 left .. 1 right), mute, or solo. While any track is soloed only soloed tracks play.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        volume: { type: "number", minimum: 0, maximum: 1 },
        pan: { type: "number", minimum: -1, maximum: 1 },
        muted: { type: "boolean" },
        solo: { type: "boolean" },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const patch: {
        volume?: number;
        pan?: number;
        muted?: boolean;
        solo?: boolean;
      } = {};
      const volume = optionalNumber(args, "volume", { min: 0, max: 1 });
      if (volume !== undefined) patch.volume = volume;
      const pan = optionalNumber(args, "pan", { min: -1, max: 1 });
      if (pan !== undefined) patch.pan = pan;
      if (args.muted !== undefined) {
        if (typeof args.muted !== "boolean")
          throw new ToolArgumentError("muted must be a boolean");
        patch.muted = args.muted;
      }
      if (args.solo !== undefined) {
        if (typeof args.solo !== "boolean")
          throw new ToolArgumentError("solo must be a boolean");
        patch.solo = args.solo;
      }
      const parts = Object.entries(patch).map(([key, value]) =>
        key === "muted"
          ? value
            ? "muted"
            : "unmuted"
          : key === "solo"
            ? value
              ? "solo"
              : "unsolo"
            : `${key} ${value}`,
      );
      if (parts.length === 0)
        throw new ToolArgumentError(
          "set_mix needs volume, pan, muted, or solo",
        );
      return {
        kind: "score",
        operations: [{ type: "updateTrack", trackId, patch }],
        trackId,
        summary: `${trackId} ${parts.join(", ")}`,
      };
    },
  },
  {
    name: "set_automation",
    description:
      "Write an automation lane (volume, pan, filter, resonance, delay-feedback, delay-mix, wt or <effect>-<param>). mode replace (default) rewrites the lane, merge keeps other beats; an empty replace clears it.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        parameter: {
          type: "string",
          description:
            "volume, pan, filter, resonance, delay-feedback, delay-mix, <effect>-<param>, or grain-<param> on a granular track",
        },
        mode: { type: "string", enum: ["replace", "merge"] },
        points: {
          type: "array",
          maxItems: SCORE_LIMITS.maxAutomationPoints,
          items: {
            type: "object",
            properties: {
              beat: beatSchema("Beat position"),
              value: {
                type: "number",
                description: "in the lane's range",
              },
            },
            required: ["beat", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["parameter", "points"],
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const parameter = oneOf(
        args.parameter,
        AUTOMATION_PARAMETERS,
        "parameter",
      );
      const mode =
        args.mode === undefined
          ? "replace"
          : oneOf(args.mode, ["replace", "merge"], "mode");
      const { min, max } = automationRange(parameter);
      const tpb = context.score.ticksPerBeat;
      const points = list(
        args,
        "points",
        0,
        SCORE_LIMITS.maxAutomationPoints,
      ).map((value, index) => {
        const point = record(value, `points[${index}]`);
        return {
          tick: Math.round(number(point, "beat", { min: 0 }) * tpb),
          value: number(point, "value", { min, max }),
        };
      });
      const track = context.score.tracks.find((t) => t.id === trackId)!;
      const existing = automationPoints(track, parameter);
      const merged = Array.from(
        new Map(
          [...(mode === "merge" ? existing : []), ...points].map((point) => [
            point.tick,
            point,
          ]),
        ).values(),
      ).sort((left, right) => left.tick - right.tick);
      return {
        kind: "score",
        operations: [
          { type: "setAutomation", trackId, parameter, points: merged },
        ],
        trackId,
        summary:
          merged.length === 0
            ? `${trackId} ${parameter} automation cleared`
            : `${trackId} ${parameter} automation · ${merged.length} point${merged.length === 1 ? "" : "s"}`,
      };
    },
  },
  {
    name: "set_fx",
    description:
      "Turn an effect on/off, load a preset, or set params by dawg or Strudel name (lpq, delayfeedback…). on:true uses good defaults; effects and presets are in the brief.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        effect: { type: "string", description: "see the brief's effects" },
        on: { type: "boolean" },
        preset: { type: "string" },
        params: {
          type: "object",
          additionalProperties: { type: ["number", "string", "boolean"] },
        },
      },
      required: ["effect"],
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const effect =
        typeof args.effect === "string"
          ? parseEffectName(args.effect)
          : undefined;
      if (!effect)
        throw new ToolArgumentError(
          `effect must be one of ${EFFECT_NAMES.join(", ")}`,
        );
      const command = fxToolCommand(effect, args);
      const result = applyFxCommand(context.score, trackId, command);
      if (!result.ok || !result.next)
        throw new ToolArgumentError(result.message);
      const track = context.score.tracks.find((t) => t.id === trackId)!;
      const values = effectValues(
        result.next.tracks.find((t) => t.id === trackId),
        effect,
      );
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: effectPatch(track, effect, values ?? null),
          },
        ],
        trackId,
        summary: `${trackId} ${result.message}`,
      };
    },
  },
  {
    name: "set_rig",
    description:
      "Guitar rig on a track (stomp, amp head with gate, cab): rig loads a whole rig or reset removes it; stomp/head/cab set stage params, null removes a stage. `amp` is Strudel gain, not this.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        rig: { type: "string", enum: [...RIG_PRESET_NAMES, "reset"] },
        ...Object.fromEntries(
          RIG_STAGES.map((stage) => [
            stage,
            {
              type: ["object", "null"],
              additionalProperties: { type: ["number", "string"] },
            },
          ]),
        ),
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      let score = context.score;
      const messages: string[] = [];
      const run = (result: FxResult) => {
        if (!result.ok) throw new ToolArgumentError(result.message);
        if (result.next) score = result.next;
        messages.push(result.message);
      };
      if (args.rig !== undefined) {
        if (typeof args.rig !== "string")
          throw new ToolArgumentError("rig must be a rig name or reset");
        const command = parseRigCommand(`rig ${args.rig}`);
        if (!command || command.type === "rig-show")
          throw new ToolArgumentError(
            `rig must be one of ${RIG_PRESET_NAMES.join(", ")} or reset`,
          );
        run(applyRigCommand(score, trackId, command));
      }
      for (const stage of RIG_STAGES) {
        const params = args[stage];
        if (params === undefined) continue;
        if (params === null) {
          run(
            applyFxCommand(score, trackId, { type: "fx-off", effect: stage }),
          );
          continue;
        }
        if (typeof params !== "object" || Array.isArray(params))
          throw new ToolArgumentError(`${stage} must be an object or null`);
        const words = Object.entries(params as Record<string, unknown>)
          .map(([key, value]) => `${key} ${String(value)}`)
          .join(" ");
        const command = words.length
          ? parseFxCommand(`fx ${stage} ${words}`)
          : ({ type: "fx-on", effect: stage } as const);
        if (!command)
          throw new ToolArgumentError(
            `${stage}: unknown parameter or value in ${words}`,
          );
        run(applyFxCommand(score, trackId, command));
      }
      if (messages.length === 0)
        throw new ToolArgumentError("give rig, stomp, head or cab");
      const next = score.tracks.find((t) => t.id === trackId)!;
      const before = context.score.tracks.find((t) => t.id === trackId)!;
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: {
              fx: next.fx ?? null,
              ...(next.reverb !== before.reverb
                ? { reverb: next.reverb ?? null }
                : {}),
            },
          },
        ],
        trackId,
        summary: `${trackId} ${messages.join(" · ")}`,
      };
    },
  },
  {
    name: "set_synth",
    description:
      "Shape a synth track's voice with Strudel synth params; null unsets one. preset loads a voice, reset clears all, zzfx takes a raw ZzFX array.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        preset: { type: "string", enum: Object.keys(SYNTH_PRESETS) },
        reset: { type: "boolean" },
        zzfx: {
          type: "array",
          maxItems: 21,
          items: { type: ["number", "null"] },
        },
        params: {
          type: "object",
          additionalProperties: {
            type: ["number", "string", "boolean", "array", "null"],
          },
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const command = synthToolCommand(args);
      const result = applySynthCommand(context.score, trackId, command);
      if (!result.ok || !result.next)
        throw new ToolArgumentError(result.message);
      const next = result.next.tracks.find((t) => t.id === trackId)!;
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: { instrument: next.instrument, synth: next.synth ?? null },
          },
        ],
        trackId,
        summary: `${trackId} ${result.message}`,
      };
    },
  },
  {
    name: "set_string",
    description:
      "Make a track a plucked, struck or bowed string (physical model): preset picks the instrument, params override it (null unsets); reset drops overrides, off returns to a plain pluck.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        preset: { type: "string", enum: [...STRING_PRESET_NAMES] },
        reset: { type: "boolean" },
        off: { type: "boolean" },
        params: {
          type: "object",
          additionalProperties: { type: ["number", "string", "null"] },
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      let score = context.score;
      const messages: string[] = [];
      for (const command of stringToolCommands(args)) {
        const result = applyStringCommand(score, trackId, command);
        if (!result.ok) throw new ToolArgumentError(result.message);
        if (result.next) score = result.next;
        messages.push(result.message);
      }
      const next = score.tracks.find((t) => t.id === trackId)!;
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: { instrument: next.instrument, string: next.string ?? null },
          },
        ],
        trackId,
        summary: `${trackId} ${messages.at(-1)}`,
      };
    },
  },
  {
    name: "set_keys",
    description:
      "Shape a modeled piano, electric keys (epiano wurli clav) or organ (tonewheel combo pipe): preset, params (null unsets), drawbars/registers/stops/rotary for organs, or reset. A row the family does not read is refused.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        preset: {
          type: "string",
          enum: [...Object.keys(KEYS_PRESETS), ...Object.keys(ORGAN_ALIASES)],
        },
        reset: { type: "boolean" },
        params: {
          type: "object",
          additionalProperties: { type: ["number", "string", "null"] },
        },
        // f061-organ
        drawbars: { type: "string", pattern: "^[0-8]{9}$" },
        registers: { type: "string", pattern: "^[0-8]{5}$" },
        stops: { type: ["array", "string"], items: { type: "string" } },
        rotary: { type: "string", enum: ["slow", "fast", "stop"] },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const command = keysToolCommand(args);
      const result = applyKeysCommand(context.score, trackId, command);
      if (!result.ok || !result.next)
        throw new ToolArgumentError(result.message);
      const before = context.score.tracks.find((t) => t.id === trackId)!;
      const next = result.next.tracks.find((t) => t.id === trackId)!;
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: {
              instrument: next.instrument,
              keys: next.keys ?? null,
              ...(next.filter !== before.filter
                ? { filter: next.filter ?? null }
                : {}),
              ...(next.fx !== before.fx ? { fx: next.fx ?? null } : {}),
              ...(next.reverb !== before.reverb
                ? { reverb: next.reverb ?? null }
                : {}),
            },
          },
        ],
        trackId,
        summary: `${trackId} ${result.message}`,
      };
    },
  },
  {
    name: "set_modal",
    description:
      "Mallets and bells on the modal engine: preset switches the voice and keeps overrides; mallet, params (null returns one to the preset), pair (gamelan ombak partner), reset.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        preset: {
          type: "string",
          enum: [...MODAL_PRESET_NAMES, ...Object.keys(MODAL_ALIASES)],
        },
        mallet: { type: "string", enum: [...MODAL_MALLET_NAMES] },
        pair: { type: ["string", "null"] },
        reset: { type: "boolean" },
        params: {
          type: "object",
          additionalProperties: { type: ["number", "string", "null"] },
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const commands: ModalCommand[] = [];
      if (args.reset === true) commands.push({ type: "modal-reset" });
      if (args.preset !== undefined) {
        const preset =
          typeof args.preset === "string"
            ? modalPresetFor(args.preset)
            : undefined;
        if (!preset)
          throw new ToolArgumentError(
            `preset must be one of ${MODAL_PRESET_NAMES.join(", ")}`,
          );
        commands.push({ type: "modal-preset", preset });
      }
      const values: Record<string, number | string | null> = {};
      if (args.mallet !== undefined) {
        if (typeof args.mallet !== "string")
          throw new ToolArgumentError("mallet must be a string");
        values.mallet = args.mallet;
      }
      if (args.pair !== undefined) {
        if (args.pair !== null && typeof args.pair !== "string")
          throw new ToolArgumentError("pair must be a track id or null");
        values.pair = args.pair;
      }
      if (args.params !== undefined) {
        if (
          typeof args.params !== "object" ||
          args.params === null ||
          Array.isArray(args.params)
        )
          throw new ToolArgumentError("params must be an object");
        for (const [key, value] of Object.entries(args.params)) {
          const name = modalParamName(key);
          if (!name)
            throw new ToolArgumentError(
              `modal has no parameter ${key} (${Object.keys(MODAL_PARAMS).join(" ")})`,
            );
          if (
            value !== null &&
            typeof value !== "number" &&
            typeof value !== "string"
          )
            throw new ToolArgumentError(`${key} must be a number or string`);
          values[name] = value;
        }
      }
      if (Object.keys(values).length > 0)
        commands.push({ type: "modal-set", values });
      if (commands.length === 0) {
        // An empty call turns the track modal and keeps a modal track's preset.
        const current = context.score.tracks.find((t) => t.id === trackId);
        commands.push({
          type: "modal-preset",
          preset:
            current?.instrument === "modal" && current.modal?.preset
              ? current.modal.preset
              : "marimba",
        });
      }
      let score = context.score;
      const messages: string[] = [];
      for (const command of commands) {
        const result = applyModalCommand(score, trackId, command);
        if (!result.ok || !result.next)
          throw new ToolArgumentError(result.message);
        score = result.next;
        messages.push(result.message);
      }
      const next = score.tracks.find((t) => t.id === trackId)!;
      // A pair also sets the partner (pengumbang) to ombak 0.
      const partners = score.tracks.filter(
        (t) =>
          t.id !== trackId &&
          t.modal !== context.score.tracks.find((o) => o.id === t.id)?.modal,
      );
      return {
        kind: "score",
        operations: [
          ...partners.map((t) => ({
            type: "updateTrack" as const,
            trackId: t.id,
            patch: { modal: t.modal ?? null },
          })),
          {
            type: "updateTrack",
            trackId,
            patch: { instrument: next.instrument, modal: next.modal ?? null },
          },
        ],
        trackId,
        summary: `${trackId} ${messages.at(-1)}`,
      };
    },
  },
  {
    name: "set_wind",
    description:
      "Winds and brass on the wind engine: preset switches the voice and keeps overrides; params (null returns one to the preset), players 2..8 for a section, reset, off.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        preset: {
          type: "string",
          enum: [...WIND_PRESET_NAMES, ...Object.keys(WIND_ALIASES)],
        },
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
      const commands: WindCommand[] = [];
      if (args.off === true) commands.push({ type: "wind-off" });
      if (args.reset === true) commands.push({ type: "wind-reset" });
      if (args.preset !== undefined) {
        const preset =
          typeof args.preset === "string"
            ? windPresetFor(args.preset)
            : undefined;
        if (!preset)
          throw new ToolArgumentError(
            `preset must be one of ${WIND_PRESET_NAMES.join(", ")}`,
          );
        commands.push({ type: "wind-preset", preset });
      }
      const values: Record<string, number | string | boolean | null> = {};
      if (args.params !== undefined) {
        if (
          typeof args.params !== "object" ||
          args.params === null ||
          Array.isArray(args.params)
        )
          throw new ToolArgumentError("params must be an object");
        for (const [key, value] of Object.entries(args.params)) {
          const name = windParamName(key);
          if (!name)
            throw new ToolArgumentError(
              `wind has no parameter ${key} (${Object.keys(WIND_PARAMS).join(" ")})`,
            );
          if (
            value !== null &&
            typeof value !== "number" &&
            typeof value !== "string" &&
            typeof value !== "boolean"
          )
            throw new ToolArgumentError(
              `${key} must be a number, string or boolean`,
            );
          values[name] = value;
        }
      }
      if (Object.keys(values).length > 0)
        commands.push({ type: "wind-set", values });
      if (commands.length === 0) {
        // An empty call turns the track into the wind engine.
        const current = context.score.tracks.find((t) => t.id === trackId);
        commands.push({
          type: "wind-preset",
          preset:
            current?.instrument === "wind" && current.wind?.preset
              ? current.wind.preset
              : "flute",
        });
      }
      let score = context.score;
      const messages: string[] = [];
      for (const command of commands) {
        const result = applyWindCommand(score, trackId, command);
        if (!result.ok) throw new ToolArgumentError(result.message);
        if (result.next) score = result.next;
        messages.push(result.message);
      }
      const next = score.tracks.find((t) => t.id === trackId)!;
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: { instrument: next.instrument, wind: next.wind ?? null },
          },
        ],
        trackId,
        summary: `${trackId} ${messages.at(-1)}`,
      };
    },
  },
  {
    name: "set_sample",
    description:
      "Set a sampler voice's Strudel sample controls (begin end gain speed loop clip fit shift fades vel rr …); null unsets one.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        voice: { type: "string" },
        params: {
          type: "object",
          additionalProperties: {
            anyOf: [
              { type: ["number", "string", "boolean", "null"] },
              {
                type: "array",
                items: { type: "integer", minimum: 0, maximum: 127 },
                minItems: 2,
                maxItems: 2,
              },
            ],
          },
        },
      },
      required: ["voice", "params"],
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const params = args.params;
      if (
        typeof args.voice !== "string" ||
        typeof params !== "object" ||
        params === null ||
        Array.isArray(params)
      )
        throw new ToolArgumentError("set_sample needs voice and params");
      const result = setSampleControls(
        context.score,
        trackId,
        args.voice,
        params as Record<string, SampleControlValue>,
      );
      if (!result.ok) throw new ToolArgumentError(result.message);
      const next = result.next.tracks.find((t) => t.id === trackId)!;
      return {
        kind: "score",
        operations: [
          { type: "updateTrack", trackId, patch: { sampler: next.sampler } },
        ],
        trackId,
        summary: `${trackId} ${result.message}`,
      };
    },
  },
  {
    name: "fit_sample",
    description:
      "Fit a sampler voice to the song's tempo map: bpm (its own tempo) or len (beats); fitmode repitch (default) | beats (drums, speech) | tones (pads, vocals). Song tempo is set_tempo.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        voice: { type: "string" },
        bpm: { type: ["number", "null"], minimum: 20, maximum: 400 },
        fitmode: {
          anyOf: [
            { type: "string", enum: ["repitch", "beats", "tones"] },
            { type: "null" },
          ],
        },
        len: { type: ["number", "null"], exclusiveMinimum: 0, maximum: 1024 },
      },
      required: ["voice"],
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      if (typeof args.voice !== "string")
        throw new ToolArgumentError("fit_sample needs voice");
      const values: Record<string, SampleControlValue> = {};
      for (const key of ["bpm", "len", "fitmode"] as const)
        if (args[key] !== undefined)
          values[key] = args[key] as SampleControlValue;
      if (Object.keys(values).length === 0)
        throw new ToolArgumentError("fit_sample needs bpm, len or fitmode");
      const result = setSampleControls(
        context.score,
        trackId,
        args.voice,
        values,
      );
      if (!result.ok) throw new ToolArgumentError(result.message);
      const next = result.next.tracks.find((t) => t.id === trackId)!;
      return {
        kind: "score",
        operations: [
          { type: "updateTrack", trackId, patch: { sampler: next.sampler } },
        ],
        trackId,
        summary: `${trackId} ${result.message.replace(/^sample/, "fit")}`,
      };
    },
  },
  {
    name: "set_effects",
    hidden: true,
    description: `Shorthand for set_fx (use set_fx): low-pass filter, delay (beats) and reverb (mix 0.15..0.35 is a room); null removes one.`,
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        filter: {
          anyOf: [
            {
              type: "object",
              properties: {
                cutoff: {
                  type: "number",
                  minimum: SCORE_LIMITS.minFilterCutoff,
                  maximum: SCORE_LIMITS.maxFilterCutoff,
                },
                resonance: {
                  type: "number",
                  minimum: 0,
                  maximum: SCORE_LIMITS.maxFilterResonance,
                },
              },
              required: ["cutoff"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
        delay: {
          anyOf: [
            {
              type: "object",
              properties: {
                beats: {
                  type: "number",
                  minimum: SCORE_LIMITS.minDelayBeats,
                  maximum: SCORE_LIMITS.maxDelayBeats,
                },
                feedback: {
                  type: "number",
                  minimum: 0,
                  maximum: SCORE_LIMITS.maxDelayFeedback,
                },
                mix: {
                  type: "number",
                  minimum: 0,
                  maximum: SCORE_LIMITS.maxDelayMix,
                },
              },
              required: ["beats"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
        reverb: {
          anyOf: [
            {
              type: "object",
              properties: {
                mix: {
                  type: "number",
                  minimum: 0,
                  maximum: SCORE_LIMITS.maxReverbMix,
                },
                size: {
                  type: "number",
                  minimum: SCORE_LIMITS.minReverbSize,
                  maximum: SCORE_LIMITS.maxReverbSize,
                },
              },
              required: ["mix"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const patch: {
        filter?: { cutoff: number; resonance: number } | null;
        delay?: { beats: number; feedback: number; mix: number } | null;
        reverb?: { mix: number; size: number } | null;
      } = {};
      const parts: string[] = [];
      if (args.filter === null) {
        patch.filter = null;
        parts.push("filter off");
      } else if (args.filter !== undefined) {
        const filter = record(args.filter, "filter");
        patch.filter = {
          cutoff: number(filter, "cutoff", {
            min: SCORE_LIMITS.minFilterCutoff,
            max: SCORE_LIMITS.maxFilterCutoff,
          }),
          resonance:
            optionalNumber(filter, "resonance", {
              min: 0,
              max: SCORE_LIMITS.maxFilterResonance,
            }) ?? 0,
        };
        parts.push(`filter ${Math.round(patch.filter.cutoff)} Hz`);
      }
      if (args.delay === null) {
        patch.delay = null;
        parts.push("delay off");
      } else if (args.delay !== undefined) {
        const delay = record(args.delay, "delay");
        patch.delay = {
          beats: number(delay, "beats", {
            min: SCORE_LIMITS.minDelayBeats,
            max: SCORE_LIMITS.maxDelayBeats,
          }),
          feedback:
            optionalNumber(delay, "feedback", {
              min: 0,
              max: SCORE_LIMITS.maxDelayFeedback,
            }) ?? 0.35,
          mix:
            optionalNumber(delay, "mix", {
              min: 0,
              max: SCORE_LIMITS.maxDelayMix,
            }) ?? 0.3,
        };
        parts.push(`delay ${patch.delay.beats} beats`);
      }
      if (args.reverb === null) {
        patch.reverb = null;
        parts.push("reverb off");
      } else if (args.reverb !== undefined) {
        const reverb = record(args.reverb, "reverb");
        patch.reverb = {
          mix: number(reverb, "mix", {
            min: 0,
            max: SCORE_LIMITS.maxReverbMix,
          }),
          size:
            optionalNumber(reverb, "size", {
              min: SCORE_LIMITS.minReverbSize,
              max: SCORE_LIMITS.maxReverbSize,
            }) ?? 0.5,
        };
        parts.push(`reverb ${patch.reverb.mix}`);
      }
      if (parts.length === 0)
        throw new ToolArgumentError(
          "set_effects needs filter, delay, or reverb",
        );
      return {
        kind: "score",
        operations: [{ type: "updateTrack", trackId, patch }],
        trackId,
        summary: `${trackId} ${parts.join(", ")}`,
      };
    },
  },
  {
    name: "add_drums",
    hidden: true,
    description: `Use set_rhythm. Add one-off drum hits to a kit track (create one with create_track instrument "kit"); prefer set_rhythm for repeating beats. Voices: ${DRUM_VOICES.map((info) => info.voice).join(", ")}. Give explicit hits, and/or patterns that repeat a voice every N beats across the loop.`,
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        hits: {
          type: "array",
          maxItems: MAX_NOTES_PER_CALL,
          items: {
            type: "object",
            properties: {
              voice: {
                type: "string",
                enum: DRUM_VOICES.map((info) => info.voice),
              },
              beat: beatSchema("Hit position in beats"),
              velocity: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["voice", "beat"],
            additionalProperties: false,
          },
        },
        patterns: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              voice: {
                type: "string",
                enum: DRUM_VOICES.map((info) => info.voice),
              },
              every: {
                type: "number",
                minimum: 0.125,
                description: "Step in beats",
              },
              from: beatSchema("First hit in beats (default 0)"),
              velocity: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["voice", "every"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const track = context.score.tracks.find((t) => t.id === trackId)!;
      if (!isDrumInstrument(track.instrument))
        throw new ToolArgumentError(
          `track ${trackId} is ${track.instrument}, not a kit; set_instrument kit or create a kit track`,
        );
      const tpb = context.score.ticksPerBeat;
      const loopBeats = loopTicksOf(context.score) / tpb;
      const voiceOf = (value: unknown, label: string) => {
        const voice =
          typeof value === "string" ? parseDrumVoice(value) : undefined;
        if (!voice) throw new ToolArgumentError(`${label}: unknown drum`);
        return voice;
      };
      const hits: { voice: DrumVoice; beat: number; velocity: number }[] = [];
      for (const [index, value] of (args.hits === undefined
        ? []
        : list(args, "hits", 0, MAX_NOTES_PER_CALL)
      ).entries()) {
        const hit = record(value, `hits[${index}]`);
        hits.push({
          voice: voiceOf(hit.voice, `hits[${index}].voice`),
          beat: number(hit, "beat", { min: 0 }),
          velocity: optionalNumber(hit, "velocity", { min: 0, max: 1 }) ?? 0.9,
        });
      }
      for (const [index, value] of (args.patterns === undefined
        ? []
        : list(args, "patterns", 0, 8)
      ).entries()) {
        const pattern = record(value, `patterns[${index}]`);
        const voice = voiceOf(pattern.voice, `patterns[${index}].voice`);
        const every = number(pattern, "every", { min: 0.125 });
        const from = optionalNumber(pattern, "from", { min: 0 }) ?? 0;
        const velocity =
          optionalNumber(pattern, "velocity", { min: 0, max: 1 }) ?? 0.85;
        for (let beat = from; beat < loopBeats - 1e-9; beat += every) {
          hits.push({ voice, beat, velocity });
          if (hits.length > MAX_NOTES_PER_CALL)
            throw new ToolArgumentError(
              `add_drums is limited to ${MAX_NOTES_PER_CALL} hits per call`,
            );
        }
      }
      if (hits.length === 0)
        throw new ToolArgumentError("add_drums needs hits or patterns");
      const operations = hits.map((hit, index): ScoreOperation => ({
        type: "addNote",
        note: {
          id: context.newNoteId(trackId, index),
          trackId,
          startTick: Math.round(hit.beat * tpb),
          durationTicks: Math.max(1, Math.round(tpb / 4)),
          pitch: drumVoicePitch(hit.voice),
          velocity: hit.velocity,
        },
      }));
      return {
        kind: "score",
        operations,
        trackId,
        summary: `+${operations.length} ${trackId} hit${operations.length === 1 ? "" : "s"}`,
      };
    },
  },
  {
    name: "extend_loop",
    description:
      "Resize the loop: bars sets the total, addBars appends. Notes and automation are preserved.",
    parameters: {
      type: "object",
      properties: {
        bars: { type: "integer", minimum: 1, maximum: SCORE_LIMITS.maxBars },
        addBars: {
          type: "integer",
          minimum: 1,
          maximum: SCORE_LIMITS.maxBars,
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const current = context.score.bars;
      const add = optionalNumber(args, "addBars", {
        min: 1,
        max: SCORE_LIMITS.maxBars,
        integer: true,
      });
      const total = optionalNumber(args, "bars", {
        min: 1,
        max: SCORE_LIMITS.maxBars,
        integer: true,
      });
      if ((add === undefined) === (total === undefined))
        throw new ToolArgumentError(
          "extend_loop needs exactly one of bars or addBars",
        );
      const bars = total ?? current + add!;
      if (bars > SCORE_LIMITS.maxBars)
        throw new ToolArgumentError(
          `loop cannot exceed ${SCORE_LIMITS.maxBars} bars`,
        );
      return {
        kind: "score",
        operations: [{ type: "setBars", bars }],
        summary: `loop ${current} → ${bars} bars`,
      };
    },
  },
  {
    name: "set_tempo",
    description: "Set the session tempo in BPM.",
    parameters: {
      type: "object",
      properties: {
        bpm: {
          type: "number",
          minimum: SCORE_LIMITS.minTempoBpm,
          maximum: SCORE_LIMITS.maxTempoBpm,
        },
      },
      required: ["bpm"],
      additionalProperties: false,
    },
    plan(args, context) {
      const bpm = number(args, "bpm", {
        min: SCORE_LIMITS.minTempoBpm,
        max: SCORE_LIMITS.maxTempoBpm,
      });
      return {
        kind: "score",
        operations: [{ type: "setTempo", tempoBpm: bpm }],
        summary: `tempo ${context.score.tempoBpm} → ${bpm} BPM`,
      };
    },
  },
  {
    name: "create_track",
    description:
      "Create a new track, then add notes to it with add_notes using the same id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: ID_PATTERN.source, maxLength: 64 },
        name: { type: "string", maxLength: SCORE_LIMITS.maxNameLength },
        instrument: { type: "string", enum: INSTRUMENT_ENUM },
      },
      required: ["id", "instrument"],
      additionalProperties: false,
    },
    plan(args, context) {
      if (typeof args.id !== "string" || !ID_PATTERN.test(args.id))
        throw new ToolArgumentError(
          "id must be 1-64 letters, digits, dot, dash, or underscore",
        );
      const id = args.id;
      if (context.score.tracks.some((track) => track.id === id))
        throw new ToolArgumentError(`track ${id} already exists`);
      const name =
        typeof args.name === "string" && args.name.trim().length > 0
          ? args.name.trim().slice(0, SCORE_LIMITS.maxNameLength)
          : id;
      const word =
        typeof args.instrument === "string"
          ? args.instrument.toLowerCase()
          : "";
      const preset = pianoWrite(word)?.preset ?? word;
      if (isKeysPreset(preset)) {
        const patch = keysPresetPatch({}, preset);
        return {
          kind: "score",
          operations: [
            {
              type: "addTrack",
              track: { id, name, ...patch, instrument: patch.instrument! },
            },
          ],
          trackId: id,
          summary: `+track ${id} (${patch.instrument} ${preset})`,
        };
      }
      const patch = instrumentName(args.instrument);
      const instrument =
        patch.string?.preset ?? patch.modal?.preset ?? patch.instrument;
      return {
        kind: "score",
        operations: [
          {
            type: "addTrack",
            track: {
              id,
              name,
              ...patch,
              // A guitar alias also starts with its rig.
              ...rigTrackFields(String(args.instrument)),
            },
          },
        ],
        trackId: id,
        summary: `+track ${id} (${instrument})`,
      };
    },
  },
  {
    name: "transport",
    description: "Start, stop, or toggle shared playback.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["play", "pause", "toggle"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    plan(args) {
      const action = oneOf(args.action, ["play", "pause", "toggle"], "action");
      return { kind: "transport", action, summary: action };
    },
  },
  {
    name: "explain",
    description:
      "Tell the user briefly what you changed or why, without editing the score.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", maxLength: MAX_EXPLAIN_CHARS } },
      required: ["text"],
      additionalProperties: false,
    },
    plan(args) {
      if (typeof args.text !== "string" || args.text.trim().length === 0)
        throw new ToolArgumentError("text must be a non-empty string");
      const text = args.text.trim().slice(0, MAX_EXPLAIN_CHARS);
      return { kind: "explain", text, summary: text.slice(0, 80) };
    },
  },
  {
    name: "list_files",
    description:
      "List a project directory (default: the project root): directories first, then files with size and mtime. At most 500 entries; .dawg/ is hidden.",
    parameters: {
      type: "object",
      properties: { path: pathSchema("Project-relative directory") },
      additionalProperties: false,
    },
    plan(args, context) {
      const path = optionalPath(args);
      return {
        kind: "action",
        summary: `list ${path || "."}`,
        run: async (action) => {
          const scope = workspaceScope(action, context);
          const result = await listFiles(scope, path);
          return { content: result.text, summary: result.summary };
        },
      };
    },
  },
  {
    name: "read_file",
    description: `Read a UTF-8 text file from the project by line range (offset is 1-based, limit is a line count). Output is capped at ${WORKSPACE_LIMITS.maxReadBytes / 1024} KiB; binary files report size and type.`,
    parameters: {
      type: "object",
      properties: {
        path: pathSchema("Project-relative file"),
        offset: {
          type: "integer",
          minimum: 1,
          description: "First line (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: WORKSPACE_LIMITS.maxReadLines,
          description: "Number of lines",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    plan(args, context) {
      const path = requiredPath(args);
      const offset = optionalNumber(args, "offset", { min: 1, integer: true });
      const limit = optionalNumber(args, "limit", {
        min: 1,
        max: WORKSPACE_LIMITS.maxReadLines,
        integer: true,
      });
      return {
        kind: "action",
        summary: `read ${path}`,
        run: async (action) => {
          const scope = workspaceScope(action, context);
          const result = await readFile(scope, path, {
            ...(offset !== undefined ? { offset } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          return { content: result.text, summary: result.summary };
        },
      };
    },
  },
  {
    name: "write_file",
    description: `Create or replace a file atomically with the full content (at most ${WORKSPACE_LIMITS.maxWriteBytes / 1024 / 1024} MiB). Writable: song.ts and the focused track's tracks/<slug>/ directory, where notes.md is your scratchpad. Parent directories are created.`,
    parameters: {
      type: "object",
      properties: {
        path: pathSchema("Project-relative file"),
        content: { type: "string", description: "Entire new file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    plan(args, context) {
      const path = requiredPath(args);
      if (typeof args.content !== "string")
        throw new ToolArgumentError("content must be a string");
      const content = args.content;
      return {
        kind: "action",
        summary: `write ${path}`,
        run: async (action) => {
          const scope = workspaceScope(action, context);
          const result = await writeFile(scope, path, content);
          return {
            content: await afterWrite(action, result.rel, result.text),
            summary: result.summary,
            mutated: true,
          };
        },
      };
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact occurrence of old with new in a writable file (same scope as write_file); old must match exactly once.",
    parameters: {
      type: "object",
      properties: {
        path: pathSchema("Project-relative file"),
        old: {
          type: "string",
          minLength: 1,
          description: "Exact text to replace",
        },
        new: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old", "new"],
      additionalProperties: false,
    },
    plan(args, context) {
      const path = requiredPath(args);
      if (typeof args.old !== "string" || args.old.length === 0)
        throw new ToolArgumentError("old must be a non-empty string");
      if (typeof args.new !== "string")
        throw new ToolArgumentError("new must be a string");
      const { old: oldText, new: newText } = args;
      return {
        kind: "action",
        summary: `edit ${path}`,
        run: async (action) => {
          const scope = workspaceScope(action, context);
          const result = await editFile(scope, path, oldText, newText);
          return {
            content: await afterWrite(action, result.rel, result.text),
            summary: result.summary,
            mutated: true,
          };
        },
      };
    },
  },
  {
    name: "web_search",
    description: `Search the web; returns up to ${SEARCH_LIMITS.defaultCount} results as title, url and snippet. Follow up with fetch_url to read a page.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: SEARCH_LIMITS.maxQueryChars },
        count: { type: "integer", minimum: 1, maximum: SEARCH_LIMITS.maxCount },
      },
      required: ["query"],
      additionalProperties: false,
    },
    plan(args) {
      if (typeof args.query !== "string" || args.query.trim().length === 0)
        throw new ToolArgumentError("query must be a non-empty string");
      if (args.query.length > SEARCH_LIMITS.maxQueryChars)
        throw new ToolArgumentError(
          `query must be at most ${SEARCH_LIMITS.maxQueryChars} characters`,
        );
      const query = args.query.trim();
      const count = optionalNumber(args, "count", {
        min: 1,
        max: SEARCH_LIMITS.maxCount,
        integer: true,
      });
      return {
        kind: "action",
        summary: `search ${query.slice(0, 60)}`,
        run: async (action) => {
          const web = action.web ?? {};
          const outcome = await webSearch(query, {
            ...(count !== undefined ? { count } : {}),
            braveApiKey: web.braveApiKey ?? process.env.BRAVE_SEARCH_API_KEY,
            ...(web.gatewayApiKey ? { gatewayApiKey: web.gatewayApiKey } : {}),
            ...(web.gatewayBaseUrl
              ? { gatewayBaseUrl: web.gatewayBaseUrl }
              : {}),
            searchTool: web.searchTool ?? process.env.DAWG_WEB_SEARCH,
            openRouterApiKey:
              web.openRouterApiKey ?? process.env.OPENROUTER_API_KEY,
            ...(web.openRouterBaseUrl
              ? { openRouterBaseUrl: web.openRouterBaseUrl }
              : {}),
            ...(web.fetch ? { fetch: web.fetch } : {}),
            ...(web.onSpend ? { onSpend: web.onSpend } : {}),
            ...(action.signal ? { signal: action.signal } : {}),
          });
          const via = describeSearchProvider(outcome);
          return {
            content: formatSearchResults(outcome, query),
            summary: `searched via ${via}${outcome.fallbackFrom ? " (fallback)" : ""} · ${outcome.results.length} result${outcome.results.length === 1 ? "" : "s"}`,
          };
        },
      };
    },
  },
  {
    name: "fetch_url",
    description: `Fetch a public http(s) page and return its readable text (HTML reduced to headings, text and links; at most ${FETCH_LIMITS.maxOutputChars / 1024} KiB). Private and local addresses are refused.`,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: FETCH_LIMITS.maxUrlChars },
      },
      required: ["url"],
      additionalProperties: false,
    },
    plan(args) {
      if (typeof args.url !== "string" || args.url.trim().length === 0)
        throw new ToolArgumentError("url must be a non-empty string");
      if (args.url.length > FETCH_LIMITS.maxUrlChars)
        throw new ToolArgumentError(
          `url must be at most ${FETCH_LIMITS.maxUrlChars} characters`,
        );
      const url = args.url.trim();
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch {
        // admitUrl reports the diagnostic when the action runs.
      }
      return {
        kind: "action",
        summary: `fetch ${host.slice(0, 60)}`,
        run: async (action) => {
          const page = await fetchUrl(url, {
            ...(action.web?.fetch ? { fetch: action.web.fetch } : {}),
            ...(action.web?.lookup ? { lookup: action.web.lookup } : {}),
            ...(action.signal ? { signal: action.signal } : {}),
          });
          return {
            content: formatFetchedPage(page),
            summary: `fetched ${new URL(page.url).hostname} (${page.bytes} bytes${page.truncated ? ", truncated" : ""})`,
          };
        },
      };
    },
  },
  ...RHYTHM_TOOLS,
  ...CHORD_TOOLS,
  ...EXPRESSION_TOOLS,
  ...TUNING_TOOLS,
  ...CALIBRATION_TOOLS,
  ...DRUM_TOOLS,
  ...TIME_TOOLS,
  ...SECTION_TOOLS,
  ...RANGE_TOOLS,
  ...MEDIA_TOOLS,
  ...PACK_TOOLS,
  ...MASTER_TOOLS,
  ...PATCH_TOOLS,
  ...STYLE_TOOLS,
  ...GRANULAR_TOOLS,
  ...RESAMPLE_TOOLS,
  // 0.7 Voice: one array per lane in voice-tools.ts.
  ...VOICE_TOOLS,
  // Looks tools up at call time, so it can plan any of the above.
  previewSoundTool((name) => findAgentTool(name)),
] satisfies AgentTool[]);

/** Errors an `action` plan may raise that are safe to show to the model. */
export function isActionDiagnostic(error: unknown): boolean {
  return (
    error instanceof WorkspaceError ||
    error instanceof WebError ||
    error instanceof ToolArgumentError ||
    error instanceof PackToolError ||
    error instanceof PreviewToolError ||
    error instanceof PackError
  );
}

const MAX_HOOK_CHARS = 4_000;

async function afterWrite(
  action: ActionContext,
  rel: string,
  text: string,
): Promise<string> {
  if (!action.onWorkspaceWrite) return text;
  try {
    const note = await action.onWorkspaceWrite(rel);
    return typeof note === "string" && note.trim()
      ? `${text}\n${note.trim().slice(0, MAX_HOOK_CHARS)}`
      : text;
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, MAX_HOOK_CHARS);
    return `${text}\nafter write: ${message}`;
  }
}

/** The slug of the focused track: its name, or its id for a draft track. */
export function focusedTrackSlug(
  context: Pick<ToolContext, "score" | "focusedTrackId">,
): string {
  const track = context.score.tracks.find(
    (candidate) => candidate.id === context.focusedTrackId,
  );
  return trackSlug(track?.name ?? context.focusedTrackId);
}

function workspaceScope(
  action: ActionContext,
  context: ToolContext,
): WorkspaceScope {
  if (!action.workspace)
    throw new WorkspaceError("file tools are unavailable in this session");
  return { root: action.workspace.root, trackSlug: focusedTrackSlug(context) };
}

function pathSchema(description: string) {
  return {
    type: "string",
    maxLength: WORKSPACE_LIMITS.maxPathChars,
    description,
  };
}

function requiredPath(args: Record<string, unknown>): string {
  const path = optionalPath(args);
  if (path === undefined || path.length === 0)
    throw new ToolArgumentError("path is required");
  return path;
}

function optionalPath(args: Record<string, unknown>): string | undefined {
  if (args.path === undefined) return undefined;
  if (typeof args.path !== "string")
    throw new ToolArgumentError("path must be a string");
  if (args.path.length > WORKSPACE_LIMITS.maxPathChars)
    throw new ToolArgumentError(
      `path must be at most ${WORKSPACE_LIMITS.maxPathChars} characters`,
    );
  return args.path;
}

const TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));

export function findAgentTool(
  name: string,
  tools: readonly AgentTool[] = AGENT_TOOLS,
): AgentTool | undefined {
  return tools === AGENT_TOOLS
    ? TOOLS_BY_NAME.get(name)
    : tools.find((tool) => tool.name === name);
}

export function chatTools(
  tools: readonly AgentTool[] = AGENT_TOOLS,
): ChatTool[] {
  return tools
    .filter((tool) => !tool.hidden)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: portableSchema(tool.parameters),
      },
    }));
}

function fxToolCommand(
  effect: EffectName,
  args: Record<string, unknown>,
): FxCommand {
  if (args.on === false) return { type: "fx-off", effect };
  if (args.preset !== undefined) {
    if (
      typeof args.preset !== "string" ||
      !Object.prototype.hasOwnProperty.call(
        FX_PRESETS[effect] ?? {},
        args.preset,
      )
    )
      throw new ToolArgumentError(
        `${effect} presets: ${Object.keys(FX_PRESETS[effect] ?? {}).join(", ") || "none"}`,
      );
    return { type: "fx-preset", effect, preset: args.preset };
  }
  if (args.params === undefined) {
    if (args.on === true) return { type: "fx-on", effect };
    throw new ToolArgumentError("set_fx needs on, preset, or params");
  }
  const params = record(args.params, "params");
  if (
    effect === "formant" &&
    formantGotVowel([
      ...Object.keys(params),
      ...Object.values(params),
    ] as string[])
  )
    throw new ToolArgumentError(FORMANT_VOWEL_HINT);
  const values: Record<string, number | string | boolean> = {};
  for (const [name, value] of Object.entries(params)) {
    const param = parseParamName(effect, name);
    if (!param)
      throw new ToolArgumentError(
        `${effect} has no parameter ${name}; it takes ${Object.keys(effectSpec(effect).params).join(", ")}`,
      );
    if (
      typeof value !== "number" &&
      typeof value !== "string" &&
      typeof value !== "boolean"
    )
      throw new ToolArgumentError(`${effect} ${name} must be a value`);
    values[param] = value;
  }
  return { type: "fx-set", effect, values };
}

/** f061-organ: set_keys drawbars/registers/stops/rotary as keys values. */
function organToolValues(
  args: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["drawbars", "registers", "rotary"] as const) {
    const value = args[name];
    if (value === undefined) continue;
    if (typeof value !== "string")
      throw new ToolArgumentError(`keys ${name} must be a string`);
    out[name] = value;
  }
  if (args.stops !== undefined) {
    const words = Array.isArray(args.stops)
      ? args.stops
      : typeof args.stops === "string"
        ? args.stops.split(/[\s,+]+/)
        : undefined;
    if (!words || !words.every((word) => typeof word === "string"))
      throw new ToolArgumentError("keys stops must be stop names");
    out.stops = words.join(" ");
  }
  return out;
}

function keysToolCommand(args: Record<string, unknown>): KeysCommand {
  if (args.reset === true) return { type: "keys-reset" };
  const organ = organToolValues(args);
  const organSet = Object.keys(organ).length > 0;
  if (args.preset !== undefined) {
    const preset =
      typeof args.preset === "string"
        ? (pianoWrite(args.preset)?.preset ?? args.preset)
        : undefined;
    if (preset === undefined || !isKeysPreset(preset))
      throw new ToolArgumentError(
        `keys presets: ${Object.keys(KEYS_PRESETS).join(", ")}`,
      );
    return organSet
      ? { type: "keys-preset", preset, values: organ }
      : { type: "keys-preset", preset };
  }
  if (args.params === undefined && organSet)
    return { type: "keys-set", values: organ };
  if (args.params === undefined)
    throw new ToolArgumentError("set_keys needs preset, reset, or params");
  const params = record(args.params, "params");
  const values: Record<string, number | string | null> = { ...organ };
  for (const [name, value] of Object.entries(params)) {
    const param = keysParamName(name);
    if (!param)
      throw new ToolArgumentError(
        `keys has no parameter ${name} (DAWG.md lists them under Keys)`,
      );
    if (
      value !== null &&
      typeof value !== "number" &&
      typeof value !== "string"
    )
      throw new ToolArgumentError(`keys ${param} takes a number or a word`);
    values[param] = value;
  }
  return { type: "keys-set", values };
}

/** Instrument words the agent may pick: the voice bank plus the pianos. */
function synthToolCommand(args: Record<string, unknown>): SynthCommand {
  if (args.reset === true) return { type: "synth-reset" };
  if (args.zzfx !== undefined) {
    if (
      !Array.isArray(args.zzfx) ||
      args.zzfx.length > 21 ||
      !args.zzfx.every((n) => n === null || typeof n === "number")
    )
      throw new ToolArgumentError("zzfx must be up to 21 numbers or nulls");
    return { type: "synth-zzfx", values: args.zzfx as (number | null)[] };
  }
  if (args.preset !== undefined) {
    if (typeof args.preset !== "string" || !isSynthPreset(args.preset))
      throw new ToolArgumentError(
        `synth presets: ${Object.keys(SYNTH_PRESETS).join(", ")}`,
      );
    return { type: "synth-preset", preset: args.preset };
  }
  if (args.params === undefined)
    throw new ToolArgumentError("set_synth needs preset, reset, or params");
  const params = record(args.params, "params");
  const values: Record<
    string,
    number | string | boolean | readonly number[] | null
  > = {};
  for (const [name, value] of Object.entries(params)) {
    const param = synthParamName(name);
    if (!param)
      throw new ToolArgumentError(
        `synth has no parameter ${name}; basics: ${SYNTH_SIMPLE.join(", ")} (DAWG.md lists all)`,
      );
    if (
      value !== null &&
      typeof value !== "number" &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(Array.isArray(value) && value.every((n) => typeof n === "number"))
    )
      throw new ToolArgumentError(`synth ${name} must be a value`);
    values[param] = value as number;
  }
  return { type: "synth-set", values };
}

function stringToolCommands(args: Record<string, unknown>): StringCommand[] {
  if (args.off === true) return [{ type: "string-off" }];
  const commands: StringCommand[] = [];
  if (args.preset !== undefined) {
    const preset =
      typeof args.preset === "string"
        ? stringPresetName(args.preset)
        : undefined;
    if (!preset)
      throw new ToolArgumentError(
        `string presets: ${STRING_PRESET_NAMES.join(", ")}`,
      );
    commands.push({ type: "string-preset", preset });
  }
  if (args.reset === true) commands.push({ type: "string-reset" });
  if (args.params !== undefined) {
    const values: Record<string, number | string | null> = {};
    for (const [name, value] of Object.entries(record(args.params, "params"))) {
      const param = stringParamName(name);
      if (!param)
        throw new ToolArgumentError(
          `string has no parameter ${name}; params: ${Object.keys(STRING_PARAMS).join(", ")}`,
        );
      if (
        value !== null &&
        typeof value !== "number" &&
        typeof value !== "string"
      )
        throw new ToolArgumentError(`string ${name} must be a value`);
      values[param] = value;
    }
    commands.push({ type: "string-set", values });
  }
  if (commands.length === 0)
    throw new ToolArgumentError(
      "set_string needs preset, params, reset or off",
    );
  return commands;
}

function targetTrack(args: Record<string, unknown>, context: ToolContext) {
  const trackId = args.trackId ?? context.focusedTrackId;
  if (typeof trackId !== "string" || trackId.length > SCORE_LIMITS.maxIdLength)
    throw new ToolArgumentError("trackId must be a short string");
  if (!context.score.tracks.some((track) => track.id === trackId))
    throw new ToolArgumentError(
      `unknown track ${trackId}; create it with create_track first`,
    );
  return trackId;
}

function knownNoteId(value: unknown, context: ToolContext, label: string) {
  if (typeof value !== "string" || value.length > SCORE_LIMITS.maxIdLength)
    throw new ToolArgumentError(`${label} must be a short string`);
  if (!context.score.notes.some((note) => note.id === value))
    throw new ToolArgumentError(`${label}: unknown note ${value}`);
  return value;
}

/**
 * The track patch an instrument word means: legacy words store themselves,
 * `string` and the string resolver words (nylon, koto, harp…) also write
 * the `Track.string` preset the engine needs.
 */
function instrumentName(value: unknown): {
  instrument: string;
  string?: { preset: string };
  modal?: TrackModal;
  wind?: TrackWind;
  vocoder?: TrackVocoder;
} {
  const word = typeof value === "string" ? value.trim() : undefined;
  if (word === STRING_INSTRUMENT)
    return {
      instrument: STRING_INSTRUMENT,
      string: { preset: DEFAULT_STRING_PRESET },
    };
  const patch = word === undefined ? undefined : instrumentPatch(word);
  if (
    patch === undefined ||
    (!patch.string &&
      !patch.modal &&
      !patch.wind &&
      !patch.vocoder &&
      !(AVAILABLE_INSTRUMENTS as readonly string[]).includes(patch.instrument))
  )
    throw new ToolArgumentError(
      `instrument must be one of ${INSTRUMENT_ENUM.join(", ")}`,
    );
  return patch;
}

function pitch(value: unknown, label: string): number {
  const midi =
    typeof value === "string" ? pitchToMidi(value.trim().toLowerCase()) : value;
  if (
    typeof midi !== "number" ||
    !Number.isInteger(midi) ||
    midi < 0 ||
    midi > 127
  )
    throw new ToolArgumentError(
      `${label} must be MIDI 0..127 or a note name like C4`,
    );
  return midi;
}

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  label: string,
): T {
  if (
    typeof value !== "string" ||
    !(options as readonly string[]).includes(value)
  )
    throw new ToolArgumentError(
      `${label} must be one of ${options.join(", ")}`,
    );
  return value as T;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ToolArgumentError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function list(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): unknown[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new ToolArgumentError(
      `${key} must be an array of ${min}..${max} items`,
    );
  return value;
}

type NumberBounds = {
  min?: number;
  max?: number;
  exclusive?: boolean;
  integer?: boolean;
};

function number(
  args: Record<string, unknown>,
  key: string,
  bounds: NumberBounds,
): number {
  const value = optionalNumber(args, key, bounds);
  if (value === undefined) throw new ToolArgumentError(`${key} is required`);
  return value;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  bounds: NumberBounds,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ToolArgumentError(`${key} must be a finite number`);
  if (bounds.integer && !Number.isInteger(value))
    throw new ToolArgumentError(`${key} must be an integer`);
  if (
    bounds.min !== undefined &&
    (bounds.exclusive ? value <= bounds.min : value < bounds.min)
  )
    throw new ToolArgumentError(
      `${key} must be ${bounds.exclusive ? ">" : ">="} ${bounds.min}`,
    );
  if (bounds.max !== undefined && value > bounds.max)
    throw new ToolArgumentError(`${key} must be <= ${bounds.max}`);
  if (Math.abs(value) > SCORE_LIMITS.maxTick)
    throw new ToolArgumentError(`${key} is out of range`);
  return value;
}
