/**
 * The agent eval task set. Each task is a prompt, a starting score, a code
 * grader and a reference solution: the tool calls a correct agent could
 * make. The CI test replays every reference through the real agent loop
 * and requires its grader to pass, and replays a do-nothing answer and
 * requires its grader to fail, so no task is unsolvable or vacuous.
 *
 * Musical content is theory only: rhythms as grids, progressions as
 * functional grammar, scales as pitch-class sets. No melody is copied.
 */
import {
  createScore,
  type NoteInput,
  type TrackInput,
  type TrackScore,
} from "../../core/score.ts";
import type { ScriptedCall } from "./client.ts";
import {
  barBeats,
  beatOf,
  check,
  chordTones,
  drumHits,
  everyBar,
  filesEvaluate,
  filterRamp,
  grid,
  inScale,
  leaps,
  lengthOf,
  loopBeats,
  lowestPerOnset,
  MAJOR,
  meterOf,
  MINOR_PENTATONIC,
  near,
  newTracks,
  notesOf,
  offsetsInBars,
  othersUnchanged,
  pc,
  pitchClassesIn,
  progressionInOrder,
  round,
  sameBeats,
  scale,
  shape,
  trackById,
  tracksMatching,
  usedFiles,
  type Check,
  type GradeContext,
} from "./grade.ts";

export type Tier = "single" | "compose" | "files" | "multi" | "recovery";

export type EvalTask = Readonly<{
  id: string;
  tier: Tier;
  prompt: string;
  setup(): Readonly<{ score: TrackScore; focus: string }>;
  grade(ctx: GradeContext): readonly Check[];
  /** Model responses of a correct solution, one array per agent step. */
  reference: readonly (readonly ScriptedCall[])[];
}>;

/** The style engine (apply_style) has not merged; style tasks are skipped. */
export const SKIPPED_TIERS = ["style"] as const;

// ---------------------------------------------------------------- fixtures

const TPB = 480;
const n = (
  id: string,
  trackId: string,
  beat: number,
  beats: number,
  pitch: number,
  velocity = 0.8,
): NoteInput => ({
  id,
  trackId,
  startTick: Math.round(beat * TPB),
  durationTicks: Math.round(beats * TPB),
  pitch,
  velocity,
});

/** A small band in C major: drums, bass, keys and a lead melody. */
function band(
  extra: Partial<{
    tempoBpm: number;
    bars: number;
    key: string;
    tracks: TrackInput[];
    notes: NoteInput[];
  }> = {},
) {
  const tracks: TrackInput[] = extra.tracks ?? [
    { id: "drums", name: "drums", instrument: "kit" },
    { id: "bass", name: "bass", instrument: "bass" },
    { id: "keys", name: "keys", instrument: "piano" },
    { id: "lead", name: "lead", instrument: "saw" },
  ];
  const notes: NoteInput[] = extra.notes ?? [
    // kick on 1 and 3, snare on 2 and 4, bar 1 only
    n("k1", "drums", 0, 0.25, 36),
    n("k2", "drums", 2, 0.25, 36),
    n("s1", "drums", 1, 0.25, 38),
    n("s2", "drums", 3, 0.25, 38),
    // bass roots C F G C, one per bar
    n("b1", "bass", 0, 2, 36),
    n("b2", "bass", 4, 2, 41),
    n("b3", "bass", 8, 2, 43),
    n("b4", "bass", 12, 2, 36),
    // keys: C major triad held in bar 1
    n("c1", "keys", 0, 4, 60, 0.6),
    n("c2", "keys", 0, 4, 64, 0.6),
    n("c3", "keys", 0, 4, 67, 0.6),
    // lead: an abstract stepwise line in C major
    n("m1", "lead", 0, 1, 72),
    n("m2", "lead", 1, 1, 74),
    n("m3", "lead", 2, 1, 76),
    n("m4", "lead", 3, 1, 74),
    n("m5", "lead", 4, 2, 72),
    n("m6", "lead", 6, 2, 67),
  ];
  return createScore({
    tempoBpm: extra.tempoBpm ?? 100,
    bars: extra.bars ?? 4,
    key: extra.key ?? "C major",
    tracks,
    notes,
  });
}

const bandSetup =
  (focus: string, extra?: Parameters<typeof band>[0]) => () => ({
    score: band(extra),
    focus,
  });

/** An empty song with the given tracks. */
const blank =
  (
    tracks: TrackInput[],
    focus: string,
    extra: Partial<{ tempoBpm: number; bars: number; key: string }> = {},
  ) =>
  () => ({
    score: createScore({
      tempoBpm: extra.tempoBpm ?? 120,
      bars: extra.bars ?? 4,
      key: extra.key ?? "C major",
      tracks,
    }),
    focus,
  });

const KIT: TrackInput = { id: "drums", name: "drums", instrument: "kit" };
const BASS: TrackInput = { id: "bass", name: "bass", instrument: "bass" };
const KEYS: TrackInput = { id: "keys", name: "keys", instrument: "piano" };
const LEAD: TrackInput = { id: "lead", name: "lead", instrument: "saw" };

// ------------------------------------------------------------- grade bits

const tempoIs = (ctx: GradeContext, bpm: number, tol = 0.5) =>
  check(
    `tempo ${bpm}`,
    Math.abs(ctx.score.tempoBpm - bpm) <= tol,
    `${ctx.score.tempoBpm}`,
  );

const tempoIn = (ctx: GradeContext, lo: number, hi: number) =>
  check(
    `tempo ${lo}..${hi}`,
    ctx.score.tempoBpm >= lo && ctx.score.tempoBpm <= hi,
    `${ctx.score.tempoBpm}`,
  );

const hitsAre = (
  ctx: GradeContext,
  voice: Parameters<typeof drumHits>[1],
  expected: readonly number[],
  label = `${voice} hits`,
) => {
  const hits = drumHits(ctx.score, voice);
  return check(label, sameBeats(hits, expected), hits.join(" "));
};

/** Every expected position is hit (extra hits allowed). */
const hitsInclude = (
  ctx: GradeContext,
  voice: Parameters<typeof drumHits>[1],
  expected: readonly number[],
  label = `${voice} covers`,
) => {
  const hits = new Set(drumHits(ctx.score, voice));
  const missing = expected.map(round).filter((beat) => !hits.has(beat));
  return check(
    label,
    missing.length === 0,
    missing.length ? `missing ${missing.slice(0, 8).join(" ")}` : undefined,
  );
};

const keyIs = (ctx: GradeContext, tonic: string, mode: string) => {
  const key = (ctx.score.key ?? "").trim().split(/\s+/);
  const ok =
    key.length === 2 &&
    pc(key[0]!) === pc(tonic) &&
    key[1]!.toLowerCase() === mode;
  return check(`key ${tonic} ${mode}`, ok, ctx.score.key ?? "none");
};

const shapeShift = (
  ctx: GradeContext,
  trackId: string,
  semitones: number,
): Check => {
  const before = notesOf(ctx.initial, trackId);
  const after = notesOf(ctx.score, trackId);
  const ok =
    before.length === after.length &&
    before.every((note, i) => {
      const now = after[i]!;
      return (
        now.pitch === note.pitch + semitones &&
        now.startTick === note.startTick &&
        now.durationTicks === note.durationTicks
      );
    });
  return check(
    `${trackId} shifted ${semitones}`,
    ok,
    after.map((note) => note.pitch).join(" "),
  );
};

const unchanged = (ctx: GradeContext, trackId: string) =>
  check(
    `${trackId} notes unchanged`,
    shape(ctx.initial, trackId) === shape(ctx.score, trackId),
  );

/** The only track matching `pattern` that is new or named in the prompt. */
function findTrack(ctx: GradeContext, pattern: RegExp) {
  return tracksMatching(ctx.score, pattern)[0];
}

/** Chord tones of `symbol` sound in each of `bars` (1-based) on `tracks`. */
function barsHoldChords(
  ctx: GradeContext,
  trackIds: readonly string[],
  symbols: readonly string[],
  label: string,
  barsPerChord = 1,
): Check {
  const tracks = ctx.score.tracks.filter((t) => trackIds.includes(t.id));
  const bar = barBeats(ctx.score);
  const misses: string[] = [];
  symbols.forEach((symbol, i) => {
    const from = i * bar * barsPerChord;
    const pcs = pitchClassesIn(
      ctx.score,
      tracks,
      from,
      from + bar * barsPerChord,
    );
    if (!chordTones(symbol).every((tone) => pcs.has(tone)))
      misses.push(`${i + 1}:${symbol}`);
  });
  return check(label, misses.length === 0, misses.join(" ") || undefined);
}

