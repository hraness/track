/**
 * The hand-editing menu (`/menu`, Ctrl-K): every edit the agent can make,
 * reachable with arrow keys. Pure: the tree is rebuilt from the score on
 * every key, and a change is returned as the command it stands for, which
 * the caller runs through the normal prompt path (one ScoreOperation, one
 * receipt, one undo step). Each row shows its current value and that
 * command, so the menu teaches the commands.
 *
 * Rendering reuses the TUI's picker overlay: `view()` returns a picker.
 */
import {
  effectPatchMenuNode,
  effectPatchMenuNodes,
  patchMenuNode,
} from "./patch-menu.ts";
import { TOPIC_ALIASES } from "../lang/glossary.ts";
import {
  voiceEffectRows,
  voiceRootDetail,
  voiceRootNodes,
} from "./menu-voice.ts";
import { commandParam, sketchFor } from "./sketch.ts";
import { nearest } from "../commands/nearest.ts";
import {
  ARROW_DOWN,
  ARROW_UP,
  HINTS,
  KEY_BACK,
  KEY_BACKSPACE,
  KEY_DOWN,
  KEY_END,
  KEY_ENTER,
  KEY_FORWARD,
  KEY_HOME,
  KEY_LEFT,
  KEY_PAGE_DOWN,
  KEY_PAGE_UP,
  KEY_RESET,
  KEY_RIGHT,
  KEY_UP,
} from "../../tui/grammar.ts";
import { arrangeDetail, arrangeNodes } from "./arrange-menu.ts";
import { auditionKey, isStageable, type AuditionKey } from "./audition.ts";
import { performanceDetail, performanceNodes } from "./performance-menu.ts";
import { malletsMenu, modalParameterNodes } from "./modal-menu.ts";
import { windParameterNodes, windsMenu } from "./wind-menu.ts";
import { singParameterNodes } from "./sing-menu.ts";
import type { FaderSpec } from "./fader.ts";
import { crumbText, type Crumbs } from "../../tui/crumbs.ts";
import { knobFields, type KnobField } from "./knob-fields.ts";
import { soundFamily } from "./knob-map.ts";
import {
  openingMeterCommand,
  openingUnit,
  tempoDetail,
  tempoMenuNode,
  START_BARS,
  START_BEATS_PER_BAR,
  START_TEMPO_BPM,
} from "./menu-time.ts";
import {
  AUTOMATION_PARAMETERS,
  automationPoints,
  automationRange,
  REVERB_IR_BUILTINS,
  SAMPLE_FIT_MODES,
  SAMPLE_UNITS,
  SCORE_LIMITS,
  isTrackAutomationParameter,
  WARP_MODES,
  WAVETABLE_PARAMS,
  isWavetableInstrument,
  wavetableOf,
  type WavetableParam,
  type AutomationParameter,
  type Track,
  type TrackAutomationParameter,
  type TrackScore,
  CALIBRATION_LATEST,
  createScore,
} from "../../core/score.ts";
import {
  CORE_EFFECTS,
  EFFECT_NAMES,
  FX_LANES,
  RIG_PRESETS,
  RIG_STAGES,
  rigPresetOf,
  SHOEGAZE_EFFECTS,
  VOWEL_VALUES,
  effectPresetNames,
  effectSpec,
  type EffectName,
  type FxLane,
  type NumberParam,
  type ParamSpec,
} from "../../core/fx.ts";
import {
  effectValues,
  parseEffectName,
  parseParamName,
} from "../commands/fx.ts";
import {
  LOUDNESS_TARGET_NAMES,
  LOUDNESS_TARGETS,
  MASTER_LIMITS,
  MASTER_PRESETS,
  MASTER_SPECS,
  MASTER_UNITS,
  describeMaster,
  describeUnit,
  type MasterUnit,
} from "../../core/master.ts";
import { SAMPLE_CONTROLS, type SampleControl } from "../commands/sample.ts";
import { AVAILABLE_INSTRUMENTS } from "../audio/wav.ts";
import {
  DEFAULT_KITS,
  GM_INSTRUMENTS,
  PACK_CATALOG,
  STRUDEL_BANK_ALIASES,
} from "../audio/packs.ts";
import { kitCatalog } from "../audio/kits.ts";
import { SYNTH_KIT_NAMES } from "../../core/kits.ts";
import { DRUM_PATTERNS } from "../../core/sdk/v1.ts";
import { isDrumInstrument } from "../../core/drums.ts";
import { loopTicksOf } from "../../core/tempo.ts";
import {
  SYNTH_GROUPS,
  SYNTH_PARAMS,
  SYNTH_PRESETS,
  SYNTH_SIMPLE,
  normalizeSynth,
} from "../../core/synth.ts";
import {
  isStringTrack,
  STRING_PARAMS,
  STRING_PRESET_NAMES,
  STRING_PRESETS,
  BOWED_PRESET_NAMES,
  BOW_SIMPLE_PARAMS,
  resolveString,
  STRING_SIMPLE_PARAMS,
  stringPresetOf,
} from "../../core/strings.ts";
import {
  KEYS_PARAMS,
  KEYS_PRESETS,
  KEYS_FAMILIES,
  ORGAN_ROWS,
  ORGAN_TEXT,
  PIPE_REGISTRATIONS,
  PIPE_STOPS,
  isElectricFamily,
  isKeysFamily,
  isOrganFamily,
  isPianoFamily,
  keysParamsFor,
  keysSimpleFor,
  pipeStops,
  resolvedKeys,
  type OrganFamily,
} from "../../core/keys.ts";
import type { PickerItem } from "../../tui/app.ts";
import { BUILTIN_TABLES, BUILTIN_TABLE_NAMES } from "../audio/wavetable.ts";
import {
  UZU_WAVETABLES,
  WAVETABLE_PACK,
  describeTable,
  listLocalWavetables,
} from "../commands/wavetable.ts";
import {
  BASS_MODES,
  CHORD_PATTERNS,
  MAX_VOICING_STEP,
  MODE_NAMES,
  PERFORM_MODES,
  PROGRESSION_PRESETS,
  PROGRESSION_STYLES,
  SCALE_NAMES,
  SPREADS,
  STROKE_PATTERN_NAMES,
  GUITAR_TUNING_NAMES,
  keyName,
  parseKey,
} from "../../core/chords.ts";
import {
  TUNING_LIMITS,
  TUNING_MAPS,
  TUNING_NAMES,
  describeTuning,
  type Tuning,
} from "../../core/tuning.ts";
import { rootName, tuningStepsText } from "../commands/tuning.ts";
import { describeGuitar } from "../commands/strum.ts";
import {
  granularBrowseNodes,
  granularMenuDetail,
  granularMenuLabel,
  granularMenuNodes,
} from "./granular-menu.ts";
import {
  ARP_RATES,
  CHORD_MODES,
  STROKE_SPEED_MS,
  defaultChordSettings,
  type ChordSettings,
} from "./play-chords.ts";

/** What the menu needs to know beyond the score. */
export type MenuContext = Readonly<{
  score: TrackScore;
  trackId: string;
  playing: boolean;
  grid: string;
  grids: readonly string[];
  clickOn: boolean;
  countInBars: number;
  /** How much agent turns show (`/showme`); absent hides the row. */
  showMe?: string;
  /** Project › audio: the chosen devices and the lists to pick from. */
  audio?: MenuAudioDevices;
  /** The session's name, for Project › session and export file names. */
  sessionName?: string;
  /** Play mode's chord settings (defaults when absent). */
  chords?: ChordSettings;
  /** Project root, for the project's own wavetables (none when absent). */
  projectRoot?: string;
  /**
   * The audition loop (src/tui/audition.ts), when the window hosts one.
   * `score` above is then the staged score; changed rows show the
   * committed value beside the staged one.
   */
  audition?: MenuAudition;
}>;

/** One output and one input (src/audio/devices.ts); no routing. */
export type MenuAudioDevices = Readonly<{
  /** `Speakers` or `default (Speakers)`. */
  output: string;
  input: string;
  /** Output names; empty when the backend cannot list them. */
  outputs: readonly string[];
  inputs: readonly string[];
  /** Why device choice is unavailable (fallback backends). */
  unavailable?: string;
}>;

/** What the menu needs from the audition controller. */
export type MenuAudition = Readonly<{
  looping: boolean;
  /** Edits are staged (an Enter keeps them, Esc reverts them). */
  dirty: boolean;
  /** How many edits are staged, for the drawer's A/B badge. */
  staged?: number;
  /** The committed score, for `staged ← committed` on changed rows. */
  committed: TrackScore;
  /** The footer while auditioning. */
  hint: string;
  /** `♪ solo · B staged 2 · 42 ms`, shown in the title. */
  status?: string | undefined;
  /**
   * Which commands stage while auditioning (default `isStageable`); the
   * chord settings screen also stages `/chords …` and `key …`.
   */
  stageable?: (command: string) => boolean;
  /** The committed chord settings, for `staged ← committed` on Chords rows. */
  committedChords?: ChordSettings;
}>;

type NumberField = Readonly<{
  kind: "number";
  label: string;
  /** `undefined` while the effect is off; a nudge then turns it on. */
  value: number | undefined;
  min: number;
  max: number;
  /** Next value one step in `direction`. */
  step: (value: number, direction: 1 | -1) => number;
  format: (value: number) => string;
  command: (value: number) => string;
  /** Shown while `value` is undefined. */
  off?: string;
  /** Starting value for a nudge while off. */
  start?: number;
  /** The command `x` runs to put the value back to its default. */
  reset?: string;
}>;

export type MenuNode = (
  | Readonly<{
      kind: "menu";
      id: string;
      label: string;
      detail: string;
      build: (context: MenuContext) => MenuNode[];
    }>
  | NumberField
  | Readonly<{
      kind: "toggle";
      label: string;
      value: boolean;
      command: (value: boolean) => string;
    }>
  | Readonly<{
      kind: "choice";
      label: string;
      value: string;
      options: readonly string[];
      command: (option: string) => string;
    }>
  | Readonly<{
      kind: "entry";
      label: string;
      value: string;
      /** Shown in the title while typing. */
      placeholder: string;
      /** Command for the typed text; undefined when it cannot parse. */
      command: (text: string) => string | undefined;
      /** Shown as the slash-command equivalent. */
      example: string;
    }>
  | Readonly<{ kind: "action"; label: string; command: string }>
  | Readonly<{
      kind: "point";
      label: string;
      lane: AutomationParameter;
      beat: number;
      value: number;
    }>
  | Readonly<{ kind: "info"; label: string; value: string }>
) &
  Readonly<{
    /** One line on what the focused row does, shown under the list. */
    help?: string;
  }>;

/** What a key did; `run` carries the command to execute. */
export type MenuResult =
  | { type: "handled" }
  | { type: "close" }
  | { type: "run"; command: string }
  /** Space (loop), `a` (A/B) or `c` (context) for the audition loop. */
  | { type: "audition"; key: AuditionKey }
  /** Commit the staged edits as one operation. */
  | { type: "keep" }
  /** Drop the staged edits. */
  | { type: "revert" }
  /**
   * The cursor moved in a list while the loop plays: audition `command`
   * in place of the previous hover of `key` (one per list).
   */
  | { type: "hover"; command: string; key: string }
  /** Left a list without choosing: drop its hover (`key`). */
  | { type: "unhover"; key: string }
  /** Chose a list item while the loop plays: stage it for good. */
  | { type: "choose"; command: string; key: string }
  /** Enter on a number row: open the fader drawer on this level's values. */
  | { type: "fader"; label: string }
  | { type: "pass" };

export type MenuView = Readonly<{
  /** The breadcrumb as plain text: `≡ Arrange › range · /q`. */
  title: string;
  /** The same breadcrumb in parts, for tui/crumbs.ts to fit and color. */
  crumbs: Crumbs;
  items: PickerItem[];
  index: number;
  hint: string;
  /** What the focused row does, and the prompt command it stands for. */
  note: string;
}>;

// ── formatting and steps ──────────────────────────────────────────────

export function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

const linear =
  (size: number, min: number, max: number) =>
  (value: number, direction: 1 | -1) =>
    clamp(Math.round((value + size * direction) / size) * size, min, max);

/** Cutoff moves by thirds of an octave-ish so the low end stays usable. */
const cutoffStep = (value: number, direction: 1 | -1) =>
  clamp(
    Math.round(direction > 0 ? value * 1.25 : value / 1.25),
    SCORE_LIMITS.minFilterCutoff,
    SCORE_LIMITS.maxFilterCutoff,
  );

const DELAY_BEATS = [
  0.0625, 0.125, 0.1875, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4,
] as const;
const delayStep = (value: number, direction: 1 | -1) => {
  if (direction > 0)
    return DELAY_BEATS.find((beats) => beats > value + 1e-9) ?? 4;
  return (
    [...DELAY_BEATS].reverse().find((beats) => beats < value - 1e-9) ?? 0.0625
  );
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const TRACK_LANE_STEP: Readonly<
  Record<TrackAutomationParameter, (value: number, direction: 1 | -1) => number>
> = {
  volume: linear(0.05, 0, SCORE_LIMITS.maxVolume),
  pan: linear(0.1, -1, 1),
  filter: cutoffStep,
  resonance: linear(0.05, 0, SCORE_LIMITS.maxFilterResonance),
  "delay-feedback": linear(0.05, 0, SCORE_LIMITS.maxDelayFeedback),
  "delay-mix": linear(0.05, 0, SCORE_LIMITS.maxDelayMix),
  wt: linear(0.05, 0, 1),
};

const TRACK_LANE_LABEL: Readonly<Record<TrackAutomationParameter, string>> = {
  volume: "volume",
  pan: "pan",
  filter: "filter cutoff (Hz)",
  resonance: "filter resonance",
  "delay-feedback": "delay feedback",
  "delay-mix": "delay mix",
  wt: "table position",
};

const FX_LANE_INFO = new Map(FX_LANES.map((entry) => [entry.lane, entry]));

/** Nudge for a number spec: linear by its step, or a sixth of an octave. */
export function specStep(
  spec: NumberParam,
): (value: number, direction: 1 | -1) => number {
  if (spec.step === "log")
    return (value, direction) => {
      const next = Math.max(value, 1) * 2 ** (direction / 6);
      return clamp(
        next >= 100 ? Math.round(next) : Math.round(next * 10) / 10,
        spec.min,
        spec.max,
      );
    };
  const size = spec.step;
  return (value, direction) => {
    const next = Math.round((value + size * direction) / size) * size;
    return clamp(Number(next.toFixed(6)), spec.min, spec.max);
  };
}

function laneStep(
  lane: AutomationParameter,
): (value: number, direction: 1 | -1) => number {
  if (isTrackAutomationParameter(lane)) return TRACK_LANE_STEP[lane];
  const info = FX_LANE_INFO.get(lane);
  return info ? specStep(info.spec) : linear(0.05, 0, 1);
}

function laneLabel(lane: AutomationParameter): string {
  if (isTrackAutomationParameter(lane)) return TRACK_LANE_LABEL[lane];
  const info = FX_LANE_INFO.get(lane);
  if (!info) return lane;
  const unit = info.spec.unit ? ` (${info.spec.unit})` : "";
  const owner =
    info.effect === "synth" ||
    info.effect === "string" ||
    info.effect === "keys" ||
    info.effect === "modal" ||
    info.effect === "grain" ||
    info.effect === "wind" ||
    info.effect === "sing" ||
    info.effect === "vocoder"
      ? info.effect
      : effectSpec(info.effect).label;
  return `${owner} ${info.param}${unit}`;
}

/** `volume 0.8`, `pan -0.3`: the command that sets a lane's static value. */
function laneFormat(lane: AutomationParameter, value: number): string {
  if (lane === "filter") return `${Math.round(value)}`;
  const info = FX_LANE_INFO.get(lane as FxLane);
  if (info?.spec.step === "log" && value >= 100) return `${Math.round(value)}`;
  return num(value);
}

// ── the tree ──────────────────────────────────────────────────────────

function focused(context: MenuContext): Track | undefined {
  return context.score.tracks.find((track) => track.id === context.trackId);
}

export function rootNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  const name = track?.name ?? context.trackId;
  const effects = EFFECT_NAMES.filter((effect) => effectValues(track, effect));
  const automated = AUTOMATION_PARAMETERS.filter(
    (lane) => automationPoints(track, lane).length > 0,
  ).length;
  const tracks = context.score.tracks.length;
  return [
    {
      kind: "menu",
      id: "sound",
      label: "Sound",
      detail: `${name} · ${track?.instrument ?? "?"}`,
      help: "the focused track's instrument, its controls and performance",
      build: soundSectionNodes,
    },
    {
      kind: "menu",
      id: "voice",
      label: "Voice",
      detail: voiceRootDetail(context),
      help: "sing, lyrics, clips, pitch, autotune, formant and vocoder",
      build: voiceRootNodes,
    },
    {
      kind: "menu",
      id: "effects",
      label: "Effects",
      detail: effects.length ? effects.join(" · ") : "none on",
      help: "filter, delay, reverb and more on the focused track",
      build: effectNodes,
    },
    {
      kind: "menu",
      id: "rhythm",
      label: "Rhythm",
      detail: "euclid editor · grooves · kits",
      help: "hits per drum, ready-made grooves and kits",
      build: rhythmNodes,
    },
    {
      kind: "menu",
      id: "chords",
      label: "Chords and key",
      detail: chordsDetail(context),
      help: "the song key and tuning, and how chords play in play mode (Ctrl-P)",
      build: chordNodes,
    },
    {
      kind: "menu",
      id: "mix",
      label: "Mix",
      detail: `${tracks} track${tracks === 1 ? "" : "s"} · ${automated} lane${automated === 1 ? "" : "s"} moving`,
      help: "volume, pan, mute and solo per track, automation and the master",
      build: mixSectionNodes,
    },
    {
      kind: "menu",
      id: "arrange",
      label: "Arrange",
      detail: arrangeDetail(context),
      help: "tracks, song sections, the form, builds, drops, fills and styles",
      build: arrangeRootNodes,
    },
    {
      kind: "menu",
      id: "project",
      label: "Project",
      detail: context.score.time
        ? `${tempoDetail(context.score)} · ${context.score.bars} bars`
        : `${num(context.score.tempoBpm)} BPM · ${context.score.beatsPerBar}/4 · ${context.score.bars} bars`,
      help: "play, tempo, meter, loop, click, export, session, agent and help",
      build: transportNodes,
    },
  ];
}

