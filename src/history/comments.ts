/**
 * Comments (design §3): resolving a `/comment @ref`, building the row with
 * the captured context, writing it (DB plus the fsync'd `comments.jsonl`
 * mirror), and listing them for `/comments`. Shared by the TUI, the CLI's
 * `dawg history comment` and the agent's `comment` tool.
 */
import type { CommentRef, ParsedComment } from "../commands/comment.ts";
import { mirrorComment, type HistoryDb } from "./db.ts";
import { contextTargets } from "./targets.ts";
import type {
  ActorKind,
  CommentContext,
  HistoryAppend,
  HistoryFilter,
  HistoryRow,
  TargetRef,
} from "./types.ts";

export type CommentAuthor = Readonly<{
  kind: ActorKind;
  actorId?: string;
  clientId?: string;
  pane?: string;
  paneKey?: string;
}>;

const SCORE_KINDS = ["edit", "undo", "redo"] as const;

/**
 * The event a reference points at, or an error line. `none` resolves to
 * undefined (a comment about the moment).
 */
export function resolveCommentRef(
  db: HistoryDb,
  sessionId: string,
  ref: CommentRef,
  author: CommentAuthor,
): { row: HistoryRow | undefined } | { error: string } {
  switch (ref.type) {
    case "none":
      return { row: undefined };
    case "last": {
      const row = db.query({ sessionId, kinds: SCORE_KINDS, limit: 1 }).rows[0];
      return row ? { row } : { error: "no edits yet to comment on" };
    }
    case "agent": {
      const row = db.query({
        sessionId,
        kinds: ["edit"],
        actors: ["agent", "subagent"],
        limit: 1,
      }).rows[0];
      return row ? { row } : { error: "the agent has not edited this session" };
    }
    case "mine": {
      const pane = author.clientId ?? author.pane;
      const row =
        pane !== undefined
          ? db.query({ sessionId, kinds: SCORE_KINDS, pane, limit: 1 }).rows[0]
          : undefined;
      return row ? { row } : { error: "this pane has not edited yet" };
    }
    case "rev": {
      const row = db.byRev(sessionId, ref.rev);
      return row ? { row } : { error: `no revision ${ref.rev} in history` };
    }
    case "event": {
      const row = db.get(ref.idPrefix);
      return row && row.sessionId === sessionId
        ? { row }
        : { error: `no event ${ref.idPrefix} in this session` };
    }
  }
}

function mergeTargets(
  a: readonly TargetRef[],
  b: readonly TargetRef[],
): TargetRef[] {
  const seen = new Set<string>();
  const out: TargetRef[] = [];
  for (const target of [...a, ...b]) {
    const key = `${target.type}\u0000${target.key}\u0000${target.trackId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
    if (out.length >= 64) break;
  }
  return out;
}

/** The append for a comment: context targets plus the parent's tracks. */
export function commentAppend(
  sessionId: string,
  parsed: ParsedComment,
  author: CommentAuthor,
  context: CommentContext | undefined,
  parent: HistoryRow | undefined,
  extra: { sub?: string; payload?: unknown; beatsPerBar?: number } = {},
): HistoryAppend {
  const parentTargets = (parent?.targets ?? []).filter(
    (target) =>
      target.type === "track" ||
      target.type === "instrument" ||
      target.type === "param",
  );
  return {
    sessionId,
    kind: "comment",
    ...(extra.sub !== undefined ? { sub: extra.sub } : {}),
    atRev: context?.rev ?? parent?.atRev ?? 0,
    ...(parent !== undefined ? { parentId: parent.id } : {}),
    actor: {
      kind: author.kind,
      ...(author.actorId !== undefined ? { actorId: author.actorId } : {}),
      ...(author.clientId !== undefined ? { clientId: author.clientId } : {}),
      ...(author.paneKey !== undefined ? { paneKey: author.paneKey } : {}),
      ...(author.pane !== undefined ? { pane: author.pane } : {}),
    },
    summary: parsed.text,
    body: parsed.text,
    ...(context !== undefined ? { context } : {}),
    ...(extra.payload !== undefined ? { payload: extra.payload } : {}),
    targets: mergeTargets(
      contextTargets(context, extra.beatsPerBar),
      parentTargets,
    ),
    tags: parsed.tags,
  };
}

/** Writes a comment row and its mirror line; returns the stored row. */
export function writeComment(db: HistoryDb, append: HistoryAppend): HistoryRow {
  const row = db.append(append);
  try {
    mirrorComment(db.workspace, row);
  } catch {
    // The DB row is the record; the mirror is a second copy.
  }
  return row;
}

/** `/comments [@agent|@mine|#tag|<track>] [n]` as a filter, or an error. */
export function commentsFilter(
  words: readonly string[],
  resolveTrack: (name: string) => string | undefined,
  pane?: string,
): { filter: HistoryFilter } | { error: string } {
  let limit = 20;
  const filter: { -readonly [K in keyof HistoryFilter]: HistoryFilter[K] } = {
    kinds: ["comment"],
  };
  for (const word of words) {
    if (/^\d+$/.test(word)) limit = Math.min(500, Math.max(1, Number(word)));
    else if (word === "@agent") filter.actors = ["agent", "subagent"];
    else if (word === "@human") filter.actors = ["human"];
    else if (word === "@mine") {
      if (pane === undefined) return { error: "this window has no pane yet" };
      filter.pane = pane;
    } else if (word.startsWith("#") && word.length > 1)
      filter.tag = word.slice(1).toLowerCase();
    else {
      const track = resolveTrack(word);
      if (track === undefined)
        return {
          error: `no track ${word} · /comments [@agent|@mine|#tag|<track>] [n]`,
        };
      filter.track = track;
    }
  }
  filter.limit = limit;
  return { filter };
}
