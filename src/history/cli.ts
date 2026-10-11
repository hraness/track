/**
 * `dawg history` (design §4.1): the session history from the shell, for a
 * coding agent in another terminal as much as for a person.
 *
 *   dawg history [filters] [--json] [--limit N] [--before SEQ] [--asc] [--follow] [--full]
 *   dawg history show <id|seq|rev:N>
 *   dawg history comment [@ref] <text>
 *   dawg history import
 *   dawg history stats
 *
 * Never creates `.dawg/`. `--follow` polls a read-only connection and never
 * talks to dawgd, so it is not a pane.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseComment } from "../commands/comment.ts";
import {
  loadSession,
  readCurrentSessionId,
  sessionPaths,
  stateDir,
  type SessionRecord,
} from "../session/store.ts";
import { listSessions } from "../session/list.ts";
import { commentAppend, resolveCommentRef, writeComment } from "./comments.ts";
import { HistoryDb, historyPath } from "./db.ts";
import { formatDetail, formatRow } from "./format.ts";
import { filterFromFlags, type Composition } from "./filter.ts";
import { reconcileHistory } from "./record.ts";
import type { HistoryRow } from "./types.ts";

export type Output = { write(text: string): unknown };

export const HISTORY_HELP = `dawg history — this project's session history (see DAWG.md "Session history")

  dawg history [filters] [--json] [--limit N] [--before SEQ] [--asc] [--follow] [--full]
  dawg history show <id|seq|rev:N>       one event in full (ops, context, payload)
  dawg history comment [@ref] <text>     leave a comment (actor external; DAWG_ACTOR names you)
  dawg history import                    import .dawg/sessions into .dawg/history.db (idempotent)
  dawg history stats                     rows per kind, bytes, oldest and newest

filters:
  --session ID|*   --kind edit,comment,...   --actor human,agent,subagent,external,system
  --track NAME|ID  --instrument KIND  --effect NAME  --node ID  --param PATH
  --bars A-B       --pane LETTER      --tag TAG      --grep 'words'
  --since 10m|2h|1d|ISO|seq:N         --rev N|A-B

Newest first, one line per row; --json prints JSON Lines of rows (ops only with --full).
@ref: @last, @agent, @rev N or an event id prefix.`;

const VALUE = new Set([
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
]);
const BOOL = new Set(["json", "asc", "follow", "full", "help"]);

type Parsed = {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
};

function parseArgs(argv: readonly string[]): Parsed | { error: string } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-h") {
      flags.add("help");
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string?];
    if (BOOL.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE.has(name))
      return { error: `unknown option · --${name.slice(0, 40)}` };
    const value = inline ?? argv[index + 1];
    if (value === undefined || value.length === 0)
      return { error: `--${name} needs a value` };
    if (inline === undefined) index += 1;
    values.set(name, value);
  }
  return { positional, values, flags };
}

function jsonRow(row: HistoryRow, full: boolean): string {
  if (full) return JSON.stringify(row);
  const { ops: _ops, ...rest } = row;
  return JSON.stringify(rest);
}

async function currentRecord(
  workspace: string,
  sessionId: string | undefined,
): Promise<SessionRecord<Composition> | undefined> {
  const id =
    sessionId ?? (await readCurrentSessionId(workspace).catch(() => undefined));
  if (id === undefined || id === "*") return undefined;
  try {
    return await loadSession<Composition>(sessionPaths(workspace, id));
  } catch {
    return undefined;
  }
}

/** Imports every session record; returns rows imported. */
async function importAll(db: HistoryDb, workspace: string): Promise<number> {
  let imported = 0;
  for (const summary of await listSessions(workspace)) {
    if (summary.error !== undefined) continue;
    try {
      const record = await loadSession<unknown>(
        sessionPaths(workspace, summary.sessionId),
      );
      imported += reconcileHistory(db, record).imported;
    } catch {
      // A damaged record stays out of history; `dawg sessions` reports it.
    }
  }
  return imported;
}

function hasSessions(workspace: string): boolean {
  return existsSync(join(stateDir(workspace), "sessions"));
}

