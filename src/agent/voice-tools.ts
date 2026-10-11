/**
 * 0.7 Voice agent tools, one array per lane. The contract spreads
 * `VOICE_TOOLS` once into `AGENT_TOOLS` and `VOICE_PREVIEWABLE_TOOLS` once
 * into `preview_sound`'s list; each lane fills only its own array and flags
 * tools that change how a track sounds with `previewable: true`.
 */
import { FX_PRESETS } from "../../core/fx.ts";
import {
  applyFxCommand,
  effectPatch,
  effectValues,
  FORMANT_VOWEL_HINT,
  type FxCommand,
} from "../commands/fx.ts";
import {
  isSingPreset,
  normalizeVowel,
  SING_INSTRUMENT,
  SING_PARAMS,
  SING_PRESET_NAMES,
  singParamName,
} from "../../core/sing.ts";
import { SCORE_LIMITS } from "../../core/score.ts";
import {
  applySingCommand,
  assignVowels,
  type SingCommand,
  type SingValue,
} from "../commands/sing.ts";
import { ToolArgumentError } from "./tool-error.ts";
// Types only: tools.ts spreads VOICE_TOOLS, so a value import would cycle.
import type { AgentTool, ToolContext } from "./tools.ts";
import { CLIP_TOOL_LIST } from "./clip-tools.ts";
import { PITCH_VOICE_NAMES, type PitchVoice } from "../audio/dsp/pitch.ts";
import {
  analyzeTrackPitch,
  guideNotesScore,
  hzName,
  PitchTargetError,
  pitchReportLines,
} from "../commands/vocal-pitch.ts";

const trackIdSchema = {
  type: "string",
  description: "Target track id. Defaults to the focused track.",
  maxLength: SCORE_LIMITS.maxIdLength,
};

/** The tool's track: `trackId` or the focused one (as tools.ts). */
function targetTrack(
  args: Record<string, unknown>,
  context: ToolContext,
): string {
  const trackId = args.trackId ?? context.focusedTrackId;
  if (typeof trackId !== "string" || trackId.length > SCORE_LIMITS.maxIdLength)
    throw new ToolArgumentError("trackId must be a short string");
  if (!context.score.tracks.some((track) => track.id === trackId))
    throw new ToolArgumentError(
      `unknown track ${trackId}; create it with create_track first`,
    );
  return trackId;
}
import {
  VOCODER_CARRIERS,
  VOCODER_FOLLOWS,
  VOCODER_PARAMS,
  VOCODER_PRESET_NAMES,
  isVocoderPreset,
  vocoderParamName,
  type VocoderCarrier,
  type VocoderFollow,
  type VocoderPresetName,
} from "../../core/vocoder.ts";
import {
  applyVocoderCommand,
  vocodeTrack,
  vocoderCandidates,
  vocoderCostHint,
  vocoderEntryLines,
  type VocoderValue,
} from "../commands/vocoder.ts";
import {
  AUTOTUNE_FIELDS,
  AUTOTUNE_PARAMS,
  AUTOTUNE_PRESETS,
  AUTOTUNE_TARGETS,
  AUTOTUNE_VOICES,
  type AutotunePreset,
} from "../../core/autotune.ts";
import {
  applyAutotuneCommand,
  type AutotuneCommand,
} from "../commands/autotune.ts";

/** A refused argument; named like tools.ts's so the model sees it. */
class AutotuneToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

/** An agent tool, optionally usable as a `preview_sound` candidate. */
export type VoiceTool = AgentTool & Readonly<{ previewable?: boolean }>;

/** clips: place_clip, edit_clip, set_lyrics. */
export const CLIPS_TOOLS: readonly VoiceTool[] = CLIP_TOOL_LIST;

/** Notes listed in an analyze_pitch result, at most. */
export const ANALYZE_PITCH_MAX_NOTES = 64;

type PitchToolArgs = { trackId: string; target?: string; voice?: PitchVoice };

