/**
 * Patches in the render (design §13 lane 3): an instrument patch track
 * plays through `runPatch`, effect patches run at the chain's patch stage
 * (after distort) or after the whole chain (`at: "post"`), and the
 * `engine.*` and `fx.*` wrapper nodes call the existing engine renderers
 * and chain stages unchanged through the caller's hooks.
 *
 * Bit-identity: a wrapped engine's output reaches `out` through unit
 * cables (x × 1 + 0 is exact), and a patch whose right channel equals its
 * left plays mono, so `patchFromTrack` renders exactly as the track did.
 */
import type { Note } from "../../../core/score.ts";
import type { PerformedNote } from "../../../core/expression.ts";
import { noteHz, type TuningTable } from "../../../core/tuning.ts";
import type { InstrumentEngine } from "../instruments.ts";
import type { SampleBank } from "../samples.ts";
import type { RenderContext } from "../wav.ts";
import {
  engineTrack,
  engineTracks,
  macroAt,
  patchLane,
  PATCH_INSTRUMENT,
  resolvePatch,
  type Patch,
  type TrackPatchValue,
} from "../../../core/patch.ts";
import type {
  AutomationPoint,
  Track,
  TrackScore,
} from "../../../core/score.ts";
import { FX_LANES } from "../../../core/fx.ts";
import { interpolateAutomation, tempoAtSample } from "../effects/common.ts";
import type { SampleWarp } from "../warp.ts";
import { compilePatch, patchDigest, type PatchProgram } from "./compile.ts";
import {
  BLOCK,
  runPatch,
  type BufferIo,
  type PatchNote,
  type PatchRender,
} from "./run.ts";

/** Automation lane prefix of each engine node (core/fx.ts FX_LANES). */
const ENGINE_LANE_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  "engine.synth": "synth",
  "engine.modal": "modal",
  "engine.string": "string",
  "engine.wind": "wind",
  "engine.sing": "sing",
  "engine.granular": "grain",
  "engine.keys": "keys",
});

/** The Track field each engine node reads its settings from. */
const ENGINE_FIELD: Readonly<Record<string, string>> = Object.freeze({
  "engine.synth": "synth",
  "engine.modal": "modal",
  "engine.string": "string",
  "engine.wind": "wind",
  "engine.sing": "sing",
  "engine.granular": "granular",
  "engine.keys": "keys",
});

const LANES: ReadonlySet<string> = new Set(FX_LANES.map(({ lane }) => lane));

/** What the patch needs from the render: timing, the library and the side. */
export type PatchContext = Readonly<{
  sampleRate: number;
  samples: number;
  samplesPerTick: number;
  tempoBpm: number;
  ticksPerBeat: number;
  beatsPerBar: number;
  warp?: SampleWarp;
  library: Readonly<Record<string, Patch>>;
  /** Score tick at buffer sample 0 (an arranged window's origin). */
  seedTick?: number;
  /** The `side` track's tap, when the patch names one. */
  side?: Float64Array;
}>;

/** The caller's renderers for wrapper nodes. */
export type PatchHooks = Readonly<{
  /** Renders `track`'s voice into `dry` (and `dryR`); returns stereo. */
  voice?: (dry: Float64Array, dryR: Float64Array, track: Track) => boolean;
  /** Runs one chain stage on `track` (its only effect) over the pair. */
  stage?: (
    stage: string,
    left: Float64Array,
    right: Float64Array | undefined,
    track: Track,
  ) => void;
}>;

/** Whether `track` plays an instrument patch. */
export function isPatchTrack(
  track: Track | undefined,
): track is Track & { patch: TrackPatchValue } {
  return track?.instrument === PATCH_INSTRUMENT && track.patch !== undefined;
}

/** The track's instrument patch (resolved through the library), if any. */
export function trackPatch(
  track: Track | undefined,
  library: Readonly<Record<string, Patch>>,
): Patch | undefined {
  return isPatchTrack(track) ? resolvePatch(track.patch, library) : undefined;
}

/**
 * Digests of every patch `track` plays (instrument, then effect patches in
 * order), for stem and live cache keys; empty without patches.
 */
export function patchDigests(
  track: Track | undefined,
  library: Readonly<Record<string, Patch>>,
): string[] {
  if (!track) return [];
  const out: string[] = [];
  const own = trackPatch(track, library);
  if (own) out.push(`patch:${patchDigest(own, library)}`);
  for (const fx of track.fxPatch ?? [])
    out.push(`fxpatch:${patchDigest(fx, library)}`);
  return out;
}

