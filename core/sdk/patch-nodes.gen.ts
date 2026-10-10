/**
 * Patch node types for the SDK, generated from NODE_SPECS
 * (core/patch-nodes.ts) by scripts/gen-patch-sdk.ts. Do not edit: the same
 * block is spliced into core/sdk/v1.ts, which stays a single vendored file.
 */

// BEGIN patch nodes: generated from core/patch-nodes.ts by scripts/gen-patch-sdk.ts

/** Port codes: `n` notes, `a` audio, `c` control, `ca` control that also takes audio. */
export type PatchPortCode = "n" | "a" | "c" | "ca";

/** Every patch node type: its main output's port code, settings, input ports and output ports (NODE_SPECS). */
export type PatchNodeTable = {
  /** oscillator: sine, saw, square, triangle or pulse, with linear FM */
  osc: {
    main: "a";
    params: {
      /** waveform (saw, square and pulse are band-limited with PolyBLEP) (default "saw") */
      wave?: "sine" | "saw" | "square" | "tri" | "pulse";
      /** frequency in Hz (wire voice.pitch to play the note) (0..20000 Hz, default 440) */
      pitch?: number;
      /** detune in cents (-1200..1200 ct, default 0) */
      detune?: number;
      /** pulse width (pulse wave) (0.01..0.99, default 0.5) */
      pw?: number;
      /** output level (0..4, default 1) */
      level?: number;
    };
    inputs: {
      /** frequency in Hz (wire voice.pitch to play the note) */
      pitch: "ca";
      /** detune in cents */
      detune: "c";
      /** pulse width (pulse wave) */
      pw: "c";
      /** linear FM: Hz added to the pitch, at audio rate */
      fm: "a";
      /** output level */
      level: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** seeded noise: white, pink or brown */
  noise: {
    main: "a";
    params: {
      /** noise color (default "white") */
      color?: "white" | "pink" | "brown";
      /** output level (0..4, default 1) */
      level?: number;
    };
    inputs: {
      /** output level */
      level: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** state-variable filter (TPT): low, high, band or notch */
  svf: {
    main: "a";
    params: {
      /** filter response (default "lp") */
      mode?: "lp" | "hp" | "bp" | "notch";
      /** cutoff frequency in Hz (20..20000 Hz, default 1000) */
      cutoff?: number;
      /** resonance 0..1 (0..1, default 0.5) */
      q?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** cutoff frequency in Hz */
      cutoff: "c";
      /** resonance 0..1 */
      q: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** one-pole low- or high-pass (6 dB/oct) */
  onepole: {
    main: "a";
    params: {
      /** filter response (default "lp") */
      mode?: "lp" | "hp";
      /** cutoff frequency in Hz (20..20000 Hz, default 1000) */
      cutoff?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** cutoff frequency in Hz */
      cutoff: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** attack, decay, sustain, release envelope 0..1, opened by a gate */
  adsr: {
    main: "c";
    params: {
      /** gate: above 0.5 opens (wire voice.gate) (0..1, default 0) */
      gate?: number;
      /** attack time (0..10 s, default 0.01) */
      attack?: number;
      /** decay time (0..10 s, default 0.1) */
      decay?: number;
      /** sustain level (0..1, default 0.7) */
      sustain?: number;
      /** release time (0..10 s, default 0.2) */
      release?: number;
    };
    inputs: {
      /** gate: above 0.5 opens (wire voice.gate) */
      gate: "c";
      /** attack time */
      attack: "c";
      /** decay time */
      decay: "c";
      /** sustain level */
      sustain: "c";
      /** release time */
      release: "c";
    };
    outputs: {
      /** envelope 0..1 */
      out: "c";
    };
  };
  /** attack-release envelope 0..1 that follows a gate */
  ar: {
    main: "c";
    params: {
      /** gate: above 0.5 opens (0..1, default 0) */
      gate?: number;
      /** attack time (0..10 s, default 0.01) */
      attack?: number;
      /** release time (0..10 s, default 0.2) */
      release?: number;
    };
    inputs: {
      /** gate: above 0.5 opens */
      gate: "c";
      /** attack time */
      attack: "c";
      /** release time */
      release: "c";
    };
    outputs: {
      /** envelope 0..1 */
      out: "c";
    };
  };
  /** slew limiter: glides a control toward its input */
  slew: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
      /** time to rise by one unit (0..10 s, default 0.05) */
      rise?: number;
      /** time to fall by one unit (0..10 s, default 0.05) */
      fall?: number;
    };
    inputs: {
      /** input */
      in: "c";
      /** time to rise by one unit */
      rise: "c";
      /** time to fall by one unit */
      fall: "c";
    };
    outputs: {
      /** slewed value */
      out: "c";
    };
  };
  /** envelope follower: the level of an audio signal as a control */
  follow: {
    main: "c";
    params: {
      /** attack time (0.0001..1 s, default 0.005) */
      attack?: number;
      /** release time (0.001..4 s, default 0.1) */
      release?: number;
    };
    inputs: {
      /** audio to follow */
      in: "a";
      /** attack time */
      attack: "c";
      /** release time */
      release: "c";
    };
    outputs: {
      /** level 0..1 */
      out: "c";
    };
  };
  /** low-frequency oscillator -1..1, free in Hz or synced to beats */
  lfo: {
    main: "c";
    params: {
      /** wave shape (random is seeded sample-and-hold per cycle) (default "sine") */
      shape?: "sine" | "tri" | "square" | "saw" | "ramp" | "random";
      /** period in beats; 0 follows rate (0..64 beats, default 0) */
      sync?: number;
      /** rate in Hz (when sync is 0) (0..100 Hz, default 1) */
      rate?: number;
      /** phase offset in cycles (0..1, default 0) */
      phase?: number;
      /** output depth (0..1, default 1) */
      depth?: number;
    };
    inputs: {
      /** rate in Hz (when sync is 0) */
      rate: "c";
      /** phase offset in cycles */
      phase: "c";
      /** output depth */
      depth: "c";
    };
    outputs: {
      /** -1..1 */
      out: "c";
    };
  };
  /** sample and hold: latches its input when the trigger rises */
  sh: {
    main: "c";
    params: {
      /** value to sample (-1000000..1000000, default 0) */
      in?: number;
      /** trigger: a rise through 0.5 samples (0..1, default 0) */
      trig?: number;
    };
    inputs: {
      /** value to sample */
      in: "c";
      /** trigger: a rise through 0.5 samples */
      trig: "c";
    };
    outputs: {
      /** held value */
      out: "c";
    };
  };
  /** seeded random value 0..1, drawn per note or per block */
  random: {
    main: "c";
    params: {
      /** when a new value is drawn (default "note") */
      per?: "note" | "block";
    };
    inputs: {};
    outputs: {
      /** 0..1 */
      out: "c";
    };
  };
  /** a constant control value */
  const: {
    main: "c";
    params: {
      /** the value (-1000000..1000000, default 0) */
      value?: number;
    };
    inputs: {};
    outputs: {
      /** the value */
      out: "c";
    };
  };
  /** a + b */
  add: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** a × b */
  mul: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 1) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** the smaller of a and b */
  min: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** the larger of a and b */
  max: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** 1 when a > b, else 0 */
  gt: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** 1 when a < b, else 0 */
  lt: {
    main: "c";
    params: {
      /** first operand (-1000000..1000000, default 0) */
      a?: number;
      /** second operand (-1000000..1000000, default 0) */
      b?: number;
    };
    inputs: {
      /** first operand */
      a: "c";
      /** second operand */
      b: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** |in| */
  abs: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
    };
    inputs: {
      /** input */
      in: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** 1 when in < 0.5, else 0 */
  not: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
    };
    inputs: {
      /** input */
      in: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** MIDI note number to Hz (12-TET, A4 = 440) */
  pitch2hz: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
    };
    inputs: {
      /** input */
      in: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** decibels to linear gain */
  db2gain: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
    };
    inputs: {
      /** input */
      in: "c";
    };
    outputs: {
      /** result */
      out: "c";
    };
  };
  /** maps in from [inmin, inmax] to [min, max], linear or exponential */
  scale: {
    main: "c";
    params: {
      /** lin or exp (exp needs min > 0) (default "lin") */
      curve?: "lin" | "exp";
      /** input (-1000000..1000000, default 0) */
      in?: number;
      /** input range low (-1000000..1000000, default -1) */
      inmin?: number;
      /** input range high (-1000000..1000000, default 1) */
      inmax?: number;
      /** output range low (-1000000..1000000, default 0) */
      min?: number;
      /** output range high (-1000000..1000000, default 1) */
      max?: number;
    };
    inputs: {
      /** input */
      in: "c";
      /** input range low */
      inmin: "c";
      /** input range high */
      inmax: "c";
      /** output range low */
      min: "c";
      /** output range high */
      max: "c";
    };
    outputs: {
      /** mapped value */
      out: "c";
    };
  };
  /** limits in to [min, max] */
  clamp: {
    main: "c";
    params: {
      /** input (-1000000..1000000, default 0) */
      in?: number;
      /** low limit (-1000000..1000000, default 0) */
      min?: number;
      /** high limit (-1000000..1000000, default 1) */
      max?: number;
    };
    inputs: {
      /** input */
      in: "c";
      /** low limit */
      min: "c";
      /** high limit */
      max: "c";
    };
    outputs: {
      /** clamped value */
      out: "c";
    };
  };
  /** tempo-synced gate: high for the first half of each cycle */
  clock: {
    main: "c";
    params: {
      /** period in beats (0.0625..64 beats, default 1) */
      beats?: number;
      /** high fraction (0.01..0.99, default 0.5) */
      width?: number;
    };
    inputs: {
      /** high fraction */
      width: "c";
    };
    outputs: {
      /** gate 0/1 */
      out: "c";
    };
  };
  /** amplifier: audio times gain (wire an envelope to gain) */
  vca: {
    main: "a";
    params: {
      /** gain (0..4, default 1) */
      gain?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** gain */
      gain: "ca";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** four-input audio mixer with a level per input */
  mix: {
    main: "a";
    params: {
      /** level of a (0..4, default 1) */
      la?: number;
      /** level of b (0..4, default 1) */
      lb?: number;
      /** level of c (0..4, default 1) */
      lc?: number;
      /** level of d (0..4, default 1) */
      ld?: number;
    };
    inputs: {
      /** input a */
      a: "a";
      /** input b */
      b: "a";
      /** input c */
      c: "a";
      /** input d */
      d: "a";
      /** level of a */
      la: "c";
      /** level of b */
      lb: "c";
      /** level of c */
      lc: "c";
      /** level of d */
      ld: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** equal-gain crossfade from a (x = 0) to b (x = 1) */
  xfade: {
    main: "a";
    params: {
      /** crossfade position (0..1, default 0.5) */
      x?: number;
    };
    inputs: {
      /** input a */
      a: "a";
      /** input b */
      b: "a";
      /** crossfade position */
      x: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** equal-power pan of a mono signal to left and right */
  pan: {
    main: "a";
    params: {
      /** -1 left .. 1 right (-1..1, default 0) */
      pan?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** -1 left .. 1 right */
      pan: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** explicit voice sum: every voice's input, summed once for the track */
  voicesum: {
    main: "a";
    params: {};
    inputs: {
      /** per-voice audio */
      in: "a";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** the whole synth voice (oscillators, FM, unison, filters, envelopes), samplers and wavetables included */
  "engine.synth": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "") */
      instrument?: string;
      /** amplitude attack: onset to peak (0..10 s, default 0.003) */
      attack?: number;
      /** amplitude decay: peak to sustain level (0..10 s, default 0.05) */
      decay?: number;
      /** amplitude sustain level held until note-off (0..1, default 1) */
      sustain?: number;
      /** amplitude release after note-off (0..10 s, default 0.05) */
      release?: number;
      /** voice gain before the effects chain (track volume follows the chain) (0..4, default 1) */
      gain?: number;
      /** pink noise mixed into the oscillator (z_* sounds: phase jitter) (0..1, default 0) */
      noise?: number;
      /** crackle density (impulses ≈ density·1000/s) (0..1, default 0.03) */
      density?: number;
      /** total pitch spread of the unison voices in semitones (0..12 st, default 0.2) */
      detune?: number;
      /** stereo spread of the unison voices (0..1, default 0.6) */
      spread?: number;
      /** pulse width (pulse sound) (0..1, default 0.5) */
      pw?: number;
      /** pulse-width LFO rate (triangle) (0..40 Hz, default 1) */
      pwrate?: number;
      /** pulse-width LFO depth (0..1, default 0) */
      pwsweep?: number;
      /** vibrato rate; 0 is off (0..64 Hz, default 0) */
      vib?: number;
      /** vibrato depth in semitones (0..24 st, default 0.5) */
      vibmod?: number;
      /** pitch envelope depth in semitones (negative inverts); 0 is off (-48..48 st, default 0) */
      penv?: number;
      /** pitch envelope attack (0..10 s, default 0.2) */
      pattack?: number;
      /** pitch envelope decay (0..10 s, default 0) */
      pdecay?: number;
      /** pitch envelope sustain level (0..1, default 1) */
      psustain?: number;
      /** pitch envelope release (0..10 s, default 0) */
      prelease?: number;
      /** per-note low-pass cutoff; unset is no low-pass (20..20000 Hz, default 2000) */
      lpf?: number;
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) (0..50, default 1) */
      lpq?: number;
      /** low-pass envelope depth in octaves above (below, negative) the cutoff (-10..10 oct, default 0) */
      lpenv?: number;
      /** low-pass envelope attack (0..10 s, default 0.005) */
      lpattack?: number;
      /** low-pass envelope decay (0..10 s, default 0.15) */
      lpdecay?: number;
      /** low-pass envelope sustain level (0..1, default 0) */
      lpsustain?: number;
      /** low-pass envelope release (0..10 s, default 0.1) */
      lprelease?: number;
      /** per-note high-pass cutoff; unset is no high-pass (20..20000 Hz, default 200) */
      hpf?: number;
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) (0..50, default 1) */
      hpq?: number;
      /** high-pass envelope depth in octaves above (below, negative) the cutoff (-10..10 oct, default 0) */
      hpenv?: number;
      /** high-pass envelope attack (0..10 s, default 0.005) */
      hpattack?: number;
      /** high-pass envelope decay (0..10 s, default 0.15) */
      hpdecay?: number;
      /** high-pass envelope sustain level (0..1, default 0) */
      hpsustain?: number;
      /** high-pass envelope release (0..10 s, default 0.1) */
      hprelease?: number;
      /** per-note band-pass cutoff; unset is no band-pass (20..20000 Hz, default 1000) */
      bpf?: number;
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) (0..50, default 1) */
      bpq?: number;
      /** band-pass envelope depth in octaves above (below, negative) the cutoff (-10..10 oct, default 0) */
      bpenv?: number;
      /** band-pass envelope attack (0..10 s, default 0.005) */
      bpattack?: number;
      /** band-pass envelope decay (0..10 s, default 0.15) */
      bpdecay?: number;
      /** band-pass envelope sustain level (0..1, default 0) */
      bpsustain?: number;
      /** band-pass envelope release (0..10 s, default 0.1) */
      bprelease?: number;
      /** filter envelope anchor: 0 sweeps up from the cutoff, 1 down to it (0..1, default 0) */
      fanchor?: number;
      /** FM modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm?: number;
      /** FM harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh?: number;
      /** FM envelope attack (0..10 s, default 0) */
      fmattack?: number;
      /** FM envelope decay (0..10 s, default 0) */
      fmdecay?: number;
      /** FM envelope sustain level (0..1, default 1) */
      fmsustain?: number;
      /** FM envelope release (0..10 s, default 0) */
      fmrelease?: number;
      /** FM 2 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm2?: number;
      /** FM 2 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh2?: number;
      /** FM 2 envelope attack (0..10 s, default 0) */
      fmattack2?: number;
      /** FM 2 envelope decay (0..10 s, default 0) */
      fmdecay2?: number;
      /** FM 2 envelope sustain level (0..1, default 1) */
      fmsustain2?: number;
      /** FM 2 envelope release (0..10 s, default 0) */
      fmrelease2?: number;
      /** FM 3 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm3?: number;
      /** FM 3 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh3?: number;
      /** FM 3 envelope attack (0..10 s, default 0) */
      fmattack3?: number;
      /** FM 3 envelope decay (0..10 s, default 0) */
      fmdecay3?: number;
      /** FM 3 envelope sustain level (0..1, default 1) */
      fmsustain3?: number;
      /** FM 3 envelope release (0..10 s, default 0) */
      fmrelease3?: number;
      /** FM 4 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm4?: number;
      /** FM 4 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh4?: number;
      /** FM 4 envelope attack (0..10 s, default 0) */
      fmattack4?: number;
      /** FM 4 envelope decay (0..10 s, default 0) */
      fmdecay4?: number;
      /** FM 4 envelope sustain level (0..1, default 1) */
      fmsustain4?: number;
      /** FM 4 envelope release (0..10 s, default 0) */
      fmrelease4?: number;
      /** FM 5 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm5?: number;
      /** FM 5 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh5?: number;
      /** FM 5 envelope attack (0..10 s, default 0) */
      fmattack5?: number;
      /** FM 5 envelope decay (0..10 s, default 0) */
      fmdecay5?: number;
      /** FM 5 envelope sustain level (0..1, default 1) */
      fmsustain5?: number;
      /** FM 5 envelope release (0..10 s, default 0) */
      fmrelease5?: number;
      /** FM 6 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm6?: number;
      /** FM 6 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh6?: number;
      /** FM 6 envelope attack (0..10 s, default 0) */
      fmattack6?: number;
      /** FM 6 envelope decay (0..10 s, default 0) */
      fmdecay6?: number;
      /** FM 6 envelope sustain level (0..1, default 1) */
      fmsustain6?: number;
      /** FM 6 envelope release (0..10 s, default 0) */
      fmrelease6?: number;
      /** FM 7 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm7?: number;
      /** FM 7 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh7?: number;
      /** FM 7 envelope attack (0..10 s, default 0) */
      fmattack7?: number;
      /** FM 7 envelope decay (0..10 s, default 0) */
      fmdecay7?: number;
      /** FM 7 envelope sustain level (0..1, default 1) */
      fmsustain7?: number;
      /** FM 7 envelope release (0..10 s, default 0) */
      fmrelease7?: number;
      /** FM 8 modulation index (peak deviation ÷ modulator frequency); 0 is off (0..64, default 0) */
      fm8?: number;
      /** FM 8 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) (0..32, default 1) */
      fmh8?: number;
      /** FM 8 envelope attack (0..10 s, default 0) */
      fmattack8?: number;
      /** FM 8 envelope decay (0..10 s, default 0) */
      fmdecay8?: number;
      /** FM 8 envelope sustain level (0..1, default 1) */
      fmsustain8?: number;
      /** FM 8 envelope release (0..10 s, default 0) */
      fmrelease8?: number;
      /** z_*: random pitch offset per note, ± fraction (0..1, default 0) */
      zrand?: number;
      /** z_*: wave shape exponent (0 squares the wave off, >1 thins it) (0..3, default 1) */
      curve?: number;
      /** z_*: pitch slide, 500·slide Hz per second (-20..20, default 0) */
      slide?: number;
      /** z_*: slide acceleration, 500·deltaSlide Hz per second² (-20..20, default 0) */
      deltaSlide?: number;
      /** z_*: pitch change applied after pitchJumpTime (-2000..2000 Hz, default 0) */
      pitchJump?: number;
      /** z_*: time before pitchJump applies (0: never) (0..10 s, default 0) */
      pitchJumpTime?: number;
      /** z_*: repeat period: restarts slide and pitchJump, sets the tremolo period (0..10 s, default 0) */
      lfo?: number;
      /** z_*: frequency-modulation speed (±50 % depth) (0..1000 Hz, default 0) */
      zmod?: number;
      /** z_*: sample-hold bit crush, 0..1 (0..1, default 0) */
      zcrush?: number;
      /** z_*: one echo this many seconds later, half level (0..1 s, default 0) */
      zdelay?: number;
      /** z_*: volume modulation amount at the lfo period (0..1, default 0) */
      tremolo?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** amplitude attack: onset to peak */
      attack: "c";
      /** amplitude decay: peak to sustain level */
      decay: "c";
      /** amplitude sustain level held until note-off */
      sustain: "c";
      /** amplitude release after note-off */
      release: "c";
      /** voice gain before the effects chain (track volume follows the chain) */
      gain: "c";
      /** pink noise mixed into the oscillator (z_* sounds: phase jitter) */
      noise: "c";
      /** crackle density (impulses ≈ density·1000/s) */
      density: "c";
      /** total pitch spread of the unison voices in semitones */
      detune: "c";
      /** stereo spread of the unison voices */
      spread: "c";
      /** pulse width (pulse sound) */
      pw: "c";
      /** pulse-width LFO rate (triangle) */
      pwrate: "c";
      /** pulse-width LFO depth */
      pwsweep: "c";
      /** vibrato rate; 0 is off */
      vib: "c";
      /** vibrato depth in semitones */
      vibmod: "c";
      /** pitch envelope depth in semitones (negative inverts); 0 is off */
      penv: "c";
      /** pitch envelope attack */
      pattack: "c";
      /** pitch envelope decay */
      pdecay: "c";
      /** pitch envelope sustain level */
      psustain: "c";
      /** pitch envelope release */
      prelease: "c";
      /** per-note low-pass cutoff; unset is no low-pass */
      lpf: "c";
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) */
      lpq: "c";
      /** low-pass envelope depth in octaves above (below, negative) the cutoff */
      lpenv: "c";
      /** low-pass envelope attack */
      lpattack: "c";
      /** low-pass envelope decay */
      lpdecay: "c";
      /** low-pass envelope sustain level */
      lpsustain: "c";
      /** low-pass envelope release */
      lprelease: "c";
      /** per-note high-pass cutoff; unset is no high-pass */
      hpf: "c";
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) */
      hpq: "c";
      /** high-pass envelope depth in octaves above (below, negative) the cutoff */
      hpenv: "c";
      /** high-pass envelope attack */
      hpattack: "c";
      /** high-pass envelope decay */
      hpdecay: "c";
      /** high-pass envelope sustain level */
      hpsustain: "c";
      /** high-pass envelope release */
      hprelease: "c";
      /** per-note band-pass cutoff; unset is no band-pass */
      bpf: "c";
      /** resonance as filter Q (0..50; 0.7 is flat, higher rings) */
      bpq: "c";
      /** band-pass envelope depth in octaves above (below, negative) the cutoff */
      bpenv: "c";
      /** band-pass envelope attack */
      bpattack: "c";
      /** band-pass envelope decay */
      bpdecay: "c";
      /** band-pass envelope sustain level */
      bpsustain: "c";
      /** band-pass envelope release */
      bprelease: "c";
      /** filter envelope anchor: 0 sweeps up from the cutoff, 1 down to it */
      fanchor: "c";
      /** FM modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm: "c";
      /** FM harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh: "c";
      /** FM envelope attack */
      fmattack: "c";
      /** FM envelope decay */
      fmdecay: "c";
      /** FM envelope sustain level */
      fmsustain: "c";
      /** FM envelope release */
      fmrelease: "c";
      /** FM 2 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm2: "c";
      /** FM 2 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh2: "c";
      /** FM 2 envelope attack */
      fmattack2: "c";
      /** FM 2 envelope decay */
      fmdecay2: "c";
      /** FM 2 envelope sustain level */
      fmsustain2: "c";
      /** FM 2 envelope release */
      fmrelease2: "c";
      /** FM 3 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm3: "c";
      /** FM 3 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh3: "c";
      /** FM 3 envelope attack */
      fmattack3: "c";
      /** FM 3 envelope decay */
      fmdecay3: "c";
      /** FM 3 envelope sustain level */
      fmsustain3: "c";
      /** FM 3 envelope release */
      fmrelease3: "c";
      /** FM 4 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm4: "c";
      /** FM 4 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh4: "c";
      /** FM 4 envelope attack */
      fmattack4: "c";
      /** FM 4 envelope decay */
      fmdecay4: "c";
      /** FM 4 envelope sustain level */
      fmsustain4: "c";
      /** FM 4 envelope release */
      fmrelease4: "c";
      /** FM 5 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm5: "c";
      /** FM 5 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh5: "c";
      /** FM 5 envelope attack */
      fmattack5: "c";
      /** FM 5 envelope decay */
      fmdecay5: "c";
      /** FM 5 envelope sustain level */
      fmsustain5: "c";
      /** FM 5 envelope release */
      fmrelease5: "c";
      /** FM 6 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm6: "c";
      /** FM 6 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh6: "c";
      /** FM 6 envelope attack */
      fmattack6: "c";
      /** FM 6 envelope decay */
      fmdecay6: "c";
      /** FM 6 envelope sustain level */
      fmsustain6: "c";
      /** FM 6 envelope release */
      fmrelease6: "c";
      /** FM 7 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm7: "c";
      /** FM 7 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh7: "c";
      /** FM 7 envelope attack */
      fmattack7: "c";
      /** FM 7 envelope decay */
      fmdecay7: "c";
      /** FM 7 envelope sustain level */
      fmsustain7: "c";
      /** FM 7 envelope release */
      fmrelease7: "c";
      /** FM 8 modulation index (peak deviation ÷ modulator frequency); 0 is off */
      fm8: "c";
      /** FM 8 harmonicity: modulator ÷ carrier frequency (integers sound harmonic) */
      fmh8: "c";
      /** FM 8 envelope attack */
      fmattack8: "c";
      /** FM 8 envelope decay */
      fmdecay8: "c";
      /** FM 8 envelope sustain level */
      fmsustain8: "c";
      /** FM 8 envelope release */
      fmrelease8: "c";
      /** z_*: random pitch offset per note, ± fraction */
      zrand: "c";
      /** z_*: wave shape exponent (0 squares the wave off, >1 thins it) */
      curve: "c";
      /** z_*: pitch slide, 500·slide Hz per second */
      slide: "c";
      /** z_*: slide acceleration, 500·deltaSlide Hz per second² */
      deltaSlide: "c";
      /** z_*: pitch change applied after pitchJumpTime */
      pitchJump: "c";
      /** z_*: time before pitchJump applies (0: never) */
      pitchJumpTime: "c";
      /** z_*: repeat period: restarts slide and pitchJump, sets the tremolo period */
      lfo: "c";
      /** z_*: frequency-modulation speed (±50 % depth) */
      zmod: "c";
      /** z_*: sample-hold bit crush, 0..1 */
      zcrush: "c";
      /** z_*: one echo this many seconds later, half level */
      zdelay: "c";
      /** z_*: volume modulation amount at the lfo period */
      tremolo: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** modal resonators: mallets, bars, bells and plates */
  "engine.modal": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "modal") */
      instrument?: "modal";
      /** mallet hardness: 0 yarn/felt, 1 brass (0..1, default 0.4) */
      hardness?: number;
      /** strike point: 0 end or edge, 0.5 center (0..1, default 0.42) */
      position?: number;
      /** ring time (T60) at middle C (0.05..30 s, default 1.6) */
      ring?: number;
      /** how much faster high modes and notes decay (0..2, default 0.9) */
      tilt?: number;
      /** damping at note-off: 0 rings on, 1 chokes (0..1, default 0) */
      damp?: number;
      /** motor tremolo depth (0..1, default 0) */
      motordepth?: number;
      /** buzzer or jingle amount (0..1, default 0) */
      buzz?: number;
      /** mallet contact click (0..1, default 0) */
      click?: number;
      /** level (0..2, default 0.8) */
      gain?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** mallet hardness: 0 yarn/felt, 1 brass */
      hardness: "c";
      /** strike point: 0 end or edge, 0.5 center */
      position: "c";
      /** ring time (T60) at middle C */
      ring: "c";
      /** how much faster high modes and notes decay */
      tilt: "c";
      /** damping at note-off: 0 rings on, 1 chokes */
      damp: "c";
      /** motor tremolo depth */
      motordepth: "c";
      /** buzzer or jingle amount */
      buzz: "c";
      /** mallet contact click */
      click: "c";
      /** level */
      gain: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** physically modeled plucked and bowed strings */
  "engine.string": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "string") */
      instrument?: "string";
      /** how long a note rings (T60 at C4) (0.05..60 s, default 3) */
      ring?: number;
      /** high-frequency loss (dark, dead strings at 1) (0..1, default 0.4) */
      damp?: number;
      /** pluck or strike position from the bridge (0.5 round, 0.04 nasal) (0.02..0.5, default 0.15) */
      pos?: number;
      /** excitation brightness at full velocity (0..1, default 0.6) */
      bright?: number;
      /** palm mute: shortens the ring and darkens the string (0..1, default 0) */
      mute?: number;
      /** bridge buzz (sitar, tanpura jawari); 0 off (0..1, default 0) */
      buzz?: number;
      /** vibrato rate (a note's own vibrato overrides it) (0..12 Hz, default 0) */
      vib?: number;
      /** vibrato depth in semitones (0..2 st, default 0.18) */
      vibmod?: number;
      /** output level (presets carry a calibrated trim) (0..2, default 1) */
      gain?: number;
      /** bow force within the playable range: flautando at 0, gritty at 1 (0..1, default 0.5) */
      pressure?: number;
      /** bow speed at full dynamics (loudness) (0..1, default 0.6) */
      speed?: number;
      /** con sordino: the practice mute, darker and softer (0..1, default 0) */
      sord?: number;
      /** dynamics on top of velocity, drives bow speed and pressure (swells) (0..1, default 1) */
      dyn?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** how long a note rings (T60 at C4) */
      ring: "c";
      /** high-frequency loss (dark, dead strings at 1) */
      damp: "c";
      /** pluck or strike position from the bridge (0.5 round, 0.04 nasal) */
      pos: "c";
      /** excitation brightness at full velocity */
      bright: "c";
      /** palm mute: shortens the ring and darkens the string */
      mute: "c";
      /** bridge buzz (sitar, tanpura jawari); 0 off */
      buzz: "c";
      /** vibrato rate (a note's own vibrato overrides it) */
      vib: "c";
      /** vibrato depth in semitones */
      vibmod: "c";
      /** output level (presets carry a calibrated trim) */
      gain: "c";
      /** bow force within the playable range: flautando at 0, gritty at 1 */
      pressure: "c";
      /** bow speed at full dynamics (loudness) */
      speed: "c";
      /** con sordino: the practice mute, darker and softer */
      sord: "c";
      /** dynamics on top of velocity, drives bow speed and pressure (swells) */
      dyn: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** physically modeled winds and brass */
  "engine.wind": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "wind") */
      instrument?: "wind";
      /** blowing pressure: swells, louder and fuller (0..1, default 0.6) */
      breath?: number;
      /** breath noise (0..1, default 0.08) */
      noise?: number;
      /** plunger opening: 0 closed, 1 open (0..1, default 1) */
      wah?: number;
      /** hum into the horn: rough, raspy (0..1, default 0) */
      growl?: number;
      /** flutter tongue (rolled r) (0..1, default 0) */
      flutter?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** blowing pressure: swells, louder and fuller */
      breath: "c";
      /** breath noise */
      noise: "c";
      /** plunger opening: 0 closed, 1 open */
      wah: "c";
      /** hum into the horn: rough, raspy */
      growl: "c";
      /** flutter tongue (rolled r) */
      flutter: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** the singing voice (lyrics, formants, choir) */
  "engine.sing": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "sing") */
      instrument?: "sing";
      /** how far an a>o vowel travels by the note's end (0..1, default 1) */
      morph?: number;
      /** throat size: formant shift, keeps pitch (-12..12 st, default 0) */
      formant?: number;
      /** voice quality: breathy and dark .. pressed (0..1, default 0.5) */
      bright?: number;
      /** aspiration noise (0..1, default 0.12) */
      breath?: number;
      /** vibrato depth (0..1 st, default 0.3) */
      vibmod?: number;
      /** singer's formant (bright 3 kHz ring) (0..1, default 0) */
      ring?: number;
      /** overtone filter sharpness and level (0..1, default 0) */
      overtone?: number;
      /** kargyraa subharmonic (an octave below) (0..1, default 0) */
      sub?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** how far an a>o vowel travels by the note's end */
      morph: "c";
      /** throat size: formant shift, keeps pitch */
      formant: "c";
      /** voice quality: breathy and dark .. pressed */
      bright: "c";
      /** aspiration noise */
      breath: "c";
      /** vibrato depth */
      vibmod: "c";
      /** singer's formant (bright 3 kHz ring) */
      ring: "c";
      /** overtone filter sharpness and level */
      overtone: "c";
      /** kargyraa subharmonic (an octave below) */
      sub: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** granular player over a sample or the track's own source */
  "engine.granular": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "granular") */
      instrument?: "granular";
      /** where the head starts inside the region (0..1, default 0) */
      pos?: number;
      /** head speed: 1 the source's own speed, 0 held, negative backwards (-4..4 x, default 1) */
      scan?: number;
      /** grain length (0.005..2 s, default 0.08) */
      grain?: number;
      /** grains sounding at once (density = overlap / grain) (0.05..32, default 4) */
      overlap?: number;
      /** onset randomness, fraction of the grain period (0..1, default 0.25) */
      jitter?: number;
      /** random offset of each grain's read position (0..2 s, default 0.01) */
      spray?: number;
      /** semitones on top of the note (-48..48 st, default 0) */
      pitch?: number;
      /** random per-grain pitch spread (± half) (0..24 st, default 0) */
      detune?: number;
      /** chance a grain plays shimint semitones up (0..1, default 0) */
      shimmer?: number;
      /** stereo spread of the grains (0..1, default 0.3) */
      spread?: number;
      /** chance a grain plays backwards (0..1, default 0) */
      reverse?: number;
      /** chance a grain step latches the head (beat repeat) (0..1, default 0) */
      repeat?: number;
      /** slow random walk of the head (depth) (0..1, default 0) */
      drift?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** where the head starts inside the region */
      pos: "c";
      /** head speed: 1 the source's own speed, 0 held, negative backwards */
      scan: "c";
      /** grain length */
      grain: "c";
      /** grains sounding at once (density = overlap / grain) */
      overlap: "c";
      /** onset randomness, fraction of the grain period */
      jitter: "c";
      /** random offset of each grain's read position */
      spray: "c";
      /** semitones on top of the note */
      pitch: "c";
      /** random per-grain pitch spread (± half) */
      detune: "c";
      /** chance a grain plays shimint semitones up */
      shimmer: "c";
      /** stereo spread of the grains */
      spread: "c";
      /** chance a grain plays backwards */
      reverse: "c";
      /** chance a grain step latches the head (beat repeat) */
      repeat: "c";
      /** slow random walk of the head (depth) */
      drift: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** modeled pianos, electric keys and organs */
  "engine.keys": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "grand") */
      instrument?:
        | "grand"
        | "upright"
        | "felt"
        | "honkytonk"
        | "prepared"
        | "epiano"
        | "wurli"
        | "clav"
        | "tonewheel"
        | "combo"
        | "pipe";
      /** hammer felt hardness: brightness at a given velocity (0..1, default 0.5) */
      hardness?: number;
      /** velocity sensitivity (0 plays every note at 0.8) (0..1, default 1) */
      touch?: number;
      /** sustain time multiplier (0.1..4 x, default 1) */
      decay?: number;
      /** damper time multiplier (how fast a released key stops) (0.1..4 x, default 1) */
      release?: number;
      /** soundboard knock and hammer thump (0..1, default 0.5) */
      knock?: number;
      /** key-off and damper mechanics (0..1, default 0.25) */
      noise?: number;
      /** felt strip between hammers and strings (0..1, default 0) */
      felt?: number;
      /** output low-pass of the electric keys; 0 is off (0..12000 Hz, default 0) */
      tone?: number;
      /** suitcase stereo vibrato depth: antiphase left/right pan (epiano) (0..1, default 0) */
      vibe?: number;
      /** tremolo depth: reed piano at 5.6 Hz (wurli), pipe tremulant (pipe) (0..1, default 0) */
      trem?: number;
      /** organ preamp overdrive (0..1, default 0.15) */
      drive?: number;
      /** rotary speed: 0 stop, 1 slow, 2 fast (0..2, default 1) */
      rotary?: number;
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
      /** hammer felt hardness: brightness at a given velocity */
      hardness: "c";
      /** velocity sensitivity (0 plays every note at 0.8) */
      touch: "c";
      /** sustain time multiplier */
      decay: "c";
      /** damper time multiplier (how fast a released key stops) */
      release: "c";
      /** soundboard knock and hammer thump */
      knock: "c";
      /** key-off and damper mechanics */
      noise: "c";
      /** felt strip between hammers and strings */
      felt: "c";
      /** output low-pass of the electric keys; 0 is off */
      tone: "c";
      /** suitcase stereo vibrato depth: antiphase left/right pan (epiano) */
      vibe: "c";
      /** tremolo depth: reed piano at 5.6 Hz (wurli), pipe tremulant (pipe) */
      trem: "c";
      /** organ preamp overdrive */
      drive: "c";
      /** rotary speed: 0 stop, 1 slow, 2 fast */
      rotary: "c";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** the vocoder's built-in carrier (saw, supersaw, pulse or noise) following the notes */
  "engine.vocoder": {
    main: "a";
    params: {
      /** which instrument of this engine plays (default "vocoder") */
      instrument?: "vocoder";
      /** engine settings, as the track field holds them */
      settings?: Readonly<Record<string, unknown>>;
    };
    inputs: {
      /** the notes to play (wire in.notes) */
      notes: "n";
    };
    outputs: {
      /** audio out (left when stereo) */
      out: "a";
      /** right out (equals out for a mono engine) */
      right: "a";
    };
  };
  /** resonant biquad: low-pass, high-pass or band-pass */
  "fx.filter": {
    main: "a";
    params: {
      /** lpf low-pass (default), hpf high-pass, bpf band-pass (default "lpf") */
      type?: "lpf" | "hpf" | "bpf";
      /** slope: 12db biquad (default), 24db two biquads, ladder 4-pole (low-pass only) (default "12db") */
      ftype?: "12db" | "24db" | "ladder";
      /** cutoff (lpf/hpf) or center (bpf) frequency (20..20000 Hz, default 2000) */
      cutoff?: number;
      /** resonance 0..1 (Q 0.707..8) (0..1, default 0) */
      resonance?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** cutoff (lpf/hpf) or center (bpf) frequency */
      cutoff: "c";
      /** resonance 0..1 (Q 0.707..8) */
      resonance: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** one-knob filter: below 0.5 low-pass, above 0.5 high-pass, 0.5 open */
  "fx.djf": {
    main: "a";
    params: {
      /** 0 dark (20 Hz low-pass) … 0.5 open … 1 thin (10 kHz high-pass) (0..1, default 0.5) */
      value?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** 0 dark (20 Hz low-pass) … 0.5 open … 1 thin (10 kHz high-pass) */
      value: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** filter whose cutoff an LFO sweeps around a center, optionally opened by the input level */
  "fx.autofilter": {
    main: "a";
    params: {
      /** filter type (default "lpf") */
      type?: "lpf" | "hpf" | "bpf";
      /** LFO shape; random is sample-and-hold, one step per cycle (default "sine") */
      shape?: "sine" | "tri" | "square" | "saw" | "ramp" | "random";
      /** center cutoff (20..20000 Hz, default 1200) */
      cutoff?: number;
      /** resonance 0..1 (Q 0.707..8) (0..1, default 0.3) */
      resonance?: number;
      /** sweep width in octaves around the center (0..6 oct, default 2) */
      depth?: number;
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz (0..64 beats, default 4) */
      sync?: number;
      /** LFO rate in Hz (used when sync is 0) (0.01..40 Hz, default 0.5) */
      rate?: number;
      /** LFO start phase in cycles (0..1, default 0) */
      phase?: number;
      /** envelope follower: octaves the cutoff moves at full input level (-6..6 oct, default 0) */
      follow?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** center cutoff */
      cutoff: "c";
      /** resonance 0..1 (Q 0.707..8) */
      resonance: "c";
      /** sweep width in octaves around the center */
      depth: "c";
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz */
      sync: "c";
      /** LFO rate in Hz (used when sync is 0) */
      rate: "c";
      /** LFO start phase in cycles */
      phase: "c";
      /** envelope follower: octaves the cutoff moves at full input level */
      follow: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** formant shift at constant pitch: moves the spectral envelope (throat or gender knob), any source */
  "fx.formant": {
    main: "a";
    params: {
      /** semitones the formants move (negative deeper, positive smaller); pitch stays (-12..12 st, default 0) */
      shift?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** semitones the formants move (negative deeper, positive smaller); pitch stays */
      shift: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** formant filter bank: five band-passes per vowel */
  "fx.vowel": {
    main: "a";
    params: {
      /** vowel formants (a e i o u plus the extended set) (default "a") */
      vowel?:
        | "a"
        | "e"
        | "i"
        | "o"
        | "u"
        | "ae"
        | "aa"
        | "oe"
        | "ue"
        | "y"
        | "uh"
        | "un"
        | "en"
        | "an"
        | "on";
      /** vowel to morph toward (absent: no morph) (default "a") */
      to?:
        | "a"
        | "e"
        | "i"
        | "o"
        | "u"
        | "ae"
        | "aa"
        | "oe"
        | "ue"
        | "y"
        | "uh"
        | "un"
        | "en"
        | "an"
        | "on";
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
      /** position between vowel (0) and to (1), log-frequency formant morph (0..1, default 0) */
      morph?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** wet/dry balance 0..1 */
      mix: "c";
      /** position between vowel (0) and to (1), log-frequency formant morph */
      morph: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** bit-depth and sample-rate reduction */
  "fx.crush": {
    main: "a";
    params: {
      /** bit depth: 1 heavy .. 16 nearly clean (1..16, default 8) */
      bits?: number;
      /** sample-and-hold factor: 1 off, 2 half rate, 3 a third… (1..64, default 1) */
      coarse?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** bit depth: 1 heavy .. 16 nearly clean */
      bits: "c";
      /** sample-and-hold factor: 1 off, 2 half rate, 3 a third… */
      coarse: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** waveshaper with drive, post-tone and automatic gain compensation */
  "fx.distort": {
    main: "a";
    params: {
      /** curve: soft (tanh), hard clip, cubic, diode, asym, fold, sinefold, chebyshev, scurve, shape (Strudel shape's curve) (default "soft") */
      type?:
        | "soft"
        | "hard"
        | "cubic"
        | "diode"
        | "asym"
        | "fold"
        | "sinefold"
        | "chebyshev"
        | "scurve"
        | "shape";
      /** drive 0..10 (Strudel distort amount) (0..10, default 2) */
      drive?: number;
      /** low-pass after the shaper; tames fizz (200..20000 Hz, default 8000) */
      tone?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
      /** linear gain after compensation (Strudel distort postgain) (0..2, default 1) */
      postgain?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** drive 0..10 (Strudel distort amount) */
      drive: "c";
      /** low-pass after the shaper; tames fizz */
      tone: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
      /** linear gain after compensation (Strudel distort postgain) */
      postgain: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** guitar pedal before the amp: fuzz (Big Muff), face (Fuzz Face), od (Tube Screamer), rat, octave (Octavia); oversampled */
  "fx.stomp": {
    main: "a";
    params: {
      /** circuit: fuzz (Big Muff), face (Fuzz Face), od (Tube Screamer), rat (RAT), octave (Octavia) (default "od") */
      type?: "fuzz" | "face" | "od" | "rat" | "octave";
      /** the pedal's gain / sustain / distortion knob, 0..10 (0..10, default 5) */
      gain?: number;
      /** dark 0 .. bright 1 (0..1, default 0.5) */
      tone?: number;
      /** trim over a level-matched pedal (0 = bypass loudness) (-24..12 dB, default 0) */
      level?: number;
      /** octave: blend of the octave-up (rectified) path (0..1, default 0.7) */
      octave?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** the pedal's gain / sustain / distortion knob, 0..10 */
      gain: "c";
      /** dark 0 .. bright 1 */
      tone: "c";
      /** trim over a level-matched pedal (0 = bypass loudness) */
      level: "c";
      /** octave: blend of the octave-up (rectified) path */
      octave: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** guitar amp: preamp stages, Yeh-Smith tone stack, power amp with sag, level-matched across types; optional noise gate */
  "fx.head": {
    main: "a";
    params: {
      /** clean (blackface), chime (AC30), crunch (plexi), lead (JCM800), high (modern high gain), solid (JC-120), bass (SVT) (default "crunch") */
      type?: "clean" | "chime" | "crunch" | "lead" | "high" | "solid" | "bass";
      /** preamp gain 0..10 (level-matched: more gain, not more volume) (0..10, default 5) */
      gain?: number;
      /** tone stack bass 0..10 (0..10, default 5) */
      bass?: number;
      /** tone stack mid 0..10 (0..10, default 5) */
      mid?: number;
      /** tone stack treble 0..10 (0..10, default 5) */
      treble?: number;
      /** power amp presence 0..10 (5 flat) (0..10, default 5) */
      presence?: number;
      /** power amp drive 0..10 (0..10, default 5) */
      master?: number;
      /** power supply sag 0..1 (absent: the head type's own) (0..1, default 0.3) */
      sag?: number;
      /** noise gate threshold before the amp (absent: no gate; 0 dB gates all) (-96..0 dB, default -60) */
      gate?: number;
      /** output level after level matching (-24..12 dB, default 0) */
      level?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** preamp gain 0..10 (level-matched: more gain, not more volume) */
      gain: "c";
      /** tone stack bass 0..10 */
      bass: "c";
      /** tone stack mid 0..10 */
      mid: "c";
      /** tone stack treble 0..10 */
      treble: "c";
      /** power amp presence 0..10 (5 flat) */
      presence: "c";
      /** power amp drive 0..10 */
      master: "c";
      /** power supply sag 0..1 (absent: the head type's own) */
      sag: "c";
      /** noise gate threshold before the amp (absent: no gate; 0 dB gates all) */
      gate: "c";
      /** output level after level matching */
      level: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** speaker cabinet and microphone (biquad model, no impulse response) */
  "fx.cab": {
    main: "a";
    params: {
      /** 1x12, 2x12, 4x12, 1x10, open back, 8x10 and 1x15 bass, di (no speaker) (default "2x12") */
      type?:
        "1x12" | "2x12" | "4x12" | "1x10" | "open" | "8x10" | "1x15" | "di";
      /** microphone position: 0 center (bright) .. 1 edge (dark) (0..1, default 0.3) */
      mic?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** microphone position: 0 center (bright) .. 1 edge (dark) */
      mic: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** held tremolo arm: slow seeded pitch wow and flutter of the whole track */
  "fx.wobble": {
    main: "a";
    params: {
      /** peak pitch deviation in cents (0..100 c, default 20) */
      depth?: number;
      /** wobble rate (0.05..8 Hz, default 0.5) */
      rate?: number;
      /** 0 periodic .. 1 wandering (seeded, so every render matches) (0..1, default 0.3) */
      drift?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** peak pitch deviation in cents */
      depth: "c";
      /** wobble rate */
      rate: "c";
      /** 0 periodic .. 1 wandering (seeded, so every render matches) */
      drift: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** feedback bloom: the top held note grows a singing harmonic */
  "fx.bloom": {
    main: "a";
    params: {
      /** level of the feedback partial (0..1, default 0.5) */
      amount?: number;
      /** harmonic that feeds back: 1 the note, 2 its octave, 3 the fifth above (1..4, default 2) */
      harm?: number;
      /** how long a note is held before it starts to feed back (0..4 s, default 0.6) */
      delay?: number;
      /** how fast the feedback grows (0.05..4 s, default 1) */
      time?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** level of the feedback partial */
      amount: "c";
      /** harmonic that feeds back: 1 the note, 2 its octave, 3 the fifth above */
      harm: "c";
      /** how long a note is held before it starts to feed back */
      delay: "c";
      /** how fast the feedback grows */
      time: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** volume swell: each strum fades in, no pick attack */
  "fx.swell": {
    main: "a";
    params: {
      /** rise time after each onset (0.01..4 s, default 0.4) */
      time?: number;
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** rise time after each onset */
      time: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** volume modulation */
  "fx.tremolo": {
    main: "a";
    params: {
      /** LFO shape (default "sine") */
      shape?: "sine" | "tri" | "square" | "saw" | "ramp";
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz (0..64 beats, default 0.5) */
      sync?: number;
      /** LFO rate in Hz (used when sync is 0) (0.01..40 Hz, default 4) */
      rate?: number;
      /** how far the level dips, 0..1 (0..1, default 0.5) */
      depth?: number;
      /** where in the cycle the peak falls (0.5 symmetric) (0..1, default 0.5) */
      skew?: number;
      /** start phase in cycles (0..1, default 0) */
      phase?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz */
      sync: "c";
      /** LFO rate in Hz (used when sync is 0) */
      rate: "c";
      /** how far the level dips, 0..1 */
      depth: "c";
      /** where in the cycle the peak falls (0.5 symmetric) */
      skew: "c";
      /** start phase in cycles */
      phase: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** feed-forward RMS-ish compressor with soft knee and make-up gain */
  "fx.compressor": {
    main: "a";
    params: {
      /** level where compression starts (-60..0 dB, default -18) */
      threshold?: number;
      /** input:output above threshold (1..20, default 4) */
      ratio?: number;
      /** soft-knee width (0..24 dB, default 6) */
      knee?: number;
      /** attack time (0.0001..1 s, default 0.01) */
      attack?: number;
      /** release time (0.01..2 s, default 0.15) */
      release?: number;
      /** gain after compression (0..24 dB, default 5) */
      makeup?: number;
    };
    inputs: {
      /** audio in */
      in: "a";
      /** level where compression starts */
      threshold: "c";
      /** input:output above threshold */
      ratio: "c";
      /** soft-knee width */
      knee: "c";
      /** attack time */
      attack: "c";
      /** release time */
      release: "c";
      /** gain after compression */
      makeup: "c";
    };
    outputs: {
      /** audio out */
      out: "a";
    };
  };
  /** automatic double tracking: a seeded second take, spread left and right */
  "fx.double": {
    main: "a";
    params: {
      /** how late the second take plays (5..60 ms, default 22) */
      time?: number;
      /** how far the second take's timing wanders (0..10 ms, default 3) */
      drift?: number;
      /** 0 centered .. 1 the two takes hard left and right (0..1, default 0.6) */
      width?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** how late the second take plays */
      time: "c";
      /** how far the second take's timing wanders */
      drift: "c";
      /** 0 centered .. 1 the two takes hard left and right */
      width: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** four-stage all-pass phaser */
  "fx.phaser": {
    main: "a";
    params: {
      /** LFO rate in Hz (used when sync is 0) (0.01..40 Hz, default 0.5) */
      rate?: number;
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz (0..64 beats, default 0) */
      sync?: number;
      /** notch depth (wet amount) (0..1, default 0.75) */
      depth?: number;
      /** sweep center (100..10000 Hz, default 1000) */
      center?: number;
      /** sweep range (0..8000 Hz, default 2000) */
      sweep?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** LFO rate in Hz (used when sync is 0) */
      rate: "c";
      /** LFO period in beats (tempo-synced); 0 uses rate in Hz */
      sync: "c";
      /** notch depth (wet amount) */
      depth: "c";
      /** sweep center */
      center: "c";
      /** sweep range */
      sweep: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** stereo chorus: two modulated delay taps in quadrature */
  "fx.chorus": {
    main: "a";
    params: {
      /** LFO rate in Hz (used when sync is 0) (0.01..40 Hz, default 0.8) */
      rate?: number;
      /** modulation depth (0..1 → 0..6 ms) (0..1, default 0.4) */
      depth?: number;
      /** wet/dry balance 0..1 (0..1, default 0.5) */
      mix?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** LFO rate in Hz (used when sync is 0) */
      rate: "c";
      /** modulation depth (0..1 → 0..6 ms) */
      depth: "c";
      /** wet/dry balance 0..1 */
      mix: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** rotary speaker: Doppler vibrato plus left/right amplitude rotation */
  "fx.leslie": {
    main: "a";
    params: {
      /** wet/dry balance 0..1 (0..1, default 1) */
      mix?: number;
      /** rotation in Hz: 6.7 fast, 0.7 slow (0.01..40 Hz, default 6.7) */
      rate?: number;
      /** cabinet size: Doppler (pitch warble) amount (0..1, default 0.5) */
      size?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** wet/dry balance 0..1 */
      mix: "c";
      /** rotation in Hz: 6.7 fast, 0.7 slow */
      rate: "c";
      /** cabinet size: Doppler (pitch warble) amount */
      size: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** linear gain after every insert, before the delay and reverb sends */
  "fx.postgain": {
    main: "a";
    params: {
      /** linear gain 0..4 (0..4, default 1) */
      gain?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** linear gain 0..4 */
      gain: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** tempo-synced stereo delay send; ping-pong with a high-cut on the repeats by default */
  "fx.delay": {
    main: "a";
    params: {
      /** repeats alternate left/right (absent: the original cross-fed stereo) (default true) */
      pingpong?: boolean;
      /** delay time in beats (0.75 = dotted eighth) (0.0625..4 beats, default 0.75) */
      beats?: number;
      /** fraction of each echo fed back (0..0.9, default 0.35) */
      feedback?: number;
      /** wet level (0..1, default 0.25) */
      mix?: number;
      /** delay time in seconds; 0 or absent uses beats (0..4 s, default 0) */
      time?: number;
      /** low-pass inside the feedback loop so repeats darken (500..20000 Hz, default 5000) */
      highcut?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** delay time in beats (0.75 = dotted eighth) */
      beats: "c";
      /** fraction of each echo fed back */
      feedback: "c";
      /** wet level */
      mix: "c";
      /** delay time in seconds; 0 or absent uses beats */
      time: "c";
      /** low-pass inside the feedback loop so repeats darken */
      highcut: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
  /** algorithmic stereo reverb send (eight combs, four allpasses per side) */
  "fx.reverb": {
    main: "a";
    params: {
      /** wet level (0..1, default 0.3) */
      mix?: number;
      /** room size (Strudel roomsize 0..10 = size·10) (0..1, default 0.5) */
      size?: number;
      /** decay time to -60 dB; overrides the size-derived decay (0.1..20 s, default 2) */
      fade?: number;
      /** low-pass on the reverb input (200..20000 Hz, default 8000) */
      lowpass?: number;
      /** damping: the tail darkens toward this frequency as it decays (200..20000 Hz, default 3000) */
      dim?: number;
      /** gap before the tail starts (0..0.5 s, default 0.02) */
      predelay?: number;
    };
    inputs: {
      /** left in */
      left: "a";
      /** right in */
      right: "a";
      /** wet level */
      mix: "c";
      /** room size (Strudel roomsize 0..10 = size·10) */
      size: "c";
      /** decay time to -60 dB; overrides the size-derived decay */
      fade: "c";
      /** low-pass on the reverb input */
      lowpass: "c";
      /** damping: the tail darkens toward this frequency as it decays */
      dim: "c";
      /** gap before the tail starts */
      predelay: "c";
    };
    outputs: {
      /** left out */
      left: "a";
      /** right out */
      right: "a";
    };
  };
};

/** The boundary nodes every patch has: `in`, `out`, `voice` and `song`. */
export type PatchBoundaryTable = {
  /** the patch's inputs from the track */
  in: {
    main: "n";
    params: {};
    inputs: {};
    outputs: {
      /** the track's notes (instrument) */
      notes: "n";
      /** the track's audio (effect patch) */
      audio: "a";
      /** the track's right channel (stereo effect patch) */
      right: "a";
      /** the sidechain track's audio (patch `side`) */
      side: "a";
    };
  };
  /** the patch's output to the track */
  out: {
    main: "none";
    params: {};
    inputs: {
      /** audio out (mono, or left when right is wired) */
      audio: "a";
      /** right channel; unwired, audio plays on both */
      right: "a";
    };
    outputs: {};
  };
  /** per-voice sources, one set per playing note */
  voice: {
    main: "c";
    params: {};
    inputs: {};
    outputs: {
      /** the note's frequency in Hz (tuned, with glide) */
      pitch: "c";
      /** the note's MIDI number */
      note: "c";
      /** 1 while the note is held, then 0 */
      gate: "c";
      /** velocity 0..1 */
      velocity: "c";
      /** phase 0..1 per cycle of the note's pitch */
      phase: "c";
      /** seeded random 0..1, fixed for the note */
      random: "c";
      /** voice slot index */
      index: "c";
      /** seconds since the note began */
      age: "c";
    };
  };
  /** global time and the track's automation */
  song: {
    main: "c";
    params: {};
    inputs: {};
    outputs: {
      /** song position in beats */
      beat: "c";
      /** position in the bar 0..1 */
      "bar.phase": "c";
      /** tempo in BPM */
      tempo: "c";
    };
  };
};

type PatchPortRow = readonly [string, PatchPortCode, number?, number?, number?];

/** Ports by node type, for wiring and checks at run time. */
export const PATCH_NODE_PORTS: Readonly<
  Record<
    string,
    Readonly<{
      rate: string;
      params: readonly string[];
      inputs: readonly PatchPortRow[];
      outputs: readonly PatchPortRow[];
      engine?: readonly string[];
    }>
  >
> = {
  osc: {
    rate: "any",
    params: ["wave", "pitch", "detune", "pw", "level"],
    inputs: [
      ["pitch", "ca", 0, 20000, 440],
      ["detune", "c", -1200, 1200, 0],
      ["pw", "c", 0.01, 0.99, 0.5],
      ["fm", "a"],
      ["level", "c", 0, 4, 1],
    ],
    outputs: [["out", "a"]],
  },
  noise: {
    rate: "any",
    params: ["color", "level"],
    inputs: [["level", "c", 0, 4, 1]],
    outputs: [["out", "a"]],
  },
  svf: {
    rate: "any",
    params: ["mode", "cutoff", "q"],
    inputs: [
      ["in", "a"],
      ["cutoff", "c", 20, 20000, 1000],
      ["q", "c", 0, 1, 0.5],
    ],
    outputs: [["out", "a"]],
  },
  onepole: {
    rate: "any",
    params: ["mode", "cutoff"],
    inputs: [
      ["in", "a"],
      ["cutoff", "c", 20, 20000, 1000],
    ],
    outputs: [["out", "a"]],
  },
  adsr: {
    rate: "any",
    params: ["gate", "attack", "decay", "sustain", "release"],
    inputs: [
      ["gate", "c", 0, 1, 0],
      ["attack", "c", 0, 10, 0.01],
      ["decay", "c", 0, 10, 0.1],
      ["sustain", "c", 0, 1, 0.7],
      ["release", "c", 0, 10, 0.2],
    ],
    outputs: [["out", "c"]],
  },
  ar: {
    rate: "any",
    params: ["gate", "attack", "release"],
    inputs: [
      ["gate", "c", 0, 1, 0],
      ["attack", "c", 0, 10, 0.01],
      ["release", "c", 0, 10, 0.2],
    ],
    outputs: [["out", "c"]],
  },
  slew: {
    rate: "any",
    params: ["in", "rise", "fall"],
    inputs: [
      ["in", "c", -1000000, 1000000, 0],
      ["rise", "c", 0, 10, 0.05],
      ["fall", "c", 0, 10, 0.05],
    ],
    outputs: [["out", "c"]],
  },
  follow: {
    rate: "any",
    params: ["attack", "release"],
    inputs: [
      ["in", "a"],
      ["attack", "c", 0.0001, 1, 0.005],
      ["release", "c", 0.001, 4, 0.1],
    ],
    outputs: [["out", "c"]],
  },
  lfo: {
    rate: "any",
    params: ["shape", "sync", "rate", "phase", "depth"],
    inputs: [
      ["rate", "c", 0, 100, 1],
      ["phase", "c", 0, 1, 0],
      ["depth", "c", 0, 1, 1],
    ],
    outputs: [["out", "c", -1, 1]],
  },
  sh: {
    rate: "any",
    params: ["in", "trig"],
    inputs: [
      ["in", "c", -1000000, 1000000, 0],
      ["trig", "c", 0, 1, 0],
    ],
    outputs: [["out", "c"]],
  },
  random: { rate: "any", params: ["per"], inputs: [], outputs: [["out", "c"]] },
  const: {
    rate: "any",
    params: ["value"],
    inputs: [],
    outputs: [["out", "c"]],
  },
  add: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  mul: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 1],
    ],
    outputs: [["out", "c"]],
  },
  min: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  max: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  gt: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  lt: {
    rate: "any",
    params: ["a", "b"],
    inputs: [
      ["a", "c", -1000000, 1000000, 0],
      ["b", "c", -1000000, 1000000, 0],
    ],
    outputs: [["out", "c"]],
  },
  abs: {
    rate: "any",
    params: ["in"],
    inputs: [["in", "c", -1000000, 1000000, 0]],
    outputs: [["out", "c"]],
  },
  not: {
    rate: "any",
    params: ["in"],
    inputs: [["in", "c", -1000000, 1000000, 0]],
    outputs: [["out", "c"]],
  },
  pitch2hz: {
    rate: "any",
    params: ["in"],
    inputs: [["in", "c", -1000000, 1000000, 0]],
    outputs: [["out", "c"]],
  },
  db2gain: {
    rate: "any",
    params: ["in"],
    inputs: [["in", "c", -1000000, 1000000, 0]],
    outputs: [["out", "c"]],
  },
  scale: {
    rate: "any",
    params: ["curve", "in", "inmin", "inmax", "min", "max"],
    inputs: [
      ["in", "c", -1000000, 1000000, 0],
      ["inmin", "c", -1000000, 1000000, -1],
      ["inmax", "c", -1000000, 1000000, 1],
      ["min", "c", -1000000, 1000000, 0],
      ["max", "c", -1000000, 1000000, 1],
    ],
    outputs: [["out", "c"]],
  },
  clamp: {
    rate: "any",
    params: ["in", "min", "max"],
    inputs: [
      ["in", "c", -1000000, 1000000, 0],
      ["min", "c", -1000000, 1000000, 0],
      ["max", "c", -1000000, 1000000, 1],
    ],
    outputs: [["out", "c"]],
  },
  clock: {
    rate: "global",
    params: ["beats", "width"],
    inputs: [["width", "c", 0.01, 0.99, 0.5]],
    outputs: [["out", "c"]],
  },
  vca: {
    rate: "any",
    params: ["gain"],
    inputs: [
      ["in", "a"],
      ["gain", "ca", 0, 4, 1],
    ],
    outputs: [["out", "a"]],
  },
  mix: {
    rate: "any",
    params: ["la", "lb", "lc", "ld"],
    inputs: [
      ["a", "a"],
      ["b", "a"],
      ["c", "a"],
      ["d", "a"],
      ["la", "c", 0, 4, 1],
      ["lb", "c", 0, 4, 1],
      ["lc", "c", 0, 4, 1],
      ["ld", "c", 0, 4, 1],
    ],
    outputs: [["out", "a"]],
  },
  xfade: {
    rate: "any",
    params: ["x"],
    inputs: [
      ["a", "a"],
      ["b", "a"],
      ["x", "c", 0, 1, 0.5],
    ],
    outputs: [["out", "a"]],
  },
  pan: {
    rate: "any",
    params: ["pan"],
    inputs: [
      ["in", "a"],
      ["pan", "c", -1, 1, 0],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  voicesum: {
    rate: "global",
    params: [],
    inputs: [["in", "a"]],
    outputs: [["out", "a"]],
  },
  "engine.synth": {
    rate: "global",
    params: [
      "instrument",
      "attack",
      "decay",
      "sustain",
      "release",
      "gain",
      "noise",
      "density",
      "detune",
      "spread",
      "pw",
      "pwrate",
      "pwsweep",
      "vib",
      "vibmod",
      "penv",
      "pattack",
      "pdecay",
      "psustain",
      "prelease",
      "lpf",
      "lpq",
      "lpenv",
      "lpattack",
      "lpdecay",
      "lpsustain",
      "lprelease",
      "hpf",
      "hpq",
      "hpenv",
      "hpattack",
      "hpdecay",
      "hpsustain",
      "hprelease",
      "bpf",
      "bpq",
      "bpenv",
      "bpattack",
      "bpdecay",
      "bpsustain",
      "bprelease",
      "fanchor",
      "fm",
      "fmh",
      "fmattack",
      "fmdecay",
      "fmsustain",
      "fmrelease",
      "fm2",
      "fmh2",
      "fmattack2",
      "fmdecay2",
      "fmsustain2",
      "fmrelease2",
      "fm3",
      "fmh3",
      "fmattack3",
      "fmdecay3",
      "fmsustain3",
      "fmrelease3",
      "fm4",
      "fmh4",
      "fmattack4",
      "fmdecay4",
      "fmsustain4",
      "fmrelease4",
      "fm5",
      "fmh5",
      "fmattack5",
      "fmdecay5",
      "fmsustain5",
      "fmrelease5",
      "fm6",
      "fmh6",
      "fmattack6",
      "fmdecay6",
      "fmsustain6",
      "fmrelease6",
      "fm7",
      "fmh7",
      "fmattack7",
      "fmdecay7",
      "fmsustain7",
      "fmrelease7",
      "fm8",
      "fmh8",
      "fmattack8",
      "fmdecay8",
      "fmsustain8",
      "fmrelease8",
      "zrand",
      "curve",
      "slide",
      "deltaSlide",
      "pitchJump",
      "pitchJumpTime",
      "lfo",
      "zmod",
      "zcrush",
      "zdelay",
      "tremolo",
    ],
    inputs: [
      ["notes", "n"],
      ["attack", "c", 0, 10, 0.003],
      ["decay", "c", 0, 10, 0.05],
      ["sustain", "c", 0, 1, 1],
      ["release", "c", 0, 10, 0.05],
      ["gain", "c", 0, 4, 1],
      ["noise", "c", 0, 1, 0],
      ["density", "c", 0, 1, 0.03],
      ["detune", "c", 0, 12, 0.2],
      ["spread", "c", 0, 1, 0.6],
      ["pw", "c", 0, 1, 0.5],
      ["pwrate", "c", 0, 40, 1],
      ["pwsweep", "c", 0, 1, 0],
      ["vib", "c", 0, 64, 0],
      ["vibmod", "c", 0, 24, 0.5],
      ["penv", "c", -48, 48, 0],
      ["pattack", "c", 0, 10, 0.2],
      ["pdecay", "c", 0, 10, 0],
      ["psustain", "c", 0, 1, 1],
      ["prelease", "c", 0, 10, 0],
      ["lpf", "c", 20, 20000, 2000],
      ["lpq", "c", 0, 50, 1],
      ["lpenv", "c", -10, 10, 0],
      ["lpattack", "c", 0, 10, 0.005],
      ["lpdecay", "c", 0, 10, 0.15],
      ["lpsustain", "c", 0, 1, 0],
      ["lprelease", "c", 0, 10, 0.1],
      ["hpf", "c", 20, 20000, 200],
      ["hpq", "c", 0, 50, 1],
      ["hpenv", "c", -10, 10, 0],
      ["hpattack", "c", 0, 10, 0.005],
      ["hpdecay", "c", 0, 10, 0.15],
      ["hpsustain", "c", 0, 1, 0],
      ["hprelease", "c", 0, 10, 0.1],
      ["bpf", "c", 20, 20000, 1000],
      ["bpq", "c", 0, 50, 1],
      ["bpenv", "c", -10, 10, 0],
      ["bpattack", "c", 0, 10, 0.005],
      ["bpdecay", "c", 0, 10, 0.15],
      ["bpsustain", "c", 0, 1, 0],
      ["bprelease", "c", 0, 10, 0.1],
      ["fanchor", "c", 0, 1, 0],
      ["fm", "c", 0, 64, 0],
      ["fmh", "c", 0, 32, 1],
      ["fmattack", "c", 0, 10, 0],
      ["fmdecay", "c", 0, 10, 0],
      ["fmsustain", "c", 0, 1, 1],
      ["fmrelease", "c", 0, 10, 0],
      ["fm2", "c", 0, 64, 0],
      ["fmh2", "c", 0, 32, 1],
      ["fmattack2", "c", 0, 10, 0],
      ["fmdecay2", "c", 0, 10, 0],
      ["fmsustain2", "c", 0, 1, 1],
      ["fmrelease2", "c", 0, 10, 0],
      ["fm3", "c", 0, 64, 0],
      ["fmh3", "c", 0, 32, 1],
      ["fmattack3", "c", 0, 10, 0],
      ["fmdecay3", "c", 0, 10, 0],
      ["fmsustain3", "c", 0, 1, 1],
      ["fmrelease3", "c", 0, 10, 0],
      ["fm4", "c", 0, 64, 0],
      ["fmh4", "c", 0, 32, 1],
      ["fmattack4", "c", 0, 10, 0],
      ["fmdecay4", "c", 0, 10, 0],
      ["fmsustain4", "c", 0, 1, 1],
      ["fmrelease4", "c", 0, 10, 0],
      ["fm5", "c", 0, 64, 0],
      ["fmh5", "c", 0, 32, 1],
      ["fmattack5", "c", 0, 10, 0],
      ["fmdecay5", "c", 0, 10, 0],
      ["fmsustain5", "c", 0, 1, 1],
      ["fmrelease5", "c", 0, 10, 0],
      ["fm6", "c", 0, 64, 0],
      ["fmh6", "c", 0, 32, 1],
      ["fmattack6", "c", 0, 10, 0],
      ["fmdecay6", "c", 0, 10, 0],
      ["fmsustain6", "c", 0, 1, 1],
      ["fmrelease6", "c", 0, 10, 0],
      ["fm7", "c", 0, 64, 0],
      ["fmh7", "c", 0, 32, 1],
      ["fmattack7", "c", 0, 10, 0],
      ["fmdecay7", "c", 0, 10, 0],
      ["fmsustain7", "c", 0, 1, 1],
      ["fmrelease7", "c", 0, 10, 0],
      ["fm8", "c", 0, 64, 0],
      ["fmh8", "c", 0, 32, 1],
      ["fmattack8", "c", 0, 10, 0],
      ["fmdecay8", "c", 0, 10, 0],
      ["fmsustain8", "c", 0, 1, 1],
      ["fmrelease8", "c", 0, 10, 0],
      ["zrand", "c", 0, 1, 0],
      ["curve", "c", 0, 3, 1],
      ["slide", "c", -20, 20, 0],
      ["deltaSlide", "c", -20, 20, 0],
      ["pitchJump", "c", -2000, 2000, 0],
      ["pitchJumpTime", "c", 0, 10, 0],
      ["lfo", "c", 0, 10, 0],
      ["zmod", "c", 0, 1000, 0],
      ["zcrush", "c", 0, 1, 0],
      ["zdelay", "c", 0, 1, 0],
      ["tremolo", "c", 0, 1, 0],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["synth", "wavetable", "sampler"],
  },
  "engine.modal": {
    rate: "global",
    params: [
      "instrument",
      "hardness",
      "position",
      "ring",
      "tilt",
      "damp",
      "motordepth",
      "buzz",
      "click",
      "gain",
    ],
    inputs: [
      ["notes", "n"],
      ["hardness", "c", 0, 1, 0.4],
      ["position", "c", 0, 1, 0.42],
      ["ring", "c", 0.05, 30, 1.6],
      ["tilt", "c", 0, 2, 0.9],
      ["damp", "c", 0, 1, 0],
      ["motordepth", "c", 0, 1, 0],
      ["buzz", "c", 0, 1, 0],
      ["click", "c", 0, 1, 0],
      ["gain", "c", 0, 2, 0.8],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["modal"],
  },
  "engine.string": {
    rate: "global",
    params: [
      "instrument",
      "ring",
      "damp",
      "pos",
      "bright",
      "mute",
      "buzz",
      "vib",
      "vibmod",
      "gain",
      "pressure",
      "speed",
      "sord",
      "dyn",
    ],
    inputs: [
      ["notes", "n"],
      ["ring", "c", 0.05, 60, 3],
      ["damp", "c", 0, 1, 0.4],
      ["pos", "c", 0.02, 0.5, 0.15],
      ["bright", "c", 0, 1, 0.6],
      ["mute", "c", 0, 1, 0],
      ["buzz", "c", 0, 1, 0],
      ["vib", "c", 0, 12, 0],
      ["vibmod", "c", 0, 2, 0.18],
      ["gain", "c", 0, 2, 1],
      ["pressure", "c", 0, 1, 0.5],
      ["speed", "c", 0, 1, 0.6],
      ["sord", "c", 0, 1, 0],
      ["dyn", "c", 0, 1, 1],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["string"],
  },
  "engine.wind": {
    rate: "global",
    params: ["instrument", "breath", "noise", "wah", "growl", "flutter"],
    inputs: [
      ["notes", "n"],
      ["breath", "c", 0, 1, 0.6],
      ["noise", "c", 0, 1, 0.08],
      ["wah", "c", 0, 1, 1],
      ["growl", "c", 0, 1, 0],
      ["flutter", "c", 0, 1, 0],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["wind"],
  },
  "engine.sing": {
    rate: "global",
    params: [
      "instrument",
      "morph",
      "formant",
      "bright",
      "breath",
      "vibmod",
      "ring",
      "overtone",
      "sub",
    ],
    inputs: [
      ["notes", "n"],
      ["morph", "c", 0, 1, 1],
      ["formant", "c", -12, 12, 0],
      ["bright", "c", 0, 1, 0.5],
      ["breath", "c", 0, 1, 0.12],
      ["vibmod", "c", 0, 1, 0.3],
      ["ring", "c", 0, 1, 0],
      ["overtone", "c", 0, 1, 0],
      ["sub", "c", 0, 1, 0],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["sing"],
  },
  "engine.granular": {
    rate: "global",
    params: [
      "instrument",
      "pos",
      "scan",
      "grain",
      "overlap",
      "jitter",
      "spray",
      "pitch",
      "detune",
      "shimmer",
      "spread",
      "reverse",
      "repeat",
      "drift",
    ],
    inputs: [
      ["notes", "n"],
      ["pos", "c", 0, 1, 0],
      ["scan", "c", -4, 4, 1],
      ["grain", "c", 0.005, 2, 0.08],
      ["overlap", "c", 0.05, 32, 4],
      ["jitter", "c", 0, 1, 0.25],
      ["spray", "c", 0, 2, 0.01],
      ["pitch", "c", -48, 48, 0],
      ["detune", "c", 0, 24, 0],
      ["shimmer", "c", 0, 1, 0],
      ["spread", "c", 0, 1, 0.3],
      ["reverse", "c", 0, 1, 0],
      ["repeat", "c", 0, 1, 0],
      ["drift", "c", 0, 1, 0],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["granular"],
  },
  "engine.keys": {
    rate: "global",
    params: [
      "instrument",
      "hardness",
      "touch",
      "decay",
      "release",
      "knock",
      "noise",
      "felt",
      "tone",
      "vibe",
      "trem",
      "drive",
      "rotary",
    ],
    inputs: [
      ["notes", "n"],
      ["hardness", "c", 0, 1, 0.5],
      ["touch", "c", 0, 1, 1],
      ["decay", "c", 0.1, 4, 1],
      ["release", "c", 0.1, 4, 1],
      ["knock", "c", 0, 1, 0.5],
      ["noise", "c", 0, 1, 0.25],
      ["felt", "c", 0, 1, 0],
      ["tone", "c", 0, 12000, 0],
      ["vibe", "c", 0, 1, 0],
      ["trem", "c", 0, 1, 0],
      ["drive", "c", 0, 1, 0.15],
      ["rotary", "c", 0, 2, 1],
    ],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["keys"],
  },
  "engine.vocoder": {
    rate: "global",
    params: ["instrument"],
    inputs: [["notes", "n"]],
    outputs: [
      ["out", "a"],
      ["right", "a"],
    ],
    engine: ["vocoder"],
  },
  "fx.filter": {
    rate: "global",
    params: ["type", "ftype", "cutoff", "resonance"],
    inputs: [
      ["in", "a"],
      ["cutoff", "c", 20, 20000, 2000],
      ["resonance", "c", 0, 1, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.djf": {
    rate: "global",
    params: ["value"],
    inputs: [
      ["in", "a"],
      ["value", "c", 0, 1, 0.5],
    ],
    outputs: [["out", "a"]],
  },
  "fx.autofilter": {
    rate: "global",
    params: [
      "type",
      "shape",
      "cutoff",
      "resonance",
      "depth",
      "sync",
      "rate",
      "phase",
      "follow",
    ],
    inputs: [
      ["in", "a"],
      ["cutoff", "c", 20, 20000, 1200],
      ["resonance", "c", 0, 1, 0.3],
      ["depth", "c", 0, 6, 2],
      ["sync", "c", 0, 64, 4],
      ["rate", "c", 0.01, 40, 0.5],
      ["phase", "c", 0, 1, 0],
      ["follow", "c", -6, 6, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.formant": {
    rate: "global",
    params: ["shift", "mix"],
    inputs: [
      ["in", "a"],
      ["shift", "c", -12, 12, 0],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.vowel": {
    rate: "global",
    params: ["vowel", "to", "mix", "morph"],
    inputs: [
      ["in", "a"],
      ["mix", "c", 0, 1, 1],
      ["morph", "c", 0, 1, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.crush": {
    rate: "global",
    params: ["bits", "coarse", "mix"],
    inputs: [
      ["in", "a"],
      ["bits", "c", 1, 16, 8],
      ["coarse", "c", 1, 64, 1],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.distort": {
    rate: "global",
    params: ["type", "drive", "tone", "mix", "postgain"],
    inputs: [
      ["in", "a"],
      ["drive", "c", 0, 10, 2],
      ["tone", "c", 200, 20000, 8000],
      ["mix", "c", 0, 1, 1],
      ["postgain", "c", 0, 2, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.stomp": {
    rate: "global",
    params: ["type", "gain", "tone", "level", "octave", "mix"],
    inputs: [
      ["in", "a"],
      ["gain", "c", 0, 10, 5],
      ["tone", "c", 0, 1, 0.5],
      ["level", "c", -24, 12, 0],
      ["octave", "c", 0, 1, 0.7],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.head": {
    rate: "global",
    params: [
      "type",
      "gain",
      "bass",
      "mid",
      "treble",
      "presence",
      "master",
      "sag",
      "gate",
      "level",
    ],
    inputs: [
      ["in", "a"],
      ["gain", "c", 0, 10, 5],
      ["bass", "c", 0, 10, 5],
      ["mid", "c", 0, 10, 5],
      ["treble", "c", 0, 10, 5],
      ["presence", "c", 0, 10, 5],
      ["master", "c", 0, 10, 5],
      ["sag", "c", 0, 1, 0.3],
      ["gate", "c", -96, 0, -60],
      ["level", "c", -24, 12, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.cab": {
    rate: "global",
    params: ["type", "mic", "mix"],
    inputs: [
      ["in", "a"],
      ["mic", "c", 0, 1, 0.3],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.wobble": {
    rate: "global",
    params: ["depth", "rate", "drift"],
    inputs: [
      ["in", "a"],
      ["depth", "c", 0, 100, 20],
      ["rate", "c", 0.05, 8, 0.5],
      ["drift", "c", 0, 1, 0.3],
    ],
    outputs: [["out", "a"]],
  },
  "fx.bloom": {
    rate: "global",
    params: ["amount", "harm", "delay", "time"],
    inputs: [
      ["in", "a"],
      ["amount", "c", 0, 1, 0.5],
      ["harm", "c", 1, 4, 2],
      ["delay", "c", 0, 4, 0.6],
      ["time", "c", 0.05, 4, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.swell": {
    rate: "global",
    params: ["time", "mix"],
    inputs: [
      ["in", "a"],
      ["time", "c", 0.01, 4, 0.4],
      ["mix", "c", 0, 1, 1],
    ],
    outputs: [["out", "a"]],
  },
  "fx.tremolo": {
    rate: "global",
    params: ["shape", "sync", "rate", "depth", "skew", "phase"],
    inputs: [
      ["in", "a"],
      ["sync", "c", 0, 64, 0.5],
      ["rate", "c", 0.01, 40, 4],
      ["depth", "c", 0, 1, 0.5],
      ["skew", "c", 0, 1, 0.5],
      ["phase", "c", 0, 1, 0],
    ],
    outputs: [["out", "a"]],
  },
  "fx.compressor": {
    rate: "global",
    params: ["threshold", "ratio", "knee", "attack", "release", "makeup"],
    inputs: [
      ["in", "a"],
      ["threshold", "c", -60, 0, -18],
      ["ratio", "c", 1, 20, 4],
      ["knee", "c", 0, 24, 6],
      ["attack", "c", 0.0001, 1, 0.01],
      ["release", "c", 0.01, 2, 0.15],
      ["makeup", "c", 0, 24, 5],
    ],
    outputs: [["out", "a"]],
  },
  "fx.double": {
    rate: "global",
    params: ["time", "drift", "width"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["time", "c", 5, 60, 22],
      ["drift", "c", 0, 10, 3],
      ["width", "c", 0, 1, 0.6],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.phaser": {
    rate: "global",
    params: ["rate", "sync", "depth", "center", "sweep"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["rate", "c", 0.01, 40, 0.5],
      ["sync", "c", 0, 64, 0],
      ["depth", "c", 0, 1, 0.75],
      ["center", "c", 100, 10000, 1000],
      ["sweep", "c", 0, 8000, 2000],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.chorus": {
    rate: "global",
    params: ["rate", "depth", "mix"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["rate", "c", 0.01, 40, 0.8],
      ["depth", "c", 0, 1, 0.4],
      ["mix", "c", 0, 1, 0.5],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.leslie": {
    rate: "global",
    params: ["mix", "rate", "size"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["mix", "c", 0, 1, 1],
      ["rate", "c", 0.01, 40, 6.7],
      ["size", "c", 0, 1, 0.5],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.postgain": {
    rate: "global",
    params: ["gain"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["gain", "c", 0, 4, 1],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.delay": {
    rate: "global",
    params: ["pingpong", "beats", "feedback", "mix", "time", "highcut"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["beats", "c", 0.0625, 4, 0.75],
      ["feedback", "c", 0, 0.9, 0.35],
      ["mix", "c", 0, 1, 0.25],
      ["time", "c", 0, 4, 0],
      ["highcut", "c", 500, 20000, 5000],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  "fx.reverb": {
    rate: "global",
    params: ["mix", "size", "fade", "lowpass", "dim", "predelay"],
    inputs: [
      ["left", "a"],
      ["right", "a"],
      ["mix", "c", 0, 1, 0.3],
      ["size", "c", 0, 1, 0.5],
      ["fade", "c", 0.1, 20, 2],
      ["lowpass", "c", 200, 20000, 8000],
      ["dim", "c", 200, 20000, 3000],
      ["predelay", "c", 0, 0.5, 0.02],
    ],
    outputs: [
      ["left", "a"],
      ["right", "a"],
    ],
  },
  in: {
    rate: "global",
    params: [],
    inputs: [],
    outputs: [
      ["notes", "n"],
      ["audio", "a"],
      ["right", "a"],
      ["side", "a"],
    ],
  },
  out: {
    rate: "global",
    params: [],
    inputs: [
      ["audio", "a"],
      ["right", "a"],
    ],
    outputs: [],
  },
  voice: {
    rate: "voice",
    params: [],
    inputs: [],
    outputs: [
      ["pitch", "c"],
      ["note", "c"],
      ["gate", "c"],
      ["velocity", "c"],
      ["phase", "c"],
      ["random", "c"],
      ["index", "c"],
      ["age", "c"],
    ],
  },
  song: {
    rate: "global",
    params: [],
    inputs: [],
    outputs: [
      ["beat", "c"],
      ["bar.phase", "c"],
      ["tempo", "c"],
    ],
  },
};

// END patch nodes
