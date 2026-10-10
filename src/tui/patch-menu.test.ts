/**
 * The ctrl-k patch rows (patcher design §7.4) as a table: every row under
 * Sound › patch and Effects › "<name> patch", and the typed command it runs.
 */
import { describe, expect, test } from "bun:test";
import { builtinPatch } from "../../core/patches/index.ts";
import { createScore, type TrackScore } from "../../core/score.ts";
import type { MenuContext, MenuNode } from "./menu.ts";
import { effectPatchMenuNodes, patchMenuNode } from "./patch-menu.ts";

function song(track: Record<string, unknown>): TrackScore {
  return createScore({
    tempoBpm: 120,
    bars: 2,
    tracks: [{ id: "t", name: "t", ...track }],
    notes: [],
  } as Parameters<typeof createScore>[0]);
}

function context(score: TrackScore): MenuContext {
  return {
    score,
    trackId: "t",
    playing: false,
    grid: "1/16",
    grids: ["1/16"],
    clickOn: false,
    countInBars: 1,
  };
}

/** `path · command` for every row, menus walked depth first. */
function table(ctx: MenuContext, nodes: MenuNode[], path = ""): string[] {
  const rows: string[] = [];
  for (const node of nodes) {
    const here = path ? `${path} › ${node.label}` : node.label;
    if (node.kind === "menu") rows.push(...table(ctx, node.build(ctx), here));
    else if (node.kind === "action") rows.push(`${here} · ${node.command}`);
    else if (node.kind === "number" && node.value !== undefined)
      rows.push(`${here} · ${node.command(node.value)}`);
    else if (node.kind === "choice")
      rows.push(`${here} · ${node.command(node.value)}`);
    else if (node.kind === "toggle")
      rows.push(`${here} · ${node.command(!node.value)}`);
    else rows.push(`${here} · (${node.kind})`);
  }
  return rows;
}

describe("ctrl-k patch rows", () => {
  test("a patch track: edit, four knobs, every node's settings", () => {
    const score = song({
      instrument: "patch",
      patch: builtinPatch("acid-bass"),
    });
    const ctx = context(score);
    const rows = table(ctx, [patchMenuNode(ctx)]);
    expect(rows[0]).toBe("patch › Edit patch · /patch");
    const knobs = rows.filter((row) => row.startsWith("patch › knobs › "));
    expect(knobs).toHaveLength(4);
    for (const row of knobs) expect(row).toMatch(/ · patch knob \S+ [\d.-]+$/);
    const nodes = rows.filter((row) => row.startsWith("patch › nodes › "));
    expect(nodes.length).toBeGreaterThan(0);
    for (const row of nodes) expect(row).toMatch(/ · patch set \S+ \S+=\S+$/);
    // Then the typed-entry rows (lane 5): new, load, add node, wire, …
    expect(rows).toContain("patch › show as text · patch show");
  });

  test("a track that is not a patch offers the preview and new/convert", () => {
    const score = song({ instrument: "bass" });
    const ctx = context(score);
    const rows = table(ctx, [patchMenuNode(ctx)]);
    expect(rows[0]).toBe("patch › Edit patch · /patch");
    expect(rows).toContain("patch › convert to patch · patch convert");
    expect(rows.some((row) => row.includes("knobs"))).toBe(false);
  });

  test("an effect patch aims every row with --fx", () => {
    const fx = builtinPatch("wide-crush")!;
    const score = song({ instrument: "bass", fxPatch: [fx] });
    const ctx = context(score);
    const rows = table(ctx, effectPatchMenuNodes(ctx, score.tracks[0]));
    expect(rows[0]).toBe(
      `${fx.name} patch › Edit effect patch · /patch --fx ${fx.name}`,
    );
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) expect(row).toEndWith(` --fx ${fx.name}`);
  });
});
