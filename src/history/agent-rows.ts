/**
 * The only builders for agent `tool` and `turn` history rows, shared by the
 * main turn and subagent child turns (design §2.3, §9).
 */
import { createHash } from "node:crypto";
import type { HistoryAppend } from "./types.ts";

type AgentRow = Omit<HistoryAppend, "sessionId" | "atRev">;

const MAX_SUMMARY = 200;
const MAX_PROMPT = 400;
const MAX_DEV_ARGS = 2 * 1024;

export function clip(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"<unserializable>"';
  }
}

/** A short, stable digest of tool arguments (never the arguments themselves). */
export function argsDigest(args: unknown): string {
  return createHash("sha256")
    .update(stableJson(args))
    .digest("hex")
    .slice(0, 12);
}

export function toolRow(call: {
  name: string;
  args: unknown;
  ok: boolean;
  ms: number;
  summary: string;
  turnId: string;
  subagent?: string;
  dev?: boolean;
}): AgentRow {
  const payload: Record<string, unknown> = {
    name: call.name,
    ok: call.ok,
    ms: Math.max(0, Math.round(call.ms)),
    args: argsDigest(call.args),
    turnId: call.turnId,
  };
  if (call.subagent !== undefined) payload.subagent = call.subagent;
  if (call.dev === true) {
    const json = stableJson(call.args);
    payload.argsJson =
      json.length <= MAX_DEV_ARGS ? json : `${json.slice(0, MAX_DEV_ARGS)}…`;
  }
  const result = clip(call.summary, MAX_SUMMARY - call.name.length - 8);
  return {
    kind: "tool",
    sub: call.ok ? "ok" : "error",
    actor: { kind: call.subagent === undefined ? "agent" : "subagent" },
    summary: clip(`${call.name}${call.ok ? "" : " ✗"}: ${result}`, MAX_SUMMARY),
    payload,
  };
}

export function turnRow(turn: {
  id: string;
  prompt: string;
  model: string;
  steps: number;
  spend: string;
  outcome: string;
  parentTurnId?: string;
  subagent?: string;
}): AgentRow {
  const payload: Record<string, unknown> = {
    prompt: clip(turn.prompt, MAX_PROMPT),
    model: turn.model,
    steps: turn.steps,
    spend: turn.spend,
    outcome: turn.outcome,
  };
  if (turn.subagent !== undefined) payload.subagent = turn.subagent;
  const head = turn.subagent === undefined ? "turn" : `sub:${turn.subagent}`;
  return {
    id: turn.id,
    kind: "turn",
    sub: turn.outcome,
    ...(turn.parentTurnId === undefined ? {} : { parentId: turn.parentTurnId }),
    actor: { kind: turn.subagent === undefined ? "agent" : "subagent" },
    summary: clip(
      `${head} · ${turn.outcome} · ${turn.steps} steps · ${turn.spend} · ${turn.prompt}`,
      MAX_SUMMARY,
    ),
    body: clip(turn.prompt, MAX_PROMPT),
    payload,
  };
}
