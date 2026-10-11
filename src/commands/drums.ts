/**
 * Drum patterns and synthesized kits as score edits.
 *
 *   /pattern                 browse the library (picker with preview)
 *   /pattern <name>          put the pattern on the focused drum track
 *   /pattern list            the library as text
 *   /kit <synth kit>         syn808, syn909, acoustic, lofi, electro, trap,
 *                            syn606, syn707, synlinn, breaks
 *   /kit default             the built-in voices again
 *
 * Sample kits (`/kit 909`, `/kit RolandTR808`) stay in `commands/pack.ts`;
 * `/kit` with no name opens one picker listing both kinds.
 *
 * Every edit is one next score, so one revision and one undo step.
 */
import {
  drumVoicePitch,
  isDrumInstrument,
  parseDrumVoice,
} from "../../core/drums.ts";
import { normalizeRhythmRow, type RhythmRow } from "../../core/euclid.ts";
import { synthKit, SYNTH_KITS } from "../../core/kits.ts";
import { rhythmVoicePitch, withTrackRhythm } from "../../core/rhythm.ts";
import {
  isSamplerInstrument,
  samplerVoiceSlots,
  ScoreValidationError,
  TrackScore,
  type Note,
  type Track,
} from "../../core/score.ts";
import {
  DRUM_PATTERNS,
  findPattern,
  type DrumPattern,
} from "../../core/sdk/v1.ts";

export { DRUM_PATTERNS, findPattern, type DrumPattern };

export type PatternCommand =
  | Readonly<{ kind: "browse" }>
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "apply"; name: string; tempo: TempoMode }>;

/**
 * `auto` moves the tempo only when it is outside the pattern's range;
 * `keep` never moves it; `set` always uses the pattern's tempo.
 */
export type TempoMode = "auto" | "keep" | "set";

/** `/pattern`, `/pattern list`, `/pattern <name> [keep-tempo|tempo]`. */
export function parsePatternCommand(
  command: string,
): PatternCommand | undefined {
  const match = command
    .trim()
    .match(
      /^\/?(?:patterns?|grooves?)(?:\s+([a-z0-9][\w-]{0,40}))?(?:\s+(keep-tempo|keep|tempo))?\s*$/i,
    );
  if (!match) return undefined;
  const name = match[1]?.toLowerCase();
  if (!name) return { kind: "browse" };
  if (name === "list" || name === "ls" || name === "presets")
    return { kind: "list" };
  const flag = match[2]?.toLowerCase();
  return {
    kind: "apply",
    name,
    tempo: flag === "tempo" ? "set" : flag ? "keep" : "auto",
  };
}

/** One line per pattern for `/pattern list` and the agent. */
export function patternLine(entry: DrumPattern): string {
  const voices = entry.rows.map((row) => row.voice).join(" ");
  return `${entry.name} · ${entry.tempo.min}–${entry.tempo.max} BPM · ${entry.tags.join(", ")} · ${voices}`;
}

export type DrumEdit = Readonly<{
  ok: boolean;
  message: string;
  next?: TrackScore;
  kind?: string;
  payload?: Record<string, unknown>;
}>;

function rowsOf(entry: DrumPattern): RhythmRow[] {
  return entry.rows.map((spec, index) => {
    const { kind: _kind, ...fields } = spec;
    return normalizeRhythmRow(fields, `${entry.name} rows[${index}]`);
  });
}

/**
 * The focused track as a drum track: a kit track as is, a missing or empty
 * melodic track as a new kit track. Undefined for a melodic track with
 * notes or a keyed sampler, which a pattern must not overwrite.
 */
function drumTrack(
  score: TrackScore,
  trackId: string,
): { score: TrackScore; track: Track } | undefined {
  const track = score.tracks.find((candidate) => candidate.id === trackId);
  if (!track) {
    const next = score.withTracks([
      ...score.tracks,
      { id: trackId, name: trackId, instrument: "kit" },
    ]);
    return { score: next, track: next.tracks.at(-1)! };
  }
  if (isDrumInstrument(track.instrument)) return { score, track };
  if (isSamplerInstrument(track.instrument))
    return track.sampler?.mode === "oneshot" ? { score, track } : undefined;
  if (score.notes.some((note) => note.trackId === trackId)) return undefined;
  const next = score.withTracks(
    score.tracks.map((candidate) =>
      candidate.id === trackId
        ? { ...candidate, instrument: "kit", rhythm: null }
        : candidate,
    ),
  );
  return { score: next, track: next.tracks.find((t) => t.id === trackId)! };
}

/**
 * The score with `name` on `trackId`: the track's notes and rows are
 * replaced by the pattern's rows (voices the track lacks are skipped), and
 * the tempo follows `tempo`.
 */