function pitchToolArgs(
  args: Record<string, unknown>,
  focusedTrackId: string,
): PitchToolArgs {
  const trackId = args.trackId ?? focusedTrackId;
  if (typeof trackId !== "string" || trackId.length === 0)
    throw new ToolArgumentError("trackId must be a track id");
  const out: PitchToolArgs = { trackId };
  if (args.clip !== undefined) {
    if (typeof args.clip !== "string" || args.clip.length === 0)
      throw new ToolArgumentError(
        "clip must be a clip id or sampler voice name",
      );
    out.target = args.clip;
  }
  if (args.voice !== undefined) {
    if (!PITCH_VOICE_NAMES.includes(args.voice as PitchVoice))
      throw new ToolArgumentError(
        `voice is one of ${PITCH_VOICE_NAMES.join(", ")}`,
      );
    out.voice = args.voice as PitchVoice;
  }
  return out;
}

const pitchToolProperties = {
  trackId: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
  clip: {
    type: "string",
    description:
      "Clip id or sampler voice on the track; default the first clip, else the first voice.",
  },
  voice: {
    type: "string",
    enum: PITCH_VOICE_NAMES,
    description:
      "Expected range: auto (70-1400 Hz, default) or bass, tenor, alto, soprano.",
  },
};

function rethrow(error: unknown): never {
  if (error instanceof PitchTargetError)
    throw new ToolArgumentError(error.message);
  throw error;
}

