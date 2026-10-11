/**
 * `EXEC_POLICY`: what the agent's `exec` tool may pass to each allowlisted
 * CLI. Every flag is listed with its arity and the role of its value; every
 * positional has a role. Anything not listed is refused by name, so a new
 * flag is a reviewed change here, never a silent pass-through.
 *
 * Threat model (DAWG.md › exec): dawg's agent can already run code as the
 * user through project `.ts` files, so this confinement stops accidents and
 * injected content (a page or a video title asking for a command), not a
 * malicious agent. It is still strict: inputs must stay inside the project
 * (or read roots), outputs inside the write scope, and only download tools
 * may name a URL.
 */

/** What a flag's value (or a positional) is. */
export type ArgRole =
  | "input"
  | "output"
  | "outdir"
  | "number"
  | "word"
  | "text"
  | "filter"
  | "url"
  | "template"
  | readonly string[];

export type FlagSpec = Readonly<{ arity: 0 | 1; role?: ArgRole }>;

export type ToolPolicy = Readonly<{
  flags: Readonly<Record<string, FlagSpec>>;
  /** Flags refused with a reason (clearer than "unknown flag"). */
  refused?: Readonly<Record<string, string>>;
  /** Flag prefixes refused with a reason (`-hls_`, `--exec`). */
  refusedPrefixes?: Readonly<Record<string, string>>;
  /** Role of each positional: a fixed list, then `rest` for the remainder. */
  positionals: Readonly<{ fixed?: readonly ArgRole[]; rest?: ArgRole; max?: number }>;
  /** Argv prepended after argv[0] (forced safety flags). */
  prepend?: readonly string[];
}>;

const f0: FlagSpec = { arity: 0 };
const num: FlagSpec = { arity: 1, role: "number" };
const word: FlagSpec = { arity: 1, role: "word" };
const text: FlagSpec = { arity: 1, role: "text" };
const input: FlagSpec = { arity: 1, role: "input" };
const output: FlagSpec = { arity: 1, role: "output" };
const outdir: FlagSpec = { arity: 1, role: "outdir" };
const filter: FlagSpec = { arity: 1, role: "filter" };

/** Container formats ffmpeg may read or write with `-f`. */
export const FFMPEG_FORMATS = Object.freeze([
  "wav", "flac", "mp3", "ogg", "opus", "aiff", "caf", "w64", "ipod", "mp4", "m4a",
  "adts", "s16le", "s24le", "s32le", "f32le", "f64le", "u8", "null", "matroska", "webm",
] as const);

/** Filters refused by name: they load code, read arbitrary files or talk out. */
export const FFMPEG_REFUSED_FILTERS = Object.freeze([
  "ladspa", "lv2", "frei0r", "frei0r_src", "sendcmd", "asendcmd", "zmq", "azmq",
  "movie", "amovie", "arnndn", "lut3d", "lut1d", "haldclut", "drawtext", "subtitles",
  "ass", "sofalizer", "ocr", "ocv", "dnn_processing", "dnn_classify", "dnn_detect",
  "sr", "derain", "dnn", "vidstabdetect", "vidstabtransform", "libplacebo",
] as const);

/** Filter option names whose value is a file. */
export const FILTER_FILE_KEYS = new Set([
  "file", "filename", "f", "fontfile", "textfile", "model", "m", "stats_file", "lut", "sofa",
]);

const FFMPEG_SHARED: Record<string, FlagSpec> = {
  "-hide_banner": f0,
  "-nostdin": f0,
  "-nostats": f0,
  "-stats": f0,
  "-loglevel": word,
  "-v": word,
  "-y": f0,
  "-n": f0,
  "-i": input,
  "-ss": text,
  "-to": text,
  "-t": text,
  "-sseof": text,
  "-itsoffset": text,
  "-stream_loop": num,
  "-ar": num,
  "-ac": num,
  "-c:a": word,
  "-codec:a": word,
  "-acodec": word,
  "-c": word,
  "-b:a": word,
  "-q:a": num,
  "-aq": num,
  "-sample_fmt": word,
  "-channel_layout": word,
  "-af": filter,
  "-filter:a": filter,
  "-filter_complex": filter,
  "-lavfi": filter,
  "-map": word,
  "-map_metadata": word,
  "-metadata": text,
  "-vn": f0,
  "-sn": f0,
  "-dn": f0,
  "-shortest": f0,
  "-frames:a": num,
  "-f": { arity: 1, role: FFMPEG_FORMATS },
  "-threads": num,
};

