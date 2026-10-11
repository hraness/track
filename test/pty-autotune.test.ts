/**
 * 0.7 autotune in the real binary: `/autotune`, the `/tune` hint, the
 * `/vocal autotune` alias and Sound > Voice > Autotune in the ctrl-k menu.
 * Same PTY setup as test/pty.test.ts (Bun.spawn with a terminal).
 */
import { expect, test } from "bun:test";
import { launch, supported } from "./pty-harness.ts";

test.skipIf(!supported)(
  "real PTY: /autotune, /tune hint, /vocal autotune, Sound > Voice > Autotune",
  async () => {
    // No provider: the prompt is commands only.
    const t = await launch(110, 34, { DAWG_AI: "0", AI_GATEWAY_API_KEY: "" }, [
      "--track",
      "vox",
    ]);
    const vt = t.vt;
    const until = t.until;
    try {
      await until(() => vt.text().includes("commands only"), "ready");
      // Each line settles before its receipt is read: a receipt's words can
      // already be on screen from the line before.
      await t.type("/autotune hard\r", "autotune set");
      expect(vt.text()).toContain("autotune · hard");
      await t.type("/tune hard\r", "tune hint");
      expect(vt.text()).toContain("for pitch correction use /autotune hard");
      await t.type("/vocal autotune gentle speed 60\r", "vocal alias");
      expect(vt.text()).toContain("autotune · gentle · speed 60 ms");
      await t.type("/autotne\r", "typo hint");
      expect(vt.text()).toContain("did you mean /autotune");
      // "autotune" is on screen already: wait for the menu itself.
      await t.type("/menu voice\r", "Voice menu");
      expect(t.state()?.screen).toBe("menu");
      expect(vt.text()).toContain("autotune");
      // Clips, lyrics and pitch sit above it: filter to autotune, then open.
      await t.send("/autotune");
      await t.send("\r");
      await until(
        () => vt.text().includes("preset") && vt.text().includes("flex"),
        "autotune rows",
      );
      expect(vt.text()).toContain("gentle");
      await t.send("\u001b");
      await t.send("\u001b");
      await t.send("\u001b");
    } finally {
      t.terminal.write("\u0003");
      await Promise.race([t.proc.exited, Bun.sleep(5000)]);
      t.proc.kill();
      t.terminal.close();
    }
  },
  25_000,
);
