/**
 * A process-global history handle for code that has no host to hold one
 * (project sync, the audio engine, dev logs). Set by the TUI wiring when a
 * session opens; absent means "no history here" and every caller no-ops.
 */
import type { HistoryHandle } from "./types.ts";

let current: HistoryHandle | undefined;

export function setHistorySink(handle: HistoryHandle | undefined): void {
  current = handle;
}

export function historySink(): HistoryHandle | undefined {
  return current;
}
