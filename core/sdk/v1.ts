/**
 * dawg SDK v1: pure builders for `song.ts` and `tracks/<slug>/track.ts`.
 *
 * Author everything in beats; `song()` converts to the integer ticks the
 * score stores. Every function returns frozen plain data, does no I/O and
 * has no dependencies, so this file is vendored unchanged into
 * `.dawg/sdk/v1.ts` and imported as `"dawg"`:
 *
 * ```ts
 * // tracks/bass/track.ts
 * import { track, note, seq } from "dawg";
 * export default track({
 *   name: "bass",
 *   instrument: "bass",
 *   volume: 0.8,
 *   notes: [note("A1", 0, 1), ...seq("E2 G2 A2", { from: 4, step: 0.5 })],
 * });
 *
 * // song.ts
 * import { song } from "dawg";
 * import bass from "./tracks/bass/track.ts";
 * export default song({ tempo: 120, meter: [4, 4], bars: 4, tracks: [bass] });
 * ```
 *
 * Additions to v1 are backwards compatible: new optional fields default to
 * the old behaviour and files that do not use them reprint byte-for-byte.
 */

/** SDK release; dawg refreshes the vendored copy when its own is newer. */
export const SDK_VERSION = "1.35.0";
/** Major of `SDK_VERSION`; `dawg.json` records it as `sdk`. */
export const SDK_MAJOR = 1;

/** Ticks per beat the score uses unless `song({ ticksPerBeat })` says otherwise. */
export const DEFAULT_TICKS_PER_BEAT = 480;
/** Velocity used when a note or hit omits it. */
export const DEFAULT_VELOCITY = 0.8;
/** Length in beats used when a hit omits it (a sixteenth at 4/4). */
export const DEFAULT_HIT_LENGTH = 0.25;

/** A MIDI number 0..127 or a pitch name such as `"C4"`, `"F#2"`, `"Bb3"`. */
export type Pitch = number | string;

/** Thrown by every builder when its input is malformed; the message names the field. */
export class DawgSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DawgSdkError";
  }
}

// ---------------------------------------------------------------------------
// Pitches

const SEMITONES: Readonly<Record<string, number>> = Object.freeze({
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
});

/**
 * MIDI number for a pitch name (`"A4"` → 69, `"C#3"` → 49, `"Bb2"` → 46;
 * octaves -1..9, case-insensitive). Numbers 0..127 pass through.
 * Throws `DawgSdkError` otherwise.
 */
export function midi(pitch: Pitch): number {
  if (typeof pitch === "number") {
    if (Number.isInteger(pitch) && pitch >= 0 && pitch <= 127) return pitch;
    throw new DawgSdkError(`pitch must be a MIDI integer 0..127: ${pitch}`);
  }
  const match =
    typeof pitch === "string"
      ? pitch.trim().match(/^([a-gA-G])([#b]?)(-?\d{1,2})$/)
      : null;
  if (!match)
    throw new DawgSdkError(
      `pitch must be a name like "C4" or "F#2": ${JSON.stringify(pitch)}`,
    );
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  const value =
    (Number(match[3]) + 1) * 12 +
    SEMITONES[match[1]!.toLowerCase()]! +
    accidental;
  if (value < 0 || value > 127)
    throw new DawgSdkError(`pitch is outside MIDI 0..127: ${pitch}`);
  return value;
}

/**
 * A pitch with an optional cents suffix (SDK 1.16.0): `"E4-14c"` is E4
 * fourteen cents flat, `"A3+50c"` a quarter tone sharp. The offset is
 * static and sits on top of the song or track tuning; ±1200 at most.
 */
export function pitchCents(pitch: Pitch): Readonly<{
  pitch: number;
  cents: number;
}> {
  const match =
    typeof pitch === "string"
      ? pitch.trim().match(/^(.+?)([+-]\d+(?:\.\d+)?)c$/)
      : null;
  if (!match) return { pitch: midi(pitch), cents: 0 };
  const cents = Number(match[2]);
  if (!(Math.abs(cents) <= 1200))
    throw new DawgSdkError(`pitch cents must be within ±1200: ${pitch}`);
  return { pitch: midi(match[1]!), cents };
}

// ---------------------------------------------------------------------------
// Drum voices (General MIDI numbers, same table as dawg's `kit`)

/** Drum voice names a `kit` track understands in `hit()`. */
export type DrumVoice =
  "kick" | "snare" | "clap" | "rim" | "tom" | "hat" | "openhat";

/** GM pitch stored for each kit voice; `hit("kick", 0)` writes pitch 36. */
export const DRUM_PITCHES: Readonly<Record<DrumVoice, number>> = Object.freeze({
  kick: 36,
  rim: 37,
  snare: 38,
  clap: 39,
  hat: 42,
  tom: 45,
  openhat: 46,
});

const DRUM_ALIASES: Readonly<Record<string, DrumVoice>> = Object.freeze({
  kick: "kick",
  bd: "kick",
  snare: "snare",
  sd: "snare",
  clap: "clap",
  cp: "clap",
  rim: "rim",
  rimshot: "rim",
  perc: "rim",
  tom: "tom",
  lt: "tom",
  hat: "hat",
  hh: "hat",
  hihat: "hat",
  "hi-hat": "hat",
  closedhat: "hat",
  "closed-hat": "hat",
  chh: "hat",
  openhat: "openhat",
  "open-hat": "openhat",
  ohh: "openhat",
  oh: "openhat",
  open: "openhat",
});

/** Instrument names dawg treats as the synthesized drum kit. */
export const KIT_INSTRUMENTS: readonly string[] = Object.freeze([
  "kit",
  "drums",
  "drum",
  "drumkit",
]);

/** Instrument name that selects a track's sampler. */
export const SAMPLER_INSTRUMENT = "sampler";
/** First pitch slot given to one-shot sampler voices (voice names sorted). */
export const SAMPLER_FIRST_SLOT = 36;

// ---------------------------------------------------------------------------
// Notes and hits

/** A pitched note in beats. Build with `note()` or `seq()`. */
export type NoteSpec = Readonly<{
  kind: "note";
  /** MIDI 0..127. */
  pitch: number;
  /** Start in beats from the loop start, ≥ 0. */
  start: number;
  /** Length in beats, > 0. */
  length: number;
  /** 0..1. */
  velocity: number;
  /** Static offset in cents from a `"E4-14c"` pitch (SDK 1.16.0); absent is 0. */
  cents?: number;
}> &
  NoteExpressionSpec;

/** A drum or sampler hit addressed by voice name; resolved to a pitch slot by `track()`. */
export type HitSpec = Readonly<{
  kind: "hit";
  voice: string;
  start: number;
  length: number;
  velocity: number;
}> &
  NoteExpressionSpec;

/** How a note is articulated (SDK 1.15.0). */
export type Articulation =
  "staccato" | "legato" | "accent" | "tenuto" | "marcato" | "ghost";

export const ARTICULATIONS: readonly Articulation[] = Object.freeze([
  "staccato",
  "legato",
  "accent",
  "tenuto",
  "marcato",
  "ghost",
]);

/** A pitch-bend point: `[at, cents]`, `at` 0..1 through the note. */
export type BendPoint = readonly [number, number];

/**
 * How one note is played (SDK 1.15.0). Every field is optional.
 *
 * ```ts
 * note("C4", 0, 1, 0.8, { art: "staccato" })
 * note("E4", 1, 2, 0.8, { glide: 0.1, vibrato: { depth: 30, delay: 0.3 } })
 * note("G4", 3, 1, 0.8, { bend: [[0, -200], [0.25, 0]] }) // scoop up a tone
 * ```
 */
export type Expression = Readonly<{
  /**
   * `staccato` (half length), `legato` (held into the next note),
   * `accent` (louder), `tenuto` (full length, a little louder), `marcato`
   * (two-thirds length, much louder) or `ghost` (half length, much softer).
   */
  articulation?: Articulation;
  /** Short alias of `articulation`. */
  art?: Articulation;
  /** Portamento into this note from the track's previous pitch, seconds (0..10). */
  glide?: number;
  /** Pitch curve in cents as `[at, cents]` points, `at` 0..1 through the note; linear between points. */
  bend?: readonly BendPoint[];
  /** Vibrato: `rate` Hz (default 5.5), `depth` cents either side (default 20), `delay` seconds before it fades in. */
  vibrato?: Readonly<{ rate?: number; depth?: number; delay?: number }>;
  /**
   * This note's humanize (SDK 1.15.0), replacing the track's amounts:
   * `{ timing ms, velocity %, length % }`; `{}` keeps the note exact.
   * Humanize just bars 5-8 with `expr({ humanize: { timing: 10 } }, ...)`.
   */
  humanize?: Readonly<{ timing?: number; velocity?: number; length?: number }>;
  /** The sung vowel on a `sing()` track (SDK 1.32.0): `"a"` .. `"u"` or a morph `"a>o"`. */
  vowel?: string;
  /** The syllable sung on this note (SDK 1.32.0): no spaces, `_` holds the previous one. */
  lyric?: string;
  /**
   * On an autotune guide note (SDK 1.33.0): the share of slow pitch drift
   * removed, 0..1, overriding the track's `autotune` drift.
   */
  drift?: number;
}>;

/** The expression a built note carries; fields are present only when set. */
export type NoteExpressionSpec = Readonly<{
  articulation?: Articulation;
  glide?: number;
  bend?: readonly BendPoint[];
  vibrato?: Readonly<{ rate: number; depth: number; delay?: number }>;
  humanize?: Readonly<{ timing?: number; velocity?: number; length?: number }>;
  vowel?: string;
  lyric?: string;
  drift?: number;
}>;

const DEFAULT_VIBRATO_RATE = 5.5;
const DEFAULT_VIBRATO_DEPTH = 20;

function expression(
  input: Expression | undefined,
  label: string,
): NoteExpressionSpec {
  if (input === undefined) return {};
  if (!isRecord(input))
    throw new DawgSdkError(`${label} expression must be an object`);
  for (const key of Object.keys(input))
    if (
      ![
        "articulation",
        "art",
        "glide",
        "bend",
        "vibrato",
        "humanize",
        "vowel",
        "lyric",
        "drift",
      ].includes(key)
    )
      throw new DawgSdkError(
        `${label} expression has an unknown field "${key.slice(0, 32)}" (articulation glide bend vibrato humanize vowel lyric drift)`,
      );
  const out: {
    articulation?: Articulation;
    glide?: number;
    bend?: readonly BendPoint[];
    vibrato?: Readonly<{ rate: number; depth: number; delay?: number }>;
    humanize?: Readonly<{
      timing?: number;
      velocity?: number;
      length?: number;
    }>;
    vowel?: string;
    lyric?: string;
    drift?: number;
  } = {};
  const articulation = input.articulation ?? input.art;
  if (articulation !== undefined) {
    if (!ARTICULATIONS.includes(articulation))
      throw new DawgSdkError(
        `${label} articulation must be one of ${ARTICULATIONS.join(" ")}`,
      );
    out.articulation = articulation;
  }
  if (input.glide !== undefined) {
    const glide = finite(input.glide, `${label} glide`);
    if (glide < 0) throw new DawgSdkError(`${label} glide must be ≥ 0`);
    out.glide = glide;
  }
  if (input.bend !== undefined) {
    if (!Array.isArray(input.bend) || input.bend.length > 32)
      throw new DawgSdkError(
        `${label} bend must be at most 32 [at, cents] points`,
      );
    if (input.bend.length > 0)
      out.bend = Object.freeze(
        input.bend.map((point: unknown, index: number): BendPoint => {
          if (!Array.isArray(point) || point.length !== 2)
            throw new DawgSdkError(
              `${label} bend[${index}] must be [at, cents]`,
            );
          return Object.freeze([
            unit(point[0], `${label} bend[${index}] at`),
            finite(point[1], `${label} bend[${index}] cents`),
          ] as const);
        }),
      );
  }
  if (input.vibrato !== undefined) {
    if (!isRecord(input.vibrato))
      throw new DawgSdkError(`${label} vibrato must be { rate, depth, delay }`);
    const delay =
      input.vibrato.delay === undefined
        ? 0
        : finite(input.vibrato.delay, `${label} vibrato delay`);
    out.vibrato = Object.freeze({
      rate: finite(
        input.vibrato.rate ?? DEFAULT_VIBRATO_RATE,
        `${label} vibrato rate`,
      ),
      depth: finite(
        input.vibrato.depth ?? DEFAULT_VIBRATO_DEPTH,
        `${label} vibrato depth`,
      ),
      ...(delay !== 0 ? { delay } : {}),
    });
  }
  if (input.humanize !== undefined) {
    if (!isRecord(input.humanize))
      throw new DawgSdkError(
        `${label} humanize must be { timing, velocity, length }`,
      );
    const amounts: Record<string, number> = {};
    for (const key of Object.keys(input.humanize)) {
      if (key !== "timing" && key !== "velocity" && key !== "length")
        throw new DawgSdkError(
          `${label} humanize has an unknown field "${key.slice(0, 32)}" (timing velocity length)`,
        );
      const value = finite(input.humanize[key], `${label} humanize ${key}`);
      if (value < 0)
        throw new DawgSdkError(`${label} humanize ${key} must be ≥ 0`);
      if (value > 0) amounts[key] = value;
    }
    out.humanize = Object.freeze(amounts);
  }
  if (input.vowel !== undefined)
    out.vowel = singVowel(input.vowel, `${label} vowel`);
  if (input.lyric !== undefined) out.lyric = lyricInput(input.lyric, label);
  if (input.drift !== undefined) {
    const drift = finite(input.drift, `${label} drift`);
    if (drift < 0 || drift > 1)
      throw new DawgSdkError(`${label} drift must be 0..1`);
    out.drift = drift;
  }
  return out;
}

/** A note's lyric: one syllable, no whitespace, at most 32 characters. */
function lyricInput(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > LYRIC_LIMIT ||
    /\s/u.test(value)
  )
    throw new DawgSdkError(
      `${label} lyric must be one syllable of 1..${LYRIC_LIMIT} characters without spaces`,
    );
  return value;
}

/**
 * The same expression on many notes or hits (SDK 1.15.0); a note's own
 * fields win.
 *
 * ```ts
 * notes: expr(seq("C2 C2 Eb2 C3", { step: 0.25 }), { art: "staccato" })
 * ```
 */
export function expr<T extends NoteSpec | HitSpec>(
  notes: readonly T[],
  expression_: Expression,
): readonly T[] {
  if (!Array.isArray(notes))
    throw new DawgSdkError("expr needs an array of notes or hits");
  const shared = expression(expression_, "expr");
  return Object.freeze(
    notes.map((item, index) => {
      if (!isRecord(item) || (item.kind !== "note" && item.kind !== "hit"))
        throw new DawgSdkError(
          `expr notes[${index}] must come from note(), seq(), hit() or hits()`,
        );
      return Object.freeze({ ...shared, ...item }) as T;
    }),
  );
}

/**
 * One note. `pitch` is a name or MIDI number, `start` and `length` are
 * beats, `velocity` defaults to 0.8, and `how` adds expression
 * (articulation, glide, bend, vibrato; SDK 1.15.0). A cents suffix detunes
 * one note (SDK 1.16.0): `"E4-14c"` (see `pitchCents`).
 *
 * ```ts
 * note("A1", 0, 1)          // A1 on the downbeat for one beat
 * note("A1", 1.5, 0.5, 0.6) // off-beat eighth, softer
 * note("A1", 2, 1, 0.8, { art: "staccato" })
 * note("E4-14c", 2)         // a just major third over C, 14 cents flat
 * ```
 */
export function note(
  pitch: Pitch,
  start: number,
  length = 1,
  velocity = DEFAULT_VELOCITY,
  how?: Expression,
): NoteSpec {
  const tuned = pitchCents(pitch);
  return Object.freeze({
    kind: "note",
    pitch: tuned.pitch,
    start: beat(start, "note start"),
    length: positive(length, "note length"),
    velocity: unit(velocity, "note velocity"),
    ...expression(how, "note"),
    ...(tuned.cents !== 0 ? { cents: tuned.cents } : {}),
  });
}

/** Options for `seq()`. */
export type SeqOptions = Readonly<{
  /** Beat of the first step, default 0. */
  from?: number;
  /** Beats between steps, default 1. */
  step?: number;
  /** Length of each note in beats, default `step`. */
  len?: number;
  /** Velocity of each note, default 0.8. */
  vel?: number;
}>;

/**
 * A step sequence: pitches separated by spaces (or an array), one per
 * `step` beats starting at `from`. `.`, `-` or `_` is a rest.
 *
 * ```ts
 * seq("E2 G2 A2", { from: 4, step: 0.5, len: 0.5 })
 * seq("C4 . E4 . G4", { step: 0.25 })
 * ```
 */
export function seq(
  pattern: string | readonly Pitch[],
  options: SeqOptions = {},
): readonly NoteSpec[] {
  const tokens =
    typeof pattern === "string" ? pattern.trim().split(/\s+/) : [...pattern];
  if (
    tokens.length === 0 ||
    tokens.length > 4096 ||
    tokens.every((token) => token === "")
  )
    throw new DawgSdkError("seq pattern must have 1..4096 steps");
  const from = beat(options.from ?? 0, "seq from");
  const step = positive(options.step ?? 1, "seq step");
  const len = positive(options.len ?? step, "seq len");
  const vel = unit(options.vel ?? DEFAULT_VELOCITY, "seq vel");
  const notes: NoteSpec[] = [];
  tokens.forEach((token, index) => {
    if (token === "." || token === "-" || token === "_" || token === "") return;
    notes.push(note(token, from + index * step, len, vel));
  });
  return Object.freeze(notes);
}

/**
 * One drum or sampler hit. On a `kit` track `voice` is `kick`, `snare`,
 * `clap`, `rim`, `tom`, `hat` or `openhat` (aliases `bd`, `sd`, `cp`, `hh`,
 * `oh` work); on a `sampler()` track it is a voice name. `length` defaults
 * to a sixteenth; `how` adds expression (`{ art: "ghost" }`, SDK 1.15.0).
 */
export function hit(
  voice: string,
  start: number,
  velocity = DEFAULT_VELOCITY,
  length = DEFAULT_HIT_LENGTH,
  how?: Expression,
): HitSpec {
  if (typeof voice !== "string" || voice.length === 0 || voice.length > 32)
    throw new DawgSdkError("hit voice must be a short name");
  return Object.freeze({
    kind: "hit",
    voice,
    start: beat(start, "hit start"),
    length: positive(length, "hit length"),
    velocity: unit(velocity, "hit velocity"),
    ...expression(how, "hit"),
  });
}

/**
 * The same hit on several beats: `hits("kick", [0, 1, 2, 3])` or
 * `hits("hat", every(0.5, { from: 0.25 }), 0.5)`.
 */
export function hits(
  voice: string,
  beats: readonly number[],
  velocity = DEFAULT_VELOCITY,
  length = DEFAULT_HIT_LENGTH,
): readonly HitSpec[] {
  if (!Array.isArray(beats) || beats.length > 4096)
    throw new DawgSdkError("hits needs an array of at most 4096 beats");
  return Object.freeze(beats.map((at) => hit(voice, at, velocity, length)));
}

/** Options for `every()`. */
export type EveryOptions = Readonly<{
  /** First beat, default 0. */
  from?: number;
  /** Exclusive end in beats, default 16 (four bars of 4/4). Pass `bars * beatsPerBar`. */
  until?: number;
}>;

/**
 * Beats from `from` (default 0) up to but excluding `until` (default 16)
 * every `step` beats: `every(1)` → `[0, 1, …, 15]`,
 * `every(0.5, { from: 0.25, until: 4 })` → `[0.25, 0.75, …, 3.75]`.
 */
export function every(step: number, options: EveryOptions = {}): number[] {
  const size = positive(step, "every step");
  const from = beat(options.from ?? 0, "every from");
  const until = beat(options.until ?? 16, "every until");
  const count = Math.max(0, Math.ceil((until - from) / size - 1e-9));
  if (count > 4096)
    throw new DawgSdkError("every would produce over 4096 beats");
  const beats: number[] = [];
  for (let index = 0; index < count; index += 1)
    beats.push(round(from + index * size));
  return beats;
}

// ---------------------------------------------------------------------------
// Rhythm rows (Euclidean generators, Torso T-1 style)

/** Per-pass variation of a rhythm row (T-1 Cycles). */
export type RhythmCycleSpec = Readonly<{
  pulses?: number;
  rotate?: number;
  repeats?: number;
  probability?: number;
  velocity?: number;
}>;

/**
 * Parameters of one generated voice. Every field is optional; dawg checks
 * ranges when the song loads. Note values are strings: `"1/16"`, `"1/8t"`.
 */
export type RhythmOptions = Readonly<{
  /** Steps 1..64, default 16. */
  steps?: number;
  /** Hits 0..steps spread as evenly as possible, default 4. */
  pulses?: number;
  /** Shift the pattern later by this many steps (negative: earlier), like Strudel's `euclidRot`. */
  rotate?: number;
  /** Length of a step, default `"1/16"`. */
  division?: string;
  /** Explicit steps instead of a Euclidean pattern: `x` hit, `X` accent, `.` rest. */
  grid?: string;
  /** Extra triggers after each pulse, 0..16 (T-1 Repeats). Cut off by the next pulse. */
  repeats?: number;
  /** Spacing of the repeats as a note value, default the step (T-1 Time). */
  time?: string;
  /** -1..1: repeats accelerate (<0) or decelerate (>0) (T-1 Pace). */
  pace?: number;
  /** -1..1: repeats fade out (<0) or build up (>0). */
  ramp?: number;
  /** Base velocity 0..1, default 0.8. */
  velocity?: number;
  /** 0..1: how far accented pulses rise toward full velocity. */
  accent?: number;
  /** Accented pulses as E(accents, pulses); default 1 (the first). */
  accents?: number;
  /** Note length in steps, 0.05..4 (T-1 Sustain), default 1. */
  gate?: number;
  /** Every pulse lasts until the next one, like Strudel's `euclidLegato`. */
  legato?: boolean;
  /** Chance 0..1 that a pulse plays; deterministic for a given `seed`. */
  probability?: number;
  /** Integer 0..1000000 choosing which pulses `probability` drops. */
  seed?: number;
  /** -0.5..0.5 of a step: every second step later (>0) or earlier. */
  swing?: number;
  /** -0.5..0.5 of a step: the whole row later or earlier. */
  nudge?: number;
  /** Variations applied on successive passes of the row (T-1 Cycles). */
  cycles?: readonly RhythmCycleSpec[];
}>;

/** One generated voice on a track's `rhythm` list. Build with `euclid()` or `grid()`. */
export type RhythmSpec = Readonly<
  RhythmOptions & {
    kind: "rhythm";
    voice: string;
  }
>;

/**
 * A Euclidean rhythm row: `pulses` hits spread over `steps`, rotated later
 * by `rotate` steps. Same patterns and rotation direction as Strudel's
 * `euclid`/`euclidRot` (`euclid("kick", 3, 8)` is `x..x..x.`). dawg expands
 * the row into hits when the song loads, so you edit the parameters, not
 * the notes; the row repeats every `steps` steps to the end of the loop.
 *
 * ```ts
 * rhythm: [
 *   euclid("kick", 4, 16),
 *   euclid("hat", 7, 16, 2, { velocity: 0.5, accent: 0.6, accents: 3 }),
 *   euclid({ voice: "snare", pulses: 2, steps: 16, rotate: 4 }),
 * ]
 * ```
 */
export function euclid(
  voice: string | (RhythmOptions & { voice: string }),
  pulses?: number,
  steps?: number,
  rotate?: number | RhythmOptions,
  options: RhythmOptions = {},
): RhythmSpec {
  if (isRecord(voice)) {
    const input = voice as RhythmOptions & { voice: string };
    return rhythmSpec(input.voice, input);
  }
  // `euclid("hat", 7, 16, { velocity: 0.5 })`: options without a rotate.
  if (isRecord(rotate)) {
    options = { ...(rotate as RhythmOptions), ...options };
    rotate = undefined;
  }
  const fields: Record<string, unknown> = { ...options };
  if (pulses !== undefined) fields.pulses = pulses;
  if (steps !== undefined) fields.steps = steps;
  if (rotate !== undefined) fields.rotate = rotate;
  return rhythmSpec(voice, fields as RhythmOptions);
}

/** `euclid(voice, pulses, steps, rotate)` under Strudel's name. */
export function euclidRot(
  voice: string,
  pulses: number,
  steps: number,
  rotate: number,
  options: RhythmOptions = {},
): RhythmSpec {
  return euclid(voice, pulses, steps, rotate, options);
}

/** A Euclidean row whose hits last until the next one (Strudel `euclidLegato`). */
export function euclidLegato(
  voice: string,
  pulses: number,
  steps: number,
  rotate = 0,
  options: RhythmOptions = {},
): RhythmSpec {
  return euclid(voice, pulses, steps, rotate, { ...options, legato: true });
}

/**
 * An explicit step row: `grid("snare", "....x.......x...")`. `X` is an
 * accented hit; the string's length is the step count.
 */
export function grid(
  voice: string,
  steps: string,
  options: RhythmOptions = {},
): RhythmSpec {
  return rhythmSpec(voice, { ...options, grid: steps });
}

function rhythmSpec(voice: unknown, options: RhythmOptions): RhythmSpec {
  if (
    typeof voice !== "string" ||
    voice.trim().length === 0 ||
    voice.length > 32
  )
    throw new DawgSdkError("rhythm voice must be a short name");
  if (!isRecord(options))
    throw new DawgSdkError("rhythm options must be an object");
  const out: Record<string, unknown> = { kind: "rhythm", voice: voice.trim() };
  for (const [key, value] of Object.entries(options)) {
    if (key === "voice" || key === "kind" || value === undefined) continue;
    if (!RHYTHM_KEYS.includes(key))
      throw new DawgSdkError(
        `rhythm ${voice}: unknown option "${key}" (${RHYTHM_KEYS.join(" ")})`,
      );
    out[key] =
      key === "cycles" && Array.isArray(value)
        ? Object.freeze(value.map((cycle) => Object.freeze({ ...cycle })))
        : value;
  }
  return Object.freeze(out) as RhythmSpec;
}

/** Row fields in the order dawg stores and prints them. */
export const RHYTHM_KEYS: readonly string[] = Object.freeze([
  "steps",
  "pulses",
  "rotate",
  "division",
  "grid",
  "repeats",
  "time",
  "pace",
  "ramp",
  "velocity",
  "accent",
  "accents",
  "gate",
  "legato",
  "probability",
  "seed",
  "swing",
  "nudge",
  "cycles",
]);

// ---------------------------------------------------------------------------
// Drum pattern library

/**
 * A named starting groove: one rhythm row per voice, ready for a
 * `instrument: "kit"` track. Rows are Euclidean where the part is
 * Euclidean and explicit grids otherwise. All patterns are 4/4; `swing`
 * is already applied to the rows.
 */
export type DrumPattern = Readonly<{
  name: string;
  label: string;
  tags: readonly string[];
  /** Usual tempo range and a suggested tempo, BPM. */
  tempo: Readonly<{ min: number; max: number; bpm: number }>;
  beatsPerBar: number;
  /** Swing of the 16th rows, -0.5..0.5 of a step. */
  swing: number;
  /** A synthesized kit that suits it (see `kit` on `track()`). */
  kit: string;
  rows: readonly RhythmSpec[];
}>;

function drumPattern(
  name: string,
  label: string,
  tags: readonly string[],
  tempo: readonly [number, number, number],
  kit: string,
  swing: number,
  rows: readonly RhythmSpec[],
): DrumPattern {
  return Object.freeze({
    name,
    label,
    tags: Object.freeze([...tags]),
    tempo: Object.freeze({ min: tempo[0], max: tempo[1], bpm: tempo[2] }),
    beatsPerBar: 4,
    swing,
    kit,
    rows: Object.freeze(
      rows.map((row) =>
        swing !== 0 && row.swing === undefined && row.division === undefined
          ? Object.freeze({ ...row, swing })
          : row,
      ),
    ),
  });
}

/**
 * The library. Written for dawg from common knowledge of each style (no
 * transcriptions): the defining placements of kick, snare and hats, kept
 * short so they are easy to vary.
 */
export const DRUM_PATTERNS: readonly DrumPattern[] = Object.freeze([
  drumPattern(
    "house",
    "House four-on-the-floor",
    ["house", "dance", "four-on-the-floor"],
    [118, 128, 124],
    "syn909",
    0,
    [
      euclid("kick", 4, 16),
      grid("clap", "....x.......x..."),
      euclid("openhat", 4, 16, 2, { velocity: 0.6 }),
      euclid("hat", 16, 16, 0, { velocity: 0.35, accent: 0.4, accents: 4 }),
    ],
  ),
  drumPattern(
    "disco",
    "Disco",
    ["disco", "dance", "four-on-the-floor"],
    [110, 125, 118],
    "acoustic",
    0,
    [
      euclid("kick", 4, 16),
      grid("snare", "....x.......x..."),
      euclid("openhat", 4, 16, 2, { velocity: 0.65 }),
      euclid("hat", 8, 16, 0, { velocity: 0.45 }),
    ],
  ),
  drumPattern(
    "techno",
    "Techno",
    ["techno", "dance", "four-on-the-floor"],
    [125, 140, 132],
    "syn909",
    0,
    [
      euclid("kick", 4, 16),
      euclid("openhat", 4, 16, 2, { velocity: 0.55 }),
      euclid("hat", 16, 16, 0, {
        velocity: 0.4,
        accent: 0.5,
        accents: 4,
        probability: 0.9,
        seed: 7,
      }),
      euclid("rim", 3, 8, 3, { velocity: 0.55 }),
      grid("clap", "............x...", { velocity: 0.7 }),
    ],
  ),
  drumPattern(
    "minimal",
    "Minimal Euclidean",
    ["minimal", "techno", "euclidean"],
    [120, 130, 124],
    "electro",
    0,
    [
      euclid("kick", 4, 16),
      euclid("rim", 5, 16, 3, { velocity: 0.6 }),
      euclid("hat", 7, 16, 2, { velocity: 0.45, accent: 0.5, accents: 3 }),
      euclid("tom", 3, 16, 6, { velocity: 0.5 }),
    ],
  ),
  drumPattern(
    "electro",
    "Electro",
    ["electro", "breaks"],
    [120, 135, 128],
    "electro",
    0,
    [
      grid("kick", "x.....x..x......"),
      grid("snare", "....x.......x..."),
      euclid("hat", 16, 16, 0, { velocity: 0.4, accent: 0.5, accents: 4 }),
      grid("clap", "....x.......x..x", { velocity: 0.6 }),
    ],
  ),
  drumPattern(
    "breakbeat",
    "Breakbeat",
    ["breaks", "big beat"],
    [120, 140, 130],
    "acoustic",
    0,
    [
      grid("kick", "x.........x.x...x.x.......x....."),
      grid("snare", "....x.......x.......x..x....x..."),
      euclid("hat", 8, 16, 0, { velocity: 0.5 }),
    ],
  ),
  drumPattern(
    "amen-style",
    "Amen-style break",
    ["breaks", "jungle", "drum and bass"],
    [160, 176, 170],
    "acoustic",
    0,
    [
      grid("kick", "x.x.......xx....x.x.......x....."),
      grid("snare", "....X..x.x..X..x....X..x.x....X.", {
        velocity: 0.55,
        accent: 0.4,
      }),
      euclid("hat", 8, 16, 0, { velocity: 0.45 }),
    ],
  ),
  drumPattern(
    "dnb",
    "Drum & bass two-step",
    ["drum and bass", "jungle"],
    [168, 178, 174],
    "syn909",
    0,
    [
      grid("kick", "x.........x....."),
      grid("snare", "....x.......x..."),
      euclid("hat", 8, 16, 1, { velocity: 0.45 }),
      grid("openhat", "..............x.", { velocity: 0.4 }),
    ],
  ),
  drumPattern(
    "halftime",
    "Halftime",
    ["halftime", "drum and bass", "dubstep"],
    [140, 175, 170],
    "syn909",
    0,
    [
      grid("kick", "x.........x.....x......x.x......"),
      grid("snare", "........x.......", { velocity: 0.95 }),
      euclid("hat", 8, 16, 0, { velocity: 0.4, probability: 0.85, seed: 3 }),
    ],
  ),
  drumPattern(
    "boom-bap",
    "Boom bap",
    ["hip hop", "boom bap"],
    [84, 96, 90],
    "lofi",
    0.12,
    [
      grid("kick", "x......x..x.....x.x....x..x....."),
      grid("snare", "....x.......x..."),
      euclid("hat", 8, 16, 0, { velocity: 0.5, accent: 0.4, accents: 4 }),
    ],
  ),
  drumPattern(
    "lofi",
    "Lo-fi hip hop",
    ["hip hop", "lo-fi", "chill"],
    [70, 90, 80],
    "lofi",
    0.18,
    [
      grid("kick", "x.........x.....x......x..x....."),
      grid("snare", "....x.......x..."),
      euclid("hat", 8, 16, 0, { velocity: 0.4, probability: 0.9, seed: 11 }),
      grid("rim", "...............x", { velocity: 0.4 }),
    ],
  ),
  drumPattern(
    "trap",
    "Trap with hat rolls",
    ["trap", "hip hop"],
    [130, 160, 140],
    "trap",
    0,
    [
      grid("kick", "x......x..x.....x.x....x......x."),
      grid("snare", "........x......."),
      grid("hat", "x.x.x.x.x.x.x.x.x.x.x.x.x.xxxxxx", {
        division: "1/32",
        velocity: 0.45,
      }),
      grid("openhat", "..............x.", { velocity: 0.35 }),
    ],
  ),
  drumPattern("drill", "Drill", ["drill", "trap"], [138, 146, 142], "trap", 0, [
    grid("kick", "x.....x.........x..x......x....."),
    grid("snare", "........x..........x....x......."),
    grid("hat", "x..x..x.x..x..x.", { velocity: 0.45 }),
  ]),
  drumPattern(
    "reggaeton",
    "Reggaeton / dembow",
    ["reggaeton", "dembow", "latin"],
    [88, 100, 95],
    "syn808",
    0,
    [
      euclid("kick", 4, 16),
      grid("snare", "...x..x....x..x."),
      euclid("hat", 8, 16, 0, { velocity: 0.45 }),
    ],
  ),
  drumPattern(
    "dancehall",
    "Dancehall",
    ["dancehall", "caribbean"],
    [90, 110, 100],
    "syn808",
    0,
    [
      euclid("kick", 3, 8),
      grid("snare", "....x.......x..."),
      euclid("rim", 5, 16, 2, { velocity: 0.5 }),
      euclid("hat", 8, 16, 0, { velocity: 0.4 }),
    ],
  ),
  drumPattern(
    "one-drop",
    "Reggae one drop",
    ["reggae", "dub"],
    [66, 80, 74],
    "acoustic",
    0.1,
    [
      grid("kick", "........x......."),
      grid("rim", "........x......."),
      euclid("hat", 8, 16, 0, { velocity: 0.45, accent: 0.4, accents: 2 }),
    ],
  ),
  drumPattern(
    "afrobeat",
    "Afrobeat",
    ["afrobeat", "african", "funk"],
    [100, 120, 110],
    "acoustic",
    0.05,
    [
      grid("kick", "x.....x...x.....x.....x...x..x.."),
      grid("snare", "....x..x....x..x", { velocity: 0.6 }),
      euclid("openhat", 4, 16, 2, { velocity: 0.45 }),
      euclid("hat", 12, 16, 0, { velocity: 0.4 }),
      grid("rim", "x.x.xx.x.x.x....", { velocity: 0.5 }),
    ],
  ),
  drumPattern(
    "afrobeats",
    "Afrobeats / afro-pop",
    ["afrobeats", "afro-pop", "african"],
    [100, 115, 106],
    "syn808",
    0.06,
    [
      euclid("kick", 4, 16),
      grid("rim", "...x..x...x..x..", { velocity: 0.6 }),
      euclid("hat", 8, 16, 0, { velocity: 0.4 }),
      grid("clap", "............x...", { velocity: 0.6 }),
    ],
  ),
  drumPattern(
    "bembe",
    "Bembé 12/8 bell",
    ["afro-cuban", "african", "euclidean"],
    [100, 130, 112],
    "acoustic",
    0,
    [
      euclid("kick", 4, 12, 0, { division: "1/8t" }),
      euclid("rim", 7, 12, 9, { division: "1/8t", velocity: 0.6 }),
      euclid("hat", 12, 12, 0, {
        division: "1/8t",
        velocity: 0.35,
        accent: 0.4,
        accents: 4,
      }),
    ],
  ),
  drumPattern(
    "tresillo",
    "Tresillo",
    ["latin", "euclidean", "habanera"],
    [90, 120, 100],
    "syn808",
    0,
    [
      euclid("kick", 3, 8),
      grid("snare", "....x.......x..."),
      euclid("hat", 8, 16, 0, { velocity: 0.4 }),
    ],
  ),
  drumPattern(
    "son-clave",
    "Son clave groove",
    ["afro-cuban", "salsa", "latin"],
    [90, 120, 100],
    "acoustic",
    0,
    [
      grid("rim", "x..x..x...x.x...", { velocity: 0.65 }),
      grid("kick", "...x.......x....", { velocity: 0.7 }),
      euclid("hat", 8, 16, 0, { velocity: 0.35 }),
    ],
  ),
  drumPattern(
    "bossa-nova",
    "Bossa nova",
    ["bossa nova", "brazilian", "latin"],
    [120, 145, 132],
    "acoustic",
    0,
    [
      grid("kick", "x..xx..xx..xx..x", { velocity: 0.6 }),
      grid("rim", "x..x..x...x..x..", { velocity: 0.55 }),
      euclid("hat", 16, 16, 0, { velocity: 0.3, accent: 0.4, accents: 4 }),
    ],
  ),
  drumPattern(
    "samba",
    "Samba",
    ["samba", "brazilian", "latin"],
    [92, 110, 100],
    "acoustic",
    0.04,
    [
      grid("kick", "x..xX..xx..xX..x", { velocity: 0.6, accent: 0.5 }),
      grid("rim", "x.x..x.x.x.x..x.", { velocity: 0.5 }),
      euclid("hat", 16, 16, 0, { velocity: 0.35, accent: 0.5, accents: 4 }),
    ],
  ),
  drumPattern(
    "cumbia",
    "Cumbia",
    ["cumbia", "latin"],
    [85, 105, 95],
    "acoustic",
    0,
    [
      grid("kick", "x.......x......."),
      grid("rim", "....x.......x...", { velocity: 0.6 }),
      euclid("hat", 12, 16, 0, { velocity: 0.35, accent: 0.5, accents: 4 }),
      euclid("openhat", 4, 16, 2, { velocity: 0.4 }),
    ],
  ),
  drumPattern(
    "garage",
    "UK garage 2-step",
    ["uk garage", "2-step", "dance"],
    [128, 136, 132],
    "syn909",
    0.15,
    [
      grid("kick", "x.........x..x..x.......x.x....."),
      grid("snare", "....x.......x..."),
      euclid("hat", 12, 16, 0, { velocity: 0.4 }),
      euclid("openhat", 4, 16, 2, { velocity: 0.35 }),
    ],
  ),
  drumPattern(
    "jersey-club",
    "Jersey club",
    ["jersey club", "club"],
    [135, 145, 140],
    "syn808",
    0,
    [
      grid("kick", "x...x...x..x.x..x...x...x.x.x.x."),
      grid("clap", "....x.......x..."),
      euclid("hat", 8, 16, 0, { velocity: 0.4 }),
    ],
  ),
  drumPattern(
    "footwork",
    "Footwork / juke",
    ["footwork", "juke", "chicago"],
    [155, 165, 160],
    "syn808",
    0,
    [
      grid("kick", "x..x..x...x..x..x..x..x...x.x.x."),
      grid("clap", "............x..."),
      euclid("hat", 6, 16, 2, { velocity: 0.45 }),
      euclid("tom", 3, 16, 8, { velocity: 0.5 }),
    ],
  ),
  drumPattern(
    "rock",
    "Rock basic",
    ["rock", "pop"],
    [100, 140, 120],
    "acoustic",
    0,
    [
      grid("kick", "x.......x.x....."),
      grid("snare", "....x.......x..."),
      euclid("hat", 8, 16, 0, { velocity: 0.55, accent: 0.3, accents: 4 }),
    ],
  ),
  drumPattern(
    "funk",
    "Funk with ghost notes",
    ["funk", "soul"],
    [95, 110, 102],
    "acoustic",
    0.08,
    [
      grid("kick", "x.x.......x..x.."),
      grid("snare", ".x..X..x.x..X..x", { velocity: 0.4, accent: 0.9 }),
      euclid("hat", 16, 16, 0, { velocity: 0.35, accent: 0.4, accents: 4 }),
    ],
  ),
  // The blues and rock shuffle is a triplet-8th feel: each beat is three
  // 8th-note triplets with the first and third struck (long-short).
  drumPattern(
    "shuffle",
    "Shuffle (triplet 8ths)",
    ["blues", "shuffle", "rock"],
    [90, 130, 110],
    "acoustic",
    0,
    [
      grid("kick", "x.....x.....", { division: "1/8t" }),
      grid("snare", "...x.....x..", { division: "1/8t" }),
      grid("hat", "X.xx.xX.xx.x", {
        division: "1/8t",
        velocity: 0.35,
        accent: 0.5,
      }),
    ],
  ),
  // The half-time shuffle swings 16ths against a backbeat on 3.
  drumPattern(
    "half-time-shuffle",
    "Half-time shuffle (swung 16ths)",
    ["shuffle", "rock", "funk"],
    [70, 100, 86],
    "acoustic",
    0.33,
    [
      grid("kick", "x.........x....."),
      grid("snare", "........x......."),
      euclid("hat", 16, 16, 0, { velocity: 0.35, accent: 0.5, accents: 8 }),
    ],
  ),
  drumPattern(
    "euclid-poly",
    "Euclidean polymeter",
    ["euclidean", "experimental", "polymeter"],
    [110, 130, 120],
    "electro",
    0,
    [
      euclid("kick", 5, 16),
      euclid("snare", 3, 8, 2, { velocity: 0.7 }),
      euclid("hat", 7, 12, 0, { velocity: 0.45, accent: 0.5, accents: 3 }),
      euclid("rim", 4, 10, 1, { velocity: 0.5, probability: 0.8, seed: 21 }),
    ],
  ),
]);

/** The pattern named `name` (case-insensitive), if any. */
export function findPattern(name: string): DrumPattern | undefined {
  const key = String(name)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return DRUM_PATTERNS.find((entry) => entry.name === key);
}

/**
 * A library pattern's rows, for a kit track's `rhythm`:
 *
 * ```ts
 * track({ name: "drums", instrument: "kit", kit: "lofi", rhythm: pattern("boom-bap") })
 * ```
 *
 * Spread it to change or add rows: `[...pattern("house"), euclid("rim", 5, 16)]`.
 * Rows with the same voice must not repeat, so drop the original first.
 */
export function pattern(name: string): readonly RhythmSpec[] {
  const found = findPattern(name);
  if (!found)
    throw new DawgSdkError(
      `unknown groove "${String(name).slice(0, 40)}" (${DRUM_PATTERNS.map((entry) => entry.name).join(" ")})`,
    );
  return found.rows;
}

// ---------------------------------------------------------------------------
// Sampler

/** One sample voice. A bare string is `{ src }`. */
export type SampleSpec = Readonly<{
  /**
   * Audio file: track-relative (`samples/kick.wav`) or project-relative
   * (`tracks/x/samples/kick.wav`), or a pack sound
   * `pack:<pack>/<sound>[:<n>]` such as `pack:tidal-drum-machines/RolandTR909_bd:0`
   * (fetched once into the cache; see `/pack`).
   */
  src: string;
  /** Pack sounds: content hash dawg pinned when the sound was first used. */
  sha256?: string;
  /** Pack sounds: the pinned HTTPS file. */
  url?: string;
  /** Pack sounds: the pack's license, recorded for credits. */
  license?: string;
  /** Pitch the file plays at, keyed mode only; default C4. */
  root?: Pitch;
  /** Start fraction 0..1 of the file, like Strudel `begin`. */
  begin?: number;
  /** End fraction 0..1 of the file, like Strudel `end`. */
  end?: number;
  /** Linear gain 0..2. */
  gain?: number;
  /** Playback rate, like Strudel `speed`; negative reverses. */
  speed?: number;
  /** Sustain by looping `begin..end`. */
  loop?: boolean;
  /** Choke group, like Strudel `cut`: a new hit stops the previous one in the group. */
  choke?: string;
  /** Looped part, like Strudel `loopBegin`/`loopb` (fraction, ≥ begin). */
  loopBegin?: number;
  /** Alias of `loopBegin` (Strudel `loopb`). */
  loopb?: number;
  /** Looped part end, like Strudel `loopEnd`/`loope` (fraction, ≤ end). */
  loopEnd?: number;
  /** Alias of `loopEnd` (Strudel `loope`). */
  loope?: number;
  /** Like Strudel `clip`: the voice lasts note length × clip (0 < clip ≤ 16), cutting the sample. */
  clip?: number;
  /** Alias of `clip` (Strudel `legato`). */
  legato?: number;
  /** Like Tidal `unit`: `"r"` rate (default), `"c"` speed in cycles (bars), `"s"` speed in seconds. */
  unit?: "r" | "c" | "s";
  /** Like Strudel `fit`: the window lasts exactly the note's length. */
  fit?: boolean;
  /** Like Strudel `loopAt(n)`: the window lasts n bars (stored as `speed: 1/n, unit: "c"`). */
  loopAt?: number;
  /** Like Tidal `accelerate`: rate ramps by this × the start rate over the voice (−8..8). */
  accelerate?: number;
  /** Like Tidal `squiz`: pitch-raise ratio per zero-crossing cycle (1..32). */
  squiz?: number;
  /** The file's own tempo (20..400, SDK 1.20.0): the window follows the song's tempo map. */
  bpm?: number;
  /** How a fitted window changes time (SDK 1.20.0): `"repitch"` (tape), `"beats"` (onset slices), `"tones"` (keeps pitch). */
  fitmode?: "repitch" | "beats" | "tones";
  /** Window length in beats (SDK 1.20.0); `fit` wins over `bpm`, `bpm` over `len`. */
  len?: number;
  /** Pitch shift in semitones at the same length (−24..24, SDK 1.29.0). */
  shift?: number;
  /** Formant shift in semitones with `shift` (SDK 1.29.0): absent follows the pitch, 0 keeps the formants. */
  formant?: number;
  /** Like Strudel `fadeTime`: release fade in seconds (0..2, SDK 1.29.0). */
  fadeTime?: number;
  /** Like Strudel `fadeInTime`: attack fade in seconds (0..2, SDK 1.29.0). */
  fadeInTime?: number;
  /** Where `resample` rendered the file from (informational, SDK 1.29.0). */
  from?: SampleProvenanceSpec;
  /** Velocity layer (SDK 1.31.0, SFZ lovel/hivel): MIDI velocities `[lo, hi]` this voice plays. */
  vel?: readonly [number, number];
  /** Round-robin group (SDK 1.31.0, SFZ seq_length): voices in a group take turns, A B A B. */
  rr?: string;
}>;

/** `SampleSpec.from` (SDK 1.29.0): the source of a resampled file. */
export type SampleProvenanceSpec = Readonly<{
  /** `track:<id>`, `orbit:<n>` or `master`. */
  source: string;
  section?: string;
  bars?: readonly [number, number];
  /** sha256 of the score the file was rendered from. */
  score: string;
}>;

/** Result of `sampler()`; pass it as a track's `instrument`. */
export type SamplerSpec = Readonly<{
  kind: "sampler";
  voices: Readonly<Record<string, SampleSpec>>;
  /** `oneshot` (default): voices are hits. `keyed`: voices are resampled across the keyboard from `root`. */
  mode: "oneshot" | "keyed";
}>;

/** Options for `sampler()`. */
export type SamplerOptions = Readonly<{ mode?: "oneshot" | "keyed" }>;

/**
 * A sample instrument. Voice names are `[A-Za-z][A-Za-z0-9_]*`, at most 64.
 *
 * ```ts
 * instrument: sampler({ kick: "samples/kick.wav", snare: "samples/sd.wav" })
 * instrument: sampler({ vox: { src: "samples/vox.wav", root: "C4" } }, { mode: "keyed" })
 * ```
 *
 * One-shot voices are played with `hit("kick", 0)`; keyed voices with `note()`.
 */
export function sampler(
  voices: Readonly<Record<string, string | SampleSpec>>,
  options: SamplerOptions = {},
): SamplerSpec {
  if (!isRecord(voices)) throw new DawgSdkError("sampler needs a voice map");
  const names = Object.keys(voices);
  if (names.length === 0 || names.length > 64)
    throw new DawgSdkError("sampler needs 1..64 voices");
  const mode = options.mode ?? "oneshot";
  if (mode !== "oneshot" && mode !== "keyed")
    throw new DawgSdkError('sampler mode must be "oneshot" or "keyed"');
  const out: Record<string, SampleSpec> = {};
  for (const name of names.sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.length > 32)
      throw new DawgSdkError(
        `sampler voice "${name}" must be a short identifier`,
      );
    out[name] = sampleSpec(voices[name]!, name);
  }
  return Object.freeze({ kind: "sampler", voices: Object.freeze(out), mode });
}

/** Instrument name that selects a track's wavetable oscillator. */
export const WAVETABLE_INSTRUMENT = "wavetable";

/** Strudel's `warpmode` names. */
export type WarpMode =
  "none" | "asym" | "bendp" | "bendm" | "bendmp" | "sync" | "quant";

/** Wavetable parameters, with Strudel's names. Omitted means default. */
export type WavetableParams = Readonly<{
  /** Position 0..1 (default 0). */
  wt?: number;
  /** Position envelope amount -1..1 and its ADSR (seconds, sustain 0..1). */
  wtenv?: number;
  wtattack?: number;
  wtdecay?: number;
  wtsustain?: number;
  wtrelease?: number;
  /** Position LFO rate (Hz) and depth 0..1. */
  wtrate?: number;
  wtdepth?: number;
  /** Phase warp amount 0..1 and mode. */
  warp?: number;
  warpmode?: WarpMode;
  /** Start phase randomness 0..1 (seeded per note). */
  wtphaserand?: number;
}>;

/** Result of `wavetable()`; pass it as a track's `instrument`. */
export type WavetableSpec = Readonly<
  { kind: "wavetable"; table: SampleSpec } & WavetableParams
>;

const WAVETABLE_KEYS = Object.freeze([
  "wt",
  "wtenv",
  "wtattack",
  "wtdecay",
  "wtsustain",
  "wtrelease",
  "wtrate",
  "wtdepth",
  "warp",
  "wtphaserand",
] as const);

/**
 * A wavetable instrument. `table` is a built-in (`basic`, `pwm`,
 * `formant`, `harmonics`), a Strudel `wt_` sound (`wt_digital:2` plays
 * `pack:uzu-wavetables/wt_digital:2`), any `pack:` ref, a project WAV
 * (`./wavetables/vox.wav`, relative to the track's directory, as the agent's
 * make_wavetable writes it), or a pinned `{ src, sha256, url }` that dawg
 * writes back after resolving it.
 *
 * ```ts
 * instrument: wavetable("basic", { wt: 0.4 })
 * instrument: wavetable("./wavetables/vox.wav", { wtenv: 0.5 })
 * instrument: wavetable("wt_vgame:3", { wtenv: 0.6, wtdecay: 0.4, warp: 0.3, warpmode: "bendp" })
 * ```
 */
export function wavetable(
  table: string | SampleSpec,
  params: WavetableParams = {},
): WavetableSpec {
  if (!isRecord(params))
    throw new DawgSdkError("wavetable params must be an object");
  const spec = typeof table === "string" ? { src: table } : table;
  if (!isRecord(spec) || typeof spec.src !== "string" || spec.src.length === 0)
    throw new DawgSdkError("wavetable needs a table name");
  let src = spec.src.trim();
  if (/\.wav$/i.test(src) && !src.startsWith("pack:")) {
    // A project table (make_wavetable writes tracks/<slug>/wavetables/x.wav);
    // `./wavetables/x.wav` is relative to the track's directory.
    if (
      src.includes("..") ||
      src.includes(":") ||
      src.startsWith("/") ||
      src.includes("\\")
    )
      throw new DawgSdkError(
        `wavetable file "${src.slice(0, 60)}" must be a project-relative path without ".."`,
      );
  } else if (!src.includes(":") || /^wt_[A-Za-z0-9_]+:[0-9]+$/.test(src))
    src = src.startsWith("wt_")
      ? `pack:uzu-wavetables/${src}`
      : `builtin:${src.toLowerCase()}`;
  else if (!/^(?:pack|builtin):/.test(src))
    throw new DawgSdkError(
      `wavetable table "${src.slice(0, 40)}" must be a built-in, wt_<set>:<n>, pack:<pack>/<sound> or a .wav file`,
    );
  const out: Record<string, unknown> = {
    kind: "wavetable",
    table: Object.freeze(
      src.startsWith("builtin:") ? { src } : { ...spec, src },
    ),
  };
  for (const key of Object.keys(params)) {
    const value = (params as Record<string, unknown>)[key];
    if (key === "warpmode") {
      if (typeof value !== "string")
        throw new DawgSdkError("wavetable warpmode must be a string");
      out.warpmode = value;
    } else if ((WAVETABLE_KEYS as readonly string[]).includes(key))
      out[key] = finite(value, `wavetable ${key}`);
    else
      throw new DawgSdkError(
        `wavetable has no parameter "${key}" (${WAVETABLE_KEYS.join(" ")} warpmode)`,
      );
  }
  return Object.freeze(out) as WavetableSpec;
}

/** Instrument name of the 0.6 string engine (`Track.string`). */
export const STRING_INSTRUMENT = "string";

/**
 * String engine settings (SDK 1.21.0): a `preset` (`nylon`, `steel`,
 * `electric`, `jangle`, `ebass`, `slap`, `upright`, `sitar`, `tanpura`,
 * `harpsichord`, `lute`, `oud`, `setar`, `tar`, `santur`, `dulcimer`, `koto`,
 * `harp`, `banjo`, `tres`, `requinto`; bowed since SDK 1.31.0: `violin`,
 * `viola`, `cello`, `contrabass`, `fiddle`, `erhu`, `kamancheh`, `violins`,
 * `violas`, `cellos`, `contrabasses`, `pizz`, `trem`) plus any parameter to
 * override (`ring`, `bright`, `damp`, `pos`, `mute`, `buzz`, `body`, `sym`,
 * bow: `exciter: "bow"`, `pressure`, `speed`, `attack`, `vib`, `vibmod`,
 * `vibdelay`, `tremhz`, `sord`, `dyn`). dawg validates names and ranges;
 * see **Strings** in DAWG.md.
 */
export type StringInput = Readonly<
  { preset?: string } & Record<string, number | string | undefined>
>;

/** Result of `stringed()`; pass it as a track's `instrument`. */
export type StringSpec = Readonly<{ kind: "string" } & StringInput>;

/**
 * A plucked or bowed string instrument (SDK 1.21.0; bowed and the object
 * form 1.31.0): a preset and overrides.
 *
 * instrument: stringed("nylon")
 * instrument: stringed("sitar", { buzz: 0.8, sym: 0.5 })
 * instrument: stringed({ preset: "cello", vib: 6 })
 */
export function stringed(
  preset: string | StringInput = "nylon",
  params: Readonly<Record<string, number | string>> = {},
): StringSpec {
  if (isRecord(preset)) {
    const { preset: name, ...rest } = preset as Record<string, unknown>;
    return stringed(name === undefined ? "nylon" : (name as string), {
      ...(rest as Record<string, number | string>),
      ...params,
    });
  }
  if (typeof preset !== "string" || preset.length === 0)
    throw new DawgSdkError("stringed needs a preset name");
  if (!isRecord(params))
    throw new DawgSdkError("stringed params must be an object");
  const out: Record<string, number | string> = { kind: "string", preset };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || key === "kind" || key === "preset") continue;
    out[key] =
      typeof value === "string" ? value : finite(value, `string ${key}`);
  }
  return Object.freeze(out) as StringSpec;
}

/** Instrument name of the 0.6 granular engine (`Track.granular`). */
export const GRANULAR_INSTRUMENT = "granular";

/**
 * Granular settings (SDK 1.23.0). `src` is a sample (`sample(...)` shape,
 * pinned like a sampler voice) or a built-in synth render
 * `"synth:<preset>[@note]"` (default `synth:pad`, nothing to download);
 * `preset` is `cloud`, `hold`, `sparkle`, `swarm`, `stutter`, `microloop`,
 * `backwards` or `dust`; every other key overrides one parameter (`grain`
 * seconds, `overlap`, `scan`, `pos`, `begin`, `end`, `spray`, `jitter`,
 * `pitch`, `detune`, `shimmer`, `shimint`, `spread`, `window`, `reverse`,
 * `freeze`, `repeat`, `hold`, `drift`, `drate`, `attack`, `release`,
 * `veltone`, `gain`, `seed`, `root`). dawg validates names and ranges; see
 * **Granular** in DAWG.md.
 */
export type GranularInput = Readonly<
  {
    src?: string | SampleSpec;
    preset?: string;
  } & Record<string, number | string | boolean | SampleSpec | undefined>
>;

/** Result of `granular()`; pass it as a track's `instrument`. */
export type GranularSpec = Readonly<{ kind: "granular" } & GranularInput>;

/**
 * A granular instrument (SDK 1.23.0): an optional preset, then overrides.
 *
 * ```ts
 * instrument: granular("cloud")
 * instrument: granular("hold", { src: "samples/choir.wav", scan: 0 })
 * instrument: granular({ src: "synth:bell@72", grain: 0.08, overlap: 6 })
 * ```
 */
export function granular(
  preset?: string | GranularInput,
  params: GranularInput = {},
): GranularSpec {
  const fields =
    typeof preset === "object" && preset !== null ? preset : params;
  if (!isRecord(fields))
    throw new DawgSdkError("granular params must be an object");
  const out: Record<string, unknown> = { kind: "granular" };
  if (typeof preset === "string") {
    if (preset.length === 0)
      throw new DawgSdkError("granular needs a preset name");
    out.preset = preset;
  } else if (preset !== undefined && (typeof preset !== "object" || !preset))
    throw new DawgSdkError("granular takes a preset name or params");
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === "kind") continue;
    if (key === "src")
      out.src =
        typeof value === "string" && value.startsWith("synth:")
          ? value
          : sampleSpec(value as string | SampleSpec, "granular src");
    else if (key === "preset" && typeof preset === "string") continue;
    else if (key === "root" && typeof value === "string")
      out.root = midi(value as Pitch);
    else if (
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      out[key] =
        typeof value === "number" ? finite(value, `granular ${key}`) : value;
    else throw new DawgSdkError(`granular ${key} must be a value`);
  }
  return Object.freeze(out) as GranularSpec;
}

/** Instrument name that selects the modal mallet-and-bell engine (SDK 1.25.0). */
export const MODAL_INSTRUMENT = "modal";

/** Modal presets (dawg's core/resonators.ts). */
export type ModalPresetName =
  | "marimba"
  | "vibes"
  | "xylophone"
  | "glock"
  | "celesta"
  | "chimes"
  | "kalimba"
  | "mbira"
  | "steelpan"
  | "bowl"
  | "gong"
  | "timpani"
  // SDK 1.30.0: gamelan, small bells and frame drums.
  | "crotales"
  | "musicbox"
  | "toypiano"
  | "saron"
  | "demung"
  | "slenthem"
  | "gangsa"
  | "gender"
  | "bonang"
  | "kenong"
  | "kethuk"
  | "kempul"
  | "daf"
  | "bodhran"
  | "tabla";

/** Modal overrides; omitted means the preset's value. dawg validates ranges. */
export type ModalParams = Readonly<{
  /** `yarn` `cord` `rubber` `plastic` `brass`: sets hardness. */
  mallet?: "yarn" | "cord" | "rubber" | "plastic" | "brass";
  /** Mallet hardness 0..1: brighter, shorter contact. */
  hardness?: number;
  /** Strike position 0..1 (0.5 is the bar's centre). */
  position?: number;
  /** Fundamental ring time (T60 seconds). */
  ring?: number;
  /** How much faster upper modes die (octaves of decay per octave). */
  tilt?: number;
  /** Damping on note-off 0..1 (0 lets the bar ring). */
  damp?: number;
  /** Choke time after note-off, seconds. */
  release?: number;
  /** Vibraphone motor rate Hz and depth 0..1. */
  motor?: number;
  motordepth?: number;
  /** Beat between paired gamelan modes, Hz. */
  ombak?: number;
  /** Mbira buzz 0..1 and mallet click 0..1. */
  buzz?: number;
  click?: number;
  /** Strike pitch bend in semitones and its decay seconds (Strudel penv/pdecay). */
  strikebend?: number;
  strikedecay?: number;
  /** Output level 0..2 (1 is the preset level). */
  gain?: number;
  /** Mode table override (`marimba`, `bell`, `gong`, …). */
  body?: string;
  /**
   * The partner track id of an ombak pair (SDK 1.30.0): this track (the
   * pengisep) sounds `ombak` Hz above it. song() sets the partner's ombak
   * to 0 (one straight voice) unless the partner gives its own.
   */
  pair?: string;
}>;

const MODAL_KEYS = Object.freeze([
  "mallet",
  "hardness",
  "position",
  "ring",
  "tilt",
  "damp",
  "release",
  "motor",
  "motordepth",
  "ombak",
  "buzz",
  "click",
  "strikebend",
  "strikedecay",
  "gain",
  "body",
] as const);

/** Mallet words (core/resonators.ts MODAL_MALLETS). */
const MODAL_MALLET_WORDS: readonly string[] = Object.freeze([
  "yarn",
  "cord",
  "rubber",
  "plastic",
  "brass",
]);

/** Mode tables a `body` override may name (core/resonators.ts MODAL_BODIES). */
const MODAL_BODY_WORDS: readonly string[] = Object.freeze([
  "marimba",
  "vibraphone",
  "xylophone",
  "glockenspiel",
  "celesta",
  "chimes",
  "crotale",
  "mbira",
  "kalimba",
  "musicbox",
  "toypiano",
  "saron",
  "bonang",
  "gender",
  "kempul",
  "gong",
  "bell",
  "steelpan",
  "bowl",
  "timpani",
  "tabla",
  "frame",
]);

/** Numeric ranges (core/resonators.ts MODAL_PARAMS min..max). */
const MODAL_RANGES: Readonly<Record<string, readonly [number, number]>> =
  Object.freeze({
    hardness: [0, 1],
    position: [0, 1],
    ring: [0.05, 30],
    tilt: [0, 2],
    damp: [0, 1],
    release: [0.005, 2],
    motor: [0, 12],
    motordepth: [0, 1],
    ombak: [0, 12],
    buzz: [0, 1],
    click: [0, 1],
    strikebend: [-24, 24],
    strikedecay: [0.001, 2],
    gain: [0, 2],
  });

/** Modal presets whose default carries an ombak twin bank (core/resonators.ts). */
const MODAL_TWIN_PRESETS: readonly string[] = Object.freeze(["gangsa"]);

const MODAL_PRESET_WORDS: readonly string[] = Object.freeze([
  "marimba",
  "vibes",
  "xylophone",
  "glock",
  "celesta",
  "chimes",
  "kalimba",
  "mbira",
  "steelpan",
  "bowl",
  "gong",
  "timpani",
  "crotales",
  "musicbox",
  "toypiano",
  "saron",
  "demung",
  "slenthem",
  "gangsa",
  "gender",
  "bonang",
  "kenong",
  "kethuk",
  "kempul",
  "daf",
  "bodhran",
  "tabla",
]);

/** Result of `modal()`; pass it as a track's `instrument`. */
export type ModalSpec = Readonly<
  { kind: "modal"; preset?: ModalPresetName } & ModalParams
>;

/**
 * Mallets and bells on the modal engine (SDK 1.25.0): a preset and
 * optional overrides. A preset word alone (`instrument: "vibes"`) is the
 * same as `modal("vibes")`, except `"marimba"`, which stays the legacy
 * marimba voice; `modal("marimba")` is the modal one.
 *
 * ```ts
 * instrument: modal("vibes", { motor: 4, hardness: 0.6 })
 * instrument: modal("marimba", { mallet: "rubber" })
 * instrument: modal({ ring: 2 }) // default preset (marimba)
 * ```
 */
export function modal(
  preset?: ModalPresetName | ModalParams,
  params: ModalParams = {},
): ModalSpec {
  const overrides = isRecord(preset) ? preset : params;
  const name = isRecord(preset) ? undefined : preset;
  if (!isRecord(overrides))
    throw new DawgSdkError("modal params must be an object");
  const out: Record<string, unknown> = { kind: "modal" };
  if (name !== undefined) {
    if (typeof name !== "string" || !MODAL_PRESET_WORDS.includes(name))
      throw new DawgSdkError(
        `modal preset "${String(name).slice(0, 32)}" is not one of ${MODAL_PRESET_WORDS.join(" ")}`,
      );
    out.preset = name;
  }
  for (const key of Object.keys(overrides)) {
    const value = (overrides as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "mallet" || key === "body") {
      const words = key === "mallet" ? MODAL_MALLET_WORDS : MODAL_BODY_WORDS;
      if (typeof value !== "string" || !words.includes(value))
        throw new DawgSdkError(
          `modal ${key} "${String(value).slice(0, 32)}" is not one of ${words.join(" ")}`,
        );
      out[key] = value;
    } else if (key === "pair") {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
        throw new DawgSdkError("modal pair must be a track id");
      out.pair = value;
    } else if ((MODAL_KEYS as readonly string[]).includes(key)) {
      const number = finite(value, `modal ${key}`);
      const [min, max] = MODAL_RANGES[key]!;
      if (number < min || number > max)
        throw new DawgSdkError(`modal ${key} must be ${min}..${max}`);
      out[key] = number;
    } else
      throw new DawgSdkError(
        `modal has no parameter "${key.slice(0, 32)}" (${MODAL_KEYS.join(" ")} pair)`,
      );
  }
  return Object.freeze(out) as ModalSpec;
}

// ---- winds (f061-gamelan-winds, SDK 1.30.0) ----

/** The instrument value of the wind engine (core/winds.ts). */
export const WIND_INSTRUMENT = "wind";

/** Wind presets (core/winds.ts WIND_PRESET_NAMES). */
export type WindPresetName =
  | "flute"
  | "recorder"
  | "whistle"
  | "ney"
  | "shakuhachi"
  | "panpipe"
  | "suling"
  | "bansuri"
  | "clarinet"
  | "bassclarinet"
  | "oboe"
  | "bassoon"
  | "sax"
  | "altosax"
  | "barisax"
  | "trumpet"
  | "harmon"
  | "plunger"
  | "trombone"
  | "tuba"
  | "horn";

const WIND_PRESET_WORDS: readonly string[] = Object.freeze([
  "flute",
  "recorder",
  "whistle",
  "ney",
  "shakuhachi",
  "panpipe",
  "suling",
  "bansuri",
  "clarinet",
  "bassclarinet",
  "oboe",
  "bassoon",
  "sax",
  "altosax",
  "barisax",
  "trumpet",
  "harmon",
  "plunger",
  "trombone",
  "tuba",
  "horn",
]);

/** Wind overrides (core/winds.ts WIND_PARAMS). */
export type WindParams = Readonly<{
  model?: "jet" | "reed" | "sax" | "lips";
  breath?: number;
  noise?: number;
  attack?: number;
  release?: number;
  vib?: number;
  vibmod?: number;
  reed?: number;
  bright?: number;
  stopped?: boolean;
  mute?: "open" | "straight" | "cup" | "harmon" | "plunger";
  wah?: number;
  wahenv?: number;
  growl?: number;
  flutter?: number;
  players?: number;
  gain?: number;
}>;

/** Enum words per wind parameter (core/winds.ts WIND_PARAMS). */
const WIND_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  model: Object.freeze(["jet", "reed", "sax", "lips"]),
  mute: Object.freeze(["open", "straight", "cup", "harmon", "plunger"]),
});

/** Numeric ranges (core/winds.ts WIND_PARAMS min..max). */
const WIND_RANGES: Readonly<Record<string, readonly [number, number]>> =
  Object.freeze({
    breath: [0, 1],
    noise: [0, 1],
    attack: [0.001, 2],
    release: [0.005, 2],
    vib: [0, 12],
    vibmod: [0, 1],
    reed: [0, 1],
    bright: [0, 1],
    wah: [0, 1],
    wahenv: [0, 1],
    growl: [0, 1],
    flutter: [0, 1],
    players: [1, 8],
    gain: [0, 2],
  });

/** Result of `wind()`; pass it as a track's `instrument`. */
export type WindSpec = Readonly<
  { kind: "wind"; preset?: WindPresetName } & WindParams
>;

/**
 * Winds and brass on the wind engine (SDK 1.30.0): a preset and optional
 * overrides. A preset word alone (`instrument: "flute"`) is the same as
 * `wind("flute")`; the bare word `"wind"` stays the legacy wind tone.
 *
 * ```ts
 * instrument: wind("sax", { breath: 0.8, growl: 0.2 })
 * instrument: wind("trumpet", { mute: "harmon", players: 3 })
 * instrument: wind({ bright: 0.3 }) // default preset (flute)
 * ```
 */
export function wind(
  preset?: WindPresetName | WindParams,
  params: WindParams = {},
): WindSpec {
  const overrides = isRecord(preset) ? preset : params;
  const name = isRecord(preset) ? undefined : preset;
  if (!isRecord(overrides))
    throw new DawgSdkError("wind params must be an object");
  const out: Record<string, unknown> = { kind: "wind" };
  if (name !== undefined) {
    if (typeof name !== "string" || !WIND_PRESET_WORDS.includes(name))
      throw new DawgSdkError(
        `wind preset "${String(name).slice(0, 32)}" is not one of ${WIND_PRESET_WORDS.join(" ")}`,
      );
    out.preset = name;
  }
  for (const key of Object.keys(overrides)) {
    const value = (overrides as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const words = WIND_ENUMS[key];
    if (words) {
      if (typeof value !== "string" || !words.includes(value))
        throw new DawgSdkError(
          `wind ${key} "${String(value).slice(0, 32)}" is not one of ${words.join(" ")}`,
        );
      out[key] = value;
    } else if (key === "stopped") {
      if (typeof value !== "boolean")
        throw new DawgSdkError("wind stopped must be true or false");
      out.stopped = value;
    } else if (WIND_RANGES[key]) {
      const number = finite(value, `wind ${key}`);
      const [min, max] = WIND_RANGES[key]!;
      if (number < min || number > max)
        throw new DawgSdkError(`wind ${key} must be ${min}..${max}`);
      if (key === "players" && !Number.isInteger(number))
        throw new DawgSdkError("wind players must be a whole number");
      out[key] = number;
    } else
      throw new DawgSdkError(
        `wind has no parameter "${key.slice(0, 32)}" (${[...Object.keys(WIND_ENUMS), "stopped", ...Object.keys(WIND_RANGES)].join(" ")})`,
      );
  }
  return Object.freeze(out) as WindSpec;
}

// ---- vocoder (f07-vocoder, SDK 1.32.0) ----

/** The instrument value of the built-in vocoder carrier (core/vocoder.ts). */
export const VOCODER_INSTRUMENT = "vocoder";

/** Vocoder presets (core/vocoder.ts VOCODER_PRESET_NAMES). */
export type VocoderPresetName =
  | "classic"
  | "robot"
  | "talkbox"
  | "choir"
  | "glass"
  | "whisper"
  | "smear"
  | "lofi";

const VOCODER_PRESET_WORDS: readonly string[] = Object.freeze([
  "classic",
  "robot",
  "talkbox",
  "choir",
  "glass",
  "whisper",
  "smear",
  "lofi",
]);

/** Vocoder overrides (core/vocoder.ts VOCODER_PARAMS). */
export type VocoderParams = Readonly<{
  /** The modulator track: an id or a name slug (`"vox"`, `"lead-vox"`). */
  src?: string;
  tap?: "chain" | "dry";
  mode?: "channel" | "talkbox";
  carrier?: "saw" | "supersaw" | "pulse" | "noise";
  follow?: "notes" | "chords" | "drone";
  root?: number;
  spread?: number;
  bands?: number;
  lo?: number;
  hi?: number;
  width?: number;
  attack?: number;
  release?: number;
  formant?: number;
  unvoiced?: number;
  sens?: number;
  hiss?: number;
  gate?: number | "auto";
  enhance?: boolean;
  depth?: number;
  freeze?: boolean;
  mix?: number;
  gain?: number;
  seed?: number;
}>;

const VOCODER_ENUMS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    tap: Object.freeze(["chain", "dry"]),
    mode: Object.freeze(["channel", "talkbox"]),
    carrier: Object.freeze(["saw", "supersaw", "pulse", "noise"]),
    follow: Object.freeze(["notes", "chords", "drone"]),
  });

const VOCODER_RANGES: Readonly<Record<string, readonly [number, number]>> =
  Object.freeze({
    root: [24, 96],
    spread: [0, 1],
    bands: [4, 40],
    lo: [50, 1000],
    hi: [2000, 12000],
    width: [0.25, 4],
    attack: [0.0005, 0.2],
    release: [0.005, 2],
    formant: [-24, 24],
    unvoiced: [0, 1],
    sens: [0, 1],
    hiss: [0, 1],
    gate: [-90, 0],
    depth: [0, 1],
    mix: [0, 1],
    gain: [-24, 24],
    seed: [0, 2 ** 31],
  });

const VOCODER_INTEGERS: readonly string[] = Object.freeze([
  "root",
  "bands",
  "seed",
]);

/** Result of `vocoder()`: a track's `instrument` or its `vocoder` field. */
export type VocoderSpec = Readonly<
  { kind: "vocoder"; preset?: VocoderPresetName } & VocoderParams
>;

/**
 * A vocoder (SDK 1.32.0): another track's voice (`src`) shapes this track's
 * sound. As the `instrument` it plays the built-in carrier (a supersaw
 * following the notes); as the `vocoder` field it vocodes the track's own
 * synth or sampler. `src` takes a track id or a name slug.
 *
 * ```ts
 * instrument: vocoder("talkbox", { src: "vox", formant: 2 })
 * vocoder: vocoder({ src: "t-vox", bands: 24 })
 * ```
 */
export function vocoder(
  preset?: VocoderPresetName | VocoderParams,
  params: VocoderParams = {},
): VocoderSpec {
  const overrides = isRecord(preset) ? preset : params;
  const name = isRecord(preset) ? undefined : preset;
  if (!isRecord(overrides))
    throw new DawgSdkError("vocoder params must be an object");
  const out: Record<string, unknown> = { kind: "vocoder" };
  if (name !== undefined) {
    if (typeof name !== "string" || !VOCODER_PRESET_WORDS.includes(name))
      throw new DawgSdkError(
        `vocoder preset "${String(name).slice(0, 32)}" is not one of ${VOCODER_PRESET_WORDS.join(" ")}`,
      );
    out.preset = name;
  }
  for (const key of Object.keys(overrides)) {
    const value = (overrides as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const words = VOCODER_ENUMS[key];
    if (key === "src") {
      if (typeof value !== "string" || value.length === 0 || value.length > 64)
        throw new DawgSdkError("vocoder src must be a track id or name slug");
      out.src = value;
    } else if (words) {
      if (typeof value !== "string" || !words.includes(value))
        throw new DawgSdkError(
          `vocoder ${key} "${String(value).slice(0, 32)}" is not one of ${words.join(" ")}`,
        );
      out[key] = value;
    } else if (key === "enhance" || key === "freeze") {
      if (typeof value !== "boolean")
        throw new DawgSdkError(`vocoder ${key} must be true or false`);
      out[key] = value;
    } else if (key === "gate" && value === "auto") {
      out.gate = "auto";
    } else if (VOCODER_RANGES[key]) {
      const number = finite(value, `vocoder ${key}`);
      const [min, max] = VOCODER_RANGES[key]!;
      if (number < min || number > max)
        throw new DawgSdkError(`vocoder ${key} must be ${min}..${max}`);
      if (VOCODER_INTEGERS.includes(key) && !Number.isInteger(number))
        throw new DawgSdkError(`vocoder ${key} must be a whole number`);
      out[key] = number;
    } else
      throw new DawgSdkError(
        `vocoder has no parameter "${key.slice(0, 32)}" (src ${[...Object.keys(VOCODER_ENUMS), "enhance", "freeze", ...Object.keys(VOCODER_RANGES)].join(" ")})`,
      );
  }
  return Object.freeze(out) as VocoderSpec;
}

/**
 * The vocoder field a track gets: its `vocoder` property, else a
 * `vocoder(...)` instrument, else `{}` for the bare word `"vocoder"` (the
 * built-in carrier with every default). `null` removes it.
 */
function trackVocoder(
  rawInstrument: unknown,
  field: unknown,
): Readonly<{ preset?: VocoderPresetName } & VocoderParams> | undefined {
  const strip = (spec: unknown) => {
    if (!isRecord(spec) || spec.kind !== "vocoder")
      throw new DawgSdkError("track vocoder must come from vocoder()");
    const { kind: _kind, ...fields } = spec as VocoderSpec;
    return Object.freeze(fields);
  };
  if (field !== undefined && field !== null) return strip(field);
  if (isRecord(rawInstrument) && rawInstrument.kind === "vocoder")
    return strip(rawInstrument);
  if (rawInstrument === VOCODER_INSTRUMENT) return Object.freeze({});
  return undefined;
}

/** Lowercase dash slug of a track name (core/slug.ts trackSlug). */
function vocoderSlug(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "track";
}

/**
 * `src` as a track id: an id wins, then a unique name slug. Errors when
 * nothing matches, two tracks share the slug, or the track names itself.
 */
function resolveVocoderSrc(
  tracks: readonly Readonly<{ id: string; name: string }>[],
  self: string,
  src: string,
): string {
  const byId = tracks.find((track) => track.id === src);
  const matches = byId
    ? [byId]
    : tracks.filter((track) => vocoderSlug(track.name) === vocoderSlug(src));
  if (matches.length === 0)
    throw new DawgSdkError(
      `track ${self}: vocoder src "${src.slice(0, 64)}" names no track; delete src (the carrier plays alone) or point it at a track in this song`,
    );
  if (matches.length > 1)
    throw new DawgSdkError(
      `track ${self}: vocoder src "${src.slice(0, 64)}" matches ${matches.length} tracks; use an id`,
    );
  if (matches[0]!.id === self)
    throw new DawgSdkError(`track ${self}: a track cannot vocode itself`);
  return matches[0]!.id;
}

/**
 * The wind field an instrument makes: `wind(...)`, or a wind preset word
 * (`"flute"`, `"saxophone"`). The bare word `"wind"` keeps its pre-0.6.1
 * meaning (the legacy tone) and makes none.
 */
function trackWind(
  raw: unknown,
): Readonly<{ preset?: WindPresetName } & WindParams> | undefined {
  if (isRecord(raw) && raw.kind === "wind") {
    const { kind: _kind, ...fields } = raw as WindSpec;
    return Object.freeze(fields);
  }
  if (typeof raw !== "string" || raw === WIND_INSTRUMENT) return undefined;
  const meaning = resolveInstrumentWord(raw);
  if (meaning?.instrument !== WIND_INSTRUMENT || !meaning.preset)
    return undefined;
  return Object.freeze({ preset: meaning.preset as WindPresetName });
}

// ---- sing (f07-sing, SDK 1.32.0) ----

/** The instrument value of the singing voice (core/sing.ts). */
export const SING_INSTRUMENT = "sing";

/** Sing presets (core/sing.ts SING_PRESET_NAMES). */
export type SingPresetName =
  | "aah"
  | "ooh"
  | "choir"
  | "oohchoir"
  | "chorale"
  | "airy"
  | "glass"
  | "lament"
  | "soprano"
  | "basso"
  | "drone"
  | "khoomei"
  | "sygyt"
  | "kargyraa";

const SING_PRESET_WORDS: readonly string[] = Object.freeze([
  "aah",
  "ooh",
  "choir",
  "oohchoir",
  "chorale",
  "airy",
  "glass",
  "lament",
  "soprano",
  "basso",
  "drone",
  "khoomei",
  "sygyt",
  "kargyraa",
]);

/** Sing overrides (core/sing.ts SING_PARAMS). */
export type SingParams = Readonly<{
  voice?: "auto" | "soprano" | "alto" | "tenor" | "bass";
  /** `"a"`, `"e"`, `"i"`, `"o"`, `"u"` or a morph `"a>o"`. */
  vowel?: string;
  morph?: number;
  formant?: number;
  bright?: number;
  breath?: number;
  jitter?: number;
  shimmer?: number;
  attack?: number;
  release?: number;
  vib?: number;
  vibmod?: number;
  vibdelay?: number;
  voices?: number;
  spread?: number;
  ring?: number;
  /** Throat drone: a note name (`"D3"`) or MIDI 36..67. */
  drone?: string | number;
  overtone?: number;
  /** Throat melody harmonic range `[lo, hi]`, 2..24. */
  harmonics?: readonly [number, number];
  sub?: number;
  gain?: number;
}>;

const SING_VOWEL_LETTERS: readonly string[] = Object.freeze([
  "a",
  "e",
  "i",
  "o",
  "u",
]);

/** Numeric ranges (core/sing.ts SING_PARAMS min..max). */
const SING_RANGES: Readonly<Record<string, readonly [number, number]>> =
  Object.freeze({
    morph: [0, 1],
    formant: [-12, 12],
    bright: [0, 1],
    breath: [0, 1],
    jitter: [0, 3],
    shimmer: [0, 1],
    attack: [0.005, 2],
    release: [0.01, 4],
    vib: [0, 9],
    vibmod: [0, 1],
    vibdelay: [0, 2],
    voices: [1, 8],
    spread: [0, 40],
    ring: [0, 1],
    overtone: [0, 1],
    sub: [0, 1],
    gain: [0, 2],
  });

/** Result of `sing()`; pass it as a track's `instrument`. */
export type SingSpec = Readonly<
  { kind: "sing"; preset?: SingPresetName } & SingParams
>;

/** `"a"` or `"a>o"`, lower-cased; throws otherwise. */
function singVowel(value: unknown, label: string): string {
  const parts =
    typeof value === "string" ? value.trim().toLowerCase().split(">") : [];
  if (
    (parts.length === 1 || parts.length === 2) &&
    parts.every((part) => SING_VOWEL_LETTERS.includes(part))
  )
    return parts.join(">");
  throw new DawgSdkError(
    `${label} must be one of ${SING_VOWEL_LETTERS.join(" ")} or a morph like a>o`,
  );
}

/**
 * The built-in singing voice (SDK 1.32.0): an LF glottal source through
 * SATB formants, choirs, and Tuvan throat singing. A preset word alone
 * (`instrument: "choir"`) is the same as `sing("choir")`. Notes sing their
 * `vowel` (`note("A3", 0, 2, 0.8, { vowel: "a>o" })`), else their lyric's
 * vowel, else the track's.
 *
 * ```ts
 * instrument: sing("choir", { vowel: "o" })
 * instrument: sing("khoomei", { drone: "D3" }) // notes pick the overtone
 * instrument: sing({ voices: 4, breath: 0.3 }) // default preset (aah)
 * ```
 */
export function sing(
  preset?: SingPresetName | SingParams,
  params: SingParams = {},
): SingSpec {
  const overrides = isRecord(preset) ? preset : params;
  const name = isRecord(preset) ? undefined : preset;
  if (!isRecord(overrides))
    throw new DawgSdkError("sing params must be an object");
  const out: Record<string, unknown> = { kind: "sing" };
  if (name !== undefined) {
    if (typeof name !== "string" || !SING_PRESET_WORDS.includes(name))
      throw new DawgSdkError(
        `sing preset "${String(name).slice(0, 32)}" is not one of ${SING_PRESET_WORDS.join(" ")}`,
      );
    out.preset = name;
  }
  for (const key of Object.keys(overrides)) {
    const value = (overrides as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "voice") {
      const voices = ["auto", "soprano", "alto", "tenor", "bass"];
      if (typeof value !== "string" || !voices.includes(value))
        throw new DawgSdkError(`sing voice must be one of ${voices.join(" ")}`);
      out.voice = value;
    } else if (key === "vowel") out.vowel = singVowel(value, "sing vowel");
    else if (key === "drone") {
      const midiValue =
        typeof value === "number" ? value : midi(value as Pitch);
      if (!Number.isInteger(midiValue) || midiValue < 36 || midiValue > 67)
        throw new DawgSdkError(
          'sing drone must be a note name C2..G4 (e.g. "D3") or MIDI 36..67',
        );
      out.drone = midiValue;
    } else if (key === "harmonics") {
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !value.every((h) => Number.isInteger(h) && h >= 2 && h <= 24) ||
        value[0] >= value[1]
      )
        throw new DawgSdkError(
          "sing harmonics must be [lo, hi], whole numbers 2..24 with lo < hi",
        );
      out.harmonics = Object.freeze([value[0], value[1]]);
    } else if (SING_RANGES[key]) {
      const number = finite(value, `sing ${key}`);
      const [min, max] = SING_RANGES[key]!;
      if (number < min || number > max)
        throw new DawgSdkError(`sing ${key} must be ${min}..${max}`);
      if (key === "voices" && !Number.isInteger(number))
        throw new DawgSdkError("sing voices must be a whole number");
      out[key] = number;
    } else
      throw new DawgSdkError(
        `sing has no parameter "${key.slice(0, 32)}" (voice vowel drone harmonics ${Object.keys(SING_RANGES).join(" ")})`,
      );
  }
  return Object.freeze(out) as SingSpec;
}

/**
 * The sing field an instrument makes: `sing(...)`, or a sing preset word
 * (`"choir"`, `"khoomei"`); `"sing"` alone is the default preset.
 */
function trackSing(
  raw: unknown,
): Readonly<{ preset?: SingPresetName } & SingParams> | undefined {
  if (isRecord(raw) && raw.kind === "sing") {
    const { kind: _kind, ...fields } = raw as SingSpec;
    return Object.freeze(fields);
  }
  if (typeof raw !== "string") return undefined;
  const meaning = resolveInstrumentWord(raw);
  if (meaning?.instrument !== SING_INSTRUMENT) return undefined;
  return Object.freeze(
    meaning.preset ? { preset: meaning.preset as SingPresetName } : {},
  );
}

// ---- autotune (f07-autotune, SDK 1.33.0) ----

/** Autotune presets, gentle to hard (core/autotune.ts AUTOTUNE_PRESETS). */
export type AutotunePresetName =
  | "hard"
  | "robot"
  | "warble"
  | "trap"
  | "pop"
  | "natural"
  | "gentle"
  | "guided"
  | "locked";

const AUTOTUNE_PRESET_WORDS: readonly string[] = Object.freeze([
  "hard",
  "robot",
  "warble",
  "trap",
  "pop",
  "natural",
  "gentle",
  "guided",
  "locked",
]);

/** Autotune fields; dawg checks the ranges (core/autotune.ts AUTOTUNE_PARAMS). */
export type AutotuneParams = Readonly<{
  /** Targets: `scale` (song or track key, else chromatic), `chromatic`, `chord`, `notes`. */
  to?: "scale" | "chromatic" | "chord" | "notes";
  /** Guide track id for `to: "notes"` (a vocal track may use its own notes). */
  from?: string;
  /** Scale for this track, e.g. `"D bayati"`; default the song key. */
  key?: string;
  /** Retune time in ms, 0..400; 0 is instant and stepped. */
  speed?: number;
  /** 0..1 slower retune on held notes. */
  relax?: number;
  /** ms 50..1000 before a note counts as held. */
  hold?: number;
  /** 0..100: higher only pulls notes already near a target. */
  flex?: number;
  /** Seconds 0..0.5 to move between targets. */
  glide?: number;
  /** 0..1 correction strength. */
  amount?: number;
  /** Added vibrato rate in Hz, 0..12 (0 off). */
  vib?: number;
  /** Added vibrato depth in semitones, 0..1. */
  vibmod?: number;
  /** Notes mode: 0..1 how far each note's middle moves to the written pitch. */
  center?: number;
  /** Notes mode: 0..1 share of slow drift removed. */
  drift?: number;
  /** Tracker range: `auto`, `bass`, `tenor`, `alto`, `soprano`. */
  voice?: "auto" | "bass" | "tenor" | "alto" | "soprano";
}>;

/** Stored autotune settings: a preset and any fields that override it. */
export type AutotuneSettings = Readonly<
  { preset?: AutotunePresetName } & AutotuneParams
>;

/** Result of `autotune()`; pass it as a track's `autotune`. */
export type AutotuneSpec = Readonly<{ kind: "autotune" } & AutotuneSettings>;

const AUTOTUNE_PARAM_KEYS: readonly string[] = Object.freeze([
  "to",
  "from",
  "key",
  "speed",
  "relax",
  "hold",
  "flex",
  "glide",
  "amount",
  "vib",
  "vibmod",
  "center",
  "drift",
  "voice",
]);

/**
 * Pitch correction (SDK 1.33.0), from `gentle` to `hard`; the preset word
 * alone also works as a track's `autotune`. Fields override the preset.
 *
 * autotune: "hard"
 * autotune: autotune("pop", { speed: 40, key: "D bayati" })
 * autotune: autotune("guided", { from: "lead" })
 */
export function autotune(
  preset?: AutotunePresetName | AutotuneParams,
  params?: AutotuneParams,
): AutotuneSpec {
  const fields =
    typeof preset === "object" && preset !== null ? preset : (params ?? {});
  const name = typeof preset === "string" ? preset : undefined;
  return Object.freeze({
    kind: "autotune" as const,
    ...autotuneInput(
      { ...(name ? { preset: name } : {}), ...fields },
      "autotune",
    ),
  });
}

function autotuneInput(raw: unknown, where: string): AutotuneSettings {
  if (typeof raw === "string") raw = { preset: raw };
  if (!isRecord(raw))
    throw new DawgSdkError(
      `${where} autotune must be a preset word or autotune()`,
    );
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "kind" || value === undefined) continue;
    if (key === "preset") {
      if (typeof value !== "string" || !AUTOTUNE_PRESET_WORDS.includes(value))
        throw new DawgSdkError(
          `${where} autotune preset "${String(value).slice(0, 32)}" is not one of ${AUTOTUNE_PRESET_WORDS.join(" ")}`,
        );
      out.preset = value;
    } else if (!AUTOTUNE_PARAM_KEYS.includes(key)) {
      throw new DawgSdkError(
        `${where} autotune has no field "${key.slice(0, 32)}" (preset ${AUTOTUNE_PARAM_KEYS.join(" ")})`,
      );
    } else if (["to", "from", "key", "voice"].includes(key)) {
      if (typeof value !== "string")
        throw new DawgSdkError(`${where} autotune ${key} must be a string`);
      out[key] = value;
    } else out[key] = finite(value, `${where} autotune ${key}`);
  }
  if (Object.keys(out).length === 0)
    throw new DawgSdkError(`${where} autotune needs a preset or fields`);
  const ordered: Record<string, unknown> = {};
  for (const key of ["preset", ...AUTOTUNE_PARAM_KEYS])
    if (out[key] !== undefined) ordered[key] = out[key];
  return Object.freeze(ordered) as AutotuneSettings;
}

/**
 * `count` equal slices of one file as voices `prefix0 … prefixN-1`, for
 * chopped breaks: `sampler(slices("samples/break.wav", 8, "brk"))`, then
 * `hit("brk3", 1.5)`.
 */
export function slices(
  src: string | SampleSpec,
  count: number,
  prefix = "slice",
): Record<string, SampleSpec> {
  if (!Number.isInteger(count) || count < 1 || count > 64)
    throw new DawgSdkError("slices count must be an integer 1..64");
  const base = sampleSpec(src, prefix);
  const begin = base.begin ?? 0;
  const end = base.end ?? 1;
  const span = (end - begin) / count;
  const voices: Record<string, SampleSpec> = {};
  for (let index = 0; index < count; index += 1) {
    voices[`${prefix}${index}`] = Object.freeze({
      ...base,
      begin: round(begin + index * span),
      end: round(index === count - 1 ? end : begin + (index + 1) * span),
    });
  }
  return voices;
}

function sampleSpec(value: string | SampleSpec, name: string): SampleSpec {
  const spec = typeof value === "string" ? { src: value } : value;
  if (!isRecord(spec) || typeof spec.src !== "string" || spec.src.length === 0)
    throw new DawgSdkError(`sampler voice ${name} needs a src path`);
  const out: {
    src: string;
    sha256?: string;
    url?: string;
    license?: string;
    root?: number;
    begin?: number;
    end?: number;
    gain?: number;
    speed?: number;
    loop?: boolean;
    choke?: string;
    loopBegin?: number;
    loopEnd?: number;
    clip?: number;
    unit?: "r" | "c" | "s";
    fit?: boolean;
    accelerate?: number;
    squiz?: number;
    bpm?: number;
    fitmode?: "repitch" | "beats" | "tones";
    len?: number;
    shift?: number;
    formant?: number;
    fadeTime?: number;
    fadeInTime?: number;
    from?: SampleProvenanceSpec;
    vel?: readonly [number, number];
    rr?: string;
  } = { src: spec.src };
  if (spec.src.startsWith("pack:")) {
    if (spec.sha256 !== undefined)
      out.sha256 = text(spec.sha256, `${name} sha256`);
    if (spec.url !== undefined) out.url = text(spec.url, `${name} url`);
    if (spec.license !== undefined)
      out.license = text(spec.license, `${name} license`);
  }
  if (spec.root !== undefined) out.root = midi(spec.root);
  if (spec.begin !== undefined) out.begin = unit(spec.begin, `${name} begin`);
  if (spec.end !== undefined) out.end = unit(spec.end, `${name} end`);
  if (spec.gain !== undefined) out.gain = finite(spec.gain, `${name} gain`);
  if (spec.speed !== undefined) out.speed = finite(spec.speed, `${name} speed`);
  if (spec.loop !== undefined) {
    if (typeof spec.loop !== "boolean")
      throw new DawgSdkError(`${name} loop must be boolean`);
    out.loop = spec.loop;
  }
  if (spec.choke !== undefined) {
    if (typeof spec.choke !== "string")
      throw new DawgSdkError(`${name} choke must be a group name`);
    out.choke = spec.choke;
  }
  const loopBegin = spec.loopBegin ?? spec.loopb;
  if (loopBegin !== undefined)
    out.loopBegin = unit(loopBegin, `${name} loopBegin`);
  const loopEnd = spec.loopEnd ?? spec.loope;
  if (loopEnd !== undefined) out.loopEnd = unit(loopEnd, `${name} loopEnd`);
  const clip = spec.clip ?? spec.legato;
  if (clip !== undefined) out.clip = finite(clip, `${name} clip`);
  if (spec.unit !== undefined) {
    if (spec.unit !== "r" && spec.unit !== "c" && spec.unit !== "s")
      throw new DawgSdkError(`${name} unit must be "r", "c" or "s"`);
    out.unit = spec.unit;
  }
  if (spec.loopAt !== undefined) {
    const bars = finite(spec.loopAt, `${name} loopAt`);
    if (bars <= 0) throw new DawgSdkError(`${name} loopAt must be positive`);
    out.speed = (out.speed ?? 1) / bars;
    out.unit = "c";
  }
  if (spec.fit !== undefined) {
    if (typeof spec.fit !== "boolean")
      throw new DawgSdkError(`${name} fit must be boolean`);
    out.fit = spec.fit;
  }
  if (spec.accelerate !== undefined)
    out.accelerate = finite(spec.accelerate, `${name} accelerate`);
  if (spec.squiz !== undefined) out.squiz = finite(spec.squiz, `${name} squiz`);
  if (spec.bpm !== undefined) out.bpm = finite(spec.bpm, `${name} bpm`);
  if (spec.fitmode !== undefined) {
    if (
      spec.fitmode !== "repitch" &&
      spec.fitmode !== "beats" &&
      spec.fitmode !== "tones"
    )
      throw new DawgSdkError(
        `${name} fitmode must be "repitch", "beats" or "tones"`,
      );
    out.fitmode = spec.fitmode;
  }
  if (spec.len !== undefined) out.len = finite(spec.len, `${name} len`);
  if (spec.shift !== undefined) out.shift = finite(spec.shift, `${name} shift`);
  if (spec.formant !== undefined)
    out.formant = finite(spec.formant, `${name} formant`);
  if (spec.fadeTime !== undefined)
    out.fadeTime = finite(spec.fadeTime, `${name} fadeTime`);
  if (spec.fadeInTime !== undefined)
    out.fadeInTime = finite(spec.fadeInTime, `${name} fadeInTime`);
  if (spec.from !== undefined) {
    if (typeof spec.from !== "object" || spec.from === null)
      throw new DawgSdkError(`${name} from must be an object`);
    out.from = spec.from;
  }
  if (spec.vel !== undefined) {
    if (!Array.isArray(spec.vel) || spec.vel.length !== 2)
      throw new DawgSdkError(`${name} vel must be [lo, hi]`);
    out.vel = Object.freeze([
      finite(spec.vel[0], `${name} vel`),
      finite(spec.vel[1], `${name} vel`),
    ] as const);
  }
  if (spec.rr !== undefined) out.rr = text(spec.rr, `${name} rr`);
  return Object.freeze(out);
}

/**
 * One sample file with options (SDK 1.20.0), for `sampler({ brk: ... })`:
 * `sample("samples/break.wav", { bpm: 174, fitmode: "beats" })` plays a
 * 174 BPM break in time with the song, cut at its hits.
 */
export function sample(
  src: string,
  options: Omit<SampleSpec, "src"> = {},
): SampleSpec {
  if (typeof src !== "string" || src.length === 0)
    throw new DawgSdkError("sample() needs a src path");
  return Object.freeze({ ...options, src });
}

// ---------------------------------------------------------------------------
// Tracks

/** `[beat, value]` control point for `automation`. */
export type Point = readonly [beat: number, value: number];

/** Automation lanes in beats. Each lane replaces the stored lane entirely. */
export type AutomationInput = Readonly<{
  /** 0..1 */
  volume?: readonly Point[];
  /** -1..1 */
  pan?: readonly Point[];
  /** Filter cutoff in Hz, 20..20000 (needs `filter`). */
  filter?: readonly Point[];
  /** 0..1 (needs `filter`). */
  resonance?: readonly Point[];
  /** 0..0.9 (needs `delay`). */
  delayFeedback?: readonly Point[];
  /** 0..1 (needs `delay`). */
  delayMix?: readonly Point[];
  /**
   * Effect parameter lanes keyed `<effect>-<param>`, e.g.
   * `"autofilter-cutoff"`, `"distort-drive"`, `"reverb-mix"` (needs the effect).
   */
  fx?: Readonly<Record<string, readonly Point[]>>;
  /** Wavetable position 0..1 (needs `wavetable()`). */
  wt?: readonly Point[];
}>;

/**
 * Every rig preset (SDK 1.22.0), kept equal to `RIG_PRESETS` in
 * core/fx.ts by `print-rig.test.ts`: the stomp, head and cab stages plus
 * the companion effects a few rigs need (funk's and wah's autofilter,
 * bachata's chorus, jangle's compressor). `spring`'s short room is the
 * track's `reverb`, not `fx`: give it as
 * `reverb: { mix: 0.3, size: 0.35, fade: 1.5, predelay: 0, dim: 3500 }`.
 */
export const RIG_PRESETS: Readonly<
  Record<
    string,
    Readonly<
      Record<"stomp" | "head" | "cab", EffectParams | undefined> &
        Readonly<Record<string, EffectParams | undefined>>
    >
  >
> = Object.freeze({
  clean: {
    stomp: undefined,
    head: { type: "clean", gain: 3, treble: 6 },
    cab: { type: "1x12" },
  },
  crunch: {
    stomp: undefined,
    head: { type: "crunch", gain: 5 },
    cab: { type: "4x12" },
  },
  punk: {
    stomp: undefined,
    head: { type: "crunch", gain: 7, mid: 6, master: 6 },
    cab: { type: "4x12", mic: 0.2 },
  },
  ragged: {
    stomp: { type: "face", gain: 6, tone: 0.6 },
    head: { type: "chime", gain: 4 },
    cab: { type: "2x12" },
  },
  lead: {
    stomp: { type: "od", gain: 3, tone: 0.5, level: 3 },
    head: { type: "lead", gain: 6, mid: 6 },
    cab: { type: "4x12" },
  },
  metal: {
    stomp: { type: "od", gain: 0, tone: 0.6, level: 6 },
    head: { type: "high", gain: 7, bass: 6, mid: 3, treble: 7, gate: -55 },
    cab: { type: "4x12", mic: 0.2 },
  },
  fuzz: {
    stomp: { type: "fuzz", gain: 7, tone: 0.5 },
    head: { type: "clean", gain: 4 },
    cab: { type: "2x12" },
  },
  octave: {
    stomp: { type: "octave", gain: 6, tone: 0.6, octave: 0.8 },
    head: { type: "clean", gain: 3 },
    cab: { type: "1x12" },
  },
  funk: {
    stomp: undefined,
    head: { type: "clean", gain: 2, treble: 7, presence: 6 },
    cab: { type: "2x12" },
    autofilter: {
      type: "bpf",
      sync: 0,
      rate: 0.01,
      depth: 0,
      follow: 3,
      cutoff: 500,
      resonance: 0.6,
    },
  },
  wah: {
    stomp: undefined,
    head: { type: "crunch", gain: 4 },
    cab: { type: "2x12" },
    autofilter: {
      type: "bpf",
      sync: 0.5,
      depth: 2,
      shape: "sine",
      cutoff: 700,
      resonance: 0.6,
    },
  },
  bachata: {
    stomp: undefined,
    head: { type: "clean", gain: 2, mid: 6, treble: 7 },
    cab: { type: "1x12", mic: 0.2 },
    chorus: { rate: 0.8, depth: 0.25, mix: 0.3 },
  },
  spring: {
    stomp: undefined,
    head: { type: "clean", gain: 3, treble: 6 },
    cab: { type: "open" },
  },
  bassdrive: {
    stomp: { type: "od", gain: 4, tone: 0.5, mix: 0.6 },
    head: { type: "bass", gain: 4 },
    cab: { type: "8x10" },
  },
  reese: {
    stomp: { type: "rat", gain: 3, tone: 0.3, mix: 0.5 },
    head: { type: "bass", gain: 6, master: 6 },
    cab: { type: "1x15" },
  },
  jangle: {
    stomp: undefined,
    head: { type: "chime", gain: 3, treble: 7 },
    cab: { type: "2x12", mic: 0.2 },
    compressor: { threshold: -20, ratio: 4, attack: 0.01, release: 0.15 },
    // The `rig jangle` command adds `double` since 0.6.1; rig("jangle")
    // keeps its 0.6.0 stages so older song.ts files sound the same. Add
    // `double: { time: 12, drift: 1.5, width: 0.5 }` for the new one.
  },
  alt: {
    stomp: { type: "rat", gain: 6, tone: 0.4 },
    head: { type: "crunch", gain: 4 },
    cab: { type: "4x12" },
  },
  // SDK 1.27.0 shoegaze rigs. Their long wash is the track's `reverb`
  // (see `rigReverb` in the `rig` command), not part of `rig()`.
  shoegaze: {
    stomp: { type: "fuzz", gain: 7, tone: 0.45 },
    head: { type: "chime", gain: 4 },
    cab: { type: "2x12" },
    wobble: { depth: 25, rate: 0.4, drift: 0.4 },
    bloom: { amount: 0.4, harm: 2, delay: 0.6, time: 1 },
    double: { time: 18, drift: 2.5, width: 0.4 },
    postgain: { gain: 0.86 },
  },
  glide: {
    stomp: { type: "face", gain: 5, tone: 0.5 },
    head: { type: "clean", gain: 4, treble: 5 },
    cab: { type: "2x12" },
    wobble: { depth: 35, rate: 0.4, drift: 0.4 },
    postgain: { gain: 0.8 },
  },
  dreampop: {
    stomp: undefined,
    head: { type: "clean", gain: 2, treble: 6 },
    cab: { type: "1x12" },
    chorus: { rate: 0.6, depth: 0.3, mix: 0.35 },
    double: { time: 14, drift: 2, width: 0.4 },
    postgain: { gain: 1.45 },
  },
  swell: {
    stomp: undefined,
    head: { type: "clean", gain: 3, treble: 5 },
    cab: { type: "1x12" },
    swell: { time: 0.5 },
    postgain: { gain: 1.25 },
  },
  ebow: {
    stomp: { type: "od", gain: 3, tone: 0.5, level: 3 },
    head: { type: "lead", gain: 5, mid: 6 },
    cab: { type: "4x12" },
    swell: { time: 0.25 },
    bloom: { amount: 0.8, harm: 1, delay: 0.1, time: 0.6 },
  },
});

/**
 * The long wash a rig preset sets as the track's `reverb` (SDK 1.27.0),
 * as the `rig` command stores it. `rig()` returns `fx` only, so give it
 * as `reverb: rigReverb("shoegaze")`; `instrument: "shoegaze"` adds it
 * when the track has no `reverb` of its own.
 */
const RIG_REVERBS: Readonly<Record<string, ReverbInput & { mix: number }>> =
  Object.freeze({
    spring: { mix: 0.3, size: 0.35, fade: 1.5, predelay: 0, dim: 3500 },
    shoegaze: { mix: 0.35, size: 0.9, fade: 4, predelay: 0.02, dim: 6000 },
    glide: { mix: 0.35, size: 0.7, fade: 2.5, predelay: 0.01, dim: 6000 },
    dreampop: { mix: 0.4, size: 0.85, fade: 5, predelay: 0.03, dim: 7000 },
    swell: { mix: 0.45, size: 0.8, fade: 4, predelay: 0.02, dim: 6500 },
  });

/** A rig preset's track reverb (`spring`, the shoegaze rigs), if any. */
export function rigReverb(name: string): ReverbInput | undefined {
  if (
    typeof name !== "string" ||
    !Object.prototype.hasOwnProperty.call(RIG_PRESETS, name)
  )
    throw new DawgSdkError(
      `unknown rig "${String(name)}" (rigs: ${Object.keys(RIG_PRESETS).join(", ")})`,
    );
  const values = RIG_REVERBS[name];
  return values === undefined ? undefined : Object.freeze({ ...values });
}

/**
 * A guitar rig for a track's `fx` (SDK 1.22.0): the stomp → head → cab
 * stages of rig preset `name` and its companion effects (as the `rig`
 * command sets them), with optional per-stage overrides. Spread it
 * into `fx` next to other effects:
 *
 * ```ts
 * fx: { ...rig("crunch"), chorus: {} }
 * fx: { ...rig("metal", { head: { gain: 9 } }) }
 * ```
 */
export function rig(
  name: string,
  overrides: Readonly<
    Partial<Record<"stomp" | "head" | "cab", EffectParams>>
  > = {},
): FxInput {
  if (
    typeof name !== "string" ||
    !Object.prototype.hasOwnProperty.call(RIG_PRESETS, name)
  )
    throw new DawgSdkError(
      `unknown rig "${String(name)}" (rigs: ${Object.keys(RIG_PRESETS).join(", ")})`,
    );
  if (!isRecord(overrides))
    throw new DawgSdkError("rig overrides must be an object");
  const out: Record<string, EffectParams> = {};
  // Companion effects first, then the stages in chain order.
  for (const [effect, values] of Object.entries(RIG_PRESETS[name]!))
    if (values && effect !== "stomp" && effect !== "head" && effect !== "cab")
      out[effect] = Object.freeze({ ...values });
  for (const stage of ["stomp", "head", "cab"] as const) {
    const base = RIG_PRESETS[name]![stage];
    const extra = overrides[stage];
    if (extra !== undefined && !isRecord(extra))
      throw new DawgSdkError(`rig ${stage} overrides must be an object`);
    if (base || extra)
      out[stage] = Object.freeze({ ...(base ?? {}), ...(extra ?? {}) });
  }
  return Object.freeze(out);
}

/** One effect's parameters; omitted ones take dawg's defaults. */
export type EffectParams = Readonly<Record<string, number | string | boolean>>;

/**
 * Insert effects by name, rendered in the fixed chain order
 * filter → djf → autofilter → vowel → crush → distort → stomp → head →
 * cab → tremolo → compressor → pan → phaser → chorus → leslie → postgain →
 * delay → reverb. The guitar rig (stomp, head, cab; SDK 1.22.0) is easiest
 * as `...rig("crunch")`.
 * Keys here: djf, autofilter, vowel, crush, distort, stomp, head, cab,
 * tremolo, compressor,
 * phaser, chorus, leslie, postgain, plus the mix-bus keys `orbit`
 * (`{ orbit: 2 }`, SDK 1.9.0) and `duck` (`{ orbit: 2, depth: 0.85 }`:
 * this track's onsets duck every other track on that orbit). See
 * docs/project-format.md for every parameter, its range and its Strudel name.
 */
export type FxInput = Readonly<Record<string, EffectParams>>;

/** A track's `fx`: effects by name, plus effect patches under `patch`. */
export type TrackFxInput = Readonly<{
  patch?: readonly PatchSpec[];
  [effect: string]: EffectParams | readonly PatchSpec[] | undefined;
}>;

/**
 * Synth voice parameters by Strudel name; only the ones given are stored
 * and the rest take dawg's defaults. Lanes go under `automation.fx` as
 * `"synth-<param>"` (e.g. `"synth-lpf"`), read at each note's onset.
 * Every parameter, range and default: **Synth** in DAWG.md.
 */
/**
 * Modelled keys settings (SDK 1.24.0), for a track whose instrument is a
 * piano family (`"grand"`, `"upright"`, `"felt"`, `"honkytonk"`,
 * `"prepared"`; the words `"ballad"` and `"lofi"` pick presets) or, from
 * SDK 1.26.0, an electric family (`"epiano"`, `"wurli"`, `"clav"`; presets
 * epiano suitcase dyno wurli clav funkclav). Every field is optional; `{}`
 * is the family's own sound. Automate a parameter with
 * `automation.fx["keys-<param>"]` (hardness, touch, decay, release, knock,
 * noise, felt; electric tone, vibe, trem), read at each note's onset.
 * Ranges: **Keys** in DAWG.md.
 */
export type KeysInput = Readonly<{
  /**
   * A named preset: grand ballad upright felt lofi honkytonk prepared, or
   * electric epiano suitcase dyno wurli clav funkclav.
   */
  preset?: string;
  /** Hammer hardness 0..1: brightness at a given velocity (0.5). */
  hardness?: number;
  /** Velocity sensitivity 0..1 (1). */
  touch?: number;
  /** Inharmonicity multiplier 0..4 (1 grand, 2.5 upright, 0 harmonic). */
  inharm?: number;
  /** Unison detune in cents 0..30 (0.7; honkytonk 16). */
  unison?: number;
  /** Sustain time multiplier 0.1..4 (1). */
  decay?: number;
  /** Damper time multiplier 0.1..4 (1). */
  release?: number;
  /** Hammer position along the string 0.04..0.3 (0.12). */
  strike?: number;
  /** Aftersound share 0..1 (0.3). */
  after?: number;
  /** Soundboard knock 0..1 (0.5). */
  knock?: number;
  /** Key and damper mechanics 0..1 (0.25). */
  noise?: number;
  /** Felt strip 0..1 (0; felt family 1). */
  felt?: number;
  /** Share of prepared keys 0..1 (0; prepared family 0.6). */
  prep?: number;
  /** Keyboard stereo width 0..1 (0.6). */
  width?: number;
  /** Octave stretch 0..1 (1); 0 keeps every key exactly on its tuning. */
  stretch?: number;
  /** Body EQ: grand upright felt honkytonk prepared (the family's own). */
  body?: string;
  /** Pitch wobble rate in Hz (tape wow), 0 off. */
  vib?: number;
  /** Pitch wobble depth in semitones (0.5). */
  vibmod?: number;
  // keys-electric (SDK 1.26.0)
  /** Sympathetic string resonance 0..1 under the sustain pedal (0; pianos). */
  sym?: number;
  /** Pickup drive 0..1: growl when played hard (0.35; epiano, wurli). */
  bark?: number;
  /** Tine or reed bell ping 0..1 (0.5; epiano, wurli). */
  bell?: number;
  /** Output low-pass in Hz, 0 off (electric keys). */
  tone?: number;
  /** Clav pickup switch: neck bridge both out ("both"). */
  pickup?: "neck" | "bridge" | "both" | "out";
  /** Clav mute slider 0..1 (0). */
  mute?: number;
  /** Suitcase stereo vibrato depth 0..1 (0; epiano). */
  vibe?: number;
  /** Suitcase vibrato rate in Hz 0.5..12 (4; epiano). */
  vibehz?: number;
  // Organs (SDK 1.28.0), for instrument `"tonewheel"`, `"combo"` or
  // `"pipe"` (presets tonewheel gospel jazzorgan combo vox pipe flutes
  // cornet reeds celeste). `"organ"` stays the legacy sine voice.
  /** Tonewheel drawbars, nine digits 0-8, 16' to 1' (`"888000000"`). */
  drawbars?: string;
  /** Tonewheel percussion: off 2nd 3rd. */
  perc?: string;
  /** Percussion decay: fast slow. */
  percdecay?: string;
  /** Key click 0..1. */
  click?: number;
  /** Scanner vibrato/chorus: off v1 v2 v3 c1 c2 c3. */
  scanner?: string;
  /** Preamp drive 0..1 (lane `keys-drive`). */
  drive?: number;
  /** Rotary speaker: slow fast stop (lane `keys-rotary`). */
  rotary?: string;
  /** Combo registers, five digits 0-8, 16' 8' 4' 2⅔' 2' (`"08800"`). */
  registers?: string;
  /**
   * Pipe stops: names or a registration (plenum flutes cornet reeds strings
   * full), as one string or a list (`["principal8", "octave4"]`).
   */
  stops?: string | readonly string[];
  /** Pipe chiff 0..1. */
  chiff?: number;
  /** Pipe wind unsteadiness 0..1. */
  wind?: number;
  /** Tremolo depth 0..1: reed piano (0; wurli), pipe tremulant (0; pipe). */
  trem?: number;
}>;

export type SynthInput = Readonly<{
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  gain?: number;
  /** Pink noise mixed into the oscillator, 0..1. */
  noise?: number;
  /** Crackle impulse density. */
  density?: number;
  /** Unison voices (supersaw defaults to 5). */
  unison?: number;
  /** Unison detune spread in semitones. */
  detune?: number;
  /** Stereo spread of the unison voices, 0..1. */
  spread?: number;
  /** Pulse width 0..1 (`pulse`). */
  pw?: number;
  pwrate?: number;
  pwsweep?: number;
  /** Vibrato rate (Hz) and depth (semitones). */
  vib?: number;
  vibmod?: number;
  /** Pitch envelope depth (semitones) and shape. */
  penv?: number;
  pattack?: number;
  pdecay?: number;
  psustain?: number;
  prelease?: number;
  pcurve?: number;
  panchor?: number;
  lpf?: number;
  lpq?: number;
  lpenv?: number;
  hpf?: number;
  hpq?: number;
  hpenv?: number;
  bpf?: number;
  bpq?: number;
  bpenv?: number;
  /** `12db`, `24db` or `ladder`. */
  ftype?: string;
  /** FM index and harmonicity ratio; `fm2`…`fm8` add operators. */
  fm?: number;
  fmh?: number;
  fmattack?: number;
  fmdecay?: number;
  fmsustain?: number;
  fmrelease?: number;
  /** `lin` or `exp`. */
  fmenv?: string;
  /** `sine`, `sawtooth`, `square` or `triangle`. */
  fmwave?: string;
  /** Harmonic amplitudes for `user` (or any basic waveform). */
  partials?: readonly number[];
  phases?: readonly number[];
  /** ZzFX controls for `z_*` sounds (units: DAWG.md "Synth"). */
  zrand?: number;
  curve?: number;
  slide?: number;
  deltaSlide?: number;
  pitchJump?: number;
  pitchJumpTime?: number;
  lfo?: number;
  zmod?: number;
  zcrush?: number;
  zdelay?: number;
  tremolo?: number;
  /** Any other Strudel synth parameter, e.g. `lpattack`, `fmh3`. */
  [param: string]: number | string | boolean | readonly number[] | undefined;
}>;

/** Input to `track()`. Omitted fields keep dawg's defaults. */
export type TrackInput = Readonly<{
  /** Stable id dawg assigned; defaults to the slug of `name`. Keep it when editing. */
  id?: string;
  /** Shown in the header; its slug names `tracks/<slug>/`. */
  name: string;
  /**
   * Synth voice (`sine`, `piano`, `pluck`, `bass`, `saw`, `square`,
   * `triangle`, and Strudel's `sawtooth`, `supersaw`, `pulse`, `user`,
   * `white`, `pink`, `brown`, `crackle`, and the ZzFX sounds `z_sine`,
   * `z_triangle`, `z_sawtooth`, `z_square`, `z_tan`, `z_noise`), `kit` for drums,
   * `sampler(...)` or `wavetable(...)`, or a mallet or bell (`vibes`,
   * `glock`, `gong`, … or `modal(...)`, SDK 1.25.0). Default `sine`.
   */
  instrument?:
    | string
    | SamplerSpec
    | WavetableSpec
    | StringSpec
    | GranularSpec
    | ModalSpec
    | WindSpec
    | SingSpec
    | VocoderSpec
    | PatchSpec
    | PatchRefSpec;
  /**
   * A vocoder on this track (SDK 1.32.0): `vocoder({ src: "vox" })` lets
   * the vox track's voice shape this track's sound; `null` removes it.
   */
  vocoder?: VocoderSpec | null;
  /**
   * The sampler a `granular(...)` track keeps while it grains one of its
   * voices (SDK 1.23.0); `grain off` plays it again.
   */
  sampler?: SamplerSpec | null;
  /**
   * The `wavetable(...)` a track keeps after it left the wavetable
   * instrument (SDK 1.32.0), so switching back restores it. A wavetable
   * track takes its table from `instrument` instead.
   */
  wavetable?: WavetableSpec | null;
  /**
   * Granular engine (SDK 1.23.0) for an `instrument: "granular"` track, or
   * use `instrument: granular("cloud", {...})` or a word (`"cloud"`).
   */
  granular?: GranularInput | null;
  /**
   * Synthesized drum kit for an `instrument: "kit"` track: `syn808`,
   * `syn909`, `acoustic`, `lofi`, `electro` or `trap`. Omit for the default
   * voices.
   */
  kit?: string;
  /**
   * The track's own clock against the song (SDK 1.14.0): `rate` 1.5 plays
   * three beats in two, `phase` starts it that many beats later, `cycle`
   * repeats its first `cycle` beats (a 3-beat cycle over 4/4 is polymeter).
   * `{ cycle: 3, rate: 13 / 12 }` drifts against a twin and realigns, the
   * tape phasing of Reich's Come Out; `phasing()` works the rate out for
   * you, and `stepPhasing()` gives Piano Phase's shift and hold.
   */
  time?: TrackTimeInput;
  /**
   * This track's tuning over the song's (SDK 1.16.0): a library name such
   * as `"pelog"` or `{ edo, ratios, cents, scl, kbm, ref, root, map }`.
   * `{ ref: 432 }` alone keeps the song's table at another pitch.
   */
  tuning?: TuningInput | null;
  /**
   * Wind engine settings as a field (SDK 1.32.0): a preset word or
   * `{ preset, ...params }`, the same as `instrument: wind(...)`. Use with
   * `instrument` omitted or `"wind"`.
   */
  wind?:
    WindPresetName | Readonly<{ preset?: WindPresetName } & WindParams> | null;
  /**
   * Singing voice settings as a field (SDK 1.32.0), the same as
   * `instrument: sing(...)`. Use with `instrument` omitted or `"sing"`.
   */
  sing?:
    SingPresetName | Readonly<{ preset?: SingPresetName } & SingParams> | null;
  /** Synth voice parameters, Strudel names (`{ attack: 0.01, lpf: 800 }`). */
  synth?: SynthInput;
  /**
   * String engine (SDK 1.21.0) for an `instrument: "string"` track, or use
   * `instrument: stringed("sitar", {...})` or a preset word (`"nylon"`).
   */
  string?: StringInput | null;
  /**
   * Modelled piano settings (SDK 1.24.0) for `instrument: "grand"` and the
   * other piano families; `{}` is the family's sound. The word `"piano"`
   * keeps the classic 0.4 tone; use `"grand"` for the modelled piano.
   */
  keys?: KeysInput;
  muted?: boolean;
  /** When any track is soloed only soloed tracks play. */
  solo?: boolean;
  /** 0..1, default 1. */
  volume?: number;
  /** -1 (left) .. 1 (right), default 0. */
  pan?: number;
  /** Filter (low-pass unless `type`); `null` or omitted means none. */
  filter?: FilterInput | null;
  /** Tempo-synced delay send in beats. */
  delay?: DelayInput | null;
  /** Stereo reverb send. */
  reverb?: ReverbInput | null;
  /**
   * Insert effects by name (`{ distort: { drive: 3 }, chorus: {} }`), and
   * effect patches under `patch` (SDK 1.35.0): `fx: { patch: [wideCrush] }`.
   */
  fx?: TrackFxInput;
  automation?: AutomationInput;
  /**
   * Signals that turn a patch's macros (SDK 1.35.0), by macro id:
   * `mods: { cutoff: sine.range(300, 2400).slow(4) }`. `song()` bakes each
   * into the macro's automation lane (`patch-<macro>`); a lane written
   * under `automation.fx` wins.
   */
  mods?: Readonly<Record<string, PatternSignal>>;
  /**
   * Signals that write automation lanes (SDK 1.35.0), by lane name as
   * `automation.fx` takes them: `lanes: { "synth-lpf": sine.range(400, 3000) }`.
   * `song()` bakes them into points; a lane written under `automation.fx` wins.
   */
  lanes?: Readonly<Record<string, PatternSignal>>;
  /**
   * Glide between notes (SDK 1.15.0): seconds (`glide: 0.08`, TB-303 style
   * legato) or `{ time, mode }`. Mode `legato` glides only into a note that
   * overlaps the previous one and does not retrigger it; `mono` always
   * glides and retriggers; `poly` glides every voice of a chord from the
   * matching voice of the previous one.
   */
  glide?: number | Readonly<{ time?: number; mode?: GlideMode }>;
  /** Sustain pedal changes as `[beat, "down" | "half" | "up"]` (SDK 1.15.0). */
  pedal?: readonly (readonly [number, PedalState])[];
  /**
   * Una corda on a modelled piano (SDK 1.26.0): `[beat, "down" | "half" |
   * "up"]`; while down each note strikes fewer strings, softer and darker.
   */
  softPedal?: readonly (readonly [number, PedalState])[];
  /**
   * Sostenuto on a modelled piano (SDK 1.26.0): `[beat, "down" | "up"]`;
   * holds only the keys already down when it presses.
   */
  sostenuto?: readonly (readonly [number, "down" | "up"])[];
  /**
   * Audio clips on the timeline (SDK 1.32.0): `audio("samples/lead.wav",
   * { at: 8 })`, or `...repeatAudio(audio(...), { every: 8, until: 64 })`.
   * They sound on any instrument; on `vocal` the notes are silent guides.
   */
  clips?: readonly (AudioSpec | readonly AudioSpec[])[];
  /** Takes the clips play from (SDK 1.32.0): `take("take-1", "takes/take-1.wav", {...})`. */
  takes?: readonly TakeSpec[];
  /**
   * Velocity response (SDK 1.15.0): `soft` (quiet notes louder), `hard`
   * (needs a firm touch), `fixed` (every note at 0.8, like an organ) or
   * `{ curve: "fixed", fixed: 0.6 }`. Default `linear`.
   */
  velocityCurve?:
    VelocityCurveName | Readonly<{ curve: VelocityCurveName; fixed?: number }>;
  /**
   * Seeded humanize applied when dawg renders, so the notes stay as written
   * (SDK 1.15.0): `timing` ms either side, `velocity` and `length` in
   * percent, `seed` (default 1) picks another take.
   */
  humanize?: Readonly<{
    timing?: number;
    velocity?: number;
    length?: number;
    seed?: number;
  }>;
  /**
   * How chords are fretted on this track (SDK 1.27.0): `{ tune: "dadgad",
   * capo: 2 }`. dawg's `strum` command and perform mode `guitar` use it;
   * it changes no sound by itself.
   */
  guitar?: GuitarInput;
  /**
   * Pitch correction on this track's clips and samples (SDK 1.32.0): a
   * preset word (`"hard"`), or `autotune("pop", { speed: 40 })`.
   */
  autotune?: AutotunePresetName | AutotuneSpec;
  /** `note()`/`seq()` for pitched tracks, `hit()`/`hits()` for kits and one-shot samplers. */
  notes?: readonly (NoteSpec | HitSpec)[];
  /**
   * Generated voices, one row per voice: `euclid()`/`grid()`. dawg expands
   * them into hits when the song loads; a row owns its voice, so `notes`
   * on the same voice are replaced.
   */
  rhythm?: readonly RhythmSpec[];
}>;

export type FilterInput = Readonly<{
  cutoff: number;
  resonance?: number;
  /** `lpf` (default), `hpf` or `bpf`. */
  type?: "lpf" | "hpf" | "bpf";
  /** Slope: `12db` (default), `24db` or `ladder`. */
  ftype?: "12db" | "24db" | "ladder";
}>;

export type DelayInput = Readonly<{
  beats: number;
  feedback?: number;
  mix?: number;
  /** Seconds; overrides `beats` when set (Strudel `delaytime`). */
  time?: number;
  /** Repeats alternate left/right. */
  pingpong?: boolean;
  /** Low-pass on the repeats, Hz. */
  highcut?: number;
}>;

export type ReverbInput = Readonly<{
  mix: number;
  size?: number;
  /** Decay to -60 dB in seconds (Strudel `roomfade`). */
  fade?: number;
  /** Low-pass on the input, Hz (Strudel `roomlp`). */
  lowpass?: number;
  /** Damping toward this Hz as the tail decays (Strudel `roomdim`). */
  dim?: number;
  /** Seconds before the tail. */
  predelay?: number;
  /**
   * Convolution reverb (Strudel `iresponse`/`ir`): `"room"`, `"hall"`,
   * `"plate"` (generated), a pack sound `pack:<pack>/<sound>[:<n>]` or a
   * track-relative audio file. `size`, `fade` and `dim` then do nothing.
   */
  ir?:
    | string
    | Readonly<{
        src: string;
        sha256?: string;
        url?: string;
        license?: string;
      }>;
}>;

/** `track({ time })`: every field optional; absent follows the song. */
export type TrackTimeInput = Readonly<{
  /** Tempo ratio against the song, 0.125..8 (1 = in step). */
  rate?: number;
  /** Beats the track's pattern starts late (negative: early); it wraps. */
  phase?: number;
  /** Beats of the track that repeat, default the whole song loop. */
  cycle?: number;
  /**
   * Stepped phasing (SDK 1.19.0), as in Reich's Piano Phase: hold `hold`
   * cycles in step, then move `shift` beats ahead over `drift` cycles, and
   * repeat. Needs `cycle`; replaces `rate`. `stepPhasing()` builds it.
   */
  steps?: Readonly<{ shift: number; hold: number; drift: number }>;
}>;

/** Frozen track built by `track()`; `song()` consumes it. Beats, not ticks. */
export type TrackSpec = Readonly<{
  kind: "track";
  id: string;
  name: string;
  slug: string;
  instrument: string;
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  filter: Readonly<
    { cutoff: number; resonance: number } & Partial<FilterInput>
  > | null;
  delay: Readonly<
    { beats: number; feedback: number; mix: number } & Partial<DelayInput>
  > | null;
  reverb: Readonly<{ mix: number; size: number } & Partial<ReverbInput>> | null;
  fx: FxInput | null;
  synth: SynthInput | null;
  sampler: SamplerSpec | null;
  wavetable: WavetableSpec | null;
  /** String engine settings (SDK 1.21.0); present only when set. */
  string?: StringInput;
  /** Granular engine settings (SDK 1.23.0); null when not granular. */
  granular?: GranularInput | null;
  automation: Readonly<Required<AutomationInput>>;
  /** Every hit resolved to its pitch slot. */
  notes: readonly NoteSpec[];
  /** Rhythm rows in order (voice names as written). */
  rhythm: readonly RhythmSpec[];
  kit: string | null;
  /** Present only when `track({ time })` set something. */
  time?: TrackTimeInput;
  /** Performance (SDK 1.15.0); present only when set. */
  glide?: Readonly<{ time: number; mode: GlideMode }>;
  pedal?: readonly (readonly [number, PedalState])[];
  /** Soft and sostenuto pedals (SDK 1.26.0); present only when set. */
  softPedal?: readonly (readonly [number, PedalState])[];
  sostenuto?: readonly (readonly [number, PedalState])[];
  velocityCurve?: Readonly<{
    curve: Exclude<VelocityCurveName, "linear">;
    fixed?: number;
  }>;
  humanize?: Readonly<{
    timing?: number;
    velocity?: number;
    length?: number;
    seed: number;
  }>;
  tuning: ScoreTuning | null;
  /** Modelled piano settings (SDK 1.24.0); present only when set. */
  keys?: KeysInput;
  /** Modal settings (SDK 1.25.0); present only on a modal track. */
  modal?: Readonly<{ preset?: ModalPresetName } & ModalParams>;
  /** Guitar fretting (SDK 1.27.0); present only when set. */
  guitar?: GuitarSetup;
  /** Wind settings (SDK 1.30.0); present only on a wind-engine track. */
  wind?: Readonly<{ preset?: WindPresetName } & WindParams>;
  /** Sing settings (SDK 1.32.0); present only on a sing track. */
  sing?: Readonly<{ preset?: SingPresetName } & SingParams>;
  /** Audio clips (SDK 1.32.0), flattened, paths project-relative; present only when set. */
  clips?: readonly AudioSpec[];
  /** Takes (SDK 1.32.0); present only when set. */
  takes?: readonly TakeSpec[];
  /** Vocoder settings (SDK 1.32.0); `src` as written until `song()`. */
  vocoder?: Readonly<{ preset?: VocoderPresetName } & VocoderParams>;
  /** Pitch correction (SDK 1.32.0); present only when set. */
  autotune?: AutotuneSettings;
  /** The patch this track plays (SDK 1.35.0); instrument is then `"patch"`. */
  patch?: PatchSpec | PatchRefSpec;
  /** Effect patches (SDK 1.35.0), in order. */
  fxPatch?: readonly PatchSpec[];
  /** Signals on macros and lanes (SDK 1.35.0); `song()` bakes them. */
  mods?: Readonly<Record<string, PatternSignal>>;
  lanes?: Readonly<Record<string, PatternSignal>>;
}>;

export type GlideMode = "legato" | "mono" | "poly";
export type PedalState = "down" | "half" | "up";
export type VelocityCurveName = "linear" | "soft" | "hard" | "fixed";

const DEFAULT_GLIDE_SECONDS = 0.06;
const DEFAULT_FIXED_VELOCITY = 0.8;

/** Normalizes `track()` performance options; dawg validates the ranges. */
function trackPerformance(
  input: TrackInput,
  name: string,
): Partial<
  Pick<
    TrackSpec,
    "glide" | "pedal" | "softPedal" | "sostenuto" | "velocityCurve" | "humanize"
  >
> {
  const out: {
    glide?: TrackSpec["glide"];
    pedal?: TrackSpec["pedal"];
    softPedal?: TrackSpec["softPedal"];
    sostenuto?: TrackSpec["sostenuto"];
    velocityCurve?: TrackSpec["velocityCurve"];
    humanize?: TrackSpec["humanize"];
  } = {};
  if (input.glide !== undefined) {
    const raw =
      typeof input.glide === "number" ? { time: input.glide } : input.glide;
    if (!isRecord(raw))
      throw new DawgSdkError(
        `track ${name}: glide must be seconds or { time, mode }`,
      );
    const mode = raw.mode ?? "legato";
    if (!["legato", "mono", "poly"].includes(mode))
      throw new DawgSdkError(
        `track ${name}: glide mode must be legato, mono or poly`,
      );
    out.glide = Object.freeze({
      time: finite(raw.time ?? DEFAULT_GLIDE_SECONDS, `${name} glide time`),
      mode,
    });
  }
  const pedalLane = (
    key: "pedal" | "softPedal" | "sostenuto",
    states: readonly PedalState[],
  ) => {
    const value: unknown = input[key];
    if (value === undefined) return;
    const shape = `[beat, ${states.map((state) => `"${state}"`).join(" | ")}]`;
    if (!Array.isArray(value) || value.length > 1024)
      throw new DawgSdkError(
        `track ${name}: ${key} must be at most 1024 ${shape} events`,
      );
    if (value.length > 0)
      out[key] = Object.freeze(
        value.map((event: unknown, index: number) => {
          if (
            !Array.isArray(event) ||
            event.length !== 2 ||
            !states.includes(event[1] as PedalState)
          )
            throw new DawgSdkError(
              `track ${name}: ${key}[${index}] must be ${shape}`,
            );
          return Object.freeze([
            beat(event[0], `${name} ${key}[${index}] beat`),
            event[1] as PedalState,
          ] as const);
        }),
      );
  };
  pedalLane("pedal", ["down", "half", "up"]);
  pedalLane("softPedal", ["down", "half", "up"]);
  pedalLane("sostenuto", ["down", "up"]);
  if (input.velocityCurve !== undefined) {
    const raw =
      typeof input.velocityCurve === "string"
        ? { curve: input.velocityCurve }
        : input.velocityCurve;
    if (
      !isRecord(raw) ||
      !["linear", "soft", "hard", "fixed"].includes(raw.curve as string)
    )
      throw new DawgSdkError(
        `track ${name}: velocityCurve must be linear, soft, hard or fixed`,
      );
    if (raw.curve === "fixed")
      out.velocityCurve = Object.freeze({
        curve: "fixed",
        fixed: unit(
          raw.fixed ?? DEFAULT_FIXED_VELOCITY,
          `${name} velocityCurve fixed`,
        ),
      });
    else if (raw.curve !== "linear")
      out.velocityCurve = Object.freeze({ curve: raw.curve });
  }
  if (input.humanize !== undefined) {
    if (!isRecord(input.humanize))
      throw new DawgSdkError(
        `track ${name}: humanize must be { timing, velocity, length, seed }`,
      );
    const amount = (key: "timing" | "velocity" | "length") => {
      const value = input.humanize![key];
      return value === undefined ? 0 : finite(value, `${name} humanize ${key}`);
    };
    const timing = amount("timing");
    const velocity = amount("velocity");
    const length = amount("length");
    const seed = input.humanize.seed ?? 1;
    if (!Number.isInteger(seed) || seed < 0)
      throw new DawgSdkError(
        `track ${name}: humanize seed must be an integer ≥ 0`,
      );
    if (timing !== 0 || velocity !== 0 || length !== 0)
      out.humanize = Object.freeze({
        ...(timing !== 0 ? { timing } : {}),
        ...(velocity !== 0 ? { velocity } : {}),
        ...(length !== 0 ? { length } : {}),
        seed,
      });
  }
  return out;
}

/**
 * A raw ZzFX parameter array (Strudel `zzfx([...])`, ZzFX's own layout:
 * volume, randomness, frequency, attack, sustain, release, shape,
 * shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime,
 * noise, modulation, bitCrush, delay, sustainVolume, decay, tremolo,
 * filter) as a `z_*` instrument and synth parameters to spread into a
 * track. Empty slots take ZzFX's defaults; frequency and sustain time come
 * from each note. `filter` > 0 is a high-pass in Hz, < 0 a low-pass.
 *
 * ```ts
 * track({ name: "blip", ...zzfx([, , , 0.01, , 0.15, 2, , 5]), notes })
 * ```
 */
export function zzfx(
  values: readonly (number | null | undefined)[],
): Readonly<{ instrument: string; synth: SynthInput }> {
  if (!Array.isArray(values) || values.length > ZZFX_LAYOUT.length)
    throw new DawgSdkError(
      `zzfx takes an array of at most ${ZZFX_LAYOUT.length} numbers`,
    );
  const synth: Record<string, number> = {
    zrand: 0.05,
    attack: 0,
    release: 0.1,
  };
  let instrument = "z_sine";
  ZZFX_LAYOUT.forEach((name, index) => {
    const value: unknown = values[index];
    if (name === null || value === undefined || value === null) return;
    const n = finite(value, `zzfx[${index}]`);
    if (name === "shape")
      instrument = ZZFX_SHAPES[Math.max(0, Math.min(5, Math.round(n)))]!;
    else if (name === "filter") {
      if (n !== 0) synth[n > 0 ? "hpf" : "lpf"] = Math.abs(n);
    } else synth[name] = n;
  });
  return Object.freeze({ instrument, synth: Object.freeze(synth) });
}

const ZZFX_LAYOUT = Object.freeze([
  "gain",
  "zrand",
  null,
  "attack",
  null,
  "release",
  "shape",
  "curve",
  "slide",
  "deltaSlide",
  "pitchJump",
  "pitchJumpTime",
  "lfo",
  "noise",
  "zmod",
  "zcrush",
  "zdelay",
  "sustain",
  "decay",
  "tremolo",
  "filter",
] as const);

const ZZFX_SHAPES = Object.freeze([
  "z_sine",
  "z_triangle",
  "z_sawtooth",
  "z_tan",
  "z_noise",
  "z_square",
] as const);

/**
 * Build a track. Hits are resolved to pitches here: GM numbers on a kit,
 * voice slots (36, 37, … in voice-name order) on a one-shot sampler.
 * Sample paths without a `tracks/` prefix are made project-relative under
 * this track's `tracks/<slug>/`.
 */
/**
 * `wind:` or `sing:` on track() as the engine spec, so the field is never
 * silently dropped: it needs `instrument` omitted or the engine's own word.
 */
function engineField(
  input: TrackInput,
  name: string,
): WindSpec | SingSpec | undefined {
  const fields = [
    ["wind", WIND_INSTRUMENT, wind] as const,
    ["sing", SING_INSTRUMENT, sing] as const,
  ].filter(([key]) => input[key] !== undefined && input[key] !== null);
  if (fields.length === 0) return undefined;
  if (fields.length > 1)
    throw new DawgSdkError(`track ${name}: use wind: or sing:, not both`);
  const [key, word, make] = fields[0]!;
  if (input.instrument !== undefined && input.instrument !== word)
    throw new DawgSdkError(
      `track ${name}: ${key}: needs instrument "${word}" or none (got ${typeof input.instrument === "string" ? `"${input.instrument.slice(0, 32)}"` : "an engine spec"})`,
    );
  const value = input[key] as unknown;
  if (typeof value === "string")
    return (make as (p: string) => WindSpec | SingSpec)(value);
  if (!isRecord(value))
    throw new DawgSdkError(
      `track ${name}: ${key}: must be a preset word or an object`,
    );
  const { preset, ...params } = value as Record<string, unknown>;
  return (make as (p: unknown, q: object) => WindSpec | SingSpec)(
    preset ?? params,
    preset === undefined ? {} : params,
  );
}

export function track(input: TrackInput): TrackSpec {
  if (!isRecord(input)) throw new DawgSdkError("track() needs an object");
  if (typeof input.name !== "string" || input.name.trim().length === 0)
    throw new DawgSdkError("track name must be a non-empty string");
  if (input.name.length > 96)
    throw new DawgSdkError("track name must be at most 96 characters");
  const name = input.name;
  const slug = slugify(name);
  const id = input.id ?? slug;
  if (typeof id !== "string" || id.length === 0 || id.length > 64)
    throw new DawgSdkError(`track ${name}: id must be 1..64 characters`);
  // A patch (SDK 1.35.0) plays as the "patch" instrument.
  const patchValue = trackPatchValue(input.instrument, name);
  const fxPatches = trackFxPatches(input.fx, name);
  if (patchValue || fxPatches) {
    const { patch: _patch, ...effects } = (
      isRecord(input.fx) ? input.fx : {}
    ) as Record<string, unknown>;
    input = {
      ...input,
      ...(patchValue ? { instrument: PATCH_INSTRUMENT_WORD } : {}),
      ...(fxPatches ? { fx: effects as FxInput } : {}),
    };
  }
  const rawInstrument = engineField(input, name) ?? input.instrument ?? "sine";
  // A granular track may keep the sampler it grains (`grain off` goes back).
  const keptSampler =
    isRecord(input.sampler) &&
    input.sampler.kind === "sampler" &&
    isRecord(rawInstrument) &&
    rawInstrument.kind === "granular"
      ? localizeSampler(input.sampler as SamplerSpec, slug)
      : null;
  if (input.sampler !== undefined && input.sampler !== null && !keptSampler)
    throw new DawgSdkError(
      `track ${name}: sampler: is only for a granular(...) track; use instrument: sampler({...})`,
    );
  const samplerSpec =
    isRecord(rawInstrument) && rawInstrument.kind === "sampler"
      ? localizeSampler(rawInstrument as SamplerSpec, slug)
      : keptSampler;
  const playedWavetable =
    isRecord(rawInstrument) && rawInstrument.kind === "wavetable";
  if (input.wavetable !== undefined && input.wavetable !== null) {
    if (!isRecord(input.wavetable) || input.wavetable.kind !== "wavetable")
      throw new DawgSdkError(`track ${name}: wavetable: takes wavetable(...)`);
    if (
      playedWavetable ||
      (typeof rawInstrument === "string" &&
        rawInstrument.trim().toLowerCase() === WAVETABLE_INSTRUMENT)
    )
      throw new DawgSdkError(
        `track ${name}: a wavetable track sets its table in instrument: wavetable(...)`,
      );
  }
  const wavetableSpec = playedWavetable
    ? localizeWavetable(rawInstrument as WavetableSpec, slug)
    : isRecord(input.wavetable)
      ? localizeWavetable(input.wavetable as WavetableSpec, slug)
      : null;
  const stringFromInstrument =
    isRecord(rawInstrument) && rawInstrument.kind === "string"
      ? stringInput(rawInstrument, name)
      : null;
  const granularFromInstrument =
    isRecord(rawInstrument) && rawInstrument.kind === "granular"
      ? granularInput(rawInstrument, name, slug)
      : null;
  const word =
    typeof rawInstrument === "string"
      ? resolveInstrumentWord(rawInstrument)
      : undefined;
  const modalSpec = trackModal(rawInstrument);
  const guitarSpec = guitarInput(input.guitar, `track ${name}`);
  const windSpec = trackWind(rawInstrument);
  const singSpec = trackSing(rawInstrument);
  const vocoderSpec = trackVocoder(rawInstrument, input.vocoder);
  const instrument = granularFromInstrument
    ? GRANULAR_INSTRUMENT
    : samplerSpec
      ? SAMPLER_INSTRUMENT
      : playedWavetable
        ? WAVETABLE_INSTRUMENT
        : stringFromInstrument
          ? STRING_INSTRUMENT
          : modalSpec
            ? MODAL_INSTRUMENT
            : windSpec
              ? WIND_INSTRUMENT
              : singSpec
                ? SING_INSTRUMENT
                : isRecord(rawInstrument) && rawInstrument.kind === "vocoder"
                  ? VOCODER_INSTRUMENT
                  : typeof rawInstrument === "string"
                    ? (word?.instrument ?? rawInstrument)
                    : undefined;
  // A granular word (`"cloud"`) turns the engine on with its preset.
  const granularSpec =
    granularInput(input.granular, name, slug) ??
    granularFromInstrument ??
    (word?.field === "granular" && word.preset
      ? Object.freeze({ preset: word.preset })
      : instrument === GRANULAR_INSTRUMENT
        ? Object.freeze({})
        : null);
  if (
    instrument === undefined ||
    instrument.length === 0 ||
    instrument.length > 64
  )
    throw new DawgSdkError(
      `track ${name}: instrument must be a voice name, "kit", sampler(...), wavetable(...), stringed(...), granular(...) or modal(...)`,
    );
  if (instrument === SAMPLER_INSTRUMENT && !samplerSpec)
    throw new DawgSdkError(
      `track ${name}: use instrument: sampler({...}) for a sampler track`,
    );
  const slots =
    samplerSpec && instrument === SAMPLER_INSTRUMENT
      ? voiceSlots(samplerSpec)
      : undefined;
  const kit = KIT_INSTRUMENTS.includes(instrument.trim().toLowerCase());
  const notes = (input.notes ?? []).map((item, index) => {
    if (!isRecord(item) || (item.kind !== "note" && item.kind !== "hit"))
      throw new DawgSdkError(
        `track ${name}: notes[${index}] must come from note(), seq(), hit() or hits()`,
      );
    if (item.kind === "note") return item as NoteSpec;
    const spec = item as HitSpec;
    const pitch = kit
      ? DRUM_PITCHES[
          DRUM_ALIASES[spec.voice.trim().toLowerCase()] ??
            (undefined as unknown as DrumVoice)
        ]
      : slots?.get(spec.voice);
    if (pitch === undefined)
      throw new DawgSdkError(
        kit
          ? `track ${name}: unknown drum "${spec.voice}" (kick snare clap rim tom hat openhat)`
          : slots
            ? `track ${name}: unknown sampler voice "${spec.voice}" (${[...slots.keys()].join(" ")})`
            : `track ${name}: hit("${spec.voice}") needs instrument "kit" or sampler(...)`,
      );
    const { kind: _kind, voice: _voice, ...rest } = spec;
    return Object.freeze({ ...rest, kind: "note" as const, pitch });
  });
  if (notes.length > 4096)
    throw new DawgSdkError(`track ${name}: at most 4096 notes`);
  const rhythm = input.rhythm ?? [];
  if (!Array.isArray(rhythm) || rhythm.length > 16)
    throw new DawgSdkError(`track ${name}: rhythm must be at most 16 rows`);
  rhythm.forEach((row, index) => {
    if (!isRecord(row) || row.kind !== "rhythm")
      throw new DawgSdkError(
        `track ${name}: rhythm[${index}] must come from euclid() or grid()`,
      );
  });
  const drumKit = input.kit ?? null;
  if (
    drumKit !== null &&
    (typeof drumKit !== "string" || drumKit.trim().length === 0 || !kit)
  )
    throw new DawgSdkError(
      `track ${name}: kit needs instrument "kit" and a kit name`,
    );
  const automation = input.automation ?? {};
  if (!isRecord(automation))
    throw new DawgSdkError(`track ${name}: automation must be an object`);
  const lane = (
    key: Exclude<keyof AutomationInput, "fx">,
  ): readonly Point[] => {
    const points = (automation as Record<string, unknown>)[key];
    if (points === undefined) return Object.freeze([]);
    if (!Array.isArray(points) || points.length > 256)
      throw new DawgSdkError(
        `track ${name}: automation.${key} must be an array of at most 256 [beat, value] points`,
      );
    return Object.freeze(
      points.map((point: unknown, index: number): Point => {
        if (!Array.isArray(point) || point.length !== 2)
          throw new DawgSdkError(
            `track ${name}: automation.${key}[${index}] must be [beat, value]`,
          );
        return Object.freeze([
          beat(point[0], `automation.${key}[${index}] beat`),
          finite(point[1], `automation.${key}[${index}] value`),
        ] as const);
      }),
    );
  };
  for (const key of Object.keys(automation))
    if (!AUTOMATION_KEYS.includes(key as keyof AutomationInput))
      throw new DawgSdkError(
        `track ${name}: unknown automation lane "${key}" (${AUTOMATION_KEYS.join(" ")})`,
      );
  // A keys preset word (`"lofi"`, `"ballad"`) brings its preset's effects,
  // as the prompt does; explicit filter, fx and reverb win.
  const presetFx = keysPresetFx(input.keys, rawInstrument);
  if (presetFx) {
    input = {
      ...input,
      ...(input.filter === undefined && presetFx.filter
        ? { filter: presetFx.filter }
        : {}),
      ...(input.reverb === undefined && presetFx.reverb
        ? { reverb: presetFx.reverb }
        : {}),
      ...(presetFx.fx && input.fx !== null
        ? { fx: { ...presetFx.fx, ...(isRecord(input.fx) ? input.fx : {}) } }
        : {}),
    };
  }
  const filter =
    input.filter === undefined || input.filter === null
      ? null
      : Object.freeze({
          cutoff: finite(input.filter.cutoff, `${name} filter.cutoff`),
          resonance: finite(
            input.filter.resonance ?? 0,
            `${name} filter.resonance`,
          ),
          ...extras(input.filter, ["type", "ftype"], `${name} filter`),
        });
  const delay =
    input.delay === undefined || input.delay === null
      ? null
      : Object.freeze({
          beats: finite(input.delay.beats, `${name} delay.beats`),
          feedback: finite(
            input.delay.feedback ?? 0.3,
            `${name} delay.feedback`,
          ),
          mix: finite(input.delay.mix ?? 0.35, `${name} delay.mix`),
          ...extras(
            input.delay,
            ["time", "pingpong", "highcut"],
            `${name} delay`,
          ),
        });
  // A rig alias with a wash (`instrument: "shoegaze"`) sets the track
  // reverb the `track shoegaze` prompt sets, unless `reverb` is given.
  if (input.reverb === undefined && typeof rawInstrument === "string") {
    const rigName = resolveInstrumentWord(rawInstrument)?.fx;
    const wash = rigName === undefined ? undefined : RIG_REVERBS[rigName];
    if (wash) input = { ...input, reverb: wash };
  }
  const reverb =
    input.reverb === undefined || input.reverb === null
      ? null
      : Object.freeze({
          mix: finite(input.reverb.mix, `${name} reverb.mix`),
          size: finite(input.reverb.size ?? 0.5, `${name} reverb.size`),
          ...extras(
            input.reverb,
            ["fade", "lowpass", "dim", "predelay"],
            `${name} reverb`,
          ),
          ...(input.reverb.ir === undefined
            ? {}
            : { ir: reverbIr(input.reverb.ir, name, slug) }),
        });
  // A guitar alias (`instrument: "jangle"`) also loads its rig; stages and
  // effects the track's own `fx` names win.
  const aliasRig =
    typeof rawInstrument === "string"
      ? resolveInstrumentWord(rawInstrument)?.fx
      : undefined;
  const fx = fxInput(
    aliasRig === undefined
      ? input.fx
      : { ...rig(aliasRig), ...(isRecord(input.fx) ? input.fx : {}) },
    name,
  );
  const synth = synthInput(input.synth, name);
  // A string preset word (`"nylon"`) turns the engine on with its preset.
  const string =
    stringInput(input.string, name) ??
    stringFromInstrument ??
    (word?.field === "string" && word.preset
      ? Object.freeze({ preset: word.preset })
      : null);
  return Object.freeze({
    kind: "track",
    id,
    name,
    slug,
    instrument,
    muted: bool(input.muted ?? false, `${name} muted`),
    solo: bool(input.solo ?? false, `${name} solo`),
    volume: finite(input.volume ?? 1, `${name} volume`),
    pan: finite(input.pan ?? 0, `${name} pan`),
    filter,
    delay,
    reverb,
    fx,
    synth,
    sampler: samplerSpec,
    wavetable: wavetableSpec,
    ...(string ? { string } : {}),
    ...(granularSpec ? { granular: granularSpec } : {}),
    automation: Object.freeze({
      volume: lane("volume"),
      pan: lane("pan"),
      filter: lane("filter"),
      resonance: lane("resonance"),
      delayFeedback: lane("delayFeedback"),
      delayMix: lane("delayMix"),
      fx: fxLanes(automation.fx, name),
      wt: lane("wt"),
    }),
    notes: Object.freeze(notes),
    rhythm: Object.freeze([...rhythm]),
    kit: drumKit === null ? null : drumKit.trim(),
    ...trackTime(input.time, name),
    ...trackPerformance(input, name),
    tuning: tuningSpec(input.tuning, `track ${name}`),
    ...keysSpec(input.keys, rawInstrument, name),
    ...(modalSpec ? { modal: modalSpec } : {}),
    ...(guitarSpec ? { guitar: guitarSpec } : {}),
    ...(windSpec ? { wind: windSpec } : {}),
    ...(singSpec ? { sing: singSpec } : {}),
    ...trackClips(input, name, slug),
    ...(vocoderSpec ? { vocoder: vocoderSpec } : {}),
    ...(input.autotune !== undefined
      ? { autotune: autotuneInput(input.autotune, `track ${name}`) }
      : {}),
    ...(patchValue ? { patch: patchValue } : {}),
    ...(fxPatches ? { fxPatch: fxPatches } : {}),
    ...trackSignals(input, name),
  });
}

const PATCH_INSTRUMENT_WORD = "patch";

function trackPatchValue(
  value: unknown,
  name: string,
): PatchSpec | PatchRefSpec | null {
  if (!isPatchValue(value)) return null;
  if ("ref" in value) return value;
  if (value.role !== "instrument")
    throw new DawgSdkError(
      `track ${name}: ${value.name} is an effect patch; place it with fx: { patch: [...] }`,
    );
  return value;
}

function trackFxPatches(
  fx: unknown,
  name: string,
): readonly PatchSpec[] | null {
  if (!isRecord(fx) || fx.patch === undefined) return null;
  if (!Array.isArray(fx.patch) || fx.patch.length > 8)
    throw new DawgSdkError(
      `track ${name}: fx.patch must be a list of at most 8 effect patches`,
    );
  for (const value of fx.patch)
    if (!isPatchValue(value) || "ref" in value || value.role !== "effect")
      throw new DawgSdkError(
        `track ${name}: fx.patch takes effect patches from fxPatch()`,
      );
  return fx.patch.length > 0 ? Object.freeze([...fx.patch]) : null;
}

function signalRecord(
  input: unknown,
  label: string,
): Readonly<Record<string, PatternSignal>> | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input)) throw new DawgSdkError(`${label} must be an object`);
  const out: Record<string, PatternSignal> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!isPatternSignal(value))
      throw new DawgSdkError(
        `${label}.${key} must be a signal (sine, saw, pat("…"), …)`,
      );
    out[key] = value instanceof PatternSignal ? value : signalFromData(value);
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
}

function trackSignals(
  input: TrackInput,
  name: string,
): Partial<Pick<TrackSpec, "mods" | "lanes">> {
  const mods = signalRecord(input.mods, `track ${name}: mods`);
  const lanes = signalRecord(input.lanes, `track ${name}: lanes`);
  return { ...(mods ? { mods } : {}), ...(lanes ? { lanes } : {}) };
}

/**
 * Effects the keys presets set with the voice: a copy of `KEYS_PRESETS`
 * filter, fx and reverb in core/keys.ts (core/keys.test.ts checks they
 * match the prompt's `piano <preset>`).
 */
const KEYS_PRESET_FX: Readonly<
  Record<
    string,
    Readonly<{
      filter?: FilterInput;
      fx?: FxInput;
      reverb?: ReverbInput;
    }>
  >
> = Object.freeze({
  ballad: { reverb: { mix: 0.25, size: 0.7 } },
  felt: { reverb: { mix: 0.2, size: 0.5 } },
  lofi: {
    filter: { cutoff: 3500, resonance: 0.1 },
    fx: { crush: { bits: 10 } },
  },
  // f061-organ: the pipe presets sound in a church.
  pipe: { reverb: { mix: 0.35, size: 0.9 } },
  flutes: { reverb: { mix: 0.3, size: 0.8 } },
  cornet: { reverb: { mix: 0.3, size: 0.8 } },
  reeds: { reverb: { mix: 0.3, size: 0.85 } },
  celeste: { reverb: { mix: 0.35, size: 0.9 } },
});

/**
 * The preset effects an instrument word brings: a preset word that is not
 * also its family (`"lofi"`, `"ballad"`), or any preset word without
 * `keys` (`"felt"`). A printed track names its family and always prints
 * `keys`, so print → eval never adds them twice.
 */
function keysPresetFx(
  keys: unknown,
  word: unknown,
): (typeof KEYS_PRESET_FX)[string] | undefined {
  if (typeof word !== "string") return undefined;
  const meaning = resolveInstrumentWord(word);
  if (meaning?.field !== "keys" || !meaning.preset) return undefined;
  if (keys !== undefined && keys !== null && word === meaning.instrument)
    return undefined;
  return KEYS_PRESET_FX[meaning.preset];
}

/**
 * `keys` for `track()`: the input as given, or `{ preset }` when the
 * instrument word names a keys preset (`"grand"`, `"lofi"`), so the word
 * alone plays the modelled piano. dawg validates the values.
 */
function keysSpec(
  input: unknown,
  word: unknown,
  name: string,
): { keys?: KeysInput } {
  const meaning =
    typeof word === "string" ? resolveInstrumentWord(word) : undefined;
  const preset = meaning?.field === "keys" ? meaning.preset : undefined;
  if (input === undefined || input === null)
    return preset ? { keys: Object.freeze({ preset }) } : {};
  if (!isRecord(input))
    throw new DawgSdkError(`track ${name}: keys must be an object`);
  const out: Record<string, EffectValue> = {};
  // A preset word (`"lofi"`) keeps its preset under given overrides; a
  // family word (`"upright"`) with `keys` is exactly the given keys.
  if (preset && input.preset === undefined && word !== meaning?.instrument)
    out.preset = preset;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    // Pipe stops may be a list: stored as one space-separated string.
    if (key === "stops" && Array.isArray(value)) {
      if (!value.every((stop) => typeof stop === "string"))
        throw new DawgSdkError(`track ${name}: keys.stops must be stop names`);
      out[key] = value.join(" ");
      continue;
    }
    out[key] = effectValue(value, `${name} keys.${key}`);
  }
  return { keys: Object.freeze(out) };
}

/**
 * The modal field an instrument makes: `modal(...)`, or a modal preset
 * word (`"vibes"`, `"glockenspiel"`). The bare words `"modal"` and
 * `"marimba"` keep their pre-0.6 meaning and make none.
 */
function trackModal(
  raw: unknown,
): Readonly<{ preset?: ModalPresetName } & ModalParams> | undefined {
  if (isRecord(raw) && raw.kind === "modal") {
    const { kind: _kind, ...fields } = raw as ModalSpec;
    return Object.freeze(fields);
  }
  if (typeof raw !== "string" || raw === MODAL_INSTRUMENT) return undefined;
  const meaning = resolveInstrumentWord(raw);
  if (meaning?.instrument !== MODAL_INSTRUMENT || !meaning.preset)
    return undefined;
  return Object.freeze({ preset: meaning.preset as ModalPresetName });
}

function trackTime(input: unknown, name: string): { time?: TrackTimeInput } {
  if (input === undefined || input === null) return {};
  if (!isRecord(input))
    throw new DawgSdkError(`track ${name}: time must be an object`);
  for (const key of Object.keys(input))
    if (key !== "rate" && key !== "phase" && key !== "cycle" && key !== "steps")
      throw new DawgSdkError(
        `track ${name}: time takes rate, phase, cycle and steps, not ${key}`,
      );
  const out: {
    rate?: number;
    phase?: number;
    cycle?: number;
    steps?: { shift: number; hold: number; drift: number };
  } = {};
  if (input.rate !== undefined) {
    const rate = finite(input.rate, `track ${name} time.rate`);
    if (rate < 0.125 || rate > 8)
      throw new DawgSdkError(`track ${name}: time.rate must be 0.125..8`);
    if (rate !== 1) out.rate = rate;
  }
  if (input.phase !== undefined) {
    const phase = finite(input.phase, `track ${name} time.phase`);
    if (phase !== 0) out.phase = phase;
  }
  if (input.cycle !== undefined) {
    const cycle = finite(input.cycle, `track ${name} time.cycle`);
    if (cycle <= 0)
      throw new DawgSdkError(`track ${name}: time.cycle must be > 0 beats`);
    out.cycle = cycle;
  }
  if (input.steps !== undefined) {
    if (!isRecord(input.steps))
      throw new DawgSdkError(`track ${name}: time.steps must be an object`);
    if (out.cycle === undefined)
      throw new DawgSdkError(`track ${name}: time.steps needs a cycle`);
    if (out.rate !== undefined)
      throw new DawgSdkError(
        `track ${name}: time takes rate or steps, not both`,
      );
    out.steps = phaseSteps(input.steps, out.cycle, `track ${name} time.steps`);
  }
  return Object.keys(out).length > 0 ? { time: Object.freeze(out) } : {};
}

function phaseSteps(
  input: Record<string, unknown>,
  cycle: number,
  label: string,
): Readonly<{ shift: number; hold: number; drift: number }> {
  const shift = positive(input.shift, `${label}.shift`);
  if (shift > cycle)
    throw new DawgSdkError(`${label}.shift must be at most the cycle`);
  const hold = finite(input.hold, `${label}.hold`);
  if (!Number.isInteger(hold) || hold < 0 || hold > 64)
    throw new DawgSdkError(`${label}.hold must be a whole 0..64 cycles`);
  const drift = finite(input.drift, `${label}.drift`);
  if (!Number.isInteger(drift) || drift < 1 || drift > 64)
    throw new DawgSdkError(`${label}.drift must be a whole 1..64 cycles`);
  return Object.freeze({ shift, hold, drift });
}

const AUTOMATION_KEYS: readonly (keyof AutomationInput)[] = Object.freeze([
  "volume",
  "pan",
  "filter",
  "resonance",
  "delayFeedback",
  "delayMix",
  "fx",
  "wt",
]);

type EffectValue = number | string | boolean;

function effectValue(value: unknown, label: string): EffectValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  return finite(value, label);
}

/** The optional effect fields that are set; dawg validates their ranges. */
function extras(
  input: object,
  keys: readonly string[],
  label: string,
): Record<string, EffectValue> {
  const out: Record<string, EffectValue> = {};
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = effectValue(value, `${label}.${key}`);
  }
  return out;
}

function fxInput(input: unknown, name: string): FxInput | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input))
    throw new DawgSdkError(`track ${name}: fx must be an object of effects`);
  const out: Record<string, EffectParams> = {};
  for (const [effect, params] of Object.entries(input)) {
    if (!isRecord(params))
      throw new DawgSdkError(`track ${name}: fx.${effect} must be an object`);
    const values: Record<string, EffectValue> = {};
    for (const [key, value] of Object.entries(params))
      values[key] = effectValue(value, `${name} fx.${effect}.${key}`);
    out[effect] = Object.freeze(values);
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
}

function stringInput(input: unknown, name: string): StringInput | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input))
    throw new DawgSdkError(`track ${name}: string must be an object`);
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || key === "kind") continue;
    out[key] =
      typeof value === "string"
        ? value
        : finite(value, `${name} string.${key}`);
  }
  return Object.freeze(out);
}

function synthInput(input: unknown, name: string): SynthInput | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input))
    throw new DawgSdkError(`track ${name}: synth must be an object`);
  const out: Record<string, EffectValue | readonly number[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value)
      ? Object.freeze(
          value.map((n, index) => finite(n, `${name} synth.${key}[${index}]`)),
        )
      : effectValue(value, `${name} synth.${key}`);
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
}

function fxLanes(
  input: unknown,
  name: string,
): Readonly<Record<string, readonly Point[]>> {
  if (input === undefined) return Object.freeze({});
  if (!isRecord(input))
    throw new DawgSdkError(`track ${name}: automation.fx must be an object`);
  const out: Record<string, readonly Point[]> = {};
  for (const [key, points] of Object.entries(input)) {
    if (!Array.isArray(points) || points.length > 256)
      throw new DawgSdkError(
        `track ${name}: automation.fx["${key}"] must be an array of at most 256 [beat, value] points`,
      );
    out[key] = Object.freeze(
      points.map((point: unknown, index: number): Point => {
        if (!Array.isArray(point) || point.length !== 2)
          throw new DawgSdkError(
            `track ${name}: automation.fx["${key}"][${index}] must be [beat, value]`,
          );
        return Object.freeze([
          beat(point[0], `automation.fx["${key}"][${index}] beat`),
          finite(point[1], `automation.fx["${key}"][${index}] value`),
        ] as const);
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Directory name for a track: lowercase, spaces and runs of punctuation
 * become one `-` (`"Keys 2"` → `keys-2`); empty input becomes `track`.
 * Same rule as dawg's `trackSlug`, copied so this file stays standalone.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "track";
}

/** Pitch slot for each one-shot voice, in voice-name order from 36. */
export function voiceSlots(spec: SamplerSpec): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  if (spec.mode !== "oneshot") return slots;
  Object.keys(spec.voices)
    .sort()
    .forEach((voice, index) => slots.set(voice, SAMPLER_FIRST_SLOT + index));
  return slots;
}

/** `reverb.ir`: built-in names stay bare; files become project-relative. */
function reverbIr(
  value: unknown,
  name: string,
  slug: string,
):
  | string
  | Readonly<{ src: string; sha256?: string; url?: string; license?: string }> {
  const spec = typeof value === "string" ? { src: value } : value;
  if (!isRecord(spec) || typeof spec.src !== "string" || spec.src.length === 0)
    throw new DawgSdkError(`track ${name}: reverb.ir needs a src`);
  const src = spec.src.trim().replace(/^\.\//, "");
  if (src.startsWith("pack:")) {
    const ref = sampleSpec(spec as SampleSpec, `${name} reverb.ir`);
    return Object.freeze({
      src: ref.src,
      ...(ref.sha256 ? { sha256: ref.sha256 } : {}),
      ...(ref.url ? { url: ref.url } : {}),
      ...(ref.license ? { license: ref.license } : {}),
    });
  }
  if (src.startsWith("builtin:") || !/[./]/.test(src)) return src;
  return src.startsWith("tracks/") ? src : `tracks/${slug}/${src}`;
}

/** Validates `granular` input and localizes a sample source like a voice. */
function granularInput(
  input: unknown,
  name: string,
  slug: string,
): GranularInput | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input))
    throw new DawgSdkError(`track ${name}: granular must be an object`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || key === "kind") continue;
    if (key === "src" && isRecord(value)) {
      const ref = sampleSpec(value as SampleSpec, `${name} granular src`);
      const src = ref.src.replace(/^\.\//, "");
      out.src = Object.freeze({
        ...ref,
        src:
          src.startsWith("tracks/") || src.startsWith("pack:")
            ? src
            : `tracks/${slug}/${src}`,
      });
    } else if (key === "src" && typeof value === "string")
      out.src = value.startsWith("synth:")
        ? value
        : granularInput({ src: { src: value } }, name, slug)!.src;
    else if (typeof value === "number")
      out[key] = finite(value, `${name} granular.${key}`);
    else if (typeof value === "string" || typeof value === "boolean")
      out[key] = value;
    else throw new DawgSdkError(`${name} granular.${key} must be a value`);
  }
  return Object.freeze(out) as GranularInput;
}

/** `./wavetables/x.wav` → `tracks/<slug>/wavetables/x.wav`, like sampler files. */
function localizeWavetable(spec: WavetableSpec, slug: string): WavetableSpec {
  const src = spec.table.src;
  if (!/\.wav$/i.test(src) || src.startsWith("pack:")) return spec;
  const bare = src.replace(/^\.\//, "");
  return Object.freeze({
    ...spec,
    table: Object.freeze({
      ...spec.table,
      src: bare.startsWith("tracks/") ? bare : `tracks/${slug}/${bare}`,
    }),
  });
}

function localizeSampler(spec: SamplerSpec, slug: string): SamplerSpec {
  const voices: Record<string, SampleSpec> = {};
  for (const [name, voice] of Object.entries(spec.voices)) {
    const src = voice.src.replace(/^\.\//, "");
    voices[name] = Object.freeze({
      ...voice,
      src:
        src.startsWith("tracks/") || src.startsWith("pack:")
          ? src
          : `tracks/${slug}/${src}`,
    });
  }
  return Object.freeze({ ...spec, voices: Object.freeze(voices) });
}

// ---------------------------------------------------------------------------
// Song

/** Input to `song()`. */
export type SongInput = Readonly<{
  /** BPM 20..300, default 120. */
  tempo?: number;
  /**
   * `[beatsPerBar, noteValue]` or just `beatsPerBar`; default `[4, 4]`.
   * A note value other than 4 is stored as a meter change at bar 1, so
   * `[6, 8]` is six eighths (three quarter-note beats) per bar.
   */
  meter?: readonly [number, number] | number;
  /** Loop length in bars, 1..256, default 4. */
  bars?: number;
  /**
   * Free text such as `"A minor"`, or null. A scale name after the tonic
   * picks a scale: `"D dorian"`, `"E hijaz"`, `"C yaman"`, `"C messiaen-3"`.
   */
  key?: string | null;
  /**
   * Song tuning (SDK 1.16.0), default 12-TET at A4 = 440 Hz: a library name
   * (`"19-edo"`, `"just"`, `"pelog"`, `"yaman"`) or `{ edo, ratios, cents,
   * scl, kbm, ref, root, map }`. See `TuningInput`.
   */
  tuning?: TuningInput | null;
  /** Integer ticks per beat, default 480. Leave it alone unless you know why. */
  ticksPerBeat?: number;
  /**
   * Tempo changes, meter changes and fermatas (SDK 1.14.0), in any order:
   * `tempo()`, `ramp()`, `rit()`, `accel()`, `fermata()` and `meter()`.
   * `tempo` above stays the opening tempo and `meter` the opening meter.
   * `rit()` and `accel()` return two marks; list them as they come.
   */
  time?: readonly (TimeMark | readonly TimeMark[])[];
  /** Tracks in score order; each from `track()`. */
  tracks: readonly TrackSpec[];
  /** Master chain and loudness target after every track and orbit bus (SDK 1.17.0); omit for none. */
  master?: MasterInput;
  /**
   * Which style and seed made the song (SDK 1.33.0), from `style()`:
   * `style: style("deep-house", { seed: 3, bars: 8 })`. A record only: the
   * notes are the tracks above; `/style` in dawg generates them.
   */
  style?: StyleSpec;
  /**
   * Named bar ranges (SDK 1.18.0): `{ name: "chorus", startBar: 8, bars: 8 }`,
   * optionally with `mute: ["pad"]` and `vary: { lead: { transpose: 12 } }`.
   */
  sections?: readonly SongSection[];
  /**
   * The order sections play, with repeats (SDK 1.18.0): `"intro verse
   * chorus*2 outro"`, or `["intro", { section: "chorus", repeat: 2 }]`.
   * Absent plays the bars straight through.
   */
  form?: string | readonly (string | SongFormEntry)[];
  /** The section playback loops (SDK 1.18.0); `loop: "chorus"` says the same. */
  loopSection?: string;
  /**
   * What playback loops (SDK 1.34.0): bars `"5-6"` (1-based, as the prompt
   * shows them) or a section `"chorus"`. Export ignores it.
   */
  loop?: string;
  /**
   * Sound calibration (SDK 1.32.0): `1` renders the 0.7 level, pitch and
   * drum-kit fixes (hat choke, tuned toms, crash and ride, level keys,
   * steady brass). Omit it to keep an older song's sound byte-identical;
   * `dawg init` writes the latest.
   */
  calibration?: number;
  /**
   * The project patch library (SDK 1.35.0): patches tracks play by name
   * with `patch({ ref: "acid-bass", macros: { cutoff: 900 } })`.
   */
  patches?: readonly PatchSpec[];
}>;

/** A song section (SDK 1.18.0); bars are 0-based like beats. */
export type SongSection = Readonly<{
  /** `intro`, `verse`, `chorus 2`, `A`: 1..32 characters, unique ignoring case. */
  name: string;
  /** First bar, 0-based. */
  startBar: number;
  /** Length in bars, at least 1. */
  bars: number;
  /** Track ids silent in this section. */
  mute?: readonly string[];
  /** Per-track changes in this section: semitones and a velocity multiplier. */
  vary?: Readonly<
    Record<string, Readonly<{ transpose?: number; gain?: number }>>
  >;
}>;

/** One step of the song form (SDK 1.18.0). */
export type SongFormEntry = Readonly<{ section: string; repeat?: number }>;

/**
 * The song master (SDK 1.17.0), processed in the fixed order
 * eq → glue → tape → width → limiter after the tracks and orbit buses are
 * summed. Each unit present is on; `{}` takes every default. `target` is
 * an integrated loudness in LUFS (ITU-R BS.1770-4), -40..-3: renders drive
 * the limiter (or, without one, a clean gain) to reach it. Streaming is
 * -14, club -8, loud hyperpop or gabber -6, classical -20, broadcast -23.
 * The SDK takes LUFS numbers only: a target name such as `master target
 * club` in the prompt also sets a limiter preset, so write that unit out.
 * DAWG.md "Master and loudness" lists every parameter with its range.
 *
 * ```ts
 * master: { glue: { ratio: 2 }, limiter: { ceiling: -1 }, target: -14 }
 * ```
 */
export type MasterInput = Readonly<{
  /** `low`/`high` shelves and `bell1`/`bell2` gains in dB, with `…freq` and `…q`. */
  eq?: EffectParams;
  /** Bus compressor: threshold, ratio, attack, release (ms), knee, makeup, mix, hpf. */
  glue?: EffectParams;
  /** Saturation: drive (dB), bias, tone (Hz), mix. */
  tape?: EffectParams;
  /** Stereo width 0..2 (1 unchanged) and `mono` bass below this many Hz. */
  width?: EffectParams;
  /** True-peak limiter: ceiling (dBTP), gain, release, lookahead (ms), truepeak. */
  limiter?: EffectParams;
  /** Integrated loudness target in LUFS (a negative number, -40..-3). */
  target?: number;
}>;

/** A stored note: integer ticks; expression fields only when set. */
export type ScoreNote = Readonly<{
  id: string;
  trackId: string;
  startTick: number;
  durationTicks: number;
  pitch: number;
  velocity: number;
  articulation?: Articulation;
  glide?: number;
  bend?: readonly Readonly<{ at: number; cents: number }>[];
  vibrato?: Readonly<{ rate: number; depth: number; delay?: number }>;
  humanize?: Readonly<{ timing?: number; velocity?: number; length?: number }>;
  /** Autotune guide drift share (SDK 1.32.0). */
  drift?: number;
  /** Static cents offset (SDK 1.16.0); absent is 0. */
  cents?: number;
  /** Sung vowel (SDK 1.32.0); absent sings the lyric's or the track's. */
  vowel?: string;
}>;

/** A stored automation point: integer tick. */
export type ScorePoint = Readonly<{ tick: number; value: number }>;

/** A stored sample reference (project-relative `src`, MIDI `root`). */
export type ScoreSampleRef = Readonly<{
  src: string;
  sha256?: string;
  url?: string;
  license?: string;
  root?: number;
  begin?: number;
  end?: number;
  gain?: number;
  speed?: number;
  loop?: boolean;
  choke?: string;
  loopBegin?: number;
  loopEnd?: number;
  clip?: number;
  unit?: "r" | "c" | "s";
  fit?: boolean;
  accelerate?: number;
  squiz?: number;
  bpm?: number;
  fitmode?: "repitch" | "beats" | "tones";
  len?: number;
  shift?: number;
  formant?: number;
  fadeTime?: number;
  fadeInTime?: number;
  from?: SampleProvenanceSpec;
}>;

/** A stored track; optional fields are present only when set. */
export type ScoreTrack = Readonly<{
  id: string;
  name: string;
  instrument: string;
  muted: boolean;
  volume: number;
  pan: number;
  volumeAutomation: readonly ScorePoint[];
  panAutomation: readonly ScorePoint[];
  solo?: boolean;
  filter?: TrackSpec["filter"] & object;
  delay?: TrackSpec["delay"] & object;
  filterAutomation?: readonly ScorePoint[];
  resonanceAutomation?: readonly ScorePoint[];
  delayFeedbackAutomation?: readonly ScorePoint[];
  delayMixAutomation?: readonly ScorePoint[];
  reverb?: TrackSpec["reverb"] & object;
  fx?: FxInput;
  fxAutomation?: Readonly<Record<string, readonly ScorePoint[]>>;
  synth?: SynthInput;
  keys?: KeysInput;
  sampler?: Readonly<{
    voices: Readonly<Record<string, ScoreSampleRef>>;
    mode: "oneshot" | "keyed";
  }>;
  /** Rhythm rows without `kind`; dawg validates and expands them. */
  rhythm?: readonly Readonly<Record<string, unknown>>[];
  /** Synth kit name; dawg validates it. */
  kit?: string;
  /** `rate`, plus `phase` and `cycle` in ticks. */
  time?: Readonly<{
    rate?: number;
    phase?: number;
    cycle?: number;
    steps?: Readonly<{ shift: number; hold: number; drift: number }>;
  }>;
  /** Track tuning; dawg validates it (SDK 1.16.0). */
  tuning?: ScoreTuning;
  wavetable?: Readonly<{ table: ScoreSampleRef } & WavetableParams>;
  wtAutomation?: readonly ScorePoint[];
  /** String engine settings; dawg validates them (SDK 1.21.0). */
  string?: StringInput;
  /** Granular settings (SDK 1.23.0); present only when set. */
  granular?: GranularInput;
  /** Modal settings (SDK 1.25.0). */
  modal?: TrackSpec["modal"];
  /** Guitar fretting (SDK 1.27.0). */
  guitar?: GuitarSetup;
  /** Wind settings (SDK 1.30.0). */
  wind?: TrackSpec["wind"];
  /** Sing settings (SDK 1.32.0). */
  sing?: TrackSpec["sing"];
  /** Vocoder settings (SDK 1.32.0); `src` is a track id. */
  vocoder?: TrackSpec["vocoder"];
  /** Pitch correction (SDK 1.32.0). */
  autotune?: AutotuneSettings;
  glide?: TrackSpec["glide"];
  pedal?: readonly Readonly<{ tick: number; state: PedalState }>[];
  softPedal?: readonly Readonly<{ tick: number; state: PedalState }>[];
  sostenuto?: readonly Readonly<{ tick: number; state: PedalState }>[];
  velocityCurve?: TrackSpec["velocityCurve"];
  humanize?: TrackSpec["humanize"];
}>;

/**
 * What `song()` returns and `song.ts` default-exports: a `track.loop/v1`
 * document in integer ticks, ready for dawg to validate and diff against
 * the session.
 */
export type Song = Readonly<{
  format: "track.loop/v1";
  version: 1;
  tempoBpm: number;
  beatsPerBar: number;
  bars: number;
  ticksPerBeat: number;
  key: string | null;
  /** Present only when `song({ time })` has marks. */
  time?: ScoreTime;
  /** Present only when the song sets one (SDK 1.16.0). */
  tuning?: ScoreTuning;
  tracks: readonly ScoreTrack[];
  notes: readonly ScoreNote[];
  master?: MasterInput;
  /** Present only when the song names a style (SDK 1.33.0). */
  style?: StyleSpec;
  /** Present only when the song has sections (SDK 1.18.0). */
  sections?: readonly SongSection[];
  /** Present only when the song has a form (SDK 1.18.0). */
  form?: readonly SongFormEntry[];
  /** Present only when a section loops (SDK 1.18.0). */
  loopSection?: string;
  /** Present only when bars loop (SDK 1.34.0): 0-based `startBar`. */
  loop?: Readonly<{ startBar: number; bars: number }>;
  /** Present only when the song sets one (SDK 1.32.0). */
  calibration?: number;
  /** Present only when the song has a patch library (SDK 1.35.0), by name. */
  patches?: Readonly<Record<string, PatchSpec>>;
}>;

/** A song's style provenance (SDK 1.33.0); see `style()`. */
export type StyleSpec = Readonly<{
  id: string;
  seed: number;
  bars: number;
  blend?: Readonly<{ id: string; weight: number }>;
}>;

export type StyleOptions = Readonly<{
  /** Generator seed, integer 0..2147483647, default 1. */
  seed?: number;
  /** Bars generated, 1..256, default 8. */
  bars?: number;
  /** Blend partner and its weight 0..1: `blend: ["bebop", 0.3]`. */
  blend?: readonly [string, number];
}>;

const STYLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Which style and seed made a song (SDK 1.33.0), for `song({ style })`:
 *
 * ```ts
 * style("deep-house", { seed: 3, bars: 8 })
 * style("bebop", { seed: 7, blend: ["bossa-nova", 0.3] })
 * ```
 *
 * The id is a taxonomy id (`dawg` lists them with `/style list`). It is a
 * record of where the song came from; the notes live in the tracks.
 */
export function style(id: string, options: StyleOptions = {}): StyleSpec {
  if (typeof id !== "string" || !STYLE_ID_PATTERN.test(id))
    throw new DawgSdkError(
      `style id must be lowercase words joined by hyphens, like "deep-house"; got ${JSON.stringify(id)}`,
    );
  if (!isRecord(options))
    throw new DawgSdkError("style options must be an object");
  const seed = options.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647)
    throw new DawgSdkError("style seed must be an integer 0..2147483647");
  const bars = options.bars ?? 8;
  if (!Number.isInteger(bars) || bars < 1 || bars > 256)
    throw new DawgSdkError("style bars must be an integer 1..256");
  let blend: StyleSpec["blend"];
  if (options.blend !== undefined) {
    const pair = options.blend;
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      !STYLE_ID_PATTERN.test(pair[0]) ||
      typeof pair[1] !== "number" ||
      !(pair[1] >= 0 && pair[1] <= 1)
    )
      throw new DawgSdkError(
        'style blend must be ["style-id", weight 0..1], like ["bebop", 0.3]',
      );
    blend = Object.freeze({ id: pair[0], weight: pair[1] });
  }
  return Object.freeze({ id, seed, bars, ...(blend ? { blend } : {}) });
}

/** A stored song `time`: ticks, and 0-based bar indexes. */
export type ScoreTime = Readonly<{
  tempo?: readonly Readonly<{
    tick: number;
    bpm: number;
    ramp?: "linear" | "exp";
  }>[];
  meter?: readonly Readonly<{
    bar: number;
    beatsPerBar: number;
    beatUnit?: number;
  }>[];
  fermatas?: readonly Readonly<{ tick: number; beats: number }>[];
}>;

/** `song({ style })`: the `style()` record, re-checked for hand-written objects. */
function songStyle(input: unknown): { style?: StyleSpec } {
  if (input === undefined || input === null) return {};
  if (!isRecord(input))
    throw new DawgSdkError('song style must come from style("id", { seed })');
  const blend = input.blend;
  const spec = style(input.id as string, {
    seed: input.seed as number,
    bars: input.bars as number,
    ...(blend !== undefined && blend !== null
      ? isRecord(blend)
        ? { blend: [blend.id, blend.weight] as unknown as [string, number] }
        : { blend: blend as [string, number] }
      : {}),
  });
  return { style: spec };
}

const MASTER_KEYS = ["eq", "glue", "tape", "width", "limiter", "target"];

/** Shape checks only; dawg validates every value when it loads the song. */
function masterData(input: unknown): MasterInput | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input)) throw new DawgSdkError("song master must be an object");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!MASTER_KEYS.includes(key))
      throw new DawgSdkError(
        `song master has no "${key}"; use ${MASTER_KEYS.join(", ")}`,
      );
    if (key === "target") {
      if (typeof value === "string")
        throw new DawgSdkError(
          `song master target takes LUFS, e.g. target: -14 (streaming), -8 (club, with limiter: { release: 60, lookahead: 2 }), -6 (loud, with limiter: { release: 20, lookahead: 1 }); got "${value}"`,
        );
      out.target = finite(value as number, "song master target");
      continue;
    }
    if (!isRecord(value))
      throw new DawgSdkError(`song master ${key} must be an object`);
    out[key] = Object.freeze({ ...value });
  }
  return Object.keys(out).length > 0
    ? (Object.freeze(out) as MasterInput)
    : undefined;
}

/** `"intro verse chorus*2"` (comma separated when a name has a space). */
function parseSongForm(
  form: NonNullable<SongInput["form"]>,
): readonly SongFormEntry[] {
  const items: (string | SongFormEntry)[] =
    typeof form === "string"
      ? (form.includes(",") ? form.split(",") : form.trim().split(/\s+/u))
          .map((item) => item.trim())
          .filter((item) => item !== "")
      : Array.isArray(form)
        ? [...form]
        : (() => {
            throw new DawgSdkError(
              "song form must be a string or an array of section names",
            );
          })();
  return Object.freeze(
    items.map((item, index) => {
      let entry: unknown = item;
      if (typeof item === "string") {
        const match = /^(.*?)\s*(?:\*|\bx|×)\s*(\d+)$/iu.exec(item);
        entry =
          match && match[1]!.length > 0
            ? { section: match[1]!, repeat: Number(match[2]) }
            : { section: item };
      }
      if (!isRecord(entry) || typeof entry.section !== "string")
        throw new DawgSdkError(
          `song form[${index}] must be a section name or { section, repeat }`,
        );
      const repeat = entry.repeat ?? 1;
      if (
        !Number.isInteger(repeat) ||
        (repeat as number) < 1 ||
        (repeat as number) > 16
      )
        throw new DawgSdkError(`song form[${index}] repeat must be 1..16`);
      return Object.freeze(
        repeat === 1
          ? { section: entry.section }
          : { section: entry.section, repeat: repeat as number },
      );
    }),
  );
}

function songSections(
  sections: NonNullable<SongInput["sections"]>,
): readonly SongSection[] {
  if (!Array.isArray(sections))
    throw new DawgSdkError("song sections must be an array");
  if (sections.length > 64) throw new DawgSdkError("song has over 64 sections");
  return Object.freeze(
    sections.map((section, index) => {
      const where = `song sections[${index}]`;
      if (!isRecord(section) || typeof section.name !== "string")
        throw new DawgSdkError(`${where} needs a name`);
      const stored: Record<string, unknown> = {
        name: section.name,
        startBar: finite(section.startBar, `${where}.startBar`),
        bars: finite(section.bars, `${where}.bars`),
      };
      if (section.mute !== undefined) {
        if (
          !Array.isArray(section.mute) ||
          section.mute.some((id) => typeof id !== "string")
        )
          throw new DawgSdkError(`${where}.mute must be track ids`);
        if (section.mute.length > 0)
          stored.mute = Object.freeze([...section.mute]);
      }
      if (section.vary !== undefined) {
        if (!isRecord(section.vary))
          throw new DawgSdkError(`${where}.vary must be an object`);
        const vary = Object.entries(section.vary);
        if (vary.length > 0)
          stored.vary = Object.freeze(
            Object.fromEntries(
              vary.map(([id, change]) => {
                if (!isRecord(change))
                  throw new DawgSdkError(
                    `${where}.vary.${id} must be an object`,
                  );
                const out: Record<string, number> = {};
                if (change.transpose !== undefined)
                  out.transpose = finite(
                    change.transpose,
                    `${where}.vary.${id}.transpose`,
                  );
                if (change.gain !== undefined)
                  out.gain = finite(change.gain, `${where}.vary.${id}.gain`);
                return [id, Object.freeze(out)];
              }),
            ),
          );
      }
      return Object.freeze(stored) as SongSection;
    }),
  );
}

/**
 * Assemble the song. Beats become ticks (`Math.round(beat * ticksPerBeat)`,
 * lengths at least one tick), and every note gets a deterministic id from
 * its track and content, so two evaluations of the same files agree.
 */
/** The newest `song({ calibration })` (mirrors core CALIBRATION_LATEST). */
export const SONG_CALIBRATION_LATEST = 1;

/** `song({ loop })`: bars `"5-6"` → a 0-based range, else a section name. */
function songLoop(
  input: unknown,
  bars: number,
): string | Readonly<{ startBar: number; bars: number }> {
  if (typeof input !== "string" || input.trim() === "")
    throw new DawgSdkError('song loop must be bars "5-6" or a section name');
  const match = /^\s*(\d{1,4})\s*(?:-|–|\.\.)?\s*(\d{1,4})?\s*$/u.exec(input);
  if (!match) return input.trim();
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to < from)
    throw new DawgSdkError(`song loop "${input}" runs low-high from bar 1`);
  if (to > bars)
    throw new DawgSdkError(
      `song loop "${input}" is past the song's ${bars} bars`,
    );
  return Object.freeze({ startBar: from - 1, bars: to - from + 1 });
}

// ---------------------------------------------------------------------------
// Range helpers (SDK 1.34.0): the prompt's copy, move and bars insert as
// pure functions over notes, for files written by hand. Bars are 1-based.

type Timed = Readonly<{ start: number; length: number }>;
type RangeHelperOptions = Readonly<{ beatsPerBar?: number }>;

function perBar(options: RangeHelperOptions | undefined, what: string): number {
  return positive(options?.beatsPerBar ?? 4, `${what} beatsPerBar`);
}

function wholeBar(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new DawgSdkError(`${what} must be a bar from 1`);
  return value;
}

/**
 * The notes (or hits) that start in bars `from..to`, re-based to beat 0
 * and cut at the range's end: `bars(chorus, 5, 6)`.
 */
export function bars<T extends Timed>(
  notes: readonly T[],
  from: number,
  to: number = from,
  options?: RangeHelperOptions,
): readonly T[] {
  if (!Array.isArray(notes))
    throw new DawgSdkError("bars needs an array of notes");
  const each = perBar(options, "bars");
  const first = wholeBar(from, "bars from");
  const last = wholeBar(to, "bars to");
  if (last < first)
    throw new DawgSdkError("bars runs low-high: bars(notes, 5, 6)");
  const start = (first - 1) * each;
  const end = last * each;
  return Object.freeze(
    notes
      .filter((item) => item.start >= start && item.start < end)
      .map((item) =>
        Object.freeze({
          ...item,
          start: item.start - start,
          length: Math.min(item.length, end - item.start),
        }),
      ),
  );
}

/**
 * Notes laid down at bar `at`, repeated `times` times end to end:
 * `place(bars(bass, 5, 6), { at: 7, times: 2 })`. Each repeat spans
 * `bars` bars (default: the whole bars the notes reach).
 */
export function place<T extends Timed>(
  notes: readonly T[],
  options: Readonly<{ at: number; times?: number; bars?: number }> &
    RangeHelperOptions,
): readonly T[] {
  if (!Array.isArray(notes))
    throw new DawgSdkError("place needs an array of notes");
  if (!isRecord(options)) throw new DawgSdkError("place needs { at: <bar> }");
  const each = perBar(options, "place");
  const at = (wholeBar(options.at, "place at") - 1) * each;
  const times = options.times ?? 1;
  if (!Number.isInteger(times) || times < 1 || times > 64)
    throw new DawgSdkError("place times must be 1..64");
  const reach = notes.reduce(
    (most, item) => Math.max(most, item.start + item.length),
    0,
  );
  const span =
    (options.bars === undefined
      ? Math.max(1, Math.ceil(reach / each - 1e-9))
      : wholeBar(options.bars, "place bars")) * each;
  const out: T[] = [];
  for (let pass = 0; pass < times; pass += 1)
    for (const item of notes)
      out.push(
        Object.freeze({ ...item, start: at + pass * span + item.start }),
      );
  return Object.freeze(out);
}

/**
 * The notes mirrored in time over `bars` bars from beat 0 (a note ending
 * at the span's end starts at 0): `reversed(bars(lead, 5, 6), { bars: 2 })`.
 */
export function reversed<T extends Timed>(
  notes: readonly T[],
  options: Readonly<{ bars: number }> & RangeHelperOptions,
): readonly T[] {
  if (!Array.isArray(notes))
    throw new DawgSdkError("reversed needs an array of notes");
  if (!isRecord(options))
    throw new DawgSdkError("reversed needs { bars: <n> }");
  const span =
    wholeBar(options.bars, "reversed bars") * perBar(options, "reversed");
  return Object.freeze(
    notes
      .filter((item) => item.start < span)
      .map((item) => {
        const length = Math.min(item.length, span - item.start);
        return Object.freeze({
          ...item,
          start: span - item.start - length,
          length,
        });
      })
      .sort((a, b) => a.start - b.start),
  );
}

/** Shift every `tick` field at or past `at` in an array of points. */
function shiftTicks(value: unknown, at: number, shift: number): unknown {
  if (!Array.isArray(value)) return value;
  if (!value.every((item) => isRecord(item) && typeof item.tick === "number"))
    return value;
  return Object.freeze(
    value.map((item) =>
      (item as { tick: number }).tick >= at
        ? Object.freeze({
            ...(item as object),
            tick: (item as { tick: number }).tick + shift,
          })
        : item,
    ),
  );
}

/**
 * `bars` empty bars inserted before bar `at` of a `song()` result: later
 * notes, sections, the loop, tempo marks, fermatas, automation points and
 * clips move right; a note held across `at` sounds on through the gap.
 * `export default insertBars(song({...}), { at: 7, bars: 2 })`.
 */
export function insertBars(
  input: Song,
  options: Readonly<{ at: number; bars: number }>,
): Song {
  if (!isRecord(input) || input.format !== "track.loop/v1")
    throw new DawgSdkError("insertBars needs a song() result");
  if (!isRecord(options))
    throw new DawgSdkError("insertBars needs { at, bars }");
  const atBar = wholeBar(options.at, "insertBars at") - 1;
  const count = wholeBar(options.bars, "insertBars bars");
  if (atBar > input.bars)
    throw new DawgSdkError(
      `insertBars at ${atBar + 1} is past the song's ${input.bars} bars`,
    );
  if (input.bars + count > 256)
    throw new DawgSdkError("a song has at most 256 bars");
  if (input.time?.meter?.some((mark) => mark.bar > 0))
    throw new DawgSdkError(
      "insertBars needs one meter · use dawg's bars insert",
    );
  const barTicks = input.beatsPerBar * input.ticksPerBeat;
  const at = atBar * barTicks;
  const shift = count * barTicks;
  const atBeat = atBar * input.beatsPerBar;
  const beats = count * input.beatsPerBar;
  const moveRange = <R extends { startBar: number; bars: number }>(
    range: R,
  ): R =>
    range.startBar >= atBar
      ? { ...range, startBar: range.startBar + count }
      : range.startBar + range.bars > atBar
        ? { ...range, bars: range.bars + count }
        : range;
  const tracks = input.tracks.map((track) => {
    const out: Record<string, unknown> = { ...track };
    for (const [field, value] of Object.entries(track)) {
      if (field === "fxAutomation" && isRecord(value)) {
        out[field] = Object.freeze(
          Object.fromEntries(
            Object.entries(value).map(([lane, points]) => [
              lane,
              shiftTicks(points, at, shift),
            ]),
          ),
        );
      } else if (field === "clips" && Array.isArray(value)) {
        out[field] = Object.freeze(
          value.map((clip) =>
            isRecord(clip) && typeof clip.at === "number" && clip.at >= atBeat
              ? Object.freeze({ ...clip, at: clip.at + beats })
              : clip,
          ),
        );
      } else out[field] = shiftTicks(value, at, shift);
    }
    return Object.freeze(out) as ScoreTrack;
  });
  const time = input.time
    ? Object.freeze({
        ...input.time,
        ...(input.time.tempo
          ? {
              tempo: shiftTicks(
                input.time.tempo,
                at,
                shift,
              ) as ScoreTime["tempo"],
            }
          : {}),
        ...(input.time.fermatas
          ? {
              fermatas: shiftTicks(
                input.time.fermatas,
                at,
                shift,
              ) as ScoreTime["fermatas"],
            }
          : {}),
      })
    : undefined;
  return Object.freeze({
    ...input,
    bars: input.bars + count,
    ...(time ? { time } : {}),
    tracks: Object.freeze(tracks),
    notes: Object.freeze(
      input.notes.map((item) =>
        item.startTick >= at
          ? Object.freeze({ ...item, startTick: item.startTick + shift })
          : item.startTick + item.durationTicks > at
            ? Object.freeze({
                ...item,
                durationTicks: item.durationTicks + shift,
              })
            : item,
      ),
    ),
    ...(input.sections
      ? {
          sections: Object.freeze(
            input.sections.map((section) => Object.freeze(moveRange(section))),
          ),
        }
      : {}),
    ...(input.loop ? { loop: Object.freeze(moveRange(input.loop)) } : {}),
  });
}

export function song(input: SongInput): Song {
  if (!isRecord(input)) throw new DawgSdkError("song() needs an object");
  const tempoBpm = finite(input.tempo ?? 120, "song tempo");
  const meter = input.meter ?? 4;
  const beatsPerBar = Array.isArray(meter)
    ? finite(meter[0], "song meter[0]")
    : finite(meter as number, "song meter");
  const beatUnit = Array.isArray(meter) ? finite(meter[1], "song meter[1]") : 4;
  if (![1, 2, 4, 8, 16, 32].includes(beatUnit))
    throw new DawgSdkError(
      "song meter note value must be 1, 2, 4, 8, 16 or 32",
    );
  const bars = finite(input.bars ?? 4, "song bars");
  const ticksPerBeat = input.ticksPerBeat ?? DEFAULT_TICKS_PER_BEAT;
  if (
    !Number.isInteger(ticksPerBeat) ||
    ticksPerBeat < 1 ||
    ticksPerBeat > 4096
  )
    throw new DawgSdkError("song ticksPerBeat must be an integer 1..4096");
  const key = input.key ?? null;
  if (key !== null && typeof key !== "string")
    throw new DawgSdkError("song key must be a string or null");
  const songTuning = tuningSpec(input.tuning, "song");
  const master = masterData(input.master);
  const calibration = input.calibration ?? 0;
  if (
    typeof calibration !== "number" ||
    !Number.isInteger(calibration) ||
    calibration < 0 ||
    calibration > SONG_CALIBRATION_LATEST
  )
    throw new DawgSdkError(
      `song calibration must be an integer 0..${SONG_CALIBRATION_LATEST}`,
    );
  if (!Array.isArray(input.tracks))
    throw new DawgSdkError("song tracks must be an array of track()");
  if (input.tracks.length > 64)
    throw new DawgSdkError("song has over 64 tracks");
  const ticks = (beats: number) => Math.round(beats * ticksPerBeat);
  const points = (lane: readonly Point[]): readonly ScorePoint[] =>
    Object.freeze(
      lane.map(([at, value]) => Object.freeze({ tick: ticks(at), value })),
    );
  const seen = new Set<string>();
  const tracks: ScoreTrack[] = [];
  const notes: ScoreNote[] = [];
  const library = songPatches(input.patches);
  const ticksPerBar = Math.round(beatsPerBar * ticksPerBeat);
  input.tracks.forEach((spec, index) => {
    if (!isRecord(spec) || spec.kind !== "track")
      throw new DawgSdkError(`song tracks[${index}] must come from track()`);
    const t = spec as TrackSpec;
    if (seen.has(t.id))
      throw new DawgSdkError(`song has two tracks with id "${t.id}"`);
    seen.add(t.id);
    const filterAutomation = points(t.automation.filter);
    const resonanceAutomation = points(t.automation.resonance);
    const delayFeedbackAutomation = points(t.automation.delayFeedback);
    const delayMixAutomation = points(t.automation.delayMix);
    const wtAutomation = points(t.automation.wt ?? []);
    const stored: Record<string, unknown> = {
      id: t.id,
      name: t.name,
      instrument: t.instrument,
      muted: t.muted,
      volume: t.volume,
      pan: t.pan,
      volumeAutomation: points(t.automation.volume),
      panAutomation: points(t.automation.pan),
    };
    if (t.solo) stored.solo = true;
    if (t.filter) stored.filter = t.filter;
    if (t.delay) stored.delay = t.delay;
    if (filterAutomation.length > 0) stored.filterAutomation = filterAutomation;
    if (resonanceAutomation.length > 0)
      stored.resonanceAutomation = resonanceAutomation;
    if (delayFeedbackAutomation.length > 0)
      stored.delayFeedbackAutomation = delayFeedbackAutomation;
    if (delayMixAutomation.length > 0)
      stored.delayMixAutomation = delayMixAutomation;
    if (t.reverb) stored.reverb = t.reverb;
    if (t.fx) stored.fx = t.fx;
    if (t.synth) stored.synth = t.synth;
    if (t.patch) stored.patch = t.patch;
    if (t.fxPatch) stored.fxPatch = t.fxPatch;
    // Signals bake into lanes; a lane written under automation.fx wins.
    const written = Object.entries(t.automation.fx ?? {})
      .map(([key, lane]) => [key, points(lane)] as const)
      .filter(([, lane]) => lane.length > 0);
    const baked = Object.entries(
      bakeTrackSignals(t, library, { bars, ticksPerBar }),
    ).filter(([key]) => !written.some(([lane]) => lane === key));
    const fxLaneEntries = [...written, ...baked];
    if (fxLaneEntries.length > 0)
      stored.fxAutomation = Object.freeze(Object.fromEntries(fxLaneEntries));
    if (t.wavetable) {
      const { kind: _kind, ...fields } = t.wavetable;
      stored.wavetable = Object.freeze(fields);
    }
    if (wtAutomation.length > 0) stored.wtAutomation = wtAutomation;
    if (t.granular) stored.granular = t.granular;
    if (t.sampler)
      stored.sampler = Object.freeze({
        voices: t.sampler.voices,
        mode: t.sampler.mode,
      });
    if (t.kit) stored.kit = t.kit;
    if (t.time) {
      const time: Record<string, unknown> = {};
      if (t.time.rate !== undefined) time.rate = t.time.rate;
      if (t.time.phase !== undefined) {
        const phase = ticks(t.time.phase);
        if (phase !== 0) time.phase = phase;
      }
      if (t.time.cycle !== undefined)
        time.cycle = Math.max(1, ticks(t.time.cycle));
      if (t.time.steps)
        time.steps = Object.freeze({
          ...t.time.steps,
          shift: Math.max(1, ticks(t.time.steps.shift)),
        });
      if (Object.keys(time).length > 0) stored.time = Object.freeze(time);
    }
    if (t.glide) stored.glide = t.glide;
    for (const key of ["pedal", "softPedal", "sostenuto"] as const) {
      const lane = t[key];
      if (!lane || lane.length === 0) continue;
      // One event per tick (the last wins), in tick order, as dawg stores it.
      const byTick = new Map<number, PedalState>();
      for (const [at, state] of lane) byTick.set(ticks(at), state);
      stored[key] = Object.freeze(
        [...byTick.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([tick, state]) => Object.freeze({ tick, state })),
      );
    }
    if (t.velocityCurve) stored.velocityCurve = t.velocityCurve;
    if (t.humanize) stored.humanize = t.humanize;
    if (t.tuning) stored.tuning = t.tuning;
    if (t.string) stored.string = t.string;
    if (t.keys) stored.keys = t.keys;
    if (t.modal) stored.modal = t.modal;
    if (t.guitar) stored.guitar = t.guitar;
    if (t.wind) stored.wind = t.wind;
    if (t.sing) stored.sing = t.sing;
    if (t.clips && t.clips.length > 0)
      stored.clips = Object.freeze(
        t.clips.map((clip, index) => storedClip(clip, index, ticks)),
      );
    if (t.takes && t.takes.length > 0)
      stored.takes = Object.freeze(
        t.takes.map((spec) => storedTake(spec, ticks)),
      );
    if (t.vocoder)
      stored.vocoder = Object.freeze(
        t.vocoder.src === undefined
          ? t.vocoder
          : {
              ...t.vocoder,
              src: resolveVocoderSrc(
                input.tracks as TrackSpec[],
                t.id,
                t.vocoder.src,
              ),
            },
      );
    if (t.autotune) stored.autotune = t.autotune;
    if (t.rhythm && t.rhythm.length > 0)
      stored.rhythm = Object.freeze(
        t.rhythm.map((row) => {
          const { kind: _kind, ...fields } = row;
          return Object.freeze(fields);
        }),
      );
    tracks.push(Object.freeze(stored) as ScoreTrack);
    const ids = new Set<string>();
    for (const n of t.notes) {
      const startTick = ticks(n.start);
      const durationTicks = Math.max(1, ticks(n.length));
      let id = "";
      for (let occurrence = 0; ; occurrence += 1) {
        id = `n-${hash64(`${t.id}|${n.pitch}|${startTick}|${durationTicks}|${n.velocity}|${occurrence}`)}`;
        if (!ids.has(id)) break;
      }
      ids.add(id);
      notes.push(
        Object.freeze({
          id,
          trackId: t.id,
          startTick,
          durationTicks,
          pitch: n.pitch,
          velocity: n.velocity,
          ...(n.articulation ? { articulation: n.articulation } : {}),
          ...(n.glide !== undefined ? { glide: n.glide } : {}),
          ...(n.bend
            ? {
                bend: Object.freeze(
                  [...n.bend]
                    .sort((a, b) => a[0] - b[0])
                    .map(([at, cents]) => Object.freeze({ at, cents })),
                ),
              }
            : {}),
          ...(n.vibrato ? { vibrato: n.vibrato } : {}),
          ...(n.humanize ? { humanize: n.humanize } : {}),
          ...(n.drift !== undefined ? { drift: n.drift } : {}),
          ...(n.cents ? { cents: n.cents } : {}),
          ...(n.vowel ? { vowel: n.vowel } : {}),
          ...(n.lyric !== undefined ? { lyric: n.lyric } : {}),
        }),
      );
    }
  });
  // An ombak pair (SDK 1.30.0): a partner (pengumbang) whose preset carries
  // its own ombak twin bank plays one straight voice instead, as `modal
  // pair` and set_modal leave it, unless it sets ombak itself.
  for (const track of [...tracks]) {
    const pair = (track as { modal?: { pair?: string } }).modal?.pair;
    if (pair === undefined) continue;
    const at = tracks.findIndex((candidate) => candidate.id === pair);
    const partner = tracks[at] as
      (ScoreTrack & { modal?: Readonly<Record<string, unknown>> }) | undefined;
    if (
      partner?.modal &&
      partner.modal.ombak === undefined &&
      MODAL_TWIN_PRESETS.includes(String(partner.modal.preset))
    )
      tracks[at] = Object.freeze({
        ...partner,
        modal: Object.freeze({ ...partner.modal, ombak: 0 }),
      }) as ScoreTrack;
  }
  const arrangement: {
    sections?: readonly SongSection[];
    form?: readonly SongFormEntry[];
    loopSection?: string;
    loop?: Readonly<{ startBar: number; bars: number }>;
  } = {};
  if (input.sections !== undefined) {
    const sections = songSections(input.sections);
    if (sections.length > 0) arrangement.sections = sections;
  }
  if (input.form !== undefined) {
    const form = parseSongForm(input.form);
    if (form.length > 0) arrangement.form = form;
  }
  if (input.loopSection !== undefined) {
    if (typeof input.loopSection !== "string")
      throw new DawgSdkError("song loopSection must be a section name");
    arrangement.loopSection = input.loopSection;
  }
  if (input.loop !== undefined) {
    if (input.loopSection !== undefined)
      throw new DawgSdkError("song sets loop or loopSection, not both");
    const looped = songLoop(input.loop, bars);
    if (typeof looped === "string") arrangement.loopSection = looped;
    else arrangement.loop = looped;
  }
  return Object.freeze({
    format: "track.loop/v1",
    version: 1,
    tempoBpm,
    beatsPerBar,
    bars,
    ticksPerBeat,
    key,
    ...songTime(
      input.time,
      tempoBpm,
      ticks,
      beatsPerBar,
      ticksPerBeat,
      beatUnit,
      bars,
    ),
    ...(songTuning ? { tuning: songTuning } : {}),
    tracks: Object.freeze(tracks),
    notes: Object.freeze(notes),
    ...(master ? { master } : {}),
    ...songStyle(input.style),
    ...arrangement,
    ...(calibration ? { calibration } : {}),
    ...(Object.keys(library).length > 0
      ? { patches: Object.freeze(library) }
      : {}),
  });
}

/** `song({ patches })` keyed by name. */
function songPatches(input: unknown): Record<string, PatchSpec> {
  const out: Record<string, PatchSpec> = {};
  if (input === undefined) return out;
  if (!Array.isArray(input) || input.length > 32)
    throw new DawgSdkError("song patches must be a list of at most 32 patch()");
  for (const value of input) {
    if (!isPatchValue(value) || "ref" in value)
      throw new DawgSdkError(
        "song patches must come from patch() or fxPatch()",
      );
    if (out[value.name])
      throw new DawgSdkError(`song has two patches named ${value.name}`);
    out[value.name] = value;
  }
  return out;
}

/** A macro's knob position 0..1 for `value` (lin, or exp for a ratio). */
function knobPosition(macro: PatchMacroData, value: number): number {
  const v = Math.min(macro.max, Math.max(macro.min, value));
  const p =
    macro.curve === "exp"
      ? Math.log(v / macro.min) / Math.log(macro.max / macro.min)
      : (v - macro.min) / (macro.max - macro.min);
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
}

/**
 * A track's signals as lanes: hidden patch macros and `mods` as knob
 * positions on `patch-<macro>`, `lanes` as values.
 */
function bakeTrackSignals(
  t: TrackSpec,
  library: Readonly<Record<string, PatchSpec>>,
  grid: Readonly<{ bars: number; ticksPerBar: number }>,
): Record<string, readonly ScorePoint[]> {
  const out: Record<string, readonly ScorePoint[]> = {};
  if (!t.patch && !t.fxPatch && !t.mods && !t.lanes) return out;
  const seed = signalSeed(t.id);
  const bake = (signal: PatternSignal, map?: (value: number) => number) =>
    bakeSignal(signal, { ...grid, seed, ...(map ? { map } : {}) });
  const played: PatchSpec[] = [];
  if (t.patch) {
    if ("ref" in t.patch) {
      const found = library[t.patch.ref];
      if (!found)
        throw new DawgSdkError(
          `track ${t.name}: no patch "${t.patch.ref}" in song({ patches })`,
        );
      played.push(found);
    } else played.push(t.patch);
  }
  played.push(...(t.fxPatch ?? []));
  const macros = new Map<string, PatchMacroData>();
  for (const p of played)
    for (const macro of p.macros)
      if (!macros.has(macro.id)) macros.set(macro.id, macro);
  const signals: (readonly [string, PatternSignal])[] = [];
  for (const p of played) signals.push(...patchSignals(p));
  for (const [id, signal] of Object.entries(t.mods ?? {})) {
    if (!macros.has(id))
      throw new DawgSdkError(
        `track ${t.name}: mods.${id} names no macro of its patches (${[...macros.keys()].join(" ") || "none"})`,
      );
    signals.push([id, signal]);
  }
  for (const [id, signal] of signals) {
    const macro = macros.get(id)!;
    out[`patch-${id}`] = bake(signal, (value) => knobPosition(macro, value));
  }
  for (const [lane, signal] of Object.entries(t.lanes ?? {}))
    out[lane] = bake(signal);
  return out;
}

// ---------------------------------------------------------------------------
// Time (SDK 1.14.0)

/** One entry of `song({ time })`; build them with the helpers below. */
export type TimeMark =
  | Readonly<{
      kind: "tempo";
      /** Beat the change lands on. */
      at: number;
      /** Absent: keep the tempo in effect there, so a ramp can start from it. */
      bpm?: number;
      /** Glide into `bpm` from the previous mark instead of stepping. */
      ramp?: "linear" | "exp";
      /** Set by `rit()`/`accel()`: the direction `song()` checks. */
      gradual?: "rit" | "accel";
      /**
       * Set by `aTempo()` (the tempo before the last rit/accel) and
       * `tempoPrimo()` (the song's opening tempo) instead of `bpm`.
       */
      back?: "a-tempo" | "primo";
    }>
  | Readonly<{
      kind: "meter";
      /** Beat of the bar line where the meter starts. */
      at: number;
      beatsPerBar: number;
      beatUnit: number;
    }>
  | Readonly<{
      kind: "fermata";
      at: number;
      /** Extra beats the held beat lasts. */
      beats: number;
    }>;

/** `ramp()` curves: `linear` adds the same BPM each beat, `exp` the same ratio. */
export type TempoCurve = "linear" | "exp";

/**
 * Tempo change at beat `at`: `tempo(32, 140)`. Omit `bpm` to pin the tempo
 * in effect there, the start of a ramp.
 */
export function tempo(at: number, bpm?: number): TimeMark {
  const start = beat(at, "tempo() at");
  if (start <= 0)
    throw new DawgSdkError("tempo() at must be > 0; song({ tempo }) is beat 0");
  if (bpm === undefined) return Object.freeze({ kind: "tempo", at: start });
  return Object.freeze({ kind: "tempo", at: start, bpm: songBpm(bpm) });
}

/**
 * `a tempo` at beat `at` (SDK 1.19.0): step back to the tempo in effect
 * before the last `rit()`/`accel()` (or ramp) ending before `at`.
 */
export function aTempo(at: number): TimeMark {
  const start = beat(at, "aTempo() at");
  if (start <= 0) throw new DawgSdkError("aTempo() at must be > 0");
  return Object.freeze({ kind: "tempo", at: start, back: "a-tempo" });
}

/** `tempo primo` at beat `at` (SDK 1.19.0): step back to `song({ tempo })`. */
export function tempoPrimo(at: number): TimeMark {
  const start = beat(at, "tempoPrimo() at");
  if (start <= 0) throw new DawgSdkError("tempoPrimo() at must be > 0");
  return Object.freeze({ kind: "tempo", at: start, back: "primo" });
}

/**
 * Glide from the previous tempo mark (or the song's opening tempo) to `bpm`
 * at beat `at`: `ramp(64, 90)`. `exp` changes by the same ratio each beat.
 */
export function ramp(
  at: number,
  bpm: number,
  curve: TempoCurve = "linear",
): TimeMark {
  const end = beat(at, "ramp() at");
  if (end <= 0) throw new DawgSdkError("ramp() at must be > 0");
  return Object.freeze({
    kind: "tempo",
    at: end,
    bpm: songBpm(bpm),
    ramp: tempoCurve(curve, "ramp()"),
  });
}

/**
 * Ritardando: slow from the tempo at beat `at` to `bpm` over `beats` beats,
 * `rit(48, 16, 80)`. Same as `[tempo(at), ramp(at + beats, bpm, curve)]`.
 */
export function rit(
  at: number,
  beats: number,
  bpm: number,
  curve: TempoCurve = "linear",
): readonly TimeMark[] {
  return gradual("rit", at, beats, bpm, curve);
}

/** Accelerando: like `rit()`, toward a faster `bpm`. */
export function accel(
  at: number,
  beats: number,
  bpm: number,
  curve: TempoCurve = "linear",
): readonly TimeMark[] {
  return gradual("accel", at, beats, bpm, curve);
}

function gradual(
  direction: "rit" | "accel",
  at: number,
  beats: number,
  bpm: number,
  curve: TempoCurve,
): readonly TimeMark[] {
  const label = `${direction}()`;
  const start = beat(at, `${label} at`);
  const length = positive(beats, `${label} beats`);
  const target = songBpm(bpm);
  const shape = tempoCurve(curve, label);
  const marks: TimeMark[] = [];
  if (start > 0) marks.push(Object.freeze({ kind: "tempo", at: start }));
  marks.push(
    Object.freeze({
      kind: "tempo",
      at: start + length,
      bpm: target,
      ramp: shape,
      gradual: direction,
    }),
  );
  return Object.freeze(marks);
}

/** Fermata: the beat at `at` lasts `beats` extra beats (default 2). */
export function fermata(at: number, beats = 2): TimeMark {
  const hold = positive(beats, "fermata() beats");
  if (hold > 64) throw new DawgSdkError("fermata() beats must be at most 64");
  return Object.freeze({
    kind: "fermata",
    at: beat(at, "fermata() at"),
    beats: hold,
  });
}

/**
 * Meter change on the bar line at beat `at`: `meter(16, [7, 8])` or
 * `meter(16, 3)` (quarter-note beats). It lasts until the next one.
 */
export function meter(
  at: number,
  value: readonly [number, number] | number,
): TimeMark {
  const start = beat(at, "meter() at");
  const [beatsPerBar, beatUnit] = Array.isArray(value)
    ? [value[0], value[1]]
    : [value as number, 4];
  if (
    typeof beatsPerBar !== "number" ||
    !Number.isInteger(beatsPerBar) ||
    beatsPerBar < 1 ||
    beatsPerBar > 16
  )
    throw new DawgSdkError("meter() beats per bar must be an integer 1..16");
  if (![1, 2, 4, 8, 16, 32].includes(beatUnit as number))
    throw new DawgSdkError("meter() note value must be 1, 2, 4, 8, 16 or 32");
  return Object.freeze({
    kind: "meter",
    at: start,
    beatsPerBar,
    beatUnit: beatUnit as number,
  });
}

/**
 * Track time for continuous phasing, the tape drift of Reich's It's Gonna
 * Rain and Come Out: the track's first `cycle` beats repeat a little fast,
 * gaining `cycles` whole cycles every `over` beats, so it drifts away from
 * an identical track and lines up again. `over` should divide the song
 * loop. `track({ ..., time: phasing(3, 48) })`. For Piano Phase's
 * shift-and-hold, use `stepPhasing()`.
 */
export function phasing(
  cycle: number,
  over: number,
  cycles = 1,
): TrackTimeInput {
  const length = positive(cycle, "phasing() cycle");
  const span = positive(over, "phasing() over");
  const gain = finite(cycles, "phasing() cycles");
  const repeats = span / length;
  const rate = (repeats + gain) / repeats;
  if (!(rate >= 0.125 && rate <= 8))
    throw new DawgSdkError("phasing() needs a rate between 0.125 and 8");
  return Object.freeze({ cycle: length, rate });
}

/**
 * Stepped phasing (SDK 1.19.0), as in Reich's Piano Phase: the track's first `cycle`
 * beats hold in step with a twin for `hold` cycles, then move `shift`
 * beats ahead over `drift` cycles, and repeat until a whole cycle ahead.
 * `track({ ..., time: stepPhasing(3, { hold: 8 }) })`.
 */
export function stepPhasing(
  cycle: number,
  options: Readonly<{ shift?: number; hold?: number; drift?: number }> = {},
): TrackTimeInput {
  const length = positive(cycle, "stepPhasing() cycle");
  const steps = phaseSteps(
    { shift: 0.25, hold: 8, drift: 2, ...options },
    length,
    "stepPhasing()",
  );
  return Object.freeze({ cycle: length, steps });
}

function songBpm(value: unknown): number {
  const bpm = finite(value, "tempo bpm");
  if (bpm < 20 || bpm > 300)
    throw new DawgSdkError("tempo bpm must be 20..300");
  return bpm;
}

function tempoCurve(value: unknown, label: string): TempoCurve {
  if (value !== "linear" && value !== "exp")
    throw new DawgSdkError(`${label} curve must be "linear" or "exp"`);
  return value;
}

/** Same as `TIME_LIMITS.maxFermataSeconds` in core/tempo.ts. */
const MAX_FERMATA_SECONDS = 16.777;

/** Tempo at `tick` through resolved tempo events (ramps glide into theirs). */
function bpmAtTick(
  tempo: readonly { tick: number; bpm: number; ramp?: TempoCurve }[],
  start: number,
  tick: number,
): number {
  let from = { tick: 0, bpm: start };
  for (const event of tempo) {
    if (event.tick <= tick) {
      from = event;
      continue;
    }
    if (!event.ramp) break;
    const t = (tick - from.tick) / (event.tick - from.tick);
    return event.ramp === "exp"
      ? from.bpm * Math.pow(event.bpm / from.bpm, t)
      : from.bpm + (event.bpm - from.bpm) * t;
  }
  return from.bpm;
}

/** Resolves `song({ time })` marks into the stored ticks and bar indexes. */
function songTime(
  input: unknown,
  tempoBpm: number,
  ticks: (beats: number) => number,
  beatsPerBar: number,
  ticksPerBeat: number,
  beatUnit = 4,
  bars = Infinity,
): { time?: ScoreTime } {
  if ((input === undefined || input === null) && beatUnit === 4) return {};
  input ??= [];
  if (!Array.isArray(input))
    throw new DawgSdkError("song time must be an array of time marks");
  const marks: TimeMark[] = [];
  for (const [index, entry] of (input as unknown[]).entries()) {
    for (const mark of Array.isArray(entry) ? entry : [entry]) {
      if (
        !isRecord(mark) ||
        (mark.kind !== "tempo" &&
          mark.kind !== "meter" &&
          mark.kind !== "fermata")
      )
        throw new DawgSdkError(
          `song time[${index}] must come from tempo(), ramp(), rit(), accel(), fermata() or meter()`,
        );
      marks.push(mark as TimeMark);
    }
  }
  // Tempo: sort by tick, resolve pins against their neighbours.
  type Event = {
    tick: number;
    bpm?: number;
    ramp?: TempoCurve;
    back?: "a-tempo" | "primo";
  };
  const byTick = new Map<number, Event>();
  for (const mark of marks) {
    if (mark.kind !== "tempo") continue;
    const tick = ticks(mark.at);
    const previous = byTick.get(tick);
    const sets = (e: { bpm?: number; back?: unknown }) =>
      e.bpm !== undefined || e.back !== undefined;
    if (previous && sets(previous) && sets(mark)) {
      // A rit or ramp ending where a tempo change starts (`rit(18, 6, 52)`
      // with `aTempo(24)`): the ramp lands a tick early, then the step.
      const ramped = previous.ramp ? previous : mark.ramp ? mark : undefined;
      const other = ramped === previous ? mark : previous;
      if (ramped && !other.ramp && tick > 1 && !byTick.has(tick - 1)) {
        byTick.set(tick - 1, {
          tick: tick - 1,
          ...(ramped.bpm !== undefined ? { bpm: ramped.bpm } : {}),
          ramp: ramped.ramp!,
        });
        byTick.set(tick, {
          tick,
          ...(other.bpm !== undefined ? { bpm: other.bpm } : {}),
          ...(other.back ? { back: other.back } : {}),
        });
        continue;
      }
      throw new DawgSdkError(
        `song time has two tempo changes at beat ${mark.at}; move one, or end a rit() where the next tempo starts`,
      );
    }
    // A pin and a change on the same beat: the change wins.
    if (previous && !sets(mark)) continue;
    byTick.set(tick, {
      tick,
      ...(mark.bpm !== undefined ? { bpm: mark.bpm } : {}),
      ...(mark.ramp ? { ramp: mark.ramp } : {}),
      ...(mark.back ? { back: mark.back } : {}),
    });
  }
  const events = [...byTick.values()].sort((a, b) => a.tick - b.tick);
  const tempo: { tick: number; bpm: number; ramp?: TempoCurve }[] = [];
  events.forEach((event, index) => {
    if (event.back) {
      let bpm = tempoBpm;
      if (event.back === "a-tempo") {
        let last = -1;
        tempo.forEach((e, i) => {
          if (e.ramp !== undefined) last = i;
        });
        if (last < 0)
          throw new DawgSdkError(
            `aTempo() at beat ${event.tick / ticksPerBeat} has no rit() or accel() before it`,
          );
        bpm = last > 0 ? tempo[last - 1]!.bpm : tempoBpm;
      }
      tempo.push(Object.freeze({ tick: event.tick, bpm }));
      return;
    }
    if (event.bpm !== undefined) {
      // rit() and accel() check their direction against the tempo they
      // start from, as the prompt's `rit` and `accel` do.
      const mark = marks.find(
        (m) => m.kind === "tempo" && ticks(m.at) === event.tick && m.gradual,
      ) as Extract<TimeMark, { kind: "tempo" }> | undefined;
      if (mark?.gradual) {
        const from = tempo[tempo.length - 1]?.bpm ?? tempoBpm;
        if (mark.gradual === "rit" && event.bpm > from)
          throw new DawgSdkError(
            `rit() target ${event.bpm} BPM is faster than ${from}; use accel()`,
          );
        if (mark.gradual === "accel" && event.bpm < from)
          throw new DawgSdkError(
            `accel() target ${event.bpm} BPM is slower than ${from}; use rit()`,
          );
      }
      tempo.push(
        Object.freeze({
          tick: event.tick,
          bpm: event.bpm,
          ...(event.ramp ? { ramp: event.ramp } : {}),
        }),
      );
      return;
    }
    // A pin holds the tempo of the marks before it, and the next ramp
    // starts from it. Without a ramp after it, it changes nothing.
    const after = events
      .slice(index + 1)
      .find((e) => e.bpm !== undefined || e.back !== undefined);
    if (!after?.ramp) return;
    const before = tempo[tempo.length - 1]?.bpm ?? tempoBpm;
    tempo.push(Object.freeze({ tick: event.tick, bpm: before }));
  });
  // Meter: beats to bar indexes, checking each lands on a bar line.
  const meters = marks
    .filter((mark) => mark.kind === "meter")
    .sort((a, b) => a.at - b.at);
  // `song({ meter: [6, 8] })`: the song meter's note value as a bar-1 change.
  if (beatUnit !== 4 && !meters.some((mark) => ticks(mark.at) === 0))
    meters.unshift({ kind: "meter", at: 0, beatsPerBar, beatUnit });
  const meterOut: { bar: number; beatsPerBar: number; beatUnit?: number }[] =
    [];
  let barTick = 0;
  let barIndex = 0;
  let barLength = beatsPerBar * ticksPerBeat;
  for (const mark of meters) {
    const tick = ticks(mark.at);
    const bars = (tick - barTick) / barLength;
    if (!Number.isInteger(bars) || bars < 0)
      throw new DawgSdkError(`meter() at beat ${mark.at} is not on a bar line`);
    if (meterOut.length > 0 && bars === 0)
      throw new DawgSdkError(`song time has two meters at beat ${mark.at}`);
    barIndex += bars;
    barTick = tick;
    barLength = (mark.beatsPerBar * ticksPerBeat * 4) / mark.beatUnit;
    meterOut.push(
      Object.freeze({
        bar: barIndex,
        beatsPerBar: mark.beatsPerBar,
        ...(mark.beatUnit !== 4 ? { beatUnit: mark.beatUnit } : {}),
      }),
    );
  }
  const fermatas = marks
    .filter((mark) => mark.kind === "fermata")
    .map((mark) => Object.freeze({ tick: ticks(mark.at), beats: mark.beats }))
    .sort((a, b) => a.tick - b.tick);
  for (let i = 1; i < fermatas.length; i += 1)
    if (fermatas[i]!.tick === fermatas[i - 1]!.tick)
      throw new DawgSdkError("song time has two fermatas on one beat");
  // Marks past the song end are never heard; the prompt refuses them too.
  if (Number.isFinite(bars)) {
    let end = 0;
    let fromBar = 0;
    let length = beatsPerBar * ticksPerBeat;
    for (const change of meterOut) {
      if (change.bar >= bars) break;
      end += (change.bar - fromBar) * length;
      fromBar = change.bar;
      length = (change.beatsPerBar * ticksPerBeat * 4) / (change.beatUnit ?? 4);
    }
    end += (bars - fromBar) * length;
    const beatOf = (tick: number) => tick / ticksPerBeat;
    // A ramp to the final barline (`rit()` over the last bars) lands on
    // the last tick, the tempo the song ends at.
    tempo.forEach((event, index) => {
      if (
        event.tick === end &&
        event.ramp &&
        end - 1 > (tempo[index - 1]?.tick ?? 0)
      )
        tempo[index] = Object.freeze({ ...event, tick: end - 1 });
    });
    for (const event of tempo)
      if (event.tick >= end)
        throw new DawgSdkError(
          `tempo at beat ${beatOf(event.tick)} is past the song end (${beatOf(end)} beats); add bars`,
        );
    for (const change of meterOut)
      if (change.bar >= bars)
        throw new DawgSdkError(
          `meter() at bar ${change.bar + 1} is past the song end (${bars} bars); add bars`,
        );
    for (const hold of fermatas)
      if (hold.tick >= end)
        throw new DawgSdkError(
          `fermata() at beat ${beatOf(hold.tick)} is past the song end (${beatOf(end)} beats); add bars`,
        );
  }
  // A fermata may hold its beat at most as long as a MIDI file can write.
  // The held beat is the meter's felt beat (a dotted quarter in 6/8), as
  // core/tempo.ts fermataSpan has it.
  const feltBeats = (tick: number): number => {
    let at = 0;
    let fromBar = 0;
    let meter = { beatsPerBar, beatUnit: 4 };
    let length = beatsPerBar * ticksPerBeat;
    for (const change of meterOut) {
      const start = at + (change.bar - fromBar) * length;
      if (start > tick) break;
      at = start;
      fromBar = change.bar;
      meter = {
        beatsPerBar: change.beatsPerBar,
        beatUnit: change.beatUnit ?? 4,
      };
      length = (meter.beatsPerBar * ticksPerBeat * 4) / meter.beatUnit;
    }
    if (meterOut.length === 0) return 1;
    const unit = 4 / meter.beatUnit;
    const compound =
      meter.beatUnit >= 8 &&
      meter.beatsPerBar > 3 &&
      meter.beatsPerBar % 3 === 0;
    return Math.max(1, compound ? unit * 3 : unit);
  };
  for (const hold of fermatas) {
    const bpm = bpmAtTick(tempo, tempoBpm, hold.tick);
    const held = ((1 + hold.beats) * feltBeats(hold.tick) * 60) / bpm;
    if (held > MAX_FERMATA_SECONDS + 1e-9)
      throw new DawgSdkError(
        `fermata() at beat ${hold.tick / ticksPerBeat} holds ${held.toFixed(1)} s; at most ${MAX_FERMATA_SECONDS} s (MIDI tempo limit), so use fewer beats or a faster tempo`,
      );
  }
  const time: Record<string, unknown> = {};
  if (tempo.length > 0) time.tempo = Object.freeze(tempo);
  if (meterOut.length > 0) time.meter = Object.freeze(meterOut);
  if (fermatas.length > 0) time.fermatas = Object.freeze(fermatas);
  return Object.keys(time).length > 0
    ? { time: Object.freeze(time) as ScoreTime }
    : {};
}

// Tuning (SDK 1.16.0)

/**
 * A tuning for `song({ tuning })` or `track({ tuning })`: a library name or
 * an object with at most one table source (`edo`, `ratios`, `cents` or
 * `scl`). Library names: `12-tet`, `19-edo`, `24-edo`, `31-edo`,
 * `pythagorean`, `just` (5-limit), `7-limit`, `well-tuned-piano`, `pelog`,
 * `slendro`, `nyamaropa`, `thai`, `shruti`, maqam and dastgah sets (`bayati`,
 * `rast`, `saba`, `shur`, `homayoun`, `chahargah`) and raga intonations
 * (`yaman`, `bhairav`, `kafi`, `todi`, …); `dawg` lists them with
 * `/tuning list`. dawg checks every value when the song loads.
 */
export type TuningInput =
  | string
  | Readonly<{
      /** A library tuning, or a label for the table given here. */
      name?: string;
      /** Equal divisions of the octave, 1..128. */
      edo?: number;
      /** Ratios for degrees 1..n, the last the period: `["9/8", "5/4", "2/1"]`. */
      ratios?: readonly (string | number)[];
      /** Cents for degrees 1..n, the last the period: `[240, 480, 720, 960, 1200]`. */
      cents?: readonly number[];
      /** A Scala `.scl` file in the project, e.g. `"tunings/slendro.scl"`. */
      scl?: string;
      /** A Scala `.kbm` keyboard mapping in the project; it sets its own root and A4. */
      kbm?: string;
      /** A4 in Hz, 220..880, default 440. */
      ref?: number;
      /** Key of degree 0, `"D4"` or 62; default the song key's tonic in octave 4. */
      root?: Pitch;
      /** `linear` (default): one key per step. `nearest`: every key plays the step nearest its 12-TET pitch. */
      map?: "linear" | "nearest";
    }>;

/** A stored tuning: `root` is a MIDI number, `ratios` are strings. */
export type ScoreTuning = Readonly<{
  name?: string;
  edo?: number;
  ratios?: readonly string[];
  cents?: readonly number[];
  scl?: string;
  kbm?: string;
  ref?: number;
  root?: number;
  map?: "linear" | "nearest";
}>;

const TUNING_FIELDS: readonly string[] = Object.freeze([
  "name",
  "edo",
  "ratios",
  "cents",
  "scl",
  "kbm",
  "ref",
  "root",
  "map",
]);

/** Checks a tuning's shape; dawg validates the values when the song loads. */
function tuningSpec(
  input: TuningInput | null | undefined,
  where: string,
): ScoreTuning | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") {
    if (input.trim() === "")
      throw new DawgSdkError(`${where} tuning must be a name or an object`);
    return Object.freeze({ name: input.trim() });
  }
  if (!isRecord(input))
    throw new DawgSdkError(`${where} tuning must be a name or an object`);
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(input)) {
    if (!TUNING_FIELDS.includes(field))
      throw new DawgSdkError(
        `${where} tuning has an unknown field "${field}" (use ${TUNING_FIELDS.join(", ")})`,
      );
    if (value === undefined || value === null) continue;
    if (field === "root") out.root = midi(value as Pitch);
    else if (field === "ratios" || field === "cents") {
      if (!Array.isArray(value))
        throw new DawgSdkError(`${where} tuning ${field} must be a list`);
      out[field] = Object.freeze(
        field === "ratios" ? value.map((ratio) => String(ratio)) : [...value],
      );
    } else out[field] = value;
  }
  const sources = ["edo", "ratios", "cents", "scl"].filter(
    (field) => out[field] !== undefined,
  );
  if (sources.length > 1)
    throw new DawgSdkError(
      `${where} tuning has ${sources.join(" and ")}; give one table`,
    );
  return Object.freeze(out as ScoreTuning);
}

// ---------------------------------------------------------------------------
// Chords

/** Options shared by `chord()` and `progression()`. */
export type ChordOptions = Readonly<{
  /** Voicing dial: each step moves the lowest note up an octave (negative: the highest down), -12..12. */
  voicing?: number;
  /** `close` (default), `open` (drop 2) or `wide` (drop 2 and 4). */
  spread?: "close" | "open" | "wide";
  /** `block` (default), `strum-up`, `strum-down`, `arp-up`, `arp-down`, `arp-updown`, `arp-random`, `harp`, `slop`, `pattern` (SDK 1.7.0). */
  perform?:
    | "block"
    | "strum-up"
    | "strum-down"
    | "arp-up"
    | "arp-down"
    | "arp-updown"
    | "arp-random"
    | "harp"
    | "slop"
    | "pattern"
    | "guitar";
  /**
   * With `perform: "guitar"` (SDK 1.27.0): the stroke grid, a name (`down`
   * `folk` `pop` `punk` `funk` `reggae` `waltz` `jangle` `island`) or
   * characters D (down) U (up) d u (light) x (muted chuck) - . (rest).
   */
  strokes?: string;
  /** Guitar: grid step in beats, default 0.5 (8ths). */
  step?: number;
  /** Guitar: milliseconds a full six-string down stroke takes, default 22. */
  speed?: number;
  /** Guitar: the song tempo `speed` converts with, default 120. */
  tempo?: number;
  /** Guitar: tuning, capo, hand, ring and position (as a track's `guitar`). */
  guitar?: GuitarInput;
  /**
   * With `perform: "pattern"`: a rhythm pattern by name or 1-based number
   * (SDK 1.7.0): `eighths`, `sixteenths`, `offbeat`, `pop`, `charleston`,
   * `bossa`, `skank`, `gallop`, `half-time`, `tresillo`, `oom-pah`, `roll`,
   * `pick`. Default 1.
   */
  pattern?: string | number;
  /** Arpeggio step in beats, default 0.25. */
  rate?: number;
  /** Arpeggio/harp octaves 1..4, default 1. */
  octaves?: number;
  /** Strum gap between voices in beats, default 1/32. */
  strum?: number;
  /** Seed for `arp-random`, default 0. */
  seed?: number;
  /** Velocity, default 0.8. */
  vel?: number;
  /** Lowest root position: the root lands at or above this pitch, default C4. */
  anchor?: Pitch;
  /** `chords` (default), `bass` (root or slash bass in octave 2, one per chord) or `both`. */
  part?: "chords" | "bass" | "both";
  /**
   * Orchid bass mode (SDK 1.7.0; overrides `part`): `off` (chords only),
   * `chords` and `single` (chords plus root or slash bass), `unison`
   * (chords plus the chord's root, ignoring a slash) or `solo` (bass only).
   */
  bass?: "off" | "chords" | "unison" | "single" | "solo";
}>;

/** Options for `progression()`. */
export type ProgressionOptions = ChordOptions &
  Readonly<{
    /** Key the numerals read in: `"C major"`, `"a minor"`, `"F# dorian"`; default C major. */
    key?: string;
    /** Beat of the first chord, default 0. */
    from?: number;
    /** Beats per chord, default 4. */
    each?: number;
    /** Voice-lead each chord to the inversion nearest the previous, default true. */
    lead?: boolean;
  }>;

/**
 * One chord from a symbol (`"Cm7"`, `"F#dim"`, `"Bbmaj9"`, `"G7sus4"`,
 * `"C/E"`) as notes from `start` for `length` beats.
 *
 * ```ts
 * notes: [...chord("Am7", 0, 4), ...chord("D9", 4, 4, { perform: "strum-up" })]
 * ```
 */
export function chord(
  symbol: string,
  start = 0,
  length = 4,
  options: ChordOptions = {},
): readonly NoteSpec[] {
  if (typeof symbol !== "string" || parseChord(symbol) === undefined)
    throw new DawgSdkError(`unknown chord symbol ${JSON.stringify(symbol)}`);
  return progression([symbol], {
    ...options,
    from: start,
    each: length,
    lead: false,
  });
}

/**
 * A voice-led progression: roman numerals in `key` (`"ii7"`, `"V"`,
 * `"bVII"`, `"V/V"`) or chord symbols, as an array or a space-separated
 * string, one chord per `each` beats from `from`. Each chord takes the
 * inversion nearest the previous one, so common tones hold. Same input,
 * same notes; dawg's play mode and agent tools use the same engine.
 *
 * ```ts
 * notes: progression("ii7 V7 Imaj7 Imaj7", { key: "C major", perform: "arp-up", rate: 0.5 })
 * notes: progression(["i", "VI", "III", "VII"], { key: "a minor", part: "bass" })
 * ```
 */
export function progression(
  chords: string | readonly string[],
  options: ProgressionOptions = {},
): readonly NoteSpec[] {
  const symbols =
    typeof chords === "string" ? chords.trim().split(/\s+/) : [...chords];
  if (symbols.length === 0 || symbols.length > 256 || symbols[0] === "")
    throw new DawgSdkError("progression needs 1..256 chords");
  const key = parseKey(options.key ?? "C major");
  if (!key)
    throw new DawgSdkError(`unknown key ${JSON.stringify(options.key)}`);
  const parsed = symbols.map((symbol) => {
    const value =
      typeof symbol === "string" ? resolveChord(key, symbol) : undefined;
    if (!value)
      throw new DawgSdkError(
        `unknown chord ${JSON.stringify(symbol)} (roman numeral or symbol)`,
      );
    return value;
  });
  const from = beat(options.from ?? 0, "progression from");
  const each = positive(options.each ?? 4, "progression each");
  const vel = unit(options.vel ?? DEFAULT_VELOCITY, "chord vel");
  const voicing = finite(options.voicing ?? 0, "chord voicing");
  const spread = options.spread ?? "close";
  if (!(SPREADS as readonly string[]).includes(spread))
    throw new DawgSdkError('chord spread must be "close", "open" or "wide"');
  const mode = options.perform ?? "block";
  if (!(PERFORM_MODES as readonly string[]).includes(mode))
    throw new DawgSdkError(`unknown chord perform ${JSON.stringify(mode)}`);
  if (
    options.bass !== undefined &&
    !(BASS_MODES as readonly string[]).includes(options.bass)
  )
    throw new DawgSdkError(
      `chord bass must be one of ${BASS_MODES.map((m) => JSON.stringify(m)).join(", ")}`,
    );
  if (options.pattern !== undefined && !findChordPattern(options.pattern))
    throw new DawgSdkError(
      `unknown chord pattern ${JSON.stringify(options.pattern)} (1..${CHORD_PATTERNS.length} or ${CHORD_PATTERNS.map((p) => p.name).join(", ")})`,
    );
  const part =
    options.bass === undefined
      ? (options.part ?? "chords")
      : options.bass === "off"
        ? "chords"
        : options.bass === "solo"
          ? "bass"
          : "both";
  if (part !== "chords" && part !== "bass" && part !== "both")
    throw new DawgSdkError('chord part must be "chords", "bass" or "both"');
  const rendered = renderProgression({
    key,
    chords: parsed,
    beatsPerChord: each,
    start: from,
    inversion: voicing,
    spread,
    bass: part !== "chords",
    ...(options.bass === "unison" ? { bassMode: "unison" as const } : {}),
    lead: options.lead ?? true,
    anchor: midi(options.anchor ?? 60),
    perform: {
      mode,
      rate: positive(options.rate ?? DEFAULT_ARP_RATE, "chord rate"),
      octaves: finite(options.octaves ?? 1, "chord octaves"),
      ...(options.strum !== undefined
        ? { strum: beat(options.strum, "chord strum") }
        : {}),
      seed: finite(options.seed ?? 0, "chord seed"),
      ...(options.pattern !== undefined ? { pattern: options.pattern } : {}),
      velocity: vel,
      ...(mode === "guitar" ? guitarPerform(options) : {}),
    },
  });
  const out = [
    ...(part === "bass" ? [] : rendered.notes),
    ...(part === "chords" ? [] : rendered.bass),
  ];
  if (out.length > 4096)
    throw new DawgSdkError("progression would produce over 4096 notes");
  return Object.freeze(
    out.map((n) => note(n.pitch, round(n.start), n.length, n.velocity)),
  );
}

/** A track's guitar setup (SDK 1.27.0): see `TrackInput.guitar`. */
export type GuitarInput = Readonly<{
  /** `standard` `dropd` `doubledropd` `dadgad` `openg` `opend` `opene` `halfdown` `nashville` `bass` `ukulele` `requinto`, or open-string pitches low to high. */
  tune?: string | readonly Pitch[];
  /** Capo fret 0..12. */
  capo?: number;
  /** Hand stretch in frets 3..6, default 4. */
  hand?: number;
  /** 0 closed shapes .. 1 ringing open strings, default 0.5. */
  ring?: number;
  /** Preferred fret position 0..12. */
  position?: number;
}>;

function guitarInput(
  input: GuitarInput | undefined,
  where: string,
): GuitarSetup | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input))
    throw new DawgSdkError(`${where} guitar must be an object`);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input))
    if (!["tune", "capo", "hand", "ring", "position"].includes(key))
      throw new DawgSdkError(
        `${where} guitar has no field "${key.slice(0, 32)}" (tune capo hand ring position)`,
      );
  if (input.tune !== undefined) {
    if (typeof input.tune === "string") {
      const name = input.tune.toLowerCase().replace(/[\s_-]/g, "");
      if (!(GUITAR_TUNING_NAMES as readonly string[]).includes(name))
        throw new DawgSdkError(
          `${where} guitar tune must be one of ${GUITAR_TUNING_NAMES.join(" ")} or a list of pitches`,
        );
      out.tune = name;
    } else if (
      Array.isArray(input.tune) &&
      input.tune.length >= 3 &&
      input.tune.length <= 12
    )
      out.tune = Object.freeze(input.tune.map((p) => midi(p)));
    else
      throw new DawgSdkError(
        `${where} guitar tune must be a name or 3..12 pitches`,
      );
  }
  const int = (key: "capo" | "hand" | "position", min: number, max: number) => {
    const value = input[key];
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < min || value > max)
      throw new DawgSdkError(
        `${where} guitar ${key} must be an integer ${min}..${max}`,
      );
    out[key] = value;
  };
  int("capo", 0, 12);
  int("hand", 3, 6);
  if (input.ring !== undefined)
    out.ring =
      Math.round(unit(input.ring, `${where} guitar ring`) * 1000) / 1000;
  int("position", 0, 12);
  return Object.keys(out).length > 0 ? Object.freeze(out) : undefined;
}

function guitarPerform(options: ChordOptions): Partial<PerformOptions> {
  if (options.strokes !== undefined && !strokeGrid(options.strokes))
    throw new DawgSdkError(
      `chord strokes must be one of ${STROKE_PATTERN_NAMES.join(" ")} or a grid of D U d u x - .`,
    );
  const setup = guitarInput(options.guitar, "chord");
  return {
    ...(options.strokes !== undefined ? { strokes: options.strokes } : {}),
    ...(options.step !== undefined
      ? { step: positive(options.step, "chord step") }
      : {}),
    ...(options.speed !== undefined
      ? {
          speed:
            Math.min(200, Math.max(0, finite(options.speed, "chord speed"))) /
            1000,
        }
      : {}),
    ...(options.tempo !== undefined
      ? { tempo: positive(options.tempo, "chord tempo") }
      : {}),
    ...(setup ? { guitar: setup } : {}),
  };
}

/**
 * Strummed guitar chords (SDK 1.27.0): `progression()` with
 * `perform: "guitar"`. Each chord is fretted on the guitar (`tune`, `capo`,
 * no barre over an open string) and strummed with a stroke grid; a down
 * stroke sweeps the strings in `speed` ms. Pair with `guitar` on the track
 * so dawg's prompt strums the same shapes.
 *
 * ```ts
 * notes: strum("G D Em C", { strokes: "folk", speed: 25, tempo: 96 })
 * notes: strum("i VI III VII", { key: "e minor", strokes: "D-DU-UDU", guitar: { capo: 2 } })
 * ```
 */
export function strum(
  chords: string | readonly string[],
  options: Omit<ProgressionOptions, "perform"> = {},
): readonly NoteSpec[] {
  return progression(chords, { ...options, perform: "guitar" });
}

// BEGIN lyrics: generated from core/lyrics.ts by core/sdk/sync-lyrics.ts
/** Longest lyric on one note (SCORE_LIMITS.maxLyricLength). */
const LYRIC_LIMIT = 32;

/** One lyric token: a syllable, a held note (`_`) or a skipped note (`~`). */
type LyricToken = Readonly<{
  syl: string;
  /** Index of the word the token belongs to. */
  word: number;
  /** First syllable of its word. */
  first: boolean;
  kind: "syl" | "hold" | "rest";
}>;

/**
 * The lyric grammar: words split by spaces, syllables by `-`, `_` holds the
 * previous syllable over the next note (melisma), `~` skips a note.
 * "sun-lit morn-ing _ glow" gives sun lit morn ing _ glow.
 */
function parseLyric(text: string): LyricToken[] {
  const out: LyricToken[] = [];
  let word = -1;
  for (const raw of text.trim().split(/\s+/u)) {
    if (raw === "") continue;
    if (raw === "_") out.push({ syl: "_", word, first: false, kind: "hold" });
    else if (raw === "~")
      out.push({ syl: "~", word, first: false, kind: "rest" });
    else {
      word += 1;
      raw
        .split("-")
        .filter(Boolean)
        .forEach((syl, index) =>
          out.push({ syl, word, first: index === 0, kind: "syl" }),
        );
    }
  }
  return out;
}

const VOWEL = /[aeiouàáâäèéêëìíîïòóôöùúûü]/u;
/** Consonant pairs that sound as one consonant and are never split. */
const SYL_DIGRAPHS = new Set(["th", "sh", "ch", "ph", "wh", "ng", "ck", "gh"]);
/** Digraphs that end a syllable (no English word starts with them). */
const SYL_CODA_ONLY = new Set(["ng", "ck", "gh", "x"]);
/** Consonant clusters a syllable may start with (maximal onset). */
const SYL_ONSETS = new Set(
  (
    "bl br cl cr dr fl fr gl gr pl pr sc sk sl sm sn sp st sw tr tw dw " +
    "thr shr chr phr phl spl spr str scr squ skr"
  ).split(" "),
);
/** Common words ending in a silent `e` that start compounds (some-thing). */
const SYL_SILENT_E_HEADS = (
  "some home life time love fire side care where there here more one " +
  "make lone like name game base wide grace face place space stone bone"
).split(" ");
/** Suffixes kept whole after a silent `e` (love-ly, care-ful). */
const SYL_SUFFIXES = ["ly", "ful", "less", "ness", "ment"];
/** Unstressed endings that close a short vowel before them (nev-er). */
const SYL_CLOSING_ENDINGS = new Set([
  "er",
  "en",
  "el",
  "et",
  "ed",
  "es",
  "est",
  "ing",
]);

/**
 * Syllables of a word typed without hyphens: a guess for English, which a
 * hyphen always overrides (`nev-er`). Each run of vowels (and `y` after a
 * consonant) is one syllable; a final silent `e` does not count, but a
 * consonant plus `le` is its own syllable (lit-tle, ta-ble). Consonant
 * pairs that sound as one (th sh ch ph wh ng ck gh) never split. Between
 * vowels a cluster gives the next syllable the longest onset English
 * allows (mon-ster, chil-dren); one consonant goes with the next vowel
 * (ba-by, to-night) unless the previous vowel is short before an
 * unstressed ending (nev-er, sing-ing). "something" gives some thing,
 * "forever" for ev er.
 */
function autoSyllabify(word: string): string[] {
  const w = word.toLowerCase();
  // Compounds and suffixes after a silent e: some-thing, love-ly.
  if (w.length >= 6) {
    for (const head of SYL_SILENT_E_HEADS)
      if (w.startsWith(head) && VOWEL.test(w.slice(head.length)))
        return [
          word.slice(0, head.length),
          ...autoSyllabify(word.slice(head.length)),
        ];
    for (const suffix of SYL_SUFFIXES) {
      const stem = w.slice(0, -suffix.length);
      if (
        w.endsWith(suffix) &&
        stem.length >= 3 &&
        stem.endsWith("e") &&
        !VOWEL.test(stem[stem.length - 2]!)
      )
        return [
          ...autoSyllabify(word.slice(0, stem.length)),
          word.slice(stem.length),
        ];
    }
  }
  // Letters into units: a vowel, a consonant, a digraph, or `qu`.
  type Unit = { at: number; text: string; vowel: boolean };
  const units: Unit[] = [];
  for (let i = 0; i < w.length;) {
    const pair = w.slice(i, i + 2);
    if (pair === "qu" || SYL_DIGRAPHS.has(pair)) {
      units.push({ at: i, text: pair, vowel: false });
      i += 2;
      continue;
    }
    const ch = w[i]!;
    const prev = units.at(-1);
    const vowel =
      VOWEL.test(ch) || (ch === "y" && prev !== undefined && !prev.vowel);
    units.push({ at: i, text: ch, vowel });
    i += 1;
  }
  // Vowel groups as [first unit, last unit].
  const groups: [number, number][] = [];
  for (let u = 0; u < units.length;) {
    if (units[u]!.vowel) {
      let v = u;
      while (v + 1 < units.length && units[v + 1]!.vowel) v += 1;
      groups.push([u, v]);
      u = v + 1;
    } else u += 1;
  }
  const lastUnit = units.length - 1;
  const finalLe =
    w.endsWith("le") &&
    units.length >= 3 &&
    units[lastUnit - 1]!.text === "l" &&
    !units[lastUnit - 2]!.vowel;
  const last = groups.at(-1);
  if (
    groups.length > 1 &&
    last &&
    last[0] === lastUnit &&
    last[1] === lastUnit &&
    units[lastUnit]!.text === "e" &&
    !units[lastUnit - 1]!.vowel &&
    !finalLe
  )
    groups.pop();
  if (groups.length <= 1) return [word];
  const cuts: number[] = [];
  for (let g = 1; g < groups.length; g += 1) {
    const prev = groups[g - 1]!;
    const next = groups[g]!;
    const cluster = units.slice(prev[1] + 1, next[0]);
    const n = cluster.length;
    const isLast = g === groups.length - 1;
    let onset: number; // units of the cluster that start the next syllable
    if (isLast && finalLe && n >= 2)
      onset = cluster[n - 2]!.text === "ck" ? 1 : 2;
    else if (n === 1) {
      const unit = cluster[0]!.text;
      const prevText = units
        .slice(prev[0], prev[1] + 1)
        .map((u) => u.text)
        .join("");
      const ending = w.slice(units[next[0]]!.at);
      const short = prevText.length === 1 && "eiou".includes(prevText);
      const closes =
        SYL_CODA_ONLY.has(unit) ||
        (short && isLast && SYL_CLOSING_ENDINGS.has(ending)) ||
        (unit === "r" && short && units[next[0]]!.text === "e");
      onset = closes ? 0 : 1;
    } else {
      onset = 1;
      for (let k = n - 1; k >= 2; k -= 1)
        if (
          SYL_ONSETS.has(
            cluster
              .slice(n - k)
              .map((u) => u.text)
              .join(""),
          )
        ) {
          onset = k;
          break;
        }
      if (SYL_CODA_ONLY.has(cluster[n - 1]!.text)) onset = 0;
    }
    const first = units[next[0] - onset]!;
    cuts.push(onset === 0 ? units[next[0]]!.at : first.at);
  }
  const out: string[] = [];
  let at = 0;
  for (const cut of cuts) {
    out.push(word.slice(at, cut));
    at = cut;
  }
  out.push(word.slice(at));
  return out.filter(Boolean);
}

/** What `assignLyrics` put on each note, and what did not fit. */
type LyricAssignment = Readonly<{
  /** Note id to its lyric (`_` holds); notes `~` skipped are absent. */
  lyrics: ReadonlyMap<string, string>;
  /** Syllables left over after the last note. */
  dropped: readonly string[];
  /** Words split automatically. */
  split: readonly string[];
}>;

/**
 * Lyrics onto `notes` in time order. Hyphens split syllables as typed;
 * when the text has fewer syllables than there are notes, words typed
 * whole are split by `autoSyllabify`, and any notes still left hold the
 * last syllable (melisma) instead of failing. Syllables past the last note
 * are reported in `dropped`. Notes sharing an onset take one token, on
 * the top note, with `_` on the others. Each lyric is cut to the 32-character limit.
 */
function assignLyrics(
  text: string,
  notes: readonly Readonly<{ id: string; startTick: number; pitch: number }>[],
): LyricAssignment {
  const sorted = [...notes].sort(
    (a, b) => a.startTick - b.startTick || b.pitch - a.pitch,
  );
  // Notes sharing an onset (a chord or a doubled note) take one token: the
  // top note carries it and the rest hold.
  const ordered: (typeof sorted)[number][] = [];
  const under = new Map<string, string[]>();
  for (const note of sorted) {
    const top = ordered.at(-1);
    if (top && top.startTick === note.startTick)
      under.get(top.id)!.push(note.id);
    else {
      ordered.push(note);
      under.set(note.id, []);
    }
  }
  let tokens = parseLyric(text);
  const split: string[] = [];
  if (tokens.length < ordered.length) {
    // Split every word typed whole; keep the split only if it still fits.
    const out: LyricToken[] = [];
    const words: string[] = [];
    for (const token of tokens) {
      const whole =
        token.kind === "syl" &&
        token.first &&
        !tokens.some((t) => t.word === token.word && !t.first);
      if (!whole) {
        out.push(token);
        continue;
      }
      const parts = autoSyllabify(token.syl);
      if (parts.length > 1) words.push(token.syl);
      parts.forEach((syl, index) =>
        out.push({ syl, word: token.word, first: index === 0, kind: "syl" }),
      );
    }
    if (out.length <= ordered.length) {
      tokens = out;
      split.push(...words);
    }
  }
  const lyrics = new Map<string, string>();
  const limit = LYRIC_LIMIT;
  ordered.forEach((note, index) => {
    const token = tokens[index];
    if (!token) {
      if (tokens.length > 0)
        for (const id of [note.id, ...under.get(note.id)!]) lyrics.set(id, "_");
      return;
    }
    if (token.kind === "rest") return;
    lyrics.set(
      note.id,
      token.kind === "hold" ? "_" : token.syl.slice(0, limit),
    );
    for (const id of under.get(note.id)!) lyrics.set(id, "_");
  });
  const dropped = tokens
    .slice(ordered.length)
    .filter((token) => token.kind === "syl")
    .map((token) => token.syl);
  return { lyrics, dropped, split };
}
// END lyrics

// BEGIN instrument words: generated from core/instruments.ts by core/sdk/sync-instruments.ts
/** What an instrument word stores on a track. */
type InstrumentWord = Readonly<{
  /** The `Track.instrument` value. */
  instrument: string;
  /** The optional Track field the engine reads (created with defaults). */
  field?: string;
  /** A preset of that engine to apply. */
  preset?: string;
  /** An insert-effect preset to apply with it (rig aliases). */
  fx?: string;
}>;

/** A word and what it means. */
type InstrumentWordRow = Readonly<{
  word: string;
  /**
   * Borrow the voice (instrument, field, preset) of this other word's row
   * when it exists; `instrument` is the fallback when it does not.
   */
  voice?: string;
}> &
  InstrumentWord;

/**
 * Words that keep their pre-0.6 meaning forever: they resolve to
 * themselves, whatever rows the lanes add.
 */
const LEGACY_WORDS: readonly string[] = Object.freeze([
  "piano",
  "pluck",
  "bass",
  "saw",
  "square",
  "triangle",
  "marimba",
  "wind",
  "cello",
  "contrabass",
  "ebass",
  "sitar",
  "organ",
  "strings",
  "bell",
  "keys",
  "lead",
]);

/** 0.6 instrument words; each lane appends its own block. */
const INSTRUMENT_WORDS: readonly InstrumentWordRow[] = Object.freeze([
  // strings (f06-strings): plucked presets of the string engine. Legacy
  // sitar/ebass keep today's voice (`string preset sitar` reaches the
  // engine), jangle is the rig alias (the guitar lane maps its 12string to the
  // preset; `string jangle` reaches it) and
  // upright is the keys lane's piano (doublebass reaches the preset).
  { word: "nylon", instrument: "string", field: "string", preset: "nylon" },
  { word: "steel", instrument: "string", field: "string", preset: "steel" },
  {
    word: "electric",
    instrument: "string",
    field: "string",
    preset: "electric",
  },
  { word: "slap", instrument: "string", field: "string", preset: "slap" },
  { word: "motown", instrument: "string", field: "string", preset: "motown" },
  { word: "tanpura", instrument: "string", field: "string", preset: "tanpura" },
  {
    word: "harpsichord",
    instrument: "string",
    field: "string",
    preset: "harpsichord",
  },
  { word: "lute", instrument: "string", field: "string", preset: "lute" },
  { word: "oud", instrument: "string", field: "string", preset: "oud" },
  { word: "setar", instrument: "string", field: "string", preset: "setar" },
  { word: "tar", instrument: "string", field: "string", preset: "tar" },
  { word: "santur", instrument: "string", field: "string", preset: "santur" },
  {
    word: "dulcimer",
    instrument: "string",
    field: "string",
    preset: "dulcimer",
  },
  { word: "koto", instrument: "string", field: "string", preset: "koto" },
  { word: "harp", instrument: "string", field: "string", preset: "harp" },
  { word: "banjo", instrument: "string", field: "string", preset: "banjo" },
  { word: "tres", instrument: "string", field: "string", preset: "tres" },
  {
    word: "requinto",
    instrument: "string",
    field: "string",
    preset: "requinto",
  },
  { word: "acoustic", instrument: "string", field: "string", preset: "steel" },
  { word: "classical", instrument: "string", field: "string", preset: "nylon" },
  {
    word: "bassguitar",
    instrument: "string",
    field: "string",
    preset: "ebass",
  },
  { word: "fender", instrument: "string", field: "string", preset: "ebass" },
  {
    word: "doublebass",
    instrument: "string",
    field: "string",
    preset: "upright",
  },
  {
    word: "cembalo",
    instrument: "string",
    field: "string",
    preset: "harpsichord",
  },
  {
    word: "hammered",
    instrument: "string",
    field: "string",
    preset: "dulcimer",
  },
  { word: "sehtar", instrument: "string", field: "string", preset: "setar" },
  // bowed (f061-bowed): bowed presets of the string engine. `cello`,
  // `contrabass` and `strings` stay legacy words (today's voice);
  // `bowed-cello`, `string cello` or `bowed cello` reach the engine.
  { word: "violin", instrument: "string", field: "string", preset: "violin" },
  { word: "viola", instrument: "string", field: "string", preset: "viola" },
  { word: "fiddle", instrument: "string", field: "string", preset: "fiddle" },
  { word: "erhu", instrument: "string", field: "string", preset: "erhu" },
  {
    word: "kamancheh",
    instrument: "string",
    field: "string",
    preset: "kamancheh",
  },
  {
    word: "kemence",
    instrument: "string",
    field: "string",
    preset: "kamancheh",
  },
  { word: "violins", instrument: "string", field: "string", preset: "violins" },
  { word: "violas", instrument: "string", field: "string", preset: "violas" },
  { word: "cellos", instrument: "string", field: "string", preset: "cellos" },
  {
    word: "contrabasses",
    instrument: "string",
    field: "string",
    preset: "contrabasses",
  },
  { word: "pizzicato", instrument: "string", field: "string", preset: "pizz" },
  { word: "tremolo", instrument: "string", field: "string", preset: "trem" },
  {
    word: "bowed-cello",
    instrument: "string",
    field: "string",
    preset: "cello",
  },
  // f06-rig: guitar track aliases, a guitar voice plus a whole rig. The
  // voice is the strings lane's `electric` row (jangle: its 12-string
  // `jangle` preset); the pluck only while that row is absent. Never `lead`
  // or `bass`.
  {
    word: "jangle",
    instrument: "string",
    field: "string",
    preset: "jangle",
    fx: "jangle",
  },
  { word: "punk", instrument: "pluck", voice: "electric", fx: "punk" },
  { word: "funk", instrument: "pluck", voice: "electric", fx: "funk" },
  { word: "ragged", instrument: "pluck", voice: "electric", fx: "ragged" },
  { word: "gtr-lead", instrument: "pluck", voice: "electric", fx: "lead" },
  { word: "gtr-metal", instrument: "pluck", voice: "electric", fx: "metal" },
  { word: "bachata", instrument: "pluck", voice: "electric", fx: "bachata" },
  // granular (f06-granular): the instrument and its texture presets. Each
  // starts from a built-in synth source, so nothing downloads.
  {
    word: "granular",
    instrument: "granular",
    field: "granular",
    preset: "cloud",
  },
  {
    word: "grains",
    instrument: "granular",
    field: "granular",
    preset: "cloud",
  },
  { word: "cloud", instrument: "granular", field: "granular", preset: "cloud" },
  {
    word: "sparkle",
    instrument: "granular",
    field: "granular",
    preset: "sparkle",
  },
  { word: "swarm", instrument: "granular", field: "granular", preset: "swarm" },
  {
    word: "microloop",
    instrument: "granular",
    field: "granular",
    preset: "microloop",
  },
  // keys (f06-piano): modelled pianos. `piano` stays legacy here; the typed
  // surfaces store a new `piano` as `grand` (core/keys.ts `pianoWrite`).
  { word: "grand", instrument: "grand", field: "keys", preset: "grand" },
  { word: "ballad", instrument: "grand", field: "keys", preset: "ballad" },
  { word: "upright", instrument: "upright", field: "keys", preset: "upright" },
  { word: "felt", instrument: "felt", field: "keys", preset: "felt" },
  { word: "lofi", instrument: "felt", field: "keys", preset: "lofi" },
  {
    word: "honkytonk",
    instrument: "honkytonk",
    field: "keys",
    preset: "honkytonk",
  },
  {
    word: "prepared",
    instrument: "prepared",
    field: "keys",
    preset: "prepared",
  },
  // keys (f061-organ): tonewheel, combo and pipe organs on the keys
  // engine. `organ` stays legacy (the sine voice).
  {
    word: "tonewheel",
    instrument: "tonewheel",
    field: "keys",
    preset: "tonewheel",
  },
  {
    word: "hammond",
    instrument: "tonewheel",
    field: "keys",
    preset: "tonewheel",
  },
  { word: "b3", instrument: "tonewheel", field: "keys", preset: "tonewheel" },
  { word: "gospel", instrument: "tonewheel", field: "keys", preset: "gospel" },
  {
    word: "jazzorgan",
    instrument: "tonewheel",
    field: "keys",
    preset: "jazzorgan",
  },
  { word: "combo", instrument: "combo", field: "keys", preset: "combo" },
  { word: "farfisa", instrument: "combo", field: "keys", preset: "combo" },
  { word: "vox", instrument: "combo", field: "keys", preset: "vox" },
  { word: "pipe", instrument: "pipe", field: "keys", preset: "pipe" },
  { word: "church", instrument: "pipe", field: "keys", preset: "pipe" },
  { word: "pipeorgan", instrument: "pipe", field: "keys", preset: "pipe" },
  { word: "churchorgan", instrument: "pipe", field: "keys", preset: "pipe" },
  { word: "flutes", instrument: "pipe", field: "keys", preset: "flutes" },
  { word: "cornet", instrument: "pipe", field: "keys", preset: "cornet" },
  { word: "reeds", instrument: "pipe", field: "keys", preset: "reeds" },
  { word: "celeste", instrument: "pipe", field: "keys", preset: "celeste" },
  // f06-modal: mallets and bells (core/resonators.ts). `marimba` is legacy;
  // `modal` alone gives the modal marimba.
  { word: "modal", instrument: "modal", field: "modal", preset: "marimba" },
  { word: "vibes", instrument: "modal", field: "modal", preset: "vibes" },
  { word: "vibraphone", instrument: "modal", field: "modal", preset: "vibes" },
  {
    word: "xylophone",
    instrument: "modal",
    field: "modal",
    preset: "xylophone",
  },
  { word: "glock", instrument: "modal", field: "modal", preset: "glock" },
  {
    word: "glockenspiel",
    instrument: "modal",
    field: "modal",
    preset: "glock",
  },
  { word: "celesta", instrument: "modal", field: "modal", preset: "celesta" },
  { word: "chimes", instrument: "modal", field: "modal", preset: "chimes" },
  { word: "tubular", instrument: "modal", field: "modal", preset: "chimes" },
  { word: "kalimba", instrument: "modal", field: "modal", preset: "kalimba" },
  {
    word: "thumbpiano",
    instrument: "modal",
    field: "modal",
    preset: "kalimba",
  },
  { word: "mbira", instrument: "modal", field: "modal", preset: "mbira" },
  { word: "steelpan", instrument: "modal", field: "modal", preset: "steelpan" },
  { word: "bowl", instrument: "modal", field: "modal", preset: "bowl" },
  { word: "gong", instrument: "modal", field: "modal", preset: "gong" },
  { word: "gongageng", instrument: "modal", field: "modal", preset: "gong" },
  { word: "timpani", instrument: "modal", field: "modal", preset: "timpani" },
  {
    word: "steeldrum",
    instrument: "modal",
    field: "modal",
    preset: "steelpan",
  },
  { word: "singingbowl", instrument: "modal", field: "modal", preset: "bowl" },
  {
    word: "kettledrum",
    instrument: "modal",
    field: "modal",
    preset: "timpani",
  },
  {
    word: "tubularbells",
    instrument: "modal",
    field: "modal",
    preset: "chimes",
  },
  // keys-electric (0.6.1): electric pianos and clavinet. `keys` stays legacy.
  { word: "epiano", instrument: "epiano", field: "keys", preset: "epiano" },
  { word: "rhodes", instrument: "epiano", field: "keys", preset: "epiano" },
  {
    word: "suitcase",
    instrument: "epiano",
    field: "keys",
    preset: "suitcase",
  },
  { word: "dyno", instrument: "epiano", field: "keys", preset: "dyno" },
  { word: "wurli", instrument: "wurli", field: "keys", preset: "wurli" },
  { word: "wurlitzer", instrument: "wurli", field: "keys", preset: "wurli" },
  { word: "clav", instrument: "clav", field: "keys", preset: "clav" },
  { word: "clavinet", instrument: "clav", field: "keys", preset: "clav" },
  { word: "funkclav", instrument: "clav", field: "keys", preset: "funkclav" },
  // f061-guitar: the shoegaze alias, an electric guitar voice plus the
  // shoegaze rig and its long wash.
  { word: "shoegaze", instrument: "pluck", voice: "electric", fx: "shoegaze" },
  // f061 integration: the two rig names that are free as instrument words
  // (glide and swell are taken by commands; reach them with `rig glide`).
  { word: "dreampop", instrument: "pluck", voice: "electric", fx: "dreampop" },
  { word: "ebow", instrument: "pluck", voice: "electric", fx: "ebow" },
  // f061-gamelan-winds: gamelan, small bells and frame drums.
  { word: "crotales", instrument: "modal", field: "modal", preset: "crotales" },
  { word: "crotale", instrument: "modal", field: "modal", preset: "crotales" },
  { word: "musicbox", instrument: "modal", field: "modal", preset: "musicbox" },
  { word: "toypiano", instrument: "modal", field: "modal", preset: "toypiano" },
  { word: "saron", instrument: "modal", field: "modal", preset: "saron" },
  { word: "demung", instrument: "modal", field: "modal", preset: "demung" },
  { word: "slenthem", instrument: "modal", field: "modal", preset: "slenthem" },
  { word: "gangsa", instrument: "modal", field: "modal", preset: "gangsa" },
  { word: "gender", instrument: "modal", field: "modal", preset: "gender" },
  { word: "bonang", instrument: "modal", field: "modal", preset: "bonang" },
  { word: "kenong", instrument: "modal", field: "modal", preset: "kenong" },
  { word: "kethuk", instrument: "modal", field: "modal", preset: "kethuk" },
  { word: "kempul", instrument: "modal", field: "modal", preset: "kempul" },
  { word: "daf", instrument: "modal", field: "modal", preset: "daf" },
  { word: "bodhran", instrument: "modal", field: "modal", preset: "bodhran" },
  { word: "framedrum", instrument: "modal", field: "modal", preset: "bodhran" },
  { word: "tabla", instrument: "modal", field: "modal", preset: "tabla" },
  // f061-gamelan-winds: blown waveguides (core/winds.ts). The legacy word
  // `wind` keeps its tone; these words and their aliases pick a wind preset.
  { word: "flute", instrument: "wind", field: "wind", preset: "flute" },
  { word: "recorder", instrument: "wind", field: "wind", preset: "recorder" },
  { word: "whistle", instrument: "wind", field: "wind", preset: "whistle" },
  { word: "ney", instrument: "wind", field: "wind", preset: "ney" },
  {
    word: "shakuhachi",
    instrument: "wind",
    field: "wind",
    preset: "shakuhachi",
  },
  { word: "panpipe", instrument: "wind", field: "wind", preset: "panpipe" },
  { word: "suling", instrument: "wind", field: "wind", preset: "suling" },
  { word: "bansuri", instrument: "wind", field: "wind", preset: "bansuri" },
  { word: "clarinet", instrument: "wind", field: "wind", preset: "clarinet" },
  {
    word: "bassclarinet",
    instrument: "wind",
    field: "wind",
    preset: "bassclarinet",
  },
  { word: "oboe", instrument: "wind", field: "wind", preset: "oboe" },
  { word: "bassoon", instrument: "wind", field: "wind", preset: "bassoon" },
  { word: "sax", instrument: "wind", field: "wind", preset: "sax" },
  { word: "altosax", instrument: "wind", field: "wind", preset: "altosax" },
  { word: "barisax", instrument: "wind", field: "wind", preset: "barisax" },
  { word: "trumpet", instrument: "wind", field: "wind", preset: "trumpet" },
  { word: "harmon", instrument: "wind", field: "wind", preset: "harmon" },
  { word: "plunger", instrument: "wind", field: "wind", preset: "plunger" },
  { word: "trombone", instrument: "wind", field: "wind", preset: "trombone" },
  { word: "tuba", instrument: "wind", field: "wind", preset: "tuba" },
  { word: "horn", instrument: "wind", field: "wind", preset: "horn" },
  { word: "tinwhistle", instrument: "wind", field: "wind", preset: "whistle" },
  {
    word: "pennywhistle",
    instrument: "wind",
    field: "wind",
    preset: "whistle",
  },
  { word: "nay", instrument: "wind", field: "wind", preset: "ney" },
  { word: "panflute", instrument: "wind", field: "wind", preset: "panpipe" },
  { word: "panpipes", instrument: "wind", field: "wind", preset: "panpipe" },
  { word: "saxophone", instrument: "wind", field: "wind", preset: "sax" },
  { word: "tenorsax", instrument: "wind", field: "wind", preset: "sax" },
  { word: "tenor", instrument: "wind", field: "wind", preset: "sax" },
  { word: "alto", instrument: "wind", field: "wind", preset: "altosax" },
  { word: "bari", instrument: "wind", field: "wind", preset: "barisax" },
  { word: "baritonesax", instrument: "wind", field: "wind", preset: "barisax" },
  { word: "frenchhorn", instrument: "wind", field: "wind", preset: "horn" },
  { word: "mutedtrumpet", instrument: "wind", field: "wind", preset: "harmon" },
  { word: "wahtrumpet", instrument: "wind", field: "wind", preset: "plunger" },
  // f07-sing: the built-in singing voice (core/sing.ts).
  { word: "sing", instrument: "sing", field: "sing" },
  { word: "aah", instrument: "sing", field: "sing", preset: "aah" },
  { word: "ooh", instrument: "sing", field: "sing", preset: "ooh" },
  { word: "choir", instrument: "sing", field: "sing", preset: "choir" },
  { word: "chorale", instrument: "sing", field: "sing", preset: "chorale" },
  { word: "khoomei", instrument: "sing", field: "sing", preset: "khoomei" },
  { word: "sygyt", instrument: "sing", field: "sing", preset: "sygyt" },
  { word: "kargyraa", instrument: "sing", field: "sing", preset: "kargyraa" },
  // f07-clips: a track of audio clips; its notes are guides.
  { word: "vocal", instrument: "vocal" },
  // f07-vocoder: the built-in carrier (core/vocoder.ts); set a source with
  // `/vocoder src <track>`.
  {
    word: "vocoder",
    instrument: "vocoder",
    field: "vocoder",
    preset: "classic",
  },
]);

/**
 * What an instrument word means: a legacy word is itself, a row word is its
 * row, anything else is undefined (callers keep the word as typed).
 */
function resolveInstrumentWord(word: string): InstrumentWord | undefined {
  if (LEGACY_WORDS.includes(word)) return Object.freeze({ instrument: word });
  const row = INSTRUMENT_WORDS.find((entry) => entry.word === word);
  if (!row) return undefined;
  const { word: _word, voice, ...meaning } = row;
  const borrowed =
    voice === undefined
      ? undefined
      : INSTRUMENT_WORDS.find((entry) => entry.word === voice && !entry.voice);
  if (!borrowed) return Object.freeze(meaning);
  return Object.freeze({
    instrument: borrowed.instrument,
    ...(borrowed.field === undefined ? {} : { field: borrowed.field }),
    ...(borrowed.preset === undefined ? {} : { preset: borrowed.preset }),
    ...(meaning.fx === undefined ? {} : { fx: meaning.fx }),
  });
}

/** The `Track.instrument` value a word stores (the word itself if unknown). */
function instrumentForWord(word: string): string {
  return resolveInstrumentWord(word)?.instrument ?? word;
}
// END instrument words

// BEGIN chord engine: generated from core/chords.ts by core/sdk/sync-chords.ts
// ---------------------------------------------------------------------------
// Vocabulary

/** The four Orchid chord-type buttons. */
const CHORD_TYPES = ["dim", "min", "maj", "sus"] as const;
type ChordType = (typeof CHORD_TYPES)[number];

/** The four Orchid extension buttons. */
const EXTENSIONS = ["6", "m7", "M7", "9"] as const;
type Extension = (typeof EXTENSIONS)[number];

/** Triad qualities: the four buttons plus dawg's two-button combinations. */
const QUALITIES = [
  "maj",
  "min",
  "dim",
  "sus4",
  "aug",
  "sus2",
  "5",
  "madd4",
  "mb6",
  "b6",
  "7#9",
  "b5",
] as const;
type Quality = (typeof QUALITIES)[number];

const QUALITY_INTERVALS: Readonly<Record<Quality, readonly number[]>> =
  Object.freeze({
    maj: [0, 4, 7],
    min: [0, 3, 7],
    dim: [0, 3, 6],
    sus4: [0, 5, 7],
    aug: [0, 4, 8],
    sus2: [0, 2, 7],
    "5": [0, 7],
    madd4: [0, 3, 5, 7],
    mb6: [0, 3, 7, 8],
    b6: [0, 4, 7, 8],
    "7#9": [0, 4, 7, 10, 15],
    b5: [0, 4, 6],
  });

/**
 * The extension button a secret chord is built with: it is part of the
 * chord, so `makeChord` drops it rather than stacking it again.
 */
const SECRET_EXTENSION: Readonly<Partial<Record<Quality, Extension>>> =
  Object.freeze({ mb6: "6", b6: "6", "7#9": "m7" });

const EXTENSION_INTERVAL: Readonly<Record<Extension, number>> = Object.freeze({
  "6": 9,
  m7: 10,
  M7: 11,
  "9": 14,
});

/**
 * Two chord-type buttons held together: Orchid's "secret chords" (manual
 * section 14.8). min+dim and maj+dim are listed with the 6 button and
 * maj+min with m7; dawg plays them without it too.
 */
const COMBINED_TYPES: Readonly<Record<string, Quality>> = Object.freeze({
  "dim+sus": "5",
  "maj+sus": "aug",
  "min+sus": "madd4",
  "dim+min": "mb6",
  "dim+maj": "b6",
  "maj+min": "7#9",
});

/** Quality for a set of held chord-type buttons, or undefined for none. */
function qualityOf(types: Iterable<ChordType>): Quality | undefined {
  const held = [...new Set(types)].sort();
  if (held.length === 0) return undefined;
  if (held.length === 1) return held[0] === "sus" ? "sus4" : held[0]!;
  return COMBINED_TYPES[held.slice(0, 2).join("+")] ?? "maj";
}

/** A chord: root pitch class, triad quality, extensions, optional bass. */
type Chord = Readonly<{
  /** 0..11, C = 0. */
  root: number;
  quality: Quality;
  extensions: readonly Extension[];
  /** Slash bass pitch class, when not the root. */
  bass?: number | undefined;
  /**
   * Upper tensions beyond the four extension buttons, as semitones above
   * the root (13 b9, 15 #9, 17 11, 18 #11, 21 13): only typed symbols
   * such as `C11`, `G13` or `A7b9` carry them (0.6.1).
   */
  tensions?: readonly number[] | undefined;
  /**
   * The root's letter, 0..6 for C..B, when a roman numeral spelled it:
   * `bVII` in C names Bb (not A#) and `vii` in F# names E# (not F).
   */
  letter?: number | undefined;
}>;

function makeChord(
  root: number,
  quality: Quality,
  extensions: Iterable<Extension> = [],
  bass?: number,
  tensions: readonly number[] = [],
): Chord {
  const held = new Set(extensions);
  const own = SECRET_EXTENSION[quality];
  const ext = EXTENSIONS.filter((value) => held.has(value) && value !== own);
  const pc = mod12(root);
  const slash = bass === undefined ? undefined : mod12(bass);
  return Object.freeze({
    root: pc,
    quality,
    extensions: Object.freeze(ext),
    ...(slash !== undefined && slash !== pc ? { bass: slash } : {}),
    ...(tensions.length > 0
      ? {
          tensions: Object.freeze([...new Set(tensions)].sort((a, b) => a - b)),
        }
      : {}),
  });
}

/** Semitones above the root, ascending and unique (9 sits at 14). */
function chordIntervals(chord: Chord): number[] {
  const set = new Set(QUALITY_INTERVALS[chord.quality]);
  for (const ext of chord.extensions) set.add(EXTENSION_INTERVAL[ext]);
  for (const step of chord.tensions ?? []) set.add(step);
  // m7 and M7 together keep both; 6 with m7 on a dim triad is the dim7's bb7.
  return [...set].sort((a, b) => a - b);
}

/** Pitch classes of the chord (bass excluded), root first. */
function chordPitchClasses(chord: Chord): number[] {
  return chordIntervals(chord).map((step) => mod12(chord.root + step));
}

// ---------------------------------------------------------------------------
// Names

const SHARP_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const FLAT_NAMES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];

/** Note name for a pitch class; flats when `flats`. */
function noteName(pc: number, flats = false): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)]!;
}

const LETTERS = "CDEFGAB";
const LETTER_PCS = [0, 2, 4, 5, 7, 9, 11] as const;

/**
 * `pc` spelled on letter `letter` (0..6, C..B) with one accidental at
 * most (E#, Cb, Bb); undefined when that would need a double accidental.
 */
function spellOnLetter(pc: number, letter: number): string | undefined {
  const l = ((Math.trunc(letter) % 7) + 7) % 7;
  const diff = ((mod12(pc) - LETTER_PCS[l]! + 18) % 12) - 6;
  if (Math.abs(diff) > 1) return undefined;
  return `${LETTERS[l]}${diff === 1 ? "#" : diff === -1 ? "b" : ""}`;
}

/** The letter (0..6, C..B) a key's tonic is spelled on. */
function tonicLetter(key: Key): number {
  return LETTERS.indexOf(noteName(key.tonic, keyUsesFlats(key))[0]!);
}

const SECRET_SUFFIX: Readonly<Partial<Record<Quality, string>>> = Object.freeze(
  { madd4: "m(add4)", mb6: "m(b6)", b6: "(b6)", "7#9": "7#9" },
);

/** Chord symbol suffix: `m7`, `maj9`, `7sus4`, `dim7`, `m7b5`, `6/9`. */
function chordSuffix(chord: Chord): string {
  if (chord.tensions?.length) {
    // A typed extended chord keeps the symbol it was typed as.
    const typed = TENSION_SUFFIXES.find(
      ([, quality, ext, tensions]) =>
        quality === chord.quality &&
        ext.join() === chord.extensions.join() &&
        tensions.join() === chord.tensions!.join(),
    );
    if (typed) return typed[0];
    const names = chord.tensions.map((step) => TENSION_NAMES[step] ?? step);
    return `${chordSuffix({ ...chord, tensions: undefined })}(${names.join(",")})`;
  }
  const ext = new Set(chord.extensions);
  const b7 = ext.has("m7");
  const M7 = ext.has("M7");
  const six = ext.has("6");
  const nine = ext.has("9");
  const q = chord.quality;
  const add = (base: string, parts: string[]) =>
    parts.length === 0 ? base : `${base}(${parts.join(",")})`;
  const extras: string[] = [];
  let base: string;
  const secret = SECRET_SUFFIX[q];
  if (secret !== undefined) {
    const names: Readonly<Record<Extension, string>> = {
      "6": "6",
      m7: "7",
      M7: "maj7",
      "9": "9",
    };
    const parts = chord.extensions.map((e) => names[e]);
    if (parts.length === 0 || !secret.endsWith(")")) return add(secret, parts);
    return `${secret.slice(0, -1)},${parts.join(",")})`;
  }
  if (q === "dim" && six && !b7 && !M7) {
    base = "dim7";
    if (nine) extras.push("add9");
    return add(base, extras);
  }
  if (b7 && M7) {
    // Both sevenths: name the dominant and list the major seventh.
    extras.push("maj7");
  }
  const seventh = b7 ? "7" : M7 ? "maj7" : "";
  if (seventh) {
    const ninth = nine ? (seventh === "7" ? "9" : "maj9") : seventh;
    switch (q) {
      case "maj":
        base = ninth;
        break;
      case "min":
        base = b7 ? (nine ? "m9" : "m7") : nine ? "m(maj9)" : "m(maj7)";
        break;
      case "dim":
        base = b7 ? (nine ? "m9b5" : "m7b5") : "dim(maj7)";
        if (!b7 && nine) extras.push("9");
        break;
      case "aug":
        base = b7 ? (nine ? "aug9" : "aug7") : "aug(maj7)";
        if (!b7 && nine) extras.push("9");
        break;
      case "sus4":
        base = `${ninth}sus4`;
        break;
      case "sus2":
        base = `${seventh}sus2`;
        if (nine) extras.push("9");
        break;
      case "5":
        base = `${seventh}(no3)`;
        if (nine) extras.push("9");
        break;
      case "b5":
        base = `${ninth}b5`;
        break;
      default:
        base = seventh; // secret qualities returned above
    }
    if (six) extras.push("13");
    return add(base, b7 && M7 ? extras : extras.filter((e) => e !== "maj7"));
  }
  const triad: Record<Quality, string> = {
    maj: "",
    min: "m",
    dim: "dim",
    sus4: "sus4",
    aug: "aug",
    sus2: "sus2",
    "5": "5",
    madd4: "m(add4)",
    mb6: "m(b6)",
    b6: "(b6)",
    "7#9": "7#9",
    b5: "(b5)",
  };
  base = triad[q];
  if (six && nine && (q === "maj" || q === "min")) return `${base}6/9`;
  if (six) {
    if (q === "maj" || q === "min") base = `${base}6`;
    else extras.push("6");
  }
  if (nine) {
    if (extras.length === 0 && (q === "maj" || q === "min"))
      return `${base}${q === "min" && !six ? "(add9)" : "add9"}`;
    extras.push("9");
  }
  return add(base, extras);
}

/** Chord symbol: `Cm7`, `F#dim`, `Bbmaj9`, `G7sus4`, `C/E`. */
function chordName(chord: Chord, flats = false): string {
  const slash =
    chord.bass === undefined ? "" : `/${noteName(chord.bass, flats)}`;
  const root =
    (chord.letter === undefined
      ? undefined
      : spellOnLetter(chord.root, chord.letter)) ?? noteName(chord.root, flats);
  return `${root}${chordSuffix(chord)}${slash}`;
}

/** Suffix → quality and extensions, longest first when parsing. */
const SUFFIXES: readonly (readonly [string, Quality, readonly Extension[]])[] =
  [
    ["", "maj", []],
    ["maj", "maj", []],
    ["M", "maj", []],
    ["m", "min", []],
    ["min", "min", []],
    ["-", "min", []],
    ["dim", "dim", []],
    ["°", "dim", []],
    ["o", "dim", []],
    ["aug", "aug", []],
    ["+", "aug", []],
    ["sus", "sus4", []],
    ["sus4", "sus4", []],
    ["sus2", "sus2", []],
    ["5", "5", []],
    ["6", "maj", ["6"]],
    ["m6", "min", ["6"]],
    ["6/9", "maj", ["6", "9"]],
    ["69", "maj", ["6", "9"]],
    ["m6/9", "min", ["6", "9"]],
    ["m69", "min", ["6", "9"]],
    ["7", "maj", ["m7"]],
    ["dom7", "maj", ["m7"]],
    ["maj7", "maj", ["M7"]],
    ["M7", "maj", ["M7"]],
    ["Δ", "maj", ["M7"]],
    ["Δ7", "maj", ["M7"]],
    ["m7", "min", ["m7"]],
    ["min7", "min", ["m7"]],
    ["-7", "min", ["m7"]],
    ["m(maj7)", "min", ["M7"]],
    ["mM7", "min", ["M7"]],
    ["m7b5", "dim", ["m7"]],
    ["ø", "dim", ["m7"]],
    ["ø7", "dim", ["m7"]],
    ["dim7", "dim", ["6"]],
    ["°7", "dim", ["6"]],
    ["o7", "dim", ["6"]],
    ["aug7", "aug", ["m7"]],
    ["+7", "aug", ["m7"]],
    ["9", "maj", ["m7", "9"]],
    ["maj9", "maj", ["M7", "9"]],
    ["M9", "maj", ["M7", "9"]],
    ["m9", "min", ["m7", "9"]],
    ["add9", "maj", ["9"]],
    ["madd9", "min", ["9"]],
    ["m(add9)", "min", ["9"]],
    ["7sus4", "sus4", ["m7"]],
    ["7sus", "sus4", ["m7"]],
    ["9sus4", "sus4", ["m7", "9"]],
    ["7sus2", "sus2", ["m7"]],
    ["maj7sus4", "sus4", ["M7"]],
    ["m(add4)", "madd4", []],
    ["madd4", "madd4", []],
    ["m(b6)", "mb6", []],
    ["mb6", "mb6", []],
    ["(b6)", "b6", []],
    ["addb6", "b6", []],
    ["7#9", "7#9", []],
    // 0.7: more spellings of the same chords.
    ["-maj7", "min", ["M7"]],
    ["mmaj7", "min", ["M7"]],
    ["mMaj7", "min", ["M7"]],
    ["m(maj7)", "min", ["M7"]],
    ["-Δ7", "min", ["M7"]],
    ["mΔ7", "min", ["M7"]],
    ["add2", "maj", ["9"]],
    ["2", "maj", ["9"]],
    ["madd2", "min", ["9"]],
    ["6add9", "maj", ["6", "9"]],
    ["m6add9", "min", ["6", "9"]],
    ["-6", "min", ["6"]],
    ["-9", "min", ["m7", "9"]],
    ["dom9", "maj", ["m7", "9"]],
    ["aug(maj7)", "aug", ["M7"]],
    ["augmaj7", "aug", ["M7"]],
    ["+maj7", "aug", ["M7"]],
    ["aug9", "aug", ["m7", "9"]],
    ["+9", "aug", ["m7", "9"]],
    ["m(maj9)", "min", ["M7", "9"]],
    ["mmaj9", "min", ["M7", "9"]],
    ["dim(maj7)", "dim", ["M7"]],
    ["7(no3)", "5", ["m7"]],
    ["maj7(no3)", "5", ["M7"]],
  ];

/** Typed upper-tension chords (0.6.1): suffix, quality, buttons, tensions. */
const TENSION_SUFFIXES: readonly (readonly [
  string,
  Quality,
  readonly Extension[],
  readonly number[],
])[] = [
  ["11", "maj", ["m7", "9"], [17]],
  ["m11", "min", ["m7", "9"], [17]],
  ["maj11", "maj", ["M7", "9"], [17]],
  ["add11", "maj", [], [17]],
  ["madd11", "min", [], [17]],
  ["13", "maj", ["m7", "9"], [21]],
  ["m13", "min", ["m7", "9"], [21]],
  ["maj13", "maj", ["M7", "9"], [21]],
  ["7b9", "maj", ["m7"], [13]],
  ["7#11", "maj", ["m7"], [18]],
  ["maj7#11", "maj", ["M7"], [18]],
  ["M7#11", "maj", ["M7"], [18]],
  ["7b13", "maj", ["m7"], [20]],
  ["13b9", "maj", ["m7"], [13, 21]],
];

const TENSION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  13: "b9",
  15: "#9",
  17: "11",
  18: "#11",
  20: "b13",
  21: "13",
});

const SUFFIX_TABLE = new Map<string, SuffixEntry>([
  ...SUFFIXES.map(
    ([suffix, quality, ext]) => [suffix, { quality, ext }] as const,
  ),
  ...TENSION_SUFFIXES.map(
    ([suffix, quality, ext, tensions]) =>
      [suffix, { quality, ext, tensions }] as const,
  ),
]);

const LETTER: Readonly<Record<string, number>> = Object.freeze({
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
});

/** Pitch class of a note name (`C`, `f#`, `Bb`), or undefined. */
function parsePitchClass(text: string): number | undefined {
  const match = text.trim().match(/^([a-gA-G])(#|b|♯|♭)?$/);
  if (!match) return undefined;
  const accidental =
    match[2] === "#" || match[2] === "♯"
      ? 1
      : match[2] === "b" || match[2] === "♭"
        ? -1
        : 0;
  return mod12(LETTER[match[1]!.toLowerCase()]! + accidental);
}

/** Alteration → upper tension (semitones above the root). */
const ALTERATION_TENSION: Readonly<Record<string, number>> = Object.freeze({
  b9: 13,
  "#9": 15,
  "11": 17,
  "#11": 18,
  "+11": 18,
  b13: 20,
  "13": 21,
});

const TOKEN = "b5|#5|\\+5|b9|#9|#11|\\+11|b13|alt|add9|add11|add13|11|13|9|6";
/** Bare alterations or parenthesized comma lists of them, in any order. */
const ALTERATIONS = new RegExp(
  `^(?:(?:${TOKEN})|\\((?:${TOKEN})(?:,(?:${TOKEN}))*\\))+$`,
);

type SuffixEntry = {
  quality: Quality;
  ext: readonly Extension[];
  tensions?: readonly number[];
};

/**
 * A suffix the table does not list, read as a listed base followed by
 * alterations, bare or in parentheses: `7#5`, `9#11`, `13#11`, `7b9b13`,
 * `9b5`, `maj7+5`, `7alt`, `7(b9,#9)`. A raised fifth makes the triad
 * augmented, a lowered one makes a major triad `b5` (a minor one
 * diminished); `alt` is b9, #9, #11 and b13 over a dominant seventh.
 */
function parseAlteredSuffix(suffix: string): SuffixEntry | undefined {
  for (let cut = suffix.length - 1; cut >= 0; cut -= 1) {
    const base = SUFFIX_TABLE.get(suffix.slice(0, cut));
    if (!base) continue;
    const raw = suffix.slice(cut);
    if (!ALTERATIONS.test(raw)) continue;
    const rest = raw.replace(/[(),]/g, "");
    const tokens = rest.match(
      /b5|#5|\+5|b9|#9|#11|\+11|b13|alt|add9|add11|add13|11|13|9|6/g,
    );
    if (!tokens || tokens.join("") !== rest) continue;
    let quality: Quality = base.quality;
    const ext = new Set<Extension>(base.ext);
    const tensions = new Set<number>(base.tensions ?? []);
    let ok = true;
    for (const token of tokens) {
      if (token === "#5" || token === "+5") {
        if (quality === "maj" || quality === "aug") quality = "aug";
        else ok = false;
      } else if (token === "b5") {
        if (quality === "maj" || quality === "b5") quality = "b5";
        else if (quality === "min" || quality === "dim") quality = "dim";
        else ok = false;
      } else if (token === "alt") {
        if (quality !== "maj") ok = false;
        ext.add("m7");
        for (const step of [13, 15, 18, 20]) tensions.add(step);
      } else if (token === "9" || token === "add9") ext.add("9");
      else if (token === "6") ext.add("6");
      else {
        const step = ALTERATION_TENSION[token.replace(/^add/, "")];
        if (step === undefined) ok = false;
        else tensions.add(step);
      }
    }
    if (!ok) continue;
    return {
      quality,
      ext: [...ext],
      tensions: [...tensions].sort((a, b) => a - b),
    };
  }
  return undefined;
}

/** Parse a chord symbol (`Cm7`, `F#dim`, `Bbmaj9`, `G7sus4`, `C/E`). */
function parseChord(symbol: string): Chord | undefined {
  if (typeof symbol !== "string" || symbol.length > 24) return undefined;
  const trimmed = symbol
    .trim()
    .replace(/6\/9$/, "69")
    .replace(/6\/9\//, "69/");
  const match = trimmed.match(/^([A-Ga-g])(#|b|♯|♭)?([^/]*)(?:\/(.+))?$/);
  if (!match) return undefined;
  const root = parsePitchClass(`${match[1]}${match[2] ?? ""}`);
  const entry =
    SUFFIX_TABLE.get(match[3] ?? "") ?? parseAlteredSuffix(match[3] ?? "");
  if (root === undefined || !entry) return undefined;
  let bass: number | undefined;
  if (match[4] !== undefined) {
    bass = parsePitchClass(match[4]);
    if (bass === undefined) return undefined;
  }
  return makeChord(root, entry.quality, entry.ext, bass, entry.tensions);
}

// ---------------------------------------------------------------------------
// Keys and modes

const MODES = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  "harmonic-minor": [0, 2, 3, 5, 7, 8, 11],
  "melodic-minor": [0, 2, 3, 5, 7, 9, 11],
  "phrygian-dominant": [0, 1, 4, 5, 7, 8, 10],
} as const);
type ModeName = keyof typeof MODES;
const MODE_NAMES = Object.keys(MODES) as ModeName[];

const MODE_ALIASES: Readonly<Record<string, ModeName>> = Object.freeze({
  "": "major",
  maj: "major",
  major: "major",
  ionian: "major",
  m: "minor",
  min: "minor",
  minor: "minor",
  aeolian: "minor",
  dorian: "dorian",
  phrygian: "phrygian",
  lydian: "lydian",
  mixolydian: "mixolydian",
  mixo: "mixolydian",
  locrian: "locrian",
  "harmonic-minor": "harmonic-minor",
  "harmonic minor": "harmonic-minor",
  harmonic: "harmonic-minor",
  "melodic-minor": "melodic-minor",
  "melodic minor": "melodic-minor",
  melodic: "melodic-minor",
  "jazz minor": "melodic-minor",
  "phrygian-dominant": "phrygian-dominant",
  "phrygian dominant": "phrygian-dominant",
  freygish: "phrygian-dominant",
  spanish: "phrygian-dominant",
  ajam: "major",
  mahur: "major",
  bilawal: "major",
});

type ScaleFamily =
  | "pentatonic"
  | "blues"
  | "maqam"
  | "dastgah"
  | "raga"
  | "messiaen"
  | "chromatic"
  | "overtone"
  | "quarter-tone";

/**
 * Scales beyond the chord modes, for keys such as `D bayati`, `C yaman` or
 * `C messiaen-3`. `steps` are semitones above the tonic and may be
 * fractional (a quarter tone is .5); `mode` is the seven-note mode the
 * chord engine harmonizes with (the closest one; see DAWG.md). A raga's
 * `intonation` is each step's traditional just pitch in cents (shruti
 * offsets), which its named tuning applies (`tuning yaman`): Pythagorean
 * ati-komal re and dha for Bhairavi, Bhairav, Purvi and Todi, the high
 * tivra ma (729/512) for Yaman, 9/5 komal ni for Kafi, after Daniélou and
 * Jairazbhoy. Maqam and dastgah quarter tones follow the 24-tone convention;
 * Segah and Sikah start on a half-flat note, so their tonic is the key.
 */
type ScaleInfo = Readonly<{
  steps: readonly number[];
  mode: ModeName;
  family: ScaleFamily;
  intonation?: readonly number[];
  aliases?: readonly string[];
}>;

const SCALES = Object.freeze({
  "major-pentatonic": {
    steps: [0, 2, 4, 7, 9],
    mode: "major",
    family: "pentatonic",
    aliases: ["pentatonic", "major pentatonic", "pent"],
  },
  "minor-pentatonic": {
    steps: [0, 3, 5, 7, 10],
    mode: "minor",
    family: "pentatonic",
    aliases: ["minor pentatonic", "m pentatonic", "min pentatonic"],
  },
  blues: {
    steps: [0, 3, 5, 6, 7, 10],
    mode: "minor",
    family: "blues",
    aliases: ["minor blues"],
  },
  "major-blues": {
    steps: [0, 2, 3, 4, 7, 9],
    mode: "major",
    family: "blues",
    aliases: ["major blues"],
  },
  "yonanuki-minor": {
    steps: [0, 2, 3, 7, 8],
    mode: "minor",
    family: "pentatonic",
    aliases: ["yonanuki", "yonanuki minor", "enka minor"],
  },
  hijaz: {
    steps: [0, 1, 4, 5, 7, 8, 10],
    mode: "phrygian-dominant",
    family: "maqam",
  },
  bayati: {
    steps: [0, 1.5, 3, 5, 7, 8, 10],
    mode: "phrygian",
    family: "maqam",
  },
  rast: { steps: [0, 2, 3.5, 5, 7, 9, 10.5], mode: "major", family: "maqam" },
  saba: { steps: [0, 1.5, 3, 4, 7, 8, 10], mode: "phrygian", family: "maqam" },
  kurd: { steps: [0, 1, 3, 5, 7, 8, 10], mode: "phrygian", family: "maqam" },
  nahawand: {
    steps: [0, 2, 3, 5, 7, 8, 11],
    mode: "harmonic-minor",
    family: "maqam",
  },
  sikah: {
    steps: [0, 1.5, 3.5, 5.5, 7, 8.5, 10.5],
    mode: "phrygian",
    family: "maqam",
    aliases: ["sika"],
  },
  huzam: {
    steps: [0, 1.5, 3.5, 4.5, 7.5, 8.5, 10.5],
    mode: "phrygian",
    family: "maqam",
    aliases: ["houzam"],
  },
  nikriz: { steps: [0, 2, 3, 6, 7, 9, 10], mode: "dorian", family: "maqam" },
  shur: {
    steps: [0, 1.5, 3, 5, 7, 8, 10],
    mode: "phrygian",
    family: "dastgah",
  },
  homayoun: {
    steps: [0, 1.5, 4, 5, 7, 8, 10],
    mode: "phrygian-dominant",
    family: "dastgah",
    aliases: ["homayun"],
  },
  chahargah: {
    steps: [0, 1.5, 4, 5, 7, 8.5, 11],
    mode: "phrygian-dominant",
    family: "dastgah",
    aliases: ["chahar-gah"],
  },
  segah: {
    steps: [0, 1.5, 3.5, 5, 6.5, 8.5, 10.5],
    mode: "phrygian",
    family: "dastgah",
    aliases: ["sehgah", "se-gah"],
  },
  nava: {
    steps: [0, 2, 3.5, 5, 7, 8, 10],
    mode: "minor",
    family: "dastgah",
  },
  yaman: {
    steps: [0, 2, 4, 6, 7, 9, 11],
    mode: "lydian",
    family: "raga",
    intonation: [0, 203.91, 386.31, 611.73, 701.96, 884.36, 1088.27],
    aliases: ["kalyan", "yaman kalyan"],
  },
  bhairav: {
    steps: [0, 1, 4, 5, 7, 8, 11],
    mode: "phrygian-dominant",
    family: "raga",
    intonation: [0, 90.22, 386.31, 498.04, 701.96, 792.18, 1088.27],
  },
  kafi: {
    steps: [0, 2, 3, 5, 7, 9, 10],
    mode: "dorian",
    family: "raga",
    intonation: [0, 203.91, 315.64, 498.04, 701.96, 884.36, 1017.6],
  },
  bhairavi: {
    steps: [0, 1, 3, 5, 7, 8, 10],
    mode: "phrygian",
    family: "raga",
    intonation: [0, 90.22, 294.13, 498.04, 701.96, 792.18, 996.09],
  },
  asavari: {
    steps: [0, 2, 3, 5, 7, 8, 10],
    mode: "minor",
    family: "raga",
    intonation: [0, 203.91, 315.64, 498.04, 701.96, 813.69, 996.09],
  },
  khamaj: {
    steps: [0, 2, 4, 5, 7, 9, 10],
    mode: "mixolydian",
    family: "raga",
    intonation: [0, 203.91, 386.31, 498.04, 701.96, 884.36, 996.09],
  },
  todi: {
    steps: [0, 1, 3, 6, 7, 8, 11],
    mode: "phrygian",
    family: "raga",
    intonation: [0, 95, 294, 606, 702, 792, 1107],
  },
  purvi: {
    steps: [0, 1, 4, 6, 7, 8, 11],
    mode: "phrygian-dominant",
    family: "raga",
    intonation: [0, 90.22, 386.31, 590.22, 701.96, 792.18, 1088.27],
  },
  marwa: {
    steps: [0, 1, 4, 6, 9, 11],
    mode: "lydian",
    family: "raga",
    intonation: [0, 111.73, 386.31, 590.22, 884.36, 1088.27],
  },
  darbari: {
    steps: [0, 2, 3, 5, 7, 8, 10],
    mode: "minor",
    family: "raga",
    intonation: [0, 203.91, 294.13, 498.04, 701.96, 792.18, 996.09],
    aliases: ["darbari kanada"],
  },
  malkauns: {
    steps: [0, 3, 5, 8, 10],
    mode: "minor",
    family: "raga",
    intonation: [0, 315.64, 498.04, 813.69, 996.09],
  },
  bhupali: {
    steps: [0, 2, 4, 7, 9],
    mode: "major",
    family: "raga",
    intonation: [0, 203.91, 386.31, 701.96, 884.36],
  },
  durga: {
    steps: [0, 2, 5, 7, 9],
    mode: "major",
    family: "raga",
    intonation: [0, 203.91, 498.04, 701.96, 884.36],
  },
  "messiaen-1": {
    steps: [0, 2, 4, 6, 8, 10],
    mode: "lydian",
    family: "messiaen",
    aliases: ["whole-tone", "whole tone", "wholetone"],
  },
  "messiaen-2": {
    steps: [0, 1, 3, 4, 6, 7, 9, 10],
    mode: "mixolydian",
    family: "messiaen",
    aliases: ["octatonic", "diminished", "half-whole"],
  },
  "messiaen-3": {
    steps: [0, 2, 3, 4, 6, 7, 8, 10, 11],
    mode: "minor",
    family: "messiaen",
  },
  "messiaen-4": {
    steps: [0, 1, 2, 5, 6, 7, 8, 11],
    mode: "harmonic-minor",
    family: "messiaen",
  },
  "messiaen-5": {
    steps: [0, 1, 5, 6, 7, 11],
    mode: "lydian",
    family: "messiaen",
  },
  "messiaen-6": {
    steps: [0, 2, 4, 5, 6, 8, 10, 11],
    mode: "major",
    family: "messiaen",
  },
  "messiaen-7": {
    steps: [0, 1, 2, 3, 5, 6, 7, 8, 9, 11],
    mode: "harmonic-minor",
    family: "messiaen",
  },
  // All twelve pitch classes: the field of free atonality and the row.
  chromatic: {
    steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    mode: "minor",
    family: "chromatic",
    aliases: ["twelve-tone", "aggregate"],
  },
  // Partials 8 to 15 of the harmonic series over the tonic (Grisey,
  // Murail): the acoustic scale with the 11th and 13th partials' and the
  // 7th's just pitches, which its named tuning applies.
  "harmonic-series": {
    steps: [0, 2, 4, 6, 7, 9, 10, 11],
    mode: "mixolydian",
    family: "overtone",
    intonation: [0, 204, 386, 551, 702, 841, 969, 1088],
    aliases: ["overtone", "overtone-scale", "partials"],
  },
  // Each tempered degree of the major scale beside its quarter-tone
  // shadow (Haba, Wyschnegradsky): neutral 2nd, 3rd, 6th and 7th and a
  // quarter-sharp 4th, sounded as note cents over twelve-tone keys.
  "quarter-tone": {
    steps: [0, 1.5, 2, 3.5, 4, 5, 5.5, 7, 8.5, 9, 10.5],
    mode: "major",
    family: "quarter-tone",
    aliases: ["quartertone", "24-tone"],
  },
} as const satisfies Record<string, ScaleInfo>);
type ScaleName = keyof typeof SCALES;
const SCALE_NAMES = Object.keys(SCALES) as ScaleName[];

const SCALE_ALIASES: Readonly<Record<string, ScaleName>> = (() => {
  const aliases: Record<string, ScaleName> = {};
  for (const name of SCALE_NAMES) {
    const info: ScaleInfo = SCALES[name];
    aliases[name] = name;
    aliases[name.replace(/-/g, " ")] = name;
    for (const alias of info.aliases ?? []) aliases[alias] = name;
  }
  return Object.freeze(aliases);
})();

/** The library scale named `text` (case and `-`/space insensitive). */
function scaleNamed(text: string): ScaleName | undefined {
  const word = text.trim().toLowerCase().replace(/\s+/g, " ");
  return SCALE_ALIASES[word] ?? SCALE_ALIASES[word.replace(/ /g, "-")];
}

/**
 * A key: a tonic and the seven-note `mode` the chord engine uses, plus the
 * library `scale` when the key names one (`D bayati`, `C yaman`).
 */
type Key = Readonly<{
  tonic: number;
  mode: ModeName;
  scale?: ScaleName;
}>;

/**
 * Parse a key: `C`, `c major`, `Am`, `a minor`, `F# dorian`, `Eb mixo`,
 * `D bayati`, `C messiaen-3`. Accepts the `<note> <mode>` form
 * `core/key.ts` writes.
 */
function parseKey(text: string | null | undefined): Key | undefined {
  if (typeof text !== "string" || text.length > 40) return undefined;
  const match = text
    .trim()
    .match(/^([a-gA-G])(#|b|♯|♭)?\s*(m(?![a-z])|[a-zA-Z][a-zA-Z0-9 -]*)?$/);
  if (!match) return undefined;
  const tonic = parsePitchClass(`${match[1]}${match[2] ?? ""}`);
  if (tonic === undefined) return undefined;
  const word = (match[3] ?? "").trim();
  const mode = MODE_ALIASES[word === "m" ? "m" : word.toLowerCase()];
  if (mode !== undefined) return Object.freeze({ tonic, mode });
  const scale = scaleNamed(word);
  if (scale === undefined) return undefined;
  return Object.freeze({ tonic, mode: SCALES[scale].mode, scale });
}

/**
 * Steps of the key's whole scale in semitones above the tonic (fractional
 * for quarter tones): the library scale when the key names one, else the
 * mode.
 */
function scaleSteps(key: Key): number[] {
  return [...(key.scale ? SCALES[key.scale].steps : MODES[key.mode])];
}

/** True when names in the key read better with flats (F, Bb, Eb, d minor…). */
function keyUsesFlats(key: Key): boolean {
  // The parent major scale's tonic decides: F, Bb, Eb, Ab, Db read in flats.
  const parentOffset: Record<ModeName, number> = {
    major: 0,
    dorian: 2,
    phrygian: 4,
    lydian: 5,
    mixolydian: 7,
    minor: 9,
    locrian: 11,
    "harmonic-minor": 9,
    "melodic-minor": 9,
    "phrygian-dominant": 4,
  };
  const parent = mod12(key.tonic - parentOffset[key.mode]);
  return [5, 10, 3, 8, 1].includes(parent);
}

/** `C major`, `F# dorian`, `Bb minor`. */
function keyName(key: Key): string {
  return `${noteName(key.tonic, keyUsesFlats(key))} ${key.scale ?? key.mode}`;
}

/** Pitch classes of the key's scale, tonic first. */
function scaleOf(key: Key): number[] {
  return MODES[key.mode].map((step) => mod12(key.tonic + step));
}

function qualityFromThirds(third: number, fifth: number): Quality {
  if (third === 4 && fifth === 7) return "maj";
  if (third === 3 && fifth === 7) return "min";
  if (third === 3 && fifth === 6) return "dim";
  if (third === 4 && fifth === 8) return "aug";
  return "maj";
}

/**
 * The diatonic chord on scale degree `degree` (0-based): stacked thirds
 * from the scale. `sevenths` adds the scale's seventh above the root.
 */
function diatonicChord(key: Key, degree: number, sevenths = false): Chord {
  const scale = MODES[key.mode];
  const at = (index: number) => {
    const octave = Math.floor(index / 7);
    return scale[((index % 7) + 7) % 7]! + 12 * octave;
  };
  const d = ((degree % 7) + 7) % 7;
  const root = at(d);
  const third = at(d + 2) - root;
  const fifth = at(d + 4) - root;
  const quality = qualityFromThirds(third, fifth);
  const ext: Extension[] = [];
  if (sevenths) {
    const seventh = at(d + 6) - root;
    if (quality === "dim" && seventh === 9) ext.push("6");
    else ext.push(seventh === 11 ? "M7" : "m7");
  }
  return makeChord(key.tonic + root, quality, ext);
}

/** The seven diatonic chords of the key. */
function diatonicChords(key: Key, sevenths = false): Chord[] {
  return Array.from({ length: 7 }, (_, degree) =>
    diatonicChord(key, degree, sevenths),
  );
}

/** Scale degree (0-based) of a pitch class, or undefined when not in key. */
function degreeOf(key: Key, pc: number): number | undefined {
  const index = scaleOf(key).indexOf(mod12(pc));
  return index < 0 ? undefined : index;
}

/**
 * Orchid Key mode: the chord a key plays. In-scale pitches play their
 * diatonic chord (C major: D → Dm). Out-of-scale pitches are dawg's
 * choice: the chord borrowed from the parallel major/minor when that
 * scale contains the pitch (C major: Eb → Eb, Ab → Ab, Bb → Bb), otherwise
 * a passing diminished seventh (C major: C# → C#dim7, F# → F#dim7).
 * `types` and `extensions` are the held Orchid buttons: a type overrides
 * the quality ("unorthodox" choices), extensions add on top.
 */
function keyModeChord(
  key: Key,
  pitch: number,
  options: Readonly<{
    types?: Iterable<ChordType>;
    extensions?: Iterable<Extension>;
    sevenths?: boolean;
  }> = {},
): Chord {
  const pc = mod12(pitch);
  const extensions = [...(options.extensions ?? [])];
  const forced = qualityOf(options.types ?? []);
  const degree = degreeOf(key, pc);
  let base: Chord;
  if (degree !== undefined) base = diatonicChord(key, degree, options.sevenths);
  else {
    const parallel: Key = {
      tonic: key.tonic,
      mode: MODES[key.mode][2] === 4 ? "minor" : "major",
    };
    const borrowed = degreeOf(parallel, pc);
    base =
      borrowed !== undefined
        ? diatonicChord(parallel, borrowed, options.sevenths)
        : makeChord(pc, "dim", ["6"]);
  }
  if (forced === undefined && extensions.length === 0) return base;
  const quality = forced ?? base.quality;
  const ext =
    forced === undefined ? [...base.extensions, ...extensions] : extensions;
  return makeChord(pc, quality, ext);
}

/** Manual (non-key) mode: the held buttons on the pressed root. */
function manualChord(
  pitch: number,
  types: Iterable<ChordType>,
  extensions: Iterable<Extension> = [],
): Chord | undefined {
  const quality = qualityOf(types);
  const ext = [...extensions];
  if (quality === undefined && ext.length === 0) return undefined;
  return makeChord(pitch, quality ?? "maj", ext);
}

// ---------------------------------------------------------------------------
// Roman numerals

const NUMERALS = ["i", "ii", "iii", "iv", "v", "vi", "vii"];

/** Roman numeral for a chord in a key (`ii`, `V7`, `bVII`, `vii°`). */
function romanOf(key: Key, chord: Chord): string {
  const scale = scaleOf(key);
  let degree = scale.indexOf(chord.root);
  let accidental = "";
  if (degree < 0) {
    // Name chromatic roots against the major scale: bIII, #iv°.
    const major = MODES.major.map((step) => mod12(key.tonic + step));
    const natural = major.indexOf(chord.root);
    const flat = major.indexOf(mod12(chord.root + 1));
    const sharp = major.indexOf(mod12(chord.root - 1));
    if (natural >= 0) {
      // A major-scale note the mode alters: ♮II in Phrygian.
      degree = natural;
      accidental = "♮";
    } else if (flat >= 0) {
      degree = flat;
      accidental = "b";
    } else {
      degree = Math.max(0, sharp);
      accidental = "#";
    }
  }
  const lower =
    chord.quality === "min" ||
    chord.quality === "dim" ||
    chord.quality === "madd4" ||
    chord.quality === "mb6";
  const numeral = NUMERALS[degree]!;
  const body = lower ? numeral : numeral.toUpperCase();
  const ext = new Set(chord.extensions);
  let mark = "";
  if (chord.quality === "dim") mark = ext.has("m7") ? "ø" : "°";
  else if (chord.quality === "aug") mark = "+";
  const seventh =
    ext.has("6") && chord.quality === "dim"
      ? "7"
      : ext.has("m7")
        ? "7"
        : ext.has("M7")
          ? "maj7"
          : "";
  // The short numeral when it reads back as this chord; else the chord's
  // own suffix in brackets (`I[7]`, `i[m6]`, `V[7#9]`), which is exact.
  const plain = `${accidental}${body}${mark}${seventh}`;
  const bare = makeChord(
    chord.root,
    chord.quality,
    chord.extensions,
    undefined,
    chord.tensions,
  );
  for (const candidate of [
    plain,
    `${accidental}${body}${mark}${seventh === "7" ? "dom7" : seventh}`,
  ])
    if (sameChord(parseRoman(key, candidate), bare)) return candidate;
  return `${accidental}${body}[${chordSuffix(bare)}]`;
}

function sameChord(a: Chord | undefined, b: Chord): boolean {
  return (
    a !== undefined &&
    a.root === b.root &&
    a.quality === b.quality &&
    a.bass === b.bass &&
    a.extensions.join() === b.extensions.join() &&
    (a.tensions ?? []).join() === (b.tensions ?? []).join()
  );
}

/**
 * Parse a roman numeral in a key: `I`, `ii`, `V7`, `vii°`, `bVII`, `iv`,
 * `IVmaj7`, `ii7`, `V/V` (secondary dominant), `Vsus4`.
 *
 * A numeral whose case matches the diatonic chord (lowercase for minor or
 * diminished) takes the diatonic quality, so `vii` is diminished in major;
 * a mismatched case is explicit (`iv` in major is minor, `IV` in minor is
 * major). `7` adds the diatonic seventh; `maj7`/`M7` and `dom7` are exact.
 */
function parseRoman(key: Key, text: string): Chord | undefined {
  return romanIn(key, text, tonicLetter(key));
}

/** `parseRoman` with the tonic spelled on `tonic` (0..6, C..B). */
function romanIn(key: Key, text: string, tonic: number): Chord | undefined {
  if (typeof text !== "string" || text.length > 32) return undefined;
  const trimmed = text.trim();
  const exact = trimmed.match(
    /^(b|#|♭|♯|♮)?(vii|vi|v|iv|iii|ii|i|VII|VI|V|IV|III|II|I)\[([^\]]*)\]$/,
  );
  if (exact) {
    // `I[7]`: the numeral names the root, the bracket is a chord suffix.
    const degree = NUMERALS.indexOf(exact[2]!.toLowerCase());
    const shift =
      exact[1] === "b" || exact[1] === "♭"
        ? -1
        : exact[1] === "♮" || !exact[1]
          ? 0
          : 1;
    const root = !exact[1]
      ? scaleOf(key)[degree]
      : mod12(key.tonic + MODES.major[degree]! + shift);
    if (root === undefined) return undefined;
    const letter = (tonic + degree) % 7;
    const chord = parseChord(
      `${spellOnLetter(root, letter) ?? noteName(root)}${exact[3]!}`,
    );
    return chord && Object.freeze({ ...chord, letter });
  }
  const slash = trimmed.match(/^(.+)\/(.+)$/);
  if (slash) {
    // V/x: the chord built on the degree of x in the key (secondary function).
    const target = romanIn(key, slash[2]!, tonic);
    if (!target) return undefined;
    return romanIn(
      { tonic: target.root, mode: "major" },
      slash[1]!,
      target.letter ?? tonic,
    );
  }
  const match = trimmed.match(
    /^(b|#|♭|♯|♮)?(vii|vi|v|iv|iii|ii|i|VII|VI|V|IV|III|II|I)(°|o|ø|\+)?(maj7|M7|dom7|7|9|maj9|6|sus4|sus2|sus|add9)?$/,
  );
  if (!match) return undefined;
  const accidental =
    match[1] === "b" || match[1] === "♭"
      ? -1
      : match[1] === "#" || match[1] === "♯"
        ? 1
        : 0;
  const numeral = match[2]!;
  const lower = numeral === numeral.toLowerCase();
  const degree = NUMERALS.indexOf(numeral.toLowerCase());
  const mark = match[3];
  const suffix = match[4] ?? "";
  const root = !match[1]
    ? scaleOf(key)[degree]!
    : mod12(key.tonic + MODES.major[degree]! + accidental);
  const inKey = degreeOf(key, root);
  const triad = inKey === undefined ? undefined : diatonicChord(key, inKey);
  const seventh =
    inKey === undefined ? undefined : diatonicChord(key, inKey, true);
  const diatonicLower =
    triad !== undefined && (triad.quality === "min" || triad.quality === "dim");
  const matches = triad !== undefined && diatonicLower === lower;
  let quality: Quality;
  if (mark === "°" || mark === "o" || mark === "ø") quality = "dim";
  else if (mark === "+") quality = "aug";
  else if (matches) quality = triad.quality;
  else quality = lower ? "min" : "maj";
  // The diatonic seventh when the triad is the diatonic one, else b7.
  const diatonicSeventh = (): Extension[] =>
    mark === "ø"
      ? ["m7"]
      : seventh && seventh.quality === quality
        ? [...seventh.extensions]
        : quality === "dim" && mark !== undefined
          ? ["6"]
          : ["m7"];
  let ext: Extension[] = mark === "ø" ? ["m7"] : [];
  switch (suffix) {
    case "7":
      ext = diatonicSeventh();
      break;
    case "dom7":
      ext = ["m7"];
      break;
    case "maj7":
    case "M7":
      ext = ["M7"];
      break;
    case "9":
      ext = [...diatonicSeventh(), "9"];
      break;
    case "maj9":
      ext = ["M7", "9"];
      break;
    case "6":
      ext = ["6"];
      break;
    case "add9":
      ext = ["9"];
      break;
    case "sus4":
    case "sus":
      quality = "sus4";
      break;
    case "sus2":
      quality = "sus2";
      break;
  }
  return Object.freeze({
    ...makeChord(root, quality, ext),
    letter: (tonic + degree) % 7,
  });
}

// ---------------------------------------------------------------------------
// Voicing

/** Default chord register: a voicing is kept inside [low, high]. */
const VOICING_RANGE = Object.freeze({ low: 48, high: 79 });
/** Voicing dial: Orchid-style rotation steps, -12..12. */
const MAX_VOICING_STEP = 12;
const SPREADS = ["close", "open", "wide"] as const;
type Spread = (typeof SPREADS)[number];

type VoicingOptions = Readonly<{
  /** Rotation steps from root position (Orchid's voicing dial). */
  inversion?: number;
  spread?: Spread;
  /** Voice-lead from this voicing (minimal movement). */
  previous?: readonly number[] | undefined;
  /** Root-position anchor: the root lands at or above this pitch. */
  anchor?: number;
  low?: number;
  high?: number;
}>;

/**
 * Root position of a chord with its root at or above `anchor`, then the
 * Orchid voicing dial: each positive step moves the lowest note up an
 * octave, each negative step the highest note down.
 */
function rotate(pitches: readonly number[], steps: number): number[] {
  const notes = [...pitches].sort((a, b) => a - b);
  if (notes.length === 0) return notes;
  for (let i = 0; i < Math.abs(Math.trunc(steps)); i += 1) {
    if (steps > 0) notes.push(notes.shift()! + 12);
    else notes.unshift(notes.pop()! - 12);
  }
  return notes;
}

function rootPosition(chord: Chord, anchor = 60): number[] {
  const rootPitch = anchor + mod12(chord.root - anchor);
  const steps = chordIntervals(chord);
  // A natural 11 over a major 3rd and a 7th is the avoid-note clash (E
  // under F a minor 9th up in C11), so the voicing drops the 3rd: C11 is
  // C G Bb D F, the sus voicing; C13 already leaves the 11 out.
  const clash =
    steps.includes(4) &&
    steps.includes(17) &&
    (steps.includes(10) || steps.includes(11));
  return steps
    .filter((step) => !(clash && step === 4))
    .map((step) => rootPitch + step);
}

/** Open voicings: `open` drops the second voice from the top an octave
 * (drop 2); `wide` also drops the fourth from the top (drop 2+4). */
function applySpread(pitches: readonly number[], spread: Spread): number[] {
  const notes = [...pitches].sort((a, b) => a - b);
  if (spread === "close" || notes.length < 3) return notes;
  const n = notes.length;
  notes[n - 2] = notes[n - 2]! - 12;
  if (spread === "wide" && n >= 4) notes[n - 4] = notes[n - 4]! - 12;
  return notes.sort((a, b) => a - b);
}

/**
 * Movement between two voicings: each voice of the new chord pays its
 * distance to the nearest previous voice and vice versa, so voicings of
 * different sizes compare and common tones are free.
 */
function movement(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const nearest = (pitch: number, set: readonly number[]) =>
    Math.min(...set.map((other) => Math.abs(other - pitch)));
  let total = 0;
  for (const pitch of b) total += nearest(pitch, a);
  for (const pitch of a) total += nearest(pitch, b);
  return total;
}

/**
 * Voice a chord. Without `previous`, root position at `anchor` rotated by
 * `inversion` (the Orchid dial). With `previous` (voice leading), every
 * rotation within an octave either side of the dial is tried and the one
 * with the least movement wins; ties go to the voicing nearest the dial,
 * then the lower one. Results stay within [low, high] when they fit.
 */
function voiceChord(chord: Chord, options: VoicingOptions = {}): number[] {
  const anchor = options.anchor ?? 60;
  const spread = options.spread ?? "close";
  const low = options.low ?? VOICING_RANGE.low;
  const high = options.high ?? VOICING_RANGE.high;
  const dial = clampInt(
    options.inversion ?? 0,
    -MAX_VOICING_STEP,
    MAX_VOICING_STEP,
  );
  const base = rootPosition(chord, anchor);
  const size = base.length;
  const fit = (notes: number[]) =>
    notes.every((pitch) => pitch >= low && pitch <= high);
  const clampMidi = (notes: number[]) =>
    notes.map((pitch) => Math.max(0, Math.min(127, pitch)));
  const at = (steps: number) => applySpread(rotate(base, steps), spread);
  if (!options.previous || options.previous.length === 0)
    return clampMidi(at(dial));
  let best: { notes: number[]; cost: number; distance: number } | undefined;
  for (let offset = -size; offset <= size; offset += 1) {
    const notes = at(dial + offset);
    if (!fit(notes) && offset !== 0) continue;
    const cost = movement(options.previous, notes);
    const distance = Math.abs(offset);
    if (
      !best ||
      cost < best.cost ||
      (cost === best.cost && distance < best.distance)
    )
      best = { notes, cost, distance };
  }
  return clampMidi(best!.notes);
}

/** Bass under a chord: its slash bass or root, in C2..B2 by default. */
function bassNote(chord: Chord, low = 36): number {
  return low + mod12((chord.bass ?? chord.root) - low);
}

/**
 * Orchid's bass behaviours (manual 10.2 and the "How to use Bass" article),
 * plus `off`. Labels in BASS_MODE_TEXT; `chords` is Orchid's default
 * "Chords Only".
 */
const BASS_MODES = ["off", "chords", "unison", "single", "solo"] as const;
type BassMode = (typeof BASS_MODES)[number];

const BASS_MODE_TEXT: Readonly<Record<BassMode, string>> = {
  off: "no bass",
  chords: "bass root under chords only",
  unison: "bass doubles single notes; root under chords",
  single: "single notes play bass only; chords play treble and root",
  solo: "bass only: the treble is muted, even for chords",
};

/** What one key press sounds once the bass mode has routed it. */
type BassRoute = Readonly<{
  /** Whether the treble (chord or single note) sounds. */
  treble: boolean;
  /** Bass pitch, or undefined for none. */
  bass: number | undefined;
}>;

/**
 * Route a key press through a bass mode. `chord` is the chord the key
 * played (undefined for a single note); `pitch` the pressed key; `low` the
 * bottom of the bass octave. Sourced semantics (Orchid manual 10.2, support
 * article "How to use Bass on Orchid"): `chords` adds the chord's root only
 * when a chord plays; `unison` plays bass and treble together on single
 * notes; `single` plays only bass on single notes and the treble only on
 * chords; `solo` mutes the treble entirely, even for chords. dawg's
 * reading where the sources are silent: every mode that sounds bass under
 * a chord uses the chord's root (or slash bass), and a single note's bass
 * is the pressed pitch class in the bass octave.
 */
function routeBass(
  mode: BassMode,
  chord: Chord | undefined,
  pitch: number,
  low = 36,
): BassRoute {
  const under = chord ? bassNote(chord, low) : low + mod12(pitch - low);
  switch (mode) {
    case "off":
      return { treble: true, bass: undefined };
    case "chords":
      return { treble: true, bass: chord ? under : undefined };
    case "unison":
      return { treble: true, bass: under };
    case "single":
      return { treble: chord !== undefined, bass: under };
    case "solo":
      return { treble: false, bass: under };
  }
}

function parseBassMode(value: string | undefined): BassMode | undefined {
  const text = (value ?? "").trim().toLowerCase();
  if (text === "on" || text === "true") return "chords";
  if (text === "false" || text === "none") return "off";
  if (text === "single-notes" || text === "singles") return "single";
  return (BASS_MODES as readonly string[]).includes(text)
    ? (text as BassMode)
    : undefined;
}

// ---------------------------------------------------------------------------
// Performance

const PERFORM_MODES = [
  "block",
  "strum-up",
  "strum-down",
  "arp-up",
  "arp-down",
  "arp-updown",
  "arp-random",
  "harp",
  "slop",
  "pattern",
  // 0.6.1: fretboard-voiced strokes (see `voiceGuitar`, `strokeVoicing`).
  "guitar",
] as const;
type PerformMode = (typeof PERFORM_MODES)[number];

type PerformOptions = Readonly<{
  mode?: PerformMode;
  /** Arp step in beats (the grid), default 1/8 beat... 0.25. */
  rate?: number;
  /** Arp/harp octaves, 1..4. */
  octaves?: number;
  /** Strum gap between voices in beats, default 1/32 beat. */
  strum?: number;
  /** Seed for arp-random and slop. */
  seed?: number;
  /** Slop amount 0..1: each voice lands up to `slop` × 1/8 beat late. */
  slop?: number;
  /** Pattern mode: a CHORD_PATTERNS name or 1-based number, default 1. */
  pattern?: string | number;
  /** 0..1. */
  velocity?: number;
  /** Guitar mode: the stroke grid (a STROKE_PATTERNS name or D U d u x - .). */
  strokes?: string;
  /** Guitar mode: grid step in beats, default 1/2. */
  step?: number;
  /** Guitar mode: seconds a full six-string down stroke takes, default 0.022. */
  speed?: number;
  /** Guitar mode: tempo in BPM that `speed` converts with, default 120. */
  tempo?: number;
  /** Guitar mode: the guitar's tuning, capo, hand, ring and position. */
  guitar?: GuitarSetup;
  /** Guitar mode: the chord's root pitch class (default: the lowest note). */
  root?: number;
  /**
   * Guitar mode: a slash bass pitch class that must sound lowest, even when
   * it is not a chord tone (B/E keeps its E pedal). Default: the lowest note.
   */
  slash?: number;
}>;

type PerformedNote = Readonly<{
  pitch: number;
  /** Beats. */
  start: number;
  length: number;
  velocity: number;
}>;

const DEFAULT_ARP_RATE = 0.25;
const DEFAULT_STRUM = 1 / 32;
const DEFAULT_SLOP = 0.5;
/** Latest a slopped voice can land, in beats, at slop 1. */
const MAX_SLOP = 1 / 8;

// ---------------------------------------------------------------------------
// Patterns

/**
 * One hit of a chord pattern. `voices` picks chord tones by index, low to
 * high: `all`, `upper` (all but the lowest), or a list where an index past
 * the top wraps an octave up (index 3 of a triad is the root +12) and a
 * negative index counts down from the top (-1 is the highest voice).
 */
type PatternHit = Readonly<{
  /** Beats from the cycle start. */
  at: number;
  /** Beats. */
  length: number;
  voices: "all" | "upper" | readonly number[];
  /** 0..1, scaled by the press velocity. */
  velocity: number;
  /** Octave shift for these voices (the bass half of oom-pah is -1). */
  octave?: number;
}>;

type ChordPattern = Readonly<{
  name: string;
  description: string;
  /** Cycle length in beats; the pattern repeats from the press. */
  beats: number;
  hits: readonly PatternHit[];
}>;

const everyStep = (
  step: number,
  beats: number,
  hit: (index: number) => Omit<PatternHit, "at">,
): PatternHit[] =>
  Array.from({ length: Math.round(beats / step) }, (_, index) => ({
    at: index * step,
    ...hit(index),
  }));

/**
 * Pattern mode. Orchid's own patterns are not published (manual 7.2: "Plays
 * chord notes in pre-determined rhythmic patterns", tempo-synced, the
 * rhythm independent of the chord's note count, with per-note velocities
 * scaled by the press; 11 at launch and two more in firmware 3.84). These
 * 13 are dawg's own design in that spirit: each hit names voices by index
 * so the rhythm holds for triads and 9th chords alike.
 */
const CHORD_PATTERNS: readonly ChordPattern[] = Object.freeze([
  {
    name: "eighths",
    description: "straight 8ths, beats accented",
    beats: 4,
    hits: everyStep(0.5, 4, (i) => ({
      length: 0.45,
      voices: "all",
      velocity: i % 2 === 0 ? 1 : 0.7,
    })),
  },
  {
    name: "sixteenths",
    description: "straight 16ths, 1-e-&-a accents",
    beats: 4,
    hits: everyStep(0.25, 4, (i) => ({
      length: 0.2,
      voices: "all",
      velocity: [1, 0.55, 0.8, 0.55][i % 4]!,
    })),
  },
  {
    name: "offbeat",
    description: "short stabs on every &",
    beats: 4,
    hits: everyStep(1, 4, () => ({
      length: 0.25,
      voices: "all",
      velocity: 0.9,
    })).map((hit) => ({ ...hit, at: hit.at + 0.5 })),
  },
  {
    name: "pop",
    description: "syncopated pop comp with 16th pushes",
    beats: 4,
    hits: [
      { at: 0, length: 0.5, voices: "all", velocity: 1 },
      { at: 0.75, length: 0.5, voices: "upper", velocity: 0.7 },
      { at: 1.5, length: 0.75, voices: "all", velocity: 0.85 },
      { at: 2.5, length: 0.5, voices: "upper", velocity: 0.7 },
      { at: 3, length: 0.25, voices: "all", velocity: 0.6 },
      { at: 3.5, length: 0.5, voices: "all", velocity: 0.85 },
    ],
  },
  {
    name: "charleston",
    description: "dotted quarter, then the & of 2",
    beats: 4,
    hits: [
      { at: 0, length: 0.75, voices: "all", velocity: 1 },
      { at: 1.5, length: 0.5, voices: "all", velocity: 0.85 },
    ],
  },
  {
    name: "bossa",
    description: "two-bar bossa comp over a root-fifth pulse",
    beats: 8,
    hits: [
      ...everyStep(2, 8, () => ({
        length: 1.5,
        voices: [0],
        velocity: 0.85,
        octave: -1,
      })),
      ...[0, 1.5, 3, 4.5, 6].map((at) => ({
        at,
        length: 0.5,
        voices: "upper" as const,
        velocity: at === 0 ? 0.9 : 0.75,
      })),
    ],
  },
  {
    name: "skank",
    description: "reggae skank: short upper stabs on 2 and 4",
    beats: 4,
    hits: [1, 3].map((at) => ({
      at,
      length: 0.2,
      voices: "upper" as const,
      velocity: 0.95,
    })),
  },
  {
    name: "gallop",
    description: "gallop: an 8th and two 16ths per beat",
    beats: 4,
    hits: everyStep(1, 4, () => ({
      length: 0.4,
      voices: "all",
      velocity: 1,
    })).flatMap((hit) => [
      hit,
      { ...hit, at: hit.at + 0.5, length: 0.2, velocity: 0.7 },
      { ...hit, at: hit.at + 0.75, length: 0.2, velocity: 0.75 },
    ]),
  },
  {
    name: "half-time",
    description: "half-time: a long hit and a pickup per two bars",
    beats: 8,
    hits: [
      { at: 0, length: 3.5, voices: "all", velocity: 1 },
      { at: 4, length: 1.5, voices: "all", velocity: 0.8 },
      { at: 7.5, length: 0.5, voices: "upper", velocity: 0.65 },
    ],
  },
  {
    name: "tresillo",
    description: "tresillo 3+3+2",
    beats: 4,
    hits: [
      { at: 0, length: 1.25, voices: "all", velocity: 1 },
      { at: 1.5, length: 1.25, voices: "all", velocity: 0.8 },
      { at: 3, length: 0.75, voices: "all", velocity: 0.9 },
    ],
  },
  {
    name: "oom-pah",
    description: "alternating bass and chord: low root, upper chord",
    beats: 4,
    hits: everyStep(1, 4, (i) =>
      i % 2 === 0
        ? { length: 0.9, voices: [0], velocity: 1, octave: -1 }
        : { length: 0.8, voices: "upper", velocity: 0.75 },
    ),
  },
  {
    name: "roll",
    description: "broken-chord roll up in 16ths, ringing to the half bar",
    beats: 4,
    hits: [0, 2].flatMap((bar) =>
      [0, 1, 2, 3].map((step) => ({
        at: bar + step * 0.25,
        length: 2 - step * 0.25,
        voices: [step],
        velocity: 0.7 + step * 0.08,
      })),
    ),
  },
  {
    name: "pick",
    description: "broken-chord picking: low, high, middle, high in 8ths",
    beats: 4,
    hits: everyStep(0.5, 4, (i) => ({
      length: 0.5,
      voices: [[0, -1, 1, -1][i % 4]!],
      velocity: i % 4 === 0 ? 0.95 : 0.7,
    })),
  },
]);

/** A pattern by name or 1-based number, or undefined. */
function findChordPattern(
  value: string | number | undefined,
): ChordPattern | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim().toLowerCase();
  const number = Number(text);
  if (/^\d+$/.test(text)) return CHORD_PATTERNS[number - 1];
  return CHORD_PATTERNS.find((pattern) => pattern.name === text);
}

function patternVoices(notes: readonly number[], hit: PatternHit): number[] {
  const n = notes.length;
  const indices =
    hit.voices === "all"
      ? notes.map((_, i) => i)
      : hit.voices === "upper"
        ? n > 1
          ? notes.slice(1).map((_, i) => i + 1)
          : [0]
        : hit.voices;
  const shift = 12 * (hit.octave ?? 0);
  const out = new Set<number>();
  for (const index of indices) {
    const i = index < 0 ? ((index % n) + n) % n : index;
    const wrapped = ((i % n) + n) % n;
    const pitch = notes[wrapped]! + 12 * Math.floor(i / n) + shift;
    if (pitch >= 0 && pitch <= 127) out.add(pitch);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Lay a voiced chord out in time over [start, start + length). Block holds
 * every voice; strums offset voices by `strum` beats and hold to the end;
 * arpeggios step one voice per `rate` beats across `octaves`, aligned to
 * multiples of `rate` from `start`; harp is an upward strum across the
 * octaves that rings to the end; slop (Orchid's humanised timing) holds
 * every voice like block but delays each by a seeded random fraction of
 * `slop` × MAX_SLOP, so each seed lands differently; pattern repeats a
 * CHORD_PATTERNS rhythm from `start`, each hit's velocity scaled by
 * `velocity`.
 */
function perform(
  pitches: readonly number[],
  start: number,
  length: number,
  options: PerformOptions = {},
): PerformedNote[] {
  const mode = options.mode ?? "block";
  const velocity = options.velocity ?? 0.8;
  const notes = [...pitches].sort((a, b) => a - b);
  if (notes.length === 0 || !(length > 0)) return [];
  const end = start + length;
  const octaves = clampInt(options.octaves ?? 1, 1, 4);
  const spanned: number[] = [];
  for (let o = 0; o < octaves; o += 1)
    for (const pitch of notes)
      if (pitch + 12 * o <= 127) spanned.push(pitch + 12 * o);
  const at = (pitch: number, from: number, to: number): PerformedNote => ({
    pitch,
    start: round6(from),
    length: round6(Math.max(1e-6, to - from)),
    velocity,
  });
  switch (mode) {
    case "block":
      return notes.map((pitch) => at(pitch, start, end));
    case "strum-up":
    case "strum-down": {
      const gap = Math.max(0, options.strum ?? DEFAULT_STRUM);
      const order = mode === "strum-up" ? notes : [...notes].reverse();
      return order
        .map((pitch, index) =>
          at(pitch, Math.min(end - gap, start + index * gap), end),
        )
        .filter((note) => note.length > 0);
    }
    case "slop": {
      const amount = Math.min(1, Math.max(0, options.slop ?? DEFAULT_SLOP));
      const random = mulberry32(options.seed ?? 0);
      const late = Math.min(amount * MAX_SLOP, length / 2);
      return notes.map((pitch) => at(pitch, start + random() * late, end));
    }
    case "pattern": {
      const pattern =
        findChordPattern(options.pattern ?? 1) ?? CHORD_PATTERNS[0]!;
      const out: PerformedNote[] = [];
      for (let cycle = start; cycle < end - 1e-9; cycle += pattern.beats)
        for (const hit of pattern.hits) {
          const from = cycle + hit.at;
          if (from >= end - 1e-9) continue;
          const to = Math.min(end, from + hit.length);
          for (const pitch of patternVoices(notes, hit))
            out.push({
              ...at(pitch, from, to),
              velocity: round6(velocity * hit.velocity),
            });
        }
      return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    }
    case "guitar": {
      const bass = options.slash ?? notes[0]!;
      const voicing = voiceGuitar(
        notes.map(mod12),
        mod12(bass),
        options.root ?? mod12(bass),
        options.guitar,
      );
      if (!voicing) return notes.map((pitch) => at(pitch, start, end));
      return strokeVoicing(voicing, start, length, {
        ...(options.strokes !== undefined ? { strokes: options.strokes } : {}),
        ...(options.step !== undefined ? { step: options.step } : {}),
        ...(options.speed !== undefined ? { speed: options.speed } : {}),
        ...(options.tempo !== undefined ? { tempo: options.tempo } : {}),
        velocity,
        strings: guitarStrings(options.guitar?.tune).length,
      });
    }
    case "harp": {
      const gap = Math.max(0, options.strum ?? DEFAULT_STRUM * 2);
      return spanned.map((pitch, index) =>
        at(pitch, Math.min(end - 1e-3, start + index * gap), end),
      );
    }
    default: {
      const rate =
        options.rate && options.rate > 0 ? options.rate : DEFAULT_ARP_RATE;
      const steps = Math.max(1, Math.floor(length / rate + 1e-9));
      let order: number[];
      if (mode === "arp-down") order = [...spanned].reverse();
      else if (mode === "arp-updown")
        order =
          spanned.length > 2
            ? [...spanned, ...spanned.slice(1, -1).reverse()]
            : spanned;
      else order = spanned;
      const random = mulberry32(options.seed ?? 0);
      const out: PerformedNote[] = [];
      for (let step = 0; step < steps; step += 1) {
        const from = start + step * rate;
        const to = Math.min(end, from + rate);
        const pitch =
          mode === "arp-random"
            ? spanned[Math.floor(random() * spanned.length)]!
            : order[step % order.length]!;
        out.push(at(pitch, from, to));
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Fretboard (0.6.1): guitar voicings and strokes

/**
 * Open-string MIDI pitches, low string to high, for `guitar tune <name>`.
 * Ported from the guitar design lane (proto/guitar/strum.ts TUNINGS).
 */
const GUITAR_TUNINGS = Object.freeze({
  standard: [40, 45, 50, 55, 59, 64],
  dropd: [38, 45, 50, 55, 59, 64],
  doubledropd: [38, 45, 50, 55, 59, 62],
  dadgad: [38, 45, 50, 55, 57, 62],
  openg: [38, 43, 50, 55, 59, 62],
  opend: [38, 45, 50, 54, 57, 62],
  opene: [40, 47, 52, 56, 59, 64],
  halfdown: [39, 44, 49, 54, 58, 63],
  nashville: [52, 57, 62, 67, 59, 64],
  bass: [28, 33, 38, 43],
  ukulele: [67, 60, 64, 69],
  requinto: [45, 50, 55, 60, 64, 69],
} as const satisfies Record<string, readonly number[]>);
type GuitarTuningName = keyof typeof GUITAR_TUNINGS;
const GUITAR_TUNING_NAMES = Object.keys(GUITAR_TUNINGS) as GuitarTuningName[];

/** How a guitar is set up for voicing chords (`Track.guitar`). */
type GuitarSetup = Readonly<{
  /** A GUITAR_TUNINGS name or open-string pitches low to high. */
  tune?: string | readonly number[];
  /** Capo fret 0..12. */
  capo?: number;
  /** Hand stretch in frets 3..6 (default 4: one fret per finger). */
  hand?: number;
  /** 0 closed shapes (no open strings) .. 1 prefer ringing open strings. */
  ring?: number;
  /** Preferred fret position 0..12 (0 open position). */
  position?: number;
}>;

/** One fretted chord: frets per string low to high (-1 muted). */
type GuitarVoicing = Readonly<{
  frets: readonly number[];
  /** Sounding pitches, low string to high. */
  pitches: readonly number[];
  /** The string each pitch sounds on. */
  strings: readonly number[];
}>;

/** Open-string pitches for a tuning name or list (standard when unknown). */
function guitarStrings(tune: GuitarSetup["tune"]): readonly number[] {
  if (Array.isArray(tune)) return tune as readonly number[];
  const name = String(tune ?? "standard")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  return (
    (GUITAR_TUNINGS as Record<string, readonly number[]>)[name] ??
    GUITAR_TUNINGS.standard
  );
}

/**
 * Fingers a fretting uses. Strings at the lowest fret count as one barre
 * only when no open string lies between them (a barre cannot skip an open
 * string); otherwise one finger each.
 */
function guitarFingers(frets: readonly number[]): number {
  const fretted = frets.filter((f) => f > 0);
  if (fretted.length === 0) return 0;
  const min = Math.min(...fretted);
  const at = frets.flatMap((f, i) => (f === min ? [i] : []));
  const between = frets.slice(at[0]!, at[at.length - 1]! + 1);
  const barre = at.length > 1 && !between.includes(0);
  return (barre ? 1 : at.length) + fretted.filter((f) => f > min).length;
}

/**
 * The chord tones a voicing must keep, most required first, after dropping
 * `drops` tones in the guitarist's order: the 5th, then the 9th; the root,
 * the 3rd and the 7th always stay (after the design lane's review).
 */
function requiredTones(tones: readonly number[], root: number, drops: number) {
  // The 5th, then the 11th (only beside a 3rd: a sus4 keeps its 4th), then
  // the 9th. dawg's symbols reach an 11th through m(add4)/madd4 (+9).
  const third = tones.some((pc) => [3, 4].includes(mod12(pc - root)));
  const order = (third ? [7, 5, 2] : [7, 2]).map((step) => mod12(root + step));
  const dropped = order.filter((pc) => tones.includes(pc)).slice(0, drops);
  return tones.filter((pc) => !dropped.includes(pc));
}

/**
 * The most playable fretting of pitch classes `tones` over `bass` on a
 * guitar `setup`: the bass is the lowest sounding note, every required
 * tone sounds, at most four fingers within a `hand`-fret stretch, mutes
 * only under the bass or one inside, and no barre over an open string.
 * Cost prefers more strings, low positions, open strings (by `ring`), a
 * fifth present, no doubled third, and small moves from `previous`.
 * Undefined when nothing fits. Ported from proto/guitar/strum.ts.
 */
function voiceGuitar(
  tones: readonly number[],
  bass: number,
  root: number,
  setup: GuitarSetup = {},
  previous?: readonly number[],
): GuitarVoicing | undefined {
  // Play mode voices every pad press; dense chords at a wide hand take
  // ~15 ms to search, so repeats come from a small LRU (results are frozen).
  const key = JSON.stringify([
    [...new Set([...tones, bass].map(mod12))],
    mod12(bass),
    mod12(root),
    setup.tune ?? null,
    setup.capo ?? null,
    setup.hand ?? null,
    setup.ring ?? null,
    setup.position ?? null,
    previous ?? null,
  ]);
  if (voicingCache.has(key)) {
    const hit = voicingCache.get(key);
    voicingCache.delete(key);
    voicingCache.set(key, hit);
    return hit;
  }
  const voiced = searchGuitar(tones, bass, root, setup, previous);
  voicingCache.set(key, voiced);
  if (voicingCache.size > VOICING_CACHE_SIZE)
    voicingCache.delete(voicingCache.keys().next().value!);
  return voiced;
}

const VOICING_CACHE_SIZE = 256;
const voicingCache = new Map<string, GuitarVoicing | undefined>();

function searchGuitar(
  tones: readonly number[],
  bass: number,
  root: number,
  setup: GuitarSetup,
  previous?: readonly number[],
): GuitarVoicing | undefined {
  const pcs = [...new Set([...tones, bass].map(mod12))];
  const capo = clampInt(setup.capo ?? 0, 0, 12);
  const open = guitarStrings(setup.tune).map((pitch) => pitch + capo);
  const n = open.length;
  const ring = Math.min(1, Math.max(0, setup.ring ?? 0.5));
  const stretch = clampInt(setup.hand ?? 4, 3, 6);
  const fifth = mod12(root + 7);
  const third = pcs.find((pc) => [3, 4].includes(mod12(pc - root)));
  const prev = previous ? [...previous].sort((a, b) => a - b) : undefined;
  for (let drops = 0; drops <= 3; drops += 1) {
    const required = requiredTones(pcs, root, drops);
    let best: { frets: number[]; cost: number } | undefined;
    const choose = (frets: readonly number[]) => {
      const idx = frets.flatMap((f, i) => (f < 0 ? [] : [i]));
      if (idx.length < Math.min(n, n >= 6 ? 4 : 3)) return;
      const interior = frets.slice(idx[0]).filter((f) => f < 0).length;
      if (interior > (n >= 6 ? 1 : 0)) return;
      const pitches = idx.map((i) => open[i]! + frets[i]!);
      if (mod12(Math.min(...pitches)) !== mod12(bass)) return;
      const sounding = new Set(pitches.map(mod12));
      if (required.some((pc) => !sounding.has(pc))) return;
      const fingers = guitarFingers(frets);
      if (fingers > 4) return;
      const fretted = frets.filter((f) => f > 0);
      const span = fretted.length
        ? Math.max(...fretted) - Math.min(...fretted)
        : 0;
      if (span > stretch - 1) return;
      const opens = frets.filter((f) => f === 0).length;
      if (ring === 0 && opens > 0) return;
      const pos = fretted.length ? Math.min(...fretted) : 0;
      let cost =
        span * 0.6 +
        pos * 0.25 +
        fingers * 0.4 -
        idx.length -
        opens * 0.7 * ring;
      cost += interior * 1.5;
      if (!sounding.has(fifth) && pcs.includes(fifth)) cost += 0.6;
      if (
        third !== undefined &&
        pitches.filter((p) => mod12(p) === third).length > 1
      )
        cost += 0.5;
      if (setup.position !== undefined)
        cost += Math.abs(pos - setup.position) * 0.5;
      if (prev && prev.length) {
        const cur = [...pitches].sort((a, b) => a - b);
        let move = 0;
        for (let i = 0; i < cur.length; i += 1)
          move += Math.abs(cur[i]! - prev[Math.min(i, prev.length - 1)]!);
        cost += move * 0.05;
      }
      if (
        !best ||
        cost < best.cost - 1e-9 ||
        (Math.abs(cost - best.cost) <= 1e-9 && frets.join() < best.frets.join())
      )
        best = { frets: [...frets], cost };
    };
    for (let p = 1; p <= 12; p += 1) {
      const options = open.map((o) => {
        const list = [-1];
        if (pcs.includes(mod12(o))) list.push(0);
        for (let f = p; f < p + stretch; f += 1)
          if (pcs.includes(mod12(o + f))) list.push(f);
        return list;
      });
      const frets = new Array<number>(n).fill(-1);
      const walk = (s: number): void => {
        if (s === n) return choose(frets);
        for (const f of options[s]!) {
          frets[s] = f;
          walk(s + 1);
        }
      };
      walk(0);
    }
    if (best) {
      const { frets } = best as { frets: number[] };
      const strings = frets.flatMap((f, i) => (f < 0 ? [] : [i]));
      return Object.freeze({
        frets: Object.freeze(frets),
        pitches: Object.freeze(strings.map((i) => open[i]! + frets[i]!)),
        strings: Object.freeze(strings),
      });
    }
  }
  return undefined;
}

/** A voicing as tab, low string first: `x 3 2 0 1 0`. */
function guitarTab(frets: readonly number[]): string {
  return frets.map((f) => (f < 0 ? "x" : String(f))).join(" ");
}

/**
 * Stroke grids for perform mode `guitar`, one character per step: D down
 * (all strings), U up (top four), d light down (top four), u light up (top
 * three), x muted chuck, `-` or `.` rest (strings ring on). After the
 * design lane's STRUM_PATTERNS.
 */
const STROKE_PATTERNS = Object.freeze({
  down: "D",
  folk: "D-DU-UDU",
  pop: "D-DU-UD-",
  punk: "DDDDDDDD",
  funk: "xUxUDUxUxUDUxUxU",
  reggae: "-D-D",
  waltz: "Ddd",
  jangle: "D-DUDUDU",
  island: "D-DU-UDU",
} as const satisfies Record<string, string>);
const STROKE_PATTERN_NAMES = Object.keys(STROKE_PATTERNS);
const STROKE_CHARS = /^[DUdux.\-]+$/;

/** Default seconds a full six-string down stroke takes (22 ms). */
const DEFAULT_STROKE_SPEED = 0.022;
/** Default stroke grid step in beats (8ths). */
const DEFAULT_STROKE_STEP = 0.5;

/** A stroke grid by name, or a literal grid of D U d u x - .; undefined if bad. */
function strokeGrid(text: string | undefined): string | undefined {
  const raw = (text ?? "down").trim();
  const named = (STROKE_PATTERNS as Record<string, string>)[raw.toLowerCase()];
  if (named) return named;
  const grid = raw.replace(/[|\s]/g, "");
  return grid.length > 0 && grid.length <= 64 && STROKE_CHARS.test(grid)
    ? grid
    : undefined;
}

/**
 * Strum fretted `voicing` from `start` for `length` beats with stroke grid
 * `strokes` (repeats every grid length, one step per `step` beats). A full
 * down stroke sweeps the six strings in `speed` seconds at `tempo` BPM;
 * each struck string rings until it is struck again or the chord ends; a
 * chuck (x) is a short muted hit that stops the strings. Velocity accents
 * downbeats and lightens upstrokes.
 */
function strokeVoicing(
  voicing: GuitarVoicing,
  start: number,
  length: number,
  options: Readonly<{
    strokes?: string;
    step?: number;
    speed?: number;
    tempo?: number;
    velocity?: number;
    strings?: number;
  }> = {},
): PerformedNote[] {
  const grid = strokeGrid(options.strokes) ?? "D";
  const step =
    options.step && options.step > 0 ? options.step : DEFAULT_STROKE_STEP;
  const tempo = options.tempo && options.tempo > 0 ? options.tempo : 120;
  const sweep =
    (Math.max(0, options.speed ?? DEFAULT_STROKE_SPEED) * tempo) / 60;
  const base = options.velocity ?? 0.8;
  const total = Math.max(2, options.strings ?? 6);
  const sounding = voicing.strings;
  const end = start + length;
  type Open = { note: PerformedNote; index: number };
  const ringing = new Map<number, Open>();
  const out: PerformedNote[] = [];
  const stop = (string: number, at: number) => {
    const held = ringing.get(string);
    if (!held) return;
    const cut = round6(
      Math.max(1e-3, Math.min(held.note.length, at - held.note.start)),
    );
    out[held.index] = { ...held.note, length: cut };
    ringing.delete(string);
  };
  const steps = Math.max(1, Math.round(length / step));
  for (let s = 0; s < steps; s += 1) {
    const ch = grid[s % grid.length]!;
    if (ch === "-" || ch === ".") continue;
    const t0 = start + s * step;
    if (t0 >= end - 1e-9) break;
    const beat = s * step;
    const accent =
      Math.abs(beat - Math.round(beat)) < 1e-9
        ? Math.round(beat) % 2 === 0
          ? 1
          : 0.92
        : 0.82;
    let order: number[];
    let velocity = base * accent;
    let ring = end - t0;
    const all = sounding.map((_, k) => k);
    switch (ch) {
      case "D":
        order = all;
        break;
      case "U":
        order = all.slice(-4).reverse();
        velocity *= 0.85;
        break;
      case "d":
        order = all.slice(-4);
        velocity *= 0.62;
        break;
      case "u":
        order = all.slice(-3).reverse();
        velocity *= 0.55;
        break;
      default:
        order = all;
        velocity *= 0.5;
        ring = Math.min(ring, 0.03 * (tempo / 60));
    }
    const first = sounding[order[0]!]!;
    order.forEach((k, position) => {
      const string = sounding[k]!;
      const at = t0 + (Math.abs(string - first) / (total - 1)) * sweep;
      if (at >= end - 1e-9) return;
      stop(string, at);
      const note: PerformedNote = {
        pitch: voicing.pitches[k]!,
        start: round6(at),
        length: round6(Math.max(1e-3, Math.min(ring, end - at))),
        velocity: round6(
          Math.max(0.05, Math.min(1, velocity * (1 - 0.04 * position))),
        ),
      };
      out.push(note);
      if (ch !== "x") ringing.set(string, { note, index: out.length - 1 });
    });
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// ---------------------------------------------------------------------------
// Progressions

/** A progression preset: roman numerals and the mode they read in. */
type ProgressionPreset = Readonly<{
  name: string;
  mode: "major" | "minor" | "dorian" | "mixolydian";
  numerals: readonly string[];
  /** Use diatonic sevenths. */
  sevenths?: boolean;
  description: string;
}>;

const PROGRESSION_PRESETS: readonly ProgressionPreset[] = Object.freeze([
  {
    name: "axis",
    mode: "major",
    numerals: ["I", "V", "vi", "IV"],
    description: "I–V–vi–IV, the four-chord pop loop",
  },
  {
    name: "sad-pop",
    mode: "major",
    numerals: ["vi", "IV", "I", "V"],
    description: "vi–IV–I–V, the same loop from the relative minor",
  },
  {
    name: "fifties",
    mode: "major",
    numerals: ["I", "vi", "IV", "V"],
    description: "I–vi–IV–V doo-wop",
  },
  {
    name: "ii-v-i",
    mode: "major",
    numerals: ["ii", "V", "I", "I"],
    sevenths: true,
    description: "ii7–V7–Imaj7, the jazz cadence",
  },
  {
    name: "turnaround",
    mode: "major",
    numerals: ["I", "vi", "ii", "V"],
    sevenths: true,
    description: "Imaj7–vi7–ii7–V7 turnaround",
  },
  {
    name: "canon",
    mode: "major",
    numerals: ["I", "V", "vi", "iii", "IV", "I", "IV", "V"],
    description: "Pachelbel's canon",
  },
  {
    name: "aeolian",
    mode: "minor",
    numerals: ["i", "VI", "III", "VII"],
    description: "i–VI–III–VII minor anthem",
  },
  {
    name: "andalusian",
    mode: "minor",
    numerals: ["i", "VII", "VI", "V"],
    description: "i–VII–VI–V descending (major V)",
  },
  {
    name: "minor-ii-v",
    mode: "minor",
    numerals: ["iiø", "V7", "i", "i"],
    sevenths: true,
    description: "iiø7–V7–i minor cadence",
  },
  {
    name: "dorian-vamp",
    mode: "dorian",
    numerals: ["i", "IV"],
    sevenths: true,
    description: "i7–IV7 dorian vamp",
  },
  {
    name: "mixolydian-rock",
    mode: "mixolydian",
    numerals: ["I", "bVII", "IV", "I"],
    description: "I–bVII–IV–I mixolydian rock",
  },
]);

const PROGRESSION_STYLES = ["pop", "jazz", "modal", "classical"] as const;
type ProgressionStyle = (typeof PROGRESSION_STYLES)[number];

/**
 * Functional-harmony transition weights between scale degrees (0 = I),
 * per style. Tonic (I, vi, iii) moves to predominant (IV, ii), which moves
 * to dominant (V, vii°), which resolves to tonic; pop adds the plagal and
 * vi–IV moves, jazz favours the cycle of fifths, modal keeps to the tonic
 * and its neighbours.
 */
const TRANSITIONS: Readonly<
  Record<ProgressionStyle, readonly (readonly number[])[]>
> = Object.freeze({
  //            I  ii iii IV  V  vi vii
  pop: [
    [0, 1, 1, 4, 4, 4, 0], // I
    [1, 0, 0, 2, 5, 1, 0], // ii
    [0, 0, 0, 3, 1, 4, 0], // iii
    [4, 1, 0, 0, 4, 2, 0], // IV
    [4, 0, 0, 2, 0, 4, 0], // V
    [1, 2, 1, 5, 3, 0, 0], // vi
    [5, 0, 1, 0, 0, 1, 0], // vii°
  ],
  jazz: [
    [0, 4, 1, 2, 1, 4, 0],
    [0, 0, 0, 0, 8, 0, 1],
    [0, 0, 0, 1, 0, 6, 0],
    [2, 2, 0, 0, 2, 0, 3],
    [6, 0, 0, 0, 0, 2, 0],
    [0, 7, 0, 1, 1, 0, 0],
    [2, 0, 5, 0, 0, 0, 0],
  ],
  modal: [
    [0, 3, 1, 4, 1, 2, 2],
    [5, 0, 1, 1, 0, 0, 1],
    [3, 1, 0, 1, 0, 0, 1],
    [5, 1, 0, 0, 1, 0, 2],
    [3, 0, 0, 2, 0, 1, 1],
    [3, 1, 0, 1, 0, 0, 1],
    [5, 0, 0, 2, 0, 0, 0],
  ],
  classical: [
    [0, 2, 1, 4, 5, 3, 1],
    [0, 0, 0, 0, 6, 0, 2],
    [0, 0, 0, 2, 0, 5, 0],
    [2, 3, 0, 0, 5, 0, 1],
    [6, 0, 0, 0, 0, 2, 0],
    [0, 4, 0, 4, 1, 0, 0],
    [6, 0, 1, 0, 0, 0, 0],
  ],
});

/** Seeded PRNG (mulberry32): same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(weights: readonly number[], random: () => number): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return 0;
  let roll = random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i]!;
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

function findPreset(name: string): ProgressionPreset | undefined {
  const wanted = name.trim().toLowerCase();
  return PROGRESSION_PRESETS.find((preset) => preset.name === wanted);
}

/** The next degree the graph favours most after `degree` (no randomness). */
function likelyNext(degree: number, style: ProgressionStyle = "pop"): number {
  const row = TRANSITIONS[style][((degree % 7) + 7) % 7]!;
  let best = 0;
  for (let i = 1; i < row.length; i += 1) if (row[i]! > row[best]!) best = i;
  return best;
}

/**
 * The chord play mode shows as "next": with a preset, the preset chord
 * after the last one played (matched by root); otherwise the strongest
 * graph transition from the last chord's degree, or I when there is none.
 */
function suggestNext(
  key: Key,
  last: Chord | undefined,
  options: Readonly<{
    preset?: string;
    style?: ProgressionStyle;
    sevenths?: boolean;
  }> = {},
): Chord {
  const preset = options.preset ? findPreset(options.preset) : undefined;
  if (preset) {
    const chords = presetChords(key, preset);
    const index = last
      ? chords.findIndex((chord) => chord.root === last.root)
      : -1;
    return chords[(index + 1) % chords.length]!;
  }
  const degree = last ? degreeOf(key, last.root) : undefined;
  const next = degree === undefined ? 0 : likelyNext(degree, options.style);
  return diatonicChord(key, next, options.sevenths);
}

/** A preset's chords in `key` (numerals read in the key's own mode). */
function presetChords(key: Key, preset: ProgressionPreset): Chord[] {
  return preset.numerals.map((numeral) => {
    const chord = parseRoman(key, numeral);
    if (!chord) throw new Error(`bad preset numeral ${numeral}`);
    if (!preset.sevenths || chord.extensions.length > 0) return chord;
    const withSeventh = parseRoman(key, `${numeral}7`);
    return withSeventh ?? chord;
  });
}

type ProgressionRequest = Readonly<{
  key: Key;
  /** Number of chords, 1..64. */
  length: number;
  /** A preset name or a style for the random walk. */
  style?: ProgressionStyle | string;
  seed?: number;
  sevenths?: boolean;
}>;

/**
 * A progression of `length` chords. A preset name cycles the preset. A
 * style walks the transition graph from I with a seeded PRNG; when the
 * progression is 4+ chords long, the last chord is drawn from the
 * dominant-function chords (V, vii°, or IV in modal) so the loop leads
 * back to I. Same request, same chords.
 */
function generateProgression(request: ProgressionRequest): Chord[] {
  const length = clampInt(request.length, 1, 64);
  const preset = request.style ? findPreset(request.style) : undefined;
  if (preset) {
    const chords = presetChords(request.key, preset);
    return Array.from({ length }, (_, i) => chords[i % chords.length]!);
  }
  const style = (PROGRESSION_STYLES as readonly string[]).includes(
    request.style ?? "",
  )
    ? (request.style as ProgressionStyle)
    : "pop";
  const sevenths = request.sevenths ?? style === "jazz";
  const random = mulberry32(request.seed ?? 1);
  const degrees: number[] = [0];
  for (let i = 1; i < length; i += 1) {
    const row: number[] = [...TRANSITIONS[style][degrees[i - 1]!]!];
    if (i === length - 1 && length >= 4) {
      const cadence = style === "modal" ? [3, 6] : [4, 6];
      for (let d = 0; d < 7; d += 1) if (!cadence.includes(d)) row[d] = 0;
      if (!row.some((w) => w > 0)) row[cadence[0]!] = 1;
    }
    degrees.push(pick(row, random));
  }
  return degrees.map((degree) => diatonicChord(request.key, degree, sevenths));
}

/** A chord with its voicing, as tools and the SDK report it. */
type VoicedChord = Readonly<{
  name: string;
  roman: string;
  pitches: readonly number[];
  bass?: number | undefined;
}>;

/** Voice a progression with minimal movement chord to chord. */
function voiceProgression(
  key: Key,
  chords: readonly Chord[],
  options: Readonly<{
    inversion?: number;
    spread?: Spread;
    bass?: boolean;
    anchor?: number;
    lead?: boolean;
  }> = {},
): VoicedChord[] {
  const flats = keyUsesFlats(key);
  let previous: number[] | undefined;
  return chords.map((chord) => {
    const pitches = voiceChord(chord, {
      ...(options.inversion !== undefined
        ? { inversion: options.inversion }
        : {}),
      ...(options.spread ? { spread: options.spread } : {}),
      ...(options.anchor !== undefined ? { anchor: options.anchor } : {}),
      previous: options.lead === false ? undefined : previous,
    });
    previous = pitches;
    return Object.freeze({
      name: chordName(chord, flats),
      roman: romanOf(key, chord),
      pitches: Object.freeze(pitches),
      ...(options.bass ? { bass: bassNote(chord) } : {}),
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers

function mod12(value: number): number {
  return ((Math.trunc(value) % 12) + 12) % 12;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Rendering a progression to notes (tools, SDK, recording)

/** A roman numeral (`ii7`, `bVII`) or chord symbol (`Cm7`, `F/A`) in `key`. */
function resolveChord(key: Key, text: string): Chord | undefined {
  return parseRoman(key, text) ?? parseChord(text);
}

type RenderOptions = Readonly<{
  key: Key;
  chords: readonly Chord[];
  /** Beats each chord lasts (one bar of 4/4 by default). */
  beatsPerChord?: number;
  /** First chord's start in beats. */
  start?: number;
  perform?: PerformOptions;
  inversion?: number;
  spread?: Spread;
  /** Add a bass note under each chord. */
  bass?: boolean;
  /**
   * Bass behaviour (overrides `bass`). Every progression step is a chord,
   * so `chords` and `single` add the root (or slash bass), `unison` the
   * chord's root (the key a player would press), and `solo` drops the
   * treble and keeps only that bass.
   */
  bassMode?: BassMode;
  /** Voice-lead chord to chord (default true). */
  lead?: boolean;
  anchor?: number;
}>;

type RenderedProgression = Readonly<{
  voiced: readonly VoicedChord[];
  notes: readonly PerformedNote[];
  bass: readonly PerformedNote[];
}>;

/**
 * A progression as notes: voice-led voicings performed over consecutive
 * spans of `beatsPerChord`, plus one sustained bass note per chord. The
 * arp-random seed advances per chord so repeated chords vary but the
 * whole render stays deterministic.
 */
function renderProgression(options: RenderOptions): RenderedProgression {
  const span =
    options.beatsPerChord && options.beatsPerChord > 0
      ? options.beatsPerChord
      : 4;
  const start = options.start ?? 0;
  const voiced = voiceProgression(options.key, options.chords, {
    ...(options.inversion !== undefined
      ? { inversion: options.inversion }
      : {}),
    ...(options.spread ? { spread: options.spread } : {}),
    ...(options.anchor !== undefined ? { anchor: options.anchor } : {}),
    ...(options.lead !== undefined ? { lead: options.lead } : {}),
    bass: true,
  });
  const notes: PerformedNote[] = [];
  const bass: PerformedNote[] = [];
  const velocity = options.perform?.velocity ?? 0.8;
  const mode: BassMode = options.bassMode ?? (options.bass ? "chords" : "off");
  voiced.forEach((chord, index) => {
    const at = start + index * span;
    if (mode !== "solo")
      notes.push(
        ...perform(chord.pitches, at, span, {
          ...options.perform,
          seed: (options.perform?.seed ?? 0) + index,
          ...(options.perform?.mode === "guitar"
            ? {
                root: options.chords[index]!.root,
                ...(options.chords[index]!.bass !== undefined
                  ? { slash: options.chords[index]!.bass }
                  : {}),
              }
            : {}),
        }),
      );
    const source = options.chords[index]!;
    const under =
      mode === "off"
        ? undefined
        : mode === "unison"
          ? bassNote({ ...source, bass: undefined })
          : chord.bass;
    if (under !== undefined)
      bass.push({
        pitch: under,
        start: round6(at),
        length: round6(span),
        velocity,
      });
  });
  return {
    voiced:
      mode !== "off"
        ? voiced
        : voiced.map(({ bass: _bass, ...rest }) => Object.freeze(rest)),
    notes,
    bass,
  };
}
// END chord engine

// ---------------------------------------------------------------------------
// Audio clips, takes and lyrics (SDK 1.32.0)

/** Options for `audio()`: times in beats, offsets and lengths in seconds. */
export type AudioOptions = Readonly<{
  /** Stable clip id; defaults to `clip`, `clip2`, ... by position. */
  id?: string;
  /** Beat the clip starts on, default 0. */
  at?: number;
  /** Seconds into the file where the clip starts, default 0. */
  offset?: number;
  /** Seconds of the file it plays, default to the end. */
  dur?: number;
  /** Linear gain 0..4, default 1. */
  gain?: number;
  /** Equal-power fade in, seconds (default 5 ms). */
  fadeInTime?: number;
  /** Equal-power fade out, seconds (default 5 ms). */
  fadeTime?: number;
  /** Play the slice backwards. */
  rev?: boolean;
  /** The track take this clip plays from (its clock drift applies). */
  take?: string;
  mute?: boolean;
  /** The words sung in the clip, for the highway and lyrics. */
  text?: string;
  /** A text-to-speech clip's time map (0.7.1); kept as written. */
  say?: Readonly<Record<string, unknown>>;
  /** The file's pin; dawg fills it from the file when absent. */
  sha256?: string;
}>;

/** One audio clip as `audio()` builds it. */
export type AudioSpec = Readonly<
  { kind: "audio"; src: string; at: number } & Omit<AudioOptions, "at">
>;

const AUDIO_KEYS = [
  "id",
  "at",
  "offset",
  "dur",
  "gain",
  "fadeInTime",
  "fadeTime",
  "rev",
  "take",
  "mute",
  "text",
  "say",
  "sha256",
] as const;

/**
 * An audio file on the track's timeline (SDK 1.32.0). `src` is relative
 * to the track folder (`samples/lead.wav`) or the project
 * (`tracks/vox/samples/lead.wav`).
 *
 * ```ts
 * clips: [audio("samples/verse.wav", { at: 16, gain: 0.8, fadeTime: 0.2 })]
 * ```
 */
export function audio(src: string, options: AudioOptions = {}): AudioSpec {
  const file = text(src, "audio src");
  if (!isRecord(options))
    throw new DawgSdkError("audio options must be an object");
  for (const key of Object.keys(options))
    if (!(AUDIO_KEYS as readonly string[]).includes(key))
      throw new DawgSdkError(
        `audio has an unknown option "${key.slice(0, 32)}" (${AUDIO_KEYS.join(" ")})`,
      );
  const out: Record<string, unknown> = {
    kind: "audio",
    src: file,
    at: beat(options.at ?? 0, "audio at"),
  };
  if (options.id !== undefined) out.id = text(options.id, "audio id");
  for (const key of [
    "offset",
    "dur",
    "gain",
    "fadeInTime",
    "fadeTime",
  ] as const)
    if (options[key] !== undefined) {
      const value = finite(options[key], `audio ${key}`);
      if (value < 0) throw new DawgSdkError(`audio ${key} must be ≥ 0`);
      out[key] = value;
    }
  for (const key of ["rev", "mute"] as const)
    if (options[key] !== undefined) {
      if (typeof options[key] !== "boolean")
        throw new DawgSdkError(`audio ${key} must be true or false`);
      if (options[key]) out[key] = true;
    }
  if (options.take !== undefined) out.take = text(options.take, "audio take");
  if (options.text !== undefined) {
    if (typeof options.text !== "string" || options.text.length > 2000)
      throw new DawgSdkError("audio text must be at most 2000 characters");
    out.text = options.text;
  }
  if (options.say !== undefined) {
    if (!isRecord(options.say))
      throw new DawgSdkError("audio say must be an object");
    out.say = options.say;
  }
  if (options.sha256 !== undefined) {
    if (
      typeof options.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(options.sha256)
    )
      throw new DawgSdkError(
        "audio sha256 must be 64 lowercase hex characters",
      );
    out.sha256 = options.sha256;
  }
  return Object.freeze(out) as AudioSpec;
}

/**
 * Copies of `clip` every `every` beats after it while they start before
 * `until` (SDK 1.32.0), the clip first: `...repeatAudio(hook, { every: 8,
 * until: 64 })`. Copies of a clip with an id get `<id>-r2`, `<id>-r3`, ...
 */
export function repeatAudio(
  clip: AudioSpec,
  options: Readonly<{ every: number; until: number }>,
): readonly AudioSpec[] {
  if (!isRecord(clip) || clip.kind !== "audio")
    throw new DawgSdkError("repeatAudio needs a clip from audio()");
  if (!isRecord(options))
    throw new DawgSdkError("repeatAudio needs { every, until } in beats");
  const every = positive(options.every, "repeatAudio every");
  const until = beat(options.until, "repeatAudio until");
  const out: AudioSpec[] = [clip];
  for (
    let at = clip.at + every, pass = 2;
    at < until - 1e-9 && out.length < 256;
    at += every, pass += 1
  )
    out.push(
      Object.freeze({
        ...clip,
        at,
        ...(clip.id !== undefined ? { id: `${clip.id}-r${pass}` } : {}),
      }) as AudioSpec,
    );
  return Object.freeze(out);
}

/** Options for `take()`: `at`, `in` and `out` in beats, the rest in seconds. */
export type TakeOptions = Readonly<{
  /** Beat the recording's first sample lines up with. */
  at?: number;
  /** Punch range in beats, default `at` to `at + 4`. */
  in?: number;
  out?: number;
  /** Seconds into the file where the take starts. */
  offset?: number;
  /** Round-trip latency compensated, seconds. */
  latency?: number;
  latencyAssumed?: boolean;
  /** Clock drift in parts per million (±1000). */
  ppm?: number;
  /** 0..1 fit of the alignment. */
  fit?: number;
  warn?: string;
  /** Manual nudge in milliseconds (±250). */
  nudge?: number;
  sha256?: string;
}>;

/** One take as `take()` builds it. */
export type TakeSpec = Readonly<
  {
    kind: "take";
    name: string;
    src: string;
    at: number;
    in: number;
    out: number;
  } & Omit<TakeOptions, "at" | "in" | "out">
>;

const TAKE_KEYS = [
  "at",
  "in",
  "out",
  "offset",
  "latency",
  "latencyAssumed",
  "ppm",
  "fit",
  "warn",
  "nudge",
  "sha256",
] as const;

/**
 * A take (SDK 1.32.0): one recorded or imported pass the track's clips can
 * play from (`audio(src, { take: "take-1" })`). Recording itself is 0.7.1.
 */
export function take(
  name: string,
  src: string,
  options: TakeOptions = {},
): TakeSpec {
  const label = `take ${text(name, "take name")}`;
  if (!isRecord(options))
    throw new DawgSdkError(`${label} options must be an object`);
  for (const key of Object.keys(options))
    if (!(TAKE_KEYS as readonly string[]).includes(key))
      throw new DawgSdkError(
        `${label} has an unknown option "${key.slice(0, 32)}" (${TAKE_KEYS.join(" ")})`,
      );
  const at = beat(options.at ?? 0, `${label} at`);
  const from = beat(options.in ?? at, `${label} in`);
  const to = beat(options.out ?? from + 4, `${label} out`);
  if (to <= from) throw new DawgSdkError(`${label}: out must be after in`);
  const out: Record<string, unknown> = {
    kind: "take",
    name,
    src: text(src, `${label} src`),
    at,
    in: from,
    out: to,
  };
  for (const key of ["offset", "latency", "ppm", "fit", "nudge"] as const)
    if (options[key] !== undefined)
      out[key] = finite(options[key], `${label} ${key}`);
  if (options.latencyAssumed) out.latencyAssumed = true;
  if (options.warn !== undefined)
    out.warn = text(options.warn, `${label} warn`);
  if (options.sha256 !== undefined)
    out.sha256 = text(options.sha256 as unknown, `${label} sha256`);
  return Object.freeze(out) as TakeSpec;
}

/**
 * Sings `text` on `notes` in time order (SDK 1.32.0): spaces split words,
 * `-` splits syllables, `_` holds the previous syllable over the next note
 * (melisma), `~` skips a note. With fewer syllables than notes, words typed
 * whole split by vowel groups and leftover notes hold the last syllable;
 * syllables past the last note are dropped. Same rules as `/lyrics`.
 *
 * ```ts
 * notes: lyrics("sun-lit morn-ing glow", seq("C4 D4 E4 G4 E4"))
 * ```
 */
export function lyrics<N extends NoteSpec>(
  text: string,
  notes: readonly N[],
): readonly N[] {
  if (typeof text !== "string" || text.length > 2000)
    throw new DawgSdkError("lyrics text must be at most 2000 characters");
  if (!Array.isArray(notes))
    throw new DawgSdkError("lyrics needs an array of notes");
  const keyed = notes.map((n, index) => ({
    id: String(index),
    startTick: Math.round(n.start * 960),
    pitch: n.pitch,
  }));
  const { lyrics: sung } = assignLyrics(text, keyed);
  return Object.freeze(
    notes.map((n, index) => {
      const lyric = sung.get(String(index));
      if (lyric === undefined) {
        const { lyric: _drop, ...rest } = n as N & { lyric?: string };
        return Object.freeze(rest) as unknown as N;
      }
      return Object.freeze({ ...n, lyric }) as N;
    }),
  );
}

/** A clip for `song()`, ticks resolved and its default id filled. */
function storedClip(
  clip: AudioSpec,
  index: number,
  ticks: (beats: number) => number,
): Record<string, unknown> {
  const { kind: _kind, at, id, ...rest } = clip;
  return Object.freeze({
    id: id ?? defaultClipId(index),
    ...rest,
    startTick: ticks(at),
  });
}

/** The id a clip without one gets: `clip`, `clip2`, `clip3`, ... */
export function defaultClipId(index: number): string {
  return index === 0 ? "clip" : `clip${index + 1}`;
}

function storedTake(
  spec: TakeSpec,
  ticks: (beats: number) => number,
): Record<string, unknown> {
  const { kind: _kind, at, in: from, out: to, ...rest } = spec;
  return Object.freeze({
    offset: 0,
    latency: 0,
    ...rest,
    startTick: ticks(at),
    inTick: ticks(from),
    outTick: ticks(to),
  });
}

/** `track({ clips, takes })` as TrackSpec fields, paths project-relative. */
function trackClips(
  input: TrackInput,
  name: string,
  slug: string,
): { clips?: readonly AudioSpec[]; takes?: readonly TakeSpec[] } {
  const local = (src: string) => {
    const path = src.replace(/^\.\//, "");
    return path.startsWith("tracks/") || path.startsWith("pack:")
      ? path
      : `tracks/${slug}/${path}`;
  };
  const out: { clips?: readonly AudioSpec[]; takes?: readonly TakeSpec[] } = {};
  if (input.clips !== undefined) {
    if (!Array.isArray(input.clips))
      throw new DawgSdkError(
        `track ${name}: clips must be an array of audio()`,
      );
    const flat = (input.clips as readonly unknown[]).flat();
    const clips = flat.map((item, index) => {
      if (!isRecord(item) || item.kind !== "audio")
        throw new DawgSdkError(
          `track ${name}: clips[${index}] must come from audio() or repeatAudio()`,
        );
      const clip = item as AudioSpec;
      return Object.freeze({ ...clip, src: local(clip.src) }) as AudioSpec;
    });
    if (clips.length > 256)
      throw new DawgSdkError(`track ${name}: at most 256 clips`);
    if (clips.length > 0) out.clips = Object.freeze(clips);
  }
  if (input.takes !== undefined) {
    if (!Array.isArray(input.takes))
      throw new DawgSdkError(`track ${name}: takes must be an array of take()`);
    const takes = input.takes.map((item, index) => {
      if (!isRecord(item) || item.kind !== "take")
        throw new DawgSdkError(
          `track ${name}: takes[${index}] must come from take()`,
        );
      const spec = item as TakeSpec;
      return Object.freeze({ ...spec, src: local(spec.src) }) as TakeSpec;
    });
    if (takes.length > 0) out.takes = Object.freeze(takes);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new DawgSdkError(`${label} must be a finite number`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024)
    throw new DawgSdkError(`${label} must be a short string`);
  return value;
}

function beat(value: unknown, label: string): number {
  const number = finite(value, label);
  if (number < 0) throw new DawgSdkError(`${label} must be ≥ 0 beats`);
  return number;
}

function positive(value: unknown, label: string): number {
  const number = finite(value, label);
  if (number <= 0) throw new DawgSdkError(`${label} must be > 0`);
  return number;
}

function unit(value: unknown, label: string): number {
  const number = finite(value, label);
  if (number < 0 || number > 1)
    throw new DawgSdkError(`${label} must be between 0 and 1`);
  return number;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new DawgSdkError(`${label} must be true or false`);
  return value;
}

/** Rounds away floating-point noise from repeated addition (1e-9 beats). */
function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** 64-bit FNV-1a over UTF-16 code units as 16 hex characters (two 32-bit lanes). */
function hash64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ ((code * 31 + index) & 0xffff), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Continuous signals (SDK 1.35.0): Strudel's `sine`, `saw`, `rand`, `pat`, …
// as a small serializable AST, evaluated as f(cycle) → number. One cycle is
// one bar. They drive patch macros (`mods:`), patch inputs and any track's
// automation lanes (`lanes:`); `song()` bakes them into automation points.
// ---------------------------------------------------------------------------

/** The signal sources: Strudel's continuous patterns, `pat()` and a constant. */
export type SignalOp =
  | "sine"
  | "cosine"
  | "saw"
  | "isaw"
  | "tri"
  | "square"
  | "rand"
  | "perlin"
  | "irand"
  | "seq"
  | "const"
  | "self";

/** One transform, applied in order after the source. */
export type SignalTransform =
  | readonly ["range" | "rangex", number, number]
  | readonly ["slow" | "fast" | "segment" | "early" | "late", number]
  | readonly ["add" | "mul", number | PatternSignal]
  | readonly ["every", number, readonly SignalTransform[]];

/**
 * A continuous signal as data: a source (`op` and `args`) and transforms
 * (`xf`). Values follow Strudel's documented formulas; `rand`, `perlin`
 * and `irand` are seeded from the track id, so renders are deterministic.
 */
export class PatternSignal {
  readonly kind = "signal" as const;
  constructor(
    readonly op: SignalOp,
    readonly args: readonly (number | string)[] = [],
    readonly xf: readonly SignalTransform[] = [],
  ) {
    Object.freeze(this.args);
    Object.freeze(this.xf);
    Object.freeze(this);
  }
  private with(transform: SignalTransform): PatternSignal {
    return new PatternSignal(this.op, this.args, [...this.xf, transform]);
  }
  /** Maps 0..1 onto `lo..hi`, as Strudel's `.range`. */
  range(lo: number, hi: number): PatternSignal {
    return this.with(["range", finite(lo, "range lo"), finite(hi, "range hi")]);
  }
  /** Maps 0..1 onto `lo..hi` exponentially (both > 0), as `.rangex`. */
  rangex(lo: number, hi: number): PatternSignal {
    return this.with([
      "rangex",
      positive(lo, "rangex lo"),
      positive(hi, "rangex hi"),
    ]);
  }
  /** `n` times slower: one period spans `n` bars. */
  slow(n: number): PatternSignal {
    return this.with(["slow", positive(n, "slow")]);
  }
  /** `n` times faster. */
  fast(n: number): PatternSignal {
    return this.with(["fast", positive(n, "fast")]);
  }
  /** Holds `n` values per bar, each sampled at its segment's start. */
  segment(n: number): PatternSignal {
    return this.with(["segment", positive(n, "segment")]);
  }
  /** Adds a number or another signal. */
  add(value: number | PatternSignal): PatternSignal {
    return this.with(["add", signalOperand(value, "add")]);
  }
  /** Multiplies by a number or another signal. */
  mul(value: number | PatternSignal): PatternSignal {
    return this.with(["mul", signalOperand(value, "mul")]);
  }
  /** Shifts `bars` earlier in time. */
  early(bars: number): PatternSignal {
    return this.with(["early", finite(bars, "early")]);
  }
  /** Shifts `bars` later in time. */
  late(bars: number): PatternSignal {
    return this.with(["late", finite(bars, "late")]);
  }
  /**
   * Applies `transform` on every `n`th bar, starting with the first, as
   * Strudel's `every` (`firstOf`): `sine.every(4, (s) => s.fast(2))`.
   */
  every(
    n: number,
    transform: (signal: PatternSignal) => PatternSignal,
  ): PatternSignal {
    const count = finite(n, "every");
    if (!Number.isInteger(count) || count < 1)
      throw new DawgSdkError("every needs a whole number of bars ≥ 1");
    const applied = transform(new PatternSignal("self"));
    if (!(applied instanceof PatternSignal) || applied.op !== "self")
      throw new DawgSdkError(
        "every(n, f): f must return its argument with transforms, like (s) => s.fast(2)",
      );
    return this.with(["every", count, applied.xf]);
  }
}

function signalOperand(value: unknown, label: string): number | PatternSignal {
  if (value instanceof PatternSignal) return value;
  return finite(value, label);
}

/** True for a `PatternSignal`, including one rebuilt from plain data. */
export function isPatternSignal(value: unknown): value is PatternSignal {
  return (
    value instanceof PatternSignal ||
    (isRecord(value) && value.kind === "signal" && typeof value.op === "string")
  );
}

/** A sine 0..1 starting at 0.5 and rising (Strudel `sine`). */
export const sine = new PatternSignal("sine");
/** A cosine 0..1: `sine` a quarter bar early (Strudel `cosine`). */
export const cosine = new PatternSignal("cosine");
/** A ramp 0..1 each bar (Strudel `saw`). */
export const saw = new PatternSignal("saw");
/** A falling ramp 1..0 each bar (Strudel `isaw`). */
export const isaw = new PatternSignal("isaw");
/** A triangle 0..1..0 each bar (Strudel `tri`). */
export const tri = new PatternSignal("tri");
/** 0 for the first half of each bar, 1 for the second (Strudel `square`). */
export const square = new PatternSignal("square");
/** Seeded random 0..1, a fresh value at every instant (Strudel `rand`). */
export const rand = new PatternSignal("rand");
/** Seeded smooth noise 0..1 (Strudel `perlin`). */
export const perlin = new PatternSignal("perlin");

/** Seeded random whole numbers `0..n-1` (Strudel `irand(n)`). */
export function irand(n: number): PatternSignal {
  const count = finite(n, "irand");
  if (!Number.isInteger(count) || count < 1)
    throw new DawgSdkError("irand needs a whole number ≥ 1");
  return new PatternSignal("irand", [count]);
}

/**
 * Numbers in mini-notation, one bar per cycle: `pat("0 0.5 1")` steps
 * through three values a bar; `[a b]` subdivides a step, `<a b>` takes one
 * per bar, `x*2` repeats inside its step and `x!2` adds steps.
 */
export function pat(text: string): PatternSignal {
  if (typeof text !== "string" || text.length > 512)
    throw new DawgSdkError(
      "pat needs a mini-notation string (≤ 512 characters)",
    );
  parseMini(text);
  return new PatternSignal("seq", [text]);
}

/** A constant signal. */
export function steady(value: number): PatternSignal {
  return new PatternSignal("const", [finite(value, "steady")]);
}

type MiniNode =
  | Readonly<{ t: "num"; v: number }>
  | Readonly<{ t: "seq"; c: readonly MiniNode[] }>
  | Readonly<{ t: "alt"; c: readonly MiniNode[] }>
  | Readonly<{ t: "fast"; n: number; c: MiniNode }>;

const miniCache = new Map<string, MiniNode>();

function parseMini(text: string): MiniNode {
  const cached = miniCache.get(text);
  if (cached) return cached;
  const tokens = text.match(/\[|\]|<|>|\*|!|[^\s[\]<>*!]+/g) ?? [];
  let at = 0;
  const fail = (why: string): never => {
    throw new DawgSdkError(`pat("${text.slice(0, 40)}"): ${why}`);
  };
  const steps = (close: string | undefined): MiniNode[] => {
    const out: MiniNode[] = [];
    while (at < tokens.length && tokens[at] !== close) {
      const token = tokens[at]!;
      at += 1;
      let node: MiniNode;
      if (token === "[" || token === "<") {
        const inner = steps(token === "[" ? "]" : ">");
        if (tokens[at] !== (token === "[" ? "]" : ">"))
          fail(`unclosed ${token}`);
        at += 1;
        if (inner.length === 0) fail(`empty ${token}`);
        node = token === "[" ? { t: "seq", c: inner } : { t: "alt", c: inner };
      } else if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/.test(token))
        node = { t: "num", v: Number(token) };
      else fail(`"${token}" is not a number`);
      while (tokens[at] === "*" || tokens[at] === "!") {
        const op = tokens[at]!;
        const count = Number(tokens[at + 1]);
        if (
          !Number.isFinite(count) ||
          count <= 0 ||
          (op === "!" && !Number.isInteger(count))
        )
          fail(`${op} needs a positive number`);
        at += 2;
        if (op === "*") node = { t: "fast", n: count, c: node! };
        else for (let i = 1; i < count; i += 1) out.push(node!);
      }
      out.push(node!);
    }
    return out;
  };
  const top = steps(undefined);
  if (at < tokens.length) fail(`unexpected ${tokens[at]}`);
  if (top.length === 0) fail("no values");
  const root: MiniNode = { t: "seq", c: top };
  if (miniCache.size > 256) miniCache.clear();
  miniCache.set(text, root);
  return root;
}

/** Strudel's slowcat time rule: child `m mod n` sees its own cycles in a row. */
function catTime(t: number, n: number): [number, number] {
  const m = Math.floor(t);
  return [((m % n) + n) % n, t - (m - Math.floor(m / n))];
}

function miniAt(node: MiniNode, t: number): number {
  switch (node.t) {
    case "num":
      return node.v;
    case "fast":
      return miniAt(node.c, t * node.n);
    case "alt": {
      const [index, local] = catTime(t, node.c.length);
      return miniAt(node.c[index]!, local);
    }
    case "seq": {
      // fastcat = slowcat(...).fast(n)
      const [index, local] = catTime(t * node.c.length, node.c.length);
      return miniAt(node.c[index]!, local);
    }
  }
}

// Strudel's legacy random: xorshift over 300 cycles (signal.mjs).
function xorwise(x: number): number {
  const a = (x << 13) ^ x;
  const b = (a >> 17) ^ a;
  return (b << 5) ^ b;
}

function randAt(t: number): number {
  const fraction = (x: number) => x - Math.trunc(x);
  const seed = xorwise(Math.trunc(fraction(t / 300) * 536870912));
  return Math.abs((seed % 536870912) / 536870912);
}

function perlinAt(t: number, seed: number): number {
  const ta = Math.floor(t);
  const x = t - ta;
  const smoother = 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
  const a = randAt(ta + seed);
  const b = randAt(ta + 1 + seed);
  return a + smoother * (b - a);
}

function sourceAt(signal: PatternSignal, t: number, seed: number): number {
  const frac = t - Math.floor(t);
  switch (signal.op) {
    case "sine":
      return (Math.sin(Math.PI * 2 * t) + 1) / 2;
    case "cosine":
      return (Math.sin(Math.PI * 2 * (t + 0.25)) + 1) / 2;
    case "saw":
      return frac;
    case "isaw":
      return 1 - frac;
    case "tri":
      return frac < 0.5 ? frac * 2 : 2 - frac * 2;
    case "square":
      return Math.floor((((t * 2) % 2) + 2) % 2);
    case "rand":
      return randAt(t + seed);
    case "perlin":
      return perlinAt(t, seed);
    case "irand":
      return Math.trunc(randAt(t + seed) * Number(signal.args[0]));
    case "seq":
      return miniAt(parseMini(String(signal.args[0])), t);
    case "const":
      return Number(signal.args[0]);
    case "self":
      throw new DawgSdkError("a signal from every(n, f) cannot stand alone");
  }
}

function chainAt(
  signal: PatternSignal,
  xf: readonly SignalTransform[],
  count: number,
  t: number,
  seed: number,
): number {
  if (count === 0) return sourceAt(signal, t, seed);
  const step = xf[count - 1]!;
  const inner = (time: number) => chainAt(signal, xf, count - 1, time, seed);
  const operand = (value: number | PatternSignal) =>
    typeof value === "number" ? value : signalAt(value, t, seed);
  switch (step[0]) {
    case "range":
      return inner(t) * (step[2] - step[1]) + step[1];
    case "rangex": {
      const lo = Math.log(step[1]);
      return Math.exp(inner(t) * (Math.log(step[2]) - lo) + lo);
    }
    case "slow":
      return inner(t / step[1]);
    case "fast":
      return inner(t * step[1]);
    case "segment":
      return inner(Math.floor(t * step[1]) / step[1]);
    case "early":
      return inner(t + step[1]);
    case "late":
      return inner(t - step[1]);
    case "add":
      return inner(t) + operand(step[1]);
    case "mul":
      return inner(t) * operand(step[1]);
    case "every": {
      const cycle = Math.floor(t);
      if (((cycle % step[1]) + step[1]) % step[1] !== 0) return inner(t);
      const nested = [...xf.slice(0, count - 1), ...step[2]];
      return chainAt(signal, nested, nested.length, t, seed);
    }
  }
}

/**
 * A signal's value at `cycle` (bars from the song start). `seed` offsets
 * `rand`, `perlin` and `irand` in time, as Strudel's legacy `randSeed`;
 * `signalSeed(trackId)` is the seed `song()` uses.
 */
export function signalAt(
  signal: PatternSignal,
  cycle: number,
  seed = 0,
): number {
  return chainAt(signal, signal.xf, signal.xf.length, cycle, seed);
}

/** The seed a track's signals use: a whole number of cycles from its id. */
export function signalSeed(trackId: string): number {
  return Number.parseInt(hash64(`signal|${trackId}`).slice(0, 8), 16) % 300;
}

/** True when the signal steps between held values (baked as steps, not ramps). */
function signalSteps(signal: PatternSignal): boolean {
  const stepped = (xf: readonly SignalTransform[]): boolean =>
    xf.some(
      (step) =>
        step[0] === "segment" ||
        (step[0] === "every" && stepped(step[2])) ||
        ((step[0] === "add" || step[0] === "mul") &&
          step[1] instanceof PatternSignal &&
          signalSteps(step[1])),
    );
  return (
    ["square", "rand", "irand", "seq", "const"].includes(signal.op) ||
    stepped(signal.xf)
  );
}

/**
 * Automation points for a signal over a song: `[tick, value]` sampled on a
 * grid of at most 16 points a bar and 256 in all. Ramping signals keep
 * one point per sample (automation ramps between them); stepping signals
 * hold each value until one tick before the next.
 */
export function bakeSignal(
  signal: PatternSignal,
  options: Readonly<{
    bars: number;
    ticksPerBar: number;
    seed: number;
    map?: (value: number) => number;
  }>,
): readonly Readonly<{ tick: number; value: number }>[] {
  const steps = signalSteps(signal);
  const budget = steps ? 128 : 256;
  const perBar = Math.max(
    1,
    Math.min(16, Math.floor(budget / Math.max(1, options.bars))),
  );
  const count = Math.max(1, Math.min(budget, Math.ceil(options.bars * perBar)));
  const map = options.map ?? ((value: number) => value);
  const out: { tick: number; value: number }[] = [];
  const push = (tick: number, value: number) => {
    const last = out[out.length - 1];
    if (last && last.tick >= tick) return;
    out.push({ tick, value });
  };
  const ticksAt = (k: number) => Math.round((k * options.ticksPerBar) / perBar);
  for (let k = 0; k < count; k += 1) {
    // Six decimals: below any audible step, and the points print clean.
    const value =
      Math.round(map(signalAt(signal, k / perBar, options.seed)) * 1e6) / 1e6 ||
      0;
    if (!Number.isFinite(value))
      throw new DawgSdkError("a signal produced a value that is not finite");
    const tick = ticksAt(k);
    if (steps) {
      const previous = out[out.length - 1];
      if (previous && previous.value === value) continue;
      if (previous && ticksAt(k) - 1 > previous.tick)
        push(tick - 1, previous.value);
      push(tick, value);
    } else push(tick, value);
  }
  // Drop the middle of three equal points: they say nothing.
  const lean = out.filter(
    (point, index) =>
      index === 0 ||
      index === out.length - 1 ||
      !(
        out[index - 1]!.value === point.value &&
        out[index + 1]!.value === point.value
      ),
  );
  return Object.freeze(lean.map((point) => Object.freeze(point)));
}

/**
 * The lowest and highest values a signal takes over its first 16 bars,
 * sampled 64 times a bar; patches size a signal's hidden macro from it.
 */
export function signalBounds(
  signal: PatternSignal,
  seed = 0,
): readonly [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 16 * 64; k += 1) {
    const value = signalAt(signal, k / 64, seed);
    if (!Number.isFinite(value))
      throw new DawgSdkError("a signal produced a value that is not finite");
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  // Round outward to 1e-6 so float noise (0.8999999999999999) prints clean.
  const down = Math.floor(lo * 1e6 + 1e-6) / 1e6;
  const up = Math.ceil(hi * 1e6 - 1e-6) / 1e6;
  return [down, Math.max(up, down)];
}

const SIGNAL_OPS: readonly SignalOp[] = [
  "sine",
  "cosine",
  "saw",
  "isaw",
  "tri",
  "square",
  "rand",
  "perlin",
  "irand",
  "seq",
  "const",
];

/** Rebuilds a signal from its plain data (`{ kind: "signal", op, args, xf }`), checking every field. */
export function signalFromData(input: unknown, depth = 0): PatternSignal {
  if (input instanceof PatternSignal) return input;
  if (!isRecord(input) || input.kind !== "signal")
    throw new DawgSdkError("a signal must come from sine, saw, pat(), …");
  if (depth > 8) throw new DawgSdkError("signals nest at most 8 deep");
  const op = input.op as SignalOp;
  if (!SIGNAL_OPS.includes(op))
    throw new DawgSdkError(`unknown signal "${String(input.op).slice(0, 32)}"`);
  const args = Array.isArray(input.args) ? input.args : [];
  let base: PatternSignal;
  if (op === "irand") base = irand(args[0] as number);
  else if (op === "seq") base = pat(args[0] as string);
  else if (op === "const") base = steady(args[0] as number);
  else base = new PatternSignal(op);
  const xf = Array.isArray(input.xf) ? input.xf : [];
  if (xf.length > 32)
    throw new DawgSdkError("a signal holds at most 32 transforms");
  const apply = (
    signal: PatternSignal,
    steps: readonly unknown[],
  ): PatternSignal =>
    steps.reduce<PatternSignal>((acc, raw) => {
      if (!Array.isArray(raw))
        throw new DawgSdkError("a signal transform must be a list");
      const [name, a, b] = raw as [string, unknown, unknown];
      switch (name) {
        case "range":
        case "rangex":
          return acc[name](a as number, b as number);
        case "slow":
        case "fast":
        case "segment":
        case "early":
        case "late":
          return acc[name](a as number);
        case "add":
        case "mul":
          return acc[name](
            typeof a === "number" ? a : signalFromData(a, depth + 1),
          );
        case "every": {
          if (!Array.isArray(b) || b.length > 32)
            throw new DawgSdkError("every holds at most 32 transforms");
          return acc.every(a as number, (self) => apply(self, b));
        }
        default:
          throw new DawgSdkError(
            `unknown signal transform "${String(name).slice(0, 32)}"`,
          );
      }
    }, signal);
  return apply(base, xf);
}

// ---------------------------------------------------------------------------
// Modular patches (SDK 1.35.0): `patch(name, build)` records a small typed
// graph of nodes, cables and macros as the plain data dawg stores
// (`core/patch.ts`). dawg validates it when it loads the song.
// ---------------------------------------------------------------------------

// BEGIN patch nodes: generated from core/patch-nodes.ts by scripts/gen-patch-sdk.ts

/** Port codes: `n` notes, `a` audio, `c` control, `ca` control that also takes audio. */
export type PatchPortCode = "n" | "a" | "c" | "ca";

/** Every patch node type: its main output's port code, settings, input ports and output ports (NODE_SPECS). */
export type PatchNodeTable = {
  /** oscillator: sine, saw, square, triangle or pulse, with linear FM */
  osc: {
    main: "a";
    params: {
      /** waveform (saw, square and pulse are band-limited with PolyBLEP) (default "saw") */
      wave?: "sine" | "saw" | "square" | "tri" | "pulse";
      /** frequency in Hz (wire voice.pitch to play the note) (0..20000 Hz, default 440) */
      pitch?: number;
      /** detune in cents (-1200..1200 ct, default 0) */
      detune?: number;
      /** pulse width (pulse wave) (0.01..0.99, default 0.5) */
      pw?: number;
      /** output level (0..4, default 1) */
      level?: number;
    };
    inputs: {
      /** frequency in Hz (wire voice.pitch to play the note) */
      pitch: "ca";
      /** detune in cents */
      detune: "c";
      /** pulse width (pulse wave) */
      pw: "c";
      /** linear FM: Hz added to the pitch, at audio rate */
      fm: "a";
      /** output level */
      level: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** seeded noise: white, pink or brown */
  noise: {
    main: "a";
    params: {
      /** noise color (default "white") */
      color?: "white" | "pink" | "brown";
      /** output level (0..4, default 1) */
      level?: number;
    };
    inputs: {
      /** output level */
      level: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** state-variable filter (TPT): low, high, band or notch */
  svf: {
    main: "a";
    params: {
      /** filter response (default "lp") */
      mode?: "lp" | "hp" | "bp" | "notch";
      /** cutoff frequency in Hz (20..20000 Hz, default 1000) */
      cutoff?: number;
      /** resonance 0..1 (0..1, default 0.5) */
      q?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** cutoff frequency in Hz */
      cutoff: "c";
      /** resonance 0..1 */
      q: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** one-pole low- or high-pass (6 dB/oct) */
  onepole: {
    main: "a";
    params: {
      /** filter response (default "lp") */
      mode?: "lp" | "hp";
      /** cutoff frequency in Hz (20..20000 Hz, default 1000) */
      cutoff?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** cutoff frequency in Hz */
      cutoff: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** attack, decay, sustain, release envelope 0..1, opened by a gate */
  adsr: {
    main: "c";
    params: {
      /** gate: above 0.5 opens (wire voice.gate) (0..1, default 0) */
      gate?: number;
      /** attack time (0..10 s, default 0.01) */
      attack?: number;
      /** decay time (0..10 s, default 0.1) */
      decay?: number;
      /** sustain level (0..1, default 0.7) */
      sustain?: number;
      /** release time (0..10 s, default 0.2) */
      release?: number;
    };
    inputs: {
      /** gate: above 0.5 opens (wire voice.gate) */
      gate: "c";
      /** attack time */
      attack: "c";
      /** decay time */
      decay: "c";
      /** sustain level */
      sustain: "c";
      /** release time */
      release: "c";
    };
    outputs: {
      /** envelope 0..1 */
      out: "c";
    };
  };
  /** attack-release envelope 0..1 that follows a gate */
  ar: {
    main: "c";
    params: {
      /** gate: above 0.5 opens (0..1, default 0) */
      gate?: number;
      /** attack time (0..10 s, default 0.01) */
      attack?: number;
      /** release time (0..10 s, default 0.2) */
      release?: number;
    };
    inputs: {
      /** gate: above 0.5 opens */
      gate: "c";
      /** attack time */
      attack: "c";
      /** release time */
      release: "c";
    };
    outputs: {
      /** envelope 0..1 */
      out: "c";
    };
  };
  /** slew limiter: glides a control toward its input */
  slew: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
      /** time to rise by one unit (0..10 s, default 0.05) */
      rise?: number;
      /** time to fall by one unit (0..10 s, default 0.05) */
      fall?: number;
    };
    inputs: {
      /** input */
      in: "c";
      /** time to rise by one unit */
      rise: "c";
      /** time to fall by one unit */
      fall: "c";
    };
    outputs: {
      /** slewed value */
      out: "c";
    };
  };
  /** envelope follower: the level of an audio signal as a control */
  follow: {
    main: "c";
    params: {
      /** attack time (0.0001..1 s, default 0.005) */
      attack?: number;
      /** release time (0.001..4 s, default 0.1) */
      release?: number;
    };
    inputs: {
      /** audio to follow */
      in: "a";
      /** attack time */
      attack: "c";
      /** release time */
      release: "c";
    };
    outputs: {
      /** level 0..1 */
      out: "c";
    };
  };
  /** low-frequency oscillator -1..1, free in Hz or synced to beats */
  lfo: {
    main: "c";
    params: {
      /** wave shape (random is seeded sample-and-hold per cycle) (default "sine") */
      shape?: "sine" | "tri" | "square" | "saw" | "ramp" | "random";
      /** period in beats; 0 follows rate (0..64 beats, default 0) */
      sync?: number;
      /** rate in Hz (when sync is 0) (0..100 Hz, default 1) */
      rate?: number;
      /** phase offset in cycles (0..1, default 0) */
      phase?: number;
      /** output depth (0..1, default 1) */
      depth?: number;
    };
    inputs: {
      /** rate in Hz (when sync is 0) */
      rate: "c";
      /** phase offset in cycles */
      phase: "c";
      /** output depth */
      depth: "c";
    };
    outputs: {
      /** -1..1 */
      out: "c";
    };
  };
  /** sample and hold: latches its input when the trigger rises */
  sh: {
    main: "c";
    params: {
      /** value to sample (-1000000..1000000, default 0) */
      in?: number;
      /** trigger: a rise through 0.5 samples (0..1, default 0) */
      trig?: number;
    };
    inputs: {
      /** value to sample */
      in: "c";
      /** trigger: a rise through 0.5 samples */
      trig: "c";
    };
    outputs: {
      /** held value */
      out: "c";
    };
  };
  /** seeded random value 0..1, drawn per note or per block */
  random: {
    main: "c";
    params: {
      /** when a new value is drawn (default "note") */
      per?: "note" | "block";
    };
    inputs: {};
    outputs: {
      /** 0..1 */
      out: "c";
    };
  };
  /** a constant control value */
  const: {
    main: "c";
    params: {
      /** the value (-1000000..1000000, default 0) */
      value?: number;
    };
    inputs: {};
    outputs: {
      /** the value */
      out: "c";
    };
  };
  /** a + b */
  add: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** a × b */
  mul: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 1) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** the smaller of a and b */
  min: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** the larger of a and b */
  max: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** 1 when a > b, else 0 */
  gt: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** 1 when a < b, else 0 */
  lt: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** |in| */
  abs: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
    };
    inputs: {
      /** input */
      in: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** 1 when in < 0.5, else 0 */
  not: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
    };
    inputs: {
      /** input */
      in: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** MIDI note number to Hz (12-TET, A4 = 440) */
  pitch2hz: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
    };
    inputs: {
      /** input */
      in: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** decibels to linear gain */
  db2gain: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
    };
    inputs: {
      /** input */
      in: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** maps in from [inmin, inmax] to [min, max], linear or exponential */
  scale: {
    main: "c";
    params: {
      /** lin or exp (exp needs min > 0) (default "lin") */
      curve?: "lin" | "exp";
      /** input (-1000000..1000000, default 0) */
      in?: number;
      /** input range low (-1000000..1000000, default -1) */
      inmin?: number;
      /** input range high (-1000000..1000000, default 1) */
      inmax?: number;
      /** output range low (-1000000..1000000, default 0) */
      min?: number;
      /** output range high (-1000000..1000000, default 1) */
      max?: number;
    };
    inputs: {
      /** input */
      in: "c";
      /** input range low */
      inmin: "c";
      /** input range high */
      inmax: "c";
      /** output range low */
      min: "c";
      /** output range high */
      max: "c";
    };
    outputs: {
      /** mapped value */
      out: "c";
    };
  };
  /** limits in to [min, max] */
  clamp: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
      /** low limit (-1000000..1000000, default 0) */
      min?: number;
      /** high limit (-1000000..1000000, default 1) */
      max?: number;
    };
    inputs: {
      /** input */
      in: "c";
      /** low limit */
      min: "c";
      /** high limit */
      max: "c";
    };
    outputs: {
      /** clamped value */
      out: "c";
    };
  };
  /** tempo-synced gate: high for the first half of each cycle */
  clock: {
    main: "c";
    params: {
      /** period in beats (0.0625..64 beats, default 1) */
      beats?: number;
      /** high fraction (0.01..0.99, default 0.5) */
      width?: number;
    };
    inputs: {
      /** high fraction */
      width: "c";
    };
    outputs: {
      /** gate 0/1 */
      out: "c";
    };
  };
  /** amplifier: audio times gain (wire an envelope to gain) */
  vca: {
    main: "a";
    params: {
      /** gain (0..4, default 1) */
      gain?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** gain */
      gain: "ca";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** four-input audio mixer with a level per input */
  mix: {
    main: "a";
    params: {
      /** level of a (0..4, default 1) */
      la?: number;
      /** level of b (0..4, default 1) */
      lb?: number;
      /** level of c (0..4, default 1) */
      lc?: number;
      /** level of d (0..4, default 1) */
      ld?: number;
    };
    inputs: {
      /** input a */
      a: "a";
      /** input b */
      b: "a";
      /** input c */
      c: "a";
      /** input d */
      d: "a";
      /** level of a */
      la: "c";
      /** level of b */
      lb: "c";
      /** level of c */
      lc: "c";
      /** level of d */
      ld: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** equal-gain crossfade from a (x = 0) to b (x = 1) */
  xfade: {
    main: "a";
    params: {
      /** crossfade position (0..1, default 0.5) */
      x?: number;
    };
    inputs: {
      /** input a */
      a: "a";
      /** input b */
      b: "a";
      /** crossfade position */
      x: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** equal-power pan of a mono signal to left and right */
  pan: {
    main: "a";
    params: {
      /** -1 left .. 1 right (-1..1, default 0) */
      pan?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** -1 left .. 1 right */
      pan: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** explicit voice sum: every voice's input, summed once for the track */
  voicesum: {
    main: "a";
    params: {};
    inputs: {
      /** per-voice audio */
      in: "a";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** the whole synth voice (oscillators, FM, unison, filters, envelopes), samplers and wavetables included */
  "engine.synth": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "") */
      instrument?: string;
      /** amplitude attack: onset to peak (0..10 s, default 0.003) */
      attack?: number;
      /** amplitude decay: peak to sustain level (0..10 s, default 0.05) */
      decay?: number;
      /** amplitude sustain level held until note-off (0..1, default 1) */
      sustain?: number;
      /** amplitude release after note-off (0..10 s, default 0.05) */
      release?: number;
      /** voice gain before the effects chain (track volume follows the chain) (0..4, default 1) */
      gain?: number;
      /** pink noise mixed into the oscillator (z_* sounds: phase jitter) (0..1, default 0) */
      noise?: number;
      /** crackle density (impulses ≈ density·1000/s) (0..1, default 0.03) */
      density?: number;
      /** total pitch spread of the unison voices in semitones (0..12 st, default 0.2) */
      detune?: number;
      /** stereo spread of the unison voices (0..1, default 0.6) */
      spread?: number;
      /** pulse width (pulse sound) (0..1, default 0.5) */
      pw?: number;
      /** pulse-width LFO rate (triangle) (0..40 Hz, default 1) */
      pwrate?: number;
      /** pulse-width LFO depth (0..1, default 0) */
      pwsweep?: number;
      /** vibrato rate; 0 is off (0..64 Hz, default 0) */
      vib?: number;
      /** vibrato depth in semitones (0..24 st, default 0.5) */
      vibmod?: number;
      /** pitch envelope depth in semitones (negative inverts); 0 is off (-48..48 st, default 0) */
      penv?: number;
      /** pitch envelope attack (0..10 s, default 0.2) */
      pattack?: number;
      /** pitch envelope decay (0..10 s, default 0) */
      pdecay?: number;
      /** pitch envelope sustain level (0..1, default 1) */
      psustain?: number;
      /** pitch envelope release (0..10 s, default 0) */
      prelease?: number;
      /** per-note low-pass cutoff; unset is no low-pass (20..20000 Hz, default 2000) */
      lpf?: number;
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) (0..50, default 1) */
      lpq?: number;
      /** low-pass envelope depth in octaves above (below, negative) the cutoff (-10..10 oct, default 0) */
      lpenv?: number;
      /** low-pass envelope attack (0..10 s, default 0.005) */
      lpattack?: number;
      /** low-pass envelope decay (0..10 s, default 0.15) */
      lpdecay?: number;
      /** low-pass envelope sustain level (0..1, default 0) */
      lpsustain?: number;
      /** low-pass envelope release (0..10 s, default 0.1) */
      lprelease?: number;
      /** per-note high-pass cutoff; unset is no high-pass (20..20000 Hz, default 200) */
      hpf?: number;
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) (0..50, default 1) */
      hpq?: number;
      /** high-pass envelope depth in octaves above (below, negative) the cutoff (-10..10 oct, default 0) */
      hpenv?: number;
      /** high-pass envelope attack (0..10 s, default 0.005) */
      hpattack?: number;
      /** high-pass envelope decay (0..10 s, default 0.15) */
      hpdecay?: number;
      /** high-pass envelope sustain level (0..1, default 0) */
      hpsustain?: number;
      /** high-pass envelope release (0..10 s, default 0.1) */
      hprelease?: number;
      /** per-note band-pass cutoff; unset is no band-pass (20..20000 Hz, default 1000) */
      bpf?: number;
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) (0..50, default 1) */
      bpq?: number;
      /** band-pass envelope depth in octaves above (below, negative) the cutoff (-10..10 oct, default 0) */
      bpenv?: number;
      /** band-pass envelope attack (0..10 s, default 0.005) */
      bpattack?: number;
      /** band-pass envelope decay (0..10 s, default 0.15) */
      bpdecay?: number;
      /** band-pass envelope sustain level (0..1, default 0) */
      bpsustain?: number;
      /** band-pass envelope release (0..10 s, default 0.1) */
      bprelease?: number;
      /** filter envelope anchor: 0 sweeps up from the cutoff, 1 down to it (0..1, default 0) */
      fanchor?: number;
      /** FM modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm?: number;
      /** FM harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh?: number;
      /** FM envelope attack (0..10 s, default 0) */
      fmattack?: number;
      /** FM envelope decay (0..10 s, default 0) */
      fmdecay?: number;
      /** FM envelope sustain level (0..1, default 1) */
      fmsustain?: number;
      /** FM envelope release (0..10 s, default 0) */
      fmrelease?: number;
      /** FM 2 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm2?: number;
      /** FM 2 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh2?: number;
      /** FM 2 envelope attack (0..10 s, default 0) */
      fmattack2?: number;
      /** FM 2 envelope decay (0..10 s, default 0) */
      fmdecay2?: number;
      /** FM 2 envelope sustain level (0..1, default 1) */
      fmsustain2?: number;
      /** FM 2 envelope release (0..10 s, default 0) */
      fmrelease2?: number;
      /** FM 3 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm3?: number;
      /** FM 3 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh3?: number;
      /** FM 3 envelope attack (0..10 s, default 0) */
      fmattack3?: number;
      /** FM 3 envelope decay (0..10 s, default 0) */
      fmdecay3?: number;
      /** FM 3 envelope sustain level (0..1, default 1) */
      fmsustain3?: number;
      /** FM 3 envelope release (0..10 s, default 0) */
      fmrelease3?: number;
      /** FM 4 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm4?: number;
      /** FM 4 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh4?: number;
      /** FM 4 envelope attack (0..10 s, default 0) */
      fmattack4?: number;
      /** FM 4 envelope decay (0..10 s, default 0) */
      fmdecay4?: number;
      /** FM 4 envelope sustain level (0..1, default 1) */
      fmsustain4?: number;
      /** FM 4 envelope release (0..10 s, default 0) */
      fmrelease4?: number;
      /** FM 5 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm5?: number;
      /** FM 5 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh5?: number;
      /** FM 5 envelope attack (0..10 s, default 0) */
      fmattack5?: number;
      /** FM 5 envelope decay (0..10 s, default 0) */
      fmdecay5?: number;
      /** FM 5 envelope sustain level (0..1, default 1) */
      fmsustain5?: number;
      /** FM 5 envelope release (0..10 s, default 0) */
      fmrelease5?: number;
      /** FM 6 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm6?: number;
      /** FM 6 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh6?: number;
      /** FM 6 envelope attack (0..10 s, default 0) */
      fmattack6?: number;
      /** FM 6 envelope decay (0..10 s, default 0) */
      fmdecay6?: number;
      /** FM 6 envelope sustain level (0..1, default 1) */
      fmsustain6?: number;
      /** FM 6 envelope release (0..10 s, default 0) */
      fmrelease6?: number;
      /** FM 7 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm7?: number;
      /** FM 7 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh7?: number;
      /** FM 7 envelope attack (0..10 s, default 0) */
      fmattack7?: number;
      /** FM 7 envelope decay (0..10 s, default 0) */
      fmdecay7?: number;
      /** FM 7 envelope sustain level (0..1, default 1) */
      fmsustain7?: number;
      /** FM 7 envelope release (0..10 s, default 0) */
      fmrelease7?: number;
      /** FM 8 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm8?: number;
      /** FM 8 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh8?: number;
      /** FM 8 envelope attack (0..10 s, default 0) */
      fmattack8?: number;
      /** FM 8 envelope decay (0..10 s, default 0) */
      fmdecay8?: number;
      /** FM 8 envelope sustain level (0..1, default 1) */
      fmsustain8?: number;
      /** FM 8 envelope release (0..10 s, default 0) */
      fmrelease8?: number;
      /** z_*: random pitch offset per note, ± fraction (0..1, default 0) */
      zrand?: number;
      /** z_*: wave shape exponent (0 squares the wave off, >1 thins it) (0..3, default 1) */
      curve?: number;
      /** z_*: pitch slide, 500·slide Hz per second (-20..20, default 0) */
      slide?: number;
      /** z_*: slide acceleration, 500·deltaSlide Hz per second² (-20..20, default 0) */
      deltaSlide?: number;
      /** z_*: pitch change applied after pitchJumpTime (-2000..2000 Hz, default 0) */
      pitchJump?: number;
      /** z_*: time before pitchJump applies (0: never) (0..10 s, default 0) */
      pitchJumpTime?: number;
      /** z_*: repeat period: restarts slide and pitchJump, sets the tremolo period (0..10 s, default 0) */
      lfo?: number;
      /** z_*: frequency-modulation speed (±50 % depth) (0..1000 Hz, default 0) */
      zmod?: number;
      /** z_*: sample-hold bit crush, 0..1 (0..1, default 0) */
      zcrush?: number;
      /** z_*: one echo this many seconds later, half level (0..1 s, default 0) */
      zdelay?: number;
      /** z_*: volume modulation amount at the lfo period (0..1, default 0) */
      tremolo?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** amplitude attack: onset to peak */
      attack: "c";
      /** amplitude decay: peak to sustain level */
      decay: "c";
      /** amplitude sustain level held until note-off */
      sustain: "c";
      /** amplitude release after note-off */
      release: "c";
      /** voice gain before the effects chain (track volume follows the chain) */
      gain: "c";
      /** pink noise mixed into the oscillator (z_* sounds: phase jitter) */
      noise: "c";
      /** crackle density (impulses ≈ density·1000/s) */
      density: "c";
      /** total pitch spread of the unison voices in semitones */
      detune: "c";
      /** stereo spread of the unison voices */
      spread: "c";
      /** pulse width (pulse sound) */
      pw: "c";
      /** pulse-width LFO rate (triangle) */
      pwrate: "c";
      /** pulse-width LFO depth */
      pwsweep: "c";
      /** vibrato rate; 0 is off */
      vib: "c";
      /** vibrato depth in semitones */
      vibmod: "c";
      /** pitch envelope depth in semitones (negative inverts); 0 is off */
      penv: "c";
      /** pitch envelope attack */
      pattack: "c";
      /** pitch envelope decay */
      pdecay: "c";
      /** pitch envelope sustain level */
      psustain: "c";
      /** pitch envelope release */
      prelease: "c";
      /** per-note low-pass cutoff; unset is no low-pass */
      lpf: "c";
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) */
      lpq: "c";
      /** low-pass envelope depth in octaves above (below, negative) the cutoff */
      lpenv: "c";
      /** low-pass envelope attack */
      lpattack: "c";
      /** low-pass envelope decay */
      lpdecay: "c";
      /** low-pass envelope sustain level */
      lpsustain: "c";
      /** low-pass envelope release */
      lprelease: "c";
      /** per-note high-pass cutoff; unset is no high-pass */
      hpf: "c";
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) */
      hpq: "c";
      /** high-pass envelope depth in octaves above (below, negative) the cutoff */
      hpenv: "c";
      /** high-pass envelope attack */
      hpattack: "c";
      /** high-pass envelope decay */
      hpdecay: "c";
      /** high-pass envelope sustain level */
      hpsustain: "c";
      /** high-pass envelope release */
      hprelease: "c";
      /** per-note band-pass cutoff; unset is no band-pass */
      bpf: "c";
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) */
      bpq: "c";
      /** band-pass envelope depth in octaves above (below, negative) the cutoff */
      bpenv: "c";
      /** band-pass envelope attack */
      bpattack: "c";
      /** band-pass envelope decay */
      bpdecay: "c";
      /** band-pass envelope sustain level */
      bpsustain: "c";
      /** band-pass envelope release */
      bprelease: "c";
      /** filter envelope anchor: 0 sweeps up from the cutoff, 1 down to it */
      fanchor: "c";
      /** FM modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm: "c";
      /** FM harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh: "c";
      /** FM envelope attack */
      fmattack: "c";
      /** FM envelope decay */
      fmdecay: "c";
      /** FM envelope sustain level */
      fmsustain: "c";
      /** FM envelope release */
      fmrelease: "c";
      /** FM 2 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm2: "c";
      /** FM 2 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh2: "c";
      /** FM 2 envelope attack */
      fmattack2: "c";
      /** FM 2 envelope decay */
      fmdecay2: "c";
      /** FM 2 envelope sustain level */
      fmsustain2: "c";
      /** FM 2 envelope release */
      fmrelease2: "c";
      /** FM 3 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm3: "c";
      /** FM 3 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh3: "c";
      /** FM 3 envelope attack */
      fmattack3: "c";
      /** FM 3 envelope decay */
      fmdecay3: "c";
      /** FM 3 envelope sustain level */
      fmsustain3: "c";
      /** FM 3 envelope release */
      fmrelease3: "c";
      /** FM 4 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm4: "c";
      /** FM 4 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh4: "c";
      /** FM 4 envelope attack */
      fmattack4: "c";
      /** FM 4 envelope decay */
      fmdecay4: "c";
      /** FM 4 envelope sustain level */
      fmsustain4: "c";
      /** FM 4 envelope release */
      fmrelease4: "c";
      /** FM 5 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm5: "c";
      /** FM 5 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh5: "c";
      /** FM 5 envelope attack */
      fmattack5: "c";
      /** FM 5 envelope decay */
      fmdecay5: "c";
      /** FM 5 envelope sustain level */
      fmsustain5: "c";
      /** FM 5 envelope release */
      fmrelease5: "c";
      /** FM 6 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm6: "c";
      /** FM 6 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh6: "c";
      /** FM 6 envelope attack */
      fmattack6: "c";
      /** FM 6 envelope decay */
      fmdecay6: "c";
      /** FM 6 envelope sustain level */
      fmsustain6: "c";
      /** FM 6 envelope release */
      fmrelease6: "c";
      /** FM 7 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm7: "c";
      /** FM 7 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh7: "c";
      /** FM 7 envelope attack */
      fmattack7: "c";
      /** FM 7 envelope decay */
      fmdecay7: "c";
      /** FM 7 envelope sustain level */
      fmsustain7: "c";
      /** FM 7 envelope release */
      fmrelease7: "c";
      /** FM 8 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm8: "c";
      /** FM 8 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh8: "c";
      /** FM 8 envelope attack */
      fmattack8: "c";
      /** FM 8 envelope decay */
      fmdecay8: "c";
      /** FM 8 envelope sustain level */
      fmsustain8: "c";
      /** FM 8 envelope release */
      fmrelease8: "c";
      /** z_*: random pitch offset per note, ± fraction */
      zrand: "c";
      /** z_*: wave shape exponent (0 squares the wave off, >1 thins it) */
      curve: "c";
      /** z_*: pitch slide, 500·slide Hz per second */
      slide: "c";
      /** z_*: slide acceleration, 500·deltaSlide Hz per second² */
      deltaSlide: "c";
      /** z_*: pitch change applied after pitchJumpTime */
      pitchJump: "c";
      /** z_*: time before pitchJump applies (0: never) */
      pitchJumpTime: "c";
      /** z_*: repeat period: restarts slide and pitchJump, sets the tremolo period */
      lfo: "c";
      /** z_*: frequency-modulation speed (±50 % depth) */
      zmod: "c";
      /** z_*: sample-hold bit crush, 0..1 */
      zcrush: "c";
      /** z_*: one echo this many seconds later, half level */
      zdelay: "c";
      /** z_*: volume modulation amount at the lfo period */
      tremolo: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** modal resonators: mallets, bars, bells and plates */
  "engine.modal": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "modal") */
      instrument?: "modal";
      /** mallet hardness: 0 yarn/felt, 1 brass (0..1, default 0.4) */
      hardness?: number;
      /** strike point: 0 end or edge, 0.5 center (0..1, default 0.42) */
      position?: number;
      /** ring time (T60) at middle C (0.05..30 s, default 1.6) */
      ring?: number;
      /** how much faster high modes and notes decay (0..2, default 0.9) */
      tilt?: number;
      /** damping at note-off: 0 rings on, 1 chokes (0..1, default 0) */
      damp?: number;
      /** motor tremolo depth (0..1, default 0) */
      motordepth?: number;
      /** buzzer or jingle amount (0..1, default 0) */
      buzz?: number;
      /** mallet contact click (0..1, default 0) */
      click?: number;
      /** level (0..2, default 0.8) */
      gain?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** mallet hardness: 0 yarn/felt, 1 brass */
      hardness: "c";
      /** strike point: 0 end or edge, 0.5 center */
      position: "c";
      /** ring time (T60) at middle C */
      ring: "c";
      /** how much faster high modes and notes decay */
      tilt: "c";
      /** damping at note-off: 0 rings on, 1 chokes */
      damp: "c";
      /** motor tremolo depth */
      motordepth: "c";
      /** buzzer or jingle amount */
      buzz: "c";
      /** mallet contact click */
      click: "c";
      /** level */
      gain: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** physically modeled plucked and bowed strings */
  "engine.string": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "string") */
      instrument?: "string";
      /** how long a note rings (T60 at C4) (0.05..60 s, default 3) */
      ring?: number;
      /** high-frequency loss (dark, dead strings at 1) (0..1, default 0.4) */
      damp?: number;
      /** pluck or strike position from the bridge (0.5 round, 0.04 nasal) (0.02..0.5, default 0.15) */
      pos?: number;
      /** excitation brightness at full velocity (0..1, default 0.6) */
      bright?: number;
      /** palm mute: shortens the ring and darkens the string (0..1, default 0) */
      mute?: number;
      /** bridge buzz (sitar, tanpura jawari); 0 off (0..1, default 0) */
      buzz?: number;
      /** vibrato rate (a note's own vibrato overrides it) (0..12 Hz, default 0) */
      vib?: number;
      /** vibrato depth in semitones (0..2 st, default 0.18) */
      vibmod?: number;
      /** output level (presets carry a calibrated trim) (0..2, default 1) */
      gain?: number;
      /** bow force within the playable range: flautando at 0, gritty at 1 (0..1, default 0.5) */
      pressure?: number;
      /** bow speed at full dynamics (loudness) (0..1, default 0.6) */
      speed?: number;
      /** con sordino: the practice mute, darker and softer (0..1, default 0) */
      sord?: number;
      /** dynamics on top of velocity, drives bow speed and pressure (swells) (0..1, default 1) */
      dyn?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** how long a note rings (T60 at C4) */
      ring: "c";
      /** high-frequency loss (dark, dead strings at 1) */
      damp: "c";
      /** pluck or strike position from the bridge (0.5 round, 0.04 nasal) */
      pos: "c";
      /** excitation brightness at full velocity */
      bright: "c";
      /** palm mute: shortens the ring and darkens the string */
      mute: "c";
      /** bridge buzz (sitar, tanpura jawari); 0 off */
      buzz: "c";
      /** vibrato rate (a note's own vibrato overrides it) */
      vib: "c";
      /** vibrato depth in semitones */
      vibmod: "c";
      /** output level (presets carry a calibrated trim) */
      gain: "c";
      /** bow force within the playable range: flautando at 0, gritty at 1 */
      pressure: "c";
      /** bow speed at full dynamics (loudness) */
      speed: "c";
      /** con sordino: the practice mute, darker and softer */
      sord: "c";
      /** dynamics on top of velocity, drives bow speed and pressure (swells) */
      dyn: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** physically modeled winds and brass */
  "engine.wind": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "wind") */
      instrument?: "wind";
      /** blowing pressure: swells, louder and fuller (0..1, default 0.6) */
      breath?: number;
      /** breath noise (0..1, default 0.08) */
      noise?: number;
      /** plunger opening: 0 closed, 1 open (0..1, default 1) */
      wah?: number;
      /** hum into the horn: rough, raspy (0..1, default 0) */
      growl?: number;
      /** flutter tongue (rolled r) (0..1, default 0) */
      flutter?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** blowing pressure: swells, louder and fuller */
      breath: "c";
      /** breath noise */
      noise: "c";
      /** plunger opening: 0 closed, 1 open */
      wah: "c";
      /** hum into the horn: rough, raspy */
      growl: "c";
      /** flutter tongue (rolled r) */
      flutter: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** the singing voice (lyrics, formants, choir) */
  "engine.sing": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "sing") */
      instrument?: "sing";
      /** how far an a>o vowel travels by the note's end (0..1, default 1) */
      morph?: number;
      /** throat size: formant shift, keeps pitch (-12..12 st, default 0) */
      formant?: number;
      /** voice quality: breathy and dark .. pressed (0..1, default 0.5) */
      bright?: number;
      /** aspiration noise (0..1, default 0.12) */
      breath?: number;
      /** vibrato depth (0..1 st, default 0.3) */
      vibmod?: number;
      /** singer's formant (bright 3 kHz ring) (0..1, default 0) */
      ring?: number;
      /** overtone filter sharpness and level (0..1, default 0) */
      overtone?: number;
      /** kargyraa subharmonic (an octave below) (0..1, default 0) */
      sub?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** how far an a>o vowel travels by the note's end */
      morph: "c";
      /** throat size: formant shift, keeps pitch */
      formant: "c";
      /** voice quality: breathy and dark .. pressed */
      bright: "c";
      /** aspiration noise */
      breath: "c";
      /** vibrato depth */
      vibmod: "c";
      /** singer's formant (bright 3 kHz ring) */
      ring: "c";
      /** overtone filter sharpness and level */
      overtone: "c";
      /** kargyraa subharmonic (an octave below) */
      sub: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** granular player over a sample or the track's own source */
  "engine.granular": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "granular") */
      instrument?: "granular";
      /** where the head starts inside the region (0..1, default 0) */
      pos?: number;
      /** head speed: 1 the source's own speed, 0 held, negative backwards (-4..4 x, default 1) */
      scan?: number;
      /** grain length (0.005..2 s, default 0.08) */
      grain?: number;
      /** grains sounding at once (density = overlap / grain) (0.05..32, default 4) */
      overlap?: number;
      /** onset randomness, fraction of the grain period (0..1, default 0.25) */
      jitter?: number;
      /** random offset of each grain's read position (0..2 s, default 0.01) */
      spray?: number;
      /** semitones on top of the note (-48..48 st, default 0) */
      pitch?: number;
      /** random per-grain pitch spread (± half) (0..24 st, default 0) */
      detune?: number;
      /** chance a grain plays shimint semitones up (0..1, default 0) */
      shimmer?: number;
      /** stereo spread of the grains (0..1, default 0.3) */
      spread?: number;
      /** chance a grain plays backwards (0..1, default 0) */
      reverse?: number;
      /** chance a grain step latches the head (beat repeat) (0..1, default 0) */
      repeat?: number;
      /** slow random walk of the head (depth) (0..1, default 0) */
      drift?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** where the head starts inside the region */
      pos: "c";
      /** head speed: 1 the source's own speed, 0 held, negative backwards */
      scan: "c";
      /** grain length */
      grain: "c";
      /** grains sounding at once (density = overlap / grain) */
      overlap: "c";
      /** onset randomness, fraction of the grain period */
      jitter: "c";
      /** random offset of each grain's read position */
      spray: "c";
      /** semitones on top of the note */
      pitch: "c";
      /** random per-grain pitch spread (± half) */
      detune: "c";
      /** chance a grain plays shimint semitones up */
      shimmer: "c";
      /** stereo spread of the grains */
      spread: "c";
      /** chance a grain plays backwards */
      reverse: "c";
      /** chance a grain step latches the head (beat repeat) */
      repeat: "c";
      /** slow random walk of the head (depth) */
      drift: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** modeled pianos, electric keys and organs */
  "engine.keys": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "grand") */
      instrument?:
        | "grand"
        | "upright"
        | "felt"
        | "honkytonk"
        | "prepared"
        | "epiano"
        | "wurli"
        | "clav"
        | "tonewheel"
        | "combo"
        | "pipe";
      /** hammer felt hardness: brightness at a given velocity (0..1, default 0.5) */
      hardness?: number;
      /** velocity sensitivity (0 plays every note at 0.8) (0..1, default 1) */
      touch?: number;
      /** sustain time multiplier (0.1..4 x, default 1) */
      decay?: number;
      /** damper time multiplier (how fast a released key stops) (0.1..4 x, default 1) */
      release?: number;
      /** soundboard knock and hammer thump (0..1, default 0.5) */
      knock?: number;
      /** key-off and damper mechanics (0..1, default 0.25) */
      noise?: number;
      /** felt strip between hammers and strings (0..1, default 0) */
      felt?: number;
      /** output low-pass of the electric keys; 0 is off (0..12000 Hz, default 0) */
      tone?: number;
      /** suitcase stereo vibrato depth: antiphase left/right pan (epiano) (0..1, default 0) */
      vibe?: number;
      /** tremolo depth: reed piano at 5.6 Hz (wurli), pipe tremulant (pipe) (0..1, default 0) */
      trem?: number;
      /** organ preamp overdrive (0..1, default 0.15) */
      drive?: number;
      /** rotary speed: 0 stop, 1 slow, 2 fast (0..2, default 1) */
      rotary?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** hammer felt hardness: brightness at a given velocity */
      hardness: "c";
      /** velocity sensitivity (0 plays every note at 0.8) */
      touch: "c";
      /** sustain time multiplier */
      decay: "c";
      /** damper time multiplier (how fast a released key stops) */
      release: "c";
      /** soundboard knock and hammer thump */
      knock: "c";
      /** key-off and damper mechanics */
      noise: "c";
      /** felt strip between hammers and strings */
      felt: "c";
      /** output low-pass of the electric keys; 0 is off */
      tone: "c";
      /** suitcase stereo vibrato depth: antiphase left/right pan (epiano) */
      vibe: "c";
      /** tremolo depth: reed piano at 5.6 Hz (wurli), pipe tremulant (pipe) */
      trem: "c";
      /** organ preamp overdrive */
      drive: "c";
      /** rotary speed: 0 stop, 1 slow, 2 fast */
      rotary: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** the vocoder's built-in carrier (saw, supersaw, pulse or noise) following the notes */
  "engine.vocoder": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "vocoder") */
      instrument?: "vocoder";
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** resonant biquad: low-pass, high-pass or band-pass */
  "fx.filter": {
    main: "a";
    params: {
      /** lpf low-pass (default), hpf high-pass, bpf band-pass (default "lpf") */
      type?: "lpf" | "hpf" | "bpf";
      /** slope: 12db biquad (default), 24db two biquads, ladder 4-pole (low-pass only) (default "12db") */
      ftype?: "12db" | "24db" | "ladder";
      /** cutoff (lpf/hpf) or center (bpf) frequency (20..20000 Hz, default 2000) */
      cutoff?: number;
      /** resonance 0..1 (Q 0.707..8) (0..1, default 0) */
      resonance?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** cutoff (lpf/hpf) or center (bpf) frequency */
      cutoff: "c";
      /** resonance 0..1 (Q 0.707..8) */
      resonance: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** one-knob filter: below 0.5 low-pass, above 0.5 high-pass, 0.5 open */
  "fx.djf": {
    main: "a";
    params: {
      /** 0 dark (20 Hz low-pass) … 0.5 open … 1 thin (10 kHz high-pass) (0..1, default 0.5) */
      value?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** 0 dark (20 Hz low-pass) … 0.5 open … 1 thin (10 kHz high-pass) */
      value: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** filter whose cutoff an LFO sweeps around a center, optionally opened by the input level */
  "fx.autofilter": {
    main: "a";
    params: {
      /** filter type (default "lpf") */
      type?: "lpf" | "hpf" | "bpf";
      /** LFO shape; random is sample-and-hold, one step per cycle (default "sine") */
      shape?: "sine" | "tri" | "square" | "saw" | "ramp" | "random";
      /** center cutoff (20..20000 Hz, default 1200) */
      cutoff?: number;
      /** resonance 0..1 (Q 0.707..8) (0..1, default 0.3) */
      resonance?: number;
      /** sweep width in octaves around the center (0..6 oct, default 2) */
      depth?: number;
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz (0..64 beats, default 4) */
      sync?: number;
      /** LFO rate in Hz (used when sync is 0) (0.01..40 Hz, default 0.5) */
      rate?: number;
      /** LFO start phase in cycles (0..1, default 0) */
      phase?: number;
      /** envelope follower: octaves the cutoff moves at full input level (-6..6 oct, default 0) */
      follow?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** center cutoff */
      cutoff: "c";
      /** resonance 0..1 (Q 0.707..8) */
      resonance: "c";
      /** sweep width in octaves around the center */
      depth: "c";
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz */
      sync: "c";
      /** LFO rate in Hz (used when sync is 0) */
      rate: "c";
      /** LFO start phase in cycles */
      phase: "c";
      /** envelope follower: octaves the cutoff moves at full input level */
      follow: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** formant shift at constant pitch: moves the spectral envelope (throat or gender knob), any source */
  "fx.formant": {
    main: "a";
    params: {
      /** semitones the formants move (negative deeper, positive smaller); pitch stays (-12..12 st, default 0) */
      shift?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** semitones the formants move (negative deeper, positive smaller); pitch stays */
      shift: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** formant filter bank: five band-passes per vowel */
  "fx.vowel": {
    main: "a";
    params: {
      /** vowel formants (a e i o u plus the extended set) (default "a") */
      vowel?:
        | "a"
        | "e"
        | "i"
        | "o"
        | "u"
        | "ae"
        | "aa"
        | "oe"
        | "ue"
        | "y"
        | "uh"
        | "un"
        | "en"
        | "an"
        | "on";
      /** vowel to morph toward (absent: no morph) (default "a") */
      to?:
        | "a"
        | "e"
        | "i"
        | "o"
        | "u"
        | "ae"
        | "aa"
        | "oe"
        | "ue"
        | "y"
        | "uh"
        | "un"
        | "en"
        | "an"
        | "on";
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
      /** position between vowel (0) and to (1), log-frequency formant morph (0..1, default 0) */
      morph?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** wet/dry balance 0..1 */
      mix: "c";
      /** position between vowel (0) and to (1), log-frequency formant morph */
      morph: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** bit-depth and sample-rate reduction */
  "fx.crush": {
    main: "a";
    params: {
      /** bit depth: 1 heavy .. 16 nearly clean (1..16, default 8) */
      bits?: number;
      /** sample-and-hold factor: 1 off, 2 half rate, 3 a third… (1..64, default 1) */
      coarse?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** bit depth: 1 heavy .. 16 nearly clean */
      bits: "c";
      /** sample-and-hold factor: 1 off, 2 half rate, 3 a third… */
      coarse: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** waveshaper with drive, post-tone and automatic gain compensation */
  "fx.distort": {
    main: "a";
    params: {
      /** curve: soft (tanh), hard clip, cubic, diode, asym, fold, sinefold, chebyshev, scurve, shape (Strudel shape's curve) (default "soft") */
      type?:
        | "soft"
        | "hard"
        | "cubic"
        | "diode"
        | "asym"
        | "fold"
        | "sinefold"
        | "chebyshev"
        | "scurve"
        | "shape";
      /** drive 0..10 (Strudel distort amount) (0..10, default 2) */
      drive?: number;
      /** low-pass after the shaper; tames fizz (200..20000 Hz, default 8000) */
      tone?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
      /** linear gain after compensation (Strudel distort postgain) (0..2, default 1) */
      postgain?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** drive 0..10 (Strudel distort amount) */
      drive: "c";
      /** low-pass after the shaper; tames fizz */
      tone: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
      /** linear gain after compensation (Strudel distort postgain) */
      postgain: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** guitar pedal before the amp: fuzz (Big Muff), face (Fuzz Face), od (Tube Screamer), rat, octave (Octavia); oversampled */
  "fx.stomp": {
    main: "a";
    params: {
      /** circuit: fuzz (Big Muff), face (Fuzz Face), od (Tube Screamer), rat (RAT), octave (Octavia) (default "od") */
      type?: "fuzz" | "face" | "od" | "rat" | "octave";
      /** the pedal's gain / sustain / distortion knob, 0..10 (0..10, default 5) */
      gain?: number;
      /** dark 0 .. bright 1 (0..1, default 0.5) */
      tone?: number;
      /** trim over a level-matched pedal (0 = bypass loudness) (-24..12 dB, default 0) */
      level?: number;
      /** octave: blend of the octave-up (rectified) path (0..1, default 0.7) */
      octave?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** the pedal's gain / sustain / distortion knob, 0..10 */
      gain: "c";
      /** dark 0 .. bright 1 */
      tone: "c";
      /** trim over a level-matched pedal (0 = bypass loudness) */
      level: "c";
      /** octave: blend of the octave-up (rectified) path */
      octave: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** guitar amp: preamp stages, Yeh-Smith tone stack, power amp with sag, level-matched across types; optional noise gate */
  "fx.head": {
    main: "a";
    params: {
      /** clean (blackface), chime (AC30), crunch (plexi), lead (JCM800), high (modern high gain), solid (JC-120), bass (SVT) (default "crunch") */
      type?: "clean" | "chime" | "crunch" | "lead" | "high" | "solid" | "bass";
      /** preamp gain 0..10 (level-matched: more gain, not more volume) (0..10, default 5) */
      gain?: number;
      /** tone stack bass 0..10 (0..10, default 5) */
      bass?: number;
      /** tone stack mid 0..10 (0..10, default 5) */
      mid?: number;
      /** tone stack treble 0..10 (0..10, default 5) */
      treble?: number;
      /** power amp presence 0..10 (5 flat) (0..10, default 5) */
      presence?: number;
      /** power amp drive 0..10 (0..10, default 5) */
      master?: number;
      /** power supply sag 0..1 (absent: the head type's own) (0..1, default 0.3) */
      sag?: number;
      /** noise gate threshold before the amp (absent: no gate; 0 dB gates all) (-96..0 dB, default -60) */
      gate?: number;
      /** output level after level matching (-24..12 dB, default 0) */
      level?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** preamp gain 0..10 (level-matched: more gain, not more volume) */
      gain: "c";
      /** tone stack bass 0..10 */
      bass: "c";
      /** tone stack mid 0..10 */
      mid: "c";
      /** tone stack treble 0..10 */
      treble: "c";
      /** power amp presence 0..10 (5 flat) */
      presence: "c";
      /** power amp drive 0..10 */
      master: "c";
      /** power supply sag 0..1 (absent: the head type's own) */
      sag: "c";
      /** noise gate threshold before the amp (absent: no gate; 0 dB gates all) */
      gate: "c";
      /** output level after level matching */
      level: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** speaker cabinet and microphone (biquad model, no impulse response) */
  "fx.cab": {
    main: "a";
    params: {
      /** 1x12, 2x12, 4x12, 1x10, open back, 8x10 and 1x15 bass, di (no speaker) (default "2x12") */
      type?:
        "1x12" | "2x12" | "4x12" | "1x10" | "open" | "8x10" | "1x15" | "di";
      /** microphone position: 0 center (bright) .. 1 edge (dark) (0..1, default 0.3) */
      mic?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** microphone position: 0 center (bright) .. 1 edge (dark) */
      mic: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** held tremolo arm: slow seeded pitch wow and flutter of the whole track */
  "fx.wobble": {
    main: "a";
    params: {
      /** peak pitch deviation in cents (0..100 c, default 20) */
      depth?: number;
      /** wobble rate (0.05..8 Hz, default 0.5) */
      rate?: number;
      /** 0 periodic .. 1 wandering (seeded, so every render matches) (0..1, default 0.3) */
      drift?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** peak pitch deviation in cents */
      depth: "c";
      /** wobble rate */
      rate: "c";
      /** 0 periodic .. 1 wandering (seeded, so every render matches) */
      drift: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** feedback bloom: the top held note grows a singing harmonic */
  "fx.bloom": {
    main: "a";
    params: {
      /** level of the feedback partial (0..1, default 0.5) */
      amount?: number;
      /** harmonic that feeds back: 1 the note, 2 its octave, 3 the fifth above (1..4, default 2) */
      harm?: number;
      /** how long a note is held before it starts to feed back (0..4 s, default 0.6) */
      delay?: number;
      /** how fast the feedback grows (0.05..4 s, default 1) */
      time?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** level of the feedback partial */
      amount: "c";
      /** harmonic that feeds back: 1 the note, 2 its octave, 3 the fifth above */
      harm: "c";
      /** how long a note is held before it starts to feed back */
      delay: "c";
      /** how fast the feedback grows */
      time: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** volume swell: each strum fades in, no pick attack */
  "fx.swell": {
    main: "a";
    params: {
      /** rise time after each onset (0.01..4 s, default 0.4) */
      time?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** rise time after each onset */
      time: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** volume modulation */
  "fx.tremolo": {
    main: "a";
    params: {
      /** LFO shape (default "sine") */
      shape?: "sine" | "tri" | "square" | "saw" | "ramp";
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz (0..64 beats, default 0.5) */
      sync?: number;
      /** LFO rate in Hz (used when sync is 0) (0.01..40 Hz, default 4) */
      rate?: number;
      /** how far the level dips, 0..1 (0..1, default 0.5) */
      depth?: number;
      /** where in the cycle the peak falls (0.5 symmetric) (0..1, default 0.5) */
      skew?: number;
      /** start phase in cycles (0..1, default 0) */
      phase?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz */
      sync: "c";
      /** LFO rate in Hz (used when sync is 0) */
      rate: "c";
      /** how far the level dips, 0..1 */
      depth: "c";
      /** where in the cycle the peak falls (0.5 symmetric) */
      skew: "c";
      /** start phase in cycles */
      phase: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** feed-forward RMS-ish compressor with soft knee and make-up gain */
  "fx.compressor": {
    main: "a";
    params: {
      /** level where compression starts (-60..0 dB, default -18) */
      threshold?: number;
      /** input:output above threshold (1..20, default 4) */
      ratio?: number;
      /** soft-knee width (0..24 dB, default 6) */
      knee?: number;
      /** attack time (0.0001..1 s, default 0.01) */
      attack?: number;
      /** release time (0.01..2 s, default 0.15) */
      release?: number;
      /** gain after compression (0..24 dB, default 5) */
      makeup?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** level where compression starts */
      threshold: "c";
      /** input:output above threshold */
      ratio: "c";
      /** soft-knee width */
      knee: "c";
      /** attack time */
      attack: "c";
      /** release time */
      release: "c";
      /** gain after compression */
      makeup: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** automatic double tracking: a seeded second take, spread left and right */
  "fx.double": {
    main: "a";
    params: {
      /** how late the second take plays (5..60 ms, default 22) */
      time?: number;
      /** how far the second take's timing wanders (0..10 ms, default 3) */
      drift?: number;
      /** 0 centered .. 1 the two takes hard left and right (0..1, default 0.6) */
      width?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** how late the second take plays */
      time: "c";
      /** how far the second take's timing wanders */
      drift: "c";
      /** 0 centered .. 1 the two takes hard left and right */
      width: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** four-stage all-pass phaser */
  "fx.phaser": {
    main: "a";
    params: {
      /** LFO rate in Hz (used when sync is 0) (0.01..40 Hz, default 0.5) */
      rate?: number;
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz (0..64 beats, default 0) */
      sync?: number;
      /** notch depth (wet amount) (0..1, default 0.75) */
      depth?: number;
      /** sweep center (100..10000 Hz, default 1000) */
      center?: number;
      /** sweep range (0..8000 Hz, default 2000) */
      sweep?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** LFO rate in Hz (used when sync is 0) */
      rate: "c";
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz */
      sync: "c";
      /** notch depth (wet amount) */
      depth: "c";
      /** sweep center */
      center: "c";
      /** sweep range */
      sweep: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** stereo chorus: two modulated delay taps in quadrature */
  "fx.chorus": {
    main: "a";
    params: {
      /** LFO rate in Hz (used when sync is 0) (0.01..40 Hz, default 0.8) */
      rate?: number;
      /** modulation depth (0..1 → 0..6 ms) (0..1, default 0.4) */
      depth?: number;
      /** wet/dry balance 0..1 (0..1, default 0.5) */
      mix?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** LFO rate in Hz (used when sync is 0) */
      rate: "c";
      /** modulation depth (0..1 → 0..6 ms) */
      depth: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** rotary speaker: Doppler vibrato plus left/right amplitude rotation */
  "fx.leslie": {
    main: "a";
    params: {
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
      /** rotation in Hz: 6.7 fast, 0.7 slow (0.01..40 Hz, default 6.7) */
      rate?: number;
      /** cabinet size: Doppler (pitch warble) amount (0..1, default 0.5) */
      size?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** wet/dry balance 0..1 */
      mix: "c";
      /** rotation in Hz: 6.7 fast, 0.7 slow */
      rate: "c";
      /** cabinet size: Doppler (pitch warble) amount */
      size: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** linear gain after every insert, before the delay and reverb sends */
  "fx.postgain": {
    main: "a";
    params: {
      /** linear gain 0..4 (0..4, default 1) */
      gain?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** linear gain 0..4 */
      gain: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** tempo-synced stereo delay send; ping-pong with a high-cut on the repeats by default */
  "fx.delay": {
    main: "a";
    params: {
      /** repeats alternate left/right (absent: the original cross-fed stereo) (default true) */
      pingpong?: boolean;
      /** delay time in beats (0.75 = dotted eighth) (0.0625..4 beats, default 0.75) */
      beats?: number;
      /** fraction of each echo fed back (0..0.9, default 0.35) */
      feedback?: number;
      /** wet level (0..1, default 0.25) */
      mix?: number;
      /** delay time in seconds; 0 or absent uses beats (0..4 s, default 0) */
      time?: number;
      /** low-pass inside the feedback loop so repeats darken (500..20000 Hz, default 5000) */
      highcut?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** delay time in beats (0.75 = dotted eighth) */
      beats: "c";
      /** fraction of each echo fed back */
      feedback: "c";
      /** wet level */
      mix: "c";
      /** delay time in seconds; 0 or absent uses beats */
      time: "c";
      /** low-pass inside the feedback loop so repeats darken */
      highcut: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** algorithmic stereo reverb send (eight combs, four allpasses per side) */
  "fx.reverb": {
    main: "a";
    params: {
      /** wet level (0..1, default 0.3) */
      mix?: number;
      /** room size (Strudel roomsize 0..10 = size·10) (0..1, default 0.5) */
      size?: number;
      /** decay time to -60 dB; overrides the size-derived decay (0.1..20 s, default 2) */
      fade?: number;
      /** low-pass on the reverb input (200..20000 Hz, default 8000) */
      lowpass?: number;
      /** damping: the tail darkens toward this frequency as it decays (200..20000 Hz, default 3000) */
      dim?: number;
      /** gap before the tail starts (0..0.5 s, default 0.02) */
      predelay?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** wet level */
      mix: "c";
      /** room size (Strudel roomsize 0..10 = size·10) */
      size: "c";
      /** decay time to -60 dB; overrides the size-derived decay */
      fade: "c";
      /** low-pass on the reverb input */
      lowpass: "c";
      /** damping: the tail darkens toward this frequency as it decays */
      dim: "c";
      /** gap before the tail starts */
      predelay: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
};

/** The boundary nodes every patch has: `in`, `out`, `voice` and `song`. */
export type PatchBoundaryTable = {
  /** the patch's inputs from the track */
  in: {
    main: "n";
    params: {};
    inputs: {};
    outputs: {
      /** the track's notes (instrument) */
      notes: "n";
      /** the track's audio (effect patch) */
      audio: "a";
      /** the track's right channel (stereo effect patch) */
      right: "a";
      /** the sidechain track's audio (patch `side`) */
      side: "a";
    };
  };
  /** the patch's output to the track */
  out: {
    main: "none";
    params: {};
    inputs: {
      /** audio out (mono, or left when right is wired) */
      audio: "a";
      /** right channel; unwired, audio plays on both */
      right: "a";
    };
    outputs: {};
  };
  /** per-voice sources, one set per playing note */
  voice: {
    main: "c";
    params: {};
    inputs: {};
    outputs: {
      /** the note's frequency in Hz (tuned, with glide) */
      pitch: "c";
      /** the note's MIDI number */
      note: "c";
      /** 1 while the note is held, then 0 */
      gate: "c";
      /** velocity 0..1 */
      velocity: "c";
      /** phase 0..1 per cycle of the note's pitch */
      phase: "c";
      /** seeded random 0..1, fixed for the note */
      random: "c";
      /** voice slot index */
      index: "c";
      /** seconds since the note began */
      age: "c";
    };
  };
  /** global time and the track's automation */
  song: {
    main: "c";
    params: {};
    inputs: {};
    outputs: {
      /** song position in beats */
      beat: "c";
      /** position in the bar 0..1 */
      "bar.phase": "c";
      /** tempo in BPM */
      tempo: "c";
    };
  };
};

type PatchPortRow = readonly [string, PatchPortCode, number?, number?, number?];

/** Ports by node type, for wiring and checks at run time. */
export const PATCH_NODE_PORTS: Readonly<
  Record<
    string,
    Readonly<{
      rate: string;
      params: readonly string[];
      inputs: readonly PatchPortRow[];
      outputs: readonly PatchPortRow[];
      engine?: readonly string[];
    }>
  >
> = {
  osc: {
    rate: "any",
    params: ["wave", "pitch", "detune", "pw", "level"],
    inputs: [
      ["pitch", "ca", 0, 20000, 440],
      ["detune", "c", -1200, 1200, 0],
      ["pw", "c", 0.01, 0.99, 0.5],
      ["fm", "a"],
      ["level", "c", 0, 4, 1],
    ],
    outputs: [["out", "a"]],
  },
  noise: {
    rate: "any",
    params: ["color", "level"],
    inputs: [["level", "c", 0, 4, 1]],
    outputs: [["out", "a"]],
  },
  svf: {
    rate: "any",
    params: ["mode", "cutoff", "q"],
    inputs: [
      ["in", "a"],
      ["cutoff", "c", 20, 20000, 1000],
      ["q", "c", 0, 1, 0.5],
    ],
    outputs: [["out", "a"]],
  },
  onepole: {
    rate: "any",
    params: ["mode", "cutoff"],
    inputs: [
      ["in", "a"],
      ["cutoff", "c", 20, 20000, 1000],
    ],
    outputs: [["out", "a"]],
  },
  adsr: {
    rate: "any",
    params: ["gate", "attack", "decay", "sustain", "release"],
    inputs: [
      ["gate", "c", 0, 1, 0],
      ["attack", "c", 0, 10, 0.01],
      ["decay", "c", 0, 10, 0.1],
      ["sustain", "c", 0, 1, 0.7],
      ["release", "c", 0, 10, 0.2],
    ],
    outputs: [["out", "c"]],
  },
  ar: {
    rate: "any",
    params: ["gate", "attack", "release"],
    inputs: [
      ["gate", "c", 0, 1, 0],
      ["attack", "c", 0, 10, 0.01],
      ["release", "c", 0, 10, 0.2],
    ],
    outputs: [["out", "c"]],
  },
  slew: {
    rate: "any",
    params: ["in", "rise", "fall"],
    inputs: [
      ["in", "c", -1000000, 1000000, 0],
      ["rise", "c", 0, 10, 0.05],
      ["fall", "c", 0, 10, 0.05],
    ],
    outputs: [["out", "c"]],
  },
  follow: {
    rate: "any",
    params: ["attack", "release"],
    inputs: [
      ["in", "a"],
      ["attack", "c", 0.0001, 1, 0.005],
      ["release", "c", 0.001, 4, 0.1],
    ],
    outputs: [["out", "c"]],
  },
  lfo: {
    rate: "any",
    params: ["shape", "sync", "rate", "phase", "depth"],
    inputs: [
      ["rate", "c", 0, 100, 1],
      ["phase", "c", 0, 1, 0],
      ["depth", "c", 0, 1, 1],
    ],
    outputs: [["out", "c", -1, 1]],
  },
  sh: {
    rate: "any",
    params: ["in", "trig"],
    inputs: [
      ["in", "c", -1000000, 1000000, 0],
      ["trig", "c", 0, 1, 0],
    ],
    outputs: [["out", "c"]],
  },
  random: { rate: "any", params: ["per"], inputs: [], outputs: [["out", "c"]] },
  const: {
    rate: "any",
    params: ["value"],
    inputs: [],
    outputs: [["out", "c"]],
  },
  add: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  mul: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 1],
    ],
    outputs: [["out", "c"]],
  },
  min: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  max: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  gt: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  lt: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  abs: {
    rate: "any",
    params: ["in"],
    inputs: [["in", "c", -1000000, 1000000, 0]],
    outputs: [["out", "c"]],
  },
  not: {
    rate: "any",
    params: ["in"],
    inputs: [["in", "c", -1000000, 1000000, 0]],
    outputs: [["out", "c"]],
  },
  pitch2hz: {
    rate: "any",
    params: ["in"],
    inputs: [["in", "c", -1000000, 1000000, 0]],
    outputs: [["out", "c"]],
  },
  db2gain: {
    rate: "any",
    params: ["in"],
    inputs: [["in", "c", -1000000, 1000000, 0]],
    outputs: [["out", "c"]],
  },
  scale: {
    rate: "any",
    params: ["curve", "in", "inmin", "inmax", "min", "max"],
    inputs: [
      ["in", "c", -1000000, 1000000, 0],
      ["inmin", "c", -1000000, 1000000, -1],
      ["inmax", "c", -1000000, 1000000, 1],
      ["min", "c", -1000000, 1000000, 0],
      ["max", "c", -1000000, 1000000, 1],
    ],
    outputs: [["out", "c"]],
  },
  clamp: {
    rate: "any",
    params: ["in", "min", "max"],
    inputs: [
      ["in", "c", -1000000, 1000000, 0],
      ["min", "c", -1000000, 1000000, 0],
      ["max", "c", -1000000, 1000000, 1],
    ],
    outputs: [["out", "c"]],
  },
  clock: {
    rate: "global",
    params: ["beats", "width"],
    inputs: [["width", "c", 0.01, 0.99, 0.5]],
    outputs: [["out", "c"]],
  },
  vca: {
    rate: "any",
    params: ["gain"],
    inputs: [
      ["in", "a"],
      ["gain", "ca", 0, 4, 1],
    ],
    outputs: [["out", "a"]],
  },
  mix: {
    rate: "any",
    params: ["la", "lb", "lc", "ld"],
    inputs: [
      ["a", "a"],
      ["b", "a"],
      ["c", "a"],
      ["d", "a"],
      ["la", "c", 0, 4, 1],
      ["lb", "c", 0, 4, 1],
      ["lc", "c", 0, 4, 1],
      ["ld", "c", 0, 4, 1],
    ],
    outputs: [["out", "a"]],
  },
  xfade: {
    rate: "any",
    params: ["x"],
    inputs: [
      ["a", "a"],
      ["b", "a"],
      ["x", "c", 0, 1, 0.5],
    ],
    outputs: [["out", "a"]],
  },
  pan: {
    rate: "any",
    params: ["pan"],
    inputs: [
      ["in", "a"],
      ["pan", "c", -1, 1, 0],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  voicesum: {
    rate: "global",
    params: [],
    inputs: [["in", "a"]],
    outputs: [["out", "a"]],
  },
  "engine.synth": {
    rate: "global",
    params: [
      "instrument",
      "attack",
      "decay",
      "sustain",
      "release",
      "gain",
      "noise",
      "density",
      "detune",
      "spread",
      "pw",
      "pwrate",
      "pwsweep",
      "vib",
      "vibmod",
      "penv",
      "pattack",
      "pdecay",
      "psustain",
      "prelease",
      "lpf",
      "lpq",
      "lpenv",
      "lpattack",
      "lpdecay",
      "lpsustain",
      "lprelease",
      "hpf",
      "hpq",
      "hpenv",
      "hpattack",
      "hpdecay",
      "hpsustain",
      "hprelease",
      "bpf",
      "bpq",
      "bpenv",
      "bpattack",
      "bpdecay",
      "bpsustain",
      "bprelease",
      "fanchor",
      "fm",
      "fmh",
      "fmattack",
      "fmdecay",
      "fmsustain",
      "fmrelease",
      "fm2",
      "fmh2",
      "fmattack2",
      "fmdecay2",
      "fmsustain2",
      "fmrelease2",
      "fm3",
      "fmh3",
      "fmattack3",
      "fmdecay3",
      "fmsustain3",
      "fmrelease3",
      "fm4",
      "fmh4",
      "fmattack4",
      "fmdecay4",
      "fmsustain4",
      "fmrelease4",
      "fm5",
      "fmh5",
      "fmattack5",
      "fmdecay5",
      "fmsustain5",
      "fmrelease5",
      "fm6",
      "fmh6",
      "fmattack6",
      "fmdecay6",
      "fmsustain6",
      "fmrelease6",
      "fm7",
      "fmh7",
      "fmattack7",
      "fmdecay7",
      "fmsustain7",
      "fmrelease7",
      "fm8",
      "fmh8",
      "fmattack8",
      "fmdecay8",
      "fmsustain8",
      "fmrelease8",
      "zrand",
      "curve",
      "slide",
      "deltaSlide",
      "pitchJump",
      "pitchJumpTime",
      "lfo",
      "zmod",
      "zcrush",
      "zdelay",
      "tremolo",
    ],
    inputs: [
      ["notes", "n"],
      ["attack", "c", 0, 10, 0.003],
      ["decay", "c", 0, 10, 0.05],
      ["sustain", "c", 0, 1, 1],
      ["release", "c", 0, 10, 0.05],
      ["gain", "c", 0, 4, 1],
      ["noise", "c", 0, 1, 0],
      ["density", "c", 0, 1, 0.03],
      ["detune", "c", 0, 12, 0.2],
      ["spread", "c", 0, 1, 0.6],
      ["pw", "c", 0, 1, 0.5],
      ["pwrate", "c", 0, 40, 1],
      ["pwsweep", "c", 0, 1, 0],
      ["vib", "c", 0, 64, 0],
      ["vibmod", "c", 0, 24, 0.5],
      ["penv", "c", -48, 48, 0],
      ["pattack", "c", 0, 10, 0.2],
      ["pdecay", "c", 0, 10, 0],
      ["psustain", "c", 0, 1, 1],
      ["prelease", "c", 0, 10, 0],
      ["lpf", "c", 20, 20000, 2000],
      ["lpq", "c", 0, 50, 1],
      ["lpenv", "c", -10, 10, 0],
      ["lpattack", "c", 0, 10, 0.005],
      ["lpdecay", "c", 0, 10, 0.15],
      ["lpsustain", "c", 0, 1, 0],
      ["lprelease", "c", 0, 10, 0.1],
      ["hpf", "c", 20, 20000, 200],
      ["hpq", "c", 0, 50, 1],
      ["hpenv", "c", -10, 10, 0],
      ["hpattack", "c", 0, 10, 0.005],
      ["hpdecay", "c", 0, 10, 0.15],
      ["hpsustain", "c", 0, 1, 0],
      ["hprelease", "c", 0, 10, 0.1],
      ["bpf", "c", 20, 20000, 1000],
      ["bpq", "c", 0, 50, 1],
      ["bpenv", "c", -10, 10, 0],
      ["bpattack", "c", 0, 10, 0.005],
      ["bpdecay", "c", 0, 10, 0.15],
      ["bpsustain", "c", 0, 1, 0],
      ["bprelease", "c", 0, 10, 0.1],
      ["fanchor", "c", 0, 1, 0],
      ["fm", "c", 0, 64, 0],
      ["fmh", "c", 0, 32, 1],
      ["fmattack", "c", 0, 10, 0],
      ["fmdecay", "c", 0, 10, 0],
      ["fmsustain", "c", 0, 1, 1],
      ["fmrelease", "c", 0, 10, 0],
      ["fm2", "c", 0, 64, 0],
      ["fmh2", "c", 0, 32, 1],
      ["fmattack2", "c", 0, 10, 0],
      ["fmdecay2", "c", 0, 10, 0],
      ["fmsustain2", "c", 0, 1, 1],
      ["fmrelease2", "c", 0, 10, 0],
      ["fm3", "c", 0, 64, 0],
      ["fmh3", "c", 0, 32, 1],
      ["fmattack3", "c", 0, 10, 0],
      ["fmdecay3", "c", 0, 10, 0],
      ["fmsustain3", "c", 0, 1, 1],
      ["fmrelease3", "c", 0, 10, 0],
      ["fm4", "c", 0, 64, 0],
      ["fmh4", "c", 0, 32, 1],
      ["fmattack4", "c", 0, 10, 0],
      ["fmdecay4", "c", 0, 10, 0],
      ["fmsustain4", "c", 0, 1, 1],
      ["fmrelease4", "c", 0, 10, 0],
      ["fm5", "c", 0, 64, 0],
      ["fmh5", "c", 0, 32, 1],
      ["fmattack5", "c", 0, 10, 0],
      ["fmdecay5", "c", 0, 10, 0],
      ["fmsustain5", "c", 0, 1, 1],
      ["fmrelease5", "c", 0, 10, 0],
      ["fm6", "c", 0, 64, 0],
      ["fmh6", "c", 0, 32, 1],
      ["fmattack6", "c", 0, 10, 0],
      ["fmdecay6", "c", 0, 10, 0],
      ["fmsustain6", "c", 0, 1, 1],
      ["fmrelease6", "c", 0, 10, 0],
      ["fm7", "c", 0, 64, 0],
      ["fmh7", "c", 0, 32, 1],
      ["fmattack7", "c", 0, 10, 0],
      ["fmdecay7", "c", 0, 10, 0],
      ["fmsustain7", "c", 0, 1, 1],
      ["fmrelease7", "c", 0, 10, 0],
      ["fm8", "c", 0, 64, 0],
      ["fmh8", "c", 0, 32, 1],
      ["fmattack8", "c", 0, 10, 0],
      ["fmdecay8", "c", 0, 10, 0],
      ["fmsustain8", "c", 0, 1, 1],
      ["fmrelease8", "c", 0, 10, 0],
      ["zrand", "c", 0, 1, 0],
      ["curve", "c", 0, 3, 1],
      ["slide", "c", -20, 20, 0],
      ["deltaSlide", "c", -20, 20, 0],
      ["pitchJump", "c", -2000, 2000, 0],
      ["pitchJumpTime", "c", 0, 10, 0],
      ["lfo", "c", 0, 10, 0],
      ["zmod", "c", 0, 1000, 0],
      ["zcrush", "c", 0, 1, 0],
      ["zdelay", "c", 0, 1, 0],
      ["tremolo", "c", 0, 1, 0],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["synth", "wavetable", "sampler"],
  },
  "engine.modal": {
    rate: "global",
    params: [
      "instrument",
      "hardness",
      "position",
      "ring",
      "tilt",
      "damp",
      "motordepth",
      "buzz",
      "click",
      "gain",
    ],
    inputs: [
      ["notes", "n"],
      ["hardness", "c", 0, 1, 0.4],
      ["position", "c", 0, 1, 0.42],
      ["ring", "c", 0.05, 30, 1.6],
      ["tilt", "c", 0, 2, 0.9],
      ["damp", "c", 0, 1, 0],
      ["motordepth", "c", 0, 1, 0],
      ["buzz", "c", 0, 1, 0],
      ["click", "c", 0, 1, 0],
      ["gain", "c", 0, 2, 0.8],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["modal"],
  },
  "engine.string": {
    rate: "global",
    params: [
      "instrument",
      "ring",
      "damp",
      "pos",
      "bright",
      "mute",
      "buzz",
      "vib",
      "vibmod",
      "gain",
      "pressure",
      "speed",
      "sord",
      "dyn",
    ],
    inputs: [
      ["notes", "n"],
      ["ring", "c", 0.05, 60, 3],
      ["damp", "c", 0, 1, 0.4],
      ["pos", "c", 0.02, 0.5, 0.15],
      ["bright", "c", 0, 1, 0.6],
      ["mute", "c", 0, 1, 0],
      ["buzz", "c", 0, 1, 0],
      ["vib", "c", 0, 12, 0],
      ["vibmod", "c", 0, 2, 0.18],
      ["gain", "c", 0, 2, 1],
      ["pressure", "c", 0, 1, 0.5],
      ["speed", "c", 0, 1, 0.6],
      ["sord", "c", 0, 1, 0],
      ["dyn", "c", 0, 1, 1],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["string"],
  },
  "engine.wind": {
    rate: "global",
    params: ["instrument", "breath", "noise", "wah", "growl", "flutter"],
    inputs: [
      ["notes", "n"],
      ["breath", "c", 0, 1, 0.6],
      ["noise", "c", 0, 1, 0.08],
      ["wah", "c", 0, 1, 1],
      ["growl", "c", 0, 1, 0],
      ["flutter", "c", 0, 1, 0],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["wind"],
  },
  "engine.sing": {
    rate: "global",
    params: [
      "instrument",
      "morph",
      "formant",
      "bright",
      "breath",
      "vibmod",
      "ring",
      "overtone",
      "sub",
    ],
    inputs: [
      ["notes", "n"],
      ["morph", "c", 0, 1, 1],
      ["formant", "c", -12, 12, 0],
      ["bright", "c", 0, 1, 0.5],
      ["breath", "c", 0, 1, 0.12],
      ["vibmod", "c", 0, 1, 0.3],
      ["ring", "c", 0, 1, 0],
      ["overtone", "c", 0, 1, 0],
      ["sub", "c", 0, 1, 0],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["sing"],
  },
  "engine.granular": {
    rate: "global",
    params: [
      "instrument",
      "pos",
      "scan",
      "grain",
      "overlap",
      "jitter",
      "spray",
      "pitch",
      "detune",
      "shimmer",
      "spread",
      "reverse",
      "repeat",
      "drift",
    ],
    inputs: [
      ["notes", "n"],
      ["pos", "c", 0, 1, 0],
      ["scan", "c", -4, 4, 1],
      ["grain", "c", 0.005, 2, 0.08],
      ["overlap", "c", 0.05, 32, 4],
      ["jitter", "c", 0, 1, 0.25],
      ["spray", "c", 0, 2, 0.01],
      ["pitch", "c", -48, 48, 0],
      ["detune", "c", 0, 24, 0],
      ["shimmer", "c", 0, 1, 0],
      ["spread", "c", 0, 1, 0.3],
      ["reverse", "c", 0, 1, 0],
      ["repeat", "c", 0, 1, 0],
      ["drift", "c", 0, 1, 0],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["granular"],
  },
  "engine.keys": {
    rate: "global",
    params: [
      "instrument",
      "hardness",
      "touch",
      "decay",
      "release",
      "knock",
      "noise",
      "felt",
      "tone",
      "vibe",
      "trem",
      "drive",
      "rotary",
    ],
    inputs: [
      ["notes", "n"],
      ["hardness", "c", 0, 1, 0.5],
      ["touch", "c", 0, 1, 1],
      ["decay", "c", 0.1, 4, 1],
      ["release", "c", 0.1, 4, 1],
      ["knock", "c", 0, 1, 0.5],
      ["noise", "c", 0, 1, 0.25],
      ["felt", "c", 0, 1, 0],
      ["tone", "c", 0, 12000, 0],
      ["vibe", "c", 0, 1, 0],
      ["trem", "c", 0, 1, 0],
      ["drive", "c", 0, 1, 0.15],
      ["rotary", "c", 0, 2, 1],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["keys"],
  },
  "engine.vocoder": {
    rate: "global",
    params: ["instrument"],
    inputs: [["notes", "n"]],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["vocoder"],
  },
  "fx.filter": {
    rate: "global",
    params: ["type", "ftype", "cutoff", "resonance"],
    inputs: [
      ["in", "a"],
      ["cutoff", "c", 20, 20000, 2000],
      ["resonance", "c", 0, 1, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.djf": {
    rate: "global",
    params: ["value"],
    inputs: [
      ["in", "a"],
      ["value", "c", 0, 1, 0.5],
    ],
    outputs: [["out", "a"]],
  },
  "fx.autofilter": {
    rate: "global",
    params: [
      "type",
      "shape",
      "cutoff",
      "resonance",
      "depth",
      "sync",
      "rate",
      "phase",
      "follow",
    ],
    inputs: [
      ["in", "a"],
      ["cutoff", "c", 20, 20000, 1200],
      ["resonance", "c", 0, 1, 0.3],
      ["depth", "c", 0, 6, 2],
      ["sync", "c", 0, 64, 4],
      ["rate", "c", 0.01, 40, 0.5],
      ["phase", "c", 0, 1, 0],
      ["follow", "c", -6, 6, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.formant": {
    rate: "global",
    params: ["shift", "mix"],
    inputs: [
      ["in", "a"],
      ["shift", "c", -12, 12, 0],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.vowel": {
    rate: "global",
    params: ["vowel", "to", "mix", "morph"],
    inputs: [
      ["in", "a"],
      ["mix", "c", 0, 1, 1],
      ["morph", "c", 0, 1, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.crush": {
    rate: "global",
    params: ["bits", "coarse", "mix"],
    inputs: [
      ["in", "a"],
      ["bits", "c", 1, 16, 8],
      ["coarse", "c", 1, 64, 1],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.distort": {
    rate: "global",
    params: ["type", "drive", "tone", "mix", "postgain"],
    inputs: [
      ["in", "a"],
      ["drive", "c", 0, 10, 2],
      ["tone", "c", 200, 20000, 8000],
      ["mix", "c", 0, 1, 1],
      ["postgain", "c", 0, 2, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.stomp": {
    rate: "global",
    params: ["type", "gain", "tone", "level", "octave", "mix"],
    inputs: [
      ["in", "a"],
      ["gain", "c", 0, 10, 5],
      ["tone", "c", 0, 1, 0.5],
      ["level", "c", -24, 12, 0],
      ["octave", "c", 0, 1, 0.7],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.head": {
    rate: "global",
    params: [
      "type",
      "gain",
      "bass",
      "mid",
      "treble",
      "presence",
      "master",
      "sag",
      "gate",
      "level",
    ],
    inputs: [
      ["in", "a"],
      ["gain", "c", 0, 10, 5],
      ["bass", "c", 0, 10, 5],
      ["mid", "c", 0, 10, 5],
      ["treble", "c", 0, 10, 5],
      ["presence", "c", 0, 10, 5],
      ["master", "c", 0, 10, 5],
      ["sag", "c", 0, 1, 0.3],
      ["gate", "c", -96, 0, -60],
      ["level", "c", -24, 12, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.cab": {
    rate: "global",
    params: ["type", "mic", "mix"],
    inputs: [
      ["in", "a"],
      ["mic", "c", 0, 1, 0.3],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.wobble": {
    rate: "global",
    params: ["depth", "rate", "drift"],
    inputs: [
      ["in", "a"],
      ["depth", "c", 0, 100, 20],
      ["rate", "c", 0.05, 8, 0.5],
      ["drift", "c", 0, 1, 0.3],
    ],
    outputs: [["out", "a"]],
  },
  "fx.bloom": {
    rate: "global",
    params: ["amount", "harm", "delay", "time"],
    inputs: [
      ["in", "a"],
      ["amount", "c", 0, 1, 0.5],
      ["harm", "c", 1, 4, 2],
      ["delay", "c", 0, 4, 0.6],
      ["time", "c", 0.05, 4, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.swell": {
    rate: "global",
    params: ["time", "mix"],
    inputs: [
      ["in", "a"],
      ["time", "c", 0.01, 4, 0.4],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.tremolo": {
    rate: "global",
    params: ["shape", "sync", "rate", "depth", "skew", "phase"],
    inputs: [
      ["in", "a"],
      ["sync", "c", 0, 64, 0.5],
      ["rate", "c", 0.01, 40, 4],
      ["depth", "c", 0, 1, 0.5],
      ["skew", "c", 0, 1, 0.5],
      ["phase", "c", 0, 1, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.compressor": {
    rate: "global",
    params: ["threshold", "ratio", "knee", "attack", "release", "makeup"],
    inputs: [
      ["in", "a"],
      ["threshold", "c", -60, 0, -18],
      ["ratio", "c", 1, 20, 4],
      ["knee", "c", 0, 24, 6],
      ["attack", "c", 0.0001, 1, 0.01],
      ["release", "c", 0.01, 2, 0.15],
      ["makeup", "c", 0, 24, 5],
    ],
    outputs: [["out", "a"]],
  },
  "fx.double": {
    rate: "global",
    params: ["time", "drift", "width"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["time", "c", 5, 60, 22],
      ["drift", "c", 0, 10, 3],
      ["width", "c", 0, 1, 0.6],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.phaser": {
    rate: "global",
    params: ["rate", "sync", "depth", "center", "sweep"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["rate", "c", 0.01, 40, 0.5],
      ["sync", "c", 0, 64, 0],
      ["depth", "c", 0, 1, 0.75],
      ["center", "c", 100, 10000, 1000],
      ["sweep", "c", 0, 8000, 2000],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.chorus": {
    rate: "global",
    params: ["rate", "depth", "mix"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["rate", "c", 0.01, 40, 0.8],
      ["depth", "c", 0, 1, 0.4],
      ["mix", "c", 0, 1, 0.5],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.leslie": {
    rate: "global",
    params: ["mix", "rate", "size"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["mix", "c", 0, 1, 1],
      ["rate", "c", 0.01, 40, 6.7],
      ["size", "c", 0, 1, 0.5],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.postgain": {
    rate: "global",
    params: ["gain"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["gain", "c", 0, 4, 1],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.delay": {
    rate: "global",
    params: ["pingpong", "beats", "feedback", "mix", "time", "highcut"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["beats", "c", 0.0625, 4, 0.75],
      ["feedback", "c", 0, 0.9, 0.35],
      ["mix", "c", 0, 1, 0.25],
      ["time", "c", 0, 4, 0],
      ["highcut", "c", 500, 20000, 5000],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.reverb": {
    rate: "global",
    params: ["mix", "size", "fade", "lowpass", "dim", "predelay"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["mix", "c", 0, 1, 0.3],
      ["size", "c", 0, 1, 0.5],
      ["fade", "c", 0.1, 20, 2],
      ["lowpass", "c", 200, 20000, 8000],
      ["dim", "c", 200, 20000, 3000],
      ["predelay", "c", 0, 0.5, 0.02],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  in: {
    rate: "global",
    params: [],
    inputs: [],
    outputs: [
      ["notes", "n"],
      ["audio", "a"],
      ["right", "a"],
      ["side", "a"],
    ],
  },
  out: {
    rate: "global",
    params: [],
    inputs: [
      ["audio", "a"],
      ["right", "a"],
    ],
    outputs: [],
  },
  voice: {
    rate: "voice",
    params: [],
    inputs: [],
    outputs: [
      ["pitch", "c"],
      ["note", "c"],
      ["gate", "c"],
      ["velocity", "c"],
      ["phase", "c"],
      ["random", "c"],
      ["index", "c"],
      ["age", "c"],
    ],
  },
  song: {
    rate: "global",
    params: [],
    inputs: [],
    outputs: [
      ["beat", "c"],
      ["bar.phase", "c"],
      ["tempo", "c"],
    ],
  },
};

// END patch nodes

/** A node as stored: `{ id, type, params?, rate?, label? }`. */
export type PatchNodeData = Readonly<{
  id: string;
  type: string;
  params?: Readonly<Record<string, unknown>>;
  rate?: "global";
  label?: string;
}>;

/** A cable from an output to an input (`"vcf.out"` → `"vca.in"`). */
export type PatchCableData = Readonly<{
  id: string;
  from: string;
  to: string;
  /** Into a control port: an attenuverter -1..1 on the cord (absent is 1). */
  amount?: number;
}>;

/** A macro: one knob that sets control inputs or number params. */
export type PatchMacroData = Readonly<{
  id: string;
  label?: string;
  min: number;
  max: number;
  default: number;
  curve?: "lin" | "exp";
  to: readonly Readonly<{ port: string; min?: number; max?: number }>[];
}>;

/** A patch as dawg stores it; `print` writes this form back. */
export type PatchSpec = Readonly<{
  kind: "patch";
  role: "instrument" | "effect";
  name: string;
  nodes: readonly PatchNodeData[];
  cables: readonly PatchCableData[];
  /** At most 16; the first four are the knobs, in this order. */
  macros: readonly PatchMacroData[];
  /** Polyphony cap (default 16). */
  voices?: number;
  /** Sidechain track id read through `input.side`. */
  side?: string;
  /** Effect patches: `post` runs after pan on the stereo pair. */
  at?: "post";
  /** Provenance, e.g. `pack:dawg/acid-bass@3`. */
  from?: string;
}>;

/** A track that plays a patch from `song({ patches })` with its own knob values. */
export type PatchRefSpec = Readonly<{
  kind: "patch";
  ref: string;
  /** Macro values by id, in macro units. */
  macros?: Readonly<Record<string, number>>;
  side?: string;
}>;

/** The plain form `patch({ ... })` takes; `kind` and `role` may be left out. */
export type PatchData = Readonly<
  Omit<PatchSpec, "kind" | "role" | "cables" | "macros"> & {
    kind?: "patch";
    role?: "instrument" | "effect";
    cables?: readonly PatchCableData[];
    macros?: readonly PatchMacroData[];
  }
>;

/** The plain form of a reference: `patch({ ref: "acid-bass", macros: { cutoff: 900 } })`. */
export type PatchRefData = Readonly<
  Omit<PatchRefSpec, "kind"> & { kind?: "patch" }
>;

/** An output port: `a` audio, `c` control, `n` notes. */
export interface PatchSource<K extends "a" | "c" | "n" = "a" | "c" | "n"> {
  readonly kind: K;
  /** `node.port`, or `macro:<id>` for a macro. */
  readonly port: string;
}

/** What a control input takes: a number, a control output, a macro or a signal. */
export type ControlValue = number | PatchSource<"c"> | PatternSignal;

/** A control output; its math creates `add`, `mul` and `scale` nodes. */
export interface ControlSource extends PatchSource<"c"> {
  /** An `add` node: this plus `value` (Strudel `.add`). */
  plus(value: ControlValue): ControlSource;
  /** A `mul` node: this times `value` (Strudel `.mul`). */
  times(value: ControlValue): ControlSource;
  /** A `scale` node mapping this output's range (0..1, or -1..1 for an LFO) onto `lo..hi`. */
  range(lo: ControlValue, hi: ControlValue): ControlSource;
  /** The same output through a cable attenuverter `k` (-1..1). */
  amount(k: number): PatchSource<"c">;
}

/** An audio output. */
export interface AudioSource extends PatchSource<"a"> {
  /**
   * Wires this output into `node`'s audio input (a stereo pair into a
   * stereo pair) and returns `node`, so chains read left to right.
   */
  to<B extends PatchSource>(node: B): B;
}

type PatchOut<C> = C extends "a"
  ? AudioSource
  : C extends "n"
    ? PatchSource<"n">
    : ControlSource;

type PatchArg<C> = C extends "n"
  ? PatchSource<"n">
  : C extends "a"
    ? PatchSource<"a">
    : C extends "ca"
      ? ControlValue | PatchSource<"a">
      : ControlValue;

type PatchAnyTable = PatchNodeTable & PatchBoundaryTable;

/** A node in a patch being built: a setter per input port, and its main output. */
export type PatchNode<T extends keyof PatchAnyTable> = {
  [P in keyof PatchAnyTable[T]["inputs"]]: (
    value: PatchArg<PatchAnyTable[T]["inputs"][P]>,
  ) => PatchNode<T>;
} & Omit<
  PatchOut<PatchAnyTable[T]["main"]>,
  keyof PatchAnyTable[T]["inputs"]
> & {
    /** The node id: pinned with `{ id }`, else derived from the patch's name. */
    readonly id: string;
    /** Runs this node once per track, after the voices are summed. */
    global(): PatchNode<T>;
    /** Another output port (`pan().output("right")`). */
    output<P extends keyof PatchAnyTable[T]["outputs"]>(
      name: P,
    ): PatchOut<PatchAnyTable[T]["outputs"][P]>;
  };

type PatchNodeOptions<T extends keyof PatchNodeTable> =
  PatchNodeTable[T]["params"] & Readonly<{ id?: string; label?: string }>;

type PatchFactory<T extends keyof PatchNodeTable> = (
  params?: PatchNodeOptions<T>,
) => PatchNode<T>;

type PatchBoundary<B extends keyof PatchBoundaryTable> = {
  readonly [P in keyof PatchBoundaryTable[B]["outputs"]]: PatchOut<
    PatchBoundaryTable[B]["outputs"][P]
  >;
};

/** A macro's range: `{ min: 80, max: 4000, default: 600, curve: "exp" }`. */
export type PatchMacroInput = Readonly<{
  min?: number;
  max?: number;
  default?: number;
  curve?: "lin" | "exp";
  label?: string;
}>;

/**
 * What a patch's build callback receives: a factory per node type
 * (`osc`, `svf`, `fx.distort`, `engine.modal`), the boundary (`voice`,
 * `song`, `input`) and `macro`.
 */
export type PatchKit = {
  [
    T in keyof PatchNodeTable as T extends `${string}.${string}` ? never : T
  ]: PatchFactory<T>;
} & {
  /** Effects as nodes (buffer rate, once per track). */
  fx: {
    [
      T in keyof PatchNodeTable as T extends `fx.${infer S}` ? S : never
    ]: PatchFactory<T>;
  };
  /**
   * Instrument engines as nodes: `engine.modal(modal("vibes"))` wraps an
   * engine spec, `engine.synth({ instrument: "pluck" })` names a word.
   */
  engine: {
    [T in keyof PatchNodeTable as T extends `engine.${infer S}` ? S : never]: (
      params?: PatchNodeOptions<T> | Readonly<{ kind: string }>,
    ) => PatchNode<T>;
  };
  /** Per-voice values: `pitch`, `gate`, `velocity`, … */
  voice: PatchBoundary<"voice"> & ControlSource;
  /** Song time: `beat`, `bar.phase`, `tempo`. */
  song: PatchBoundary<"song"> & ControlSource;
  /** The track's notes, its audio (effect patches) and the sidechain. */
  input: PatchBoundary<"in"> & Pick<AudioSource, "to"> & PatchSource<"n">;
  /** Declares a macro; the first four are the knobs, in call order. */
  macro(id: string, spec?: PatchMacroInput): ControlSource;
};

/** `patch(name, build, options)`: polyphony, sidechain, placement, provenance. */
export type PatchOptions = Readonly<{
  voices?: number;
  side?: string;
  at?: "post";
  from?: string;
}>;

type PatchSourceData = Readonly<{
  kind: "a" | "c" | "n";
  /** `node.port`, absent for a macro. */
  from?: string;
  macro?: string;
  amount?: number;
  /** The output swings -1..1 (an LFO), so `.range()` maps from -1. */
  bipolar?: boolean;
}>;

type PatchRecorder = {
  name: string;
  role: "instrument" | "effect";
  nodes: {
    id: string;
    type: string;
    params: Record<string, unknown>;
    rate?: "global";
    label?: string;
  }[];
  cables: { id: string; from: string; to: string; amount?: number }[];
  macros: {
    id: string;
    label?: string;
    min: number;
    max: number;
    default: number;
    curve?: "exp";
    to: { port: string }[];
  }[];
  pending: { port: string; signal: PatternSignal }[];
  ordinals: Map<string, number>;
};

const PATCH_SOURCES = new WeakMap<object, PatchSourceData>();
/** Signals wired into a patch's inputs, by the hidden macro they drive. */
const PATCH_SIGNALS = new WeakMap<
  object,
  readonly (readonly [string, PatternSignal])[]
>();
const PATCH_ID = /^[a-z][a-z0-9-]*$/;
const PATCH_NAME = /^[a-z0-9][a-z0-9-]*$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Eight base32 characters of a stable hash, in `newId`'s alphabet. */
function patchHash(text: string): string {
  const hex = hash64(text);
  let a = Number.parseInt(hex.slice(0, 8), 16);
  let b = Number.parseInt(hex.slice(8), 16);
  let out = "";
  for (let index = 0; index < 8; index += 1) {
    const word = index < 4 ? a : b;
    out += BASE32[word & 31];
    if (index < 4) a = Math.floor(a / 32);
    else b = Math.floor(b / 32);
  }
  return out;
}

function patchPorts(type: string) {
  const row = PATCH_NODE_PORTS[type];
  if (!row) throw new DawgSdkError(`unknown patch node type "${type}"`);
  return row;
}

function patchInput(type: string, port: string): PatchPortRow {
  const row = patchPorts(type).inputs.find(([name]) => name === port);
  if (!row) throw new DawgSdkError(`no port ${port} on ${type}`);
  return row;
}

function nodeTypeOf(rec: PatchRecorder, id: string): string {
  if (id === "in" || id === "out" || id === "voice" || id === "song") return id;
  const node = rec.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new DawgSdkError(`${rec.name}: no node "${id}"`);
  return node.type;
}

function addNode(
  rec: PatchRecorder,
  type: string,
  input: unknown,
): PatchRecorder["nodes"][number] {
  const row = patchPorts(type);
  if (input !== undefined && !isRecord(input))
    throw new DawgSdkError(`${rec.name}: ${type}() takes an object`);
  const {
    id: pinned,
    label,
    ...rest
  } = (input ?? {}) as Record<string, unknown>;
  let id: string;
  if (pinned !== undefined) {
    if (
      typeof pinned !== "string" ||
      pinned.length > 32 ||
      !PATCH_ID.test(pinned)
    )
      throw new DawgSdkError(
        `${rec.name}: node id must be [a-z][a-z0-9-]*, at most 32 characters`,
      );
    id = pinned;
  } else {
    const head =
      type
        .replace(/^(fx|engine|patch)\./, "")
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^[^a-z]+/, "")
        .slice(0, 20) || "node";
    let ordinal = rec.ordinals.get(type) ?? 0;
    do {
      ordinal += 1;
      id = `${head}-${patchHash(`${rec.name}|${type}|${ordinal}`)}`;
    } while (rec.nodes.some((node) => node.id === id));
    rec.ordinals.set(type, ordinal);
  }
  if (
    ["in", "out", "voice", "song"].includes(id) ||
    rec.nodes.some((node) => node.id === id)
  )
    throw new DawgSdkError(`${rec.name}: node id "${id}" is taken`);
  if (
    label !== undefined &&
    (typeof label !== "string" || label.length === 0 || label.length > 48)
  )
    throw new DawgSdkError(
      `${rec.name}: node ${id} label must be 1..48 characters`,
    );
  const allowed = row.engine ? [...row.params, "settings"] : row.params;
  for (const key of Object.keys(rest))
    if (!allowed.includes(key))
      throw new DawgSdkError(`${rec.name}: ${type} has no param "${key}"`);
  const params: Record<string, unknown> = {};
  for (const key of allowed)
    if (rest[key] !== undefined) params[key] = rest[key];
  const node = {
    id,
    type,
    params,
    ...(label !== undefined ? { label: label as string } : {}),
  };
  rec.nodes.push(node);
  return node;
}

/** Wraps an engine spec (`modal("vibes")`) as an engine node's params. */
function engineParams(type: string, value: unknown): unknown {
  if (!isRecord(value) || typeof value.kind !== "string") return value;
  const spec = track({
    name: "engine",
    instrument: value as TrackInput["instrument"],
  });
  const fields = patchPorts(type).engine ?? [];
  const settings: Record<string, unknown> = {};
  for (const field of fields) {
    const setting = (spec as Record<string, unknown>)[field];
    if (isRecord(setting)) {
      const { kind: _kind, ...rest } = setting;
      settings[field] = rest;
    }
  }
  return {
    instrument: spec.instrument,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

function patchSource(rec: PatchRecorder, data: PatchSourceData): object {
  const port = data.from ?? `macro:${data.macro}`;
  const source: Record<string, unknown> = { kind: data.kind, port };
  if (data.kind === "c")
    Object.assign(
      source,
      controlOps(rec, () => data),
    );
  if (data.kind === "a")
    source.to = (target: unknown) => connect(rec, data, target);
  PATCH_SOURCES.set(source, data);
  return Object.freeze(source);
}

function controlOps(rec: PatchRecorder, data: () => PatchSourceData) {
  const math = (type: string, a: string, b: string, value: unknown) => {
    const node = addNode(rec, type, undefined);
    wire(rec, `${node.id}.${a}`, patchSource(rec, data()));
    wire(rec, `${node.id}.${b}`, value);
    return nodeHandle(rec, node);
  };
  return {
    plus: (value: unknown) => math("add", "a", "b", value),
    times: (value: unknown) => math("mul", "a", "b", value),
    range: (lo: unknown, hi: unknown) => {
      const source = data();
      const macro = source.macro
        ? rec.macros.find((candidate) => candidate.id === source.macro)
        : undefined;
      const node = addNode(rec, "scale", {
        inmin: macro ? macro.min : source.bipolar ? -1 : 0,
        inmax: macro ? macro.max : 1,
      });
      wire(rec, `${node.id}.in`, patchSource(rec, source));
      wire(rec, `${node.id}.min`, lo);
      wire(rec, `${node.id}.max`, hi);
      return nodeHandle(rec, node);
    },
    amount: (k: unknown) => {
      const source = data();
      const amount = finite(k, `${rec.name}: amount`);
      if (amount < -1 || amount > 1)
        throw new DawgSdkError(`${rec.name}: amount must be -1..1`);
      if (!source.from)
        throw new DawgSdkError(
          `${rec.name}: amount() works on a node output, not a macro`,
        );
      return patchSource(rec, { ...source, amount });
    },
  };
}

/** Wires `value` into the input `target` (`node.port`). */
function wire(rec: PatchRecorder, target: string, value: unknown): void {
  const dot = target.indexOf(".");
  const id = target.slice(0, dot);
  const port = target.slice(dot + 1);
  const type = nodeTypeOf(rec, id);
  const [, code, min, max] = patchInput(type, port);
  const node = rec.nodes.find((candidate) => candidate.id === id);
  const label = `${rec.name}: ${target}`;
  const control = code === "c" || code === "ca";
  if (typeof value === "number") {
    if (!control)
      throw new DawgSdkError(
        `${label} takes ${code === "a" ? "audio" : "notes"}, not a number`,
      );
    if (node && patchPorts(type).params.includes(port))
      node.params[port] = finite(value, label);
    else {
      const constant = addNode(rec, "const", { value: finite(value, label) });
      wire(
        rec,
        target,
        patchSource(rec, { kind: "c", from: `${constant.id}.out` }),
      );
    }
    return;
  }
  if (isPatternSignal(value)) {
    if (!control)
      throw new DawgSdkError(
        `${label} takes ${code === "a" ? "audio" : "notes"}, not a signal`,
      );
    const signal =
      value instanceof PatternSignal ? value : signalFromData(value);
    if (
      min === undefined &&
      !(node && patchPorts(type).params.includes(port))
    ) {
      const constant = addNode(rec, "const", undefined);
      rec.pending.push({ port: `${constant.id}.value`, signal });
      wire(
        rec,
        target,
        patchSource(rec, { kind: "c", from: `${constant.id}.out` }),
      );
    } else rec.pending.push({ port: target, signal });
    void max;
    return;
  }
  const data =
    isRecord(value) || typeof value === "function"
      ? PATCH_SOURCES.get(value as object)
      : undefined;
  if (!data)
    throw new DawgSdkError(
      `${label}: wire a number, a node, a macro or a signal`,
    );
  const fits =
    data.kind === code ||
    (code === "ca" && (data.kind === "c" || data.kind === "a"));
  if (!fits) {
    const word = {
      a: "audio",
      c: "control",
      n: "notes",
      ca: "control",
    } as const;
    throw new DawgSdkError(
      `${label} takes ${word[code]}, not ${word[data.kind]}`,
    );
  }
  if (data.macro) {
    const macro = rec.macros.find((candidate) => candidate.id === data.macro)!;
    if (
      min === undefined &&
      !(node && patchPorts(type).params.includes(port))
    ) {
      const constant = addNode(rec, "const", undefined);
      macro.to.push({ port: `${constant.id}.value` });
      wire(
        rec,
        target,
        patchSource(rec, { kind: "c", from: `${constant.id}.out` }),
      );
    } else {
      if (macro.to.some((existing) => existing.port === target))
        throw new DawgSdkError(
          `${rec.name}: macro ${macro.id} already sets ${target}`,
        );
      macro.to.push({ port: target });
    }
    return;
  }
  const from = data.from!;
  if (rec.cables.some((cable) => cable.from === from && cable.to === target))
    throw new DawgSdkError(
      `${rec.name}: ${from} is already wired to ${target}`,
    );
  rec.cables.push({
    id: `c-${patchHash(`${rec.name}|${from}|${target}`)}`,
    from,
    to: target,
    ...(data.amount !== undefined && data.amount !== 1
      ? { amount: data.amount }
      : {}),
  });
}

/** The audio outputs `.to()` uses: the first, and `right` when it has one. */
function audioPair(rows: readonly PatchPortRow[]): string[] {
  const audio = rows.filter(([name, code]) => code === "a" && name !== "side");
  const first = audio[0]?.[0];
  if (first === undefined) return [];
  const right = audio.find(([name]) => name === "right" && name !== first);
  return right ? [first, right[0]] : [first];
}

function connect(
  rec: PatchRecorder,
  source: PatchSourceData,
  target: unknown,
): unknown {
  const id = isRecord(target) ? PATCH_TARGETS.get(target) : undefined;
  if (id === undefined)
    throw new DawgSdkError(`${rec.name}: .to() needs a node`);
  connectTo(rec, source, id);
  return target;
}

function connectTo(
  rec: PatchRecorder,
  source: PatchSourceData,
  id: string,
): void {
  const inputs = audioPair(patchPorts(nodeTypeOf(rec, id)).inputs);
  if (inputs.length === 0)
    throw new DawgSdkError(`${rec.name}: ${id} has no audio input`);
  const [node, port] = splitRef(source.from ?? "");
  const outputs =
    port === audioPair(patchPorts(nodeTypeOf(rec, node)).outputs)[0]
      ? audioPair(patchPorts(nodeTypeOf(rec, node)).outputs)
      : [port];
  outputs
    .slice(0, inputs.length)
    .forEach((out, index) =>
      wire(
        rec,
        `${id}.${inputs[index]}`,
        patchSource(rec, { kind: "a", from: `${node}.${out}` }),
      ),
    );
  if (outputs.length === 1 && inputs.length === 2)
    wire(
      rec,
      `${id}.${inputs[1]}`,
      patchSource(rec, { kind: "a", from: `${node}.${outputs[0]}` }),
    );
}

function splitRef(ref: string): [string, string] {
  const dot = ref.indexOf(".");
  return [ref.slice(0, dot), ref.slice(dot + 1)];
}

/** Node handles by object, to their node id (for `.to()`). */
const PATCH_TARGETS = new WeakMap<object, string>();

function nodeHandle(
  rec: PatchRecorder,
  node: PatchRecorder["nodes"][number],
): unknown {
  const row = patchPorts(node.type);
  const main = row.outputs[0];
  const data = (port: string): PatchSourceData => {
    const out = row.outputs.find(([name]) => name === port);
    if (!out) throw new DawgSdkError(`no output ${port} on ${node.type}`);
    return {
      kind: out[1] === "ca" ? "c" : (out[1] as "a" | "c" | "n"),
      from: `${node.id}.${port}`,
      ...(out[2] === -1 ? { bipolar: true } : {}),
    };
  };
  const handle: Record<string, unknown> = {
    id: node.id,
    ...(main
      ? { kind: data(main[0]).kind, port: `${node.id}.${main[0]}` }
      : {}),
  };
  if (main && data(main[0]).kind === "c")
    Object.assign(
      handle,
      controlOps(rec, () => data(main[0])),
    );
  if (main && audioPair(row.outputs).length > 0)
    handle.to = (target: unknown) =>
      connect(rec, data(audioPair(row.outputs)[0]!), target);
  handle.global = () => {
    node.rate = "global";
    return handle;
  };
  handle.output = (port: string) => patchSource(rec, data(port));
  for (const [name] of row.inputs)
    handle[name] = (value: unknown) => {
      wire(rec, `${node.id}.${name}`, value);
      return handle;
    };
  if (main) PATCH_SOURCES.set(handle, data(main[0]));
  PATCH_TARGETS.set(handle, node.id);
  return handle;
}

function boundary(rec: PatchRecorder, id: "voice" | "song" | "in"): unknown {
  const row = patchPorts(id);
  const out: Record<string, unknown> = {};
  for (const [name, code] of row.outputs)
    out[name] = patchSource(rec, {
      kind: code === "ca" ? "c" : (code as "a" | "c" | "n"),
      from: `${id}.${name}`,
    });
  const main = row.outputs[0]!;
  const data = PATCH_SOURCES.get(out[main[0]] as object)!;
  const handle: Record<string, unknown> = {
    ...out,
    kind: data.kind,
    port: data.from,
  };
  if (data.kind === "c")
    Object.assign(
      handle,
      controlOps(rec, () => data),
    );
  if (id === "in")
    handle.to = (target: unknown) =>
      connect(rec, { kind: "a", from: "in.audio" }, target);
  PATCH_SOURCES.set(handle, data);
  return Object.freeze(handle);
}

function patchKit(rec: PatchRecorder): PatchKit {
  const kit: Record<string, unknown> = { fx: {}, engine: {} };
  for (const type of Object.keys(PATCH_NODE_PORTS)) {
    if (["in", "out", "voice", "song"].includes(type)) continue;
    const make = (input?: unknown) =>
      nodeHandle(
        rec,
        addNode(
          rec,
          type,
          type.startsWith("engine.") ? engineParams(type, input) : input,
        ),
      );
    const [family, name] = type.includes(".") ? splitRef(type) : ["", type];
    if (family) (kit[family] as Record<string, unknown>)[name] = make;
    else kit[type] = make;
  }
  kit.voice = boundary(rec, "voice");
  kit.song = boundary(rec, "song");
  kit.input = boundary(rec, "in");
  kit.macro = (id: unknown, spec: unknown = {}) => {
    if (typeof id !== "string" || id.length > 32 || !PATCH_ID.test(id))
      throw new DawgSdkError(
        `${rec.name}: macro id must be [a-z][a-z0-9-]*, at most 32 characters`,
      );
    if (rec.macros.some((macro) => macro.id === id))
      throw new DawgSdkError(`${rec.name}: two macros named ${id}`);
    if (!isRecord(spec))
      throw new DawgSdkError(`${rec.name}: macro ${id} takes an object`);
    const min = finite(spec.min ?? 0, `macro ${id} min`);
    const max = finite(spec.max ?? 1, `macro ${id} max`);
    if (!(max > min))
      throw new DawgSdkError(`${rec.name}: macro ${id} max must be above min`);
    if (
      spec.curve !== undefined &&
      spec.curve !== "lin" &&
      spec.curve !== "exp"
    )
      throw new DawgSdkError(
        `${rec.name}: macro ${id} curve must be lin or exp`,
      );
    if (spec.curve === "exp" && min <= 0)
      throw new DawgSdkError(
        `${rec.name}: macro ${id}: an exp curve needs min above 0`,
      );
    const value = Math.min(
      max,
      Math.max(min, finite(spec.default ?? min, `macro ${id} default`)),
    );
    if (
      spec.label !== undefined &&
      (typeof spec.label !== "string" ||
        spec.label.length === 0 ||
        spec.label.length > 48)
    )
      throw new DawgSdkError(
        `${rec.name}: macro ${id} label must be 1..48 characters`,
      );
    rec.macros.push({
      id,
      ...(spec.label !== undefined ? { label: spec.label as string } : {}),
      min,
      max,
      default: value,
      ...(spec.curve === "exp" ? { curve: "exp" as const } : {}),
      to: [],
    });
    return patchSource(rec, { kind: "c", macro: id });
  };
  return kit as PatchKit;
}

function compareCableData(a: PatchCableData, b: PatchCableData): number {
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return order(a.to, b.to) || order(a.from, b.from) || order(a.id, b.id);
}

function buildPatch(
  role: "instrument" | "effect",
  name: unknown,
  build: (kit: PatchKit) => unknown,
  options: PatchOptions = {},
): PatchSpec {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 64 ||
    !PATCH_NAME.test(name)
  )
    throw new DawgSdkError(
      "a patch's name must be lowercase letters, digits and dashes, at most 64 characters",
    );
  if (typeof build !== "function")
    throw new DawgSdkError(`patch ${name}: build must be a function`);
  const rec: PatchRecorder = {
    name,
    role,
    nodes: [],
    cables: [],
    macros: [],
    pending: [],
    ordinals: new Map(),
  };
  const result = build(patchKit(rec));
  const data =
    isRecord(result) || typeof result === "function"
      ? PATCH_SOURCES.get(result as object)
      : undefined;
  if (!data || data.kind !== "a" || !data.from)
    throw new DawgSdkError(`patch ${name}: build must return the audio output`);
  connectTo(rec, data, "out");
  // Signals wired into inputs drive hidden macros after the declared ones.
  const signals: (readonly [string, PatternSignal])[] = [];
  for (const { port, signal } of rec.pending) {
    const [id, input] = splitRef(port);
    const [, , low, high] = patchInput(nodeTypeOf(rec, id), input);
    const [lo, hi] = signalBounds(signal);
    const min = low === undefined ? lo : Math.max(low, Math.min(high!, lo));
    const max = high === undefined ? hi : Math.max(low!, Math.min(high, hi));
    const node = rec.nodes.find((candidate) => candidate.id === id)!;
    if (!(max > min)) {
      node.params[input] = min;
      continue;
    }
    const base =
      input
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^[^a-z]+/, "")
        .slice(0, 28) || "signal";
    let macroId = base;
    for (let n = 2; rec.macros.some((macro) => macro.id === macroId); n += 1)
      macroId = `${base}-${n}`;
    rec.macros.push({
      id: macroId,
      min,
      max,
      default: Math.min(max, Math.max(min, signalAt(signal, 0))),
      to: [{ port }],
    });
    signals.push([macroId, signal]);
  }
  const patch = Object.freeze({
    kind: "patch" as const,
    role,
    name,
    nodes: Object.freeze(
      rec.nodes.map((node) =>
        Object.freeze({
          id: node.id,
          type: node.type,
          ...(Object.keys(node.params).length > 0
            ? { params: Object.freeze({ ...node.params }) }
            : {}),
          ...(node.rate ? { rate: node.rate } : {}),
          ...(node.label !== undefined ? { label: node.label } : {}),
        }),
      ),
    ),
    cables: Object.freeze(
      rec.cables
        .map((cable) => Object.freeze({ ...cable }))
        .sort(compareCableData),
    ),
    macros: Object.freeze(
      rec.macros.map((macro) =>
        Object.freeze({
          ...macro,
          to: Object.freeze(
            macro.to.map((target) => Object.freeze({ ...target })),
          ),
        }),
      ),
    ),
    ...patchOptions(name, options, role),
  });
  if (patch.macros.length > 16)
    throw new DawgSdkError(`patch ${name} holds at most 16 macros`);
  if (signals.length > 0) PATCH_SIGNALS.set(patch, Object.freeze(signals));
  return patch;
}

function patchOptions(
  name: string,
  options: unknown,
  role: "instrument" | "effect",
): Partial<Pick<PatchSpec, "voices" | "side" | "at" | "from">> {
  if (!isRecord(options))
    throw new DawgSdkError(`patch ${name}: options must be an object`);
  const out: Record<string, unknown> = {};
  if (options.voices !== undefined) {
    const voices = finite(options.voices, `patch ${name} voices`);
    if (!Number.isInteger(voices) || voices < 1 || voices > 32)
      throw new DawgSdkError(`patch ${name} voices must be an integer 1..32`);
    out.voices = voices;
  }
  if (options.side !== undefined) {
    if (typeof options.side !== "string" || options.side.length === 0)
      throw new DawgSdkError(`patch ${name} side must name a track`);
    out.side = options.side;
  }
  if (options.at !== undefined) {
    if (options.at !== "post" || role !== "effect")
      throw new DawgSdkError(
        `patch ${name} at must be "post" (effect patches only)`,
      );
    out.at = "post";
  }
  if (options.from !== undefined) {
    if (
      typeof options.from !== "string" ||
      options.from.length === 0 ||
      options.from.length > 128
    )
      throw new DawgSdkError(`patch ${name} from must be 1..128 characters`);
    out.from = options.from;
  }
  return out;
}

/** The plain form: kept as given (dawg validates and orders it). */
function plainPatch(
  input: Record<string, unknown>,
  role?: "effect",
): PatchSpec | PatchRefSpec {
  if (input.ref !== undefined) {
    const { kind: _kind, ...rest } = input;
    if (typeof input.ref !== "string" || !PATCH_NAME.test(input.ref))
      throw new DawgSdkError(
        "patch ref must name a patch in song({ patches })",
      );
    for (const key of Object.keys(rest))
      if (!["ref", "macros", "side"].includes(key))
        throw new DawgSdkError(`patch reference has no field "${key}"`);
    if (rest.macros !== undefined && !isRecord(rest.macros))
      throw new DawgSdkError(`patch ${input.ref} macros must be an object`);
    return Object.freeze({ kind: "patch" as const, ...rest }) as PatchRefSpec;
  }
  const {
    kind: _kind,
    role: given,
    name,
    nodes,
    cables,
    macros,
    ...rest
  } = input;
  if (typeof name !== "string" || !PATCH_NAME.test(name))
    throw new DawgSdkError(
      "a patch's name must be lowercase letters, digits and dashes, at most 64 characters",
    );
  if (!Array.isArray(nodes))
    throw new DawgSdkError(`patch ${name}: nodes must be a list`);
  if (cables !== undefined && !Array.isArray(cables))
    throw new DawgSdkError(`patch ${name}: cables must be a list`);
  if (macros !== undefined && !Array.isArray(macros))
    throw new DawgSdkError(`patch ${name}: macros must be a list`);
  const kind = given ?? role ?? "instrument";
  if (kind !== "instrument" && kind !== "effect")
    throw new DawgSdkError(`patch ${name} role must be instrument or effect`);
  return Object.freeze({
    kind: "patch" as const,
    role: kind,
    name,
    nodes: Object.freeze([...nodes]),
    cables: Object.freeze([...((cables as unknown[]) ?? [])]),
    macros: Object.freeze([...((macros as unknown[]) ?? [])]),
    ...patchOptions(name, rest, kind),
  }) as PatchSpec;
}

/**
 * A modular patch. The builder form records a graph:
 *
 *     patch("acid-bass", ({ voice, osc, svf, adsr, vca, fx, macro }) => {
 *       const cutoff = macro("cutoff", { min: 80, max: 4000, default: 600, curve: "exp" });
 *       const env = adsr({ decay: 0.18, sustain: 0 }).gate(voice.gate);
 *       return osc({ wave: "saw" }).pitch(voice.pitch)
 *         .to(svf({ mode: "lp" }).cutoff(cutoff.plus(env.times(2400))))
 *         .to(fx.distort({ drive: 2 }).global());
 *     })
 *
 * The plain form `patch({ name, nodes, cables, macros })` takes the stored
 * shape, which is what dawg prints; `patch({ ref: "acid-bass" })` plays a
 * patch from `song({ patches })`. Play one with `track({ instrument })`.
 */
export function patch(
  name: string,
  build: (kit: PatchKit) => PatchSource<"a">,
  options?: PatchOptions,
): PatchSpec;
export function patch(data: PatchData): PatchSpec;
export function patch(data: PatchRefData): PatchRefSpec;
export function patch(
  name: string | PatchData | PatchRefData,
  build?: (kit: PatchKit) => PatchSource<"a">,
  options?: PatchOptions,
): PatchSpec | PatchRefSpec {
  if (isRecord(name)) return plainPatch(name);
  return buildPatch(
    "instrument",
    name,
    build as (kit: PatchKit) => unknown,
    options,
  );
}

/**
 * An effect patch, placed with `fx: { patch: [wideCrush] }`:
 * `fxPatch("wide-crush", ({ input, fx, lfo }) =>
 * input.to(fx.crush().bits(lfo({ rate: 0.25 }).range(4, 12))))`.
 */
export function fxPatch(
  name: string,
  build: (kit: PatchKit) => PatchSource<"a">,
  options?: PatchOptions,
): PatchSpec;
export function fxPatch(data: PatchData): PatchSpec;
export function fxPatch(
  name: string | PatchData,
  build?: (kit: PatchKit) => PatchSource<"a">,
  options?: PatchOptions,
): PatchSpec {
  if (isRecord(name)) return plainPatch(name, "effect") as PatchSpec;
  return buildPatch(
    "effect",
    name,
    build as (kit: PatchKit) => unknown,
    options,
  );
}

/** True for a patch or a patch reference. */
export function isPatchValue(
  value: unknown,
): value is PatchSpec | PatchRefSpec {
  return isRecord(value) && value.kind === "patch";
}

/** The signals a built patch wired into its inputs, by hidden macro id. */
export function patchSignals(
  value: PatchSpec | PatchRefSpec,
): readonly (readonly [string, PatternSignal])[] {
  return PATCH_SIGNALS.get(value) ?? [];
}
