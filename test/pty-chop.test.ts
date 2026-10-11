/**
 * `/chop info` in a real PTY at 80x24 with NO_COLOR: the receipt names the
 * file's length and rate, and `/chop reverse` writes a new WAV under the
 * focused track's samples folder.
 */
import { expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav24, makePcm } from "../src/audio/chop/pcm.ts";
import { launch, supported } from "./pty-harness.ts";

test.skipIf(!supported)(
  "real PTY: /chop info and reverse at 80x24 NO_COLOR",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawg-pty-chop-"));
    const pcm = makePcm(44_100, 1, 44_100);
    for (let i = 0; i < 44_100; i += 1)
      pcm.channels[0]![i] = Math.sin((2 * Math.PI * 220 * i) / 44_100) * 0.5;
    await writeFile(join(dir, "tone.wav"), encodeWav24(pcm));
    const t = await launch(80, 24, { NO_COLOR: "1" }, ["--track", "lead"], dir);
    try {
      await t.until(() => t.vt.text().includes(" NOW "), "prompt");
      await t.type("/chop info tone.wav\r", "chop info");
      await t.until(() => t.vt.text().includes("tone.wav"), "info receipt");
      const text = t.vt.text();
      expect(text).toMatch(/1(\.0+)?\s?s|0:01/);
      expect(text).toContain("44100 Hz");
      await t.type("/chop reverse tone.wav\r", "chop reverse");
      await t.until(() => /reverse/i.test(t.vt.text()), "reverse receipt");
      const samples = await readdir(
        join(dir, "tracks", "lead", "samples"),
      ).catch(() => []);
      expect(samples.some((name) => name.endsWith(".wav"))).toBe(true);
    } finally {
      await t.send("\u0003");
      await Promise.race([t.proc.exited, Bun.sleep(5000)]);
      t.proc.kill();
      t.terminal.close();
    }
  },
  30_000,
);