/** The compiled program of a track's instrument patch, if any. */
export function trackProgram(
  track: Track | undefined,
  library: Readonly<Record<string, Patch>>,
): PatchProgram | undefined {
  const patch = trackPatch(track, library);
  return patch ? compilePatch(patch, library) : undefined;
}

/** Seconds a patch track rings past its last note-off (its voices' release). */
export function patchTailSeconds(
  track: Track | undefined,
  library: Readonly<Record<string, Patch>>,
): number {
  const program = trackProgram(track, library);
  if (!program || program.voice.ids.length === 0) return 0;
  return program.maxRelease + 0.1;
}

/** Per-block values of the patch's top-level macros from the track's lanes. */
function macroValues(
  program: PatchProgram,
  track: Track,
  overrides: Readonly<Record<string, number>> | undefined,
  context: PatchContext,
  blocks: number,
): (number | Float64Array)[] {
  return program.macros.map((macro) => {
    const fallback = overrides?.[macro.id] ?? macro.default;
    const lane = track.fxAutomation?.[patchLane(macro.id)];
    if (!lane || lane.length === 0) return fallback;
    const out = new Float64Array(blocks);
    for (let b = 0; b < blocks; b += 1) {
      const tick = tickAt(context, b * BLOCK);
      const position = interpolateAutomation(lane, tick, Number.NaN);
      out[b] = position === position ? macroAt(macro, position) : fallback;
    }
    return out;
  });
}

function tickAt(context: PatchContext, sample: number): number {
  const origin = context.seedTick ?? 0;
  return context.warp
    ? context.warp.tick(sample)
    : origin + sample / context.samplesPerTick;
}

function tempoBlocks(
  context: PatchContext,
  blocks: number,
): number | Float64Array {
  if (!context.warp) return context.tempoBpm;
  const out = new Float64Array(blocks);
  for (let b = 0; b < blocks; b += 1)
    out[b] = tempoAtSample(context, b * BLOCK);
  return out;
}

/** Common run options for a patch over the render. */
function runOptions(
  program: PatchProgram,
  track: Track,
  overrides: Readonly<Record<string, number>> | undefined,
  context: PatchContext,
  seed: string,
) {
  const frames = context.samples;
  const blocks = Math.ceil(frames / BLOCK);
  return {
    frames,
    sampleRate: context.sampleRate,
    macros: macroValues(program, track, overrides, context, blocks),
    tempo: tempoBlocks(context, blocks),
    beat0: (context.seedTick ?? 0) / context.ticksPerBeat,
    beatsPerBar: context.beatsPerBar,
    seed,
    ...(context.side ? { side: context.side } : {}),
  };
}

/**
 * A wired control input as onset automation: an engine reads its lanes at
 * each note's onset, so the cable's value at every onset becomes a point.
 */
function onsetLane(
  signal: Float64Array,
  base: number,
  onsets: readonly Readonly<{ tick: number; sample: number }>[],
): AutomationPoint[] {
  const points: AutomationPoint[] = [];
  for (const { tick, sample } of onsets) {
    const at = Math.min(signal.length - 1, Math.max(0, sample));
    const value = base + signal[at]!;
    const last = points[points.length - 1];
    if (last && last.tick === tick) points[points.length - 1] = { tick, value };
    else points.push({ tick, value });
  }
  return points;
}

/** A wired control input as per-block automation (effect stages read it so). */
function blockLane(
  signal: Float64Array,
  base: number,
  context: PatchContext,
): AutomationPoint[] {
  const points: AutomationPoint[] = [];
  let tick = -Infinity;
  for (let i = 0; i < signal.length; i += BLOCK) {
    const at = Math.round(tickAt(context, i));
    if (at <= tick) continue;
    tick = at;
    points.push({ tick, value: base + signal[i]! });
  }
  return points;
}

function numberParam(node: BufferIo["node"], name: string): number {
  const value = node.params[name];
  if (typeof value === "number") return value;
  const port = node.spec.inputs.find((p) => p.name === name);
  return port?.spec?.default ?? 0;
}

/**
 * A control input's value per sample: its knob (when a macro drives it) or
 * its own value, plus its cables; undefined when none of those is live.
 * `own` also counts an explicit numeric value, which engines only read
 * through lanes.
 */
