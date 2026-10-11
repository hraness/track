/**
 * Workspace file access for the agent. The project root is the directory
 * `dawg` runs in. Every path the model supplies is resolved lexically, then
 * through `realpath`, and must stay under the root; `.dawg/` is dawg's own
 * state and is never reachable. Reads cover the whole project; writes are
 * limited to `song.ts` and the focused track's `tracks/<slug>/` directory.
 * Every operation is bounded in entries and bytes.
 */
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile as fsReadFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const WORKSPACE_LIMITS = Object.freeze({
  maxPathChars: 512,
  maxPathSegments: 32,
  maxListEntries: 500,
  maxReadBytes: 256 * 1024,
  /** Bytes scanned to honour a line offset; files beyond this are reported as partial. */
  maxScanBytes: 4 * 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxReadLines: 100_000,
  maxOutlineLines: 30,
  maxOutlineLineChars: 120,
  maxNotesBytes: 1024,
});

/** The directory dawg owns; invisible to the file tools. */
export const RUNTIME_DIR = ".dawg";
const OUTLINE_HIDDEN = new Set([RUNTIME_DIR, "node_modules", ".git"]);

export type WorkspaceScope = Readonly<{
  /** Absolute project root (the session workspace). */
  root: string;
  /** Slug of the focused track; its `tracks/<slug>/` directory is writable. */
  trackSlug: string;
  /**
   * When set (a dispatch subagent), the only writable paths: project-relative
   * globs (`**` any depth, `*` within a segment) instead of the defaults.
   */
  writeGlobs?: readonly string[];
}>;

/** Glob match for write scopes: `**` any depth, `*` and `?` within a segment. */
export function globMatch(glob: string, path: string): boolean {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") {
        pattern += "(?:.*/)?";
        index++;
      } else pattern += ".*";
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`).test(path);
}

/** A path or content the tools refused; nothing was touched. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export type ResolvedPath = Readonly<{
  /** Absolute path under the (unresolved) root. */
  abs: string;
  /** Project-relative path with `/` separators; `""` is the root. */
  rel: string;
}>;

/** Project-relative roots this scope may write under. */
export function writeRoots(scope: WorkspaceScope): readonly string[] {
  if (scope.writeGlobs) return scope.writeGlobs;
  return ["song.ts", `tracks/${scope.trackSlug}/`];
}

export function inWriteScope(scope: WorkspaceScope, rel: string): boolean {
  if (scope.writeGlobs)
    return scope.writeGlobs.some((glob) => globMatch(glob, rel));
  return rel === "song.ts" || rel.startsWith(`tracks/${scope.trackSlug}/`);
}

function outsideWriteScope(scope: WorkspaceScope, rel: string): WorkspaceError {
  return new WorkspaceError(
    `${rel || "."} is outside this window's writable scope; it may write ${writeRoots(scope).join(" and ") || "nothing"} (reads work anywhere except ${RUNTIME_DIR}/)`,
  );
}

function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Lexical resolution: a string, bounded, under the root and not in `.dawg/`. */
export function lexicalPath(
  scope: WorkspaceScope,
  input: unknown,
  label = "path",
): ResolvedPath {
  if (typeof input !== "string")
    throw new WorkspaceError(`${label} must be a string`);
  if (input.length > WORKSPACE_LIMITS.maxPathChars)
    throw new WorkspaceError(
      `${label} is longer than ${WORKSPACE_LIMITS.maxPathChars} characters`,
    );
  if (input.includes("\0"))
    throw new WorkspaceError(`${label} contains a NUL byte`);
  const abs = resolve(scope.root, input);
  const rel = relative(scope.root, abs);
  if (escapes(rel))
    throw new WorkspaceError(
      `${label} ${input.slice(0, 80)} leaves the project directory`,
    );
  const segments = rel === "" ? [] : rel.split(sep);
  if (segments.length > WORKSPACE_LIMITS.maxPathSegments)
    throw new WorkspaceError(
      `${label} has more than ${WORKSPACE_LIMITS.maxPathSegments} segments`,
    );
  if (segments[0] === RUNTIME_DIR)
    throw new WorkspaceError(
      `${segments.join("/")} is inside ${RUNTIME_DIR}/, which dawg owns; tools cannot read or write there`,
    );
  return { abs, rel: segments.join("/") };
}

async function realRoot(scope: WorkspaceScope): Promise<string> {
  try {
    return await realpath(scope.root);
  } catch {
    throw new WorkspaceError("project directory is unavailable");
  }
}