/**
 * Where each `/menu <id>` opens: the ten topic ids (sound voice effects
 * rhythm chords mix arrange project keys agent) first, then every older id,
 * as a path of menu ids from the root. `keys` opens Project › help and
 * guides; the ? panel itself belongs to the window.
 */
export const SECTION_ALIASES: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    withTopicAliases({
      sound: ["sound"],
      voice: ["voice"],
      effects: ["effects"],
      rhythm: ["rhythm"],
      chords: ["chords"],
      mix: ["mix"],
      arrange: ["arrange"],
      project: ["project"],
      keys: ["project", "help"],
      agent: ["project", "agent"],
      // Older ids, kept as aliases.
      parameters: ["sound"],
      sounds: ["sound", "browse"],
      instruments: ["sound", "browse"],
      performance: ["sound", "performance"],
      expression: ["sound", "performance"],
      clips: ["voice"],
      lyrics: ["voice"],
      autotune: ["voice"],
      sing: ["voice"],
      vocoder: ["voice"],
      formant: ["voice"],
      grooves: ["rhythm", "patterns"],
      groove: ["rhythm", "patterns"],
      patterns: ["rhythm", "patterns"],
      kits: ["rhythm", "kits"],
      euclid: ["rhythm"],
      tuning: ["chords", "tuning"],
      scale: ["chords"],
      key: ["chords"],
      track: ["mix"],
      automation: ["mix", "automation"],
      master: ["mix", "master"],
      tracks: ["arrange", "tracks"],
      music: ["arrange"],
      style: ["arrange", "style"],
      styles: ["arrange", "style"],
      genre: ["arrange", "style"],
      sections: ["arrange", "sections"],
      form: ["arrange"],
      transport: ["project"],
      tempo: ["project", "tempo"],
      meter: ["project", "tempo"],
      time: ["project", "tempo"],
      export: ["project", "export"],
      session: ["project", "session"],
      sessions: ["project", "session"],
      window: ["project", "help"],
      help: ["project", "help"],
      guides: ["project", "help"],
      model: ["project", "agent"],
      audio: ["project", "audio"],
      devices: ["project", "audio"],
      showme: ["project", "agent"],
      models: ["project", "agent"],
      fx: ["effects"],
    }),
  );

/**
 * Every glossary topic alias (`/help drums`, `/guide mixer`) opens the same
 * topic in `/menu` too: a word with no deeper path here opens its topic.
 */
function withTopicAliases(
  paths: Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  const all = { ...paths };
  for (const [word, topic] of Object.entries(TOPIC_ALIASES))
    if (!all[word] && all[topic]) all[word] = all[topic]!;
  return all;
}

/** Sound: the instrument and its controls first, then the instruments. */
function soundSectionNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  const tuning: MenuNode[] =
    track && !isDrumInstrument(track.instrument)
      ? [
          {
            kind: "menu",
            id: "track-tuning",
            label: "track tuning",
            detail: track.tuning
              ? tuningLabel(track.tuning)
              : `song · ${tuningLabel(context.score.tuning)}`,
            help: "this track's tuning, or follow the song",
            build: trackTuningNodes,
          },
        ]
      : [];
  const grainLabel = granularMenuLabel(track);
  const granular: MenuNode[] =
    track && grainLabel
      ? [
          {
            kind: "menu",
            id: "granular",
            label: grainLabel,
            detail: granularMenuDetail(track),
            help: "grain clouds: preset, source, position, scan, grain size, pitch, shimmer",
            build: (inner) => granularMenuNodes(focused(inner)),
          },
        ]
      : [];
  const keys: MenuNode[] =
    track && isOrganFamily(track.instrument) && track.keys
      ? [
          {
            kind: "menu",
            id: "keys",
            label: "keys",
            detail: `${track.instrument}${track.keys.preset ? ` · ${track.keys.preset}` : ""}`,
            help: "the modeled organ: preset, drawbars, registers or stops, rotary",
            build: (inner) => {
              const current = focused(inner);
              return current ? organNodes(current) : [];
            },
          },
        ]
      : track && isKeysFamily(track.instrument) && track.keys
        ? [
            {
              kind: "menu",
              id: "keys",
              label: "keys",
              detail: `${track.instrument}${track.keys.preset ? ` · ${track.keys.preset}` : ""}`,
              help: isElectricFamily(track.instrument)
                ? "electric keys: preset, bark, bell, tone, vibe/trem, pickup and mute"
                : "the modeled piano: preset, touch, hammers, dampers, stretch",
              build: (inner) => {
                const current = focused(inner);
                return current
                  ? keysNodes(current, keysParamsFor(current.instrument))
                  : [];
              },
            },
          ]
        : [];
  // 0.6.1: fretting for strum and the guitar perform mode, on guitar-like
  // tracks (a string voice, a rig, or a guitar setup already stored).
  const guitar: MenuNode[] =
    track &&
    (track.guitar ||
      track.string ||
      RIG_STAGES.some((stage) => track.fx?.[stage] !== undefined))
      ? [
          {
            kind: "menu",
            id: "guitar",
            label: "guitar",
            detail: describeGuitar(track.guitar),
            help: "tuning, capo, hand stretch, ringing open strings and position for strum and chords perform guitar",
            build: (inner) => guitarNodes(focused(inner)),
          },
        ]
      : [];
  return [
    ...parameterNodes(context),
    ...granular,
    ...keys,
    ...guitar,
    ...tuning,
    patchMenuNode(context),
    {
      kind: "menu",
      id: "performance",
      label: "performance",
      detail: performanceDetail(focused(context)),
      help: "articulation, glide, bend, vibrato, pedal, velocity curve, humanize",
      build: performanceNodes,
    },
    {
      kind: "menu",
      id: "browse",
      label: "instruments",
      detail: soundsDetail(focused(context)),
      help: "every instrument: keys, strings, mallets, winds, granular, wavetables, sample packs",
      build: soundNodes,
    },
  ];
}

/** Sound > guitar: Track.guitar rows plus a strum action. */
function guitarNodes(track: Track | undefined): MenuNode[] {
  if (!track) return [];
  const g = track.guitar;
  const tune = g?.tune ?? "standard";
  const tuneName = typeof tune === "string" ? tune : tune.join(" ");
  const int = (
    label: string,
    field: "capo" | "hand" | "position",
    min: number,
    max: number,
    fallback: number,
    help: string,
  ): MenuNode => ({
    kind: "number",
    label,
    help,
    value: g?.[field] ?? fallback,
    min,
    max,
    step: linear(1, min, max),
    format: (value) => num(Math.round(value)),
    command: (value) => `guitar ${field} ${Math.round(value)}`,
  });
  return [
    {
      kind: "choice",
      label: "tune",
      help: "open strings; type guitar tune D A D G A D for your own",
      value: tuneName,
      options: (GUITAR_TUNING_NAMES as readonly string[]).includes(tuneName)
        ? GUITAR_TUNING_NAMES
        : [tuneName, ...GUITAR_TUNING_NAMES],
      command: (option) => `guitar tune ${option}`,
    },
    int(
      "capo",
      "capo",
      0,
      12,
      0,
      "capo fret; chord shapes sound this many semitones up",
    ),
    int("hand", "hand", 3, 6, 4, "how many frets one hand shape may span"),
    {
      kind: "number",
      label: "ring",
      help: "0 closed shapes .. 1 lets open strings ring",
      value: g?.ring ?? 0.5,
      min: 0,
      max: 1,
      step: linear(0.1, 0, 1),
      format: (value) => num(value),
      command: (value) => `guitar ring ${Math.round(value * 10) / 10}`,
    },
    int(
      "position",
      "position",
      0,
      12,
      0,
      "preferred fret position for voicings",
    ),
    {
      kind: "action",
      label: "strum the chords on this track",
      command: "strum",
      help: "replaces block chords with strummed guitar notes",
    },
    {
      kind: "action",
      label: "reset",
      command: "guitar reset",
      help: "standard tuning, no capo",
    },
  ];
}

/** Rhythm: the euclid editor, then grooves and kits. */
function rhythmNodes(context: MenuContext): MenuNode[] {
  return [
    {
      kind: "action",
      label: "euclid editor",
      command: "/euclid",
      help: "hits, steps and rotation per drum",
    },
    patternsMenu(),
    kitsMenu(),
    gridNode(context),
  ];
}

/** The record and euclid grid (Rhythm and Project share this row). */
function gridNode(context: MenuContext): MenuNode {
  return {
    kind: "choice",
    label: "grid",
    help: "the step play-mode recording and the euclid editor snap to",
    value: context.grid,
    options: context.grids,
    command: (option) => `/grid ${option}`,
  };
}

/** Arrange: the tracks first, then sections, form and styles. */
function arrangeRootNodes(context: MenuContext): MenuNode[] {
  const count = context.score.tracks.length;
  return [
    {
      kind: "menu",
      id: "tracks",
      label: "tracks",
      detail: `${count} track${count === 1 ? "" : "s"} · add, focus, move, remove`,
      help: "add a track, focus one, rename, reorder or remove it",
      build: tracksNodes,
    },
    ...arrangeNodes(context),
  ];
}

/** Arrange › tracks: add, focus, rename, move and remove. */
function tracksNodes(context: MenuContext): MenuNode[] {
  const score = context.score;
  const track = focused(context);
  const nodes: MenuNode[] = [
    {
      kind: "entry",
      label: "add a track",
      value: "",
      placeholder: "name, e.g. bass or piano b",
      example: "/track bass",
      help: "a new track with that name (or focus it when it exists)",
      command: (text) => {
        const name = text.trim().replace(/\s+/g, " ");
        return /^[a-z0-9._ -]{1,64}$/i.test(name)
          ? `/track ${name}`
          : undefined;
      },
    },
    ...score.tracks.map((item): MenuNode => ({
      kind: "action",
      label: `${item.id === context.trackId ? "● " : ""}${item.name ?? item.id}`,
      command: `/track ${item.id}`,
      help: `focus ${item.id} · ${item.instrument}`,
    })),
  ];
  if (track) {
    nodes.push({
      kind: "entry",
      label: "rename",
      value: track.name,
      placeholder: "new name",
      command: (text) =>
        text.trim() ? `track name ${text.trim()}` : undefined,
      example: `track name ${track.name}`,
      help: "rename the focused track",
    });
    if (score.tracks.length > 1) {
      const index = score.tracks.findIndex((item) => item.id === track.id);
      nodes.push(
        {
          kind: "number",
          label: "position",
          help: "where the focused track sits in the list",
          value: index + 1,
          min: 1,
          max: score.tracks.length,
          step: linear(1, 1, score.tracks.length),
          format: (value) => `${num(value)} of ${score.tracks.length}`,
          command: (value) => `/track move ${track.id} ${Math.round(value)}`,
        },
        {
          kind: "action",
          label: `remove ${track.id}`,
          command: `/track remove ${track.id}`,
          help: "remove the focused track (^z brings it back)",
        },
      );
    }
  }
  return nodes;
}

/** A file-safe stem for export names: the session's song name or `song`. */
function exportStem(context: MenuContext): string {
  const stem = (context.sessionName ?? "song")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return stem || "song";
}

/** Project › export: the project file and MIDI; audio renders offline. */
function exportNodes(context: MenuContext): MenuNode[] {
  const stem = exportStem(context);
  return [
    {
      kind: "entry",
      label: "project file",
      value: "",
      placeholder: `file name, e.g. ${stem}.track.json`,
      example: `/export ${stem}.track.json`,
      help: "the whole song as one .track.json file (open it with /import)",
      command: (text) => {
        const name = text.trim() || `${stem}.track.json`;
        return /^\S+$/.test(name)
          ? `/export ${/\.json$/i.test(name) ? name : `${name}.track.json`}`
          : undefined;
      },
    },
    {
      kind: "entry",
      label: "MIDI",
      value: "",
      placeholder: `file name, e.g. ${stem}.mid`,
      example: `/export ${stem}.mid`,
      help: "notes, tempo and tracks as a standard MIDI file",
      command: (text) => {
        const name = text.trim() || `${stem}.mid`;
        return /^\S+$/.test(name)
          ? `/export ${/\.midi?$/i.test(name) ? name : `${name}.mid`}`
          : undefined;
      },
    },
    {
      kind: "info",
      label: "WAV and stems",
      value: `dawg render ${stem}.wav`,
      help: "audio renders offline in the shell: dawg render out.wav (--stems for one file per track)",
    },
  ];
}

/** Project › session: rename, fork and resume (the window's verbs). */
function sessionNodes(context: MenuContext): MenuNode[] {
  return [
    {
      kind: "entry",
      label: "rename",
      value: context.sessionName ?? "",
      placeholder: "song name (--auto names it for you)",
      example: "/rename night drive",
      help: "name this session; --auto hands naming back to dawg",
      command: (text) => (text.trim() ? `/rename ${text.trim()}` : undefined),
    },
    {
      kind: "action",
      label: "fork",
      command: "/fork",
      help: "a copy of this session to try something; the original stays",
    },
    {
      kind: "action",
      label: "resume",
      command: "/resume",
      help: "pick an earlier session in this folder",
    },
    {
      kind: "action",
      label: "list sessions",
      command: "/sessions",
      help: "every session in this folder, newest first",
    },
  ];
}

/** Project › agent: the model, show-me and the model key. */
function agentNodes(context: MenuContext): MenuNode[] {
  return [
    {
      kind: "action",
      label: "model",
      command: "/model",
      help: "pick the model the agent runs on",
    },
    ...(context.showMe === undefined
      ? []
      : [
          {
            kind: "choice" as const,
            label: "show me",
            help: "agent turns: its commands as ghost text, faders, keys",
            value: context.showMe,
            options: ["on", "quiet", "off"],
            command: (option: string) => `/showme ${option}`,
          },
        ]),
    {
      kind: "action",
      label: "model key",
      command: "/model key",
      help: "add a model key so typed requests reach the agent (dawg works offline without it)",
    },
    {
      kind: "action",
      label: "agent help",
      command: "/help agent",
      help: "what the agent can do and how its turns show",
    },
  ];
}

/** Project › help and guides: the reference, guides and keys. */
function helpNodes(): MenuNode[] {
  return [
    {
      kind: "action",
      label: "help",
      command: "/help",
      help: "start here: the ten topics",
    },
    {
      kind: "action",
      label: "all commands",
      command: "/help all",
      help: "the full command reference",
    },
    {
      kind: "action",
      label: "guides",
      command: "/guide",
      help: "short walkthroughs, one screen each",
    },
    {
      kind: "action",
      label: "keys",
      command: "/help keys",
      help: "every key in the window (? shows them too)",
    },
  ];
}

/** Mix: this track, every track, automation lanes, then the master. */
function mixSectionNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  const automated = AUTOMATION_PARAMETERS.filter(
    (lane) => automationPoints(track, lane).length > 0,
  ).join(" ");
  return [
    ...trackNodes(context),
    {
      kind: "menu",
      id: "mixer",
      label: "mixer",
      detail: `${context.score.tracks.length} levels on one page`,
      help: "every track's level as a fader, the drawer's all-tracks page (mix) · tab flips to this track",
      build: mixerNodes,
    },
    {
      kind: "menu",
      id: "tracks",
      label: "all tracks",
      detail: `${context.score.tracks.length} · focus another track`,
      help: "pick a track to edit; ● is the focused one",
      build: mixNodes,
    },
    {
      kind: "menu",
      id: "automation",
      label: "automation",
      detail: automated || "no lanes yet",
      help: "points that move a value over the loop",
      build: automationNodes,
    },
    {
      kind: "menu",
      id: "master",
      label: "master",
      detail: context.score.master
        ? describeMaster(context.score.master)
        : "off · bypass",
      help: "the song master on the summed mix: EQ, glue, tape, width, limiter",
      build: masterNodes,
    },
  ];
}

/** Mix › master: the loudness target, then each unit in order. */
function masterNodes(context: MenuContext): MenuNode[] {
  const master = context.score.master;
  // A name only when the LUFS and the limiter ceiling both match it, and no
  // other name shares them (apple and podcast are both -16 at -1 dBTP).
  const matches = LOUDNESS_TARGET_NAMES.filter(
    (name) =>
      LOUDNESS_TARGETS[name].lufs === master?.target &&
      LOUDNESS_TARGETS[name].ceiling ===
        (master?.limiter?.ceiling ?? MASTER_LIMITS.safeCeiling),
  );
  const named =
    matches.length === 1
      ? matches[0]
      : matches.length > 1
        ? `${num(master!.target!)} LUFS`
        : undefined;
  const nodes: MenuNode[] = [
    {
      kind: "choice",
      label: "target",
      value: master?.target === undefined ? "off" : (named ?? "custom"),
      options: ["off", ...LOUDNESS_TARGET_NAMES],
      command: (name) => `master target ${name}`,
      help: "named loudness target; loud ones also load a fast limiter",
    },
    {
      kind: "number",
      label: "target LUFS",
      value: master?.target,
      start: -14,
      off: "off",
      min: MASTER_LIMITS.minTarget,
      max: MASTER_LIMITS.maxTarget,
      step: (value, direction) =>
        clamp(
          Math.round((value + direction * 0.5) * 2) / 2,
          MASTER_LIMITS.minTarget,
          MASTER_LIMITS.maxTarget,
        ),
      format: (value) => `${num(value)} LUFS`,
      command: (value) => `master target ${num(value)}`,
      reset: "master target off",
      help: "integrated loudness renders normalize to (EBU R 128 / BS.1770)",
    },
  ];
  for (const unit of MASTER_UNITS) {
    const spec = MASTER_SPECS[unit];
    const values = master?.[unit];
    nodes.push({
      kind: "menu",
      id: `master:${unit}`,
      label: unit,
      detail: values ? describeUnit(unit, values) : "off",
      help: spec.doc,
      build: (inner) => masterUnitNodes(inner, unit, false),
    });
  }
  nodes.push({
    kind: "action",
    label: "measure the mix",
    command: "master measure",
    help: "render and report LUFS, true peak, LRA, balance and correlation",
  });
  if (master)
    nodes.push({
      kind: "action",
      label: "remove master",
      command: "master off",
      help: "bypass: the mix renders exactly as without a master",
    });
  return nodes;
}

