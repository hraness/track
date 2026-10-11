/**
 * Audition: a file (or a range of it) as the preview player's PCM, at the
 * engine's rate, at most 30 s. Used by the agent `audio` tool's `audition`
 * and typed `/chop play`.
 */
import type { CommandRunner } from "../../auth/runner.ts";
import type { RenderedAudio } from "../wav.ts";
import { resample } from "./ops.ts";
import { frames, readAudio, slicePcm } from "./pcm.ts";

export const AUDITION_MAX_SECONDS = 30;

export async function auditionPcm(
  path: string,
  runner: CommandRunner,
  sampleRate: number,
  from?: number,
  to?: number,
  signal?: AbortSignal,
): Promise<RenderedAudio> {
  const pcm = await readAudio(path, runner, signal);
  const sr = pcm.sampleRate;
  const a = Math.max(0, Math.min(frames(pcm), Math.round((from ?? 0) * sr)));
  const end = to === undefined ? frames(pcm) : Math.round(to * sr);
  const b = Math.max(
    a,
    Math.min(frames(pcm), end, a + sr * AUDITION_MAX_SECONDS),
  );
  const clip = resample(slicePcm(pcm, a, b), sampleRate);
  const n = frames(clip);
  const left = clip.channels[0]!;
  const right = clip.channels[1] ?? left;
  const out = new Int16Array(n * 2);
  const q = (v: number) =>
    Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i += 1) {
    out[i * 2] = q(left[i]!);
    out[i * 2 + 1] = q(right[i]!);
  }
  return { sampleRate, channels: 2, frames: n, pcm: out };
}
