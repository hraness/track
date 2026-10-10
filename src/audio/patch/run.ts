/**
 * The patch runner (design §8.2): interprets a `PatchProgram` in 32-sample
 * blocks over flat Float64Arrays. The global nodes ahead of the voices run
 * over the whole render first, then every note plays on its own block grid
 * from its start sample, then the global nodes after the voices run over
 * the voice sums. Engine and effect nodes (`process: "buffer"`) run once
 * over the whole render through the caller's `buffer` handler.
 *
 * Voices are allocated in note order (start, then id): before each note,
 * every playing voice renders its blocks that end by the note's start; a
 * free slot plays the note, or the oldest voice is stolen with a 2 ms fade.
 * A voice ends 50 ms below -90 dB after its gate closes, or at gate-off +
 * the longest release + 0.1 s. Per-node generators are seeded from
 * `${note.seed}:patch:${node}`, so the output never depends on wall-clock
 * time, voice order or what else is playing.
 */
import { seedHash } from "../dsp/rng.ts";
import {
  Base,
  F,
  In,
  INPUT_WIDTH,
  mapMacro,
  Op,
  type BufferNode,
  type PatchProgram,
  type Phase,
  type Section,
} from "./compile.ts";
import { adsr, ar, follow, slew } from "./nodes/envelopes.ts";
import { onepole, svf } from "./nodes/filters.ts";
import { at, BLOCK, type Frame, put } from "./nodes/frame.ts";
import {
  binary,
  Binary,
  clamp,
  constant,
  scale,
  unary,
  Unary,
} from "./nodes/math.ts";
import { macro, mix, pan, pass, vca, xfade } from "./nodes/mix.ts";
import { clock, lfo, random, sh } from "./nodes/modulators.ts";
import { noise, osc } from "./nodes/sources.ts";
import { fuseVoice } from "./fuse.ts";

export { BLOCK };

/** One note for the voices, in samples. */
export type PatchNote = Readonly<{
  /** Seed text (`${note.id}:${startTick}`); also the deterministic tie-break. */
  seed: string;
  start: number;
  /** Gate-off sample (exclusive). */
  end: number;
  /** Frequency in Hz. */
  pitch: number;
  /** MIDI number. */
  note: number;
  velocity: number;
}>;

/** What a buffer node's handler sees: whole-render inputs and outputs. */
export type BufferIo = Readonly<{
  node: BufferNode;
  /** Cable sums per input port (audio and control), undefined when unwired. */
  inputs: Readonly<Record<string, Float64Array | undefined>>;
  /** Output buffers to fill, per output port (length `frames`). */
  outputs: Readonly<Record<string, Float64Array>>;
  frames: number;
  sampleRate: number;
}>;

export type PatchRunOptions = Readonly<{
  frames: number;
  sampleRate: number;
  notes?: readonly PatchNote[];
  /** Top-level macro values per macro: a constant, or one value per 32-sample block. */
  macros?: readonly (number | Float64Array | undefined)[];
  /** Tempo in BPM (constant), or one value per block. */
  tempo?: number | Float64Array;
  /** Song position in beats at sample 0. */
  beat0?: number;
  beatsPerBar?: number;
  /** Seed text for the global section's generators. */
  seed?: string;
  /** The track's audio, for effect patches and `side`. */
  audio?: Float64Array;
  right?: Float64Array;
  side?: Float64Array;
  buffer?: (io: BufferIo) => void;
  /**
   * false runs the voice section through the reference interpreter (per
   * node `prologue` + `kernel`) instead of the fused block (fuse.ts); the
   * bytes are the same. For the differential test and the bench.
   */
  fuse?: boolean;
}>;

export type PatchRender = {
  left: Float64Array;
  /** Present when the patch wires `out.right`. */
  right?: Float64Array;
  /** Voices stolen while full. */
  stolen: number;
  /** Non-finite values scrubbed to zero. */
  scrubbed: number;
};

