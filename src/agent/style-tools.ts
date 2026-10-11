/**
 * Agent tools for the style engine (core/styles): `list_styles` and
 * `style_info` read the taxonomy and cards; `apply_style` generates a song
 * from a style (optionally blended with a second one) and replaces the
 * score with it in one undo step, the same path as the `style` command.
 */

import { DiffError, diffScores } from "../../core/diff.ts";
import { STYLE_TREE, searchStyles } from "../../core/styles/index.ts";
import {
  STYLE_LIMITS,
  StyleError,
  styleScore,
} from "../../core/styles/generate.ts";
import { STYLE_FAMILIES } from "../../core/styles/taxonomy.ts";
import { resolveStyle } from "../../core/styles/index.ts";
import {
  describeStyle,
  findStyle,
  generateFromCommand,
  generatedSummary,
} from "../commands/style.ts";
import type { AgentTool } from "./tools.ts";

class StyleToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

const MAX_LIST = 60;

function nodeJSON(id: string) {
  const node = STYLE_TREE.get(id)!;
  return {
    id,
    title: node.title,
    ...(node.leaf ? {} : { children: node.children.length }),
  };
}

function knownStyle(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 120)
    throw new StyleToolError(`${name} must be a style id or name`);
  const id = findStyle(value);
  if (!id) {
    const near = searchStyles(value, 5).map((match) => match.id);
    throw new StyleToolError(
      `no style "${value}"${near.length ? `; did you mean ${near.join(", ")}` : "; call list_styles with a query"}`,
    );
  }
  return id;
}

function integer(value: unknown, name: string, min: number, max: number) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new StyleToolError(`${name} must be an integer ${min}..${max}`);
  return value;
}

export const STYLE_TOOLS = Object.freeze([
  {
    name: "list_styles",
    description:
      "Browse the style taxonomy (read-only): query searches, parent lists children, neither lists families.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 120 },
        parent: { type: "string", maxLength: 120 },
      },
      additionalProperties: false,
    },
    plan(args) {
      for (const key of Object.keys(args))
        if (key !== "query" && key !== "parent")
          throw new StyleToolError(`unknown argument ${key}`);
      let result: unknown;
      let summary: string;
      if (args.query !== undefined) {
        if (typeof args.query !== "string" || !args.query.trim())
          throw new StyleToolError("query must be a non-empty string");
        const matches = searchStyles(args.query, MAX_LIST).map((match) =>
          nodeJSON(match.id),
        );
        result = { query: args.query, matches };
        summary = `styles · ${matches.length} for "${args.query.slice(0, 40)}"`;
      } else if (args.parent !== undefined) {
        const id = knownStyle(args.parent, "parent");
        const node = STYLE_TREE.get(id)!;
        result = {
          parent: id,
          children: node.children.slice(0, MAX_LIST * 2).map(nodeJSON),
        };
        summary = `styles · ${node.children.length} under ${id}`;
      } else {
        result = {
          families: STYLE_FAMILIES.map((family) => ({
            family: family.key,
            title: family.title,
            roots: family.roots.map(nodeJSON),
          })),
        };
        summary = "styles · families";
      }
      const content = JSON.stringify(result);
      return {
        kind: "action",
        summary,
        async run() {
          return { content, summary };
        },
      };
    },
  },
  {
    name: "style_info",
    description:
      "Describe one style (read-only): taxonomy path, meter, tempo range, groove and swing, tuning and scales, harmony model, texture roles, and children.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", maxLength: 120 } },
      required: ["id"],
      additionalProperties: false,
    },
    plan(args) {
      const id = knownStyle(args.id, "id");
      const node = STYLE_TREE.get(id)!;
      const content = JSON.stringify({
        id,
        lines: describeStyle(resolveStyle(id)),
        children: node.children,
      });
      const summary = `style ${id}`;
      return {
        kind: "action",
        summary,
        async run() {
          return { content, summary };
        },
      };
    },
  },
  {
    name: "apply_style",
    description:
      "Replace the whole song with one generated from a style (one undo step); bars 1..64, seed picks a variation, blend+weight mixes two styles.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", maxLength: 120 },
        bars: {
          type: "integer",
          minimum: STYLE_LIMITS.minBars,
          maximum: STYLE_LIMITS.maxBars,
        },
        seed: { type: "integer", minimum: 0, maximum: STYLE_LIMITS.maxSeed },
        blend: { type: "string", maxLength: 120 },
        weight: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    plan(args, context) {
      for (const key of Object.keys(args))
        if (!["id", "bars", "seed", "blend", "weight"].includes(key))
          throw new StyleToolError(`unknown argument ${key}`);
      const id = knownStyle(args.id, "id");
      const bars = integer(
        args.bars,
        "bars",
        STYLE_LIMITS.minBars,
        STYLE_LIMITS.maxBars,
      );
      const seed = integer(args.seed, "seed", 0, STYLE_LIMITS.maxSeed);
      if (args.weight !== undefined && args.blend === undefined)
        throw new StyleToolError("weight needs blend");
      let blend: { id: string; weight: number } | undefined;
      if (args.blend !== undefined) {
        const weight = args.weight ?? 0.5;
        if (
          typeof weight !== "number" ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 1
        )
          throw new StyleToolError("weight must be 0..1");
        blend = { id: knownStyle(args.blend, "blend"), weight };
      }
      try {
        const generated = generateFromCommand({
          type: "style-apply",
          id,
          ...(bars !== undefined ? { bars } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(blend ? { blend } : {}),
        });
        const next = styleScore(generated);
        return {
          kind: "score",
          operations: diffScores(context.score, next),
          summary: generatedSummary(generated).slice(0, 160),
        };
      } catch (error) {
        if (error instanceof StyleError || error instanceof DiffError)
          throw new StyleToolError(error.message);
        throw error;
      }
    },
  },
] satisfies AgentTool[]);
