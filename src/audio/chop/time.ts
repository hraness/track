/**
 * Time specs every chop op accepts: seconds as a number or "1.25s",
 * milliseconds "350ms", clock "1:23.5", musical "bar:9.1" (bar 9 beat 1,
 * both 1-based) or "beat:32" (32 beats in), "end", and a leading "-" that
 * counts back from the end ("-2s"). Bars and beats need the project tempo.
 */
import { ChopError } from "./pcm.ts";

export type TimeSpec = number | string;

export type Tempo = Readonly<{ bpm: number; beatsPerBar: number }>;

/** Seconds for `spec` in a file `total` seconds long, clamped to [0, total]. */
export function parseTime(
  spec: TimeSpec,
  total: number,
  tempo?: Tempo,
): number {
  const value = rawTime(spec, total, tempo);
  if (!Number.isFinite(value)) throw new ChopError(`bad time ${String(spec)}`);
  return Math.max(0, Math.min(total, value));
}

function rawTime(spec: TimeSpec, total: number, tempo?: Tempo): number {
  if (typeof spec === "number") return spec < 0 ? total + spec : spec;
  const text = spec.trim().toLowerCase();
  if (text === "end") return total;
  if (text === "start") return 0;
  if (text.startsWith("-")) return total - rawTime(text.slice(1), total, tempo);
  const musical = /^(bar|beat):(\d+(?:\.\d+)?)(?:\.(\d+(?:\.\d+)?))?$/.exec(
    text,
  );
  if (musical) {
    if (!tempo)
      throw new ChopError(
        `${spec} needs a tempo · pass bpm (CLI --bpm, tool tempo) or run inside a project`,
      );
    const beat = 60 / tempo.bpm;
    if (musical[1] === "beat") return Number(musical[2]) * beat;
    // bar:9.1 → bar 9 beat 1; bar:9 → bar 9 beat 1; bar:9.2.5 not allowed.
    const [barText, beatText] = musical[2]!.includes(".")
      ? musical[2]!.split(".")
      : [musical[2]!, musical[3] ?? "1"];
    const bar = Number(barText);
    const inBar = Number(beatText ?? "1");
    if (bar < 1 || inBar < 1) throw new ChopError(`${spec}: bars and beats count from 1`);
    return ((bar - 1) * tempo.beatsPerBar + (inBar - 1)) * beat;
  }
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(text);
  if (ms) return Number(ms[1]) / 1000;
  const s = /^(\d+(?:\.\d+)?)s?$/.exec(text);
  if (s) return Number(s[1]);
  const clock = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  throw new ChopError(
    `bad time "${spec}" · use 1.5, 1.5s, 350ms, 1:23.5, bar:9.1, beat:32, end or -2s`,
  );
}

/** "1.234s" with ms precision, for summaries. */
export function fmtSeconds(value: number): string {
  return `${Math.round(value * 1000) / 1000}s`;
}
