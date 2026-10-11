/**
 * Play mode's controller: wires the pure keyboard mapper (play-mode.ts) to
 * live audition, the click bus and recording. Everything it touches goes
 * through a small host interface, so tests drive it with a fake engine and
 * an injected clock, and the TUI loop in main.ts only forwards keys and
 * frames.
 *
 * Recording appends notes to the focused track through ScoreOperations
 * (`addNote`, plus `removeNote` when replacing), committed once per bar as
 * the playhead leaves it: one undo entry per recorded bar, synced to other
 * windows and the project files like any other edit.
 *
 * Chord mode (play-chords.ts) turns a note key into a voiced chord: every
 * voice sounds through the same live path, strums and arpeggios are paced by
 * `tick()`, and a recorded chord is laid out with core/chords.ts `perform`
 * so the score holds exactly what an agent's `write_chords` would write.
 */
import {
  applyScoreOperation,
  type ScoreOperation,
  type TrackScore,
} from "../../core/score.ts";
import {
  EXPRESSION_LIMITS,
  ExpressionValidationError,
  normalizePedal,
  pedalStateAt,
  type PedalEvent,
  type PedalState,
} from "../../core/expression.ts";
import type { ClickBus } from "../audio/engine.ts";
import type { RemoteClick, RemoteNote } from "../session/shared-live.ts";
import {
  DEFAULT_CLICK_VOLUME,
  countInClicks,
  meterClickGrid,
  parseClickArgument,
} from "../audio/click.ts";
import {
  barAt,
  barStartTick,
  bpmAtTick,
  clickTicksOf,
  hasMeterChanges,
  hasTempoMap,
  loopTickAt,
  loopTicksOf,
  transportBar,
  transportBarStart,
} from "../../core/tempo.ts";
import {
  LiveFullRenderer,
  LiveSynth,
  warmLive,
  MAX_LIVE_NOTE_SECONDS,
  type LiveNotePcm,
} from "../audio/live.ts";
import type { SampleBank } from "../audio/samples.ts";
import { loopedSection } from "../audio/arrange.ts";
import { fitting, onFitReady } from "../audio/fit.ts";
import {
  DEFAULT_STRUM,
  degreeOf,
  perform,
  type PerformMode,
  type PerformOptions,
  type PerformedNote,
} from "../../core/chords.ts";
import {
  ChordPad,
  chordCapable,
  defaultChordSettings,
  guitarPerform,
  songKey,
  type ChordSettings,
  type PlayedChord,
} from "./play-chords.ts";
import type { PlayHeaderView, PlayStripKey } from "../../tui/play-strip.ts";
import { resolveTuning, type Tuning } from "../../core/tuning.ts";
import { singThroat } from "../../core/sing.ts";
import {
  NOTE_KEYS,
  PlayKeyboard,
  REPEAT_DELAY_MS,
  degreeLayout,
  playLayoutFor,
  stripCells,
  type PlayAction,
  type PlayCommand,
  type PlayLayout,
  type PlayedNote,
} from "./play-mode.ts";

/** The part of AudioEngine play mode uses. */
export interface LiveEngine {
  readonly sampleRate: number;
  readonly canMonitor: boolean;
  readonly leadMs: number;
  /** The lead play mode pins (15 ms on the native sink, else 60 ms). */
  readonly playLeadMs?: number;
  /** How play mode sounds (`native sink`, `ffplay · no native sink`). */
  readonly audioNote?: string;
  monitor(on: boolean): Promise<void>;
  setLeadMs(ms: number | undefined): void;
  noteOn(id: number, note: LiveNotePcm): number;
  noteOff(id: number): void;
  /** Frames of voice `id` mixed so far, or undefined once it has ended. */
  voicePosition?(id: number): number | undefined;
  setClick(click: ClickBus | undefined): void;
  /**
   * A shared engine (dawgd's, src/session/shared-live.ts) takes note events
   * instead of PCM: it renders the voice itself, so one engine mixes every
   * pane. Returns the monotonic ms the note is scheduled for.
   */
  remoteNote?(id: number, note: RemoteNote): number;
  /** A shared engine's click: on/volume and the count-in, not a closure. */
  remoteClick?(click: RemoteClick): void;
}

