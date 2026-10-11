/**
 * The on-screen keyboard's layout as text, at the three sizes (120, 80 and
 * the 60×16 minimum), in notes and drum modes: keys in their QWERTY rows,
 * black keys over the gaps, every mapped key present, labels underneath.
 */
import { describe, expect, test } from "bun:test";
import {
  drumKeyLabels,
  PlayKeyboard,
  stripCells,
} from "../src/tui/play-mode.ts";
import {
  playKeysForm,
  playKeysLayout,
  playKeysRows,
  type PlayKeysLayout,
  type PlayKeysView,
} from "./play-keys.ts";

function view(drums: boolean, lit: string[] = []): PlayKeysView {
  const keyboard = new PlayKeyboard({ base: drums ? 36 : 48 });
  for (const key of lit) keyboard.press(key, 0, 500);
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
    keys,
    sounds: drums,
    octave: keyboard.range,
    velocity: 100,
    click: false,
    countInBars: 1,
    armed: false,
    recording: false,
    replace: false,
  };
}

/** The layout's rows as text. */
function text(layout: PlayKeysLayout, width: number): string[] {
  const rows = Array.from({ length: layout.rows }, () =>
    Array.from({ length: width }, () => " "),
  );
  for (const span of layout.spans)
    [...span.text].forEach((ch, index) => {
      const row = rows[span.row]!;
      if (span.x + index < width) row[span.x + index] = ch;
    });
  return rows.map((row) => row.join("").trimEnd());
}

/** Column of a key cap's letter. */
function capX(layout: PlayKeysLayout, key: string): number {
  return layout.spans.find(
    (span) => span.kind === "letter" && span.key?.key === key,
  )!.x;
}

const SIZES = [
  [120, 40, "full"],
  [80, 24, "compact"],
  [60, 16, "minimal"],
] as const;

describe("play keys layout", () => {
  for (const [width, height, form] of SIZES)
    for (const drums of [false, true])
      test(`${width}×${height} ${drums ? "drums" : "notes"} is ${form}`, () => {
        expect(playKeysForm(width, height)).toBe(form);
        const layout = playKeysLayout(view(drums), width, height);
        expect(layout.form).toBe(form);
        const lines = text(layout, width);
        // Every note key is a cap of its own, inside the width.
        for (const line of lines)
          expect(line.length).toBeLessThanOrEqual(width);
        const letters = layout.spans
          .filter((span) => span.kind === "letter" && span.key)
          .map((span) => span.key!.key);
        expect(letters.sort()).toEqual([..."awsedftgyhujkolp;'"].sort());
        // Black keys sit over the gap between their white neighbours.
        for (const [black, left, right] of [
          ["w", "a", "s"],
          ["e", "s", "d"],
          ["t", "f", "g"],
          ["u", "h", "j"],
          ["p", "l", ";"],
        ] as const) {
          const x = capX(layout, black);
          expect(x).toBeGreaterThan(capX(layout, left));
          expect(x).toBeLessThan(capX(layout, right));
        }
        // No black key over E–F or B–C: the R and I gaps stay empty.
        const upper = layout.spans
          .filter((span) => span.kind === "letter" && span.key?.black)
          .map((span) => span.x)
          .sort((a, b) => a - b);
        expect(upper[2]! - upper[1]!).toBeGreaterThan(layout.cell);
        // Labels go directly under their key letter.
        const s = layout.spans.find(
          (span) => span.kind === "label" && span.key?.key === "s",
        )!;
        expect(s.x).toBe(capX(layout, "s"));
        const joined = lines.join("\n");
        if (drums) {
          expect(joined).toMatch(/^ kick +snr +snr +tom1 /m);
          for (const sound of ["rim", "clap", "chh", "ohh", "crsh", "ride"])
            expect(joined).toContain(sound);
          // No note names under the drum keys.
          for (const span of layout.spans)
            if (span.kind === "label") expect(span.text).not.toMatch(/^C\d/);
        } else {
          expect(joined).toMatch(
            /^ C3 +D +E +F +G +A +B +C4 +D +E +F(?: {2}|$)/m,
          );
          expect(joined).toMatch(/C# +D# +F# +G# +A# +C# +D#/);
        }
        // The panel: octave, velocity, click, record and count-in.
        for (const word of [
          "oct C",
          "vel 100",
          "click off",
          "rec off",
          "count-in 1 bar",
        ])
          expect(joined).toContain(word);
        // Full form adds the bottom row as control keys.
        if (form === "full") {
          expect(joined).toMatch(/oct- +oct\+ +vel- +vel\+ +click/);
          expect(layout.rows).toBe(6);
        } else expect(joined).not.toContain("oct-");
        if (form === "compact") expect(layout.rows).toBe(5);
        expect(playKeysRows(view(drums), width, height)).toBe(layout.rows);
      });

  test("held keys are marked as well as reversed", () => {
    const layout = playKeysLayout(view(false, ["s"]), 80, 24);
    expect(text(layout, 80)[2]).toMatch(/^ A {4}S• {3}D /);
    const ascii = playKeysLayout(view(false, ["s"]), 80, 24, false);
    expect(text(ascii, 80)[2]).toMatch(/^ A {4}S\* {3}D /);
    const s = layout.spans.find(
      (span) => span.kind === "letter" && span.key?.key === "s",
    )!;
    expect(s.key?.lit).toBe(true);
  });

  test("record and count-in state read without color", () => {
    const base = view(false);
    const rec = (over: Partial<PlayKeysView>, unicode = true) =>
      text(playKeysLayout({ ...base, ...over }, 80, 24, unicode), 80).join(
        "\n",
      );
    expect(rec({ armed: true })).toContain("● rec armed");
    expect(rec({ armed: true }, false)).toContain("* rec armed");
    expect(rec({ armed: true, recording: true })).toContain("● REC");
    expect(rec({ armed: true, recording: true, replace: true })).toContain(
      "REC replace",
    );
    expect(rec({ countIn: "count-in 3" })).toContain("count-in 3");
    expect(rec({ countInBars: 0 })).toContain("no count-in");
  });

  test("unmapped keys print a dot, ASCII a period", () => {
    const keyboard = new PlayKeyboard({ base: 36 });
    // Kit without calibration: O P ; ' play only the fallback click.
    const keys = stripCells(keyboard, new Set(), drumKeyLabels(false));
    const v = { ...view(true), keys };
    expect(text(playKeysLayout(v, 80, 24), 80)[1]).toMatch(/ohh +· +· /);
    expect(text(playKeysLayout(v, 80, 24, false), 80)[1]).toMatch(
      /ohh +\. +\. /,
    );
    expect(
      keys
        .filter((key) => key.unmapped)
        .map((key) => key.key)
        .sort(),
    ).toEqual(["'", ";", "o", "p"]);
  });
});
