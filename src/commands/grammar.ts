/**
 * The one command grammar (design §3): `[/]verb [noun|target] [args]`, where
 * the slash is optional, synonyms map to the canonical word, and every noun
 * answers `remove|rm|delete` and `list|presets|ls` the same way.
 *
 * The parsers keep their own spellings; this module rewrites a line that no
 * parser took into the spellings they do take (`recover`), so a line that
 * works today runs exactly as before and only a line that failed gets a
 * second reading. `commandParses` (src/commands/parses.ts) and the prompt bar
 * (src/main.ts submit) share it, so an alias that runs also counts as a
 * command for typo fixes, show-me and the agent's command mode.
 */

import { HELP_SECTIONS, USAGE } from "./help.ts";
import { nearest } from "./nearest.ts";
import { parseTuningCommand } from "./tuning.ts";

/** Words that remove a thing: `section rm verse` ≡ `section remove verse`. */
export const REMOVE_WORDS: readonly string[] = ["remove", "rm", "delete"];
/** Words that list a noun's presets: `fx ls` ≡ `fx list` ≡ `fx`. */
export const LIST_WORDS: readonly string[] = ["list", "presets", "ls"];

/** `/formant 3` → `formant 3`; `formant 3` → `/formant 3`. */
export function toggleSlash(line: string): string {
  const text = line.trim();
  return text.startsWith("/") ? text.slice(1) : `/${text}`;
}

/** One leading `/` removed (only one: `//x` stays a slash word). */
export function stripSlash(line: string): string {
  const text = line.trim();
  return text.startsWith("/") ? text.slice(1) : text;
}

/** The first word, slash and case folded (`/FX` → `fx`). */
export function verbOf(line: string): string {
  return stripSlash(line).split(/\s+/)[0]?.toLowerCase() ?? "";
}

/**
 * Canonical forms that are new names for old grammar, rewritten to the
 * spelling the parser takes. Each entry maps a bare line to its rewrite, or
 * undefined when the entry does not apply. Canonical first, old alias kept:
 * `groove house` runs the parser's `/pattern house`.
 */
const REWRITES: readonly ((words: readonly string[]) => string | undefined)[] =
  [
    // key ≡ scale for showing and listing (`key A minor` already parses).
    (w) =>
      w[0] === "key" &&
      (w.length === 1 || (w.length === 2 && LIST_WORDS.includes(w[1]!)))
        ? w.length === 1
          ? "scale"
          : "scale list"
        : undefined,
    // key <mode> keeps the tonic (`key dorian`, `key hijaz`), as scale does.
    (w) => {
      if (w[0] !== "key" || w.length < 2) return undefined;
      const scale = ["scale", ...w.slice(1)].join(" ");
      const parsed = parseTuningCommand(scale);
      return parsed?.type === "scale-set" && parsed.scale !== undefined
        ? scale
        : undefined;
    },
    // chords idiom <name> ≡ chords style <name>.
    (w) =>
      w[0] === "chords" && w[1] === "idiom"
        ? ["chords", "style", ...w.slice(2)].join(" ")
        : undefined,
    // synth filter <hz> ≡ synth lpf <hz> (also lowpass, cutoff).
    (w) =>
      w[0] === "synth" && /^(filter|lowpass|cutoff)$/.test(w[1] ?? "")
        ? ["synth", "lpf", ...w.slice(2)].join(" ")
        : undefined,
    // fx filter cutoff <hz> ≡ fx filter lpf <hz>; fx lowpass ≡ fx filter.
    (w) =>
      w[0] === "fx" && w[1] === "filter" && w[2] === "cutoff"
        ? ["fx", "filter", "lpf", ...w.slice(3)].join(" ")
        : w[0] === "fx" && w[1] === "lowpass"
          ? ["fx", "filter", ...w.slice(2)].join(" ")
          : undefined,
    // lowpass <hz> ≡ filter <hz>.
    (w) =>
      w[0] === "lowpass" ? ["filter", ...w.slice(1)].join(" ") : undefined,
    // genre <id> ≡ style <id>.
    (w) =>
      w[0] === "genre" || w[0] === "genres"
        ? ["style", ...w.slice(1)].join(" ")
        : undefined,
    // bpm <n> ≡ tempo <n> (bare `/bpm` stays a sample's own tempo).
    (w) =>
      w[0] === "bpm" && w.length === 2 && /^\d+(\.\d+)?$/.test(w[1]!)
        ? `tempo ${w[1]}`
        : undefined,
    // render|bounce|wav <file>.wav [stems] ≡ export <file>.wav [stems].
    (w) =>
      /^(render|bounce|wav)$/.test(w[0] ?? "") &&
      /\.wav$/i.test(w[1] ?? "") &&
      (w.length === 2 || (w.length === 3 && w[2] === "stems"))
        ? ["export", ...w.slice(1)].join(" ")
        : undefined,
    // remove|rm|delete note <id> ≡ remove <id>.
    (w) =>
      REMOVE_WORDS.includes(w[0] ?? "") && w[1] === "note" && w.length === 3
        ? `remove ${w[2]}`
        : undefined,
    // rm <id> ≡ remove <id>.
    (w) =>
      w[0] === "rm" && w.length >= 2
        ? ["remove", ...w.slice(1)].join(" ")
        : undefined,
  ];

