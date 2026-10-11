import { newId } from "../../core/ids.ts";
import { GRANULAR_PARAMS } from "../../core/granular.ts";
import { compositionBrief } from "./brief.ts";
import { CHORD_PROCESS } from "../../core/chords.ts";
import {
  AGENT_LIMITS,
  MEDIA_PROMPT,
  DISPATCH_PROMPT,
  classifyAgentError,
  executeCall,
  type TurnState,
  hostProjectOutline,
  tighten,
  turnDeadline,
  WORKSPACE_PROMPT,
  type AgentBudget,
  type AgentEvent,
  type AgentHost,
  type AgentTurnResult,
} from "./agent.ts";
import { AGENT_TOOLS, type AgentTool } from "./tools.ts";
import { parseTextReply, XcbError, type TextReply } from "./xcb.ts";
import { SseBudgetError } from "./sse.ts";

/** Steps per xcb turn. Each step is one full model call, so keep it small. */
export const XCB_MAX_STEPS = 3;
const MAX_PROMPT_CHARS = 8_000;
const MAX_FEEDBACK_CHARS = 6_000;

/** One text-in/text-out model call; `generate` must honour `signal`. */
export type TextGenerate = (
  prompt: string,
  options: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number },
) => Promise<string>;

export type TextAgentTurnOptions = Readonly<{
  prompt: string;
  generate: TextGenerate;
  host: AgentHost;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  budget?: AgentBudget;
  /** History id of this turn; default a fresh one. */
  turnId?: string;
  tools?: readonly AgentTool[];
  newNoteId?: (trackId: string, revision: number, index: number) => string;
}>;

