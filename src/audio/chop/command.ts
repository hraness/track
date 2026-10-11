/**
 * Typed `/chop <op> <file> [values] [--flags]` (also `chop …`). `/chop`
 * alone opens the help card; `/chop audition <file>` plays it. Same words as
 * `dawg media chop`, same `runChop` as the agent `audio` tool.
 */
import { errorMessage } from "../../media/vendor/util.ts";
import type { ChopArgs, ChopOp } from "./types.ts";
import { chopFromWords, chopUsage } from "./words.ts";

export type ChopCommand =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "run"; op: ChopOp; args: ChopArgs }>
  | Readonly<{ kind: "error"; message: string }>;

export function parseChopCommand(command: string): ChopCommand | undefined {
  const words = command.trim().split(/\s+/);
  const head = words[0]?.toLowerCase();
  if (head !== "/chop" && head !== "chop") return undefined;
  const rest = words.slice(1);
  if (rest.length === 0 || rest[0] === "help") return { kind: "help" };
  try {
    const { op, args } = chopFromWords(rest);
    return { kind: "run", op, args };
  } catch (error) {
    return { kind: "error", message: `chop · ${errorMessage(error)} · /chop lists ops` };
  }
}

/** The `/chop` help card. */
export function chopHelpLines(): string[] {
  return [
    "Inspect and chop audio files; edits write new WAVs (originals are never changed).",
    "",
    ...chopUsage("/chop ").split("\n"),
    "",
    "Times: 1.5 · 1.5s · 350ms · 1:02 · bar:9.1 · -2s (from the end).",
    "Files: project-relative, or a name in the focused track's downloads/ or samples/.",
    "Outputs go to tracks/<track>/samples/ · --out PATH picks the file.",
    "Shell: dawg media chop <op> … · agent: the audio tool · guide: chop.",
  ];
}
