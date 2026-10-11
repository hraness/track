import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile as fsRead,
  realpath,
  rm,
  symlink,
  writeFile as fsWrite,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editFile,
  listFiles,
  projectOutline,
  readFile,
  resolveReadPath,
  resolveWritePath,
  WORKSPACE_LIMITS,
  WorkspaceError,
  writeFile,
  writeRoots,
  globMatch,
  type WorkspaceScope,
} from "./workspace.ts";

let root: string;
let outside: string;
let scope: WorkspaceScope;

async function seed(files: Record<string, string | Uint8Array>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await fsWrite(abs, content);
  }
}

beforeEach(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "dawg-ws-")));
  root = join(base, "project");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await fsWrite(join(outside, "secret.txt"), "not yours\n");
  scope = { root, trackSlug: "bass" };
  await seed({
    "dawg.json": '{"dawg":1,"sdk":"1"}\n',
    "song.ts": "export default song({ tempo: 120 });\n",
    "tracks/bass/track.ts":
      'export default track({ id: "t-bass", name: "bass" });\n',
    "tracks/bass/notes.md": "# bass\nkeep it simple\n",
    "tracks/drums/track.ts": 'export default track({ id: "t-drums" });\n',
    ".dawg/session": "abc\n",
    ".dawg/sessions/abc.json": "{}\n",
  });
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

const rejects = async (promise: Promise<unknown>, pattern: RegExp) => {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(WorkspaceError);
  expect((error as Error).message).toMatch(pattern);
};

