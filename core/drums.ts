/**
 * Drum vocabulary shared by the parser, renderer, highway, and planner.
 *
 * A drum track is an ordinary track whose instrument is a kit (`kit`,
 * `drums`, `drum`, or `drumkit`). Its notes keep the score's MIDI `pitch`
 * field, using General MIDI percussion numbers to select a voice, so drum
 * hits round-trip through `track.loop/v1` without a new note shape.
 */

export type DrumVoice =
  "kick" | "snare" | "clap" | "rim" | "tom" | "hat" | "openhat";

export type DrumVoiceInfo = Readonly<{
  voice: DrumVoice;
  pitch: number;
  label: string;
  /** Four columns at most: play mode prints it under the key. */
  short: string;
}>;

/** Ordered left to right as highway lanes. */
export const DRUM_VOICES: readonly DrumVoiceInfo[] = Object.freeze([
  Object.freeze({ voice: "kick", pitch: 36, label: "kick", short: "kick" }),
  Object.freeze({ voice: "snare", pitch: 38, label: "snare", short: "snr" }),
  Object.freeze({ voice: "clap", pitch: 39, label: "clap", short: "clap" }),
  Object.freeze({ voice: "rim", pitch: 37, label: "rim", short: "rim" }),
  Object.freeze({ voice: "tom", pitch: 45, label: "tom", short: "tom" }),
  Object.freeze({ voice: "hat", pitch: 42, label: "hat", short: "chh" }),
  Object.freeze({ voice: "openhat", pitch: 46, label: "open", short: "ohh" }),
] as const);

export const DRUM_INSTRUMENTS = Object.freeze([
  "kit",
  "drums",
  "drum",
  "drumkit",
] as const);

const VOICE_ALIASES: Readonly<Record<string, DrumVoice>> = Object.freeze({
  kick: "kick",
  bd: "kick",
  snare: "snare",
  sd: "snare",
  clap: "clap",
  cp: "clap",
  rim: "rim",
  rimshot: "rim",
  perc: "rim",
  tom: "tom",
  lt: "tom",
  hat: "hat",
  hh: "hat",
  hihat: "hat",
  "hi-hat": "hat",
  closedhat: "hat",
  "closed-hat": "hat",
  chh: "hat",
  openhat: "openhat",
  "open-hat": "openhat",
  ohh: "openhat",
  oh: "openhat",
  open: "openhat",
});

/** Extra General MIDI numbers folded onto the nearest local voice. */
const PITCH_ALIASES: Readonly<Record<number, DrumVoice>> = Object.freeze({
  35: "kick",
  40: "snare",
  41: "tom",
  43: "tom",
  44: "hat",
  47: "tom",
  48: "tom",
  50: "tom",
});

export function isDrumInstrument(instrument: string | undefined): boolean {
  if (typeof instrument !== "string") return false;
  return (DRUM_INSTRUMENTS as readonly string[]).includes(
    instrument.trim().toLowerCase(),
  );
}

export function parseDrumVoice(value: string): DrumVoice | undefined {
  return VOICE_ALIASES[value.trim().toLowerCase()];
}

export function drumVoicePitch(voice: DrumVoice): number {
  return DRUM_VOICES.find((info) => info.voice === voice)!.pitch;
}

/**
 * The voice a GM pitch names, aliases included, or undefined for a number
 * the kit only plays by falling back to `rim`.
 */
export function drumVoiceNamed(pitch: number): DrumVoice | undefined {
  return (
    DRUM_VOICES.find((info) => info.pitch === pitch)?.voice ??
    PITCH_ALIASES[pitch]
  );
}

/** Any MIDI pitch resolves to a voice; unknown numbers play as `rim`. */
export function drumVoiceForPitch(pitch: number): DrumVoice {
  return (
    DRUM_VOICES.find((info) => info.pitch === pitch)?.voice ??
    PITCH_ALIASES[pitch] ??
    "rim"
  );
}

export function drumLane(pitch: number): number {
  const voice = drumVoiceForPitch(pitch);
  return DRUM_VOICES.findIndex((info) => info.voice === voice);
}
