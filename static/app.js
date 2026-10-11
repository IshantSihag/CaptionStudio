/* Caption Studio — frontend logic (vanilla JS, no dependencies) */
'use strict';

/* ============================ helpers ============================ */
const $ = (id) => document.getElementById(id);
const qs = (sel, root) => (root || document).querySelector(sel);

async function api(path, opts) {
  const init = { method: (opts && opts.method) || 'GET' };
  if (opts && opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  const resp = await fetch(path, init);
  let data = {};
  try { data = await resp.json(); } catch (e) { /* empty body */ }
  if (!resp.ok) throw new Error(data.error || ('Request failed (' + resp.status + ')'));
  return data;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

// Exact clock for the paused cursor position: H:MM:SS.cc (centisecond precision,
// matching ASS timestamps, e.g. 304.46s -> 0:05:04.46).
function fmtClockMs(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return h + ':' + String(m).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

function toast(message, kind, action) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.fn(); el.remove(); });
    el.appendChild(btn);
  }
  box.appendChild(el);
  setTimeout(() => el.remove(), action ? 7000 : (kind === 'error' ? 6000 : 3200));
}

/* ============================ ASS toolkit (JS mirror) ============================ */
const DEFAULT_EVENT_FIELDS = ['Layer', 'Start', 'End', 'Style', 'Name',
  'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
const DEFAULT_STYLE_FIELDS = ['Name', 'Fontname', 'Fontsize', 'PrimaryColour',
  'SecondaryColour', 'OutlineColour', 'BackColour', 'Bold', 'Italic', 'Underline',
  'StrikeOut', 'ScaleX', 'ScaleY', 'Spacing', 'Angle', 'BorderStyle', 'Outline',
  'Shadow', 'Alignment', 'MarginL', 'MarginR', 'MarginV', 'Encoding'];

function parseAssTime(v) {
  v = String(v).trim();
  let m = v.match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
  m = v.match(/^(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (m) return (+m[1]) * 60 + (+m[2]) + (+m[3].padEnd(3, '0')) / 1000;
  const f = parseFloat(v);
  if (!isNaN(f)) return f;
  throw new Error('Bad time: ' + v);
}

function fmtAssTime(sec) {
  let cs = Math.max(0, Math.round((sec || 0) * 100));
  const h = Math.floor(cs / 360000); cs -= h * 360000;
  const m = Math.floor(cs / 6000); cs -= m * 6000;
  const s = Math.floor(cs / 100); cs -= s * 100;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

function sectionIndex(lines, name) {
  const want = name.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === want) return i;
  }
  return -1;
}

function sectionEnd(lines, start) {
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('[') && t.endsWith(']')) return i;
  }
  return lines.length;
}

function findFormatIndex(lines, from, to) {
  for (let i = from; i < to; i++) {
    if (lines[i].trim().toLowerCase().startsWith('format:')) return i;
  }
  return -1;
}

function formatFields(line, fallback) {
  const idx = line.indexOf(':');
  if (idx < 0) return fallback.slice();
  const fields = line.slice(idx + 1).split(',').map((f) => f.trim());
  return fields.some((f) => f) ? fields : fallback.slice();
}

function splitFields(payload, fields) {
  const parts = payload.split(',');
  if (parts.length > fields.length) {
    const rest = parts.splice(fields.length - 1).join(',');
    parts.push(rest);
  }
  while (parts.length < fields.length) parts.push('');
  return parts;
}

function parseCuesFromAss(text) {
  const lines = text.split('\n');
  const ev = sectionIndex(lines, '[Events]');
  if (ev < 0) throw new Error('No [Events] section');
  const end = sectionEnd(lines, ev);
  const fmtIdx = findFormatIndex(lines, ev + 1, end);
  const fields = fmtIdx >= 0 ? formatFields(lines[fmtIdx], DEFAULT_EVENT_FIELDS)
                             : DEFAULT_EVENT_FIELDS.slice();
  const startFrom = (fmtIdx >= 0 ? fmtIdx : ev) + 1;
  const cues = [];
  for (let i = startFrom; i < end; i++) {
    const low = lines[i].trim().toLowerCase();
    if (!low.startsWith('dialogue:')) continue;
    const payload = lines[i].slice(lines[i].indexOf(':') + 1).replace(/^ */, '');
    const vals = splitFields(payload, fields);
    const data = {};
    fields.forEach((f, k) => { data[f] = vals[k]; });
    let start, ende;
    try { start = parseAssTime(data.Start); ende = parseAssTime(data.End); } catch (e) { continue; }
    const extras = {};
    fields.forEach((f) => { if (f !== 'Start' && f !== 'End' && f !== 'Text') extras[f] = data[f]; });
    const ov = extractOverrides(data.Text || '');
    cues.push({
      start, end: ende, text: ov.text, style: data.Style || 'Default', extras,
      color: ov.color, bold: ov.bold, italic: ov.italic,
      borderX: ov.borderX, borderY: ov.borderY,
    });
  }
  if (!cues.length && !/dialogue:/i.test(text)) throw new Error('No captions found');
  return cues;
}

/* ---- per-caption override tags ({\1c&HBBGGRR&\b1\i1\xbord2\ybord5}) ----
   The managed tags are lifted out of the text into cue.color / cue.bold /
   cue.italic / cue.borderX / cue.borderY so the editor can show clean text
   and proper controls; any other tag the user typed by hand (\pos, \fn, \t, …)
   stays exactly where it was.

   \bord / \xbord / \ybord are ASS override tags that set the outline/box
   thickness separately on the horizontal and vertical axes — this is the only
   way to give a caption box different horizontal vs vertical padding, because
   the style section itself has a single Outline value. */
function hexToAssInline(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return '';
  const rgb = m[1];
  return '&H' + rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
}

function ovNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function extractOverrides(text) {
  const out = { text: String(text == null ? '' : text), color: null, bold: null, italic: null,
                borderX: null, borderY: null };
  const m = /^\{([^{}]*)\}/.exec(out.text);
  if (!m) return out;
  let inner = m[1];
  let changed = false;

  const cm = /\\(?:1c|c)\s*&H([0-9a-fA-F]{6})&/.exec(inner);
  if (cm) { out.color = assColorToHex('&H' + cm[1]); inner = inner.replace(cm[0], ''); changed = true; }
  const bm = /\\b([01])(?![0-9])/.exec(inner);
  if (bm) { out.bold = bm[1] === '1'; inner = inner.replace(bm[0], ''); changed = true; }
  const im = /\\i([01])(?![0-9])/.exec(inner);
  if (im) { out.italic = im[1] === '1'; inner = inner.replace(im[0], ''); changed = true; }

  // \bord sets both axes; \xbord / \ybord each set one axis.
  const xm = /\\(?:bord|xbord)\s*(\d+(?:\.\d+)?)/.exec(inner);
  if (xm) {
    const v = ovNum(xm[1]);
    out.borderX = v;
    if (xm[0][1] === 'b') out.borderY = v;   // plain \bord sets both axes
    inner = inner.replace(xm[0], '');
    changed = true;
  }
  const ym = /\\ybord\s*(\d+(?:\.\d+)?)/.exec(inner);
  if (ym) { out.borderY = ovNum(ym[1]); inner = inner.replace(ym[0], ''); changed = true; }

  if (!changed) return out;
  const kept = inner.trim() ? '{' + inner + '}' : '';
  out.text = kept + out.text.slice(m[0].length);
  return out;
}

function ovFmt(v) {
  const n = Math.round(v * 10) / 10;
  return String(Math.round(n) === n ? Math.round(n) : n);
}

