/**
 * Session history end to end at 80x24 (design §3, §4.3): an edit is
 * recorded in .dawg/history.db, `/comment` captures the pane's context
 * and says so on its receipt, `/comments` lists it, and `/history` opens
 * the newest-last picker. NO_COLOR keeps every mark and word.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, supported } from "./pty-harness.ts";

async function walk(env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "dawg-pty-hist-"));
  const t = await launch(80, 24, env, ["--track", "bass"], dir);
  try {
    await t.until(() => t.vt.text().includes(" NOW "), "prompt");
    await t.type("add C4 at 1\r", "edit");
    await t.settle("edit");
    await t.type("/comment that bass line #good\r", "comment");
    await t.settle("comment");
    // The receipt is the frame after the settled state.
    await t.until(() => t.vt.text().includes("commented #"), "receipt");
    expect(t.vt.text()).toMatch(/commented #\d+ · 1\.1 · bass/);
    await t.type("/comments\r", "comments");
    await t.settle("comments");
    await t.until(() => t.vt.text().includes("comments ·"), "comments");
    expect(t.vt.text()).toContain("that bass line #good");
    await t.type("\u001b", "close");
    await t.settle("closed");
    await t.type("/history\r", "history");
    await t.settle("history");
    await t.until(() => t.vt.text().includes("history ·"), "history");
    expect(t.vt.text()).toContain("that bass line");
    // Enter jumps to the comment's moment: its playhead and track.
    await t.type("\r", "jump");
    await t.settle("jump");
    expect(t.state()?.overlay).toBeNull();
    expect(t.state()?.track).toBe("bass");
    expect(t.vt.wrapsSinceClear).toBe(0);
    expect(t.proc.exitCode).toBeNull();
  } finally {
    t.proc.kill();
    await t.proc.exited;
  }
  const path = join(dir, ".dawg", "history.db");
  expect(existsSync(path)).toBe(true);
  const db = new Database(path, { readonly: true });
  try {
    const kinds = (
      db.query("SELECT kind FROM events ORDER BY seq").all() as {
        kind: string;
      }[]
    ).map((row) => row.kind);
    expect(kinds).toContain("edit");
    expect(kinds).toContain("comment");
    const comment = db
      .query("SELECT context FROM events WHERE kind = 'comment'")
      .get() as { context: string | null };
    const context = JSON.parse(comment.context ?? "{}") as {
      focus?: { trackId?: string };
      view?: { screen?: string };
    };
    expect(context.focus?.trackId).toBe("bass");
    expect(context.view?.screen).toBe("home");
  } finally {
    db.close();
  }
}

test.skipIf(!supported)(
  "real PTY 80x24 NO_COLOR: an edit, /comment with context, /comments, /history",
  () => walk({ NO_COLOR: "1" }),
  60_000,
);

test.skipIf(!supported)(
  "real PTY 80x24 color: /comment and /history",
  () => walk({}),
  60_000,
);
