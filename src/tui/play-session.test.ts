import { describe, expect, test } from "bun:test";
import { createScore, type TrackScore } from "../../core/score.ts";
import { pedalStateAt, type PedalEvent } from "../../core/expression.ts";
import { loopSection } from "../../core/sections.ts";
import { scoreBeatAt } from "../audio/arrange.ts";
import type { ClickBus } from "../audio/engine.ts";
import type { LiveNotePcm } from "../audio/live.ts";
import {
  PlaySession,
  quantize,
  recordOperations,
  recordPedalOperation,
  type LiveEngine,
  type PlayHost,
} from "./play-session.ts";
import { defaultChordSettings, type ChordSettings } from "./play-chords.ts";

class FakeEngine implements LiveEngine {
  readonly sampleRate = 22_050;
  canMonitor = true;
  lead: number | undefined;
  monitoring = false;
  click: ClickBus | undefined;
  readonly on = new Map<number, LiveNotePcm>();
  readonly off: number[] = [];
  constructor(private readonly now: () => number) {}
  get leadMs(): number {
    return this.lead ?? 200;
  }
  async monitor(on: boolean): Promise<void> {
    this.monitoring = on;
  }
  setLeadMs(ms: number | undefined): void {
    this.lead = ms;
  }
  noteOn(id: number, note: LiveNotePcm): number {
    this.on.set(id, note);
    return this.now() + this.leadMs;
  }
  noteOff(id: number): void {
    this.off.push(id);
  }
  setClick(click: ClickBus | undefined): void {
    this.click = click;
  }
}

function harness(
  score: TrackScore,
  trackId = "lead",
  chords: Partial<ChordSettings> = { mode: "manual", explicit: true },
) {
  const state = {
    score,
    now: 0,
    playing: false,
    startMs: 0,
    startBeat: 0,
    commits: [] as { kind: string; payload: Record<string, unknown> }[],
    cards: [] as string[],
  };
  let ids = 0;
  const engine = new FakeEngine(() => state.now);
  const beatMs = () => 60_000 / state.score.tempoBpm;
  const host: PlayHost = {
    score: () => state.score,
    trackId: () => trackId,
    now: () => state.now,
    playing: () => state.playing,
    beatAt: (ms) =>
      state.playing
        ? state.startBeat + (ms - state.startMs) / beatMs()
        : state.startBeat,
    engine: () => engine,
    async commit(next, kind, payload) {
      state.score = next;
      state.commits.push({ kind, payload });
    },
    async startTransport(beat) {
      state.playing = true;
      state.startBeat = beat;
      state.startMs = state.now;
    },
    async stopTransport() {
      state.playing = false;
    },
    card: (text) => state.cards.push(text),
    newNoteId: () => `rec-${++ids}`,
  };
  const settings = { ...defaultChordSettings(), ...chords };
  return {
    state,
    engine,
    host,
    session: new PlaySession(host, { chords: settings }),
  };
}

function leadScore(): TrackScore {
  return createScore({
    tempoBpm: 120,
    bars: 2,
    tracks: [{ id: "lead", name: "keys", instrument: "piano" }],
  });
}