function composeOverrides(cue) {
  if (!cue) return '';
  const parts = [];
  if (cue.color) {
    const c = hexToAssInline(cue.color);
    if (c) parts.push('\\1c' + c + '&');
  }
  if (cue.bold != null) parts.push(cue.bold ? '\\b1' : '\\b0');
  if (cue.italic != null) parts.push(cue.italic ? '\\i1' : '\\i0');
  if (cue.borderX != null || cue.borderY != null) {
    const bx = cue.borderX != null ? ovFmt(cue.borderX) : ovFmt(cue.borderY);
    const by = cue.borderY != null ? ovFmt(cue.borderY) : ovFmt(cue.borderX);
    if (bx === by) parts.push('\\bord' + bx);
    else {
      if (cue.borderX != null) parts.push('\\xbord' + bx);
      if (cue.borderY != null) parts.push('\\ybord' + by);
    }
  }
  return parts.length ? '{' + parts.join('') + '}' : '';
}

function composeDialogue(cue, fields, defaultStyle) {
  const ex = cue.extras || {};
  const values = fields.map((f) => {
    if (f === 'Start') return fmtAssTime(cue.start);
    if (f === 'End') return fmtAssTime(cue.end);
    if (f === 'Text') return composeOverrides(cue) + (cue.text || '');
    if (f === 'Layer') return ex.Layer || '0';
    if (f === 'Style') return ex.Style || cue.style || defaultStyle;
    if (f === 'MarginL' || f === 'MarginR' || f === 'MarginV') return ex[f] || '0';
    return ex[f] || '';
  });
  return 'Dialogue: ' + values.join(',');
}

function firstStyleName(text) {
  const lines = text.split('\n');
  const st = sectionIndex(lines, '[V4+ Styles]') >= 0 ? sectionIndex(lines, '[V4+ Styles]')
                                                     : sectionIndex(lines, '[V4 Styles]');
  if (st < 0) return 'Default';
  const end = sectionEnd(lines, st);
  for (let i = st + 1; i < end; i++) {
    const low = lines[i].trim().toLowerCase();
    if (low.startsWith('style:')) {
      return lines[i].slice(lines[i].indexOf(':') + 1).split(',')[0].trim() || 'Default';
    }
  }
  return 'Default';
}

function rebuildAss(text, cues) {
  const lines = text.split('\n');
  const ev = sectionIndex(lines, '[Events]');
  if (ev < 0) return text;
  const end = sectionEnd(lines, ev);
  const fmtIdx = findFormatIndex(lines, ev + 1, end);
  const fields = fmtIdx >= 0 ? formatFields(lines[fmtIdx], DEFAULT_EVENT_FIELDS)
                             : DEFAULT_EVENT_FIELDS.slice();
  const startFrom = (fmtIdx >= 0 ? fmtIdx : ev) + 1;
  let firstEv = -1, lastEv = -1;
  for (let i = startFrom; i < end; i++) {
    const low = lines[i].trim().toLowerCase();
    if (low.startsWith('dialogue:') || low.startsWith('comment:')) {
      if (firstEv < 0) firstEv = i;
      lastEv = i;
    }
  }
  const dstyle = firstStyleName(text);
  const newEvents = cues.map((c) => composeDialogue(c, fields, dstyle));
  if (firstEv < 0) {
    return lines.slice(0, startFrom).concat(newEvents, lines.slice(startFrom)).join('\n');
  }
  return lines.slice(0, firstEv).concat(newEvents, lines.slice(lastEv + 1)).join('\n');
}

/* ---- style helpers ---- */
function assColorParts(value) {
  let h = String(value == null ? '' : value).replace(/^&H/i, '');
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  h = h.padStart(8, '0');
  return {
    alpha: h.slice(0, 2),
    b: h.slice(2, 4), g: h.slice(4, 6), r: h.slice(6, 8),
  };
}
function assColorToHex(value) {
  const p = assColorParts(value);
  if (!p) return '#ffffff';
  return '#' + p.r + p.g + p.b;
}
function assColorToCss(value) {
  const p = assColorParts(value);
  if (!p) return 'rgb(255,255,255)';
  return 'rgb(' + parseInt(p.r, 16) + ',' + parseInt(p.g, 16) + ',' + parseInt(p.b, 16) + ')';
}
function assColorAlpha(value) {
  const p = assColorParts(value);
  if (!p) return 1;
  return 1 - parseInt(p.alpha, 16) / 255;
}
function hexToAssColor(hex, keepOriginal, opacity) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return keepOriginal || '&H00FFFFFF';
  const rgb = m[1];
  let alphaHex;
  if (opacity == null) {
    const keep = assColorParts(keepOriginal);
    alphaHex = keep ? keep.alpha : '00';
  } else {
    const a = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255);
    alphaHex = a.toString(16).padStart(2, '0');
  }
  return ('&H' + alphaHex + rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2)).toUpperCase();
}

function readStyle(text) {
  const lines = text.split('\n');
  const stSec = sectionIndex(lines, '[V4+ Styles]') >= 0 ? sectionIndex(lines, '[V4+ Styles]')
                                                        : sectionIndex(lines, '[V4 Styles]');
  const info = { playresX: 384, playresY: 288 };
  const inf = sectionIndex(lines, '[Script Info]');
  if (inf >= 0) {
    const infEnd = sectionEnd(lines, inf);
    for (let i = inf + 1; i < infEnd; i++) {
      const m = lines[i].match(/^\s*PlayResX\s*:\s*(\d+)/i); if (m) info.playresX = +m[1];
      const my = lines[i].match(/^\s*PlayResY\s*:\s*(\d+)/i); if (my) info.playresY = +my[1];
    }
  }
  if (stSec < 0) return Object.assign(info, defaultStyleValues());
  const end = sectionEnd(lines, stSec);
  const fmtIdx = findFormatIndex(lines, stSec + 1, end);
  const fields = fmtIdx >= 0 ? formatFields(lines[fmtIdx], DEFAULT_STYLE_FIELDS)
                             : DEFAULT_STYLE_FIELDS.slice();
  for (let i = (fmtIdx >= 0 ? fmtIdx : stSec) + 1; i < end; i++) {
    if (!lines[i].trim().toLowerCase().startsWith('style:')) continue;
    const payload = lines[i].slice(lines[i].indexOf(':') + 1).replace(/^ */, '');
    const vals = splitFields(payload, fields);
    const data = {};
    fields.forEach((f, k) => { data[f] = vals[k]; });
    return Object.assign(info, {
      name: data.Name || 'Default',
      font: data.Fontname || 'Arial',
      size: parseFloat(data.Fontsize) || 30,
      bold: (parseInt(data.Bold, 10) || 0) < 0 || data.Bold === '-1',
      color: data.PrimaryColour || '&H00FFFFFF',
      outlineColor: data.OutlineColour || '&H00000000',
      outlineOpacity: assColorAlpha(data.OutlineColour || '&H00000000'),
      border: parseInt(data.BorderStyle, 10) || 1,
      outline: (function () { const v = parseFloat(data.Outline); return isNaN(v) ? 1 : v; })(),
      align: parseInt(data.Alignment, 10) || 2,
      marginV: parseFloat(data.MarginV) || 10,
    });
  }
  return Object.assign(info, defaultStyleValues());
}

function defaultStyleValues() {
  return { name: 'Default', font: 'Arial', size: 30, bold: false,
    color: '&H00FFFFFF', outlineColor: '&H00000000', outlineOpacity: 1, border: 1,
    outline: 2, align: 2, marginV: 12 };
}

function updateStyleInText(text, updates) {
  const lines = text.split('\n');
  const stSec = sectionIndex(lines, '[V4+ Styles]') >= 0 ? sectionIndex(lines, '[V4+ Styles]')
                                                        : sectionIndex(lines, '[V4 Styles]');
  if (stSec < 0) return text;
  const end = sectionEnd(lines, stSec);
  const fmtIdx = findFormatIndex(lines, stSec + 1, end);
  const fields = fmtIdx >= 0 ? formatFields(lines[fmtIdx], DEFAULT_STYLE_FIELDS)
                             : DEFAULT_STYLE_FIELDS.slice();
  for (let i = (fmtIdx >= 0 ? fmtIdx : stSec) + 1; i < end; i++) {
    if (!lines[i].trim().toLowerCase().startsWith('style:')) continue;
    const payload = lines[i].slice(lines[i].indexOf(':') + 1).replace(/^ */, '');
    const vals = splitFields(payload, fields);
    fields.forEach((f, k) => {
      if (Object.prototype.hasOwnProperty.call(updates, f)) vals[k] = String(updates[f]);
    });
    lines[i] = 'Style: ' + vals.join(',');
    break;
  }
  return lines.join('\n');
}

