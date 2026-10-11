/**
 * Agent tool `set_calibration`: runs the same `/calibration` command the
 * prompt and the menu do (src/commands/calibration.ts).
 */

import { CALIBRATION_LATEST } from "../../core/score.ts";
import {
  applyCalibrationCommand,
  parseCalibrationCommand,
} from "../commands/calibration.ts";
import { ToolArgumentError } from "./tool-error.ts";
import type { AgentTool } from "./tools.ts";

const SET_CALIBRATION: AgentTool = {
  name: "set_calibration",
  description:
    "Set the song's sound calibration: 1 (latest) or 0 (legacy 0.4 to 0.6.1 sound).",
  parameters: {
    type: "object",
    properties: {
      calibration: { type: "integer", minimum: 0, maximum: CALIBRATION_LATEST },
    },
    required: ["calibration"],
    additionalProperties: false,
  },
  plan(args, context) {
    const value = args.calibration;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > CALIBRATION_LATEST
    )
      throw new ToolArgumentError(
        `calibration must be an integer 0..${CALIBRATION_LATEST}`,
      );
    const result = applyCalibrationCommand(
      context.score,
      parseCalibrationCommand(`calibration ${value}`)!,
    );
    if (!result.ok) throw new ToolArgumentError(result.message);
    return {
      kind: "score",
      operations: [
        { type: "setCalibration", calibration: value === 0 ? null : value },
      ],
      summary: result.message,
    };
  },
};

export const CALIBRATION_TOOLS: readonly AgentTool[] = Object.freeze([
  SET_CALIBRATION,
]);
