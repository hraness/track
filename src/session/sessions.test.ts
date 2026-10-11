import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScore } from "../../core/score.ts";
import {
  forkSession,
  historyEvents,
  resolveSessionArg,
  SessionLookupError,
} from "./attach.ts";
import { DaemonClient } from "./client.ts";
import { openSessionPort } from "./port.ts";
import { listSessions, resolveSession } from "./list.ts";
import {
  forkName,
  MetaValidationError,
  normalizeSessionName,
  parseMetaPatch,
  parseSessionMeta,
  uniqueName,
} from "./meta.ts";
import { historyTarget, UNDO_KIND } from "../commands/history.ts";
import {
  appendSessionEvent,
  ensureSession,
  inheritedEvents,
  loadSession,
  readCurrentSessionId,
  sessionPaths,
  updateSessionMeta,
} from "./store.ts";

const workspaces: string[] = [];
const clients: DaemonClient[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dawg-sessions-"));
  workspaces.push(dir);
  return dir;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const dir of workspaces.splice(0)) {
    const sessions = join(dir, ".dawg", "sessions");
    for await (const owner of new Bun.Glob("*.daemon.lock/owner").scan(
      sessions,
    )) {
      try {
        const { pid } = JSON.parse(
          await readFile(join(sessions, owner), "utf8"),
        ) as { pid: number };
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

const initial = createScore({
  tracks: [{ id: "main", name: "main", instrument: "sine" }],
}).toJSON();

describe("session names", () => {
  test("fork numbering: x → x 2 → x 3; a fork of x 2 is x 3", () => {
    expect(forkName("x", ["x"])).toBe("x 2");
    expect(forkName("x", ["x", "x 2"])).toBe("x 3");
    expect(forkName("x 2", ["x", "x 2"])).toBe("x 3");
    expect(forkName("x 2", ["x", "x 2", "x 3", "y 9"])).toBe("x 4");
    expect(forkName("night drive", [])).toBe("night drive 2");
    // A trailing "1" or a year-like number is part of the name only when < 2.
    expect(forkName("take 1", ["take 1"])).toBe("take 1 2");
    expect(uniqueName("Song", ["song", "song 2"])).toBe("Song 3");
    expect(forkName("x".repeat(40), []).length).toBeLessThanOrEqual(40);
  });

  test("bounds and validates foreign metadata", () => {
    expect(normalizeSessionName("  Late\u0007 night\n  jam  ")).toBe(
      "Late night jam",
    );
    expect(normalizeSessionName("x".repeat(90))).toHaveLength(40);
    expect(() => normalizeSessionName("   ")).toThrow(MetaValidationError);
    expect(() => normalizeSessionName(7)).toThrow(MetaValidationError);
    expect(() => parseMetaPatch({ nameSource: "robot" })).toThrow(
      MetaValidationError,
    );
    expect(() => parseMetaPatch(null)).toThrow(MetaValidationError);
    const fallback = {
      sessionId: "abcdef123456",
      updatedAt: "2026-10-06T00:00:00.000Z",
    };
    const meta = parseSessionMeta(undefined, fallback);
    expect(meta.name).toBe("session abcdef12");
    expect(meta.nameSource).toBe("auto");
    expect(() =>
      parseSessionMeta(
        {
          name: "ok",
          nameSource: "auto",
          forkOf: { sessionId: "../x", revision: 1 },
        },
        fallback,
      ),
    ).toThrow();
  });

  test("forks snapshot the composition with lineage and move the pointer", async () => {
    const dir = await workspace();
    const base = await ensureSession(initial, { workspace: dir, name: "x" });
    const two = await forkSession(dir, base.record, undefined);
    expect(two.meta.name).toBe("x 2");
    expect(two.meta.forkOf).toEqual({
      sessionId: base.record.sessionId,
      revision: 0,
    });
    expect(two.composition).toEqual(base.record.composition);
    expect(await readCurrentSessionId(dir)).toBe(two.sessionId);
    const three = await forkSession(dir, two, undefined);
    expect(three.meta.name).toBe("x 3");
    const again = await forkSession(dir, base.record, undefined);
    expect(again.meta.name).toBe("x 4");
    const named = await forkSession(dir, base.record, "x 3");
    expect(named.meta.name).toBe("x 5");
    const listed = await listSessions(dir);
    expect(listed.map((s) => s.name).sort()).toEqual([
      "x",
      "x 2",
      "x 3",
      "x 4",
      "x 5",
    ]);
    expect(listed.find((s) => s.name === "x 3")?.forkOf?.sessionId).toBe(
      two.sessionId,
    );
  });

  test("undo in a fork steps back past the fork point into the parent", async () => {
    const dir = await workspace();
    const base = await ensureSession<unknown>({ v: 0 }, { workspace: dir });
    let parent = base.record;
    for (const v of [1, 2])
      parent = await appendSessionEvent(
        base.paths,
        parent,
        { kind: "score.edit", payload: {} },
        { v },
      );
    const fork = await forkSession(dir, parent, "f");
    // The parent keeps editing after the fork; the fork must not see it.
    parent = await appendSessionEvent(
      base.paths,
      parent,
      { kind: "score.edit", payload: {} },
      { v: 99 },
    );
    expect(fork.events).toHaveLength(0);
    const events = await historyEvents(dir, fork);
    expect(events).toHaveLength(2);
    // Undo restores the composition before the parent's last pre-fork edit.
    expect(historyTarget(fork.composition, events, "undo")).toEqual({
      revision: 2,
      composition: { v: 1 },
    });
    // After one undo in the fork, the next undo reaches the parent's first edit.
    const undone = await appendSessionEvent(
      sessionPaths(dir, fork.sessionId),
      fork,
      { kind: UNDO_KIND, payload: { undoneRevision: 2 } },
      { v: 1 },
    );
    expect(
      historyTarget(
        undone.composition,
        await historyEvents(dir, undone),
        "undo",
      )?.composition,
    ).toEqual({ v: 0 });
    // A fork of a fork walks the whole chain.
    const grand = await forkSession(dir, fork, "g");
    expect(await historyEvents(dir, grand)).toHaveLength(2);
  });

  test("inherited history is bounded and tolerates bad lineage", async () => {
    const dir = await workspace();
    const self = "self-id";
    // Missing parent: empty.
    expect(
      await inheritedEvents(
        dir,
        {
          ...(await ensureSession<unknown>({}, { workspace: dir })).record.meta,
          forkOf: { sessionId: "missing", revision: 3 },
        },
        self,
      ),
    ).toEqual([]);
    // Forked past the parent's revision: inconsistent, ignored.
    const parent = await ensureSession<unknown>(
      {},
      { workspace: dir, sessionId: "p1", setCurrent: false },
    );
    expect(
      await inheritedEvents(
        dir,
        { ...parent.record.meta, forkOf: { sessionId: "p1", revision: 5 } },
        self,
      ),
    ).toEqual([]);
    // A cycle back to itself stops.
    expect(
      await inheritedEvents(
        dir,
        { ...parent.record.meta, forkOf: { sessionId: self, revision: 0 } },
        self,
      ),
    ).toEqual([]);
  });

  test("--session resolves names, ids, and reports ambiguity", async () => {
    const dir = await workspace();
    const a = await ensureSession(initial, {
      workspace: dir,
      name: "night drive",
    });
    await ensureSession(initial, {
      workspace: dir,
      sessionId: "b-id",
      name: "Night Drift",
    });
    expect(await resolveSessionArg(dir, "night drive")).toBe(
      a.record.sessionId,
    );
    expect(await resolveSessionArg(dir, "NIGHT DRIVE")).toBe(
      a.record.sessionId,
    );
    expect(await resolveSessionArg(dir, "b-id")).toBe("b-id");
    // An id-shaped typo is an error, never a silently created session.
    await expect(resolveSessionArg(dir, "brand-new")).rejects.toThrow(
      'no session named "brand-new" · dawg sessions',
    );
    // Duplicate names (e.g. two legacy records) need an id.
    await ensureSession(initial, {
      workspace: dir,
      sessionId: "c-id",
      name: "dup",
    });
    await ensureSession(initial, {
      workspace: dir,
      sessionId: "d-id",
      name: "dup",
    });
    await expect(resolveSessionArg(dir, "dup")).rejects.toBeInstanceOf(
      SessionLookupError,
    );
    const listed = await listSessions(dir);
    expect(resolveSession(listed, "dup").status).toBe("ambiguous");
    await expect(resolveSessionArg(dir, "no such ☃ name")).rejects.toThrow(
      "no session named",
    );
  });

  test("legacy records without meta load with an id-based auto name", async () => {
    const dir = await workspace();
    const { paths } = await ensureSession(initial, { workspace: dir });
    const raw = JSON.parse(await readFile(paths.record, "utf8")) as Record<
      string,
      unknown
    >;
    delete raw.meta;
    await writeFile(paths.record, JSON.stringify(raw));
    const record = await loadSession(paths);
    expect(record.meta.name).toBe(`session ${record.sessionId.slice(0, 8)}`);
    expect(record.meta.nameSource).toBe("auto");
  });
});

describe("rename", () => {
  test("file: a user rename beats a stale auto-name", async () => {
    const dir = await workspace();
    const { paths } = await ensureSession(initial, { workspace: dir });
    const auto = { name: "untitled", nameSource: "auto" as const };
    expect(
      (await updateSessionMeta(paths, { name: "mine", nameSource: "user" }))
        .status,
    ).toBe("applied");
    const late = await updateSessionMeta(paths, { name: "model name" }, auto);
    expect(late.status).toBe("stale");
    expect(late.record.meta.name).toBe("mine");
    // /rename --auto hands naming back.
    await updateSessionMeta(paths, { nameSource: "auto" });
    const next = await updateSessionMeta(
      paths,
      { name: "model name" },
      { name: "mine", nameSource: "auto" },
    );
    expect(next.status).toBe("applied");
    // An auto-name computed from an older score revision is stale too.
    const revision = next.record.revision;
    const older = await updateSessionMeta(
      paths,
      { name: "older score" },
      { name: "model name", nameSource: "auto", revision: revision - 1 },
    );
    expect(older.status).toBe("stale");
    const current = await updateSessionMeta(
      paths,
      { name: "current score" },
      { name: "model name", nameSource: "auto", revision },
    );
    expect(current.status).toBe("applied");
    expect(current.record.meta.name).toBe("current score");
  });

  test("file sessions see renames from another window without polling delay", async () => {
    const dir = await workspace();
    const { paths, record } = await ensureSession(initial, { workspace: dir });
    // The backstop poll is pushed far past the test's deadline, so a rename
    // that arrives at all arrived through fs.watch (no wall-clock bound).
    const open = (label: string) =>
      openSessionPort({
        paths,
        sessionId: record.sessionId,
        label,
        focusedTrackId: null,
        daemon: false,
        watchedPollMs: 600_000,
      });
    const a = await open("a");
    const b = await open("b");
    const seen: string[] = [];
    let baseline = false;
    const stop = b.subscribe((update) => {
      if (update.type === "record") baseline = true;
      if (update.type === "meta") seen.push(update.meta.name);
    });
    try {
      const ready = Date.now() + 10_000;
      while (!baseline && Date.now() < ready) await Bun.sleep(5);
      expect(baseline).toBe(true);
      await a.updateMeta({ name: "watched", nameSource: "user" });
      const deadline = Date.now() + 10_000;
      while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(5);
      expect(seen[0]).toBe("watched");
    } finally {
      stop();
      await a.close();
      await b.close();
    }
  }, 30_000);

  test("dawgd: renames broadcast to every window and stale auto-names drop", async () => {
    const dir = await workspace();
    const { record } = await ensureSession(initial, { workspace: dir });
    const connect = async (label: string) => {
      const client = await DaemonClient.connect({
        workspace: dir,
        sessionId: record.sessionId,
        label,
        daemonArgs: ["--grace-ms", "300"],
      });
      clients.push(client);
      return client;
    };
    const a = await connect("a");
    const b = await connect("b");
    const seen: string[] = [];
    b.subscribe((update) => {
      if (update.type === "meta") seen.push(update.meta.name);
    });
    const expectAuto = { name: "untitled", nameSource: "auto" as const };
    const [user, auto] = await Promise.all([
      a.updateMeta({ name: "my song", nameSource: "user" }),
      // Sent second on another socket: computed against the old name.
      Bun.sleep(5).then(() => b.updateMeta({ name: "model name" }, expectAuto)),
    ]);
    expect(user).toBe("applied");
    expect(auto).toBe("stale");
    const deadline = Date.now() + 3_000;
    while (!seen.includes("my song") && Date.now() < deadline)
      await Bun.sleep(20);
    expect(seen).toContain("my song");
    expect(b.record.meta.name).toBe("my song");
    expect(b.record.meta.nameSource).toBe("user");
    // Persisted for the next launch.
    const { paths } = await ensureSession(initial, {
      workspace: dir,
      sessionId: record.sessionId,
    });
    expect((await loadSession(paths)).meta.name).toBe("my song");
  });
});
