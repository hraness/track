/**
 * Session metadata: the human name, who chose it, and fork lineage. It is
 * stored inside the session record beside the composition, versioned on its
 * own counter so renames never bump the score revision or the undo history.
 */
export const MAX_SESSION_NAME_LENGTH = 40;
export const DEFAULT_SESSION_NAME = "untitled";
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_ID_LENGTH = 64;
const FINGERPRINT_PATTERN = /^[0-9a-f]{1,32}$/;
/** C0/C1 controls, zero-width and bidi formatting characters. */
const UNPRINTABLE = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]",
  "g",
);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type NameSource = "auto" | "user";

export type SessionMeta = {
  name: string;
  /** `user` permanently stops auto-naming until `/rename --auto`. */
  nameSource: NameSource;
  forkOf?: { sessionId: string; revision: number };
  createdAt: string;
  updatedAt: string;
  /** Incremented on every metadata write; independent of the score revision. */
  version: number;
  /** Fingerprint hash the current auto name was chosen for. */
  namedFingerprint?: string;
  /** Track-and-instrument-set hash at the last auto name. */
  namedStructure?: string;
  /**
   * Optional (0.7): the song's loop has wrapped once, so the one-shot
   * `↻ first loop` moment never repeats. Session state, never the score.
   */
  heardLoop?: true;
};

/** Fields a client may change. `null` clears an optional field. */
export type MetaPatch = {
  name?: string;
  nameSource?: NameSource;
  namedFingerprint?: string | null;
  namedStructure?: string | null;
  /** Only ever set; the first loop is heard once. */
  heardLoop?: true;
};

/**
 * A conditional write applies only when every given field still matches.
 * `revision` is the score revision the write was computed from: an auto-name
 * is a function of the score, so a name for an older revision is stale.
 */
export type MetaExpect = {
  name?: string;
  nameSource?: NameSource;
  revision?: number;
};

export class MetaValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MetaValidationError";
  }
}

/** Trims, collapses whitespace, drops control characters, bounds to 40. */
export function normalizeSessionName(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024)
    throw new MetaValidationError("session name must be a short string");
  const name = value
    .replace(UNPRINTABLE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SESSION_NAME_LENGTH)
    .trim();
  if (name.length === 0) throw new MetaValidationError("session name is empty");
  return name;
}

export function defaultSessionMeta(
  at: string,
  name = DEFAULT_SESSION_NAME,
): SessionMeta {
  return {
    name,
    nameSource: "auto",
    createdAt: at,
    updatedAt: at,
    version: 0,
  };
}

/**
 * Validates metadata read from disk or the wire. Records written before
 * metadata existed get a deterministic name derived from their id.
 */
export function parseSessionMeta(
  value: unknown,
  fallback: { sessionId: string; updatedAt: string },
): SessionMeta {
  if (value === undefined || value === null)
    return defaultSessionMeta(
      fallback.updatedAt,
      `session ${fallback.sessionId.slice(0, 8)}`,
    );
  if (typeof value !== "object" || Array.isArray(value))
    throw new MetaValidationError("session meta must be an object");
  const meta = value as Record<string, unknown>;
  const nameSource = meta.nameSource;
  if (nameSource !== "auto" && nameSource !== "user")
    throw new MetaValidationError("session nameSource is invalid");
  if (!Number.isSafeInteger(meta.version) || (meta.version as number) < 0)
    throw new MetaValidationError("session meta version is invalid");
  const result: SessionMeta = {
    name: normalizeSessionName(meta.name),
    nameSource,
    createdAt: timestamp(meta.createdAt, "createdAt"),
    updatedAt: timestamp(meta.updatedAt, "updatedAt"),
    version: meta.version as number,
  };
  if (meta.forkOf !== undefined) {
    const fork = meta.forkOf;
    if (typeof fork !== "object" || fork === null)
      throw new MetaValidationError("session forkOf is invalid");
    const { sessionId, revision } = fork as Record<string, unknown>;
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      sessionId.length > MAX_ID_LENGTH ||
      !ID_PATTERN.test(sessionId) ||
      !Number.isSafeInteger(revision) ||
      (revision as number) < 0
    )
      throw new MetaValidationError("session forkOf is invalid");
    result.forkOf = { sessionId, revision: revision as number };
  }
  const fingerprint = optionalFingerprint(meta.namedFingerprint);
  if (fingerprint) result.namedFingerprint = fingerprint;
  const structure = optionalFingerprint(meta.namedStructure);
  if (structure) result.namedStructure = structure;
  if (meta.heardLoop === true) result.heardLoop = true;
  return result;
}

