/**
 * The agent's `exec` tool: one allowlisted audio CLI with an argv array, no
 * shell, cwd = project (`src/media/exec.ts`, policy in `exec-policy.ts`).
 * `log` + `offset` page through a previous run's saved output instead.
 *
 * Settings seam (lane agentcore owns `src/agent/settings.ts`): until it
 * lands, `readExecSettings` reads `shell` and `readRoots` from
 * `.dawg/agent.json`, which only the human edits (the agent's write scope
 * refuses `.dawg/`).
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { EXEC_LIMITS, ExecError, readExecLog, runExec } from "../media/exec.ts";
import type { AgentTool, ToolPlan } from "./tools.ts";

export type ExecSettings = Readonly<{ shell: boolean; readRoots: readonly string[] }>;

/** `.dawg/agent.json` `{ shell, readRoots }`; anything malformed reads as off. */
export function readExecSettings(root: string): ExecSettings {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".dawg", "agent.json"), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return { shell: false, readRoots: [] };
    const record = raw as Record<string, unknown>;
    const readRoots = Array.isArray(record.readRoots)
      ? record.readRoots
          .filter((r): r is string => typeof r === "string" && r.length > 0)
          .map((r) => (isAbsolute(r) ? r : resolve(root, r)))
      : [];
    return { shell: record.shell === true, readRoots };
  } catch {
    return { shell: false, readRoots: [] };
  }
}

export const EXEC_TOOL: AgentTool = {
  name: "exec",
  description:
    "Run an audio CLI (ffmpeg ffprobe sox rubberband yt-dlp demucs basic-pitch aubio* whisper-cli; any if user enabled shell): argv array, no shell, cwd project. Returns tails; log+offset pages full output.",
  parameters: {
    type: "object",
    properties: {
      argv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: EXEC_LIMITS.maxArgs },
      timeoutSec: { type: "integer", minimum: 1, maximum: EXEC_LIMITS.maxTimeoutMs / 1000 },
      log: { type: "string" },
      offset: { type: "integer" },
    },
    additionalProperties: false,
  },
  plan: (raw) => planExec(raw),
};

function planExec(raw: Record<string, unknown>): ToolPlan {
  if (typeof raw.log === "string") {
    const logId = raw.log;
    const offset = typeof raw.offset === "number" ? raw.offset : 0;
    return {
      kind: "media",
      summary: `exec log ${logId}`.slice(0, 120),
      run: async (media) => {
        const page = readExecLog(media.projectRoot, logId, offset);
        return { summary: `exec log ${logId} @${page.offset}`, content: { ...page }, outputs: [] };
      },
    };
  }
  const argv = raw.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string"))
    throw new ExecError("exec needs argv: a non-empty array of strings (or log: <id>)");
  const timeoutMs =
    typeof raw.timeoutSec === "number" ? Math.round(raw.timeoutSec * 1000) : undefined;
  return {
    kind: "media",
    summary: `exec ${argv.slice(0, 6).join(" ")}`.slice(0, 120),
    run: async (media) => {
      const settings = readExecSettings(media.projectRoot);
      const result = await runExec(
        { argv: argv as string[], ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
        {
          root: media.projectRoot,
          trackSlug: media.trackSlug,
          runner: media.runner,
          signal: media.signal,
          progress: media.progress,
          shell: settings.shell,
          readRoots: settings.readRoots,
          actor: { kind: "agent" },
          ...(media.chopHistory ? { history: media.chopHistory } : {}),
        },
      );
      const status = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
      const { argv: ran, ...rest } = result;
      return {
        summary: `${ran[0]} · ${status} · ${result.ms} ms${result.outputs.length ? ` · ${result.outputs.length} files` : ""}`,
        content: { ...rest, ok: result.exitCode === 0 && !result.timedOut },
        outputs: result.outputs,
      };
    },
  };
}
