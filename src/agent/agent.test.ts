import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScore, type TrackScore } from "../../core/score.ts";
import {
  AGENT_SYSTEM_PROMPT,
  AgentTimeoutError,
  classifyAgentError,
  describeAgentEvent,
  runAgentTurn,
  StaleRevisionError,
  summarizeToolResult,
  type AgentEvent,
  type AgentHost,
} from "./agent.ts";
import type { FetchLike } from "../web/http.ts";
import { createGatewayClient, createOpenRouterClient } from "./gateway.ts";
import { scriptedRunner } from "../auth/runner.ts";
import { ffprobeJson, syntheticWav } from "../media/media-fixtures.ts";
import {
  finishChunk,
  scriptedFetch,
  sseBody,
  textChunk,
  toolCallChunks,
} from "./sse-fixtures.ts";

const KEY = "sk-live-should-never-leak-9f8e7d";

function memoryHost(
  initial: TrackScore = createScore({ tracks: [{ id: "main" }] }),
) {
  const state = {
    score: initial,
    revision: 3,
    commits: 0,
    steering: [] as string[],
  };
  const host: AgentHost = {
    snapshot: () => ({
      score: state.score,
      revision: state.revision,
      focusedTrackId: "main",
      recentOperations: ["agent.tool: +4 main notes"],
    }),
    commit: (change) => {
      if (change.baseRevision !== state.revision)
        return Promise.reject(
          new StaleRevisionError(change.baseRevision, state.revision),
        );
      state.score = change.next;
      state.revision += 1;
      state.commits += 1;
      return Promise.resolve({ revision: state.revision });
    },
    takeSteering: () => state.steering.splice(0),
  };
  return { state, host };
}

function client(fetcher: ReturnType<typeof scriptedFetch>["fetcher"]) {
  return createGatewayClient({
    apiKey: KEY,
    baseUrl: "https://gw.test/v1",
    fetcher,
  });
}

const bassArgs = {
  trackId: "bass",
  notes: [
    { pitch: "C2", start: 0, duration: 1 },
    { pitch: 38, start: 1, duration: 0.5, velocity: 0.6 },
  ],
};