describe("PlaySession", () => {
  test("a drum kit labels keys by drum and hides chords", async () => {
    const score = createScore({
      tempoBpm: 120,
      bars: 1,
      tracks: [{ id: "drums", name: "drums", instrument: "kit" }],
    });
    const { session } = harness(score, "drums", { mode: "auto" });
    await session.enter();
    const keys = session.strip(0);
    const label = (key: string) => keys.find((k) => k.key === key)?.label;
    expect(label("a")).toBe("kick");
    expect(label("s")).toBe("snr");
    expect(label("t")).toBe("chh");
    expect(keys.some((k) => k.label === "C2")).toBe(false);
    expect(keys.some((k) => k.chord)).toBe(false);
    const view = session.header();
    expect(view.range).toBe("drums");
    expect(view.chords).toBeUndefined();
    expect(view.legend).toBeUndefined();
  });

  test("enter drops the lead and monitors; exit restores", async () => {
    const { session, engine } = harness(leadScore());
    await session.enter();
    expect(engine.lead).toBe(60);
    expect(engine.monitoring).toBe(true);
    await session.exit();
    expect(engine.lead).toBeUndefined();
    expect(engine.monitoring).toBe(false);
  });

  test("a note key sounds through the engine at the play lead", async () => {
    const { session, engine } = harness(leadScore());
    await session.enter();
    expect(session.press("a")).toEqual({ type: "handled" });
    expect(engine.on.size).toBe(1);
    expect(session.lastLatencyMs).toBe(60);
    expect(session.press("]")).toEqual({ type: "unmapped" });
    expect(session.press("\u001b")).toEqual({
      type: "command",
      command: "exit",
    });
  });

  test("records quantized notes once the playhead leaves the bar", async () => {
    const { session, state } = harness(leadScore());
    await session.enter();
    session.press("r");
    expect(session.armed).toBe(true);
    session.press(" "); // the caller handles space
    expect(session.startWithCountIn()).toBe(true);
    // One bar count-in at 120 BPM = 2 s.
    expect(session.header().countIn).toBe("count-in 4");
    state.now = 2_000;
    session.tick();
    expect(state.playing).toBe(true);
    expect(session.recording).toBe(true);
    // Beat 1.05 → quantized to 1 on the 1/16 grid.
    state.now = 2_000 + 525;
    session.tick();
    session.press("a");
    state.now = 2_000 + 1_000;
    session.tick();
    expect(state.commits).toHaveLength(0);
    // Into bar 2: bar 1 commits as one undo entry.
    state.now = 2_000 + 2_010;
    session.tick();
    await session.stopRecording();
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0]!.kind).toBe("score.record");
    const notes = state.score.notes.filter((note) => note.trackId === "lead");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.startTick).toBe(state.score.ticksPerBeat);
    expect(notes[0]!.pitch).toBe(48);
    expect(notes[0]!.durationTicks).toBe(state.score.ticksPerBeat / 4);
    expect(state.cards.at(-1)).toContain("recorded 1 note");
  });

  test("Tab sustain records pedal events; notes keep their key length", async () => {
    const { session, state } = harness(leadScore());
    await session.enter();
    session.press("r");
    session.setCountIn(0);
    session.startWithCountIn();
    session.tick();
    expect(session.recording).toBe(true);
    // Pedal down on beat 0, a note, pedal up on beat 2 (500 ms per beat).
    session.press("\t");
    session.press("a");
    state.now = 1_000;
    session.press("\t");
    state.now = 2_010;
    session.tick();
    await session.stopRecording();
    const tpb = state.score.ticksPerBeat;
    const lead = state.score.tracks.find((track) => track.id === "lead")!;
    expect(lead.pedal).toEqual([
      { tick: 0, state: "down" },
      { tick: 2 * tpb, state: "up" },
    ]);
    const notes = state.score.notes.filter((note) => note.trackId === "lead");
    expect(notes).toHaveLength(1);
    // The key's gate length, not the pedal-held two beats.
    expect(notes[0]!.durationTicks).toBe(tpb / 4);
    expect(state.cards.at(-1)).toContain("2 pedal");
  });

  test("replace erases the pass's bars of old pedal events", () => {
    const score = createScore({
      tempoBpm: 120,
      bars: 2,
      tracks: [
        {
          id: "lead",
          pedal: [
            { tick: 0, state: "down" },
            { tick: 4 * 480, state: "up" },
          ],
        },
      ],
    });
    const tpb = score.ticksPerBeat;
    const op = recordPedalOperation(score, {
      trackId: "lead",
      events: [{ beat: 9, state: "down" }],
      eraseBars: [0],
    });
    // Beat 9 wraps into the 8-beat loop at beat 1.
    expect(op).toEqual({
      type: "updateTrack",
      trackId: "lead",
      patch: {
        pedal: [
          { tick: tpb, state: "down" },
          { tick: 4 * 480, state: "up" },
        ],
      },
    });
    expect(
      recordPedalOperation(score, { trackId: "lead", events: [] }),
    ).toBeUndefined();
  });

  test("a pedal held across the loop seam stays down from tick 0", () => {
    const score = createScore({
      tempoBpm: 120,
      bars: 4,
      tracks: [{ id: "lead", name: "keys", instrument: "piano" }],
    });
    const op = recordPedalOperation(score, {
      trackId: "lead",
      events: [
        { beat: 14, state: "down" },
        { beat: 18, state: "up" },
      ],
    });
    const pedal = (op as unknown as { patch: { pedal: PedalEvent[] } }).patch
      .pedal;
    expect(pedal).toEqual([
      { tick: 0, state: "down" },
      { tick: 960, state: "up" },
      { tick: 6720, state: "down" },
    ]);
    expect(pedalStateAt(pedal, 480)).toBe("down");
    expect(pedalStateAt(pedal, 1440)).toBe("up");
  });

  test("replace restores the pedal state at the erased range's edges", () => {
    const score = createScore({
      tempoBpm: 120,
      bars: 3,
      tracks: [
        {
          id: "lead",
          pedal: [
            { tick: 0, state: "down" },
            { tick: 6 * 480, state: "up" },
            { tick: 7 * 480, state: "down" },
          ],
        },
      ],
    });
    // Erasing bar 2 (beats 4-8) with nothing played: the old lift goes,
    // so the bar starts up, and bar 3 resumes the old held pedal.
    const op = recordPedalOperation(score, {
      trackId: "lead",
      events: [],
      eraseBars: [1],
    });
    expect(
      (op as unknown as { patch: { pedal: PedalEvent[] } }).patch.pedal,
    ).toEqual([
      { tick: 0, state: "down" },
      { tick: 4 * 480, state: "up" },
      { tick: 8 * 480, state: "down" },
    ]);
    // A take that entered the bar with the pedal held keeps it held.
    const held = recordPedalOperation(score, {
      trackId: "lead",
      events: [],
      eraseBars: [1],
      eraseStates: new Map([[1, "down"]]),
    });
    expect(
      (held as unknown as { patch: { pedal: PedalEvent[] } }).patch.pedal,
    ).toEqual([{ tick: 0, state: "down" }]);
  });

  test("a full pedal lane never costs the take's notes", async () => {
    const full = Array.from({ length: 1024 }, (_, tick) => ({
      tick,
      state: tick % 2 === 0 ? ("down" as const) : ("up" as const),
    }));
    const score = createScore({
      tempoBpm: 120,
      bars: 2,
      tracks: [{ id: "lead", name: "keys", instrument: "piano", pedal: full }],
    });
    const { session, state } = harness(score);
    await session.enter();
    session.press("r");
    session.setCountIn(0);
    session.startWithCountIn();
    session.tick();
    state.now = 1_500;
    session.press("\t");
    session.press("a");
    state.now = 1_800;
    session.press("\t");
    state.now = 2_010;
    session.tick();
    await session.stopRecording();
    const notes = state.score.notes.filter((note) => note.trackId === "lead");
    expect(notes).toHaveLength(1);
    expect(state.score.tracks[0]!.pedal).toHaveLength(1024);
    expect(state.cards.at(-1)).toContain("pedal lane is full");
  });

  test("a failed commit keeps the take for the next flush", async () => {
    const { session, state, host } = harness(leadScore());
    const commit = host.commit;
    let fail = true;
    host.commit = async (next, kind, payload) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      await commit(next, kind, payload);
    };
    await session.enter();
    session.press("r");
    session.setCountIn(0);
    session.startWithCountIn();
    session.tick();
    session.press("\t");
    session.press("a");
    state.now = 1_000;
    session.press("\t");
    state.now = 2_010;
    session.tick();
    await session.stopRecording();
    // The bar flush failed; stopping retried and committed the same take.
    expect(state.cards.some((card) => card.includes("disk full"))).toBe(true);
    expect(state.score.notes).toHaveLength(1);
    expect(state.score.tracks[0]!.pedal).toHaveLength(2);
  });

  test("recording over a looped section lands inside the section", async () => {
    const score = loopSection(
      createScore({
        tempoBpm: 120,
        bars: 24,
        tracks: [{ id: "lead", name: "keys", instrument: "piano" }],
      }).withSections([{ name: "chorus", startBar: 16, bars: 8 }], []),
      "chorus",
    );
    const { session, state, host } = harness(score);
    host.scoreBeat = (beat) => scoreBeatAt(state.score, beat);
    await session.enter();
    session.press("r");
    state.now = 0;
    host.startTransport(0);
    session.tick();
    // Transport beat 1 of the looped render is the chorus's bar 17, beat 2.
    state.now = 500;
    session.tick();
    session.press("a");
    state.now = 2_010;
    session.tick();
    await session.stopRecording();
    const notes = state.score.notes.filter((note) => note.trackId === "lead");
    expect(notes).toHaveLength(1);
    const ticksPerBar = 4 * state.score.ticksPerBeat;
    expect(notes[0]!.startTick).toBe(
      16 * ticksPerBar + state.score.ticksPerBeat,
    );
  });

  describe("loop recording (op1-ux §4.7)", () => {
    function loopScore(): TrackScore {
      return createScore({
        tempoBpm: 120,
        bars: 8,
        tracks: [{ id: "lead", name: "keys", instrument: "piano" }],
      }).withLoop({ startBar: 4, bars: 2 });
    }
    const BAR_MS = 2_000;
    const PASS_MS = 2 * BAR_MS;

    async function looping(score = loopScore()) {
      const rig = harness(score);
      rig.host.scoreBeat = (beat) => scoreBeatAt(rig.state.score, beat);
      await rig.session.enter();
      rig.session.press("r");
      rig.state.now = 0;
      await rig.host.startTransport(0);
      rig.session.tick();
      return rig;
    }

    /** Tap a key at `ms` (released at once), then tick. */
    function tap(
      rig: Awaited<ReturnType<typeof looping>>,
      ms: number,
      key = "a",
    ) {
      rig.state.now = ms;
      rig.session.tick();
      rig.session.press(key);
    }

    test("3 passes over a 2-bar loop are 3 revisions, inside bars 5-6", async () => {
      const rig = await looping();
      for (let pass = 0; pass < 3; pass += 1) {
        tap(rig, pass * PASS_MS + 500, "asd"[pass]);
        // Crossing the loop's inner bar line commits nothing.
        rig.state.now = pass * PASS_MS + BAR_MS + 10;
        rig.session.tick();
        await Promise.resolve();
        expect(rig.state.commits).toHaveLength(pass);
        tap(rig, pass * PASS_MS + BAR_MS + 1_000, "fgh"[pass]);
        rig.state.now = (pass + 1) * PASS_MS + 10;
        rig.session.tick();
        await rig.session["flushing"];
        expect(rig.state.commits).toHaveLength(pass + 1);
      }
      expect(rig.state.commits.map((commit) => commit.payload.pass)).toEqual([
        1, 2, 3,
      ]);
      expect(rig.state.cards.at(-1)).toContain("pass 3 · +2 notes");
      const ticksPerBar = 4 * rig.state.score.ticksPerBeat;
      const notes = rig.state.score.notes.filter(
        (note) => note.trackId === "lead",
      );
      expect(notes.length).toBeGreaterThanOrEqual(2);
      for (const note of notes) {
        expect(note.startTick).toBeGreaterThanOrEqual(4 * ticksPerBar);
        expect(note.startTick).toBeLessThan(6 * ticksPerBar);
      }
      expect(rig.session.header().pass).toBe("↻ 5–6 · pass 4");
    });

    test("an empty pass writes nothing", async () => {
      const rig = await looping();
      tap(rig, 500);
      rig.state.now = PASS_MS + 10;
      rig.session.tick();
      await rig.session["flushing"];
      expect(rig.state.commits).toHaveLength(1);
      rig.state.now = 2 * PASS_MS + 10;
      rig.session.tick();
      await rig.session["flushing"];
      expect(rig.state.commits).toHaveLength(1);
    });

    test("replace erases only the bars each pass crossed", async () => {
      const base = loopScore();
      const ticksPerBar = 4 * base.ticksPerBeat;
      const seeded = createScore({
        ...base.toJSON(),
        notes: [3, 4, 5, 6].map((bar) => ({
          id: `old-${bar}`,
          trackId: "lead",
          pitch: 72,
          startTick: bar * ticksPerBar,
          durationTicks: 120,
          velocity: 0.8,
        })),
      } as Parameters<typeof createScore>[0]);
      const rig = await looping(seeded);
      rig.session.press("R");
      expect(rig.session.replace).toBe(true);
      tap(rig, 500);
      rig.state.now = PASS_MS + 10;
      rig.session.tick();
      await rig.session["flushing"];
      const ids = rig.state.score.notes.map((note) => note.id);
      expect(ids).toContain("old-3");
      expect(ids).toContain("old-6");
      expect(ids).not.toContain("old-4");
      expect(ids).not.toContain("old-5");
    });

    test("replace refuses while another pane records the track, naming it", async () => {
      const rig = await looping();
      rig.host.recordingElsewhere = (trackId) =>
        trackId === "lead" ? "pane B" : undefined;
      const result = rig.session.recordCommand("replace");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("pane B is recording keys");
      expect(rig.session.replace).toBe(false);
      // Overdub alongside is fine.
      expect(rig.session.recordCommand("overdub").ok).toBe(true);
    });

    test("an armed replace pass lands as overdub once another pane records", async () => {
      const base = loopScore();
      const ticksPerBar = 4 * base.ticksPerBeat;
      const seeded = createScore({
        ...base.toJSON(),
        notes: [
          {
            id: "theirs",
            trackId: "lead",
            pitch: 72,
            startTick: 4 * ticksPerBar,
            durationTicks: 120,
            velocity: 0.8,
          },
        ],
      } as Parameters<typeof createScore>[0]);
      const rig = await looping(seeded);
      expect(rig.session.recordCommand("replace").ok).toBe(true);
      rig.host.recordingElsewhere = () => "pane B";
      tap(rig, 500);
      rig.state.now = PASS_MS + 10;
      rig.session.tick();
      await rig.session["flushing"];
      expect(rig.state.score.notes.map((note) => note.id)).toContain("theirs");
      expect(rig.state.cards.join("\n")).toContain("pass kept as overdub");
    });

    test("recording over a form's repeat (a TAPE ghost) lands in its source", async () => {
      // Form verse, chorus, verse: transport bar 4 is the verse again, the
      // ░ ghost pass on TAPE; its notes belong to the verse's bars 0-1.
      const score = createScore({
        tempoBpm: 120,
        bars: 4,
        tracks: [{ id: "lead", name: "keys", instrument: "piano" }],
      }).withSections(
        [
          { name: "verse", startBar: 0, bars: 2 },
          { name: "chorus", startBar: 2, bars: 2 },
        ],
        [{ section: "verse" }, { section: "chorus" }, { section: "verse" }],
      );
      const rig = await looping(score);
      tap(rig, 4 * BAR_MS + 500);
      rig.state.now = 5 * BAR_MS + 10;
      rig.session.tick();
      await rig.session["flushing"];
      const notes = rig.state.score.notes.filter(
        (note) => note.trackId === "lead",
      );
      expect(notes).toHaveLength(1);
      const ticksPerBar = 4 * rig.state.score.ticksPerBeat;
      expect(notes[0]!.startTick).toBeLessThan(ticksPerBar);
      expect(rig.state.commits[0]!.payload.pass).toBeUndefined();
    });

    test("without a loop, each bar is still one revision", async () => {
      const rig = await looping(
        createScore({
          tempoBpm: 120,
          bars: 8,
          tracks: [{ id: "lead", name: "keys", instrument: "piano" }],
        }),
      );
      tap(rig, 500);
      rig.state.now = BAR_MS + 10;
      rig.session.tick();
      await rig.session["flushing"];
      expect(rig.state.commits).toHaveLength(1);
      expect(rig.state.commits[0]!.payload.pass).toBeUndefined();
      expect(rig.session.header().pass).toBeUndefined();
    });
  });

  test("nothing records while the transport is stopped (free play)", async () => {
    const { session, state } = harness(leadScore());
    await session.enter();
    session.press("r");
    session.press("a");
    session.press("s");
    await session.stopRecording();
    expect(state.commits).toHaveLength(0);
  });

  test("count-in 0 starts at once; the click follows the count-in", async () => {
    const { session, state, engine } = harness(leadScore());
    await session.enter();
    session.press("r");
    session.setCountIn(2);
    session.startWithCountIn();
    expect(engine.click).toBeDefined();
    // Two bars of 4 beats before beat 0.
    expect(session.clickBeatAt(0)).toBe(-8);
    expect(session.clickBeatAt(500)).toBe(-7);
    state.now = 4_000;
    session.tick();
    expect(state.playing).toBe(true);
    // Click off and no count-in: silent.
    expect(session.clickBeatAt(4_500)).toBeUndefined();
    session.press("m");
    expect(session.clickBeatAt(4_500)).toBe(1);
  });

  test("/click parses on, off and volume", () => {
    const { session } = harness(leadScore());
    expect(session.clickCommand("on")).toBe("click on · 60%");
    expect(session.clickCommand("40%")).toBe("click on · 40%");
    expect(session.clickCommand("off")).toBe("click off");
    expect(session.clickCommand("loud")).toContain("usage");
  });

  test("header shows range, velocity, record and click", async () => {
    const { session } = harness(leadScore());
    await session.enter();
    session.press("x");
    session.press("v");
    session.press("r");
    const header = session.header();
    expect(header.range).toBe("C4–F5");
    expect(header.velocity).toBe(116);
    expect(header.armed).toBe(true);
    expect(header.recording).toBe(false);
    expect(header.keys).toHaveLength(18);
    expect(header.keys[0]!.label).toBe("C4");
    expect(header.keys[1]!.label).toBe("C#");
  });

  test("bass tracks sit an octave low", () => {
    const { session } = harness(
      createScore({
        tracks: [{ id: "lead", name: "b", instrument: "bass" }],
      }),
    );
    expect(session.keyboard.range).toBe("C2–F3");
  });
});

