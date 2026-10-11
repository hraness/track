/**
 * Frame composition and UI state for the interactive dawg TUI.
 *
 *   ┌ header: dawg · track · session · ▶ BPM · model · rev · sync ┐
 *   │ highway (notes fall toward the hit line)              │
 *   │ activity strip: spinner, operation cards, queue depth │
 *   └ prompt panel: bg fill, mode pill, wrapped draft       ┘
 *
 * `composeFrame` is pure (view + UI state + size + time → cell buffer), so
 * tests snapshot exact frames.  `TuiApp` owns the mutable UI state (prompt,
 * activity feed, theme, motion, overlay) and writes differential frames to an
 * injectable `TerminalIO`.
 */

import { paintTape, type TapeView } from "./tape.ts";
import { paintPatch, type PatchPaint } from "./patch.ts";
import {
  ActivityFeed,
  ERROR_FADE_MS,
  fail,
  revisionLabel,
  spinnerFrame,
  type ActivityCard,
  type Receipt,
  type TranscriptEntry,
} from "./activity.ts";
import {
  paintHighway,
  projectionFor,
  resolveBeat,
  type TrackScoreSnapshot,
} from "./highway.ts";
import { placeholderHint } from "./hints.ts";
import {
  Delight,
  downbeatGlint,
  FIRST_LOOP_CARD,
  sweepProgress,
} from "./delight.ts";
import { asciiHint, fitHint, HINTS } from "./grammar.ts";
import { GuideBrowser } from "./guide.ts";
import {
  CODE_ROLE,
  listGuides,
  RULE_MARK,
  SECTION_MARKS,
  type DocMark,
} from "../guides/index.ts";
import { topicMiss } from "../src/lang/glossary.ts";
import { classifyKey, overlayKey, type UiCommand } from "./keys.ts";
import { PromptModel, type PromptAction, type PromptMode } from "./prompt.ts";
import {
  paintChordLegend,
  paintPlayHeader,
  paintPlayStrip,
  type PlayHeaderView,
} from "./play-strip.ts";
import { paintPlayKeys, playKeysRows } from "./play-keys.ts";
import { paintArrangeStrip, type ArrangeStripView } from "./arrange-strip.ts";
import { CellBuffer, ScreenWriter, type CursorPosition } from "./screen.ts";
import { paintDrawer, type DrawerLayout, type DrawerView } from "./drawer.ts";
import { HitMap, type HitTarget } from "./hits.ts";
import { displayWidth, truncate } from "./text.ts";
import { paintCrumbs, type Crumbs } from "./crumbs.ts";
import {
  accentStyle,
  detectTerminalCapabilities,
  effectiveTheme,
  onBackground,
  parseThemeName,
  shade,
  THEME_NAMES,
  type Style,
  type TerminalCapabilities,
  type Theme,
  type ThemeName,
} from "./theme.ts";

export type SyncState = "synced" | "syncing" | "conflict" | "offline" | "local";

export interface AppView {
  score: TrackScoreSnapshot;
  /** Transport beat; when omitted it is derived from the snapshot. */
  beat?: number | undefined;
  model?: string | undefined;
  sync?: SyncState | undefined;
  /** Human session name; replaces the short id in the header when set. */
  sessionName?: string | undefined;
  /** Live panes on this session (presence); shown when more than one. */
  windows?: number | undefined;
  /** This pane's letter (dawgd), shown beside the count: `B ⧉3` (`B 3 panes` in ASCII). */
  pane?: string | undefined;
  /** Project typecheck result; `types ✓` or `types ✗ N` beside sync. */
  types?: TypesIndicator | undefined;
  /**
   * The line under the prompt: `$0.12 session · $0.48 today · opus-5.5 ·
   * gateway`, or `commands only`. The caller sizes it to the width.
   */
  spend?: string | undefined;
  /** No agent provider: the placeholder teaches commands, no NOW pill. */
  agentOffline?: boolean | undefined;
  /**
   * Show-me: the command the agent is writing, as it streams (ghost text in
   * an empty prompt bar), and the caption naming the human gesture.
   */
  showMe?:
    { ghost?: string | undefined; caption?: string | undefined } | undefined;
  /** Play mode: replaces the header and adds the keyboard strip row. */
  play?: PlayHeaderView | undefined;
  /** TAPE (op1-ux §6): replaces the highway and the arrange strip. */
  tape?: TapeView | undefined;
  /** The patch view (patcher §7): replaces the highway and the arrange strip. */
  patch?: PatchPaint | undefined;
  /** Song master meter: integrated LUFS and true peak of the playing loop. */
  loudness?: LoudnessView | undefined;
  /** Song sections over the timeline (0.5); no row when absent. */
  arrange?: ArrangeStripView | undefined;
}

export type LoudnessView = Readonly<{
  /** Integrated loudness, LUFS. */
  integrated: number;
  /** True peak, dBTP. */
  truePeak: number;
  /** The master's loudness target, when one is set. */
  target?: number | undefined;
  /** The limiter's ceiling, dBTP, when the limiter is on. */
  ceiling?: number | undefined;
  /** A monitor-rate reading shown until the export-rate one is in (`~`). */
  estimate?: boolean | undefined;
}>;

/**
 * `-14.1 LUFS (-14) · TP -1.0`: the compact loudness meter, with the
 * master's target in brackets when one is set and `~` before a monitor-rate
 * estimate. Loudness below -70 LUFS (silence) reads `-∞`.
 */
export function loudnessMeter(view: LoudnessView): string {
  const lufs = view.integrated <= -70 ? "-∞" : view.integrated.toFixed(1);
  const peak = view.truePeak <= -119 ? "-∞" : view.truePeak.toFixed(1);
  const target = view.target === undefined ? "" : ` (${view.target})`;
  return `${view.estimate ? "~" : ""}${lufs} LUFS${target} · TP ${peak}`;
}

/** Whether the meter's reading is off target by more than 0.5 LU. */
export function loudnessOffTarget(view: LoudnessView): boolean {
  return (
    view.target !== undefined &&
    view.integrated > -70 &&
    Math.abs(view.integrated - view.target) > 0.5
  );
}

export type TypesIndicator = Readonly<{ ok: boolean; errors: number }>;

export interface UiState {
  prompt: PromptModel;
  activity: ActivityFeed;
  theme: Theme;
  capabilities: TerminalCapabilities;
  reducedMotion: boolean;
  overlay: Overlay;
  /** Transcript scroll (entries up from the newest) and filter. */
  log?: LogView | undefined;
  picker?: PickerState | undefined;
  text?: TextView | undefined;
  /** The `?` panel: keys for the screen underneath, drawn over it. */
  keys?: TextView | undefined;
  /** The `/guide` tree and pages. */
  guide?: GuideBrowser | undefined;
  /** The fader drawer, docked over the bottom of the piano roll. */
  drawer?: DrawerView | undefined;
  /** Downbeat glint, first-loop sweep and ghost-note lanes (delight.ts). */
  delight?: Delight | undefined;
}

/**
 * `log` is the transcript, `picker` an arrow-key list, `text` static lines,
 * `guide` the user guides.
 */
export type Overlay = "log" | "picker" | "text" | "guide" | undefined;

/** A scrollable read-only panel (`/help`, `/sessions`, `/tracks`). */
export interface TextView {
  title: string;
  lines: readonly string[];
  /**
   * Each `── heading` line's mark (guides/marks.ts), drawn in place of the
   * rule: `/help` marks its groups by kind (`› sound`, `✦ agent`), the `?`
   * panel marks every list `⌃`. Undefined (or missing) keeps the rule.
   */
  marks?: readonly (DocMark | undefined)[] | undefined;
  /** Rows scrolled down from the top. */
  scroll: number;
}

export type LogFilter = "all" | "requests" | "ops" | "errors";
export const LOG_FILTERS: readonly LogFilter[] = [
  "all",
  "requests",
  "ops",
  "errors",
];

export interface LogView {
  scroll: number;
  filter: LogFilter;
}

/** An arrow-key list overlay (`/resume`, `/login --xcb`). */
export interface PickerState {
  /** Caller tag returned with the choice. */
  id: string;
  title: string;
  items: readonly PickerItem[];
  index: number;
  /** Type-to-filter on label and detail (`/model`). */
  filterable?: boolean | undefined;
  /** Current filter text; `items` is then the matching subset of `all`. */
  query?: string | undefined;
  /** `/` was pressed: printable keys type into the filter. */
  filtering?: boolean | undefined;
  all?: readonly PickerItem[] | undefined;
  /** Footer keys, replacing the default move/choose/cancel hint. */
  hint?: string | undefined;
  /** A dim line under the rows: what the focused row does. */
  note?: string | undefined;
  /**
   * The Ctrl-K menu's breadcrumb (tui/crumbs.ts), drawn in place of
   * `title` with the menu mark and folded to fit.
   */
  crumbs?: Crumbs | undefined;
  /**
   * Hosts the audition loop (src/tui/audition.ts): Space, `a` and `c` are
   * returned as `pick-audition` instead of being swallowed.
   */
  audition?: boolean | undefined;
}

export interface PickerItem {
  label: string;
  /** Opaque value returned on Enter. */
  value: string;
  detail?: string | undefined;
  /** Marked with ● (the current model). */
  current?: boolean | undefined;
}

