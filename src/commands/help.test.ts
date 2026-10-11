import { describe, expect, test } from "bun:test";
import {
  ARRANGE_PAGE,
  HELP_SECTIONS,
  looksLikeProse,
  helpLines,
  helpText,
  helpHeadingMarks,
  helpTopicLines,
  editDistance,
  nearestCommand,
  typoFix,
  usageHint,
  keysLines,
  USAGE,
  helpTitle,
} from "./help.ts";
import { KEYS, type KeySection } from "../../tui/grammar.ts";
import { createScore } from "../../core/score.ts";
import { commandParses } from "./parses.ts";
import {
  lintText,
  resolveTopic,
  TOPIC_ALIASES,
  TOPICS,
  topicMiss,
} from "../lang/glossary.ts";

describe("help reference", () => {
  test("groups are the topic ids in order, each command exactly once", () => {
    const topics = HELP_SECTIONS.map(
      (section) => section.group.split(" · ")[0],
    );
    expect([...new Set(topics)]).toEqual(TOPICS.filter((id) => id !== "keys"));
    // Sub-groups sit right after their topic: the menu root order holds.
    for (let i = 1; i < topics.length; i++)
      if (topics[i] !== topics[i - 1])
        expect(topics.indexOf(topics[i]!)).toBe(i);
    for (const section of HELP_SECTIONS)
      expect(section.entries.length).toBeLessThanOrEqual(16);
    const commands = HELP_SECTIONS.flatMap((section) =>
      section.entries.map((entry) => entry.command),
    );
    expect(new Set(commands).size).toBe(commands.length);
    for (const required of [
      "help [topic]",
      "/transcript",
      "track <name>",
      "/view focus|all",
      "/theme default|high-contrast|mono",
      "/motion on|off",
      "tracks",
      "/status",
      "/sessions",
      "/resume [<n>|<name>|<id>]",
      "undo [all]",
      "redo [all]",
    ])
      expect(commands).toContain(required);
  });

  // Bare by default; a verb keeps its slash while only the window runs it
  // (the grammar lane makes the slash optional, then this list shrinks),
  // so the written form always works today.
  test("commands are bare except the window-only verbs", () => {
    const slashed = HELP_SECTIONS.flatMap((section) =>
      section.entries
        .map((entry) => entry.command)
        .filter((command) => command.startsWith("/")),
    ).map((command) => command.split(/[\s[]/)[0]);
    expect([...new Set(slashed)].sort()).toEqual(
      [
        "/agent",
        "/auth",
        "/bpm",
        "/chords",
        "/click",
        "/comment",
        "/fork",
        "/formant",
        "/guide",
        "/kit",
        "/logout",
        "/menu",
        "/model",
        "/motion",
        "/patch",
        "/play",
        "/rename",
        "/resume",
        "/sample",
        "/sessions",
        "/showme",
        "/status",
        "/tape",
        "/theme",
        "/transcript",
        "/try",
        "/view",
        "/vowel",
      ].sort(),
    );
  });

  test("placeholders use the glossary words", () => {
    const text = HELP_SECTIONS.flatMap((section) =>
      section.entries.map((entry) => entry.command),
    ).join("\n");
    expect(text).toContain("hit <drum>");
    expect(text).toContain("<sample>");
    expect(text).toContain("<lane>");
    expect(text).not.toContain("<voice>");
    expect(text).not.toContain("<registers>");
  });

  test("overlay lines carry a heading per topic, then the keys, and fit", () => {
    const lines = helpLines(72);
    const headings = lines.filter((line) => line.startsWith("── "));
    expect(headings.slice(0, HELP_SECTIONS.length)).toEqual(
      HELP_SECTIONS.map((section) => `── ${section.group}`),
    );
    expect(headings[HELP_SECTIONS.length]).toStartWith("── keys");
    expect(lines.every((line) => line.length <= 72)).toBe(true);
    expect(lines.some((line) => line.startsWith("pan <-1..1>"))).toBe(true);
  });

  test("the CLI block lists the same commands without the key table", () => {
    const text = helpText();
    expect(text).toContain("sound:\n  instrument");
    expect(text).toContain("/resume [<n>|<name>|<id>]");
    expect(text).not.toContain("ctrl-z");
  });

  test("near-misses of known verbs get usage; free text gets nothing", () => {
    expect(usageHint("pan 3")).toBe("pan takes -1…1 · pan -0.5");
    expect(usageHint("volume 2")).toBe("volume takes 0…1 · volume 0.8");
    expect(usageHint("add H4 at 0")).toContain("add <note> at <beat>");
    expect(usageHint("/export")).toBe(
      "usage · export <file> · export loop.track.json",
    );
    expect(usageHint("/foo")).toBeUndefined();
    expect(usageHint("make it swing")).toBeUndefined();
  });

  test("/help is start-here plus the ten topics; all is the reference", () => {
    const guide = helpTopicLines(undefined, 72)!;
    expect(guide.filter((line) => line.startsWith("── "))).toEqual([
      "── start here",
      "── topics · help <topic>",
    ]);
    expect(guide.length).toBeLessThanOrEqual(22);
    expect(guide.every((line) => line.length <= 72)).toBe(true);
    for (const id of TOPICS)
      expect(guide.some((line) => line.startsWith(`${id} `))).toBe(true);
    expect(helpTopicLines("all", 72)).toEqual(helpLines(72));
    expect(helpTopicLines("nope", 72)).toBeUndefined();
    const arrange = helpTopicLines("arrange", 72)!;
    expect(arrange[0]).toBe("── arrange");
    for (const verb of ["section", "form", "build", "style"])
      expect(arrange.some((line) => line.startsWith(`${verb} `))).toBe(true);
    expect(arrange.at(-1)).toBe("guide arrange · menu arrange · help all");
    // A command name is a topic too: its rows and its full usage.
    for (const name of ["vocoder", "clip", "autotune", "sing", "formant"]) {
      const lines = helpTopicLines(name, 72)!;
      expect(lines[0]).toBe(`── ${name}`);
      expect(lines.every((line) => line.length <= 72)).toBe(true);
    }
    expect(helpTopicLines("vocoder", 72)!.join(" ")).toContain("freeze");
    expect(helpTopicLines("vocoder", 72)!.at(-1)).toBe("see also help voice");
  });

  test("every topic id and alias opens a page", () => {
    for (const id of TOPICS) {
      const lines = helpTopicLines(id, 72)!;
      expect(lines[0]).toBe(`── ${id}`);
      expect(lines.every((line) => line.length <= 72)).toBe(true);
      expect(helpTopicLines(`/${id.toUpperCase()}`, 72)?.[0]).toBe(`── ${id}`);
    }
    for (const [alias, id] of Object.entries(TOPIC_ALIASES)) {
      const lines = helpTopicLines(alias, 72);
      expect(lines).toBeDefined();
      expect(resolveTopic(alias)).toBe(id);
    }
    expect(helpTopicLines("music", 72)?.[0]).toBe("── arrange");
    expect(helpTopicLines("session", 72)?.[0]).toBe("── project");
    expect(helpTopicLines("window", 72)?.[0]).toBe("── keys");
  });

  test("help keys is tui/grammar.ts KEYS, row for row", () => {
    const lines = keysLines(200);
    const rows = new Set(
      (Object.values(KEYS) as readonly KeySection[][]).flatMap((sections) =>
        sections.flatMap((section) =>
          section.rows.map(([keys, action]) => `${keys}|${action}`),
        ),
      ),
    );
    const body = lines.filter((line) => line && !line.startsWith("── "));
    expect(body.length).toBeGreaterThan(20);
    for (const line of body) {
      const match = [...rows].find((row) => {
        const [keys, action] = row.split("|") as [string, string];
        return (
          line.startsWith(keys) &&
          line.endsWith(action) &&
          line.slice(keys.length, line.length - action.length).trim() === ""
        );
      });
      expect(match, line).toBeDefined();
    }
    for (const sections of Object.values(KEYS) as readonly KeySection[][])
      for (const section of sections)
        for (const [keys, action] of section.rows)
          expect(
            body.some((line) => line.startsWith(keys) && line.endsWith(action)),
            `${keys} ${action}`,
          ).toBe(true);
  });

  test("an unknown topic names the nearest one", () => {
    expect(topicMiss("vocie")).toBe(
      "no topic vocie · did you mean voice · /help",
    );
    // Nothing near: no wild guess, only the way back.
    expect(topicMiss("nonsense")).toBe("no topic nonsense · /help");
  });

  test("typos get the nearest command", () => {
    expect(nearestCommand("/clik on")).toBe("/click");
    expect(nearestCommand("/patern")).toBe("/pattern");
    expect(nearestCommand("/fx delay on")).toBe("fx");
    expect(nearestCommand("/chrods")).toBe("/chords");
    expect(nearestCommand("/zzzzzzz")).toBeUndefined();
  });

  test("an adjacent swap is one edit, even in short words", () => {
    expect(nearestCommand("/hlep")).toBe("/help");
    expect(nearestCommand("/meun")).toBe("/menu");
    expect(nearestCommand("/plya")).toBe("/play");
    expect(nearestCommand("/sesions")).toBe("/sessions");
    expect(editDistance("hlep", "help")).toBe(1);
    expect(editDistance("ca", "abc")).toBe(3);
  });

  test("property: editDistance is a symmetric, bounded edit count", () => {
    let state = 0x5eed;
    const next = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 4294967296;
    };
    const word = () =>
      Array.from(
        { length: Math.floor(next() * 7) },
        () => "abcde"[Math.floor(next() * 5)],
      ).join("");
    for (let run = 0; run < 2000; run += 1) {
      const a = word();
      const b = word();
      const d = editDistance(a, b);
      expect(d).toBe(editDistance(b, a));
      expect(d === 0).toBe(a === b);
      expect(d).toBeGreaterThanOrEqual(Math.abs(a.length - b.length));
      expect(d).toBeLessThanOrEqual(Math.max(a.length, b.length));
      if (a.length >= 2) {
        const i = Math.floor(next() * (a.length - 1));
        const swapped = `${a.slice(0, i)}${a[i + 1]}${a[i]}${a.slice(i + 2)}`;
        expect(editDistance(a, swapped)).toBe(swapped === a ? 0 : 1);
      }
    }
  });
});

