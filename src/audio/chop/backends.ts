/**
 * Optional external backends for the chop toolkit. Every argv here is built
 * by dawg from typed, range-checked values and absolute paths dawg resolved;
 * nothing is ever taken from an agent string. Missing tools fall back to
 * the pure TS implementations (`ops.ts`), except decoding non-WAV inputs and
 * converting to flac/mp3, which need ffmpeg and say how to install it.
 */
import type { CommandRunner } from "../../auth/runner.ts";
import { ChopError } from "./pcm.ts";

export const FFMPEG_HINT =
  "install ffmpeg: brew install ffmpeg (macOS) or apt install ffmpeg (Debian/Ubuntu)";
export const RUBBERBAND_HINT =
  "install rubberband for higher quality stretch/pitch: brew install rubberband or apt install rubberband-cli";

export type Backends = Readonly<{ ffmpeg: boolean; rubberband: boolean }>;

export function detectBackends(runner: CommandRunner): Backends {
  return {
    ffmpeg: runner.which("ffmpeg") !== undefined,
    rubberband: runner.which("rubberband") !== undefined,
  };
}

/** Forced first so no option can reach the network or a pipe. */
const FFMPEG_PRELUDE = Object.freeze([
  "-hide_banner",
  "-nostdin",
  "-loglevel",
  "error",
  "-protocol_whitelist",
  "file",
  "-y",
]);

function assertAbsolute(...paths: string[]): void {
  for (const path of paths)
    if (!path.startsWith("/") || path.includes("\0"))
      throw new ChopError("internal: backend paths must be absolute");
}

export function ffmpegConvertArgv(
  input: string,
  output: string,
  options: Readonly<{ format: "wav" | "flac" | "mp3"; sampleRate?: number; channels?: 1 | 2 }>,
): string[] {
  assertAbsolute(input, output);
  const codec =
    options.format === "flac" ? ["-c:a", "flac"] : options.format === "mp3" ? ["-c:a", "libmp3lame", "-q:a", "2"] : ["-c:a", "pcm_s24le"];
  return [
    ...FFMPEG_PRELUDE,
    "-i",
    input,
    "-vn",
    ...(options.sampleRate ? ["-ar", String(Math.round(options.sampleRate))] : []),
    ...(options.channels ? ["-ac", String(options.channels)] : []),
    ...codec,
    "-f",
    options.format,
    output,
  ];
}

/** rubberband CLI: -t time ratio, -p semitones, -F formant, -3 = R3 engine. */
export function rubberbandArgv(
  input: string,
  output: string,
  options: Readonly<{ ratio?: number; semitones?: number; formant?: boolean }>,
): string[] {
  assertAbsolute(input, output);
  const argv = ["-3", "-q"];
  if (options.ratio !== undefined) argv.push("-t", options.ratio.toFixed(6));
  if (options.semitones !== undefined) argv.push("-p", options.semitones.toFixed(4));
  if (options.formant) argv.push("-F");
  argv.push(input, output);
  return argv;
}

export async function runBackend(
  runner: CommandRunner,
  tool: "ffmpeg" | "rubberband",
  argv: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const result = await runner.run(tool, argv, {
    timeoutMs: 5 * 60_000,
    maxOutputBytes: 64 * 1024,
    signal,
  });
  if (result.code !== 0 || result.killed)
    throw new ChopError(
      `${tool} failed (${result.killed ? "stopped" : `exit ${result.code}`}): ${result.stderr.trim().slice(0, 200)}`,
    );
}
