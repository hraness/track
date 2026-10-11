/**
 * Subagent dispatch: the `dispatch` tool runs up to four child agent turns in
 * parallel, each confined to its own write scope (tracks, optional bars,
 * extra file globs, song-level settings for at most one task).
 *
 * - Scopes are validated before anything runs: the same track in two tasks,
 *   a `.dawg/` glob or two `global` tasks is a tool error naming both.
 * - Every child commit goes through `scopedHost`, which refuses operations
 *   outside the scope, then commits under one per-dispatch `CommitQueue`. A
 *   commit whose base revision went stale (a sibling landed first) is
 *   replayed onto the latest score with `rebaseOperations`; only a failed
 *   replay is a conflict, reported back to the child and in its result.
 * - Children run through the parent's own provider loop (`ChildTurnRunner`)
 *   with a small budget, the parent's abort signal (Esc cancels all) and an
 *   overall wall clock; their usage feeds the parent's spend line.
 */
import { barAt } from "../../core/tempo.ts";
import type { ScoreOperation, TrackScore } from "../../core/score.ts";
import { newId } from "../../core/ids.ts";
import { turnRow } from "../history/agent-rows.ts";
import { rebaseOperations } from "../session/rebase.ts";
import {
  StaleRevisionError,
  type AgentBudget,
  type AgentCommit,
  type AgentEvent,
  type AgentHost,
  type AgentTurnResult,
} from "./agent.ts";
import { trackSlug } from "../../core/slug.ts";
export { globMatch } from "./workspace.ts";
import {
  SUBAGENT_LIMITS,
  SubagentScopeError,
  type SubagentTask,
} from "./subagent-tasks.ts";
export {
  parseBars,
  parseTasks,
  SUBAGENT_LIMITS,
  SubagentScopeError,
  type SubagentTask,
} from "./subagent-tasks.ts";

export const CHILD_BUDGET: AgentBudget = Object.freeze({
  maxSteps: 6,
  maxToolCalls: 16,
  timeoutMs: 60_000,
});

/** Tools a child never gets: no transport, no nested dispatch, no trusted exec. */
export const CHILD_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "dispatch",
  "transport",
  "play",
  "pause",
  "exec",
]);

export type WriteScope = Readonly<{
  trackIds: ReadonlySet<string>;
  /** True when the task may add tracks (always; added tracks become owned). */
  newTracks: boolean;
  /** 1-based inclusive bar range limiting note edits. */
  bars?: readonly [number, number];
  /** Project-relative writable globs (`tracks/<slug>/**` of owned tracks + `files`). */
  fileGlobs: readonly string[];
  global: boolean;
}>;

export type SubagentStatus =
  "done" | "conflict" | "error" | "canceled" | "budget";

export type SubagentResult = Readonly<{
  id: string;
  status: SubagentStatus;
  revisions: readonly number[];
  summary: string;
  spend: string;
}>;

/** One child turn on the parent's provider path. */
export type ChildTurnRunner = (input: {
  prompt: string;
  host: AgentHost;
  budget: AgentBudget;
  /** Allow list of tool names. */
  tools: readonly string[];
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  model?: string;
  /** The child turn's pre-assigned history id. */
  turnId?: string;
}) => Promise<AgentTurnResult>;

