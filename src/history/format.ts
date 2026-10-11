/**
 * One line per history row, shared by the CLI, `/comments`, the history
 * view and the agent's `history_query` tool (design §4.1):
 *
 *   #812  rev 41  12:03:11  agent     edit     bass   tightened hats
 *   #820          12:05:40  A human   comment  12.3   ✎ love this part #love
 *
 * Plain text, no colour: callers style it. `ascii` swaps `✎` for `*`.
 */
import { contextLabel } from "./context.ts";
import type { HistoryRow, TargetRef } from "./types.ts";

export type FormatOptions = Readonly<{
  ascii?: boolean;
  /** Maximum line width (default 120). */
  width?: number;
  /** Track id → display name. */
  trackName?: (id: string) => string | undefined;
  /** Local time zone; tests pass "UTC". */
  timeZone?: string;
}>;

export function commentMark(ascii = false): string {
  return ascii ? "*" : "✎";
}

function clock(at: string, timeZone?: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("en-GB", {
    hour12: false,
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
}

/** `A human`, `agent`, `sub:drums`, `external`. */
export function actorLabel(row: HistoryRow): string {
  const payload =
    typeof row.payload === "object" && row.payload !== null
      ? (row.payload as Record<string, unknown>)
      : {};
  if (row.actor.kind === "subagent" && typeof payload.subagent === "string")
    return `sub:${payload.subagent}`;
  if (row.actor.pane !== undefined)
    return `${row.actor.pane} ${row.actor.kind}`;
  return row.actor.kind;
}

/** The most useful single target: a track name, else a param, else bars. */
export function targetLabel(
  targets: readonly TargetRef[],
  trackName?: (id: string) => string | undefined,
): string {
  const track = targets.find((each) => each.type === "track");
  if (track !== undefined) return trackName?.(track.key) ?? track.key;
  const param = targets.find((each) => each.type === "param");
  if (param !== undefined) return param.key;
  const file = targets.find((each) => each.type === "file");
  if (file !== undefined) return file.key;
  const bars = targets.find((each) => each.type === "bars");
  if (bars !== undefined) return `bars ${bars.key}`;
  return "";
}

function clip(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function pad(text: string, width: number): string {
  const length = [...text].length;
  return length >= width ? text : text + " ".repeat(width - length);
}

/** The row's text: comments get the mark and their tags. */
export function rowText(row: HistoryRow, ascii = false): string {
  if (row.kind === "comment") {
    const text = row.body ?? row.summary;
    const missing = row.tags.filter((tag) => !text.includes(`#${tag}`));
    const tags =
      missing.length > 0
        ? `  ${missing.map((tag) => `#${tag}`).join(" ")}`
        : "";
    return `${commentMark(ascii)} ${text}${tags}`;
  }
  return row.summary;
}

export function formatRow(row: HistoryRow, opts: FormatOptions = {}): string {
  const width = opts.width ?? 120;
  const where =
    row.kind === "comment"
      ? contextLabel(row.context) || targetLabel(row.targets, opts.trackName)
      : targetLabel(row.targets, opts.trackName);
  const head = [
    pad(`#${row.seq}`, 6),
    pad(row.rev !== null ? `rev ${row.rev}` : "", 7),
    clock(row.at, opts.timeZone),
    pad(actorLabel(row), 9),
    pad(row.kind, 8),
    pad(clip(where, 16), 6),
  ].join("  ");
  return clip(
    `${head}  ${rowText(row, opts.ascii)}`.replace(/\s+$/, ""),
    width,
  );
}

/** A compact line for narrow panes: `#820 A ✎ love this part`. */
export function formatRowShort(
  row: HistoryRow,
  opts: FormatOptions = {},
): string {
  const width = opts.width ?? 60;
  const who =
    row.actor.pane ?? (row.actor.kind === "human" ? "you" : row.actor.kind);
  const rev = row.rev !== null ? ` r${row.rev}` : "";
  const where = row.kind === "comment" ? contextLabel(row.context) : "";
  return clip(
    `#${row.seq}${rev} ${who} ${row.kind === "comment" ? "" : `${row.kind} `}${where ? `${where} ` : ""}${rowText(row, opts.ascii)}`,
    width,
  );
}

/** Every detail of one row, for `dawg history show`. */
export function formatDetail(
  row: HistoryRow,
  opts: FormatOptions = {},
): string {
  const lines = [formatRow(row, { ...opts, width: 400 })];
  lines.push(
    `id ${row.id} · session ${row.sessionId} · at ${row.at}${row.rev !== null ? ` · rev ${row.rev}` : ` · at rev ${row.atRev}`}`,
  );
  if (row.sub !== null) lines.push(`sub ${row.sub}`);
  if (row.parentId !== null) lines.push(`about ${row.parentId}`);
  if (row.body !== undefined && row.kind !== "comment")
    lines.push(`body ${row.body}`);
  if (row.tags.length > 0)
    lines.push(`tags ${row.tags.map((tag) => `#${tag}`).join(" ")}`);
  if (row.targets.length > 0)
    lines.push(
      `targets ${row.targets.map((target) => `${target.type}:${target.key}`).join(" ")}`,
    );
  if (row.context !== undefined)
    lines.push(`context ${JSON.stringify(row.context)}`);
  if (row.ops !== undefined) lines.push(`ops ${JSON.stringify(row.ops)}`);
  if (row.payload !== undefined)
    lines.push(`payload ${JSON.stringify(row.payload)}`);
  if (row.file !== undefined) lines.push(`file .dawg/${row.file}`);
  return lines.join("\n");
}

/** One row in at most `width` columns: the full line, or the short one below 72. */
export function formatHistoryLine(
  row: HistoryRow,
  width: number,
  opts: Omit<FormatOptions, "width"> = {},
): string {
  return width >= 100
    ? formatRow(row, { ...opts, width })
    : formatRowShort(row, { ...opts, width });
}
