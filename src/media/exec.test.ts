import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemRunner, type CommandRunner } from "../auth/runner.ts";
import { checkExecArgv, EXEC_LIMITS, ExecError, readExecLog, runExec, type ExecContext } from "./exec.ts";

let root: string;
let outside: string;
let bin: string;

/** Fake CLIs: real processes, so timeouts, groups and logs are exercised. */
const FAKES: Record<string, string> = {
  // Echoes its argv, writes the last argument as an output file.
  ffmpeg: `#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\neval last=\\\${$#}\necho data > "$last"\necho "size=1kB" 1>&2\n`,
  ffprobe: `#!/bin/sh\necho '{"format":{"duration":"1.0"}}'\n`,
  // Sleeps in a child too, so the group kill is visible.
  sox: `#!/bin/sh\n(sleep 30; echo leaked > "$PWD/leak.txt") &\nsleep 30\n`,
  rubberband: `#!/bin/sh\nyes "noise line for truncation testing" | head -c 17000000\nexit 3\n`,
  "yt-dlp": `#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\necho "HOME=$HOME"\n`,
  sleeper: `#!/bin/sh\necho trusted\n`,
};

function runnerFor(dir: string): CommandRunner {
  return {
    ...systemRunner,
    which: (command) => (existsSync(join(dir, command)) ? join(dir, command) : undefined),
  };
}

function ctx(extra: Partial<ExecContext> = {}): ExecContext {
  return { root, trackSlug: "lead", runner: runnerFor(bin), path: `${bin}:/usr/bin:/bin`, ...extra };
}

function refused(argv: string[], extra: Partial<ExecContext> = {}): string {
  const result = checkExecArgv(argv, ctx(extra));
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dawg-exec-"));
  outside = mkdtempSync(join(tmpdir(), "dawg-exec-out-"));
  bin = mkdtempSync(join(tmpdir(), "dawg-exec-bin-"));
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  mkdirSync(join(root, "tracks/lead/samples"), { recursive: true });
  writeFileSync(join(root, "in.wav"), "RIFF");
  writeFileSync(join(outside, "secret.wav"), "RIFF");
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(outside, "secret.wav"), join(root, "link.wav"));
});

afterAll(() => {
  for (const dir of [root, outside, bin]) rmSync(dir, { recursive: true, force: true });
});