/** Most picker rows kept; longer lists are truncated by the caller's order. */
export const MAX_PICKER_ITEMS = 64;

export function logEntriesFor(
  entries: readonly TranscriptEntry[],
  filter: LogFilter,
): readonly TranscriptEntry[] {
  if (filter === "all") return entries;
  return entries.filter((entry) =>
    filter === "requests"
      ? entry.kind === "request"
      : filter === "errors"
        ? entry.kind === "error"
        : entry.kind === "op" ||
          entry.kind === "revision" ||
          entry.kind === "agent",
  );
}

export interface FrameSize {
  width: number;
  height: number;
}

export interface Frame {
  buffer: CellBuffer;
  cursor: CursorPosition | undefined;
  /** Rows used by the prompt editor (excluding borders). */
  promptRows: number;
  layout: FrameLayout;
  /** Click targets, recorded while painting (topmost last). */
  hits: HitMap;
  /** Where the fader drawer landed, when one is open. */
  drawer?: DrawerLayout | undefined;
}

export interface FrameLayout {
  header: number;
  highway: { y: number; height: number };
  activity: number;
  prompt: { y: number; height: number };
  /** Editor rows inside the prompt panel. */
  promptRows: number;
  /** Whether the prompt panel has a bottom border with key hints. */
  footer: boolean;
  tooSmall: boolean;
}

/**
 * The smallest terminal the real UI draws in (DAWG.md "Terminal
 * sizes"). Measured with `bun run sizes`: below 60 columns the play-mode
 * key strip and the header's bar position drop out and the prompt's spend
 * line clips; below 16 rows the prompt loses its footer and the drawer its
 * last knob. 80x24 stays the design target.
 */
export const MIN_WIDTH = 60;
export const MIN_HEIGHT = 16;

/** True when a terminal of this size shows the too-small screen instead. */
export function isTooSmall(size: FrameSize): boolean {
  return !(size.width >= MIN_WIDTH && size.height >= MIN_HEIGHT);
}
/**
 * The longest line a text panel (help, guides, the transcript, menus) sets:
 * past about 100 columns prose stops being readable and a command table's
 * two columns drift apart, so on a wide terminal the panel holds this
 * measure, left-aligned, and the song keeps drawing beside it (see
 * `SIDE_MIN_WIDTH`).
 */
export const TEXT_MEASURE = 100;
/** The fewest columns beside a capped panel worth drawing the view into. */
export const SIDE_MIN_WIDTH = 36;

/** Where a text panel sits in a terminal `width` columns wide. */
export function panelRect(
  width: number,
  measure = TEXT_MEASURE,
): { left: number; boxWidth: number } {
  const left = width >= 60 ? 2 : 0;
  return { left, boxWidth: Math.min(width - left * 2, measure + 4) };
}

export const MAX_PROMPT_ROWS = 8;
/** New cards glow for this long before settling. */
export const CARD_GLOW_MS = 700;

/** Prompt rows allowed for a viewport: 1..8, capped at 30% of its height. */
export function promptRowCap(height: number): number {
  return Math.max(1, Math.min(MAX_PROMPT_ROWS, Math.floor(height * 0.3)));
}

/** Width available to the prompt editor inside the panel. */
export function promptEditorWidth(width: number): number {
  // "│ › " + text + cursor cell + " │"
  return Math.max(4, width - 7);
}

interface Box {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}
const UNICODE_BOX: Box = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
};
const ASCII_BOX: Box = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };

export function computeLayout(
  size: FrameSize,
  promptWrappedRows: number,
): FrameLayout {
  const tooSmall = isTooSmall(size);
  const rows = Math.max(
    1,
    Math.min(promptWrappedRows, promptRowCap(size.height)),
  );
  const footer = size.height >= 16 ? 1 : 0;
  const promptHeight = 1 + rows + footer;
  const promptY = size.height - promptHeight;
  const activity = promptY - 1;
  const highwayY = 1;
  return {
    header: 0,
    highway: { y: highwayY, height: Math.max(0, activity - highwayY) },
    activity,
    prompt: { y: promptY, height: promptHeight },
    promptRows: rows,
    footer: footer === 1,
    tooSmall,
  };
}

// ---------------------------------------------------------------------------
// Header

interface Segment {
  text: string;
  style: Style;
  /** Lower numbers survive longer when space is short. */
  priority: number;
  /** What a click on it does. */
  target?: HitTarget | undefined;
}

function paintSegments(
  buffer: CellBuffer,
  y: number,
  segments: Segment[],
  width: number,
  separator: string,
  separatorStyle: Style,
  background: Style,
  rightSegments: Segment[] = [],
  hits?: HitMap,
): void {
  const sepWidth = displayWidth(separator);
  const total = (list: Segment[]) =>
    list.reduce((sum, segment) => sum + displayWidth(segment.text), 0) +
    Math.max(0, list.length - 1) * sepWidth;
  let left = [...segments];
  let right = [...rightSegments];
  const fits = () =>
    total(left) + (right.length ? total(right) + 2 : 0) + 2 <= width;
  while (!fits()) {
    const all = [...left, ...right];
    if (all.length <= 1) break;
    const worst = all.reduce((a, b) => (b.priority > a.priority ? b : a));
    left = left.filter((segment) => segment !== worst);
    right = right.filter((segment) => segment !== worst);
  }
  buffer.fill(0, y, width, 1, background);
  let x = 1;
  left.forEach((segment, index) => {
    if (index > 0)
      x += buffer.text(
        x,
        y,
        separator,
        onBackground(separatorStyle, background),
      );
    const used = buffer.text(
      x,
      y,
      truncate(segment.text, Math.max(1, width - x - 1)),
      onBackground(segment.style, background),
    );
    if (segment.target) hits?.add(x, y, used, 1, segment.target);
    x += used;
  });
  if (right.length) {
    let rx = width - 1 - total(right);
    if (rx <= x) return;
    right.forEach((segment, index) => {
      if (index > 0)
        rx += buffer.text(
          rx,
          y,
          separator,
          onBackground(separatorStyle, background),
        );
      const used = buffer.text(
        rx,
        y,
        segment.text,
        onBackground(segment.style, background),
      );
      if (segment.target) hits?.add(rx, y, used, 1, segment.target);
      rx += used;
    });
  }
}

function syncSegment(
  sync: SyncState | undefined,
  theme: Theme,
  unicode: boolean,
): Segment | undefined {
  if (!sync) return undefined;
  const glyph: Record<SyncState, string> = unicode
    ? {
        synced: "●",
        syncing: "◌",
        conflict: "▲",
        offline: "✗",
        local: "○",
      }
    : { synced: "*", syncing: "o", conflict: "!", offline: "x", local: "o" };
  const style: Record<SyncState, Style> = {
    synced: theme.roles.success,
    syncing: theme.roles.muted,
    conflict: theme.roles.warning,
    offline: theme.roles.error,
    local: theme.roles.muted,
  };
  return { text: `${glyph[sync]} ${sync}`, style: style[sync], priority: 4 };
}

/**
 * The song header compressed for play mode's row: transport, tempo, the
 * track and the revision (`▶ 120 BPM · drums · rev 1`).
 */
export function playContext(
  score: TrackScoreSnapshot,
  unicode: boolean,
): string {
  const playing = score.playing === true;
  const glyph = playing ? (unicode ? "▶" : ">") : unicode ? "⏸" : "||";
  const name = score.trackName ?? score.trackId ?? "track";
  return [
    `${glyph} ${score.bpm ?? 120} BPM`,
    name,
    ...(score.revision !== undefined ? [`rev ${score.revision}`] : []),
  ].join(" · ");
}

/** `5.3`: the 1-based bar and beat of a song beat. */
export function barBeatLabel(
  beat: number,
  beatsPerBar: number,
  barBeats?: readonly number[],
): string {
  const at = Number.isFinite(beat) ? Math.max(0, beat) : 0;
  if (barBeats && barBeats.length > 0) {
    let bar = 0;
    while (bar + 1 < barBeats.length && barBeats[bar + 1]! <= at + 1e-9)
      bar += 1;
    return `${bar + 1}.${Math.floor(at - barBeats[bar]! + 1e-9) + 1}`;
  }
  const per = Math.max(1, beatsPerBar);
  const bar = Math.floor(at / per + 1e-9);
  return `${bar + 1}.${Math.floor(at - bar * per + 1e-9) + 1}`;
}

/** `↻ 5–6` (`loop 5-6` without Unicode): the loop range, 1-based bars. */
export function loopRangeLabel(
  range: Readonly<{ startBar: number; bars: number }>,
  unicode: boolean,
): string {
  const first = range.startBar + 1;
  const last = range.startBar + range.bars;
  const bars =
    first === last ? `${first}` : `${first}${unicode ? "–" : "-"}${last}`;
  return unicode ? `↻ ${bars}` : `loop ${bars}`;
}

/** `B ⧉3`: this pane's letter and how many panes are live. */
export function paneLabel(
  windows: number,
  pane: string | undefined,
  unicode: boolean,
): string {
  const count = unicode ? `⧉${windows}` : `${windows} panes`;
  return pane ? `${pane} ${count}` : count;
}

/** The footer's right side: the session name, then the spend line. */
export function footerStatus(view: AppView, sessionId?: string): string {
  const session =
    view.sessionName ??
    (sessionId ? `session ${sessionId.slice(0, 8)}` : undefined);
  return [session, view.spend].filter(Boolean).join(" · ");
}

