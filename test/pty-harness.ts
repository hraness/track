/**
 * Shared PTY launcher for the play-mode and menu tests: the real `dawg`
 * binary in a Bun pseudo-terminal, rendered through test/vt.ts.
 */
import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VirtualTerminal } from "./vt.ts";

export const MAIN = resolve(import.meta.dir, "../src/main.ts");
export const supported =
  process.platform !== "win32" &&
  typeof (Bun as unknown as { Terminal?: unknown }).Terminal === "function";

const dirs: string[] = [];
// Outside `bun test` (an ad hoc driver script) afterAll throws: the caller
// owns cleanup there.
try {
  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
} catch {
  // not under the test runner
}

interface PtyTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * What the editor reports after each frame under `DAWG_STATE_OSC=1`
 * (src/main.ts): input bytes it has acted on, whether anything it started
 * still runs, and where it stands.
 */
export interface EditorState {
  in: number;
  busy: boolean;
  rev: number;
  track: string;
  screen: "home" | "tape" | "play" | "sound" | "menu" | "patch";
  overlay: string | null;
}

export async function launch(
  cols: number,
  rows: number,
  env: Record<string, string>,
  argv: string[] = ["--track", "bass"],
  dir?: string,
  /** Runtime flags before the script (`--preload <file>`). */
  bunArgs: string[] = [],
) {
  const cwd = dir ?? (await mkdtemp(join(tmpdir(), "dawg-pty-")));
  if (!dir) dirs.push(cwd);
  const vt = new VirtualTerminal(cols, rows);
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, ...bunArgs, MAIN, ...argv], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      DAWG_DAEMON: "0",
      DAWG_AUDIO: "0",
      // A configured (fake) provider: the agent prompt and NOW pill show,
      // and the first-run sign-in picker stays out of the way.
      AI_GATEWAY_API_KEY: "vck_ptytest0000000000000000",
      DAWG_CREDENTIAL_STORE: "file",
      DAWG_CONFIG_DIR: join(cwd, ".config", "dawg"),
      DAWG_STATE_OSC: "1",
      ...env,
    },
    terminal: {
      cols,
      rows,
      data(_terminal: unknown, data: Uint8Array) {
        vt.writeFrames(decoder.decode(data, { stream: true }));
      },
    },
  } as Parameters<typeof Bun.spawn>[1]);
  const pty = (proc as unknown as { terminal: PtyTerminal }).terminal;
  let state: EditorState | undefined;
  vt.onOsc = (code, text) => {
    if (code === 7799) state = JSON.parse(text) as EditorState;
  };
  // Every byte sent is counted, so `settle` knows what the editor still owes.
  let written = 0;
  const terminal: PtyTerminal = {
    write(data) {
      written += Buffer.byteLength(data);
      pty.write(data);
    },
    resize: (c, r) => pty.resize(c, r),
    close: () => pty.close(),
  };
  const until = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 5000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${label}\n${vt.text()}`);
      await Bun.sleep(20);
    }
  };
  const send = async (data: string) => {
    terminal.write(data);
    await Bun.sleep(60);
  };
  /**
   * Wait until the editor has acted on every byte sent so far and nothing it
   * started (a queued line, Ctrl-T, undo, a gesture's commands) still runs;
   * the frame on screen is then drawn from that settled state. Use it before
   * an assertion instead of a sleep or a text that can show up early.
   */
  const settle = async (label = "settled", timeoutMs = 15_000) => {
    const owed = written;
    await until(
      () => state !== undefined && state.in >= owed && !state.busy,
      `${label} (editor ${JSON.stringify(state)}, sent ${owed} bytes)`,
      timeoutMs,
    );
    return state!;
  };
  /** Send keys, then `settle`. */
  const type = async (data: string, label?: string) => {
    terminal.write(data);
    return settle(label ?? `after ${JSON.stringify(data)}`);
  };
  return {
    proc,
    terminal,
    vt,
    until,
    send,
    settle,
    type,
    state: () => state,
    cwd,
  };
}
