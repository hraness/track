import { describe, expect, test } from "bun:test";
import {
  applyScoreOperation,
  createScore,
  type ScoreOperation,
  type TrackScore,
} from "../../core/score.ts";
import {
  StaleRevisionError,
  type AgentCommit,
  type AgentHost,
  type AgentTurnResult,
} from "./agent.ts";
import {
  buildScopes,
  formatResults,
  parseTasks,
  runSubagents,
  SpendMeter,
  SubagentScopeError,
  type ChildTurnRunner,
} from "./subagents.ts";
import { AGENT_TOOLS, findAgentTool } from "./tools.ts";
import { executeCall, runAgentTurn, type AgentEvent } from "./agent.ts";
import type { HistoryHandle } from "../history/types.ts";
import { createGatewayClient } from "./gateway.ts";
import {
  finishChunk,
  scriptedFetch,
  textChunk,
  toolCallChunks,
} from "./sse-fixtures.ts";

function base(): TrackScore {
  return createScore({
    tracks: [
      { id: "bass", name: "Bass" },
      { id: "drums", name: "Drums" },
      { id: "keys", name: "Keys" },
    ],
  });
}

/** A strict host like the file port: a stale base revision is rejected. */
function strictHost(initial: TrackScore = base()) {
  const state = {
    score: initial,
    revision: 10,
    commits: [] as AgentCommit[],
  };
  const host: AgentHost = {
    snapshot: () => ({
      score: state.score,
      revision: state.revision,
      focusedTrackId: "bass",
      recentOperations: [],
    }),
    commit: (change) => {
      if (change.baseRevision !== state.revision)
        return Promise.reject(
          new StaleRevisionError(change.baseRevision, state.revision),
        );
      state.score = change.next;
      state.revision += 1;
      state.commits.push(change);
      return Promise.resolve({ revision: state.revision });
    },
  };
  return { state, host };
}

function apply(score: TrackScore, operations: readonly ScoreOperation[]) {
  return operations.reduce(
    (next, operation) => applyScoreOperation(next, operation),
    score,
  );
}

function note(id: string, trackId: string, pitch = 40): ScoreOperation {
  return {
    type: "addNote",
    note: { id, trackId, pitch, velocity: 0.8, start: 0, duration: 1 },
  };
}

function done(text: string): AgentTurnResult {
  return {
    type: "done",
    reason: "stop",
    text,
    applied: 1,
    rejected: 0,
    revision: 0,
  };
}

/** Commits `operations` from the snapshot the child read before `gate`. */
async function childEdit(
  host: AgentHost,
  operations: readonly ScoreOperation[],
  gate?: Promise<void>,
): Promise<void> {
  const snapshot = host.snapshot();
  await gate;
  await host.commit({
    next: apply(snapshot.score, operations),
    operations,
    baseRevision: snapshot.revision,
    toolName: "add_notes",
    callId: "c1",
    summary: `+${operations.length} notes`,
  });
}

function parent(
  host: AgentHost,
  runTurn: ChildTurnRunner,
  signal?: AbortSignal,
) {
  return {
    host,
    runTurn,
    toolNames: ["add_notes", "dispatch", "transport", "set_volume"],
    concurrency: 4,
    signal: signal ?? new AbortController().signal,
    spend: new SpendMeter(),
    callId: "parent-1",
  };
}

