/**
 * The launch and subcommand argv contract, end to end: help never writes,
 * mistakes exit 2 before `.dawg/` exists, `--track` normalizes like `/track`,
 * `--import X --export Y` converts without touching the session, and a demo
 * frame in a fresh directory leaves nothing behind.
 */
import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const dirs: string[] = [];
const home = await mkdtemp(join(tmpdir(), "dawg-cli-home-"));
dirs.push(home);

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dawg-cli-"));
  dirs.push(dir);
  return dir;
}

async function run(
  cwd: string,
  argv: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...argv], {
    cwd,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      TERM: "xterm-256color",
      NO_COLOR: "1",
      DAWG_AUDIO: "0",
      DAWG_AI: "0",
      DAWG_DAEMON: "0",
      DAWG_PROVIDER: "gateway",
      DAWG_CREDENTIAL_STORE: "file",
      DAWG_CONFIG_DIR: join(home, ".config"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      ...extra,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("every subcommand's --help exits 0 and writes nothing", async () => {
  const cases = [
    ["init", "--help"],
    ["init", "-h"],
    ["check", "--help"],
    ["sessions", "--help"],
    ["history", "--help"],
    ["media", "--help"],
    ["media", "-h"],
    ["render", "--help"],
    ["login", "--help"],
    ["model", "--help"],
    ["--help"],
  ];
  const results = await Promise.all(
    cases.map(async (argv) => {
      const dir = await workspace();
      const result = await run(dir, argv);
      return { argv, result, files: await readdir(dir) };
    }),
  );
  for (const { argv, result, files } of results) {
    expect({ argv, code: result.code, files }).toEqual({
      argv,
      code: 0,
      files: [],
    });
    expect(result.stdout.length).toBeGreaterThan(0);
  }
});

test("subcommand and launch mistakes exit 2 before writing anything", async () => {
  const long = `x${"y".repeat(80)}`;
  const cases: [string[], string][] = [
    [["init", "--bogus"], "unknown option · --bogus"],
    [["init", "a", "b"], "unexpected argument · b"],
    [["check", "extra"], "unexpected argument · extra"],
    [["sessions", "--version"], "unknown option · --version"],
    [["sessions", "extra"], "unexpected argument · extra"],
    [["history", "--bogus"], "unknown option · --bogus"],
    [["--session"], "--session needs a value"],
    [["--session", "--new"], "--session needs a value"],
    [["--track"], "--track needs a value"],
    [["--track", ""], "--track needs a value"],
    [["--track", "--new"], "--track needs a value"],
    [["--track", long], "invalid track name"],
    [["--track", "../../etc"], "invalid track name"],
    [["--theme", "bogus"], "unknown theme bogus"],
    [["--import"], "--import needs a value"],
  ];
  const results = await Promise.all(
    cases.map(async ([argv, message]) => {
      const dir = await workspace();
      const result = await run(dir, argv);
      return { argv, message, result, files: await readdir(dir) };
    }),
  );
  for (const { argv, message, result, files } of results) {
    expect({ argv, code: result.code, files }).toEqual({
      argv,
      code: 2,
      files: [],
    });
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain(" at ");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  }
});

test("--track normalizes like /track and reuses case variants", async () => {
  const dir = await workspace();
  // An existing workspace: the demo frame then works on its session.
  await mkdir(join(dir, ".dawg"));
  const demo = { DAWG_DEMO: "1" };
  expect(
    (await run(dir, ["--track", "Bass", "--export", "a.json"], demo)).code,
  ).toBe(0);
  expect(
    (await run(dir, ["--track", "bass", "--export", "b.json"], demo)).code,
  ).toBe(0);
  expect(
    (await run(dir, ["--track", "Bass Guitar", "--export", "c.json"], demo))
      .code,
  ).toBe(0);
  const ids = (file: string) =>
    readFile(join(dir, file), "utf8").then((raw) =>
      (JSON.parse(raw) as { tracks: { id: string }[] }).tracks.map(
        (track) => track.id,
      ),
    );
  const final = await ids("c.json");
  expect(final.filter((id) => id.toLowerCase() === "bass")).toEqual(["bass"]);
  expect(final).toContain("bass-guitar");
  expect(final.every((id) => /^[a-z0-9._-]{1,64}$/.test(id))).toBe(true);
});

test("--import X --export Y converts without opening a session", async () => {
  const dir = await workspace();
  const source = await workspace();
  // A loop file from a throwaway workspace, its tempo edited.
  expect(
    (await run(source, ["--export", "a.track.json"], { DAWG_DEMO: "1" })).code,
  ).toBe(0);
  const loop = JSON.parse(
    await readFile(join(source, "a.track.json"), "utf8"),
  ) as { tempoBpm: number };
  loop.tempoBpm = 77;
  await writeFile(join(dir, "b.track.json"), JSON.stringify(loop));
  const converted = await run(dir, [
    "--import",
    "b.track.json",
    "--export",
    "c.track.json",
  ]);
  expect(converted.code).toBe(0);
  expect(converted.stdout).toBe("converted b.track.json → c.track.json\n");
  expect((await readdir(dir)).sort()).toEqual(["b.track.json", "c.track.json"]);
  const out = JSON.parse(await readFile(join(dir, "c.track.json"), "utf8")) as {
    tempoBpm: number;
  };
  expect(out.tempoBpm).toBe(77);
});

test("a demo frame in a fresh directory creates no .dawg/", async () => {
  const dir = await workspace();
  const result = await run(dir, ["--demo"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("dawg");
  expect(await readdir(dir)).toEqual([]);
  // Piped stdin (not a TTY) is a demo too.
  const piped = await run(dir, []);
  expect(piped.code).toBe(0);
  expect(await readdir(dir)).toEqual([]);
});

test("dawg --help lists every flag render accepts, every line within 78 columns", async () => {
  const { RENDER_USAGE } = await import("../src/render.ts");
  const help = (await run(await workspace(), ["--help"])).stdout;
  for (const flag of RENDER_USAGE.match(/--[a-z-]+/g) ?? [])
    expect(help).toContain(flag);
  expect(help).toContain("--section");
  expect(help).toContain("--rate");
  const usage = help.split("\n\n")[1]!.split("\n");
  const render = usage.filter(
    (line) =>
      line.includes("dawg render") || line.startsWith("               ["),
  );
  expect(render.length).toBeGreaterThan(1);
  expect(render.every((line) => line.length <= 78)).toBe(true);
  // Every line fits an 80-column terminal with a margin.
  expect(help.split("\n").filter((line) => line.length > 78)).toEqual([]);
});
