import { describe, expect, test } from "bun:test";
import { createScore, type TrackScore, updateTrack } from "../../core/score.ts";
import { applyEditCommand, parseEditCommand } from "../commands/edit.ts";
import {
  applyExpressionCommand,
  parseExpressionCommand,
} from "../commands/expression.ts";
import { isStageable } from "./audition.ts";
import { EditMenu, type MenuContext } from "./menu.ts";
import { defaultChordSettings } from "./play-chords.ts";

function applyEdit(value: TrackScore, command: string): TrackScore {
  const result = applyExpressionCommand(
    value,
    "keys",
    parseExpressionCommand(command)!,
  );
  return result.next!;
}

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const LEFT = "\u001b[D";
const RIGHT = "\u001b[C";
const ESC = "\u001b";

function score(): TrackScore {
  return createScore({
    tempoBpm: 120,
    bars: 2,
    tracks: [
      { id: "keys", name: "keys", instrument: "piano" },
      { id: "bass", name: "bass", instrument: "bass", volume: 0.6 },
    ],
    notes: [],
  });
}

function context(value = score()): MenuContext {
  return {
    score: value,
    trackId: "keys",
    playing: false,
    grid: "1/16",
    grids: ["1/4", "1/8", "1/16"],
    clickOn: false,
    countInBars: 1,
  };
}

/** Move to the row whose label starts with `label`. */
function select(menu: EditMenu, ctx: MenuContext, label: string): void {
  const rows = menu.view(ctx).items;
  const target = rows.findIndex((row) => row.label.startsWith(label));
  expect(target).toBeGreaterThanOrEqual(0);
  const now = menu.view(ctx).index;
  for (let i = now; i < target; i++) menu.key(DOWN, ctx);
  for (let i = now; i > target; i--) menu.key(UP, ctx);
  expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toStartWith(label);
}

