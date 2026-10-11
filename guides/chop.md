---
id: chop
title: Chop audio
parent: sound
order: 5
---

Cut, slice and reshape any audio file into new samples: find the
hits, cut on them, stretch or pitch the result and load the slices
on a sampler. Your original file is never changed.

## Ask

- "slice the break into its hits and put them on a sampler"
- "cut bars 9 to 13 of the song and pitch it down 3"
- "find the other places that sound like the hook"

## Type it yourself

- `chop info break.wav` · `chop onsets break.wav`
- `chop beats break.wav`
- `chop cut break.wav 1.2s 3.4s` (cuts snap to zero crossings)
- `chop slice break.wav --method onset --track chops --pattern`
- `chop pitch vox.wav -3` · `chop stretch loop.wav --bpm 90:120`
- `chop fade hook.wav 10ms 200ms` · `chop normalize hook.wav -1`
- `chop audition samples/hook-cut.wav` plays it
- `chop` lists every op; in a shell, `dawg media chop <op> …`

Times read `1.5`, `1.5s`, `350ms`, `1:02`, `bar:9.1` or `-2s` from
the end. New files go to `tracks/<track>/samples/`.

## Menu

- Ctrl-K › Project › media › chop

## Keys

- Enter on an op row, type the file and values, Enter runs it

## Next

- Tip: stretch and pitch sound best with `rubberband` installed;
  `dawg media doctor` lists what is present
- `guide media` · `guide resample`