describe("dispatch subagents", () => {
  test("concurrent children on different tracks both land, attributed", async () => {
    const { state, host } = strictHost();
    // Both children read revision 10 before either commits, so the second
    // commit is stale and must be replayed onto the first one's result.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const seenTools: string[][] = [];
    const runTurn: ChildTurnRunner = async (input) => {
      seenTools.push([...input.tools]);
      const track = input.prompt.includes("subagent bassline")
        ? "bass"
        : "drums";
      const pending = childEdit(
        input.host,
        [note(`${track}-n1`, track), note(`${track}-n2`, track, 45)],
        gate,
      );
      if (++started === 2) release();
      await pending;
      input.onEvent({ type: "usage", inputTokens: 1200, outputTokens: 80 });
      return done(`wrote ${track}`);
    };
    const tasks = parseTasks([
      { id: "bassline", prompt: "a walking bass", tracks: ["Bass"] },
      { id: "groove", prompt: "a groove", tracks: ["drums"] },
    ]);
    const spend = new SpendMeter();
    const results = await runSubagents(tasks, {
      ...parent(host, runTurn),
      spend,
    });
    expect(results.map((result) => result.status)).toEqual(["done", "done"]);
    expect(state.revision).toBe(12);
    expect(state.score.notes.map((n) => n.id).sort()).toEqual([
      "bass-n1",
      "bass-n2",
      "drums-n1",
      "drums-n2",
    ]);
    // Separate attributed revisions, each tied to the parent's call.
    expect(
      state.commits.map((c) => [c.subagent, c.parentCallId]).sort(),
    ).toEqual([
      ["bassline", "parent-1"],
      ["groove", "parent-1"],
    ]);
    expect(
      state.commits.every((c) => /^\[(bassline|groove)\] /.test(c.summary)),
    ).toBe(true);
    expect(results.flatMap((r) => r.revisions).sort()).toEqual([11, 12]);
    // Children never get dispatch or transport.
    for (const tools of seenTools)
      expect(tools).toEqual(["add_notes", "set_volume"]);
    expect(spend.inputTokens).toBe(2400);
    const text = formatResults(results, spend);
    expect(text).toContain("bassline: done revs");
    expect(text).toContain("total spend: 2.4k in · 160 out");
  });

  test("two tasks on the same track are refused before anything runs", async () => {
    const { state, host } = strictHost();
    let ran = 0;
    const runTurn: ChildTurnRunner = async () => {
      ran++;
      return done("x");
    };
    const tasks = parseTasks([
      { id: "a", prompt: "x", tracks: ["bass"] },
      { id: "b", prompt: "y", tracks: ["Bass"] },
    ]);
    await expect(runSubagents(tasks, parent(host, runTurn))).rejects.toThrow(
      "tasks a and b both write track Bass; give each track to one task",
    );
    expect(ran).toBe(0);
    expect(state.revision).toBe(10);
  });

  test("a concurrent edit to the same track is a reported conflict, not a clobber", async () => {
    const { state, host } = strictHost();
    const runTurn: ChildTurnRunner = async (input) => {
      const snapshot = input.host.snapshot();
      // Someone else (the human, another pane) changes the bass volume after
      // the child read the score.
      const human = apply(state.score, [
        { type: "updateTrack", trackId: "bass", patch: { volume: 0.2 } },
      ]);
      await host.commit({
        next: human,
        operations: [],
        baseRevision: state.revision,
        toolName: "human",
        callId: "h",
        summary: "volume",
      });
      const operations: ScoreOperation[] = [
        { type: "updateTrack", trackId: "bass", patch: { volume: 0.9 } },
      ];
      try {
        await input.host.commit({
          next: apply(snapshot.score, operations),
          operations,
          baseRevision: snapshot.revision,
          toolName: "set_volume",
          callId: "c",
          summary: "volume 0.9",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(StaleRevisionError);
      }
      return done("tried");
    };
    const results = await runSubagents(
      parseTasks([{ id: "mix", prompt: "louder bass", tracks: ["bass"] }]),
      parent(host, runTurn),
    );
    expect(results[0]).toMatchObject({
      id: "mix",
      status: "conflict",
      revisions: [],
    });
    expect(results[0]!.summary).toBe("conflict: bass volume changed");
    expect(state.score.tracks.find((t) => t.id === "bass")!.volume).toBe(0.2);
  });

  test("an edit outside the task's scope is refused", async () => {
    const { state, host } = strictHost();
    let refusal = "";
    const runTurn: ChildTurnRunner = async (input) => {
      try {
        await childEdit(input.host, [note("k1", "keys")]);
      } catch (error) {
        refusal = error instanceof SubagentScopeError ? error.message : "other";
      }
      return done("no");
    };
    await runSubagents(
      parseTasks([{ id: "bassline", prompt: "x", tracks: ["bass"] }]),
      parent(host, runTurn),
    );
    expect(refusal).toStartWith("[bassline] ");
    expect(refusal).toContain("Keys");
    expect(state.revision).toBe(10);
  });

  test("aborting the parent cancels every running child", async () => {
    const { host } = strictHost();
    const controller = new AbortController();
    const runTurn: ChildTurnRunner = (input) =>
      new Promise((resolve) => {
        input.signal.addEventListener("abort", () =>
          resolve({
            type: "error",
            code: "aborted",
            message: "aborted",
            applied: 0,
            revision: 0,
          }),
        );
        controller.abort(new Error("Esc"));
      });
    const results = await runSubagents(
      parseTasks([
        { id: "a", prompt: "x", tracks: ["bass"] },
        { id: "b", prompt: "y", tracks: ["drums"] },
      ]),
      parent(host, runTurn, controller.signal),
    );
    expect(results.map((r) => r.status)).toEqual(["canceled", "canceled"]);
  });

  test("the dispatch tool validates its task list in plan()", () => {
    const tool = findAgentTool("dispatch")!;
    const context = {
      score: base(),
      focusedTrackId: "bass",
      revision: 1,
      newNoteId: () => "n",
    };
    const plan = tool.plan(
      { tasks: [{ id: "a", prompt: "x", tracks: ["bass"], bars: "1-4" }] },
      context,
    );
    expect(plan).toMatchObject({ kind: "dispatch", summary: "dispatch a" });
    expect(() =>
      buildScopes(
        parseTasks([{ id: "a", prompt: "x", tracks: [], files: [".dawg/**"] }]),
        base(),
      ),
    ).toThrow(SubagentScopeError);
  });
});

describe("dispatch through a parent turn", () => {
  test("the parent's dispatch call runs children and reads their lines", async () => {
    const { state, host } = strictHost();
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "d1", "dispatch", {
          tasks: [
            { id: "low", prompt: "bass", tracks: ["bass"] },
            { id: "kit", prompt: "drums", tracks: ["drums"] },
          ],
        }),
        finishChunk("tool_calls"),
      ],
      [textChunk("Dispatched bass and drums."), finishChunk("stop")],
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "bass and drums",
      model: "opus-5.5",
      client: createGatewayClient({
        apiKey: "k",
        baseUrl: "https://gw.test/v1",
        fetcher: script.fetcher,
      }),
      host: {
        ...host,
        subagents: {
          concurrency: 4,
          model: "haiku-5.5",
          runTurn: async (input) => {
            const track = input.prompt.includes("subagent low")
              ? "bass"
              : "drums";
            await childEdit(input.host, [note(`${track}-1`, track)]);
            input.onEvent({
              type: "usage",
              inputTokens: 500,
              outputTokens: 20,
            });
            return done(`${track} done`);
          },
        },
      },
      onEvent: (event) => events.push(event),
    });
    expect(result.type).toBe("done");
    expect(state.commits.map((c) => c.subagent).sort()).toEqual(["kit", "low"]);
    // Children's usage reaches the parent's sink (the spend meter).
    expect(
      events.filter((e) => e.type === "usage" && e.inputTokens === 500),
    ).toHaveLength(2);
    const applied = events.find(
      (e) => e.type === "tool-applied" && e.name === "dispatch",
    );
    expect(applied?.type === "tool-applied" && applied.summary).toBe(
      "dispatch · 2/2 done",
    );
    const second = script.requests[1]!.body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolReply = second.messages.find((m) => m.role === "tool");
    expect(String(toolReply?.content)).toContain("low: done revs");
  });

  test("a host without subagents refuses dispatch", async () => {
    const { host } = strictHost();
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "d1", "dispatch", {
          tasks: [{ id: "a", prompt: "x", tracks: ["bass"] }],
        }),
        finishChunk("tool_calls"),
      ],
      [textChunk("ok"), finishChunk("stop")],
    ]);
    const events: AgentEvent[] = [];
    await runAgentTurn({
      prompt: "x",
      model: "opus-5.5",
      client: createGatewayClient({
        apiKey: "k",
        baseUrl: "https://gw.test/v1",
        fetcher: script.fetcher,
      }),
      host,
      onEvent: (event) => events.push(event),
    });
    const rejected = events.find((e) => e.type === "tool-rejected");
    expect(rejected?.type === "tool-rejected" && rejected.diagnostic).toContain(
      "dispatch is unavailable here",
    );
  });

  test("tool and child turn rows reach history, linked to the parent turn", async () => {
    const { host } = strictHost();
    const rows: Array<Record<string, unknown>> = [];
    const history: HistoryHandle = {
      append(row) {
        rows.push(row as Record<string, unknown>);
        const id = row.id ?? `ev-${rows.length}`;
        return { id, done: Promise.resolve(undefined) };
      },
      query: () => ({ rows: [] }),
      context: () => ({ rev: 0 }) as never,
    };
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "d1", "dispatch", {
          tasks: [
            { id: "low", prompt: "bass", tracks: ["bass"] },
            { id: "kit", prompt: "drums", tracks: ["drums"] },
          ],
        }),
        finishChunk("tool_calls"),
      ],
      [textChunk("ok"), finishChunk("stop")],
    ]);
    const childTurnIds: string[] = [];
    await runAgentTurn({
      prompt: "bass and drums",
      model: "opus-5.5",
      turnId: "turn-parent",
      client: createGatewayClient({
        apiKey: "k",
        baseUrl: "https://gw.test/v1",
        fetcher: script.fetcher,
      }),
      host: {
        ...host,
        history,
        subagents: {
          concurrency: 4,
          runTurn: async (input) => {
            childTurnIds.push(input.turnId ?? "");
            await executeCall(
              { id: "c1", name: "no_such_tool", arguments: "{}" },
              {
                tools: AGENT_TOOLS,
                host: input.host,
                newNoteId: (track) => `${track}-x`,
                ...(input.turnId ? { turnId: input.turnId } : {}),
              },
            );
            return done("ok");
          },
        },
      },
    });
    const tools = rows.filter((row) => row.kind === "tool");
    const dispatchRow = tools.find(
      (row) => (row.payload as { name: string }).name === "dispatch",
    )!;
    expect((dispatchRow.payload as { turnId: string }).turnId).toBe(
      "turn-parent",
    );
    expect((dispatchRow.actor as { kind: string }).kind).toBe("agent");
    const childTools = tools.filter(
      (row) => (row.actor as { kind: string }).kind === "subagent",
    );
    expect(
      childTools
        .map((row) => (row.payload as { subagent: string }).subagent)
        .sort(),
    ).toEqual(["kit", "low"]);
    expect(childTools.every((row) => row.sub === "error")).toBe(true);
    const turns = rows.filter((row) => row.kind === "turn");
    expect(turns.map((row) => row.parentId)).toEqual([
      "turn-parent",
      "turn-parent",
    ]);
    expect(turns.map((row) => row.id).sort()).toEqual([...childTurnIds].sort());
    expect(new Set(childTurnIds).size).toBe(2);
  });
});
