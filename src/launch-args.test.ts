import { describe, expect, test } from "bun:test";
import {
  BOOLEAN_FLAGS,
  normalizeTrackArg,
  parseLaunchArgs,
  parseSimpleArgv,
  resolveTrackArg,
  VALUE_FLAGS,
} from "./launch-args.ts";
import { THEME_NAMES } from "../tui/theme.ts";

/** mulberry32: a small seeded generator so the fuzz cases are reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!;

describe("parseLaunchArgs", () => {
  test("a value flag with no value, or a flag as its value, is an error", () => {
    for (const flag of VALUE_FLAGS) {
      expect(parseLaunchArgs([flag])).toEqual({
        ok: false,
        problem: `${flag} needs a value`,
      });
      expect(parseLaunchArgs([flag, ""])).toEqual({
        ok: false,
        problem: `${flag} needs a value`,
      });
      expect(parseLaunchArgs([flag, "--new"]).ok).toBe(false);
      expect(parseLaunchArgs([flag, "-h"]).ok).toBe(false);
    }
  });

  test("--session --new is rejected, not read as two things", () => {
    const parsed = parseLaunchArgs(["--session", "--new"]);
    expect(parsed).toEqual({ ok: false, problem: "--session needs a value" });
    expect(parseLaunchArgs(["--track", "--new"]).ok).toBe(false);
  });

  test("--theme takes a known name or alias and lists them otherwise", () => {
    for (const name of THEME_NAMES) {
      const parsed = parseLaunchArgs(["--theme", name]);
      expect(parsed.ok && parsed.args.theme).toBe(name);
    }
    const alias = parseLaunchArgs(["--theme", "HC"]);
    expect(alias.ok && alias.args.theme).toBe("high-contrast");
    const bad = parseLaunchArgs(["--theme", "bogus"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      for (const name of THEME_NAMES) expect(bad.problem).toContain(name);
  });

  test("--track is normalized like /track and length-checked", () => {
    const parsed = parseLaunchArgs(["--track", "Bass Guitar"]);
    expect(parsed.ok && parsed.args.track).toEqual({
      id: "bass-guitar",
      name: "bass guitar",
    });
    expect(parseLaunchArgs(["--track", "a".repeat(64)]).ok).toBe(true);
    expect(parseLaunchArgs(["--track", "a".repeat(65)])).toEqual({
      ok: false,
      problem: "invalid track name",
    });
    for (const bad of ["../../etc", "a/b", "..", ".", "bass!", "é"])
      expect(parseLaunchArgs(["--track", bad]).ok).toBe(false);
  });

  test("repeats, unknown options and stray words are errors", () => {
    expect(parseLaunchArgs(["--track", "a", "--track", "b"])).toEqual({
      ok: false,
      problem: "--track given twice",
    });
    expect(parseLaunchArgs(["--bogus"])).toEqual({
      ok: false,
      problem: "unknown option · --bogus",
    });
    expect(parseLaunchArgs(["--new", "stray"])).toEqual({
      ok: false,
      problem: "unknown command · stray",
    });
    expect(parseLaunchArgs(["nope"])).toEqual({
      ok: false,
      problem: "unknown command · nope",
    });
  });

  test("a subcommand owns the rest of argv", () => {
    const parsed = parseLaunchArgs(["render", "--whatever", "x"]);
    expect(parsed.ok && parsed.args.subcommand).toBe("render");
  });

  test("a full valid launch line parses every field", () => {
    const parsed = parseLaunchArgs([
      "--new",
      "--session",
      "jam",
      "--track",
      "Keys",
      "--import",
      "a.track.json",
      "--export",
      "b.track.json",
      "--theme",
      "mono",
      "--no-mouse",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.session).toBe("jam");
    expect(parsed.args.track).toEqual({ id: "keys", name: "keys" });
    expect(parsed.args.importPath).toBe("a.track.json");
    expect(parsed.args.exportPath).toBe("b.track.json");
    expect(parsed.args.theme).toBe("mono");
    expect([...parsed.args.flags].sort()).toEqual(["--new", "--no-mouse"]);
  });

  test("fuzz: every argv either parses consistently or names one problem", () => {
    const random = rng(0x0dab);
    const atoms = [
      ...VALUE_FLAGS,
      ...BOOLEAN_FLAGS,
      "",
      "-",
      "--",
      "--bogus",
      "-x",
      "jam",
      "Bass",
      "../x",
      "a".repeat(70),
      "mono",
      "render",
      "song.track.json",
    ];
    for (let run = 0; run < 2000; run += 1) {
      const length = Math.floor(random() * 6);
      const argv = Array.from({ length }, () => pick(random, atoms));
      const parsed = parseLaunchArgs(argv);
      if (!parsed.ok) {
        expect(parsed.problem.length).toBeGreaterThan(0);
        expect(parsed.problem).not.toContain("\n");
        continue;
      }
      const { args } = parsed;
      if (args.subcommand) continue;
      // Every value the parser accepted is the word after its flag, and
      // never another flag.
      for (const [flag, value] of [
        ["--session", args.session],
        ["--import", args.importPath],
        ["--export", args.exportPath],
      ] as const) {
        if (value === undefined) {
          expect(argv).not.toContain(flag);
          continue;
        }
        expect(argv[argv.indexOf(flag) + 1]).toBe(value);
        expect(value.startsWith("-")).toBe(false);
      }
      if (args.track) {
        expect(args.track.id).toMatch(/^[a-z0-9._-]{1,64}$/);
        expect(normalizeTrackArg(args.track.id)?.id).toBe(args.track.id);
      }
      for (const flag of args.flags) expect(BOOLEAN_FLAGS).toContain(flag);
    }
  });
});

describe("normalizeTrackArg", () => {
  test("property: ids are idempotent, lowercase and path-free", () => {
    const random = rng(64);
    const alphabet = "abcXYZ019._- /\\!é\t";
    for (let run = 0; run < 3000; run += 1) {
      const length = 1 + Math.floor(random() * 70);
      let value = "";
      for (let i = 0; i < length; i += 1) value += pick(random, [...alphabet]);
      const arg = normalizeTrackArg(value);
      if (!arg) continue;
      expect(arg.id).toMatch(/^[a-z0-9._-]{1,64}$/);
      expect(arg.id).not.toMatch(/^\.+$/);
      expect(arg.id).toBe(arg.id.toLowerCase());
      expect(arg.name.replace(/ /g, "-")).toBe(arg.id);
      expect(normalizeTrackArg(arg.name)).toEqual(arg);
      expect(normalizeTrackArg(arg.id)?.id).toBe(arg.id);
    }
  });
});

describe("resolveTrackArg", () => {
  test("matches an existing track by id or name before creating one", () => {
    const tracks = [
      { id: "Bass", name: "Bass" },
      { id: "gtr", name: "Bass Guitar" },
    ];
    expect(resolveTrackArg(tracks, normalizeTrackArg("bass")!)).toBe("Bass");
    expect(resolveTrackArg(tracks, normalizeTrackArg("BASS GUITAR")!)).toBe(
      "gtr",
    );
    expect(resolveTrackArg(tracks, normalizeTrackArg("keys")!)).toBe("keys");
  });
});

describe("parseSimpleArgv", () => {
  test("help anywhere, unknown options and extra words", () => {
    expect(parseSimpleArgv(["--help"], 0)).toEqual({ kind: "help" });
    expect(parseSimpleArgv(["dir", "-h"], 1)).toEqual({ kind: "help" });
    expect(parseSimpleArgv(["--version"], 0)).toEqual({
      kind: "error",
      problem: "unknown option · --version",
    });
    expect(parseSimpleArgv(["a", "b"], 1)).toEqual({
      kind: "error",
      problem: "unexpected argument · b",
    });
    expect(parseSimpleArgv(["dir"], 1)).toEqual({
      kind: "run",
      positionals: ["dir"],
    });
    expect(parseSimpleArgv([], 0)).toEqual({ kind: "run", positionals: [] });
  });
});

describe("dawg pane", () => {
  const pane = (argv: string[]) => {
    const parsed = parseLaunchArgs(["pane", ...argv]);
    if (!parsed.ok) throw new Error(parsed.problem);
    return { track: parsed.args.track?.id, ...parsed.args.pane };
  };

  test("screen, track, parameter, pin and follow", () => {
    expect(pane(["home"])).toEqual({
      track: undefined,
      screen: "home",
      param: undefined,
      pin: false,
      follow: undefined,
    });
    expect(pane(["play", "drums"])).toMatchObject({
      screen: "play",
      track: "drums",
    });
    expect(pane(["sound", "bass"])).toMatchObject({
      track: "bass",
      param: undefined,
    });
    expect(pane(["sound", "pan"])).toMatchObject({
      track: undefined,
      param: "pan",
    });
    expect(pane(["sound", "bass", "volume", "pin"])).toMatchObject({
      track: "bass",
      param: "volume",
      pin: true,
    });
    expect(pane(["menu", "mix"])).toMatchObject({ param: "mix" });
    // The patch view: a track, then an effect patch by name.
    expect(pane(["patch", "bass"])).toMatchObject({
      screen: "patch",
      track: "bass",
      param: undefined,
    });
    expect(pane(["patch", "bass", "wide-crush"])).toMatchObject({
      track: "bass",
      param: "wide-crush",
    });
    expect(pane(["sound", "follow"])).toMatchObject({ follow: "*" });
    expect(pane(["sound", "follow", "b"])).toMatchObject({ follow: "B" });
  });

  test("mistakes are one line", () => {
    for (const argv of [
      [],
      ["reels"],
      ["play", "a", "b"],
      ["home", "x", "pin", "follow"],
      ["sound", "--x"],
    ]) {
      const parsed = parseLaunchArgs(["pane", ...argv]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problem).not.toContain("\n");
    }
  });
});
