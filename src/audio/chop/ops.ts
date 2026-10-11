/**
 * Pure, deterministic chop operations on `Pcm` buffers: analysis (onsets,
 * beats, segments, peaks) and edits (cut with zero-crossing snap, trim, pad,
 * fades, gain, normalize, reverse, filter, loop seams, concat, mix, split,
 * TS stretch and pitch). No IO here; `run.ts` reads and writes files.
 */
import { detectOnsets } from "../dsp/onset.ts";
import { pitchShift } from "../dsp/shift.ts";
import { Biquad } from "../effects/common.ts";
import { estimateTempo, onsetEnvelope } from "../../media/dsp.ts";
import {
  ChopError,
  frames,
  fromDb,
  makePcm,
  mapChannels,
  mono,
  peak,
  slicePcm,
  type Pcm,
} from "./pcm.ts";

/** Analysis windows: long files are analysed in pieces, never truncated. */
export const ANALYSIS_WINDOW_SECONDS = 240;
export const ANALYSIS_OVERLAP_SECONDS = 2;
/** Zero-crossing search radius. */
export const ZERO_SNAP_SECONDS = 0.005;
/** Onset snap radius. */
export const ONSET_SNAP_SECONDS = 0.05;
/** Bins for the peaks strip; ≤ 200 keeps the JSON under 2 KiB. */
export const MAX_PEAK_BINS = 200;

export type Snap = "zero" | "onset" | "beat" | "none";
export type FadeCurve = "linear" | "exp" | "log" | "scurve";

// ---------------------------------------------------------------- snapping

/**
 * Nearest sign change of the mono sum within ±5 ms of `frame` (then the
 * quietest sample if there is none), so a cut never clicks.
 */
export function snapToZero(
  signal: Float32Array,
  frame: number,
  sampleRate: number,
): number {
  const at = Math.max(0, Math.min(signal.length, Math.round(frame)));
  if (at <= 0 || at >= signal.length) return at;
  const radius = Math.max(1, Math.round(ZERO_SNAP_SECONDS * sampleRate));
  for (let d = 0; d <= radius; d += 1) {
    for (const i of d === 0 ? [at] : [at - d, at + d]) {
      if (i <= 0 || i >= signal.length) continue;
      const a = signal[i - 1]!;
      const b = signal[i]!;
      if (b === 0 || (a < 0 && b > 0) || (a > 0 && b < 0))
        // Pick whichever side of the crossing is closer to zero.
        return Math.abs(a) < Math.abs(b) ? i - 1 : i;
    }
  }
  let best = at;
  let bestValue = Math.abs(signal[at]!);
  for (
    let i = Math.max(0, at - radius);
    i <= Math.min(signal.length - 1, at + radius);
    i += 1
  ) {
    const v = Math.abs(signal[i]!);
    if (v < bestValue) {
      best = i;
      bestValue = v;
    }
  }
  return best;
}

export function snapToList(
  frame: number,
  points: readonly number[],
  radius: number,
): number {
  let best = frame;
  let bestDistance = radius + 1;
  for (const p of points) {
    const d = Math.abs(p - frame);
    if (d < bestDistance) {
      best = p;
      bestDistance = d;
    }
  }
  return bestDistance <= radius ? best : frame;
}

// ---------------------------------------------------------------- analysis

type Window = Readonly<{ start: number; end: number }>;

/** 240 s windows with 2 s overlap covering the whole signal. */
export function analysisWindows(length: number, sampleRate: number): Window[] {
  const size = ANALYSIS_WINDOW_SECONDS * sampleRate;
  const overlap = ANALYSIS_OVERLAP_SECONDS * sampleRate;
  if (length <= size) return [{ start: 0, end: length }];
  const out: Window[] = [];
  for (let start = 0; start < length; start += size - overlap) {
    out.push({ start, end: Math.min(length, start + size) });
    if (start + size >= length) break;
  }
  return out;
}

