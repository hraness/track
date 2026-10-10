/**
 * The patch view (patcher design §7.2), as a pure painter: the node list
 * and the selected node's ports side by side, the cable matrix under them
 * (rows are outputs, columns are inputs), the compiler's warnings, the
 * four macro knobs and the gesture row.
 *
 * The caller (src/tui/patch-view.ts) builds a `PatchPaint` from the score;
 * this module only lays it out, so every size is testable without a
 * session. Colour is never the only cue (NO_COLOR, mono): the focused pane
 * title is reversed, the selected row carries `▸` (ASCII `>`), a node's
 * rate is `◆` voice / `●` global (`v` / `g`), and a cell's kind is its
 * glyph: `~` audio, `▪` control with its amount, `♪` notes (`n`), `Σ` a
 * voice sum (`S`), `✕` a cable the compiler dropped (`x`).
 *
 * Small terminals: below 10 body rows the matrix replaces the node and
 * port lists while it has focus. Large ones: the lists stop at 32 and 64
 * columns, and the matrix shows more columns and rows.
 */
import { asciiHint } from "./grammar.ts";
import type { HitMap } from "./hits.ts";
import { paintKnobStrip, type KnobIndex, type KnobSlots } from "./knobs.ts";
import type { CellBuffer } from "./screen.ts";
import { displayWidth, truncate } from "./text.ts";
import type { Style, Theme } from "./theme.ts";

export type PatchPaneId = "nodes" | "ports" | "matrix" | "knobs";

export type PaintNode = Readonly<{
  id: string;
  type: string;
  rate: "voice" | "global";
  detail: string;
  boundary: boolean;
}>;

export type PaintPort = Readonly<{
  kind: "param" | "in" | "out";
  name: string;
  /** A param's value, or the cables (`← voice.pitch`, `→ vcf.in`). */
  value: string;
}>;

export type PaintCell = Readonly<{
  kind: "audio" | "control" | "notes" | "macro" | "legal" | "none";
  /** A control cable's amount (absent: 1). */
  amount?: number | undefined;
  dropped?: boolean | undefined;
  sum?: boolean | undefined;
}>;

export type PatchPaint = Readonly<{
  /** `acid-bass (instrument · 6 nodes · 9 cables · 16 voices)`. */
  title: string;
  /** `preview` or `library acid-bass`: why the view is read-only. */
  tag?: string | undefined;
  pane: PatchPaneId;
  nodes: readonly PaintNode[];
  node: number;
  /** `tone  osc · voice`. */
  portsTitle: string;
  ports: readonly PaintPort[];
  port: number;
  rows: readonly string[];
  cols: readonly string[];
  /** `cells[row][col]`. */
  cells: readonly (readonly PaintCell[])[];
  row: number;
  col: number;
  full: boolean;
  /** The selected cell in words: `env.out → vcf.cutoff · 0.6`. */
  caption: string;
  warnings: readonly string[];
  knobs: KnobSlots;
  selected: KnobIndex;
  /** Any macro at all (else the knob row reads `m maps a param`). */
  macros: number;
  hint: string;
}>;

export type PatchPaintOptions = Readonly<{
  theme: Theme;
  unicode: boolean;
  hits?: HitMap | undefined;
}>;

/** What the painter laid out, for tests. */
export type PatchLayout = Readonly<{
  /** Lists shown (node and port panes). */
  lists: boolean;
  /** Matrix rows and columns shown, and the first of each. */
  matrixRows: number;
  matrixCols: number;
  firstRow: number;
  firstCol: number;
}>;

/** Widest the node list and the ports pane grow. */
export const PATCH_NODES_MAX = 44;
export const PATCH_PORTS_MAX = 64;
const NODES_MIN = 18;
/** Widest a matrix column and the row labels get. */
const COLUMN_MAX = 10;

/** ASCII spellings of the arrows the view's words carry. */
function asciiText(text: string): string {
  return asciiHint(
    text
      .replace(/▸/g, ">")
      .replace(/→/g, "->")
      .replace(/←/g, "<-")
      .replace(/⇄/g, "<>"),
  );
}
const LABEL_MAX = 18;

/** A cell's text (without the selection), at most `width - 1` cells. */
export function cellText(cell: PaintCell, unicode: boolean): string {
  if (cell.kind === "none") return "";
  if (cell.kind === "legal") return unicode ? "·" : ".";
  let text: string;
  if (cell.kind === "audio") text = "~";
  else if (cell.kind === "notes") text = unicode ? "♪" : "n";
  else {
    const mark = unicode ? "▪" : "#";
    const amount = cell.amount ?? 1;
    text =
      cell.kind === "macro" || amount === 1
        ? mark
        : `${mark}${amountText(amount)}`;
  }
  if (cell.sum) text += unicode ? "Σ" : "S";
  if (cell.dropped) text = `${unicode ? "✕" : "x"}${text}`;
  return text;
}