function controlSignal(
  io: BufferIo,
  name: string,
  own: boolean,
): Float64Array | undefined {
  const cable = io.inputs[name];
  const knob = io.bases?.[name];
  if (!cable && !knob && !(own && typeof io.node.params[name] === "number"))
    return undefined;
  const base = numberParam(io.node, name);
  const out = new Float64Array(io.frames);
  for (let i = 0; i < io.frames; i += 1)
    out[i] =
      (knob ? knob[Math.min(knob.length - 1, Math.floor(i / BLOCK))]! : base) +
      (cable ? cable[i]! : 0);
  return out;
}

/** Lanes for every live control input of a wrapper node. */
function wiredLanes(
  io: BufferIo,
  prefix: string,
  own: boolean,
  lane: (signal: Float64Array, base: number) => AutomationPoint[],
): Record<string, AutomationPoint[]> {
  const lanes: Record<string, AutomationPoint[]> = {};
  for (const port of io.node.spec.inputs) {
    if (port.kind !== "control") continue;
    const name = `${prefix}-${port.name}`;
    if (!LANES.has(name)) continue;
    const signal = controlSignal(io, port.name, own);
    if (signal) lanes[name] = lane(signal, 0);
  }
  return lanes;
}

/** The buffer handler for `engine.*` and `fx.*` nodes over `track`. */
function bufferHandler(
  track: Track,
  played: readonly Readonly<{ startTick: number }>[] | undefined,
  context: PatchContext,
  hooks: PatchHooks,
): (io: BufferIo) => void {
  return (io) => {
    const { node, outputs } = io;
    if (node.type.startsWith("engine.")) {
      if (!hooks.voice) throw new Error(`node ${node.id}: no engine renderer`);
      let voiceTrack = engineTrack(track, node) as Track;
      const prefix = ENGINE_LANE_PREFIX[node.type];
      if (prefix && played) {
        const onsets = played.map((note) => ({
          tick: note.startTick,
          sample: Math.floor(
            context.warp
              ? context.warp.sample(note.startTick)
              : (note.startTick - (context.seedTick ?? 0)) *
                  context.samplesPerTick,
          ),
        }));
        const lanes = wiredLanes(io, prefix, true, (signal, base) =>
          onsetLane(signal, base, onsets),
        );
        if (Object.keys(lanes).length > 0) {
          // An engine reads its lanes only with its settings field present
          // (a bare `sine` is the legacy voice), so a knob or value creates it.
          const field = ENGINE_FIELD[node.type];
          const record = voiceTrack as unknown as Record<string, unknown>;
          voiceTrack = {
            ...voiceTrack,
            ...(field && record[field] === undefined ? { [field]: {} } : {}),
            fxAutomation: { ...voiceTrack.fxAutomation, ...lanes },
          } as Track;
        }
      }
      const left = outputs.out!;
      const right = outputs.right ?? new Float64Array(io.frames);
      const stereo = hooks.voice(left, right, voiceTrack);
      if (!stereo) right.set(left);
      return;
    }
    if (node.type.startsWith("fx.")) {
      if (!hooks.stage) throw new Error(`node ${node.id}: no effect stage`);
      const stage = node.type.slice(3);
      const values: Record<string, unknown> = {};
      for (const port of node.spec.inputs)
        if (port.kind === "control")
          values[port.name] = numberParam(node, port.name);
      for (const [name, value] of Object.entries(node.params))
        if (typeof value !== "number") values[name] = value;
      const lanes = wiredLanes(io, stage, false, (signal, base) =>
        blockLane(signal, base, context),
      );
      const stageTrack = stageTrackOf(track, stage, values, lanes);
      const stereoStage = outputs.left !== undefined;
      const left = stereoStage ? outputs.left! : outputs.out!;
      const inLeft = stereoStage ? io.inputs.left : io.inputs.in;
      if (inLeft) left.set(inLeft);
      if (stereoStage) {
        const right = outputs.right!;
        const inRight = io.inputs.right ?? inLeft;
        if (inRight) right.set(inRight);
        hooks.stage(stage, left, right, stageTrack);
      } else hooks.stage(stage, left, undefined, stageTrack);
      return;
    }
    throw new Error(`node ${node.id}: unknown buffer node ${node.type}`);
  };
}

/**
 * The track one chain stage runs on: only that effect, with the node's
 * values and wired lanes; the track's own effects and automation stay out.
 */
