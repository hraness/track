/** Effect-chain presets (any track) and drum kit rows. */
import { knob, type PresetSpec } from "../build.ts";

export const CHAIN: readonly PresetSpec[] = [
  {
    name: "vocal-chain",
    category: "chain",
    tags: ["vocal", "mix", "compressor", "plate", "clean"],
    desc: "vocal chain: rumble cut, leveller, presence lift, doubler and plate",
    feature: "a classic serial channel strip with a doubler",
    fx: [
      ["filter", { type: "hpf", cutoff: 90 }, "lowcut"],
      [
        "compressor",
        { threshold: -20, ratio: 3, attack: 0.005, release: 0.12, makeup: 4 },
      ],
      ["double", { time: 18, drift: 3, width: 0.5 }],
      [
        "reverb",
        { mix: 0.15, size: 0.45, fade: 1.4, lowpass: 8000, predelay: 0.02 },
      ],
    ],
    knobs: [
      knob(
        "Level",
        [-40, -6, -20],
        { "compressor.threshold": null },
        "how firmly the leveller holds",
      ),
      knob(
        "Low Cut",
        [30, 300, 90],
        { "lowcut.cutoff": null },
        "rumble cut",
        "exp",
      ),
      knob("Double", [0, 1, 0.5], { "double.width": null }, "doubler width"),
      knob("Plate", [0, 0.5, 0.15], { "reverb.mix": null }, "plate reverb"),
    ],
  },
  {
    name: "lofi-chain",
    category: "chain",
    tags: ["lofi", "tape", "crush", "dusty", "warm"],
    desc: "lo-fi: band-limited, crushed, wobbly and warm",
    feature: "bitcrush, tape wobble and a narrow band-pass",
    fx: [
      ["filter", { type: "hpf", cutoff: 150 }, "lowcut"],
      ["filter", { type: "lpf", cutoff: 4500 }, "highcut"],
      ["crush", { bits: 10, mix: 0.6 }],
      ["wobble", { depth: 30, rate: 0.6, drift: 0.4 }],
      ["reverb", { mix: 0.12, size: 0.4 }],
    ],
    knobs: [
      knob(
        "Dust",
        [4, 16, 10],
        { "crush.bits": null },
        "bit depth: lower is grittier",
      ),
      knob("Wobble", [0, 100, 30], { "wobble.depth": null }, "tape wobble"),
      knob(
        "Muffle",
        [800, 12000, 4500],
        { "highcut.cutoff": null },
        "how muffled the top is",
        "exp",
      ),
      knob("Room", [0, 0.5, 0.12], { "reverb.mix": null }, "room"),
    ],
  },
  {
    name: "tape-warmth",
    category: "chain",
    tags: ["tape", "saturation", "warm", "analog", "glue"],
    desc: "tape machine: soft saturation, gentle glue and a little flutter",
    feature: "saturation into a slow compressor with wow and flutter",
    fx: [
      ["distort", { drive: 2, tone: 5000, mix: 0.6 }],
      [
        "compressor",
        { threshold: -18, ratio: 2, attack: 0.03, release: 0.3, makeup: 2 },
      ],
      ["wobble", { depth: 12, rate: 0.5, drift: 0.3 }],
    ],
    knobs: [
      knob("Drive", [0, 6, 2], { "distort.drive": null }, "tape saturation"),
      knob(
        "Glue",
        [-36, -6, -18],
        { "compressor.threshold": null },
        "compression",
      ),
      knob("Flutter", [0, 60, 12], { "wobble.depth": null }, "wow and flutter"),
      knob("Blend", [0, 1, 0.6], { "distort.mix": null }, "saturated blend"),
    ],
  },
  {
    name: "dub-delay",
    category: "chain",
    tags: ["dub", "delay", "reggae", "echo", "feedback"],
    desc: "dub echo: dark, high-feedback dotted repeats into a spring",
    feature: "tempo-synced delay with a band-limited feedback path",
    fx: [
      ["delay", { beats: 0.75, feedback: 0.65, mix: 0.4, highcut: 2200 }],
      ["filter", { type: "hpf", cutoff: 200 }, "thin"],
      ["reverb", { mix: 0.2, size: 0.45, fade: 1.5 }],
    ],
    knobs: [
      knob(
        "Repeats",
        [0, 0.9, 0.65],
        { "delay.feedback": null },
        "echo repeats",
      ),
      knob(
        "Time",
        [0.125, 1.5, 0.75],
        { "delay.beats": null },
        "echo time in beats",
      ),
      knob(
        "Dark",
        [800, 8000, 2200],
        { "delay.highcut": null },
        "how dark the repeats get",
        "exp",
      ),
      knob("Echo", [0, 0.8, 0.4], { "delay.mix": null }, "echo level"),
    ],
  },
  {
    name: "big-room-reverb",
    category: "chain",
    tags: ["reverb", "hall", "cinematic", "ambient", "space"],
    desc: "huge hall with predelay and a soft low-pass",
    feature: "long reverb with predelay and damping",
    fx: [
      [
        "reverb",
        { mix: 0.4, size: 0.95, fade: 6, lowpass: 6000, predelay: 0.05 },
      ],
    ],
    knobs: [
      knob("Size", [0.2, 1, 0.95], { "reverb.size": null }, "room size"),
      knob("Tail", [0.5, 12, 6], { "reverb.fade": null }, "decay time", "exp"),
      knob(
        "Damp",
        [1500, 14000, 6000],
        { "reverb.lowpass": null },
        "how dark the tail is",
        "exp",
      ),
      knob("Mix", [0, 1, 0.4], { "reverb.mix": null }, "wet level"),
    ],
  },
  {
    name: "shimmer-space",
    category: "chain",
    tags: ["shimmer", "ambient", "bloom", "reverb", "ethereal"],
    desc: "blooming octave shimmer into a long wash",
    feature: "harmonic bloom stage feeding a long reverb",
    fx: [
      ["bloom", { amount: 0.5, harm: 2 }],
      ["reverb", { mix: 0.45, size: 0.95, fade: 7, lowpass: 9000 }],
    ],
    knobs: [
      knob(
        "Bloom",
        [0, 1, 0.5],
        { "bloom.amount": null },
        "how much the sound blooms",
      ),
      knob(
        "Shimmer",
        [1, 4, 2],
        { "bloom.harm": null },
        "which harmonic blooms: octave, fifth above, two octaves",
      ),
      knob("Tail", [1, 12, 7], { "reverb.fade": null }, "decay", "exp"),
      knob("Mix", [0, 1, 0.45], { "reverb.mix": null }, "wet level"),
    ],
  },
  {
    name: "guitar-amp",
    category: "chain",
    tags: ["amp", "guitar", "drive", "cab", "rock"],
    desc: "pedal, amp head and 4x12 for any track",
    feature: "stomp, head and cabinet simulation",
    fx: [
      ["stomp", { type: "od", gain: 4, tone: 0.5 }],
      ["head", { type: "crunch", gain: 5 }],
      ["cab", { type: "4x12", mic: 0.3 }],
    ],
    knobs: [
      knob("Pedal", [0, 10, 4], { "stomp.gain": null }, "pedal drive"),
      knob("Amp", [0, 10, 5], { "head.gain": null }, "amp gain"),
      knob("Mid", [0, 10, 5], { "head.mid": null }, "amp mids"),
      knob("Mic", [0, 1, 0.3], { "cab.mic": null }, "mic position on the cone"),
    ],
  },
  {
    name: "rotary-speaker",
    category: "chain",
    tags: ["leslie", "organ", "rotary", "swirl"],
    desc: "rotary speaker swirl for organs and guitars",
    feature: "Leslie horn and drum simulation",
    fx: [
      ["distort", { drive: 1.5, mix: 0.5 }],
      ["leslie", { mix: 1, rate: 0.8, size: 0.5 }],
    ],
    knobs: [
      knob(
        "Speed",
        [0.5, 7, 0.8],
        { "leslie.rate": null },
        "slow chorale to fast tremolo",
        "exp",
      ),
      knob("Cabinet", [0, 1, 0.5], { "leslie.size": null }, "cabinet size"),
      knob("Mix", [0, 1, 1], { "leslie.mix": null }, "wet level"),
      knob(
        "Drive",
        [0, 5, 1.5],
        { "distort.drive": null },
        "tube preamp drive",
      ),
    ],
  },
  {
    name: "telephone",
    category: "chain",
    tags: ["telephone", "radio", "band-pass", "lofi", "vocal"],
    desc: "telephone and radio voice: narrow band with a little grit",
    feature: "steep band-limiting with drive",
    fx: [
      ["filter", { type: "hpf", cutoff: 400, resonance: 0.2 }, "lowcut"],
      ["filter", { type: "lpf", cutoff: 3200, resonance: 0.2 }, "highcut"],
      ["distort", { drive: 3, mix: 0.6 }],
    ],
    knobs: [
      knob(
        "Low",
        [100, 1200, 400],
        { "lowcut.cutoff": null },
        "low edge",
        "exp",
      ),
      knob(
        "High",
        [1200, 8000, 3200],
        { "highcut.cutoff": null },
        "high edge",
        "exp",
      ),
      knob("Grit", [0, 8, 3], { "distort.drive": null }, "line grit"),
      knob("Blend", [0, 1, 0.6], { "distort.mix": null }, "grit blend"),
    ],
  },
  {
    name: "master-bus",
    category: "chain",
    tags: ["master", "bus", "glue", "mix", "loudness"],
    desc: "gentle master bus: low cut, glue compressor and a soft top",
    feature: "bus compression with a safe low cut",
    fx: [
      ["filter", { type: "hpf", cutoff: 25 }, "lowcut"],
      [
        "compressor",
        {
          threshold: -14,
          ratio: 2,
          knee: 6,
          attack: 0.03,
          release: 0.25,
          makeup: 2,
        },
      ],
      ["filter", { type: "lpf", cutoff: 18000 }, "air"],
    ],
    knobs: [
      knob(
        "Glue",
        [-30, -4, -14],
        { "compressor.threshold": null },
        "how much the bus is glued",
      ),
      knob(
        "Ratio",
        [1, 6, 2],
        { "compressor.ratio": null },
        "compression ratio",
      ),
      knob(
        "Makeup",
        [0, 12, 2],
        { "compressor.makeup": null },
        "makeup gain (dB)",
      ),
      knob(
        "Air",
        [6000, 20000, 18000],
        { "air.cutoff": null },
        "top end",
        "exp",
      ),
    ],
  },
  {
    name: "phaser-sweep",
    category: "chain",
    tags: ["phaser", "sweep", "70s", "psychedelic"],
    desc: "slow swooshing phaser",
    feature: "tempo-synced phaser",
    fx: [["phaser", { rate: 0.3, depth: 0.7, sweep: 2000 }]],
    knobs: [
      knob(
        "Speed",
        [0.05, 4, 0.3],
        { "phaser.rate": null },
        "sweep speed",
        "exp",
      ),
      knob("Depth", [0, 1, 0.7], { "phaser.depth": null }, "depth"),
      knob(
        "Sweep",
        [200, 6000, 2000],
        { "phaser.sweep": null },
        "sweep width (Hz)",
        "exp",
      ),
      knob(
        "Centre",
        [200, 4000, 1000],
        { "phaser.center": null },
        "center",
        "exp",
      ),
    ],
  },
];