export interface PlayHost {
  score(): TrackScore;
  trackId(): string;
  /** Monotonic ms (performance.now()). */
  now(): number;
  playing(): boolean;
  /** Transport beat (unwrapped) at monotonic `ms`. */
  beatAt(ms: number): number;
  /**
   * The score beat transport `beat` plays: inside a looped section, or the
   * matching bar of the form pass. Absent means the transport is the score.
   */
  scoreBeat?(beat: number): number;
  engine(): LiveEngine | undefined;
  samples?(): SampleBank | undefined;
  commit(
    next: TrackScore,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  /** Start the transport at `beat`. */
  startTransport(beat: number): Promise<void>;
  stopTransport(): Promise<void>;
  card(text: string, tone: "info" | "success" | "warning" | "error"): void;
  /**
   * `,` / `.`: load the previous / next preset of the track's category
   * (`preset prev|next`); returns the status line, or undefined.
   */
  presetStep?(step: 1 | -1): string | undefined;
  /**
   * Another pane recording on `trackId` (§12.4): its name (`pane B`), else
   * undefined. A replace pass refuses while one is, since it would erase
   * the other pane's notes.
   */
  recordingElsewhere?(trackId: string): string | undefined;
  /** A played key that is not recorded: the screen glows its lane. */
  ghost?(pitch: number): void;
  newNoteId(): string;
}

/** Grid steps in beats, coarse to fine. */
export const GRIDS: readonly Readonly<{ label: string; beats: number }>[] =
  Object.freeze([
    { label: "1/4", beats: 1 },
    { label: "1/8", beats: 0.5 },
    { label: "1/8T", beats: 1 / 3 },
    { label: "1/16", beats: 0.25 },
    { label: "1/16T", beats: 1 / 6 },
    { label: "1/32", beats: 0.125 },
  ]);
export const DEFAULT_GRID = "1/16";
/** Play mode's queue lead: short enough that a key feels immediate. */
export const PLAY_LEAD_MS = 60;
/** Status while a long fitted sample window computes (fit.ts). */
const FITTING_STATUS = "fitting · the sample plays once ready";
export const FLASH_MS = 110;

export function gridBeats(label: string): number | undefined {
  return GRIDS.find((grid) => grid.label === label.toUpperCase())?.beats;
}

/** Snap `beat` to the nearest multiple of `step`. */
export function quantize(beat: number, step: number): number {
  if (!(step > 0)) return beat;
  return Math.round(beat / step) * step;
}

type Pending = {
  id: number;
  pitch: number;
  velocity: number;
  atMs: number;
  /** Unwrapped transport beat of the press. */
  beat: number;
  releaseAtMs: number;
  /**
   * When the key itself let go. Differs from `releaseAtMs` only while the
   * sustain pedal holds the note: the recorded length is the key's, and the
   * recorded pedal events do the sustaining (as a MIDI CC64 recording does).
   */
  keyUpMs: number;
  /** Set when the key played a chord: laid out with `perform` on flush. */
  chord?: RecordedChord;
};

/** What a recorded chord press expands to. */
export type RecordedChord = Readonly<{
  pitches: readonly number[];
  bass?: number | undefined;
  mode: PerformMode;
  /** Arp step in beats. */
  rate: number;
  octaves: number;
  seed: number;
  /** CHORD_PATTERNS name when `mode` is `pattern`. */
  pattern?: string;
  /** Guitar mode: strokes, speed, tempo, fretting and the chord root. */
  guitar?: Partial<PerformOptions>;
}>;

/** A chord sounding live: its voices start and stop from `tick()`. */
type LiveChord = {
  played: PlayedChord;
  velocity: number;
  startMs: number;
  releaseAtMs: number;
  /** Voices in beats from the press, sorted by start. */
  plan: PerformedNote[];
  next: number;
  /** Live voice id → its plan index, start and own end (Infinity: the key's). */
  sounding: Map<number, { index: number; atMs: number; endMs: number }>;
};

/** Beats a held live chord's plan covers (arps keep stepping this long). */
const LIVE_PLAN_BEATS = 64;
/** Live chord voices use ids far above the keyboard's. */
const VOICE_ID_BASE = 1_000_000_000;

type CountIn = {
  startMs: number;
  beats: number;
  startBeat: number;
  /** Count-in tempo: the tempo where recording starts. */
  bpm: number;
  /** Beats per counted bar and per click (meter-aware). */
  barBeats: number;
  clickBeats: number;
};

export type PlayKeyResult =
  | { type: "handled" }
  | { type: "unmapped" }
  | { type: "command"; command: PlayCommand };

export class PlaySession {
  public readonly keyboard: PlayKeyboard;
  public layout: PlayLayout;
  public armed = false;
  public replace = false;
  public clickOn = false;
  public clickVolume = DEFAULT_CLICK_VOLUME;
  public countInBars = 1;
  public grid = DEFAULT_GRID;
  public status: string | undefined;
  /** Unsubscribes the pending "fit ready" listener (fit.ts). */
  private stopFitWait: (() => void) | undefined;
  /** Scale-degree layout on (`i`); follows key and tuning changes. */
  public degreesOn = false;
  private degreeKey: string | undefined;
  private active = false;
  private synth: LiveSynth | undefined;
  /** Rig voices awaiting their full render: id → released since. */
  private readonly windows = new Map<number, boolean>();
  /** f07-sing: the sounding key on a throat track (one drone, mono). */
  private throatId: number | undefined;
  private readonly fullRenderer = new LiveFullRenderer();
  private readonly pending = new Map<number, Pending>();
  /** Sustain changes while recording (Tab latch or Shift), as pedal events. */
  private pendingPedal: { beat: number; state: PedalState }[] = [];
  /** The pedal state last recorded this pass. */
  private pedalDown = false;
  /** Played note id → recorded score note id, for this pass. */
  private readonly recordedIds = new Set<string>();
  /** In-loop bars the playhead finished while replacing. */
  private readonly replaceBars = new Set<number>();
  /** Live pedal state as the playhead entered each loop bar (replace). */
  private readonly barPedal = new Map<number, PedalState>();
  private lastBar: number | undefined;
  /** Loop recording: the pass (loop wrap) the playhead is in. */
  private lastPass: number | undefined;
  /** Passes committed this take (the header's `pass N`). */
  private passCount = 0;
  private countIn: CountIn | undefined;
  private flushing: Promise<void> = Promise.resolve();
  /** Most recent key-to-sound schedule, ms (lead before device latency). */
  public lastLatencyMs: number | undefined;
  private readonly trackId: string;
  public readonly chords: ChordPad;
  private readonly liveChords = new Map<number, LiveChord>();
  private nextVoiceId = VOICE_ID_BASE;
  /** The `n` key's last route, so its auto-repeats hold one chord. */
  private nRoute:
    { key: string; chord: PlayedChord["chord"]; atMs: number } | undefined;

  /** The track this session plays and records into. */
  public get track(): string {
    return this.trackId;
  }

  public constructor(
    private readonly host: PlayHost,
    options: Readonly<{
      clickOn?: boolean;
      clickVolume?: number;
      chords?: ChordSettings;
    }> = {},
  ) {
    this.trackId = host.trackId();
    const track = this.trackData();
    this.layout = playLayoutFor(track, this.host.score().calibration ?? 0);
    const settings = options.chords ?? defaultChordSettings();
    // Auto chords by default on chord-capable tracks, until chosen by hand.
    // Diatonic triads assume 12-TET and a polyphonic part: a track in
    // another tuning, or a mono/legato glide line, plays single notes.
    if (!settings.explicit)
      settings.mode =
        chordCapable(track) &&
        twelveTet(this.host.score(), track) &&
        (track?.glide === undefined || track.glide.mode === "poly") &&
        !singThroat(track)
          ? "auto"
          : "manual";
    this.chords = new ChordPad(settings, () => this.host.score().key);
    this.keyboard = new PlayKeyboard({ base: this.layout.base });
    this.clickOn = options.clickOn ?? false;
    this.clickVolume = options.clickVolume ?? DEFAULT_CLICK_VOLUME;
  }

  public get on(): boolean {
    return this.active;
  }

  private trackData() {
    return this.host
      .score()
      .tracks.find((track) => track.id === this.host.trackId());
  }

  public get gridStep(): number {
    return gridBeats(this.grid) ?? 0.25;
  }

  /** Gate for a single press: one grid step at the current tempo. */
  public gateMs(): number {
    return (this.gridStep * 60_000) / this.currentBpm();
  }

  /** Tempo at the playhead (the song tempo without a tempo map). */
  private currentBpm(): number {
    const score = this.host.score();
    if (!hasTempoMap(score)) return score.tempoBpm;
    return bpmAtTick(
      score,
      loopTickAt(score, this.host.beatAt(this.host.now())),
    );
  }

  public async enter(): Promise<void> {
    this.active = true;
    const engine = this.host.engine();
    if (engine?.canMonitor) {
      engine.setLeadMs(engine.playLeadMs ?? PLAY_LEAD_MS);
      // The voice's tables and loops are built now, not on the first key.
      warmLive(this.host.score(), this.trackId, engine.sampleRate);
      await engine.monitor(true);
      if (engine.audioNote)
        this.status = `${engine.audioNote} · ${Math.round(engine.leadMs)} ms lead`;
    } else this.status = "no audio · keys still record";
    this.applyClick();
  }

  public async exit(): Promise<void> {
    if (!this.active) return;
    await this.stopRecording();
    this.active = false;
    this.countIn = undefined;
    const engine = this.host.engine();
    if (engine) {
      if (engine.remoteClick) this.sendClick(engine.remoteClick.bind(engine));
      else engine.setClick(this.clickOn ? this.clickBus() : undefined);
      engine.setLeadMs(undefined);
      await engine.monitor(false);
    }
  }

