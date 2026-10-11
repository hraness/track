# dawg

A music workstation in your terminal. Play notes on your computer
keyboard, type short commands like `tempo 120`, or ask an agent in plain
words. Projects are typed TypeScript files you can edit anywhere.

Everything runs on your machine: the song lives in `.dawg` in your
folder, there is no account, and the commands work offline. The agent
is optional.

Docs: [dawg.sh/docs](https://dawg.sh/docs) (the same guides as `/guide`
in the app) · [dawg vs Strudel](https://dawg.sh/vs/strudel)

## Install

dawg needs [Bun](https://bun.sh) 1.3.14 or newer.

```sh
curl -fsSL https://dawg.sh/install | sh
```

## Start a song

```sh
mkdir my-song && cd my-song
dawg
```

Then try:

```text
track drums
pattern house
track bass
add C2 at 0 for 1
tempo 120
```

Space on an empty prompt plays and pauses; Ctrl-Z undoes any step.

## Four ways to do anything

Every guide shows the same four ways, so you can pick the one you like:

- **Ask.** Type a plain sentence ("make the hats swing") and the agent
  edits the song, typing each command it runs so you learn them.
- **Type it yourself.** Short commands such as `loop 5-6`, `reverb 0.4`
  or `style deep-house 16`. `/help` lists them all.
- **Menu.** Ctrl-K opens a menu of settings; a number row opens a
  fader you can drag or step.
- **Keys.** Ctrl-P turns the keyboard into a piano; Ctrl-T opens TAPE,
  every track across the bars; `?` shows the keys for any screen.

Open the same song in more than one terminal: each pane gets a letter
and its own undo, and they share one transport (`guide panes`).

## Other ways to install

Install the release tarball from GitHub directly:

```sh
bun add -g https://github.com/hraness/dawg/releases/download/v0.8.0/hraness-dawg-0.8.0.tgz
dawg --help
```

Each [release](https://github.com/hraness/dawg/releases) is immutable and ships the tarball, a `SHA256SUMS` file and a build provenance attestation. To check a download before installing it:

```sh
gh release download v0.8.0 --repo hraness/dawg
shasum -a 256 -c SHA256SUMS
gh attestation verify hraness-dawg-0.8.0.tgz --repo hraness/dawg
bun add -g "$PWD/hraness-dawg-0.8.0.tgz"
```

dawg is also on npm as [`@hraness/dawg`](https://www.npmjs.com/package/@hraness/dawg):

```sh
npm i -g @hraness/dawg
# or
bun add -g @hraness/dawg
```

To run from source instead:

```sh
git clone https://github.com/hraness/dawg.git
cd dawg
bun install --frozen-lockfile
bun run dawg
```

Running `dawg` creates `.dawg/session` when needed (the first launch says `created .dawg/ · add it to .gitignore`) and attaches to that session on later launches. Use `dawg --new` for a new composition, `dawg --session <name|id>` to attach explicitly (an unknown name or id is an error, `no session named "…" · dawg sessions`, never a new session), or `dawg --track bass` to focus a named track. `dawg --version` prints the version; an unknown subcommand or option is rejected with usage before anything is written, and `dawg sessions --help`, `dawg render --help` and `dawg auth --help` print their own usage.

## Sessions and windows

Every window you open on a session takes the first track no other window has focused, in score order. Open three terminals on a three-track session and each one restores a different instrument. A fourth window gets a draft track (`track-4`, "all tracks open · new track") that is added to the score on its first edit, so idle windows never clutter the song. `--track` always wins over auto-claim.

Sessions have names. A new session starts as `untitled` and is named automatically from what you play (`a minor bass groove`, `dusty basement funk`). `/rename <name>` sets your own name and stops auto-naming for good; `/rename --auto` hands it back. A user rename always beats an auto-name that was still in flight, and every window updates. `/fork [name]` snapshots the current song into a new session (`night drive` → `night drive 2` → `night drive 3`; a fork of `night drive 2` is `night drive 3`) and switches this window to it. `/sessions` lists sessions in an overlay (one summary card stays in the strip), `/resume` opens a picker (↑/↓, Enter or a digit, Esc) and `/resume <n|name|id>` switches directly by any list index, name or id prefix. Undo in a fork steps back past the fork point into the parent's history. `dawg sessions` prints the same list from the shell.

Auto-naming is cheap. dawg keeps a local musical fingerprint (tempo, key estimate, instruments, register, density and effects) and only asks a model when the music actually changed, at most once every few turns, after three quiet seconds. The request is about 120 tokens in and 12 out through the configured provider (gateway `anthropic/claude-haiku-4.5`, or xcb), runs in the background so it never blocks the prompt, and falls back to a local name such as `96 bpm drums` when offline or with `DAWG_AI=0`. In tests a typical 10-prompt session makes 2–3 naming calls.

## Commands

A sample of what you can type at the prompt:

```text
add C4 at 0 for 1
play
pause
tempo 128
instrument piano
volume 0.7
pan -0.4
automate volume at 0 0.2
automate volume at 4 1
automate pan at 0 -1
automate pan at 4 1
/track drums
instrument kit
hit kick at 0
hit snare at 1 vel 0.7
pattern kick 0 1 2 3
pattern hat every 0.5 from 0.25
clear hat
filter 1200
filter 800 0.6
filter off
delay 0.375 0.3
delay 0.75 0.4 0.5
delay off
reverb 0.3
reverb 0.4 0.8
reverb off
automate filter at 0 400
automate filter at 4 6000
automate resonance at 0 0.2
automate delay-feedback at 0 0.6
automate delay-mix at 4 0
clear filter automation
bars 8
extend 4 bars
clear automation
mute
solo
unsolo
clear
undo
redo
move note <id> to 2.5
duration note <id> 0.25
/export loop.track.json
/import loop.track.json
/model             pick a model (cost per prompt shown)
```

`/help` opens the command reference in an overlay under ten topics (sound, voice, effects, rhythm, chords, mix, arrange, project, keys, agent), with every command listed once in its bare form (`tempo 96`, `track drums`, `export loop.wav`); the slash is optional everywhere, and only `/rename`, `/fork`, `/resume`, `/auth` and `/play` (play mode; bare `play` is the transport) keep it. The same topic ids work in `/guide` and `/menu`. An unknown `/word` is rejected locally (`unknown command /foo · /help`), and a known verb with bad arguments gets usage (`pan 3 · pan takes -1…1 · pan -0.5`) instead of a model call. `/track <name>` focuses a track in this window, creating it when it is new; a track another live window has open stays theirs (`drums is open in another window`).

A track named `drums` (or `kit`) starts with the `kit` instrument; `instrument kit` turns any track into a drum track. Drums are `kick` (`bd`), `snare` (`sd`), `clap` (`cp`), `rim` (`perc`), `tom`, `hat` (`hh`), and `openhat` (`oh`); the highway shows one lane per voice. `pattern <voice> <beats...>` takes up to 64 beats, `pattern <voice> every <step>` (step ≥ 0.125) fills the loop, `vel <0..1>` sets velocity, and `clear <voice>` removes only that voice. `filter <hz> [resonance]` is a per-track low-pass (20–20000 Hz, resonance 0–1), `delay <beats> [feedback] [mix]` is a tempo-synced stereo ping-pong echo send (0.0625–4 beats, feedback ≤ 0.9, mix 0–1), `reverb <mix> [size]` is an algorithmic stereo reverb send (mix 0–1, size 0–1, default 0.5; `reverb off` removes it), and `automate filter|resonance|delay-feedback|delay-mix at <beat> <value>` writes the cutoff (Hz), resonance (0–1), delay feedback (0–0.9) and delay mix (0–1) lanes. `solo` isolates the focused track in playback across every window; `redo` re-applies the last undone edit.

## The screen

The screen has four parts. A one-line header shows `dawg` · track · ▶/⏸ BPM · key · session · window count (when more than one) on the left and model · rev · sync state on the right; narrower terminals drop the least important segments first. The highway overlays every unmuted track, each in its own stable accent, with the focused track bright and the others dimmed; `/view focus` shows only the focused track and `/view all` (the default) brings the rest back. A track with no hits shows `main · empty · add C4 at 0 to start` in place of lane labels. Below it, an activity strip shows operation cards (`✓ +8 bass notes · rev 41→42 · ^z undo`; the undo hint accompanies the first three score edits), queue depth, a braille spinner while the agent works, and errors in red with an `✗` prefix in one shape, `<what> · <why> · <next step>` (`no such file · nope.json`). The prompt panel is filled with a background color. It wraps by grapheme, grows from 1 to 8 rows (capped at 30% of the screen, then scrolls internally) and keeps the draft when the terminal is resized. Narrow terminals collapse the header and hints. Below 60×16 the screen shows `terminal too small · W×H · need ≥ 60×16`, centered and updating as you resize; playback, the daemon and the agent keep going, space plays and stops, q and ctrl-c quit, other keys are dropped, and the real UI comes back unchanged once the terminal is big enough.

| Key                   | Action                                                                       |
| --------------------- | ---------------------------------------------------------------------------- |
| Space (empty prompt)  | play / pause                                                                 |
| Enter                 | send now (NOW) or run after the agent turn (NEXT)                            |
| Shift-Enter, Ctrl-J   | newline                                                                      |
| Alt-Enter             | run this prompt next, after the agent turn                                   |
| Ctrl-Q                | toggle the NOW / NEXT pill                                                   |
| Ctrl-Z / Ctrl-Y       | undo / redo                                                                  |
| Ctrl-O, `/transcript` | transcript overlay: ↑/↓, PgUp/PgDn scroll, `/` filters requests, ops, errors |
| Esc                   | cancel the agent turn, close the overlay, or clear the draft                 |
| Ctrl-L                | full redraw                                                                  |
| Ctrl-C                | exit                                                                         |

## TAPE, knobs and panes

Ctrl-T opens TAPE: every track across the bars, one row each, with sections and the loop bracket on top. Each key runs one typed command and echoes it on the prompt (`c` copies the range, `v` pastes it, `\` loops the section here), so the screen teaches the typed form. The same edits as commands: `loop 5-6`, `copy bass 5-6 to 7 x2`, `move bass 5-6 to 9`, `clear bass 5-6`, `reverse bass 5-6`, `bars insert 2 at 9`, `jump 5.3`, `section split chorus at 13`, `form print`. `knobs` turns four knobs (● ▲ ■ ◆) on the sound, `mix`, master, tempo or an effect. Several terminals can share one session as panes: `panes` lists them, `pane tape` turns this one into a tape pane, `pin` keeps the drawer on one parameter and `follow b` mirrors pane B. `undo` undoes this pane's last edit; `undo all` anyone's. `audio out <name>` and `audio in <name>` pick devices on this machine (`audio test` plays a tone; `dawg doctor` shows the choice). `/help arrange`, `/help panes` and `/guide tape` teach each of these.

A NOW send runs ahead of work waiting as NEXT. Bracketed paste preserves multiline input.

## Patches

A patch is a small modular synth or effect: oscillators, filters, envelopes and math, plus dawg's own engines and effects as nodes, joined by cables. `patch load acid-bass` puts a built-in on the focused track and `/patch` opens it (Ctrl-K › Sound › patch):

```text
 ⏸ 121 BPM · 1.1 · bass        Bb dorian · opus-5.5 · gateway · rev 2 · ○ local
 patch bass ▸ acid-bass (instrument · 7 nodes · 10 cables · 1 voice)
 NODES                        │ vcf  svf · voice
 voice    ◆                   │▸mode    lp
 tone     ◆ osc saw           │ in      ← tone.out
 env      ◆ adsr              │ cutoff  ← envamt.out
 envamt   ◆ scale lin         │ q       ← ·
 amp      ◆ adsr              │ out     → vca.in
▸vcf      ◆ svf lp            │
 vca      ◆                   │
────────────────────────────────────────────────────────────────────────────────
 CABLES     vcf.in vcf.cutoff vcf.q vca.in
 tone.out   ~      ·          ·     ·
 envamt.out ·      ▪          ·     ·
 vcf.out    ·      ·          ·     ~
 Cutoff            ▪
 Reso                         ▪
 ◆ voice ● global ~ audio ▪ control ♪ notes Σ voice sum ✕ dropped
 ● Cutoff 600 ███── ▲ Reso 0.7 █████── ■ Env 2400 ███──── ◆ Drive 2.5 ██────
 tab pane · enter edit · a add · w wire · x remove · m knob · ? keys
 ✓ patch bass ▸ acid-bass · 7 nodes · 10 cables · ? keys · esc home
╭─ NOW ────────────────────────────────────────────────────────────────────────╮
│ ›  describe a change — “double the melody an octave up”                      │
╰─────────────────── night drive · $0 session · $0 today · opus-5.5 · gateway ─╯
```

Nodes run in signal order (`◆` per voice, `●` once), the selected node's ports sit beside them, and the cable matrix shows outputs down and inputs across. `a` adds a node, `w` wires, `x` removes, `m` maps a parameter to a knob, and each key runs a typed `patch …` command that echoes on the prompt (`patch add svf as vcf`, `patch wire tone.out vcf.in`, `patch macro …`). The first four macros are the four knobs. Eight patches ship built in: `acid-bass`, `supersaw-pad`, `fm-bell`, `pluck-ks` and `wobble` instruments, and `sidechain-pump`, `wide-crush` and `formant-vox` effects (`--fx <name>` edits an effect patch). `patch save <name> --user` keeps one in your library, `patch load github:<user>/<repo>/<name>` fetches one pinned by hash, and `patch show` prints the lines that rebuild a patch. The agent edits patches with the `patch_edit` tool, and `song.ts` builds them with `patch()` and Strudel-style signals (`mods: { cutoff: sine.range(300, 2400).slow(4) }`). See **Patches** in [DAWG.md](./DAWG.md#patches) and `/help sound`.

## Themes and accessibility

`/theme default|high-contrast|mono` and `--theme <name>` (or `DAWG_THEME`) pick a theme. Semantic color tokens map to truecolor, 256, 16 or no color. `NO_COLOR` and `TERM=dumb` force monochrome. `/motion off`, `--reduce-motion` or `DAWG_REDUCE_MOTION=1` replace animations with static states in the same positions. Every color has a non-color cue as well: glyph density, `✓`/`✗`/`!` prefixes, the mode pill text and `▶`/`⏸`.

## Project files

`dawg init` turns the current directory into a project: `song.ts` and one `tracks/<slug>/track.ts` per track, written with a small typed SDK (`import { track, note, hit } from "dawg"`). Edit them in any editor (or let the agent edit them) and every open window applies the change as one revision; edit in the TUI and the affected file is reprinted. `dawg check` typechecks and evaluates the files and exits 1 with `file:line:col` diagnostics. See **Project files and SDK** in [DAWG.md](./DAWG.md).

## Agent and models

Run `dawg model key` (or just `dawg` the first time) to give the agent a model; `dawg login` is an alias. dawg looks for what is already on the machine, in parallel and with a 4 s cap, then shows one picker: ↑/↓ or a number, Enter to choose, Esc to cancel. The first detected option is the default, and when exactly one is ready it just asks `Use <it>? [Y/n]`.

| Option                     | Detected from                                                        | Setup                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vercel AI Gateway          | `AI_GATEWAY_API_KEY`, a stored dawg key, `vercel whoami`             | With the Vercel CLI: `vercel login` in the browser if needed, then a key named `dawg-<hostname>` is created (`--budget <dollars>` sets its limit). Without it: opens the keys page and takes a pasted key (hidden input).      |
| OpenRouter                 | `OPENROUTER_API_KEY`, a stored dawg key                              | OpenRouter's OAuth PKCE flow: dawg opens the browser on a one-time `127.0.0.1` callback, checks the state, exchanges the code for a key and verifies it (5 min timeout; the URL is printed too). `--key` pastes a key instead. |
| ChatGPT/Codex subscription | [xcb](https://github.com/hraness/xcb) accounts with provider `codex` | Lists ready accounts and their models; runs `xcb setup codex` (in the browser) when none is ready.                                                                                                                             |
| Claude subscription        | xcb accounts with provider `claude`                                  | Same, with `xcb setup claude`.                                                                                                                                                                                                 |

- Shortcuts: `dawg model key gateway|openrouter|codex|claude` (`--account <id> --model <id>` for subscriptions), `dawg model key --xcb` for any xcb account, `dawg model key --key` to paste a gateway key.
- The choice sticks. dawg saves the provider, model and account in `~/.config/dawg/config.json` (0600, written atomically, never a key) and reuses it on every start and `dawg model key` without asking. `dawg model key <provider>`, `/model` and `dawg logout [provider]` change or clear it. If the saved provider stops working (revoked key, account gone), dawg says so once and opens the picker; it never switches providers on its own.
- `model key` in the TUI suspends the screen, runs the same flow (browser and `vercel login` included) and redraws when done.
- `dawg model` (or `/model` in the TUI) picks a model for the active provider, grouped as frontier, fast and open weights, with type-to-filter and an estimated cost per prompt (`~$0.004/prompt`) from [models.dev](https://models.dev) pricing (OpenRouter's own `/models` prices on OpenRouter); subscriptions show `included`. On the gateway and OpenRouter only tool-calling models are listed; for subscriptions the list is what xcb reports for the account. `/model opus-5.5` sets one directly, and any `vendor/model` ID the provider serves works too.
- Under the prompt, `$0.12 session · $0.48 today · opus-5.5 · gateway` shows spend from the usage each response reports (the provider's own cost when given, else tokens × price). The daily total is shared across windows through `~/.config/dawg/usage.json`. Subscriptions show `subscription`.
- `dawg auth status` (also `/auth`; `--check` verifies keys online) lists all four options with detected, active and validated state, plus the installed xcb version and the audio backend. Keys appear only masked (`vck_…abcd`).
- Keys go to the macOS Keychain (service `dawg`, passed to `security -i` on stdin so a key never appears in a process list) or `~/.config/dawg/credentials.json` (0600, directory 0700). They are never written to `.dawg/`. Environment keys always win.
- Provider order: `DAWG_PROVIDER`, then the saved choice, then auto (AI Gateway, then OpenRouter, then a ready subscription). `DAWG_AI=0` turns the agent off. The header shows `<model> · <provider>`.
- Subscriptions need xcb 0.20.0 or newer. An account is usable when xcb reports it `available`; one still in automatic admission (`admission: pending`) works, but its first turn can take up to a minute longer. Accounts whose catalog is missing are refreshed once (`xcb accounts refresh`) during discovery.

On the gateway and OpenRouter, unrecognized requests go to a streaming, tool-calling agent through the OpenAI-compatible chat API. The default is `opus-5.5` (`anthropic/claude-opus-5.5`); `DAWG_MODEL=<alias|vendor/model>` overrides it, and an unknown value is an error at startup that lists the choices. xcb has no tool calling, so dawg asks for one JSON object of ops per call and runs each op through the same checks; it retries with diagnostics up to 3 calls per turn.

The agent edits the score only through typed tools: `add_notes`, `add_drums`, `remove_notes`, `update_notes`, `set_instrument`, `set_mix` (with solo), `set_effects` (filter, delay and reverb), `set_automation` (volume, pan, filter cutoff and resonance, delay feedback and mix), `extend_loop`, `set_tempo`, `create_track`, `transport` and `explain`. Each call is validated, then committed as its own revision, and the status line shows its result (for example `✓ +8 bass notes`). While the agent is working, Esc cancels and keeps every change accepted so far. Enter sends a NOW message that the agent reads at its next step. A NEXT submit (Ctrl-Q toggles now / next) waits until the turn ends.

## Sound and audio

Playback renders deterministic stereo PCM with sine, piano, pluck, bass, saw, square, and triangle voices plus a synthesized kit (pitch-swept sine kick, seeded-noise snare and hats), applies per-track volume, equal-power pan (-1 left to 1 right), low-pass filter, ping-pong delay, and a Freeverb-style reverb, and honors mute and solo. Renders are byte-identical across runs. Live keys play through the native sink (a small Rust library with a real audio callback, about 17 ms key to heard on macOS) when a verified prebuilt ships for the platform; otherwise playback falls back to the stdin players, and `dawg doctor` says which and why. Playback is gapless: one long-lived player (the native sink, else `ffplay`, else SoX `play`) reads a seamless loop as raw PCM on stdin, and edits, tempo changes and seeks swap the buffer in place at the current position without restarting it, so the transport stays aligned with what you hear. On macOS without either, `afplay` replays a re-rendered loop on each edit. `dawg auth status` shows the backend; `DAWG_AUDIO=0` runs headless (see Environment for the other switches). `dawg --export file.track.json` and `dawg --import file.track.json` exchange the bounded `track.loop/v1` document. `dawg render out.wav` writes the current session (or `--session <name|id>`, or `--import file.track.json`) to a WAV through the same renderer, without starting dawgd or playing audio; the same score always produces the same bytes, and the command prints the file's sha256. `/status` prints the session name, revision, composition digest and storage (`shared via dawgd` or `saved locally · no daemon`).

The agent can download a YouTube reference, split stems, analyze tempo and key, transcribe notes and lyrics, and import samples into `tracks/<slug>/`; `dawg media doctor` shows which local binaries or StemDeck it will use (see [DAWG.md](./DAWG.md#media-tools)).

## Environment variables

| Variable                                                      | Effect                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DAWG_AUDIO=0`                                                | no sound; the transport still runs (the one audio kill switch)                                                                          |
| `DAWG_AUDIO_BACKEND=native\|ffplay\|sox\|afplay`              | force a player (`none` is still accepted and means the same as `DAWG_AUDIO=0`)                                                          |
| `DAWG_AUDIO_DEVICE`, `DAWG_AUDIO_BUFFER`, `DAWG_PLAY_LEAD_MS` | native sink output device name, device buffer frames (128) and play-mode lead (15 ms; 60 ms on stdin players)                           |
| `DAWG_SINK_LIB`                                               | load this native sink library instead of the verified prebuilt (development; no sha256 check)                                           |
| `DAWG_AUDIO_PLAYER="cmd {rate} {channels}"`                   | stream raw PCM to any stdin player                                                                                                      |
| `DAWG_AI=0`                                                   | agent off; unrecognized requests are rejected locally and naming stays local                                                            |
| `DAWG_PROVIDER=gateway\|openrouter\|codex\|claude\|xcb\|auto` | provider choice (default: the saved choice, else `auto`)                                                                                |
| `DAWG_MODEL=<alias\|vendor/model>`                            | model for this run (unknown values are rejected)                                                                                        |
| `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`                    | win over any stored key                                                                                                                 |
| `XCB_BIN`                                                     | path to xcb for the subscription options                                                                                                |
| `DAWG_CREDENTIAL_STORE=file`, `DAWG_CONFIG_DIR`               | skip the Keychain; move `~/.config/dawg`                                                                                                |
| `DAWG_STEMDECK_URL`                                           | StemDeck for the media tools (default `http://127.0.0.1:8000`; else local yt-dlp, demucs, basic-pitch, whisper-cli)                     |
| `DAWG_DAEMON=0`                                               | file-lock path, no dawgd                                                                                                                |
| `DAWG_DEMO=1`                                                 | print one deterministic frame and exit (also `--demo`, or a non-TTY stdin); `DAWG_DEMO=1 bun run src/main.ts` is the development render |
| `DAWG_THEME`, `DAWG_REDUCE_MOTION=1`                          | theme (`default\|high-contrast\|mono`) and static motion                                                                                |
| `NO_COLOR`, `TERM=dumb`                                       | monochrome                                                                                                                              |

## Architecture

- `core/` defines the bounded immutable `track.loop/v1` score and operations.
- `src/session/` provides an append-only local event log, atomic snapshots, and `dawgd`: one local daemon per session (`src/daemon.ts`), started automatically by the first window. Windows connect over a Unix socket, send idempotent intents, and receive accepted changes, presence, and one shared transport clock. If the daemon cannot start, windows fall back to the file-lock path and say so in the status line. `dawg sessions` lists the workspace's sessions with revision, update time, and live daemon.
- `src/agent/` runs the bounded streaming tool-calling agent: the SSE gateway client, the tool registry, the composition brief, and operation validation.
- `src/agent/workspace.ts` and `src/web/` give the agent bounded project file access (writes scoped to `song.ts` and the focused `tracks/<slug>/`) and web search and fetch with injectable network.
- `core/sdk/` and `src/project/` make a directory with `dawg.json` a project of typechecked TypeScript files (`song.ts`, `tracks/<slug>/track.ts`) kept in two-way sync with the session.
- `src/audio/` owns the transport clock, deterministic instrument-bank WAV rendering, and per-session playback lock. When `dawgd` is running it is the only process that plays audio.
- `tui/` owns terminal capability detection, semantic colors, animation phases, piano-roll rendering, and the multiline prompt editor.

The runtime is intentionally adapter-shaped. The local synthesizer is deterministic and works without a sound device; native or sample-backed players can replace it behind the same score boundary.

See [DAWG.md](./DAWG.md) for the detailed command and interaction contract.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` includes `test/e2e.test.ts`, which drives real `dawg` processes in real PTYs against a temporary workspace and a live dawgd: three windows converging on one revision and digest, shared transport, rename, auto-claim and drafts, undo and redo across windows, fork, `kill -9` recovery and a deterministic render. It needs no network or credentials. See [CHANGELOG.md](./CHANGELOG.md) for release history.

## Releasing

Bump `version` in `package.json` and add its section to `CHANGELOG.md` in a pull request, then merge it. When Check passes on `main`, the annotated `v<version>` tag, the immutable GitHub Release (tarball, `SHA256SUMS` and a provenance attestation) and the npm publish of `@hraness/dawg` follow automatically. See [docs/publishing.md](./docs/publishing.md).

## License

dawg is MIT licensed. Contributions should preserve bounded inputs, deterministic score operations, local session safety, and a working terminal fallback when color or animation is unavailable.