describe("recordOperations", () => {
  test("wraps into the loop, skips duplicates, replaces bars", () => {
    const tpb = leadScore().ticksPerBeat;
    let id = 0;
    const ops = recordOperations(
      createScore({
        bars: 2,
        tracks: [{ id: "lead", name: "keys", instrument: "piano" }],
        notes: [
          {
            id: "old",
            trackId: "lead",
            startTick: 4 * tpb,
            durationTicks: tpb,
            pitch: 60,
            velocity: 0.8,
          },
        ],
      }),
      {
        trackId: "lead",
        notes: [
          { pitch: 62, velocity: 64, beat: 8 + 4.1, beats: 1.1 },
          { pitch: 62, velocity: 64, beat: 4.12, beats: 0.2 },
        ],
        grid: 0.25,
        eraseBars: [1],
        newId: () => `n${++id}`,
      },
    );
    expect(ops[0]).toEqual({ type: "removeNote", noteId: "old" });
    const adds = ops.filter((op) => op.type === "addNote");
    // Beat 12.1 wraps to 4.0 in an 8-beat loop; the second is the same step.
    expect(adds).toHaveLength(1);
    expect(adds[0]!.type === "addNote" && adds[0]!.note.startTick).toBe(
      4 * tpb,
    );
    expect(adds[0]!.type === "addNote" && adds[0]!.note.durationTicks).toBe(
      tpb,
    );
  });

  test("quantize snaps to the nearest step", () => {
    expect(quantize(1.13, 0.25)).toBe(1.25);
    expect(quantize(1.12, 0.25)).toBe(1);
  });

  test("pitched tracks default to auto chords; bass tracks to manual", () => {
    expect(harness(leadScore(), "lead", {}).session.chords.settings.mode).toBe(
      "auto",
    );
    const bass = harness(
      createScore({ tracks: [{ id: "lead", name: "b", instrument: "bass" }] }),
      "lead",
      {},
    );
    expect(bass.session.chords.settings.mode).toBe("manual");
  });

  test("a non-12 tuning or a mono glide line defaults to single notes", () => {
    const pelog = createScore({
      tuning: { name: "pelog" },
      tracks: [{ id: "lead", name: "polos", instrument: "piano" }],
    });
    expect(harness(pelog, "lead", {}).session.chords.settings.mode).toBe(
      "manual",
    );
    const retuned = createScore({
      tuning: { edo: 12, ref: 446 },
      tracks: [{ id: "lead", name: "keys", instrument: "piano" }],
    });
    expect(harness(retuned, "lead", {}).session.chords.settings.mode).toBe(
      "auto",
    );
    const acid = createScore({
      tracks: [
        {
          id: "lead",
          name: "acid",
          instrument: "saw",
          glide: { time: 0.06, mode: "legato" },
        },
      ],
    });
    expect(harness(acid, "lead", {}).session.chords.settings.mode).toBe(
      "manual",
    );
  });
});

