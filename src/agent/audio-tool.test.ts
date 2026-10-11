import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCORE_LIMITS,
  applyScoreOperation,
  createScore,
  type TrackScore,
} from "../../core/score.ts";
import type { CommandRunner } from "../auth/runner.ts";
import { encodeWav24, makePcm } from "../audio/chop/pcm.ts";
import { slicesToSampler } from "../audio/chop/sampler.ts";
import { AUDIO_TOOL } from "./audio-tool.ts";
import { AGENT_TOOLS, type ToolContext } from "./tools.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const noTools: CommandRunner = {
  which: () => undefined,
  run: async () => {
    throw new Error("no external tools in this test");
  },
};

const SR = 44_100;

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dawg-audio-tool-"));
  dirs.push(root);
  const pcm = makePcm(SR, 1, SR * 2);
  for (let h = 0; h < 4; h += 1)
    for (let i = 0; i < SR * 0.2; i += 1)
      pcm.channels[0]![h * SR * 0.5 + i] =
        Math.sin((2 * Math.PI * 220 * i) / SR) *
        Math.exp(-i / (SR * 0.04)) *
        0.8;
  await mkdir(join(root, "tracks", "lead", "downloads"), { recursive: true });
  await writeFile(
    join(root, "tracks", "lead", "downloads", "break.wav"),
    encodeWav24(pcm),
  );
  return root;
}

const score = createScore({
  tempoBpm: 120,
  bars: 4,
  tracks: [{ id: "lead", name: "lead", instrument: "saw" }],
});

function context(value: TrackScore = score): ToolContext {
  return {
    score: value,
    focusedTrackId: "lead",
    revision: 3,
    newNoteId: (trackId, index) => `${trackId}-n${index}`,
  };
}

describe("audio agent tool", () => {
  test("is in the catalog with a short description", () => {
    expect(AGENT_TOOLS.some((tool) => tool.name === "audio")).toBe(true);
    expect(AUDIO_TOOL.description.length).toBeLessThanOrEqual(600);
  });

  test("rejects an unknown op before running anything", () => {
    expect(() => AUDIO_TOOL.plan({ op: "explode" }, context())).toThrow();
  });

  test("onsets on a downloaded file finds the planted hits", async () => {
    const root = await project();
    const plan = AUDIO_TOOL.plan(
      { op: "onsets", input: "break.wav" },
      context(),
    );
    expect(plan.kind).toBe("media");
    if (plan.kind !== "media") return;
    const result = await plan.run({
      projectRoot: root,
      trackSlug: "lead",
      runner: noTools,
      signal: new AbortController().signal,
      progress: () => {},
    });
    const content = result.content as { points: { t: number }[] };
    expect(content.points.length).toBe(4);
    expect(content.points[1]!.t).toBeCloseTo(0.5, 1);
  });

  test("cut writes a sample under the focused track", async () => {
    const root = await project();
    const plan = AUDIO_TOOL.plan(
      { op: "cut", input: "break.wav", from: "0.5s", to: "1s" },
      context(),
    );
    if (plan.kind !== "media") throw new Error("expected media");
    const result = await plan.run({
      projectRoot: root,
      trackSlug: "lead",
      runner: noTools,
      signal: new AbortController().signal,
      progress: () => {},
    });
    expect(result.outputs?.[0]).toMatch(
      /^tracks\/lead\/samples\/break-cut.*\.wav$/,
    );
  });

  test("slice with track yields valid score operations and a pattern", async () => {
    const root = await project();
    const plan = AUDIO_TOOL.plan(
      {
        op: "slice",
        input: "break.wav",
        method: "silence",
        track: "chops",
        pattern: true,
      },
      context(),
    );
    expect(plan.kind).toBe("prepare");
    if (plan.kind !== "prepare") return;
    const scored = await plan.run({
      workspace: { root } as never,
      media: { runner: noTools },
    });
    let next = score;
    for (const op of scored.operations) next = applyScoreOperation(next, op);
    const track = next.tracks.find((t) => t.id === "chops");
    expect(track?.instrument).toBe("sampler");
    expect(Object.keys(track?.sampler?.voices ?? {}).length).toBe(4);
    expect(next.notes.filter((n) => n.trackId === "chops").length).toBe(4);
  });

  test("slice refuses past the sampler voice cap", () => {
    const outputs = Array.from(
      { length: SCORE_LIMITS.maxSamplerVoices + 1 },
      (_, i) => ({
        path: `samples/x-${i}.wav`,
        sha256: "0".repeat(64),
        seconds: 0.1,
        peakDb: -1,
      }),
    );
    expect(() =>
      slicesToSampler(score, "chops", "x", outputs, {
        newNoteId: (i) => `n${i}`,
      }),
    ).toThrow(/sampler cap/);
  });

  test("slice onto a non-sampler track is refused", () => {
    expect(() =>
      slicesToSampler(
        score,
        "lead",
        "x",
        [
          {
            path: "samples/a.wav",
            sha256: "0".repeat(64),
            seconds: 0.1,
            peakDb: -1,
          },
        ],
        { newNoteId: (i) => `n${i}` },
      ),
    ).toThrow(/not a sampler/);
  });
});
