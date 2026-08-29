---
name: media-preview
description: Turn generated video, audio, and images into a screening page carrying a review brief, then hand back a link. Follows how film and music post-production actually request approval - state the version and stage, scope the ask to a few points, declare what is still WIP, anchor every note to a timecode, mark OK/Retake/Hold, and let automated QC report duration, resolution, loudness, true peak, and missing audio before a human looks. Use right after generating or exporting media, or when asked to "show me a preview", "let me review this", "screening", "check this take", "プレビュー見せて", "試写", "テイクを見たい", "確認したい", or "/media-preview". Do not use for a single still image, or when the user only wants the file path.
allowed-tools: Bash, Read
---

# media-preview

Hands generated media to a reviewer the way a post house does.

A list of files is not a review request. **A review only works when the requester scopes it.**

## Phase 1: Decide the ask (before running anything)

Settle these four before touching the command. Do not run without them.

### 1. Version and stage

Always pass `--version "v3 rough cut"`. The reviewer uses this to decide **what is fair to comment on**. Without a stage, they report every flaw across every stage, and you spend the round trip replying "that part isn't done yet".

### 2. Scope the ask to 1-3 points (`--ask`)

**"Take a look" is not a request.** Each stage has its own questions.

**Film / video**

| Stage | Put in `--ask` | Push to `--wip` (not yet) |
|---|---|---|
| Outline / storyboard | Story flow, pacing of the beats, strength of the open | Image quality, titles, sound |
| Rough cut (offline) | Cut points, rhythm, total runtime | Color, title design, sound mix |
| Fine cut | Whether runtime can be locked | Color |
| Online / color | Grade, consistency across shots | Structure (locked by now) |
| Sound mix | VO against music, intelligibility | Picture |
| Final review / delivery | Typos, spec violations | Structure and direction (not changing) |

**Music**

| Stage | Put in `--ask` | Push to `--wip` |
|---|---|---|
| Demo | Song structure, key, tempo, direction | Fidelity, mix |
| Arrangement | Instrument entries and exits, dynamics | Mix balance |
| Rough mix | Level balance per part, stereo placement | Final loudness |
| Final mix | Vocal depth, reverb amount | Performance |
| Master | Loudness, gap against the reference | Performance and arrangement |

### 3. Declare the WIP (`--wip`)

"Titles are placeholder", "no color grade yet", "scratch VO", "shot 3 not filmed". **An undeclared WIP wastes the reviewer's pass.** The right column above is the source list.

### 4. Spec and deadline (`--spec` / `--due`)

`--spec "under 4:00 / 1920x1080 / -14 LUFS"`, `--due "Aug 31 delivery"`. With a spec written down, the automated QC numbers can be read against something.

## Phase 2: Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/preview-media.mjs" <paths...> \
  --title "Nachi Falls MV — screening" \
  --version "v3 rough cut" \
  --ask "Does the retake at 2:51 read as a deliberate quality call?" \
  --ask "Is the VO drifting against picture around 1:20?" \
  --wip "No color grade, titles are placeholder" \
  --spec "under 4:00 / 1920x1080 / -14 LUFS" \
  --due "Aug 31 delivery" \
  --loudness
```

| Option | Meaning |
|---|---|
| `--version` | Version and stage. **Effectively required** |
| `--ask "..."` | What to check. Repeatable. **Keep it to 1-3.** Omitting it prints a warning |
| `--wip "..."` | Known WIP to skip. Repeatable |
| `--spec` / `--due` / `--changes` | Spec / deadline / what changed since last version |
| `--loudness` | Measure EBU R128 against -14 LUFS / -1 dBTP. **Always pass it when sound is under review** |
| `--since <minutes>` | Only files touched in the last N minutes. Near-required when pointing at a whole working directory |
| `--title` / `--out` / `--no-open` | Heading / output path / skip opening the browser (verification only) |

Paths may be files or directories. Directories recurse 4 levels, skipping `node_modules`, `.git`, `dist`, and dotfiles. Handles video `mp4/mov/webm/m4v/mkv`, audio `mp3/wav/m4a/aac/flac/ogg/opus`, images `png/jpg/jpeg/gif/webp/avif`.

Automated QC (duration, resolution, fps, loudness, true peak, missing audio track) runs before the reviewer looks. **Never ask a human to measure what a machine can.**

## Phase 3: What to write in chat

Paste the `file://` URL from the first output line, then restate the brief. Never post the bare URL alone.

```
Review request — v3 rough cut / 2 files
file:///Users/you/.claude/previews/preview-....html

What to check
1. Does the retake at 2:51 read as a deliberate quality call?
2. Is the VO drifting against picture around 1:20?

Known WIP (skip): no color grade, titles are placeholder
QC flag: the demo recording has no audio track, and the spec calls for sound.

How to reply: 1=OK / 2=Retake / 3=Hold per card, press c while playing to pin a
note to that timecode, then hit "Copy review" and paste it back.
```

Never dump the generated HTML into the terminal.

## Phase 4: Reading the reply

The user pastes this shape:

```
# Review — Nachi Falls MV (v3 rough cut)
## [Retake] demo.mp4
`/path/to/demo.mp4`
- 02:51 Music buries the VO
- 03:20 Typo in the lower third
## [OK] final.mp4
```

How to act on it:

- **Retake** — fix it. A timecoded note means **touch that spot only**. Do not regenerate the whole piece
- **Hold** — the reviewer lacks something to decide with. Ask what is missing (no reference to compare against, stage unclear)
- **Many left unreviewed** — you sent too many files. Narrow with `--since` or explicit paths next time
- **Notes came back on things listed in `--wip`** — the declaration did not land. Move that item directly under the asks next time

## Screening page controls (safe to relay to the user)

- `j` / `k` move, `space` play-pause, `c` pin a note at the current position, `1`/`2`/`3` for OK / Retake / Hold
- Only one stream plays at a time, so a screening never becomes overlapping audio
- Clicking a note's timecode replays from that point
- Verdicts and notes persist in `localStorage` and survive closing the tab
- "Copy review" puts a Markdown summary on the clipboard, ordered Retake → Hold → OK

## When it fails

- **Zero files** — wrong path, or `--since` too tight. Check real files and mtimes with `ls`, then rerun
- **Warned about a missing `--ask`** — go back to Phase 1. Do not send an unscoped review
- **No loudness numbers** — `ffmpeg` is missing (`brew install ffmpeg`). Playback still works
- **Metadata shows size only** — `ffprobe` cannot read that container. Safe to continue
- **Browser does not open** — `open` / `xdg-open` / `start` failed. Pasting the URL in chat still works
- **Media will not play** — codec the browser cannot decode (ProRes, some H.265). Build a proxy with `ffmpeg -i <in> -c:v libx264 -c:a aac <out>.mp4` and pass that instead
