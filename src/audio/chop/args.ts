/**
 * Argument checking shared by the three doors: the agent `audio` tool hands
 * its JSON object here, `dawg media chop` and `/chop` hand parsed words.
 * Unknown keys are refused by name so a typo never silently does nothing.
 */
import { ChopError } from "./pcm.ts";
import {
  CHOP_CURVES,
  CHOP_FILTERS,
  CHOP_FORMATS,
  CHOP_METHODS,
  CHOP_OPS,
  CHOP_SNAPS,
  type ChopArgs,
  type ChopOp,
} from "./types.ts";

type Kind = "path" | "time" | "number" | "bool" | readonly string[] | "paths" | "numbers" | "times" | "reference";

export const CHOP_ARG_KINDS: Readonly<Record<string, Kind>> = Object.freeze({
  input: "path",
  output: "path",
  from: "time",
  to: "time",
  snap: CHOP_SNAPS,
  method: CHOP_METHODS,
  count: "number",
  thresholdDb: "number",
  minMs: "number",
  ratio: "number",
  fromBpm: "number",
  toBpm: "number",
  semitones: "number",
  preserve: ["formant", "none"],
  fadeIn: "time",
  fadeOut: "time",
  curve: CHOP_CURVES,
  targetDb: "number",
  rms: "bool",
  db: "number",
  offset: "time",
  crossfadeMs: "number",
  type: CHOP_FILTERS,
  hz: "number",
  q: "number",
  format: CHOP_FORMATS,
  sampleRate: "number",
  channels: ["1", "2"],
  inputs: "paths",
  gains: "numbers",
  offsets: "times",
  reference: "reference",
  track: "path",
  pattern: "bool",
  sensitivity: "number",
});

function time(value: unknown, key: string): number | string {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && value.length <= 32) return value.trim();
  throw new ChopError(`${key} must be seconds or a time like "1.5s", "350ms", "1:02.5", "bar:9.1", "-2s"`);
}

function path(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || value.includes("\0"))
    throw new ChopError(`${key} must be a project-relative path`);
  return value.trim();
}

export function parseChopOp(value: unknown): ChopOp {
  if (typeof value === "string" && (CHOP_OPS as readonly string[]).includes(value)) return value as ChopOp;
  throw new ChopError(`op must be one of ${CHOP_OPS.join(", ")}`);
}

/** Validate an untyped args object into `ChopArgs` (ranges are checked by runChop). */
export function parseChopArgs(raw: Record<string, unknown>): ChopArgs {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "op" || value === undefined || value === null) continue;
    const kind = CHOP_ARG_KINDS[key];
    if (!kind) throw new ChopError(`unknown argument ${key.slice(0, 32)}`);
    if (Array.isArray(kind)) {
      const text = typeof value === "number" ? String(value) : value;
      if (typeof text !== "string" || !kind.includes(text)) throw new ChopError(`${key} must be one of ${kind.join(", ")}`);
      out[key] = key === "channels" ? Number(text) : text;
      continue;
    }
    switch (kind) {
      case "path":
        out[key] = path(value, key);
        break;
      case "time":
        out[key] = time(value, key);
        break;
      case "number": {
        const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
        if (typeof n !== "number" || !Number.isFinite(n)) throw new ChopError(`${key} must be a number`);
        out[key] = n;
        break;
      }
      case "bool":
        if (typeof value === "boolean") out[key] = value;
        else if (value === "true" || value === "false") out[key] = value === "true";
        else throw new ChopError(`${key} must be true or false`);
        break;
      case "paths":
      case "numbers":
      case "times": {
        if (!Array.isArray(value) || value.length > 16) throw new ChopError(`${key} must be a list of at most 16`);
        out[key] = value.map((item, i) =>
          kind === "paths" ? path(item, `${key}[${i}]`) : kind === "times" ? time(item, `${key}[${i}]`) : numberItem(item, `${key}[${i}]`),
        );
        break;
      }
      case "reference": {
        if (typeof value !== "object" || Array.isArray(value)) throw new ChopError("reference must be {from, to, input?}");
        const ref = value as Record<string, unknown>;
        out[key] = {
          from: time(ref.from, "reference.from"),
          to: time(ref.to, "reference.to"),
          ...(ref.input !== undefined ? { input: path(ref.input, "reference.input") } : {}),
        };
        break;
      }
    }
  }
  return out as ChopArgs;
}

function numberItem(value: unknown, key: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ChopError(`${key} must be a number`);
  return n;
}
