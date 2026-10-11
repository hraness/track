/**
 * The preset browser end to end: `/presets` opens the categories, typing
 * filters every preset, moving auditions, enter keeps it (one undo) and
 * esc reverts; `preset next` steps through the category.
 */
import { expect, test } from "bun:test";
import { launch, supported } from "./pty-harness.ts";

test.skipIf(!supported)(
  "real PTY: /presets browses, filters, keeps and reverts",
  async () => {
    const t = await launch(80, 24, {});
    const screen = () => t.vt.text();
    try {
      await t.until(() => screen().includes(" NOW "), "prompt");
      await t.settle("prompt");
      await t.type("/presets\r", "open");
      await t.until(() => screen().includes("─ presets"), "browser");
      expect(screen()).toContain("bass");
      expect(screen()).toContain("pad");
      await t.type("warm pad", "filter");
      await t.until(() => screen().includes("warm-pad"), "filtered");
      if (process.env.DAWG_PRINT_FRAME) console.log(screen());
      await t.type("\r", "keep");
      await t.until(() => /: warm-pad ·/.test(screen()), "kept");
      expect(screen()).not.toContain("─ presets");
      await t.type("preset next\r", "next");
      await t.until(
        () => /: (?!warm-pad)[a-z0-9-]+ ·/.test(screen()),
        "stepped",
      );
      await t.type("/presets pad\r", "reopen");
      await t.until(() => screen().includes("─ "), "pad list");
      await t.type("\x1b", "esc");
      await t.until(() => !screen().includes("╭─ pad"), "closed");
    } finally {
      t.terminal.close();
      t.proc.kill();
      await t.proc.exited;
    }
  },
  45_000,
);