const monophonic = (ctx: GradeContext, trackId: string) => {
  const notes = notesOf(ctx.score, trackId);
  const overlaps = notes.filter(
    (note, i) =>
      i > 0 &&
      notes[i - 1]!.startTick + notes[i - 1]!.durationTicks > note.startTick,
  ).length;
  return check(`${trackId} monophonic`, overlaps === 0, `${overlaps} overlaps`);
};

const fileTask = (ctx: GradeContext) => [usedFiles(ctx), filesEvaluate(ctx)];

// ----------------------------------------------------- reference helpers

const call = (name: string, args: unknown): ScriptedCall => ({ name, args });

const notesCall = (
  trackId: string,
  notes: ReadonlyArray<
    [pitch: number | string, start: number, duration: number, velocity?: number]
  >,
) =>
  call("add_notes", {
    trackId,
    notes: notes.map(([pitch, start, duration, velocity]) => ({
      pitch,
      start,
      duration,
      ...(velocity === undefined ? {} : { velocity }),
    })),
  });

/** update_notes moving every listed fixture note by `semitones`. */
const transposeCall = (
  ids: ReadonlyArray<[id: string, pitch: number]>,
  semitones: number,
) =>
  call("update_notes", {
    updates: ids.map(([noteId, pitch]) => ({
      noteId,
      pitch: pitch + semitones,
    })),
  });

const BASS_IDS: Array<[string, number]> = [
  ["b1", 36],
  ["b2", 41],
  ["b3", 43],
  ["b4", 36],
];
const LEAD_IDS: Array<[string, number]> = [
  ["m1", 72],
  ["m2", 74],
  ["m3", 76],
  ["m4", 74],
  ["m5", 72],
  ["m6", 67],
];

/** A kick, snare or hat row of `beats` (quarter-note offsets in a bar). */
const gridRow = (voice: string, offsets: readonly number[], steps = 16) => {
  const cells = Array.from({ length: steps }, () => ".");
  for (const offset of offsets) cells[Math.round(offset * 4)] = "x";
  return { voice, grid: cells.join("") };
};

// ------------------------------------------------------------------ tasks

const single: EvalTask[] = [
  {
    id: "kick-four-on-floor-128",
    tier: "single",
    prompt: "Add a four-on-the-floor kick at 128 BPM.",
    setup: blank([KIT], "drums"),
    grade: (ctx) => [
      tempoIs(ctx, 128),
      hitsAre(ctx, "kick", grid(loopBeats(ctx.score), 1)),
    ],
    reference: [
      [
        call("set_tempo", { bpm: 128 }),
        call("set_rhythm", {
          trackId: "drums",
          rows: [{ voice: "kick", pulses: 4, steps: 16 }],
        }),
      ],
    ],
  },
  {
    id: "snare-backbeat",
    tier: "single",
    prompt: "Put a snare on beats 2 and 4 of every bar.",
    setup: blank([KIT], "drums"),
    grade: (ctx) => [hitsAre(ctx, "snare", everyBar(ctx.score, [1, 3]))],
    reference: [[call("set_rhythm", { rows: [gridRow("snare", [1, 3])] })]],
  },
  {
    id: "hats-eighths",
    tier: "single",
    prompt: "Add closed hi-hats on every eighth note across the loop.",
    setup: blank([KIT], "drums"),
    grade: (ctx) => [hitsAre(ctx, "hat", grid(loopBeats(ctx.score), 0.5))],
    reference: [
      [call("set_rhythm", { rows: [{ voice: "hat", pulses: 8, steps: 16 }] })],
    ],
  },
  {
    id: "offbeat-open-hats",
    tier: "single",
    prompt: "Add open hi-hats on the offbeat (the 'and') of every beat.",
    setup: blank([KIT], "drums"),
    grade: (ctx) => [
      hitsAre(ctx, "openhat", grid(loopBeats(ctx.score), 1, 0.5)),
    ],
    reference: [
      [
        call("set_rhythm", {
          rows: [gridRow("openhat", [0.5, 1.5, 2.5, 3.5])],
        }),
      ],
    ],
  },
  {
    id: "set-tempo-90",
    tier: "single",
    prompt: "Set the tempo to 90 BPM.",
    setup: bandSetup("lead"),
    grade: (ctx) => [tempoIs(ctx, 90), othersUnchanged(ctx, [])],
    reference: [[call("set_tempo", { bpm: 90 })]],
  },
  {
    id: "transpose-bass-whole-step",
    tier: "single",
    prompt: "Transpose the bass track up a whole step. Keep the rhythm.",
    setup: bandSetup("bass"),
    grade: (ctx) => [
      shapeShift(ctx, "bass", 2),
      othersUnchanged(ctx, ["bass"]),
    ],
    reference: [[transposeCall(BASS_IDS, 2)]],
  },
  {
    id: "transpose-lead-octave-down",
    tier: "single",
    prompt: "Move the whole lead melody down one octave.",
    setup: bandSetup("lead"),
    grade: (ctx) => [
      shapeShift(ctx, "lead", -12),
      othersUnchanged(ctx, ["lead"]),
    ],
    reference: [[transposeCall(LEAD_IDS, -12)]],
  },
  {
    id: "reverb-mix-keys",
    tier: "single",
    prompt: "Set the reverb mix on the keys track to 0.4.",
    setup: bandSetup("keys"),
    grade: (ctx) => [
      check(
        "keys reverb mix 0.4",
        near(trackById(ctx.score, "keys")?.reverb?.mix, 0.4),
        JSON.stringify(trackById(ctx.score, "keys")?.reverb ?? null),
      ),
      othersUnchanged(ctx, ["keys"]),
    ],
    reference: [
      [
        call("set_fx", {
          trackId: "keys",
          effect: "reverb",
          params: { mix: 0.4 },
        }),
      ],
    ],
  },
  {
    id: "mute-lead",
    tier: "single",
    prompt: "Mute the lead.",
    setup: bandSetup("bass"),
    grade: (ctx) => [
      check("lead muted", trackById(ctx.score, "lead")?.muted === true),
      unchanged(ctx, "lead"),
      othersUnchanged(ctx, ["lead"]),
    ],
    reference: [[call("set_mix", { trackId: "lead", muted: true })]],
  },
  {
    id: "bass-volume",
    tier: "single",
    prompt: "Turn the bass volume down to 0.6.",
    setup: bandSetup("keys"),
    grade: (ctx) => [
      check(
        "bass volume 0.6",
        near(trackById(ctx.score, "bass")?.volume, 0.6),
        `${trackById(ctx.score, "bass")?.volume}`,
      ),
      unchanged(ctx, "bass"),
    ],
    reference: [[call("set_mix", { trackId: "bass", volume: 0.6 })]],
  },
  {
    id: "pan-keys-left",
    tier: "single",
    prompt: "Pan the keys 30% to the left.",
    setup: bandSetup("lead"),
    grade: (ctx) => [
      check(
        "keys pan -0.3",
        near(trackById(ctx.score, "keys")?.pan, -0.3),
        `${trackById(ctx.score, "keys")?.pan}`,
      ),
    ],
    reference: [[call("set_mix", { trackId: "keys", pan: -0.3 })]],
  },
  {
    id: "extend-to-8-bars",
    tier: "single",
    prompt: "Make the loop 8 bars long without changing any notes.",
    setup: bandSetup("lead"),
    grade: (ctx) => [
      check("8 bars", ctx.score.bars === 8, `${ctx.score.bars}`),
      othersUnchanged(ctx, []),
    ],
    reference: [[call("extend_loop", { bars: 8 })]],
  },
  {
    id: "key-d-dorian",
    tier: "single",
    prompt: "Set the song key to D dorian.",
    setup: bandSetup("keys"),
    grade: (ctx) => [keyIs(ctx, "D", "dorian"), othersUnchanged(ctx, [])],
    reference: [[call("set_scale", { tonic: "D", scale: "dorian" })]],
  },
  {
    id: "clear-lead",
    tier: "single",
    prompt: "Delete every note on the lead track but keep the track.",
    setup: bandSetup("bass"),
    grade: (ctx) => [
      check("lead kept", Boolean(trackById(ctx.score, "lead"))),
      check("lead empty", notesOf(ctx.score, "lead").length === 0),
      othersUnchanged(ctx, ["lead"]),
    ],
    reference: [[call("remove_notes", { trackId: "lead", all: true })]],
  },
  {
    id: "bass-velocity-half",
    tier: "single",
    prompt: "Set the velocity of every bass note to 0.5.",
    setup: bandSetup("bass"),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "bass");
      return [
        check("4 bass notes", notes.length === 4),
        check(
          "velocity 0.5",
          notes.every((note) => near(note.velocity, 0.5)),
          notes.map((note) => note.velocity).join(" "),
        ),
      ];
    },
    reference: [
      [
        call("update_notes", {
          updates: BASS_IDS.map(([noteId]) => ({ noteId, velocity: 0.5 })),
        }),
      ],
    ],
  },
  {
    id: "new-supersaw-pad",
    tier: "single",
    prompt: "Create a new track called pad using the supersaw instrument.",
    setup: bandSetup("keys"),
    grade: (ctx) => {
      const pad = newTracks(ctx).find((t) => /pad/i.test(t.id + t.name));
      return [
        check("pad track", Boolean(pad)),
        check("supersaw", pad?.instrument === "supersaw", pad?.instrument),
        othersUnchanged(ctx, []),
      ];
    },
    reference: [
      [
        call("create_track", {
          id: "pad",
          name: "pad",
          instrument: "supersaw",
        }),
      ],
    ],
  },
  {
    id: "lead-to-square",
    tier: "single",
    prompt: "Change the lead's instrument to a square wave.",
    setup: bandSetup("lead"),
    grade: (ctx) => [
      check(
        "square",
        trackById(ctx.score, "lead")?.instrument === "square",
        trackById(ctx.score, "lead")?.instrument,
      ),
      unchanged(ctx, "lead"),
    ],
    reference: [
      [call("set_instrument", { trackId: "lead", instrument: "square" })],
    ],
  },
  {
    id: "bass-lowpass-800",
    tier: "single",
    prompt: "Put a low-pass filter at 800 Hz on the bass.",
    setup: bandSetup("keys"),
    grade: (ctx) => {
      const filter = trackById(ctx.score, "bass")?.filter;
      return [
        check(
          "cutoff 800",
          near(filter?.cutoff, 800, 1) && (filter?.type ?? "lpf") === "lpf",
          JSON.stringify(filter ?? null),
        ),
      ];
    },
    reference: [
      [call("set_effects", { trackId: "bass", filter: { cutoff: 800 } })],
    ],
  },
  {
    id: "lead-dotted-eighth-delay",
    tier: "single",
    prompt: "Add a dotted-eighth delay to the lead.",
    setup: bandSetup("lead"),
    grade: (ctx) => {
      const delay = trackById(ctx.score, "lead")?.delay;
      return [
        check(
          "delay 0.75 beats",
          near(delay?.beats, 0.75),
          JSON.stringify(delay ?? null),
        ),
        check("delay audible", (delay?.mix ?? 0) > 0),
      ];
    },
    reference: [
      [
        call("set_effects", {
          trackId: "lead",
          delay: { beats: 0.75, feedback: 0.35, mix: 0.3 },
        }),
      ],
    ],
  },
  {
    id: "meter-three-four",
    tier: "single",
    prompt: "Change the time signature to 3/4.",
    setup: blank([KEYS], "keys"),
    grade: (ctx) => {
      const meter = meterOf(ctx.score);
      return [
        check(
          "3/4",
          meter.beats === 3 && meter.unit === 4,
          `${meter.beats}/${meter.unit}`,
        ),
      ];
    },
    reference: [[call("set_time", { action: "meter", meter: "3/4", bar: 1 })]],
  },
  {
    id: "move-bass-note",
    tier: "single",
    prompt:
      "Move the bass note that starts on beat 8 (the G) to start on beat 9 instead.",
    setup: bandSetup("bass"),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "bass");
      const g = notes.filter((note) => note.pitch === 43);
      return [
        check("one G", g.length === 1),
        check(
          "G at beat 9",
          g.length === 1 && round(beatOf(ctx.score, g[0]!)) === 9,
        ),
        check(
          "others kept",
          notes.filter((note) => note.pitch !== 43).length === 3,
        ),
      ];
    },
    reference: [
      [call("update_notes", { updates: [{ noteId: "b3", start: 9 }] })],
    ],
  },
  {
    id: "add-c-major-triad",
    tier: "single",
    prompt:
      "On the keys track, add a C major triad (C4 E4 G4) at beat 0 lasting 4 beats.",
    setup: blank([KEYS], "keys"),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "keys");
      return [
        check(
          "C4 E4 G4 at 0 for 4",
          notes.length === 3 &&
            [60, 64, 67].every((p) =>
              notes.some(
                (note) =>
                  note.pitch === p &&
                  note.startTick === 0 &&
                  round(lengthOf(ctx.score, note)) === 4,
              ),
            ),
          notes.map((note) => note.pitch).join(" "),
        ),
      ];
    },
    reference: [
      notesCall("keys", [
        ["C4", 0, 4],
        ["E4", 0, 4],
        ["G4", 0, 4],
      ]),
    ].map((c) => [c]),
  },
];

