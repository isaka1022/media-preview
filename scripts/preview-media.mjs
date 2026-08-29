#!/usr/bin/env node
// Turns generated media into a screening page carrying a review brief.
// Usage: preview-media.mjs [paths...] [--ask "..."]... [--wip "..."]... [--loudness] ...

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const run = promisify(execFile)

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__', 'Pods'])
const MAX_DEPTH = 4
const DEFAULT_OUT_DIR = path.join(os.homedir(), '.claude', 'previews')

// Streaming platform norms. Drift beyond these gets normalized on playback, or clips.
const TARGET_LUFS = -14
const LUFS_TOLERANCE = 1.5
const TRUE_PEAK_CEILING = -1

const VERDICTS = ['OK', 'Retake', 'Hold']

function parseArgs(argv) {
  const opts = {
    targets: [], title: null, version: null, due: null, spec: null, changes: null,
    asks: [], wips: [], sinceMin: null, out: null, open: true, loudness: false,
  }
  const multi = { '--ask': 'asks', '--wip': 'wips' }
  const single = { '--title': 'title', '--version': 'version', '--due': 'due', '--spec': 'spec', '--changes': 'changes', '--out': 'out' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (multi[a]) opts[multi[a]].push(argv[++i])
    else if (single[a]) opts[single[a]] = argv[++i]
    else if (a === '--since') opts.sinceMin = Number(argv[++i])
    else if (a === '--loudness') opts.loudness = true
    else if (a === '--no-open') opts.open = false
    else opts.targets.push(a)
  }
  if (opts.targets.length === 0) opts.targets.push(process.cwd())
  return opts
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (IMAGE_EXT.has(ext)) return 'image'
  return null
}

async function collect(target, depth = 0) {
  let st
  try {
    st = await stat(target)
  } catch {
    return []
  }
  if (st.isFile()) {
    return kindOf(target) ? [{ file: path.resolve(target), size: st.size, mtime: st.mtimeMs }] : []
  }
  if (!st.isDirectory() || depth > MAX_DEPTH) return []

  const entries = await readdir(target, { withFileTypes: true })
  const found = await Promise.all(
    entries.map((e) => {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) return []
      return collect(path.join(target, e.name), depth + 1)
    })
  )
  return found.flat()
}

// A missing or unreadable ffprobe degrades to size-only metadata rather than failing.
async function probe(file) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=width,height,codec_name,codec_type,channels,sample_rate,r_frame_rate',
      '-of', 'json',
      file,
    ])
    const data = JSON.parse(stdout)
    const v = data.streams?.find((s) => s.codec_type === 'video')
    const a = data.streams?.find((s) => s.codec_type === 'audio')
    let fps = null
    if (v?.r_frame_rate) {
      const [num, den] = v.r_frame_rate.split('/').map(Number)
      if (den) fps = Math.round((num / den) * 100) / 100
    }
    return {
      duration: data.format?.duration ? Number(data.format.duration) : null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps,
      videoCodec: v?.codec_name ?? null,
      audioCodec: a?.codec_name ?? null,
      channels: a?.channels ?? null,
      sampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    }
  } catch {
    return {}
  }
}

