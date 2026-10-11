import { newId } from "../../core/ids.ts";
import type { HistoryHandle } from "./types.ts";

/** A handle that accepts and drops everything: tests and history-less hosts. */
export function noopHistoryHandle(rev = 0): HistoryHandle {
  return Object.freeze({
    append(e) {
      return { id: e.id ?? newId("ev"), done: Promise.resolve(undefined) };
    },
    query() {
      return { rows: [] };
    },
    context() {
      return { rev };
    },
  });
}
