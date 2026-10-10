/**
 * Fused voice blocks: the voice section compiled to one JavaScript function
 * per program (design §8.2, "compile the patch, don't interpret it"). Every
 * input record and port offset is resolved once and written into the code
 * as a literal, and each node calls its kernel directly instead of going
 * through the runner's per-node switch. Consecutive nodes with inlined
 * kernels share one sample loop (each node's statements for sample `i` in
 * node order), split wherever a node reads a whole block (a block
 * control's last sample) that an earlier node in the loop writes. The generated statements are the
 * interpreter's arithmetic in the interpreter's order, so the output is
 * bit-identical to `prologue` + `kernel`.
 */
import {
  Base,
  F,
  In,
  INPUT_WIDTH,
  mapMacro,
  Op,
  type Section,
} from "./compile.ts";
import { BLOCK } from "./nodes/frame.ts";
import {
  KERNEL_HELPERS,
  kernelParts,
  type Parts,
  scoped,
  standalone,
  voiceAddr,
  voiceParts,
} from "./kernels.ts";

export { voiceAddr };

/** Literal for a double, exact (`String` round-trips; -0 needs its sign). */
export function lit(x: number): string {
  if (Object.is(x, -0)) return "(-0)";
  if (x !== x) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "(-Infinity)";
  const s = String(x);
  return x < 0 ? `(${s})` : s;
}

/** Shared state a fused block reads and writes besides the voice memory. */
export type FuseCtx = {
  consts: Float64Array;
  ext: Float64Array;
  scrubbed: number;
};

/** One input record's code, split like a kernel's parts (kernels.ts). */
type InputCode = {
  pre: string;
  body: string;
  post: string;
  /** Slot offsets read whole before the loop (block values, slot bases). */
  blockReads: number[];
  /** Slot offset written per sample, or -1. */
  write: number;
  /** False when the per-sample form does not apply (a sum into its own source). */
  fusable: boolean;
};

/**
 * Code for one input record (the generic prologue specialised to it): audio
 * sums, sampled controls and block controls. `$` names are the record's own
 * (kernels.ts `scoped` prefixes them with the node).
 */
