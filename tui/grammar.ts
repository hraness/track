/**
 * The shared key grammar: one vocabulary for every picker, editor and menu,
 * the one-line footer hint each screen shows, and the `?` panel listing the
 * keys of the current screen.
 *
 *   ↑↓ (j k)        move              Enter   open or confirm
 *   ←→ (h l, - +)   adjust a value    Space   audition or toggle
 *   /               filter            Esc     back one level (filter first)
 *   ?               keys for this screen
 *   digits          type a value, only where a value is focused
 *
 * Play mode is the one exception (its letters are piano keys, by the
 * GarageBand "Musical Typing" convention); its panel says so.
 */
import { displayWidth } from "./text.ts";

// ── key sets: the one definition every screen imports ─────────────────

type Keys = ReadonlySet<string>;
const keys = (...values: string[]): Keys => Object.freeze(new Set(values));

/** The raw arrow sequences, for code that synthesizes a key press. */
export const ARROW_UP = "\u001b[A";
export const ARROW_DOWN = "\u001b[B";
/** ↑ k: move up (a row, a voice, a param). */
export const KEY_UP = keys(ARROW_UP, "\u001bOA", "k");
/** ↓ j: move down. */
export const KEY_DOWN = keys(ARROW_DOWN, "\u001bOB", "j");
/** ← h - _: back on a row that is not a value; adjust down on a value. */
export const KEY_LEFT = keys("\u001b[D", "\u001bOD", "h", "-", "_");
/** → l + =: go in or apply; adjust up on a value. */
export const KEY_RIGHT = keys("\u001b[C", "\u001bOC", "l", "+", "=");
/** ← h only: the keys that go back from a row that is not a value. */
export const KEY_BACK = keys("\u001b[D", "\u001bOD", "h");
/** → l only: the keys that go into a row that is not a value. */
export const KEY_FORWARD = keys("\u001b[C", "\u001bOC", "l");
/** Tab: the next field (fader, rhythm editor, forms). */
export const KEY_TAB = keys("\t");
/** Shift-tab: the previous field. */
export const KEY_BACKTAB = keys("\u001b[Z");
/** Enter: open or confirm, everywhere. */
export const KEY_ENTER = keys("\r", "\n");
export const KEY_BACKSPACE = keys("\u007f", "\b");
/** x d Delete: reset a value (delete an automation point, turn a row off). */
export const KEY_RESET = keys("x", "d", "\u001b[3~");
/** Shift-← → { }: a coarse step. */
export const KEY_COARSE_LEFT = keys("\u001b[1;2D", "{");
export const KEY_COARSE_RIGHT = keys("\u001b[1;2C", "}");
/** [ ] alt-← →: a fine step (skips detents). */
export const KEY_FINE_LEFT = keys("\u001b[1;3D", "\u001b[1;5D", "\u001bb", "[");
export const KEY_FINE_RIGHT = keys(
  "\u001b[1;3C",
  "\u001b[1;5C",
  "\u001bf",
  "]",
);
export const KEY_PAGE_UP = keys("\u001b[5~");
export const KEY_PAGE_DOWN = keys("\u001b[6~");
export const KEY_HOME = keys("\u001b[H", "\u001bOH", "\u001b[1~");
export const KEY_END = keys("\u001b[F", "\u001bOF", "\u001b[4~");
export const KEY_ESC = "\u001b";

/** A `key  action` pair for the `?` panel. */
export type KeyRow = readonly [keys: string, action: string];
export type KeySection = Readonly<{ title: string; rows: readonly KeyRow[] }>;

/**
 * Fit a ` a · b · esc back · ? keys ` hint into `width` columns by dropping
 * parts from the middle: the way out (`esc …`) and `? keys` stay longest,
 * since they are how a user leaves or learns the rest. Returns "" when not
 * even `? keys` fits.
 */
export function fitHint(hint: string, width: number): string {
  const key = `${width}\u0000${hint}`;
  const cached = fitted.get(key);
  if (cached !== undefined) return cached;
  const text = fitHintUncached(hint, width);
  if (fitted.size > 256) fitted.clear();
  fitted.set(key, text);
  return text;
}

/** Hints repeat every frame; fit each (hint, width) once. */
const fitted = new Map<string, string>();

function fitHintUncached(hint: string, width: number): string {
  const parts = hint
    .trim()
    .split(" · ")
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  const tailAt = parts.findIndex(
    (part) => part.startsWith("esc ") || part.startsWith("? "),
  );
  const head = tailAt < 0 ? parts.slice(0, -1) : parts.slice(0, tailAt);
  const tail = tailAt < 0 ? parts.slice(-1) : parts.slice(tailAt);
  for (;;) {
    const text = ` ${[...head, ...tail].join(" · ")} `;
    if (displayWidth(text) <= width) return text;
    if (head.length > 0) head.pop();
    else if (tail.length > 1) tail.shift();
    else return "";
  }
}

