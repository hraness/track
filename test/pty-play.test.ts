/**
 * Play mode end to end: Ctrl-P enters, keys record into the focused track
 * through the session, Esc leaves and normal typing works again.
 */
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, supported } from "./pty-harness.ts";

/** Every note in the newest session record under `.dawg/`. */
async function sessionNotes(
  cwd: string,
): Promise<{ trackId: string; pitch: number; startTick: number }[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    // Lock directories and presence files can vanish mid-walk.
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      () => [],
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".json")) found.push(path);
    }
  };
  await walk(join(cwd, ".dawg"));
  for (const path of found) {
    const text = await readFile(path, "utf8").catch(() => "{}");
    if (!text.includes('"composition"')) continue;
    const parsed = JSON.parse(text) as {
      composition?: {
        notes?: { trackId: string; pitch: number; startTick: number }[];
      };
    };
    if (parsed.composition?.notes) return parsed.composition.notes;
  }
  return [];
}

test.skipIf(!supported)(
  "real PTY: play mode header, record a pass, leave with Esc",
  async () => {
    const t = await launch(100, 28, {});
    try {
      await t.until(() => t.vt.text().includes(" NOW "), "prompt");
      await t.send("/count-in 0\r");
      await t.until(
        () => t.vt.text().includes("count-in · 0 bars"),
        "count-in",
      );

      await t.send("\u0010");
      // Bass sits an octave low; the keyboard shows the keys, C2 under A.
      await t.until(() => t.vt.text().includes("PLAY"), "play header");
      await t.until(() => t.vt.text().includes("oct C2–F3"), "keyboard");
      expect(t.vt.text()).toMatch(/^ C2 +D +E +F /m);

      // Octave and velocity keys update the header in place.
      await t.send("x");
      await t.until(() => t.vt.text().includes("C3–F4"), "octave up");
      await t.send("z");
      await t.until(() => t.vt.text().includes("C2–F3"), "octave down");
      await t.send("c");
      // Velocity is a status line, not header furniture.
      await t.until(() => t.vt.text().includes("velocity 84"), "velocity");
      // `?` lists play mode's keys and the state kept out of the header.
      await t.send("?");
      await t.until(
        () => t.vt.text().includes("letters are piano keys"),
        "keys",
      );
      expect(t.vt.text()).toContain("velocity 84 · grid 1/16");
      await t.send("\u001b");
      await t.until(
        () => !t.vt.text().includes("letters are piano keys"),
        "keys closed",
      );
      expect(t.vt.text()).toContain("PLAY");

      // Arm, start, play two notes, stop: one recorded pass.
      await t.send("r");
      await t.until(() => t.vt.text().includes("rec armed"), "armed");
      await t.send(" ");
      await t.until(() => t.vt.text().includes("REC"), "recording");
      await t.send("a");
      await Bun.sleep(300);
      await t.send("g");
      await Bun.sleep(200);
      await t.send(" ");
      await t.until(
        () => t.vt.text().includes("recorded 2 notes"),
        "record receipt",
      );
      const notes = (await sessionNotes(t.cwd)).filter(
        (note) => note.trackId === "bass",
      );
      expect(notes.map((note) => note.pitch).sort()).toEqual([36, 43]);

      // Esc leaves; letters type into the prompt again.
      await t.send("\u001b");
      await t.until(() => !t.vt.text().includes("PLAY "), "left play");
      await t.send("asdf");
      await t.until(() => t.vt.text().includes("asdf"), "typing");
    } finally {
      t.terminal.write("\u0003");
      await t.proc.exited;
    }
  },
  20_000,
);

test.skipIf(!supported)(
  "real PTY: auto chords record a voiced diatonic chord; q switches to manual",
  async () => {
    const t = await launch(120, 28, {}, ["--track", "keys"]);
    try {
      await t.until(() => t.vt.text().includes(" NOW "), "prompt");
      await t.send("/key C major\r");
      await t.until(() => t.vt.text().includes("key · C major"), "key");
      await t.send("/count-in 0\r");
      await t.until(
        () => t.vt.text().includes("count-in · 0 bars"),
        "count-in",
      );
      await t.send("\u0010");
      // A keys track defaults to auto chords; each key names its chord.
      await t.until(() => t.vt.text().includes("AUTO C major"), "auto header");
      expect(t.vt.text()).toMatch(/^ C +Dm +Em +F +G +Am +Bdim /m);
      // The number-row legend shows what each chord key does.
      expect(t.vt.text()).toContain("1 dim");
      expect(t.vt.text()).toContain("b bass off");
      expect(t.vt.text()).toContain("? keys · esc leave");

      await t.send("r");
      await t.until(() => t.vt.text().includes("rec armed"), "armed");
      await t.send(" ");
      await t.until(() => t.vt.text().includes("REC"), "recording");
      await t.send("s"); // D → Dm in C major
      await t.until(() => t.vt.text().includes("Dm (ii)"), "chord shown");
      await Bun.sleep(250);
      await t.send(" ");
      await t.until(
        () => t.vt.text().includes("recorded 3 notes"),
        "record receipt",
      );
      const notes = (await sessionNotes(t.cwd)).filter(
        (note) => note.trackId === "keys",
      );
      expect(
        [...new Set(notes.map((note) => note.pitch % 12))].sort(
          (a, b) => a - b,
        ),
      ).toEqual([2, 5, 9]);
      expect(new Set(notes.map((note) => note.startTick)).size).toBe(1);

      // q: manual, single notes again.
      await t.send("q");
      await t.until(() => t.vt.text().includes("MANUAL C major"), "manual");
      expect(t.vt.text()).not.toMatch(/^ C +Dm +Em /m);
      expect(t.vt.text()).toMatch(/^ C3 +D +E +F /m);
    } finally {
      t.terminal.write("\u0003");
      await t.proc.exited;
    }
  },
  20_000,
);