describe("streaming agent turn", () => {
  test("applies a multi-tool turn, feeds results back, and finishes", async () => {
    const script = scriptedFetch([
      [
        textChunk("Laying down "),
        ...toolCallChunks(0, "c1", "create_track", {
          id: "bass",
          instrument: "bass",
        }),
        ...toolCallChunks(1, "c2", "add_notes", bassArgs),
        ...toolCallChunks(2, "c3", "set_tempo", { bpm: 96 }),
        finishChunk("tool_calls"),
      ],
      [textChunk("Added a two-note bass line at 96 BPM."), finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "add a bass line",
      model: "opus-5.5",
      client: client(script.fetcher),
      host,
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({
      type: "done",
      reason: "stop",
      applied: 3,
      rejected: 0,
      revision: 6,
    });
    expect(result.type === "done" && result.text).toBe(
      "Added a two-note bass line at 96 BPM.",
    );
    expect(state.score.tempoBpm).toBe(96);
    expect(
      state.score.notes.filter((n) => n.trackId === "bass").map((n) => n.pitch),
    ).toEqual([36, 38]);
    const applied = events.filter((e) => e.type === "tool-applied");
    expect(
      applied.map(
        (e) =>
          e.type === "tool-applied" && [
            e.summary,
            e.baseRevision,
            e.resultRevision,
          ],
      ),
    ).toEqual([
      ["+track bass (bass)", 3, 4],
      ["+2 bass notes", 4, 5],
      ["tempo 120 → 96 BPM", 5, 6],
    ]);
    expect(
      events
        .filter((e) => e.type === "tool-start")
        .map((e) => e.type === "tool-start" && e.name),
    ).toEqual(["create_track", "add_notes", "set_tempo"]);
    expect(
      events.some((e) => e.type === "text-delta" && e.delta === "Laying down "),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    // Second request carries the assistant tool calls and one result per call.
    const second = script.requests[1]!.body as {
      messages: Array<Record<string, unknown>>;
    };
    const toolMessages = second.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
    expect(JSON.parse(String(toolMessages[1]!.content))).toMatchObject({
      ok: true,
      revision: 5,
    });
    // The refreshed brief reflects the applied changes, and says so: it
    // precedes the request, so an unlabeled one reads as the starting score
    // and small models re-apply the edit (a transpose repeated 8 times).
    expect(String(second.messages[1]!.content)).toContain('"tempoBpm":96');
    expect(String(second.messages[1]!.content)).toStartWith(
      "Composition brief (JSON, the current score at revision 6: it already includes every edit your tool calls made this turn, starting from revision 3; do not repeat them): ",
    );
    expect(
      String(
        (script.requests[0]!.body as { messages: Array<{ content: string }> })
          .messages[1]!.content,
      ),
    ).toStartWith("Composition brief (JSON): ");
    expect(script.requests[0]!.body).toMatchObject({
      model: "anthropic/claude-opus-5.5",
      stream: true,
    });
  });

  test("rejects invalid arguments without mutating the score", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "bad1", "add_notes", {
          notes: [{ pitch: 300, start: 0, duration: 1 }],
        }),
        ...toolCallChunks(1, "bad2", "set_tempo", "{not json"),
        ...toolCallChunks(2, "bad3", "drop_tables", {}),
        ...toolCallChunks(3, "bad4", "add_notes", {
          trackId: "ghost",
          notes: [{ pitch: 60, start: 0, duration: 1 }],
        }),
        finishChunk("tool_calls"),
      ],
      [textChunk("Sorry, nothing changed."), finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    const before = state.score;
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({
      type: "done",
      applied: 0,
      rejected: 4,
      revision: 3,
    });
    expect(state.score).toBe(before);
    expect(state.commits).toBe(0);
    const diagnostics = events.flatMap((e) =>
      e.type === "tool-rejected" ? [e.diagnostic] : [],
    );
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics[1]).toContain("valid JSON");
    expect(diagnostics[2]).toContain("unknown tool");
    expect(diagnostics[3]).toContain("unknown track ghost");
  });

  test("a call that passes the tool but fails reducer validation is not applied", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "c1", "add_notes", {
          notes: [{ pitch: 60, start: 1_000_000, duration: 1 }],
        }),
        finishChunk("tool_calls"),
      ],
      [finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    const events: AgentEvent[] = [];
    await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      onEvent: (e) => events.push(e),
    });
    expect(state.commits).toBe(0);
    expect(events.some((e) => e.type === "tool-rejected")).toBe(true);
  });

  test("reports a stale revision when another window commits first", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "c1", "set_tempo", { bpm: 140 }),
        finishChunk("tool_calls"),
      ],
      [finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    const racing: AgentHost = {
      ...host,
      commit: (change) => {
        state.revision += 1; // another window wins the race
        return host.commit(change);
      },
    };
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host: racing,
      onEvent: (e) => events.push(e),
    });
    const rejected = events.find((e) => e.type === "tool-rejected");
    expect(rejected?.type === "tool-rejected" && rejected.diagnostic).toContain(
      "stale revision",
    );
    expect(state.score.tempoBpm).toBe(120);
    expect(result).toMatchObject({ type: "done", applied: 0 });
    const second = script.requests[1]!.body as {
      messages: Array<Record<string, unknown>>;
    };
    expect(String(second.messages.at(-1)!.content)).toContain("stale revision");
  });

  test("abort mid-stream keeps the last accepted revision", async () => {
    const controller = new AbortController();
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "c1", "set_tempo", { bpm: 100 }),
        finishChunk("tool_calls"),
      ],
      () =>
        new Response(
          sseBody([textChunk("thinking about the drums")], {
            done: false,
            hang: true,
          }),
          {
            status: 200,
          },
        ),
    ]);
    const { state, host } = memoryHost();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "text-delta") controller.abort();
      },
    });
    expect(result).toMatchObject({
      type: "error",
      code: "aborted",
      applied: 1,
      revision: 4,
    });
    expect(state.score.tempoBpm).toBe(100);
    expect(describeAgentEvent(result)).toBe("canceled · kept rev 4");
  });

  test("times out a stalled stream", async () => {
    const script = scriptedFetch([
      () =>
        new Response(sseBody([textChunk("hm")], { done: false, hang: true }), {
          status: 200,
        }),
    ]);
    const { host } = memoryHost();
    const result = await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      budget: { timeoutMs: 30 },
    });
    expect(result).toMatchObject({ type: "error", code: "timeout" });
  });

  test("surfaces provider errors without leaking the key", async () => {
    const script = scriptedFetch([
      () =>
        new Response(
          JSON.stringify({ error: { message: `invalid key ${KEY}` } }),
          { status: 401 },
        ),
    ]);
    const { host } = memoryHost();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "x",
      model: "opus-5.5",
      client: client(script.fetcher),
      host,
      onEvent: (e) => events.push(e),
    });
    expect(result).toMatchObject({ type: "error", code: "provider" });
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(script.requests.map((r) => r.body))).not.toContain(
      KEY,
    );
  });

  test("stops at the response byte budget", async () => {
    const script = scriptedFetch([
      [textChunk("x".repeat(4_000)), finishChunk("stop")],
    ]);
    const { host } = memoryHost();
    const result = await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      budget: { maxResponseBytes: 512 },
    });
    expect(result).toMatchObject({ type: "error", code: "budget" });
  });

  test("older tool results collapse to summaries and the request budget is enforced", async () => {
    const steps = Array.from({ length: 5 }, (_, i) => [
      ...toolCallChunks(0, `c${i}`, "set_tempo", { bpm: 100 + i }),
      finishChunk("tool_calls"),
    ]);
    const script = scriptedFetch([
      ...steps,
      [textChunk("done"), finishChunk("stop")],
    ]);
    const { host } = memoryHost();
    const result = await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
    });
    expect(result).toMatchObject({ type: "done", reason: "stop", applied: 5 });
    const last = script.requests.at(-1)!.body as {
      messages: { role: string; content: string }[];
    };
    const tools = last.messages.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(5);
    // Results from steps 1-3 are one-liners by step 6; steps 4-5 are verbatim.
    expect(
      tools.slice(0, 3).every((m) => m.content.startsWith("(earlier result)")),
    ).toBe(true);
    expect(tools.slice(3).every((m) => m.content.startsWith("{"))).toBe(true);
    expect(
      summarizeToolResult(
        JSON.stringify({ ok: true, revision: 9, summary: "tempo 120" }),
      ),
    ).toBe("(earlier result) ok · rev 9 · tempo 120");
    expect(summarizeToolResult("x".repeat(500)).length).toBeLessThanOrEqual(
      180,
    );

    // A turn whose requests outgrow 512 KiB in total ends with a budget error.
    const big = scriptedFetch(
      Array.from({ length: 8 }, (_, i) => [
        ...toolCallChunks(0, `b${i}`, "explain", { text: "y".repeat(30_000) }),
        finishChunk("tool_calls"),
      ]),
    );
    const capped = await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(big.fetcher),
      host: memoryHost().host,
    });
    expect(capped).toMatchObject({ type: "error", code: "budget" });
    expect((capped as { message: string }).message).toContain("request budget");
    expect(big.requests.length).toBeLessThan(8);
  });

  test("stops at the tool-call and step budgets", async () => {
    const tempoCalls = Array.from({ length: 3 }, (_, i) =>
      toolCallChunks(i, `t${i}`, "set_tempo", { bpm: 100 + i }),
    ).flat();
    const script = scriptedFetch([[...tempoCalls, finishChunk("tool_calls")]]);
    const { state, host } = memoryHost();
    const result = await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      budget: { maxToolCalls: 2 },
    });
    expect(result).toMatchObject({
      type: "done",
      reason: "max-tool-calls",
      applied: 2,
    });
    expect(state.score.tempoBpm).toBe(101);

    const loop = scriptedFetch([
      [
        ...toolCallChunks(0, "a", "explain", { text: "one" }),
        finishChunk("tool_calls"),
      ],
      [
        ...toolCallChunks(0, "b", "explain", { text: "two" }),
        finishChunk("tool_calls"),
      ],
    ]);
    const steps = await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(loop.fetcher),
      host,
      budget: { maxSteps: 2 },
    });
    expect(steps).toMatchObject({
      type: "done",
      reason: "max-steps",
      text: "two",
    });
  });

  test("steering messages are injected before the next step", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "c1", "set_tempo", { bpm: 90 }),
        finishChunk("tool_calls"),
      ],
      [finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      onEvent: (event) => {
        if (event.type === "tool-applied")
          state.steering.push("make it darker");
      },
    });
    const second = script.requests[1]!.body as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(second.messages.at(-1)).toMatchObject({ role: "user" });
    expect(second.messages.at(-1)!.content).toContain("make it darker");
  });
});

