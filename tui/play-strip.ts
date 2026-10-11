/**
 * Play mode's two fixed rows: the header (`PLAY MODE  ▶ 120 BPM · lead ·
 * rev 3  C3–F4  vel 100  ● REC
 * click ✓` plus a beat flash) and a one-line keyboard strip with the keys
 * that are sounding lit. Both repaint in place every frame, so playing never
 * scrolls the transcript.
 */
import type { CellBuffer } from "./screen.ts";
import { displayWidth, truncate } from "./text.ts";
import { onBackground, type Style, type Theme } from "./theme.ts";

export type PlayStripKey = Readonly<{
  key: string;
  label: string;
  black: boolean;
  lit: boolean;
  /** Chord mode: the label names the chord this key plays. */
  chord?: boolean | undefined;
  /** That chord is built on a degree of the song's key. */
  diatonic?: boolean | undefined;
  /** A C, or the tonic in scale degrees: its label keeps the octave. */
  root?: boolean | undefined;
  /** Plays nothing (past a sampler's last slot, off the MIDI range). */
  unmapped?: boolean | undefined;
}>;

export type PlayHeaderView = Readonly<{
  /**
   * The song header compressed to the left of the row while play mode
   * covers it: `▶ 120 BPM · drums · rev 1`.
   */
  context?: string | undefined;
  /** `C3–F4`. */
  range: string;
  velocity: number;
  /** Record armed. */
  armed: boolean;
  /** Recording right now (armed and the transport is running). */
  recording: boolean;
  replace: boolean;
  /** Loop recording: `↻ 5–6 · pass 3`. */
  pass?: string | undefined;
  click: boolean;
  sustain: boolean;
  /** `count-in 3` while counting in. */
  countIn?: string | undefined;
  /** Beat within the bar (1-based) and whether it is the flash window. */
  beat?: Readonly<{ index: number; of: number; flash: boolean }> | undefined;
  /** `grid 1/16`. */
  grid: string;
  /** Chord mode: `AUTO C major · Dm (ii) → G · arp-up`, empty when off. */
  chords?: string | undefined;
  /** Short status (`octave C2`, `no audio`). */
  status?: string | undefined;
  keys: readonly PlayStripKey[];
  /** Keys name sounds (a kit, a one-shot sampler) rather than notes. */
  sounds?: boolean | undefined;
  /** The keys' range at the current octave, kits included: `C2–F3`. */
  octave?: string | undefined;
  /** The count-in setting, in bars. */
  countInBars?: number | undefined;
  /** Chord mode's number-row legend; latched entries are `on`. */
  legend?: readonly ChordLegendCell[] | undefined;
}>;

/** One chord-mode key on the legend row: `1 dim`, `9 strum-up`. */
export type ChordLegendCell = Readonly<{
  key: string;
  label: string;
  on: boolean;
}>;

/** Text of the header row, for tests and narrow terminals. */
export function playHeaderText(view: PlayHeaderView, unicode = true): string {
  const parts = [
    "PLAY MODE",
    view.context ?? "",
    view.range,
    view.armed
      ? `${unicode ? "●" : "*"} ${view.recording ? "REC" : "rec armed"}${view.replace ? " replace" : ""}`
      : "",
    view.pass
      ? unicode
        ? view.pass
        : view.pass.replace("↻", "@").replace("–", "-")
      : "",
    view.click ? "click" : "",
    view.sustain ? "SUSTAIN" : "",
    view.chords ?? "",
    view.countIn ?? "",
    view.status ?? "",
  ].filter(Boolean);
  return parts.join("  ");
}

