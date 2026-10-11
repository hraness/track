/**
 * End-to-end qualification: real `dawg` processes in real PTYs, a real
 * dawgd daemon, a temp workspace, and no network.
 *
 * One scenario walks the multi-window workflow: three windows build drums,
 * bass and keys on a new session and converge on one revision and digest;
 * transport is shared; /rename propagates; reopened windows auto-claim the
 * three tracks and a fourth gets a draft; undo/redo stay consistent across
 * windows; /fork numbers the new session; a `kill -9` of dawgd recovers
 * with the same digest on the next edit; and `dawg render` is
 * byte-for-byte deterministic.
 */
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { VirtualTerminal } from "./vt.ts";
import { wavBytes } from "../src/audio/sample-fixtures.ts";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const supported =
  process.platform !== "win32" &&
  typeof (Bun as unknown as { Terminal?: unknown }).Terminal === "function";

const COLS = 120;
const ROWS = 32;

interface PtyTerminal {
  write(data: string): void;
  close(): void;
}

type Window = {
  name: string;
  proc: ReturnType<typeof Bun.spawn>;
  terminal: PtyTerminal;
  vt: VirtualTerminal;
};

const workspaces: string[] = [];
const windows = new Set<Window>();

/** Offline, credential-free environment: no provider, no audio, no network. */
function env(workspace: string): Record<string, string> {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: workspace,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    NO_COLOR: "1",
    DAWG_AUDIO: "0",
    DAWG_AI: "0",
    DAWG_PROVIDER: "gateway",
    DAWG_CREDENTIAL_STORE: "file",
    DAWG_CONFIG_DIR: join(workspace, ".config"),
    // Bun caches transpiled large modules under $HOME (macOS: Library/Caches/bun);
    // keep that out of the workspace the tests inspect.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
}

function open(workspace: string, name: string, argv: string[] = []): Window {
  const vt = new VirtualTerminal(COLS, ROWS);
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, MAIN, ...argv], {
    cwd: workspace,
    env: env(workspace),
    terminal: {
      cols: COLS,
      rows: ROWS,
      data(_terminal: unknown, data: Uint8Array) {
        vt.writeFrames(decoder.decode(data, { stream: true }));
      },
    },
  } as Parameters<typeof Bun.spawn>[1]);
  const terminal = (proc as unknown as { terminal: PtyTerminal }).terminal;
  const window = { name, proc, terminal, vt };
  windows.add(window);
  return window;
}