/** The ASCII spelling of a hint, for terminals without Unicode arrows. */
export function asciiHint(hint: string): string {
  return hint
    .replace(/↑↓/g, "up/dn")
    .replace(/←→/g, "lt/rt")
    .replace(/–/g, "-");
}

// ── footer hints, one per screen ──────────────────────────────────────

export const HINTS = {
  list: " ↑↓ move · enter choose · / filter · esc back · ? keys ",
  preview: " ↑↓ preview · enter apply · / filter · esc back · ? keys ",
  hover: " ↑↓ hear · enter choose · a A/B · c context · esc back · ? keys ",
  audition:
    " ↑↓ hear · enter keep · space loop · a A/B · c mix · / filter · esc back · ? keys ",
  filtering: " type to filter · enter choose · esc clear · ? keys ",
  menu: " ↑↓ move · enter open · / filter · esc back · ? keys ",
  value: " ←→ adjust · enter open · 0-9 type · x reset · esc back · ? keys ",
  point: " ←→ adjust · enter type · x delete · esc back · ? keys ",
  action: " ↑↓ move · enter apply · / filter · esc back · ? keys ",
  typing: " type a value · enter apply · esc clear ",
  euclid:
    " ↑↓ knob · ←→ turn · tab field · space loop · x off · esc back · ? keys ",
  text: " ↑↓ scroll · pgup pgdn page · esc back · ? keys ",
  log: " ↑↓ scroll · / filter · esc back · ? keys ",
  keys: " esc or ? closes ",
} as const;

// ── the `?` panel ─────────────────────────────────────────────────────
//
// Each screen lists every key once: a key that means different things on
// different rows says so on its one line.

/** The audition loop's keys, shared by the menu and the rhythm editor. */
const AUDITION_ROWS: readonly KeyRow[] = [
  ["space", "loop the track · again stops"],
  ["a", "A/B: committed ↔ staged"],
  ["c", "solo ↔ in context (the whole mix)"],
  ["ctrl-z", "undo a kept change"],
];

/** The ctrl-k menu roots, in order (src/tui/menu.ts builds them). */
export const MENU_ROOTS = Object.freeze([
  "Sound",
  "Voice",
  "Effects",
  "Rhythm",
  "Chords and key",
  "Mix",
  "Arrange",
  "Project",
]);

/** Keys that close the `?` panel; every other key is ignored while open. */
export function closesKeys(value: string): boolean {
  return value === KEY_ESC || value === "?";
}

const LIST: readonly KeyRow[] = [
  ["↑ ↓  j k", "move"],
  ["pgup pgdn", "page"],
  ["enter", "choose"],
  ["/", "filter (type, then enter or esc)"],
  ["esc", "clear the filter, then back"],
];