export function applyDrumPattern(
  score: TrackScore,
  trackId: string,
  name: string,
  tempo: TempoMode = "auto",
): DrumEdit {
  const entry = findPattern(name);
  if (!entry)
    return {
      ok: false,
      message: `pattern · no ${name.slice(0, 40)} · /pattern list`,
    };
  const target = drumTrack(score, trackId);
  if (!target)
    return {
      ok: false,
      message: `pattern · ${trackId} is a melodic track · focus a drum track (/track drums) and retry`,
    };
  const rows = rowsOf(entry);
  const playable = rows.filter(
    (row) => rhythmVoicePitch(target.track, row.voice) !== undefined,
  );
  const skipped = rows
    .filter((row) => !playable.includes(row))
    .map((row) => row.voice);
  if (playable.length === 0)
    return {
      ok: false,
      message: `pattern · ${trackId} has none of ${rows.map((row) => row.voice).join("/")}`,
    };
  const moveTempo =
    tempo === "set" ||
    (tempo === "auto" &&
      (score.tempoBpm < entry.tempo.min || score.tempoBpm > entry.tempo.max));
  const cleared = new TrackScore({
    ...target.score.toJSON(),
    ...(moveTempo ? { tempoBpm: entry.tempo.bpm } : {}),
    tracks: target.score.tracks.map((candidate) =>
      candidate.id === trackId ? { ...candidate, rhythm: null } : candidate,
    ),
    notes: target.score.notes.filter((note) => note.trackId !== trackId),
  });
  let next: TrackScore;
  try {
    next = withTrackRhythm(cleared, trackId, playable);
  } catch (error) {
    if (error instanceof ScoreValidationError)
      return { ok: false, message: `pattern · ${error.message}` };
    throw error;
  }
  const parts = [`pattern ${entry.name} on ${trackId}`];
  if (moveTempo) parts.push(`${entry.tempo.bpm} BPM`);
  if (skipped.length) parts.push(`no ${skipped.join("/")}`);
  const track = next.tracks.find((candidate) => candidate.id === trackId);
  if (isDrumInstrument(track?.instrument) && !track?.kit)
    parts.push(`try /kit ${entry.kit}`);
  return {
    ok: true,
    message: parts.join(" · "),
    next,
    kind: "score.pattern",
    payload: {
      trackId,
      pattern: entry.name,
      ...(moveTempo ? { tempoBpm: entry.tempo.bpm } : {}),
    },
  };
}

/** True for names `/kit` should treat as a synthesized kit. */
export function isSynthKitName(name: string): boolean {
  return (
    name.trim().toLowerCase() === "default" || synthKit(name) !== undefined
  );
}

/**
 * The score with synth kit `name` (`default` for the built-in voices) on
 * `trackId`. A oneshot sampler kit (from `/kit 909`) turns back into a
 * synth kit track; its hits and rows move to the drum voices of the same
 * name, and voices without one are dropped.
 */
export function applySynthKit(
  score: TrackScore,
  trackId: string,
  name: string,
): DrumEdit {
  const isDefault = name.trim().toLowerCase() === "default";
  const kit = isDefault ? undefined : synthKit(name);
  if (!isDefault && !kit)
    return {
      ok: false,
      message: `kit · no synth kit ${name.slice(0, 40)} (default ${SYNTH_KITS.map((entry) => entry.name).join(" ")})`,
    };
  const track = score.tracks.find((candidate) => candidate.id === trackId);
  const label = kit?.name ?? "default";
  const done = (next: TrackScore, extra = ""): DrumEdit => ({
    ok: true,
    message: `kit ${label} on ${trackId}${extra}`,
    next,
    kind: "score.kit",
    payload: { trackId, kit: label },
  });
  if (!track)
    return done(
      score.withTracks([
        ...score.tracks,
        {
          id: trackId,
          name: trackId,
          instrument: "kit",
          ...(kit ? { kit: kit.name } : {}),
        },
      ]),
    );
  if (isDrumInstrument(track.instrument)) {
    if ((track.kit ?? undefined) === kit?.name)
      return { ok: true, message: `kit ${label} on ${trackId} already` };
    return done(
      score.withTracks(
        score.tracks.map((candidate) =>
          candidate.id === trackId
            ? { ...candidate, kit: kit ? kit.name : null }
            : candidate,
        ),
      ),
    );
  }
  const oneshot =
    isSamplerInstrument(track.instrument) && track.sampler?.mode === "oneshot";
  const hasNotes = score.notes.some((note) => note.trackId === trackId);
  if (!oneshot && hasNotes)
    return {
      ok: false,
      message: `kit · ${trackId} is a melodic track · focus a drum track (/track drums) and retry`,
    };
  const pitchOf = new Map<number, number>();
  if (oneshot && track.sampler)
    for (const [voice, slot] of samplerVoiceSlots(track.sampler)) {
      const drum = parseDrumVoice(voice);
      if (drum) pitchOf.set(slot, drumVoicePitch(drum));
    }
  const notes: Note[] = [];
  let dropped = 0;
  for (const note of score.notes) {
    if (note.trackId !== trackId) {
      notes.push(note);
      continue;
    }
    const pitch = pitchOf.get(note.pitch);
    if (pitch === undefined) dropped += 1;
    else notes.push({ ...note, pitch });
  }
  const rows = (track.rhythm ?? []).filter(
    (row) => parseDrumVoice(row.voice) !== undefined,
  );
  const next = new TrackScore({
    ...score.toJSON(),
    tracks: score.tracks.map((candidate) => {
      if (candidate.id !== trackId) return candidate;
      const { sampler: _sampler, ...rest } = candidate;
      return {
        ...rest,
        instrument: "kit",
        rhythm: rows.length > 0 ? rows : null,
        ...(kit ? { kit: kit.name } : {}),
      };
    }),
    notes,
  });
  return done(next, dropped ? ` · ${dropped} hits had no synth voice` : "");
}
