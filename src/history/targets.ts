/**
 * What a score event touched, as `TargetRef`s, so history can be queried
 * by track, instrument, effect, node, param and bar range (design §2.5).
 * Pure: works on score operations and composition JSON, never throws.
 */
import { DiffError, diffScores } from "../../core/diff.ts";
import { scoreFromJSON, type ScoreOperation } from "../../core/score.ts";
import type { CommentContext, TargetRef } from "./types.ts";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ScoreShape = {
  ticksPerBeat: number;
  beatsPerBar: number;
  tracks: Map<string, { instrument?: string }>;
  notes: Map<
    string,
    { trackId: string; startTick: number; durationTicks: number }
  >;
};

function shape(composition: unknown): ScoreShape {
  const value = isObj(composition) ? composition : {};
  const tracks = new Map<string, { instrument?: string }>();
  for (const track of Array.isArray(value.tracks) ? value.tracks : []) {
    if (!isObj(track) || typeof track.id !== "string") continue;
    tracks.set(
      track.id,
      typeof track.instrument === "string"
        ? { instrument: track.instrument }
        : {},
    );
  }
  const notes = new Map<
    string,
    { trackId: string; startTick: number; durationTicks: number }
  >();
  for (const note of Array.isArray(value.notes) ? value.notes : []) {
    if (
      !isObj(note) ||
      typeof note.id !== "string" ||
      typeof note.trackId !== "string"
    )
      continue;
    notes.set(note.id, {
      trackId: note.trackId,
      startTick: typeof note.startTick === "number" ? note.startTick : 0,
      durationTicks:
        typeof note.durationTicks === "number" ? note.durationTicks : 0,
    });
  }
  return {
    ticksPerBeat:
      typeof value.ticksPerBeat === "number" && value.ticksPerBeat > 0
        ? value.ticksPerBeat
        : 480,
    beatsPerBar:
      typeof value.beatsPerBar === "number" && value.beatsPerBar > 0
        ? value.beatsPerBar
        : 4,
    tracks,
    notes,
  };
}

class Collector {
  private readonly out: TargetRef[] = [];
  private readonly keys = new Set<string>();
  private readonly bars = new Map<string, { from: number; to: number }>();