export const TEXT_AGENT_SYSTEM_PROMPT = [
  "You are dawg, a loop composer inside a terminal music workstation.",
  "You edit the score by returning operations. Each op is validated and applied immediately, in order, as its own revision.",
  'Times are in beats from the loop start (0-based), while musicians count from 1: in 4/4 "beats 2 and 4" are beats 1 and 3 of each bar here, "the and of 1" is 0.5, and bar n starts at (n-1)×beats per bar. Keep notes inside loopBeats unless you extend the loop first.',
  "Prefer a few well-formed ops (one add_notes op per track part) over many tiny ones.",
  'For drums, create a track with instrument "kit" and prefer set_rhythm (Euclidean rows: pulses over steps, rotate, repeats for rolls, accent, probability, swing) so the beat stays editable as parameters; for a style groove start from apply_drum_pattern (list_drum_patterns) and pick a sound with set_drum_kit. Drum pitches select voices, so do not use add_notes for beats.',
  "Song structure: list_sections shows named sections (bars count from 1); edit_section marks, adds, duplicates, moves, renames, deletes, mutes, varies (transpose/gain) and loops them; set_form sets the play order with repeats (intro verse chorus*2 outro); add_transition generates builds (riser, snare roll, filter sweep, uplifter), drops (cut plus impact) and drum fills at section boundaries.",
  CHORD_PROCESS,
  "Synth voices: set_synth shapes a synth track with Strudel params (ADSR, lpf/lpenv filter envelopes, fm/fmh, supersaw unison/detune, vib, penv, noise; z_* ZzFX sounds take slide/pitchJump/lfo/zcrush…) or a preset (pad lead pluck bass keys bell…).",
  "Plucked strings: set_string makes a track a physical-model string (nylon steel electric jangle ebass slap upright motown sitar tanpura harpsichord lute oud setar tar santur dulcimer koto harp banjo tres requinto) and overrides params (ring bright damp pos mute buzz body sym). The bare words sitar, ebass, pluck keep their older voices; use set_string for the modeled ones.",
  "Bowed strings: set_string preset violin|viola|cello|contrabass|fiddle|erhu|kamancheh|violins|violas|cellos|contrabasses|pizz|trem plays a bowed physical model (bow params pressure speed attack vib vibmod vibdelay tremhz sord dyn). Overlapping or legato notes slur in one bow. The bare words cello, contrabass and strings keep their older voices; use set_string (or the words violin, viola, fiddle, erhu, violins, cellos) for the bowed ones. Sampler voices take vel [lo, hi] velocity layers and rr round-robin groups via set_sample.",
  "Pianos: set_instrument piano (or grand upright felt honkytonk prepared, ballad, lofi) loads a modeled piano with real hammers, stretched inharmonic strings, dampers and the sustain pedal; set_keys tweaks it (hardness touch decay release felt stretch body…, automate as keys-<param> lanes; sym 0.5 adds sympathetic bloom under the sustain pedal for pedalled Romantic and Impressionist playing). A track already stored as instrument piano keeps the legacy tone until you set it again.",
  "Electric keys: set_instrument epiano (rhodes; suitcase stereo vibe, dyno bright 80s), wurli, clav (funkclav); set_keys tweaks bark bell tone vibe (epiano), trem (wurli), pickup neck|bridge|both|out and mute (clav). Soft and sostenuto pedals: set_piano_pedals on any modeled piano.",
  'Organs: set_instrument tonewheel (hammond b3 gospel jazzorgan), combo (farfisa vox) or pipe (church flutes cornet reeds celeste) loads a modeled organ; instrument organ stays the legacy sine. set_keys drawbars "888800008" (16\' to 1\'), registers "08880" (combo), stops ["principal8","octave4"] or plenum|flutes|cornet|reeds|strings|full (pipe), rotary slow|fast|stop, params perc 3rd percdecay percvol click scanner c3 drive chiff wind trem (each family takes only its own rows); automate keys-rotary and keys-drive lanes.',
  "Mallets and bells: set_instrument vibes (or marimba via modal, xylophone glock celesta chimes kalimba mbira steelpan bowl gong timpani) plays the modal engine; set_modal changes mallet (yarn…brass), hardness, position, ring, damp, motor/motordepth (vibes tremolo), buzz, click. Plain instrument marimba stays the legacy tone.",
  "Gamelan: set_modal preset saron demung slenthem gangsa gender bonang kenong kethuk kempul (gong too) with tuning slendro or pelog; for ombak (the shimmer) put the same part on two gangsa tracks and set_modal pair <other track> on one: it sounds ombak Hz (default 6) above its partner. Frame drums: daf bodhran tabla.",
  "Winds and brass: set_instrument flute recorder whistle ney shakuhachi panpipe suling bansuri clarinet bassclarinet oboe bassoon sax altosax barisax trumpet harmon plunger trombone tuba horn plays the wind engine; set_wind changes breath, bright, mute (open straight cup harmon plunger), players (2..8 spreads a section over chord tones), growl, vib. Lines slur unless re-tongued (gaps or articulations). Plain instrument wind stays the legacy tone.",
  "Voices (0.7): set_instrument aah ooh choir chorale (or set_sing preset oohchoir airy glass lament soprano basso drone) plays the built-in singing voice, a synthetic glottal source through formants (never a cloned voice); set_sing params voice (auto soprano alto tenor bass), vowel (a e i o u or a>o), voices 2..8 (an ensemble), breath, vib, jitter, bright; set_vowels puts vowels on notes. Throat singing: khoomei, sygyt (whistle) and kargyraa (sub growl) hold a drone (set_sing params drone D2) and each note picks a harmonic of it.",
  "Vocoder: a vocoder is a carrier track whose vocoder.src is the modulator (usually the user's vocal). make one with create_track (instrument vocoder), then set_vocoder with src set to the vocal, and mute the vocal; talkbox suits funk and soul, choir and glass suit hyperpop, robot and smear suit electronic or ambient. Vocode only the user's own or licensed audio, never an identifiable third party's speech unless the user confirms they hold the rights.",
  "Sampler voices: set_sample sets Strudel sample controls per voice (begin end speed unit loop loopBegin loopEnd clip/legato fit loopAt accelerate squiz cut); splice = slices with fit.",
  "Fitting samples (0.6): fit_sample sets a voice's own bpm (or len in beats) so it follows the song's tempo map; fitmode beats for drums and speech (hits stay sharp), tones for pads and vocals (pitch kept), repitch (default) like tape.",
  "Effects (set_fx and set_automation): the brief's effects list is the fixed chain order with each effect's simple params. set_fx turns an effect on with good defaults, loads a preset or sets params by dawg or Strudel name. Lanes: volume, pan, filter, resonance, delay-feedback, delay-mix, wt and <effect>-<param> (e.g. autofilter-cutoff).",
  "Guitar rig (set_rig): rig loads a whole rig (clean crunch punk ragged lead metal fuzz octave funk wah bachata spring bassdrive reese jangle alt) on a guitar or bass track; stomp, head and cab tweak the pedal, amp (level-matched, gate in dB) and cabinet. Tracks named jangle punk funk ragged gtr-lead gtr-metal bachata start with a guitar voice and that rig. `amp` is Strudel gain; the guitar amp is head.",
  "Shoegaze: rig shoegaze|glide|dreampop|swell|ebow (or a track named shoegaze); set_fx wobble (tremolo-arm bend: depth cents, rate, drift), bloom (feedback swell on the top note), swell (volume swell: time), double (second take: time, drift, width); reverb ir builtin:reverse|gate|spring. Strumming: set_guitar (tune dadgad, capo, hand, ring), strum_chords (chords or the track's own, strokes folk|pop|punk… or D-DU-UDU, speed ms), write_chords perform guitar.",
  "Formant (0.7): set_formant shift -12..12 st moves a track's formants at constant pitch (negative deeper or bigger, positive smaller; 2-4 natural), mix 0..1, preset deep giant bright tiny, off; lanes formant-shift formant-mix. The vowel filter is set_fx vowel, whose to and morph 0..1 glide between two vowels (lane vowel-morph).",
  "Previewing: preview_sound renders a track, or candidate sound tool calls (changes: [{tool, args}]), without committing, returns loudness, brightness and a comparison, and plays it once in the user's window. Use it when choosing between sounds (tables, presets, effect amounts), say how it sounds, then commit with the normal tools.",
  "Wavetable synth: set_wavetable picks a table (built-ins offline, Strudel wt_ sets fetched once) and scans it by position wt.",
  `Granular: set_granular makes a track a grain cloud (presets cloud hold sparkle swarm stutter microloop backwards dust) of a synth source (src synth:pad, the default; synth:<name>@<note>) or one of its own sampler voices, and overrides params (${Object.keys(GRANULAR_PARAMS).join(" ")}; repeat and hold latch the head for beat repeats, begin and end pick a region, root takes a MIDI number or note name); off returns to the previous voice; the same seed gives the same grains. Grain play: sync "1/16" puts grain onsets on the tempo grid, quant scale|chord snaps grain pitches, mono true glides legato notes through one cloud, pedal true freezes the head while the sustain pedal is down; set_automation grain-<param> lanes (grain-pos, grain-scan, grain-pitch …) move a parameter over beats. Resample: the resample tool renders a track, orbit or the mix (a section or bars) to a pinned WAV and adds a sampler track, or with grain a granular track, that plays it; set_sample shift (semitones, length kept, formant 0 keeps a voice's character) and fadeInTime/fadeTime shape a sampler voice.`,
  "Mastering: set_master sets the song master and loudness target; measure_mix reports LUFS, true peak, balance and correlation. Master only when asked for loudness or a finished sound, and measure before and after.",
  'Reply with exactly one JSON object and nothing else, shaped {"ops":[{"tool":"<tool name>","args":{...}}],"say":"<one short sentence describing the musical change>","done":true}.',
  'Set "done":false only if you need to see the results of these ops before continuing; you will then get each op\'s result and can send more ops.',
  "If an op was rejected, read its diagnostic and either send a corrected op or stop with done:true.",
  WORKSPACE_PROMPT,
  MEDIA_PROMPT,
  DISPATCH_PROMPT,
  'Media tools return their outputs in the op result; send them alone with "done":false and chain on the result.',
].join(" ");

