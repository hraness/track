/**
 * `/agent read-root add|remove|list [path]` and `/agent shell on|off`
 * (design §6.2): the human-only switches in `.dawg/agent.json`. They are
 * window commands, so `commandParses` never accepts them and the agent
 * cannot type them through show-me; no agent tool imports the setters.
 */
import {
  addReadRoot,
  AgentSettingsError,
  readAgentSettings,
  removeReadRoot,
  setTrustedShell,
} from "../agent/settings.ts";

export const AGENT_SETTINGS_USAGE =
  "usage · /agent read-root add|remove|list [path] · /agent shell on|off";

export type AgentSettingsCommand =
  | Readonly<{ kind: "read-root"; action: "list" }>
  | Readonly<{ kind: "read-root"; action: "add" | "remove"; path: string }>
  | Readonly<{ kind: "shell"; on?: boolean }>;

/** The argument after `/agent`; undefined when it is not one of these. */
export function parseAgentSettingsCommand(
  arg: string,
): AgentSettingsCommand | undefined {
  const text = arg.trim();
  const root = /^read-?roots?(?:\s+(list|add|remove|rm)(?:\s+(.+))?)?$/i.exec(
    text,
  );
  if (root) {
    const verb = (root[1] ?? "list").toLowerCase();
    const path = root[2]?.trim();
    if (verb === "list")
      return path ? undefined : { kind: "read-root", action: "list" };
    if (!path) return undefined;
    return {
      kind: "read-root",
      action: verb === "add" ? "add" : "remove",
      path,
    };
  }
  const shell = /^shell(?:\s+(on|off))?$/i.exec(text);
  if (shell)
    return shell[1] === undefined
      ? { kind: "shell" }
      : { kind: "shell", on: shell[1].toLowerCase() === "on" };
  return undefined;
}

export type AgentSettingsResult = Readonly<{
  ok: boolean;
  message: string;
  /** For list: one line per read root, to show in a text pane. */
  lines?: readonly string[];
}>;

/** Run one parsed command against the project's `.dawg/agent.json`. */
export async function runAgentSettingsCommand(
  arg: string,
  projectRoot: string,
  cwd: string = projectRoot,
): Promise<AgentSettingsResult> {
  const command = parseAgentSettingsCommand(arg);
  if (!command) return { ok: false, message: AGENT_SETTINGS_USAGE };
  try {
    if (command.kind === "shell") {
      if (command.on === undefined) {
        const settings = await readAgentSettings(projectRoot);
        return {
          ok: true,
          message: `trusted shell ${settings.shell ? "on" : "off"} · /agent shell on|off`,
        };
      }
      await setTrustedShell(projectRoot, command.on);
      return {
        ok: true,
        message: command.on
          ? "trusted shell on · the agent's exec may run any command line in this project (off after untrusted content)"
          : "trusted shell off · exec runs only its allowlisted tools",
      };
    }
    if (command.action === "list") {
      const { readRoots } = await readAgentSettings(projectRoot);
      return readRoots.length === 0
        ? {
            ok: true,
            message:
              "no read roots · the agent reads only this project · /agent read-root add <folder>",
            lines: [],
          }
        : {
            ok: true,
            message: `${readRoots.length} read root${readRoots.length === 1 ? "" : "s"} · the agent may read, never write, these folders`,
            lines: readRoots,
          };
    }
    if (command.action === "add") {
      const settings = await addReadRoot(projectRoot, command.path, cwd);
      const added = settings.readRoots.at(-1) ?? command.path;
      return {
        ok: true,
        message: `read root added · ${added} · the agent may read it, never write`,
      };
    }
    await removeReadRoot(projectRoot, command.path, cwd);
    return { ok: true, message: `read root removed · ${command.path}` };
  } catch (error) {
    if (error instanceof AgentSettingsError)
      return { ok: false, message: error.message };
    throw error;
  }
}
