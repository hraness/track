/**
 * The guides are user docs in two places (the `/guide` pane and dawg.sh), so
 * each one must parse, fit one pane at 80 columns, and name only commands
 * that exist.
 */
import { describe, expect, test } from "bun:test";
import { HELP_SECTIONS, USAGE } from "../src/commands/help.ts";
import { guideLines, paginate, wrapRows } from "../tui/guide.ts";
import { TOPICS, TOPIC_ALIASES, lintText } from "../src/lang/glossary.ts";
import { GuideBrowser } from "../tui/guide.ts";
import { listGuides } from "./index.ts";

/** Rows a guide may take in the pane (80×24 leaves about 20 inside). */
/** The guide pane's rows inside an 80x24 terminal (docs/screens/guide). */
const PAGE_ROWS = 16;
/** Short guides: a topic that needs more pages wants splitting. */
const MAX_PAGES = 3;
/** The pane's text width at 80 columns: 80 − margins − border − padding. */
const WIDTH = 72;

const guides = listGuides();

/** Every slash word the app accepts, from the help reference and usages. */
const KNOWN = new Set(
  [
    ...HELP_SECTIONS.flatMap((section) =>
      section.entries.map((entry) => entry.command),
    ),
    ...Object.values(USAGE),
  ].flatMap((text) => text.match(/\/[a-z][a-z-]*/g) ?? []),
);