/** One master unit: on/off, preset, its simple params, then `advanced`. */
function masterUnitNodes(
  context: MenuContext,
  unit: MasterUnit,
  advanced: boolean,
): MenuNode[] {
  const spec = MASTER_SPECS[unit];
  const values = context.score.master?.[unit];
  const nodes: MenuNode[] = [];
  if (!advanced) {
    nodes.push({
      kind: "toggle",
      label: "on",
      value: values !== undefined,
      command: (on) => `master ${unit} ${on ? "on" : "off"}`,
      help: `switch the master ${spec.label} on or off`,
    });
    const presets = Object.keys(MASTER_PRESETS[unit]);
    if (presets.length > 0)
      nodes.push({
        kind: "choice",
        label: "preset",
        value: "—",
        options: presets,
        command: (preset) => `master ${unit} preset ${preset}`,
        help: "a starting point; every value stays editable",
      });
  }
  const keys = advanced ? Object.keys(spec.params) : spec.simple;
  for (const key of keys) {
    const param = spec.params[key]!;
    const current = values?.[key];
    // With a target the search sets the limiter's drive; its gain is unused.
    if (
      unit === "limiter" &&
      key === "gain" &&
      context.score.master?.target !== undefined
    ) {
      nodes.push({ kind: "info", label: key, value: "set by target" });
      continue;
    }
    if (param.kind === "number") {
      nodes.push({
        kind: "number",
        label: key,
        value: typeof current === "number" ? current : undefined,
        start: param.default,
        off: values
          ? withUnit(formatParam(param, param.default), param.unit)
          : "off",
        min: param.min,
        max: param.max,
        step: specStep(param),
        format: (value) => withUnit(formatParam(param, value), param.unit),
        command: (value) =>
          `master ${unit} ${key} ${formatParam(param, value)}`,
        help: param.doc,
        ...(values
          ? {
              reset: `master ${unit} ${key} ${formatParam(param, param.default)}`,
            }
          : {}),
      });
    } else if (param.kind === "enum") {
      nodes.push({
        kind: "choice",
        label: key,
        value: typeof current === "string" ? current : param.default,
        options: param.values,
        command: (option) => `master ${unit} ${key} ${option}`,
        help: param.doc,
      });
    } else {
      nodes.push({
        kind: "toggle",
        label: key,
        value: typeof current === "boolean" ? current : param.default,
        command: (on) => `master ${unit} ${key} ${on ? "on" : "off"}`,
        help: param.doc,
      });
    }
  }
  if (!advanced && Object.keys(spec.params).length > spec.simple.length)
    nodes.push({
      kind: "menu",
      id: `master:${unit}:advanced`,
      label: "advanced",
      detail: `all ${Object.keys(spec.params).length} params`,
      build: (inner) => masterUnitNodes(inner, unit, true),
    });
  return nodes;
}

function chordsDetail(context: MenuContext): string {
  const chords = context.chords ?? defaultChordSettings();
  const key = parseKey(context.score.key ?? undefined);
  return `${chords.mode} · ${key ? keyName(key) : "no key"} · ${chords.perform}`;
}

/** Chords and key: the song key and tuning, then play mode's chord settings. */
function chordNodes(context: MenuContext): MenuNode[] {
  const chords = context.chords ?? defaultChordSettings();
  const key = parseKey(context.score.key ?? undefined);
  const tonic = key ? keyName(key).split(" ")[0]! : "C";
  // A library scale (D hijaz, C yaman) survives a tonic change.
  const mode: string = key?.scale ?? key?.mode ?? "major";
  const presets = PROGRESSION_PRESETS.map((preset) => preset.name);
  return [
    {
      kind: "choice",
      label: "mode",
      help: "auto: keys play chords in the song key · manual: latch 1–8 · off",
      value: chords.mode,
      options: CHORD_MODES,
      command: (option) => `/chords ${option}`,
    },
    {
      kind: "choice",
      label: "key tonic",
      help: "the song key; auto chord mode follows it",
      value: tonic,
      options: TONICS,
      command: (option) => `key ${option} ${mode}`,
    },
    {
      kind: "choice",
      label: "key mode",
      help: "major, minor, a church mode or any library scale",
      value: mode,
      options: [...MODE_NAMES, ...SCALE_NAMES],
      command: (option) => `key ${tonic} ${option}`,
    },
    {
      kind: "menu",
      id: "tuning",
      label: "tuning",
      detail: `${tuningLabel(context.score.tuning)} · ${keyLabel(context.score.key)}`,
      help: "the song tuning: 12-TET, EDOs, just, gamelan, Scala, and the scale",
      build: songTuningNodes,
    },
    {
      kind: "number",
      label: "voicing",
      help: "inversion steps up or down (play mode: - =)",
      value: chords.inversion,
      start: 0,
      min: -MAX_VOICING_STEP,
      max: MAX_VOICING_STEP,
      step: linear(1, -MAX_VOICING_STEP, MAX_VOICING_STEP),
      format: (value) => (value > 0 ? `+${value}` : String(value)),
      command: (value) => `/chords voicing ${Math.round(value)}`,
    },
    {
      kind: "choice",
      label: "spread",
      help: "close, open or wide chord voicing",
      value: chords.spread,
      options: SPREADS,
      command: (option) => `/chords spread ${option}`,
    },
    {
      kind: "choice",
      label: "bass",
      help: "what the left hand plays under the chord (play mode: b)",
      value: chords.bass,
      options: BASS_MODES,
      command: (option) => `/chords bass ${option}`,
    },
    {
      kind: "toggle",
      label: "sevenths",
      help: "auto mode plays sevenths instead of triads",
      value: chords.sevenths,
      command: (on) => `/chords sevenths ${on ? "on" : "off"}`,
    },
    {
      kind: "choice",
      label: "perform",
      help: "block, strum, arpeggio or a rhythm pattern (play mode: 9)",
      value: chords.perform,
      options: PERFORM_MODES,
      command: (option) => `/chords perform ${option}`,
    },
    {
      kind: "choice",
      label: "pattern",
      help: "the rhythm used when perform is pattern",
      value: chords.pattern,
      options: CHORD_PATTERNS.map((pattern) => pattern.name),
      command: (option) => `/chords pattern ${option}`,
    },
    // Strum grid and speed only act when perform is guitar.
    ...(chords.perform !== "guitar"
      ? []
      : ([
          {
            kind: "choice",
            label: "strokes",
            help: "guitar strum grid (D down, U up, d u light, x chuck, - rest); type /chords strokes D-DU-UDU for your own",
            value: chords.strokes,
            options: (STROKE_PATTERN_NAMES as readonly string[]).includes(
              chords.strokes,
            )
              ? STROKE_PATTERN_NAMES
              : [chords.strokes, ...STROKE_PATTERN_NAMES],
            command: (option) => `/chords strokes ${option}`,
          },
          {
            kind: "number",
            label: "speed",
            help: "ms a full down stroke takes (0 hits every string at once); type /chords speed 1/32b to set it in beats",
            value: chords.speed,
            min: STROKE_SPEED_MS.min,
            max: STROKE_SPEED_MS.max,
            step: linear(1, STROKE_SPEED_MS.min, STROKE_SPEED_MS.max),
            format: (value) => `${num(value)} ms`,
            command: (value) => `/chords speed ${Math.round(value)}ms`,
          },
        ] satisfies MenuNode[])),
    {
      kind: "choice",
      label: "arp rate",
      help: "arpeggio step length",
      value: chords.rate,
      options: ARP_RATES,
      command: (option) => `/chords rate ${option}`,
    },
    {
      kind: "number",
      label: "arp octaves",
      help: "how many octaves an arpeggio climbs",
      value: chords.octaves,
      start: 1,
      min: 1,
      max: 4,
      step: linear(1, 1, 4),
      format: (value) => `${num(value)} oct`,
      command: (value) => `/chords octaves ${Math.round(value)}`,
    },
    {
      kind: "choice",
      label: "progression",
      help: "a preset the n key walks through",
      value: chords.preset,
      options: ["none", ...presets],
      command: (option) => `/chords preset ${option}`,
    },
    {
      kind: "choice",
      label: "idiom",
      help: "the musical idiom n suggests next chords in (pop, jazz, blues…)",
      value: chords.style,
      options: PROGRESSION_STYLES,
      command: (option) => `/chords style ${option}`,
    },
    {
      kind: "entry",
      label: "progression",
      value: "",
      placeholder: "chords, e.g. i7 IV7 each 8",
      help: "sustained, voice-led block chords on this track in the song key",
      command: (text) =>
        text.trim() ? `progression ${text.trim()}` : undefined,
      example: "progression i7 IV7 each 8",
    },
  ];
}

const TONICS = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;

function trackNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  if (!track)
    return [{ kind: "info", label: "no track", value: "/track <name>" }];
  return [
    {
      kind: "entry",
      label: "name",
      value: track.name,
      placeholder: "new name",
      command: (text) =>
        text.trim() ? `track name ${text.trim()}` : undefined,
      example: `track name ${track.name}`,
      help: "rename the focused track",
    },
    {
      kind: "toggle",
      label: "mute",
      value: track.muted,
      command: (on) => (on ? "mute" : "unmute"),
      help: "silence this track",
    },
    {
      kind: "toggle",
      label: "solo",
      value: track.solo === true,
      command: (on) => (on ? "solo" : "unsolo"),
      help: "hear only soloed tracks",
    },
    volumeNode(track),
    panNode(track),
  ];
}

/**
 * Mix › mixer: one level fader per track (design §8.5), each a typed
 * `volume <track> <0..1>`, so the page sets any track without moving the
 * focus. Labels are numbered, so two tracks with one name stay apart.
 */
export function mixerNodes(context: MenuContext): MenuNode[] {
  return context.score.tracks.map((track, index): MenuNode => {
    const base = volumeNode(track);
    return {
      ...(base as Extract<MenuNode, { kind: "number" }>),
      label: `${index + 1}${track.id === context.trackId ? "›" : " "}${track.name}`,
      command: (value: number) => `volume ${track.id} ${num(value)}`,
      reset: `volume ${track.id} 1`,
      help: `${track.name}'s level; 1 is unity (0 dB) · x resets`,
    };
  });
}

function instrumentNode(track: Track): MenuNode {
  const options: string[] = [...AVAILABLE_INSTRUMENTS, ...KEYS_FAMILIES];
  if (!options.includes(track.instrument)) options.push(track.instrument);
  return {
    kind: "choice",
    label: "instrument",
    value: track.instrument,
    options,
    command: (option) => `instrument ${option}`,
    help: "the sound source; drums use kit",
  };
}

