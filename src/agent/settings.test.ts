import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addReadRoot,
  agentSettingsPath,
  AgentSettingsError,
  DEFAULT_AGENT_SETTINGS,
  parseAgentSettings,
  readAgentSettings,
  removeReadRoot,
  setTrustedShell,
} from "./settings.ts";

async function temp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dawg-settings-"));
}

describe("agent settings", () => {
  test("missing or malformed files read as defaults", async () => {
    const root = await temp();
    try {
      expect(await readAgentSettings(root)).toEqual(DEFAULT_AGENT_SETTINGS);
      await mkdir(join(root, ".dawg"));
      await writeFile(agentSettingsPath(root), "{nope");
      expect(await readAgentSettings(root)).toEqual(DEFAULT_AGENT_SETTINGS);
      expect(
        parseAgentSettings({
          readRoots: ["rel/x", 3, "/abs", "/abs"],
          shell: "yes",
        }),
      ).toEqual({ readRoots: ["/abs"], shell: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("read roots are stored by realpath, deduped and removable; unknown keys survive", async () => {
    const root = await temp();
    const outside = await temp();
    try {
      await mkdir(join(root, ".dawg"));
      await writeFile(agentSettingsPath(root), JSON.stringify({ future: 1 }));
      await mkdir(join(outside, "lib"));
      await symlink(join(outside, "lib"), join(outside, "link"));
      const added = await addReadRoot(root, join(outside, "link"));
      expect(added.readRoots).toHaveLength(1);
      expect(added.readRoots[0]!.endsWith("/lib")).toBe(true);
      expect(
        (await addReadRoot(root, join(outside, "lib"))).readRoots,
      ).toHaveLength(1);
      const raw = JSON.parse(await readFile(agentSettingsPath(root), "utf8"));
      expect(raw.future).toBe(1);
      expect(
        (await removeReadRoot(root, join(outside, "lib"))).readRoots,
      ).toEqual([]);
      await expect(removeReadRoot(root, "/nowhere")).rejects.toBeInstanceOf(
        AgentSettingsError,
      );
      await expect(addReadRoot(root, join(outside, "missing"))).rejects.toThrow(
        "does not exist",
      );
      await expect(addReadRoot(root, root)).rejects.toThrow(
        "inside the project",
      );
      expect(
        (await readdir(join(root, ".dawg"))).filter((f) => f.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("the trusted shell is off by default and toggles", async () => {
    const root = await temp();
    try {
      expect((await readAgentSettings(root)).shell).toBe(false);
      expect((await setTrustedShell(root, true)).shell).toBe(true);
      expect((await readAgentSettings(root)).shell).toBe(true);
      expect((await setTrustedShell(root, false)).shell).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no agent tool module can reach the human-only setters", async () => {
    const dirs = ["src/agent", "src/media"];
    const offenders: string[] = [];
    for (const dir of dirs)
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".ts") || name.includes(".test.")) continue;
        if (name === "settings.ts") continue;
        const source = await readFile(join(dir, name), "utf8");
        if (/\b(addReadRoot|removeReadRoot|setTrustedShell)\b/.test(source))
          offenders.push(`${dir}/${name}`);
      }
    expect(offenders).toEqual([]);
  });
});
