/**
 * TAPE end to end (op1-ux §6, §8.3): Ctrl-T opens every track across the
 * bars, each gesture echoes and runs its typed range command, the clipboard
 * survives in `.dawg`, the mouse sets the loop, and Esc goes home. Also a
 * multi-pane case: another pane recording on a track shows `C●` in the
 * TAPE gutter.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launch, MAIN, supported } from "./pty-harness.ts";
import { VirtualTerminal } from "./vt.ts";

type SessionScore = {
  bars: number;
  revision?: number;
  sections?: { name: string; startBar: number; bars: number }[];
  tracks: { id: string; muted?: boolean }[];
  notes: { trackId: string; startTick: number }[];
  loop?: { startBar: number; bars: number } | null;
  loopSection?: string | null;
};
type SessionEvent = { kind: string };

/** The newest composition record under `.dawg/`, with its events. */
async function session(
  cwd: string,
): Promise<{ score: SessionScore; events: SessionEvent[] } | undefined> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      () => [],
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".json")) found.push(path);
    }
  };
  await walk(join(cwd, ".dawg"));
  let best:
    | { revision: number; score: SessionScore; events: SessionEvent[] }
    | undefined;
  for (const path of found) {
    const text = await readFile(path, "utf8").catch(() => "{}");
    if (!text.includes('"composition"')) continue;
    const parsed = JSON.parse(text) as {
      revision?: number;
      composition?: SessionScore & { tracks?: unknown };
      events?: SessionEvent[];
    };
    if (!parsed.composition?.tracks) continue;
    const revision = parsed.revision ?? 0;
    if (!best || revision >= best.revision)
      best = {
        revision,
        score: parsed.composition,
        events: parsed.events ?? [],
      };
  }
  return best;
}

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  context: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}\n${context()}`);
}

/** SGR mouse: press and release at a 0-based cell. */
const click = (x: number, y: number) =>
  `\u001b[<0;${x + 1};${y + 1}M\u001b[<0;${x + 1};${y + 1}m`;

for (const [cols, rows] of [
  [80, 24],
  [120, 32],
] as const)
  test.skipIf(!supported)(
    `real PTY: TAPE gestures echo range commands at ${cols}x${rows}`,
    async () => {
      const t = await launch(cols, rows, cols === 80 ? {} : { NO_COLOR: "1" });
      try {
        await t.until(() => t.vt.text().includes(" NOW "), "prompt");
        await t.send("bars 8\r");
        await t.send("add C4 at 0\r");
        await t.send("add E4 at 4\r");
        await t.send("section verse 1-4\r");
        await t.send("section chorus 5-8\r");
        await t.send("track drums\r");
        await t.send("track bass\r");
        // Every queued line has run before Ctrl-T: the notes land before the
        // sections, and bass is focused from launch, so neither the session
        // file nor the header says the sections and `track bass` ran.
        await t.settle("seven lines applied");
        expect((await session(t.cwd))?.score.notes.length).toBe(2);
        expect(t.vt.lines()[0]).toMatch(/· bass\b/);

        // Ctrl-T: TAPE replaces the highway; the hint row teaches keys.
        await t.type("\u0014", "tape opened");
        await t.until(() => t.vt.text().includes("range: bass"), "tape");
        const text = t.vt.text();
        expect(text).toContain("▼");
        expect(text).toContain("verse");
        expect(text).toContain("›bass");
        expect(text).toContain("c copy");
        expect(text).toContain("playhead");

        // `\` loops the section under the playhead, again turns the loop
        // off, and a third time loops it back (each echoed as typed).
        expect(text).not.toContain("(loop)");
        const looped = async () => (await session(t.cwd))?.score.loopSection;
        await t.send("\\");
        await t.until(
          () => t.vt.text().includes("loop verse"),
          "echo: loop verse",
        );
        await waitFor(async () => (await looped()) === "verse", "verse loops");
        await t.until(() => t.vt.text().includes("(loop)"), "loop range");
        await t.send("\\");
        await t.until(() => t.vt.text().includes("loop off"), "echo: loop off");
        await waitFor(
          async () => !(await looped()),
          "loop off",
          () => t.vt.text(),
        );
        await t.until(
          () => !t.vt.text().includes("(loop)"),
          "range not looped",
        );
        await Bun.sleep(900); // let the previous echo fade
        await t.send("\\");
        await t.until(() => t.vt.text().includes("(loop)"), "loop range again");
        expect(t.vt.lines().some((line) => line.includes("]"))).toBe(true);

        // `c` copies the loop range and fills the clipboard chip.
        await t.send("c");
        await t.until(
          () => t.vt.text().includes("copy bass 1-4"),
          "echo: copy",
        );
        await t.until(
          () => t.vt.text().includes("clipboard: bass · 4 bars"),
          "clipboard chip",
          8000,
        );
        const clipDir = join(t.cwd, ".dawg", "clipboard");
        await waitFor(
          async () => (await readdir(clipDir)).length === 1,
          "clipboard file",
        );

        // `x` then `v` at the chorus: one move, the source bars empty.
        await t.send("x");
        await waitFor(
          async () => (await session(t.cwd))?.score.notes.length === 0,
          "cut clears",
          () => t.vt.text(),
        );
        await t.send(".");
        await t.until(() => t.vt.text().includes("jump chorus"), "echo: jump");
        await t.until(() => t.vt.text().includes("5.1"), "jump to the chorus");
        await t.send("v");
        await t.until(
          () => t.vt.text().includes("move bass 1-4 to 5"),
          "echo: the paste after a cut folds into a move",
        );
        await waitFor(
          async () => {
            const notes = (await session(t.cwd))?.score.notes ?? [];
            return (
              notes.length === 2 &&
              notes.every((note) => note.startTick >= 4 * 1920)
            );
          },
          "notes moved to bar 5",
          () => t.vt.text(),
        );

        // Number keys pick tracks on TAPE; `?` lists the TAPE keys.
        await t.send("?");
        await t.until(
          () => t.vt.text().includes("tape · every track"),
          "tape keys",
        );
        await t.send("\u001b");
        await t.until(
          () => !t.vt.text().includes("tape · every track"),
          "keys closed",
        );

        // A drag on the ruler sets the loop over the dragged bars.
        const rulerY = t.vt
          .lines()
          .findIndex((line) => line.startsWith(" bar"));
        expect(rulerY).toBeGreaterThan(0);
        const left = 9; // TAPE_GUTTER
        const cellsPerBar = 4; // beat zoom in 4/4
        const at = (bar: number) => left + bar * cellsPerBar;
        t.terminal.write(`\u001b[<0;${at(1) + 1};${rulerY + 1}M`);
        await Bun.sleep(40);
        t.terminal.write(`\u001b[<32;${at(2) + 1};${rulerY + 1}M`);
        await Bun.sleep(40);
        t.terminal.write(`\u001b[<0;${at(2) + 1};${rulerY + 1}m`);
        await t.until(
          () => t.vt.text().includes("loop 2-3"),
          "echo: drag loop",
        );
        await waitFor(
          async () => {
            const loop = (await session(t.cwd))?.score.loop;
            return loop?.startBar === 1 && loop.bars === 2;
          },
          "loop 2-3 from the drag",
          () => t.vt.text(),
        );

        // A click on a row focuses that track (echoed as `track …`).
        const rowY = t.vt.lines().findIndex((line) => /^ \d.drums/.test(line));
        expect(rowY).toBeGreaterThan(0);
        await t.send(click(20, rowY));
        await t.until(() => t.vt.text().includes("›drums"), "row focus");

        // Esc goes home: the highway is back, TAPE is gone.
        await t.send("\u001b");
        await t.until(() => !t.vt.text().includes("range: "), "home");
        expect(t.vt.text()).not.toContain("c copy · x cut");
      } finally {
        t.proc.kill();
      }
    },
    60_000,
  );

// Colour and NO_COLOR: the ghost is a glyph, never only a dim colour.
for (const env of [{}, { NO_COLOR: "1" }] as Record<string, string>[])
  test.skipIf(!supported)(
    `real PTY: a form draws unrolled, repeats ghosted ░${"NO_COLOR" in env ? " (NO_COLOR)" : ""}`,
    async () => {
      const t = await launch(80, 24, env);
      try {
        await t.until(() => t.vt.text().includes(" NOW "), "prompt");
        await t.send("bars 8\r");
        await t.send("add C4 at 16\r");
        await t.send("section verse 1-4\r");
        await t.send("section chorus 5-8\r");
        await t.send("form verse chorus*2\r");
        // "chorus" is on screen from the section line already: wait for the
        // queued lines to run, not for a word.
        await t.settle("form set");
        await t.type("\u0014", "tape opened");
        await t.until(() => t.vt.text().includes("range: "), "tape");
        const ghost = "░";
        const sect = () =>
          t.vt.lines().find((line) => line.startsWith(" sect")) ?? "";
        await t.until(() => sect().includes("chorus ×2"), "pass label");
        expect(sect()).toContain(`${ghost}chorus`);
        // At the chorus the range line says an edit lands on both passes.
        await t.send(".");
        await t.until(
          () => t.vt.text().includes("edits chorus (plays 2×)"),
          "edits chorus (plays 2×)",
        );
      } finally {
        t.proc.kill();
      }
    },
    60_000,
  );

test.skipIf(!supported)(
  "real PTY: TAPE tiles, inserts, splits, picks, mutes and undoes",
  async () => {
    const t = await launch(80, 24, {});
    const now = async () => (await session(t.cwd))!.score;
    const bassNotes = async () =>
      (await now()).notes
        .filter((note) => note.trackId === "bass")
        .map((note) => note.startTick / 1920)
        .sort((a, b) => a - b);
    try {
      await t.until(() => t.vt.text().includes(" NOW "), "prompt");
      for (const line of [
        "bars 8",
        "track drums",
        "track bass",
        "add C4 at 0",
        "section verse 1-4",
      ])
        await t.send(`${line}\r`);
      // `section verse` runs after the note: wait for the whole queue.
      await t.settle("five lines applied");
      expect(await bassNotes()).toEqual([0]);
      await t.type("\u0014", "tape opened");
      await t.until(() => t.vt.text().includes("range: bass"), "tape");

      // Loop the verse, shrink it to one bar with `[`, and copy it.
      await t.send("\\");
      await t.until(() => t.vt.text().includes("(loop)"), "loop");
      for (let i = 0; i < 3; i += 1) {
        await t.send("[");
        await Bun.sleep(150);
      }
      await t.until(
        () =>
          t.vt.text().includes("bars 1 (loop)") ||
          t.vt.text().includes("bar 1 (loop)"),
        "one-bar loop",
      );
      await t.send("c");
      await t.until(
        () => t.vt.text().includes("clipboard: bass · 1 bar"),
        "chip",
      );

      // `v v` tiles: each paste lands after the last one.
      await t.send("\\"); // loop off, so the range is the bar under the head
      await t.until(() => !t.vt.text().includes("(loop)"), "loop off");
      await t.send("1"); // bass is the first row (already focused)
      // shift-→ turns the playhead knob a bar: `jump 2`.
      await t.send("\u001b[1;2C");
      await t.until(() => t.vt.text().includes("jump 2"), "echo: jump 2");
      await t.until(() => /playhead 2\.1/.test(t.vt.text()), "at bar 2");
      // Back to back, as a person types: the second `v` lands past the
      // first even before its `jump` has run.
      await t.send("v");
      await t.send("v");
      await waitFor(
        async () => (await bassNotes()).join() === "0,1,2",
        "v v tiles bars 2 and 3",
        () => t.vt.text(),
      );

      // ctrl-z undoes one gesture: the last tile only.
      await t.send("\u001a");
      await waitFor(
        async () => (await bassNotes()).join() === "0,1",
        "undo one tile",
        () => t.vt.text(),
      );

      // `V` inserts: bars after the playhead slide right.
      await t.send("V");
      await t.until(() => t.vt.text().includes(" insert"), "echo: insert");
      await waitFor(
        async () => (await now()).bars === 9,
        "insert grows the song",
        () => t.vt.text(),
      );

      // `s` splits the section under the playhead; `S` joins it back.
      // The paste's own `jump` past the insert may still be queued, so `,`
      // repeats until the playhead sits at the verse's start (a `,` there
      // is a no-op note).
      const atStart = () => /playhead 1\.1/.test(t.vt.text());
      for (let i = 0; i < 20 && !atStart(); i += 1) {
        await t.send(",");
        await Bun.sleep(250);
      }
      await t.until(() => t.vt.text().includes("jump verse"), "echo: jump");
      await t.until(atStart, "at bar 1");
      await t.send("\u001b[1;2C");
      await t.until(() => /playhead 2\.1/.test(t.vt.text()), "at bar 2 again");
      await t.send("s");
      await t.until(
        () => t.vt.text().includes("section split verse"),
        "echo: split",
      );
      await waitFor(
        async () => ((await now()).sections ?? []).length === 2,
        "two sections",
        () => t.vt.text(),
      );
      await t.send("S");
      await waitFor(
        async () => ((await now()).sections ?? []).length === 1,
        "joined",
        () => t.vt.text(),
      );

      // `2` picks drums; `h` mutes it (echoed `mute drums`).
      await t.send("2");
      await t.until(() => t.vt.text().includes("›drums"), "drums focused");
      await t.send("h");
      await t.until(() => t.vt.text().includes("mute drums"), "echo: mute");
      await waitFor(
        async () =>
          (await now()).tracks.find((track) => track.id === "drums")?.muted ===
          true,
        "drums muted",
      );
      await t.send("1");
      await t.until(() => t.vt.text().includes("›bass"), "1 focuses bass");
    } finally {
      t.proc.kill();
    }
  },
  60_000,
);

// --- Multi-pane: the TAPE gutter marks other panes (§12.7). ---------------

const workspaces: string[] = [];
type Pane = {
  proc: ReturnType<typeof Bun.spawn>;
  terminal: { write(data: string): void; close(): void };
  vt: VirtualTerminal;
};
const panes: Pane[] = [];

afterAll(async () => {
  for (const p of panes) {
    p.proc.kill("SIGKILL");
    p.terminal.close();
  }
  // Pane daemons: kill any left by a failed run before removing the dir.
  for (const dir of workspaces) {
    const sessions = join(dir, ".dawg", "sessions");
    for (const name of await readdir(sessions).catch(() => [] as string[])) {
      if (!name.endsWith(".daemon.lock")) continue;
      try {
        const owner = JSON.parse(
          await readFile(join(sessions, name, "owner"), "utf8"),
        ) as { pid?: unknown };
        if (typeof owner.pid === "number") process.kill(owner.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

function openPane(dir: string, argv: string[]): Pane {
  const cols = 100;
  const rows = 28;
  const vt = new VirtualTerminal(cols, rows);
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, MAIN, ...argv], {
    cwd: dir,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dir,
      TERM: "xterm-256color",
      NO_COLOR: "1",
      DAWG_AUDIO: "0",
      DAWG_AI: "0",
      DAWG_PROVIDER: "gateway",
      DAWG_CREDENTIAL_STORE: "file",
      DAWG_CONFIG_DIR: join(dir, ".config"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
    terminal: {
      cols,
      rows,
      data(_terminal: unknown, data: Uint8Array) {
        vt.writeFrames(decoder.decode(data, { stream: true }));
      },
    },
  } as Parameters<typeof Bun.spawn>[1]);
  const pane = {
    proc,
    terminal: (proc as unknown as { terminal: Pane["terminal"] }).terminal,
    vt,
  };
  panes.push(pane);
  return pane;
}

async function until(
  predicate: () => boolean,
  label: string,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}\n${context()}`);
    await Bun.sleep(25);
  }
}

test.skipIf(!supported)(
  "real PTY panes: a recording pane shows C● in the TAPE gutter",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawg-tape-panes-"));
    workspaces.push(dir);
    const a = openPane(dir, ["--new", "--track", "bass"]);
    await until(
      () => /rev \d+/.test(a.vt.lines()[0] ?? ""),
      "A ready",
      () => a.vt.text(),
    );
    a.terminal.write("pattern kick every 1\r");
    await Bun.sleep(100);
    a.terminal.write("track bass\r");
    await Bun.sleep(100);
    const b = openPane(dir, ["pane", "home", "bass"]);
    await until(
      () => /rev \d+/.test(b.vt.lines()[0] ?? ""),
      "B ready",
      () => b.vt.text(),
    );
    const c = openPane(dir, ["pane", "play", "drums"]);
    await until(
      () => c.vt.text().includes("PLAY"),
      "C in play mode",
      () => c.vt.text(),
    );
    const both = () => `--- A\n${a.vt.text()}\n--- C\n${c.vt.text()}`;

    // A on TAPE: B sits on bass, C on drums.
    a.terminal.write("\u0014");
    await until(() => a.vt.text().includes("range: "), "A on tape", both);
    const row = (name: string) =>
      a.vt.lines().find((line) => new RegExp(`^ \\d.${name}`).test(line)) ?? "";
    await until(
      () => /\sB\s*$/.test(row("bass")) && /\sC\s*$/.test(row("drums")),
      "pane letters in the gutter",
      () => a.vt.text(),
    );

    // C records: its letter gains the red dot (`●`, kept under NO_COLOR).
    c.terminal.write("r");
    await until(() => c.vt.text().includes("rec armed"), "C armed", both);
    c.terminal.write(" ");
    await until(() => c.vt.text().includes("REC"), "C recording", both);
    await until(() => /\sC●\s*$/.test(row("drums")), "C● on drums", both);
    c.terminal.write(" ");
    await until(
      () => !/C●/.test(row("drums")),
      "C● clears after the take",
      both,
    );

    for (const p of [a, b, c]) {
      p.terminal.write("\u0003");
      await Promise.race([p.proc.exited, Bun.sleep(5_000)]);
    }
  },
  90_000,
);
