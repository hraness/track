/**
 * One `HistoryDb` per workspace per process (design §2.4). Opening never
 * throws: history is a sidecar of the JSON session record, so a missing
 * SQLite, a read-only disk or a locked file leaves editing untouched and
 * the record stays the source of truth. `DAWG_HISTORY=off` disables it.
 */
import { resolve } from "node:path";
import { HistoryDb, type OpenOptions } from "./db.ts";

const open = new Map<string, HistoryDb | null>();

export function historyDisabled(env = process.env): boolean {
  const value = (env.DAWG_HISTORY ?? "").toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

/**
 * The workspace's history DB, opened writable on first use and cached;
 * undefined when history is disabled or the DB cannot be opened.
 */
export function openHistory(
  workspace: string,
  opts: OpenOptions = {},
): HistoryDb | undefined {
  if (historyDisabled()) return undefined;
  const key = resolve(workspace);
  const cached = open.get(key);
  if (cached !== undefined) return cached ?? undefined;
  let db: HistoryDb | null = null;
  try {
    db = HistoryDb.open(key, opts);
  } catch {
    db = null;
  }
  open.set(key, db);
  return db ?? undefined;
}

/** Closes every cached DB (process exit, tests). */
export function closeHistories(): void {
  for (const db of open.values()) {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
  open.clear();
}

/** Forgets one workspace's cached DB, closing it. */
export function closeHistory(workspace: string): void {
  const key = resolve(workspace);
  try {
    open.get(key)?.close();
  } catch {
    // Already closed.
  }
  open.delete(key);
}