function inputCode(
  section: Section,
  consts: Float64Array,
  record: number,
  first: boolean,
): InputCode {
  const rec = section.inputs;
  const cab = section.cables;
  const r = record * INPUT_WIDTH;
  const kind = rec[r + F.Kind]!;
  const c0 = rec[r + F.CableStart]! * 2;
  const c1 = c0 + rec[r + F.CableCount]! * 2;
  const cables: { x: number; a: string }[] = [];
  for (let c = c0; c < c1; c += 2)
    cables.push({ x: voiceAddr(cab[c]!), a: lit(consts[cab[c + 1]!]!) });
  const q = `$r${record}`;
  if (kind === In.Sum) {
    const o = voiceAddr(rec[r + F.Slot]!);
    // One pass per sample, the sum's terms in cable order (slots are whole
    // blocks, so a source either is the scratch slot or does not overlap).
    if (cables.every((c) => c.x !== o)) {
      const terms = cables.map((c) => `m[${c.x} + i] * ${c.a}`);
      return {
        pre: "",
        body: `m[${o} + i] = ${terms.join(" + ")};\n`,
        post: "",
        blockReads: [],
        write: o,
        fusable: true,
      };
    }
    let code = `for (let i = 0; i < ${BLOCK}; i += 1) m[${o} + i] = m[${cables[0]!.x} + i] * ${cables[0]!.a};\n`;
    for (const c of cables.slice(1))
      code += `for (let i = 0; i < ${BLOCK}; i += 1) m[${o} + i] += m[${c.x} + i] * ${c.a};\n`;
    return {
      pre: code,
      body: "",
      post: "",
      blockReads: [],
      write: -1,
      fusable: false,
    };
  }
  const slot = rec[r + F.Ctl]!;
  const cl = rec[r + F.Clamp]!;
  const lo = cl >= 0 ? lit(consts[cl]!) : "(-Infinity)";
  const hi = cl >= 0 ? lit(consts[cl + 1]!) : "Infinity";
  const bi = rec[r + F.BaseIndex]!;
  const mp = rec[r + F.Map]!;
  const baseKind = rec[r + F.BaseKind]!;
  const blockReads: number[] = [];
  let base: string;
  if (baseKind === Base.Const) base = lit(consts[bi]!);
  else {
    if (baseKind !== Base.External) blockReads.push(voiceAddr(bi));
    const raw =
      baseKind === Base.External
        ? `ctx.ext[${bi}]`
        : `m[${voiceAddr(bi) + BLOCK - 1}]`;
    base =
      mp >= 0
        ? `mapMacro(${raw}, k[${mp}], k[${mp + 1}], k[${mp + 2}] === 1, k[${mp + 3}], k[${mp + 4}])`
        : raw;
  }
  const settle = (value: string) =>
    `{\nlet v = ${value};\nif (v !== v) { v = 0; ctx.scrubbed += 1; }\n` +
    (first ? `prev[${slot}] = v;\n` : `prev[${slot}] = ctl[${slot}];\n`) +
    `ctl[${slot}] = v;\n}\n`;
  if (kind === In.Sampled) {
    const o = voiceAddr(rec[r + F.Slot]!);
    if (cables.every((c) => c.x !== o)) {
      let sum = `${q}base`;
      for (const c of cables) sum = `(${sum}) + m[${c.x} + i] * ${c.a}`;
      const v = cl >= 0 ? `v < ${lo} ? ${lo} : v > ${hi} ? ${hi} : v` : "v";
      return {
        pre: `const ${q}base = ${base};\nlet ${q}last = 0;\n`,
        body: `{\nconst v = ${sum};\nconst w = ${v};\nm[${o} + i] = w;\n${q}last = w;\n}\n`,
        post: settle(`${q}last`),
        blockReads,
        write: o,
        fusable: true,
      };
    }
    let code = `{\nconst base = ${base};\nfor (let i = 0; i < ${BLOCK}; i += 1) m[${o} + i] = base;\n`;
    for (const c of cables)
      code += `for (let i = 0; i < ${BLOCK}; i += 1) m[${o} + i] += m[${c.x} + i] * ${c.a};\n`;
    if (cl >= 0)
      code += `for (let i = 0; i < ${BLOCK}; i += 1) { const v = m[${o} + i]; m[${o} + i] = v < ${lo} ? ${lo} : v > ${hi} ? ${hi} : v; }\n`;
    code += `}\n${settle(`m[${o + BLOCK - 1}]`)}`;
    return {
      pre: code,
      body: "",
      post: "",
      blockReads,
      write: -1,
      fusable: false,
    };
  }
  let code = `{\nlet value = ${base};\n`;
  for (const c of cables) {
    blockReads.push(c.x);
    code += `value += m[${c.x + BLOCK - 1}] * ${c.a};\n`;
  }
  code += `if (value < ${lo}) value = ${lo};\nelse if (value > ${hi}) value = ${hi};\n`;
  code += `${settle("value")}}\n`;
  return {
    pre: code,
    body: "",
    post: "",
    blockReads,
    write: -1,
    fusable: true,
  };
}

/** Names a hoisted constant may use (besides literals and other constants). */
const PURE = [
  "Math.PI",
  "Math.pow",
  "Math.sin",
  "Math.cos",
  "Math.tan",
  "Math.abs",
  "Math.min",
  "Math.max",
  "Math.floor",
  "Math.exp",
  "Math.log",
  "Math.sqrt",
  "TAU",
  "warp",
  "flush",
  "NaN",
  "Infinity",
];

/**
 * The value each constant control (a block input with no cables and a
 * literal base, never re-evaluated) holds after the first block: the
 * literal clamped and cleaned exactly as the block input code does.
 */
