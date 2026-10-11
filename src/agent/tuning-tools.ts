/**
 * Agent tools for tunings and scales: `set_tuning` and `set_scale`. Both
 * build the same `/tuning` and `/scale` commands the prompt and the menu
 * run (src/commands/tuning.ts), so every surface validates alike.
 */

import { readFile } from "node:fs/promises";
import type { ScoreOperation, TrackScore } from "../../core/score.ts";
import { TUNING_LIMITS, TUNING_MAPS, type Tuning } from "../../core/tuning.ts";
import {
  applyTuningCommand,
  parseTuningCommand,
  type ProjectRead,
  type TuningResult,
} from "../commands/tuning.ts";
import { resolveReadPath, WorkspaceError } from "./workspace.ts";
import type { AgentTool, ScorePlan, ToolContext } from "./tools.ts";

class TuningToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

const MAX_TABLE = 128;

/** The `/tuning …` arguments one set_tuning call stands for. */
export function tuningCommandsFor(args: Record<string, unknown>): string[] {
  const target = args.target === undefined ? "song" : args.target;
  if (target !== "song" && target !== "track")
    throw new TuningToolError("target must be song or track");
  const prefix = target === "track" ? "tuning track" : "tuning";
  if (args.off === true) return [`${prefix} off`];
  const commands: string[] = [];
  const tables = ["name", "edo", "ratios", "cents", "scl"].filter(
    (field) => args[field] !== undefined,
  );
  if (tables.length > 1)
    throw new TuningToolError(
      `give one of name, edo, ratios, cents or scl (got ${tables.join(", ")})`,
    );
  const word = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !/^[^\s]{1,256}$/.test(value))
      throw new TuningToolError(`${field} must be one word`);
    return value;
  };
  const table = tables[0];
  if (table === "name") commands.push(`${prefix} ${word(args.name, "name")}`);
  else if (table === "edo") {
    const edo = args.edo;
    if (
      typeof edo !== "number" ||
      !Number.isInteger(edo) ||
      edo < 1 ||
      edo > TUNING_LIMITS.maxEdo
    )
      throw new TuningToolError(`edo must be 1..${TUNING_LIMITS.maxEdo}`);
    commands.push(`${prefix} edo ${edo}`);
  } else if (table === "ratios" || table === "cents") {
    const list = args[table];
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_TABLE)
      throw new TuningToolError(`${table} must list 1..${MAX_TABLE} steps`);
    const items = list.map((item, index) => {
      if (table === "cents" && typeof item === "number" && isFinite(item))
        return String(item);
      return word(
        typeof item === "number" ? String(item) : item,
        `${table}[${index}]`,
      );
    });
    commands.push(`${prefix} ${table} ${items.join(" ")}`);
  } else if (table === "scl") {
    const scl = word(args.scl, "scl");
    commands.push(
      args.kbm !== undefined
        ? `${prefix} scl ${scl} kbm ${word(args.kbm, "kbm")}`
        : `${prefix} scl ${scl}`,
    );
  }
  if (table !== "scl" && args.kbm !== undefined)
    commands.push(
      args.kbm === null
        ? `${prefix} kbm off`
        : `${prefix} kbm ${word(args.kbm, "kbm")}`,
    );
  if (args.ref !== undefined) {
    if (args.ref === null) commands.push(`${prefix} ref off`);
    else if (typeof args.ref === "number" && isFinite(args.ref))
      commands.push(`${prefix} ref ${args.ref}`);
    else throw new TuningToolError("ref must be a number of Hz or null");
  }
  if (args.root !== undefined)
    commands.push(
      `${prefix} root ${args.root === null ? "auto" : word(String(args.root), "root")}`,
    );
  if (args.map !== undefined) {
    if (!TUNING_MAPS.includes(args.map as never))
      throw new TuningToolError(`map must be ${TUNING_MAPS.join(" or ")}`);
    commands.push(`${prefix} map ${String(args.map)}`);
  }
  if (commands.length === 0)
    throw new TuningToolError(
      "give a tuning (name, edo, ratios, cents or scl), ref, root, map or off",
    );
  return commands;
}

/** Runs `commands` in order and returns the operations they produced. */
function planCommands(
  score: TrackScore,
  trackId: string,
  commands: readonly string[],
  read: ProjectRead,
): ScorePlan {
  let next = score;
  const operations: ScoreOperation[] = [];
  const messages: string[] = [];
  for (const text of commands) {
    const command = parseTuningCommand(text);
    if (!command) throw new TuningToolError(`cannot read ${text}`);
    const result: TuningResult = applyTuningCommand(
      next,
      trackId,
      command,
      read,
    );
    if (!result.ok || !result.next) throw new TuningToolError(result.message);
    operations.push(operationOf(result, trackId));
    messages.push(result.message);
    next = result.next;
  }
  return {
    kind: "score",
    operations,
    summary: messages.at(-1) ?? "tuning",
    trackId,
  };
}

