/**
 * Words → chop arguments, shared by `dawg media chop <op> …` and the typed
 * `/chop <op> …`. Positionals follow the op (`cut <file> <from> <to>`,
 * `pitch <file> <semitones>`); every argument also has a flag form,
 * `--kebab-case value` or `key=value`, so the two doors read the same.
 */
import { parseChopArgs, parseChopOp, CHOP_ARG_KINDS } from "./args.ts";
import { ChopError } from "./pcm.ts";
import type { ChopArgs, ChopOp } from "./types.ts";

/** Op → the names its positionals fill after the input file. */
export const CHOP_POSITIONALS: Readonly<Record<ChopOp, readonly string[]>> = Object.freeze({
  info: [],
  peaks: ["count"],
  onsets: [],
  beats: [],
  segments: ["count"],
  find: ["refFrom", "refTo"],
  cut: ["from", "to"],
  slice: ["count"],
  trim: ["from", "to"],
  pad: ["offset"],
  shift: ["offset"],
  loop: ["from", "to"],
  concat: [],
  mix: [],
  stretch: ["ratio"],
  pitch: ["semitones"],
  fade: ["fadeIn", "fadeOut"],
  normalize: ["targetDb"],
  gain: ["db"],
  reverse: [],
  filter: ["type", "hz"],
  convert: ["format"],
  resample: ["sampleRate"],
  split: [],
  audition: ["from", "to"],
});

/** One line per op, for `/chop`, `dawg media chop --help` and the guide. */
export const CHOP_USAGE: Readonly<Record<ChopOp, string>> = Object.freeze({
  info: "info <file>                     length, rate, peak/rms dB, sha256",
  peaks: "peaks <file> [bins]              waveform strip (≤ 200 bins)",
  onsets: "onsets <file>                   hit times",
  beats: "beats <file>                    bpm and beat times",
  segments: "segments <file> [n] --method silence|onset|section|beats|grid",
  find: "find <file> <from> <to>         places that sound like that range",
  cut: "cut <file> <from> <to>          new file, cut at zero crossings",
  slice: "slice <file> [n] --method …     one file per slice [--track id --pattern]",
  trim: "trim <file> [from] [to]         drop silence (or keep a range)",
  pad: "pad <file> <offset>             add silence before (negative drops)",
  shift: "shift <file> <offset>           same as pad",
  loop: "loop <file> <from> <to>         seamless loop with a crossfade",
  concat: "concat <a> <b> …                join files [--crossfade-ms 10]",
  mix: "mix <a> <b> …                   sum files [--gains 0,-6]",
  stretch: "stretch <file> <ratio>          longer (2) or shorter (0.5), pitch kept [--bpm 90:120]",
  pitch: "pitch <file> <semitones>        transpose, length kept [--preserve formant]",
  fade: "fade <file> <in> [out]          fades [--curve linear|exp|log|scurve]",
  normalize: "normalize <file> [dB]            peak to dB (default -1) [--rms true]",
  gain: "gain <file> <dB>                louder or quieter",
  reverse: "reverse <file>                  backwards",
  filter: "filter <file> <type> <hz>       highpass|lowpass|bandpass [--q 0.7]",
  convert: "convert <file> <wav|flac|mp3>   change format (mp3/flac need ffmpeg)",
  resample: "resample <file> <rate>          change sample rate",
  split: "split <file>                    one mono file per channel",
  audition: "audition <file> [from] [to]     play it through the preview player",
});

const FLAG_FOR: ReadonlyMap<string, string> = new Map(
  [...Object.keys(CHOP_ARG_KINDS), "out", "bpm", "refFrom", "refTo"].map((key) => [
    key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
    key,
  ]),
);

const LISTS = new Set(["inputs", "gains", "offsets"]);
const BOOLS = new Set(["pattern", "rms"]);

/**
 * Parse `<op> <file> [positionals] [--flag value | key=value]…`. Returns the
 * op and validated args; `extra` holds options the caller owns (`track`
 * means the sampler track here; the CLI's `--track` folder is taken first).
 */
export function chopFromWords(words: readonly string[]): { op: ChopOp; args: ChopArgs } {
  const [opWord, ...rest] = words;
  const op = parseChopOp(opWord === "play" ? "audition" : opWord);
  const raw: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    let key: string | undefined;
    let value: string | undefined;
    if (word.startsWith("--") && word.length > 2) {
      const eq = word.indexOf("=");
      const name = eq > 0 ? word.slice(2, eq) : word.slice(2);
      key = FLAG_FOR.get(name);
      if (!key) throw new ChopError(`unknown option --${name.slice(0, 32)}`);
      if (eq > 0) value = word.slice(eq + 1);
      else if (BOOLS.has(key) && (rest[i + 1] === undefined || rest[i + 1]!.startsWith("--"))) value = "true";
      else {
        value = rest[i + 1];
        i += 1;
        if (value === undefined) throw new ChopError(`--${name} needs a value`);
      }
    } else if (/^[a-zA-Z]+=/.test(word) && FLAG_FOR.has(word.slice(0, word.indexOf("=")).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))) {
      const eq = word.indexOf("=");
      key = FLAG_FOR.get(word.slice(0, eq).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
      value = word.slice(eq + 1);
    } else {
      positional.push(word);
      continue;
    }
    assign(raw, key!, value!);
  }
  if (op === "concat" || op === "mix") {
    if (positional.length > 0) raw.inputs = positional;
  } else {
    const [input, ...more] = positional;
    if (input !== undefined) raw.input = input;
    const names = CHOP_POSITIONALS[op];
    if (more.length > names.length)
      throw new ChopError(`${op} takes ${names.length ? names.join(", ") : "no values"} after the file; extra "${more[names.length]!.slice(0, 32)}"`);
    more.forEach((word, index) => assign(raw, names[index]!, word));
  }
  if (raw.refFrom !== undefined || raw.refTo !== undefined) {
    raw.reference = { from: raw.refFrom, to: raw.refTo };
    delete raw.refFrom;
    delete raw.refTo;
  }
  return { op, args: parseChopArgs(raw) };
}

function assign(raw: Record<string, unknown>, key: string, value: string): void {
  if (key === "out") raw.output = value;
  else if (key === "bpm") {
    const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) throw new ChopError("--bpm takes from:to, like 90:120");
    raw.fromBpm = Number(match[1]);
    raw.toBpm = Number(match[2]);
  } else if (LISTS.has(key)) raw[key] = value.split(",").map((part) => part.trim()).filter(Boolean);
  else raw[key] = value;
}

/** The help card: every op on one line each. */
export function chopUsage(prefix: string): string {
  return Object.values(CHOP_USAGE)
    .map((line) => `  ${prefix}${line}`)
    .join("\n");
}