/** `.6`, `-.25`, `1`: an amount in at most four cells. */
export function amountText(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  const text = String(rounded).replace(/^(-?)0\./, "$1.");
  return text.slice(0, 4);
}

function firstVisible(selected: number, count: number, room: number): number {
  if (count <= room || room <= 0) return 0;
  return Math.max(0, Math.min(selected - room + 1, count - room, selected));
}

export function paintPatch(
  buffer: CellBuffer,
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
  view: PatchPaint,
  options: PatchPaintOptions,
): PatchLayout {
  const { theme, unicode } = options;
  const roles = theme.roles;
  const empty: PatchLayout = {
    lists: false,
    matrixRows: 0,
    matrixCols: 0,
    firstRow: 0,
    firstCol: 0,
  };
  if (rect.width < 20 || rect.height < 4) return empty;
  const bottom = rect.y + rect.height;
  const rule = unicode ? "─" : "-";
  const pointer = unicode ? "▸" : ">";
  const say = (text: string): string => (unicode ? text : asciiText(text));

  // Header: the patch, and why it is read-only.
  let y = rect.y;
  const tag = view.tag ? ` [${say(view.tag)}]` : "";
  const head = truncate(
    ` patch ${say(view.title)}`,
    rect.width - displayWidth(tag) - 1,
  );
  buffer.text(rect.x, y, head, { ...roles.text, bold: true });
  if (tag) buffer.text(rect.x + displayWidth(head), y, tag, roles.warning);
  y += 1;

  // Footer, bottom up: the hint, the knobs, the first warning.
  let footer = bottom;
  footer -= 1;
  buffer.text(
    rect.x + 1,
    footer,
    truncate(say(view.hint), rect.width - 2),
    roles.muted,
  );
  if (footer - y >= 5) {
    footer -= 1;
    if (view.macros > 0)
      paintKnobStrip(
        buffer,
        rect.x + 1,
        footer,
        rect.width - 2,
        view.knobs,
        view.selected,
        { theme, unicode },
      );
    else
      buffer.text(
        rect.x + 1,
        footer,
        truncate("no knobs yet · m on a param maps it to one", rect.width - 2),
        roles.faint,
      );
    if (view.pane === "knobs")
      buffer.text(rect.x, footer, pointer, { ...roles.text, bold: true });
  }
  if (view.warnings.length > 0 && footer - y >= 5) {
    footer -= 1;
    const count =
      view.warnings.length > 1 ? ` (+${view.warnings.length - 1} more)` : "";
    buffer.text(
      rect.x + 1,
      footer,
      truncate(
        `${unicode ? "⚠" : "!"} ${say(view.warnings[0]!)}${count}`,
        rect.width - 2,
      ),
      roles.warning,
    );
  }

  // Body: lists over the matrix, or one of them when short.
  const body = footer - y;
  if (body <= 0) return empty;
  const matrixOnly = body < 10 && view.pane === "matrix";
  const listsOnly = body < 10 && !matrixOnly;
  const listRows = listsOnly
    ? body
    : matrixOnly
      ? 0
      : Math.max(
          4,
          Math.min(
            Math.max(view.nodes.length, view.ports.length) + 1,
            Math.ceil(body * 0.45),
          ),
        );
  if (listRows > 0) paintLists(buffer, rect, y, listRows, view, options);
  y += listRows;
  if (listsOnly || y >= footer) return { ...empty, lists: true };
  if (listRows > 0) {
    buffer.text(rect.x, y, rule.repeat(rect.width), roles.border);
    y += 1;
  }
  const layout = paintMatrix(
    buffer,
    { x: rect.x, y, width: rect.width, height: footer - y },
    view,
    options,
  );
  return { ...layout, lists: listRows > 0 };
}

function paneTitle(
  buffer: CellBuffer,
  x: number,
  y: number,
  text: string,
  focused: boolean,
  theme: Theme,
  width: number,
): void {
  buffer.text(
    x,
    y,
    truncate(` ${text} `, width),
    focused
      ? { ...theme.roles.text, bold: true, reverse: true }
      : theme.roles.faint,
  );
}

