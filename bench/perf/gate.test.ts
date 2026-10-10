/**
 * CI perf gates: the felt costs this lane cut, held against regressions.
 * Each budget is a ratio to the calibration loop (stats.ts), so a slow
 * shared runner scales its own budget, and each sits at about 3x what a
 * 2026 laptop measures, so only a real regression (an allocation or a
 * de-optimised loop on a hot path) trips it. docs/perf.md has the numbers.
 */
import { expect, test } from "bun:test";
import { createScore } from "../../core/score.ts";
import { LiveSynth, warmLive } from "../../src/audio/live.ts";
import { renderScorePcm } from "../../src/audio/wav.ts";
import { LIVE_CASES } from "./live.ts";
import { patchRunner } from "./patch-runner.ts";
import { RENDER_CASES } from "./render.ts";
import { calibrate } from "./stats.ts";

const BARS = 8;

/** Best of `runs` renders of `name` at `rate`, in ms per bar. */
function renderPerBar(name: string, rate: number, runs = 2): number {
  const score = RENDER_CASES[name]!();
  renderScorePcm(score, { sampleRate: rate });
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    renderScorePcm(score, { sampleRate: rate });
    best = Math.min(best, (performance.now() - started) / BARS);
  }
  return best;
}

// Calibrated budgets, in calibration-loop units (about 1.9 ms on an M-series
// laptop): ms/bar for renders, ms for a key.
// Each sits near 3x today and below the pre-lane cost, so losing a fix trips it.
const RENDER_BUDGET: Readonly<Record<string, number>> = {
  vocoder: 90, // ~57 ms/bar (30 units) at 48 kHz; 209 before
  "sing-choir": 50, // ~31 ms/bar (16 units); 77 before
  "cellos-section": 80, // ~49 ms/bar (26 units); 73 before
  "reverb-hall": 22, // ~13 ms/bar (7 units); 50 before
  psola: 18, // ~12 ms/bar (6 units); 38 before
};

for (const [name, budget] of Object.entries(RENDER_BUDGET))
  test(`perf gate: ${name} renders a 48 kHz bar within ${budget} calibration units`, () => {
    const unit = calibrate();
    const perBar = renderPerBar(name, 48_000);
    expect(perBar / unit).toBeLessThan(budget);
  }, 60_000);

test("perf gate: the first choir key after the play-mode warm renders within 30 calibration units", () => {
  const score = createScore({
    tempoBpm: 120,
    bars: 2,
    tracks: [{ id: "t", name: "t", ...LIVE_CASES["sing-choir"] }],
    notes: [],
  } as never);
  warmLive(score, "t", 44_100);
  const unit = calibrate();
  const synth = new LiveSynth(44_100);
  const started = performance.now();
  synth.render({ score, trackId: "t", pitch: 62, velocity: 0.8, seconds: 0.5 });
  // ~16 ms (8 units) warm; ~65 ms (34 units) without the warm.
  expect((performance.now() - started) / unit).toBeLessThan(30);
}, 60_000);

test("perf gate: the patch runner plays a voice-sample within 19 calibration units (ns per ms of calibration)", () => {
  // 16 voices x 12 nodes (bench/perf/patch-runner.ts): about 7.4 units on
  // a 2026 arm64 laptop and 16.3 on the x64 CI runner with the fused voice
  // block (the first fused block: 9.4 and 20.8; the reference interpreter
  // about 15.3 on the laptop; the prototype in patch-kernel.ts about 7).
  // A per-sample allocation or closure trips it.
  const unit = calibrate();
  const ns = Math.min(...patchRunner(3));
  console.log(`patch runner: ${(ns / unit).toFixed(2)} units`);
  expect(ns / unit).toBeLessThan(19);
}, 60_000);

test("perf gate: the fused voice block runs within 0.68x of the reference interpreter", () => {
  // Same process, same patch, so machine speed cancels: about 0.46 on a
  // 2026 arm64 laptop and 0.62 on the x64 CI runner (the first fused
  // block: 0.60 and 0.69). Losing the loop fusion, the inlined kernels or
  // the register-held intermediates (fuse.ts, kernels.ts) puts it near 1.
  const fused = Math.min(...patchRunner(3));
  const interp = Math.min(...patchRunner(3, false));
  console.log(`patch runner: fused/interpreter ${(fused / interp).toFixed(3)}`);
  expect(fused / interp).toBeLessThan(0.68);
}, 60_000);
