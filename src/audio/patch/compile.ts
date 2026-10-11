/**
 * The patch compiler (design §8.1): inlines nested patches, drops nodes that
 * cannot reach `out`, colors voice and global, breaks each feedback loop at
 * the deterministic cable `findCycles` names (a one-block delay), schedules
 * each section topologically (ties by node id, so the order never depends
 * on the input order) and emits a `PatchProgram`: typed arrays only, which
 * `run.ts` interprets block by block.
 *
 * Programs are cached by `patchDigest` (canonical JSON of the patch and the
 * library patches it nests).
 */
import { createHash } from "node:crypto";
import {
  findCycles,
  nestedSpec,
  PATCH_LIMITS,
  splitPort,
  type Cable,
  type Macro,
  type Patch,
  type PatchNode,
} from "../../../core/patch.ts";
import {
  BOUNDARY_SPECS,
  nodeSpec,
  type NodeSpec,
  type PortSpec,
} from "../../../core/patch-nodes.ts";
import type { NumberParam } from "../../../core/params.ts";

/** Interpreter op codes (one per kernel). */
export const enum Op {
  In,
  Song,
  Voice,
  Out,
  Buffer,
  Pass,
  Macro,
  Osc,
  Noise,
  Svf,
  Onepole,
  Adsr,
  Ar,
  Slew,
  Follow,
  Lfo,
  Sh,
  Random,
  Const,
  Add,
  Mul,
  Min,
  Max,
  Gt,
  Lt,
  Abs,
  Not,
  Pitch2Hz,
  Db2Gain,
  Scale,
  Clamp,
  Clock,
  Vca,
  Mix,
  Xfade,
  Pan,
}

const OPS: Readonly<Record<string, Op>> = {
  osc: Op.Osc,
  noise: Op.Noise,
  svf: Op.Svf,
  onepole: Op.Onepole,
  adsr: Op.Adsr,
  ar: Op.Ar,
  slew: Op.Slew,
  follow: Op.Follow,
  lfo: Op.Lfo,
  sh: Op.Sh,
  random: Op.Random,
  const: Op.Const,
  add: Op.Add,
  mul: Op.Mul,
  min: Op.Min,
  max: Op.Max,
  gt: Op.Gt,
  lt: Op.Lt,
  abs: Op.Abs,
  not: Op.Not,
  pitch2hz: Op.Pitch2Hz,
  db2gain: Op.Db2Gain,
  scale: Op.Scale,
  clamp: Op.Clamp,
  clock: Op.Clock,
  vca: Op.Vca,
  mix: Op.Mix,
  xfade: Op.Xfade,
  pan: Op.Pan,
  voicesum: Op.Pass,
  pass: Op.Pass,
  macro: Op.Macro,
  in: Op.In,
  song: Op.Song,
  voice: Op.Voice,
  out: Op.Out,
};

/** State cells per op, and the cell each seeded generator lives in. */
const STATE: Partial<Record<Op, number>> = {
  [Op.Osc]: 1,
  [Op.Noise]: 8,
  [Op.Svf]: 2,
  [Op.Onepole]: 1,
  [Op.Adsr]: 3,
  [Op.Ar]: 1,
  [Op.Slew]: 2,
  [Op.Follow]: 1,
  [Op.Lfo]: 4,
  [Op.Sh]: 2,
  [Op.Random]: 3,
};
const SEED_CELL: Partial<Record<Op, number>> = {
  [Op.Noise]: 0,
  [Op.Lfo]: 2,
  [Op.Random]: 1,
};
/** Enum setting that selects a kernel variant. */
const MODE_PARAM: Partial<Record<Op, string>> = {
  [Op.Osc]: "wave",
  [Op.Noise]: "color",
  [Op.Svf]: "mode",
  [Op.Onepole]: "mode",
  [Op.Lfo]: "shape",
  [Op.Random]: "per",
  [Op.Scale]: "curve",
};
/** Control inputs read per sample (besides the spec's audio-rate ports). */
const SAMPLED: Partial<Record<Op, readonly string[] | "all">> = {
  [Op.Adsr]: ["gate"],
  [Op.Ar]: ["gate"],
  [Op.Slew]: ["in"],
  [Op.Sh]: ["in", "trig"],
  [Op.Add]: "all",
  [Op.Mul]: "all",
  [Op.Min]: "all",
  [Op.Max]: "all",
  [Op.Gt]: "all",
  [Op.Lt]: "all",
  [Op.Abs]: "all",
  [Op.Not]: "all",
  [Op.Pitch2Hz]: "all",
  [Op.Db2Gain]: "all",
  [Op.Scale]: "all",
  [Op.Clamp]: "all",
};

/** Input evaluation kinds. */
export const enum In {
  /** Nothing to do (an unwired or directly wired audio input, a notes port). */
  None,
  /** Audio: sum of cables into a scratch slot. */
  Sum,
  /** Control, one value per block (the source's last sample). */
  Block,
  /** Control, per sample into a scratch slot (and the last sample as ctl). */
  Sampled,
}

export const enum Base {
  Const,
  /** A top-level macro, supplied per block by the caller. */
  External,
  /** A nested patch's macro node (its output slot's block value). */
  Slot,
}

/** Fields of one input record in `Section.inputs` (stride `INPUT_WIDTH`). */
export const INPUT_WIDTH = 10;
export const enum F {
  Kind,
  Slot,
  Ctl,
  BaseKind,
  BaseIndex,
  Map,
  Clamp,
  Smooth,
  CableStart,
  CableCount,
}