describe("drum, effects, solo, and filter tools", () => {
  test("applies drums, effects, solo, and filter automation through the loop", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "d0", "create_track", {
          id: "drums",
          instrument: "kit",
        }),
        ...toolCallChunks(1, "d1", "add_drums", {
          trackId: "drums",
          hits: [{ voice: "snare", beat: 1 }],
          patterns: [{ voice: "kick", every: 4 }],
        }),
        ...toolCallChunks(2, "d2", "set_effects", {
          filter: { cutoff: 1200, resonance: 0.4 },
          delay: { beats: 0.75 },
        }),
        ...toolCallChunks(3, "d3", "set_mix", { trackId: "drums", solo: true }),
        ...toolCallChunks(4, "d4", "set_automation", {
          parameter: "filter",
          points: [
            { beat: 0, value: 400 },
            { beat: 8, value: 8000 },
          ],
        }),
        finishChunk("tool_calls"),
      ],
      [finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "beat + dub fx",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      onEvent: (e) => events.push(e),
    });
    expect(result).toMatchObject({ type: "done", applied: 5, rejected: 0 });
    const drums = state.score.notes.filter((n) => n.trackId === "drums");
    expect(drums.map((n) => n.pitch).sort()).toEqual([36, 36, 36, 36, 38]);
    const main = state.score.tracks.find((t) => t.id === "main")!;
    expect(main.filter).toEqual({ cutoff: 1200, resonance: 0.4 });
    expect(main.delay).toMatchObject({ beats: 0.75 });
    expect(main.filterAutomation?.map((p) => p.value)).toEqual([400, 8000]);
    expect(state.score.tracks.find((t) => t.id === "drums")!.solo).toBe(true);
    expect(
      events.flatMap((e) => (e.type === "tool-applied" ? [e.summary] : [])),
    ).toContain("+5 drums hits");
  });

  test("set_rhythm stores Euclidean rows and generates their lanes", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "r0", "create_track", {
          id: "drums",
          instrument: "kit",
        }),
        ...toolCallChunks(1, "r1", "set_rhythm", {
          trackId: "drums",
          rows: [
            { voice: "kick", pulses: 4, steps: 16 },
            { voice: "hat", pulses: 7, rotate: 2, repeats: 1, time: "1/32" },
          ],
        }),
        ...toolCallChunks(2, "r2", "set_rhythm", {
          trackId: "drums",
          rows: [{ voice: "kick", pulses: 17 }],
        }),
        finishChunk("tool_calls"),
      ],
      [finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "euclid beat",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      onEvent: (e) => events.push(e),
    });
    expect(result).toMatchObject({ applied: 2, rejected: 1 });
    const drums = state.score.tracks.find((t) => t.id === "drums")!;
    expect(drums.rhythm).toEqual([
      { voice: "kick" },
      { voice: "hat", pulses: 7, rotate: 2, repeats: 1, time: "1/32" },
    ]);
    const kicks = state.score.notes.filter((n) => n.pitch === 36);
    expect(kicks.map((n) => n.startTick / 480)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(state.score.notes.some((n) => n.pitch === 42)).toBe(true);
    const diagnostic = events.flatMap((e) =>
      e.type === "tool-rejected" ? [e.diagnostic] : [],
    )[0];
    expect(diagnostic).toContain("pulses");
  });

  test("drum pattern tools: list, apply with tempo, and set a synth kit", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "p0", "list_drum_patterns", { filter: "hip hop" }),
        ...toolCallChunks(1, "p1", "apply_drum_pattern", {
          name: "boom-bap",
          trackId: "drums",
        }),
        ...toolCallChunks(2, "p2", "set_drum_kit", {
          kit: "lofi",
          trackId: "drums",
        }),
        ...toolCallChunks(3, "p3", "apply_drum_pattern", {
          name: "no-such-groove",
          trackId: "drums",
        }),
        finishChunk("tool_calls"),
      ],
      [finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "boom bap beat",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      onEvent: (e) => events.push(e),
    });
    expect(result).toMatchObject({ rejected: 1 });
    const drums = state.score.tracks.find((t) => t.id === "drums")!;
    expect(drums.instrument).toBe("kit");
    expect(drums.kit).toBe("lofi");
    expect(drums.rhythm?.map((row) => row.voice)).toEqual([
      "kick",
      "snare",
      "hat",
    ]);
    expect(state.score.tempoBpm).toBe(90);
    expect(state.score.notes.some((n) => n.trackId === "drums")).toBe(true);
    const listed = events.flatMap((e) =>
      e.type === "tool-applied" ? [e.summary] : [],
    );
    expect(listed.some((summary) => /patterns/.test(summary))).toBe(true);
  });

  test("rejects drums on a melodic track and out-of-range effects", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "x0", "add_drums", {
          hits: [{ voice: "kick", beat: 0 }],
        }),
        ...toolCallChunks(1, "x1", "set_effects", { delay: { beats: 9 } }),
        ...toolCallChunks(2, "x2", "set_automation", {
          parameter: "filter",
          points: [{ beat: 0, value: 5 }],
        }),
        finishChunk("tool_calls"),
      ],
      [finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    const events: AgentEvent[] = [];
    await runAgentTurn({
      prompt: "x",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
      onEvent: (e) => events.push(e),
    });
    expect(state.commits).toBe(0);
    const diagnostics = events.flatMap((e) =>
      e.type === "tool-rejected" ? [e.diagnostic] : [],
    );
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]).toContain("not a kit");
  });

  test("sets reverb and automates delay mix, feedback, and resonance", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "r0", "set_effects", {
          delay: { beats: 0.5 },
          reverb: { mix: 0.25, size: 0.8 },
        }),
        ...toolCallChunks(1, "r1", "set_automation", {
          parameter: "delay-mix",
          points: [
            { beat: 0, value: 0 },
            { beat: 4, value: 0.9 },
          ],
        }),
        ...toolCallChunks(2, "r2", "set_automation", {
          parameter: "delay-feedback",
          points: [{ beat: 2, value: 0.7 }],
        }),
        ...toolCallChunks(3, "r3", "set_automation", {
          parameter: "resonance",
          points: [{ beat: 1, value: 0.5 }],
        }),
        ...toolCallChunks(4, "r4", "set_automation", {
          parameter: "delay-feedback",
          points: [{ beat: 0, value: 0.95 }],
        }),
        ...toolCallChunks(5, "r5", "set_effects", { reverb: { mix: 3 } }),
        finishChunk("tool_calls"),
      ],
      [finishChunk("stop")],
    ]);
    const { state, host } = memoryHost();
    const result = await runAgentTurn({
      prompt: "space",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
    });
    expect(result).toMatchObject({ type: "done", applied: 4, rejected: 2 });
    const main = state.score.tracks.find((t) => t.id === "main")!;
    expect(main.reverb).toEqual({ mix: 0.25, size: 0.8 });
    expect(main.delayMixAutomation?.map((p) => p.value)).toEqual([0, 0.9]);
    expect(main.delayFeedbackAutomation).toEqual([
      { tick: 2 * state.score.ticksPerBeat, value: 0.7 },
    ]);
    expect(main.resonanceAutomation?.map((p) => p.value)).toEqual([0.5]);
  });

  test("removes effects with null", async () => {
    const base = createScore({
      tracks: [
        {
          id: "main",
          filter: { cutoff: 500, resonance: 0 },
          delay: { beats: 1, feedback: 0.2, mix: 0.2 },
          reverb: { mix: 0.3, size: 0.5 },
        },
      ],
    });
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "n0", "set_effects", {
          filter: null,
          delay: null,
          reverb: null,
        }),
        finishChunk("tool_calls"),
      ],
      [finishChunk("stop")],
    ]);
    const { state, host } = memoryHost(base);
    await runAgentTurn({
      prompt: "dry",
      model: "sol-6.1",
      client: client(script.fetcher),
      host,
    });
    const main = state.score.tracks[0]!;
    expect(main.filter).toBeUndefined();
    expect(main.delay).toBeUndefined();
    expect(main.reverb).toBeUndefined();
  });
});

