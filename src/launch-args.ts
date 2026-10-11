/**
 * The `dawg [options]` launch grammar and the small argv contract the plain
 * subcommands share. Pure: no I/O, so every mistake is rejected before
 * `.dawg/` (or any project file) could be written.
 */
export { parseSimpleArgv, type SimpleArgv } from "./argv.ts";
import { parseThemeName, THEME_NAMES, type ThemeName } from "../tui/theme.ts";

/** Subcommands that parse their own argv; the launch grammar skips them. */
export const SUBCOMMANDS: readonly string[] = [
  "login",
  "logout",
  "auth",
  "model",
  "sessions",
  "render",
  "init",
  "check",
  "media",
  "history",
];
export const VALUE_FLAGS = [
  "--session",
  "--track",
  "--import",
  "--export",
  "--theme",
] as const;
export type ValueFlag = (typeof VALUE_FLAGS)[number];
export const BOOLEAN_FLAGS: readonly string[] = [
  "--new",
  "--demo",
  "--help",
  "-h",
  "--version",
  "-v",
  "--reduce-motion",
  "--no-mouse",
];

/** A `--track` value resolved to the id `/track` would use. */
export type TrackArg = { id: string; name: string };

/** Screens a pane can open on (§12.5). */
export const PANE_SCREENS = [
  "home",
  "play",
  "tape",
  "sound",
  "menu",
  "patch",
] as const;
export type PaneScreen = (typeof PANE_SCREENS)[number];

/**
 * `dawg pane <screen> [track] [param] [pin | follow [letter]]`: what this
 * terminal shows of the session in the current directory. `sound` opens
 * the drawer on `param` (default volume); `menu` opens `param` as a menu
 * section. `follow` tracks another pane's focus (`*` = the latest).
 */
export type PaneArgs = {
  screen: PaneScreen;
  param: string | undefined;
  pin: boolean;
  follow: string | undefined;
};

export type LaunchArgs = {
  subcommand: string | undefined;
  /** `dawg pane …` (its track is `track`). */
  pane?: PaneArgs;
  flags: ReadonlySet<string>;
  session: string | undefined;
  track: TrackArg | undefined;
  importPath: string | undefined;
  exportPath: string | undefined;
  theme: ThemeName | undefined;
};

export type LaunchParse =
  { ok: true; args: LaunchArgs } | { ok: false; problem: string };

const TRACK_NAME = /^[a-z0-9._ -]{1,64}$/i;

/**
 * `--track Bass Guitar` → id `bass-guitar`, name `bass guitar`: the rule
 * `/track` applies (letters, digits, `.`, `_`, `-` and spaces, at most 64),
 * lowercased with runs of spaces collapsed. Undefined when invalid.
 */
export function normalizeTrackArg(value: string): TrackArg | undefined {
  const name = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!TRACK_NAME.test(name)) return undefined;
  // `.` and `..` are path segments, never track ids.
  if (/^\.+$/.test(name)) return undefined;
  return { id: name.replace(/ /g, "-"), name };
}

/** The existing track `arg` names (by id or name), else `arg.id`. */
export function resolveTrackArg(
  tracks: readonly { id: string; name?: string | undefined }[],
  arg: TrackArg,
): string {
  const found =
    tracks.find((track) => track.id === arg.id) ??
    tracks.find((track) => track.id.toLowerCase() === arg.id) ??
    tracks.find((track) => (track.name ?? track.id).toLowerCase() === arg.name);
  return found?.id ?? arg.id;
}

/**
 * Parses `dawg [options]`. A subcommand as the first word ends parsing (the
 * subcommand owns the rest). Value flags need a value that does not start
 * with `-`; each may be given once; `--track` and `--theme` are validated
 * here so a bad value is one line and exit 2, never a stack trace.
 */