test.skipIf(!supported)(
  "real PTY: a latched chord key is drawn reversed in the legend, in colour",
  async () => {
    const t = await launch(120, 28, {}, ["--track", "keys"]);
    try {
      await t.until(() => t.vt.text().includes(" NOW "), "prompt");
      await t.send("\u0010");
      await t.until(() => t.vt.text().includes("1 dim"), "legend");
      const style = (label: string) => {
        const y = t.vt.findRow("1 dim");
        const x = t.vt.lines()[y]!.indexOf(label);
        return t.vt.cell(x, y).style;
      };
      expect(style("min").reverse).toBeFalsy();
      await t.send("2");
      await t.until(() => style("min").reverse === true, "min latched");
      expect(style("min").fg).toBeDefined();
      expect(style("dim").reverse).toBeFalsy();
      expect(style("m7").reverse).toBeFalsy();
      // The ? panel's chord line uses the header's words.
      await t.send("?");
      await t.until(() => t.vt.text().includes("⌃ play mode"), "keys panel");
      expect(t.vt.text()).toMatch(
        /chords AUTO \S+ major \(assumed\) · next \S+ · min/,
      );
      expect(t.vt.text()).not.toContain("→");
      await t.send("?");
      await t.until(() => !t.vt.text().includes("⌃ play mode"), "closed");
      await t.send("0");
      await t.until(() => !style("min").reverse, "latches cleared");
    } finally {
      t.terminal.write("\u0003");
      await t.proc.exited;
    }
  },
  20_000,
);

test.skipIf(!supported)(
  "real PTY: r on TAPE records the loop, a pass an undo step; reels turn",
  async () => {
    const t = await launch(100, 28, {}, ["--track", "keys"]);
    try {
      await t.until(() => t.vt.text().includes(" NOW "), "prompt");
      for (const [line, seen] of [
        ["/count-in 0", "count-in · 0 bars"],
        ["/tempo 240", "240"],
        ["/loop 1", "loop"],
      ] as const) {
        await t.send(`${line}\r`);
        await t.until(() => t.vt.text().includes(seen), line);
      }
      await t.send("\u0014"); // Ctrl-T: TAPE
      await t.until(() => t.vt.text().includes("r record"), "tape hint");
      await t.send("r");
      await t.until(
        () => t.vt.text().includes("PLAY") && t.vt.text().includes("rec armed"),
        "TAPE r arms play mode",
      );
      expect(t.vt.text()).toContain("one undo step a pass");
      await t.send(" ");
      await t.until(() => t.vt.text().includes("↻ 1 · pass"), "pass header");
      // A note in each of two passes (a 1-bar loop at 240 BPM is 1 s).
      await t.send("a");
      await t.until(
        () => /pass 1 · \+\d+ notes?/.test(t.vt.text()),
        "pass 1 committed",
      );
      await t.send("g");
      await t.until(
        () => /pass ([2-9]|\d\d+) · \+\d+ notes?/.test(t.vt.text()),
        "a later pass committed",
      );
      await t.send(" ");
      await t.send("\u001b");
      await t.until(() => !t.vt.text().includes("PLAY MODE"), "left play");
      // Back on TAPE: space runs the transport and the reels turn a beat.
      await t.until(() => t.vt.text().includes("r record"), "back on tape");
      const reel = () => t.vt.lines()[t.vt.findRow(" bar")]?.slice(0, 9) ?? "";
      expect(reel()).toContain("◐");
      await t.send(" ");
      await t.until(() => /[◓◑◒]/.test(reel()), "reel turns");
      await t.send(" ");
      const keys = async () =>
        (await sessionNotes(t.cwd)).filter((note) => note.trackId === "keys");
      expect((await keys()).length).toBeGreaterThanOrEqual(2);
      const before = (await keys()).length;
      // One Ctrl-Z takes back one pass, not the take.
      await t.send("\u001a");
      await Bun.sleep(400);
      const after = (await keys()).length;
      expect(after).toBeGreaterThan(0);
      expect(after).toBeLessThan(before);
    } finally {
      t.terminal.write("\u0003");
      await t.proc.exited;
    }
  },
  30_000,
);
