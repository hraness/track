import { docsHref, docsPages, docsTrail } from "../docs/pages";

function docsTrailDepth(id: string): number {
  return docsTrail(id).length - 1;
}
import {
  installCommand,
  productMessaging,
  productUrl,
  repoUrl,
  sourceInstallCommands,
} from "../messaging";
import { latestRelease, releaseTarballUrl } from "../release";

// A machine-readable summary of dawg.sh. The install line follows the real
// release state, so it never promises a tarball that is not published.
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  const release = await latestRelease();
  const installLines = release.published
    ? `- \`${installCommand}\` installs Bun if missing, downloads v${release.version} with SHA256SUMS from GitHub Releases, verifies the checksum and runs \`bun add -g\`.\n- Or \`bun add -g ${releaseTarballUrl(release.version)}\`.`
    : `- The first GitHub Release is coming soon; until then \`${installCommand}\` exits with a notice. Run from source: \`${sourceInstallCommands.join(" && ")}\`.`;
  const docs = [
    `- [Install](${productUrl}/docs): Install dawg and start a session.`,
    ...docsPages.map((page) => {
      const indent = "  ".repeat(docsTrailDepth(page.id));
      const summary = page.description === "" ? "" : `: ${page.description}`;
      return `${indent}- [${page.title}](${productUrl}${docsHref(page.id)})${summary}`;
    }),
  ].join("\n");
  const body = `# dawg

> ${productMessaging.tagline} ${productMessaging.short}

dawg is a free, MIT-licensed, local-first music workstation for the terminal, built on Bun (1.3.14 or newer). You type at a prompt; typed commands such as \`tempo 96\`, \`pattern kick 0 1 2 3\` or \`reverb 0.3\` edit the score directly, and anything else goes to a streaming agent that edits only through typed, validated tools. Every edit is committed as a revision in a shared session log, so undo and redo work from any window. The score scrolls on a piano-roll "highway" above the prompt.

## Install

${installLines}
- npm: \`npm i -g @hraness/dawg\` or \`bun add -g @hraness/dawg\`.
- Source: ${repoUrl}

## What ships

- Instruments: sine, piano, pluck, bass, saw, square, triangle, and a synthesized drum kit (kick, snare, clap, rim, tom, hat, openhat).
- Per-track volume, pan, mute, solo, low-pass filter, ping-pong stereo delay, Freeverb-style reverb, and automation lanes for volume, pan, filter cutoff, resonance, delay feedback and delay mix.
- Gapless playback through dawg's native audio sink (prebuilt for macOS and Linux, arm64 and x64; ffplay, SoX play or afplay as fallbacks); \`dawg render out.wav\` writes byte-identical stereo WAVs.
- dawgd, one local daemon per session: many terminal windows share one score and one transport; it recovers from crashes and falls back to a file lock if it cannot start.
- Each new window claims the next unclaimed instrument, so N windows on an N-track song each play a different track.
- Sessions name themselves from the music; /rename, /fork (numbered), /sessions and /resume.
- Providers: \`dawg model key\` picks one: a Vercel AI Gateway key, OpenRouter (browser sign-in), or a Claude or ChatGPT/Codex subscription through xcb (https://xcb.sh). \`dawg model\` picks the model; the default is opus-5.5.
- Patches (/patch): modular instruments and effects from nodes and cables, four macro knobs, eight built-ins, a user library and \`github:\` patches; \`patch()\` in song.ts.
- TAPE (Ctrl-T): copy, move, loop and repeat ranges of bars.
- Panes: one song in several terminals, one transport, a letter per pane.
- Themes default, high-contrast and mono; reduced motion; NO_COLOR.

## Docs

${docs}
- [dawg vs Strudel](${productUrl}/vs/strudel): How dawg and Strudel differ and fit together.
- [Changelog](${productUrl}/changelog): Every release, from CHANGELOG.md.
- [DAWG.md](${repoUrl}/blob/main/DAWG.md): Architecture and protocol notes.
`;
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
