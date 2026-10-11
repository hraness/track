import { describe, expect, test } from "bun:test";
import { PRESETS, presetByName } from "../../core/presets/index.ts";
import { emptyScore, type TrackScore } from "../../core/score.ts";
import { PRESET_TOOLS } from "../agent/preset-tools.ts";
import {
  applyPresetCommand,
  findPresets,
  parsePresetCommand,
  similarPresets,
  steppedPreset,
  trackPreset,
  usePreset,
} from "./preset.ts";

function score(): TrackScore {
  const base = emptyScore();
  return base.withTracks([
    { ...base.tracks[0]!, id: "lead", instrument: "sawtooth" },
    { ...base.tracks[0]!, id: "drums", instrument: "kit" },
  ]);
}

describe("preset command", () => {
  test("parses every verb, and leaves other lines alone", () => {
    expect(parsePresetCommand("preset warm-pad")).toEqual({
      type: "preset-use",
      name: "warm-pad",
    });
    expect(parsePresetCommand("/presets")).toEqual({ type: "preset-browse" });
    expect(parsePresetCommand("/presets bass")).toEqual({
      type: "preset-browse",
      list: "bass",
    });
    expect(parsePresetCommand("preset find fm bell")).toEqual({
      type: "preset-list",
      query: "fm bell",
    });
    expect(parsePresetCommand("preset next")).toEqual({
      type: "preset-step",
      step: 1,
    });
    expect(parsePresetCommand("preset fav")).toEqual({ type: "preset-fav" });
    expect(parsePresetCommand("synth preset pad")).toBeUndefined();
    expect(parsePresetCommand("preset two words")).toBeUndefined();
  });

  test("fuzzy search finds by name, subsequence and tag", () => {
    expect(findPresets("warm pad")[0]?.name).toBe("warm-pad");
    expect(findPresets("wrmpd").map((p) => p.name)).toContain("warm-pad");
    expect(findPresets("808").length).toBeGreaterThan(0);
    expect(findPresets("zzzzqqq")).toEqual([]);
  });

  test("similar presets share the category or tags", () => {
    const pad = presetByName("warm-pad")!;
    const like = similarPresets(pad);
    expect(like.length).toBeGreaterThan(0);
    expect(like).not.toContain(pad);
  });

  test("loading a preset plays its patch and remembers where it came from", () => {
    const result = usePreset(score(), "lead", presetByName("warm-pad")!);
    expect(result.ok).toBe(true);
    const track = result.next!.tracks.find((t) => t.id === "lead");
    expect(track?.instrument).toBe("patch");
    expect(trackPreset(track)?.name).toBe("warm-pad");
    expect(result.message).toContain("Warmth");
  });

  test("a kit needs a drum track and a melodic preset a melodic one", () => {
    const kit = PRESETS.find((p) => p.kind === "kit")!;
    expect(usePreset(score(), "lead", kit).ok).toBe(false);
    expect(usePreset(score(), "drums", kit).ok).toBe(true);
    expect(usePreset(score(), "drums", presetByName("warm-pad")!).ok).toBe(
      false,
    );
  });

  test("a chain preset swaps in place when browsing", () => {
    const chains = PRESETS.filter((p) => p.kind === "effect");
    let next = usePreset(score(), "lead", chains[0]!).next!;
    next = usePreset(next, "lead", chains[1]!).next!;
    const stages = next.tracks.find((t) => t.id === "lead")!.fxPatch ?? [];
    expect(stages.map((p) => p.name)).toEqual([chains[1]!.name]);
  });

  test("next and prev step through the category and wrap", () => {
    const loaded = usePreset(score(), "lead", presetByName("warm-pad")!).next!;
    const track = loaded.tracks.find((t) => t.id === "lead");
    const next = steppedPreset(track, 1)!;
    expect(next.category).toBe("pad");
    expect(next.name).not.toBe("warm-pad");
    const back = usePreset(loaded, "lead", next).next!;
    expect(
      steppedPreset(
        back.tracks.find((t) => t.id === "lead"),
        -1,
      )?.name,
    ).toBe("warm-pad");
  });

  test("info names the feature, the knobs and the /patch path", () => {
    const result = applyPresetCommand(score(), "lead", {
      type: "preset-info",
      name: "warm-pad",
    });
    expect(result.read).toBe(true);
    expect(result.message).toContain("uses:");
    expect(result.message).toContain("/patch");
  });
});

describe("agent preset tools", () => {
  const context = {
    score: score(),
    focusedTrackId: "lead",
    revision: 0,
    newNoteId: () => "n",
  };
  const tool = (name: string) => PRESET_TOOLS.find((t) => t.name === name)!;

  test("preset_catalog lists, searches and describes", async () => {
    for (const args of [
      {},
      { category: "bass" },
      { query: "fm" },
      { name: "warm-pad" },
    ]) {
      const plan = tool("preset_catalog").plan(args, context);
      expect(plan.kind).toBe("action");
      if (plan.kind !== "action") continue;
      const out = await plan.run({});
      expect(out.content.length).toBeGreaterThan(10);
    }
    expect(() =>
      tool("preset_catalog").plan({ name: "nope-nope" }, context),
    ).toThrow();
  });

  test("use_preset commits score operations", () => {
    const plan = tool("use_preset").plan({ name: "warm-pad" }, context);
    expect(plan.kind).toBe("score");
    if (plan.kind === "score")
      expect(plan.operations.length).toBeGreaterThan(0);
    expect(() => tool("use_preset").plan({ name: "nope" }, context)).toThrow();
  });
});
