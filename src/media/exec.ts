/**
 * The exec runner behind the agent's `exec` tool: run one allowlisted
 * audio CLI with an argv array, no shell, cwd = project.
 *
 *   checkExecArgv  parse argv against EXEC_POLICY (exec-policy.ts): every
 *                  flag listed, every path confined, URLs only for yt-dlp
 *   runExec        spawn in its own process group with a minimal env,
 *                  stream stdout+stderr to .dawg/logs/exec/<id>.log (16 MiB
 *                  cap), return 2 KiB tails, the log id and new files
 *   readExecLog    page through a saved log, 4 KiB at a time
 *
 * Limits: timeout from start (default 120 s, max 600 s), SIGTERM then
 * SIGKILL to the whole group after 2 s, 2 concurrent runs per process in a
 * FIFO queue. Trusted shell mode (`shell: true`, set by the human only)
 * accepts any CLI on PATH with the same limits and logging. Nothing is
 * ever installed: a missing tool returns its install command.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandRunner } from "../auth/runner.ts";
import type { ChopActor, ChopHistory } from "../audio/chop/types.ts";
import { defaultWriteScope } from "../audio/chop/run.ts";
import { historySink } from "../history/sink.ts";
import { INSTALL_COMMANDS, uvInstalledTools } from "./backend.ts";
import {
  EXEC_POLICY,
  FFMPEG_REFUSED_FILTERS,
  FILTER_FILE_KEYS,
  SOX_ALL_EFFECTS,
  SOX_EFFECT_SET,
  type ArgRole,
  type ToolPolicy,
} from "./exec-policy.ts";

export const EXEC_ALLOW = [
  "ffmpeg",
  "ffprobe",
  "sox",
  "rubberband",
  "yt-dlp",
  "demucs",
  "basic-pitch",
  "aubio",
  "aubioonset",
  "aubiotrack",
  "aubionotes",
  "whisper-cli",
] as const;
export type ExecTool = (typeof EXEC_ALLOW)[number];

export const EXEC_LIMITS = Object.freeze({
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  killGraceMs: 2_000,
  logCapBytes: 16 * 1024 * 1024,
  tailBytes: 2048,
  pageBytes: 4096,
  maxArgs: 64,
  maxArgLength: 1024,
  maxOutputs: 50,
  slots: 2,
});

/** Install hints for every allowlisted tool (never run by dawg). */
export const EXEC_INSTALL: Readonly<Record<ExecTool, string>> = {
  ffmpeg: INSTALL_COMMANDS.ffmpeg,
  ffprobe: INSTALL_COMMANDS.ffprobe,
  "yt-dlp": INSTALL_COMMANDS["yt-dlp"],
  "whisper-cli": INSTALL_COMMANDS["whisper-cli"],
  demucs: INSTALL_COMMANDS.demucs,
  "basic-pitch": INSTALL_COMMANDS["basic-pitch"],
  sox: "brew install sox (or apt install sox)",
  rubberband: "brew install rubberband (or apt install rubberband-cli)",
  aubio: "brew install aubio (or apt install aubio-tools)",
  aubioonset: "brew install aubio (or apt install aubio-tools)",
  aubiotrack: "brew install aubio (or apt install aubio-tools)",
  aubionotes: "brew install aubio (or apt install aubio-tools)",
};

export class ExecError extends Error {}

export type ExecRequest = Readonly<{ argv: readonly string[]; timeoutMs?: number }>;

export type ExecContext = Readonly<{
  /** Project root (absolute). */
  root: string;
  /** Focused track slug: default outputs go to tracks/<slug>/. */
  trackSlug?: string;
  /** Resolves argv[0] (`which`); never runs anything itself here. */
  runner: CommandRunner;
  /** Extra read-only roots inputs may come from (absolute). */
  readRoots?: readonly string[];
  /** Human-enabled trusted shell: any CLI on PATH, no argument policy. */
  shell?: boolean;
  /** Relative-path predicate for outputs; default refuses .dawg/.git/node_modules. */
  writeScope?: (relative: string) => boolean;
  signal?: AbortSignal;
  progress?: (line: string) => void;
  /** PATH for the child (default process.env.PATH). */
  path?: string;
  /** Default `historySink()`. */
  history?: ChopHistory;
  actor?: ChopActor;
}>;

