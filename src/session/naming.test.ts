import { describe, expect, test } from "bun:test";
import {
  addNote,
  createScore,
  scoreFromJSON,
  type TrackScore,
} from "../../core/score.ts";
import {
  applyMetaPatch,
  defaultSessionMeta,
  metaMatches,
  parseMetaExpect,
  type MetaExpect,
  type MetaPatch,
  type SessionMeta,
} from "./meta.ts";
import {
  AutoNamer,
  estimateKey,
  localName,
  musicalFingerprint,
  namingPrompt,
  sanitizeGeneratedName,
  type NameGenerator,
  type NamingTarget,
} from "./naming.ts";

function notes(
  score: TrackScore,
  trackId: string,
  pitches: number[],
  prefix = trackId,
): TrackScore {
  let next = score;
  pitches.forEach((pitch, index) => {
    next = addNote(next, {
      id: `${prefix}-${index}`,
      trackId,
      startTick: index * 480,
      durationTicks: 480,
      pitch,
      velocity: 0.8,
    });
  });
  return next;
}

const A_MINOR_BASS = [33, 36, 40, 33, 45, 43, 40, 36];

function groove(): TrackScore {
  const base = createScore({
    tempoBpm: 96,
    tracks: [
      { id: "bass", name: "bass", instrument: "saw" },
      { id: "drums", name: "drums", instrument: "kit" },
    ],
  });
  return notes(notes(base, "bass", A_MINOR_BASS), "drums", [36, 42, 38, 42]);
}

/** In-memory session metadata with the same conditional-write semantics. */
class MemoryTarget implements NamingTarget {
  public meta_: SessionMeta = defaultSessionMeta("2026-10-06T00:00:00.000Z");
  public writes = 0;
  public beforeWrite: (() => void) | undefined;
  public others: string[] = [];
  meta(): SessionMeta {
    return this.meta_;
  }
  async updateMeta(patch: MetaPatch, expect: MetaExpect) {
    this.beforeWrite?.();
    if (!metaMatches(this.meta_, expect))
      return { status: "stale" as const, meta: this.meta_ };
    this.writes += 1;
    this.meta_ = applyMetaPatch(this.meta_, patch, "2026-10-06T00:00:01Z");
    return { status: "applied" as const, meta: this.meta_ };
  }
  async otherNames() {
    return this.others;
  }
}

class FakeGenerator implements NameGenerator {
  public prompts: string[] = [];
  public constructor(public reply: (prompt: string) => string | Error) {}
  async generate(prompt: string, options: { maxTokens: number }) {
    expect(options.maxTokens).toBe(12);
    this.prompts.push(prompt);
    const value = this.reply(prompt);
    if (value instanceof Error) throw value;
    return value;
  }
}

describe("musical fingerprint", () => {
  test("is stable across note order, ids and track names", () => {
    const a = groove();
    const reordered = notes(
      notes(
        createScore({
          tempoBpm: 96,
          tracks: [
            { id: "drums", name: "Beat", instrument: "kit" },
            { id: "bass", name: "Low end", instrument: "saw" },
          ],
        }),
        "drums",
        [36, 42, 38, 42],
        "x",
      ),
      "bass",
      A_MINOR_BASS,
      "y",
    );
    expect(musicalFingerprint(reordered).hash).toBe(musicalFingerprint(a).hash);
    expect(musicalFingerprint(a).line).toBe(musicalFingerprint(a).line);
  });

  test("changes with tempo, instrument and effects", () => {
    const base = musicalFingerprint(groove()).hash;
    expect(musicalFingerprint(groove().withTempo(128)).hash).not.toBe(base);
    const swapped = groove().withTracks(
      groove().tracks.map((track) =>
        track.id === "bass" ? { ...track, instrument: "square" } : track,
      ),
    );
    expect(musicalFingerprint(swapped).hash).not.toBe(base);
    expect(musicalFingerprint(swapped).structure).not.toBe(
      musicalFingerprint(groove()).structure,
    );
  });

  test("estimates keys and builds a local name", () => {
    const histogram = new Array(12).fill(0);
    for (const pitch of A_MINOR_BASS) histogram[pitch % 12] += 1;
    expect(estimateKey(histogram)).toBe("a minor");
    const fingerprint = musicalFingerprint(groove());
    expect(fingerprint.line).toContain("96 bpm");
    expect(fingerprint.line).toContain("a minor");
    expect(localName(fingerprint)).toBe("a minor bass groove");
    const drumsOnly = notes(
      createScore({
        tempoBpm: 128,
        tracks: [{ id: "d", name: "d", instrument: "kit" }],
      }),
      "d",
      [36, 38],
    );
    expect(localName(musicalFingerprint(drumsOnly))).toBe("128 bpm drums");
  });

  test("the prompt stays small", () => {
    const prompt = namingPrompt(
      musicalFingerprint(groove()),
      ["x".repeat(500), "make the bass darker and add a swung hat"],
      "untitled",
    );
    // ~4 characters per token: comfortably near the 120-token budget.
    expect(prompt.length).toBeLessThan(560);
    expect(prompt).not.toContain("x".repeat(61));
  });
});