  /** The click bus the engine mixes: count-in, then the transport. */
  public clickBus(): ClickBus {
    const score = this.host.score();
    const count = this.countIn;
    // Without meter changes the fixed beatsPerBar grid clicks as in 0.4.
    let grid: ClickBus["grid"];
    if (count && hasMeterChanges(score))
      grid = (from, to) =>
        countInClicks(
          count.startBeat,
          count.beats / count.barBeats,
          count.barBeats,
          count.clickBeats,
          from,
          to,
        );
    else if (!count && hasMeterChanges(score))
      grid = meterClickGrid(() => this.host.score());
    return {
      volume: this.clickVolume,
      beatsPerBar: score.beatsPerBar,
      subdivision: 1,
      beatAt: (ms) => this.clickBeatAt(ms),
      ...(grid ? { grid } : {}),
    };
  }

  /** Beat the click follows at `ms`, or undefined while silent. */
  public clickBeatAt(ms: number): number | undefined {
    const count = this.countIn;
    if (count) {
      const beatMs = 60_000 / count.bpm;
      return count.startBeat - count.beats + (ms - count.startMs) / beatMs;
    }
    if (!this.clickOn || !this.host.playing()) return undefined;
    return this.host.beatAt(ms);
  }

  private applyClick(): void {
    const engine = this.host.engine();
    if (!engine) return;
    if (engine.remoteClick) {
      this.sendClick(engine.remoteClick.bind(engine));
      return;
    }
    engine.setClick(this.clickOn || this.countIn ? this.clickBus() : undefined);
  }

  /** The click as a shared engine takes it: on, volume, count-in. */
  private sendClick(send: (click: RemoteClick) => void): void {
    const count = this.countIn;
    send({
      on: this.clickOn,
      volume: this.clickVolume,
      ...(count
        ? {
            countIn: {
              startMs: count.startMs,
              startBeat: count.startBeat,
              beats: count.beats,
              barBeats: count.barBeats,
              clickBeats: count.clickBeats,
              bpm: count.bpm,
            },
          }
        : {}),
    });
  }

  /** `/click on|off|<volume>`. */
  public clickCommand(argument: string): string {
    const parsed = parseClickArgument(argument, {
      on: this.clickOn,
      volume: this.clickVolume,
    });
    if ("error" in parsed) return parsed.error;
    this.clickOn = parsed.on;
    this.clickVolume = parsed.volume || this.clickVolume;
    this.applyClick();
    return this.clickOn
      ? `click on · ${Math.round(this.clickVolume * 100)}%`
      : "click off";
  }

  public setCountIn(bars: number): string {
    this.countInBars = Math.max(0, Math.min(2, Math.round(bars)));
    return `count-in · ${this.countInBars} bar${this.countInBars === 1 ? "" : "s"}`;
  }

  public setGrid(label: string): string | undefined {
    const match = GRIDS.find((grid) => grid.label === label.toUpperCase());
    if (!match) return undefined;
    this.grid = match.label;
    return `grid · ${match.label}`;
  }

  /**
   * `keys record [replace|off]` and the r / R keys: arm recording, overdub
   * (additive) or replace (each pass erases the bars it crossed). With a
   * loop set, every pass over it is one commit, so one undo step (§4.7).
   * Replace refuses while another pane records this track (§12.4).
   */
  public recordCommand(
    mode: "overdub" | "replace" | "off",
  ): Readonly<{ ok: boolean; message: string }> {
    if (mode === "off") {
      const was = this.armed;
      this.armed = false;
      this.replace = false;
      if (was) void this.stopRecording();
      this.status = "record off";
      return { ok: true, message: "record off" };
    }
    if (mode === "replace") {
      const other = this.host.recordingElsewhere?.(this.trackId);
      if (other) {
        const message = `${other} is recording ${this.trackName()} · overdub instead (r)`;
        this.status = `✗ ${message}`;
        return { ok: false, message };
      }
    }
    this.replace = mode === "replace";
    this.armed = true;
    const message = `record ${this.replace ? "replace" : "overdub"} · ${this.trackName()} · ${this.passWord()}`;
    this.status = this.replace
      ? "replace · each pass overwrites its bars"
      : "overdub";
    return { ok: true, message };
  }

  private trackName(): string {
    return this.trackData()?.name ?? this.trackId;
  }

  /** `loop 5–6 · one undo step a pass`, or `one undo step a bar`. */
  private passWord(): string {
    const loop = loopedSection(this.host.score());
    if (!loop) return "one undo step a bar";
    const last = loop.startBar + loop.bars;
    const bars =
      loop.bars === 1 ? `${loop.startBar + 1}` : `${loop.startBar + 1}–${last}`;
    return `loop ${bars} · one undo step a pass`;
  }

  /** Handle one decoded key; mode commands return to the caller. */
  public press(value: string): PlayKeyResult {
    const now = this.host.now();
    this.syncDegrees();
    let key = value;
    if (this.chords.on && value === "n") {
      // Route the suggestion through the note key of its root, so holding
      // `n` sustains it like any held key.
      const route =
        this.nRoute && now - this.nRoute.atMs <= REPEAT_DELAY_MS
          ? this.nRoute
          : { ...this.nextRoute(), atMs: now };
      route.atMs = now;
      this.nRoute = route;
      this.chords.force(route.chord);
      key = route.key;
    } else {
      const pad = this.chords.press(value);
      if (pad.type === "status") {
        this.status = pad.status;
        return { type: "handled" };
      }
    }
    const action = this.keyboard.press(key, now, this.gateMs());
    const result = this.apply(action, now);
    this.recordPedal(now);
    return result;
  }

  /** The suggested next chord and the lowest note key on its root. */
  private nextRoute(): { key: string; chord: PlayedChord["chord"] } {
    const chord = this.chords.next();
    const keys = Object.keys(NOTE_KEYS)
      .map((key) => [key, this.keyboard.pitchFor(key)] as const)
      .filter(
        (entry): entry is readonly [string, number] => entry[1] !== undefined,
      )
      .sort((a, b) => a[1] - b[1]);
    const found = keys.find(([, pitch]) => (pitch - chord.root) % 12 === 0);
    return { key: found?.[0] ?? "a", chord };
  }

