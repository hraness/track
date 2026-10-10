/**
 * The four knobs of a page as fader fields: each path of a KNOB_MAPS row
 * (src/tui/knob-map.ts) resolved in the live Ctrl-K tree, so a knob turns
 * exactly what that menu row turns and runs the same typed command.
 */
import type { KnobIndex } from "../../tui/knobs.ts";
import type { FaderSpec } from "./fader.ts";
import { knobMap, type KnobMap } from "./knob-map.ts";
import {
  faderSpecs,
  rootNodes,
  type MenuContext,
  type MenuNode,
} from "./menu.ts";

export type KnobField = FaderSpec & { knob: KnobIndex };

const norm = (text: string) => text.trim().toLowerCase();

function matches(node: MenuNode, segment: string): boolean {
  const want = norm(segment);
  if (want.endsWith("*"))
    return node.kind === "menu" && norm(node.id).startsWith(want.slice(0, -1));
  if (node.kind === "menu" && norm(node.id) === want) return true;
  return norm(node.label) === want;
}

/** The row a knob path reaches from the root, or undefined. */
export function resolveKnobPath(
  context: MenuContext,
  path: string,
): MenuNode | undefined {
  let nodes: readonly MenuNode[] = rootNodes(context);
  let found: MenuNode | undefined;
  for (const segment of path.split("/")) {
    const nth = /^#(\d+)$/.exec(segment);
    found = nth
      ? nodes[Number(nth[1]) - 1]
      : nodes.find((node) => matches(node, segment));
    if (!found && !nth) {
      // Effects beyond the first few live under "more effects".
      const more = nodes.find(
        (node) => node.kind === "menu" && node.id === "more effects",
      );
      if (more?.kind === "menu")
        found = more.build(context).find((node) => matches(node, segment));
    }
    if (!found) return undefined;
    nodes = found.kind === "menu" ? found.build(context) : [];
  }
  return found;
}

/**
 * The knob label: the row's own label, or `reverb mix` when the row lives in
 * another effect than the page's (the mixer's reverb send).
 */
function knobLabel(page: string, path: string, label: string): string {
  const segments = path.split("/");
  if (segments[0] === "effects" && segments.length >= 3) {
    const effect = segments[1]!;
    if (page !== `fx:${effect}`) return `${effect} ${label}`;
  }
  return label;
}

/**
 * The four slots of `page` for `context`: a field per slot whose path
 * resolves to a number or choice row, else undefined (drawn `·`, skipped).
 * A page without a row (an effect not in the table) derives one from
 * `fallback`: its first three number rows, and `mix` on orange.
 */
export function knobSlots(
  context: MenuContext,
  page: string,
  fallback: readonly FaderSpec[] = [],
): (KnobField | undefined)[] {
  const map: KnobMap | undefined = knobMap(page);
  if (!map) {
    const numbers = fallback.filter(
      (field) => field.kind === "number" && field.label !== "mix",
    );
    const mix = fallback.find((field) => field.label === "mix");
    return [numbers[0], numbers[1], numbers[2], mix].map((field, index) =>
      field ? { ...field, knob: index as KnobIndex } : undefined,
    );
  }
  return map.map((path, index) => {
    if (!path || path.startsWith("@") || !path.includes("/")) return undefined;
    const node = resolveKnobPath(context, path);
    const spec = node ? faderSpecs([node])[0] : undefined;
    if (!spec) return undefined;
    return {
      ...spec,
      label: knobLabel(page, path, spec.label),
      knob: index as KnobIndex,
    } as KnobField;
  });
}

/** The present knobs of `page`, in knob order: the drawer's front page. */
export function knobFields(
  context: MenuContext,
  page: string,
  fallback: readonly FaderSpec[] = [],
): KnobField[] {
  return knobSlots(context, page, fallback).filter(
    (field): field is KnobField => field !== undefined,
  );
}