/** Relative path of `real` under the real root, or a diagnostic for `rel`. */
function realRelative(root: string, real: string, rel: string): string {
  const realRel = relative(root, real);
  if (escapes(realRel))
    throw new WorkspaceError(
      `${rel || "."} resolves through a symlink that leaves the project`,
    );
  const segments = realRel === "" ? [] : realRel.split(sep);
  if (segments[0] === RUNTIME_DIR)
    throw new WorkspaceError(
      `${rel || "."} resolves into ${RUNTIME_DIR}/, which dawg owns`,
    );
  return segments.join("/");
}

/** Resolve a path for reading: it must exist and stay under the root after `realpath`. */
export async function resolveReadPath(
  scope: WorkspaceScope,
  input: unknown,
  label = "path",
): Promise<ResolvedPath & { real: string }> {
  const lexical = lexicalPath(scope, input, label);
  const root = await realRoot(scope);
  let real: string;
  try {
    real = await realpath(lexical.abs);
  } catch (error) {
    if (isNotFound(error))
      throw new WorkspaceError(`${lexical.rel || "."}: no such file`);
    throw new WorkspaceError(`${lexical.rel || "."}: ${fsMessage(error)}`);
  }
  realRelative(root, real, lexical.rel);
  return { ...lexical, real };
}

/**
 * Resolve a path for writing: inside the write scope lexically and after
 * resolving its nearest existing ancestor, never through a symlink, never a
 * directory. The file itself may not exist yet.
 */
export async function resolveWritePath(
  scope: WorkspaceScope,
  input: unknown,
): Promise<ResolvedPath> {
  const lexical = lexicalPath(scope, input);
  if (!inWriteScope(scope, lexical.rel))
    throw outsideWriteScope(scope, lexical.rel);
  const root = await realRoot(scope);
  let ancestor = lexical.abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (tail.length === 0) {
        if (info.isSymbolicLink())
          throw new WorkspaceError(
            `${lexical.rel} is a symlink; tools do not write through links`,
          );
        if (info.isDirectory())
          throw new WorkspaceError(`${lexical.rel} is a directory`);
      }
      break;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (!isNotFound(error))
        throw new WorkspaceError(`${lexical.rel}: ${fsMessage(error)}`);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new WorkspaceError("project directory is unavailable");
    tail.unshift(basename(ancestor));
    ancestor = parent;
  }
  const realAncestor = await realpath(ancestor).catch(() => {
    throw new WorkspaceError(`${lexical.rel}: parent is unavailable`);
  });
  const realRel = realRelative(root, join(realAncestor, ...tail), lexical.rel);
  if (!inWriteScope(scope, realRel)) throw outsideWriteScope(scope, realRel);
  return lexical;
}

export type ListedEntry = Readonly<{
  name: string;
  kind: "dir" | "file" | "link" | "other";
  size: number;
  mtime: string;
}>;

/** Directory listing: directories first, bounded to `maxListEntries`. */
export async function listFiles(
  scope: WorkspaceScope,
  input: unknown = "",
): Promise<{ text: string; summary: string }> {
  const target = await resolveReadPath(scope, input ?? "");
  let names: import("node:fs").Dirent[];
  try {
    names = await readdir(target.real, { withFileTypes: true });
  } catch (error) {
    if (isNotDirectory(error))
      throw new WorkspaceError(
        `${target.rel} is a file, not a directory; use read_file`,
      );
    throw new WorkspaceError(`${target.rel || "."}: ${fsMessage(error)}`);
  }
  const visible = names
    .filter((entry) => !(target.rel === "" && entry.name === RUNTIME_DIR))
    .sort(
      (left, right) =>
        Number(right.isDirectory()) - Number(left.isDirectory()) ||
        left.name.localeCompare(right.name),
    );
  const shown = visible.slice(0, WORKSPACE_LIMITS.maxListEntries);
  const entries: ListedEntry[] = [];
  for (const entry of shown) {
    try {
      const info = await lstat(join(target.real, entry.name));
      entries.push({
        name: entry.name,
        kind: info.isDirectory()
          ? "dir"
          : info.isSymbolicLink()
            ? "link"
            : info.isFile()
              ? "file"
              : "other",
        size: info.size,
        mtime: info.mtime.toISOString().slice(0, 19) + "Z",
      });
    } catch {
      entries.push({ name: entry.name, kind: "other", size: 0, mtime: "" });
    }
  }
  const lines = entries.map((entry) =>
    entry.kind === "dir"
      ? `${entry.name}/`
      : `${entry.name}${entry.kind === "link" ? "@" : ""}  ${formatBytes(entry.size)}  ${entry.mtime}`,
  );
  const omitted = visible.length - shown.length;
  if (omitted > 0) lines.push(`… ${omitted} more entries not shown`);
  const where = target.rel || ".";
  return {
    text: `${where}/ · ${visible.length} entr${visible.length === 1 ? "y" : "ies"}${lines.length ? "\n" : ""}${lines.join("\n")}`,
    summary: `listed ${where} (${visible.length})`,
  };
}

