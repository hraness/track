/**
 * The preset builder: a preset is a built-in patch (one or more `engine.*`
 * layers, then an `fx.*` chain, then a level stage) plus the browser's
 * metadata. Specs stay short and readable; `buildPreset` wires the nodes,
 * cables and the four named knobs.
 */
import type { Cable, Macro, Patch, PatchNode, PortRef } from "../patch.ts";

/** Browser categories, in browsing order. */
export const PRESET_CATEGORIES = Object.freeze([
  "init",
  "bass",
  "lead",
  "pad",
  "keys",
  "pluck",
  "mallet",
  "strings",
  "brass",
  "wind",
  "vox",
  "arp",
  "fx",
  "texture",
  "drums",
  "perc",
  "chain",
] as const);
export type PresetCategory = (typeof PRESET_CATEGORIES)[number];

/** One line per category for the browser and help. */
export const CATEGORY_DOCS: Readonly<Record<PresetCategory, string>> =
  Object.freeze({
    init: "plain starting points, one per engine",
    bass: "sub, reese, acid, 808, FM and played basses",
    lead: "mono and poly leads, glide, sync and screamers",
    pad: "warm, glass, evolving and choir pads",
    keys: "pianos, electric pianos, organs and clavs",
    pluck: "synth plucks, guitars, harps and kalimbas",
    mallet: "bells, mallets and tuned percussion",
    strings: "bowed ensembles, solo strings and pizzicato",
    brass: "synth brass, stabs and modeled horns",
    wind: "flutes, reeds and world winds",
    vox: "choirs, singers, throat singing and vocoders",
    arp: "sequences, gated pads and pulsing patterns",
    fx: "risers, impacts, lasers and sirens",
    texture: "drones, granular beds and washes",
    drums: "kits for the drum track",
    perc: "hand drums and world percussion",
    chain: "effect chains for any track",
  });

/** Engines a layer can use (`engine.<name>` patch nodes). */
export type EngineName =
  | "synth"
  | "keys"
  | "string"
  | "modal"
  | "wind"
  | "sing"
  | "granular"
  | "vocoder";

const GAIN_PORT: Partial<Record<EngineName, true>> = {
  synth: true,
  string: true,
  modal: true,
};

/** Effect stages that take a stereo pair (`left`/`right`). */
const STEREO = new Set([
  "double",
  "phaser",
  "chorus",
  "leslie",
  "postgain",
  "delay",
  "reverb",
]);

export type Layer = Readonly<{
  engine: EngineName;
  /** The node's instrument word (oscillator, keys family, `string` …). */
  instrument: string;
  /** Engine settings fields, e.g. `{ synth: { unison: 5 } }`. */
  settings?: Readonly<Record<string, unknown>>;
  /** Control values on the engine node (they play as onset lanes). */
  params?: Readonly<Record<string, number>>;
  /** Node id; defaults to the engine name (`synth`, then `synth2`). */
  id?: string;
  /** Layer level: the engine's `gain` input, or a postgain after it. */
  gain?: number;
}>;

/** `[type, params, id]`: `type` without `fx.`; id defaults to the type. */
export type Stage = readonly [
  type: string,
  params?: Readonly<Record<string, number | string | boolean>>,
  id?: string,
];

/** A modulator wired into a port: `lfo` sweeps a control input. */
export type Mod = Readonly<{
  id: string;
  /** Node type (`lfo`, `random`, `adsr` …) and its params. */
  type: string;
  params?: Readonly<Record<string, number | string | boolean>>;
  /** Target port and attenuverter. */
  to: PortRef;
  amount?: number;
}>;

export type Knob = Readonly<{
  label: string;
  min: number;
  max: number;
  default: number;
  curve?: "exp";
  /** Target port → its value at the knob's min and max (absent: knob range). */
  to: Readonly<Record<string, readonly [number, number] | null>>;
  /** One line for the receipt: what turning it does. */
  doc: string;
}>;

export type PresetSpec = Readonly<{
  name: string;
  category: PresetCategory;
  tags: readonly string[];
  /** One line: what it sounds like. */
  desc: string;
  /** The advanced engine feature it shows, in plain words. */
  feature: string;
  /** Instrument presets: the sound sources (summed). */
  layers?: readonly Layer[];
  fx?: readonly Stage[];
  mods?: readonly Mod[];
  knobs: readonly [Knob, Knob, Knob, Knob];
  voices?: number;
  /** Phrase range for the quality check (MIDI low, high). */
  range?: readonly [number, number];
  /** Monophonic sound: the check plays a line, not chords. */
  mono?: boolean;
  /** A fast peak limiter after the level stage, for spiky sources. */
  guard?: boolean;
}>;

export type KnobDoc = Readonly<{ id: string; label: string; doc: string }>;

