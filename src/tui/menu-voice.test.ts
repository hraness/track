import { describe, expect, test } from "bun:test";
import { AUTOMATION_PARAMETERS, createScore } from "../../core/score.ts";
import {
  EditMenu,
  rootNodes,
  type MenuContext,
  type MenuNode,
} from "./menu.ts";

function context(): MenuContext {
  return {
    score: createScore({
      tempoBpm: 120,
      bars: 2,
      tracks: [{ id: "lead", name: "lead", instrument: "saw" }],
      notes: [],
    }),
    trackId: "lead",
    playing: false,
    grid: "1/16",
    grids: ["1/4", "1/8", "1/16"],
    clickOn: false,
    countInBars: 1,
  };
}

function open(nodes: MenuNode[], id: string, ctx: MenuContext): MenuNode[] {
  const node = nodes.find((n) => n.kind === "menu" && n.id === id);
  if (!node || node.kind !== "menu") throw new Error(`no menu ${id}`);
  return node.build(ctx);
}

const labels = (nodes: MenuNode[]) => nodes.map((node) => node.label);

describe("0.7 Voice root", () => {
  test("Voice is a root, always shown, with an empty state on a synth track", () => {
    const ctx = context();
    const root = rootNodes(ctx);
    expect(labels(root)).toEqual([
      "Sound",
      "Voice",
      "Effects",
      "Rhythm",
      "Chords and key",
      "Mix",
      "Arrange",
      "Project",
    ]);
    const voiceRoot = root[1]!;
    expect(voiceRoot.kind === "menu" && voiceRoot.detail).toBe(
      "turn this track into a voice",
    );
    const voice = open(root, "voice", ctx);
    // The empty state leads; clips and lyrics follow so a take imports now.
    expect(voice[0]).toMatchObject({
      label: "voice presets",
      detail: "turn this track into a voice",
    });
    expect(labels(voice)).toEqual(
      expect.arrayContaining(["clips", "lyrics", "formant", "vocoder"]),
    );
    const presets = open(voice, "voice:presets", ctx);
    expect(labels(presets).map((l) => l.split(" ")[0])).toEqual([
      "vocal",
      "choir",
      "solo",
      "throat",
      "vocoder",
    ]);
    // Sound no longer carries voice rows; Effects links to Voice.
    const sound = open(root, "sound", ctx);
    expect(labels(sound)).not.toContain("Voice");
    expect(labels(sound).slice(-3)).toEqual([
      "performance",
      "instruments",
      "preset library",
    ]);
    expect(labels(open(sound, "browse", ctx))).not.toContain("Voices");
    const effects = open(root, "effects", ctx);
    expect(labels(effects).filter((l) => l === "voice effects")).toHaveLength(
      1,
    );
    expect(labels(open(effects, "voice", ctx))).toEqual(
      expect.arrayContaining(["formant", "vocoder"]),
    );
  });

  test("a sing track opens Voice on sing, then voice presets last", () => {
    const ctx: MenuContext = {
      ...context(),
      score: createScore({
        tempoBpm: 120,
        bars: 2,
        tracks: [
          {
            id: "lead",
            name: "lead",
            instrument: "sing",
            sing: { preset: "choir" },
          },
        ],
        notes: [],
      } as never),
    };
    const root = rootNodes(ctx);
    const voiceRoot = root.find((n) => n.label === "Voice")!;
    expect(voiceRoot.kind === "menu" && voiceRoot.detail).toStartWith("sing");
    const voice = open(root, "voice", ctx);
    expect(labels(voice)[0]).toBe("sing");
    expect(labels(voice).at(-1)).toBe("voice presets");
    expect(labels(open(voice, "voice:sing", ctx))).toEqual(
      expect.arrayContaining(["preset", "throat", "vowels"]),
    );
  });

  test("formant rows: on, preset, shift, mix; the vowel gains to and morph", () => {
    const ctx = context();
    const effects = open(rootNodes(ctx), "effects", ctx);
    const formant = open(open(effects, "voice", ctx), "formant", ctx);
    // The same rows open from the Voice root.
    expect(
      labels(open(open(rootNodes(ctx), "voice", ctx), "formant", ctx)),
    ).toEqual(labels(formant));
    expect(labels(formant)).toEqual([
      "on",
      "preset",
      "shift",
      "mix",
      "advanced",
    ]);
    const shift = formant.find((node) => node.label === "shift")!;
    expect(shift.kind === "number" && shift.command(-4)).toBe(
      "fx formant shift -4",
    );
    // Not duplicated under more effects.
    expect(labels(open(effects, "more effects", ctx))).not.toContain("formant");
    const vowel = open(open(effects, "more effects", ctx), "vowel", ctx);
    expect(labels(vowel)).toEqual(
      expect.arrayContaining(["vowel", "mix", "to", "morph"]),
    );
    const to = vowel.find((node) => node.label === "to")!;
    expect(to.kind === "choice" && to.command("o")).toBe("/vowel to o");
  });

  test("Mix offers the formant and vowel-morph lanes", () => {
    expect(AUTOMATION_PARAMETERS).toEqual(
      expect.arrayContaining(["formant-shift", "formant-mix", "vowel-morph"]),
    );
  });
});

