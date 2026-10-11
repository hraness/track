import { describe, expect, test } from "bun:test";
import { argsDigest, toolRow, turnRow } from "./agent-rows.ts";
import { historySink, setHistorySink } from "./sink.ts";
import { noopHistoryHandle } from "./noop.ts";

describe("agent rows", () => {
  test("toolRow digests args and keeps them only in dev", () => {
    const row = toolRow({
      name: "add_notes",
      args: { a: 1 },
      ok: true,
      ms: 12.4,
      summary: "added 4 notes",
      turnId: "t1",
    });
    expect(row.kind).toBe("tool");
    expect(row.actor.kind).toBe("agent");
    expect(row.summary).toBe("add_notes: added 4 notes");
    expect(row.payload).toEqual({
      name: "add_notes",
      ok: true,
      ms: 12,
      args: argsDigest({ a: 1 }),
      turnId: "t1",
    });
    const dev = toolRow({
      name: "x",
      args: { big: "y".repeat(5000) },
      ok: false,
      ms: 1,
      summary: "bad",
      turnId: "t",
      subagent: "drums",
      dev: true,
    });
    expect(dev.actor.kind).toBe("subagent");
    expect(dev.sub).toBe("error");
    expect(
      String((dev.payload as { argsJson: string }).argsJson).length,
    ).toBeLessThanOrEqual(2049);
  });

  test("turnRow keeps the pre-assigned id and parent", () => {
    const row = turnRow({
      id: "turn-1",
      prompt: "p".repeat(900),
      model: "m",
      steps: 3,
      spend: "$0.01",
      outcome: "done",
      parentTurnId: "turn-0",
      subagent: "bass",
    });
    expect(row.id).toBe("turn-1");
    expect(row.parentId).toBe("turn-0");
    expect(row.summary.length).toBeLessThanOrEqual(200);
    expect(row.body?.length).toBeLessThanOrEqual(400);
  });

  test("sink is process-global and the no-op handle drops rows", async () => {
    expect(historySink()).toBeUndefined();
    const h = noopHistoryHandle(3);
    setHistorySink(h);
    expect(historySink()).toBe(h);
    const r = h.append({
      kind: "comment",
      actor: { kind: "human" },
      summary: "x",
    });
    expect(r.id.length).toBeGreaterThan(0);
    expect(await r.done).toBeUndefined();
    expect(h.context().rev).toBe(3);
    setHistorySink(undefined);
  });
});