function stageTrackOf(
  track: Track,
  stage: string,
  values: Record<string, unknown>,
  lanes: Record<string, AutomationPoint[]>,
): Track {
  const {
    fx: _fx,
    filter: _filter,
    delay: _delay,
    reverb: _reverb,
    filterAutomation: _fa,
    resonanceAutomation: _ra,
    delayFeedbackAutomation: _dfa,
    delayMixAutomation: _dma,
    fxAutomation: _fxa,
    fxPatch: _fxPatch,
    ...rest
  } = track;
  const base = {
    ...rest,
    ...(Object.keys(lanes).length > 0 ? { fxAutomation: lanes } : {}),
  };
  if (stage === "filter" || stage === "delay" || stage === "reverb")
    return { ...base, [stage]: values } as unknown as Track;
  return { ...base, fx: { [stage]: values } } as unknown as Track;
}

/**
 * Plays an instrument patch track's notes into `dry` (and `dryR`); returns
 * whether it wrote a distinct right channel.
 */
export function renderPatchVoice(
  dry: Float64Array,
  dryR: Float64Array,
  played: readonly Readonly<{
    id: string;
    startTick: number;
    pitch: number;
    velocity: number;
  }>[],
  spans: readonly Readonly<{ start: number; length: number; hz: number }>[],
  track: Track,
  context: PatchContext,
  hooks: PatchHooks,
): boolean {
  if (!isPatchTrack(track)) return false;
  const patch = resolvePatch(track.patch, context.library);
  if (!patch) return false;
  const program = compilePatch(patch, context.library);
  const notes: PatchNote[] = played.map((note, i) => ({
    seed: `${note.id}:${note.startTick}`,
    start: spans[i]!.start,
    end: spans[i]!.start + spans[i]!.length,
    pitch: spans[i]!.hz,
    note: note.pitch,
    velocity: note.velocity,
  }));
  const overrides = "ref" in track.patch ? track.patch.macros : undefined;
  const render = runPatch(program, {
    ...runOptions(program, track, overrides, context, track.id),
    notes,
    buffer: bufferHandler(track, played, context, hooks),
  });
  return writeOut(render, dry, dryR);
}

/** Copies a render into the pair; true when its right differs from its left. */
function writeOut(
  render: PatchRender,
  left: Float64Array,
  right: Float64Array | undefined,
): boolean {
  left.set(render.left.subarray(0, left.length));
  if (!render.right || !right) return false;
  let same = true;
  const n = Math.min(left.length, render.right.length);
  for (let i = 0; i < n; i += 1)
    if (render.right[i] !== render.left[i]) {
      same = false;
      break;
    }
  if (same) return false;
  right.set(render.right.subarray(0, right.length));
  return true;
}

/** Effect patches the stage runs: pre-chain (patch stage) or post. */
export function effectPatches(
  track: Track,
  at: "chain" | "post",
): readonly Patch[] {
  return (track.fxPatch ?? []).filter((patch) =>
    at === "post" ? patch.at === "post" : patch.at !== "post",
  );
}

/**
 * Runs the track's effect patches for one place in the chain over `left`
 * (and `right` after the whole chain).
 */
function applyEffectPatches(
  left: Float64Array,
  right: Float64Array | undefined,
  track: Track,
  at: "chain" | "post",
  context: PatchContext,
  hooks: PatchHooks,
): void {
  for (const [index, patch] of effectPatches(track, at).entries()) {
    const program = compilePatch(patch, context.library);
    const sized = { ...context, samples: left.length };
    const render = runPatch(program, {
      ...runOptions(
        program,
        track,
        undefined,
        sized,
        `${track.id}:fx${index}:${patch.name}`,
      ),
      audio: left,
      ...(right ? { right } : {}),
      buffer: bufferHandler(track, undefined, sized, hooks),
    });
    left.set(render.left);
    if (right) right.set(render.right ?? render.left);
  }
}

/** What a patch reads from the stem pass (wav.ts supplies it). */
export type PatchRenderer = Readonly<{
  /** Renders a plain (non-patch) track's voice into the pair; returns stereo. */
  voice(
    dry: Float64Array,
    dryR: Float64Array,
    played: readonly PerformedNote[],
    track: Track,
    context: RenderContext,
    bank: SampleBank,
  ): boolean;
  /** Runs one chain stage over the pair; `track` carries only that effect. */
  stage(
    stage: string,
    left: Float64Array,
    right: Float64Array | undefined,
    track: Track,
    context: RenderContext,
  ): void;
  /** Stem key digests of a plain track's voice (samples, wavetable, assets). */
  digests(track: Track, bank: SampleBank, score: TrackScore): readonly string[];
  /** Ring-out of a plain track's voice in seconds. */
  tail(track: Track, lowestPitch?: number): number;
  /** Where a note sounds, in buffer samples. */
  span(note: Note, context: RenderContext): { start: number; length: number };
}>;