/* ============================ app state ============================ */
let st = null;            // last server state
let project = null;
let job = null;
let platform = 'darwin';
let activeScreen = 'setup';
let handledKey = null;
let logLen = 0;
let logBuffer = [];
let elapsedTimer = null;

let assText = '';
let assRev = 0;
let dirty = false;
let saving = false;
let saveTimer = null;
let cues = [];
let cuesValid = true;
let styleInfo = null;
let currentTab = 'cues';
let lastDeleted = null;
let refreshTimer = null;
let frameSeq = 0;          // render token: lets a superseded fetch discard its result
let frameErrorShown = false;
let activeCueIdx = -1;
let openStyleRow = -1;      // cue row whose per-caption style panel is open

/* The exact-frame preview renders at this position. It is our own tracked
   value rather than a live read of <video>.currentTime: some browsers reset
   the video clock (back to 0) when the layout changes — e.g. switching
   between the Captions and Style tabs — and a live read would then make every
   "Rendering exact frame…" preview show the first caption. frameTime is
   updated from every genuine position source (play/pause/seek events, the
   Go button, the timeline, and the arrow keys), so a bounced clock can never
   drag the preview back to the start. */
let frameTime = 0;
// Authoritative position for an explicit Go-button jump. The browser snaps
// player.currentTime to a video frame boundary when seeking, and the
// seeking/seeked handlers would otherwise overwrite frameTime with that
// snapped value — which can land a frame BEFORE c.start and, when the previous
// caption ends exactly at c.start, reactivate the previous caption. While
// jumpTarget is set, the seek handlers trust the requested position instead.
let jumpTarget = null;

function notePreviewTime(t) {
  if (t == null || !isFinite(t) || t < 0) return;
  frameTime = t;
}

function previewTime() {
  return frameTime;
}

const player = $('player');
const playerBox = $('playerBox');
const frameImg = $('frameImg');
const frameBusy = $('frameBusy');
const capOverlay = $('capOverlay');

/* ============================ loading cursor ============================
   Turns the mouse cursor into a "wait" cursor while heavy work is running
   (a pipeline/export job or a frame-preview render) so the user knows to
   wait. Two flags are tracked independently so overlapping busy states
   don't flicker the cursor. */
let busyJob = false;
let busyFrame = false;

function updateBodyCursor() {
  document.body.classList.toggle('loading', busyJob || busyFrame);
}

function setFrameBusy(show) {
  const next = !!show;
  frameBusy.classList.toggle('hidden', !next);
  if (busyFrame !== next) {
    busyFrame = next;
    updateBodyCursor();
  }
}

/* ============================ screens ============================ */
function show(name) {
  const changed = name !== activeScreen;
  activeScreen = name;
  ['setup', 'work', 'editor', 'export'].forEach((s) => {
    $('screen-' + s).classList.toggle('hidden', s !== name);
  });
  if (name !== 'work') { setFrameBusy(false); }
  if (changed && activeScreen !== 'editor') {
    // leaving the editor: stop playback and show a fresh still frame later
    if (player && !player.paused && !player.ended) player.pause();
    capOverlay.classList.add('hidden');
  }
  if (changed && name === 'editor') scheduleFrameRefresh(0);
  updateTopbar();
}

function updateTopbar() {
  const ready = !!(project && project.captions_ready);
  const busy = !!(job && job.status === 'running');
  $('btnExport').classList.toggle('hidden', !(ready && (activeScreen === 'editor') && !busy));
  $('btnRegenerate').classList.toggle('hidden', !(ready && activeScreen === 'editor' && !busy));
  $('btnStartOver').classList.toggle('hidden', !(project && activeScreen === 'editor'));
}

/* ============================ setup screen ============================ */
function renderTools(tools) {
  const banner = $('toolBanner');
  const okBox = $('toolOk');
  if (!tools || !tools.items) return;
  const missing = tools.items.filter((i) => !i.ok);
  if (tools.ok) {
    banner.classList.add('hidden');
    okBox.classList.remove('hidden');
    okBox.textContent = '✓ ffmpeg and whisper-ctranslate2 are installed — everything is ready.';
    $('helpBox').open = false;
  } else {
    okBox.classList.add('hidden');
    banner.classList.remove('hidden');
    const hintKey = platform === 'darwin' ? 'hint_mac' : (platform === 'win32' ? 'hint_win' : 'hint_linux');
    banner.innerHTML =
      '<h3>⚠ Installation for tools is not proper</h3>' +
      '<p>Caption Studio needs two tools and ' +
      esc(missing.map((m) => m.name).join(' & ')) +
      (missing.length > 1 ? ' were' : ' was') + ' not found on this computer:</p>' +
      '<ul class="missing">' +
      missing.map((m) => '<li><b>' + esc(m.name) + '</b> — ' + esc(m[hintKey]) + '</li>').join('') +
      '</ul>' +
      '<p class="muted" style="margin-bottom:0">Install them, then click “Check again”.</p>';
    $('helpBox').open = true;
  }
  const disabled = !tools.ok;
  $('btnChoose').disabled = disabled;
  $('btnUsePath').disabled = disabled;
}

async function recheckTools() {
  try {
    const tools = await api('/api/recheck_tools', { method: 'POST', body: {} });
    st = st || {}; st.tools = tools;
    renderTools(tools);
    if (tools.ok) toast('All tools found — you are good to go!', 'ok');
  } catch (e) {
    toast('Could not re-check: ' + e.message, 'error');
  }
}

