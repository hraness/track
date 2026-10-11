/**
 * The terminal-size matrix: every screen and overlay of the real `dawg`
 * binary in a PTY, resized through a list of sizes. Each scenario launches
 * once at a comfortable size, opens its screen, then walks the sizes; at
 * every size it checks what a person would see:
 *
 * - the process is alive (a throw in a frame exits the editor);
 * - no row ran past the last column (no wrap) and nothing scrolled;
 * - a header and a bottom row are drawn, or the too-small screen is;
 * - the screen is still the one that was open (its marker is visible) and
 *   its focus mark shows, at sizes at or above the minimum;
 * - frame times (compose + encode, from `DAWG_FRAME_LOG`).
 *
 * `test/sizes.test.ts` runs a sample in `bun run check`; `bun run sizes`
 * runs the full matrix and writes notes (bench/sizes/matrix.ts).
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_HEIGHT, MIN_WIDTH, TEXT_MEASURE } from "../tui/app.ts";
import { launch } from "./pty-harness.ts";

export type Size = readonly [cols: number, rows: number];

export const FULL_SIZES: readonly Size[] = [
  [20, 6],
  [40, 12],
  [60, 18],
  [80, 24],
  [100, 30],
  [120, 40],
  [200, 60],
  [300, 100],
  [500, 150],
  [300, 20],
  [40, 80],
];

/** The sample `bun run check` walks (test/sizes.test.ts). */
/**
 * The most a steady frame (compose plus encode) may take at any size, up
 * to 500x150: half the 33 ms frame interval, so the audio and
 * input threads keep headroom. `bun run sizes` flags a size over it.
 */
export const FRAME_BUDGET_MS = 16;

export const CHECK_SIZES: readonly Size[] = [
  [20, 6],
  [60, 16],
  [80, 24],
  [300, 20],
  [40, 80],
  [500, 150],
  [1, 1],
  [80, 24],
];
export const CHECK_SCENARIOS = [
  "home-playing",
  "play-mode",
  "play-drums",
  "tape",
  "patch",
  "drawer-knobs",
  "menu-depth",
  "help",
  "history",
  "showme-stream",
];

export type Pty = Awaited<ReturnType<typeof launch>>;

export interface Scenario {
  name: string;
  env?: Record<string, string>;
  argv?: string[];
  /** Opens the screen from a fresh editor at the launch size. */
  open(t: Pty): Promise<void>;
  /** The screen is still open (checked at usable sizes). */
  marker(text: string): boolean;
  /** Focus is visible: a selected row, a knob, the prompt cursor. */
  focus?(t: Pty): boolean;
  /** Ongoing animation (playing): settle by time, not by quiet. */
  animating?: boolean;
  /** Talks to the fake streaming gateway (`agentEnv`). */
  agent?: boolean;
}

export const ESC = "\u001b";
const UP = `${ESC}[A`;

/** Any cell drawn in reverse video or the prompt cursor shown. */
export function focusShown(t: Pty): boolean {
  if (t.vt.cursorVisible) return true;
  return t.vt.cells.some((row) => row.some((cell) => cell.style.reverse));
}

/** Play mode's 18 note keys, each a cap of its own under the header. */
const PLAY_KEYS = "AWSEDFTGYHUJKOLP;'";

function everyPlayKey(text: string): boolean {
  const top = text.split("\n").slice(1, 8).join("\n");
  return [...PLAY_KEYS].every((letter) =>
    new RegExp(
      `(?<=^| )${letter.replace(/[;']/g, "\\$&")}[•*]?(?= |$)`,
      "m",
    ).test(top),
  );
}

async function ready(t: Pty): Promise<void> {
  await t.until(() => t.vt.text().includes(" NOW "), "prompt", 15_000);
  await t.settle("editor idle at launch");
}