/** Walking bass in Bb over ii-V-I: quarter notes, chord roots on downbeats. */
const WALK: Array<[number, number, number]> = [
  // Cm7: C D Eb E(chromatic to F)
  [36, 0, 1],
  [38, 1, 1],
  [39, 2, 1],
  [40, 3, 1],
  // F7: F A C B(chromatic to Bb)
  [41, 4, 1],
  [45, 5, 1],
  [48, 6, 1],
  [47, 7, 1],
  // Bbmaj7: Bb D F A
  [46, 8, 1],
  [50, 9, 1],
  [53, 10, 1],
  [45, 11, 1],
  // Bbmaj7: Bb C D F
  [46, 12, 1],
  [48, 13, 1],
  [50, 14, 1],
  [53, 15, 1],
];

const compose: EvalTask[] = [
  {
    id: "ii-v-i-bb-walking",
    tier: "compose",
    prompt:
      "Write a ii-V-I in Bb major on the keys (one bar each, then hold the I for the last bar) with a walking bass on the bass track: quarter notes, chord root on each downbeat.",
    setup: blank([KEYS, BASS], "keys", { tempoBpm: 140, key: "Bb major" }),
    grade: (ctx) => {
      const bass = notesOf(ctx.score, "bass");
      const lows = lowestPerOnset(ctx.score, bass);
      const onsets = lows.map((note) => round(beatOf(ctx.score, note)));
      const roots = [pc("C"), pc("F"), pc("Bb"), pc("Bb")];
      const downbeats = roots.map((root, bar) =>
        lows.some(
          (note) =>
            round(beatOf(ctx.score, note)) === bar * 4 &&
            note.pitch % 12 === root,
        ),
      );
      return [
        barsHoldChords(
          ctx,
          ["keys"],
          ["Cm7", "F7", "Bbmaj7", "Bbmaj7"],
          "keys ii-V-I",
        ),
        check(
          "walking quarters",
          grid(16, 1).every((beat) => onsets.includes(beat)),
          onsets.join(" "),
        ),
        check(
          "roots on downbeats",
          downbeats.every(Boolean),
          downbeats.join(" "),
        ),
        check(
          "bass register",
          bass.every((note) => note.pitch < 60),
        ),
        check(
          "stepwise-ish walk",
          leaps(lows).every((leap) => leap <= 9),
          leaps(lows).join(" "),
        ),
      ];
    },
    reference: [
      [
        call("write_chords", {
          trackId: "keys",
          key: "Bb major",
          chords: ["ii7", "V7", "Imaj7", "Imaj7"],
        }),
        notesCall("bass", WALK),
      ],
    ],
  },
  {
    id: "son-clave-3-2",
    tier: "compose",
    prompt:
      "Program a 3-2 son clave on the drum track using the rim voice, repeating every two bars.",
    setup: blank([KIT], "drums", { tempoBpm: 100 }),
    grade: (ctx) => {
      const hits = drumHits(ctx.score, "rim");
      const fold = (period: number) =>
        [...new Set(hits.map((beat) => round(beat % period)))].sort(
          (a, b) => a - b,
        );
      const twoBar = fold(8);
      return [
        check(
          "3-2 son clave",
          // The prompt asks for a two-bar cycle, so a one-bar form fails.
          sameBeats(twoBar, [0, 1.5, 3, 5, 6]),
          twoBar.join(" "),
        ),
        check("covers the loop", hits.length >= 10, `${hits.length}`),
      ];
    },
    reference: [
      [
        call("set_rhythm", {
          rows: [{ voice: "rim", grid: "x.....x.....x.......x...x......." }],
        }),
      ],
    ],
  },
  {
    id: "rumba-clave-3-2",
    tier: "compose",
    prompt: "Program a 3-2 rumba clave with the rim voice on the drum track.",
    setup: blank([KIT], "drums", { tempoBpm: 110 }),
    grade: (ctx) => {
      const hits = drumHits(ctx.score, "rim");
      const fold = (period: number) =>
        [...new Set(hits.map((beat) => round(beat % period)))].sort(
          (a, b) => a - b,
        );
      // The span is unspecified: accept the two-bar quarter-pulse form or
      // the same clave compressed into one bar of sixteenths.
      const twoBar = fold(8);
      const oneBar = fold(4);
      return [
        check(
          "3-2 rumba clave",
          sameBeats(twoBar, [0, 1.5, 3.5, 5, 6]) ||
            sameBeats(oneBar, [0, 0.75, 1.75, 2.5, 3]),
          twoBar.join(" "),
        ),
        check("covers the loop", hits.length >= 10, `${hits.length}`),
      ];
    },
    reference: [
      [
        call("set_rhythm", {
          rows: [{ voice: "rim", grid: "x.....x.......x.....x...x......." }],
        }),
      ],
    ],
  },
  {
    id: "tresillo-bass",
    tier: "compose",
    prompt:
      "Write a tresillo (3+3+2) bass line on the bass track playing C2 in every bar.",
    setup: blank([BASS], "bass"),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "bass");
      const starts = notes.map((note) => round(beatOf(ctx.score, note)));
      return [
        check(
          "tresillo onsets",
          sameBeats([...new Set(starts)], everyBar(ctx.score, [0, 1.5, 3])),
          starts.join(" "),
        ),
        check(
          "C",
          notes.length > 0 && notes.every((note) => note.pitch % 12 === 0),
        ),
      ];
    },
    reference: [
      [
        notesCall(
          "bass",
          [0, 1, 2, 3].flatMap((bar) =>
            [
              [0, 1.5],
              [1.5, 1.5],
              [3, 1],
            ].map(
              ([at, len]) =>
                ["C2", bar * 4 + at!, len!] as [string, number, number],
            ),
          ),
        ),
      ],
    ],
  },
  {
    id: "trance-build-8-bars",
    tier: "compose",
    prompt:
      "Make an 8-bar trance build at 138 BPM: a four-on-the-floor kick through all 8 bars and a low-pass filter automation ramp on the pad that rises from under 1 kHz to over 5 kHz across the 8 bars.",
    setup: blank(
      [KIT, { id: "pad", name: "pad", instrument: "supersaw" }],
      "pad",
      { tempoBpm: 120, bars: 4, key: "A minor" },
    ),
    grade: (ctx) => {
      const pad = trackById(ctx.score, "pad");
      const ramp = pad ? filterRamp(ctx.score, pad) : [];
      const values = ramp.map(([, value]) => value);
      return [
        tempoIs(ctx, 138),
        check("8 bars", ctx.score.bars >= 8, `${ctx.score.bars}`),
        hitsInclude(ctx, "kick", grid(32, 1), "kick every beat of 8 bars"),
        check(
          "ramp starts low",
          values.length >= 2 && values[0]! <= 1000,
          values.join(" "),
        ),
        check("ramp ends high", values.length >= 2 && values.at(-1)! >= 5000),
        check(
          "ramp rises",
          values.every((v, i) => i === 0 || v >= values[i - 1]!),
        ),
        check(
          "ramp spans the build",
          ramp.length >= 2 && ramp.at(-1)![0] >= 24 && ramp[0]![0] <= 4,
        ),
      ];
    },
    reference: [
      [call("set_tempo", { bpm: 138 }), call("extend_loop", { bars: 8 })],
      [
        call("set_rhythm", {
          trackId: "drums",
          rows: [{ voice: "kick", pulses: 4, steps: 16 }],
        }),
        call("set_automation", {
          trackId: "pad",
          parameter: "filter",
          points: [
            { beat: 0, value: 400 },
            { beat: 31, value: 8000 },
          ],
        }),
      ],
    ],
  },
  {
    id: "pop-i-v-vi-iv-g",
    tier: "compose",
    prompt:
      "Write a I-V-vi-IV progression in G major on the keys, one chord per bar.",
    setup: blank([KEYS], "keys", { key: "G major" }),
    grade: (ctx) => [
      barsHoldChords(ctx, ["keys"], ["G", "D", "Em", "C"], "G D Em C"),
      check(
        "in key",
        inScale(notesOf(ctx.score, "keys"), scale("G", MAJOR)) === 1,
      ),
    ],
    reference: [
      [
        call("write_chords", {
          trackId: "keys",
          key: "G major",
          chords: ["I", "V", "vi", "IV"],
        }),
      ],
    ],
  },
  {
    id: "twelve-bar-blues-a",
    tier: "compose",
    prompt:
      "Write a 12-bar blues in A with dominant seventh chords on the keys (one chord per bar, quick-change not used, turnaround on the V in bar 12).",
    setup: blank([KEYS], "keys", { bars: 4, key: "A major" }),
    grade: (ctx) => [
      check("12 bars", ctx.score.bars >= 12, `${ctx.score.bars}`),
      barsHoldChords(
        ctx,
        ["keys"],
        [
          "A7",
          "A7",
          "A7",
          "A7",
          "D7",
          "D7",
          "A7",
          "A7",
          "E7",
          "D7",
          "A7",
          "E7",
        ],
        "12-bar form",
      ),
    ],
    reference: [
      [call("extend_loop", { bars: 12 })],
      [
        call("write_chords", {
          trackId: "keys",
          chords: [
            "A7",
            "A7",
            "A7",
            "A7",
            "D7",
            "D7",
            "A7",
            "A7",
            "E7",
            "D7",
            "A7",
            "E7",
          ],
        }),
      ],
    ],
  },
  {
    id: "e-minor-pentatonic-line",
    tier: "compose",
    prompt:
      "Write a monophonic lead line of at least 12 notes in E minor pentatonic on the lead track, spanning the 4 bars, with no leap larger than an octave.",
    setup: blank([LEAD], "lead", { key: "E minor" }),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "lead");
      const last = notes.length ? beatOf(ctx.score, notes.at(-1)!) : 0;
      return [
        check("12+ notes", notes.length >= 12, `${notes.length}`),
        check(
          "E minor pentatonic",
          inScale(notes, scale("E", MINOR_PENTATONIC)) === 1,
        ),
        monophonic(ctx, "lead"),
        check("spans 4 bars", last >= 12, `${last}`),
        check(
          "no leap over an octave",
          leaps(notes).every((leap) => leap <= 12),
        ),
      ];
    },
    reference: [
      [
        notesCall(
          "lead",
          [
            "E4",
            "G4",
            "A4",
            "B4",
            "D5",
            "B4",
            "A4",
            "G4",
            "E4",
            "D4",
            "E4",
            "G4",
            "A4",
            "G4",
            "E4",
            "E4",
          ].map((pitch, i) => [pitch, i, 1] as [string, number, number]),
        ),
      ],
    ],
  },
  {
    id: "roots-under-chords",
    tier: "compose",
    prompt:
      "The keys play Am F C G, one chord per bar. Write a bass line on the bass track that plays each chord's root on beat 1 of its bar, below C3.",
    setup: () => ({
      score: createScore({
        tempoBpm: 96,
        bars: 4,
        key: "A minor",
        tracks: [KEYS, BASS],
        notes: [
          [57, 60, 64],
          [53, 57, 60],
          [55, 60, 64],
          [55, 59, 62],
        ].flatMap((chord, bar) =>
          chord.map((pitch, i) =>
            n(`ch${bar}${i}`, "keys", bar * 4, 4, pitch, 0.6),
          ),
        ),
      }),
      focus: "bass",
    }),
    grade: (ctx) => {
      const lows = lowestPerOnset(ctx.score, notesOf(ctx.score, "bass"));
      const roots = ["A", "F", "C", "G"].map(pc);
      const ok = roots.map((root, bar) =>
        lows.some(
          (note) =>
            round(beatOf(ctx.score, note)) === bar * 4 &&
            note.pitch % 12 === root &&
            note.pitch < 48,
        ),
      );
      return [
        check("roots on beat 1", ok.every(Boolean), ok.join(" ")),
        unchanged(ctx, "keys"),
      ];
    },
    reference: [
      notesCall("bass", [
        ["A1", 0, 4],
        ["F1", 4, 4],
        ["C2", 8, 4],
        ["G1", 12, 4],
      ]),
    ].map((c) => [c]),
  },
  {
    id: "boom-bap-90",
    tier: "compose",
    prompt:
      "Program a boom bap beat at 90 BPM: kick on beat 1 and the 'and' of 3, snare on 2 and 4, closed hats on eighths.",
    setup: blank([KIT], "drums"),
    grade: (ctx) => [
      tempoIs(ctx, 90),
      hitsAre(ctx, "kick", everyBar(ctx.score, [0, 2.5])),
      hitsAre(ctx, "snare", everyBar(ctx.score, [1, 3])),
      hitsAre(ctx, "hat", grid(loopBeats(ctx.score), 0.5)),
    ],
    reference: [
      [
        call("set_tempo", { bpm: 90 }),
        call("set_rhythm", {
          rows: [
            gridRow("kick", [0, 2.5]),
            gridRow("snare", [1, 3]),
            { voice: "hat", pulses: 8, steps: 16 },
          ],
        }),
      ],
    ],
  },
  {
    id: "trap-half-time",
    tier: "compose",
    prompt:
      "Make a trap beat at 140 BPM: half-time snare on beat 3 of each bar, 16th-note closed hats throughout, and a kick on beat 1 of each bar.",
    setup: blank([KIT], "drums"),
    grade: (ctx) => [
      tempoIs(ctx, 140),
      hitsAre(ctx, "snare", everyBar(ctx.score, [2])),
      hitsInclude(ctx, "hat", grid(loopBeats(ctx.score), 0.25), "16th hats"),
      hitsInclude(ctx, "kick", everyBar(ctx.score, [0])),
    ],
    reference: [
      [
        call("set_tempo", { bpm: 140 }),
        call("set_rhythm", {
          rows: [
            gridRow("kick", [0]),
            gridRow("snare", [2]),
            { voice: "hat", pulses: 16, steps: 16 },
          ],
        }),
      ],
    ],
  },
  {
    id: "dembow",
    tier: "compose",
    prompt:
      "Program a dembow groove: kick on every beat, snare on the last sixteenth of beat 1, the 'and' of 2, the last sixteenth of beat 3 and the 'and' of 4.",
    setup: blank([KIT], "drums", { tempoBpm: 95 }),
    grade: (ctx) => [
      hitsAre(ctx, "kick", grid(loopBeats(ctx.score), 1)),
      hitsAre(ctx, "snare", everyBar(ctx.score, [0.75, 1.5, 2.75, 3.5])),
    ],
    reference: [
      [
        call("set_rhythm", {
          rows: [
            { voice: "kick", pulses: 4, steps: 16 },
            gridRow("snare", [0.75, 1.5, 2.75, 3.5]),
          ],
        }),
      ],
    ],
  },
  {
    id: "am-arpeggio-16ths",
    tier: "compose",
    prompt:
      "Arpeggiate an A minor chord in sixteenth notes across bar 1 on the keys track (16 notes, chord tones only).",
    setup: blank([KEYS], "keys", { key: "A minor" }),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "keys");
      const starts = notes.map((note) => round(beatOf(ctx.score, note)));
      const pcs = new Set(chordTones("Am"));
      return [
        check(
          "16 sixteenths in bar 1",
          sameBeats([...new Set(starts)], grid(4, 0.25)),
          starts.join(" "),
        ),
        check(
          "chord tones",
          notes.every((note) => pcs.has(note.pitch % 12)),
        ),
        check(
          "uses all three tones",
          chordTones("Am").every((t) =>
            notes.some((note) => note.pitch % 12 === t),
          ),
        ),
      ];
    },
    reference: [
      [
        notesCall(
          "keys",
          Array.from(
            { length: 16 },
            (_, i) =>
              [[57, 60, 64, 69][i % 4]!, i * 0.25, 0.25] as [
                number,
                number,
                number,
              ],
          ),
        ),
      ],
    ],
  },
  {
    id: "harmony-in-thirds",
    tier: "compose",
    prompt:
      "Create a track called harmony (any melodic instrument) that doubles the lead a diatonic third above in C major, same rhythm.",
    setup: bandSetup("lead"),
    grade: (ctx) => {
      const lead = notesOf(ctx.score, "lead");
      const harmony = findTrack(ctx, /harmony/i);
      const notes = harmony ? notesOf(ctx.score, harmony.id) : [];
      const major = scale("C", MAJOR);
      const ok =
        notes.length === lead.length &&
        lead.every((note) =>
          notes.some(
            (h) =>
              h.startTick === note.startTick &&
              h.durationTicks === note.durationTicks &&
              [3, 4].includes(h.pitch - note.pitch) &&
              major.has(h.pitch % 12),
          ),
        );
      return [
        check("harmony track", Boolean(harmony)),
        check("diatonic thirds above", ok),
        unchanged(ctx, "lead"),
      ];
    },
    reference: [
      [
        call("create_track", {
          id: "harmony",
          name: "harmony",
          instrument: "triangle",
        }),
      ],
      [
        notesCall("harmony", [
          [76, 0, 1],
          [77, 1, 1],
          [79, 2, 1],
          [77, 3, 1],
          [76, 4, 2],
          [71, 6, 2],
        ]),
      ],
    ],
  },
  {
    id: "andalusian-cadence",
    tier: "compose",
    prompt:
      "Write an Andalusian cadence in A minor on the keys (Am G F E), one chord per bar.",
    setup: blank([KEYS], "keys", { key: "A minor" }),
    grade: (ctx) => [
      barsHoldChords(ctx, ["keys"], ["Am", "G", "F", "E"], "Am G F E"),
      check(
        "E chord has G#",
        pitchClassesIn(ctx.score, ctx.score.tracks, 12, 16).has(pc("G#")),
      ),
    ],
    reference: [
      [
        call("write_chords", {
          trackId: "keys",
          chords: ["Am", "G", "F", "E"],
        }),
      ],
    ],
  },
  {
    id: "waltz-oom-pah-pah",
    tier: "compose",
    prompt:
      "Make a waltz in 3/4: on the bass track play C2 on beat 1 of every bar, and on the keys play a C major triad on beats 2 and 3 of every bar.",
    setup: blank([BASS, KEYS], "keys"),
    grade: (ctx) => {
      const bass = notesOf(ctx.score, "bass").map((note) =>
        round(beatOf(ctx.score, note)),
      );
      const keys = notesOf(ctx.score, "keys").map((note) =>
        round(beatOf(ctx.score, note)),
      );
      return [
        check("3/4", meterOf(ctx.score).beats === 3),
        check(
          "bass on 1",
          bass.length >= 4 && sameBeats(offsetsInBars(ctx.score, bass), [0]),
          bass.join(" "),
        ),
        check(
          "keys on 2 and 3",
          keys.length >= 8 && sameBeats(offsetsInBars(ctx.score, keys), [1, 2]),
          keys.join(" "),
        ),
        check(
          "triads",
          inScale(notesOf(ctx.score, "keys"), new Set(chordTones("C"))) === 1,
        ),
        check("every bar", bass.length >= ctx.score.bars),
      ];
    },
    reference: [
      [call("set_time", { action: "meter", meter: "3/4", bar: 1 })],
      [
        notesCall(
          "bass",
          [0, 1, 2, 3].map(
            (bar) => ["C2", bar * 3, 1] as [string, number, number],
          ),
        ),
        notesCall(
          "keys",
          [0, 1, 2, 3].flatMap((bar) =>
            [1, 2].flatMap((beat) =>
              ["C4", "E4", "G4"].map(
                (p) => [p, bar * 3 + beat, 1] as [string, number, number],
              ),
            ),
          ),
        ),
      ],
    ],
  },
  {
    id: "house-bass-offbeats",
    tier: "compose",
    prompt:
      "Write a bass line on the bass track that plays A1 on the offbeat ('and') of every beat, eighth notes long.",
    setup: blank([BASS], "bass", { key: "A minor", tempoBpm: 124 }),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "bass");
      return [
        check(
          "offbeats",
          sameBeats(
            notes.map((note) => round(beatOf(ctx.score, note))),
            grid(16, 1, 0.5),
          ),
        ),
        check(
          "A1",
          notes.every((note) => note.pitch === 33),
        ),
        check(
          "eighths",
          notes.every((note) => round(lengthOf(ctx.score, note)) === 0.5),
        ),
      ];
    },
    reference: [
      [
        notesCall(
          "bass",
          grid(16, 1, 0.5).map(
            (beat) => ["A1", beat, 0.5] as [string, number, number],
          ),
        ),
      ],
    ],
  },
];