describe("edit menu", () => {
  test("root lists eight plain sections with a summary and a description", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx);
    const labels = menu
      .view(ctx)
      .items.map((row) => row.label.slice(0, 16).trim());
    expect(labels).toEqual([
      "Sound",
      "Voice",
      "Effects",
      "Rhythm",
      "Chords and key",
      "Mix",
      "Arrange",
      "Project",
    ]);
    expect(menu.view(ctx).items[1]!.label).toContain(
      "turn this track into a voice",
    );
    expect(menu.view(ctx).items[4]!.label).toContain("manual");
    expect(menu.view(ctx).items[7]!.label).toContain("120 BPM");
    // The focused row is described under the list.
    expect(menu.view(ctx).note).toContain("instrument");
  });

  test("old section names open where that content lives now", () => {
    const menu = new EditMenu();
    const ctx = context();
    for (const [section, title] of [
      ["parameters", "≡ Sound"],
      ["sounds", "≡ Sound › instruments"],
      ["track", "≡ Mix"],
      ["automation", "≡ Mix › automation"],
      ["transport", "≡ Project"],
      ["tuning", "≡ Chords and key › tuning"],
      ["clips", "≡ Voice"],
      ["agent", "≡ Project › agent"],
      ["keys", "≡ Project › help and guides"],
    ] as const) {
      menu.show(ctx, section);
      expect(menu.view(ctx).title).toBe(title);
    }
  });

  test("Arrange marks, loops, mutes, varies and orders sections", () => {
    const menu = new EditMenu();
    const empty = context();
    menu.show(empty, "arrange");
    expect(menu.view(empty).title).toBe("≡ Arrange");
    expect(menu.view(empty).items[0]!.label).toStartWith("tracks");
    expect(menu.view(empty).items[1]!.label).toStartWith("sections");
    menu.show(empty, "sections");
    expect(menu.view(empty).title).toBe("≡ Arrange › sections");
    expect(menu.view(empty).items[0]!.label).toStartWith("mark bars");
    const ctx = context(
      score().withSections(
        [
          { name: "verse", startBar: 0, bars: 1 },
          { name: "chorus", startBar: 1, bars: 1, mute: ["keys"] },
        ],
        [],
      ),
    );
    menu.show(ctx, "sections");
    expect(menu.view(ctx).items[1]!.label).toContain("mutes keys");
    select(menu, ctx, "chorus");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Arrange › sections › chorus");
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "section loop chorus",
    });
    select(menu, ctx, "mute keys");
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "section unmute chorus keys",
    });
    select(menu, ctx, "transpose keys");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "section vary chorus keys +1",
    });
    expect(menu.key(LEFT, ctx)).toEqual({
      type: "run",
      command: "section vary chorus keys -1",
    });
    expect(menu.key("x", ctx)).toEqual({
      type: "run",
      command: "section vary chorus keys off",
    });
    select(menu, ctx, "build");
    menu.key("\r", ctx);
    select(menu, ctx, "into it");
    expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toBe(
      "into it (1 bar before)",
    );
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "build into chorus",
    });
    menu.key(ESC, ctx);
    select(menu, ctx, "move left");
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "section move chorus left",
    });
    menu.key(ESC, ctx);
    menu.key(ESC, ctx);
    select(menu, ctx, "form");
    expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toContain(
      "bars in order",
    );
  });

  test("Chords edits play-mode chord settings and the song key", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx, "chords");
    expect(menu.view(ctx).title).toBe("≡ Chords and key");
    select(menu, ctx, "mode");
    expect(menu.key(LEFT, ctx)).toEqual({
      type: "run",
      command: "/chords auto",
    });
    select(menu, ctx, "key mode");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "key C minor",
    });
    select(menu, ctx, "voicing");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "/chords voicing 1",
    });
    select(menu, ctx, "bass");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "/chords bass chords",
    });
    select(menu, ctx, "perform");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "/chords perform strum-up",
    });
    select(menu, ctx, "pattern");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "/chords pattern sixteenths",
    });
  });

  test("Enter opens, Esc backs out one level, Esc at the root closes", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx);
    select(menu, ctx, "Effects");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Effects");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Effects › filter");
    expect(menu.key(ESC, ctx)).toEqual({ type: "handled" });
    expect(menu.key(ESC, ctx)).toEqual({ type: "handled" });
    expect(menu.key(ESC, ctx)).toEqual({ type: "close" });
  });

  test("orbit and duck live under more effects and run fx commands", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx);
    select(menu, ctx, "Effects");
    menu.key("\r", ctx);
    select(menu, ctx, "more effects");
    menu.key("\r", ctx);
    select(menu, ctx, "duck");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Effects › more effects › duck");
    const labels = menu.view(ctx).items.map((row) => row.label);
    expect(labels.some((label) => label.startsWith("orbit"))).toBe(true);
    expect(labels.some((label) => label.startsWith("depth"))).toBe(true);
    select(menu, ctx, "orbit");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "fx duck orbit 1",
    });
  });

  test("Effects > Guitar rig loads rigs and opens stomp, head and cab", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx);
    select(menu, ctx, "Effects");
    menu.key("\r", ctx);
    select(menu, ctx, "guitar rig");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Effects › guitar rig");
    const labels = menu.view(ctx).items.map((row) => row.label);
    expect(labels).toHaveLength(4);
    expect(labels[0]!.startsWith("rig")).toBe(true);
    expect(labels[1]!.startsWith("stomp box")).toBe(true);
    select(menu, ctx, "rig");
    expect(menu.key(RIGHT, ctx)).toEqual({ type: "run", command: "rig clean" });
    menu.key("\u001b[B", ctx);
    menu.key("\r", ctx);
    select(menu, ctx, "type");
    expect(menu.key(RIGHT, ctx)).toMatchObject({ type: "run" });
  });

  test("Effects > Shoegaze lists wobble, bloom, swell and double", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx);
    select(menu, ctx, "Effects");
    menu.key("\r", ctx);
    select(menu, ctx, "shoegaze");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Effects › shoegaze");
    const labels = menu.view(ctx).items.map((row) => row.label);
    expect(labels).toHaveLength(4);
    expect(labels[0]).toStartWith("wobble");
  });

  test("Sound > guitar sets tuning and capo on a guitar track", () => {
    const value = createScore({
      tempoBpm: 120,
      tracks: [
        {
          id: "keys",
          name: "gtr",
          instrument: "string",
          string: { preset: "steel" },
          guitar: { capo: 2 },
        },
      ],
    });
    const menu = new EditMenu();
    const ctx = context(value);
    menu.show(ctx, "sound");
    select(menu, ctx, "guitar");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Sound › guitar");
    select(menu, ctx, "tune");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "guitar tune dropd",
    });
    select(menu, ctx, "capo");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "guitar capo 3",
    });
  });

  test("Chords lists strokes and speed only when perform is guitar", () => {
    const menu = new EditMenu();
    const plain = context();
    menu.show(plain, "chords");
    const labels = menu.view(plain).items.map((row) => row.label);
    expect(labels.some((label) => label.startsWith("strokes"))).toBe(false);
    expect(labels.some((label) => label.startsWith("speed"))).toBe(false);
    const ctx: MenuContext = {
      ...context(),
      chords: { ...defaultChordSettings(), perform: "guitar" },
    };
    menu.show(ctx, "chords");
    select(menu, ctx, "strokes");
    expect(menu.key(RIGHT, ctx)).toMatchObject({ type: "run" });
    select(menu, ctx, "speed");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "/chords speed 23ms",
    });
  });

  test("nudges run the command the row shows, with the field's step", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx, "mix");
    select(menu, ctx, "volume");
    const row = menu.view(ctx).items[menu.view(ctx).index]!;
    expect(row.label).toContain("1 · 0.0 dB");
    // The row hides command syntax; the note under the list teaches it.
    expect(row.detail).toBeUndefined();
    expect(menu.view(ctx).note).toEndWith("› volume 1");
    // Clamped at the top of the range; down steps by 0.05.
    expect(menu.key(RIGHT, ctx)).toEqual({ type: "handled" });
    expect(menu.key("-", ctx)).toEqual({ type: "run", command: "volume 0.95" });
    select(menu, ctx, "pan");
    expect(menu.key("l", ctx)).toEqual({ type: "run", command: "pan 0.1" });
    select(menu, ctx, "mute");
    expect(menu.key("\r", ctx)).toEqual({ type: "run", command: "mute" });
  });

  test("typed digits set a value; out-of-range input runs nothing", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx, "project");
    select(menu, ctx, "tempo");
    expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toContain(
      "120 BPM",
    );
    menu.key("9", ctx);
    menu.key("5", ctx);
    expect(menu.view(ctx).title).toContain("tempo: 95");
    expect(menu.key("\r", ctx)).toEqual({ type: "run", command: "tempo 95" });
    menu.key("9", ctx);
    menu.key("9", ctx);
    menu.key("9", ctx);
    expect(menu.key("\r", ctx)).toEqual({ type: "handled" });
    select(menu, ctx, "beats per bar");
    expect(menu.key(LEFT, ctx)).toEqual({ type: "run", command: "meter 3" });
  });

  test("an effect that is off turns on with its first nudge", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx, "effects");
    menu.key("\r", ctx); // Filter
    select(menu, ctx, "cutoff");
    expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toContain("off");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "fx filter cutoff 2000",
    });
    const on = score().toJSON();
    const filtered = createScore({
      ...on,
      tracks: (on.tracks ?? []).map((track) =>
        track.id === "keys"
          ? { ...track, filter: { cutoff: 2000, resonance: 0.2 } }
          : track,
      ),
    });
    const next = context(filtered);
    expect(menu.key(RIGHT, next)).toEqual({
      type: "run",
      command: "fx filter cutoff 2245",
    });
    select(menu, next, "resonance");
    expect(menu.key(RIGHT, next)).toEqual({
      type: "run",
      command: "fx filter resonance 0.25",
    });
  });

  test("Sound: instrument, synth preset, simple params, advanced, patch, performance, browse", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx);
    select(menu, ctx, "Sound");
    menu.key("\r", ctx);
    const labels = menu
      .view(ctx)
      .items.map((row) => row.label.slice(0, 16).trim());
    expect(labels.slice(0, 3)).toEqual(["instrument", "preset", "attack"]);
    expect(labels.at(-7)).toBe("advanced");
    // 0.6: a pitched track can be turned into a grain cloud.
    expect(labels.at(-6)).toBe("granular");
    expect(labels.at(-5)).toBe("track tuning");
    // Patcher §7.4: Sound › patch.
    expect(labels.at(-4)).toBe("patch");
    // 0.7: voice rows live in the Voice root now.
    expect(labels).not.toContain("Voice");
    expect(labels.at(-3)).toBe("performance");
    expect(labels.at(-2)).toBe("instruments");
    // The preset library (core/presets) closes Sound.
    expect(labels.at(-1)).toBe("preset library");
    select(menu, ctx, "attack");
    expect(menu.key(RIGHT, ctx)).toMatchObject({ type: "run" });
    // Plain label; the note names the prompt command.
    select(menu, ctx, "synth filter");
    expect(menu.view(ctx).note).toContain("› synth lpf 2000");
    expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toContain("off");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "synth lpf 2000",
    });
    select(menu, ctx, "advanced");
    menu.key("\r", ctx);
    const groups = menu.view(ctx).items.map((row) => row.label);
    expect(groups.some((label) => label.startsWith("FM 8"))).toBe(true);
    select(menu, ctx, "pitch envelope");
    menu.key("\r", ctx);
    select(menu, ctx, "penv");
    // Unset → the first nudge writes the default, as effects do.
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "synth penv 0",
    });
  });

  test("tuning: song tuning under Chords and key, track tuning under Sound", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx, "tuning");
    expect(menu.view(ctx).title).toBe("≡ Chords and key › tuning");
    select(menu, ctx, "tuning");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "tuning 19-edo",
    });
    select(menu, ctx, "reference A4");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "tuning ref 440",
    });
    select(menu, ctx, "scale");
    expect(menu.key(RIGHT, ctx)).toMatchObject({ type: "run" });
    menu.show(ctx, "sound");
    select(menu, ctx, "track tuning");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Sound › track tuning");
    select(menu, ctx, "tuning");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "tuning track 12-tet",
    });
    select(menu, ctx, "root");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "tuning track root C4",
    });
  });

  test("tuning: ratio, cents and keyboard-map entries, and a tonic that keeps the scale", () => {
    const menu = new EditMenu();
    const value = score().withKey("D hijaz").withTuning({ ref: 432 });
    const ctx = context(value);
    const type = (text: string) => {
      for (const ch of text) menu.key(ch, ctx);
      return menu.key("\r", ctx);
    };
    menu.show(ctx, "tuning");
    select(menu, ctx, "ratios");
    menu.key("\r", ctx);
    expect(type("9/8 5/4 3/2 2/1")).toEqual({
      type: "run",
      command: "tuning ratios 9/8 5/4 3/2 2/1",
    });
    select(menu, ctx, "cents");
    menu.key("\r", ctx);
    expect(type("231 474 1200")).toEqual({
      type: "run",
      command: "tuning cents 231 474 1200",
    });
    select(menu, ctx, "keyboard map");
    menu.key("\r", ctx);
    expect(type("off")).toEqual({ type: "run", command: "tuning kbm off" });
    select(menu, ctx, "tonic");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "key Eb hijaz",
    });
    menu.show(ctx, "chords");
    select(menu, ctx, "key tonic");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "key Eb hijaz",
    });
    // A track that follows the song shows the song's reference.
    menu.show(ctx, "sound");
    select(menu, ctx, "track tuning");
    menu.key("\r", ctx);
    select(menu, ctx, "reference A4");
    expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toContain(
      "432 Hz · song",
    );
  });

  test("choices open a list; ←/→ cycle without opening", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx, "sound");
    select(menu, ctx, "instrument");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "instrument pluck",
    });
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Sound › instrument");
    select(menu, ctx, "saw");
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "instrument saw",
    });
  });

  test("automation: add points, ramp, nudge and delete a point", () => {
    const menu = new EditMenu();
    let ctx = context();
    menu.show(ctx, "automation");
    select(menu, ctx, "filter cutoff");
    menu.key("\r", ctx);
    select(menu, ctx, "add points");
    menu.key("\r", ctx);
    for (const ch of "2:800") menu.key(ch, ctx);
    const add = menu.key("\r", ctx);
    expect(add).toEqual({
      type: "run",
      command: "automate filter points 2:800",
    });
    select(menu, ctx, "ramp");
    menu.key("\r", ctx);
    for (const ch of "0:200 4:8000") menu.key(ch, ctx);
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "automate filter points 0:200 4:8000",
    });

    // Apply both through the edit grammar, then edit the point row.
    let value = score();
    for (const command of [
      "automate filter points 2:800",
      "automate filter points 0:200 4:8000",
    ]) {
      const result = applyEditCommand(
        value,
        "keys",
        parseEditCommand(command)!,
      );
      expect(result.ok).toBe(true);
      value = result.next!;
    }
    expect(value.tracks[0]!.filterAutomation).toHaveLength(3);
    ctx = context(value);
    select(menu, ctx, "beat 2");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "automate filter points 2:1000",
    });
    expect(menu.key("x", ctx)).toEqual({
      type: "run",
      command: "automate filter remove 2",
    });
    select(menu, ctx, "clear lane");
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "clear filter automation",
    });
  });

  test("Mix > master: target, units, presets and params run master commands", () => {
    const menu = new EditMenu();
    let ctx = context();
    menu.show(ctx, "master");
    expect(menu.view(ctx).title).toBe("≡ Mix › master");
    select(menu, ctx, "target");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "master target streaming",
    });
    select(menu, ctx, "target LUFS");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "master target -14",
    });
    select(menu, ctx, "glue");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Mix › master › glue");
    select(menu, ctx, "on");
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "master glue on",
    });
    ctx = context(score().withMaster({ target: -14, glue: { ratio: 2 } }));
    select(menu, ctx, "ratio");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "master glue ratio 2.5",
    });
    expect(menu.key("x", ctx)).toEqual({
      type: "run",
      command: "master glue ratio 2",
    });
    menu.key(ESC, ctx);
    select(menu, ctx, "target LUFS");
    expect(menu.key("x", ctx)).toEqual({
      type: "run",
      command: "master target off",
    });
    select(menu, ctx, "remove master");
    expect(menu.key("\r", ctx)).toEqual({ type: "run", command: "master off" });
  });

  test("Mix > master: target names need a unique LUFS and ceiling match", () => {
    const menu = new EditMenu();
    const row = (ctx: MenuContext, label: string) =>
      menu.view(ctx).items.find((item) => item.label.startsWith(label))!.label;
    const at = (master: Record<string, unknown>) =>
      context(score().withMaster(master as never));
    let ctx = at({ target: -16, limiter: { ceiling: -1 } });
    menu.show(ctx, "master");
    // apple and podcast share -16 LUFS at -1 dBTP: show the number.
    expect(row(ctx, "target ")).toContain("-16 LUFS");
    expect(row(ctx, "target ")).not.toContain("apple");
    ctx = at({ target: -14, limiter: { ceiling: -2 } });
    expect(row(ctx, "target ")).toContain("custom");
    ctx = at({ target: -14, limiter: { ceiling: -1 } });
    expect(row(ctx, "target ")).toContain("streaming");
    // With a target, the limiter's gain is the search's, not the user's.
    select(menu, ctx, "limiter");
    menu.key("\r", ctx);
    expect(row(ctx, "gain")).toContain("set by target");
  });

  test("/ filters the current list; Esc clears the filter first", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx, "project");
    menu.key("/", ctx);
    for (const ch of "grid") menu.key(ch, ctx);
    const rows = menu.view(ctx).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toStartWith("grid");
    expect(menu.view(ctx).note).toEndWith("› /grid 1/16");
    expect(menu.view(ctx).title).toContain("/grid");
    menu.key(ESC, ctx);
    expect(menu.view(ctx).items.length).toBeGreaterThan(1);
    expect(menu.view(ctx).title).toBe("≡ Project");
  });

  test("mix focuses another track before editing it", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx, "mix");
    select(menu, ctx, "all tracks");
    menu.key("\r", ctx);
    select(menu, ctx, "bass");
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "/track bass",
    });
  });

  test("Ctrl-C and redraw pass through to the app", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx);
    expect(menu.key("\u0003", ctx)).toEqual({ type: "pass" });
  });
});