function volumeNode(track: Track): MenuNode {
  return {
    kind: "number",
    label: "volume",
    value: track.volume,
    min: 0,
    max: SCORE_LIMITS.maxVolume,
    step: TRACK_LANE_STEP.volume,
    format: (value) =>
      `${num(value)} · ${value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dB` : "silent"}`,
    command: (value) => `volume ${num(value)}`,
    reset: "volume 1",
    help: "track gain; 1 is unity (0 dB) · x resets",
  };
}

function panNode(track: Track): MenuNode {
  return {
    kind: "number",
    label: "pan",
    value: track.pan,
    min: -1,
    max: 1,
    step: TRACK_LANE_STEP.pan,
    format: (value) =>
      value === 0
        ? "center"
        : `${num(Math.abs(value))} ${value < 0 ? "L" : "R"}`,
    command: (value) => `pan ${num(value)}`,
    reset: "pan 0",
    help: "-1 left … 1 right · x centers",
  };
}

function parameterNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  if (!track) return [];
  const nodes: MenuNode[] = [instrumentNode(track)];
  // A wavetable track also has the synth voice's envelope, filters and FM.
  if (isWavetableInstrument(track.instrument))
    nodes.push(...wavetableNodes(track, context.projectRoot));
  if (isStringTrack(track)) {
    nodes.push(
      ...stringNodes(
        track,
        resolveString(track.string).exciter === "bow"
          ? BOW_SIMPLE_PARAMS
          : STRING_SIMPLE_PARAMS,
      ),
    );
    nodes.push({
      kind: "menu",
      id: "string:advanced",
      label: "advanced",
      detail: `all ${Object.keys(STRING_PARAMS).length} params`,
      help: "every string parameter: exciter, loss, body, buzz, sympathetics, bow (pressure, speed, attack, vib, vibdelay, tremhz, sord, dyn)",
      build: (inner) => {
        const current = focused(inner);
        return current
          ? stringNodes(current, Object.keys(STRING_PARAMS), false)
          : [];
      },
    });
    if (Object.keys(track.string ?? {}).some((key) => key !== "preset"))
      nodes.push({
        kind: "action",
        label: "reset to preset",
        command: "string reset",
        help: "drop this track's string overrides, keep the preset",
      });
    return nodes;
  }
  if (track.sampler) {
    nodes.push({
      kind: "info",
      label: "sampler mode",
      value: track.sampler.mode,
    });
    for (const [voice, ref] of Object.entries(track.sampler.voices).sort()) {
      const extras = [
        ref.root !== undefined ? `root ${ref.root}` : "",
        ref.gain !== undefined ? `gain ${num(ref.gain)}` : "",
        ref.speed !== undefined ? `speed ${num(ref.speed)}` : "",
      ].filter(Boolean);
      nodes.push({
        kind: "menu",
        id: `sample:${voice}`,
        label: voice,
        detail: [ref.src.split("/").at(-1), ...extras].join(" · "),
        help: "this voice's sample controls (Strudel names)",
        build: (context) => sampleVoiceNodes(context, voice),
      });
    }
    nodes.push({
      kind: "info",
      label: "add a voice",
      value: "/sample <path> [as <voice>]",
    });
  } else if (isOrganFamily(track.instrument) && track.keys) {
    // f061-organ: preset, Drawbars/Registers/Stops sub-menus, organ rows.
    nodes.push(...organNodes(track));
  } else if (isKeysFamily(track.instrument) && track.keys) {
    nodes.push(...keysNodes(track, keysSimpleFor(track.instrument)));
    const all = keysParamsFor(track.instrument);
    nodes.push({
      kind: "menu",
      id: "keys:all",
      label: isElectricFamily(track.instrument)
        ? `all ${track.instrument} params`
        : "all piano params",
      detail: `all ${all.length} params`,
      help: isElectricFamily(track.instrument)
        ? "every electric keys parameter for this family"
        : "every modeled piano parameter",
      build: (inner) => {
        const current = focused(inner);
        return current
          ? keysNodes(current, keysParamsFor(current.instrument))
          : [];
      },
    });
  } else if (track.instrument === "modal") {
    // 0.6 modal percussion: preset, mallet and MODAL_PARAMS rows.
    nodes.push(...modalParameterNodes(track));
  } else if (track.instrument === "wind" && track.wind) {
    // 0.6.1 wind engine: preset and WIND_PARAMS rows.
    nodes.push(...windParameterNodes(track));
  } else if (track.instrument === "sing" && track.sing) {
    // 0.7 sing engine: preset, SING_PARAMS rows and a Throat sub-menu.
    nodes.push(
      ...singParameterNodes(track, parseKey(context.score.key)?.tonic),
    );
  } else if (!isDrumInstrument(track.instrument)) {
    nodes.push(...synthNodes(track, SYNTH_SIMPLE));
    nodes.push({
      kind: "menu",
      id: "synth:advanced",
      label: "advanced",
      detail: `all ${Object.keys(SYNTH_PARAMS).length} params`,
      help: "every voice parameter, grouped, under its Strudel name",
      build: synthAdvancedNodes,
    });
    if (track.synth)
      nodes.push({
        kind: "action",
        label: "reset to defaults",
        command: "synth reset",
        help: "clear every voice setting on this track",
      });
  }
  return nodes;
}

/** Number rows for `/sample set`: [control, min, max, step, default]. */
const SAMPLE_NUMBER_ROWS: readonly (readonly [
  SampleControl,
  number,
  number,
  number,
  number,
])[] = [
  ["begin", 0, 0.99, 0.01, 0],
  ["end", 0.01, 1, 0.01, 1],
  ["gain", 0, SCORE_LIMITS.maxSampleGain, 0.05, 1],
  ["speed", -SCORE_LIMITS.maxSampleSpeed, SCORE_LIMITS.maxSampleSpeed, 0.05, 1],
  ["loopBegin", 0, 0.99, 0.01, 0],
  ["loopEnd", 0.01, 1, 0.01, 1],
  ["clip", 0.05, SCORE_LIMITS.maxSampleClip, 0.05, 1],
  [
    "accelerate",
    -SCORE_LIMITS.maxSampleAccelerate,
    SCORE_LIMITS.maxSampleAccelerate,
    0.1,
    0,
  ],
  ["squiz", 1, SCORE_LIMITS.maxSampleSquiz, 0.5, 1],
];

/** One sampler voice: every sample control, run through `/sample set`. */
function sampleVoiceNodes(context: MenuContext, voice: string): MenuNode[] {
  const track = context.score.tracks.find(
    (item) => item.id === context.trackId,
  );
  const ref = track?.sampler?.voices[voice];
  if (!ref) return [];
  const set = (rest: string) => `/sample set ${voice} ${rest}`;
  const nodes: MenuNode[] = [{ kind: "info", label: "file", value: ref.src }];
  for (const [control, min, max, step, start] of SAMPLE_NUMBER_ROWS) {
    const current = (ref as Record<string, unknown>)[control];
    nodes.push({
      kind: "number",
      label: control,
      value: typeof current === "number" ? current : undefined,
      start,
      off: num(start),
      min,
      max,
      step:
        control === "speed"
          ? (value, direction) => {
              // Speed 0 is invalid: step over it.
              const next = linear(step, min, max)(value, direction);
              return next === 0 ? step * direction : next;
            }
          : linear(step, min, max),
      format: num,
      command: (value) => set(`${control} ${num(value)}`),
      reset: set(`${control} off`),
      help: SAMPLE_CONTROLS[control],
    });
  }
  nodes.push(
    {
      kind: "choice",
      label: "unit",
      value: ref.unit ?? "r",
      options: SAMPLE_UNITS,
      command: (option) => set(`unit ${option}`),
      help: SAMPLE_CONTROLS.unit,
    },
    {
      kind: "toggle",
      label: "loop",
      value: ref.loop === true,
      command: (on) => set(`loop ${on ? "on" : "off"}`),
      help: SAMPLE_CONTROLS.loop,
    },
    {
      kind: "toggle",
      label: "fit",
      value: ref.fit === true,
      command: (on) => set(`fit ${on ? "on" : "off"}`),
      help: SAMPLE_CONTROLS.fit,
    },
    {
      kind: "info",
      label: "cut / loopAt",
      value: `/sample set ${voice} cut hats · loopAt 2`,
    },
    // 0.6 fit: the sample's own tempo, its length in beats, and how it fits.
    {
      kind: "number",
      label: "bpm",
      value: ref.bpm,
      start: Math.round(context.score.tempoBpm),
      off: "off",
      min: SCORE_LIMITS.minSampleBpm,
      max: SCORE_LIMITS.maxSampleBpm,
      step: linear(1, SCORE_LIMITS.minSampleBpm, SCORE_LIMITS.maxSampleBpm),
      format: num,
      command: (value) => `/bpm ${num(value)} ${voice}`,
      reset: `/bpm off ${voice}`,
      help: SAMPLE_CONTROLS.bpm,
    },
    {
      kind: "choice",
      label: "fitmode",
      // off: unset (plays as repitch); auto suggests one from the sound.
      value: ref.fitmode ?? "off",
      options: ["off", ...SAMPLE_FIT_MODES, "auto"],
      command: (option) => `/fitmode ${option} ${voice}`,
      help: `${SAMPLE_CONTROLS.fitmode} · beats for drums, tones for pads · set bpm or len first`,
    },
    {
      kind: "number",
      label: "len",
      value: ref.len,
      start: 4,
      off: "off",
      min: 0.25,
      max: SCORE_LIMITS.maxSampleLenBeats,
      step: linear(0.25, 0.25, SCORE_LIMITS.maxSampleLenBeats),
      format: num,
      command: (value) => `/len ${num(value)} ${voice}`,
      reset: `/len off ${voice}`,
      help: SAMPLE_CONTROLS.len,
    },
    // 0.6.1 shift: pitch without changing length, formants kept or moved,
    // and the voice's fade in and out.
    {
      kind: "number",
      label: "shift",
      value: ref.shift,
      start: 0,
      off: "off",
      min: -SCORE_LIMITS.maxSampleShift,
      max: SCORE_LIMITS.maxSampleShift,
      step: linear(
        1,
        -SCORE_LIMITS.maxSampleShift,
        SCORE_LIMITS.maxSampleShift,
      ),
      format: num,
      command: (value) => `/shift ${num(value)} ${voice}`,
      reset: `/shift off ${voice}`,
      help: SAMPLE_CONTROLS.shift,
    },
    {
      kind: "number",
      label: "formant",
      value: ref.formant,
      start: 0,
      off: "follow",
      min: -SCORE_LIMITS.maxSampleShift,
      max: SCORE_LIMITS.maxSampleShift,
      step: linear(
        1,
        -SCORE_LIMITS.maxSampleShift,
        SCORE_LIMITS.maxSampleShift,
      ),
      format: (value) => (value === 0 ? "keep" : num(value)),
      command: (value) => set(`formant ${num(value)}`),
      reset: set("formant off"),
      help: `${SAMPLE_CONTROLS.formant} · needs shift`,
    },
    {
      kind: "number",
      label: "fade in",
      value: ref.fadeInTime,
      start: 0.01,
      off: "off",
      min: 0,
      max: SCORE_LIMITS.maxSampleFadeSeconds,
      step: linear(0.01, 0, SCORE_LIMITS.maxSampleFadeSeconds),
      format: num,
      command: (value) => `/fade in ${num(value)} ${voice}`,
      reset: `/fade in off ${voice}`,
      help: SAMPLE_CONTROLS.fadeInTime,
    },
    {
      kind: "number",
      label: "fade out",
      value: ref.fadeTime,
      start: 0.1,
      off: "off",
      min: 0,
      max: SCORE_LIMITS.maxSampleFadeSeconds,
      step: linear(0.05, 0, SCORE_LIMITS.maxSampleFadeSeconds),
      format: num,
      command: (value) => `/fade out ${num(value)} ${voice}`,
      reset: `/fade out off ${voice}`,
      help: SAMPLE_CONTROLS.fadeTime,
    },
    // 0.6.1 layers: velocity layer (SFZ lovel/hivel) and round-robin group.
    {
      kind: "choice",
      label: "velocity layer",
      value: ref.vel ? `${ref.vel[0]}-${ref.vel[1]}` : "off",
      options: velocityLayerOptions(ref.vel),
      command: (option) => set(`vel ${option}`),
      help: `${SAMPLE_CONTROLS.vel} · two layers: 0-63 and 64-127 · three: 0-42 43-84 85-127`,
    },
    {
      kind: "entry",
      label: "round robin",
      value: ref.rr ?? "",
      placeholder: "group name, e.g. sn",
      command: (text) => set(`rr ${text.trim() || "off"}`),
      example: `/sample set ${voice} rr sn`,
      help: SAMPLE_CONTROLS.rr,
    },
  );
  return nodes;
}

/** Common velocity splits, plus the voice's own range when it is another. */
function velocityLayerOptions(
  vel: readonly [number, number] | undefined,
): string[] {
  const options = ["off", "0-63", "64-127", "0-42", "43-84", "85-127"];
  const own = vel ? `${vel[0]}-${vel[1]}` : undefined;
  return own && !options.includes(own) ? [...options, own] : options;
}

/** Synth preset first, then one row per parameter. */
/** The preset this track's voice still matches exactly, if any. */
function matchingSynthPreset(track: Track): string | undefined {
  if (!track.synth) return undefined;
  const current = JSON.stringify(track.synth);
  return Object.entries(SYNTH_PRESETS).find(
    ([, preset]) =>
      preset.instrument === track.instrument &&
      JSON.stringify(normalizeSynth(preset.synth)) === current,
  )?.[0];
}

/** Modeled piano rows: the preset, then each parameter (`keys <p> <v>`). */
function keysNodes(
  track: Track,
  params: readonly string[],
  presets: readonly string[] = keysPresetNames(track.instrument),
): MenuNode[] {
  const effective = resolvedKeys(track.instrument, track.keys);
  const nodes: MenuNode[] = [
    {
      kind: "choice",
      label: "preset",
      value: track.keys?.preset ?? "—",
      options: presets,
      command: (preset) => `keys preset ${preset}`,
      help: isOrganFamily(track.instrument)
        ? "a starting organ; every value stays editable"
        : isElectricFamily(track.instrument)
          ? "a starting electric piano or clav; every value stays editable"
          : "a starting piano; every value stays editable",
    },
  ];
  for (const key of params) {
    const param = KEYS_PARAMS[key]!;
    const stored = track.keys?.[key];
    if (param.kind === "number") {
      const base = effective[key] as number;
      nodes.push({
        kind: "number",
        label: key,
        value: typeof stored === "number" ? stored : undefined,
        start: base,
        off: withUnit(formatParam(param, base), param.unit),
        min: param.min,
        max: param.max,
        step: specStep(param),
        format: (value) => withUnit(formatParam(param, value), param.unit),
        command: (value) => `keys ${key} ${formatParam(param, value)}`,
        reset: `keys ${key} off`,
        help: param.doc,
      });
    } else if (param.kind === "enum")
      nodes.push({
        kind: "choice",
        label: key,
        value: typeof stored === "string" ? stored : String(effective[key]),
        options: param.values,
        command: (option) => `keys ${key} ${option}`,
        help: param.doc,
      });
  }
  nodes.push({
    kind: "action",
    label: "reset to the family",
    command: "keys reset",
    help: "clear every override and the preset, and the effects the preset added (keeps the family's own sound)",
  });
  return nodes;
}

// ---- f061-organ menu rows -------------------------------------------------

const PIANO_PRESET_NAMES = Object.keys(KEYS_PRESETS).filter((name) =>
  isPianoFamily(KEYS_PRESETS[name]!.instrument),
);
const ORGAN_PRESET_NAMES = Object.keys(KEYS_PRESETS).filter((name) =>
  isOrganFamily(KEYS_PRESETS[name]!.instrument),
);
const ELECTRIC_PRESET_NAMES = Object.keys(KEYS_PRESETS).filter((name) =>
  isElectricFamily(KEYS_PRESETS[name]!.instrument),
);

/** The presets of the track's kind of keys (pianos, electric or organs). */
function keysPresetNames(instrument: string): readonly string[] {
  if (isOrganFamily(instrument)) return ORGAN_PRESET_NAMES;
  if (isElectricFamily(instrument)) return ELECTRIC_PRESET_NAMES;
  return PIANO_PRESET_NAMES;
}

const DRAWBAR_FEET = [
  "16'",
  "5⅓'",
  "8'",
  "4'",
  "2⅔'",
  "2'",
  "1⅗'",
  "1⅓'",
  "1'",
];
const REGISTER_FEET = ["16'", "8'", "4'", "2⅔'", "2'"];

/**
 * One 0-8 row per footage of a digit string (`keys drawbars 888000000`):
 * left/right pull a bar in or out, x puts the whole set back.
 */
function digitNodes(
  name: "drawbars" | "registers",
  text: string,
  feet: readonly string[],
  stored: boolean,
): MenuNode[] {
  const digits = text.split("").map(Number);
  const nodes: MenuNode[] = feet.map((foot, index): MenuNode => {
    const at = (value: number) =>
      digits.map((d, i) => (i === index ? value : d)).join("");
    return {
      kind: "number",
      label: foot,
      value: digits[index]!,
      min: 0,
      max: 8,
      step: (value, direction) => Math.max(0, Math.min(8, value + direction)),
      format: (value) =>
        `${value}  ${"█".repeat(value)}${"·".repeat(8 - value)}`,
      command: (value) => `keys ${name} ${at(value)}`,
      // x resets this bar only, to its default digit.
      reset: `keys ${name} ${at(Number(ORGAN_TEXT[name].default[index] ?? 0))}`,
      help: `${foot} ${name === "drawbars" ? "drawbar" : "register"} 0-8`,
    };
  });
  nodes.push({
    kind: "entry",
    label: `${name} (type)`,
    value: stored ? text : `${text} (default)`,
    placeholder: `${feet.length} digits 0-8`,
    command: (typed) =>
      new RegExp(`^[0-8]{${feet.length}}$`).test(typed.trim())
        ? `keys ${name} ${typed.trim()}`
        : undefined,
    example: `keys ${name} ${text}`,
  });
  return nodes;
}

/** Pipe stops: a registration, then one toggle per stop. */
function stopNodes(text: string): MenuNode[] {
  const on = pipeStops(text);
  const nodes: MenuNode[] = [
    {
      kind: "choice",
      label: "registration",
      value: Object.keys(PIPE_REGISTRATIONS).includes(text) ? text : "—",
      options: Object.keys(PIPE_REGISTRATIONS),
      command: (option) => `keys stops ${option}`,
      help: "a named registration (stops drawn together)",
    },
  ];
  for (const stop of PIPE_STOPS)
    nodes.push({
      kind: "toggle",
      label: stop,
      value: on.includes(stop),
      command: (value) => {
        const next = value
          ? PIPE_STOPS.filter((name) => name === stop || on.includes(name))
          : on.filter((name) => name !== stop);
        return next.length > 0
          ? `keys stops ${next.join(" ")}`
          : "keys stops off";
      },
      help: `draw or retire the ${stop} stop`,
    });
  return nodes;
}

/** The organ's rows: preset, its family's sub-menu, then its parameters. */
function organNodes(track: Track): MenuNode[] {
  const family = track.instrument as OrganFamily;
  const effective = resolvedKeys(track.instrument, track.keys);
  const rows = ORGAN_ROWS[family].filter((row) => row in KEYS_PARAMS);
  const nodes = keysNodes(track, rows, ORGAN_PRESET_NAMES);
  const text = (name: keyof typeof ORGAN_TEXT) =>
    String(effective[name] ?? ORGAN_TEXT[name].default);
  const sub: MenuNode =
    family === "tonewheel"
      ? {
          kind: "menu",
          id: "keys:drawbars",
          label: "drawbars",
          detail: text("drawbars"),
          help: "nine drawbars 16' to 1' (0 in, 8 full out)",
          build: (inner) => {
            const current = focused(inner) ?? track;
            const value = resolvedKeys(current.instrument, current.keys);
            return digitNodes(
              "drawbars",
              String(value.drawbars ?? ORGAN_TEXT.drawbars.default),
              DRAWBAR_FEET,
              current.keys?.drawbars !== undefined,
            );
          },
        }
      : family === "combo"
        ? {
            kind: "menu",
            id: "keys:registers",
            label: "registers",
            detail: text("registers"),
            help: "five combo-organ registers 16' to 2' (0 off, 8 full)",
            build: (inner) => {
              const current = focused(inner) ?? track;
              const value = resolvedKeys(current.instrument, current.keys);
              return digitNodes(
                "registers",
                String(value.registers ?? ORGAN_TEXT.registers.default),
                REGISTER_FEET,
                current.keys?.registers !== undefined,
              );
            },
          }
        : {
            kind: "menu",
            id: "keys:stops",
            label: "stops",
            detail: text("stops"),
            help: "pipe stops and registrations",
            build: (inner) => {
              const current = focused(inner) ?? track;
              const value = resolvedKeys(current.instrument, current.keys);
              return stopNodes(String(value.stops ?? ORGAN_TEXT.stops.default));
            },
          };
  // After the preset row, before the parameters.
  nodes.splice(1, 0, sub);
  return nodes;
}

function synthNodes(track: Track, keys: readonly string[]): MenuNode[] {
  const nodes: MenuNode[] = [];
  if (keys === SYNTH_SIMPLE)
    nodes.push({
      kind: "choice",
      label: "preset",
      value: matchingSynthPreset(track) ?? "—",
      options: Object.keys(SYNTH_PRESETS),
      command: (preset) => `synth preset ${preset}`,
      help: "a starting voice; every value stays editable",
    });
  for (const key of keys)
    nodes.push(synthParamNode(track, key, keys !== SYNTH_SIMPLE));
  return nodes;
}

function synthParamNode(track: Track, key: string, named: boolean): MenuNode {
  const param = SYNTH_PARAMS[key]!;
  const current = track.synth?.[key];
  const aliases = (param.strudel ?? []).filter((name) => name !== key);
  const label = named
    ? aliases.length
      ? `${key} (${aliases.join("/")})`
      : key
    : (SYNTH_LABEL[key] ?? key);
  if (param.kind === "number")
    return {
      kind: "number",
      label,
      value: typeof current === "number" ? current : undefined,
      start: param.default,
      // An unset filter cutoff means no filter, not the default cutoff.
      off: /^(lpf|hpf|bpf)$/.test(key)
        ? "off"
        : withUnit(formatParam(param, param.default), param.unit),
      min: param.min,
      max: param.max,
      step: specStep(param),
      format: (value) => withUnit(formatParam(param, value), param.unit),
      command: (value) => `synth ${key} ${formatParam(param, value)}`,
      reset: `synth ${key} off`,
      help: param.doc,
    };
  if (param.kind === "enum")
    return {
      kind: "choice",
      label,
      value: typeof current === "string" ? current : param.default,
      options: param.values,
      command: (option) => `synth ${key} ${option}`,
      help: param.doc,
    };
  return {
    kind: "toggle",
    label,
    value: typeof current === "boolean" ? current : param.default,
    command: (on) => `synth ${key} ${on ? "on" : "off"}`,
    help: param.doc,
  };
}

/** Plain names for the simple synth rows; the note shows the command name. */
const SYNTH_LABEL: Readonly<Record<string, string>> = {
  lpf: "synth filter",
  lpq: "synth filter res",
  lpenv: "synth filter env",
  vib: "vibrato",
  fm: "FM amount",
};

/** String preset first (simple view), then one row per parameter. */
function stringNodes(
  track: Track,
  keys: readonly string[],
  withPreset = true,
): MenuNode[] {
  const nodes: MenuNode[] = [];
  const preset = STRING_PRESETS[stringPresetOf(track.string)]!;
  if (withPreset)
    nodes.push({
      kind: "choice",
      label: "preset",
      help: preset.doc,
      value: stringPresetOf(track.string),
      options: STRING_PRESET_NAMES,
      command: (name) => `string preset ${name}`,
    });
  for (const key of keys) {
    const param = STRING_PARAMS[key]!;
    const own = track.string?.[key];
    const base = preset.values[key] ?? param.default;
    if (param.kind === "number")
      nodes.push({
        kind: "number",
        label: param.unit ? `${key} ${param.unit}` : key,
        help: param.doc,
        value: typeof own === "number" ? own : undefined,
        start: typeof base === "number" ? base : param.default,
        off: formatParam(
          param,
          typeof base === "number" ? base : param.default,
        ),
        min: param.min,
        max: param.max,
        step: specStep(param),
        format: (value) => formatParam(param, value),
        command: (value) => `string ${key} ${formatParam(param, value)}`,
      });
    else if (param.kind === "enum")
      nodes.push({
        kind: "choice",
        label: key,
        help: param.doc,
        value: typeof own === "string" ? own : String(base),
        options: param.values,
        command: (option) => `string ${key} ${option}`,
      });
  }
  return nodes;
}

/** Every synth parameter, grouped (amplitude, oscillator, FM 1..8, …). */
function synthAdvancedNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  if (!track) return [];
  const nodes: MenuNode[] = SYNTH_GROUPS.map((group) => {
    const set = group.params.filter((key) => track.synth?.[key] !== undefined);
    return {
      kind: "menu",
      id: `synth:${group.id}`,
      label: group.label,
      detail: set.length
        ? set.map((key) => `${key} ${String(track.synth![key])}`).join(" · ")
        : "defaults",
      build: (inner) => {
        const current = focused(inner);
        return current ? synthNodes(current, group.params) : [];
      },
    };
  });
  const partials = track.synth?.partials;
  nodes.push({
    kind: "entry",
    label: "partials",
    value: Array.isArray(partials) ? partials.join(" ") : "—",
    placeholder: "harmonic amplitudes, e.g. 1 0.5 0.33",
    command: (text) =>
      text.trim() ? `synth partials ${text.trim()}` : "synth partials off",
    example: "synth partials 1 0.5 0.33 0.25",
  });
  nodes.push({
    kind: "entry",
    label: "zzfx array",
    value: "—",
    placeholder: "a raw ZzFX array, e.g. ,,129,.01,,.15,2",
    command: (text) => `synth zzfx ${text.trim()}`,
    example: "synth zzfx ,,129,.01,,.15,2",
  });
  return nodes;
}

/** Short help for each wavetable parameter row. */
const WAVETABLE_LABELS: Readonly<Record<WavetableParam, string>> = {
  wt: "position (wt)",
  wtenv: "position env amount",
  wtattack: "position env attack s",
  wtdecay: "position env decay s",
  wtsustain: "position env sustain",
  wtrelease: "position env release s",
  wtrate: "position LFO Hz",
  wtdepth: "position LFO depth",
  warp: "warp",
  wtphaserand: "phase randomness",
};

const WAVETABLE_STEP: Readonly<Record<WavetableParam, number>> = {
  wt: 0.05,
  wtenv: 0.1,
  wtattack: 0.01,
  wtdecay: 0.05,
  wtsustain: 0.05,
  wtrelease: 0.05,
  wtrate: 0.25,
  wtdepth: 0.05,
  warp: 0.05,
  wtphaserand: 0.1,
};

function wavetableNodes(track: Track, projectRoot?: string): MenuNode[] {
  const settings = wavetableOf(track);
  const local = listLocalWavetables(projectRoot);
  const tables: MenuNode[] = [
    ...local.map((path): MenuNode => ({
      kind: "action",
      label: `${path.split("/").pop()}  project · ${path.split("/")[1]}`,
      command: `wt ${path}`,
    })),
    ...BUILTIN_TABLE_NAMES.map((name): MenuNode => ({
      kind: "action",
      label: `${name}  ${BUILTIN_TABLES[name]!.title} · built-in`,
      command: `wt ${name}`,
    })),
    ...Object.entries(UZU_WAVETABLES).map(([set, names]): MenuNode => ({
      kind: "menu",
      id: `wt-${set}`,
      label: set,
      detail: `${names.length} tables · ${WAVETABLE_PACK}`,
      build: () =>
        names.map((name, index): MenuNode => ({
          kind: "action",
          label: `${set}:${index}  ${name}`,
          command: `wt ${set}:${index}`,
        })),
    })),
  ];
  const nodes: MenuNode[] = [
    {
      kind: "menu",
      id: "wavetables",
      label: "table",
      detail: describeTable(settings.table.src),
      build: () => tables,
    },
  ];
  for (const name of Object.keys(WAVETABLE_PARAMS) as WavetableParam[]) {
    const [min, max, fallback] = WAVETABLE_PARAMS[name];
    nodes.push({
      kind: "number",
      label: WAVETABLE_LABELS[name],
      value: settings[name] ?? fallback,
      min,
      max,
      step: linear(WAVETABLE_STEP[name], min, max),
      format: num,
      command: (value) => `${name} ${num(value)}`,
      reset: `${name} ${num(fallback)}`,
    });
  }
  nodes.push({
    kind: "choice",
    label: "warp mode",
    value: settings.warpmode ?? "none",
    options: WARP_MODES,
    command: (option) => `warpmode ${option}`,
  });
  if ((track.wtAutomation?.length ?? 0) > 0)
    nodes.push({
      kind: "info",
      label: "position automation",
      value: `${track.wtAutomation!.length} points · Automation › table position`,
    });
  return nodes;
}

/** Effects in chain order; each opens on its presets and simple params. */
function effectNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  if (!track) return [];
  const node = (effect: EffectName): MenuNode => {
    const spec = effectSpec(effect);
    const values = effectValues(track, effect);
    return {
      kind: "menu",
      id: effect,
      label: spec.label,
      detail: values ? effectSummary(effect, values) : "off",
      help: spec.doc,
      build: (inner) => effectParamNodes(inner, effect, false),
    };
  };
  const rigStages = RIG_STAGES as readonly string[];
  // 0.6.1 shoegaze stages get their own sub-menu.
  const gaze = SHOEGAZE_EFFECTS as readonly string[];
  const more = EFFECT_NAMES.filter(
    (effect) =>
      !CORE_EFFECTS.includes(effect) &&
      !rigStages.includes(effect) &&
      !gaze.includes(effect) &&
      // 0.7: the formant shift lives in Effects > Voice.
      effect !== "formant",
  );
  const gazeOn = SHOEGAZE_EFFECTS.filter((effect) =>
    effectValues(track, effect),
  );
  const shoegaze: MenuNode = {
    kind: "menu",
    id: "shoegaze",
    label: "shoegaze",
    help: "wobble (tremolo-arm bend), bloom (feedback), swell (volume swell), double (two takes); `rig shoegaze` loads them all",
    detail:
      gazeOn.length === 0
        ? "off"
        : gazeOn.map((effect) => effectSpec(effect).label).join(", "),
    build: () => SHOEGAZE_EFFECTS.map(node),
  };
  const moreOn = more.filter((effect) => effectValues(track, effect));
  // 0.6 guitar rig: stomp → head (with its gate) → cab, plus whole rigs.
  const rigOn = RIG_STAGES.filter((stage) => effectValues(track, stage));
  const rig: MenuNode = {
    kind: "menu",
    id: "guitar rig",
    label: "guitar rig",
    help: "stomp box, amp head with noise gate and speaker cabinet; `rig <name>` loads a whole rig",
    detail:
      rigOn.length === 0 ? "off" : (rigPresetOf(track.fx) ?? rigOn.join(" → ")),
    build: (inner) => {
      const current = focused(inner);
      return [
        {
          kind: "choice",
          label: "rig",
          value: rigPresetOf(current?.fx) ?? "—",
          options: [...Object.keys(RIG_PRESETS), "reset"],
          command: (name) => `rig ${name}`,
          help: "a whole rig (stomp, head, cab); every stage stays editable",
        },
        ...RIG_STAGES.map(node),
      ];
    },
  };
  return [
    ...effectPatchMenuNodes(context, track),
    ...CORE_EFFECTS.map(node),
    rig,
    shoegaze,
    // Formant and vocoder live under Voice; this row is the way there.
    ...(voiceEffectRows(context).length > 0
      ? [
          {
            kind: "menu" as const,
            id: "voice",
            label: "voice effects",
            detail: "formant · vocoder · also in Voice",
            help: "formant and vocoder for voices (the same rows as Ctrl-K › Voice)",
            build: voiceEffectRows,
          },
        ]
      : []),
    {
      kind: "menu",
      id: "more effects",
      label: "more effects",
      help: "less common effects, each with the same controls",
      detail:
        moreOn.length > 0
          ? `on: ${moreOn.map((effect) => effectSpec(effect).label).join(", ")}`
          : more.map((effect) => effectSpec(effect).label).join(", "),
      build: () => more.map(node),
    },
    effectPatchMenuNode(),
  ];
}

function effectSummary(
  effect: EffectName,
  values: Readonly<Record<string, number | string | boolean>>,
): string {
  const spec = effectSpec(effect);
  return spec.simple
    .filter((key) => values[key] !== undefined)
    .map((key) => {
      const value = values[key]!;
      const param = spec.params[key]!;
      return `${key} ${typeof value === "number" ? formatParam(param, value) : String(value)}`;
    })
    .join(" · ");
}

/** `800 Hz`, `0.2 s`: a value with its unit, when it has one. */
function withUnit(text: string, unit: string | undefined): string {
  return unit ? `${text} ${unit}` : text;
}

function formatParam(spec: ParamSpec, value: number): string {
  if (spec.kind !== "number") return num(value);
  const text =
    spec.step === "log" && value >= 100 ? `${Math.round(value)}` : num(value);
  // Rounding never leaves the range: attack 0.0001 types as 0.0001, not 0.
  return Number(text) < spec.min ? String(spec.min) : text;
}

/**
 * One effect's rows: on/off, presets, then its simple parameters; the
 * `advanced` submenu holds every parameter with its Strudel names.
 */
export function effectParamNodes(
  context: MenuContext,
  effect: EffectName,
  advanced: boolean,
): MenuNode[] {
  const track = focused(context);
  if (!track) return [];
  const spec = effectSpec(effect);
  const values = effectValues(track, effect);
  const nodes: MenuNode[] = [];
  if (!advanced) {
    nodes.push({
      kind: "toggle",
      label: "on",
      value: values !== undefined,
      command: (on) => `fx ${effect} ${on ? "on" : "off"}`,
      help: `switch the ${spec.label} on or off (settings are kept)`,
    });
    const presets = effectPresetNames(effect);
    if (presets.length > 0)
      nodes.push({
        kind: "choice",
        label: "preset",
        value: "—",
        options: presets,
        command: (preset) => `fx ${effect} preset ${preset}`,
        help: "a starting point; every value stays editable",
      });
    if (effect === "reverb") {
      // Convolution (Strudel `ir`): a generated impulse, or `fx ir <file>`.
      const ir = track.reverb?.ir?.src;
      const current = ir?.startsWith("builtin:")
        ? ir.slice("builtin:".length)
        : (ir ?? "off");
      nodes.push({
        kind: "choice",
        label: "impulse (ir)",
        value: current,
        options: ["off", ...REVERB_IR_BUILTINS],
        command: (choice) => `fx reverb ir ${choice}`,
      });
    }
  }
  const keys = advanced ? Object.keys(spec.params) : spec.simple;
  for (const key of keys) {
    const param = spec.params[key]!;
    const current = values?.[key];
    const label =
      advanced && param.strudel?.length
        ? `${key} (${param.strudel.filter((name) => !name.includes(" ")).join("/")})`
        : key;
    if (param.kind === "number") {
      nodes.push({
        kind: "number",
        label,
        value: typeof current === "number" ? current : undefined,
        start: param.default,
        off: values
          ? withUnit(formatParam(param, param.default), param.unit)
          : "off",
        min: param.min,
        max: param.max,
        step: specStep(param),
        format: (value) => withUnit(formatParam(param, value), param.unit),
        command: (value) => `fx ${effect} ${key} ${formatParam(param, value)}`,
        help: param.doc,
        ...(values
          ? {
              reset: `fx ${effect} ${key} ${formatParam(param, param.default)}`,
            }
          : {}),
      });
    } else if (param.kind === "enum") {
      nodes.push({
        kind: "choice",
        label,
        value: typeof current === "string" ? current : param.default,
        options: param.values,
        command: (option) => `fx ${effect} ${key} ${option}`,
        help: param.doc,
      });
    } else {
      nodes.push({
        kind: "toggle",
        label,
        value: typeof current === "boolean" ? current : param.default,
        command: (on) => `fx ${effect} ${key} ${on ? "on" : "off"}`,
        help: param.doc,
      });
    }
  }
  if (!advanced && effect === "vowel") {
    // 0.7 vowel morph: To picks the target (morph starts halfway), Morph
    // moves between the two; both through `/vowel`.
    const to = values?.to;
    nodes.push(
      {
        kind: "choice",
        label: "to",
        value: typeof to === "string" ? to : "—",
        options: ["—", ...VOWEL_VALUES],
        command: (option) =>
          option === "—" ? "/vowel to off" : `/vowel to ${option}`,
        help: "a second vowel to morph toward (— keeps one vowel)",
      },
      {
        kind: "number",
        label: "morph",
        value: typeof values?.morph === "number" ? values.morph : undefined,
        start: 0.5,
        off: typeof to === "string" ? "0" : "set to first",
        min: 0,
        max: 1,
        step: specStep(spec.params.morph as NumberParam),
        format: (value) => num(value),
        command: (value) =>
          typeof to === "string" ? `/vowel morph ${num(value)}` : `/vowel to o`,
        help: "0 is the vowel, 1 is the to vowel; log-frequency formant glide, automatable as vowel-morph",
        ...(typeof to === "string" ? { reset: "/vowel morph 0" } : {}),
      },
    );
  }
  if (!advanced) {
    nodes.push({
      kind: "menu",
      id: `${effect}:advanced`,
      label: "advanced",
      detail: `all ${Object.keys(spec.params).length} params`,
      help: `Strudel: ${spec.strudel}`,
      build: (inner) => effectParamNodes(inner, effect, true),
    });
    if (values)
      nodes.push({
        kind: "action",
        label: "reset to defaults",
        command: `fx ${effect} reset`,
        help: `put every ${spec.label} value back to its default`,
      });
  }
  return nodes;
}

function automationNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  if (!track) return [];
  // Track lanes, the lanes of effects that are on, and any lane with
  // points; every other effect lane is under "all lanes".
  const shown = AUTOMATION_PARAMETERS.filter((lane) => {
    if (isTrackAutomationParameter(lane)) return true;
    if (automationPoints(track, lane).length > 0) return true;
    const info = FX_LANE_INFO.get(lane as FxLane);
    if (info?.effect === "synth")
      return track.synth?.[info.param] !== undefined;
    if (info?.effect === "string") return track.string !== undefined;
    // Only the lanes this family's engine reads (keys-rotary on organs,
    // keys-hardness on pianos); the rest wait under "all lanes".
    if (info?.effect === "keys")
      return (
        track.keys !== undefined &&
        keysParamsFor(track.instrument).includes(info.param)
      );
    if (info?.effect === "modal") return track.modal !== undefined;
    if (info?.effect === "grain") return track.granular !== undefined;
    if (info?.effect === "wind") return track.wind !== undefined;
    if (info?.effect === "sing") return track.sing !== undefined;
    if (info?.effect === "vocoder") return track.vocoder !== undefined;
    return info !== undefined && effectValues(track, info.effect) !== undefined;
  });
  const hidden = AUTOMATION_PARAMETERS.filter((lane) => !shown.includes(lane));
  const nodes = shown.map((lane) => laneMenu(track, lane));
  if (hidden.length > 0)
    nodes.push({
      kind: "menu",
      id: "lanes:all",
      label: "all lanes",
      detail: `${hidden.length} more effect lanes`,
      build: (inner) => {
        const current = focused(inner);
        return current ? hidden.map((lane) => laneMenu(current, lane)) : [];
      },
    });
  return nodes;
}

function laneMenu(track: Track, lane: AutomationParameter): MenuNode {
  const count = automationPoints(track, lane).length;
  return {
    kind: "menu",
    id: `lane:${lane}`,
    label: laneLabel(lane),
    detail: `${count} point${count === 1 ? "" : "s"}`,
    build: (inner) => laneNodes(inner, lane),
  };
}

/** `4:0.5 8:1` → `automate <lane> points 4:0.5 8:1`, when every pair parses. */
function pointsCommand(
  lane: AutomationParameter,
  text: string,
  exactly?: number,
): string | undefined {
  const pairs = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (pairs.length === 0 || (exactly !== undefined && pairs.length !== exactly))
    return undefined;
  const { min, max } = automationRange(lane);
  for (const pair of pairs) {
    const match = pair.match(/^(\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/);
    if (!match) return undefined;
    const value = Number(match[2]);
    if (value < min || value > max) return undefined;
  }
  return `automate ${lane} points ${pairs.join(" ")}`;
}

function laneNodes(
  context: MenuContext,
  lane: AutomationParameter,
): MenuNode[] {
  const track = focused(context);
  if (!track) return [];
  const { min, max } = automationRange(lane);
  const range = `${laneFormat(lane, min)}…${laneFormat(lane, max)}`;
  const points = automationPoints(track, lane);
  const nodes: MenuNode[] = [
    {
      kind: "entry",
      label: "add points",
      value: range,
      placeholder: "beat:value [beat:value …]",
      command: (text) => pointsCommand(lane, text),
      example: `automate ${lane} points 0:${laneFormat(lane, min)} 4:${laneFormat(lane, max)}`,
    },
    {
      kind: "entry",
      label: "ramp",
      value: "two points",
      placeholder: "from-beat:value to-beat:value",
      command: (text) => pointsCommand(lane, text, 2),
      example: `automate ${lane} points 0:${laneFormat(lane, min)} ${loopTicksOf(context.score) / context.score.ticksPerBeat}:${laneFormat(lane, max)}`,
    },
  ];
  for (const point of points)
    nodes.push({
      kind: "point",
      label: `beat ${num(point.tick / context.score.ticksPerBeat)}`,
      lane,
      beat: point.tick / context.score.ticksPerBeat,
      value: point.value,
    });
  if (points.length > 0)
    nodes.push({
      kind: "action",
      label: "clear lane",
      command: `clear ${lane} automation`,
    });
  return nodes;
}

function mixNodes(context: MenuContext): MenuNode[] {
  return context.score.tracks.map((track): MenuNode => {
    const detail = `vol ${num(track.volume)} · pan ${num(track.pan)}${track.muted ? " · M" : ""}${track.solo ? " · S" : ""}`;
    // Commands act on the focused track, so another track is focused first.
    return track.id === context.trackId
      ? {
          kind: "menu",
          id: `mix:${track.id}`,
          label: `${track.name} ●`,
          detail,
          build: trackNodes,
        }
      : {
          kind: "action",
          label: `${track.name}  ${detail}`,
          command: `/track ${track.id}`,
        };
  });
}

// ── sounds (sample packs) ──────────────────────────────────────────────

function soundsDetail(track: Track | undefined): string {
  const packs = new Set<string>();
  for (const ref of Object.values(track?.sampler?.voices ?? {}))
    if (ref.src.startsWith("pack:")) packs.add(ref.src.slice(5).split("/")[0]!);
  return packs.size ? [...packs].join(" · ") : "kits, instruments, packs";
}

/**
 * The instrument browser: kits and soundfont instruments from the
 * built-in packs (fetched on first use), and the pack list.
 */
function kitsMenu(): MenuNode {
  return {
    kind: "menu",
    id: "kits",
    label: "kits",
    help: "make this a drum track with a synth or sample kit",
    detail: `synth ${SYNTH_KIT_NAMES.join(" ")} · samples ${Object.keys(DEFAULT_KITS).join(" ")}`,
    // Synth kits first (offline), then the pack sample kits.
    build: () => [
      ...kitCatalog().map((entry): MenuNode => ({
        kind: "action",
        label:
          entry.kind === "synth"
            ? `${entry.label} · ${entry.detail}`
            : `${entry.label} · ${DEFAULT_KITS[entry.name]?.pack ?? entry.detail}`,
        command: entry.command,
      })),
      {
        kind: "menu",
        id: "kit-nicknames",
        label: "Strudel banks",
        detail: `${Object.keys(STRUDEL_BANK_ALIASES).length} drum machines by nickname`,
        build: () =>
          Object.entries(STRUDEL_BANK_ALIASES)
            .sort(([, a], [, b]) =>
              a.toLowerCase() < b.toLowerCase() ? -1 : 1,
            )
            .map(([bank, nickname]): MenuNode => ({
              kind: "action",
              label: `${nickname}  ${bank}`,
              command: `/kit ${nickname}`,
            })),
      },
    ],
  };
}

function patternsMenu(): MenuNode {
  return {
    kind: "menu",
    id: "patterns",
    label: "grooves",
    detail: `${DRUM_PATTERNS.length} ready-made drum parts`,
    help: "replace the drum part with a ready-made groove",
    build: () =>
      DRUM_PATTERNS.map((entry): MenuNode => ({
        kind: "action",
        label: `${entry.label}  ${entry.tempo.bpm} BPM · ${entry.tags.join(", ")}`,
        command: `/groove ${entry.name}`,
      })),
  };
}

const GRANULAR_PRESETS_COUNT = granularBrowseNodes().length;

function soundNodes(context: MenuContext): MenuNode[] {
  return [
    {
      kind: "menu",
      id: "group:keys",
      label: "keys",
      help: "modeled pianos, electric keys and organs, built in (no download)",
      detail: `${PIANO_PRESET_NAMES.join(" ")} · electric: ${ELECTRIC_PRESET_NAMES.join(" ")} · organs: ${ORGAN_PRESET_NAMES.join(" ")}`,
      build: () => [
        ...PIANO_PRESET_NAMES.map((name): MenuNode => {
          const preset = KEYS_PRESETS[name]!;
          return {
            kind: "action",
            label: `${name.padEnd(10)} ${preset.doc}`,
            command: `piano ${name}`,
            help: preset.styles,
          };
        }),
        // keys-electric (0.6.1): tine and reed pianos and the clavinet.
        {
          kind: "menu",
          id: "group:keys:electric",
          label: "electric",
          help: "electric pianos (tine, reed) and the clavinet, modeled",
          detail: ELECTRIC_PRESET_NAMES.join(" "),
          build: () =>
            Object.entries(KEYS_PRESETS)
              .filter(([, preset]) => isElectricFamily(preset.instrument))
              .map(([name, preset]): MenuNode => ({
                kind: "action",
                label: `${name.padEnd(10)} ${preset.doc}`,
                command: `keys preset ${name}`,
                help: preset.styles,
              })),
        },
        // f061-organ
        {
          kind: "menu",
          id: "group:organs",
          label: "organs",
          help: "tonewheel, combo and pipe organs on the keys engine",
          detail: ORGAN_PRESET_NAMES.join(" "),
          build: () =>
            ORGAN_PRESET_NAMES.map((name): MenuNode => {
              const preset = KEYS_PRESETS[name]!;
              return {
                kind: "action",
                label: `${name.padEnd(10)} ${preset.doc}`,
                command: name,
                help: preset.styles,
              };
            }),
        },
      ],
    },
    {
      kind: "action",
      label: "wavetable  basic shapes morph · built-in",
      command: "wt basic",
      help: "switch this track to the morphing wavetable synth",
    },
    // 0.6 instrument groups, one per lane.
    malletsMenu(),
    windsMenu(),
    {
      kind: "menu",
      id: "strings",
      label: "strings",
      help: "plucked strings: guitars, basses, sitar, harpsichord, oud, koto…; Bowed: violin to contrabass, sections",
      detail: `${STRING_PRESET_NAMES.length - BOWED_PRESET_NAMES.length} plucked · ${BOWED_PRESET_NAMES.length} bowed · built-in`,
      build: () => [
        ...STRING_PRESET_NAMES.filter(
          (name) => !BOWED_PRESET_NAMES.includes(name),
        ).map((name): MenuNode => ({
          kind: "action",
          label: `${name.padEnd(12)} ${STRING_PRESETS[name]!.doc}`,
          command: `string ${name}`,
          help: STRING_PRESETS[name]!.styles,
        })),
        {
          kind: "menu",
          id: "strings:bowed",
          label: "bowed",
          help: "bowed strings: violin, viola, cello, bass, fiddle, erhu, sections",
          detail: BOWED_PRESET_NAMES.join(" "),
          build: () =>
            BOWED_PRESET_NAMES.map((name): MenuNode => ({
              kind: "action",
              label: `${name.padEnd(12)} ${STRING_PRESETS[name]!.doc}`,
              command: `bowed ${name}`,
              help: STRING_PRESETS[name]!.styles,
            })),
        },
      ],
    },
    {
      kind: "menu",
      id: "granular-browse",
      label: "granular",
      help: "grain clouds from a built-in synth or this track's own sound",
      detail: `${GRANULAR_PRESETS_COUNT} presets · built-in`,
      build: granularBrowseNodes,
    },
    {
      kind: "menu",
      id: "instruments",
      label: "all instruments",
      help: "sampled piano and General MIDI instruments",
      detail: "General MIDI soundfont, piano",
      build: () => [
        {
          kind: "action",
          label: "piano  Salamander grand · piano",
          command: "/pack use piano/piano",
        },
        ...GM_INSTRUMENTS.map((name): MenuNode => ({
          kind: "action",
          label: `${name.replace(/^gm_/, "").replace(/_/g, " ")} · gm`,
          command: `/pack use gm/${name}`,
        })),
      ],
    },
    {
      kind: "entry",
      label: "use a sample",
      value: "",
      help: "type a pack sample name, e.g. dirt-samples/bd:3",
      placeholder: "<pack>/<sound>[:<n>]",
      command: (text) => (text.trim() ? `/pack use ${text.trim()}` : undefined),
      example: "/pack use dirt-samples/bd:3",
    },
    {
      kind: "menu",
      id: "packs",
      label: "sample packs",
      help: "browse built-in packs or add one by URL",
      detail: `${PACK_CATALOG.length} built in`,
      build: () => [
        ...PACK_CATALOG.map((pack): MenuNode => ({
          kind: "action",
          label: `${pack.name}  ${pack.license}`,
          command: `/pack info ${pack.name}`,
        })),
        {
          kind: "entry",
          label: "add a pack",
          value: "",
          placeholder: "manifest URL or github:user/repo",
          command: (text) =>
            text.trim() ? `/pack add ${text.trim()}` : undefined,
          example: "/pack add github:yaxu/clean-breaks",
        },
      ],
    },
  ];
}

function transportNodes(context: MenuContext): MenuNode[] {
  const score = context.score;
  return [
    {
      kind: "action",
      label: context.playing ? "pause" : "play",
      command: context.playing ? "pause" : "play",
      help: "start or stop the loop (space on an empty prompt)",
    },
    {
      kind: "number",
      label: "tempo",
      help: "beats per minute",
      value: score.tempoBpm,
      start: START_TEMPO_BPM,
      min: SCORE_LIMITS.minTempoBpm,
      max: SCORE_LIMITS.maxTempoBpm,
      step: linear(1, SCORE_LIMITS.minTempoBpm, SCORE_LIMITS.maxTempoBpm),
      format: (value) => `${num(value)} BPM`,
      command: (value) => `tempo ${num(value)}`,
    },
    {
      kind: "number",
      label: "beats per bar",
      help: "the meter",
      value: score.beatsPerBar,
      start: START_BEATS_PER_BAR,
      min: 1,
      max: SCORE_LIMITS.maxBeatsPerBar,
      step: linear(1, 1, SCORE_LIMITS.maxBeatsPerBar),
      format: (value) => `${value}/${openingUnit(score)}`,
      command: (value) => openingMeterCommand(score, value),
    },
    tempoMenuNode(context),
    {
      kind: "number",
      label: "loop length",
      help: "how long the loop is",
      value: score.bars,
      start: START_BARS,
      min: 1,
      max: SCORE_LIMITS.maxBars,
      step: linear(1, 1, SCORE_LIMITS.maxBars),
      format: (value) => `${num(value)} bar${value === 1 ? "" : "s"}`,
      command: (value) => `bars ${Math.round(value)}`,
    },
    gridNode(context),
    {
      kind: "toggle",
      label: "click",
      help: "metronome while playing and recording",
      value: context.clickOn,
      command: (on) => `/click ${on ? "on" : "off"}`,
    },
    {
      kind: "choice",
      label: "count-in bars",
      help: "bars of click before recording starts",
      value: String(context.countInBars),
      options: ["0", "1", "2"],
      command: (option) => `/count-in ${option}`,
    },
    {
      kind: "choice",
      label: "calibration",
      help: "sound fixes: 1 chokes hats, tunes toms, levels keys, steadies brass · 0 keeps the legacy sound",
      value: String(score.calibration ?? 0),
      options: Array.from({ length: CALIBRATION_LATEST + 1 }, (_, i) =>
        String(i),
      ),
      command: (option) => `/calibration ${option}`,
    },
    {
      kind: "menu",
      id: "resample",
      label: "resample",
      detail: "track · section · bars → new sample track",
      help: "render a track, an orbit or the mix to a pinned WAV on a new sampler or granular track",
      build: resampleNodes,
    },
    {
      kind: "menu",
      id: "export",
      label: "export",
      detail: "project file · MIDI · WAV",
      help: "save the song as a project file or MIDI; audio renders offline",
      build: exportNodes,
    },
    {
      kind: "menu",
      id: "session",
      label: "session",
      detail: context.sessionName ?? "rename · fork · resume",
      help: "rename, fork or resume a session",
      build: sessionNodes,
    },
    {
      kind: "menu",
      id: "agent",
      label: "agent",
      detail: context.showMe
        ? `show me ${context.showMe}`
        : "model · model key",
      help: "the agent's model, show-me and model key",
      build: agentNodes,
    },
    {
      kind: "menu",
      id: "audio",
      label: "audio",
      detail: context.audio
        ? `out ${context.audio.output} · in ${context.audio.input}`
        : "output · input",
      help: "pick the audio output and input (one each, saved on this machine)",
      build: audioNodes,
    },
    {
      kind: "menu",
      id: "help",
      label: "help and guides",
      detail: "help · guides · keys",
      help: "the command reference, the guides and the keys",
      build: helpNodes,
    },
  ];
}

/** Project › audio: two rows, each opening a device list. */
function audioNodes(context: MenuContext): MenuNode[] {
  const audio = context.audio;
  if (!audio || audio.unavailable)
    return [
      {
        kind: "info",
        label: "devices",
        value: "system default",
        help: audio?.unavailable ?? "device choice needs the native sink",
      },
      {
        kind: "action",
        label: "show audio",
        command: "/audio",
        help: "the current output, input and why choice is unavailable",
      },
    ];
  const list = (
    side: "out" | "in",
    names: readonly string[],
    current: string,
  ): MenuNode[] => [
    {
      kind: "action",
      label: current.startsWith("default") ? "● default" : "default",
      command: `/audio ${side} default`,
      help: "the system default device (follows the system setting)",
    },
    ...names.map((name): MenuNode => ({
      kind: "action",
      label: name === current ? `● ${name}` : name,
      command: `/audio ${side} ${name}`,
      help:
        side === "out"
          ? `play through ${name} (a soft blip confirms it)`
          : `listen on ${name} (audio test meters it)`,
    })),
  ];
  return [
    {
      kind: "menu",
      id: "output",
      label: "output",
      detail: audio.output,
      help: "where dawg plays: Enter picks, Esc goes back",
      build: () => list("out", audio.outputs, audio.output),
    },
    {
      kind: "menu",
      id: "input",
      label: "input",
      detail: audio.input,
      help: "the input to meter now and record from later",
      build: () => list("in", audio.inputs, audio.input),
    },
    {
      kind: "action",
      label: "test",
      command: "/audio test",
      help: "a short tone on the output, then a level meter for the input",
    },
  ];
}

/** Project > Resample: one action per useful source and range. */
function resampleNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  const score = context.score;
  const nodes: MenuNode[] = [];
  if (track) {
    nodes.push(
      {
        kind: "action",
        label: `${track.id} → sampler`,
        command: `resample ${track.id}`,
        help: "render this track (pre-master) to a one-shot sampler track",
      },
      {
        kind: "action",
        label: `${track.id} → granular`,
        command: `resample ${track.id} grain`,
        help: "render this track to a granular track (cloud preset) holding one note",
      },
    );
    for (const section of score.sections)
      nodes.push({
        kind: "action",
        label: `${track.id} · section ${section.name}`,
        command: `resample ${track.id} section ${section.name}`,
        help: `render bars ${section.startBar + 1}-${section.startBar + section.bars} of this track`,
      });
  }
  nodes.push(
    {
      kind: "entry",
      label: "bars",
      value: "",
      placeholder: "a-b [grain]",
      example: "/resample <track> bars 1-2",
      command: (text) => {
        const match = /^\s*(\d{1,4})(?:-(\d{1,4}))?(\s+grain)?\s*$/.exec(text);
        if (!match || !track) return undefined;
        return `resample ${track.id} bars ${match[1]}-${match[2] ?? match[1]}${match[3] ? " grain" : ""}`;
      },
      help: "render a bar range of the focused track",
    },
    {
      kind: "action",
      label: "mix → sampler",
      command: "resample orbit 1",
      help: "pre-master: render every track on orbit 1 (the default bus) without the song master",
    },
    {
      kind: "action",
      label: "master → sampler",
      command: "resample master",
      help: "render the whole song through the master chain",
    },
  );
  return nodes;
}

// ── tuning ────────────────────────────────────────────────────────────

/** Short name of a tuning for a choice row: its library name or table. */
function tuningLabel(tuning: Tuning | undefined): string {
  if (!tuning) return "12-tet";
  if (tuning.name) return tuning.name;
  if (tuning.edo) return `${tuning.edo}-edo`;
  if (tuning.scl) return tuning.scl.split("/").at(-1)!;
  if (tuning.ratios || tuning.cents) return "custom";
  return "12-tet";
}

function keyLabel(key: string | null | undefined): string {
  const parsed = parseKey(key ?? undefined);
  return parsed ? keyName(parsed) : "no key";
}

const ROOT_OPTIONS = [
  "auto",
  "C4",
  "Db4",
  "D4",
  "Eb4",
  "E4",
  "F4",
  "Gb4",
  "G4",
  "Ab4",
  "A4",
  "Bb4",
  "B4",
] as const;

/** Rows shared by the song and track tuning screens. */
function tuningRows(
  tuning: Tuning | undefined,
  prefix: string,
  first: MenuNode,
  song?: Tuning,
): MenuNode[] {
  // A track screen shows the song's ref and root where the track has none.
  const ref = tuning?.ref ?? song?.ref;
  const refFrom =
    tuning?.ref === undefined && ref !== undefined ? " · song" : "";
  const root = tuning?.root ?? song?.root;
  const rootFrom =
    tuning?.root === undefined && root !== undefined ? " · song" : "";
  const nodes: MenuNode[] = [
    first,
    {
      kind: "info",
      label: "steps (cents)",
      value: tuningStepsText(tuning),
      help: describeTuning(tuning),
    },
    {
      kind: "number",
      label: "reference A4",
      help: "12-TET A4 in Hz; the root sounds at its 12-TET pitch from it · x: 440",
      value: ref,
      off: "440 Hz",
      start: 440,
      min: TUNING_LIMITS.minRefHz,
      max: TUNING_LIMITS.maxRefHz,
      step: linear(1, TUNING_LIMITS.minRefHz, TUNING_LIMITS.maxRefHz),
      format: (value) => `${num(value)} Hz${refFrom}`,
      command: (value) => `${prefix} ref ${num(value)}`,
      reset: `${prefix} ref off`,
    },
    {
      kind: "choice",
      label: "root",
      help: song
        ? `the key that plays degree 0; auto follows the song tuning's root${rootFrom ? " (now the song's)" : ""}`
        : "the key that plays degree 0; auto follows the song key",
      value: rootName(root),
      options: ROOT_OPTIONS,
      command: (option) => `${prefix} root ${option}`,
    },
    {
      kind: "choice",
      label: "keys",
      help: "linear: one key per step (Scala) · nearest: each of 12 keys to its nearest step",
      value: tuning?.map ?? "linear",
      options: TUNING_MAPS,
      command: (option) => `${prefix} map ${option}`,
    },
    {
      kind: "entry",
      label: "equal steps",
      value: tuning?.edo ? String(tuning.edo) : "",
      placeholder: "steps per octave, e.g. 22",
      command: (text) =>
        /^\d+$/.test(text.trim()) ? `${prefix} edo ${text.trim()}` : undefined,
      example: `${prefix} edo 22`,
      help: "n equal divisions of the octave",
    },
    {
      kind: "entry",
      label: "Scala file",
      value: tuning?.scl ?? "",
      placeholder: "path to a .scl file",
      command: (text) =>
        text.trim() ? `${prefix} scl ${text.trim()}` : undefined,
      example: `${prefix} scl tunings/meantone.scl`,
      help: "a Scala scale; files outside the project are copied into tunings/",
    },
    {
      kind: "entry",
      label: "ratios",
      value: tuning?.ratios?.join(" ") ?? "",
      placeholder: "just ratios, the last is the period",
      command: (text) =>
        text.trim() ? `${prefix} ratios ${text.trim()}` : undefined,
      example: `${prefix} ratios 9/8 5/4 3/2 2/1`,
      help: "a just-intonation table: ratios for degrees 1..n",
    },
    {
      kind: "entry",
      label: "cents",
      value: tuning?.cents && !tuning.scl ? tuning.cents.join(" ") : "",
      placeholder: "cents, the last is the period",
      command: (text) =>
        /^[-+\d.\s]+$/.test(text.trim())
          ? `${prefix} cents ${text.trim()}`
          : undefined,
      example: `${prefix} cents 231 474 717 955 1200`,
      help: "a table in cents for degrees 1..n",
    },
    {
      kind: "entry",
      label: "keyboard map (.kbm)",
      value: tuning?.kbm ?? "",
      placeholder: "path to a .kbm file, or off",
      command: (text) =>
        text.trim() ? `${prefix} kbm ${text.trim()}` : undefined,
      example: `${prefix} kbm tunings/white.kbm`,
      help: "a Scala keyboard map: which key plays which degree; off removes it",
    },
  ];
  return nodes;
}

