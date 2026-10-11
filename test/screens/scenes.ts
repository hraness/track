/**
 * The docs screens: each scene drives the real `dawg` to one moment and
 * captures it. `bun test/screens/capture.ts` writes them to docs/screens;
 * test/screens/screens.test.ts captures them again and fails when a
 * committed screen no longer matches the TUI.
 *
 * Scenes start from a seeded style (deterministic for a given seed) and
 * reach every state with keys and typed commands, as a person would.
 */
import { resolve } from "node:path";
import { sideBySide, Stage, type Pty, type ScreenFile } from "./driver.ts";
import { FakeGateway } from "./gateway.ts";

const FAKE_SINK = resolve(import.meta.dir, "../fake-sink-preload.ts");

export interface Scene {
  id: string;
  /** What the screen shows, for alt text and captions. */
  title: string;
  cols: number;
  rows: number;
  run(stage: Stage, size: { cols: number; rows: number }): Promise<ScreenFile>;
  /** Environment for this scene (NO_COLOR…). */
  env?: Record<string, string>;
  /** Extra preloads (the fake native sink). */
  preloads?: string[];
}

const ESC = "\u001b";
const CTRL = (letter: string) =>
  String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;

const has = (pty: Pty, needle: string | RegExp) => () =>
  typeof needle === "string"
    ? pty.vt.text().includes(needle)
    : needle.test(pty.vt.text());

/** dawg at the prompt, with a deep-house song written by `style`. */
async function song(
  stage: Stage,
  size: { cols: number; rows: number },
  argv: string[] = [],
  env: Record<string, string> = {},
): Promise<Pty> {
  const pty = stage.open(size.cols, size.rows, argv, env);
  await stage.until(has(pty, " NOW "), "prompt", pty);
  await stage.type(pty, "style deep-house 8 3\r");
  await stage.until(has(pty, "✓ deep-house"), "style", pty);
  // A name of our own: the auto-namer runs on a real-time timer, so its
  // receipt would land in some captures and not others.
  await stage.type(pty, "/rename night drive\r");
  await stage.until(has(pty, "night drive"), "renamed", pty);
  await stage.step(40, 50); // let the receipts settle
  return pty;
}

/** Plays from the top for `beats` beats at the song tempo. */
async function playFor(stage: Stage, pty: Pty, beats: number): Promise<void> {
  await stage.type(pty, " ", 4);
  // The header, not any ▶ on screen: TAPE and the highway draw ▶ too.
  await stage.until(has(pty, /▶ \d+ BPM/), "playing", pty);
  // 121 BPM: a beat is ~496 ms; 25 ms steps keep the highway smooth.
  await stage.step(Math.round((beats * 496) / 25), 25);
}

