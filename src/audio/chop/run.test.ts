import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemRunner, type CommandRunner } from "../../auth/runner.ts";
import { encodeWav24, makePcm, type Pcm } from "./pcm.ts";
import { resolveOutput, runChop } from "./run.ts";
import type { ChopContext, ChopHistory } from "./types.ts";

const SR = 44_100;

/** Four 0.25 s decaying 220 Hz hits separated by 0.25 s of silence. */
function hits(): Pcm {
  const pcm = makePcm(SR, 2, SR * 2);
  for (let h = 0; h < 4; h += 1) {
    const start = h * SR * 0.5;
    for (let i = 0; i < SR * 0.25; i += 1) {
      const v =
        Math.sin((2 * Math.PI * 220 * i) / SR) *
        Math.exp(-i / (SR * 0.05)) *
        0.8;
      pcm.channels[0]![start + i] = v;
      pcm.channels[1]![start + i] = v * 0.5;
    }
  }
  return pcm;
}

const noTools: CommandRunner = {
  which: () => undefined,
  run: async () => {
    throw new Error("no external tools in this test");
  },
};

let root: string;
let ctx: ChopContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dawg-chop-"));
  await writeFile(join(root, "loop.wav"), encodeWav24(hits()));
  ctx = { root, runner: noTools, signal: new AbortController().signal };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runChop", () => {
  test("info reports length, rate, channels and levels", async () => {
    const result = await runChop("info", { input: "loop.wav" }, ctx);
    expect(result.info).toMatchObject({
      path: "loop.wav",
      seconds: 2,
      sampleRate: SR,
      channels: 2,
    });
    expect(result.outputs).toHaveLength(0);
  });

  test("segments by silence find the four hits", async () => {
    const result = await runChop(
      "segments",
      { input: "loop.wav", method: "silence" },
      ctx,
    );
    expect(result.points).toHaveLength(4);
    expect(result.points![1]!.t).toBeCloseTo(0.5, 1);
  });

  test("onsets land on each hit", async () => {
    const result = await runChop("onsets", { input: "loop.wav" }, ctx);
    const times = result.points!.map((p) => p.t);
    for (const expected of [0.5, 1, 1.5])
      expect(times.some((t) => Math.abs(t - expected) < 0.03)).toBe(true);
  });

  test("cut snaps to a zero crossing and writes a sidecar", async () => {
    const result = await runChop(
      "cut",
      { input: "loop.wav", from: 0.5013, to: "1s" },
      ctx,
    );
    const out = result.outputs[0]!;
    expect(out.path).toBe("samples/loop-cut.wav");
    expect(out.from).toBeGreaterThanOrEqual(0.496);
    expect(out.from).toBeLessThanOrEqual(0.507);
    const sidecar = JSON.parse(
      await readFile(join(root, "samples/loop-cut.chop.json"), "utf8"),
    );
    expect(sidecar.op).toBe("cut");
    expect(sidecar.inputs[0].path).toBe("loop.wav");
  });

  test("the same op twice produces byte-identical audio (deterministic)", async () => {
    const cases = [
      ["cut", { from: 0.2, to: 1.3 }],
      ["slice", { method: "silence" }],
      ["stretch", { ratio: 1.5 }],
      ["pitch", { semitones: 3 }],
      ["fade", { fadeIn: 0.1, fadeOut: 0.3, curve: "scurve" }],
      ["normalize", { targetDb: -3 }],
      ["reverse", {}],
      ["loop", { from: 0, to: 1, crossfadeMs: 20 }],
    ] as const;
    for (const [op, args] of cases) {
      const a = await runChop(op, { input: "loop.wav", ...args }, ctx);
      const b = await runChop(op, { input: "loop.wav", ...args }, ctx);
      expect(a.outputs.map((o) => o.sha256)).toEqual(
        b.outputs.map((o) => o.sha256),
      );
      expect(a.outputs[0]!.path).not.toBe(b.outputs[0]!.path);
    }
  });

  test("slice writes one file per hit", async () => {
    const result = await runChop(
      "slice",
      { input: "loop.wav", method: "silence" },
      ctx,
    );
    expect(result.outputs).toHaveLength(4);
    expect(result.outputs[0]!.path).toBe("samples/loop-s01.wav");
  });

  test("stretch doubles the length; pitch keeps it", async () => {
    const s = await runChop("stretch", { input: "loop.wav", ratio: 2 }, ctx);
    expect(s.outputs[0]!.seconds).toBeCloseTo(4, 1);
    expect(s.backend).toBe("ts");
    const p = await runChop("pitch", { input: "loop.wav", semitones: -5 }, ctx);
    expect(p.outputs[0]!.seconds).toBeCloseTo(2, 1);
  });

  test("gain, trim and peaks", async () => {
    const g = await runChop("gain", { input: "loop.wav", db: -6 }, ctx);
    expect(g.outputs[0]!.peakDb).toBeLessThan(-7);
    const t = await runChop("trim", { input: "loop.wav" }, ctx);
    expect(t.outputs[0]!.seconds).toBeLessThan(2);
    const k = await runChop(
      "peaks",
      { input: "loop.wav", count: 8 },
      { ...ctx, ascii: true },
    );
    expect(k.peaks!.bins).toHaveLength(8);
    expect(k.peaks!.text).toMatch(/^[ .:\-=+*#]{8}$/);
  });

  test("overwriting an existing output keeps a trash copy", async () => {
    await runChop(
      "cut",
      { input: "loop.wav", from: 0, to: 1, output: "keep.wav" },
      ctx,
    );
    const second = await runChop(
      "cut",
      { input: "loop.wav", from: 1, to: 2, output: "keep.wav" },
      ctx,
    );
    expect(second.trashed).toHaveLength(1);
    expect(second.trashed![0]!.copy.startsWith(".dawg/trash/")).toBe(true);
  });

  test("history rows are appended when a handle is wired", async () => {
    const rows: unknown[] = [];
    const history: ChopHistory = {
      append: (row) => {
        rows.push(row);
      },
    };
    await runChop(
      "reverse",
      { input: "loop.wav", track: "drums" },
      { ...ctx, history },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "asset", sub: "audio.reverse" });
  });

  test("bad arguments explain the valid range", async () => {
    await expect(
      runChop("pitch", { input: "loop.wav", semitones: 99 }, ctx),
    ).rejects.toThrow(/-24 to 24/);
    await expect(
      runChop("cut", { input: "loop.wav", from: 1, to: 0.5 }, ctx),
    ).rejects.toThrow(/must be after/);
    await expect(
      runChop("convert", { input: "loop.wav", format: "mp3" }, ctx),
    ).rejects.toThrow(/needs ffmpeg/);
  });
});

