#!/usr/bin/env bun
import { TOPIC_ALIASES } from "./lang/glossary.ts";
import { isGuideInstrument, vocalChainPatch } from "../core/clips.ts";
import { newId } from "../core/ids.ts";
import { deepEqual, DiffError, diffScores } from "../core/diff.ts";
import { currentActor } from "./identity/actor.ts";
import {
  runHistoryLine,
  wireHistory,
  type HistoryHost,
} from "./history/wire.ts";
import { isSingWord } from "../core/sing.ts";
import { commandParses, parseExact } from "./commands/parses.ts";
import { paramRangeError } from "./commands/param-range.ts";
import { noteName as midiNoteName } from "./media/notes.ts";
import {
  EVERYDAY_VERBS,
  EXPORT_USAGE,
  elsewhereHint,
  FREE_TEXT_HINTS,
  noTrack,
  stemsReceipt,
  LOOP_USAGE,
  WINDOW_VERBS,
  NO_AGENT,
  RANGES,
  canonicalWindowForm,
  friendlyCoreError,
  knownVerbs,
  nearest,
  noNote,
  parseExportCommand,
  parseLoopCommand,
  recover,
  usageCard,
  usageError,
  verbOf,
} from "./commands/grammar.ts";
import {
  instrumentListLines,
  isUnknownInstrument,
  plainSineAdvice,
  unknownInstrumentMessage,
} from "./audio/instrument-check.ts";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import {
  ensureSession,
  SessionConflictError,
  type SessionRecord,
} from "./session/store.ts";
import { openSessionPort } from "./session/port.ts";
import {
  OwnWrites,
  editedTrack,
  foreignEvents,
  otherWindowName,
  paneLetters,
} from "./session/origin.ts";
import {
  compositionDigest,
  monotonicEpochMs,
  type PaneView,
  type PresenceEntry,
} from "./session/protocol.ts";
import {
  formatSessionLine,
  listSessions,
  printSessions,
} from "./session/list.ts";
import { openHistory } from "./history/open.ts";
import { undoEvents } from "./history/undo-source.ts";
import {
  ALL_TRACKS_OPEN_HINT,
  attachTrack,
  forkSession,
  namingTarget,
  pickerLines,
  resolveSessionArg,
  SessionLookupError,
  withTrack,
} from "./session/attach.ts";
import { AutoNamer, providerNameGenerator } from "./session/naming.ts";
import { normalizeSessionName } from "./session/meta.ts";
import { parsePrompt } from "./agent/ops.ts";
import { applyMusicCommand, parseMusicCommand } from "./commands/music.ts";
import { applyRhythmCommand, parseRhythmCommand } from "./commands/rhythm.ts";
import {
  applyDrumPattern,
  applySynthKit,
  DRUM_PATTERNS,
  isSynthKitName,
  parsePatternCommand,
  patternLine,
  type PatternCommand,
} from "./commands/drums.ts";
import { kitCatalog } from "./audio/kits.ts";
import { applyEditCommand, parseEditCommand } from "./commands/edit.ts";
import { applyTimeCommand, parseTimeCommand } from "./commands/time.ts";
import {
  barAt,
  barStartTick,
  bpmAtTick,
  hasMeterChanges,
  loopTicksOf,
} from "../core/tempo.ts";
import {
  applyExpressionCommand,
  parseExpressionCommand,
} from "./commands/expression.ts";
import {
  applyPatchCommand,
  parsePatchCommand,
  patchCommandError,
  patchSourceOf,
  type PatchCommand,
  type PatchEnv,
} from "./commands/patch.ts";
import {
  applyPresetCommand,
  listKind,
  parsePresetCommand,
  steppedPreset,
  trackPreset,
  usePreset,
  type PresetCommand,
  type PresetListKind,
} from "./commands/preset.ts";
import { presetByName } from "../core/presets/index.ts";
import { presetPhrase, presetScore } from "./audio/preset-check.ts";
import { loadFavorites, saveFavorites } from "./audio/preset-favorites.ts";
import {
  categoryPicker,
  presetPicker,
  type BrowserOptions,
} from "./tui/preset-browser.ts";
import {
  isPatchSource,
  loadPatchSource,
  readUserPatch,
  saveUserPatch,
} from "./audio/patch-library.ts";
import { builtinPatch } from "../core/patches/index.ts";
import {
  applyFxCommand,
  parseFxCommand,
  unknownFxMessage,
} from "./commands/fx.ts";
import {
  applyRigCommand,
  parseRigCommand,
  rigTrackFields,
  rigWordPatch,
} from "./commands/rig.ts";
import {
  applyProgressionCommand,
  parseProgressionCommand,
} from "./commands/progression.ts";
import {
  applyGuitarCommand,
  applyStrumCommand,
  parseGuitarCommand,
  parseStrumCommand,
} from "./commands/strum.ts";
import {
  applyModalCommand,
  modalListLines,
  parseModalCommand,
} from "./commands/modal.ts";
import {
  applyWindCommand,
  parseWindCommand,
  windListLines,
} from "./commands/wind.ts";
import {
  applySingCommand,
  parseSingCommand,
  singListLines,
} from "./commands/sing.ts";
import { applySynthCommand, parseSynthCommand } from "./commands/synth.ts";
import { applyStringCommand, parseStringCommand } from "./commands/string.ts";
import { instrumentPatchForWord, isModalWord } from "../core/resonators.ts";
import {
  applyGranularCommand,
  granularTrackPreset,
  grainSrcHint,
  parseGranularCommand,
} from "./commands/granular.ts";
import {
  applyKeysCommand,
  newPianoTrack,
  parseKeysCommand,
  parseRecordCommand,
} from "./commands/keys.ts";
import {
  applyTuningCommand,
  importTuningFile,
  parseTuningCommand,
  type TuningCommand,
} from "./commands/tuning.ts";
import {
  applyCalibrationCommand,
  parseCalibrationCommand,
} from "./commands/calibration.ts";
import { TuningError, displayTag, resolveTuning } from "../core/tuning.ts";
import {
  applyMasterCommand,
  measurementLine,
  parseMasterCommand,
} from "./commands/master.ts";
import { applyStyleCommand, parseStyleCommand } from "./commands/style.ts";
import { exportSampleRate, measureScoreOffThread } from "./audio/measure.ts";
import {
  applySectionCommand,
  loopSpan,
  parseSectionCommand,
} from "./commands/arrange.ts";
import {
  applyRangeCommand,
  parseRangeCommand,
  type RangeClipboard,
} from "./commands/range.ts";
import { rangeLabel } from "../core/range.ts";
import {
  helpMiss,
  helpText,
  helpTitle,
  helpHeadingMarks,
  helpTopicLines,
  nearestCommand,
  typoFix,
  usageHint,
} from "./commands/help.ts";
import {
  historyReceipt,
  historyTarget,
  paneHistoryStep,
  REDO_KIND,
  UNDO_KIND,
} from "./commands/history.ts";

import {
  SamplePlacementError,
  addSampleVoice,
  freeVoiceName,
  listSampleVoices,
  parseSampleCommand,
  setSampleControls,
  placeSampleFile,
  samplerTarget,
  voiceNameFrom,
} from "./commands/sample.ts";
import { applyFitCommand, fitVoice, parseFitCommand } from "./commands/fit.ts";
import { applyShiftCommand, parseShiftCommand } from "./commands/shift.ts";
import { parseVocalCommand, runVocalCommand } from "./commands/vocal.ts";
import {
  applyFormantCommand,
  parseFormantCommand,
  parseVowelCommand,
} from "./commands/formant.ts";
import {
  applyLyrics,
  parseClipCommand,
  parseLyricsCommand,
  runClipCommand,
  setClipImportDeps,
} from "./commands/clips.ts";
import { pitchTraceFor } from "./commands/vocal-pitch.ts";
import {
  applyVocoderCommand,
  parseVocoderCommand,
  vocoderListLines,
} from "./commands/vocoder.ts";
import {
  applyAutotuneCommand,
  autotuneListLines,
  parseAutotuneCommand,
} from "./commands/autotune.ts";
import { parseResampleCommand, runResample } from "./commands/resample.ts";
import { chopHelpLines, parseChopCommand } from "./audio/chop/command.ts";
import { runChop, stemOf } from "./audio/chop/run.ts";
import { slicesToSampler } from "./audio/chop/sampler.ts";
import { auditionPcm } from "./audio/chop/audition.ts";
import type { ChopResult } from "./audio/chop/types.ts";
import { trackSlug as chopTrackSlug } from "../core/slug.ts";
import { suggestFitMode } from "./audio/dsp/onset.ts";
import {
  SampleLibrary,
  hasSamplerTracks,
  sampleKey,
  type SampleBank,
  type SampleProblem,
} from "./audio/samples.ts";
import {
  ANALYSIS_CACHE_BYTES,
  analysisCacheStatus,
  analysisDir,
  pruneAnalysisCache,
} from "./audio/analysis.ts";
import { drumSnapshotFields, samplerSnapshotFields } from "../tui/drums.ts";
import { clipSnapshots, loadClipPeaks } from "../tui/clip-row.ts";
import { highwayLayers } from "../tui/layers.ts";
import { drumVoicePitch, isDrumInstrument } from "../core/drums.ts";
import {
  describeAgentEvent,
  StaleRevisionError,
  type AgentEvent,
  type AgentHost,
} from "./agent/agent.ts";
import { routeDuringTurn } from "./agent/steer.ts";
import {
  isApiSelection,
  providerFingerprint,
  providerLabel,
  runProviderTurn,
  selectProvider,
  type ProviderSelection,
  subagentHostFor,
} from "./agent/provider.ts";
import {
  MODEL_CATALOG,
  priceForModel,
  resolveModelChoice,
} from "./agent/models.ts";
import {
  SpendMeter,
  spendLine as formatSpendLine,
  webHostFor,
} from "./agent/usage.ts";
import { configDir, readConfig, writeConfig } from "./auth/credentials.ts";
import type { CommandOutcome } from "./agent/command-agent.ts";
import {
  GLIDE_STEP_MS,
  NoteScheduler,
  finishHint,
  gestureFor,
  glideValues,
  agentPathsAllowed,
  isAgentCommand,
  isBrokenCommand,
  brokenCommandReceipt,
  parseShowMe,
  toolCaption,
  type ShowMeLevel,
} from "./agent/show-me.ts";
import { firstRunCard, runAuthCommand, runTuiLogin } from "./auth/cli.ts";
import { musicalReceipt } from "./session/receipt.ts";
import {
  modelPickerItems,
  tuiAuthCommand,
  tuiLoginArgs,
  tuiSetModel,
} from "./auth/tui.ts";
import { TransportClock, transportMapFor } from "./audio/clock.ts";
import {
  AudioEngine,
  detectAudioBackend,
  type AudioBackendInfo,
} from "./audio/engine.ts";
import { audioMenuState, runAudioCommand } from "./audio/audio-command.ts";
import { runAgentSettingsCommand } from "./commands/agent-settings.ts";
import { readAgentSettings } from "./agent/settings.ts";
import {
  DEFAULT_GRID,
  GRIDS,
  PLAY_LEAD_MS,
  PlaySession,
  type LiveEngine,
} from "./tui/play-session.ts";
import {
  EditMenu,
  menuUsage,
  menuSectionPath,
  type MenuAudioDevices,
  type MenuContext,
} from "./tui/menu.ts";
import { KNOB_PAGE_WORDS, knobPageId } from "./tui/knob-map.ts";
import {
  beatOfBar,
  cutArmed,
  focusCommand,
  foldBase,
  knobNoun,
  tapeKey,
  tapeKnobs,
  type TapeContext,
} from "./tui/tape-mode.ts";
import { tapeView } from "./tui/tape-view.ts";
import {
  clampState,
  focusCable,
  newCables,
  patchKey,
  patchModel,
  patchPaint,
  patchViewState,
  type PatchViewState,
} from "./tui/patch-view.ts";
import { nodeMenuId } from "./tui/patch-menu.ts";
import type { PatchPaint } from "../tui/patch.ts";
import type { Cable } from "../core/patch.ts";
import { PromptQueue } from "./tui/prompt-queue.ts";
import { TAPE_ZOOMS, type TapeView, type TapeZoom } from "../tui/tape.ts";
import type { HitTarget } from "../tui/hits.ts";
import { knobKey, type KnobState } from "../tui/knobs.ts";
import {
  clipboardPath,
  loadClipboard,
  saveClipboard,
} from "./session/clipboard.ts";
import { extractRange } from "../core/range.ts";
import {
  drawerAside,
  drawerView,
  faderChoose,
  faderCommand,
  faderKeyPress,
  faderSetPosition,
  faderStep,
  focusIndex,
  type FaderResult,
  type FaderState,
} from "./tui/fader.ts";
import {
  isMouseSequence,
  MOUSE_OFF,
  MOUSE_ON,
  parseMouse,
  type MouseEvent,
} from "../tui/keys.ts";
import {
  Audition,
  SUPERSEDED,
  isChordStageable,
  isStageable,
} from "./tui/audition.ts";
import { EuclidEditor, type EuclidContext } from "./tui/euclid.ts";
import {
  ARROW_DOWN,
  ARROW_UP,
  closesKeys,
  HINTS,
  KEYS,
  keyLines,
  type KeySection,
} from "../tui/grammar.ts";
import { renderAudition } from "./audio/audition.ts";
import {
  exportScore,
  loopedSection,
  playbackTime,
  scoreBeatAt,
} from "./audio/arrange.ts";
import { loopFlash, reelGlyph } from "../tui/delight.ts";
import { formatForm } from "../core/sections.ts";
import type { ArrangeStripView } from "../tui/arrange-strip.ts";
import { renderScorePcm } from "./audio/wav.ts";
import type { PreviewHost } from "./agent/preview-tool.ts";
import { rhythmVoicePitch } from "../core/rhythm.ts";
import {
  applyChordsCommand,
  chordPhrase,
  defaultChordSettings,
  type ChordSettings,
} from "./tui/play-chords.ts";
import {
  cacheLines,
  kitListLines,
  kitTarget,
  packListLines,
  parseKitCommand,
  parsePackCommand,
  useKit,
  useSound,
  type KitCommand,
  type PackCommand,
} from "./commands/pack.ts";
import {
  describeWavetable,
  parseWavetableCommand,
  pickWavetable,
  wavetableListLines,
  wavetableParamEdit,
  type WavetableCommand,
} from "./commands/wavetable.ts";
import {
  ALIASED_PACK,
  DEFAULT_KITS,
  PackError,
  PackStore,
  banksOf,
  packCredits,
  writeCredits,
} from "./audio/packs.ts";
import { SharedLiveEngine, type LiveLink } from "./session/shared-live.ts";
import {
  addNote,
  applyScoreOperation,
  createScore,
  isSamplerInstrument,
  isTrackAudible,
  PACK_PREFIX,
  scoreFromJSON,
  SCORE_LIMITS,
  type SampleRef,
  type TrackScore,
  type ScoreOperation,
} from "../core/score.ts";
import { reconcileRhythm } from "../core/rhythm.ts";
import { decodeLoop, encodeLoop } from "../core/loop.ts";
import { scoreToMidi } from "../core/midi.ts";
import type { TrackScoreSnapshot } from "../tui/render.ts";
import { PromptModel } from "../tui/prompt.ts";
import {
  ESCAPE_FLUSH_MS,
  INPUT_FLUSH,
  PASTE_FLUSH_MS,
  TerminalInputDecoder,
} from "../tui/input.ts";
import {
  FrameGate,
  IDLE_HEARTBEAT_MS,
  MIN_FRAME_GAP_MS,
} from "../tui/frame-gate.ts";
import {
  CARD_GLOW_MS,
  composeFrame,
  isTooSmall,
  tooSmallKey,
  TuiApp,
  type AppView,
  type LoudnessView,
  type SyncState,
  type TypesIndicator,
} from "../tui/app.ts";
import type { DrawerView } from "../tui/drawer.ts";
import { crumbText } from "../tui/crumbs.ts";
import { fail, note, ok, toneOf, warn, type Receipt } from "../tui/activity.ts";
import { systemRunner } from "./auth/runner.ts";
import type { MediaServices } from "./media/types.ts";
import { encodeBuffer } from "../tui/screen.ts";
import { parseThemeName } from "../tui/theme.ts";
import { formatDiagnostic } from "../core/sdk/eval.ts";
import { isProject } from "./project/init.ts";
import {
  parseLaunchArgs,
  parsePaneArgs,
  type PaneArgs,
  parseSimpleArgv,
  resolveTrackArg,
} from "./launch-args.ts";
import { RENDER_USAGE, runRenderCommand } from "./render.ts";
import { typecheckProject } from "./project/typecheck.ts";
import {
  startProjectSync,
  type ProjectSync,
  type SyncHost,
} from "./project/sync.ts";

/** Set while `submit` runs a grammar reading, so it reads only once. */
let recovering = false;

/** Slash words `submit` handles itself (no parser in commandParses). */
const SLASH_HANDLED: ReadonlySet<string> = new Set([
  ...WINDOW_VERBS,
  "chords",
  "click",
  "help",
]);

/** Whether a bare command parses (no side effects): for typo suggestions. */
function parsesLocally(text: string): boolean {
  return commandParses(text, score);
}

const ESC = "\u001b[";
/** `/sessions` rows shown in the overlay. */
const MAX_LISTED_SESSIONS = 64;

