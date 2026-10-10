/**
 * Which value each of the four knobs turns, per page (design §7.3): one
 * table, read by the fader drawer's front page, the mixer page and euclid.
 * A row is four menu paths from the Ctrl-K root (`sound/attack`,
 * `effects/reverb/mix`, `mix/volume`): segments match a submenu's id or a
 * row's label, and `more effects` is searched on the way. An undefined slot
 * shows as `·` and ↑↓ skips it.
 *
 * The rule (tui/knobs.ts): blue moves, green sizes, white shapes, orange
 * level. Pages not in the table (an effect without a row) derive one: their
 * first three number rows on blue, green and white, and `mix` on orange.
 *
 * Data, not code, so the patcher can map a patch's macros onto the same
 * four knobs by adding rows (`patch:<id>`), and a test checks every path
 * resolves for every instrument family. A `*` at the end of a segment
 * matches the first submenu whose id starts with it (`sample:*`); `#n` is
 * the nth row of its level (a patch's macros have no fixed labels).
 */
import { PATCH_INSTRUMENT } from "../../core/patch.ts";
import { isWavetableInstrument, type Track } from "../../core/score.ts";
import { isDrumInstrument } from "../../core/drums.ts";
import {
  isElectricFamily,
  isKeysFamily,
  isOrganFamily,
} from "../../core/keys.ts";
import { isStringTrack } from "../../core/strings.ts";
import { isGranularInstrument } from "../../core/granular.ts";

export type KnobRef = string | undefined;
export type KnobMap = readonly [KnobRef, KnobRef, KnobRef, KnobRef];

/**
 * Pages, by id. `sound:<family>` rows use each engine's own param names (the
 * rows its Sound menu shows); orange is the track level on every sound page,
 * so ◆ always means "how loud".
 */
export const KNOB_MAPS: Readonly<Record<string, KnobMap>> = Object.freeze({
  "sound:synth": [
    "sound/preset",
    "sound/attack",
    "sound/synth filter",
    "mix/volume",
  ],
  "sound:wavetable": [
    "sound/position (wt)",
    "sound/attack",
    "sound/synth filter",
    "mix/volume",
  ],
  "sound:piano": [
    "sound/preset",
    "sound/decay",
    "sound/hardness",
    "mix/volume",
  ],
  "sound:electric": ["sound/preset", "sound/bell", "sound/tone", "mix/volume"],
  "sound:organ": ["sound/preset", "sound/perc", "sound/drive", "mix/volume"],
  "sound:string": [
    "sound/preset",
    "sound/ring s",
    "sound/bright",
    "mix/volume",
  ],
  "sound:wind": [
    "sound/breath",
    "sound/wind:advanced/vib",
    "sound/bright",
    "mix/volume",
  ],
  "sound:modal": [
    "sound/position",
    "sound/ring",
    "sound/hardness",
    "mix/volume",
  ],
  "sound:sing": ["sound/vowel", "sound/voices", "sound/bright", "mix/volume"],
  "sound:granular": [
    "sound/granular/position",
    "sound/granular/grain (s)",
    "sound/granular/spray (s)",
    "mix/volume",
  ],
  // `sample:*` is the track's first sample voice.
  "sound:sampler": [
    "sound/sample:*/begin",
    "sound/sample:*/len",
    "sound/sample:*/speed",
    "mix/volume",
  ],
  // A kit has no voice params: blue loosens the timing, green the room it
  // plays in, white its tone.
  "sound:kit": [
    "sound/performance/humanize timing (ms)",
    "effects/reverb/mix",
    "effects/filter/cutoff",
    "mix/volume",
  ],
  // The mixer page: this track's pan, reverb send, tone and level.
  mix: ["mix/pan", "effects/reverb/mix", "effects/filter/cutoff", "mix/volume"],
  master: [
    "mix/master/master:eq/low",
    "mix/master/master:eq/bell1",
    "mix/master/master:eq/high",
    "mix/master/target LUFS",
  ],
  tempo: [
    "project/tempo",
    "project/loop length",
    "project/beats per bar",
    undefined,
  ],
  // Effects: time or rate, feedback / size / depth, tone, mix.
  "fx:filter": [
    "effects/filter/type",
    "effects/filter/resonance",
    "effects/filter/cutoff",
    undefined,
  ],
  "fx:delay": [
    "effects/delay/beats",
    "effects/delay/feedback",
    undefined,
    "effects/delay/mix",
  ],
  "fx:reverb": [
    "effects/reverb/impulse (ir)",
    "effects/reverb/size",
    undefined,
    "effects/reverb/mix",
  ],
  "fx:chorus": [
    "effects/chorus/rate",
    "effects/chorus/depth",
    undefined,
    "effects/chorus/mix",
  ],
  /**
   * The Euclid editor (design §8.7): its row's own fields, not menu paths.
   * Blue picks the drum row; ←→ on it moves between rows.
   */
  euclid: ["drum", "pulses", "rotate", "velocity"],
  /**
   * TAPE (design §7.3): its own values, not menu paths. Blue the playhead
   * (a beat; ⇧ a bar), green the loop length, white the tempo of the
   * segment under the playhead, orange the focused track's volume.
   */
  tape: ["playhead", "loop", "tempo", "volume"],
  /**
   * A patch track (patcher design §4): the patch's first four macros, in
   * order (`#n` is the nth row of Sound › patch › knobs). A patch with
   * fewer macros leaves the rest `·`. The patch view's header reads the
   * same row.
   */
  "sound:patch": [
    "sound/patch/knobs/#1",
    "sound/patch/knobs/#2",
    "sound/patch/knobs/#3",
    "sound/patch/knobs/#4",
  ],
  "fx:distort": [
    undefined,
    "effects/distort/drive",
    "effects/distort/tone",
    "effects/distort/mix",
  ],
});

