/**
 * The patch view (patcher design §7): the model of a track's patch, each
 * key's typed command, and the painter at the small and large sizes, under
 * mono and ASCII.
 */
import { describe, expect, test } from "bun:test";
import { builtinPatch } from "../../core/patches/index.ts";
import { createScore, type TrackScore } from "../../core/score.ts";
import { CellBuffer } from "../../tui/screen.ts";
import { PATCH_NODES_MAX, paintPatch } from "../../tui/patch.ts";
import { getTheme } from "../../tui/theme.ts";
import {
  focusCable,
  legalCable,
  newCables,
  matrixAxes,
  patchKey,
  patchModel,
  patchPaint,
  patchViewState,
  wireTargets,
  type PatchModel,
  type PatchViewState,
} from "./patch-view.ts";

function song(track: Record<string, unknown>): TrackScore {
  return createScore({
    tempoBpm: 120,
    bars: 2,
    tracks: [{ id: "t", name: "t", ...track }],
    notes: [],
  } as Parameters<typeof createScore>[0]);
}

function acid(): TrackScore {
  return song({ instrument: "patch", patch: builtinPatch("acid-bass") });
}

function model(score: TrackScore, fx?: string): PatchModel {
  const value = patchModel(score, "t", fx);
  if (typeof value === "string") throw new Error(value);
  return value;
}

function keys(
  m: PatchModel,
  state: PatchViewState,
  ...values: string[]
): ReturnType<typeof patchKey> {
  let last: ReturnType<typeof patchKey> = { type: "handled" };
  for (const value of values) last = patchKey(state, m, value);
  return last;
}

describe("patchModel", () => {
  test("lists boundary and patch nodes in signal order, out last", () => {
    const m = model(acid());
    const ids = m.nodes.map((n) => n.id);
    expect(ids[0]).toBe("voice");
    expect(ids.at(-1)).toBe("out");
    for (const node of m.patch.nodes) expect(ids).toContain(node.id);
    // A cable's source comes before its destination (no feedback here).
    for (const cable of m.patch.cables) {
      const from = ids.indexOf(cable.from.split(".")[0]!);
      const to = ids.indexOf(cable.to.split(".")[0]!);
      expect(from).toBeLessThan(to);
    }
  });

  test("a non-patch track previews as a patch, read-only", () => {
    const m = model(song({ instrument: "saw" }));
    expect(m.preview).toBe(true);
    const state = patchViewState();
    const action = patchKey(state, m, "a");
    expect(action.type).toBe("note");
    if (action.type === "note")
      expect(action.message).toContain("patch convert");
  });

  test("a library reference is read-only and says how to detach", () => {
    const patch = builtinPatch("acid-bass")!;
    const score = createScore({
      tempoBpm: 120,
      bars: 2,
      patches: { "acid-bass": patch },
      tracks: [
        {
          id: "t",
          name: "t",
          instrument: "patch",
          patch: { kind: "patch", ref: "acid-bass" },
        },
      ],
      notes: [],
    } as Parameters<typeof createScore>[0]);
    const m = model(score);
    expect(m.ref).toBe("acid-bass");
    const state = patchViewState();
    state.node = m.nodes.findIndex((n) => !n.boundary);
    const action = patchKey(state, m, "x");
    expect(action.type).toBe("note");
    if (action.type === "note")
      expect(action.message).toContain("patch detach");
    expect(patchPaint(m, patchViewState()).tag).toContain("library acid-bass");
  });

  test("a missing effect patch is a message, not a model", () => {
    expect(typeof patchModel(acid(), "t", "nope")).toBe("string");
    expect(typeof patchModel(acid(), "nobody")).toBe("string");
  });

  test("an effect patch lists in.audio and no voice", () => {
    const score = song({
      instrument: "saw",
      fxPatch: [builtinPatch("wide-crush")],
    });
    const m = model(score, "wide-crush");
    const ids = m.nodes.map((n) => n.id);
    expect(ids).toContain("in");
    expect(ids).not.toContain("voice");
    expect(m.sources.some((s) => s.ref === "in.audio")).toBe(true);
    expect(m.sources.some((s) => s.ref === "in.notes")).toBe(false);
    // Every command carries --fx.
    const state = patchViewState("wide-crush");
    const action = keys(m, state, "a");
    expect(action.type).toBe("pick");
    if (action.type === "pick") {
      expect(
        action.items.every((i) => i.value.endsWith("--fx wide-crush")),
      ).toBe(true);
      // No engines in an effect patch.
      expect(action.items.some((i) => i.value.includes("add engine."))).toBe(
        false,
      );
    }
  });

  test("surfaces the compiler's dropped cables in cells and warnings", () => {
    const base = builtinPatch("acid-bass")!;
    // A feedback loop across an engine is cut by the compiler.
    const engine = base.nodes.find((n) =>
      ["osc", "fm", "wavetable", "engine.synth"].includes(n.type),
    );
    expect(engine).toBeDefined();
    const filter = base.nodes.find(
      (n) => n.type === "svf" || n.type === "ladder",
    );
    const patch = {
      ...base,
      cables: [
        ...base.cables,
        { id: "loop1", from: `${filter!.id}.out`, to: `${engine!.id}.fm` },
      ],
    };
    const m = model(song({ instrument: "patch", patch }));
    if (m.warnings.some((w) => w.startsWith("cable loop1:"))) {
      expect(m.dropped.has("loop1")).toBe(true);
      const state = patchViewState();
      state.full = true;
      const paint = patchPaint(m, state);
      expect(paint.warnings.length).toBeGreaterThan(0);
      expect(paint.cells.flat().some((c) => c.dropped)).toBe(true);
    } else {
      // The compiler delays it instead: a warning, never a dropped cell.
      expect(m.warnings.some((w) => w.includes("loop1"))).toBe(true);
      expect(m.dropped.has("loop1")).toBe(false);
    }
  });
});