export const SCENES: Scene[] = [
  {
    id: "highway",
    title:
      "The highway: a deep-house song playing, notes streaming down to the hit line",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await playFor(stage, pty, 6);
      return stage.capture(pty, "highway");
    },
  },
  {
    id: "tape",
    title:
      "TAPE (Ctrl-T): every track across the bars, the loop, turning reels and ghost repeats of the form",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await stage.type(pty, "form build drop*2\r");
      await stage.until(has(pty, "✓ form"), "form", pty);
      await stage.type(pty, "loop 5-6\r");
      await stage.type(pty, CTRL("t"));
      await stage.until(has(pty, "range:"), "tape", pty);
      await playFor(stage, pty, 5);
      return stage.capture(pty, "tape");
    },
  },
  {
    id: "hero",
    title:
      "dawg playing a four-track deep-house song while the agent types its next command into the prompt",
    cols: 100,
    rows: 30,
    async run(stage, size) {
      const gateway = new FakeGateway();
      stage.onClose(() => gateway.stop());
      // The first chunk stops mid-command, so nothing is applied before the
      // capture: an edit landing mid-play re-anchors the transport at a
      // moment that depends on the runner's speed.
      const release = gateway.reply([
        "fx rev",
        "erb mix 0.4\ntempo 112\n",
        "Slower and wetter.",
      ]);
      const pty = await song(stage, size, ["--track", "chords"], gateway.env);
      await stage.type(pty, "loop 1-4\r");
      await playFor(stage, pty, 3);
      await stage.type(pty, "make it slower and wetter\r", 1);
      await stage.until(() => gateway.requests > 0, "request", pty);
      release();
      // Only the first chunk is out, so the prompt stops at "fx rev";
      // the typing runs on the clock, so a fixed number of steps lands on
      // the same keystroke every run.
      await Bun.sleep(400);
      await stage.step(40, 25);
      await stage.until(has(pty, "fx rev▏"), "show-me typing", pty);
      return stage.capture(pty, "hero");
    },
  },
  {
    id: "knobs",
    title:
      "Four knobs: the focused track's sound on four coloured, shaped knobs",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await stage.type(pty, "knobs\r");
      await stage.until(has(pty, "≡ Sound"), "knobs", pty);
      await stage.type(pty, RIGHT);
      await stage.type(pty, RIGHT);
      return stage.capture(pty, "knobs");
    },
  },
  {
    id: "mix",
    title: "The mixer: one volume and pan row per track",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await stage.type(pty, "mix\r");
      await stage.until(has(pty, "Mix › mixer"), "mixer", pty);
      return stage.capture(pty, "mix");
    },
  },
  {
    id: "play-mode",
    title: "Play mode (Ctrl-P): the computer keyboard is a piano",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "keys"]);
      await stage.type(pty, CTRL("p"));
      await stage.until(has(pty, /PLAY/), "play mode", pty);
      await stage.type(pty, "a");
      await stage.type(pty, "d");
      return stage.capture(pty, "play-mode");
    },
  },
  {
    id: "patch",
    title:
      "/patch: the acid-bass patch on the bass track, its nodes, ports, cables and four macro knobs",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await stage.type(pty, "patch load acid-bass\r");
      await stage.until(has(pty, "now plays patch acid-bass"), "loaded", pty);
      await stage.type(pty, "/patch\r");
      await stage.until(has(pty, "CABLES"), "patch view", pty);
      for (let i = 0; i < 5; i++) await stage.type(pty, DOWN);
      await stage.until(has(pty, "▸vcf"), "vcf selected", pty);
      return stage.capture(pty, "patch");
    },
  },
  {
    id: "menu",
    title: "The Ctrl-K menu: every edit reachable with keys alone",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await stage.type(pty, CTRL("k"));
      await stage.until(has(pty, "menu"), "menu", pty);
      await stage.type(pty, DOWN);
      return stage.capture(pty, "menu");
    },
  },
  {
    id: "audio",
    title: "Ctrl-K › Project › audio › output: pick where dawg plays",
    cols: 80,
    rows: 24,
    env: { DAWG_AUDIO: "1", DAWG_AUDIO_BACKEND: "native" },
    preloads: [FAKE_SINK],
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await stage.type(pty, "/menu audio\r");
      await stage.until(has(pty, "≡ Project › audio"), "audio", pty);
      await stage.type(pty, "\r");
      await stage.until(has(pty, "audio › output"), "outputs", pty);
      await stage.type(pty, DOWN);
      return stage.capture(pty, "audio");
    },
  },
  {
    id: "showme",
    title:
      "Show-me: the agent types commands into the prompt and each one lands as it streams",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const gateway = new FakeGateway();
      stage.onClose(() => gateway.stop());
      const release = gateway.reply([
        "tem",
        "po 112\nfx rev",
        "erb mix 0.4\n",
        "Slower and wetter: tempo 112, then more reverb.",
      ]);
      const pty = await song(stage, size, ["--track", "chords"], gateway.env);
      await stage.type(pty, "make it slower and wetter\r");
      await stage.until(() => gateway.requests > 0, "request", pty);
      release(2);
      await Bun.sleep(400);
      await stage.step(40, 25);
      await stage.until(has(pty, "fx rev▏"), "ghost", pty);
      await stage.until(has(pty, "112 BPM"), "tempo lands", pty);
      return stage.capture(pty, "showme");
    },
  },
  {
    id: "agent",
    title:
      "An agent turn's card: what changed, and the command to do it yourself",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const gateway = new FakeGateway();
      stage.onClose(() => gateway.stop());
      const release = gateway.reply([
        "tempo 112\nfx reverb mix 0.4\n",
        "Slower and wetter: tempo 112, then more reverb.",
      ]);
      const pty = await song(stage, size, ["--track", "chords"], gateway.env);
      await stage.type(pty, "make it slower and wetter\r");
      await stage.until(() => gateway.requests > 0, "request", pty);
      release(2);
      await Bun.sleep(400);
      await stage.step(80, 25);
      await stage.until(has(pty, "do it yourself"), "finish hint", pty);
      return stage.capture(pty, "agent");
    },
  },
  {
    id: "panes",
    title:
      "Panes: a second terminal on the same song, each pane with its letter",
    cols: 129,
    rows: 32,
    async run(stage, size) {
      const half = { cols: 64, rows: size.rows };
      const a = await song(stage, half, ["--track", "bass"], {
        DAWG_DAEMON: "1",
      });
      const b = stage.open(half.cols, half.rows, ["pane", "tape"], {
        DAWG_DAEMON: "1",
      });
      await stage.until(has(b, "range:"), "pane B tape", b);
      await stage.type(b, "3");
      await stage.step(200, 50);
      await stage.type(a, "pane\r");
      await stage.until(has(a, /pane/), "pane list", a);
      return sideBySide(
        "panes",
        await stage.capture(a, "a"),
        await stage.capture(b, "b"),
      );
    },
  },
  {
    id: "help",
    title: "/help: the start page and the ten topics",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await stage.type(pty, "/help\r");
      await stage.until(has(pty, "sound"), "help", pty);
      return stage.capture(pty, "help");
    },
  },
  {
    id: "guide",
    title: "/guide: the user guides inside dawg",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await stage.type(pty, "/guide tape\r");
      await stage.until(has(pty, "TAPE"), "guide", pty);
      return stage.capture(pty, "guide");
    },
  },
  {
    id: "keys",
    title: "The ? panel on TAPE: every key and the command it types",
    cols: 80,
    rows: 24,
    async run(stage, size) {
      const pty = await song(stage, size, ["--track", "bass"]);
      await stage.type(pty, CTRL("t"));
      await stage.until(has(pty, "range:"), "tape", pty);
      await stage.type(pty, "?");
      await stage.until(has(pty, "loop the section"), "keys", pty);
      return stage.capture(pty, "keys");
    },
  },
  {
    id: "too-small",
    title: "Below 60x16 dawg says so and keeps playing",
    cols: 50,
    rows: 14,
    async run(stage, size) {
      const pty = stage.open(size.cols, size.rows);
      await stage.until(has(pty, "too small"), "too small", pty);
      return stage.capture(pty, "too-small");
    },
  },
];

export function sceneById(id: string): Scene {
  const scene = SCENES.find((entry) => entry.id === id);
  if (!scene) throw new Error(`no scene ${id}`);
  return scene;
}

/** Runs one scene in a fresh workspace. */
export async function shoot(scene: Scene): Promise<ScreenFile> {
  const stage = new Stage(scene.env, scene.preloads);
  try {
    return await scene.run(stage, { cols: scene.cols, rows: scene.rows });
  } finally {
    await stage.close();
  }
}