export function paintPlayHeader(
  buffer: CellBuffer,
  y: number,
  width: number,
  view: PlayHeaderView,
  theme: Theme,
  unicode: boolean,
): void {
  const roles = theme.roles;
  const panel = roles.panel;
  buffer.fill(0, y, width, 1, panel);
  let x = 1;
  const put = (text: string, style = roles.text) => {
    if (x >= width - 1) return;
    x += buffer.text(
      x,
      y,
      truncate(text, Math.max(1, width - x - 1)),
      onBackground(style, panel),
    );
    x += buffer.text(x, y, "  ", panel);
  };
  put(" PLAY MODE ", roles.pillSteer);
  const context = fitContext(view, width, unicode);
  if (context) put(context, roles.muted);
  // A kit names its range by the track already in the context.
  if (!context.includes(" · ") || view.range !== "drums")
    put(view.range, { ...roles.text, bold: true });
  if (view.armed)
    put(
      `${unicode ? "●" : "*"} ${view.recording ? "REC" : "rec armed"}${view.replace ? " replace" : ""}`,
      view.recording ? roles.error : roles.warning,
    );
  if (view.pass)
    put(
      unicode ? view.pass : view.pass.replace("↻", "@").replace("–", "-"),
      roles.knob2,
    );
  // Velocity, grid and click details live in the `?` panel.
  if (view.click) put("click", roles.success);
  if (view.sustain) put("SUSTAIN", roles.pillQueue);
  if (view.chords) put(view.chords, roles.hit);
  if (view.countIn) put(view.countIn, roles.warning);
  const hintWidth = displayWidth("? keys · esc leave");
  if (view.beat && x + view.beat.of + 2 <= width - 1 - hintWidth) {
    const cells = Array.from({ length: view.beat.of }, (_, index) =>
      index + 1 === view.beat!.index
        ? unicode
          ? "●"
          : "o"
        : unicode
          ? "·"
          : ".",
    ).join("");
    put(
      cells,
      view.beat.flash
        ? view.beat.index === 1
          ? roles.error
          : roles.hit
        : roles.muted,
    );
  }
  // The way out and the way to learn more, always at the right edge.
  const hint = "? keys · esc leave";
  const right = width - 1 - displayWidth(hint);
  // Status shows whole or by its first clause, never cut mid-word.
  if (view.status) {
    const room = right - 2 - x;
    const first = view.status.split(" · ")[0]!;
    const text =
      displayWidth(view.status) <= room
        ? view.status
        : displayWidth(first) <= room
          ? first
          : "";
    if (text) x += buffer.text(x, y, text, onBackground(roles.muted, panel));
  }
  if (right > x) buffer.text(right, y, hint, onBackground(roles.faint, panel));
}

/**
 * The compressed song header (`▶ 120 BPM · bass · rev 1`). It is reserved
 * first: the beat dots and the status give way before it does, and only a
 * terminal too narrow for it with the badge and the way out shortens it to
 * its first clause.
 */
function fitContext(
  view: PlayHeaderView,
  width: number,
  unicode: boolean,
): string {
  if (!view.context) return "";
  const rest = displayWidth(
    playHeaderText(
      { ...view, context: undefined, status: undefined, beat: undefined },
      unicode,
    ),
  );
  // Badge padding, the right-hand hint and the gaps between parts.
  const room = width - 2 - displayWidth("? keys · esc leave") - 4 - rest;
  for (const candidate of [view.context, view.context.split(" · ")[0]!])
    if (displayWidth(candidate) + 2 <= room) return candidate;
  return "";
}

/** Chord mode's number row: `1 dim  2 min … 9 block  b bass off  n next`. */
export function paintChordLegend(
  buffer: CellBuffer,
  y: number,
  width: number,
  cells: readonly ChordLegendCell[],
  theme: Theme,
): void {
  const roles = theme.roles;
  buffer.fill(0, y, width, 1, roles.canvas);
  let x = 1;
  for (const cell of cells) {
    const keyWidth = displayWidth(cell.key);
    const cellWidth = keyWidth + 1 + displayWidth(cell.label) + 2;
    if (x + cellWidth > width) break;
    buffer.text(x, y, cell.key, { ...roles.text, bold: true });
    buffer.text(
      x + keyWidth + 1,
      y,
      cell.label,
      cell.on ? { ...roles.hit, reverse: true } : roles.muted,
    );
    x += cellWidth;
  }
}

/**
 * `A C3  W C#3 …`: each key with what it plays. The key letter is muted so
 * the music reads first; a chord label is bold, and chords in the song's
 * key are lit (they always fit). Sounding keys are reversed.
 */
export function paintPlayStrip(
  buffer: CellBuffer,
  y: number,
  width: number,
  keys: readonly PlayStripKey[],
  theme: Theme,
): void {
  const roles = theme.roles;
  buffer.fill(0, y, width, 1, roles.canvas);
  let x = 1;
  for (const key of keys) {
    const letter = key.key.toUpperCase();
    const cellWidth = displayWidth(letter) + 1 + displayWidth(key.label) + 1;
    if (x + cellWidth > width - 1) break;
    const labelStyle: Style = key.lit
      ? { ...(key.black ? roles.selected : roles.hit), reverse: true }
      : key.chord
        ? { ...(key.diatonic ? roles.hit : roles.text), bold: true }
        : key.black
          ? roles.muted
          : roles.text;
    const letterStyle: Style = key.lit
      ? labelStyle
      : key.black
        ? roles.faint
        : roles.muted;
    x += buffer.text(x, y, letter, letterStyle);
    x += buffer.text(x, y, " ", key.lit ? labelStyle : roles.canvas);
    x += buffer.text(x, y, key.label, labelStyle);
    x += 1;
  }
}