  private apply(action: PlayAction, now: number): PlayKeyResult {
    switch (action.type) {
      case "unmapped":
        return { type: "unmapped" };
      case "command":
        return this.command(action.command);
      case "octave":
        this.status = action.clamped
          ? `octave limit · ${this.keyboard.range}`
          : `octave ${this.keyboard.range}`;
        return { type: "handled" };
      case "velocity":
        this.status = `velocity ${action.velocity}${action.clamped ? " · limit" : ""}`;
        return { type: "handled" };
      case "sustain":
        this.release(action.released, action.atMs);
        this.status = action.on ? "sustain latched" : "sustain off";
        return { type: "handled" };
      case "note": {
        this.release(action.released, now);
        // A key that is not recording glows its lane for a moment.
        if (!this.recording) this.host.ghost?.(action.note.pitch);
        const chord = this.chords.chordFor(action.note.pitch);
        if (chord) {
          const played = this.chords.voice(chord, action.note.pitch);
          this.startChord(action.note, played);
          this.record(action.note, this.recordedChord(played, action.note.id));
          this.status = played.name;
          return { type: "handled" };
        }
        // Bass modes that sound bass under single notes (unison, single, solo).
        const single = this.chords.single(action.note.pitch);
        if (single) {
          this.startChord(action.note, single, "block");
          this.record(
            action.note,
            this.recordedChord(single, action.note.id, "block"),
          );
          return { type: "handled" };
        }
        // f07-sing: a throat track is one drone; a new key releases the last.
        if (singThroat(this.trackData())) {
          if (this.throatId !== undefined && this.throatId !== action.note.id)
            this.release([this.throatId], now);
          this.throatId = action.note.id;
        }
        this.sound(action.note.id, action.note);
        this.record(action.note);
        return { type: "handled" };
      }
      case "extend": {
        const pending = this.pending.get(action.id);
        if (action.absorbed !== undefined) {
          this.host.engine()?.noteOff(action.absorbed);
          this.stopChord(action.absorbed);
          this.pending.delete(action.absorbed);
        }
        if (pending) {
          pending.releaseAtMs = action.releaseAtMs;
          pending.keyUpMs = Math.max(
            pending.keyUpMs,
            pending.chord || Number.isFinite(action.releaseAtMs)
              ? action.releaseAtMs
              : now + this.gateMs(),
          );
        }
        const live = this.liveChords.get(action.id);
        if (live) {
          live.releaseAtMs = action.releaseAtMs;
          this.resoundChord(live);
          return { type: "handled" };
        }
        const pitch = this.keyboard.pitchFor(action.key);
        if (pitch !== undefined)
          this.sound(action.id, {
            id: action.id,
            key: action.key,
            pitch,
            velocity: this.keyboard.velocity,
            atMs: pending?.atMs ?? now,
            releaseAtMs: action.releaseAtMs,
            sustain: !Number.isFinite(action.releaseAtMs),
          });
        return { type: "handled" };
      }
    }
  }

  private command(command: PlayCommand): PlayKeyResult {
    if (command === "record") {
      this.recordCommand(this.armed ? "off" : "overdub");
      return { type: "handled" };
    }
    if (command === "replace") {
      const result = this.recordCommand(this.replace ? "overdub" : "replace");
      if (!result.ok) this.host.card(result.message, "error");
      return { type: "handled" };
    }
    if (command === "click") {
      this.status = this.clickCommand("toggle");
      return { type: "handled" };
    }
    if (command === "degrees") {
      this.status = this.toggleDegrees();
      return { type: "handled" };
    }
    if (command === "preset-prev" || command === "preset-next") {
      const status = this.host.presetStep?.(command === "preset-next" ? 1 : -1);
      if (status) this.status = status;
      return { type: "handled" };
    }
    return { type: "command", command };
  }

  /**
   * `i`: the home row plays scale degrees (the song key's scale, or every
   * step of a non-12 tuning) instead of chromatic keys. Drum kits and
   * sampler slots keep their pads.
   */
  public toggleDegrees(on = !this.degreesOn): string {
    if (on && this.layout.labels.size > 0)
      return "scale degrees need a melodic track";
    this.degreesOn = on;
    this.degreeKey = undefined;
    this.syncDegrees();
    return on
      ? `scale degrees · ${this.keyboard.degrees!.name} · ${this.keyboard.range}`
      : `chromatic · ${this.keyboard.range}`;
  }

  /** Follows the song key and tuning while degree mode is on. */
  private syncDegrees(): void {
    if (!this.degreesOn) {
      this.keyboard.degrees = undefined;
      return;
    }
    const score = this.host.score();
    const track = this.trackData();
    const signature = JSON.stringify([score.key, score.tuning, track?.tuning]);
    if (signature === this.degreeKey && this.keyboard.degrees) return;
    this.degreeKey = signature;
    const table =
      score.tuning || track?.tuning
        ? resolveTuning(score.tuning, track?.tuning, score.key)
        : undefined;
    this.keyboard.degrees = degreeLayout(score.key, table);
  }

  /** Render the note through the track's own voice and start it. */
  private sound(id: number, note: PlayedNote): void {
    const engine = this.host.engine();
    if (!engine?.canMonitor) return;
    const seconds = Number.isFinite(note.releaseAtMs)
      ? (note.releaseAtMs - note.atMs) / 1000
      : MAX_LIVE_NOTE_SECONDS;
    if (engine.remoteNote) {
      const scheduled = engine.remoteNote(id, {
        trackId: this.trackId,
        pitch: note.pitch,
        velocity: note.velocity / 127,
        seconds,
        beat: this.host.beatAt(note.atMs),
        atMs: note.atMs,
      });
      this.lastLatencyMs = Math.max(0, scheduled - this.host.now());
      return;
    }
    const samples = this.host.samples?.();
    if (this.synth?.rate !== engine.sampleRate)
      this.synth = new LiveSynth(engine.sampleRate);
    const score = this.host.score();
    const request = {
      score,
      trackId: this.trackId,
      pitch: note.pitch,
      velocity: note.velocity / 127,
      seconds,
      ...(samples ? { samples } : {}),
      ...(score.time?.tempo
        ? { tick: loopTickAt(score, this.host.beatAt(note.atMs)) }
        : {}),
    };
    const synth = this.synth;
    const pcm = synth.render(request);
    if (!pcm) return;
    if (pcm.fitting) {
      // A long fitted sample window is computing: silent, never off-pitch.
      this.status = FITTING_STATUS;
      this.stopFitWait ??= onFitReady(() => {
        if (fitting()) return;
        this.stopFitWait?.();
        this.stopFitWait = undefined;
        if (this.status === FITTING_STATUS)
          this.status = "fit ready · play the key again";
      });
      return;
    }
    const scheduled = engine.noteOn(id, pcm);
    this.lastLatencyMs = Math.max(0, scheduled - this.host.now());
    // A guitar rig sounds its first window now; the rest renders after the
    // key event and replaces the voice in place while it is still sounding.
    this.windows.delete(id);
    if (pcm.partial) this.windows.set(id, false);
    // The full pass runs on a worker, in key order, so a strummed chord or a
    // fast run never stalls key handling behind an oversampled render.
    if (pcm.partial)
      void this.fullRenderer
        .full(
          synth,
          pcm.clock === undefined ? request : { ...request, clock: pcm.clock },
        )
        .then((full) => {
          // Not after note-off: a swap would cancel the release fade.
          if (
            full &&
            this.windows.get(id) === false &&
            engine.voicePosition?.(id) !== undefined
          )
            engine.noteOn(id, full);
          this.windows.delete(id);
        });
  }

  private release(ids: readonly number[], atMs: number): void {
    const engine = this.host.engine();
    for (const id of ids) {
      engine?.noteOff(id);
      if (this.windows.has(id)) this.windows.set(id, true);
      const live = this.liveChords.get(id);
      if (live) live.releaseAtMs = Math.min(live.releaseAtMs, atMs);
      const pending = this.pending.get(id);
      if (pending) {
        pending.releaseAtMs = atMs;
        pending.keyUpMs = Math.min(pending.keyUpMs, atMs);
      }
    }
  }