describe("exec argument policy", () => {
  test("accepts a plain ffmpeg chop and forces safety flags", () => {
    const result = checkExecArgv(["ffmpeg", "-y", "-i", "in.wav", "-af", "afade=t=in:d=0.1", "out/a.wav"], ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.argv.slice(0, 3)).toEqual(["ffmpeg", "-nostdin", "-hide_banner"]);
    expect(result.argv).toContain("-protocol_whitelist");
    expect(result.outputs).toEqual(["out/a.wav"]);
  });

  test("refuses tools outside the allowlist and paths in argv[0]", () => {
    expect(refused(["bash", "-c", "id"])).toContain("not allowed");
    expect(refused(["/usr/bin/ffmpeg", "-i", "in.wav", "o.wav"])).toContain("bare tool name");
    expect(refused(["uv", "run", "x"])).toContain("uv is not accepted");
  });

  test("argument injection: unknown flags, -- and stdin are refused by name", () => {
    expect(refused(["ffmpeg", "-i", "in.wav", "-dump_attachment", "x", "o.wav"])).toMatch(/refused|unknown flag/);
    expect(refused(["ffmpeg", "--", "-i"])).toContain('"--"');
    expect(refused(["ffmpeg", "-i", "-", "o.wav"])).toMatch(/stdin|does not exist|"-"/);
    expect(refused(["yt-dlp", "--exec", "rm -rf ~", "https://example.com/v"])).toContain("refused");
    expect(refused(["ffmpeg", "-i", "in.wav", "-f", "lavfi", "o.wav"])).toContain("must be one of");
    expect(refused(["ffmpeg", "-i", "in.wav\nx", "o.wav"])).toContain("control character");
    expect(refused(["ffmpeg", "-i", "in.wav", "-af", "ladspa=file=/tmp/x.so", "o.wav"])).toContain("refused");
    expect(refused(["ffmpeg", "-i", "in.wav", "-af", "amovie=/etc/passwd", "o.wav"])).toContain("refused");
    expect(refused(["sox", "in.wav", "o.wav", "remix", "|rm"])).toContain("refused");
  });

  test("path confinement: absolute, .., protocols and symlink escapes", () => {
    expect(refused(["ffmpeg", "-i", "/etc/hosts", "o.wav"])).toContain("outside the project");
    expect(refused(["ffmpeg", "-i", "../../etc/hosts", "o.wav"])).toMatch(/outside the project|does not exist/);
    expect(refused(["ffmpeg", "-i", "in.wav", "/tmp/o.wav"])).toContain("outside the project");
    expect(refused(["ffmpeg", "-i", "in.wav", "../o.wav"])).toContain("outside the project");
    expect(refused(["ffmpeg", "-i", "http://evil/x.wav", "o.wav"])).toContain("protocol");
    expect(refused(["ffmpeg", "-i", "concat:in.wav|in.wav", "o.wav"])).toContain("protocol");
    expect(refused(["ffmpeg", "-i", "in.wav", "pipe:1"])).toContain("protocol");
    expect(refused(["ffmpeg", "-i", "link.wav", "o.wav"])).toContain("outside the project");
    expect(refused(["ffmpeg", "-i", "in.wav", "escape/o.wav"])).toContain("symlink");
    expect(refused(["ffmpeg", "-i", "in.wav", ".dawg/x.wav"])).toContain("write scope");
    expect(refused(["ffmpeg", "-i", "in.wav", ".git/hooks/pre-commit"])).toContain("write scope");
    // A read root the host grants is accepted.
    expect(checkExecArgv(["ffmpeg", "-i", join(outside, "secret.wav"), "o.wav"], ctx({ readRoots: [outside] })).ok).toBe(true);
  });

  test("no network except download tools", () => {
    expect(refused(["ffmpeg", "-i", "https://example.com/a.mp3", "o.wav"])).toContain("protocol");
    expect(refused(["sox", "https://example.com/a.wav", "o.wav"])).toMatch(/protocol|outside/);
    expect(refused(["yt-dlp", "http://example.com/v"])).toContain("https");
    expect(refused(["yt-dlp", "https://127.0.0.1/v"])).toContain("IP-address");
    expect(refused(["yt-dlp", "https://user:pw@example.com/v"])).toContain("credentials");
    expect(refused(["yt-dlp", "-o", "../%(title)s.%(ext)s", "https://example.com/v"])).toContain("..");
    expect(checkExecArgv(["yt-dlp", "-x", "https://example.com/v"], ctx()).ok).toBe(true);
  });

  test("every §7.4 vector is refused", () => {
    expect(refused(["sox", "-", "o.wav"])).toContain('"-"');
    expect(refused(["yt-dlp", "--exec-before-download", "x", "https://example.com/v"])).toContain("refused");
    expect(refused(["yt-dlp", "--ffmpeg-location", "/tmp/x", "https://example.com/v"])).toMatch(/refused|unknown/);
    expect(refused(["yt-dlp", "--postprocessor-args", "x", "https://example.com/v"])).toMatch(/refused|unknown/);
    expect(refused(["yt-dlp", "-a", "urls.txt"])).toMatch(/refused|unknown/);
    expect(refused(["yt-dlp", "--config-location", "x", "https://example.com/v"])).toMatch(/refused|unknown/);
    expect(refused(["ffmpeg", "-i", "in.wav", "-af", "sendcmd=c=x", "o.wav"])).toContain("refused");
    expect(refused(["ffmpeg", "-f", "concat", "-safe", "0", "-i", "in.wav", "o.wav"])).toMatch(/refused|must be one of/);
    expect(refused(["ffmpeg", "-report", "-i", "in.wav", "o.wav"])).toMatch(/refused|unknown/);
    expect(refused(["ffmpeg", "-i", "in.wav", "-f", "segment", "o%d.wav"])).toContain("must be one of");
    expect(refused(["ffmpeg", "-i", "in.wav", "a.wav", "/tmp/b.wav"])).toContain("outside the project");
    expect(refused(["ffmpeg", "-i", "file:in.wav", "o.wav"])).toContain("protocol");
    expect(refused(["demucs", "--repo", "/tmp/models", "in.wav"])).toMatch(/refused|unknown/);
    expect(refused(["uvx", "demucs"])).toContain("uv is not accepted");
    const stripped = checkExecArgv(["ffmpeg", "-protocol_whitelist", "http,file", "-i", "in.wav", "o.wav"], ctx());
    expect(stripped.ok && stripped.argv.join(" ")).not.toContain("http,file");
  });

  test("trusted shell mode accepts any CLI but still no paths in argv[0]", () => {
    expect(checkExecArgv(["sleeper", "anything", "--goes"], ctx({ shell: true })).ok).toBe(true);
    expect(refused(["/bin/sh", "-c", "x"], { shell: true })).toContain("bare tool name");
  });
});

