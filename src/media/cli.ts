/**
 * `dawg media <verb>`: the same six tools from the shell, plus `doctor`.
 *
 *   dawg media doctor
 *   dawg media download <youtube-url> [--name <slug>] [--track <name>]
 *   dawg media stems <file>
 *   dawg media analyze <file>
 *   dawg media notes <file> [--kind drums|bass|vocals|guitar|piano|other] [--from s] [--to s]
 *   dawg media sample <file> <name> [--begin 0..1] [--end 0..1] [--root C4]
 *   dawg media wavetable <file> <name> [--frames 64] [--start s] [--end s] [--method auto|slice|spectral] [--smooth 0..1]
                                         2048-sample frames → tracks/<slug>/wavetables/<name>.wav
  dawg media lyrics <file> [--lang en]
 *   dawg media chop <op> <file> [values] [--flags]   (see CHOP_USAGE)
 *
 * Progress goes to stderr, the JSON result to stdout. Ctrl-C sends SIGTERM to
 * the helper (SIGKILL after 15 s) and exits 130.
 */
import { systemRunner, type CommandRunner } from "../auth/runner.ts";
import { doctor, formatDoctor } from "./backend.ts";
import { analysisCacheStatus, analysisDoctorLine } from "../audio/analysis.ts";
import { trackSlug } from "./paths.ts";
import { MediaAbortError } from "./process.ts";
import { findMediaTool } from "./registry.ts";
import type { MediaHost, MediaResult } from "./types.ts";
import { errorMessage } from "./vendor/util.ts";
import { runChopCli } from "../audio/chop/cli.ts";

export type Output = { write(text: string): unknown };

export const MEDIA_HELP = `dawg media — local media tools (see DAWG.md "Media tools")

  dawg media doctor                      backend + binaries + install commands + analysis cache
  dawg media download <url> [--name n]   YouTube audio → tracks/<slug>/downloads/<n>.wav
  dawg media stems <file>                six stems → <file>.stems/
  dawg media analyze <file>              tempo, key, beat grid, peaks → <file>.analysis.json
  dawg media notes <file> [--kind k] [--from s] [--to s]
                                         notes/hits + quantized snippet → <file>.<kind>.notes.json
  dawg media sample <file> <name> [--begin f] [--end f] [--root C4]
                                         48 kHz wav → tracks/<slug>/samples/<name>.wav + sampler snippet
  dawg media wavetable <file> <name> [--frames 64] [--start s] [--end s] [--method auto|slice|spectral] [--smooth 0..1]
                                         2048-sample frames → tracks/<slug>/wavetables/<name>.wav
  dawg media lyrics <file> [--lang en]   whisper transcript → <file>.lyrics.json/.txt
  dawg media chop <op> <file> …          inspect and chop audio (dawg media chop --help)

Options: --track <name> picks the track folder (default main); --json prints only the result.
Env: DAWG_STEMDECK_URL (default http://127.0.0.1:8000).`;

const VERBS: Record<string, { tool: string; positional: string[] }> = {
  download: { tool: "download_audio", positional: ["url"] },
  stems: { tool: "split_stems", positional: ["file"] },
  analyze: { tool: "analyze_audio", positional: ["file"] },
  notes: { tool: "transcribe_notes", positional: ["file"] },
  sample: { tool: "import_sample", positional: ["file", "name"] },
  lyrics: { tool: "transcribe_lyrics", positional: ["file"] },
  wavetable: { tool: "make_wavetable", positional: ["file", "name"] },
};

const NUMERIC = new Set([
  "from",
  "to",
  "begin",
  "end",
  "frames",
  "start",
  "smooth",
]);

export function parseMediaArgv(argv: readonly string[]): {
  verb: string | undefined;
  args: Record<string, unknown>;
  track: string;
  json: boolean;
  help: boolean;
} {
  // `dawg media --help` (or `-h`): a leading help flag is not a verb.
  if (argv[0] === "--help" || argv[0] === "-h")
    return {
      verb: undefined,
      args: {},
      track: "main",
      json: false,
      help: true,
    };
  const [verb, ...rest] = argv;
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  let track = "main";
  let json = false;
  let help = false;
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (item === "--help" || item === "-h") help = true;
    else if (item === "--json") json = true;
    else if (item.startsWith("--")) {
      const key = item.slice(2);
      const value = rest[index + 1];
      if (value === undefined) throw new Error(`--${key} needs a value`);
      index += 1;
      if (key === "track") track = value;
      else if (NUMERIC.has(key)) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed))
          throw new Error(`--${key} must be a number`);
        args[key] = parsed;
      } else args[key] = value;
    } else positional.push(item);
  }
  const spec = verb ? VERBS[verb] : undefined;
  if (spec) {
    spec.positional.forEach((name, index) => {
      if (positional[index] !== undefined) args[name] = positional[index];
    });
    if (positional.length > spec.positional.length)
      throw new Error(
        `unexpected argument ${positional[spec.positional.length]}`,
      );
  }
  return { verb, args, track, json, help };
}

export async function runMediaCommand(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
  options: {
    runner?: CommandRunner;
    fetch?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  if (argv[1] === "chop")
    return runChopCli(argv.slice(2), cwd, stdout, stderr, options);
  let parsed: ReturnType<typeof parseMediaArgv>;
  try {
    parsed = parseMediaArgv(argv.slice(1));
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n${MEDIA_HELP}\n`);
    return 2;
  }
  if (parsed.help || parsed.verb === undefined) {
    stdout.write(`${MEDIA_HELP}\n`);
    return parsed.verb === undefined && !parsed.help ? 2 : 0;
  }
  const host: MediaHost = {
    projectRoot: cwd,
    trackSlug: trackSlug(parsed.track),
    runner: options.runner ?? systemRunner,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    env: process.env,
  };
  if (parsed.verb === "doctor") {
    const report = await doctor({
      ...host,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const analysis = await analysisCacheStatus(cwd);
    if (parsed.json)
      stdout.write(
        `${JSON.stringify({ ...report, analysisCache: analysis }, null, 2)}\n`,
      );
    else
      stdout.write(
        `${[...formatDoctor(report), await analysisDoctorLine(cwd)].join("\n")}\n`,
      );
    return 0;
  }
  const spec = VERBS[parsed.verb];
  const tool = spec ? findMediaTool(spec.tool) : undefined;
  if (!spec || !tool) {
    stderr.write(`unknown media command ${parsed.verb}\n${MEDIA_HELP}\n`);
    return 2;
  }
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new MediaAbortError());
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const plan = tool.plan(parsed.args, undefined as never);
    if (plan.kind !== "media") throw new Error("not a media tool");
    let lastLine = "";
    const result: MediaResult = await plan.run({
      ...host,
      signal,
      progress: (line) => {
        if (line === lastLine || parsed.json) return;
        lastLine = line;
        stderr.write(`· ${line}\n`);
      },
    });
    if (!parsed.json) stderr.write(`✓ ${result.summary}\n`);
    stdout.write(`${JSON.stringify(result.content, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (signal.aborted || error instanceof MediaAbortError) {
      stderr.write("cancelled\n");
      return 130;
    }
    stderr.write(`✗ ${errorMessage(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}