function operationOf(result: TuningResult, trackId: string): ScoreOperation {
  const payload = result.payload ?? {};
  if (result.kind === "score.tuning")
    return {
      type: "setTuning",
      tuning: (payload.tuning as Tuning | null | undefined) ?? null,
    };
  if (result.kind === "score.track")
    return {
      type: "updateTrack",
      trackId,
      patch: (payload.patch as { tuning: Tuning | null }) ?? {},
    };
  if (result.kind === "score.key")
    return { type: "setKey", key: (payload.key as string | null) ?? null };
  throw new TuningToolError(`unexpected result ${result.kind ?? ""}`);
}

function trackFor(args: Record<string, unknown>, context: ToolContext): string {
  const id = args.trackId ?? context.focusedTrackId;
  if (typeof id !== "string" || !context.score.tracks.some((t) => t.id === id))
    throw new TuningToolError(`no track ${String(id)}`);
  return id;
}

const SET_TUNING: AgentTool = {
  name: "set_tuning",
  description:
    "Set the song tuning (or one track's): library name, n-EDO, ratios, cents or a Scala file, plus A4, root and mapping; off returns to 12-TET.",
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["song", "track"] },
      trackId: { type: "string", description: "track target; default focused" },
      name: {
        type: "string",
        description:
          "19-edo, 24-edo, 31-edo, pythagorean, just, 7-limit, well-tuned-piano, pelog, slendro, rast, bayati, yaman…",
      },
      edo: { type: "integer", minimum: 1, maximum: TUNING_LIMITS.maxEdo },
      ratios: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_TABLE,
        description:
          'degrees 1..n, last is the period: ["9/8","5/4","3/2","2/1"]',
      },
      cents: {
        type: "array",
        items: { type: "number" },
        maxItems: MAX_TABLE,
        description: "degrees 1..n in cents, last is the period (1200)",
      },
      scl: { type: "string", description: "project path to a .scl file" },
      kbm: {
        type: ["string", "null"],
        description: "project path to a .kbm keyboard map; null removes it",
      },
      ref: {
        type: ["number", "null"],
        minimum: TUNING_LIMITS.minRefHz,
        maximum: TUNING_LIMITS.maxRefHz,
        description: "A4 in Hz (440); null resets",
      },
      root: {
        type: ["string", "null"],
        description: 'key of degree 0 ("D4"); null follows the song key',
      },
      map: {
        type: "string",
        enum: TUNING_MAPS,
        description:
          "linear: one key per step · nearest: 12 keys to nearest step",
      },
      off: { type: "boolean" },
    },
    additionalProperties: false,
  },
  plan(args, context) {
    const trackId = trackFor(args, context);
    const commands = tuningCommandsFor(args);
    const needsFiles = args.scl !== undefined || typeof args.kbm === "string";
    const current =
      args.target === "track"
        ? context.score.tracks.find((t) => t.id === trackId)?.tuning
        : context.score.tuning;
    if (!needsFiles && !current?.scl && !current?.kbm)
      return planCommands(context.score, trackId, commands, () => undefined);
    return {
      kind: "prepare",
      summary: commands.join(" · "),
      async run(host) {
        const files = new Map<string, string>();
        if (host.workspace) {
          const paths = [args.scl, args.kbm, current?.scl, current?.kbm].filter(
            (path): path is string => typeof path === "string",
          );
          for (const path of paths) {
            try {
              const resolved = await resolveReadPath(
                { root: host.workspace.root, trackSlug: "" },
                path,
              );
              files.set(path, await readFile(resolved.real, "utf8"));
            } catch (error) {
              if (!(error instanceof WorkspaceError)) throw error;
            }
          }
        }
        return planCommands(context.score, trackId, commands, (path) =>
          files.get(path),
        );
      },
    };
  },
};

const SET_SCALE: AgentTool = {
  name: "set_scale",
  description:
    "Set the song key and scale (modes, minors, pentatonic, blues, maqam, raga, Messiaen); chords, keys and snapping follow it.",
  parameters: {
    type: "object",
    properties: {
      tonic: {
        type: "string",
        description: '"C", "F#", "Eb"; default song tonic',
      },
      scale: {
        type: "string",
        description:
          "dorian, harmonic-minor, minor-pentatonic, blues, hijaz, bayati, yaman, bhairav, kafi, messiaen-3…",
      },
    },
    required: ["scale"],
    additionalProperties: false,
  },
  plan(args, context) {
    const scale = args.scale;
    if (typeof scale !== "string" || !/^[a-z0-9-]{1,32}$/i.test(scale))
      throw new TuningToolError("scale must be a scale name");
    const tonic = args.tonic;
    if (
      tonic !== undefined &&
      (typeof tonic !== "string" || !/^[a-g][#b]?$/i.test(tonic))
    )
      throw new TuningToolError('tonic must be a note name like "D" or "Eb"');
    const command = tonic ? `scale ${tonic} ${scale}` : `scale ${scale}`;
    return planCommands(
      context.score,
      context.focusedTrackId,
      [command],
      () => undefined,
    );
  },
};

export const TUNING_TOOLS: readonly AgentTool[] = Object.freeze([
  SET_TUNING,
  SET_SCALE,
]);
