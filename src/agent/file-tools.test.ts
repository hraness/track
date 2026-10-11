import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteFile,
  FILE_TOOL_LIMITS,
  globFiles,
  grepFiles,
  moveFile,
} from "./file-tools.ts";
import { WorkspaceError, type WorkspaceScope } from "./workspace.ts";

let root: string;
let outside: string;
let scope: WorkspaceScope;

async function rejects(promise: Promise<unknown>, message: RegExp) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WorkspaceError);
  expect((error as Error).message).toMatch(message);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dawg-ft-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "dawg-ft-out-")));
  await mkdir(join(root, "tracks/bass"), { recursive: true });
  await mkdir(join(root, "tracks/drums"), { recursive: true });
  await mkdir(join(root, ".dawg"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "node_modules/x"), { recursive: true });
  await writeFile(join(root, "song.ts"), "export default song({});\n");
  await writeFile(
    join(root, "tracks/bass/track.ts"),
    'export default track({ id: "bass", instrument: "sub" });\n',
  );
  await writeFile(
    join(root, "tracks/drums/track.ts"),
    'export default track({ id: "drums", instrument: "kit" });\n',
  );
  await writeFile(join(root, ".dawg/session"), "instrument secret\n");
  await writeFile(join(root, ".git/config"), "instrument git\n");
  await writeFile(join(root, "node_modules/x/i.js"), "instrument dep\n");
  await writeFile(join(outside, "secret.ts"), "instrument outside\n");
  scope = { root, trackSlug: "bass" };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("glob", () => {
  test("matches by pattern, skips denied dirs and symlinks out", async () => {
    await symlink(outside, join(root, "tracks/bass/out"));
    const result = await globFiles(scope, { pattern: "**/*.ts" });
    expect(result.text.split("\n")).toEqual([
      "3 matches for **/*.ts in .",
      "song.ts",
      "tracks/bass/track.ts",
      "tracks/drums/track.ts",
    ]);
    const scoped = await globFiles(scope, {
      pattern: "*.ts",
      path: "tracks/bass",
    });
    expect(scoped.text).toContain("tracks/bass/track.ts");
    await rejects(
      globFiles(scope, { pattern: "*", path: ".dawg" }),
      /\.dawg\//,
    );
    await rejects(
      globFiles(scope, { pattern: "*", path: "../" }),
      /leaves the project/,
    );
  });

  test("pages with cursor and stays under 6 KiB", async () => {
    await mkdir(join(root, "samples"), { recursive: true });
    for (let index = 0; index < 400; index++)
      await writeFile(
        join(
          root,
          "samples",
          `a-long-sample-name-${String(index).padStart(3, "0")}.wav`,
        ),
        "",
      );
    const first = await globFiles(scope, {
      pattern: "samples/*.wav",
      limit: 500,
    });
    expect(new TextEncoder().encode(first.text).byteLength).toBeLessThanOrEqual(
      FILE_TOOL_LIMITS.maxResultBytes,
    );
    const cursor = Number(/cursor=(\d+)/.exec(first.text)?.[1]);
    expect(cursor).toBeGreaterThan(0);
    const second = await globFiles(scope, {
      pattern: "samples/*.wav",
      cursor,
      limit: 2,
    });
    expect(second.text.split("\n")[1]).toBe(
      `samples/a-long-sample-name-${String(cursor).padStart(3, "0")}.wav`,
    );
  });

  test("an absolute read root is searchable, read-only", async () => {
    await writeFile(join(outside, "kick.wav"), "");
    const withRoots: WorkspaceScope = { ...scope, readRoots: [outside] };
    const result = await globFiles(withRoots, {
      pattern: "*.wav",
      path: outside,
    });
    expect(result.text).toContain(join(outside, "kick.wav"));
    await rejects(
      globFiles(scope, { pattern: "*", path: outside }),
      /leaves the project/,
    );
  });
});