function paintHeader(
  buffer: CellBuffer,
  view: AppView,
  ui: UiState,
  width: number,
  hits?: HitMap,
  beat = 0,
): void {
  const { theme, capabilities } = ui;
  const roles = theme.roles;
  const score = view.score;
  const unicode = capabilities.unicode;
  const playing = score.playing === true;
  // The ▶ brightens for a moment on each bar's downbeat.
  const glint = downbeatGlint({
    playing,
    beat,
    bpm: score.bpm ?? 120,
    beatsPerBar: score.beatsPerBar ?? 4,
    barBeats: score.barBeats,
    loopBeats: score.loopBeats,
    reducedMotion: ui.reducedMotion,
  });
  const transport = `${playing ? (unicode ? "▶" : ">") : unicode ? "⏸" : "||"} ${score.bpm ?? 120} BPM`;
  const name = score.trackName ?? score.trackId ?? "track";
  // dawg · ▶ BPM · bar.beat · ↻ loop · track ··· key · model · rev · pane
  // (design §8.2): where you are in the song reads first; the session name
  // lives in the footer.
  const left: Segment[] = [
    { text: "dawg", style: { ...roles.muted, bold: true }, priority: 6 },
    {
      text: transport,
      style: playing
        ? glint
          ? { ...shade(roles.transport, 0.55), bold: true }
          : roles.transport
        : roles.paused,
      priority: 0,
      target: { kind: "transport" },
    },
    {
      text: barBeatLabel(beat, score.beatsPerBar ?? 4, score.barBeats),
      style: roles.text,
      priority: 2,
    },
  ];
  if (score.loopRange)
    left.push({
      text: loopRangeLabel(score.loopRange, unicode),
      // The loop is the green knob's (§8.1): it wears that color.
      style: roles.knob2,
      priority: 3,
    });
  left.push({
    text: name,
    style: { ...accentStyle(theme, score.trackId ?? name), bold: true },
    priority: 0,
    target: { kind: "tracks" },
  });
  const right: Segment[] = [];
  // The key never drops before the model, rev or sync at 80 columns.
  if (score.key)
    right.push({ text: score.key, style: roles.muted, priority: 1 });
  if (view.model)
    right.push({
      text: view.model,
      style: roles.agent,
      priority: 2,
      target: { kind: "model" },
    });
  if (score.revision !== undefined)
    right.push({
      text: `rev ${score.revision}`,
      style: roles.text,
      priority: 1,
    });
  if (view.windows !== undefined && view.windows > 1)
    right.push({
      text: paneLabel(view.windows, view.pane, unicode),
      style: roles.muted,
      priority: 4,
    });
  if (view.types)
    right.push({
      text: view.types.ok
        ? `types ${unicode ? "✓" : "ok"}`
        : `types ${unicode ? "✗" : "x"} ${view.types.errors}`,
      style: view.types.ok ? roles.success : roles.error,
      priority: 4,
    });
  if (view.loudness)
    right.push({
      text: loudnessMeter(view.loudness),
      // Over full scale is an error; above the limiter's ceiling (-1 dBTP
      // without one) or off the target by more than 0.5 LU a warning.
      style:
        view.loudness.truePeak > 0
          ? roles.error
          : view.loudness.truePeak > (view.loudness.ceiling ?? -1) + 0.1 ||
              loudnessOffTarget(view.loudness)
            ? roles.warning
            : roles.muted,
      priority: 3,
    });
  const sync = syncSegment(view.sync, theme, unicode);
  if (sync) right.push(sync);
  paintSegments(
    buffer,
    0,
    left,
    width,
    " · ",
    roles.faint,
    roles.panel,
    right,
    hits,
  );
}

// ---------------------------------------------------------------------------
// Activity strip

function cardMarker(card: ActivityCard, unicode: boolean): string {
  switch (card.tone) {
    case "error":
      return unicode ? "✗" : "x";
    case "warning":
      return "!";
    case "agent":
      return unicode ? "◆" : "*";
    case "success":
      return unicode ? "✓" : "+";
    default:
      return unicode ? "•" : "-";
  }
}

export function cardText(card: ActivityCard, unicode: boolean): string {
  const count =
    card.count && card.count > 1 ? ` ${unicode ? "×" : "x"}${card.count}` : "";
  const parts = [`${cardMarker(card, unicode)} ${card.text}${count}`];
  const revision = revisionLabel(
    card.baseRevision,
    card.resultRevision,
    unicode,
  );
  if (revision) parts.push(revision);
  if (card.hint) parts.push(card.hint);
  if (card.suffix) parts.push(card.suffix);
  return parts.join(" · ");
}

/** How long each one-time note leads when they cannot all fit at once. */
export const ONCE_ROTATE_MS = 3_000;

/**
 * The cards for the strip's width: when the one-time notes cannot all show
 * whole beside the receipts, they take turns (one every `ONCE_ROTATE_MS`,
 * on the frame clock), so each is read in full at least once.
 */
export function stripCards(
  cards: readonly ActivityCard[],
  room: number,
  nowMs: number,
  unicode: boolean,
): ActivityCard[] {
  const width = (list: readonly ActivityCard[]) =>
    list.reduce(
      (sum, card, index) =>
        sum + (index > 0 ? 3 : 0) + displayWidth(cardText(card, unicode)),
      0,
    );
  if (width(cards) <= room) return [...cards];
  const steady = cards.filter((card) => !card.once);
  const once = cards.filter((card) => card.once);
  if (once.length < 2) return [...cards];
  const turn =
    once[Math.floor(Math.max(0, nowMs) / ONCE_ROTATE_MS) % once.length]!;
  return [...steady, turn];
}

function paintActivity(
  buffer: CellBuffer,
  y: number,
  ui: UiState,
  width: number,
  nowMs: number,
  agentOffline = false,
): void {
  const { theme, capabilities, activity } = ui;
  const roles = theme.roles;
  const background = roles.canvas;
  buffer.fill(0, y, width, 1, background);
  let x = 1;
  const right: string[] = [];
  if (activity.queueDepth > 0) right.push(`queue ${activity.queueDepth}`);
  if (ui.reducedMotion) right.push("motion off");
  const rightText = right.join(" · ");
  const limit = width - 1 - (rightText ? displayWidth(rightText) + 2 : 0);
  const spinner = activity.spinner;
  if (spinner) {
    const frame = spinnerFrame(
      nowMs - spinner.sinceMs,
      capabilities.unicode,
      ui.reducedMotion,
    );
    x += buffer.text(x, y, `${frame} `, roles.agent);
    x += buffer.text(x, y, truncate(spinner.label, Math.max(0, limit - x)), {
      ...roles.agent,
      bold: true,
    });
    // The agent's latest sentence, faint: what it is doing, in its words.
    if (activity.streamSentence && x < limit - 4) {
      x += buffer.text(x, y, " · ", roles.faint);
      const tail = activity.streamSentence;
      const room = Math.max(0, limit - x);
      const shown =
        displayWidth(tail) > room
          ? `…${Array.from(tail)
              .slice(-(room - 1))
              .join("")}`
          : tail;
      x += buffer.text(x, y, truncate(shown, room), roles.faint);
    }
  } else {
    const cards = stripCards(
      activity.visible(nowMs),
      Math.max(0, limit - x),
      nowMs,
      capabilities.unicode,
    );
    cards.forEach((card, index) => {
      if (x >= limit) return;
      const text = cardText(card, capabilities.unicode);
      // A one-time note behind the first slot shows whole or not at all
      // (it stays in ctrl-o); a cut note loses its key word.
      if (index > 0 && card.once && x + 3 + displayWidth(text) > limit) {
        x = limit;
        return;
      }
      if (index > 0) {
        if (x + 3 + Math.min(12, displayWidth(text)) > limit) {
          x = limit;
          return;
        }
        x += buffer.text(x, y, "   ", background);
      }
      const age = nowMs - card.atMs;
      let style: Style =
        card.tone === "error"
          ? roles.error
          : card.tone === "warning"
            ? roles.warning
            : card.tone === "agent"
              ? roles.agent
              : card.tone === "success"
                ? roles.success
                : roles.text;
      // Behind the first slot everything is faint; an error keeps its
      // color until it is old, then fades with the rest.
      if (index > 0)
        style =
          card.tone === "error" && age < ERROR_FADE_MS
            ? roles.error
            : roles.faint;
      else if (card.once) style = roles.faint;
      else if (!ui.reducedMotion && age >= 0 && age < CARD_GLOW_MS)
        style = { ...shade(style, 0.4 * (1 - age / CARD_GLOW_MS)), bold: true };
      x += buffer.text(x, y, truncate(text, Math.max(0, limit - x)), style);
    });
    if (cards.length === 0)
      buffer.text(
        x,
        y,
        truncate(
          agentOffline
            ? "type a command · space plays on an empty prompt · /help"
            : "type a request · space plays on an empty prompt · /help",
          limit - x,
        ),
        roles.faint,
      );
  }
  if (rightText)
    buffer.text(width - 1 - displayWidth(rightText), y, rightText, roles.muted);
}

// ---------------------------------------------------------------------------
// Prompt panel