const FADE_SECONDS = 0.002;
const SILENCE = Math.pow(10, -90 / 20);
const SILENCE_SECONDS = 0.05;
const TAIL_SECONDS = 0.1;

type Voice = {
  m: Float64Array;
  ctl: Float64Array;
  prev: Float64Array;
  st: Float64Array;
  frame: Frame;
  index: number;
  note: PatchNote;
  order: number;
  pos: number;
  first: boolean;
  phase: number;
  random: number;
  quiet: number;
  /** Sample the steal fade starts at (Infinity when not stolen). */
  fadeAt: number;
  done: boolean;
};

function frameOf(
  section: Section,
  m: Float64Array,
  ctl: Float64Array,
  prev: Float64Array,
  st: Float64Array,
  stride: number,
  local: number,
  sampleRate: number,
  beatSlot: number,
): Frame {
  return {
    m,
    ctl,
    prev,
    st,
    stride,
    blk: 0,
    local,
    sampleRate,
    bps: 2,
    slotBase: section.slotBase,
    slots: section.slots,
    ctlBase: section.ctlBase,
    stBase: section.stBase,
    mode: section.mode,
    nIn: section.nIn,
    beatSlot,
  };
}

/** Memory offset of slot `s` in a frame (the block-local rule of `at`). */
function addr(f: Frame, s: number): number {
  return s >= 0 ? s * f.stride + f.blk : f.local - (s + 1) * BLOCK;
}

/** Runner-wide state shared by the global and voice sections. */
type Ctx = {
  program: PatchProgram;
  consts: Float64Array;
  /** External macro values for the block being rendered. */
  ext: Float64Array;
  sampleRate: number;
  scrubbed: number;
};

/** Evaluates node `n`'s inputs (controls, sums, sampled ports) for this block. */
function prologue(
  f: Frame,
  section: Section,
  ctx: Ctx,
  n: number,
  first: boolean,
): void {
  const rec = section.inputs;
  const cab = section.cables;
  const k = ctx.consts;
  const m = f.m;
  const ctl = f.ctl;
  const prev = f.prev;
  // The first block evaluates every input; later blocks only the ones that
  // can change (a constant, unwired control keeps its first value).
  const hot = section.hot;
  const start = first ? section.inStart[n]! : section.hotStart[n]!;
  const count = first ? section.inCount[n]! : section.hotCount[n]!;
  for (let j = 0; j < count; j += 1) {
    const r = (first ? start + j : hot[start + j]!) * INPUT_WIDTH;
    const kind = rec[r + F.Kind]!;
    if (kind === In.None) continue;
    const cables = rec[r + F.CableCount]!;
    const c0 = rec[r + F.CableStart]! * 2;
    const c1 = c0 + cables * 2;
    if (kind === In.Sum) {
      const o = addr(f, rec[r + F.Slot]!);
      const x0 = addr(f, cab[c0]!);
      const a0 = k[cab[c0 + 1]!]!;
      for (let i = 0; i < BLOCK; i += 1) m[o + i] = m[x0 + i]! * a0;
      for (let c = c0 + 2; c < c1; c += 2) {
        const x = addr(f, cab[c]!);
        const a = k[cab[c + 1]!]!;
        for (let i = 0; i < BLOCK; i += 1) m[o + i]! += m[x + i]! * a;
      }
      continue;
    }
    // Control: base (constant, external knob or knob node) + Σ cable × amount.
    const slot = rec[r + F.Ctl]!;
    const baseKind = rec[r + F.BaseKind]!;
    const bi = rec[r + F.BaseIndex]!;
    const mp = rec[r + F.Map]!;
    const cl = rec[r + F.Clamp]!;
    const lo = cl >= 0 ? k[cl]! : -Infinity;
    const hi = cl >= 0 ? k[cl + 1]! : Infinity;
    let base: number;
    if (baseKind === Base.Const) base = k[bi]!;
    else {
      const raw =
        baseKind === Base.External ? ctx.ext[bi]! : m[addr(f, bi) + BLOCK - 1]!;
      base =
        mp >= 0
          ? mapMacro(
              raw,
              k[mp]!,
              k[mp + 1]!,
              k[mp + 2]! === 1,
              k[mp + 3]!,
              k[mp + 4]!,
            )
          : raw;
    }
    let value: number;
    if (kind === In.Sampled && cables === 1) {
      // The common case in one pass: base + cable × amount, clamped.
      const o = addr(f, rec[r + F.Slot]!);
      const x = addr(f, cab[c0]!);
      const a = k[cab[c0 + 1]!]!;
      for (let i = 0; i < BLOCK; i += 1) {
        const v = base + m[x + i]! * a;
        m[o + i] = v < lo ? lo : v > hi ? hi : v;
      }
      value = m[o + BLOCK - 1]!;
    } else if (kind === In.Sampled) {
      const o = addr(f, rec[r + F.Slot]!);
      put(m, base, o);
      for (let c = c0; c < c1; c += 2) {
        const x = addr(f, cab[c]!);
        const a = k[cab[c + 1]!]!;
        for (let i = 0; i < BLOCK; i += 1) m[o + i]! += m[x + i]! * a;
      }
      if (cl >= 0)
        for (let i = 0; i < BLOCK; i += 1) {
          const v = m[o + i]!;
          m[o + i] = v < lo ? lo : v > hi ? hi : v;
        }
      value = m[o + BLOCK - 1]!;
    } else {
      value = base;
      for (let c = c0; c < c1; c += 2)
        value += m[addr(f, cab[c]!) + BLOCK - 1]! * k[cab[c + 1]!]!;
      if (value < lo) value = lo;
      else if (value > hi) value = hi;
    }
    if (value !== value) {
      value = 0;
      ctx.scrubbed += 1;
    }
    prev[slot] = first ? value : ctl[slot]!;
    ctl[slot] = value;
  }
}

