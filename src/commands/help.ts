/**
 * The command reference, in one place: `/help` renders it in the overlay,
 * `dawg --help` prints it, and the docs mirror it. Groups are the ten topic
 * ids (src/lang/glossary.ts), the same ids `/guide` and `/menu` take.
 * A topic may have sub-groups (`sound · performance`) so no group runs
 * past about fifteen rows. Commands are written bare, since the slash is
 * optional; only the free-text window verbs (`/rename`, `/fork`,
 * `/resume`), `/auth`, `/bpm` (a sample's tempo; bare `bpm` is song tempo)
 * and `/play` (play mode; bare `play` is the transport) keep it.
 */
import { GUITAR_TUNING_NAMES } from "../../core/chords.ts";
import {
  helpGroupMark,
  SECTION_MARKS,
  type DocMark,
} from "../../guides/marks.ts";
import { KEYS, type KeyScreen } from "../../tui/grammar.ts";
import { displayWidth, truncate } from "../../tui/text.ts";
import {
  resolveTopic,
  topicMiss,
  TOPIC_SUMMARY,
  TOPICS,
  type TopicId,
} from "../lang/glossary.ts";
import { EXPRESSION_USAGE } from "./expression.ts";
import { editDistance } from "./nearest.ts";
import { VOCAL_VERBS } from "./vocal.ts";

/** A topic id, or a heading of the start page. */
export type HelpGroup = string;

export type HelpEntry = Readonly<{
  /** Canonical form, e.g. `pan <-1..1>`. */
  command: string;
  /** What it does, short enough for one overlay row. */
  summary: string;
}>;

