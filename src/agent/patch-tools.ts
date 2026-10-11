/**
 * `patch_edit` (patcher design §6.1, lane 5): the agent's door to a track's
 * patch. Each op is one `patch …` line, so the receipts and the transcript
 * read as the commands a person would type; the batch applies in order as
 * one revision, and the first bad op rejects all of them and is named. The
 * score change is sent as node, cable and macro operations (core/diff.ts),
 * never a whole-patch write over an existing patch.
 */
import { diffScores } from "../../core/diff.ts";
import { NODE_SPECS, NODE_TYPES } from "../../core/patch-nodes.ts";
import { builtinPatch } from "../../core/patches/index.ts";
import { SCORE_LIMITS } from "../../core/score.ts";
import {
  applyPatchBatch,
  locatePatch,
  patchRecipe,
  printPatchValue,
  type PatchParams,
} from "../commands/patch.ts";
import type { AgentOperation } from "./ops.ts";
import type { AgentTool, ToolContext } from "./tools.ts";

class PatchToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

export const PATCH_TOOL_OPS = [
  "new",
  "add",
  "set",
  "wire",
  "unwire",
  "macro",
  "knob",
  "rate",
  "rm",
  "convert",
  "detach",
  "load",
  "save",
] as const;

const MAX_OPS = 64;

/** The enum params' values, for the schema description. */
const ENUM_HINTS = Object.values(NODE_SPECS)
  .flatMap((spec) =>
    Object.entries(spec.params)
      .filter(([, param]) => param.kind === "enum")
      .map(([name, param]) =>
        param.kind === "enum"
          ? `${spec.type}.${name}: ${param.values.join("|")}`
          : "",
      ),
  )
  .filter((hint) => hint.length > 0 && hint.length < 60)
  .slice(0, 12)
  .join("; ");

const word = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 120)
    throw new PatchToolError(`${what} must be a short string`);
  if (/\s/.test(value)) throw new PatchToolError(`${what} has no spaces`);
  return value;
};

const quoted = (text: unknown, what: string): string => {
  if (typeof text !== "string" || text.length > 60)
    throw new PatchToolError(
      `${what} must be a string of at most 60 characters`,
    );
  return JSON.stringify(text);
};

function params(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new PatchToolError("params must be an object of name: value");
  return Object.entries(value as PatchParams)
    .map(([key, v]) => {
      if (!/^[a-z][a-z0-9]*$/i.test(key))
        throw new PatchToolError(`param name ${key} is a word`);
      return ` ${key}=${printPatchValue(v)}`;
    })
    .join("");
}

const num = (value: unknown, what: string): string => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new PatchToolError(`${what} must be a number`);
  return String(value);
};

/** One op as the `patch …` line it stands for. */
export function patchOpLine(op: Record<string, unknown>, fx?: string): string {
  const tail = fx === undefined ? "" : ` --fx ${fx}`;
  const label =
    op.label === undefined ? "" : ` label ${quoted(op.label, "label")}`;
  switch (op.op) {
    case "new":
      return `patch new ${word(op.name, "name")}${op.role === "effect" || op.role === "instrument" ? ` ${op.role}` : ""}${op.from !== undefined ? ` from ${word(op.from, "from")}` : ""}${op.voices !== undefined ? ` voices=${num(op.voices, "voices")}` : ""}${tail}`;
    case "add":
      return `patch add ${word(op.type, "type")}${op.id !== undefined ? ` as ${word(op.id, "id")}` : ""}${params(op.params)}${label}${tail}`;
    case "set":
      return `patch set ${word(op.id, "id")}${params(op.params)}${label}${tail}`;
    case "wire":
      return `patch wire ${word(op.from, "from")} ${word(op.to, "to")}${op.amount !== undefined ? ` ${num(op.amount, "amount")}` : ""}${tail}`;
    case "unwire":
      return `patch unwire ${word(op.from, "from")} ${word(op.to, "to")}${tail}`;
    case "macro": {
      if (!Array.isArray(op.targets) || op.targets.length === 0)
        throw new PatchToolError(
          'macro needs targets: ["node.port" or "node.port:min..max"]',
        );
      const targets = op.targets.map((t) => word(t, "target")).join(" ");
      const range =
        op.min !== undefined || op.max !== undefined
          ? ` range ${num(op.min, "min")}..${num(op.max, "max")}`
          : "";
      return `patch macro ${word(op.id, "id")} ${targets}${range}${op.default !== undefined ? ` default ${num(op.default, "default")}` : ""}${op.curve === "exp" || op.curve === "lin" ? ` curve ${op.curve}` : ""}${label}${tail}`;
    }
    case "knob":
      return `patch knob ${word(op.id, "id")} ${num(op.value, "value")}${tail}`;
    case "rate":
      if (op.rate !== "global" && op.rate !== "voice")
        throw new PatchToolError("rate is global or voice");
      return `patch rate ${word(op.id, "id")} ${op.rate}${tail}`;
    case "rm":
      return `patch rm ${word(op.id, "id")}${tail}`;
    case "convert":
      return "patch convert";
    case "detach":
      return "patch detach";
    case "load":
      return `patch load ${word(op.name, "name")}${tail}`;
    case "save":
      return `patch save ${word(op.name, "name")}${tail}`;
    default:
      throw new PatchToolError(`op is one of ${PATCH_TOOL_OPS.join(", ")}`);
  }
}

