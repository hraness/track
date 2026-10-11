import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentSettings } from "../agent/settings.ts";
import { commandParses } from "./parses.ts";
import { demoScore } from "../../test/consistency-lib.ts";
import {
  parseAgentSettingsCommand,
  runAgentSettingsCommand,
} from "./agent-settings.ts";

let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dawg-agentset-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "dawg-agentout-")));
  await mkdir(join(outside, "samples"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("/agent read-root and /agent shell", () => {
  test("parses the forms /help teaches", () => {
    expect(parseAgentSettingsCommand("read-root list")).toEqual({
      kind: "read-root",
      action: "list",
    });
    expect(parseAgentSettingsCommand("read-root add ~/x y")).toEqual({
      kind: "read-root",
      action: "add",
      path: "~/x y",
    });
    expect(parseAgentSettingsCommand("shell on")).toEqual({
      kind: "shell",
      on: true,
    });
    expect(parseAgentSettingsCommand("read-root add")).toBeUndefined();
    expect(parseAgentSettingsCommand("shell maybe")).toBeUndefined();
  });

  test("add, list, remove and shell write .dawg/agent.json", async () => {
    const dir = join(outside, "samples");
    expect(
      (await runAgentSettingsCommand(`read-root add ${dir}`, root)).ok,
    ).toBe(true);
    const listed = await runAgentSettingsCommand("read-root list", root);
    expect(listed.lines).toEqual([dir]);
    expect((await runAgentSettingsCommand("shell on", root)).ok).toBe(true);
    expect(await readAgentSettings(root)).toEqual({
      readRoots: [dir],
      shell: true,
    });
    expect(
      (await runAgentSettingsCommand(`read-root remove ${dir}`, root)).ok,
    ).toBe(true);
    expect((await readAgentSettings(root)).readRoots).toEqual([]);
  });

  test("a missing folder is refused with a message", async () => {
    const result = await runAgentSettingsCommand(
      `read-root add ${join(outside, "nope")}`,
      root,
    );
    expect(result.ok).toBe(false);
    expect((await readAgentSettings(root)).readRoots).toEqual([]);
  });

  test("the agent cannot type these through show-me", () => {
    for (const line of ["/agent shell on", "/agent read-root add /tmp"])
      expect(commandParses(line, demoScore())).toBe(false);
  });
});