export type HelpSection = Readonly<{
  group: HelpGroup;
  entries: readonly HelpEntry[];
}>;

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    group: "sound",
    entries: [
      {
        command: "instrument <name> | preset <name> | /presets [category]",
        summary:
          "sine piano pluck bass … kit · preset warm-pad · preset find fm bell · preset next",
      },
      {
        command: "synth <param> <value> | preset <name>",
        summary: "the synth · synth lpf 1200 · synth alone lists every param",
      },
      {
        command: "wt <table> | wt <0..1> | wt list",
        summary: "wavetable synth · wt basic · wt wt_digital:2 · wt 0.5",
      },
      {
        command: "wtenv|wtattack|wtdecay|wtrate|wtdepth|warp <n>",
        summary: "scan the table · warpmode bendp",
      },
      {
        command:
          "grain <preset> | <param> <value> | on [voice V] | src synth:<name>|voice V",
        summary:
          "granular cloud · grain cloud · grain scan 0.2 · track swarm-2 · grain presets",
      },
      {
        command: "piano [<preset>] | grand | upright | felt | honkytonk",
        summary: "modeled piano · piano ballad · piano lofi · piano prepared",
      },
      {
        command: "keys <param> <value> | preset <name> | reset",
        summary: "piano params · keys hardness 0.3 decay 1.5 · keys lists them",
      },
      {
        command: "epiano|wurli|clav [preset <name>] | <param> <value>",
        summary:
          "electric keys · suitcase dyno funkclav · epiano vibe 0.6 · clav pickup bridge",
      },
      {
        command:
          "tonewheel [<drawbars>] | combo [<tabs>] [<register>] | pipe [<stops>]",
        summary:
          "organs · tonewheel 888800008 perc 3rd · gospel · combo 08880 flute · pipe plenum · keys perc 3rd",
      },
      {
        command: "rotary slow|fast|stop [at <beat>]",
        summary:
          "organ rotary speaker speed · rotary fast at 16 writes the keys-rotary lane",
      },
      {
        command: "string <preset> | <param> <value> | presets | reset | off",
        summary:
          "plucked strings · string sitar · string buzz 0.8 · string ring 6",
      },
      {
        command: "bowed [<preset>] | <param> <value> | presets",
        summary:
          "bowed strings · bowed violin · bowed cellos · bowed pressure 0.7 · bowed sord 1",
      },
      {
        command:
          "guitar tune <name|notes> | capo | hand | ring | position | reset",
        summary: "guitar fretting · guitar tune dadgad · guitar capo 2",
      },
      {
        command:
          "modal <preset> | <param> <value> | mallet <name> | reset | off",
        summary: "mallets · modal vibes · modal hardness 0.8 · modal presets",
      },
      {
        command: "wind <preset> | <param> <value> | mute <name> | reset | off",
        summary:
          "winds and brass · wind flute · wind sax · wind players 4 · wind presets",
      },
      {
        command: "/try <sound command>",
        summary: "hear it on a loop first · a A/B · enter keep",
      },
    ],
  },
  {
    group: "sound · performance",
    entries: [
      {
        command: "art <articulation>|off [target]",
        summary:
          "staccato legato accent tenuto marcato ghost · art staccato bars 1-2",
      },
      {
        command: "glide <ms>|0 [legato|mono|poly] | glide <ms> <target>",
        summary:
          "portamento in ms · glide 60 mono · glide 0 off · SDK 0.06 (s)",
      },
      {
        command: "bend <cents>|scoop|fall|doit|<at:cents>... [target]",
        summary: "pitch curve over each note · bend +200 bar 3",
      },
      {
        command: "vibrato <rate> <depth> [<delay>] [target]",
        summary: "per-note vibrato · vibrato 5.5 30 0.2",
      },
      {
        command: "pedal <beat>-<beat>... | bars | down|half|up <beat> | off",
        summary: "sustain pedal · pedal 0-3.5 4-7.5 · pedal bars",
      },
      {
        command: "pedal soft|sost <beat>-<beat>... | bars | off",
        summary:
          "piano una corda and sostenuto · pedal soft 0-8 · pedal sost 0-4",
      },
      {
        command: "velcurve linear|soft|hard|fixed [<v>]",
        summary: "how velocity maps to level · velcurve fixed 0.6 (0..1)",
      },
      {
        command: "humanize <ms> [<vel%> [<len%>]] [seed <n>|<target>] | off",
        summary:
          "seeded feel at render · humanize 10 8 5 · humanize 20 bars 2-3",
      },
      { command: "expression", summary: "this track's performance settings" },
      {
        command: "/patch [--fx <name>] [off]",
        summary:
          "the patch view: nodes, ports, cables · a add · w wire · m knob",
      },
    ],
  },
  {
    group: "sound · samples",
    entries: [
      {
        command: "/sample [<path> [as <sample>]]",
        summary: "add a sample · alone lists the samples",
      },
      {
        command: "/bpm <n> [<sample>]",
        summary: "a sample's own tempo (the slash matters: bare bpm is tempo)",
      },
      {
        command: "fitmode [repitch|beats|tones|auto] [<sample>]",
        summary: "how it fits · alone suggests one from the sound",
      },
      {
        command: "len <beats> [<sample>]",
        summary: "the sample lasts n beats of the song",
      },
      {
        command: "shift <semitones> [formant keep|follow|<n>] [<sample>]",
        summary:
          "a sample's pitch without changing its length · shift 0 clears",
      },
      {
        command: "fade [in|out] <seconds> [<sample>]",
        summary: "a sample's fade in and out (Strudel fadeInTime/fadeTime)",
      },
      {
        command:
          "resample <track>|orbit <n>|master [section <name>|bars a-b] [grain]",
        summary: "render to a pinned WAV on a new sampler (or granular) track",
      },
      {
        command: "chop <op> <file> [values] · chop slice <file> --track <id>",
        summary:
          "inspect and chop audio files into new samples (cut, slice, pitch, stretch, fade…)",
      },
    ],
  },
  {
    group: "sound · patch",
    entries: [
      {
        command:
          "patch new <name> [instrument|effect] [from <preset>] · patch load <name>",
        summary:
          "a modular patch · patch load acid-bass · patch convert · patch detach · patch show",
      },
      {
        command:
          "patch add <type> [as <id>] [k=v …] · patch set <id> k=v · patch rm <id>",
        summary:
          "nodes · patch add svf as vcf mode=lp · patch nodes lists them",
      },
      {
        command:
          "patch wire <node.port> <node.port> [amount] · patch unwire <a> <b>",
        summary: "cables · patch wire tone.out vcf.in · patch rate lfo global",
      },
      {
        command:
          "patch macro <id> <node.port>[:min..max] … · patch knob <id> <value>",
        summary: "knobs 1-4 · patch macro cutoff vcf.cutoff range 80..4000",
      },
      {
        command:
          "patch save <name> [--user] · patch load github:<user>/<repo>/<name>",
        summary:
          "the project or your user library · pack patches pinned by hash",
      },
    ],
  },
  {
    group: "voice",
    entries: [
      {
        command: "sing [preset] [param value]",
        summary:
          "built-in singing voice: aah ooh choir chorale airy glass lament soprano basso, throat: drone khoomei sygyt kargyraa",
      },
      {
        command: "sing vowels <v> …",
        summary:
          "vowels for the track's notes in order, cycled · sing vowels a e i o",
      },
      {
        command: "note vowel <v|a>u> [target]",
        summary: "sung vowel for selected notes · note vowel o bar 2",
      },
      {
        command: "lyrics [bar] sun-lit morn-ing",
        summary: "syllables onto the notes (- splits, _ holds, ~ skips)",
      },
      {
        command: "autotune [preset] [field value …] | off | presets",
        summary:
          "pitch correction · autotune hard · autotune gentle · autotune to notes melody · autotune key D bayati",
      },
      {
        command:
          "/formant <-12..12> [mix] | deep | giant | bright | tiny | on | off",
        summary:
          "formant shift at constant pitch · /formant -4 deeper · /formant 3 smaller",
      },
      {
        command:
          "/vowel <v> [<to> [<morph>]] | ee | to <v>|off | morph <0..1> | off",
        summary: "vowel filter · /vowel a · /vowel a o 0.5 morphs a toward o",
      },
      {
        command:
          "vocoder [preset] | src <track> | <param> <value|reset> | off | presets",
        summary:
          "vocode the focused voice onto a synth (classic robot talkbox choir glass whisper smear lofi) · help vocoder lists params",
      },
    ],
  },
  {
    group: "voice · clips",
    entries: [
      { command: "vocal", summary: "voice tools: lists every verb" },
      {
        command:
          "clip [id] gain -3 | gain by -3 | fade .01 .2 | fade in .01 | split 7",
        summary: "edit an audio clip (dB, seconds, 1-based bars)",
      },
      {
        command:
          "clip [id] trim offset 1 dur 4|end | rev | repeat 2 [to 32] | mute | rm",
        summary: "trim, reverse, repeat, mute or remove a clip",
      },
      ...VOCAL_VERBS.map((verb) => ({
        command: `vocal ${verb.usage}`,
        summary: verb.summary,
      })),
    ],
  },
  {
    group: "effects",
    entries: [
      {
        command: "fx <effect> <param> <value> | on | off | preset <name>",
        summary:
          "effects · fx delay mix 0.3 · fx reverb on · fx alone lists them",
      },
      {
        command: "filter <hz> [res] · delay <beats> [fb] [mix] · reverb <mix>",
        summary:
          "shortcuts for fx filter, delay and reverb · filter 1200 · delay 0.5 · reverb 0.3",
      },
      {
        command: "rig <preset> | reset",
        summary:
          "guitar amp and pedals · rig crunch · rig jangle · rig metal · rig alone lists them",
      },
      {
        command: "stomp|head|cab <type> | <param> <value>",
        summary:
          "pedal, amp, cabinet · stomp rat · head gain 7 gate -55 · cab 4x12",
      },
      {
        command: "fx wobble|bloom|swell|double [param value]",
        summary:
          "shoegaze · fx wobble depth 30 · fx double · fx reverb ir builtin:reverse",
      },
    ],
  },
  {
    group: "rhythm",
    entries: [
      {
        command: "hit <drum> at <beat>",
        summary: "one hit on a kit track · hit kick at 0",
      },
      {
        command: "pattern <drum> <beats...> | every <step>",
        summary: "a drum on beats · pattern kick every 1",
      },
      { command: "clear <drum>", summary: "remove one drum's hits" },
      {
        command: "euclid <drum> <pulses> [<steps>] [rotate <n>]",
        summary: "generated rhythm · euclid hat 7 16 rotate 2",
      },
      {
        command: "euclid <drum> <field> <value> | off | freeze",
        summary: "repeats pace accent prob swing …",
      },
      { command: "grid <drum> <x.X.>", summary: "explicit steps · X accent" },
      {
        command: "pattern [name]",
        summary: "groove picker · hear each groove move",
      },
      {
        command: "/kit [name]",
        summary: "kit picker · synth kits, then sample kits",
      },
      {
        command: "pack list|info|use|add",
        summary: "sample packs · pack use 909/bd",
      },
      {
        command: "euclid [drum]",
        summary: "euclid rhythm editor · Ctrl-K › Rhythm",
      },
    ],
  },
  {
    group: "chords",
    entries: [
      {
        command: "key <tonic> <mode> | none",
        summary: "song key · key A minor · key F# dorian",
      },
      {
        command: "scale [<tonic>] <name> | list",
        summary: "song scale · scale D hijaz · scale yaman · scale list",
      },
      {
        command: "tuning <name> | edo <n> | scl <file> | off",
        summary: "song tuning · tuning 19-edo · tuning just · tuning list",
      },
      {
        command: "tuning ref <hz> | root <note> | map linear|nearest",
        summary: "A4 reference · degree-0 key · keys per step",
      },
      {
        command: "tuning track <…> | track off",
        summary: "this track's tuning · off follows the song",
      },
      {
        command: "cents <id> <±c>",
        summary: "detune one note · cents n3 -14 · add E4-14c at 0",
      },
      {
        command: "progression <chords> [each 4] [at 0] [bass]",
        summary:
          "sustained voice-led chords · progression i7 IV7 each 8 · progression Am7 D9 bass",
      },
      {
        command: "strum [chords] [pattern] [strokes D-DU-UDU] [speed 22ms]",
        summary:
          "strummed guitar chords · strum G D Em C folk · strum I V vi IV · strum alone strums the track's chords",
      },
      {
        command: "/chords auto|manual|off",
        summary: "chords in play mode · /chords alone shows settings",
      },
      {
        command: "play degrees|in-key|chromatic",
        summary:
          "in play mode the home row plays the key's degrees (any tuning)",
      },
    ],
  },
  {
    group: "mix",
    entries: [
      { command: "volume <0..1>", summary: "track level" },
      { command: "pan <-1..1>", summary: "left … right" },
      {
        command: "knobs [sound|mix|master|tempo|fx <effect>]",
        summary: "four knobs ● moves ▲ sizes ■ shapes ◆ level · tab all params",
      },
      {
        command: "mix | volume <track> <0..1> | pan <track> <-1..1>",
        summary: "the mixer page · volume drums 0.5 sets drums, focus stays",
      },
      { command: "mute", summary: "silence this track" },
      { command: "unmute", summary: "hear it again" },
      { command: "solo", summary: "only this track" },
      { command: "unsolo", summary: "every track again" },
      {
        command: "automate <lane> at <beat> <value>",
        summary: "volume pan filter resonance delay-feedback delay-mix wt",
      },
      {
        command: "automate <lane> points <b:v>...",
        summary: "several points · automate pan points 0:-1 4:1",
      },
      { command: "automate <lane> remove <beat>", summary: "drop one point" },
      { command: "clear [<lane>] automation", summary: "drop a lane's points" },
      {
        command: "master <unit> on|off | preset <name> | <param> <value>",
        summary:
          "song master · eq glue tape width limiter · master glue ratio 4",
      },
      {
        command: "master <target> | target <lufs> | measure | off",
        summary:
          "loudness · master streaming · master target -9 · master measure",
      },
    ],
  },
  {
    group: "arrange",
    entries: [
      { command: "add <note> at <beat> [for <beats>]", summary: "add C4 at 0" },
      { command: "remove <id>", summary: "delete a note" },
      { command: "move <id> to <beat>", summary: "shift a note" },
      { command: "length <id> <beats>", summary: "resize a note" },
      { command: "velocity <id> <0..1>", summary: "note loudness" },
      { command: "clear", summary: "remove this track's notes" },
      { command: "track <name>", summary: "focus a track, creating it if new" },
      { command: "tracks", summary: "list tracks" },
      {
        command: "track rm|move <name> [<position>]",
        summary:
          "remove a track (Ctrl-Z undoes) or move it · rm and delete are aliases",
      },
      { command: "track name <text>", summary: "rename this track" },
      {
        command: "track rate|phase|loop <n> | off",
        summary: "polytempo · track rate 3/2 · track loop 3",
      },
      {
        command: "track phasing <beats> [over <beats>|hold <n>]",
        summary: "Reich phasing · track phasing 3 hold 8 · track time off",
      },
    ],
  },
  {
    group: "arrange · song",
    entries: [
      {
        command: "section <name> <a>-<b> | add | dup | move | rename | remove",
        summary:
          "song sections · section chorus 9-16 · section alone lists them",
      },
      {
        command: "section loop | jump | mute | vary <name>",
        summary: "section loop chorus · section mute verse drums",
      },
      {
        command: "form <section…> | off | bake",
        summary: "song form · form intro verse chorus*2 outro",
      },
      {
        command: "build | drop | fill [<section> | <a>-<b>]",
        summary: "riser, roll, sweep · pre-drop cut and impact · drum fill",
      },
      {
        command: "style <id> [bars] [seed]",
        summary: "a whole song in a style · style bebop 16 3 · style again",
      },
      {
        command: "style list|search|info · style blend <a> <b> [w]",
        summary: "the style tree · style search maqam",
      },
      { command: "bars <count>", summary: "song length, 1–256" },
      { command: "extend <count> bars", summary: "lengthen the song" },
    ],
  },
  {
    group: "arrange · range",
    entries: [
      {
        command: "/tape [on|off]",
        summary: "every track across the bars · c copy x cut v paste · ctrl-t",
      },
      {
        command: "keys record [replace|off]",
        summary: "record the loop in play · one undo step a pass · r R on tape",
      },
      {
        command: "loop <a>-<b> | <section> | next | prev | off",
        summary: "the loop range · loop 5-6 · loop next steps it along",
      },
      {
        command: "copy [<track>|all] <a>-<b> to <bar> [x<N>] [insert|merge]",
        summary: "copy bass 5-6 to 7 x2 · copy all chorus to 17 insert",
      },
      {
        command: "move [<track>|all] <a>-<b> to <bar> [insert]",
        summary: "move bass 5-6 to 9 · the source empties",
      },
      {
        command: "clear [<track>|all] <a>-<b>",
        summary: "clear bass 5-6 · empty bars, the bars stay",
      },
      {
        command: "copy [<track>|all] <a>-<b> · paste [at <bar>] [x<N>]",
        summary: "the clipboard · copy all 1-4 · paste at 9",
      },
      {
        command: "reverse [<track>|all] <a>-<b>",
        summary: "mirror the bars · reverse bass 5-6",
      },
      {
        command: "bars insert <n> at <bar> | bars remove <a>-<b>",
        summary: "shift later music · sections, clips, automation, tempo",
      },
      {
        command: "jump <bar>[.<beat>] | <section>",
        summary: "move the playhead · jump 5 · jump 5.3 · jump chorus",
      },
      {
        command: "section split <name> at <bar> | join <name>",
        summary: "section split chorus at 13 · section join chorus",
      },
      {
        command: "form print",
        summary: "print form to tape · alias of form bake",
      },
    ],
  },
  {
    group: "project",
    entries: [
      { command: "play", summary: "start the transport" },
      { command: "pause", summary: "stop the transport" },
      {
        command: "/play [on|off]",
        summary: "play mode: the computer keyboard plays notes · ctrl-p",
      },
      { command: "tempo <bpm>", summary: "20–300 BPM" },
      {
        command: "tempo <bpm> at <beat>|bar <n> [ramp|exp]",
        summary: "tempo change · tempo 90 at bar 9 ramp · tempo clear",
      },
      {
        command: "rit|accel [<n> bars] [to <bpm>] [at bar <n>]",
        summary: "gradual · rit 4 bars to 80 · a tempo · tempo primo",
      },
      {
        command: "fermata [at <beat>|at bar <n>|at end] [<extra beats>]",
        summary: "hold a beat · fermata at 31 2 · fermata clear",
      },
      { command: "meter <1..16>", summary: "beats per bar" },
      {
        command: "meter <n>/<d> [at bar <n>]",
        summary: "meter change · meter 7/8 at bar 5 · meter clear",
      },
      {
        command: "/click on|off|<volume>",
        summary: "metronome · /count-in 0-2 · grid 1/16",
      },
      {
        command: "export <file> [stems]",
        summary:
          "JSON, MIDI for .mid, WAV for .wav · export song.wav · export mix.wav stems",
      },
      { command: "import <file>", summary: "replace the score from a file" },
      {
        command: "calibration [0|1|latest|off]",
        summary: "sound fixes · 1 chokes hats, levels keys · 0 legacy",
      },
      {
        command: "undo [all]",
        summary: "this pane's last edit · Ctrl-Z · all: anyone's",
      },
      {
        command: "redo [all]",
        summary: "step forward · Ctrl-Y · all: anyone's",
      },
      { command: "/status", summary: "name · revision · digest · storage" },
    ],
  },
  {
    group: "project · window",
    entries: [
      { command: "/view focus|all", summary: "one track or every track" },
      { command: "/transcript", summary: "scrollable log · Ctrl-O" },
      { command: "/theme default|high-contrast|mono", summary: "colors" },
      { command: "/motion on|off", summary: "animation" },
      {
        command: "/menu [section]",
        summary: "every setting by hand · Ctrl-K · /menu <topic>",
      },
      {
        command: "help [topic]",
        summary: "start here · help <topic> · help all for everything",
      },
      { command: "/guide [topic]", summary: "short how-to guides · F1" },
    ],
  },
  {
    group: "project · session",
    entries: [
      { command: "/sessions", summary: "list sessions in this workspace" },
      { command: "/resume [<n>|<name>|<id>]", summary: "switch session" },
      { command: "/rename <name>|--auto", summary: "name this session" },
      { command: "/fork [<name>]", summary: "copy into a new session" },
      {
        command: "/comment [@last|@agent|@rev N] <text>",
        summary: "a breadcrumb here (/c) · #tags",
      },
      {
        command: "comments [@agent|@mine|#tag|<track>]",
        summary: "list comments",
      },
      {
        command: "history [<track>|comment|#tag|bars A-B]",
        summary: "edits, comments, turns",
      },
    ],
  },
  {
    group: "project · audio",
    entries: [
      {
        command: "audio",
        summary: "the output and input in use, and the lists",
      },
      {
        command: "audio out <name|default>",
        summary: "play through one output · saved on this machine",
      },
      {
        command: "audio in <name|default>",
        summary: "the input to meter (recording takes comes later)",
      },
      { command: "audio test", summary: "a short tone, then the input level" },
    ],
  },
  {
    group: "project · panes",
    entries: [
      { command: "panes", summary: "who has this session open, on what" },
      {
        command: "pane <screen> [<track>]",
        summary: "copies dawg pane … for another terminal",
      },
      { command: "pin · unpin", summary: "keep this pane on its track" },
      {
        command: "follow [<letter>] · unfollow",
        summary: "follow another pane's track · follow b",
      },
    ],
  },
  {
    group: "agent",
    entries: [
      {
        command: "/model [alias]",
        summary: "pick the agent's model · /model lists them · /model fast",
      },
      {
        command: "/model key [gateway|openrouter|codex|claude]",
        summary: "add an agent key (optional) · finds existing setups first",
      },
      {
        command: "/logout [provider]",
        summary: "forget keys and the saved choice",
      },
      { command: "/auth [--check]", summary: "provider and audio status" },
      {
        command: "/showme on|quiet|off",
        summary:
          "the agent types its commands in your prompt bar as it streams",
      },
      {
        command: "/agent read-root add|remove|list [folder]",
        summary:
          "let the agent read a folder outside the project (never write) · human only",
      },
      {
        command: "/agent shell on|off",
        summary:
          "trusted shell: exec may run any command line here · off by default, human only",
      },
    ],
  },
];