/** Runs one block of one node (inputs already evaluated). */
function kernel(f: Frame, section: Section, n: number): void {
  switch (section.op[n]!) {
    case Op.Osc:
      return osc(f, n);
    case Op.Noise:
      return noise(f, n);
    case Op.Svf:
      return svf(f, n);
    case Op.Onepole:
      return onepole(f, n);
    case Op.Adsr:
      return adsr(f, n);
    case Op.Ar:
      return ar(f, n);
    case Op.Slew:
      return slew(f, n);
    case Op.Follow:
      return follow(f, n);
    case Op.Lfo:
      return lfo(f, n);
    case Op.Sh:
      return sh(f, n);
    case Op.Random:
      return random(f, n);
    case Op.Const:
      return constant(f, n);
    case Op.Add:
      return binary(f, n, Binary.Add);
    case Op.Mul:
      return binary(f, n, Binary.Mul);
    case Op.Min:
      return binary(f, n, Binary.Min);
    case Op.Max:
      return binary(f, n, Binary.Max);
    case Op.Gt:
      return binary(f, n, Binary.Gt);
    case Op.Lt:
      return binary(f, n, Binary.Lt);
    case Op.Abs:
      return unary(f, n, Unary.Abs);
    case Op.Not:
      return unary(f, n, Unary.Not);
    case Op.Pitch2Hz:
      return unary(f, n, Unary.Pitch2Hz);
    case Op.Db2Gain:
      return unary(f, n, Unary.Db2Gain);
    case Op.Scale:
      return scale(f, n);
    case Op.Clamp:
      return clamp(f, n);
    case Op.Clock:
      return clock(f, n);
    case Op.Vca:
      return vca(f, n);
    case Op.Mix:
      return mix(f, n);
    case Op.Xfade:
      return xfade(f, n);
    case Op.Pan:
      return pan(f, n);
    case Op.Pass:
      return pass(f, n);
    case Op.Macro:
      return macro(f, n);
    default:
      // Boundaries are filled by the runner; `out` is read after the block.
      return;
  }
}

