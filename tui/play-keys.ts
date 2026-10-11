/**
 * Play mode's on-screen keyboard: the note keys drawn where they sit on a
 * QWERTY keyboard, each key letter with what it plays printed under it.
 *
 *      W    E         T    Y    U         O    P       z x  oct C3–F4
 *      C#   D#        F#   G#   A#        C#   D#      c v  vel 100
 *   A    S    D    F    G    H    J    K    L    ;    '    m    click on
 *   C3   D    E    F    G    A    B    C4   D    E    F    r    rec off
 *                                                           count-in 1 bar
 *
 * The upper row sits half a key to the right, so each black key falls over
 * the gap between the two white keys it lies between, and the R and I gaps
 * are the piano's missing black keys (E–F, B–C). On a kit or a one-shot
 * sampler the labels name the sound each key plays (`kick`, `snr`, `chh`)
 * and the C keys lose their octave mark; there is no harmony to anchor.
 *
 * Three forms, by terminal size, all showing every mapped key:
 *
 *   full     ≥120 columns: wider keys, plus the bottom row (Z X C V M) as
 *            keys labeled oct- oct+ vel- vel+ click, and the panel.
 *   compact  ≥80 columns: the two note rows with the panel on the right.
 *   minimal  the 60-column minimum: the two note rows, the panel folded
 *            into a line underneath.
 *
 * Pure layout (`playKeysLayout`) and a painter (`paintPlayKeys`), so the
 * layout is testable as text and styles map from roles, never from hue
 * alone: held keys are reversed and marked `S•` (`S*` in ASCII), unmapped
 * keys print `·` (`.`), and root keys carry their octave digit in bold.
 */
import type { PlayStripKey } from "./play-strip.ts";
import type { CellBuffer } from "./screen.ts";
import { displayWidth, truncate } from "./text.ts";
import type { Style, Theme } from "./theme.ts";

export type PlayKeysForm = "full" | "compact" | "minimal";

export type PlayKeysView = Readonly<{
  keys: readonly PlayStripKey[];
  /** Keys name sounds (a kit, a one-shot sampler) rather than notes. */
  sounds?: boolean | undefined;
  /** The keys' range at the current octave: `C3–F4`. */
  octave: string;
  velocity: number;
  click: boolean;
  /** The count-in setting, in bars. */
  countInBars?: number | undefined;
  /** `count-in 3` while counting in. */
  countIn?: string | undefined;
  armed: boolean;
  recording: boolean;
  replace: boolean;
}>;

export type PlayKeysSpanKind =
  | "letter"
  | "label"
  | "panelKey"
  | "panelText"
  | "panelValue"
  | "rec"
  | "countIn";

export type PlayKeysSpan = Readonly<{
  row: number;
  x: number;
  text: string;
  kind: PlayKeysSpanKind;
  /** The note key a letter or label belongs to. */
  key?: PlayStripKey | undefined;
  /** A control cap on the full form's bottom row. */
  control?: boolean | undefined;
}>;

export type PlayKeysLayout = Readonly<{
  form: PlayKeysForm;
  /** Columns per key, gap included. */
  cell: number;
  rows: number;
  spans: readonly PlayKeysSpan[];
}>;

/** Left margin of the keyboard. */
const LEFT = 1;
/** Columns between the keyboard and the panel on its right. */
const PANEL_GAP = 2;
/** The narrowest panel worth putting beside the keys. */
const PANEL_MIN = 18;
/** Columns of the panel's key column: `z x `. */
const PANEL_KEYS = 5;

const HOME = ["a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'"];
/** Each black key and the white key to its left (index into HOME). */
const UPPER: ReadonlyArray<readonly [string, number]> = [
  ["w", 0],
  ["e", 1],
  ["t", 3],
  ["y", 4],
  ["u", 5],
  ["o", 7],
  ["p", 8],
];
/** The full form's bottom row: octave and velocity, then the click. */
const BOTTOM: ReadonlyArray<readonly [string, number, string]> = [
  ["z", 0, "oct-"],
  ["x", 1, "oct+"],
  ["c", 2, "vel-"],
  ["v", 3, "vel+"],
  ["m", 6, "click"],
];

