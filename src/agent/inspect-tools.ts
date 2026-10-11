/**
 * `inspect` (design §6.3): one read-only tool with compact, paged views of
 * the song, so the agent can look closely without the brief growing. Every
 * result stays under INSPECT_LIMITS.maxResultBytes and ends with
 * `… (N more; cursor=K)` when it pages.
 */
import { stat } from "node:fs/promises";
import type { Patch } from "../../core/patch.ts";
import type { Note, Track, TrackScore } from "../../core/score.ts";
import { arrangedBars, formatForm } from "../../core/sections.ts";
import { barAt, barStartTick, meterSegments } from "../../core/tempo.ts";
import { describeMaster } from "../../core/master.ts";
import { decodeWav } from "../audio/samples.ts";
import { noteName } from "./brief.ts";
import type { AgentTool, ToolContext } from "./tools.ts";
import { ToolArgumentError } from "./tool-error.ts";
import {
  detectBinary,
  formatBytes,
  resolveReadPath,
  WorkspaceError,
} from "./workspace.ts";

export const INSPECT_WHATS = [
  "score",
  "track",
  "notes",
  "sample",
  "patch",
  "mix",
  "sections",
] as const;
export type InspectWhat = (typeof INSPECT_WHATS)[number];

export const INSPECT_LIMITS = Object.freeze({
  maxResultBytes: 6 * 1024,
  /** The `score` overview aims for this; tracks page past it. */
  scoreBytes: 1536,
  notesPerPage: 32,
  maxTargetChars: 512,
});

/** A track by id, or by name ignoring case. */
export function findTrack(
  score: TrackScore,
  target: string | undefined,
): Track {
  if (!target)
    throw new ToolArgumentError("target (a track id or name) is required");
  const lower = target.toLowerCase();
  const track =
    score.tracks.find((t) => t.id === target) ??
    score.tracks.find((t) => t.name.toLowerCase() === lower);
  if (!track)
    throw new ToolArgumentError(
      `no track ${JSON.stringify(target)}; tracks: ${score.tracks
        .map((t) => t.id)
        .slice(0, 24)
        .join(", ")}`,
    );
  return track;
}

/** `"A-B"` or `"A"` (1-based, inclusive) → 0-based [start, end). */
export function parseBars(
  input: string | undefined,
  score: TrackScore,
): [number, number] | undefined {
  if (input === undefined || input === "") return undefined;
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(input);
  if (!match) throw new ToolArgumentError('bars must look like "5" or "5-8"');
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to < from)
    throw new ToolArgumentError("bars count from 1 and must not run backwards");
  return [from - 1, Math.min(to, Math.max(score.bars, to))];
}

const round = (value: number, places = 3) =>
  Math.round(value * 10 ** places) / 10 ** places;

function meterText(score: TrackScore): string {
  const first = meterSegments(score)[0]!;
  return `${first.beatsPerBar}/${first.beatUnit}`;
}

/** `bar.beat` (1-based) of a tick. */
function position(score: TrackScore, tick: number): string {
  const at = barAt(score, tick);
  const beat = at.offset / score.ticksPerBeat + 1;
  return `${at.bar + 1}.${round(beat, 2)}`;
}

function notesOf(score: TrackScore, trackId: string): Note[] {
  return score.notes
    .filter((note) => note.trackId === trackId)
    .sort(
      (left, right) =>
        left.startTick - right.startTick ||
        left.pitch - right.pitch ||
        left.id.localeCompare(right.id),
    );
}

function trackLine(score: TrackScore, track: Track): string {
  const notes = notesOf(score, track.id);
  const parts = [`${track.id}`];
  if (track.name !== track.id) parts.push(JSON.stringify(track.name));
  parts.push(track.instrument);
  parts.push(`${notes.length} notes`);
  if (notes.length > 0) {
    const first = barAt(score, notes[0]!.startTick).bar + 1;
    const last =
      barAt(score, Math.max(...notes.map((n) => n.startTick))).bar + 1;
    parts.push(first === last ? `bar ${first}` : `bars ${first}-${last}`);
    const pitches = notes.map((n) => n.pitch);
    parts.push(
      `${noteName(Math.min(...pitches))}..${noteName(Math.max(...pitches))}`,
    );
  }
  parts.push(`vol ${round(track.volume, 2)}`);
  if (track.pan !== 0) parts.push(`pan ${round(track.pan, 2)}`);
  if (track.muted) parts.push("muted");
  if (track.solo) parts.push("solo");
  return parts.join(" · ");
}