const files: EvalTask[] = [
  {
    id: "files-tempo",
    tier: "files",
    prompt:
      "Edit song.ts directly (with the file tools) to change the tempo to 110.",
    setup: bandSetup("lead"),
    grade: (ctx) => [
      ...fileTask(ctx),
      tempoIs(ctx, 110),
      othersUnchanged(ctx, []),
    ],
    reference: [
      [
        call("edit_file", {
          path: "song.ts",
          old: "tempo: 100,",
          new: "tempo: 110,",
        }),
      ],
    ],
  },
  {
    id: "files-key",
    tier: "files",
    prompt: "Using the file tools, edit song.ts so the key is A minor.",
    setup: bandSetup("keys"),
    grade: (ctx) => [...fileTask(ctx), keyIs(ctx, "A", "minor")],
    reference: [
      [
        call("edit_file", {
          path: "song.ts",
          old: 'key: "C major",',
          new: 'key: "A minor",',
        }),
      ],
    ],
  },
  {
    id: "files-bars",
    tier: "files",
    prompt: "Edit song.ts with the file tools to make the song 8 bars long.",
    setup: bandSetup("keys"),
    grade: (ctx) => [
      ...fileTask(ctx),
      check("8 bars", ctx.score.bars === 8),
      othersUnchanged(ctx, []),
    ],
    reference: [
      [
        call("edit_file", {
          path: "song.ts",
          old: "bars: 4,",
          new: "bars: 8,",
        }),
      ],
    ],
  },
  {
    id: "files-meter",
    tier: "files",
    prompt: "Edit song.ts with the file tools to change the meter to 6/8.",
    setup: blank([KEYS], "keys"),
    grade: (ctx) => {
      const meter = meterOf(ctx.score);
      return [
        ...fileTask(ctx),
        check(
          "6/8",
          meter.beats === 6 && meter.unit === 8,
          `${meter.beats}/${meter.unit}`,
        ),
      ];
    },
    reference: [
      [
        call("edit_file", {
          path: "song.ts",
          old: "meter: [4, 4],",
          new: "meter: [6, 8],",
        }),
      ],
    ],
  },
  {
    id: "files-instrument",
    tier: "files",
    prompt:
      "Edit tracks/bass/track.ts with the file tools so the bass uses the pluck instrument.",
    setup: bandSetup("bass"),
    grade: (ctx) => [
      ...fileTask(ctx),
      check("pluck", trackById(ctx.score, "bass")?.instrument === "pluck"),
      unchanged(ctx, "bass"),
    ],
    reference: [
      [
        call("edit_file", {
          path: "tracks/bass/track.ts",
          old: 'instrument: "bass",',
          new: 'instrument: "pluck",',
        }),
      ],
    ],
  },
  {
    id: "files-volume",
    tier: "files",
    prompt:
      "Edit tracks/keys/track.ts with the file tools to set the keys volume to 0.7.",
    setup: bandSetup("keys"),
    grade: (ctx) => [
      ...fileTask(ctx),
      check("volume 0.7", near(trackById(ctx.score, "keys")?.volume, 0.7)),
      unchanged(ctx, "keys"),
    ],
    reference: [
      [
        call("edit_file", {
          path: "tracks/keys/track.ts",
          old: 'instrument: "piano",',
          new: 'instrument: "piano",\n  volume: 0.7,',
        }),
      ],
    ],
  },
  {
    id: "files-add-note",
    tier: "files",
    prompt:
      "Edit tracks/bass/track.ts with the file tools to add an E2 note at beat 6 lasting 2 beats.",
    setup: bandSetup("bass"),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "bass");
      return [
        ...fileTask(ctx),
        check("5 notes", notes.length === 5),
        check(
          "E2 at 6 for 2",
          notes.some(
            (note) =>
              note.pitch === 40 &&
              round(beatOf(ctx.score, note)) === 6 &&
              round(lengthOf(ctx.score, note)) === 2,
          ),
        ),
      ];
    },
    reference: [
      [call("read_file", { path: "tracks/bass/track.ts" })],
      [
        call("edit_file", {
          path: "tracks/bass/track.ts",
          old: 'note("G2", 8, 2)',
          new: 'note("E2", 6, 2), note("G2", 8, 2)',
        }),
      ],
    ],
  },
  {
    id: "files-rewrite-scale",
    tier: "files",
    prompt:
      "Rewrite tracks/lead/track.ts with the file tools so the lead plays an ascending C major scale from C4 to C5 in eighth notes from beat 0, replacing its notes.",
    setup: bandSetup("lead"),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "lead");
      return [
        ...fileTask(ctx),
        check(
          "C major scale in eighths",
          notes.length === 8 &&
            notes.every(
              (note, i) =>
                note.pitch === [60, 62, 64, 65, 67, 69, 71, 72][i] &&
                round(beatOf(ctx.score, note)) === i * 0.5,
            ),
          notes.map((note) => note.pitch).join(" "),
        ),
      ];
    },
    reference: [
      [
        call("write_file", {
          path: "tracks/lead/track.ts",
          content: `import { track, note } from "dawg";\n\nexport default track({\n  id: "lead",\n  name: "lead",\n  instrument: "saw",\n  notes: [${["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"].map((p, i) => `note("${p}", ${i * 0.5}, 0.5)`).join(", ")}],\n});\n`,
        }),
      ],
    ],
  },
  {
    id: "files-velocity",
    tier: "files",
    prompt:
      "Edit tracks/bass/track.ts with the file tools so the first bass note (C2 at beat 0) has velocity 0.3.",
    setup: bandSetup("bass"),
    grade: (ctx) => {
      const first = notesOf(ctx.score, "bass")[0];
      return [
        ...fileTask(ctx),
        check(
          "velocity 0.3",
          Boolean(first) &&
            first!.pitch === 36 &&
            first!.startTick === 0 &&
            near(first!.velocity, 0.3),
        ),
        check("4 notes", notesOf(ctx.score, "bass").length === 4),
      ];
    },
    reference: [
      [call("read_file", { path: "tracks/bass/track.ts" })],
      [
        call("edit_file", {
          path: "tracks/bass/track.ts",
          old: 'note("C2", 0, 2)',
          new: 'note("C2", 0, 2, 0.3)',
        }),
      ],
    ],
  },
  {
    id: "files-transpose-track",
    tier: "files",
    prompt:
      "Edit tracks/bass/track.ts with the file tools to transpose every bass note up an octave.",
    setup: bandSetup("bass"),
    grade: (ctx) => [...fileTask(ctx), shapeShift(ctx, "bass", 12)],
    reference: [
      [call("read_file", { path: "tracks/bass/track.ts" })],
      [
        call("write_file", {
          path: "tracks/bass/track.ts",
          content:
            'import { track, note } from "dawg";\n\nexport default track({\n  id: "bass",\n  name: "bass",\n  instrument: "bass",\n  notes: [note("C3", 0, 2), note("F3", 4, 2), note("G3", 8, 2), note("C3", 12, 2)],\n});\n',
        }),
      ],
    ],
  },
];

