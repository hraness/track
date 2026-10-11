/**
 * `/comment` grammar (design §3.1):
 *
 *   /comment <text>                 about the moment (context only)
 *   /comment @last <text>           about the newest score event (any actor)
 *   /comment @agent <text>          about the agent's newest edit
 *   /comment @mine <text>           about this pane's newest edit
 *   /comment @rev <N> <text>        about the event that produced revision N
 *   /comment @<eventId> <text>      about a specific event (id prefix >= 6)
 *   /c <text>                       alias
 *
 * `#tag` tokens anywhere become tags; the text keeps them.
 */
export const MAX_COMMENT_CHARS = 2_000;

export type CommentRef =
  | { type: "none" }
  | { type: "last" }
  | { type: "agent" }
  | { type: "mine" }
  | { type: "rev"; rev: number }
  | { type: "event"; idPrefix: string };

export type ParsedComment = Readonly<{
  ref: CommentRef;
  text: string;
  tags: readonly string[];
}>;

export const COMMENT_USAGE = "usage · /comment <text>";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const TAG = /(?:^|\s)#([a-z0-9][a-z0-9_-]{0,31})\b/gi;

/** Tags in `text`, lowercased and deduplicated, at most 8. */
export function commentTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(TAG)) {
    const tag = match[1]!.toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

/** Parses `/comment …`, `/c …`, or just the words after either. */
export function parseComment(input: string): ParsedComment | { error: string } {
  let rest = input
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\/(?:comment|c)(?:\s+|$)/i, "");
  let ref: CommentRef = { type: "none" };
  const head = /^@(\S+)\s*/.exec(rest);
  if (head) {
    const word = head[1]!;
    rest = rest.slice(head[0].length);
    const lower = word.toLowerCase();
    if (lower === "last") ref = { type: "last" };
    else if (lower === "agent") ref = { type: "agent" };
    else if (lower === "mine") ref = { type: "mine" };
    else if (lower === "rev" || /^rev:?\d+$/.test(lower)) {
      let digits = lower.replace(/^rev:?/, "");
      if (digits.length === 0) {
        const next = /^(\d+)\s*/.exec(rest);
        if (!next) return { error: "usage · /comment @rev <N> <text>" };
        digits = next[1]!;
        rest = rest.slice(next[0].length);
      }
      const rev = Number(digits);
      if (!Number.isSafeInteger(rev) || rev < 1)
        return { error: "usage · /comment @rev <N> <text>" };
      ref = { type: "rev", rev };
    } else if (/^[A-Za-z0-9_-]{6,}$/.test(word))
      ref = { type: "event", idPrefix: word };
    else
      return {
        error: `unknown reference @${word} · try @last, @agent, @mine, @rev N or an event id`,
      };
  }
  const text = rest.trim();
  if (text.length === 0) return { error: COMMENT_USAGE };
  if (text.length > MAX_COMMENT_CHARS)
    return { error: `comment is longer than ${MAX_COMMENT_CHARS} characters` };
  return { ref, text, tags: commentTags(text) };
}

/** A typed history command: what `/comment`, `/comments` and `/history` run. */
export type HistoryCommand =
  | { type: "comment"; comment: ParsedComment }
  | { type: "comment"; error: string }
  | { type: "comments"; words: readonly string[] }
  | { type: "history"; words: readonly string[] }
  | { type: "history-jump"; seq: number };

/**
 * `/comment …`, `/c …`, `/comments [words]`, `/history [words]`; undefined
 * for any other line. Slash only: bare `comment` reaches the agent unless
 * the grammar's slash reading recovers it. A comment with no text still
 * parses (it answers its usage line locally instead of going to the agent).
 */
export function parseHistoryCommand(text: string): HistoryCommand | undefined {
  const line = text.trim();
  const match = /^\/(comment|c|comments|history)(?:\s+([\s\S]*))?$/i.exec(line);
  if (!match) return undefined;
  const verb = match[1]!.toLowerCase();
  const rest = (match[2] ?? "").trim();
  if (verb === "comment" || verb === "c") {
    const comment = parseComment(rest);
    return "error" in comment
      ? { type: "comment", error: comment.error }
      : { type: "comment", comment };
  }
  const words = rest.length > 0 ? rest.split(/\s+/) : [];
  if (verb === "history" && words[0]?.toLowerCase() === "jump") {
    const seq = Number(words[1]?.replace(/^#/, ""));
    if (words.length === 2 && Number.isSafeInteger(seq) && seq > 0)
      return { type: "history-jump", seq };
  }
  return verb === "comments"
    ? { type: "comments", words }
    : { type: "history", words };
}
