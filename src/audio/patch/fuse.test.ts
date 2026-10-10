/**
 * Differential test for the fused voice block (fuse.ts): random patches
 * render the same bytes fused and through the reference interpreter.
 */
import { describe, expect, test } from "bun:test";
import { validatePatch } from "../../../core/patch.ts";
import { NODE_SPECS, type NodeSpec } from "../../../core/patch-nodes.ts";
import { compilePatch, type PatchProgram } from "./compile.ts";
import { lit } from "./fuse.ts";
import { runPatch, type PatchNote, type PatchRunOptions } from "./run.ts";

const SR = 22_050;
const PATCHES = 120;

const HAND = [
  "osc",
  "osc",
  "osc",
  "noise",
  "svf",
  "onepole",
  "adsr",
  "ar",
  "slew",
  "follow",
  "lfo",
  "lfo",
  "sh",
  "random",
  "const",
  "add",
  "mul",
  "min",
  "max",
  "gt",
  "lt",
  "abs",
  "not",
  "pitch2hz",
  "db2gain",
  "scale",
  "clamp",
  "clock",
  "vca",
  "mix",
  "xfade",
  "pan",
];
const LAST = ["vca", "pan", "svf", "mix", "osc", "xfade", "onepole"];
const VOICE_SOURCES = [
  "voice.pitch",
  "voice.gate",
  "voice.note",
  "voice.velocity",
  "voice.phase",
  "voice.random",
  "voice.index",
  "voice.age",
  "song.beat",
];

type Cable = { id: string; from: string; to: string; amount?: number };
type Case = { program: PatchProgram; options: PatchRunOptions };

/** A seeded random instrument patch with notes, tempo and macro lanes. */
function* cases(seed: number): Generator<Case> {
  let s = seed;
  const rnd = () => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) & 0x7fffffff;
    return s / 0x80000000;
  };
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const outs = (id: string, spec: NodeSpec) =>
    spec.outputs
      .filter((o) => o.kind !== "notes")
      .map((o) => `${id}.${o.name}`);
  for (let tries = 0; tries < PATCHES * 10; tries += 1) {
    const n = 3 + Math.floor(rnd() * 10);
    const nodes: {
      id: string;
      type: string;
      params: Record<string, unknown>;
    }[] = [];
    for (let i = 0; i < n; i += 1) {
      const type = i === n - 1 ? pick(LAST) : pick(HAND);
      const params: Record<string, unknown> = {};
      for (const [key, p] of Object.entries(NODE_SPECS[type]!.params)) {
        if (rnd() < 0.5) continue;
        if (p.kind === "enum") params[key] = pick(p.values);
        else if (p.kind === "number") {
          const lo = Math.max(p.min, -1000);
          const hi = Math.min(p.max, 2000);
          params[key] = +(
            lo +
            (hi - lo) * rnd() * (rnd() < 0.5 ? 0.1 : 1)
          ).toFixed(3);
        }
      }
      nodes.push({ id: `${type}${i}`, type, params });
    }
    const sources = [
      VOICE_SOURCES,
      ...nodes.map((nd) => outs(nd.id, NODE_SPECS[nd.type]!)),
    ];
    const cables: Cable[] = [];
    nodes.forEach((nd, i) => {
      for (const port of NODE_SPECS[nd.type]!.inputs) {
        if (rnd() < 0.45) continue;
        const k =
          rnd() < 0.08
            ? Math.floor(rnd() * (nodes.length + 1))
            : Math.floor(rnd() * (i + 1));
        const from = pick(sources[k]!.length > 0 ? sources[k]! : VOICE_SOURCES);
        if (from.startsWith(`${nd.id}.`)) continue;
        const cable: Cable = {
          id: `c${String(cables.length).padStart(3, "0")}`,
          from,
          to: `${nd.id}.${port.name}`,
        };
        if (
          port.kind === "control" &&
          rnd() < 0.5 &&
          !(port.name === "pitch" && from === "voice.pitch")
        )
          cable.amount = +(rnd() * 2 - 1).toFixed(3);
        cables.push(cable);
      }
    });
    const last = nodes[n - 1]!;
    cables.push({
      id: "z1",
      from: outs(last.id, NODE_SPECS[last.type]!)[0]!,
      to: "out.audio",
    });
    if (rnd() < 0.4) {
      const other = pick(nodes);
      cables.push({
        id: "z2",
        from: outs(other.id, NODE_SPECS[other.type]!).at(-1)!,
        to: "out.right",
      });
    }
    const controls = nodes.flatMap((nd) =>
      NODE_SPECS[nd.type]!.inputs.filter((p) => p.kind === "control").map(
        (p) => `${nd.id}.${p.name}`,
      ),
    );
    const macros =
      controls.length > 0 && rnd() < 0.5
        ? [
            {
              id: "m1",
              min: 0.1,
              max: 10,
              default: 1 + rnd() * 5,
              curve: rnd() < 0.5 ? "exp" : "lin",
              to: [{ port: pick(controls) }],
            },
          ]
        : [];
    let program: PatchProgram;
    try {
      program = compilePatch(
        validatePatch({
          kind: "patch",
          role: "instrument",
          name: `p${tries}`,
          voices: 1 + Math.floor(rnd() * 6),
          nodes,
          cables,
          macros,
        }),
      );
    } catch {
      continue; // an invalid random patch (a cycle, a bad range)
    }
    const frames = Math.floor(SR * 0.5) + Math.floor(rnd() * 100);
    const notes: PatchNote[] = Array.from(
      { length: 3 + Math.floor(rnd() * 6) },
      (_, i) => {
        const start = Math.floor(rnd() * frames * 0.7);
        return {
          seed: `n${i}:${start}`,
          start,
          end: start + Math.floor(rnd() * SR * 0.2) + 1,
          pitch: 55 * Math.pow(2, rnd() * 4),
          note: 40 + i,
          velocity: rnd(),
        };
      },
    );
    const blocks = Math.ceil(frames / 32);
    const tempo =
      rnd() < 0.5
        ? 100 + rnd() * 60
        : Float64Array.from({ length: blocks }, (_, b) => 90 + b * 0.05);
    const lane =
      macros.length > 0 && rnd() < 0.5
        ? [
            Float64Array.from(
              { length: blocks },
              (_, b) => 0.1 + (b % 300) / 30,
            ),
          ]
        : undefined;
    yield {
      program,
      options: {
        frames,
        sampleRate: SR,
        notes,
        tempo,
        beat0: rnd() * 4,
        seed: `g${tries}`,
        ...(lane ? { macros: lane } : {}),
      },
    };
  }
}