/** pitch: analyze_pitch, pitch_to_notes. */
export const PITCH_TOOLS: readonly VoiceTool[] = [
  {
    name: "analyze_pitch",
    description:
      "Read-only: track the pitch of a track's audio clip or sampler voice (default the focused track) and report the detected key, median pitch, range and the sung notes with their cents off pitch. Cached per file.",
    parameters: {
      type: "object",
      properties: pitchToolProperties,
      additionalProperties: false,
    },
    plan(args, context) {
      const parsed = pitchToolArgs(args, context.focusedTrackId);
      return {
        kind: "action",
        summary: `analyze_pitch ${parsed.trackId}`,
        run: async (action) => {
          const root = action.workspace?.root ?? process.cwd();
          const report = await analyzeTrackPitch(
            context.score,
            parsed.trackId,
            root,
            parsed,
          ).catch(rethrow);
          const lines = pitchReportLines(report).slice(0, -1);
          const shown = report.notes.slice(0, ANALYZE_PITCH_MAX_NOTES);
          if (shown.length > 0) lines.push("notes (file seconds):");
          for (const note of shown)
            lines.push(
              `  ${note.start.toFixed(2)}-${note.end.toFixed(2)} ${hzName(440 * 2 ** ((note.midi - 69) / 12))} ${note.cents >= 0 ? "+" : ""}${Math.round(note.cents)}c`,
            );
          if (report.notes.length > shown.length)
            lines.push(`  … ${report.notes.length - shown.length} more`);
          return {
            content: lines.join("\n"),
            summary: `${report.trackId} · ${report.key ?? "key unclear"} · ${hzName(report.median)}`,
          };
        },
      };
    },
  },
  {
    name: "pitch_to_notes",
    description:
      "Turn a track's sung or played audio (clip or sampler voice) into a new guide-notes track, one note per detected note, placed through the tempo map where the audio plays. The audio track is unchanged.",
    parameters: {
      type: "object",
      properties: {
        ...pitchToolProperties,
        as: {
          type: "string",
          maxLength: SCORE_LIMITS.maxIdLength,
          description: "Id for the new track; default <track>-notes.",
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const parsed = pitchToolArgs(args, context.focusedTrackId);
      if (
        args.as !== undefined &&
        (typeof args.as !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(args.as))
      )
        throw new ToolArgumentError("as must be a track id");
      const as = args.as as string | undefined;
      return {
        kind: "prepare",
        summary: `pitch_to_notes ${parsed.trackId}`,
        run: async (action) => {
          const root = action.workspace?.root ?? process.cwd();
          const report = await analyzeTrackPitch(
            context.score,
            parsed.trackId,
            root,
            parsed,
          ).catch(rethrow);
          if (report.notes.length === 0)
            throw new ToolArgumentError(
              `no notes found in ${report.trackId} · ${report.target.label}`,
            );
          let made: ReturnType<typeof guideNotesScore>;
          try {
            made = guideNotesScore(context.score, report, as ? { as } : {});
          } catch (error) {
            rethrow(error);
          }
          const track = made.next.tracks.find((t) => t.id === made.trackId)!;
          const notes = made.next.notes.filter(
            (note) => note.trackId === made.trackId,
          );
          return {
            kind: "score",
            operations: [
              { type: "addTrack", track },
              ...notes.map((note) => ({ type: "addNote" as const, note })),
            ],
            summary: `${made.count} guide notes from ${report.trackId} · ${report.target.label} on ${made.trackId}${report.key ? ` · ${report.key}` : ""}`,
            trackId: made.trackId,
          };
        },
      };
    },
  },
];
const FORMANT_PRESETS = Object.keys(FX_PRESETS.formant ?? {});

/**
 * formant: set_formant. The fx `formant` stage (core/fx.ts): shift moves the
 * spectral envelope in semitones while the pitch stays, mix blends it.
 */
export const FORMANT_TOOLS: readonly VoiceTool[] = [
  {
    name: "set_formant",
    previewable: true,
    description:
      "Shift a track's formants at constant pitch: shift -12..12 st, mix 0..1, preset deep giant bright tiny, off.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        shift: { type: "number", minimum: -12, maximum: 12 },
        mix: { type: "number", minimum: 0, maximum: 1 },
        preset: { type: "string", enum: FORMANT_PRESETS },
        off: { type: "boolean" },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      if ("vowel" in args) throw new ToolArgumentError(FORMANT_VOWEL_HINT);
      const commands: FxCommand[] = [];
      const others = (["shift", "mix", "preset"] as const).filter(
        (key) => args[key] !== undefined,
      );
      if (args.off === true && others.length > 0)
        throw new ToolArgumentError(
          `off removes the formant stage; drop ${others.join(", ")} or off`,
        );
      // A preset sets shift; an explicit shift overrides it, and the summary says so.
      const overridden =
        args.preset !== undefined && args.shift !== undefined
          ? ` (shift ${String(args.shift)} overrides preset ${String(args.preset)})`
          : "";
      if (args.off === true)
        commands.push({ type: "fx-off", effect: "formant" });
      else {
        if (args.preset !== undefined) {
          if (
            typeof args.preset !== "string" ||
            !FORMANT_PRESETS.includes(args.preset)
          )
            throw new ToolArgumentError(
              `preset must be one of ${FORMANT_PRESETS.join(", ")}`,
            );
          commands.push({
            type: "fx-preset",
            effect: "formant",
            preset: args.preset,
          });
        }
        const values: Record<string, number> = {};
        for (const key of ["shift", "mix"] as const) {
          const value = args[key];
          if (value === undefined) continue;
          if (typeof value !== "number" || !Number.isFinite(value))
            throw new ToolArgumentError(`${key} must be a number`);
          values[key] = value;
        }
        if (Object.keys(values).length > 0)
          commands.push({ type: "fx-set", effect: "formant", values });
        // An empty call turns it on (shift 0, mix 1): a neutral start.
        if (commands.length === 0)
          commands.push({ type: "fx-on", effect: "formant" });
      }
      let score = context.score;
      let message = "";
      for (const command of commands) {
        const result = applyFxCommand(score, trackId, command);
        if (!result.ok) throw new ToolArgumentError(result.message);
        if (result.next) score = result.next;
        message = result.message;
      }
      const track = context.score.tracks.find((t) => t.id === trackId)!;
      const values = effectValues(
        score.tracks.find((t) => t.id === trackId),
        "formant",
      );
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: effectPatch(track, "formant", values ?? null),
          },
        ],
        trackId,
        summary: `${trackId} ${message}${overridden}`,
      };
    },
  },
];
/** sing: set_sing, set_vowels. */
export const SING_TOOLS: readonly VoiceTool[] = [
  {
    name: "set_sing",
    previewable: true,
    description:
      "The built-in singing voice (synthetic, never cloned): preset switches the voice and keeps overrides; params (null returns one), voices 2..8, vowel, drone (throat singing), reset, off.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        preset: { type: "string", enum: [...SING_PRESET_NAMES] },
        reset: { type: "boolean" },
        off: { type: "boolean" },
        params: {
          type: "object",
          additionalProperties: {
            type: ["number", "string", "array", "null"],
          },
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const commands: SingCommand[] = [];
      if (args.off === true) commands.push({ type: "sing-off" });
      if (args.reset === true) commands.push({ type: "sing-reset" });
      let preset: (typeof SING_PRESET_NAMES)[number] | undefined;
      if (args.preset !== undefined) {
        if (typeof args.preset !== "string" || !isSingPreset(args.preset))
          throw new ToolArgumentError(
            `preset must be one of ${SING_PRESET_NAMES.join(", ")}`,
          );
        preset = args.preset;
      }
      const values: Record<string, SingValue> = {};
      if (args.params !== undefined) {
        if (
          typeof args.params !== "object" ||
          args.params === null ||
          Array.isArray(args.params)
        )
          throw new ToolArgumentError("params must be an object");
        for (const [key, value] of Object.entries(args.params)) {
          const name = singParamName(key);
          if (!name)
            throw new ToolArgumentError(
              `sing has no parameter ${key} (${Object.keys(SING_PARAMS).join(" ")})`,
            );
          if (
            value !== null &&
            typeof value !== "number" &&
            typeof value !== "string" &&
            !(
              Array.isArray(value) &&
              value.length === 2 &&
              value.every((item) => typeof item === "number")
            )
          )
            throw new ToolArgumentError(
              `${key} must be a number, a string or [lo, hi]`,
            );
          values[name] = value as SingValue;
        }
      }
      if (preset !== undefined || Object.keys(values).length > 0)
        commands.push({
          type: "sing-set",
          ...(preset !== undefined ? { preset } : {}),
          values,
        });
      if (commands.length === 0) {
        // An empty call turns the track into the sing engine.
        const current = context.score.tracks.find((t) => t.id === trackId);
        commands.push({
          type: "sing-set",
          preset:
            current?.instrument === SING_INSTRUMENT && current.sing?.preset
              ? current.sing.preset
              : "aah",
          values: {},
        });
      }
      let score = context.score;
      const messages: string[] = [];
      for (const command of commands) {
        const result = applySingCommand(score, trackId, command);
        if (!result.ok) throw new ToolArgumentError(result.message);
        if (result.next) score = result.next;
        messages.push(result.message);
      }
      const next = score.tracks.find((t) => t.id === trackId)!;
      // A throat preset on an empty track writes its demo line.
      const before = new Set(context.score.notes.map((note) => note.id));
      const added = score.notes.filter((note) => !before.has(note.id));
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: { instrument: next.instrument, sing: next.sing ?? null },
          },
          ...added.map((note) => ({ type: "addNote" as const, note })),
        ],
        trackId,
        summary: `${trackId} ${messages.at(-1)}`,
      };
    },
  },
  {
    name: "set_vowels",
    previewable: true,
    description:
      "Set the sung vowel of a sing track's notes: a list cycled in time order (a e i o u or morphs like a>u); noteIds limits it; [] or null clears.",
    parameters: {
      type: "object",
      properties: {
        trackId: trackIdSchema,
        vowels: {
          type: ["array", "null"],
          items: { type: "string", maxLength: 16 },
          maxItems: 64,
        },
        noteIds: {
          type: "array",
          items: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
          maxItems: 128,
        },
      },
      required: ["vowels"],
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = targetTrack(args, context);
      const raw = args.vowels;
      if (raw !== null && !Array.isArray(raw))
        throw new ToolArgumentError("vowels must be a list or null");
      const vowels: string[] = [];
      for (const item of raw ?? []) {
        if (typeof item !== "string")
          throw new ToolArgumentError("each vowel must be a string");
        try {
          vowels.push(normalizeVowel(item));
        } catch (error) {
          throw new ToolArgumentError(
            error instanceof Error ? error.message : `bad vowel ${item}`,
          );
        }
      }
      let noteIds: string[] | undefined;
      if (args.noteIds !== undefined) {
        if (!Array.isArray(args.noteIds))
          throw new ToolArgumentError("noteIds must be a list");
        noteIds = args.noteIds.map((id) => {
          const note =
            typeof id === "string"
              ? context.score.notes.find((n) => n.id === id)
              : undefined;
          if (!note || note.trackId !== trackId)
            throw new ToolArgumentError(
              `unknown note ${String(id)} on ${trackId}`,
            );
          return id as string;
        });
      }
      const notes = context.score.notes
        .filter((note) =>
          noteIds ? noteIds.includes(note.id) : note.trackId === trackId,
        )
        .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
      if (notes.length === 0)
        throw new ToolArgumentError(`${trackId} has no notes`);
      if (vowels.length === 0)
        return {
          kind: "score",
          operations: notes.map((note) => ({
            type: "updateNote" as const,
            noteId: note.id,
            patch: { vowel: null },
          })),
          trackId,
          summary: `${trackId} vowels cleared on ${notes.length} notes`,
        };
      const { next } = assignVowels(context.score, trackId, vowels, noteIds);
      const after = new Map(next.notes.map((note) => [note.id, note.vowel]));
      return {
        kind: "score",
        operations: notes.map((note) => ({
          type: "updateNote" as const,
          noteId: note.id,
          patch: { vowel: after.get(note.id) ?? null },
        })),
        trackId,
        summary: `${trackId} sings ${vowels.join(" ")} over ${notes.length} notes`,
      };
    },
  },
];
/** `set_vocoder.params` keys: exactly VOCODER_PARAMS. */
export const VOCODER_TOOL_PARAM_KEYS: readonly string[] = Object.freeze(
  Object.keys(VOCODER_PARAMS),
);