export type ExecResult = Readonly<{
  exitCode: number;
  ms: number;
  stdoutTail: string;
  stderrTail: string;
  logId: string;
  logPath: string;
  outputs: readonly string[];
  queuedMs: number;
  timedOut?: boolean;
  /** The argv actually run (forced flags included). */
  argv: readonly string[];
  /** Log bytes past the cap were dropped. */
  logTruncated?: boolean;
}>;

export type ExecCheck =
  | { ok: true; argv: string[]; outputs: string[]; outdirs: string[] }
  | { ok: false; reason: string };

const NAME = /^[A-Za-z0-9._+-]{1,64}$/;
const WORD = /^[A-Za-z0-9_.:+\-[\]]{1,64}$/;
const LOG_ID = /^[a-z0-9]{6,16}-[a-f0-9]{8}$/;

// ------------------------------------------------------------------ check

/** Parse and confine `argv` (sync); `argv[0]` is a bare tool name. */
export function checkExecArgv(argv: readonly string[], ctx: ExecContext): ExecCheck {
  try {
    return { ok: true, ...checkOrThrow(argv, ctx) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function checkOrThrow(
  argv: readonly string[],
  ctx: ExecContext,
): { argv: string[]; outputs: string[]; outdirs: string[] } {
  if (!Array.isArray(argv) || argv.length === 0) throw new ExecError("argv must be a non-empty array of strings");
  if (argv.length > EXEC_LIMITS.maxArgs) throw new ExecError(`argv has at most ${EXEC_LIMITS.maxArgs} items`);
  for (const [i, arg] of argv.entries()) {
    if (typeof arg !== "string") throw new ExecError(`argv[${i}] must be a string`);
    if (arg.length > EXEC_LIMITS.maxArgLength) throw new ExecError(`argv[${i}] is longer than ${EXEC_LIMITS.maxArgLength}`);
    if (arg.includes("\0") || /[\r\n]/.test(arg)) throw new ExecError(`argv[${i}] contains a control character`);
  }
  const tool = argv[0]!;
  if (!NAME.test(tool) || tool.includes("/"))
    throw new ExecError(`argv[0] must be a bare tool name (no path): ${tool}`);
  const args = argv.slice(1);
  if (ctx.shell) return { argv: [tool, ...args], outputs: [], outdirs: [] };
  if (tool === "uv" || tool === "uvx")
    throw new ExecError("uv is not accepted; demucs and basic-pitch run through their uv install automatically");
  const policy = EXEC_POLICY[tool];
  if (!policy || !(EXEC_ALLOW as readonly string[]).includes(tool))
    throw new ExecError(`${tool} is not allowed; allowed: ${EXEC_ALLOW.join(", ")} (the user can enable any CLI with /agent shell on)`);
  const state = new Checker(tool, policy, ctx);
  return tool === "sox" ? state.sox(args) : state.generic(args);
}

class Checker {
  readonly outputs: string[] = [];
  readonly outdirs: string[] = [];
  private readonly root: string;

  constructor(
    readonly tool: string,
    readonly policy: ToolPolicy,
    readonly ctx: ExecContext,
  ) {
    this.root = realpathSync(ctx.root);
  }

  private refusedFlag(flag: string): void {
    const reason = this.policy.refused?.[flag];
    if (reason) throw new ExecError(`${this.tool} ${flag} is refused: ${reason}`);
    for (const [prefix, why] of Object.entries(this.policy.refusedPrefixes ?? {}))
      if (flag.startsWith(prefix)) throw new ExecError(`${this.tool} ${flag} is refused: ${why}`);
  }

  private lookup(flag: string): { name: string; spec: { arity: 0 | 1; role?: ArgRole } } {
    this.refusedFlag(flag);
    let name = flag;
    for (;;) {
      const spec = this.policy.flags[name];
      if (spec) return { name, spec };
      // ffmpeg stream specifiers: -c:a:0 → -c:a → -c.
      if (!this.tool.startsWith("ff") || !name.includes(":")) break;
      name = name.slice(0, name.lastIndexOf(":"));
      this.refusedFlag(name);
    }
    const known = Object.keys(this.policy.flags);
    throw new ExecError(
      `${this.tool}: unknown flag ${flag}; allowed: ${known.slice(0, 40).join(" ")}${known.length > 40 ? " …" : ""}`,
    );
  }

  generic(args: readonly string[]): { argv: string[]; outputs: string[]; outdirs: string[] } {
    const out: string[] = [];
    const positionals: string[] = [];
    let templateArg: { index: number; value: string } | undefined;
    let pathsDir: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]!;
      if (token === "--") throw new ExecError(`${this.tool}: "--" is not accepted`);
      if (token === "-") throw new ExecError(`${this.tool}: "-" (stdin/stdout) is not accepted`);
      if (token.startsWith("-") && token.length > 1 && !/^-\d/.test(token)) {
        let flag = token;
        let inline: string | undefined;
        if (token.startsWith("--") && token.includes("=")) {
          flag = token.slice(0, token.indexOf("="));
          inline = token.slice(token.indexOf("=") + 1);
        }
        if (this.tool.startsWith("ff") && flag === "-protocol_whitelist") {
          // dawg sets its own (file only) before every input.
          if (inline === undefined) i += 1;
          continue;
        }
        const { name, spec } = this.lookup(flag);
        if (spec.arity === 0) {
          if (inline !== undefined) throw new ExecError(`${this.tool} ${flag} takes no value`);
          out.push(token);
          continue;
        }
        const value = inline ?? args[++i];
        if (value === undefined) throw new ExecError(`${this.tool} ${flag} needs a value`);
        const role = spec.role ?? "text";
        if (role === "template") {
          templateArg = { index: out.length + 1, value };
        } else if (role === "outdir" && (name === "-P" || name === "--paths")) {
          pathsDir = this.checkValue(role, value, flag);
        } else this.checkValue(role, value, flag);
        if (this.tool === "ffmpeg" && name === "-i") out.push("-protocol_whitelist", "file");
        out.push(flag, value);
        continue;
      }
      positionals.push(token);
      out.push(token);
    }
    this.checkPositionals(positionals);
    if (this.tool === "yt-dlp") {
      if (positionals.length !== 1) throw new ExecError("yt-dlp needs exactly one https:// URL");
      if (templateArg) this.checkTemplate(templateArg.value, pathsDir);
      if (!templateArg && !pathsDir) {
        const dir = `tracks/${this.ctx.trackSlug ?? "main"}/downloads`;
        this.checkValue("outdir", dir, "-P");
        out.unshift("-P", dir);
      }
    } else if (templateArg) {
      // demucs --filename: relative to -o, no directories of its own.
      if (templateArg.value.includes("..") || isAbsolute(templateArg.value))
        throw new ExecError(`${this.tool} --filename must stay inside the output folder`);
    }
    const forced = this.tool === "ffmpeg" ? ["-nostdin", "-hide_banner"] : [];
    return {
      argv: [this.tool, ...(this.policy.prepend ?? []), ...forced, ...out],
      outputs: this.outputs,
      outdirs: this.outdirs,
    };
  }

  private checkPositionals(positionals: readonly string[]): void {
    const { fixed = [], rest, max } = this.policy.positionals;
    if (max !== undefined && positionals.length > max)
      throw new ExecError(`${this.tool} takes at most ${max} positional argument${max === 1 ? "" : "s"}`);
    for (const [i, value] of positionals.entries()) {
      const role = i < fixed.length ? fixed[i]! : rest;
      if (!role) throw new ExecError(`${this.tool}: unexpected argument ${value}`);
      if (value.startsWith("-")) throw new ExecError(`${this.tool}: ${value} looks like a flag in a file position`);
      this.checkValue(role, value, `argument ${i + 1}`);
    }
    if (this.tool === "rubberband" && positionals.length !== 2)
      throw new ExecError("rubberband needs <input> <output>");
    if (this.tool === "basic-pitch" && positionals.length < 2)
      throw new ExecError("basic-pitch needs <output-dir> <input>…");
  }

  /** sox: [gopts] [[fopts] infile]… [[fopts] outfile] [effect [args]]… */
  sox(args: readonly string[]): { argv: string[]; outputs: string[]; outdirs: string[] } {
    const files: Array<{ value: string; nul: boolean }> = [];
    let i = 0;
    for (; i < args.length; i += 1) {
      const token = args[i]!;
      if (token === "-" || token === "--") throw new ExecError(`sox: "${token}" is not accepted`);
      if (token.startsWith("-") && token.length > 1 && !/^-\d/.test(token)) {
        const { spec } = this.lookup(token);
        if (token === "-n") {
          files.push({ value: token, nul: true });
          continue;
        }
        if (spec.arity === 1) {
          const value = args[++i];
          if (value === undefined) throw new ExecError(`sox ${token} needs a value`);
          this.checkValue(spec.role ?? "text", value, token);
        }
        continue;
      }
      if (files.length >= 2 && SOX_ALL_EFFECTS.has(token)) break;
      if (token.startsWith("|")) throw new ExecError("sox: piped input (|command) is refused");
      files.push({ value: token, nul: false });
    }
    if (files.length < 2) throw new ExecError("sox needs an input and an output (use -n for none)");
    for (const [index, file] of files.entries()) {
      if (file.nul) continue;
      this.checkValue(index === files.length - 1 ? "output" : "input", file.value, `file ${index + 1}`);
    }
    let effect: string | undefined;
    for (; i < args.length; i += 1) {
      const token = args[i]!;
      if (SOX_ALL_EFFECTS.has(token)) {
        if (!SOX_EFFECT_SET.has(token))
          throw new ExecError(`sox effect ${token} is refused; allowed: ${[...SOX_EFFECT_SET].join(" ")}`);
        effect = token;
        continue;
      }
      if (!effect) throw new ExecError(`sox: expected an effect, got ${token}`);
      if (token.startsWith("|") || token.includes("://"))
        throw new ExecError(`sox ${effect}: ${token} is refused`);
      if (effect === "spectrogram" && token === "-o") {
        const value = args[++i];
        if (value === undefined) throw new ExecError("sox spectrogram -o needs a file");
        this.checkValue("output", value, "spectrogram -o");
      }
    }
    return { argv: ["sox", ...args], outputs: this.outputs, outdirs: this.outdirs };
  }

  /** Check one value against its role; returns the resolved relative path for path roles. */
  checkValue(role: ArgRole, value: string, where: string): string | undefined {
    if (Array.isArray(role)) {
      if (!role.includes(value)) throw new ExecError(`${this.tool} ${where} must be one of ${role.join(", ")}`);
      return undefined;
    }
    switch (role) {
      case "number":
        if (!Number.isFinite(Number(value))) throw new ExecError(`${this.tool} ${where} must be a number`);
        return undefined;
      case "word":
        if (!WORD.test(value)) throw new ExecError(`${this.tool} ${where}: "${value}" is not a plain word`);
        return undefined;
      case "text":
        if (value.includes("://")) throw new ExecError(`${this.tool} ${where}: URLs are only accepted by yt-dlp`);
        return undefined;
      case "filter":
        this.checkFilter(value, where);
        return undefined;
      case "url":
        this.checkUrl(value);
        return undefined;
      case "template":
        return undefined;
      case "input":
        return this.input(value, where);
      case "output":
        return this.output(value, where, false);
      case "outdir":
        return this.output(value, where, true);
    }
  }

  private checkUrl(value: string): void {
    if (this.tool !== "yt-dlp") throw new ExecError(`${this.tool}: URLs are only accepted by yt-dlp`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ExecError(`yt-dlp: ${value} is not a URL`);
    }
    if (url.protocol !== "https:") throw new ExecError("yt-dlp: only https:// URLs");
    if (url.username || url.password) throw new ExecError("yt-dlp: URLs with credentials are refused");
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      /^[\d.]+$/.test(host) ||
      host.includes(":") ||
      host.startsWith("[")
    )
      throw new ExecError("yt-dlp: local and IP-address hosts are refused");
  }

  private checkFilter(graph: string, where: string): void {
    // Split into filters on , ; outside quotes and brackets.
    const filters: string[] = [];
    let depth = 0;
    let quote = false;
    let current = "";
    for (let i = 0; i < graph.length; i += 1) {
      const c = graph[i]!;
      if (c === "\\" && i + 1 < graph.length) {
        current += c + graph[++i]!;
        continue;
      }
      if (c === "'") quote = !quote;
      else if (!quote && c === "[") depth += 1;
      else if (!quote && c === "]") depth -= 1;
      if (!quote && depth === 0 && (c === "," || c === ";")) {
        filters.push(current);
        current = "";
        continue;
      }
      current += c;
    }
    filters.push(current);
    for (const raw of filters) {
      const body = raw.trim().replace(/^(\[[^\]]*\]\s*)+/, "").replace(/(\s*\[[^\]]*\])+$/, "");
      if (!body) continue;
      const eq = body.indexOf("=");
      const name = (eq < 0 ? body : body.slice(0, eq)).trim().replace(/@.*$/, "").toLowerCase();
      if (!/^[a-z0-9_]+$/.test(name)) throw new ExecError(`${this.tool} ${where}: bad filter name "${name}"`);
      if ((FFMPEG_REFUSED_FILTERS as readonly string[]).includes(name))
        throw new ExecError(`${this.tool} ${where}: the ${name} filter is refused (it loads code or reads files)`);
      if (eq < 0) continue;
      const options = body.slice(eq + 1);
      for (const part of options.split(":")) {
        const kv = part.indexOf("=");
        const key = kv < 0 ? "" : part.slice(0, kv).trim().toLowerCase();
        const value = (kv < 0 ? part : part.slice(kv + 1)).trim().replace(/^'|'$/g, "");
        if (value.includes("://")) throw new ExecError(`${this.tool} ${where}: URLs are refused in filters`);
        const pathLike = value.startsWith("/") || value.startsWith("~") || value.includes("..");
        if ((key && FILTER_FILE_KEYS.has(key)) || pathLike) this.input(value, `${where} ${name}`);
      }
    }
  }

  private inside(real: string, roots: readonly string[]): boolean {
    return roots.some((root) => real === root || real.startsWith(root + sep));
  }

  private input(value: string, where: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))
      throw new ExecError(`${this.tool} ${where}: protocol inputs (${value.split(":")[0]}:) are refused`);
    const candidate = isAbsolute(value) ? value : resolve(this.root, value);
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      throw new ExecError(`${this.tool} ${where}: ${value} does not exist`);
    }
    const roots = [this.root, ...(this.ctx.readRoots ?? []).map((r) => safeReal(r)).filter((r): r is string => !!r)];
    if (!this.inside(real, roots)) throw new ExecError(`${this.tool} ${where}: ${value} is outside the project`);
    return relative(this.root, real).split(sep).join("/");
  }

  private output(value: string, where: string, directory: boolean): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value))
      throw new ExecError(`${this.tool} ${where}: protocol outputs (${value.split(":")[0]}:) are refused`);
    const candidate = isAbsolute(value) ? resolve(value) : resolve(this.root, value);
    const rel = relative(this.root, candidate);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new ExecError(`${this.tool} ${where}: ${value} is outside the project`);
    const posix = rel.split(sep).join("/");
    if (!(this.ctx.writeScope ?? defaultWriteScope)(posix))
      throw new ExecError(`${this.tool} ${where}: ${posix} is outside the write scope`);
    // Every existing ancestor must stay inside (symlinked folders cannot leave).
    let probe = directory ? candidate : dirname(candidate);
    for (;;) {
      if (existsSync(probe)) {
        const real = realpathSync(probe);
        if (!this.inside(real, [this.root]))
          throw new ExecError(`${this.tool} ${where}: ${value} escapes the project through a symlink`);
        break;
      }
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (!directory && existsSync(candidate)) {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink() || !info.isFile())
        throw new ExecError(`${this.tool} ${where}: ${posix} exists and is not a regular file`);
    }
    (directory ? this.outdirs : this.outputs).push(posix);
    return posix;
  }

  private checkTemplate(template: string, pathsDir: string | undefined): void {
    if (template.includes("..")) throw new ExecError("yt-dlp -o must not contain ..");
    const literal = template.replace(/%\([^)]*\)[-#0 +]*\d*\.?\d*[a-zA-Z]/g, "x");
    if (/%/.test(literal)) throw new ExecError("yt-dlp -o: unsupported template");
    this.output(pathsDir && !isAbsolute(literal) ? join(pathsDir, literal) : literal, "-o", false);
  }
}