/** Join lines under a byte budget, paging the tail from `cursor`. */
function pageLines(
  head: readonly string[],
  lines: readonly string[],
  cursor: number,
  budget: number,
): string {
  const out = [...head];
  let bytes = out.join("\n").length;
  let shown = 0;
  for (const line of lines.slice(cursor)) {
    if (bytes + line.length + 1 > budget - 48) break;
    out.push(line);
    bytes += line.length + 1;
    shown += 1;
  }
  const rest = lines.length - cursor - shown;
  if (rest > 0) out.push(`… (${rest} more; cursor=${cursor + shown})`);
  return out.join("\n");
}

function inspectScore(score: TrackScore, cursor: number): string {
  const head = [
    `tempo ${round(score.tempoBpm, 2)} bpm · ${meterText(score)} · ${score.bars} bars${
      score.key ? ` · key ${score.key}` : ""
    }${score.sections.length ? ` · arranged ${arrangedBars(score)} bars` : ""}`,
  ];
  if (score.sections.length > 0)
    head.push(
      `sections: ${score.sections
        .map((s) => `${s.name}@${s.startBar + 1}+${s.bars}`)
        .join(" ")
        .slice(0, 300)}`,
    );
  if (score.form.length > 0)
    head.push(`form: ${formatForm(score.form).slice(0, 200)}`);
  if (score.master)
    head.push(`master: ${describeMaster(score.master).slice(0, 160)}`);
  head.push(`${score.tracks.length} tracks:`);
  const lines = score.tracks.map((track) => trackLine(score, track));
  return pageLines(head, lines, cursor, INSPECT_LIMITS.scoreBytes);
}

/** Non-default track fields, compact JSON; automation lanes as counts. */
function inspectTrack(score: TrackScore, track: Track): string {
  const lanes: Record<string, number> = {};
  const count = (name: string, points: readonly unknown[] | undefined) => {
    if (points && points.length > 0) lanes[name] = points.length;
  };
  count("volume", track.volumeAutomation);
  count("pan", track.panAutomation);
  count("filter", track.filterAutomation);
  count("resonance", track.resonanceAutomation);
  count("delay-feedback", track.delayFeedbackAutomation);
  count("delay-mix", track.delayMixAutomation);
  count("wt", track.wtAutomation);
  for (const [lane, points] of Object.entries(track.fxAutomation ?? {}))
    count(lane, points);
  const {
    volumeAutomation: _v,
    panAutomation: _p,
    filterAutomation: _f,
    resonanceAutomation: _r,
    delayFeedbackAutomation: _df,
    delayMixAutomation: _dm,
    wtAutomation: _wt,
    fxAutomation: _fx,
    ...rest
  } = track as Track & Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === false) continue;
    if (key === "pan" && value === 0) continue;
    if (key === "sampler" && value && typeof value === "object") {
      const voices = (value as { voices?: readonly unknown[] }).voices;
      fields.sampler = Array.isArray(voices)
        ? { voices: voices.length, first: voices[0] }
        : value;
      continue;
    }
    fields[key] = value;
  }
  fields.notes = notesOf(score, track.id).length;
  if (Object.keys(lanes).length > 0) fields.automation = lanes;
  return clip(JSON.stringify(fields));
}

function inspectNotes(
  score: TrackScore,
  track: Track,
  bars: [number, number] | undefined,
  cursor: number,
): string {
  let notes = notesOf(score, track.id);
  if (bars) {
    const from = barStartTick(score, bars[0]);
    const to = barStartTick(score, bars[1]);
    notes = notes.filter((n) => n.startTick >= from && n.startTick < to);
  }
  const tpb = score.ticksPerBeat;
  const tuned = notes.some((n) => n.cents !== undefined);
  const page = notes.slice(cursor, cursor + INSPECT_LIMITS.notesPerPage);
  const lines = [
    `${track.id}: ${notes.length} notes${bars ? ` in bars ${bars[0] + 1}-${bars[1]}` : ""} · id pitch bar.beat beats vel${tuned ? " cents" : ""}`,
    ...page.map((n) =>
      [
        n.id,
        noteName(n.pitch),
        position(score, n.startTick),
        round(n.durationTicks / tpb),
        round(n.velocity, 2),
        ...(tuned ? [n.cents ?? 0] : []),
      ].join(" "),
    ),
  ];
  const next = cursor + page.length;
  if (next < notes.length)
    lines.push(`… (${notes.length - next} more; cursor=${next})`);
  return clip(lines.join("\n"));
}