/** One section's code: per-node arrays plus input records and cables. */
export type Section = Readonly<{
  ids: readonly string[];
  op: Int32Array;
  mode: Int32Array;
  nIn: Int32Array;
  slotBase: Int32Array;
  slots: Int32Array;
  ctlBase: Int32Array;
  stBase: Int32Array;
  inStart: Int32Array;
  inCount: Int32Array;
  /** Input records (`INPUT_WIDTH` fields each). */
  inputs: Int32Array;
  /**
   * Per node, the records that change after the first block (wired, or
   * knob-driven, or sampled): indices into `inputs` from `hotStart`.
   */
  hot: Int32Array;
  hotStart: Int32Array;
  hotCount: Int32Array;
  /** Cable pairs: source slot, constant index of the amount. */
  cables: Int32Array;
  /** Delay copies run after each block: source slot, delay slot. */
  delays: Int32Array;
  ctlCount: number;
  stateCount: number;
  /** Full-length slots (global only). */
  fullSlots: number;
  /** Block-local slots (slot -1 is the zero block). */
  localSlots: number;
  /** Seeded generators: state cell, node id. */
  seeds: readonly (readonly [number, string])[];
}>;

/** A global run: a range of block nodes, or one buffer node. */
export type Phase = Readonly<
  | { kind: "block"; nodes: readonly number[]; delays: Int32Array }
  | {
      kind: "buffer";
      node: number;
    }
>;

/** A buffer node's ports, for the caller's handler (lane 3 engines and effects). */
export type BufferNode = Readonly<{
  id: string;
  type: string;
  params: Readonly<Record<string, unknown>>;
  spec: NodeSpec;
}>;

export type PatchProgram = Readonly<{
  digest: string;
  name: string;
  role: Patch["role"];
  global: Section;
  voice: Section;
  pre: readonly Phase[];
  post: readonly Phase[];
  /** Bit k set when `voice` output k (pitch, note, gate, …) is wired. */
  voiceUsed: number;
  /** Fan-outs copied into each voice block: global slot, voice slot. */
  fanOuts: Int32Array;
  /** Voice sums added after each voice block: voice slot, global slot. */
  voiceSums: Int32Array;
  /** Global slot of `song.beat` (always computed). */
  beatSlot: number;
  /** Top-level macros, in knob order. */
  macros: readonly Macro[];
  consts: Float64Array;
  buffers: readonly BufferNode[];
  stereo: boolean;
  /** Voices after the deterministic cost cap. */
  voices: number;
  /** Longest release a voice can ring after gate-off, in seconds. */
  maxRelease: number;
  cost: number;
  warnings: readonly string[];
}>;

/** Cost budget per sample in `NodeSpec.cost` units (design §8.3: 25 ms per track-second). */
export const PATCH_COST_BUDGET = 1100;

const BOUNDARY_VOICE_PORTS = BOUNDARY_SPECS.voice!.outputs.map((p) => p.name);

// ---------------------------------------------------------------- digest

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function nestedNames(
  patch: Patch,
  library: Readonly<Record<string, Patch>>,
  out: Set<string>,
): Set<string> {
  for (const node of patch.nodes)
    if (node.type.startsWith("patch.")) {
      const name = node.type.slice(6);
      const sub = library[name];
      if (sub && !out.has(name)) {
        out.add(name);
        nestedNames(sub, library, out);
      }
    }
  return out;
}