function pill(mode: PromptMode): string {
  return mode === "queue" ? " NEXT " : " NOW ";
}

function paintPrompt(
  buffer: CellBuffer,
  view: AppView,
  ui: UiState,
  layout: FrameLayout,
  width: number,
): { cursor: CursorPosition; rows: number } {
  const { theme, capabilities, prompt, activity } = ui;
  const roles = theme.roles;
  const box = capabilities.unicode ? UNICODE_BOX : ASCII_BOX;
  const panel: Style = { ...roles.promptBg };
  const border = onBackground(roles.borderFocus, panel);
  const top = layout.prompt.y;
  const height = layout.prompt.height;
  buffer.fill(0, top, width, height, panel);
  const rows = layout.promptRows;

  // Top border with the mode pill and right-aligned status.
  buffer.set(0, top, box.tl, border);
  for (let x = 1; x < width - 1; x += 1) buffer.set(x, top, box.h, border);
  buffer.set(width - 1, top, box.tr, border);
  const mode = prompt.snapshot.mode;
  const pillStyle = mode === "queue" ? roles.pillQueue : roles.pillSteer;
  let x = 2;
  if (!view.agentOffline) x += buffer.text(x, top, pill(mode), pillStyle);
  const status: string[] = [];
  // The model shows once, in the header; the spend line carries it here.
  // Views without a spend line (embedders such as the site demo) keep the
  // model label.
  if (view.spend) {
    if (!layout.footer) status.push(view.spend);
  } else if (view.model) status.push(view.model);
  if (!layout.footer && view.sessionName) status.unshift(view.sessionName);
  if (activity.queueDepth > 0) status.push(`queue ${activity.queueDepth}`);
  const layoutInfo = prompt.layout(rows);
  if (layoutInfo.total > rows)
    status.push(
      `${layoutInfo.first + layoutInfo.cursorRow + 1}/${layoutInfo.total}`,
    );
  const statusText = ` ${status.join(" · ")} `;
  if (status.length && width - 2 - displayWidth(statusText) > x + 1)
    buffer.text(
      width - 2 - displayWidth(statusText),
      top,
      statusText,
      onBackground(roles.muted, panel),
    );

  // Editor rows.
  const text = onBackground(roles.promptText, panel);
  const faint = onBackground(roles.faint, panel);
  const editorWidth = promptEditorWidth(width);
  for (let index = 0; index < rows; index += 1) {
    const y = top + 1 + index;
    buffer.set(0, y, box.v, border);
    buffer.set(width - 1, y, box.v, border);
    const row = layoutInfo.rows[index];
    const isFirst = layoutInfo.first + index === 0;
    buffer.text(
      2,
      y,
      isFirst ? (capabilities.unicode ? "›" : ">") : " ",
      onBackground(roles.borderFocus, panel),
    );
    if (row) buffer.text(4, y, row.text, text, editorWidth + 1);
    if (index === 0 && layoutInfo.first > 0)
      buffer.text(width - 3, y, capabilities.unicode ? "↑" : "^", faint);
    if (index === rows - 1 && layoutInfo.first + rows < layoutInfo.total)
      buffer.text(width - 3, y, capabilities.unicode ? "↓" : "v", faint);
  }
  const ghost = view.showMe?.ghost;
  const caption = view.showMe?.caption;
  if (prompt.value.length === 0 && (ghost || caption)) {
    // The agent's command as it streams, then the gesture it stands for.
    const typed = ghost ? `${ghost}${capabilities.unicode ? "▏" : "_"}` : "";
    const line = typed && caption ? `${typed}  ${caption}` : typed || caption!;
    buffer.text(5, top + 1, truncate(line, editorWidth - 1), faint);
  } else if (prompt.value.length === 0) {
    // Seeded per session (tui/hints.ts): the words stay put while you
    // work and change between sessions, chosen by agent and song state.
    const score = view.score;
    const placeholder = placeholderHint({
      seed: score.sessionId ?? "dawg",
      agent: !view.agentOffline,
      filled:
        score.notes.length > 0 ||
        (score.clips ?? []).length > 0 ||
        (score.layers ?? []).some((layer) => layer.notes.length > 0),
      drums: projectionFor(score).kind !== "pitch",
      queue: mode === "queue",
    });
    buffer.text(5, top + 1, truncate(placeholder, editorWidth - 1), faint);
  }

  // Footer hints.
  if (layout.footer) {
    const y = top + height - 1;
    buffer.set(0, y, box.bl, border);
    for (let column = 1; column < width - 1; column += 1)
      buffer.set(column, y, box.h, border);
    buffer.set(width - 1, y, box.br, border);
    // One notation everywhere: ctrl-<key>, as /help and the menu spell it.
    const hints =
      width >= 112
        ? " enter send · shift-enter newline · ctrl-q now/next · ctrl-z undo · ctrl-o log · ctrl-c quit "
        : width >= 80
          ? " enter send · ctrl-j newline · ctrl-q now/next · ctrl-z undo · ctrl-o log "
          : width >= 52
            ? " enter · ctrl-q now/next · ctrl-z undo · ctrl-o log "
            : "";
    const right = footerStatus(view, view.score.sessionId);
    const spend = right ? ` ${right} ` : "";
    const spendWidth = displayWidth(spend);
    // Spend wins over hints when both do not fit.
    const shown =
      hints && displayWidth(hints) + spendWidth + 6 <= width ? hints : "";
    if (shown) buffer.text(2, y, shown, onBackground(roles.muted, panel));
    if (spend && spendWidth + 4 <= width)
      buffer.text(
        width - 2 - spendWidth,
        y,
        spend,
        onBackground(roles.muted, panel),
      );
  }

  // Cursor: shown as a reverse cell and as the real terminal cursor.
  const cursorX = Math.min(width - 2, 4 + layoutInfo.cursorColumn);
  const cursorY = top + 1 + Math.min(rows - 1, layoutInfo.cursorRow);
  const under = buffer.get(cursorX, cursorY);
  buffer.set(
    cursorX,
    cursorY,
    under && under.ch !== "" && prompt.value.length > 0 ? under.ch : " ",
    { ...text, ...roles.cursor },
  );
  return { cursor: { x: cursorX, y: cursorY }, rows };
}

// ---------------------------------------------------------------------------
// Transcript overlay

const KIND_TAGS: Record<TranscriptEntry["kind"], string> = {
  request: "you",
  op: "op ",
  revision: "rev",
  error: "ERR",
  agent: "ai ",
  note: "   ",
};

function paintOverlay(
  buffer: CellBuffer,
  ui: UiState,
  region: { y: number; height: number },
  width: number,
): void {
  const { theme, capabilities, activity } = ui;
  const roles = theme.roles;
  const box = capabilities.unicode ? UNICODE_BOX : ASCII_BOX;
  const panel = roles.panel;
  const border = onBackground(roles.border, panel);
  const { left, boxWidth } = panelRect(width);
  const top = region.y;
  const height = region.height;
  if (height < 3 || boxWidth < 10) return;
  buffer.fill(left, top, boxWidth, height, panel);
  buffer.set(left, top, box.tl, border);
  buffer.set(left + boxWidth - 1, top, box.tr, border);
  buffer.set(left, top + height - 1, box.bl, border);
  buffer.set(left + boxWidth - 1, top + height - 1, box.br, border);
  for (let x = left + 1; x < left + boxWidth - 1; x += 1) {
    buffer.set(x, top, box.h, border);
    buffer.set(x, top + height - 1, box.h, border);
  }
  for (let y = top + 1; y < top + height - 1; y += 1) {
    buffer.set(left, y, box.v, border);
    buffer.set(left + boxWidth - 1, y, box.v, border);
  }
  const view = ui.log ?? { scroll: 0, filter: "all" };
  const inner = height - 2;
  const all = logEntriesFor(activity.transcript, view.filter);
  const maxScroll = Math.max(0, all.length - inner);
  const scroll = Math.max(0, Math.min(maxScroll, view.scroll));
  const end = all.length - scroll;
  const entries = all.slice(Math.max(0, end - inner), end);
  const position =
    scroll > 0 ? ` · ${end}/${all.length}` : all.length > inner ? " · end" : "";
  buffer.text(
    left + 2,
    top,
    ` transcript · ${view.filter}${position} `,
    onBackground({ ...roles.text, bold: true }, panel),
    boxWidth - 4,
  );
  const hintText = footerHint(HINTS.log, boxWidth - 4, capabilities.unicode);
  if (hintText)
    buffer.text(
      left + boxWidth - 2 - displayWidth(hintText),
      top + height - 1,
      hintText,
      onBackground(roles.muted, panel),
    );
  if (entries.length === 0)
    buffer.text(
      left + 2,
      top + 1,
      view.filter === "all" ? "nothing yet" : `no ${view.filter} yet`,
      onBackground(roles.faint, panel),
    );
  entries.forEach((entry, index) => {
    const y = top + 1 + index;
    const tagStyle =
      entry.kind === "error"
        ? roles.error
        : entry.kind === "request"
          ? roles.borderFocus
          : entry.kind === "agent"
            ? roles.agent
            : roles.muted;
    buffer.text(
      left + 2,
      y,
      KIND_TAGS[entry.kind],
      onBackground({ ...tagStyle, bold: true }, panel),
    );
    buffer.text(
      left + 6,
      y,
      truncate(entry.text.replace(/\s+/g, " "), boxWidth - 8),
      onBackground(entry.kind === "error" ? roles.error : roles.text, panel),
    );
  });
}

