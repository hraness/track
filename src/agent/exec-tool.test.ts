import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScore } from "../../core/score.ts";
import { systemRunner, type CommandRunner } from "../auth/runner.ts";
import type { MediaRunContext } from "../media/types.ts";
import { EXEC_TOOL, readExecSettings } from "./exec-tool.ts";
import { AGENT_TOOLS, type ToolContext } from "./tools.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const bin = temp("dawg-exec-tool-bin-");
writeFileSync(join(bin, "echo"), '#!/bin/sh\necho "$@"\n');
writeFileSync(join(bin, "ffprobe"), '#!/bin/sh\necho "probe $@"\n');
for (const name of ["echo", "ffprobe"]) chmodSync(join(bin, name), 0o755);
const runner: CommandRunner = {
  ...systemRunner,
  which: (command) =>
    existsSync(join(bin, command)) ? join(bin, command) : undefined,
};

const tool: ToolContext = {
  score: createScore({
    tempoBpm: 120,
    bars: 4,
    tracks: [{ id: "lead", name: "lead", instrument: "saw" }],
  }),
  focusedTrackId: "lead",
  revision: 1,
  newNoteId: (trackId, index) => `${trackId}-n${index}`,
};

function media(root: string): MediaRunContext {
  return {
    runner,
    projectRoot: root,
    trackSlug: "lead",
    signal: new AbortController().signal,
    progress: () => {},
  };
}

async function run(root: string, raw: Record<string, unknown>) {
  const plan = EXEC_TOOL.plan(raw, tool);
  if (plan.kind !== "media") throw new Error("exec plans are media plans");
  return plan.run(media(root));
}

describe("exec agent tool", () => {
  test("is in the catalog", () => {
    expect(AGENT_TOOLS.some((t) => t.name === "exec")).toBe(true);
    expect(EXEC_TOOL.description.length).toBeLessThan(220);
  });

  test("runs an allowlisted tool and pages its log", async () => {
    const root = temp("dawg-exec-tool-");
    writeFileSync(join(root, "a.wav"), "RIFF");
    const result = await run(root, { argv: ["ffprobe", "a.wav"] });
    expect(result.content.ok).toBe(true);
    expect(result.content.stdoutTail).toBe("probe a.wav\n");
    const page = await run(root, { log: result.content.logId });
    expect(String(page.content.text)).toContain("$ ffprobe a.wav");
  });

  test("trusted shell runs any CLI only when the human set it", async () => {
    const root = temp("dawg-exec-tool-");
    await expect(run(root, { argv: ["echo", "hi"] })).rejects.toThrow(
      "not allowed",
    );
    mkdirSync(join(root, ".dawg"), { recursive: true });
    writeFileSync(
      join(root, ".dawg", "agent.json"),
      JSON.stringify({ shell: true }),
    );
    expect(readExecSettings(root).shell).toBe(true);
    const result = await run(root, { argv: ["echo", "hi"] });
    expect(result.content.stdoutTail).toBe("hi\n");
    // The agent cannot write the setting: exec outputs refuse .dawg/.
    writeFileSync(join(root, ".dawg", "agent.json"), "{}");
    await expect(
      run(root, { argv: ["ffprobe", "-i", "x", ".dawg/agent.json"] }),
    ).rejects.toThrow();
  });

  test("malformed settings read as off", () => {
    const root = temp("dawg-exec-tool-");
    mkdirSync(join(root, ".dawg"), { recursive: true });
    writeFileSync(join(root, ".dawg", "agent.json"), "{nope");
    expect(readExecSettings(root)).toEqual({ shell: false, readRoots: [] });
  });

  test("argv must be strings", () => {
    expect(() => EXEC_TOOL.plan({ argv: [1, 2] }, tool)).toThrow("argv");
  });
});