/** Canonical digest of a patch and every library patch it nests. */
export function patchDigest(
  patch: Patch,
  library: Readonly<Record<string, Patch>> = {},
): string {
  const names = [...nestedNames(patch, library, new Set())].sort();
  const text = canonical({
    patch,
    nested: names.map((name) => library[name]),
  });
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- flatten

type FlatNode = {
  id: string;
  type: string;
  spec: NodeSpec;
  params: Readonly<Record<string, unknown>>;
  global: boolean;
};

type BaseRef =
  | {
      kind: Base.External;
      index: number;
      macro: Macro;
      min?: number;
      max?: number;
    }
  | { kind: Base.Slot; node: string; macro: Macro; min?: number; max?: number };

type Flat = {
  nodes: Map<string, FlatNode>;
  cables: Cable[];
  bases: Map<string, BaseRef>;
  warnings: string[];
};

const audioPort = (name: string): PortSpec => ({
  name,
  kind: name === "notes" ? "notes" : "audio",
  doc: name,
});

function passSpec(names: readonly string[]): NodeSpec {
  return {
    type: "pass",
    family: "mix",
    doc: "a nested patch's boundary",
    inputs: names.map(audioPort),
    outputs: names.map(audioPort),
    params: {},
    rate: "any",
    process: "block",
    cost: 0,
  };
}

function macroSpec(macro: Macro): NodeSpec {
  const spec: NumberParam = {
    kind: "number",
    min: macro.min,
    max: macro.max,
    default: macro.default,
    step: (macro.max - macro.min) / 100,
    doc: macro.label ?? macro.id,
  };
  return {
    type: "macro",
    family: "mix",
    doc: "a nested patch's knob",
    inputs: [{ name: "in", kind: "control", spec, doc: spec.doc }],
    outputs: [{ name: "out", kind: "control", doc: "the knob value" }],
    params: {},
    rate: "any",
    process: "block",
    cost: 0,
  };
}

function flatten(patch: Patch, library: Readonly<Record<string, Patch>>): Flat {
  const flat: Flat = {
    nodes: new Map(),
    cables: [],
    bases: new Map(),
    warnings: [],
  };
  const top = new Set(["in", "out", "voice", "song"]);
  for (const id of top)
    flat.nodes.set(id, {
      id,
      type: id,
      spec: BOUNDARY_SPECS[id]!,
      params: {},
      global: false,
    });
  inline(patch, "", library, flat, 0);
  patch.macros.forEach((macro, index) => {
    for (const target of macro.to) {
      const port = rewriteTarget(target.port, "", patch, library);
      if (flat.bases.has(port)) {
        flat.warnings.push(
          `macro ${macro.id}: ${port} is already set by another macro`,
        );
        continue;
      }
      flat.bases.set(port, {
        kind: Base.External,
        index,
        macro,
        min: target.min,
        max: target.max,
      });
    }
  });
  return flat;
}

/** Outer endpoint `X.port` of a nested node, mapped into its inlined nodes. */
function rewriteEnd(
  ref: string,
  prefix: string,
  patch: Patch,
  library: Readonly<Record<string, Patch>>,
  dir: "from" | "to",
): string {
  const [id, port] = splitPort(ref);
  if (id === "voice" || id === "song") return ref;
  if (id === "in" || id === "out")
    return `${prefix}${id}.${port}`.replace(/^\./, "");
  const node = patch.nodes.find((n) => n.id === id);
  if (node?.type.startsWith("patch.")) {
    const sub = library[node.type.slice(6)];
    if (dir === "from") return `${prefix}${id}/out.${port}`;
    if (sub?.macros.some((m) => m.id === port))
      return `${prefix}${id}/@${port}.in`;
    return `${prefix}${id}/in.${port}`;
  }
  return `${prefix}${id}.${port}`;
}

function rewriteTarget(
  ref: string,
  prefix: string,
  patch: Patch,
  library: Readonly<Record<string, Patch>>,
): string {
  return rewriteEnd(ref, prefix, patch, library, "to");
}

function inline(
  patch: Patch,
  prefix: string,
  library: Readonly<Record<string, Patch>>,
  flat: Flat,
  depth: number,
): void {
  if (depth > PATCH_LIMITS.maxDepth)
    throw new Error(
      `patch ${patch.name} nests deeper than ${PATCH_LIMITS.maxDepth}`,
    );
  if (prefix) {
    // The nested boundary: pass nodes for in and out (outer ids `X/in`, `X/out`).
    const inner = prefix.slice(0, -1);
    flat.nodes.set(`${inner}/in`, {
      id: `${inner}/in`,
      type: "pass",
      spec: passSpec(["notes", "audio", "right", "side"]),
      params: {},
      global: false,
    });
    flat.nodes.set(`${inner}/out`, {
      id: `${inner}/out`,
      type: "pass",
      spec: passSpec(["audio", "right"]),
      params: {},
      global: false,
    });
  }
  for (const node of patch.nodes) {
    const id = `${prefix}${node.id}`;
    if (node.type.startsWith("patch.")) {
      const sub = library[node.type.slice(6)];
      if (!sub)
        throw new Error(`node ${id}: no project patch "${node.type.slice(6)}"`);
      // The nested node's own ports are checked by validatePatch already.
      void nestedSpec(sub);
      inline(sub, `${id}/`, library, flat, depth + 1);
      for (const macro of sub.macros) {
        const macroId = `${id}/@${macro.id}`;
        flat.nodes.set(macroId, {
          id: macroId,
          type: "macro",
          spec: macroSpec(macro),
          params: {},
          global: false,
        });
        for (const target of macro.to) {
          const port = rewriteTarget(target.port, `${id}/`, sub, library);
          if (!flat.bases.has(port))
            flat.bases.set(port, {
              kind: Base.Slot,
              node: macroId,
              macro,
              min: target.min,
              max: target.max,
            });
        }
      }
      continue;
    }
    const spec = nodeSpec(node.type);
    if (!spec) throw new Error(`node ${id}: unknown type ${node.type}`);
    flat.nodes.set(id, {
      id,
      type: node.type,
      spec,
      params: (node as PatchNode).params ?? {},
      global: node.rate === "global",
    });
  }
  for (const cable of patch.cables)
    flat.cables.push({
      id: `${prefix}${cable.id}`,
      from: rewriteEnd(
        cable.from,
        prefix,
        patch,
        library,
        "from",
      ) as Cable["from"],
      to: rewriteEnd(cable.to, prefix, patch, library, "to") as Cable["to"],
      ...(cable.amount !== undefined ? { amount: cable.amount } : {}),
    });
}

// ---------------------------------------------------------------- compile

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

const PROGRAMS = new Map<string, PatchProgram>();
const CACHE_SIZE = 64;

/** The compiled program for a patch, cached by digest. */
export function compilePatch(
  patch: Patch,
  library: Readonly<Record<string, Patch>> = {},
): PatchProgram {
  const digest = patchDigest(patch, library);
  const hit = PROGRAMS.get(digest);
  if (hit) {
    PROGRAMS.delete(digest);
    PROGRAMS.set(digest, hit);
    return hit;
  }
  const program = buildProgram(patch, library, digest);
  PROGRAMS.set(digest, program);
  if (PROGRAMS.size > CACHE_SIZE)
    PROGRAMS.delete(PROGRAMS.keys().next().value!);
  return program;
}

function buildProgram(
  patch: Patch,
  library: Readonly<Record<string, Patch>>,
  digest: string,
): PatchProgram {
  const flat = flatten(patch, library);
  const warnings = flat.warnings;
  const nodes = flat.nodes;
  // Drop cables whose ends do not exist (a nested port nothing drives).
  let cables = flat.cables.filter((cable) => {
    const [from, fromPort] = splitPort(cable.from);
    const [to, toPort] = splitPort(cable.to);
    const a = nodes.get(from);
    const b = nodes.get(to);
    return (
      a !== undefined &&
      b !== undefined &&
      a.spec.outputs.some((p) => p.name === fromPort) &&
      b.spec.inputs.some((p) => p.name === toPort)
    );
  });

  // 1. Reachability: only nodes that feed `out` (or a macro node feeding one) run.
  const feeds = new Map<string, Set<string>>();
  for (const cable of cables) {
    const to = splitPort(cable.to)[0];
    if (!feeds.has(to)) feeds.set(to, new Set());
    feeds.get(to)!.add(splitPort(cable.from)[0]);
  }
  for (const [port, base] of flat.bases)
    if (base.kind === Base.Slot) {
      const to = splitPort(port)[0];
      if (!feeds.has(to)) feeds.set(to, new Set());
      feeds.get(to)!.add(base.node);
    }
  const live = new Set<string>(["out"]);
  const stack = ["out"];
  while (stack.length) {
    for (const from of feeds.get(stack.pop()!) ?? [])
      if (!live.has(from)) {
        live.add(from);
        stack.push(from);
      }
  }
  for (const id of [...nodes.keys()].sort(compareText))
    if (!live.has(id)) {
      const node = nodes.get(id)!;
      if (
        !["in", "voice", "song"].includes(id) &&
        node.type !== "pass" &&
        node.type !== "macro"
      )
        warnings.push(`unused node ${id}`);
      nodes.delete(id);
    }
  cables = cables.filter(
    (c) => nodes.has(splitPort(c.from)[0]) && nodes.has(splitPort(c.to)[0]),
  );
  // Song and in are always available to the global section.
  for (const id of ["in", "song"])
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        type: id,
        spec: BOUNDARY_SPECS[id]!,
        params: {},
        global: false,
      });

  // 2. Rates (Bitwig-style coloring, as core/patch.ts inferRates).
  const voice = new Set<string>();
  for (const node of nodes.values())
    if (node.spec.rate === "voice") voice.add(node.id);
  const canVoice = (id: string) => {
    const n = nodes.get(id)!;
    return n.spec.rate === "any" && !n.global;
  };
  const extraEdges: [string, string][] = [];
  for (const [port, base] of flat.bases)
    if (
      base.kind === Base.Slot &&
      nodes.has(base.node) &&
      nodes.has(splitPort(port)[0])
    )
      extraEdges.push([base.node, splitPort(port)[0]]);
  const edges = (): [string, string][] => [
    ...cables.map((c): [string, string] => [
      splitPort(c.from)[0],
      splitPort(c.to)[0],
    ]),
    ...extraEdges,
  ];
  for (let changed = true; changed;) {
    changed = false;
    for (const [from, to] of edges())
      if (voice.has(from) && !voice.has(to) && canVoice(to)) {
        voice.add(to);
        changed = true;
      }
  }

  // 3. Sections: a global node downstream of any voice node runs after the voices.
  const post = new Set<string>();
  const next = new Map<string, string[]>();
  for (const [from, to] of edges()) {
    if (!next.has(from)) next.set(from, []);
    next.get(from)!.push(to);
  }
  const walk = [...voice];
  const seen = new Set(walk);
  while (walk.length)
    for (const to of next.get(walk.pop()!) ?? [])
      if (!seen.has(to)) {
        seen.add(to);
        walk.push(to);
        if (!voice.has(to)) post.add(to);
      }
  cables = cables.filter((cable) => {
    const from = splitPort(cable.from)[0];
    const to = splitPort(cable.to)[0];
    if (post.has(from) && voice.has(to)) {
      warnings.push(
        `cable ${cable.id}: ${from} runs after the voices, so it cannot feed ${to}`,
      );
      return false;
    }
    return true;
  });

  // 4. Feedback: break each loop at findCycles' cable (a one-block delay).
  const userNodes = [...nodes.values()].filter(
    (n) => !["in", "out", "voice", "song"].includes(n.id),
  );
  const report = findCycles({
    kind: "patch",
    role: patch.role,
    name: patch.name,
    nodes: userNodes.map((n) => ({ id: n.id, type: n.type })),
    cables,
    macros: [],
  });
  const delayed = new Set<string>();
  for (const id of report.breaks) {
    const cable = cables.find((c) => c.id === id)!;
    const head = splitPort(cable.to)[0];
    const loop = report.cycles.find((c) => c.includes(head)) ?? [head];
    if (loop.some((n) => nodes.get(n)?.spec.process === "buffer")) {
      warnings.push(
        `cable ${id}: a feedback loop through an engine or effect node is cut`,
      );
      cables = cables.filter((c) => c.id !== id);
    } else {
      delayed.add(id);
      warnings.push(`feedback: cable ${id} is delayed one block (32 samples)`);
    }
  }

  // 5. Schedule each section: Kahn's order, ties by id, block nodes before buffer nodes.
  const order = (ids: Set<string>): string[] => {
    const indegree = new Map<string, number>();
    for (const id of ids) indegree.set(id, 0);
    const outs = new Map<string, string[]>();
    const add = (from: string, to: string) => {
      if (!ids.has(from) || !ids.has(to) || from === to) return;
      indegree.set(to, indegree.get(to)! + 1);
      if (!outs.has(from)) outs.set(from, []);
      outs.get(from)!.push(to);
    };
    for (const cable of cables)
      if (!delayed.has(cable.id))
        add(splitPort(cable.from)[0], splitPort(cable.to)[0]);
    for (const [from, to] of extraEdges) add(from, to);
    const ready = [...ids].filter((id) => indegree.get(id) === 0);
    const out: string[] = [];
    const rank = (id: string) =>
      nodes.get(id)!.spec.process === "buffer" ? 1 : 0;
    while (ready.length) {
      ready.sort((a, b) => rank(a) - rank(b) || compareText(a, b));
      const id = ready.shift()!;
      out.push(id);
      for (const to of outs.get(id) ?? []) {
        indegree.set(to, indegree.get(to)! - 1);
        if (indegree.get(to) === 0) ready.push(to);
      }
    }
    if (out.length !== ids.size)
      throw new Error(
        `patch ${patch.name}: a nested knob feeds back into itself`,
      );
    return out;
  };
  const voiceIds = new Set([...nodes.keys()].filter((id) => voice.has(id)));
  const globalIds = new Set([...nodes.keys()].filter((id) => !voice.has(id)));
  const preIds = new Set([...globalIds].filter((id) => !post.has(id)));
  const postIds = new Set([...globalIds].filter((id) => post.has(id)));
  const preOrder = order(preIds);
  const postOrder = order(postIds);
  let voiceOrder = order(voiceIds);
  // Boundaries first: song and in head the global section.
  const lead = (list: string[], first: readonly string[]) => [
    ...first.filter((id) => list.includes(id)),
    ...list.filter((id) => !first.includes(id)),
  ];
  const preList = lead(preOrder, ["song", "in"]);
  voiceOrder = lead(voiceOrder, ["voice"]);

  // Phases: runs of block nodes split at buffer nodes.
  const phaseOf = new Map<string, number>();
  const phaseLists: { kind: "block" | "buffer"; ids: string[] }[] = [];
  for (const list of [preList, postOrder]) {
    let current: { kind: "block" | "buffer"; ids: string[] } | undefined;
    for (const id of list) {
      if (nodes.get(id)!.spec.process === "buffer") {
        phaseLists.push({ kind: "buffer", ids: [id] });
        current = undefined;
      } else {
        if (!current) {
          current = { kind: "block", ids: [] };
          phaseLists.push(current);
        }
        current.ids.push(id);
      }
      phaseOf.set(id, phaseLists.length - 1);
    }
    // Pre and post never share a phase.
    current = undefined;
  }
  const preCount = phaseLists.findIndex((p) =>
    p.ids.some((id) => post.has(id)),
  );
  for (const id of [...delayed]) {
    const cable = cables.find((c) => c.id === id)!;
    const from = splitPort(cable.from)[0];
    const to = splitPort(cable.to)[0];
    if (!voice.has(from) && phaseOf.get(from) !== phaseOf.get(to)) {
      warnings.push(
        `cable ${id}: a feedback loop across an engine or effect node is cut`,
      );
      delayed.delete(id);
      cables = cables.filter((c) => c.id !== id);
    }
  }

  // 6. Slots. Global outputs read across phases, by voices or by buffer nodes
  // keep the whole render; everything else lives one block at a time.
  const consts: number[] = [];
  const constant = (value: number): number => {
    consts.push(value);
    return consts.length - 1;
  };
  const one = constant(1);
  const into = new Map<string, Cable[]>();
  for (const cable of cables) {
    if (!into.has(cable.to)) into.set(cable.to, []);
    into.get(cable.to)!.push(cable);
  }
  const needsFull = new Set<string>();
  for (const cable of cables) {
    const from = splitPort(cable.from)[0];
    const to = splitPort(cable.to)[0];
    if (voice.has(from)) continue;
    if (
      voice.has(to) ||
      nodes.get(from)!.spec.process === "buffer" ||
      nodes.get(to)!.spec.process === "buffer" ||
      phaseOf.get(from) !== phaseOf.get(to)
    )
      needsFull.add(cable.from);
  }
  for (const [port, base] of flat.bases)
    if (base.kind === Base.Slot && !voice.has(base.node)) {
      const to = splitPort(port)[0];
      if (voice.has(to) || phaseOf.get(base.node) !== phaseOf.get(to))
        needsFull.add(`${base.node}.out`);
    }
  needsFull.add("song.beat");

  type Builder = {
    full: number;
    local: number;
    slotOf: Map<string, number>;
  };
  const g: Builder = { full: 0, local: 1, slotOf: new Map() };
  const v: Builder = { full: 0, local: 1, slotOf: new Map() };
  const local = (b: Builder) => -1 - b.local++;
  const fullSlot = (b: Builder) => b.full++;
  for (const id of [...preList, ...postOrder]) {
    const node = nodes.get(id)!;
    for (const port of node.spec.outputs) {
      if (port.kind === "notes") continue;
      const ref = `${id}.${port.name}`;
      const whole = needsFull.has(ref) || node.spec.process === "buffer";
      g.slotOf.set(ref, whole ? fullSlot(g) : local(g));
    }
  }
  for (const id of voiceOrder)
    for (const port of nodes.get(id)!.spec.outputs) {
      if (port.kind === "notes") continue;
      v.slotOf.set(`${id}.${port.name}`, local(v));
    }
  // Voice sums: one full-length accumulator per voice port feeding the global section.
  const accumulators = new Map<string, number>();
  const fanIns = new Map<string, number>();
  for (const cable of cables) {
    const from = splitPort(cable.from)[0];
    const to = splitPort(cable.to)[0];
    if (voice.has(from) && !voice.has(to) && !accumulators.has(cable.from))
      accumulators.set(cable.from, fullSlot(g));
    if (!voice.has(from) && voice.has(to) && !fanIns.has(cable.from))
      fanIns.set(cable.from, local(v));
  }
  for (const [port, base] of flat.bases)
    if (base.kind === Base.Slot) {
      const ref = `${base.node}.out`;
      const to = splitPort(port)[0];
      if (voice.has(base.node) && !voice.has(to) && !accumulators.has(ref))
        accumulators.set(ref, fullSlot(g));
      if (!voice.has(base.node) && voice.has(to) && !fanIns.has(ref))
        fanIns.set(ref, local(v));
    }

  // 7. Emit sections.
  const buffers: BufferNode[] = [];
  let maxRelease = 0;
  const emit = (ids: readonly string[], isVoice: boolean, b: Builder) => {
    const n = ids.length;
    const op = new Int32Array(n);
    const mode = new Int32Array(n);
    const nIn = new Int32Array(n);
    const slotBase = new Int32Array(n);
    const ctlBase = new Int32Array(n);
    const stBase = new Int32Array(n);
    const inStart = new Int32Array(n);
    const inCount = new Int32Array(n);
    const slots: number[] = [];
    const inputs: number[] = [];
    const cableList: number[] = [];
    const delayList: number[] = [];
    const seeds: [number, string][] = [];
    let ctl = 0;
    let state = 0;
    // Where a cable's source lives from this section's point of view.
    const sourceSlot = (cable: Cable | undefined, ref: string): number => {
      const from = splitPort(ref)[0];
      if (isVoice) {
        if (!voice.has(from)) return fanIns.get(ref)!;
      } else if (voice.has(from)) return accumulators.get(ref)!;
      const slot = b.slotOf.get(ref)!;
      if (cable && delayed.has(cable.id)) {
        const delay = local(b);
        delayList.push(slot, delay);
        return delay;
      }
      return slot;
    };
    const baseSlot = (node: string): number =>
      sourceSlot(undefined, `${node}.out`);
    ids.forEach((id, index) => {
      const node = nodes.get(id)!;
      const spec = node.spec;
      const code =
        spec.process === "buffer"
          ? Op.Buffer
          : node.type === "pass"
            ? Op.Pass
            : OPS[node.type];
      if (code === undefined)
        throw new Error(`node ${id}: no kernel for ${node.type}`);
      op[index] = code;
      nIn[index] = spec.inputs.length;
      const modeParam = MODE_PARAM[code];
      if (modeParam) {
        const values = (
          spec.params[modeParam] as {
            values: readonly string[];
            default: string;
          }
        ).values;
        const chosen =
          (node.params[modeParam] as string | undefined) ??
          (spec.params[modeParam] as { default: string }).default;
        mode[index] = Math.max(0, values.indexOf(chosen));
      }
      if (code === Op.Buffer)
        buffers.push({ id, type: node.type, params: node.params, spec });
      const settings = Object.entries(spec.params)
        .filter(
          ([name, p]) =>
            p.kind === "number" && !spec.inputs.some((i) => i.name === name),
        )
        .map(([name]) => name)
        .sort(compareText);
      ctlBase[index] = ctl;
      stBase[index] = state;
      const seedCell = SEED_CELL[code];
      if (seedCell !== undefined) seeds.push([state + seedCell, id]);
      state += STATE[code] ?? 0;
      slotBase[index] = slots.length;
      inStart[index] = inputs.length / INPUT_WIDTH;
      const sampled = SAMPLED[code];
      const ports: {
        port: string;
        spec?: NumberParam;
        kind: PortSpec["kind"];
        sampled: boolean;
        smooth: boolean;
      }[] = [
        ...spec.inputs.map((p) => ({
          port: p.name,
          spec: p.spec,
          kind: p.kind,
          sampled:
            p.kind === "control" &&
            (p.audioRate === true ||
              sampled === "all" ||
              (sampled?.includes(p.name) ?? false)),
          smooth: p.smooth === true,
        })),
        ...settings.map((name) => ({
          port: name,
          spec: spec.params[name] as NumberParam,
          kind: "control" as const,
          sampled: false,
          smooth: false,
        })),
      ];
      ports.forEach((p, k) => {
        const ref = `${id}.${p.port}`;
        const list = (into.get(ref) ?? []).filter(
          (c) =>
            nodes
              .get(splitPort(c.from)[0])!
              .spec.outputs.find((o) => o.name === splitPort(c.from)[1])
              ?.kind !== "notes",
        );
        const record = new Array<number>(INPUT_WIDTH).fill(0);
        record[F.Ctl] = ctl + k;
        record[F.Map] = -1;
        record[F.Clamp] = -1;
        record[F.CableStart] = cableList.length / 2;
        let slot = -1;
        if (p.kind === "notes" || code === Op.Buffer) {
          record[F.Kind] = In.None;
          // Buffer nodes read their sources whole; record the cables only.
          if (code === Op.Buffer && p.kind !== "notes") {
            record[F.Kind] = p.kind === "audio" ? In.Sum : In.Block;
            for (const c of list)
              cableList.push(
                sourceSlot(c, c.from),
                c.amount === undefined ? one : constant(c.amount),
              );
            record[F.CableCount] = list.length;
            // A knob on an engine or effect setting: the handler reads its
            // mapped value per block (run.ts `runBuffer` → `io.bases`).
            const base = p.kind === "control" ? flat.bases.get(ref) : undefined;
            record[F.BaseKind] = Base.Const;
            if (base) {
              record[F.Map] = constant(base.macro.min);
              constant(base.macro.max);
              constant(base.macro.curve === "exp" ? 1 : 0);
              constant(base.min ?? Number.NaN);
              constant(base.max ?? Number.NaN);
              if (base.kind === Base.External) {
                record[F.BaseKind] = Base.External;
                record[F.BaseIndex] = base.index;
              } else if (base.kind === Base.Slot && nodes.has(base.node)) {
                record[F.BaseKind] = Base.Slot;
                record[F.BaseIndex] = baseSlot(base.node);
              } else record[F.Map] = -1;
            }
            if (p.spec && record[F.BaseKind] !== Base.Const) {
              record[F.Clamp] = constant(p.spec.min);
              constant(p.spec.max);
            }
          }
        } else if (p.kind === "audio") {
          if (list.length === 1 && (list[0]!.amount ?? 1) === 1) {
            record[F.Kind] = In.None;
            slot = sourceSlot(list[0], list[0]!.from);
          } else if (list.length > 0) {
            record[F.Kind] = In.Sum;
            slot = local(b);
            for (const c of list)
              cableList.push(
                sourceSlot(c, c.from),
                c.amount === undefined ? one : constant(c.amount),
              );
            record[F.CableCount] = list.length;
          }
        } else {
          record[F.Kind] = p.sampled ? In.Sampled : In.Block;
          if (p.sampled) slot = local(b);
          for (const c of list)
            cableList.push(
              sourceSlot(c, c.from),
              c.amount === undefined ? one : constant(c.amount),
            );
          record[F.CableCount] = list.length;
          record[F.Smooth] = p.smooth ? 1 : 0;
          const range = p.spec;
          if (range) {
            record[F.Clamp] = constant(range.min);
            constant(range.max);
          }
          const raw = node.params[p.port];
          // Cables add to an explicit value (or a knob); a wired port with
          // neither starts from 0, so voice.pitch → osc.pitch plays the note.
          const fallback =
            typeof raw === "number"
              ? raw
              : list.length > 0
                ? 0
                : (range?.default ?? 0);
          const base = flat.bases.get(ref);
          if (base) {
            record[F.Map] = constant(base.macro.min);
            constant(base.macro.max);
            constant(base.macro.curve === "exp" ? 1 : 0);
            constant(base.min ?? Number.NaN);
            constant(base.max ?? Number.NaN);
          }
          if (base?.kind === Base.External) {
            record[F.BaseKind] = Base.External;
            record[F.BaseIndex] = base.index;
          } else if (base?.kind === Base.Slot && nodes.has(base.node)) {
            record[F.BaseKind] = Base.Slot;
            record[F.BaseIndex] = baseSlot(base.node);
          } else {
            record[F.BaseKind] = Base.Const;
            record[F.BaseIndex] = constant(fallback);
            if (base) record[F.Map] = -1;
          }
          if ((code === Op.Adsr || code === Op.Ar) && p.port === "release")
            maxRelease = Math.max(
              maxRelease,
              list.length === 0 && record[F.BaseKind] === Base.Const
                ? fallback
                : (range?.max ?? 10),
            );
        }
        record[F.Slot] = slot;
        inputs.push(...record);
        if (k < spec.inputs.length) slots.push(slot);
      });
      inCount[index] = ports.length;
      ctl += ports.length;
      for (const port of spec.outputs)
        slots.push(
          port.kind === "notes" ? -1 : b.slotOf.get(`${id}.${port.name}`)!,
        );
    });
    return {
      section: {
        ids,
        op,
        mode,
        nIn,
        slotBase,
        slots: Int32Array.from(slots),
        ctlBase,
        stBase,
        inStart,
        inCount,
        ...hotInputs(inputs, inStart, inCount),
        inputs: Int32Array.from(inputs),
        cables: Int32Array.from(cableList),
        delays: Int32Array.from(delayList),
        ctlCount: ctl,
        stateCount: state,
        fullSlots: b.full,
        localSlots: b.local,
        seeds,
      } as Section,
    };
  };
  const globalIdsOrdered = [...preList, ...postOrder];
  const { section: globalSection } = emit(globalIdsOrdered, false, g);
  const { section: voiceSection } = emit(voiceOrder, true, v);
  // Fix up full/local counts after both emits (fan-ins were allocated earlier).
  const finalGlobal: Section = {
    ...globalSection,
    fullSlots: g.full,
    localSlots: g.local,
  };
  const finalVoice: Section = {
    ...voiceSection,
    fullSlots: 0,
    localSlots: v.local,
  };

  // Delay copies belong to the phase of their source node.
  const indexOf = new Map(globalIdsOrdered.map((id, i) => [id, i]));
  const phaseDelays = phaseLists.map(() => [] as number[]);
  const gDelays = finalGlobal.delays;
  const slotOwner = new Map<number, string>();
  for (const [ref, slot] of g.slotOf) slotOwner.set(slot, splitPort(ref)[0]);
  for (let i = 0; i < gDelays.length; i += 2) {
    const owner = slotOwner.get(gDelays[i]!)!;
    phaseDelays[phaseOf.get(owner)!]!.push(gDelays[i]!, gDelays[i + 1]!);
  }
  const phases: Phase[] = phaseLists.map((p, i) =>
    p.kind === "buffer"
      ? { kind: "buffer", node: indexOf.get(p.ids[0]!)! }
      : {
          kind: "block",
          nodes: p.ids.map((id) => indexOf.get(id)!),
          delays: Int32Array.from(phaseDelays[i]!),
        },
  );
  const split = preCount < 0 ? phases.length : preCount;

  let voiceUsed = 0;
  BOUNDARY_VOICE_PORTS.forEach((name, k) => {
    if (cables.some((c) => c.from === `voice.${name}`)) voiceUsed |= 1 << k;
  });
  const fanOuts: number[] = [];
  for (const [ref, slot] of fanIns) fanOuts.push(g.slotOf.get(ref)!, slot);
  const voiceSums: number[] = [];
  for (const [ref, slot] of accumulators)
    voiceSums.push(v.slotOf.get(ref)!, slot);

  // 8. Cost and the deterministic voice cap.
  let voiceCost = 0;
  let globalCost = 0;
  for (const id of nodes.keys()) {
    const cost = nodes.get(id)!.spec.cost;
    if (voice.has(id)) voiceCost += cost;
    else globalCost += cost;
  }
  const requested = patch.voices ?? PATCH_LIMITS.defaultVoices;
  const voices = voiceCap(requested, voiceCost, globalCost);
  if (voices < requested)
    warnings.push(
      `over the cost budget: voices capped at ${voices} (asked for ${requested})`,
    );

  const stereo = (into.get("out.right") ?? []).length > 0;
  return Object.freeze({
    digest,
    name: patch.name,
    role: patch.role,
    global: finalGlobal,
    voice: finalVoice,
    pre: phases.slice(0, split),
    post: phases.slice(split),
    voiceUsed,
    fanOuts: Int32Array.from(fanOuts),
    voiceSums: Int32Array.from(voiceSums),
    beatSlot: g.slotOf.get("song.beat")!,
    macros: patch.macros,
    consts: Float64Array.from(consts),
    buffers,
    stereo,
    voices: voiceSums.length > 0 ? voices : 0,
    maxRelease,
    cost: voiceCost * voices + globalCost,
    warnings: Object.freeze([...warnings]),
  });
}

