import { afterEach, describe, expect, test } from "bun:test";
import { budget } from "../../test/perf.ts";
import { Database } from "bun:sqlite";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffScores } from "../../core/diff.ts";
import {
  emptyScore,
  scoreFromJSON,
  type TrackScore,
} from "../../core/score.ts";
import {
  historyTarget,
  paneHistoryStep,
  REDO_KIND,
  UNDO_KIND,
} from "../commands/history.ts";
import { historyEvents } from "../session/attach.ts";
import {
  appendSessionEvent,
  ensureSession,
  loadSession,
  type SessionPaths,
  type SessionRecord,
} from "../session/store.ts";
import { HISTORY_LIMITS, HistoryDb, historyPath } from "./db.ts";
import { historyHook } from "./hook.ts";
import { closeHistories, openHistory } from "./open.ts";
import {
  clearHistoryDirty,
  isHistoryDirty,
  markHistoryDirty,
  reconcileHistory,
  recordSessionEvent,
} from "./record.ts";
import { undoEvents } from "./undo-source.ts";

afterEach(() => closeHistories());

function band(): TrackScore {
  return emptyScore().withTracks([
    { id: "bass", instrument: "bass" },
    { id: "keys", instrument: "piano" },
  ]);
}

type Fixture = {
  workspace: string;
  paths: SessionPaths;
  record: SessionRecord<unknown>;
};

/** A session written by the plain store, as older dawg builds left it. */
async function fixture(
  edits = 12,
  hook = false,
  name = "fixture",
): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), "dawg-history-"));
  const created = await ensureSession<unknown>(band().toJSON(), {
    workspace,
    sessionId: name,
  });
  let record = created.record as SessionRecord<unknown>;
  let score = band();
  for (let index = 0; index < edits; index += 1) {
    const next =
      index % 3 === 2
        ? score.withTempo(90 + index)
        : score.addNote({
            id: `n${index}`,
            trackId: index % 2 === 0 ? "bass" : "keys",
            startTick: index * 96,
            durationTicks: 96,
            pitch: 40 + index,
            velocity: 0.7,
          });
    const ops = diffScores(score, next);
    record = await appendSessionEvent(
      created.paths,
      record,
      {
        kind: index === 5 ? "agent.tool" : "score.operation",
        payload: index === 5 ? { tool: "add_notes" } : {},
        ops: [...ops],
        actor: { clientId: index % 2 === 0 ? "pane-a" : "pane-b" },
      },
      next.toJSON(),
      hook
        ? historyHook(workspace, name, {
            letter: index % 2 === 0 ? "A" : "B",
          })
        : undefined,
    );
    score = next;
  }
  return { workspace, paths: created.paths, record };
}