/** Token and dollar totals; the parent's meter prices usage events itself. */
export class SpendMeter {
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  add(usage: { inputTokens: number; outputTokens: number; costUsd?: number }) {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.costUsd += usage.costUsd ?? 0;
  }
  line(): string {
    const tokens = `${formatTokens(this.inputTokens)} in · ${formatTokens(this.outputTokens)} out`;
    return this.costUsd > 0
      ? `${tokens} · $${this.costUsd.toFixed(4)}`
      : tokens;
  }
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** A promise mutex: one commit at a time across all children. */
export class CommitQueue {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export type SubagentParent = Readonly<{
  host: AgentHost;
  runTurn: ChildTurnRunner;
  /** Every tool name the parent has; children get these minus the denied ones. */
  toolNames: readonly string[];
  concurrency: number;
  signal: AbortSignal;
  spend: SpendMeter;
  callId: string;
  /** The parent turn's history id: child turn rows point at it. */
  turnId?: string;
  model?: string;
  /** Usage and progress from children, forwarded to the parent's event sink. */
  onEvent?: (event: AgentEvent) => void;
  /** Overrides SUBAGENT_LIMITS.wallClockMs (tests). */
  wallClockMs?: number;
}>;

/** Resolve a track reference by id, then by case-insensitive name. */
export function resolveTrack(score: TrackScore, ref: string): string {
  const exact = score.tracks.find((track) => track.id === ref);
  if (exact) return exact.id;
  const lower = ref.trim().toLowerCase();
  const named = score.tracks.filter(
    (track) => track.name.trim().toLowerCase() === lower,
  );
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1)
    throw new SubagentScopeError(`track name ${ref} is ambiguous; use its id`);
  throw new SubagentScopeError(`no track ${ref.slice(0, 40)}`);
}

function badGlob(glob: string): string | undefined {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(normalized))
    return "must stay under the project";
  const first = normalized.split("/")[0]!.toLowerCase();
  if (first === ".dawg" || first === ".git" || first === "node_modules")
    return `${first}/ is never writable`;
  if (first.startsWith("*") && normalized.startsWith("*"))
    return "must start with a directory or file name, not a wildcard";
  return undefined;
}

/**
 * Validate every task against the score and each other, before anything
 * runs: tracks resolve, scopes are pairwise disjoint, globs stay out of
 * `.dawg/`, at most one task is `global`.
 */
export function buildScopes(
  tasks: readonly SubagentTask[],
  score: TrackScore,
): Map<string, WriteScope> {
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  const scopes = new Map<string, WriteScope>();
  let globalTask: string | undefined;
  for (const task of tasks) {
    if (ids.has(task.id))
      throw new SubagentScopeError(`two tasks are named ${task.id}`);
    ids.add(task.id);
    const trackIds = new Set<string>();
    for (const ref of task.tracks) {
      const id = resolveTrack(score, ref);
      const other = owner.get(id);
      if (other && other !== task.id)
        throw new SubagentScopeError(
          `tasks ${other} and ${task.id} both write track ${trackName(score, id)}; give each track to one task`,
        );
      owner.set(id, task.id);
      trackIds.add(id);
    }
    for (const glob of task.files ?? []) {
      const problem = badGlob(glob);
      if (problem)
        throw new SubagentScopeError(
          `task ${task.id}: files ${glob} ${problem}`,
        );
    }
    if (task.global) {
      if (globalTask)
        throw new SubagentScopeError(
          `tasks ${globalTask} and ${task.id} are both global; at most one task may change song-level settings`,
        );
      globalTask = task.id;
    }
    const fileGlobs = [
      ...[...trackIds].map(
        (id) => `tracks/${trackSlug(trackName(score, id))}/**`,
      ),
      ...(task.files ?? []),
      ...(task.global ? ["song.ts"] : []),
    ];
    scopes.set(task.id, {
      trackIds,
      newTracks: true,
      ...(task.bars ? { bars: task.bars } : {}),
      fileGlobs,
      global: task.global === true,
    });
  }
  // Explicit file globs must not overlap across tasks either.
  const globOwner = new Map<string, string>();
  for (const [id, scope] of scopes)
    for (const glob of scope.fileGlobs) {
      const other = globOwner.get(glob);
      if (other && other !== id)
        throw new SubagentScopeError(
          `tasks ${other} and ${id} both write ${glob}; give each file to one task`,
        );
      globOwner.set(glob, id);
    }
  return scopes;
}

function trackName(score: TrackScore, id: string): string {
  return score.tracks.find((track) => track.id === id)?.name ?? id;
}

/** Operations that change song-level settings. */
const SONG_LEVEL: ReadonlySet<ScoreOperation["type"]> = new Set([
  "setTempo",
  "setBars",
  "setKey",
  "setMeter",
  "setTime",
  "setTuning",
  "setMaster",
  "setCalibration",
  "setStyle",
  "setSections",
  "setLoop",
  "moveTrack",
] as ScoreOperation["type"][]);

