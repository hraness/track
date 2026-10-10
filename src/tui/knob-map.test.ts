/**
 * The knob table (src/tui/knob-map.ts) against the live Ctrl-K tree: every
 * page's paths resolve for a track of each instrument family, and every
 * turn, coarse turn and reset a knob makes is a command the prompt runs
 * locally, so a knob is never a gesture without words (design §10).
 */
import { describe, expect, test } from "bun:test";
import { createScore, type TrackScore } from "../../core/score.ts";
import { accepts, menuContext } from "../../test/consistency-lib.ts";
import { instrumentPatch } from "../agent/ops.ts";
import { newPianoTrack } from "../commands/keys.ts";
import { faderSpecs, rootNodes } from "./menu.ts";
import { resolveKnobPath, knobSlots } from "./knob-fields.ts";
import { KNOB_MAPS, knobPageId, soundFamily } from "./knob-map.ts";
import { EUCLID_PARAMS } from "./euclid.ts";
import type { FaderSpec } from "./fader.ts";

const FAMILY_TRACKS: Record<string, Record<string, unknown>> = {
  synth: { instrument: "sawtooth" },
  wavetable: instrumentPatch("wavetable"),
  piano: newPianoTrack("grand"),
  electric: newPianoTrack("rhodes"),
  organ: newPianoTrack("tonewheel"),
  string: instrumentPatch("nylon"),
  wind: instrumentPatch("flute"),
  modal: { instrument: "modal", modal: {} },
  sing: instrumentPatch("choir"),
  granular: { instrument: "granular" },
  sampler: {
    instrument: "sampler",
    sampler: { mode: "oneshot", voices: { hit: { src: "a.wav" } } },
  },
  kit: { instrument: "kit" },
};

function songWith(patch: Record<string, unknown>): TrackScore {
  return createScore({
    tempoBpm: 120,
    bars: 2,
    tracks: [{ id: "t", name: "t", ...patch }],
    notes: [],
  } as Parameters<typeof createScore>[0]);
}

/** Every command one knob can run: both turns, both coarse turns, reset. */
function knobCommands(field: FaderSpec): string[] {
  if (field.kind === "choice")
    return field.options.map((option) => field.command(option));
  const value = field.value ?? field.start ?? field.min;
  const commands = [field.command(value)];
  for (const direction of [1, -1] as const) {
    let at = value;
    commands.push(field.command(field.step(at, direction)));
    for (let i = 0; i < 5; i++) at = field.step(at, direction);
    commands.push(field.command(at));
  }
  if (field.reset) commands.push(field.reset);
  return commands;
}

describe("knob table", () => {
  test("every sound family has a page, and each family maps to its page", () => {
    for (const [family, patch] of Object.entries(FAMILY_TRACKS)) {
      const track = songWith(patch).tracks[0]!;
      expect(soundFamily(track), family).toBe(family);
      expect(KNOB_MAPS[`sound:${family}`], family).toBeDefined();
      expect(knobPageId("sound", track)).toBe(`sound:${family}`);
    }
  });

  test("every row is four slots, and orange is the level on every sound page", () => {
    for (const [page, row] of Object.entries(KNOB_MAPS)) {
      expect(row.length, page).toBe(4);
      // A patch's four knobs are its first four macros (patcher §7.2).
      if (page.startsWith("sound:") && page !== "sound:patch")
        expect(row[3], page).toBe("mix/volume");
    }
  });

  test("every sound path resolves for its family, and every turn is a typed command", () => {
    for (const [family, patch] of Object.entries(FAMILY_TRACKS)) {
      const score = songWith(patch);
      const context = menuContext("t", score);
      const page = `sound:${family}`;
      const slots = knobSlots(context, page);
      KNOB_MAPS[page]!.forEach((path, index) => {
        if (!path) {
          expect(slots[index], `${page} ${index}`).toBeUndefined();
          return;
        }
        expect(slots[index], `${page} ${path}`).toBeDefined();
        for (const command of knobCommands(slots[index]!))
          expect(accepts(command, score), `${page} ${path}: ${command}`).toBe(
            true,
          );
      });
    }
  });

  test("the mix, master, tempo and effect pages resolve on a synth track", () => {
    const score = songWith({ instrument: "sawtooth" });
    const context = menuContext("t", score);
    for (const page of Object.keys(KNOB_MAPS)) {
      // TAPE's knobs are its own (src/tui/tape-mode.ts tapeKnobs, tested
      // there): playhead and loop are not menu fields.
      if (page.startsWith("sound:") || page === "euclid" || page === "tape")
        continue;
      const slots = knobSlots(context, page);
      KNOB_MAPS[page]!.forEach((path, index) => {
        if (!path) return;
        expect(resolveKnobPath(context, path), `${page} ${path}`).toBeDefined();
        expect(slots[index], `${page} ${path}`).toBeDefined();
        for (const command of knobCommands(slots[index]!))
          expect(accepts(command, score), `${page}: ${command}`).toBe(true);
      });
    }
  });

  test("an effect without a row derives three number knobs and its mix", () => {
    const score = songWith({ instrument: "sawtooth" });
    const context = menuContext("t", score);
    const node = rootNodes(context).find(
      (n) => n.kind === "menu" && n.id === "effects",
    );
    expect(node?.kind).toBe("menu");
    if (node?.kind !== "menu") return;
    const unmapped = node
      .build(context)
      .filter(
        (n) =>
          n.kind === "menu" &&
          !(`fx:${n.id}` in KNOB_MAPS) &&
          n.id !== "more effects",
      );
    for (const effect of unmapped) {
      if (effect.kind !== "menu") continue;
      const fields = faderSpecs(effect.build(context));
      const slots = knobSlots(context, `fx:${effect.id}`, fields);
      const mix = fields.find((field) => field.label === "mix");
      expect(slots[3]?.label, effect.id).toBe(mix?.label);
      for (const slot of slots.slice(0, 3))
        if (slot) expect(slot.kind, effect.id).toBe("number");
    }
  });

  test("euclid's knobs name the editor's own fields", () => {
    const [drum, ...rest] = KNOB_MAPS.euclid!;
    expect(drum).toBe("drum");
    for (const field of rest)
      expect(
        EUCLID_PARAMS.some((param) => param.field === field),
        String(field),
      ).toBe(true);
  });

  test("knobs <page> words reach a page", () => {
    const track = songWith({ instrument: "sawtooth" }).tracks[0]!;
    expect(knobPageId(undefined, track)).toBe("sound:synth");
    expect(knobPageId("mix", track)).toBe("mix");
    expect(knobPageId("fx reverb", track)).toBe("fx:reverb");
    expect(knobPageId("piano", track)).toBe("sound:piano");
    expect(knobPageId("nonsense", track)).toBeUndefined();
    for (const word of [
      "knobs",
      "knobs mix",
      "knobs master",
      "knobs tempo",
      "knobs fx reverb",
      "mix",
      "synth",
      "volume",
      "volume t 0.5",
      "pan t -0.5",
    ])
      expect(accepts(word, songWith({ instrument: "sawtooth" })), word).toBe(
        true,
      );
  });

  test("every sound page fills all four knobs (a kit too)", () => {
    for (const [family, patch] of Object.entries(FAMILY_TRACKS)) {
      const score = songWith(patch);
      const slots = knobSlots(menuContext("t", score), `sound:${family}`);
      expect(slots.filter((slot) => slot !== undefined).length, family).toBe(4);
    }
  });
});