/** Onset frames over the whole file (windowed, merged, deduplicated). */
export function onsets(pcm: Pcm, sensitivity = 1): number[] {
  const signal = mono(pcm);
  const all: number[] = [];
  const gap = Math.round(0.03 * pcm.sampleRate);
  for (const w of analysisWindows(signal.length, pcm.sampleRate)) {
    const found = detectOnsets(
      signal.subarray(w.start, w.end),
      pcm.sampleRate,
      sensitivity,
    );
    for (const f of found) {
      const at = f + w.start;
      if (!rises(signal, at, pcm.sampleRate)) continue;
      if (all.length === 0 || at - all[all.length - 1]! > gap) all.push(at);
    }
  }
  return all;
}

/**
 * An onset must start a rise in energy: the 30 ms after it louder than the
 * 30 ms before it. Spectral flux alone also fires inside a decaying tail.
 */
function rises(signal: Float32Array, at: number, sampleRate: number): boolean {
  const span = Math.round(0.03 * sampleRate);
  const energy = (from: number, to: number) => {
    let sum = 0;
    const a = Math.max(0, from);
    const b = Math.min(signal.length, to);
    for (let i = a; i < b; i += 1) sum += signal[i]! * signal[i]!;
    return b > a ? sum / (b - a) : 0;
  };
  const before = energy(
    at - span - Math.round(0.005 * sampleRate),
    at - Math.round(0.005 * sampleRate),
  );
  const after = energy(at, at + span);
  return after > before * 1.25 + 1e-12;
}

export type Beats = Readonly<{
  bpm: number;
  confidence: number;
  offset: number;
  beats: number[];
}>;

/** Tempo and a beat grid in seconds (first window decides the tempo). */
export function beats(pcm: Pcm): Beats | undefined {
  const signal = mono(pcm);
  const window = Math.min(
    signal.length,
    ANALYSIS_WINDOW_SECONDS * pcm.sampleRate,
  );
  const { envelope, hopSeconds } = onsetEnvelope(
    signal.subarray(0, window),
    pcm.sampleRate,
  );
  const estimate = estimateTempo(envelope, hopSeconds);
  if (!estimate) return undefined;
  const period = 60 / estimate.bpm;
  const total = signal.length / pcm.sampleRate;
  const grid: number[] = [];
  for (let t = estimate.offsetSeconds % period; t < total; t += period)
    grid.push(Math.round(t * 1000) / 1000);
  return {
    bpm: Math.round(estimate.bpm * 100) / 100,
    confidence: Math.round(estimate.confidence * 1000) / 1000,
    offset: Math.round((estimate.offsetSeconds % period) * 1000) / 1000,
    beats: grid,
  };
}

export type Segment = Readonly<{ start: number; end: number; peakDb?: number }>;

/**
 * Non-silent regions (frames): a 10 ms RMS envelope against `thresholdDb`,
 * gaps shorter than `minFrames` bridged, regions shorter dropped.
 */
export function silenceSegments(
  pcm: Pcm,
  thresholdDb = -40,
  minFrames = Math.round(0.08 * pcm.sampleRate),
): Segment[] {
  const signal = mono(pcm);
  const hop = Math.max(1, Math.round(0.01 * pcm.sampleRate));
  const threshold = fromDb(thresholdDb);
  const loud: boolean[] = [];
  for (let start = 0; start < signal.length; start += hop) {
    let sum = 0;
    const end = Math.min(signal.length, start + hop);
    for (let i = start; i < end; i += 1) sum += signal[i]! ** 2;
    loud.push(Math.sqrt(sum / Math.max(1, end - start)) >= threshold);
  }
  const raw: Segment[] = [];
  let open = -1;
  for (let i = 0; i <= loud.length; i += 1) {
    if (i < loud.length && loud[i]) {
      if (open < 0) open = i;
    } else if (open >= 0) {
      raw.push({ start: open * hop, end: Math.min(signal.length, i * hop) });
      open = -1;
    }
  }
  const merged: Segment[] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < minFrames)
      merged[merged.length - 1] = { start: last.start, end: s.end };
    else merged.push(s);
  }
  return merged.filter((s) => s.end - s.start >= minFrames);
}

/** Onset-to-onset regions (frames), the last running to the end. */
export function onsetSegments(
  pcm: Pcm,
  minFrames: number,
  sensitivity = 1,
): Segment[] {
  const points = onsets(pcm, sensitivity);
  const n = frames(pcm);
  if (points.length === 0) return n > 0 ? [{ start: 0, end: n }] : [];
  const out: Segment[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const start = points[i]!;
    const end = points[i + 1] ?? n;
    if (end - start >= minFrames) out.push({ start, end });
    else if (out.length > 0)
      out[out.length - 1] = { start: out[out.length - 1]!.start, end };
  }
  return out;
}

