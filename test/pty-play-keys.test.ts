/**
 * Play mode's on-screen keyboard in a real PTY: the keys drawn in QWERTY
 * rows with what they play underneath, held keys lit (reversed, so it
 * reads without color), and a recorded pass that lands in the track.
 */
import { expect, test } from "bun:test";
import { launch, supported } from "./pty-harness.ts";

type Pty = Awaited<ReturnType<typeof launch>>;

/**
 * Whether the key cap for `letter` is held: reversed, and marked with `•`
 * (`*` in ASCII) so it reads with attributes off.
 */
function lit(t: Pty, letter: string): boolean {
  const lines = t.vt.lines();
  const escaped = letter.replace(/[;']/, "\\$&");
  for (let y = 1; y < 8; y += 1) {
    const line = lines[y] ?? "";
    // Key caps stand alone: ` S    D`, never inside a word.
    const match = new RegExp(`(?<=^| )${escaped}([•*]?)(?= |$)`).exec(line);
    if (match && match.index < 60) return match[1] !== "";
  }
  throw new Error(`no key cap ${letter}\n${t.vt.text()}`);
}

/** The held key's cap is reverse video (where attributes are on). */
function reversed(t: Pty, letter: string): boolean {
  const lines = t.vt.lines();
  for (let y = 1; y < 8; y += 1) {
    const x = (lines[y] ?? "").indexOf(`${letter}•`);
    if (x >= 0) return t.vt.cell(x, y).style.reverse === true;
  }
  return false;
}

test.skipIf(!supported)(
  "real PTY: play keys light up while held and record a pass",
  async () => {
    const t = await launch(80, 24, {}, ["--track", "keys"]);
    try {
      await t.until(() => t.vt.text().includes(" NOW "), "prompt");
      await t.type("/count-in 0\r");
      await t.type("/chords off\r");
      await t.type("\u0010", "play mode");
      expect(t.state()?.screen).toBe("play");
      // The frame follows the settled state; wait for the keyboard itself.
      await t.until(() => t.vt.text().includes("rec off"), "keyboard");
      const keys = t.vt.lines().slice(1, 6).join("\n");
      // The upper row's black keys over the home row, labels underneath.
      expect(keys).toMatch(/ W {4}E {9}T {4}Y {4}U {9}O {4}P/);
      expect(keys).toMatch(/ A {4}S {4}D {4}F {4}G/);
      expect(keys).toContain("C#");
      expect(keys).toMatch(/C3 .*C4/);
      expect(keys).toContain("rec off");
      expect(lit(t, "S")).toBe(false);

      // Arm and latch sustain, so pressed keys stay down.
      await t.type("r");
      await t.until(() => t.vt.text().includes("rec armed"), "armed");
      await t.type("\t");
      await t.type(" ");
      await t.until(() => t.vt.text().includes("REC"), "recording");
      await t.type("s");
      await t.until(() => lit(t, "S"), "S lit");
      expect(reversed(t, "S")).toBe(true);
      expect(lit(t, "D")).toBe(false);
      await t.type("j");
      await t.until(() => lit(t, "J"), "J lit");
      expect(lit(t, "S")).toBe(true);
      // Unlatch: the keys go dark; stop: the pass is recorded.
      await t.type("\t");
      await t.until(() => !lit(t, "S") && !lit(t, "J"), "released");
      await t.type(" ");
      await t.until(
        () => t.vt.text().includes("recorded 2 notes"),
        "record receipt",
      );
      await t.type("\u001b");
    } finally {
      t.terminal.write("\u0003");
      await Promise.race([t.proc.exited, Bun.sleep(5000)]);
      t.proc.kill();
    }
  },
  30_000,
);

test.skipIf(!supported)(
  "real PTY: a kit's keys name their drums, ASCII under TERM=dumb",
  async () => {
    const t = await launch(80, 24, { TERM: "dumb", NO_COLOR: "1" }, [
      "--track",
      "drums",
    ]);
    try {
      await t.until(() => t.vt.text().includes("NOW"), "prompt");
      await t.type("instrument kit\r");
      await t.until(() => t.vt.text().includes("track"), "kit");
      await t.type("\u0010", "play mode");
      await t.until(() => t.vt.text().includes(" kick snr "), "drum keys");
      const keys = t.vt.lines().slice(1, 6).join("\n");
      expect(keys).toMatch(/ kick snr /);
      for (const sound of ["rim", "clap", "chh", "ohh", "tom"])
        expect(keys).toContain(sound);
      expect(keys).toMatch(/^[\x20-\x7e\n]*$/);
      // Held (latched) keys reverse even with no color at all.
      await t.type("\t");
      await t.type("a");
      await t.until(() => lit(t, "A"), "A lit");
      expect(lit(t, "S")).toBe(false);
      await t.type("\t");
      await t.type("\u001b");
    } finally {
      t.terminal.write("\u0003");
      await Promise.race([t.proc.exited, Bun.sleep(5000)]);
      t.proc.kill();
    }
  },
  30_000,
);