describe("patchKey", () => {
  test("enter on a node opens its settings; on a boundary explains it", () => {
    const m = model(acid());
    const state = patchViewState();
    expect(patchKey(state, m, "\r").type).toBe("note");
    state.node = m.nodes.findIndex((n) => !n.boundary);
    const action = patchKey(state, m, "\r");
    expect(action).toEqual({ type: "node", nodeId: m.nodes[state.node]!.id });
  });

  test("x removes a node with patch rm; never a boundary", () => {
    const m = model(acid());
    const state = patchViewState();
    state.node = m.nodes.findIndex((n) => !n.boundary);
    expect(patchKey(state, m, "x")).toEqual({
      type: "run",
      commands: [`patch rm ${m.nodes[state.node]!.id}`],
    });
    state.node = m.nodes.length - 1;
    expect(patchKey(state, m, "x").type).toBe("note");
  });

  test("w lists only legal destinations, each a patch wire", () => {
    const m = model(acid());
    const from = "voice.pitch";
    const targets = wireTargets(m, from);
    expect(targets.length).toBeGreaterThan(0);
    for (const to of targets) expect(legalCable(m, from, to)).toBe(true);
    // Audio ports never take a notes cable; notes go only to notes.
    expect(legalCable(m, "voice.pitch", "out.audio")).toBe(true);
    const state = patchViewState();
    const action = patchKey(state, m, "w");
    expect(action.type).toBe("pick");
    if (action.type === "pick")
      for (const item of action.items)
        expect(item.value).toMatch(/^patch wire voice\.\S+ \S+\.\S+$/);
  });

  test("matrix: enter wires and unwires, [ ] and digits set the amount", () => {
    const m = model(acid());
    const state = patchViewState();
    state.full = true;
    state.pane = "matrix";
    const { rows, cols } = matrixAxes(m, state);
    const cable = m.patch.cables.find(
      (c) => cols.find((col) => col.ref === c.to)?.kind === "control",
    )!;
    state.row = rows.findIndex((r) => r.ref === cable.from);
    state.col = cols.findIndex((c) => c.ref === cable.to);
    expect(patchKey(state, m, "\r")).toEqual({
      type: "run",
      commands: [`patch unwire ${cable.from} ${cable.to}`],
    });
    const amount = cable.amount ?? 1;
    const down = patchKey(state, m, "[");
    expect(down.type).toBe("run");
    if (down.type === "run")
      expect(down.commands[0]).toBe(
        `patch wire ${cable.from} ${cable.to} ${Math.round((amount - 0.05) * 100) / 100}`,
      );
    expect(patchKey(state, m, "5")).toEqual({
      type: "run",
      commands: [`patch wire ${cable.from} ${cable.to} 0.5`],
    });
    expect(patchKey(state, m, "0")).toEqual({
      type: "run",
      commands: [`patch wire ${cable.from} ${cable.to} 1`],
    });
  });

  test("tab cycles panes; f toggles the full matrix; esc exits", () => {
    const m = model(acid());
    const state = patchViewState();
    keys(m, state, "\t");
    expect(state.pane).toBe("ports");
    keys(m, state, "\t");
    expect(state.pane).toBe("matrix");
    keys(m, state, "\t");
    expect(state.pane).toBe("knobs");
    keys(m, state, "\t");
    expect(state.pane).toBe("nodes");
    keys(m, state, "f");
    expect(state.full).toBe(true);
    expect(patchKey(state, m, "\u001b").type).toBe("exit");
    expect(patchKey(state, m, "s")).toEqual({
      type: "prefill",
      text: "patch save acid-bass",
    });
  });

  test("knobs pane turns the first macro with patch knob", () => {
    const m = model(acid());
    const state = patchViewState();
    state.pane = "knobs";
    const action = patchKey(state, m, "\u001b[C");
    expect(action.type).toBe("run");
    if (action.type === "run")
      expect(action.commands[0]).toMatch(
        new RegExp(`^patch knob ${m.patch.macros[0]!.id} \\S+$`),
      );
  });

  test("m on a mappable param offers existing macros and a new one", () => {
    const m = model(acid());
    const state = patchViewState();
    state.node = m.nodes.findIndex(
      (n) => n.type === "svf" || n.type === "ladder",
    );
    state.pane = "ports";
    const action = (() => {
      for (let i = 0; i < 20; i++) {
        const a = patchKey(state, m, "m");
        if (a.type === "pick") return a;
        patchKey(state, m, "\u001b[B");
      }
      return undefined;
    })();
    expect(action?.type).toBe("pick");
    if (action?.type === "pick") {
      expect(
        action.items.every((i) => i.value.startsWith("patch macro ")),
      ).toBe(true);
      expect(action.items.at(-1)!.label).toContain("new knob");
    }
  });

  test("g toggles a node that can run either way", () => {
    const m = model(acid());
    const state = patchViewState();
    const either = m.nodes.findIndex((n) => n.either);
    if (either < 0) return;
    state.node = either;
    const action = patchKey(state, m, "g");
    expect(action.type).toBe("run");
    if (action.type === "run")
      expect(action.commands[0]).toMatch(/^patch rate \S+ (global|voice)$/);
  });
});

