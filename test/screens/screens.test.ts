/**
 * The committed docs screens (docs/screens) must match the TUI today: each
 * scene drives the real dawg again and the capture must equal the file
 * byte for byte. When it fails, run `bun run screens` and review the diff.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { captureAll, screenPath, SCREENS_DIR } from "./capture.ts";
import { screenText, supported, type ScreenFile } from "./driver.ts";
import { SCENES } from "./scenes.ts";

test("every committed screen has a scene and every scene a screen", () => {
  const files = readdirSync(SCREENS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .sort();
  expect(files).toEqual(SCENES.map((scene) => scene.id).sort());
});

test("the README's patch screen is the committed capture", () => {
  const readme = readFileSync(
    new URL("../../README.md", import.meta.url),
    "utf8",
  );
  const screen = JSON.parse(
    readFileSync(screenPath("patch"), "utf8"),
  ) as ScreenFile;
  expect(readme).toContain(
    `\`\`\`text\n${screenText(screen).join("\n")}\n\`\`\``,
  );
});

test.skipIf(!supported)(
  "the docs screens match the TUI (bun run screens refreshes them)",
  async () => {
    const captured = await captureAll(SCENES);
    const stale: string[] = [];
    for (const [id, text] of captured) {
      const path = screenPath(id);
      const committed = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (committed === text) continue;
      const before = committed
        ? screenText(JSON.parse(committed) as ScreenFile)
        : [];
      const after = screenText(JSON.parse(text) as ScreenFile);
      const rows = after
        .map((line, y) =>
          line === before[y]
            ? ""
            : `  ${y}: ${before[y] ?? ""}\n  ${y}> ${line}`,
        )
        .filter(Boolean);
      stale.push(
        `${id}${rows.length ? `\n${rows.join("\n")}` : " (colours only)"}`,
      );
    }
    expect(
      stale,
      `stale screens · run bun run screens\n${stale.join("\n")}`,
    ).toEqual([]);
  },
  120_000,
);
