/**
 * Per-project agent settings the human controls: `.dawg/agent.json`.
 *
 * - `readRoots`: absolute directories outside the project the agent may read
 *   (never write), e.g. a sample library. Realpath-confined like the project.
 * - `shell`: the trusted-shell switch for the exec tool (any program on PATH,
 *   still no shell interpreter unless asked, still blocked after untrusted
 *   content). Off by default.
 *
 * The file sits under `.dawg/`, which every agent file tool refuses to write,
 * and no agent tool imports the setters below: only the typed `/agent`
 * command, its Ctrl-K rows and `dawg agent` change them. Reading tolerates a
 * missing or malformed file (defaults); writing is atomic and keeps unknown
 * keys so a newer dawg's fields survive an older one.
 */

import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { RUNTIME_DIR } from "./workspace.ts";

export const AGENT_SETTINGS_FILE = "agent.json";
/** At most this many read roots; each path at most 1024 characters. */
export const MAX_READ_ROOTS = 16;
const MAX_PATH_CHARS = 1_024;
const MAX_FILE_BYTES = 64 * 1024;

export type AgentSettings = Readonly<{
  readRoots: readonly string[];
  shell: boolean;
}>;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = Object.freeze({
  readRoots: Object.freeze([]) as readonly string[],
  shell: false,
});

export class AgentSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSettingsError";
  }
}

export function agentSettingsPath(projectRoot: string): string {
  return join(projectRoot, RUNTIME_DIR, AGENT_SETTINGS_FILE);
}

/** Parse foreign JSON into settings; anything invalid falls back per field. */
export function parseAgentSettings(value: unknown): AgentSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return DEFAULT_AGENT_SETTINGS;
  const record = value as Record<string, unknown>;
  const roots = Array.isArray(record.readRoots)
    ? record.readRoots
        .filter(
          (root): root is string =>
            typeof root === "string" &&
            root.length > 0 &&
            root.length <= MAX_PATH_CHARS &&
            !root.includes("\0") &&
            isAbsolute(root),
        )
        .slice(0, MAX_READ_ROOTS)
    : [];
  return Object.freeze({
    readRoots: Object.freeze([...new Set(roots)]),
    shell: record.shell === true,
  });
}

async function readRaw(projectRoot: string): Promise<Record<string, unknown>> {
  try {
    const path = agentSettingsPath(projectRoot);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return {};
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The project's agent settings; defaults when the file is absent or bad. */
export async function readAgentSettings(
  projectRoot: string,
): Promise<AgentSettings> {
  return parseAgentSettings(await readRaw(projectRoot));
}

async function writeRaw(
  projectRoot: string,
  raw: Record<string, unknown>,
): Promise<void> {
  const path = agentSettingsPath(projectRoot);
  await mkdir(join(projectRoot, RUNTIME_DIR), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

/** `~/x` → home-relative; relative paths resolve against `cwd`. */
export function expandRootPath(input: string, cwd: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(cwd, trimmed);
}

/**
 * Human-only: add a read root. The directory must exist; it is stored by
 * realpath so a later symlink swap cannot widen it. Returns the new settings.
 */
export async function addReadRoot(
  projectRoot: string,
  input: string,
  cwd: string = projectRoot,
): Promise<AgentSettings> {
  if (!input.trim()) throw new AgentSettingsError("read-root needs a path");
  if (input.includes("\0")) throw new AgentSettingsError("bad path");
  const absolute = expandRootPath(input, cwd);
  let real: string;
  try {
    real = await realpath(absolute);
    if (!(await stat(real)).isDirectory())
      throw new AgentSettingsError(`${input} is not a directory`);
  } catch (error) {
    if (error instanceof AgentSettingsError) throw error;
    throw new AgentSettingsError(`${input} does not exist`);
  }
  if (real.length > MAX_PATH_CHARS)
    throw new AgentSettingsError("path is too long");
  const projectReal = await realpath(projectRoot).catch(() => projectRoot);
  if (real === projectReal || real.startsWith(`${projectReal}/`))
    throw new AgentSettingsError(
      "that folder is inside the project; the agent can already read it",
    );
  const raw = await readRaw(projectRoot);
  const current = parseAgentSettings(raw);
  if (current.readRoots.includes(real)) return current;
  if (current.readRoots.length >= MAX_READ_ROOTS)
    throw new AgentSettingsError(`at most ${MAX_READ_ROOTS} read roots`);
  const next = { ...raw, readRoots: [...current.readRoots, real] };
  await writeRaw(projectRoot, next);
  return parseAgentSettings(next);
}

/** Human-only: remove a read root (by its stored path or the typed one). */
export async function removeReadRoot(
  projectRoot: string,
  input: string,
  cwd: string = projectRoot,
): Promise<AgentSettings> {
  const raw = await readRaw(projectRoot);
  const current = parseAgentSettings(raw);
  const absolute = expandRootPath(input, cwd);
  const real = await realpath(absolute).catch(() => absolute);
  const kept = current.readRoots.filter(
    (root) => root !== absolute && root !== real,
  );
  if (kept.length === current.readRoots.length)
    throw new AgentSettingsError(`${input} is not a read root`);
  const next = { ...raw, readRoots: kept };
  await writeRaw(projectRoot, next);
  return parseAgentSettings(next);
}

/** Human-only: the trusted-shell switch for exec. */
export async function setTrustedShell(
  projectRoot: string,
  on: boolean,
): Promise<AgentSettings> {
  const raw = await readRaw(projectRoot);
  const next = { ...raw, shell: on };
  await writeRaw(projectRoot, next);
  return parseAgentSettings(next);
}
