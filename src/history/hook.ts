/**
 * The `onCommitted` hook both session writers pass to `appendSessionEvent`
 * (design §2.5): the daemon and `FilePort.append`. It opens the workspace's
 * history DB on first use and, when the session was dirty (a crash, an
 * older build, a busy DB), reconciles from the record before recording the
 * new event, so rows stay contiguous by revision.
 */
import type { SessionEvent, SessionRecord } from "../session/store.ts";
import { openHistory } from "./open.ts";
import {
  isHistoryDirty,
  reconcileHistory,
  recordSessionEvent,
  type PaneStamp,
} from "./record.ts";

export type CommitHook = (
  event: SessionEvent,
  diskBefore: SessionRecord<unknown>,
  after: SessionRecord<unknown>,
) => void;

const reconciled = new Set<string>();

export function historyHook(
  workspace: string,
  sessionId: string,
  pane?: PaneStamp,
): CommitHook | undefined {
  const db = openHistory(workspace);
  if (db === undefined || db.readonly) return undefined;
  return (event, diskBefore, after) => {
    const key = `${db.path}\u0000${sessionId}`;
    if (!reconciled.has(key) || isHistoryDirty(sessionId)) {
      // Everything before this event: the record as it was on disk.
      try {
        reconcileHistory(db, diskBefore);
        reconciled.add(key);
      } catch {
        // Stays dirty; the next commit retries.
      }
    }
    recordSessionEvent(db, sessionId, event, diskBefore, after, pane);
  };
}