describe("history migration from session JSON", () => {
  test("imports every event once, idempotently, with targets and actors", async () => {
    const { workspace, paths, record } = await fixture(12);
    const before = await readFile(paths.record, "utf8");
    const db = HistoryDb.open(workspace);
    const first = reconcileHistory(db, record);
    expect(first.imported).toBe(12);
    const again = reconcileHistory(db, record);
    expect(again.imported).toBe(0);
    // The session file is never rewritten by the import.
    expect(await readFile(paths.record, "utf8")).toBe(before);
    const all = db.query({
      sessionId: record.sessionId,
      limit: 500,
      order: "asc",
    });
    expect(all.rows.map((row) => row.rev)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(all.rows.every((row) => row.origin === "imported")).toBe(true);
    expect(all.rows[5]!.actor.kind).toBe("agent");
    expect(all.rows[0]!.actor.kind).toBe("human");
    const bass = db.query({
      sessionId: record.sessionId,
      track: "bass",
      limit: 500,
    });
    expect(bass.rows.length).toBeGreaterThan(0);
    expect(
      bass.rows.every((row) =>
        row.targets.some((t) => t.type === "track" && t.key === "bass"),
      ),
    ).toBe(true);
    const tempo = db.query({
      sessionId: record.sessionId,
      param: "tempo",
      limit: 500,
    });
    expect(tempo.rows.map((row) => row.rev)).toEqual([12, 9, 6, 3]);
    db.close();
  });

  test("a folded record imports what remains and reports the gap", async () => {
    const { workspace, record } = await fixture(6);
    const folded: SessionRecord<unknown> = {
      ...record,
      events: record.events.slice(3),
      folded: 3,
    };
    const db = HistoryDb.open(workspace);
    const report = reconcileHistory(db, folded);
    expect(report.imported).toBe(3);
    expect(report.foldedGap).toBe(3);
    expect(db.lastRev(record.sessionId)).toBe(6);
    db.close();
  });

  test("a damaged history file is quarantined, never deleted, and rebuilt", async () => {
    const { workspace, record } = await fixture(4);
    await writeFile(historyPath(workspace), "not a database at all, sorry");
    const db = HistoryDb.open(workspace);
    expect(db.report.quarantined).toBeDefined();
    const kept = await readdir(join(workspace, ".dawg"));
    expect(kept.some((file) => file.startsWith("history.db.corrupt-"))).toBe(
      true,
    );
    expect(reconcileHistory(db, record).imported).toBe(4);
    db.close();
  });

  test("a newer schema opens for reads and known-column inserts only", async () => {
    const { workspace, record } = await fixture(2);
    const db = HistoryDb.open(workspace);
    reconcileHistory(db, record);
    db.metaSet("schema_version", "999");
    db.close();
    const newer = HistoryDb.open(workspace);
    expect(newer.newerSchema).toBe(true);
    expect(newer.query({ sessionId: record.sessionId }).rows.length).toBe(2);
    newer.close();
  });
});

describe("history write path", () => {
  test("the commit hook records every edit in revision order with panes", async () => {
    const { workspace, record } = await fixture(9, true);
    const db = openHistory(workspace)!;
    const rows = db.query({
      sessionId: record.sessionId,
      limit: 50,
      order: "asc",
    }).rows;
    expect(rows.map((row) => row.rev)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rows.every((row) => row.origin === "local")).toBe(true);
    expect(rows[0]!.actor.pane).toBe("A");
    expect(rows[1]!.actor.pane).toBe("B");
    expect(
      db.query({ sessionId: record.sessionId, pane: "B", limit: 50 }).rows
        .length,
    ).toBe(4);
  });

  test("crash between the JSON commit and the DB insert: reconcile fills the gap", async () => {
    const { workspace, paths, record } = await fixture(3, true);
    const db = openHistory(workspace)!;
    // Simulate a crash: two edits commit to JSON with no hook.
    let current = record;
    let score = scoreFromJSON(current.composition);
    for (const bpm of [101, 102]) {
      const next = score.withTempo(bpm);
      current = await appendSessionEvent(
        paths,
        current,
        {
          kind: "score.operation",
          payload: {},
          ops: [...diffScores(score, next)],
        },
        next.toJSON(),
      );
      score = next;
    }
    expect(db.lastRev(record.sessionId)).toBe(3);
    // The next hooked edit reconciles first, so revisions stay contiguous.
    markHistoryDirty(record.sessionId);
    const next = score.withTempo(103);
    await appendSessionEvent(
      paths,
      current,
      {
        kind: "score.operation",
        payload: {},
        ops: [...diffScores(score, next)],
      },
      next.toJSON(),
      historyHook(workspace, record.sessionId),
    );
    const revs = db
      .query({ sessionId: record.sessionId, limit: 50, order: "asc" })
      .rows.map((row) => row.rev);
    expect(revs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(isHistoryDirty(record.sessionId)).toBe(false);
  });

  test("a failing hook never fails the committed edit", async () => {
    const { workspace, paths, record } = await fixture(1);
    const db = HistoryDb.open(workspace);
    db.close();
    const score = scoreFromJSON(record.composition).withTempo(77);
    const next = await appendSessionEvent(
      paths,
      record,
      { kind: "score.operation", payload: {} },
      score.toJSON(),
      (event, before, after) =>
        recordSessionEvent(db, record.sessionId, event, before, after),
    );
    expect(next.revision).toBe(2);
    expect(isHistoryDirty(record.sessionId)).toBe(true);
    clearHistoryDirty(record.sessionId);
    expect(
      ((await loadSession(paths)).composition as { tempoBpm: number }).tempoBpm,
    ).toBe(77);
  });

  test("a duplicate event id is a no-op, not a second row", async () => {
    const { workspace, record } = await fixture(2, true);
    const db = openHistory(workspace)!;
    const event = record.events[1]!;
    recordSessionEvent(db, record.sessionId, event, record, record);
    expect(
      db.query({ sessionId: record.sessionId, limit: 50 }).rows.length,
    ).toBe(2);
    expect(isHistoryDirty(record.sessionId)).toBe(false);
  });

  test("DB-only rows (comments) never break revision contiguity", async () => {
    const { workspace, record } = await fixture(3, true);
    const db = openHistory(workspace)!;
    const parent = db.byRev(record.sessionId, 2)!;
    const row = db.append({
      sessionId: record.sessionId,
      kind: "comment",
      atRev: 3,
      parentId: parent.id,
      actor: { kind: "human", pane: "A" },
      summary: "love this #keeper",
      body: "love this #keeper",
      tags: ["keeper"],
    });
    expect(row.rev).toBeNull();
    expect(
      db.query({ sessionId: record.sessionId, tag: "keeper" }).rows[0]!.id,
    ).toBe(row.id);
    expect(
      db.query({ sessionId: record.sessionId, parentId: parent.id }).rows[0]!
        .id,
    ).toBe(row.id);
    expect(
      db.query({ sessionId: record.sessionId, grep: "love" }).rows.length,
    ).toBe(1);
    expect(() => db.metaGet("schema_version")).not.toThrow();
  });
});

describe("undo reads from history", () => {
  async function stacks(
    events: Parameters<typeof historyTarget>[1],
    composition: unknown,
  ) {
    const undo = historyTarget(composition, events, "undo");
    const redo = historyTarget(composition, events, "redo");
    return { undo, redo };
  }

  test("undo and redo targets match the record-only path exactly", async () => {
    const { workspace, record } = await fixture(10, true);
    const db = openHistory(workspace)!;
    const fromDb = await undoEvents(db, workspace, record);
    const fromRecord = await historyEvents(workspace, record);
    expect(fromDb.map((event) => event.revision)).toEqual(
      fromRecord.map((event) => event.revision),
    );
    expect(await stacks(fromDb, record.composition)).toEqual(
      await stacks(fromRecord, record.composition),
    );
    expect(
      paneHistoryStep(record.composition, fromDb, "undo", "pane-a"),
    ).toEqual(
      paneHistoryStep(record.composition, fromRecord, "undo", "pane-a"),
    );
  });

  test("undo walks further back than the record keeps once rewinds are compacted", async () => {
    const { workspace, record } = await fixture(8, true);
    const db = openHistory(workspace)!;
    // The record dropped the rewinds of its oldest events (as trimRecord does).
    const trimmed: SessionRecord<unknown> = {
      ...record,
      events: record.events.map((event, index) =>
        index < 5 ? { ...event, rewind: undefined } : event,
      ) as SessionRecord<unknown>["events"],
    };
    const recordOnly = await historyEvents(workspace, trimmed);
    const viaDb = await undoEvents(db, workspace, trimmed);
    const reachable = (events: Parameters<typeof historyTarget>[1]) => {
      let composition: unknown = trimmed.composition;
      let all = [...events];
      let steps = 0;
      for (;;) {
        const target = historyTarget(composition, all, "undo");
        if (!target) return steps;
        composition = target.composition;
        all = [
          ...all,
          {
            revision: all.at(-1)!.revision + 1,
            kind: UNDO_KIND,
            payload: { undoneRevision: target.revision },
            rewind: undefined,
            actor: undefined,
          },
        ];
        steps += 1;
        if (steps > 50) return steps;
      }
    };
    expect(REDO_KIND).toBe("score.redo");
    expect(reachable(viaDb)).toBeGreaterThanOrEqual(reachable(recordOnly));
    expect(viaDb.filter((event) => event.rewind !== undefined).length).toBe(8);
  });

  test("without a DB undo falls back to the record", async () => {
    const { workspace, record } = await fixture(3);
    const events = await undoEvents(undefined, workspace, record);
    expect(events.map((event) => event.revision)).toEqual([1, 2, 3]);
  });
});

describe("history stays bounded", () => {
  test("edit-path append latency and DB growth are bounded", async () => {
    const { workspace, record } = await fixture(1, true);
    const db = openHistory(workspace)!;
    let score = scoreFromJSON(record.composition);
    const ms: number[] = [];
    const rows = 400;
    let current = record;
    for (let index = 0; index < rows; index += 1) {
      const next = score.addNote({
        id: `p${index}`,
        trackId: index % 2 ? "bass" : "keys",
        startTick: (index % 64) * 48,
        durationTicks: 48,
        pitch: 36 + (index % 48),
        velocity: 0.6,
      });
      const event = {
        id: `perf-${index}`,
        revision: current.revision + 1,
        at: new Date().toISOString(),
        kind: "score.operation",
        payload: {},
        ops: [...diffScores(score, next)],
      };
      const after = {
        ...current,
        revision: event.revision,
        composition: next.toJSON(),
      };
      const started = performance.now();
      recordSessionEvent(db, record.sessionId, event, current, after);
      ms.push(performance.now() - started);
      current = after as SessionRecord<unknown>;
      score = next;
    }
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.floor(ms.length * 0.95)]!;
    // The design budget is 2 ms; budget() scales it on a loaded host.
    expect(p95).toBeLessThan(budget(HISTORY_LIMITS.appendBudgetMs * 2));
    const bytes =
      (await stat(historyPath(workspace))).size +
      (await stat(`${historyPath(workspace)}-wal`).catch(() => ({ size: 0 })))
        .size;
    // A few KiB per small edit at most.
    expect(bytes / rows).toBeLessThan(16 * 1024);
  });

  test("rewinds are capped per session, oldest first, keeping metadata", async () => {
    const { workspace, record } = await fixture(10, true);
    const db = openHistory(workspace)!;
    const dropped = db.capRewinds(record.sessionId, 4, Number.MAX_SAFE_INTEGER);
    expect(dropped).toBe(6);
    const meta = db.undoMeta(record.sessionId);
    expect(meta.length).toBe(10);
    expect(meta.filter((m) => m.hasRewind).map((m) => m.rev)).toEqual([
      7, 8, 9, 10,
    ]);
  });

  test("history is a sidecar: opening the copy read-only never writes", async () => {
    const { workspace, record } = await fixture(2, true);
    openHistory(workspace);
    closeHistories();
    const copy = await mkdtemp(join(tmpdir(), "dawg-history-ro-"));
    await Bun.write(join(copy, ".dawg", "x"), "");
    await copyFile(historyPath(workspace), historyPath(copy));
    const before = await readFile(historyPath(copy));
    const ro = HistoryDb.open(copy, { readonly: true });
    expect(ro.query({ sessionId: record.sessionId }).rows.length).toBe(2);
    ro.close();
    expect(Buffer.compare(before, await readFile(historyPath(copy)))).toBe(0);
    const raw = new Database(historyPath(copy), { readonly: true });
    expect(raw.query("SELECT count(*) AS n FROM events").get()).toEqual({
      n: 2,
    });
    raw.close();
  });
});
