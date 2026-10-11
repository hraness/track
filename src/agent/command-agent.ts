/**
 * Command mode (show-me): the agent acts by writing dawg prompt commands, one
 * per line, the way a human types them. Each line runs through the host's
 * command path (the same parser and commit a typed Enter uses) the moment
 * it is complete, while the model is still streaming the next one, so the
 * score changes during the turn. The partial line is reported as it grows
 * (`command-typing`) for the prompt bar's ghost text. A small JSON tool set
 * stays for what commands cannot express: workspace files, the web, media
 * and measuring. Measured against the JSON tool loop on the same tasks this
 * sends about a ninth of the input tokens and finishes in about half the
 * time (docs/show-me.md).
 */
import { newId } from "../../core/ids.ts";
import { HELP_SECTIONS } from "../commands/help.ts";
import { MEDIA_TOOLS } from "../media/tools.ts";
import {
  AGENT_LIMITS,
  MEDIA_PROMPT,
  DISPATCH_PROMPT,
  WORKSPACE_PROMPT,
  classifyAgentError,
  executeCall,
  type TurnState,
  hostProjectOutline,
  tighten,
  turnDeadline,
  type AgentEvent,
  type AgentTurnOptions,
  type AgentTurnResult,
} from "./agent.ts";
import { compositionBrief } from "./brief.ts";
import type { ChatMessage, ChatToolCall } from "./gateway.ts";
import { CommandLines } from "./show-me.ts";
import { AGENT_TOOLS, chatTools } from "./tools.ts";
import { SseBudgetError } from "./sse.ts";

/** What a host does with one complete command line. */
export type CommandOutcome = Readonly<{
  ok: boolean;
  /** The receipt a human would see (`tempo · 96`) or the error. */
  message: string;
  baseRevision: number;
  resultRevision: number;
}>;

export type CommandHost = Readonly<{
  /** Whether a complete line is a song-editing command (else it is prose). */
  isCommand(line: string): boolean;
  /** Run a line exactly as if the user had typed it and pressed Enter. */
  run(line: string): Promise<CommandOutcome>;
}>;

/** The tools a command-mode model still gets: what commands cannot say. */
export const COMMAND_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "web_search",
  "fetch_url",
  "explain",
  "preview_sound",
  "measure_mix",
  ...MEDIA_TOOLS.map((tool) => tool.name),
]);

/** Steps per command-mode turn: each extra one is a correction round. */
export const COMMAND_MAX_STEPS = 4;

/** Reference groups the command agent is not shown. */
const AGENT_SKIPS: ReadonlySet<string> = new Set([
  "project · window",
  "project · panes",
  "project · audio",
  "agent",
]);

function commandReference(): string {
  // Song commands only. Panes, audio devices and the window groups change the person's window or
  // machine; the clipboard row is a two-step buffer the agent never needs.
  return HELP_SECTIONS.filter((section) => !AGENT_SKIPS.has(section.group))
    .flatMap((section) =>
      section.entries
        .filter(
          (entry) => !/\bpaste\b/.test(`${entry.command} ${entry.summary}`),
        )
        .map((entry) => `${entry.command} — ${entry.summary}`),
    )
    .join("\n");
}

export const COMMAND_AGENT_PROMPT = [
  "You are dawg, a loop composer inside a terminal music workstation, and you teach it by doing.",
  "Act by writing dawg prompt commands, exactly as a human types them in the prompt bar, one per line. The user watches each command appear in their prompt bar as you write it, and each line runs the moment it ends, so they learn the commands by watching you.",
  "Prefer the gestures a person would use: a parameter as one value command (fx reverb mix 0.4, volume 0.7, pan -0.3, which the user sees as a fader moving), notes one per line with add (add C4 at 0 for 0.5, played on the user's keyboard as you write them), drums with hit, pattern and euclid on a kit track, a whole groove with groove <name>.",
  "To arrange, name bars: loop 5-6 loops them, copy bass 5-6 to 7 and move bass 5-6 to 9 place them in one step, clear bass 5-6 empties them. Never copy to the clipboard and paste.",
  "Commands apply to the focused track. /track <name> focuses a track or creates it; instrument kit makes a drum track. Times are beats from 0: in 4/4 musicians' beats 2 and 4 are beats 1 and 3 here, and bar n starts at (n-1)×beats per bar.",
  "Write commands first, with no numbering, quotes or code fences. Then write one short plain sentence (not a command) that says what changed and names the key command so the user can do it by hand next time.",
  "If a command fails you get its error; correct it with another command or stop.",
  "Use the tools only for what commands cannot do: project files, the web, media, previewing and measuring.",
  WORKSPACE_PROMPT,
  MEDIA_PROMPT,
  DISPATCH_PROMPT,
].join(" ");

