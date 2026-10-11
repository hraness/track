/**
 * The chop toolkit's audio buffer: planar float channels at one rate.
 * Decodes any WAV natively (other formats through ffmpeg, when present) and
 * writes 24-bit PCM WAV, temp-then-rename, so every op is deterministic and
 * an interrupted write never leaves half a file.
 */
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "../../auth/runner.ts";
import { parseWav } from "../../media/vendor/wav.ts";

export type Pcm = Readonly<{
  sampleRate: number;
  /** One Float32Array per channel, all the same length. */
  channels: readonly Float32Array[];
}>;

/** Largest input read whole (matches the media tools). */
export const MAX_INPUT_BYTES = 512 * 1024 * 1024;
/** Hard cap on analysed or edited audio (30 minutes). */
export const MAX_SECONDS = 30 * 60;

export class ChopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChopError";
  }
}

export function frames(pcm: Pcm): number {
  return pcm.channels[0]?.length ?? 0;
}

export function seconds(pcm: Pcm): number {
  return frames(pcm) / pcm.sampleRate;
}

/** Sum to mono (mean of channels). */
export function mono(pcm: Pcm): Float32Array {
  const n = frames(pcm);
  if (pcm.channels.length === 1) return pcm.channels[0]!;
  const out = new Float32Array(n);
  const scale = 1 / pcm.channels.length;
  for (const channel of pcm.channels)
    for (let i = 0; i < n; i += 1) out[i]! += channel[i]! * scale;
  return out;
}

export function makePcm(
  sampleRate: number,
  channelCount: number,
  length: number,
): Pcm {
  return {
    sampleRate,
    channels: Array.from(
      { length: channelCount },
      () => new Float32Array(length),
    ),
  };
}

export function mapChannels(
  pcm: Pcm,
  fn: (channel: Float32Array, index: number) => Float32Array,
): Pcm {
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map(fn) };
}

export function slicePcm(pcm: Pcm, start: number, end: number): Pcm {
  const a = Math.max(0, Math.min(frames(pcm), Math.round(start)));
  const b = Math.max(a, Math.min(frames(pcm), Math.round(end)));
  return mapChannels(pcm, (channel) => channel.slice(a, b));
}

export function peak(pcm: Pcm): number {
  let max = 0;
  for (const channel of pcm.channels)
    for (let i = 0; i < channel.length; i += 1) {
      const v = Math.abs(channel[i]!);
      if (v > max) max = v;
    }
  return max;
}

export function rms(pcm: Pcm): number {
  let sum = 0;
  let count = 0;
  for (const channel of pcm.channels) {
    for (let i = 0; i < channel.length; i += 1) sum += channel[i]! ** 2;
    count += channel.length;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/** Linear amplitude in dBFS, rounded to 0.1, floor -120. */
export function toDb(linear: number): number {
  if (!(linear > 0)) return -120;
  return Math.max(-120, Math.round(20 * Math.log10(linear) * 10) / 10);
}

export function fromDb(db: number): number {
  return 10 ** (db / 20);
}

/** Decode a WAV byte buffer. */
export function decodeWavBytes(bytes: Uint8Array): Pcm {
  const wav = parseWav(bytes, {
    maximumBytes: MAX_INPUT_BYTES,
    maximumDurationSeconds: MAX_SECONDS,
  });
  const channels: Float32Array[] = [];
  for (let c = 0; c < wav.channels; c += 1) {
    const out = new Float32Array(wav.sampleCount);
    for (let i = 0; i < wav.sampleCount; i += 1) out[i] = wav.sample(i, c);
    channels.push(out);
  }
  return { sampleRate: wav.sampleRate, channels };
}

function isRiff(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  );
}

/**
 * Read any audio file: WAV natively, anything else through ffmpeg (decoded
 * to float WAV at its own rate). Without ffmpeg a non-WAV input is an error
 * naming the install command; dawg never installs it.
 */
export async function readAudio(
  path: string,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<Pcm> {
  const file = Bun.file(path);
  if (file.size > MAX_INPUT_BYTES)
    throw new ChopError(
      `${path} is over the ${MAX_INPUT_BYTES / 1024 / 1024} MiB input cap`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isRiff(bytes)) return decodeWavBytes(bytes);
  if (!runner.which("ffmpeg"))
    throw new ChopError(
      "only WAV decodes without ffmpeg · install it with: brew install ffmpeg (macOS) or apt install ffmpeg",
    );
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "dawg-chop-"));
  try {
    const out = join(dir, "decoded.wav");
    const result = await runner.run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-y",
        "-i",
        path,
        "-vn",
        "-t",
        String(MAX_SECONDS),
        "-c:a",
        "pcm_f32le",
        out,
      ],
      {
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 64 * 1024,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.code !== 0)
      throw new ChopError(
        `ffmpeg could not decode ${path}: ${result.stderr.trim().slice(0, 200)}`,
      );
    return decodeWavBytes(new Uint8Array(await Bun.file(out).arrayBuffer()));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 24-bit PCM WAV bytes; samples are clipped to [-1, 1]. Deterministic. */
export function encodeWav24(pcm: Pcm): Uint8Array {
  const n = frames(pcm);
  const ch = Math.max(1, pcm.channels.length);
  const dataBytes = n * ch * 3;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1)
      bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * ch * 3, true);
  view.setUint16(32, ch * 3, true);
  view.setUint16(34, 24, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < ch; c += 1) {
      const v = pcm.channels[c]?.[i] ?? 0;
      const clipped = v > 1 ? 1 : v < -1 ? -1 : Number.isFinite(v) ? v : 0;
      let s = Math.round(clipped * 8_388_607);
      if (s < 0) s += 0x1000000;
      bytes[offset] = s & 0xff;
      bytes[offset + 1] = (s >> 8) & 0xff;
      bytes[offset + 2] = (s >> 16) & 0xff;
      offset += 3;
    }
  }
  return bytes;
}

/** Write `pcm` to `path` atomically (temp file then rename). */
export async function writeAudio(path: string, pcm: Pcm): Promise<void> {
  const temp = `${path}.part-${process.pid}`;
  try {
    await Bun.write(temp, encodeWav24(pcm));
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