async function chooseVideo() {
  const btn = $('btnChoose');
  btn.disabled = true;
  btn.textContent = 'Opening the file picker…';
  try {
    const res = await api('/api/pick_video', { method: 'POST', body: {} });
    if (res.status === 'ok') {
      $('pathInput').value = res.path;
      await startProject(res.path);
    } else if (res.status === 'unavailable') {
      toast('The file dialog could not open — paste the file path below instead.', 'error');
      $('pathInput').focus();
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = !(st && st.tools && st.tools.ok);
    btn.textContent = 'Choose a video file…';
  }
}

async function startProject(path) {
  $('setupMsg').textContent = '';
  try {
    const res = await api('/api/start', { method: 'POST', body: { path } });
    project = res.project;
    handledKey = res.job ? res.job.id + ':' + res.job.status : null;
    if (res.status === 'ready') {
      await enterEditor(true);
      toast('Found existing captions for this video — loaded them.', 'ok');
    } else {
      job = res.job;
      logBuffer = []; logLen = 0;
      renderWork();
      show('work');
    }
  } catch (e) {
    $('setupMsg').textContent = e.message;
  }
}

/* ============================ work screen ============================ */
function renderWork() {
  if (!job) return;
  $('workTitle').textContent = job.kind === 'export' ? 'Exporting your video…' : 'Preparing your captions…';
  $('workFile').textContent = project ? project.video_name : '';

  const stages = job.stages || [];
  const list = $('stepList');
  list.innerHTML = '';
  stages.forEach((s, i) => {
    const li = document.createElement('li');
    let cls = '', icon = '·';
    if (job.status === 'error' && i === job.stage_index) { cls = 'error'; icon = '✕'; }
    else if (i < job.stage_index || job.status === 'done') { cls = 'done'; icon = '✓'; }
    else if (i === job.stage_index && job.status === 'running') { cls = 'active'; icon = '…'; }
    li.className = cls;
    const detail = (cls === 'active' && job.message) ? job.message : '';
    li.innerHTML = '<span class="ico">' + icon + '</span>' +
      '<span><span class="label">' + esc(s.label) + '</span>' +
      (detail ? '<span class="detail">' + esc(detail) + '</span>' : '') + '</span>';
    list.appendChild(li);
  });

  const fill = $('pbarFill');
  if (job.status === 'error') {
    fill.classList.remove('indeterminate');
    fill.style.width = '100%';
    fill.style.background = 'var(--danger)';
    $('workMsg').className = 'msg';
    $('workMsg').textContent = job.error || 'Something went wrong.';
  } else {
    fill.style.background = '';
    if (job.progress == null) {
      fill.classList.add('indeterminate');
      fill.style.width = '34%';
    } else {
      fill.classList.remove('indeterminate');
      fill.style.width = Math.round(job.progress * 100) + '%';
    }
    $('workMsg').className = 'msg muted';
    $('workMsg').textContent = job.message || '';
  }

  const elapsed = Math.max(0, (Date.now() / 1000) - (job.started || 0));
  $('workElapsed').textContent = job.status === 'running'
    ? 'elapsed ' + fmtClock(elapsed) : '';

  if (job.log_total > logLen) {
    logBuffer = logBuffer.concat(job.log);
    if (logBuffer.length > 500) logBuffer = logBuffer.slice(-500);
    logLen = job.log_total;
    const pre = $('logPre');
    pre.textContent = logBuffer.join('\n');
    pre.scrollTop = pre.scrollHeight;
  }

  const cancelBtn = $('btnCancelJob');
  if (job.status === 'running') {
    cancelBtn.textContent = 'Cancel';
    cancelBtn.classList.remove('hidden');
  } else if (job.status === 'error' || job.status === 'cancelled') {
    cancelBtn.textContent = 'Close';
    cancelBtn.classList.remove('hidden');
  } else {
    cancelBtn.classList.add('hidden');
  }
}

async function cancelJob() {
  if (job && job.status === 'running') {
    try { await api('/api/cancel', { method: 'POST', body: {} }); }
    catch (e) { toast(e.message, 'error'); }
  } else {
    show(project && project.captions_ready ? 'editor' : 'setup');
  }
}

/* ============================ editor ============================ */
async function enterEditor(withToast) {
  show('editor');
  await loadAss();
  layoutVideo();
  if (withToast) toast('Captions ready — check them below!', 'ok');
}

function layoutVideo() {
  if (!project) return;
  playerBox.style.aspectRatio = project.width + ' / ' + project.height;
  $('videoName').textContent = project.video_name +
    '  ·  ' + project.width + '×' + project.height +
    '  ·  ' + fmtClock(project.duration);
  if (player.dataset.loaded !== project.video_path) {
    player.src = '/api/video';
    player.dataset.loaded = project.video_path;
    frameTime = 0;
    frameImg.classList.add('hidden');
    capOverlay.classList.add('hidden');
  }
  updateTimeline();
}

async function loadAss() {
  try {
    const r = await api('/api/ass');
    assText = r.text;
    assRev = r.rev;
    dirty = false;
    parseAss();
    renderCueList();
    fillStyleTab();
    syncRawTab();
    updateTimeline();
    setPill(dirty ? 'dirty' : 'saved', dirty ? 'Unsaved changes' : 'Saved ✓');
    scheduleFrameRefresh(0);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function parseAss() {
  try {
    cues = parseCuesFromAss(assText);
    cuesValid = true;
  } catch (e) {
    cues = [];
    cuesValid = false;
  }
  styleInfo = readStyle(assText);
  const adv = cues.find((c) => c.borderX != null || c.borderY != null);
  if (adv) {
    styleInfo.padX = adv.borderX != null ? adv.borderX : styleInfo.outline;
    styleInfo.padY = adv.borderY != null ? adv.borderY : styleInfo.outline;
  } else {
    styleInfo.padX = styleInfo.outline;
    styleInfo.padY = styleInfo.outline;
  }
}

/* Global horizontal/vertical box padding as per-caption override values
   (null = inherit the style's single Outline value for that axis). */
function globalBorderOverrides() {
  const g = styleInfo || readStyle(assText);
  const px = g.padX != null ? g.padX : g.outline;
  const py = g.padY != null ? g.padY : g.outline;
  const use = (px !== g.outline || py !== g.outline);
  return { borderX: use ? px : null, borderY: use ? py : null };
}

function cueDisplayText(t) { return String(t || '').replace(/\\N/gi, '\n'); }
function cueModelText(t) { return String(t || '').replace(/\r?\n/g, '\\N'); }

function renderCueList() {
  const box = $('cueList');
  box.innerHTML = '';
  $('cueCount').textContent = cues.length
    ? cues.length + ' captions' + (cuesValid ? '' : '  ⚠ could not read the file')
    : '';
  $('cuesEmpty').classList.toggle('hidden', cues.length > 0);
  const frag = document.createDocumentFragment();
  cues.forEach((c, i) => frag.appendChild(buildCueRow(c, i)));
  box.appendChild(frag);
  Array.from(box.querySelectorAll('textarea')).forEach((ta) => autoGrow(ta));
  highlightActiveCue();
}

function buildCueRow(c, i) {
  const row = document.createElement('div');
  row.className = 'cue';
  row.dataset.i = String(i);
  const styled = cueHasOwnStyle(c);
  const rowHtml =
    '<span class="num">#' + (i + 1) + '</span>' +
    '<div class="times">' +
      '<input class="t" data-f="start" value="' + esc(fmtAssTime(c.start)) + '">' +
      '<span>→</span>' +
      '<input class="t" data-f="end" value="' + esc(fmtAssTime(c.end)) + '">' +
    '</div>' +
    '<textarea rows="2">' + esc(cueDisplayText(c.text)) + '</textarea>' +
    '<div class="acts">' +
      '<button data-a="jump" title="Jump the video to this caption">▶ Go</button>' +
      '<button data-a="s" title="Set start time to the current video time">S start</button>' +
      '<button data-a="e" title="Set end time to the current video time">E end</button>' +
      '<button data-a="sty" class="sty' + (styled ? ' on' : '') +
        '" title="Style just this caption (colour, bold, italic)">Aa</button>' +
      '<button data-a="del" class="del" title="Delete this caption">✕</button>' +
    '</div>' +
    '<div class="cue-style' + (openStyleRow === i ? '' : ' hidden') + '">' +
      '<label class="cs"><input type="checkbox" class="cs-use"' +
        (c.color ? ' checked' : '') + '> Special text colour</label>' +
      '<input type="color" class="cs-col" value="' + esc(c.color || defaultHexColour()) + '"' +
        (c.color ? '' : ' disabled') + ' title="Colour for this caption only">' +
      '<label class="cs"><input type="checkbox" class="cs-b"' +
        ((c.bold != null ? c.bold : !!(styleInfo && styleInfo.bold)) ? ' checked' : '') +
        '> Bold</label>' +
      '<label class="cs"><input type="checkbox" class="cs-i"' +
        ((c.italic != null ? c.italic : false) ? ' checked' : '') + '> Italic</label>' +
      '<button data-a="rst" class="cs-reset" title="Remove this caption’s own style">Use the default style</button>' +
    '</div>';
  row.innerHTML = rowHtml;
  return row;
}

function cueHasOwnStyle(c) {
  return !!(c && (c.color || c.bold != null || c.italic != null));
}

function cueFromRow(row) { return cues[+row.dataset.i]; }

function handleCueClick(ev) {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const row = btn.closest('.cue');
  if (!row) return;
  const idx = +row.dataset.i;
  const c = cues[idx];
  if (!c) return;
  const action = btn.dataset.a;
  const t = previewTime();

  if (action === 'jump') {
    // Land exactly at the caption's start (c.start). Setting player.currentTime
    // snaps to a frame boundary and the seeking/seeked handlers would adopt a
    // position slightly BEFORE c.start — which, when the previous caption ends
    // exactly at c.start, would highlight the previous row and render its text.
    // jumpTarget makes the requested position authoritative for this jump.
    jumpTarget = c.start;
    notePreviewTime(c.start);
    player.currentTime = c.start;
    updateTimeLabel();
    updatePlayhead();
    scheduleFrameRefresh(0);
    return;
  }
  if (action === 's') {
    if (t >= c.end) { toast('The video is past the end of this caption — move the end first.', 'error'); return; }
    c.start = t;
    sortCues();
    afterCueTimeEdit(row, idx, c);
    return;
  }
  if (action === 'e') {
    if (t <= c.start) { toast('The video is before the start of this caption.', 'error'); return; }
    c.end = t;
    afterCueTimeEdit(row, idx, c);
    return;
  }
  if (action === 'sty') {
    const panel = qs('.cue-style', row);
    if (!panel) return;
    const willShow = panel.classList.contains('hidden');
    // only one panel open at a time
    const open = qs('.cue-style:not(.hidden)', $('cueList'));
    if (open && open !== panel) open.classList.add('hidden');
    panel.classList.toggle('hidden', !willShow);
    openStyleRow = willShow ? idx : -1;
    return;
  }
  if (action === 'rst') {
    c.color = null;
    c.bold = null;
    c.italic = null;
    afterCueChange(true);   // rebuild resets the panel controls too
    return;
  }
  if (action === 'del') {
    lastDeleted = { cue: c, index: idx };
    cues.splice(idx, 1);
    afterCueChange(true);
    toast('Caption deleted', null, { label: 'Undo', fn: undoDelete });
  }
}

function undoDelete() {
  if (!lastDeleted) return;
  cues.splice(Math.min(lastDeleted.index, cues.length), 0, lastDeleted.cue);
  lastDeleted = null;
  afterCueChange(true);
}

function handleCueInput(ev) {
  const row = ev.target.closest('.cue');
  if (!row) return;
  const idx = +row.dataset.i;
  const c = cues[idx];
  if (!c) return;

  if (ev.target.matches('input.t')) {
    const field = ev.target.dataset.f;
    try {
      const val = parseAssTime(ev.target.value);
      if (field === 'start' && val >= c.end) throw new Error('start must be before end');
      if (field === 'end' && val <= c.start) throw new Error('end must be after start');
      c[field] = val;
      ev.target.classList.remove('bad');
      if (ev.type === 'change') { sortCues(); afterCueChange(true); }
      else afterCueChange(false, false);
    } catch (e) {
      ev.target.classList.add('bad');
      if (ev.type === 'change') toast('“' + ev.target.value + '” is not a valid time (use 0:00:12.50).', 'error');
    }
    return;
  }
  if (ev.target.tagName === 'TEXTAREA') {
    c.text = cueModelText(ev.target.value);
    autoGrow(ev.target);
    afterCueChange(false, false);
    return;
  }
  if (ev.target.classList.contains('cs-use')) {
    const col = qs('.cs-col', row);
    c.color = ev.target.checked ? (col ? col.value : null) : null;
    if (col) col.disabled = !ev.target.checked;
    updateStyleButton(row, c);
    afterCueChange(false, false);
    return;
  }
  if (ev.target.classList.contains('cs-col')) {
    c.color = ev.target.value;
    const use = qs('.cs-use', row);
    if (use) use.checked = true;
    updateStyleButton(row, c);
    afterCueChange(false, false);
    return;
  }
  if (ev.target.classList.contains('cs-b')) {
    c.bold = ev.target.checked;
    updateStyleButton(row, c);
    afterCueChange(false, false);
    return;
  }
  if (ev.target.classList.contains('cs-i')) {
    c.italic = ev.target.checked;
    updateStyleButton(row, c);
    afterCueChange(false, false);
  }
}

function updateStyleButton(row, c) {
  const btn = qs('button[data-a="sty"]', row);
  if (btn) btn.classList.toggle('on', cueHasOwnStyle(c));
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(38, ta.scrollHeight + 2) + 'px';
}

function sortCues() {
  cues.sort((a, b) => a.start - b.start);
}

function afterCueChange(structural, timeline) {
  assText = rebuildAss(assText, cues);
  scheduleSave();
  if (timeline !== false) updateTimeline();
  if (structural) renderCueList();
  else highlightActiveCue();
  scheduleFrameRefresh(160);
}

// Light-weight path for start/end edits (the Go-adjacent black buttons). A
// start/end change only affects ONE caption, so patching that row (and its
// timeline bar) in place avoids rebuilding all 536 rows, the whole timeline,
// and — most importantly — the immediate ffmpeg frame render, which would run
// against the OLD saved ASS anyway (the edit is still in the 800ms save
// debounce) and could not show the change. saveAss() re-renders once with the
// fresh rev when the debounced save lands.
function afterCueTimeEdit(row, idx, c) {
  const newIdx = cues.indexOf(c);
  if (newIdx !== idx) {
    // The edit moved this caption past another one in the list — rare.
    renderCueList();
    updateTimeline();
  } else {
    const st = qs('input[data-f="start"]', row);
    const en = qs('input[data-f="end"]', row);
    if (st) st.value = fmtAssTime(c.start);
    if (en) en.value = fmtAssTime(c.end);
  }
  const dur = (project && project.duration) || 0;
  const block = qs('.cue-block[data-i="' + newIdx + '"]', $('timeline'));
  if (block) {
    block.style.left = (c.start / dur * 100) + '%';
    block.style.width = Math.max(0.35, (c.end - c.start) / dur * 100) + '%';
  }
  assText = rebuildAss(assText, cues);
  scheduleSave();
  // No scheduleFrameRefresh here on purpose (see comment above).
}

function addCueAtPlayhead() {
  const dur = (project && project.duration) || 0;
  const start = Math.min(previewTime(), Math.max(0, dur - 0.5));
  const end = Math.min(dur || start + 2, start + 2);
  const gb = globalBorderOverrides();
  const cue = {
    start, end: Math.max(end, start + 0.3),
    text: 'New caption',
    style: styleInfo ? styleInfo.name : 'Default',
    extras: {},
    color: null, bold: null, italic: null,
    borderX: gb.borderX, borderY: gb.borderY,
  };
  cues.push(cue);
  sortCues();
  afterCueChange(true);
  const idx = cues.indexOf(cue);
  setTimeout(() => {
    const row = qs('.cue[data-i="' + idx + '"]', $('cueList'));
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const ta = qs('textarea', row);
      if (ta) { ta.focus(); ta.select(); }
    }
  }, 60);
}

/* ---- saving ---- */
function setPill(cls, text) {
  const pill = $('savePill');
  pill.className = 'pill ' + (cls || '');
  pill.textContent = text;
}

function scheduleSave() {
  dirty = true;
  setPill('dirty', 'Unsaved changes…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveAss(), 800);
  $('dirtyNote').textContent = 'Auto-saves as you type';
}

async function saveAss(force) {
  if (!dirty && !force) return true;
  if (saving) { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveAss(), 400); return true; }
  saving = true;
  setPill('saving', 'Saving…');
  try {
    const r = await api('/api/ass', { method: 'POST', body: { text: assText } });
    assRev = r.rev;
    dirty = false;
    project = project || {};
    project.captions_ready = true;
    project.ass_rev = r.rev;
    setPill('saved', 'Saved ✓');
    $('dirtyNote').textContent = '';
    scheduleFrameRefresh(0);
    return true;
  } catch (e) {
    setPill('dirty', 'Not saved!');
    toast('Could not save: ' + e.message, 'error');
    return false;
  } finally {
    saving = false;
  }
}

async function revertAss() {
  if (dirty && !confirm('Discard the changes you have not saved yet?')) return;
  try {
    await loadAss();
    toast('Reverted to the saved file.', 'ok');
  } catch (e) { /* loadAss already toasts */ }
}

/* ---- tabs ---- */
function switchTab(name) {
  if (name === currentTab) return;
  if (currentTab === 'raw') {
    // leaving the raw editor: re-parse the text the user typed
    const before = assText;
    parseAss();
    if (!cuesValid && before.trim()) {
      currentTab = name;
      applyTabVisibility();
      renderCueList();
      toast('Could not read captions from the raw file — use “Revert” if it looks wrong.', 'error');
      return;
    }
  }
  currentTab = name;
  applyTabVisibility();
  if (name === 'cues') { renderCueList(); }
  if (name === 'style') { fillStyleTab(); }
  if (name === 'raw') { syncRawTab(); }
}

function applyTabVisibility() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === currentTab);
  });
  ['cues', 'style', 'raw'].forEach((t) => {
    $('tab-' + t).classList.toggle('hidden', t !== currentTab);
  });
}

