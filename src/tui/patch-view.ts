/**
 * The patch view (patcher design §7): a node list, the selected node's
 * ports, and a cable matrix (rows are outputs, columns are inputs), with
 * the patch's first four macros on the four knobs.
 *
 *   ↑↓          move in the focused pane          tab ⇧tab   next pane
 *   ←→          nodes ⇄ ports; across the matrix's columns
 *   enter       node: its settings in the drawer · cell: wire / unwire
 *               port: jump to the node on its other end
 *   [ ] { }     cell amount −/+ 5 % (⇧ 25 %) · 1-9 0: 10-90 %, 100 %
 *   a w x m g   add node · wire to… · remove · map to a knob · voice/global
 *   f s space   full matrix · save · play       esc   back home
 *
 * Pure: `patchModel` reads the score, `patchKey` turns a key into what to
 * run, and every edit is a typed `patch …` command (`--fx <name>` on an
 * effect patch), so the receipt teaches the words. The painter is
 * tui/patch.ts.
 */
import {
  cableKindError,
  inferRates,
  isPatchRef,
  macroAt,
  macroPosition,
  patchFromTrack,
  patchSpecs,
  PATCH_LIMITS,
  splitPort,
  type Cable,
  type Patch,
  type PortKind,
  type Rate,
} from "../../core/patch.ts";
import {
  NODE_SPECS,
  NODE_TYPES,
  type NodeSpec,
} from "../../core/patch-nodes.ts";
import type { Track, TrackScore } from "../../core/score.ts";
import { compilePatch } from "../audio/patch/compile.ts";
import {
  KEY_COARSE_LEFT,
  KEY_COARSE_RIGHT,
  KEY_DOWN,
  KEY_ENTER,
  KEY_LEFT,
  KEY_RIGHT,
  KEY_UP,
} from "../../tui/grammar.ts";
import {
  knobKey,
  type KnobIndex,
  type KnobSlot,
  type KnobSlots,
  type KnobState,
} from "../../tui/knobs.ts";
import type { PaintCell, PatchPaint } from "../../tui/patch.ts";
import { num } from "./menu.ts";
import { fxSuffix, macroValue, trackPatch } from "./patch-menu.ts";

export type PatchPane = "nodes" | "ports" | "matrix" | "knobs";

/** One pane's view state (each terminal pane keeps its own). */
export type PatchViewState = {
  /** The effect patch shown, by name; absent: the instrument patch. */
  fx?: string | undefined;
  pane: PatchPane;
  /** Index into the model's node list. */
  node: number;
  /** Index into the selected node's port rows. */
  port: number;
  row: number;
  col: number;
  /** The whole matrix, not just the selected node's neighbourhood. */
  full: boolean;
  knobs: KnobState;
};

export function patchViewState(fx?: string): PatchViewState {
  return {
    ...(fx === undefined ? {} : { fx }),
    pane: "nodes",
    node: 0,
    port: 0,
    row: 0,
    col: 0,
    full: false,
    knobs: { selected: 0 },
  };
}

export type ModelNode = Readonly<{
  id: string;
  type: string;
  rate: Rate;
  /** `in`, `out`, `voice` or `song`: listed, never removed. */
  boundary: boolean;
  /** A short summary: the first choice param's value (`saw`, `lp`). */
  detail: string;
  /** The node can run per voice or globally (`g` toggles it). */
  either: boolean;
  /** Forced global by the patch. */
  forced: boolean;
}>;

export type PortRow = Readonly<
  | { kind: "param"; name: string; text: string; mappable: boolean }
  | {
      kind: "in";
      name: string;
      port: PortKind;
      /** Sources wired into it (`voice.pitch`). */
      links: readonly string[];
      mappable: boolean;
    }
  | { kind: "out"; name: string; port: PortKind; links: readonly string[] }
>;

export type MatrixRow = Readonly<{
  /** `vcf.out`, or `macro:<id>` for a macro's targets. */
  ref: string;
  label: string;
  kind: PortKind | "macro";
  macro?: number;
}>;

export type MatrixCol = Readonly<{ ref: string; kind: PortKind }>;

export type Cell = Readonly<{
  cable?: Cable | undefined;
  /** A macro row: the macro maps onto this port. */
  mapped?: boolean;
  /** A cable here would be accepted (kinds, role, no duplicate). */
  legal: boolean;
  /** The compiler dropped this cable (its warning names it). */
  dropped: boolean;
  /** A voice cable into a global node: summed over voices (Σ). */
  sum: boolean;
}>;