function stillValues(
  section: Section,
  consts: Float64Array,
): Map<number, number> {
  const rec = section.inputs;
  const known = new Map<number, number>();
  const hot = new Set(section.hot);
  for (let n = 0; n < section.op.length; n += 1)
    for (let j = 0; j < section.inCount[n]!; j += 1) {
      const record = section.inStart[n]! + j;
      const r = record * INPUT_WIDTH;
      if (hot.has(record) || rec[r + F.Kind] !== In.Block) continue;
      if (rec[r + F.CableCount] !== 0 || rec[r + F.BaseKind] !== Base.Const)
        continue;
      const cl = rec[r + F.Clamp]!;
      const lo = cl >= 0 ? consts[cl]! : -Infinity;
      const hi = cl >= 0 ? consts[cl + 1]! : Infinity;
      let value = consts[rec[r + F.BaseIndex]!]!;
      if (value < lo) value = lo;
      else if (value > hi) value = hi;
      if (value !== value) value = 0;
      known.set(rec[r + F.Ctl]!, value);
    }
  return known;
}

const CALL = /Math\.(sin|cos|tan|pow|exp|log)\(/;
const LOOP = "/*loop*/";
const END = "/*end*/";
const REF = /(?<![\w$])m\[(\d+)( \+ [^\]]+)?\]/g;

/**
 * Keeps a slot in a local instead of voice memory when one shared sample
 * loop writes it (every sample, before any read) and nothing else reads
 * it: no code outside that loop, no kernel function, not the runner
 * (`keep`). The local holds the same double the store would, so the bytes
 * do not change.
 */
function localize(code: string, keep: ReadonlySet<number>): string {
  const parts = code.split(LOOP);
  const loops = parts.slice(1).map((p) => p.split(END));
  const outside = [parts[0]!, ...loops.map((l) => l[1]!)].join("\n");
  const owner = new Map<number, number>();
  const bad = new Set<number>();
  const base = (x: number) => x - (x % BLOCK);
  for (const r of outside.matchAll(REF)) bad.add(base(Number(r[1])));
  loops.forEach(([loop], j) => {
    for (const r of loop!.matchAll(REF)) {
      const x = Number(r[1]);
      if (r[2] !== " + i" || x % BLOCK !== 0) bad.add(base(x));
      else if ((owner.get(x) ?? j) !== j) bad.add(x);
      else owner.set(x, j);
    }
  });
  const out = [parts[0]!];
  loops.forEach(([loop, rest], j) => {
    let decl = "";
    let text = loop!;
    for (const [x, o] of owner) {
      if (o !== j || bad.has(x) || keep.has(x)) continue;
      const at = text.indexOf(`m[${x} + i]`);
      if (!text.startsWith(`m[${x} + i] = `, at)) continue;
      decl += `let s${x} = 0;\n`;
      text = text.split(`m[${x} + i] = `).join(`s${x} = `);
      text = text.split(`m[${x} + i]`).join(`s${x}`);
    }
    out.push(decl + text + rest!);
  });
  return out.join("");
}

/** A fused voice block: one block of the voice section, boundary included. */
export type FusedBlock = ((
  f: unknown,
  ctx: FuseCtx,
  voice: unknown,
  sr: number,
  gm: Float64Array,
  stride: number,
  fanAt: number,
  sumAt: number,
) => void) & {
  /** Fan-in slots the block reads from the global memory itself. */
  direct: ReadonlySet<number>;
  /** Whether the block adds the voice sums itself when `sumAt >= 0`. */
  sums: boolean;
};

/** The runner's copies around a voice block (compile.ts fanOuts, voiceSums). */
export type FuseIo = Readonly<{
  /** Global source slot, voice fan-in slot, per fan-out. */
  fanOuts: Int32Array;
  /** Voice source slot, global accumulator slot, per voice sum. */
  voiceSums: Int32Array;
}>;

/** Kernel call for node `n` (null: the runner fills it, or nothing to do). */
export type KernelOf = (op: number, n: number) => string | null;

/**
 * Builds the fused block of a voice section: `first` evaluates every input
 * (the voice's first block), otherwise only the hot ones.
 * The voice boundary node is inlined for the ports in `deps.voiceUsed`
 * (kernels.ts `voiceParts`). Kernels come from `deps` by the names `kernelOf` returns.
 */
