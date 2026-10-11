/**
 * History filters from words (design §4.1): the CLI's `--track bass`
 * flags, `/history track bass` in the TUI and the agent's `history_query`
 * all build a `HistoryFilter` here, so the three read the same way.
 */
import type { TrackScore } from "../../core/score.ts";
import { parseSince } from "./db.ts";
import {
  ACTOR_KINDS,
  HISTORY_KINDS,
  type ActorKind,
  type HistoryFilter,
  type HistoryKind,
} from "./types.ts";

/** Filter words that take a value (`track bass`, `--track bass`, `track:bass`). */
export const FILTER_KEYS: readonly string[] = [
  "session",
  "kind",
  "actor",
  "track",
  "instrument",
  "effect",
  "node",
  "param",
  "bars",
  "pane",
  "tag",
  "grep",
  "since",
  "rev",
  "limit",
  "before",
];

function list<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  what: string,
): T[] | { error: string } | undefined {
  if (value === undefined) return undefined;
  const out: T[] = [];
  for (const word of value.split(",").map((each) => each.trim())) {
    if (!(allowed as readonly string[]).includes(word))
      return {
        error: `unknown ${what} ${word} · one of ${allowed.join(", ")}`,
      };
    out.push(word as T);
  }
  return out;
}

function range(value: string): [number, number] | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const from = Number(match[1]);
  const to = match[2] !== undefined ? Number(match[2]) : from;
  return to >= from ? [from, to] : undefined;
}

export type Composition = {
  tracks?: { id: string; name?: string; instrument?: string }[];
};

function trackResolver(
  composition: Composition | undefined,
): (word: string) => string | undefined {
  const tracks = composition?.tracks ?? [];
  return (word) => {
    const lower = word.toLowerCase();
    return (
      tracks.find((track) => track.id === word)?.id ??
      tracks.find((track) => track.id.toLowerCase() === lower)?.id ??
      tracks.find((track) => (track.name ?? "").toLowerCase() === lower)?.id
    );
  };
}

/** Builds the query filter from parsed flags. */
export function filterFromFlags(
  values: ReadonlyMap<string, string>,
  sessionId: string | undefined,
  composition: Composition | undefined,
): { filter: HistoryFilter; sinceSeq?: number } | { error: string } {
  const filter: { -readonly [K in keyof HistoryFilter]: HistoryFilter[K] } = {};
  const session = values.get("session") ?? sessionId;
  if (session !== undefined) filter.sessionId = session;
  const kinds = list<HistoryKind>(values.get("kind"), HISTORY_KINDS, "kind");
  if (kinds && "error" in kinds) return kinds;
  if (kinds) filter.kinds = kinds;
  const actors = list<ActorKind>(values.get("actor"), ACTOR_KINDS, "actor");
  if (actors && "error" in actors) return actors;
  if (actors) filter.actors = actors;
  const track = values.get("track");
  if (track !== undefined)
    filter.track = trackResolver(composition)(track) ?? track;
  for (const key of [
    "instrument",
    "effect",
    "node",
    "param",
    "pane",
    "tag",
    "grep",
  ] as const) {
    const value = values.get(key);
    if (value !== undefined)
      filter[key] =
        key === "tag" ? value.replace(/^#/, "").toLowerCase() : value;
  }
  const bars = values.get("bars");
  if (bars !== undefined) {
    const parsed = range(bars);
    if (!parsed) return { error: "--bars wants A-B, e.g. 9-16" };
    filter.bars = parsed;
  }
  const rev = values.get("rev");
  if (rev !== undefined) {
    const parsed = range(rev);
    if (!parsed) return { error: "--rev wants N or A-B" };
    filter.rev = parsed[0] === parsed[1] ? parsed[0] : parsed;
  }
  let sinceSeq: number | undefined;
  const since = values.get("since");
  if (since !== undefined) {
    const seq = /^seq:(\d+)$/.exec(since);
    if (seq) sinceSeq = filter.sinceSeq = Number(seq[1]);
    else {
      const at = parseSince(since);
      if (at === undefined)
        return { error: "--since wants 10m, 2h, 1d, an ISO time or seq:N" };
      filter.sinceAt = at;
    }
  }
  const limit = values.get("limit");
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1)
      return { error: "--limit wants a positive number" };
    filter.limit = Math.min(500, Number(limit));
  }
  const before = values.get("before");
  if (before !== undefined) {
    if (!/^\d+$/.test(before))
      return { error: "--before wants a row number (seq)" };
    filter.beforeSeq = Number(before);
  }
  return { filter, ...(sinceSeq !== undefined ? { sinceSeq } : {}) };
}

const KIND_WORDS: Readonly<Record<string, HistoryKind>> = {
  comments: "comment",
  comment: "comment",
  edits: "edit",
  edit: "edit",
  undos: "undo",
  tools: "tool",
  turns: "turn",
  logs: "log",
};

/**
 * Parses filter words: `track bass`, `--param volume`, `tag:love`,
 * `bars 9-16`, `#love` (a tag), `comments` (a kind), `agent` (an actor);
 * anything else is grep text. Tracks resolve by id or name against
 * `score`.
 */
export function parseHistoryFilterWords(
  words: readonly string[],
  score: TrackScore | Composition | undefined,
  sessionId?: string,
): { filter: HistoryFilter } | { error: string } {
  const values = new Map<string, string>();
  const kinds: string[] = [];
  const actors: string[] = [];
  const grep: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const raw = words[index]!;
    const word = raw.replace(/^--?/, "");
    const colon = /^([a-z]+)[:=](.+)$/i.exec(word);
    if (colon && FILTER_KEYS.includes(colon[1]!.toLowerCase())) {
      values.set(colon[1]!.toLowerCase(), colon[2]!);
      continue;
    }
    const lower = word.toLowerCase();
    if (FILTER_KEYS.includes(lower)) {
      const value = words[index + 1];
      if (value === undefined) return { error: `${lower} needs a value` };
      values.set(lower, value);
      index += 1;
      continue;
    }
    if (raw.startsWith("-"))
      return { error: `unknown filter ${raw.slice(0, 40)}` };
    if (/^#[a-z0-9]/i.test(raw)) {
      values.set("tag", raw.slice(1));
      continue;
    }
    if (KIND_WORDS[lower] !== undefined) {
      kinds.push(KIND_WORDS[lower]);
      continue;
    }
    if ((ACTOR_KINDS as readonly string[]).includes(lower)) {
      actors.push(lower);
      continue;
    }
    grep.push(raw);
  }
  if (kinds.length > 0 && !values.has("kind"))
    values.set("kind", kinds.join(","));
  if (actors.length > 0 && !values.has("actor"))
    values.set("actor", actors.join(","));
  if (grep.length > 0 && !values.has("grep"))
    values.set("grep", grep.join(" "));
  const composition: Composition | undefined =
    score === undefined
      ? undefined
      : {
          tracks: score.tracks?.map((track) => ({
            id: track.id,
            name: track.name,
            instrument:
              typeof track.instrument === "string"
                ? track.instrument
                : undefined,
          })),
        };
  const built = filterFromFlags(values, sessionId, composition);
  if ("error" in built) return { error: built.error.replace(/^--/, "") };
  return { filter: built.filter };
}
