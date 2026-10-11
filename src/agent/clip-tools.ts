/**
 * Clip and lyric agent tools (0.7 clips lane): `place_clip`, `edit_clip`
 * and `set_lyrics`. Positions are in beats, gain in dB; the score stores
 * ticks and linear gain. Files must already be inside the project (an
 * `import_sample` or a `split_stems` stem); nothing is fetched.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import {
  assignLyrics,
  CLIP_GAIN_MAX_DB,
  CLIP_GAIN_MIN_DB,
  clipGainDb,
  dbToClipGain,
  importGain,
  nextClipId,
  repeatClip,
  splitClip,
} from "../../core/clips.ts";
import {
  SCORE_LIMITS,
  type AudioClip,
  type ScoreOperation,
  type Track,
} from "../../core/score.ts";
import { trackSlug } from "../../core/slug.ts";
import { wavInfo } from "../commands/clips.ts";
import { ToolArgumentError } from "./tool-error.ts";
import type { ToolContext } from "./tools.ts";
import type { VoiceTool } from "./voice-tools.ts";

function trackOf(args: Record<string, unknown>, context: ToolContext): Track {
  const id = args.trackId ?? context.focusedTrackId;
  const track = context.score.tracks.find((t) => t.id === id);
  if (!track)
    throw new ToolArgumentError(
      `unknown track ${String(id)}; create it with create_track first`,
    );
  return track;
}

function beats(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new ToolArgumentError(`${label} must be beats >= 0`);
  return value;
}

function seconds(value: unknown, label: string, max: number) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  )
    throw new ToolArgumentError(`${label} must be seconds 0..${max}`);
  return value;
}

const tickOf = (context: ToolContext, beat: number) =>
  Math.round(beat * context.score.ticksPerBeat);

const setClipsOp = (
  trackId: string,
  clips: readonly AudioClip[],
): ScoreOperation =>
  ({
    type: "setClips",
    trackId,
    clips: clips.length > 0 ? clips : null,
  }) as ScoreOperation;

const placeClip: VoiceTool = {
  name: "place_clip",
  description:
    "Place a project audio file as a clip on a track at a beat (pinned by sha256, peaks at -6 dBFS) with optional offset, dur, gain, fades, rev.",
  parameters: {
    type: "object",
    properties: {
      trackId: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
      src: {
        type: "string",
        maxLength: SCORE_LIMITS.maxSamplePathLength,
        description: "Project-relative wav path",
      },
      at: { type: "number", minimum: 0, description: "Start in beats" },
      id: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
      offset: { type: "number", minimum: 0 },
      dur: { type: "number", exclusiveMinimum: 0 },
      gain: {
        type: "number",
        minimum: CLIP_GAIN_MIN_DB,
        maximum: CLIP_GAIN_MAX_DB,
      },
      fadeIn: {
        type: "number",
        minimum: 0,
        maximum: SCORE_LIMITS.maxClipFadeSeconds,
      },
      fadeOut: {
        type: "number",
        minimum: 0,
        maximum: SCORE_LIMITS.maxClipFadeSeconds,
      },
      rev: { type: "boolean" },
    },
    required: ["src"],
    additionalProperties: false,
  },
  previewable: true,
  plan(args, context) {
    const track = trackOf(args, context);
    if (typeof args.src !== "string" || args.src.length === 0)
      throw new ToolArgumentError("src must be a project-relative wav path");
    const src = args.src.replace(/^\.\//, "");
    const at = beats(args.at, "at") ?? 0;
    const max = SCORE_LIMITS.maxClipSeconds;
    const offset = seconds(args.offset, "offset", max);
    const dur = seconds(args.dur, "dur", max);
    const fadeIn = seconds(
      args.fadeIn,
      "fadeIn",
      SCORE_LIMITS.maxClipFadeSeconds,
    );
    const fadeOut = seconds(
      args.fadeOut,
      "fadeOut",
      SCORE_LIMITS.maxClipFadeSeconds,
    );
    if ((track.clips?.length ?? 0) >= SCORE_LIMITS.maxClipsPerTrack)
      throw new ToolArgumentError(
        `${track.name} already has ${SCORE_LIMITS.maxClipsPerTrack} clips`,
      );
    const wanted =
      typeof args.id === "string" && args.id
        ? args.id
        : trackSlug(basename(src, extname(src))) || "clip";
    const id = nextClipId(track, wanted);
    return {
      kind: "prepare",
      summary: `place ${id} at beat ${at} on ${track.name}`,
      async run(host) {
        const root = host.workspace?.root ?? process.cwd();
        const path = resolve(root, src);
        if (relative(root, path).startsWith(".."))
          throw new ToolArgumentError("src must stay inside the project");
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile())
          throw new ToolArgumentError(
            `${src} does not exist in the project; import_sample or split_stems first`,
          );
        if (info.size > SCORE_LIMITS.maxSampleFileBytes)
          throw new ToolArgumentError(`${src} is over the sample size cap`);
        const sha256 = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        const wav = await wavInfo(path);
        if (!wav) throw new ToolArgumentError(`${src} is not a readable wav`);
        const gain =
          typeof args.gain === "number"
            ? dbToClipGain(args.gain)
            : importGain(wav.peak);
        const clip: AudioClip = {
          id,
          src,
          sha256,
          startTick: tickOf(context, at),
          ...(offset !== undefined && offset > 0 ? { offset } : {}),
          ...(dur !== undefined ? { dur } : {}),
          ...(gain !== undefined && Math.abs(gain - 1) > 1e-6
            ? { gain: Math.round(gain * 1e4) / 1e4 }
            : {}),
          ...(fadeIn !== undefined ? { fadeInTime: fadeIn } : {}),
          ...(fadeOut !== undefined ? { fadeTime: fadeOut } : {}),
          ...(args.rev === true ? { rev: true } : {}),
        };
        return {
          kind: "score",
          operations: [setClipsOp(track.id, [...(track.clips ?? []), clip])],
          summary: `placed ${id} (${wav.seconds.toFixed(1)} s${
            clip.gain !== undefined ? `, ${clipGainDb(clip.gain)} dB` : ""
          }) at beat ${at} on ${track.name}`,
          trackId: track.id,
        };
      },
    };
  },
};

const editClip: VoiceTool = {
  name: "edit_clip",
  description:
    "Edit a clip by id: at, gain, fades, offset/dur, rev, mute, split (a beat), repeat {every, until}, remove.",
  parameters: {
    type: "object",
    properties: {
      trackId: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
      id: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
      at: { type: "number", minimum: 0 },
      gain: {
        type: "number",
        minimum: CLIP_GAIN_MIN_DB,
        maximum: CLIP_GAIN_MAX_DB,
      },
      fadeIn: {
        type: "number",
        minimum: 0,
        maximum: SCORE_LIMITS.maxClipFadeSeconds,
      },
      fadeOut: {
        type: "number",
        minimum: 0,
        maximum: SCORE_LIMITS.maxClipFadeSeconds,
      },
      offset: { type: "number", minimum: 0 },
      dur: { type: ["number", "null"], exclusiveMinimum: 0 },
      rev: { type: "boolean" },
      mute: { type: "boolean" },
      repeat: {
        type: "object",
        properties: {
          every: { type: "number", exclusiveMinimum: 0 },
          until: { type: "number", minimum: 0 },
        },
        required: ["every", "until"],
        additionalProperties: false,
      },
      split: { type: "number", minimum: 0 },
      remove: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  previewable: true,
  plan(args, context) {
    const track = trackOf(args, context);
    const clips = track.clips ?? [];
    const clip = clips.find((c) => c.id === args.id);
    if (!clip)
      throw new ToolArgumentError(
        `no clip ${String(args.id)} on ${track.name}${clips.length ? ` (${clips.map((c) => c.id).join(", ")})` : ""}`,
      );
    if (args.remove === true)
      return {
        kind: "score",
        operations: [
          setClipsOp(
            track.id,
            clips.filter((c) => c !== clip),
          ),
        ],
        summary: `removed clip ${clip.id}`,
        trackId: track.id,
      };
    const split = beats(args.split, "split");
    if (split !== undefined) {
      const others = Object.keys(args).filter(
        (key) => !["trackId", "id", "split"].includes(key),
      );
      if (others.length > 0)
        throw new ToolArgumentError(
          `split on its own; edit ${others.join(", ")} in a second call`,
        );
      return {
        kind: "prepare",
        summary: `split ${clip.id} at beat ${split}`,
        async run(host) {
          const root = host.workspace?.root ?? process.cwd();
          const fileSeconds = (await wavInfo(resolve(root, clip.src)))?.seconds;
          const cut = splitClip(
            context.score,
            track,
            clip,
            tickOf(context, split),
            fileSeconds,
          );
          if (typeof cut === "string")
            throw new ToolArgumentError(
              cut.replace("there", `at beat ${split}`),
            );
          return {
            kind: "score",
            operations: [
              setClipsOp(
                track.id,
                clips.flatMap((c) => (c === clip ? [cut.head, cut.tail] : [c])),
              ),
            ],
            summary: `split ${clip.id} at beat ${split} into ${clip.id} and ${cut.tail.id}`,
            trackId: track.id,
          };
        },
      };
    }
    const max = SCORE_LIMITS.maxClipSeconds;
    const next: Record<string, unknown> = { ...clip };
    const changes: string[] = [];
    const at = beats(args.at, "at");
    if (at !== undefined) {
      next.startTick = tickOf(context, at);
      changes.push(`at beat ${at}`);
    }
    if (args.gain !== undefined) {
      if (typeof args.gain !== "number" || !Number.isFinite(args.gain))
        throw new ToolArgumentError("gain must be dB");
      const gain = dbToClipGain(args.gain);
      if (Math.abs(gain - 1) < 1e-6) delete next.gain;
      else next.gain = Math.round(gain * 1e4) / 1e4;
      changes.push(`gain ${args.gain} dB`);
    }
    const fadeIn = seconds(
      args.fadeIn,
      "fadeIn",
      SCORE_LIMITS.maxClipFadeSeconds,
    );
    const fadeOut = seconds(
      args.fadeOut,
      "fadeOut",
      SCORE_LIMITS.maxClipFadeSeconds,
    );
    if (fadeIn !== undefined) next.fadeInTime = fadeIn;
    if (fadeOut !== undefined) next.fadeTime = fadeOut;
    if (fadeIn !== undefined || fadeOut !== undefined) changes.push("fades");
    const offset = seconds(args.offset, "offset", max);
    if (offset !== undefined) {
      if (offset > 0) next.offset = offset;
      else delete next.offset;
      changes.push(`offset ${offset} s`);
    }
    if (args.dur === null) {
      delete next.dur;
      changes.push("plays to the end");
    } else {
      const dur = seconds(args.dur, "dur", max);
      if (dur !== undefined) {
        next.dur = dur;
        changes.push(`dur ${dur} s`);
      }
    }
    for (const key of ["rev", "mute"] as const)
      if (args[key] !== undefined) {
        if (args[key] === true) next[key] = true;
        else delete next[key];
        changes.push(`${key} ${args[key] === true ? "on" : "off"}`);
      }
    const edited = next as AudioClip;
    let out = clips.map((c) => (c === clip ? edited : c));
    if (args.repeat !== undefined) {
      const repeat = args.repeat as { every?: unknown; until?: unknown };
      const every = beats(repeat.every, "repeat.every");
      const until = beats(repeat.until, "repeat.until");
      if (!every || until === undefined)
        throw new ToolArgumentError(
          "repeat needs every > 0 and until in beats",
        );
      const copies = repeatClip(
        edited,
        tickOf(context, every),
        tickOf(context, until),
        new Set(out.map((c) => c.id)),
      );
      if (out.length + copies.length > SCORE_LIMITS.maxClipsPerTrack)
        throw new ToolArgumentError(
          `more than ${SCORE_LIMITS.maxClipsPerTrack} clips`,
        );
      out = [...out, ...copies];
      changes.push(`${copies.length} repeats`);
    }
    if (changes.length === 0) throw new ToolArgumentError("nothing to change");
    return {
      kind: "score",
      operations: [setClipsOp(track.id, out)],
      summary: `clip ${clip.id}: ${changes.join(", ")}`,
      trackId: track.id,
    };
  },
};

const setLyrics: VoiceTool = {
  name: "set_lyrics",
  description:
    "Put lyrics on a track's notes in time order: spaces separate syllables, hyphens split words, _ holds (melisma), ~ skips; from starts later, clear removes.",
  parameters: {
    type: "object",
    properties: {
      trackId: { type: "string", maxLength: SCORE_LIMITS.maxIdLength },
      text: { type: "string", maxLength: SCORE_LIMITS.maxClipTextLength },
      from: { type: "number", minimum: 0 },
      clear: { type: "boolean" },
    },
    additionalProperties: false,
  },
  plan(args, context) {
    const track = trackOf(args, context);
    const from = tickOf(context, beats(args.from, "from") ?? 0);
    const notes = context.score.notes
      .filter((n) => n.trackId === track.id && n.startTick >= from)
      .sort((a, b) => a.startTick - b.startTick || b.pitch - a.pitch);
    const tops = notes.filter(
      (note, index) =>
        index === 0 || note.startTick !== notes[index - 1]!.startTick,
    );
    const operations: ScoreOperation[] = [];
    if (args.clear === true) {
      for (const note of notes)
        if (note.lyric !== undefined)
          operations.push({
            type: "updateNote",
            noteId: note.id,
            patch: { lyric: null },
          } as ScoreOperation);
      return {
        kind: "score",
        operations,
        summary: `cleared lyrics on ${track.name}`,
        trackId: track.id,
      };
    }
    if (typeof args.text !== "string" || !args.text.trim())
      throw new ToolArgumentError("text is required (or clear: true)");
    if (tops.length === 0)
      throw new ToolArgumentError(
        `${track.name} has no notes to sing on; add notes first`,
      );
    const { lyrics, dropped, split } = assignLyrics(args.text, tops);
    for (const note of tops) {
      const lyric = lyrics.get(note.id);
      if (lyric !== note.lyric)
        operations.push({
          type: "updateNote",
          noteId: note.id,
          patch: { lyric: lyric ?? null },
        } as ScoreOperation);
    }
    return {
      kind: "score",
      operations,
      summary: `lyrics on ${track.name}: ${tops.map((n) => lyrics.get(n.id) ?? "~").join(" ")}${
        split.length ? ` (split ${split.join(", ")})` : ""
      }${dropped.length ? `; ${dropped.length} syllables left over: ${dropped.join(" ")}` : ""}`,
      trackId: track.id,
    };
  },
};

/** The clips lane's tools, spread into CLIPS_TOOLS. */
export const CLIP_TOOL_LIST: readonly VoiceTool[] = [
  placeClip,
  editClip,
  setLyrics,
];