describe("Voice › pitch (pitch lane)", () => {
  test("shows only for a track with audio, with analyze, trace and notes rows", async () => {
    const { pitchMenuRows, pitchSoundRows } = await import("./menu-voice.ts");
    const ctx = context();
    expect(pitchSoundRows(ctx)).toEqual([]);
    const withClip: MenuContext = {
      ...ctx,
      score: createScore({
        tracks: [
          {
            id: "lead",
            instrument: "sine",
            clips: [
              {
                id: "verse",
                src: "tracks/lead/samples/verse.wav",
                sha256: "a".repeat(64),
                startTick: 0,
              },
            ],
          },
        ],
      } as never),
    };
    const rows = pitchSoundRows(withClip);
    expect(labels(rows)).toEqual(["pitch"]);
    const voice = open(rootNodes(withClip), "voice", withClip);
    expect(labels(voice)).toContain("pitch");
    // A track with clips is a voice: no empty state, presets last.
    expect(labels(voice)).not.toContain("turn this track into a voice");
    const pitch = pitchMenuRows(withClip);
    expect(labels(pitch)).toEqual([
      "analyze",
      "detected key",
      "median pitch",
      "trace",
      "make notes",
    ]);
    const trace = pitch.find((row) => row.label === "trace")!;
    if (trace.kind !== "toggle") throw new Error("trace is a toggle");
    expect(trace.value).toBe(false);
    expect(trace.command(true)).toBe("/vocal pitch trace on");
    const make = pitch.find((row) => row.label === "make notes")!;
    expect(make.kind === "action" && make.command).toBe("/vocal notes");
  });

  test("Voice › autotune on a sampler track: rows run autotune", () => {
    const ctx: MenuContext = {
      ...context(),
      trackId: "vox",
      score: createScore({
        tempoBpm: 120,
        bars: 2,
        tracks: [
          { id: "lead", name: "lead", instrument: "saw" },
          {
            id: "vox",
            name: "vox",
            instrument: "sampler",
            sampler: {
              mode: "oneshot",
              voices: { take: { src: "tracks/vox/samples/take.wav" } },
            },
            autotune: { preset: "hard", speed: 10 },
          },
        ],
        notes: [],
      }),
    };
    const voice = open(rootNodes(ctx), "voice", ctx);
    expect(labels(voice)).toContain("autotune");
    // The root filter finds nested voice groups by name.
    const menu = new EditMenu();
    menu.show(ctx);
    menu.key("/", ctx);
    for (const ch of "autotune") menu.key(ch, ctx);
    const found = menu.view(ctx).items.map((item) => item.label);
    const deep = found.findIndex((label) => label.includes("Voice › autotune"));
    expect(deep).toBeGreaterThan(0);
    for (let i = 0; i < deep; i++) menu.key("\x1b[B", ctx);
    menu.key("\r", ctx);
    expect(menu.view(ctx).items[0]!.label).toStartWith("preset");
    const rows = open(voice, "voice:autotune", ctx);
    expect(labels(rows).slice(0, 4)).toEqual(["preset", "to", "from", "key"]);
    expect(labels(rows)).toContain("speed");
    expect(labels(rows)).toContain("drift");
    expect(labels(rows)).toContain("voice");
    const preset = rows.find((row) => row.label === "preset")!;
    if (preset.kind !== "choice") throw new Error("preset is a choice");
    expect(preset.value).toBe("hard");
    expect(preset.command("gentle")).toBe("autotune gentle");
    expect(preset.command("off")).toBe("autotune off");
    const speed = rows.find((row) => row.label === "speed")!;
    if (speed.kind !== "number") throw new Error("speed is a number");
    expect(speed.value).toBe(10);
    expect(speed.command(speed.step(10, 1))).toBe("autotune speed 15");
    expect(speed.reset).toBe("autotune speed off");
    const from = rows.find((row) => row.label === "from")!;
    if (from.kind !== "choice") throw new Error("from is a choice");
    expect(from.options).toEqual(["own notes", "lead"]);
    expect(from.command("lead")).toBe("autotune to notes lead");
    expect(labels(rows).at(-1)).toBe("reset to preset");
  });

  test("a synth track has no autotune row", () => {
    const ctx = context();
    expect(labels(open(rootNodes(ctx), "voice", ctx))).not.toContain(
      "autotune",
    );
  });
});