/** `count` equal regions (frames). */
export function gridSegments(pcm: Pcm, count: number): Segment[] {
  const n = frames(pcm);
  const out: Segment[] = [];
  for (let i = 0; i < count; i += 1)
    out.push({
      start: Math.round((i * n) / count),
      end: Math.round(((i + 1) * n) / count),
    });
  return out;
}

/** Beat-grid regions every `beatsPer` beats (frames). */
export function beatSegments(pcm: Pcm, beatsPer = 1): Segment[] {
  const grid = beats(pcm);
  const n = frames(pcm);
  if (!grid || grid.beats.length < 2)
    return n > 0 ? [{ start: 0, end: n }] : [];
  const marks = grid.beats
    .filter((_, i) => i % Math.max(1, beatsPer) === 0)
    .map((t) => Math.round(t * pcm.sampleRate));
  const out: Segment[] = [];
  if (marks[0]! > 0) out.push({ start: 0, end: marks[0]! });
  for (let i = 0; i < marks.length; i += 1)
    out.push({ start: marks[i]!, end: marks[i + 1] ?? n });
  return out.filter((s) => s.end > s.start);
}

/**
 * Coarse sections: a per-second energy curve, split where the smoothed level
 * jumps most (novelty peaks), at most `count` sections of ≥ 4 s.
 */
export function sectionSegments(pcm: Pcm, count = 8): Segment[] {
  const signal = mono(pcm);
  const sr = pcm.sampleRate;
  const hop = sr; // one second
  const levels: number[] = [];
  for (let start = 0; start < signal.length; start += hop) {
    let sum = 0;
    const end = Math.min(signal.length, start + hop);
    for (let i = start; i < end; i += 1) sum += signal[i]! ** 2;
    levels.push(10 * Math.log10(sum / Math.max(1, end - start) + 1e-9));
  }
  const novelty: { i: number; v: number }[] = [];
  const k = 4;
  for (let i = k; i < levels.length - k; i += 1) {
    let before = 0;
    let after = 0;
    for (let j = 1; j <= k; j += 1) {
      before += levels[i - j]!;
      after += levels[i + j - 1]!;
    }
    novelty.push({ i, v: Math.abs(after - before) / k });
  }
  novelty.sort((a, b) => b.v - a.v || a.i - b.i);
  const cuts: number[] = [];
  for (const { i, v } of novelty) {
    if (cuts.length >= Math.max(0, count - 1) || v < 3) break;
    if (cuts.every((c) => Math.abs(c - i) >= 4)) cuts.push(i);
  }
  cuts.sort((a, b) => a - b);
  const marks = [0, ...cuts.map((c) => c * hop), signal.length];
  const out: Segment[] = [];
  for (let i = 0; i + 1 < marks.length; i += 1)
    out.push({ start: marks[i]!, end: marks[i + 1]! });
  return out;
}

/** Min/max per bin of the mono sum, rounded to 0.001. */
export function peakBins(pcm: Pcm, count: number): number[] {
  const signal = mono(pcm);
  const bins = Math.max(1, Math.min(MAX_PEAK_BINS, count, signal.length || 1));
  const out: number[] = [];
  for (let b = 0; b < bins; b += 1) {
    const start = Math.floor((b * signal.length) / bins);
    const end = Math.max(
      start + 1,
      Math.floor(((b + 1) * signal.length) / bins),
    );
    let max = 0;
    for (let i = start; i < Math.min(end, signal.length); i += 1) {
      const v = Math.abs(signal[i]!);
      if (v > max) max = v;
    }
    out.push(Math.round(max * 1000) / 1000);
  }
  return out;
}

/** A one-line level strip: ▁▂▃▄▅▆▇█, or " .:-=+*#" in ASCII mode. */
export function peakStrip(bins: readonly number[], ascii = false): string {
  const glyphs = ascii ? " .:-=+*#" : "▁▂▃▄▅▆▇█";
  const max = Math.max(1e-9, ...bins);
  return bins
    .map(
      (v) =>
        glyphs[
          Math.min(
            glyphs.length - 1,
            Math.floor((v / max) * (glyphs.length - 1) + 0.5),
          )
        ],
    )
    .join("");
}