/** Render the tool registry as a compact op catalog for a text-only model. */
export function renderToolCatalog(
  tools: readonly AgentTool[] = AGENT_TOOLS,
): string {
  return tools
    .filter((tool) => !tool.hidden)
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  args schema: ${JSON.stringify(tool.parameters)}`,
    )
    .join("\n");
}

/**
 * A tool loop for providers without tool calling (xcb). The model returns one
 * JSON object of ops; each op goes through the same tool argument checks,
 * operation validator, reducer dry run and per-op commit as the gateway path.
 * Rejected ops or `done:false` trigger another call with diagnostics, up to
 * `XCB_MAX_STEPS` calls and the usual turn budgets.
 */
export async function runTextAgentTurn(
  options: TextAgentTurnOptions,
): Promise<AgentTurnResult> {
  const limits = {
    maxSteps: Math.min(
      XCB_MAX_STEPS,
      tighten(options.budget?.maxSteps, AGENT_LIMITS.maxSteps),
    ),
    maxToolCalls: tighten(
      options.budget?.maxToolCalls,
      AGENT_LIMITS.maxToolCalls,
    ),
    maxResponseBytes: tighten(
      options.budget?.maxResponseBytes,
      AGENT_LIMITS.maxResponseBytes,
    ),
    timeoutMs: tighten(options.budget?.timeoutMs, AGENT_LIMITS.timeoutMs),
  };
  const emit = (event: AgentEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A rendering failure must never corrupt the turn.
    }
  };
  const tools = options.tools ?? AGENT_TOOLS;
  const catalog = renderToolCatalog(tools);
  const turnId = options.turnId ?? newId("turn");
  const turnState: TurnState = { untrusted: false };
  const newNoteId =
    options.newNoteId ??
    ((trackId: string, _revision: number, _index: number) => newId(trackId));
  const startedAt = Date.now();
  const deadline = turnDeadline(limits.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;

  let applied = 0;
  let rejected = 0;
  let toolCalls = 0;
  let bytesUsed = 0;
  let finalText = "";
  const steering: string[] = [];
  let feedback = "";
  const currentRevision = () => options.host.snapshot().revision;
  const finish = (result: AgentTurnResult): AgentTurnResult => {
    deadline.clear();
    emit(result);
    return result;
  };
  const done = (reason: "stop" | "max-steps" | "max-tool-calls") =>
    finish({
      type: "done",
      reason,
      text: finalText,
      applied,
      rejected,
      revision: currentRevision(),
    });

  try {
    for (let step = 1; step <= limits.maxSteps; step += 1) {
      if (signal.aborted) throw signal.reason;
      for (const steer of options.host.takeSteering?.() ?? [])
        steering.push(steer.slice(0, 2_000));
      emit({ type: "step", step });
      const remainingBytes = limits.maxResponseBytes - bytesUsed;
      if (remainingBytes <= 0)
        throw new SseBudgetError(limits.maxResponseBytes);
      const snapshot = options.host.snapshot();
      const brief = compositionBrief({
        ...snapshot,
        project: await hostProjectOutline(options.host, snapshot),
      });
      const prompt = [
        TEXT_AGENT_SYSTEM_PROMPT,
        `Tools:\n${catalog}`,
        `Composition brief (JSON): ${brief}`,
        `User request: ${options.prompt.slice(0, MAX_PROMPT_CHARS)}`,
        ...steering.map((text) => `Steering from the user mid-turn: ${text}`),
        feedback
          ? `Results of your previous ops (the brief above already reflects accepted ones):\n${feedback}`
          : "",
        "Reply now with the single JSON object.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const remainingMs = limits.timeoutMs - (Date.now() - startedAt);
      const reply = await options.generate(prompt, {
        signal,
        timeoutMs: Math.max(1_000, remainingMs),
        maxOutputBytes: Math.min(remainingBytes, 64 * 1024),
      });
      if (signal.aborted) throw signal.reason;
      bytesUsed += reply.length;

      let parsed: TextReply;
      try {
        parsed = parseTextReply(reply);
      } catch (error) {
        const diagnostic =
          error instanceof XcbError
            ? error.message
            : "reply could not be parsed";
        rejected += 1;
        emit({
          type: "tool-rejected",
          callId: `xcb-${step}-reply`,
          name: "reply",
          diagnostic,
        });
        feedback = `Your reply was rejected: ${diagnostic}. Reply with exactly one JSON object.`;
        continue;
      }
      if (parsed.say) {
        finalText = parsed.say;
        emit({ type: "text-delta", delta: parsed.say });
      }
      const results: string[] = [];
      let stepRejected = 0;
      let overBudget = false;
      for (const [index, op] of parsed.ops.entries()) {
        if (signal.aborted) throw signal.reason;
        const callId = `xcb-${step}-${index}`;
        if (toolCalls >= limits.maxToolCalls) {
          overBudget = true;
          rejected += 1;
          stepRejected += 1;
          emit({
            type: "tool-rejected",
            callId,
            name: op.tool,
            diagnostic: "tool call budget exhausted",
          });
          continue;
        }
        toolCalls += 1;
        emit({ type: "tool-start", callId, name: op.tool, step });
        const outcome = await executeCall(
          { id: callId, name: op.tool, arguments: JSON.stringify(op.args) },
          {
            turnId,
            turnState,
            tools,
            host: options.host,
            newNoteId,
            signal,
            suspendTimeout: deadline.suspend,
            emit,
            onProgress: (line) =>
              emit({ type: "tool-progress", callId, name: op.tool, line }),
          },
        );
        if (outcome.ok) {
          applied += outcome.mutated ? 1 : 0;
          if (outcome.explanation) finalText = outcome.explanation;
          emit(outcome.event);
        } else {
          rejected += 1;
          stepRejected += 1;
          emit({
            type: "tool-rejected",
            callId,
            name: op.tool,
            diagnostic: outcome.diagnostic,
          });
        }
        results.push(`ops[${index}] ${op.tool}: ${outcome.content}`);
      }
      if (overBudget || toolCalls >= limits.maxToolCalls)
        return done("max-tool-calls");
      if (stepRejected === 0 && parsed.done) return done("stop");
      feedback =
        results.join("\n").slice(0, MAX_FEEDBACK_CHARS) || "No ops were sent.";
    }
    return done("max-steps");
  } catch (error) {
    const { code, message } = classifyAgentError(error, signal, options.signal);
    return finish({
      type: "error",
      code,
      message,
      applied,
      revision: currentRevision(),
    });
  } finally {
    deadline.clear();
  }
}