function keyedScore(key = "C major"): TrackScore {
  return createScore({
    tempoBpm: 120,
    bars: 2,
    key,
    tracks: [{ id: "lead", name: "keys", instrument: "piano" }],
  });
}

/** Run a recording: `play` presses keys at times (ms after the downbeat). */
async function recordChords(
  score: TrackScore,
  chords: Partial<ChordSettings>,
  play: (at: (ms: number) => void, press: (key: string) => void) => void,
) {
  const h = harness(score, "lead", chords);
  await h.session.enter();
  h.session.setCountIn(0);
  h.session.press("r");
  h.session.startWithCountIn();
  h.session.tick();
  const at = (ms: number) => {
    h.state.now = ms;
    h.session.tick();
  };
  play(at, (key) => h.session.press(key));
  at(4_010);
  await h.session.stopRecording();
  const notes = h.state.score.notes
    .filter((note) => note.trackId === "lead")
    .map((note) => ({
      pitch: note.pitch,
      beat: note.startTick / h.state.score.ticksPerBeat,
      beats: note.durationTicks / h.state.score.ticksPerBeat,
    }))
    .sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  return { ...h, notes };
}

describe("PlaySession chord mode", () => {
  test("auto: a note key plays and records the key's diatonic chord", async () => {
    const { notes, engine, session, state } = await recordChords(
      keyedScore(),
      { mode: "auto", explicit: true },
      (at, press) => {
        at(0);
        press("s"); // D in C major → Dm
      },
    );
    expect(notes.map((note) => note.pitch)).toEqual([50, 53, 57]);
    expect(notes.every((note) => note.beat === 0)).toBe(true);
    // All three voices sounded live.
    expect(engine.on.size).toBeGreaterThanOrEqual(3);
    expect(session.chords.last?.name).toBe("Dm");
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0]!.kind).toBe("score.record");
    expect(session.header().chords).toContain("AUTO C major");
    expect(session.header().chords).toContain("Dm (ii)");
  });

  test("consecutive chords voice-lead (G after C stays close)", async () => {
    const { notes } = await recordChords(
      keyedScore(),
      { mode: "auto", explicit: true },
      (at, press) => {
        at(0);
        press("a");
        at(1_000);
        press("g");
      },
    );
    const second = notes.filter((note) => note.beat === 2).map((n) => n.pitch);
    // Root position G would be 55,59,62; voice-led from C-E-G it is B-D-G
    // (moves of 1, 2 and 0 semitones).
    expect(second.sort()).toEqual([47, 50, 55]);
  });

  test("manual: single notes until a chord type is latched", async () => {
    const { notes } = await recordChords(
      leadScore(),
      { mode: "manual", explicit: true },
      (at, press) => {
        at(0);
        press("a");
        at(1_000);
        press("2"); // min
        press("6"); // m7
        press("s");
      },
    );
    expect(notes.filter((n) => n.beat === 0).map((n) => n.pitch)).toEqual([48]);
    const chord = notes.filter((n) => n.beat === 2).map((n) => n.pitch);
    expect(
      chord.map((pitch) => (pitch - 50 + 120) % 12).sort((a, b) => a - b),
    ).toEqual([0, 3, 7, 10]);
  });

  test("arp-up records one voice per grid step inside the held length", async () => {
    const { notes } = await recordChords(
      keyedScore(),
      { mode: "auto", explicit: true, perform: "arp-up", rate: "1/8" },
      (at, press) => {
        at(0);
        press("\t"); // sustain latch: the chord holds until Tab again
        press("a");
        at(1_000);
        press("\t");
      },
    );
    const first = notes.filter((note) => note.beat < 2);
    expect(first.length).toBeGreaterThan(1);
    for (const note of first) {
      expect((note.beat * 2) % 1).toBe(0);
      expect(note.beats).toBe(0.5);
    }
    expect(first.slice(0, 3).map((note) => note.pitch)).toEqual([48, 52, 55]);
  });

  test("pattern perform records the offbeat rhythm on the grid", async () => {
    const { notes, state } = await recordChords(
      keyedScore(),
      { mode: "auto", explicit: true, perform: "pattern", pattern: "offbeat" },
      (at, press) => {
        at(0);
        press("\t");
        press("a"); // C major, held for the bar
        at(1_990);
        press("\t");
      },
    );
    const beats = [...new Set(notes.map((note) => note.beat))];
    expect(beats).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(notes.every((note) => note.beats === 0.25)).toBe(true);
    const recorded = state.score.notes.filter((n) => n.trackId === "lead");
    // Offbeat accents are 0.9 of the press velocity.
    expect(new Set(recorded.map((n) => n.velocity)).size).toBe(1);
  });

  test("bass solo records only the bass under a chord", async () => {
    const { notes } = await recordChords(
      keyedScore(),
      { mode: "auto", explicit: true, bass: "solo" },
      (at, press) => {
        at(0);
        press("s"); // Dm → bass D2
      },
    );
    expect(notes.map((note) => note.pitch)).toEqual([26]);
  });

  test("bass unison doubles a manual single note two octaves down", async () => {
    const { notes } = await recordChords(
      leadScore(),
      { mode: "manual", explicit: true, bass: "unison" },
      (at, press) => {
        at(0);
        press("d"); // E4
      },
    );
    expect(notes.map((note) => note.pitch)).toEqual([28, 52]);
  });

  test("n plays the suggested next chord through its root's key", async () => {
    const { session } = harness(keyedScore(), "lead", {
      mode: "auto",
      explicit: true,
      preset: "axis",
    });
    await session.enter();
    session.press("a"); // C
    const suggested = session.header().chords!;
    expect(suggested).toContain("next G");
    session.press("n");
    expect(session.chords.last?.name).toBe("G");
  });

  test("the strip labels keys with the chord they play in auto", async () => {
    const { session } = harness(keyedScore("A minor"), "lead", {
      mode: "auto",
      explicit: true,
    });
    await session.enter();
    const labels = new Map(
      session.header().keys.map((key) => [key.key, key.label]),
    );
    expect(
      ["a", "s", "d", "f", "g", "h", "j"].map((key) => labels.get(key)),
    ).toEqual(["C", "Dm", "Em", "F", "G", "Am", "Bdim"]);
  });
});