async function seed(t: Pty): Promise<void> {
  await t.send("bars 8\r");
  await t.send("add C4 at 0 for 1\r");
  await t.send("add E4 at 4 for 1\r");
  await t.send("section verse 1-4\r");
  await t.send("section chorus 5-8\r");
  await t.send("track drums\r");
  await t.send("instrument kit\r");
  await t.send("hit kick at 0\r");
  await t.send("track bass\r");
  // Lines typed faster than they run queue up: wait for all nine, so the
  // scenario opens on bass rather than wherever the queue had got to.
  await t.settle("seed applied");
}

/**
 * A fake streaming gateway for the agent scenarios: every request gets the
 * same reply, streamed a chunk every `gapMs`, so a resize lands mid-stream.
 */
let gateway: { origin: string; stop(): void } | undefined;
const REPLY = [
  "tem",
  "po 96\nfx rev",
  "erb mix 0.4\nadd C4 at 0 for 1\nadd E4 at 1 for 1\n",
  "add G4 at 2 for 1\nvolume 0.7\npan -0.2\n",
  "Slower and wetter, with a rising line: type tempo 96, then fx reverb mix 0.4. ",
  "The pad sits under the bass; pan it left so the hats have room on the right, ",
  "and try volume 0.7 if it masks the kick when the chorus opens up.",
];
export function agentEnv(gapMs = 250): Record<string, string> {
  if (!gateway) {
    const encoder = new TextEncoder();
    const chunk = (content: string) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/chat/completions"))
          return new Response("nope", { status: 404 });
        let sent = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await Bun.sleep(gapMs);
              if (sent >= REPLY.length) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
                  ),
                );
                controller.close();
                return;
              }
              controller.enqueue(encoder.encode(chunk(REPLY[sent++]!)));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    gateway = {
      origin: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  }
  return {
    AI_GATEWAY_BASE_URL: `${gateway.origin}/v1`,
    DAWG_MODELS_DEV_URL: `${gateway.origin}/api.json`,
  };
}
export function stopGateway(): void {
  gateway?.stop();
  gateway = undefined;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "home",
    async open(t) {
      await ready(t);
      await seed(t);
    },
    marker: (text) => text.includes(" NOW "),
    focus: (t) => t.vt.cursorVisible,
  },
  {
    name: "home-playing",
    animating: true,
    async open(t) {
      await ready(t);
      await seed(t);
      await t.send(" ");
      await t.until(() => t.vt.lines()[0]!.includes("▶"), "playing");
    },
    marker: (text) => text.includes(" NOW "),
    focus: (t) => t.vt.cursorVisible,
  },
  {
    name: "tape",
    async open(t) {
      await ready(t);
      await seed(t);
      await t.type("\u0014", "tape opened");
      await t.until(() => t.vt.text().includes("range: "), "tape");
    },
    marker: (text) => text.includes("range: "),
    focus: focusShown,
  },
  {
    name: "patch",
    async open(t) {
      await ready(t);
      await seed(t);
      await t.type("/patch\r", "patch view opened");
      await t.until(() => t.vt.text().includes("patch bass"), "patch view");
    },
    // The header names the track; at any usable size it is the first row.
    marker: (text) => text.includes("patch bass"),
    focus: focusShown,
  },
  {
    name: "play-mode",
    async open(t) {
      await ready(t);
      await t.send("\u0010");
      await t.until(() => t.vt.text().includes("PLAY"), "play header");
    },
    // The on-screen keyboard keeps every note key at every usable size.
    marker: (text) => text.includes("PLAY") && everyPlayKey(text),
  },
  {
    name: "play-drums",
    async open(t) {
      await ready(t);
      await t.send("instrument kit\r");
      await t.settle("kit");
      await t.send("\u0010");
      await t.until(() => t.vt.text().includes("PLAY"), "play header");
    },
    argv: ["--track", "drums"],
    marker: (text) =>
      text.includes("PLAY") && everyPlayKey(text) && /\bkick\b/.test(text),
  },
  {
    name: "play-keys",
    async open(t) {
      await ready(t);
      await t.send("\u0010");
      await t.until(() => t.vt.text().includes("PLAY"), "play header");
      await t.send("?");
      await t.until(() => /esc|close/.test(t.vt.text()), "keys sheet");
    },
    marker: (text) => text.includes("PLAY"),
  },
  {
    name: "drawer-knobs",
    async open(t) {
      await ready(t);
      await t.send("volume\r");
      await t.until(() => t.vt.text().includes("›volume"), "knob page");
      await t.send(UP);
    },
    marker: (text) => text.includes("pan") && text.includes("cutoff"),
    focus: (t) => t.vt.text().includes("›"),
  },
  {
    name: "drawer-all",
    async open(t) {
      await ready(t);
      await t.send("volume\r");
      await t.until(() => t.vt.text().includes("›volume"), "knob page");
      await t.send("\t");
      await t.until(() => t.vt.text().includes("tab knobs"), "all params");
    },
    marker: (text) => text.includes("pan"),
    focus: (t) => t.vt.text().includes("›"),
  },
  {
    name: "mix",
    async open(t) {
      await ready(t);
      await seed(t);
      await t.send("mix\r");
      await t.until(() => t.vt.text().includes("mixer"), "mixer");
    },
    marker: (text) => text.includes("mix"),
    focus: (t) => t.vt.text().includes("›"),
  },
  {
    name: "menu-depth",
    async open(t) {
      await ready(t);
      await t.send("\u000b");
      await t.until(() => t.vt.text().includes("Project"), "menu root");
      await t.send("/mix");
      await t.send("\r");
      await t.until(() => t.vt.text().includes("≡ Mix"), "mix");
      await t.send("/master");
      await t.send("\r");
      await t.until(() => t.vt.text().includes("master"), "master");
      await t.send("/glue");
      await t.send("\r");
      await t.until(() => t.vt.text().includes("glue"), "glue");
    },
    marker: (text) => text.includes("glue"),
    focus: focusShown,
  },
  {
    name: "help",
    async open(t) {
      await ready(t);
      await t.send("/help all\r");
      await t.until(() => t.vt.text().includes("help"), "help");
    },
    marker: (text) => text.includes("help"),
  },
  {
    // The /history picker (src/history/wire.ts): an edit and a comment.
    name: "history",
    async open(t) {
      await ready(t);
      await t.send("add C4 at 1\r");
      await t.send("/comment love this bass line #love\r");
      await t.send("/history\r");
      await t.until(() => t.vt.text().includes("history ·"), "history");
    },
    marker: (text) => text.includes("history"),
    focus: focusShown,
  },
  {
    name: "guide",
    async open(t) {
      await ready(t);
      await t.send("/guide voice\r");
      await t.until(() => t.vt.text().includes("Ask"), "guide page");
    },
    marker: (text) => /guide|Ask|Voice/.test(text),
  },
  {
    name: "guide-tree",
    async open(t) {
      await ready(t);
      await t.send("/guide\r");
      await t.until(() => t.vt.text().includes("Getting started"), "tree");
    },
    marker: (text) => /guide|Getting/.test(text),
    focus: focusShown,
  },
  {
    name: "euclid",
    async open(t) {
      await ready(t);
      await t.send("/track drums\r");
      await t.send("instrument kit\r");
      await t.send("/euclid\r");
      await t.until(() => t.vt.text().includes("rhythm ›"), "editor");
    },
    marker: (text) => text.includes("rhythm"),
    focus: focusShown,
  },
  {
    name: "audio-menu",
    async open(t) {
      await ready(t);
      await t.send("/menu project\r");
      await t.until(() => t.vt.text().includes("≡ Project"), "Project");
      await t.send("/audio");
      await t.send("\r");
      await t.until(() => t.vt.text().includes("audio"), "audio");
    },
    marker: (text) => text.includes("audio"),
    focus: focusShown,
  },
  {
    name: "transcript",
    async open(t) {
      await ready(t);
      await seed(t);
      await t.send("\u000f");
      await t.until(() => t.vt.text().includes("transcript"), "transcript");
    },
    marker: (text) => text.includes("transcript"),
  },
  {
    name: "showme-stream",
    agent: true,
    animating: true,
    async open(t) {
      await ready(t);
      await t.send("make it slower and wetter\r");
      await t.until(() => t.vt.text().includes("▏"), "ghost text", 10_000);
    },
    // The stream runs through the walk; whatever phase it is in, the prompt
    // or an agent card shows.
    marker: (text) => text.includes("NOW") || text.includes("NEXT"),
  },
  {
    name: "agent-cards",
    agent: true,
    async open(t) {
      await ready(t);
      await t.send("make it slower and wetter\r");
      await t.until(
        () => t.vt.text().includes("◆ 96 BPM"),
        "agent card",
        15_000,
      );
    },
    marker: (text) => text.includes("NOW"),
  },
  {
    // One pane on a session daemon: the header's sync mark (`● synced`).
    name: "panes-header",
    env: { DAWG_DAEMON: "1", DAWG_AI: "0" },
    argv: ["--new", "--track", "bass"],
    async open(t) {
      await t.until(
        () => (t.vt.lines()[0] ?? "").includes("synced"),
        "synced header",
        15_000,
      );
    },
    marker: (text) => text.includes("BPM"),
  },
  {
    name: "first-run",
    env: { AI_GATEWAY_API_KEY: "" },
    async open(t) {
      await t.until(
        () => t.vt.text().includes("model key"),
        "first-run card",
        15_000,
      );
    },
    marker: (text) => text.includes("model key") || text.includes("dawg"),
    focus: (t) => t.vt.cursorVisible,
  },
];