/** Project › tuning & scale: the song tuning and the song scale. */
function songTuningNodes(context: MenuContext): MenuNode[] {
  const score = context.score;
  const key = parseKey(score.key ?? undefined);
  const scale = key ? (key.scale ?? key.mode) : "major";
  const tonic = key ? keyName(key).split(" ")[0]! : "C";
  return [
    ...tuningRows(score.tuning, "tuning", {
      kind: "choice",
      label: "tuning",
      help: "the song tuning; every track without its own follows it",
      value: tuningLabel(score.tuning),
      options: TUNING_NAMES,
      command: (option) =>
        option === "12-tet" ? "tuning off" : `tuning ${option}`,
    }),
    {
      kind: "choice",
      label: "scale",
      help: "the song scale: modes, minors, pentatonics, maqam, ragas, Messiaen",
      value: scale,
      options: [...MODE_NAMES, ...SCALE_NAMES],
      command: (option) => `key ${option}`,
    },
    {
      kind: "choice",
      label: "tonic",
      help: "the song key's tonic; keeps the scale",
      value: tonic,
      options: TONICS,
      command: (option) => `key ${option} ${scale}`,
    },
    {
      kind: "action",
      label: "list tunings",
      command: "tuning list",
      help: "every library tuning, by family",
    },
    {
      kind: "action",
      label: "list scales",
      command: "key list",
      help: "every mode and scale, by family",
    },
  ];
}

