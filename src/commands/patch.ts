/**
 * `patch` commands (patcher design §6.1): the typed door to the focused
 * track's instrument patch, or with `--fx <name>` one of its effect patches.
 *
 *   patch new <name> [instrument|effect] [from <patch|engine>] [voices=n] [at=post]
 *   patch add <type> [as <id>] [k=v …] [label "…"]   patch add svf as vcf mode=lp cutoff=800
 *   patch set <id> k=v … [label "…"]                 patch set vcf q=0.6
 *   patch wire <node.port> <node.port> [amount]      patch wire lfo1.out vcf.cutoff 0.4
 *   patch unwire <node.port> <node.port>
 *   patch macro <id> <node.port>[:min..max] … [range a..b] [default x] [curve exp] [label "…"]
 *   patch knob <macro> <value>                       sets a macro's value (a knob)
 *   patch rate <id> global|voice                     forces a node to run once per track
 *   patch mod <macro|node.port> <pattern>            (refuses: typed patterns need a parser; SDK mods: work)
 *   patch rm <id>                                    a node (and its cables) or a macro
 *   patch convert                                    the instrument, wrapped as a patch
 *   patch detach                                     a shared library patch, copied into the track
 *   patch load <name>                                a project, user or built-in patch
 *   patch save <name> [--user|--project]
 *   patch show [<name>]                              a recipe of these lines (read-only)
 *   patch nodes [family]                             the node library (read-only)
 *
 * Bare `patch`, `patch off` and `patch --fx <name>` open and close the patch
 * view (a window command), so they are not parsed here. Every mutating
 * command is one revision: the window diffs it into node, cable and macro
 * operations (core/diff.ts), never a whole-patch write over an existing one.
 */
import { compilePatch } from "../audio/patch/compile.ts";
import { resolveInstrumentWord } from "../../core/instruments.ts";
import {
  PATCH_INSTRUMENT,
  convertToPatch,
  findCycles,
  inferRates,
  isPatchRef,
  newCableId,
  newNodeId,
  compareCables,
  patchFromTrack,
  patchSpecs,
  splitPort,
  type Cable,
  type Macro,
  type MacroTarget,
  type Patch,
  type PatchEdit,
  type PatchNode,
  type PatchParamValue,
  type PatchRole,
  type TrackPatchValue,
} from "../../core/patch.ts";
import {
  BOUNDARY_SPECS,
  NODE_SPECS,
  NODE_TYPES,
  nodeSpec,
  type NodeSpec,
} from "../../core/patch-nodes.ts";
import { BUILTIN_PATCHES, builtinPatch } from "../../core/patches/index.ts";
import { FxValidationError } from "../../core/params.ts";
import {
  ScoreValidationError,
  TrackScore,
  editPatch,
  patchContext,
  setPatch,
  updateTrack,
  type PatchTarget,
} from "../../core/score.ts";
import { nearest } from "./nearest.ts";

export type PatchParams = Readonly<Record<string, PatchParamValue>>;

export type PatchCommand = Readonly<
  (
    | {
        type: "patch-new";
        name: string;
        role?: PatchRole;
        from?: string;
        voices?: number;
        at?: "post";
      }
    | {
        type: "patch-add";
        nodeType: string;
        id?: string;
        params: PatchParams;
        label?: string;
      }
    | { type: "patch-set"; id: string; params: PatchParams; label?: string }
    | { type: "patch-wire"; from: string; to: string; amount?: number }
    | { type: "patch-unwire"; a: string; b: string }
    | {
        type: "patch-macro";
        id: string;
        targets: readonly MacroTarget[];
        min?: number;
        max?: number;
        default?: number;
        curve?: "lin" | "exp";
        label?: string;
      }
    | { type: "patch-knob"; macro: string; value: number }
    | { type: "patch-rate"; id: string; rate: "global" | "voice" }
    | { type: "patch-mod"; target: string; pattern: string }
    | { type: "patch-rm"; id: string }
    | { type: "patch-convert" }
    | { type: "patch-detach" }
    | { type: "patch-load"; source: string }
    | { type: "patch-save"; name: string; scope: "project" | "user" }
    | { type: "patch-show"; name?: string }
    | { type: "patch-nodes"; family?: string }
  ) & { fx?: string }
>;

/** The verbs, in /help order (the four-doors table walks these). */
export const PATCH_VERBS = [
  "new",
  "add",
  "set",
  "wire",
  "unwire",
  "macro",
  "knob",
  "rate",
  "mod",
  "rm",
  "convert",
  "detach",
  "load",
  "save",
  "show",
  "nodes",
] as const;

/** Read-only verbs: safe for show-me, they never write a revision. */
export const PATCH_READ_ONLY: readonly string[] = ["show", "nodes"];

export const PATCH_USAGE: Readonly<Record<string, string>> = {
  new: "patch new <name> [instrument|effect] [from <patch|engine>]",
  add: "patch add <type> [as <id>] [k=v …] [label “…”]",
  set: "patch set <id> k=v … [label “…”]",
  wire: "patch wire <node.port> <node.port> [amount]",
  unwire: "patch unwire <node.port> <node.port>",
  macro:
    "patch macro <id> <node.port>[:min..max] … [range a..b] [default x] [curve exp] [label “…”]",
  knob: "patch knob <macro> <value>",
  rate: "patch rate <id> global|voice",
  mod: "patch mod <macro|node.port> <pattern>",
  rm: "patch rm <node|macro>",
  convert: "patch convert",
  detach: "patch detach",
  load: "patch load <name>",
  save: "patch save <name> [--user|--project]",
  show: "patch show [<name>]",
  nodes: "patch nodes [family]",
};

const ID = /^[a-z][a-z0-9-]*$/;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

/** Splits on spaces, keeping "quoted text" and {json} / [json] whole. */
export function patchTokens(text: string): string[] | undefined {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  let quote = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) current += text[++i]!;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"' || ch === "“" || ch === "”") {
      quote = true;
      started = true;
      current += '"';
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (depth < 0) return undefined;
    if (/\s/.test(ch) && depth === 0) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote || depth !== 0) return undefined;
  if (started) out.push(current);
  // Close a typographic quote as a plain one.
  return out.map((token) => token.replace(/”/g, '"'));
}