/**
 * `/help` with no topic: start here, then the ten topics. Each row is
 * something to type or press, then what it does. The full reference is
 * `/help all`; one topic is `/help <topic>`.
 */
export const HELP_GUIDE: readonly HelpSection[] = [
  {
    group: "start here",
    entries: [
      {
        command: "type a request",
        summary: "“add a walking bass in A minor” (with an agent)",
      },
      {
        command: "style deep-house",
        summary: "a whole song in a style · style list",
      },
      {
        command: "space · ctrl-p",
        summary: "play · play mode: the keyboard plays notes",
      },
      { command: "ctrl-k", summary: "menu: every setting by hand" },
      { command: "? · ctrl-z · ctrl-y", summary: "keys here · undo · redo" },
    ],
  },
  {
    group: "topics · help <topic>",
    entries: [
      ...TOPICS.map((id) => ({ command: id, summary: TOPIC_SUMMARY[id] })),
      { command: "all", summary: "every command · /guide <topic> · F1" },
    ],
  },
];

/**
 * `/help arrange`: one screen around the range verbs (design F11), each row
 * a line to type. The full syntax of every arranging command stays in
 * `/help all` and `/help <command>` (`/help copy`, `/help section`).
 */
export const ARRANGE_PAGE: HelpSection = {
  group: "arrange",
  entries: [
    {
      command: "loop 5-6 · loop chorus",
      summary: "loop the bars · loop next · loop off",
    },
    {
      command: "copy bass 5-6 to 7",
      summary: "copy bars · x2 repeats · all = every track",
    },
    {
      command: "move bass 5-6 to 9",
      summary: "move bars · the source empties",
    },
    {
      command: "clear bass 5-6",
      summary: "empty bars · reverse bass 5-6 mirrors",
    },
    {
      command: "copy all 1-4 · paste at 9",
      summary: "the clipboard, for later",
    },
    { command: "jump 5 · jump chorus", summary: "move the playhead" },
    { command: "ctrl-t · tape", summary: "every track across the bars" },
    {
      command: "section chorus 9-16",
      summary: "name bars · section loop chorus",
    },
    {
      command: "form verse verse chorus",
      summary: "song form · form print lays it out",
    },
    {
      command: "build · drop · fill chorus",
      summary: "riser · pre-drop cut · drum fill",
    },
    { command: "style deep-house 16", summary: "a whole song in a style" },
  ],
};