/** The sound page's family for a track: which engine its Sound menu shows. */
export function soundFamily(track: Track): string {
  if (track.instrument === PATCH_INSTRUMENT && track.patch) return "patch";
  if (isDrumInstrument(track.instrument)) return "kit";
  if (track.sampler) return "sampler";
  if (isGranularInstrument(track.instrument)) return "granular";
  if (isOrganFamily(track.instrument) && track.keys) return "organ";
  if (isKeysFamily(track.instrument) && track.keys)
    return isElectricFamily(track.instrument) ? "electric" : "piano";
  if (isStringTrack(track)) return "string";
  if (track.instrument === "modal") return "modal";
  if (track.instrument === "wind" && track.wind) return "wind";
  if (track.instrument === "sing" && track.sing) return "sing";
  if (isWavetableInstrument(track.instrument)) return "wavetable";
  return "synth";
}

/** The page id for `knobs <page>`, or undefined when no page has that name. */
export function knobPageId(
  word: string | undefined,
  track: Track | undefined,
): string | undefined {
  const name = (word ?? "sound").trim().toLowerCase().replace(/\s+/g, " ");
  if (name === "sound" || name === "")
    return `sound:${track ? soundFamily(track) : "synth"}`;
  if (name === "mix" || name === "master" || name === "tempo") return name;
  const fx = name.match(/^(?:fx|effect|effects)\s+(\S+)$/)?.[1];
  if (fx) return `fx:${fx}`;
  if (`sound:${name}` in KNOB_MAPS) return `sound:${name}`;
  return undefined;
}

/** The page's row; an unmapped effect gets none (the menu derives one). */
export function knobMap(page: string): KnobMap | undefined {
  return KNOB_MAPS[page];
}

/** The pages `knobs` names, for help and completion. */
export const KNOB_PAGE_WORDS = Object.freeze([
  "sound",
  "mix",
  "master",
  "tempo",
  "fx <effect>",
]);