/** The AgentOperation a `patch_edit` call stands for. */
export function patchToolOperation(
  args: Record<string, unknown>,
  context: Pick<ToolContext, "score" | "focusedTrackId">,
): Extract<AgentOperation, { type: "patch-batch" }> {
  const trackId = args.trackId ?? context.focusedTrackId;
  if (typeof trackId !== "string" || trackId.length > SCORE_LIMITS.maxIdLength)
    throw new PatchToolError("trackId must be a short string");
  if (!context.score.tracks.some((track) => track.id === trackId))
    throw new PatchToolError(
      `unknown track ${trackId}; create it with create_track first`,
    );
  const fx = args.fx === undefined ? undefined : word(args.fx, "fx");
  if (!Array.isArray(args.ops) || args.ops.length === 0)
    throw new PatchToolError(
      "pass ops: [{op, …}], or show: true to read the patch",
    );
  if (args.ops.length > MAX_OPS)
    throw new PatchToolError(`at most ${MAX_OPS} ops per call`);
  const lines = args.ops.map((op, index) => {
    if (op === null || typeof op !== "object" || Array.isArray(op))
      throw new PatchToolError(`ops[${index}] must be an object`);
    try {
      return patchOpLine(op as Record<string, unknown>, fx);
    } catch (error) {
      if (error instanceof PatchToolError)
        throw new PatchToolError(`ops[${index}]: ${error.message}`);
      throw error;
    }
  });
  return { type: "patch-batch", lines, trackId };
}

/** Built-ins whose recipes are the prompt's few-shot examples. */
export const PATCH_FEW_SHOT = ["acid-bass", "pluck-ks", "fm-bell"] as const;

/** Recipes of built-in patches, one per line, `;` between commands. */
export function patchToolExamples(): string {
  return PATCH_FEW_SHOT.map((name) => builtinPatch(name))
    .filter((patch) => patch !== undefined)
    .map((patch) => patchRecipe(patch).join("; "))
    .join(" | ");
}

/** The system prompt's patcher paragraph. */
export const PATCH_PROMPT = `Modular patches: patch_edit builds a track's sound from nodes (osc, svf, adsr, vca, delayline, engine.*, fx.*) wired port to port, with up to 8 macros (the first four are knobs 1-4). Only patch when asked for a patch, a modular sound or something no set_* tool covers; prefer patch load <built-in> then edits. Ops mirror these typed recipes (each op one command; ids are yours): ${patchToolExamples()}`;

export const PATCH_TOOLS = Object.freeze([
  {
    name: "patch_edit",
    description:
      "Edit a track's modular patch or an fx patch: ops (new add set wire unwire macro knob rate rm convert detach load save) run in order as one undo step; show:true reads it as lines.",
    parameters: {
      type: "object",
      properties: {
        trackId: {
          type: "string",
          description: "Target track id. Defaults to the focused track.",
          maxLength: SCORE_LIMITS.maxIdLength,
        },
        fx: {
          type: "string",
          description: "Edit this effect patch, not the instrument.",
        },
        show: {
          type: "boolean",
          description: "Read the patch as lines.",
        },
        ops: {
          type: "array",
          maxItems: MAX_OPS,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: [...PATCH_TOOL_OPS] },
              type: {
                type: "string",
                enum: [...NODE_TYPES],
                description: `Node type for add. Enum params: ${ENUM_HINTS}`,
              },
              id: { type: "string", description: "Node or macro id." },
              name: {
                type: "string",
                description: "Patch to create, load or save.",
              },
              role: { type: "string", enum: ["instrument", "effect"] },
              params: {
                type: "object",
                description: "Node params, name: value.",
              },
              from: {
                type: "string",
                description:
                  "node.port (wire), or a patch or instrument (new).",
              },
              to: { type: "string", description: "node.port." },
              amount: { type: "number", minimum: -1, maximum: 1 },
              targets: { type: "array", items: { type: "string" } },
              min: { type: "number" },
              max: { type: "number" },
              default: { type: "number" },
              value: { type: "number" },
              curve: { type: "string", enum: ["lin", "exp"] },
              rate: { type: "string", enum: ["global", "voice"] },
              voices: { type: "integer", minimum: 1, maximum: 32 },
              label: { type: "string", maxLength: 60 },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      for (const key of Object.keys(args))
        if (!["trackId", "fx", "show", "ops"].includes(key))
          throw new PatchToolError(`unknown argument ${key}`);
      if (
        args.show === true &&
        (!Array.isArray(args.ops) || args.ops.length === 0)
      ) {
        const trackId =
          typeof args.trackId === "string"
            ? args.trackId
            : context.focusedTrackId;
        const fx = typeof args.fx === "string" ? args.fx : undefined;
        const located = locatePatch(context.score, trackId, fx);
        if (typeof located === "string") throw new PatchToolError(located);
        const text = patchRecipe(located).join("\n");
        return {
          kind: "action",
          summary: `read ${trackId}${fx ? ` fx ${fx}` : ""} patch`,
          async run() {
            return {
              content: text,
              summary: `patch ${located.name} · ${located.nodes.length} nodes`,
            };
          },
        };
      }
      const operation = patchToolOperation(args, context);
      const trackId = operation.trackId ?? context.focusedTrackId;
      const result = applyPatchBatch(context.score, trackId, operation.lines);
      if (!result.ok) throw new PatchToolError(result.message);
      if (result.effects?.length)
        throw new PatchToolError(
          "save to the user library is typed only (patch save <name> --user)",
        );
      const operations = result.next
        ? diffScores(context.score, result.next)
        : [];
      return {
        kind: "score",
        operations,
        trackId,
        summary: result.message.split("\n").join(" · ").slice(0, 160),
      };
    },
  },
] satisfies AgentTool[]);