function inspectMix(score: TrackScore, cursor: number): string {
  const head = score.master
    ? [`master: ${describeMaster(score.master).slice(0, 200)}`]
    : ["master: off"];
  const lines = score.tracks.map((track) => {
    const parts = [
      track.id,
      `vol ${round(track.volume, 2)}`,
      `pan ${round(track.pan, 2)}`,
    ];
    if (track.muted) parts.push("muted");
    if (track.solo) parts.push("solo");
    if (track.filter) parts.push(`filter ${JSON.stringify(track.filter)}`);
    if (track.delay) parts.push(`delay ${JSON.stringify(track.delay)}`);
    if (track.reverb) parts.push(`reverb ${JSON.stringify(track.reverb)}`);
    if (track.fx) parts.push(`fx ${Object.keys(track.fx).join(",")}`);
    return parts.join(" · ");
  });
  return pageLines(head, lines, cursor, INSPECT_LIMITS.maxResultBytes);
}

function inspectSections(score: TrackScore): string {
  if (score.sections.length === 0)
    return `no sections; the song plays ${score.bars} bars straight through`;
  const lines = score.sections.map((s) => {
    const parts = [`${s.name}: bars ${s.startBar + 1}-${s.startBar + s.bars}`];
    if (s.mute) parts.push(`mute ${JSON.stringify(s.mute)}`);
    if (s.vary) parts.push(`vary ${JSON.stringify(s.vary)}`);
    return parts.join(" · ");
  });
  if (score.form.length > 0) lines.push(`form: ${formatForm(score.form)}`);
  if (score.loopSection) lines.push(`loop: ${score.loopSection}`);
  lines.push(`arranged: ${arrangedBars(score)} bars`);
  return clip(lines.join("\n"));
}

/** A library patch by name, or the patch a track plays. */
function inspectPatch(score: TrackScore, target: string | undefined): string {
  if (!target) {
    const names = Object.keys(score.patches ?? {});
    return names.length
      ? `patches: ${names.join(", ")}`
      : "no library patches; pass a track to see its patch";
  }
  const library = score.patches ?? {};
  let patch: Patch | undefined = library[target];
  let header = `patch ${target}`;
  if (!patch) {
    const track = findTrack(score, target);
    const value = track.patch as
      | (Patch & { ref?: undefined })
      | { kind: "patch"; ref: string; macros?: Record<string, number> }
      | undefined;
    if (!value)
      throw new ToolArgumentError(
        `${track.id} plays ${track.instrument}, not a patch`,
      );
    if ("ref" in value && value.ref) {
      patch = library[value.ref];
      header = `${track.id} plays ${value.ref}${
        value.macros ? ` macros ${JSON.stringify(value.macros)}` : ""
      }`;
      if (!patch) return `${header} (missing from the library)`;
    } else {
      patch = value as Patch;
      header = `${track.id} inline patch ${patch.name}`;
    }
  }
  const lines = [
    `${header} · ${patch.role} · ${patch.nodes.length} nodes · ${patch.cables.length} cables`,
    ...patch.nodes.map((node) => {
      const params = node.params ? ` ${JSON.stringify(node.params)}` : "";
      return `${node.id} ${node.type}${node.rate ? " global" : ""}${params}`;
    }),
    `cables: ${patch.cables.map((c) => `${c.from}→${c.to}${c.amount !== undefined ? `×${c.amount}` : ""}`).join(" ")}`,
  ];
  if (patch.macros.length > 0)
    lines.push(
      `macros: ${patch.macros
        .map((m) => `${m.id}=${m.default} [${m.min},${m.max}]`)
        .join(" ")}`,
    );
  return clip(lines.join("\n"));
}

