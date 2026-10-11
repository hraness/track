/**
 * Agent tools for the song master: `set_master` (score) edits the chain and
 * loudness target through the same `nextMaster` path as the `master` prompt
 * command, and `measure_mix` (read-only) renders the song and reports
 * loudness (BS.1770 / EBU R 128), true peak, spectral balance and stereo
 * correlation, so the agent can check a mix before and after mastering.
 */

import {
  LOUDNESS_TARGET_NAMES,
  LOUDNESS_TARGETS,
  MASTER_LIMITS,
  MASTER_PRESETS,
  MASTER_SPECS,
  MASTER_UNITS,
  describeMaster,
  isLoudnessTargetName,
  isMasterUnit,
  normalizeMaster,
  type MasterUnit,
  type SongMaster,
} from "../../core/master.ts";
import { FxValidationError } from "../../core/params.ts";
import { ScoreValidationError, type TrackScore } from "../../core/score.ts";
import {
  exportSampleRate,
  measureScore,
  type ScoreMeasurement,
} from "../audio/measure.ts";
import { nextMaster, type MasterCommand } from "../commands/master.ts";
import type { AgentTool } from "./tools.ts";
import type { PreviewHost } from "./preview-tool.ts";

class MasterToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

const TARGET_LIST = LOUDNESS_TARGET_NAMES.map(
  (name) => `${name} ${LOUDNESS_TARGETS[name].lufs}`,
).join(", ");

const UNIT_ARGS = Object.fromEntries(
  MASTER_UNITS.map((unit) => [
    unit,
    {
      description: `${MASTER_SPECS[unit].doc}; params ${Object.keys(MASTER_SPECS[unit].params).join(" ")}`,
      anyOf: [
        { type: "boolean" },
        { type: "string", enum: Object.keys(MASTER_PRESETS[unit]) },
        { type: "object" },
      ],
    },
  ]),
);

function unitCommands(unit: MasterUnit, value: unknown): MasterCommand[] {
  if (value === undefined) return [];
  if (value === true || value === false)
    return [{ type: "master-unit", unit, on: value }];
  if (typeof value === "string") {
    if (!Object.hasOwn(MASTER_PRESETS[unit], value))
      throw new MasterToolError(
        `${unit} preset must be one of ${Object.keys(MASTER_PRESETS[unit]).join(", ")}`,
      );
    return [{ type: "master-preset", unit, preset: value }];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new MasterToolError(
      `${unit} must be true, false, a preset name or params`,
    );
  const values: Record<string, number | string | boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      typeof raw !== "number" &&
      typeof raw !== "string" &&
      typeof raw !== "boolean"
    )
      throw new MasterToolError(`${unit}.${key} must be a number or string`);
    values[key] = raw;
  }
  return [{ type: "master-set", unit, values }];
}

function targetCommand(value: unknown): MasterCommand | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "off")
    return { type: "master-target", lufs: null };
  if (typeof value === "string") {
    if (!isLoudnessTargetName(value))
      throw new MasterToolError(
        `target must be LUFS or one of ${LOUDNESS_TARGET_NAMES.join(", ")}`,
      );
    return {
      type: "master-target",
      lufs: LOUDNESS_TARGETS[value].lufs,
      name: value,
    };
  }
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new MasterToolError("target must be LUFS, a name or null");
  // Like the prompt's `master target 14`: loudness targets are negative.
  return { type: "master-target", lufs: -Math.abs(value) };
}