function syncRawTab() { $('rawAss').value = assText; }

/* ---- style tab ---- */
function defaultHexColour() {
  const s = styleInfo || readStyle(assText);
  return assColorToHex(s.color);
}

function fillStyleTab() {
  if (!styleInfo) styleInfo = readStyle(assText);
  $('stFont').value = styleInfo.font;
  $('stSize').value = Math.round(styleInfo.size);
  $('stColor').value = assColorToHex(styleInfo.color);
  $('stOutline').value = assColorToHex(styleInfo.outlineColor);
  $('stBox').value = String(styleInfo.border === 3 ? 3 : 1);
  const op = Math.round((styleInfo.outlineOpacity == null ? 1 : styleInfo.outlineOpacity) * 100);
  $('stBgOp').value = String(op);
  $('stBgOpVal').textContent = op + '%';
  $('stWidthX').value = String(styleInfo.padX != null ? Math.round(styleInfo.padX) : Math.round(styleInfo.outline));
  $('stWidthY').value = String(styleInfo.padY != null ? Math.round(styleInfo.padY) : Math.round(styleInfo.outline));
  $('stPos').value = [2, 5, 8].includes(styleInfo.align) ? String(styleInfo.align) : '2';
  $('stMargin').value = Math.round(styleInfo.marginV);
}