test("a sentence starting with a command verb is a request, not a usage error", () => {
  for (const text of [
    "add a walking bass in A minor",
    "pan the hats left",
    "remove the busy hats",
  ]) {
    expect(looksLikeProse(text)).toBe(true);
    expect(usageHint(text)).toBeUndefined();
  }
  for (const text of ["pan 3", "add H4 at 0", "volume loud", "/export"])
    expect(looksLikeProse(text)).toBe(false);
  expect(usageHint("pan 3")).toBe("pan takes -1…1 · pan -0.5");
  expect(usageHint("/export")).toBeDefined();
});

test("a one-letter slip on a command whose arguments parse is suggested", () => {
  const parses = (text: string) => /^(tempo \d+|pan -?[\d.]+)$/.test(text);
  expect(typoFix("tempoo 90", parses)).toBe("tempo 90");
  expect(typoFix("pann -0.5", parses)).toBe("pan -0.5");
  // Prose after a near-verb, slash words and far words still go on.
  expect(typoFix("tempoo the song up", parses)).toBeUndefined();
  expect(typoFix("/tempoo 90", parses)).toBeUndefined();
  expect(typoFix("tmpooo 90", parses)).toBeUndefined();
  expect(typoFix("tempo 90", parses)).toBeUndefined();
});