export function parseLaunchArgs(argv: readonly string[]): LaunchParse {
  const flags = new Set<string>();
  const values = new Map<ValueFlag, string>();
  const first = argv[0];
  if (first === "pane") return parsePaneArgs(argv.slice(1));
  if (first !== undefined && !first.startsWith("-")) {
    if (SUBCOMMANDS.includes(first))
      return { ok: true, args: emptyArgs(first, flags) };
    return { ok: false, problem: `unknown command · ${clip(first)}` };
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const flag = arg as ValueFlag;
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return { ok: false, problem: `${flag} needs a value` };
      if (values.has(flag))
        return { ok: false, problem: `${flag} given twice` };
      values.set(flag, value);
      index += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.includes(arg)) {
      flags.add(arg);
      continue;
    }
    if (arg.startsWith("-"))
      return { ok: false, problem: `unknown option · ${clip(arg)}` };
    return { ok: false, problem: `unknown command · ${clip(arg)}` };
  }
  let track: TrackArg | undefined;
  const trackValue = values.get("--track");
  if (trackValue !== undefined) {
    track = normalizeTrackArg(trackValue);
    if (!track) return { ok: false, problem: "invalid track name" };
  }
  let theme: ThemeName | undefined;
  const themeValue = values.get("--theme");
  if (themeValue !== undefined) {
    theme = parseThemeName(themeValue);
    if (!theme)
      return {
        ok: false,
        problem: `unknown theme ${clip(themeValue)} · ${THEME_NAMES.join(" | ")}`,
      };
  }
  return {
    ok: true,
    args: {
      subcommand: undefined,
      flags,
      session: values.get("--session"),
      track,
      importPath: values.get("--import"),
      exportPath: values.get("--export"),
      theme,
    },
  };
}

/** Drawer parameters `dawg pane sound <word>` opens (else the word is a track). */
const SOUND_PARAMS: readonly string[] = [
  "volume",
  "pan",
  "tempo",
  "bpm",
  "bars",
  "meter",
];

const PANE_USAGE =
  "usage: dawg pane home|play|tape|sound|menu|patch [track] [volume|pan|section|fx patch] [pin|follow [A-Z]]";

export function parsePaneArgs(argv: readonly string[]): LaunchParse {
  const [screenWord, ...rest] = argv;
  const screen = PANE_SCREENS.find(
    (name) => name === screenWord?.toLowerCase(),
  );
  if (!screen)
    return {
      ok: false,
      problem: screenWord
        ? `unknown pane screen ${clip(screenWord)} · ${PANE_USAGE}`
        : PANE_USAGE,
    };
  let pin = false;
  let follow: string | undefined;
  const words: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]!;
    if (word === "pin") pin = true;
    else if (word === "follow") {
      const letter = rest[index + 1];
      if (letter !== undefined && /^[A-Z]$/i.test(letter)) {
        follow = letter.toUpperCase();
        index += 1;
      } else follow = "*";
    } else if (word.startsWith("-"))
      return {
        ok: false,
        problem: `unknown option · ${clip(word)} · ${PANE_USAGE}`,
      };
    else words.push(word);
  }
  if (pin && follow)
    return { ok: false, problem: `pin or follow, not both · ${PANE_USAGE}` };
  if (words.length > 2)
    return { ok: false, problem: `too many words · ${PANE_USAGE}` };
  let track: TrackArg | undefined;
  // `menu mix`, `sound filter`: one word after these is the section or the
  // parameter; a track then comes first (`sound bass filter`).
  const [first, second] = words;
  let param: string | undefined;
  const trackFirst =
    words.length === 2 ||
    (first !== undefined &&
      (screen === "home" ||
        screen === "play" ||
        screen === "patch" ||
        (screen === "sound" && !SOUND_PARAMS.includes(first.toLowerCase()))));
  if (trackFirst) {
    track = normalizeTrackArg(first!);
    if (!track) return { ok: false, problem: "invalid track name" };
    param = second;
  } else param = first;
  if (param !== undefined && !/^[a-z][a-z0-9 ._-]{0,63}$/i.test(param))
    return { ok: false, problem: `invalid pane parameter · ${PANE_USAGE}` };
  if (param !== undefined && (screen === "home" || screen === "play"))
    return {
      ok: false,
      problem: `${screen} takes a track only · ${PANE_USAGE}`,
    };
  return {
    ok: true,
    args: {
      ...emptyArgs(undefined, new Set()),
      track,
      pane: { screen, param: param?.toLowerCase(), pin, follow },
    },
  };
}

function emptyArgs(
  subcommand: string | undefined,
  flags: Set<string>,
): LaunchArgs {
  return {
    subcommand,
    flags,
    session: undefined,
    track: undefined,
    importPath: undefined,
    exportPath: undefined,
    theme: undefined,
  };
}

function clip(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}