/** Sound › tuning: the focused track's own tuning, or the song's. */
function trackTuningNodes(context: MenuContext): MenuNode[] {
  const track = focused(context);
  return tuningRows(
    track?.tuning,
    "tuning track",
    {
      kind: "choice",
      label: "tuning",
      help: "song: follow the song tuning · or a tuning for this track only",
      value: track?.tuning ? tuningLabel(track.tuning) : "song",
      options: ["song", ...TUNING_NAMES],
      command: (option) =>
        option === "song" ? "tuning track off" : `tuning track ${option}`,
    },
    context.score.tuning ?? {},
  );
}

// ── controller ────────────────────────────────────────────────────────

type Frame = {
  title: string;
  /** The submenu's node id (`chords`), for `EditMenu.section`. */
  id?: string;
  build: (context: MenuContext) => MenuNode[];
  index: number;
  query: string;
  /**
   * Lists audition the item under the cursor while the loop plays: the
   * hover key, and whether this frame has staged a hover yet.
   */
  hover?: string;
  hovering?: boolean;
};

export const LABEL_WIDTH = 16;

/**
 * A submenu frame whose rows are rebuilt from the parent's fresh build, so
 * values (and the commands closed over them) always follow the score.
 */
function childFrame(
  parent: Frame,
  node: Extract<MenuNode, { kind: "menu" }>,
): Frame {
  return {
    title: node.label,
    id: node.id,
    index: 0,
    query: "",
    hover: `menu:${node.id}`,
    build: (context) => {
      const fresh = parent
        .build(context)
        .find(
          (candidate): candidate is Extract<MenuNode, { kind: "menu" }> =>
            candidate.kind === "menu" && candidate.id === node.id,
        );
      return (fresh ?? node).build(context);
    },
  };
}

