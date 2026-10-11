/**
 * The shared key grammar (design §5, §8.4): one module owns the key sets,
 * and each `?` panel lists a key once per screen.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayWidth } from "./text.ts";
import {
  KEYS,
  KEY_BACK,
  KEY_BACKTAB,
  KEY_DOWN,
  KEY_ENTER,
  KEY_LEFT,
  KEY_RESET,
  KEY_RIGHT,
  KEY_TAB,
  KEY_UP,
  keyLines,
} from "./grammar.ts";

const ROOT = join(import.meta.dir, "..");

/** Files that read keys; they import the sets instead of spelling them. */
const READERS = [
  "src/tui/menu.ts",
  "src/tui/fader.ts",
  "src/tui/euclid.ts",
  "src/tui/audition.ts",
  "src/main.ts",
];

/** Single keys a `?` row names: `↑ ↓  j k` → ↑, ↓, j, k. */
function keysOf(label: string): string[] {
  return label
    .replace(/\s+or\s+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

describe("key sets", () => {
  test("arrows, vim letters, tab and back-tab", () => {
    expect(KEY_UP.has("\u001b[A") && KEY_UP.has("k")).toBe(true);
    expect(KEY_DOWN.has("\u001b[B") && KEY_DOWN.has("j")).toBe(true);
    expect(KEY_LEFT.has("h") && KEY_RIGHT.has("l")).toBe(true);
    expect(KEY_BACK.has("h") && !KEY_BACK.has("-")).toBe(true);
    expect(KEY_TAB.has("\t")).toBe(true);
    expect(KEY_BACKTAB.has("\u001b[Z")).toBe(true);
    expect(KEY_ENTER.has("\r") && KEY_ENTER.has("\n")).toBe(true);
    expect([...KEY_RESET]).toEqual(["x", "d", "\u001b[3~"]);
  });

  test("no reader redefines a key set or spells a cursor key", () => {
    const local: string[] = [];
    for (const file of READERS) {
      const text = readFileSync(join(ROOT, file), "utf8");
      text.split("\n").forEach((line, index) => {
        if (/^\s*(?:\/\/|\*)/.test(line)) return;
        if (/\bconst KEY_[A-Z_]+\s*=/.test(line))
          local.push(`${file}:${index + 1}`);
        if (/\\u001b(?:\[[ABCDHFZ]|O[ABCDHF]|\[[3456]~)/.test(line))
          local.push(`${file}:${index + 1}`);
      });
    }
    expect(local).toEqual([]);
  });
});

describe("? panels", () => {
  for (const [screen, sections] of Object.entries(KEYS)) {
    test(`${screen}: each key once`, () => {
      const seen = new Map<string, string>();
      const twice: string[] = [];
      for (const section of sections) {
        // Mouse gestures are not keys.
        if (section.title === "mouse") continue;
        for (const [label] of section.rows)
          for (const key of keysOf(label)) {
            if (seen.has(key))
              twice.push(`${key}: ${seen.get(key)} | ${label}`);
            else seen.set(key, label);
          }
      }
      expect(twice).toEqual([]);
    });
  }

  test("enter opens or confirms on every list screen", () => {
    for (const screen of [
      "menu",
      "audition",
      "presets",
      "preview",
      "fader",
    ] as const) {
      const enter = KEYS[screen]
        .flatMap((section) => section.rows)
        .find(([label]) => keysOf(label).includes("enter"));
      expect(enter?.[1]).toMatch(/open|keep|apply|choose|set/);
    }
  });

  test("play-mode tab is the one documented exception", () => {
    const tabs = Object.entries(KEYS).flatMap(([screen, sections]) =>
      sections.flatMap((section) =>
        section.rows
          .filter(([label]) => keysOf(label).includes("tab"))
          .map(([, action]) => `${screen}: ${action}`),
      ),
    );
    for (const row of tabs)
      if (!row.startsWith("play:")) expect(row).toMatch(/next/);
    expect(tabs.find((row) => row.startsWith("play:"))).toContain(
      "play mode only",
    );
  });

  test("every ? panel row fits an 80-column terminal", () => {
    // The panel's inner width at 80 columns (main.ts: columns - 8).
    for (const [screen, sections] of Object.entries(KEYS))
      for (const line of keyLines(sections))
        expect(`${screen}: ${displayWidth(line) <= 72 ? "fits" : line}`).toBe(
          `${screen}: fits`,
        );
    expect(keyLines(KEYS.prompt).join("\n")).toMatch(
      /ctrl-k\s+menu: 8 sections/,
    );
  });

  test("ctrl-q says what it switches; euclid says knob", () => {
    const lines = keyLines(KEYS.prompt).join("\n");
    expect(lines).toContain("switch now/next");
    expect(keyLines(KEYS.euclid).join("\n")).toMatch(
      /↑ ↓ {2}j k\s+knob: ● drum/,
    );
  });
});