export interface SizeResult {
  scenario: string;
  size: Size;
  alive: boolean;
  wraps: number;
  scrolls: number;
  tooSmall: boolean;
  header: boolean;
  footer: boolean;
  marker: boolean;
  focus: boolean | undefined;
  /** Rows whose last cell is a letter or digit: possibly clipped words. */
  edgeRows: number;
  /** Frame compose+encode times at this size, ms. */
  frameMs: number[];
  frameBytes: number[];
  screen: string;
  problems: string[];
}

function usable(size: Size): boolean {
  return size[0] >= MIN_WIDTH && size[1] >= MIN_HEIGHT;
}

async function frameLog(path: string): Promise<string[]> {
  return (await readFile(path, "utf8").catch(() => "")).split("\n");
}

/** Resize and wait for the full repaint plus a short quiet period. */
async function resizeTo(t: Pty, size: Size, animating: boolean): Promise<void> {
  const clears = t.vt.clears;
  t.vt.resize(Math.max(1, size[0]), Math.max(1, size[1]));
  t.terminal.resize(size[0], size[1]);
  const deadline = Date.now() + 3000;
  while (t.vt.clears === clears && Date.now() < deadline) await Bun.sleep(10);
  if (animating) {
    await Bun.sleep(400);
    return;
  }
  let bytes = t.vt.bytes;
  let quietSince = Date.now();
  while (Date.now() - quietSince < 120 && Date.now() < deadline + 2000) {
    await Bun.sleep(20);
    if (t.vt.bytes !== bytes) {
      bytes = t.vt.bytes;
      quietSince = Date.now();
    }
  }
}