describe("name validation", () => {
  test("accepts 2-4 lowercase words and rejects junk", () => {
    expect(sanitizeGeneratedName('"Midnight Basement Funk"')).toBe(
      "midnight basement funk",
    );
    expect(sanitizeGeneratedName("rain on tin\nexplanation")).toBe(
      "rain on tin",
    );
    expect(sanitizeGeneratedName("a")).toBeUndefined();
    expect(sanitizeGeneratedName("one two three four five")).toBeUndefined();
    expect(sanitizeGeneratedName("x".repeat(40))).toBeUndefined();
    expect(sanitizeGeneratedName("\u001b[31mred\u001b[0m alert")).toBe(
      "31mred 0m alert",
    );
    expect(sanitizeGeneratedName(42)).toBeUndefined();
  });
});

describe("meta conditions", () => {
  test("a revision condition parses and matches only that revision", () => {
    const expect_ = parseMetaExpect({ nameSource: "auto", revision: 4 })!;
    expect(expect_).toEqual({ nameSource: "auto", revision: 4 });
    const meta = defaultSessionMeta("2026-10-06T00:00:00.000Z");
    expect(metaMatches(meta, expect_, 4)).toBe(true);
    expect(metaMatches(meta, expect_, 5)).toBe(false);
    expect(metaMatches(meta, { nameSource: "auto" }, 5)).toBe(true);
    for (const revision of [-1, 1.5, "4", Number.NaN])
      expect(() => parseMetaExpect({ revision })).toThrow("meta revision");
  });
});

describe("AutoNamer across windows", () => {
  /** One session on disk; each window reads it through its own target. */
  class SharedSession {
    public meta: SessionMeta = defaultSessionMeta("2026-10-06T00:00:00.000Z");
    public revision = 0;
    public score: TrackScore = createScore({ tempoBpm: 120, tracks: [] });
    public writes: string[] = [];
    edit(score: TrackScore): number {
      this.score = score;
      return (this.revision += 1);
    }
    target(): NamingTarget {
      return {
        meta: () => this.meta,
        current: () => ({ score: this.score, revision: this.revision }),
        updateMeta: async (patch, expect) => {
          if (!metaMatches(this.meta, expect, this.revision))
            return { status: "stale" as const, meta: this.meta };
          this.meta = applyMetaPatch(this.meta, patch, "2026-10-06T00:00:01Z");
          if (patch.name) this.writes.push(patch.name);
          return { status: "applied" as const, meta: this.meta };
        },
        otherNames: async () => [],
      };
    }
  }
  /** Names the score it was asked about, after `ms`. */
  const slow = (ms: number): NameGenerator => ({
    async generate(prompt) {
      await Bun.sleep(ms);
      return prompt.includes("drums") && !prompt.includes("bass")
        ? "drum loop only"
        : "bass and drums";
    },
  });
  const drums = () =>
    notes(
      createScore({
        tempoBpm: 96,
        tracks: [{ id: "drums", name: "drums", instrument: "kit" }],
      }),
      "drums",
      [36, 42, 38, 42],
    );

  // [A's model ms, B's model ms, A's quiet period ms]: A's run either is in
  // flight when B edits, or starts only after B has already named the song.
  for (const [first, second, quiet] of [
    [200, 1, 1],
    [1, 200, 1],
    [1, 1, 100],
  ] as const)
    test(`the newest revision's name wins (model ${first}/${second} ms, quiet ${quiet} ms)`, async () => {
      const session = new SharedSession();
      const a = new AutoNamer({
        target: session.target(),
        generator: slow(first),
        delayMs: quiet,
      });
      const b = new AutoNamer({
        target: session.target(),
        generator: slow(second),
        delayMs: 1,
      });
      // Window A adds drums and starts naming; window B adds the bass while
      // A's request is in flight.
      a.noteTurn({ score: session.score, prompt: "drums", accepted: true });
      session.edit(drums());
      a.noteTurn({ score: drums(), prompt: "drums", accepted: true });
      await Bun.sleep(20);
      session.edit(groove());
      b.noteTurn({ score: groove(), prompt: "bass", accepted: true });
      await Promise.all([a.idle(), b.idle()]);
      expect(session.meta.name).toBe("bass and drums");
      expect(session.meta.namedFingerprint).toBe(
        musicalFingerprint(groove()).hash,
      );
      expect(session.writes.at(-1)).toBe("bass and drums");
      a.dispose();
      b.dispose();
    });
});

