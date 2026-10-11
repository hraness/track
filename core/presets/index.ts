/**
 * The built-in preset catalog: every preset by name, in category order.
 * Instrument and effect presets are built-in patches (BUILTIN_PATCHES
 * includes them); drum presets set the track's kit.
 */
import { ACID_BASS } from "../patches/acid-bass.ts";
import { FM_BELL } from "../patches/fm-bell.ts";
import { FORMANT_VOX } from "../patches/formant-vox.ts";
import { PLUCK_KS } from "../patches/pluck-ks.ts";
import { SIDECHAIN_PUMP } from "../patches/sidechain-pump.ts";
import { SUPERSAW_PAD } from "../patches/supersaw-pad.ts";
import { WIDE_CRUSH } from "../patches/wide-crush.ts";
import { WOBBLE } from "../patches/wobble.ts";
import type { Patch } from "../patch.ts";
import { polishModular } from "./modular.ts";
import {
  buildPreset,
  describePatch,
  PRESET_CATEGORIES,
  type Preset,
  type PresetSpec,
} from "./build.ts";
import { PRESET_LEVELS } from "./levels.ts";
import { BASS } from "./catalog/bass.ts";
import { LEAD } from "./catalog/lead.ts";
import { PAD } from "./catalog/pad.ts";
import { KEYS } from "./catalog/keys.ts";
import { MALLET, PLUCK } from "./catalog/pluck.ts";
import { BRASS, STRINGS, VOX, WIND } from "./catalog/orchestra.ts";
import { ARP, FX, INIT, PERC, TEXTURE } from "./catalog/motion.ts";
import { CHAIN, KITS } from "./catalog/chain.ts";

export const PRESET_SPECS: readonly PresetSpec[] = [
  ...BASS,
  ...LEAD,
  ...PAD,
  ...KEYS,
  ...PLUCK,
  ...MALLET,
  ...STRINGS,
  ...BRASS,
  ...WIND,
  ...VOX,
  ...ARP,
  ...FX,
  ...TEXTURE,
  ...PERC,
  ...INIT,
  ...CHAIN,
];

/**
 * The hand-wired modular patches: oscillators, filters and envelopes as
 * separate nodes, so opening one in /patch shows the whole signal path.
 */
const GUARDED = new Set(["wobble", "pluck-ks"]);
const polished = (patch: Patch, velocity: boolean, levels = PRESET_LEVELS) =>
  polishModular(
    patch,
    levels[patch.name] ?? 1,
    velocity,
    GUARDED.has(patch.name),
  );

/** The modular patches as written, for the level script's rebuilds. */
export const MODULAR_SOURCES: Readonly<
  Record<string, readonly [Patch, boolean]>
> = {
  "acid-bass": [ACID_BASS, true],
  wobble: [WOBBLE, true],
  "supersaw-pad": [SUPERSAW_PAD, true],
  "fm-bell": [FM_BELL, false],
  "pluck-ks": [PLUCK_KS, false],
  "sidechain-pump": [SIDECHAIN_PUMP, false],
  "wide-crush": [WIDE_CRUSH, false],
  "formant-vox": [FORMANT_VOX, false],
};

/** A modular preset rebuilt with `levels` (the level script's second pass). */
export function rebuildModular(
  preset: Preset,
  levels: Readonly<Record<string, number>>,
): Preset | undefined {
  const source = MODULAR_SOURCES[preset.name];
  if (!source) return undefined;
  return { ...preset, patch: polished(source[0], source[1], levels) };
}

const MODULAR: readonly Preset[] = [
  describePatch(polished(ACID_BASS, true), {
    category: "bass",
    tags: ["acid", "303", "modular", "resonant", "squelch"],
    desc: "303-style acid line built from raw modules",
    feature:
      "modular graph: saw, resonant filter, accent envelope and drive as nodes",
    docs: [
      "filter cutoff",
      "resonance squelch",
      "envelope sweep per note",
      "drive",
    ],
  }),
  describePatch(polished(WOBBLE, true), {
    category: "bass",
    tags: ["dubstep", "wobble", "lfo", "modular"],
    desc: "dubstep wobble: an LFO sweeping a resonant filter",
    feature: "modular graph: tempo-synced LFO cabled into filter cutoff",
    docs: ["filter center", "wobble depth", "wobble rate", "resonance"],
  }),
  describePatch(polished(SUPERSAW_PAD, true), {
    category: "pad",
    tags: ["supersaw", "modular", "wide", "trance"],
    desc: "supersaw pad wired from seven detuned oscillators",
    feature: "modular graph: detuned oscillator bank, panned and summed",
    docs: ["detune spread", "filter cutoff", "attack", "reverb"],
  }),
  describePatch(polished(FM_BELL, false), {
    category: "mallet",
    tags: ["fm", "bell", "modular", "operators"],
    desc: "FM bell from two oscillators cabled into each other",
    feature:
      "modular graph: a modulator oscillator into the carrier's FM input",
    docs: ["FM index", "modulator ratio", "decay", "reverb"],
  }),
  describePatch(polished(PLUCK_KS, false), {
    category: "pluck",
    tags: ["karplus", "pluck", "modular", "string"],
    desc: "Karplus-Strong pluck: a noise burst in a tuned feedback delay",
    feature: "modular graph: noise burst into a filtered feedback loop",
    docs: ["ring time", "damping", "brightness", "echo"],
  }),
  describePatch(polished(SIDECHAIN_PUMP, false), {
    category: "chain",
    tags: ["sidechain", "pump", "house", "ducking", "modular"],
    desc: "sidechain pump: ducks under a clock or another track's level",
    feature:
      "envelope follower on the side input (or a tempo clock) driving gain",
    docs: ["duck depth", "release", "beats per pump", "dry blend"],
  }),
  describePatch(polished(WIDE_CRUSH, false), {
    category: "chain",
    tags: ["crush", "stereo", "lofi", "modular"],
    desc: "bitcrush and downsample with a mid/side widener",
    feature: "modular graph: crusher and mid/side width as nodes",
    docs: ["bit depth", "downsample", "stereo width", "wet blend"],
  }),
  describePatch(polished(FORMANT_VOX, false), {
    category: "chain",
    tags: ["formant", "vowel", "talk", "modular"],
    desc: "talking vowel filter morphing under an LFO",
    feature: "LFO cabled into a vowel formant filter",
    docs: ["vowel", "morph rate", "formant shift", "wet blend"],
  }),
];

export const PRESETS: readonly Preset[] = Object.freeze(
  [
    ...PRESET_SPECS.map((spec) => buildPreset(spec, PRESET_LEVELS)),
    ...MODULAR,
    ...KITS,
  ].sort(
    (a, b) =>
      PRESET_CATEGORIES.indexOf(a.category) -
      PRESET_CATEGORIES.indexOf(b.category),
  ),
);

const BY_NAME = new Map(PRESETS.map((p) => [p.name, p]));

/** The built-in preset named `name`, or undefined. */
export function presetByName(name: string): Preset | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}
