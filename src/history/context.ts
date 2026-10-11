/**
 * What a pane was looking at and listening to when a comment (or focus
 * snapshot) was made (design §3.2). `captureContext` is pure: main.ts
 * feeds it one `ContextSource` adapter (`src/history/wire.ts`).
 */
import type { TrackScore } from "../../core/score.ts";
import { barAt } from "../../core/tempo.ts";
import type { PresenceEntry } from "../session/protocol.ts";
import type { CommentContext } from "./types.ts";

export type { CommentContext } from "./types.ts";

export type ContextSource = Readonly<{
  presence: PresenceEntry | undefined;
  score: TrackScore;
  revision: number;
  /** Score beat under the playhead (undefined when never played). */
  playheadBeat: number | undefined;
  /** The loop in score beats. */
  loop: { from: number; to: number } | undefined;
  selection: CommentContext["selection"] | undefined;
  focusedParam: string | undefined;
  patchNode: string | undefined;
  /** Transport state, when the host knows it. */
  transport?: { playing: boolean; recording: boolean } | undefined;
}>;

function position(
  score: TrackScore,
  beat: number,
): { bar: number; beatInBar: number; label: string } {
  const tick = Math.max(0, Math.round(beat * score.ticksPerBeat));
  try {
    const at = barAt(score, tick);
    const beatTicks = Math.max(1, (at.barTicks / at.beatsPerBar) | 0);
    const beatInBar = Math.floor(at.offset / beatTicks) + 1;
    return { bar: at.bar + 1, beatInBar, label: `${at.bar + 1}.${beatInBar}` };
  } catch {
    const bpb = Math.max(1, score.beatsPerBar);
    const bar = Math.floor(beat / bpb) + 1;
    const beatInBar = Math.floor(beat - (bar - 1) * bpb) + 1;
    return { bar, beatInBar, label: `${bar}.${beatInBar}` };
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function captureContext(src: ContextSource): CommentContext {
  const presence = src.presence;
  const score = src.score;
  const trackId = presence?.focusedTrackId ?? undefined;
  const track =
    trackId !== undefined
      ? score.tracks.find((each) => each.id === trackId)
      : undefined;
  const param = src.focusedParam ?? presence?.param;
  const view: Record<string, unknown> = {};
  if (presence?.screen !== undefined) view.screen = presence.screen;
  if (presence?.param !== undefined) view.param = presence.param;
  if (presence?.pinned !== undefined) view.pinned = presence.pinned;
  if (presence?.follow !== undefined) view.follow = presence.follow;
  const focus: Record<string, unknown> = {};
  if (trackId !== undefined) focus.trackId = trackId;
  if (track !== undefined) {
    focus.trackName = track.name;
    focus.instrument = track.instrument;
  }
  if (param !== undefined) focus.param = param;
  if (src.patchNode !== undefined) focus.node = src.patchNode;
  const out: Record<string, unknown> = { rev: src.revision };
  if (presence?.pane !== undefined) out.pane = presence.pane;
  if (presence?.clientId !== undefined) out.clientId = presence.clientId;
  if (Object.keys(view).length > 0) out.view = view;
  if (Object.keys(focus).length > 0) out.focus = focus;
  if (src.playheadBeat !== undefined && Number.isFinite(src.playheadBeat)) {
    const beat = Math.max(0, src.playheadBeat);
    out.playhead = { beat: round(beat), ...position(score, beat) };
  }
  if (
    src.loop !== undefined &&
    Number.isFinite(src.loop.from) &&
    Number.isFinite(src.loop.to) &&
    src.loop.to > src.loop.from
  ) {
    const from = position(score, src.loop.from);
    const to = position(score, src.loop.to);
    out.loop = {
      fromBeat: round(src.loop.from),
      toBeat: round(src.loop.to),
      label: `${from.label}–${to.label}`,
    };
  }
  if (src.selection !== undefined) out.selection = src.selection;
  out.transport = {
    playing: src.transport?.playing ?? presence?.playing === true,
    recording: src.transport?.recording ?? presence?.recording !== undefined,
    bpm: score.tempoBpm,
  };
  return out as CommentContext;
}

/** `12.3 · bass/volume` — the short locator a comment line shows. */
export function contextLabel(context: CommentContext | undefined): string {
  if (context === undefined) return "";
  const parts: string[] = [];
  if (context.loop !== undefined) parts.push(context.loop.label);
  else if (context.playhead !== undefined) parts.push(context.playhead.label);
  const focus = context.focus;
  const name = focus?.trackName ?? focus?.trackId;
  if (name !== undefined)
    parts.push(focus?.param !== undefined ? `${name}/${focus.param}` : name);
  else if (focus?.param !== undefined) parts.push(focus.param);
  return parts.join(" · ");
}