export type PatchModel = Readonly<{
  track: Track;
  patch: Patch;
  fx?: string | undefined;
  /** The track is not a patch: this is `patchFromTrack`, read-only. */
  preview: boolean;
  /** The library patch the track plays (a reference), when it is one. */
  ref?: string | undefined;
  nodes: readonly ModelNode[];
  specs: ReadonlyMap<string, NodeSpec>;
  rates: ReadonlyMap<string, Rate>;
  /** Every output and every input, in node order. */
  sources: readonly MatrixRow[];
  targets: readonly MatrixCol[];
  /** The compiler's warnings: dropped and delayed cables, voice caps. */
  warnings: readonly string[];
  /** Cable ids the compiler dropped. */
  dropped: ReadonlySet<string>;
  voiceSums: ReadonlySet<string>;
  voices: number;
}>;

const BOUNDARY = ["in", "voice", "song", "out"];

/** Topological order (sources first), ties by patch order; cycles appended. */
function signalOrder(patch: Patch, ids: readonly string[]): string[] {
  const incoming = new Map<string, Set<string>>();
  for (const id of ids) incoming.set(id, new Set());
  for (const cable of patch.cables) {
    const from = splitPort(cable.from)[0];
    const to = splitPort(cable.to)[0];
    if (from !== to && incoming.has(to) && incoming.has(from))
      incoming.get(to)!.add(from);
  }
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < ids.length) {
    const next =
      ids.find(
        (id) =>
          !done.has(id) && [...incoming.get(id)!].every((d) => done.has(d)),
      ) ?? ids.find((id) => !done.has(id))!;
    done.add(next);
    out.push(next);
  }
  return out;
}

function nodeDetail(patch: Patch, id: string, spec: NodeSpec): string {
  const node = patch.nodes.find((n) => n.id === id);
  for (const [name, param] of Object.entries(spec.params))
    if (param.kind === "enum") {
      const value = node?.params?.[name];
      return typeof value === "string" ? value : param.default;
    }
  return "";
}

/** The ids the compiler names in a "cable <id>: …" warning it drops. */
function droppedCables(warnings: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const warning of warnings) {
    const id = /^cable (\S+): /.exec(warning)?.[1];
    if (id) out.add(id);
  }
  return out;
}

/** The view's model of the focused track's patch, or why there is none. */
export function patchModel(
  score: TrackScore,
  trackId: string,
  fx?: string,
): PatchModel | string {
  const track = score.tracks.find((t) => t.id === trackId);
  if (!track) return "no track focused";
  const library = score.patches ?? {};
  let patch = trackPatch(score, track, fx);
  let preview = false;
  if (!patch) {
    if (fx !== undefined) return `${track.id} has no effect patch ${fx}`;
    if (track.patch && isPatchRef(track.patch))
      return `${track.id} plays patch ${track.patch.ref}, which the song does not hold`;
    patch = patchFromTrack(track);
    preview = true;
  }
  const specs = patchSpecs(patch, library);
  const { rates, voiceSums } = inferRates(patch, library);
  const used = new Set<string>();
  for (const cable of patch.cables) {
    used.add(splitPort(cable.from)[0]);
    used.add(splitPort(cable.to)[0]);
  }
  const boundary = BOUNDARY.filter(
    (id) =>
      used.has(id) ||
      id === "out" ||
      (id === "in" && patch.role === "effect") ||
      (id === "voice" && patch.role === "instrument"),
  );
  const ids = [
    ...boundary.filter((id) => id !== "out"),
    ...patch.nodes.map((n) => n.id),
  ];
  const ordered = [...signalOrder(patch, ids), "out"];
  const nodes: ModelNode[] = ordered.map((id) => {
    const spec = specs.get(id)!;
    const node = patch.nodes.find((n) => n.id === id);
    return {
      id,
      type: node?.type ?? id,
      rate: rates.get(id) ?? "global",
      boundary: !node,
      detail: nodeDetail(patch, id, spec),
      either: spec.rate === "any" && Boolean(node),
      forced: node?.rate === "global",
    };
  });
  const outs = (id: string, spec: NodeSpec) =>
    spec.outputs.filter((port) => {
      if (id !== "in") return true;
      return patch.role === "instrument"
        ? port.name === "notes"
        : port.name !== "notes" &&
            (port.name !== "side" || Boolean(patch.side));
    });
  const sources: MatrixRow[] = nodes.flatMap((node) =>
    outs(node.id, specs.get(node.id)!).map((port) => ({
      ref: `${node.id}.${port.name}`,
      label: `${node.id}.${port.name}`,
      kind: port.kind,
    })),
  );
  patch.macros.forEach((macro, index) =>
    sources.push({
      ref: `macro:${macro.id}`,
      label: macro.label ?? macro.id,
      kind: "macro",
      macro: index,
    }),
  );
  const targets: MatrixCol[] = nodes.flatMap((node) =>
    specs.get(node.id)!.inputs.map((port) => ({
      ref: `${node.id}.${port.name}`,
      kind: port.kind,
    })),
  );
  let warnings: readonly string[] = [];
  let voices = patch.voices ?? PATCH_LIMITS.defaultVoices;
  try {
    const program = compilePatch(patch, library);
    warnings = program.warnings;
    voices = program.voices;
  } catch (error) {
    warnings = [error instanceof Error ? error.message : String(error)];
  }
  const dropped = new Set(
    [...droppedCables(warnings)].filter(
      (id) =>
        !warnings.some((w) => w.startsWith(`feedback: cable ${id} is delayed`)),
    ),
  );
  return {
    track,
    patch,
    ...(fx === undefined ? {} : { fx }),
    preview,
    ...(track.patch && isPatchRef(track.patch) && fx === undefined
      ? { ref: track.patch.ref }
      : {}),
    nodes,
    specs,
    rates,
    sources,
    targets,
    warnings,
    dropped,
    voiceSums: new Set(voiceSums),
    voices,
  };
}

