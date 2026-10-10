import { expect, test } from "bun:test";
import { PromptQueue } from "./prompt-queue.ts";

/** Runs the queue as the editor does: a step's lines go first. */
const drain = (queue: PromptQueue): string[] => {
  const out: string[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift())
    if (typeof next === "function") queue.runFirst(...next());
    else out.push(next);
  return out;
};

test("lines typed faster than they run keep their order", () => {
  const queue = new PromptQueue();
  for (const line of ["section verse 1-4", "track drums", "track bass"])
    queue.runNow(line);
  expect(queue.length).toBe(3);
  expect(drain(queue)).toEqual([
    "section verse 1-4",
    "track drums",
    "track bass",
  ]);
  expect(queue.length).toBe(0);
});

test("a gesture's commands run together and in order: v v pastes and jumps", () => {
  const queue = new PromptQueue();
  queue.runNow("paste", "jump 3");
  queue.runNow("paste", "jump 4");
  expect(drain(queue)).toEqual(["paste", "jump 3", "paste", "jump 4"]);
});

test("Enter runs ahead of Alt-Enter follow-ups; each lane is first in, first out", () => {
  const queue = new PromptQueue();
  queue.runNext("later 1");
  queue.runNext("later 2");
  queue.runNow("now 1");
  expect(queue.shift()).toBe("now 1");
  queue.runNow("now 2");
  queue.runNow("now 3");
  expect(drain(queue)).toEqual(["now 2", "now 3", "later 1", "later 2"]);
});

test("a step decides its lines at its turn and they run before later lines", () => {
  const queue = new PromptQueue();
  let loop = 4;
  const ran: string[] = [];
  const shrink = (): readonly string[] => [`loop 1-${loop - 1}`];
  queue.runNow("loop 1-4", shrink, "keys record");
  queue.runNext("follow-up");
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (typeof next === "function") {
      queue.runFirst(...next());
      continue;
    }
    ran.push(next);
    const bars = /^loop 1-(\d+)$/.exec(next);
    if (bars) loop = Number(bars[1]);
  }
  expect(ran).toEqual(["loop 1-4", "loop 1-3", "keys record", "follow-up"]);
});