function opTrackId(
  operation: ScoreOperation,
  score: TrackScore,
): string | undefined {
  switch (operation.type) {
    case "addNote":
      return operation.note.trackId;
    case "removeNote":
    case "updateNote":
      return score.notes.find((note) => note.id === operation.noteId)?.trackId;
    case "updateTrack":
    case "setAutomation":
    case "clearTrack":
    case "removeTrack":
    case "setClips":
      return operation.trackId;
    case "setPatch":
    case "setPatchNode":
    case "setPatchCable":
    case "setPatchMacro":
      return "trackId" in operation.target
        ? operation.target.trackId
        : undefined;
    default:
      return undefined;
  }
}

function noteBar(score: TrackScore, startTick: number): number {
  return barAt(score, Math.max(0, Math.round(startTick))).bar + 1;
}

/**
 * The first operation outside `scope`, as a sentence naming it, or
 * undefined when every operation is allowed. `owned` collects tracks the
 * operations themselves add (they become part of the scope).
 */
export function checkScope(
  operations: readonly ScoreOperation[],
  scope: WriteScope,
  score: TrackScore,
  owned: Set<string>,
): string | undefined {
  const mine = (id: string | undefined) =>
    id !== undefined && (scope.trackIds.has(id) || owned.has(id));
  for (const operation of operations) {
    if (operation.type === "addTrack") {
      if (!scope.newTracks) return "addTrack is outside this task's scope";
      if (typeof operation.track.id === "string") owned.add(operation.track.id);
      continue;
    }
    if (SONG_LEVEL.has(operation.type)) {
      if (!scope.global)
        return `${operation.type} changes the whole song; only a global task may`;
      continue;
    }
    if (
      operation.type === "setPatch" ||
      operation.type === "setPatchNode" ||
      operation.type === "setPatchCable" ||
      operation.type === "setPatchMacro"
    ) {
      if ("library" in operation.target) {
        if (!scope.global)
          return `${operation.type} on library patch ${operation.target.library}; only a global task may`;
        continue;
      }
    }
    const trackId = opTrackId(operation, score);
    if (!mine(trackId))
      return `${operation.type} on track ${trackId ? trackName(score, trackId) : "?"} is outside this task's tracks`;
    if (scope.bars && !owned.has(trackId!)) {
      const [from, to] = scope.bars;
      const ticks: number[] = [];
      if (operation.type === "addNote") {
        const note = operation.note;
        ticks.push(
          note.startTick ?? Math.round((note.start ?? 0) * score.ticksPerBeat),
        );
      } else if (
        operation.type === "updateNote" ||
        operation.type === "removeNote"
      ) {
        const current = score.notes.find(
          (note) => note.id === operation.noteId,
        );
        if (current) ticks.push(current.startTick);
        if (
          operation.type === "updateNote" &&
          operation.patch.startTick !== undefined
        )
          ticks.push(operation.patch.startTick);
      } else if (operation.type === "clearTrack") {
        return `clearTrack reaches outside bars ${from}-${to}`;
      }
      for (const tick of ticks) {
        const bar = noteBar(score, tick);
        if (bar < from || bar > to)
          return `${operation.type} at bar ${bar} is outside bars ${from}-${to}`;
      }
    }
  }
  return undefined;
}

const MAX_BASE_SNAPSHOTS = 32;

/**
 * A host for one child: the parent's snapshot, commits checked against the
 * scope and serialized through `queue`, workspace writes confined to the
 * scope's globs. Rejected commits record a conflict on `state`.
 */