/**
 * Verbs whose slash and bare spellings are different commands: bare `play`
 * is the transport, `/play` is play mode. The grammar never swaps them.
 */
export const DISTINCT_SLASH: ReadonlySet<string> = new Set(["play", "c"]);

/**
 * Every other reading of `line`, most likely first: the canonical rewrite,
 * the other slash spelling, and the remove and list word swaps, each with
 * and without the slash. The line itself is not included.
 */
export function candidates(line: string): string[] {
  const text = line.trim().replace(/\s+/g, " ");
  if (!text || text.length > 1_024) return [];
  const bare = stripSlash(text);
  if (!bare || bare.startsWith("/")) return [];
  // `play` and `/play` are two commands (transport vs play mode).
  if (DISTINCT_SLASH.has(verbOf(text))) return [];
  const words = bare.split(" ");
  const lower = words.map((word) => word.toLowerCase());
  const out: string[] = [];
  const push = (candidate: string | undefined): void => {
    if (candidate === undefined) return;
    for (const form of [candidate, toggleSlash(candidate)])
      if (form !== text && !out.includes(form)) out.push(form);
  };
  for (const rewrite of REWRITES) push(rewrite(lower));
  push(bare);
  // remove|rm|delete in the first three words: try each spelling.
  for (let index = 0; index < Math.min(3, words.length); index += 1) {
    if (!REMOVE_WORDS.includes(lower[index]!)) continue;
    for (const word of REMOVE_WORDS)
      if (word !== lower[index])
        push(
          [...words.slice(0, index), word, ...words.slice(index + 1)].join(" "),
        );
  }
  // <noun> list|presets|ls, or bare <noun>: try every listing spelling.
  const last = lower.at(-1)!;
  if (words.length >= 2 && LIST_WORDS.includes(last)) {
    const head = words.slice(0, -1);
    push(head.join(" "));
    for (const word of LIST_WORDS)
      if (word !== last) push([...head, word].join(" "));
  } else if (words.length === 1)
    for (const word of LIST_WORDS) push(`${words[0]} ${word}`);
  return out;
}

/** The first reading of `line` that `accepts`, or undefined. */
export function recover(
  line: string,
  accepts: (candidate: string) => boolean,
): string | undefined {
  return candidates(line).find(accepts);
}

// ---------------------------------------------------------------------------
// Export and loop: forms the prompt bar runs itself

export type ExportCommand = Readonly<{
  path: string;
  format: "json" | "mid" | "wav";
  stems: boolean;
}>;

export const EXPORT_USAGE =
  "export <file>.track.json|.mid|.wav [stems] · export song.wav · export mix.wav stems";

/**
 * `export song.wav`, `export song.wav stems`, `export loop.track.json`,
 * `export song.mid` (slash optional). Stems are a WAV per track.
 */