/** Validates a client patch from `unknown`; unknown keys are ignored. */
export function parseMetaPatch(value: unknown): MetaPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new MetaValidationError("meta patch must be an object");
  const raw = value as Record<string, unknown>;
  const patch: MetaPatch = {};
  if (raw.name !== undefined) patch.name = normalizeSessionName(raw.name);
  if (raw.nameSource !== undefined) {
    if (raw.nameSource !== "auto" && raw.nameSource !== "user")
      throw new MetaValidationError("nameSource is invalid");
    patch.nameSource = raw.nameSource;
  }
  for (const key of ["namedFingerprint", "namedStructure"] as const) {
    if (raw[key] === undefined) continue;
    patch[key] = raw[key] === null ? null : requireFingerprint(raw[key]);
  }
  if (raw.heardLoop !== undefined) {
    if (raw.heardLoop !== true)
      throw new MetaValidationError("heardLoop is invalid");
    patch.heardLoop = true;
  }
  if (Object.keys(patch).length === 0)
    throw new MetaValidationError("meta patch is empty");
  return patch;
}

export function parseMetaExpect(value: unknown): MetaExpect | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new MetaValidationError("meta condition must be an object");
  const raw = value as Record<string, unknown>;
  const expect: MetaExpect = {};
  if (raw.name !== undefined) expect.name = normalizeSessionName(raw.name);
  if (raw.nameSource !== undefined) {
    if (raw.nameSource !== "auto" && raw.nameSource !== "user")
      throw new MetaValidationError("nameSource is invalid");
    expect.nameSource = raw.nameSource;
  }
  if (raw.revision !== undefined) {
    if (
      typeof raw.revision !== "number" ||
      !Number.isSafeInteger(raw.revision) ||
      raw.revision < 0
    )
      throw new MetaValidationError("meta revision is invalid");
    expect.revision = raw.revision;
  }
  return expect;
}

export function metaMatches(
  meta: SessionMeta,
  expect?: MetaExpect,
  revision?: number,
): boolean {
  if (!expect) return true;
  if (expect.revision !== undefined && expect.revision !== revision)
    return false;
  if (expect.name !== undefined && expect.name !== meta.name) return false;
  if (expect.nameSource !== undefined && expect.nameSource !== meta.nameSource)
    return false;
  return true;
}

export function applyMetaPatch(
  meta: SessionMeta,
  patch: MetaPatch,
  at: string,
): SessionMeta {
  const next: SessionMeta = {
    ...meta,
    updatedAt: at,
    version: meta.version + 1,
  };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.nameSource !== undefined) next.nameSource = patch.nameSource;
  if (patch.heardLoop) next.heardLoop = true;
  for (const key of ["namedFingerprint", "namedStructure"] as const) {
    if (patch[key] === null) delete next[key];
    else if (patch[key] !== undefined) next[key] = patch[key];
  }
  return next;
}

/** Splits a trailing ` N` (N ≥ 2) suffix: `x 3` → `{ base: "x", n: 3 }`. */
export function splitNameNumber(name: string): { base: string; n: number } {
  const match = name.match(/^(.*\S) (\d{1,4})$/);
  if (!match) return { base: name, n: 1 };
  const n = Number(match[2]);
  return n >= 2 ? { base: match[1]!, n } : { base: name, n: 1 };
}

/**
 * Default fork name: strip any trailing ` N` from the parent, then take the
 * highest ` N` among sessions with that base, plus one (`x` → `x 2` → `x 3`;
 * a fork of `x 2` is `x 3` too).
 */
export function forkName(parent: string, existing: readonly string[]): string {
  const { base } = splitNameNumber(parent);
  let highest = 1;
  for (const name of existing) {
    const split = splitNameNumber(name);
    if (split.base === base) highest = Math.max(highest, split.n);
  }
  return withNumber(base, highest + 1);
}

/** Adds or bumps a ` N` suffix until the name is not in `taken`. */
export function uniqueName(name: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((entry) => entry.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const { base, n } = splitNameNumber(name);
  for (let next = Math.max(2, n + 1); next < 10_000; next += 1) {
    const candidate = withNumber(base, next);
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

export function withNumber(base: string, n: number): string {
  const suffix = ` ${n}`;
  return `${base.slice(0, MAX_SESSION_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TIMESTAMP_LENGTH
  )
    throw new MetaValidationError(`session ${label} is invalid`);
  return value;
}

function optionalFingerprint(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireFingerprint(value);
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value))
    throw new MetaValidationError("fingerprint is invalid");
  return value;
}