const bytes = (x: Float64Array | undefined) =>
  x ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : Buffer.alloc(0);

describe("fused voice block", () => {
  test(`${PATCHES} random patches render the same bytes fused and interpreted`, () => {
    let made = 0;
    for (const { program, options } of cases(12_345)) {
      const fused = runPatch(program, options);
      const plain = runPatch(program, { ...options, fuse: false });
      expect(bytes(fused.left).equals(bytes(plain.left))).toBe(true);
      expect(bytes(fused.right).equals(bytes(plain.right))).toBe(true);
      expect([fused.stolen, fused.scrubbed]).toEqual([
        plain.stolen,
        plain.scrubbed,
      ]);
      made += 1;
      if (made === PATCHES) break;
    }
    expect(made).toBe(PATCHES);
  }, 60_000);

  test("one program renders the same bytes fused and interpreted at each sample rate", () => {
    // The fused block embeds the rate and the constant controls, built
    // once per program and rate; a second rate must not reuse the first.
    let made = 0;
    for (const { program, options } of cases(777)) {
      for (const sampleRate of [48_000, 44_100, 48_000, 22_050]) {
        const o = { ...options, sampleRate };
        const fused = runPatch(program, o);
        const plain = runPatch(program, { ...o, fuse: false });
        expect(bytes(fused.left).equals(bytes(plain.left))).toBe(true);
        expect(bytes(fused.right).equals(bytes(plain.right))).toBe(true);
      }
      made += 1;
      if (made === 12) break;
    }
    expect(made).toBe(12);
  }, 60_000);

  test("literals round-trip every double the generated code embeds", () => {
    for (const x of [
      0,
      -0,
      1,
      -1,
      0.1,
      -1200,
      1e-300,
      5e-324,
      1.7976931348623157e308,
      Infinity,
      -Infinity,
      Math.PI / 3,
    ]) {
      const back = new Function(`return ${lit(x)};`)() as number;
      expect(Object.is(back, x)).toBe(true);
    }
    expect(Number.isNaN(new Function(`return ${lit(NaN)};`)() as number)).toBe(
      true,
    );
  });
});