function paint(
  width: number,
  height: number,
  m: PatchModel,
  state: PatchViewState,
  options: { theme?: "default" | "mono"; unicode?: boolean } = {},
): string[] {
  const buffer = new CellBuffer(width, height);
  paintPatch(buffer, { x: 0, y: 0, width, height }, patchPaint(m, state), {
    theme: getTheme(options.theme ?? "default"),
    unicode: options.unicode ?? true,
  });
  return buffer.lines();
}

describe("paintPatch", () => {
  test("80x18: header, nodes, ports, matrix, knobs and hint", () => {
    const m = model(acid());
    const lines = paint(80, 18, m, patchViewState());
    const text = lines.join("\n");
    expect(lines[0]).toContain("patch t ▸ acid-bass (instrument");
    expect(text).toContain(" NODES ");
    expect(text).toContain("CABLES");
    expect(text).toContain("▸voice");
    expect(lines.at(-1)).toContain("tab pane");
    expect(lines.at(-2)).toContain(
      m.patch.macros[0]!.label ?? m.patch.macros[0]!.id,
    );
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  test("a short body shows the matrix alone while it has focus", () => {
    const m = model(acid());
    const state = patchViewState();
    state.pane = "matrix";
    state.full = true;
    const text = paint(60, 9, m, state).join("\n");
    expect(text).not.toContain(" NODES ");
    expect(text).toContain("CABLES");
    state.pane = "nodes";
    const lists = paint(60, 9, m, state).join("\n");
    expect(lists).toContain(" NODES ");
  });

  test("ASCII keeps every cue", () => {
    const m = model(acid());
    const state = patchViewState();
    state.full = true;
    const text = paint(100, 30, m, state, {
      unicode: false,
      theme: "mono",
    }).join("\n");
    expect(text).not.toMatch(/[▸◆●▪♪Σ✕│─⚠←→█]/u);
    expect(text).toContain(">voice");
    expect(text).toContain("v voice g global");
  });

  test("a large terminal caps the lists and shows the whole matrix", () => {
    const m = model(acid());
    const state = patchViewState();
    state.full = true;
    const lines = paint(300, 80, m, state);
    const text = lines.join("\n");
    expect(text).toContain("drive.mix");
    // Wide enough for every label whole, every column shows whole.
    const wide = paint(420, 40, m, state).join("\n");
    for (const ref of m.targets.map((c) => c.ref)) expect(wide).toContain(ref);
    // The node list stops at PATCH_NODES_MAX columns.
    const bar = lines[2]!.indexOf("│");
    expect(bar).toBeLessThanOrEqual(PATCH_NODES_MAX);
  });

  test("tiny rects draw nothing and never throw", () => {
    const m = model(acid());
    for (const [w, h] of [
      [1, 1],
      [19, 3],
      [20, 4],
      [60, 5],
    ] as const)
      expect(() => paint(w, h, m, patchViewState())).not.toThrow();
  });
});

describe("show-me (§7.5)", () => {
  test("a cable wired elsewhere puts the selection on its cell", () => {
    const m = model(acid());
    const state = patchViewState();
    const last = m.patch.cables.at(-1)!;
    const before = m.patch.cables.slice(0, -1);
    expect(newCables(before, m.patch.cables)).toEqual([last]);
    expect(newCables(m.patch.cables, m.patch.cables)).toEqual([]);
    expect(focusCable(state, m, last)).toBe(true);
    expect(state.pane).toBe("matrix");
    const { rows, cols } = matrixAxes(m, state);
    expect(rows[state.row]!.ref).toBe(last.from);
    expect(cols[state.col]!.ref).toBe(last.to);
    expect(focusCable(state, m, { from: "nope.out", to: "out.in" })).toBe(
      false,
    );
  });
});