describe("chop path confinement", () => {
  test("inputs outside the project are refused", async () => {
    await expect(
      runChop("info", { input: "/etc/hosts" }, ctx),
    ).rejects.toThrow(/outside the project/);
    await expect(runChop("info", { input: "../x.wav" }, ctx)).rejects.toThrow();
  });

  test("outputs outside the project or in .dawg/.git are refused", async () => {
    await expect(resolveOutput(ctx, "../evil.wav")).rejects.toThrow(
      /outside the project/,
    );
    await expect(resolveOutput(ctx, "/tmp/evil.wav")).rejects.toThrow(
      /outside the project/,
    );
    await expect(resolveOutput(ctx, ".dawg/x.wav")).rejects.toThrow(
      /write scope/,
    );
    await expect(resolveOutput(ctx, ".git/hooks/x.wav")).rejects.toThrow(
      /write scope/,
    );
  });

  test("a symlinked directory cannot carry an output out of the project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dawg-out-"));
    try {
      await symlink(outside, join(root, "link"));
      await expect(resolveOutput(ctx, "link/x.wav")).rejects.toThrow(
        /symlink/,
      );
      await writeFile(join(outside, "secret.wav"), encodeWav24(hits()));
      await expect(
        runChop("info", { input: "link/secret.wav" }, ctx),
      ).rejects.toThrow(/outside the project/);
      await mkdir(join(root, "samples"), { recursive: true });
      await symlink(
        join(outside, "secret.wav"),
        join(root, "samples/file.wav"),
      );
      await expect(resolveOutput(ctx, "samples/file.wav")).rejects.toThrow(
        /not a regular file/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

const hasFfmpeg = systemRunner.which("ffmpeg") !== undefined;
const hasRubberband = systemRunner.which("rubberband") !== undefined;

describe("external backends (skipped when not installed)", () => {
  test.skipIf(!hasFfmpeg)("ffmpeg converts to flac", async () => {
    const result = await runChop(
      "convert",
      { input: "loop.wav", format: "flac" },
      { ...ctx, runner: systemRunner },
    );
    expect(result.backend).toBe("ffmpeg");
    expect(result.outputs[0]!.path).toBe("samples/loop-conv.flac");
  });

  test.skipIf(!hasRubberband)("rubberband stretches when installed", async () => {
    const result = await runChop(
      "stretch",
      { input: "loop.wav", ratio: 2 },
      { ...ctx, runner: systemRunner },
    );
    expect(result.backend).toBe("rubberband");
    expect(result.outputs[0]!.seconds).toBeCloseTo(4, 0);
  });
});