describe("AutoNamer", () => {
  const options = (target: NamingTarget, generator?: NameGenerator) => ({
    target,
    generator,
    delayMs: 1,
  });

  test("skips the model when the fingerprint is unchanged", async () => {
    const target = new MemoryTarget();
    const generator = new FakeGenerator(() => "dusty basement funk");
    const namer = new AutoNamer(options(target, generator));
    namer.noteTurn({ score: groove(), prompt: "bass", accepted: true });
    await namer.idle();
    expect(target.meta_.name).toBe("dusty basement funk");
    expect(generator.prompts).toHaveLength(1);
    // Same music again (e.g. a no-op or an undo back to it): no call.
    namer.noteTurn({ score: groove(), prompt: "again", accepted: true });
    await namer.idle();
    expect(generator.prompts).toHaveLength(1);
    expect(namer.stats.unchanged).toBe(1);
    // Rejected turns are ignored entirely.
    namer.noteTurn({
      score: groove().withTempo(140),
      prompt: "?",
      accepted: false,
    });
    await namer.idle();
    expect(generator.prompts).toHaveLength(1);
  });

  test("hysteresis: the model echoing the current name keeps it", async () => {
    const target = new MemoryTarget();
    const generator = new FakeGenerator((prompt) =>
      prompt.includes("current name: dusty basement funk")
        ? "dusty basement funk"
        : "dusty basement funk",
    );
    const namer = new AutoNamer({ ...options(target, generator), minTurns: 1 });
    namer.noteTurn({ score: groove(), prompt: "bass", accepted: true });
    await namer.idle();
    const version = target.meta_.version;
    namer.noteTurn({
      score: groove().withTempo(100),
      prompt: "faster",
      accepted: true,
    });
    await namer.idle();
    expect(generator.prompts).toHaveLength(2);
    expect(generator.prompts[1]).toContain("current name: dusty basement funk");
    expect(target.meta_.name).toBe("dusty basement funk");
    expect(namer.stats.renames).toBe(1);
    // Only the fingerprint bookkeeping moved; the next same-music turn skips.
    expect(target.meta_.version).toBe(version + 1);
    namer.noteTurn({
      score: groove().withTempo(100),
      prompt: "x",
      accepted: true,
    });
    await namer.idle();
    expect(generator.prompts).toHaveLength(2);
  });

  test("a user rename during the request wins and stops auto-naming", async () => {
    const target = new MemoryTarget();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const generator: NameGenerator = {
      async generate() {
        await gate;
        return "late model name";
      },
    };
    const namer = new AutoNamer(options(target, generator));
    namer.noteTurn({ score: groove(), prompt: "bass", accepted: true });
    await Bun.sleep(10);
    // `/rename` lands while the model call is in flight.
    target.meta_ = applyMetaPatch(
      target.meta_,
      { name: "my song", nameSource: "user" },
      "2026-10-06T00:00:02Z",
    );
    release();
    await namer.idle();
    expect(target.meta_.name).toBe("my song");
    expect(target.meta_.nameSource).toBe("user");
    expect(namer.stats.dropped).toBe(1);
    // And no further calls while nameSource is user.
    const calls = namer.stats.calls;
    namer.noteTurn({
      score: groove().withTempo(150),
      prompt: "x",
      accepted: true,
    });
    await namer.idle();
    expect(namer.stats.calls).toBe(calls);
  });

  test("falls back to the local name offline and suffixes collisions", async () => {
    const target = new MemoryTarget();
    target.others = ["a minor bass groove"];
    const namer = new AutoNamer(
      options(target, new FakeGenerator(() => new Error("offline"))),
    );
    namer.noteTurn({ score: groove(), prompt: "bass", accepted: true });
    await namer.idle();
    expect(target.meta_.name).toBe("a minor bass groove 2");
    const local = new AutoNamer(options(new MemoryTarget()));
    local.noteTurn({ score: groove(), prompt: "bass", accepted: true });
    await local.idle();
    expect(local.stats.calls).toBe(0);
  });

  test("forks keep their number when auto-renamed", async () => {
    const target = new MemoryTarget();
    target.meta_ = {
      ...target.meta_,
      name: "night drive 3",
      forkOf: { sessionId: "parent", revision: 4 },
    };
    const generator = new FakeGenerator(() => "neon rain");
    const namer = new AutoNamer(options(target, generator));
    namer.noteTurn({ score: groove(), prompt: "bass", accepted: true });
    await namer.idle();
    expect(generator.prompts[0]).toContain(
      "current name: night drive\n".trim(),
    );
    expect(target.meta_.name).toBe("neon rain 3");
  });

  test("call budget: a typical 10-prompt session makes few calls", async () => {
    const target = new MemoryTarget();
    const generator = new FakeGenerator(() => "dusty basement funk");
    const namer = new AutoNamer(options(target, generator));
    let score = createScore({
      tempoBpm: 96,
      tracks: [{ id: "bass", name: "bass", instrument: "saw" }],
    });
    const turns: Array<[string, (s: TrackScore) => TrackScore, boolean]> = [
      [
        "add a bassline",
        (s) => notes(s, "bass", A_MINOR_BASS.slice(0, 4)),
        true,
      ],
      ["more bass notes", (s) => notes(s, "bass", A_MINOR_BASS, "b2"), true],
      ["play", (s) => s, false],
      [
        "louder",
        (s) => s.withTracks(s.tracks.map((t) => ({ ...t, volume: 0.9 }))),
        true,
      ],
      [
        "add drums",
        (s) =>
          notes(
            s.withTracks([
              ...s.tracks,
              {
                id: "drums",
                name: "drums",
                instrument: "kit",
                muted: false,
                volume: 0.8,
                pan: 0,
                volumeAutomation: [],
                panAutomation: [],
              },
            ]),
            "drums",
            [36, 42, 38, 42],
          ),
        true,
      ],
      [
        "pan bass left",
        (s) =>
          s.withTracks(
            s.tracks.map((t) => (t.id === "bass" ? { ...t, pan: -0.3 } : t)),
          ),
        true,
      ],
      ["tempo 100", (s) => s.withTempo(100), true],
      ["undo", (s) => s.withTempo(96), true],
      ["what key is this?", (s) => s, false],
      ["tempo 104", (s) => s.withTempo(104), true],
    ];
    for (const [prompt, edit, accepted] of turns) {
      score = edit(score);
      namer.noteTurn({ score, prompt, accepted });
      await namer.idle();
    }
    // First name, the drums (structure change), and at most one more.
    expect(namer.stats.calls).toBeGreaterThanOrEqual(2);
    expect(namer.stats.calls).toBeLessThanOrEqual(3);
    console.log(
      `naming budget: ${namer.stats.calls} calls / 10 prompts`,
      namer.stats,
    );
  });

  test("bursts coalesce into one request", async () => {
    const target = new MemoryTarget();
    const generator = new FakeGenerator(() => "burst name");
    const namer = new AutoNamer({ target, generator, delayMs: 30 });
    for (let i = 0; i < 5; i += 1)
      namer.noteTurn({
        score: groove().withTempo(90 + i),
        prompt: `t${i}`,
        accepted: true,
      });
    await Bun.sleep(80);
    await namer.idle();
    expect(generator.prompts).toHaveLength(1);
    expect(generator.prompts[0]).toContain("94 bpm");
  });
});

test("a tuned song is named by its tuning, not a guessed key", () => {
  const tuned = scoreFromJSON({
    ...groove().toJSON(),
    tuning: { name: "pelog" },
  });
  expect(musicalFingerprint(tuned).key).toBe("pelog");
  expect(localName(musicalFingerprint(tuned))).toBe("pelog bass groove");
});