function portKind(
  model: PatchModel,
  ref: string,
  dir: "in" | "out",
): PortKind | undefined {
  const [id, name] = splitPort(ref);
  const spec = model.specs.get(id);
  const ports = dir === "in" ? spec?.inputs : spec?.outputs;
  return ports?.find((port) => port.name === name)?.kind;
}

/**
 * Whether a cable `from → to` would validate (core/patch.ts rules): the
 * kinds agree, the role has that input, and the pair is not wired yet.
 */
export function legalCable(
  model: PatchModel,
  from: string,
  to: string,
): boolean {
  const out = portKind(model, from, "out");
  const into = portKind(model, to, "in");
  if (!out || !into) return false;
  if (cableKindError(out, into, to)) return false;
  if (model.patch.cables.length >= PATCH_LIMITS.maxCables) return false;
  if (model.patch.cables.some((c) => c.from === from && c.to === to))
    return false;
  const [source, port] = splitPort(from);
  if (model.patch.role === "effect" && (source === "voice" || port === "notes"))
    return false;
  if (model.patch.role === "instrument" && source === "in" && port !== "notes")
    return false;
  return true;
}

/** The legal destinations of an output: the `w` list (never an illegal port). */
export function wireTargets(model: PatchModel, from: string): string[] {
  return model.targets
    .map((col) => col.ref)
    .filter((to) => legalCable(model, from, to));
}

export function cableAt(
  model: PatchModel,
  from: string,
  to: string,
): Cable | undefined {
  return model.patch.cables.find((c) => c.from === from && c.to === to);
}

export function cell(model: PatchModel, row: MatrixRow, col: MatrixCol): Cell {
  if (row.kind === "macro") {
    const macro = model.patch.macros[row.macro!]!;
    return {
      mapped: macro.to.some((t) => t.port === col.ref),
      legal: false,
      dropped: false,
      sum: false,
    };
  }
  const cable = cableAt(model, row.ref, col.ref);
  return {
    cable,
    legal: cable ? true : legalCable(model, row.ref, col.ref),
    dropped: cable ? model.dropped.has(cable.id) : false,
    sum: cable ? model.voiceSums.has(cable.id) : false,
  };
}

/** The matrix shown: the selected node's neighbourhood, or all of it. */
export function matrixAxes(
  model: PatchModel,
  state: PatchViewState,
): Readonly<{ rows: readonly MatrixRow[]; cols: readonly MatrixCol[] }> {
  if (state.full) return { rows: model.sources, cols: model.targets };
  const node = model.nodes[clampIndex(state.node, model.nodes.length)];
  if (!node) return { rows: [], cols: [] };
  const id = node.id;
  const touches = (ref: string) => splitPort(ref)[0] === id;
  const rowRefs = new Set<string>();
  const colRefs = new Set<string>();
  for (const cable of model.patch.cables) {
    if (touches(cable.to)) rowRefs.add(cable.from);
    if (touches(cable.from)) colRefs.add(cable.to);
  }
  const rows = model.sources.filter(
    (row) =>
      touches(row.ref) ||
      rowRefs.has(row.ref) ||
      (row.kind === "macro" &&
        model.patch.macros[row.macro!]!.to.some((t) => touches(t.port))),
  );
  const cols = model.targets.filter(
    (col) => touches(col.ref) || colRefs.has(col.ref),
  );
  return { rows, cols };
}

