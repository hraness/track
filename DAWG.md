# dawg

dawg is a local-first terminal music workstation with a Pi-like agent loop. Each terminal window can focus on one track while a shared local session keeps the score, transport, and agent operations in sync. It is designed for `dawg` to feel like a coding agent session where the artifact is a loop you can hear and edit.

The first steel thread includes a typed `track.loop/v1` score, an append-only local session with a cross-window writer lock, a terminal piano-roll projection, a multiline prompt, a bounded streaming tool-calling agent on the Vercel AI Gateway, and a local PCM synthesizer. Provider and audio adapters remain behind explicit ports so the TUI can still be exercised without credentials or a sound device.

## Run

```sh
bun install
bun run dawg
```

Run `dawg` from any directory. It creates `.dawg/session` on first use and reuses that session in later terminal windows. Use `dawg --new` for a separate composition, `dawg --session <name|id>` to attach explicitly (an unknown value is `no session named "…" · dawg sessions`, never a new session), and `dawg --track bass` to focus a named track (normalized like `/track`: lowercase, spaces become `-`, `[a-z0-9._-]{1,64}`, and an existing track matches by id or name, so `--track Bass` focuses `bass`). `dawg --version` prints the version; unknown subcommands and options, a value flag with no value (or one starting with `-`), an invalid `--track` and an unknown `--theme` are rejected with usage and exit 2 before `.dawg/` exists, and `dawg <command> --help` prints usage and writes nothing for every subcommand (`init`, `check` and `sessions` also reject extra arguments). `dawg --import a --export b` converts one loop file to another without opening a session, and a demo frame (`--demo`, or stdin not a terminal) in a directory with no `.dawg/` renders from a throwaway session and leaves nothing behind; and the launch that creates `.dawg/` says `created .dawg/ · add it to .gitignore` in the strip. Every window connects to `dawgd`, a per-session daemon the first window starts in the background. It is the single writer: windows send operations with a base revision and an idempotency key, duplicate keys are no-ops, a stale full composition receives a typed rebase diagnostic, and a stale `operations` intent (what the agent sends) is replayed on the current score when nothing it touches changed since its base (the notes it updates or removes, the tracks it rewrites or clears, tempo and length, and ids it creates; at most 64 revisions back, with the base recovered by rewinding the event log); anything else still gets the rebase diagnostic. Every event stores a compact reverse delta (`rewind`) rather than a copy of the previous score, so a session record grows by about the size of each edit; when it nears its 4 MiB cap the oldest rewinds are compacted away and only that older history becomes unreachable. Rebased events record `rebasedFrom`, and their rewind leads back to the score they replayed on, so undo drops only that change, and on the file fallback the agent commits the full composition with the strict base check. Accepted commits are persisted through the same atomic snapshot store before being broadcast to every window. The daemon also owns the only transport and audio player, broadcasting play, pause, seek, and tempo with a timestamp so every window draws the same hit line. It keeps a presence table (`clientId`, `pid`, focused track) and can atomically claim the first unfocused track for a new window. The daemon exits 30 seconds after its last window closes, removes its socket on SIGTERM, and a crashed daemon's socket and lock are reclaimed by the next window. If `dawgd` cannot be started (or `DAWG_DAEMON=0`), windows fall back to the snapshot under the file lock, watching the session directory with `fs.watch` (so renames and edits from other windows arrive immediately) with a 1 s backstop poll, or a 200 ms poll where watching is unavailable, with presence kept in per-window heartbeat files. `dawg sessions` lists sessions in the current workspace. `dawg render <out.wav|out.mid> [--session <name|id>] [--import <file>]` reads the session record from disk (no daemon, no audio) and writes a stereo 16-bit WAV through the playback renderer (or a Standard MIDI File with tempo and time-signature meta events for `.mid`, see **Tempo and meter**); the same score always yields the same bytes, and the command prints the size and sha256. `/status` reports `status · <name> · rev <n> · <digest> · shared via dawgd` (or `saved locally · no daemon`), where the digest is the 16-hex composition digest dawgd broadcasts. In demo mode a drum track is seeded with a one-bar kick, snare and hat groove instead of melodic notes.

### One command grammar

Every prompt-bar command reads the same with or without its slash (`/fx reverb on` is `fx reverb on`). `remove`, `rm` and `delete` are one verb on every object, and `list`, `presets`, `ls` and a bare noun are one listing. Aliases run their canonical form: `rig <preset>` (`track <preset>` still works), `model key` (`login`), `chords idiom` (`chords style`), `synth filter` (`synth cutoff`), `loop a-b|off` (`loop 2-3` sets the loop range; it makes no section), `export <file>.wav [stems]` (the `dawg render` path; agent paths are workspace-relative), and a bare `pattern <groove>` or `kit <name>`. A known verb that fails answers with one usage card, `✗ tempo 900 · tempo takes 20…300 BPM · tempo 128`, with a nearest suggestion and never a raw core key; it never reaches the agent, and without a provider nothing does. Instruments are checked exactly on write (`✗ instrument sawtoth · did you mean sawtooth? · instrument list`), while stored projects still load. `remove n1` checks the note exists (`✗ no note n1 · notes lists them`). Status reads such as bare `fx` and `tracks` print `•`, and a bare scalar (`tempo`, `volume`) opens its fader (on its four knobs where it is one; see **Four knobs**). The agent tools `set_effects`, `vocode` and `add_drums` still run but are not advertised; use `set_fx`, `set_vocoder` and `set_rhythm`.

### Sessions, names and forks

Each session record carries bounded metadata alongside the score: `name` (1–40 printable characters), `nameSource` (`auto` or `user`), an optional `forkOf {sessionId, revision}`, the fingerprint the current auto-name was computed from, and a `version` counter. Records written before metadata existed load with an id-based auto name. Metadata writes are conditional (`expect {name?, nameSource?}`) and never touch the score revision or event log. Through `dawgd` they are a `meta` frame that the daemon applies, persists atomically and broadcasts; on the file fallback they run under the session lock, and polling windows pick up the newer `meta.version`. `/rename <name>` is unconditional and sets `nameSource=user`, so it wins over any auto-name computed against the old name, which arrives `stale` and is dropped. `/rename --auto` sets `nameSource=auto` and clears the stored fingerprint.