/** Static lines in a bordered panel; the title sits on the top border. */
function paintText(
  buffer: CellBuffer,
  ui: UiState,
  region: { y: number; height: number },
  width: number,
  options: { text?: TextView | undefined; hint?: string } = {},
): void {
  const text = options.text ?? ui.text;
  if (!text) return;
  const roles = ui.theme.roles;
  const { left, boxWidth } = panelRect(width);
  const height = region.height;
  if (height < 3 || boxWidth < 10) return;
  const panel = paintBox(buffer, ui, {
    left,
    top: region.y,
    width: boxWidth,
    height,
  });
  const inner = height - 2;
  const maxScroll = Math.max(0, text.lines.length - inner);
  const scroll = Math.max(0, Math.min(maxScroll, text.scroll));
  const position =
    maxScroll > 0
      ? ` · ${scroll + 1}-${scroll + inner}/${text.lines.length}`
      : "";
  buffer.text(
    left + 2,
    region.y,
    ` ${text.title}${position} `,
    onBackground({ ...roles.text, bold: true }, panel),
    boxWidth - 4,
  );
  const hint = footerHint(
    options.hint ?? HINTS.text,
    boxWidth - 4,
    ui.capabilities.unicode,
  );
  if (hint)
    buffer.text(
      left + boxWidth - 2 - displayWidth(hint),
      region.y + height - 1,
      hint,
      onBackground(roles.muted, panel),
    );
  text.lines.slice(scroll, scroll + inner).forEach((line, index) => {
    const heading = line.startsWith("── ");
    const y = region.y + 1 + index;
    // The heading's mark, as in /guide (guides/marks.ts): the symbol says
    // what the group is, its role's color repeats it.
    const mark = heading
      ? (text.marks?.[scroll + index] ?? RULE_MARK)
      : undefined;
    const sign = mark ? (ui.capabilities.unicode ? mark.mark : mark.ascii) : "";
    buffer.text(
      left + 2,
      y,
      truncate(heading ? `${sign} ${line.slice(3)}` : line, boxWidth - 4),
      onBackground(heading ? { ...roles.text, bold: true } : roles.text, panel),
    );
    if (mark)
      buffer.text(
        left + 2,
        y,
        sign,
        onBackground({ ...roles[mark.role], bold: true }, panel),
        boxWidth - 4,
      );
  });
}

function paintGuide(
  buffer: CellBuffer,
  ui: UiState,
  region: { y: number; height: number },
  width: number,
): void {
  const guide = ui.guide;
  if (!guide) return;
  const roles = ui.theme.roles;
  const unicode = ui.capabilities.unicode;
  const { left, boxWidth } = panelRect(width);
  const height = region.height;
  if (height < 3 || boxWidth < 10) return;
  const panel = paintBox(buffer, ui, {
    left,
    top: region.y,
    width: boxWidth,
    height,
  });
  const view = guide.view(boxWidth - 4, height - 2, unicode);
  buffer.text(
    left + 2,
    region.y,
    ` ${view.title} `,
    onBackground({ ...roles.text, bold: true }, panel),
    boxWidth - 4,
  );
  const hint = footerHint(view.hint, boxWidth - 4, unicode);
  if (hint)
    buffer.text(
      left + boxWidth - 2 - displayWidth(hint),
      region.y + height - 1,
      hint,
      onBackground(roles.muted, panel),
    );
  view.rows.forEach((row, index) => {
    const style = row.selected
      ? { ...roles.borderFocus, bold: true }
      : row.heading
        ? { ...roles.text, bold: true }
        : row.muted
          ? roles.muted
          : roles.text;
    const marker = row.selected ? (unicode ? "›" : ">") : " ";
    const tree = guide.page === undefined;
    const text = tree ? `${marker}${row.text}` : row.text;
    const x = left + 2;
    const y = region.y + 1 + index;
    const room = boxWidth - 4;
    buffer.text(x, y, truncate(text, room), onBackground(style, panel));
    if (tree) return;
    // The mark and typed commands repeat their meaning in color; the
    // symbol (or bold) carries it without.
    const paint = (from: number, to: number, role: Style) => {
      const at = displayWidth(row.text.slice(0, from));
      if (at >= room) return;
      buffer.text(
        x + at,
        y,
        row.text.slice(from, to),
        onBackground(role, panel),
        room - at,
      );
    };
    if (row.mark)
      paint(0, row.mark.length, { ...roles[row.mark.role], bold: true });
    for (const [from, to] of row.code ?? [])
      paint(from, to, { ...roles[CODE_ROLE], bold: true });
  });
}

function paintBox(
  buffer: CellBuffer,
  ui: UiState,
  rect: { left: number; top: number; width: number; height: number },
): Style {
  const roles = ui.theme.roles;
  const box = ui.capabilities.unicode ? UNICODE_BOX : ASCII_BOX;
  const panel = roles.panel;
  const border = onBackground(roles.borderFocus, panel);
  const { left, top, width, height } = rect;
  buffer.fill(left, top, width, height, panel);
  buffer.set(left, top, box.tl, border);
  buffer.set(left + width - 1, top, box.tr, border);
  buffer.set(left, top + height - 1, box.bl, border);
  buffer.set(left + width - 1, top + height - 1, box.br, border);
  for (let x = left + 1; x < left + width - 1; x += 1) {
    buffer.set(x, top, box.h, border);
    buffer.set(x, top + height - 1, box.h, border);
  }
  for (let y = top + 1; y < top + height - 1; y += 1) {
    buffer.set(left, y, box.v, border);
    buffer.set(left + width - 1, y, box.v, border);
  }
  return panel;
}

function paintPicker(
  buffer: CellBuffer,
  ui: UiState,
  region: { y: number; height: number },
  width: number,
  hits?: HitMap,
): void {
  const picker = ui.picker;
  if (!picker) return;
  const roles = ui.theme.roles;
  const { left, boxWidth } = panelRect(width);
  const noteRows = picker.note && region.height >= 6 ? 1 : 0;
  const height = Math.min(
    region.height,
    Math.max(1, picker.items.length) + 2 + noteRows,
  );
  if (height < 3 || boxWidth < 10) return;
  const panel = paintBox(buffer, ui, {
    left,
    top: region.y,
    width: boxWidth,
    height,
  });
  if (picker.crumbs)
    paintCrumbs(buffer, left + 2, region.y, picker.crumbs, boxWidth - 4, {
      roles,
      unicode: ui.capabilities.unicode,
      background: panel,
    });
  else
    buffer.text(
      left + 2,
      region.y,
      ` ${picker.title}${picker.filtering || picker.query ? ` · /${picker.query ?? ""}${picker.filtering ? "▏" : ""}` : ""} `,
      onBackground({ ...roles.text, bold: true }, panel),
      boxWidth - 4,
    );
  const hint = footerHint(
    picker.filtering
      ? HINTS.filtering
      : (picker.hint ??
          (picker.filterable
            ? HINTS.list
            : HINTS.list.replace(" · / filter", ""))),
    boxWidth - 4,
    ui.capabilities.unicode,
  );
  if (hint)
    buffer.text(
      left + boxWidth - 2 - displayWidth(hint),
      region.y + height - 1,
      hint,
      onBackground(roles.muted, panel),
    );
  const inner = height - 2 - noteRows;
  if (noteRows && picker.note)
    buffer.text(
      left + 2,
      region.y + height - 2,
      truncate(picker.note, boxWidth - 4),
      onBackground(roles.muted, panel),
    );
  const first = Math.max(
    0,
    Math.min(picker.items.length - inner, picker.index - inner + 1),
  );
  const marks = (picker.all ?? picker.items).some(
    (item) => item.current !== undefined,
  );
  if (picker.items.length === 0)
    buffer.text(
      left + 4,
      region.y + 1,
      "no matches",
      onBackground(roles.muted, panel),
    );
  picker.items.slice(first, first + inner).forEach((item, offset) => {
    const index = first + offset;
    const y = region.y + 1 + offset;
    hits?.add(left + 1, y, boxWidth - 2, 1, { kind: "picker-row", index });
    const selected = index === picker.index;
    const marker = selected ? (ui.capabilities.unicode ? "›" : ">") : " ";
    const style = selected
      ? onBackground({ ...roles.borderFocus, bold: true }, panel)
      : onBackground(roles.text, panel);
    buffer.text(left + 2, y, marker, style);
    // A column for the current-item mark only when the picker uses one.
    const pad = marks ? 2 : 0;
    if (item.current)
      buffer.text(
        left + 4,
        y,
        ui.capabilities.unicode ? "●" : "*",
        onBackground(roles.success, panel),
      );
    const room = boxWidth - 6 - pad;
    const used = buffer.text(
      left + 4 + pad,
      y,
      truncate(item.label, room),
      style,
    );
    if (item.detail && used + 3 < room)
      buffer.text(
        left + 4 + pad + used + 2,
        y,
        truncate(item.detail, room - used - 2),
        onBackground(roles.muted, panel),
      );
  });
}

/** The `?` panel sits at the bottom of the highway, as tall as it needs. */
function keysRegion(
  region: { y: number; height: number },
  keys: TextView,
): { y: number; height: number } {
  const height = Math.min(region.height, keys.lines.length + 2);
  return { y: region.y + region.height - height, height };
}