export function scopedHost(
  host: AgentHost,
  scope: WriteScope,
  label: string,
  queue: CommitQueue,
  state: { revisions: number[]; conflict?: string; parentCallId?: string } = {
    revisions: [],
  },
): AgentHost {
  // Scores seen by the child, by revision, so a stale commit can be rebased.
  const bases = new Map<number, TrackScore>();
  const owned = new Set<string>();
  const remember = (revision: number, score: TrackScore) => {
    bases.set(revision, score);
    if (bases.size > MAX_BASE_SNAPSHOTS)
      bases.delete(bases.keys().next().value as number);
  };
  const scopedWorkspaceWrite = host.onWorkspaceWrite;
  return {
    subagentId: label,
    ...(host.history ? { history: host.history } : {}),
    snapshot() {
      const snapshot = host.snapshot();
      remember(snapshot.revision, snapshot.score);
      const focus = [...scope.trackIds][0];
      return focus ? { ...snapshot, focusedTrackId: focus } : snapshot;
    },
    async commit(change: AgentCommit) {
      const base = bases.get(change.baseRevision) ?? host.snapshot().score;
      const outside = checkScope(change.operations, scope, base, owned);
      if (outside) throw new SubagentScopeError(`[${label}] ${outside}`);
      return queue.run(async () => {
        const current = host.snapshot();
        let next = change.next;
        if (current.revision !== change.baseRevision) {
          const replay = rebaseOperations(
            base,
            current.score,
            change.operations,
          );
          if (!replay.ok) {
            state.conflict = replay.reason;
            throw new StaleRevisionError(change.baseRevision, current.revision);
          }
          next = replay.next;
        }
        const committed = await host.commit({
          ...change,
          next,
          baseRevision: current.revision,
          summary: `[${label}] ${change.summary}`,
          subagent: label,
          ...(state.parentCallId ? { parentCallId: state.parentCallId } : {}),
        });
        state.revisions.push(committed.revision);
        return committed;
      });
    },
    ...(host.workspace
      ? {
          workspace: {
            ...host.workspace,
            writeGlobs: scope.fileGlobs,
          },
        }
      : {}),
    ...(scopedWorkspaceWrite
      ? { onWorkspaceWrite: (path: string) => scopedWorkspaceWrite(path) }
      : {}),
    ...(host.web ? { web: host.web } : {}),
    ...(host.media ? { media: host.media } : {}),
    ...(host.packs ? { packs: host.packs } : {}),
  };
}

function statusFor(
  result: AgentTurnResult | undefined,
  state: { conflict?: string },
  canceled: boolean,
): SubagentStatus {
  if (canceled) return "canceled";
  if (state.conflict) return "conflict";
  if (!result) return "error";
  if (result.type === "done")
    return result.reason === "stop" ? "done" : "budget";
  if (result.code === "aborted" || result.code === "timeout")
    return result.code === "timeout" ? "budget" : "canceled";
  if (result.code === "budget") return "budget";
  return "error";
}

function resultSummary(
  result: AgentTurnResult | undefined,
  state: { conflict?: string },
  fallback: string,
): string {
  const text = state.conflict
    ? `conflict: ${state.conflict}`
    : result?.type === "done"
      ? result.text || `${result.applied} change(s)`
      : result?.type === "error"
        ? result.message
        : fallback;
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUBAGENT_LIMITS.maxSummaryChars);
}

