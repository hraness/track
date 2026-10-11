/**
 * The `dispatch` tool: plan side only. Validation of the task list happens
 * here (shape, ids, bars, globs); scope checks against the score and the
 * parallel run happen in `executeCall` through `runSubagents`, which needs
 * the host, the provider loop and the parent's abort signal.
 */
import type { AgentTool } from "./tools.ts";
import { parseTasks, SUBAGENT_LIMITS } from "./subagent-tasks.ts";

export const DISPATCH_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "dispatch",
    description:
      "Run up to 4 subagents in parallel, each on its own tracks (or new tracks) and files. Each commits its own attributed revisions; overlapping scopes are refused up front and edits outside a scope are refused. Returns one line per task: status, revisions, summary, spend.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: SUBAGENT_LIMITS.maxTasks,
          items: {
            type: "object",
            properties: {
              id: { type: "string", pattern: "^[a-z0-9-]{1,24}$" },
              prompt: {
                type: "string",
                maxLength: SUBAGENT_LIMITS.maxPromptChars,
              },
              tracks: {
                type: "array",
                items: { type: "string" },
                maxItems: SUBAGENT_LIMITS.maxTracksPerTask,
                description:
                  "Track ids/names this task may change; [] = new tracks only.",
              },
              bars: {
                type: "string",
                description: "A-B: limit note edits to these bars.",
              },
              files: {
                type: "array",
                items: { type: "string" },
                maxItems: SUBAGENT_LIMITS.maxFilesPerTask,
                description: "Extra writable project globs.",
              },
              global: {
                type: "boolean",
                description:
                  "May change song-level settings (tempo, meter, form, master, tuning); one task at most.",
              },
            },
            required: ["id", "prompt", "tracks"],
            additionalProperties: false,
          },
        },
        model: {
          type: "string",
          description: "Default: the fast model.",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    plan(args) {
      const tasks = parseTasks(args.tasks);
      const model =
        typeof args.model === "string" && args.model.trim()
          ? args.model.trim().slice(0, 120)
          : undefined;
      return {
        kind: "dispatch",
        tasks,
        ...(model ? { model } : {}),
        summary: `dispatch ${tasks.map((task) => task.id).join(", ")}`,
      };
    },
  },
] satisfies AgentTool[]);
