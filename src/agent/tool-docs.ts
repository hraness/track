/**
 * The long form of the agent tool descriptions: examples, preset lists and
 * edge cases that used to sit in each tool description. The tool catalog the
 * model reads every step (chatTools, renderToolCatalog) keeps one or two
 * sentences per tool so it stays under CATALOG_BUDGET; this map is the
 * reference the agent docs lens renders (guides, DAWG.md tool pages).
 *
 * Pure data with no imports, so any tool file can read it without a cycle.
 */

export type AgentToolDoc = Readonly<{
  /** Prose beyond the catalog description: presets, ranges, pitfalls. */
  details?: string;
  /** One representative arguments object. */
  example?: Readonly<Record<string, unknown>>;
}>;

export const AGENT_TOOL_DOCS: Readonly<Record<string, AgentToolDoc>> =
  Object.freeze({
    update_notes: {
      details:
        "Move, resize, transpose, re-velocity or detune existing notes by id. Times are in beats. To transpose, prefer transpose (semitones relative to the note's current pitch, e.g. 2 up a whole step, -12 down an octave) over an absolute pitch.",
    },
    set_instrument: {
      details:
        "Change a track's instrument voice. Mallets and bells (modal): modal (marimba) vibes xylophone glock celesta chimes kalimba mbira steelpan bowl gong timpani, gamelan saron gangsa bonang …; set_modal shapes them. Electric keys: epiano suitcase dyno wurli clav funkclav (set_keys). Winds and brass (wind engine): flute recorder clarinet oboe bassoon sax trumpet trombone tuba horn …; set_wind shapes them.",
    },
    set_automation: {
      details:
        "Write an automation lane: volume 0..1, pan -1..1, filter (cutoff Hz), resonance 0..1, delay-feedback 0..0.9, delay-mix, wt (wavetable position 0..1), or <effect>-<param> (the param's range). The effect must be on to be heard. mode=replace (default) rewrites the lane; merge keeps other beats. An empty replace clears it.",
    },
    set_rig: {
      details:
        "Guitar rig on a track (stomp → amp head with noise gate → speaker cab, before tremolo). rig loads a whole rig (clean crunch punk ragged lead metal fuzz octave funk wah bachata spring bassdrive reese jangle alt, and the shoegaze rigs shoegaze glide dreampop swell ebow that add wobble/bloom/swell/double and a long reverb) or reset removes it; stomp/head/cab set stage params (stomp type fuzz|face|od|rat|octave gain tone level; head type clean|chime|crunch|lead|high|solid|bass gain bass mid treble presence master sag gate(dB); cab type 1x12|2x12|4x12|1x10|open|8x10|1x15|di mic), or null removes a stage. Heads are level-matched. `amp` is Strudel gain, not this.",
    },
    set_synth: {
      details:
        "Shape a synth track's voice with Strudel synth params (attack decay sustain release, lpf lpq lpenv, fm fmh, unison detune spread, vib vibmod, penv, noise, pw…); null unsets one. preset loads a voice (instrument + params); reset clears all; zzfx takes a raw ZzFX array (empty slots null) and sets a z_* sound.",
    },
    set_string: {
      details:
        "Make a track a plucked, struck or bowed string (physical model). Bowed presets (exciter bow): violin viola cello contrabass fiddle erhu kamancheh, sections violins violas cellos contrabasses, pizz trem. preset picks the instrument; params override it (ring s, bright, damp, pos, mute, buzz = jawari, body, sym = sympathetic strings, stiff, exciter pick|finger|hammer|noise|bow); null unsets one. Bowed presets take pressure speed attack vib vibmod vibdelay tremhz sord dyn. reset keeps the preset and drops overrides; off returns the track to a plain pluck voice.",
    },
    set_keys: {
      details:
        'Shape a modeled piano, electric keys (epiano wurli clav) or organ: preset (instrument, keys and its effects), params hardness decay release felt… (pianos: sym 0.5 adds sympathetic bloom under the sustain pedal, good for Chopin and Debussy; epiano: bark bell tone vibe; wurli: trem; clav: pickup mute; null unsets; DAWG.md lists all), or reset. Stored "piano" stays legacy; set_instrument piano writes grand. Organs (not "organ", a legacy synth): presets tonewheel combo pipe… (aliases hammond b3 farfisa church); drawbars "888800008", registers "08880", stops (plenum, flute8…), rotary; params perc percdecay percvol click scanner drive (tonewheel), voice vib vibmod drive (combo), chiff wind trem (pipe). A row the family does not read is refused.',
    },
    set_modal: {
      details:
        "Mallets and bells on the modal engine: preset (marimba vibes xylophone glock celesta chimes kalimba mbira steelpan bowl gong timpani) switches the voice and keeps overrides (gamelan: crotales musicbox toypiano saron demung slenthem gangsa gender bonang kenong kethuk kempul; frame drums daf bodhran tabla); mallet yarn|cord|rubber|plastic|brass; params sets MODAL_PARAMS (hardness position ring tilt release damp motor motordepth ombak buzz click strikebend strikedecay gain), null returns one to the preset; pair names a partner modal track: this track (pengisep) sounds ombak Hz above it and the partner (pengumbang) gets ombak 0, null unpairs; reset clears overrides. Turns the track into instrument modal.",
    },
    set_wind: {
      details:
        "Winds and brass on the wind engine (breath-driven waveguides): preset (flute recorder whistle ney shakuhachi panpipe suling bansuri clarinet bassclarinet oboe bassoon sax altosax barisax trumpet harmon plunger trombone tuba horn) switches the voice and keeps overrides; params sets WIND_PARAMS (breath bright mute players growl noise attack release vib vibmod reed stopped wah wahenv flutter gain model), null returns one to the preset; players 2..8 is a section that spreads over chord tones; reset clears overrides; off returns to the legacy wind tone. Lines slur by default (a note that starts while one note is held is not re-tongued). Turns the track into the wind engine.",
    },
    set_sample: {
      details:
        "Set a sampler voice's Strudel sample controls: begin end gain speed unit(r|c|s) loop loopBegin loopEnd clip(legato) fit loopAt accelerate squiz cut, and (0.6.1) shift (semitones, length kept) formant (0 keeps the voice's formants) fadeInTime fadeTime (seconds), vel [lo,hi] (velocity layer) rr (round-robin group). null unsets one.",
    },
    fit_sample: {
      details:
        "Fit a sampler voice to the song's tempo map (ramps included): bpm is the sample's own tempo (20..400), len its length in beats; fitmode repitch (tape: pitch moves with speed, default) | beats (drums, speech: onset slices placed on time, unstretched) | tones (pads, vocals: phase-vocoder stretch, pitch kept). fit on > bpm > len. null unsets one. Song tempo is set_tempo, not this.",
    },
    edit_file: {
      details:
        "Replace one exact occurrence of old with new in a writable file (same scope as write_file). old must match exactly once; otherwise the result tells you the count. Prefer this over many note tools for large edits or restructuring of tracks/<slug>/track.ts.",
    },
    glob: {
      details:
        "Patterns match paths relative to path: tracks/*/track.ts, **/*.wav, samples/**. An absolute path inside a read root (.dawg/agent.json readRoots, set by the human) searches there, read-only. Results page with cursor; a scan stops at 20 000 entries.",
      example: { pattern: "tracks/**/*.wav" },
    },
    grep: {
      details:
        "pattern is a JavaScript regular expression tested per line; files over 1 MiB and binary files are skipped. glob filters by file name (*.ts) or, with a slash, by path. Page with cursor when the result says more.",
      example: { pattern: "setInstrument\\(", glob: "*.ts" },
    },
    inspect: {
      details:
        "The cheap way to look closely without growing the brief. score: tempo, meter, sections and one line per track (instrument, notes, bars used, range, level), about 1.5 KiB. track: the track's non-default settings with automation lanes as point counts. notes: id pitch bar.beat beats vel, 32 per page, bars \"5-8\" narrows. mix: levels, pan, sends and fx per track plus the master. sections: bars, mutes, form and loop. patch: a library patch's nodes, cables and macros, or the patch a track plays. sample: format, rate, channels, length, peak and RMS of a project or read-root WAV. Results that page end with (N more; cursor=K); pass cursor to continue.",
      example: { what: "notes", target: "bass", bars: "1-4" },
    },
    move_file: {
      details:
        "Both paths must be writable (the whole project except .dawg/, .git/, node_modules/; a dispatch task only its files). The target must not exist. Moving a track.ts reloads the project like a write.",
    },
    delete_file: {
      details:
        "The file is copied to .dawg/trash/<time>/<path> before it is removed; that copy is the recovery (there is no file-level undo). Score changes from deleting a track source are undoable as score edits.",
    },
    set_rhythm: {
      details:
        "Preferred for drums: one row per voice of a kit/oneshot track; its notes regenerate from the row. pulses (4) over steps (16..64) Euclidean, rotate later; division 1/32..1/1 (1/16) is one step, and the steps×division cycle repeats from beat 0 to fill the loop (E(4,16) at 1/16 = a hit every beat, four on the floor; a backbeat on counts 2 and 4 is grid '....x.......x...' or E(2,16) rotate 4; offbeat 'and's are grid '..x.' ); grid 'x.X.' explicit (X accent); repeats 0..16 after each pulse every time, pace -1..1, ramp -1..1; velocity (0.8); accent 0..1 on E(accents,pulses); gate; legato; probability+seed; swing/nudge ±0.5 step; cycles [{pulses,rotate,repeats,probability,velocity}] per pass. remove [voices] (freeze keeps notes).",
    },
    suggest_progression: {
      details:
        "Read-only: voice-led diatonic chords (name, numeral, voicing, bass). style pop|jazz|modal|classical walks a seeded harmony graph; or a preset axis|sad-pop|fifties|ii-v-i|turnaround|canon|aeolian|andalusian|minor-ii-v|dorian-vamp|mixolydian-rock. length ≤32.",
    },
    write_chords: {
      details:
        "Write voice-led chords to a track (one bar each by default), with optional bass here or on bassTrackId. perform pattern uses pattern eighths|sixteenths|offbeat|pop|charleston|bossa|skank|gallop|half-time|tresillo|oom-pah|roll|pick. bassMode off|chords|unison|single|solo (solo: bass only). ≤512 notes.",
    },
    strum_chords: {
      details:
        "Strum chords as fretted guitar notes (set_guitar). chords omitted strums the track's block chords. strokes down|folk|pop|punk|funk|reggae|waltz|jangle|island or a DUdux-. grid; speed ms/stroke (22); step grid beats; each beats/chord (a bar).",
    },
    set_guitar: {
      details:
        'Guitar fretting for strum: tune standard|dropd|doubledropd|dadgad|openg|opend|opene|halfdown|nashville|bass|ukulele|requinto or notes low-high ("D A D G A D"), capo 0..12, hand 3..6 frets, ring 0..1, position 0..12, reset.',
    },
    set_expression: {
      details:
        "Per-note expression on noteIds, or on trackId's notes starting in [fromBeat, toBeat); null clears. articulation: staccato halves length, legato holds to the next note, accent/marcato louder, ghost quiet. glide: seconds sliding in from the previous pitch. bend: [{at 0..1, cents}] or scoop|fall|doit. vibrato: {rate Hz, depth cents, delay s}. humanize: {timing ms, velocity %, length %} for just these notes, replacing the track's amounts ({} keeps them exact). Overrides the synth's slide, penv, vib. On a legato-glide track a note glides when it overlaps the previous one (use articulation legato), or, with its own glide, when the previous note ends at most a 16th step earlier (a TB-303 slide; a longer rest never slides).",
    },
    set_performance: {
      details:
        'A track\'s performance; null clears. glide: {time s, mode legato|mono|poly}: legato slides only between overlapping notes without retriggering (TB-303), mono always slides, poly slides every voice. pedal: [{beat, state down|half|up}] or "bars" to re-pedal each bar. velocityCurve: {curve linear|soft|hard|fixed, fixed 0..1}. humanize: {timing ms, velocity %, length %, seed} applied at render; keep the seed for the same take.',
    },
    set_tuning: {
      details:
        "Set the song tuning (every track follows it) or one track's own tuning: a library tuning by name, n-EDO, just ratios, cents, or a Scala .scl/.kbm file in the project; plus A4 reference, root key and key mapping. off returns to 12-TET (track: follows the song). Note-level detune is add_notes cents.",
    },
    set_scale: {
      details:
        "Set the song key and scale: a church mode, harmonic or melodic minor, pentatonic, blues, maqam (hijaz, bayati), raga (yaman, bhairav, kafi…) or a Messiaen mode. Chords, play-mode keys and scale snapping follow it. Scales with microtones or just intonation pair with set_tuning name=<scale>.",
    },
    set_calibration: {
      details:
        "Set the song's sound calibration: 1 (latest) chokes the open hat, tunes GM toms, adds crash, ride and cowbell, levels keys presets and steadies lip brass; 0 keeps the legacy 0.4 to 0.6.1 sound byte-identical. New songs start at the latest.",
    },
    set_time: {
      details:
        "Tempo map and meter: action tempo (bpm at beat|bar; ramp linear|exp glides into it), rit/accel (bars or beats long, optional target bpm and start; default 75%/133% over the last 2 bars), a_tempo/tempo_primo (step back to the tempo before the last rit/accel, or to the start tempo; at the bar after it unless beat|bar), fermata (hold beat|bar for beats extra beats), meter ('7/8' from bar, or the whole song without bar), remove_tempo/remove_fermata/remove_meter, clear (what: tempo|meter|fermatas|track|all). Per-track polytempo/polymeter: action track with rate (tempo ratio, 1.5 = three against two), phase (beats later) and cycle (beats per repeat), null resets one; action phasing (cycle beats, over beats, cycles n) sets a continuous drift that realigns at the loop end (over must divide the loop); with hold/drift (whole cycles) and shift (beats, default 0.25) it is stepped, as in Piano Phase: hold in step, then move shift ahead over drift cycles. Beats count from 0, bars from 1.",
    },
    edit_section: {
      details:
        "Arrange song sections (named bar ranges; bars count from 1). mark names bars fromBar..fromBar+bars-1 without moving music; add appends empty bars as a new section; duplicate copies a section's music after it; move moves its music (toBar, before or after a section); rename; delete removes its bars and music; unmark drops only the name; mute/unmute silences tracks in it; vary sets a track's transpose (semitones) and gain (0..2) in it (neither: clears); reset clears mutes and variations; loop makes playback cycle it; unloop plays the song.",
    },
    set_form: {
      details:
        'Set the song form: the order sections play in, with repeats, e.g. "intro verse chorus*2 verse chorus outro" (commas when a name has spaces). Playback and export follow it. An empty string clears it; bake writes the form out as plain bars (sections laid end to end) and clears it.',
    },
    add_transition: {
      details:
        "Generate a transition with the built-in voices (bars count from 1). build: noise riser, accelerating snare roll, filter sweep and uplifter (all on by default), landing on the bar after its range. The range is `bars` bars (default 4) just before section `into` (the usual build into a drop or chorus); or a section's own bars (its last `bars` bars when bars is given); or `bars` bars starting at atBar; default the song's last 4 bars. The sweep is a high-pass rising to 1.2 kHz on pitched tracks (a low-pass opening from cutoff/10 on low-pass tracks), snapping back on the downbeat. drop: a pre-drop cut (cutBeats of silence, default 1, up to two bars) and an impact hit on the section's first bar or atBar (default: the section named drop, else chorus). fill: a drum fill (toms, roll, kick) in the last beats (default 1, 0.5 up to two bars) leading into the section or into atBar, plus a crash on its downbeat. Without section or atBar, fills go at every section boundary. Out-of-range values are clamped.",
    },
    edit_range: {
      details:
        "Edit bar ranges (bars count from 1; a range is fromBar..toBar or a section name). loop sets the loop range playback cycles (no section is made); unloop plays the song. copy copies a track's (or allTracks') notes, automation and clips in the range to atBar, overwriting there (merge keeps what is there; insert shifts later music right), times tiles it end to end. move is copy plus clearing the source. clear empties the range (the bars stay). reverse mirrors it in time. insert_bars adds `bars` empty bars at atBar and moves later sections, clips, automation and tempo points right; remove_bars cuts the range out. split cuts a section in two at atBar; join merges a section with the one after it. Each call is one undo step and runs the same command the prompt does.",
    },
    download_audio: {
      details:
        "Download the audio of a YouTube video as a wav into the focused track's downloads/ folder (with a .json sidecar: title, duration, source, sha256). YouTube URLs only; 500 MiB and 15 minutes of wall time at most. Check the brief's downloads list first so the same video is never fetched twice.",
    },
    split_stems: {
      details:
        "Separate a downloaded wav into six stems (vocals, drums, bass, guitar, piano, other) in <file>.stems/. Uses a local StemDeck when one is running, otherwise demucs htdemucs_6s (up to 20 minutes; the first run downloads the model).",
    },
    transcribe_notes: {
      details:
        'Transcribe a stem to notes. kind=drums classifies kick/snare/hat/… hits; other kinds run basic-pitch. Returns up to 2048 timed notes and a quantized snippet (note("A1", startBeat, lengthBeats, velocity) or hit("kick", beat)) aligned to the file\'s beat grid; use from/to (seconds) to transcribe one section.',
    },
    make_wavetable: {
      details:
        "Make a wavetable from any audio file in the project (download, stem, imported sample): writes tracks/<slug>/wavetables/<name>.wav (float32, 2048-sample frames) and reports the detected pitch, method and how the timbre moves across the frames. Region defaults to the most stable tonal 2 s; method auto picks slice (pitched single cycles) or spectral (vocals, pads, noise). Then set_wavetable with that path as table.",
    },
    use_sound: {
      details:
        'Put a pack sound on a track through the sampler. sound is <pack>/<sound>[:<n>] (n picks a file, like Strudel s("bd:3")), a kit/bank name or Strudel bank nickname (909, 808, linn, TR909, tr808, sp12, dmx, RolandTR909, tidal-drum-machines/RolandTR707) to load a whole kit, or a keyed instrument such as gm/gm_acoustic_grand_piano or piano/piano. The file is fetched and pinned by sha256 so renders stay reproducible. Drum hits on the track keep playing the matching kit voice.',
    },
    set_wavetable: {
      details:
        "Make a track a wavetable synth and shape it (Strudel names). table: basic (sine>tri>saw>square), pwm, formant, harmonics (offline), wt_digital:0-4, wt_vgame:0-10 (Strudel uzu-wavetables), pack:<pack>/<sound>[:n], or a project table from make_wavetable (tracks/<slug>/wavetables/<name>.wav); omit to keep. wt: position 0..1. wtenv/wtattack/wtdecay/wtsustain/wtrelease: position envelope (amount -1..1, seconds). wtrate Hz/wtdepth: position LFO. warp+warpmode bend the phase. wtphaserand: start phase spread. Automate position with set_automation wt.",
    },
    set_master: {
      details:
        "Edit the song master (after every track and bus) and its loudness target. Units run eq, glue, tape, width, limiter; each takes false (remove), true (defaults), a preset or {param: value}; omitted units stay. A named target (streaming -14, apple -16, podcast -16, broadcast -23, club -8, loud -6, classical -20, ambient -18) also sets the limiter. off:true removes the master.",
    },
    measure_mix: {
      details:
        "Render and measure the song (read-only): integrated, short-term and momentary LUFS, loudness range, true peak, PLR, band balance (dB share), stereo correlation and side level, after the master. bypass_master:true measures before it.",
    },
    patch_edit: {
      details:
        'Edit a track\'s modular patch, or an effect patch (fx). ops run in order as one undo step; a bad op rejects all. Ops mirror typed `patch` lines: new {name, role?, from?}, add {type, id?, params?}, set {id, params}, wire {from, to, amount?} (node.port), unwire {from, to}, macro {id, targets:["node.port[:min..max]"], label?} (knobs 1-4 first), knob {id, value}, rate {id, rate}, rm {id}, convert, detach, load {name}, save {name}. Boundary ports: in.notes/audio/right/side, out.audio/right, voice.pitch/gate/velocity/note, song.beat/tempo. show:true reads it as lines.',
    },
    list_styles: {
      details:
        "Browse the style taxonomy (read-only). query: ranked search over ids, names, aliases and regions. parent: the children of one style id. Neither: the families and their root styles. Returns ids to pass to style_info and apply_style.",
    },
    apply_style: {
      details:
        "Replace the whole song with one generated from a style: drums, bass, harmony, melody and form from the style's patterns (one undo step). bars 1..64 (default 8); seed picks a variation (same seed, same song). blend + weight (0 is id, 1 is blend) mixes two styles.",
    },
    set_granular: {
      details:
        "Make a track a granular instrument (offline, nothing to download) or shape it. preset: cloud hold sparkle swarm stutter microloop backwards dust. src: a built-in synth source synth:<pad|lead|pluck|bass|sub|acid|keys|bell|…>[@note]; on a sampler track the first (or named voice) sample is the source. params (null unsets): grain s, overlap, scan (head speed, 0 held), pos, begin, end, spray, jitter, pitch st, detune, shimmer, shimint, spread, window (hann tukey gauss tri perc rperc), reverse 0..1, freeze, repeat, hold, drift, drate, attack, release, veltone, gain, seed, root. reset keeps preset and source; off returns to the previous voice.",
    },
    resample: {
      details:
        "Bounce a track (default focused), an orbit (no master) or the master over the song, a section or bars [first,last] to a pinned WAV, adding a one-shot sampler track that plays it in place; grain adds a granular track instead; post keeps the master chain.",
    },
    place_clip: {
      details:
        "Place an audio file already in the project (an import_sample result, a split_stems stem such as tracks/<slug>/downloads/<song>.stems/vocals.wav) as a clip on a track at a beat. Pins the file's sha256 and sets clip gain so the file peaks at -6 dBFS. Clips sum before the track's effects; on a `vocal` track the notes are silent guides. Optional offset and dur (seconds into the file), gain (dB -60..12, overrides the -6 dBFS level; the project stores it linear), fadeIn/fadeOut (seconds, equal-power; stored as fadeInTime/fadeTime), rev.",
    },
    edit_clip: {
      details:
        "Edit a clip on a track by id: at (beats), gain (dB -60..12; 0 removes; stored linear), fadeIn/fadeOut (seconds, equal-power; stored as fadeInTime/fadeTime), offset/dur (seconds into the file; dur null plays to the end), rev, mute, split (a beat: cuts the clip in two there with 5 ms fades, the tail gets a new id), repeat {every, until} in beats (writes copies <id>-r2, -r3...), remove.",
    },
    set_lyrics: {
      details:
        "Put lyrics on a track's notes in time order (chords sing on their top note): spaces separate syllables, hyphens split words (nev-er), _ holds the previous syllable over a note (melisma), ~ skips a note. Words typed whole are split automatically when there are more notes than syllables. from (beats) starts later; clear removes lyrics from there on. Lyrics are text on notes; they guide sing and future TTS and show on the highway.",
    },
    set_formant: {
      details:
        "Shift a track's formants at constant pitch (the throat or gender knob; works on any source, voices most of all): shift -12..12 semitones (negative deeper or bigger, positive smaller or younger; 2-4 is natural, 7+ is a cartoon), mix 0..1 (default 1); preset deep giant bright tiny; off removes it. Automatable as lanes formant-shift and formant-mix. The vowel filter is set_fx vowel (vowel, to, morph 0..1 morphs between two vowels; lane vowel-morph).",
    },
    set_sing: {
      details:
        "The built-in singing voice (a synthetic LF glottal source through Klatt formants; no recorded or cloned voice). preset (aah ooh choir oohchoir chorale airy glass lament soprano basso drone khoomei sygyt kargyraa) switches the voice and keeps overrides; params sets voice vowel morph formant bright breath jitter shimmer attack release vib vibmod vibdelay voices spread ring drone overtone sub gain, null returns one to the preset; voices 2..8 is an ensemble (choir); vowel is a e i o u or a morph a>o; drone (a note name like D3 or a MIDI number) turns on throat singing: khoomei, sygyt (whistle) and kargyraa (sub-octave growl) pick a harmonic of the drone per note. A throat preset on a track with no notes writes a short demo melody (8 notes an octave above the drone); write your own notes instead when you have a melody. reset clears overrides; off removes the voice. Notes sing their vowel (set_vowels) or their lyric's vowel. Turns the track into the sing engine.",
    },
    set_vowels: {
      details:
        "Set the sung vowel of a sing track's notes (set_sing). vowels: a list cycled over the notes in time order, each a e i o u (also ah eh ee oh oo) or a morph like a>u that travels through the note; noteIds limits it to those notes; vowels [] or null clears them so notes sing their lyric's vowel or the track's vowel.",
    },
    set_vocoder: {
      details:
        "Put a vocoder on a track (the carrier: its synth, sampler or the built-in `vocoder` instrument) or change it. To vocode a vocal, create_track with instrument vocoder, then set_vocoder src <vocal>. src is the modulator track, usually a vocal (id or name slug). preset (classic robot talkbox choir glass whisper smear lofi) keeps overrides; params sets VOCODER_PARAMS keys, null returns one to the preset; reset drops every override (keeps src and preset); off removes the vocoder. The modulator is heard even when muted. Returns a cost hint and the modulator's license. Vocode only the user's own or licensed audio.",
    },
    autotune_vocal: {
      details:
        "Pitch correction on a track's audio (its clips and sampler voices), gentle to hard. preset: hard (instant stepped notes), robot (stepped on every tuning step), warble (hard with synthetic vibrato), trap (fast, glossy), pop (default: polished but sung), natural, gentle (keeps vibrato), guided (follows guide notes), locked (follows notes exactly). params override one field, null returns it to the preset: to scale|chromatic|chord|notes (scale: key or the song key and tuning, so maqam, raga and n-EDO work; chromatic without a key; chord: the chord timeline; notes: `from` or the track's own notes), from <trackId>, key (e.g. 'D bayati'), speed ms (0 instant), relax 0..1, hold ms, flex 0..100 (Antares-style: bends wider than flex cents pass), glide ms (0..500), amount 0..1, vib Hz, vibmod semitones, center 0..1, drift 0..1, voice auto|bass|tenor|alto|soprano. reset drops overrides; off removes it. Unsure of the key? analyze_pitch first. Never fetch an artist's vocal to imitate.",
    },
    dispatch: {
      details:
        "Fan independent work out to subagents that run in parallel on the same provider (the fast model unless model is set). Give each task its own tracks: two tasks naming the same track, a .dawg/ glob, or two global tasks are refused before anything runs. tracks [] means the task may only add new tracks. bars A-B limits its note edits; files adds writable project globs on top of its tracks' tracks/<slug>/**; global lets one task change tempo, meter, form, master or tuning. Each child has 6 steps and 16 tool calls, no transport, no nested dispatch and no trusted exec; Esc cancels them all and the whole dispatch stops after 5 minutes. Every child edit is its own revision, attributed [task-id], and undoable on its own. When another edit touched the same notes or track settings first, the child's edit is not forced: the task reports conflict with the reason. Use it for 2-4 genuinely separate parts (drums, bass, keys); do sequential or dependent edits yourself.",
      example: {
        tasks: [
          {
            id: "drums",
            prompt: "a half-time groove, bars 1-8",
            tracks: ["drums"],
          },
          {
            id: "bass",
            prompt: "a root-fifth bass under the chords",
            tracks: ["bass"],
          },
        ],
      },
    },
    preview_sound: {
      details:
        "Hear a track, or a candidate sound change, without committing it. changes: sound tool calls to try ({tool, args} for set_fx, set_rig, set_synth, set_string, set_modal, set_wind, set_wavetable, set_instrument, set_sample, fit_sample, set_mix, set_automation, set_drum_kit, use_sound), applied to a copy. Renders the track's notes over up to 4 bars (or a short phrase by role when it has none), solo or in context, and returns RMS/peak dBFS, spectral centroid and a one-line description for the current and the candidate sound. When the user's window is open it plays the snippet once. Then commit with the normal tools if it sounds right.",
    },
  });

/** The reference text for one tool: its details, else nothing. */
export function toolDetails(name: string): string | undefined {
  return AGENT_TOOL_DOCS[name]?.details;
}