/** The form for a terminal `width` wide with `height` rows to spare. */
export function playKeysForm(width: number, height: number): PlayKeysForm {
  if (width >= 120 && height >= 14) return "full";
  if (width >= 80 && height >= 9) return "compact";
  return "minimal";
}

/**
 * Columns per key: wide enough for the longest label (a chord name like
 * `Bbm7` in auto chords) and the form's floor, never wider than eleven
 * keys in the terminal. Labels longer than that are cut with an ellipsis.
 */
function cellFor(
  form: PlayKeysForm,
  width: number,
  keys: readonly PlayStripKey[],
): number {
  const widest = Math.max(0, ...keys.map((key) => displayWidth(key.label)));
  const fit = Math.floor((width - LEFT - 1) / HOME.length);
  const floor = form === "full" ? 7 : 5;
  return Math.max(3, Math.min(fit, Math.max(floor, widest + 1), 9));
}

type PanelItem = Readonly<{
  keys: string;
  text: string;
  kind: PlayKeysSpanKind;
}>;

function panelItems(view: PlayKeysView, unicode: boolean): PanelItem[] {
  const ascii = (text: string) => (unicode ? text : text.replace(/–/g, "-"));
  const rec = view.armed
    ? `${unicode ? "●" : "*"} ${view.recording ? "REC" : "rec armed"}${view.replace ? " replace" : ""}`
    : `rec off${view.replace ? " · replace" : ""}`;
  const bars = view.countInBars ?? 1;
  const items: PanelItem[] = [
    { keys: "z x", text: `oct ${ascii(view.octave)}`, kind: "panelValue" },
    { keys: "c v", text: `vel ${view.velocity}`, kind: "panelValue" },
    {
      keys: "m",
      text: `click ${view.click ? "on" : "off"}`,
      kind: "panelText",
    },
    { keys: "r", text: rec, kind: "rec" },
    {
      keys: "",
      text:
        view.countIn ??
        (bars === 0
          ? "no count-in"
          : `count-in ${bars} bar${bars === 1 ? "" : "s"}`),
      kind: "countIn",
    },
  ];
  return unicode
    ? items
    : items.map((item) => ({ ...item, text: item.text.replace(/·/g, "-") }));
}

/** Lay the keys out for `width` columns and up to `height` rows. */
export function playKeysLayout(
  view: PlayKeysView,
  width: number,
  height: number,
  unicode = true,
): PlayKeysLayout {
  const form = playKeysForm(width, height);
  const cell = cellFor(form, width, view.keys);
  const room = cell - 1;
  const ellipsis = unicode ? "…" : "~";
  const spans: PlayKeysSpan[] = [];
  const byKey = new Map(view.keys.map((key) => [key.key, key]));
  const upper = UPPER.filter(([key]) => byKey.has(key));
  const half = Math.ceil(cell / 2);
  const capRow = (
    row: number,
    entries: ReadonlyArray<readonly [PlayStripKey, number]>,
  ) => {
    for (const [key, x] of entries) {
      // A held key carries a mark as well as reverse video, so it reads
      // where attributes are off (TERM=dumb) and in any color depth.
      const letter = key.key.toUpperCase();
      spans.push({
        row,
        x,
        text: key.lit ? `${letter}${unicode ? "•" : "*"}` : letter,
        kind: "letter",
        key,
      });
      spans.push({
        row: row + 1,
        x,
        text: truncate(
          key.unmapped && !unicode ? key.label.replace(/·/g, ".") : key.label,
          room,
          ellipsis,
        ),
        kind: "label",
        key,
      });
    }
  };
  let row = 0;
  if (upper.length > 0) {
    capRow(
      row,
      upper.map(([key, left]) => [
        byKey.get(key)!,
        LEFT + (left + 1) * cell - half + 1,
      ]),
    );
    row += 2;
  }
  // Keys outside the physical rows (none today) still print, in order.
  const home = [
    ...HOME.filter((key) => byKey.has(key)),
    ...view.keys
      .map((key) => key.key)
      .filter((key) => !HOME.includes(key) && !UPPER.some(([k]) => k === key)),
  ];
  capRow(
    row,
    home.map((key, index) => [byKey.get(key)!, LEFT + index * cell]),
  );
  row += 2;
  if (form === "full") {
    for (const [key, index, label] of BOTTOM) {
      const x = LEFT + Math.floor(cell / 2) + index * cell;
      spans.push({
        row,
        x,
        text: key.toUpperCase(),
        kind: "letter",
        control: true,
      });
      spans.push({
        row: row + 1,
        x,
        text: label,
        kind: "label",
        control: true,
      });
    }
    row += 2;
  }
  const keysWidth = LEFT + HOME.length * cell;
  const items = panelItems(view, unicode);
  const panelX = keysWidth + PANEL_GAP;
  const panelRoom = width - 1 - panelX;
  if (panelRoom >= PANEL_MIN) {
    // Beside the keys, one control a line.
    items.forEach((item, index) => {
      if (item.keys)
        spans.push({
          row: index,
          x: panelX,
          text: item.keys,
          kind: "panelKey",
        });
      spans.push({
        row: index,
        x: panelX + PANEL_KEYS,
        text: truncate(item.text, panelRoom - PANEL_KEYS, ellipsis),
        kind: item.kind,
      });
    });
    row = Math.max(row, items.length);
  } else {
    // Underneath, packed into as few lines as the width allows.
    let x = LEFT;
    let line = row;
    const right = width - 1;
    for (const item of items) {
      const need =
        (item.keys ? displayWidth(item.keys) + 1 : 0) + displayWidth(item.text);
      if (x > LEFT && x + need > right) {
        line += 1;
        x = LEFT;
      }
      if (item.keys) {
        spans.push({ row: line, x, text: item.keys, kind: "panelKey" });
        x += displayWidth(item.keys) + 1;
      }
      const text = truncate(item.text, Math.max(1, right - x), ellipsis);
      spans.push({ row: line, x, text, kind: item.kind });
      x += displayWidth(text) + 2;
    }
    row = line + 1;
  }
  return { form, cell, rows: row, spans };
}