/** A footer hint fitted to `width`, spelled in ASCII when needed. */
export function footerHint(
  hint: string,
  width: number,
  unicode: boolean,
): string {
  return fitHint(unicode ? hint : asciiHint(hint), width);
}

// ---------------------------------------------------------------------------

/**
 * The too-small screen's lines, widest layout that fits first: one line
 * (`terminal too small · 58×14 · need ≥ 60×16`), then stacked, then bare
 * numbers. The last line is the keys that still work.
 */
export function tooSmallLines(
  size: FrameSize,
  unicode: boolean,
  playing: boolean,
): string[] {
  const x = unicode ? "×" : "x";
  const dot = unicode ? " · " : " - ";
  const now = `${size.width}${x}${size.height}`;
  const need = `need ${unicode ? "≥" : ">="} ${MIN_WIDTH}${x}${MIN_HEIGHT}`;
  const keys = `space ${playing ? "stop" : "play"}${dot}q quit`;
  const fits = (lines: string[]) =>
    lines.length <= size.height &&
    lines.every((line) => displayWidth(line) <= size.width);
  const layouts = [
    [`terminal too small${dot}${now}${dot}${need}`, "", keys],
    ["terminal too small", `${now}${dot}${need}`, "", keys],
    ["terminal too small", now, need, "", keys],
    ["terminal too small", now, need],
    ["too small", now, need],
    [now, need],
    [`${now} ${unicode ? "≥" : ">="}${MIN_WIDTH}${x}${MIN_HEIGHT}`],
    [now],
  ];
  return layouts.find(fits) ?? [now];
}

/**
 * What a key does while the too-small screen is up: ctrl-c and q quit,
 * space starts or stops playback, everything else (typing, mouse, menu
 * keys) is dropped so the hidden UI's state is untouched.
 */
export function tooSmallKey(value: unknown): "quit" | "play" | "ignore" {
  if (value === "\u0003" || value === "q" || value === "Q") return "quit";
  if (value === " ") return "play";
  return "ignore";
}

function paintTooSmall(
  buffer: CellBuffer,
  ui: UiState,
  size: FrameSize,
  playing: boolean,
): void {
  const roles = ui.theme.roles;
  const lines = tooSmallLines(size, ui.capabilities.unicode, playing);
  const top = Math.max(0, Math.floor((size.height - lines.length) / 2));
  lines.forEach((line, index) => {
    const text = truncate(line, size.width);
    const x = Math.max(0, Math.floor((size.width - displayWidth(text)) / 2));
    buffer.text(
      x,
      top + index,
      text,
      index === 0 ? { ...roles.warning, bold: true } : roles.muted,
    );
  });
}

export function composeFrame(
  view: AppView,
  ui: UiState,
  size: FrameSize,
  nowMs: number,
): Frame {
  const width = Math.max(1, Math.floor(size.width));
  const height = Math.max(1, Math.floor(size.height));
  const buffer = new CellBuffer(width, height, ui.theme.roles.canvas);
  ui.prompt.setWidth(promptEditorWidth(width));
  const layout = computeLayout({ width, height }, ui.prompt.wrappedRows);
  const hits = new HitMap();
  if (layout.tooSmall) {
    paintTooSmall(buffer, ui, { width, height }, view.score.playing === true);
    return {
      buffer,
      cursor: undefined,
      promptRows: 0,
      layout,
      hits: new HitMap(),
    };
  }
  if (view.play) {
    paintPlayHeader(
      buffer,
      layout.header,
      width,
      {
        ...view.play,
        context: playContext(view.score, ui.capabilities.unicode),
      },
      ui.theme,
      ui.capabilities.unicode,
    );
    // The keyboard as it sits under the hands; one line of `A C3 W C#`
    // only when the rows are too few to draw it and keep the roll.
    const keysView = {
      ...view.play,
      octave: view.play.octave ?? view.play.range,
    };
    const keyRows = playKeysRows(
      keysView,
      width,
      layout.highway.height,
      ui.capabilities.unicode,
    );
    const used =
      keyRows + 2 <= layout.highway.height
        ? paintPlayKeys(
            buffer,
            layout.highway.y,
            width,
            layout.highway.height,
            keysView,
            ui.theme,
            ui.capabilities.unicode,
          )
        : layout.highway.height > 1
          ? (paintPlayStrip(
              buffer,
              layout.highway.y,
              width,
              view.play.keys,
              ui.theme,
            ),
            1)
          : 0;
    layout.highway = {
      y: layout.highway.y + used,
      height: layout.highway.height - used,
    };
    if (view.play.legend && layout.highway.height > 4) {
      paintChordLegend(
        buffer,
        layout.highway.y,
        width,
        view.play.legend,
        ui.theme,
      );
      layout.highway = {
        y: layout.highway.y + 1,
        height: layout.highway.height - 1,
      };
    }
  } else
    paintHeader(
      buffer,
      view,
      ui,
      width,
      hits,
      view.beat ?? resolveBeat(view.score, nowMs),
    );
  if (view.arrange && !view.tape && !view.patch && layout.highway.height > 4) {
    paintArrangeStrip(
      buffer,
      layout.highway.y,
      width,
      view.arrange,
      ui.theme,
      ui.capabilities.unicode,
    );
    layout.highway = {
      y: layout.highway.y + 1,
      height: layout.highway.height - 1,
    };
  }
  const beat = view.beat ?? resolveBeat(view.score, nowMs);
  let drawer: DrawerLayout | undefined;
  if (layout.highway.height > 0) {
    hits.add(0, layout.highway.y, width, layout.highway.height, {
      kind: ui.overlay && !ui.drawer ? "text" : "highway",
    });
    // The drawer replaces the menu's list: the piano roll shows above it.
    let panel: number | undefined = TEXT_MEASURE;
    if (ui.overlay === "log" && !ui.drawer)
      paintOverlay(buffer, ui, layout.highway, width);
    else if (ui.overlay === "picker" && ui.picker && !ui.drawer)
      paintPicker(buffer, ui, layout.highway, width, hits);
    else if (ui.overlay === "text" && ui.text)
      paintText(buffer, ui, layout.highway, width);
    else if (ui.overlay === "guide" && ui.guide)
      paintGuide(buffer, ui, layout.highway, width);
    else panel = undefined;
    // A text panel holds its measure; on a wide terminal the song keeps
    // drawing beside it instead of an empty margin.
    const { left: panelLeft, boxWidth } = panelRect(width, panel);
    const sideX = panelLeft + boxWidth + 1;
    const side =
      panel !== undefined
        ? width - sideX >= SIDE_MIN_WIDTH
          ? { x: sideX, width: width - sideX }
          : undefined
        : { x: 0, width };
    if (side && view.patch)
      paintPatch(
        buffer,
        { ...side, y: layout.highway.y, height: layout.highway.height },
        view.patch,
        {
          theme: ui.theme,
          unicode: ui.capabilities.unicode,
          ...(panel !== undefined ? {} : { hits }),
        },
      );
    else if (side && view.tape)
      paintTape(
        buffer,
        { ...side, y: layout.highway.y, height: layout.highway.height },
        view.tape,
        {
          theme: ui.theme,
          unicode: ui.capabilities.unicode,
          ...(panel !== undefined ? {} : { hits }),
        },
      );
    else if (side)
      paintHighway(
        buffer,
        { ...side, y: layout.highway.y, height: layout.highway.height },
        view.score,
        beat,
        {
          theme: ui.theme,
          capabilities: ui.capabilities,
          reducedMotion: ui.reducedMotion,
          hint: {
            seed: view.score.sessionId ?? "dawg",
            agent: !view.agentOffline,
          },
          sweep: sweepProgress(
            ui.delight?.sweepStartedAtMs,
            nowMs,
            ui.reducedMotion,
          ),
          glows: ui.delight?.glows(nowMs, ui.reducedMotion),
        },
      );
    if (ui.drawer)
      drawer = paintDrawer(
        buffer,
        layout.highway,
        width,
        ui.drawer,
        {
          theme: ui.theme,
          unicode: ui.capabilities.unicode,
          reducedMotion: ui.reducedMotion,
        },
        hits,
      );
  }
  if (ui.keys && layout.highway.height > 0)
    paintText(buffer, ui, keysRegion(layout.highway, ui.keys), width, {
      text: ui.keys,
      hint: HINTS.keys,
    });
  paintActivity(
    buffer,
    layout.activity,
    ui,
    width,
    nowMs,
    view.agentOffline ?? false,
  );
  const prompt = paintPrompt(buffer, view, ui, layout, width);
  return {
    buffer,
    cursor: prompt.cursor,
    promptRows: prompt.rows,
    layout,
    hits,
    drawer,
  };
}

// ---------------------------------------------------------------------------
// Mutable app

/** The longest a lagging terminal waits between frames. */
export const MAX_BACKOFF_MS = 250;

export interface TerminalIO {
  /**
   * Writes a frame. `false` means the terminal is not keeping up (the
   * stream's buffer is full): frames back off until a write is accepted.
   */
  write(data: string): void | boolean;
  columns(): number;
  rows(): number;
}