export type Preset = Readonly<{
  name: string;
  category: PresetCategory;
  tags: readonly string[];
  desc: string;
  feature: string;
  /** Instrument or effect patch, or a drum kit name. */
  kind: "instrument" | "effect" | "kit";
  /** The patch to load (absent for kits). */
  patch?: Patch;
  /** The kit word (`syn808` …) for kit presets. */
  kit?: string;
  knobs: readonly KnobDoc[];
  range: readonly [number, number];
  mono: boolean;
  /** `/patch` node types it uses (engines first). */
  nodes: readonly string[];
}>;

const DEFAULT_RANGE: readonly [number, number] = [48, 79];
const RANGES: Readonly<
  Partial<Record<PresetCategory, readonly [number, number]>>
> = {
  bass: [28, 52],
  lead: [60, 84],
  pad: [48, 76],
  keys: [43, 84],
  pluck: [52, 84],
  mallet: [60, 91],
  strings: [43, 79],
  brass: [48, 74],
  wind: [60, 84],
  vox: [48, 74],
  arp: [52, 79],
  fx: [48, 72],
  texture: [36, 64],
  perc: [48, 72],
};

const idOf = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "knob";

/** Wires a spec into a validated-shape patch plus its browser metadata. */
export function buildPreset(
  spec: PresetSpec,
  level: Readonly<Record<string, number>> = {},
): Preset {
  const role = spec.layers ? "instrument" : "effect";
  const nodes: PatchNode[] = [];
  const cables: Cable[] = [];
  const used = new Set<string>();
  const fresh = (base: string): string => {
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}${n}`;
    used.add(id);
    return id;
  };
  let cableN = 0;
  const wire = (from: string, to: string, amount?: number) =>
    cables.push({
      id: `c${(cableN += 1)}`,
      from: from as PortRef,
      to: to as PortRef,
      ...(amount === undefined ? {} : { amount }),
    });

  // Sources: a list of [left, right?] audio ports summed into the next stage.
  let srcL: string[] = [];
  let srcR: string[] = [];
  if (spec.layers) {
    for (const layer of spec.layers) {
      const id = fresh(layer.id ?? layer.engine);
      const params: Record<string, unknown> = {
        instrument: layer.instrument,
        ...(layer.params ?? {}),
      };
      if (layer.settings) params.settings = layer.settings;
      const gainOnNode = layer.gain !== undefined && GAIN_PORT[layer.engine];
      if (gainOnNode) params.gain = layer.gain;
      nodes.push({
        id,
        type: `engine.${layer.engine}`,
        params: params as PatchNode["params"],
      });
      wire("in.notes", `${id}.notes`);
      if (layer.gain !== undefined && !gainOnNode) {
        const amp = fresh(`${id}-amp`);
        nodes.push({
          id: amp,
          type: "fx.postgain",
          params: { gain: layer.gain },
        });
        wire(`${id}.out`, `${amp}.left`);
        wire(`${id}.right`, `${amp}.right`);
        srcL.push(`${amp}.left`);
        srcR.push(`${amp}.right`);
      } else {
        srcL.push(`${id}.out`);
        srcR.push(`${id}.right`);
      }
    }
  } else {
    srcL = ["in.audio"];
    srcR = ["in.right"];
  }
  let stereo = spec.layers !== undefined || role === "effect";
  for (const [type, params, idHint] of spec.fx ?? []) {
    const id = fresh(idHint ?? type);
    nodes.push({
      id,
      type: `fx.${type}`,
      ...(params ? { params } : {}),
    });
    if (STEREO.has(type)) {
      for (const s of srcL) wire(s, `${id}.left`);
      for (const s of stereo ? srcR : srcL) wire(s, `${id}.right`);
      srcL = [`${id}.left`];
      srcR = [`${id}.right`];
      stereo = true;
    } else {
      // A mono stage folds the pair to its left channel.
      for (const s of srcL) wire(s, `${id}.in`);
      srcL = [`${id}.out`];
      srcR = [];
      stereo = false;
    }
  }
  // The level stage (postgain tops out at 4, so a quiet source takes two).
  const gain = level[spec.name] ?? 1;
  const stages = gain > 4 ? [4, gain / 4] : [gain];
  let out = "";
  for (const [n, g] of stages.entries()) {
    const id = fresh("level");
    nodes.push({
      id,
      type: "fx.postgain",
      label: n === 0 ? "level" : "level trim",
      params: { gain: Math.round(g * 1000) / 1000 },
    });
    for (const s of srcL) wire(s, `${id}.left`);
    for (const s of stereo ? srcR : srcL) wire(s, `${id}.right`);
    srcL = [`${id}.left`];
    srcR = [`${id}.right`];
    stereo = true;
    out = id;
  }
  let endL = `${out}.left`;
  let endR = `${out}.right`;
  if (spec.guard) {
    // A tanh soft clipper per channel: transparent under -6 dBFS, and no
    // sample past -1.4 dBFS however hard a spiky source hits.
    const guard = (end: string, side: string): string => {
      const g = fresh(`guard${side}`);
      nodes.push({
        id: g,
        type: "fx.distort",
        label: "peak guard",
        params: { type: "soft", drive: 0, tone: 20000, mix: 1, postgain: 0.85 },
      });
      wire(end, `${g}.in`);
      return `${g}.out`;
    };
    endL = guard(endL, "l");
    endR = stereo ? guard(endR, "r") : endL;
  }
  wire(endL, "out.audio");
  wire(endR, "out.right");

  for (const mod of spec.mods ?? []) {
    const id = fresh(mod.id);
    nodes.push({
      id,
      type: mod.type,
      ...(mod.params ? { params: mod.params } : {}),
    });
    wire(`${id}.out`, mod.to, mod.amount);
  }

  const macros: Macro[] = spec.knobs.map((knob) => ({
    id: idOf(knob.label),
    label: knob.label,
    min: knob.min,
    max: knob.max,
    default: knob.default,
    ...(knob.curve ? { curve: knob.curve } : {}),
    to: Object.entries(knob.to).map(([port, range]) => ({
      port: port as PortRef,
      ...(range ? { min: range[0], max: range[1] } : {}),
    })),
  }));
  const patch: Patch = {
    kind: "patch",
    role,
    name: spec.name,
    nodes,
    cables,
    macros,
    ...(spec.voices ? { voices: spec.voices } : {}),
  };
  return Object.freeze({
    name: spec.name,
    category: spec.category,
    tags: Object.freeze([...spec.tags]),
    desc: spec.desc,
    feature: spec.feature,
    kind: role,
    patch,
    knobs: Object.freeze(
      spec.knobs.map((k) => ({
        id: idOf(k.label),
        label: k.label,
        doc: k.doc,
      })),
    ),
    range: spec.range ?? RANGES[spec.category] ?? DEFAULT_RANGE,
    mono: spec.mono ?? false,
    nodes: Object.freeze([...new Set(nodes.map((n) => n.type))]),
  });
}

/** Browser metadata for a hand-written built-in patch. */
export function describePatch(
  patch: Patch,
  meta: Readonly<{
    category: PresetCategory;
    tags: readonly string[];
    desc: string;
    feature: string;
    docs: readonly string[];
    range?: readonly [number, number];
    mono?: boolean;
  }>,
): Preset {
  return Object.freeze({
    name: patch.name,
    category: meta.category,
    tags: Object.freeze([...meta.tags]),
    desc: meta.desc,
    feature: meta.feature,
    kind: patch.role,
    patch,
    knobs: Object.freeze(
      patch.macros.slice(0, 4).map((m, i) => ({
        id: m.id,
        label: m.label ?? m.id,
        doc: meta.docs[i] ?? "",
      })),
    ),
    range: meta.range ?? RANGES[meta.category] ?? DEFAULT_RANGE,
    mono: meta.mono ?? false,
    nodes: Object.freeze([...new Set(patch.nodes.map((n) => n.type))]),
  });
}

/** A drum kit as a browser row. */
export function kitPreset(
  name: string,
  kit: string,
  tags: readonly string[],
  desc: string,
  feature: string,
): Preset {
  return Object.freeze({
    name,
    category: "drums" as const,
    tags: Object.freeze([...tags]),
    desc,
    feature,
    kind: "kit" as const,
    kit,
    knobs: Object.freeze([]),
    range: [36, 51] as const,
    mono: false,
    nodes: Object.freeze([]),
  });
}

/** Shorthand for a knob. */
export function knob(
  label: string,
  range: readonly [number, number, number],
  to: Knob["to"],
  doc: string,
  curve?: "exp",
): Knob {
  return {
    label,
    min: range[0],
    max: range[1],
    default: range[2],
    ...(curve ? { curve } : {}),
    to,
    doc,
  };
}

type Settings = Readonly<Record<string, unknown>>;
type Params = Readonly<Record<string, number>>;

/** A synth layer: oscillator word, `synth` settings, optional node values. */
export const synth = (
  instrument: string,
  settings: Settings,
  extra: Partial<Layer> = {},
): Layer => ({
  engine: "synth",
  instrument,
  settings: { synth: settings },
  ...extra,
});

/** A layer that plays one of an engine's own presets, plus overrides. */
export const engine = (
  name: Exclude<EngineName, "synth" | "keys">,
  preset: string,
  overrides: Settings = {},
  extra: Partial<Layer> = {},
): Layer => ({
  engine: name,
  instrument: name,
  settings: { [name]: { preset, ...overrides } },
  ...extra,
});

/** A keys layer: family word and keys preset. */
export const keys = (
  family: string,
  preset: string,
  overrides: Settings = {},
  extra: Partial<Layer> = {},
): Layer => ({
  engine: "keys",
  instrument: family,
  settings: { keys: { preset, ...overrides } },
  ...extra,
});

export type { Params };