export function fuseVoice(
  section: Section,
  consts: Float64Array,
  first: boolean,
  kernelOf: KernelOf,
  deps: Readonly<Record<string, unknown>>,
  io: FuseIo = { fanOuts: new Int32Array(0), voiceSums: new Int32Array(0) },
  sampleRate?: number,
): FusedBlock {
  const rec = section.inputs;
  let body = "";
  let head = "";
  const blockConst = new Map<number, string>();
  // The open group: nodes sharing one sample loop, and the slots they write.
  let group: Parts[] = [];
  let written = new Set<number>();
  const close = () => {
    if (group.length === 1) body += standalone(group[0]!);
    else if (group.length > 1)
      body += `{\n${group.map((g) => g.pre).join("")}${LOOP}for (let i = 0; i < ${BLOCK}; i += 1) {\n${group.map((g) => `{\n${g.body}}\n`).join("")}}${END}\n${group.map((g) => g.post).join("")}}\n`;
    group = [];
    written = new Set();
  };
  const portsEnd = (n: number) =>
    n + 1 < section.op.length ? section.slotBase[n + 1]! : section.slots.length;
  // Slots read outside the generated code: delay sources (and the voice
  // sums, for the blocks the runner adds itself).
  const keep = new Set<number>();
  const sumPairs: [number, number][] = [];
  for (let k = 0; k < io.voiceSums.length; k += 2) {
    keep.add(voiceAddr(io.voiceSums[k]!));
    sumPairs.push([voiceAddr(io.voiceSums[k]!), io.voiceSums[k + 1]!]);
  }
  for (let d = 0; d < section.delays.length; d += 2)
    keep.add(voiceAddr(section.delays[d]!));
  const voiceOp = section.ids.indexOf("voice");
  for (let n = 0; n < section.op.length; n += 1) {
    if (n === voiceOp) {
      // The voice's setup goes first in the function; a port that is one
      // value for the whole block is read as that value, not from memory.
      const vp = voiceParts(section, n, deps.voiceUsed as number);
      head += vp.pre;
      const vbody = vp.body
        .split("\n")
        .filter((line) => {
          const c = /^m\[(\d+) \+ i\] = (n\d+_v\d+);$/.exec(line);
          if (!c) return true;
          blockConst.set(Number(c[1]), c[2]!);
          return false;
        })
        .join("\n");
      group.push({ pre: "", body: vbody, post: vp.post });
      const end =
        n + 1 < section.op.length
          ? section.slotBase[n + 1]!
          : section.slots.length;
      for (let k = section.slotBase[n]!; k < end; k += 1)
        written.add(voiceAddr(section.slots[k]!));
      continue;
    }
    const records: number[] = [];
    if (first) {
      for (let j = 0; j < section.inCount[n]!; j += 1) {
        const record = section.inStart[n]! + j;
        if (rec[record * INPUT_WIDTH + F.Kind] !== In.None)
          records.push(record);
      }
    } else
      for (let j = 0; j < section.hotCount[n]!; j += 1)
        records.push(section.hot[section.hotStart[n]! + j]!);
    const inputs = records.map((record) =>
      inputCode(section, consts, record, first),
    );
    const parts = kernelParts(section, n);
    if (!parts || !inputs.every((x) => x.fusable)) {
      close();
      for (const x of inputs)
        body += scoped(x.body ? standalone(x) : x.pre + x.post, n);
      const call = parts ? standalone(parts) : kernelOf(section.op[n]!, n);
      // A kernel function reads and writes its ports through the frame.
      if (!parts)
        for (let k = section.slotBase[n]!; k < portsEnd(n); k += 1)
          keep.add(voiceAddr(section.slots[k]!));
      if (call) body += call + "\n";
      continue;
    }
    // A node joins the open group unless it reads a whole block that the
    // group writes (that block is only complete after the loop).
    // A call the engine cannot inline (Math.sin) spills every value live
    // across it, so such a node gets a loop of its own.
    const alone = CALL.test(parts.body);
    if (alone || inputs.some((x) => x.blockReads.some((o) => written.has(o))))
      close();
    group.push({
      pre: scoped(inputs.map((x) => x.pre).join(""), n) + parts.pre,
      body: scoped(inputs.map((x) => x.body).join(""), n) + parts.body,
      post: scoped(inputs.map((x) => x.post).join(""), n) + parts.post,
    });
    for (const x of inputs) if (x.write >= 0) written.add(x.write);
    if (alone) {
      close();
      continue;
    }
    const end =
      n + 1 < section.op.length
        ? section.slotBase[n + 1]!
        : section.slots.length;
    for (let k = section.slotBase[n]! + section.nIn[n]!; k < end; k += 1)
      written.add(voiceAddr(section.slots[k]!));
  }
  // The voice sums of a plain block (no steal fade, no silence tracking),
  // scrubbed and added as run.ts does, each into its own accumulator.
  const sums =
    sumPairs.length > 0 &&
    new Set(sumPairs.map((p) => p[1])).size === sumPairs.length;
  if (sums) {
    let sumBody = "";
    let pre = "";
    sumPairs.forEach(([x, g], j) => {
      pre += `const sd${j} = ${g} * stride + sumAt;\n`;
      sumBody += `{\nconst x = m[${x} + i];\nif (sumAt < 0) out[${x} + i] = x;\nelse if (x - x === 0) gm[sd${j} + i] += x;\nelse ctx.scrubbed += 1;\n}\n`;
    });
    group.push({ pre, body: sumBody, post: "" });
    for (const [x] of sumPairs) keep.delete(x);
  }
  close();
  for (const [x, name] of blockConst) {
    body = body.replace(REF, (ref, at: string) =>
      Number(at) - (Number(at) % BLOCK) === x ? name : ref,
    );
    if (keep.has(x))
      body = `for (let i = 0; i < ${BLOCK}; i += 1) m[${x} + i] = ${name};\n${body}`;
  }
  body = head + body;
  body = localize(body, keep);
  // Fan-ins read from the global memory where it covers the block.
  const direct = new Set<number>();
  let fans = "";
  for (let k = 0; k < io.fanOuts.length; k += 2) {
    const d = voiceAddr(io.fanOuts[k + 1]!);
    if (keep.has(d)) continue;
    direct.add(d);
    fans += `const F${d} = fanAt >= 0 ? gm : m;\nconst o${d} = fanAt >= 0 ? ${io.fanOuts[k]!} * stride + fanAt : ${d};\n`;
  }
  body = body.replace(REF, (ref, at: string, rest: string | undefined) => {
    const x = Number(at);
    const d = x - (x % BLOCK);
    if (!direct.has(d)) return ref;
    return rest ? `F${d}[o${d} + ${x - d}${rest}]` : `F${d}[o${d} + ${x - d}]`;
  });
  // With the sample rate fixed, a constant control's cell holds a value
  // known now: reads become literals, and a block constant computed only
  // from literals moves out of the block function (computed once).
  function hoist(): string {
    const known = stillValues(section, consts);
    body = body.split("f.sampleRate").join(lit(sampleRate!));
    body = body.replace(
      /(?<![\w$])(ctl|prev)\[(\d+)\](?!\s*=[^=])/g,
      (ref, _a: string, c: string) => {
        const value = known.get(Number(c));
        return value === undefined ? ref : lit(value);
      },
    );
    const pure = new Set(PURE);
    let out = "";
    body = body
      .split("\n")
      .filter((line) => {
        const decl = /^const (n\d+_\w+) = (.+);$/.exec(line);
        if (!decl) return true;
        const rest = decl[2]!
          .replace(/\b\d+(\.\d+)?(e[+-]?\d+)?\b/gi, "")
          .replace(/[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*/g, (id) =>
            pure.has(id) ? "" : "@",
          );
        if (/[@[\]{};"'`]/.test(rest)) return true;
        pure.add(decl[1]!);
        out += line + "\n";
        return false;
      })
      .join("\n");
    return out;
  }
  const names = Object.keys(deps);
  const hoisted = sampleRate === undefined ? "" : hoist();
  const code = `"use strict";\n${KERNEL_HELPERS}\n${hoisted}return function fused(f, ctx, voice, sr, gm, stride, fanAt, sumAt) {\nconst m = f.m;\nconst out = m;\n${fans}const st = f.st;\nconst ctl = f.ctl;\nconst prev = f.prev;\nconst k = ctx.consts;\n${body}};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function("mapMacro", ...names, code) as (
    ...a: unknown[]
  ) => never;
  const fn = make(mapMacro, ...names.map((name) => deps[name])) as (
    ...a: unknown[]
  ) => void;
  return Object.assign(fn, { direct, sums });
}