  public get recording(): boolean {
    return this.armed && this.host.playing() && this.countIn === undefined;
  }

  private record(note: PlayedNote, chord?: RecordedChord): void {
    if (!this.recording) return;
    this.pending.set(note.id, {
      id: note.id,
      pitch: note.pitch,
      velocity: note.velocity,
      atMs: note.atMs,
      beat: this.host.beatAt(note.atMs),
      releaseAtMs: note.releaseAtMs,
      // A chord press lays its voices out over the held length (arps keep
      // stepping while the pedal holds), so it keeps that length.
      keyUpMs:
        chord || Number.isFinite(note.releaseAtMs)
          ? note.releaseAtMs
          : note.atMs + this.gateMs(),
      ...(chord ? { chord } : {}),
    });
  }

  /**
   * Record a sustain change (Tab latch, or Shift held on note keys) as a
   * pedal event at the playhead, like Logic's Musical Typing records its Tab
   * sustain key as CC64.
   */
  private recordPedal(now: number): void {
    // Chord presses record the held length on their voices instead.
    const down =
      this.keyboard.sustain &&
      ![...this.pending.values()].some((pending) => pending.chord);
    if (!this.recording) {
      if (!down) this.pedalDown = false;
      return;
    }
    if (down === this.pedalDown) return;
    this.pedalDown = down;
    this.pendingPedal.push({
      beat: this.host.beatAt(now),
      state: down ? "down" : "up",
    });
  }

  private recordedChord(
    played: PlayedChord,
    seed: number,
    mode: PerformMode = this.chords.settings.perform,
  ): RecordedChord {
    const settings = this.chords.settings;
    return {
      pitches: played.pitches,
      bass: played.bass,
      mode,
      rate: this.chords.rateBeats(this.gridStep),
      octaves: settings.octaves,
      seed,
      ...(mode === "pattern" ? { pattern: settings.pattern } : {}),
      ...(mode === "guitar" ? { guitar: this.guitarOptions(played) } : {}),
    };
  }

  /** Guitar-mode perform options for a played chord (strokes, speed, frets). */
  private guitarOptions(played: PlayedChord): Partial<PerformOptions> {
    return {
      ...guitarPerform(
        this.chords.settings,
        { tempoBpm: this.currentBpm() },
        this.trackData(),
      ),
      root: played.chord.root,
      ...(played.chord.bass !== undefined ? { slash: played.chord.bass } : {}),
    };
  }

  // ── live chords ──────────────────────────────────────────────────────

  private startChord(
    note: PlayedNote,
    played: PlayedChord,
    mode: PerformMode = this.chords.settings.perform,
  ): void {
    const settings = this.chords.settings;
    // Velocity 1: pattern hits carry their own accents, scaled by the press.
    const plan = perform(played.pitches, 0, LIVE_PLAN_BEATS, {
      mode,
      rate: this.chords.rateBeats(this.gridStep),
      octaves: settings.octaves,
      strum: mode === "harp" ? DEFAULT_STRUM * 2 : DEFAULT_STRUM,
      seed: note.id,
      pattern: settings.pattern,
      velocity: 1,
      ...(mode === "guitar" ? this.guitarOptions(played) : {}),
    });
    if (played.bass !== undefined)
      plan.push({
        pitch: played.bass,
        start: 0,
        length: LIVE_PLAN_BEATS,
        velocity: 1,
      });
    plan.sort((a, b) => a.start - b.start);
    this.liveChords.set(note.id, {
      played,
      velocity: note.velocity,
      startMs: note.atMs,
      releaseAtMs: note.releaseAtMs,
      plan,
      next: 0,
      sounding: new Map(),
    });
    this.pumpChords(this.host.now());
  }

  private stopChord(id: number): void {
    const live = this.liveChords.get(id);
    if (!live) return;
    const engine = this.host.engine();
    for (const voice of live.sounding.keys()) engine?.noteOff(voice);
    this.liveChords.delete(id);
  }

  private beatMs(): number {
    return 60_000 / this.currentBpm();
  }

  /** Start due voices, end finished ones, drop released chords. */
  private pumpChords(now: number): void {
    if (this.liveChords.size === 0) return;
    const engine = this.host.engine();
    const beatMs = this.beatMs();
    for (const [id, live] of this.liveChords) {
      for (const [voice, state] of live.sounding)
        if (state.endMs <= now || live.releaseAtMs <= now) {
          engine?.noteOff(voice);
          live.sounding.delete(voice);
        }
      while (live.next < live.plan.length) {
        const planned = live.plan[live.next]!;
        const atMs = live.startMs + planned.start * beatMs;
        if (atMs > now || atMs >= live.releaseAtMs) break;
        live.next += 1;
        const endMs = live.startMs + (planned.start + planned.length) * beatMs;
        // Notes that ring to the end of the plan follow the key instead.
        const own = planned.start + planned.length < LIVE_PLAN_BEATS - 1e-6;
        const voice = this.nextVoiceId++;
        live.sounding.set(voice, {
          index: live.next - 1,
          atMs,
          endMs: own ? endMs : Infinity,
        });
        this.soundVoice(
          voice,
          live,
          planned,
          atMs,
          own ? endMs : live.releaseAtMs,
        );
      }
      const exhausted =
        live.next >= live.plan.length ||
        live.startMs + live.plan[live.next]!.start * beatMs >= live.releaseAtMs;
      if (live.releaseAtMs <= now || (exhausted && live.sounding.size === 0))
        this.stopChord(id);
    }
  }

  /** A held chord's release moved: re-render the voices that follow it. */
  private resoundChord(live: LiveChord): void {
    for (const [voice, state] of live.sounding)
      if (!Number.isFinite(state.endMs)) {
        const planned = live.plan[state.index]!;
        this.soundVoice(voice, live, planned, state.atMs, live.releaseAtMs);
      }
  }

  private soundVoice(
    voice: number,
    live: LiveChord,
    planned: Readonly<{ pitch: number; velocity: number }>,
    atMs: number,
    endMs: number,
  ): void {
    this.sound(voice, {
      id: voice,
      key: "",
      pitch: planned.pitch,
      velocity: scaleVelocity(live.velocity, planned.velocity),
      atMs,
      releaseAtMs: endMs,
      sustain: !Number.isFinite(endMs),
    });
  }

  /**
   * Space in play mode: with record armed and the transport stopped, count
   * in from the bar the playhead is in, then start. Returns false when the
   * caller should toggle the transport itself.
   */
  public startWithCountIn(): boolean {
    if (!this.armed || this.host.playing() || this.countIn) return false;
    const score = this.host.score();
    const startBeat = transportBarStart(
      score,
      transportBar(score, this.host.beatAt(this.host.now())),
    );
    if (this.countInBars === 0) {
      void this.host.startTransport(startBeat);
      return true;
    }
    // Count in the meter and tempo of the bar recording starts in.
    const at = barAt(score, loopTickAt(score, startBeat));
    const tpb = score.ticksPerBeat;
    const barBeats = at.barTicks / tpb;
    this.countIn = {
      startMs: this.host.now(),
      beats: this.countInBars * barBeats,
      startBeat,
      bpm: bpmAtTick(score, at.tick),
      barBeats,
      clickBeats: clickTicksOf(at, tpb) / tpb,
    };
    this.applyClick();
    return true;
  }

