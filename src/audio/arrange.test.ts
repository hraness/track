import { describe, expect, test } from "bun:test";
import { createScore, TrackScore } from "../../core/score.ts";
import {
  applySectionChanges,
  loopSection,
  parseForm,
  withForm,
} from "../../core/sections.ts";
import {
  exportScore,
  playbackScore,
  renderArranged,
  renderArrangedPcm,
  scoreBeatAt,
  sectionCues,
} from "./arrange.ts";
import {
  encodeWav,
  loopFrames,
  renderScorePcm,
  StemRenderer,
  withWavCues,
} from "./wav.ts";
import { budget } from "../../test/perf.ts";

function song(bars = 8, tempoBpm = 120): TrackScore {
  const notes = Array.from({ length: bars }, (_, bar) => ({
    id: `n${bar}`,
    trackId: "lead",
    pitch: 60 + (bar % 5),
    startTick: bar * 4 * 480,
    durationTicks: 960,
    velocity: 0.8,
  }));
  return createScore({
    bars,
    tempoBpm,
    tracks: [{ id: "lead", name: "lead", instrument: "saw" }],
    notes,
  }).withSections(
    [
      { name: "verse", startBar: 0, bars: Math.floor(bars / 2) },
      {
        name: "chorus",
        startBar: Math.floor(bars / 2),
        bars: bars - Math.floor(bars / 2),
      },
    ],
    [],
  );
}

describe("arranged rendering", () => {
  test("a song without form, mutes or section loop renders as today", () => {
    const score = song();
    expect(playbackScore(score)).toBe(score);
    expect(exportScore(score)).toBe(score);
    const today = renderScorePcm(score, { loop: true });
    const arranged = renderArrangedPcm(score, { loop: true });
    expect(arranged.frames).toBe(today.frames);
    expect(
      Buffer.from(arranged.pcm.buffer).equals(Buffer.from(today.pcm.buffer)),
    ).toBe(true);
    const oneShot = renderArrangedPcm(score);
    expect(
      Buffer.from(oneShot.pcm.buffer).equals(
        Buffer.from(renderScorePcm(score).pcm.buffer),
      ),
    ).toBe(true);
  });

  test("playback and export follow the form", () => {
    const score = withForm(song(), parseForm(song(), "verse verse chorus"));
    const flat = exportScore(score);
    expect(flat.bars).toBe(12);
    const loop = renderArrangedPcm(score, { loop: true });
    expect(loop.frames).toBe(Math.round(loopFrames(flat, loop.sampleRate)));
  });

  test("a looped section plays only its bars; export ignores it", () => {
    const score = loopSection(song(), "chorus");
    const loop = renderArrangedPcm(score, { loop: true });
    const section = playbackScore(score);
    expect(section.bars).toBe(4);
    expect(loop.frames).toBe(Math.round(loopFrames(section, loop.sampleRate)));
    expect(exportScore(score).bars).toBe(8);
  });

  test("long forms render in windows, deterministically, at full length", () => {
    // 4 sections of 8 bars at 120 bpm = 16 s each; the form plays 64 s.
    const score = withForm(
      song(16),
      parseForm(song(16), "verse chorus verse chorus"),
    );
    const flat = exportScore(score);
    expect(flat.bars).toBe(32);
    const first = renderArrangedPcm(score, { loop: true });
    const second = renderArrangedPcm(score, { loop: true });
    expect(first.frames).toBe(Math.round(loopFrames(flat, first.sampleRate)));
    expect(
      Buffer.from(first.pcm.buffer).equals(Buffer.from(second.pcm.buffer)),
    ).toBe(true);
    const oneShot = renderArrangedPcm(score);
    expect(oneShot.frames).toBeGreaterThan(60 * oneShot.sampleRate);
    // The last pass sounds: the final bars are not silent.
    const tail = oneShot.pcm.subarray(
      Math.round(62 * oneShot.sampleRate) * 2,
      Math.round(63 * oneShot.sampleRate) * 2,
    );
    expect(tail.some((sample) => sample !== 0)).toBe(true);
  });

  test("a form past the bar and note limits renders in full", () => {
    // 8 bars with 256 notes at 240 bpm (1 s a bar); 33 passes play 264
    // bars and 8448 notes, past both the 256-bar and 4096-note limits.
    const notes = Array.from({ length: 256 }, (_, index) => ({
      id: `n${index}`,
      trackId: "lead",
      pitch: 60 + (index % 12),
      startTick: index * 60,
      durationTicks: 60,
      velocity: 0.5,
    }));
    const base = createScore({
      bars: 8,
      tempoBpm: 240,
      tracks: [{ id: "lead", name: "lead", instrument: "square" }],
      notes,
    }).withSections([{ name: "loop", startBar: 0, bars: 8 }], []);
    const score = withForm(base, parseForm(base, "loop*16 loop*16 loop"));
    expect(() => exportScore(score)).toThrow(/limit/);
    const renderer = new StemRenderer();
    const audio = renderArranged(renderer, score, { sampleRate: 8000 });
    expect(audio.frames).toBeGreaterThanOrEqual(264 * 8000);
    const end = audio.pcm.subarray(263 * 8000 * 2, 264 * 8000 * 2);
    expect(end.some((sample) => sample !== 0)).toBe(true);
    // Repeated passes share their window scores, so stems are reused.
    expect(renderer.cache.stems).toBeLessThan(6);
  });

  test("the highway shows the score beat of the pass that plays", () => {
    const plain = song();
    expect(scoreBeatAt(plain, 37.5)).toBe(37.5);
    const formed = withForm(plain, parseForm(plain, "chorus verse"));
    // Arranged beat 0 is the chorus, which starts at score bar 4.
    expect(scoreBeatAt(formed, 0)).toBe(16);
    expect(scoreBeatAt(formed, 17)).toBe(1);
    const looped = loopSection(plain, "chorus");
    expect(scoreBeatAt(looped, 0)).toBe(16);
    expect(scoreBeatAt(looped, 17)).toBe(17);
    expect(scoreBeatAt(looped, 33)).toBe(17);
  });
});

