/**
 * `dawg media chop <op> <file> [values] [--flags]`: the chop toolkit from a
 * shell. Same `runChop` as the agent `audio` tool and typed `/chop`. The
 * JSON result goes to stdout, the one-line summary to stderr.
 *
 *   dawg media chop onsets break.wav
 *   dawg media chop cut break.wav 1.2s 3.4s --out samples/hit.wav
 *   dawg media chop pitch vox.wav -3 --preserve formant
 */
import { systemRunner, type CommandRunner } from "../../auth/runner.ts";
import { trackSlug } from "../../media/paths.ts";
import { MediaAbortError } from "../../media/process.ts";
import { errorMessage } from "../../media/vendor/util.ts";
import { runChop } from "./run.ts";
import type { ChopResult } from "./types.ts";
import { chopFromWords, chopUsage } from "./words.ts";

type Output = { write(text: string): unknown };

export const CHOP_HELP = `dawg media chop — inspect and chop audio (guides/chop.md)

${chopUsage("dawg media chop ")}

Times: seconds (1.5), 1.5s, 350ms, 1:02.5, bar:9.1 or beat:32 (with --bpm-of N),
negative counts from the end (-2s). Cuts snap to zero crossings (--snap zero|onset|beat|none).
Outputs: 24-bit WAV with a .json sidecar (sha256, source, op) in tracks/<track>/samples/
(or samples/ without --track); --out PATH picks the file. Never overwrites unless --out names it.
Options: --track <name> folder for downloads/samples (slicing into a sampler track is /chop in dawg) · --json prints only the result.
WAV decodes natively; mp3/m4a/flac need ffmpeg. stretch/pitch use rubberband when installed.`;

export async function runChopCli(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
  options: { runner?: CommandRunner; signal?: AbortSignal } = {},
): Promise<number> {
  const words: string[] = [];
  let folder: string | undefined;
  let json = false;
  let bpm: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i]!;
    if (word === "--help" || word === "-h") {
      stdout.write(`${CHOP_HELP}\n`);
      return 0;
    }
    if (word === "--json") json = true;
    else if (word === "--track") {
      folder = argv[i + 1];
      i += 1;
    } else if (word === "--bpm-of") {
      bpm = Number(argv[i + 1]);
      i += 1;
    } else words.push(word);
  }
  if (words.length === 0) {
    stdout.write(`${CHOP_HELP}\n`);
    return 2;
  }
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new MediaAbortError());
  process.once("SIGINT", onInterrupt);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const { op, args } = chopFromWords(words);
    if (args.pattern)
      throw new Error(
        "--pattern loads slices into a sampler track; that needs a session · use /chop slice … in dawg",
      );
    const result: ChopResult = await runChop(op, args, {
      root: cwd,
      runner: options.runner ?? systemRunner,
      signal,
      actor: { kind: "human" },
      ...(folder
        ? {
            trackSlug: trackSlug(folder),
            outDir: `tracks/${trackSlug(folder)}/samples`,
          }
        : {}),
      ...(bpm && Number.isFinite(bpm)
        ? { tempo: { bpm, beatsPerBar: 4 } }
        : {}),
    });
    if (!json) stderr.write(`✓ ${result.summary}\n`);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (signal.aborted) {
      stderr.write("cancelled\n");
      return 130;
    }
    stderr.write(`✗ ${errorMessage(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}