describe("scale degrees (i)", () => {
  test("i toggles degree mode, which follows the song key and tuning", async () => {
    const { session, state } = harness(
      leadScore().withKey("D dorian"),
      "lead",
      {
        mode: "off",
        explicit: true,
      },
    );
    await session.enter();
    expect(session.press("i")).toEqual({ type: "handled" });
    expect(session.status).toContain("scale degrees · D dorian");
    // a s d play D E F from D3, the tonic in the default C3 octave.
    expect(session.keyboard.range).toBe("D3–G4");
    expect(
      session
        .strip()
        .slice(0, 3)
        .map((cell) => cell.label),
    ).toEqual(["D3", "E", "F"]);
    // The tonic is the root a player anchors on; it keeps its octave.
    expect(session.strip()[0]!.root).toBe(true);
    state.score = state.score.withTuning({ edo: 19 });
    const cells = session.strip();
    expect(cells).toHaveLength(11);
    expect(session.keyboard.degrees?.period).toBe(19);
    session.press("i");
    expect(session.status).toContain("chromatic");
    expect(session.strip()).toHaveLength(18);
  });
});

describe("PlaySession throat tracks (f07-sing)", () => {
  test("two keys on a khoomei track: the second releases the first", async () => {
    const score = createScore({
      tempoBpm: 120,
      bars: 2,
      tracks: [
        {
          id: "lead",
          name: "throat",
          instrument: "sing",
          sing: { preset: "khoomei" },
        },
      ],
    } as never);
    const { session, engine } = harness(score);
    await session.enter();
    expect(session.press("a")).toEqual({ type: "handled" });
    const [first] = [...engine.on.keys()];
    expect(engine.off).not.toContain(first!);
    expect(session.press("s")).toEqual({ type: "handled" });
    expect(engine.on.size).toBe(2);
    expect(engine.off).toContain(first!);
    // Each note is a whole drone (it sounds from its own start).
    for (const pcm of engine.on.values()) expect(pcm.frames).toBeGreaterThan(0);
  });
});