/**
 * `/help panes`: several terminals on one session (§12). Its rows are the
 * `project · panes` reference group under a heading of its own.
 */
function panesLines(width: number): string[] {
  const group = HELP_SECTIONS.find((s) => s.group === "project · panes")!;
  return [
    ...sectionLines([{ ...group, group: "panes" }], width),
    "",
    truncate("dawg pane tape in another terminal · guide panes", width),
  ];
}

/** Topics `/help <topic>` takes, besides `all` (aliases resolve too). */
export const HELP_TOPICS = TOPICS;

/**
 * `/help keys`: every screen's `?` panel, straight from tui/grammar.ts
 * KEYS, so the reference and the panels never disagree.
 */
export function keysLines(width = 80): string[] {
  const seen = new Set<string>();
  const sections = (Object.keys(KEYS) as KeyScreen[]).flatMap((screen) =>
    KEYS[screen].map((section) => ({
      title:
        section.title === screen || screen === "prompt"
          ? section.title
          : `${screen} · ${section.title}`,
      rows: section.rows,
    })),
  );
  const column =
    Math.min(
      24,
      Math.max(
        ...sections.flatMap((s) => s.rows.map(([keys]) => displayWidth(keys))),
      ),
    ) + 2;
  const lines = ["── keys"];
  for (const section of sections) {
    const key = JSON.stringify(section.rows);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push("", truncate(`── ${section.title}`, width));
    for (const [keys, action] of section.rows)
      lines.push(
        truncate(
          `${keys}${" ".repeat(Math.max(1, column - displayWidth(keys)))}${action}`,
          width,
        ),
      );
  }
  return lines;
}

/** The last rows of a topic page: the same id in the other two doors. */
function doors(id: TopicId, width: number): string[] {
  return ["", truncate(`guide ${id} · menu ${id} · help all`, width)];
}