export class EditMenu {
  private stack: Frame[] = [];
  private filtering = false;
  /**
   * The fader drawer's front page (design §8.6): the open level's knob page
   * and whether Tab paged to every param. Undefined: plain rows.
   */
  private knobView: { page: string; all: boolean } | undefined;
  /** Typed value for the selected row (`entry` holds the row's label). */
  private entry: { label: string; buffer: string } | undefined;

  get open(): boolean {
    return this.stack.length > 0;
  }

  /** True while the menu takes typed text (a filter or a value). */
  get typing(): boolean {
    return this.filtering || this.entry !== undefined;
  }

  /** The root section open now (`chords`), or undefined at the root. */
  get section(): string | undefined {
    return this.stack[1]?.id;
  }

  /** Open at the root, or at a section id (`effects`, `automation`). */
  show(context: MenuContext, section?: string): void {
    this.stack = [{ title: "menu", build: rootNodes, index: 0, query: "" }];
    this.filtering = false;
    this.entry = undefined;
    // Walk the section path (`automation` is Mix › automation).
    for (const id of section ? (menuSectionPath(context, section) ?? []) : []) {
      const frame = this.stack.at(-1)!;
      const nodes = frame.build(context);
      const index = nodes.findIndex(
        (node) => node.kind === "menu" && node.id === id,
      );
      const node = nodes[index];
      if (node?.kind !== "menu") break;
      frame.index = index;
      this.stack.push(childFrame(frame, node));
    }
  }

  /** Step into the open level's submenu `id`; false when it has none. */
  enter(context: MenuContext, id: string): boolean {
    const frame = this.stack.at(-1);
    if (!frame) return false;
    const nodes = frame.build(context);
    const index = nodes.findIndex(
      (node) => node.kind === "menu" && node.id === id,
    );
    const node = nodes[index];
    if (node?.kind !== "menu") return false;
    frame.index = index;
    this.stack.push(childFrame(frame, node));
    return true;
  }