describe("auditions inside a looped section", () => {
  test("the audition region stays within the looped section", async () => {
    const { previewRegion } = await import("./preview.ts");
    const plain = song(16);
    expect(previewRegion(plain, "lead", 0)).toEqual({ startBar: 0, bars: 2 });
    const looped = loopSection(plain, "chorus");
    // The chorus is bars 8..16; a playhead at beat 0 of the loop is bar 8.
    expect(previewRegion(looped, "lead", 0)).toEqual({ startBar: 8, bars: 2 });
    expect(previewRegion(looped, "lead", 4 * 4)).toEqual({
      startBar: 12,
      bars: 2,
    });
    const short = song(4).withSections(
      [{ name: "hook", startBar: 1, bars: 3 }],
      [],
      "hook",
    );
    expect(previewRegion(short, "lead", 0)).toEqual({ startBar: 1, bars: 3 });
  });
});

describe("dawg render --section", () => {
  test("renders one section, and names the sections when it is missing", async () => {
    const { mkdtemp, writeFile, stat, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { encodeLoopDocument } = await import("../../core/loop.ts");
    const { runRenderCommand } = await import("../render.ts");
    const dir = await mkdtemp(join(tmpdir(), "dawg-render-section-"));
    try {
      await writeFile(
        join(dir, "song.track.json"),
        JSON.stringify(encodeLoopDocument(song(8, 120))),
      );
      const out: string[] = [];
      const err: string[] = [];
      const io = (sink: string[]) => ({
        write: (text: string) => sink.push(text),
      });
      const code = await runRenderCommand(
        [
          "render",
          "chorus.wav",
          "--import",
          "song.track.json",
          "--section",
          "chorus",
        ],
        dir,
        io(out),
        io(err),
      );
      expect(err.join("")).toBe("");
      expect(code).toBe(0);
      await runRenderCommand(
        ["render", "all.wav", "--import", "song.track.json"],
        dir,
        io(out),
        io(err),
      );
      // Four of the song's eight bars: about half as long, plus the tail.
      const part = (await stat(join(dir, "chorus.wav"))).size;
      const whole = (await stat(join(dir, "all.wav"))).size;
      expect(part / whole).toBeGreaterThan(0.45);
      expect(part / whole).toBeLessThan(0.7);
      const missing = await runRenderCommand(
        [
          "render",
          "x.wav",
          "--import",
          "song.track.json",
          "--section",
          "bridge",
        ],
        dir,
        io(out),
        io(err),
      );
      expect(missing).toBe(1);
      expect(err.join("")).toContain("sections: verse, chorus");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("windowed renders match one pass", () => {
  const rate = 8000;
  function rms(pcm: Int16Array, fromSecond: number, toSecond: number) {
    const slice = pcm.subarray(fromSecond * rate * 2, toSecond * rate * 2);
    let sum = 0;
    for (const sample of slice) sum += sample * sample;
    return Math.sqrt(sum / Math.max(1, slice.length));
  }
  function maxDiff(a: Int16Array, b: Int16Array, frames: number) {
    let most = 0;
    for (let index = 0; index < frames * 2; index += 1)
      most = Math.max(most, Math.abs((a[index] ?? 0) - (b[index] ?? 0)));
    return most;
  }
  // 28 bars at 120 bpm: 2 s a bar, 56 s, past the single-pass limit and
  // under the 60 s cap of the one-pass reference.
  const ticks = 4 * 480;
  function long(
    extraTracks: NonNullable<
      NonNullable<Parameters<typeof createScore>[0]>["tracks"]
    > = [],
  ) {
    return createScore({
      bars: 28,
      tempoBpm: 120,
      tracks: [
        { id: "pad", name: "pad", instrument: "sine" },
        { id: "helper", name: "helper", instrument: "square" },
        ...extraTracks,
      ],
      notes: [
        {
          id: "p1",
          trackId: "pad",
          pitch: 57,
          startTick: 0,
          durationTicks: 16 * ticks,
          velocity: 0.7,
        },
        {
          id: "p2",
          trackId: "pad",
          pitch: 60,
          startTick: 16 * ticks,
          durationTicks: 12 * ticks,
          velocity: 0.7,
        },
        {
          id: "h",
          trackId: "helper",
          pitch: 72,
          startTick: 0,
          durationTicks: 480,
          velocity: 0.5,
        },
      ],
    }).withSections(
      [{ name: "all", startBar: 0, bars: 28, mute: ["helper"] }],
      [],
    );
  }

  test("a held note sounds through every bar it covers", () => {
    const score = long();
    const audio = renderArrangedPcm(score, { sampleRate: rate });
    for (let bar = 0; bar < 28; bar += 1)
      expect(rms(audio.pcm, bar * 2, bar * 2 + 2)).toBeGreaterThan(100);
    const single = renderScorePcm(applySectionChanges(score), {
      sampleRate: rate,
      maxSeconds: 70,
    });
    expect(maxDiff(audio.pcm, single.pcm, 56 * rate)).toBeLessThanOrEqual(2);
  });

  test("seeded noise and ducking agree with one pass", () => {
    const kickTicks = Array.from({ length: 56 }, (_, index) => index * 960);
    const base = long([
      {
        id: "k",
        name: "k",
        instrument: "kit",
        fx: { duck: { orbit: 2, depth: 1, attack: 0.3 } },
      },
      {
        id: "lead",
        name: "lead",
        instrument: "saw",
        fx: { orbit: { orbit: 2 } },
      },
    ]);
    const score = new TrackScore({
      ...base.toJSON(),
      notes: [
        ...base.notes,
        ...kickTicks.map((tick, index) => ({
          id: `k${index}`,
          trackId: "k",
          pitch: index % 2 ? 38 : 36,
          startTick: tick,
          durationTicks: 240,
          velocity: 0.9,
        })),
        ...Array.from({ length: 28 }, (_, index) => ({
          id: `l${index}`,
          trackId: "lead",
          pitch: 64,
          startTick: index * ticks,
          durationTicks: ticks,
          velocity: 0.6,
        })),
      ],
    });
    const audio = renderArrangedPcm(score, { sampleRate: rate });
    const single = renderScorePcm(applySectionChanges(score), {
      sampleRate: rate,
      maxSeconds: 70,
    });
    expect(maxDiff(audio.pcm, single.pcm, 56 * rate)).toBeLessThanOrEqual(2);
  });

  test("a ducked form agrees with its flattened one pass", () => {
    const kick = Array.from({ length: 28 }, (_, index) => ({
      id: `k${index}`,
      trackId: "k",
      pitch: 36,
      startTick: index * 960,
      durationTicks: 240,
      velocity: 0.9,
    }));
    const lead = Array.from({ length: 14 }, (_, index) => ({
      id: `l${index}`,
      trackId: "lead",
      pitch: 64 + (index % 5),
      startTick: index * ticks,
      durationTicks: ticks,
      velocity: 0.6,
    }));
    const base = createScore({
      bars: 14,
      tempoBpm: 120,
      tracks: [
        {
          id: "k",
          name: "k",
          instrument: "kit",
          fx: { duck: { orbit: 2, depth: 1, attack: 0.3 } },
        },
        {
          id: "lead",
          name: "lead",
          instrument: "saw",
          fx: { orbit: { orbit: 2 } },
        },
      ],
      notes: [...kick, ...lead],
    }).withSections(
      [
        { name: "a", startBar: 0, bars: 7 },
        { name: "b", startBar: 7, bars: 7 },
      ],
      [],
    );
    const score = withForm(base, parseForm(base, "a b a b"));
    const audio = renderArrangedPcm(score, { sampleRate: rate });
    const single = renderScorePcm(exportScore(score), {
      sampleRate: rate,
      maxSeconds: 60,
    });
    expect(maxDiff(audio.pcm, single.pcm, 56 * rate)).toBeLessThanOrEqual(2);
  });
});

describe("songs longer than one pass render in full", () => {
  function plain(bars: number, tempoBpm = 120): TrackScore {
    return createScore({
      bars,
      tempoBpm,
      tracks: [{ id: "lead", name: "lead", instrument: "sine" }],
      notes: Array.from({ length: bars }, (_, bar) => ({
        id: `n${bar}`,
        trackId: "lead",
        pitch: 60,
        startTick: bar * 4 * 480,
        durationTicks: 480,
        velocity: 0.8,
      })),
    });
  }

  test("a plain song past 30 s is not cut", () => {
    // 32 bars at 120 bpm: 64 s plus the tail.
    const audio = renderArrangedPcm(plain(32), { sampleRate: 8000 });
    expect(audio.frames / 8000).toBeGreaterThan(64);
    expect(audio.frames / 8000).toBeLessThan(66);
    // The last note (beat 124, 62 s) sounds.
    let peak = 0;
    for (let index = 62 * 8000 * 2; index < 63 * 8000 * 2; index += 1)
      peak = Math.max(peak, Math.abs(audio.pcm[index]!));
    expect(peak).toBeGreaterThan(1000);
  });

  test("a song between 30 and 45 s renders in one pass at full length", () => {
    const audio = renderArrangedPcm(plain(18), { sampleRate: 8000 });
    expect(audio.frames / 8000).toBeGreaterThan(36);
  });

  test("a short song renders exactly as before", () => {
    const score = plain(8);
    const today = renderScorePcm(score, { sampleRate: 8000 });
    const arranged = renderArrangedPcm(score, { sampleRate: 8000 });
    expect(
      Buffer.from(arranged.pcm.buffer).equals(Buffer.from(today.pcm.buffer)),
    ).toBe(true);
  });

  test("a drone held past the window reach crossfades at seams, in linear time", () => {
    const rate = 8000;
    const bars = 60; // 120 s at 120 bpm
    const score = createScore({
      bars,
      tempoBpm: 120,
      tracks: [{ id: "drone", name: "drone", instrument: "sine" }],
      notes: [
        {
          id: "d",
          trackId: "drone",
          pitch: 48,
          startTick: 0,
          durationTicks: bars * 4 * 480,
          velocity: 0.7,
        },
      ],
    });
    const started = performance.now();
    const audio = renderArrangedPcm(score, { sampleRate: rate });
    const elapsed = performance.now() - started;
    expect(audio.frames / rate).toBeGreaterThan(120);
    // A sine at C3 moves at most ~2*pi*130/8000 of full scale per sample;
    // a phase step would jump far more.
    let largest = 0;
    let typical = 0;
    for (let frame = rate; frame < 119 * rate; frame += 1) {
      const step = Math.abs(
        audio.pcm[frame * 2]! - audio.pcm[(frame - 1) * 2]!,
      );
      largest = Math.max(largest, step);
      typical = Math.max(typical, frame < 40 * rate ? step : 0);
    }
    expect(largest).toBeLessThanOrEqual(typical * 1.5 + 2);
    // Full-size windows, not one bar each with half a minute of pre-roll.
    expect(elapsed).toBeLessThan(budget(20_000));
  });
});

describe("sections meet the 0.5 tempo map, track time and master", () => {
  test("a looped section starts at the tempo sounding there", () => {
    // 8 bars at 120, stepping to 60 bpm at bar 4 (the chorus).
    const score = song(8).withTime({ tempo: [{ tick: 4 * 4 * 480, bpm: 60 }] });
    const chorus = playbackScore(loopSection(score, "chorus"));
    expect(chorus.tempoBpm).toBe(60);
    expect(chorus.time).toBeUndefined();
    const audio = renderArrangedPcm(loopSection(score, "chorus"), {
      loop: true,
    });
    // 4 bars of 4 beats at 60 bpm.
    expect(audio.frames).toBe(16 * audio.sampleRate);
  });

  test("a form lays each pass's tempo out on the arranged timeline", () => {
    const base = song(8).withTime({ tempo: [{ tick: 4 * 4 * 480, bpm: 60 }] });
    const score = withForm(base, parseForm(base, "chorus verse"));
    const flat = exportScore(score);
    expect(flat.tempoBpm).toBe(60);
    expect(flat.time?.tempo).toEqual([{ tick: 4 * 4 * 480, bpm: 120 }]);
    const audio = renderArrangedPcm(score, { loop: true });
    // 16 beats at 60 then 16 at 120: 16 + 8 seconds.
    expect(audio.frames).toBe(24 * audio.sampleRate);
  });

  test("sections cut what a timed (phasing) track actually plays", () => {
    const base = song(8);
    const phased = new TrackScore({
      ...base.toJSON(),
      tracks: [{ ...base.tracks[0]!, time: { rate: 2 } }],
    });
    const flat = exportScore(withForm(phased, parseForm(phased, "chorus")));
    // Twice the rate: the chorus holds the second run of all 8 notes.
    expect(flat.notes.length).toBe(8);
    expect(flat.tracks[0]!.time).toBeUndefined();
  });

  function cycled(bars: number, perCycle: number, sections: boolean) {
    // Two tracks, each cycling one beat of `perCycle` notes all song long.
    const tracks = ["a", "b"].map((id) => ({
      id,
      name: id,
      instrument: "sine" as const,
      time: { cycle: 480 },
    }));
    const notes = tracks.flatMap((track, index) =>
      Array.from({ length: perCycle }, (_, n) => ({
        id: `${track.id}${n}`,
        trackId: track.id,
        pitch: 60 + index * 7 + (n % 5),
        startTick: Math.floor((n * 480) / perCycle),
        durationTicks: Math.max(1, Math.floor(480 / perCycle)),
        velocity: 0.8,
      })),
    );
    const score = createScore({ bars, tempoBpm: 120, tracks, notes });
    if (!sections) return score;
    return score.withSections([
      { name: "intro", startBar: 0, bars: bars / 2 },
      { name: "phase", startBar: bars / 2, bars: bars / 2 },
    ]);
  }

  function windowRms(pcm: Int16Array, rate: number, from: number, to: number) {
    let sum = 0;
    let count = 0;
    for (let frame = from * rate; frame < to * rate; frame += 1) {
      const value = (pcm[frame * 2] ?? 0) / 32768;
      sum += value * value;
      count += 1;
    }
    return Math.sqrt(sum / Math.max(1, count));
  }

  test("a long timed (cycled) track without sections plays to the end", () => {
    // 32 bars at 120 bpm: 64 s, rendered in windows.
    const audio = renderArrangedPcm(cycled(32, 3, false));
    for (let second = 0; second + 10 <= 60; second += 10)
      expect(
        windowRms(audio.pcm, audio.sampleRate, second, second + 10),
      ).toBeGreaterThan(0.01);
  });

  test("baked timed tracks may hold more notes than a stored score", () => {
    // 64 bars x 4 beats x 12 notes x 2 tracks = 6144 baked notes.
    const score = cycled(64, 12, true);
    expect(score.notes.length).toBe(24);
    const audio = renderArrangedPcm(score);
    expect(audio.frames).toBeGreaterThanOrEqual(128 * audio.sampleRate);
    expect(windowRms(audio.pcm, audio.sampleRate, 110, 120)).toBeGreaterThan(
      0.01,
    );
    expect(exportScore(score).notes.length).toBe(6144);
  });

  test("a long form is mastered once over the whole song", () => {
    const base = song(16).withMaster({ target: -14 });
    const score = withForm(base, parseForm(base, "verse chorus verse chorus"));
    const audio = renderArrangedPcm(score);
    expect(audio.master).toBeDefined();
    expect(audio.frames).toBeGreaterThan(60 * audio.sampleRate);
  });

  test("sections and meter changes do not mix", () => {
    expect(() =>
      song(8).withTime({ meter: [{ bar: 2, beatsPerBar: 3 }] }),
    ).toThrow(/sections need one meter/);
  });
});

describe("section cues in WAV exports", () => {
  test("cues follow the form in playback order", () => {
    const score = song(8, 120);
    const rate = 1000;
    expect(sectionCues(score, rate)).toEqual([
      { frame: 0, label: "verse" },
      { frame: 8000, label: "chorus" },
    ]);
    const formed = withForm(score, parseForm(score, "chorus verse chorus"));
    expect(sectionCues(formed, rate).map((cue) => cue.frame)).toEqual([
      0, 8000, 16000,
    ]);
    expect(sectionCues(createScore({}), rate)).toEqual([]);
  });

  test("withWavCues writes cue and adtl label chunks", () => {
    const plain = encodeWav(new Int16Array(4), 1000, 1);
    expect(withWavCues(plain, [])).toBe(plain);
    const wav = withWavCues(plain, [
      { frame: 0, label: "intro" },
      { frame: 2, label: "drop" },
    ]);
    const view = new DataView(wav.buffer);
    const tag = (at: number) =>
      String.fromCharCode(...wav.subarray(at, at + 4));
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    const chunks: string[] = [];
    for (let at = 12; at < wav.byteLength;) {
      chunks.push(tag(at));
      const size = view.getUint32(at + 4, true);
      at += 8 + size + (size % 2);
    }
    expect(chunks).toEqual(["fmt ", "data", "cue ", "LIST"]);
    const text = new TextDecoder().decode(wav);
    expect(text).toContain("adtl");
    expect(text).toContain("intro");
    expect(text).toContain("drop");
  });
});

describe("dawg render with a sample that cannot load", () => {
  test("fails instead of writing the song without that voice", async () => {
    const { mkdtemp, writeFile, rm, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { encodeLoopDocument } = await import("../../core/loop.ts");
    const { runRenderCommand } = await import("../render.ts");
    const dir = await mkdtemp(join(tmpdir(), "dawg-render-missing-"));
    try {
      const score = createScore({
        tempoBpm: 120,
        bars: 1,
        tracks: [
          {
            id: "s",
            name: "s",
            instrument: "sampler",
            sampler: {
              mode: "keyed",
              voices: { tone: { src: "tracks/s/samples/gone.wav", root: 69 } },
            },
          },
        ],
        notes: [
          {
            id: "a",
            trackId: "s",
            pitch: 69,
            startTick: 0,
            durationTicks: 480,
            velocity: 1,
          },
        ],
      });
      await writeFile(
        join(dir, "song.track.json"),
        JSON.stringify(encodeLoopDocument(score)),
      );
      const err: string[] = [];
      const code = await runRenderCommand(
        ["render", "out.wav", "--import", "song.track.json"],
        dir,
        { write: () => undefined },
        { write: (text: string) => err.push(text) },
      );
      expect(code).toBe(1);
      expect(err.join("")).toContain("sample error");
      expect(err.join("")).toContain("render failed · 1 sample voice");
      expect(await stat(join(dir, "out.wav")).catch(() => undefined)).toBe(
        undefined,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("windowed renders keep the piano pedals (0.6.1)", () => {
  const rate = 22050;
  const ticks = 4 * 480;
  function rmsDb(pcm: Int16Array, fromSecond: number, toSecond: number) {
    const slice = pcm.subarray(fromSecond * rate * 2, toSecond * rate * 2);
    let sum = 0;
    for (const sample of slice) sum += sample * sample;
    return 10 * Math.log10(sum / Math.max(1, slice.length) + 1e-9);
  }
  function score(pedals: boolean) {
    // 28 bars at 120 bpm: 56 s, so the export renders in windows. Una corda
    // goes down just before bar 20; sostenuto catches the bar-20 key and
    // holds it to bar 24.
    return createScore({
      bars: 28,
      tempoBpm: 120,
      tracks: [
        {
          id: "p",
          name: "p",
          instrument: "grand",
          keys: {},
          ...(pedals
            ? {
                softPedal: [{ tick: 20 * ticks - 240, state: "down" }],
                sostenuto: [
                  { tick: 20 * ticks + 240, state: "down" },
                  { tick: 24 * ticks, state: "up" },
                ],
              }
            : {}),
        },
      ],
      notes: [
        {
          id: "a",
          trackId: "p",
          pitch: 48,
          startTick: 0,
          durationTicks: 480,
          velocity: 0.6,
        },
        {
          id: "b",
          trackId: "p",
          pitch: 60,
          startTick: 20 * ticks,
          durationTicks: 480,
          velocity: 0.8,
        },
      ],
    } as Parameters<typeof createScore>[0]).withSections(
      [{ name: "all", startBar: 0, bars: 28 }],
      [],
    );
  }

  // Three full 56-70 s renders, deterministic (same bytes every run): about
  // 0.5-1 s on CI runners, but 5.2 s once on a stalled runner, past bun's
  // default 5 s. The budget is for the runner, not for variable work.
  test("una corda and sostenuto past bar 20 match the one-pass render", () => {
    const windowed = renderArrangedPcm(score(true), { sampleRate: rate });
    const single = renderScorePcm(applySectionChanges(score(true)), {
      sampleRate: rate,
      maxSeconds: 70,
    });
    const plain = renderScorePcm(applySectionChanges(score(false)), {
      sampleRate: rate,
      maxSeconds: 70,
    });
    // Attack under una corda (bar 20 = 40 s) and the latched tail.
    for (const [from, to] of [
      [40, 40.4],
      [43, 46],
    ] as const)
      expect(
        Math.abs(rmsDb(windowed.pcm, from, to) - rmsDb(single.pcm, from, to)),
      ).toBeLessThanOrEqual(1);
    // The pedals are audible there, so the match means something: una
    // corda lowers the attack peak (keys.md 9.12), in both renders.
    const peakDb = (pcm: Int16Array) => {
      let top = 0;
      for (const x of pcm.subarray(40 * rate * 2, 40.2 * rate * 2))
        top = Math.max(top, Math.abs(x));
      return 20 * Math.log10(top);
    };
    expect(peakDb(plain.pcm) - peakDb(single.pcm)).toBeGreaterThan(1.5);
    expect(peakDb(plain.pcm) - peakDb(windowed.pcm)).toBeGreaterThan(1.5);
    expect(
      rmsDb(single.pcm, 43, 46) - rmsDb(plain.pcm, 43, 46),
    ).toBeGreaterThan(10);
  }, 30_000);
});
