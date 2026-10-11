/**
 * `slice` with `track`: the files a slice wrote become one-shot sampler
 * voices on that track (created when missing), on consecutive pitch slots,
 * and with `pattern` one trigger note per slice at its original onset. The
 * result is plain score operations, committed as one revision by the agent
 * loop or the typed command, so undo removes all of it at once.
 */
import {
  SAMPLER_FIRST_SLOT,
  SCORE_LIMITS,
  isSamplerInstrument,
  samplerVoiceSlots,
  type SampleRef,
  type ScoreOperation,
  type TrackScore,
} from "../../../core/score.ts";
import { ChopError } from "./pcm.ts";
import type { ChopOutput } from "./types.ts";

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** `<stem>_<n>`: voice names must match /^[A-Za-z][A-Za-z0-9_]*$/. */
export function sliceVoiceName(stem: string, index: number): string {
  const suffix = `_${index + 1}`;
  let base = stem.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^[^A-Za-z]+/, "");
  if (!base) base = "slice";
  base = base.slice(0, SCORE_LIMITS.maxSamplerVoiceNameLength - suffix.length);
  return `${base}${suffix}`;
}

export type SliceToSampler = Readonly<{
  operations: ScoreOperation[];
  voices: readonly string[];
  trackId: string;
  created: boolean;
  notes: number;
}>;

export function slicesToSampler(
  score: TrackScore,
  trackId: string,
  stem: string,
  outputs: readonly ChopOutput[],
  options: Readonly<{
    pattern?: boolean;
    newNoteId: (index: number) => string;
  }>,
): SliceToSampler {
  if (!ID.test(trackId))
    throw new ChopError("track must be an id (letters, digits, . _ -)");
  if (outputs.length === 0) throw new ChopError("no slices to load");
  const existing = score.tracks.find((t) => t.id === trackId);
  if (existing && !isSamplerInstrument(existing.instrument))
    throw new ChopError(
      `track ${trackId} is ${existing.instrument}, not a sampler · pick another track or a new id`,
    );
  if (existing?.sampler && existing.sampler.mode !== "oneshot")
    throw new ChopError(
      `track ${trackId} is a keyed sampler; slices need one-shot`,
    );
  const voices: Record<string, SampleRef> = {
    ...(existing?.sampler?.voices ?? {}),
  };
  const names: string[] = [];
  outputs.forEach((output, index) => {
    let name = sliceVoiceName(stem, index);
    for (let n = 2; voices[name] && n < 100; n += 1)
      name = sliceVoiceName(`${stem}${n}`, index);
    voices[name] = { src: output.path, sha256: output.sha256 };
    names.push(name);
  });
  const total = Object.keys(voices).length;
  if (total > SCORE_LIMITS.maxSamplerVoices)
    throw new ChopError(
      `${total} voices exceeds the sampler cap of ${SCORE_LIMITS.maxSamplerVoices} · use count to slice fewer`,
    );
  const sampler = { mode: "oneshot" as const, voices };
  const operations: ScoreOperation[] = existing
    ? [{ type: "updateTrack", trackId, patch: { sampler } }]
    : [
        {
          type: "addTrack",
          track: { id: trackId, name: trackId, instrument: "sampler", sampler },
        },
      ];
  let notes = 0;
  if (options.pattern) {
    const slots = samplerVoiceSlots(sampler);
    const ticksPerSecond = (score.tempoBpm / 60) * score.ticksPerBeat;
    const first = outputs[0]!.from ?? 0;
    const room = SCORE_LIMITS.maxNotes - score.notes.length;
    if (outputs.length > room)
      throw new ChopError(
        `the pattern needs ${outputs.length} notes; the score has room for ${room}`,
      );
    outputs.forEach((output, index) => {
      const start = Math.round(((output.from ?? 0) - first) * ticksPerSecond);
      operations.push({
        type: "addNote",
        note: {
          id: options.newNoteId(index),
          trackId,
          startTick: Math.max(0, start),
          durationTicks: Math.max(
            1,
            Math.round(output.seconds * ticksPerSecond),
          ),
          pitch: slots.get(names[index]!) ?? SAMPLER_FIRST_SLOT,
          velocity: 1,
        },
      });
      notes += 1;
    });
  }
  return { operations, voices: names, trackId, created: !existing, notes };
}
