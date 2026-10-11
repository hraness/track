/**
 * The seven media tools as `AgentTool`s. `plan()` validates arguments from
 * `unknown` and returns a `media` plan whose `run()` the agent loop executes
 * with the host's `MediaHost` (project root, focused slug, runner, fetch),
 * a cancellation signal and a progress sink. `dawg media <verb>` reuses the
 * same `run` functions through `src/media/cli.ts`.
 */
import type { AgentTool, ToolPlan } from "../agent/tools.ts";
import { analyzeAudio } from "./analyze.ts";
import { downloadAudio } from "./download.ts";
import { importSample } from "./import.ts";
import { makeWavetableFile } from "./wavetable.ts";
import {
  MAKE_MAX_FRAMES,
  MAKE_METHODS,
  MAKE_NORMALIZE,
  type MakeMethod,
  type MakeNormalize,
} from "../audio/wavetable-maker.ts";
import { transcribeLyrics } from "./lyrics.ts";
import { NOTE_KINDS, transcribeNotes, type NoteKind } from "./notes.ts";
import { MAX_NAME_LENGTH, trackSlug } from "./paths.ts";
import { splitStems } from "./stems.ts";
import { validateYoutubeUrl } from "./vendor/util.ts";

export class MediaArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaArgumentError";
  }
}

function text(args: Record<string, unknown>, key: string, max: number): string {
  const value = args[key];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  )
    throw new MediaArgumentError(
      `${key} must be a non-empty string (≤ ${max} chars)`,
    );
  return value.trim();
}

function optionalText(args: Record<string, unknown>, key: string, max: number) {
  return args[key] === undefined ? undefined : text(args, key, max);
}

function optionalFraction(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new MediaArgumentError(`${key} must be a number in 0..1`);
  return value;
}

function optionalSeconds(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 7_200
  )
    throw new MediaArgumentError(`${key} must be seconds in 0..7200`);
  return value;
}

function sampleName(args: Record<string, unknown>): string {
  const value = text(args, "name", MAX_NAME_LENGTH);
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(value))
    throw new MediaArgumentError(
      "name must be a short identifier: lowercase letter, then letters, digits or _, at most 32 characters",
    );
  return value;
}

const fileSchema = {
  type: "string",
  maxLength: 1024,
  description:
    "Project-relative path (as listed in the brief's downloads or returned by another media tool).",
};

type MediaRun = Extract<ToolPlan, { kind: "media" }>["run"];

const media = (summary: string, run: MediaRun): ToolPlan => ({
  kind: "media",
  summary,
  run,
});