describe("workspace and web tools in the loop", () => {
  async function project() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dawg-loop-")));
    await mkdir(join(root, "tracks/main"), { recursive: true });
    await mkdir(join(root, "tracks/other"), { recursive: true });
    await writeFile(
      join(root, "tracks/main/track.ts"),
      'export default track({ id: "main", volume: 0.5 });\n',
    );
    await writeFile(join(root, "tracks/main/notes.md"), "# main\nidea: dub\n");
    await writeFile(join(root, "tracks/other/track.ts"), "// other\n");
    await writeFile(join(root, "song.ts"), "export default song({});\n");
    return root;
  }

  test("reads, searches, edits a track file, refuses code after web text, reports the hook", async () => {
    const root = await project();
    try {
      const ddg = await readFile(
        new URL("../web/fixtures/duckduckgo.html", import.meta.url),
        "utf8",
      );
      const script = scriptedFetch([
        [
          ...toolCallChunks(0, "r1", "read_file", {
            path: "tracks/main/track.ts",
          }),
          ...toolCallChunks(1, "s1", "web_search", {
            query: "comb filter reverb",
          }),
          ...toolCallChunks(2, "l1", "list_files", { path: "tracks" }),
          finishChunk("tool_calls"),
        ],
        [
          ...toolCallChunks(0, "e1", "edit_file", {
            path: "tracks/main/track.ts",
            old: "volume: 0.5",
            new: "volume: 0.8, send: { reverb: 0.3 }",
          }),
          ...toolCallChunks(1, "e2", "edit_file", {
            path: "song.ts",
            old: "song({})",
            new: "song({ hacked: true })",
          }),
          ...toolCallChunks(2, "w1", "write_file", {
            path: "tracks/main/notes.md",
            content: "# main\nidea: dub\nref: freeverb\n",
          }),
          finishChunk("tool_calls"),
        ],
        [
          textChunk("Turned up main and noted the reference."),
          finishChunk("stop"),
        ],
      ]);
      const webFetch: FetchLike = async (input) => {
        const url = String(input);
        expect(url.startsWith("https://html.duckduckgo.com/html/")).toBe(true);
        return new Response(ddg, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      };
      const { state, host } = memoryHost();
      const writes: string[] = [];
      const events: AgentEvent[] = [];
      const result = await runAgentTurn({
        prompt: "louder main with a reverb reference",
        model: "opus-5.5",
        client: client(script.fetcher),
        host: {
          ...host,
          workspace: { root },
          onWorkspaceWrite: (path) => {
            writes.push(path);
            return path.endsWith("track.ts")
              ? "track.ts applied: 1 track updated"
              : undefined;
          },
          web: { fetch: webFetch },
        },
        onEvent: (event) => events.push(event),
      });
      expect(result).toMatchObject({
        type: "done",
        reason: "stop",
        applied: 2,
        rejected: 1,
        revision: 3,
      });
      expect(state.commits).toBe(0);
      expect(await readFile(join(root, "tracks/main/track.ts"), "utf8")).toBe(
        'export default track({ id: "main", volume: 0.8, send: { reverb: 0.3 } });\n',
      );
      // song.ts is code; after web_search this turn it is read-only.
      expect(await readFile(join(root, "song.ts"), "utf8")).toBe(
        "export default song({});\n",
      );
      expect(
        await readFile(join(root, "tracks/main/notes.md"), "utf8"),
      ).toContain("ref: freeverb");
      expect(writes).toEqual(["tracks/main/track.ts", "tracks/main/notes.md"]);
      expect(
        (await readdir(join(root, "tracks/main"))).filter((n) =>
          n.endsWith(".tmp"),
        ),
      ).toEqual([]);
      expect(
        events
          .filter((e) => e.type === "tool-applied")
          .map((e) => e.type === "tool-applied" && e.summary),
      ).toEqual([
        "read tracks/main/track.ts (1 line)",
        "searched via duckduckgo · 3 results",
        "listed tracks (2)",
        "edited tracks/main/track.ts",
        "wrote tracks/main/notes.md (31 B)",
      ]);
      const rejected = events.find((e) => e.type === "tool-rejected");
      expect(rejected?.type === "tool-rejected" && rejected.diagnostic).toBe(
        "song.ts: untrusted content seen this turn; ask the user and continue next turn",
      );
      // The first brief carries the project tree and the notes head.
      const first = script.requests[0]!.body as {
        messages: Array<Record<string, unknown>>;
      };
      const brief = JSON.parse(
        String(first.messages[1]!.content).replace(
          /^Composition brief \(JSON\): /,
          "",
        ),
      ) as { project?: { tree: string[]; notes?: string } };
      expect(brief.project?.tree).toEqual([
        "song.ts 25 B",
        "tracks/main/ (focused) 2 files 68 B",
        "tracks/other/ 1 file 9 B",
      ]);
      expect(brief.project?.notes).toBe("# main\nidea: dub\n");
      // Anthropic models get the system prompt as one cache-marked text part.
      expect(JSON.stringify(first.messages[0]!.content)).toContain("edit_file");
      // Tool results are plain text; the write hook's text follows the edit result.
      const second = script.requests[1]!.body as {
        messages: Array<Record<string, unknown>>;
      };
      const tools = second.messages.filter((m) => m.role === "tool");
      expect(String(tools[0]!.content)).toBe(
        'tracks/main/track.ts · lines 1-1 of 1\nexport default track({ id: "main", volume: 0.5 });',
      );
      expect(String(tools[1]!.content)).toMatch(
        /^3 results via duckduckgo\n1\. Freeverb/,
      );
      expect(String(tools[2]!.content)).toBe(
        "tracks/ · 2 entries\nmain/\nother/",
      );
      const third = script.requests[2]!.body as {
        messages: Array<Record<string, unknown>>;
      };
      const edits = third.messages.filter((m) => m.role === "tool").slice(-3);
      expect(String(edits[0]!.content)).toBe(
        "edited tracks/main/track.ts: replaced 1 occurrence (1 → 1 line)\ntrack.ts applied: 1 track updated",
      );
      expect(JSON.parse(String(edits[1]!.content))).toMatchObject({
        ok: false,
      });
      expect(String(edits[2]!.content)).toBe(
        "wrote tracks/main/notes.md (31 bytes)",
      );
      for (const request of script.requests)
        expect(JSON.stringify(request.body)).not.toContain(KEY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("file tools are unavailable without a workspace and web tools stay bounded", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "r1", "read_file", { path: "song.ts" }),
        ...toolCallChunks(1, "f1", "fetch_url", {
          url: "http://localhost:7/x",
        }),
        ...toolCallChunks(2, "s1", "web_search", { query: "   " }),
        finishChunk("tool_calls"),
      ],
      [textChunk("Nothing to do."), finishChunk("stop")],
    ]);
    const { host } = memoryHost();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "x",
      model: "opus-5.5",
      client: client(script.fetcher),
      host,
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({ type: "done", applied: 0, rejected: 3 });
    expect(
      events
        .filter((e) => e.type === "tool-rejected")
        .map((e) => e.type === "tool-rejected" && e.diagnostic),
    ).toEqual([
      "file tools are unavailable in this session",
      "localhost is not a public host",
      "query must be a non-empty string",
    ]);
  });
});