export async function runHistoryCommand(
  argv: readonly string[],
  workspace: string,
  out: Output,
  err: Output,
  signal?: AbortSignal,
): Promise<number> {
  const args = argv[0] === "history" ? argv.slice(1) : argv;
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    err.write(`dawg history: ${parsed.error} · dawg history --help\n`);
    return 2;
  }
  if (parsed.flags.has("help")) {
    out.write(`${HISTORY_HELP}\n`);
    return 0;
  }
  const verb = parsed.positional[0];
  if (!hasSessions(workspace)) {
    err.write(
      "dawg history: no dawg sessions here (.dawg/sessions) · run dawg in this folder first\n",
    );
    return 2;
  }
  const dbExists = existsSync(historyPath(workspace));
  const follow = parsed.flags.has("follow");

  if (verb === "show") {
    const key = parsed.positional[1];
    if (key === undefined) {
      err.write("dawg history: usage · dawg history show <id|seq|rev:N>\n");
      return 2;
    }
    const db = HistoryDb.open(workspace, { busyMs: 2000 });
    try {
      await importAll(db, workspace);
      const record = await currentRecord(
        workspace,
        parsed.values.get("session"),
      );
      const rev = /^rev:(\d+)$/.exec(key);
      const row = rev
        ? record && db.byRev(record.sessionId, Number(rev[1]))
        : /^\d+$/.test(key)
          ? db.get(Number(key))
          : db.get(key);
      if (!row) {
        err.write(`dawg history: no event ${key.slice(0, 40)}\n`);
        return 1;
      }
      out.write(
        parsed.flags.has("json")
          ? `${JSON.stringify(row)}\n`
          : `${formatDetail(row, { trackName: names(record) })}\n`,
      );
      return 0;
    } finally {
      db.close();
    }
  }

  if (verb === "import" || verb === "stats" || verb === "comment") {
    const db = HistoryDb.open(workspace, { busyMs: 2000 });
    try {
      const imported = await importAll(db, workspace);
      if (verb === "import") {
        out.write(
          `imported ${imported} event${imported === 1 ? "" : "s"} into .dawg/history.db\n`,
        );
        return 0;
      }
      if (verb === "stats") {
        const stats = db.stats();
        if (parsed.flags.has("json")) out.write(`${JSON.stringify(stats)}\n`);
        else
          out.write(
            [
              `${stats.sessions} session${stats.sessions === 1 ? "" : "s"} · ${(stats.bytes / 1024).toFixed(0)} KiB · .dawg/history.db`,
              ...Object.entries(stats.kinds)
                .sort((a, b) => b[1] - a[1])
                .map(([kind, n]) => `  ${kind.padEnd(10)} ${n}`),
              ...(stats.oldest ? [`oldest ${stats.oldest}`] : []),
              ...(stats.newest ? [`newest ${stats.newest}`] : []),
            ].join("\n") + "\n",
          );
        return 0;
      }
      return await cliComment(db, workspace, parsed, out, err);
    } finally {
      db.close();
    }
  }

  if (verb !== undefined) {
    err.write(
      `dawg history: unknown verb ${verb.slice(0, 40)} · show, comment, import, stats\n`,
    );
    return 2;
  }

  const record = await currentRecord(workspace, parsed.values.get("session"));
  const built = filterFromFlags(
    parsed.values,
    record?.sessionId,
    record?.composition,
  );
  if ("error" in built) {
    err.write(`dawg history: ${built.error}\n`);
    return 2;
  }
  const json = parsed.flags.has("json");
  const full = parsed.flags.has("full");
  const asc = parsed.flags.has("asc");
  const trackName = names(record);
  const print = (row: HistoryRow): void => {
    out.write(`${json ? jsonRow(row, full) : formatRow(row, { trackName })}\n`);
  };

  if (!dbExists) {
    if (follow) {
      // Wait for a pane to create it; never create it from a watcher.
      while (!existsSync(historyPath(workspace))) {
        if (signal?.aborted) return 0;
        await Bun.sleep(250);
      }
    } else {
      const db = HistoryDb.open(workspace, { busyMs: 2000 });
      await importAll(db, workspace);
      db.close();
    }
  }
  const db = HistoryDb.open(workspace, { readonly: true, busyMs: 2000 });
  try {
    const page = db.query({ ...built.filter, order: asc ? "asc" : "desc" });
    const rows = asc ? page.rows : [...page.rows];
    for (const row of rows) print(row);
    if (!json && page.next !== undefined && !follow)
      out.write(`-- next: dawg history --before ${page.next}\n`);
    if (!follow) return 0;
    let cursor = Math.max(db.lastSeq(), built.sinceSeq ?? 0);
    while (!signal?.aborted) {
      await Bun.sleep(250);
      if (signal?.aborted) break;
      const fresh = db.query({
        ...built.filter,
        beforeSeq: undefined,
        sinceSeq: cursor,
        order: "asc",
        limit: 500,
      });
      for (const row of fresh.rows) {
        print(row);
        cursor = Math.max(cursor, row.seq);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

function names(
  record: SessionRecord<Composition> | undefined,
): (id: string) => string | undefined {
  const tracks = record?.composition?.tracks ?? [];
  return (id) => {
    const track = tracks.find((each) => each.id === id);
    return track?.name ?? track?.id;
  };
}

async function cliComment(
  db: HistoryDb,
  workspace: string,
  parsed: Parsed,
  out: Output,
  err: Output,
): Promise<number> {
  const text = parsed.positional.slice(1).join(" ");
  const comment = parseComment(text);
  if ("error" in comment) {
    err.write(
      `dawg history: ${comment.error.replace("/comment", "dawg history comment")}\n`,
    );
    return 2;
  }
  const record = await currentRecord(workspace, parsed.values.get("session"));
  if (!record) {
    err.write(
      "dawg history: no current session to comment on · --session ID\n",
    );
    return 2;
  }
  const actorId = process.env.DAWG_ACTOR?.trim() || "external";
  const author = { kind: "external" as const, actorId: actorId.slice(0, 64) };
  if (comment.ref.type === "mine") {
    err.write(
      "dawg history: @mine needs a pane · use @last, @agent, @rev N or an id\n",
    );
    return 2;
  }
  const resolved = resolveCommentRef(db, record.sessionId, comment.ref, author);
  if ("error" in resolved) {
    err.write(`dawg history: ${resolved.error}\n`);
    return 1;
  }
  const row = writeComment(
    db,
    commentAppend(
      record.sessionId,
      comment,
      author,
      { rev: record.revision },
      resolved.row,
    ),
  );
  out.write(
    parsed.flags.has("json")
      ? `${JSON.stringify(row)}\n`
      : `commented #${row.seq}${resolved.row?.rev != null ? ` · about rev ${resolved.row.rev}` : ""}\n`,
  );
  return 0;
}