test("grain is a known verb: a slip suggests it and usage names it", () => {
  const parses = (text: string) => /^grain \S+/.test(text);
  expect(typoFix("graen cloud", parses)).toBe("grain cloud");
  expect(usageHint("grain")).toContain("grain cloud");
});

// Every /help example running bare and slashed, window verbs included, is
// checked in test/consistency.test.ts ("help and usage examples parse bare
// and slashed"), which has no known gaps.

test("no help row uses a glossary loser except in alias notes", () => {
  expect(lintText(helpText())).toEqual([]);
  expect(lintText(keysLines(72).join("\n"))).toEqual([]);
  // Usage hints show on every miss, so they speak the glossary too.
  expect(lintText(Object.values(USAGE).join("\n"))).toEqual([]);
  expect(USAGE.instrument!.match(/\bsaw(tooth)?\b/g)).toEqual(["sawtooth"]);
});

test("/help login opens model key and never shows login", () => {
  const lines = helpTopicLines("login")!;
  expect(lines[0]).toBe("── model key");
  expect(lines.join("\n")).not.toMatch(/\blogin\b/);
  expect(helpTitle("login")).toBe("help · model key");
});

test("/help <command> does not repeat its usage line", () => {
  for (const name of ["scale", "model key", "vocoder"]) {
    const lines = helpTopicLines(name)!.filter((line) => line.trim());
    expect(new Set(lines).size, name).toBe(lines.length);
  }
  const scale = helpTopicLines("scale")!.join("\n");
  expect(scale.match(/scale D hijaz/g)).toHaveLength(1);
});