/** Run validated tasks with bounded concurrency; one result per task, in order. */
export async function runSubagents(
  tasks: readonly SubagentTask[],
  parent: SubagentParent,
): Promise<SubagentResult[]> {
  const scopes = buildScopes(tasks, parent.host.snapshot().score);
  const queue = new CommitQueue();
  const tools = parent.toolNames.filter(
    (name) => !CHILD_DENIED_TOOLS.has(name),
  );
  const wall = new AbortController();
  const timer = setTimeout(
    () => wall.abort(new Error("dispatch wall clock")),
    parent.wallClockMs ?? SUBAGENT_LIMITS.wallClockMs,
  );
  const onParentAbort = () => wall.abort(parent.signal.reason);
  if (parent.signal.aborted) onParentAbort();
  else parent.signal.addEventListener("abort", onParentAbort, { once: true });
  const results: SubagentResult[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      const task = tasks[index]!;
      const spend = new SpendMeter();
      const state: {
        revisions: number[];
        conflict?: string;
        parentCallId?: string;
      } = {
        revisions: [],
        parentCallId: parent.callId,
      };
      if (wall.signal.aborted) {
        results[index] = {
          id: task.id,
          status: "canceled",
          revisions: [],
          summary: "not started",
          spend: spend.line(),
        };
        continue;
      }
      const host = scopedHost(
        parent.host,
        scopes.get(task.id)!,
        task.id,
        queue,
        state,
      );
      let result: AgentTurnResult | undefined;
      let failure = "";
      const childTurnId = newId("turn");
      let steps = 0;
      try {
        result = await parent.runTurn({
          turnId: childTurnId,
          prompt: childPrompt(
            task,
            scopes.get(task.id)!,
            parent.host.snapshot().score,
          ),
          host,
          budget: CHILD_BUDGET,
          tools,
          signal: wall.signal,
          ...(parent.model ? { model: parent.model } : {}),
          onEvent: (event) => {
            if (event.type === "usage") {
              spend.add(event);
              parent.spend.add(event);
              parent.onEvent?.(event);
            } else if (event.type === "tool-start" || event.type === "step") {
              if (event.type === "step") steps = event.step;
              const line =
                event.type === "step"
                  ? `sub:${task.id} ▸ step ${event.step}`
                  : `sub:${task.id} ▸ ${event.name}`;
              parent.onEvent?.({ type: "activity", message: line });
            }
          },
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      results[index] = {
        id: task.id,
        status: statusFor(result, state, wall.signal.aborted && !result),
        revisions: state.revisions,
        summary: resultSummary(result, state, failure || "no result"),
        spend: spend.line(),
      };
      recordChildTurn(parent, task, results[index]!, {
        id: childTurnId,
        steps,
      });
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(parent.concurrency, tasks.length)) },
        worker,
      ),
    );
  } finally {
    clearTimeout(timer);
    parent.signal.removeEventListener("abort", onParentAbort);
  }
  // A child cut off by the wall clock or Esc reports canceled.
  return results.map((result) =>
    wall.signal.aborted &&
    result.status !== "done" &&
    result.status !== "conflict"
      ? { ...result, status: "canceled" }
      : result,
  );
}

/** One `kind=turn` history row per child, linked to the parent turn. */
function recordChildTurn(
  parent: SubagentParent,
  task: SubagentTask,
  result: SubagentResult,
  turn: { id: string; steps: number },
): void {
  const history = parent.host.history;
  if (!history) return;
  try {
    const row = turnRow({
      id: turn.id,
      prompt: task.prompt,
      model: parent.model ?? "",
      steps: turn.steps,
      spend: result.spend,
      outcome: result.status,
      subagent: task.id,
      ...(parent.turnId ? { parentTurnId: parent.turnId } : {}),
    });
    void history.append(row).done.catch(() => undefined);
  } catch {
    // history is observability; never let it break a dispatch
  }
}

function childPrompt(
  task: SubagentTask,
  scope: WriteScope,
  score: TrackScore,
): string {
  const tracks = [...scope.trackIds].map(
    (id) => `${trackName(score, id)} (${id})`,
  );
  return [
    `You are subagent ${task.id}, one of several editing this song in parallel.`,
    tracks.length > 0
      ? `You may change only these tracks: ${tracks.join(", ")}; you may also add new tracks.`
      : "You may only add new tracks; leave existing tracks alone.",
    scope.bars
      ? `Limit note edits to bars ${scope.bars[0]}-${scope.bars[1]}.`
      : "",
    scope.global
      ? "You may change song-level settings (tempo, meter, form, master, tuning)."
      : "Do not change song-level settings (tempo, meter, key, form, master, tuning).",
    `Files you may write: ${scope.fileGlobs.join(" ") || "none"}.`,
    "Edits outside that scope are refused. Finish with one short sentence on what you changed.",
    "",
    task.prompt,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** One line per task for the model, plus the total spend. */
export function formatResults(
  results: readonly SubagentResult[],
  total: SpendMeter,
): string {
  const lines = results.map((result) => {
    const revs =
      result.revisions.length > 0 ? ` revs ${result.revisions.join(",")}` : "";
    return `${result.id}: ${result.status}${revs} · ${result.summary} · ${result.spend}`;
  });
  lines.push(`total spend: ${total.line()}`);
  return lines.join("\n");
}
