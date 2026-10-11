import { describe, expect, test } from "bun:test";
import * as ops from "./ops.ts";
import { frames, makePcm, peak, toDb, type Pcm } from "./pcm.ts";

const SR = 44100;

function clicks(times: readonly number[], length = 4, sr = SR): Pcm {
  const pcm = makePcm(sr, 1, Math.round(length * sr));
  const ch = pcm.channels[0]!;
  for (const t of times) {
    const at = Math.round(t * sr);
    for (let i = 0; i < sr * 0.05 && at + i < ch.length; i += 1)
      ch[at + i] = Math.sin((2 * Math.PI * 330 * i) / sr) * Math.exp(-i / (sr * 0.01)) * 0.9;
  }
  return pcm;
}

function sine(seconds: number, hz = 220, amp = 0.5, channels = 1): Pcm {
  const pcm = makePcm(SR, channels, Math.round(seconds * SR));
  for (const ch of pcm.channels)
    for (let i = 0; i < ch.length; i += 1) ch[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
  return pcm;
}

describe("chop ops are deterministic on synthetic signals", () => {
  test("zero-crossing snap lands on a sign change", () => {
    const signal = sine(1, 97).channels[0]!;
    for (const frame of [1234, 5001, 20000]) {
      const at = ops.snapToZero(signal, frame, SR);
      expect(Math.abs(at - frame)).toBeLessThan(SR * 0.01);
      // The chosen sample sits beside a sign change, on its quieter side.
      const changes = (i: number) => Math.sign(signal[i - 1]!) !== Math.sign(signal[i]!);
      expect(changes(at) || changes(at + 1)).toBe(true);
      expect(Math.abs(signal[at]!)).toBeLessThan(0.01);
    }
  });

  test("onsets land within a few ms of planted clicks", () => {
    const planted = [0.25, 0.75, 1.5, 2.25, 3.1];
    const found = ops.onsets(clicks(planted)).map((f) => f / SR);
    expect(found.length).toBe(planted.length);
    for (const [i, t] of planted.entries()) expect(Math.abs(found[i]! - t)).toBeLessThan(0.012);
  });

  test("beats on a 120 bpm click track read 120 ± 1", () => {
    const times = Array.from({ length: 16 }, (_, i) => i * 0.5);
    const result = ops.beats(clicks(times, 8));
    expect(result).toBeDefined();
    expect(Math.abs(result!.bpm - 120)).toBeLessThanOrEqual(1);
  });

  test("silence segments find planted regions", () => {
    const segments = ops.silenceSegments(clicks([0.5, 1.5, 2.5], 3.5), -40, Math.round(0.02 * SR));
    expect(segments.length).toBe(3);
  });

  test("fades are monotonic and start/end at silence", () => {
    const out = ops.fade(makePcm(SR, 1, SR), SR / 4, SR / 4, "scurve");
    const flat = makePcm(SR, 1, SR);
    flat.channels[0]!.fill(0.5);
    const faded = ops.fade(flat, SR / 4, SR / 4, "exp").channels[0]!;
    expect(faded[0]).toBe(0);
    for (let i = 1; i < SR / 4; i += 1) expect(faded[i]!).toBeGreaterThanOrEqual(faded[i - 1]!);
    for (let i = SR - SR / 4 + 1; i < SR; i += 1) expect(faded[i]!).toBeLessThanOrEqual(faded[i - 1]!);
    expect(frames(out)).toBe(SR);
  });

  test("reverse twice is the identity", () => {
    const pcm = clicks([0.1, 0.3], 0.5);
    const back = ops.reverse(ops.reverse(pcm));
    expect(Array.from(back.channels[0]!)).toEqual(Array.from(pcm.channels[0]!));
  });

  test("gain and normalize set the peak", () => {
    const pcm = sine(0.5, 220, 0.5);
    expect(toDb(peak(ops.gain(pcm, -6)))).toBeCloseTo(toDb(0.5) - 6, 1);
    expect(toDb(peak(ops.normalize(pcm, -1)))).toBeCloseTo(-1, 1);
  });

  test("pad adds exact frames; concat and mix sum lengths", () => {
    const pcm = sine(0.5);
    expect(frames(ops.pad(pcm, 441))).toBe(frames(pcm) + 441);
    expect(frames(ops.concat([pcm, pcm]))).toBe(frames(pcm) * 2);
    expect(frames(ops.mix([pcm, sine(0.25)]))).toBe(frames(pcm));
  });

  test("split gives one mono file per channel", () => {
    const parts = ops.split(sine(0.2, 220, 0.5, 2));
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.channels.length === 1)).toBe(true);
  });

  test("lowpass removes most of a high tone", () => {
    const high = sine(0.5, 8000);
    expect(peak(ops.filter(high, "lowpass", 300))).toBeLessThan(0.05);
  });

  test("loop seam ends near where it starts", () => {
    const looped = ops.loopSeam(sine(1, 113), Math.round(0.02 * SR)).channels[0]!;
    expect(Math.abs(looped[looped.length - 1]! - looped[0]!)).toBeLessThan(0.05);
  });

  test("peak strip stays small and has an ASCII form", () => {
    const bins = ops.peakBins(clicks([0.5, 1]), 200);
    expect(bins.length).toBe(200);
    expect(ops.peakStrip(bins).length).toBeLessThan(2048);
    expect(/^[\x20-\x7e]*$/.test(ops.peakStrip(bins, true))).toBe(true);
  });

  test("find locates a planted repeat", () => {
    const pcm = makePcm(SR, 1, SR * 4);
    const motif = sine(0.3, 440, 0.6).channels[0]!;
    for (let i = 0; i < motif.length; i += 1) {
      pcm.channels[0]![Math.round(0.5 * SR) + i] = motif[i]! * Math.exp(-i / 5000);
      pcm.channels[0]![Math.round(2.7 * SR) + i] = motif[i]! * Math.exp(-i / 5000);
    }
    const reference = { ...pcm, channels: [pcm.channels[0]!.slice(Math.round(0.5 * SR), Math.round(0.8 * SR))] };
    const matches = ops.findSimilar(pcm, reference, 4);
    expect(matches.some((m) => Math.abs(m.start / SR - 2.7) < 0.03)).toBe(true);
  });

  test("a 10-minute file is analysed past 240 s", () => {
    const sr = 8000;
    const times = Array.from({ length: 20 }, (_, i) => 30 * i + 1);
    const found = ops.onsets(clicks(times, 600, sr)).map((f) => f / sr);
    expect(found.some((t) => t > 500)).toBe(true);
  });

  test("TS stretch and pitch keep or change length as promised", () => {
    const pcm = sine(0.5);
    expect(Math.abs(frames(ops.stretchTs(pcm, 2)) - frames(pcm) * 2)).toBeLessThan(SR * 0.02);
    expect(Math.abs(frames(ops.pitchTs(pcm, 3, false)) - frames(pcm))).toBeLessThan(SR * 0.02);
  });
});
