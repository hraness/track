/**
 * glob, grep, move_file and delete_file over the agent workspace (design
 * §6.2). Path policy lives in workspace.ts; this file walks directories with
 * bounded scans and formats compact, paged results (≤ 6 KiB each).
 */
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  DENIED_DIRS,
  detectBinary,
  exists,
  fsMessage,
  globMatch,
  isExternal,
  isNotFound,
  resolveReadPath,
  resolveWritePath,
  TRASH_DIR,
  WorkspaceError,
  type WorkspaceScope,
} from "./workspace.ts";

export const FILE_TOOL_LIMITS = Object.freeze({
  /** Files and directories visited per call. */
  maxScanEntries: 20_000,
  maxGlobResults: 500,
  defaultGlobResults: 100,
  maxGrepResults: 200,
  defaultGrepResults: 50,
  /** Files above this are skipped by grep. */
  maxGrepFileBytes: 1024 * 1024,
  maxPatternChars: 200,
  maxLineChars: 200,
  /** Every result stays under this. */
  maxResultBytes: 6 * 1024,
});

type Walked = { rel: string; abs: string; size: number };

/**
 * Files under `base` (depth first, sorted), skipping denied directories and
 * symlinks. Stops at `maxScanEntries`; `truncated` says so.
 */
async function walkFiles(
  baseAbs: string,
  baseRel: string,
): Promise<{ files: Walked[]; truncated: boolean }> {
  const files: Walked[] = [];
  let visited = 0;
  let truncated = false;
  const visit = async (abs: string, rel: string): Promise<void> => {
    if (truncated) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (++visited > FILE_TOOL_LIMITS.maxScanEntries) {
        truncated = true;
        return;
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (rel === "" && DENIED_DIRS.includes(entry.name.toLowerCase()))
        continue;
      const childAbs = join(abs, entry.name);
      if (entry.isDirectory()) await visit(childAbs, childRel);
      else if (entry.isFile()) {
        let size = 0;
        try {
          size = (await lstat(childAbs)).size;
        } catch {
          continue;
        }
        files.push({ rel: childRel, abs: childAbs, size });
      }
    }
  };
  await visit(baseAbs, baseRel);
  return { files, truncated };
}

/** Lines up to the byte cap, then `… (N more; cursor=K)`. */
function paged(
  header: string,
  lines: readonly string[],
  cursor: number,
  total: number,
  note?: string,
): string {
  const out = [header];
  let bytes = header.length + 1;
  let shown = 0;
  for (const line of lines) {
    if (bytes + line.length + 1 > FILE_TOOL_LIMITS.maxResultBytes - 80) break;
    out.push(line);
    bytes += line.length + 1;
    shown += 1;
  }
  const rest = total - cursor - shown;
  if (rest > 0) out.push(`… (${rest} more; cursor=${cursor + shown})`);
  if (note) out.push(note);
  return out.join("\n");
}

function checkCursor(cursor: number | undefined): number {
  if (cursor === undefined) return 0;
  if (!Number.isInteger(cursor) || cursor < 0)
    throw new WorkspaceError("cursor must be a non-negative integer");
  return cursor;
}

function checkPattern(pattern: unknown): string {
  if (typeof pattern !== "string" || pattern.length === 0)
    throw new WorkspaceError("pattern must be a non-empty string");
  if (pattern.length > FILE_TOOL_LIMITS.maxPatternChars)
    throw new WorkspaceError(
      `pattern is longer than ${FILE_TOOL_LIMITS.maxPatternChars} characters`,
    );
  return pattern;
}

/** Display path: project-relative, or absolute inside a read root. */
function shown(base: { rel: string }, walked: Walked, baseAbs: string) {
  if (!isExternal(base)) return walked.rel;
  return join(base.rel, relative(baseAbs, walked.abs)).split(sep).join("/");
}

/** Paths matching a glob (`**` any depth, `*`, `?`), relative to `path`. */
export async function globFiles(
  scope: WorkspaceScope,
  options: {
    pattern: unknown;
    path?: unknown;
    limit?: number;
    cursor?: number;
  },
): Promise<{ text: string; summary: string }> {
  const pattern = checkPattern(options.pattern);
  const cursor = checkCursor(options.cursor);
  const limit = Math.min(
    options.limit ?? FILE_TOOL_LIMITS.defaultGlobResults,
    FILE_TOOL_LIMITS.maxGlobResults,
  );
  const base = await resolveReadPath(scope, options.path ?? "");
  const external = isExternal(base);
  const { files, truncated } = await walkFiles(
    base.real,
    external ? "" : base.rel,
  );
  const prefix = !external && base.rel ? `${base.rel}/` : "";
  const matches = files.filter((file) => {
    const local = external
      ? relative(base.real, file.abs).split(sep).join("/")
      : file.rel.slice(prefix.length);
    return globMatch(pattern, local);
  });
  const page = matches.slice(cursor, cursor + limit);
  const where = base.rel || ".";
  const text = paged(
    `${matches.length} match${matches.length === 1 ? "" : "es"} for ${pattern} in ${where}`,
    page.map((file) => shown(base, file, base.real)),
    cursor,
    matches.length,
    truncated
      ? `scan stopped at ${FILE_TOOL_LIMITS.maxScanEntries} entries; narrow path`
      : undefined,
  );
  return { text, summary: `glob ${pattern} (${matches.length})` };
}

