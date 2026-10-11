/**
 * The preset library commands (core/presets):
 *
 *   preset | /presets            the preset browser (category, then preset)
 *   preset <name>                load a preset on the focused track
 *   preset list [<category|tag|words>]   the catalog, filtered
 *   preset info [<name>]         what it is, its four knobs, similar presets
 *   preset next | prev           step through the current preset's category
 *   preset fav [<name>]          star or unstar (default: the current one)
 *   preset favs                  the starred presets
 *
 * An instrument preset makes the track play its patch (`/patch` opens it);
 * an effect-chain preset adds an effect patch, replacing the chain an
 * earlier `preset` loaded; a drum preset sets the drum track's kit. The
 * patch carries `from: preset:<name>`, so next/prev and the browser know
 * where the track is. One command is one revision.
 */
import { isPatchRef, PATCH_INSTRUMENT, type Patch } from "../../core/patch.ts";
import {
  CATEGORY_DOCS,
  PRESET_CATEGORIES,
  type Preset,
  type PresetCategory,
} from "../../core/presets/build.ts";
import { PRESETS, presetByName } from "../../core/presets/index.ts";
import { isDrumInstrument } from "../../core/drums.ts";
import {
  setPatch,
  updateTrack,
  type Track,
  type TrackScore,
} from "../../core/score.ts";
import { applySynthKit } from "./drums.ts";
import { nearest } from "./nearest.ts";

export type PresetCommand =
  | { type: "preset-browse"; list?: PresetListKind }
  | { type: "preset-use"; name: string }
  | { type: "preset-list"; query?: string }
  | { type: "preset-info"; name?: string }
  | { type: "preset-step"; step: 1 | -1 }
  | { type: "preset-fav"; name?: string }
  | { type: "preset-favs" };

/** What one browser list shows: a category, the stars, the neighbors of
 * the current preset, or everything. */
export type PresetListKind = PresetCategory | "favorites" | "similar" | "all";

/** The list a typed word names (`/presets bass`), if any. */
export function listKind(word: string | undefined): PresetListKind | undefined {
  if (!word) return undefined;
  if (word === "favorites" || word === "favs" || word === "starred")
    return "favorites";
  if (word === "similar" || word === "all") return word;
  return CATEGORY_SET.has(word) ? (word as PresetCategory) : undefined;
}

export type PresetResult = Readonly<{
  ok: boolean;
  message: string;
  next?: TrackScore;
  kind?: string;
  payload?: Record<string, unknown>;
  /** A listing or description (several lines), nothing changed. */
  read?: boolean;
  /** The favorite set after a `preset fav`. */
  favorites?: ReadonlySet<string>;
}>;

const PREFIX = "preset:";
const CATEGORY_SET = new Set<string>(PRESET_CATEGORIES);

export const PRESET_USAGE =
  "preset [<name> | list [<category|tag>] | info [<name>] | next | prev | fav [<name>] | favs] · preset warm-pad · preset list bass";

/** One line per category (core/presets/build.ts). */
export const CATEGORY_GIST = CATEGORY_DOCS;

const TOKEN = /^[a-z0-9][a-z0-9-]*$/;