export const KEYS = {
  prompt: [
    {
      title: "start here",
      rows: [
        ["type", "ask in plain words, or type a command"],
        ["ctrl-p", "play mode: notes on the keyboard (chords: q)"],
        ["ctrl-k", `menu: ${MENU_ROOTS.length} sections · /menu <topic>`],
        ["space", "play / pause (empty prompt)"],
        ["/help", "what dawg can do · /help <topic> for more"],
      ],
    },
    {
      title: "prompt",
      rows: [
        ["enter", "send"],
        ["shift-enter ctrl-j", "new line"],
        ["alt-enter", "send next, after the current request"],
        ["ctrl-q", "switch now/next (what enter does)"],
        ["ctrl-z ctrl-y", "undo / redo"],
        ["ctrl-o", "transcript"],
        ["esc", "cancel the agent · back from a panel"],
        ["ctrl-c", "quit"],
      ],
    },
    {
      title: "mouse",
      rows: [
        ["click ▶/⏸ BPM", "play / pause"],
        ["click track name", "track list (click one to focus it)"],
        ["click model", "model picker"],
        ["click volume · fx filter", "a bare param opens its fader drawer"],
      ],
    },
  ],
  list: [{ title: "list", rows: LIST }],
  audition: [
    {
      title: "auditioning list",
      rows: [
        ["space", "loop the focused track · again stops"],
        ["↑ ↓  j k", "move; while looping, hear the row on the loop"],
        ["a", "A/B: before ↔ the highlighted row"],
        ["c", "solo ↔ in context (the whole mix)"],
        ["enter", "keep it (one undo step)"],
        ["esc", "back; nothing changes"],
        ["/", "filter (type, then enter or esc)"],
      ],
    },
  ],
  presets: [
    {
      title: "preset browser",
      rows: [
        ["↑ ↓", "move; each preset plays a short phrase"],
        ["type", "search every preset by name, tag or knob (fuzzy)"],
        ["enter", "open a category · keep the preset (one undo)"],
        ["→", "presets like the highlighted one"],
        ["←", "back to the categories"],
        ["*", "star / unstar · starred is a category"],
        ["space", "loop the focused track · moving hears it in the mix"],
        ["esc", "clear the search, then revert and close"],
      ],
    },
  ],
  preview: [
    {
      title: "patterns",
      rows: [
        ["↑ ↓  j k", "move and hear the pattern"],
        ["enter", "apply it to the focused track"],
        ...LIST.slice(3),
      ],
    },
  ],
  menu: [
    {
      title: "menu",
      rows: [
        ["↑ ↓  j k", "move"],
        [
          "enter",
          "open · run · value: fader or list · staged: keep (one undo)",
        ],
        ["→ l", "go in · run an action · on a value: adjust up"],
        ["← h", "back one level · on a value: adjust down"],
        ["- +", "adjust a value"],
        ["esc", "revert staged changes, else back (a filter clears first)"],
        ["/", "filter this level"],
        ["0-9 .", "type a value, enter applies"],
        ["x d delete", "reset to default (deletes an automation point)"],
        ...AUDITION_ROWS,
      ],
    },
    {
      title: "mouse",
      rows: [
        ["click", "select a row · click again opens it"],
        ["wheel", "move through the list"],
      ],
    },
  ],
  fader: [
    {
      title: "fader drawer",
      rows: [
        ["← →  h l  - +", "step (tempo, meter, bars apply at once)"],
        ["shift-← shift-→  { }", "coarse step (five)"],
        ["[ ]  alt-← alt-→", "fine step (a tenth; skips detents)"],
        ["pgup pgdn", "big step (twenty)"],
        ["home end", "minimum / maximum"],
        ["0-9 .", "type an exact value, enter sets it"],
        ["x d delete", "back to the default"],
        ["↑ ↓  j k  tab shift-tab", "previous / next param of this device"],
        ["enter", "keep every staged change (one undo)"],
        ["esc", "revert and close"],
        ...AUDITION_ROWS,
      ],
    },
    {
      title: "mouse",
      rows: [
        ["click [−] [+]", "step (shift-click: coarse)"],
        ["click or drag the bar", "set the value there"],
        ["wheel on a fader", "step it (shift: coarse)"],
        ["click an option", "choose it"],
        ["click enter keep · esc revert", "same as the keys"],
      ],
    },
  ],
  euclid: [
    {
      title: "rhythm editor",
      rows: [
        ["↑ ↓  j k", "knob: ● drum ▲ pulses ■ rotate ◆ velocity"],
        ["← →  h l  - +", "turn it (● picks the drum row)"],
        ["tab shift-tab  ] [", "next / previous field, every field"],
        ["0-9", "type a value, enter applies"],
        ["enter", "add a row (or type a value) · staged: keep"],
        ["x d delete", "turn the row off"],
        ["f", "freeze into plain hits"],
        ["esc", "revert staged changes, else back"],
        ...AUDITION_ROWS,
      ],
    },
  ],
  text: [
    {
      title: "panel",
      // No j k: the prompt stays live under a panel, so letters type there.
      rows: [
        ["↑ ↓", "scroll"],
        ["pgup pgdn home end", "page"],
        ["esc", "close"],
      ],
    },
  ],
  guide: [
    {
      title: "guides",
      rows: [
        ["↑ ↓  j k", "move · scroll a guide"],
        ["→ l enter", "expand a section, then open the guide"],
        ["← h", "collapse · go to the parent · back from a guide"],
        ["/", "filter by title and text (enter opens)"],
        ["esc", "clear the filter, then back, then close"],
        ["f1", "open or close the guides"],
      ],
    },
  ],
  log: [
    {
      title: "transcript",
      rows: [
        ["↑ ↓", "scroll"],
        ["pgup pgdn home end", "page"],
        ["/", "next filter: all, requests, ops, errors"],
        ["esc ctrl-o", "close"],
      ],
    },
  ],
  play: [
    {
      title: "play mode · letters are piano keys",
      rows: [
        ["a s d f g h j k l ; '", "white keys"],
        ["w e t y u o p", "black keys"],
        ["z x", "octave down / up"],
        ["c v", "velocity down / up"],
        ["shift", "sustain while held"],
        ["tab", "sustain latch (play mode only)"],
        ["space", "play / pause (with count-in)"],
        ["r R", "record · replace · keys record (a pass an undo)"],
        ["m", "metronome click"],
        ["i", "scale degrees ⇄ chromatic (home row in key)"],
        [", .", "previous / next preset (preset prev, preset next)"],
        ["q", "chord mode: auto ⇄ manual"],
        ["/", "type a command, still in play mode"],
        ["ctrl-k", "menu"],
        ["esc", "leave play mode"],
      ],
    },
  ],
  tape: [
    {
      title: "tape · every track across the bars (each key echoes its command)",
      rows: [
        ["space", "play / pause from the playhead"],
        ["↑ ↓", "pick a knob: ● playhead ▲ loop ■ tempo ◆ volume"],
        ["← → ⇧", "turn it (⇧ coarse) · jump 5.3 · loop 5-7 · tempo 96"],
        [", .", "previous / next section · jump chorus"],
        ["< >", "slide the loop by its length · loop 7-8"],
        ["[ ]", "loop end a bar shorter / longer · loop 5-7"],
        ["{ }", "loop start a bar earlier / later · loop 4-7"],
        ["\\", "loop the section here; again: off · loop chorus"],
        ["1-9 tab", "focus a track row; tab: the next · track drums"],
        ["c C", "copy the range (track / all) · copy bass 5-6"],
        ["x X", "cut: copy, then clear · clear bass 5-6"],
        ["v V", "paste at the playhead (V inserts) · copy bass 5-6 to 7"],
        ["delete", "clear the range · clear bass 5-6"],
        ["~", "reverse the range · reverse bass 5-6"],
        ["s S", "split / join the section here · section split verse at 3"],
        ["h H", "mute / solo the track · mute bass · solo"],
        ["r R", "record the loop in play, a pass an undo · keys record"],
        ["m b", "click · stop"],
        ["- =", "zoom out / in (bar, beat, half beat a cell)"],
        ["enter", "the knob big in the drawer (reset there: x)"],
        ["/", "type a command, staying on tape"],
        ["esc ctrl-t", "back home · tape"],
      ],
    },
  ],
  patch: [
    {
      title: "patch · nodes, ports, cables (each key echoes its command)",
      rows: [
        ["↑ ↓", "move in the focused pane"],
        ["tab ⇧tab", "next pane: nodes · ports · cables · knobs"],
        ["← → ⇧", "nodes ⇄ ports · across cables · turn a knob (⇧ coarse)"],
        ["enter", "node: its settings · cell: patch wire / unwire"],
        ["[ ] { }", "cable amount −/+ 5 % (⇧ 25 %) · patch wire a b 0.6"],
        ["1-9 0", "cable amount 10-90 % · 100 %"],
        ["a", "add a node · patch add lfo"],
        ["w", "wire to a legal input · patch wire env.out vcf.cutoff"],
        ["x", "remove the cable or node · patch unwire · patch rm"],
        ["m", "map the param to a knob · patch macro"],
        ["g", "run the node per voice or once · patch rate lfo global"],
        ["f", "the whole cable matrix / the node's neighbourhood"],
        ["s", "save to the library · patch save acid-bass"],
        ["space", "audition loop (the track solo)"],
        ["/", "type a command, staying here"],
        ["esc", "back home · patch off"],
      ],
    },
  ],
  chords: [
    {
      title: "chord mode · number row latches",
      rows: [
        ["1 2 3 4", "dim · min · maj · sus (two combine)"],
        ["5 6 7 8", "add 6 · m7 · M7 · 9"],
        ["0", "clear the latches"],
        ["- =", "voicing down / up"],
        ["9", "next perform mode (block, strum, arp…)"],
        ["b", "next bass mode"],
        ["n", "play the suggested next chord"],
      ],
    },
  ],
} satisfies Record<string, readonly KeySection[]>;

export type KeyScreen = keyof typeof KEYS;

/** `?` panel lines: a heading per section, then aligned `keys  action`. */
export function keyLines(sections: readonly KeySection[]): string[] {
  const column =
    Math.max(
      0,
      ...sections.flatMap((section) =>
        section.rows.map(([keys]) => displayWidth(keys)),
      ),
    ) + 2;
  const lines: string[] = [];
  for (const section of sections) {
    if (lines.length) lines.push("");
    lines.push(`── ${section.title}`);
    for (const [keys, action] of section.rows)
      lines.push(
        `${keys}${" ".repeat(Math.max(1, column - displayWidth(keys)))}${action}`,
      );
  }
  return lines;
}