function clampPad(v, fallback) {
  if (v === '' || isNaN(v)) return null;
  return Math.max(0, Math.min(120, v));
}

function applyStyleFromInputs() {
  const current = readStyle(assText);
  const opacity = Math.max(0, Math.min(100, parseInt($('stBgOp').value, 10)));
  const padX = clampPad(parseInt($('stWidthX').value, 10), current.outline);
  const padY = clampPad(parseInt($('stWidthY').value, 10), current.outline);
  const effX = padX == null ? current.outline : padX;
  const effY = padY == null ? current.outline : padY;
  const outlineField = effX === effY ? effX : Math.min(effX, effY);
  const updates = {
    Fontname: ($('stFont').value || 'Arial').trim() || 'Arial',
    Fontsize: String(Math.max(4, Math.min(400, parseInt($('stSize').value, 10) || current.size))),
    PrimaryColour: hexToAssColor($('stColor').value, current.color),
    OutlineColour: hexToAssColor($('stOutline').value, current.outlineColor,
      isNaN(opacity) ? undefined : opacity / 100),
    BorderStyle: $('stBox').value,
    Outline: String(Math.max(0, Math.min(120, outlineField))),
    Alignment: $('stPos').value,
    MarginV: String(Math.max(0, Math.min(3000, parseInt($('stMargin').value, 10) || 0))),
  };
  if (!isNaN(opacity)) $('stBgOpVal').textContent = opacity + '%';
  assText = updateStyleInText(assText, updates);
  // Push the two-axis padding into every caption line (as \xbord/\ybord tags).
  const use = effX !== outlineField || effY !== outlineField;
  cues.forEach((c) => {
    c.borderX = use ? effX : null;
    c.borderY = use ? effY : null;
  });
  assText = rebuildAss(assText, cues);
  styleInfo = readStyle(assText);
  styleInfo.padX = effX;
  styleInfo.padY = effY;
  scheduleSave();
  scheduleFrameRefresh(200);
}

/* ---- raw tab ---- */
function handleRawInput() {
  assText = $('rawAss').value;
  scheduleSave();
  scheduleFrameRefresh(300);
}

/* ============================ video preview ============================ */
function scheduleFrameRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshFrame, delay == null ? 120 : delay);
}

