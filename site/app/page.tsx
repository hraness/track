import Link from "next/link";
import type { ReactNode } from "react";
import { MarketingPillars } from "@hraness/design-kit/react/server";

import { CodeBlock } from "./code-block";
import {
  installCommand,
  productMessaging,
  repoUrl,
  sourceInstallCommands,
} from "./messaging";
import { DawgPlatformInstall } from "./platform-install";
import { latestRelease, releaseTarballUrl } from "./release";
import { Screen } from "./screens/screen";
import { SiteHeader } from "./site-header";

// Re-check for a new release hourly (RELEASE_REVALIDATE); Next needs a literal.
export const revalidate = 3600;

const pillars = [
  {
    title: "Play it",
    body: "Ctrl-P turns the computer keyboard into a piano. Record over the loop with a click and count-in, quantized to the grid.",
  },
  {
    title: "Type it",
    body: "tempo 96, loop chorus, reverb 0.3. Every edit is a short command that runs offline, and every key and menu row shows the command it runs.",
  },
  {
    title: "Ask for it",
    body: "Plain requests go to an agent. It types its commands into your prompt as it works, so you see each one land and can type it yourself next time.",
  },
  {
    title: "Keep it as code",
    body: "A project is song.ts plus one track.ts per track, typed against a small SDK. Edit them in any editor and the open song updates.",
  },
] as const;

const questions = [
  {
    q: "Do I need an account?",
    a: "No. The session lives in .dawg/ in your folder, and commands, playback, recording and rendering work offline. You only need a provider for the agent.",
  },
  {
    q: "Which models does the agent use?",
    a: "Run dawg model key. It finds what you already have: a Vercel AI Gateway or OpenRouter key, or a ChatGPT/Codex or Claude subscription through xcb. /model picks a model and shows the estimated cost per prompt; the default is opus-5.5.",
  },
  {
    q: "Where does the sound come from?",
    a: "dawg's own synthesizers, sampler and drum kit. It plays through a native audio sink, prebuilt for macOS and Linux on arm64 and x64, and falls back to ffplay, SoX or afplay. dawg doctor shows which one it uses.",
  },
  {
    q: "Can the agent wreck my song?",
    a: "Every tool call is validated and dry-run before it commits, and each accepted call is its own revision, so undo removes exactly that change. Esc stops a turn and keeps what landed.",
  },
  {
    q: "Can I get the song out?",
    a: "dawg render song.wav writes a WAV through the same renderer that plays, byte-identical across runs; dawg render song.mid writes MIDI. The project files are plain TypeScript in your folder.",
  },
  {
    q: "What does it cost?",
    a: "dawg is free and MIT licensed. Agent turns are billed by your gateway or OpenRouter account, or count against your subscription.",
  },
] as const;

const projectCode = `// tracks/drums/track.ts
import { track, euclid, grid } from "dawg";

export default track({
  name: "drums",
  instrument: "kit",
  rhythm: [
    euclid("kick", 4, 16),
    euclid("hat", 7, 16, 2, { velocity: 0.5 }),
    grid("snare", "....X.......x..."),
  ],
});`;