const vocoderTrackId = {
  type: "string",
  description: "Target track id. Defaults to the focused track.",
  maxLength: SCORE_LIMITS.maxIdLength,
};

function knownTrack(
  value: unknown,
  fallback: string,
  tracks: readonly { id: string }[],
  label: string,
): string {
  const id = value ?? fallback;
  if (typeof id !== "string" || id.length > SCORE_LIMITS.maxIdLength)
    throw new ToolArgumentError(`${label} must be a short string`);
  if (!tracks.some((track) => track.id === id))
    throw new ToolArgumentError(`unknown track ${id}`);
  return id;
}

function presetArg(value: unknown): VocoderPresetName | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isVocoderPreset(value))
    throw new ToolArgumentError(
      `preset must be one of ${VOCODER_PRESET_NAMES.join(", ")}`,
    );
  return value;
}

/** vocoder: set_vocoder, vocode. */
export const VOCODER_TOOLS: readonly VoiceTool[] = [
  {
    name: "set_vocoder",
    previewable: true,
    description:
      "Put a vocoder on a carrier track or change it: src (modulator track), preset, params (null returns one), reset, off. Vocode only the user's own or licensed audio.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        trackId: vocoderTrackId,
        src: { type: "string", maxLength: 64 },
        preset: { type: "string", enum: [...VOCODER_PRESET_NAMES] },
        reset: { type: "boolean" },
        off: { type: "boolean" },
        params: {
          type: "object",
          description: `VOCODER_PARAMS: ${Object.keys(VOCODER_PARAMS).join(" ")}; gate takes "auto"; null resets one`,
          additionalProperties: {
            type: ["number", "string", "boolean", "null"],
          },
        },
      },
    },
    plan(args, context) {
      const trackId = knownTrack(
        args.trackId,
        context.focusedTrackId,
        context.score.tracks,
        "trackId",
      );
      let score = context.score;
      const messages: string[] = [];
      const run = (command: Parameters<typeof applyVocoderCommand>[2]) => {
        const result = applyVocoderCommand(score, trackId, command);
        if (!result.ok) throw new ToolArgumentError(result.message);
        if (result.next) score = result.next;
        messages.push(result.message);
      };
      if (args.off === true) run({ type: "vocoder-off" });
      else {
        const values: Record<string, VocoderValue> = {};
        if (args.params !== undefined) {
          if (
            typeof args.params !== "object" ||
            args.params === null ||
            Array.isArray(args.params)
          )
            throw new ToolArgumentError("params must be an object");
          for (const [key, value] of Object.entries(args.params)) {
            const name = vocoderParamName(key);
            if (!name)
              throw new ToolArgumentError(
                `vocoder has no parameter ${key.slice(0, 32)} (${VOCODER_TOOL_PARAM_KEYS.join(" ")})`,
              );
            if (
              value !== null &&
              typeof value !== "number" &&
              typeof value !== "string" &&
              typeof value !== "boolean"
            )
              throw new ToolArgumentError(
                `${key} must be a number, string, boolean or null`,
              );
            values[name] = value;
          }
        }
        if (args.reset === true) run({ type: "vocoder-reset" });
        const preset = presetArg(args.preset);
        if (args.src !== undefined && typeof args.src !== "string")
          throw new ToolArgumentError("src must be a track id or name");
        const src = args.src as string | undefined;
        const current = score.tracks.find((t) => t.id === trackId)!;
        if (
          preset ||
          src !== undefined ||
          Object.keys(values).length > 0 ||
          (!current.vocoder && args.reset !== true)
        ) {
          if (!current.vocoder && src === undefined) {
            const candidates = vocoderCandidates(score, trackId);
            if (candidates.length !== 1)
              throw new ToolArgumentError(
                candidates.length === 0
                  ? vocoderEntryLines().join(" ")
                  : `src is required: one of ${candidates.map((t) => t.id).join(", ")}`,
              );
          }
          run({
            type: "vocoder-set",
            ...(preset ? { preset } : {}),
            src:
              src ??
              current.vocoder?.src ??
              vocoderCandidates(score, trackId)[0]!.id,
            values,
          });
        }
      }
      const next = score.tracks.find((t) => t.id === trackId)!;
      const cost = next.vocoder ? ` · ${vocoderCostHint(next.vocoder)}` : "";
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: { vocoder: next.vocoder ?? null },
          },
        ],
        trackId,
        summary: `${trackId} ${messages.at(-1) ?? "vocoder unchanged"}${cost}`,
      };
    },
  },
  {
    name: "vocode",
    previewable: true,
    hidden: true,
    description:
      "Use set_vocoder. One step: create a vocoder track driven by a vocal (or any) track, following the song's chords (or a drone on the key's root when there are none) unless follow is given. Mutes the source unless keepSource (the vocoder still hears a muted source). Echoes the source's license. Vocode only the user's own or licensed audio.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["src"],
      properties: {
        src: vocoderTrackId,
        preset: { type: "string", enum: [...VOCODER_PRESET_NAMES] },
        name: { type: "string", maxLength: 48 },
        carrier: { type: "string", enum: [...VOCODER_CARRIERS] },
        follow: { type: "string", enum: [...VOCODER_FOLLOWS] },
        keepSource: { type: "boolean" },
      },
    },
    plan(args, context) {
      const src = knownTrack(args.src, "", context.score.tracks, "src");
      const enumArg = <T extends string>(
        value: unknown,
        values: readonly string[],
        label: string,
      ): T | undefined => {
        if (value === undefined) return undefined;
        if (typeof value !== "string" || !values.includes(value))
          throw new ToolArgumentError(
            `${label} must be one of ${values.join(", ")}`,
          );
        return value as T;
      };
      if (args.name !== undefined && typeof args.name !== "string")
        throw new ToolArgumentError("name must be a string");
      const preset = presetArg(args.preset);
      const carrier = enumArg<VocoderCarrier>(
        args.carrier,
        VOCODER_CARRIERS,
        "carrier",
      );
      const follow = enumArg<VocoderFollow>(
        args.follow,
        VOCODER_FOLLOWS,
        "follow",
      );
      const result = vocodeTrack(context.score, src, {
        ...(preset ? { preset } : {}),
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        ...(carrier ? { carrier } : {}),
        ...(follow ? { follow } : {}),
        ...(args.keepSource === true ? { keepSource: true } : {}),
      });
      if (!result.ok || !result.next || !result.trackId)
        throw new ToolArgumentError(result.message);
      const track = result.next.tracks.find((t) => t.id === result.trackId)!;
      const muted = result.next.tracks.find((t) => t.id === src)!.muted;
      const before = context.score.tracks.find((t) => t.id === src)!.muted;
      return {
        kind: "score",
        operations: [
          { type: "addTrack", track },
          ...(muted !== before
            ? [
                {
                  type: "updateTrack" as const,
                  trackId: src,
                  patch: { muted: true },
                },
              ]
            : []),
        ],
        trackId: result.trackId,
        summary: `${result.message.split("\n").join(" ")} · ${vocoderCostHint(track.vocoder!)}`,
      };
    },
  },
];
/** autotune: autotune_vocal. */
export const AUTOTUNE_TOOLS: readonly VoiceTool[] = [
  {
    name: "autotune_vocal",
    previewable: true,
    description:
      "Pitch correction on a track's audio: preset (hard robot warble trap pop natural gentle guided locked) and params overrides (to, key, speed, …; null returns one), reset, off. Never fetch an artist's vocal to imitate.",
    parameters: {
      type: "object",
      properties: {
        trackId: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
        preset: { type: "string", enum: [...AUTOTUNE_PRESETS] },
        reset: { type: "boolean" },
        off: { type: "boolean" },
        params: {
          type: "object",
          properties: {
            to: { type: ["string", "null"], enum: [...AUTOTUNE_TARGETS, null] },
            from: { type: ["string", "null"] },
            key: { type: ["string", "null"] },
            voice: {
              type: ["string", "null"],
              enum: [...AUTOTUNE_VOICES, null],
            },
            ...Object.fromEntries(
              AUTOTUNE_PARAMS.map((param) => [
                param.name,
                {
                  type: ["number", "null"],
                  minimum: param.min,
                  maximum: param.max,
                },
              ]),
            ),
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const trackId = args.trackId ?? context.focusedTrackId;
      if (typeof trackId !== "string" || trackId.length === 0)
        throw new AutotuneToolError("trackId must be a track id");
      if (!context.score.tracks.some((track) => track.id === trackId))
        throw new AutotuneToolError(
          `unknown track ${trackId}; create it with create_track first`,
        );
      const commands: AutotuneCommand[] = [];
      if (args.off === true) commands.push({ type: "autotune-off" });
      else {
        if (args.reset === true) commands.push({ type: "autotune-reset" });
        let preset: AutotunePreset | undefined;
        if (args.preset !== undefined) {
          if (
            typeof args.preset !== "string" ||
            !(AUTOTUNE_PRESETS as readonly string[]).includes(args.preset)
          )
            throw new AutotuneToolError(
              `preset must be one of ${AUTOTUNE_PRESETS.join(", ")}`,
            );
          preset = args.preset as AutotunePreset;
        }
        const values: Record<string, number | string | null> = {};
        if (args.params !== undefined) {
          if (
            typeof args.params !== "object" ||
            args.params === null ||
            Array.isArray(args.params)
          )
            throw new AutotuneToolError("params must be an object");
          for (const [key, value] of Object.entries(args.params)) {
            if (
              !(AUTOTUNE_FIELDS as readonly string[]).includes(key) ||
              key === "preset"
            )
              throw new AutotuneToolError(
                `autotune has no field ${key} (${AUTOTUNE_FIELDS.filter((f) => f !== "preset").join(" ")})`,
              );
            if (
              value !== null &&
              typeof value !== "number" &&
              typeof value !== "string"
            )
              throw new AutotuneToolError(`${key} must be a number or string`);
            // glide reads in ms here, as /autotune and the menu show it.
            values[key] =
              key === "glide" && typeof value === "number"
                ? value / 1000
                : value;
          }
        }
        if (preset || Object.keys(values).length > 0 || commands.length === 0)
          commands.push({
            type: "autotune-set",
            ...(preset ? { preset } : {}),
            values,
          });
      }
      let score = context.score;
      const messages: string[] = [];
      for (const command of commands) {
        const result = applyAutotuneCommand(score, trackId, command);
        if (!result.ok) throw new AutotuneToolError(result.message);
        if (result.next) score = result.next;
        messages.push(result.message);
      }
      const next = score.tracks.find((track) => track.id === trackId)!;
      return {
        kind: "score",
        operations: [
          {
            type: "updateTrack",
            trackId,
            patch: { autotune: next.autotune ?? null },
          },
        ],
        trackId,
        summary: `${trackId} ${messages.at(-1)}`,
      };
    },
  },
];

/** Every voice tool, in lane order. */
export const VOICE_TOOLS: readonly VoiceTool[] = [
  ...CLIPS_TOOLS,
  ...PITCH_TOOLS,
  ...FORMANT_TOOLS,
  ...SING_TOOLS,
  ...VOCODER_TOOLS,
  ...AUTOTUNE_TOOLS,
];

/** Voice tools a `preview_sound` candidate may use. */
export const VOICE_PREVIEWABLE_TOOLS: readonly string[] = VOICE_TOOLS.filter(
  (tool) => tool.previewable === true,
).map((tool) => tool.name);