const MAGIC: ReadonlyArray<readonly [string, (head: Uint8Array) => boolean]> = [
  ["wav", (h) => ascii(h, 0, "RIFF") && ascii(h, 8, "WAVE")],
  ["aiff", (h) => ascii(h, 0, "FORM") && ascii(h, 8, "AIFF")],
  ["flac", (h) => ascii(h, 0, "fLaC")],
  ["ogg", (h) => ascii(h, 0, "OggS")],
  [
    "mp3",
    (h) => ascii(h, 0, "ID3") || (h[0] === 0xff && (h[1]! & 0xe0) === 0xe0),
  ],
  ["mp4", (h) => ascii(h, 4, "ftyp")],
  ["midi", (h) => ascii(h, 0, "MThd")],
  ["png", (h) => h[0] === 0x89 && ascii(h, 1, "PNG")],
  ["jpeg", (h) => h[0] === 0xff && h[1] === 0xd8],
  ["gif", (h) => ascii(h, 0, "GIF8")],
  ["pdf", (h) => ascii(h, 0, "%PDF")],
  ["zip", (h) => ascii(h, 0, "PK\u0003\u0004")],
  ["gzip", (h) => h[0] === 0x1f && h[1] === 0x8b],
];

function ascii(head: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1)
    if (head[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** `undefined` for text; otherwise a short type name. */
export function detectBinary(head: Uint8Array): string | undefined {
  for (const [type, test] of MAGIC)
    if (head.length >= 12 && test(head)) return type;
  const window = head.subarray(0, 8192);
  return window.includes(0) ? "binary" : undefined;
}

export type ReadRange = Readonly<{ offset?: number; limit?: number }>;

/** Read a text file by lines, bounded to `maxReadBytes` of output. */
export async function readFile(
  scope: WorkspaceScope,
  input: unknown,
  range: ReadRange = {},
): Promise<{ text: string; summary: string }> {
  const offset = range.offset ?? 1;
  const limit = range.limit ?? WORKSPACE_LIMITS.maxReadLines;
  const target = await resolveReadPath(scope, input);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target.real);
  } catch (error) {
    throw new WorkspaceError(`${target.rel}: ${fsMessage(error)}`);
  }
  if (info.isDirectory())
    throw new WorkspaceError(`${target.rel} is a directory; use list_files`);
  if (!info.isFile())
    throw new WorkspaceError(`${target.rel} is not a regular file`);
  const scan = Math.min(info.size, WORKSPACE_LIMITS.maxScanBytes);
  const buffer = new Uint8Array(scan);
  const handle = await open(target.real, "r");
  let read = 0;
  try {
    while (read < scan) {
      const { bytesRead } = await handle.read(buffer, read, scan - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const head = buffer.subarray(0, read);
  const type = detectBinary(head);
  if (type)
    return {
      text: `${target.rel}: ${type} file, ${formatBytes(info.size)} (${info.size} bytes); not readable as text`,
      summary: `read ${target.rel} (${type})`,
    };
  const decoded = new TextDecoder("utf-8").decode(head);
  const lines = decoded.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "" && read === info.size)
    lines.pop();
  const partialScan = read < info.size;
  const total = partialScan ? lines.length - 1 : lines.length;
  if (offset > total && total > 0)
    throw new WorkspaceError(
      `${target.rel} has ${total}${partialScan ? "+" : ""} lines; offset ${offset} is past the end`,
    );
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const encoder = new TextEncoder();
  const out: string[] = [];
  let bytes = 0;
  for (const line of selected) {
    const size = encoder.encode(line).byteLength + 1;
    if (bytes + size > WORKSPACE_LIMITS.maxReadBytes) break;
    bytes += size;
    out.push(line);
  }
  const first = total === 0 ? 0 : offset;
  const last = total === 0 ? 0 : offset + out.length - 1;
  const notes: string[] = [];
  if (out.length < selected.length)
    notes.push(
      `truncated at ${formatBytes(WORKSPACE_LIMITS.maxReadBytes)}; continue with offset ${last + 1}`,
    );
  else if (last < total) notes.push(`continue with offset ${last + 1}`);
  if (partialScan)
    notes.push(
      `only the first ${formatBytes(WORKSPACE_LIMITS.maxScanBytes)} were scanned`,
    );
  const header = `${target.rel} · lines ${first}-${last} of ${total}${partialScan ? "+" : ""}${notes.length ? ` · ${notes.join("; ")}` : ""}`;
  return {
    text: out.length ? `${header}\n${out.join("\n")}` : header,
    summary: `read ${target.rel} (${out.length} line${out.length === 1 ? "" : "s"})`,
  };
}

export type WriteResult = Readonly<{
  rel: string;
  bytes: number;
  created: boolean;
  text: string;
  summary: string;
}>;

/** Replace or create a file atomically (temp file + rename in the same directory). */
export async function writeFile(
  scope: WorkspaceScope,
  input: unknown,
  content: unknown,
): Promise<WriteResult> {
  if (typeof content !== "string")
    throw new WorkspaceError("content must be a string");
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > WORKSPACE_LIMITS.maxWriteBytes)
    throw new WorkspaceError(
      `content is ${formatBytes(bytes.byteLength)}; the write limit is ${formatBytes(WORKSPACE_LIMITS.maxWriteBytes)}`,
    );
  const target = await resolveWritePath(scope, input);
  const created = !(await exists(target.abs));
  await mkdir(dirname(target.abs), { recursive: true }).catch((error) => {
    throw new WorkspaceError(`${target.rel}: ${fsMessage(error)}`);
  });
  await atomicWrite(target, bytes);
  return {
    rel: target.rel,
    bytes: bytes.byteLength,
    created,
    text: `wrote ${target.rel} (${bytes.byteLength} bytes${created ? ", new file" : ""})`,
    summary: `wrote ${target.rel} (${formatBytes(bytes.byteLength)})`,
  };
}

/** Replace exactly one occurrence of `oldText`; otherwise report the count. */
export async function editFile(
  scope: WorkspaceScope,
  input: unknown,
  oldText: unknown,
  newText: unknown,
): Promise<WriteResult> {
  if (typeof oldText !== "string" || oldText.length === 0)
    throw new WorkspaceError("old must be a non-empty string");
  if (typeof newText !== "string")
    throw new WorkspaceError("new must be a string");
  if (oldText === newText)
    throw new WorkspaceError("old and new are identical; nothing to change");
  if (
    oldText.length > WORKSPACE_LIMITS.maxWriteBytes ||
    newText.length > WORKSPACE_LIMITS.maxWriteBytes
  )
    throw new WorkspaceError(
      `old and new must each be under ${formatBytes(WORKSPACE_LIMITS.maxWriteBytes)}`,
    );
  const target = await resolveWritePath(scope, input);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target.abs);
  } catch (error) {
    if (isNotFound(error))
      throw new WorkspaceError(
        `${target.rel}: no such file; use write_file to create it`,
      );
    throw new WorkspaceError(`${target.rel}: ${fsMessage(error)}`);
  }
  if (info.size > WORKSPACE_LIMITS.maxWriteBytes)
    throw new WorkspaceError(
      `${target.rel} is ${formatBytes(info.size)}, above the ${formatBytes(WORKSPACE_LIMITS.maxWriteBytes)} edit limit`,
    );
  const raw = await fsReadFile(target.abs);
  if (detectBinary(raw))
    throw new WorkspaceError(`${target.rel} is not a text file`);
  const current = raw.toString("utf8");
  let count = 0;
  let at = current.indexOf(oldText);
  const first = at;
  while (at !== -1 && count < 1000) {
    count += 1;
    at = current.indexOf(oldText, at + oldText.length);
  }
  if (count === 0)
    throw new WorkspaceError(
      `old text was not found in ${target.rel}; read the file and copy the exact text`,
    );
  if (count > 1)
    throw new WorkspaceError(
      `old text occurs ${count} times in ${target.rel}; include more surrounding lines so it matches once`,
    );
  const next =
    current.slice(0, first) + newText + current.slice(first + oldText.length);
  const bytes = new TextEncoder().encode(next);
  if (bytes.byteLength > WORKSPACE_LIMITS.maxWriteBytes)
    throw new WorkspaceError(
      `the edited file would exceed ${formatBytes(WORKSPACE_LIMITS.maxWriteBytes)}`,
    );
  await atomicWrite(target, bytes);
  const oldLines = oldText.split("\n").length;
  const newLines = newText.split("\n").length;
  return {
    rel: target.rel,
    bytes: bytes.byteLength,
    created: false,
    text: `edited ${target.rel}: replaced 1 occurrence (${oldLines} → ${newLines} line${newLines === 1 ? "" : "s"})`,
    summary: `edited ${target.rel}`,
  };
}