/** Format, rate, channels, length, peak and RMS of a project or read-root file. */
export async function inspectSample(
  scope: Parameters<typeof resolveReadPath>[0],
  path: string,
): Promise<string> {
  const target = await resolveReadPath(scope, path);
  const info = await stat(target.real);
  if (!info.isFile()) throw new WorkspaceError(`${target.rel} is not a file`);
  const bytes = new Uint8Array(await Bun.file(target.real).arrayBuffer());
  const head = `${target.rel} · ${formatBytes(info.size)}`;
  const riff =
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
  if (!riff)
    return detectBinary(bytes.subarray(0, 8192))
      ? `${head} · not a WAV; convert it with the media tools to inspect`
      : `${head} · text; use read_file`;
  let pcm;
  try {
    pcm = decodeWav(bytes);
  } catch (error) {
    return `${head} · WAV that does not decode: ${(error as Error).message}`;
  }
  let peak = 0;
  let sum = 0;
  for (const value of pcm.data) {
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / Math.max(1, pcm.data.length));
  const db = (value: number) =>
    value > 0 ? `${round(20 * Math.log10(value), 1)} dBFS` : "-inf dBFS";
  return `${head} · WAV ${pcm.sampleRate} Hz · ${pcm.channels} ch · ${round(
    pcm.frames / pcm.sampleRate,
    3,
  )} s · peak ${db(peak)} · rms ${db(rms)}`;
}

function clip(text: string): string {
  const max = INSPECT_LIMITS.maxResultBytes;
  if (new TextEncoder().encode(text).byteLength <= max) return text;
  return `${text.slice(0, max - 40)}… (truncated)`;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new ToolArgumentError(`${key} must be a string`);
  return value;
}

/** The synchronous views; `sample` needs the workspace and runs in the action. */
export function inspectView(
  score: TrackScore,
  what: InspectWhat,
  options: { target?: string; bars?: string; cursor?: number },
): string {
  const cursor = options.cursor ?? 0;
  switch (what) {
    case "score":
      return inspectScore(score, cursor);
    case "track":
      return inspectTrack(score, findTrack(score, options.target));
    case "notes":
      return inspectNotes(
        score,
        findTrack(score, options.target),
        parseBars(options.bars, score),
        cursor,
      );
    case "mix":
      return inspectMix(score, cursor);
    case "sections":
      return inspectSections(score);
    case "patch":
      return inspectPatch(score, options.target);
    case "sample":
      throw new ToolArgumentError("sample needs the workspace");
  }
}

export const INSPECT_TOOLS: readonly AgentTool[] = [
  {
    name: "inspect",
    description:
      'Read-only compact views: score overview, a track\'s settings, its notes (32 per page, bars "5-8"), a sample file, a patch, the mix, or sections. Pages with cursor.',
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: [...INSPECT_WHATS] },
        target: {
          type: "string",
          maxLength: INSPECT_LIMITS.maxTargetChars,
          description: "Track id or name, sample path, or library patch",
        },
        bars: { type: "string", maxLength: 16 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["what"],
      additionalProperties: false,
    },
    plan(args, context: ToolContext) {
      const what = args.what;
      if (
        typeof what !== "string" ||
        !(INSPECT_WHATS as readonly string[]).includes(what)
      )
        throw new ToolArgumentError(
          `what must be one of ${INSPECT_WHATS.join(", ")}`,
        );
      const target = optionalString(args, "target");
      const bars = optionalString(args, "bars");
      const cursor = args.cursor;
      if (
        cursor !== undefined &&
        (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0)
      )
        throw new ToolArgumentError("cursor must be a non-negative integer");
      const kind = what as InspectWhat;
      if (kind === "sample") {
        if (!target)
          throw new ToolArgumentError("target (a sample path) is required");
        return {
          kind: "action",
          summary: `inspect sample ${target}`,
          run: async (action) => {
            if (!action.workspace)
              throw new WorkspaceError(
                "file tools are unavailable in this session",
              );
            const content = await inspectSample(
              {
                root: action.workspace.root,
                trackSlug: "",
                ...(action.workspace.readRoots
                  ? { readRoots: action.workspace.readRoots }
                  : {}),
              },
              target,
            );
            return { content, summary: `inspected ${target}` };
          },
        };
      }
      // Views are computed in plan() so argument errors reject the call.
      const content = inspectView(context.score, kind, {
        ...(target !== undefined ? { target } : {}),
        ...(bars !== undefined ? { bars } : {}),
        ...(typeof cursor === "number" ? { cursor } : {}),
      });
      return {
        kind: "action",
        summary: `inspect ${kind}${target ? ` ${target}` : ""}`,
        run: async () => ({ content, summary: `inspected ${kind}` }),
      };
    },
  },
];