describe("guides", () => {
  test("there are guides, with unique ids and real parents", () => {
    expect(guides.length).toBeGreaterThanOrEqual(15);
    const ids = guides.map((guide) => guide.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const guide of guides)
      if (guide.parent) expect(ids).toContain(guide.parent);
  });

  test("tree order puts each parent before its children", () => {
    const seen = new Set<string>();
    for (const guide of guides) {
      if (guide.parent) expect(seen.has(guide.parent)).toBe(true);
      seen.add(guide.id);
    }
  });

  test("no two siblings share an order", () => {
    const pairs = guides.map((guide) => `${guide.parent ?? ""}:${guide.order}`);
    const dupes = pairs.filter((pair, index) => pairs.indexOf(pair) !== index);
    expect(dupes).toEqual([]);
  });

  test("no source line runs past 72 columns", () => {
    const long = guides.flatMap((guide) =>
      guide.body
        .split("\n")
        .filter((line) => [...line].length > WIDTH)
        .map((line) => `${guide.id}: ${line}`),
    );
    expect(long).toEqual([]);
  });

  test("the voice guide shows lyrics, sing and Ctrl-K › Voice", () => {
    const voice = guides.find((guide) => guide.id === "voice")!.body;
    expect(voice).toContain("`lyrics ");
    expect(voice).toContain("`sing ");
    expect(voice).toContain("Ctrl-K › Voice");
  });

  test("hints name play mode, never a bare Ctrl-P play", () => {
    for (const guide of guides)
      expect(guide.body).not.toMatch(/Ctrl-P play(?! mode)/i);
  });

  for (const guide of guides)
    test(`${guide.id} pages fit an 80x24 terminal`, () => {
      const pages = paginate(
        wrapRows(guideLines(guide.body), WIDTH),
        PAGE_ROWS,
      );
      for (const page of pages)
        expect(page.length).toBeLessThanOrEqual(PAGE_ROWS);
      expect(pages.length).toBeLessThanOrEqual(MAX_PAGES);
      expect(guide.body).not.toMatch(/^# /m);
    });

  test("every /command a guide names exists", () => {
    const unknown: string[] = [];
    for (const guide of guides)
      for (const span of guide.body.match(/`[^`]+`/g) ?? [])
        for (const word of span.match(/(?<![\w.>/])\/[a-z][a-z-]*/g) ?? [])
          if (!KNOWN.has(word)) unknown.push(`${guide.id}: ${word}`);
    expect(unknown).toEqual([]);
  });

  test("/guide opens every topic id and alias", () => {
    for (const word of [...TOPICS, ...Object.keys(TOPIC_ALIASES)]) {
      const browser = new GuideBrowser(guides);
      expect(browser.open(word)).toBe(true);
      expect(browser.page).toBeDefined();
    }
    const browser = new GuideBrowser(guides);
    expect(browser.open("scale") && browser.page).toBe("chords");
    expect(browser.open("tuning") && browser.page).toBe("tuning");
    expect(browser.open("expression") && browser.page).toBe("performance");
    expect(browser.open("nonsense")).toBe(false);
  });

  test("every topic id has a guide", () => {
    const ids = new Set(guides.map((guide) => guide.id));
    for (const topic of TOPICS) expect(ids.has(topic)).toBe(true);
  });

  // One template: Ask / Type it yourself / Menu / Keys / Next, in that
  // order, with Mouse or Try allowed in between.
  const TEMPLATE = ["Ask", "Type it yourself", "Menu", "Keys", "Next"];
  for (const guide of guides)
    test(`${guide.id} follows the template`, () => {
      const headings = [...guide.body.matchAll(/^## (.+)$/gm)].map(
        (match) => match[1]!,
      );
      expect(headings.filter((h) => TEMPLATE.includes(h))).toEqual(TEMPLATE);
      for (const heading of headings)
        expect([...TEMPLATE, "Mouse", "Try"]).toContain(heading);
    });

  test("every Ctrl-K path names real menu labels (design §4a)", () => {
    const bad: string[] = [];
    for (const guide of guides)
      for (const line of guide.body.split("\n"))
        for (const crumb of line.split(/(?=Ctrl-K ›)/).slice(1)) {
          const path = crumb
            .replace(/^Ctrl-K › /, "")
            .split(/[:(]/)[0]!
            .replace(/\s*·\s*$/, "")
            .trim();
          if (!menuPathOk(path)) bad.push(`${guide.id}: ${crumb.trim()}`);
        }
    expect(bad).toEqual([]);
  });

  test("no retired word or British spelling outside alias notes", () => {
    const hits = guides.flatMap((guide) =>
      lintText(guide.body).map((hit) => `${guide.id}: ${hit}`),
    );
    expect(hits).toEqual([]);
  });
});

/**
 * The ctrl-k labels from design §4a. Lane E replaces this with menuPath once
 * the menu lane lands, so breadcrumbs come from the live tree.
 */
type MenuNode = { readonly [label: string]: MenuNode };
const LEAF: MenuNode = {};
const leaves = (...labels: string[]): MenuNode =>
  Object.fromEntries(labels.map((label) => [label, LEAF]));
const MENU: MenuNode = {
  Sound: {
    ...leaves(
      "instrument",
      "preset",
      "advanced",
      "synth filter",
      "keys",
      "organ",
      "guitar",
      "granular",
      "track tuning",
      "performance",
    ),
    instruments: {
      Keys: leaves("Electric", "Organs"),
      Strings: leaves("Bowed"),
      ...leaves(
        "Mallets and bells",
        "Winds and brass",
        "Granular",
        "Wavetable",
        "all instruments",
        "sample packs",
        "use a sample",
      ),
    },
  },
  Voice: leaves(
    "sing",
    "lyrics",
    "clips",
    "pitch",
    "autotune",
    "formant",
    "vocoder",
    "voice presets",
  ),
  Effects: leaves(
    "Filter",
    "Auto filter",
    "Distortion",
    "Tremolo",
    "Compressor",
    "Chorus",
    "Delay",
    "Reverb",
    "Guitar rig",
    "Shoegaze",
    "more effects",
  ),
  Rhythm: leaves("euclid editor", "grooves", "kits", "grid"),
  "Chords and key": leaves("key", "tuning", "play", "progression", "idiom"),
  Mix: leaves(
    "name",
    "mute",
    "solo",
    "volume",
    "pan",
    "all tracks",
    "automation",
    "master",
  ),
  Arrange: leaves("tracks", "sections", "form", "style"),
  Project: {
    ...leaves(
      "play",
      "tempo",
      "beats per bar",
      "tempo and meter",
      "loop length",
      "grid",
      "click",
      "count-in bars",
      "calibration",
      "export",
      "resample",
    ),
    session: leaves("rename", "fork", "resume"),
    media: leaves("chop", "chop help"),
    agent: leaves("model", "show-me", "model key"),
    audio: leaves("output", "input", "test"),
    "help and guides": leaves("help", "guides", "keys"),
  },
};

/** `A › b › c · d`: each step is a child of the one before; `·` siblings. */
function menuPathOk(path: string): boolean {
  const steps = path.split(" › ");
  let node = MENU;
  for (const [index, step] of steps.entries()) {
    const names = index === steps.length - 1 ? step.split(" · ") : [step];
    for (const name of names) if (!(name.trim() in node)) return false;
    node = node[names[0]!.trim()]!;
  }
  return true;
}