  /**
   * Open on the level a bare parameter command edits, for the fader drawer:
   * `volume` / `pan` (Mix), `fx filter` / `fx filter cutoff` (that effect,
   * in Effects or its "more effects" list). Returns the label to focus, or
   * undefined when `command` names no such parameter (the menu is closed).
   */
  showFader(context: MenuContext, command: string): string | undefined {
    const words = command.trim().replace(/^\//, "").toLowerCase().split(/\s+/);
    if (words.length === 1 && (words[0] === "volume" || words[0] === "pan")) {
      this.show(context, "mix");
      if (this.stack.length < 2) return this.fail();
      return this.focusLabel(context, words[0]) ?? this.fail();
    }
    if (words[0] !== "fx" || words.length < 2 || words.length > 3)
      return undefined;
    const effect = parseEffectName(words[1]!);
    if (!effect) return undefined;
    const param = words[2] ? parseParamName(effect, words[2]) : undefined;
    if (words[2] && !param) return undefined;
    this.show(context, "effects");
    if (this.stack.length < 2) return this.fail();
    if (!this.descend(context, effect)) {
      if (
        !this.descend(context, "more effects") ||
        !this.descend(context, effect)
      )
        return this.fail();
    }
    const fields = this.faderFields(context);
    const label = param
      ? fields.find((field) => field.label === param)?.label
      : fields.find((field) => field.kind === "number")?.label;
    if (!label) return this.fail();
    return this.focusLabel(context, label) ?? this.fail();
  }

  private fail(): undefined {
    this.close();
    return undefined;
  }

  /** Step into the child menu `id` of the current level. */
  private descend(context: MenuContext, id: string): boolean {
    const frame = this.stack.at(-1);
    if (!frame) return false;
    const nodes = frame.build(context);
    const index = nodes.findIndex(
      (node) => node.kind === "menu" && node.id === id,
    );
    const node = nodes[index];
    if (node?.kind !== "menu") return false;
    frame.index = index;
    this.stack.push(childFrame(frame, node));
    return true;
  }

  /** Put the cursor on the row labelled `label`; returns it when found. */
  private focusLabel(context: MenuContext, label: string): string | undefined {
    const frame = this.stack.at(-1);
    if (!frame) return undefined;
    const index = frame
      .build(context)
      .findIndex((node) => node.label === label);
    if (index < 0) return undefined;
    frame.index = index;
    return label;
  }

  /** Select row `index` of the current level (a click), clearing typing. */
  select(context: MenuContext, index: number): void {
    const frame = this.stack.at(-1);
    if (!frame) return;
    this.entry = undefined;
    this.filtering = false;
    frame.index = clamp(index, 0, Math.max(0, this.nodes(context).length - 1));
  }

  /** The row index under the cursor (the picker's). */
  get index(): number {
    return this.stack.at(-1)?.index ?? 0;
  }

  close(): void {
    this.stack = [];
    this.filtering = false;
    this.entry = undefined;
    this.knobView = undefined;
  }

  /**
   * The knob page of the open level (design §7.3), or undefined where the
   * level has no knobs: Sound (by engine), Mix and its mixer (this track),
   * the master, Project (tempo) and one effect.
   */
  knobPageHere(context: MenuContext): string | undefined {
    const ids = this.stack.slice(1).map((frame) => frame.id ?? "");
    const [top, sub] = ids;
    const track = focused(context);
    if (top === "sound" && ids.length === 1)
      return track ? `sound:${soundFamily(track)}` : undefined;
    if (
      top === "mix" &&
      (ids.length === 1 || (ids.length === 2 && sub === "mixer"))
    )
      return "mix";
    if (top === "mix" && ids.length === 2 && sub === "master") return "master";
    if (top === "project" && ids.length === 1) return "tempo";
    const last = ids.at(-1) ?? "";
    if (top === "effects" && (EFFECT_NAMES as readonly string[]).includes(last))
      return `fx:${last}`;
    return undefined;
  }

  /**
   * Turn the drawer's knob front page on for the open level. `label` is the
   * row the drawer opens on: when it is not one of the knobs (or the level
   * is the mixer), the drawer opens on every param instead. Returns the
   * label to focus, or undefined when the level has no knob page.
   */
  openKnobs(context: MenuContext, label?: string): string | undefined {
    const page = this.knobPageHere(context);
    this.knobView = undefined;
    if (!page) return undefined;
    const frame = this.stack.at(-1)!;
    const fallback = faderSpecs(frame.build(context));
    const knobs = knobFields(context, page, fallback);
    if (knobs.length === 0) return undefined;
    const mixer = frame.id === "mixer";
    const onKnob =
      label === undefined || knobs.some((knob) => knob.label === label);
    this.knobView = { page, all: mixer || !onKnob };
    if (this.knobView.all) return label ?? fallback[0]?.label;
    return label ?? knobs[0]!.label;
  }

  /** Which drawer page is up: the four knobs, every param, or no knobs. */
  get knobPage(): "knobs" | "all" | undefined {
    return this.knobView ? (this.knobView.all ? "all" : "knobs") : undefined;
  }

  /** The knob page id behind the drawer (`sound:synth`, `mix`), if any. */
  get knobPageId(): string | undefined {
    return this.knobView?.page;
  }

  /**
   * Tab in the drawer: flip between the four knobs and every param (on the
   * mixer, between all tracks and this track). Returns the label to focus:
   * `keep` when it is on the new page, else the page's first field.
   */
  pageKnobs(context: MenuContext, keep: string): string | undefined {
    if (!this.knobView) return undefined;
    this.knobView = { ...this.knobView, all: !this.knobView.all };
    const fields = this.faderFields(context);
    return fields.some((field) => field.label === keep)
      ? keep
      : fields[0]?.label;
  }

  /** The visible rows of the current level (filtered). */
  nodes(context: MenuContext): MenuNode[] {
    const frame = this.stack.at(-1);
    if (!frame) return [];
    const all = frame.build(context);
    const needle = frame.query.toLowerCase();
    if (!needle) return all;
    const direct = all.filter((node) =>
      nodeText(node).toLowerCase().includes(needle),
    );
    // At the root a filter also looks two levels down for groups
    // (`/autotune`, `/formant`, `/tuning`) and offers them by path, after
    // the roots that match.
    if (this.stack.length !== 1) return direct;
    return [...direct, ...deepGroups(all, context, needle)];
  }

  private selected(context: MenuContext): MenuNode | undefined {
    const frame = this.stack.at(-1);
    const nodes = this.nodes(context);
    if (!frame || nodes.length === 0) return undefined;
    frame.index = clamp(frame.index, 0, nodes.length - 1);
    return nodes[frame.index];
  }

  key(value: string, context: MenuContext): MenuResult {
    const frame = this.stack.at(-1);
    if (!frame) return { type: "pass" };
    if (value === "\u0003" || value === "\u000c") return { type: "pass" };
    if (this.entry) return this.entryKey(value, context);
    if (this.filtering) {
      if (value === "\u001b") {
        frame.query = "";
        this.filtering = false;
        return { type: "handled" };
      }
      if (KEY_BACKSPACE.has(value)) {
        frame.query = frame.query.slice(0, -1);
        if (!frame.query) this.filtering = false;
        frame.index = 0;
        return { type: "handled" };
      }
      if (KEY_ENTER.has(value) || value === ARROW_DOWN || value === ARROW_UP) {
        this.filtering = false;
        return this.key(value, context);
      }
      if (value.length === 1 && value >= " ") {
        frame.query = (frame.query + value).slice(0, 40);
        frame.index = 0;
        return { type: "handled" };
      }
      return { type: "handled" };
    }
    const nodes = this.nodes(context);
    const node = this.selected(context);
    if (value === "\u001b") {
      if (frame.query) {
        frame.query = "";
        return { type: "handled" };
      }
      // In a list, Esc drops the hovered item and goes back; elsewhere it
      // reverts staged edits first, then goes back as usual.
      if (frame.hover && frame.hovering && context.audition) {
        this.stack.pop();
        return { type: "unhover", key: frame.hover };
      }
      if (context.audition?.dirty) return { type: "revert" };
      this.stack.pop();
      return this.stack.length ? { type: "handled" } : { type: "close" };
    }
    if (value === "/") {
      this.filtering = true;
      frame.query = "";
      return { type: "handled" };
    }
    if (KEY_UP.has(value) || KEY_DOWN.has(value)) {
      const step = KEY_UP.has(value) ? -1 : 1;
      if (nodes.length)
        frame.index = (frame.index + step + nodes.length) % nodes.length;
      return this.hovered(frame, context);
    }
    if (KEY_PAGE_UP.has(value) || KEY_HOME.has(value)) {
      frame.index = 0;
      return this.hovered(frame, context);
    }
    if (KEY_PAGE_DOWN.has(value) || KEY_END.has(value)) {
      frame.index = Math.max(0, nodes.length - 1);
      return this.hovered(frame, context);
    }
    // Space hears the focused track (it still switches a toggle row);
    // `a` and `c` are A/B and context while the window hosts an audition.
    const audition = context.audition ? auditionKey(value) : undefined;
    if (audition && !(audition === "loop" && node?.kind === "toggle"))
      return { type: "audition", key: audition };
    if (!node) return { type: "handled" };
    if (
      KEY_ENTER.has(value) &&
      context.audition?.dirty &&
      (node.kind === "number" ||
        node.kind === "toggle" ||
        node.kind === "point" ||
        node.kind === "info")
    )
      return { type: "keep" };
    // ← → adjust a value; on any other row ← h go back and → l go in
    // (or run the action), and - + do nothing.
    const isValue = isValueNode(node);
    if (isValue && (KEY_LEFT.has(value) || KEY_RIGHT.has(value)))
      return this.nudge(node, KEY_RIGHT.has(value) ? 1 : -1);
    if (!isValue && KEY_BACK.has(value)) return this.back();
    if (!isValue && (KEY_LEFT.has(value) || KEY_RIGHT.has(value)))
      if (!(
        KEY_FORWARD.has(value) &&
        (node.kind === "menu" || node.kind === "action")
      ))
        return { type: "handled" };
    if (KEY_RESET.has(value) && node.kind === "number") {
      const reset =
        node.reset ??
        (node.start !== undefined && node.value !== undefined
          ? node.command(node.start)
          : undefined);
      return reset ? { type: "run", command: reset } : { type: "handled" };
    }
    if (KEY_RESET.has(value) && node.kind === "point")
      return {
        type: "run",
        command: `automate ${node.lane} remove ${num(node.beat)}`,
      };
    if (
      /^[0-9.]$/.test(value) &&
      (node.kind === "number" || node.kind === "point")
    ) {
      this.entry = { label: node.label, buffer: value };
      return { type: "handled" };
    }
    if (KEY_ENTER.has(value) || KEY_FORWARD.has(value) || value === " ") {
      if (node.kind === "menu") {
        // Going back lands on the opened row with the filter cleared.
        if (frame.query) {
          frame.query = "";
          frame.index = Math.max(
            0,
            this.nodes(context).findIndex(
              (candidate) =>
                candidate.kind === "menu" && candidate.id === node.id,
            ),
          );
        }
        this.stack.push(childFrame(frame, node));
        return { type: "handled" };
      }
      if (node.kind === "toggle")
        return { type: "run", command: node.command(!node.value) };
      if (node.kind === "action")
        return frame.hover &&
          context.audition?.looping &&
          (context.audition.stageable ?? isStageable)(node.command)
          ? { type: "choose", command: node.command, key: frame.hover }
          : { type: "run", command: node.command };
      if (node.kind === "choice") {
        const current = node.options.indexOf(node.value);
        this.stack.push({
          title: node.label,
          index: Math.max(0, current),
          query: "",
          hover: node.label,
          build: (fresh) => {
            const parent = this.stack.at(-2);
            const live =
              parent
                ?.build(fresh)
                .find(
                  (candidate): candidate is typeof node =>
                    candidate.kind === "choice" &&
                    candidate.label === node.label,
                ) ?? node;
            // The current value is shown, not re-run: re-confirming a
            // legacy `piano` would otherwise re-voice it as the grand.
            return live.options.map((option): MenuNode =>
              option === live.value
                ? { kind: "info", label: `${option}  ✓`, value: "current" }
                : {
                    kind: "action",
                    label: option,
                    command: live.command(option),
                  },
            );
          },
        });
        return { type: "handled" };
      }
      if (node.kind === "number") return { type: "fader", label: node.label };
      if (node.kind === "entry" || node.kind === "point") {
        this.entry = { label: node.label, buffer: "" };
        return { type: "handled" };
      }
    }
    return { type: "handled" };
  }

  /** After a move: audition the item under the cursor in a list. */
  private hovered(frame: Frame, context: MenuContext): MenuResult {
    if (!frame.hover || !context.audition?.looping) return { type: "handled" };
    const node = this.selected(context);
    const stageable = context.audition?.stageable ?? isStageable;
    if (node?.kind !== "action" || !stageable(node.command))
      return { type: "handled" };
    frame.hovering = true;
    return { type: "hover", command: node.command, key: frame.hover };
  }

  /** ← on a row that is not a value: up one level (never past the root). */
  private back(): MenuResult {
    if (this.stack.length <= 1) return { type: "handled" };
    const left = this.stack.pop();
    if (left?.hover && left.hovering)
      return { type: "unhover", key: left.hover };
    return { type: "handled" };
  }

  private nudge(node: MenuNode, direction: 1 | -1): MenuResult {
    if (node.kind === "number") {
      const next =
        node.value === undefined
          ? (node.start ?? node.min)
          : clamp(node.step(node.value, direction), node.min, node.max);
      if (node.value !== undefined && Math.abs(next - node.value) < 1e-9)
        return { type: "handled" };
      return { type: "run", command: node.command(next) };
    }
    if (node.kind === "point") {
      const { min, max } = automationRange(node.lane);
      const next = clamp(laneStep(node.lane)(node.value, direction), min, max);
      if (Math.abs(next - node.value) < 1e-9) return { type: "handled" };
      return {
        type: "run",
        command: `automate ${node.lane} points ${num(node.beat)}:${laneFormat(node.lane, next)}`,
      };
    }
    if (node.kind === "toggle") {
      const want = direction > 0;
      return want === node.value
        ? { type: "handled" }
        : { type: "run", command: node.command(want) };
    }
    if (node.kind === "choice") {
      const at = node.options.indexOf(node.value);
      const next =
        node.options[clamp(at + direction, 0, node.options.length - 1)];
      return next === undefined || next === node.value
        ? { type: "handled" }
        : { type: "run", command: node.command(next) };
    }
    return { type: "handled" };
  }

  private entryKey(value: string, context: MenuContext): MenuResult {
    const entry = this.entry!;
    if (value === "\u001b") {
      this.entry = undefined;
      return { type: "handled" };
    }
    if (KEY_BACKSPACE.has(value)) {
      entry.buffer = entry.buffer.slice(0, -1);
      return { type: "handled" };
    }
    if (KEY_ENTER.has(value)) {
      const node = this.selected(context);
      this.entry = undefined;
      const command = node ? entryCommand(node, entry.buffer) : undefined;
      if (!command) return { type: "handled" };
      // A committed value clears the filter so its result (a new automation
      // point, a renamed row) is in view, keeping the cursor on the row.
      const frame = this.stack.at(-1)!;
      if (frame.query && node) {
        frame.query = "";
        const index = this.nodes(context).findIndex(
          (candidate) => candidate.label === node.label,
        );
        frame.index = Math.max(0, index);
      }
      return { type: "run", command };
    }
    if (value.length >= 1 && !value.startsWith("\u001b") && value >= " ") {
      entry.buffer = (entry.buffer + value).slice(0, 200);
    }
    return { type: "handled" };
  }

  /**
   * The current level's number and choice rows as fader fields (the drawer's
   * related params: every filter control, every reverb control), built
   * from `context` (the staged score while auditioning).
   */
  faderFields(context: MenuContext): (FaderSpec | KnobField)[] {
    const frame = this.stack.at(-1);
    if (!frame) return [];
    const rows = faderSpecs(frame.build(context));
    if (!this.knobView) return rows;
    if (!this.knobView.all)
      return knobFields(context, this.knobView.page, rows);
    // The mixer's rows are all levels: each wears the orange knob.
    if (frame.id === "mixer")
      return rows.map((row) => ({ ...row, knob: 3 as const }));
    return rows;
  }

  /**
   * Every param of the current level, whichever drawer page is up: the
   * side list a wide drawer shows beside the four knobs.
   */
  pageFields(context: MenuContext): FaderSpec[] {
    const frame = this.stack.at(-1);
    return frame ? faderSpecs(frame.build(context)) : [];
  }

  /** The same fields as committed, for the drawer's `staged ← committed`. */
  faderCommitted(context: MenuContext): FaderSpec[] {
    const audition = context.audition;
    if (!audition?.dirty) return this.faderFields(context);
    return this.faderFields({
      ...context,
      score: audition.committed,
      ...(audition.committedChords ? { chords: audition.committedChords } : {}),
    });
  }

  /**
   * The breadcrumb's steps below the root (`["Arrange", "range"]`), for the
   * picker's and the drawer's titles; `["menu"]` at the root.
   */
  get steps(): readonly string[] {
    const steps = this.stack.slice(1).map((level) => level.title);
    return steps.length ? steps : ["menu"];
  }

  /** The picker the TUI draws for the current level. */
  view(context: MenuContext): MenuView {
    const frame = this.stack.at(-1);
    const nodes = this.nodes(context);
    const index = frame
      ? clamp(frame.index, 0, Math.max(0, nodes.length - 1))
      : 0;
    const selected = nodes[index];
    let suffix = "";
    if (frame?.query || this.filtering) suffix += ` · /${frame?.query ?? ""}`;
    if (this.entry)
      suffix += ` · ${this.entry.label}: ${this.entry.buffer || placeholderFor(selected)}▏`;
    const audition = context.audition;
    if (audition?.status && !this.entry) suffix += ` · ${audition.status}`;
    const crumbs: Crumbs = {
      steps: this.steps,
      ...(audition?.dirty ? { prefix: "● " } : {}),
      ...(suffix ? { suffix } : {}),
    };
    const title = crumbText(crumbs);
    // Changed rows show `staged ← committed` (Elektron's compare, inline).
    const before = new Map<string, string>();
    if (audition?.dirty && frame && !frame.query)
      for (const node of frame.build({
        ...context,
        score: audition.committed,
        ...(audition.committedChords
          ? { chords: audition.committedChords }
          : {}),
      }))
        before.set(node.label, valueText(node));
    const items = nodes.map((node, at) => {
      const now = valueText(node);
      const was = node.kind === "menu" ? undefined : before.get(node.label);
      const shown = was !== undefined && was !== now ? `${now} ← ${was}` : now;
      return {
        label: `${node.label.padEnd(LABEL_WIDTH)} ${shown}`.trimEnd(),
        value: String(at),
      };
    });
    const command = selected ? commandText(selected) : undefined;
    const note = [
      selected ? describe(selected) : "",
      selected?.kind === "number" && command
        ? rowSketch(selected, command, nodes)
        : "",
      command ? `› ${command}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    const hint = this.entry
      ? HINTS.typing
      : this.filtering
        ? HINTS.filtering
        : audition?.looping && frame?.hover && selected?.kind === "action"
          ? HINTS.hover
          : audition && (audition.looping || audition.dirty)
            ? audition.hint
            : selected?.kind === "point"
              ? HINTS.point
              : selected?.kind === "number" ||
                  selected?.kind === "toggle" ||
                  selected?.kind === "choice"
                ? HINTS.value
                : selected?.kind === "action"
                  ? HINTS.action
                  : HINTS.menu;
    return { title, crumbs, items, index, hint, note };
  }
}

/** Rows that hold a value: ← → adjust them instead of navigating. */
function isValueNode(node: MenuNode): boolean {
  return (
    node.kind === "number" ||
    node.kind === "point" ||
    node.kind === "toggle" ||
    node.kind === "choice"
  );
}

/** The focused row's one-line description. */
function describe(node: MenuNode): string {
  if (node.help) return node.help;
  switch (node.kind) {
    case "number":
      return node.reset || node.start !== undefined
        ? "←→ adjust · type a number · x resets"
        : "←→ adjust · type a number";
    case "toggle":
      return "space or enter switches it";
    case "choice":
      return `${node.options.length} choices · enter lists them`;
    case "point":
      return "←→ change · type beat:value · x deletes";
    case "entry":
      return "enter, then type";
    default:
      return "";
  }
}

function placeholderFor(node: MenuNode | undefined): string {
  if (!node) return "";
  if (node.kind === "entry") return node.placeholder;
  if (node.kind === "number")
    return `${node.format(node.min)}…${node.format(node.max)}`;
  if (node.kind === "point") return "value";
  return "";
}

/** Menu rows → fader fields: numbers and choices, in row order. */
export function faderSpecs(nodes: readonly MenuNode[]): FaderSpec[] {
  const fields: FaderSpec[] = [];
  for (const node of nodes) {
    if (node.kind === "number")
      fields.push({
        kind: "number",
        label: node.label,
        value: node.value,
        min: node.min,
        max: node.max,
        step: node.step,
        format: node.format,
        command: node.command,
        parse: (text) => entryCommand(node, text),
        reset: node.reset,
        start: node.start,
        off: node.off,
      });
    else if (node.kind === "choice")
      fields.push({
        kind: "choice",
        label: node.label,
        value: node.value,
        options: node.options,
        command: node.command,
      });
  }
  return fields;
}

function entryCommand(node: MenuNode, text: string): string | undefined {
  const trimmed = text.trim();
  if (node.kind === "entry") return node.command(trimmed);
  if (node.kind === "number") {
    if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
    const value = Number(trimmed);
    if (value < node.min || value > node.max) return undefined;
    return node.command(value);
  }
  if (node.kind === "point") {
    // `0.8` sets the value; `6:0.8` moves to beat 6.
    const { min, max } = automationRange(node.lane);
    const match = trimmed.match(/^(?:(\d+(?:\.\d+)?):)?(-?\d+(?:\.\d+)?)$/);
    if (!match) return undefined;
    const value = Number(match[2]);
    if (value < min || value > max) return undefined;
    if (match[1] !== undefined && Number(match[1]) !== node.beat)
      return `automate ${node.lane} points ${match[1]}:${match[2]}`;
    return `automate ${node.lane} points ${num(node.beat)}:${match[2]}`;
  }
  return undefined;
}

function valueText(node: MenuNode): string {
  switch (node.kind) {
    case "menu":
      return node.detail;
    case "number":
      return node.value === undefined
        ? (node.off ?? "—")
        : node.format(node.value);
    case "toggle":
      return node.value ? "on" : "off";
    case "choice":
      return node.value;
    case "entry":
      return node.value;
    case "point":
      return laneFormat(node.lane, node.value);
    case "info":
      return node.value;
    case "action":
      return "";
  }
}

/** The command a row stands for, shown so the menu teaches commands. */
/** A filter curve, envelope or table position for a focused number row. */
function rowSketch(
  node: Extract<MenuNode, { kind: "number" }>,
  command: string,
  nodes: readonly MenuNode[],
): string {
  const value = node.value ?? node.start ?? node.min;
  return (
    sketchFor(
      command,
      value,
      (param) => {
        for (const sibling of nodes) {
          if (sibling.kind !== "number") continue;
          const text = commandText(sibling);
          if (text && commandParam(text) === param)
            return sibling.value ?? sibling.start;
        }
        return undefined;
      },
      filterTypeOf(nodes),
    ) ?? ""
  );
}

function filterTypeOf(nodes: readonly MenuNode[]): string | undefined {
  const row = nodes.find(
    (node) => node.kind === "choice" && node.label === "type",
  );
  return row?.kind === "choice" && typeof row.value === "string"
    ? row.value
    : undefined;
}

function commandText(node: MenuNode): string | undefined {
  switch (node.kind) {
    case "number":
      return node.command(node.value ?? node.start ?? node.min);
    case "toggle":
      return node.command(!node.value);
    case "choice":
      return node.command(node.value);
    case "entry":
      return node.example;
    case "action":
      return node.command;
    case "point":
      return `automate ${node.lane} points ${num(node.beat)}:${laneFormat(node.lane, node.value)}`;
    default:
      return undefined;
  }
}

/** Menu groups below `nodes` (two levels) whose label matches `needle`. */
function deepGroups(
  nodes: readonly MenuNode[],
  context: MenuContext,
  needle: string,
): MenuNode[] {
  const found: MenuNode[] = [];
  const visit = (list: readonly MenuNode[], path: string, depth: number) => {
    for (const node of list) {
      if (node.kind !== "menu" || found.length >= 12) continue;
      const label = path ? `${path} › ${node.label}` : node.label;
      if (path && node.label.toLowerCase().includes(needle))
        found.push({ ...node, label });
      if (depth < 2) {
        let children: MenuNode[] = [];
        try {
          children = node.build(context);
        } catch {
          continue;
        }
        visit(children, label, depth + 1);
      }
    }
  };
  visit(nodes, "", 0);
  return found;
}

function nodeText(node: MenuNode): string {
  return `${node.label} ${valueText(node)} ${commandText(node) ?? ""}`;
}

/** Every id `/menu <id>` opens: the ten topics first, then older ids. */
export const MENU_SECTIONS: readonly string[] = Object.freeze(
  Object.keys(SECTION_ALIASES),
);

/** The ten topic ids, the roots `/menu` names first. */
export const MENU_TOPICS: readonly string[] = Object.freeze(
  MENU_SECTIONS.slice(0, 10),
);

/** The names `/menu` and `/help menu` list: one per topic, no aliases. */
export const MENU_SHOWN_SECTIONS: readonly string[] = MENU_TOPICS;

/** `/menu`'s usage line: the short form; `/help menu` lists every topic. */
export const MENU_USAGE = "usage: /menu <topic or row> · /help menu lists them";

/**
 * The error for `/menu <section>` when nothing matches: the nearest topic
 * or row name first, so it fits 80 columns, then the short usage.
 */
export function menuUsage(context: MenuContext, section: string): string {
  const names = new Set<string>(MENU_SECTIONS);
  for (const node of rootNodes(context))
    if (node.kind === "menu") {
      let children: MenuNode[] = [];
      try {
        children = node.build(context);
      } catch {
        continue;
      }
      for (const child of children)
        if (child.kind === "menu") names.add(labelName(child.label));
    }
  const near = nearest(section, names);
  return `no menu "${section}"${near ? ` · did you mean /menu ${near}?` : ""} · /menu <topic or row>`;
}

/** A row label without its padded detail: `granular  12 presets` → `granular`. */
function labelName(label: string): string {
  return label
    .split(/\s{2,}/)[0]!
    .trim()
    .toLowerCase();
}

/**
 * The path of menu ids `/menu <section>` walks: a topic or older id from
 * SECTION_ALIASES, else the first menu row (three levels deep, breadth
 * first) whose id or label is `section`. Undefined when nothing matches.
 */
export function menuSectionPath(
  context: MenuContext,
  section: string,
): readonly string[] | undefined {
  const needle = section.trim().toLowerCase();
  if (!needle) return undefined;
  const alias = SECTION_ALIASES[needle];
  if (alias) return alias;
  type Step = { nodes: readonly MenuNode[]; path: readonly string[] };
  let level: Step[] = [{ nodes: rootNodes(context), path: [] }];
  for (let depth = 0; depth < 3 && level.length; depth += 1) {
    const next: Step[] = [];
    for (const { nodes, path } of level) {
      for (const node of nodes) {
        if (node.kind !== "menu") continue;
        const at = [...path, node.id];
        if (node.id === needle || node.label.toLowerCase() === needle)
          return at;
        if (depth < 2) {
          try {
            next.push({ nodes: node.build(context), path: at });
          } catch {
            // A section that cannot build here has no rows to match.
          }
        }
      }
    }
    level = next;
  }
  return undefined;
}

/** A one-track project, for breadcrumbs asked for without a window. */
function breadcrumbContext(): MenuContext {
  return {
    score: createScore({
      tempoBpm: 120,
      bars: 8,
      tracks: [{ id: "keys", name: "keys", instrument: "piano" }],
      notes: [],
    }),
    trackId: "keys",
    playing: false,
    grid: "1/16",
    grids: ["1/16"],
    clickOn: false,
    countInBars: 1,
  };
}

/**
 * `Ctrl-K › Chords and key › tuning`: where `/menu <id>` opens, from the
 * live labels. Undefined when `id` opens nothing.
 */
export function menuPath(
  id: string,
  context: MenuContext = breadcrumbContext(),
): string | undefined {
  const path = menuSectionPath(context, id);
  if (!path) return undefined;
  const labels: string[] = [];
  let nodes: readonly MenuNode[] = rootNodes(context);
  for (const step of path) {
    const node = nodes.find((row) => row.kind === "menu" && row.id === step);
    if (node?.kind !== "menu") return undefined;
    labels.push(node.label);
    nodes = node.build(context);
  }
  return ["Ctrl-K", ...labels].join(" › ");
}