describe("Sound › performance", () => {
  const played = createScore({
    tempoBpm: 120,
    bars: 2,
    tracks: [{ id: "keys", name: "keys", instrument: "piano" }],
    notes: [0, 1].map((beat) => ({
      id: `n${beat}`,
      trackId: "keys",
      startTick: beat * 480,
      durationTicks: 480,
      pitch: 60,
      velocity: 0.8,
    })),
  });

  function open(ctx: MenuContext): EditMenu {
    const menu = new EditMenu();
    menu.show(ctx, "performance");
    return menu;
  }

  test("opens by name and lists the performance rows", () => {
    const ctx = context(played);
    const menu = open(ctx);
    expect(menu.view(ctx).title).toContain("performance");
    const labels = menu.view(ctx).items.map((row) => row.label);
    for (const label of [
      "articulation",
      "glide (ms)",
      "glide mode",
      "bend",
      "vibrato",
      "sustain pedal",
      "velocity curve",
      "humanize timing (ms)",
    ])
      expect(labels.some((row) => row.startsWith(label))).toBe(true);
  });

  test("rows run the prompt commands", () => {
    const ctx = context(played);
    const menu = open(ctx);
    select(menu, ctx, "articulation");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "art staccato",
    });
    select(menu, ctx, "glide (ms)");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "glide 60ms",
    });
    select(menu, ctx, "glide mode");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "glide legato",
    });
    select(menu, ctx, "sustain pedal");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "pedal bars",
    });
    select(menu, ctx, "velocity curve");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "velcurve soft",
    });
    select(menu, ctx, "humanize timing");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "humanize 8 0 0",
    });
  });

  test("pedal and humanize rows stage for A/B while auditioning", () => {
    const ctx = context(played);
    const menu = open(ctx);
    for (const label of [
      "sustain pedal",
      "humanize timing",
      "velocity curve",
      "glide (ms)",
    ]) {
      select(menu, ctx, label);
      const action = menu.key(RIGHT, ctx) as { command?: string };
      expect(isStageable(action.command!)).toBe(true);
    }
    expect(isStageable("humanize reseed")).toBe(true);
  });

  test("soft pedal and sostenuto rows show on the modelled pianos", () => {
    const grand = updateTrack(played, "keys", { instrument: "grand" });
    const ctx = context(grand);
    const menu = open(ctx);
    select(menu, ctx, "soft pedal");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "pedal soft bars",
    });
    select(menu, ctx, "sostenuto");
    const action = menu.key(RIGHT, ctx) as { command?: string };
    expect(action.command).toBe("pedal sost bars");
    expect(isStageable(action.command!)).toBe(true);
    // Not on a synth piano unless a lane is already set.
    const plain = open(context(played));
    expect(
      plain
        .view(context(played))
        .items.some((row) => row.label.startsWith("soft pedal")),
    ).toBe(false);
  });

  test("set values show and x resets them", () => {
    const humanized = applyEdit(played, "humanize 10 5");
    const ctx = context(humanized);
    const menu = open(ctx);
    select(menu, ctx, "humanize timing");
    expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toContain(
      "±10 ms",
    );
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "humanize 11 5 0",
    });
    expect(menu.key("x", ctx)).toEqual({
      type: "run",
      command: "humanize off",
    });
    expect(
      menu.view(ctx).items.some((row) => row.label.startsWith("new take")),
    ).toBe(true);
  });
});

