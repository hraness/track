/**
 * Shared helpers for the consistency suites (test/consistency.test.ts,
 * test/four-ways.test.ts, test/glossary-lint.test.ts): what the prompt bar
 * runs locally, a walk of the ctrl-k tree, and the user-facing text files.
 *
 * "Accepted" means the prompt bar runs the line itself, with no model call:
 * one of the music parsers (`commandParses`), the style and calibration
 * parsers, or one of the window commands `submit` (src/main.ts), the TUI
 * (`tui/app.ts` `command`) and the session commands match. The window
 * patterns are read from the source, so a new window command is covered
 * without editing this file.
 */
import { knobPageId } from "../src/tui/knob-map.ts";
import { parseAudioCommand } from "../src/audio/devices.ts";
import { parsePaneArgs } from "../src/launch-args.ts";
import { WINDOW_VERBS, canonicalWindowForm } from "../src/commands/grammar.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createScore, type TrackScore } from "../core/score.ts";
import { DRUM_VOICES } from "../core/drums.ts";
import { listGuides } from "../guides/index.ts";
import { parseShowMe } from "../src/agent/show-me.ts";
import { parseAgentSettingsCommand } from "../src/commands/agent-settings.ts";
import { resolveModelChoice } from "../src/agent/models.ts";
import { parseClickArgument } from "../src/audio/click.ts";
import { tuiLoginArgs } from "../src/auth/tui.ts";
import { parseCalibrationCommand } from "../src/commands/calibration.ts";
import { parseEffectName } from "../src/commands/fx.ts";
import { helpTopicLines } from "../src/commands/help.ts";
import { commandParses } from "../src/commands/parses.ts";
import { parseStyleCommand } from "../src/commands/style.ts";
import { isStageable } from "../src/tui/audition.ts";
import {
  applyChordsCommand,
  defaultChordSettings,
} from "../src/tui/play-chords.ts";
import { GRIDS } from "../src/tui/play-session.ts";
import { GuideBrowser } from "../tui/guide.ts";
import { parseThemeName } from "../tui/theme.ts";
import {
  EditMenu,
  MENU_SECTIONS,
  type MenuContext,
  type MenuNode,
  rootNodes,
} from "../src/tui/menu.ts";

export const ROOT = resolve(import.meta.dir, "..");

