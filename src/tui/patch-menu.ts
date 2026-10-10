/**
 * Ctrl-k rows for patches (patcher design §7.4): Sound › patch on every
 * melodic or patch track, and one Effects › "<name> patch" group per effect
 * patch. Every row runs a typed command: `/patch` opens the patch view, a
 * node's number rows run `patch set <id> k=v`, the knobs run
 * `patch knob <macro> <value>`, and `--fx <name>` aims each at an effect
 * patch. The patch view's enter on a node opens its group here in the
 * fader drawer, so the drawer's keys, staging and keep/revert all apply.
 * Below them sit the lane 5 rows (new, load, convert, add node, wire, …),
 * each an entry that runs one typed `patch …` line, and Effects › add
 * effect patch.
 */
import type { NumberParam } from "../../core/params.ts";
import {
  isPatchRef,
  macroAt,
  macroPosition,
  PATCH_INSTRUMENT,
  patchSpecs,
  resolvePatch,
  type Macro,
  type Patch,
} from "../../core/patch.ts";
import { BUILTIN_PATCH_NAMES } from "../../core/patches/index.ts";
import type { Track, TrackScore } from "../../core/score.ts";
import { parsePatchCommand } from "../commands/patch.ts";
import { num, specStep, type MenuContext, type MenuNode } from "./menu.ts";

/** ` --fx <name>` for an effect patch, empty for the instrument patch. */
export function fxSuffix(fx: string | undefined): string {
  return fx === undefined ? "" : ` --fx ${fx}`;
}

/** The track's instrument patch (resolved through the library) or effect patch. */
export function trackPatch(
  score: TrackScore,
  track: Track,
  fx?: string,
): Patch | undefined {
  if (fx !== undefined) return track.fxPatch?.find((p) => p.name === fx);
  if (track.instrument !== PATCH_INSTRUMENT || !track.patch) return undefined;
  return resolvePatch(track.patch, score.patches);
}

/** A macro's value on this track: the ref's own setting, else its default. */
export function macroValue(track: Track, macro: Macro, fx?: string): number {
  const value =
    fx === undefined && track.patch && isPatchRef(track.patch)
      ? track.patch.macros?.[macro.id]
      : undefined;
  return value ?? macro.default;
}

/** A macro nudged along its knob travel (exp macros move by ratio). */
export function macroStep(
  macro: Macro,
): (value: number, direction: 1 | -1) => number {
  return (value, direction) => {
    const position = Math.min(
      1,
      Math.max(0, macroPosition(macro, value) + direction * 0.02),
    );
    return Number(macroAt(macro, position).toPrecision(4));
  };
}

/** One row per macro (in knob order): `patch knob <id> <value>`. */
export function macroNodes(
  track: Track,
  patch: Patch,
  fx?: string,
): MenuNode[] {
  return patch.macros.map((macro, index) => ({
    kind: "number",
    label: macro.label ?? macro.id,
    value: macroValue(track, macro, fx),
    min: Math.min(macro.min, macro.max),
    max: Math.max(macro.min, macro.max),
    step: macroStep(macro),
    format: (v) => num(v),
    command: (v) => `patch knob ${macro.id} ${num(v)}${fxSuffix(fx)}`,
    reset: `patch knob ${macro.id} ${num(macro.default)}${fxSuffix(fx)}`,
    help: `${index < 4 ? `knob ${index + 1} · ` : ""}${macro.to.map((t) => t.port).join(", ") || "no targets"} · x resets`,
  }));
}