describe("auditioning in the menu", () => {
  const auditioning = (
    value: TrackScore,
    committed: TrackScore,
    dirty: boolean,
  ): MenuContext => ({
    ...context(value),
    audition: {
      looping: true,
      dirty,
      committed,
      hint: " space stop · a A/B · c context · enter keep · esc revert · ? keys ",
      status: dirty ? "♪ solo · B staged 1" : "♪ solo",
    },
  });

  test("Space, a and c reach the audition; a toggle row still switches on Space", () => {
    const menu = new EditMenu();
    const ctx = auditioning(score(), score(), false);
    menu.show(ctx, "mix");
    select(menu, ctx, "volume");
    expect(menu.key(" ", ctx)).toEqual({ type: "audition", key: "loop" });
    expect(menu.key("a", ctx)).toEqual({ type: "audition", key: "ab" });
    expect(menu.key("c", ctx)).toEqual({ type: "audition", key: "context" });
    // Nudges still run their command; the window decides to stage it.
    expect(menu.key("-", ctx)).toEqual({ type: "run", command: "volume 0.95" });
    select(menu, ctx, "mute");
    expect(menu.key(" ", ctx)).toEqual({ type: "run", command: "mute" });
    // Without an audition host the keys keep their old meaning.
    const plain = new EditMenu();
    plain.show(context(), "mix");
    expect(plain.key("a", context())).toEqual({ type: "handled" });
  });

  test("staged rows show staged ← committed; Enter keeps; Esc reverts first", () => {
    const committed = score();
    const staged = committed.withTracks(
      committed.tracks.map((track) =>
        track.id === "keys" ? { ...track, volume: 0.8 } : track,
      ),
    );
    const menu = new EditMenu();
    const ctx = auditioning(staged, committed, true);
    menu.show(ctx, "mix");
    select(menu, ctx, "volume");
    const view = menu.view(ctx);
    expect(view.items[view.index]!.label).toContain("0.8");
    expect(view.items[view.index]!.label).toContain(" ← 1");
    // Unchanged rows show one value.
    expect(
      view.items.find((row) => row.label.startsWith("pan"))!.label,
    ).not.toContain("←");
    expect(view.title).toStartWith("● ");
    expect(view.title).toContain("B staged 1");
    expect(view.hint).toContain("enter keep");
    expect(menu.key("\r", ctx)).toEqual({ type: "keep" });
    expect(menu.key(ESC, ctx)).toEqual({ type: "revert" });
    // Once reverted, Esc goes back as usual.
    const clean = auditioning(committed, committed, false);
    expect(menu.key(ESC, clean)).toEqual({ type: "handled" });
  });
});

