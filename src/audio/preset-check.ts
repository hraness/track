/**
 * Objective checks for built-in presets (nobody can listen in CI). Each
 * preset plays a standard phrase: a held chord (or a held note for mono
 * sounds), a line across its range, a soft and a hard note, and a top note,
 * then a tail. The render is measured for loudness, peaks, DC, stereo,
 * spectrum, velocity response, tail and cost; `presetProblems` compares
 * the numbers with PRESET_LIMITS.
 */
import { compilePatch, PATCH_COST_BUDGET } from "./patch/compile.ts";
import { measureMix, pcmChannels } from "./loudness.ts";
import { renderScorePcm } from "./wav.ts";
import { createScore } from "../../core/score.ts";
import type { Preset, PresetCategory } from "../../core/presets/build.ts";

export const CHECK_SAMPLE_RATE = 22050;
const BPM = 120;
const TPB = 480;
const SEC = (s: number) => Math.round((s * BPM * TPB) / 60);

/** Loudness each category is normalised to (integrated LUFS). */
export const CATEGORY_LUFS: Readonly<Record<PresetCategory, number>> =
  Object.freeze({
    init: -18,
    bass: -16,
    lead: -16,
    pad: -18,
    keys: -17,
    pluck: -17,
    mallet: -18,
    strings: -18,
    brass: -17,
    wind: -17,
    vox: -18,
    arp: -17,
    fx: -19,
    texture: -20,
    drums: -16,
    perc: -17,
    chain: -18,
  });

/** The limits every built-in preset meets (test/presets-quality.test.ts). */
export const PRESET_LIMITS = Object.freeze({
  /** |integrated − category target|, LU. */
  loudnessLu: 2,
  /** True peak ceiling, dBTP. */
  truePeakDb: -1,
  /** |mean| of either channel, full scale. */
  dc: 0.005,
  /** L/R correlation floor (mono compatibility). */
  correlation: -0.1,
  /** Mono sum may lose at most this much loudness, LU. */
  monoLossLu: 3,
  /** Last 0.5 s at least this far under the loudest 0.5 s, dB. */
  tailDb: 45,
  /** Share of energy above 6 kHz on the top note (aliasing proxy), dB. */
  topHighDb: -3,
  /** Pads, keys, strings, vox: high band share ceiling, dB. */
  softHighDb: -12,
  /** Basses: sub+bass share floor, dB (a quarter of the energy below 250 Hz). */
  bassLowDb: -6,
  /** A hard note is at least this much louder than a soft one, dB. */
  velocityDb: 1,
});

/** Categories whose sounds should not be harsh on top. */
const SOFT_TOP: ReadonlySet<PresetCategory> = new Set([
  "pad",
  "keys",
  "strings",
  "vox",
  "texture",
]);
/** Categories that may be wide or out of phase by design. */
const WIDE: ReadonlySet<PresetCategory> = new Set(["fx", "texture", "chain"]);
/** Engines whose level does not follow velocity by design. */
const FLAT_VELOCITY: ReadonlySet<string> = new Set([
  "engine.keys:tonewheel",
  "engine.keys:combo",
  "engine.keys:pipe",
  "engine.granular",
  "engine.vocoder",
  "engine.sing",
  "engine.wind",
  // An amp head compresses: played hard or soft it sits at one level.
  "fx.head",
]);

export type PresetMetrics = Readonly<{
  name: string;
  lufs: number;
  target: number;
  truePeak: number;
  dc: number;
  correlation: number;
  monoLoss: number;
  tailDb: number;
  bands: Readonly<Record<string, number>>;
  topHigh: number;
  velocityDb: number;
  nonFinite: number;
  cost: number;
  voices: number;
  requestedVoices: number;
  seconds: number;
}>;

type PhraseNote = { start: number; dur: number; pitch: number; vel: number };