/** The system prompt with the command reference, built once. */
let systemPrompt: string | undefined;
export function commandAgentSystemPrompt(): string {
  systemPrompt ??= `${COMMAND_AGENT_PROMPT}\n\nCommands:\n${commandReference()}\n/track <name> — focus or create a track`;
  return systemPrompt;
}

export type CommandAgentTurnOptions = AgentTurnOptions &
  Readonly<{ commands: CommandHost }>;

/**
 * One command-mode turn. Lines run in order on one chain, so a slow command
 * never reorders the next, and reading the stream never waits on them.
 */
export async function runCommandAgentTurn(
  options: CommandAgentTurnOptions,
): Promise<AgentTurnResult> {
  const limits = {
    maxSteps: Math.min(
      COMMAND_MAX_STEPS,
      tighten(options.budget?.maxSteps, AGENT_LIMITS.maxSteps),
    ),
    maxToolCalls: tighten(
      options.budget?.maxToolCalls,
      AGENT_LIMITS.maxToolCalls,
    ),
    maxResponseBytes: tighten(
      options.budget?.maxResponseBytes,
      AGENT_LIMITS.maxResponseBytes,
    ),
    timeoutMs: tighten(options.budget?.timeoutMs, AGENT_LIMITS.timeoutMs),
  };
  const emit = (event: AgentEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A rendering failure must never corrupt the turn.
    }
  };
  const allTools = options.tools ?? AGENT_TOOLS;
  const offered = chatTools(
    allTools.filter((tool) => COMMAND_MODE_TOOL_NAMES.has(tool.name)),
  );
  const turnId = options.turnId ?? newId("turn");
  const turnState: TurnState = { untrusted: false };
  const newNoteId =
    options.newNoteId ??
    ((trackId: string, _revision: number, _index: number) => newId(trackId));
  const deadline = turnDeadline(limits.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const currentRevision = () => options.host.snapshot().revision;
  const turnStartRevision = currentRevision();

  let applied = 0;
  let rejected = 0;
  let toolCalls = 0;
  let bytesUsed = 0;
  let finalText = "";
  const messages: ChatMessage[] = [
    { role: "user", content: options.prompt.slice(0, 8_000) },
  ];
  const finish = (result: AgentTurnResult): AgentTurnResult => {
    deadline.clear();
    emit(result);
    return result;
  };
  const done = (reason: "stop" | "max-steps" | "max-tool-calls") =>
    finish({
      type: "done",
      reason,
      text: finalText,
      applied,
      rejected,
      revision: currentRevision(),
    });

  try {
    for (let step = 1; step <= limits.maxSteps; step += 1) {
      if (signal.aborted) throw signal.reason;
      for (const steer of options.host.takeSteering?.() ?? [])
        messages.push({
          role: "user",
          content: `Steering from the user mid-turn: ${steer.slice(0, 2_000)}`,
        });
      emit({ type: "step", step });
      const snapshot = options.host.snapshot();
      const brief = compositionBrief({
        ...snapshot,
        project: await hostProjectOutline(options.host, snapshot),
      });
      const briefText =
        snapshot.revision === turnStartRevision
          ? `Composition brief (JSON): ${brief}`
          : `Composition brief (JSON, current score at revision ${snapshot.revision}: it already includes every command you ran this turn; do not repeat them): ${brief}`;
      const remaining = limits.maxResponseBytes - bytesUsed;
      if (remaining <= 0) throw new SseBudgetError(limits.maxResponseBytes);

      const lines = new CommandLines();
      let text = "";
      const prose: string[] = [];
      const results: string[] = [];
      let failed = 0;
      let chain: Promise<void> = Promise.resolve();
      const runLine = (line: string) => {
        if (!options.commands.isCommand(line)) {
          prose.push(line);
          return;
        }
        if (toolCalls >= limits.maxToolCalls) return;
        toolCalls += 1;
        const callId = `cmd-${step}-${toolCalls}`;
        chain = chain.then(async () => {
          if (signal.aborted) return;
          emit({ type: "tool-start", callId, name: "command", step });
          let outcome: CommandOutcome;
          try {
            outcome = await options.commands.run(line);
          } catch (error) {
            outcome = {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
              baseRevision: currentRevision(),
              resultRevision: currentRevision(),
            };
          }
          emit({ type: "command", line, ...outcome });
          if (outcome.ok) {
            if (outcome.resultRevision !== outcome.baseRevision) applied += 1;
            results.push(`${line} → ${outcome.message}`);
          } else {
            failed += 1;
            rejected += 1;
            results.push(`${line} → FAILED: ${outcome.message}`);
          }
        });
      };
      const pending = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let typing = "";
      for await (const event of options.client.stream(
        {
          model: options.model,
          ...(options.fallbackModel
            ? { fallbackModelId: options.fallbackModel }
            : {}),
          messages: [
            { role: "system", content: commandAgentSystemPrompt() },
            { role: "system", content: briefText },
            ...messages,
          ],
          ...(offered.length > 0 ? { tools: offered } : {}),
          maxResponseBytes: remaining,
        },
        signal,
      )) {
        if (event.type === "usage") {
          const { type: _type, ...usage } = event;
          emit({ type: "usage", ...usage });
        } else if (event.type === "activity") {
          emit({ type: "activity", message: event.message });
        } else if (event.type === "text") {
          bytesUsed += event.delta.length;
          if (text.length >= AGENT_LIMITS.maxTextChars) continue;
          text += event.delta;
          const { complete, partial } = lines.push(event.delta);
          for (const line of complete) runLine(line);
          if (partial !== typing) {
            typing = partial;
            emit({ type: "command-typing", text: partial });
          }
        } else if (event.type === "tool-delta") {
          const call = pending.get(event.index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (event.id) call.id = event.id;
          if (event.name) call.name += event.name;
          if (event.arguments) {
            call.arguments += event.arguments;
            bytesUsed += event.arguments.length;
            if (call.arguments.length > AGENT_LIMITS.maxToolArgumentBytes)
              throw new SseBudgetError(AGENT_LIMITS.maxToolArgumentBytes);
          }
          pending.set(event.index, call);
        }
      }
      const last = lines.flush();
      if (last) runLine(last);
      if (typing) emit({ type: "command-typing", text: "" });
      await chain;
      if (signal.aborted) throw signal.reason;
      if (prose.length > 0) {
        finalText = prose.join(" ");
        emit({ type: "text-delta", delta: finalText });
      }

      const calls = [...pending.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => ({
          ...call,
          id: call.id || `call-${step}-${index}`,
        }));
      if (calls.length === 0 && failed === 0) return done("stop");
      if (calls.length > 0) {
        const assistantCalls: ChatToolCall[] = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        }));
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: assistantCalls,
        });
        for (const call of calls) {
          if (signal.aborted) throw signal.reason;
          toolCalls += 1;
          emit({ type: "tool-start", callId: call.id, name: call.name, step });
          const outcome = await executeCall(call, {
            turnId,
            turnState,
            tools: allTools,
            host: options.host,
            newNoteId,
            signal,
            suspendTimeout: deadline.suspend,
            emit,
            onProgress: (line) =>
              emit({
                type: "tool-progress",
                callId: call.id,
                name: call.name,
                line,
              }),
          });
          if (outcome.ok) {
            applied += outcome.mutated ? 1 : 0;
            if (outcome.explanation) finalText = outcome.explanation;
            emit(outcome.event);
          } else {
            rejected += 1;
            emit({
              type: "tool-rejected",
              callId: call.id,
              name: call.name,
              diagnostic: outcome.diagnostic,
            });
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: outcome.content,
          });
        }
      } else messages.push({ role: "assistant", content: text });
      if (results.length > 0)
        messages.push({
          role: "user",
          content: `Command results:\n${results.join("\n").slice(0, 6_000)}`,
        });
      if (toolCalls >= limits.maxToolCalls) return done("max-tool-calls");
    }
    return done("max-steps");
  } catch (error) {
    const { code, message } = classifyAgentError(error, signal, options.signal);
    return finish({
      type: "error",
      code,
      message,
      applied,
      revision: currentRevision(),
    });
  } finally {
    deadline.clear();
  }
}
