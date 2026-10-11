/**
 * The audio menu end to end over a fake native sink: Ctrl-K › Project ›
 * audio › output lists the devices, Enter picks one (saved per machine,
 * a blip on it), Esc goes back; `audio in <name>` sets the input.
 */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, supported } from "./pty-harness.ts";

const PRELOAD = resolve(import.meta.dir, "fake-sink-preload.ts");

test.skipIf(!supported)(
  "pick an output and an input from the audio menu",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawg-pty-audio-"));
    const log = join(dir, "opened.log");
    const t = await launch(
      100,
      34,
      {
        DAWG_AUDIO: "1",
        DAWG_AUDIO_BACKEND: "native",
        DAWG_FAKE_SINK_LOG: log,
      },
      ["--track", "bass"],
      dir,
      ["--preload", PRELOAD],
    );
    const choice = async () =>
      JSON.parse(
        await readFile(
          join(dir, ".config", "dawg", "audio.json"),
          "utf8",
        ).catch(() => "{}"),
      ) as { version?: number; output?: string; input?: string };
    try {
      await t.until(() => t.vt.text().includes(" NOW "), "prompt");
      await t.send("/menu project\r");
      await t.until(() => t.vt.text().includes("≡ Project"), "Project");
      await t.send("/audio");
      await t.send("\r");
      await t.until(
        () => t.vt.text().includes("≡ Project › audio"),
        "audio page",
      );
      expect(t.vt.text()).toContain("output");
      expect(t.vt.text()).toContain("input");
      await t.send("/output");
      await t.send("\r");
      await t.until(
        () => t.vt.text().includes("≡ Project › audio › output"),
        "output list",
      );
      expect(t.vt.text()).toContain("Built-in Output");
      // Arrows: default, Built-in Output, USB Audio Interface.
      await t.send("\u001b[B");
      await t.send("\u001b[B");
      // The pick echoes `audio out USB Audio Interface` as its request line
      // before the command runs: wait for the queue, not that text.
      await t.type("\r", "picked");
      expect(t.vt.text()).toContain("audio out USB Audio Interface");
      expect((await choice()).output).toBe("USB Audio Interface");
      const opened = async () =>
        (await readFile(log, "utf8").catch(() => "")).split("\n");
      for (
        let i = 0;
        i < 100 && !(await opened()).includes("USB Audio Interface");
        i++
      )
        await Bun.sleep(50);
      expect(await opened()).toContain("USB Audio Interface");
      // Esc back out, then the typed input.
      const menuOpen = () => t.vt.text().includes("≡ ");
      for (let i = 0; i < 8 && menuOpen(); i++) {
        await t.send("\u001b");
        await Bun.sleep(150);
      }
      await t.until(() => !menuOpen(), "menu closed");
      await t.type("audio in usb\r", "input set");
      expect(t.vt.text()).toContain("audio in USB Audio Interface");
      expect(await choice()).toEqual({
        version: 1,
        output: "USB Audio Interface",
        input: "USB Audio Interface",
      });
    } finally {
      t.terminal.write("\u0003");
      await t.proc.exited;
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