/** Zeroes non-finite node state (a NaN in a filter memory would stick). */
function scrubState(st: Float64Array, ctx: Ctx): void {
  for (let i = 0; i < st.length; i += 1) {
    const v = st[i]!;
    if (v - v !== 0) {
      st[i] = 0;
      ctx.scrubbed += 1;
    }
  }
}

function copyDelays(f: Frame, delays: Int32Array): void {
  const m = f.m;
  for (let d = 0; d < delays.length; d += 2) {
    const x = addr(f, delays[d]!);
    const o = addr(f, delays[d + 1]!);
    for (let i = 0; i < BLOCK; i += 1) {
      const v = m[x + i]!;
      m[o + i] = v - v === 0 ? v : 0;
    }
  }
}

const valueAt = (
  source: number | Float64Array | undefined,
  block: number,
  fallback: number,
): number =>
  source === undefined
    ? fallback
    : typeof source === "number"
      ? source
      : (source[Math.min(block, source.length - 1)] ?? fallback);

/** Renders a patch program. Pure: the same program and options give the same bytes. */
export function runPatch(
  program: PatchProgram,
  options: PatchRunOptions,
): PatchRender {
  const { frames, sampleRate } = options;
  const blocks = Math.ceil(frames / BLOCK);
  const stride = (blocks + 1) * BLOCK;
  const g = program.global;
  const ctx: Ctx = {
    program,
    consts: program.consts,
    ext: new Float64Array(program.macros.length),
    sampleRate,
    scrubbed: 0,
  };
  const macroValues = options.macros ?? [];
  const setExt = (block: number) => {
    for (let i = 0; i < program.macros.length; i += 1)
      ctx.ext[i] = valueAt(macroValues[i], block, program.macros[i]!.default);
  };
  const tempo = options.tempo ?? 120;
  const beatsPerBar = options.beatsPerBar ?? 4;
  const local = g.fullSlots * stride;
  const gm = new Float64Array(local + g.localSlots * BLOCK);
  const gctl = new Float64Array(g.ctlCount);
  const gprev = new Float64Array(g.ctlCount);
  const gst = new Float64Array(g.stateCount);
  const globalSeed = options.seed ?? program.name;
  for (const [cell, node] of g.seeds)
    gst[cell] = seedHash(`${globalSeed}:patch:${node}`) | 0;
  const gf = frameOf(
    g,
    gm,
    gctl,
    gprev,
    gst,
    stride,
    local,
    sampleRate,
    program.beatSlot,
  );
  const left = new Float64Array(frames);
  const right = program.stereo ? new Float64Array(frames) : undefined;

  // Song position per block (always computed: clock and song.* read it).
  const beats = new Float64Array(blocks + 1);
  {
    let beat = options.beat0 ?? 0;
    for (let b = 0; b <= blocks; b += 1) {
      beats[b] = beat;
      beat += (valueAt(tempo, b, 120) / 60) * (BLOCK / sampleRate);
    }
  }

  const runGlobal = (
    phase: Phase & { kind: "block" },
    b: number,
    first: boolean,
  ) => {
    gf.blk = b * BLOCK;
    const bpm = valueAt(tempo, b, 120);
    gf.bps = bpm / 60;
    setExt(b);
    for (const n of phase.nodes) {
      const op = g.op[n]!;
      if (op === Op.Song) song(gf, n, beats[b]!, bpm, sampleRate, beatsPerBar);
      else if (op === Op.In) inputs(gf, n, options, b * BLOCK, frames);
      else {
        prologue(gf, g, ctx, n, first);
        if (op === Op.Out) output(gf, n, left, right, b * BLOCK, frames);
        else kernel(gf, g, n);
      }
    }
    copyDelays(gf, phase.delays);
    scrubState(gst, ctx);
  };
  const runBuffer = (phase: Phase & { kind: "buffer" }) => {
    const n = phase.node;
    const node = program.buffers.find((b) => b.id === g.ids[n])!;
    const ins: Record<string, Float64Array | undefined> = {};
    const start = g.inStart[n]!;
    node.spec.inputs.forEach((port, j) => {
      const r = (start + j) * INPUT_WIDTH;
      const count = g.inputs[r + F.CableCount]!;
      if (port.kind === "notes" || count === 0) return;
      const sum = new Float64Array(frames);
      const c0 = g.inputs[r + F.CableStart]! * 2;
      for (let c = c0; c < c0 + count * 2; c += 2) {
        const x = g.cables[c]! * stride;
        const a = program.consts[g.cables[c + 1]!]!;
        for (let i = 0; i < frames; i += 1) sum[i]! += gm[x + i]! * a;
      }
      ins[port.name] = sum;
    });
    const outs: Record<string, Float64Array> = {};
    node.spec.outputs.forEach((port, j) => {
      if (port.kind === "notes") return;
      const slot = g.slots[g.slotBase[n]! + node.spec.inputs.length + j]!;
      outs[port.name] = gm.subarray(slot * stride, slot * stride + frames);
    });
    if (!options.buffer)
      throw new Error(`node ${node.id}: no handler for ${node.type}`);
    options.buffer({ node, inputs: ins, outputs: outs, frames, sampleRate });
    for (const buf of Object.values(outs))
      for (let i = 0; i < frames; i += 1) {
        const v = buf[i]!;
        if (v - v !== 0) {
          buf[i] = 0;
          ctx.scrubbed += 1;
        }
      }
  };
  const runPhases = (phases: readonly Phase[]) => {
    for (const phase of phases) {
      if (phase.kind === "buffer") runBuffer(phase);
      else for (let b = 0; b < blocks; b += 1) runGlobal(phase, b, b === 0);
    }
  };

  runPhases(program.pre);
  const stolen =
    program.voices > 0 ? runVoices(program, options, ctx, gm, stride) : 0;
  runPhases(program.post);
  ctx.scrubbed += scrub(left) + (right ? scrub(right) : 0);
  return { left, ...(right ? { right } : {}), stolen, scrubbed: ctx.scrubbed };
}