// ---------------------------------------------------------------- edits

export function gain(pcm: Pcm, db: number): Pcm {
  const g = fromDb(db);
  return mapChannels(pcm, (c) => c.map((v) => v * g));
}

/** Scale so the peak (or RMS when `rms`) lands on `targetDb`. */
export function normalize(
  pcm: Pcm,
  targetDb = -1,
  mode: "peak" | "rms" = "peak",
): Pcm {
  let level = 0;
  if (mode === "peak") level = peak(pcm);
  else {
    let sum = 0;
    let count = 0;
    for (const c of pcm.channels) {
      for (let i = 0; i < c.length; i += 1) sum += c[i]! ** 2;
      count += c.length;
    }
    level = count ? Math.sqrt(sum / count) : 0;
  }
  if (!(level > 0)) return pcm;
  const g = fromDb(targetDb) / level;
  return mapChannels(pcm, (c) => c.map((v) => v * g));
}

export function reverse(pcm: Pcm): Pcm {
  return mapChannels(pcm, (c) => c.slice().reverse());
}

/** Gain at position x ∈ [0, 1] for a fade-in curve (fade-outs mirror it). */
export function curveAt(x: number, curve: FadeCurve): number {
  const t = Math.max(0, Math.min(1, x));
  switch (curve) {
    case "linear":
      return t;
    case "exp":
      return t * t;
    case "log":
      return Math.sqrt(t);
    case "scurve":
      return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }
}

export function fade(
  pcm: Pcm,
  inFrames: number,
  outFrames: number,
  curve: FadeCurve = "linear",
): Pcm {
  const n = frames(pcm);
  const fi = Math.max(0, Math.min(n, Math.round(inFrames)));
  const fo = Math.max(0, Math.min(n, Math.round(outFrames)));
  return mapChannels(pcm, (c) => {
    const out = c.slice();
    for (let i = 0; i < fi; i += 1) out[i]! *= curveAt(i / fi, curve);
    for (let i = 0; i < fo; i += 1) out[n - 1 - i]! *= curveAt(i / fo, curve);
    return out;
  });
}

/** Drop leading and trailing audio below `thresholdDb` (frames kept). */
export function trimBounds(
  pcm: Pcm,
  thresholdDb = -40,
): Readonly<{ start: number; end: number }> {
  const threshold = fromDb(thresholdDb);
  const n = frames(pcm);
  let start = 0;
  let end = n;
  const loud = (i: number) =>
    pcm.channels.some((c) => Math.abs(c[i]!) >= threshold);
  while (start < n && !loud(start)) start += 1;
  while (end > start && !loud(end - 1)) end -= 1;
  return { start, end };
}

/** Positive `offsetFrames` adds silence before; negative drops the head. */
export function pad(pcm: Pcm, offsetFrames: number, tailFrames = 0): Pcm {
  const off = Math.round(offsetFrames);
  if (off < 0) return pad(slicePcm(pcm, -off, frames(pcm)), 0, tailFrames);
  const n = frames(pcm);
  const out = makePcm(
    pcm.sampleRate,
    pcm.channels.length,
    n + off + Math.max(0, Math.round(tailFrames)),
  );
  pcm.channels.forEach((c, i) => out.channels[i]!.set(c, off));
  return out;
}

export type FilterKind = "highpass" | "lowpass" | "bandpass";

export function filter(pcm: Pcm, kind: FilterKind, hz: number, q = 0.707): Pcm {
  const type = kind === "highpass" ? "hpf" : kind === "lowpass" ? "lpf" : "bpf";
  return mapChannels(pcm, (c) => {
    const bq = new Biquad();
    bq.set(type, hz, q, pcm.sampleRate);
    const out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i += 1) out[i] = bq.process(c[i]!);
    return out;
  });
}

/**
 * A seamless loop of [start, end): the tail's last `crossfade` frames are
 * blended into the head so the wrap is continuous.
 */