  public add(ref: TargetRef): void {
    const key = `${ref.type}\0${ref.key}\0${ref.trackId ?? ""}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.out.push(ref);
  }

  public track(trackId: string, s: ScoreShape): void {
    this.add({ type: "track", key: trackId, trackId });
    const instrument = s.tracks.get(trackId)?.instrument;
    if (instrument) this.add({ type: "instrument", key: instrument, trackId });
  }

  public param(trackId: string | undefined, key: string): void {
    this.add({ type: "param", key, ...(trackId ? { trackId } : {}) });
  }

  /** Bar ranges merge per track into one span. */
  public span(
    trackId: string,
    startTick: number,
    durationTicks: number,
    s: ScoreShape,
  ): void {
    const ticksPerBar = s.ticksPerBeat * s.beatsPerBar;
    const from = Math.floor(startTick / ticksPerBar) + 1;
    const to =
      Math.floor(
        Math.max(startTick, startTick + durationTicks - 1) / ticksPerBar,
      ) + 1;
    const known = this.bars.get(trackId);
    this.bars.set(
      trackId,
      known
        ? { from: Math.min(known.from, from), to: Math.max(known.to, to) }
        : { from, to },
    );
  }

  public done(limit = 64): TargetRef[] {
    for (const [trackId, range] of this.bars)
      this.add({
        type: "bars",
        key: `${range.from}-${range.to}`,
        trackId,
        barFrom: range.from,
        barTo: range.to,
      });
    return this.out.slice(0, limit);
  }
}

const TRACK_PARAM: Readonly<Record<string, string>> = {
  muted: "mute",
  solo: "solo",
  volume: "volume",
  pan: "pan",
  volumeAutomation: "volume",
  panAutomation: "pan",
  filterAutomation: "filter.cutoff",
  resonanceAutomation: "filter.resonance",
  delayFeedbackAutomation: "delay.feedback",
  delayMixAutomation: "delay.mix",
  wtAutomation: "wavetable.position",
};

function trackPatch(
  trackId: string,
  patch: unknown,
  before: ScoreShape,
  after: ScoreShape | undefined,
  c: Collector,
): void {
  c.track(trackId, before);
  if (!isObj(patch)) return;
  for (const [field, value] of Object.entries(patch)) {
    if (field === "instrument") {
      if (typeof value === "string")
        c.add({ type: "instrument", key: value, trackId });
      c.param(trackId, "instrument");
      continue;
    }
    if (field === "name") {
      c.param(trackId, "name");
      continue;
    }
    const mapped = TRACK_PARAM[field];
    if (mapped) {
      c.param(trackId, mapped);
      continue;
    }
    if (field === "fx" || field === "fxAutomation") {
      if (isObj(value))
        for (const [name, inner] of Object.entries(value)) {
          c.add({ type: "effect", key: name, trackId });
          if (isObj(inner))
            for (const knob of Object.keys(inner))
              c.param(trackId, `fx.${name}.${knob}`);
          else c.param(trackId, `fx.${name}`);
        }
      else c.param(trackId, "fx");
      continue;
    }
    if (field === "filter" || field === "delay" || field === "reverb") {
      c.add({ type: "effect", key: field, trackId });
      if (isObj(value))
        for (const knob of Object.keys(value))
          c.param(trackId, `${field}.${knob}`);
      else c.param(trackId, field);
      continue;
    }
    if (isObj(value))
      for (const knob of Object.keys(value))
        c.param(trackId, `${field}.${knob}`);
    else c.param(trackId, field);
  }
  const instrument = after?.tracks.get(trackId)?.instrument;
  if (instrument) c.add({ type: "instrument", key: instrument, trackId });
}

function patchTarget(
  target: unknown,
  nodeId: string | undefined,
  node: unknown,
  before: ScoreShape,
  c: Collector,
): void {
  if (!isObj(target)) return;
  const trackId =
    typeof target.trackId === "string" ? target.trackId : undefined;
  if (trackId) c.track(trackId, before);
  if (typeof target.fx === "string")
    c.add({ type: "effect", key: target.fx, ...(trackId ? { trackId } : {}) });
  if (typeof target.library === "string")
    c.param(undefined, `library.${target.library}`);
  if (nodeId) {
    c.add({ type: "node", key: nodeId, ...(trackId ? { trackId } : {}) });
    const params =
      isObj(node) && isObj(node.params) ? Object.keys(node.params) : [];
    if (params.length === 0) c.param(trackId, `node.${nodeId}`);
    for (const port of params.slice(0, 8))
      c.param(trackId, `node.${nodeId}.${port}`);
  }
}

function fromOperation(
  op: unknown,
  before: ScoreShape,
  after: ScoreShape | undefined,
  c: Collector,
): void {
  if (!isObj(op) || typeof op.type !== "string") return;
  const o = op as Obj & { type: ScoreOperation["type"] };
  const trackId = typeof o.trackId === "string" ? o.trackId : undefined;
  switch (o.type) {
    case "addTrack": {
      const track = isObj(o.track) ? o.track : {};
      if (typeof track.id === "string") {
        c.add({ type: "track", key: track.id, trackId: track.id });
        if (typeof track.instrument === "string")
          c.add({
            type: "instrument",
            key: track.instrument,
            trackId: track.id,
          });
      }
      return;
    }
    case "removeTrack":
    case "clearTrack":
    case "moveTrack":
      if (trackId) c.track(trackId, before);
      return;
    case "updateTrack":
      if (trackId) trackPatch(trackId, o.patch, before, after, c);
      return;
    case "setAutomation":
      if (trackId) {
        c.track(trackId, before);
        const parameter =
          typeof o.parameter === "string" ? o.parameter : "automation";
        c.param(trackId, TRACK_PARAM[`${parameter}Automation`] ?? parameter);
      }
      return;
    case "setClips":
      if (trackId) {
        c.track(trackId, before);
        c.param(trackId, "clips");
      }
      return;
    case "addNote": {
      const note = isObj(o.note) ? o.note : {};
      if (typeof note.trackId !== "string") return;
      c.track(note.trackId, before);
      const tpb = before.ticksPerBeat;
      const start =
        typeof note.startTick === "number"
          ? note.startTick
          : typeof note.start === "number"
            ? note.start * tpb
            : 0;
      const duration =
        typeof note.durationTicks === "number"
          ? note.durationTicks
          : typeof note.duration === "number"
            ? note.duration * tpb
            : 0;
      c.span(note.trackId, start, duration, before);
      return;
    }
    case "removeNote":
    case "updateNote": {
      const noteId = typeof o.noteId === "string" ? o.noteId : "";
      const note = before.notes.get(noteId) ?? after?.notes.get(noteId);
      if (!note) return;
      c.track(note.trackId, before);
      c.span(note.trackId, note.startTick, note.durationTicks, before);
      const moved = after?.notes.get(noteId);
      if (moved)
        c.span(moved.trackId, moved.startTick, moved.durationTicks, before);
      return;
    }
    case "setTempo":
      c.param(undefined, "tempo");
      return;
    case "setBars":
      c.param(undefined, "bars");
      return;
    case "setKey":
      c.param(undefined, "key");
      return;
    case "setMeter":
      c.param(undefined, "meter");
      return;
    case "setTime":
      c.param(undefined, "time");
      return;
    case "setTuning":
      c.param(undefined, "tuning");
      return;
    case "setMaster":
      c.add({ type: "effect", key: "master" });
      c.param(undefined, "master");
      return;
    case "setCalibration":
      c.param(undefined, "calibration");
      return;
    case "setStyle":
      c.param(undefined, "style");
      return;
    case "setSections":
      c.param(undefined, "sections");
      return;
    case "setLoop":
      c.param(undefined, "loop");
      return;
    case "setPatch":
      patchTarget(o.target, undefined, undefined, before, c);
      if (
        trackId === undefined &&
        isObj(o.target) &&
        typeof o.target.trackId === "string"
      )
        c.param(o.target.trackId, "patch");
      return;
    case "setPatchNode":
      patchTarget(
        o.target,
        typeof o.nodeId === "string" ? o.nodeId : undefined,
        o.node,
        before,
        c,
      );
      return;
    case "setPatchCable":
    case "setPatchMacro":
      patchTarget(o.target, undefined, undefined, before, c);
      if (isObj(o.target) && typeof o.target.trackId === "string")
        c.param(
          o.target.trackId,
          o.type === "setPatchCable"
            ? "patch.cable"
            : `macro.${String(o.macroId)}`,
        );
      return;
    default:
      return;
  }
}

/**
 * Targets of one score event. `ops` when the event carries them; otherwise
 * derived by diffing `before` and `after`, else one `track` target per track
 * whose JSON changed. `files` adds one `file` target per changed path.
 */
export function deriveTargets(
  ops: readonly unknown[] | undefined,
  before: unknown,
  after?: unknown,
  files?: readonly string[],
): TargetRef[] {
  const c = new Collector();
  const b = shape(before);
  const a = after === undefined ? undefined : shape(after);
  let list: readonly unknown[] | undefined = ops;
  if (
    (list === undefined || list.length === 0) &&
    after !== undefined &&
    before !== undefined
  ) {
    try {
      list = diffScores(scoreFromJSON(before), scoreFromJSON(after));
    } catch (error) {
      if (!(error instanceof DiffError) && !(error instanceof Error))
        throw error;
      list = undefined;
      for (const id of changedTracks(before, after)) c.track(id, a ?? b);
    }
  }
  for (const op of list ?? []) fromOperation(op, b, a, c);
  for (const file of files ?? []) c.add({ type: "file", key: file });
  return c.done();
}

function changedTracks(before: unknown, after: unknown): string[] {
  const index = (value: unknown) => {
    const map = new Map<string, string>();
    const tracks =
      isObj(value) && Array.isArray(value.tracks) ? value.tracks : [];
    for (const track of tracks)
      if (isObj(track) && typeof track.id === "string")
        map.set(track.id, JSON.stringify(track));
    return map;
  };
  const b = index(before);
  const a = index(after);
  const ids = new Set([...b.keys(), ...a.keys()]);
  return [...ids].filter((id) => b.get(id) !== a.get(id));
}

/**
 * Targets of a comment, from what the pane was looking at: the focused
 * track and its instrument, param, node, and the bars under the playhead
 * (or the loop range), so `--track bass` finds "love this bassline".
 */
export function contextTargets(
  context: CommentContext | undefined,
  beatsPerBar = 4,
): TargetRef[] {
  if (!context) return [];
  const c = new Collector();
  const trackId = context.focus?.trackId;
  if (trackId) {
    c.add({ type: "track", key: trackId, trackId });
    if (context.focus?.instrument)
      c.add({ type: "instrument", key: context.focus.instrument, trackId });
  }
  if (context.focus?.param) c.param(trackId, context.focus.param);
  if (context.focus?.node)
    c.add({
      type: "node",
      key: context.focus.node,
      ...(trackId ? { trackId } : {}),
    });
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const barTrack = trackId ?? "*";
  if (context.loop) {
    const from = Math.floor(context.loop.fromBeat / bpb) + 1;
    const to = Math.max(from, Math.ceil(context.loop.toBeat / bpb));
    c.add({
      type: "bars",
      key: `${from}-${to}`,
      trackId: barTrack,
      barFrom: from,
      barTo: to,
    });
  } else if (context.playhead) {
    const bar = context.playhead.bar;
    c.add({
      type: "bars",
      key: `${bar}-${bar}`,
      trackId: barTrack,
      barFrom: bar,
      barTo: bar,
    });
  }
  return c.done();
}