async function atomicWrite(target: ResolvedPath, bytes: Uint8Array) {
  const nonce = Math.random().toString(36).slice(2, 8);
  const temp = join(
    dirname(target.abs),
    `.${basename(target.abs)}.${process.pid}.${nonce}.tmp`,
  );
  try {
    await fsWriteFile(temp, bytes, { flag: "wx" });
    await rename(temp, target.abs);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new WorkspaceError(`${target.rel}: ${fsMessage(error)}`);
  }
}

export type ProjectOutline = Readonly<{
  /** At most `maxOutlineLines` lines naming top-level entries and track directories. */
  tree: readonly string[];
  /** First `maxNotesBytes` of the focused track's `notes.md`, when present. */
  notes?: string;
}>;

/**
 * A bounded view of the project for the brief. Never throws: an unreadable
 * project yields an empty tree.
 */
export async function projectOutline(
  scope: WorkspaceScope,
): Promise<ProjectOutline> {
  const lines: string[] = [];
  const push = (line: string) =>
    lines.push(
      line.length > WORKSPACE_LIMITS.maxOutlineLineChars
        ? `${line.slice(0, WORKSPACE_LIMITS.maxOutlineLineChars - 1)}…`
        : line,
    );
  const top = await safeReaddir(scope.root);
  const topVisible = top
    .filter((entry) => !OUTLINE_HIDDEN.has(entry.name))
    .sort(
      (left, right) =>
        Number(right.isDirectory()) - Number(left.isDirectory()) ||
        left.name.localeCompare(right.name),
    );
  for (const entry of topVisible.slice(0, WORKSPACE_LIMITS.maxOutlineLines)) {
    if (entry.name === "tracks" && entry.isDirectory()) continue;
    if (entry.isDirectory()) push(`${entry.name}/`);
    else
      push(
        `${entry.name} ${formatBytes(await sizeOf(join(scope.root, entry.name)))}`,
      );
  }
  const tracksDir = join(scope.root, "tracks");
  const trackDirs = (await safeReaddir(tracksDir))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) =>
      left === scope.trackSlug
        ? -1
        : right === scope.trackSlug
          ? 1
          : left.localeCompare(right),
    );
  for (const slug of trackDirs.slice(0, WORKSPACE_LIMITS.maxOutlineLines)) {
    const dir = join(tracksDir, slug);
    const files = (await safeReaddir(dir)).filter((entry) => entry.isFile());
    let bytes = 0;
    for (const file of files) bytes += await sizeOf(join(dir, file.name));
    const samples = (await safeReaddir(join(dir, "samples"))).filter((e) =>
      e.isFile(),
    );
    const downloads = (await safeReaddir(join(dir, "downloads"))).filter((e) =>
      e.isFile(),
    );
    const focus = slug === scope.trackSlug ? " (focused)" : "";
    const parts = [
      `${files.length} file${files.length === 1 ? "" : "s"} ${formatBytes(bytes)}`,
      ...(samples.length ? [`${samples.length} samples`] : []),
    ];
    push(`tracks/${slug}/${focus} ${parts.join(", ")}`);
    if (downloads.length > 0) {
      const names = downloads
        .map((e) => e.name)
        .sort()
        .slice(0, 8);
      const more = downloads.length - names.length;
      push(
        `tracks/${slug}/downloads/: ${names.join(", ")}${more > 0 ? ` +${more}` : ""}`,
      );
    }
  }
  const tree =
    lines.length > WORKSPACE_LIMITS.maxOutlineLines
      ? [
          ...lines.slice(0, WORKSPACE_LIMITS.maxOutlineLines - 1),
          `… ${lines.length - WORKSPACE_LIMITS.maxOutlineLines + 1} more`,
        ]
      : lines;
  const notes = await notesHead(join(tracksDir, scope.trackSlug, "notes.md"));
  return notes === undefined ? { tree } : { tree, notes };
}

async function notesHead(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return undefined;
    handle = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = new Uint8Array(WORKSPACE_LIMITS.maxNotesBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (detectBinary(head)) return undefined;
    const text = new TextDecoder("utf-8").decode(head).replace(/�$/, "");
    return bytesRead === buffer.length ? `${text}…` : text;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function safeReaddir(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trim(bytes / 1024)} KiB`;
  return `${trim(bytes / (1024 * 1024))} MiB`;
}

function trim(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}

function isNotDirectory(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOTDIR";
}

function fsMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case "ENOENT":
      return "no such file";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EISDIR":
      return "is a directory";
    case "ENOTDIR":
      return "a path segment is not a directory";
    case "ELOOP":
      return "too many symlinks";
    default:
      return code ? `filesystem error ${code}` : "filesystem error";
  }
}