export function loopSeam(pcm: Pcm, crossfadeFrames: number): Pcm {
  const n = frames(pcm);
  const x = Math.max(
    0,
    Math.min(Math.floor(n / 2), Math.round(crossfadeFrames)),
  );
  if (x === 0) return pcm;
  return mapChannels(pcm, (c) => {
    const out = c.slice(0, n - x);
    for (let i = 0; i < x; i += 1) {
      const t = i / x;
      // Equal-power blend: the tail fades out over the head fading in.
      out[i] =
        c[i]! * Math.sin((t * Math.PI) / 2) +
        c[n - x + i]! * Math.cos((t * Math.PI) / 2);
    }
    return out;
  });
}

function matchLayout(pcm: Pcm, sampleRate: number, channels: number): Pcm {
  if (pcm.sampleRate !== sampleRate)
    throw new ChopError(
      `sample rates differ (${pcm.sampleRate} vs ${sampleRate}) · convert first`,
    );
  if (pcm.channels.length === channels) return pcm;
  if (pcm.channels.length === 1)
    return {
      sampleRate,
      channels: Array.from({ length: channels }, () => pcm.channels[0]!),
    };
  const m = mono(pcm);
  return { sampleRate, channels: Array.from({ length: channels }, () => m) };
}

/** Join buffers end to end with an optional equal-power crossfade. */
export function concat(parts: readonly Pcm[], crossfadeFrames = 0): Pcm {
  if (parts.length === 0) throw new ChopError("concat needs inputs");
  const sr = parts[0]!.sampleRate;
  const ch = Math.max(...parts.map((p) => p.channels.length));
  const aligned = parts.map((p) => matchLayout(p, sr, ch));
  const x = Math.max(0, Math.round(crossfadeFrames));
  let total = 0;
  aligned.forEach(
    (p, i) =>
      (total +=
        frames(p) -
        (i > 0 ? Math.min(x, frames(p), frames(aligned[i - 1]!)) : 0)),
  );
  const out = makePcm(sr, ch, total);
  let at = 0;
  aligned.forEach((p, index) => {
    const overlap =
      index > 0 ? Math.min(x, frames(p), frames(aligned[index - 1]!)) : 0;
    at -= overlap;
    for (let c = 0; c < ch; c += 1) {
      const src = p.channels[c]!;
      const dst = out.channels[c]!;
      for (let i = 0; i < src.length; i += 1) {
        if (i < overlap) {
          const t = i / overlap;
          dst[at + i] =
            dst[at + i]! * Math.cos((t * Math.PI) / 2) +
            src[i]! * Math.sin((t * Math.PI) / 2);
        } else dst[at + i] = src[i]!;
      }
    }
    at += frames(p);
  });
  return out;
}

/** Sum buffers with per-input gains (dB) and start offsets (frames). */
export function mix(
  parts: readonly Pcm[],
  gainsDb: readonly number[] = [],
  offsets: readonly number[] = [],
): Pcm {
  if (parts.length === 0) throw new ChopError("mix needs inputs");
  const sr = parts[0]!.sampleRate;
  const ch = Math.max(...parts.map((p) => p.channels.length));
  const aligned = parts.map((p) => matchLayout(p, sr, ch));
  const length = Math.max(
    ...aligned.map(
      (p, i) => frames(p) + Math.max(0, Math.round(offsets[i] ?? 0)),
    ),
  );
  const out = makePcm(sr, ch, length);
  aligned.forEach((p, i) => {
    const g = fromDb(gainsDb[i] ?? 0);
    const off = Math.max(0, Math.round(offsets[i] ?? 0));
    for (let c = 0; c < ch; c += 1) {
      const src = p.channels[c]!;
      const dst = out.channels[c]!;
      for (let j = 0; j < src.length; j += 1) dst[off + j]! += src[j]! * g;
    }
  });
  return out;
}

/** Each channel as its own mono buffer. */
export function split(pcm: Pcm): Pcm[] {
  return pcm.channels.map((c) => ({
    sampleRate: pcm.sampleRate,
    channels: [c.slice()],
  }));
}