describe("exec runs", () => {
  test("runs with a minimal env, logs, and reports new files", async () => {
    const result = await runExec({ argv: ["ffmpeg", "-i", "in.wav", "tracks/lead/samples/cut.wav"] }, ctx());
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toEqual(["tracks/lead/samples/cut.wav"]);
    expect(result.stdoutTail).toContain("arg:-nostdin");
    expect(result.stderrTail).toContain("size=1kB");
    const log = readExecLog(root, result.logId);
    expect(log.text.startsWith("$ ffmpeg -nostdin")).toBe(true);
  });

  test("yt-dlp gets forced flags, a default folder and a private HOME", async () => {
    const result = await runExec({ argv: ["yt-dlp", "-x", "https://example.com/v"] }, ctx());
    expect(result.stdoutTail).toContain("arg:--no-exec");
    expect(result.stdoutTail).toContain("arg:tracks/lead/downloads");
    expect(result.stdoutTail).toContain(`.dawg/tmp/exec/${result.logId}`);
  });

  test("a timeout kills the whole process group", async () => {
    const started = Date.now();
    const result = await runExec({ argv: ["sox", "-n", "out.wav"], timeoutMs: 1000 }, ctx());
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(existsSync(join(root, "leak.txt"))).toBe(false);
  }, 15000);

  test("output is truncated in the reply and capped in the saved log", async () => {
    const result = await runExec({ argv: ["rubberband", "in.wav", "o.wav"] }, ctx());
    expect(result.exitCode).toBe(3);
    expect(Buffer.byteLength(result.stdoutTail)).toBeLessThanOrEqual(EXEC_LIMITS.tailBytes);
    expect(result.logTruncated).toBe(true);
    const page = readExecLog(root, result.logId);
    expect(page.size).toBeLessThanOrEqual(EXEC_LIMITS.logCapBytes);
    expect(page.text.length).toBeLessThanOrEqual(EXEC_LIMITS.pageBytes);
    expect(page.nextOffset).toBe(EXEC_LIMITS.pageBytes);
  }, 30000);

  test("an abort cancels the run", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runExec({ argv: ["sox", "-n", "o.wav"] }, ctx({ signal: controller.signal }));
    expect(result.exitCode).not.toBe(0);
  }, 15000);

  test("env secrets are stripped from the child", async () => {
    process.env.DAWG_TEST_SECRET = "hunter2";
    try {
      const result = await runExec({ argv: ["sleeper"] }, ctx({ shell: true }));
      expect(result.stdoutTail).toBe("trusted\n");
      writeFileSync(join(bin, "envdump"), "#!/bin/sh\nenv\n");
      chmodSync(join(bin, "envdump"), 0o755);
      const env = await runExec({ argv: ["envdump"] }, ctx({ shell: true }));
      expect(env.stdoutTail).not.toContain("hunter2");
      expect(env.stdoutTail).toContain("HOME=");
    } finally {
      delete process.env.DAWG_TEST_SECRET;
    }
  });

  test("queue: two slots, FIFO, abort while queued", async () => {
    const slow = (signal: AbortSignal) => runExec({ argv: ["sox", "-n", "q.wav"], timeoutMs: 1500 }, ctx({ signal }));
    const keep = new AbortController();
    const a = slow(keep.signal);
    const b = slow(keep.signal);
    const queued = new AbortController();
    const c = slow(queued.signal);
    queued.abort();
    await expect(c).rejects.toThrow("cancelled while queued");
    const d = await runExec({ argv: ["sleeper"] }, ctx({ shell: true }));
    expect(d.queuedMs).toBeGreaterThan(500);
    await Promise.all([a, b]);
  }, 20000);

  test("a missing tool names its install command and installs nothing", async () => {
    await expect(runExec({ argv: ["aubioonset", "-i", "in.wav"] }, ctx())).rejects.toThrow(/not installed.*brew install aubio/);
  });

  test("history rows: one tool row and one asset row per output", async () => {
    const rows: Array<{ kind: string; summary: string }> = [];
    await runExec(
      { argv: ["ffmpeg", "-i", "in.wav", "tracks/lead/samples/h.wav"] },
      ctx({
        history: {
          append: (row) => {
            rows.push(row);
            return { id: "ev_test", done: Promise.resolve(undefined) };
          },
        },
      }),
    );
    expect(rows.map((row) => row.kind)).toEqual(["tool", "asset"]);
  });

  test("log ids are validated (no path traversal)", () => {
    expect(() => readExecLog(root, "../../etc/passwd")).toThrow(ExecError);
    expect(readFileSync(join(root, "in.wav"), "utf8")).toBe("RIFF");
  });
});