  /** Advance count-in, flush finished bars. Call every frame. */
  public tick(): void {
    if (!this.active) return;
    const now = this.host.now();
    this.pumpChords(now);
    const count = this.countIn;
    if (count) {
      const beatMs = 60_000 / count.bpm;
      if (now - count.startMs >= count.beats * beatMs) {
        this.countIn = undefined;
        this.applyClick();
        void this.host.startTransport(count.startBeat);
      }
      return;
    }
    if (!this.armed || !this.host.playing()) {
      if (this.pending.size > 0 || this.replaceBars.size > 0)
        void this.stopRecording();
      this.lastBar = undefined;
      this.lastPass = undefined;
      return;
    }
    const score = this.host.score();
    const bar = transportBar(score, this.host.beatAt(now));
    if (bar !== this.lastBar)
      this.barPedal.set(this.loopBar(bar), this.pedalDown ? "down" : "up");
    // With a loop set, a take commits once per pass (each wrap), so one
    // pass is one undo step; without one, once per bar (§4.7).
    const loop = loopedSection(score);
    const pass = loop ? Math.floor(bar / loop.bars) : undefined;
    if (this.lastBar !== undefined && bar !== this.lastBar) {
      // Every bar the playhead left (a slow frame can skip one).
      if (this.replace)
        for (
          let left = this.lastBar;
          left < bar && left < this.lastBar + 256;
          left += 1
        )
          this.replaceBars.add(
            this.loopBar(
              Math.floor(
                this.toScoreBeat(left * score.beatsPerBar) / score.beatsPerBar,
              ),
            ),
          );
      if (pass === undefined) this.queueFlush(bar, now, false);
      else if (this.lastPass !== undefined && pass !== this.lastPass)
        this.queueFlush(bar, now, false, true);
    }
    this.lastBar = bar;
    this.lastPass = pass;
  }

  /** `↻ 5–6 · pass 3` while loop recording; undefined otherwise. */
  public passLabel(): string | undefined {
    if (!this.recording) return undefined;
    const loop = loopedSection(this.host.score());
    if (!loop) return undefined;
    const bars =
      loop.bars === 1
        ? `${loop.startBar + 1}`
        : `${loop.startBar + 1}–${loop.startBar + loop.bars}`;
    return `↻ ${bars} · pass ${this.passCount + 1}`;
  }

  private toScoreBeat(beat: number): number {
    return this.host.scoreBeat ? this.host.scoreBeat(beat) : beat;
  }

  private loopBar(bar: number): number {
    const bars = this.host.score().bars;
    return ((bar % bars) + bars) % bars;
  }

  /** Commit what record armed collected; called when recording ends. */
  public async stopRecording(): Promise<void> {
    const now = this.host.now();
    // A pedal still down when recording stops lifts here.
    if (this.pedalDown && this.host.playing())
      this.pendingPedal.push({ beat: this.host.beatAt(now), state: "up" });
    this.pedalDown = false;
    this.queueFlush(
      Number.POSITIVE_INFINITY,
      now,
      true,
      loopedSection(this.host.score()) !== undefined,
    );
    await this.flushing;
    this.recordedIds.clear();
    this.lastBar = undefined;
    this.lastPass = undefined;
    this.passCount = 0;
  }

  private queueFlush(
    currentBar: number,
    now: number,
    all: boolean,
    pass = false,
  ): void {
    this.flushing = this.flushing
      .then(() => this.flush(currentBar, now, all, pass))
      .catch((error: unknown) =>
        this.host.card(
          `record failed · ${error instanceof Error ? error.message : String(error)}`,
          "error",
        ),
      );
  }

  /**
   * Commit pending notes whose bar is behind the playhead and whose key has
   * released (all of them when `all`), plus replace-mode erasures.
   */
  private async flush(
    currentBar: number,
    now: number,
    all: boolean,
    pass = false,
  ): Promise<void> {
    const score = this.host.score();
    const ready: Pending[] = [];
    for (const pending of this.pending.values()) {
      const bar = transportBar(score, pending.beat);
      const released = pending.keyUpMs <= now;
      if (all || (bar < currentBar && released)) ready.push(pending);
    }
    const erase = [...this.replaceBars];
    this.replaceBars.clear();
    const pedal = this.pendingPedal.filter(
      (event) => all || transportBar(score, event.beat) < currentBar,
    );
    this.pendingPedal = this.pendingPedal.filter(
      (event) => !pedal.includes(event),
    );
    if (pass) this.passCount += 1;
    // §12.4: a replace pass never erases while another pane records this
    // track; its notes still land, as an overdub.
    const other =
      erase.length > 0
        ? this.host.recordingElsewhere?.(this.trackId)
        : undefined;
    if (other) {
      erase.length = 0;
      this.host.card(
        `${other} is recording ${this.trackName()} · pass kept as overdub`,
        "warning",
      );
    }
    if (ready.length === 0 && erase.length === 0 && pedal.length === 0) {
      if (pass) this.recordedIds.clear();
      return;
    }
    const eraseStates = new Map(
      erase.map((bar) => [bar, this.barPedal.get(bar) ?? "up"] as const),
    );
    try {
      await this.commitTake(
        score,
        ready,
        erase,
        eraseStates,
        pedal,
        now,
        pass ? this.passCount : undefined,
      );
      // The next pass may replace this one's notes: forget them.
      if (pass) this.recordedIds.clear();
    } catch (error) {
      // Nothing was committed: keep the take so the next flush retries it.
      for (const pending of ready) this.pending.set(pending.id, pending);
      for (const bar of erase) this.replaceBars.add(bar);
      this.pendingPedal = [...pedal, ...this.pendingPedal];
      throw error;
    }
  }