/** Linear-interpolation resample of one channel to `length` frames. */
function stretchLinear(x: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length);
  if (x.length === 0) return out;
  const step = (x.length - 1) / Math.max(1, length - 1);
  for (let i = 0; i < length; i += 1) {
    const pos = i * step;
    const a = Math.floor(pos);
    const frac = pos - a;
    out[i] =
      x[a]! * (1 - frac) + (x[Math.min(x.length - 1, a + 1)] ?? 0) * frac;
  }
  return out;
}

/** Change the sample rate (linear interpolation; ffmpeg does better). */
export function resample(pcm: Pcm, sampleRate: number): Pcm {
  if (sampleRate === pcm.sampleRate) return pcm;
  const length = Math.round((frames(pcm) * sampleRate) / pcm.sampleRate);
  return {
    sampleRate,
    channels: pcm.channels.map((c) => stretchLinear(c, length)),
  };
}

/** Pitch shift at the same length (formant-aware phase vocoder, dsp/shift.ts). */
export function pitchTs(
  pcm: Pcm,
  semitones: number,
  keepFormant: boolean,
): Pcm {
  return mapChannels(pcm, (c) =>
    pitchShift(c, pcm.sampleRate, semitones, keepFormant ? { formant: 0 } : {}),
  );
}

/**
 * Time stretch by `ratio` (duration multiplier) at the same pitch: resample
 * to the new length (which moves pitch by 1/ratio), then shift it back.
 */
export function stretchTs(pcm: Pcm, ratio: number): Pcm {
  const length = Math.max(1, Math.round(frames(pcm) * ratio));
  const semitones = 12 * Math.log2(ratio);
  return mapChannels(pcm, (c) => {
    const resampled = stretchLinear(c, length);
    return Math.abs(semitones) < 1e-6
      ? resampled
      : pitchShift(resampled, pcm.sampleRate, semitones);
  });
}

// ---------------------------------------------------------------- find

/** 10 ms hop features: log RMS and zero-crossing rate (a brightness proxy). */
function features(
  signal: Float32Array,
  sampleRate: number,
): { level: Float64Array; zcr: Float64Array; hop: number } {
  const hop = Math.max(1, Math.round(0.01 * sampleRate));
  const count = Math.floor(signal.length / hop);
  const level = new Float64Array(count);
  const zcr = new Float64Array(count);
  for (let f = 0; f < count; f += 1) {
    let sum = 0;
    let crossings = 0;
    const start = f * hop;
    for (let i = start; i < start + hop; i += 1) {
      const v = signal[i]!;
      sum += v * v;
      if (i > start && signal[i - 1]! < 0 !== v < 0) crossings += 1;
    }
    level[f] = Math.log10(sum / hop + 1e-9);
    zcr[f] = crossings / hop;
  }
  return { level, zcr, hop };
}

function pearson(
  a: Float64Array,
  aStart: number,
  b: Float64Array,
  length: number,
): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < length; i += 1) {
    ma += a[aStart + i]!;
    mb += b[i]!;
  }
  ma /= length;
  mb /= length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[aStart + i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export type Match = Readonly<{ start: number; end: number; score: number }>;

/**
 * Regions of `pcm` that look like `reference` (frames): sliding 10 ms
 * level and brightness envelopes, Pearson-correlated and averaged, top
 * `count` non-overlapping matches above 0.5, best first. Deterministic.
 */
export function findSimilar(pcm: Pcm, reference: Pcm, count = 8): Match[] {
  const sr = pcm.sampleRate;
  const hay = features(mono(pcm), sr);
  const needle = features(mono(reference), sr);
  const length = needle.level.length;
  if (length < 5)
    throw new ChopError("find needs a reference of at least 50 ms");
  const scores: { f: number; score: number }[] = [];
  for (let f = 0; f + length <= hay.level.length; f += 1) {
    const score =
      0.6 * pearson(hay.level, f, needle.level, length) +
      0.4 * pearson(hay.zcr, f, needle.zcr, length);
    scores.push({ f, score });
  }
  scores.sort((a, b) => b.score - a.score || a.f - b.f);
  const picked: Match[] = [];
  for (const { f, score } of scores) {
    if (picked.length >= count || score < 0.5) break;
    const start = f * hay.hop;
    const end = start + length * hay.hop;
    if (picked.every((m) => end <= m.start || start >= m.end))
      picked.push({ start, end, score: Math.round(score * 1000) / 1000 });
  }
  return picked;
}