function scrub(buffer: Float64Array): number {
  let count = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const v = buffer[i]!;
    if (v - v !== 0) {
      buffer[i] = 0;
      count += 1;
    }
  }
  return count;
}

/** song: beat, bar.phase, tempo for this block. */
function song(
  f: Frame,
  n: number,
  beat: number,
  bpm: number,
  sr: number,
  perBar: number,
): void {
  const m = f.m;
  const ob = at(f, n, 0);
  const op = at(f, n, 1);
  const ot = at(f, n, 2);
  const step = bpm / 60 / sr;
  for (let i = 0; i < BLOCK; i += 1) {
    const x = beat + step * i;
    m[ob + i] = x;
    const bar = x / perBar;
    m[op + i] = bar - Math.floor(bar);
    m[ot + i] = bpm;
  }
}

/** in: the track's audio, right and side at this block. */
function inputs(
  f: Frame,
  n: number,
  o: PatchRunOptions,
  pos: number,
  frames: number,
): void {
  const sources = [undefined, o.audio, o.right ?? o.audio, o.side];
  for (let k = 1; k < 4; k += 1) {
    const slot = f.slots[f.slotBase[n]! + k]!;
    if (slot === -1) continue;
    const dst = at(f, n, k);
    const src = sources[k];
    for (let i = 0; i < BLOCK; i += 1) {
      const x = pos + i;
      f.m[dst + i] = src !== undefined && x < frames ? (src[x] ?? 0) : 0;
    }
  }
}

/** out: copies audio (and right) into the render. */
function output(
  f: Frame,
  n: number,
  left: Float64Array,
  right: Float64Array | undefined,
  pos: number,
  frames: number,
): void {
  const a = at(f, n, 0);
  const r = at(f, n, 1);
  const end = Math.min(BLOCK, frames - pos);
  for (let i = 0; i < end; i += 1) {
    left[pos + i] = f.m[a + i]!;
    if (right) right[pos + i] = f.m[r + i]!;
  }
}