describe("media tools in the loop", () => {
  test("runs past the turn deadline while a helper works, streams progress, reports outputs", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "dawg-media-loop-")),
    );
    try {
      await mkdir(join(root, "tracks/main/downloads"), { recursive: true });
      await writeFile(
        join(root, "tracks/main/downloads/loop.wav"),
        syntheticWav(2, (t) => 0.4 * Math.sin(2 * Math.PI * 220 * t)),
      );
      const script = scriptedFetch([
        [
          ...toolCallChunks(0, "m1", "analyze_audio", { file: "loop.wav" }),
          finishChunk("tool_calls"),
        ],
        [textChunk("Analyzed the loop."), finishChunk("stop")],
      ]);
      const runner = scriptedRunner(
        [
          {
            match: (command) => command === "ffprobe",
            respond: async () => {
              // Longer than the whole turn budget: the deadline is suspended.
              await Bun.sleep(150);
              return { stdout: ffprobeJson(2) };
            },
          },
        ],
        ["ffprobe"],
      );
      const { host } = memoryHost();
      const events: AgentEvent[] = [];
      const result = await runAgentTurn({
        prompt: "what tempo is loop.wav",
        model: "opus-5.5",
        client: client(script.fetcher),
        host: { ...host, workspace: { root }, media: { runner } },
        budget: { timeoutMs: 100 },
        onEvent: (event) => events.push(event),
      });
      expect(result).toMatchObject({
        type: "done",
        reason: "stop",
        applied: 0,
      });
      const progress = events.flatMap((event) =>
        event.type === "tool-progress" ? [event.line] : [],
      );
      expect(progress).toEqual([
        "ffprobe",
        "decoding",
        "tempo",
        "key",
        "waveform",
      ]);
      expect(
        describeAgentEvent(events.find((e) => e.type === "tool-progress")!),
      ).toContain("ffprobe");
      const followUp = script.requests[1]!.body as {
        messages: { role: string; content: string }[];
      };
      const toolMessage = followUp.messages.find((m) => m.role === "tool")!;
      const content = JSON.parse(toolMessage.content) as Record<
        string,
        unknown
      >;
      expect(content.ok).toBe(true);
      expect(content.outputs).toEqual([
        "tracks/main/downloads/loop.analysis.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("media tools are rejected without a media host or workspace", async () => {
    const script = scriptedFetch([
      [
        ...toolCallChunks(0, "m1", "split_stems", { file: "song.wav" }),
        finishChunk("tool_calls"),
      ],
      [textChunk("No stems."), finishChunk("stop")],
    ]);
    const { host } = memoryHost();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      prompt: "split song.wav",
      model: "opus-5.5",
      client: client(script.fetcher),
      host,
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({ type: "done", rejected: 1 });
    expect(
      events.some(
        (event) =>
          event.type === "tool-rejected" &&
          event.diagnostic === "media tools are unavailable in this host",
      ),
    ).toBe(true);
  });
});