async function until(
  predicate: () => boolean,
  label: string,
  context: () => string = () => "",
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}\n${context()}`);
    await Bun.sleep(25);
  }
}

const header = (w: Window) => w.vt.lines()[0] ?? "";
/** The session name lives in the footer (design §13). */
const footer = (w: Window) => w.vt.lines().at(-1) ?? "";
const screens = (ws: readonly Window[]) =>
  ws.map((w) => `--- ${w.name}\n${w.vt.text()}`).join("\n");

async function ready(w: Window): Promise<void> {
  await until(
    // DAWG_AI=0: no agent, so the command placeholder shows instead of NOW.
    () => w.vt.text().includes("try: ") && /rev \d+/.test(header(w)),
    `${w.name} prompt`,
    () => w.vt.text(),
  );
}

async function send(w: Window, line: string): Promise<void> {
  w.terminal.write(`${line}\r`);
  await Bun.sleep(40);
}

/** Runs a command that commits exactly one revision and waits for it. */
async function edit(w: Window, line: string): Promise<number> {
  const before = revision(w);
  await send(w, line);
  await until(
    () => revision(w) > before,
    `${w.name}: ${line}`,
    () => w.vt.text(),
  );
  return revision(w);
}

function revision(w: Window): number {
  const match = header(w).match(/rev (\d+)/);
  return match ? Number(match[1]) : -1;
}

type Status = { name: string; revision: number; digest: string; mode: string };

/**
 * Asks a window for `/status` and parses its own revision and digest. The
 * activity strip lists the newest card first and merges repeats, so the
 * first match whose revision equals the header's is the current reading.
 */
async function status(w: Window): Promise<Status> {
  const marker =
    /status · (.+?) · rev (\d+) · ([0-9a-f]{16}) · (shared via dawgd|saved locally · no daemon)/;
  await send(w, "/status");
  let found: RegExpMatchArray | null = null;
  await until(
    () => {
      found = w.vt.text().match(marker);
      return (
        found !== null &&
        Number(found[2]) === revision(w) &&
        footer(w).includes(found[1]!)
      );
    },
    `${w.name} /status`,
    () => w.vt.text(),
  );
  const match = found as unknown as RegExpMatchArray;
  return {
    name: match[1]!,
    revision: Number(match[2]),
    digest: match[3]!,
    mode: match[4]!,
  };
}

/**
 * Waits until every window's header shows the same revision, then checks
 * each window's own composition digest and session name agree.
 */
async function converged(ws: readonly Window[]): Promise<Status> {
  await until(
    () => {
      const revisions = ws.map(revision);
      return revisions[0]! > 0 && revisions.every((r) => r === revisions[0]);
    },
    "same revision in every window",
    () => screens(ws),
  );
  // The session name changes without a revision (the auto-namer renames on
  // a timer, and the rename reaches each window on its own), so it can land
  // between two windows' /status reads. Read until one snapshot agrees: every
  // window's /status names the same session and every footer, read after,
  // shows it. A real divergence still fails at the deadline.
  let statuses: Status[] = [];
  let footers: string[] = [];
  const deadline = Date.now() + 10_000;
  for (;;) {
    statuses = [];
    for (const w of ws) statuses.push(await status(w));
    footers = ws.map(footer);
    const name = statuses[0]!.name;
    const agreed =
      statuses.every((s) => s.name === name) &&
      footers.every((f) => f.includes(name));
    if (agreed || Date.now() > deadline) break;
  }
  for (const s of statuses) {
    expect(s.mode).toBe("shared via dawgd");
    expect(s.revision).toBe(statuses[0]!.revision);
    expect(s.digest).toBe(statuses[0]!.digest);
    expect(s.name).toBe(statuses[0]!.name);
  }
  for (const f of footers) expect(f).toContain(statuses[0]!.name);
  return statuses[0]!;
}

async function close(w: Window): Promise<void> {
  w.terminal.write("\u0003");
  const code = await Promise.race([
    w.proc.exited,
    Bun.sleep(5_000).then(() => "timeout" as const),
  ]);
  if (code === "timeout") w.proc.kill("SIGKILL");
  w.terminal.close();
  windows.delete(w);
  expect(code).toBe(0);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Live dawgd pids for every session in a workspace, from their locks. */
async function daemonPids(workspace: string): Promise<number[]> {
  const dir = join(workspace, ".dawg", "sessions");
  const names = await readdir(dir).catch(() => [] as string[]);
  const pids: number[] = [];
  for (const name of names.filter((n) => n.endsWith(".daemon.lock"))) {
    try {
      const owner = JSON.parse(
        await readFile(join(dir, name, "owner"), "utf8"),
      ) as {
        pid?: unknown;
      };
      if (typeof owner.pid === "number" && alive(owner.pid))
        pids.push(owner.pid);
    } catch {
      // A lock being rewritten; the next read sees it.
    }
  }
  return pids;
}

afterAll(async () => {
  for (const w of windows) {
    w.proc.kill("SIGKILL");
    w.terminal.close();
  }
  for (const workspace of workspaces) {
    for (const pid of await daemonPids(workspace)) process.kill(pid, "SIGKILL");
    await rm(workspace, { recursive: true, force: true });
  }
});

async function render(workspace: string, out: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, MAIN, "render", out], {
    cwd: workspace,
    env: env(workspace),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const bytes = await readFile(join(workspace, out));
  const sha = createHash("sha256").update(bytes).digest("hex");
  expect(stdout).toContain(sha);
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
  return sha;
}

test.skipIf(!supported)(
  "e2e: three windows, dawgd, rename, auto-claim, undo/redo, fork, kill -9, render",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "dawg-e2e-"));
    workspaces.push(workspace);

    // 1. Three windows on a new session, one per instrument.
    const drums = open(workspace, "drums", ["--new", "--track", "drums"]);
    await ready(drums);
    // Sequential: each window creates its track on attach, and auto-claim
    // below depends on score order drums, bass, keys.
    const bass = open(workspace, "bass", ["--track", "bass"]);
    await ready(bass);
    const keys = open(workspace, "keys", ["--track", "keys"]);
    await ready(keys);
    const trio = [drums, bass, keys];
    await converged(trio);

    await edit(drums, "pattern kick every 1");
    await edit(drums, "pattern snare 1 3 vel 0.8");
    await edit(drums, "pattern hat every 0.5 from 0.25 vel 0.5");
    await converged(trio);
    await edit(bass, "instrument bass");
    await edit(bass, "add C2 at 0 for 1");
    await edit(bass, "add G2 at 2 for 1");
    await converged(trio);
    await edit(keys, "instrument piano");
    await edit(keys, "add E4 at 0 for 2");
    await edit(keys, "add G4 at 2 for 2");
    const built = await converged(trio);
    expect(header(drums)).toContain("drums");
    expect(header(bass)).toContain("bass");
    expect(header(keys)).toContain("keys");

    // Transport is shared: play in one window shows ▶ in all three.
    await send(bass, "play");
    await until(
      () => trio.every((w) => header(w).includes("▶")),
      "▶ in every window",
      () => screens(trio),
    );
    await send(keys, "pause");
    await until(
      () => trio.every((w) => header(w).includes("⏸")),
      "⏸ in every window",
      () => screens(trio),
    );

    // 2. /rename propagates to every header.
    await send(drums, "/rename night drive");
    await until(
      () => trio.every((w) => footer(w).includes("night drive")),
      "renamed header in every window",
      () => screens(trio),
    );
    const renamed = await converged(trio);
    expect(renamed.name).toBe("night drive");
    expect(renamed.digest).toBe(built.digest);
    for (const w of trio) await close(w);

    // Reopened plain windows auto-claim drums, bass and keys in score order;
    // a fourth window gets a draft track.
    const one = open(workspace, "one");
    await ready(one);
    const two = open(workspace, "two");
    await ready(two);
    const three = open(workspace, "three");
    await ready(three);
    expect(header(one)).toContain("drums");
    expect(header(two)).toContain("bass");
    expect(header(three)).toContain("keys");
    const four = open(workspace, "four");
    await until(
      () => four.vt.text().includes("all tracks open"),
      "draft hint",
      () => four.vt.text(),
    );
    expect(header(four)).toContain("track-4");
    const quad = [one, two, three, four];
    const reopened = await converged(quad);
    expect(reopened.digest).toBe(built.digest);
    expect(reopened.name).toBe("night drive");

    // `undo all` in one pane and `redo all` in another stay consistent
    // everywhere (plain undo is per pane, design §12.6).
    await edit(two, "add A2 at 3 for 1");
    const added = await converged(quad);
    await edit(three, "undo all");
    const undone = await converged(quad);
    expect(undone.digest).toBe(built.digest);
    await edit(one, "redo all");
    const redone = await converged(quad);
    expect(redone.digest).toBe(added.digest);
    await send(four, "redo all");
    await until(
      () => four.vt.text().includes("nothing to redo"),
      "empty redo stack",
      () => four.vt.text(),
    );

    // 3. kill -9 dawgd mid-session: the next edit recovers the same state.
    const [pid] = await daemonPids(workspace);
    expect(pid).toBeNumber();
    process.kill(pid!, "SIGKILL");
    await until(() => !alive(pid!), "dawgd exit");
    const recovered = await edit(one, "pattern clap 1 3 vel 0.6");
    expect(recovered).toBe(redone.revision + 1);
    const afterCrash = await converged(quad);
    expect(afterCrash.revision).toBe(recovered);
    const [respawned] = await daemonPids(workspace);
    expect(respawned).toBeNumber();
    expect(respawned).not.toBe(pid);
    // Undoing the post-crash edit returns to the pre-crash digest.
    await edit(three, "undo all");
    const rewound = await converged(quad);
    expect(rewound.digest).toBe(redone.digest);
    await edit(two, "redo all");
    const replayed = await converged(quad);
    expect(replayed.digest).toBe(afterCrash.digest);

    // 4. /fork numbers the new session and moves only this window.
    await send(four, "/fork");
    await until(
      () => footer(four).includes("night drive 2"),
      "fork header",
      () => four.vt.text(),
    );
    // The card can draw a frame after the header under load.
    await until(
      () => four.vt.text().includes("forked · night drive 2"),
      "fork card",
      () => four.vt.text(),
    );
    const forked = await status(four);
    expect(forked.name).toBe("night drive 2");
    expect(forked.digest).toBe(replayed.digest);
    for (const w of [one, two, three])
      expect(footer(w)).not.toContain("night drive 2");
    const stayed = await converged([one, two, three]);
    expect(stayed.name).toBe("night drive");

    for (const w of quad) await close(w);

    // 5. Rendering the session twice is byte-identical. The workspace
    // pointer follows the fork, which holds the same composition.
    const first = await render(workspace, "first.wav");
    const second = await render(workspace, "second.wav");
    expect(second).toBe(first);
  },
  120_000,
);

test("argument mistakes and --version never create .dawg/", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dawg-args-"));
  workspaces.push(workspace);
  const run = async (argv: string[]) => {
    const proc = Bun.spawn([process.execPath, MAIN, ...argv], {
      cwd: workspace,
      env: env(workspace),
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
  };
  const version = await run(["--version"]);
  expect(version.code).toBe(0);
  expect(version.stdout).toMatch(/^dawg \d+\.\d+\.\d+/);
  const bogus = await run(["bogus"]);
  expect(bogus.code).toBe(2);
  expect(bogus.stderr).toBe("unknown command · bogus · dawg --help\n");
  const typo = await run(["--sesion", "x"]);
  expect(typo.code).toBe(2);
  expect(typo.stderr).toContain("unknown option · --sesion");
  const missing = await run(["--session", "nope"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toBe('no session named "nope" · dawg sessions\n');
  const renderHelp = await run(["render", "--help"]);
  expect(renderHelp.code).toBe(0);
  expect(renderHelp.stdout).toContain("usage: dawg render <out.wav>");
  const sessionsHelp = await run(["sessions", "--help"]);
  expect(sessionsHelp.code).toBe(0);
  expect(sessionsHelp.stdout).toContain("usage: dawg sessions");
  expect(await readdir(workspace)).toEqual([]);
});

test("demo --track drums seeds a drum pattern, not melodic notes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dawg-demo-"));
  workspaces.push(workspace);
  const proc = Bun.spawn(
    [process.execPath, MAIN, "--track", "drums", "--export", "demo.json"],
    {
      cwd: workspace,
      env: { ...env(workspace), DAWG_DEMO: "1" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  expect(await proc.exited).toBe(0);
  const exported = JSON.parse(
    await readFile(join(workspace, "demo.json"), "utf8"),
  ) as { notes: { pitch: number; trackId: string }[] };
  const pitches = new Set(exported.notes.map((note) => note.pitch));
  // kick 36, snare 38, closed hat 42; nothing falls through to rim.
  expect([...pitches].sort()).toEqual([36, 38, 42]);
  expect(exported.notes.every((note) => note.trackId === "drums")).toBe(true);
});

test.skipIf(!supported)(
  "project files: init, hand-edited track file, TUI edit reprinted, second window sees both",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "dawg-project-"));
    workspaces.push(workspace);
    const cli = async (argv: string[]) => {
      const proc = Bun.spawn([process.execPath, MAIN, ...argv], {
        cwd: workspace,
        env: env(workspace),
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
    };
    const init = await cli(["init"]);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("wrote song.ts\n");

    const a = open(workspace, "A");
    await ready(a);
    // The session wins over the untouched init song: its tracks are printed.
    let trackFile = "";
    const readTrack = () => readFile(join(workspace, trackFile), "utf8");
    const deadline = Date.now() + 10_000;
    while (!trackFile && Date.now() < deadline) {
      const dirs = await readdir(join(workspace, "tracks")).catch(() => []);
      for (const dir of dirs) {
        const path = `tracks/${dir}/track.ts`;
        if (await readFile(join(workspace, path), "utf8").catch(() => "")) {
          trackFile = path;
          break;
        }
      }
      await Bun.sleep(50);
    }
    expect(trackFile).not.toBe("");
    await until(
      () => header(a).includes("types ✓"),
      "types indicator",
      () => a.vt.text(),
      15_000,
    );

    // An agent-free edit: append two notes to the printed track by hand.
    const printed = await readTrack();
    const authored = printed
      .replace(/^import \{ ([^}]*) \} from "dawg";/, (_, names: string) => {
        const set = new Set(names.split(", "));
        set.add("note");
        return `import { ${[...set].sort().join(", ")} } from "dawg";`;
      })
      .replace(
        /\n\}\);\n$/,
        `\n  notes: [note("E3", 2), note("G3", 3)],\n});\n`,
      );
    expect(authored).not.toBe(printed);
    const before = revision(a);
    await Bun.write(join(workspace, trackFile), authored);
    await until(
      () => revision(a) > before && a.vt.text().includes("applied from files"),
      "files applied in A",
      () => a.vt.text(),
      15_000,
    );

    // A TUI edit lands in the file; the hand-written notes stay.
    await edit(a, "add C4 at 0 for 1");
    let text = "";
    const reprintDeadline = Date.now() + 15_000;
    while (!text.includes('note("C4", 0)')) {
      if (Date.now() > reprintDeadline)
        throw new Error(`track file not reprinted\n${text}\n${a.vt.text()}`);
      await Bun.sleep(50);
      text = await readTrack();
    }
    expect(text).toContain('note("E3", 2)');
    expect(text).toContain('note("G3", 3)');

    const b = open(workspace, "B");
    await ready(b);
    await converged([a, b]);
    const check = await cli(["check"]);
    expect(check.stderr).toBe("");
    expect(check.code).toBe(0);
    expect(check.stdout).toMatch(/^ok · \d+ tracks?, 3 notes/);
    await close(b);
    await close(a);
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "samples: init, import_sample-shaped WAV, sampler() track, dawg render hits",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "dawg-sampler-"));
    workspaces.push(workspace);
    const cli = async (argv: string[]) => {
      const proc = Bun.spawn([process.execPath, MAIN, ...argv], {
        cwd: workspace,
        env: env(workspace),
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
    };
    expect((await cli(["init"])).code).toBe(0);
    // What media tools' import_sample writes: 48 kHz stereo PCM16.
    const frames = 4_800;
    const kick: number[] = [];
    for (let i = 0; i < frames; i += 1) {
      const v =
        Math.sin((2 * Math.PI * 60 * i) / 48_000) * Math.exp(-i / 1_500);
      kick.push(v * 0.9, v * 0.9);
    }
    await mkdir(join(workspace, "tracks/drums/samples"), { recursive: true });
    await writeFile(
      join(workspace, "tracks/drums/samples/kick.wav"),
      wavBytes(kick, { channels: 2, sampleRate: 48_000 }),
    );
    await writeFile(
      join(workspace, "tracks/drums/track.ts"),
      `import { track, sampler, hits } from "dawg";