  private async commitTake(
    score: TrackScore,
    ready: readonly Pending[],
    erase: readonly number[],
    eraseStates: ReadonlyMap<number, PedalState>,
    pedal: readonly { beat: number; state: PedalState }[],
    now: number,
    pass?: number,
  ): Promise<void> {
    const operations = recordOperations(score, {
      trackId: this.trackId,
      notes: ready.flatMap((pending) => {
        const beats = hasTempoMap(score)
          ? this.host.beatAt(Math.min(pending.keyUpMs, now)) -
            this.host.beatAt(pending.atMs)
          : ((Math.min(pending.keyUpMs, now) - pending.atMs) * score.tempoBpm) /
            60_000;
        return pending.chord
          ? chordNotes(pending.chord, {
              beat: this.toScoreBeat(pending.beat),
              beats,
              velocity: pending.velocity,
              grid: this.gridStep,
            })
          : [
              {
                pitch: pending.pitch,
                velocity: pending.velocity,
                beat: this.toScoreBeat(pending.beat),
                beats,
              },
            ];
      }),
      grid: this.gridStep,
      eraseBars: erase,
      keep: this.recordedIds,
      newId: () => this.host.newNoteId(),
    });
    // A pedal lane that cannot take more events never costs the notes.
    let pedalNote = "";
    try {
      const pedalOperation = recordPedalOperation(score, {
        trackId: this.trackId,
        events: pedal,
        eraseBars: erase,
        eraseStates,
      });
      if (pedalOperation) operations.push(pedalOperation);
    } catch (error) {
      if (!(error instanceof ExpressionValidationError)) throw error;
      pedalNote = ` · pedal not recorded (${error.message})`;
    }
    if (operations.length === 0) return;
    let next = score;
    for (const operation of operations)
      next = applyScoreOperation(next, operation);
    const added = operations.filter((op) => op.type === "addNote").length;
    const removed = operations.filter((op) => op.type === "removeNote").length;
    await this.host.commit(next, "score.record", {
      trackId: this.trackId,
      operations,
      replace: this.replace,
      ...(pass !== undefined ? { pass } : {}),
    });
    for (const pending of ready) this.pending.delete(pending.id);
    for (const operation of operations)
      if (operation.type === "addNote") this.recordedIds.add(operation.note.id);
    const head =
      pass !== undefined
        ? `pass ${pass} · +${added} note${added === 1 ? "" : "s"}`
        : `recorded ${added} note${added === 1 ? "" : "s"}`;
    this.host.card(
      `${head}${pedal.length && !pedalNote ? ` · ${pedal.length} pedal` : ""}${removed ? ` · replaced ${removed}` : ""} · ${this.trackId}${pedalNote}`,
      pedalNote ? "warning" : "success",
    );
  }

  public header(): PlayHeaderView {
    const now = this.host.now();
    const score = this.host.score();
    const count = this.countIn;
    let beat: PlayHeaderView["beat"];
    let countIn: string | undefined;
    const beatMs = 60_000 / (count?.bpm ?? score.tempoBpm);
    const at = count
      ? count.startBeat - count.beats + (now - count.startMs) / beatMs
      : this.host.playing()
        ? this.host.beatAt(now)
        : undefined;
    if (at !== undefined && (count || !hasMeterChanges(score))) {
      const whole = Math.floor(at);
      const inBar =
        ((whole % score.beatsPerBar) + score.beatsPerBar) % score.beatsPerBar;
      beat = {
        index: inBar + 1,
        of: score.beatsPerBar,
        flash: (at - whole) * beatMs < FLASH_MS,
      };
      if (count) {
        const clicks = Math.round(count.barBeats / count.clickBeats);
        const step = Math.floor(
          (at - (count.startBeat - count.beats)) / count.clickBeats,
        );
        beat = {
          index: (((step % clicks) + clicks) % clicks) + 1,
          of: clicks,
          flash:
            ((at - (count.startBeat - count.beats)) % count.clickBeats) *
              beatMs <
            FLASH_MS,
        };
        countIn = `count-in ${Math.ceil((count.startBeat - at) / count.clickBeats)}`;
      }
    } else if (at !== undefined) {
      // Meter changes: count the clicks of the bar the playhead is in.
      const tpb = score.ticksPerBeat;
      const position = barAt(score, loopTickAt(score, at));
      const click = clickTicksOf(position, tpb);
      const inBar = position.offset / click;
      const whole = Math.floor(inBar);
      beat = {
        index: whole + 1,
        of: Math.round(position.barTicks / click),
        flash:
          ((inBar - whole) * click * 60_000) /
            tpb /
            bpmAtTick(score, position.tick + whole * click) <
          FLASH_MS,
      };
    }
    return {
      range: this.layout.drums ? "drums" : this.keyboard.range,
      velocity: this.keyboard.velocity,
      armed: this.armed,
      recording: this.recording,
      replace: this.replace,
      pass: this.passLabel(),
      click: this.clickOn,
      sustain: this.keyboard.sustain,
      countIn,
      beat,
      grid: `grid ${this.grid}`,
      // A kit plays drums, not harmony: no chord row and no key chip.
      chords: this.layout.drums
        ? undefined
        : this.chords.glance(songKey(this.host.score().key).set),
      status: this.status,
      keys: this.strip(now),
      sounds: this.layout.labels.size > 0,
      octave: this.keyboard.range,
      countInBars: this.countInBars,
      legend:
        this.chords.on && !this.layout.drums ? this.chords.legend() : undefined,
    };
  }

  /** Secondary state for the `?` panel (kept out of the header). */
  public details(): string[] {
    const keySet = songKey(this.host.score().key).set;
    return [
      `velocity ${this.keyboard.velocity} · grid ${this.grid} · click ${this.clickOn ? "on" : "off"} · count-in ${this.countInBars} bar${this.countInBars === 1 ? "" : "s"}`,
      ...(this.chords.on ? [`chords ${this.chords.headerText(keySet)}`] : []),
    ];
  }

  public strip(now = this.host.now()): PlayStripKey[] {
    this.syncDegrees();
    return stripCells(
      this.keyboard,
      this.keyboard.litKeys(now),
      this.layout.labels,
    ).map((cell) => {
      const chord = this.keyboard.pitchFor(cell.key);
      const name =
        chord === undefined || this.layout.drums
          ? undefined
          : this.chords.keyLabel(chord);
      // Chords in the key are the safe ones to reach for: the strip lights
      // them; a borrowed chord still plays but stays plain.
      return name && chord !== undefined
        ? {
            ...cell,
            label: name,
            chord: true,
            diatonic:
              degreeOf(this.chords.key, ((chord % 12) + 12) % 12) !== undefined,
          }
        : this.noteCell(cell);
    });
  }

