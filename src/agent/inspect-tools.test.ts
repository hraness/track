import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScore, type TrackScore } from "../../core/score.ts";
import { encodeWav } from "../audio/wav.ts";
import { INSPECT_LIMITS } from "./inspect-tools.ts";
import { AGENT_TOOLS, ToolArgumentError, type ToolContext } from "./tools.ts";

const tool = AGENT_TOOLS.find((t) => t.name === "inspect")!;

function context(score: TrackScore): ToolContext {
  return {
    score,
    focusedTrackId: "lead",
    revision: 1,
    newNoteId: (trackId, index) => `${trackId}-${index}`,
  };
}

async function inspect(
  score: TrackScore,
  args: Record<string, unknown>,
  workspace?: { root: string },
): Promise<string> {
  const plan = tool.plan(args, context(score));
  if (plan.kind !== "action") throw new Error(`planned ${plan.kind}`);
  const result = await plan.run(workspace ? { workspace } : {});
  return result.content;
}

const score = createScore({
  bars: 8,
  tempoBpm: 96,
  tracks: [
    { id: "lead", name: "Lead", instrument: "saw", volume: 0.6 },
    { id: "bass", name: "bass", instrument: "sine", pan: -0.3 },
    { id: "empty", name: "empty", instrument: "kit", muted: true },
  ],
  notes: Array.from({ length: 40 }, (_, i) => ({
    id: `n${i}`,
    trackId: "lead",
    pitch: 60 + (i % 12),
    startTick: i * 240,
    durationTicks: 240,
    velocity: 0.8,
  })).concat([
    {
      id: "b0",
      trackId: "bass",
      pitch: 36,
      startTick: 0,
      durationTicks: 1920,
      velocity: 0.9,
    },
  ]),
});

describe("inspect", () => {
  test("score is a compact overview with one line per track", async () => {
    const text = await inspect(score, { what: "score" });
    expect(text.length).toBeLessThanOrEqual(INSPECT_LIMITS.scoreBytes);
    expect(text).toContain("tempo 96 bpm · 4/4 · 8 bars");
    expect(text).toContain('lead · "Lead" · saw · 40 notes · bars 1-5');
    expect(text).toContain("bass · sine · 1 notes · bar 1 · C2..C2");
    expect(text).toContain("empty · kit · 0 notes · vol");
    expect(text).toContain("muted");
  });

  test("score pages tracks past its budget", async () => {
    const many = createScore({
      tracks: Array.from({ length: 64 }, (_, i) => ({
        id: `track-with-a-long-id-${i}`,
        name: `track-with-a-long-id-${i}`,
        instrument: "saw",
      })),
    });
    const first = await inspect(many, { what: "score" });
    expect(new TextEncoder().encode(first).length).toBeLessThanOrEqual(6144);
    for (const what of ["mix", "sections", "track"] as const) {
      const out = await inspect(many, {
        what,
        ...(what === "track" ? { target: "track-with-a-long-id-3" } : {}),
      });
      expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(6144);
    }
    const match = /… \((\d+) more; cursor=(\d+)\)$/.exec(first);
    expect(match).not.toBeNull();
    const next = await inspect(many, {
      what: "score",
      cursor: Number(match![2]),
    });
    expect(next).toContain(`track-with-a-long-id-${match![2]} `);
  });

  test("notes page 32 at a time and narrow by bars", async () => {
    const first = await inspect(score, { what: "notes", target: "Lead" });
    const lines = first.split("\n");
    expect(lines[0]).toBe("lead: 40 notes · id pitch bar.beat beats vel");
    expect(lines[1]).toBe("n0 C4 1.1 0.5 0.8");
    expect(lines).toHaveLength(1 + 32 + 1);
    expect(lines.at(-1)).toBe("… (8 more; cursor=32)");
    const rest = await inspect(score, {
      what: "notes",
      target: "lead",
      cursor: 32,
    });
    expect(rest.split("\n")).toHaveLength(1 + 8);
    const bar2 = await inspect(score, {
      what: "notes",
      target: "lead",
      bars: "2",
    });
    expect(bar2.split("\n")[0]).toBe(
      "lead: 8 notes in bars 2-2 · id pitch bar.beat beats vel",
    );
    expect(bar2).toContain("n8 G#4 2.1 0.5 0.8");
  });

  test("track shows non-default settings; mix and sections summarize", async () => {
    const track = JSON.parse(
      await inspect(score, { what: "track", target: "bass" }),
    ) as Record<string, unknown>;
    expect(track).toMatchObject({ id: "bass", instrument: "sine", pan: -0.3 });
    expect(track.notes).toBe(1);
    expect(track.muted).toBeUndefined();
    const mix = await inspect(score, { what: "mix" });
    expect(mix.split("\n")[0]).toBe("master: off");
    expect(mix).toContain("bass · vol");
    expect(mix).toContain("pan -0.3");
    expect(await inspect(score, { what: "sections" })).toBe(
      "no sections; the song plays 8 bars straight through",
    );
    expect(await inspect(score, { what: "patch" })).toContain(
      "no library patches",
    );
  });

  test("bad arguments reject the call at plan time", () => {
    expect(() => tool.plan({ what: "nope" }, context(score))).toThrow(
      ToolArgumentError,
    );
    expect(() =>
      tool.plan({ what: "notes", target: "ghost" }, context(score)),
    ).toThrow(/no track "ghost"; tracks: lead, bass, empty/);
    expect(() =>
      tool.plan({ what: "notes", target: "lead", bars: "x" }, context(score)),
    ).toThrow(/bars must look like/);
    expect(() =>
      tool.plan({ what: "patch", target: "lead" }, context(score)),
    ).toThrow(/plays saw, not a patch/);
  });

  describe("sample", () => {
    let root: string;
    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "dawg-inspect-")));
      await mkdir(join(root, "samples"), { recursive: true });
      await mkdir(join(root, ".dawg"), { recursive: true });
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("reports format, length, peak and rms of a WAV", async () => {
      const pcm = new Int16Array(44100);
      for (let i = 0; i < pcm.length; i++)
        pcm[i] = Math.round(Math.sin(i / 10) * 16384);
      await writeFile(join(root, "samples/tone.wav"), encodeWav(pcm, 44100));
      const text = await inspect(
        score,
        { what: "sample", target: "samples/tone.wav" },
        { root },
      );
      expect(text).toMatch(
        /^samples\/tone\.wav · 86\.2 KiB · WAV 44100 Hz · 1 ch · 1 s · peak -6 dBFS · rms -9(\.\d)? dBFS$/,
      );
    });

    test("non-WAV files and .dawg internals", async () => {
      await writeFile(join(root, "samples/notes.txt"), "hello\n");
      expect(
        await inspect(
          score,
          { what: "sample", target: "samples/notes.txt" },
          { root },
        ),
      ).toContain("text; use read_file");
      await writeFile(join(root, ".dawg/history.db"), "x");
      await expect(
        inspect(
          score,
          { what: "sample", target: ".dawg/history.db" },
          { root },
        ),
      ).rejects.toThrow(/\.dawg/);
    });
  });
});
