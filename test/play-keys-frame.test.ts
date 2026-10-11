/**
 * Play mode's on-screen keyboard in the real frame composer at 80×24, in
 * notes and drum modes, unicode and ASCII. The snapshots are the rows the
 * keyboard draws under the header, so a layout change shows up as a diff.
 */
import { describe, expect, test } from "bun:test";
import {
  drumKeyLabels,
  PlayKeyboard,
  stripCells,
} from "../src/tui/play-mode.ts";
import { TuiApp, type AppView } from "../tui/app.ts";
import type { TrackScoreSnapshot } from "../tui/highway.ts";
import type { PlayHeaderView } from "../tui/play-strip.ts";
import { VirtualTerminal } from "./vt.ts";

function score(drums: boolean): TrackScoreSnapshot {
  return {
    trackName: drums ? "drums" : "keys",
    trackId: drums ? "drums" : "keys",
    sessionId: "7f3a91c2-0000",
    revision: 1,
    bpm: 120,
    playing: false,
    loopBeats: 8,
    beatsPerBar: 4,
    notes: [],
  };
}

function playView(drums: boolean): PlayHeaderView {
  const keyboard = new PlayKeyboard({ base: drums ? 36 : 48 });
  // S and J held: a lit white key on the home row in either mode.
  keyboard.press("s", 0, 500);
  keyboard.press("j", 0, 500);
  const labels = drums ? drumKeyLabels(true) : new Map<number, string>();
  const keys = stripCells(keyboard, keyboard.litKeys(10), labels).map(
    (cell) => ({
      ...cell,
      label:
        drums || cell.root || cell.unmapped
          ? cell.label
          : cell.label.replace(/-?\d+$/, ""),
    }),
  );
  return {
    range: drums ? "drums" : keyboard.range,
    octave: keyboard.range,
    velocity: 100,
    armed: true,
    recording: false,
    replace: false,
    click: true,
    sustain: false,
    grid: "grid 1/16",
    keys,
    sounds: drums,
    countInBars: 1,
  };
}

function paint(drums: boolean, unicode: boolean, cols = 80, rows = 24) {
  const vt = new VirtualTerminal(cols, rows);
  const app = new TuiApp({
    io: {
      write: (data: string) => vt.write(data),
      columns: () => cols,
      rows: () => rows,
    },
    capabilities: { colorDepth: "none", unicode },
    clock: () => 10_000,
  });
  app.render(
    {
      score: score(drums),
      beat: 0,
      model: "sol-6.1",
      sync: "synced",
      play: playView(drums),
    } as AppView,
    { force: true },
  );
  return vt.lines();
}

describe("play keyboard frame at 80×24", () => {
  for (const drums of [false, true])
    for (const unicode of [true, false])
      test(`${drums ? "drums" : "notes"} · ${unicode ? "unicode" : "ascii"}`, () => {
        const lines = paint(drums, unicode);
        const keys = lines.slice(1, 6);
        expect(keys).toMatchSnapshot();
        const text = keys.join("\n");
        // Every note key's letter is on screen.
        for (const letter of "WETYUOPASDFGHJKL;'")
          expect(text).toContain(letter);
        if (drums) {
          for (const sound of [
            "kick",
            "snr",
            "chh",
            "ohh",
            "clap",
            "tom1",
            "tom6",
            "rim",
            "crsh",
            "ride",
          ])
            expect(text).toContain(sound);
          // Kick and snare sit on the home row, under the strongest fingers.
          expect(keys[3]).toMatch(/^ kick snr /);
          expect(keys[1]!.slice(0, 50)).not.toMatch(/C\d/);
        } else {
          expect(text).toContain("C3");
          expect(text).toContain("C4");
          expect(text).toContain("C#");
        }
        if (!unicode) expect(text).toMatch(/^[\x20-\x7e\n]*$/);
        // The roll keeps rows under the keyboard.
        expect(lines.length).toBe(24);
      });

  test("120 columns adds the control row, 60×16 keeps every key", () => {
    const wide = paint(false, true, 120, 30).join("\n");
    expect(wide).toContain("oct-");
    expect(wide).toContain("vel+");
    const small = paint(true, true, 60, 16).join("\n");
    for (const letter of "WETYUOPASDFGHJKL;'") expect(small).toContain(letter);
    expect(small).toContain("kick");
    expect(small).toContain("oct C2");
  });
});