export interface TuiAppOptions {
  io: TerminalIO;
  capabilities?: TerminalCapabilities;
  theme?: ThemeName;
  reducedMotion?: boolean;
  clock?: () => number;
  prompt?: PromptModel;
  activity?: ActivityFeed;
}

export type AppInput =
  | { type: "action"; action: PromptAction }
  | { type: "ui"; command: UiCommand }
  /** Enter on a picker row; `value` is the chosen item's value. */
  | { type: "pick"; picker: string; value: string }
  /** Esc on a picker. */
  | { type: "pick-cancel"; picker: string }
  /**
   * The highlighted row changed (move, page, filter): the hook for live
   * previews (/pattern today; an audition controller can listen here too).
   * Pickers raise `pick-move` → `pick` (commit) or `pick-cancel` (cancel).
   */
  | { type: "pick-move"; picker: string; value: string }
  /** Space, `a` or `c` on a picker that hosts the audition loop. */
  | { type: "pick-audition"; picker: string; key: "loop" | "ab" | "context" }
  /** Consumed by an overlay (scroll, filter, move). */
  | { type: "overlay" }
  | { type: "none" };

export class TuiApp {
  readonly prompt: PromptModel;
  readonly activity: ActivityFeed;
  readonly io: TerminalIO;
  readonly clock: () => number;
  capabilities: TerminalCapabilities;
  themeName: ThemeName;
  reducedMotion: boolean;
  overlay: Overlay;
  log: LogView = { scroll: 0, filter: "all" };
  picker: PickerState | undefined;
  text: TextView | undefined;
  /** The fader drawer's paint model while one is open. */
  drawer: DrawerView | undefined;
  /** `/view all` overlays every unmuted track; `/view focus` shows one. */
  highwayView: "all" | "focus" = "all";
  private writer: ScreenWriter;
  private lastFrame: Frame | undefined;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  /** Compose plus encode time of the last rendered frame, in ms. */
  lastRenderMs = 0;
  /** Minimum interval between frames (~30 fps). */
  frameIntervalMs = 33;
  /**
   * Extra spacing while the terminal lags: doubles on each refused write up
   * to `MAX_BACKOFF_MS`, resets on the first accepted one.
   */
  backoffMs = 0;
  /** Session-only delight; `heardLoop` comes from the session's metadata. */
  readonly delight = new Delight();
  /** The song wrapped for the first time: the host records it in meta. */
  onFirstLoop: (() => void) | undefined;

  constructor(options: TuiAppOptions) {
    this.io = options.io;
    this.clock = options.clock ?? Date.now;
    this.capabilities = options.capabilities ?? detectTerminalCapabilities();
    this.themeName = options.theme ?? "default";
    this.reducedMotion = options.reducedMotion ?? false;
    this.overlay = undefined;
    this.prompt =
      options.prompt ?? new PromptModel({ width: 72, maxVisualRows: 8 });
    this.activity = options.activity ?? new ActivityFeed({ clock: this.clock });
    this.writer = new ScreenWriter(this.capabilities);
  }

  get theme(): Theme {
    return effectiveTheme(this.themeName, this.capabilities);
  }

  get ui(): UiState {
    return {
      prompt: this.prompt,
      activity: this.activity,
      theme: this.theme,
      capabilities: this.capabilities,
      reducedMotion: this.reducedMotion,
      overlay: this.overlay,
      log: this.log,
      picker: this.picker,
      text: this.text,
      keys: this.keys,
      guide: this.guide,
      drawer: this.drawer,
      delight: this.delight,
    };
  }

  get frame(): Frame | undefined {
    return this.lastFrame;
  }