function unquote(token: string): string | undefined {
  if (!token.startsWith('"') || !token.endsWith('"') || token.length < 2)
    return undefined;
  try {
    const value: unknown = JSON.parse(token);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One `k=v` value: a number, on/off, a JSON object, a quoted or bare word. */
export function parsePatchValue(raw: string): PatchParamValue | undefined {
  if (raw.length === 0) return undefined;
  if (NUMBER.test(raw)) return Number(raw);
  if (raw === "true" || raw === "on") return true;
  if (raw === "false" || raw === "off") return false;
  if (raw.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(raw);
      return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith('"')) return unquote(raw);
  return /^[a-z0-9._:#+-]+$/i.test(raw) ? raw : undefined;
}

type Read = PatchCommand | { error: string };

function usage(verb: string): { error: string } {
  return { error: `usage: ${PATCH_USAGE[verb] ?? "patch <verb> …"}` };
}

/** `k=v …` and an optional `label "…"`, or an error. */
function readParams(
  words: readonly string[],
  verb: string,
): { params: PatchParams; label?: string } | { error: string } {
  const params: Record<string, PatchParamValue> = {};
  let label: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "label") {
      const text =
        words[i + 1] === undefined
          ? undefined
          : (unquote(words[i + 1]!) ?? words[i + 1]);
      if (text === undefined)
        return { error: `patch ${verb}: label needs text` };
      label = text;
      i++;
      continue;
    }
    const eq = word.indexOf("=");
    if (eq <= 0) return { error: `patch ${verb}: expected k=v, got "${word}"` };
    const key = word.slice(0, eq);
    const value = parsePatchValue(word.slice(eq + 1));
    if (value === undefined)
      return {
        error: `patch ${verb}: cannot read ${key}=${word.slice(eq + 1)}`,
      };
    params[key] = value;
  }
  return label === undefined ? { params } : { params, label };
}

function portWord(word: string | undefined): string | undefined {
  return word !== undefined && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/i.test(word)
    ? word
    : undefined;
}

/** `node.port[:min..max]` */
function readTarget(word: string): MacroTarget | undefined {
  const match = word.match(
    /^([a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*?)(?::([-+]?[\d.e]+)\.\.([-+]?[\d.e]+))?$/i,
  );
  if (!match) return undefined;
  const port = match[1]! as MacroTarget["port"];
  if (match[2] === undefined) return { port };
  const min = Number(match[2]);
  const max = Number(match[3]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  return { port, min, max };
}

function readRange(word: string | undefined): [number, number] | undefined {
  const match = word?.match(/^([-+]?[\d.e]+)\.\.([-+]?[\d.e]+)$/i);
  if (!match) return undefined;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : undefined;
}

function readCommand(prompt: string): Read | undefined {
  const tokens = patchTokens(prompt.trim().replace(/^\//, ""));
  if (!tokens || tokens[0]?.toLowerCase() !== "patch") return undefined;
  let words = tokens.slice(1);
  let fx: string | undefined;
  const flag = words.indexOf("--fx");
  if (flag >= 0) {
    fx = words[flag + 1];
    if (fx === undefined || !NAME.test(fx))
      return { error: "patch: --fx needs the name of an effect patch" };
    words = [...words.slice(0, flag), ...words.slice(flag + 2)];
  }
  // Bare `patch`, `patch off`, `patch --fx n`: the patch view's window command.
  if (words.length === 0 || (words.length === 1 && words[0] === "off"))
    return undefined;
  const verb = words[0]!.toLowerCase();
  const rest = words.slice(1);
  const withFx = (command: PatchCommand): PatchCommand =>
    fx === undefined ? command : { ...command, fx };
  switch (verb) {
    case "new": {
      const name = rest[0];
      if (!name || !NAME.test(name)) return usage(verb);
      let role: PatchRole | undefined;
      let from: string | undefined;
      let voices: number | undefined;
      let at: "post" | undefined;
      for (let i = 1; i < rest.length; i++) {
        const word = rest[i]!;
        if (word === "instrument" || word === "effect") role = word;
        else if (word === "from" && rest[i + 1]) from = rest[++i];
        else if (/^voices=\d+$/.test(word)) voices = Number(word.slice(7));
        else if (word === "at=post") at = "post";
        else return usage(verb);
      }
      return withFx({
        type: "patch-new",
        name,
        ...(role ? { role } : {}),
        ...(from ? { from } : {}),
        ...(voices !== undefined ? { voices } : {}),
        ...(at ? { at } : {}),
      });
    }
    case "add": {
      const nodeType = rest[0];
      if (!nodeType || !/^[a-z][a-z0-9.-]*$/i.test(nodeType))
        return usage(verb);
      let id: string | undefined;
      let tail = rest.slice(1);
      if (tail[0] === "as") {
        id = tail[1];
        if (!id || !ID.test(id))
          return { error: "patch add: an id is [a-z][a-z0-9-]* (as vcf)" };
        tail = tail.slice(2);
      }
      const read = readParams(tail, verb);
      if ("error" in read) return read;
      return withFx({
        type: "patch-add",
        nodeType: nodeType.toLowerCase(),
        ...(id ? { id } : {}),
        ...read,
      });
    }
    case "set": {
      const id = rest[0];
      if (!id || !ID.test(id) || rest.length < 2) return usage(verb);
      const read = readParams(rest.slice(1), verb);
      if ("error" in read) return read;
      return withFx({ type: "patch-set", id, ...read });
    }
    case "wire": {
      const from = portWord(rest[0]);
      const to = portWord(rest[1]);
      if (!from || !to || rest.length > 3) return usage(verb);
      if (rest[2] === undefined)
        return withFx({ type: "patch-wire", from, to });
      const amount = NUMBER.test(rest[2]) ? Number(rest[2]) : Number.NaN;
      if (!(amount >= -1 && amount <= 1))
        return { error: "patch wire: the amount is -1..1 (0.4 is 40 %)" };
      return withFx({ type: "patch-wire", from, to, amount });
    }
    case "unwire": {
      const [a, b] = rest;
      if (!a || !b || rest.length !== 2) return usage(verb);
      return withFx({ type: "patch-unwire", a, b });
    }
    case "macro": {
      const id = rest[0];
      if (!id || !ID.test(id)) return usage(verb);
      const targets: MacroTarget[] = [];
      let min: number | undefined;
      let max: number | undefined;
      let fallback: number | undefined;
      let curve: "lin" | "exp" | undefined;
      let label: string | undefined;
      for (let i = 1; i < rest.length; i++) {
        const word = rest[i]!;
        if (word === "range") {
          const range = readRange(rest[++i]);
          if (!range) return { error: "patch macro: range a..b (range 0..1)" };
          [min, max] = range;
        } else if (word === "default") {
          const value = rest[++i];
          if (value === undefined || !NUMBER.test(value))
            return { error: "patch macro: default takes a number" };
          fallback = Number(value);
        } else if (word === "curve") {
          const value = rest[++i];
          if (value !== "lin" && value !== "exp")
            return { error: "patch macro: curve lin|exp" };
          curve = value;
        } else if (word === "label") {
          const text =
            rest[i + 1] === undefined
              ? undefined
              : (unquote(rest[i + 1]!) ?? rest[i + 1]);
          if (text === undefined)
            return { error: "patch macro: label needs text" };
          label = text;
          i++;
        } else {
          const target = readTarget(word);
          if (!target)
            return {
              error: `patch macro: "${word}" is not node.port[:min..max]`,
            };
          targets.push(target);
        }
      }
      if (targets.length === 0) return usage(verb);
      return withFx({
        type: "patch-macro",
        id,
        targets,
        ...(min !== undefined ? { min, max: max! } : {}),
        ...(fallback !== undefined ? { default: fallback } : {}),
        ...(curve ? { curve } : {}),
        ...(label !== undefined ? { label } : {}),
      });
    }
    case "knob": {
      const [macro, value] = rest;
      if (
        !macro ||
        !ID.test(macro) ||
        !value ||
        !NUMBER.test(value) ||
        rest.length !== 2
      )
        return usage(verb);
      return withFx({ type: "patch-knob", macro, value: Number(value) });
    }
    case "rate": {
      const [id, rate] = rest;
      if (
        !id ||
        !ID.test(id) ||
        (rate !== "global" && rate !== "voice") ||
        rest.length !== 2
      )
        return usage(verb);
      return withFx({ type: "patch-rate", id, rate });
    }
    case "mod": {
      const target = rest[0];
      if (!target || rest.length < 2) return usage(verb);
      return withFx({
        type: "patch-mod",
        target,
        pattern: rest.slice(1).join(" "),
      });
    }
    case "rm":
    case "remove":
    case "delete": {
      const id = rest[0];
      if (!id || !ID.test(id) || rest.length !== 1) return usage("rm");
      return withFx({ type: "patch-rm", id });
    }
    case "convert":
      return rest.length === 0
        ? withFx({ type: "patch-convert" })
        : usage(verb);
    case "detach":
      return rest.length === 0 && fx === undefined
        ? { type: "patch-detach" }
        : usage(verb);
    case "load": {
      const source = rest[0];
      if (
        !source ||
        rest.length !== 1 ||
        !/^(?:github:)?[a-z0-9][a-z0-9/._-]*$/i.test(source)
      )
        return usage(verb);
      return withFx({ type: "patch-load", source });
    }
    case "save": {
      const name = rest[0];
      if (!name || !NAME.test(name)) return usage(verb);
      let scope: "project" | "user" = "project";
      for (const word of rest.slice(1)) {
        if (word === "--user") scope = "user";
        else if (word === "--project") scope = "project";
        else return usage(verb);
      }
      return withFx({ type: "patch-save", name, scope });
    }
    case "show":
    case "ls": {
      if (rest.length > 1) return usage("show");
      const name = rest[0];
      if (name !== undefined && !NAME.test(name)) return usage("show");
      return withFx(
        name ? { type: "patch-show", name } : { type: "patch-show" },
      );
    }
    case "nodes":
    case "list": {
      if (rest.length > 1) return usage("nodes");
      return withFx(
        rest[0]
          ? { type: "patch-nodes", family: rest[0] }
          : { type: "patch-nodes" },
      );
    }
    default: {
      const near = nearest(verb, PATCH_VERBS);
      return {
        error: `patch: no verb "${verb}"${near ? ` · did you mean patch ${near}?` : ""} · ${PATCH_VERBS.join(" ")}`,
      };
    }
  }
}

/** The command a `patch …` line runs, or undefined. */
export function parsePatchCommand(prompt: string): PatchCommand | undefined {
  const read = readCommand(prompt);
  return read && !("error" in read) ? read : undefined;
}

/** The usage error for a `patch …` line that does not parse, else undefined. */
export function patchCommandError(prompt: string): string | undefined {
  const read = readCommand(prompt);
  return read && "error" in read ? read.error : undefined;
}

/** Whether a `patch` line only reads (show-me runs it without an edit). */
export function isReadOnlyPatchCommand(prompt: string): boolean {
  const command = parsePatchCommand(prompt);
  return command?.type === "patch-show" || command?.type === "patch-nodes";
}

// ---------------------------------------------------------------- printing

/** One value as `k=v` prints it (round-trips through parsePatchValue). */
export function printPatchValue(value: PatchParamValue): string {
  return printValue(value);
}

function printValue(value: PatchParamValue): string {
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "string")
    return /^[a-z0-9._:#+-]+$/i.test(value) &&
      !NUMBER.test(value) &&
      !["true", "false", "on", "off"].includes(value)
      ? value
      : JSON.stringify(value);
  return JSON.stringify(value);
}

function printParams(params: PatchParams | undefined, type?: string): string {
  // The node spec's param order, so a recipe prints the same however the
  // params were typed; names the spec does not know go last.
  const order = Object.keys(
    (type !== undefined
      ? (NODE_SPECS as Record<string, { params: object } | undefined>)[type]
          ?.params
      : undefined) ?? {},
  );
  const rank = (key: string) => {
    const at = order.indexOf(key);
    return at < 0 ? order.length : at;
  };
  return Object.entries(params ?? {})
    .sort(
      ([a], [b]) =>
        rank(a) - rank(b) ||
        (rank(a) === order.length ? a.localeCompare(b) : 0),
    )
    .map(([key, value]) => ` ${key}=${printValue(value)}`)
    .join("");
}

function printMacro(macro: Macro): string {
  const targets = macro.to
    .map((target) =>
      target.min === undefined || target.max === undefined
        ? target.port
        : `${target.port}:${target.min}..${target.max}`,
    )
    .join(" ");
  return [
    `patch macro ${macro.id} ${targets} range ${macro.min}..${macro.max} default ${macro.default}`,
    macro.curve ? ` curve ${macro.curve}` : "",
    macro.label !== undefined ? ` label ${JSON.stringify(macro.label)}` : "",
  ].join("");
}

/**
 * `patch show`: the lines that rebuild `patch` from nothing (design §6.2,
 * "type what you see"). Cable ids and provenance are not printed; replay
 * mints fresh ids.
 */
export function patchRecipe(patch: Patch): string[] {
  const fx = patch.role === "effect" ? ` --fx ${patch.name}` : "";
  const head = [
    `patch new ${patch.name} ${patch.role}`,
    patch.voices !== undefined ? ` voices=${patch.voices}` : "",
    patch.at ? ` at=${patch.at}` : "",
  ].join("");
  const lines = [head];
  for (const node of patch.nodes) {
    lines.push(
      `patch add ${node.type} as ${node.id}${printParams(node.params, node.type)}${node.label !== undefined ? ` label ${JSON.stringify(node.label)}` : ""}${fx}`,
    );
    if (node.rate === "global") lines.push(`patch rate ${node.id} global${fx}`);
  }
  // Canonical order (destination, then source), so the recipe never
  // depends on the cable ids a replay mints.
  for (const cable of [...patch.cables].sort(compareCables))
    lines.push(
      `patch wire ${cable.from} ${cable.to}${cable.amount !== undefined ? ` ${cable.amount}` : ""}${fx}`,
    );
  for (const macro of patch.macros) lines.push(`${printMacro(macro)}${fx}`);
  return lines;
}

// ---------------------------------------------------------------- applying

export type PatchEffect = Readonly<{
  kind: "save-user";
  name: string;
  patch: Patch;
  /** The track's knob settings (a library ref's macros), saved with it. */
  macros?: Readonly<Record<string, number>>;
}>;

/**
 * What the window resolved before applying (the libraries are async I/O,
 * applying stays pure): user patches by name, and a fetched `github:` source.
 */
export type PatchEnv = Readonly<{
  /** The user library: a patch by name. */
  userPatch?: (name: string) => Patch | undefined;
  /** A `github:…` source the window fetched and pinned (`from` is its pack ref). */
  fetched?: Readonly<{ source: string; patch: Patch; from: string }>;
}>;

/** The source word a command loads from (the window resolves it first), if any. */
export function patchSourceOf(command: PatchCommand): string | undefined {
  if (command.type === "patch-load") return command.source;
  if (command.type === "patch-new") return command.from;
  if (command.type === "patch-show") return command.name;
  return undefined;
}

export type PatchResult = Readonly<{
  ok: boolean;
  message: string;
  next?: TrackScore;
  kind?: string;
  payload?: Record<string, unknown>;
  /** Read-only output (show, nodes): a note, not a receipt. */
  read?: boolean;
  /** Work outside the score the window does after committing. */
  effect?: PatchEffect;
}>;

type Located = Readonly<{
  target: PatchTarget;
  patch: Patch;
  /** `bass`, `bass fx crush` or `library acid`. */
  where: string;
}>;

class PatchCommandError extends Error {}

function bad(message: string): never {
  throw new PatchCommandError(message);
}

function suggestion(word: string, vocabulary: Iterable<string>): string {
  const match = nearest(word, [...vocabulary]);
  return match ? ` · did you mean ${match}?` : "";
}

function locate(
  score: TrackScore,
  trackId: string,
  fx: string | undefined,
): Located {
  const track = score.tracks.find((candidate) => candidate.id === trackId);
  if (!track) bad(`no track ${trackId}`);
  if (fx !== undefined) {
    const stages = track.fxPatch ?? [];
    const stage = stages.find((candidate) => candidate.name === fx);
    if (!stage)
      bad(
        `${trackId} has no effect patch ${fx}${suggestion(
          fx,
          stages.map((s) => s.name),
        )} · patch new ${fx} effect`,
      );
    return {
      target: { trackId, fx },
      patch: stage,
      where: `${trackId} fx ${fx}`,
    };
  }
  const value = track.patch as TrackPatchValue | undefined;
  if (!value || track.instrument !== PATCH_INSTRUMENT)
    bad(`${trackId} plays no patch · patch new <name> or patch convert`);
  if (isPatchRef(value)) {
    const shared = score.patches[value.ref];
    if (!shared) bad(`${trackId} names a missing library patch ${value.ref}`);
    return {
      target: { library: value.ref },
      patch: shared,
      where: `library ${value.ref}`,
    };
  }
  return { target: { trackId }, patch: value, where: trackId };
}

/** The patch `patch …` edits on a track (fx: an effect patch), or why not. */
export function locatePatch(
  score: TrackScore,
  trackId: string,
  fx?: string,
): Patch | string {
  try {
    return locate(score, trackId, fx).patch;
  } catch (error) {
    if (error instanceof PatchCommandError) return error.message;
    throw error;
  }
}

function specFor(score: TrackScore, type: string): NodeSpec | undefined {
  if (type.startsWith("patch.")) {
    const sub = score.patches[type.slice(6)];
    return sub
      ? patchSpecs({ ...sub, nodes: [] }).get("in") &&
          nodeSpecOfNested(score, type)
      : undefined;
  }
  return nodeSpec(type);
}

function nodeSpecOfNested(
  score: TrackScore,
  type: string,
): NodeSpec | undefined {
  const probe: Patch = {
    kind: "patch",
    role: "instrument",
    name: "probe",
    nodes: [{ id: "probe", type }],
    cables: [],
    macros: [],
  };
  return patchSpecs(probe, score.patches).get("probe");
}

function canonicalType(score: TrackScore, word: string): string {
  if (word.startsWith("patch.")) {
    if (score.patches[word.slice(6)]) return word;
    bad(
      `patch add: no project patch ${word.slice(6)}${suggestion(word.slice(6), Object.keys(score.patches))}`,
    );
  }
  const spec = nodeSpec(word);
  if (spec) return spec.type;
  const fx = nodeSpec(`fx.${word}`);
  if (fx) return fx.type;
  const engine = nodeSpec(`engine.${word}`);
  if (engine) return engine.type;
  return bad(
    `patch add: no node type "${word}"${suggestion(word, NODE_TYPES)} · patch nodes lists them`,
  );
}

/** The ports of `id` in `patch`, with errors that name them and suggest. */
function checkPort(
  score: TrackScore,
  patch: Patch,
  ref: string,
  dir: "in" | "out",
  verb: string,
): void {
  const [id, port] = splitPort(ref);
  const specs = patchSpecs(patch, score.patches);
  const spec = specs.get(id);
  if (!spec)
    bad(
      `patch ${verb}: no node ${id}${suggestion(id, [...specs.keys()])} · nodes: ${patch.nodes.map((n) => n.id).join(", ") || "none yet"}`,
    );
  const own = dir === "out" ? spec.outputs : spec.inputs;
  const other = dir === "out" ? spec.inputs : spec.outputs;
  if (own.some((candidate) => candidate.name === port)) return;
  const type = patch.nodes.find((n) => n.id === id)?.type ?? id;
  if (other.some((candidate) => candidate.name === port))
    bad(
      `patch ${verb}: ${ref} is an ${dir === "out" ? "input" : "output"}; wire <from output> <to input>`,
    );
  const names = own.map((candidate) => candidate.name);
  bad(
    `patch ${verb}: no ${dir === "out" ? "output" : "input"} "${port}" on ${id} (${type}); ${dir === "out" ? "outputs" : "inputs"}: ${names.join(", ") || "none"}${suggestion(port, names)}`,
  );
}

function rates(score: TrackScore, patch: Patch): ReadonlyMap<string, string> {
  try {
    return inferRates(patch, score.patches).rates;
  } catch {
    return new Map();
  }
}

/** Compiler warnings about cables it drops (post-global into voice nodes, cut loops). */
export function droppedCableWarnings(
  patch: Patch,
  library: Readonly<Record<string, Patch>> = {},
): string[] {
  try {
    return compilePatch(patch, library).warnings.filter(
      (warning) =>
        /^cable \S+: /.test(warning) || /^over the cost budget/.test(warning),
    );
  } catch {
    return [];
  }
}

/** `; vcf now voice-rate`, and any new dropped-cable warnings. */
function consequences(
  score: TrackScore,
  before: Patch | undefined,
  after: Patch,
): string {
  const parts: string[] = [];
  if (before) {
    const was = rates(score, before);
    const now = rates(score, after);
    for (const node of after.nodes) {
      const rate = now.get(node.id);
      if (rate && was.has(node.id) && was.get(node.id) !== rate)
        parts.push(`${node.id} now ${rate}-rate`);
    }
  }
  const old = new Set(
    before ? droppedCableWarnings(before, score.patches) : [],
  );
  const names = new Map(
    after.cables.map((cable) => [cable.id, `${cable.from} → ${cable.to}`]),
  );
  for (const warning of droppedCableWarnings(after, score.patches))
    if (!old.has(warning))
      parts.push(
        `⚠ ${warning.replace(/^cable (\S+):/, (_all, id: string) => `${names.get(id) ?? `cable ${id}`} dropped:`)}`,
      );
  return parts.length ? `; ${parts.join("; ")}` : "";
}

function located(score: TrackScore, at: Located): Patch {
  const after = score === undefined ? undefined : locateAfter(score, at.target);
  return after ?? at.patch;
}

function locateAfter(
  score: TrackScore,
  target: PatchTarget,
): Patch | undefined {
  if ("library" in target) return score.patches[target.library];
  const track = score.tracks.find((t) => t.id === target.trackId);
  if (!track) return undefined;
  if (target.fx !== undefined)
    return track.fxPatch?.find((stage) => stage.name === target.fx);
  return track.patch && !isPatchRef(track.patch) ? track.patch : undefined;
}

function edit(score: TrackScore, at: Located, change: PatchEdit): TrackScore {
  return editPatch(score, at.target, change);
}

function sourcePatch(
  score: TrackScore,
  name: string,
  env: PatchEnv,
): { patch: Patch; from: string; library?: boolean } | undefined {
  if (env.fetched && env.fetched.source === name)
    return { patch: env.fetched.patch, from: env.fetched.from };
  const own = score.patches[name];
  if (own) return { patch: own, from: `project:${name}`, library: true };
  const user = env.userPatch?.(name);
  if (user) return { patch: user, from: `user:${name}` };
  const builtin = builtinPatch(name);
  if (builtin) return { patch: builtin, from: `builtin:${name}` };
  return undefined;
}

function sourceVocabulary(score: TrackScore): string[] {
  return [...Object.keys(score.patches), ...Object.keys(BUILTIN_PATCHES)];
}

function withRole(
  patch: Patch,
  role: PatchRole,
  name: string,
  from?: string,
): Patch {
  const { from: _from, side: _side, ...rest } = patch;
  return {
    ...rest,
    role,
    name,
    ...(from !== undefined
      ? { from }
      : patch.from !== undefined
        ? { from: patch.from }
        : {}),
    ...(role === "instrument" && rest.at ? {} : {}),
  };
}

function emptyPatch(name: string, role: PatchRole): Patch {
  return { kind: "patch", role, name, nodes: [], cables: [], macros: [] };
}

function familyList(family: string | undefined): string {
  const specs = Object.values(NODE_SPECS);
  const families = [...new Set(specs.map((spec) => spec.family))];
  if (family === undefined)
    return [
      ...families.map(
        (name) =>
          `${name}: ${specs
            .filter((spec) => spec.family === name)
            .map((spec) => spec.type)
            .join(" ")}`,
      ),
      `boundary: ${Object.entries(BOUNDARY_SPECS)
        .map(
          ([id, spec]) =>
            `${id}.{${[...spec.outputs, ...spec.inputs].map((p) => p.name).join(",")}}`,
        )
        .join(" ")}`,
      "patch nodes <family> for ports",
    ].join("\n");
  const match = families.find((name) => name === family);
  const one = nodeSpec(family);
  if (!match && one)
    return `${one.type} · ${one.doc} · in: ${one.inputs.map((p) => p.name).join(" ") || "-"} · out: ${one.outputs.map((p) => p.name).join(" ") || "-"} · params: ${Object.keys(one.params).join(" ") || "-"}`;
  if (!match)
    bad(
      `patch nodes: no family ${family}${suggestion(family, families)} · ${families.join(" ")}`,
    );
  return specs
    .filter((spec) => spec.family === match)
    .map(
      (spec) =>
        `${spec.type} · in: ${spec.inputs.map((p) => p.name).join(" ") || "-"} · out: ${spec.outputs.map((p) => p.name).join(" ") || "-"}`,
    )
    .join("\n");
}

function pct(amount: number | undefined): string {
  return amount === undefined || amount === 1
    ? ""
    : ` (${Math.round(amount * 100)} %)`;
}

function knobOf(patch: Patch, id: string): string {
  const at = patch.macros.findIndex((macro) => macro.id === id);
  return at >= 0 && at < 4
    ? ` (knob ${at + 1})`
    : at >= 4
      ? ` (drawer ${Math.floor(at / 4)})`
      : "";
}

function applyOne(
  score: TrackScore,
  trackId: string,
  command: PatchCommand,
  env: PatchEnv,
): PatchResult {
  const kind = `patch.${command.type.slice(6)}`;
  const done = (
    next: TrackScore,
    message: string,
    payload: Record<string, unknown> = {},
  ): PatchResult => ({
    ok: true,
    message,
    next,
    kind,
    payload: { trackId, ...(command.fx ? { fx: command.fx } : {}), ...payload },
  });
  switch (command.type) {
    case "patch-nodes":
      return { ok: true, read: true, message: familyList(command.family) };
    case "patch-show": {
      if (command.name !== undefined) {
        const source = sourcePatch(score, command.name, env);
        if (!source)
          bad(
            `patch show: no patch ${command.name}${suggestion(command.name, sourceVocabulary(score))}`,
          );
        return {
          ok: true,
          read: true,
          message: patchRecipe(source.patch).join("\n"),
        };
      }
      const at = locate(score, trackId, command.fx);
      return {
        ok: true,
        read: true,
        message: patchRecipe(at.patch).join("\n"),
      };
    }
    case "patch-mod":
      return bad(
        "patch mod: typed patterns are not wired yet; write mods: { cutoff: sine.slow(4) } in the track file (SDK 1.35.0), or set the macro with patch knob",
      );
    case "patch-new":
    case "patch-load": {
      const track = score.tracks.find((t) => t.id === trackId);
      if (!track) bad(`no track ${trackId}`);
      const name =
        command.type === "patch-new"
          ? command.name
          : env.fetched?.source === command.source
            ? env.fetched.patch.name
            : command.source.split(/[/:@]/).filter(Boolean).at(-1)!;
      const fromWord =
        command.type === "patch-new" ? command.from : command.source;
      if (fromWord?.startsWith("github:") && env.fetched?.source !== fromWord)
        bad(`patch load: could not fetch ${fromWord}`);
      let base: Patch | undefined;
      let from: string | undefined;
      let libraryRef = false;
      if (fromWord !== undefined) {
        const source = sourcePatch(score, fromWord, env);
        if (source) {
          base = source.patch;
          from = source.library ? undefined : source.from;
          libraryRef = source.library === true;
        } else if (
          command.type === "patch-new" &&
          resolveInstrumentWord(fromWord)
        ) {
          base = patchFromTrack({ instrument: fromWord });
        } else
          bad(
            `patch ${command.type === "patch-new" ? "new" : "load"}: no patch or instrument "${fromWord}"${suggestion(fromWord, sourceVocabulary(score))}`,
          );
      }
      const role: PatchRole =
        (command.type === "patch-new" ? command.role : undefined) ??
        (command.fx !== undefined ? "effect" : (base?.role ?? "instrument"));
      if (base && base.role !== role)
        bad(`patch: ${fromWord} is an ${base.role} patch, not an ${role}`);
      let patch = base
        ? withRole(base, role, name, from)
        : emptyPatch(name, role);
      if (command.type === "patch-new") {
        if (command.voices !== undefined)
          patch = { ...patch, voices: command.voices };
        if (command.at) {
          if (role !== "effect")
            bad("patch new: at=post is for effect patches");
          patch = { ...patch, at: "post" };
        }
      }
      if (role === "effect") {
        const stages = track.fxPatch ?? [];
        if (stages.some((stage) => stage.name === name))
          bad(
            `${trackId} already has effect patch ${name} · patch rm or another name`,
          );
        const next = setPatch(
          score,
          { trackId, fx: name },
          patch,
          stages.length,
        );
        return done(
          next,
          `${trackId}: effect patch ${name}${from ? ` from ${fromWord}` : ""} · patch add <type> --fx ${name}`,
          { name },
        );
      }
      const replaced =
        track.patch !== undefined && track.instrument === PATCH_INSTRUMENT;
      // A project library patch plays by reference, so its edits stay shared.
      const value: TrackPatchValue =
        command.type === "patch-load" && libraryRef
          ? { kind: "patch", ref: fromWord! }
          : patch;
      const next = updateTrack(score, trackId, {
        instrument: PATCH_INSTRUMENT,
        patch: value,
      });
      return done(
        next,
        `${trackId}: ${replaced ? "replaced with" : "now plays"} patch ${isPatchRef(value) ? `${value.ref} (shared)` : name}${fromWord && fromWord !== name ? ` from ${fromWord}` : ""}${patch.nodes.length === 0 ? " · patch add osc as tone" : ""}`,
        { name },
      );
    }
    case "patch-convert": {
      const track = score.tracks.find((t) => t.id === trackId);
      if (!track) bad(`no track ${trackId}`);
      if (track.instrument === PATCH_INSTRUMENT)
        bad(`${trackId} already plays a patch · patch show`);
      const converted = convertToPatch(track);
      const next = score.withTracks(
        score.tracks.map((t) => (t.id === trackId ? converted : t)),
      );
      return done(
        next,
        `${trackId}: ${track.instrument} is now a patch (one ${converted.patch && !isPatchRef(converted.patch) ? converted.patch.nodes[0]?.type : "engine"} node) · patch show`,
      );
    }
    case "patch-detach": {
      const track = score.tracks.find((t) => t.id === trackId);
      if (!track) bad(`no track ${trackId}`);
      if (!track.patch || !isPatchRef(track.patch))
        bad(`${trackId} has no shared patch to detach`);
      const ref = track.patch;
      const shared = score.patches[ref.ref];
      if (!shared) bad(`${trackId} names a missing library patch ${ref.ref}`);
      const macros = shared.macros.map((macro) =>
        ref.macros?.[macro.id] === undefined
          ? macro
          : { ...macro, default: ref.macros[macro.id]! },
      );
      const next = updateTrack(score, trackId, {
        patch: {
          ...shared,
          macros,
          ...(ref.side !== undefined ? { side: ref.side } : {}),
        },
      });
      return done(
        next,
        `${trackId}: own copy of ${ref.ref}; edits stay on this track`,
      );
    }
    case "patch-knob": {
      const track = score.tracks.find((t) => t.id === trackId);
      if (!track) bad(`no track ${trackId}`);
      const at = locate(score, trackId, command.fx);
      const macro = at.patch.macros.find((m) => m.id === command.macro);
      if (!macro)
        bad(
          `patch knob: no macro ${command.macro}${suggestion(
            command.macro,
            at.patch.macros.map((m) => m.id),
          )} · macros: ${at.patch.macros.map((m) => m.id).join(", ") || "none · patch macro"}`,
        );
      const lo = Math.min(macro.min, macro.max);
      const hi = Math.max(macro.min, macro.max);
      if (command.value < lo || command.value > hi)
        bad(`patch knob: ${macro.id} is ${macro.min}..${macro.max}`);
      if (command.fx === undefined && track.patch && isPatchRef(track.patch)) {
        const ref = track.patch;
        const next = updateTrack(score, trackId, {
          patch: {
            ...ref,
            macros: { ...(ref.macros ?? {}), [macro.id]: command.value },
          },
        });
        return done(
          next,
          `${trackId}: ${macro.label ?? macro.id} ${command.value}${knobOf(at.patch, macro.id)}`,
        );
      }
      const next = edit(score, at, {
        kind: "macro",
        macroId: macro.id,
        macro: { ...macro, default: command.value },
      });
      return done(
        next,
        `${at.where}: ${macro.label ?? macro.id} ${command.value}${knobOf(at.patch, macro.id)}`,
      );
    }
    case "patch-save": {
      const at = locate(score, trackId, command.fx);
      const copy = withRole(at.patch, at.patch.role, command.name);
      if (command.scope === "user") {
        const value = command.fx
          ? undefined
          : score.tracks.find((t) => t.id === trackId)?.patch;
        const knobs = value && "ref" in value ? value.macros : undefined;
        return {
          ok: true,
          message: `saved ${command.name} to your patch library · patch load ${command.name}`,
          effect: {
            kind: "save-user",
            name: command.name,
            patch: copy,
            ...(knobs && Object.keys(knobs).length ? { macros: knobs } : {}),
          },
        };
      }
      const exists = score.patches[command.name] !== undefined;
      const next = setPatch(score, { library: command.name }, copy);
      return done(
        next,
        `${exists ? "updated" : "saved"} project patch ${command.name} · patch load ${command.name}`,
        { name: command.name },
      );
    }
    default:
      break;
  }
  const at = locate(score, trackId, command.fx);
  const before = at.patch;
  const finish = (next: TrackScore, message: string): PatchResult =>
    done(
      next,
      `${at.where}: ${message}${consequences(score, before, located(next, at))}`,
    );
  switch (command.type) {
    case "patch-add": {
      const type = canonicalType(score, command.nodeType);
      const id = command.id ?? newNodeId(type);
      if (before.nodes.some((node) => node.id === id))
        bad(`patch add: ${id} exists · patch set ${id} … or another id`);
      const node: PatchNode = {
        id,
        type,
        ...(Object.keys(command.params).length
          ? { params: command.params }
          : {}),
        ...(command.label !== undefined ? { label: command.label } : {}),
      };
      checkParams(score, type, command.params, "add");
      return finish(
        edit(score, at, { kind: "node", nodeId: id, node }),
        `added ${id} (${type})`,
      );
    }
    case "patch-set": {
      const node = before.nodes.find((n) => n.id === command.id);
      if (!node)
        bad(
          `patch set: no node ${command.id}${suggestion(
            command.id,
            before.nodes.map((n) => n.id),
          )}`,
        );
      checkParams(score, node.type, command.params, "set");
      const params = { ...(node.params ?? {}), ...command.params };
      const next: PatchNode = {
        ...node,
        ...(Object.keys(params).length ? { params } : {}),
        ...(command.label !== undefined ? { label: command.label } : {}),
      };
      const said = [
        ...Object.entries(command.params).map(
          ([k, v]) => `${k} ${printValue(v)}`,
        ),
        ...(command.label !== undefined
          ? [`label ${JSON.stringify(command.label)}`]
          : []),
      ].join(", ");
      return finish(
        edit(score, at, { kind: "node", nodeId: node.id, node: next }),
        `${node.id}: ${said}`,
      );
    }
    case "patch-rate": {
      const node = before.nodes.find((n) => n.id === command.id);
      if (!node)
        bad(
          `patch rate: no node ${command.id}${suggestion(
            command.id,
            before.nodes.map((n) => n.id),
          )}`,
        );
      const { rate: _rate, ...rest } = node;
      const next: PatchNode =
        command.rate === "global" ? { ...rest, rate: "global" } : rest;
      if (command.rate === "voice" && node.rate === undefined)
        return {
          ok: true,
          message: `${at.where}: ${node.id} already follows what feeds it`,
        };
      return finish(
        edit(score, at, { kind: "node", nodeId: node.id, node: next }),
        command.rate === "global"
          ? `${node.id} runs once per track`
          : `${node.id} follows what feeds it`,
      );
    }
    case "patch-wire": {
      checkPort(score, before, command.from, "out", "wire");
      checkPort(score, before, command.to, "in", "wire");
      const existing = before.cables.find(
        (c) => c.from === command.from && c.to === command.to,
      );
      const cable: Cable = {
        id: existing?.id ?? newCableId(),
        from: command.from as Cable["from"],
        to: command.to as Cable["to"],
        ...(command.amount !== undefined ? { amount: command.amount } : {}),
      };
      const [fromNode] = splitPort(command.from);
      return finish(
        edit(score, at, { kind: "cable", cableId: cable.id, cable }),
        `${existing ? "rewired" : "wired"} ${fromNode} → ${command.to}${pct(command.amount)}`,
      );
    }
    case "patch-unwire": {
      const matches = (c: Cable, a: string, b: string) =>
        (c.from === a || splitPort(c.from)[0] === a) &&
        (c.to === b || splitPort(c.to)[0] === b);
      const gone = before.cables.filter(
        (c) =>
          matches(c, command.a, command.b) || matches(c, command.b, command.a),
      );
      if (gone.length === 0)
        bad(`patch unwire: no cable between ${command.a} and ${command.b}`);
      let next = score;
      for (const cable of gone)
        next = editPatch(next, at.target, {
          kind: "cable",
          cableId: cable.id,
          cable: null,
        });
      return finish(
        next,
        `unwired ${gone.map((c) => `${c.from} → ${c.to}`).join(", ")}`,
      );
    }
    case "patch-macro": {
      for (const target of command.targets)
        checkMacroPort(score, before, target.port);
      const single =
        command.targets.length === 1 && command.targets[0]!.min === undefined
          ? command.targets[0]!
          : undefined;
      const portSpec = single
        ? portRange(score, before, single.port)
        : undefined;
      const min = command.min ?? portSpec?.min ?? 0;
      const max = command.max ?? portSpec?.max ?? 1;
      const existing = before.macros.find((m) => m.id === command.id);
      const fallback =
        command.default ?? existing?.default ?? portSpec?.default ?? min;
      const macro: Macro = {
        id: command.id,
        ...(command.label !== undefined
          ? { label: command.label }
          : existing?.label !== undefined
            ? { label: existing.label }
            : {}),
        min,
        max,
        default: Math.min(
          Math.max(fallback, Math.min(min, max)),
          Math.max(min, max),
        ),
        ...((command.curve ??
          (portSpec?.step === "log" ? "exp" : undefined)) === "exp"
          ? { curve: "exp" as const }
          : {}),
        to: command.targets,
      };
      const next = edit(score, at, { kind: "macro", macroId: macro.id, macro });
      const after = located(next, at);
      const targets = command.targets
        .map((t) =>
          t.min === undefined ? t.port : `${t.port} ${t.min}..${t.max}`,
        )
        .join(", ");
      return finish(
        next,
        `macro ${macro.id} → ${targets}${knobOf(after, macro.id)}`,
      );
    }
    case "patch-rm": {
      if (before.nodes.some((n) => n.id === command.id)) {
        const cables = before.cables.filter(
          (c) =>
            splitPort(c.from)[0] === command.id ||
            splitPort(c.to)[0] === command.id,
        ).length;
        return finish(
          edit(score, at, { kind: "node", nodeId: command.id, node: null }),
          `removed ${command.id}${cables ? ` and ${cables} cable${cables === 1 ? "" : "s"}` : ""}`,
        );
      }
      if (before.macros.some((m) => m.id === command.id))
        return finish(
          edit(score, at, { kind: "macro", macroId: command.id, macro: null }),
          `removed macro ${command.id}`,
        );
      if (command.fx !== undefined && command.id === command.fx) {
        const next = setPatch(score, { trackId, fx: command.fx }, null);
        return done(next, `${trackId}: removed effect patch ${command.fx}`);
      }
      return bad(
        `patch rm: no node or macro ${command.id}${suggestion(command.id, [...before.nodes.map((n) => n.id), ...before.macros.map((m) => m.id)])}`,
      );
    }
    default:
      return bad("patch: unhandled command");
  }
}

function checkParams(
  score: TrackScore,
  type: string,
  params: PatchParams,
  verb: string,
): void {
  const spec = type.startsWith("patch.")
    ? nodeSpecOfNested(score, type)
    : nodeSpec(type);
  if (!spec) return;
  const known = new Set([
    ...Object.keys(spec.params),
    ...(spec.engine ? ["instrument", "settings"] : []),
  ]);
  for (const key of Object.keys(params))
    if (!known.has(key))
      bad(
        `patch ${verb}: no param "${key}" on ${spec.type}${suggestion(key, known)} · params: ${[...known].join(", ") || "none"}`,
      );
}

function checkMacroPort(score: TrackScore, patch: Patch, ref: string): void {
  const [id, port] = splitPort(ref);
  const node = patch.nodes.find((n) => n.id === id);
  if (!node)
    bad(
      `patch macro: no node ${id}${suggestion(
        id,
        patch.nodes.map((n) => n.id),
      )}`,
    );
  const spec = specFor(score, node.type);
  if (!spec) return;
  const names = [
    ...spec.inputs.filter((p) => p.kind === "control").map((p) => p.name),
    ...Object.entries(spec.params)
      .filter(([, p]) => p.kind === "number")
      .map(([name]) => name),
  ];
  if (!names.includes(port))
    bad(
      `patch macro: no control "${port}" on ${id} (${node.type}); controls: ${[...new Set(names)].join(", ") || "none"}${suggestion(port, names)}`,
    );
}

function portRange(
  score: TrackScore,
  patch: Patch,
  ref: string,
):
  | { min: number; max: number; default: number; step: number | "log" }
  | undefined {
  const [id, port] = splitPort(ref);
  const node = patch.nodes.find((n) => n.id === id);
  const spec = node ? specFor(score, node.type) : undefined;
  if (!spec) return undefined;
  const param = spec.params[port];
  const range =
    param?.kind === "number"
      ? param
      : spec.inputs.find((p) => p.name === port)?.spec;
  return range
    ? {
        min: range.min,
        max: range.max,
        default: range.default,
        step: range.step,
      }
    : undefined;
}

function describe(error: unknown): string | undefined {
  if (error instanceof PatchCommandError) return error.message;
  if (
    error instanceof FxValidationError ||
    error instanceof ScoreValidationError
  )
    return `patch: ${error.message}`;
  return undefined;
}

/** Runs one `patch` command against the focused track. */
export function applyPatchCommand(
  score: TrackScore,
  trackId: string,
  command: PatchCommand,
  env: PatchEnv = {},
): PatchResult {
  try {
    return applyOne(score, trackId, command, env);
  } catch (error) {
    const message = describe(error);
    if (message === undefined) throw error;
    return { ok: false, message };
  }
}

/**
 * A batch of `patch` lines applied in order as one revision: the first line
 * that fails rejects the whole batch and is named (the agent tool).
 */
export function applyPatchBatch(
  score: TrackScore,
  trackId: string,
  lines: readonly string[],
  env: PatchEnv = {},
): PatchResult & { failedAt?: number; effects?: readonly PatchEffect[] } {
  let work = score;
  const receipts: string[] = [];
  const effects: PatchEffect[] = [];
  for (const [index, line] of lines.entries()) {
    const command = parsePatchCommand(line);
    if (!command)
      return {
        ok: false,
        failedAt: index,
        message: `line ${index + 1} \`${line}\`: ${patchCommandError(line) ?? "not a patch command"} · nothing applied`,
      };
    const result = applyPatchCommand(work, trackId, command, env);
    if (!result.ok)
      return {
        ok: false,
        failedAt: index,
        message: `line ${index + 1} \`${line}\`: ${result.message} · nothing applied`,
      };
    if (result.next) work = result.next;
    if (result.effect) effects.push(result.effect);
    receipts.push(result.message);
  }
  return {
    ok: true,
    message: receipts.join("\n"),
    ...(work !== score
      ? {
          next: work,
          kind: "patch.batch",
          payload: { trackId, lines: lines.length },
        }
      : {}),
    ...(effects.length ? { effects } : {}),
  };
}

/** Patch context for validating a score's library (re-exported for tools). */
export { patchContext, findCycles };
