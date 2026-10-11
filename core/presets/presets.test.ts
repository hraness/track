/**
 * The built-in preset catalog: every entry is well formed, and every
 * instrument and effect preset passes the quality limits over the standard
 * phrase (loudness at its category target, true-peak headroom, no DC or
 * non-finite samples, a tail that ends, mono compatibility, spectral
 * balance, aliasing, velocity response and cost). The renders run in
 * parallel shards of `scripts/preset-levels.ts`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validatePatch } from "../patch.ts";
import { SYNTH_KIT_NAMES } from "../kits.ts";
import { PRESET_CATEGORIES } from "./build.ts";
import { PRESET_LEVELS } from "./levels.ts";
import { PRESETS, PRESET_SPECS } from "./index.ts";

describe("preset catalog", () => {
  test("names are unique, short and kebab-case", () => {
    const names = PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(16);
  });

  test("every category has presets and an init preset exists per engine", () => {
    for (const c of PRESET_CATEGORIES)
      expect(PRESETS.some((p) => p.category === c)).toBe(true);
    const inits = PRESETS.filter((p) => p.category === "init");
    expect(inits.length).toBeGreaterThanOrEqual(7);
  });

  test("each preset has tags, a description, a feature and four knobs", () => {
    for (const p of PRESETS) {
      expect(p.tags.length).toBeGreaterThanOrEqual(2);
      expect(p.desc.length).toBeGreaterThan(8);
      expect(p.feature.length).toBeGreaterThan(5);
      if (p.kind === "kit") {
        expect(SYNTH_KIT_NAMES).toContain(p.kit!);
        continue;
      }
      expect(p.knobs).toHaveLength(4);
      for (const k of p.knobs) {
        expect(k.label).toMatch(/^[A-Z]/);
        expect(k.doc.length).toBeGreaterThan(2);
      }
      validatePatch(p.patch!, { label: p.name });
    }
  });

  test("every built preset has a generated level", () => {
    for (const s of PRESET_SPECS)
      expect(PRESET_LEVELS[s.name]).toBeGreaterThan(0);
  });
});

describe("preset quality", () => {
  test("every instrument and effect preset passes the limits", async () => {
    const shards = 8;
    const script = join(import.meta.dir, "../../scripts/preset-levels.ts");
    const runs = await Promise.all(
      Array.from({ length: shards }, async (_, i) => {
        const proc = Bun.spawn(
          ["bun", script, "--json", "--shard", `${i + 1}/${shards}`],
          { stdout: "pipe", stderr: "inherit" },
        );
        const text = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        return JSON.parse(text) as { name: string; problems: string[] }[];
      }),
    );
    const rows = runs.flat();
    expect(rows.length).toBe(PRESETS.filter((p) => p.patch).length);
    const bad = rows
      .filter((r) => r.problems.length > 0)
      .map((r) => `${r.name}: ${r.problems.join("; ")}`);
    expect(bad).toEqual([]);
  }, 600_000);
});