export const MEDIA_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "download_audio",
    description:
      "Download a YouTube video's audio as a wav (with a .json sidecar) into the focused track's downloads/. Check the brief's downloads first: never fetch twice.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          maxLength: 2048,
          description: "A youtube.com or youtu.be URL.",
        },
        name: {
          type: "string",
          maxLength: MAX_NAME_LENGTH,
          description:
            "Optional file name (slugified); defaults to the video title.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    plan: (args) => {
      const url = validateYoutubeUrl(text(args, "url", 2048));
      const name = optionalText(args, "name", MAX_NAME_LENGTH);
      return media(
        `download ${name ? trackSlug(name) : new URL(url).hostname}`,
        (context) => downloadAudio({ url, ...(name ? { name } : {}) }, context),
      );
    },
  },
  {
    name: "split_stems",
    description:
      "Separate a downloaded wav into six stems in <file>.stems/ (StemDeck when running, else demucs; up to 20 minutes).",
    parameters: {
      type: "object",
      properties: { file: fileSchema },
      required: ["file"],
      additionalProperties: false,
    },
    plan: (args) => {
      const file = text(args, "file", 1024);
      return media(`split stems of ${file}`, (context) =>
        splitStems({ file }, context),
      );
    },
  },
  {
    name: "analyze_audio",
    description:
      "Measure an audio file: duration, sample rate, tempo (bpm with a confidence), beat grid, key and 240 waveform peaks. Written to <name>.analysis.json; later transcribe_notes calls align to this grid.",
    parameters: {
      type: "object",
      properties: { file: fileSchema },
      required: ["file"],
      additionalProperties: false,
    },
    plan: (args) => {
      const file = text(args, "file", 1024);
      return media(`analyze ${file}`, (context) =>
        analyzeAudio({ file }, context),
      );
    },
  },
  {
    name: "transcribe_notes",
    description:
      "Transcribe a stem to notes (kind=drums classifies hits; others run basic-pitch), aligned to the beat grid, up to 2048 notes; from/to (seconds) limit it.",
    parameters: {
      type: "object",
      properties: {
        file: fileSchema,
        kind: {
          type: "string",
          enum: [...NOTE_KINDS],
          description:
            "Defaults from the file name (drums.wav → drums, bass.wav → bass, else other).",
        },
        from: {
          type: "number",
          minimum: 0,
          description: "Start of the window in seconds.",
        },
        to: {
          type: "number",
          minimum: 0,
          description: "End of the window in seconds.",
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
    plan: (args) => {
      const file = text(args, "file", 1024);
      const kindValue = optionalText(args, "kind", 16);
      if (
        kindValue !== undefined &&
        !(NOTE_KINDS as readonly string[]).includes(kindValue)
      )
        throw new MediaArgumentError(
          `kind must be one of ${NOTE_KINDS.join(", ")}`,
        );
      const kind = kindValue as NoteKind | undefined;
      const from = optionalSeconds(args, "from");
      const to = optionalSeconds(args, "to");
      if (from !== undefined && to !== undefined && to <= from)
        throw new MediaArgumentError("to must be greater than from");
      return media(`transcribe ${kind ?? "notes"} from ${file}`, (context) =>
        transcribeNotes(
          {
            file,
            ...(kind ? { kind } : {}),
            ...(from !== undefined ? { from } : {}),
            ...(to !== undefined ? { to } : {}),
          },
          context,
        ),
      );
    },
  },
  {
    name: "import_sample",
    description:
      "Copy an audio file into the focused track's samples/ as 48 kHz wav and return the sampler({...}) snippet for track.ts. begin/end are fractions 0..1 of the file; root is the note the sample is pitched at (default C4).",
    parameters: {
      type: "object",
      properties: {
        file: fileSchema,
        name: {
          type: "string",
          maxLength: MAX_NAME_LENGTH,
          description: "Voice name: lowercase identifier such as kick or vox.",
        },
        begin: { type: "number", minimum: 0, maximum: 1 },
        end: { type: "number", minimum: 0, maximum: 1 },
        root: {
          type: "string",
          maxLength: 4,
          description: "Note name like C4 or A#2.",
        },
      },
      required: ["file", "name"],
      additionalProperties: false,
    },
    plan: (args) => {
      const file = text(args, "file", 1024);
      const name = sampleName(args);
      const begin = optionalFraction(args, "begin");
      const end = optionalFraction(args, "end");
      if (begin !== undefined && end !== undefined && end <= begin)
        throw new MediaArgumentError("end must be greater than begin");
      const root = optionalText(args, "root", 4);
      if (root !== undefined && !/^[A-Ga-g][#b]?-?\d$/.test(root))
        throw new MediaArgumentError("root must be a note name like C4");
      return media(`import ${file} as sample ${name}`, (context) =>
        importSample(
          {
            file,
            name,
            ...(begin !== undefined ? { begin } : {}),
            ...(end !== undefined ? { end } : {}),
            ...(root ? { root } : {}),
          },
          context,
        ),
      );
    },
  },
  {
    name: "make_wavetable",
    description:
      "Make a wavetable from a project audio file into tracks/<slug>/wavetables/<name>.wav and describe its sweep; then set_wavetable with that path.",
    parameters: {
      type: "object",
      properties: {
        file: fileSchema,
        name: {
          type: "string",
          maxLength: MAX_NAME_LENGTH,
          description: "Table name: lowercase identifier such as vox or growl.",
        },
        frames: {
          type: "integer",
          minimum: 1,
          maximum: MAKE_MAX_FRAMES,
          description: "Frame count (default 64).",
        },
        start: {
          type: "number",
          minimum: 0,
          description: "Region start, seconds.",
        },
        end: {
          type: "number",
          minimum: 0,
          description: "Region end, seconds.",
        },
        method: { type: "string", enum: [...MAKE_METHODS] },
        smooth: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Blend frames with neighbours for a smoother morph.",
        },
        normalize: { type: "string", enum: [...MAKE_NORMALIZE] },
      },
      required: ["file", "name"],
      additionalProperties: false,
    },
    plan: (args) => {
      const file = text(args, "file", 1024);
      const name = sampleName(args);
      const frames = args.frames;
      if (
        frames !== undefined &&
        (typeof frames !== "number" ||
          !Number.isInteger(frames) ||
          frames < 1 ||
          frames > MAKE_MAX_FRAMES)
      )
        throw new MediaArgumentError(
          `frames must be an integer 1..${MAKE_MAX_FRAMES}`,
        );
      const seconds = (key: "start" | "end") => {
        const value = args[key];
        if (value === undefined) return undefined;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          throw new MediaArgumentError(`${key} must be seconds ≥ 0`);
        return value;
      };
      const start = seconds("start");
      const end = seconds("end");
      if (start !== undefined && end !== undefined && end <= start)
        throw new MediaArgumentError("end must be greater than start");
      const method = optionalText(args, "method", 16);
      if (method !== undefined && !MAKE_METHODS.includes(method as MakeMethod))
        throw new MediaArgumentError(
          `method must be ${MAKE_METHODS.join(", ")}`,
        );
      const normalize = optionalText(args, "normalize", 16);
      if (
        normalize !== undefined &&
        !MAKE_NORMALIZE.includes(normalize as MakeNormalize)
      )
        throw new MediaArgumentError(
          `normalize must be ${MAKE_NORMALIZE.join(", ")}`,
        );
      const smooth = optionalFraction(args, "smooth");
      return media(`make wavetable ${name} from ${file}`, (context) =>
        makeWavetableFile(
          {
            file,
            name,
            ...(frames !== undefined ? { frames: frames as number } : {}),
            ...(start !== undefined ? { start } : {}),
            ...(end !== undefined ? { end } : {}),
            ...(method ? { method: method as MakeMethod } : {}),
            ...(smooth !== undefined ? { smooth } : {}),
            ...(normalize ? { normalize: normalize as MakeNormalize } : {}),
          },
          context,
        ),
      );
    },
  },
  {
    name: "transcribe_lyrics",
    description:
      "Transcribe sung or spoken words with whisper.cpp. Writes <name>.lyrics.json (timed segments) and .lyrics.txt; the first run downloads the ~148 MB ggml-base model into ~/.cache/dawg/whisper.",
    parameters: {
      type: "object",
      properties: {
        file: fileSchema,
        lang: {
          type: "string",
          maxLength: 4,
          description: "Language code (en default, or auto).",
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
    plan: (args) => {
      const file = text(args, "file", 1024);
      const lang = optionalText(args, "lang", 4)?.toLowerCase();
      return media(`transcribe lyrics of ${file}`, (context) =>
        transcribeLyrics({ file, ...(lang ? { lang } : {}) }, context),
      );
    },
  },
]);

/** Agent tool names that touch `downloads/`; the host refreshes its listing after them. */
export const MEDIA_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  MEDIA_TOOLS.map((tool) => tool.name),
);