export function parseExportCommand(line: string): ExportCommand | undefined {
  const match = line.trim().match(/^\/?export\s+(\S+)(?:\s+(stems))?\s*$/i);
  if (!match) return undefined;
  const path = match[1]!;
  // `export list` is a listing spelling, never a file named `list`.
  if (LIST_WORDS.includes(path.toLowerCase())) return undefined;
  const format = /\.wav$/i.test(path)
    ? "wav"
    : /\.midi?$/i.test(path)
      ? "mid"
      : "json";
  const stems = match[2] !== undefined;
  if (stems && format !== "wav") return undefined;
  return { path, format, stems };
}

/**
 * Whether the agent may write `path`: relative, inside the workspace, with
 * no `..` segment and no home or drive prefix.
 */
export function workspaceRelative(path: string): boolean {
  if (!path || path.length > 256) return false;
  if (/^([/\\~]|[a-z]:)/i.test(path)) return false;
  return !path.split(/[/\\]/).some((segment) => segment === "..");
}

export type LoopCommand =
  | Readonly<{ type: "loop-off" }>
  | Readonly<{ type: "loop-bars"; from: number; to: number }>
  | Readonly<{ type: "loop-section"; name: string }>
  | Readonly<{ type: "loop-show" }>;

export const LOOP_USAGE =
  "loop <a>-<b> | <section> | next | prev | off · loop 1-4 · loop chorus · loop next · loop off";

/**
 * `loop 1-4` (bars, 1-based inclusive), `loop 1 4`, `loop chorus`, `loop
 * off`, bare `loop` (what loops now). Slash optional.
 */
export function parseLoopCommand(line: string): LoopCommand | undefined {
  const words = stripSlash(line).trim().split(/\s+/);
  if (words[0]?.toLowerCase() !== "loop") return undefined;
  const rest = words.slice(1);
  if (rest.length === 0) return { type: "loop-show" };
  if (rest.length === 1 && /^(off|none|song)$/i.test(rest[0]!))
    return { type: "loop-off" };
  const range = rest
    .join(" ")
    .match(/^(\d{1,4})\s*(?:-|\.\.|–|\s)\s*(\d{1,4})$/u);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return from >= 1 && to >= from
      ? { type: "loop-bars", from, to }
      : undefined;
  }
  if (rest.length === 1 && /^\d{1,4}$/.test(rest[0]!)) {
    const bar = Number(rest[0]);
    return bar >= 1 ? { type: "loop-bars", from: bar, to: bar } : undefined;
  }
  const name = rest.join(" ");
  return /^[\p{L}\p{N}][\p{L}\p{N} _\x27.-]{0,31}$/u.test(name)
    ? { type: "loop-section", name }
    : undefined;
}

/** `track remove|rm|delete <name>` and `track move <name> <n>`. */
export function parseTrackEdit(
  line: string,
): Readonly<{ verb: "rm" | "move"; rest: string }> | undefined {
  const match = line
    .trim()
    .match(/^\/?track\s+(rm|remove|delete|move)\s+(.{1,64}?)\s*$/i);
  if (!match) return undefined;
  return {
    verb: match[1]!.toLowerCase() === "move" ? "move" : "rm",
    rest: match[2]!,
  };
}

// ---------------------------------------------------------------------------
// Window verbs and the agent boundary

/**
 * Window verbs whose argument is free text: bare they print this hint and do
 * nothing, so `rename` alone (or a sentence starting with it, offline) never
 * renames or forks a session by accident.
 */
export const FREE_TEXT_HINTS: Readonly<Record<string, string>> = {
  rename: "rename · /rename <name> names this session · /rename --auto",
  fork: "fork · /fork [<name>] copies this session",
  resume: "resume · /resume [<n>|<name>] · /sessions lists them",
  login:
    "model key · model key [gateway|openrouter|codex|claude] adds an agent", // login is an alias
};

/**
 * Words people reach for that dawg keeps elsewhere: the hint names where,
 * so `swing` never reads as a typo of `sing`.
 */