export function parsePresetCommand(prompt: string): PresetCommand | undefined {
  const words = prompt.trim().replace(/^\//, "").split(/\s+/);
  const head = words[0]?.toLowerCase();
  if (head !== "preset" && head !== "presets") return undefined;
  const rest = words.slice(1).map((word) => word.toLowerCase());
  if (rest.length === 0) return { type: "preset-browse" };
  const [verb, ...tail] = rest;
  const arg = tail.join(" ").trim() || undefined;
  switch (verb) {
    case "list":
    case "ls":
    case "find":
    case "search":
      return { type: "preset-list", ...(arg ? { query: arg } : {}) };
    case "similar":
      if (!arg) return { type: "preset-browse", list: "similar" };
      if (!TOKEN.test(arg)) return undefined;
      return { type: "preset-info", name: arg };
    case "info":
    case "show":
      if (arg && !TOKEN.test(arg)) return undefined;
      return { type: "preset-info", ...(arg ? { name: arg } : {}) };
    case "next":
      return tail.length ? undefined : { type: "preset-step", step: 1 };
    case "prev":
    case "previous":
      return tail.length ? undefined : { type: "preset-step", step: -1 };
    case "fav":
    case "favorite":
    case "star":
      if (arg && !TOKEN.test(arg)) return undefined;
      return { type: "preset-fav", ...(arg ? { name: arg } : {}) };
    case "favs":
    case "favorites":
    case "starred":
      return tail.length ? undefined : { type: "preset-favs" };
    case "browse": {
      const list = listKind(arg);
      if (arg && !list) return undefined;
      return { type: "preset-browse", ...(list ? { list } : {}) };
    }
  }
  if (tail.length > 0 || !TOKEN.test(verb!)) return undefined;
  // `presets bass` opens the browser on a category; `preset bass` too.
  const list = listKind(verb);
  if (list && !presetByName(verb!)) return { type: "preset-browse", list };
  return { type: "preset-use", name: verb! };
}

/** The preset a track was loaded from, by its patch's provenance. */
export function trackPreset(track: Track | undefined): Preset | undefined {
  if (!track) return undefined;
  const fromOf = (patch: Patch | undefined) =>
    patch?.from?.startsWith(PREFIX)
      ? presetByName(patch.from.slice(PREFIX.length))
      : undefined;
  if (
    track.instrument === PATCH_INSTRUMENT &&
    track.patch &&
    !isPatchRef(track.patch)
  ) {
    const found = fromOf(track.patch);
    if (found) return found;
  }
  for (const fx of [...(track.fxPatch ?? [])].reverse()) {
    const found = fromOf(fx);
    if (found) return found;
  }
  if (isDrumInstrument(track.instrument) && track.kit)
    return PRESETS.find((p) => p.kind === "kit" && p.kit === track.kit);
  return undefined;
}

/** The knob receipt: `Grit drive · Motion filter sweep · …`. */
export function knobLine(preset: Preset): string {
  return preset.knobs.map((k) => `${k.label} ${k.doc}`).join(" · ");
}

/** The four knob names, `Grit · Motion · Space · Bloom`. */
export function knobNames(preset: Preset): string {
  return preset.knobs.map((k) => k.label).join(" · ");
}

/**
 * How well `query` matches a preset (higher is better), or 0 for no
 * match. Every word must match something: the name, a tag, the category,
 * the description or a knob, exactly, as a prefix, or as a subsequence of
 * the name (`wrmpd` finds warm-pad).
 */
export function presetScore(preset: Preset, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let total = 0;
  for (const word of words) {
    const score = wordScore(preset, word);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

function wordScore(preset: Preset, word: string): number {
  const name = preset.name;
  if (name === word) return 100;
  if (name.startsWith(word)) return 80;
  if (name.split("-").some((part) => part.startsWith(word))) return 70;
  if (preset.tags.includes(word)) return 60;
  if (preset.category === word) return 55;
  if (preset.tags.some((tag) => tag.startsWith(word))) return 45;
  if (name.includes(word)) return 40;
  if (preset.knobs.some((k) => k.label.toLowerCase() === word)) return 30;
  if (
    preset.desc.toLowerCase().includes(word) ||
    preset.feature.toLowerCase().includes(word)
  )
    return 20;
  if (word.length >= 3 && subsequence(name.replace(/-/g, ""), word)) return 10;
  return 0;
}

function subsequence(text: string, word: string): boolean {
  let at = 0;
  for (const ch of text) if (ch === word[at]) at += 1;
  return at >= word.length;
}

/** Presets matching `query`, best first (catalog order breaks ties). */
export function findPresets(query: string): Preset[] {
  return PRESETS.map((preset, index) => ({
    preset,
    index,
    score: presetScore(preset, query),
  }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.preset);
}

/**
 * Presets that sound alike: shared tags weigh most, then the same
 * category, then the same engines. Drum kits only match kits.
 */
export function similarPresets(preset: Preset, count = 5): Preset[] {
  const tags = new Set(preset.tags);
  const engines = new Set(preset.nodes.filter((n) => n.startsWith("engine.")));
  return PRESETS.filter(
    (other) =>
      other !== preset &&
      (other.kind === "kit") === (preset.kind === "kit") &&
      (other.kind === "effect") === (preset.kind === "effect"),
  )
    .map((other, index) => {
      const shared = other.tags.filter((tag) => tags.has(tag)).length;
      const engine = other.nodes.some((n) => engines.has(n)) ? 1 : 0;
      const category = other.category === preset.category ? 1.5 : 0;
      return { other, index, score: shared * 2 + category + engine };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, count)
    .map((row) => row.other);
}

/** Presets of one category, in catalog order. */
export function presetsIn(category: PresetCategory): Preset[] {
  return PRESETS.filter((preset) => preset.category === category);
}

/** One catalog row: `warm-pad  pad  Grit · Motion · Space · Bloom  — desc`. */
export function presetRow(preset: Preset, favorite = false): string {
  const knobs = preset.kind === "kit" ? "kit" : knobNames(preset);
  return `${favorite ? "* " : ""}${preset.name} · ${preset.category} · ${knobs} · ${preset.desc}`;
}

/** The lines of `preset info`. */
export function presetInfo(preset: Preset): string[] {
  const lines = [
    `${preset.name} · ${preset.category} · ${preset.tags.join(" ")}`,
    preset.desc,
    `uses: ${preset.feature}`,
  ];
  if (preset.kind === "kit")
    lines.push(`kit ${preset.kit} · /kit ${preset.kit}`);
  else {
    for (const [i, k] of preset.knobs.entries())
      lines.push(`knob ${i + 1} ${k.label}: ${k.doc}`);
    lines.push(
      preset.kind === "effect"
        ? `open it: /patch --fx ${preset.name} · nodes: ${preset.nodes.join(" ")}`
        : `open it: /patch · nodes: ${preset.nodes.join(" ")}`,
    );
  }
  const similar = similarPresets(preset);
  if (similar.length)
    lines.push(`similar: ${similar.map((p) => p.name).join(" ")}`);
  return lines;
}

function unknown(name: string): PresetResult {
  const guess =
    nearest(
      name,
      PRESETS.map((p) => p.name),
    ) ?? findPresets(name)[0]?.name;
  return {
    ok: false,
    message: `preset · no preset ${name.slice(0, 40)}${guess ? ` · did you mean ${guess}?` : ""} · preset list`,
  };
}

/** Loads `preset` on `trackId`: the track's patch, an effect patch or a kit. */
export function usePreset(
  score: TrackScore,
  trackId: string,
  preset: Preset,
): PresetResult {
  const track = score.tracks.find((t) => t.id === trackId);
  if (!track) return { ok: false, message: `preset · no track ${trackId}` };
  const drums = isDrumInstrument(track.instrument);
  if (preset.kind === "kit") {
    if (!drums)
      return {
        ok: false,
        message: `preset ${preset.name} is a kit · focus a drum track (/track drums)`,
      };
    const result = applySynthKit(score, trackId, preset.kit!);
    if (!result.ok || !result.next)
      return { ok: result.ok, message: result.message };
    return {
      ok: true,
      message: `${trackId}: ${preset.name} · ${preset.desc}`,
      next: result.next,
      kind: "preset.use",
      payload: { trackId, preset: preset.name },
    };
  }
  const patch: Patch = { ...preset.patch!, from: `${PREFIX}${preset.name}` };
  if (preset.kind === "effect") {
    const stages = track.fxPatch ?? [];
    // Browsing chains swaps the one an earlier `preset` loaded in place.
    const at = stages.findIndex((p) => p.from?.startsWith(PREFIX));
    if (stages.some((p, i) => p.name === preset.name && i !== at))
      return {
        ok: true,
        message: `${trackId} already has ${preset.name}`,
      };
    let next = score;
    if (at >= 0) next = setPatch(next, { trackId, fx: stages[at]!.name }, null);
    next = setPatch(
      next,
      { trackId, fx: preset.name },
      patch,
      at >= 0 ? at : stages.length,
    );
    return {
      ok: true,
      message: `${trackId}: chain ${preset.name} · ${knobLine(preset)} · /patch --fx ${preset.name}`,
      next,
      kind: "preset.use",
      payload: { trackId, preset: preset.name },
    };
  }
  if (drums)
    return {
      ok: false,
      message: `preset ${preset.name} is for melodic tracks · on drums try preset list drums`,
    };
  const next = updateTrack(score, trackId, {
    instrument: PATCH_INSTRUMENT,
    patch,
  });
  return {
    ok: true,
    message: `${trackId}: ${preset.name} · ${knobLine(preset)} · /patch opens it`,
    next,
    kind: "preset.use",
    payload: { trackId, preset: preset.name },
  };
}

/** The preset `step` away from the track's in its category (wrapping). */
export function steppedPreset(
  track: Track | undefined,
  step: 1 | -1,
): Preset | undefined {
  const current = trackPreset(track);
  const drums = track ? isDrumInstrument(track.instrument) : false;
  const pool = current
    ? presetsIn(current.category)
    : PRESETS.filter(
        (p) => (p.kind === "kit") === drums && p.kind !== "effect",
      );
  if (pool.length === 0) return undefined;
  const at = current ? pool.indexOf(current) : -1;
  const index = at < 0 ? (step > 0 ? 0 : pool.length - 1) : at + step;
  return pool[(index + pool.length) % pool.length];
}

export function applyPresetCommand(
  score: TrackScore,
  trackId: string,
  command: PresetCommand,
  favorites: ReadonlySet<string> = new Set(),
): PresetResult {
  const track = score.tracks.find((t) => t.id === trackId);
  switch (command.type) {
    case "preset-browse": {
      const lines = PRESET_CATEGORIES.map(
        (c) => `${c} · ${presetsIn(c).length} · ${CATEGORY_GIST[c]}`,
      );
      return {
        ok: true,
        read: true,
        message: [
          `presets · ${PRESETS.length} in ${PRESET_CATEGORIES.length} categories · preset list <category>`,
          ...(command.list && CATEGORY_SET.has(command.list)
            ? presetsIn(command.list as PresetCategory).map((p) =>
                presetRow(p, favorites.has(p.name)),
              )
            : lines),
        ].join("\n"),
      };
    }
    case "preset-list": {
      const query = command.query ?? "";
      const list = CATEGORY_SET.has(query)
        ? presetsIn(query as PresetCategory)
        : findPresets(query);
      if (list.length === 0)
        return {
          ok: true,
          read: true,
          message: `presets · nothing matches ${query.slice(0, 40)} · try a category: ${PRESET_CATEGORIES.join(" ")}`,
        };
      return {
        ok: true,
        read: true,
        message: [
          `presets${query ? ` matching ${query}` : ""} · ${list.length}`,
          ...list.map((p) => presetRow(p, favorites.has(p.name))),
        ].join("\n"),
      };
    }
    case "preset-info": {
      const preset = command.name
        ? presetByName(command.name)
        : trackPreset(track);
      if (!preset)
        return command.name
          ? unknown(command.name)
          : {
              ok: false,
              message: `preset info · ${trackId} plays no preset · preset info <name>`,
            };
      return { ok: true, read: true, message: presetInfo(preset).join("\n") };
    }
    case "preset-favs": {
      const list = PRESETS.filter((p) => favorites.has(p.name));
      return {
        ok: true,
        read: true,
        message: list.length
          ? [
              `favorites · ${list.length}`,
              ...list.map((p) => presetRow(p, true)),
            ].join("\n")
          : "favorites · none yet · preset fav <name>, or * in the browser",
      };
    }
    case "preset-fav": {
      const preset = command.name
        ? presetByName(command.name)
        : trackPreset(track);
      if (!preset)
        return command.name
          ? unknown(command.name)
          : { ok: false, message: `preset fav · ${trackId} plays no preset` };
      const next = new Set(favorites);
      const starred = !next.delete(preset.name);
      if (starred) next.add(preset.name);
      return {
        ok: true,
        message: `${preset.name} ${starred ? "starred" : "unstarred"} · preset favs`,
        favorites: next,
      };
    }
    case "preset-step": {
      const preset = steppedPreset(track, command.step);
      if (!preset)
        return { ok: false, message: `preset · nothing to step through` };
      return usePreset(score, trackId, preset);
    }
    case "preset-use": {
      const preset = presetByName(command.name);
      if (!preset) return unknown(command.name);
      return usePreset(score, trackId, preset);
    }
  }
}