/** The standard phrase for a preset, in seconds. */
export function presetPhrase(preset: Preset): PhraseNote[] {
  const [lo, hi] = preset.range;
  const mid = Math.round((lo + hi) / 2);
  const notes: PhraseNote[] = [];
  const root = Math.max(lo, mid - 5);
  // 0–1.6 s: a chord (or held note).
  const chord = preset.mono ? [root] : [root, root + 4, root + 7];
  for (const p of chord) notes.push({ start: 0, dur: 1.5, pitch: p, vel: 0.8 });
  // 2–3.75 s: a line across the range.
  for (let i = 0; i < 8; i += 1)
    notes.push({
      start: 2 + i * 0.25,
      dur: 0.22,
      pitch: Math.round(lo + ((hi - lo) * i) / 7),
      vel: 0.75,
    });
  // 4.5 s soft, 5.5 s hard (same pitch).
  notes.push({ start: 4.5, dur: 0.4, pitch: mid, vel: 0.3 });
  notes.push({ start: 5.5, dur: 0.4, pitch: mid, vel: 1 });
  // 6.5 s: the top note.
  notes.push({ start: 6.5, dur: 0.5, pitch: hi, vel: 0.8 });
  return notes;
}

/** Seconds rendered: the phrase plus a tail. */
export const CHECK_SECONDS = 14;

function window(
  left: Float64Array,
  right: Float64Array,
  from: number,
  to: number,
): [Float64Array, Float64Array] {
  const a = Math.floor(from * CHECK_SAMPLE_RATE);
  const b = Math.min(left.length, Math.floor(to * CHECK_SAMPLE_RATE));
  return [left.slice(a, b), right.slice(a, b)];
}

function rmsDb(left: Float64Array, right: Float64Array): number {
  let e = 0;
  for (let i = 0; i < left.length; i += 1) e += left[i]! ** 2 + right[i]! ** 2;
  return 10 * Math.log10(e / Math.max(1, 2 * left.length) + 1e-20);
}

const velocityFlat = (preset: Preset): boolean =>
  (preset.patch?.nodes ?? []).some(
    (n) =>
      FLAT_VELOCITY.has(n.type) ||
      FLAT_VELOCITY.has(`${n.type}:${String(n.params?.instrument ?? "")}`),
  );

/** A track playing `preset` (an effect preset runs over a saw chord). */
export function presetScore(
  preset: Preset,
  phrase: readonly PhraseNote[] = presetPhrase(preset),
  seconds = CHECK_SECONDS,
) {
  const notes = phrase.map((n, i) => ({
    id: `n${i}`,
    trackId: "t",
    startTick: SEC(n.start),
    durationTicks: SEC(n.dur),
    pitch: n.pitch,
    velocity: n.vel,
  }));
  const track =
    preset.kind === "effect"
      ? {
          id: "t",
          name: "t",
          instrument: "sawtooth",
          synth: { attack: 0.01, release: 0.2, lpf: 3000 },
          fxPatch: [preset.patch!],
        }
      : { id: "t", name: "t", instrument: "patch", patch: preset.patch! };
  return createScore({
    tempoBpm: BPM,
    ticksPerBeat: TPB,
    bars: Math.ceil(seconds / 2),
    tracks: [track],
    notes,
  } as unknown as Parameters<typeof createScore>[0]);
}

