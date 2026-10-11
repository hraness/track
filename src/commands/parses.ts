/**
 * Whether a prompt line is a command the human prompt bar runs locally (no
 * model call): every command parser the prompt tries, in one list. The TUI
 * uses it for typo fixes; show-me (src/agent/show-me.ts) uses it in tests to
 * prove every command it ghost-types is one a human can type.
 */
import type { TrackScore } from "../../core/score.ts";
import { parsePrompt } from "../agent/ops.ts";
import { parseSectionCommand } from "./arrange.ts";
import { parseRangeCommand } from "./range.ts";
import { parseAutotuneCommand } from "./autotune.ts";
import { parseClipCommand, parseLyricsCommand } from "./clips.ts";
import { parseHistoryCommand } from "./comment.ts";
import { parsePatternCommand } from "./drums.ts";
import { parseProgressionCommand } from "./progression.ts";
import { parseEditCommand } from "./edit.ts";
import { parseExpressionCommand } from "./expression.ts";
import { parseFitCommand } from "./fit.ts";
import { parseFormantCommand, parseVowelCommand } from "./formant.ts";
import { parseFxCommand } from "./fx.ts";
import { parsePresetCommand } from "./preset.ts";
import { parsePatchCommand } from "./patch.ts";
import { parseGranularCommand } from "./granular.ts";
import { parseKeysCommand, parseRecordCommand } from "./keys.ts";
import { parseMasterCommand } from "./master.ts";
import { parseModalCommand } from "./modal.ts";
import { parseMusicCommand } from "./music.ts";
import { parseKitCommand, parsePackCommand } from "./pack.ts";
import { parseResampleCommand } from "./resample.ts";
import { parseChopCommand } from "../audio/chop/command.ts";
import { parseRhythmCommand } from "./rhythm.ts";
import { parseRigCommand } from "./rig.ts";
import { parseSampleCommand } from "./sample.ts";
import { parseShiftCommand } from "./shift.ts";
import { parseSingCommand } from "./sing.ts";
import { parseStringCommand } from "./string.ts";
import { parseGuitarCommand, parseStrumCommand } from "./strum.ts";
import { parseSynthCommand } from "./synth.ts";
import { parseTimeCommand } from "./time.ts";
import { parseTuningCommand } from "./tuning.ts";
import { parseVocalCommand } from "./vocal.ts";
import { parseVocoderCommand } from "./vocoder.ts";
import { parseWavetableCommand } from "./wavetable.ts";
import { parseWindCommand } from "./wind.ts";
import {
  candidates,
  parseExportCommand,
  parseLoopCommand,
  parseTrackEdit,
} from "./grammar.ts";

/** One parser's reading of a line: its name and what it parsed. */
export type ParsedCommand = Readonly<{ parser: string; value: unknown }>;

/**
 * The first parser that takes `text` exactly as typed, with its result
 * (no grammar rewrites): what the prompt bar would run for this spelling.
 */
export function parseExact(
  text: string,
  score: TrackScore,
): ParsedCommand | undefined {
  for (const parse of parsers(score)) {
    const value = parse(text);
    if (value !== undefined)
      return { parser: parse.name || "anonymous", value };
  }
  return undefined;
}

/**
 * What `text` runs as: the exact spelling first, then the grammar's other
 * readings (`/x` ≡ `x`, aliases, remove and list words) in order.
 */
export function parseCommand(
  text: string,
  score: TrackScore,
): ParsedCommand | undefined {
  for (const line of [text, ...candidates(text)]) {
    const parsed = parseExact(line, score);
    if (parsed) return parsed;
  }
  return undefined;
}

/** Whether a line runs locally, in any spelling the grammar accepts. */
export function commandParses(text: string, score: TrackScore): boolean {
  return parseCommand(text, score) !== undefined;
}

function parsers(score: TrackScore): ((text: string) => unknown)[] {
  return [
    function parseRange(value: string) {
      return parseRangeCommand(value, score);
    },
    parsePrompt,
    parseMusicCommand,
    parseEditCommand,
    parseRhythmCommand,
    parsePatchCommand,
    parsePresetCommand,
    parseFxCommand,
    parseSynthCommand,
    parseStringCommand,
    parseGranularCommand,
    parseRecordCommand,
    parseKeysCommand,
    parseExpressionCommand,
    parseMasterCommand,
    function parseSection(value: string) {
      return parseSectionCommand(value, score);
    },
    parsePatternCommand,
    parseKitCommand,
    parsePackCommand,
    parseSampleCommand,
    parseFitCommand,
    parseShiftCommand,
    parseResampleCommand,
    parseChopCommand,
    parseWavetableCommand,
    parseTimeCommand,
    parseTuningCommand,
    parseRigCommand,
    parseModalCommand,
    parseGuitarCommand,
    parseStrumCommand,
    parseProgressionCommand,
    parseWindCommand,
    parseAutotuneCommand,
    parseSingCommand,
    parseVocoderCommand,
    parseVocalCommand,
    parseFormantCommand,
    parseVowelCommand,
    parseClipCommand,
    parseLyricsCommand,
    parseExportCommand,
    parseLoopCommand,
    parseTrackEdit,
    parseHistoryCommand,
  ];
}