describe("grep", () => {
  test("file:line: text, never from denied dirs", async () => {
    const result = await grepFiles(scope, { pattern: "instrument" });
    expect(result.text.split("\n")).toEqual([
      "grep /instrument/ in .",
      'tracks/bass/track.ts:1: export default track({ id: "bass", instrument: "sub" });',
      'tracks/drums/track.ts:1: export default track({ id: "drums", instrument: "kit" });',
    ]);
    const one = await grepFiles(scope, {
      pattern: "KIT",
      ignoreCase: true,
      path: "tracks/drums/track.ts",
    });
    expect(one.text).toContain("tracks/drums/track.ts:1:");
    const none = await grepFiles(scope, { pattern: "zzz", glob: "*.md" });
    expect(none.text).toContain("no matches");
    await rejects(grepFiles(scope, { pattern: "(" }), /not a valid regular/);
  });

  test("pages with cursor, caps lines and bytes", async () => {
    const line = `${"x".repeat(400)}\n`;
    await writeFile(join(root, "tracks/bass/big.txt"), line.repeat(300));
    const first = await grepFiles(scope, { pattern: "x", limit: 200 });
    expect(new TextEncoder().encode(first.text).byteLength).toBeLessThanOrEqual(
      FILE_TOOL_LIMITS.maxResultBytes,
    );
    expect(first.text).toMatch(/cursor=\d+/);
    expect(first.text.split("\n")[1]!.length).toBeLessThan(260);
  });

  test("skips binary files", async () => {
    await writeFile(
      join(root, "tracks/bass/a.wav"),
      new Uint8Array([0, 105, 110, 0]),
    );
    const result = await grepFiles(scope, { pattern: "in" });
    expect(result.text).not.toContain("a.wav");
  });
});

describe("move_file and delete_file", () => {
  test("move renames, never overwrites, refuses denied targets", async () => {
    await writeFile(join(root, "tracks/bass/notes.md"), "n\n");
    const moved = await moveFile(
      scope,
      "tracks/bass/notes.md",
      "notes/bass.md",
    );
    expect(moved.text).toBe("moved tracks/bass/notes.md → notes/bass.md");
    expect(await readFile(join(root, "notes/bass.md"), "utf8")).toBe("n\n");
    await rejects(
      moveFile(scope, "notes/bass.md", "song.ts"),
      /never overwrites/,
    );
    await rejects(moveFile(scope, "notes/bass.md", ".dawg/x.md"), /\.dawg\//);
    await rejects(moveFile(scope, ".dawg/session", "x"), /\.dawg\//);
    await rejects(moveFile(scope, "missing.md", "y.md"), /no such file/);
    await rejects(
      moveFile(scope, "tracks", "y"),
      /not a regular file|directory/,
    );
  });

  test("delete keeps a copy in .dawg/trash/", async () => {
    const result = await deleteFile(
      scope,
      "tracks/drums/track.ts",
      new Date("2026-10-11T00:00:00Z"),
    );
    expect(result.trash).toBe(
      ".dawg/trash/2026-10-11T00-00-00-000Z/tracks/drums/track.ts",
    );
    expect(await readdir(join(root, "tracks/drums"))).toEqual([]);
    expect(await readFile(join(root, result.trash), "utf8")).toContain("kit");
    await rejects(deleteFile(scope, ".dawg/session"), /\.dawg\//);
    await rejects(deleteFile(scope, ".git/config"), /do not touch/);
  });

  test("a dispatch scope limits move and delete to its globs", async () => {
    const sub: WorkspaceScope = { ...scope, writeGlobs: ["tracks/bass/**"] };
    await rejects(
      deleteFile(sub, "tracks/drums/track.ts"),
      /task's writable scope/,
    );
    await rejects(
      moveFile(sub, "tracks/bass/track.ts", "tracks/drums/b.ts"),
      /task's writable scope/,
    );
  });

  test("symlinks out of the project cannot be moved or deleted through", async () => {
    await symlink(
      join(outside, "secret.ts"),
      join(root, "tracks/bass/leak.ts"),
    );
    await rejects(deleteFile(scope, "tracks/bass/leak.ts"), /symlink/);
    expect(await readdir(outside)).toEqual(["secret.ts"]);
  });
});