/**
 * Put the selection on a cable's cell (§7.5: show-me lands on the cell
 * the agent, or another pane, just wired): its source node, the matrix
 * pane, and its row and column. False when the cable is not in the patch.
 */
export function focusCable(
  state: PatchViewState,
  model: PatchModel,
  cable: Readonly<{ from: string; to: string }>,
): boolean {
  const node = model.nodes.findIndex((n) => n.id === splitPort(cable.from)[0]);
  if (node < 0) return false;
  const next = { ...state, node };
  const { rows, cols } = matrixAxes(model, next);
  const row = rows.findIndex((r) => r.ref === cable.from);
  const col = cols.findIndex((c) => c.ref === cable.to);
  if (row < 0 || col < 0) return false;
  Object.assign(state, { node, row, col, pane: "matrix" });
  return true;
}

/** Cables in `now` and not in `before`, by from and to (ids may be new). */
export function newCables(
  before: readonly Cable[],
  now: readonly Cable[],
): Cable[] {
  const seen = new Set(before.map((c) => `${c.from} ${c.to}`));
  return now.filter((c) => !seen.has(`${c.from} ${c.to}`));
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

/** The selected node's port rows: number/choice params, inputs, outputs. */
export function portRows(model: PatchModel, nodeId: string): PortRow[] {
  const spec = model.specs.get(nodeId);
  if (!spec) return [];
  const node = model.patch.nodes.find((n) => n.id === nodeId);
  const inputs = new Set(spec.inputs.map((p) => p.name));
  const rows: PortRow[] = [];
  for (const [name, param] of Object.entries(spec.params)) {
    if (inputs.has(name)) continue;
    const value = node?.params?.[name];
    const text =
      param.kind === "number"
        ? num(typeof value === "number" ? value : param.default)
        : param.kind === "enum"
          ? typeof value === "string"
            ? value
            : param.default
          : (typeof value === "boolean" ? value : param.default)
            ? "on"
            : "off";
    rows.push({
      kind: "param",
      name,
      text,
      mappable: param.kind === "number" && Boolean(node),
    });
  }
  for (const port of spec.inputs)
    rows.push({
      kind: "in",
      name: port.name,
      port: port.kind,
      links: model.patch.cables
        .filter((c) => c.to === `${nodeId}.${port.name}`)
        .map((c) => c.from),
      mappable: port.kind === "control" && Boolean(port.spec) && Boolean(node),
    });
  for (const port of spec.outputs)
    if (model.sources.some((s) => s.ref === `${nodeId}.${port.name}`))
      rows.push({
        kind: "out",
        name: port.name,
        port: port.kind,
        links: model.patch.cables
          .filter((c) => c.from === `${nodeId}.${port.name}`)
          .map((c) => c.to),
      });
  return rows;
}

// ── the four knobs: the patch's first four macros ─────────────────────

/**
 * The macros on the four knobs (src/tui/knob-map.ts `sound:patch`): each
 * turn is `patch knob <id> <value>`, 2 % of the knob's travel (⇧ 10 %),
 * so an exp macro turns by ratio as its sound does.
 */
export function patchKnobs(model: PatchModel): KnobSlots {
  const slots = [0, 1, 2, 3].map((index): KnobSlot | undefined => {
    const macro = model.patch.macros[index];
    if (!macro) return undefined;
    const value = macroValue(model.track, macro, model.fx);
    const position = macroPosition(macro, value);
    const suffix = fxSuffix(model.fx);
    return {
      label: macro.label ?? macro.id,
      text: num(value),
      position,
      turn: (direction, coarse) => {
        const next = Math.min(
          1,
          Math.max(0, position + direction * (coarse ? 0.1 : 0.02)),
        );
        const target = Number(macroAt(macro, next).toPrecision(4));
        return target === value
          ? undefined
          : `patch knob ${macro.id} ${num(target)}${suffix}`;
      },
      reset: `patch knob ${macro.id} ${num(macro.default)}${suffix}`,
    };
  });
  return slots as unknown as KnobSlots;
}

// ── keys ──────────────────────────────────────────────────────────────

export type PatchAction =
  /** Run these typed commands in order (each echoes, as if typed). */
  | Readonly<{ type: "run"; commands: readonly string[] }>
  /** Open the node's settings (Sound › patch › nodes › <id>) in the drawer. */
  | Readonly<{ type: "node"; nodeId: string }>
  /** A pick list: each item runs its command; `audition` hears each row. */
  | Readonly<{
      type: "pick";
      id: "patch-add" | "patch-wire" | "patch-map";
      title: string;
      items: readonly Readonly<{ label: string; value: string }>[];
    }>
  /** Put a command in the prompt to finish and confirm (`patch save …`). */
  | Readonly<{ type: "prefill"; text: string }>
  | Readonly<{ type: "note"; message: string }>
  | Readonly<{ type: "handled" }>
  | Readonly<{ type: "transport" }>
  | Readonly<{ type: "keys" }>
  | Readonly<{ type: "exit" }>
  /** Not a patch-view key: the prompt, ctrl keys. */
  | Readonly<{ type: "pass" }>;

/** The hint row: the main gestures; the rest are in `?` (KEYS.patch). */
export const PATCH_HINT =
  "tab pane · enter edit · a add · w wire · x remove · m knob · ? keys";

const PANES: readonly PatchPane[] = ["nodes", "ports", "matrix", "knobs"];

function cycle(state: PatchViewState, model: PatchModel, by: 1 | -1): void {
  const panes = PANES.filter(
    (pane) => pane !== "knobs" || model.patch.macros.length > 0,
  );
  const at = Math.max(0, panes.indexOf(state.pane));
  state.pane = panes[(at + by + panes.length) % panes.length]!;
}

const READ_ONLY = (model: PatchModel): string =>
  model.ref !== undefined
    ? `${model.track.id} plays library patch ${model.ref} · its knobs turn here; patch detach makes it editable`
    : `${model.track.id} is not a patch yet · this is its ${model.patch.nodes[0]?.type ?? "engine"} as one · patch convert makes it one`;

/** Clamp every index to the model (the score may have changed). */
export function clampState(state: PatchViewState, model: PatchModel): void {
  state.node = clampIndex(state.node, model.nodes.length);
  const node = model.nodes[state.node];
  const ports = node ? portRows(model, node.id) : [];
  state.port = clampIndex(state.port, Math.max(1, ports.length));
  const { rows, cols } = matrixAxes(model, state);
  state.row = clampIndex(state.row, Math.max(1, rows.length));
  state.col = clampIndex(state.col, Math.max(1, cols.length));
  if (state.pane === "knobs" && model.patch.macros.length === 0)
    state.pane = "nodes";
}

function amountOf(cable: Cable): number {
  return cable.amount ?? 1;
}

function amountCommand(
  model: PatchModel,
  from: string,
  to: string,
  amount: number,
): string {
  const value = Math.round(Math.max(-1, Math.min(1, amount)) * 100) / 100;
  return `patch wire ${from} ${to} ${num(value)}${fxSuffix(model.fx)}`;
}

function newMacroId(model: PatchModel, name: string): string {
  const base =
    name.replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "") || "knob";
  const taken = new Set(model.patch.macros.map((m) => m.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

/** The `m` list for a port: each existing macro, then a new one. */
export function mapItems(
  model: PatchModel,
  ref: string,
): { label: string; value: string }[] {
  const suffix = fxSuffix(model.fx);
  const [, name] = splitPort(ref);
  const items = model.patch.macros.map((macro, index) => ({
    label: `${index < 4 ? `knob ${index + 1}` : "      "} ${macro.label ?? macro.id} (${macro.to.map((t) => t.port).join(", ")})`,
    value: `patch macro ${macro.id} ${[...macro.to.map((t) => t.port), ref].join(" ")}${suffix}`,
  }));
  if (model.patch.macros.length < PATCH_LIMITS.maxMacros) {
    const id = newMacroId(model, name);
    items.push({
      label: `new knob ${id} → ${ref}`,
      value: `patch macro ${id} ${ref}${suffix}`,
    });
  }
  return items.filter((item) => !item.label.includes(`(${ref})`));
}

/** The `a` list: every node type the patch's role may hold. */
export function addItems(
  model: PatchModel,
): { label: string; value: string }[] {
  return NODE_TYPES.filter(
    (type) =>
      model.patch.role === "instrument" ||
      NODE_SPECS[type]!.family !== "engine",
  ).map((type) => {
    const spec = NODE_SPECS[type]!;
    return {
      label: `${type.padEnd(16)} ${spec.family.padEnd(8)} ${spec.doc}`,
      value: `patch add ${type}${fxSuffix(model.fx)}`,
    };
  });
}

/** One key on the patch view. Mutates `state` (focus, scroll). */
export function patchKey(
  state: PatchViewState,
  model: PatchModel,
  value: string,
): PatchAction {
  clampState(state, model);
  const suffix = fxSuffix(model.fx);
  const node = model.nodes[state.node];
  const ports = node ? portRows(model, node.id) : [];
  const port = ports[state.port];
  const { rows, cols } = matrixAxes(model, state);
  const row = rows[state.row];
  const col = cols[state.col];
  const editable = !model.preview && model.ref === undefined;
  const edit = (action: PatchAction): PatchAction =>
    editable ? action : { type: "note", message: READ_ONLY(model) };

  switch (value) {
    case "\u001b":
      return { type: "exit" };
    case " ":
      return { type: "transport" };
    case "?":
      return { type: "keys" };
    case "\t":
      cycle(state, model, 1);
      return { type: "handled" };
    case "\u001b[Z":
      cycle(state, model, -1);
      return { type: "handled" };
    case "f":
      state.full = !state.full;
      state.row = 0;
      state.col = 0;
      return { type: "handled" };
    case "s":
      return edit({ type: "prefill", text: `patch save ${model.patch.name}` });
    case "a":
      return edit({
        type: "pick",
        id: "patch-add",
        title: `add a node to ${model.patch.name}`,
        items: addItems(model),
      });
  }

  if (state.pane === "knobs") {
    const knob = knobKey(state.knobs, patchKnobs(model), value);
    if (knob.type === "run") return { type: "run", commands: [knob.command] };
    if (knob.type === "open")
      return {
        type: "run",
        commands: [model.fx === undefined ? "knobs sound" : `/patch${suffix}`],
      };
    if (knob.type === "handled") return { type: "handled" };
  }

  const up = KEY_UP.has(value);
  if (up || KEY_DOWN.has(value)) {
    const by = up ? -1 : 1;
    if (state.pane === "nodes") {
      state.node = clampIndex(state.node + by, model.nodes.length);
      state.port = 0;
      if (!state.full) {
        state.row = 0;
        state.col = 0;
      }
    } else if (state.pane === "ports")
      state.port = clampIndex(state.port + by, ports.length);
    else if (state.pane === "matrix")
      state.row = clampIndex(state.row + by, rows.length);
    return { type: "handled" };
  }
  const left = KEY_LEFT.has(value) && value !== "-";
  if (left || (KEY_RIGHT.has(value) && value !== "+")) {
    const by = left ? -1 : 1;
    if (state.pane === "matrix")
      state.col = clampIndex(state.col + by, cols.length);
    else if (state.pane === "nodes" && !left) state.pane = "ports";
    else if (state.pane === "ports" && left) state.pane = "nodes";
    else if (state.pane === "ports") state.pane = "matrix";
    return { type: "handled" };
  }

  // Matrix cell amount: [ ] 5 %, { } (⇧) 25 %, digits 10-90 % and 0 100 %.
  const fine = value === "[" ? -0.05 : value === "]" ? 0.05 : undefined;
  const coarse = KEY_COARSE_LEFT.has(value)
    ? -0.25
    : KEY_COARSE_RIGHT.has(value)
      ? 0.25
      : undefined;
  const digit = /^[0-9]$/.test(value) ? Number(value) : undefined;
  if (
    state.pane === "matrix" &&
    (fine !== undefined || coarse !== undefined || digit !== undefined)
  ) {
    if (!row || !col || row.kind === "macro") return { type: "handled" };
    if (col.kind !== "control")
      return {
        type: "note",
        message: `${col.ref} is ${col.kind}: amounts scale cables into control ports`,
      };
    const cable = cableAt(model, row.ref, col.ref);
    if (!cable && !legalCable(model, row.ref, col.ref))
      return { type: "handled" };
    const amount =
      digit !== undefined
        ? digit === 0
          ? 1
          : digit / 10
        : (cable ? amountOf(cable) : 0) + (fine ?? coarse ?? 0);
    return edit({
      type: "run",
      commands: [amountCommand(model, row.ref, col.ref, amount)],
    });
  }

  if (KEY_ENTER.has(value)) {
    if (state.pane === "nodes") {
      if (!node) return { type: "handled" };
      if (node.boundary)
        return {
          type: "note",
          message: `${node.id}: ${model.specs.get(node.id)?.doc ?? "the patch boundary"}`,
        };
      return edit({ type: "node", nodeId: node.id });
    }
    if (state.pane === "ports") {
      if (!port || port.kind === "param") {
        return node && !node.boundary
          ? edit({ type: "node", nodeId: node.id })
          : { type: "handled" };
      }
      const other = port.links[0];
      if (!other)
        return port.kind === "out"
          ? wirePick(model, `${node!.id}.${port.name}`, edit)
          : { type: "note", message: `${node!.id}.${port.name} has no cable` };
      const id = splitPort(other)[0];
      state.node = Math.max(
        0,
        model.nodes.findIndex((n) => n.id === id),
      );
      state.port = 0;
      return { type: "handled" };
    }
    if (state.pane === "matrix") {
      if (!row || !col) return { type: "handled" };
      if (row.kind === "macro")
        return {
          type: "note",
          message: `knob ${row.label}: m on a port maps it · patch macro`,
        };
      const cable = cableAt(model, row.ref, col.ref);
      if (cable)
        return edit({
          type: "run",
          commands: [`patch unwire ${row.ref} ${col.ref}${suffix}`],
        });
      if (!legalCable(model, row.ref, col.ref))
        return {
          type: "note",
          message: `${row.ref} cannot feed ${col.ref}`,
        };
      return edit({
        type: "run",
        commands: [`patch wire ${row.ref} ${col.ref}${suffix}`],
      });
    }
  }

  switch (value) {
    case "w": {
      const from =
        state.pane === "matrix" && row && row.kind !== "macro"
          ? row.ref
          : state.pane === "ports" && port?.kind === "out"
            ? `${node!.id}.${port.name}`
            : node
              ? model.sources.find((s) => splitPort(s.ref)[0] === node.id)?.ref
              : undefined;
      if (!from)
        return {
          type: "note",
          message: `${node?.id ?? "this node"} has no output`,
        };
      return wirePick(model, from, edit);
    }
    case "x":
    case "\u001b[3~": {
      if (state.pane === "matrix") {
        const cable = row && col ? cableAt(model, row.ref, col.ref) : undefined;
        if (!cable) return { type: "handled" };
        return edit({
          type: "run",
          commands: [`patch unwire ${cable.from} ${cable.to}${suffix}`],
        });
      }
      if (state.pane === "ports" && port && port.kind !== "param") {
        const other = port.links[0];
        if (!other) return { type: "handled" };
        const self = `${node!.id}.${port.name}`;
        const [from, to] = port.kind === "in" ? [other, self] : [self, other];
        return edit({
          type: "run",
          commands: [`patch unwire ${from} ${to}${suffix}`],
        });
      }
      if (!node || node.boundary)
        return {
          type: "note",
          message: `${node?.id ?? "it"} is the patch boundary`,
        };
      return edit({ type: "run", commands: [`patch rm ${node.id}${suffix}`] });
    }
    case "m": {
      const ref =
        state.pane === "ports" && port && port.kind !== "out" && port.mappable
          ? `${node!.id}.${port.name}`
          : state.pane === "matrix" && col?.kind === "control"
            ? col.ref
            : undefined;
      if (!ref)
        return {
          type: "note",
          message:
            "m maps a number param or control input: pick one in the ports pane",
        };
      return edit({
        type: "pick",
        id: "patch-map",
        title: `map ${ref} to a knob`,
        items: mapItems(model, ref),
      });
    }
    case "g": {
      if (!node || !node.either)
        return {
          type: "note",
          message: `${node?.id ?? "it"} always runs ${node?.rate ?? "global"}`,
        };
      return edit({
        type: "run",
        commands: [
          `patch rate ${node.id} ${node.forced ? "voice" : "global"}${suffix}`,
        ],
      });
    }
  }
  if (value === "/" || value === "\u0003" || value === "\u000b")
    return { type: "pass" };
  // Unmapped printable keys are swallowed; control keys keep their bindings.
  return value.length === 1 && value >= " " && value !== "\u007f"
    ? { type: "handled" }
    : { type: "pass" };
}

function wirePick(
  model: PatchModel,
  from: string,
  edit: (action: PatchAction) => PatchAction,
): PatchAction {
  const targets = wireTargets(model, from);
  if (targets.length === 0)
    return { type: "note", message: `${from} has nowhere left to go` };
  return edit({
    type: "pick",
    id: "patch-wire",
    title: `wire ${from} to…`,
    items: targets.map((to) => ({
      label: `${to.padEnd(20)} ${portKind(model, to, "in")}`,
      value: `patch wire ${from} ${to}${fxSuffix(model.fx)}`,
    })),
  });
}

/** The knob index of a macro, for painters (undefined past the fourth). */
export function macroKnob(index: number): KnobIndex | undefined {
  return index < 4 ? (index as KnobIndex) : undefined;
}

// ── paint ─────────────────────────────────────────────────────────────

function cellPaint(
  model: PatchModel,
  row: MatrixRow,
  col: MatrixCol,
): PaintCell {
  const c = cell(model, row, col);
  if (row.kind === "macro")
    return c.mapped ? { kind: "macro" } : { kind: "none" };
  if (c.cable)
    return {
      kind: col.kind,
      ...(c.cable.amount !== undefined ? { amount: c.cable.amount } : {}),
      ...(c.dropped ? { dropped: true } : {}),
      ...(c.sum ? { sum: true } : {}),
    };
  return { kind: c.legal ? "legal" : "none" };
}

/** The selected cell in words, for the matrix's last row. */
export function cellCaption(model: PatchModel, state: PatchViewState): string {
  const { rows, cols } = matrixAxes(model, state);
  const row = rows[state.row];
  const col = cols[state.col];
  if (!row || !col) return "";
  if (row.kind === "macro") {
    const macro = model.patch.macros[row.macro!]!;
    const mapped = macro.to.some((t) => t.port === col.ref);
    return `knob ${row.label} ${mapped ? "turns" : "does not turn"} ${col.ref}`;
  }
  const c = cell(model, row, col);
  if (c.cable) {
    const amount =
      col.kind === "control" ? ` · ${num(c.cable.amount ?? 1)} ([ ] 0-9)` : "";
    const notes = [
      c.dropped ? " · dropped by the compiler" : "",
      c.sum ? " · summed over voices" : "",
    ].join("");
    return `${row.ref} → ${col.ref}${amount}${notes} · enter unwires`;
  }
  return c.legal
    ? `${row.ref} → ${col.ref} · enter wires`
    : `${row.ref} cannot feed ${col.ref}`;
}

/** The painter's view of the model at `state` (tui/patch.ts). */
export function patchPaint(
  model: PatchModel,
  state: PatchViewState,
  hint = PATCH_HINT,
): PatchPaint {
  clampState(state, model);
  const node = model.nodes[state.node];
  const ports = node ? portRows(model, node.id) : [];
  const { rows, cols } = matrixAxes(model, state);
  const patch = model.patch;
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  const title = `${patch.name} (${[
    patch.role,
    plural(patch.nodes.length, "node"),
    plural(patch.cables.length, "cable"),
    ...(patch.role === "instrument" && model.voices > 0
      ? [plural(model.voices, "voice")]
      : []),
  ].join(" · ")})`;
  return {
    title: `${model.track.id} ▸ ${title}`,
    tag: model.preview
      ? "preview · patch convert"
      : model.ref !== undefined
        ? `library ${model.ref} · patch detach`
        : undefined,
    pane: state.pane,
    nodes: model.nodes.map((n) => ({
      id: n.id,
      type: n.type === n.id ? "" : n.type,
      rate: n.rate,
      detail: n.detail,
      boundary: n.boundary,
    })),
    node: state.node,
    portsTitle: node
      ? `${node.id}  ${node.type === node.id ? "" : `${node.type} · `}${node.rate}`
      : "",
    ports: ports.map((port) => ({
      kind: port.kind,
      name: port.name,
      value: port.kind === "param" ? port.text : port.links.join(", "),
    })),
    port: state.port,
    rows: rows.map((row) => row.label),
    cols: cols.map((col) => col.ref),
    cells: rows.map((row) => cols.map((col) => cellPaint(model, row, col))),
    row: state.row,
    col: state.col,
    full: state.full,
    caption: cellCaption(model, state),
    warnings: model.warnings,
    knobs: patchKnobs(model),
    selected: state.knobs.selected,
    macros: patch.macros.length,
    hint,
  };
}