export function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** The body of the first top-level function in `source` named `name`. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`missing ${header}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end);
}

/** Every `/^\/…/flags` literal in `body`, as a RegExp. */
function slashPatterns(body: string): RegExp[] {
  const literal = /\/\^\\\/(?:[^/\\\n]|\\.)*\/[a-z]*/g;
  return [...body.matchAll(literal)].map((match) => {
    const text = match[0];
    const close = text.lastIndexOf("/");
    return new RegExp(text.slice(1, close), text.slice(close + 1));
  });
}

let windowCache: RegExp[] | undefined;

/** The window-command patterns `submit`, the TUI and sessions match. */
export function windowPatterns(): RegExp[] {
  if (windowCache) return windowCache;
  const main = read("src/main.ts");
  const app = read("tui/app.ts");
  windowCache = [
    ...slashPatterns(functionBody(main, "async function submit(")),
    ...slashPatterns(functionBody(main, "async function sessionCommand(")),
    ...slashPatterns(functionBody(main, "function paneCommand(")),
    ...slashPatterns(functionBody(app, "  command(text: string)")),
  ].filter(
    // Guards that hand the line on (`/instrument\s`, `/model\b`, a
    // lookahead) are not commands; `/login\b` and `/logout|auth` are.
    (pattern) =>
      pattern.source.endsWith("$") ||
      /^\^\\\/\(?(?:login|logout)/.test(pattern.source),
  );
  return windowCache;
}

/** The verb a window command starts with: `/show-me on` → `showme`. */
function windowVerb(command: string): string {
  const word = command.replace(/^\//, "").split(/\s+/)[0]!.toLowerCase();
  return word.replace(/-/g, "");
}

type ArgCheck = (arg: string, score: TrackScore) => boolean;

const helpTopic: ArgCheck = (arg) => helpTopicLines(arg) !== undefined;
const guideTopic: ArgCheck = (arg) => new GuideBrowser(listGuides()).open(arg);
const onOff: ArgCheck = (arg) => /^(on|off)$/i.test(arg);

/**
 * What each window verb with a free argument does with it, mirrored from
 * its handler: `/menu <section>` must name a section, `/help <topic>` a
 * topic, `/model <alias>` a catalog model, and so on. A verb whose pattern
 * takes free text and is in neither this table nor FREE_TEXT is refused
 * with an argument, so a new window command cannot pass laxly.
 */
const WINDOW_ARGS: Readonly<Record<string, ArgCheck>> = {
  help: helpTopic,
  "?": helpTopic,
  guide: guideTopic,
  pane: (arg) => parsePaneArgs(arg.split(/\s+/)).ok,
  guides: guideTopic,
  menu: (arg) =>
    (MENU_SECTIONS as readonly string[]).includes(arg.toLowerCase()),
  showme: (arg) => parseShowMe(arg) !== undefined,
  agent: (arg) => parseAgentSettingsCommand(arg) !== undefined,
  audio: (arg) => parseAudioCommand(arg) !== undefined,
  click: (arg) =>
    !("error" in parseClickArgument(arg, { on: false, volume: 0.5 })),
  chords: (arg) => applyChordsCommand(defaultChordSettings(), arg).ok,
  euclid: (arg) =>
    DRUM_VOICES.some((voice) => voice.voice === arg.toLowerCase()),
  try: (arg, score) =>
    /^agent\s+(on|off)$/i.test(arg) ||
    (isStageable(arg) && accepts(arg, score)),
  model: (arg) =>
    resolveModelChoice("gateway", arg) !== undefined ||
    resolveModelChoice("openrouter", arg) !== undefined,
  theme: (arg) => parseThemeName(arg) !== undefined,
  view: (arg) => /^(all|focus)$/i.test(arg),
  motion: onOff,
  grid: (arg) => GRIDS.some((grid) => grid.label === arg.toUpperCase()),
  volume: () => false,
  pan: () => false,
  fx: (arg) => parseEffectName(arg.split(/\s+/)[0]!) !== undefined,
  login: (arg) => typeof tuiLoginArgs(`/login ${arg}`) !== "string",
  sessions: () => false,
  knobs: (arg, score) => knobPageId(arg, score.tracks[0]) !== undefined,
};

/** Verbs whose argument is a name or a path the person picks. */
const FREE_TEXT = new Set([
  "track",
  "add",
  "export",
  "import",
  "rename",
  "fork",
  "resume",
]);

/** The argument text after the verb (`fx reverb mix` → `reverb mix`). */
function windowArg(command: string): string {
  return command.replace(/^\/?\S+\s*/, "").trim();
}

/** True when a window command's pattern matches and its argument is real. */
function windowAccepts(command: string, score: TrackScore): boolean {
  const verb = windowVerb(command);
  const arg = windowArg(command);
  for (const pattern of windowPatterns()) {
    if (!pattern.test(command)) continue;
    if (!arg) return true;
    const check = WINDOW_ARGS[verb];
    if (check) {
      if (check(arg, score)) return true;
      continue;
    }
    if (FREE_TEXT.has(verb)) return true;
    // A pattern that spells out its arguments (`(on|off)`, `([0-2])`)
    // already checked them; one that takes any text did not.
    if (!/\.\+|\.\*|\\S\+/.test(pattern.source)) return true;
  }
  return false;
}

/** True when the prompt bar runs `line` locally (no model call). */
export function accepts(
  line: string,
  score: TrackScore = demoScore(),
): boolean {
  const command = line.trim();
  if (!command) return false;
  // `model key`, `models`, `voice`: the window runs their canonical form.
  const canonical = canonicalWindowForm(command);
  if (canonical) return accepts(canonical, score);
  if (commandParses(command, score)) return true;
  if (parseStyleCommand(command)) return true;
  if (parseCalibrationCommand(command)) return true;
  if (windowAccepts(command, score)) return true;
  // The prompt bar's second reading: a bare window verb (`status`,
  // `guide voice`) runs as its slash form (main.ts SLASH_HANDLED).
  const verb = command.split(/\s+/)[0]!.toLowerCase();
  return (
    !command.startsWith("/") &&
    (WINDOW_VERBS.has(verb) || verb === "chords") &&
    windowAccepts(`/${command}`, score)
  );
}

/**
 * A song with one track of each instrument the tree walk covers: the menu
 * builds different rows for each (synth params, piano pedals, drum lanes,
 * organ registers, the singing voice, the string engine, a sampler voice).
 */
export function demoScore(): TrackScore {
  return createScore({
    tempoBpm: 120,
    bars: 8,
    sections: [
      { name: "verse", startBar: 0, bars: 4 },
      { name: "chorus", startBar: 4, bars: 4 },
    ],
    tracks: [
      { id: "saw", name: "saw", instrument: "saw" },
      { id: "piano", name: "piano", instrument: "piano" },
      { id: "drums", name: "drums", instrument: "kit" },
      { id: "organ", name: "organ", instrument: "organ" },
      { id: "voice", name: "voice", instrument: "sing" },
      { id: "strings", name: "strings", instrument: "string" },
      {
        id: "vox",
        name: "vox",
        instrument: "sampler",
        sampler: {
          mode: "oneshot",
          voices: { take: { src: "tracks/vox/samples/take.wav" } },
        },
      },
    ],
    notes: [
      {
        id: "n1",
        trackId: "saw",
        pitch: 60,
        startTick: 0,
        durationTicks: 480,
        velocity: 0.8,
      },
      {
        id: "n2",
        trackId: "drums",
        pitch: 36,
        startTick: 0,
        durationTicks: 120,
        velocity: 0.8,
      },
    ],
  } as Parameters<typeof createScore>[0]);
}

export const WALK_TRACKS = [
  "saw",
  "piano",
  "drums",
  "organ",
  "voice",
  "strings",
  "vox",
];

export function menuContext(
  trackId: string,
  score: TrackScore = demoScore(),
): MenuContext {
  return {
    score,
    trackId,
    playing: false,
    grid: "1/16",
    grids: ["1/4", "1/8", "1/16"],
    clickOn: false,
    countInBars: 1,
    showMe: "on",
    // Device rows run `/audio out <name>`: names with spaces must parse.
    audio: {
      output: "default (Built-in Output)",
      input: "USB Audio Interface",
      outputs: ["Built-in Output", "USB Audio Interface"],
      inputs: ["Built-in Microphone", "USB Audio Interface"],
    },
  };
}

export type WalkedNode = Readonly<{ path: string[]; node: MenuNode }>;

/**
 * Every node of the ctrl-k tree for `context`, depth first, with its label
 * path from the root. Branch ids repeat at most `maxRepeat` times on one
 * path, so self-referencing menus end.
 */
export function walkMenu(context: MenuContext, maxDepth = 8): WalkedNode[] {
  const out: WalkedNode[] = [];
  const visit = (nodes: readonly MenuNode[], path: string[], ids: string[]) => {
    if (path.length > maxDepth) return;
    for (const node of nodes) {
      const here = [...path, node.label];
      out.push({ path: here, node });
      if (node.kind !== "menu") continue;
      if (ids.includes(node.id)) continue;
      let children: MenuNode[] = [];
      try {
        children = node.build(context);
      } catch (error) {
        throw new Error(`${here.join(" › ")}: ${String(error)}`);
      }
      visit(children, here, [...ids, node.id]);
    }
  };
  visit(rootNodes(context), [], []);
  return out;
}

/** The commands a node can run: every action, toggle state, choice and value. */
export function nodeCommands(node: MenuNode): string[] {
  switch (node.kind) {
    case "action":
      return [node.command];
    case "toggle":
      return [node.command(true), node.command(false)];
    case "choice":
      return node.options.map((option) => node.command(option));
    case "number": {
      const values = [node.min, node.max, node.value ?? node.start ?? node.min];
      return [
        ...values.map((value) => node.command(value)),
        ...(node.reset ? [node.reset] : []),
      ];
    }
    case "entry":
      return [node.example];
    default:
      return [];
  }
}

/** Every tree walk over the instruments the suite covers. */
export function walkAll(): { track: string; walked: WalkedNode[] }[] {
  const score = demoScore();
  return WALK_TRACKS.map((track) => ({
    track,
    walked: walkMenu(menuContext(track, score)),
  }));
}

export { EditMenu };

/** Guides and their bodies. */
export function guideFiles(): { path: string; text: string }[] {
  return readdirSync(join(ROOT, "guides"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ path: `guides/${name}`, text: read(`guides/${name}`) }));
}

/**
 * Every `Ctrl-K › A › B` path in `text`, as label segments. A path ends at
 * the first backtick, bracket, colon, period, middle dot or line end.
 */
export function menuPathsIn(text: string): string[][] {
  const out: string[][] = [];
  for (const match of text.matchAll(
    /ctrl-k((?: › [^`()\[\]:.,"·|\n/$]+)+)/gi,
  )) {
    const segments = match[1]!
      .split(" › ")
      .map((segment) => segment.replace(/\*\*/g, "").trim())
      .filter(Boolean)
      .map((segment) =>
        segment.split(/ (?:as|and|shows|lists|for) /)[0]!.trim(),
      );
    if (segments.length > 0) out.push(segments);
  }
  return out;
}