function patchContextOf(
  context: RenderContext,
  side?: Float64Array,
): PatchContext {
  return {
    sampleRate: context.sampleRate,
    samples: context.samples,
    samplesPerTick: context.samplesPerTick,
    tempoBpm: context.tempoBpm,
    ticksPerBeat: context.score.ticksPerBeat,
    beatsPerBar: context.score.beatsPerBar,
    library: context.score.patches,
    ...(context.warp ? { warp: context.warp } : {}),
    ...(context.seedTick !== undefined ? { seedTick: context.seedTick } : {}),
    ...(side ? { side } : {}),
  };
}

function hooksFor(
  renderer: PatchRenderer,
  context: RenderContext,
  bank: SampleBank,
  played: readonly PerformedNote[],
): PatchHooks {
  return {
    voice: (dry, dryR, track) =>
      renderer.voice(dry, dryR, played, track, context, bank),
    stage: (stage, left, right, track) =>
      renderer.stage(stage, left, right, track, context),
  };
}

/**
 * Plays an instrument patch track into `dry` (and `dryR`); returns whether
 * it wrote a distinct right channel. `side` is the side track's audio.
 */
export function renderPatchTrack(
  dry: Float64Array,
  dryR: Float64Array,
  played: readonly PerformedNote[],
  track: Track,
  context: RenderContext & { readonly tuning?: TuningTable },
  bank: SampleBank,
  renderer: PatchRenderer,
  side?: Float64Array,
): boolean {
  const spans = played.map((note) => ({
    ...renderer.span(note, context),
    hz: noteHz(note.pitch, note.cents, context.tuning),
  }));
  return renderPatchVoice(
    dry,
    dryR,
    played,
    spans,
    track,
    patchContextOf(context, side),
    hooksFor(renderer, context, bank, played),
  );
}

/** The chain's patch stage for `track` (a mono hook), or undefined. */
export function patchStageFor(
  track: Track,
  context: RenderContext,
  bank: SampleBank,
  renderer: PatchRenderer,
  side?: Float64Array,
): ((buffer: Float64Array) => void) | undefined {
  if (effectPatches(track, "chain").length === 0) return undefined;
  const patch = patchContextOf(context, side);
  const hooks = hooksFor(renderer, context, bank, []);
  return (buffer) =>
    applyEffectPatches(buffer, undefined, track, "chain", patch, hooks);
}

/** Runs the track's `at: "post"` effect patches over the finished pair. */
export function applyPostPatches(
  left: Float64Array,
  right: Float64Array,
  track: Track,
  context: RenderContext,
  bank: SampleBank,
  renderer: PatchRenderer,
  side?: Float64Array,
): void {
  if (effectPatches(track, "post").length === 0) return;
  applyEffectPatches(
    left,
    right,
    track,
    "post",
    patchContextOf(context, side),
    hooksFor(renderer, context, bank, []),
  );
}

/** Whether any of the track's patches reads its `side` track. */
export function readsSide(track: Track | undefined): boolean {
  return (
    track !== undefined &&
    (track.patch?.side !== undefined ||
      (track.fxPatch ?? []).some((patch) => patch.side !== undefined))
  );
}

/** The `patch` instrument engine over the stem pass's `renderer`. */
export function patchEngine(renderer: PatchRenderer): InstrumentEngine {
  return {
    id: PATCH_INSTRUMENT,
    field: "patch",
    render(dry, dryR, notes, track, context, bank) {
      const right = dryR ?? new Float64Array(dry.length);
      renderPatchTrack(dry, right, notes, track, context, bank, renderer);
    },
    // The voices' release, or the longest wrapped engine's ring-out.
    tailSeconds(track, lowestPitch, score) {
      const library = score?.patches ?? {};
      return Math.max(
        patchTailSeconds(track, library),
        ...engineTracks(track, library).map((inner) =>
          renderer.tail(inner, lowestPitch),
        ),
      );
    },
    stereo: () => true,
    assetDigests(track, bank, score) {
      const library = score?.patches ?? {};
      return [
        ...patchDigests(track, library),
        ...engineTracks(track, library).flatMap((inner) =>
          renderer.digests(inner, bank, score!),
        ),
      ];
    },
  };
}
