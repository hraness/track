/**
 * Dispatch task parsing, shared by the `dispatch` tool's plan and the
 * runner. Kept free of agent imports so the tool catalog can load it
 * without an import cycle.
 */

export const SUBAGENT_LIMITS = Object.freeze({
  maxTasks: 4,
  maxTracksPerTask: 8,
  maxFilesPerTask: 8,
  maxPromptChars: 2000,
  /** Concurrency for the gateway and command loops. */
  concurrency: 4,
  /** xcb children are separate `xcb generate` processes on a subscription. */
  xcbConcurrency: 2,
  /** The whole dispatch, after which unfinished children are canceled. */
  wallClockMs: 5 * 60_000,
  maxSummaryChars: 240,
});

export type SubagentTask = Readonly<{
  id: string;
  prompt: string;
  tracks: readonly string[];
  bars?: readonly [number, number];
  files?: readonly string[];
  global?: boolean;
}>;

export class SubagentScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentScopeError";
  }
}

const TASK_ID = /^[a-z0-9-]{1,24}$/;

/** `"5-8"` → [5, 8]; `"3"` → [3, 3]. Bars are 1-based and inclusive. */
export function parseBars(text: string): readonly [number, number] {
  const match = /^\s*(\d{1,4})\s*(?:-\s*(\d{1,4}))?\s*$/.exec(text);
  if (!match)
    throw new SubagentScopeError(`bars ${text.slice(0, 20)}: use A-B`);
  const from = Number(match[1]);
  const to = Number(match[2] ?? match[1]);
  if (from < 1 || to < from)
    throw new SubagentScopeError(`bars ${text}: need 1 ≤ A ≤ B`);
  return [from, to];
}

/** Parse the dispatch tool's raw `tasks` argument. */
export function parseTasks(raw: unknown): SubagentTask[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new SubagentScopeError("tasks must be a non-empty array");
  if (raw.length > SUBAGENT_LIMITS.maxTasks)
    throw new SubagentScopeError(
      `at most ${SUBAGENT_LIMITS.maxTasks} tasks per dispatch`,
    );
  return raw.map((entry, index): SubagentTask => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new SubagentScopeError(`tasks[${index}] must be an object`);
    const value = entry as Record<string, unknown>;
    const id = value.id;
    if (typeof id !== "string" || !TASK_ID.test(id))
      throw new SubagentScopeError(
        `tasks[${index}].id must match [a-z0-9-]{1,24}`,
      );
    const prompt = value.prompt;
    if (typeof prompt !== "string" || !prompt.trim())
      throw new SubagentScopeError(`task ${id}: prompt is required`);
    if (prompt.length > SUBAGENT_LIMITS.maxPromptChars)
      throw new SubagentScopeError(
        `task ${id}: prompt is longer than ${SUBAGENT_LIMITS.maxPromptChars} characters`,
      );
    const strings = (key: string, max: number): string[] => {
      const list = value[key] ?? [];
      if (
        !Array.isArray(list) ||
        list.some((item) => typeof item !== "string" || !item.trim())
      )
        throw new SubagentScopeError(`task ${id}: ${key} must be strings`);
      if (list.length > max)
        throw new SubagentScopeError(`task ${id}: at most ${max} ${key}`);
      return list as string[];
    };
    if (value.tracks === undefined)
      throw new SubagentScopeError(
        `task ${id}: tracks is required ([] = new tracks only)`,
      );
    const tracks = strings("tracks", SUBAGENT_LIMITS.maxTracksPerTask);
    const files = strings("files", SUBAGENT_LIMITS.maxFilesPerTask);
    if (value.bars !== undefined && typeof value.bars !== "string")
      throw new SubagentScopeError(
        `task ${id}: bars must be a string like 5-8`,
      );
    if (value.global !== undefined && typeof value.global !== "boolean")
      throw new SubagentScopeError(`task ${id}: global must be true or false`);
    return {
      id,
      prompt: prompt.trim(),
      tracks,
      ...(typeof value.bars === "string"
        ? { bars: parseBars(value.bars) }
        : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(value.global === true ? { global: true } : {}),
    };
  });
}