/** Rows the keyboard takes, for the frame's layout. */
export function playKeysRows(
  view: PlayKeysView,
  width: number,
  height: number,
  unicode = true,
): number {
  return playKeysLayout(view, width, height, unicode).rows;
}

function keyStyle(
  key: PlayStripKey,
  kind: "letter" | "label",
  theme: Theme,
): Style {
  const roles = theme.roles;
  if (key.lit)
    return {
      ...(key.black ? roles.selected : roles.hit),
      reverse: true,
      bold: true,
    };
  if (key.unmapped) return roles.faint;
  if (kind === "letter") return { ...roles.text, bold: true };
  if (key.chord)
    return { ...(key.diatonic ? roles.hit : roles.text), bold: true };
  if (key.root) return { ...roles.success, bold: true };
  return key.black ? roles.muted : roles.text;
}

/**
 * Paint the keyboard at row `y`, at most `height` rows; returns the rows
 * used. Lit keys fill their cap's width on both rows, so a held key reads
 * as one solid key in any color depth.
 */
export function paintPlayKeys(
  buffer: CellBuffer,
  y: number,
  width: number,
  height: number,
  view: PlayKeysView,
  theme: Theme,
  unicode: boolean,
): number {
  const layout = playKeysLayout(view, width, height, unicode);
  const rows = Math.min(height, layout.rows);
  const roles = theme.roles;
  buffer.fill(0, y, width, rows, roles.canvas);
  const room = layout.cell - 1;
  for (const span of layout.spans) {
    if (span.row >= rows) continue;
    const at = y + span.row;
    if (span.key && (span.kind === "letter" || span.kind === "label")) {
      const style = keyStyle(span.key, span.kind, theme);
      const text = span.key.lit
        ? span.text + " ".repeat(Math.max(0, room - displayWidth(span.text)))
        : span.text;
      buffer.text(span.x, at, text, style);
      continue;
    }
    const style: Style = span.control
      ? span.kind === "letter"
        ? { ...roles.text, bold: true }
        : roles.muted
      : span.kind === "panelKey"
        ? { ...roles.text, bold: true }
        : span.kind === "panelValue"
          ? { ...roles.text, bold: true }
          : span.kind === "rec"
            ? view.recording
              ? roles.error
              : view.armed
                ? roles.warning
                : roles.muted
            : span.kind === "countIn"
              ? view.countIn
                ? roles.warning
                : roles.muted
              : view.click
                ? roles.success
                : roles.muted;
    buffer.text(span.x, at, span.text, style);
  }
  return rows;
}