describe("hovering lists in the menu", () => {
  const looping = (on: boolean): MenuContext => ({
    ...context(),
    audition: {
      looping: on,
      dirty: false,
      committed: score(),
      hint: "",
      status: on ? "♪ solo" : "",
    },
  });

  test("while looping, moving hears the row; Enter chooses; Esc and ← drop the hover", () => {
    const menu = new EditMenu();
    const ctx = looping(true);
    menu.show(ctx, "sound");
    select(menu, ctx, "instruments");
    expect(menu.key("\r", ctx)).toEqual({ type: "handled" });
    select(menu, ctx, "all instruments");
    expect(menu.key("\r", ctx)).toEqual({ type: "handled" });
    const moved = menu.key(DOWN, ctx);
    expect(moved).toEqual({
      type: "hover",
      command: expect.stringMatching(/^\/pack use gm\//),
      key: "menu:instruments",
    });
    expect(menu.key("\r", ctx)).toMatchObject({
      type: "choose",
      key: "menu:instruments",
    });
    menu.key(DOWN, ctx);
    expect(menu.key(ESC, ctx)).toEqual({
      type: "unhover",
      key: "menu:instruments",
    });
    // Back in "instruments"; ← from a hovered list drops it as well.
    select(menu, ctx, "all instruments");
    menu.key("\r", ctx);
    menu.key(DOWN, ctx);
    expect(menu.key(LEFT, ctx)).toEqual({
      type: "unhover",
      key: "menu:instruments",
    });
  });

  test("with the loop off, lists move and Enter runs as before", () => {
    const menu = new EditMenu();
    const ctx = looping(false);
    menu.show(ctx, "sound");
    select(menu, ctx, "instruments");
    menu.key("\r", ctx);
    select(menu, ctx, "all instruments");
    menu.key("\r", ctx);
    expect(menu.key(DOWN, ctx)).toEqual({ type: "handled" });
    expect(menu.key("\r", ctx)).toMatchObject({ type: "run" });
    // Non-sound rows (pack info) never hover.
    const on = looping(true);
    const browse = new EditMenu();
    browse.show(on, "sound");
    select(browse, on, "instruments");
    browse.key("\r", on);
    select(browse, on, "sample packs");
    browse.key("\r", on);
    expect(browse.key(DOWN, on)).toEqual({ type: "handled" });
  });
});

describe("edit commands", () => {
  test("parse names, meter, points and removal; reject bad input", () => {
    expect(parseEditCommand("track name Lead Line")).toEqual({
      type: "track-name",
      name: "Lead Line",
    });
    expect(parseEditCommand("meter 3")).toEqual({
      type: "meter",
      beatsPerBar: 3,
    });
    expect(parseEditCommand("meter 0")).toBeUndefined();
    expect(parseEditCommand("automate pan points 0:-1 4:1")).toEqual({
      type: "automation-points",
      parameter: "pan",
      points: [
        { beat: 0, value: -1 },
        { beat: 4, value: 1 },
      ],
    });
    expect(parseEditCommand("automate cutoff points 0:5")).toBeUndefined();
    expect(parseEditCommand("automate wobble points 0:1")).toBeUndefined();
    expect(parseEditCommand("automate volume remove 2")).toEqual({
      type: "automation-remove",
      parameter: "volume",
      beat: 2,
    });
    expect(parseEditCommand("name the track after my dog")).toBeUndefined();
  });

  test("each command is one operation on the focused track", () => {
    const base = score();
    const renamed = applyEditCommand(base, "keys", {
      type: "track-name",
      name: "Rhodes",
    });
    expect(renamed.next!.tracks[0]!.name).toBe("Rhodes");
    expect(renamed.kind).toBe("score.track");
    const meter = applyEditCommand(base, "keys", {
      type: "meter",
      beatsPerBar: 3,
    });
    expect(meter.next!.beatsPerBar).toBe(3);
    const missing = applyEditCommand(base, "keys", {
      type: "automation-remove",
      parameter: "volume",
      beat: 1,
    });
    expect(missing.ok).toBe(false);
  });
});

describe("key command", () => {
  test("key sets, normalises and clears the song key in one operation", () => {
    expect(parseEditCommand("key a minor")).toEqual({
      type: "key",
      key: "A minor",
    });
    expect(parseEditCommand("/key Bb dorian")).toEqual({
      type: "key",
      key: "Bb dorian",
    });
    expect(parseEditCommand("key none")).toEqual({ type: "key", key: null });
    expect(parseEditCommand("key H major")).toBeUndefined();
    const set = applyEditCommand(score(), "keys", parseEditCommand("key Am")!);
    expect(set.next!.key).toBe("A minor");
    expect(set.kind).toBe("score.key");
  });

  test("Sound › a sample voice fits with bpm, fitmode and len rows", () => {
    const menu = new EditMenu();
    const ctx: MenuContext = {
      ...context(
        createScore({
          tempoBpm: 128,
          bars: 2,
          tracks: [
            {
              id: "keys",
              instrument: "sampler",
              sampler: {
                mode: "oneshot",
                voices: { brk: { src: "tracks/keys/samples/brk.wav" } },
              },
            },
          ],
        }),
      ),
    };
    menu.show(ctx, "parameters");
    select(menu, ctx, "brk");
    menu.key("\r", ctx);
    expect(menu.view(ctx).title).toBe("≡ Sound › brk");
    select(menu, ctx, "bpm");
    // Off by default; the first step starts at the song's tempo.
    expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toContain("off");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "/bpm 128 brk",
    });
    expect(menu.key("x", ctx)).toEqual({
      type: "run",
      command: "/bpm off brk",
    });
    select(menu, ctx, "fitmode");
    // Unset shows off; the next choice is repitch.
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "/fitmode repitch brk",
    });
    select(menu, ctx, "len");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "/len 4 brk",
    });
    // 0.6.1 layers: Velocity layer steps through the common splits.
    select(menu, ctx, "velocity layer");
    expect(menu.key(RIGHT, ctx)).toEqual({
      type: "run",
      command: "/sample set brk vel 0-63",
    });
    select(menu, ctx, "round robin");
    expect(menu.view(ctx).items[menu.view(ctx).index]!.label).toContain(
      "round robin",
    );
    menu.key("\r", ctx);
    for (const ch of "sn") menu.key(ch, ctx);
    expect(menu.key("\r", ctx)).toEqual({
      type: "run",
      command: "/sample set brk rr sn",
    });
  });
});

describe("show me row", () => {
  test("Project › agent lists the show-me level and sets it with /showme", () => {
    const menu = new EditMenu();
    const ctx = { ...context(), showMe: "on" };
    menu.show(ctx, "agent");
    select(menu, ctx, "show me");
    const row = menu.view(ctx).items[menu.view(ctx).index]!;
    expect(row.label).toContain("on");
    const result = menu.key(RIGHT, ctx);
    expect(JSON.stringify(result)).toContain("/showme quiet");
  });

  test("no row when the window has no agent setting", () => {
    const menu = new EditMenu();
    const ctx = context();
    menu.show(ctx, "project");
    expect(
      menu.view(ctx).items.some((row) => row.label.startsWith("show me")),
    ).toBe(false);
  });
});