type Fused = ReturnType<typeof fuseVoice>;
const FUSED = new WeakMap<PatchProgram, Map<number, readonly [Fused, Fused]>>();

/** Kernel function names for the fused block (fuse.ts `KernelOf`). */
const KERNEL_NAMES: Readonly<Record<number, string>> = {
  [Op.Osc]: "osc",
  [Op.Noise]: "noise",
  [Op.Svf]: "svf",
  [Op.Onepole]: "onepole",
  [Op.Adsr]: "adsr",
  [Op.Ar]: "ar",
  [Op.Slew]: "slew",
  [Op.Follow]: "follow",
  [Op.Lfo]: "lfo",
  [Op.Sh]: "sh",
  [Op.Random]: "random",
  [Op.Const]: "constant",
  [Op.Scale]: "scale",
  [Op.Clamp]: "clamp",
  [Op.Clock]: "clock",
  [Op.Vca]: "vca",
  [Op.Mix]: "mix",
  [Op.Xfade]: "xfade",
  [Op.Pan]: "pan",
  [Op.Pass]: "pass",
  [Op.Macro]: "macro",
};
const BINARY_OPS: Readonly<Record<number, number>> = {
  [Op.Add]: Binary.Add,
  [Op.Mul]: Binary.Mul,
  [Op.Min]: Binary.Min,
  [Op.Max]: Binary.Max,
  [Op.Gt]: Binary.Gt,
  [Op.Lt]: Binary.Lt,
};
const UNARY_OPS: Readonly<Record<number, number>> = {
  [Op.Abs]: Unary.Abs,
  [Op.Not]: Unary.Not,
  [Op.Pitch2Hz]: Unary.Pitch2Hz,
  [Op.Db2Gain]: Unary.Db2Gain,
};

const kernelOf = (op: number, n: number): string | null =>
  KERNEL_NAMES[op] !== undefined
    ? `${KERNEL_NAMES[op]}(f, ${n});`
    : BINARY_OPS[op] !== undefined
      ? `binary(f, ${n}, ${BINARY_OPS[op]});`
      : UNARY_OPS[op] !== undefined
        ? `unary(f, ${n}, ${UNARY_OPS[op]});`
        : null;

/** The program's fused voice blocks (first block, later blocks), built once. */
function fusedOf(
  program: PatchProgram,
  sampleRate: number,
): readonly [Fused, Fused] {
  let bySr = FUSED.get(program);
  if (!bySr) FUSED.set(program, (bySr = new Map()));
  let fused = bySr.get(sampleRate);
  if (fused) return fused;
  const deps = {
    voiceUsed: program.voiceUsed,
    osc,
    noise,
    svf,
    onepole,
    adsr,
    ar,
    slew,
    follow,
    lfo,
    sh,
    random,
    constant,
    scale,
    clamp,
    clock,
    vca,
    mix,
    xfade,
    pan,
    pass,
    macro,
    binary,
    unary,
  };
  const v = program.voice;
  fused = [
    fuseVoice(v, program.consts, true, kernelOf, deps, program, sampleRate),
    fuseVoice(v, program.consts, false, kernelOf, deps, program, sampleRate),
  ];
  bySr.set(sampleRate, fused);
  return fused;
}

/** Plays every note through the voice section into the global voice-sum slots. */