const multi: EvalTask[] = [
  {
    id: "house-groove",
    tier: "multi",
    prompt:
      "Build a house groove at 124 BPM: four-on-the-floor kick, clap on 2 and 4, open hats on the offbeats, and on the bass track A1 eighth notes on every offbeat.",
    setup: blank([KIT, BASS], "drums", { key: "A minor" }),
    grade: (ctx) => {
      const bass = notesOf(ctx.score, "bass");
      return [
        tempoIs(ctx, 124),
        hitsAre(ctx, "kick", grid(16, 1)),
        hitsAre(ctx, "clap", everyBar(ctx.score, [1, 3])),
        hitsAre(ctx, "openhat", grid(16, 1, 0.5)),
        check(
          "bass offbeats",
          sameBeats(
            bass.map((note) => round(beatOf(ctx.score, note))),
            grid(16, 1, 0.5),
          ),
        ),
        check(
          "bass A",
          bass.length > 0 && bass.every((note) => note.pitch % 12 === 9),
        ),
      ];
    },
    reference: [
      [
        call("set_tempo", { bpm: 124 }),
        call("set_rhythm", {
          trackId: "drums",
          rows: [
            { voice: "kick", pulses: 4, steps: 16 },
            gridRow("clap", [1, 3]),
            gridRow("openhat", [0.5, 1.5, 2.5, 3.5]),
          ],
        }),
        notesCall(
          "bass",
          grid(16, 1, 0.5).map(
            (beat) => ["A1", beat, 0.5] as [string, number, number],
          ),
        ),
      ],
    ],
  },
  {
    id: "repeat-lead-octave-up",
    tier: "multi",
    prompt:
      "Extend the loop to 8 bars and repeat the lead's first 4 bars in bars 5-8 an octave higher. Leave bars 1-4 as they are.",
    setup: bandSetup("lead"),
    grade: (ctx) => {
      const before = notesOf(ctx.initial, "lead");
      const after = notesOf(ctx.score, "lead");
      const copy = before.every((note) =>
        after.some(
          (n2) =>
            n2.startTick === note.startTick + 16 * ctx.score.ticksPerBeat &&
            n2.pitch === note.pitch + 12 &&
            n2.durationTicks === note.durationTicks,
        ),
      );
      const kept = before.every((note) =>
        after.some(
          (n2) => n2.startTick === note.startTick && n2.pitch === note.pitch,
        ),
      );
      return [
        check("8 bars", ctx.score.bars === 8),
        check("copy up an octave in bar 5", copy),
        check("original kept", kept),
        check(
          "nothing extra",
          after.length === before.length * 2,
          `${after.length}`,
        ),
      ];
    },
    reference: [
      [call("extend_loop", { bars: 8 })],
      [
        notesCall(
          "lead",
          LEAD_IDS.map(([, pitch], i) => {
            const starts = [0, 1, 2, 3, 4, 6];
            const lens = [1, 1, 1, 1, 2, 2];
            return [pitch + 12, starts[i]! + 16, lens[i]!] as [
              number,
              number,
              number,
            ];
          }),
        ),
      ],
    ],
  },
  {
    id: "jazz-pad-and-bass",
    tier: "multi",
    prompt:
      "Create a pad track and a bass track. On the pad write Dm7 G7 Cmaj7 Cmaj7, one chord per bar; on the bass play each chord's root as a whole note below C3.",
    setup: blank([KEYS], "keys", { key: "C major", tempoBpm: 110 }),
    grade: (ctx) => {
      const pad = findTrack(ctx, /pad/i);
      const bass = findTrack(ctx, /bass/i);
      const lows = bass
        ? lowestPerOnset(ctx.score, notesOf(ctx.score, bass.id))
        : [];
      const roots = ["D", "G", "C", "C"].map(pc);
      const rootsOk = roots.every((root, bar) =>
        lows.some(
          (note) =>
            round(beatOf(ctx.score, note)) === bar * 4 &&
            note.pitch % 12 === root &&
            note.pitch < 48,
        ),
      );
      return [
        check("pad", Boolean(pad)),
        check("bass", Boolean(bass)),
        pad
          ? barsHoldChords(
              ctx,
              [pad.id],
              ["Dm7", "G7", "Cmaj7", "Cmaj7"],
              "pad ii-V-I",
            )
          : check("pad ii-V-I", false),
        check("bass roots", rootsOk),
      ];
    },
    reference: [
      [
        call("create_track", {
          id: "pad",
          name: "pad",
          instrument: "supersaw",
        }),
        call("create_track", { id: "bass", name: "bass", instrument: "bass" }),
      ],
      [
        call("write_chords", {
          trackId: "pad",
          chords: ["Dm7", "G7", "Cmaj7", "Cmaj7"],
        }),
        notesCall("bass", [
          ["D2", 0, 4],
          ["G1", 4, 4],
          ["C2", 8, 4],
          ["C2", 12, 4],
        ]),
      ],
    ],
  },
  {
    id: "mix-pass",
    tier: "multi",
    prompt:
      "Mix pass: reverb mix 0.3 on the keys, a 600 Hz low-pass on the bass, and a half-beat delay with 0.4 feedback on the lead.",
    setup: bandSetup("keys"),
    grade: (ctx) => [
      check(
        "keys reverb",
        near(trackById(ctx.score, "keys")?.reverb?.mix, 0.3),
      ),
      check(
        "bass 600 Hz",
        near(trackById(ctx.score, "bass")?.filter?.cutoff, 600, 1),
      ),
      check(
        "lead delay",
        near(trackById(ctx.score, "lead")?.delay?.beats, 0.5) &&
          near(trackById(ctx.score, "lead")?.delay?.feedback, 0.4),
      ),
      othersUnchanged(ctx, []),
    ],
    reference: [
      [
        call("set_effects", { trackId: "keys", reverb: { mix: 0.3 } }),
        call("set_effects", { trackId: "bass", filter: { cutoff: 600 } }),
        call("set_effects", {
          trackId: "lead",
          delay: { beats: 0.5, feedback: 0.4 },
        }),
      ],
    ],
  },
  {
    id: "ballad-setup",
    tier: "multi",
    prompt:
      "Set the tempo to 75 BPM, the key to F major, and write I-vi-IV-V on the keys, one chord per bar.",
    setup: blank([KEYS], "keys"),
    grade: (ctx) => [
      tempoIs(ctx, 75),
      keyIs(ctx, "F", "major"),
      barsHoldChords(ctx, ["keys"], ["F", "Dm", "Bb", "C"], "F Dm Bb C"),
    ],
    reference: [
      [
        call("set_tempo", { bpm: 75 }),
        call("set_scale", { tonic: "F", scale: "major" }),
      ],
      [
        call("write_chords", {
          trackId: "keys",
          key: "F major",
          chords: ["I", "vi", "IV", "V"],
        }),
      ],
    ],
  },
  {
    id: "kick-with-snare-roll",
    tier: "multi",
    prompt:
      "Four-on-the-floor kick through the loop, plus a snare roll of sixteenth notes over the last beat of bar 4 (four snare hits).",
    setup: blank([KIT], "drums", { tempoBpm: 126 }),
    grade: (ctx) => {
      const snares = drumHits(ctx.score, "snare");
      return [
        hitsInclude(ctx, "kick", grid(16, 1)),
        check(
          "roll on beat 16",
          sameBeats(
            snares.filter((beat) => beat >= 15),
            [15, 15.25, 15.5, 15.75],
          ),
          snares.join(" "),
        ),
      ];
    },
    reference: [
      [
        call("set_rhythm", { rows: [{ voice: "kick", pulses: 4, steps: 16 }] }),
        call("add_drums", {
          hits: [15, 15.25, 15.5, 15.75].map((beat) => ({
            voice: "snare",
            beat,
          })),
        }),
      ],
    ],
  },
  {
    id: "drop-bass-and-mute",
    tier: "multi",
    prompt:
      "Mute the keys, solo-free: set the lead volume to 0.8, and pan the lead 0.2 right.",
    setup: bandSetup("lead"),
    grade: (ctx) => [
      check("keys muted", trackById(ctx.score, "keys")?.muted === true),
      check("lead volume", near(trackById(ctx.score, "lead")?.volume, 0.8)),
      check("lead pan", near(trackById(ctx.score, "lead")?.pan, 0.2)),
    ],
    reference: [
      [
        call("set_mix", { trackId: "keys", muted: true }),
        call("set_mix", { trackId: "lead", volume: 0.8, pan: 0.2 }),
      ],
    ],
  },
  {
    id: "dorian-vamp",
    tier: "multi",
    prompt:
      "Set the key to D dorian and write a two-chord vamp on the keys alternating Dm7 and G7 every bar for 4 bars.",
    setup: blank([KEYS], "keys"),
    grade: (ctx) => [
      keyIs(ctx, "D", "dorian"),
      barsHoldChords(ctx, ["keys"], ["Dm7", "G7", "Dm7", "G7"], "Dm7 G7 vamp"),
    ],
    reference: [
      [call("set_scale", { tonic: "D", scale: "dorian" })],
      [
        call("write_chords", {
          trackId: "keys",
          chords: ["Dm7", "G7", "Dm7", "G7"],
        }),
      ],
    ],
  },
];