describe("path policy", () => {
  test("rejects escapes, absolute paths outside the root, and .dawg", async () => {
    await rejects(
      resolveReadPath(scope, "../outside/secret.txt"),
      /leaves the project/,
    );
    await rejects(
      resolveReadPath(scope, join(outside, "secret.txt")),
      /leaves the project/,
    );
    await rejects(
      resolveReadPath(scope, "tracks/../../outside/secret.txt"),
      /leaves the project/,
    );
    await rejects(resolveReadPath(scope, ".dawg/session"), /\.dawg\//);
    await rejects(resolveReadPath(scope, ".dawg"), /\.dawg\//);
    await rejects(resolveWritePath(scope, ".dawg/session"), /\.dawg\//);
    await rejects(resolveReadPath(scope, "a\0b"), /NUL/);
    await rejects(resolveReadPath(scope, "x".repeat(600)), /longer than/);
    await rejects(resolveReadPath(scope, 42), /must be a string/);
    await rejects(resolveReadPath(scope, "nope.ts"), /no such file/);
  });

  test("accepts absolute paths inside the root and dot-prefixed names", async () => {
    expect((await resolveReadPath(scope, join(root, "song.ts"))).rel).toBe(
      "song.ts",
    );
    await seed({ "..notes": "x" });
    expect((await resolveReadPath(scope, "..notes")).rel).toBe("..notes");
  });

  test("rejects symlinks that leave the root for reads and writes", async () => {
    await symlink(
      join(outside, "secret.txt"),
      join(root, "tracks/bass/leak.txt"),
    );
    await symlink(outside, join(root, "tracks/bass/out"));
    await rejects(
      resolveReadPath(scope, "tracks/bass/leak.txt"),
      /symlink that leaves/,
    );
    await rejects(
      resolveReadPath(scope, "tracks/bass/out/secret.txt"),
      /symlink that leaves/,
    );
    await rejects(resolveWritePath(scope, "tracks/bass/leak.txt"), /symlink/);
    await rejects(
      resolveWritePath(scope, "tracks/bass/out/new.txt"),
      /symlink that leaves/,
    );
    await rejects(writeFile(scope, "tracks/bass/out/new.txt", "x"), /symlink/);
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  test("rejects a symlinked track directory that points at another track", async () => {
    await symlink(join(root, "tracks/drums"), join(root, "tracks/keys"));
    await rejects(
      resolveWritePath({ root, trackSlug: "keys" }, "tracks/keys/track.ts"),
      /outside this window's writable scope/,
    );
  });

  test("scopes writes to song.ts and the focused track directory", async () => {
    expect(writeRoots(scope)).toEqual(["song.ts", "tracks/bass/"]);
    expect((await resolveWritePath(scope, "song.ts")).rel).toBe("song.ts");
    expect((await resolveWritePath(scope, "tracks/bass/notes.md")).rel).toBe(
      "tracks/bass/notes.md",
    );
    expect(
      (await resolveWritePath(scope, "tracks/bass/samples/kick.wav")).rel,
    ).toBe("tracks/bass/samples/kick.wav");
    await rejects(
      resolveWritePath(scope, "tracks/drums/track.ts"),
      /may write song\.ts and tracks\/bass\//,
    );
    await rejects(resolveWritePath(scope, "dawg.json"), /writable scope/);
    await rejects(
      resolveWritePath(scope, "tracks/bassline/track.ts"),
      /writable scope/,
    );
    await mkdir(join(root, "tracks/bass/samples"), { recursive: true });
    await rejects(
      resolveWritePath(scope, "tracks/bass/samples"),
      /is a directory/,
    );
    await rejects(resolveWritePath(scope, "tracks/bass"), /writable scope/);
    await rejects(resolveWritePath(scope, ""), /writable scope/);
  });
});

describe("list_files", () => {
  test("lists directories first with sizes and hides .dawg at the root", async () => {
    const { text, summary } = await listFiles(scope);
    const lines = text.split("\n");
    expect(lines[0]).toBe("./ · 3 entries");
    expect(lines[1]).toBe("tracks/");
    expect(lines[2]).toMatch(/^dawg\.json {2}21 B {2}\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toContain(".dawg");
    expect(summary).toBe("listed . (3)");
    const sub = await listFiles(scope, "tracks/bass");
    expect(sub.text.split("\n")[0]).toBe("tracks/bass/ · 2 entries");
  });

  test("caps the listing at 500 entries and reports the rest", async () => {
    await mkdir(join(root, "tracks/bass/many"));
    for (let index = 0; index < 505; index += 1)
      await fsWrite(
        join(root, "tracks/bass/many", `f${String(index).padStart(3, "0")}`),
        "x",
      );
    const { text } = await listFiles(scope, "tracks/bass/many");
    const lines = text.split("\n");
    expect(lines).toHaveLength(1 + WORKSPACE_LIMITS.maxListEntries + 1);
    expect(lines.at(-1)).toBe("… 5 more entries not shown");
  });

  test("diagnoses a file path and a missing directory", async () => {
    await rejects(
      listFiles(scope, "song.ts"),
      /not a directory; use read_file/,
    );
    await rejects(listFiles(scope, "missing"), /no such file/);
  });
});

describe("read_file", () => {
  test("reads text with a header, honours offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
    await seed({ "tracks/bass/notes.md": `${lines.join("\n")}\n` });
    const whole = await readFile(scope, "tracks/bass/notes.md");
    expect(whole.text).toBe(
      `tracks/bass/notes.md · lines 1-10 of 10\n${lines.join("\n")}`,
    );
    expect(whole.summary).toBe("read tracks/bass/notes.md (10 lines)");
    const part = await readFile(scope, "tracks/bass/notes.md", {
      offset: 4,
      limit: 3,
    });
    expect(part.text).toBe(
      "tracks/bass/notes.md · lines 4-6 of 10 · continue with offset 7\nline 4\nline 5\nline 6",
    );
    await rejects(
      readFile(scope, "tracks/bass/notes.md", { offset: 11 }),
      /offset 11 is past the end/,
    );
    await rejects(readFile(scope, "tracks"), /is a directory; use list_files/);
    const empty = await readFile(scope, "tracks/bass/empty.txt").catch(
      () => undefined,
    );
    expect(empty).toBeUndefined();
  });

  test("truncates output at 256 KiB and says how to continue", async () => {
    const line = "x".repeat(1023);
    await seed({
      "tracks/bass/big.txt": Array.from({ length: 300 }, () => line).join("\n"),
    });
    const { text } = await readFile(scope, "tracks/bass/big.txt");
    const [header, ...body] = text.split("\n");
    expect(header).toBe(
      "tracks/bass/big.txt · lines 1-256 of 300 · truncated at 256 KiB; continue with offset 257",
    );
    expect(body).toHaveLength(256);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      WORKSPACE_LIMITS.maxReadBytes + 128,
    );
  });

  test("reports binary files by type and size instead of dumping them", async () => {
    const wav = new Uint8Array(64);
    wav.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const blob = new Uint8Array(32);
    blob[5] = 0;
    blob[6] = 0xff;
    await seed({
      "tracks/bass/samples/kick.wav": wav,
      "tracks/bass/blob.bin": blob,
    });
    const { text, summary } = await readFile(
      scope,
      "tracks/bass/samples/kick.wav",
    );
    expect(text).toBe(
      "tracks/bass/samples/kick.wav: wav file, 64 B (64 bytes); not readable as text",
    );
    expect(summary).toBe("read tracks/bass/samples/kick.wav (wav)");
    expect((await readFile(scope, "tracks/bass/blob.bin")).text).toContain(
      "binary file, 32 B",
    );
  });
});

describe("write_file", () => {
  test("writes atomically, creates parents inside scope, and leaves no temp files", async () => {
    const result = await writeFile(
      scope,
      "tracks/bass/samples/notes/x.txt",
      "hi\n",
    );
    expect(result).toMatchObject({
      rel: "tracks/bass/samples/notes/x.txt",
      bytes: 3,
      created: true,
    });
    expect(result.text).toBe(
      "wrote tracks/bass/samples/notes/x.txt (3 bytes, new file)",
    );
    expect(result.summary).toBe("wrote tracks/bass/samples/notes/x.txt (3 B)");
    expect(
      await fsRead(join(root, "tracks/bass/samples/notes/x.txt"), "utf8"),
    ).toBe("hi\n");
    expect(
      (await readdir(join(root, "tracks/bass/samples/notes"))).sort(),
    ).toEqual(["x.txt"]);
    const again = await writeFile(
      scope,
      "song.ts",
      "export default song({ tempo: 90 });\n",
    );
    expect(again.created).toBe(false);
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("refuses writes over 1 MiB, out of scope, and non-string content", async () => {
    await rejects(
      writeFile(
        scope,
        "tracks/bass/huge.txt",
        "x".repeat(WORKSPACE_LIMITS.maxWriteBytes + 1),
      ),
      /write limit is 1 MiB/,
    );
    await rejects(
      writeFile(scope, "tracks/drums/track.ts", "x"),
      /writable scope/,
    );
    await rejects(
      writeFile(scope, "tracks/bass/x.txt", 7),
      /content must be a string/,
    );
    expect(await fsRead(join(root, "tracks/drums/track.ts"), "utf8")).toContain(
      "t-drums",
    );
  });
});

describe("edit_file", () => {
  test("replaces exactly one occurrence", async () => {
    const result = await editFile(
      scope,
      "tracks/bass/track.ts",
      'name: "bass"',
      'name: "bass",\n  volume: 0.7',
    );
    expect(result.text).toBe(
      "edited tracks/bass/track.ts: replaced 1 occurrence (1 → 2 lines)",
    );
    expect(result.summary).toBe("edited tracks/bass/track.ts");
    expect(await fsRead(join(root, "tracks/bass/track.ts"), "utf8")).toContain(
      "volume: 0.7",
    );
  });

  test("diagnoses zero and multiple matches without touching the file", async () => {
    await seed({ "tracks/bass/notes.md": "a b a\n" });
    await rejects(
      editFile(scope, "tracks/bass/notes.md", "zzz", "y"),
      /old text was not found in tracks\/bass\/notes\.md/,
    );
    await rejects(
      editFile(scope, "tracks/bass/notes.md", "a", "y"),
      /occurs 2 times in tracks\/bass\/notes\.md/,
    );
    await rejects(
      editFile(scope, "tracks/bass/notes.md", "", "y"),
      /old must be a non-empty string/,
    );
    await rejects(
      editFile(scope, "tracks/bass/notes.md", "a", "a"),
      /identical/,
    );
    await rejects(
      editFile(scope, "tracks/bass/missing.md", "a", "b"),
      /no such file; use write_file/,
    );
    await rejects(
      editFile(scope, "tracks/drums/track.ts", "t-drums", "x"),
      /writable scope/,
    );
    expect(await fsRead(join(root, "tracks/bass/notes.md"), "utf8")).toBe(
      "a b a\n",
    );
  });
});

describe("projectOutline", () => {
  test("lists top-level entries, tracks with counts, downloads, and the notes head", async () => {
    await seed({
      "tracks/bass/downloads/song.wav": "RIFF",
      "tracks/bass/downloads/song.json": "{}",
      "tracks/bass/samples/kick.wav": "RIFF",
      "node_modules/x/index.js": "",
      "README.md": "# hi\n",
    });
    const outline = await projectOutline(scope);
    expect(outline.tree).toEqual([
      "dawg.json 21 B",
      "README.md 5 B",
      "song.ts 37 B",
      "tracks/bass/ (focused) 2 files 76 B, 1 samples",
      "tracks/bass/downloads/: song.json, song.wav",
      "tracks/drums/ 1 file 41 B",
    ]);
    expect(outline.notes).toBe("# bass\nkeep it simple\n");
  });

  test("stays within 30 lines and 1 KiB of notes, and never throws", async () => {
    for (let index = 0; index < 60; index += 1)
      await seed({ [`tracks/t${index}/track.ts`]: "x" });
    await seed({ "tracks/bass/notes.md": "n".repeat(5000) });
    const outline = await projectOutline(scope);
    expect(outline.tree.length).toBeLessThanOrEqual(
      WORKSPACE_LIMITS.maxOutlineLines,
    );
    expect(outline.tree.at(-1)).toMatch(/^… \d+ more$/);
    expect(outline.notes!.length).toBe(WORKSPACE_LIMITS.maxNotesBytes + 1);
    expect(outline.notes!.endsWith("…")).toBe(true);
    const missing = await projectOutline({
      root: join(root, "nope"),
      trackSlug: "bass",
    });
    expect(missing).toEqual({ tree: [] });
  });
});

describe("dispatch write globs", () => {
  test("globs replace the default write scope", async () => {
    const sub: WorkspaceScope = {
      root,
      trackSlug: "bass",
      writeGlobs: ["tracks/drums/**", "notes/*.md"],
    };
    expect(globMatch("tracks/drums/**", "tracks/drums/a/b.ts")).toBe(true);
    expect(globMatch("**/x.ts", "x.ts")).toBe(true);
    expect(globMatch("**/x.ts", "ax.ts")).toBe(false);
    expect(globMatch("notes/*.md", "notes/a/b.md")).toBe(false);
    await writeFile(sub, "tracks/drums/notes.md", "kick on 1\n");
    await rejects(
      writeFile(sub, "tracks/bass/notes.md", "x"),
      /outside this window's writable scope; it may write tracks\/drums\/\*\* and notes\/\*\.md/,
    );
    await rejects(writeFile(sub, "song.ts", "x"), /outside this window/);
    expect(writeRoots(sub)).toEqual(["tracks/drums/**", "notes/*.md"]);
  });
});