export const ELSEWHERE_HINTS: Readonly<Record<string, string>> = {
  swing: "swing lives on a rhythm row · euclid hat swing 0.1 · help rhythm",
};

/** The hint for a line whose verb dawg keeps elsewhere, if any. */
export function elsewhereHint(line: string): string | undefined {
  const verb = verbOf(line);
  return Object.prototype.hasOwnProperty.call(ELSEWHERE_HINTS, verb)
    ? ELSEWHERE_HINTS[verb]
    : undefined;
}

/**
 * Window verbs that run the same with or without the slash. The prompt bar
 * retries the other spelling of these when the typed one is not handled.
 */
export const WINDOW_VERBS: ReadonlySet<string> = new Set([
  "help",
  "guide",
  "guides",
  "menu",
  "tracks",
  "track",
  "undo",
  "redo",
  "export",
  "import",
  "status",
  "theme",
  "motion",
  "showme",
  "audio",
  "model",
  "sessions",
  "logout",
  "auth",
  "quit",
  "exit",
  "view",
  "transcript",
  "log",
  "click",
  "count-in",
  "grid",
  "try",
  "sample",
  "samples",
  "len",
  "fitmode",
  "euclid",
  "tape",
  "patch",
  "style",
  "styles",
  "calibration",
]);

/** `✗ no agent · …`: what prose gets when no provider is signed in. */
export const NO_AGENT = "no agent · try style deep-house · model key adds one";

/**
 * Command words that are also everyday English: a sentence starting with
 * one (`add a walking bass`, `build tension`) is a request for the agent.
 * Every other known verb is grammar only and never reaches the agent.
 */
export const EVERYDAY_VERBS: ReadonlySet<string> = new Set([
  "add",
  "put",
  "move",
  "make",
  "build",
  "drop",
  "fill",
  "form",
  "play",
  "remove",
  "delete",
  "clear",
  "extend",
  "length",
  "try",
  "help",
  "sing",
  "pan",
  "track",
  "chords",
  "key",
  "scale",
  "style",
  "view",
  "log",
  "bend",
  "glide",
  "fade",
  "shift",
  "loop",
  "groove",
  "hit",
  "export",
  "import",
  "rename",
  "fork",
  "resume",
  "login", // alias of model key
]);

/**
 * `✗ <line> · did you mean <x>? · <usage>`: one card for a known verb whose
 * arguments did not parse, the same for slash and bare input, in the order
 * what failed · nearest match · where to look.
 */
export function usageCard(line: string, usage: string, near?: string): string {
  return near
    ? `${line} · did you mean ${near}? · ${usage}`
    : `${line} · ${usage}`;
}

// ---------------------------------------------------------------------------
// One vocabulary matcher, one error template

export { nearest } from "./nearest.ts";