/**
 * A drum preset: the synth kit plus a drum-bus chain (compressor, color,
 * tone, room) whose four knobs turn it, loaded as the drum track's effect
 * patch.
 */
const drumKit = (
  name: string,
  kit: string,
  tags: readonly string[],
  desc: string,
  feature: string,
  color: PresetSpec["fx"] extends readonly (infer S)[] | undefined ? S : never,
  colorKnob: ReturnType<typeof knob>,
  bus: Readonly<{
    threshold: number;
    ratio: number;
    tone: number;
    room: number;
    size: number;
  }>,
): PresetSpec => ({
  name,
  category: "drums",
  kit,
  guard: true,
  tags,
  desc,
  feature,
  fx: [
    [
      "compressor",
      {
        threshold: bus.threshold,
        ratio: bus.ratio,
        knee: 4,
        attack: 0.012,
        release: 0.12,
        makeup: 2,
      },
      "punch",
    ],
    color,
    ["filter", { type: "lpf", cutoff: bus.tone, resonance: 0 }, "tone"],
    [
      "reverb",
      {
        mix: bus.room,
        size: bus.size,
        fade: 1.2,
        lowpass: 7000,
        predelay: 0.01,
      },
      "room",
    ],
  ],
  knobs: [
    knob(
      "Punch",
      [-30, -6, bus.threshold],
      { "punch.threshold": [-6, -30] },
      "bus compression: more snap and sustain on every hit",
    ),
    colorKnob,
    knob(
      "Tone",
      [1500, 18000, bus.tone],
      { "tone.cutoff": null },
      "dark and muffled to open and bright",
      "exp",
    ),
    knob(
      "Room",
      [0, 0.5, bus.room],
      { "room.mix": null },
      "dry and tight to a live room around the kit",
    ),
  ],
});