/** A topic's groups: `sound`, then `sound · performance`, `sound · samples`. */
export function topicSections(id: TopicId): readonly HelpSection[] {
  return HELP_SECTIONS.filter(
    (section) => section.group === id || section.group.startsWith(`${id} · `),
  );
}

/** One topic's page: its groups, then where else the topic opens. */
function topicLines(id: TopicId, width: number): string[] {
  if (id === "keys") return [...keysLines(width), ...doors(id, width)];
  if (id === "arrange")
    return [...sectionLines([ARRANGE_PAGE], width), ...doors(id, width)];
  return [...sectionLines(topicSections(id), width), ...doors(id, width)];
}

/**
 * Rows for `/help [topic]`: the start page with no topic, the full
 * reference for `all`, a topic for its id or an alias, a command's rows
 * for its verb (`/help vocoder`); undefined for an unknown word.
 */
export function helpTopicLines(
  topic: string | undefined,
  width = 80,
): string[] | undefined {
  const name = topic?.trim().toLowerCase().replace(/^\//, "");
  if (!name) return sectionLines(HELP_GUIDE, width, 20);
  if (name === "all" || name === "commands" || name === "reference")
    return helpLines(width);
  if ((TOPICS as readonly string[]).includes(name))
    return topicLines(name as TopicId, width);
  if (name === "panes" || name === "pane") return panesLines(width);
  const spelled = HELP_COMMAND_ALIASES[name];
  if (spelled) return commandTopic(spelled, width, name);
  const alias = resolveTopic(name);
  // A topic alias wins unless a reference row starts with the word:
  // `/help sections` is the arrange topic, `/help scale` the command.
  const command =
    alias && !hasRow(name) ? undefined : commandTopic(name, width);
  if (command)
    return alias
      ? [...command, "", truncate(`see also help ${alias}`, width)]
      : command;
  return alias ? topicLines(alias, width) : undefined;
}

/**
 * Each `/help` line's heading mark, or undefined for a row that is not a
 * `── heading`: guides/marks.ts helpGroupMark by group (`› sound`,
 * `✦ agent`, `→ topics`), and `⌃` for every heading from `── keys` on,
 * since the keys always close a page.
 */
export function helpHeadingMarks(
  lines: readonly string[],
): (DocMark | undefined)[] {
  let keys = false;
  return lines.map((line) => {
    if (!line.startsWith("── ")) return undefined;
    const group = line.slice(3);
    if (group === "keys") keys = true;
    return keys ? SECTION_MARKS.Keys : helpGroupMark(group);
  });
}

/** True when a reference row starts with `name` (`/scale`, `scale …`). */
function hasRow(name: string): boolean {
  const verb = name.replace(/[^a-z0-9-]/g, "");
  return HELP_SECTIONS.some((section) =>
    section.entries.some((entry) =>
      new RegExp(`^/?${verb}(\\s|$)`, "i").test(entry.command),
    ),
  );
}

/**
 * `/help <command>` (`/help vocoder`, `/help clip`): the command's rows
 * from every group, then its full usage wrapped; undefined when no command
 * has that name.
 */
function commandTopic(
  name: string,
  width: number,
  usageKey = name,
): string[] | undefined {
  const pattern = name
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ +/g, "\\s+");
  const own = (command: string) =>
    new RegExp(`^/?${pattern}(\\s|$)`, "i").test(command);
  const rows = HELP_SECTIONS.flatMap((section) =>
    section.entries.filter((entry) => own(entry.command)),
  );
  const usage = USAGE[usageKey] ?? USAGE[name];
  if (rows.length === 0 && !usage) return undefined;
  const wrap = Math.max(30, width - 2);
  // A usage line that repeats a row keeps only what it adds (examples).
  const extra = usage
    ? rows.reduce((text, entry) => {
        const bare = (value: string) =>
          value.replace(/^\//, "").replace(/\s*\|\s*/g, "|");
        return bare(text).startsWith(bare(entry.command))
          ? bare(text)
              .slice(bare(entry.command).length)
              .replace(/^\s*·\s*/, "")
          : text;
      }, usage)
    : "";
  // Examples a row summary already shows are not repeated.
  const shown = rows.map((entry) => entry.summary).join(" · ");
  const added = extra
    .split(" · ")
    .filter((part) => part && !shown.split(" · ").includes(part))
    .join(" · ");
  return [
    `── ${name}`,
    ...rows.flatMap((entry) => [
      ...wrapWords(entry.command, wrap),
      ...wrapWords(entry.summary, wrap - 2).map((line) => `  ${line}`),
    ]),
    ...(added ? ["", ...wrapWords(added, wrap)] : []),
  ];
}

/**
 * Typed aliases that /help shows under their one word (design §8.2): the
 * alias opens the page and the title, heading and rows name the canonical
 * command.
 */
export const HELP_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  login: "model key",
};

function wrapWords(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    if (row && row.length + 1 + word.length > width) {
      rows.push(row);
      row = word;
    } else row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  return rows;
}

function sectionLines(
  sections: readonly HelpSection[],
  width: number,
  fixedColumn?: number,
): string[] {
  const lines: string[] = [];
  const column =
    fixedColumn ??
    Math.min(
      40,
      Math.max(
        ...sections.flatMap((s) => s.entries.map((e) => e.command.length)),
      ) + 2,
    );
  for (const section of sections) {
    if (lines.length > 0) lines.push("");
    lines.push(truncate(`── ${section.group}`, width));
    for (const entry of section.entries) {
      const pad = Math.max(1, column - entry.command.length);
      lines.push(
        truncate(`${entry.command}${" ".repeat(pad)}${entry.summary}`, width),
      );
    }
  }
  return lines;
}

/**
 * `/help all`: a heading per topic, then `command  summary` lines, then
 * the keys of every screen.
 */
export function helpLines(width = 80): string[] {
  const lines: string[] = [];
  const column = Math.min(
    40,
    Math.max(
      ...HELP_SECTIONS.flatMap((s) => s.entries.map((e) => e.command.length)),
    ) + 2,
  );
  for (const section of HELP_SECTIONS) {
    if (lines.length > 0) lines.push("");
    lines.push(truncate(`── ${section.group}`, width));
    for (const entry of section.entries) {
      const pad = Math.max(1, column - entry.command.length);
      lines.push(
        truncate(`${entry.command}${" ".repeat(pad)}${entry.summary}`, width),
      );
    }
  }
  return [...lines, "", ...keysLines(width)];
}

/** The `Commands:` block of `dawg --help`. */
export function helpText(): string {
  return HELP_SECTIONS.map(
    (section) =>
      `${section.group}:\n${section.entries
        .map((entry) => `  ${entry.command}`)
        .join("\n")}`,
  ).join("\n");
}