describe("classifyAgentError", () => {
  test("a transport TimeoutError is a provider failure, the turn budget stays a timeout", () => {
    const live = new AbortController().signal;
    expect(
      classifyAgentError(
        new DOMException("The operation timed out.", "TimeoutError"),
        live,
        undefined,
      ),
    ).toEqual({
      code: "provider",
      message: "model request timed out: The operation timed out.",
    });
    expect(
      classifyAgentError(new AgentTimeoutError(90_000), live, undefined).code,
    ).toBe("timeout");
    const user = new AbortController();
    user.abort();
    expect(classifyAgentError(new TypeError("x"), live, user.signal).code).toBe(
      "aborted",
    );
  });
});

describe("prompt cache", () => {
  test("the static prefix is byte-stable across steps and marked for Anthropic models", async () => {
    const turn = () =>
      scriptedFetch([
        [
          ...toolCallChunks(0, "c1", "set_tempo", { bpm: 100 }),
          finishChunk("tool_calls"),
        ],
        [textChunk("done"), finishChunk("stop")],
      ]);
    const routes = [
      ["openrouter", "anthropic/claude-opus-5.5", true],
      ["openrouter", "openai/gpt-oss-20b:nitro", false],
      ["gateway", "anthropic/claude-opus-5.5", true],
      ["gateway", "openai/gpt-6-luna", false],
    ] as const;
    for (const [provider, modelId, marked] of routes) {
      const script = turn();
      const make =
        provider === "openrouter"
          ? createOpenRouterClient
          : createGatewayClient;
      const result = await runAgentTurn({
        prompt: "tempo 100",
        model: modelId,
        client: make({
          apiKey: KEY,
          baseUrl: "https://gw.test/v1",
          fetcher: script.fetcher,
        }),
        host: memoryHost().host,
      });
      expect(result.type).toBe("done");
      const bodies = script.requests.map(
        (r) =>
          r.body as {
            messages: unknown[];
            tools: unknown[];
            providerOptions?: unknown;
          },
      );
      expect(bodies).toHaveLength(2);
      // Tools and the static system message never change between steps, so
      // the provider can reuse the cached prefix.
      expect(JSON.stringify(bodies[1]!.tools)).toBe(
        JSON.stringify(bodies[0]!.tools),
      );
      expect(JSON.stringify(bodies[1]!.messages[0])).toBe(
        JSON.stringify(bodies[0]!.messages[0]),
      );
      const first = bodies[0]!.messages[0] as {
        role: string;
        content: unknown;
      };
      expect(first.role).toBe("system");
      if (marked)
        expect(first.content).toEqual([
          {
            type: "text",
            text: AGENT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ]);
      else expect(first.content).toBe(AGENT_SYSTEM_PROMPT);
      // Only the static prompt carries a breakpoint; the brief stays plain.
      expect(JSON.stringify(bodies[0]!.messages.slice(1))).not.toContain(
        "cache_control",
      );
      expect(bodies[0]!.providerOptions).toEqual(
        provider === "gateway" ? { gateway: { caching: "auto" } } : undefined,
      );
    }
  });
});