export default track({
  name: "drums",
  instrument: sampler({ kick: "samples/kick.wav" }),
  notes: [...hits("kick", [0, 2])],
});
`,
    );
    await writeFile(
      join(workspace, "song.ts"),
      `import { song } from "dawg";
import drums from "./tracks/drums/track.ts";

export default song({ tempo: 120, meter: [4, 4], bars: 1, tracks: [drums] });
`,
    );
    const first = await cli(["render", "out.wav"]);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    const bytes = await readFile(join(workspace, "out.wav"));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rate = view.getUint32(24, true);
    const peak = (from: number, to: number) => {
      let max = 0;
      for (let f = Math.floor(from * rate); f < to * rate; f += 1)
        max = Math.max(max, Math.abs(view.getInt16(44 + f * 4, true)));
      return max;
    };
    // Hits on beats 0 and 2 at 120 BPM: 0 s and 1 s; silence between.
    expect(peak(0, 0.05)).toBeGreaterThan(2_000);
    expect(peak(1, 1.05)).toBeGreaterThan(2_000);
    expect(peak(0.3, 0.9)).toBe(0);
    expect(peak(1.3, 1.9)).toBe(0);
    // The decoded PCM is cached content-addressed; a second render is identical.
    const assets = await readdir(join(workspace, ".dawg/assets"));
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatch(/^[0-9a-f]{64}\.pcm$/);
    const second = await cli(["render", "again.wav"]);
    expect(second.code).toBe(0);
    expect(await readFile(join(workspace, "again.wav"))).toEqual(bytes);
  },
  30_000,
);

test("render --normalize masters to a loudness target; --measure reports it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dawg-loudness-"));
  workspaces.push(workspace);
  const notes = Array.from({ length: 8 }, (_, beat) => ({
    id: `n${beat}`,
    trackId: "bass",
    pitch: 45 + (beat % 3) * 4,
    startTick: beat * 480,
    durationTicks: 400,
    velocity: 0.7,
  }));
  await writeFile(
    join(workspace, "song.track.json"),
    JSON.stringify({
      format: "track.loop/v1",
      version: 1,
      tempoBpm: 128,
      beatsPerBar: 4,
      bars: 2,
      ticksPerBeat: 480,
      tracks: [{ id: "bass", name: "bass", instrument: "saw" }],
      notes,
    }),
  );
  const cli = async (argv: string[]) => {
    const proc = Bun.spawn([process.execPath, MAIN, ...argv], {
      cwd: workspace,
      env: env(workspace),
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
  };
  const plain = await cli([
    "render",
    "plain.wav",
    "--import",
    "song.track.json",
  ]);
  expect(plain.stderr).toBe("");
  expect(plain.code).toBe(0);
  // No master: no loudness line, and the export is the plain render.
  expect(plain.stdout).not.toContain("loudness");
  const measured = await cli([
    "render",
    "measured.wav",
    "--import",
    "song.track.json",
    "--measure",
  ]);
  expect(measured.code).toBe(0);
  expect(measured.stdout).toMatch(
    /loudness · -?\d+\.\d LUFS · momentary max -?\d+\.\d · short-term max/,
  );
  expect(await readFile(join(workspace, "measured.wav"))).toEqual(
    await readFile(join(workspace, "plain.wav")),
  );
  const club = await cli([
    "render",
    "club.wav",
    "--import",
    "song.track.json",
    "--normalize",
    "club",
  ]);
  expect(club.stderr).toBe("");
  const clubLine = club.stdout.match(
    /loudness · (-?\d+\.\d) LUFS · (-?\d+\.\d) dBTP · target -8\.0 reached/,
  );
  expect(clubLine).not.toBeNull();
  expect(Number(clubLine![1])).toBeCloseTo(-8, 0);
  expect(Number(clubLine![2])).toBeLessThanOrEqual(-0.9);
  // A mastered export is a deliverable: 48 kHz unless --rate says otherwise.
  const clubWav = await readFile(join(workspace, "club.wav"));
  expect(clubWav.readUInt32LE(24)).toBe(48_000);
  const quiet = await cli([
    "render",
    "quiet.wav",
    "--import",
    "song.track.json",
    "--normalize",
    "-23",
  ]);
  expect(quiet.stdout).toContain("-23.0 LUFS");
  const bad = await cli([
    "render",
    "bad.wav",
    "--import",
    "song.track.json",
    "--normalize",
    "loudest",
  ]);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain("--normalize takes LUFS");
}, 30_000);

test("--import of a non-loop file is a one-line error, not a stack trace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dawg-import-bad-"));
  workspaces.push(workspace);
  await writeFile(join(workspace, "out.mid"), "MThd\u0000\u0000\u0000\u0006");
  const proc = Bun.spawn(
    [process.execPath, MAIN, "--import", "out.mid", "--export", "rt.json"],
    {
      cwd: workspace,
      env: env(workspace),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(stderr).toContain("cannot import out.mid");
  expect(stderr).toContain("MIDI files are not imported");
  expect(stderr.trim().split("\n")).toHaveLength(1);
});