/** Usage for a known verb, shown instead of sending a near-miss to the agent. */
export const USAGE: Readonly<Record<string, string>> = {
  click: "/click on|off|<volume> · /click 50%",
  "count-in": "/count-in 0|1|2",
  chords:
    "/chords auto|manual|off · voicing <n> · spread · bass · perform · rate · octaves · sevenths · preset · style · strokes · speed",
  key: "key <tonic> <mode> | none · key A minor",
  scale: "scale [<tonic>] <name> | list · scale D hijaz",
  tuning:
    "tuning <name> | edo <n> | ratios … | cents … | scl <file> [kbm <file>] | ref <hz> | root <note> | map linear|nearest | track … | off · tuning 19-edo",
  calibration: "calibration [0|1|latest|off] · calibration latest",
  tune: "tuning <name> | edo <n> | scl <file> | off · tuning list · pitch correction is autotune",
  autotune:
    "autotune [hard|robot|warble|trap|pop|natural|gentle|guided|locked] | to scale|chromatic|chord|notes [track] | key <key> | speed hold glide <ms> | relax amount center drift <0..1> | flex <0..100> | vib <Hz> vibmod <st> | voice auto|bass|tenor|alto|soprano | reset | off | presets · autotune hard · autotune natural flex 40",
  cents: "cents <id> <±cents> · cents n3 -14",
  grid: "grid 1/4|1/8|1/8T|1/16|1/16T|1/32",
  tempo:
    "tempo takes 20…300 · tempo 120 · tempo 90 at bar 9 [ramp|exp] · tempo remove bar 9 · tempo clear · tempo map",
  bpm: "tempo takes 20…300 · tempo 120 · a sample's own tempo: /bpm 174 [<sample>] · /bpm off",
  rit: "rit [<n> bars|beats] [to <bpm>] [at bar <n>|<beat>] [exp] · rit 4 bars to 80",
  ritardando:
    "rit [<n> bars|beats] [to <bpm>] [at bar <n>|<beat>] [exp] · rit 4 bars to 80",
  rall: "rit [<n> bars|beats] [to <bpm>] [at bar <n>|<beat>] [exp] · rall 2 bars",
  accel:
    "accel [<n> bars|beats] [to <bpm>] [at bar <n>|<beat>] [exp] · accel 8 bars to 174 at bar 9",
  accelerando:
    "accel [<n> bars|beats] [to <bpm>] [at bar <n>|<beat>] [exp] · accel 8 bars to 174",
  fermata:
    "fermata [at <beat>|at bar <n>|at end] [<extra beats>] · fermata at 31 2 · fermata remove 31 · fermata clear",
  add: "add <note> at <beat> [for <beats>] · add C4 at 0",
  put: "add <note> at <beat> [for <beats>] · add C4 at 0",
  remove: "remove <id> · ids show in the transcript",
  delete: "remove <id> · ids show in the transcript",
  move: "move <id> to <beat> · move [<track>|all] <a>-<b> to <bar> [insert] · move bass 5-6 to 9",
  length: "length <id> <beats>",
  velocity: "velocity <id> <0..1>",
  vel: "velocity <id> <0..1>",
  bars: "bars <count> (1…256) | bars insert <n> at <bar> | bars remove <a>-<b> · bars 8 · bars insert 2 at 3",
  copy: "copy [<track>|all] [<a>-<b>|<section>] [to <bar>] [x<N>] [insert|merge] · copy bass 5-6 to 7 x2",
  paste:
    "paste [at <bar>] [x<N>] [insert|merge] · paste at 9 · copy bass 5-6 fills the clipboard",
  reverse: "reverse [<track>|all] [<a>-<b>|<section>] · reverse bass 5-6",
  jump: "jump <bar>[.<beat>] | <section> · jump 5 · jump 5.3 · jump chorus",
  loop: "loop <a>-<b> | <section> | next | prev | off · loop 5-6 · loop chorus · loop off",
  pane: "pane home|play|tape|sound|menu|patch [<track>] [pin|follow [<letter>]] · pane tape · pane sound bass pin · pane patch bass",
  follow: "follow [<letter>] · follow b · unfollow stops",
  panes: "panes · who has this session open, on what · pane tape",
  knobs:
    "knobs [sound|mix|master|tempo|fx <effect>] · knobs mix · knobs fx reverb",
  mix: "mix · the mixer page · volume drums 0.5 · pan drums -0.2",
  audio:
    "audio [out|in <name|default>] | test · audio out default · audio test",
  extend: "extend <count> bars · extend 4 bars",
  instrument:
    "instrument <name> · sine piano pluck bass sawtooth square triangle wavetable kit · pianos: grand upright felt honkytonk prepared · electric: epiano suitcase dyno wurli clav funkclav · synth: supersaw pulse white pink z_square · voices: vocal aah ooh choir chorale khoomei sygyt kargyraa vocoder…",
  volume: "volume takes 0…1 · volume 0.8",
  vol: "volume takes 0…1 · volume 0.8",
  pan: "pan takes -1…1 · pan -0.5",
  wt: "wt <table> | wt <0..1> | wt list · wt basic · wt wt_digital:2",
  wavetable: "wt <table> | wt <0..1> | wt list · wt basic · wt wt_digital:2",
  grain:
    "grain <preset> | <param> <value> | on [voice V] | src synth:<name>|voice V | reset | off | presets · sync 1/64…1/1 (t triplet, d or . dotted) · grain cloud · grain pitch 12 · grain sync 1/8.",
  granular:
    "grain <preset> | <param> <value> | on [voice V] | src synth:<name>|voice V | reset | off | presets · grain cloud",
  warpmode: "warpmode none|asym|bendp|bendm|bendmp|sync|quant",
  filter: "filter <hz> [res] · filter 800 0.3 · filter off",
  delay: "delay <beats> [fb] [mix] · delay 0.75 0.4 0.3 · delay off",
  reverb: "reverb <mix> [size] · reverb 0.3 0.6 · reverb off",
  automate: "automate <lane> at <beat> <value> · automate volume at 0 0.5",
  automation: "automate <lane> at <beat> <value> · automate volume at 0 0.5",
  hit: "hit <drum> at <beat> · hit kick at 0",
  pattern: "pattern <drum> <beats...> | every <step> · pattern kick every 1",
  clear:
    "clear · clear <drum> · clear [<lane>] automation · clear [<track>|all] <a>-<b> · clear bass 5-6",
  track:
    "track <name> · track drums · track rm <name> · track move <name> <position> · track rate <0.125..8>|<a>/<b>|off · track phase <beats> · track loop <beats> · track phasing <beats> [over <beats>]",
  tracks: "tracks",
  sessions: "/sessions",
  resume: "/resume [<n>|<name>|<id>]",
  rename: "/rename <name> | --auto",
  fork: "/fork [<name>]",
  comment:
    "/comment [@last|@agent|@mine|@rev <N>|@<id>] <text> · /comment love this part #love",
  comments: "comments [@agent|@mine|#tag|<track>] [n] · /comments #good",
  history:
    "history [<track>|<kind>|#tag|bars A-B|<n>] · /history bass comment · dawg history in a shell",
  status: "/status",
  export: "export <file> · export loop.track.json",
  import: "import <file> · import loop.track.json",
  sample:
    "/sample <path> [as <sample>] · /sample set <sample> <control> <value>… · /sample set brk fit on clip 1 · /sample set soft vel 0-63 rr a",
  samples: "/sample · lists the focused track's samples",
  fitmode:
    "fitmode [repitch|beats|tones|auto|off] [<sample>] · fitmode beats · fitmode auto brk",
  len: "len <beats> [<sample>] · len 16 · len off",
  shift:
    "shift <semitones> [formant keep|follow|<n>] [<sample>] · shift 7 formant keep · shift 0",
  fade: "fade [in|out] <seconds> [<sample>] · fade out 0.5 · fade in 0.05 · fade off",
  resample:
    "resample <track>|orbit <n>|master [section <name>|bars a-b] [post] [grain] [as <id>] · resample lead · resample drums bars 1-2 grain · resample master section chorus",
  bounce: "resample <track>|orbit <n>|master [section <name>|bars a-b] [grain]",
  chop: "/chop <op> <file> [values] [--flags] · /chop cut break.wav 1.2s 3.4s · /chop pitch vox.wav -3 · /chop slice break.wav --method onset --track chops --pattern · /chop audition out.wav",
  view: "/view focus | all",
  transcript: "/transcript",
  log: "/transcript",
  theme: "/theme default | high-contrast | mono",
  motion: "/motion on | off",
  model:
    "/model [fast | alias | vendor/model] · /model key [gateway | openrouter | codex | claude]",
  models: "/model [fast | alias | vendor/model] · /model key [provider]",
  login: "/model key [gateway | openrouter | codex | claude]",
  logout: "/logout [provider]",
  auth: "/auth [--check]",
  help: "help [topic] · help all · help sound|voice|effects|rhythm|chords|mix|arrange|project|keys|agent",
  guide: "/guide [topic] · /guide voice · F1 · the same topics as help",
  fx: "fx <effect> <param> <value> | on | off | preset <name> · fx delay mix 0.3",
  patch:
    "patch new|load|add|set|wire|unwire|macro|knob|rate|rm|save|show|nodes|convert|detach … [--fx <name>] · patch add osc as tone · patch wire tone.out out.audio",
  preset:
    "preset <name> | list [category|favs] | find <words> | info <name> | similar [name] | fav <name> | next | prev | browse · preset warm-pad · preset list bass",
  presets: "/presets [category] · /presets · /presets bass",
  synth: "synth <param> <value> | preset <name> · synth lpf 1200",
  string:
    "string <preset> | preset <name> | <param> <value> | presets | reset | off · string koto",
  bowed:
    "bowed [violin|viola|cello|contrabass|fiddle|erhu|kamancheh|violins|violas|cellos|contrabasses|pizz|trem] | <param> <value> | presets · bowed violin · bowed pressure 0.7",
  rig: "rig clean|crunch|punk|ragged|lead|metal|fuzz|octave|funk|wah|bachata|spring|bassdrive|reese|jangle|alt|shoegaze|glide|dreampop|swell|ebow | reset",
  guitar: `guitar tune ${GUITAR_TUNING_NAMES.join("|")} | E A D G B E · capo 0..12 · hand 3..6 · ring 0..1 · position · reset`,
  progression:
    "progression i7 IV7 i7 IV7 [each 8] [at 0] [bass] · numerals in the song key or symbols (Am7 D9) · block chords that hold for each span",
  strum:
    "strum G D Em C [folk|pop|punk|…] [strokes D-DU-UDU] [speed 22ms] [each 4] [at 0] · strum alone strums the track's chords",
  stomp:
    "stomp fuzz|face|od|rat|octave | gain <0-10> tone <0-1> level <dB> | off",
  head: "head clean|chime|crunch|lead|high|solid|bass | gain bass mid treble presence master <0-10> | gate <dB> | off",
  cab: "cab 1x12|2x12|4x12|1x10|open|8x10|1x15|di | mic <0-1> | off",
  keys: "keys <param> <value> | preset <name> | reset | presets · keys hardness 0.3 · keys stretch 0 · keys sym 0.5 (sympathetic bloom under the sustain pedal)",
  piano:
    "piano [grand|ballad|upright|felt|lofi|honkytonk|prepared] · piano ballad",
  epiano:
    "epiano [preset epiano|suitcase|dyno] | bark bell tone vibe vibehz decay release <value> · epiano vibe 0.6 · rhodes",
  wurli:
    "wurli [preset wurli] | bark bell tone trem decay release <value> · wurli trem 0.5",
  clav: "clav [preset clav|funkclav] | pickup neck|bridge|both|out | mute tone decay release <value> · clav pickup bridge",
  tonewheel:
    "tonewheel [<9 drawbar digits>] | hammond | b3 | gospel | jazzorgan · tonewheel 888800008",
  combo: "combo [<5 register digits>] | farfisa | vox · combo 08880",
  pipe: "pipe [plenum|flutes|cornet|reeds|strings|full | <stop> …] | church · pipe principal8,octave4",
  rotary: "rotary slow|fast|stop [at <beat>] · rotary fast · rotary fast at 16",
  modal:
    "modal <preset> | <body> | <param> <value> | mallet <name> | pair <track> | gamelan | reset | off | presets · modal vibes · modal gangsa · modal ring 3",
  wind: "wind <preset> | <param> <value> | mute <name> | reset | off | presets · wind flute · wind trumpet mute harmon · wind players 4",
  formant:
    "/formant <-12..12> [mix] | deep|giant|bright|tiny | on | off · /formant -4 · /formant 3 0.5",
  vowel:
    "/vowel <v> [<to> [<morph 0..1>]] | ee | to <v>|off | morph <0..1> | mix <0..1> | off · /vowel a o 0.5",
  lyrics:
    'lyrics [bar] <syllables> | clear [bar] · lyrics "sun-lit morn-ing" (- splits, _ holds, ~ skips)',
  sing: "sing <preset> | <param> <value> | drone <D3> | vowels a e i … | reset | off | presets · sing choir · sing khoomei drone D3 · sing vowel o voices 6",
  vocoder:
    "vocoder [preset] | src <track> | <param> <value|reset> | reset | off | presets · vocoder talkbox · vocoder src vox · vocoder formant +3 · vocoder gate auto · params: tap mode carrier follow root spread bands lo hi width attack release formant unvoiced sens hiss gate enhance depth freeze mix gain seed",
  pack: "pack list | info <name> | use <pack>/<sound> | add <url>",
  kit: "/kit [name] · /kit syn909",
  euclid: "euclid [drum] · euclid hat 7 16",
  menu: "/menu [sound|voice|effects|rhythm|chords|mix|arrange|project|keys|agent] or any row name · /menu tuning · Ctrl-K",
  style:
    "style [list [id]|search <words>|info <id>|<id> [bars] [seed]|blend <a> <b> [w] [bars] [seed]|again] · style deep-house 16 · style blend bebop bossa-nova 0.3",
  master:
    "master <unit> on|off|preset <name>|<param> <value> · master streaming|club|loud · master target -14 · master measure · master off",
  try: "/try <sound command> · /try fx reverb mix 0.6",
  play: "/play [on|off|degrees|in-key|chromatic] · ctrl-p play mode · i toggles degrees",
  tape: "/tape [on|off] · ctrl-t · every track across the bars · c copy · x cut · v paste · \\ loop",
  meter:
    "meter <1..16> · meter 3 · meter 7/8 [at bar <n>] · meter remove bar <n> · meter clear",
  art: EXPRESSION_USAGE.art,
  articulation: EXPRESSION_USAGE.art,
  bend: EXPRESSION_USAGE.bend,
  vibrato: EXPRESSION_USAGE.vibrato,
  glide: EXPRESSION_USAGE.glide,
  portamento: EXPRESSION_USAGE.glide,
  pedal: EXPRESSION_USAGE.pedal,
  sustain: EXPRESSION_USAGE.pedal,
  velcurve: EXPRESSION_USAGE.velcurve,
  humanize: EXPRESSION_USAGE.humanize,
  section:
    "section [mark] <name> <a>-<b> | add [<name>] [<n>] | dup | move <name> to <bar> | rename <name> to <new> | delete | unmark | mute | vary | reset | loop <name>|off | jump <name> | split <name> at <bar> | join <name> · section chorus 9-16",
  sections: "section · lists sections, the form and the loop",
  form: "form <section…> | off | bake (print) · form verse verse chorus verse · form verse chorus*2",
  build:
    "build [into <section> | <section> | <a>-<b>] [<n> bars] [riser] [roll] [sweep] [uplifter] · build into chorus",
  drop: "drop [<section> | at <bar>] [cut <beats>] [no impact] · drop chorus",
  fill: "fill [<section> | at <bar>] [toms|roll|kick] [<n> beats] [no crash] · fill chorus (the beats before it)",
  undo: "undo · Ctrl-Z",
  redo: "redo · Ctrl-Y",
};