  /** Repaint everything on the next render (resize, theme change, ^L). */
  invalidate(): void {
    this.writer.invalidate();
    this.lastFrameAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Render a frame if the frame budget allows.  Returns the bytes written
   * (empty when throttled or nothing changed).
   */
  render(view: AppView, options: { force?: boolean } = {}): string {
    const now = this.clock();
    if (
      !options.force &&
      now - this.lastFrameAt < this.frameIntervalMs + this.backoffMs
    )
      return "";
    // A zero-size (or unknown) terminal has no cell to draw in; any write
    // would wrap. Draw again in full once it has one.
    const columns = Math.floor(this.io.columns() || 0);
    const rows = Math.floor(this.io.rows() || 0);
    if (columns < 1 || rows < 1) {
      this.writer.invalidate();
      return "";
    }
    this.lastFrameAt = now;
    this.watchFirstLoop(view, now);
    const started = performance.now();
    const frame = composeFrame(
      view,
      this.ui,
      { width: columns, height: rows },
      now,
    );
    this.lastFrame = frame;
    const out = this.writer.frame(frame.buffer, frame.cursor);
    this.lastRenderMs = performance.now() - started;
    if (out) {
      const accepted = this.io.write(out);
      this.backoffMs =
        accepted === false
          ? Math.min(
              MAX_BACKOFF_MS,
              Math.max(this.frameIntervalMs, this.backoffMs * 2),
            )
          : 0;
    }
    return out;
  }

  /**
   * The first wrap of a song that never wrapped before: a one-shot sweep
   * and the card `↻ first loop`. The card shows with motion off too (it is
   * information); the sweep does not.
   */
  private watchFirstLoop(view: AppView, now: number): void {
    const score = view.score;
    const wrapped = this.delight.observe(
      {
        playing: score.playing === true,
        beat: view.beat ?? resolveBeat(score, now),
        loopBeats: score.loopBeats,
        empty:
          score.notes.length === 0 &&
          (score.clips ?? []).length === 0 &&
          !(score.layers ?? []).some((layer) => layer.notes.length > 0),
      },
      now,
    );
    if (!wrapped) return;
    this.activity.pushCard(FIRST_LOOP_CARD, { tone: "info", once: true });
    this.onFirstLoop?.();
  }

  /** Decode one key sequence (from TerminalInputDecoder) into an input. */
  input(value: string | { type: "paste"; text: string }): AppInput {
    if (typeof value !== "string")
      return {
        type: "action",
        action: this.prompt.handle({ type: "paste", text: value.text }),
      };
    const key = classifyKey(value);
    if (this.overlay === "picker" && this.picker) {
      const picker = this.picker;
      const nav = overlayKey(value);
      if (nav === "up" || nav === "down" || nav === "pgup" || nav === "pgdn") {
        const step =
          nav === "up" ? -1 : nav === "down" ? 1 : nav === "pgup" ? -8 : 8;
        // Moving ends typing into the filter; the filter itself stays.
        picker.filtering = false;
        picker.index = Math.max(
          0,
          Math.min(picker.items.length - 1, picker.index + step),
        );
        return this.pickerMoved(picker);
      }
      if (nav === "home" || nav === "end") {
        picker.index = nav === "home" ? 0 : picker.items.length - 1;
        return this.pickerMoved(picker);
      }
      if (nav === "enter") {
        const item = picker.items[picker.index];
        this.closePicker();
        return item
          ? { type: "pick", picker: picker.id, value: item.value }
          : { type: "pick-cancel", picker: picker.id };
      }
      if (key.type === "ui" && key.command === "close-overlay") {
        // Esc clears the filter first, then closes.
        if (picker.query || picker.filtering) {
          this.filterPicker("");
          if (this.picker) this.picker.filtering = false;
          return { type: "overlay" };
        }
        this.closePicker();
        return { type: "pick-cancel", picker: picker.id };
      }
      if (picker.filterable && picker.filtering) {
        if (value === "\u007f" || value === "\b") {
          const query = (picker.query ?? "").slice(0, -1);
          this.filterPicker(query);
          if (!query && this.picker) this.picker.filtering = false;
          return { type: "overlay" };
        }
        if (key.type === "text") {
          this.filterPicker(((picker.query ?? "") + key.text).slice(0, 40));
          return { type: "overlay" };
        }
      }
      if (picker.audition && !picker.filtering) {
        const audition =
          value === " "
            ? "loop"
            : value === "a"
              ? "ab"
              : value === "c"
                ? "context"
                : undefined;
        if (audition)
          return { type: "pick-audition", picker: picker.id, key: audition };
      }
      if (picker.filterable && key.type === "text" && key.text === "/") {
        picker.filtering = true;
        return { type: "overlay" };
      }
      if (key.type === "text" && (key.text === "j" || key.text === "k")) {
        const step = key.text === "k" ? -1 : 1;
        picker.index = Math.max(
          0,
          Math.min(picker.items.length - 1, picker.index + step),
        );
        return this.pickerMoved(picker);
      }
      // Quit and redraw still work; everything else is swallowed.
      if (
        key.type === "ui" &&
        (key.command === "quit" || key.command === "redraw")
      ) {
        if (key.command === "redraw") this.invalidate();
        return { type: "ui", command: key.command };
      }
      return { type: "overlay" };
    }
    if (this.overlay === "guide" && this.guide) {
      if (
        key.type === "ui" &&
        (key.command === "quit" || key.command === "redraw")
      ) {
        if (key.command === "redraw") this.invalidate();
        return { type: "ui", command: key.command };
      }
      const result = this.guide.key(value, Math.max(1, this.io.rows() - 10));
      if (result === "close") this.closeGuide();
      return { type: "overlay" };
    }
    if (this.overlay === "text" && this.text) {
      const nav = overlayKey(value);
      const page = this.overlayRows();
      if (nav && nav !== "enter") {
        const step =
          nav === "down"
            ? 1
            : nav === "up"
              ? -1
              : nav === "pgdn"
                ? page
                : nav === "pgup"
                  ? -page
                  : 0;
        // Clamp to the last full page, the same bound paintText uses, so
        // End then ↑ moves the view on the first press.
        const max = Math.max(0, this.text.lines.length - page);
        const from = Math.min(max, this.text.scroll);
        const next =
          nav === "home"
            ? 0
            : nav === "end"
              ? max
              : Math.max(0, Math.min(max, from + step));
        // At the last page the panel pins to the end: a resize keeps the
        // last line in view (paintText clamps Infinity to the new bound).
        this.text.scroll = max > 0 && next === max ? Infinity : next;
        return { type: "overlay" };
      }
    }
    if (this.overlay === "log") {
      const nav = overlayKey(value);
      const page = this.overlayRows();
      if (nav && nav !== "enter") {
        const step =
          nav === "up"
            ? 1
            : nav === "down"
              ? -1
              : nav === "pgup"
                ? page
                : nav === "pgdn"
                  ? -page
                  : 0;
        const total = logEntriesFor(
          this.activity.transcript,
          this.log.filter,
        ).length;
        // Scroll counts rows up from the newest; paintOverlay's bound.
        const max = Math.max(0, total - page);
        const from = Math.min(max, this.log.scroll);
        this.log.scroll =
          nav === "home"
            ? max
            : nav === "end"
              ? 0
              : Math.max(0, Math.min(max, from + step));
        return { type: "overlay" };
      }
      if (key.type === "text" && key.text === "/") {
        const next =
          LOG_FILTERS[
            (LOG_FILTERS.indexOf(this.log.filter) + 1) % LOG_FILTERS.length
          ]!;
        this.log = { scroll: 0, filter: next };
        return { type: "overlay" };
      }
    }
    switch (key.type) {
      case "ui":
        if (key.command === "toggle-log") {
          this.overlay = this.overlay === "log" ? undefined : "log";
          if (this.overlay === "log") this.log = { ...this.log, scroll: 0 };
          return { type: "ui", command: key.command };
        }
        if (key.command === "close-overlay") {
          if (this.overlay) {
            this.overlay = undefined;
            return { type: "ui", command: key.command };
          }
          return { type: "action", action: this.prompt.handle("ESC") };
        }
        if (key.command === "redraw") this.invalidate();
        return { type: "ui", command: key.command };
      case "prompt": {
        const action = this.prompt.handle(key.key);
        // Submitting from under a text panel closes it so the receipt shows.
        if (action.kind === "submit" && this.overlay === "text")
          this.closeText();
        return { type: "action", action };
      }
      case "text": {
        let action: PromptAction = {
          kind: "noop",
          state: this.prompt.snapshot,
        };
        for (const character of Array.from(key.text))
          action = this.prompt.handle(character);
        return { type: "action", action };
      }
      default:
        return { type: "none" };
    }
  }

  /** Show an arrow-key picker over the highway; replaces any overlay. */
  /** `pick-move` for the row now highlighted, or a plain overlay input. */
  private pickerMoved(picker: PickerState): AppInput {
    const item = picker.items[picker.index];
    return item
      ? { type: "pick-move", picker: picker.id, value: item.value }
      : { type: "overlay" };
  }

  openPicker(picker: Omit<PickerState, "index"> & { index?: number }): void {
    const items = picker.items.slice(0, MAX_PICKER_ITEMS);
    if (items.length === 0) return;
    this.picker = {
      ...picker,
      items,
      index: Math.max(0, Math.min(items.length - 1, picker.index ?? 0)),
    };
    this.overlay = "picker";
  }

  /** Narrow a filterable picker to rows matching `query`. */
  private filterPicker(query: string): void {
    const picker = this.picker;
    if (!picker) return;
    const all = picker.all ?? picker.items;
    const needle = query.toLowerCase();
    const items = all.filter(
      (item) =>
        !needle ||
        item.label.toLowerCase().includes(needle) ||
        (item.detail ?? "").toLowerCase().includes(needle),
    );
    const keep = picker.items[picker.index]?.value;
    const index = Math.max(
      0,
      items.findIndex((item) => item.value === keep),
    );
    this.picker = { ...picker, all, query, items, index };
  }

  closePicker(): void {
    this.picker = undefined;
    if (this.overlay === "picker") this.overlay = undefined;
  }

  /**
   * Rows of text a panel over the highway shows (its height less the two
   * borders), as last rendered; a guess from the terminal height before the
   * first frame.
   */
  private overlayRows(): number {
    const highway = this.lastFrame?.layout.highway.height;
    return Math.max(
      1,
      highway !== undefined && highway > 2 ? highway - 2 : this.io.rows() - 10,
    );
  }

  /** Show static lines over the highway (`/help`, lists); replaces any overlay. */
  openText(
    title: string,
    lines: readonly string[],
    marks?: readonly (DocMark | undefined)[],
  ): void {
    this.text = {
      title,
      lines: lines.slice(0, 512),
      scroll: 0,
      ...(marks ? { marks: marks.slice(0, 512) } : {}),
    };
    this.overlay = "text";
  }

  /** The `?` panel over the current screen; any key closes it. */
  keys: TextView | undefined;
  showKeys(title: string, lines: readonly string[]): void {
    // Every list on the ? panel is keys: the guides' `⌃` mark.
    const marks = lines.map((line) =>
      line.startsWith("── ") ? SECTION_MARKS.Keys : undefined,
    );
    this.keys = { title, lines, scroll: 0, marks };
  }

  closeKeys(): void {
    this.keys = undefined;
  }

  /** True while a picker's `/` filter is taking typed text. */
  get pickerTyping(): boolean {
    return this.overlay === "picker" && this.picker?.filtering === true;
  }

  /** The `/guide` pane; built on first use from `guides/*.md`. */
  guide: GuideBrowser | undefined;

  /**
   * Open the guides at the tree, or at one guide (`chords`). Returns false
   * (and opens nothing) when `topic` names no guide.
   */
  openGuide(topic?: string): boolean {
    const browser = this.guide ?? new GuideBrowser(listGuides());
    if (topic && !browser.open(topic)) return false;
    if (!topic) {
      browser.page = undefined;
      browser.query = "";
      browser.filtering = false;
    }
    this.guide = browser;
    this.overlay = "guide";
    return true;
  }

  closeGuide(): void {
    if (this.overlay === "guide") this.overlay = undefined;
  }

  /** True while the guide filter takes typed text (so `?` is a letter). */
  get guideTyping(): boolean {
    return this.overlay === "guide" && this.guide?.typing === true;
  }

  closeText(): void {
    this.text = undefined;
    if (this.overlay === "text") this.overlay = undefined;
  }

  /**
   * Handle TUI-local slash commands (`/log`, `/theme`, `/motion`, `/guide`).
   * Returns a receipt (a structured one for a refusal), or undefined when
   * the command is not a UI command.
   */
  command(text: string): string | Receipt | undefined {
    const command = text.trim();
    if (/^\/(log|transcript)$/i.test(command)) {
      this.overlay = this.overlay === "log" ? undefined : "log";
      if (this.overlay === "log") this.log = { ...this.log, scroll: 0 };
      return this.overlay
        ? "transcript open · esc closes"
        : "transcript closed";
    }
    const theme = command.match(/^\/theme(?:\s+(\S+))?$/i);
    if (theme) {
      if (!theme[1])
        return `theme ${this.themeName} · ${THEME_NAMES.join(" | ")}`;
      const name = parseThemeName(theme[1]);
      if (!name) return `unknown theme · ${THEME_NAMES.join(" | ")}`;
      this.themeName = name;
      this.invalidate();
      return this.capabilities.colorDepth === "none" && name !== "mono"
        ? `theme ${name} · terminal has no color, showing mono`
        : `theme ${name}`;
    }
    const guide = command.match(/^\/guides?(?:\s+(.+))?$/i);
    if (guide) {
      const topic = guide[1]?.trim();
      if (!this.openGuide(topic))
        return fail(
          topicMiss(
            topic!,
            (this.guide?.guides ?? listGuides()).map((g) => g.id),
          ),
        );
      return topic
        ? `guide · ${this.guide?.guides.find((g) => g.id === this.guide?.page)?.title ?? topic} · esc back`
        : "guides · → open · esc closes";
    }
    const view = command.match(/^\/view(?:\s+(\S+))?$/i);
    if (view) {
      const value = view[1]?.toLowerCase();
      if (value === undefined)
        this.highwayView = this.highwayView === "all" ? "focus" : "all";
      else if (value === "all" || value === "focus") this.highwayView = value;
      else return "view · /view focus | all";
      return this.highwayView === "all"
        ? "view all · every unmuted track, focused track on top"
        : "view focus · focused track only";
    }
    const motion = command.match(/^\/motion(?:\s+(on|off))?$/i);
    if (motion) {
      if (motion[1]) this.reducedMotion = motion[1].toLowerCase() === "off";
      else this.reducedMotion = !this.reducedMotion;
      return `motion ${this.reducedMotion ? "off" : "on"}`;
    }
    return undefined;
  }
}

/** Plain text of a frame (for tests and the non-interactive demo). */
export function frameText(frame: Frame): string {
  return frame.buffer
    .lines()
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}
