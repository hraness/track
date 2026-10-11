/**
 * The agent's `audio` tool: one tool, an `op` enum, every op of the chop
 * toolkit (`src/audio/chop`). The same `runChop` backs `/chop` and
 * `dawg media chop`, so what the agent does a human can repeat by hand.
 * Long docs live in the agent docs (`guides/chop.md`); the catalog entry
 * stays short because every token of it is paid on every turn.
 */
import { systemRunner } from "../auth/runner.ts";
import { parseChopArgs, parseChopOp } from "../audio/chop/args.ts";
import { ChopError } from "../audio/chop/pcm.ts";
import { runChop, stemOf } from "../audio/chop/run.ts";
import { slicesToSampler } from "../audio/chop/sampler.ts";
import { CHOP_OPS, type ChopContext, type ChopResult } from "../audio/chop/types.ts";
import type { MediaRunContext } from "../media/types.ts";
import { trackSlug } from "../../core/slug.ts";
import type { AgentTool, ToolContext, ToolPlan } from "./tools.ts";

const time = { type: ["number", "string"] };
const num = { type: "number" };
const str = { type: "string" };

export const AUDIO_TOOL: AgentTool = {
  name: "audio",
  description:
    'Inspect and chop audio files; edits write new WAVs to tracks/<slug>/samples/. Read ops: info peaks onsets beats segments find audition. Times: 1.5, "350ms", "1:02", "bar:9.1", "-2s"; cuts snap to zero crossings. slice+track loads slices as sampler voices (+pattern notes). Other args (fromBpm toBpm preserve curve targetDb offset crossfadeMs format sampleRate gains reference thresholdDb): see guides/chop.md.',
  parameters: {
    type: "object",
    properties: {
      op: { enum: CHOP_OPS },
      input: str,
      output: str,
      from: time,
      to: time,
      snap: { enum: ["zero", "onset", "beat", "none"] },
      method: { enum: ["silence", "onset", "section", "beats", "grid"] },
      count: num,
      semitones: num,
      ratio: num,
      fadeIn: time,
      fadeOut: time,
      db: num,
      type: { enum: ["highpass", "lowpass", "bandpass"] },
      hz: num,
      inputs: { type: "array", items: str },
      track: str,
      pattern: { type: "boolean" },
    },
    required: ["op"],
    additionalProperties: true,
  },
  plan: (raw, context) => planAudio(raw, context),
};

function chopContext(
  base: Pick<MediaRunContext, "projectRoot" | "trackSlug" | "runner" | "signal"> &
    Partial<Pick<MediaRunContext, "progress" | "chopHistory">>,
  tool: ToolContext,
): ChopContext {
  return {
    root: base.projectRoot,
    trackSlug: base.trackSlug,
    runner: base.runner,
    signal: base.signal,
    tempo: { bpm: tool.score.tempoBpm, beatsPerBar: tool.score.beatsPerBar },
    actor: { kind: "agent" },
    atRev: tool.revision,
    ...(base.progress ? { progress: base.progress } : {}),
    // History seam: the host sets `media.chopHistory` once lane hist wires
    // its HistoryHandle; until then no asset rows are written.
    ...(base.chopHistory ? { history: base.chopHistory } : {}),
  };
}

/** What the model reads: the result without empty fields, outputs listed. */
export function chopContent(result: ChopResult): Record<string, unknown> {
  const { summary: _summary, op: _op, ...rest } = result;
  return { ...rest, outputs: result.outputs };
}

function planAudio(raw: Record<string, unknown>, tool: ToolContext): ToolPlan {
  let op;
  let args;
  try {
    op = parseChopOp(raw.op);
    args = parseChopArgs(raw);
  } catch (error) {
    throw new ChopError(error instanceof Error ? error.message : String(error));
  }
  const label = `audio ${op}${args.input ? ` ${args.input}` : ""}`.slice(0, 120);
  if (op === "audition") {
    return {
      kind: "action",
      summary: label,
      run: async (action) => {
        const root = action.workspace?.root;
        if (!root) throw new ChopError("audio needs a project folder");
        const result = await runChop(op, args, {
          root,
          runner: systemRunner,
          signal: action.signal ?? new AbortController().signal,
          tempo: { bpm: tool.score.tempoBpm, beatsPerBar: tool.score.beatsPerBar },
          ...(action.preview?.playFile
            ? {
                audition: async (path: string, from?: number, to?: number) => {
                  await action.preview!.playFile!(path, from, to);
                },
              }
            : {}),
        });
        return { content: JSON.stringify({ ok: true, summary: result.summary }), summary: result.summary };
      },
    };
  }
  if (op === "slice" && args.track) {
    const trackId = args.track;
    return {
      kind: "prepare",
      summary: label,
      run: async (action) => {
        const root = action.workspace?.root;
        if (!root) throw new ChopError("audio needs a project folder");
        const slug = focusedSlug(tool);
        const result = await runChop(
          op,
          args,
          chopContext(
            {
              projectRoot: root,
              trackSlug: slug,
              runner: action.media?.runner ?? systemRunner,
              signal: action.signal ?? new AbortController().signal,
              ...(action.media?.chopHistory ? { chopHistory: action.media.chopHistory } : {}),
            },
            tool,
          ),
        );
        const loaded = slicesToSampler(tool.score, trackId, stemOf(args.input ?? "slice"), result.outputs, {
          ...(args.pattern ? { pattern: true } : {}),
          newNoteId: (index) => tool.newNoteId(trackId, index),
        });
        return {
          kind: "score",
          operations: loaded.operations,
          trackId,
          summary: `${result.summary} · ${loaded.voices.length} voices on ${trackId}${loaded.notes ? `, ${loaded.notes} notes` : ""}`.slice(0, 160),
        };
      },
    };
  }
  return {
    kind: "media",
    summary: label,
    run: async (media) => {
      const result = await runChop(op, args, chopContext(media, tool));
      return { summary: result.summary, content: chopContent(result), outputs: result.outputs.map((o) => o.path) };
    },
  };
}

function focusedSlug(tool: ToolContext): string {
  const track = tool.score.tracks.find((t) => t.id === tool.focusedTrackId);
  return trackSlug(track?.name ?? tool.focusedTrackId);
}