/** Verbs a typo can be matched against, without their slash. */
const KNOWN_VERBS: readonly string[] = [
  ...new Set(
    [
      ...HELP_SECTIONS.flatMap((section) =>
        section.entries.map((entry) => entry.command.split(/[\s|[]/)[0]!),
      ),
      ...Object.values(USAGE).map((usage) => usage.split(/[\s|[]/)[0]!),
    ]
      .map((verb) => verb.replace(/^\//, ""))
      .filter((verb) => /^[a-z][\w-]*$/i.test(verb)),
  ),
];

/** Window verbs whose free text would otherwise read as a typo fix. */
const SLASH_ONLY: ReadonlySet<string> = new Set([
  "rename",
  "fork",
  "resume",
  "comment",
  "c",
  "login",
  "logout",
  "auth",
  "bpm",
]);

export { editDistance } from "./nearest.ts";

/**
 * The known command nearest to the first word of `command` (`/clik` →
 * `/click`, `/fx` → `fx`), or undefined when nothing is close.
 */
export function nearestCommand(command: string): string | undefined {
  const word = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const slash = word.startsWith("/");
  const bare = word.replace(/^\//, "");
  if (!bare) return undefined;
  let best: { verb: string; distance: number; score: number } | undefined;
  for (const verb of KNOWN_VERBS) {
    const distance = editDistance(bare, verb);
    if (distance === 0 && !slash) continue;
    // Ties go to a dropped letter (`/clik` → `/click`, not `/clip`), the
    // commonest slip, then a changed one, then an extra one.
    const shape =
      verb.length > bare.length ? 0 : verb.length === bare.length ? 1 : 2;
    const score = distance * 3 + shape;
    if (!best || score < best.score) best = { verb, distance, score };
  }
  const limit = bare.length <= 4 ? 1 : 2;
  if (!best || best.distance > limit) return undefined;
  // Answer in the form typed (`/clik` → `/click`), except an exact word
  // that failed with a slash (`/fx delay on` → `fx`): its slash was wrong.
  return slash && best.distance > 0 ? `/${best.verb}` : best.verb;
}

/**
 * `tempoo 90` → `tempo 90`: the first word one edit from a bare command
 * whose arguments then parse (`parses` decides). Slash words and inputs
 * whose rest is not that command's arguments (prose) return undefined.
 */
export function typoFix(
  command: string,
  parses: (candidate: string) => boolean,
): string | undefined {
  const text = command.trim();
  if (!text || text.startsWith("/")) return undefined;
  const [first, ...rest] = text.split(/\s+/);
  const word = first!.toLowerCase();
  for (const verb of KNOWN_VERBS) {
    if (SLASH_ONLY.has(verb) || verb === word) continue;
    if (editDistance(word, verb) !== 1) continue;
    const candidate = [verb, ...rest].join(" ");
    if (parses(candidate)) return candidate;
  }
  return undefined;
}

/**
 * True for a sentence that merely starts with a command verb (`add a walking
 * bass in A minor`, `pan the hats left`): three or more words and no number
 * or note name with an octave. Those are requests for the agent, not
 * malformed commands. Slash words are never prose.
 */
export function looksLikeProse(command: string): boolean {
  const text = command.trim();
  if (text.startsWith("/")) return false;
  const words = text.split(/\s+/);
  return words.length >= 3 && !/\d/.test(text);
}

/**
 * A usage hint when `command` starts with a known verb but did not parse
 * (`pan 3`, `volume 2`, `add H4 at 0`, `/export` with no file); undefined for
 * free text that should go to the agent.
 */
export function usageHint(command: string): string | undefined {
  if (looksLikeProse(command)) return undefined;
  const words = command.trim().toLowerCase().replace(/^\//, "").split(/\s+/);
  const verb = words[0];
  if (!verb) return undefined;
  // `build tension`, `drop bass`, `form a hook`: everyday words, so only
  // arguments that look like the grammar earn a usage hint; the rest is
  // a request for the agent.
  if (
    ARRANGE_VERBS.has(verb) &&
    !command.trim().startsWith("/") &&
    !words.slice(1).some((word) => /\d/.test(word) || ARRANGE_WORDS.has(word))
  )
    return undefined;
  const usage = USAGE[verb];
  return usage === undefined ? undefined : usageForm(usage);
}

/**
 * Every usage line reads `usage · <cmd> <args>`; a range refusal keeps
 * its own template (`pan takes -1…1 · pan -0.5`).
 */
export function usageForm(usage: string): string {
  return / takes /.test(usage) || usage.startsWith("usage · ")
    ? usage
    : `usage · ${usage}`;
}

const ARRANGE_VERBS: ReadonlySet<string> = new Set([
  "build",
  "drop",
  "fill",
  "form",
]);
const ARRANGE_WORDS: ReadonlySet<string> = new Set([
  "at",
  "into",
  "cut",
  "no",
  "impact",
  "crash",
  "riser",
  "roll",
  "sweep",
  "uplifter",
  "toms",
  "kick",
  "beats",
  "bars",
  "bake",
  "off",
]);

/** The overlay title for `/help [topic]`: an alias shows its topic. */
export function helpTitle(topic: string | undefined): string {
  const name = topic?.trim().toLowerCase().replace(/^\//, "");
  if (!name) return "help";
  const spelled = HELP_COMMAND_ALIASES[name];
  if (spelled) return `help · ${spelled}`;
  const id = (TOPICS as readonly string[]).includes(name)
    ? name
    : USAGE[name] || commandHelpExists(name)
      ? name
      : (resolveTopic(name) ?? name);
  return `help · ${id}`;
}

function commandHelpExists(name: string): boolean {
  return HELP_SECTIONS.some((section) =>
    section.entries.some((entry) =>
      entry.command.replace(/^\//, "").startsWith(`${name} `),
    ),
  );
}

/** `no topic X · did you mean Y · /help`, for `/help X` with no page. */
export function helpMiss(topic: string): string {
  return topicMiss(topic, ["all"]);
}