async function refreshFrame() {
  if (activeScreen !== 'editor' || !project || !project.captions_ready) return;
  if (!player.paused && !player.seeking) return;  // playing = live overlay instead
  const t = previewTime();
  const seq = ++frameSeq;
  setFrameBusy(true);
  try {
    // Note: we deliberately do NOT abort the previous request. Killing the
    // connection while the server renders was what produced ConnectionAborted
    // noise in the server log plus wasted ffmpeg work. Instead a stale-seq
    // fetch below simply discards its result; the server dedupes identical
    // renders via its frame cache, so this stays cheap.
    const resp = await fetch('/api/frame?t=' + t.toFixed(2) + '&rev=' + assRev);
    if (!resp.ok) {
      let msg = 'preview failed';
      try { msg = (await resp.json()).error || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    if (seq !== frameSeq) return;  // superseded by a newer refresh; it owns the busy flag
    if (activeScreen !== 'editor' || (!player.paused && !player.seeking)) {
      // the screen changed or playback resumed while we waited
      setFrameBusy(false);
      return;
    }
    const url = URL.createObjectURL(blob);
    frameImg.onload = () => { setFrameBusy(false); };
    frameImg.onerror = () => { setFrameBusy(false); };
    const old = frameImg.src;
    frameImg.src = url;
    if (old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 500);
    frameImg.classList.remove('hidden');
    frameErrorShown = false;
  } catch (e) {
    if (seq !== frameSeq) return;  // stale failure, a newer refresh is in charge
    setFrameBusy(false);
    if (!frameErrorShown) { toast('Preview error: ' + e.message, 'error'); frameErrorShown = true; }
  }
}

function hideStillFrame() {
  frameImg.classList.add('hidden');
  setFrameBusy(false);
}

function renderLiveCaption(cue) {
  const s = styleInfo || readStyle(assText);
  const boxH = playerBox.clientHeight || 1;
  const scale = boxH / (s.playresY || 288);
  const fontSize = Math.max(8, s.size * scale);
  const padX = Math.max(0, ((cue && cue.borderX != null ? cue.borderX : (s.padX != null ? s.padX : s.outline)) || 1) * scale);
  const padY = Math.max(0, ((cue && cue.borderY != null ? cue.borderY : (s.padY != null ? s.padY : s.outline)) || 1) * scale);
  const outline = Math.max(0.5, Math.min(padX, padY));
  const margin = Math.max(0, s.marginV * scale);
  const bgOpacity = s.outlineOpacity == null ? 1 : s.outlineOpacity;

  let css = '';
  const fontSafe = String(s.font || '').replace(/[^A-Za-z0-9 ,'_-]/g, '').trim() || 'Arial';
  css += 'font-family:' + esc(fontSafe) + ',Arial,sans-serif;';
  css += 'font-size:' + fontSize.toFixed(1) + 'px;';
  css += 'font-weight:' + ((cue && cue.bold != null ? cue.bold : s.bold) ? '700' : '400') + ';';
  css += 'font-style:' + ((cue && cue.italic) ? 'italic' : 'normal') + ';';
  css += 'color:' + (cue && cue.color ? cue.color : assColorToCss(s.color)) + ';';
  if (s.border === 3) {
    const bg = assColorToCss(s.outlineColor);
    css += 'background:' + bg.replace('rgb(', 'rgba(').replace(')', ',' + bgOpacity.toFixed(2) + ')') + ';';
    css += 'padding:' + (padY * 0.7).toFixed(1) + 'px ' + (padX * 1.4).toFixed(1) + 'px;';
    css += 'border-radius:' + Math.round(Math.min(padX, padY)) + 'px;';
    css += 'box-decoration-break:clone;';
  } else {
    const stroke = assColorToCss(s.outlineColor)
      .replace('rgb(', 'rgba(').replace(')', ',' + bgOpacity.toFixed(2) + ')');
    css += '-webkit-text-stroke:' + (outline * 0.6).toFixed(1) + 'px ' + stroke + ';';
    css += 'paint-order:stroke fill;';
    css += 'text-shadow:0 0 ' + (outline).toFixed(1) + 'px rgba(0,0,0,.65);';
  }

  const align = s.align;
  capOverlay.style.alignItems = align >= 7 ? 'flex-start' : (align >= 4 ? 'center' : 'flex-end');
  capOverlay.style.paddingTop = align >= 7 ? margin + 'px' : '0';
  capOverlay.style.paddingBottom = align < 4 ? margin + 'px' : '0';
  const html = esc(cueDisplayText(cue ? cue.text : '')).replace(/\n/g, '<br>');
  capOverlay.innerHTML = '<span class="cap-text" style="' + css + '">' + html + '</span>';
  capOverlay.classList.remove('hidden');
}

function tickOverlay() {
  if (activeScreen !== 'editor') { capOverlay.classList.add('hidden'); return; }
  if (player.paused || player.ended) {
    capOverlay.classList.add('hidden');
    return;
  }
  const t = player.currentTime;
  let idx = -1;
  for (let i = 0; i < cues.length; i++) {
    if (t >= cues[i].start && t < cues[i].end) { idx = i; break; }
    if (cues[i].start > t) break;
  }
  if (idx >= 0) renderLiveCaption(cues[idx]);
  else capOverlay.classList.add('hidden');
  highlightActiveCue(idx);
  updatePlayhead(t);
  updateTimeLabel();
  requestAnimationFrame(tickOverlay);
}

function highlightActiveCue(idx) {
  if (idx === undefined) {
    const t = previewTime();
    idx = cues.findIndex((c) => t >= c.start && t < c.end);
  }
  if (idx === activeCueIdx) return;
  const prev = activeCueIdx >= 0 ? qs('.cue[data-i="' + activeCueIdx + '"]', $('cueList')) : null;
  if (prev) prev.classList.remove('active');
  activeCueIdx = idx;
  const row = idx >= 0 ? qs('.cue[data-i="' + idx + '"]', $('cueList')) : null;
  if (row) row.classList.add('active');
}

function updateTimeLabel() {
  const t = previewTime();
  // While paused show the exact cursor position (0:05:04.46); during playback
  // the coarse clock avoids jitter from low-frequency timeupdate ticks.
  $('timeLabel').textContent =
    (player.paused ? fmtClockMs(t) : fmtClock(t)) +
    ' / ' + fmtClock(project ? project.duration : 0);
}

function updatePlayhead(t) {
  const ph = qs('.playhead', $('timeline'));
  if (!ph || !project || !project.duration) return;
  ph.style.left = ((t == null ? previewTime() : t) / project.duration * 100) + '%';
}

function updateTimeline() {
  const tl = $('timeline');
  const dur = (project && project.duration) || 0;
  tl.innerHTML = '';
  if (!dur) return;
  cues.forEach((c, i) => {
    const b = document.createElement('div');
    b.className = 'cue-block';
    b.dataset.i = String(i);
    b.style.left = (c.start / dur * 100) + '%';
    b.style.width = Math.max(0.35, (c.end - c.start) / dur * 100) + '%';
    tl.appendChild(b);
  });
  if (!cues.length) {
    const empty = document.createElement('div');
    empty.className = 'tl-empty';
    empty.textContent = 'no captions yet';
    tl.appendChild(empty);
  }
  const ph = document.createElement('div');
  ph.className = 'playhead';
  tl.appendChild(ph);
  updatePlayhead();
}

function seekFromTimeline(ev) {
  const rect = $('timeline').getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  if (project && project.duration) {
    const t = frac * project.duration;
    jumpTarget = null; // a manual scrub cancels any pending Go jump
    notePreviewTime(t);
    player.currentTime = t;
    updateTimeLabel();
    updatePlayhead();
    scheduleFrameRefresh(0);
  }
}

/* ============================ export screen ============================ */
function renderExport() {
  const card = $('exportCard');
  if (!job || job.kind !== 'export') return;
  const isMac = platform === 'darwin';

  if (job.status === 'running') {
    const pct = job.progress == null ? null : Math.round(job.progress * 100);
    const elapsed = Math.max(0, (Date.now() / 1000) - job.started);
    card.innerHTML =
      '<div class="big-ico">⏳</div>' +
      '<h2>Exporting your video…</h2>' +
      '<p class="muted">' + esc((job.stages[0] && job.stages[0].label) || 'Working') + '</p>' +
      '<div class="pbar" style="margin-top:18px"><div class="pbar-fill' +
        (pct == null ? ' indeterminate' : '') + '" style="width:' + (pct == null ? 34 : pct) +
        '%"></div></div>' +
      '<div class="row between" style="margin-top:8px">' +
        '<span class="msg muted" style="color:var(--muted)">' + esc(job.message || '') + '</span>' +
        '<span class="muted">' + (pct == null ? 'elapsed ' + fmtClock(elapsed) : pct + '%') + '</span>' +
      '</div>' +
      '<div class="actions"><button class="btn danger ghost" id="exCancel">Cancel</button></div>';
    $('exCancel').addEventListener('click', () =>
      api('/api/cancel', { method: 'POST', body: {} }).catch((e) => toast(e.message, 'error')));
    return;
  }

  if (job.status === 'done') {
    const path = (job.result && job.result.path) || (project && project.export_path) || '';
    const name = path.split(/[\\/]/).pop();
    const size = job.result && job.result.size_mb;
    card.innerHTML =
      '<div class="big-ico">🎉</div>' +
      '<h2>Your captioned video is ready!</h2>' +
      '<p class="muted">Saved next to your original video' + (size ? ' · ' + size + ' MB' : '') + '</p>' +
      '<div class="out-name">' + esc(name) + '</div>' +
      '<video src="/api/result" controls preload="metadata"></video>' +
      '<div class="actions">' +
        '<button class="btn primary" id="exReveal">' + (isMac ? 'Reveal in Finder' : 'Show in folder') + '</button>' +
        '<button class="btn" id="exBack">Keep editing</button>' +
        '<button class="btn ghost" id="exNew">Start over</button>' +
      '</div>';
    $('exReveal').addEventListener('click', () => action('reveal'));
    $('exBack').addEventListener('click', () => show('editor'));
    $('exNew').addEventListener('click', startOver);
    return;
  }

  // error / cancelled
  card.innerHTML =
    '<div class="big-ico">😞</div>' +
    '<h2>' + (job.status === 'cancelled' ? 'Export cancelled' : 'The export failed') + '</h2>' +
    (job.error ? '<div class="err-text">' + esc(job.error) + '</div>' : '') +
    '<div class="actions">' +
      '<button class="btn primary" id="exBack2">Back to the editor</button>' +
    '</div>';
  $('exBack2').addEventListener('click', () => show('editor'));
}

function action(kind) {
  api('/api/action', { method: 'POST', body: { action: kind } })
    .then((r) => { if (!r.ok) toast('Could not open the folder.', 'error'); })
    .catch((e) => toast(e.message, 'error'));
}

async function doExport() {
  const ok = await saveAss(true);
  if (!ok) { toast('Fix the save problem first.', 'error'); return; }
  try {
    const r = await api('/api/export', { method: 'POST', body: {} });
    job = r.job;
    handledKey = job.id + ':' + job.status;
    logBuffer = []; logLen = 0;
    renderExport();
    show('export');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function regenerate() {
  if (!confirm('Transcribe this video again from scratch?\n\nYour current caption edits will be replaced.')) return;
  try {
    const r = await api('/api/regenerate', { method: 'POST', body: {} });
    job = r.job;
    handledKey = job.id + ':' + job.status;
    logBuffer = []; logLen = 0;
    project.captions_ready = false;
    renderWork();
    show('work');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function startOver() {
  if (dirty) await saveAss();
  if (job && job.status === 'running') { toast('Cancel the current task first.', 'error'); return; }
  try {
    await api('/api/reset', { method: 'POST', body: {} });
    project = null;
    job = null;
    handledKey = null;
    frameTime = 0;
    player.pause();
    player.removeAttribute('src');
    player.dataset.loaded = '';
    show('setup');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ============================ polling ============================ */
async function poll() {
  let next = 2200;
  try {
    const s = await api('/api/state?log_from=' + logLen);
    st = s;
    platform = s.platform || platform;
    if (s.tools) renderTools(s.tools);
    project = s.project;
    job = s.job;

    // keep the "wait" cursor while any pipeline/export job is running
    const running = !!(job && job.status === 'running');
    if (running !== busyJob) {
      busyJob = running;
      updateBodyCursor();
    }

    if (job) {
      const key = job.id + ':' + job.status;
      const isNew = key !== handledKey;
      if (job.status === 'running') next = 650;
      if (isNew) {
        handledKey = key;
        await onJobStatus();
      }
    }

    if (job && job.status === 'running') {
      if (job.kind === 'process' && activeScreen === 'work') renderWork();
      if (job.kind === 'export' && activeScreen === 'export') renderExport();
      if (job.kind === 'process' && activeScreen === 'export') { renderWork(); show('work'); }
    }
  } catch (e) {
    /* server briefly unavailable — keep polling */
    next = 3000;
  }
  setTimeout(poll, next);
}

async function onJobStatus() {
  if (!job) return;
  if (job.status === 'running') {
    if (job.kind === 'process') { renderWork(); show('work'); }
    else { renderExport(); show('export'); }
    return;
  }
  if (job.status === 'done') {
    if (job.kind === 'process') {
      handledKey = job.id + ':done';
      await enterEditor(true);
    } else {
      renderExport();
      show('export');
    }
    return;
  }
  if (job.status === 'error') {
    if (job.kind === 'process') { renderWork(); show('work'); }
    else { renderExport(); show('export'); }
    return;
  }
  if (job.status === 'cancelled') {
    if (job.kind === 'process') {
      if (project && project.captions_ready) { await enterEditor(false); }
      else { show('setup'); $('setupMsg').textContent = 'Cancelled — nothing was changed.'; }
    } else {
      show('editor');
      toast('Export cancelled.');
    }
  }
}

/* ============================ wiring ============================ */
function wireEvents() {
  $('btnChoose').addEventListener('click', chooseVideo);
  $('btnUsePath').addEventListener('click', () => {
    const v = $('pathInput').value.trim();
    if (v) startProject(v);
    else $('setupMsg').textContent = 'Paste the full path of your video first.';
  });
  $('pathInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnUsePath').click();
  });
  $('btnRecheck').addEventListener('click', recheckTools);
  $('btnCancelJob').addEventListener('click', cancelJob);
  $('btnExport').addEventListener('click', doExport);
  $('btnRegenerate').addEventListener('click', regenerate);
  $('btnStartOver').addEventListener('click', startOver);
  $('btnAddCue').addEventListener('click', addCueAtPlayhead);
  $('btnAddCue2').addEventListener('click', addCueAtPlayhead);
  $('btnRevert').addEventListener('click', revertAss);
  $('btnShowWork').addEventListener('click', () => {
    const dir = project ? project.work_dir : '';
    toast(dir, null, {
      label: 'Copy',
      fn: () => { if (navigator.clipboard) navigator.clipboard.writeText(dir); },
    });
  });

  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));

  const cueList = $('cueList');
  cueList.addEventListener('click', handleCueClick);
  cueList.addEventListener('input', handleCueInput);
  cueList.addEventListener('change', handleCueInput);
  cueList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'TEXTAREA' && !e.shiftKey) {
      e.preventDefault();
    }
  });
  cueList.addEventListener('input', (e) => {
    if (e.target.tagName === 'TEXTAREA') autoGrow(e.target);
  });

  ['stFont', 'stSize', 'stColor', 'stOutline', 'stBox', 'stBgOp', 'stWidthX', 'stWidthY', 'stPos', 'stMargin']
    .forEach((id) => $(id).addEventListener('input', applyStyleFromInputs));

  $('rawAss').addEventListener('input', handleRawInput);

  // video events
  player.addEventListener('loadedmetadata', () => { updateTimeLabel(); updateTimeline(); });
  player.addEventListener('play', () => {
    notePreviewTime(player.currentTime);
    hideStillFrame();
    requestAnimationFrame(tickOverlay);
  });
  player.addEventListener('pause', () => {
    notePreviewTime(player.currentTime);
    capOverlay.classList.add('hidden');
    scheduleFrameRefresh(0);
    highlightActiveCue();
    updateTimeLabel();
    updatePlayhead();
  });
  let seekTimer = null;
  player.addEventListener('seeking', () => {
    notePreviewTime(jumpTarget != null ? jumpTarget : player.currentTime);
    setFrameBusy(true);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => scheduleFrameRefresh(0), 160);
    updateTimeLabel();
    updatePlayhead();
  });
  player.addEventListener('seeked', () => {
    clearTimeout(seekTimer);
    notePreviewTime(jumpTarget != null ? jumpTarget : player.currentTime);
    jumpTarget = null; // jump consumed — real time is authoritative again.
    scheduleFrameRefresh(0);
    highlightActiveCue();
    updateTimeLabel();
    updatePlayhead();
  });
  player.addEventListener('timeupdate', () => {
    notePreviewTime(player.currentTime);
    if (player.paused) { updateTimeLabel(); updatePlayhead(); }
  });
  player.addEventListener('error', () => {
    const err = player.error;
    const msg = err && err.message ? err.message : 'the browser could not decode it';
    toast('The video could not be played: ' + msg +
      ' (the preview may still work — export uses the file directly).', 'error');
  });

  const tl = $('timeline');
  let dragging = false;
  tl.addEventListener('pointerdown', (e) => { dragging = true; tl.setPointerCapture(e.pointerId); seekFromTimeline(e); });
  tl.addEventListener('pointermove', (e) => { if (dragging) seekFromTimeline(e); });
  tl.addEventListener('pointerup', () => { dragging = false; scheduleFrameRefresh(0); });
  tl.addEventListener('pointercancel', () => { dragging = false; });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return;
    if (activeScreen !== 'editor') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (player.paused) player.play().catch(() => {});
      else player.pause();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      const t = Math.max(0, previewTime() - 5);
      jumpTarget = null;
      notePreviewTime(t);
      player.currentTime = t;
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      const t = Math.min(project ? project.duration : Infinity, previewTime() + 5);
      jumpTarget = null;
      notePreviewTime(t);
      player.currentTime = t;
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      const payload = JSON.stringify({ text: assText });
      try { navigator.sendBeacon('/api/ass', payload); } catch (err) { /* ignore */ }
    }
  });
}

/* ============================ boot ============================ */
async function boot() {
  wireEvents();
  applyTabVisibility();
  try {
    const s = await api('/api/state?log_from=0');
    st = s;
    platform = s.platform || platform;
    if (s.tools) renderTools(s.tools);
    project = s.project;
    job = s.job;

    if (job && job.status === 'running') {
      handledKey = job.id + ':running';
      if (job.kind === 'process') { renderWork(); show('work'); }
      else { renderExport(); show('export'); }
      logLen = 0;
      logBuffer = [];
      if (job.log_total) { logBuffer = job.log.slice(); logLen = job.log_total; }
    } else if (job && job.status === 'error') {
      handledKey = job.id + ':error';
      if (job.kind === 'process') { renderWork(); show('work'); }
      else { renderExport(); show('export'); }
      logBuffer = job.log || [];
      logLen = job.log_total || 0;
    } else if (project && project.captions_ready) {
      await enterEditor(false);
    } else if (project) {
      // project exists but captions are not ready (server restarted mid-run)
      await startProject(project.video_path);
    }
  } catch (e) {
    toast('Could not reach the backend: ' + e.message, 'error');
  }
  poll();
}

document.addEventListener('DOMContentLoaded', boot);