  private noteCell(cell: PlayStripKey): PlayStripKey {
    return {
      ...cell,
      // Octave digits only on the root (C, or the tonic in scale degrees):
      // the anchor reads at a glance and the other labels stay short.
      label:
        this.layout.labels.size > 0 || cell.root || cell.unmapped
          ? cell.label
          : cell.label.replace(/-?\d+$/, ""),
    };
  }
}

export type RecordedNote = Readonly<{
  pitch: number;
  /** MIDI velocity 1..127. */
  velocity: number;
  /** Unwrapped transport beat of the press. */
  beat: number;
  /** Held length in beats. */
  beats: number;
  /** Already on the grid (a laid-out chord voice): keep beat and length. */
  exact?: boolean;
}>;

/** A press velocity (1..127) times a pattern accent (0..1), at least 1. */
function scaleVelocity(velocity: number, accent: number): number {
  return accent >= 1 ? velocity : Math.max(1, Math.round(velocity * accent));
}

/**
 * A recorded chord press as notes: the press snaps to `grid`, its held
 * length rounds to whole grid steps (at least one), and `perform` lays the
 * voices out inside it; the bass holds the whole length.
 */
export function chordNotes(
  chord: RecordedChord,
  press: Readonly<{
    beat: number;
    beats: number;
    velocity: number;
    grid: number;
  }>,
): RecordedNote[] {
  const start = quantize(press.beat, press.grid);
  const length = Math.max(press.grid, quantize(press.beats, press.grid));
  const notes = perform(chord.pitches, start, length, {
    mode: chord.mode,
    rate: chord.rate,
    octaves: chord.octaves,
    strum: chord.mode === "harp" ? DEFAULT_STRUM * 2 : DEFAULT_STRUM,
    seed: chord.seed,
    ...(chord.pattern !== undefined ? { pattern: chord.pattern } : {}),
    velocity: 1,
    ...chord.guitar,
  }).map((note) => ({
    pitch: note.pitch,
    velocity: scaleVelocity(press.velocity, note.velocity),
    beat: note.start,
    beats: note.length,
    exact: true,
  }));
  if (chord.bass !== undefined)
    notes.push({
      pitch: chord.bass,
      velocity: press.velocity,
      beat: start,
      beats: length,
      exact: true,
    });
  return notes;
}

/**
 * The ScoreOperations one recorded bar commits: notes quantized to `grid`
 * and wrapped into the loop (overdub), plus removals of existing notes that
 * start in `eraseBars` (replace), except notes this pass recorded (`keep`).
 */
export function recordOperations(
  score: TrackScore,
  options: Readonly<{
    trackId: string;
    notes: readonly RecordedNote[];
    grid: number;
    eraseBars?: readonly number[];
    keep?: ReadonlySet<string>;
    newId: () => string;
  }>,
): ScoreOperation[] {
  const operations: ScoreOperation[] = [];
  const tpb = score.ticksPerBeat;
  const loopBeats = loopTicksOf(score) / tpb;
  const erase = new Set(options.eraseBars ?? []);
  if (erase.size > 0)
    for (const note of score.notes) {
      if (note.trackId !== options.trackId) continue;
      if (options.keep?.has(note.id)) continue;
      const bar = hasMeterChanges(score)
        ? barAt(score, note.startTick).bar
        : Math.floor(note.startTick / tpb / score.beatsPerBar);
      if (erase.has(bar))
        operations.push({ type: "removeNote", noteId: note.id });
    }
  const removed = new Set(
    operations.map((operation) =>
      operation.type === "removeNote" ? operation.noteId : "",
    ),
  );
  const taken = new Set(
    score.notes
      .filter(
        (note) => note.trackId === options.trackId && !removed.has(note.id),
      )
      .map((note) => `${note.pitch}:${note.startTick}`),
  );
  for (const note of options.notes) {
    let start =
      (note.exact ? note.beat : quantize(note.beat, options.grid)) % loopBeats;
    if (start < 0) start += loopBeats;
    const beats = note.exact
      ? note.beats
      : Math.max(options.grid, quantize(note.beats, options.grid));
    const startTick = Math.round(start * tpb);
    const durationTicks = Math.max(
      1,
      Math.min(Math.round(beats * tpb), loopBeats * tpb - startTick),
    );
    const slot = `${note.pitch}:${startTick}`;
    // The same pitch on the same step twice is one note (a stutter).
    if (taken.has(slot)) continue;
    taken.add(slot);
    operations.push({
      type: "addNote",
      note: {
        id: options.newId(),
        trackId: options.trackId,
        startTick,
        durationTicks,
        pitch: note.pitch,
        velocity: Math.max(0.01, Math.min(1, note.velocity / 127)),
      },
    });
  }
  return operations;
}

/**
 * The `updateTrack` that merges recorded pedal events into the track,
 * wrapped into the loop (unquantized: pedalling is about the release), after
 * dropping existing events in `eraseBars` (replace). Undefined when nothing
 * changes.
 */
export function recordPedalOperation(
  score: TrackScore,
  options: Readonly<{
    trackId: string;
    events: readonly { beat: number; state: PedalState }[];
    eraseBars?: readonly number[];
    /** The pedal as the take entered each erased bar (default `up`). */
    eraseStates?: ReadonlyMap<number, PedalState>;
  }>,
): ScoreOperation | undefined {
  const track = score.tracks.find((item) => item.id === options.trackId);
  if (!track) return undefined;
  const tpb = score.ticksPerBeat;
  // Bars follow the meter map; without meter changes this is the 0.4 grid.
  const maxTick = loopTicksOf(score);
  const original = track.pedal ?? [];
  const erase = new Set(options.eraseBars ?? []);
  const kept = original.filter(
    (event) => !erase.has(barAt(score, event.tick).bar),
  );
  if (options.events.length === 0 && erase.size === 0) return undefined;
  const byTick = new Map<number, PedalEvent>(
    kept.map((event) => [event.tick, event]),
  );
  // Replace: an erased bar starts in the state the take had there, and the
  // old pedal resumes after it, so no stale press is left without its lift.
  for (const bar of erase) {
    const start = barStartTick(score, bar);
    const end = barStartTick(score, bar + 1);
    byTick.set(start, {
      tick: start,
      state: options.eraseStates?.get(bar) ?? "up",
    });
    if (end < maxTick && !erase.has(bar + 1) && !byTick.has(end))
      byTick.set(end, { tick: end, state: pedalStateAt(original, end - 1) });
  }
  for (const event of options.events) {
    let tick = Math.round(event.beat * tpb) % maxTick;
    if (tick < 0) tick += maxTick;
    byTick.set(tick, { tick, state: event.state });
  }
  const sorted = [...byTick.values()].sort((a, b) => a.tick - b.tick);
  // A pedal held across the loop seam is down again from tick 0.
  const seam = sorted[sorted.length - 1]?.state ?? "up";
  if (options.events.length > 0 && seam !== "up" && sorted[0]?.tick !== 0)
    sorted.unshift({ tick: 0, state: seam });
  // Drop events that do not change the state (the lane has a size limit).
  const compact: PedalEvent[] = [];
  for (const event of sorted) {
    const before = compact[compact.length - 1]?.state ?? "up";
    if (event.state !== before) compact.push(event);
  }
  if (compact.length > EXPRESSION_LIMITS.maxPedalEvents)
    throw new ExpressionValidationError(
      `the pedal lane is full (${EXPRESSION_LIMITS.maxPedalEvents} events)`,
    );
  const pedal = normalizePedal(compact, maxTick);
  const same =
    (pedal?.length ?? 0) === original.length &&
    (pedal ?? []).every(
      (event, index) =>
        event.tick === original[index]!.tick &&
        event.state === original[index]!.state,
    );
  if (same) return undefined;
  return {
    type: "updateTrack",
    trackId: options.trackId,
    patch: { pedal: pedal && pedal.length > 0 ? pedal : null },
  };
}

/** Whether `track` sounds in plain 12-TET (no tuning, or one equal to it). */
function twelveTet(
  score: Readonly<{ tuning?: Tuning; key?: string | null }>,
  track: Readonly<{ tuning?: Tuning }> | undefined,
): boolean {
  if (!score.tuning && !track?.tuning) return true;
  const table = resolveTuning(score.tuning, track?.tuning, score.key);
  if (!table) return true;
  if (table.size !== 12 || Math.abs(table.period - 1200) > 0.01) return false;
  for (let key = 1; key < 128; key += 1) {
    const [low, high] = [table.hz[key - 1]!, table.hz[key]!];
    if (low <= 0 || high <= 0) return false;
    if (Math.abs(1200 * Math.log2(high / low) - 100) > 0.5) return false;
  }
  return true;
}