// EBU R128, so nobody has to judge level by ear.
async function measureLoudness(file) {
  try {
    const { stderr } = await run(
      'ffmpeg',
      ['-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
      { maxBuffer: 1024 * 1024 * 32 }
    ).catch((e) => ({ stderr: e.stderr ?? '' }))
    const summary = stderr.slice(stderr.lastIndexOf('Integrated loudness'))
    const pick = (label) => {
      const m = summary.match(new RegExp(label + '[:\\s]+(-?\\d+(?:\\.\\d+)?)'))
      return m ? Number(m[1]) : null
    }
    const integrated = pick('I')
    if (integrated == null) return null
    return { integrated, range: pick('LRA'), truePeak: pick('Peak') }
  } catch {
    return null
  }
}

function openInBrowser(file) {
  if (process.platform === 'darwin') return run('open', [file])
  if (process.platform === 'win32') return run('cmd', ['/c', 'start', '', file])
  return run('xdg-open', [file])
}

function fmtSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function fmtDuration(sec) {
  if (sec == null) return null
  const total = Math.round(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

function fmtTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function fileUrl(p) {
  return `file://${p.split('/').map(encodeURIComponent).join('/')}`
}

function specChips(item) {
  const chips = []
  const dur = fmtDuration(item.duration)
  if (dur) chips.push({ label: dur })
  if (item.width && item.height) chips.push({ label: `${item.width}×${item.height}` })
  if (item.fps) chips.push({ label: `${item.fps}fps` })
  if (item.kind === 'audio' && item.sampleRate) {
    chips.push({ label: `${(item.sampleRate / 1000).toFixed(1)}kHz` })
    if (item.channels) chips.push({ label: item.channels === 1 ? 'mono' : item.channels === 2 ? 'stereo' : `${item.channels}ch` })
  }
  chips.push({ label: fmtSize(item.size) })

  if (item.kind === 'video' && item.duration != null && !item.audioCodec) {
    chips.push({
      label: 'no audio',
      state: 'warn',
      hint: 'No audio track. Screen recorders often drop audio, which is how silent masters get shipped.',
    })
  }

  if (item.loudness) {
    const { integrated, truePeak } = item.loudness
    const delta = integrated - TARGET_LUFS
    const off = Math.abs(delta) > LUFS_TOLERANCE
    chips.push({
      label: `${integrated.toFixed(1)} LUFS`,
      state: off ? 'warn' : 'ok',
      hint: off
        ? `${(delta > 0 ? '+' : '')}${delta.toFixed(1)} dB off the ${TARGET_LUFS} LUFS streaming target`
        : `Within tolerance of the ${TARGET_LUFS} LUFS streaming target`,
    })
    if (truePeak != null) {
      const over = truePeak > TRUE_PEAK_CEILING
      chips.push({
        label: `TP ${truePeak.toFixed(1)} dB`,
        state: over ? 'warn' : 'ok',
        hint: over
          ? `Above ${TRUE_PEAK_CEILING} dBTP — may distort after transcoding`
          : `Under ${TRUE_PEAK_CEILING} dBTP`,
      })
    }
  }
  return chips
}

function mediaTag(item) {
  const url = esc(fileUrl(item.file))
  if (item.kind === 'video') return `<video src="${url}" controls preload="metadata" playsinline></video>`
  if (item.kind === 'audio') return `<audio src="${url}" controls preload="metadata"></audio>`
  return `<img src="${url}" alt="${esc(path.basename(item.file))}" loading="lazy">`
}

function renderCard(item, index) {
  const chips = specChips(item)
    .map((c) => `<span class="chip${c.state ? ' ' + c.state : ''}"${c.hint ? ` title="${esc(c.hint)}"` : ''}>${esc(c.label)}</span>`)
    .join('')
  const timed = item.kind !== 'image'

  return `<article class="card ${item.kind}" data-index="${index}" data-path="${esc(item.file)}" data-name="${esc(path.basename(item.file))}">
  <header>
    <span class="badge">${item.kind}</span>
    <h2>${esc(path.basename(item.file))}</h2>
    <span class="verdict-tag"></span>
  </header>
  <div class="media">${mediaTag(item)}</div>
  <div class="chips">${chips}</div>
  <div class="verdict">
    ${VERDICTS.map((v) => `<button class="v-btn" data-verdict="${v}">${v}</button>`).join('\n    ')}
    <span class="hint">${timed ? 'Press <kbd>c</kbd> while playing to pin a note' : 'Press <kbd>c</kbd> to add a note'}</span>
  </div>
  <ul class="comments"></ul>
  <div class="comment-input">
    <span class="tc-label">--:--</span>
    <input type="text" placeholder="What is wrong here? Enter to save, Esc to cancel">
  </div>
  <p class="path" title="Click to copy path">${esc(item.file)}</p>
</article>`
}

function renderBrief(opts, items) {
  const rows = []
  if (opts.version) rows.push(['Version', opts.version])
  if (opts.changes) rows.push(['Changed', opts.changes])
  if (opts.spec) rows.push(['Spec', opts.spec])
  if (opts.due) rows.push(['Due', opts.due])

  const warnings = items.flatMap((i) =>
    specChips(i).filter((c) => c.state === 'warn').map((c) => `${path.basename(i.file)} — ${c.label}: ${c.hint}`)
  )

  return `<section class="brief">
  <h2>Review request</h2>
  ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
  ${
    opts.asks.length
      ? `<div class="ask-block"><h3>What to check</h3><ol>${opts.asks.map((a) => `<li>${esc(a)}</li>`).join('')}</ol></div>`
      : '<div class="ask-block warn-empty"><h3>What to check</h3><p>Not specified — the requester did not scope this review.</p></div>'
  }
  ${
    opts.wips.length
      ? `<div class="wip-block"><h3>Known WIP — skip these</h3><ul>${opts.wips.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
      : ''
  }
  ${
    warnings.length
      ? `<div class="qc-block"><h3>Automated QC flags</h3><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
      : ''
  }
</section>`
}

function renderHtml(opts, items, generatedAt) {
  const totalSize = items.reduce((sum, i) => sum + i.size, 0)
  const counts = items.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {})
  const summary = [
    counts.video ? `${counts.video} video` : null,
    counts.audio ? `${counts.audio} audio` : null,
    counts.image ? `${counts.image} image` : null,
  ]
    .filter(Boolean)
    .join(' / ')
  const title = opts.title ?? `Screening — ${items.length} files`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #14161a; --panel: #1c1f25; --border: #2c313a;
    --fg: #e6e8ec; --muted: #8b93a1; --accent: #7aa2f7; --accent-dim: #2a3450;
    --ok: #7cc47f; --retake: #e06c75; --hold: #d9a441;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  header.top {
    position: sticky; top: 0; z-index: 10; background: rgba(20,22,26,.94);
    backdrop-filter: blur(8px); border-bottom: 1px solid var(--border);
    padding: 12px 24px; display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
  }
  header.top h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 12px; }
  header.top .actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  #progress { font-variant-numeric: tabular-nums; }
  button {
    background: var(--panel); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); color: #0d0f12; border-color: var(--accent); font-weight: 600; }
  button.primary:hover { opacity: .88; color: #0d0f12; }
  kbd { background: #0d0f12; border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; font-size: 11px; }

  .brief {
    margin: 20px 24px 0; background: var(--panel); border: 1px solid var(--border);
    border-left: 3px solid var(--accent); border-radius: 10px; padding: 16px 20px;
  }
  .brief h2 { margin: 0 0 12px; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
  .brief h3 { margin: 0 0 6px; font-size: 12px; color: var(--muted); font-weight: 600; }
  .brief dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 14px; font-size: 13px; }
  .brief dt { color: var(--muted); }
  .brief dd { margin: 0; }
  .brief ol, .brief ul { margin: 0; padding-left: 20px; font-size: 13px; }
  .ask-block { margin-bottom: 12px; }
  .ask-block ol li { margin-bottom: 2px; }
  .wip-block li { color: var(--muted); }
  .qc-block { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px; }
  .qc-block h3 { color: var(--hold); }
  .warn-empty p { color: var(--hold); font-size: 13px; margin: 0; }

  main { padding: 20px 24px 120px; display: grid; gap: 20px; align-items: start; grid-template-columns: repeat(auto-fill, minmax(440px, 1fr)); }
  @media (max-width: 980px) { main { grid-template-columns: 1fr; } }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px; scroll-margin-top: 76px;
  }
  .card.current { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim); }
  .card[data-verdict="OK"] { border-left: 3px solid var(--ok); }
  .card[data-verdict="Retake"] { border-left: 3px solid var(--retake); }
  .card[data-verdict="Hold"] { border-left: 3px solid var(--hold); }
  .card header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .card h2 { margin: 0; font-size: 13px; font-weight: 600; word-break: break-all; flex: 1; }
  .badge {
    font-size: 10px; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; text-transform: uppercase;
    background: var(--accent-dim); color: var(--accent); letter-spacing: .06em;
  }
  .verdict-tag { font-size: 11px; font-weight: 600; flex-shrink: 0; }
  .card[data-verdict="OK"] .verdict-tag { color: var(--ok); }
  .card[data-verdict="Retake"] .verdict-tag { color: var(--retake); }
  .card[data-verdict="Hold"] .verdict-tag { color: var(--hold); }
  .media { background: #0d0f12; border-radius: 6px; overflow: hidden; }
  .media video, .media img { width: 100%; display: block; max-height: 58vh; object-fit: contain; }
  .media audio { width: 100%; display: block; padding: 10px; }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
  .chip {
    font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #0d0f12;
    border: 1px solid var(--border); color: var(--muted); font-variant-numeric: tabular-nums;
  }
  .chip.ok { color: var(--ok); border-color: #2f4a31; cursor: help; }
  .chip.warn { color: var(--hold); border-color: #4a3d1f; cursor: help; }

  .verdict { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
  .v-btn { padding: 4px 12px; }
  .v-btn.on[data-verdict="OK"] { background: var(--ok); color: #0d0f12; border-color: var(--ok); font-weight: 600; }
  .v-btn.on[data-verdict="Retake"] { background: var(--retake); color: #0d0f12; border-color: var(--retake); font-weight: 600; }
  .v-btn.on[data-verdict="Hold"] { background: var(--hold); color: #0d0f12; border-color: var(--hold); font-weight: 600; }
  .verdict .hint { margin-left: auto; color: var(--muted); font-size: 11px; }

  .comments { list-style: none; margin: 0 0 8px; padding: 0; }
  .comments li {
    display: flex; gap: 8px; align-items: flex-start; padding: 5px 8px;
    border-left: 2px solid var(--border); font-size: 13px;
  }
  .comments li:hover { background: #171a1f; border-left-color: var(--accent); }
  .comments .tc {
    color: var(--accent); font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 12px; cursor: pointer; flex-shrink: 0; padding-top: 1px;
  }
  .comments .body { flex: 1; word-break: break-word; }
  .comments .del { color: #5f6773; cursor: pointer; flex-shrink: 0; padding: 0 4px; }
  .comments .del:hover { color: var(--retake); }

  .comment-input { display: none; gap: 8px; align-items: center; margin-bottom: 8px; }
  .comment-input.active { display: flex; }
  .tc-label {
    color: var(--accent); font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 12px; flex-shrink: 0;
  }
  .comment-input input {
    flex: 1; background: #171a1f; color: var(--fg); border: 1px solid var(--accent);
    border-radius: 6px; padding: 6px 10px; font-family: inherit; font-size: 13px;
  }
  .comment-input input:focus { outline: none; }

  .path {
    color: #5f6773; font-size: 11px; margin: 0; word-break: break-all;
    cursor: pointer; font-family: ui-monospace, SFMono-Regular, monospace;
  }
  .path:hover { color: var(--accent); }

  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--accent); color: #0d0f12; padding: 10px 18px; border-radius: 8px;
    font-size: 13px; font-weight: 600; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 20;
  }
  .toast.show { opacity: 1; }
  .empty { padding: 60px 24px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<header class="top">
  <h1>${esc(title)}</h1>
  <span class="sub">${esc(summary)} · ${esc(fmtSize(totalSize))} · ${esc(generatedAt)}</span>
  <span class="sub"><kbd>j</kbd><kbd>k</kbd> move <kbd>space</kbd> play <kbd>c</kbd> comment <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> verdict</span>
  <div class="actions">
    <span class="sub" id="progress"></span>
    <button class="primary" id="copy-review">Copy review</button>
  </div>
</header>
${renderBrief(opts, items)}
<main>
${items.length ? items.map(renderCard).join('\n') : '<p class="empty">No media found.</p>'}
</main>
<div class="toast" id="toast"></div>
<script>
  const REVIEW_TITLE = ${JSON.stringify(title)};
  const REVIEW_VERSION = ${JSON.stringify(opts.version ?? '')};
  const VERDICTS = ${JSON.stringify(VERDICTS)};
  const cards = [...document.querySelectorAll('.card')];
  const toastEl = document.getElementById('toast');
  const progressEl = document.getElementById('progress');
  let current = 0;

  const toast = (msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 1400);
  };

  const fmtTc = (sec) => {
    const t = Math.floor(sec || 0);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  };

  // file:// origins can reject the async clipboard API, so fall back to execCommand.
  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(label);
  };

  const key = (p) => 'mediareview:' + p;
  const load = (p) => {
    try { return JSON.parse(localStorage.getItem(key(p))) || { verdict: null, comments: [] }; }
    catch { return { verdict: null, comments: [] }; }
  };
  const save = (p, state) => {
    try { localStorage.setItem(key(p), JSON.stringify(state)); } catch {}
  };

  const updateProgress = () => {
    const done = cards.filter((c) => c.dataset.verdict).length;
    progressEl.textContent = done + ' / ' + cards.length + ' reviewed';
  };

  const renderComments = (card, state) => {
    const ul = card.querySelector('.comments');
    const media = card.querySelector('video, audio');
    ul.innerHTML = '';
    state.comments
      .slice()
      .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
      .forEach((c) => {
        const li = document.createElement('li');
        const tc = document.createElement('span');
        tc.className = 'tc';
        tc.textContent = c.t == null ? '--:--' : fmtTc(c.t);
        if (media && c.t != null) {
          tc.title = 'Play from here';
          tc.addEventListener('click', () => { media.currentTime = c.t; media.play(); });
        }
        const body = document.createElement('span');
        body.className = 'body';
        body.textContent = c.text;
        const del = document.createElement('span');
        del.className = 'del';
        del.textContent = '×';
        del.title = 'Delete';
        del.addEventListener('click', () => {
          state.comments = state.comments.filter((x) => x !== c);
          save(card.dataset.path, state);
          renderComments(card, state);
        });
        li.append(tc, body, del);
        ul.appendChild(li);
      });
  };

  const setVerdict = (card, state, verdict) => {
    state.verdict = state.verdict === verdict ? null : verdict;
    save(card.dataset.path, state);
    if (state.verdict) card.dataset.verdict = state.verdict;
    else delete card.dataset.verdict;
    card.querySelector('.verdict-tag').textContent = state.verdict ?? '';
    card.querySelectorAll('.v-btn').forEach((b) => b.classList.toggle('on', b.dataset.verdict === state.verdict));
    updateProgress();
  };

  const openCommentInput = (card, state) => {
    const media = card.querySelector('video, audio');
    const box = card.querySelector('.comment-input');
    const input = box.querySelector('input');
    const t = media ? media.currentTime : null;
    if (media && !media.paused) media.pause();
    box.querySelector('.tc-label').textContent = t == null ? '--:--' : fmtTc(t);
    box.classList.add('active');
    input.value = '';
    input.focus();

    const commit = () => {
      const text = input.value.trim();
      box.classList.remove('active');
      if (!text) return;
      state.comments.push({ t: t == null ? null : Math.floor(t), text });
      save(card.dataset.path, state);
      renderComments(card, state);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); box.classList.remove('active'); }
      e.stopPropagation();
    };
    input.onblur = () => box.classList.remove('active');
  };

  const states = new Map();
  cards.forEach((card) => {
    const state = load(card.dataset.path);
    states.set(card, state);
    if (state.verdict) {
      card.dataset.verdict = state.verdict;
      card.querySelector('.verdict-tag').textContent = state.verdict;
      card.querySelectorAll('.v-btn').forEach((b) => b.classList.toggle('on', b.dataset.verdict === state.verdict));
    }
    renderComments(card, state);
    card.querySelectorAll('.v-btn').forEach((b) =>
      b.addEventListener('click', () => setVerdict(card, state, b.dataset.verdict))
    );
    card.querySelector('.path').addEventListener('click', () => copy(card.dataset.path, 'Path copied'));
  });

  const focusCard = (i) => {
    if (!cards.length) return;
    current = Math.max(0, Math.min(cards.length - 1, i));
    cards.forEach((c, idx) => c.classList.toggle('current', idx === current));
    cards[current].scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey) return;
    const card = cards[current];
    if (e.key === 'j') { e.preventDefault(); focusCard(current + 1); }
    else if (e.key === 'k') { e.preventDefault(); focusCard(current - 1); }
    else if (e.key === ' ') {
      const m = card?.querySelector('video, audio');
      if (!m) return;
      e.preventDefault();
      m.paused ? m.play() : m.pause();
    }
    else if (e.key === 'c' && card) { e.preventDefault(); openCommentInput(card, states.get(card)); }
    else if (['1', '2', '3'].includes(e.key) && card) {
      e.preventDefault();
      setVerdict(card, states.get(card), VERDICTS[Number(e.key) - 1]);
    }
  });

  // One stream at a time, so a screening never turns into overlapping audio.
  document.querySelectorAll('video, audio').forEach((m) => {
    m.addEventListener('play', () => {
      document.querySelectorAll('video, audio').forEach((o) => { if (o !== m) o.pause(); });
      focusCard(cards.findIndex((c) => c.contains(m)));
    });
  });

  document.getElementById('copy-review').addEventListener('click', () => {
    const lines = ['# Review — ' + REVIEW_TITLE + (REVIEW_VERSION ? ' (' + REVIEW_VERSION + ')' : '')];
    const order = { Retake: 0, Hold: 1, OK: 2 };
    const reviewed = cards
      .map((c) => ({ card: c, state: states.get(c) }))
      .filter((x) => x.state.verdict || x.state.comments.length)
      .sort((a, b) => (order[a.state.verdict] ?? 3) - (order[b.state.verdict] ?? 3));

    if (!reviewed.length) return toast('Nothing marked yet');

    reviewed.forEach(({ card, state }) => {
      lines.push('', '## [' + (state.verdict ?? 'unmarked') + '] ' + card.dataset.name);
      lines.push('\`' + card.dataset.path + '\`');
      state.comments
        .slice()
        .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
        .forEach((c) => lines.push('- ' + (c.t == null ? '' : fmtTc(c.t) + ' ') + c.text));
      if (!state.comments.length) lines.push('- (no notes)');
    });

    const untouched = cards.length - reviewed.length;
    if (untouched > 0) lines.push('', 'Not reviewed: ' + untouched);
    copy(lines.join('\\n'), 'Review copied');
  });

  updateProgress();
  focusCard(0);
</script>
</body>
</html>`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  const collected = (await Promise.all(opts.targets.map((t) => collect(t)))).flat()
  const seen = new Set()
  let items = collected.filter((i) => !seen.has(i.file) && seen.add(i.file))

  if (opts.sinceMin != null) {
    const cutoff = Date.now() - opts.sinceMin * 60_000
    items = items.filter((i) => i.mtime >= cutoff)
  }

  items.sort((a, b) => b.mtime - a.mtime)
  items = await Promise.all(
    items.map(async (i) => ({ ...i, kind: kindOf(i.file), ...(await probe(i.file)) }))
  )

  if (opts.loudness) {
    items = await Promise.all(
      items.map(async (i) => (i.kind === 'image' ? i : { ...i, loudness: await measureLoudness(i.file) }))
    )
  }

  const out =
    opts.out ?? path.join(DEFAULT_OUT_DIR, `preview-${new Date().toISOString().replace(/[:.]/g, '-')}.html`)

  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, renderHtml(opts, items, fmtTime(Date.now())), 'utf8')

  if (opts.open) await openInBrowser(out).catch(() => {})

  const by = (k) => items.filter((i) => i.kind === k).length
  console.log(fileUrl(path.resolve(out)))
  console.log(`${items.length} files (${by('video')} video / ${by('audio')} audio / ${by('image')} image)`)
  if (!opts.asks.length) console.log('warning: no --ask given. Scope the review before sending it.')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