`/fork [name]` writes a new session with a snapshot of the composition at the current revision (not the event log), `forkOf` lineage and a numbered name: strip a trailing ` N` (N ≥ 2) from the parent, then take one more than the highest ` N` among sessions with that base. An explicit name that collides is suffixed the same way. The workspace pointer moves to the fork, so plain `dawg` resumes it. Undo does not stop at the fork point: the fork's history is its own events preceded by each ancestor's events up to the revision it was forked at, following `forkOf` at most 8 levels (stopping at cycles, missing parents or revisions beyond the parent's log) and keeping at most the store's event cap.

On launch, and after `/fork` or `/resume`, a window without `--track` sends an atomic `claim {draft: true}`. dawgd serializes claims on its event loop; the file fallback serializes them under the presence lock. The reply is the first track in score order that no live window has focused, or, when every track is taken, a fresh `track-N` id that is neither in the score nor focused by another window. A draft is only appended to the score (`track.attach`) on the window's first edit. `--session <name|id>` resolves an exact id, then an exact case-insensitive name, then a unique id prefix of at least four characters; ambiguous names list the candidates and exit.

The header shows the session name and, when more than one window is open, the window count. Renames, forks, claims and the all-tracks-open hint appear as activity cards. The session port exposes a structured sync status (`synced`, `syncing`, `conflict`, `offline`, `local`) that drives the header directly.

Auto-naming (`src/session/naming.ts`) is gated on a local musical fingerprint: tempo, a scale-fit key estimate from the pitch-class histogram (tonic and fifth weighted), sorted instrument families, register and density buckets, and effects, hashed into an order- and id-independent digest. After an accepted turn the namer waits for a quiet period, and skips the model when the fingerprint equals the one the current name came from or when fewer than three turns have passed since the last name (a structure change, such as a new instrument family, bypasses the turn gate). The prompt is one fingerprint line, the last two prompts truncated to 60 characters each, and the current name, with `max_tokens: 12`. The reply is untrusted: it is stripped to 2–4 lowercase words of at most 32 characters, and a reply equal to the current name keeps it (hysteresis). The write is conditional on the name and `nameSource` the request started from, and a newer request supersedes an older one, so a slow provider (xcb takes about 7 s) can never overwrite a user rename. Forks keep their ` N` suffix through auto-renames, and a name already used by another session is suffixed. The generator is an injectable `NameGenerator`; the default calls `generateText` from `src/agent/provider.ts` and falls back to the deterministic local name.

### Session history

Every committed session event is also a row in `.dawg/history.db` (`src/history/`, `bun:sqlite`, WAL), one database per workspace across all its sessions and forks. The JSON session record stays the source of truth: history is a sidecar written after the record's fsync by both writers (`dawgd` and the file fallback), so a failed or missing database never fails an edit, and `DAWG_HISTORY=off` turns it off. On first open dawg imports the existing `.dawg/sessions/*.json` logs idempotently (each record event once, by session and revision), and on every open it reconciles revisions the record has and the database lacks, so a crash between the two writes heals itself. Older sessions are never rewritten. A newer schema opens read-only; a corrupt file is moved aside to `history.db.corrupt-<time>` and rebuilt from the records.

Each row carries a sequence number, kind (`edit`, `undo`, `redo`, `comment`, `tool`, `turn`, `log`, `asset`, `focus`, `transport`), actor (`human`, `agent`, `subagent`, `external`, `system`), pane, the revision it produced, a one-line summary, the ops, and targets derived from the ops (track, instrument, effect, node, param, bars), so a query by track, instrument or parameter is an index lookup. Undo and redo read their events through the database (`src/history/undo-source.ts`), which keeps far more rewinds than the record's capped log, so `Ctrl-Z` walks back past the record's window; the undo engine itself is unchanged and falls back to the record without a database. Retention keeps every edit, undo, redo, comment, transport and asset row; it drops `log` rows after 14 days and unreferenced `focus` rows after 30, and caps stored rewinds at 5 000 per session (the row and its ops stay). Comments are also mirrored, one fsync'd JSON line each, to `.dawg/comments.jsonl`, and a rebuilt database re-imports them.

In the window, `/comment <text>` (alias `/c`) leaves a breadcrumb in the session: it records the pane, the screen it shows, the focused track and instrument, the open parameter, the playhead bar and beat, the loop range and the transport, so "I love this part" stays attached to the part. `@last`, `@agent`, `@mine`, `@rev <N>` or `@<eventId>` point the comment at an edit ("that agent edit was good": `/comment @agent nice #good`), and `#tags` are indexed. `/comments [@agent|@mine|#tag|<track>]` lists them, and `/history [<track>|<kind>|#tag|bars A-B]` opens every edit, comment and agent turn, newest last; Enter jumps to the row's moment (its playhead or loop, and its track). Both are also under `Project › session` in Ctrl-K, and the agent receives the same handle (`AgentHost.history`), so its tool calls, turns and comments land in the same database.

`dawg history` reads it from the shell, for a coding agent in another terminal as much as for you: one line per row, newest first, filtered with `--track`, `--instrument`, `--param`, `--bars A-B`, `--kind`, `--actor`, `--pane`, `--tag`, `--grep`, `--since 10m` and `--rev`; `--json` prints JSON Lines, `--follow` streams new rows until Ctrl-C (read-only, it never joins the session), `dawg history show rev:12` prints one event in full, `dawg history comment "<text>"` (or `@last <text>`) leaves a comment as an external actor (`DAWG_ACTOR` names you), and `dawg history stats` and `dawg history import` report and rebuild. It never creates `.dawg/` in a directory without one.

The `dawgd` protocol is newline-delimited JSON over a Unix socket in the session directory, or a hashed path under `$TMPDIR` when that path would exceed the platform socket-path limit. Every frame carries `v: 1`, frames are size-bounded, and every inbound frame is parsed from `unknown`. Clients send `hello`, `apply`, `transport`, `sync`, `focus`, `claim`, `meta`, and `ping`; the daemon replies with `welcome`, `result`, `snapshot`, `claimed`, `pong`, and typed `error` frames, and pushes `commit`, `transport`, `presence`, and `meta`.

The header (`dawg` · track · ▶/⏸ BPM · key · session · N windows, then model · rev · sync on the right; `test/tui.test.ts` freezes the order) sits above the highway. The highway sits above the activity strip and the prompt. Notes stream toward the hit line, and velocity sets glyph density (`░▒▓█`) and saturation. Beat and bar rules get stronger at each level. Sustains draw as beams with a decaying tail and a short ghost after release. Each hit runs approach glow → flash/burst at the line → fade. The hit line pulses on the beat, and a sweep marks the loop wrap. A track with no hits draws `<track> · empty · space play · ctrl-p play mode · ctrl-k menu` on a reserved row that never covers the ruler, led by `hit kick at 0` on a kit, `/lyrics la la · sing ooh` on a vocal track and, from 100 columns, a seeded `try style <id>` (the prompt placeholder suggests the same style); while playing it reads `space stop · type a request`, or `space stop · ctrl-p play mode` with no agent. The hit line stays. Drum tracks use one lane per voice with a legend; lane projection is pluggable (`LaneProjection` in `tui/highway.ts`). By default every unmuted track is overlaid through its own projection and accent, the focused track drawn on top at full strength and the others dimmed; `/view focus` restores the single-track view. Animation is derived from transport time, so frame rate never changes timing. Frames render into a retained cell buffer, only changed cells are written with minimal color codes, and output is capped at about 30 fps (bursts of forced frames coalesce), under 60 KB/s for a style-sized song at 80x24.

Keys: `Space` (empty prompt) toggles playback. `Enter` sends, or waits for the agent turn when the pill reads NEXT. `Shift-Enter`/`Ctrl-J` inserts a newline, `Alt-Enter` queues and `Ctrl-Q` toggles the NOW / NEXT pill. During an agent turn a typed command that parses locally (`tempo 120`, `play`, a note edit) runs at once beside the turn instead of steering it, so commands and keyboard play never wait on the model; prose and slash commands still steer. `Ctrl-Z`/`Ctrl-Y` undo and redo, and `Ctrl-O` or `/transcript` opens the transcript, which scrolls with ↑/↓, PgUp/PgDn and Home/End, and `/` cycles its filter (all, requests, ops, errors). `Esc` cancels an agent turn, closes the overlay or clears the draft. `Ctrl-L` redraws and `Ctrl-C` exits. Bracketed paste keeps multiline text intact.

Themes: `/theme default|high-contrast|mono`, `--theme`, `DAWG_THEME`. Color falls back through truecolor, 256-color, 16-color and monochrome. `NO_COLOR` and `TERM=dumb` are supported. `/motion off`, `--reduce-motion` and `DAWG_REDUCE_MOTION=1` switch to static states in the same positions. `--no-mouse` or `DAWG_MOUSE=0` keeps the terminal's own mouse selection (see **Mouse**).

Other code reports into the activity strip through `ActivityFeed` (`tui/activity.ts`): `pushCard(text, {tone, baseRevision, resultRevision, hint})`, `pushError(text)`, `setSpinner(label | undefined)`, `setQueueDepth(n)` and `applyAgentEvent(event)`, which accepts the agent's streaming `AgentEvent`s unchanged. Command handlers return a `Receipt` (`{ok: true | false | "warn", text}`), so a failure such as `main is not a drum track` is red because it says so, not because of its wording; `receiptTone` only classifies the legacy strings that remain. The `ctrl-z undo` hint rides only on receipts that changed the score, and only the first three in a session. `/help`, `/sessions` and `/tracks` open a scrollable text overlay (`TuiApp.openText`) and leave one summary card in the strip; `/help` is generated from `src/commands/help.ts`, which also feeds `dawg --help` and the usage hints that answer an unknown `/word` or a near-miss such as `pan 3` without a model call. A known verb followed by a sentence (three or more words, no numbers: `add a walking bass in A minor`) goes to the agent instead. An unknown `/word` names the nearest command (`unknown command /clik · did you mean /click? · /help`); a bare word one edit from a command whose remaining words parse as its arguments is suggested locally (`tempoo 90 · did you mean tempo 90?`); other bare words are requests for the agent.

`/help` opens a short start page (type a request or a style, Ctrl-P, Ctrl-K, `?`, undo) and the ten topics: **sound**, **voice**, **effects**, **rhythm**, **chords**, **mix**, **arrange**, **project**, **keys** and **agent**. The same ids open the same subject in all three doors: `/help voice` lists its commands, `/guide voice` explains it, `/menu voice` opens its Ctrl-K section. `/help all` is the full reference and `/help <command>` (`/help autotune`) shows one command's usage. Entries are written bare (`tempo 96`, `track drums`); only the free-text window verbs keep the slash (`/rename`, `/fork`, `/resume`, `/auth`), and `/play` (play mode, Ctrl-P) keeps it because bare `play` is the transport. Groups follow the Ctrl-K root order and stay within about fifteen rows, with sub-groups such as `sound · samples`; guitar amp presets are `rig <preset>` under effects, and the agent key is `model key` (`login` is an alias, not listed). Placeholders read `<drum>`, `<sample>`, `<register>` and `<lane>`. `/help keys` is drawn from the key table in `tui/grammar.ts`, so it always matches the keys. Old topic names still open their topic as aliases (music → arrange, session → project, window → keys, tuning → chords, performance → sound, and more in `src/lang/glossary.ts`). An unknown topic answers `no topic X · did you mean Y · /help`.

`/guide` (or F1) opens the user guides (`guides/*.md`, shipped in the package and rendered unchanged on dawg.sh/docs). The tree follows the topics: Getting started, then Using dawg (`keys`: the menu, faders, play mode), Sound, Voice, Effects, Rhythm, Chords (with Tuning), Mix (with Automation), Arrange (notes, tracks, tempo, styles, sections), Project (files, sessions) and Agent (show-me, providers, web search). Every guide uses one template, **Ask**, **Type it yourself**, **Menu**, **Keys** and **Next**, so the same answer is always in the same place. The pane: ↑↓ (j k) move, → l or Enter expand a section then open a guide, ← h collapse or go to the parent and back from a page, `/` filters by title and text, Esc clears the filter, then steps back, then closes. A guide splits into pages that fit the pane, whole sections at a time (`paginate` in `tui/guide.ts`); the title shows `· 1/2`, n (→, space, pgdn at the end) turns the page and then opens the next guide, p (pgup) goes back, and the last page's hint names the next guide. Each line kind has a mark from `guides/index.ts` (✦ Ask, › Type it yourself, ≡ Menu, ⌃ Keys, → Next, ── other headings, ✓ Tip, ! Careful; ASCII under TERM=dumb), colored with a theme role but never a knob color, so a page reads the same under NO_COLOR; typed commands lose their backticks and are drawn bold. `/help` headings use the same ── mark, and dawg.sh/docs mirrors the table (`site/app/doc-marks.ts`, checked by `site/tests/doc-marks.test.ts`). `/guide <topic>` opens one guide directly and accepts every topic id and alias (`/guide scale` opens Chords). `guides/guides.test.ts` keeps every page within 16 rows at 72 columns (the pane in an 80x24 terminal) and every guide within three pages, checks the template, every `/command` and every `Ctrl-K ›` path, and lints the words against the glossary.

The local command path understands requests such as:

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
clear pan automation
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
/tracks
/status
/export loop.track.json
/import loop.track.json
/model opus-5.5
/model fast
/help
/help all
```

`/track <name>` focuses a track in this window and creates it when it is new; when another live window has it focused the reply is `<name> is open in another window` and focus stays put. Music words are bare and app commands take a slash; `tracks`, `export`, `import` and `track` still work bare as aliases but are listed once.

`/track rm <name>` (aliases `remove` and `delete`) removes a track and its notes, and drops any `vocoder.src` or `autotune.from` on another track that named it; the last track stays (`/clear` empties it). `/track move <name> <position>` puts a track at a 1-based place in the list. Names match the id or the display name (`/track rm piano b`). Both undo with ^Z, and both sit in Ctrl-K › Arrange › tracks as **move** and **remove** on the focused track.

Drum tracks use the `kit` instrument (a track named `drums` gets it automatically). Notes on a kit track keep the score's MIDI pitch field, using General MIDI percussion numbers (kick 36, rim 37, snare 38, clap 39, closed hat 42, tom 45, open hat 46), so drum hits round-trip through `track.loop/v1` unchanged and the highway draws them in one lane per voice. Grammar, one command per prompt, beats in score beats:

```text
hit <voice> [at] <beat> [vel <0..1>]
pattern <voice> <beat> [<beat> ...] [vel <0..1>]        up to 64 beats
pattern <voice> every <step> [from <beat>] [vel <0..1>]  step >= 0.125, fills the loop, at most 256 hits
clear <voice>
filter <cutoff 20..20000> [<resonance 0..1>] | filter off
delay <beats 0.0625..4> [<feedback 0..0.9> [<mix 0..1>]] | delay off
reverb <mix 0..1> [<size 0..1>] | reverb off     size defaults to 0.5
automate filter at <beat> <cutoff> | clear filter automation
automate resonance at <beat> <0..1> | clear resonance automation
automate delay-feedback at <beat> <0..0.9> | clear delay-feedback automation
automate delay-mix at <beat> <0..1> | clear delay-mix automation
automate <lane> points <beat:value> [<beat:value> ...]   merge points into a lane
automate <lane> remove <beat>                            drop one point
track name <text>                                       rename the focused track
meter <beats per bar 1..16>
tempo 90 at bar 9 ramp | rit 4 bars to 80 | fermata at 31 2 | meter 7/8 at bar 5
track rate 3/2 | track phasing 4 | track phasing 3 hold 8 | track time off
solo | unsolo
undo | redo
```

Effects live on the track as optional `filter {cutoff, resonance}`, `delay {beats, feedback, mix}`, `reverb {mix, size}`, `filterAutomation`, `resonanceAutomation`, `delayFeedbackAutomation`, `delayMixAutomation`, and `solo` fields. Effect lanes modulate an existing effect: a resonance lane needs a filter and the delay lanes need a delay. Documents written before these fields existed still parse; out-of-range or non-finite values are rejected. Undo and redo append ordinary session events, so history is shared by every window and a new edit clears the redo stack.

Unrecognized prompts go to the agent whenever a provider is configured (`DAWG_AI=0` disables it); see **Providers and auth** below. `src/agent/models.ts` holds the model catalog: frontier (`opus-5.5`, `fable-5.1`, `sol-6.1`, `gemini-3.1-pro`), fast (`sonnet-5.5`, `haiku-5.5`, `haiku-4.5`, `gpt-5.4-mini`, `gemini-3.8-flash`, `glm-5.3-flash`) and open weights (`deepseek-v4-pro`, `kimi-k3`, `qwen3.8-27b`, `glm-5.3`, `llama-4-maverick`), each with its gateway and OpenRouter ID, checked against the live gateway and OpenRouter model lists and tagged for tool use. The `/model` picker joins the catalog with the live list and shows only tool-calling models; any other `vendor/model` ID the provider lists is accepted too, and on OpenRouter a routing variant suffix such as `:nitro`, `:free` or `:floor` is kept (`DAWG_MODEL=google/gemini-2.5-flash:nitro`). Anthropic models get a prompt-cache breakpoint on the static system prompt, which stays byte-identical across steps. `DAWG_MODEL` picks the model for one run, and an unknown value fails at startup with the valid list. The default is `opus-5.5`. `/model fast` (also `dawg model fast`, `DAWG_MODEL=fast`, and `gatewayModel`/`openrouterModel: "fast"` resolved at save) picks `haiku-5.5`, the fastest model in `bench/agent-eval` that passes the non-style tasks about as well as the default (`FAST_MODEL_ALIAS` in `src/agent/models.ts`; numbers in `docs/model-eval.md`). A catalog row may name a `fallback` on another vendor: `haiku-5.5` falls back to `glm-5.3-flash` for one try when every attempt failed before the first byte (repeated 5xx, header timeout, or a stream that sends nothing for `GATEWAY_FIRST_BYTE_TIMEOUT_MS`, 20 s; any byte, a keep-alive comment included, counts). A reply that starts with `Done: <summary>` beside its tool calls ends the turn once they apply, saving the summary round trip, unless the step wrote notes, rhythms, chords or structure (`CONTENT_TOOLS`), which always get a review step. `DAWG_OPUS_MODEL` / `DAWG_SOL_MODEL` still remap those two aliases.

### Agent turns

A turn calls `POST /v1/chat/completions` with `stream: true` and one JSON-schema tool for each operation family. The OpenAI-compatible SSE stream is parsed locally with `fetch`, so the agent adds no runtime dependency. Each request sends a compact, deterministic **composition brief** instead of raw logs. It contains revision, tempo, meter, bars, key, tracks with instrument, mix, note count and pitch range, the focused track's notes, recent accepted operations and the instrument list. It is capped at 12 KiB and never includes environment values.

When a tool call finishes streaming, it passes three checks: the tool's own argument checks, the planner's bounded operation validator, and a dry run of the score reducer. Only then is it committed through the session as a separate revision pinned to the revision it was planned against. If the call fails a check, or another window committed first (stale revision), dawg rejects it without changing the score. The model receives the diagnostic as the tool result and can correct itself. A turn is bounded to 8 steps, 32 tool calls, 1 MiB of streamed response and a 90 s timeout.

`runAgentTurn` (`src/agent/agent.ts`) emits structured progress events for the TUI: `step`, `text-delta`, `tool-start`, `tool-applied` (with `summary`, `baseRevision`, `resultRevision` and `trackId`), `tool-rejected` (with `diagnostic`), and a final `done` or `error` (`aborted`, `timeout`, `budget`, `provider`). To add an operation family, append a tool to `AGENT_TOOLS` in `src/agent/tools.ts`. The schema, dispatch and validation all come from that one entry.

Times in tools and the brief are beats from 0; the system prompt maps musical counts (beats 2 and 4 of a 4/4 bar are beats 1 and 3) so models place backbeats correctly. `update_notes` takes either an absolute `pitch` or a relative `transpose` in semitones, and its summary lists each moved note as `id before→after`. Tool schemas are sent with unions rewritten as `anyOf` branches (`src/agent/portable-schema.ts`) so Gemini accepts them. `bench/agent-eval/` measures how well a model drives these tools; see `docs/model-eval.md`.

### Show-me (command mode)

In a terminal, with `/showme on` (the default) or `quiet` and an API provider (the gateway or a direct key), a turn runs in **command mode** (`src/agent/command-agent.ts`). The model writes dawg prompt commands, one per line, as a person types them. The prompt bar shows the line being written as ghost text at the model's own speed. Each complete line that parses (`isAgentCommand`, the same `commandParses` the prompt's typo check uses) runs through the TUI's `submit()`, the path Enter runs: same parser, commit, undo step and project sync. The score changes during the turn. Lines that are not commands are prose for the transcript. Window-only commands (`/model`, `model key`, `/showme`, `/theme`, `/quit`) never run. A failed line goes back to the model with its error for a correction round, up to 4 steps. A small JSON tool set stays for what commands cannot express: workspace files, web, media, `explain`, `preview_sound` and `measure_mix`.

A caption under the prompt names the gesture (`src/agent/show-me.ts`). For a parameter value, the fader glides about 150 ms in 30 ms steps through staged audition while the loop plays, then the command commits. For a note or drum hit, the caption names the play-mode key and the octave keys, and the note sounds in time behind the stream (`NoteScheduler`): grid-spaced when the model is faster than the tempo, step entry when slower. Media tools name the `dawg media` verb. At the end of the turn the caption gives a do-it-yourself hint with the Ctrl-K path. Nothing is replayed after the turn, and typing, play mode and the next turn are never blocked. `/showme off`, non-TTY runs and subscription providers use the JSON tool loop above. Command mode sends about a ninth of the input tokens and finishes in about half the time; see `docs/show-me.md` for the measurements and the exceptions.

### Workspace and web tools

The project directory (the directory `dawg` runs in) is the agent's workspace. Six more entries in `AGENT_TOOLS` give the model bounded file and web access on both the gateway and xcb paths; `src/agent/workspace.ts` holds the path policy and `src/web/` the network side.

- `list_files`, `read_file`: anywhere in the project except `.dawg/`, which dawg owns. Listings stop at 500 entries, reads at 256 KiB per call (1-based `offset` and `limit` page through larger files), and binary files (WAV, AIFF, FLAC, MP3, MIDI, images, archives) report type and size instead of bytes.
- `write_file`, `edit_file`: only `song.ts` and the focused track's `tracks/<slug>/` directory (`core/slug.ts` derives the slug from the track name). Writes are atomic (temp file and rename), capped at 1 MiB, and create parent directories. `edit_file` replaces exactly one occurrence of `old`; zero or several matches return a count and nothing changes. `tracks/<slug>/notes.md` is the model's scratchpad and is never parsed. After a write, the optional host hook `onWorkspaceWrite(path)` can append text to the tool result (the project lane uses it to report how `track.ts` applied).
- Every path is resolved lexically and then through `realpath`; `..`, absolute paths outside the root, symlinks that leave the project and anything under `.dawg/` are rejected with a diagnostic naming the writable roots. The brief gains a `project` entry with a tree of at most 30 lines and the first 1 KiB of the focused `notes.md`; both are shed before track summaries when the 12 KiB budget is tight.
- `web_search` returns up to 8 `{title, url, snippet}` results. Providers, first match wins: `BRAVE_SEARCH_API_KEY` (explicit override); an AI Gateway key, which makes one non-streaming `anthropic/claude-haiku-4.5` call with the gateway's server-side search tool (`DAWG_WEB_SEARCH=exa|perplexity|parallel|browserbase`, default `exa`; the gateway bills the search, about $0.007 for Exa; its reported cost already includes that fee, so dawg records it as-is and uses the fee as an estimate only when no cost is reported; a live Exa search with three results cost $0.013); an OpenRouter key (`OPENROUTER_API_KEY`), which uses the `web` plugin and its `url_citation` annotations; else DuckDuckGo's HTML endpoint. `DAWG_WEB_SEARCH` can also pin a backend (`duckduckgo`, `openrouter`, `gateway`, `brave`) when its credentials exist. A failing paid provider falls through to DuckDuckGo and the result says so. The activity card names the answering provider (`searched via gateway · exa`), and `WebHost.onSpend` reports each billed search for the spend ledger.
- `fetch_url` fetches one public http(s) URL locally: hostnames are resolved first and loopback, private, link-local, CGNAT and multicast addresses (IPv4, IPv6 and mapped) are refused, the connection is pinned to the address that was checked (the Host header and TLS server name keep the original name, so DNS rebinding cannot swap in a private address), IPv4-compatible, 6to4, site-local and discard-prefix IPv6 forms are classified by what they embed, redirects (at most 3) are re-checked per hop, bodies stop at 2 MiB and the text handed to the model at 32 KiB. HTML is reduced to headings, lists, links and paragraphs; scripts, styles and navigation are dropped. Fetched text is untrusted and the system prompt says so.

All limits live in `WORKSPACE_LIMITS`, `SEARCH_LIMITS` and `FETCH_LIMITS`. Search and fetch take an injectable `fetch` (and `lookup`), so tests run on fixtures in `src/web/fixtures/` without network. The gateway search fixture is derived from the documented response shape; capture a live response once to confirm it.

### Media tools

Seven more `AGENT_TOOLS` entries (`src/media/`) turn reference audio into material for a track. They work on files under the focused track's `tracks/<slug>/downloads/` (the same slug and write scope as `write_file`), return project-relative output paths so the model can chain them, and never install anything: a missing binary is reported with its install command. `dawg media <verb>` runs the same code from the shell, and `dawg media doctor` lists the backend, each binary, how it runs and how to install it, plus one line for the project's pitch analysis cache (`.dawg/analysis`: files, size against its 64 MB cap, least recently used pruned, tracker version).

- `download_audio {url, name?}`: YouTube only (`youtube.com`, `youtu.be`, `music.youtube.com`). Writes `<name>.wav` plus a `<name>.json` sidecar (title, duration, source URL, backend, sha256, time). The same source URL is reused instead of downloaded again. yt-dlp runs with `--no-playlist`, `--max-filesize 500m` and a 15 min budget.
- `split_stems {file}`: six stems (vocals, drums, bass, guitar, piano, other) into `<base>.stems/`, cached once present. 20 min budget.
- `analyze_audio {file}`: ffprobe metadata, then tempo, key, a beat grid and 240 waveform peaks computed in TypeScript, written to `<base>.analysis.json`; the model sees 48 peaks.
- `transcribe_notes {file, kind?, from?, to?}`: drums use a vendored onset classifier mapped to dawg kit voices (kick, snare, clap, tom, hat, openhat, rim); pitched stems run `basic-pitch`. Notes are quantized onto the analysis beat grid (run first when missing) and returned as a `note()`/`hit()` snippet plus `<base>.<kind>.notes.json`, at most 2048 notes.
- `import_sample {file, name, begin?, end?, root?}`: ffmpeg converts the file (or a trimmed window) to 48 kHz stereo PCM16 at `tracks/<slug>/samples/<name>.wav` and returns its sha256, duration and a `sampler({ name: "samples/<name>.wav" })` snippet (`{src, root, begin, end}` when given; `begin`/`end` are fractions of the file, `root` defaults to C4; a root adds `{ mode: "keyed" }`).
- `make_wavetable {file, name, frames?, start?, end?, method?, smooth?, normalize?}`: reads the file (WAV directly, anything else through ffmpeg as 48 kHz mono, at most 10 minutes) and writes a float32 wavetable of `frames` (default 64, at most 256) 2048-sample frames with a `clm ` chunk to `tracks/<slug>/wavetables/<name>.wav`. See [Wavetables from audio](#wavetables-from-audio).
- `transcribe_lyrics {file, lang?}`: whisper-cli on a 16 kHz mono copy, writing `<base>.lyrics.json` (segments with seconds) and `.lyrics.txt`. The `ggml-base.en.bin` model (about 141 MiB) is announced and then downloaded once into `~/.cache/dawg/whisper/`.

**Backends.** When StemDeck answers `GET /api/health` at `DAWG_STEMDECK_URL` (default `http://127.0.0.1:8000`, no credentials or query allowed in the URL), downloads and stems go through its job API and the job id is kept in the sidecar so `analyze_audio` reuses StemDeck's beat grid. Otherwise dawg runs the binaries directly: `yt-dlp`, `ffmpeg`, `ffprobe`, `whisper-cli` (`brew install yt-dlp ffmpeg whisper-cpp`), and `demucs`/`basic-pitch` through `uv tool run` when `uv tool list` shows them (`uv tool install demucs`, `uv tool install basic-pitch`). demucs downloads its model on first run.

**Bounds.** Every subprocess goes through the injectable `CommandRunner` with a per-tool timeout, 1 MiB of captured output, and SIGTERM then SIGKILL on Esc or abort. Helper output becomes throttled one-line progress (`demucs 42%`, `stemdeck separating 42%`) on the activity card through the `tool-progress` event. The turn deadline is paused while a media helper runs, so a 10 minute separation does not time out the turn; the other turn budgets still apply. WAVs read into memory are capped at 256 MiB. Input paths must stay inside the project. URLs are never logged with credentials. The drum classifier, beat-grid fitting, WAV codec and basic-pitch CSV parser are vendored from soundfish in `src/media/vendor/` with a header crediting it; tests stub every binary and StemDeck with `scriptedRunner`, fetch fixtures and a drum excerpt in `src/media/fixtures/`. `DAWG_LIVE_MEDIA=1 bun test src/media` adds one live ffprobe smoke test.

### Subagents

`dispatch {tasks: [{id, prompt, tracks, bars?, files?, global?}], model?}` (`src/agent/subagents.ts`, `src/agent/dispatch-tool.ts`) runs up to four child agent turns in parallel on the parent's provider: API providers default to the fast model (`/model fast`), xcb children use the account's model and run two at a time, since each is an `xcb generate` process on the subscription.

- **Scopes.** Each task names the tracks it may change (by id or name; `[]` means new tracks only), optionally a bar range for its note edits, extra writable project globs and, for at most one task, `global` (tempo, meter, form, master, tuning). Before anything runs, the same track in two tasks, two `global` tasks or a glob under `.dawg/` is a tool error naming both tasks. A child's file writes are limited to its tracks' `tracks/<slug>/**` plus its globs.
- **Commits.** Every child edit goes through one commit queue. When a sibling landed first, the edit is replayed onto the newer score with the same rebase dawgd uses for panes (`src/session/rebase.ts`), so edits to different tracks never conflict. An edit whose notes or track settings changed underneath it is not forced: the task reports `conflict` with the reason. Each edit is its own revision with the summary prefixed `[<task id>]` and `AgentCommit.subagent`/`parentCallId` set, so undo takes back one child edit at a time.
- **Bounds.** A child has 6 steps and 16 tool calls, never gets `dispatch`, `transport` or trusted `exec`, and shares the parent's abort signal: Esc cancels every child. The dispatch pauses the parent's turn deadline and has its own 5 minute wall clock, after which unfinished children report `canceled`. Children's usage feeds the parent's spend meter.
- **Result.** One line per task, `<id>: done|conflict|error|canceled|budget revs 41,42 · <summary> · <spend>`, then `total spend: …`. Progress lines (`sub:<id> ▸ add_notes`) show in the agent pane while children run.

### Audio chop toolkit

One engine, three doors (`src/audio/chop/`): the agent's `audio` tool (`src/agent/audio-tool.ts`), typed `chop <op> <file> [values] [--flags]` and `dawg media chop <op> …` all call `runChop(op, args, ctx)`, so the result of an agent edit can be repeated by hand. Ops: `info`, `peaks`, `onsets`, `beats`, `segments` (`--method silence|onset|section|beats|grid`), `find` (places that sound like a reference range), `cut`, `slice`, `trim`, `pad`/`shift`, `loop` (crossfaded seam), `concat`, `mix`, `stretch` (`--bpm 90:120`), `pitch` (`--preserve formant`), `fade` (`--curve linear|exp|log|scurve`), `normalize`, `gain`, `reverse`, `filter`, `convert`, `resample`, `split` and `audition` (plays through the agent preview voice, at most 30 s). Ctrl-K › Project › media › chop (one entry row per op); `chop` alone opens the card.

- **Times** read seconds (`1.5`, `1.5s`), `350ms`, `m:ss`, `bar:9.1` (song tempo) or a negative offset from the end. Cuts snap to the nearest zero crossing within 5 ms (`--snap onset|beat|none`).
- **Files.** Inputs resolve project-relative, then in the focused track's `downloads/` and `samples/`; they must realpath inside the project. Outputs go to `tracks/<slug>/samples/<stem>-<op>.wav` (24-bit WAV) with a `.chop.json` sidecar (op, args, input sha256, backend); `.dawg/**`, `.git/**` and symlinked directories that leave the project are refused. Overwriting keeps the old file under `.dawg/trash/`. Originals are never changed.
- **Backends.** Everything runs in TypeScript on the decoded PCM; `ffmpeg` decodes non-WAV input and encodes mp3/flac, and `rubberband` (when installed) gives higher quality `stretch` and `pitch`, otherwise `dsp/shift.ts`. A missing helper is reported with its install command; nothing is installed.
- **Analysis** walks long files in 240 s windows, so a 10 minute file is analyzed to the end; results return at most 64 points to the model (`dawg media chop … --json` gives all of them).
- **Slice to a sampler.** `chop slice <file> --track <id> [--pattern]` loads each slice as a voice on a sampler track (refused past the voice cap) and, with `--pattern`, writes one note per slice in order; one score commit, so Ctrl-Z undoes it.
- **History.** Each written file becomes an `asset` row (sub `audio.<op>`, payload op, args, sha256 of inputs and output; targets sample, file and track) through the session's history handle (`historySink()`, or `MediaServices.chopHistory` when a host passes one). With no session open nothing is recorded.

### exec

The agent's `exec` tool runs one audio CLI with an argv array: no shell, cwd = project (`src/agent/exec-tool.ts`, runner `src/media/exec.ts`, policy `src/media/exec-policy.ts`). Allowed: `ffmpeg`, `ffprobe`, `sox`, `rubberband`, `yt-dlp`, `demucs`, `basic-pitch`, `aubio`, `aubioonset`, `aubiotrack`, `aubionotes`, `whisper-cli`. A missing tool returns its install command; dawg never installs anything.

**Threat model.** The agent can already run code as the user through project `.ts` files, so exec confinement stops accidents and injected content (a page or video title telling the agent to run something), not a malicious agent. Every flag of every tool is listed with its arity and the role of its value; anything else is refused by name. Inputs resolve (realpath) inside the project or the human's `readRoots`; outputs stay inside the write scope (never `.dawg/`, `.git/`, `node_modules/`), symlinked folders cannot leave it, and protocol inputs (`pipe:`, `file:`, `concat:`, `http:`) are refused. Only `yt-dlp` takes a URL (https, no credentials, no local or IP hosts); dawg prepends `--ignore-config --no-plugin-dirs --no-exec`. ffmpeg always gets `-nostdin -hide_banner` and `-protocol_whitelist file` before each input (a user value is dropped); filters that load code or read files (`ladspa`, `movie`, `sendcmd`, …) are refused. The child gets only `PATH`, `LANG` and `HOME=TMPDIR=.dawg/tmp/exec/<id>`, so no user config or secrets reach it.

**Trusted shell.** `.dawg/agent.json` `{ "shell": true }`, edited by the human only (the agent's write scope refuses `.dawg/`), lets exec run any CLI on PATH with the same limits and logging. `readRoots` there adds read-only input folders.

**Limits.** Timeout 120 s by default, 600 s at most, counted from start; on timeout or Esc the whole process group gets SIGTERM, then SIGKILL after 2 s. Two runs at a time per dawg process, FIFO (`queuedMs` is reported). The turn deadline pauses while exec runs. stdout and stderr go to `.dawg/logs/exec/<id>.log` (16 MiB cap); the result carries 2 KiB tails, the log id, and the files that appeared in the output folders (at most 50). `exec { log, offset }` pages the log 4 KiB at a time. Each run is a `tool` history row (argv, exit, ms, log id) plus an `asset` row per new file.

### Providers and auth

`src/agent/provider.ts` picks a backend per turn: `DAWG_PROVIDER`, then the choice saved in `~/.config/dawg/config.json`, then `auto` (AI Gateway, then OpenRouter, then a ready Codex or Claude subscription, else offline with a `dawg model key` hint). The config holds `provider`, the model and, for subscriptions, the xcb account. It is written atomically with 0600 permissions and never holds a key. A saved choice that stops working (revoked key, account gone) comes back as `offline` with `invalidSaved` and the reason; startup and `dawg model key` (alias `dawg login`) say so once and open the picker rather than switching providers. Only `dawg logout`, `/logout`, `dawg model key <provider>` and `/model` change it.

Keys (`ai-gateway`, `openrouter`) resolve from the environment (`AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`), then the macOS Keychain (service `dawg`), then `~/.config/dawg/credentials.json` (0600 under a 0700 directory, written atomically through a temp file and rename). Storing uses `security -i` with the command on stdin, so a key never appears on an argv. Keys must match `[A-Za-z0-9._-]{16,256}` and are shown only masked (`vck_…abcd`). Nothing auth-related goes to `.dawg/`.

`src/auth/discover.ts` probes all four options in parallel, each with a 4 s cap and no network beyond the local CLIs: environment and stored keys, `vercel whoami --format json --non-interactive`, `VERCEL_OIDC_TOKEN` (a usable gateway credential in a linked project), and `xcb --version` plus `xcb --json generate --capabilities` split by provider family. xcb accounts are usable iff `available === true`; `admission` (`pending | admitted | qualified | null`) is informational, and pending accounts are usable with a slower first call. Accounts reporting `models_unavailable` are refreshed once per process (`xcb accounts refresh <id>`, in parallel, 10 s each) and re-read. Reasons map to one-line hints (`application_disabled` → `xcb application enable`, `admission_failed` → retry after 15 minutes); xcb older than 0.20.0 is reported with an upgrade hint.

`src/auth/login.ts` turns the probes into one picker (`src/auth/picker.ts`, a pure model the shell and TUI both render: arrows, numbers, Enter, type-to-filter). Per option:

- **Gateway**: with the Vercel CLI, `vercel login` gets the terminal when needed, then `vercel ai-gateway api-keys create --name dawg-<host> --non-interactive [--limit <dollars>]` prints only the key on stdout. Without it, dawg opens the gateway keys page and reads a pasted key with echo off. Validation is `GET /v1/credits`.
- **OpenRouter** (`src/auth/openrouter.ts`): OAuth PKCE. A server on `127.0.0.1:<ephemeral>` waits for `/callback` and checks a random `state`. The browser opens `https://openrouter.ai/auth?callback_url=…&code_challenge=<S256>&code_challenge_method=S256`, and the code goes to `POST /api/v1/auth/keys` with the verifier. The URL is printed for headless use, the server closes after 5 minutes, and validation is `GET /api/v1/key`.
- **Codex / Claude**: lists usable xcb accounts of that family and the models xcb reports for them (only models with an admission state). With none ready, dawg runs `xcb setup <family>` with the terminal; otherwise it prints the command.

Every subprocess goes through the injectable `CommandRunner` in `src/auth/runner.ts`, which bounds output, writes stdin and on abort sends SIGTERM (SIGKILL after 15 s) and waits for exit. Tests script `vercel`, `security` and `xcb` through it and run OpenRouter against a local fake server.

`model key` (alias `/login`) in the TUI calls `handoff()`: it stops the frame timer, detaches stdin, leaves raw mode, bracketed paste and the alternate screen, runs the same flow on the real terminal, then re-enters, clears and forces a full redraw.

The gateway and OpenRouter share `src/agent/gateway.ts`, an OpenAI-compatible streaming client with tool calls that requests `stream_options.include_usage`. `src/agent/usage.ts` prices each usage chunk, using the provider's own `cost` when present and otherwise tokens × the models.dev price. It keeps the session total and a daily ledger in `~/.config/dawg/usage.json` (31 days, lock file plus atomic rename) that windows share, and draws the spend line under the prompt (`$0.12 session · $0.48 today · opus-5.5 · gateway`; `subscription` for xcb; `commands only` offline, with no model key nag; it narrows by dropping today, then session). Billed web searches add to the same meter. Prices come from `https://models.dev/api.json`, cached in `~/.config/dawg/cache/` for 24 h, fetched with a timeout and size cap, with a stale cache preferred to nothing offline; on OpenRouter its own `/models` prices win. The picker's `~$0.005/prompt` is `TYPICAL_PROMPT` (≈ 53,000 input + 600 output tokens, measured from the system prompt, tool schemas and a fixture brief over about 2 requests at about 3 bytes per token, as the agent eval in `bench/agent-eval` observed) × price.

The xcb provider (`src/agent/xcb.ts`, `src/agent/xcb-agent.ts`) calls `xcb --json generate` with one `{version:1, account, model, prompt, timeoutMs, maxOutputBytes}` request on stdin. xcb exposes zero tools and does not stream, so the prompt carries the system rules, the composition brief and the tool catalog as JSON schemas, and asks for exactly one `{ops:[{tool,args}], say?, done}` object. The reply is untrusted. dawg takes the first balanced JSON object in at most 64 KiB, allows at most 16 ops and caps `say` at 400 characters. Each op then goes through `executeCall`, the same argument checks, operation validator, reducer dry run and per-op revision commit used by the gateway loop, and emits the same `tool-applied`/`tool-rejected`/`text-delta` events. If a reply cannot be parsed, an op is rejected or `done` is false, dawg makes another call with the per-op results, up to 3 calls and within the normal turn budgets. Esc aborts the turn, which terminates the xcb child and keeps every accepted revision. The child timeout is `timeoutMs + 75 s`, because the first `generate` per binding (and after an xcb or provider update) admits the account and can take up to a minute longer. A `busy` result, when two first calls hit one account, is retried with backoff. Accounts come from `xcb --json generate --capabilities`, parsed field by field from `unknown`. dawg never runs the xcb installer.

`generateText(prompt, {maxTokens, signal?, timeoutMs?, selection?})` from `src/agent/provider.ts` is a tool-free one-shot completion for helpers like session naming. On the gateway and OpenRouter it uses `anthropic/claude-haiku-4.5` with `max_tokens`. On xcb it uses the selected account with `maxOutputBytes ≈ 8 × maxTokens`. It returns at most 512 trimmed characters of untrusted text and throws when offline, so callers should fall back to a local default.

Playback renders the score to interleaved stereo 16-bit PCM with deterministic sine, piano, pluck, bass, saw, square, and triangle voices and a synthesized kit whose noise comes from a PRNG seeded by each note, so every render is byte-identical. Track volume and pan automation, the low-pass filter (with cutoff and resonance lanes), the delay send (with feedback and mix lanes), and the reverb send are applied per track; mute always silences a track and any solo silences unsoloed tracks. Pan uses an equal-power law (-1 left, 1 right). The delay is a stereo ping-pong (first repeat on the panned side, later repeats alternate) and the reverb is a Freeverb-style network of eight parallel damped combs and four series allpasses per channel, with the right channel's delay lines offset for width; both use only integer delay lengths and fixed coefficients, so renders stay deterministic.

Audio engine. With `dawgd` running only the daemon plays audio; on the file-lock fallback a per-session audio lock keeps multiple TUI windows from starting duplicate voices. The engine renders one loop with every tail (release, delay, reverb) folded back onto the loop start, so the buffer repeats seamlessly, and streams it as raw s16le stereo into one long-lived player process, paced by the wall clock with about 200 ms queued. An edit renders the new loop and swaps it in at the current loop position without restarting the player; a tempo change keeps the musical beat; a seek or a drift above 30 ms re-anchors the write position to the shared transport clock, offset by the queued audio, so the transport matches what you hear. Backends, in order: the native sink (`native/sink`, a Rust/cpal ring drained by the device's audio callback, loaded through bun:ffi after its sha256 matches the shipped manifest; it receives the same s16le stream, converted exactly to f32, paced by a 5 ms pump with a 15 ms play lead), then `ffplay -f s16le -i -`, then SoX `play -t raw -`, then (macOS) `afplay` re-rendering a loop-folded WAV rotated to the current beat on each edit, the only backend that restarts. `DAWG_AUDIO_BACKEND=native|ffplay|sox|afplay|none` forces one, `DAWG_AUDIO_PLAYER="cmd {rate} {channels}"` streams into any stdin player, and `DAWG_AUDIO=0` disables sound. `dawg auth status` and `/auth` print the detected backend; `dawg doctor` also prints why the native sink is or is not in use, the play lead, the audio devices, and the output and input saved from the audio menu (`chosen: output USB Audio Interface · input default (Built-in Microphone)`, `(missing, using default)` when a saved device is gone, and the file it lives in; `chosen` in `--json`). The renderer is deterministic and independently testable; a native or sample-backed instrument backend can replace it behind the same player port.
Audio devices (`src/audio/devices.ts`, `src/audio/audio-command.ts`). One output and one input, each a device name or the system default; there is no routing matrix. Ctrl-K › Project › audio shows two rows (output and input), each opening the device list (arrows, Enter picks, Esc back); `audio` shows the choice, `audio out <name|default>` and `audio in <name|default>` set it (exact, case-insensitive or a unique prefix of a listed name), and `audio test` plays a short tone on the output, then meters one second of the input (peak dBFS). Picking an output plays a soft blip on it through its own short stream. The choice is saved per machine in `<config>/audio.json` (`~/.config/dawg/audio.json`, or under `DAWG_CONFIG_DIR`), never in the project; `DAWG_AUDIO_DEVICE` still overrides the output. Every engine (the window's, the file-lock fallback's, dawgd's) follows the file: it reads it before each player starts and checks it about once a second while playing, so a pick moves playback at the frame being heard. When the chosen output is gone (unplugged mid-song, or missing at start) the engine opens the system default and says so once (`audio output "<name>" is unavailable · playing on the system default`); the saved choice is kept for the next start. Choosing needs the native sink, which lists and opens devices by name. On SoX, `audio out <name>` sets `AUDIODEV` for `play` but cannot list devices or choose an input; ffplay and afplay always play on the system default, and `audio` says why (with the native sink's unavailable reason). The input is chosen and metered only; recording takes is a later lane.

Set `DAWG_AUDIO=0` for headless sessions.

Use `DAWG_DEMO=1 bun run src/main.ts` for a deterministic non-interactive frame stream while developing the renderer.

## Project files and SDK

A directory with a `dawg.json` is a project: its score lives in typechecked TypeScript files that you, an editor or the agent can edit, and every window keeps those files and the session in step. `dawg init [dir]` creates one and is idempotent; it never touches anything outside the target.

```text
dawg.json                  {"format":"dawg.project/v1","sdk":1}
tsconfig.json              extends .dawg/sdk/tsconfig.json; paths {"dawg": ["./.dawg/sdk/v1.ts"]}
song.ts                    tempo, meter, bars, key, track order; imports tracks/*/track.ts
tracks/<slug>/track.ts     one track: instrument or sampler, mix, effects, automation, notes
tracks/<slug>/samples/     audio a sampler references by relative path
.dawg/sdk/v1.ts            vendored SDK (committed), refreshed by init when a newer 1.x ships
.dawg/sync.json            hashes of the files dawg last wrote (runtime, gitignored)
.dawg/tsbuild/             incremental typecheck state (runtime, gitignored)
```

`init` appends `.dawg/*` and `!.dawg/sdk/` to `.gitignore`, so sessions and caches stay local while the vendored SDK is committed with the project. The slug is `trackSlug(name)` from `core/slug.ts`; duplicates get `-2`, `-3`. The full design is in [docs/project-format.md](./docs/project-format.md).

SDK. `core/sdk/v1.ts` is one dependency-free file with JSDoc on every export, because its signatures are what an agent reads. Authors write beats; `song()` returns a `track.loop/v1` document in integer ticks (`round(beat × ticksPerBeat)`). Builders: `note(pitch, start, length = 1, velocity = 0.8)`, `seq("E2 . G2", {from, step, len, vel})` (`.`, `-`, `_` rest), `hit(voice, start, velocity, length = 0.25)` and `hits(voice, beats)` for `kit` voices (`kick`, `snare`, `hat`, …) and sampler voices, `every(step, {from, until})`, `sampler(voices, {mode})`, `slices(src, count)`, `chord(symbol, start, length, opts)`, `progression(chords, opts)` (see [Chords](#chords)), `track({...})` and `song({...})`. Note ids are content hashes, so the files never carry them and dawg keeps the session's ids for notes that did not change.

Evaluation. `evaluateProject(dir)` (`core/sdk/eval.ts`) imports `song.ts` in a fresh `bun --no-addons --no-install` child with cwd at the project, an environment of only `PATH`, `HOME` and `TMPDIR`, a 10 s timeout and 32 MiB of output (above the largest score `SCORE_LIMITS` allows; an overflow is reported as such, not as a timeout), then decodes the document through the ordinary score validator. Failures are diagnostics `file:line:col message`, never throws. Evaluation is an isolated process, not a sandbox: project code runs with your user's file and network access, like any build script, and the sync evaluates it on startup and on every change, so open only projects you trust.

Typecheck. `typecheckProject(dir)` (`src/project/typecheck.ts`) runs the native TypeScript 7 compiler from the `typescript` dependency with `--incremental` state in `.dawg/tsbuild`. A cold check of a three-track project takes about 65 ms and a warm one about 26 ms on an M-series Mac. The header shows `types ✓` or `types ✗ N`.

Two-way sync (`src/project/sync.ts`) runs in every window of a project:

- Files to score: `fs.watch` on the project and `tracks/` (plus a 1.5 s poll) with a 150 ms debounce. A changed source is evaluated, its notes adopt the session's ids, and `diffScores` (`core/diff.ts`) turns the difference into the smallest list of score operations, committed as one `files.apply` revision through the session port, so dawgd rebases it like an agent intent and undo drops it as one step. The window shows `applied from files · 2 notes, 1 track`. A file that fails to evaluate leaves the score untouched and shows `files rejected · <diagnostic>` once per distinct error.
- Score to files: after any accepted revision (TUI, agent, another window) the window reprints only the files whose own track (or song) slice changed since their last evaluation, so hand formatting and comments in untouched files survive. A file whose bytes no longer hash to what dawg last wrote (edited in an editor, or failing to evaluate) is never overwritten; the window shows `<file> edited · not overwritten` and the next look applies it. `.dawg/sync.json` is read, written and merged under `.dawg/sync.lock`, and every write is fsynced with its directory. A track file left behind by a rename or removal is deleted only if its hash still matches what dawg wrote; a hand-edited one is kept.
- Startup: the files belong to one session at a time (recorded in `.dawg/sync.json`). A window on another session while the owner is still open stays detached and shows `files belong to session <id>`. Otherwise, if any source differs from the hash in `.dawg/sync.json` (edited while dawg was closed, or never written by dawg), the files win; else the session wins and the files are reprinted.
- Echo: a file whose hash is one dawg wrote (in any window) or one this window already evaluated is skipped, so a window never reverts its own newer edit by applying another window's reprint. Hashes cover every project source (`.ts`/`.js`/`.json` helper modules, `.scl`/`.kbm` tunings), so editing an imported helper syncs too; a look with nothing new reports `files unchanged`.
- The agent's `write_file`/`edit_file` on a `.ts` source applies before the tool result returns; the result carries the outcome line, `types ✓` or `types ✗ N` and up to eight diagnostics.

The printer (`core/sdk/print.ts`) is deterministic and Prettier-stable (`prettier --check` passes on its output), prints only non-default fields, and satisfies `print(evaluate(print(score))) = print(score)`.

`dawg check` typechecks and evaluates the project, prints diagnostics to stderr and `ok · 3 tracks, 12 notes · types 26 ms · eval 21 ms` on success, and exits 1 on any problem or outside a project.

Score format. The score stays `track.loop/v1` with `version: 1`: every addition is an optional field, so older documents still parse and older dawg versions reject only documents that use the new fields. Tracks may carry `sampler: {mode: "oneshot" | "keyed", voices: {name: {src, sha256?, url?, license?, root?, begin?, end?, gain?, speed?, loop?, choke?}}}` with bounds in `SCORE_LIMITS` (64 voices, 256-character relative `src`, gain ≤ 2, speed ≤ 8). One-shot voices map to pitches from 36 in voice-name order. Sampler tracks play their samples; see [Samples](#samples). `diffScores` uses four operations added alongside: `removeTrack`, `moveTrack`, `setKey` and `setMeter`, which dawgd rebases and the planner accepts.

## Effects

Every track has one fixed effects chain (`FX_CHAIN` in `core/fx.ts`, DSP in `src/audio/effects/`):

```text
filter → djf → autofilter → formant → vowel → crush → distort → stomp → head → cab → tremolo → compressor → pan → phaser → chorus → leslie → postgain → delay → reverb → [mix: orbit → duck]
```

Stages before `pan` run on the track's mono voice sum; pan spreads it to stereo with the equal-power law; the rest run on the stereo pair. An effect that is off costs nothing. The core set — **filter, auto filter, distortion, tremolo, compressor, chorus, delay, reverb** — leads the Effects menu and the agent brief; dj filter, vowel, bitcrush, phaser, leslie, post gain, orbit and duck are under **more effects** for Strudel parity.

`orbit` and `duck` act where track stems are summed (`src/audio/effects/duck.ts`). Every track plays on an orbit (1 unless `fx orbit <n>` sets one). A track with `duck` is a sidechain trigger: each of its note onsets dips every other audible track on the target orbit by `depth`, reaching it over `onset` and recovering linearly over `attack`. Overlapping dips take the deepest; a ducker never ducks itself; loop renders wrap a dip across the loop end. The gain is computed from note onsets, not audio, so it is deterministic and costs one multiply per sample on ducked tracks. Typical use: `fx orbit 2` on the pad and bass, `fx duck preset pump` on the kick.

**Orbit buses** (`src/audio/effects/bus.ts`): `fx orbit shared on` makes a track send to its orbit's one shared delay and one shared reverb instead of running its own, as Strudel orbits do. Each member's stem (its chain up to delay) feeds the bus delay at its `delay.mix` and the bus reverb at its `reverb.mix`, both following their lanes; the bus delay's time, feedback, ping-pong and high-cut come from the first member in score order with a delay, the bus reverb's settings from the first member with a reverb. The two run in parallel and join the mix after the stems. Both are linear, so a one-member bus sounds exactly like that track's own delay and reverb; tracks without `shared` are unaffected.

**Convolution reverb** (`src/audio/effects/convolution.ts`, Strudel `iresponse`/`ir`): `fx reverb ir hall` (or `fx ir hall`) convolves with a generated impulse, `room`, `hall` or `plate`; `fx ir pack:<pack>/<sound>` or `fx ir samples/church.wav` uses a sample, pinned by sha256 like sampler files; `fx ir off` returns to the algorithmic tail. `mix` and `predelay` still apply; `size`, `fade` and `dim` do not. Uniformly partitioned FFT convolution, energy-normalized so a given `mix` sounds about as loud as the algorithmic tail; impulses are cut at 10 s.

`filter`, `delay` and `reverb` stay where they were on the track (older documents decode and render byte-for-byte as before; the new fields `filter.type`/`ftype`, `delay.time`/`pingpong`/`highcut` and `reverb.fade`/`lowpass`/`dim`/`predelay` are optional). The other effects live in `track.fx` keyed by name, and their parameter lanes in `track.fxAutomation` keyed `<effect>-<param>` (`autofilter-cutoff`, `distort-drive`, `reverb-mix`…). Omitted parameters take the defaults below, and turning an effect on with no parameters gives a good starting sound: the delay is a 3/16 (dotted-eighth) stereo ping-pong with feedback 0.35, mix 0.25 and a 5 kHz high-cut on the repeats.

Prompt grammar (one undo step per command; parameter names are dawg's or any Strudel name in the table):

```text
fx                                       list the focused track's effects
fx <effect> on|off|reset                 on with defaults, remove, back to defaults
fx <effect> preset <name>                load a preset
fx <effect> <param> <value> [<param> <value> …]
fx delay mix 0.3                         fx filter type hpf cutoff 300
fx distort drive 4 tone 5000             fx autofilter shape random sync 0.25
fx tremolo depth 0.8                     fx delay delayfeedback 0.4
fx orbit 2                               fx duck preset pump   (one number sets the first param)
automate distort-drive points 0:1 8:6    every numeric fx param has a lane
```

Aliases: `dist`, `comp`, `room`, `bitcrush`, `trem`, `auto-filter`, `bus`/`o` (orbit), `sidechain`/`duckorbit` (duck), `lpf`/`hpf`/`bpf` (filter with that type). The menu's Effects section opens each effect on its on/off toggle, presets and simple parameters; **advanced** lists every parameter with its Strudel names. The agent's `set_fx` tool takes the same names and presets.

Presets: filter `warm dark acid thin telephone`; autofilter `slow-sweep wobble s&h hpf-rise env-follow`; distort `warm crunch fuzz fold shape`; tremolo `gentle eighth-chop pulse`; compressor `gentle punch squash`; chorus `subtle wide seasick`; delay `ping-pong dotted-eighth slapback dub`; reverb `room hall plate ambient`; djf `dark thin`; formant `deep giant bright tiny`; vowel `a o ee`; crush `8-bit lofi destroy`; phaser `slow fast`; leslie `fast slow`; duck `pump subtle gate`.

The DSP is clean-room, written from public documentation of the parameters and standard literature (RBJ biquads, a Stilson/Smith-style ladder, Freeverb-style combs and allpasses, the Giannoulis–Massberg–Reiss compressor), not from Strudel or superdough source (AGPL). Renders stay deterministic: the random S&H shape hashes the cycle index, so cold, cached and worker renders are byte-identical (`src/audio/renderer.test.ts`).

Parameters (**bold** effect = shown in the simple menu; Lane = automation lane):

| Effect         | Param               | Range                                                                             | Default | Strudel                                                        | Lane                   |
| -------------- | ------------------- | --------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------- | ---------------------- |
| **filter**     | type (optional)     | lpf / hpf / bpf                                                                   | lpf     | `lpf`, `hpf`, `bpf`                                            |                        |
| filter         | ftype (optional)    | 12db / 24db / ladder                                                              | 12db    | `ftype`                                                        |                        |
| **filter**     | cutoff              | 20..20000 Hz                                                                      | 2000    | `lpf`, `cutoff`, `ctf`, `lp`, `hpf`, `hcutoff`, `bpf`, `bandf` | `filter`               |
| **filter**     | resonance           | 0..1                                                                              | 0       | `lpq`, `resonance`, `hpq`, `hresonance`, `bpq`, `bandq`        | `resonance`            |
| **djf**        | value               | 0..1                                                                              | 0.5     | `djf`                                                          | `djf-value`            |
| **autofilter** | type                | lpf / hpf / bpf                                                                   | lpf     | `ftype-like: lpf/hpf/bpf`                                      |                        |
| **autofilter** | cutoff              | 20..20000 Hz                                                                      | 1200    | `lpf`, `cutoff`                                                | `autofilter-cutoff`    |
| autofilter     | resonance           | 0..1                                                                              | 0.3     | `lpq`, `resonance`                                             | `autofilter-resonance` |
| **autofilter** | depth               | 0..6 oct                                                                          | 2       |                                                                | `autofilter-depth`     |
| **autofilter** | sync                | 0..64 beats                                                                       | 4       |                                                                |                        |
| autofilter     | rate                | 0.01..40 Hz                                                                       | 0.5     |                                                                | `autofilter-rate`      |
| **autofilter** | shape               | sine / tri / square / saw / ramp / random                                         | sine    |                                                                |                        |
| autofilter     | phase               | 0..1                                                                              | 0       |                                                                |                        |
| autofilter     | follow              | -6..6 oct                                                                         | 0       | `lpenv (per note, see synth)`                                  | `autofilter-follow`    |
| **formant**    | shift               | -12..12 st                                                                        | 0       |                                                                | `formant-shift`        |
| **formant**    | mix                 | 0..1                                                                              | 1       |                                                                | `formant-mix`          |
| **vowel**      | vowel               | a / e / i / o / u / ae / aa / oe / ue / y / uh / un / en / an / on                | a       | `vowel`                                                        |                        |
| **vowel**      | mix                 | 0..1                                                                              | 1       |                                                                | `vowel-mix`            |
| vowel          | to (optional)       | a / e / i / o / u / ae / aa / oe / ue / y / uh / un / en / an / on                | (none)  |                                                                |                        |
| vowel          | morph (optional)    | 0..1                                                                              | 0       |                                                                | `vowel-morph`          |
| **crush**      | bits                | 1..16                                                                             | 8       | `crush`                                                        | `crush-bits`           |
| **crush**      | coarse              | 1..64                                                                             | 1       | `coarse`                                                       |                        |
| **crush**      | mix                 | 0..1                                                                              | 1       |                                                                | `crush-mix`            |
| **distort**    | drive               | 0..10                                                                             | 2       | `distort`, `dist`                                              | `distort-drive`        |
| distort        | type                | soft / hard / cubic / diode / asym / fold / sinefold / chebyshev / scurve / shape | soft    | `distort type (3rd field)`, `shape → type shape`               |                        |
| **distort**    | tone                | 200..20000 Hz                                                                     | 8000    |                                                                | `distort-tone`         |
| **distort**    | mix                 | 0..1                                                                              | 1       |                                                                | `distort-mix`          |
| distort        | postgain            | 0..2                                                                              | 1       | `distort postgain`                                             |                        |
| **tremolo**    | sync                | 0..64 beats                                                                       | 0.5     | `tremolosync`, `tremsync`                                      |                        |
| tremolo        | rate                | 0.01..40 Hz                                                                       | 4       | `tremolo`                                                      | `tremolo-rate`         |
| **tremolo**    | depth               | 0..1                                                                              | 0.5     | `tremolodepth`, `tremdepth`                                    | `tremolo-depth`        |
| **tremolo**    | shape               | sine / tri / square / saw / ramp                                                  | sine    | `tremoloshape`, `tremshape`                                    |                        |
| tremolo        | skew                | 0..1                                                                              | 0.5     | `tremoloskew`, `tremskew`                                      |                        |
| tremolo        | phase               | 0..1                                                                              | 0       | `tremolophase`, `tremphase`                                    |                        |
| **compressor** | threshold           | -60..0 dB                                                                         | -18     | `compressor threshold`                                         | `compressor-threshold` |
| **compressor** | ratio               | 1..20                                                                             | 4       | `compressorRatio`                                              |                        |
| compressor     | knee                | 0..24 dB                                                                          | 6       | `compressorKnee`                                               |                        |
| compressor     | attack              | 0.0001..1 s                                                                       | 0.01    | `compressorAttack`                                             |                        |
| compressor     | release             | 0.01..2 s                                                                         | 0.15    | `compressorRelease`                                            |                        |
| **compressor** | makeup              | 0..24 dB                                                                          | 5       |                                                                | `compressor-makeup`    |
| **phaser**     | rate                | 0.01..40 Hz                                                                       | 0.5     | `phaser`, `ph`                                                 | `phaser-rate`          |
| phaser         | sync                | 0..64 beats                                                                       | 0       |                                                                |                        |
| **phaser**     | depth               | 0..1                                                                              | 0.75    | `phaserdepth`, `phd`, `phasdp`                                 | `phaser-depth`         |
| phaser         | center              | 100..10000 Hz                                                                     | 1000    | `phasercenter`, `phc`                                          |                        |
| phaser         | sweep               | 0..8000 Hz                                                                        | 2000    | `phasersweep`, `phs`                                           |                        |
| **chorus**     | rate                | 0.01..40 Hz                                                                       | 0.8     |                                                                | `chorus-rate`          |
| **chorus**     | depth               | 0..1                                                                              | 0.4     |                                                                | `chorus-depth`         |
| **chorus**     | mix                 | 0..1                                                                              | 0.5     |                                                                | `chorus-mix`           |
| **leslie**     | mix                 | 0..1                                                                              | 1       | `leslie`                                                       | `leslie-mix`           |
| **leslie**     | rate                | 0.01..40 Hz                                                                       | 6.7     | `lrate`                                                        | `leslie-rate`          |
| leslie         | size                | 0..1                                                                              | 0.5     | `lsize`                                                        |                        |
| **postgain**   | gain                | 0..4                                                                              | 1       | `postgain`, `post`                                             | `postgain-gain`        |
| **delay**      | beats               | 0.0625..4 beats                                                                   | 0.75    | `delaytime (seconds = beats·60/bpm)`                           |                        |
| **delay**      | feedback            | 0..0.9                                                                            | 0.35    | `delayfeedback`, `delayfb`, `dfb`                              | `delay-feedback`       |
| **delay**      | mix                 | 0..1                                                                              | 0.25    | `delay`                                                        | `delay-mix`            |
| delay          | time (optional)     | 0..4 s                                                                            | 0       | `delaytime`, `delayt`, `dt`                                    |                        |
| delay          | pingpong (optional) | on/off                                                                            | true    |                                                                |                        |
| delay          | highcut (optional)  | 500..20000 Hz                                                                     | 5000    |                                                                |                        |
| **reverb**     | mix                 | 0..1                                                                              | 0.3     | `room`                                                         | `reverb-mix`           |
| **reverb**     | size                | 0..1                                                                              | 0.5     | `roomsize`, `rsize`, `sz`, `size`                              |                        |
| reverb         | fade (optional)     | 0.1..20 s                                                                         | 2       | `roomfade`, `rfade`                                            |                        |
| reverb         | lowpass (optional)  | 200..20000 Hz                                                                     | 8000    | `roomlp`, `rlp`                                                |                        |
| reverb         | dim (optional)      | 200..20000 Hz                                                                     | 3000    | `roomdim`, `rdim`                                              |                        |
| reverb         | predelay (optional) | 0..0.5 s                                                                          | 0.02    |                                                                |                        |
| reverb         | ir (optional)       | `builtin:room\|hall\|plate\|reverse\|gate\|spring`, pack sound or project WAV     | off     | `iresponse`, `ir`                                              |                        |
| orbit          | orbit               | 1..16 (integer)                                                                   | 2       | `orbit`, `o`                                                   |                        |
| orbit          | shared (optional)   | on/off                                                                            | off     |                                                                |                        |
| duck           | orbit               | 1..16 (integer)                                                                   | 1       | `duckorbit`, `duck`                                            |                        |
| duck           | depth               | 0..1                                                                              | 1       | `duckdepth`                                                    |                        |
| duck           | attack              | 0.001..4 s                                                                        | 0.1     | `duckattack`, `duckatt`, `datt`                                |                        |
| duck           | onset               | 0..0.5 s                                                                          | 0.003   | `duckonset`                                                    |                        |

Strudel mapping notes: Strudel's `lpf`/`hpf`/`bpf` each set a separate filter; dawg has one track filter whose `type` selects the response, so `lpf(800)` is `filter {type: "lpf", cutoff: 800}` and `lpq`/`hpq`/`bpq` map to `resonance`. `delay` in Strudel is the wet level (dawg `delay.mix`), `delaytime` is seconds (dawg `delay.time`; `beats` is the tempo-synced form), `delayfeedback` is `delay.feedback`. `room` is `reverb.mix`, `size`/`roomsize` is `reverb.size`, `roomfade`/`roomlp`/`roomdim` are `fade`/`lowpass`/`dim`. `distort` and `shape` are the distortion drive with `type: "shape"` for Strudel's `shape` curve; `crush` is bits and `coarse` is the sample-hold factor. `phaser`/`phaserdepth`/`phasercenter`/`phasersweep`, `tremolo*`, `leslie`/`lrate`/`lsize`, `postgain` and `compressor` keep their names. `orbit` groups tracks for `duckorbit`/`duckdepth`/`duckattack`/`duckonset` sidechaining; By default each track keeps its own delay and reverb; `fx orbit 2 shared on` makes the track send to its orbit's one shared delay and reverb, as Strudel orbits do (see **Orbit buses**). `iresponse`/`ir` is `reverb.ir`.

### Guitar rig (stomp, head, cab)

A guitar rig is three effects in the chain after `distort` (`src/audio/effects/rig/`): a **stomp** box, an amp **head** with an optional noise gate, and a speaker **cab**inet. They run once per track on the mono voice sum, never per voice, and each nonlinear section has its own half-band oversampler (4x at 22.05 kHz, 2x at 44.1/48 kHz) with antiderivative-antialiased shapers, so a 1 kHz fuzz keeps its aliases at or below -60 dB in the audible band. A full rig costs about 15-25 ms per track-second.

```text
rig crunch                 a whole rig: stomp + head + cab (one undo step)
rig                        show the focused track's rig
rig reset                  remove all three stages
stomp fuzz | stomp gain 7  head lead | head treble 7 gate -55 | cab 4x12 | cab mic 0.6
fx head gain 4             the same stages through the generic fx grammar
rig jangle                 the jangle rig on the focused track (alias: track jangle makes a new guitar track)
```

- **stomp** `type` `fuzz` (Big Muff-style, with its tone stack), `face` (Fuzz Face-style), `od` (Tube Screamer-style mid hump and soft clip), `rat` (op-amp hard clip and filter), `octave` (Octavia-style full-wave rectifier, `octave` sets the blend). Each pedal is level-matched to bypass from a fixed -18 dBFS 196 Hz sine (within 1 dB at every type and gain), so kicking on a fuzz does not jump the track; `level` is a trim on top. Presets `muff face screamer rat octavia boost`.
- **head** `type` `clean` (Fender-style blackface), `chime` (Vox AC-style top boost), `crunch` and `lead` (Marshall-style), `high` (modern high gain), `solid` (clean solid state), `bass` (bass amp). Each has its own Yeh–Smith passive tone stack (`bass mid treble`), a `presence` shelf, power-amp `sag` and a `master`. Each type's makeup gain is calibrated once from a fixed -30 dBFS 196 Hz sine, so switching heads keeps the level within 1 dB. `gate` (dB threshold, absent = off) is a noise gate before the preamp with hysteresis and a short hold. Presets `blackface ac plexi lead modern jc svt`.
- **cab** `type` `1x12 2x12 4x12 1x10 open 8x10 1x15 di`: biquad speaker models (low resonance, presence peak, cone break-up roll-off); `mic` moves from the cone center (bright) to the edge (dark); `di` is the band-limited direct box for bass.

Rig presets (`RIG_PRESETS` in `core/fx.ts`): `clean crunch punk ragged lead metal fuzz octave funk wah bachata spring bassdrive reese jangle alt`. A rig writes its three stages and its companion effects (`funk` an envelope filter, `wah` an auto-wah, `bachata` a chorus, `jangle` a compressor, `spring` the track reverb); switching rigs or `rig reset` removes the previous rig's companions while they still hold the values the rig wrote, and keeps any you edited. Each stage stays editable afterwards, and the rig row then reads `—`. `rig <preset>` is the one word for the amp and pedals. The track words `jangle punk funk ragged gtr-lead gtr-metal bachata` remain as aliases that create a guitar track with that rig on every path (`track jangle`, `dawg jangle`, `instrument jangle`, the agent's create_track and set_instrument, SDK `instrument: "jangle"`): the strings `electric` voice (the 12-string `jangle` preset for jangle) plus that rig. `lead` and `bass` keep their synth meaning.

`amp` stays Strudel's linear gain: `fx amp` and `amp crunch` answer "did you mean head (guitar amp)?". Lanes: `stomp-gain`, `stomp-tone`, `head-gain` (coefficients follow automation every 32 samples, only while automated). Menu: **Ctrl-K › Effects › Guitar rig** (rig preset row, then Stomp box, Amp head, Speaker cabinet). Agent: `set_rig`. SDK: `fx: { ...rig("crunch") }` or the stages by name. In play mode a held note through a rig sounds its first 0.75 s window at render quality at once and the rest renders on a background worker in key order, so key handling never waits on it (the stages are causal, so the window is the exact prefix of the whole note).

| Effect    | Param           | Range                                               | Default | Lane         |
| --------- | --------------- | --------------------------------------------------- | ------- | ------------ |
| **stomp** | type            | fuzz / face / od / rat / octave                     | od      |              |
| **stomp** | gain            | 0..10                                               | 5       | `stomp-gain` |
| **stomp** | tone            | 0..1                                                | 0.5     | `stomp-tone` |
| **stomp** | level           | -24..12 dB                                          | 0       |              |
| stomp     | octave          | 0..1                                                | 0.7     |              |
| stomp     | mix             | 0..1                                                | 1       |              |
| **head**  | type            | clean / chime / crunch / lead / high / solid / bass | crunch  |              |
| **head**  | gain            | 0..10                                               | 5       | `head-gain`  |
| **head**  | bass            | 0..10                                               | 5       |              |
| **head**  | mid             | 0..10                                               | 5       |              |
| **head**  | treble          | 0..10                                               | 5       |              |
| head      | presence        | 0..10                                               | 5       |              |
| head      | master          | 0..10                                               | 5       |              |
| head      | sag (optional)  | 0..1                                                | 0.3     |              |
| head      | gate (optional) | -96..0 dB                                           | off     |              |
| head      | level           | -24..12 dB                                          | 0       |              |
| **cab**   | type            | 1x12 / 2x12 / 4x12 / 1x10 / open / 8x10 / 1x15 / di | 2x12    |              |
| **cab**   | mic             | 0..1                                                | 0.3     |              |
| **cab**   | mix             | 0..1                                                | 1       |              |

### Shoegaze (wobble, bloom, swell, double) (0.6.1)

Four effects that sit after `cab` and before `tremolo` (`double` runs after `pan`, because it makes the stereo image), in `src/audio/effects/gaze.ts`. They run once per track, never per voice, and use seeded randomness only, so every render is identical.

```text
fx wobble                  held tremolo arm: seeded pitch wow and flutter (depth 20 c)
fx wobble depth 35 rate 0.4 drift 0.5
fx bloom                   feedback: the top held note grows a singing harmonic
fx swell time 0.5          volume swell: each strum fades in, no pick attack
fx double                  a second, seeded take a few ms late, spread left and right
rig shoegaze               fuzz + chime head + wobble + bloom + double + a big reverb
fx reverb ir builtin:reverse  reverse-gate swell after the attack, not a pre-verb (also builtin:gate and builtin:spring)
track shoegaze             alias: a new electric guitar track named shoegaze, with the shoegaze rig
```

- **wobble** (`depth` 0..100 cents, `rate` Hz, `drift` 0 periodic .. 1 wandering) is a modulated fractional delay read with a 4-point interpolator, like a held vibrato arm or tape wow. Its peak deviation equals `depth` (a sustained A3 at depth 35 swings ±35 c). `depth` is automatable.
- **bloom** (`amount`, `harm` 1..4, `delay` s, `time` s) finds the highest held note at each moment (EffectContext.notes) and grows a phase-continuous partial at its `harm`-th harmonic after the note has been held `delay` seconds, the way an amp in feedback picks one note. Each note's partial is seeded by the note id, so it is stable when other notes change.
- **swell** (`time` s, `mix`) restarts a raised-cosine fade at each note onset: a volume-pedal swell without the pick.
- **double** (`time` 5..60 ms, `drift` ms, `width`) is automatic double tracking: a second take through a modulated delay whose timing wanders by `drift`, panned against the dry take. Left/right correlation stays between 0.3 and 0.8.

Rig presets gain `shoegaze glide dreampop swell ebow` (the `swell` rig is the swell effect plus a clean amp and a room; `ebow` is swell plus a bloom on the note itself). `jangle` now also writes a light `double`; a project that loaded jangle before 0.6.1 keeps its stored stages and renders unchanged until `rig jangle` is applied again. In `song.ts`, `rig("jangle")` and `instrument: "jangle"` keep the 0.6.0 stages (no double) so existing files render unchanged; add `double: {}` for the 0.6.1 sound. `instrument: "shoegaze"`, `"dreampop"` and `"ebow"` (the rig names that are also instrument words; `glide` and `swell` are reached with `rig glide`/`rig swell` or `fx: rig("glide")`) also set the rig's reverb wash, like `rig shoegaze`; `rig()` returns effects only, so pair it with `reverb: rigReverb("shoegaze")`. The rigs carry a `postgain` trim so the shoegaze rigs land within 2.5 dB of `clean` on a held chord, and `shoegaze`, `glide` and `dreampop` also on a dense strum. `swell` and `ebow` restart their fade on every onset, so a fast strum through them sits several dB lower; they are made for held notes and slow chords. The built-in impulses `reverse` (energy rising to a hard stop: a reverse-gate swell that rises after each attack, not a pre-verb that swells into the note; no rig preset uses it, so reach it with `fx reverb ir builtin:reverse`), `gate` (a dense, flat 250 ms burst cut short) and `spring` (a dispersive, chirping tank) are generated from seeded noise like `room hall plate`; no recorded IR ships. Menu: **Ctrl-K › Effects › Shoegaze**, and the rig preset row in **Ctrl-K › Effects › Guitar rig**. Agent: `set_fx` and `set_rig`. SDK: `fx: { ...rig("shoegaze") }` or `fx: { wobble: { depth: 30 } }`. A full shoegaze rig costs under 25 ms per track-second.

| Effect     | Param  | Range        | Default | Lane           |
| ---------- | ------ | ------------ | ------- | -------------- |
| **wobble** | depth  | 0..100 cents | 20      | `wobble-depth` |
| **wobble** | rate   | 0.05..8 Hz   | 0.5     |                |
| **wobble** | drift  | 0..1         | 0.3     |                |
| **bloom**  | amount | 0..1         | 0.5     |                |
| **bloom**  | harm   | 1..4         | 2       |                |
| **bloom**  | delay  | 0..4 s       | 0.6     |                |
| bloom      | time   | 0.05..4 s    | 1       |                |
| **swell**  | time   | 0.01..4 s    | 0.4     |                |
| **swell**  | mix    | 0..1         | 1       | `swell-mix`    |
| **double** | time   | 5..60 ms     | 22      |                |
| **double** | drift  | 0..10 ms     | 3       |                |
| **double** | width  | 0..1         | 0.6     |                |

## Master and loudness

The song master is an optional chain after every track, orbit bus and duck are summed: **EQ** (low shelf, two bells, high shelf) → **glue** (stereo-linked bus compressor with soft knee, parallel mix and a sidechain high-pass) → **tape** (saturation with bias and a tone roll-off) → **width** (mid/side, mono below a cutoff) → **limiter** (true-peak brickwall with lookahead). A song with no master renders byte-identically to 0.4; an absent unit is skipped and a 0 dB EQ band is skipped.

| Command                                  | Does                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `master glue on` / `master glue off`     | a unit with defaults, or drop it                                                                                                                                                                                                      |
| `master glue preset glue`                | presets: eq `air warm mud-cut smile`, glue `gentle glue pump`, tape `warm hot crush`, width `narrow wide vinyl` (vinyl: mono below 150 Hz), limiter `transparent loud brick`                                                          |
| `master glue ratio 4`                    | one parameter (turns the unit on)                                                                                                                                                                                                     |
| `master streaming` / `master target -14` | a loudness target by name or LUFS; `master -14` and `master on` (streaming) are shorthands, as are `master spotify`/`youtube`/`tidal`; a positive number is read as negative LUFS and the reply says so; `master target off` drops it |
| `master measure`                         | integrated, short-term max and momentary max LUFS, loudness range, true peak, correlation                                                                                                                                             |
| `master off`                             | remove the master                                                                                                                                                                                                                     |

Targets: `streaming` -14 LUFS / -1 dBTP, `apple` and `podcast` -16, `broadcast` -23 (EBU R 128), `classical` -20, `ambient` -18, `club` -8 / -2 dBTP (with the `loud` limiter) and `loud` -6 / -2 dBTP (with the `brick` limiter, for hyperpop, gabber and hardcore; masters louder than -14 LUFS stay under -2 dBTP because lossy encoding of loud, dense material adds inter-sample overs). With the limiter on, a target sets the limiter's input gain: a bracketing search on the measured integrated loudness that starts from the linear estimate, gives the same answer for the same mix every time, and stops early with `reached: false` once more drive no longer raises the loudness. At -6 LUFS the limiter alone may stop short; `tape preset crush` or a lower glue threshold before it helps; without it, the gain is capped so the true peak stays at or below -1 dBTP, so a quiet target is always met and a loud one may fall short (the measurement says so).

Measurement follows ITU-R BS.1770-4 and EBU R 128: K-weighting derived for any sample rate, 400 ms momentary and 3 s short-term windows (maxima on a 10 ms grid), the -70 LUFS absolute and -10 LU relative gates for integrated loudness, the EBU Tech 3342 loudness range (-20 LU gate, 10th to 95th percentile of short-term values), and true peak from the BS.1770-4 Annex 2 4x oversampling filter. Tests check EBU Tech 3341 cases 1–5, 9–14 (11 and 14 modeled) and 15–19 and Tech 3342 cases 1–4 within their tolerances. The parameters are in `core/master.ts` (`MASTER_SPECS`, `MASTER_PRESETS`, `LOUDNESS_TARGETS`).

Parameters (**bold** unit = shown in the simple menu; the rest are under `advanced`). Glue's `auto` make-up adds half the reduction a full-scale peak gets, so glue on and off compare near level-matched. Clean EQ corners above 0.45 × the render rate are clamped there.

<!-- master-params:start -->

| Unit        | Param     | Range          | Default | Does                                                                                   |
| ----------- | --------- | -------------- | ------- | -------------------------------------------------------------------------------------- |
| **eq**      | low       | -12..12 dB     | 0       | low shelf gain                                                                         |
| eq          | lowfreq   | 20..1000 Hz    | 100     | low shelf corner                                                                       |
| **eq**      | bell1     | -12..12 dB     | 0       | first bell gain                                                                        |
| eq          | bell1freq | 40..16000 Hz   | 400     | first bell center                                                                      |
| eq          | bell1q    | 0.1..10        | 1       | first bell width: higher is narrower                                                   |
| **eq**      | bell2     | -12..12 dB     | 0       | second bell gain                                                                       |
| eq          | bell2freq | 200..18000 Hz  | 3000    | second bell center                                                                     |
| eq          | bell2q    | 0.1..10        | 1       | second bell width: higher is narrower                                                  |
| **eq**      | high      | -12..12 dB     | 0       | high shelf gain                                                                        |
| eq          | highfreq  | 1000..20000 Hz | 10000   | high shelf corner                                                                      |
| **glue**    | threshold | -40..0 dB      | -18     | level where compression starts                                                         |
| **glue**    | ratio     | 1..10          | 2       | input:output above threshold (2 and 4 are the classic bus settings)                    |
| **glue**    | attack    | 0.1..30 ms     | 10      | how fast it clamps down; slower lets transients through                                |
| **glue**    | release   | 50..1200 ms    | 300     | how fast it lets go; set it to breathe with the tempo                                  |
| glue        | knee      | 0..12 dB       | 6       | soft-knee width                                                                        |
| **glue**    | makeup    | 0..24 dB       | 0       | gain after compression (on top of auto)                                                |
| **glue**    | auto      | on / off       | on      | automatic make-up (half the reduction at 0 dBFS) so on/off compares near level-matched |
| glue        | mix       | 0..1           | 1       | dry/wet: below 1 is parallel compression                                               |
| glue        | hpf       | 0..400 Hz      | 0       | sidechain high-pass so the bass does not pump the mix; 0 is off                        |
| **tape**    | drive     | 0..24 dB       | 6       | push into the curve: denser and louder                                                 |
| tape        | bias      | 0..0.5         | 0.1     | asymmetry: adds even harmonics                                                         |
| tape        | tone      | 2000..20000 Hz | 20000   | high-frequency roll-off after the curve; 20000 is off                                  |
| **tape**    | mix       | 0..1           | 1       | dry/wet                                                                                |
| **width**   | width     | 0..2           | 1       | side level: 0 is mono, 1 unchanged, 2 twice as wide                                    |
| **width**   | mono      | 0..300 Hz      | 120     | below this the mix is mono (keeps bass centered); 0 is off                             |
| **limiter** | ceiling   | -12..0 dBTP    | -1      | highest true peak out                                                                  |
| **limiter** | gain      | 0..24 dB       | 0       | drive into the limiter (a target sets it itself)                                       |
| **limiter** | release   | 1..1000 ms     | 100     | recovery time; short is louder, long is cleaner                                        |
| limiter     | lookahead | 0.5..10 ms     | 5       | how early gain reduction starts before a peak                                          |
| limiter     | truepeak  | on / off       | on      | catch peaks between samples (4x oversampled detection)                                 |

<!-- master-params:end -->

A song with a master renders at 48 kHz; a song without one keeps the engine's 22,050 Hz, as dawg 0.4 wrote it, so older projects export byte-identically. `--rate 48000` (or 44100) picks the rate for any render. `dawg render out.wav --normalize streaming` (or a LUFS number) applies a target for that export only, without changing the song; `--measure` prints the loudness line after any render. When samples hit 16-bit full scale, `dawg render` prints a `warning · N samples clip` line on stderr with the fix (lower volumes, or a master with a limiter). While the loop plays, the header shows `-14.1 LUFS (-14) · TP -1.0` for the last rendered loop, with or without a master, so you can read a mix before mastering it. The bracket is the target, and the reading turns to a warning color when it is more than 0.5 LU off the target or the true peak passes the limiter's ceiling (-1 dBTP without one). With a master the loop monitors at the engine's 22,050 Hz while exports and `master measure` run at 48 kHz; the header shows the 48 kHz reading once it is measured in the background (a `~` marks the monitor estimate until then). EQ above about 9.9 kHz is not audible while monitoring but is in the export. The menu has it under **Ctrl-K › Mix › master** (`/menu master`), where `Space` stages master changes for A/B like other sound edits. The agent has `set_master` and `measure_mix` (integrated, short-term and momentary LUFS, loudness range, true peak, spectral balance in five bands (sub, bass, low-mid, high-mid, high) and stereo correlation, with `bypass_master` to compare); it masters only when asked and measures before and after. In the SDK: `song({ master: { glue: { ratio: 2 }, limiter: { ceiling: -1 }, target: -14 } })` (SDK 1.17.0).

## Synth

A synth track's voice is shaped by `track.synth`, a map of Strudel (superdough) parameter names to values. Parameter names are Strudel's wherever one means the same thing, and every Strudel alias is accepted on input (`att`, `lpe`, `fmi`, `vmod`…); the stored and printed form is the canonical name in the table. Only the parameters a document sets are stored, and an unset one takes its default, as in Strudel. A track with no `synth` and one of dawg's original instruments (`sine piano pluck bass saw square triangle`) renders byte-for-byte as before.

Sounds (`instrument`): `sine`, `sawtooth` (`saw` stays the legacy voice until `synth` is set), `square`, `triangle`, `supersaw`, `pulse`, `user` (additive, from `partials`/`phases`), and noise `white`, `pink`, `brown`, `crackle`, plus the ZzFX sounds `z_sine`, `z_triangle`, `z_sawtooth`, `z_square`, `z_tan`, `z_noise`. Aliases: `sin`, `tri`, `sqr`, `noise`/`whitenoise`, `pinknoise`, `brownnoise`. Any oscillator can be mixed with noise (`noise`, and `density` for crackle), detuned into a unison stack (`unison`, `detune`, `spread`), pulse-width modulated (`pw`, `pwrate`, `pwsweep`), and frequency-modulated by up to eight operators (`fm`…`fm8`, each with `fmh`, an ADSR, `fmenv` lin/exp and `fmwave`). The operators modulate the carrier's phase in parallel, each at its own ratio `fmh`. The pitch envelope (`penv` semitones with `pattack/pdecay/psustain/prelease`, `pcurve`, `panchor`) and vibrato (`vib` Hz, `vibmod` semitones) bend pitch. Three per-voice filters (`lpf`, `hpf`, `bpf`, in that order) each have `q`, an envelope depth in octaves (`lpenv`…) and their own ADSR; `ftype` chooses 12 dB, 24 dB or ladder for the low-pass and `fanchor` sets where the envelope sits relative to the cutoff. A filter whose cutoff is unset is off.

ZzFX sounds (`z_*`) run their own small procedural generator (`src/audio/synth/zzfx.ts`) and then the same ADSR and per-voice filters: frequency = note·(1 ± `zrand`) + 500·`slide` Hz/s + 250·`deltaSlide`·t² Hz, plus `pitchJump` Hz once `pitchJumpTime` seconds have passed; `lfo` (seconds) restarts slide and pitch jump every period and sets the period of `tremolo` (volume modulation amount); `zmod` is an FM rate in Hz at ±50 % depth; `noise` jitters the phase increment (on other sounds it mixes pink noise); `curve` bends the wave (sign·|x|^curve, 0 squares it); `zcrush` holds samples (0..1 → 1..100 samples at 44.1 kHz); `zdelay` adds one echo at half level. Strudel documents names and intent, not units, so these units are dawg's.

The oscillator is chosen in one place, `resolveOscillator()` in `src/audio/synth/oscillators.ts`, which maps a sound name to an oscillator factory that can read the track's synth parameters. Another module can add sounds with `registerOscillatorResolver()` and reuse the voice's ADSR, filter envelopes, unison and FM.

Prompt grammar (one undo step per command):

```text
synth                                    list what this track sets
synth preset <name>                      instrument + parameters
synth lpf 800 lpenv 3 lpdecay 0.2        any parameter by name or Strudel alias
synth fm 4 fmh 1.5                       synth adsr 0.01 0.2 0.5 0.3
synth partials 1 0.5 0.33 0.25           additive harmonics (also phases)
synth lpf off                            unset one parameter
synth reset                              unset everything
synth zzfx ,,129,.01,,.15,2             a raw ZzFX array (or paste zzfx(...[…]))
automate synth-lpf points 0:400 8:4000   numeric parameters have lanes
```

Raw ZzFX arrays (Strudel `zzfx([...])`) use ZzFX's documented positional layout: volume→`gain`, randomness→`zrand`, frequency (the note), attack, sustain time (the note's length), release, shape 0–5→`z_sine`/`z_triangle`/`z_sawtooth`/`z_tan`/`z_noise`/`z_square`, shapeCurve→`curve`, `slide`, `deltaSlide`, `pitchJump`, `pitchJumpTime`, repeatTime→`lfo`, `noise`, modulation→`zmod`, bitCrush→`zcrush`, delay→`zdelay`, sustainVolume→`sustain`, `decay`, `tremolo`, filter (> 0 high-pass Hz, < 0 low-pass Hz). Empty slots take ZzFX's defaults; the result is stored as the named controls, so it prints and edits like any synth track. The SDK has `zzfx([...])` to spread into `track({...})` and `set_synth` takes `zzfx`.

Presets: `pad` (supersaw: slow, wide detuned saws through a soft low-pass), `lead` (sawtooth: bright saw with a short filter blip and delayed vibrato feel), `pluck` (pulse: short percussive pulse with a fast filter envelope), `bass` (sawtooth: round saw bass, 24 dB low-pass with a little bite), `sub` (sine: clean sine sub with a tiny pitch drop on each note), `acid` (sawtooth: ladder low-pass with high resonance and a snappy envelope), `keys` (sine: electric-piano style 1:1 FM with a decaying modulator), `bell` (sine: inharmonic FM bell with a long ring), `organ` (user: drawbar-style additive organ with a gentle vibrato), `strings` (supersaw: softer ensemble: slow attack, gentle vibrato, darker filter), `brass` (sawtooth: filter swell on attack like a brass section), `wind` (pink: breathy band-passed noise that swells and fades), `chip` (pulse: 8-bit square lead with slow pulse-width motion), `zap` (z_square: ZzFX laser zap: a square that dives in pitch).

The menu's **Parameters** section shows the instrument, preset and the simple parameters (ADSR, lpf/lpq/lpenv, detune, vib, fm); **advanced** groups every parameter (amplitude, oscillator, vibrato, pitch envelope, the three filters, FM 1–8, ZzFX, partials) with its Strudel aliases. The agent's `set_synth` tool takes the same names and presets.

Automation lanes `synth-<param>` are read at each note's onset, as Strudel reads a patterned control once per event. Note velocity scales the voice as Strudel's `velocity` does, and `gain` is the voice gain before the effects chain.

The DSP is dawg's own, clean-room from public documentation and standard literature (PolyBLEP oscillators, Paul Kellet's pink-noise filter, leaky-integrated brown noise, RBJ biquads and a Stilson/Smith-style ladder, linear and exponential ADSRs, phase-modulation FM), not from Strudel or superdough source (AGPL-3.0). Noise comes from a PRNG seeded by each note, so renders stay byte-identical across cold, cached and worker paths.

| Param         | Range                               | Default | Strudel names                | Lane                  |
| ------------- | ----------------------------------- | ------- | ---------------------------- | --------------------- |
| **attack**    | 0..10 s                             | 0.003   | `attack`, `att`              | `synth-attack`        |
| **decay**     | 0..10 s                             | 0.05    | `decay`, `dec`               | `synth-decay`         |
| **sustain**   | 0..1                                | 1       | `sustain`, `sus`             | `synth-sustain`       |
| **release**   | 0..10 s                             | 0.05    | `release`, `rel`             | `synth-release`       |
| gain          | 0..4                                | 1       | `gain`                       | `synth-gain`          |
| noise         | 0..1                                | 0       | `noise`                      | `synth-noise`         |
| density       | 0..1                                | 0.03    | `density`                    | `synth-density`       |
| unison        | 1..16                               | 1       | `unison`                     |                       |
| **detune**    | 0..12 st                            | 0.2     | `detune`                     | `synth-detune`        |
| spread        | 0..1                                | 0.6     | `spread`                     | `synth-spread`        |
| pw            | 0..1                                | 0.5     | `pw`                         | `synth-pw`            |
| pwrate        | 0..40 Hz                            | 1       | `pwrate`                     | `synth-pwrate`        |
| pwsweep       | 0..1                                | 0       | `pwsweep`                    | `synth-pwsweep`       |
| **vib**       | 0..64 Hz                            | 0       | `vib`, `vibrato`, `v`        | `synth-vib`           |
| vibmod        | 0..24 st                            | 0.5     | `vibmod`, `vmod`             | `synth-vibmod`        |
| penv          | -48..48 st                          | 0       | `penv`                       | `synth-penv`          |
| pattack       | 0..10 s                             | 0.2     | `pattack`, `patt`            | `synth-pattack`       |
| pdecay        | 0..10 s                             | 0       | `pdecay`, `pdec`             | `synth-pdecay`        |
| psustain      | 0..1                                | 1       | `psustain`, `psus`           | `synth-psustain`      |
| prelease      | 0..10 s                             | 0       | `prelease`, `prel`           | `synth-prelease`      |
| pcurve        | 0..1                                | 0       | `pcurve`                     |                       |
| panchor       | 0..1                                | 0       | `panchor`                    |                       |
| **lpf**       | 20..20000 Hz                        | 2000    | `lpf`, `cutoff`, `ctf`, `lp` | `synth-lpf`           |
| **lpq**       | 0..50                               | 1       | `lpq`, `resonance`           | `synth-lpq`           |
| **lpenv**     | -10..10 oct                         | 0       | `lpenv`, `lpe`               | `synth-lpenv`         |
| lpattack      | 0..10 s                             | 0.005   | `lpattack`, `lpa`            | `synth-lpattack`      |
| lpdecay       | 0..10 s                             | 0.15    | `lpdecay`, `lpd`             | `synth-lpdecay`       |
| lpsustain     | 0..1                                | 0       | `lpsustain`, `lps`           | `synth-lpsustain`     |
| lprelease     | 0..10 s                             | 0.1     | `lprelease`, `lpr`           | `synth-lprelease`     |
| hpf           | 20..20000 Hz                        | 200     | `hpf`, `hcutoff`, `hp`       | `synth-hpf`           |
| hpq           | 0..50                               | 1       | `hpq`, `hresonance`          | `synth-hpq`           |
| hpenv         | -10..10 oct                         | 0       | `hpenv`, `hpe`               | `synth-hpenv`         |
| hpattack      | 0..10 s                             | 0.005   | `hpattack`, `hpa`            | `synth-hpattack`      |
| hpdecay       | 0..10 s                             | 0.15    | `hpdecay`, `hpd`             | `synth-hpdecay`       |
| hpsustain     | 0..1                                | 0       | `hpsustain`, `hps`           | `synth-hpsustain`     |
| hprelease     | 0..10 s                             | 0.1     | `hprelease`, `hpr`           | `synth-hprelease`     |
| bpf           | 20..20000 Hz                        | 1000    | `bpf`, `bandf`, `bp`         | `synth-bpf`           |
| bpq           | 0..50                               | 1       | `bpq`, `bandq`               | `synth-bpq`           |
| bpenv         | -10..10 oct                         | 0       | `bpenv`, `bpe`               | `synth-bpenv`         |
| bpattack      | 0..10 s                             | 0.005   | `bpattack`, `bpa`            | `synth-bpattack`      |
| bpdecay       | 0..10 s                             | 0.15    | `bpdecay`, `bpd`             | `synth-bpdecay`       |
| bpsustain     | 0..1                                | 0       | `bpsustain`, `bps`           | `synth-bpsustain`     |
| bprelease     | 0..10 s                             | 0.1     | `bprelease`, `bpr`           | `synth-bprelease`     |
| ftype         | 12db / 24db / ladder                | 12db    | `ftype`                      |                       |
| fanchor       | 0..1                                | 0       | `fanchor`                    | `synth-fanchor`       |
| **fm**        | 0..64                               | 0       | `fm`, `fmi`                  | `synth-fm`            |
| fmh           | 0..32                               | 1       | `fmh`                        | `synth-fmh`           |
| fmattack      | 0..10 s                             | 0       | `fmattack`, `fmatt`          | `synth-fmattack`      |
| fmdecay       | 0..10 s                             | 0       | `fmdecay`, `fmdec`           | `synth-fmdecay`       |
| fmsustain     | 0..1                                | 1       | `fmsustain`, `fmsus`         | `synth-fmsustain`     |
| fmrelease     | 0..10 s                             | 0       | `fmrelease`, `fmrel`         | `synth-fmrelease`     |
| fmenv         | lin / exp                           | lin     | `fmenv`, `fme`               |                       |
| fmwave        | sine / sawtooth / square / triangle | sine    | `fmwave`                     |                       |
| zrand         | 0..1                                | 0       | `zrand`                      | `synth-zrand`         |
| curve         | 0..3                                | 1       | `curve`                      | `synth-curve`         |
| slide         | -20..20                             | 0       | `slide`                      | `synth-slide`         |
| deltaSlide    | -20..20                             | 0       | `deltaSlide`                 | `synth-deltaSlide`    |
| pitchJump     | -2000..2000 Hz                      | 0       | `pitchJump`                  | `synth-pitchJump`     |
| pitchJumpTime | 0..10 s                             | 0       | `pitchJumpTime`              | `synth-pitchJumpTime` |
| lfo           | 0..10 s                             | 0       | `lfo`                        | `synth-lfo`           |
| zmod          | 0..1000 Hz                          | 0       | `zmod`                       | `synth-zmod`          |
| zcrush        | 0..1                                | 0       | `zcrush`                     | `synth-zcrush`        |
| zdelay        | 0..1 s                              | 0       | `zdelay`                     | `synth-zdelay`        |
| tremolo       | 0..1                                | 0       | `tremolo`                    | `synth-tremolo`       |
| partials      | up to 64 numbers -1..1              | —       | `partials`                   |                       |
| phases        | up to 64 numbers 0..1               | —       | `phases`                     |                       |

FM operators 2–8 repeat the `fm` rows with a suffix (`fm2`, `fmh2`, `fmattack2` … `fmwave8`), each with its lane.

### Strudel parity

| Strudel                                                                                                                                                                              | dawg                                                           | Status                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------- |
| `s`/`sound` sine, sawtooth, square, triangle, supersaw, pulse, user, white, pink, brown, crackle                                                                                     | `instrument`                                                   | done                                                 |
| `noise`, `density`                                                                                                                                                                   | `synth.noise`, `synth.density`                                 | done                                                 |
| `unison`, `spread`, `detune`                                                                                                                                                         | `synth.*`                                                      | done                                                 |
| `pw`, `pwrate`, `pwsweep`                                                                                                                                                            | `synth.*`                                                      | done                                                 |
| `fm`/`fmi`, `fmh`, `fmattack/fmdecay/fmsustain/fmrelease`, `fmenv`, `fmwave`, operators 2–8                                                                                          | `synth.*`                                                      | done                                                 |
| `attack/decay/sustain/release`, `adsr`, `gain`, `velocity`                                                                                                                           | `synth.*`; `adsr` is command shorthand; velocity is the note's | done                                                 |
| `penv`, `pattack/pdecay/psustain/prelease`, `pcurve`, `panchor`                                                                                                                      | `synth.*`                                                      | done                                                 |
| `vib`/`vibrato`, `vibmod`                                                                                                                                                            | `synth.*`                                                      | done                                                 |
| `lpf/hpf/bpf`, `lpq/hpq/bpq`, `lpenv/hpenv/bpenv` and their ADSRs, `ftype`, `fanchor`                                                                                                | `synth.*` (per voice); also the track `filter` effect          | done                                                 |
| `partials`, `phases`                                                                                                                                                                 | `synth.partials`, `synth.phases`                               | done                                                 |
| `vowel`, `coarse`, `crush`, `shape`, `distort`, `djf`                                                                                                                                | effects `vowel`, `crush`, `distort`, `djf`                     | done (see Effects)                                   |
| `phaser*`, `tremolo*`, `leslie`/`lrate`/`lsize`, `compressor*`, `postgain`                                                                                                           | effects of the same names                                      | done                                                 |
| `room`, `size`, `roomfade`, `roomlp`, `roomdim`                                                                                                                                      | `reverb`                                                       | done                                                 |
| `delay`, `delaytime`, `delayfeedback`                                                                                                                                                | `delay`                                                        | done                                                 |
| `pan`                                                                                                                                                                                | track `pan`                                                    | done                                                 |
| `orbit`, `duckorbit`/`duckdepth`/`duckattack`/`duckonset`                                                                                                                            | effects `orbit` (+ `shared`), `duck`                           | done: `shared` sends to one delay + reverb per orbit |
| `iresponse`/`ir`                                                                                                                                                                     | `reverb.ir`                                                    | done: FFT convolution; built-ins or a pinned sample  |
| `z_sine`…`z_noise`; `zrand`, `curve`, `slide`, `deltaSlide`, `pitchJump`, `pitchJumpTime`, `lfo`, `noise`, `zmod`, `zcrush`, `zdelay`, `tremolo`                                     | ZzFX sounds, `synth.*`                                         | done (clean-room; units documented above)            |
| zzfx `duration`                                                                                                                                                                      | note length                                                    | done: a note's length is its duration                |
| raw `zzfx([...])` parameter array                                                                                                                                                    | `synth zzfx …`, SDK `zzfx([...])`, `set_synth {zzfx}`          | done: ZzFX's documented layout → named controls      |
| soundfonts `gm_*`, drum banks, dirt-samples                                                                                                                                          | sampler and sample packs                                       | not this engine: hosted samples, see Sample packs    |
| sample controls `begin`, `end`, `speed`, `unit`, `loop`, `loopBegin`/`loopb`, `loopEnd`/`loope`, `clip`/`legato`, `fit`, `loopAt`, `accelerate`, `squiz`, `cut`, `gain`, `vel`, `rr` | sampler voice fields; `/sample set`, `set_sample`              | done (see Samples)                                   |
| fitting to tempo (Ableton Repitch/Beats/Tones; Strudel `fit`)                                                                                                                        | `bpm` `fitmode` `len`; `/fitmode`, `fit_sample`                | done (see Fitting samples)                           |

## Patches

A patch is a small modular synth or effect stored in the score: nodes (oscillators, filters, envelopes, math, whole engines and effects) joined by cables, with up to four macros as its knobs. A track plays one as its instrument (`instrument: "patch"`) or runs effect patches in its chain (`fx.patch`); `song.ts` can also hold a library of named patches that tracks reference.

### Patches in song.ts (SDK 1.35.0)

`patch(name, build)` builds an instrument patch and `fxPatch(name, build)` an effect patch. The build callback receives a factory per node type (`osc`, `svf`, `adsr`, `vca`, `fx.distort`, `engine.modal`, …), the boundaries `voice` (`pitch`, `gate`, `velocity`, …), `song` (`beat`, `bar.phase`, `tempo`) and `input` (the track's notes, its audio and the sidechain), and `macro(id, { min, max, default, curve })`; the first four macros are the knobs, in call order.

```ts
const acid = patch("acid-bass", ({ voice, osc, svf, adsr, vca, fx, macro }) => {
  const cutoff = macro("cutoff", {
    min: 80,
    max: 4000,
    default: 600,
    curve: "exp",
  });
  const env = adsr({
    attack: 0.002,
    decay: 0.2,
    sustain: 0,
    release: 0.05,
  }).gate(voice.gate);
  return osc({ wave: "saw" })
    .pitch(voice.pitch)
    .to(
      svf({ mode: "lp" })
        .cutoff(cutoff.plus(env.times(2400)))
        .q(macro("reso")),
    )
    .to(vca().gain(env.times(voice.velocity)))
    .to(fx.distort({ drive: 3 }).global());
});

export default track({
  name: "acid",
  instrument: acid,
  mods: { cutoff: sine.range(300, 2400).slow(4), reso: pat("0.5 0.8 0.6 0.9") },
  notes: seq("A1 A1 C2 A1 G1 A1 E2 D2", { step: 0.25 }),
});
```

- `a.to(b)` cables `a`'s main audio out into `b`'s main audio in and returns `b`. A port setter (`.cutoff(x)`, `.gain(x)`) takes a number, a node, a macro or a pattern; `.input("fm")` and `.output("right")` name other ports. Port setters and settings are typed from the node specs, so a notes source into `cutoff`, an unknown port or a wave word a node does not know is a type error.
- `x.plus(y)`, `x.times(y)`, `x.range(lo, hi)` and `x.amount(k)` (an attenuverter, -1..1) add math nodes; `.global()` moves a node after the voice sum, so it runs once for all voices.
- Node and cable ids come from a stable hash of the patch's name and the build, so the same source builds the same patch; pass `{ id }` to a factory to pin one.
- `patch(name, build, { voices, side, at: "post", from })` sets polyphony, the sidechain track, placement after the effect chain (effect patches) and provenance.
- The plain form `patch({ role, name, nodes, cables, macros })` is what `dawg` prints back; `patch({ ref: "acid-bass", macros: { cutoff: 900 } })` plays a patch from `song({ patches: [...] })` with its own macro values.

### Patterns as signals

`sine`, `cosine`, `saw`, `isaw`, `tri`, `square`, `rand`, `perlin`, `irand(n)` and `pat("0 0.5 <1 0.8>")` are Strudel's continuous signals, one cycle a bar, with `.range`, `.rangex`, `.slow`, `.fast`, `.segment`, `.add`, `.mul`, `.early`, `.late` and `.every(n, f)`. Values follow Strudel's formulas (`sine` is 0.5 at the bar start and rises; `rand` and `perlin` use its legacy xorshift, seeded per track from the track id). On a track, `mods: { cutoff: sine.range(300, 2400).slow(4) }` drives a patch macro and `lanes: { "synth-lpf": saw.range(400, 3000) }` any automation lane. `song()` bakes each into automation points (at most 16 a bar; stepped signals such as `pat` and `segment` hold their values), and a lane written under `automation` wins. Wiring a pattern straight into a port (`svf().cutoff(sine.range(300, 2400))`) makes a hidden macro driven the same way.

## Keys (modeled piano)

A track whose `instrument` is a piano family (`grand`, `upright`, `felt`, `honkytonk`, `prepared`) and which has a `keys` field plays dawg's modeled piano (`src/audio/keys/`): a felt hammer of the chosen hardness strikes a bank of stretched, inharmonic string modes (two or three detuned unison strings per key, with a fast first stage and a slow aftersound), a soundboard knock, dampers that stop a released key in about a second, and a small body EQ per family. The 0.5 sustain pedal (down, half, up) holds the dampers off. It is built in: nothing downloads and every render is byte-identical.

`piano` keeps two meanings on purpose. A project already stored as `instrument: "piano"` keeps the legacy tone forever. Every new write of the word (`piano`, `instrument piano`, `set_instrument piano`, the menu) stores `instrument: "grand"` with `keys: { preset: "grand" }`. `organ` stays the synth preset (the modeled organs are `tonewheel`, `combo` and `pipe`, below). The sampled Salamander grand is still in the browser under instruments.

Tuning: each key's first partial sits on the track's tuning (12-TET or any table, 19-EDO included; an unmapped degree is silent). By default the octaves are stretched from the strings' own inharmonicity, as a piano tuner would: low octaves are tuned between the 2:1 and 4:2 beats and the treble is beatless 2:1 to the stretched note below, so the octave from A3 to A4 beats under 1 Hz. `keys stretch 0` keeps every key exactly on the tuning. Bends and glides keep each string mode under the Nyquist limit (modes that would alias are muted), and each note fades over its last 250 ms so it ends inside the 8 s loop-tail window.

Polyphony is 64 voices; a new key steals the oldest released voice, then the oldest held one.

Prompt grammar (one undo step per command):

```text
piano                                    the modeled grand (also: grand)
piano ballad                             a preset: grand ballad upright felt lofi honkytonk prepared
upright | felt | honkytonk | prepared   the preset word alone
keys                                     list this track's piano settings
keys presets                             every preset with its styles
keys preset lofi                         load a preset (instrument, keys and its effects)
keys hardness 0.3 decay 1.5              any parameter
keys hardness off                        unset one parameter (back to the preset)
keys reset                               the family's own sound (keys: {})
automate keys-hardness points 0:0.2 8:0.8   automatable parameters have lanes
```

Presets: `grand` (concert grand, bright and long, three-string unisons), `ballad` (darker grand, softer hammer, more aftersound, plus a room reverb), `upright` (boxy, more inharmonic, shorter), `felt` (felt strip down, muted and intimate, audible mechanics, a small room), `lofi` (felt piano with tape wow, a 3.5 kHz low-pass filter and a 10-bit crush), `honkytonk` (16-cent unisons, bright saloon upright), `prepared` (bolts, rubber and screws on 60% of keys, seeded per key, so the same key always carries the same preparation). A preset is stored as `keys.preset`; its values are read at render, so overrides stay small. The effects a preset brings (`ballad`, `felt`, `lofi`) are ordinary track fields (`reverb`, `filter`, `fx.crush`) and stay editable; switching presets or `keys reset` removes them while they still hold the preset's values, and the same preset word in `song.ts` (`instrument: "lofi"`) brings the same effects. A bare `lofi` stays the kit and crush preset word; type `piano lofi`.

The menu has the pianos under **Ctrl-K › Sound › instruments › Keys**, and for a piano track a **Sound › keys** page and the simple rows (preset, hardness, decay, release, felt) on the **Sound** page. The agent's `set_keys` tool takes the same presets and names; `set_instrument` and `create_track` take the piano words. In the SDK: `track({ instrument: "grand", keys: { hardness: 0.3 } })`.

| Param        | Range                                 | Default            | Lane            | What it does                                                         |
| ------------ | ------------------------------------- | ------------------ | --------------- | -------------------------------------------------------------------- |
| **hardness** | 0..1                                  | 0.5                | `keys-hardness` | hammer felt hardness: brightness at a given velocity                 |
| **touch**    | 0..1                                  | 1                  | `keys-touch`    | velocity sensitivity (0 plays every note at 0.8)                     |
| **inharm**   | 0..4 x                                | 1 (upright 2.5)    |                 | inharmonicity multiplier (0 harmonic)                                |
| **unison**   | 0..30 cents                           | 0.7 (honkytonk 16) |                 | detune spread of the unison strings                                  |
| **decay**    | 0.1..4 x                              | 1 (upright 0.6)    | `keys-decay`    | sustain time multiplier                                              |
| **release**  | 0.1..4 x                              | 1                  | `keys-release`  | damper time multiplier (how fast a released key stops)               |
| **strike**   | 0.04..0.3                             | 0.12               |                 | hammer position along the string                                     |
| **after**    | 0..1                                  | 0.3                |                 | aftersound share (the slow second stage of the decay)                |
| **knock**    | 0..1                                  | 0.5                | `keys-knock`    | soundboard knock and hammer thump                                    |
| **noise**    | 0..1                                  | 0.25 (felt 0.6)    | `keys-noise`    | key-off and damper mechanics                                         |
| **felt**     | 0..1                                  | 0 (felt 1)         | `keys-felt`     | felt strip between hammers and strings                               |
| **prep**     | 0..1                                  | 0 (prepared 0.6)   |                 | share of keys carrying a preparation (seeded per key)                |
| **width**    | 0..1                                  | 0.6                |                 | keyboard stereo spread, bass left and treble right                   |
| **stretch**  | 0..1                                  | 1                  |                 | octave stretch from the strings' inharmonicity; 0 keeps tuning exact |
| **body**     | grand upright felt honkytonk prepared | the family's own   |                 | body EQ voicing                                                      |
| **vib**      | 0..64 Hz                              | 0                  |                 | pitch wobble rate (tape wow); note vibrato replaces it               |
| **vibmod**   | 0..24 semitones                       | 0.5                |                 | pitch wobble depth                                                   |
| **sym**      | 0..1                                  | 0                  |                 | sympathetic string resonance while the sustain pedal is down         |

Lanes are read at each note's onset. The model is dawg's own, from public literature (Fletcher's inharmonicity B·n² law, Railsback stretch, Weinreich's coupled unison strings and two-stage decay, Chaigne and Askenfelt's felt-hammer model, Bank's modal piano synthesis), with no sampled audio.

`sym` (0.6.1) adds a per-track bank of 36 tuned strings (C2..B4) that ring along with what you play while the sustain pedal is down, as the undamped strings of a real piano do. It costs nothing when `sym` is 0 or the track has no sustain pedal, and runs at half rate at 44.1 and 48 kHz.

### Soft pedal and sostenuto (0.6.1)

The modeled pianos have the other two pedals of a grand. Both are pedal lanes like the sustain pedal (`[{ tick, state }]`, at most 1024 events) and absent means today's sound:

- **Soft pedal** (`softPedal`, una corda, the left pedal): while it is down each note's hammer is shifted so it strikes fewer strings with a softer part of the felt: the unison narrows, the hammer's high partials are rolled off and the level drops about 3 dB, so the note is quieter and darker (a 10%+ lower spectral centroid and at least 3 dB less 2-4 kHz energy on middle C). `half` is half the shift. It is read at each note's onset, so a note struck before the pedal keeps its tone.
- **Sostenuto** (`sostenuto`, the middle pedal, `down` and `up` only): keys already held when it goes down keep their dampers up until it lifts; notes struck afterwards damp at their own release. A held key struck again while the pedal is down keeps ringing to the lift (the rod keeps its damper up), and a key still held through a lift is caught again by the next press. It works alongside the sustain pedal. Only the modeled pianos with a `keys` object hear the soft pedal; `pedal soft` says so on any other track.

```text
pedal soft 0-8                           una corda from beat 0 to 8 (also: down|half|up <beat>, bars, off)
pedal sost 0-4                           sostenuto down at 0, up at 4 (holds the keys down at 0)
pedal soft                               list the lane; pedal sost off clears it
```

Menu: **Sound › performance** has **soft pedal** and **sostenuto** rows (off, or held over every bar) on a modeled piano track. Agent: `set_piano_pedals` (`soft`, `sostenuto`: events, `"bars"` or null). SDK (1.26.0): `track({ instrument: "grand", softPedal: [[0, "down"], [8, "up"]], sostenuto: [[1, "down"], [4, "up"]] })`.

### Electric keys (0.6.1)

Three electric keyboard families on the same `keys` field, built in and byte-identical across renders:

- **epiano** (`rhodes`): a tine piano. Each hammer strikes a tine cantilever (three modes: the fundamental, the bell partial and the clang), read by an electromagnetic pickup whose nonlinear response is computed at 2x oversampling, so `bark` growls when played hard without aliasing (aliases of a hard-driven key 96 stay below -50 dB). `vibe` is the suitcase stereo vibrato: the left and right channels swap in antiphase at `vibehz`.
- **wurli** (`wurlitzer`): a reed piano with a capacitive pickup: nasal, with a growl on loud notes; `trem` is the built-in 5.6 Hz tremolo.
- **clav** (`clavinet`): struck strings read by neck and bridge pickups. `pickup` chooses `neck`, `bridge`, `both` or `out` (both, out of phase: thin and funky) and `mute` is the mute slider. Pickup positions vary slightly per track (seeded from the track id, so the same track always sounds the same). Releasing a key damps it with the yarn damper and a small release plunk.

Presets: `epiano` (stage tine piano), `suitcase` (with the stereo vibrato), `dyno` (bright, bell-heavy), `wurli`, `clav` (both pickups) and `funkclav` (pickups out of phase, mute up). The preset word alone loads it (`suitcase`, `funkclav`); `keys` stays the legacy word.

```text
epiano | wurli | clav                    the family (also rhodes wurlitzer clavinet)
epiano preset suitcase                   a preset: epiano suitcase dyno | wurli | clav funkclav
epiano vibe 0.6 bark 0.5                 any parameter of the family
clav pickup bridge mute 0.4
automate keys-vibe points 0:0 8:0.8      automatable parameters have lanes
```

| Param      | Families      | Range                | Default | Lane        | What it does                          |
| ---------- | ------------- | -------------------- | ------- | ----------- | ------------------------------------- |
| **bark**   | epiano, wurli | 0..1                 | 0.35    |             | pickup drive: growl when played hard  |
| **bell**   | epiano, wurli | 0..1                 | 0.5     |             | tine or reed bell ping                |
| **tone**   | all three     | 0..12000 Hz          | 0 (off) | `keys-tone` | output low-pass                       |
| **vibe**   | epiano        | 0..1                 | 0       | `keys-vibe` | suitcase stereo vibrato depth         |
| **vibehz** | epiano        | 0.5..12 Hz           | 4       |             | suitcase vibrato rate                 |
| **trem**   | wurli         | 0..1                 | 0       | `keys-trem` | tremolo depth at 5.6 Hz               |
| **pickup** | clav          | neck bridge both out | both    |             | pickup switch                         |
| **mute**   | clav          | 0..1                 | 0       |             | mute slider: damps the upper partials |

`hardness`, `touch`, `decay`, `release`, `width`, `vib` and `vibmod` apply to the electric families too. The menu has them under **Sound › instruments › Keys › Electric**, with their rows on the **Sound** page; the agent's `set_instrument` and `set_keys` take the same words; the SDK takes `track({ instrument: "epiano", keys: { vibe: 0.6 } })` or `track({ instrument: "suitcase" })`. The models are dawg's own, from public descriptions of the instruments (tine and tone-bar cantilever, electromagnetic and electrostatic pickups, the Clavinet's pickup switching), with no sampled audio.

### Organs (tonewheel, combo, pipe)

Three organ families run on the same keys engine (`src/audio/keys/organ.ts`) when the track's `instrument` is `tonewheel`, `combo` or `pipe` and it carries `keys`. `organ` stays the legacy sine preset and renders byte-identically; reach the engine with the verbs or presets below, or the aliases `hammond`, `b3`, `farfisa`, `church`, `pipeorgan`.

- **tonewheel**: 91 free-running tonewheels at the gear ratios of the classic organ, phase-locked to song time (a key opens a wheel already turning, so the same chord sounds the same wherever it lands and two keys sharing a wheel share its phase). Nine drawbars `16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1'` stored as nine digits 0-8 (`888000000`). Single-trigger percussion (2nd or 3rd harmonic, fast or slow) fires only when every key was up and, as on the original, mutes the 1' bar while it is on. Key click, a scanner vibrato/chorus (V1-V3, C1-C3), a preamp drive and a two-rotor rotary speaker (horn and drum, slow, fast or stop) whose rotors glide between speeds with their own inertia: about a second for the horn and several for the drum.
- **combo**: divider-style combo organ with five registers `16' 8' 4' 2⅔' 2'` (five digits), a flute, reed or bright voice and a vibrato.
- **pipe**: band-limited additive pipe ranks with chiff, wind unsteadiness and a tremulant. `stops` lists stop names (`subbass16 bourdon16 principal8 flute8 gedackt8 gamba8 celeste8 octave4 flute4 nazard fifteenth2 piccolo2 tierce larigot mixture trombone16 trumpet8 oboe8 krummhorn8`) or registrations (`plenum flutes cornet reeds strings full`). Each rank sits on the track's tuning (12-TET or a table such as 19-EDO); mutation and mixture ranks are tuned pure (quints 3·f, tierces 5·f) so they fuse with the foundation. Drawbar and rank footages are octaves of the table, so a 19-EDO organ keeps its octaves.

A row belongs to its family: `rotary fast` on a pipe organ or `keys drawbars` on a grand is refused with the families that read it, and `keys` on an organ lists its own rows. Single-trigger percussion is one envelope per track: every key struck together sounds it, and a key added while another is held gets the envelope's decayed level. Drive changes the tone at roughly steady loudness.

The scanner, drive and rotary run once per track after its voices (the keys per-track post hook), so chords share one rotor; in play mode the live synth keeps one per track and shares its wheel and rotor clock. Rotary and drive are lanes: `keys-rotary` (0 stop, 1 slow, 2 fast; the rotors spin up or down with inertia) and `keys-drive`.

```text
tonewheel                                the tonewheel organ (also: hammond, b3)
tonewheel 888800008                      the organ with those drawbars
gospel | jazzorgan                       tonewheel presets
combo | combo 08880 | farfisa | vox      the combo organ
pipe | pipe flutes | pipe principal8 octave4   the pipe organ with a registration or stops
flutes | cornet | reeds | celeste        pipe presets
tonewheel 888800008 perc 3rd             a verb takes more rows (combo 08880 flute)
rotary slow | fast | stop                the rotary speaker
rotary fast at 16                        switch it at beat 16 (a keys-rotary lane point)
keys drawbars 888000000                  any organ row (keys perc 3rd, keys scanner v2, keys stops plenum)
automate keys-rotary points 0:1 4:2      spin the rotor up at beat 4
```

Presets: `tonewheel` (888000000, scanner C3, slow rotary), `gospel` (888800008, 3rd percussion, fast rotary, driven), `jazzorgan` (888000000 with soft 3rd percussion), `combo` (reed registers 08800 with vibrato), `vox` (bright 08880), `pipe` (plenum in a church reverb), `flutes` (gedackt 8' and flute 4' with tremulant), `cornet`, `reeds`, `celeste` (gamba and celeste beating).

The menu has them under **Ctrl-K › Sound › instruments › Keys › Organs**; for an organ track the **Sound** page shows the preset, a **Drawbars** (tonewheel), **Registers** (combo) or **Stops** (pipe) sub-menu with one row per footage or stop, and the family's rows. The agent's `set_keys` takes `drawbars`, `registers`, `stops` and `rotary` next to `params`. In the SDK: `track({ instrument: "tonewheel", keys: { drawbars: "888800008", rotary: "fast" } })` or `keys: { stops: ["principal8", "octave4"] }`.

| Param         | Family          | Range                       | Default                               | Lane          | What it does                                   |
| ------------- | --------------- | --------------------------- | ------------------------------------- | ------------- | ---------------------------------------------- |
| **drawbars**  | tonewheel       | nine digits 0-8             | 888000000                             |               | drawbar registration, 16' to 1'                |
| **perc**      | tonewheel       | off 2nd 3rd                 | off                                   |               | single-trigger percussion; on mutes the 1' bar |
| **percdecay** | tonewheel       | fast slow                   | fast                                  |               | percussion decay (0.6 s or 1.8 s)              |
| **percvol**   | tonewheel       | normal soft                 | normal                                |               | soft: percussion 6 dB down, drawbars unmuted   |
| **click**     | tonewheel       | 0..1                        | 0.5                                   |               | key click                                      |
| **scanner**   | tonewheel       | off v1 v2 v3 c1 c2 c3       | c3                                    |               | scanner vibrato or chorus                      |
| **drive**     | tonewheel combo | 0..1                        | 0.15 (combo 0)                        | `keys-drive`  | preamp overdrive                               |
| **rotary**    | tonewheel combo | slow fast stop              | slow (combo stop)                     | `keys-rotary` | rotary speaker speed                           |
| **registers** | combo           | five digits 0-8             | 08800                                 |               | combo registers, 16' to 2'                     |
| **voice**     | combo           | flute reed bright           | reed                                  |               | register timbre                                |
| **stops**     | pipe            | stop names or registrations | principal8 octave4 fifteenth2 mixture |               | drawn stops                                    |
| **chiff**     | pipe            | 0..1                        | 0.4                                   |               | flue pipe attack noise                         |
| **wind**      | pipe            | 0..1                        | 0.3                                   |               | wind instability                               |
| **trem**      | pipe            | 0..1                        | 0                                     |               | tremulant depth                                |

The organ models are dawg's own, from public descriptions of the tonewheel generator (91 wheels, the 2:1 gearing per octave and its 1' foldback at the top), the scanner vibrato, the rotary speaker's horn and drum rotor speeds, and additive pipe-organ synthesis; no sampled audio.

## Samples

A track whose instrument is `sampler(...)` plays audio files instead of a synth. Voices live in `tracks/<slug>/samples/` and `src` is relative to the track directory (`samples/kick.wav`); a project-relative `tracks/<slug>/samples/kick.wav` works too.

```ts
// tracks/drums/track.ts
import { track, sampler, hits } from "dawg";

export default track({
  name: "drums",
  instrument: sampler({
    kick: "samples/kick.wav",
    hat: { src: "samples/hat.wav", choke: "hats", gain: 0.6 },
    open: { src: "samples/open.wav", choke: "hats" },
  }),
  notes: [
    ...hits("kick", [0, 1, 2, 3]),
    ...hits("hat", [0.5, 1.5]),
    ...hits("open", [3.5]),
  ],
});
```

Semantics follow Strudel's sampler:

| Strudel                                                 | dawg                                                       | Behavior                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `samples({ kick: "kick.wav" })`                         | `sampler({ kick: "samples/kick.wav" })`                    | one voice per name                                                                                                                               |
| `s("kick hat")`                                         | `hits("kick", …)`, `hit("hat", …)` (oneshot mode)          | voices take pitch slots 36, 37, … in name order; a hit plays the whole sample, whatever the note length                                          |
| `note("c4 e4").s("vox")`                                | `sampler({ vox: { src, root: "C4" } }, { mode: "keyed" })` | rate = 2^((pitch − root)/12); the note's length holds it, then a 10 ms release; several roots multi-sample                                       |
| `.begin(0.25)` / `.end(0.5)`                            | `begin: 0.25`, `end: 0.5`                                  | 0..1 fractions of the file                                                                                                                       |
| `.speed(2)` / `.speed(-1)`                              | `speed: 2` / `speed: -1`                                   | rate and pitch together; negative plays the window backwards                                                                                     |
| `.loop(1)`                                              | `loop: true`                                               | repeats begin..end (5 ms crossfade) for the note's length, oneshot or keyed                                                                      |
| `.cut(1)`                                               | `choke: "hats"`                                            | a new hit in the group stops the sounding voice with a 5 ms fade                                                                                 |
| `.gain(0.8)`                                            | `gain: 0.8`                                                | 0..2, times velocity and the track volume                                                                                                        |
| `.slice(8, …)` / `.chop(8)`                             | `slices("samples/break.wav", 8)`                           | eight voices with begin/end windows                                                                                                              |
| `.loopBegin(0.25)` / `.loopEnd(0.75)` (`loopb`/`loope`) | `loopBegin: 0.25`, `loopEnd: 0.75`                         | with `loop`, the first pass plays from `begin`, then repeats only loopBegin..loopEnd (file fractions inside the window)                          |
| `.clip(1)` / `.legato(1)`                               | `clip: 1`                                                  | the voice lasts note length × clip (then a 10 ms release), cutting a long oneshot                                                                |
| `.fit()`                                                | `fit: true`                                                | the window is stretched or squeezed (by rate, so pitch follows) to last the note                                                                 |
| `.unit("c")`                                            | `unit: "c"`, `speed: n`                                    | `speed` becomes a duration: the window lasts 1/n bars; `unit: "s"`: `speed` seconds                                                              |
| `.loopAt(2)`                                            | `speed: 0.5, unit: "c"` (`/sample set brk loopAt 2`)       | the window lasts 2 bars                                                                                                                          |
| `.accelerate(1)`                                        | `accelerate: 1`                                            | the rate ramps linearly by +1× over the voice (−8..8); a ramp that reaches rate 0 ends the voice                                                 |
| `.squiz(2)`                                             | `squiz: 2`                                                 | each zero-crossing cycle is replayed `squiz`× faster, raising pitch without shortening (1..32; implemented from the Tidal/SuperDirt description) |

`/sample set <voice> <control> <value>…` edits these on the focused sampler track (`/sample set brk fit on clip 1`, `/sample set hat cut hats`, `off` unsets one), each voice in the menu's Parameters section has the same controls, and the agent's `set_sample` tool takes them by name.

### Velocity layers and round robin (0.6.1)

Two optional voice fields borrowed from SFZ make a multisampled instrument:

| Field | Values                  | What it does                                                                                                                                                                                                                                                                                                               |
| ----- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vel` | `[lo, hi]`, MIDI 0..127 | the velocity range this voice plays (SFZ `lovel`/`hivel`). Keyed voices with the same root are layers: a note plays the one whose range holds its velocity. One-shot layers on a kit share a pad only through an `rr` group (below); a one-shot voice with `vel` and no `rr` keeps its own pad and plays at every velocity |
| `rr`  | group name              | round robin (SFZ `seq_length`): voices in a group with the same root and a matching layer take turns, A B A B, in note order, so a repeated hit never sounds machine-gunned                                                                                                                                                |

The picker chooses the layer by velocity first (when no layer of the group holds the velocity, the nearest layer plays), then the next voice in the group from a counter that starts at a turn seeded by the track id and the group, so renders stay deterministic but two tracks with the same samples do not alternate in lockstep. For a kit pad with soft and hard hits, put both voices in one group: `sample snare-soft vel 0-63 rr sn` and `sample snare-hard vel 64-127 rr sn`; either pad then plays the layer the velocity asks for. A note's velocity maps to MIDI as `round(velocity x 127)`; a boundary velocity belongs to the layer whose range contains it (`[0,63]` and `[64,127]` switch at 64). `/sample set snare1 vel 0-63 rr sn`, the menu's **Velocity layer** and **Round robin** rows on each voice, `set_sample {params: {vel: [64,127], rr: "sn"}}` and `sample("samples/sn1.wav", { vel: [0, 63], rr: "sn" })` set them; `off` clears. Voices without them play as before.

### Fitting samples to the song (0.6)

A voice can follow the song's time instead of its own rate. Give it its own tempo (`bpm`) or a length in beats (`len`), and pick how it changes time with `fitmode`:

| Field     | Values                                | What it does                                                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bpm`     | 20..400                               | the sample's own tempo: the window advances one source beat per song beat (times `abs(speed)`), through the tempo map, ramps and fermatas included; a 174 BPM break in a 128 BPM song plays 128/174 as fast                                                                                                                         |
| `len`     | beats, > 0                            | the window lasts `len` song beats through the tempo map                                                                                                                                                                                                                                                                             |
| `fitmode` | `repitch` (default), `beats`, `tones` | `repitch` is tape: speed and pitch move together. `beats` cuts the window at its onsets (SuperFlux, 30 ms minimum gap) and places each slice on its new time unstretched, so every hit stays sharp: drums, speech. `tones` time-stretches with a phase vocoder with identity phase locking and keeps the pitch: pads, loops, vocals |

How they combine with Strudel's controls and the 0.5 tempo map:

| Set                                                         | Window length                                                                | Pitch                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| none of them                                                | `speed`, `unit`, `fit`, `loopAt` as before                                   | moves with speed                        |
| `fit` + `fitmode beats/tones`                               | the note (fit wins over `bpm` and `len`)                                     | kept                                    |
| `bpm`                                                       | source beats ÷ `bpm` × song beats, following tempo changes                   | `repitch`: moves; `beats`/`tones`: kept |
| `len` (no `bpm`)                                            | `len` song beats, following tempo changes                                    | `repitch`: moves; `beats`/`tones`: kept |
| `speed` with `bpm`                                          | `abs(speed)` source beats per song beat (2 = double time); negative reverses | as above                                |
| `unit` with `bpm`/`len`                                     | ignored once fitted                                                          | —                                       |
| keyed root, `cents`, glide                                  | the fitted buffer is repitched on top: play the root to keep the time        | moves                                   |
| `loopBegin`/`loopEnd`, `clip`, `accelerate`, `squiz`, `cut` | apply to the fitted buffer                                                   | as before                               |

`fitmode beats` or `tones` needs `bpm`, `len` or `fit` (validation error otherwise). `/bpm 174`, `/len 16` and `/fitmode beats` act on the focused sampler voice (name it when the track has several: `/bpm 174 brk`; `off` unsets; song tempo stays the bare word `tempo <n>`, and a bare `bpm <n>` without the slash also sets the song tempo, so only `/bpm` sets the sample's); `/fitmode auto` suggests a mode from the sound (crest factor above 5 and more than 2 onsets a second fit as `beats`, the rest as `tones`). The menu's Sound section lists `bpm`, `fitmode` and `len` on each voice, the agent's `fit_sample` tool takes them, and the SDK is `sample("samples/amen.wav", { bpm: 174, fitmode: "beats" })`.

### Shift and fade (0.6.1)

`shift <semitones>` moves a sampler voice's pitch without changing its length (−24..24). It is a phase-vocoder stretch by 2^(st/12) followed by a band-limited read-back at that rate (identity phase locking, Laroche and Dolson 1999; the same idea as Strudel's `stretch`), cached like a fit and applied after any `fitmode`, so a fitted loop can also be transposed. By default the formants move with the pitch, like a tape; `shift 7 formant keep` (stored `formant: 0`) keeps them where they were, so a voice or a guitar keeps its body, and `formant <n>` moves them `n` semitones on their own. Formants are kept with an envelope drawn through the harmonic peaks (a cepstral true envelope, Röbel and Rodet 2005, where no peak stands): measured on voices from 110 to 330 Hz, ±7 and +12 st land within 1 cent and keep the first formant peak within 3%. Each frame keeps its energy through the correction, so keeping formants stays within 1.5 dB of the plain shift's level. `shift 0` clears the shift but keeps a formant move (`shift 0 formant 3` moves only the formants); `shift off` clears both.

`fade out 0.5` and `fade in 0.05` (Strudel `fadeTime` and `fadeInTime`, stored as `fadeTime` and `fadeInTime`, 0..2 s) shape a voice's start and end in place of the short default declick, and follow the fitted length when the voice is fitted. `fade off` clears both.

Both act on the focused sampler voice (`shift 7 vox` names one). The menu's sample rows (**Ctrl-K › Sound**) list Shift, Formant, Fade in and Fade out, the agent's `set_sample` tool takes `shift`, `formant`, `fadeTime` and `fadeInTime`, and the SDK writes `sample("samples/vox.wav", { shift: 7, formant: 0, fadeTime: 0.5 })`.

### Resample (0.6.1)

`resample <track>|orbit <n>|master [section <name>|bars a-b] [post] [grain] [as <id>]` renders one track, one orbit or the whole mix to `tracks/<slug>/samples/<name>.wav` through the same offline renderer as `dawg render`, pins its sha256 and adds a track that plays it: a one-shot sampler track with one note across the range, or with `grain` a granular track (the `cloud` preset) holding one note there. The source stays as it is; mute it to hear only the copy. The file ends 20 ms after the sound falls to digital silence, and a source that is silent over the range is refused with a receipt instead of adding a silent track. Like freezing and flattening in a DAW (Ableton's Resampling input, Bitwig's bounce in place), it turns a part into material you can chop, grain or shift.

- The render is pre-master (the song master is left out) unless `post` is given or the source is `master`. The same score always gives the same bytes, so the sha256 is stable.
- The new sampler voice plays the file at gain 2 with no fade in, so it reproduces the source stem within −60 dB.
- The voice records where it came from in `from: { source: "track:lead" | "orbit:2" | "master", section?, bars?, score }`, `score` being the sha256 of the score it was rendered from. It is informational; the renderer never reads it.
- Up to 600 s. `section` uses the song's sections; `bars 1-2` is 1-based and inclusive.

**Ctrl-K › Project › resample** lists each track, orbit and the mix with a `→ sampler` and `→ granular` row. The agent's `resample {source: track|orbit|master, trackId?, orbit?, section?, bars?, post?, grain?, as?}` tool does the same.

Fitted windows are computed once and kept in a 64 MB least-recently-used cache of the played window only. Only the frames a note can reach are fitted (a held keyed or clipped note fits its length plus the release; a one-shot or looped voice fits the whole window). Renders and exports always compute them; in play mode a fit up to 8 s (of source or output, whichever is longer) is computed on the spot (under 160 ms), and a longer one stays silent with "fitting" in the status line until it is ready ("fit ready" then), never at the wrong pitch. Audition previews fit synchronously.

Every voice starts and stops with a 1–3 ms fade, so cuts do not click. Without `bpm`, `len` or `fitmode` there is no time-stretch, as in Strudel's default. A sampler track goes through the same volume and pan automation, filter, delay and reverb as any other track and is a cached stem like any other; the stem's cache key includes each voice's sha256, so replacing a file re-renders it.

Decoding: WAV (PCM 16/24/32-bit integer and 32-bit float, any channel count and rate) and AIFF/AIFF-C (8/16/24/32-bit) decode natively, mixed to mono and resampled to the engine rate on the fly with linear interpolation. MP3, FLAC, Ogg, M4A and anything else decode through `ffmpeg` when it is on `PATH` (dawg never installs it); without it the voice is skipped with `<voice> · <path> · not WAV/AIFF and ffmpeg is not on PATH · convert it to WAV, or install ffmpeg (e.g. brew install ffmpeg) and reload`. Decoded PCM is cached at `.dawg/assets/<sha256>.pcm`, least recently used first out past 512 MiB. Files over 50 MiB or 10 minutes, paths that leave the project (including through a symlink), and more than 64 voices are rejected. A `sha256` that no longer matches the file is a warning and the file still plays. Problems appear as receipts in the TUI and on stderr from `dawg render`; the track renders without the missing voices and nothing crashes.

In the TUI, oneshot sampler tracks show one highway lane per voice, labeled by name; keyed tracks use the pitch axis. `/tracks` shows each sampler's sample count and how many failed to load. `/sample <path> [as <voice>]` adds a voice to the focused track: a file outside the track directory is copied into `tracks/<slug>/samples/`, the voice name defaults to the file name, and a focused synth track that already has notes gets a new `samples` track instead. Existing hits keep their voice when the new name shifts the slots. `/sample` alone lists the voices. The agent's `import_sample` media tool writes 48 kHz stereo WAVs to the same folder.

## Sample packs

dawg reads Strudel's sample-pack manifests, so the packs Strudel users know work here, without any Strudel code (Strudel is AGPL; dawg's loader in `src/audio/packs.ts` is written from the documented manifest format only). A manifest is JSON: `{"_base": "<url>/", "<sound>": ["a.wav", "b.wav"] | {"c4": "c4.wav"}}`. A list is a set of variations addressed `<sound>:<n>`; a note map is a keyed instrument. `github:<user>/<repo>[/<branch>]` means `https://raw.githubusercontent.com/<user>/<repo>/<branch or main>/strudel.json`, the rule Strudel documents. General MIDI soundfonts load from gleitz/midi-js-soundfonts' `names.json` and become keyed samplers with one zone per sampled note.

Fetching is lazy. Adding a pack fetches only its manifest. A sample file is fetched the first time a track uses it, decoded, and stored in the existing `.dawg/assets/<sha256>.pcm` cache (with a copy of the raw file in the pack cache), so a pack never lands in the repo or the npm package. Only HTTPS is accepted (loopback HTTP only under `DAWG_PACKS_ALLOW_LOOPBACK_HTTP=1`, for tests), URLs may not carry credentials, every fetch has a timeout, and files keep the same size and duration limits as local samples. Manifests and files are cached under `$XDG_CACHE_HOME/dawg/packs` (default `~/.cache/dawg/packs`; `DAWG_PACKS_DIR` overrides), so a pack sound used once plays offline afterwards.

A sampler voice references a pack sound as `pack:<pack>/<sound>[:<n>]`, like Strudel's `s("bd:3")`; banks follow Strudel's `bank("RolandTR909")` naming (`RolandTR909_bd`). When the sound is first used dawg pins it in the track: `{src: "pack:tidal-drum-machines/RolandTR909_bd", sha256, url, license}`. Renders load the pinned sha256, so they stay reproducible even if the pack changes upstream; a pin whose file no longer matches is reported, not silently replaced. This is an additive field set on `SampleRef`, and older documents decode unchanged.

```ts
instrument: sampler({
  kick: "pack:tidal-drum-machines/RolandTR909_bd",
  hat: "pack:vcsl/hihat:2",
}),
```

| Command                                                    | Does                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/pack` or `/pack list`                                    | the built-in catalog and your added packs, with licenses                                                                                                                                                                                                                                                                                                                                         |
| `/pack add <url \| github:user/repo[/branch]> [as <name>]` | register a manifest (fetches the manifest only)                                                                                                                                                                                                                                                                                                                                                  |
| `/pack info <name>`                                        | license, source, sound names                                                                                                                                                                                                                                                                                                                                                                     |
| `/pack remove <name>`                                      | forget an added pack (built-ins stay)                                                                                                                                                                                                                                                                                                                                                            |
| `/pack use <pack>/<sound>[:<n>] [as <voice>]`              | add one pack sound as a voice on the focused track                                                                                                                                                                                                                                                                                                                                               |
| `/pack cache [prune [<size>] \| clear]`                    | disk used by pack downloads and decoded audio against their caps; `prune` evicts down to the cap (or `<size>`, e.g. `500M`), `clear` evicts everything this project does not use                                                                                                                                                                                                                 |
| `/kit [<kit>]`                                             | with no name, one picker of every kit (synth kits first, then sample kits); a synth kit name (`syn808`, `syn909`, `acoustic`, `lofi`, `electro`, `trap`, `default`) sets the offline drum synth; a bank (`909`, `808`, `707`, `606`, `linn`, `lm1`, `dmx`, `cr78`, `uzu`, `dirt`, or any bank name like `RolandTR909`) turns the focused drum track into a sampler on it; `/kit list` lists both |

**Bank nicknames.** Strudel's REPL registers short names for the drum machines with `aliasBank("https://strudel.b-cdn.net/tidal-drum-machines-alias.json")`, a JSON map of bank → nickname (`{"RolandTR909": "TR909", "AkaiLinn": "Linn", "EmuSP12": "SP12", …}`, 66 entries). dawg ships a snapshot of that file (taken 2026-10-07) so nicknames work offline, and refreshes it whenever it fetches the `tidal-drum-machines` manifest. A nickname works wherever a bank does: `/kit TR909`, `/kit tr808`, `/pack use tidal-drum-machines/TR909`, `pack:tidal-drum-machines/TR909_bd` in `track.ts`, the agent's `use_sound`, and the menu's **Rhythm › kits › Strudel banks** list. Resolution order: a nickname in its exact case (`Linn` → `AkaiLinn`, as in Strudel), then dawg's short names (`909`, `linn` → `LinnDrum`, unchanged from before), then a bank name in any case, then a nickname in any case (`sp12` → `EmuSP12`), then a bank suffix. Pins always store the full bank name (`pack:tidal-drum-machines/RolandTR909_bd`), so documents never depend on alias data.

**Cache sizes.** Pack downloads (`~/.cache/dawg/packs/files/`, shared by every project) are capped at 2 GiB and decoded audio (`<project>/.dawg/assets/`) at 1 GiB per project; `DAWG_PACKS_CACHE_MAX` and `DAWG_ASSETS_CACHE_MAX` override them (`500M`, `4G`, or bytes). Both evict least recently used files first, and neither evicts a file the open project's score uses, even when that project alone is over the cap. An evicted pack file is fetched again from its pinned URL and checked against its pinned sha256 the next time it plays, so eviction only ever costs a download. Manifests are small and never evicted. Decoded samples also share a 512 MiB in-memory LRU per process.

Ctrl-K › Sound › instruments lists kits, instruments (the Salamander piano and `gm_*` soundfonts, Strudel naming), "use a sample" and sample packs. The agent has `list_packs`, `search_sounds {query}` and `use_sound {sound, track?, voice?}`. A pack sound plays from keyboard play mode like any sampler voice. `kitFromBank(bank)` in `src/audio/packs.ts` returns the voice map for a bank (kick, snare, hat, …) for other kit lists.

Every pack is fully supported, whatever its license; dawg records each sample's pack and license (or `none stated`) in the pinned voice. A render that uses pack sounds names the packs in the WAV's INFO comment and prints a `credits ·` line, and a project that uses a CC-BY or CC-BY-SA pack gets a `CREDITS.md` with the required attribution (dawg leaves a hand-written `CREDITS.md` alone).

Built-in catalog (manifests are the GitHub-raw equivalents of the files Strudel's REPL loads from its CDN; licenses read from each repository on 2026-10-07):

| Pack                  | Manifest                                                                                                           | Samples from                                                          | License                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------- |
| `tidal-drum-machines` | `https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json`                          | ritchse/tidal-drum-machines (684 sounds: TR-808, TR-909, LinnDrum, …) | none stated                   |
| `dirt-samples`        | `github:tidalcycles/dirt-samples` → `https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json` | tidalcycles/Dirt-Samples (219 sounds)                                 | none stated                   |
| `uzu-drumkit`         | `github:tidalcycles/uzu-drumkit`                                                                                   | tidalcycles/uzu-drumkit                                               | Unlicense                     |
| `vcsl`                | `https://raw.githubusercontent.com/felixroos/dough-samples/main/vcsl.json`                                         | sgossner/VCSL (fetched per file; the repo is ~4 GB)                   | CC0-1.0                       |
| `piano`               | `https://raw.githubusercontent.com/felixroos/dough-samples/main/piano.json`                                        | Salamander Grand Piano V3, Alexander Holm                             | CC-BY-3.0                     |
| `mridangam`           | `https://raw.githubusercontent.com/felixroos/dough-samples/main/mridangam.json`                                    | yaxu/mrid, Arthur Carabott 2022                                       | CC-BY-SA-4.0 (per its README) |
| `emu-sp12`            | `https://raw.githubusercontent.com/felixroos/dough-samples/main/EmuSP12.json`                                      | ritchse/tidal-drum-machines                                           | none stated                   |
| `gm`                  | `https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/names.json`                                                | FluidR3_GM via gleitz/midi-js-soundfonts (code MIT)                   | CC-BY-3.0                     |
| `gm-musyngkite`       | `https://gleitz.github.io/midi-js-soundfonts/MusyngKite/names.json`                                                | Musyng Kite via gleitz/midi-js-soundfonts                             | CC-BY-SA-3.0                  |

felixroos/dough-samples, the manifest host, has no license file. Strudel's own `gm_*` sounds come from a different soundfont set; dawg uses FluidR3_GM with the same names.

## Wavetable synth

`instrument: "wavetable"` turns a track into a wavetable oscillator. A wavetable is a stack of single-cycle frames; the position `wt` (0..1) scans across them, mixing neighbouring frames smoothly. Parameter names and meanings follow Strudel's documented controls (`packages/core/controls.mjs` JSDoc on strudel.cc); the oscillator in `src/audio/wavetable.ts` is dawg's own, written from those docs and the WAV format, with no Strudel code.

| Parameter                                    | Range          | Default           | Meaning                                                                   |
| -------------------------------------------- | -------------- | ----------------- | ------------------------------------------------------------------------- |
| `wt`                                         | 0..1           | 0                 | position in the table (automatable: `automate wt points 0:0 4:1`)         |
| `wtenv`                                      | -1..1          | 0                 | position envelope amount, added to `wt`                                   |
| `wtattack` `wtdecay` `wtsustain` `wtrelease` | s, s, 0..1, s  | 0.01, 0.1, 1, 0.1 | position envelope shape                                                   |
| `wtrate` `wtdepth`                           | 0..50 Hz, 0..1 | 0, 0              | sine LFO on the position                                                  |
| `warp` `warpmode`                            | 0..1, mode     | 0, `none`         | bends the read phase: `asym`, `bendp`, `bendm`, `bendmp`, `sync`, `quant` |
| `wtphaserand`                                | 0..1           | 0                 | start phase randomness, seeded per note so renders stay reproducible      |

Tables. Four built-ins are generated in code and work offline: `basic` (sine → triangle → saw → square), `pwm` (pulse 50% → 5%), `formant` (vowels a → e → i → o → u) and `harmonics` (1 → 32 harmonics). Strudel's `wt_` sounds come from the `uzu-wavetables` pack (`github:tidalcycles/uzu-wavetables`, Unlicense) through the normal pack path: `wt_digital:2` means `pack:uzu-wavetables/wt_digital:2`, fetched once, pinned by sha256 and cached like any pack sound. Any other pack sound works too. Frames follow the Serum/Vital WAV convention: a `clm ` chunk reading `<!>2048 …` gives the frame length; otherwise a file whose length is a multiple of 2048 samples is 2048-sample frames, and anything else is one single-cycle frame (the AKWF convention).

Band-limiting. Each frame is kept as its harmonic spectrum and rendered into one table per octave holding only the harmonics below Nyquist for that octave, so a high note never aliases. Tables are oversampled and read with 4-point Hermite interpolation. The arithmetic is plain float64 in a fixed order, so inline, worker and cold or warm cache renders are byte-identical (a renderer parity test checks it).

The wavetable is an oscillator of the synth voice (see [Synth](#synth)): a wavetable track also takes every `synth` parameter, so `attack`/`release`, the `lpf`/`lpenv` filter envelopes, `fm`, `unison`/`detune`/`spread`, `vib` and `penv` shape it as they shape a saw. The band-limit level follows the instantaneous pitch, so vibrato, pitch envelopes and detuned unison voices stay alias-free. Live play mode plays wavetable tracks.

```ts
instrument: wavetable("wt_digital:2", { wt: 0.3, wtenv: 0.5, wtdecay: 0.4, warp: 0.2, warpmode: "bendp" }),
```

| Command                                    | Does                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `/wt` · `/wt list`                         | the focused track's wavetable · built-in tables and the `wt_` sets                              |
| `/wt <table>`                              | make the focused track a wavetable track (`basic`, `wt_vgame:3`, `pack:…`, a project `vox.wav`) |
| `/wt <0..1>`                               | set the position                                                                                |
| `/wtenv`, `/wtattack` … `/wtphaserand <n>` | set one parameter; `/warpmode <mode>` sets the warp mode                                        |

The menu's **Parameters** section lists the table picker and every wavetable parameter for a wavetable track, and **Sounds** has a "wavetable synth" row. The agent's `set_wavetable` tool takes the same table names and parameters.

### Wavetables from audio

The agent's `make_wavetable` tool (`src/audio/wavetable-maker.ts`, `src/media/wavetable.ts`; `dawg media wavetable <file> <name>`) builds a table from any audio file in the project:

- **Region.** `start`/`end` in seconds, or automatic: the most stable tonal stretch of up to 2 s (high YIN clarity, steady pitch, enough level), else the loudest 2 s.
- **Method.** `slice` reads one pitch period at each frame's time (YIN-style pitch detection through the FFT), resamples it to 2048 samples with cubic interpolation and spreads the loop-point mismatch over the cycle so it does not click. `spectral` takes, for each frame, the source's magnitude around each harmonic of the reference pitch and uses a fixed phase per harmonic, so frames morph without phase cancellation; it suits vocals, pads and noise. `auto` (the default) picks `slice` when the region is clearly periodic.
- **Clean-up.** DC removed, fundamental rotated to start as a rising sine (so neighbouring frames line up), optional `smooth` across neighbours, and per-frame (default), whole-table or no normalisation to 0.98 peak.
- **Report.** The result gives the path, sha256, frame count, method, region, detected pitch and a short sweep description (spectral centroid per frame span, how smooth the morph is), and the `set_wavetable` call that plays it.

All arithmetic is float64 in a fixed order with no randomness, so the same input and options give the same bytes. Project tables live under `tracks/<slug>/wavetables/`; `/wt list` and the menu's table picker list them, `/wt vox.wav` (or a full `tracks/…` path) picks one for the focused track, and `track.ts` refers to it as `wavetable("./wavetables/vox.wav")`. A track that switches to another instrument keeps its table, written `wavetable: wavetable(...)` beside `instrument`, so switching back restores it. The score keeps the project path and its sha256; evaluation re-hashes it like sampler files. A file that changed since it was picked plays with a warning; a missing one is a load problem naming `make_wavetable`.

## Plucked strings

`instrument: "string"` with a `string` field plays a physical model of a plucked or struck string (`src/audio/strings/`): an extended Karplus-Strong loop (Jaffe and Smith 1983) tuned exactly with a first-order Thiran allpass, a one-pole loss designed from two decay times (Välimäki et al. 1996), an allpass dispersion cascade for stiff strings (Van Duyne and Smith 1994), a raised-cosine pluck shaped by the pluck-position comb, a modal body, a sympathetic string bank and seeded unison courses. Pitches come from the 0.5 tuning tables and pitch curves (bends, glides, cents), so a string track plays 19-EDO or just intonation and follows `bend`. Bare legacy words (`sitar`, `ebass`, `pluck`, `cello`) keep their old tone; the engine runs only when the track has a `string` field.

`string sitar`, or `instrument nylon` / `instrument koto` with the resolver words (`nylon`, `steel`, `harpsichord`, `koto` …; the bare words `sitar`, `ebass` and `pluck` keep their legacy voices), picks one of 22 presets, each a full parameter set frozen by a hash test:

| Preset                                  | Sound                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `nylon` `steel` `electric` `jangle`     | classical, steel-string, clean electric and electric 12-string guitars |
| `ebass` `slap` `upright` `motown`       | electric bass, slap, upright pizzicato, flatwound muted P-bass         |
| `sitar` `tanpura`                       | jawari buzz with taraf sympathetic strings; open-string drone          |
| `harpsichord` `lute` `harp`             | 8'+8' harpsichord (velocity-flat), gut lute courses, concert harp      |
| `oud` `setar` `tar` `santur` `dulcimer` | fretless oud, Persian setar and tar, santur and hammered dulcimer      |
| `koto` `banjo` `tres` `requinto`        | koto, 5-string banjo, Cuban tres, bachata requinto                     |

Preset aliases (after `string`): `classical` (nylon), `acoustic` and `guitar` (steel), `12string` (jangle), `bassguitar` and `fender` (ebass), `doublebass` (upright), `cembalo` (harpsichord), `hammered` (dulcimer), `sehtar` (setar).

| Parameter                  | Range                    | Meaning                                                                     |
| -------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `ring` (Strudel `decay`)   | 0.05..60 s               | how long a note rings: the fundamental's T60 at C4                          |
| `track`                    | 0..1.5                   | higher notes ring shorter: T60 x (f/C4)^-track                              |
| `damp` `bright`            | 0..1                     | high-frequency loss; excitation brightness at full velocity                 |
| `pos`                      | 0.02..0.5                | pluck position from the bridge (0.5 round, 0.04 nasal)                      |
| `exciter`                  | pick finger hammer noise | how the string is set in motion                                             |
| `mute`                     | 0..1                     | palm mute (staccato and ghost articulations damp the same way)              |
| `buzz` (`jawari`)          | 0..1                     | bridge buzz: a zero-mean, energy-preserving bridge allpass, pitch-locked    |
| `stiff`                    | 0..1                     | inharmonicity B = 1e-6 x 400^stiff                                          |
| `body` `size`              | type, 0.25..5            | body resonance (`guitar`, `gourd`, `board`, `skin`, `bass` …) and its scale |
| `sym` `symtune`            | 0..1, mode               | sympathetic strings, tuned to the song `scale`, `open` strings or a `drone` |
| `unison` `detune` `spread` | 1..8, 0..1, 0..1         | strings per course, their detune and stereo spread                          |
| `oct` `octbelow`           | 0..1, key                | octave strings (12-string, harpsichord 4'), only below a key                |
| `vel` `pickup` `noise`     | 0..1                     | velocity sensitivity, magnetic pickup position, excitation noise            |
| `vib` `vibmod` `vibdelay`  | Hz, st, s                | preset vibrato (a note's own vibrato wins)                                  |
| `release` `voices` `gain`  | s, 1..32, 0..2           | damping after note-off, polyphony cap, level                                |

Sympathetic strings follow the song key's own scale, so `key C bhairav` tunes the taraf to Bhairav (shuddha Ni, komal Re and Dha) and a maqam key keeps its quarter tones. The `drone` tuning is Sa-Pa-Sa, or Sa-Ma-Sa (tivra Ma when the scale has it, else Sa-Ni-Sa) in a raga without Pa such as Marwa. Changing the key re-renders a string track's stem.

`ring`, `damp`, `pos`, `bright`, `mute`, `buzz`, `vib`, `vibmod` and `gain` automate as `string-<param>` lanes (`automate string-buzz points 0:0 4:0.8`). Measured on the renderer, on one string with the body and sympathetic strings off: every fifth key within 0.1 cent of the tuning table (sitar with buzz within 1 cent above C4). With the preset defaults a unison course (the harpsichord's 8'+8') is tuned around the table pitch and beats, and the sitar's sympathetic strings ring with the played note, so a single-peak pitch reading of the whole sound can drift a few cents; a course's tuning belongs to its key, so every strike of a key beats the same way and the harpsichord's level stays within 0.5 dB across velocities. Also measured: the fundamental's decay within 10% of `ring` at every fifth key, a C-major triad at velocity 0.8 near -6 dBFS for every preset, and under 20 ms of render per voice-second.

```ts
instrument: stringed("sitar", { buzz: 0.8, sym: 0.5 }),
```

| Command                                    | Does                                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `string` · `string presets`                | the focused track's preset and overrides · the preset list        |
| `string <preset>`                          | make the focused track that string instrument                     |
| `string <param> <value> [<param> <value>]` | override parameters (`string buzz 0.8 sym 0.5`, `string decay 6`) |
| `string <param> off` · `string reset`      | back to the preset's value · drop every override                  |
| `string off`                               | back to the legacy `pluck` voice                                  |

The menu has the presets under Sound › instruments › Strings and every string parameter on the Sound page of a string track (left/right adjust, `x` resets, space auditions with staged A/B). The agent's `set_string {trackId?, preset?, params?, reset?, off?}` runs the same command. SDK 1.21.0: `stringed(preset, params)` as a track's `instrument`, or `track({ instrument: "string", string: { preset: "koto", ring: 4 } })`; the printer writes `stringed(...)` back.

### Bowed strings

`exciter: "bow"` (0.6.1) drives the same string with a bow instead of a pluck: a bowed waveguide after the STK `Bowed` model (Smith; Cook and Scavone), with a friction table whose slope follows bow force and a bridge reflection through the string loss, so the string sticks and slips in Helmholtz motion. A Schelleng guard keeps every setting playable: bow force maps inside the measured minimum and maximum for the note's pitch and bow position (Schelleng 1973), so `pressure 0` is a breathy flautando and `pressure 1` a gritty but still pitched sound, never a squeal or silence; strings with periods under 24 samples run 2x oversampled, and a pitch lock keeps the note within 1 cent from G3 to C7 at 22.05 and 48 kHz. The `violin` body adds the main air and wood resonances (A0, CBR, B1-, B1+ and the bridge hill).

`bowed` plays the cello preset; `bowed <preset>` (or `string <preset>`) picks one of 13 bowed presets appended to the table (35 in all):

| Preset                                     | Sound                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `violin` `viola` `cello` `contrabass`      | solo orchestral strings                                                   |
| `fiddle` `erhu` `kamancheh` (`kemence`)    | folk fiddle, erhu (skin body, wide vibrato), Persian spike fiddle         |
| `violins` `violas` `cellos` `contrabasses` | sections: seeded unison players with their own detune, vibrato and spread |
| `pizz` (`pizzicato`) · `trem` (`tremolo`)  | plucked violin section · tremolo section                                  |

The words `violin`, `viola`, `fiddle`, `erhu`, `kamancheh`, `violins`, `violas`, `cellos`, `contrabasses` and `bowed-cello` switch a track to these presets. The bare legacy words `cello`, `contrabass` and `strings` keep their pre-0.6.1 voices byte-identically; reach the bowed cello with `bowed cello`, `string cello`, `instrument bowed-cello`, `set_string {preset: "cello"}` or `stringed({ preset: "cello" })`.

| Parameter                 | Range      | Meaning                                                                     |
| ------------------------- | ---------- | --------------------------------------------------------------------------- |
| `pressure`                | 0..1       | bow force inside the playable range: flautando at 0, gritty at 1            |
| `speed`                   | 0..1       | bow speed at full dynamics (loudness)                                       |
| `attack`                  | 0.005..4 s | bow-speed ramp at the start of a stroke (swells)                            |
| `vib` `vibmod` `vibdelay` | Hz, st, s  | vibrato rate, depth and onset delay (a note's own vibrato wins)             |
| `tremhz`                  | 0..16 Hz   | tremolo bowing: rapid strokes per second (0 off)                            |
| `sord`                    | 0..1       | con sordino: the practice mute, darker and softer                           |
| `dyn` (`expression`)      | 0..1       | dynamics on top of velocity (like MIDI CC11): drives bow speed and pressure |

Phrasing. A true legato is a slur: a single note that starts while the previous single note is held and that note lets go within a 64th note or 150 ms, or a note with the `legato` articulation. The string retunes within 5-10 ms and keeps the bow, with no new attack (four slurred notes are one onset); the bow point and loss follow the new pitch, so slurs up to two octaves land within a cent at a fresh note's level, and wider leaps start a new stroke. A note held under a moving line (a pedal) keeps sounding. Chords and double stops start new strokes. Velocity sets the stroke's dynamics and presses harder (pressure + 0.3 x (velocity - 0.5)); `staccato` and `ghost` are detache strokes (attack 10 ms, release 30 ms), and `accent` and `marcato` bite (pressure +0.2 for the first 80 ms). Section presets seed each player's vibrato rate (x0.92-1.08), depth (x0.8-1.2) and phase, and start players up to 25 ms apart (the first stays on the grid). `pressure`, `speed`, `sord` and `dyn` automate as `string-<param>` lanes, read every 32 samples, so `automate string-dyn points 0:0.2 4:1` is a crescendo inside held notes; `string-pos` sets each note's bow point (sul ponticello near 0.05, sul tasto near 0.4). Play mode caps a section at two unison players and sounds the first 0.75 s at once, the rest following in the background; renders use every player.

Measured: tuning within 1 cent to C7 at 22.05 and 48 kHz; 0 of 1296 pressure/speed/position/pitch settings leave Helmholtz motion; the free string after the bow lifts decays within 10% of `ring`; ff is at least 1.15x brighter (spectral centroid) than pp; 8 s of `violins` in play mode renders in under 40 ms.

| Command                                      | Does                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| `bowed` · `bowed <preset>` · `bowed presets` | the cello · a bowed preset · the bowed presets          |
| `bowed <param> <value> …`                    | the same as `string <param> <value> …` (`bowed sord 1`) |

The menu lists them under **Sound › instruments › Strings › Bowed**, and the **Sound** page on a bowed track shows `pressure speed vib sord dyn bright ring body` first (the rest under advanced). SDK 1.31.0: `stringed("violin", { pressure: 0.7 })` or `stringed({ preset: "cello", sord: 1 })`.

## Patch commands

`patch …` edits the focused track's modular patch (with `--fx <name>`, one of its effect patches); every line is one undo step, sent as node, cable and macro operations so two panes editing different cables both keep their change. `patch new <name> [instrument|effect] [from <preset>]` starts one (`patch convert` turns the track's current instrument into an equivalent patch), `patch load <name>` points the track at a project, user or built-in library patch (`acid-bass`, `pluck-ks`, `fm-bell`, `wobble`, …) and `patch detach` makes it an editable copy. Then `patch add <type> [as <id>] [k=v …]`, `patch set <id> k=v …`, `patch rm <id>`, `patch wire <node.port> <node.port> [amount]` and `patch unwire <a> <b>` build the graph; `patch macro <id> <node.port>[:min..max] … [range a..b] [default v] [label "…"]` maps a knob (the first four are knobs 1-4, set with `patch knob <id> <value>`), and `patch rate <id> global|voice` pins a node's rate. Errors name the port and the nearest word (`no port cutof on svf · did you mean cutoff?`), and nothing applies. Receipts say what changed rate (`; vcf now voice-rate`) and warn about cables the compiler drops (a per-voice signal into a global node, a loop with no buffer node). `patch show` prints the patch as the `patch …` lines that rebuild it, `patch nodes [family]` lists the node types and their ports, `patch show <built-in>` prints a library recipe, `patch save <name>` copies it into the project library, `patch save <name> --user` writes it to your user library (`$XDG_DATA_HOME/dawg/patches`, with the knob settings) and `patch load github:<user>/<repo>/<name>` fetches a pack patch pinned by hash. The agent edits patches with the `patch_edit` tool (ops in order, one bad op rejects the batch), and show-me types the same lines.

## Granular

`instrument: "granular"` plays a track's sound as a cloud of short grains. A read head moves through a source; every few milliseconds a grain (a windowed slice, repitched to the note) starts at the head plus a little random spray. It is the classic asynchronous granular model (Roads, _Microsound_; Granulator II, Mutable Clouds), with Strudel-style short names. Everything renders offline and deterministically: grains draw from the counter-based generator in `src/audio/dsp/rng.ts`, keyed on (`seed`, track, pitch, start tick, occurrence), so the same project gives the same bytes and a repeated note varies the way a real cloud does.

Sources. With nothing loaded a granular track grains a built-in synth render (`synth:pad` at C4, made into a held, seamless loop of its sustained part so a long note never falls into silence), so `grain cloud` sounds at once. `src` takes any synth preset or sound (`synth:bell`, `synth:supersaw@48`, `synth:pad@c3`; a sound plays with the track's own `synth` params, and `grain on` after `synth preset pad` grains `synth:pad`), or a sample: on a sampler track `grain on` (or `grain on voice vox`) grains that voice, pinned by sha256 like the sampler file, and the track keeps its sampler so `grain off` goes back. A missing source is a sample load problem in `/tracks`, never a silent track. `root` is the note that plays the source at its own pitch (a MIDI number or a note name: `grain root c4`). `grain off` returns to the voice the track had when granular turned on (stored as `granular.from`).

Presets (each is a few overrides over the defaults; `microloop`, `sparkle` and `backwards` come into their own on a resampled phrase, and are textures on a synth source):

| preset      | sound                                                |
| ----------- | ---------------------------------------------------- |
| `cloud`     | slow-scanning soft cloud, wide (the `granular` word) |
| `hold`      | held, shimmering sustain of one moment               |
| `sparkle`   | octave-and-fifth sparkle over a slow scan            |
| `swarm`     | dense, detuned, fully wide                           |
| `stutter`   | dry 45 ms repeats that latch and follow the music    |
| `microloop` | tight looping grains that slowly advance             |
| `backwards` | backwards swells                                     |
| `dust`      | sparse random crackles across the source             |

Parameters: `begin`/`end` (the region, 0..1), `pos` (head start), `scan` (head speed, 1 = the source's own speed, 0 held, negative backwards), `grain` (s, 5 ms..2 s), `overlap` (grains sounding at once; density = overlap / grain), `jitter` (onset randomness), `spray` (s of read offset), `pitch` and `detune` (semitones), `shimmer` and `shimint` (chance a grain plays an interval up, 12 by default), `spread` (stereo), `window` (`hann tukey gauss tri perc rperc`), `reverse` (chance a grain plays backwards), `freeze`, `repeat` and `hold` (beat-repeat latches), `drift` and `drate` (a slow random walk of the head), `attack`, `release`, `veltone`, `gain`, `seed` and `root`. After a note ends the grains keep coming while the voice fades over `release`, and the note rings for `release + 1.5 × grain` (at most 10 s). `hold` is both a preset (`grain hold`) and a parameter (`grain hold 4`). Past 16 voices the oldest released voice is stolen first, then the oldest held one.

Quality and cost. Grains read a shared semitone-level band-limited bank (`src/audio/dsp/bank.ts`: windowed-sinc levels built on demand in 4096-frame Float32 chunks, a 64 MB LRU, the level re-picked every 32 frames), so upward shifts and shimmer do not alias. Pitch is exact to within 1 cent across C1..C8 and in other tunings; a cold note-on renders its first block in under 10 ms and the densest preset costs at most 7 ms per voice-second at 48 kHz, so play mode and the audition loop stay live.

| Command                                   | What it does                                                        |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `grain` · `grain presets`                 | the focused track's granular settings with values · the presets     |
| `grain <preset>`                          | make the focused track a grain cloud of its own sound with a preset |
| `grain on [voice V]` · `grain off`        | grain this track's sound (a sampler voice) · back to its voice      |
| `grain src synth:<name>[@note]`           | a built-in synth source                                             |
| `grain src voice <V>`                     | one of this track's sampler voices as source                        |
| `grain <param> <value> …` · `grain reset` | override parameters (`off` unsets one) · drop the overrides         |
| `track cloud` · `track hold-2`            | a new granular track named after a preset                           |
| `track pad grain swarm`                   | focus or create a track and grain it in one step                    |

**Ctrl-K › Sound › granular**: it edits the preset, source and every parameter of a granular track (on any other pitched track the same row reads `grain this track's synth` and offers `grain on` and the presets); **Ctrl-K › Sound › instruments › Granular** lists the presets. `grain` edits stage in the audition loop, so space plays them and `a` compares A/B. The agent's `set_granular {trackId, preset?, src?, voice?, params?, reset?, off?}` tool takes the same names, and the SDK writes:

```ts
instrument: granular("cloud", { scan: 0.1, seed: 7 }),
instrument: granular({ src: "synth:bell@72", grain: 0.08, shimmer: 0.3 }),
instrument: granular("hold", { src: "samples/choir.wav", root: "A3" }),
```

### Grain play (0.6.1)

Four optional parameters make a granular track playable like an instrument rather than a texture. Each is absent by default, and absent renders byte-identically to 0.6.0.

| Parameter | Values (default)                                                                               | What it does                                                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`    | `off` `1/64` `1/32` `1/16t` `1/16` `1/16d` `1/8t` `1/8` `1/8d` `1/4t` `1/4` `1/4d` `1/2` `1/1` | Grains start on a note-value grid that follows the song's tempo map (ramps included), as Ableton Granulator II and Output Portal sync their grain rate. `grain` still sets each grain's length; `overlap` is ignored. `jitter` moves onsets off the grid by up to a fraction of a step. Measured within 1 ms of 117.19 ms per 1/16 at 128 BPM.           |
| `quant`   | `off` `scale` `chord`                                                                          | Snaps each grain's pitch offset (`pitch`, `detune`, `shimmer`) to the nearest pitch of the song key's scale, or of the pitch classes sounding on the song's other pitched tracks at that grain's onset, falling back to the scale when nothing sounds (scale quantize, as on Output Portal and Bitwig's Sampler). The played note itself is never moved. |
| `mono`    | `on` `off` (off)                                                                               | One voice: a note that starts before the previous one ends (legato) retargets that voice's pitch and keeps its grain stream and head, so a melody glides through one cloud; a detached note starts a new voice and cuts the old one's tail.                                                                                                              |
| `pedal`   | `on` `off` (off)                                                                               | The track's sustain pedal freezes the head while it is down (the cloud keeps playing the same spot), as on Mutable Clouds' freeze and the Hologram Microcosm hold.                                                                                                                                                                                       |

`grain sync 1/16`, `grain quant scale`, `grain mono on` and `grain pedal on` set them (`off` unsets); **Sound › granular** lists them as rows, `set_granular` takes them in `params`, and the SDK writes `granular("cloud", { sync: "1/16", quant: "scale", mono: true })`.

Lanes: every numeric parameter that moves well over time has a `grain-<param>` automation lane: `grain-pos`, `grain-scan`, `grain-grain`, `grain-overlap`, `grain-jitter`, `grain-spray`, `grain-pitch`, `grain-detune`, `grain-shimmer`, `grain-spread`, `grain-reverse`, `grain-repeat` and `grain-drift`. A lane replaces the parameter's value while it has points (`automate grain-pos points 0:0.1 8:0.9` sweeps the head across the source), is read every 32 frames, and latches per grain at its onset, so a block render equals a whole render. They are in **Mix**'s lane picker on granular tracks and stored in `track.fxAutomation` like the effect lanes.

## Mallets and bells (modal)

`instrument: "modal"` plays struck bars, tines, bells, bowls and drums on a modal resonator bank (`src/audio/dsp/modal.ts`, `src/audio/resonators.ts`): each note excites a table of measured mode ratios through a mallet pulse, each mode rings as a two-pole resonator with its own decay, and the strike point weights the modes the way it does on a real bar (the node at the center of a marimba bar mutes the second mode). It is dawg's own engine, ported from the reviewed 0.6 prototype.

Presets (a word picks one): `marimba` `vibes` `xylophone` `glock` `celesta` `chimes` `kalimba` `mbira` `steelpan` `bowl` `gong` `timpani`; aliases `vibraphone`, `glockenspiel`, `tubular`, `thumbpiano`, `gongageng`, `steeldrum`, `singingbowl`, `kettledrum` and `tubularbells`. `instrument vibes` (or any preset word) switches the focused track. Plain `marimba` with no `modal` field keeps the pre-0.6 marimba voice byte-identical, so old projects sound the same; use `modal marimba` for the modal one (the `instrument marimba` receipt says so). One-shot renders let a modal tail ring up to 30 s (bowls and gongs ring out instead of stopping at the 8 s loop-fold cap). `dawg check` warns about tracks still on the legacy `marimba`, `modal` or `wind` words.

| Parameter                  | Range              | Meaning                                                                           |
| -------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `mallet`                   | yarn … brass       | `yarn` `cord` `rubber` `plastic` `brass`; sets `hardness`                         |
| `hardness`                 | 0..1               | mallet hardness: soft rounds off the high modes, hard adds them; velocity adds    |
| `position`                 | 0..1               | strike point: 0 the end or edge, 0.5 the center                                   |
| `ring`                     | 0.05..30 s (log)   | ring time (T60) at middle C                                                       |
| `tilt`                     | 0..2               | how much faster high modes and high notes decay                                   |
| `damp` `release`           | 0..1, 0.005..2 s   | damping at note-off (0 rings on, 1 chokes) and the choke time; the pedal lifts it |
| `motor` `motordepth`       | 0..12 Hz, 0..1     | vibraphone motor tremolo                                                          |
| `ombak`                    | 0..12 Hz           | paired-instrument beating (gamelan)                                               |
| `buzz` `click`             | 0..1               | mbira bottle-cap buzz, mallet contact click                                       |
| `strikebend` `strikedecay` | ±24 st, 0.001..2 s | the pitch glide at the strike (timpani); Strudel `penv`/`pdecay`                  |
| `gain`                     | 0..2               | level                                                                             |

`hardness`, `position`, `ring`, `tilt`, `damp`, `motordepth`, `buzz`, `click` and `gain` have `modal-<param>` automation lanes, read at each note's onset. Notes honour the track or song tuning, note `cents`, bends, articulation (accents strike harder, staccato damps), the sustain pedal (holds dampers off), velocity curves, humanize and the tempo map. Up to 32 voices ring at once (the oldest is stolen with a short fade); tails ring up to 30 s and stop early once silent. Rendering is seeded and float64 in a fixed order, so renders are byte-identical across runs and workers.

```ts
instrument: modal("vibes", { motor: 4, hardness: 0.6 }),
instrument: modal("marimba", { mallet: "rubber", ring: 2 }),
```

| Command                                  | Does                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `modal` · `modal presets` (`modal list`) | the focused track's preset and overrides · every preset    |
| `modal <preset>` · `modal preset <name>` | make the focused track a modal track with that preset      |
| `modal mallet <name>`                    | pick a mallet (sets hardness; the later of the two wins)   |
| `modal <body>`                           | set the body (`modal saron`, `modal kempul`): `modal body` |
| `modal <param> <value> …`                | set parameters (`modal ring 3 hardness 0.7`); `off` clears |
| `modal reset`                            | clear overrides, keep the preset                           |
| `modal off`                              | leave the engine for the legacy marimba voice              |

The menu's **Sound › instruments › Mallets and bells** lists the presets, and the **Sound** page shows the preset, mallet, the simple parameters and an **advanced** group on a modal track. The agent's `set_modal {trackId, preset?, mallet?, params?, reset?}` tool takes the same names.

### Gamelan (0.6.1)

The modal engine also plays Javanese and Balinese bronzes, small bells and frame drums: `saron` `demung` `slenthem` `gangsa` `gender` `bonang` `kenong` `kethuk` `kempul`, the bells `crotales` `musicbox` `toypiano`, and the drums `daf` `bodhran` `tabla` (aliases `crotale`, `musicalbox`, `framedrum`). `modal gamelan` lists them; the menu has them under **Ctrl-K › Sound › instruments › Mallets and bells** (Gamelan). Gamelan is tuned in slendro or pelog, not 12-TET, so pair the presets with `tuning slendro` or `tuning pelog` (the 0.5 tuning tables).

Balinese instruments come in pairs: the pengumbang is tuned low and the pengisep a few hertz high, so a unison beats (_ombak_, "wave") at that difference, typically 5 to 8 Hz. `modal pair <track>` makes the focused track the pengisep of the named partner: it sounds `ombak` Hz above it (gangsa's 7 Hz by default), the partner plays one voice at its own pitch, and the two together beat at exactly `ombak` Hz instead of each track beating on its own. `modal pair off` undoes it. `modal ombak 6` or `modal pair t2` on a track that is not modal yet starts it as a `gangsa`. In the SDK: `modal("gangsa", { ombak: 6, pair: "pengumbang" })`.

Live, an undamped bar (`damp 0`: gongs, kempul, bowls) keeps ringing after you release the key in play mode and the audition loop: up to 32 ringing voices, the oldest faded over 250 ms, and the loop's fold fades a tail that would outlast it the same way. The 15 presets are appended to the table (existing ones unchanged), and `RESONATOR_TABLE_VERSION` is 2, so stems re-render once.

## Winds and brass (wind engine)

`instrument: "wind"` with a `wind` field plays blown instruments on breath-driven digital waveguides (`src/audio/winds/`): a bore delay line tuned exactly with a Thiran allpass, closed by a reed table (clarinet), a conical reed (saxophones, oboe, bassoon), an air jet (flutes) or a lip resonator (brass), with loss and bell filters, breath noise and a breath envelope. Reed and jet run at 2x with first-order antiderivative antialiasing (`src/audio/dsp/shape.ts`, `oversample.ts`); each preset carries per-semitone pitch and level trims for 22.05, 44.1 and 48 kHz, generated by `bun scripts/calibrate-winds.ts`, so every preset plays within 3 cents across its range. It is dawg's own model, after Smith's digital waveguides, Cook's STK reed and jet models and Välimäki's fractional-delay filters, ported from the reviewed 0.6 prototype; no samples.

Presets (a word picks one): flutes `flute` `recorder` `whistle` `ney` `shakuhachi` `panpipe` `suling` `bansuri`; reeds `clarinet` `bassclarinet` `oboe` `bassoon`; saxophones `sax` (tenor) `altosax` `barisax`; brass `trumpet` `harmon` `plunger` `trombone` `tuba` `horn`. Aliases: `tinwhistle` `pennywhistle` `nay` `panflute` `panpipes` `saxophone` `tenorsax` `tenor` `alto` `bari` `baritonesax` `frenchhorn` `mutedtrumpet` `wahtrumpet`. `instrument flute` (or any preset word) switches the focused track. The bare legacy word `wind` with no `wind` field keeps its pre-0.6 tone byte-identically; `wind flute` gives the engine. `presets wind` (or `wind presets`) lists them; the menu has them under **Sound › instruments › Winds and brass**, and the **Sound** page shows the simple rows `breath` `bright` `mute` `players` `growl` with the rest under advanced.

| Parameter          | Range                            | Meaning                                                                       |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------- |
| `model`            | jet reed sax lips                | exciter and bore (set by the preset)                                          |
| `breath`           | 0..1                             | blowing pressure: louder and fuller; too little and a reed does not speak     |
| `noise`            | 0..1                             | breath noise                                                                  |
| `attack` `release` | 0.001..2 s, 0.005..2 s           | breath rise and fall; Strudel `att`/`rel`                                     |
| `vib` `vibmod`     | 0..12 Hz, 0..1 st                | vibrato rate and depth                                                        |
| `reed`             | 0..1                             | reed stiffness, jet offset or lip tension                                     |
| `bright`           | 0..1                             | bore loss: dark to bright                                                     |
| `stopped`          | on/off                           | stopped pipe, odd harmonics (jet only: panpipe)                               |
| `mute`             | open straight cup harmon plunger | brass mute                                                                    |
| `wah` `wahenv`     | 0..1                             | plunger opening, and how much it opens with each note (doo-wah)               |
| `growl` `flutter`  | 0..1                             | hum into the horn, flutter tongue                                             |
| `players`          | 1..8                             | section size: extra players double the chord tones, slightly detuned and late |
| `gain`             | 0..2                             | level                                                                         |

`breath`, `noise`, `wah`, `growl` and `flutter` have `wind-<param>` automation lanes, read continuously, so a breath lane swells a held note. A single line slurs by default: a lone note that starts under (or right at the end of) a lone held note continues the same breath with a legato pitch change (a track `glide` setting, a `staccato` note or a bend tongues it instead); chords sound as separate voices. Velocity brightens the tone (brass the most, flutes the least), accents and marcato blow harder, and notes honour tuning, `cents`, bends, humanize and the tempo map. Up to 24 voices sound at once; the oldest is stolen with an 80 ms fade.

```ts
instrument: "flute",
instrument: wind("trumpet", { mute: "harmon", players: 3 }),
instrument: wind("sax", { breath: 0.8, growl: 0.3 }),
```

| Command                                  | What it does                                                    |
| ---------------------------------------- | --------------------------------------------------------------- |
| `wind` · `wind presets` · `presets wind` | the focused track's preset and overrides · every preset         |
| `wind <preset>`                          | make the focused track a wind track with that preset            |
| `wind <param> <value> …`                 | set parameters (`wind breath 0.8 players 3`); `off` clears one  |
| `wind mute <name>`                       | `open` `straight` `cup` `harmon` `plunger`                      |
| `wind reset` · `wind off`                | clear overrides, keep the preset · back to the legacy wind tone |

The agent's `set_wind {trackId, preset?, params?, reset?}` tool takes the same names, and `set_instrument` accepts every wind word.

## Rhythm (Euclidean rows)

A drum part can be stored as generators instead of notes: each row owns one voice of a `kit` or oneshot `sampler` track and dawg expands it into ordinary notes, so rendering, diffs and sync are unchanged while you, the agent and `track.ts` edit four numbers instead of sixteen hits. The model follows the Torso T-1's Shape and Groove sections; the Euclidean patterns and rotation match Strudel's `euclid`/`euclidRot` exactly (`E(3,8)` is `x..x..x.`, a positive rotate moves the pattern later).

```ts
// tracks/drums/track.ts
import { track, euclid, grid } from "dawg";

export default track({
  name: "drums",
  instrument: "kit",
  rhythm: [
    euclid("kick", 4, 16),
    euclid("hat", 7, 16, 2, {
      velocity: 0.5,
      accent: 0.6,
      accents: 3,
      swing: 0.15,
    }),
    grid("snare", "....X.......x..."),
    euclid({
      voice: "openhat",
      pulses: 1,
      steps: 16,
      rotate: 14,
      repeats: 3,
      time: "1/32",
      ramp: -0.6,
    }),
  ],
});
```

| Field                | Range (default)                      | T-1 parameter    | Behavior                                                                                      |
| -------------------- | ------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------- |
| `steps`              | 1..64 (16)                           | Steps            | Length of one pass; the row repeats every pass to the end of the loop.                        |
| `pulses`             | 0..steps (4)                         | Pulses           | Hits spread over the steps by Bjorklund's algorithm.                                          |
| `rotate`             | -64..64 (0)                          | Rotate           | Shifts the pattern later by n steps (negative: earlier), Strudel's direction.                 |
| `division`           | 1/32, 1/16t, 1/16, 1/8t … 1/1 (1/16) | Division         | Length of one step.                                                                           |
| `grid`               | `x` hit, `X` accent, `.` rest        | per-step editing | Explicit steps instead of pulses; its length is the step count.                               |
| `repeats`            | 0..16 (0)                            | Repeats          | Extra hits after each pulse, cut off by the next pulse (T-1 "choke" mode).                    |
| `time`               | a division (= `division`)            | Time             | Spacing of those repeats.                                                                     |
| `pace`               | -1..1 (0)                            | Pace             | > 0 slows the repeats down progressively, < 0 speeds them up.                                 |
| `ramp`               | -1..1 (0)                            | Ramp             | Velocity across the repeats: > 0 builds, < 0 fades.                                           |
| `velocity`           | 0..1 (0.8)                           | Velocity         | Base velocity.                                                                                |
| `accent`, `accents`  | 0..1 (0), 1..pulses (1)              | Accent           | Lifts `E(accents, pulses)` of the pulses (or the `X` steps) toward full velocity.             |
| `gate`, `legato`     | 0.05..4 steps (1), boolean           | Sustain          | Note length in steps; `legato` holds each hit to the next one (Strudel `euclidLegato`).       |
| `probability`,`seed` | 0..1 (1), 0..1e6 (0)                 | Probability      | Drops pulses (and their repeats) by a seeded hash: the same seed always drops the same hits.  |
| `swing`              | -0.5..0.5 step (0)                   | Timing           | Every second step later (> 0) or earlier.                                                     |
| `nudge`              | -0.5..0.5 step (0)                   | Delay            | The whole row later or earlier.                                                               |
| `cycles`             | 1..16 entries                        | Cycles           | Per-pass overrides of `pulses`, `rotate`, `repeats`, `probability`, `velocity`, used in turn. |

Rows regenerate when the loop length or meter changes. Editing a generated lane by hand (play-mode recording, `hit`, the agent's `add_drums`) freezes that row: the row is dropped and its notes stay as plain notes. `euclid <voice> freeze` does the same on purpose, `euclid <voice> off` removes the row and its notes.

Prompt grammar: `euclid kick 4 16`, `euclid hat 7 16 rotate 2`, `euclid hat swing 0.2 prob 0.8 seed 3` (named fields merge into the existing row, `default` resets one), `euclid snare off|freeze`, `grid snare ....X.......x...`. The agent's `set_rhythm` tool takes the same rows and its prompt prefers it for drums.

**Editor.** `/euclid [voice]`, or Rhythm in `/menu`, opens a T-1-style editor on the focused kit or oneshot sampler track: one row per voice with its step grid (`x` hit, `X` accent, `·` rest) and summary (`E(4,16)`). Every change runs one `euclid …` command, so it is one receipt and one undo step, and the edited voice plays once (audition) after it lands. The hits show on the highway like any notes. The bottom row is the four-knob strip (see **Four knobs**; `KNOB_MAPS.euclid`): `●›kick ▲ pulses 4 ■ rotate 0 ◆ velocity 0.8`. `/euclid hat` opens on `▲` pulses; bare `/euclid` on `●`.

| Key                         | Action                                                      |
| --------------------------- | ----------------------------------------------------------- |
| `↑ ↓` / `j k`               | pick a knob: `●` drum, `▲` pulses, `■` rotate, `◆` velocity |
| `← →` / `h l` / `- +`       | turn it (`●` moves to the next or previous drum row)        |
| `Tab` / `Shift-Tab` (`] [`) | next / previous parameter, every field                      |
| digits, `.`, `-`, Backspace | type a value, Enter applies                                 |
| Enter                       | add a row for a voice without one; keep (looping)           |
| Space                       | start or stop the audition loop (staging)                   |
| `a` / `c`                   | A/B / solo ↔ in context, while the loop plays               |
| `x` / Delete, `f`           | remove the row and its notes / freeze it to notes           |
| Esc                         | cancel typing, revert staged changes, then close            |

## Chords

`core/chords.ts` is one pure, deterministic chord engine shared by the agent tools, the SDK helpers and play mode. Its input model follows the Telepathic Instruments ORC-1 Orchid; the parts Orchid does not document are dawg's own and are marked so.

From Orchid's documentation and reviews:

- Four chord-type buttons, `dim min maj sus`, and four extension buttons, `6 m7 M7 9`. Hold a type and press a root for the chord; extensions add notes on top of a type (or of a Key-mode chord) and any number of them combine (Maj + M7 + C = Cmaj7). Extensions never play alone.
- Key mode: once a key is set, every key plays the chord that fits the key (C major: D plays Dm). Type and extension buttons still work on top for less obvious choices.
- Voicing dial: each click moves the chord's lowest note up an octave, or its highest note down, walking through inversions and up or down the keyboard.
- Bass: an optional engine that plays the chord's root under every chord. Its menu (manual 10.2, "How to use Bass on Orchid") has Chords Only (bass only under chords), Unison (single notes play bass and treble together), Single Notes (single notes play only bass; the treble sounds only for chords) and Solo (the treble is muted, even for chords).
- Performance modes: Strum (and 2-octave), Slop (random timing per note for a humanised feel that varies with every press), Arpeggiator (and 2-octave, tempo-synced; more chord notes make a longer pattern), Pattern (fixed rhythms) and Harp (a sweep across several octaves).
- "Secret chords" (firmware 3.84+, Orchid manual section 14.8): two type buttons held together play extra chords. dim+sus is a power chord (C5), maj+sus augmented (C+), min+sus Cm(add4); min+dim with the 6 button is Cm(b6), maj+dim with 6 is C(b6), and maj+min with m7 is C7♯9. dawg's `COMBINED_TYPES` is this table.
- Typed upper tensions (0.6.1): chord symbols also accept `11 m11 maj11 add11 madd11 13 m13 maj13 7b9 7#11 maj7#11 7b13 13b9` (`strum C11`, `strum_chords`, SDK `strum()`). They are typed-only (no pad buttons) and name back as typed; the guitar voicer drops the 5th, then the 11th beside a 3rd, then the 9th, and never the 3rd or 7th.
- Orchid has no generator that writes a progression for you. Key mode is its "easy chord progressions" feature: you pick the order, every key is in key.

dawg's own design:

- Secret chords play without their listed extension, since a latched pair is already deliberate; the listed extension is part of the chord and is not stacked again. Other extensions add on top (`Cm(add4,7)`). With three types latched, the first two in `dim min maj sus` order count.
- Key-mode chords are the diatonic triads (sevenths when asked) of `major`, `minor`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `locrian` and `harmonic-minor`. A key outside the scale plays the chord borrowed from the parallel major or minor when that scale has the note (C major: E♭, A♭, B♭), otherwise a passing diminished seventh.
- Voice leading: a voicing is the chord in root position from C4, rotated by the dial. When there is a previous chord, every rotation within one octave of the dial is scored by movement (each new voice's distance to the nearest old voice, plus the reverse, so common tones are free), kept within C3–G5 where it fits, and the cheapest wins; ties go to the rotation nearest the dial. Spread `open` drops the second voice from the top an octave (drop 2), `wide` also the fourth.
- Bass is the root (or slash bass) in C2–B2, one sustained note per chord. The five bass modes `off`, `chords`, `unison`, `single` and `solo` follow Orchid's menu; under `unison` the agent and SDK use the chord's root and ignore a slash bass, and in play mode a single note's bass is the same pitch class two octaves under the pressed octave.
- Pattern perform mode: Orchid ships fixed rhythm patterns but does not publish them, so dawg's thirteen are its own (`eighths`, `sixteenths`, `offbeat`, `pop`, `charleston`, `bossa`, `skank`, `gallop`, `half-time`, `tresillo`, `oom-pah`, `roll`, `pick`), chosen by name or number 1–13. Each is a list of hits (beat, length, accent, which voices: all, the upper voices, the root an octave down, or chosen chord tones) over one or two bars, repeated over the held length and cut at its end. Accents scale the press velocity.
- Perform modes `block`, `strum-up`, `strum-down` (1/32-beat gap), `arp-up`, `arp-down`, `arp-updown`, `arp-random` (seeded) with a grid-aligned `rate` and 1–4 `octaves`, `harp` (a 1/16-beat upward sweep across the octaves that rings to the end of the chord), and `slop` (Orchid's humanised block chord: each voice lands up to 1/16 beat late, chosen by the press's seed, so repeats differ but a recording replays exactly).
- Progressions (dawg's "auto"): eleven presets (`axis` I–V–vi–IV, `sad-pop` vi–IV–I–V, `fifties` I–vi–IV–V, `ii-v-i`, `turnaround` I–vi–ii–V, `canon`, `aeolian` i–VI–III–VII, `andalusian` i–VII–VI–V, `minor-ii-v`, `dorian-vamp`, `mixolydian-rock` I–♭VII–IV–I) and four styles, `pop`, `jazz`, `modal` and `classical`, that walk a weighted graph of scale-degree transitions (tonic → predominant → dominant → tonic, with plagal and vi–IV moves for pop and the cycle of fifths for jazz) from I with a seeded PRNG. A progression of four or more chords ends on a dominant-function chord (V or vii°; IV or vii in modal) so the loop leads home. The same key, style, length and seed always give the same chords.

- Chord symbols (0.7) also take stacked alterations on any listed base, bare or in parentheses: `C7#5`, `Cmaj7+5`, `C9#11`, `C13#11`, `C7b9b13`, `C7(b9,#9)`, `C9b5`, `C7alt` (b9 #9 #11 b13), and the spellings `C-maj7`, `Cmmaj7`, `Cadd2`, `C2`, `C6add9`. Roman numerals are lossless: a numeral reads back as the chord it names. When the short form would read back differently, the numeral carries the chord's own suffix in brackets (`Idom7`, `I[5]`, `I[7#9]`, `V[13#11]`), and a major-scale degree the mode alters takes `♮` (`♮II` in Phrygian). Both forms parse wherever numerals do.

Prompt. `progression <chords> [each <beats>] [at <beat>] [bass]` (alias `prog`) writes sustained, voice-led `block` chords on the focused track: numerals in the song key (`progression i7 IV7 i7 IV7 each 8`) or symbols (`progression Am7 D9 bass`), `each` defaulting to one bar. It adds notes beside the existing ones, grows the song to fit, and writes the same notes as SDK `progression(chords, { key, from, each })`; `bass` adds the root under each chord. It is the carrier for a vocoder or talkbox without the agent. Menu: **Ctrl-K › Chords and key › progression**.

Agent. `suggest_progression {key?, chords? | style?, length?, seed?, sevenths?, inversion?, spread?}` (read-only) returns each chord's name, roman numeral, voicing and bass. `write_chords {trackId?, chords, key?, start?, beatsPerChord?, perform?, pattern?, rate?, octaves?, strum?, velocity?, bass?, bassMode?, bassTrackId?, inversion?, spread?}` writes them as one revision. `chords` takes roman numerals in the key (`ii7`, `bVII`, `V/V`) or symbols (`Cm7`, `F/A`). The system prompt tells the agent to use these tools for chord parts, so its chords are diatonic and voice-led rather than hand-stacked.

SDK. `chord("Cm7", start, length, opts)` and `progression("ii7 V7 Imaj7", { key, from, each, perform, pattern, rate, octaves, strum, seed, voicing, spread, part, bass })` expand to notes at evaluation; see [docs/project-format.md](./docs/project-format.md). The vendored SDK stays one import-free file: `core/sdk/v1.ts` carries a generated copy of the engine (`bun core/sdk/sync-chords.ts`, checked by a test).

## Performance and expression

Notes can say how they are played, and tracks how they perform. Every field is optional: a note or track without them sounds exactly as before. Expression is applied at render to copies of the notes, so the score keeps what you wrote.

Per note (the focused track; a target is `all`, the default, `last` (the note added last), `bar 3`, `bars 2-4` or note ids; the reply names the scope and how many notes changed):

| Command                                                     | Does                                                                                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `art staccato\|legato\|accent\|tenuto\|marcato\|ghost\|off` | staccato half length; legato held into the next note with a short overlap; accent +0.2 velocity; tenuto full length +0.05; marcato two thirds +0.3; ghost half length ×0.4 |
| `glide 60ms` with a target                                  | portamento into each note from the previous pitch                                                                                                                          |
| `bend -200 \| scoop \| fall \| doit \| 0:-200 0.25:0`       | a pitch curve over the note in cents (`at` 0..1 of its length), linear between points                                                                                      |
| `vibrato 5.5 30 [0.2]`                                      | rate Hz, depth cents either side, delay s (then a 0.15 s fade-in)                                                                                                          |

Per track:

| Command                                                                       | Does                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `glide 80ms [legato\|mono\|poly]`                                             | `legato` (default): one voice, slides only into a note that overlaps the last, no envelope retrigger; a note with its own glide also slides from a note ending at most a 16th earlier (the TB-303 slide, set on the destination note); `mono` always slides; `poly` slides each voice from the previous chord. Mono and legato glides approach the pitch exponentially (RC), poly linearly; `glide 0` is off |
| `pedal 0-3.5 4-7.5`, `pedal bars`, `pedal down\|half\|up <beat>`, `pedal off` | sustain pedal (CC64; spans in beats from 0, `bars 2-3` in bars from 1): notes released while it is down ring until it lifts; `half` lets them fade; `bars` re-pedals on each downbeat (lift and catch) and replaces the lane                                                                                                                                                                                 |
| `velcurve linear\|soft\|hard\|fixed [v]`                                      | soft (v^0.5) brings quiet notes up, hard (v^2) needs a firm touch, fixed plays every note at `v` (default 0.8)                                                                                                                                                                                                                                                                                               |
| `humanize 8 [5 [10]] [seed n]`                                                | timing ±ms, velocity ±%, length ±%, seeded per note at render (`humanize reseed` for a new take, `off` to remove)                                                                                                                                                                                                                                                                                            |
| `expression`                                                                  | what the focused track does                                                                                                                                                                                                                                                                                                                                                                                  |

Precedence with the synth: a note's settings override the track's synth. A note's `vibrato` replaces the synth's `vib`/`vibmod`, a `bend` replaces the pitch envelope (`penv`), and a gliding note ignores ZzFX `slide`. Render order: articulation, then humanize velocity, then pedal, then glide and mono voicing (on written timing), then humanize timing and length, then the velocity curve.

Menu: **Sound › performance** has glide time (ms) and mode, sustain pedal (off or every bar), velocity curve, humanize timing, velocity and length, and new take; the loop stages them for A/B like any other sound change. Agent: `set_expression` (articulation, glide, bend, vibrato and humanize over note ids or a beat range) and `set_performance` (the track's glide, pedal, velocity curve and humanize). SDK (1.15.0): `note("C4", 0, 1, 0.8, { art: "staccato", glide: 0.05, bend: [[0, -200], [0.25, 0]], vibrato: { rate: 5.5, depth: 30 }, humanize: { timing: 10 } })`, `expr(notes, { art: "ghost" })` for many notes, and `track({ glide: 0.08, pedal: [[0, "down"], [4, "up"]], velocityCurve: "soft", humanize: { timing: 8, seed: 7 } })`.

## Sound calibration

A song's `calibration` picks the revision of level, pitch and kit fixes the released engines render with. Absent or 0 keeps every 0.4 to 0.6.1 project byte-identical; `dawg init` writes the latest (1). `/calibration` shows it, `/calibration 1|latest|0|off` sets it; Ctrl-K › Project › calibration, the `set_calibration` agent tool and `song({ calibration: 1 })` do the same.

Revision 1: a closed (42) or pedal (44) hat chokes a sounding open hat (46) over 8 ms; GM toms 41 to 50 are pitched two thirds of a semitone per key around 45 (low tom); 49, 52, 55 and 57 play a crash, 51, 53 and 59 a ride and 56 a cowbell (they were a rim click), and section fills end on the crash; hat metal is band-limited; keys presets are leveled to within 3 dB of piano across notes 36 to 96; and lip brass locks its lip resonance to the sounding pitch with soft lip saturation, so held notes are steady and in tune.

## Tunings and scales

Every project plays in 12-tone equal tuning at A4 = 440 Hz until it says otherwise. A song tuning, a track tuning or a note's cents change only the frequencies; notes stay MIDI keys, so editing, chords, play mode and exports work the same. MIDI export carries a tuning with the MIDI Tuning Standard (a single-note tuning SysEx per tuned track, selected with RPN 3), and writes glides, bends, vibrato and note cents as pitch bend (range ±24 semitones) on notes that sound alone on their track; synths without MTS play 12-TET keys. A project without any of these renders byte-identically to 0.4.

Tunings (`core/tuning.ts`). A tuning is one table (`edo: 19`, `ratios: ["9/8", "5/4", …, "2/1"]`, `cents: [231, 474, …, 1200]`, a Scala `scl` file, or a library `name`) plus `ref` (the 12-TET A4 in Hz, default 440, that fixes the root key's pitch), `root` (the key of degree 0) and `map` (`linear` or `nearest`). The last table entry is the period, usually 1200 cents (2/1).

- The library: `12-tet`, `19-edo`, `24-edo`, `31-edo`, `pythagorean`, `just` (5-limit), `7-limit`, `well-tuned-piano` (La Monte Young's 7-limit key map from E♭, after Kyle Gann's published ratios), `pelog` and `slendro` (Kunst's and Surjodiningrat's averages), `nyamaropa` (a Shona mbira after Berliner), `thai` (seven equal steps, the Thai and Khmer norm, also `7-edo`), `hindustani` (twelve just svaras), `shruti` (the 22 shrutis), maqam and dastgah tables (`rast`, `bayati`, `saba`, `sikah`, `huzam`, `shur`, `homayoun`, `chahargah`, `segah`, `nava`) and raga tables (`yaman`, `bhairav`, `kafi`, `bhairavi`, `todi`, `marwa`, `darbari`, `malkauns` and more, each built from the raga's own svaras over 5-limit defaults). `tuning list` shows each one with a line about it. The gamelan, mbira, maqam and raga tables are marked approximate: every gamelan and every mbira is tuned differently, and maqam and raga intonation varies by tradition and performer.
- Anchoring follows Scala and Surge's tuning library: the root key sounds at its 12-TET frequency under `ref`, and the table counts up from it. So `ref` is the 12-TET A4 that fixes the root, and A4 itself sounds at exactly `ref` only when the root is an A (in `just` from C, A4 is 5/3 above C4, about 436 Hz at ref 440). For an exact reference key and frequency, use a `.kbm` keyboard mapping. The root defaults to the library tuning's own (E♭ for the Well-Tuned Piano), else the song key's tonic in octave 4, else C4.
- Mapping. Twelve-step tables retune the twelve keys. Other sizes default to `linear`, one key per step, as Scala, Surge and Ableton's tuning system do (19-EDO puts the octave 19 keys up). `map: "nearest"` keeps the piano layout instead and plays each key at the nearest table pitch, which suits pentatonic gamelan tables on a normal keyboard.
- Frequencies at or above 20 kHz count as unmapped keys and stay silent, so a coarse table (`edo: 1`) cannot alias at the top of the keyboard.
- Scala. `tuning scl tunings/slendro.scl [kbm tunings/white.kbm]` copies a file from outside the project into `tunings/` and stores the path. The `.scl` parser follows the Scala specification: `!` comments, a description line, the count, then one pitch per line (a period means cents, otherwise a ratio or integer), the 1/1 implicit and the last pitch the period. A `.kbm` keyboard mapping (size, first and last key, middle key, reference key and frequency, octave degree, then the map with `x` for unmapped keys) overrides `ref` and `root`. Bad files are refused with a line number.
- Track tuning overrides the song's field by field: a track with its own table uses it, and `ref`, `root` and `map` fall back to the song's. Kits ignore tunings.
- Note cents: `note("E4-14c", 0)`, `add E4-14c at 0` or `cents n3 -14` give one note a static offset of up to ±1200 cents on top of any tuning.

Scales (`core/chords.ts`). The song key string now names any scale: `"D dorian"`, `"A harmonic-minor"`, `"E hijaz"`, `"C yaman"`, `"C messiaen-3"`. The library has the church modes, harmonic and melodic minor, phrygian dominant, major and minor pentatonic, `yonanuki-minor` (1 2 b3 5 b6, the enka and trot pentatonic), blues and major blues, the maqamat `hijaz`, `bayati`, `rast`, `saba`, `kurd`, `nahawand` and `nikriz`, the dastgahs `shur`, `homayoun`, `chahargah`, `segah` and `nava`, the neutral-third maqamat `sikah` and `huzam`, common Hindustani ragas (`yaman`, `bhairav`, `kafi`, `bhairavi`, `asavari`, `khamaj`, `todi`, `purvi`, `marwa`, `darbari`, `malkauns`, `bhupali`, `durga`) by their thaat or aroha notes, Messiaen's seven modes of limited transposition, `chromatic` (all twelve pitch classes), `harmonic-series` (partials 8 to 15 over the tonic; `tuning harmonic-series` sounds them in just cents) and `quarter-tone` (each major degree beside its quarter-tone shadow, sounded as note cents). Every existing key string reads as before. Quarter-tone scales (Bayati, Rast, Saba) name their half-flat degrees; setting such a scale suggests the matching library tuning so they sound.

Chords. The chord engine stays twelve-tone: a scale outside the seven diatonic modes uses the nearest diatonic mode for key-mode chords. In a twelve-key tuning chords keep their keys (so in `just` they sound pure); in a linear non-12 tuning such as 19-EDO, the chord tools and play-mode chord phrases move each written pitch to the key that sounds nearest, so a C major triad becomes steps 0, 6 and 11.

Play mode. `i` (or `/play degrees`) toggles scale-degree mapping: the home row `A S D F G H J K L ; '` plays consecutive degrees of the song scale, or every step of a linear non-12 tuning (the nearest step to each scale note when a key is set), and the upper row is off. When a tuning has more steps than the home row (19- or 31-EDO with no key), `Z`/`X` page by eleven degrees instead of a period, so every step is reachable. `/play chromatic` turns it back off. The header shows the scale and tuning.

Highway. A note that sounds more than half a cent away from 12-TET shows a compact cents tag (`+14`, `−32`) after its label when there is room. In a twelve-key table the tag is measured from the note's own lane. In a linear non-12 table (19-EDO, slendro) the lane is only the key, so the tag names the 12-TET pitch it is measured from (`D#−47`, or `C` when it sounds right on it), and lane labels mark the tuning's periods (every 19 keys from the root) instead of every C.

Commands and menu.

| Command                                     | Does                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `tuning <name>` · `edo <n>` · `off`         | song tuning (`off` is 12-TET)                          |
| `tuning ratios 9/8 5/4 … 2/1` · `cents …`   | a custom table                                         |
| `tuning scl <file> [kbm <file>]`            | a Scala scale and optional keyboard mapping            |
| `tuning ref <hz>` · `root <note>` · `map …` | reference pitch, root key, `linear` or `nearest`       |
| `tuning track <…>` · `track off`            | the focused track's own tuning; `off` follows the song |
| `tuning list` · `scale list`                | the libraries                                          |
| `scale [<tonic>] <name>`                    | the song key and scale (`scale D hijaz`)               |
| `cents <id> <±c>`                           | detune one note                                        |

The menu has the same in Ctrl-K › Chords and key › tuning (song tuning, ref, root, map, equal steps, ratios, cents, Scala file, keyboard map, scale and tonic; `/menu tuning` jumps there) and Ctrl-K › Sound › track tuning (the track's, showing inherited song values as `· song`). The Chords tonic row keeps a library scale (`D hijaz` stays hijaz). Agent: `set_tuning {target?, name? | edo? | ratios? | cents? | scl?, kbm?, ref?, root?, map?, off?}` and `set_scale {tonic?, scale}` run the same commands, `add_notes` and `update_notes` take an optional `cents` per note (0 clears it), and the agent brief carries the song and track tunings and a `cents` column when a focused note has one. SDK 1.16.0: `song({ tuning })`, `track({ tuning })` (a name string or an object), and pitch strings with a cents suffix (`note("E4-14c", 0)`, `seq("C4 E4-14c G4+2c")`).

Rendering. Synth and wavetable voices start at the tuned frequency; keyed samplers repitch by the ratio between the tuned and the 12-TET frequency, and one-shot samplers apply note cents only. Live playback, audition and export use the same table, so what you hear is what renders.

## Play mode (computer keyboard)

`Ctrl-P` or `/play` turns the computer keyboard into a piano for the focused track, using the "musical typing" layout GarageBand, Logic, BandLab, FL Studio and Ableton share. `Esc` or `/play off` leaves it and every normal binding is back. Typing `/` starts a slash command without leaving the mode (`/click 40%`, `/play off`).

| Key                     | Does                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `A S D F G H J K L ; '` | white keys C D E F G A B C D E F from the base octave                    |
| `W E T Y U O P`         | black keys C♯ D♯ F♯ G♯ A♯ C♯ D♯ (none on `R` or `I`, like a piano)       |
| `Z` / `X`               | octave down / up (clamped to the score's pitch range)                    |
| `C` / `V`               | velocity down / up in steps of 16 (1–127, shown in the header)           |
| Shift + note            | sustained note: rings until a plain key or `Tab`                         |
| `Tab`                   | sustain pedal latch on/off (off releases every sustained note)           |
| `R`                     | record arm on/off                                                        |
| `Shift-R`               | replace: bars you play over are cleared first (default: overdub)         |
| `M`                     | click on/off                                                             |
| `I`                     | scale-degree keys on/off (see [Tunings and scales](#tunings-and-scales)) |
| `Space`                 | play/stop; with record armed and stopped, counts in, then records        |
| `?`                     | the play-mode keys and current settings (any key closes)                 |
| `/`                     | type a slash command without leaving (`/click 40%`)                      |
| `Esc`                   | leave play mode                                                          |

Recording keeps each note's velocity from `C`/`V`. Sustain is recorded the way Logic's Musical Typing records its `Tab` sustain key: as pedal events (`down` when `Tab` latches or Shift starts holding, `up` when it lets go) on the track, at the playhead and not quantized, while the notes keep the length the key was held. Terminals report key-down only, so `Tab` latches rather than holds. A chord-mode press keeps its held length on its voices instead.

### Guitar strumming (0.6.1)

The `guitar` perform mode, the `strum` command, `strum_chords` and SDK `strum()` share one fretboard voicer and one stroke engine in `core/chords.ts`.

```text
guitar                         show the track's fretting (Track.guitar)
guitar tune dadgad             a tuning name, or open strings low to high: guitar tune D A D G A D
guitar capo 2 · hand 5 · ring 0.8 · position 5 · guitar reset
strum G D Em C folk            chords (symbols or roman numerals), one bar each
strum I V vi IV strokes D-DU-UDU speed 30ms each 2 at 4
strum                          strum the block chords already on the track
/chords perform guitar         play mode chords strum on the fretboard; [ ] change speed
```

- **Voicer.** Each chord is fitted to the strings within `hand` frets (default 4) above the capo, preferring open strings (`ring` 0 closed shapes .. 1 ringing open strings) and the `position` fret. A barre never lies over a string that plays open, the bass is the chord's root or slash bass, and when a chord has more notes than strings fit it drops the fifth, then the 11th, then the 9th, as guitarists do. Every one of the 96 common shapes (12 roots × 8 qualities) is playable within 4 frets in standard tuning.
- **Tunings** (`GUITAR_TUNINGS`): `standard dropd doubledropd dadgad openg opend opene halfdown nashville bass ukulele requinto`, or any 3..12 open-string notes. The capo moves every string up.
- **Strokes.** A grid on `step` (an eighth by default) of `D` down, `U` up, `d` `u` light strokes, `x` a muted chuck, and `-` or `.` a rest (the strings ring on), or a named pattern: `down folk pop punk funk reggae waltz jangle island`. Down strokes go low to high, up strokes high to low over three or four strings, and a new stroke cuts the strings it restrikes. Patterns are dawg's own: the classic folk/pop eighth-note patterns of beginner method books.
- **Speed.** The time a full six-string down stroke takes, 22 ms by default (0..200 ms), the spread a real pick takes across the strings; it is in milliseconds so it stays the same at any tempo (`speed 1/32b` gives it in beats, converted at the song tempo). At 120 BPM the first-to-last note spread equals `speed` within 1 ms.

Track.guitar is stored only when set (`{ tune, capo, hand, ring, position }`). Menu: the **guitar** page of Ctrl-K › Sound (on guitar-like tracks: tune, capo, hand, ring, position, strum the chords, reset) and a **play** page in Ctrl-K › Chords and key (strokes, speed). Agent: `set_guitar`, `strum_chords`, and `write_chords` with `perform: "guitar"`, `strokes`, `speed`. SDK: `track({ guitar: { tune: "dadgad", capo: 2 } })` and `strum("G D Em C", { strokes: "folk", speed: 30 })`.

### Chord mode

Play mode has a chord sub-mode modeled on the Orchid's Key mode. It is `auto` by default when the focused track can play chords (pitched synths, piano, soundfonts, keyed samplers; not tracks whose instrument, name or id says bass, kit, drum or perc) in 12-TET without a mono or legato glide, otherwise `manual`, so a track in pelog, just intonation or another non-12 tuning, or a TB-303-style legato line, records single notes. Choosing a mode by hand (`Q`, `/chords`, the menu) sticks for the session.

- `auto`: each note key plays the diatonic chord of the song key on that root (C major: `S` plays Dm, `G` plays G). Keys outside the scale borrow from the parallel major or minor. The on-screen keyboard labels every white and black key with its chord.
- `manual`: note keys play single notes as before; latch a chord type or extension and they play that chord on the pressed root.
- `off`: plain play mode; the chord keys below go back to being unmapped.

Terminals send no key releases, so the Orchid's held left-hand buttons are latches here: press once to latch, again to release, `0` clears them all.

| Key       | Does (chord mode on)                                                                    |
| --------- | --------------------------------------------------------------------------------------- |
| `Q`       | auto ⇄ manual                                                                           |
| `1 2 3 4` | latch chord type dim / min / maj / sus (two latched make a combined chord)              |
| `5 6 7 8` | latch extension 6 / m7 / M7 / 9 (any number; on top of the type or auto chord)          |
| `0`       | clear every latch                                                                       |
| `-` / `=` | voicing dial down / up (-12..12; walks inversions)                                      |
| `9`       | next perform mode (block, strum-up, strum-down, arp-up, …, harp, slop, pattern, guitar) |
| `[` / `]` | perform guitar: strum slower / faster (5 ms steps, 0..200 ms)                           |
| `B`       | next bass mode: off, chords, unison, single, solo (bass in C2–B2)                       |
| `N`       | play the suggested next chord (the `next` chord in the header)                          |

The header gains `AUTO C major · Dm (ii) · next G`: mode, key (`(assumed)` when the score has none and C major is used), the last chord with its numeral, and the suggested next chord. A legend row under the on-screen keyboard lists the number-row latches (`1 dim  2 min  3 maj  4 sus  5 6  6 m7  7 M7  8 9  0 clear  -= voicing 0  9 block  b bass off  n next  q auto`), with latched ones lit; at 80 columns the row ends where it fits. The full chord state is in the `?` panel, in the header's words: `chords AUTO C major · Dm (ii) · next G · min+m7 · voicing +1 · arp-up · bass chords`. The suggestion comes from the progression engine: the next chord of the chosen preset when the last chord is in it, otherwise a seeded step of the style's transition graph.

Each chord is voice-led from the previous one and sounds through the live voice path. Recording quantizes the press like a note and lays the chord out with the perform mode over its held length (arpeggios at `rate`, `grid` by default; patterns from the press's quantized start), plus the bass note. Under `unison`, `single` and `solo` a single note in manual mode also records its bass (and, for `unison`, the note itself); `solo` records chords as bass only; each bar is still one revision and one undo step.

`/chords` with no argument prints the settings; `/chords auto|manual|off`, `voicing <n>`, `spread close|open|wide`, `bass off|chords|unison|single|solo` (`on` means `chords`), `sevenths on|off`, `perform <mode>`, `pattern <1..13|name>` (also selects the pattern perform mode), `rate grid|1/4|1/8|1/16|1/32`, `octaves 1..4`, `preset <name>|none`, `style pop|jazz|modal|classical`, and for the guitar perform mode `strokes <name|grid>` and `speed <ms|beats>` (`speed 30ms`, `speed 1/32b`). `key <tonic> <mode>` (`key A minor`, `key F# dorian`, `key none`) sets the song key as one score edit. The same settings and the key are in `/menu` under Chords.

The base octave follows the instrument: C3 (MIDI 48) by default, C2 for bass instruments or tracks named bass, C4 for saw/square/triangle/pluck leads. Kits start at C2, on the GM map, so the home row is the kit you hit most: `A` kick, `S` and `D` snare under the index and middle fingers, `F G H J K L` the toms low to high; the upper row is the lighter hits, `W` rim, `E` clap, `T` and `Y` closed hat, `U` open hat, and on a calibrated score (`calibration` 1 or more) `O` and `;` crash, `P` and `'` ride. On a one-shot sampler track the keys walk the voices in name order from slot 36 (`A` the first voice, `W` the second, chromatically), and the keys show voice names; a keyed sampler starts at the C below its lowest root and repitches from it.

The header reads `PLAY  C3–F4  ● REC` with a beat flash and ends in `? keys · esc leave`; grid and the chord state are in the `?` panel, and a key that changes a setting (`C`, `V`, `M`) says so in the header's status for a moment. Under the header is the on-screen keyboard (`tui/play-keys.ts`), drawn the way the keys sit under your hands:

```text
    W    E         T    Y    U         O    P             z x  oct C3–F4
    C#   D#        F#   G#   A#        C#   D#            c v  vel 100
 A    S•   D    F    G    H    J    K    L    ;    '      m    click on
 C3   D    E    F    G    A    B    C4   D    E    F      r    ● rec armed
                                                               count-in 1 bar
```

Each key cap is its letter with what it plays printed under it: the note name, with the octave on the C keys (the tonic under `I`) so the octave reads at a glance, the chord in auto chords, or on a kit and a one-shot sampler the sound (`kick snr chh ohh clap rim tom crsh ride`, taken from what the kit renders for each pitch). The upper row sits half a key to the right, so each black key falls over the gap between the white keys it lies between, and the gaps at `R` and `I` are the piano's missing black keys. A key that plays nothing shows `·`. Held and sounding keys are reversed and marked `S•` (`S*` in ASCII), so they read without color; C keys are bold. The panel on the right shows the octave and velocity with their keys (`z x`, `c v`), the click (`m`), record (`r`: `rec off`, `● rec armed`, `● REC` or `● REC replace`) and the count-in, which counts down while it runs. From 120 columns the keys widen and the bottom row joins them, `Z X C V M` labeled `oct- oct+ vel- vel+ click`; at 80 columns it is the two note rows and the panel; at the 60-column minimum the panel folds into a line under the keys. Every mapped key shows at every size. With too few rows to draw it and keep the roll, the keyboard folds to one line, `A C3 W C# S D …`. It all repaints in place; nothing scrolls per note.

Notes sound through the track's own instrument, effects and volume, rendered by the same per-instrument voice code as the loop, and mix into the stream about 60 ms ahead of now (play mode lowers the queue lead from 200 ms and restores it on exit). That works over silence and over the playing loop. A muted or unsoloed track still sounds while you play it. With audio backend `none` the keys still record.

Terminals send key presses and auto-repeats, never key releases, so held notes are synthesized. A press sounds for one grid step; holding the key keeps it sounding while the OS auto-repeats it (after its repeat delay, usually 250–700 ms), and it ends about 120 ms after the last repeat. Hold notes shorter than the repeat delay come out one grid step long. Use Shift or the `Tab` latch for long notes.

Recording: with record armed and the transport running, each note is quantized to the grid (`/grid 1/16` by default; `1/4 1/8 1/8T 1/16 1/16T 1/32`), wrapped into the loop, and appended to the focused track as `addNote` operations when the playhead leaves the bar, so each recorded bar is one revision: one `Ctrl-Z` undoes a bar, other windows and the project files see it like any edit. Stopping commits the rest. The same pitch on the same step twice is one note. Replace removes the bar's earlier notes in the same revision. No agent and no network are involved.

**Loop recording.** With a loop set (`loop 5-6`, `\` on TAPE), recording commits once per pass instead of once per bar: each wrap is one revision and one `Ctrl-Z`, the card reads `pass 3 · +5 notes`, the header shows `↻ 5–6 · pass 3`, and a pass that played nothing writes nothing. `keys record` arms it (`keys record replace` replaces, `keys record off` disarms), opening PLAY on the focused track first; on TAPE `r` and `R` run those, and `Esc` goes back to TAPE. Replace erases only the bars each pass crossed, inside the loop. Without a loop, playing over a form's repeat (a `░` ghost pass on TAPE) records into the source section's bars, one revision a bar. Live notes sound through the shared daemon engine, so every pane hears them, and each carries its beat. Other panes see the recording pane as `C●`; while another pane is recording a track, replace on it is refused and names that pane (`✗ pane B is recording bass · overdub instead (r)`), and a pass already armed for replace lands as an overdub. On TAPE the reels `◐◓◑◒` turn one step a beat while the transport runs (`|/-\` in ASCII), and as each pass closes the loop brackets draw reversed with the fill `━` for a moment, a shape change rather than a color; `/motion off` keeps both still.

## Click track

`/click on|off|<volume>` (`/click 40%`, `/click 0.4`) or `M` in play mode. An accented downbeat and lighter beats at the transport tempo and the score's meter, mixed as a separate monitoring bus. It is never part of a loop render, a stem, `dawg render`, or `/export`; tests compare those byte for byte with the click on. `/count-in 0|1|2` sets how many bars of click play before recording starts (default 1); the header counts down and flashes the beat, so it also works with backend `none`.

## Tempo and meter

Ticks stay score time; an optional song `time` field turns them into seconds (`core/tempo.ts`). A beat is a quarter note and BPM counts quarter notes, as in Standard MIDI Files, so a 7/8 bar lasts 3.5 beats. Without `time` and without track `time` everything is the 0.4 arithmetic and renders byte-identically.

```text
tempo 90 at bar 9            step change on bar 9's downbeat (beats count from 0, bars from 1)
tempo 140 at 64 ramp         glide from the previous tempo into 140 at beat 64 (linear, equal BPM per beat)
tempo 70 at bar 17 exp       exponential glide: equal ratio per beat, even to the ear
tempo remove bar 9 | tempo clear | tempo map
rit 4 bars to 80             ritardando over the last 4 bars; rit/accel default to 75% / 133% over the last 2 bars
a tempo [at bar <n>]         step back to the tempo before the last rit/accel (default: the bar after it ends)
tempo primo [at bar <n>]     step back to the start tempo
accel 8 bars to 174 at bar 9 accelerando from bar 9; `beats` instead of `bars`, `exp` for an exponential curve
fermata at 31 2              hold beat 31 for 2 extra beats; fermata [at <beat>|[at] bar <n>|[at] end] [<extra beats>], default 2
meter 7/8 at bar 5           meter change on a bar line, lasting until the next one; meter 7/8 alone sets the whole song
meter remove bar 5 | meter clear
track rate 3/2               polytempo: the focused track plays at 1.5× the song tempo (0.125..8 or a/b)
track phase 0.5              start the track half a beat later
track loop 3                 polymeter: loop the track's first 3 beats against the song's bars
track phasing 3 [over 48]    continuous drift: a 3-beat cycle gains one cycle every 48 beats, then realigns (needs a loop of whole spans)
track phasing 3 hold 8       stepped, as in Piano Phase: hold in step 8 cycles, move a sixteenth ahead over 2 (drift 2, shift 0.25)
track time off               follow the song again
```

- **Tempo events** (`time.tempo: [{tick, bpm, ramp?}]`) follow `tempoBpm`, which stays the start tempo. An event without `ramp` is a step; `ramp: "linear"` or `"exp"` glides from the previous tempo into the event. Ramps are defined over score position (beats), as Logic's and Cubase's tempo curves and MuseScore's gradual tempo changes are, and the renderer integrates them in closed form, so a ramp lands on the same sample however it is rendered.
- **rit / accel** write a pin at the start (the tempo in effect there) and a ramp to the target. MuseScore's defaults are used when no target is given: ritardando to 75%, accelerando to 133%. A rit refuses a faster target and an accel a slower one. `a tempo` and `tempo primo` are plain steps back.
- **Fermatas** (`time.fermatas: [{tick, beats}]`) lengthen the beat that starts at `tick` to `1 + beats` times its length (the meter's felt beat: a dotted quarter in 6/8 or 12/8, a quarter otherwise): everything inside that beat slows evenly and everything later moves back. WAV and MIDI export time it the same way (MIDI writes a slower tempo over the beat), so a held beat may last at most 16.777 s, the slowest tempo a MIDI file can write; a longer hold is refused with a message.
- **Meter changes** (`time.meter: [{bar, beatsPerBar, beatUnit}]`, `bar` 0-based in the file) take effect on bar lines only. The bar lasts `beatsPerBar × 4 / beatUnit` beats; `beatsPerBar` on the song stays the default meter. The click accents each bar's downbeat and clicks the meter's beat unit (dotted in compound meters such as 6/8), the count-in uses the meter and tempo at the punch-in bar, the highway draws bar lines and numbers from the meter map, and play-mode replace erases the bars the meter map says.
- **Track time** (`track.time: {rate, phase, cycle, steps?}`, phase, cycle and shift in ticks in the file) places a track's notes on the song timeline: the first `cycle` ticks repeat every `cycle / rate` song ticks, shifted `phase` song ticks later, restarting with every song loop. Two identical tracks with one on `track phasing 4` drift apart a little each cycle and line up again after `over` beats (default the loop), the continuous tape phasing of Reich's _It's Gonna Rain_ and _Come Out_; `over` and the cycle must divide the loop, and the prompt names the bars it needs otherwise. `track phasing 3 hold 8` stores `steps: {shift, hold, drift}` instead of a rate: the track holds in step for `hold` cycles, then moves `shift` ahead over `drift` cycles, and repeats, the shift-and-lock process of _Piano Phase_ and _Drumming_. Automation stays in song time.
- **Everywhere**: the offline renderer, the live engine and audition loop, the transport clock (beat ⇄ wall time, shared by every window through dawgd), click and count-in, recording quantization and the highway use the same map. `/export song.mid` and `dawg render song.mid` write a format-1 Standard MIDI File: track 0 carries the time-signature (FF 58) and tempo (FF 51) meta events, ramps are written as tempo steps every sixteenth whose BPM is the exact average over the step, so each step boundary lands on the same second as the WAV.

The menu has the same controls under **Ctrl-K › Project › tempo and meter** (`/menu tempo`): the tempo map (add a change, a ramp, a rit or accel, a tempo, tempo primo, a fermata), meter changes, and the focused track's rate, phase, cycle, phasing and stepped phasing. The agent's `set_time` tool takes the same actions, and the SDK has `tempo`, `ramp`, `rit`, `accel`, `aTempo`, `tempoPrimo`, `fermata`, `meter`, `phasing` and `stepPhasing` (see **Project files and SDK**).

## Grooves and kits

**Patterns.** dawg ships a library of 31 starting grooves, written for dawg from the defining placements of each style (no transcriptions). A pattern is a set of rhythm rows, one per voice, so after applying it every part is still a few Euclidean or grid parameters you can change in `/euclid`, with the prompt grammar, or in `track.ts`.

| Command                                | Does                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/pattern`                             | picker of every pattern; moving the cursor plays one bar of it (silent while the loop plays), typing filters, Enter applies                          |
| `/pattern <name>`                      | replace the focused drum track's notes and rows with the pattern; the tempo moves to the pattern's tempo only when it is outside the pattern's range |
| `/pattern <name> keep-tempo` / `tempo` | never / always move the tempo                                                                                                                        |
| `/pattern list`                        | the library as text: name, tempo range, tags, voices                                                                                                 |

Applying to a missing track creates a kit track; an empty melodic track becomes a kit track; a melodic track with notes is refused. Voices the track lacks (a sampler kit without a rim, say) are skipped and named in the receipt. Every apply is one revision and one undo step. In `track.ts`, `pattern("boom-bap")` returns the rows: `rhythm: pattern("boom-bap")`, or `[...pattern("house"), euclid("rim", 5, 16)]` to add one.

Patterns: `house`, `disco`, `techno`, `minimal`, `electro`, `breakbeat`, `amen-style`, `dnb`, `halftime`, `boom-bap`, `lofi`, `trap`, `drill`, `reggaeton`, `dancehall`, `one-drop`, `afrobeat`, `afrobeats`, `bembe`, `tresillo`, `son-clave`, `bossa-nova`, `samba`, `cumbia`, `garage`, `jersey-club`, `footwork`, `rock`, `funk`, `shuffle` (triplet 8ths), `half-time-shuffle`, `euclid-poly`. Ctrl-K › Rhythm › grooves lists them too.

**Kits.** A `kit` track plays the built-in drum synth. `kit: "<name>"` on the track (`/kit <name>`, or `set_drum_kit` for the agent) chooses one of six synthesized kits, all offline and deterministic; a track without `kit` sounds exactly as before.

| Kit        | Sound                                                        |
| ---------- | ------------------------------------------------------------ |
| `default`  | the original voices                                          |
| `syn808`   | long sub boom, snappy snare, metallic hats                   |
| `syn909`   | punchy clicky kick, bright noisy snare                       |
| `acoustic` | beater kick, wire snare, darker cymbals                      |
| `lofi`     | soft round kick, crushed and dark (alias `dusty`)            |
| `electro`  | tight short kick, clicky rim, ticking hats (alias `minimal`) |
| `trap`     | distorted long 808, crisp hats, high snare                   |

Sample kits from packs (`/kit 909` and the rest, see **Sample packs**) sit in the same picker after the synth kits. `/kit syn909` on a sampler kit turns it back into a synth kit track, moving hits and rows to the drums of the same name. The agent has `list_drum_patterns`, `apply_drum_pattern {name, trackId?, tempo: auto|keep|set}` and `set_drum_kit {kit, trackId?}`, and its prompt starts style grooves from a groove.

## Arrange (sections and form)

A song can name its parts. A **section** is a named bar range (`intro`, `verse`, `pre`, `chorus`, `build`, `drop`, `breakdown`, `bridge`, `outro`, or any name up to 32 characters) with optional per-section track mutes and variations. The **form** is an ordered list of sections with repeats (`verse verse chorus verse`, `intro verse chorus*2 outro`); a repeated pass plays identically, so `section dup chorus as last chorus` and a variation on the copy make a different last chorus that playback and export follow. A song without sections or a form plays and renders exactly as before, byte for byte.

Sections are markers over the timeline, like the arranger track in Studio One or Cubase and Logic's arranger: marking one never moves notes, while `dup`, `move` and `delete` take the section's bars with them and ripple the bars after it. Sections may overlap, so `chorus` and `chorus 2` can share bars and differ only by mutes and variations. Bars are numbered from 1 at the prompt, as a DAW ruler shows them, and from 0 in the score and the SDK.

| Command                                                                     | Does                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `section`                                                                   | list sections, the form and the looped section                                                                                                                                                                                                                                                                                                                              |
| `section [mark] chorus 9-16`                                                | mark bars 9–16 as `chorus` (re-marks an existing one)                                                                                                                                                                                                                                                                                                                       |
| `section add [<name>] [<n> bars]`                                           | a new section after the last one, growing the song                                                                                                                                                                                                                                                                                                                          |
| `section dup <name> [as <new>]`                                             | copy the section and its bars right after it                                                                                                                                                                                                                                                                                                                                |
| `section move <name> to <bar>` / `left` / `right` / `before <x>`            | move it with its bars                                                                                                                                                                                                                                                                                                                                                       |
| `section rename <name> to <new>`                                            | rename it (the form and the loop follow)                                                                                                                                                                                                                                                                                                                                    |
| `section delete <name>` / `section unmark <name>`                           | remove it with its bars (ripple), or only the marker                                                                                                                                                                                                                                                                                                                        |
| `section mute <name> [<track>…]` / `unmute`                                 | silence tracks in that section (the focused track by default)                                                                                                                                                                                                                                                                                                               |
| `section vary <name> [<track>] +12 [gain 0.8]` / `off`                      | transpose (semitones) or scale velocities of a track in that section                                                                                                                                                                                                                                                                                                        |
| `section reset <name>`                                                      | clear its mutes and variations                                                                                                                                                                                                                                                                                                                                              |
| `section loop <name>` / `section loop off`                                  | loop that section in playback (the per-song cycle, saved with the project)                                                                                                                                                                                                                                                                                                  |
| `section jump <name>`                                                       | move the playhead to it                                                                                                                                                                                                                                                                                                                                                     |
| `form intro verse*2 chorus outro` / `form off` / `form bake`                | set the form; clear it; or write it out as a linear score (one undo step)                                                                                                                                                                                                                                                                                                   |
| `build into <section> [<n> bars]`                                           | a build on the n bars (default 4) before the section, landing on its downbeat                                                                                                                                                                                                                                                                                               |
| `build [<section> \| <a>-<b>] [<n> bars] [riser] [roll] [sweep] [uplifter]` | a build over the section (its last n bars with `<n> bars`) or the bars; default the song's last four bars; all four layers by default                                                                                                                                                                                                                                       |
| `drop [<section> \| at <bar>] [cut <beats>] [no impact]`                    | a pre-drop cut (1 beat of silence by default, up to two bars) and an impact on the downbeat; bare `drop` lands on the section named `drop` or `chorus`, else on the bar after the last build (adding that bar when the build ends the song); with neither it asks for `drop chorus` or `drop at 17`. A cut that clips a build's uplifter retunes its rise to end at the cut |
| `fill [<section> \| at <bar>] [toms\|roll\|kick] [<n> beats] [no crash]`    | a drum fill on the beats before the section (1 by default, ½ beat up to two bars), or at every section boundary                                                                                                                                                                                                                                                             |

Playback follows the form; with a section looped it loops just that section, with its mutes and variations, and the highway, play mode and auditions stay inside it (an audition region is clipped to the looped section). Export (`dawg render`, the agent's preview) always plays the whole form and ignores the section loop; `dawg render out.wav --section chorus` renders one section on its own: notes and clips are cut at its edges and nothing before it plays, so stateful effects (a vocoder's band followers, a talkbox's first LPC frame, reverb tails) start fresh and the first and last few milliseconds differ from the same span of the full render. The windows a long render is split into internally do pre-roll and match the full render. Every WAV covers the whole song (or section) plus its tail; a long song renders in windows and is capped at 15 minutes, and a held note that crosses a window seam is crossfaded so long drones stay smooth. Exports mark the form: WAV renders carry a `cue ` point and `LIST adtl` label at each section start, and MIDI exports an FF 06 marker. Sections count bars in one meter: a compound meter held from bar 1 (`meter 6/8`, `song({ meter: [12, 8] })`) works, while meter changes later in the song and sections exclude each other.

Generators write ordinary notes, tracks and automation, so everything they make can be edited or undone (one step per command):

- **riser**: a `riser` track of filtered white noise whose cutoff and volume ramp up over the range.
- **roll**: an accelerating snare roll on the kit track (quarters, 8ths, 16ths, then 32nds, crescendo), on a `roll` kit track when the song has none.
- **sweep**: unfiltered or high-pass pitched tracks playing in the range get a high-pass sweep up to 1.2 kHz, and low-pass tracks open from a tenth of their cutoff to it; both sweep on an octave (log-frequency) curve and snap back on the next downbeat. The riser's cutoff rises the same way.
- **uplifter**: a `uplifter` supersaw with a rising pitch envelope, tempo-synced to land on the bar after the range (at most 10 s); builds of another length get their own `uplifter-<bars>` track so each lands on time.
- **cut** and **impact**: notes starting in the last beats before the drop are removed and held notes are shortened; an `impact` sine with a pitch drop and noise hits the downbeat.
- **fill**: 16ths replace the groove in the fill's beats: `toms` starts on the snare and steps down high, mid and low toms (GM 50, 47, 45; the built-in kit folds them onto its one tom), `roll` is snare and `kick` kick and snare. The crash on the next downbeat is an open hat plus a kick, since the built-in kit has no cymbal.

Section mutes and variations govern every bar of their section: a note held from an earlier section stops at the bar where a section that mutes its track begins, so a song sounds the same played straight through and through the form. Generators place their cut and crash by bar order in the score; with a form that reorders sections, run them on the bars that precede the target in the form (`build 13-16`, `fill at 17`).

The arrangement strip is one row under the header that shows the sections over the timeline (`▏verse   ▏chorus`), the looped section reversed, the section under the playhead bold, and the playhead as `▼`. It appears only when the song has sections. The menu's **Arrange** section (`/menu arrange`) lists every section; each opens loop, jump here, a mute toggle for every track, transpose and gain, build (into it, over it, or custom length and layers), drop (cut length and impact), fill (style, beats and crash), duplicate, duplicate as, move to, move left and right, rename, clear mutes and variations, unmark and delete. Agent tools: `list_sections`, `edit_section` (mark, add, duplicate, move, rename, delete, unmark, mute, unmute, vary, reset, loop, unloop), `set_form` and `add_transition` (build into or over a section, drop, fill). In `song.ts`: `song({ sections: [{ name: "verse", startBar: 0, bars: 8 }, …], form: "intro verse*2 chorus", loop: "chorus" })` (SDK 1.18.0; `loopSection: "chorus"` still reads).

## Ranges (loop, copy, move, bars)

The **loop range** is the bars playback cycles. `loop 5-6` sets it, `loop chorus` loops a section, `loop next` and `loop prev` step it one length along, and `loop off` plays the song again. A loop range is not a section: it never shows on the arrangement strip or in the form, and it is saved as `score.loop` (`loop: "5-6"` in `song.ts`, SDK 1.34.0). Setting one clears a looped section and the other way round. Export ignores it, like the section loop. Songs saved by 0.7 with a hidden section named `loop` load with that section turned into the loop range.

Range commands take bars as the ruler counts them (from 1): `5-6`, `5`, or a section name. Without a range they act on the loop range, else the section under the playhead, else the bar under it, which is what the keyed gestures use. `<track>` is a track id or name, `all` is every track, and a bare command acts on the focused track. Each command is one undo step and one diff operation set, so other windows and the agent see the edit, not a new score.

| Command                                                                      | Does                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loop <a>-<b>` / `loop <section>` / `loop next` / `loop prev` / `loop off`   | set, step or clear the loop range                                                                                                                                                |
| `copy [<track>\|all] <a>-<b> to <bar> [x<N>] [insert\|merge]`                | copy the notes, automation and clips in those bars to `<bar>`, replacing what is there; `x2` tiles it end to end, `merge` keeps what is there, `insert` shifts later music right |
| `move [<track>\|all] <a>-<b> to <bar> [insert]`                              | copy, then empty the source                                                                                                                                                      |
| `clear [<track>\|all] <a>-<b>`                                               | empty the bars; the bars stay (bare `clear` still empties the focused track)                                                                                                     |
| `copy [<track>\|all] <a>-<b>` then `paste [at <bar>] [x<N>] [insert\|merge]` | the clipboard: `copy` without `to` fills it, `paste` lays it down at the playhead's bar or `<bar>`; it is per window and not saved                                               |
| `reverse [<track>\|all] <a>-<b>`                                             | mirror the bars in time                                                                                                                                                          |
| `bars insert <n> at <bar>` / `bars remove <a>-<b>`                           | add empty bars before `<bar>`, or cut bars out; later sections, clips, automation, tempo and meter points and the loop range move with the music                                 |
| `jump <bar>[.<beat>]` / `jump <section>`                                     | move the playhead                                                                                                                                                                |
| `section split <name> at <bar>` / `section join <name>`                      | cut a section in two (the second half is `<name> 2`), or merge it with the section after it                                                                                      |
| `form print`                                                                 | the form written out as plain bars (`form bake`)                                                                                                                                 |

Copy, move, clear and reverse never touch tempo or meter points (except that `insert` opens new bars first); `bars insert` and `bars remove` move them. The menu's **Arrange › range** runs the same commands (loop bars, loop next and prev, copy, move, clear, reverse, paste at, insert and remove bars), the agent's `edit_range` tool types them, and show-me can type any of them. In `song.ts`, `bars(notes, 5, 6)` takes the notes in bars 5-6 starting at 0, `place(notes, { at: 7, times: 3 })` lays them at bar 7 three times, `reversed(notes, { bars: 2 })` mirrors them, and `insertBars(song, { at: 7, bars: 2 })` inserts bars into a whole song (SDK 1.34.0).

## TAPE (Ctrl-T)

`Ctrl-T` or `/tape` opens TAPE in place of the highway: every track as a row across the bars, each cell a density glyph (` ▁▂▃▄▅▆▇█`, the notes starting there weighted by velocity; a held note `▁`, an audio clip `▃`, empty `·`). Above the rows sit the bar ruler with the playhead `▼` and the loop brackets `[══]` read from `score.loop`, and the sections (`▀name▀`, the looped one reversed). The focused row carries `›`, a muted row is dim, and color is never the only cue (NO_COLOR and the mono theme keep every glyph). `-` and `=` zoom between a bar, a beat and half a beat a cell, and the view scrolls to keep the playhead in sight. The highway stays home: `Esc` or `Ctrl-T` again goes back, and `dawg pane tape` opens a pane on it.

`/patch` (Ctrl-K Sound › patch › Edit patch) opens the patch view of the focused track in place of the highway; `/patch --fx <name>` opens one of its effect patches (Effects › "<name> patch" › Edit effect patch). It lists the nodes in signal order (`◆` per voice, `●` once), the selected node's ports, and a cable matrix with outputs down and inputs across, pinned headers, and only the selected node's neighbourhood until `f` shows the whole matrix. A cell shows a cable's amount; a cable the compiler drops (an unreachable node, a cycle) is marked and its warning sits above the knobs. `tab` moves between the panes, `enter` opens a node's settings in the drawer or wires and unwires a cell, `[ ] { }` and `1`-`0` set a cable's amount, and `a`, `w`, `x`, `m` and `g` add a node, wire to a legal input, remove, map a param to a knob, and switch a node between per voice and once. `space` loops the track solo, and while it loops each row of the add list is heard as you move (`enter` keeps, `esc` reverts). Every key runs a typed `patch …` command that echoes, so the receipt teaches the words. The patch's first four macros are the four knobs (`KNOB_MAPS` row `sound:patch`). A track that is not a patch shows as a preview of its engine (`patch convert` makes it one), and a library patch is read-only apart from its knobs. A cable wired anywhere else (a typed command, the agent, another pane) moves the selection to its cell, so show-me lands where the change happened. `Esc` goes back, and `dawg pane patch [track]` opens a pane on it.

The footer is the range line (`range: bass · bars 5–6 (loop)`, the loop range, else the section, else the bar under the playhead) with the clipboard chip, the four knobs (● playhead, ▲ loop length, ■ tempo, ◆ volume, from `tui/knobs.ts`; `↑` `↓` pick, `←` `→` turn, `⇧` coarse, `Enter` opens the drawer) and the key hints. Every key echoes and runs a typed command, so TAPE teaches the range commands above: `c` (`C` all tracks) is `copy bass 5-6`, `x` is `copy` then `clear`, `v` pastes at the playhead's bar (`V` inserts), `delete` clears, `~` reverses, `\` loops the section here (again: off), `<` `>` slide the loop, `[` `]` `{` `}` move its end and start, `,` `.` jump between sections, `s` `S` split and join the section, `h` `H` mute and solo, and `1`-`9` or `Tab` focus a track row (number keys pick tracks on TAPE, not knobs). The first paste after a cut lands as one `move`, one revision. The clipboard is per pane and kept in `.dawg/clipboard/` next to the session, so it survives a restart. With the mouse, a click on the ruler jumps, a drag on it sets the loop, a click on a row focuses it and a drag along a row sets the loop over those bars; the wheel walks the playhead a bar at a time. Other panes on a track show in the right gutter (`B`, `C●` while that pane records). Score edits commit like any other command, so other windows and the agent see them.

With a form set (`form verse chorus*2`), TAPE draws the song unrolled, in the order it plays: the first pass of each section is solid and every later pass is a ghost, shaded `░` (`~` without Unicode) and dimmed, with the section row labeled `chorus ×2`. Each column still names its score bar, so a key, click or drag on a ghost acts on the source section, and the range line says so (`range: bass · bars 5–8 (chorus) · edits chorus (plays 2×)`). The playhead follows the pass that is playing; bars the form never plays sit after it. `form print` (or `form bake`) writes the form out as plain bars: `printed form to tape · 16 bars`.

## Styles

`/style` writes a whole song in a style: drums, bass, chords, melody and form, generated from a **style card**, a set of theory patterns rather than recordings. A card names the meter (signature, additive grouping, hypermeter, cycles such as tala, iqa, gongan or clave timelines), the tempo range, the groove (subdivision, swing ratio, microtiming, per-role lay-back, seeded humanisation), the onset grids per role as abstract step weights, the pitch space (12-TET scales and modes, or a tuning such as maqam quarter tones, with scale weights), the harmony as a grammar (Roman-numeral presets, fixed forms such as the 12-bar blues, a Markov chain and cadences), melody contour, range and interval statistics, the texture (which roles are required) and the form. Cards inherit: a leaf patches its branch, which patches its family root, so `deep-house` only states what differs from `house` and `electronic`.

The taxonomy (`core/styles/taxonomy.ts`) has eight families and about 850 styles; every leaf is present, and a leaf without its own card generates from its nearest ancestor's card. Generation is deterministic: the same style, bars and seed always write the same song, and nothing is random beyond the seed.

| Command                                      | Does                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `style`                                      | the families and their root styles                                               |
| `style list [<id>]`                          | the children of a style                                                          |
| `style search <words>`                       | ranked search over ids, names, aliases and regions                               |
| `style info <id>`                            | path, meter, tempo, groove, tuning, harmony and roles                            |
| `style <id> [bars] [seed]`                   | replace the song with one in that style (1 to 64 bars, default 8; one undo step) |
| `style blend <a> <b> [weight] [bars] [seed]` | mix two cards; weight 0 is `a`, 1 is `b` (default 0.5)                           |
| `style again`                                | the song's style with the next seed                                              |

Every generated song is checked by `core/styles/validate.ts` before it is written: meter and tempo in range, onsets on the card's grid within tolerance, the swing ratio measured from the notes, every pitch in the scale or tuning, the chord sequence accepted by the harmony grammar, melody range and interval statistics, and every instrument resolving. The summary line reports how many checks passed. The song records its provenance in `style` (`{ id, seed, bars, blend? }`), which `/style again` reads.

Menu: **Ctrl-K › Arrange › style** (`/menu style`) walks the taxonomy, with `find`, `blend` and, once the song has a style, `again`; each style offers make 4, 8, 16 or 32 bars and about. Agent tools: `list_styles` (families, children or a query), `style_info` and `apply_style` (`id`, `bars`, `seed`, `blend`, `weight`). In `song.ts`: `song({ style: style("deep-house", { seed: 3, bars: 8 }) })` records the provenance (SDK 1.33.0); the notes live in the tracks as usual.

## Voice

Release 0.7 adds voice tools: audio clips and lyrics, pitch tracking, autotune, a formant shift, sung vowels and choirs, and a vocoder. Each arrives in its own subsection below. `/vocal` is the umbrella: bare `/vocal` lists every voice verb this build has, and `/help voice` shows them; `/help <command>` (`/help vocoder`, `/help clip`, `/help autotune`) shows one command with its full usage. Ctrl-K › Voice: every voice tool; on a track without a voice it offers "turn this track into a voice".

A track may store `clips`, `takes` and note `lyric`s (see docs/project-format.md). Projects without them sound exactly as before.

### Clips and lyrics

An audio clip is a window onto a WAV file in the project, placed at a bar on a track. Clips sum into the track before its effects, so the track's filter, compressor, reverb, sends and automation all act on them. Any track can hold clips: on a synth track the notes still play beside them.

- **`vocal`** is the instrument for a sung part. Its notes are guides: silent in exports and renders, a soft sine (about -12 dB under a plain sine) in play mode and the audition loop so you can sing or check against them. `instrument vocal` (or `/track vocal`) also fills the vocal chain into effects the track has not set: a 90 Hz high-pass for rumble and plosives, a 3:1 compressor, and a short plate. A `vocal` track without clips keeps the plain tone older projects had.
- **`/vocal import <file> [bar]`** copies a WAV that is already 48 kHz mono 16-bit straight in, and converts anything else through the sample importer (ffmpeg, which dawg detects and never installs), into `tracks/<slug>/samples/` as 48 kHz mono 16-bit, pins its sha256 and places a clip at the bar (bar 1 when left out). On a fresh track (default sine, no notes) it also sets the instrument to `vocal`, without the chain. `instrument vocal` adds the vocal chain (90 Hz high-pass, 3:1 compressor, short plate) to effects the track does not set, and its receipt lists what it added. The clip gain is set so the file's peak sits at -6 dBFS, leaving headroom for the chain. `/vocal stem [bar]` places the vocals stem from the last `split_stems`. `/vocal setups` lists one-step setups; `/vocal setups <name>` applies only what this build supports and names what is missing (`hyper` sets `autotune hard`, formant +3.5, slapback and light distortion; setups needing harmony, recording or `/say` wait for those tools).
- **`/clip`** lists the focused track's clips; `/clip [id] <edit>` changes one (the clip under the cursor when `id` is left out): `gain -3` (dB, -60..12, absolute; `gain by -3` nudges), `fade .01 .2` (in and out, seconds, equal-power; `fade in .01` or `fade out default` sets or resets one side), `move 9` and `split 7` (1-based bars, `5.3` is bar 5 beat 3), `trim [offset s] [dur s|end]` (seconds into the file; `dur end` plays to the file's end), `rev`, `mute` (toggles), `repeat 2 [to 32]` (copies every 2 bars up to bar 32, or to the song end; `repeat every 2 to 32` also works), `rm`.
- **`/lyrics [bar] <text>`** puts syllables onto the focused track's notes from the bar, one per note in time order (the top note of a chord). `hel-lo` splits a word across notes, `_` holds the last syllable over another note (a melisma), `~` skips a note. A word without hyphens is split by an English syllable guess (th, sh, ch, ng and ck stay whole, a consonant plus `le` is its own syllable: `lit-tle`, `some-thing`, `for-ev-er`), and the receipt names the words it split; type hyphens where the guess is wrong. Notes starting together (a chord or a doubled note) take one syllable on the top note, and the others hold. `/lyrics` shows them; `/lyrics clear [bar]` removes them. On a sing track each syllable sings its vowel and a `_` holds the vowel before it; on other tracks the guide and the highway show them.

Placement follows the tempo map: a clip starts on its tick's time and plays at the file's own speed, so a tempo ramp moves its start but never stretches the audio (Ableton calls this warp off; a clip in a take with `ppm` is stretched by that drift only). A clip whose file is missing or whose bytes no longer match its sha256 renders silent and warns; `dawg check` re-hashes every clip and take and reports mismatches like a type error. Sections act on clips: a section mute silences the clips in it, and a clip crossing a section edge is cut there with a 5 ms equal-power fade, as are clips cut by `split`.

Ctrl-K › Voice › **clips** (each clip with gain, fade in, fade out, start in file, length, reverse, mute, move, split, repeat, file and remove; import a file, the vocals stem and the setups) and **lyrics**, and Ctrl-K › Voice › **voice presets**. The highway draws a clip row beside the focused track: each clip as a waveform block named by its file, a `┃` seam where one clip starts at another's end, and each note's lyric beside its head. Agent tools: `place_clip`, `edit_clip` (gain, fades, trim, move, split, rev, mute, repeat, remove), `set_lyrics`; the tools and commands take gain in dB and the tools' `fadeIn`/`fadeOut` are the SDK's `fadeInTime`/`fadeTime`. SDK:

```ts
track({
  id: "vox",
  instrument: "vocal",
  clips: [
    audio("tracks/vox/samples/verse.wav", { at: 8, gain: 0.7, fadeTime: 0.2 }),
    ...repeatAudio(audio("tracks/vox/samples/hey.wav", { at: 16 }), {
      every: 4,
      until: 32,
    }),
  ],
  notes: lyrics("hel-lo _ world", [
    note("C4", 8),
    note("D4", 9),
    note("E4", 10),
  ]),
});
```

`at`, `in` and `out` are in beats, `offset` and `dur` in seconds, and `gain` is linear (0.5 is about -6 dB; the printer writes the dB beside it as `gain: 0.5 /* -6.0 dB */`); `take(name, src, opts)` describes a take (the shape 0.7.1 recording writes). `audio()` prints its options in the order `id at offset dur gain fadeInTime fadeTime rev take mute text say sha256`, and a printed project reads back deep-equal.

### Formant shift and vowel morph

The `formant` effect moves a sound's formants (the resonances of the throat and mouth that make a voice sound big or small, male or female) without changing its pitch; it works on any source and most clearly on voices. It sits in the chain after `autofilter` and before `vowel`.

| Knob             | Range       | Default | Lane            | Does                                                                        |
| ---------------- | ----------- | ------- | --------------- | --------------------------------------------------------------------------- |
| formant shift    | -12..12 st  | 0       | `formant-shift` | moves the spectral envelope; negative is deeper or bigger, positive smaller |
| formant mix      | 0..1        | 1       | `formant-mix`   | blends the shifted and the dry signal                                       |
| vowel morph (to) | 0..1 (to v) | 0       | `vowel-morph`   | glides the vowel filter's five formants from `vowel` toward `to` (log Hz)   |

```text
/formant -4              deeper (pitch stays); /formant 3 0.5 is smaller at half mix
/formant giant           presets deep giant bright tiny; /formant off removes it
/vowel a o 0.5           vowel filter halfway from a to o; /vowel morph 0.8, /vowel to u
/vowel to off            back to one vowel; changing the vowel keeps your mix
/vocal formant -4        the same, under the voice umbrella
automate formant-shift points 0:-6 8:6
```

Shifts of 2 to 4 st sound natural; 7 and beyond are a cartoon. The shift is a cepstral spectral-envelope warp (Röbel and Rodet 2005; Smith, Spectral Audio Signal Processing): each STFT frame (1024 points at 24 kHz and below, 2048 above, hop a quarter frame, Hann analysis and synthesis) is divided by its envelope and multiplied by the envelope read at `k / 2^(st/12)`, the gain clamped to 24 dB and the phase left alone. The envelope's lifter follows the voice: 0.75 of a pitch period from a 5-frame median autocorrelation f0, clamped to 1..2 ms, 1 ms when unvoiced. Measured on the synthetic voice fixture at 22.05 kHz, ±2 and ±4 st land within 1 cent of the original pitch and 3 to 5.5 dB RMS of the envelope of a voice synthesized with moved formants (against 4 to 10 dB unprocessed), pre-echo stays below -15 dB, and it costs about 4 ms per audio-second. Frames are anchored to absolute hop multiples, so a preview window plays exactly the same samples as the full render. `shift 0` without automation leaves the sound untouched. This is not the sampler's `shift … formant`, which keeps formants while the pitch moves.

Before 0.7, `fx formant` was an alias of the vowel filter. `/fx formant o` and `set_fx {effect: "formant", vowel}` now answer "formant now shifts formants at constant pitch; the vowel filter is `vowel`".

Ctrl-K › Voice › **formant**: shift and mix (left/right adjust, `x` resets, space auditions with staged A/B); **Effects › more effects › vowel** gains To and Morph. Mix lists the `formant-shift`, `formant-mix` and `vowel-morph` lanes. The agent's `set_formant` tool takes `shift`, `mix`, `preset` and `off` and can be previewed with `preview_sound`; `set_fx vowel` takes `to` and `morph`. In the SDK: `fx: { formant: { shift: -4 }, vowel: { vowel: "a", to: "o", morph: 0.5 } }`.

### Singing voice

`sing choir` (or `/sing choir`, or the instrument words `aah`, `ooh`, `choir`, `chorale`, `khoomei`, `sygyt`, `kargyraa`) turns the focused track into the built-in singing voice: a synthetic glottal source (the Liljencrants-Fant model, shaped by Fant's Rd voice quality and band-limited by pitch so nothing aliases) through a five-formant Klatt cascade with soprano, alto, tenor and bass vowel tables. It is a synthetic voice, not a recording and not anyone's voice, and it renders offline and deterministically. It reads pitch through the track's tuning, and glide, articulation, pedal and the tempo map work as they do for winds.

Presets: `aah ooh choir oohchoir chorale airy glass` (Choir), `lament soprano basso` (Solo) and `drone khoomei sygyt kargyraa` (Throat). `sing` with no arguments shows the track's voice; `sing list` lists the presets; `sing <preset> <param> <value>…` applies a preset and overrides; `sing <param> <value>` changes one value and `sing <param> off` returns it to the preset; `sing off` clears the voice and returns the track to the plain `sine` tone, so it sounds the same after a save and reload.

Parameters: `voice` (`auto`, `soprano`, `alto`, `tenor`, `bass`; auto picks one type per part from its median pitch, so an SATB part keeps its own timbre), `vowel` (`a e i o u`, or a morph such as `a>o` across each note), `morph`, `formant` (semitones, a bigger or smaller singer), `bright` (voice quality: breathy to pressed; velocity also presses), `breath`, `jitter`, `shimmer`, `attack`, `release`, `vib`, `vibmod`, `vibdelay` (vibrato that arrives after the onset), `voices` (1 to 8; more than one is a stereo ensemble with seeded scatter of pitch, timing, vibrato and formants), `spread` (cents), `ring` (the singer's formant near 3 kHz), `drone`, `overtone`, `harmonics` and `sub`, and `gain`. Lanes `sing-morph`, `sing-formant`, `sing-bright`, `sing-breath`, `sing-vibmod`, `sing-ring`, `sing-overtone` and `sing-sub` automate them.

Vowels per note: `/note vowel o` (or `a>u`, or `off`) on the selection, last note, a bar or note ids, and `sing vowels a e i o u` cycles vowels over the track's notes. A note's own `vowel` wins over the track's; a note with a `lyric` sings that syllable's vowel. High notes open the jaw: when the pitch rises above the first formant the voice raises it to follow, as trained sopranos do.

Throat singing: `khoomei`, `sygyt` and `kargyraa` hold one drone (`drone D3`, a note name or MIDI number) for each phrase, and each melody note picks the drone harmonic nearest to it (folded by octaves into `harmonics`, 6 to 12 by default) and sharpens the overtone filter onto it, so the melody whistles above the drone. `kargyraa` adds a subharmonic an octave below (`sub`). Without a `drone` of your own, the drone follows the song key: the key root nearest the preset's drone, so sygyt keeps its whistle near 2 kHz and kargyraa its growl near A2 (`sing` and the menu show it as, for example, `drone E2 (key)`). A throat preset on a track with no notes writes an 8-note demo line an octave above the drone, so `sing khoomei` sounds in one step. In play mode a throat track is one voice: a new key releases the last.

Menu: Ctrl-K › Voice › voice presets: a Choir, Solo or Throat preset (space auditions) with the sing rows, with the drone and overtone rows in a Throat sub-menu; on a sung track, the **Vowels** page sets the notes' vowels (Ctrl-K › Sound › performance). The agent tools are `set_sing` and `set_vowels` (both previewable), and `set_instrument` takes the instrument words. In the SDK: `track({ instrument: sing("khoomei", { drone: "D3" }) })`, `instrument: "choir"`, and `note("C4", 0, 1, 0.8, { vowel: "a>o" })`.

### Pitch

dawg can read the melody out of audio: a sampler voice (for example a stem from `resample` or `split_stems`) or, once clips land, an audio clip. Nothing in the score changes until you ask for guide notes.

- `/vocal pitch` reports the focused audio's detected key, median pitch and range with cents (`stem · voice stem · key · a major · median C#4 -8c · range A3 -5c to F#4 +30c · 14 notes`). Add `clip` or `voice` (a sampler voice), optionally followed by its name in any case, to choose the source, and `bass`, `tenor`, `alto` or `soprano` to narrow the search range (auto is 70-1400 Hz; bass goes down to 55 Hz).
- `/vocal pitch trace on` draws the sung pitch over the note highway: one dot per column on the lane of the nearest semitone, in the warning color when it is more than 15 cents off. `/vocal pitch trace off` hides it.
- `/vocal notes` turns the melody into a new guide-notes track (`<track>-notes`, or `as <name>`), one note per sung note, placed through the tempo map where the audio plays. Velocity follows the voicing confidence.
- Ctrl-K › Voice › pitch shows the detected key and median, with Analyze, Trace and Make notes rows.
- Agent tools: `analyze_pitch` (read-only: key, median, range and the note list in file seconds) and `pitch_to_notes`.

The tracker is a pYIN-style estimator on an exact 16 kHz copy of the audio, with a 5 ms hop, a voicing probability per frame and a Viterbi path that resists octave jumps; on the test voices it stays within 10 cents of the truth on held notes and costs about 20 ms per audio second. Curves are cached in `.dawg/analysis/` (`<sha256>.<voice>.v<version>.f0`, at most 64 MB, oldest removed first; `/pack cache` shows the size), so a second look is instant. A corrupt or old cache file is ignored and rebuilt, and the cached and fresh curves are identical.

### Vocoder

A vocoder makes one sound talk with another: a voice (the modulator) shapes the spectrum of an instrument (the carrier) band by band, so the instrument sings the voice's words at the instrument's pitch. dawg's vocoder sits on the carrier track: `vocoder.src` names the voice track, and the carrier is the track itself.

The one-step way: focus a vocal track (a sampler voice or clips) and type `/vocoder`. dawg adds a `<name> vocoder` track playing the built-in carrier, points it at the vocal and mutes the vocal, in one undo step; the carrier follows the song's chords when it has harmonic tracks, otherwise it drones on the song key's root. `/vocal vocoder` is the same command. On a synth track with one vocal in the song, `/vocoder` drives that synth instead. `/vocoder talkbox` or `/vocoder formant 3` on the vocal does the same with those settings, and on a vocal that already drives a carrier `/vocoder` focuses that carrier (`/vocoder new` makes another). With nothing to vocode it changes nothing and says how to bring a voice in. Muting the source does not silence the vocoder: the vocoder listens before the source's mute, volume, pan and sends.

`/vocoder` and `vocode` echo the modulator's license. Vocode only your own recordings or audio you hold the rights to. To vocode your own voice, load a recording of it onto a track (`/sample take.wav`), then `/vocoder talkbox` on that track.

| Command                                      | Does                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/vocoder [preset]`                          | vocode the focused vocal (a new carrier), or set the focused carrier's preset          |
| `/vocoder src <track>`                       | the modulator: a track id or name slug (`lead-vox`); preset words win over track names |
| `/vocoder <param> <value>` / `<param> reset` | set or reset any parameter below (`att` and `rel` are Strudel spellings)               |
| `/vocoder reset` / `off` / `presets`         | back to the preset's values; remove the vocoder; list presets                          |
| `instrument vocoder`                         | the built-in carrier: saw, supersaw, pulse or noise following notes, chords or a drone |

Presets (all 24 bands or fewer): **classic** (70s and 80s band vocoder lead, the default), **robot** (12 bands, a pulse drone), **talkbox** (an LPC mouth filter on a saw), **choir** (stereo supersaw chord pad), **glass** (bright, formant +3), **whisper** (noise carrier), **smear** (long release wash; try `freeze`) and **lofi** (8 narrow bands under 4 kHz).

Register matters for the talkbox: a carrier note sounds only the harmonics of its pitch, so a vowel's first formant (250-700 Hz) needs a carrier fundamental well below it. Keep talkbox chords and lines around A2-A3 (`voicing -8` on a progression, or write them an octave or two down); above about 300 Hz /i/ and /u/ blur into /a/. `/track rm <name>` removes a track and drops any `vocoder.src` that named it, so the carrier plays alone; a project file whose src names a missing track fails `dawg check` with that fix.

| Parameter  | Range                               | Default   | Does                                                                                             |
| ---------- | ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `tap`      | `chain`, `dry`                      | chain     | listen to the source after its mono chain (before pan) or before its effects                     |
| `mode`     | `channel`, `talkbox`                | channel   | a band bank, or an LPC talkbox (order sr/2000, 20 ms frames)                                     |
| `carrier`  | `saw`, `supersaw`, `pulse`, `noise` | supersaw  | the built-in carrier (`instrument vocoder` only)                                                 |
| `follow`   | `notes`, `chords`, `drone`          | notes     | the built-in carrier's pitch: its notes, the song's chords, or `root`                            |
| `root`     | 24..96                              | 45        | the drone pitch (MIDI), and the octave chords are voiced from                                    |
| `spread`   | 0..1 st                             | 0.15      | supersaw detune                                                                                  |
| `bands`    | 4..40                               | 16        | channel bands, spaced evenly in log frequency (heavy above 24)                                   |
| `lo`, `hi` | 50..1000 Hz, 2000..12000 Hz         | 100, 8000 | the lowest and highest band centers                                                              |
| `width`    | 0.25..4                             | 1         | band width as a multiple of the spacing                                                          |
| `attack`   | 0.0005..0.2 s                       | 0.005     | envelope follower attack                                                                         |
| `release`  | 0.005..2 s                          | 0.04      | envelope follower release; long releases smear                                                   |
| `formant`  | ±24 st (talkbox ±12)                | 0         | move the voice's formants: + is smaller and brighter                                             |
| `unvoiced` | 0..1                                | 0.5       | noise in place of the carrier on s, f, sh and t                                                  |
| `sens`     | 0..1                                | 0.5       | how readily a frame counts as unvoiced                                                           |
| `hiss`     | 0..1                                | 0         | the source's top end passed straight through                                                     |
| `gate`     | -90..0 dBFS or `auto`               | auto      | silence below this source level; `auto` reads the source's noise floor                           |
| `enhance`  | on/off                              | on        | whiten the carrier so every band speaks                                                          |
| `depth`    | 0..1                                | 1         | how much the voice shapes the carrier                                                            |
| `freeze`   | on/off                              | off       | hold the last sung vowel through every rest (a `vocoder-freeze` lane holds whatever is sounding) |
| `mix`      | 0..1                                | 1         | wet against the plain carrier                                                                    |
| `gain`     | ±24 dB                              | 0         | output trim (a fixed makeup gain and a soft peak guard at 1.0 come first)                        |
| `seed`     | integer                             | track id  | the unvoiced noise seed                                                                          |

How it works: channel mode splits both signals into the same bands (cascaded RBJ band-passes, laid out from `lo` to `hi` the same at every sample rate), follows each modulator band's level, and multiplies the carrier's band by it. Each band's envelope is advanced by its filter's group delay plus the attack, so consonants stay on time. A formant shift reads the envelopes at a fractional band index. Talkbox mode fits an all-pole mouth filter to each 20 ms frame of the voice (on an absolute hop grid, so windows agree) and runs the carrier through it, which keeps vowels sharper with fewer artefacts. Frames that are both high-band heavy and aperiodic count as unvoiced and get seeded noise (keyed to the song sample) instead of the carrier, as hardware vocoders do with their sibilance switch. A stereo carrier (a supersaw) gets one analysis and two synthesis banks.

Menu: **Ctrl-K › Voice › vocoder**: a Source picker, Preset and one row per parameter; **Ctrl-K › Voice › voice presets** (Vocoder) makes a carrier track or picks a preset. The Mix lane picker lists `vocoder-spread`, `-width`, `-release`, `-formant`, `-unvoiced`, `-hiss`, `-depth`, `-freeze` (a 0/1 step lane), `-mix` and `-gain`. Agent tools: `set_vocoder` (preset, src and a params object; previewable) and `vocode` (makes the carrier from a source and echoes the source's license). In `song.ts`: `vocoder("talkbox", { src: "lead-vox", formant: 2 })` as an instrument or as a track's `vocoder` field (SDK 1.32.0).

Cost: a 16-band channel vocoder renders at about 45 ms per audio-second, talkbox about 10 ms (measured on an M-series Mac); renders reuse the source's cached audio, and an edit to the source's pan, reverb, delay or sends does not re-render the vocoder.

### Autotune

`/autotune hard` corrects the pitch of a track's audio: every clip and every sampler voice on the track, after the sampler's shift step. One word is enough; the default is `pop`. Presets go from hard to gentle:

| Preset    | Sound                                   |
| --------- | --------------------------------------- |
| `hard`    | instant, stepped notes                  |
| `robot`   | stepped on every step of the tuning     |
| `warble`  | hard with wide synthetic vibrato        |
| `trap`    | fast and glossy                         |
| `pop`     | polished but sung (the default)         |
| `natural` | keeps scoops and vibrato                |
| `gentle`  | barely there                            |
| `guided`  | notes to a written melody, vibrato kept |
| `locked`  | hard tune locked to a melody            |

Targets (`to`): `scale` (the default) uses the track or song key and the 0.5 tuning, so maqam, raga and n-EDO tunings work, and with no key it is chromatic; `chromatic` uses every step of the tuning; `chord` follows the chord timeline; `notes` follows another track's notes (`/autotune to notes lead`, a routing edge like a sidechain) or, without `from`, the track's own notes (so `/autotune guided` and `/autotune locked` work in one step; a track with no notes is told which tracks it could follow). A key override that names a maqam or raga (`key D bayati`, `key C yaman`) brings that scale's intonation when neither the song nor the track sets a tuning. The `chord` target leaves out the tuned track, its guide and other vocal or autotuned tracks, so sung pitches never count as chord tones. A note's `drift` expression overrides how much slow drift is removed under it.

Parameters: `speed` 0..400 ms (retune time, 0 is instant; `0.2s` reads as 200 ms), `relax` 0..1 (slower retune on held notes), `hold` 50..1000 ms (when a note counts as held), `flex` 0..100 (higher only pulls notes already near a target, like Antares Flex-Tune), `glide` 0..500 ms (time between targets; a bare number is ms, `40ms` and `0.04s` also work, as with `/glide`), `amount` 0..1, `vib` 0..12 Hz and `vibmod` 0..1 semitones (added vibrato, on voiced frames only), `center` and `drift` 0..1 (notes targets), `key` (overrides the song key) and `voice` (`auto`, `bass`, `tenor`, `alto`, `soprano`: the tracker's range). Corrections are weighted by voicing, guarded against octave errors, and use hysteresis so vibrato does not flip targets.

Reach it as `/autotune [preset] [param value …]`, `/autotune off`, `/autotune presets`, `/vocal autotune …`, Ctrl-K › Voice › autotune (rows for every parameter; left/right adjusts, `x` resets, space auditions), the agent tool `autotune_vocal`, and the SDK: `track({ autotune: "hard" })` or `autotune("pop", { speed: 40 })`. `/tune` stays the tuning command; `/tune hard` hints at `/autotune`.

Rendering is deterministic: tuned spans are cached (128 MB of their own) by the audio's identity (a shifted or fitted sample by its shift or fit key), the settings, the targets and the engine version; with chord or note targets a sampler voice tunes only the frames it plays, and stereo samples keep both channels. In play mode a span longer than 0.25 s plays untuned until its correction is ready; the correction runs in slices so play mode stays responsive. Correction uses the pitch tracker and PSOLA of `/vocal pitch`; a clip is tuned once per placement (its offset and take nudge join the key), and a reversed clip or voice plays untuned. License lines for tuned clips made by `/vocal say` come with `say` in 0.7.1.

## Menus

`/menu` or `Ctrl-K` (on an empty prompt, in play mode too) opens the edit menu, drawn with the same overlay as the model picker. Every edit the agent can make is reachable from it with keys alone. Each row shows a plain label and the current value with its unit (s, Hz, oct, st, dB, BPM, bars); the line under the list describes the focused row and shows, dimmed, the prompt command the row runs, so the menu teaches the commands. `/menu <section>` opens a section directly (`/menu effects`, `/menu tuning`); the old names `parameters`, `sounds`, `track`, `automation` and `transport` still work.

| Section        | Rows (most used first)                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sound          | instrument, preset, the instrument's parameters, **advanced**; **synth filter**; **keys**, **organ**, **guitar** or **granular** when the instrument has them; **track tuning**; **performance** (articulation, glide, bend, vibrato, pedal, humanize); **instruments** (Keys › Electric, Organs · Strings › Bowed · Mallets and bells · Winds and brass · Granular · Wavetable · all instruments · sample packs · use a sample) |
| Voice          | always shown (on a track without a voice it offers "turn this track into a voice"): **sing** (preset, vowels, throat), **lyrics**, **clips**, **pitch**, **autotune**, **formant**, **vocoder**, **voice presets**                                                                                                                                                                                                               |
| Effects        | Filter, Auto filter, Distortion, Tremolo, Compressor, Chorus, Delay, Reverb, Guitar rig, Shoegaze, **more effects** (dj filter, vowel, bitcrush, phaser, leslie, post gain, …); a "voice effects → Voice" row                                                                                                                                                                                                                    |
| Rhythm         | the **euclid editor** (`/euclid`), **grooves** (`/pattern`), **kits** (`/kit`, synth then samples), **grid**                                                                                                                                                                                                                                                                                                                     |
| Chords and key | **key** (tonic, scale), **tuning** (song tuning, reference, root, equal steps, Scala file, ratios, cents, keyboard map), **play** (mode, voicing, spread, bass, sevenths, perform, pattern, arp rate, arp octaves), **progression**, **idiom**                                                                                                                                                                                   |
| Mix            | the focused track's name, mute, solo, volume, pan; **mixer** (every track's level, the drawer's `mix` page); **all tracks** (choosing one focuses it); **automation** (each lane with its points as `beat N  value` rows, add points, ramp, clear lane); **master**                                                                                                                                                              |
| Arrange        | **tracks** (add, focus, rename, move, remove), **sections** (each section's loop, jump, mute, transpose, gain, build, drop, fill, duplicate, move, rename, remove; mark bars, add section), **form**, **style** (find, blend, families)                                                                                                                                                                                          |
| Project        | play, tempo, beats per bar, **tempo and meter**, loop length, grid, click, count-in bars, calibration, **export** (project file, MIDI, WAV, stems), **resample**, **session** (rename, fork, resume), **agent** (model, show-me, model key), **help and guides** (help, guides, keys)                                                                                                                                            |

Breadcrumbs in the docs and guides use these labels, written `Ctrl-K › Chords and key › tuning`. `/menu <topic>` opens the same section that `/help <topic>` and `/guide <topic>` explain.

`/menu <id>` takes one of the ten topic ids (`sound`, `voice`, `effects`, `rhythm`, `chords`, `mix`, `arrange`, `project`, `keys`, `agent`), any topic alias (`drums`, `mixer`, `fx`) or any row name it knows (`tuning`, `performance`, `master`, `export`, `models`, …). `/menu keys` opens the `?` panel. An unknown id answers `no menu "sond" · did you mean /menu sound? · /menu <topic or row>`. In a fader, `x` resets any number row; tempo, meter and loop length apply at once rather than staging, and the hint says `applies at once`. Labels fit 16 columns. Below the root, sibling labels share one case rule. A row's path reads `Ctrl-K › Chords and key › tuning`, and show-me's finish hint uses the same path.

Every list, picker and editor uses the same keys (see **Keys** below). In the menu:

| Key                  | Does                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `↑` `↓` / `k` `j`    | move                                                                                     |
| `Enter`              | open or confirm: open a section, run an action, open a number's fader, keep staged edits |
| `→` / `l`            | go in; on a value row, adjust up                                                         |
| `←` / `h`            | back one level; on a value row, adjust down                                              |
| `-` `+`              | adjust a value by its step (cutoff moves 25%) or cycle a choice                          |
| `Tab` / `Shift-Tab`  | next / previous field (in the fader and the rhythm editor)                               |
| `Space`              | toggle on/off; elsewhere, hear the focused track (see Previewing changes)                |
| `0-9` `.`            | type a value; `Enter` stages it in the fader drawer, `Esc` cancels                       |
| `/`                  | filter the current list by name, value or command                                        |
| `x` / `d` / `Delete` | reset the focused value to its default; on an automation point, remove it                |
| `Esc`                | revert staged edits, else clear the filter, then back one level, then close              |
| `?`                  | the keys for this screen, each key listed once                                           |

The key sets live in `tui/grammar.ts` (`KEY_UP`, `KEY_DOWN`, `KEY_LEFT`, `KEY_RIGHT`, `KEY_TAB`, `KEY_BACKTAB`, …); the menu, fader, rhythm editor and prompt import them. Play mode's `Tab` is a sustain latch, the one documented exception, because letters are notes there.

Automation rows take `beat:value` pairs (`2:800` or `0:200 4:8000`); a ramp is two pairs, start and end, and the renderer interpolates between points. Turning an effect's first field up switches it on with defaults. Each change runs the command it shows through the normal prompt path, so it is one `ScoreOperation`, one receipt, one undo step, and it syncs to other windows and the project files.

## Fader drawer

Editing a number opens a fader drawer: a panel docked directly above the prompt, over the bottom of the piano roll, which stays visible above it. It opens from `Enter` (or a second click) on a number row in the menu, or from a bare parameter at the prompt: `volume`, `pan`, `fx filter` (every filter param, focused on the first number) or `fx reverb mix` (focused on mix). The drawer stacks every param of that device (all of the filter's, or the Mix screen's), so one drawer covers a device.

```text
╭─ menu › Effects › filter ──── loop off · A/B: 1 change staged · enter keep · esc revert ─╮
│   type        lpf │ hpf │ bpf                                                         │
│                                                                                        │
│ › cutoff     1200 Hz ← 800 Hz                                         20 Hz … 20000 Hz │
│   [−] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┃━━━●───────────────────────────────── [+] │
╰──────── ←→ adjust · ⇧←→ coarse · [ ] fine · ↑↓ param · 0-9 type · d default · esc revert ─╯
```

Each field shows its name, current value with unit, the committed value while a change is staged (`1200 Hz ← 800 Hz`), its range, and a bar with `[−]` `[+]` buttons; the bar marks the committed position with `┃`. Wide positive ranges (cutoff, delay time) map on a log scale. Choice params (filter type, presets, on/off) are segmented selectors in the same drawer. Ranges, steps, units and formatting come from the menu row, which takes them from `core/params.ts`, the effect specs and the automation lanes.

Every change is staged on the audition loop (see **Previewing changes**), filed under its field so repeated nudges replace one staged edit; the piano roll and the loop, when it plays, follow at once. `Enter` keeps everything staged as one revision and one undo step; `Esc` reverts. A setting the loop cannot stage (tempo, loop length) applies directly.

| Key                         | In the drawer                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `←` `→` / `-` `+` / `h` `l` | step by the param's step                                                                                      |
| `Shift`-`←` `→` / `{` `}`   | coarse step (five steps)                                                                                      |
| `[` `]` / `Alt`-`←` `→`     | fine step (a tenth of a step; skips detents)                                                                  |
| `PgUp` `PgDn`               | big step (twenty)                                                                                             |
| `Home` `End`                | minimum / maximum                                                                                             |
| `0`-`9` `.`                 | type an exact value; `Enter` sets it, `Esc` cancels                                                           |
| `x` / `d` / `Delete`        | back to the default                                                                                           |
| `↑` `↓` / `Tab` `Shift-Tab` | previous / next param of this device (on a knob page `↑` `↓` pick a knob and `Tab` pages knobs ↔ every param) |
| `Enter`                     | keep every staged change (one undo step); none: close                                                         |
| `Esc`                       | revert staged changes and close                                                                               |
| `Space` `a` `c`             | audition loop · A/B · solo ↔ in context                                                                       |
| `?`                         | these keys                                                                                                    |

### Four knobs

Where a level has them, the drawer opens on four knobs first: the OP-1's four color encoders, the same four on every screen.

| Knob | Color  | Means  | Examples                                     |
| ---- | ------ | ------ | -------------------------------------------- |
| `●`  | blue   | moves  | preset, position, pan, filter type, tempo    |
| `▲`  | green  | sizes  | attack, decay, length, reverb send, feedback |
| `■`  | white  | shapes | filter, tone, brightness, cutoff             |
| `◆`  | orange | level  | track volume, effect mix, loudness target    |

```text
╭─ menu › Sound ───────────────────────────────────────────────────────────────╮
│ ●›preset         pad │ lead │ pluck │ bass │ sub │ acid │ keys │ bell │ ›    │
│ ▲ attack        0.003 s            [−] ───────────────────────────────── [+] │
│ ■ synth filter  off                [−] ───────────────────────────────── [+] │
│ ◆ volume        1 · 0.0 dB         [−] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━● [+] │
╰─────────── ↑↓ knob · ←→ turn · tab all · enter keep · ⇧ coarse · esc revert ─╯
```

The shape glyph always goes with the color, so `NO_COLOR` and the mono theme keep every cue; without Unicode the glyphs are `o ^ # *`. `↑` `↓` pick a knob (an empty slot, drawn `·`, is skipped), `←` `→` turn it, `Shift` turns it coarse and `x` resets it. `Tab` pages to every param of the level (today's drawer) and back. Every turn runs the row's own command (`synth cutoff 1760`, `fx reverb mix 0.3`, `volume 0.8`), so the receipt teaches the words and show-me types the same lines.

The drawer has knobs on Sound (by engine: synth, wavetable, piano, electric, organ, string, wind, modal, sing, granular, sampler, kit), Mix, Mix › master, Project (tempo, loop length, beats per bar) and each effect. Which row each knob turns is one table, `src/tui/knob-map.ts` (`KNOB_MAPS`): four Ctrl-K paths per page, checked against every instrument family by a test, so a patch's macros can later map onto the same four knobs by adding rows. An effect without a row takes its first three number params and its mix.

| Command                                          | Opens                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `synth`                                          | the focused track's sound knobs (and the synth summary receipt)                           |
| `knobs [sound\|mix\|master\|tempo\|fx <effect>]` | that page's four knobs (bare: sound)                                                      |
| `volume` / `pan` / `fx reverb mix`               | the level's knobs, on that knob (a param that is not a knob opens every param)            |
| `mix`                                            | the mixer page: every track's level as an orange fader; `Tab` flips to this track's knobs |

The mixer page is also `Ctrl-K › Mix › mixer`. Each row runs `volume <track> <0..1>` (`volume drums 0.5`, and `pan <track> <-1..1>`), which sets that track without moving the focus.

Detents catch the values people reach for: volume 1 (0 dB), pan 0 (center), whole-number tempo, mix 0, 0.5 and 1, and a filter's octave cutoffs. A drag or step that lands within 2% of the range snaps onto the detent, a key step that jumps over one stops on it, and a fine step skips them. The landing flashes the detent's name for one frame unless `/motion off`. While anything is staged the title reads `A/B: 1 change staged · enter keep · esc revert`, and the badge's key words are click targets.

On a choice, `←` `→` move between options and `1`-`9` pick one by number. Sizes: two rows per field (value line, then bar) while the drawer takes at most half the piano roll; one row per field when shorter, as a window that follows the focused field; and at the 8-row terminal minimum a single borderless row with the focused field. The piano roll always keeps at least 40% of its rows above the drawer (at least three).

## Mouse

dawg turns on SGR mouse reporting (modes 1000, 1002 and 1006) and turns it off again on exit, on `SIGTERM`/`SIGHUP`, on a crash, and around external editors. `--no-mouse` or `DAWG_MOUSE=0` (and `TERM=dumb`) leave it off, so the terminal's own selection and scrollback work; a terminal without mouse support ignores the modes and every key still works. Legacy X10 reports are swallowed rather than typed into the prompt.

| Where                           | Click / wheel                                                        |
| ------------------------------- | -------------------------------------------------------------------- |
| fader `[−]` `[+]`               | step (shift-click: coarse)                                           |
| fader bar                       | set the value at that point; drag to slide it (past the ends clamps) |
| fader option                    | choose it                                                            |
| fader name                      | focus that field                                                     |
| badge `enter keep` `esc revert` | the same as `Enter` / `Esc`                                          |
| wheel on a fader                | step it (up raises; shift: coarse)                                   |
| list / menu row                 | select it; a click on the selected row opens it (`Enter`)            |
| wheel on a list                 | move through it                                                      |
| header `▶/⏸ BPM`                | play / pause                                                         |
| header track name               | the track list (`/tracks`); click a track to focus it                |
| header model                    | the model picker                                                     |

Hit-testing uses the same paint pass that draws the frame: each painter records its click regions into the frame's `HitMap` (`tui/hits.ts`), so targets never drift from what is on screen. The piano roll does not place notes on click (a note needs pitch, length and velocity that a click does not carry); clicks there are ignored.

## Terminal sizes

80x24 is the design target; the UI also works from **60x16** up to as large as the terminal goes, and redraws cleanly on every resize.

**Minimum.** Below 60 columns the play-mode keyboard and the header's bar position drop out and the prompt's spend line clips; below 16 rows the prompt loses its footer and the drawer its last knob. So under 60x16 dawg shows `terminal too small · W×H · need ≥ 60×16`, centered, updating as you resize (ASCII without unicode). Playback, the daemon and the agent keep running; `ctrl-c` and `q` quit, `space` plays or pauses, and every other key is ignored, so nothing changes until the real UI returns, on the first frame the size allows. A 1x1 or 0-column terminal draws nothing and never throws.

**Resize.** `SIGWINCH` bursts from a drag coalesce into at most one frame per 33 ms plus a trailing one (72 signals measured as about 16 repaints). Each size change clears the screen and resets the frame diff, so no stale cells survive. Focus, the selected knob, the menu path, drawer state, the loop and the playhead view are model state and are untouched; scroll positions re-clamp to the new page, and a panel scrolled to its end (the transcript, a guide) stays pinned to the end. Agent streaming and show-me typing carry on through it.

**Large terminals.** Data views use the space, text holds a measure, and no glyph is stretched past legibility:

| View                                      | On a large terminal                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| highway                                   | lanes stop at 10 columns; a wider highway shows more pitches (one to three octaves) and centers the rest; a taller one looks further ahead (at most 4 rows per beat) |
| TAPE                                      | more bars across and every track down, until the song runs out                                                                                                       |
| patch view                                | the node list widens to 44 columns and the ports to 64; a wider or taller matrix shows more cables, then the whole patch                                             |
| drawer (knobs, mixer)                     | rows stop at 96 columns; a wide drawer lists every param of the page beside the four knobs (what Tab shows); a taller drawer fits more mixer tracks                  |
| knob strip                                | each slot at most 40 columns, left-aligned                                                                                                                           |
| help, guides, menus, transcript, `?` keys | a panel at most 100 columns of text, left-aligned; with 36 or more columns free, the song keeps drawing beside it                                                    |
| prompt, header, footer, cards             | full width (one line each; long text truncates with `…`)                                                                                                             |

A steady frame (compose plus encode) stays under 16 ms at 500x150 (measured 2 to 3 ms; text measurement skips grapheme segmentation for ASCII and caches the rest). `bun run sizes` walks every screen through the full size matrix and flags a frame over budget, a wrapped or scrolled frame, a lost header, footer, screen or focus, and a text panel past its measure; `bun run check` runs a sample of it.

## Previewing changes

Hear a sound change before you keep it. In the edit menu (every section: Sound, Effects, Rhythm, Chords, Mix), `Space` starts a short loop of the focused track; `Space` again stops it. The song pauses while the loop plays, so only one thing sounds at a time.

The loop is the track's own notes over its loop when that is four bars or shorter, otherwise the two bars under the playhead (or the track's first two bars with notes, if those are empty). A track with no notes plays a short phrase by role: a chord for pads and keys, a riff for bass and leads, a groove for kits and drums, and one held note for wavetables so position and envelope changes are audible. It plays solo by default; `c` switches to the whole mix with the track in it.

While the loop plays, each change you make is **staged**, not committed. The loop re-renders only the changed track through the normal renderer and stem cache, in the render worker, and swaps it in within about 100 ms (a reverb mix change re-mixes the cached tail and is heard in about 65 ms). Every swap, here and in the song player, crossfades old to new over 20 ms at the same beat, so changes never click; renders and exports never pass through the crossfade. Held keys are coalesced so only the latest value renders. The menu title shows `●` and `B staged N`, and each changed row shows the staged value beside the committed one (`mix  0.5 ← 0.3`).

| Key     | While auditioning                                            |
| ------- | ------------------------------------------------------------ |
| `Space` | start or stop the loop of the focused track                  |
| `c`     | solo ↔ in context (the whole mix with the track)             |
| `←` `→` | change the focused value; staged and heard at once           |
| `a`     | A/B: flip between the committed sound (A) and the staged (B) |
| `Enter` | keep every staged change as one revision and one undo step   |
| `Esc`   | revert staged changes (the score is untouched); again: back  |
| `?`     | the keys for this screen                                     |

Kept changes are one `ScoreOperation` (`preview.commit`, listing the commands), so `Ctrl-Z` takes them all back at once, and they sync to other windows and the project files like any edit. If the score changes underneath (another window, the agent, an undo), the staged commands are re-applied on top of the new score; any that no longer apply are dropped, with a notice. Leaving the menu reverts anything staged. With the loop off, the menu behaves as before: each change is committed right away.

**The rhythm editor and the chord settings stage too.** `/euclid` and the chord settings (the menu's Chords section, `/menu chords`) use the same loop and keys. In `/euclid`, `Space` loops the drum track; pulses, steps, rotate, typed values, a new row, `off` and `freeze` are staged, the title shows `●` and `B staged N`, and a changed lane shows `E(5,16) ← E(4,16)`. Chord settings are window settings rather than score edits, so while the Chords section is open the loop plays the focused track's chord phrase (two bars of the song key's progression, voiced and performed by the current settings: inversion, spread, bass, sevenths, block/strum/arp, pattern); a staged setting changes the B phrase, and `a` flips back to the committed settings. `Enter` keeps every staged change as one undo step: rhythm edits as one `preview.commit` revision, and chord settings applied at once (a key change, the only one stored in the score, as one revision). `Esc` reverts with nothing written. With the loop off, both screens commit each change at once, as before.

**Lists audition on hover.** With the loop on, moving the cursor through a list plays the highlighted item on the loop: the wavetable list (built-in, pack and project tables), instruments, kits and grooves, and every choice list (filter type, warp mode, presets). It is the browser-preview model of Ableton and Bitwig, applied to the loop you are already hearing. Each move replaces the previous hover, so the staged count stays at one, and fast moves skip straight to the latest item. A pack item that has to be fetched shows `fetching…` in the title; the cursor keeps moving and the item plays once it arrives. `Enter` chooses the item (it stays staged until you keep), `Esc` or `←` leaves the list and drops the hover. The `/kit` and `/pattern` pickers work the same way: `Space` starts the loop, moving hears each kit or groove, `Enter` keeps it, `Esc` cancels.

| Key in a list | While auditioning                                   |
| ------------- | --------------------------------------------------- |
| `↑` `↓`       | move and hear the highlighted item on the loop      |
| `Enter`       | choose it (menu) or keep it (picker), one undo step |
| `Esc` / `←`   | leave the list; the hover is dropped                |
| `a` / `c`     | A/B against the committed sound / solo ↔ in context |

**Try a prompt command.** `/try <sound command>` stages one command on the loop instead of committing it: `/try fx reverb mix 0.6`, `/try synth cutoff 800`, `/try wt pwm`. A small panel offers keep or revert; `a` flips A/B, `Enter` on keep commits it as one undo step, `Esc` drops it. Only sound commands can be tried (fx, synth, wt, kit, pattern, pack use, volume, pan and similar).

**What you see.** While the loop plays, the menu title adds a level meter of the looping track or mix: RMS as an eight-cell bar over -48..0 dBFS, the peak in dB, and `!` in the last cell when the loop clips (`♪ solo · B staged 2 · 64 ms · █████··· -9 dB`; the `ms` is the last key-to-swap time). A focused cutoff row draws its low- or high-pass curve on a log axis, an attack/decay/sustain/release row draws the envelope with the other stages, and the wavetable position row marks its place in the table:

```text
│ cutoff (lpf/hpf) or center (bpf) frequency  ▇▇▇▇▇▇▇▇▇▇▇▅▂▁▁▁  › fx filt… │
```

**The agent can listen too.** The `preview_sound {trackId?, changes?, bars?, context?, play?}` tool renders the same loop score for a track, or for candidate sound tool calls (`changes: [{tool: "set_wavetable", args: {...}}]`, any of `set_fx`, `set_synth`, `set_wavetable`, `set_instrument`, `set_sample`, `set_effects`, `set_mix`, `set_automation`, `set_drum_kit`, `use_sound`) applied to a copy of the score. Nothing is committed. It returns RMS and peak dBFS, the spectral centroid and a one-line description for the current and the candidate sound, plus a comparison (`3.0 dB louder, brighter (×2.00 centroid)`). When the window is quiet (no song or audition loop playing) it plays the candidate once, so the agent can say how it sounds before committing with the normal tools. `/try agent off` keeps agent previews silent (numbers only), `/try agent on` turns them back on; `DAWG_AGENT_PREVIEW=off` starts with them off.

The preview renders through the same path as the song, so filters, automation, shared orbit buses, impulse responses and ZzFX voices sound the same as those bars of the full mix. With no audio device (tests, CI, SSH) the loop does nothing audible and everything else works.

## Keys

One grammar for every picker (`/model`, `/pattern`, `/kit`, `/resume`, the wavetable and pack lists), the menu, the `/euclid` editor and the text panels (`/help`, `/tracks`, the transcript):

| Key                         | Does                                                           |
| --------------------------- | -------------------------------------------------------------- |
| `↑` `↓` / `j` `k`           | move (scroll in a text panel); PgUp/PgDn/Home/End page         |
| `←` `→` / `h` `l` / `-` `+` | adjust the focused value                                       |
| `Enter`                     | open or confirm                                                |
| `Space`                     | audition or toggle                                             |
| `/`                         | filter; typing then narrows the list                           |
| `Esc`                       | back one level: clears the filter or a typed value first       |
| `?`                         | the keys for the current screen, drawn over it; any key closes |
| digits                      | type a value, only where a value is focused                    |

The fader drawer adds coarse, fine and big steps, Home/End and `0`/`d` default (see **Fader drawer**); clicks and the wheel mirror these keys (see **Mouse**).

Every screen ends in a one-line footer of its keys that fits 80 columns (parts drop from the middle when narrower; `esc` and `? keys` stay). `?` on an empty prompt lists the prompt keys and the three ways in. Play mode is the one exception: its letters and number row are piano keys and chord latches (the GarageBand "Musical Typing" convention); its `?` panel says so.

## Release

Bump `version` in `package.json` and add its section to `CHANGELOG.md` in a pull request, then merge it. When Check passes on `main`, the annotated `v<version>` tag, the immutable GitHub Release (tarball, `SHA256SUMS` and a provenance attestation) and the npm publish of `@hraness/dawg` follow automatically. See [docs/publishing.md](./docs/publishing.md).