function runVoices(
  program: PatchProgram,
  options: PatchRunOptions,
  ctx: Ctx,
  gm: Float64Array,
  stride: number,
): number {
  const v = program.voice;
  const sr = options.sampleRate;
  const frames = options.frames;
  const tempo = options.tempo ?? 120;
  const macroValues = options.macros ?? [];
  const notes = [...(options.notes ?? [])]
    .filter((note) => note.start < frames && note.end > note.start)
    .sort(
      (a, b) =>
        a.start - b.start || (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : 0),
    );
  const fade = Math.max(1, Math.round(FADE_SECONDS * sr));
  const quietLimit = Math.round(SILENCE_SECONDS * sr);
  const tail = Math.round((program.maxRelease + TAIL_SECONDS) * sr);
  const pool: Voice[] = [];
  const playing: Voice[] = [];
  const fanOuts = program.fanOuts;
  const sums = program.voiceSums;
  const voiceOp = v.ids.indexOf("voice");
  const [fusedFirst, fusedNext] = fusedOf(program, sr);
  const fuse = options.fuse ?? true;
  const macroCount = program.macros.length;
  let stolen = 0;
  let order = 0;

  const acquire = (note: PatchNote, index: number): Voice => {
    const voice = pool.pop() ?? newVoice();
    voice.m.fill(0);
    voice.ctl.fill(0);
    voice.prev.fill(0);
    voice.st.fill(0);
    for (const [cell, node] of v.seeds)
      voice.st[cell] = seedHash(`${note.seed}:patch:${node}`) | 0;
    voice.index = index;
    voice.note = note;
    voice.order = order++;
    voice.pos = note.start;
    voice.first = true;
    voice.phase = 0;
    voice.random = seedHash(`${note.seed}:patch:voice`) / 4_294_967_296;
    voice.quiet = 0;
    voice.fadeAt = Infinity;
    voice.done = false;
    return voice;
  };
  function newVoice(): Voice {
    const m = new Float64Array(v.localSlots * BLOCK);
    const ctl = new Float64Array(v.ctlCount);
    const prev = new Float64Array(v.ctlCount);
    const st = new Float64Array(v.stateCount);
    return {
      m,
      ctl,
      prev,
      st,
      frame: frameOf(v, m, ctl, prev, st, BLOCK, 0, sr, 0),
      index: 0,
      note: undefined as unknown as PatchNote,
      order: 0,
      pos: 0,
      first: true,
      phase: 0,
      random: 0,
      quiet: 0,
      fadeAt: Infinity,
      done: false,
    };
  }

  const block = (voice: Voice) => {
    const f = voice.frame;
    const pos = voice.pos;
    const gb = Math.floor(pos / BLOCK);
    const bpm = valueAt(tempo, gb, 120);
    f.bps = bpm / 60;
    // External knobs at this voice block's end, on the global block grid.
    const endBlock = Math.floor((pos + BLOCK - 1) / BLOCK);
    for (let i = 0; i < macroCount; i += 1)
      ctx.ext[i] = valueAt(
        macroValues[i],
        endBlock,
        program.macros[i]!.default,
      );
    const fused = voice.first ? fusedFirst : fusedNext;
    // Fan-outs: global sources at this voice's absolute position. A fused
    // block reads its direct fan-ins from `gm` itself when all are in range.
    let fanAt = pos;
    for (let k = 0; k < fanOuts.length; k += 2)
      if (fanOuts[k]! * stride + pos + BLOCK > gm.length) fanAt = -1;
    for (let k = 0; k < fanOuts.length; k += 2) {
      const dst = addr(f, fanOuts[k + 1]!);
      if (fuse && fanAt >= 0 && fused.direct.has(dst)) continue;
      const src = fanOuts[k]! * stride + pos;
      const vm = f.m;
      // Past the end of the song a source reads as silence; the in-range
      // case stays a plain copy (an out-of-bounds read deoptimizes).
      if (src + BLOCK <= gm.length)
        for (let i = 0; i < BLOCK; i += 1) vm[dst + i] = gm[src + i]!;
      else for (let i = 0; i < BLOCK; i += 1) vm[dst + i] = gm[src + i] ?? 0;
    }
    const fadeAt = voice.fadeAt;
    const gateOff = voice.note.end;
    const plain = fadeAt >= pos + BLOCK && pos + BLOCK <= stride - BLOCK;
    const track = pos + BLOCK > gateOff;
    const sumAt = fuse && fused.sums && plain && !track ? pos : -1;
    if (fuse) fused(f, ctx, voice, sr, gm, stride, fanAt, sumAt);
    else
      for (let node = 0; node < v.op.length; node += 1) {
        if (node === voiceOp) {
          voiceSources(f, node, voice, sr, program.voiceUsed);
          continue;
        }
        prologue(f, v, ctx, node, voice.first);
        kernel(f, v, node);
      }
    copyDelays(f, v.delays);
    scrubState(voice.st, ctx);
    voice.first = false;
    // Voice sums, with the steal fade, into the global accumulators. The
    // peak (for the silence test) only matters after gate-off.
    let peak = 0;
    const vm = f.m;
    for (let k = 0; k < sums.length && sumAt < 0; k += 2) {
      const src = addr(f, sums[k]!);
      const dst = sums[k + 1]! * stride + pos;
      if (plain && !track) {
        for (let i = 0; i < BLOCK; i += 1) {
          const x = vm[src + i]!;
          if (x - x === 0) gm[dst + i]! += x;
          else ctx.scrubbed += 1;
        }
        continue;
      }
      for (let i = 0; i < BLOCK; i += 1) {
        let x = vm[src + i]!;
        if (x - x !== 0) {
          x = 0;
          ctx.scrubbed += 1;
        }
        const t = pos + i;
        if (t >= fadeAt)
          x *= t - fadeAt >= fade ? 0 : 1 - (t - fadeAt + 1) / fade;
        if (t < stride - BLOCK) gm[dst + i]! += x;
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
      }
    }
    voice.pos = pos + BLOCK;
    if (voice.pos >= fadeAt + fade) voice.done = true;
    else if (pos >= gateOff) {
      voice.quiet = peak < SILENCE ? voice.quiet + BLOCK : 0;
      if (voice.quiet >= quietLimit || voice.pos >= gateOff + tail)
        voice.done = true;
    }
    if (voice.pos >= frames) voice.done = true;
  };
  const advance = (until: number) => {
    for (const voice of playing)
      while (!voice.done && voice.pos + BLOCK <= until) block(voice);
    for (let i = playing.length - 1; i >= 0; i -= 1)
      if (playing[i]!.done) pool.push(...playing.splice(i, 1));
  };

  for (const note of notes) {
    advance(note.start);
    const owners = playing.filter((p) => p.fadeAt === Infinity);
    let index = -1;
    if (owners.length < program.voices) {
      const used = new Set(owners.map((p) => p.index));
      index = 0;
      while (used.has(index)) index += 1;
    } else {
      const oldest = owners.reduce((a, b) => (b.order < a.order ? b : a));
      oldest.fadeAt = note.start;
      index = oldest.index;
      stolen += 1;
    }
    playing.push(acquire(note, index));
  }
  advance(Infinity);
  return stolen;
}