function paintLists(
  buffer: CellBuffer,
  rect: Readonly<{ x: number; width: number }>,
  top: number,
  rows: number,
  view: PatchPaint,
  options: PatchPaintOptions,
): void {
  const { theme, unicode } = options;
  const roles = theme.roles;
  const nodesWidth = Math.min(
    PATCH_NODES_MAX,
    Math.max(NODES_MIN, Math.floor(rect.width * 0.38)),
  );
  const portsX = rect.x + nodesWidth + 1;
  const portsWidth = Math.min(
    PATCH_PORTS_MAX,
    rect.x + rect.width - portsX - 1,
  );
  const pointer = unicode ? "▸" : ">";
  for (let row = 0; row < rows; row += 1)
    buffer.text(
      rect.x + nodesWidth,
      top + row,
      unicode ? "│" : "|",
      roles.border,
    );

  // Nodes, in signal order.
  paneTitle(
    buffer,
    rect.x,
    top,
    "NODES",
    view.pane === "nodes",
    theme,
    nodesWidth,
  );
  const nodeRoom = rows - 1;
  const firstNode = firstVisible(view.node, view.nodes.length, nodeRoom);
  view.nodes.slice(firstNode, firstNode + nodeRoom).forEach((node, offset) => {
    const index = firstNode + offset;
    const y = top + 1 + offset;
    const selected = index === view.node;
    const rate =
      node.rate === "voice" ? (unicode ? "◆" : "v") : unicode ? "●" : "g";
    buffer.text(rect.x, y, selected ? pointer : " ", {
      ...roles.text,
      bold: true,
    });
    // Ids take what they need, up to 20 columns or half the pane.
    const longest = Math.max(...view.nodes.map((n) => displayWidth(n.id)));
    const idWidth = Math.max(
      Math.min(8, nodesWidth - 4),
      Math.min(longest, 20, Math.floor((nodesWidth - 4) / 2)),
    );
    const id = truncate(node.id, idWidth).padEnd(idWidth);
    buffer.text(
      rect.x + 1,
      y,
      id,
      selected && view.pane === "nodes"
        ? { ...roles.selected, reverse: true }
        : node.boundary
          ? roles.muted
          : roles.text,
    );
    const rest = nodesWidth - 2 - idWidth;
    if (rest >= 4) {
      buffer.text(
        rect.x + 2 + idWidth,
        y,
        rate,
        node.rate === "voice" ? roles.knob1 : roles.knob4,
      );
      const detail = node.detail ? ` ${node.detail}` : "";
      buffer.text(
        rect.x + 4 + idWidth,
        y,
        truncate(`${node.type}${detail}`, rest - 3),
        roles.faint,
      );
    }
  });

  // The selected node's params and ports.
  if (portsWidth < 10) return;
  paneTitle(
    buffer,
    portsX,
    top,
    view.portsTitle,
    view.pane === "ports",
    theme,
    portsWidth,
  );
  const portRoom = rows - 1;
  const firstPort = firstVisible(view.port, view.ports.length, portRoom);
  const nameWidth = Math.min(
    10,
    Math.max(4, ...view.ports.map((port) => displayWidth(port.name) + 1)),
  );
  view.ports.slice(firstPort, firstPort + portRoom).forEach((port, offset) => {
    const index = firstPort + offset;
    const y = top + 1 + offset;
    const selected = index === view.port;
    buffer.text(portsX, y, selected ? pointer : " ", {
      ...roles.text,
      bold: true,
    });
    const mark =
      port.kind === "in"
        ? unicode
          ? "←"
          : "<-"
        : port.kind === "out"
          ? unicode
            ? "→"
            : "->"
          : " ";
    buffer.text(
      portsX + 1,
      y,
      truncate(port.name, nameWidth).padEnd(nameWidth),
      selected && view.pane === "ports"
        ? { ...roles.selected, reverse: true }
        : port.kind === "param"
          ? roles.text
          : roles.muted,
    );
    buffer.text(
      portsX + 2 + nameWidth,
      y,
      truncate(
        port.kind === "param" ? port.value : `${mark} ${port.value || "·"}`,
        portsWidth - nameWidth - 3,
      ),
      port.kind === "param" ? roles.text : roles.faint,
    );
  });
}

function cellStyle(cell: PaintCell, theme: Theme): Style {
  const roles = theme.roles;
  if (cell.dropped) return roles.error;
  switch (cell.kind) {
    case "audio":
      return roles.knob2;
    case "control":
      return roles.knob1;
    case "notes":
      return roles.knob3;
    case "macro":
      return roles.knob4;
    default:
      return roles.faint;
  }
}