/** Renders the phrase and measures it. */
export function measurePreset(preset: Preset): PresetMetrics {
  if (!preset.patch) throw new Error(`${preset.name}: kits are not measured`);
  const score = presetScore(preset);
  const audio = renderScorePcm(score, { sampleRate: CHECK_SAMPLE_RATE });
  const [left, right] = pcmChannels(audio.pcm);
  const mix = measureMix(left, right, CHECK_SAMPLE_RATE);
  const mono = new Float64Array(left.length);
  for (let i = 0; i < left.length; i += 1) mono[i] = (left[i]! + right[i]!) / 2;
  const monoMix = measureMix(mono, mono, CHECK_SAMPLE_RATE, {
    truePeak: false,
  });
  let dl = 0;
  let dr = 0;
  for (let i = 0; i < left.length; i += 1) {
    dl += left[i]!;
    dr += right[i]!;
  }
  const dc = Math.max(Math.abs(dl), Math.abs(dr)) / left.length;
  // Loudest half second against the last half second.
  let loudest = -Infinity;
  for (let t = 0; t + 0.5 <= 8; t += 0.25)
    loudest = Math.max(loudest, rmsDb(...window(left, right, t, t + 0.5)));
  const end = audio.frames / CHECK_SAMPLE_RATE;
  const tail = rmsDb(...window(left, right, end - 0.5, end));
  const top = window(left, right, 6.5, 7);
  const topMix = measureMix(top[0], top[1], CHECK_SAMPLE_RATE, {
    truePeak: false,
  });
  // Velocity: one soft and one hard note, each rendered alone so a long
  // release or the reverb of the phrase cannot blur the comparison.
  const mid = Math.round((preset.range[0] + preset.range[1]) / 2);
  const single = (vel: number) => {
    const pcm = renderScorePcm(
      presetScore(preset, [{ start: 0, dur: 0.6, pitch: mid, vel }], 2),
      { sampleRate: CHECK_SAMPLE_RATE },
    ).pcm;
    const [l, r] = pcmChannels(pcm);
    return rmsDb(l, r);
  };
  const soft = single(0.3);
  const hard = single(1);
  const program = compilePatch(preset.patch);
  const requested = preset.patch.voices ?? 16;
  const nonFinite = audio.nonFinite
    ? Object.values(audio.nonFinite).reduce(
        (sum: number, v) => sum + (typeof v === "number" ? v : 0),
        0,
      )
    : 0;
  return Object.freeze({
    name: preset.name,
    lufs: mix.loudness.integrated,
    target: CATEGORY_LUFS[preset.category],
    truePeak: mix.loudness.truePeak,
    dc,
    correlation: mix.correlation,
    monoLoss: mix.loudness.integrated - monoMix.loudness.integrated,
    tailDb: loudest - tail,
    bands: mix.bands,
    topHigh: topMix.bands.high,
    velocityDb: hard - soft,
    nonFinite,
    cost: program.cost,
    voices: program.voices,
    requestedVoices: requested,
    seconds: end,
  });
}

/** What a preset's numbers break, as short lines (empty: it passes). */
export function presetProblems(preset: Preset, m: PresetMetrics): string[] {
  const L = PRESET_LIMITS;
  const out: string[] = [];
  const f = (v: number) => v.toFixed(1);
  if (!Number.isFinite(m.lufs)) out.push("silent");
  else if (Math.abs(m.lufs - m.target) > L.loudnessLu)
    out.push(`loudness ${f(m.lufs)} LUFS, target ${m.target}±${L.loudnessLu}`);
  if (m.truePeak > L.truePeakDb)
    out.push(`true peak ${f(m.truePeak)} dBTP > ${L.truePeakDb}`);
  if (m.dc > L.dc) out.push(`DC ${m.dc.toFixed(4)}`);
  if (m.nonFinite > 0) out.push(`${m.nonFinite} non-finite samples`);
  if (!WIDE.has(preset.category)) {
    if (m.correlation < L.correlation)
      out.push(`correlation ${m.correlation.toFixed(2)} < ${L.correlation}`);
    if (m.monoLoss > L.monoLossLu)
      out.push(`mono sum loses ${f(m.monoLoss)} LU`);
  }
  if (m.tailDb < L.tailDb)
    out.push(`tail only ${f(m.tailDb)} dB under the peak`);
  if (preset.kind === "instrument") {
    if (m.topHigh > L.topHighDb)
      out.push(`top note ${f(m.topHigh)} dB above 6 kHz (aliasing)`);
    if (SOFT_TOP.has(preset.category) && (m.bands.high ?? -99) > L.softHighDb)
      out.push(`harsh: ${f(m.bands.high!)} dB above 6 kHz`);
    if (
      preset.category === "bass" &&
      10 *
        Math.log10(
          10 ** ((m.bands.sub ?? -99) / 10) +
            10 ** ((m.bands.bass ?? -99) / 10),
        ) <
        L.bassLowDb
    )
      out.push("bass: too little energy below 250 Hz");
    if (
      !velocityFlat(preset) &&
      preset.category !== "fx" &&
      preset.category !== "texture" &&
      m.velocityDb < L.velocityDb
    )
      out.push(`velocity: hard note only ${f(m.velocityDb)} dB louder`);
  }
  if (m.cost > PATCH_COST_BUDGET)
    out.push(`cost ${m.cost} > ${PATCH_COST_BUDGET}`);
  if (m.voices > 0 && m.voices < Math.min(m.requestedVoices, 4))
    out.push(`cost caps voices at ${m.voices}`);
  return out;
}

/** The level gain that brings `m` to its target (for the levels table). */
export function levelFor(current: number, m: PresetMetrics): number {
  return current * 10 ** ((m.target - m.lufs) / 20);
}