const grit = (drive: number, mix: number) =>
  [
    ["distort", { type: "soft", drive, tone: 9000, mix }, "grit"] as const,
    knob(
      "Grit",
      [0, 4, drive],
      { "grit.drive": null },
      "clean to saturated, pushed through tape",
    ),
  ] as const;

const dust = (amount: number) =>
  [
    [
      "crush",
      { bits: Math.round((16 - amount * 10) * 10) / 10, coarse: 1, mix: 0.6 },
      "dust",
    ] as const,
    knob(
      "Dust",
      [0, 1, amount],
      { "dust.bits": [16, 6] },
      "clean to crunchy sampler bit depth",
    ),
  ] as const;

const kitSpec = (
  name: string,
  kit: string,
  tags: readonly string[],
  desc: string,
  feature: string,
  color: readonly [
    PresetSpec["fx"] extends readonly (infer S)[] | undefined ? S : never,
    ReturnType<typeof knob>,
  ],
  bus: Parameters<typeof drumKit>[7],
) => drumKit(name, kit, tags, desc, feature, color[0], color[1], bus);

/** Drum presets: synth kits with a drum-bus chain. */
export const KITS: readonly PresetSpec[] = [
  kitSpec(
    "808-kit",
    "syn808",
    ["808", "hip-hop", "electro", "classic"],
    "synth 808: booming kick, snappy snare, ticking hats",
    "drum synthesis: tuned kick sweep and long boom, into a drum bus",
    grit(0.6, 0.4),
    { threshold: -16, ratio: 3, tone: 14000, room: 0.08, size: 0.4 },
  ),
  kitSpec(
    "909-kit",
    "syn909",
    ["909", "house", "techno", "classic"],
    "synth 909: punchy kick and bright hats for house and techno",
    "drum synthesis: short punchy sweep, into a drum bus",
    grit(0.8, 0.4),
    { threshold: -18, ratio: 4, tone: 16000, room: 0.06, size: 0.35 },
  ),
  kitSpec(
    "acoustic-kit",
    "acoustic",
    ["acoustic", "rock", "live", "natural"],
    "natural acoustic kit in a live room",
    "modeled drums with natural decays and a room reverb",
    grit(0.3, 0.3),
    { threshold: -20, ratio: 3, tone: 12000, room: 0.18, size: 0.55 },
  ),
  kitSpec(
    "lofi-kit",
    "lofi",
    ["lofi", "dusty", "boom-bap", "crushed"],
    "dusty, crushed boom-bap kit",
    "bitcrush and sample-and-hold on the whole kit",
    dust(0.4),
    { threshold: -18, ratio: 3, tone: 6000, room: 0.1, size: 0.4 },
  ),
  kitSpec(
    "electro-kit",
    "electro",
    ["electro", "minimal", "tight", "clicky"],
    "tight, clicky minimal kit",
    "short metallic hats and a tight kick",
    grit(0.5, 0.3),
    { threshold: -16, ratio: 3, tone: 15000, room: 0.05, size: 0.3 },
  ),
  kitSpec(
    "trap-kit",
    "trap",
    ["trap", "808", "drill", "distorted"],
    "trap: distorted long 808, crisp hats, high snare",
    "saturation on a long sliding 808",
    grit(1, 0.4),
    { threshold: -16, ratio: 3, tone: 16000, room: 0.05, size: 0.3 },
  ),
  kitSpec(
    "606-kit",
    "syn606",
    ["606", "electro", "acid", "classic", "minimal"],
    "synth 606: thin tight kick, snappy snare, ticking metal hats",
    "six-square metallic hats and a short tuned kick, into a drum bus",
    grit(0.6, 0.35),
    { threshold: -18, ratio: 3, tone: 15000, room: 0.06, size: 0.3 },
  ),
  kitSpec(
    "707-kit",
    "syn707",
    ["707", "house", "freestyle", "classic", "80s"],
    "synth 707: punchy short kick, crisp snare and bright hats",
    "bright noise hats and a punchy sweep, glued on a drum bus",
    grit(0.7, 0.35),
    { threshold: -18, ratio: 3.5, tone: 16000, room: 0.08, size: 0.4 },
  ),
  kitSpec(
    "linn-kit",
    "synlinn",
    ["linn", "80s", "pop", "funk", "classic"],
    "80s Linn-style kit: fat kick, big tonal snare in a bright room",
    "tonal snare body and a gated-feeling room on a drum bus",
    grit(0.5, 0.3),
    { threshold: -20, ratio: 4, tone: 14000, room: 0.2, size: 0.5 },
  ),
  kitSpec(
    "breaks-kit",
    "breaks",
    ["breaks", "breakbeat", "jungle", "boom-bap", "dusty"],
    "dusty live break: thuddy kick, cracking snare, crushed top",
    "sample-and-hold and bitcrush on the kit, then a squashed bus",
    dust(0.6),
    { threshold: -22, ratio: 5, tone: 9000, room: 0.12, size: 0.45 },
  ),
];