/** A node's static settings: numbers and choices, each `patch set`. */
export function nodeParamNodes(
  patch: Patch,
  nodeId: string,
  fx?: string,
  library: Readonly<Record<string, Patch>> = {},
): MenuNode[] {
  const node = patch.nodes.find((n) => n.id === nodeId);
  const spec = patchSpecs(patch, library).get(nodeId);
  if (!node || !spec) return [];
  const rows: MenuNode[] = [];
  for (const [name, param] of Object.entries(spec.params)) {
    const value = node.params?.[name];
    const set = (text: string) =>
      `patch set ${nodeId} ${name}=${text}${fxSuffix(fx)}`;
    if (param.kind === "number") {
      const p: NumberParam = param;
      rows.push({
        kind: "number",
        label: name,
        value: typeof value === "number" ? value : p.default,
        min: p.min,
        max: p.max,
        step: specStep(p),
        format: (v) => (p.unit ? `${num(v)} ${p.unit}` : num(v)),
        command: (v) => set(num(v)),
        reset: set(num(p.default)),
        help: `${p.doc} · default ${num(p.default)} · x resets`,
      });
    } else if (param.kind === "enum")
      rows.push({
        kind: "choice",
        label: name,
        value: typeof value === "string" ? value : param.default,
        options: param.values,
        command: (option) => set(option),
        help: param.doc,
      });
    else
      rows.push({
        kind: "toggle",
        label: name,
        value: typeof value === "boolean" ? value : param.default,
        command: (on) => set(on ? "on" : "off"),
        help: param.doc,
      });
  }
  return rows;
}

/** The menu id of a node's group (the patch view's enter opens it). */
export function nodeMenuId(nodeId: string): string {
  return `patch:node:${nodeId}`;
}

function patchGroups(
  context: MenuContext,
  track: Track,
  patch: Patch,
  fx?: string,
): MenuNode[] {
  return [
    {
      kind: "action",
      label: fx === undefined ? "Edit patch" : "Edit effect patch",
      command: `/patch${fxSuffix(fx)}`,
      help: "the patch view: nodes, ports and the cable matrix",
    },
    {
      kind: "menu",
      id: "patch:knobs",
      label: "knobs",
      detail: patch.macros
        .slice(0, 4)
        .map((m) => m.label ?? m.id)
        .join(" · "),
      help: "the patch's macros; the first four are the four knobs",
      build: () => macroNodes(track, patch, fx),
    },
    {
      kind: "menu",
      id: "patch:nodes",
      label: "nodes",
      detail: `${patch.nodes.length} node${patch.nodes.length === 1 ? "" : "s"}`,
      help: "every node's settings · patch set <id> k=v",
      build: () =>
        patch.nodes.map((node): MenuNode => ({
          kind: "menu",
          id: nodeMenuId(node.id),
          label: node.id,
          detail: node.type,
          help: `${node.type} settings`,
          build: () =>
            nodeParamNodes(patch, node.id, fx, context.score.patches),
        })),
    },
  ];
}

/** Sound › patch on the focused track: the view, knobs, nodes, then edits. */
export function patchMenuNode(context: MenuContext): MenuNode {
  const track = context.score.tracks.find((t) => t.id === context.trackId);
  const patch = track && trackPatch(context.score, track);
  if (!track || !patch)
    return {
      kind: "menu",
      id: "patch",
      label: "patch",
      detail: "off · /patch previews it as one",
      help: "modular patches: nodes, cables and four knobs",
      build: (inner) => [
        {
          kind: "action",
          label: "Edit patch",
          command: "/patch",
          help: "the patch view (a preview until the track is a patch)",
        },
        ...patchRows(inner),
      ],
    };
  const ref = track.patch && isPatchRef(track.patch) ? track.patch.ref : "";
  return {
    kind: "menu",
    id: "patch",
    label: "patch",
    detail: `${ref || patch.name} · ${patch.nodes.length} nodes`,
    help: "modular patches: nodes, cables and four knobs",
    build: (inner) => [
      ...patchGroups(inner, track, patch),
      ...patchRows(inner),
    ],
  };
}

/** Effects › "<name> patch", one group per effect patch on the track. */
export function effectPatchMenuNodes(
  context: MenuContext,
  track: Track | undefined,
): MenuNode[] {
  return (track?.fxPatch ?? []).map((patch) => ({
    kind: "menu",
    id: `patch:fx:${patch.name}`,
    label: `${patch.name} patch`,
    detail: `effect patch · ${patch.nodes.length} nodes`,
    help: "an effect patch at the chain's patch stage",
    build: (inner) => patchGroups(inner, track!, patch, patch.name),
  }));
}