const norm = (text: string) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * How well a menu row answers to `segment`: 3 for its label or id, 2 for a
 * label that starts with it, 1 for a label that has it as a word, 0 none.
 */
function rowScore(node: MenuNode, segment: string): number {
  const want = norm(segment);
  const label = norm(node.label);
  const id = "id" in node && typeof node.id === "string" ? norm(node.id) : "";
  if (label === want || id === want) return 3;
  if (label.startsWith(`${want} `)) return 2;
  return label.split(" ").includes(want) ? 1 : 0;
}

/** The row that best answers to `segment`, first wins a tie. */
function bestRow(
  nodes: readonly MenuNode[],
  segment: string,
): MenuNode | undefined {
  let best: MenuNode | undefined;
  let score = 0;
  for (const node of nodes) {
    const here = rowScore(node, segment);
    if (here > score) [best, score] = [node, here];
  }
  return best;
}

/**
 * The node a label path reaches from the root, in any walked instrument's
 * tree; undefined when no tree has it.
 */
export function resolveMenuPath(
  segments: readonly string[],
): { track: string; node: MenuNode } | undefined {
  const score = demoScore();
  for (const track of WALK_TRACKS) {
    const context = menuContext(track, score);
    let nodes: readonly MenuNode[] = rootNodes(context);
    let found: MenuNode | undefined;
    for (const segment of segments) {
      found = bestRow(nodes, segment);
      if (!found) break;
      nodes = found.kind === "menu" ? found.build(context) : [];
    }
    if (found) return { track, node: found };
  }
  return undefined;
}

/** The ten topic ids (design §4): one id, three doors. */
export const TOPIC_IDS = [
  "sound",
  "voice",
  "effects",
  "rhythm",
  "chords",
  "mix",
  "arrange",
  "project",
  "keys",
  "agent",
] as const;