/** Every verb help and the usage table know, bare (`fx`, `tempo`, …). */
export function knownVerbs(): ReadonlySet<string> {
  knownCache ??= new Set(
    [
      ...HELP_SECTIONS.flatMap((section) =>
        section.group === "keys"
          ? []
          : section.entries.map((entry) => entry.command.split(/[\s|[]/)[0]!),
      ),
      ...Object.keys(USAGE),
      ...Object.values(USAGE).map((usage) => usage.split(/[\s|[]/)[0]!),
      ...WINDOW_VERBS,
      "groove",
      "rig",
      "loop",
      "export",
      "remove",
      "rm",
      "delete",
    ]
      .map((verb) => verb.replace(/^\//, "").toLowerCase())
      .filter((verb) => /^[a-z][\w-]*$/.test(verb)),
  );
  return knownCache;
}
let knownCache: Set<string> | undefined;

/** A value's allowed range, unit and a working example. */
export type ValueRange = Readonly<{
  command: string;
  min: number;
  max: number;
  unit: string;
  example: string;
}>;

/**
 * Range tables for the values people type, keyed by command word, with the
 * core schema keys they guard (`tempoBpm`) mapped to the same rows, so a
 * core message never reaches a card raw.
 */
export const RANGES: Readonly<Record<string, ValueRange>> = Object.freeze({
  tempo: {
    command: "tempo",
    min: 20,
    max: 300,
    unit: "BPM",
    example: "tempo 128",
  },
  bars: { command: "bars", min: 1, max: 256, unit: "bars", example: "bars 8" },
  meter: {
    command: "meter",
    min: 1,
    max: 16,
    unit: "beats per bar",
    example: "meter 3",
  },
  volume: {
    command: "volume",
    min: 0,
    max: 1,
    unit: "",
    example: "volume 0.8",
  },
  pan: { command: "pan", min: -1, max: 1, unit: "", example: "pan -0.3" },
});

/** Core schema keys and the command row that explains each. */
const CORE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  tempoBpm: "tempo",
  bars: "bars",
  beatsPerBar: "meter",
  "track volume": "volume",
  "track pan": "pan",
});

/**
 * `✗ tempo 900 · tempo takes 20…300 BPM · tempo 128`: the one template for
 * a value out of range (the `✗` is the card's marker).
 */
export function usageError(input: string, range: ValueRange): string {
  const unit = range.unit ? ` ${range.unit}` : "";
  return `${clip(input)} · ${range.command} takes ${range.min}…${range.max}${unit} · ${range.example}`;
}

/**
 * A core validation message rewritten in the template, or undefined when it
 * names no known key: `tempoBpm must be between 20 and 300` after `tempo
 * 900` reads `tempo 900 · tempo takes 20…300 BPM · tempo 128`.
 */
export function friendlyCoreError(
  input: string,
  message: string,
): string | undefined {
  for (const [key, command] of Object.entries(CORE_KEYS)) {
    if (!message.startsWith(`${key} must be`)) continue;
    const range = RANGES[command];
    if (range) return usageError(input, range);
  }
  return undefined;
}

/** `usage · <cmd> <args>`: the one usage line. */
export function usageLine(usage: string): string {
  return `usage · ${usage.replace(/^usage\s*·?\s*/i, "")}`;
}

/** `no track <id> · tracks lists them`: the one missing-track line. */
export function noTrack(id: string): string {
  return `no track ${clip(id)} · tracks lists them`;
}

/** `no note <id> · notes lists them`: the one missing-note line. */
export function noNote(id: string): string {
  return `no note ${clip(id)} · notes lists them`;
}

function clip(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 32 ? `${line.slice(0, 31)}…` : line;
}

// ---------------------------------------------------------------------------
// Canonical rewrites the prompt bar applies before anything else

/**
 * Canonical forms that name window commands: `model key [provider]` is the
 * agent-key command (`login` stays an alias), `models` is `model`, and
 * `voice` opens the Voice help topic. Undefined when `line` is none.
 */
export function canonicalWindowForm(line: string): string | undefined {
  const text = line.trim().replace(/\s+/g, " ");
  const key = text.match(/^\/?models?\s+key(?:\s+(.*))?$/i);
  if (key) return `/login${key[1] ? ` ${key[1]}` : ""}`; // login: the alias it runs
  const models = text.match(/^\/?models(\s+\S+)?$/i);
  if (models) return `/model${models[1] ?? ""}`;
  if (/^\/?voice$/i.test(text)) return "/help voice";
  return undefined;
}

/**
 * `exported · mix.wav · 2 stems mix-lead.wav mix-bass.wav`: the stems
 * receipt names every file it wrote, counted in the right number.
 */
export function stemsReceipt(path: string, stems: readonly string[]): string {
  const base = (file: string) => file.split(/[\\/]/).at(-1) ?? file;
  if (stems.length === 0)
    return `exported · ${path} · no audible tracks for stems`;
  const count = `${stems.length} stem${stems.length === 1 ? "" : "s"}`;
  const names = stems.slice(0, 3).map(base);
  if (stems.length > 3) names.push(`+${stems.length - 3}`);
  return `exported · ${path} · ${count} ${names.join(" ")}`;
}