/** `patch <verb> <text>` when it parses, else undefined (the entry waits). */
function patchLine(verb: string, text: string): string | undefined {
  const rest = text.trim().replace(/\s+/g, " ");
  if (!rest) return undefined;
  const line = `patch ${verb} ${rest}`;
  return parsePatchCommand(line) ? line : undefined;
}

function entry(
  label: string,
  verb: string,
  placeholder: string,
  example: string,
  help: string,
): MenuNode {
  return {
    kind: "entry",
    label,
    value: "",
    placeholder,
    example: `patch ${verb} ${example}`,
    help,
    command: (text) => patchLine(verb, text),
  };
}

function patchRows(context: MenuContext): MenuNode[] {
  const track = context.score.tracks.find((t) => t.id === context.trackId);
  if (!track) return [];
  const rows: MenuNode[] = [
    entry(
      "new patch",
      "new",
      "name [from <preset|instrument>], e.g. mine from acid-bass",
      "mine",
      "start a modular patch on this track",
    ),
    {
      kind: "choice",
      label: "load patch",
      value: "",
      options: BUILTIN_PATCH_NAMES,
      command: (name) => `patch load ${name}`,
      help: "play a built-in patch · or type patch load <name|github:…>",
    },
    {
      kind: "action",
      label: "convert to patch",
      command: "patch convert",
      help: `rebuild ${track.instrument} as an equivalent patch you can rewire`,
    },
  ];
  rows.push(
    entry(
      "add node",
      "add",
      "type [as id] [k=v …], e.g. svf as vcf cutoff=800",
      "osc as tone",
      "add a node · patch nodes lists the types",
    ),
    entry(
      "set node",
      "set",
      "id k=v …, e.g. vcf q=0.6",
      "tone wave=saw",
      "change a node's params",
    ),
    entry(
      "wire",
      "wire",
      "from.port to.port [amount], e.g. lfo.out vcf.cutoff 0.4",
      "tone.out out.audio",
      "connect an output to an input",
    ),
    entry(
      "unwire",
      "unwire",
      "from.port to.port",
      "tone.out out.audio",
      "remove a cable",
    ),
    entry(
      "map to knob",
      "macro",
      'id node.port[:min..max] … [label "…"]',
      "cutoff vcf.cutoff",
      "a macro: one knob that moves one or more ports",
    ),
    entry(
      "turn knob",
      "knob",
      "macro value, e.g. cutoff 900",
      "cutoff 900",
      "set a macro's value",
    ),
    entry(
      "node rate",
      "rate",
      "id global|voice, e.g. lfo global",
      "tone global",
      "run a node once per track or once per voice",
    ),
    entry("remove node", "rm", "id", "tone", "remove a node and its cables"),
    entry(
      "save patch",
      "save",
      "name [--user]",
      "mine",
      "copy this patch into the project library (--user: every project)",
    ),
    {
      kind: "action",
      label: "show as text",
      command: "patch show",
      help: "the patch as the lines that rebuild it",
    },
    {
      kind: "action",
      label: "list node types",
      command: "patch nodes",
      help: "every node type with its ports",
    },
  );
  rows.push({
    kind: "action",
    label: "detach",
    command: "patch detach",
    help:
      track.patch && isPatchRef(track.patch)
        ? `give this track its own copy of ${track.patch.ref}`
        : "give this track its own copy of a shared library patch",
  });
  return rows;
}

/** Effects › add effect patch. */
export function effectPatchMenuNode(): MenuNode {
  return {
    kind: "entry",
    label: "add effect patch",
    value: "",
    placeholder: "name [from <preset>], e.g. wobble",
    example: "patch new wobble effect",
    help: "a modular effect on this track · edit it with patch … --fx <name>",
    command: (text) => {
      const words = text.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return undefined;
      const [name, ...rest] = words;
      const line = `patch new ${name} effect${rest.length ? ` ${rest.join(" ")}` : ""}`;
      return parsePatchCommand(line) ? line : undefined;
    },
  };
}
