/**
 * Polish for the hand-wired modular patches: velocity on the amp envelope
 * and a level stage that puts them at their category loudness, without
 * touching the graph a reader opens in /patch.
 */
import type { Cable, Patch, PatchNode, PortRef } from "../patch.ts";

export function polishModular(
  patch: Patch,
  gain: number,
  velocity: boolean,
  guard = false,
): Patch {
  const nodes: PatchNode[] = [...patch.nodes];
  const cables: Cable[] = [];
  let n = 0;
  const add = (from: string, to: string) =>
    cables.push({
      id: `c-polish${(n += 1)}`,
      from: from as PortRef,
      to: to as PortRef,
    });
  const outs = patch.cables.filter(
    (c) => c.to === "out.audio" || c.to === "out.right",
  );
  const amp = velocity
    ? patch.cables.find((c) => c.to === "vca.gain")
    : undefined;
  for (const c of patch.cables)
    if (c !== amp && !outs.includes(c)) cables.push(c);
  if (amp) {
    // Velocity scales the amp envelope: a soft note sits about 10 dB down.
    nodes.push({ id: "velamp", type: "vca", label: "velocity" });
    nodes.push({
      id: "velcurve",
      type: "scale",
      label: "velocity curve",
      params: { inmin: 0, inmax: 1, min: 0.25, max: 1 },
    });
    add(amp.from, "velamp.in");
    add("voice.velocity", "velcurve.in");
    add("velcurve.out", "velamp.gain");
    add("velamp.out", "vca.gain");
  }
  const g = Math.round(Math.min(4, gain) * 1000) / 1000;
  nodes.push({
    id: "level",
    type: "fx.postgain",
    label: "level",
    params: { gain: g },
  });
  const left = outs.find((c) => c.to === "out.audio");
  const right = outs.find((c) => c.to === "out.right");
  if (left) add(left.from, "level.left");
  add((right ?? left)!.from, "level.right");
  if (guard) {
    // The same tanh peak guard the catalog presets use.
    for (const side of ["l", "r"]) {
      nodes.push({
        id: `guard${side}`,
        type: "fx.distort",
        label: "peak guard",
        params: { type: "soft", drive: 0, tone: 20000, mix: 1, postgain: 0.85 },
      });
    }
    add("level.left", "guardl.in");
    add("level.right", "guardr.in");
    add("guardl.out", "out.audio");
    add("guardr.out", "out.right");
  } else {
    add("level.left", "out.audio");
    add("level.right", "out.right");
  }
  return Object.freeze({ ...patch, nodes, cables });
}
