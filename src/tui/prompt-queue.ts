/**
 * The editor's prompt queue: two first-in, first-out lanes.
 *
 * - `now`: lines submitted with Enter, menu and picker picks, and the typed
 *   commands a TAPE gesture echoes. They run ahead of queued follow-ups, in
 *   the order they arrived: `track drums` then `track bass` typed while an
 *   edit is still running ends on bass, and `v v` pastes then jumps twice.
 * - `next`: Alt-Enter follow-ups, which wait for every `now` line.
 *
 * One lane used to take `now` lines at its front (`unshift`), so lines typed
 * faster than they ran came out newest first.
 */
/**
 * A queued line, or a step that decides its lines when its turn comes (a
 * TAPE key typed ahead reduces from what the lines before it left).
 */
export type QueuedPrompt = string | (() => readonly string[]);

export class PromptQueue {
  private readonly now: QueuedPrompt[] = [];
  private readonly next: QueuedPrompt[] = [];

  /** Run ahead of queued follow-ups, after earlier `now` lines. */
  runNow(...prompts: readonly QueuedPrompt[]): void {
    this.now.push(...prompts);
  }

  /** Run before anything else waiting: a dequeued step's own lines. */
  runFirst(...prompts: readonly string[]): void {
    this.now.unshift(...prompts);
  }

  /** Run after everything already waiting. */
  runNext(prompt: string): void {
    this.next.push(prompt);
  }

  /** The next prompt to run, `now` lines first. */
  shift(): QueuedPrompt | undefined {
    return this.now.shift() ?? this.next.shift();
  }

  get length(): number {
    return this.now.length + this.next.length;
  }
}