/** `file:line: text` for a JavaScript regular expression. */
export async function grepFiles(
  scope: WorkspaceScope,
  options: {
    pattern: unknown;
    path?: unknown;
    glob?: unknown;
    limit?: number;
    cursor?: number;
    ignoreCase?: boolean;
  },
): Promise<{ text: string; summary: string }> {
  const source = checkPattern(options.pattern);
  let regex: RegExp;
  try {
    regex = new RegExp(source, options.ignoreCase ? "i" : "");
  } catch (error) {
    throw new WorkspaceError(
      `pattern is not a valid regular expression: ${fsMessage(error)}`,
    );
  }
  const fileGlob =
    options.glob === undefined ? undefined : checkPattern(options.glob);
  const cursor = checkCursor(options.cursor);
  const limit = Math.min(
    options.limit ?? FILE_TOOL_LIMITS.defaultGrepResults,
    FILE_TOOL_LIMITS.maxGrepResults,
  );
  const base = await resolveReadPath(scope, options.path ?? "");
  const external = isExternal(base);
  const info = await lstat(base.real);
  const candidates: Walked[] = info.isFile()
    ? [{ rel: base.rel, abs: base.real, size: info.size }]
    : (await walkFiles(base.real, external ? "" : base.rel)).files;
  const hits: string[] = [];
  let skipped = 0;
  for (const file of candidates) {
    if (hits.length >= cursor + limit + 1) break;
    const name = shown(base, file, base.real);
    if (
      fileGlob &&
      !globMatch(
        fileGlob,
        fileGlob.includes("/") ? name : name.split("/").pop()!,
      )
    )
      continue;
    if (file.size > FILE_TOOL_LIMITS.maxGrepFileBytes) {
      skipped += 1;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await Bun.file(file.abs).arrayBuffer());
    } catch {
      continue;
    }
    if (detectBinary(bytes.subarray(0, 8192))) continue;
    const lines = new TextDecoder("utf-8").decode(bytes).split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!regex.test(line)) continue;
      const text =
        line.length > FILE_TOOL_LIMITS.maxLineChars
          ? `${line.slice(0, FILE_TOOL_LIMITS.maxLineChars - 1)}…`
          : line;
      hits.push(`${name}:${index + 1}: ${text.trim()}`);
      if (hits.length >= cursor + limit + 1) break;
    }
  }
  const more = hits.length > cursor + limit;
  const page = hits.slice(cursor, cursor + limit);
  const out = [`grep /${source}/ in ${base.rel || "."}`];
  let size = out[0]!.length;
  let count = 0;
  for (const hit of page) {
    if (size + hit.length + 1 > FILE_TOOL_LIMITS.maxResultBytes - 120) break;
    out.push(hit);
    size += hit.length + 1;
    count += 1;
  }
  if (count === 0 && page.length === 0) out.push("no matches");
  if (more || count < page.length)
    out.push(`… (more; cursor=${cursor + count})`);
  if (skipped > 0)
    out.push(
      `${skipped} file(s) over ${FILE_TOOL_LIMITS.maxGrepFileBytes / 1024 / 1024} MiB skipped`,
    );
  return {
    text: out.join("\n"),
    summary: `grep ${source.slice(0, 40)} (${count}${more ? "+" : ""})`,
  };
}

async function regularFile(scope: WorkspaceScope, path: unknown) {
  const target = await resolveWritePath(scope, path);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(target.abs);
  } catch (error) {
    if (isNotFound(error))
      throw new WorkspaceError(`${target.rel}: no such file`);
    throw new WorkspaceError(`${target.rel}: ${fsMessage(error)}`);
  }
  if (!info.isFile())
    throw new WorkspaceError(`${target.rel} is not a regular file`);
  return target;
}

/** Rename a file inside the write scope; never overwrites. */
export async function moveFile(
  scope: WorkspaceScope,
  from: unknown,
  to: unknown,
): Promise<{ from: string; to: string; text: string; summary: string }> {
  const source = await regularFile(scope, from);
  const target = await resolveWritePath(scope, to);
  if (await exists(target.abs))
    throw new WorkspaceError(
      `${target.rel} already exists; move_file never overwrites`,
    );
  try {
    await mkdir(dirname(target.abs), { recursive: true });
    await rename(source.abs, target.abs);
  } catch (error) {
    throw new WorkspaceError(`${source.rel}: ${fsMessage(error)}`);
  }
  return {
    from: source.rel,
    to: target.rel,
    text: `moved ${source.rel} → ${target.rel}`,
    summary: `moved ${source.rel}`,
  };
}

/**
 * Delete a file inside the write scope. A copy goes to
 * `.dawg/trash/<stamp>/<path>` first; that copy is the recovery.
 */
export async function deleteFile(
  scope: WorkspaceScope,
  path: unknown,
  now: Date = new Date(),
): Promise<{ rel: string; trash: string; text: string; summary: string }> {
  const target = await regularFile(scope, path);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const trashRel = `${TRASH_DIR}/${stamp}/${target.rel}`;
  const trashAbs = join(scope.root, trashRel);
  try {
    await mkdir(dirname(trashAbs), { recursive: true });
    await copyFile(target.abs, trashAbs);
    await unlink(target.abs);
  } catch (error) {
    throw new WorkspaceError(`${target.rel}: ${fsMessage(error)}`);
  }
  return {
    rel: target.rel,
    trash: trashRel,
    text: `deleted ${target.rel} (copy in ${trashRel})`,
    summary: `deleted ${target.rel}`,
  };
}