function paintMatrix(
  buffer: CellBuffer,
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
  view: PatchPaint,
  options: PatchPaintOptions,
): Omit<PatchLayout, "lists"> {
  const { theme, unicode } = options;
  const roles = theme.roles;
  const none = { matrixRows: 0, matrixCols: 0, firstRow: 0, firstCol: 0 };
  if (rect.height < 2) return none;
  const focused = view.pane === "matrix";
  const label = view.full ? "CABLES (all)" : "CABLES";
  const labelWidth = Math.min(
    LABEL_MAX,
    Math.max(
      displayWidth(label) + 2,
      ...view.rows.map((row) => displayWidth(row) + 2),
    ),
  );
  paneTitle(buffer, rect.x, rect.y, label, focused, theme, labelWidth);
  // The last row: the selected cell in words, or the legend.
  const legendRow = rect.height >= 4;
  const gridRows = rect.height - 1 - (legendRow ? 1 : 0);
  if (legendRow) {
    const legend = unicode
      ? "◆ voice ● global ~ audio ▪ control ♪ notes Σ voice sum ✕ dropped"
      : "v voice g global ~ audio # control n notes S voice sum x dropped";
    buffer.text(
      rect.x + 1,
      rect.y + rect.height - 1,
      truncate(
        (unicode ? (s: string) => s : asciiText)(
          focused && view.caption ? view.caption : legend,
        ),
        rect.width - 2,
      ),
      focused ? roles.text : roles.faint,
    );
  }
  if (view.rows.length === 0 || view.cols.length === 0) {
    buffer.text(
      rect.x + labelWidth,
      rect.y,
      truncate(
        "no cables here · w wires the selected output · f the full matrix",
        rect.width - labelWidth - 1,
      ),
      roles.faint,
    );
    return none;
  }
  // Columns: page so the selected one shows, as many as fit. A terminal
  // wide enough for every full label shows them whole.
  const room = rect.width - labelWidth;
  const whole = view.cols.map((col) => Math.max(5, displayWidth(col) + 1));
  const widths =
    whole.reduce((sum, w) => sum + w, 0) <= room
      ? whole
      : whole.map((w) => Math.min(COLUMN_MAX, w));
  let firstCol = 0;
  const fits = (from: number, to: number): boolean => {
    let used = 0;
    for (let k = from; k <= to; k += 1) used += widths[k]!;
    return used <= room;
  };
  while (firstCol < view.col && !fits(firstCol, view.col)) firstCol += 1;
  let lastCol = firstCol;
  let used = 0;
  while (lastCol < view.cols.length && used + widths[lastCol]! <= room) {
    used += widths[lastCol]!;
    lastCol += 1;
  }
  const firstRow = firstVisible(view.row, view.rows.length, gridRows);
  // Column headers, pinned.
  let x = rect.x + labelWidth;
  for (let k = firstCol; k < lastCol; k += 1) {
    const selected = focused && k === view.col;
    buffer.text(
      x,
      rect.y,
      truncate(view.cols[k]!, widths[k]! - 1),
      selected ? { ...roles.text, bold: true, reverse: true } : roles.muted,
    );
    x += widths[k]!;
  }
  // Rows, labels pinned.
  const shown = view.rows.slice(firstRow, firstRow + gridRows);
  shown.forEach((name, offset) => {
    const index = firstRow + offset;
    const y = rect.y + 1 + offset;
    const selectedRow = focused && index === view.row;
    buffer.text(rect.x, y, selectedRow ? (unicode ? "▸" : ">") : " ", {
      ...roles.text,
      bold: true,
    });
    buffer.text(
      rect.x + 1,
      y,
      truncate(name, labelWidth - 2),
      selectedRow ? { ...roles.text, bold: true, reverse: true } : roles.text,
    );
    let cx = rect.x + labelWidth;
    for (let k = firstCol; k < lastCol; k += 1) {
      const cell = view.cells[index]?.[k] ?? { kind: "none" as const };
      const text = truncate(cellText(cell, unicode), widths[k]! - 1, "");
      const selected = selectedRow && k === view.col;
      const style = cellStyle(cell, theme);
      if (selected) {
        // The cursor shows on an empty cell too: a reversed `·` or blank.
        const shownText = text || " ";
        buffer.text(
          cx,
          y,
          shownText.padEnd(Math.max(1, displayWidth(shownText))),
          {
            ...style,
            reverse: true,
            bold: true,
          },
        );
      } else if (text) buffer.text(cx, y, text, style);
      cx += widths[k]!;
    }
  });
  return {
    matrixRows: shown.length,
    matrixCols: lastCol - firstCol,
    firstRow,
    firstCol,
  };
}