/** The records each node must re-evaluate every block after the first. */
function hotInputs(
  inputs: readonly number[],
  inStart: Int32Array,
  inCount: Int32Array,
): { hot: Int32Array; hotStart: Int32Array; hotCount: Int32Array } {
  const hot: number[] = [];
  const hotStart = new Int32Array(inStart.length);
  const hotCount = new Int32Array(inStart.length);
  for (let n = 0; n < inStart.length; n += 1) {
    hotStart[n] = hot.length;
    for (let j = 0; j < inCount[n]!; j += 1) {
      const r = (inStart[n]! + j) * INPUT_WIDTH;
      const kind = inputs[r + F.Kind]!;
      if (kind === In.None) continue;
      const still =
        kind === In.Block &&
        inputs[r + F.CableCount] === 0 &&
        inputs[r + F.BaseKind] === Base.Const;
      if (!still) hot.push(inStart[n]! + j);
    }
    hotCount[n] = hot.length - hotStart[n]!;
  }
  return { hot: Int32Array.from(hot), hotStart, hotCount };
}

/**
 * Voices that fit the cost budget: Σ(voice nodes × voices) + Σ(global
 * nodes) ≤ PATCH_COST_BUDGET, at least one, at most `requested`. A pure
 * function of the patch, never of wall-clock time.
 */
export function voiceCap(
  requested: number,
  voiceCost: number,
  globalCost: number,
  budget = PATCH_COST_BUDGET,
): number {
  if (voiceCost <= 0) return requested;
  const fit = Math.floor((budget - globalCost) / voiceCost);
  return Math.max(1, Math.min(requested, fit));
}

/**
 * A macro's value at one of its targets: the knob position (lin or exp over
 * the macro range) mapped onto the target's min..max; NaN ends fall back to
 * the macro's own range, and both NaN pass the value through.
 */
export function mapMacro(
  value: number,
  min: number,
  max: number,
  exp: boolean,
  tmin: number,
  tmax: number,
): number {
  if (tmin !== tmin && tmax !== tmax) return value;
  const v = value < min ? min : value > max ? max : value;
  let p = exp
    ? Math.log(v / min) / Math.log(max / min)
    : (v - min) / (max - min);
  if (!Number.isFinite(p)) p = 0;
  const lo = tmin === tmin ? tmin : min;
  const hi = tmax === tmax ? tmax : max;
  return lo + (hi - lo) * p;
}