const FFMPEG_REFUSED: Record<string, string> = {
  "-report": "writes a log file outside the project",
  "-passlogfile": "writes a log file",
  "-vstats_file": "writes a stats file",
  "-vstats": "writes a stats file",
  "-sdp_file": "writes an SDP file",
  "-progress": "reports to a URL or file",
  "-dump_attachment": "writes attachments",
  "-attach": "reads an arbitrary file",
  "-protocol_whitelist": "dawg forces -protocol_whitelist file",
  "-protocol_blacklist": "dawg forces -protocol_whitelist file",
  "-safe": "the concat demuxer is refused",
  "-filter_script": "reads a filter graph from a file",
  "-filter_complex_script": "reads a filter graph from a file",
  "-/filter": "reads a filter graph from a file",
  "-/af": "reads a filter graph from a file",
};

const FFMPEG_REFUSED_PREFIXES: Record<string, string> = {
  "-hls_": "HLS writes segment files",
  "-segment_": "the segment muxer writes many files",
  "-dash_": "DASH writes segment files",
};

/** Every sox effect name; those not in SOX_EFFECTS are refused by name. */
export const SOX_ALL_EFFECTS: ReadonlySet<string> = new Set([
  "allpass", "band", "bandpass", "bandreject", "bass", "bend", "biquad", "chorus", "channels",
  "compand", "contrast", "dcshift", "deemph", "delay", "dither", "divide", "downsample",
  "earwax", "echo", "echos", "equalizer", "fade", "fir", "firfit", "flanger", "gain",
  "highpass", "hilbert", "input", "ladspa", "loudness", "lowpass", "mcompand", "noiseprof",
  "noisered", "norm", "oops", "output", "overdrive", "pad", "phaser", "pitch", "rate", "remix",
  "repeat", "reverb", "reverse", "riaa", "silence", "sinc", "spectrogram", "speed", "splice",
  "stat", "stats", "stretch", "swap", "synth", "tempo", "treble", "tremolo", "trim",
  "upsample", "vad", "vol",
]);

const SOX_EFFECTS = Object.freeze([
  "trim", "pad", "fade", "gain", "norm", "tempo", "pitch", "speed", "rate", "channels",
  "remix", "reverse", "silence", "highpass", "lowpass", "bandpass", "equalizer", "bass",
  "treble", "reverb", "compand", "stat", "stats", "spectrogram", "vol", "dither", "repeat",
  "loudness", "contrast", "overdrive", "echo", "chorus", "flanger", "phaser", "tremolo",
] as const);
export const SOX_EFFECT_SET: ReadonlySet<string> = new Set(SOX_EFFECTS);

