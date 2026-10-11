# dawg

dawg is a free, MIT-licensed, local-first music workstation for the terminal, built on Bun. You play notes on the computer keyboard, type short commands, or ask an agent that edits through typed, validated tools. The song scrolls on a piano-roll highway above the prompt, and the project is typed TypeScript files. This file records the positioning the dawg.sh site carries.

## Platform

- Repository: [hraness/dawg](https://github.com/hraness/dawg), MIT.
- CLI: `dawg`. Package: `@hraness/dawg`, distributed as a GitHub Release tarball with `SHA256SUMS` and a build provenance attestation, and published to npm (`npm i -g @hraness/dawg`, `bun add -g @hraness/dawg`).
- Runtime: Bun 1.3.14 or newer. The CLI has no runtime dependencies.
- Site: [dawg.sh](https://dawg.sh), this `site/` directory, deployed by Vercel project `dawg` with root directory `site/`.

## Users

- Developers who live in a terminal and want to sketch music without leaving it.
- People who already pay for a Claude or ChatGPT/Codex subscription, or have an OpenRouter or AI Gateway key, and want to point it at something fun.
- Agent tinkerers who want to see a tool-calling agent edit a structured document they can hear.

## Positioning

The hook, used in the site title, hero and share card:

- “A DAW in your terminal, dawg.”

The short line, used under the hook and in package descriptions:

- “Play it on your keyboard, type short commands, or ask an agent. Songs are typed TypeScript files in your folder.”

The four pillars, in order (four ways to make the same edit):

1. **Play it.** Ctrl-P turns the computer keyboard into a piano; record over the loop with a click and count-in, quantized to the grid.
2. **Type it.** Every edit is a short command that runs offline, and every key and menu row shows the command it runs.
3. **Ask for it.** Plain requests go to an agent that types its commands into your prompt as it works (show-me); each change is one undo step.
4. **Keep it as code.** A project is `song.ts` plus a `track.ts` per track, typed against a small SDK; edit them in any editor and the open song updates.

Category label: “Terminal music workstation.”

## Capabilities the site may claim

Only what `README.md`, `DAWG.md` and `CHANGELOG.md` on `main` describe:

- Instruments sine, piano, pluck, bass, saw, square, triangle and a synthesized drum kit (kick, snare, clap, rim, tom, hat, openhat).
- Per-track volume, pan, mute, solo, low-pass filter, ping-pong stereo delay, Freeverb-style reverb, and automation lanes for volume, pan, filter cutoff, resonance, delay feedback and delay mix.
- Gapless playback through a native audio sink (prebuilt for macOS and Linux, arm64 and x64), with `ffplay`, SoX `play` or `afplay` as fallbacks.
- Undo and redo from the shared session log.
- `dawgd`: one daemon per session, shared transport, crash recovery, file-lock fallback.
- Auto-claim of the next instrument per window; draft track beyond the last.
- Named sessions, `/rename`, numbered `/fork`, `/sessions`, `/resume`, auto-naming from a local fingerprint.
- `dawg model key` (AI Gateway, OpenRouter, or a Claude or ChatGPT/Codex subscription through xcb), `dawg model`, `dawg auth status`, `dawg logout`. Default model `opus-5.5`.
- Patches (`/patch`): modular instruments and effects built from nodes and cables, with four macro knobs and eight built-ins.
- TAPE (Ctrl-T) for ranges of bars; panes (one song in several terminals, a letter each); play mode (Ctrl-P) and recording; show-me (the agent types the commands it runs).
- Strudel-format sample packs (`/pack add`), read from the documented manifest format without Strudel code.
- Themes default, high-contrast and mono; reduced motion; `NO_COLOR`.
- `dawg render out.wav`, byte-identical across runs.

## Constraints

- Install lines, in order: the dawg.sh script, then `npm i -g @hraness/dawg` / `bun add -g @hraness/dawg`, then the release tarball.
- Until a GitHub Release exists, the install script exits with “the first release of dawg is coming soon” and the site shows the source install instead of a tarball link.
- No live MIDI, plugin or DAW-project-export claims; dawg writes WAV and MIDI files only.
- Comparisons live on their own pages (`/vs/strudel`), cite the other tool's own docs, say where it is better, and never disparage.

## Brand commitments

- Every screen on the site is real: `test/screens/capture.ts` drives the real `dawg` in a PTY on seeded projects and commits cell grids to `docs/screens/*.json`, rendered as selectable text. Regenerate with `bun run screens`; `bun run check` fails when a screen is stale.
- Analytics are cookieless PostHog in the shared Hraness project (543691) with `site_id: "dawg"`. Copy events never send copied text.