/** Wraps a usage line at spaces before `width`, indenting continuations. */
function wrapUsage(text: string, width: number, indent: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const prefix = lines.length === 0 ? "  " : indent;
    if (line && prefix.length + line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.join(`\n${indent}`);
}
const HELP_TEXT = `dawg · local-first terminal music workstation

Usage:
  dawg [--new] [--session <name|id>] [--track <name>]
  dawg --import <file> --export <file>   convert a loop file (no session)
  dawg sessions
  dawg history [filters] [--json] [--follow]  edits and comments (--help)
  ${wrapUsage(RENDER_USAGE.replace(/^usage: /, ""), 76, "               ")}
  dawg init [dir]      song.ts, tracks/<slug>/track.ts and .dawg/sdk
  dawg check           typecheck + evaluate the project; exit 1 on problems
  dawg <command> --help  usage: sessions history render init check media model
  dawg doctor          audio backend, native sink and devices
  dawg media doctor|download|stems|analyze|notes|sample|lyrics  (--help)
  dawg --version

Display options:
  --reduce-motion   static hit/sustain states (also DAWG_REDUCE_MOTION=1)
  --theme <name>    default | high-contrast | mono (NO_COLOR forces mono)
  --no-mouse        keys only; no click/wheel reporting (also DAWG_MOUSE=0)

Prompt:
  Enter submit · Shift-Enter newline · Alt-Enter next · Ctrl-Q now / next
  Ctrl-Z undo · Ctrl-Y redo · Ctrl-O transcript · Esc close · Ctrl-C exit
  Space on an empty prompt toggles playback

Commands (bare music words; app commands take a slash):
${helpText()}

Agent (optional; the choice is saved and reused until you log out):
  dawg model key               find existing setups and pick a provider
  dawg model key gateway|openrouter|codex|claude
  dawg model [alias]           pick a model, with the cost per prompt
  dawg logout [provider] · dawg auth status [--check]
Unrecognized requests go to the agent once a provider is configured
(DAWG_PROVIDER=gateway|openrouter|codex|claude|auto, DAWG_MODEL=<alias>;
DAWG_AI=0 disables the agent).`;
const args = new Set(process.argv.slice(2));
/** One parse for every launch flag; problems are reported below. */
const launch = parseLaunchArgs(process.argv.slice(2));
const launchArgs = launch.ok ? launch.args : undefined;
const requestedSession = launchArgs?.session;
/** `--track` normalized as `/track` does; matched to an existing track below. */
let explicitTrack = launchArgs?.track?.id;
/** The focused track; claimed at startup unless `--track` is given. */
let requestedTrack = explicitTrack ?? "main";
const initialInstrument = isDrumInstrument(requestedTrack) ? "kit" : "sine";
const importPath = launchArgs?.importPath;
const exportPath = launchArgs?.exportPath;
// `dawg model key [provider]` is the canonical spelling of `dawg login`.
if (process.argv[2] === "model" && process.argv[3] === "key")
  process.exit(await runAuthCommand(["login", ...process.argv.slice(4)]));
if (["login", "logout", "auth", "model"].includes(process.argv[2] ?? ""))
  process.exit(await runAuthCommand(process.argv.slice(2)));
{
  // An unknown DAWG_MODEL is an error, never a silent fallback.
  const fromEnv = process.env.DAWG_MODEL?.trim();
  if (
    fromEnv &&
    !resolveModelChoice("gateway", fromEnv) &&
    !resolveModelChoice("openrouter", fromEnv)
  ) {
    process.stderr.write(
      `dawg: unknown DAWG_MODEL "${fromEnv.slice(0, 40)}"; use one of ${MODEL_CATALOG.map((row) => row.alias).join(", ")} or a vendor/model ID\n`,
    );
    process.exit(2);
  }
}
if (process.argv[2] === "sessions") {
  const usage =
    "usage: dawg sessions · lists this workspace's sessions, newest first (* marks the current one)";
  const parsed = parseSimpleArgv(process.argv.slice(3), 0);
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.problem} · ${usage}\n`);
    process.exit(2);
  }
  if (parsed.kind === "help") stdout.write(`${usage}\n`);
  else await printSessions(process.cwd(), stdout);
  process.exit(0);
}
if (process.argv[2] === "init" || process.argv[2] === "check") {
  const command =
    process.argv[2] === "init"
      ? (await import("./project/init.ts")).runInitCommand
      : (await import("./project/check.ts")).runCheckCommand;
  process.exit(
    await command(process.argv.slice(2), process.cwd(), stdout, process.stderr),
  );
}
if (process.argv[2] === "doctor") {
  const { runDoctorCommand } = await import("./audio/doctor.ts");
  process.exit(await runDoctorCommand(process.argv.slice(3), stdout));
}
if (process.argv[2] === "media") {
  const { runMediaCommand } = await import("./media/cli.ts");
  process.exit(
    await runMediaCommand(
      process.argv.slice(2),
      process.cwd(),
      stdout,
      process.stderr,
    ),
  );
}
if (process.argv[2] === "history") {
  const { runHistoryCommand } = await import("./history/cli.ts");
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.exit(
    await runHistoryCommand(
      process.argv.slice(2),
      process.cwd(),
      stdout,
      process.stderr,
      abort.signal,
    ),
  );
}
if (process.argv[2] === "render") {
  const { runRenderCommand } = await import("./render.ts");
  process.exit(
    await runRenderCommand(
      process.argv.slice(2),
      process.cwd(),
      stdout,
      process.stderr,
    ),
  );
}
if (args.has("--version") || args.has("-v")) {
  stdout.write(`dawg ${await packageVersion()}\n`);
  process.exit(0);
}
if (args.has("--help") || args.has("-h")) {
  stdout.write(`${HELP_TEXT}\n`);
  process.exit(0);
}
// Argument mistakes are rejected here, before `.dawg/` could be created.
{
  if (!launch.ok) {
    process.stderr.write(`${launch.problem} · dawg --help\n`);
    process.exit(2);
  }
}
// `--import X --export Y` converts one loop file to another: no session.
if (importPath && exportPath) {
  try {
    const converted = decodeLoop(await readLoopFile(importPath));
    await writeFile(resolve(exportPath), encodeLoop(converted), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const midi = /\.midi?$/i.test(importPath)
      ? " · MIDI files are not imported; --import takes a .track.json loop"
      : "";
    process.stderr.write(
      `dawg: cannot import ${importPath} · ${reason.split("\n")[0]!.slice(0, 160)}${midi}\n`,
    );
    process.exit(1);
  }
  stdout.write(`converted ${importPath} → ${exportPath}\n`);
  process.exit(0);
}
const demo =
  args.has("--demo") || process.env.DAWG_DEMO === "1" || !stdin.isTTY;
// Music first: the TUI opens directly. The first session with no provider
// (or a saved one that stopped working) gets one card instead of a picker.
const launchCard =
  !demo && process.env.DAWG_AI !== "0" && stdout.isTTY
    ? firstRunCard().catch(() => undefined)
    : undefined;

const initial = createScore({
  tracks: [
    {
      id: requestedTrack,
      name: requestedTrack,
      instrument: initialInstrument,
      // `dawg jangle`: a guitar alias starts with its voice and rig.
      ...rigTrackFields(requestedTrack),
    },
  ],
});
const sessionOptions: { sessionId?: string; setCurrent: boolean } = {
  setCurrent: !requestedSession || args.has("--new"),
};
const selectedSession = args.has("--new")
  ? randomUUID()
  : requestedSession === undefined
    ? undefined
    : await resolveSessionArg(process.cwd(), requestedSession).catch(
        (error: unknown) => {
          if (!(error instanceof SessionLookupError)) throw error;
          process.stderr.write(`${error.message}\n`);
          process.exit(1);
        },
      );
if (selectedSession !== undefined) sessionOptions.sessionId = selectedSession;
/** True when this launch creates `.dawg/`; the strip says so once. */
const freshWorkspace = !(await stat(join(process.cwd(), ".dawg")).then(
  () => true,
  () => false,
));
// Decode the import before a session exists, so a bad file is one line.
let importedScore: TrackScore | undefined;
if (importPath) {
  try {
    importedScore = decodeLoop(await readLoopFile(importPath));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const midi = /\.midi?$/i.test(importPath)
      ? " · MIDI files are not imported; --import takes a .track.json loop"
      : "";
    process.stderr.write(
      `dawg: cannot import ${importPath} · ${reason.split("\n")[0]!.slice(0, 160)}${midi}\n`,
    );
    process.exit(1);
  }
}
// A demo frame only renders: with no workspace yet (and nothing imported),
// it runs on a throwaway session so the cwd gets no `.dawg/`.
const ephemeralWorkspace =
  demo && freshWorkspace && !importPath && selectedSession === undefined
    ? await mkdtemp(join(tmpdir(), "dawg-demo-"))
    : undefined;
const session = await ensureSession(initial.toJSON(), {
  ...sessionOptions,
  ...(ephemeralWorkspace ? { workspace: ephemeralWorkspace } : {}),
});
// Who is at this window; also salts collision-free ids (core/ids.ts).
const actor = await currentActor();
// dawgd when connected, the file-lock path otherwise (see src/session/port.ts).
let port = await openSessionPort<ReturnType<TrackScore["toJSON"]>>({
  actor,
  paths: session.paths,
  sessionId: session.record.sessionId,
  label: explicitTrack ?? "window",
  focusedTrackId: explicitTrack ?? null,
  daemon: !demo,
});
let record: SessionRecord<ReturnType<TrackScore["toJSON"]>> =
  port.mode === "daemon" ? await port.load() : session.record;
let score = scoreFromJSON(record.composition);
if (importPath && importedScore) score = importedScore;
// `--track Bass` focuses an existing `bass` (or a track named "Bass").
if (launchArgs?.track) {
  explicitTrack = resolveTrackArg(score.tracks, launchArgs.track);
  requestedTrack = explicitTrack;
}
if (importPath && importedScore) {
  score = importedScore;
  record = await port.append(
    record,
    {
      kind: "score.import",
      payload: { path: importPath },
    },
    score.toJSON(),
  );
}
/** True while the focused track is a reserved draft not yet in the score. */
let draftTrack = false;
let attachNotice = "";
if (!demo) {
  const attached = await attachTrack(port, score, explicitTrack);
  requestedTrack = attached.trackId;
  draftTrack = attached.draft;
  attachNotice = attached.draft
    ? ALL_TRACKS_OPEN_HINT
    : attached.reason === "claimed" && score.tracks.length > 1
      ? `opened · ${requestedTrack}`
      : "";
} else if (explicitTrack === undefined)
  requestedTrack = score.tracks[0]?.id ?? requestedTrack;
if (!draftTrack) await ensureFocusedTrack();

const clock = new TransportClock(score.tempoBpm);
let audio = port.player;
let audioInfoCache: AudioBackendInfo | undefined;
let audioMenuCache: { at: number; state: MenuAudioDevices } | undefined;
/** Session and today's spend, from the usage each response reports. */
const meter = new SpendMeter(configDir());
void meter.load().catch(() => undefined);
const prompt = new PromptModel({ width: 72, maxVisualRows: 8 });
const tui = new TuiApp({
  io: {
    write: (data) => stdout.write(data),
    columns: () => stdout.columns ?? 80,
    rows: () => stdout.rows ?? 24,
  },
  prompt,
  theme: launchArgs?.theme ?? parseThemeName(process.env.DAWG_THEME),
  reducedMotion:
    args.has("--reduce-motion") || process.env.DAWG_REDUCE_MOTION === "1",
});
let syncState: SyncState = port.sync;
let windowCount = 1;
/** Pin and follow (§12.5): set by `dawg pane …`, `pin` and `follow`. */
const paneOptions: { pinned: boolean; follow: string | undefined } = {
  pinned: false,
  follow: undefined,
};
/** Every pane on this session, as the last presence push listed them. */
let panePresence: readonly PresenceEntry[] = [];
/** The last view this pane reported (JSON), so unchanged views stay quiet. */
let reportedView = "";
let sharedLive: { link: LiveLink; engine: SharedLiveEngine } | undefined;
/** Project file sync when `dawg.json` is in the working directory. */
let projectSync: ProjectSync | undefined;
let packStore: PackStore | undefined;
let reportedSampleProblems = "";
let sampleLibrary: SampleLibrary | undefined;
let typesIndicator: TypesIndicator | undefined;
let announcedName = record.meta.name;
let namer = makeNamer();
/** Re-subscribes the TUI after /fork or /resume replaces `port`. */
let rebindPort: () => void = () => undefined;
/** Play mode's controller; kept across entries so settings persist. */
let play: PlaySession | undefined;
/** Chord-mode settings, shared by every track's play session. */
const chordSettings = defaultChordSettings();
/** The hand-editing menu (`/menu`, Ctrl-K), drawn as the picker overlay. */
const menu = new EditMenu();
/** The Euclidean rhythm editor (`/euclid`, Rhythm in `/menu`). */
const euclid = new EuclidEditor();
/** Live voice id for auditions (play-mode voices use small positive ids). */
const AUDITION_VOICE = 0x7fff_0001;
/** A voice to audition once the editor's queued command lands. */
let pendingAudition: string | undefined;
/** The pattern the /pattern picker last previewed. */
let patternPreview: string | undefined;
/** Daemon windows play no loop; play mode monitors through its own engine. */
let monitorEngine: AudioEngine | undefined;
/** The audition loop and staged edits (src/tui/audition.ts), made lazily. */
let auditionLoop: Audition | undefined;
/** Pickers that host the audition loop (Space, `a`, `c`, hover). */
const AUDITION_PICKERS = new Set([
  "kit",
  "pattern",
  "try",
  "patch-add",
  "presets",
  "preset",
]);
/** Starred presets, read once from disk (src/audio/preset-favorites.ts). */
let presetFavorites: Set<string> | undefined;
/** The preset the browser last previewed (one phrase per move). */
let presetPreviewed: string | undefined;
const TRY_USAGE =
  "/try <sound command> · /try fx reverb mix 0.6 · /try agent on|off";
/** Whether the agent's preview_sound plays its snippet in this window. */
let agentPreviewPlays = process.env.DAWG_AGENT_PREVIEW !== "off";
const AGENT_PREVIEW_VOICE = 0x7fff_0002;
/**
 * Set while a staged command runs: `commitScore` hands its result here
 * instead of appending, and a remote revision that lands meanwhile waits in
 * `committed` (the window's `score` is the staged base until it finishes).
 */
/** A `/chords …` settings command (staged as window state, not a score edit). */
const CHORDS_COMMAND = /^\/chords\s+(.+)$/i;
/** Whether the chord settings screen was open at the last menu redraw. */
let chordScreenWas = false;
/** The range clipboard (`copy bass 5-6`, then `paste at 9`); per window. */
let rangeClipboard: RangeClipboard | undefined;
/**
 * The patch view (patcher design §7): on, and its pane state (which
 * patch, the focused pane, the node, port and matrix cell, the knob).
 * Each key runs a typed `patch …` command.
 */
const patchView: {
  on: boolean;
  state: PatchViewState;
  /** The cables last painted, so a new one (typed, agent, other pane) is shown. */
  cables?: Readonly<{ key: string; list: readonly Cable[] }> | undefined;
} = {
  on: false,
  state: patchViewState(),
};
/**
 * TAPE (op1-ux §6): on, its zoom, its knob strip, the last view painted
 * (mouse hits map cells to bars through it), a ruler drag in progress, and
 * the pending cut (the score before and after its clear) so the first
 * paste after it runs `move` against the score the cut came from.
 */
const tape: {
  on: boolean;
  zoom: TapeZoom;
  knobs: KnobState;
  view?: TapeView | undefined;
  drag?: { from: number; to: number; left: number; first: number } | undefined;
  cut?: { before: TrackScore; after?: TrackScore | undefined } | undefined;
  /** Set by `x`: the score before it, until its `clear` lands. */
  cutArmed?: TrackScore | undefined;
  /** Set by the first `v` after a cut: its `move` reads `cut.before`. */
  foldArmed?: boolean | undefined;
  /**
   * Where a paste's queued `jump` will put the playhead (a score beat),
   * so a quick `v v v` tiles before that jump has run.
   */
  pending?: { beat: number; until: number } | undefined;
} = { on: false, zoom: "beat", knobs: { selected: 0 } };
let stageCapture: { next?: TrackScore; committed?: TrackScore } | undefined;
/** Redraw soon (the audition reports renders between frames). */
let requestFrame: () => void = () => undefined;
/** Queue a prompt to run as if typed (set by the interactive loop). */
let runPromptLater: (command: string) => void = () => undefined;
/** Queue several prompts, in order, ahead of anything already queued. */
let runPromptsLater: (commands: readonly string[]) => void = () => undefined;
/** True while a queued prompt is running or waiting (set by the loop). */
let promptQueueBusy: () => boolean = () => false;
/**
 * Queue a step that decides its prompts when its turn comes, after what is
 * already queued has run (set by the interactive loop).
 */
let runStepLater: (step: () => readonly string[]) => void = () => undefined;
/** The fader drawer's focus and typing, while one is open over the menu. */
let fader: FaderState | undefined;
/** Session history (src/history/wire.ts): the handle, /comment, /history. */
const historyHost: HistoryHost = {
  workspace: ephemeralWorkspace ?? process.cwd(),
  sessionId: () => record.sessionId,
  revision: () => record.revision,
  score: () => score,
  clientId: () => port.clientId,
  actorId: () => actor.id,
  presence: () =>
    panePresence.find((entry) => entry.clientId === port.clientId),
  focusedTrack: () => requestedTrack,
  playheadBeat: () => scoreBeatAt(score, clock.beatAt()),
  playing: () => clock.playing,
  focusedParam: () => fader?.label.slice(0, 64),
  patchNode: () => undefined,
  screen: () => paneView().screen ?? "home",
  ascii: () => !tui.capabilities.unicode,
};
const history = wireHistory(historyHost);
/** Show-me state (see the show-me section below). */
/** A TAPE gesture's typed command, echoed dimly in the prompt row. */
const gestureEcho: {
  text?: string | undefined;
  clear?: ReturnType<typeof setTimeout> | undefined;
} = {};

/** `.dawg/agent.json` shell switch, for the Project › agent › shell row. */
let agentShellOn = false;
async function refreshAgentShell(): Promise<void> {
  agentShellOn =
    (await readAgentSettings(process.cwd()).catch(() => undefined))?.shell ??
    false;
}
void refreshAgentShell();

const showMe: {
  level: ShowMeLevel;
  ghost?: string | undefined;
  caption?: string | undefined;
  commands: string[];
  notes: NoteScheduler;
  clear?: ReturnType<typeof setTimeout> | undefined;
} = {
  level: parseShowMe(process.env.DAWG_SHOWME ?? "") ?? "on",
  commands: [],
  notes: new NoteScheduler(() => score.tempoBpm),
};
if (!process.env.DAWG_SHOWME)
  void readConfig({ dir: configDir() })
    .then((config) => {
      if (config.showMe) showMe.level = config.showMe;
    })
    .catch(() => undefined);
/** The fader bar a left-button drag started on. */
let dragging: { field: number; left: number; width: number } | undefined;
/** The open drawer came from a command, not the menu. */
let faderStandalone = false;
/** Per-field sequence: a drag drops stale stages that would land late. */
const faderSeq = new Map<string, number>();
/** The decoded sampler voices, for play mode's live voices. */
let liveSampleBank: SampleBank | undefined;
/** The in-flight agent turn: Esc aborts it, Enter steers it. */
let agentTurn: { controller: AbortController; steering: string[] } | undefined;
let reportAgentActivity: (text: string) => void = () => undefined;
// Declared before `await runInteractive()` runs, or assigning it is a TDZ error.
let agentEventSink: (event: AgentEvent) => void = () => undefined;
/** Resolved lazily (and again after /login); `undefined` until first needed. */
let provider: Promise<ProviderSelection> | undefined;
let providerStamp = { fingerprint: "", at: 0, offline: false };
let providerName = "";
/** Undo/redo key hints shown so far; only the first few receipts carry one. */
let undoHintsShown = 0;
const MAX_UNDO_HINTS = 3;
let invalidNoticeShown = false;
/** True while /login has handed the terminal to a shell flow. */
let screenSuspended = false;
/** Redraw from outside the input loop (usage arrives asynchronously). */
let tickUi: () => void = () => undefined;
/** Suspend the TUI around an interactive shell flow (set by runInteractive). */
let handoff: <T>(flow: () => Promise<T>) => Promise<T> = (flow) => flow();

/** `$0.12 session · $0.48 today · opus-5.5 · gateway`, sized to the width. */
function spendLine(): string {
  const width = stdout.columns ?? 80;
  if (!providerName || providerName === "offline")
    // A state, not a nag: the first session's card already named /login.
    return width >= 40 ? formatSpendLine({ kind: "offline" }) : "";
  const [model, provider] = providerName.split(" · ");
  return formatSpendLine(
    {
      kind: providerSnapshot?.kind === "xcb" ? "subscription" : "api",
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      sessionUsd: meter.sessionUsd,
      todayUsd: meter.todayUsd,
    },
    Math.max(0, width - 8),
  );
}
let providerSnapshot: ProviderSelection | undefined;
if (demo) {
  if (score.notes.length === 0) score = seedDemo(score, requestedTrack);
  if (exportPath)
    await writeFile(resolve(exportPath), encodeLoop(score), "utf8");
  renderOnce(
    score,
    clock.beatAt(),
    "demo · press space to play",
    "add C4 at 0 for 1",
    0,
  );
  if (ephemeralWorkspace) {
    await port.close().catch(() => undefined);
    await rm(ephemeralWorkspace, { recursive: true, force: true });
  }
  process.exit(0);
}

if (exportPath) {
  await writeFile(resolve(exportPath), encodeLoop(score), "utf8");
  if (!stdin.isTTY) process.exit(0);
}

await runInteractive();

async function packageVersion(): Promise<string> {
  return (await import("./version.ts")).VERSION;
}

function seedDemo(value: TrackScore, trackId: string): TrackScore {
  const instrument = value.tracks.find(
    (track) => track.id === trackId,
  )?.instrument;
  if (isDrumInstrument(instrument)) return seedDemoDrums(value, trackId);
  return addNote(
    addNote(
      addNote(value, {
        id: "demo-1",
        trackId,
        startTick: 0,
        durationTicks: 240,
        pitch: 60,
        velocity: 0.9,
      }),
      {
        id: "demo-2",
        trackId,
        startTick: 480,
        durationTicks: 480,
        pitch: 64,
        velocity: 0.75,
      },
    ),
    {
      id: "demo-3",
      trackId,
      startTick: 960,
      durationTicks: 240,
      pitch: 67,
      velocity: 0.85,
    },
  );
}

/** A one-bar kick/snare/hat groove for a drum track in demo mode. */
function seedDemoDrums(value: TrackScore, trackId: string): TrackScore {
  const hits: Array<["kick" | "snare" | "hat", number, number]> = [
    ["kick", 0, 0.95],
    ["hat", 0.5, 0.6],
    ["snare", 1, 0.85],
    ["hat", 1.5, 0.6],
    ["kick", 2, 0.9],
    ["hat", 2.5, 0.6],
    ["snare", 3, 0.85],
    ["hat", 3.5, 0.6],
  ];
  return hits.reduce(
    (next, [voice, beat, velocity], index) =>
      addNote(next, {
        id: `demo-${index + 1}`,
        trackId,
        startTick: Math.round(beat * next.ticksPerBeat),
        durationTicks: Math.round(next.ticksPerBeat / 4),
        pitch: drumVoicePitch(voice),
        velocity,
      }),
    value,
  );
}

function snapshot(
  value: TrackScore,
  beat: number,
  activity?: string,
): TrackScoreSnapshot {
  const focused = value.tracks.find((track) => track.id === requestedTrack);
  const table =
    focused && !isDrumInstrument(focused.instrument)
      ? resolveTuning(value.tuning, focused.tuning, value.key)
      : undefined;
  const notes = value.notes
    .filter((note) => note.trackId === requestedTrack)
    .map((note) => {
      const tag =
        focused && !isDrumInstrument(focused.instrument)
          ? displayTag(table, note.pitch, note.cents)
          : undefined;
      return {
        id: note.id,
        startBeat: note.startTick / value.ticksPerBeat,
        durationBeats: note.durationTicks / value.ticksPerBeat,
        pitch: note.pitch,
        velocity: note.velocity,
        muted: focused?.muted,
        ...(tag?.cents !== undefined ? { cents: tag.cents } : {}),
        ...(tag?.name !== undefined ? { centsFrom: tag.name } : {}),
        ...(note.lyric !== undefined ? { lyric: note.lyric } : {}),
      };
    });
  // 0.7 clips: the clip row; peaks load off the frame path, then redraw.
  const clips = clipSnapshots(value, requestedTrack);
  if (clips)
    void loadClipPeaks(process.cwd(), focused).then((changed) => {
      if (changed) requestFrame();
    });
  return {
    notes,
    ...(clips ? { clips } : {}),
    trackName:
      value.tracks.find((track) => track.id === requestedTrack)?.name ??
      requestedTrack,
    trackId: requestedTrack,
    sessionId: record.sessionId,
    revision: shownRevision(record),
    bpm: value.time?.tempo
      ? bpmAtTick(value, beat * value.ticksPerBeat)
      : value.tempoBpm,
    key: value.key ?? undefined,
    loopBeats: loopTicksOf(value) / value.ticksPerBeat,
    ...(value.loop ? { loopRange: value.loop } : {}),
    beatsPerBar: value.beatsPerBar,
    ...(hasMeterChanges(value)
      ? {
          barBeats: Array.from(
            { length: value.bars },
            (_, bar) => barStartTick(value, bar) / value.ticksPerBeat,
          ),
        }
      : {}),
    laneCount: 24,
    currentBeat: scoreBeatAt(value, beat),
    playing: clock.playing,
    activity,
    ...(focused?.instrument === "vocal" ? { vocal: true } : {}),
    ...drumSnapshotFields(
      value.tracks.find((track) => track.id === requestedTrack)?.instrument,
      notes,
    ),
    ...samplerSnapshotFields(
      value.tracks.find((track) => track.id === requestedTrack),
      notes,
    ),
    ...(table && table.linear && table.size !== 12
      ? { tuningPeriod: { size: table.size, root: table.root } }
      : {}),
    pitchTrace: pitchTraceFor(requestedTrack, value),
    layers:
      tui.highwayView === "all"
        ? highwayLayers(
            value.tracks,
            value.notes,
            value.ticksPerBeat,
            requestedTrack,
          )
        : undefined,
  };
}

function renderOnce(
  value: TrackScore,
  transportBeat: number,
  activity?: string,
  draft = "",
  nowMs = Date.now(),
): void {
  if (activity) tui.activity.pushCard(activity, { tone: "info" });
  if (draft) tui.input({ type: "paste", text: draft });
  const frame = composeFrame(
    appView(value, transportBeat),
    tui.ui,
    { width: Math.max(24, stdout.columns ?? 80), height: 20 },
    nowMs,
  );
  stdout.write(`${encodeBuffer(frame.buffer, tui.capabilities)}\n`);
}

function appView(value: TrackScore, beat: number): AppView {
  return {
    score: snapshot(value, beat),
    // The highway shows score time: inside the looped section or form pass.
    beat: scoreBeatAt(value, beat),
    arrange: arrangeStripView(value, beat),
    // `opus-5.5 · gateway`, `sonnet · claude`; hidden when offline.
    model:
      providerName && providerName !== "offline" ? providerName : undefined,
    spend: spendLine(),
    agentOffline: providerName === "offline" || process.env.DAWG_AI === "0",
    showMe:
      showMe.ghost || showMe.caption
        ? { ghost: showMe.ghost, caption: showMe.caption }
        : gestureEcho.text
          ? { caption: gestureEcho.text }
          : undefined,
    sync: syncState,
    sessionName: record.meta.name,
    windows: windowCount,
    pane: port.pane,
    types: typesIndicator,
    play: play?.on ? play.header() : undefined,
    tape:
      tape.on && !play?.on && !patchView.on
        ? currentTapeView(value, beat)
        : undefined,
    patch: patchView.on && !play?.on ? currentPatchPaint(value) : undefined,
    loudness: masterLoudness(value),
  };
}

/**
 * The 48 kHz reading of the mastered song (what `master measure` and the
 * export read), for the score it measured; one measurement at a time, in a
 * worker, started when the loop plays a mastered score it has not read.
 */
let exportMeter:
  { score: TrackScore; view?: LoudnessView; running: boolean } | undefined;

/**
 * The header meter: loudness of the loop the local engine is playing. With
 * a master the engine monitors at its own rate, so the meter shows the
 * export-rate reading once it is in and the monitor's (marked as an
 * estimate) until then.
 */
function masterLoudness(value: TrackScore): LoudnessView | undefined {
  const engine = audio instanceof AudioEngine ? audio : monitorEngine;
  const report = engine?.loudness;
  if (!report) return undefined;
  const ceiling =
    typeof value.master?.limiter?.ceiling === "number"
      ? value.master.limiter.ceiling
      : value.master?.limiter
        ? -1
        : undefined;
  const target =
    typeof value.master?.target === "number" ? value.master.target : undefined;
  const monitor: LoudnessView = {
    integrated: report.integrated,
    truePeak: report.truePeak,
    target,
    ceiling,
  };
  if (!value.master || exportSampleRate(value) === engine.sampleRate)
    return monitor;
  if (exportMeter?.score === value && exportMeter.view) return exportMeter.view;
  if (!exportMeter?.running) {
    const measuring = { score: value, running: true } as NonNullable<
      typeof exportMeter
    >;
    exportMeter = measuring;
    void measureScoreOffThread(value, { projectRoot: process.cwd() })
      .then((measured) => {
        measuring.view = {
          integrated: measured.mix.loudness.integrated,
          truePeak: measured.mix.loudness.truePeak,
          target,
          ceiling,
        };
      })
      .catch(() => undefined)
      .finally(() => {
        measuring.running = false;
      });
  }
  return { ...monitor, estimate: true };
}

/** The arrangement strip over the timeline; absent without sections. */
function arrangeStripView(
  value: TrackScore,
  beat: number,
): ArrangeStripView | undefined {
  if (value.sections.length === 0) return undefined;
  return {
    bars: value.bars,
    sections: value.sections,
    loop: value.loopSection,
    playheadBar: scoreBeatAt(value, beat) / value.beatsPerBar,
    form: value.form.length ? formatForm(value.form) : undefined,
  };
}

/** What the strip compares a receipt against: the revision and score before. */
type Baseline = { revision: number; score: TrackScore };
function baseline(): Baseline {
  return { revision: record.revision, score };
}

/**
 * Show a command receipt in the activity strip. The tone comes from the
 * receipt itself (strings fall back to a legacy regex); the revision label
 * appears when the revision moved, and the undo hint only when the score
 * changed in this session (not for forks, resumes or transport).
 */
function receipt(result: string | Receipt, base?: Baseline): void {
  const message = typeof result === "string" ? result : result.text;
  const tone = toneOf(result);
  const changed = base !== undefined && record.revision !== base.revision;
  const scoreChanged =
    changed && record.sessionId !== undefined && score !== base.score;
  if (tone === "error") {
    tui.activity.pushError(message);
    return;
  }
  // A receipt that names its own undo key needs no second hint.
  const hint =
    scoreChanged &&
    undoHintsShown < MAX_UNDO_HINTS &&
    !message.endsWith("ctrl-z undo")
      ? message.startsWith("undid")
        ? "ctrl-y redo"
        : "ctrl-z undo"
      : undefined;
  if (hint) undoHintsShown += 1;
  tui.activity.pushCard(message, {
    tone,
    baseRevision: changed ? shownRevision(record, base.revision) : undefined,
    resultRevision: changed ? shownRevision(record) : undefined,
    hint,
    trackId: requestedTrack,
  });
}

/** One shape for thrown errors: `<what> · <why> · <next step>`. */
function describeError(command: string, error: unknown): string {
  const detail = error as { code?: unknown; path?: unknown } | undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (detail?.code === "ENOENT" && typeof detail.path === "string")
    return `no such file · ${relative(process.cwd(), detail.path)}`;
  // `tempo 900` → `tempo 900 · tempo takes 20…300 BPM · tempo 128`: no raw
  // core keys (`tempoBpm`) on a card.
  const friendly = friendlyCoreError(truncateForCard(command), message);
  if (friendly) return friendly;
  const verb = command.trim().split(/\s+/)[0]?.replace(/^\//, "") || "command";
  return `${verb} failed · ${message}`;
}

function truncateForCard(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 32 ? `${line.slice(0, 31)}…` : line;
}

/**
 * Mouse reporting is on unless `--no-mouse` or `DAWG_MOUSE=0` (or a dumb
 * terminal) says otherwise. A terminal without mouse support ignores the
 * modes and every key still works.
 */
function mouseEnabled(): boolean {
  return (
    !process.argv.includes("--no-mouse") &&
    process.env.DAWG_MOUSE !== "0" &&
    process.env.TERM !== "dumb"
  );
}

function mouseOn(): string {
  return mouseEnabled() ? MOUSE_ON : "";
}

/**
 * Mouse off, plain colors, plain paste, cursor shown, main screen.  A
 * function, not a const: `await runInteractive()` runs above this line.
 */
function terminalRestore(): string {
  return `${MOUSE_OFF}${ESC}0m${ESC}?2004l${ESC}?25h${ESC}?1049l`;
}

/** `dawg: <stack>` for a crash printed after leaving the alternate screen. */
function crashText(error: unknown): string {
  const text =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return `dawg: ${text}\n`;
}

async function runInteractive(): Promise<void> {
  // Every way out (quit, a failing teardown step, a crash, a kill, a stray
  // process.exit) restores the whole terminal, once, synchronously: the
  // shell must not stay on the alternate screen with paste brackets on.
  let terminalRestored = false;
  const restoreTerminal = () => {
    if (terminalRestored) return;
    terminalRestored = true;
    try {
      stdin.setRawMode?.(false);
    } catch {
      // stdin may already be closed.
    }
    try {
      writeSync(1, terminalRestore());
    } catch {
      // The terminal may already be gone (SIGHUP).
    }
  };
  process.once("exit", restoreTerminal);
  // A kill or a closed terminal: restore it, then exit as killed.
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)
    process.once(signal, () => {
      restoreTerminal();
      process.exit(code);
    });
  // An exception nothing caught leaves the editor in an unknown state: leave
  // the alternate screen first, so the stack lands in the shell, then exit.
  const onUncaught = (error: unknown) => {
    restoreTerminal();
    try {
      writeSync(2, crashText(error));
    } catch {
      // Nowhere left to report it.
    }
    process.exit(1);
  };
  // A rejected fire-and-forget promise is one failed action, not a broken
  // editor: report it on the activity strip and repaint over anything the
  // runtime wrote.
  const onRejection = (error: unknown) => {
    if (terminalRestored || screenSuspended) {
      try {
        writeSync(2, crashText(error));
      } catch {
        // Nowhere left to report it.
      }
      return;
    }
    tui.activity.pushError(
      `failed · ${error instanceof Error ? error.message : String(error)}`,
    );
    tui.invalidate();
    requestFrame();
  };
  // Runtime warnings and console output would land on top of the frame; the
  // writer never repaints rows it did not change.  Route them to the
  // transcript instead, and repaint.
  const onWarning = (warning: Error) => {
    if (screenSuspended || terminalRestored) return;
    tui.activity.pushNote(`warning · ${warning.message}`, "error");
    tui.invalidate();
    requestFrame();
  };
  const consoleError = console.error;
  const consoleWarn = console.warn;
  const consoleToTranscript =
    (original: (...data: unknown[]) => void) =>
    (...data: unknown[]) => {
      if (screenSuspended || terminalRestored) return original(...data);
      tui.activity.pushNote(
        data
          .map((item) => (item instanceof Error ? item.message : String(item)))
          .join(" "),
        "error",
      );
      tui.invalidate();
      requestFrame();
    };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  process.on("warning", onWarning);
  console.error = consoleToTranscript(consoleError);
  console.warn = consoleToTranscript(consoleWarn);
  stdin.setRawMode?.(true);
  stdin.resume();
  // Alternate screen, hidden cursor, bracketed paste.
  stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h${ESC}2J${mouseOn()}`);
  const inputDecoder = new TerminalInputDecoder();
  const queuedPrompts = new PromptQueue();
  let processingQueue = false;
  // Undo/redo runs beside the queue (it must not wait on an agent turn), so
  // a queued line waits for it instead: started before the undo's append
  // has resolved, it would append against the old revision and fail with a
  // conflict (Ctrl-Z then V on TAPE: `copy failed · session changed`).
  let historyStep: Promise<unknown> = Promise.resolve();
  // `DAWG_STATE_OSC=1` (the PTY tests): each tick ends with an invisible
  // `OSC 7799 ; <json> BEL` saying how many input bytes the editor has acted
  // on and whether anything it started is still running, so a test waits
  // for the editor to settle instead of sleeping or matching early text.
  const stateOsc = process.env.DAWG_STATE_OSC === "1";
  let reportedState = "";
  /** Input bytes received, and of those the ones the key loop finished. */
  let inputReceived = 0;
  let inputHandled = 0;
  /** Key-loop work in flight that is not a queued prompt (Ctrl-T, undo…). */
  let inflight = 0;
  const settling = <T>(work: Promise<T>): Promise<T> => {
    inflight += 1;
    return work.finally(() => {
      inflight -= 1;
      requestFrame();
    });
  };
  const editorState = (): string =>
    JSON.stringify({
      in: inputHandled,
      busy:
        processingQueue ||
        queuedPrompts.length > 0 ||
        inflight > 0 ||
        agentTurn !== undefined ||
        inputDecoder.pending() !== undefined,
      rev: record.revision,
      track: requestedTrack,
      screen: paneView().screen,
      overlay: tui.ui.overlay ?? null,
    });
  const runPrompt = async (text: string): Promise<void> => {
    const ui = tui.command(text);
    if (ui !== undefined) {
      if (typeof ui === "string") tui.activity.pushCard(ui, { tone: "info" });
      else tui.activity.pushCard(ui.text, { tone: toneOf(ui) });
      return;
    }
    tui.activity.pushRequest(text);
    const base = baseline();
    const baseSession = record.sessionId;
    try {
      const message = await submit(text);
      // Agent turns report through agentEventSink; skip a duplicate receipt.
      if (!agentReported) receipt(message, base);
      // Naming runs later on a timer; it never delays the next prompt.
      if (record.sessionId === baseSession)
        namer.noteTurn({
          score,
          prompt: text,
          accepted: record.revision !== base.revision,
        });
    } catch (error) {
      tui.activity.pushError(describeError(text, error));
    } finally {
      agentReported = false;
    }
  };
  let agentReported = false;
  /** A typed command during an agent turn; leaves the turn's receipt alone. */
  const runLocalBesideAgent = async (text: string): Promise<void> => {
    tui.activity.pushRequest(text);
    const base = baseline();
    try {
      receipt(await submit(text), base);
    } catch (error) {
      tui.activity.pushError(describeError(text, error));
    }
  };
  const drainQueue = async (): Promise<void> => {
    if (processingQueue) return;
    processingQueue = true;
    try {
      for (
        let nextPrompt = queuedPrompts.shift();
        nextPrompt !== undefined;
        nextPrompt = queuedPrompts.shift()
      ) {
        tui.activity.setQueueDepth(queuedPrompts.length);
        await historyStep;
        if (typeof nextPrompt === "function") {
          // A deferred step (a TAPE key typed ahead): its prompts run next,
          // reduced from what the lines before it left.
          queuedPrompts.runFirst(...nextPrompt());
          tick(true);
          continue;
        }
        await runPrompt(nextPrompt);
        if (pendingAudition && queuedPrompts.length === 0) {
          const voice = pendingAudition;
          pendingAudition = undefined;
          audition(voice);
        }
        tick(true);
      }
    } finally {
      processingQueue = false;
      tui.activity.setQueueDepth(queuedPrompts.length);
    }
  };
  // Builds a frame only when something can have changed (tui/frame-gate.ts):
  // an idle editor no longer rebuilds the whole view 30 times a second.
  const frameGate = new FrameGate(IDLE_HEARTBEAT_MS, MIN_FRAME_GAP_MS);
  // `DAWG_FRAME_LOG=<file>`: one `WxH ms bytes` line per frame (the size
  // matrix in test/sizes-lib.ts reads frame times from it).
  const frameLog = process.env.DAWG_FRAME_LOG;
  const unwatchActivity = tui.activity.subscribe(() => frameGate.markDirty());
  const animating = (): boolean => {
    if (clock.playing || play?.on || auditionLoop?.looping) return true;
    const activity = tui.activity;
    if (activity.spinner || activity.streaming) return true;
    if (tui.delight.animating(Date.now())) return true;
    const latest = activity.latest;
    return (
      !tui.ui.reducedMotion &&
      latest !== undefined &&
      Date.now() - latest.atMs < CARD_GLOW_MS
    );
  };
  const tick = (force = false) => {
    if (screenSuspended) return;
    reportView();
    // A state report always follows a frame built from that state.
    const state = stateOsc ? editorState() : "";
    const report = () => {
      if (state === reportedState) return;
      reportedState = state;
      stdout.write(`\u001b]7799;${state}\u0007`);
    };
    if (
      !frameGate.shouldBuild({
        nowMs: Date.now(),
        force: force || state !== reportedState,
        animating: animating(),
        keys: [
          score,
          record.revision,
          record.sessionId,
          record.meta.name,
          syncState,
          windowCount,
          panePresence,
          typesIndicator,
          menu.open,
          euclid.open,
          tui.ui.overlay,
        ],
      })
    ) {
      // No report here: a new state forces a build, so a skip means the
      // gate deferred that frame (too soon after the last). It stays dirty
      // and the next tick draws it, then reports; reporting now would tell a
      // waiting test the editor settled while the screen is a frame behind.
      return;
    }
    followCommitted();
    tui.delight.song(record.sessionId, record.meta.heardLoop === true);
    play?.tick();
    // Values in the menu follow the score as edits land.
    if (menu.open) refreshMenu();
    if (euclid.open) refreshEuclid();
    refreshAuditionPicker();
    // The gate already paces frames; the app's own throttle would drop an
    // approved frame that lands just after a forced one, and the gate would
    // not ask again until the heartbeat.
    const out = tui.render(appView(score, clock.beatAt()), { force: true });
    if (frameLog)
      appendFileSync(
        frameLog,
        `${stdout.columns ?? 0}x${stdout.rows ?? 0} ${tui.lastRenderMs.toFixed(3)} ${out.length}\n`,
      );
    if (stateOsc) report();
  };
  requestFrame = () => tick(true);
  // The first wrap is remembered per song in .dawg metadata, never the score.
  tui.onFirstLoop = () => {
    void port
      .updateMeta({ heardLoop: true })
      .then((result) => adoptMeta(result.meta))
      .catch(() => undefined);
  };
  runPromptLater = (command) => {
    queuedPrompts.runNow(command);
    void drainQueue();
  };
  runPromptsLater = (commands) => {
    queuedPrompts.runNow(...commands);
    void drainQueue();
  };
  promptQueueBusy = () => processingQueue || queuedPrompts.length > 0;
  runStepLater = (step) => {
    queuedPrompts.runNow(step);
    void drainQueue();
  };
  reportAgentActivity = () => {
    tui.activity.applyAgentEvent({ type: "start", model: providerName });
  };
  agentEventSink = (event) => {
    if (event.type === "usage") return;
    if (event.type === "command-typing") {
      showMeTyping(event.text);
      return;
    }
    if (event.type === "command") return;
    if (event.type === "tool-start") {
      const caption = toolCaption(event.name);
      if (caption) showMeCaption(caption);
    }
    if (event.type === "done" || event.type === "error") showMeFinish();
    tui.activity.applyAgentEvent(event);
    if (event.type === "done" || event.type === "error") agentReported = true;
  };
  // ~30 fps cap; the differential writer only emits changed rows.
  let timer = setInterval(tick, tui.frameIntervalMs);
  const onResize = () => {
    tui.invalidate();
    tick(true);
  };
  stdout.on("resize", onResize);
  const ownWrites = new OwnWrites();
  let presenceClients: readonly PresenceEntry[] = [];
  let applying: Promise<void> = Promise.resolve();
  const applyLatest = (latest: typeof record): Promise<void> =>
    (applying = applying.then(() => applyRecord(latest)));
  const applyRecord = async (latest: typeof record): Promise<void> => {
    try {
      // Queued before a /fork or /resume swapped the session: stale.
      if (latest.sessionId !== record.sessionId) return;
      if (latest.revision > record.revision) {
        const previousRevision = record.revision;
        const before = score;
        record = latest;
        if (stageCapture)
          stageCapture.committed = scoreFromJSON(record.composition);
        else score = scoreFromJSON(record.composition);
        clock.follow(score);
        if (clock.playing) void audio.play(score);
        // Connected windows follow dawgd's transport frames instead.
        const replay =
          port.mode === "file" ? latest.events.slice(previousRevision) : [];
        for (const event of replay) {
          if (
            event.kind !== "transport" ||
            typeof event.payload !== "object" ||
            event.payload === null
          )
            continue;
          const payload = event.payload as {
            action?: string;
            playing?: boolean;
            beat?: number;
          };
          if (
            typeof payload.playing === "boolean" &&
            typeof payload.beat === "number" &&
            Number.isFinite(payload.beat)
          ) {
            clock.sync(payload.beat, payload.playing, Date.parse(event.at));
            if (payload.playing) void audio.play(score, clock.beatAt());
            else audio.stop();
          } else if (typeof payload.playing === "boolean")
            await setTransport(payload.playing ? "play" : "pause");
          else if (payload.action === "play") await setTransport("play");
          else if (payload.action === "pause") await setTransport("pause");
          else if (payload.action === "toggle") await setTransport("toggle");
        }
        projectSync?.scoreChanged(score);
        // Another window's play/pause is followed, not announced, and this
        // window's own writes (which can echo back before the append
        // resolves) are never "synced".
        const from = shownRevision(record, previousRevision);
        const to = shownRevision(record);
        await ownWrites.settled();
        const foreignList = foreignEvents(
          latest,
          previousRevision,
          ownWrites,
        ).filter((event) => event.kind !== "transport");
        const foreign = foreignList.length > 0;
        // dawgd stamps each event's author: another pane's edit is its
        // letter and what it touched, only when it touches this pane's
        // track (§12.7); no "synced from another window" card.
        const letters = paneLetters(
          foreignList,
          presenceClients,
          port.clientId,
        );
        if (to !== from && foreign && letters.length > 0) {
          const edited = editedTrack(before, scoreFromJSON(latest.composition));
          if (edited === undefined || edited === requestedTrack)
            tui.activity.pushCard(
              `${letters.join(" ")} ✓ ${
                edited
                  ? (score.tracks.find((track) => track.id === edited)?.name ??
                    edited)
                  : "song"
              }`,
              { tone: "info", baseRevision: from, resultRevision: to },
            );
        } else if (to !== from && foreign)
          tui.activity.pushCard(
            `synced · ${otherWindowName(presenceClients, port.clientId, {
              editedTrackId: editedTrack(
                before,
                scoreFromJSON(latest.composition),
              ),
              trackName: (id) =>
                score.tracks.find((track) => track.id === id)?.name ?? id,
            })}`,
            { tone: "info", baseRevision: from, resultRevision: to },
          );
      }
    } catch {
      // An invalid composition is skipped; the next update retries.
    }
  };
  const onUpdate: Parameters<typeof port.subscribe>[0] = (update) => {
    if (update.type === "record") {
      void applyLatest(update.record);
      adoptMeta(update.record.meta);
    } else if (update.type === "meta") adoptMeta(update.meta);
    else if (update.type === "presence") {
      presenceClients = update.clients;
      followPresence(panePresence, update.clients);
      panePresence = update.clients;
      windowCount = update.clients.length;
    } else if (update.type === "sync") syncState = update.sync;
    else if (update.type === "transport") {
      // Every window renders the same hit line from dawgd's timestamp.
      const { playing, beat, bpm, atMs } = update.transport;
      clock.setTempo(bpm);
      clock.setTimeMap(transportMapFor(playbackTime(score)));
      clock.sync(beat, playing, atMs, monotonicEpochMs());
    } else if (update.type === "status") {
      syncState = port.sync;
      tui.activity.pushCard(update.message, {
        tone: syncState === "offline" ? "warning" : "info",
      });
    }
  };
  // Each subscription answers only while its port is the live one: /fork and
  // /resume swap the port, and a load the old port started before the swap
  // could otherwise land afterwards and pull the old session's name and
  // score into the new one.
  const subscribeLive = (): (() => void) => {
    const bound = port;
    ownWrites.attach(bound);
    return bound.subscribe((update) => {
      if (bound === port) onUpdate(update);
    });
  };
  let unsubscribe = subscribeLive();
  const refreshPresence = () =>
    void port
      .presence()
      .then((clients) => {
        presenceClients = clients;
        panePresence = clients;
        windowCount = Math.max(1, clients.length);
      })
      .catch(() => undefined);
  // File-lock windows have no presence push; poll the heartbeat files.
  const presenceTimer = setInterval(() => {
    if (port.mode === "file") refreshPresence();
  }, 2_000);
  refreshPresence();
  rebindPort = () => {
    unsubscribe();
    syncState = port.sync;
    unsubscribe = subscribeLive();
    refreshPresence();
    reportedView = "";
  };
  if (freshWorkspace)
    tui.activity.pushCard("created .dawg/ · add it to .gitignore", {
      tone: "info",
      once: true,
    });
  if (attachNotice)
    tui.activity.pushCard(attachNotice, {
      tone: "info",
      trackId: requestedTrack,
      hint: draftTrack ? "first edit creates it" : undefined,
    });
  if (port.status !== "file session")
    tui.activity.pushCard(port.status, { tone: "info" });
  void launchCard?.then((card) => {
    if (card) tui.activity.pushCard(card.text, { tone: card.tone, once: true });
  });
  if (await isProject(process.cwd()))
    projectSync = startProjectSync(syncHost());
  void currentProvider().then(() => tick(true));
  tickUi = () => tick(true);
  reportSampleProblems(score);
  if (launchArgs?.pane) void openPane(launchArgs.pane).then(() => tick(true));
  // Input arrives through a detachable listener (not `for await`), so /login
  // can hand the terminal to an interactive shell flow and take it back.
  const inbox: string[] = [];
  /** `inputReceived` as of each inbox entry: what handling it accounts for. */
  const inboxBytes: number[] = [];
  let takenBytes = 0;
  let wake: (() => void) | undefined;
  const onData = (chunk: Buffer | string) => {
    inputReceived +=
      typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    inbox.push(String(chunk));
    inboxBytes.push(inputReceived);
    wake?.();
  };
  const onEnd = () => {
    inbox.push("\u0000eof");
    inboxBytes.push(inputReceived);
    wake?.();
  };
  stdin.on("data", onData);
  stdin.on("end", onEnd);
  async function* chunks(): AsyncGenerator<string> {
    for (;;) {
      while (inbox.length === 0) {
        // A partial escape (Alt+[, a cut-off paste) is flushed after a short
        // idle so it never holds back the keys behind it.
        const held = inputDecoder.pending();
        const idle =
          held === "paste"
            ? PASTE_FLUSH_MS
            : held === "escape"
              ? ESCAPE_FLUSH_MS
              : undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await new Promise<boolean>((resolve) => {
          wake = () => resolve(false);
          if (idle !== undefined)
            timeout = setTimeout(() => resolve(true), idle);
        });
        clearTimeout(timeout);
        if (timedOut && inbox.length === 0) {
          wake = undefined;
          yield INPUT_FLUSH;
        }
      }
      wake = undefined;
      const next = inbox.shift()!;
      if (next === "\u0000eof") return;
      takenBytes = inboxBytes.shift() ?? takenBytes;
      yield next;
    }
  }
  handoff = async <T>(flow: () => Promise<T>): Promise<T> => {
    if (screenSuspended) return flow();
    screenSuspended = true;
    clearInterval(timer);
    stdin.off("data", onData);
    stdin.pause();
    stdin.setRawMode?.(false);
    // Leave the alternate screen; restore the cursor and plain paste.
    stdout.write(terminalRestore());
    try {
      return await flow();
    } finally {
      stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h${ESC}2J${mouseOn()}`);
      stdin.setRawMode?.(true);
      stdin.on("data", onData);
      stdin.resume();
      screenSuspended = false;
      timer = setInterval(tick, tui.frameIntervalMs);
      tui.invalidate();
      tick(true);
    }
  };
  tick(true);
  try {
    let exiting = false;
    for await (const text of chunks()) {
      // A read that is exactly ESC is the Esc key, not the start of a sequence.
      const values =
        text === INPUT_FLUSH
          ? inputDecoder.flush()
          : [
              ...inputDecoder.push(text),
              ...(text === "\u001b" ? inputDecoder.flush() : []),
            ];
      while (values.length) {
        const value = values.shift()!;
        // Below the minimum size only quit and play work; the hidden UI keeps
        // its state for when the terminal grows back (tui/app.ts).
        if (
          isTooSmall({ width: stdout.columns ?? 80, height: stdout.rows ?? 24 })
        ) {
          const key = tooSmallKey(value);
          if (key === "quit") {
            exiting = true;
            break;
          }
          if (key === "play")
            void settling(
              toggleTransport()
                .catch((error: unknown) => transportFailed(error))
                .finally(() => tick(true)),
            );
          continue;
        }
        // A mouse report acts on what the last frame painted under it; some
        // become keys (a list row, a wheel notch) and run through below.
        if (typeof value === "string" && isMouseSequence(value)) {
          const event = parseMouse(value);
          if (event) values.unshift(...mouseInput(event));
          tick(true);
          continue;
        }
        // The fader drawer owns every key while it is up.
        if (typeof value === "string" && fader && menu.open) {
          // Tab flips the knob front page and every param (design §8.6).
          if (value === "\t" && menu.knobPage && fader.typing === undefined) {
            const label = menu.pageKnobs(menuContext(), fader.label);
            if (label) fader.label = label;
            refreshMenu();
            tick(true);
            continue;
          }
          const result = faderKeyPress(
            fader,
            menu.faderFields(menuContext()),
            value,
            faderKeyOptions(),
          );
          if (result.type !== "pass") {
            faderOutcome(result);
            refreshMenu();
            tick(true);
            continue;
          }
        }
        // The `?` panel closes on esc or ?; other keys wait (Ctrl-C quits).
        if (tui.ui.keys && typeof value === "string" && value !== "\u0003") {
          if (closesKeys(value)) tui.closeKeys();
          tick(true);
          continue;
        }
        if (value === "?" && keysScreen()) {
          showKeys();
          tick(true);
          continue;
        }
        // The rhythm editor owns every key while it is up (Esc backs out).
        if (typeof value === "string" && euclid.open) {
          if (tui.ui.overlay !== "picker" || tui.ui.picker?.id !== "euclid")
            euclid.close();
          else {
            const result = euclid.key(value, euclidContext());
            if (result.type === "close") {
              const back = euclid.returnTo;
              euclid.close();
              tui.closePicker();
              if (back === "menu") openMenu();
              else leaveAuditionScreen();
            } else if (result.type === "run") {
              if (!stageIfAuditioning(result.command)) {
                queuedPrompts.runNow(result.command);
                if (result.audition) pendingAudition = result.audition;
                void drainQueue();
              }
            } else if (result.type === "audition") audition(result.voice);
            else if (result.type === "loop") auditionKeyPressed(result.key);
            else if (result.type === "revert") revertStaged();
            else if (result.type === "keep")
              void keepStaged()
                .then((outcome) => receipt(outcome))
                .catch((error) =>
                  tui.activity.pushError(describeError("keep", error)),
                )
                .finally(() => tick(true));
            if (result.type !== "pass") {
              refreshEuclid();
              tick(true);
              continue;
            }
          }
        }
        // The edit menu owns every key while it is up (Esc backs out).
        if (typeof value === "string" && menu.open) {
          if (tui.ui.overlay !== "picker" || tui.ui.picker?.id !== "menu")
            menu.close();
          else {
            const result = menu.key(value, menuContext());
            if (result.type === "close") {
              tui.closePicker();
              leaveAuditionScreen();
            } else if (result.type === "run") {
              if (!stageIfAuditioning(result.command)) {
                queuedPrompts.runNow(result.command);
                void drainQueue();
              }
            } else if (result.type === "audition")
              auditionKeyPressed(result.key);
            else if (result.type === "fader")
              openFader(
                menu.openKnobs(menuContext(), result.label) ?? result.label,
              );
            else if (result.type === "revert") revertStaged();
            else if (result.type === "hover")
              hoverItem(result.command, result.key);
            else if (result.type === "unhover")
              void auditionLoop
                ?.unhover(result.key)
                .finally(() => requestFrame());
            else if (result.type === "choose")
              chooseItem(result.command, result.key);
            else if (result.type === "keep")
              void keepStaged()
                .then((outcome) => receipt(outcome))
                .catch((error) =>
                  tui.activity.pushError(describeError("keep", error)),
                )
                .finally(() => tick(true));
            if (result.type !== "pass") {
              refreshMenu();
              tick(true);
              continue;
            }
          }
        }
        // F1 opens the guides from anywhere the prompt has focus.
        if (
          (value === "\u001bOP" || value === "\u001b[11~") &&
          (tui.ui.overlay === undefined || tui.ui.overlay === "guide")
        ) {
          if (tui.ui.overlay === "guide") tui.closeGuide();
          else tui.openGuide();
          tick(true);
          continue;
        }
        // Ctrl-K opens the menu on an empty prompt (in play mode too); with
        // text it keeps its kill-to-end-of-line meaning.
        if (
          value === "\u000b" &&
          prompt.value.length === 0 &&
          tui.ui.overlay === undefined
        ) {
          openMenu();
          tick(true);
          continue;
        }
        if (typeof value === "string" && play?.on && playKey(value)) {
          tick(true);
          continue;
        }
        if (typeof value === "string" && tape.on && tapeInput(value)) {
          tick(true);
          continue;
        }
        if (typeof value === "string" && patchView.on && patchInput(value)) {
          tick(true);
          continue;
        }
        // Ctrl-T opens TAPE (op1-ux §6); again (or esc) goes home.
        if (value === "\u0014" && tui.ui.overlay === undefined) {
          if (tape.on) receipt(exitTape());
          else
            void settling(
              enterTape()
                .then((outcome) => receipt(outcome))
                .finally(() => tick(true)),
            );
          tick(true);
          continue;
        }
        // Ctrl-P enters play mode. A bare `p` would steal the first letter of
        // `pan`, `pattern`, `play` and every prose request starting with p.
        if (value === "\u0010" && tui.ui.overlay === undefined) {
          void settling(
            enterPlay()
              .then((outcome) => receipt(outcome))
              .finally(() => tick(true)),
          );
          continue;
        }
        // The prompt is always focused, so ordinary `q` must remain typeable in
        // requests (for example, "quiet hi-hat"). Ctrl-C is the unambiguous
        // shell exit key; Ctrl-Q is reserved for prompt mode switching.
        // Keep the empty-prompt space shortcut for transport, while allowing
        // ordinary spaces once a request is being composed.
        if (
          value === " " &&
          prompt.value.length === 0 &&
          !(tui.ui.overlay === "picker" && tui.ui.picker?.audition) &&
          tui.ui.overlay !== "guide"
        ) {
          // Never await a daemon round trip here: the key loop must stay
          // live for Esc, quit and redraws while the toggle is in flight.
          void settling(
            toggleTransport()
              .catch((error: unknown) => transportFailed(error))
              .finally(() => tick(true)),
          );
        } else {
          const input = tui.input(value);
          const action = input.type === "action" ? input.action : undefined;
          if (input.type === "ui") {
            if (input.command === "quit") exiting = true;
            else if (
              (input.command === "undo" || input.command === "redo") &&
              !agentTurn
            ) {
              const base = baseline();
              const command = input.command;
              historyStep = settling(
                stepHistory(command)
                  .then((outcome) => receipt(outcome, base))
                  .catch((error: unknown) => {
                    tui.activity.pushCard(
                      `${command} failed · ${error instanceof Error ? error.message : String(error)}`,
                      { tone: "error" },
                    );
                  })
                  .finally(() => tick(true)),
              );
            }
          } else if (input.type === "pick-key") {
            void presetPickerKey(input.picker, input.key, input.value).finally(
              () => tick(true),
            );
          } else if (
            input.type === "pick-move" &&
            (input.picker === "preset" || input.picker === "presets") &&
            !auditionLoop?.looping
          ) {
            previewPreset(input.value);
          } else if (
            input.type === "pick" &&
            input.picker === "presets" &&
            input.value.startsWith("/presets ")
          ) {
            // A category opens its list; nothing is kept yet.
            const list = listKind(input.value.slice(9));
            if (list) openPresetBrowser(list);
          } else if (input.type === "pick-move") {
            // Moving through a list auditions the row under the cursor on
            // the loop; with the loop off, /pattern plays one bar of it.
            if (auditionLoop?.looping && isStageable(input.value))
              hoverItem(input.value, `picker:${input.picker}`);
            else if (input.picker === "pattern")
              previewPattern(
                input.value.replace(/^\/(?:pattern|groove)\s+/, ""),
              );
          } else if (input.type === "pick-audition") {
            pickerAuditionKey(input.key);
          } else if (input.type === "pick-cancel") {
            if (AUDITION_PICKERS.has(input.picker)) leaveAuditionScreen();
          } else if (input.type === "pick" && input.picker === "try") {
            if (input.value === "keep")
              void keepStaged()
                .then((outcome) => receipt(outcome))
                .catch((error) =>
                  tui.activity.pushError(describeError("keep", error)),
                )
                .finally(() => {
                  stopAuditionLoop();
                  tick(true);
                });
            else leaveAuditionScreen();
          } else if (
            input.type === "pick" &&
            AUDITION_PICKERS.has(input.picker) &&
            auditionLoop?.staging
          ) {
            // Enter in an auditioning list keeps what you hear.
            const loop = auditionLoop;
            const key = `picker:${input.picker}`;
            void (
              isStageable(input.value)
                ? loop.hover(input.value, key)
                : Promise.resolve()
            )
              .then(() => loop.settle(key))
              .then(() => keepStaged())
              .then((outcome) => receipt(outcome))
              .catch((error) =>
                tui.activity.pushError(describeError("keep", error)),
              )
              .finally(() => {
                stopAuditionLoop();
                tick(true);
              });
          } else if (input.type === "pick") {
            // Picker choices run as the command they stand for.
            queuedPrompts.runNow(
              input.picker === "resume"
                ? `/resume ${input.value}`
                : input.value,
            );
            void drainQueue();
          } else if (action?.kind === "exit") exiting = true;
          else if (action?.kind === "cancel" && agentTurn) {
            agentTurn.controller.abort();
            tui.activity.setSpinner("cancelling");
          } else if (
            action?.kind === "submit" &&
            action.value &&
            agentTurn &&
            routeDuringTurn(action.value, parsesLocally) === "local"
          ) {
            // A typed command never waits on the agent: it commits its own
            // revision now, and the agent's next call re-reads the score.
            const value = action.value;
            void settling(runLocalBesideAgent(value).finally(() => tick(true)));
          } else if (action?.kind === "submit" && action.value && agentTurn) {
            // Enter during a turn steers it; Alt-Enter still queues a follow-up.
            agentTurn.steering.push(action.value);
            tui.activity.pushCard(
              `steering · ${truncateForCard(action.value)}`,
              { tone: "agent", hint: "next step" },
            );
          } else if (action?.kind === "submit" && action.value) {
            queuedPrompts.runNow(action.value);
            // Do not await: the input loop must stay live so Esc can cancel.
            void drainQueue();
          } else if (action?.kind === "queue" && action.value) {
            queuedPrompts.runNext(action.value);
            tui.activity.setQueueDepth(queuedPrompts.length);
            tui.activity.pushCard(`queued · ${truncateForCard(action.value)}`, {
              tone: "info",
            });
            void drainQueue();
          }
        }
        if (exiting) break;
        tick(true);
      }
      if (exiting) break;
      inputHandled = takenBytes;
      if (stateOsc) tick();
    }
  } finally {
    stdin.off("data", onData);
    stdin.off("end", onEnd);
    clearInterval(timer);
    clearInterval(presenceTimer);
    stdout.off("resize", onResize);
    // The terminal first: a teardown step that throws (a read-only .dawg,
    // a dead engine) must not leave the shell on the alternate screen.
    restoreTerminal();
    stdin.pause();
    console.error = consoleError;
    console.warn = consoleWarn;
    process.off("warning", onWarning);
    unwatchActivity();
    // Each step on its own: one failure does not skip the rest.
    const failures: unknown[] = [];
    const steps: Array<() => unknown> = [
      () => projectSync?.stop(),
      () => namer.dispose(),
      () => unsubscribe(),
      () => play?.exit(),
      () => monitorEngine?.dispose(),
      () => audio.stop(),
      () => port.close(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onUncaught);
    if (failures.length > 0) throw failures[0];
  }
}

/** `unknown command /clik · did you mean /click? · /help`. */
function unknownCommand(command: string): string {
  const word = command.split(/\s+/)[0] ?? command;
  const near = nearestCommand(command);
  return near
    ? `unknown command ${word} · did you mean ${near}? · /help`
    : `unknown command ${word} · /help`;
}

async function submit(prompt: string): Promise<string | Receipt> {
  const command = prompt.trim();
  // Canonical names for window commands: `model key` (login), `models`,
  // `voice` (the Voice topic).
  const canonical = canonicalWindowForm(command);
  if (canonical) return submit(canonical);
  const helpCommand = command.match(/^\/?(?:help|\?)(?:\s+(\S+))?$/i);
  if (helpCommand) {
    const topic = helpCommand[1];
    // The panel's inner width (tui/app.ts paintText): rows clip there with
    // an ellipsis, the same as every other panel.
    const columns = stdout.columns ?? 80;
    const lines = helpTopicLines(
      topic,
      Math.max(10, columns - (columns >= 60 ? 8 : 4)),
    );
    if (!lines) return fail(helpMiss(topic!));
    tui.openText(helpTitle(topic), lines, helpHeadingMarks(lines));
    return ok(topic ? helpTitle(topic) : "help · help all for every command");
  }
  if (/^\/?tracks$/i.test(command)) {
    const problems = await sampleProblems(score);
    const items = score.tracks.map((track) => {
      const voices = track.sampler
        ? Object.keys(track.sampler.voices).length
        : 0;
      const missing = problems.filter(
        (problem) => problem.trackId === track.id && problem.level === "error",
      ).length;
      const samples = track.sampler
        ? ` · ${voices} sample${voices === 1 ? "" : "s"}${missing ? ` · ${missing} missing` : ""}`
        : "";
      return {
        label: track.id,
        value: `/track ${track.id}`,
        detail: `${track.instrument}${samples}${track.muted ? " · muted" : ""}${track.solo ? " · solo" : ""}${paneMarks(track.id)}`,
        current: track.id === requestedTrack,
      };
    });
    // A picker: Enter (or a click) focuses the track; Esc closes.
    tui.openPicker({
      id: "tracks",
      title: "tracks · ● focused",
      items,
      filterable: items.length > 8,
      index: Math.max(
        0,
        items.findIndex((item) => item.current),
      ),
    });
    return note(`${items.length} track${items.length === 1 ? "" : "s"}`);
  }
  if (/^\/?(?:instruments|instrument\s+(?:list|ls|presets))$/i.test(command)) {
    // `instrument list`: every word `instrument <name>` takes, by family.
    const columns = stdout.columns ?? 80;
    const lines = instrumentListLines(
      Math.max(10, columns - (columns >= 60 ? 8 : 4)),
    );
    tui.openText("instruments", lines);
    return note("instruments · instrument <name> on the focused track");
  }
  if (/^\/?notes(?:\s+(?:list|ls))?$/i.test(command)) {
    // `notes`: the focused track's note ids, the names `remove <id>` takes.
    const notes = score.notes
      .filter((entry) => entry.trackId === requestedTrack)
      .slice()
      .sort((a, b) => a.startTick - b.startTick);
    const lines = notes.map(
      (entry) =>
        `${entry.id} · ${midiNoteName(entry.pitch)} · beat ${+(entry.startTick / score.ticksPerBeat).toFixed(2)}`,
    );
    if (lines.length === 0) return note(`notes · ${requestedTrack} has none`);
    tui.openText(`notes · ${requestedTrack}`, lines);
    return note(
      `${lines.length} note${lines.length === 1 ? "" : "s"} · ${requestedTrack} · remove <id>`,
    );
  }
  const patchViewMatch = command.match(
    /^\/patch(?:\s+(on|off)|\s+--fx\s+([a-z][a-z0-9-]{0,31}))?$/i,
  );
  if (patchViewMatch) {
    const wanted = patchViewMatch[1]?.toLowerCase();
    if (wanted === "off") return exitPatch();
    return enterPatch(patchViewMatch[2]?.toLowerCase());
  }
  const tapeCommand = command.match(/^\/tape(?:\s+(on|off))?$/i);
  if (tapeCommand) {
    const wanted = tapeCommand[1]?.toLowerCase();
    if (wanted === "off" || (wanted === undefined && tape.on))
      return exitTape();
    return enterTape();
  }
  const playCommand = command.match(
    /^\/play(?:\s+(on|off|degrees|in-key|chromatic))?$/i,
  );
  if (playCommand) {
    const wanted = playCommand[1]?.toLowerCase();
    if (wanted === "off" || (wanted === undefined && play?.on))
      return exitPlay();
    if (wanted && wanted !== "on") {
      const message = playSession().toggleDegrees(wanted !== "chromatic");
      if (message.startsWith("scale degrees need")) return fail(message);
      const entered = await enterPlay();
      return entered.ok ? ok(message) : entered;
    }
    return enterPlay();
  }
  const clickCommand = command.match(/^\/click(?:\s+(.+))?$/i);
  if (clickCommand) {
    const message = playSession().clickCommand(clickCommand[1] ?? "");
    return message.startsWith("usage") || message.startsWith("click volume")
      ? fail(message)
      : ok(message);
  }
  const chordsCommand = command.match(/^\/chords(?:\s+(.+))?$/i);
  if (chordsCommand) {
    const result = applyChordsCommand(
      chordSettings,
      chordsCommand[1] ?? "",
      score.tempoBpm,
    );
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const audioCommand = command.match(/^\/audio(?:\s+(.*))?$/i);
  if (audioCommand) {
    const result = await runAudioCommand(audioCommand[1] ?? "", {
      info: audioInfo(),
      setOutput: (name) => {
        if (audio instanceof AudioEngine) audio.setDevice(name);
        monitorEngine?.setDevice(name);
      },
      background: (task) => void task,
    });
    audioMenuCache = undefined;
    if (result.ok && result.lines && /^\/audio(\s+test)?\s*$/i.test(command))
      tui.openText(/test/i.test(command) ? "audio test" : "audio", [
        ...result.lines,
      ]);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const agentSettings = command.match(/^\/agent\s+(.+)$/i);
  if (agentSettings) {
    const result = await runAgentSettingsCommand(
      agentSettings[1]!,
      process.cwd(),
    );
    if (result.ok && result.lines && result.lines.length > 0)
      tui.openText("read roots", [...result.lines]);
    void refreshAgentShell();
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const showMeCommand = command.match(/^\/show-?me(?:\s+(\S+))?$/i);
  if (showMeCommand) {
    if (!showMeCommand[1])
      return ok(`show me · ${showMe.level} · /showme on|quiet|off`);
    const level = parseShowMe(showMeCommand[1]);
    if (!level) return fail("usage · /showme on|quiet|off");
    showMe.level = level;
    void writeConfig({ dir: configDir() }, { showMe: level }).catch(
      () => undefined,
    );
    return ok(
      level === "off"
        ? "show me off · the agent edits with tools"
        : level === "quiet"
          ? "show me quiet · the agent types commands, no captions"
          : "show me on · the agent types commands, slides faders, plays keys",
    );
  }
  const countIn = command.match(/^\/count-?in\s+([0-2])$/i);
  if (countIn) return ok(playSession().setCountIn(Number(countIn[1])));
  const euclidCommand = command.match(/^\/euclid(?:\s+(\S+))?$/i);
  if (euclidCommand) {
    const from = menu.open ? "menu" : undefined;
    if (menu.open) {
      menu.close();
      tui.closePicker();
    }
    openEuclid(euclidCommand[1]?.toLowerCase(), from);
    return ok("rhythm editor");
  }
  const tryCommand = command.match(/^\/try(?:\s+(.+))?$/i);
  if (tryCommand) return tryPrompt(tryCommand[1]?.trim() ?? "");
  // A bare scalar (`volume`, `pan`, `fx reverb mix`, and the song's
  // `tempo`, `bars` and `meter`) opens the fader drawer on it, with its
  // related params stacked below.
  if (
    /^\/?(?:volume|pan|tempo|bpm|bars|meter|fx\s+\S+(?:\s+\S+)?)$/i.test(
      command,
    )
  ) {
    const context = menuContext();
    const opened =
      menu.showFader(context, command) ?? songFader(context, command);
    // Bare `volume` (and every scalar) opens on its knob page, when its
    // level has one and the param is a knob: the four knobs up front.
    const label = opened && (menu.openKnobs(context, opened) ?? opened);
    if (label) {
      const field = menu
        .faderFields(context)
        .find((candidate) => candidate.label === label);
      // The receipt names the value it opened on: `tempo · 120 BPM · …`.
      const value =
        field?.kind === "number"
          ? field.value !== undefined
            ? field.format(field.value)
            : field.off
          : undefined;
      openFader(label, true);
      refreshMenu();
      return ok(
        `${label}${value ? ` · ${value}` : ""} · ${
          menu.knobPage === "knobs"
            ? "↑↓ knob · ←→ turn · tab all"
            : "←→ adjust · enter keep · esc revert"
        }`,
      );
    }
  }
  // `mix`: the drawer's mixer page, every track's level as a fader.
  // `knobs [sound|mix|master|tempo|fx <effect>]`: a page's four knobs.
  const knobsCommand = command.match(/^\/?(?:(mix)|knobs(?:\s+(.+))?)$/i);
  if (knobsCommand) {
    const context = menuContext();
    const track = context.score.tracks.find((t) => t.id === context.trackId);
    const label = knobsCommand[1]
      ? openMixer(context)
      : openKnobPage(context, knobsCommand[2], track);
    if (!label)
      return fail(
        knobsCommand[1]
          ? "mix · no tracks yet · track <name>"
          : `knobs ${knobsCommand[2] ?? ""} · no such page · knobs ${KNOB_PAGE_WORDS.join("|")}`,
      );
    openFader(label, true);
    refreshMenu();
    return ok(
      knobsCommand[1]
        ? "mix · ↑↓ track · ←→ level · tab this track · enter keep · esc revert"
        : `knobs · ${menu.knobPageId} · ↑↓ knob · ←→ turn · tab all params`,
    );
  }
  const menuCommand = command.match(/^\/menu(?:\s+(\S+))?$/i);
  if (menuCommand) {
    const section = menuCommand[1]?.toLowerCase();
    // §4: the keys topic has no menu page; it opens the ? panel.
    if (section && (section === "keys" || TOPIC_ALIASES[section] === "keys")) {
      tui.showKeys("keys", keyLines(KEYS.prompt));
      return ok("keys");
    }
    if (section && !menuSectionPath(menuContext(), section))
      return fail(menuUsage(menuContext(), section));
    openMenu(section);
    return ok("menu");
  }
  const gridCommand = command.match(/^\/grid\s+(\S+)$/i);
  if (gridCommand) {
    const message = playSession().setGrid(gridCommand[1]!);
    return message
      ? ok(message)
      : fail("usage: /grid 1/4|1/8|1/8T|1/16|1/16T|1/32");
  }
  const paneReceipt = paneCommand(command);
  if (paneReceipt) return paneReceipt;
  if (/^\/status$/i.test(command))
    return ok(
      `status · ${record.meta.name} · rev ${record.revision} · ${compositionDigest(record.composition)} · ${port.mode === "daemon" ? "shared via dawgd" : "saved locally · no daemon"}`,
    );
  const history = /^\/?(undo|redo)(?:\s+(all))?$/i.exec(command);
  if (history)
    return stepHistory(
      history[1]!.toLowerCase() as "undo" | "redo",
      history[2] ? "all" : "pane",
    );
  const trackCommand = command.match(
    /^\/?(?:add\s+)?track\s+([a-z0-9._-]{1,64})$/i,
  );
  if (trackCommand) return focusTrack(trackCommand[1]!.toLowerCase());
  // `track cloud grain hold`: focus (or create) a track and grain it.
  const grainTrack = command.match(
    /^\/?track\s+([a-z0-9._-]{1,64})\s+(grain\s+.+)$/i,
  );
  if (grainTrack && parseGranularCommand(grainTrack[2]!)) {
    const focused = await focusTrack(grainTrack[1]!.toLowerCase());
    if (requestedTrack !== grainTrack[1]!.toLowerCase()) return focused;
    return submit(grainTrack[2]!);
  }
  // `/track rm <name>` (aliases remove, delete) and `/track move <name>
  // <position>`: the human surface for the removeTrack and moveTrack
  // operations. Removing a track also drops any vocoder src or autotune from
  // that named it; ^z brings everything back.
  const trackEdit = command.match(
    /^\/?track\s+(rm|remove|delete|move)\s+(.{1,64}?)\s*$/i,
  );
  if (trackEdit) {
    const verb = trackEdit[1]!.toLowerCase() === "move" ? "move" : "rm";
    let rest = trackEdit[2]!.trim();
    let position: number | undefined;
    if (verb === "move") {
      const tail = rest.match(/^(.+?)\s+(\d{1,3})$/);
      if (!tail)
        return fail(`usage · /track move <name> <1..${score.tracks.length}>`);
      rest = tail[1]!;
      position = Number(tail[2]);
    }
    const wanted = rest
      .replace(/^["']|["']$/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
    const found = score.tracks.find(
      (track) =>
        track.id.toLowerCase() === wanted ||
        track.id.toLowerCase() === wanted.replace(/ /g, "-") ||
        (track.name ?? "").toLowerCase() === wanted,
    );
    if (!found) return fail(noTrack(rest));
    if (verb === "move") {
      if (position! < 1 || position! > score.tracks.length)
        return fail(`usage · /track move <name> <1..${score.tracks.length}>`);
      const next = applyScoreOperation(score, {
        type: "moveTrack",
        trackId: found.id,
        index: position! - 1,
      });
      await commitScore(next, "track.move", { trackId: found.id });
      await projectSync?.flushScore();
      return ok(`moved ${found.id} to position ${position}`);
    }
    if (score.tracks.length <= 1)
      return fail("the last track stays · /clear empties it");
    const next = applyScoreOperation(score, {
      type: "removeTrack",
      trackId: found.id,
    });
    const dropped = score.tracks
      .filter((track) => track.id !== found.id)
      .filter((track) => {
        const after = next.tracks.find((t) => t.id === track.id);
        return (
          (track.vocoder?.src !== undefined &&
            after?.vocoder?.src === undefined) ||
          (track.autotune?.from !== undefined &&
            after?.autotune?.from === undefined)
        );
      })
      .map((track) => track.id);
    await commitScore(next, "track.remove", { trackId: found.id });
    await projectSync?.flushScore();
    if (found.id === requestedTrack) await focusTrack(next.tracks[0]!.id);
    return ok(
      `removed ${found.id}${dropped.length ? ` · dropped references on ${dropped.join(", ")}` : ""} · ctrl-z undoes`,
    );
  }
  // `/track piano b`: a name with spaces focuses the track of that name, or
  // creates `piano-b` named "piano b".
  const namedTrack = command.match(/^\/track\s+([a-z0-9._ -]{1,64})$/i);
  if (namedTrack) {
    const name = namedTrack[1]!.trim().replace(/\s+/g, " ");
    const found = score.tracks.find(
      (track) => (track.name ?? track.id).toLowerCase() === name.toLowerCase(),
    );
    return focusTrack(found?.id ?? name.toLowerCase().replace(/ /g, "-"));
  }
  const sample = parseSampleCommand(command);
  if (sample) return sampleCommand(sample);
  const fit = parseFitCommand(command);
  if (fit) return fitCommand(fit);
  const shift = parseShiftCommand(command);
  if (shift) {
    const result = applyShiftCommand(score, requestedTrack, shift);
    if (!result.ok) return fail(result.message);
    await commitScore(result.next, "sample.set", { trackId: requestedTrack });
    await projectSync?.flushScore();
    return ok(result.message);
  }
  const resample = parseResampleCommand(command);
  if (resample) return resampleCommand(resample);
  const chop = parseChopCommand(command);
  if (chop) return chopCommand(chop);
  // 0.7 clips: `/clip` edits and `/lyrics` on the focused track.
  const clipCommand = parseClipCommand(command);
  if (clipCommand) {
    if ("error" in clipCommand) return fail(clipCommand.error);
    const result = await runClipCommand(clipCommand, {
      score,
      trackId: requestedTrack,
      cwd: process.cwd(),
    });
    if (!result.ok) return fail(result.message);
    if (result.next && result.kind) {
      await commitScore(result.next, result.kind, {
        trackId: requestedTrack,
        ...result.payload,
      });
      await projectSync?.flushScore();
    }
    return ok(result.message);
  }
  const lyricsCommand = parseLyricsCommand(command);
  if (lyricsCommand) {
    const result = applyLyrics(score, requestedTrack, lyricsCommand);
    if (!result.ok) return fail(result.message);
    if (result.next && result.kind) {
      await commitScore(result.next, result.kind, {
        trackId: requestedTrack,
        ...result.payload,
      });
      await projectSync?.flushScore();
    }
    return ok(result.message);
  }
  // 0.7 autotune: `/autotune …` (and `/tune <preset>` pointing here).
  // `/vocal autotune …` takes the same path (presets panel, draft, commit).
  const autotune = parseAutotuneCommand(
    command.replace(/^\/?vocal\s+(?=autotune\b)/i, ""),
  );
  if (autotune) {
    if (autotune.type === "autotune-list")
      tui.openText("autotune presets", autotuneListLines());
    if (autotune.type !== "autotune-usage" && autotune.type !== "autotune-list")
      await materializeDraft();
    const result = applyAutotuneCommand(score, requestedTrack, autotune);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  // 0.7 Voice: `/vocal <verb>`; lanes register verbs in VOCAL_VERBS.
  setClipImportDeps({
    media: {
      ...mediaServices(),
      signal: new AbortController().signal,
      progress: () => undefined,
    },
  });
  const vocal = parseVocalCommand(command);
  if (vocal) {
    if (vocal.kind === "verb") await materializeDraft();
    const result = await runVocalCommand(vocal, {
      score,
      trackId: requestedTrack,
      cwd: process.cwd(),
    });
    if (!result.ok) return fail(result.message);
    if (result.next && result.kind) {
      await commitScore(result.next, result.kind, {
        trackId: requestedTrack,
        ...result.payload,
      });
      await projectSync?.flushScore();
    }
    // A verb that made or chose another track (a vocoder carrier): focus it.
    if (result.trackId && result.trackId !== requestedTrack) {
      await port.focus(result.trackId);
      requestedTrack = result.trackId;
    }
    return ok(result.message);
  }
  const pack = parsePackCommand(command);
  if (pack) return packCommand(pack);
  const pattern = parsePatternCommand(command);
  if (pattern) return patternCommand(pattern);
  const kit = parseKitCommand(command);
  if (kit) return kitCommand(kit, /^\/?kits?\s*$/i.test(command.trim()));
  const wavetable = parseWavetableCommand(command);
  if (wavetable) return wavetableCommand(wavetable);
  const historyReply = await historyCommand(command);
  if (historyReply !== undefined) return historyReply;
  const sessionReply = await sessionCommand(command);
  if (sessionReply !== undefined) return sessionReply;
  const time = parseTimeCommand(command);
  if (time) {
    if (time.type !== "tempo-map") await materializeDraft();
    const result = applyTimeCommand(score, requestedTrack, time);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const edit = parseEditCommand(command);
  if (edit) {
    await materializeDraft();
    const result = applyEditCommand(score, requestedTrack, edit);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const rhythm = parseRhythmCommand(command);
  if (rhythm) {
    await materializeDraft();
    const result = applyRhythmCommand(score, requestedTrack, rhythm);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const guitar = parseGuitarCommand(command);
  if (guitar) {
    if (guitar.type !== "guitar-show" && guitar.type !== "guitar-hint")
      await materializeDraft();
    const result = applyGuitarCommand(score, requestedTrack, guitar);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const progression = parseProgressionCommand(command);
  if (progression) {
    if (progression.type === "progression") await materializeDraft();
    const result = applyProgressionCommand(
      score,
      requestedTrack,
      progression,
      () => newId("n"),
    );
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const strum = parseStrumCommand(command);
  if (strum) {
    if (strum.type === "strum") await materializeDraft();
    const result = applyStrumCommand(score, requestedTrack, strum, () =>
      newId("n"),
    );
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const rig = parseRigCommand(command);
  if (rig) {
    if (rig.type !== "rig-show" && rig.type !== "rig-hint")
      await materializeDraft();
    const result = applyRigCommand(score, requestedTrack, rig);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return readOrDone(result);
  }
  // 0.7 `/formant` and `/vowel`: short forms of `fx formant|vowel`.
  const formant = parseFormantCommand(command) ?? parseVowelCommand(command);
  if (formant) {
    if (formant.type === "fx") await materializeDraft();
    const result = applyFormantCommand(score, requestedTrack, formant);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  // Patcher (design §6.1): `patch add|set|wire|…` edits the focused
  // track's patch; each line is one revision of node/cable/macro ops.
  const patchError = patchCommandError(command);
  if (patchError) return fail(patchError);
  const patchCommand = parsePatchCommand(command);
  if (patchCommand) return runPatchCommand(patchCommand);
  const presetCommand = parsePresetCommand(command);
  if (presetCommand) return runPresetCommand(presetCommand);
  const fx = parseFxCommand(command);
  if (fx) {
    if (fx.type !== "fx-list") await materializeDraft();
    // A pack impulse is pinned (sha256 + url) once, as wavetable tables are.
    let pinnedIr: SampleRef | undefined;
    if (fx.type === "fx-ir" && fx.ir?.startsWith(PACK_PREFIX)) {
      try {
        pinnedIr = await packs().pin(fx.ir);
      } catch (error) {
        if (error instanceof PackError)
          return fail(`reverb ir · ${error.message}`);
        throw error;
      }
    }
    const result = applyFxCommand(score, requestedTrack, fx, pinnedIr);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    // Bare `fx` reads the chain (`•`); it changes nothing.
    if (result.ok && fx.type === "fx-list") return note(result.message);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const unknownFx = unknownFxMessage(command);
  if (unknownFx) return fail(unknownFx);
  const expression = parseExpressionCommand(command);
  if (expression) {
    if (expression.type !== "show" && expression.type !== "invalid")
      await materializeDraft();
    const result = applyExpressionCommand(score, requestedTrack, expression);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const tuning = parseTuningCommand(command);
  if (tuning) return tuningCommand(tuning);
  const calibration = parseCalibrationCommand(command);
  if (calibration) {
    const result = applyCalibrationCommand(score, calibration);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const recordCommand = parseRecordCommand(command);
  if (recordCommand) return keysRecord(recordCommand);
  const keysCommand = parseKeysCommand(command);
  if (keysCommand) {
    const reads =
      keysCommand.type === "keys-list" || keysCommand.type === "keys-presets";
    if (!reads) await materializeDraft();
    const result = applyKeysCommand(score, requestedTrack, keysCommand);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const modal = parseModalCommand(command);
  if (modal) {
    if (modal.type === "modal-list")
      tui.openText("modal presets", modalListLines());
    if (modal.type !== "modal-show" && modal.type !== "modal-list")
      await materializeDraft();
    const result = applyModalCommand(score, requestedTrack, modal);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const vocoderCommand = parseVocoderCommand(command);
  if (vocoderCommand) {
    if (vocoderCommand.type === "vocoder-list")
      tui.openText("vocoder presets", vocoderListLines());
    if (
      vocoderCommand.type !== "vocoder-list" &&
      vocoderCommand.type !== "vocoder-usage"
    )
      await materializeDraft();
    const result = applyVocoderCommand(score, requestedTrack, vocoderCommand);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    // `/vocoder` on a vocal makes a carrier track: focus it.
    if (result.trackId && result.trackId !== requestedTrack) {
      await port.focus(result.trackId);
      requestedTrack = result.trackId;
    }
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const windCommand = parseWindCommand(command);
  if (windCommand) {
    if (windCommand.type === "wind-list")
      tui.openText("wind presets", windListLines());
    if (windCommand.type !== "wind-show" && windCommand.type !== "wind-list")
      await materializeDraft();
    const result = applyWindCommand(score, requestedTrack, windCommand);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const singCommand = parseSingCommand(command);
  if (singCommand) {
    if (singCommand.type === "sing-list")
      tui.openText("sing presets", singListLines());
    if (singCommand.type !== "sing-show" && singCommand.type !== "sing-list")
      await materializeDraft();
    const result = applySingCommand(score, requestedTrack, singCommand);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const synth = parseSynthCommand(command);
  if (synth) {
    if (synth.type !== "synth-list") await materializeDraft();
    const result = applySynthCommand(score, requestedTrack, synth);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    // Bare `synth` (design §8.6) also opens the sound page's four knobs.
    if (synth.type === "synth-list" && result.ok && !stageCapture) {
      const context = menuContext();
      const track = context.score.tracks.find((t) => t.id === context.trackId);
      const label = openKnobPage(context, "sound", track);
      if (label) {
        openFader(label, true);
        refreshMenu();
      }
    }
    return readOrDone(result);
  }
  const stringCommand = parseStringCommand(command);
  if (stringCommand) {
    if (
      stringCommand.type !== "string-list" &&
      stringCommand.type !== "string-presets"
    )
      await materializeDraft();
    const result = applyStringCommand(score, requestedTrack, stringCommand);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return readOrDone(result);
  }
  const grainHint = grainSrcHint(command);
  if (grainHint) return fail(grainHint);
  const grain = parseGranularCommand(command);
  if (grain) {
    if (grain.type !== "grain-list" && grain.type !== "grain-presets")
      await materializeDraft();
    const result = applyGranularCommand(score, requestedTrack, grain);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const styleCommand = parseStyleCommand(
    /^\/?styles?\s+presets$/i.test(command) ? "style list" : command,
  );
  if (styleCommand) {
    const writes =
      styleCommand.type === "style-apply" ||
      styleCommand.type === "style-again";
    // Bare `style` opens Arrange › style; `style list|ls|presets` lists.
    if (
      styleCommand.type === "style-families" &&
      /^\/?styles?$/i.test(command)
    ) {
      openMenu("style");
      return ok(
        "style · ↑/↓ browse · enter makes the song · style list prints it",
      );
    }
    if (writes) await materializeDraft();
    const result = applyStyleCommand(score, styleCommand);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    if (result.log) tui.activity.pushNote(result.log);
    if (!result.ok) return fail(result.message);
    // A multi-line listing opens as text; the card keeps its first line
    // so lines never run together on the one-line strip.
    if (!writes && result.message.includes("\n")) {
      const [head = "styles", ...rest] = result.message.split("\n");
      tui.openText(head, rest);
      return note(head);
    }
    // A new song: focus its first melodic track, so play and the menu
    // land on something tonal instead of a track the style replaced.
    const melodic = writes
      ? result.next?.tracks.find((track) => !isDrumInstrument(track.instrument))
      : undefined;
    if (melodic && melodic.id !== requestedTrack) {
      await port.focus(melodic.id);
      requestedTrack = melodic.id;
      draftTrack = false;
    }
    return ok(
      melodic ? `${result.message} · focused ${melodic.id}` : result.message,
    );
  }
  const masterCommand = parseMasterCommand(command);
  if (masterCommand) {
    if (masterCommand.type === "master-measure")
      return ok(await measureLine(score));
    if (
      masterCommand.type !== "master-list" &&
      masterCommand.type !== "master-show"
    )
      await materializeDraft();
    const result = applyMasterCommand(score, masterCommand);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return readOrDone(result);
  }
  // Range commands (op1-ux §6.4): copy/move/clear/paste/reverse bars,
  // bars insert|remove, loop next|prev, jump.
  const rangeCommand = parseRangeCommand(command, score);
  if (rangeCommand) {
    const reads =
      rangeCommand.type === "range-usage" ||
      rangeCommand.type === "jump-bar" ||
      rangeCommand.type === "jump-section" ||
      (rangeCommand.type === "range-copy" && rangeCommand.to === undefined);
    if (!reads) await materializeDraft();
    // TAPE's first paste after a cut (§6.2): the `move` reads the bars from
    // the score before the cut's clear, so cut and paste land as one move.
    const folded =
      rangeCommand.type === "range-move" &&
      tape.foldArmed &&
      tape.cut &&
      cutArmed(tape.cut.after, score)
        ? foldBase(tape.cut.before, score)
        : undefined;
    tape.foldArmed = undefined;
    const cutBase =
      rangeCommand.type === "range-clear" ? tape.cutArmed : undefined;
    if (rangeCommand.type === "range-clear") tape.cutArmed = undefined;
    const result = applyRangeCommand(
      folded ?? score,
      {
        trackId: requestedTrack,
        playheadBar: playheadBar(),
        ...(rangeClipboard ? { clipboard: rangeClipboard } : {}),
      },
      rangeCommand,
    );
    if (result.delegate) return submit(result.delegate);
    if (result.clipboard) {
      rangeClipboard = result.clipboard;
      tape.cut = undefined;
      void saveClipboard(paneClipboardPath(), rangeClipboard).catch(
        () => undefined,
      );
    }
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    if (cutBase && result.next) tape.cut = { before: cutBase, after: score };
    else if (result.next && result.kind) tape.cut = undefined;
    if (result.seekBeat !== undefined) await seekTransport(result.seekBeat);
    return readOrDone(result);
  }
  // `loop <a>-<b> | <section> | off`: what playback loops. Bars set the
  // loop range (score.loop); a name loops that section.
  const loop = parseLoopCommand(command);
  if (loop) {
    if (loop.type === "loop-show")
      return note(
        score.loop
          ? `loop · bars ${rangeLabel(score.loop)} · loop off plays the song`
          : score.loopSection
            ? `loop · ${score.loopSection} · loop off plays the song`
            : `loop · the song · ${LOOP_USAGE}`,
      );
    if (loop.type === "loop-off") {
      if (score.loop) {
        await materializeDraft();
        await commitScore(score.withLoop(null), "score.loop", { loop: null });
        return ok("loop · off · playing the song");
      }
      return submit("section loop off");
    }
    if (loop.type === "loop-section")
      return submit(`section loop ${loop.name}`);
    const result = loopSpan(score, loop.from, loop.to);
    if (!result.ok) return fail(result.message);
    await materializeDraft();
    await commitScore(result.next, "score.loop", { loop: result.next.loop });
    return ok(result.message);
  }
  const arrange = parseSectionCommand(command, score);
  if (arrange) {
    const reads =
      arrange.type === "section-list" ||
      arrange.type === "section-unknown" ||
      arrange.type === "form-show" ||
      arrange.type === "section-jump";
    if (!reads) await materializeDraft();
    const result = applySectionCommand(score, requestedTrack, arrange);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    if (result.seekBeat !== undefined) await seekTransport(result.seekBeat);
    return readOrDone(result);
  }
  const music = parseMusicCommand(command);
  if (music) {
    await materializeDraft();
    const result = applyMusicCommand(score, requestedTrack, music, () =>
      newId("n"),
    );
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const exportCommand = parseExportCommand(command);
  if (exportCommand) {
    const path = resolve(exportCommand.path);
    if (exportCommand.format === "mid") {
      await writeFile(path, scoreToMidi(exportScore(score)));
      return `exported midi · ${exportCommand.path}`;
    }
    // Audio goes through the `dawg render` path, the same bytes as the CLI.
    if (exportCommand.format === "wav")
      return exportWav(exportCommand.path, exportCommand.stems);
    // Other audio names are not formats dawg writes.
    if (/\.(aiff?|flac|mp3|ogg|m4a)$/i.test(path))
      return fail(`export · ${exportCommand.path} · ${EXPORT_USAGE}`);
    await writeFile(path, encodeLoop(score), "utf8");
    return `exported · ${exportCommand.path}`;
  }
  const importCommand = command.match(/^\/?import\s+([^\s]+)$/i);
  if (importCommand) {
    await materializeDraft();
    const imported = decodeLoop(await readLoopFile(importCommand[1]!));
    await commitScore(imported, "score.import", { path: importCommand[1] });
    return `imported · ${importCommand[1]}`;
  }
  const modelMatch = prompt.trim().match(/^\/model(?:\s+(\S+))?\s*$/i);
  if (modelMatch) {
    const selection = await currentProvider();
    if (!modelMatch[1]) {
      if (selection.kind === "offline")
        return `model · none · ${selection.reason}`;
      tui.activity.setSpinner("models");
      try {
        const items = await modelPickerItems(selection);
        if (items.length === 0)
          return `model · ${providerName} · no other models listed`;
        tui.openPicker({
          id: "model",
          title: `model · ${providerName}`,
          items,
          filterable: true,
          index: Math.max(
            0,
            items.findIndex((item) => item.current),
          ),
        });
        return `model · ${providerName} · pick one (or /model <alias>)`;
      } finally {
        tui.activity.setSpinner(undefined);
      }
    }
    const result = await tuiSetModel(modelMatch[1]);
    provider = undefined;
    await currentProvider();
    return result.ok ? result.text : fail(result.text);
  }
  if (/^\/login\b/i.test(prompt.trim())) {
    const parsed = tuiLoginArgs(prompt.trim());
    if (typeof parsed === "string") return `model key · ${parsed}`;
    await handoff(() =>
      runTuiLogin(
        parsed.target === "auto" ? "pick" : parsed.target,
        parsed.options,
      ),
    );
    provider = undefined;
    await currentProvider();
    return providerName === "offline"
      ? "no agent key · model key adds one · direct commands still work"
      : `agent key · ${providerName}`;
  }
  if (/^\/(logout|auth)\b/i.test(prompt.trim())) {
    tui.activity.setSpinner(prompt.trim().split(/\s+/)[0]!.slice(1));
    try {
      const lines = await tuiAuthCommand(prompt.trim());
      provider = undefined;
      await currentProvider();
      for (const line of lines.slice(0, -1))
        tui.activity.pushCard(line, { tone: authTone(line) });
      return lines.at(-1) ?? "auth · done";
    } finally {
      tui.activity.setSpinner(undefined);
    }
  }
  // The grammar's second reading (design §3): a line no handler took runs
  // in its other spellings — `/x` ≡ `x`, aliases, `rm|remove|delete`,
  // `list|presets|ls` — so only lines that failed before get one.
  // A line the core prompt parser takes is already understood.
  if (!recovering && !parsePrompt(prompt)) {
    const retry = recover(
      command,
      (candidate) =>
        parseExact(candidate, score) !== undefined ||
        // Window verbs get only the slash toggle, never a listing word.
        (candidate.startsWith("/") &&
          SLASH_HANDLED.has(verbOf(candidate)) &&
          candidate.split(/\s+/).length === command.trim().split(/\s+/).length),
    );
    if (retry !== undefined) {
      recovering = true;
      try {
        return await submit(retry);
      } finally {
        recovering = false;
      }
    }
  }
  // Bare `rename`, `fork`, `resume`, `login` take free text: a hint only.
  const freeText = FREE_TEXT_HINTS[command.toLowerCase()];
  if (freeText !== undefined) return note(freeText);
  const elsewhere = elsewhereHint(command);
  if (elsewhere !== undefined) return note(elsewhere);
  // `/model` belongs to its own handler above; every other slash word that
  // reached here is unknown or misused, and never a question for the agent.
  // `/instrument aah` is `instrument aah`; `instrument sing choir` is
  // `instrument choir`.
  const singWord = command.match(/^\/?instrument\s+sing\s+([a-z]+)$/i);
  if (singWord && isSingWord(singWord[1]!.toLowerCase()))
    return submit(`instrument ${singWord[1]!.toLowerCase()}`);
  if (/^\/instrument\s/i.test(command) && parsePrompt(command.slice(1)))
    return submit(command.slice(1));
  // A synth or effect number out of range names its range.
  const range = paramRangeError(command);
  if (range) return fail(range);
  if (command.startsWith("/") && !/^\/model\b/i.test(command)) {
    const hint = usageHint(command);
    return fail(
      hint ? `${truncateForCard(command)} · ${hint}` : unknownCommand(command),
    );
  }
  const parsed = parsePrompt(prompt);
  if (!parsed) {
    // A known verb with bad arguments gets usage, not a model call.
    const hint = usageHint(command);
    if (hint) return fail(`${truncateForCard(command)} · ${hint}`);
    // A one-letter slip on a command whose arguments parse stays local.
    const fix = typoFix(command, parsesLocally);
    if (fix) return fail(`${truncateForCard(command)} · did you mean ${fix}?`);
    // A grammar verb (not everyday English) never reaches the agent.
    const verb = verbOf(command);
    if (knownVerbs().has(verb) && !EVERYDAY_VERBS.has(verb))
      return fail(usageCard(truncateForCard(command), `/help ${verb}`));
    if (process.env.DAWG_AI === "0")
      return fail(`unrecognized · ${truncateForCard(command)} · /help`);
    await materializeDraft();
    return runAgent(prompt);
  }
  if (parsed.type !== "transport") await materializeDraft();
  if (parsed.type === "transport") {
    await setTransport(parsed.action);
    try {
      record = await port.append(
        record,
        {
          kind: "transport",
          payload: {
            action: parsed.action,
            playing: clock.playing,
            beat: clock.beatAt(),
          },
        },
        score.toJSON(),
      );
    } catch (error) {
      if (error instanceof SessionConflictError)
        return warn("transport changed in another window");
      throw error;
    }
    return parsed.action;
  }
  if (parsed.type === "set-tempo") {
    const range = RANGES.tempo!;
    if (parsed.tempoBpm < range.min || parsed.tempoBpm > range.max)
      return fail(usageError(truncateForCard(command), range));
    const next = score.withTempo(parsed.tempoBpm);
    await commitScore(next, "score.tempo", { tempoBpm: parsed.tempoBpm });
    clock.follow(next);
    // A bare `bpm <n>` stays song tempo; on a sampler track say where the
    // sample's own tempo lives (`/bpm`, 0.6 fit).
    const focused = next.tracks.find((t) => t.id === requestedTrack);
    const samplerHint =
      /^\s*bpm\b/i.test(prompt) &&
      focused?.sampler &&
      isSamplerInstrument(focused.instrument)
        ? ` · song tempo · the sample's own tempo is /bpm ${parsed.tempoBpm}`
        : "";
    return `tempo · ${next.tempoBpm} BPM${samplerHint}`;
  }
  if (parsed.type === "add-track") return focusTrack(parsed.trackId);
  if (parsed.type === "set-bars" || parsed.type === "extend-bars") {
    const bars =
      parsed.type === "set-bars"
        ? parsed.bars
        : Math.min(SCORE_LIMITS.maxBars, score.bars + parsed.bars);
    const next = applyScoreOperation(score, { type: "setBars", bars });
    await commitScore(next, "score.bars", { bars });
    return `bars · ${bars}`;
  }
  if (parsed.type === "track") {
    // An unknown word would store and play a plain sine: say so instead.
    const word = parsed.patch.instrument;
    if (word !== undefined && isUnknownInstrument(word))
      return fail(unknownInstrumentMessage(word));
    // `instrument jangle`: a guitar alias also loads its rig.
    const rigged = parsed.word
      ? {
          ...parsed.patch,
          ...rigWordPatch(
            parsed.word,
            score.tracks.find((t) => t.id === requestedTrack)?.fx,
          ),
        }
      : parsed.patch;
    // `instrument vocal` (0.7): the vocal chain fills unset effects.
    const chain = isGuideInstrument(parsed.patch.instrument)
      ? vocalChainPatch(score.tracks.find((t) => t.id === requestedTrack))
      : {};
    const patch = { ...chain, ...rigged };
    // `volume drums 0.5` names its track; it must exist.
    if (parsed.trackId !== undefined) {
      const target = score.tracks.find(
        (candidate) =>
          candidate.id === parsed.trackId ||
          candidate.name.toLowerCase() === parsed.trackId,
      );
      if (!target) return fail(`no track ${parsed.trackId}`);
      const next = applyScoreOperation(score, {
        type: "updateTrack",
        trackId: target.id,
        patch,
      });
      await commitScore(next, "score.track", { trackId: target.id, patch });
      return `track · ${target.id}`;
    }
    const next = applyScoreOperation(score, {
      type: "updateTrack",
      trackId: requestedTrack,
      patch,
    });
    await commitScore(next, "score.track", {
      trackId: requestedTrack,
      patch,
    });
    // Plain `marimba` keeps the legacy tone; point at the mallet engine.
    if (parsed.patch.instrument === "marimba" && !("modal" in parsed.patch))
      return `track · ${requestedTrack} · marimba (legacy tone) · modal marimba for the mallet engine`;
    // Plain `wind` keeps the legacy tone; point at the wind engine.
    if (parsed.patch.instrument === "wind" && !("wind" in parsed.patch))
      return `track · ${requestedTrack} · wind (legacy tone) · wind flute (or sax, trumpet …) for the wind engine`;
    const sine =
      word !== undefined && !("string" in parsed.patch)
        ? plainSineAdvice(word)
        : undefined;
    if (sine) return `track · ${requestedTrack} · ${sine}`;
    const added = [
      chain.filter ? "hpf 90 Hz" : "",
      chain.fx?.compressor ? "compressor 3:1" : "",
      chain.reverb ? "plate 0.14" : "",
    ].filter(Boolean);
    if (added.length)
      return `track · ${requestedTrack} · vocal · added ${added.join(", ")} · fx … off to remove`;
    return `track · ${requestedTrack}`;
  }
  if (parsed.type === "automation") {
    const points = parsed.points.map((point) => ({
      tick: Math.max(0, Math.round(point.beat * score.ticksPerBeat)),
      value: point.value,
    }));
    const track = score.tracks.find(
      (candidate) => candidate.id === requestedTrack,
    );
    const current =
      parsed.parameter === "pan"
        ? (track?.panAutomation ?? [])
        : (track?.volumeAutomation ?? []);
    const merged =
      points.length === 0
        ? []
        : Array.from(
            new Map(
              [...current, ...points].map((point) => [point.tick, point]),
            ).values(),
          ).sort((left, right) => left.tick - right.tick);
    const next = applyScoreOperation(score, {
      type: "setAutomation",
      trackId: requestedTrack,
      parameter: parsed.parameter,
      points: merged,
    });
    await commitScore(next, "score.automation", {
      trackId: requestedTrack,
      parameter: parsed.parameter,
      points: merged,
    });
    return `automation · ${parsed.parameter} ${merged.length} point${merged.length === 1 ? "" : "s"}`;
  }
  if (parsed.type === "clear-track") {
    const next = applyScoreOperation(score, {
      type: "clearTrack",
      trackId: requestedTrack,
    });
    await commitScore(next, "score.clear", { trackId: requestedTrack });
    return `cleared · ${requestedTrack}`;
  }
  if (parsed.type === "remove-note") {
    // A receipt never claims a removal that did not happen.
    if (!score.notes.some((note) => note.id === parsed.noteId))
      return fail(noNote(parsed.noteId));
    const next = applyScoreOperation(score, {
      type: "removeNote",
      noteId: parsed.noteId,
    });
    await commitScore(next, "score.operation", {
      operation: { type: "removeNote", noteId: parsed.noteId },
    });
    return `removed · ${parsed.noteId}`;
  }
  if (parsed.type === "update-note") {
    const patch = {
      ...(typeof parsed.patch.start === "number"
        ? { startTick: Math.round(parsed.patch.start * score.ticksPerBeat) }
        : {}),
      ...(typeof parsed.patch.duration === "number"
        ? {
            durationTicks: Math.max(
              1,
              Math.round(parsed.patch.duration * score.ticksPerBeat),
            ),
          }
        : {}),
      ...(typeof parsed.patch.pitch === "number"
        ? { pitch: parsed.patch.pitch }
        : {}),
      ...(typeof parsed.patch.velocity === "number"
        ? { velocity: parsed.patch.velocity }
        : {}),
      ...(typeof parsed.patch.cents === "number"
        ? { cents: parsed.patch.cents }
        : {}),
    };
    const next = applyScoreOperation(score, {
      type: "updateNote",
      noteId: parsed.noteId,
      patch,
    });
    await commitScore(next, "score.note", {
      operation: { type: "updateNote", noteId: parsed.noteId, patch },
    });
    return `updated · ${parsed.noteId}`;
  }
  if (parsed.type !== "add-note") return "queued";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = attempt === 0 ? record : await port.load();
    const latestScore = scoreFromJSON(latest.composition);
    const note = {
      id: newId(requestedTrack),
      trackId: requestedTrack,
      startTick: Math.round(parsed.start * latestScore.ticksPerBeat),
      durationTicks: Math.max(
        1,
        Math.round(parsed.duration * latestScore.ticksPerBeat),
      ),
      pitch: parsed.pitch,
      velocity: parsed.velocity,
      ...(parsed.cents ? { cents: parsed.cents } : {}),
    };
    const operation: ScoreOperation = { type: "addNote", note };
    const next = applyScoreOperation(latestScore, operation);
    try {
      record = await port.append(
        latest,
        {
          kind: "score.operation",
          payload: { operation },
        },
        next.toJSON(),
      );
      score = next;
      if (clock.playing) void audio.play(score);
      return `added ${note.id}`;
    } catch (error) {
      if (!(error instanceof SessionConflictError)) throw error;
    }
  }
  return warn("session busy · retry the note");
}

/**
 * `/track <name>`: focus `trackId` in this window, creating it when it is
 * not in the score yet. A track another live window has focused stays
 * theirs; focus goes through the port so presence is right everywhere.
 */
async function focusTrack(
  trackId: string,
  options: { follow?: boolean } = {},
): Promise<Receipt> {
  if (trackId === requestedTrack && !draftTrack)
    return warn(`already on ${trackId}`);
  if (paneOptions.pinned)
    return warn(`pinned to ${requestedTrack} · unpin to change`);
  // Typing a track yourself stops following (§12.5).
  if (!options.follow && paneOptions.follow) paneOptions.follow = undefined;
  // Focus is not exclusive (§12.5): a track another pane shows is a soft
  // note on the receipt, never a refusal.
  const clients = await port.presence().catch(() => []);
  const sharing = clients.find(
    (client) =>
      client.clientId !== port.clientId && client.focusedTrackId === trackId,
  );
  const shared = sharing
    ? ` · ${sharing.pane ? `pane ${sharing.pane}` : "another pane"} is on ${trackId} too`
    : "";
  const existing = score.tracks.find((track) => track.id === trackId);
  const exists = existing !== undefined;
  // `track cloud`, `track hold-2`: a new granular track with that preset.
  const grainPreset = granularTrackPreset(trackId);
  if (!exists) {
    const next = applyScoreOperation(score, {
      type: "addTrack",
      track: {
        id: trackId,
        name: trackId,
        instrument: grainPreset
          ? "granular"
          : isDrumInstrument(trackId)
            ? "kit"
            : "sine",
        // `track jangle`, `track gtr-metal`…: a guitar voice and its rig.
        ...rigTrackFields(trackId),
        ...(grainPreset ? { granular: { preset: grainPreset } } : {}),
        // `/track piano` (or grand, felt…) starts on the modelled piano.
        ...newPianoTrack(trackId),
        // `track vibes`: a 0.6 modal word names the track and its preset.
        ...(isModalWord(trackId) ? instrumentPatchForWord(trackId) : {}),
        // `track vocal` (0.7): a clip track with the vocal chain.
        ...(isGuideInstrument(trackId)
          ? { instrument: "vocal", ...vocalChainPatch(undefined) }
          : {}),
      },
    });
    await commitScore(next, "track.create", { trackId });
  }
  await port.focus(trackId);
  requestedTrack = trackId;
  draftTrack = false;
  if (exists && grainPreset && existing.instrument !== "granular")
    return warn(
      `track · ${trackId} is a ${existing.instrument} track · grain ${grainPreset} makes it granular`,
    );
  return ok(
    (exists
      ? `track · ${trackId}`
      : grainPreset
        ? `track created · ${trackId} · granular ${grainPreset} · nothing to download`
        : `track created · ${trackId}`) + shared,
  );
}

/** Decode every sampler voice (cached) and return what failed to load. */
async function sampleProblems(
  value: TrackScore,
): Promise<readonly SampleProblem[]> {
  if (!hasSamplerTracks(value)) return [];
  sampleLibrary ??= new SampleLibrary({
    projectRoot: process.cwd(),
    packs: packs(),
  });
  try {
    const bank = await sampleLibrary.load(value);
    liveSampleBank = bank;
    return bank.problems;
  } catch (error) {
    return [
      {
        trackId: "",
        voice: "",
        src: "",
        level: "error",
        message: `samples · ${error instanceof Error ? error.message : String(error)} · check the sample files`,
      },
    ];
  }
}

/** Surface sample load problems once per distinct set, as receipts. */
function reportSampleProblems(value: TrackScore): void {
  if (!hasSamplerTracks(value)) return;
  void sampleProblems(value).then((problems) => {
    const key = problems.map((problem) => problem.message).join("\n");
    if (key === reportedSampleProblems) return;
    reportedSampleProblems = key;
    for (const problem of problems.slice(0, 3))
      tui.activity.pushCard(`sample ${problem.voice} · ${problem.message}`, {
        tone: problem.level === "error" ? "error" : "warning",
        trackId: problem.trackId || undefined,
      });
    if (problems.length > 3)
      tui.activity.pushCard(
        `${problems.length - 3} more sample problems · /tracks`,
        {
          tone: "warning",
        },
      );
    tickUi();
  });
}

/** `/tuning …` and `/scale …` (src/commands/tuning.ts). */
async function tuningCommand(command: TuningCommand): Promise<Receipt> {
  const projectRoot = process.cwd();
  if (command.type === "tuning-set") {
    // Scala files outside the project are copied into tunings/ first.
    try {
      const patch = { ...command.patch };
      if (patch.scl)
        patch.scl = await importTuningFile(projectRoot, projectRoot, patch.scl);
      if (patch.kbm)
        patch.kbm = await importTuningFile(projectRoot, projectRoot, patch.kbm);
      command = { ...command, patch };
    } catch (error) {
      if (error instanceof TuningError)
        return fail(`tuning · ${error.message}`);
      throw error;
    }
  }
  if (command.type === "tuning-set" || command.type === "tuning-off")
    if (command.target === "track") await materializeDraft();
  const read = (path: string): string | undefined => {
    try {
      return readFileSync(join(projectRoot, path), "utf8");
    } catch {
      return undefined;
    }
  };
  const result = applyTuningCommand(score, requestedTrack, command, read);
  if (result.panel) tui.openText(result.panel.title, result.panel.lines);
  if (result.next && result.kind)
    await commitScore(result.next, result.kind, result.payload);
  return result.ok ? ok(result.message) : fail(result.message);
}

/** `/fitmode`, `/bpm`, `/len` on the focused sampler voice (0.6). */
async function fitCommand(
  command: NonNullable<ReturnType<typeof parseFitCommand>>,
): Promise<Receipt> {
  let suggested: "beats" | "tones" | undefined;
  if (command.control === "fitmode" && command.value === undefined) {
    const target = fitVoice(score, requestedTrack, command.voice);
    if ("error" in target) return fail(target.error);
    const decoded = liveSampleBank?.voices.get(
      sampleKey(requestedTrack, target.voice),
    );
    if (!decoded)
      return warn(
        "fit · the sample is still loading · fitmode repitch|beats|tones",
      );
    suggested = suggestFitMode(decoded.mono, decoded.sampleRate);
  }
  const result = applyFitCommand(score, requestedTrack, command, suggested);
  if (!result.ok) return fail(result.message);
  await commitScore(result.next, "sample.set", { trackId: requestedTrack });
  await projectSync?.flushScore();
  return ok(
    suggested
      ? `${result.message} · suggested from the sound (${suggested === "beats" ? "hits" : "held tones"})`
      : result.message,
  );
}

/** `/chop …`: the audio chop toolkit (same runChop as the agent's audio tool). */
async function chopCommand(
  command: NonNullable<ReturnType<typeof parseChopCommand>>,
): Promise<Receipt> {
  if (command.kind === "help") {
    tui.openText("chop", chopHelpLines());
    return ok("chop · /chop <op> <file> …");
  }
  if (command.kind === "error") return fail(command.message);
  const focused = score.tracks.find((track) => track.id === requestedTrack);
  const slug = chopTrackSlug(focused?.name ?? requestedTrack);
  tui.activity.setSpinner(`chop ${command.op}`);
  let result: ChopResult;
  try {
    result = await runChop(command.op, command.args, {
      root: process.cwd(),
      runner: systemRunner,
      signal: new AbortController().signal,
      trackSlug: slug,
      tempo: { bpm: score.tempoBpm, beatsPerBar: score.beatsPerBar },
      actor: { kind: "human" },
      ascii: !tui.capabilities.unicode,
      audition: async (path, from, to) => {
        await playFileForAgent(path, from, to);
      },
      // Default: historySink(), set when the session opens (lane hist).
      ...(mediaServices().chopHistory
        ? { history: mediaServices().chopHistory! }
        : {}),
    });
  } catch (error) {
    return fail(
      `chop ${command.op} · ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    tui.activity.setSpinner(undefined);
  }
  if (command.op === "slice" && command.args.track) {
    await materializeDraft();
    const trackId = command.args.track;
    let loaded;
    try {
      loaded = slicesToSampler(
        score,
        trackId,
        stemOf(command.args.input ?? "slice"),
        result.outputs,
        {
          ...(command.args.pattern ? { pattern: true } : {}),
          newNoteId: (index) => `${trackId}-chop-${record.revision}-${index}`,
        },
      );
    } catch (error) {
      return fail(
        `chop slice · ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let next = score;
    for (const operation of loaded.operations)
      next = applyScoreOperation(next, operation);
    await commitScore(next, "audio.slice", {
      trackId,
      voices: loaded.voices,
    });
    await projectSync?.flushScore();
    return ok(
      `${result.summary} · ${loaded.voices.length} voices on ${trackId}${loaded.notes ? ` · ${loaded.notes} notes` : ""} · ctrl-z undoes`,
    );
  }
  const lines = chopResultLines(result);
  if (lines.length > 1) tui.openText(`chop ${command.op}`, lines);
  return ok(result.summary);
}

function chopResultLines(result: ChopResult): string[] {
  const lines = [result.summary];
  if (result.info)
    lines.push(
      `${result.info.path} · ${result.info.seconds.toFixed(2)} s · ${result.info.sampleRate} Hz · ${result.info.channels} ch · ${result.info.format}`,
      `peak ${result.info.peakDb} dB · rms ${result.info.rmsDb} dB · sha256 ${result.info.sha256.slice(0, 12)}`,
    );
  if (result.peaks) lines.push("", result.peaks.text);
  if (result.bpm) lines.push(`bpm ${result.bpm}`);
  for (const point of (result.points ?? []).slice(0, 64))
    lines.push(
      `${point.t.toFixed(3)} s${point.end !== undefined ? ` – ${point.end.toFixed(3)} s` : ""}${point.score !== undefined ? ` · score ${point.score.toFixed(2)}` : ""}${point.label ? ` · ${point.label}` : ""}`,
    );
  if ((result.points?.length ?? 0) > 64)
    lines.push(
      `… ${result.points!.length - 64} more (dawg media chop … --json)`,
    );
  for (const output of result.outputs)
    lines.push(
      `→ ${output.path} · ${output.seconds.toFixed(2)} s · peak ${output.peakDb} dB`,
    );
  if (result.truncated)
    lines.push(
      `analyzed ${result.truncated.analysedSeconds} s of ${result.truncated.totalSeconds} s`,
    );
  return lines;
}

/** Play a file (or range) through the agent preview voice; false when silent. */
async function playFileForAgent(
  path: string,
  from?: number,
  to?: number,
): Promise<boolean> {
  const engine = liveEngine();
  if (!engine?.canMonitor) return false;
  const rendered = await auditionPcm(
    path,
    systemRunner,
    previewEngine().sampleRate,
    from,
    to,
  );
  return (await agentPreviewHost().play?.(rendered)) ?? false;
}

async function resampleCommand(
  command: NonNullable<ReturnType<typeof parseResampleCommand>>,
): Promise<Receipt> {
  await materializeDraft();
  // The source's own samples must be loaded for the render.
  if (hasSamplerTracks(score)) await sampleProblems(score);
  const result = await runResample({
    projectRoot: process.cwd(),
    score,
    command,
    ...(liveSampleBank ? { samples: liveSampleBank } : {}),
  });
  if (!result.ok) return fail(result.message);
  const problems = (await sampleProblems(result.next)).filter(
    (problem) =>
      problem.trackId === result.trackId && problem.level === "error",
  );
  if (problems.length > 0) return fail(`resample · ${problems[0]!.message}`);
  await commitScore(result.next, "resample", {
    trackId: result.trackId,
    src: result.src,
    sha256: result.sha256,
  });
  await port.focus(result.trackId);
  requestedTrack = result.trackId;
  draftTrack = false;
  await projectSync?.flushScore();
  return ok(result.message);
}

async function sampleCommand(
  command: NonNullable<ReturnType<typeof parseSampleCommand>>,
): Promise<Receipt> {
  if (command.kind === "list") {
    const track = score.tracks.find((item) => item.id === requestedTrack);
    const lines = listSampleVoices(track);
    if (lines.length === 0)
      return warn(
        `sample · ${requestedTrack} has no samples · /sample <path> [as <voice>]`,
      );
    tui.openText(`samples · ${requestedTrack}`, lines);
    return ok(`${lines.length} sample${lines.length === 1 ? "" : "s"}`);
  }
  if (command.kind === "set") {
    const result = setSampleControls(
      score,
      requestedTrack,
      command.voice,
      command.values,
    );
    if (!result.ok) return fail(result.message);
    await commitScore(result.next, "sample.set", {
      trackId: requestedTrack,
      voice: command.voice,
    });
    await projectSync?.flushScore();
    return ok(result.message);
  }
  await materializeDraft();
  const trackId = samplerTarget(score, requestedTrack);
  const voice =
    command.voice ?? freeVoiceName(score, trackId, voiceNameFrom(command.path));
  let placed;
  try {
    placed = await placeSampleFile({
      projectRoot: process.cwd(),
      cwd: process.cwd(),
      input: command.path,
      score,
      trackId,
      voice,
    });
  } catch (error) {
    if (error instanceof SamplePlacementError)
      return fail(`sample · ${error.message} · check the path and retry`);
    throw error;
  }
  const result = addSampleVoice(score, trackId, voice, {
    src: placed.src,
    sha256: placed.sha256,
  });
  if (!result.ok) return fail(result.message);
  // Decode before committing so a bad file is a receipt, not a silent voice.
  const problems = (await sampleProblems(result.next)).filter(
    (problem) => problem.trackId === trackId && problem.voice === voice,
  );
  if (problems.some((problem) => problem.level === "error"))
    return fail(`sample · ${problems[0]!.message}`);
  await commitScore(result.next, "sample.add", {
    trackId,
    voice,
    src: placed.src,
  });
  if (trackId !== requestedTrack) {
    await port.focus(trackId);
    requestedTrack = trackId;
    draftTrack = false;
  }
  await projectSync?.flushScore();
  return ok(
    `${result.message}${placed.copied ? ` · copied to ${placed.src}` : ""}`,
  );
}

function packs(): PackStore {
  packStore ??= new PackStore();
  return packStore;
}

/** Keeps CREDITS.md in step with the CC-BY packs the score uses (quietly). */
async function updateCredits(value: TrackScore): Promise<void> {
  const refs = value.tracks.flatMap((track) =>
    Object.values(track.sampler?.voices ?? {}),
  );
  if (!refs.some((ref) => ref.src.startsWith("pack:"))) return;
  // Only a dawg project gets CREDITS.md; a bare session directory does not.
  if (!projectSync) return;
  try {
    await writeCredits(process.cwd(), packCredits(refs, await packs().list()));
  } catch {
    /* credits are best effort; render metadata carries them too */
  }
}

/** Applies a pack edit as one undo step and focuses its track. */
async function commitPackEdit(
  operations: readonly ScoreOperation[],
  trackId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<Receipt | undefined> {
  let next = score;
  for (const operation of operations)
    next = applyScoreOperation(next, operation);
  const problems = (await sampleProblems(next)).filter(
    (problem) => problem.trackId === trackId && problem.level === "error",
  );
  if (problems.length > 0) return fail(`sound · ${problems[0]!.message}`);
  await commitScore(next, kind, payload);
  if (stageCapture) return undefined;
  if (trackId !== requestedTrack) {
    await port.focus(trackId);
    requestedTrack = trackId;
    draftTrack = false;
  }
  await projectSync?.flushScore();
  return undefined;
}

async function packCommand(command: PackCommand): Promise<Receipt> {
  try {
    if (command.kind === "usage") return warn(command.message);
    if (command.kind === "list") {
      const lines = packListLines(await packs().list());
      tui.openText("packs", lines);
      return ok(`${lines.length} packs · /pack info <name>`);
    }
    if (command.kind === "cache") {
      const library = (sampleLibrary ??= new SampleLibrary({
        projectRoot: process.cwd(),
        packs: packs(),
      }));
      let freed: { files: number; bytes: number } | undefined;
      if (command.pruneTo !== undefined) {
        const to = (cap: number) =>
          command.pruneTo === "cap" ? cap : (command.pruneTo as number);
        const store = packs();
        const a = await store.pruneCache(to(store.maxFileCacheBytes));
        const b = await library.pruneCache(to(library.maxCacheBytes));
        const c = await pruneAnalysisCache(
          analysisDir(process.cwd()),
          to(ANALYSIS_CACHE_BYTES),
        );
        freed = {
          files: a.removed + b.removed + c.removed,
          bytes: a.freed + b.freed + c.freed,
        };
      }
      const lines = cacheLines({
        packs: await packs().cacheStatus(),
        assets: await library.cacheStatus(),
        analysis: await analysisCacheStatus(process.cwd()),
        ...(freed ? { freed } : {}),
      });
      tui.openText("cache", lines);
      return ok(lines[0]!);
    }
    if (command.kind === "add") {
      const added = await packs().add(
        command.source,
        command.name ? { name: command.name } : {},
      );
      return ok(
        `pack added · ${added.pack.name} · ${added.sounds} sounds · /pack info ${added.pack.name}`,
      );
    }
    if (command.kind === "info") {
      const info = await packs().info(command.name);
      if (!info)
        return fail(
          `pack · no pack named ${command.name.slice(0, 40)} · /pack list`,
        );
      const manifest = await packs().manifest(info.name);
      const banks = banksOf(manifest);
      const names = [...manifest.sounds.keys()];
      const lines = [
        `${info.name} · ${info.title}`,
        `license · ${info.license}${info.attribution ? ` · ${info.attribution}` : ""}`,
        `manifest · ${info.manifestUrl}`,
        ...(info.homepage ? [`home · ${info.homepage}`] : []),
        `${names.length} sounds${banks.length ? ` · ${banks.length} kits` : ""}`,
        ...(banks.length ? [`kits · ${banks.join(" ")}`] : []),
        ...names.slice(0, 400).map((name) => {
          const sound = manifest.sounds.get(name)!;
          return `${name} · ${sound.kind === "zones" ? `${sound.zones.length} notes (keyed)` : `${sound.files.length} file${sound.files.length === 1 ? "" : "s"}`}`;
        }),
      ];
      tui.openText(`pack · ${info.name}`, lines);
      return ok(
        `${info.name} · ${names.length} sounds · /pack use ${info.name}/<sound>`,
      );
    }
    if (command.kind === "remove") {
      const known = await packs().remove(command.name);
      return known
        ? ok(`pack removed · ${command.name}`)
        : fail(
            `pack · no pack named ${command.name.slice(0, 40)} · /pack list`,
          );
    }
    await materializeDraft();
    const result = await useSound(
      packs(),
      score,
      requestedTrack,
      command.sound,
      {
        ...(command.voice ? { voice: command.voice } : {}),
      },
    );
    const failed = await commitPackEdit(
      result.operations,
      result.trackId,
      "pack.use",
      {
        trackId: result.trackId,
        sound: command.sound,
      },
    );
    return failed ?? ok(`sound · ${result.summary}`);
  } catch (error) {
    if (error instanceof PackError) return fail(`pack · ${error.message}`);
    throw error;
  }
}

/**
 * Resolves the patch a command names outside the song before it applies:
 * a `github:` source is fetched and pinned, any other name not built in or
 * in the song's library is read from the user library.
 */
async function patchEnv(command: PatchCommand): Promise<PatchEnv | string> {
  const source = patchSourceOf(command);
  if (source === undefined) return {};
  try {
    if (isPatchSource(source)) {
      const loaded = await loadPatchSource(source, { store: packs() });
      return { fetched: { source, patch: loaded.patch, from: loaded.from } };
    }
    if (builtinPatch(source) || score.patches[source]) return {};
    const file = await readUserPatch(source);
    return file
      ? { userPatch: (name) => (name === source ? file.patch : undefined) }
      : {};
  } catch (error) {
    return `patch: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Runs one typed `patch …` line (src/commands/patch.ts) on the focused track. */
async function runPatchCommand(command: PatchCommand): Promise<Receipt> {
  const reads = command.type === "patch-show" || command.type === "patch-nodes";
  if (!reads) await materializeDraft();
  const env = await patchEnv(command);
  if (typeof env === "string") return fail(env);
  const result = applyPatchCommand(score, requestedTrack, command, env);
  if (!result.ok) return fail(result.message);
  if (result.read) {
    const lines = result.message.split("\n");
    if (lines.length > 1) {
      tui.openText(
        command.type === "patch-show" ? "patch" : "patch nodes",
        lines,
      );
      return note(`${lines[0]} · ${lines.length} lines`);
    }
    return note(result.message);
  }
  if (result.effect?.kind === "save-user") {
    try {
      await saveUserPatch(result.effect.patch, {
        name: result.effect.name,
        ...(result.effect.macros ? { macros: result.effect.macros } : {}),
      });
    } catch (error) {
      return fail(
        `patch save: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (result.next && result.kind)
    await commitScore(result.next, result.kind, result.payload);
  return ok(result.message);
}

/**
 * A command result as a receipt: a refusal is ✗, a change is ✓, and a read
 * that changed nothing (a listing or a show) is •.
 */
function readOrDone(
  result: Readonly<{ ok: boolean; message: string; next?: unknown }>,
): Receipt {
  if (!result.ok) return fail(result.message);
  return result.next ? ok(result.message) : note(result.message);
}

async function patternCommand(command: PatternCommand): Promise<Receipt> {
  if (command.kind === "list") {
    tui.openText("grooves", DRUM_PATTERNS.map(patternLine));
    return note(`grooves · ${DRUM_PATTERNS.length} · groove <name>`);
  }
  if (command.kind === "browse") {
    tui.openPicker({
      id: "pattern",
      title: "grooves",
      hint: HINTS.audition,
      audition: true,
      items: DRUM_PATTERNS.map((entry) => ({
        label: `${entry.label.padEnd(22)} ${entry.tempo.bpm} BPM · ${entry.tags.join(", ")}`,
        value: `/groove ${entry.name}`,
      })),
      filterable: true,
      index: 0,
    });
    patternPreview = undefined;
    previewPattern(DRUM_PATTERNS[0]?.name);
    return note("grooves · ↑/↓ preview · Enter applies on the focused track");
  }
  await materializeDraft();
  const result = applyDrumPattern(
    score,
    requestedTrack,
    command.name,
    command.tempo,
  );
  if (result.next && result.kind)
    await commitScore(result.next, result.kind, result.payload);
  return result.ok ? ok(result.message) : fail(result.message);
}

/**
 * Play one bar of the pattern under the picker cursor, on a scratch copy
 * of the focused track (or a fresh kit track when the focus is melodic).
 * Silent while the loop plays, like the Euclidean editor's audition.
 */
function previewPattern(name: string | undefined): void {
  if (!name || name === patternPreview) return;
  patternPreview = name;
  if (clock.playing) return;
  const entry = DRUM_PATTERNS.find((candidate) => candidate.name === name);
  if (!entry) return;
  let result = applyDrumPattern(score, requestedTrack, entry.name, "set");
  let trackId = requestedTrack;
  if (!result.next) {
    trackId = "pattern-preview";
    result = applyDrumPattern(score, trackId, entry.name, "set");
  }
  if (!result.next) return;
  const engine = liveEngine();
  if (!engine?.canMonitor) return;
  const pcm = renderAudition({
    score: result.next,
    trackId,
    bars: 1,
    sampleRate: engine.sampleRate,
    ...(liveSampleBank ? { samples: liveSampleBank } : {}),
  });
  if (!pcm) return;
  void engine
    .monitor(true)
    .then(() => engine.noteOn(AUDITION_VOICE, pcm))
    .catch(() => undefined);
}

async function favorites(): Promise<Set<string>> {
  return (presetFavorites ??= await loadFavorites());
}

function browserOptions(current = trackPreset(focusedTrack())): BrowserOptions {
  const track = focusedTrack();
  return {
    favorites: presetFavorites ?? new Set(),
    current,
    drums: track ? isDrumInstrumentTrack(track) : false,
    ascii: !tui.ui.capabilities.unicode,
  };
}

function focusedTrack() {
  return score.tracks.find((track) => track.id === requestedTrack);
}

/** `preset …` (core/presets): load, list, describe, star, browse. */
async function runPresetCommand(command: PresetCommand): Promise<Receipt> {
  const favs = await favorites();
  if (command.type === "preset-browse") {
    openPresetBrowser(command.list);
    return note(
      command.list
        ? `presets › ${command.list} · ↑↓ hear · enter keeps · esc reverts`
        : "presets · enter opens a category · type to search all",
    );
  }
  if (command.type === "preset-use" || command.type === "preset-step")
    await materializeDraft();
  const result = applyPresetCommand(score, requestedTrack, command, favs);
  if (result.favorites) {
    presetFavorites = new Set(result.favorites);
    await saveFavorites(presetFavorites).catch(() => undefined);
  }
  if (result.next && result.kind)
    await commitScore(result.next, result.kind, result.payload);
  if (result.read && result.ok) {
    const lines = result.message.split("\n");
    if (lines.length > 1) tui.openText("presets", lines);
    return note(lines[0]!);
  }
  return result.ok
    ? result.next
      ? ok(result.message)
      : note(result.message)
    : fail(result.message);
}

/** The preset browser: categories, or one list (`/presets bass`). */
function openPresetBrowser(list?: PresetListKind, like?: string): void {
  const options = browserOptions(
    like ? (presetByName(like) ?? trackPreset(focusedTrack())) : undefined,
  );
  const spec = list
    ? presetPicker(
        list,
        list === "similar" && !like ? browserOptions() : options,
      )
    : categoryPicker(browserOptions());
  if (!spec) {
    tui.activity.pushCard(
      list === "favorites"
        ? "starred · none yet · * stars a preset in the browser"
        : `presets · ${list} is empty · /presets`,
      { tone: "info" },
    );
    if (list) openPresetBrowser();
    return;
  }
  presetPreviewed = undefined;
  tui.openPicker(spec);
}

/** A browser key: * stars, → similar or open, ← back to categories. */
async function presetPickerKey(
  picker: string,
  key: string,
  value: string,
): Promise<void> {
  const name = value.startsWith("preset ") ? value.slice(7) : undefined;
  if (key === "*" && name) {
    const favs = await favorites();
    const result = applyPresetCommand(
      score,
      requestedTrack,
      {
        type: "preset-fav",
        name,
      },
      favs,
    );
    if (result.favorites) {
      presetFavorites = new Set(result.favorites);
      await saveFavorites(presetFavorites).catch(() => undefined);
    }
    // Redraw the rows with the star, keeping the list and the cursor.
    const open = tui.ui.picker;
    if (open?.id === picker) {
      const kind =
        picker === "presets" ? undefined : (open.title.split("› ")[1] ?? "");
      const at = open.index;
      const query = open.query;
      const listName = kind?.startsWith("like ")
        ? "similar"
        : kind === "starred"
          ? "favorites"
          : kind;
      const spec = listName
        ? presetPicker(
            listKind(listName) ?? "all",
            browserOptions(
              kind?.startsWith("like ")
                ? presetByName(kind.slice(5))
                : undefined,
            ),
          )
        : categoryPicker(browserOptions());
      if (spec) {
        tui.openPicker({ ...spec, index: at });
        if (query) {
          const reopened = tui.ui.picker;
          if (reopened) reopened.query = query;
        }
      }
    }
    tui.activity.pushCard(result.message, { tone: "info" });
    return;
  }
  if (key === "left") {
    if (picker === "preset") openPresetBrowser();
    return;
  }
  if (key === "right") {
    if (name) openPresetBrowser("similar", name);
    else if (value.startsWith("/presets ")) {
      const list = listKind(value.slice(9));
      if (list) openPresetBrowser(list);
    }
  }
}

/**
 * Moving in the browser plays the preset once: one bar of the focused
 * track's own notes through it, else its standard phrase (the quality
 * check's) cut to a few seconds. With the loop on, the row is heard on the
 * loop instead (hoverItem), as in every auditioning list.
 */
function previewPreset(value: string): void {
  if (!value.startsWith("preset ")) return;
  const name = value.slice(7);
  if (name === presetPreviewed) return;
  presetPreviewed = name;
  if (clock.playing) return;
  const preset = presetByName(name);
  const engine = liveEngine();
  if (!preset || !engine?.canMonitor) return;
  const used = usePreset(score, requestedTrack, preset);
  let pcm = used.next
    ? renderAudition({
        score: used.next,
        trackId: requestedTrack,
        bars: 1,
        sampleRate: engine.sampleRate,
        ...(liveSampleBank ? { samples: liveSampleBank } : {}),
      })
    : undefined;
  if (!pcm && preset.patch) {
    const phrase = presetPhrase(preset).filter((n) => n.start < 3.8);
    pcm = renderAudition({
      score: presetScore(preset, phrase, 4),
      trackId: "t",
      bars: 2,
      sampleRate: engine.sampleRate,
    });
  }
  if (!pcm) return;
  void engine
    .monitor(true)
    .then(() => engine.noteOn(AUDITION_VOICE, pcm))
    .catch(() => undefined);
}

/** `,` / `.` in play mode: the neighbouring preset, as `preset prev|next`. */
function presetStepFromPlay(step: 1 | -1): string | undefined {
  const preset = steppedPreset(focusedTrack(), step);
  if (!preset) return "no presets to step through";
  runTyped([`preset ${preset.name}`]);
  return `preset ${preset.name} · ${preset.category} · , . step`;
}

/** `/kit` with no name: one picker with the synth kits and the sample kits. */
function openKitPicker(): Receipt {
  const current = score.tracks.find((track) => track.id === requestedTrack);
  const items = kitCatalog().map((entry) => ({
    label: `${entry.kind === "synth" ? "synth " : "sample"}  ${entry.label.padEnd(18)} ${entry.detail}`,
    value: entry.command,
    current:
      entry.kind === "synth" &&
      isDrumInstrumentTrack(current) &&
      (current?.kit ?? "default") === entry.name,
  }));
  tui.openPicker({
    id: "kit",
    title: "kits",
    hint: HINTS.audition,
    audition: true,
    items,
    filterable: true,
    index: Math.max(
      0,
      items.findIndex((item) => item.current),
    ),
  });
  return ok("kits · synth kits work offline · sample kits are fetched once");
}

function isDrumInstrumentTrack(track: { instrument: string } | undefined) {
  return track !== undefined && isDrumInstrument(track.instrument);
}

async function kitCommand(command: KitCommand, bare = false): Promise<Receipt> {
  if (bare) return openKitPicker();
  if (command.kind === "set" && isSynthKitName(command.bank)) {
    await materializeDraft();
    const result = applySynthKit(score, requestedTrack, command.bank);
    if (result.next && result.kind)
      await commitScore(result.next, result.kind, result.payload);
    return result.ok ? ok(result.message) : fail(result.message);
  }
  if (command.kind === "list") {
    const lines = kitCatalog()
      .filter((entry) => entry.kind === "synth")
      .map((entry) => `${entry.name} · synth · ${entry.detail}`);
    lines.push(...kitListLines(await packs().bankAliases(ALIASED_PACK)));
    tui.openText("kits", lines);
    return note("kits · /kit <name or nickname> on the focused drum track");
  }
  await materializeDraft();
  const trackId = kitTarget(score, requestedTrack);
  if (!trackId)
    return fail(
      `kit · ${requestedTrack} is a melodic track · focus a drum track (/track drums) and retry`,
    );
  try {
    const result = await useKit(packs(), score, trackId, command.bank);
    const failed = await commitPackEdit(
      result.operations,
      trackId,
      "pack.kit",
      {
        trackId,
        bank: command.bank,
      },
    );
    return failed ?? ok(result.summary);
  } catch (error) {
    if (error instanceof PackError) return fail(`kit · ${error.message}`);
    throw error;
  }
}

async function wavetableCommand(command: WavetableCommand): Promise<Receipt> {
  if (command.kind === "usage") return warn(command.message);
  if (command.kind === "show")
    return ok(describeWavetable(score, requestedTrack));
  if (command.kind === "list") {
    tui.openText(
      "wavetables",
      await wavetableListLines(packs(), process.cwd()),
    );
    return ok("wavetables · wt <table> sets the focused track");
  }
  await materializeDraft();
  const trackId = requestedTrack;
  try {
    const edit =
      command.kind === "table"
        ? await pickWavetable(
            packs(),
            score,
            trackId,
            command.table,
            process.cwd(),
          )
        : wavetableParamEdit(score, trackId, command);
    const failed = await commitPackEdit(
      [edit.operation],
      trackId,
      "track.wavetable",
      { trackId, ...command },
    );
    return failed ?? ok(edit.summary);
  } catch (error) {
    if (error instanceof PackError) return fail(`wavetable · ${error.message}`);
    throw error;
  }
}

async function readLoopFile(path: string): Promise<string> {
  const contents = await readFile(resolve(path));
  if (contents.byteLength > 512 * 1024)
    throw new Error("loop import exceeds 512 KiB");
  return contents.toString("utf8");
}

/**
 * Adds the focused track to the score when it is missing (an explicit
 * `--track`, or a draft on its first edit), retrying past concurrent writes.
 */
async function ensureFocusedTrack(): Promise<void> {
  if (score.tracks.some((track) => track.id === requestedTrack)) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = attempt === 0 ? record : await port.load();
    const latestScore = scoreFromJSON(latest.composition);
    if (latestScore.tracks.some((track) => track.id === requestedTrack)) {
      record = latest;
      score = latestScore;
      return;
    }
    const next = withTrack(latestScore, requestedTrack);
    try {
      record = await port.append(
        latest,
        { kind: "track.attach", payload: { trackId: requestedTrack } },
        next.toJSON(),
      );
      score = next;
      return;
    } catch (error) {
      if (!(error instanceof SessionConflictError)) throw error;
    }
  }
}

/** A draft track becomes real on the window's first edit. */
async function materializeDraft(): Promise<void> {
  if (!draftTrack) return;
  await ensureFocusedTrack();
  draftTrack = false;
}

function adoptMeta(meta: typeof record.meta): void {
  if (meta.version < record.meta.version) return;
  record = { ...record, meta };
  if (meta.name !== announcedName) {
    announcedName = meta.name;
    // The auto-name joins the receipt that earned it, as a quiet suffix.
    if (meta.nameSource === "auto")
      tui.activity.attachNote(`named “${meta.name}” · /rename`);
    else tui.activity.pushCard(`session · ${meta.name}`, { tone: "info" });
  }
}

function makeNamer(): AutoNamer {
  const target = namingTarget(
    process.cwd(),
    () => ({ port, record }),
    (meta) => adoptMeta(meta),
  );
  return new AutoNamer({
    // Name the committed score at its revision (never a staged preview or
    // a turn's older snapshot): windows then agree on one name per revision,
    // and a run that read an older revision is dropped as stale.
    target: {
      ...target,
      current: () => ({
        score: scoreFromJSON(record.composition),
        revision: record.revision,
      }),
    },
    // DAWG_AI=0 keeps naming local; an offline provider falls back too.
    generator:
      process.env.DAWG_AI === "0"
        ? undefined
        : providerNameGenerator(currentProvider),
  });
}

/** `/comment`, `/comments`, `/history` (src/history/wire.ts). */
async function historyCommand(command: string): Promise<Receipt | undefined> {
  const reply = runHistoryLine(
    command,
    historyHost,
    history,
    stdout.columns ?? 80,
  );
  if (reply === undefined) return undefined;
  if ("view" in reply) tui.openText(reply.view.title, reply.view.lines);
  if ("picker" in reply)
    tui.openPicker({ id: "history", filterable: true, ...reply.picker });
  if ("jump" in reply) {
    if (
      reply.jump.trackId !== undefined &&
      reply.jump.trackId !== requestedTrack
    ) {
      await port.focus(reply.jump.trackId);
      requestedTrack = reply.jump.trackId;
    }
    if (reply.jump.beat !== undefined) await seekTransport(reply.jump.beat);
  }
  return reply.tone === "ok"
    ? ok(reply.text)
    : reply.tone === "warn"
      ? warn(reply.text)
      : fail(reply.text);
}

/** `/sessions`, `/resume`, `/rename`, `/fork`; undefined when not one. */
async function sessionCommand(
  command: string,
): Promise<string | Receipt | undefined> {
  const match = command.match(/^\/(sessions|resume|rename|fork)(?:\s+(.*))?$/i);
  if (!match) return undefined;
  const verb = match[1]!.toLowerCase();
  const arg = (match[2] ?? "").trim();
  const workspace = process.cwd();
  if (verb === "rename") {
    if (!arg)
      return record.meta.nameSource === "auto"
        ? `${record.meta.name} (auto-named) · rename with /rename <name>`
        : `${record.meta.name} (named by you) · /rename --auto to auto-name`;
    if (arg === "--auto") {
      const result = await port.updateMeta({
        nameSource: "auto",
        namedFingerprint: null,
        namedStructure: null,
      });
      adoptMeta(result.meta);
      namer.request(score);
      return "auto-naming on";
    }
    const name = normalizeSessionName(arg);
    // Announced before the write: the session watcher can deliver the new
    // name before updateMeta returns, which would card the rename twice.
    announcedName = name;
    // Unconditional: the latest user rename wins over any in-flight auto-name.
    const result = await port.updateMeta({ name, nameSource: "user" });
    announcedName = result.meta.name;
    adoptMeta(result.meta);
    return `renamed · ${result.meta.name}`;
  }
  const sessions = await listSessions(workspace);
  if (verb === "resume" && !arg) {
    const readable = sessions.filter((session) => !session.error).slice(0, 64);
    if (readable.length === 0) return warn("no sessions to resume");
    const current = readable.findIndex(
      (session) => session.sessionId === record.sessionId,
    );
    tui.openPicker({
      id: "resume",
      title: "resume a session",
      items: readable.map((session) => ({
        label: `${session.sessionId === record.sessionId ? "* " : "  "}${formatSessionLine(session, sessions)}`,
        value: session.sessionId,
      })),
      index: Math.max(0, current),
    });
    return "resume · 1-9 shown · /resume <name|id>";
  }
  if (verb === "sessions") {
    const lines = pickerLines(
      sessions,
      record.sessionId,
      (session) => formatSessionLine(session, sessions),
      MAX_LISTED_SESSIONS,
    );
    tui.openText("sessions · * current · /resume <n>", lines);
    return ok(`${lines.length} session${lines.length === 1 ? "" : "s"}`);
  }
  if (agentTurn) return warn("agent busy · finish or Esc first");
  if (verb === "fork") {
    const forked = await forkSession(workspace, record, arg || undefined);
    await switchSession(forked.sessionId);
    return `forked · ${forked.meta.name}`;
  }
  const readable = sessions.filter((session) => !session.error);
  // Any list index works, not only the digits the picker binds.
  const index = /^\d+$/.test(arg) ? Number(arg) - 1 : -1;
  let sessionId = readable[index]?.sessionId;
  if (sessionId === undefined)
    try {
      sessionId = await resolveSessionArg(workspace, arg, sessions);
    } catch (error) {
      if (!(error instanceof SessionLookupError)) throw error;
      return fail(error.message.replace(" · dawg sessions", " · /sessions"));
    }
  if (sessionId === record.sessionId)
    return warn(`already in ${record.meta.name}`);
  await switchSession(sessionId);
  return `resumed · ${record.meta.name} · ${requestedTrack}${draftTrack ? " (new)" : ""}`;
}

/** Leaves the current session and attaches this window to `sessionId`. */
async function switchSession(sessionId: string): Promise<void> {
  // Play mode belongs to the old session's engine and track.
  await play?.exit();
  play = undefined;
  if (clock.playing) await setTransport("pause");
  namer.dispose();
  await port.close();
  const next = await ensureSession(initial.toJSON(), {
    sessionId,
    setCurrent: true,
  });
  port = await openSessionPort<ReturnType<TrackScore["toJSON"]>>({
    actor,
    paths: next.paths,
    sessionId,
    label: "window",
    focusedTrackId: null,
  });
  audio = port.player;
  record = port.mode === "daemon" ? await port.load() : next.record;
  score = scoreFromJSON(record.composition);
  clock.follow(score);
  const attached = await attachTrack(port, score, undefined);
  requestedTrack = attached.trackId;
  draftTrack = attached.draft;
  announcedName = record.meta.name;
  namer = makeNamer();
  rebindPort();
  if (attached.draft)
    tui.activity.pushCard(ALL_TRACKS_OPEN_HINT, {
      tone: "info",
      trackId: requestedTrack,
    });
}

function liveEngine(): LiveEngine | undefined {
  return previewEngine();
}

/**
 * The engine play mode sounds through: dawgd's shared engine when the
 * daemon offers one (every pane's notes and one click mix there, §12.3),
 * else this window's own monitor. Never both.
 */
function playEngine(): LiveEngine | undefined {
  const link = port.liveLink();
  if (!link) return previewEngine();
  if (sharedLive?.link !== link)
    sharedLive = { link, engine: new SharedLiveEngine(link) };
  return sharedLive.engine;
}

/**
 * What this pane shows, for the other panes' presence markers (§12.7):
 * sent only when it changes, and only to a daemon that has panes.
 */
function paneView(): PaneView {
  const session = play;
  const view: PaneView = {
    screen: session?.on
      ? "play"
      : patchView.on
        ? "patch"
        : tape.on
          ? "tape"
          : fader
            ? "sound"
            : menu.open
              ? "menu"
              : "home",
  };
  if (fader) view.param = fader.label.slice(0, 64);
  if (session?.on) view.playing = true;
  if (session?.recording)
    view.recording = session.replace ? "replace" : "overdub";
  if (paneOptions.pinned) view.pinned = true;
  if (paneOptions.follow) view.follow = paneOptions.follow;
  return view;
}
function reportView(): void {
  const view = paneView();
  const key = JSON.stringify(view);
  if (key === reportedView) return;
  reportedView = key;
  port.setView(view);
}

/**
 * `dawg pane <screen> …` at launch: focus its track, then open the screen
 * through the same commands a person would type, so the pane starts where
 * the shell line said.
 */
async function openPane(pane: PaneArgs): Promise<void> {
  paneOptions.pinned = pane.pin;
  paneOptions.follow = pane.follow;
  let result: string | Receipt | undefined;
  if (pane.screen === "play") result = await enterPlay();
  else if (pane.screen === "tape") result = await enterTape();
  else if (pane.screen === "patch") result = await enterPatch(pane.param);
  else if (pane.screen === "sound")
    result = await submit(pane.param ?? "volume");
  else if (pane.screen === "menu")
    result = await submit(`/menu${pane.param ? ` ${pane.param}` : ""}`);
  if (result !== undefined) receipt(result);
}

/**
 * Other panes on `trackId`, for a track row's gutter (§12.7): their letters,
 * a red-dot `●` after a pane that is recording. Empty for a solo window.
 */
function paneMarks(trackId: string): string {
  const marks = panePresence
    .filter(
      (entry) =>
        entry.clientId !== port.clientId &&
        entry.pane &&
        entry.focusedTrackId === trackId,
    )
    .map((entry) => `${entry.pane}${entry.recording ? "●" : ""}`);
  return marks.length ? `  ${marks.join(" ")}` : "";
}

/**
 * Another pane recording on `trackId` (§12.4): `pane B`, else undefined.
 * Play refuses to replace a pass while one is, naming it.
 */
function recordingPane(trackId: string): string | undefined {
  const other = panePresence.find(
    (entry) =>
      entry.clientId !== port.clientId &&
      entry.recording !== undefined &&
      entry.focusedTrackId === trackId,
  );
  if (!other) return undefined;
  return other.pane ? `pane ${other.pane}` : "another pane";
}

/** A drawer row another pane has open on this track shows its letter. */
function withPaneMarks(view: DrawerView): DrawerView {
  const others = panePresence.filter(
    (entry) =>
      entry.clientId !== port.clientId &&
      entry.pane &&
      entry.param &&
      entry.screen === "sound" &&
      entry.focusedTrackId === requestedTrack,
  );
  if (others.length === 0) return view;
  return {
    ...view,
    fields: view.fields.map((field) => {
      const peers = others
        .filter((entry) => entry.param === field.label)
        .map((entry) => entry.pane)
        .join(" ");
      return peers ? { ...field, peers } : field;
    }),
  };
}

/** One pane's line for `pane`: letter, screen, track, parameter, state. */
function paneLine(entry: PresenceEntry): string {
  const bits = [
    `${entry.pane ?? "·"} ${entry.screen ?? "home"}`,
    entry.focusedTrackId ?? "no track",
  ];
  if (entry.param) bits.push(entry.param);
  if (entry.recording) bits.push(`● ${entry.recording}`);
  if (entry.pinned) bits.push("pinned");
  if (entry.follow) bits.push(`follows ${entry.follow}`);
  if (entry.clientId === port.clientId) bits.push("this pane");
  return bits.join(" · ");
}

/**
 * `pane` lists panes; `pane <screen> [track]…` prints the shell line that
 * opens one (dawg can't open terminal windows portably), with the tmux
 * split line inside tmux, and copies it via OSC 52. `pin`, `unpin`,
 * `follow [letter]`, `unfollow`. Undefined: not a pane command.
 */
function paneCommand(command: string): Receipt | undefined {
  const text = command.trim();
  if (/^\/?panes?$/i.test(text)) {
    if (port.mode !== "daemon")
      return ok("solo pane · no daemon · DAWG_DAEMON=0 is set");
    const entries = [...panePresence].sort((a, b) =>
      (a.pane ?? "~").localeCompare(b.pane ?? "~"),
    );
    if (entries.length === 0) return ok("1 pane · this one");
    return ok(`${entries.length} panes │ ${entries.map(paneLine).join(" │ ")}`);
  }
  const open = text.match(/^\/?pane\s+(.+)$/i);
  if (open) {
    const parsed = parsePaneArgs(open[1]!.split(/\s+/));
    if (!parsed.ok) return fail(parsed.problem);
    const line = `dawg pane ${open[1]!.trim().toLowerCase()}`;
    copyToClipboard(line);
    return ok(
      process.env.TMUX
        ? `run · tmux split-window ${line} · copied`
        : `run in another terminal · ${line} · copied`,
    );
  }
  if (/^\/?pin$/i.test(text)) {
    paneOptions.pinned = true;
    paneOptions.follow = undefined;
    return ok(`pinned to ${requestedTrack} · unpin releases`);
  }
  if (/^\/?unpin$/i.test(text)) {
    if (!paneOptions.pinned) return warn("not pinned");
    paneOptions.pinned = false;
    return ok("unpinned");
  }
  const follow = text.match(/^\/?follow(?:\s+([a-z]))?$/i);
  if (follow) {
    if (port.mode !== "daemon") return warn("follow needs dawgd · solo pane");
    paneOptions.pinned = false;
    paneOptions.follow = follow[1]?.toUpperCase() ?? "*";
    followPresence([], panePresence);
    return ok(
      paneOptions.follow === "*"
        ? "following the latest pane's track"
        : `following pane ${paneOptions.follow}`,
    );
  }
  if (/^\/?unfollow$/i.test(text)) {
    if (!paneOptions.follow) return warn("not following");
    paneOptions.follow = undefined;
    return ok("unfollowed");
  }
  return undefined;
}

/** OSC 52: the terminal copies `text` where it supports it; else a no-op. */
function copyToClipboard(text: string): void {
  if (!stdout.isTTY) return;
  stdout.write(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`);
}

/**
 * A following pane takes the track its target focuses: one letter, or for
 * `*` the other pane whose focus changed most recently. Pinned panes never
 * move on someone else's focus.
 */
function followPresence(
  before: readonly PresenceEntry[],
  after: readonly PresenceEntry[],
): void {
  const target = paneOptions.follow;
  if (!target || paneOptions.pinned) return;
  const others = after.filter((entry) => entry.clientId !== port.clientId);
  let next: string | null | undefined;
  if (target !== "*")
    next = others.find((entry) => entry.pane === target)?.focusedTrackId;
  else {
    const moved = others.filter(
      (entry) =>
        before.find((old) => old.clientId === entry.clientId)
          ?.focusedTrackId !== entry.focusedTrackId,
    );
    next = (moved.at(-1) ?? (before.length === 0 ? others.at(-1) : undefined))
      ?.focusedTrackId;
  }
  if (!next || next === requestedTrack) return;
  void focusTrack(next, { follow: true }).then((result) => {
    if (result.ok) {
      receipt(
        ok(
          `follows ${target === "*" ? "latest pane" : `pane ${target}`} · ${next}`,
        ),
      );
      tickUi();
    }
  });
}

/** The engine this window hears itself through (its own in daemon mode). */
function previewEngine(): AudioEngine {
  if (audio instanceof AudioEngine) return audio;
  monitorEngine ??= new AudioEngine({
    projectRoot: process.cwd(),
    onStatus: (status) => {
      if (status.state === "device")
        tui.activity.pushCard(`audio · ${status.message}`, { tone: "warning" });
    },
  });
  return monitorEngine;
}

/** This machine's player, without starting an engine just to ask. */
function audioInfo(): AudioBackendInfo {
  if (audio instanceof AudioEngine) return audio.info;
  if (monitorEngine) return monitorEngine.info;
  audioInfoCache ??= detectAudioBackend();
  return audioInfoCache;
}

/** Project › audio's rows; device lists are re-read at most every 3 s. */
function audioMenu(): MenuAudioDevices {
  const now = performance.now();
  if (!audioMenuCache || now - audioMenuCache.at > 3000)
    audioMenuCache = { at: now, state: audioMenuState(audioInfo()) };
  return audioMenuCache.state;
}

/** The play session for the focused track (re-made when focus moves). */
function menuContext(): MenuContext {
  const session = play;
  const loop = auditionController();
  loop.focus(requestedTrack);
  return {
    score: loop.staging ? loop.score : score,
    audition: {
      looping: loop.looping,
      dirty: loop.dirtyEdits,
      committed: score,
      hint: loop.hint(),
      status: loop.status(),
      stageable: stageableNow,
      committedChords: chordSettings,
    },
    trackId: requestedTrack,
    sessionName: record.meta.name,
    playing: clock.playing,
    grid: session?.grid ?? DEFAULT_GRID,
    grids: GRIDS.map((grid) => grid.label),
    clickOn: session?.clickOn ?? false,
    countInBars: session?.countInBars ?? 1,
    showMe: showMe.level,
    agentShell: agentShellOn,
    audio: audioMenu(),
    chords: stagedChordSettings() ?? session?.chords.settings ?? chordSettings,
    projectRoot: process.cwd(),
  };
}

/** The screen `?` describes, or undefined while `?` is typed text. */
function keysScreen(): readonly KeySection[] | undefined {
  if (euclid.open) return euclid.typing ? undefined : KEYS.euclid;
  if (fader && menu.open)
    return fader.typing !== undefined ? undefined : KEYS.fader;
  if (menu.open) return menu.typing ? undefined : KEYS.menu;
  const overlay = tui.ui.overlay;
  if (overlay === "picker")
    return tui.pickerTyping
      ? undefined
      : tui.ui.picker?.id === "preset" || tui.ui.picker?.id === "presets"
        ? KEYS.presets
        : AUDITION_PICKERS.has(tui.ui.picker?.id ?? "")
          ? KEYS.audition
          : KEYS.list;
  if (overlay === "text") return KEYS.text;
  if (overlay === "log") return KEYS.log;
  if (overlay === "guide") return tui.guideTyping ? undefined : KEYS.guide;
  if (prompt.value.length > 0) return undefined;
  if (play?.on)
    return play.chords.on ? [...KEYS.play, ...KEYS.chords] : KEYS.play;
  if (patchView.on) return KEYS.patch;
  if (tape.on) return KEYS.tape;
  return KEYS.prompt;
}

function showKeys(): void {
  const sections = keysScreen();
  if (!sections) return;
  const lines = keyLines(sections);
  // Play mode's secondary state lives here instead of the header.
  if (play?.on && !tui.ui.overlay && !menu.open)
    lines.unshift(...play.details(), "");
  tui.showKeys("keys", lines);
}

function openMenu(section?: string): void {
  menu.show(menuContext(), section);
  refreshMenu();
}

function euclidContext(): EuclidContext {
  const loop = auditionController();
  loop.focus(requestedTrack);
  return {
    score: loop.staging ? loop.score : score,
    trackId: requestedTrack,
    audition: {
      looping: loop.looping,
      dirty: loop.dirtyEdits,
      committed: score,
      hint: loop.hint(),
      status: loop.status(),
    },
  };
}

function openEuclid(voice?: string, origin?: string): void {
  euclid.show(euclidContext(), voice, origin);
  refreshEuclid();
}

function refreshEuclid(): void {
  if (!euclid.open) return;
  if (tui.ui.overlay !== undefined && tui.ui.picker?.id !== "euclid") {
    euclid.close();
    return;
  }
  const view = euclid.view(euclidContext());
  tui.openPicker({
    id: "euclid",
    title: view.title,
    items: view.items,
    index: view.index,
    hint: view.hint,
  });
}

/**
 * Play one bar of `voice` on the focused track over silence. While the loop
 * is playing the edit is already audible, so nothing extra sounds.
 */
function audition(voice: string): void {
  if (clock.playing) return;
  const track = score.tracks.find(
    (candidate) => candidate.id === requestedTrack,
  );
  if (!track) return;
  const pitch = rhythmVoicePitch(track, voice);
  if (pitch === undefined) return;
  const engine = liveEngine();
  if (!engine?.canMonitor) return;
  const pcm = renderAudition({
    score,
    trackId: track.id,
    pitches: new Set([pitch]),
    bars: 1,
    sampleRate: engine.sampleRate,
    ...(liveSampleBank ? { samples: liveSampleBank } : {}),
  });
  if (!pcm) return;
  void engine
    .monitor(true)
    .then(() => engine.noteOn(AUDITION_VOICE, pcm))
    .catch(() => undefined);
}

/**
 * The window's audition controller. Its loop plays through the ordinary
 * engine (the render worker and stem cache), so a preview sounds exactly
 * like the same bars of the song; staged commands run through `submit`
 * with `commitScore` captured, so a staged edit is made by the same code
 * as a committed one.
 */
function auditionController(): Audition {
  auditionLoop ??= new Audition(
    {
      apply: applyStaged,
      play: (preview) => previewEngine().play(preview),
      stop() {
        const engine = previewEngine();
        engine.stop();
        if (!play?.on) engine.setLeadMs(undefined);
      },
      leadMs: () => previewEngine().leadMs,
      now: () => performance.now(),
      beat: () => clock.beatAt(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as Timer),
      changed: () => requestFrame(),
      level: () => previewEngine().level,
      // The last loop the engine played is the song's when a loop starts.
      masterGainDb: () =>
        score.master?.target === undefined
          ? undefined
          : previewEngine().loudness?.gainDb,
      // The chord settings screen loops a progression with its settings.
      phrase: (showing) => {
        if (!chordScreenOpen()) return undefined;
        const settings =
          showing === "A"
            ? chordSettings
            : (stagedChordSettings() ?? chordSettings);
        return (base, track, bars) => chordPhrase(settings, base, track, bars);
      },
    },
    score,
    requestedTrack,
  );
  return auditionLoop;
}

/** True while the menu's Chords section (`/menu chords`) is open. */
function chordScreenOpen(): boolean {
  return menu.open && menu.section === "chords";
}

/** What stages while auditioning on the screen open now. */
function stageableNow(command: string): boolean {
  return (
    isStageable(command) || (chordScreenOpen() && isChordStageable(command))
  );
}

/**
 * The chord settings with the staged `/chords …` commands applied, or
 * undefined while none are staged. Chord settings are window state (not in
 * the score), so the staged ones are derived from the staged commands.
 */
function stagedChordSettings(): ChordSettings | undefined {
  const commands = auditionLoop?.dirtyEdits ? auditionLoop.commands : [];
  const chords = commands.filter((command) => CHORDS_COMMAND.test(command));
  if (chords.length === 0) return undefined;
  const settings = { ...chordSettings };
  for (const command of chords)
    applyChordsCommand(
      settings,
      command.match(CHORDS_COMMAND)![1]!,
      score.tempoBpm,
    );
  return settings;
}

/** Re-render the loop when the chord screen opens or closes. */
function noteChordScreen(): void {
  const now = chordScreenOpen();
  if (now === chordScreenWas) return;
  chordScreenWas = now;
  auditionLoop?.request();
}

/**
 * Warm the pack cache for a staged command before it runs, so a lazy fetch
 * (a sample kit, a pack sound or table) happens outside the capture and the
 * window's score is swapped only for the instant the command takes.
 */
async function prefetchStaged(
  base: TrackScore,
  command: string,
): Promise<void> {
  try {
    const kit = parseKitCommand(command);
    if (kit?.kind === "set" && !isSynthKitName(kit.bank)) {
      const trackId = kitTarget(base, requestedTrack);
      if (trackId) await useKit(packs(), base, trackId, kit.bank);
      return;
    }
    const pack = parsePackCommand(command);
    if (pack?.kind === "use") {
      await useSound(packs(), base, requestedTrack, pack.sound, {
        ...(pack.voice ? { voice: pack.voice } : {}),
      });
      return;
    }
    const wavetable = parseWavetableCommand(command);
    if (wavetable?.kind === "table")
      await pickWavetable(
        packs(),
        base,
        requestedTrack,
        wavetable.table,
        process.cwd(),
      );
  } catch {
    // The command itself reports the failure.
  }
}

/** Apply one prompt command to `base` without committing (see stageCapture). */
async function applyStaged(
  base: TrackScore,
  command: string,
): Promise<{ next?: TrackScore; ok: boolean; message: string }> {
  const chords = command.trim().match(CHORDS_COMMAND);
  if (chords) {
    // Window state: checked on a copy; kept settings apply on Enter.
    const result = applyChordsCommand(
      { ...chordSettings },
      chords[1]!,
      base.tempoBpm,
    );
    return { next: base, ok: result.ok, message: result.message };
  }
  await prefetchStaged(base, command);
  // Staged commands run one at a time, between queued prompts.
  while (stageCapture) await Bun.sleep(1);
  const committed = score;
  stageCapture = {};
  score = base;
  try {
    const result = await submit(command);
    const text = typeof result === "string" ? result : result.text;
    const good = toneOf(result) !== "error";
    return { next: stageCapture.next, ok: good, message: text };
  } catch (error) {
    return { ok: false, message: describeError(command, error) };
  } finally {
    score = stageCapture?.committed ?? committed;
    stageCapture = undefined;
  }
}

/** Keep the controller on the committed score (remote edits, undo, agent). */
function followCommitted(): void {
  const loop = auditionLoop;
  if (!loop || stageCapture || loop.committed === score) return;
  if (!loop.dirtyEdits) {
    loop.committedNow(score);
    return;
  }
  void loop.rebase(score).then(({ dropped }) => {
    tui.activity.pushCard(
      dropped.length
        ? `score changed · dropped staged ${dropped.join(", ")}`
        : "score changed · staged edits re-applied on top",
      { tone: "warning" },
    );
    requestFrame();
  });
}

async function startAuditionLoop(): Promise<void> {
  const loop = auditionController();
  await materializeDraft();
  loop.committedNow(score);
  loop.focus(requestedTrack);
  // One sound at a time: the song stops while the loop plays.
  if (clock.playing) await setTransport("pause");
  previewEngine().setLeadMs(previewEngine().playLeadMs);
  loop.start();
}

function stopAuditionLoop(): void {
  auditionLoop?.stop();
}

/** A menu or picker audition key: Space, `a` (A/B) or `c` (context). */
function auditionKeyPressed(
  key: "loop" | "ab" | "context",
): Promise<void> | undefined {
  const loop = auditionController();
  if (key === "loop") {
    if (loop.looping) stopAuditionLoop();
    else return startAuditionLoop().finally(() => requestFrame());
  } else if (key === "ab") {
    if (!loop.dirtyEdits) {
      tui.activity.pushCard("A/B · nothing staged yet · ←→ to change a value", {
        tone: "info",
      });
      return;
    }
    loop.toggleAB();
  } else loop.toggleContext();
  return undefined;
}

/** An auditioning picker's title carries the loop status (`♪ solo · B`). */
function refreshAuditionPicker(): void {
  const picker = tui.ui.picker as
    (NonNullable<typeof tui.ui.picker> & { baseTitle?: string }) | undefined;
  if (tui.ui.overlay !== "picker" || !picker?.audition) return;
  // Kept on the picker so a filter's copy of it keeps the plain title too.
  const base = (picker.baseTitle ??= picker.title);
  const status = auditionLoop?.status();
  const dirty = auditionLoop?.dirtyEdits ? "● " : "";
  picker.title = status ? `${dirty}${base} · ${status}` : base;
}

/**
 * `/try <command>`: hear a sound command on the audition loop before it
 * lands. A small picker offers keep (one undo step) or revert; Space, `a`
 * and `c` work as in the menu.
 */
async function tryPrompt(command: string): Promise<Receipt> {
  if (!command) return fail(TRY_USAGE);
  const agentToggle = command.match(/^agent\s+(on|off)$/i);
  if (agentToggle) {
    agentPreviewPlays = agentToggle[1]!.toLowerCase() === "on";
    return ok(
      `try · agent previews ${agentPreviewPlays ? "play once here" : "stay silent (numbers only)"}`,
    );
  }
  if (!isStageable(command))
    return fail(`try · only sound changes can be tried · ${TRY_USAGE}`);
  if (menu.open || euclid.open)
    return fail("try · close the open screen first");
  const loop = auditionController();
  if (!loop.looping) await startAuditionLoop();
  const result = await loop.stage(command);
  if (!result.ok) {
    if (!loop.dirtyEdits) stopAuditionLoop();
    return fail(`try · ${result.message}`);
  }
  tui.openPicker({
    id: "try",
    title: `try · ${command.slice(0, 48)}`,
    hint: HINTS.audition,
    audition: true,
    items: [
      { label: "keep", value: "keep", detail: "commit it · one undo step" },
      { label: "revert", value: "revert", detail: "drop it" },
    ],
  });
  return ok(`trying · ${command} · a A/B · enter keep · esc revert`);
}

/** Audition a list's highlighted item in place of its previous hover. */
function hoverItem(command: string, key: string): void {
  const loop = auditionLoop;
  if (!loop?.looping) return;
  requestFrame();
  void loop.hover(command, key).then((result) => {
    if (!result.ok && result.message !== SUPERSEDED)
      tui.activity.pushCard(result.message, { tone: "warning" });
    requestFrame();
  });
}

/** Enter on a list item while auditioning: it stays staged for good. */
function chooseItem(command: string, key: string): void {
  const loop = auditionLoop;
  if (!loop) return;
  void loop
    .hover(command, key)
    .then((result) => {
      if (!result.ok && result.message !== SUPERSEDED)
        tui.activity.pushCard(result.message, { tone: "warning" });
      loop.settle(key);
    })
    .finally(() => requestFrame());
}

/** Space, `a` or `c` in a picker: starting the loop hovers the cursor row. */
function pickerAuditionKey(key: "loop" | "ab" | "context"): void {
  const started = auditionKeyPressed(key);
  if (!started) return;
  const picker = tui.ui.picker;
  const item = picker?.items[picker.index];
  if (!picker || !item || !isStageable(item.value)) return;
  void started.then(() => {
    const now = tui.ui.picker;
    const current = now?.id === picker.id ? now.items[now.index] : undefined;
    if (current && isStageable(current.value))
      hoverItem(current.value, `picker:${picker.id}`);
  });
}

/** Stage a menu command while auditioning; undefined when it should run. */
function stageIfAuditioning(command: string): boolean {
  const loop = auditionLoop;
  if (!loop?.staging || !stageableNow(command)) return false;
  void loop.stage(command).then((result) => {
    if (!result.ok)
      tui.activity.pushCard(result.message, {
        tone: result.message.includes("failed") ? "error" : "warning",
      });
    requestFrame();
  });
  return true;
}

/** Enter: every staged edit becomes ONE revision (one undo step). */
async function keepStaged(): Promise<Receipt> {
  const loop = auditionLoop;
  await loop?.settled();
  const taken = loop?.take();
  if (!loop || !taken) return warn("nothing staged");
  await materializeDraft();
  // Chord settings are window state: they apply here, outside the revision.
  const chordCommands = taken.commands.filter((command) =>
    CHORDS_COMMAND.test(command),
  );
  for (const command of chordCommands)
    applyChordsCommand(
      chordSettings,
      command.match(CHORDS_COMMAND)![1]!,
      score.tempoBpm,
    );
  const scoreCommands = taken.commands.filter(
    (command) => !CHORDS_COMMAND.test(command),
  );
  let next = taken.score;
  for (let attempt = 0; scoreCommands.length && next !== score; attempt += 1) {
    try {
      await commitScore(next, "preview.commit", {
        trackId: loop.trackId,
        commands: scoreCommands,
      });
      break;
    } catch (error) {
      if (!(error instanceof SessionConflictError) || attempt > 0) throw error;
      // Another window committed first: replay the staged commands on it.
      record = await port.load();
      score = scoreFromJSON(record.composition);
      next = score;
      for (const command of scoreCommands) {
        const result = await applyStaged(next, command);
        if (result.next) next = result.next;
      }
    }
  }
  loop.committedNow(score);
  await projectSync?.flushScore();
  const kept = `kept ${taken.commands.length} change${taken.commands.length === 1 ? "" : "s"}`;
  return ok(
    scoreCommands.length
      ? `${kept} · one undo step`
      : `${kept} · chord settings (window state, no revision)`,
  );
}

function revertStaged(): void {
  const loop = auditionLoop;
  if (!loop?.dirtyEdits) return;
  const count = loop.commands.length;
  loop.revert();
  tui.activity.pushCard(
    `reverted ${count} staged change${count === 1 ? "" : "s"}`,
    { tone: "info" },
  );
}

/** Leaving an auditioning screen stops the loop and drops staged edits. */
function leaveAuditionScreen(): void {
  if (auditionLoop?.dirtyEdits) revertStaged();
  stopAuditionLoop();
}

function refreshMenu(): void {
  noteChordScreen();
  if (!menu.open) {
    closeFader();
    return;
  }
  if (tui.ui.overlay !== undefined && tui.ui.picker?.id !== "menu") {
    // Another overlay (help, a picker) replaced the menu.
    menu.close();
    leaveAuditionScreen();
    return;
  }
  const context = menuContext();
  if (fader) {
    const fields = menu.faderFields(context);
    if (fields.length === 0) closeFader();
    else {
      const focusedField = fields[focusIndex(fader, fields)];
      const drawer = drawerView(fader, fields, menu.faderCommitted(context), {
        title: crumbText({ steps: menu.steps }),
        crumbs: { steps: menu.steps },
        dirty: context.audition?.dirty ?? false,
        status: context.audition?.status,
        atOnce:
          focusedField !== undefined &&
          !stageableNow(faderCommand(focusedField)),
        knobs: menu.knobPage,
      });
      tui.drawer = withPaneMarks(
        menu.knobPage === "knobs"
          ? { ...drawer, aside: drawerAside(menu.pageFields(context), fields) }
          : drawer,
      );
    }
  }
  const view = menu.view(context);
  tui.openPicker({
    id: "menu",
    title: view.title,
    crumbs: view.crumbs,
    items: view.items.length
      ? view.items
      : [{ label: "no matches", value: "none" }],
    index: view.index,
    hint: view.hint,
    note: view.note,
  });
}

// ── the fader drawer ─────────────────────────────────────────────────

/** Enter on a number row (or a bare `volume`, `fx filter`): the drawer. */
/**
 * `export song.wav [stems]`: render the song as `dawg render song.wav` would
 * (the offline renderer, deterministic), then with `stems` one WAV per
 * audible track beside it (`song-bass.wav`), each that track soloed.
 */
async function exportWav(path: string, stems: boolean): Promise<Receipt> {
  const directory = await mkdtemp(join(tmpdir(), "dawg-export-"));
  const errors: string[] = [];
  const sink = { write: (text: string) => errors.push(text.trim()) };
  const quiet = { write: () => undefined };
  const render = async (song: TrackScore, target: string): Promise<boolean> => {
    const file = join(directory, "song.track.json");
    await writeFile(file, encodeLoop(song), "utf8");
    const code = await runRenderCommand(
      ["render", target, "--import", file],
      process.cwd(),
      quiet,
      sink,
    );
    return code === 0;
  };
  tui.activity.setSpinner(`export ${path}`);
  try {
    if (!(await render(score, path)))
      return fail(errors.at(-1) ?? `export failed · ${path}`);
    if (!stems) return ok(`exported · ${path}`);
    const written: string[] = [];
    const base = path.replace(/\.wav$/i, "");
    for (const track of score.tracks) {
      if (!isTrackAudible(score, track.id)) continue;
      let solo = score;
      for (const other of score.tracks)
        solo = applyScoreOperation(solo, {
          type: "updateTrack",
          trackId: other.id,
          patch: { solo: other.id === track.id },
        });
      const target = `${base}-${track.id}.wav`;
      if (!(await render(solo, target)))
        return fail(errors.at(-1) ?? `export failed · ${target}`);
      written.push(target);
    }
    return ok(stemsReceipt(path, written));
  } finally {
    tui.activity.setSpinner(undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

/** `mix`: Mix › mixer in the drawer, on the focused track's level. */
function openMixer(context: MenuContext): string | undefined {
  if (context.score.tracks.length === 0) return undefined;
  menu.show(context, "mix");
  if (!menu.enter(context, "mixer")) {
    menu.close();
    return undefined;
  }
  const first = menu.openKnobs(context);
  const fields = menu.faderFields(context);
  const here = fields.find((field) => field.label.includes("›"));
  if (!first || fields.length === 0) {
    menu.close();
    return undefined;
  }
  return here?.label ?? first;
}

/** `knobs <page>`: open that page's level and its four knobs. */
function openKnobPage(
  context: MenuContext,
  word: string | undefined,
  track: TrackScore["tracks"][number] | undefined,
): string | undefined {
  const page = knobPageId(word, track);
  if (!page) return undefined;
  if (page.startsWith("fx:")) {
    if (!menu.showFader(context, `fx ${page.slice(3)}`)) return undefined;
  } else {
    const section = page.startsWith("sound:")
      ? "sound"
      : page === "tempo"
        ? "project"
        : page;
    menu.show(context, section);
  }
  const label = menu.openKnobs(context);
  if (!label || menu.knobPageId !== page) {
    menu.close();
    return undefined;
  }
  return label;
}

/** `tempo`, `bars`, `meter`: open Project and name its fader, if it has one. */
function songFader(context: MenuContext, command: string): string | undefined {
  // Bare song scalars and the Project fader each opens.
  const faders: Readonly<Record<string, string>> = {
    tempo: "tempo",
    bpm: "tempo",
    bars: "loop length",
    meter: "beats per bar",
  };
  const label = faders[command.replace(/^\//, "").toLowerCase()];
  if (!label) return undefined;
  menu.show(context, "project");
  if (menu.faderFields(context).some((field) => field.label === label))
    return label;
  menu.close();
  return undefined;
}

/**
 * Open the drawer on `label`. `standalone` drawers came from a command or a
 * click, not from inside the menu, so closing one closes the menu too.
 */
function openFader(label: string, standalone = false): void {
  fader = { label };
  faderStandalone = standalone;
  const loop = auditionController();
  if (!loop.dirtyEdits) loop.committedNow(score);
}

function closeFader(): void {
  fader = undefined;
  tui.drawer = undefined;
  if (faderStandalone && menu.open) {
    faderStandalone = false;
    menu.close();
    tui.closePicker();
    stopAuditionLoop();
  }
  faderStandalone = false;
}

function faderKeyOptions(): { dirty: boolean; audition: boolean } {
  return { dirty: auditionLoop?.dirtyEdits ?? false, audition: true };
}

/**
 * Act on a drawer result. A set stages on the audition loop, filed under
 * its field so every nudge replaces the last: the piano roll (and the loop,
 * when it plays) follows at once, and Enter keeps them all as one revision.
 * A setting the loop cannot stage (tempo, loop length) applies directly.
 */
function faderOutcome(result: FaderResult): void {
  if (result.type === "set") {
    if (!stageableNow(result.command)) {
      runPromptLater(result.command);
      return;
    }
    const loop = auditionController();
    if (!loop.dirtyEdits) loop.committedNow(score);
    const seq = (faderSeq.get(result.key) ?? 0) + 1;
    faderSeq.set(result.key, seq);
    void loop
      .stage(result.command, {
        replaceKey: result.key,
        superseded: () => faderSeq.get(result.key) !== seq,
      })
      .then((outcome) => {
        if (!outcome.ok && outcome.message !== SUPERSEDED)
          tui.activity.pushCard(outcome.message, {
            tone: outcome.message.includes("failed") ? "error" : "warning",
          });
        requestFrame();
      });
  } else if (result.type === "keep") {
    closeFader();
    void keepStaged()
      .then((outcome) => receipt(outcome))
      .catch((error) => tui.activity.pushError(describeError("keep", error)))
      .finally(() => requestFrame());
  } else if (result.type === "revert") {
    revertStaged();
    closeFader();
  } else if (result.type === "close") closeFader();
  else if (result.type === "audition") auditionKeyPressed(result.key);
}

// ── the mouse ────────────────────────────────────────────────────────

/**
 * One mouse report, hit-tested against the regions the last frame painted.
 * Acts directly (a fader, the transport) or returns keys to run through the
 * ordinary key path (a list row is Enter, a wheel notch is an arrow).
 */
function mouseInput(event: MouseEvent): string[] {
  const frame = tui.frame;
  if (!frame) return [];
  const target = frame.hits.at(event.x, event.y)?.target;
  if (tape.on && !play?.on && !tui.ui.overlay && !menu.open) {
    const handled = tapeMouse(event, target);
    if (handled) return handled;
  }
  if (event.kind === "wheel") {
    const fields = fader && menu.open ? menu.faderFields(menuContext()) : [];
    if (
      fader &&
      target &&
      (target.kind === "fader-bar" ||
        target.kind === "fader-row" ||
        target.kind === "fader-step" ||
        target.kind === "fader-option")
    ) {
      // Wheel up raises the value under the pointer.
      faderOutcome(
        faderStep(
          fader,
          fields[target.field],
          event.delta < 0 ? 1 : -1,
          event.shift ? "coarse" : "normal",
        ),
      );
      refreshMenu();
      return [];
    }
    if (fader) return [];
    if (tui.ui.overlay) return [event.delta < 0 ? ARROW_UP : ARROW_DOWN];
    return [];
  }
  // A drag keeps moving the fader it started on, even past the bar's ends.
  if (event.kind === "drag" && event.button === "left" && fader && dragging) {
    const fields = menu.faderFields(menuContext());
    faderOutcome(
      faderSetPosition(
        fader,
        fields[dragging.field],
        (event.x - dragging.left) / Math.max(1, dragging.width - 1),
      ),
    );
    refreshMenu();
    return [];
  }
  if (event.kind === "up") {
    dragging = undefined;
    return [];
  }
  if (event.kind !== "down" || event.button !== "left" || !target) return [];
  if (fader && menu.open) {
    const fields = menu.faderFields(menuContext());
    let result: FaderResult | undefined;
    switch (target.kind) {
      case "fader-step":
        result = faderStep(
          fader,
          fields[target.field],
          target.direction,
          event.shift ? "coarse" : "normal",
        );
        break;
      case "fader-bar":
        dragging = target;
        result = faderSetPosition(
          fader,
          fields[target.field],
          (event.x - target.left) / Math.max(1, target.width - 1),
        );
        break;
      case "fader-option":
        result = faderChoose(fader, fields[target.field], target.option);
        break;
      case "fader-row": {
        const field = fields[target.field];
        if (field) {
          fader.label = field.label;
          fader.typing = undefined;
        }
        result = { type: "handled" };
        break;
      }
      case "fader-keep":
        result = auditionLoop?.dirtyEdits
          ? { type: "keep" }
          : { type: "close" };
        break;
      case "fader-revert":
        result = auditionLoop?.dirtyEdits
          ? { type: "revert" }
          : { type: "close" };
        break;
      default:
        break;
    }
    if (result) {
      faderOutcome(result);
      refreshMenu();
      return [];
    }
  }
  switch (target.kind) {
    case "picker-row": {
      const picker = tui.ui.picker;
      if (!picker) return [];
      if (picker.id === "menu" && menu.open) {
        // The first click selects a row; a click on the selected row opens it.
        const again = menu.index === target.index;
        menu.select(menuContext(), target.index);
        refreshMenu();
        return again ? ["\r"] : [];
      }
      const again = picker.index === target.index;
      picker.index = target.index;
      picker.filtering = false;
      return again ? ["\r"] : [];
    }
    case "transport":
      if (tui.ui.overlay) return [];
      void toggleTransport()
        .catch((error: unknown) => transportFailed(error))
        .finally(() => requestFrame());
      return [];
    case "tracks":
      if (tui.ui.overlay) return [];
      runPromptLater("/tracks");
      return [];
    case "model":
      if (tui.ui.overlay) return [];
      runPromptLater("/model");
      return [];
    default:
      return [];
  }
}

function playSession(): PlaySession {
  if (play && play.track === requestedTrack) return play;
  const previous = play;
  play = new PlaySession(playHost(), {
    clickOn: previous?.clickOn,
    clickVolume: previous?.clickVolume,
    chords: chordSettings,
  });
  if (previous) {
    play.countInBars = previous.countInBars;
    play.grid = previous.grid;
  }
  return play;
}

async function enterPlay(): Promise<Receipt> {
  if (play?.on) return ok(`play mode · ${play.track} · esc leaves`);
  await materializeDraft();
  const session = playSession();
  await session.enter();
  if (hasSamplerTracks(score)) void sampleProblems(score);
  return ok(
    `play mode · ${session.track} · ${session.layout.drums ? "kit" : session.keyboard.range} · ? keys · esc leaves`,
  );
}

/**
 * `keys record [replace|off]` (op1-ux §4.7, r / R on TAPE): opens PLAY on
 * the focused track and arms recording. With a loop set, every pass over
 * it commits once, so one undo step; esc goes back to TAPE.
 */
async function keysRecord(
  mode: "overdub" | "replace" | "off",
): Promise<Receipt> {
  if (mode === "off" && !play?.on) return ok("record off");
  if (!play?.on) {
    const entered = await enterPlay();
    if (!play?.on) return entered;
  }
  const result = playSession().recordCommand(mode);
  reportView();
  return result.ok ? ok(result.message) : fail(result.message);
}

async function exitPlay(): Promise<Receipt> {
  if (!play?.on) return ok("play mode is off");
  await play.exit();
  return ok("play off");
}

// ── TAPE (op1-ux §6) ─────────────────────────────────────────────────

/** This pane's clipboard file in `.dawg` (§6.3); undefined in a demo. */
function paneClipboardPath(): string | undefined {
  if (demo || !record.sessionId) return undefined;
  return clipboardPath(process.cwd(), record.sessionId, port.pane);
}

/** The paste's target beat until its `jump` lands (or a moment passes). */
function pendingTapeBeat(value: TrackScore): number | undefined {
  const pending = tape.pending;
  if (!pending) return undefined;
  const here = scoreBeatAt(value, clock.beatAt());
  if (Date.now() > pending.until || clock.playing || here >= pending.beat) {
    tape.pending = undefined;
    return undefined;
  }
  return pending.beat;
}

/** What TAPE's reducer and view read: the score, focus, playhead, clipboard. */
function tapeContext(
  value: TrackScore = score,
  beat = clock.beatAt(),
): TapeContext {
  const board = rangeClipboard;
  return {
    score: value,
    trackId: requestedTrack,
    beat: pendingTapeBeat(value) ?? scoreBeatAt(value, beat),
    clipboard: board ? { source: board.source, range: board.range } : undefined,
    cut: cutArmed(tape.cut?.after, value),
  };
}

function currentTapeView(value: TrackScore, beat: number): TapeView {
  const view = tapeView({
    ...tapeContext(value, beat),
    // A pending paste's jump has not landed: its bar's first pass shows.
    transportBeat: pendingTapeBeat(value) === undefined ? beat : undefined,
    zoom: tape.zoom,
    selected: tape.knobs.selected,
    marks: paneMarks,
  });
  // §9.1 and §9.3: reels turn on the transport beat; the loop brackets
  // flash as each pass closes. Both are still with `/motion off`.
  const reducedMotion = tui.ui.reducedMotion;
  const withDelight: TapeView = {
    ...view,
    reel: reelGlyph({
      playing: clock.playing,
      beat,
      reducedMotion,
      unicode: tui.capabilities.unicode,
    }),
    loopFlash: loopFlash({
      playing: clock.playing,
      beat,
      loopBeats: loopedSection(value)
        ? loopTicksOf(value) / value.ticksPerBeat
        : undefined,
      bpm: bpmAtTick(value, scoreBeatAt(value, beat) * value.ticksPerBeat),
      reducedMotion,
    }),
  };
  tape.view = withDelight;
  return withDelight;
}

/** Whether the clipboard's source bars differ from what the score holds now. */
function clipboardStale(): boolean {
  const board = rangeClipboard;
  if (!board) return false;
  try {
    const ids = board.clip.all ? undefined : [board.source];
    const now = extractRange(score, ids, board.range);
    return JSON.stringify(now) !== JSON.stringify(board.clip);
  } catch {
    return true;
  }
}

/** Typed commands from a TAPE gesture: each echoes and runs as if typed. */
function runTyped(commands: readonly string[]): void {
  echoGesture(commands);
  runPromptsLater(commands);
}

/**
 * The prompt row echoes a gesture's typed command dimly for one beat
 * (op1-ux §10.1: type what you see), at least long enough to read.
 */
function echoGesture(commands: readonly string[]): void {
  if (commands.length === 0) return;
  gestureEcho.text = commands.join(" · ");
  if (gestureEcho.clear) clearTimeout(gestureEcho.clear);
  const beatMs = 60_000 / Math.max(1, score.tempoBpm);
  gestureEcho.clear = setTimeout(
    () => {
      gestureEcho.text = undefined;
      gestureEcho.clear = undefined;
      requestFrame();
    },
    Math.max(800, beatMs),
  );
  gestureEcho.clear.unref?.();
  requestFrame();
}

async function enterTape(): Promise<Receipt> {
  if (play?.on) await play.exit();
  if (tape.on) return ok("tape · esc goes home");
  exitPatch();
  closeFader();
  if (menu.open) menu.close();
  tape.on = true;
  tape.knobs.selected = 0;
  if (!rangeClipboard) {
    rangeClipboard = await loadClipboard(paneClipboardPath());
  }
  return ok(
    `tape · ${score.tracks.length} track${score.tracks.length === 1 ? "" : "s"} · ${score.bars} bars · ? keys · esc home`,
  );
}

/** `/patch [--fx <name>]`: the patch view on the focused track. */
async function enterPatch(fx?: string): Promise<Receipt> {
  const model = patchModel(score, requestedTrack, fx);
  if (typeof model === "string") return fail(model);
  if (play?.on) await play.exit();
  closeFader();
  if (menu.open) menu.close();
  if (tape.on) exitTape();
  if (!patchView.on || patchView.state.fx !== fx) {
    patchView.state = patchViewState(fx);
    patchView.cables = undefined;
  }
  patchView.on = true;
  const patch = model.patch;
  const what = model.preview
    ? "a preview · patch convert makes it a patch"
    : model.ref !== undefined
      ? `library ${model.ref} · patch detach edits it`
      : `${patch.nodes.length} nodes · ${patch.cables.length} cables`;
  return ok(
    `patch ${model.track.id} ▸ ${patch.name} · ${what} · ? keys · esc home`,
  );
}

function exitPatch(): Receipt {
  if (!patchView.on) return ok("the patch view is off");
  patchView.on = false;
  return ok("home");
}

/** The patch view's paint, or undefined when its track or patch went away. */
function currentPatchPaint(value: TrackScore): PatchPaint | undefined {
  const model = patchModel(value, requestedTrack, patchView.state.fx);
  if (typeof model === "string") return undefined;
  const cables = model.patch.cables;
  const key = `${model.track.id} ${model.fx ?? ""}`;
  const before = patchView.cables;
  patchView.cables = { key, list: cables };
  if (before?.key === key && before.list !== cables) {
    const added = newCables(before.list, cables).at(-1);
    if (added) focusCable(patchView.state, model, added);
  }
  clampState(patchView.state, model);
  return patchPaint(model, patchView.state);
}

/**
 * One key on the patch view. True when it consumed the key; false sends
 * it on (the prompt once a command is typed, overlays, ctrl keys).
 */
function patchInput(value: string): boolean {
  if (!patchView.on || play?.on) return false;
  if (tui.ui.overlay !== undefined || menu.open) return false;
  if (prompt.value.length > 0) return false;
  if (value === "/" || value === "\u0003") return false;
  const model = patchModel(score, requestedTrack, patchView.state.fx);
  if (typeof model === "string") {
    tui.activity.pushCard(model, { tone: "info" });
    receipt(exitPatch());
    return true;
  }
  clampState(patchView.state, model);
  const action = patchKey(patchView.state, model, value);
  switch (action.type) {
    case "run":
      runTyped(action.commands);
      return true;
    case "node": {
      const context = menuContext();
      const fx = patchView.state.fx;
      menu.show(context, fx === undefined ? "patch" : `patch:fx:${fx}`);
      if (
        !menu.enter(context, "patch:nodes") ||
        !menu.enter(context, nodeMenuId(action.nodeId))
      ) {
        menu.close();
        tui.activity.pushCard(`patch set ${action.nodeId} <param>=<value>`, {
          tone: "info",
        });
      }
      return true;
    }
    case "pick":
      tui.openPicker({
        id: action.id,
        title: action.title,
        // The add list hears each node on the loop (enter keeps, esc
        // reverts), as /try and the kit list do.
        hint: action.id === "patch-add" ? HINTS.audition : HINTS.list,
        audition: action.id === "patch-add",
        items: action.items.map((item) => ({
          label: item.label,
          value: item.value,
        })),
        filterable: true,
      });
      return true;
    case "prefill":
      prompt.handle({ type: "text", text: action.text });
      return true;
    case "note":
      tui.activity.pushCard(action.message, { tone: "info" });
      return true;
    case "audition":
      void auditionKeyPressed("loop");
      return true;
    case "keys":
      showKeys();
      return true;
    case "exit":
      receipt(exitPatch());
      return true;
    case "handled":
      return true;
    case "pass":
      break;
  }
  // Unmapped printable keys are swallowed (as on TAPE); control keys
  // (enter, ctrl-z, ctrl-k) keep their bindings.
  return value.length === 1 && value >= " " && value !== "\u007f";
}

function exitTape(): Receipt {
  if (!tape.on) return ok("tape is off");
  tape.on = false;
  tape.view = undefined;
  tape.drag = undefined;
  return ok("home");
}

/**
 * One key on TAPE. True when TAPE consumed it; false sends it on (the
 * prompt once a command is typed, overlays, ctrl keys).
 */
function tapeInput(value: string): boolean {
  if (!tape.on || play?.on) return false;
  if (tui.ui.overlay !== undefined || menu.open) return false;
  if (prompt.value.length > 0) return false;
  if (value === "/" || value === "\u0003") return false;
  // A key that types commands reduces from the score and playhead, which
  // queued commands have not changed yet: `[ [` pressed before the first
  // `loop` lands would both shrink the same loop. Such a key waits its turn
  // in the queue and reduces from what the lines before it left.
  if (promptQueueBusy() && tapeKeyTypes(value)) {
    runStepLater(() => {
      if (!tape.on || play?.on) return [];
      let typed: readonly string[] = [];
      applyTapeKey(value, (commands) => {
        echoGesture(commands);
        typed = commands;
      });
      return typed;
    });
    return true;
  }
  return applyTapeKey(value, runTyped);
}

/** Whether a TAPE key would type commands now (a dry run, no effects). */
function tapeKeyTypes(value: string): boolean {
  const base = tapeContext();
  const context = { ...base, stale: !base.cut && clipboardStale() };
  const action = tapeKey(context, value);
  if (action.type === "run" || action.type === "paste") return true;
  if (action.type === "focus") return true;
  if (action.type !== "pass") return false;
  const knob = knobKey({ ...tape.knobs }, tapeKnobs(context), value);
  return knob.type === "run" || knob.type === "open";
}

/** One TAPE key, its commands handed to `run`. */
function applyTapeKey(
  value: string,
  run: (commands: readonly string[]) => void,
): boolean {
  const base = tapeContext();
  // After a cut the source bars are empty on purpose: not stale.
  const context = { ...base, stale: !base.cut && clipboardStale() };
  const action = tapeKey(context, value);
  switch (action.type) {
    case "run":
      if (action.cut) tape.cutArmed = score;
      run(action.commands);
      return true;
    case "paste": {
      if (action.fold) tape.foldArmed = true;
      const commands = [action.command];
      // The playhead moves past the paste so `v v v` tiles.
      if (action.end < score.bars) {
        commands.push(`jump ${action.end + 1}`);
        tape.pending = {
          beat: beatOfBar(score, action.end),
          until: Date.now() + 2000,
        };
      }
      run(commands);
      return true;
    }
    case "note":
      tui.activity.pushCard(action.message, { tone: "info" });
      return true;
    case "zoom": {
      const index = TAPE_ZOOMS.indexOf(tape.zoom) + action.direction;
      tape.zoom =
        TAPE_ZOOMS[Math.max(0, Math.min(TAPE_ZOOMS.length - 1, index))]!;
      return true;
    }
    case "focus": {
      const command = focusCommand(score, action.row);
      if (command) run([command]);
      return true;
    }
    case "transport":
      void toggleTransport().catch((error: unknown) => transportFailed(error));
      return true;
    case "keys":
      showKeys();
      return true;
    case "exit":
      receipt(exitTape());
      return true;
    case "pass":
      break;
  }
  const knob = knobKey(tape.knobs, tapeKnobs(context), value);
  if (knob.type === "run") {
    run([knob.command]);
    return true;
  }
  if (knob.type === "open") {
    run([knobNoun(context, knob.knob)]);
    return true;
  }
  if (knob.type === "handled") return true;
  // Unmapped printable keys are swallowed (as in play mode); control keys
  // (enter, ctrl-z, ctrl-k) keep their bindings.
  return value.length === 1 && value >= " " && value !== "\u007f";
}

/**
 * The mouse on TAPE: a ruler click jumps there and a ruler drag sets the
 * loop, a row click focuses it, the clipboard chip pastes, and the wheel
 * turns the selected knob. Each runs its typed command. Undefined: not a
 * TAPE gesture, so the ordinary mouse path takes it.
 */
function tapeMouse(
  event: MouseEvent,
  target: HitTarget | undefined,
): string[] | undefined {
  if (event.kind === "wheel") {
    if (!target || (target.kind !== "tape-ruler" && target.kind !== "tape-row"))
      return undefined;
    // The wheel walks the playhead a bar at a time (never a tempo knob).
    const bar = playheadBar();
    const next = Math.max(
      0,
      Math.min(score.bars - 1, bar + (event.delta < 0 ? -1 : 1)),
    );
    if (next !== bar) runTyped([`jump ${next + 1}`]);
    return [];
  }
  const drag = tape.drag;
  if (drag && (event.kind === "drag" || event.kind === "up")) {
    const view = tape.view;
    const first = drag.first;
    const bar =
      view && first !== undefined
        ? tapeBarAt(event.x, drag.left, first)
        : undefined;
    if (bar !== undefined) drag.to = bar;
    if (event.kind === "up") {
      tape.drag = undefined;
      if (drag.to !== drag.from) {
        const start = Math.min(drag.from, drag.to);
        const end = Math.max(drag.from, drag.to);
        runTyped([`loop ${start + 1}-${end + 1}`]);
      }
    }
    return [];
  }
  if (event.kind !== "down" || event.button !== "left" || !target)
    return undefined;
  if (target.kind === "tape-ruler") {
    const bar = tapeBarAt(event.x, target.left, target.firstCell);
    if (bar === undefined) return [];
    tape.drag = {
      from: bar,
      to: bar,
      left: target.left,
      first: target.firstCell,
    };
    runTyped([`jump ${bar + 1}`]);
    return [];
  }
  if (target.kind === "tape-row") {
    // A drag along a row sets the loop over those bars, like the ruler.
    const bar = tapeBarAt(event.x, target.left, target.firstCell);
    if (bar !== undefined)
      tape.drag = {
        from: bar,
        to: bar,
        left: target.left,
        first: target.firstCell,
      };
    const command = focusCommand(score, target.row);
    if (command && score.tracks[target.row]?.id !== requestedTrack)
      runTyped([command]);
    return [];
  }
  if (target.kind === "tape-clipboard") {
    tapeInput("v");
    return [];
  }
  return undefined;
}

/** The bar under a TAPE column, from the last painted view. */
function tapeBarAt(
  x: number,
  left: number,
  firstCell: number,
): number | undefined {
  const view = tape.view;
  if (!view) return undefined;
  const cell = x - left + firstCell;
  if (cell < 0 || cell >= view.cellBars.length) return undefined;
  return view.cellBars[cell];
}

/**
 * One key in play mode. True when play mode consumed it; false sends it on
 * to the normal bindings (overlays, a command being typed, Ctrl-C, arrows).
 */
function playKey(value: string): boolean {
  const session = play;
  if (!session?.on) return false;
  if (tui.ui.overlay !== undefined) return false;
  // `/play off`, `/click 50%`: once a command is being typed, keys are text.
  if (prompt.value.length > 0) return false;
  if (value === "/") return false;
  if (value === "\u0003") return false;
  const result = session.press(value);
  if (result.type === "handled") return true;
  if (result.type === "command") {
    if (result.command === "exit")
      void exitPlay().then((outcome) => receipt(outcome));
    else if (result.command === "transport") {
      if (!session.startWithCountIn())
        void toggleTransport().catch((error: unknown) =>
          transportFailed(error),
        );
    } else if (result.command === "menu") return false;
    return true;
  }
  // Unmapped: printable keys are swallowed so a stray letter never lands in
  // the prompt; control keys (Enter, arrows, Ctrl-Z) keep their bindings.
  return value.length === 1 && value >= " " && value !== "\u007f";
}

function playHost() {
  return {
    score: () => score,
    trackId: () => requestedTrack,
    now: () => performance.now(),
    playing: () => clock.playing,
    beatAt: (ms: number) => clock.beatAt(ms),
    scoreBeat: (beat: number) => scoreBeatAt(score, beat),
    engine: playEngine,
    samples: () => liveSampleBank,
    // A take is a plain commitScore (it diffs into operations, so dawgd
    // rebases a pass over other panes' edits); a stale record reloads and
    // replays the take's operations on what landed meanwhile.
    async commit(
      next: TrackScore,
      kind: string,
      payload: Record<string, unknown>,
    ): Promise<void> {
      const operations = (payload.operations ?? []) as ScoreOperation[];
      let target = next;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await commitScore(target, kind, payload);
          return;
        } catch (error) {
          if (!(error instanceof SessionConflictError)) throw error;
          record = await port.load();
          score = scoreFromJSON(record.composition);
          target = operations.reduce(
            (value, operation) => applyScoreOperation(value, operation),
            score,
          );
        }
      }
      throw new Error("session busy");
    },
    recordingElsewhere: (trackId: string) => recordingPane(trackId),
    async startTransport(beat: number): Promise<void> {
      if (port.mode === "daemon") {
        await port.transport("play", { beat });
        return;
      }
      clock.sync(beat, false);
      await setTransport("play");
    },
    async stopTransport(): Promise<void> {
      await setTransport("pause");
    },
    ghost(pitch: number) {
      tui.delight.ghost(pitch, Date.now());
      requestFrame();
    },
    card(text: string, tone: "info" | "success" | "warning" | "error") {
      if (tone === "error") tui.activity.pushError(text);
      else
        tui.activity.pushCard(text, {
          tone,
          trackId: requestedTrack,
          resultRevision:
            tone === "success" ? shownRevision(record) : undefined,
        });
    },
    newNoteId: () => newId("n"),
    presetStep: presetStepFromPlay,
  };
}

async function commitScore(
  next: TrackScore,
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  if (next === score) return;
  // Rhythm rows regenerate after a loop resize and freeze when their lane
  // is hand-edited, so rows and notes never disagree.
  next = reconcileRhythm(score, next);
  const retimed = timingChanged(score, next);
  if (stageCapture) {
    // A staged edit: the audition plays it; nothing is written yet.
    stageCapture.next = next;
    score = next;
    if (retimed) clock.follow(score);
    return;
  }
  // Every edit travels as score operations (snapshot when the diff cannot
  // express it), so dawgd rebases it over other panes' concurrent edits per
  // (track, property) and the log replays as operations (design §12.6).
  const operations = diffOps(score, next);
  if (operations) {
    record = await port.appendOperations(
      record,
      { kind, payload },
      operations,
      next.toJSON(),
    );
    // A rebased edit lands on top of what other panes wrote meanwhile.
    score = deepEqual(record.composition, next.toJSON())
      ? next
      : scoreFromJSON(record.composition);
  } else {
    record = await port.append(record, { kind, payload }, next.toJSON());
    score = next;
  }
  if (retimed || score !== next) clock.follow(score);
  if (clock.playing) void audio.play(score);
  projectSync?.scoreChanged(score);
  reportSampleProblems(score);
  void updateCredits(score);
}

/** The ops from `previous` to `next`, or undefined when they do not diff. */
function diffOps(
  previous: TrackScore,
  next: TrackScore,
): readonly ScoreOperation[] | undefined {
  try {
    const operations = diffScores(previous, next);
    return operations.length > 0 && operations.length <= 256
      ? operations
      : undefined;
  } catch (error) {
    if (error instanceof DiffError) return undefined;
    throw error;
  }
}

/** True when the transport clock must follow `next` (tempo, meter, loop). */
function timingChanged(previous: TrackScore, next: TrackScore): boolean {
  return (
    previous.time !== next.time ||
    previous.tempoBpm !== next.tempoBpm ||
    previous.beatsPerBar !== next.beatsPerBar ||
    previous.bars !== next.bars
  );
}

/** The window's side of the project file sync (see src/project/sync.ts). */
function syncHost(): SyncHost {
  return {
    project: process.cwd(),
    // The files belong to one session at a time; another session's window
    // stays detached instead of reprinting over them.
    sessionId: () => record.sessionId,
    current: () => score,
    async commit(plan, summary) {
      const baseRevision = record.revision;
      record = await port.appendOperations(
        record,
        {
          kind: "files.apply",
          payload: { summary },
        },
        plan.operations,
        plan.next.toJSON(),
      );
      score = scoreFromJSON(record.composition);
      clock.follow(score);
      if (clock.playing) void audio.play(score);
      reportSampleProblems(score);
      void baseRevision;
      return score;
    },
    card(text, tone, hint) {
      if (tone === "error") tui.activity.pushError(text);
      else
        tui.activity.pushCard(text, {
          tone,
          hint,
          resultRevision:
            tone === "success" ? shownRevision(record) : undefined,
        });
    },
    types(state) {
      typesIndicator = state;
    },
  };
}

/**
 * Undo and redo (design §12.6). By default a pane steps its own edits: the
 * newest edit this client made, inverted and rebased over whatever other
 * panes did since. `undo all` / `redo all` step the shared history, whoever
 * made the edit, and the receipt names the other pane. A lone pane (or one
 * that has made no edit since it opened) falls back to the shared history,
 * so single-pane sessions behave exactly as before.
 */
async function stepHistory(
  direction: "undo" | "redo",
  scope: "pane" | "all" = "pane",
): Promise<Receipt> {
  const latest = await port.load();
  // A fork's undo continues into its parent's history past the fork point.
  const events = await undoEvents(
    openHistory(process.cwd()),
    process.cwd(),
    latest,
  );
  const before = scoreFromJSON(latest.composition);
  const kind = direction === "undo" ? UNDO_KIND : REDO_KIND;
  const key = direction === "undo" ? "undoneRevision" : "redoneRevision";
  const otherPanes = panePresence.filter(
    (entry) => entry.clientId !== port.clientId,
  );
  let next: TrackScore;
  let revision: number;
  let author = "";
  if (scope === "pane") {
    const step = paneHistoryStep(
      latest.composition,
      events,
      direction,
      port.clientId,
    );
    if (!step || (!step.ok && step.others.length === 0)) {
      if (otherPanes.length === 0) return stepHistory(direction, "all");
      if (!step)
        return warn(
          `nothing of this pane's to ${direction} · ${direction} all steps everyone's`,
        );
    }
    if (!step.ok) {
      if (step.reason === "session-wide")
        return warn(`that edit is session-wide · ${direction} all`);
      const who = step.others.map(paneName).join(", ");
      return warn(
        `${who} changed ${step.reason.replace(/ changed$/, "")} since · ${direction} all ${direction === "undo" ? "undoes" : "redoes"} theirs too`,
      );
    }
    next = step.next;
    revision = step.revision;
  } else {
    const target = historyTarget(latest.composition, events, direction);
    if (!target) return warn(`nothing to ${direction}`);
    next = scoreFromJSON(target.composition);
    revision = target.revision;
    const writer = events.find((event) => event.revision === revision)?.actor
      ?.clientId;
    if (writer && writer !== port.clientId && otherPanes.length > 0)
      author = ` (${paneName(writer)})`;
  }
  try {
    const event = {
      kind,
      payload: { [key]: revision, ...(scope === "pane" ? {} : { scope }) },
    };
    let operations: readonly ScoreOperation[] = [];
    try {
      operations = diffScores(before, next);
    } catch (error) {
      if (!(error instanceof DiffError)) throw error;
    }
    record = await port.appendOperations(
      latest,
      event,
      operations,
      next.toJSON(),
    );
    // Compare with what was undone, which another window may have written.
    score = scoreFromJSON(record.composition);
    if (clock.playing) void audio.play(score);
    return ok(
      historyReceipt(
        direction,
        before,
        score,
        shownRevision(record, revision),
      ) + author,
    );
  } catch (error) {
    if (error instanceof SessionConflictError)
      return warn(`session changed · retry ${direction}`);
    return fail(
      `${direction} failed · ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `pane B` for a client in presence, `another pane` once it has left. */
function paneName(clientId: string): string {
  const pane = panePresence.find((entry) => entry.clientId === clientId)?.pane;
  return pane ? `pane ${pane}` : "another pane";
}

/** Space, the menu and a header click all report a failed toggle the same way. */
function transportFailed(error: unknown): void {
  tui.activity.pushCard(
    `transport failed · ${error instanceof Error ? error.message : String(error)}`,
    { tone: "error" },
  );
}

/**
 * The revision dawg shows (header, receipts, undo): edits to the song.
 * Play and pause are logged so other windows follow them, but they are not
 * edits, so they never move the number: a revision shows as itself minus
 * the transport events at or before it.
 */
function shownRevision(
  value: typeof record,
  revision = value.revision,
): number {
  let transports = 0;
  for (const event of value.events)
    if (event.revision <= revision && event.kind === "transport")
      transports += 1;
  return revision - transports;
}

/**
 * The space-bar toggle: flip the transport, then record it for other
 * windows. The log entry keeps windows in step; the header's revision
 * (`shownRevision`) skips it, since play/pause is not an edit.
 */
async function toggleTransport(): Promise<void> {
  await setTransport("toggle");
  try {
    record = await port.append(
      record,
      {
        kind: "transport",
        payload: {
          action: "toggle",
          playing: clock.playing,
          beat: clock.beatAt(),
        },
      },
      score.toJSON(),
    );
  } catch (error) {
    if (error instanceof SessionConflictError)
      tui.activity.pushCard("transport changed in another window", {
        tone: "warning",
      });
    else throw error;
  }
}

async function setTransport(
  action: "play" | "pause" | "toggle",
): Promise<void> {
  // One sound at a time: starting the song stops an audition loop.
  if (action !== "pause" && auditionLoop?.looping) stopAuditionLoop();
  if (port.mode === "daemon") {
    // dawgd owns the only transport; its broadcast updates `clock`.
    await port.transport(action);
    return;
  }
  if (action === "play") {
    clock.play();
    await audio.play(score, clock.beatAt());
  } else if (action === "pause") {
    clock.pause();
    audio.stop();
  } else if (clock.playing) {
    clock.pause();
    audio.stop();
  } else {
    clock.play();
    await audio.play(score, clock.beatAt());
  }
}

/** Move the playhead to transport `beat`, playing or not (section jump). */
/** The bar under the playhead, 0-based on the score. */
function playheadBar(): number {
  const beat = scoreBeatAt(score, clock.beatAt());
  return barAt(score, Math.max(0, Math.round(beat * score.ticksPerBeat))).bar;
}

async function seekTransport(beat: number): Promise<void> {
  if (port.mode === "daemon") {
    await port.transport("seek", { beat });
    return;
  }
  const now = Date.now();
  clock.sync(beat, clock.playing, now, now);
  if (clock.playing) await audio.play(score, clock.beatAt());
}

/**
 * Run one streaming tool-calling turn. Each validated tool call commits its
 * own revision through `agentHost`, so cancelling keeps every accepted change
 * and never leaves a half-applied call.
 */
async function runAgent(text: string): Promise<string | Receipt> {
  if (agentTurn) return warn("agent busy · Esc cancels");
  const selection = await currentProvider();
  if (selection.kind === "offline")
    return fail(`${truncateForCard(text)} · ${NO_AGENT}`);
  const turn = { controller: new AbortController(), steering: [] as string[] };
  agentTurn = turn;
  // The turn ends on one musical receipt of what it changed.
  const before = score;
  reportAgentActivity(`${providerName} · thinking…`);
  // xcb admits a pending account on its first call, which takes longer.
  let admitting = selection.kind === "xcb" && selection.admissionPending;
  if (admitting) tui.activity.setSpinner("admitting account…");
  try {
    const result = await runProviderTurn({
      selection,
      prompt: text,
      host: agentHost(turn, selection),
      signal: turn.controller.signal,
      onEvent: (event) => {
        if (admitting && event.type === "step" && event.step <= 1) return;
        if (admitting) {
          admitting = false;
          provider = undefined; // Re-read capabilities: now admitted.
        }
        if (event.type === "usage") {
          // Subscriptions are included; API responses are priced once.
          if (isApiSelection(selection)) {
            const { type: _type, ...usage } = event;
            void priceForModel(selection.kind, selection.modelId, {
              configDir: configDir(),
              apiKey: selection.apiKey,
            })
              .catch(() => undefined)
              .then((price) => {
                meter.add(usage, price);
                tickUi();
              });
          }
          return;
        }
        if (event.type === "done")
          tui.activity.setTurnReceipt(musicalReceipt(before, score));
        agentEventSink(event);
      },
    });
    return describeAgentEvent(result) ?? "agent finished";
  } finally {
    if (agentTurn === turn) agentTurn = undefined;
  }
}

function authTone(line: string): "success" | "warning" | "info" {
  if (line.startsWith("✓")) return "success";
  if (/^(✗|\?)|not |no |could not|failed/i.test(line)) return "warning";
  return "info";
}

/**
 * The cached provider, re-resolved when `~/.config/dawg` config or
 * credentials change (two stats per call) and, while offline, at most every
 * 30 s so an account admitted elsewhere is picked up without a restart.
 */
function currentProvider(): Promise<ProviderSelection> {
  const fingerprint = providerFingerprint();
  const stale =
    fingerprint !== providerStamp.fingerprint ||
    (providerStamp.offline && Date.now() - providerStamp.at > 30_000);
  if (provider && stale) provider = undefined;
  if (!provider) {
    providerStamp = { fingerprint, at: Date.now(), offline: false };
    provider = selectProvider().catch((): ProviderSelection => ({
      kind: "offline",
      choice: "auto",
      reason: "provider unavailable; run `dawg model key`",
    }));
  }
  return provider.then((selection) => {
    providerSnapshot = selection;
    providerName = providerLabel(selection);
    if (
      selection.kind === "offline" &&
      selection.invalidSaved &&
      !invalidNoticeShown
    ) {
      invalidNoticeShown = true;
      tui.activity.pushCard(`agent key stopped working · ${selection.reason}`, {
        tone: "warning",
        hint: "/model key",
      });
    }
    providerStamp.offline = selection.kind === "offline";
    return selection;
  });
}

/** Media tools write under the workspace's `tracks/<slug>/downloads/`. */
function mediaServices(): MediaServices {
  return { runner: systemRunner, env: process.env };
}

/**
 * `master measure`: render the song as the loop that plays and measure
 * loudness, peaks and balance at the export rate. The render, master and
 * meter run in a worker (`measureScoreOffThread`), so the header, input and
 * playback keep going on a long loop.
 */
async function measureLine(value: TrackScore): Promise<string> {
  await sampleProblems(value);
  tui.activity.setSpinner("measuring");
  try {
    const measured = await measureScoreOffThread(value, {
      projectRoot: process.cwd(),
    });
    return `master measure · ${measurementLine(measured.mix, measured.master)} · ${measured.sampleRate / 1000} kHz`;
  } finally {
    tui.activity.setSpinner(undefined);
  }
}

/**
 * How the agent's preview_sound renders (with this window's decoded
 * samples, at the engine's rate) and plays: once, over silence, unless the
 * song or the audition loop is already sounding or `/try agent off`.
 */
function agentPreviewHost(): PreviewHost {
  return {
    render: async (value) => {
      await sampleProblems(value);
      return renderScorePcm(value, {
        sampleRate: previewEngine().sampleRate,
        ...(liveSampleBank ? { samples: liveSampleBank } : {}),
      });
    },
    // Off the UI thread, at the export rate (see measureLine).
    measure: async (value, options) => {
      await sampleProblems(value);
      return measureScoreOffThread(value, {
        projectRoot: process.cwd(),
        ...(options?.sampleRate === undefined
          ? {}
          : { sampleRate: options.sampleRate }),
      });
    },
    playFile: (path, from, to) => playFileForAgent(path, from, to),
    play: async (rendered) => {
      if (!agentPreviewPlays || clock.playing || auditionLoop?.looping)
        return false;
      const engine = liveEngine();
      if (!engine?.canMonitor || rendered.frames === 0) return false;
      try {
        await engine.monitor(true);
        engine.noteOn(AGENT_PREVIEW_VOICE, {
          pcm: rendered.pcm,
          frames: rendered.frames,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ── show-me ──────────────────────────────────────────────────────────

/**
 * Show-me (docs/show-me.md): with an API provider the agent writes prompt
 * commands, streamed. The line being written is ghost text in the empty
 * prompt bar at the model's own speed; each complete line runs through
 * `submit()`, the path a typed Enter takes, at once. A parameter value
 * glides there over ~150 ms while the loop plays (you hear it), notes and
 * hits sound as they arrive (in time when the stream is ahead of the tempo,
 * as step entry when it is behind), and the caption names the key or fader
 * a person would use. Nothing waits for the turn to end.
 */

function showMeTyping(text: string): void {
  showMe.ghost = text || undefined;
  if (text && showMe.level === "on") showMe.caption = undefined;
  requestFrame();
}

function showMeCaption(text: string | undefined): void {
  if (showMe.level !== "on") return;
  showMe.caption = text;
  if (showMe.clear) clearTimeout(showMe.clear);
  showMe.clear = undefined;
  requestFrame();
}

/** End of a turn: the ghost goes, the caption becomes the do-it-yourself hint. */
function showMeFinish(): void {
  showMe.ghost = undefined;
  showMe.notes.reset();
  const hint = finishHint(showMe.commands);
  showMe.commands = [];
  if (hint && showMe.level === "on") {
    showMeCaption(hint);
    showMe.clear = setTimeout(() => {
      showMe.caption = undefined;
      showMe.clear = undefined;
      requestFrame();
    }, 8_000);
  } else {
    showMe.caption = undefined;
    requestFrame();
  }
}

/**
 * Slide a fader to its new value the way the drawer does: each eased step is
 * the field's own command, staged on a scratch score and played, so the loop
 * moves through the values. Only while the loop plays (otherwise nothing is
 * heard and the glide would only cost time); never longer than ~150 ms.
 */
async function glideFader(param: string, target: number): Promise<void> {
  if (!clock.playing || !stdout.isTTY) return;
  const scratch = new EditMenu();
  const context = { ...menuContext(), score };
  const label = scratch.showFader(context, param);
  if (!label) return;
  const field = scratch
    .faderFields(context)
    .find((candidate) => candidate.label === label);
  scratch.close();
  if (field?.kind !== "number") return;
  const from = field.value ?? field.start ?? target;
  const steps = glideValues(from, target).slice(0, -1);
  for (const value of steps) {
    const staged = await applyStaged(score, field.command(value));
    if (staged.next && clock.playing) void audio.play(staged.next);
    await Bun.sleep(GLIDE_STEP_MS);
  }
}

/** Sound one streamed note on the audition voice (the loop is stopped). */
function soundStreamedNote(
  value: TrackScore,
  trackId: string,
  pitch: number,
  startBeat: number,
): void {
  if (clock.playing) return; // The loop itself plays it.
  const engine = liveEngine();
  if (!engine?.canMonitor) return;
  const tick = Math.round(startBeat * value.ticksPerBeat);
  const note = value.notes.find(
    (candidate) =>
      candidate.trackId === trackId &&
      candidate.pitch === pitch &&
      candidate.startTick === tick,
  );
  if (!note) return;
  try {
    const json = value.toJSON() as unknown as Record<string, unknown>;
    const single = scoreFromJSON({
      ...json,
      notes: [{ ...note, startTick: 0 }],
    });
    const pcm = renderAudition({
      score: single,
      trackId,
      sampleRate: engine.sampleRate,
      ...(liveSampleBank ? { samples: liveSampleBank } : {}),
    });
    if (!pcm) return;
    void engine
      .monitor(true)
      .then(() => engine.noteOn(AUDITION_VOICE, pcm))
      .catch(() => undefined);
  } catch {
    // A note that cannot render is still in the score.
  }
}

/** The command host the show-me agent loop runs lines through. */
function showMeCommandHost(): AgentHost["commands"] {
  return {
    isCommand: (line) =>
      isAgentCommand(line, score) || isBrokenCommand(line, score),
    async run(line): Promise<CommandOutcome> {
      if (!agentPathsAllowed(line)) {
        const revision = shownRevision(record);
        return {
          ok: false,
          message: `${line} · the agent works only inside this folder`,
          baseRevision: revision,
          resultRevision: revision,
        };
      }
      if (isBrokenCommand(line, score)) {
        // A command that does not parse is a red receipt, never prose.
        const base = baseline();
        receipt(fail(brokenCommandReceipt(line)), base);
        return {
          ok: false,
          message: brokenCommandReceipt(line),
          baseRevision: base.revision,
          resultRevision: base.revision,
        };
      }
      const gesture = gestureFor(line, { score, trackId: requestedTrack });
      showMeCaption(gesture.caption);
      showMe.commands.push(line);
      if (gesture.kind === "fader" && showMe.level === "on")
        await glideFader(gesture.param, gesture.value);
      const base = baseline();
      tui.activity.pushNote(`agent › ${line}`, "request");
      let result: string | Receipt;
      try {
        result = await submit(line);
      } catch (error) {
        result = fail(describeError(line, error));
      }
      receipt(result, base);
      if (gesture.kind === "keys" && showMe.level === "on") {
        const trackId = requestedTrack;
        const after = score;
        for (const note of gesture.notes) {
          const { atMs } = showMe.notes.schedule(note.start, performance.now());
          const delay = Math.max(0, atMs - performance.now());
          setTimeout(
            () => soundStreamedNote(after, trackId, note.pitch, note.start),
            delay,
          );
        }
      }
      return {
        ok: toneOf(result) !== "error",
        message: typeof result === "string" ? result : result.text,
        baseRevision: shownRevision(record, base.revision),
        resultRevision: shownRevision(record),
      };
    },
  };
}

function agentHost(
  turn: { steering: string[] },
  selection: ProviderSelection,
): AgentHost {
  return {
    snapshot: () => ({
      score,
      revision: record.revision,
      focusedTrackId: requestedTrack,
      recentOperations: record.events.slice(-8).map((event) => {
        const payload = event.payload as { summary?: unknown } | null;
        return typeof payload?.summary === "string"
          ? `${event.kind}: ${payload.summary}`
          : event.kind;
      }),
    }),
    media: mediaServices(),
    history: history.handle,
    preview: agentPreviewHost(),
    // dispatch children run on this turn's provider, scoped and attributed.
    ...(() => {
      const subagents = subagentHostFor(selection);
      return subagents ? { subagents } : {};
    })(),
    async commit(change) {
      // dawgd rebases operation intents onto newer revisions when nothing
      // they touch changed; the file port keeps the strict base check.
      if (port.mode !== "daemon" && change.baseRevision !== record.revision)
        throw new StaleRevisionError(change.baseRevision, record.revision);
      try {
        record = await port.appendOperations(
          { ...record, revision: change.baseRevision },
          {
            kind: "agent.tool",
            payload: {
              tool: change.toolName,
              callId: change.callId,
              summary: change.summary,
              operations: change.operations,
            },
          },
          change.operations,
          change.next.toJSON(),
        );
        // A rebased commit lands on a newer score than `change.next`.
        score = scoreFromJSON(record.composition);
        if (clock.playing) void audio.play(score);
      } catch (error) {
        if (error instanceof SessionConflictError)
          throw new StaleRevisionError(
            change.baseRevision,
            record.revision + 1,
          );
        throw error;
      }
      if (
        change.operations.some(
          (operation) =>
            operation.type === "setTempo" || operation.type === "setTime",
        )
      )
        clock.follow(score);
      return { revision: record.revision };
    },
    async transport(action) {
      await setTransport(action);
      try {
        record = await port.append(
          record,
          {
            kind: "transport",
            payload: { action, playing: clock.playing, beat: clock.beatAt() },
          },
          score.toJSON(),
        );
      } catch (error) {
        if (!(error instanceof SessionConflictError)) throw error;
      }
    },
    takeSteering: () => turn.steering.splice(0),
    ...(showMe.level !== "off" && stdout.isTTY
      ? { commands: showMeCommandHost() }
      : {}),
    workspace: { root: process.cwd() },
    // A written project source is applied before the tool result returns,
    // so the model reads the outcome and any type errors in the same step.
    async onWorkspaceWrite(path) {
      if (!projectSync || !/\.ts$/.test(path)) return;
      const outcome = await projectSync.checkFiles();
      const types = await typecheckProject(process.cwd());
      const errors = types.diagnostics.slice(0, 8).map(formatDiagnostic);
      return [
        outcome,
        types.ok ? "types ✓" : `types ✗ ${types.diagnostics.length}`,
        ...errors,
      ].join("\n");
    },
    // web_search uses the turn's own gateway or OpenRouter key; billed
    // searches go to the spend meter and daily ledger.
    web: webHostFor(
      isApiSelection(selection) ? selection : { kind: selection.kind },
      meter,
      tickUi,
    ),
  };
}