export function checkScreen(
  t: Pty,
  scenario: Scenario,
  size: Size,
): Omit<SizeResult, "frameMs" | "frameBytes" | "wraps" | "scrolls"> {
  const lines = t.vt.lines();
  const text = lines.join("\n");
  const tooSmall = /too small/.test(text);
  const alive = t.proc.exitCode === null;
  const header = (lines[0] ?? "").trim().length > 0;
  const footer = (lines[size[1] - 1] ?? "").trim().length > 0;
  const big = usable(size);
  const marker = scenario.marker(text);
  const focus = scenario.focus?.(t);
  const edgeRows = t.vt.cells.filter((row) => {
    const last = row[row.length - 1]?.ch ?? " ";
    const before = row[row.length - 2]?.ch ?? " ";
    return /[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(before);
  }).length;
  const problems: string[] = [];
  if (!alive) problems.push(`exited ${t.proc.exitCode}`);
  if (big && tooSmall) problems.push("too-small screen at a usable size");
  // Wide enough for the words: below the minimum the notice must show.
  if (!big && size[0] >= 20 && size[1] >= 3 && !tooSmall)
    problems.push("no too-small screen below the minimum");
  if (big && !tooSmall) {
    if (!header) problems.push("no header");
    if (!footer) problems.push("no bottom row");
    if (!marker) problems.push("screen lost");
    if (focus === false) problems.push("focus not visible");
    // A text panel (inset two columns: help, guides, menus, the transcript)
    // holds its reading measure however wide the terminal.
    for (const line of lines) {
      const top = /^ {2}╭─.*╮/.exec(line);
      if (top && top[0].length - 2 > TEXT_MEASURE + 4) {
        problems.push(`text panel ${top[0].length - 2} wide`);
        break;
      }
    }
  }
  return {
    scenario: scenario.name,
    size,
    alive,
    tooSmall,
    header,
    footer,
    marker,
    focus,
    edgeRows,
    screen: text,
    problems,
  };
}

/** Run one scenario through `sizes`; resolves every size's result. */
export async function runScenario(
  scenario: Scenario,
  sizes: readonly Size[],
  launchSize: Size = [100, 30],
): Promise<SizeResult[]> {
  const cwd = await mkdtemp(join(tmpdir(), "dawg-sizes-"));
  const log = join(cwd, "frames.log");
  const t = await launch(
    launchSize[0],
    launchSize[1],
    {
      DAWG_FRAME_LOG: log,
      ...(scenario.agent ? agentEnv() : {}),
      ...scenario.env,
    },
    scenario.argv ?? ["--track", "bass"],
    cwd,
  );
  const results: SizeResult[] = [];
  try {
    await scenario.open(t);
    await Bun.sleep(150);
    for (const size of sizes) {
      const before = (await frameLog(log)).length;
      await resizeTo(t, size, scenario.animating === true);
      const frames = (await frameLog(log))
        .slice(Math.max(0, before - 1))
        .filter((line) => line.startsWith(`${size[0]}x${size[1]} `))
        .map((line) => line.split(" "));
      // A big frame lands in several PTY chunks, the cursor hidden until
      // the last one: give focus a moment to settle before judging it.
      if (scenario.focus) {
        const deadline = Date.now() + 1000;
        while (!scenario.focus(t) && Date.now() < deadline) await Bun.sleep(10);
      }
      const checked = checkScreen(t, scenario, size);
      const result: SizeResult = {
        ...checked,
        // A frame already in flight at the old size can wrap; the full
        // repaint at the new size clears it. Count what follows the clear.
        wraps: t.vt.wrapsSinceClear,
        scrolls: t.vt.scrollsSinceClear,
        frameMs: frames.map((parts) => Number(parts[1])),
        frameBytes: frames.map((parts) => Number(parts[2])),
      };
      if (result.wraps)
        result.problems.push(`${result.wraps} wraps (${t.vt.lastWrap})`);
      if (result.scrolls) result.problems.push(`${result.scrolls} scrolls`);
      if (frames.length === 0 && result.alive)
        result.problems.push("no frame at this size");
      results.push(result);
      if (!result.alive) break;
    }
  } finally {
    t.terminal.write("\u0003");
    await Promise.race([t.proc.exited, Bun.sleep(3000)]);
    t.proc.kill();
    t.terminal.close();
    await killDaemons(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
  return results;
}

/** A scenario that started a session daemon leaves none behind. */
async function killDaemons(cwd: string): Promise<void> {
  const dir = join(cwd, ".dawg", "sessions");
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith(".daemon.lock"))) {
    try {
      const owner = JSON.parse(
        await readFile(join(dir, name, "owner"), "utf8"),
      ) as { pid?: unknown };
      if (typeof owner.pid === "number") process.kill(owner.pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
}