/** voice: pitch, note, gate, velocity, phase, random, index, age (wired ones only). */
function voiceSources(
  f: Frame,
  n: number,
  voice: Voice,
  sr: number,
  used: number,
): void {
  const m = f.m;
  const note = voice.note;
  const pos = voice.pos;
  if (used & 1) {
    const o = at(f, n, 0);
    put(m, note.pitch, o);
  }
  if (used & 2) {
    const o = at(f, n, 1);
    put(m, note.note, o);
  }
  if (used & 4) {
    const o = at(f, n, 2);
    for (let i = 0; i < BLOCK; i += 1) m[o + i] = pos + i < note.end ? 1 : 0;
  }
  if (used & 8) {
    const o = at(f, n, 3);
    put(m, note.velocity, o);
  }
  if (used & 16) {
    const o = at(f, n, 4);
    const inc = note.pitch / sr;
    let p = voice.phase;
    for (let i = 0; i < BLOCK; i += 1) {
      m[o + i] = p;
      p += inc;
      if (p >= 1) p -= Math.floor(p);
    }
    voice.phase = p;
  }
  if (used & 32) {
    const o = at(f, n, 5);
    put(m, voice.random, o);
  }
  if (used & 64) {
    const o = at(f, n, 6);
    put(m, voice.index, o);
  }
  if (used & 128) {
    const o = at(f, n, 7);
    for (let i = 0; i < BLOCK; i += 1) m[o + i] = (pos - note.start + i) / sr;
  }
}
