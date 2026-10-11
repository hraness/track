/**
 * The preset browser (`/presets`, `preset`, Ctrl-K › Sound › preset
 * library): two pickers over core/presets.
 *
 *   presets            categories, favorites and "similar to what plays";
 *                      typing searches every preset at once (fuzzy)
 *   preset             one category's presets: moving hears each one,
 *                      enter keeps it, esc reverts; typing searches the
 *                      whole catalog, * stars, → similar, ← categories
 *
 * Each preset row shows its four knob names; the line under the rows says
 * which engine feature it uses and how to open it in /patch. Pure: the
 * host opens the pickers and runs the chosen commands.
 */
import { PRESET_CATEGORIES } from "../../core/presets/build.ts";
import type { Preset, PresetCategory } from "../../core/presets/build.ts";
import { PRESETS, presetByName } from "../../core/presets/index.ts";
import {
  CATEGORY_GIST,
  knobNames,
  presetScore,
  presetsIn,
  similarPresets,
  type PresetListKind,
} from "../commands/preset.ts";
import type { PickerItem, PickerState } from "../../tui/app.ts";

export const BROWSER_PICKERS = Object.freeze(["presets", "preset"]);

/** The footer of each browser picker. */
export const PRESET_HINTS = Object.freeze({
  categories: " ↑↓ move · enter open · type to search · esc close · ? keys ",
  presets:
    " ↑↓ hear · enter keep · type search · * star · → similar · ← back · space loop · esc revert ",
});

export type BrowserOptions = Readonly<{
  favorites: ReadonlySet<string>;
  /** The preset the focused track plays, if any. */
  current?: Preset | undefined;
  /** Whether the focused track is a drum track (kits come first there). */
  drums?: boolean;
  /** ASCII glyphs (no ★). */
  ascii?: boolean;
}>;

type PickerSpec = Omit<PickerState, "index"> & { index?: number };

const star = (ascii: boolean | undefined) => (ascii ? "*" : "★");

/** A preset row: `★ warm-pad       Grit · Motion · Space · Bloom`. */
export function presetItem(
  preset: Preset,
  options: BrowserOptions,
): PickerItem {
  const fav = options.favorites.has(preset.name);
  const knobs = preset.kind === "kit" ? `kit ${preset.kit}` : knobNames(preset);
  return {
    label: `${fav ? `${star(options.ascii)} ` : "  "}${preset.name.padEnd(16)} ${knobs}`,
    value: `preset ${preset.name}`,
    detail: preset.desc,
    current: options.current?.name === preset.name,
    note: presetNote(preset),
  };
}

/** The line under the rows: the feature it shows, and where to open it. */
export function presetNote(preset: Preset): string {
  const open =
    preset.kind === "kit"
      ? "/kit"
      : preset.kind === "effect"
        ? `/patch --fx ${preset.name}`
        : "/patch";
  return `${preset.feature} · ${open}`;
}

function categoryItem(category: PresetCategory): PickerItem {
  const count = presetsIn(category).length;
  return {
    label: `${category.padEnd(8)} ${String(count).padStart(3)}`,
    value: `/presets ${category}`,
    detail: CATEGORY_GIST[category],
    note: `${CATEGORY_GIST[category]} · enter opens · type to search all`,
  };
}

/** Fuzzy rank for a browser row: presets by name, tags and knobs. */
export function browserRank(query: string, item: PickerItem): number {
  if (item.value.startsWith("preset ")) {
    const preset = presetByName(item.value.slice(7));
    return preset ? presetScore(preset, query) : 0;
  }
  const text = `${item.label} ${item.detail ?? ""}`.toLowerCase();
  // A category matches its own name strongly, its gist weakly.
  const name = item.value.replace(/^\/presets\s+/, "");
  if (name.startsWith(query.trim())) return 90;
  return query
    .trim()
    .split(/\s+/)
    .every((word) => text.includes(word))
    ? 5
    : 0;
}

/** The first picker: favorites, similar, then every category. */
export function categoryPicker(options: BrowserOptions): PickerSpec {
  const special: PickerItem[] = [];
  if (options.current)
    special.push({
      label: `similar  to ${options.current.name}`,
      value: "/presets similar",
      detail: "presets that sound alike",
      note: `${options.current.name} plays now · → or enter lists its neighbors`,
    });
  const favs = PRESETS.filter((p) => options.favorites.has(p.name)).length;
  special.push({
    label: `${star(options.ascii)} starred ${String(favs).padStart(3)}`,
    value: "/presets favorites",
    detail: favs ? "your favorites" : "none yet · * stars a preset",
    note: "your starred presets · * in a list stars or unstars",
  });
  const order = options.drums
    ? [
        "drums" as const,
        "perc" as const,
        "chain" as const,
        ...PRESET_CATEGORIES.filter(
          (c) => c !== "drums" && c !== "perc" && c !== "chain",
        ),
      ]
    : PRESET_CATEGORIES;
  const base = [...special, ...order.map(categoryItem)];
  return {
    id: "presets",
    title: `presets · ${PRESETS.length}`,
    hint: PRESET_HINTS.categories,
    items: base,
    base,
    all: [...base, ...PRESETS.map((p) => presetItem(p, options))],
    rank: browserRank,
    filterable: true,
    typeToFilter: true,
    keys: ["right"],
    audition: true,
    index: options.current ? 0 : special.length,
  };
}

/** The presets one browser list shows. */
export function presetList(
  kind: PresetListKind,
  options: BrowserOptions,
): Preset[] {
  if (kind === "favorites")
    return PRESETS.filter((p) => options.favorites.has(p.name));
  if (kind === "similar")
    return options.current
      ? [options.current, ...similarPresets(options.current, 12)]
      : [];
  if (kind === "all") return [...PRESETS];
  return presetsIn(kind);
}

/** The second picker: one list of presets, auditioned as you move. */
export function presetPicker(
  kind: PresetListKind,
  options: BrowserOptions,
): PickerSpec | undefined {
  const list = presetList(kind, options);
  if (list.length === 0) return undefined;
  const items = list.map((p) => presetItem(p, options));
  const title =
    kind === "similar" && options.current
      ? `presets › like ${options.current.name}`
      : kind === "favorites"
        ? "presets › starred"
        : `presets › ${kind}`;
  const at = items.findIndex((item) => item.current);
  return {
    id: "preset",
    title,
    hint: PRESET_HINTS.presets,
    items,
    base: items,
    all: PRESETS.map((p) => presetItem(p, options)),
    rank: browserRank,
    filterable: true,
    typeToFilter: true,
    keys: ["*", "right", "left"],
    audition: true,
    index: Math.max(0, at),
  };
}