describe("/help arrange and /help panes (op1-ux lane E)", () => {
  const score = createScore({
    bars: 16,
    tracks: [
      { id: "main", instrument: "saw" },
      { id: "bass", instrument: "saw" },
    ],
    sections: [
      { name: "verse", startBar: 1, bars: 8 },
      { name: "chorus", startBar: 9, bars: 8 },
    ],
  } as Parameters<typeof createScore>[0]);

  test("arrange is one screen around the range verbs; first line fits 80", () => {
    const lines = helpTopicLines("arrange", 80)!;
    expect(lines.length).toBeLessThanOrEqual(14);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.some((line) => line.includes("…"))).toBe(false);
    const body = lines.slice(1).join("\n");
    for (const verb of ["loop 5-6", "copy bass 5-6 to 7", "move bass", "paste"])
      expect(body).toContain(verb);
  });

  test("every arrange row is a line the prompt runs", () => {
    // Window lines the consistency gate covers (test/consistency.test.ts).
    const window = new Set(["ctrl-t", "tape", "style deep-house 16"]);
    for (const entry of ARRANGE_PAGE.entries)
      for (const line of entry.command.split(" · ")) {
        if (window.has(line)) continue;
        expect(commandParses(line, score), line).toBe(true);
      }
  });

  test("panes lists pane, pin and follow and points at the guide", () => {
    const lines = helpTopicLines("panes", 80)!;
    expect(lines[0]).toBe("── panes");
    expect(lines.length).toBeLessThanOrEqual(14);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    const text = lines.join("\n");
    for (const word of ["pane <screen>", "pin · unpin", "follow"])
      expect(text).toContain(word);
    expect(lines.at(-1)).toContain("guide panes");
    expect(helpTopicLines("pane", 80)).toEqual(lines);
  });
});

describe("help group marks", () => {
  test("each heading takes the guides' mark for its kind", () => {
    const lines = helpTopicLines(undefined)!;
    const marks = helpHeadingMarks(lines);
    const at = (heading: string) => marks[lines.indexOf(`── ${heading}`)];
    expect(at("start here")?.mark).toBe("›");
    expect(at("topics · help <topic>")?.mark).toBe("→");
    for (const [index, line] of lines.entries())
      expect(marks[index] !== undefined).toBe(line.startsWith("── "));
  });

  test("help all: commands ›, agent ✦, then every key list ⌃", () => {
    const lines = helpTopicLines("all")!;
    const marks = helpHeadingMarks(lines);
    const keys = lines.indexOf("── keys");
    expect(keys).toBeGreaterThan(0);
    lines.forEach((line, index) => {
      if (!line.startsWith("── ")) return;
      const group = line.slice(3);
      const want = index >= keys ? "⌃" : group.startsWith("agent") ? "✦" : "›";
      expect(`${marks[index]?.mark} ${group}`).toBe(`${want} ${group}`);
    });
    // Never a knob color: the roles come from the guides' table.
    const roles = new Set(marks.filter(Boolean).map((mark) => mark!.role));
    for (const role of roles) expect(role).not.toMatch(/^knob/);
  });
});