function round(value: number, digits = 1): number | null {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** The measure_mix result: plain numbers (null for silence), no series. */
export function measurementJSON(
  measured: ScoreMeasurement,
  master: SongMaster | undefined,
): Record<string, unknown> {
  const { mix } = measured;
  const loudness = mix.loudness;
  const notes: string[] = [];
  if (!Number.isFinite(loudness.integrated))
    notes.push("silent: nothing to measure");
  else {
    // The limiter's own ceiling when one is set; otherwise -1 dBTP, or -2
    // for a master louder than -14 LUFS (lossy encodes of loud, dense
    // material make inter-sample overs).
    const set = master?.limiter?.ceiling;
    const safe = loudness.integrated > -14 ? -2 : -1;
    const ceiling = typeof set === "number" ? set : safe;
    if (loudness.truePeak > ceiling + 0.1)
      notes.push(
        typeof set === "number"
          ? `true peak above the ${ceiling} dBTP ceiling`
          : `true peak above ${safe} dBTP: lossy encodes may clip (keep -1 dBTP, -2 for masters louder than -14 LUFS)`,
      );
    if (mix.correlation < 0)
      notes.push("negative correlation: parts cancel in mono");
    if (mix.bands.sub > -3)
      notes.push("sub band dominates; check the low end on small speakers");
  }
  if (measured.master?.target !== undefined && !measured.master.reached)
    notes.push(
      measured.master.integrated < measured.master.target
        ? "target missed: the limiter has hit its plateau; add master tape (preset crush) or a lower glue threshold before it"
        : "target missed: the mix is louder than the target allows",
    );
  return {
    integrated: round(loudness.integrated),
    shortTermMax: round(loudness.shortTermMax),
    momentaryMax: round(loudness.momentaryMax),
    range: round(loudness.range),
    truePeak: round(loudness.truePeak),
    samplePeak: round(loudness.samplePeak),
    plr: round(mix.plr),
    bands: Object.fromEntries(
      Object.entries(mix.bands).map(([name, db]) => [name, round(db)]),
    ),
    correlation: round(mix.correlation, 2),
    sideDb: round(mix.sideDb),
    seconds: round(measured.seconds, 2),
    sampleRate: measured.sampleRate,
    loop: measured.loop,
    master: master
      ? {
          chain: describeMaster(master),
          ...(measured.master
            ? {
                gainDb: round(measured.master.gainDb),
                ...(measured.master.target === undefined
                  ? {}
                  : {
                      target: measured.master.target,
                      reached: measured.master.reached,
                    }),
              }
            : {}),
        }
      : null,
    ...(notes.length ? { notes } : {}),
  };
}

/** Measure with the window's decoded samples when it has them. */
async function measureWith(
  preview: PreviewHost | undefined,
  score: TrackScore,
  sampleRate: number,
): Promise<ScoreMeasurement> {
  return preview?.measure
    ? await preview.measure(score, { sampleRate })
    : measureScore(score, { sampleRate });
}

export const MASTER_TOOLS = Object.freeze([
  {
    name: "set_master",
    description:
      "Edit the song master (eq, glue, tape, width, limiter: false, true, a preset or params) and its loudness target; off:true removes it.",
    parameters: {
      type: "object",
      properties: {
        ...UNIT_ARGS,
        target: {
          description: `Integrated LUFS (${MASTER_LIMITS.minTarget} to ${MASTER_LIMITS.maxTarget}), a name, or null to clear. The limiter's drive reaches it; without a limiter, gain stops at ${MASTER_LIMITS.safeCeiling} dBTP.`,
          anyOf: [
            { type: "number" },
            { type: "string", enum: [...LOUDNESS_TARGET_NAMES] },
            { type: "null" },
          ],
        },
        off: {
          type: "boolean",
          description: "Remove the whole master.",
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      const commands: MasterCommand[] = [];
      if (args.off === true) commands.push({ type: "master-off" });
      for (const unit of MASTER_UNITS)
        commands.push(...unitCommands(unit, args[unit]));
      const target = targetCommand(args.target);
      if (target) commands.push(target);
      for (const key of Object.keys(args))
        if (key !== "off" && key !== "target" && !isMasterUnit(key))
          throw new MasterToolError(`unknown argument ${key}`);
      if (commands.length === 0)
        throw new MasterToolError(
          "pass a unit (eq, glue, tape, width, limiter), target or off",
        );
      let master: SongMaster | undefined = context.score.master;
      try {
        for (const command of commands)
          master = normalizeMaster(nextMaster(master, command));
      } catch (error) {
        if (
          error instanceof FxValidationError ||
          error instanceof ScoreValidationError
        )
          throw new MasterToolError(error.message);
        throw error;
      }
      return {
        kind: "score",
        operations: [{ type: "setMaster", master: master ?? null }],
        summary: `master · ${describeMaster(master)}`.slice(0, 160),
      };
    },
  },
  {
    name: "measure_mix",
    description:
      "Render and measure the song (read-only): LUFS, loudness range, true peak, band balance, stereo correlation; bypass_master:true measures before the master.",
    parameters: {
      type: "object",
      properties: {
        bypass_master: {
          type: "boolean",
          description: "Measure without the master.",
        },
      },
      additionalProperties: false,
    },
    plan(args, context) {
      if (
        args.bypass_master !== undefined &&
        typeof args.bypass_master !== "boolean"
      )
        throw new MasterToolError("bypass_master must be a boolean");
      const bypass = args.bypass_master === true && !!context.score.master;
      const score = bypass ? context.score.withMaster(null) : context.score;
      return {
        kind: "action",
        summary: bypass
          ? "measured the mix before the master"
          : "measured the mix",
        async run(action) {
          // The bypassed reading stays at the mastered song's rate, so the
          // before/after comparison is not a resampling artefact.
          const measured = await measureWith(
            action.preview,
            score,
            exportSampleRate(context.score),
          );
          const result = measurementJSON(measured, score.master);
          const integrated = result.integrated;
          return {
            content: JSON.stringify(result),
            summary:
              integrated === null
                ? "measured · silent"
                : `measured · ${integrated} LUFS · ${result.truePeak} dBTP`,
          };
        },
      };
    },
  },
] satisfies AgentTool[]);