export const EXEC_POLICY: Readonly<Record<string, ToolPolicy>> = Object.freeze({
  ffmpeg: {
    flags: FFMPEG_SHARED,
    refused: FFMPEG_REFUSED,
    refusedPrefixes: FFMPEG_REFUSED_PREFIXES,
    // Non-option positionals are outputs (inputs only via -i).
    positionals: { rest: "output", max: 8 },
  },
  ffprobe: {
    flags: {
      "-hide_banner": f0,
      "-loglevel": word,
      "-v": word,
      "-i": input,
      "-show_format": f0,
      "-show_streams": f0,
      "-show_frames": f0,
      "-show_packets": f0,
      "-count_frames": f0,
      "-show_entries": text,
      "-select_streams": word,
      "-of": text,
      "-print_format": text,
      "-read_intervals": text,
      "-pretty": f0,
      "-sexagesimal": f0,
      "-af": filter,
      "-f": { arity: 1, role: FFMPEG_FORMATS },
    },
    refused: FFMPEG_REFUSED,
    refusedPrefixes: FFMPEG_REFUSED_PREFIXES,
    positionals: { rest: "input", max: 1 },
  },
  sox: {
    // Global and format options; files and effects are parsed by checkSox.
    flags: {
      "-q": f0,
      "-S": f0,
      "-V": f0,
      "-G": f0,
      "--norm": f0,
      "-m": f0,
      "-M": f0,
      "--combine": { arity: 1, role: ["concatenate", "merge", "mix", "mix-power", "multiply", "sequence"] },
      "-n": f0,
      "-r": num,
      "-c": num,
      "-b": num,
      "-e": word,
      "-t": word,
      "-v": num,
      "-D": f0,
      "--no-dither": f0,
    },
    refused: {
      "--effects-file": "reads effects from a file",
      "--plot": "writes a script",
      "-p": "pipes audio between sox processes",
      "--sox-pipe": "pipes audio between sox processes",
    },
    positionals: { rest: "input" },
  },
  rubberband: {
    flags: {
      "-t": num, "--time": num,
      "-T": num, "--tempo": num,
      "-p": num, "--pitch": num,
      "-f": num, "--frequency": num,
      "-D": num, "--duration": num,
      "-F": f0, "--formant": f0,
      "-3": f0, "--fine": f0,
      "-2": f0, "--faster": f0,
      "-c": num, "--crisp": num,
      "-q": f0, "--quiet": f0,
      "--centre-focus": f0,
      "--pitch-hq": f0,
      "--no-transients": f0,
      "--ignore-clipping": f0,
    },
    refused: {
      "-M": "reads a time map file",
      "--timemap": "reads a time map file",
      "--freqmap": "reads a frequency map file",
      "--pitchmap": "reads a pitch map file",
    },
    positionals: { fixed: ["input", "output"], max: 2 },
  },
  "yt-dlp": {
    prepend: ["--ignore-config", "--no-plugin-dirs", "--no-exec"],
    flags: {
      "-x": f0, "--extract-audio": f0,
      "--audio-format": { arity: 1, role: ["best", "aac", "alac", "flac", "m4a", "mp3", "opus", "vorbis", "wav"] },
      "--audio-quality": word,
      "-f": text, "--format": text,
      "-o": { arity: 1, role: "template" }, "--output": { arity: 1, role: "template" },
      "-P": outdir, "--paths": outdir,
      "--no-playlist": f0,
      "--restrict-filenames": f0,
      "--no-progress": f0, "--newline": f0,
      "-q": f0, "--quiet": f0,
      "--no-warnings": f0,
      "--write-info-json": f0,
      "--no-mtime": f0,
      "--no-part": f0,
      "--download-sections": text,
      "--max-filesize": word,
      "--skip-download": f0, "--simulate": f0, "-s": f0,
      "-J": f0, "--dump-single-json": f0,
      "-j": f0, "--dump-json": f0,
      "--print": text, "-O": text,
      "--get-title": f0, "--get-duration": f0,
    },
    refused: {
      "--ffmpeg-location": "runs a binary of the agent's choosing",
      "--postprocessor-args": "passes arbitrary arguments to ffmpeg",
      "--ppa": "passes arbitrary arguments to ffmpeg",
      "-a": "reads URLs from a file",
      "--batch-file": "reads URLs from a file",
      "--config-location": "reads a config file",
      "--config-locations": "reads a config file",
      "--load-info-json": "reads an arbitrary file",
      "--plugin-dirs": "loads plugins",
      "--use-postprocessor": "loads a postprocessor plugin",
      "--print-to-file": "writes outside the output path",
      "--proxy": "routes traffic through another host",
      "--external-downloader": "runs another program",
      "--downloader": "runs another program",
      "--downloader-args": "passes arguments to another program",
    },
    refusedPrefixes: {
      "--exec": "runs a command",
      "--cookies": "reads browser cookies",
      "--netrc": "reads credentials",
      "--username": "sends credentials",
      "--password": "sends credentials",
    },
    positionals: { rest: "url", max: 1 },
  },
  demucs: {
    flags: {
      "-n": word, "--name": word,
      "-o": outdir, "--out": outdir,
      "--two-stems": word,
      "--mp3": f0, "--flac": f0, "--int24": f0, "--float32": f0,
      "--mp3-bitrate": num,
      "-d": { arity: 1, role: ["cpu", "mps", "cuda"] }, "--device": { arity: 1, role: ["cpu", "mps", "cuda"] },
      "-j": num, "--jobs": num,
      "--shifts": num, "--overlap": num, "--segment": num,
      "--clip-mode": { arity: 1, role: ["rescale", "clamp", "none"] },
      "--filename": { arity: 1, role: "template" },
    },
    refused: {
      "--repo": "loads model files (torch pickles) from a folder",
      "--sig": "selects an unreviewed model signature",
    },
    positionals: { rest: "input", max: 16 },
  },
  "basic-pitch": {
    flags: {
      "--save-midi": f0,
      "--sonify-midi": f0,
      "--save-model-outputs": f0,
      "--save-note-events": f0,
      "--onset-threshold": num,
      "--frame-threshold": num,
      "--minimum-note-length": num,
      "--minimum-frequency": num,
      "--maximum-frequency": num,
      "--multiple-pitch-bends": f0,
      "--midi-tempo": num,
      "--sonification-samplerate": num,
    },
    refused: { "--model-path": "loads a model from an arbitrary path", "--model-serialization": "loads an alternate model" },
    positionals: { fixed: ["outdir"], rest: "input", max: 17 },
  },
  aubio: {
    flags: {
      "-i": input, "--input": input,
      "-r": num, "--samplerate": num,
      "-B": num, "--bufsize": num,
      "-H": num, "--hopsize": num,
      "-s": num, "--silence": num,
      "-t": num, "--threshold": num,
      "-m": word, "--method": word,
      "-T": { arity: 1, role: ["samples", "ms", "seconds"] }, "--time-format": { arity: 1, role: ["samples", "ms", "seconds"] },
      "-u": word, "--pitch-unit": word,
      "-l": num, "--tolerance": num,
      "-M": num, "--minioi": num,
      "-v": f0, "-q": f0,
    },
    positionals: {
      fixed: [["onset", "pitch", "beat", "tempo", "notes", "mfcc", "melbands", "quiet"]],
      rest: "input",
      max: 2,
    },
  },
  aubioonset: aubioTool(),
  aubiotrack: aubioTool(),
  aubionotes: aubioTool(),
  "whisper-cli": {
    flags: {
      "-m": input, "--model": input,
      "-f": input, "--file": input,
      "-l": word, "--language": word,
      "-t": num, "--threads": num,
      "-otxt": f0, "--output-txt": f0,
      "-ojson": f0, "--output-json": f0,
      "-osrt": f0, "--output-srt": f0,
      "-ovtt": f0, "--output-vtt": f0,
      "-ocsv": f0, "--output-csv": f0,
      "-of": output, "--output-file": output,
      "-np": f0, "--no-prints": f0,
      "-nt": f0, "--no-timestamps": f0,
      "-ml": num, "--max-len": num,
      "-sow": f0, "--split-on-word": f0,
      "-tr": f0, "--translate": f0,
      "-pp": f0, "--print-progress": f0,
      "-ot": num, "--offset-t": num,
      "-d": num, "--duration": num,
    },
    positionals: { rest: "input", max: 4 },
  },
});

function aubioTool(): ToolPolicy {
  return {
    flags: {
      "-i": input, "--input": input,
      "-o": output, "--output": output,
      "-r": num, "--samplerate": num,
      "-B": num, "--bufsize": num,
      "-H": num, "--hopsize": num,
      "-s": num, "--silence": num,
      "-t": num, "--threshold": num,
      "-O": word, "--onset": word,
      "-M": num, "--minioi": num,
      "-T": { arity: 1, role: ["samples", "ms", "seconds"] }, "--time-format": { arity: 1, role: ["samples", "ms", "seconds"] },
      "-v": f0, "-q": f0,
    },
    positionals: { rest: "input", max: 1 },
  };
}