function safeReal(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ queue

let running = 0;
const waiting: Array<() => void> = [];

async function acquire(signal?: AbortSignal): Promise<() => void> {
  const release = () => {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  if (running < EXEC_LIMITS.slots) {
    running += 1;
    return release;
  }
  await new Promise<void>((resolveWait, reject) => {
    const go = () => {
      signal?.removeEventListener("abort", onAbort);
      running += 1;
      resolveWait();
    };
    const onAbort = () => {
      const index = waiting.indexOf(go);
      if (index >= 0) waiting.splice(index, 1);
      reject(new ExecError("cancelled while queued"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.push(go);
  });
  return release;
}

// ------------------------------------------------------------------ run

/** Files (relative) with size+mtime under `dirs`, bounded. */
function snapshot(root: string, dirs: readonly string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (abs: string, depth: number) => {
    if (seen.size > 4000 || depth > 4) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile()) {
        try {
          const info = statSync(path);
          seen.set(relative(root, path).split(sep).join("/"), `${info.size}:${info.mtimeMs}`);
        } catch {
          // Gone between readdir and stat.
        }
      }
    }
  };
  for (const dir of new Set(dirs)) walk(join(root, dir), 0);
  return seen;
}

class Tail {
  private text = "";
  push(chunk: string): void {
    this.text = (this.text + chunk).slice(-EXEC_LIMITS.tailBytes * 2);
  }
  value(): string {
    const bytes = Buffer.from(this.text);
    return bytes.length <= EXEC_LIMITS.tailBytes
      ? this.text
      : bytes.subarray(bytes.length - EXEC_LIMITS.tailBytes).toString("utf8").replace(/^�+/, "");
  }
}

function newLogId(): string {
  const random = crypto.getRandomValues(new Uint8Array(4));
  return `${Date.now().toString(36)}-${Buffer.from(random).toString("hex")}`;
}

/** Run one checked command; throws ExecError on a refusal or missing tool. */
export async function runExec(request: ExecRequest, ctx: ExecContext): Promise<ExecResult> {
  const checked = checkExecArgv(request.argv, ctx);
  if (!checked.ok) throw new ExecError(checked.reason);
  const timeoutMs = Math.min(
    EXEC_LIMITS.maxTimeoutMs,
    Math.max(1000, Math.round(request.timeoutMs ?? EXEC_LIMITS.defaultTimeoutMs)),
  );
  const tool = checked.argv[0]!;
  let command = ctx.runner.which(tool);
  let prefix: string[] = [];
  const env: Record<string, string> = {
    PATH: ctx.path ?? process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
  };
  if (!command && (tool === "demucs" || tool === "basic-pitch")) {
    const uv = ctx.runner.which("uv");
    if (uv && (await uvInstalledTools(ctx.runner, ctx.signal)).has(tool)) {
      command = uv;
      prefix = ["tool", "run", "--offline", tool];
      env.UV_OFFLINE = "1";
    }
  }
  if (!command) {
    const hint = (EXEC_INSTALL as Record<string, string>)[tool];
    throw new ExecError(`${tool} is not installed${hint ? `; install with: ${hint}` : ""} (dawg never installs tools)`);
  }
  const root = realpathSync(ctx.root);
  const logId = newLogId();
  const tmp = join(root, ".dawg", "tmp", "exec", logId);
  const logDir = join(root, ".dawg", "logs", "exec");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  env.HOME = tmp;
  env.TMPDIR = tmp;
  const logPath = join(logDir, `${logId}.log`);
  const watch = [
    ...checked.outputs.map((path) => dirname(path)),
    ...checked.outdirs,
    ...(ctx.trackSlug ? [`tracks/${ctx.trackSlug}/samples`, `tracks/${ctx.trackSlug}/downloads`] : []),
    ...(tool === "demucs" && checked.outdirs.length === 0 ? ["separated"] : []),
  ];
  const before = snapshot(root, watch);
  for (const out of checked.outputs) mkdirSync(join(root, dirname(out)), { recursive: true });
  for (const out of checked.outdirs) mkdirSync(join(root, out), { recursive: true });

  const enqueued = Date.now();
  const release = await acquire(ctx.signal);
  const queuedMs = Date.now() - enqueued;
  const started = Date.now();
  const fd = openSync(logPath, "w");
  let logged = 0;
  let logTruncated = false;
  const header = `$ ${checked.argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}\n`;
  writeSync(fd, header);
  logged += Buffer.byteLength(header);
  const outTail = new Tail();
  const errTail = new Tail();
  let lastProgress = 0;
  let timedOut = false;
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      const child = spawn(command!, [...prefix, ...checked.argv.slice(1)], {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let escalate: ReturnType<typeof setTimeout> | undefined;
      const killGroup = () => {
        if (escalate || child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
        escalate = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // Already gone.
          }
        }, EXEC_LIMITS.killGraceMs);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutMs);
      const onAbort = () => killGroup();
      if (ctx.signal?.aborted) killGroup();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const sink = (tail: Tail, isErr: boolean) => (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        tail.push(text);
        if (logged < EXEC_LIMITS.logCapBytes) {
          const room = EXEC_LIMITS.logCapBytes - logged;
          const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
          writeSync(fd, slice);
          logged += slice.length;
          if (slice.length < chunk.length) logTruncated = true;
        } else logTruncated = true;
        if (isErr && ctx.progress && Date.now() - lastProgress > 250) {
          const line = text.split(/[\r\n]+/).filter((l) => l.trim()).pop();
          if (line) {
            lastProgress = Date.now();
            ctx.progress(`${tool} ${line.trim().slice(0, 120)}`);
          }
        }
      };
      child.stdout!.on("data", sink(outTail, false));
      child.stderr!.on("data", sink(errTail, true));
      child.on("error", (error) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        rejectExit(new ExecError(`${tool} failed to start: ${error.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (escalate) clearTimeout(escalate);
        ctx.signal?.removeEventListener("abort", onAbort);
        // Make sure nothing in the group outlives the leader.
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Group already empty.
        }
        resolveExit(code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1));
      });
    });
  } finally {
    release();
    closeSync(fd);
  }
  const ms = Date.now() - started;
  const after = snapshot(root, watch);
  const outputs: string[] = [];
  for (const [path, stamp] of after) {
    if (before.get(path) === stamp) continue;
    outputs.push(path);
    if (outputs.length >= EXEC_LIMITS.maxOutputs) break;
  }
  outputs.sort();
  const logRel = relative(root, logPath).split(sep).join("/");
  const result: ExecResult = {
    exitCode,
    ms,
    stdoutTail: outTail.value(),
    stderrTail: errTail.value(),
    logId,
    logPath: logRel,
    outputs,
    queuedMs,
    argv: checked.argv,
    ...(timedOut ? { timedOut: true } : {}),
    ...(logTruncated ? { logTruncated: true } : {}),
  };
  recordHistory(result, ctx);
  return result;
}

function recordHistory(result: ExecResult, ctx: ExecContext): void {
  const history = ctx.history ?? historySink();
  if (!history) return;
  const base = { actor: ctx.actor ?? { kind: "agent" as const } };
  try {
    history.append({
      ...base,
      kind: "tool",
      sub: "exec",
      summary: `exec ${result.argv[0]} · exit ${result.exitCode} · ${result.ms} ms`,
      payload: { argv: result.argv, exitCode: result.exitCode, ms: result.ms, logId: result.logId },
    });
    for (const path of result.outputs)
      history.append({
        ...base,
        kind: "asset",
        sub: "exec",
        summary: `exec ${result.argv[0]} → ${path}`,
        payload: { path, logId: result.logId },
        targets: [{ type: "file", key: path }],
      });
  } catch {
    // History is best effort; the files are already on disk.
  }
}

/** Page through a saved exec log: 4 KiB from `offset`. */
export function readExecLog(
  rootDir: string,
  logId: string,
  offset = 0,
): Readonly<{ logId: string; offset: number; nextOffset?: number; size: number; text: string }> {
  if (!LOG_ID.test(logId)) throw new ExecError(`no exec log ${logId}`);
  const path = join(realpathSync(rootDir), ".dawg", "logs", "exec", `${logId}.log`);
  let size: number;
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw new ExecError(`no exec log ${logId}`);
  }
  const start = Math.max(0, Math.min(size, Math.floor(offset)));
  const length = Math.min(EXEC_LIMITS.pageBytes, size - start);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const end = start + length;
  return {
    logId,
    offset: start,
    ...(end < size ? { nextOffset: end } : {}),
    size,
    text: buffer.toString("utf8"),
  };
}