const recovery: EvalTask[] = [
  {
    id: "note-past-loop",
    tier: "recovery",
    prompt: "Add a C5 quarter note on the lead at beat 20.",
    setup: bandSetup("lead"),
    grade: (ctx) => [
      check(
        "C5 at 20",
        notesOf(ctx.score, "lead").some(
          (note) => note.pitch === 72 && round(beatOf(ctx.score, note)) === 20,
        ),
      ),
      check(
        "loop covers it",
        loopBeats(ctx.score) > 20,
        `${ctx.score.bars} bars`,
      ),
    ],
    reference: [
      [call("extend_loop", { bars: 6 })],
      [notesCall("lead", [["C5", 20, 1]])],
    ],
  },
  {
    id: "track-by-name",
    tier: "recovery",
    prompt: "Transpose the piano up a perfect fifth.",
    setup: () => ({
      score: createScore({
        tempoBpm: 100,
        key: "C major",
        tracks: [
          { id: "t2", name: "Grand Piano", instrument: "piano" },
          { id: "t1", name: "Sub", instrument: "bass" },
        ],
        notes: [
          n("p1", "t2", 0, 2, 60),
          n("p2", "t2", 2, 2, 64),
          n("s1", "t1", 0, 4, 36),
        ],
      }),
      focus: "t1",
    }),
    grade: (ctx) => [shapeShift(ctx, "t2", 7), unchanged(ctx, "t1")],
    reference: [
      [
        call("update_notes", {
          updates: [
            { noteId: "p1", pitch: 67 },
            { noteId: "p2", pitch: 71 },
          ],
        }),
      ],
    ],
  },
  {
    id: "tempo-out-of-range",
    tier: "recovery",
    prompt:
      "Set the tempo to 400 BPM, or as fast as dawg allows if that is too fast.",
    setup: bandSetup("lead"),
    grade: (ctx) => [tempoIs(ctx, 300)],
    reference: [
      [call("set_tempo", { bpm: 400 })],
      [call("set_tempo", { bpm: 300 })],
    ],
  },
  {
    id: "remove-wrong-notes",
    tier: "recovery",
    prompt:
      "Remove the notes on the lead that are out of the C major key; keep the rest exactly as they are.",
    setup: () => ({
      score: band({
        notes: [
          n("m1", "lead", 0, 1, 72),
          n("m2", "lead", 1, 1, 73),
          n("m3", "lead", 2, 1, 76),
          n("m4", "lead", 3, 1, 78),
          n("m5", "lead", 4, 1, 79),
          n("m6", "lead", 5, 1, 70),
        ],
      }),
      focus: "lead",
    }),
    grade: (ctx) => [
      check(
        "only in-key notes remain",
        shape(ctx.score, "lead") ===
          notesOf(ctx.initial, "lead")
            .filter((note) => [72, 76, 79].includes(note.pitch))
            .map(
              (note) =>
                `${note.pitch}@${note.startTick}+${note.durationTicks}v${round(note.velocity)}`,
            )
            .join(" "),
        shape(ctx.score, "lead"),
      ),
    ],
    reference: [
      [call("remove_notes", { trackId: "lead", noteIds: ["m2", "m4", "m6"] })],
    ],
  },
  {
    id: "fix-overlaps",
    tier: "recovery",
    prompt:
      "Make the lead monophonic: shorten any note that overlaps the next one so it ends where the next starts. Don't move any starts.",
    setup: () => ({
      score: band({
        notes: [
          n("m1", "lead", 0, 2, 72),
          n("m2", "lead", 1, 1, 74),
          n("m3", "lead", 2, 3, 76),
          n("m4", "lead", 4, 1, 77),
        ],
      }),
      focus: "lead",
    }),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "lead");
      const starts = notes.map((note) => round(beatOf(ctx.score, note)));
      const lens = notes.map((note) => round(lengthOf(ctx.score, note)));
      return [
        monophonic(ctx, "lead"),
        check("starts kept", sameBeats(starts, [0, 1, 2, 4])),
        check(
          "trimmed to the next start",
          lens.join(" ") === "1 1 2 1",
          lens.join(" "),
        ),
      ];
    },
    reference: [
      [
        call("update_notes", {
          updates: [
            { noteId: "m1", duration: 1 },
            { noteId: "m3", duration: 2 },
          ],
        }),
      ],
    ],
  },
  {
    id: "quiet-hats-only",
    tier: "recovery",
    prompt:
      "The hi-hats are too loud: set every hat to velocity 0.4 and leave the kick and snare alone.",
    setup: () => ({
      score: createScore({
        tempoBpm: 120,
        tracks: [KIT],
        notes: [
          ...grid(4, 0.5).map((beat, i) =>
            n(`h${i}`, "drums", beat, 0.25, 42, 1),
          ),
          n("k1", "drums", 0, 0.25, 36, 0.9),
          n("k2", "drums", 2, 0.25, 36, 0.9),
          n("s1", "drums", 1, 0.25, 38, 0.85),
          n("s2", "drums", 3, 0.25, 38, 0.85),
        ],
      }),
      focus: "drums",
    }),
    grade: (ctx) => {
      const notes = notesOf(ctx.score, "drums");
      const hats = notes.filter((note) => note.pitch === 42);
      const others = notes.filter((note) => note.pitch !== 42);
      return [
        check(
          "8 hats at 0.4",
          hats.length === 8 && hats.every((note) => near(note.velocity, 0.4)),
        ),
        check(
          "kick and snare kept",
          others.length === 4 &&
            others.every((note) =>
              near(note.velocity, note.pitch === 36 ? 0.9 : 0.85),
            ),
        ),
      ];
    },
    reference: [
      [
        call("update_notes", {
          updates: Array.from({ length: 8 }, (_, i) => ({
            noteId: `h${i}`,
            velocity: 0.4,
          })),
        }),
      ],
    ],
  },
  {
    id: "bad-file-edit-recover",
    tier: "recovery",
    prompt:
      "With the file tools, change the lead's instrument in tracks/lead/track.ts to triangle. Read the file first if you are not sure of its exact text.",
    setup: bandSetup("lead"),
    grade: (ctx) => [
      ...fileTask(ctx),
      check(
        "triangle",
        trackById(ctx.score, "lead")?.instrument === "triangle",
      ),
      unchanged(ctx, "lead"),
    ],
    reference: [
      [
        call("edit_file", {
          path: "tracks/lead/track.ts",
          old: "instrument: 'saw'",
          new: "instrument: 'triangle'",
        }),
      ],
      [
        call("edit_file", {
          path: "tracks/lead/track.ts",
          old: 'instrument: "saw",',
          new: 'instrument: "triangle",',
        }),
      ],
    ],
  },
  {
    id: "write-outside-scope",
    tier: "recovery",
    prompt:
      "Add a G2 half note at beat 2 on the bass track. (Its source file may not say what you expect, so use whatever works.)",
    setup: bandSetup("lead"),
    grade: (ctx) => [
      check(
        "G2 at 2",
        notesOf(ctx.score, "bass").some(
          (note) =>
            note.pitch === 43 &&
            round(beatOf(ctx.score, note)) === 2 &&
            round(lengthOf(ctx.score, note)) === 2,
        ),
      ),
      check("5 bass notes", notesOf(ctx.score, "bass").length === 5),
      unchanged(ctx, "lead"),
    ],
    reference: [
      [
        call("edit_file", {
          path: "tracks/bass/track.ts",
          old: 'note("C2", 0, 4)',
          new: 'note("C2", 0, 4), note("G2", 2, 2)',
        }),
      ],
      [notesCall("bass", [["G2", 2, 2]])],
    ],
  },
];

export const TASKS: readonly EvalTask[] = [
  ...single,
  ...compose,
  ...files,
  ...multi,
  ...recovery,
];