/** One feature: label column on the left, copy and real screens on the right. */
function Feature({
  id,
  index,
  label,
  heading,
  screens,
  children,
}: Readonly<{
  id: string;
  index: string;
  label: string;
  heading: string;
  screens?: readonly string[];
  children: ReactNode;
}>) {
  return (
    <section className="dawg-section" aria-labelledby={id}>
      <SectionHead id={id} index={index} label={label} heading={heading} />
      <div className="dawg-section__body dawg-feature">
        <div className="dawg-feature__copy">{children}</div>
        {screens === undefined ? null : (
          <div className="dawg-feature__screens">
            {screens.map((screen) => (
              <Screen key={screen} id={screen} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** A section's mono label and heading, in the left column of the studio grid. */
function SectionHead({
  id,
  index,
  label,
  heading,
  children,
}: Readonly<{
  id: string;
  index: string;
  label: string;
  heading: string;
  children?: ReactNode;
}>) {
  return (
    <header className="dawg-section__head">
      <p className="dawg-eyebrow">
        <span aria-hidden="true">{index}</span> {label}
      </p>
      <h2 id={id} className="dawg-section__title">
        {heading}
      </h2>
      {children}
    </header>
  );
}

export default async function Home() {
  const release = await latestRelease();
  return (
    <>
      <SiteHeader active="home" />
      <main id="main" tabIndex={-1} className="dawg-main">
        <section className="dawg-hero" aria-labelledby="hero-title">
          <p className="dawg-eyebrow dawg-hero__eyebrow">
            {productMessaging.category}
          </p>
          <h1 id="hero-title" className="dawg-hero__title">
            A DAW in your terminal,{" "}
            <span className="dawg-hero__dawg">dawg</span>.
          </h1>
          <div className="dawg-hero__row">
            <p className="dawg-lede">{productMessaging.short}</p>
            <div className="dawg-hero__install">
              <DawgPlatformInstall installCommand={installCommand} />
              <p className="dawg-hero__links">
                <Link href="/docs" data-analytics-cta>
                  Read the docs
                </Link>
                <a href={repoUrl}>Source on GitHub</a>
                <span>MIT · macOS and Linux</span>
              </p>
            </div>
          </div>
          <div className="dawg-hero__demo">
            <Screen
              id="hero"
              caption="A real frame: four tracks playing in a loop of bars 1 to 4 while the agent types its next command into the prompt."
            />
          </div>
        </section>

        <section className="dawg-clips" aria-labelledby="pillars-title">
          <h2 id="pillars-title" className="dawg-visually-hidden">
            Four ways to make the same edit
          </h2>
          <MarketingPillars
            ariaLabel="Four ways to make the same edit"
            className="dawg-clips__grid"
            columns={4}
            pillars={pillars.map((pillar) => ({
              label: pillar.title,
              summary: pillar.body,
            }))}
          />
        </section>

        <Feature
          id="highway-title"
          index="01"
          label="Highway"
          heading="Notes fall toward the hit line"
          screens={["highway"]}
        >
          <p>
            The main view is a piano roll turned on its side. Every track
            scrolls down to the hit line in its own color, with the focused
            track bright, sustains stretched across beats and a lane per drum
            voice. The prompt stays live underneath, so you edit while the loop
            plays.
          </p>
          <p>
            The header shows the transport, tempo, bar.beat, loop, key and
            model. Space on an empty prompt plays and pauses.
          </p>
        </Feature>

        <Feature
          id="play-title"
          index="02"
          label="Play and record"
          heading="Your keyboard is a piano"
          screens={["play-mode"]}
        >
          <p>
            Ctrl-P turns the home row into white keys and the row above into
            black keys. <code>z</code> and <code>x</code> shift octaves,{" "}
            <code>q</code> plays chords, and <code>r</code> records over the
            loop with a click and count-in, quantized to the grid you set with{" "}
            <code>grid 1/16</code>.
          </p>
          <p>
            Live keys go through a native audio sink. On macOS a key is heard
            about 17 ms after the press, measured on a loopback (
            <code>bench/sink-latency.ts</code>).
          </p>
        </Feature>

        <Feature
          id="tape-title"
          index="03"
          label="Tape"
          heading="Every track across the bars"
          screens={["tape"]}
        >
          <p>
            Ctrl-T opens TAPE: one row per track, sections and the loop bracket
            on top. Each key runs one command and echoes it on the prompt, so{" "}
            <code>c</code> shows you <code>copy</code> and <code>\</code> loops
            the section under the playhead.
          </p>
          <p>
            Copy, cut, paste, insert and clear bars; repeats of the song form
            are shaded, and an edit there tells you which copies it changes.
          </p>
        </Feature>

        <Feature
          id="sound-title"
          index="04"
          label="Sound and mix"
          heading="Four knobs and a mixer"
          screens={["knobs", "mix"]}
        >
          <p>
            The knobs drawer puts four parameters of the focused track on four
            colored, shaped knobs (● ▲ ■ ◆). ↑↓ picks one, ←→ turns it. The same
            drawer turns the mix, the master, tempo or any effect.
          </p>
          <p>
            Instruments include synths, wavetables, pianos and electric keys,
            organs, strings, winds, mallets, a sampler and a drum kit. Filter,
            delay, reverb and the other effects take automation lanes. The
            sampler loads Strudel-format sample packs;{" "}
            <Link href="/vs/strudel">dawg vs Strudel</Link> covers how the two
            relate.
          </p>
        </Feature>

        <Feature
          id="patch-title"
          index="05"
          label="Patches"
          heading="Build a sound from modules"
          screens={["patch"]}
        >
          <p>
            A patch is a small modular synth or effect: oscillators, filters,
            envelopes and math, plus dawg&rsquo;s own engines and effects as
            nodes, joined by cables. <code>/patch</code> shows the focused
            track&rsquo;s nodes in signal order, the ports of the selected one
            and a cable matrix. <code>a</code> adds a node, <code>w</code> wires
            it and <code>m</code> maps a parameter to a knob; each key runs a
            typed <code>patch</code> command and echoes it. The first four
            macros are the four knobs.
          </p>
          <p>
            Eight patches ship built in, such as <code>acid-bass</code>,{" "}
            <code>fm-bell</code> and the <code>sidechain-pump</code> effect.{" "}
            <code>patch save mybass --user</code> keeps one in your library and{" "}
            <code>patch load github:user/repo/name</code> fetches one pinned by
            hash. The agent edits patches with the same commands, and{" "}
            <code>song.ts</code> builds them with <code>patch()</code> and
            Strudel-style signals such as{" "}
            <code>sine.range(300, 2400).slow(4)</code>.
          </p>
        </Feature>

        <Feature
          id="menu-title"
          index="06"
          label="Menu"
          heading="Ctrl-K opens every control"
          screens={["menu"]}
        >
          <p>
            Ctrl-K opens a menu of everything dawg can do, grouped by topic.
            Each row shows its value and, dimmed, the command it runs, so the
            menu teaches the commands as you use it. Changes are staged on a
            loop until you keep them.
          </p>
          <p>
            <code>?</code> lists the keys for the screen you are on, and F1
            opens the guides.
          </p>
        </Feature>

        <Feature
          id="styles-title"
          index="07"
          label="Styles and voice"
          heading="Start from a style, add a singer"
        >
          <p>
            <code>style deep-house 16</code> writes a whole song from a style
            card: meter, groove, scale, harmony and form. The taxonomy covers
            about 850 styles in eight families. The same style, bars and seed
            always make the same song, and <code>style blend</code> mixes two.
          </p>
          <p>
            A built-in singer sings your melody on vowels or lyrics (
            <code>sing choir</code>, <code>lyrics sun-lit morn-ing</code>).
            Import vocal takes and tune them with autotune, formant shift and a
            vocoder.
          </p>
        </Feature>

        <Feature
          id="agent-title"
          index="08"
          label="Agent"
          heading="Watch the agent type its commands"
          screens={["showme", "agent"]}
        >
          <p>
            Anything that isn&rsquo;t a command goes to the agent. With show-me
            on, it types dawg commands into your prompt as it writes them, and
            each runs as its line ends. The card at the end lists what changed
            and the command to do it yourself.
          </p>
          <p>
            It edits only through typed tools. Each call is validated and
            dry-run against the score before it commits as its own revision, so
            Ctrl-Z removes exactly that change. Esc stops a turn and keeps what
            landed.
          </p>
          <p>
            Bring a Vercel AI Gateway or OpenRouter key, or a ChatGPT/Codex or
            Claude subscription through{" "}
            <a href="https://github.com/hraness/xcb">xcb</a>.{" "}
            <code>dawg model key</code> finds what you have.
          </p>
        </Feature>

        <Feature
          id="panes-title"
          index="09"
          label="Panes"
          heading="One song in several terminals"
          screens={["panes"]}
        >
          <p>
            Open the same song in more terminals: one plays, one shows TAPE, one
            the knobs. A small local daemon, <code>dawgd</code>, keeps one score
            and one transport for all of them. Each pane has a letter and its
            own undo; <code>follow b</code> mirrors pane B.
          </p>
          <p>
            Every edit is written to disk before any window sees it, so a
            crashed pane or daemon loses nothing; the next window picks up the
            session.
          </p>
        </Feature>

        <Feature
          id="files-title"
          index="10"
          label="Project files"
          heading="Songs are typed TypeScript"
        >
          <p>
            <code>dawg init</code> writes <code>song.ts</code> and one{" "}
            <code>tracks/&lt;slug&gt;/track.ts</code> per track. Edit them in
            any editor, or let the agent, and every open window applies the
            change as one undo step. Edit in the TUI and the file is reprinted.{" "}
            <code>dawg check</code> typechecks the project.
          </p>
          <CodeBlock code={projectCode} />
        </Feature>

        <Feature
          id="local-title"
          index="11"
          label="Offline"
          heading="Offline, low-latency, exact renders"
          screens={["audio"]}
        >
          <p>
            Commands, playback, recording and rendering need no account or
            network. Live keys play through a native audio sink, about 17 ms
            from key to sound on macOS. Pick output and input devices with{" "}
            <code>audio out</code> and <code>audio in</code>; the choice is
            saved on this machine, not in the song.
          </p>
          <p>
            <code>dawg render out.wav</code> writes the song through the same
            renderer that plays it, byte-identical across runs, and prints the
            sha256. <code>out.mid</code> writes MIDI.
          </p>
        </Feature>

        <section
          className="dawg-section dawg-install"
          id="install"
          aria-labelledby="install-title"
        >
          <SectionHead
            id="install-title"
            index="12"
            label="Get started"
            heading="Install"
          >
            <p>
              dawg runs on <a href="https://bun.sh">Bun</a> 1.3.14 or newer. The
              script installs Bun if it&rsquo;s missing, downloads the latest
              release tarball from GitHub, checks it against the release&rsquo;s
              SHA256SUMS and installs it with <code>bun add -g</code>.
            </p>
          </SectionHead>
          <div className="dawg-section__body">
            {release.published ? null : (
              <p className="dawg-notice" role="status">
                The first release of dawg is coming soon. Until it&rsquo;s out
                the script stops with a note instead of installing; run it from
                source in the meantime.
              </p>
            )}
            <div className="dawg-install__grid">
              <div>
                <h3>Install script</h3>
                <CodeBlock code={`$ ${installCommand}`} />
                <p className="dawg-small">
                  <a href="/install">Read the script</a> before you pipe it.
                </p>
              </div>
              {release.published ? (
                <div>
                  <h3>Release tarball with Bun</h3>
                  <CodeBlock
                    code={`$ bun add -g ${releaseTarballUrl(release.version)}`}
                  />
                  <p className="dawg-small">
                    Each <a href={release.url}>release</a> ships the tarball,
                    SHA256SUMS and a build provenance attestation.
                  </p>
                </div>
              ) : null}
              <div>
                <h3>From source</h3>
                <CodeBlock
                  code={sourceInstallCommands
                    .map((line) => `$ ${line}`)
                    .join("\n")}
                />
              </div>
            </div>
            <p>
              Sound plays through dawg&rsquo;s native audio sink on macOS and
              Linux; where it cannot load, install <code>ffplay</code> (from
              FFmpeg) or SoX. Then run <code>dawg</code> in any folder and
              follow the <Link href="/docs">docs</Link>.
            </p>
          </div>
        </section>

        <section className="dawg-section" aria-labelledby="faq-title">
          <SectionHead
            id="faq-title"
            index="13"
            label="FAQ"
            heading="Questions"
          />
          <div className="dawg-section__body dawg-faq">
            {questions.map((item) => (
              <details key={item.q}>
                <summary>
                  {item.q}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
