const SAMPLE = "[Script Info]\r\n; Caption Studio test sample\r\nScriptType: v4.00+\r\nPlayResX: 1280\r\nPlayResY: 720\r\nWrapStyle: 0\r\nScaledBorderAndShadow: yes\r\n\r\n[V4+ Styles]\r\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\r\nStyle: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nDialogue: 0,0:00:00.00,0:00:01.20,Default,,0,0,0,,FIRST CAPTION\r\nDialogue: 0,0:00:01.20,0:00:02.40,Default,,0,0,0,,Second caption\r\nDialogue: 0,0:00:02.40,0:00:03.00,Default,,0,0,0,,Third\r\nDialogue: 0,0:00:03.00,0:00:04.25,Default,,0,0,0,,Fourth caption\\Nwith a break\r\nDialogue: 0,0:00:04.25,0:00:05.50,Default,,0,0,0,,Fifth\r\nDialogue: 0,0:00:05.50,0:00:06.75,Default,,0,0,0,,Sixth\r\nDialogue: 0,0:00:06.75,0:00:08.00,Default,,0,0,0,,Seventh\r\nDialogue: 0,0:00:08.00,0:00:09.10,Default,,0,0,0,,Eighth\r\nDialogue: 0,0:00:09.10,0:00:10.00,Default,,0,0,0,,Ninth\r\n";
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



let failures = 0;
function ok(cond, msg) { if (cond) { console.log('  ok - ' + msg); } else { failures++; console.log('  FAIL - ' + msg); } }

// 1. parse
let parsed;
try { parsed = parseCuesFromAss(SAMPLE); } catch (e) { console.log('  FAIL parse: ' + e.message); process.exit(1); }
const dialogueCount = (SAMPLE.match(/^Dialogue:/gm) || []).length;
ok(parsed.length === dialogueCount, 'parsed all dialogues (' + parsed.length + '/' + dialogueCount + ')');
ok(parsed[0].start === 0, 'first cue starts at 0 (' + parsed[0].start + ')');
ok(parsed[0].text.indexOf('FIRST CAPTION') === 0, 'text preserved: ' + JSON.stringify(parsed[0].text));

// 2. rebuild round trip preserves everything else
const rebuilt = rebuildAss(SAMPLE, parsed);
const reparsed = parseCuesFromAss(rebuilt);
ok(reparsed.length === parsed.length, 'round trip keeps cue count');
ok(reparsed[3].text === parsed[3].text && reparsed[3].end === parsed[3].end, 'round trip keeps cue 4 text+time');
ok(rebuilt.split('\n').find(l => l.startsWith('PlayResX')) === 'PlayResX: 1280\r' || rebuilt.split('\n').find(l => l.startsWith('PlayResX')) === 'PlayResX: 1280', 'header untouched: ' + JSON.stringify(rebuilt.split('\n').find(l => l.startsWith('PlayResX'))));
ok(rebuilt.indexOf('Style: Default,Arial,40,') >= 0, 'style line untouched');
const origLines = SAMPLE.split('\n').filter(l => !l.startsWith('Dialogue:'));
const newLines = rebuilt.split('\n').filter(l => !l.startsWith('Dialogue:'));
ok(origLines.join('\n') === newLines.join('\n'), 'every non-dialogue line is byte-identical');

// 3. edit + rebuild
parsed[1].text = 'SECOND CAPTION CHANGED';
const edited = rebuildAss(SAMPLE, parsed);
ok(edited.indexOf('SECOND CAPTION CHANGED') > 0, 'edited text written into the file');
ok(parseCuesFromAss(edited)[1].text === 'SECOND CAPTION CHANGED', 'edited text reads back');

// 4. delete all captions
const emptied = rebuildAss(SAMPLE, []);
ok(!/^Dialogue:/m.test(emptied), 'deleting all cues leaves no dialogue lines');
ok(emptied.indexOf('[Events]') > 0 && emptied.indexOf('Format: Layer') > 0, 'events header survives empty cue list');
ok(emptied.indexOf('PlayResX: 1280') > 0, 'info survives empty cue list');

// 5. add a cue after emptying
const withNew = rebuildAss(emptied, [{start: 1.5, end: 3.25, text: 'Brand\\Nnew line', extras: {}}]);
ok(parseCuesFromAss(withNew).length === 1, 'new cue added to empty file');
ok(parseCuesFromAss(withNew)[0].text === 'Brand\\Nnew line', 'new cue text with line break kept');

// 6. times
ok(fmtAssTime(0) === '0:00:00.00', 'fmt 0 -> ' + fmtAssTime(0));
ok(fmtAssTime(3723.456) === '1:02:03.46', 'fmt big -> ' + fmtAssTime(3723.456));
ok(Math.abs(parseAssTime('1:02:03.46') - 3723.46) < 1e-6, 'parse big round trip');
ok(Math.abs(parseAssTime('00:01:02,500') - 62.5) < 1e-6, 'parses SRT style time');
ok(Math.abs(parseAssTime('12.75') - 12.75) < 1e-6, 'parses bare seconds');

// 7. colors
ok(assColorToHex('&Hffffff') === '#ffffff', '6 digit color -> #ffffff');
ok(assColorToHex('&H00FF0000').toLowerCase() === '#0000ff', 'BGR conversion (blue): ' + assColorToHex('&H00FF0000'));
ok(hexToAssColor('#123456', '&H80ABCDEF') === '&H80563412', 'hex -> ass keeps alpha: ' + hexToAssColor('#123456', '&H80ABCDEF'));
ok(assColorAlpha('&H80000000') < 0.7 && assColorAlpha('&H00000000') === 1, 'alpha mapping');

// 8. style read/update
const s1 = readStyle(SAMPLE);
ok(s1.size === 40 && s1.font === 'Arial' && s1.align === 2, 'readStyle: size=' + s1.size + ' font=' + s1.font + ' align=' + s1.align);
ok(s1.playresX === 1280 && s1.playresY === 720, 'readStyle playres: ' + s1.playresX + 'x' + s1.playresY);
const s2raw = updateStyleInText(SAMPLE, {Fontsize: '55', Alignment: '8', PrimaryColour: hexToAssColor('#ff0000', readStyle(SAMPLE).color)});
const s2 = readStyle(s2raw);
ok(s2.size === 55, 'updateStyleInText fontsize -> ' + s2.size);
ok(s2.align === 8, 'updateStyleInText alignment -> ' + s2.align);
ok(assColorToHex(s2.color).toLowerCase() === '#ff0000', 'updateStyleInText color -> ' + assColorToHex(s2.color));
ok(s2raw.split('\n').filter(l => l.startsWith('Style:')).length === 1, 'still exactly one style line');
ok(updateStyleInText(SAMPLE, {Fontsize: '55'}).split('\n').length === SAMPLE.split('\n').length, 'no lines added/removed');

// 9. multi-line text <-> display conversion helpers (mirrored in editor code)
const display = String('a\\Nb').replace(/\\N/gi, '\n');
const model = String('a\nb').replace(/\r?\n/g, '\\N');
ok(display === 'a\nb' && model === 'a\\Nb', 'newline <-> \\N conversion');

// 10. background opacity encoding (transparent caption box)
ok(hexToAssColor('#000000', null, 0.5) === '&H80000000', 'opacity 50% -> &H80000000: ' + hexToAssColor('#000000', null, 0.5));
ok(hexToAssColor('#000000', null, 0) === '&HFF000000', 'opacity 0% -> &HFF000000');
ok(hexToAssColor('#123456', '&H80ABCDEF', 1) === '&H00563412', 'opacity 100% keeps colour, alpha 00: ' + hexToAssColor('#123456', '&H80ABCDEF', 1));
ok(hexToAssColor('#123456', '&H80ABCDEF') === '&H80563412', 'opacity omitted still copies the old alpha');
const opStyle = readStyle(SAMPLE.replace('&H00000000,&H00000000', '&H80000000,&H00000000'));
ok(Math.abs(opStyle.outlineOpacity - (1 - 128 / 255)) < 0.01, 'readStyle sees a ~50% box: ' + opStyle.outlineOpacity);
ok(readStyle(SAMPLE).outlineOpacity === 1, 'solid colour reads as opaque');
ok(readStyle(SAMPLE).outline === 2, 'outline width reads: ' + readStyle(SAMPLE).outline);

// 11. per-caption override tags
const ov1 = extractOverrides('{\\1c&H00FF00&\\b1\\i1}Hello');
ok(ov1.color === '#00FF00' && ov1.bold === true && ov1.italic === true && ov1.text === 'Hello',
   'extracts colour/bold/italic: ' + JSON.stringify(ov1));
const ov2 = extractOverrides('{\\pos(10,20)\\1c&H0000FF&}Hi');
ok(ov2.color === '#FF0000' && ov2.text === '{\\pos(10,20)}Hi',
   'unknown tags stay in the text: ' + JSON.stringify(ov2));
const ov3 = extractOverrides('plain text');
ok(ov3.color === null && ov3.bold === null && ov3.italic === null && ov3.text === 'plain text',
   'text without tags untouched');
const ov4 = extractOverrides('{\\b100}weighted');
ok(ov4.bold === null && ov4.text === '{\\b100}weighted',
   'bold weight 100 is not mistaken for a bold toggle');
ok(composeOverrides({}) === '' && composeOverrides({ color: null, bold: null, italic: null }) === '',
   'no overrides -> no tag');
ok(composeOverrides({ color: '#FF0000', bold: true, italic: false }) === '{\\1c&H0000FF&\\b1\\i0}',
   'compose overrides: ' + composeOverrides({ color: '#FF0000', bold: true, italic: false }));

// 12. overrides survive save + reload of the real file
const baseCues = parseCuesFromAss(SAMPLE);
baseCues[2].color = '#00FF00';
baseCues[2].bold = true;
const rtText = rebuildAss(SAMPLE, baseCues);
const rtCues = parseCuesFromAss(rtText);
ok(rtCues.length === baseCues.length, 'round trip keeps every cue (' + rtCues.length + ')');
ok(rtCues[2].text === baseCues[2].text && rtCues[2].color === '#00FF00' && rtCues[2].bold === true,
   'override survives save/reload: ' + JSON.stringify(rtCues[2]));
ok(rtCues[0].color === null && rtCues[0].bold === null, 'cue without override stays on the default style');
ok(rtText.indexOf('\\1c&H00FF00&') > 0, 'override tag written into the file');

// 13. horizontal / vertical padding (\xbord / \ybord)
const pb1 = extractOverrides('{\\xbord1\\ybord6}PAD');
ok(pb1.borderX === 1 && pb1.borderY === 6 && pb1.text === 'PAD',
   'extracts x/y padding: ' + JSON.stringify(pb1));
const pb2 = extractOverrides('{\\bord4}X');
ok(pb2.borderX === 4 && pb2.borderY === 4 && pb2.text === 'X',
   'bord sets both axes: ' + JSON.stringify(pb2));
ok(composeOverrides({ borderX: 2, borderY: 5 }) === '{\\xbord2\\ybord5}',
   'compose x/y padding: ' + composeOverrides({ borderX: 2, borderY: 5 }));
ok(composeOverrides({ borderX: 7, borderY: 7 }) === '{\\bord7}',
   'equal padding folds into a single bord tag');
ok(composeOverrides({}) === '' && composeOverrides({ borderX: null, borderY: null }) === '',
   'no padding overrides -> no tag');
ok(extractOverrides(composeOverrides({ color: '#0000FF', borderX: 2, borderY: 5 })).borderX === 2,
   'padding tag adjacent to colour tag parses back');

// 14. padding + colour survive a save + reload of the real file
const rtBase = parseCuesFromAss(SAMPLE);
rtBase[3].color = '#00FF00';
rtBase[3].borderX = 2;
rtBase[3].borderY = 5;
const rtText2 = rebuildAss(SAMPLE, rtBase);
const rtCues2 = parseCuesFromAss(rtText2);
ok(rtCues2.length === rtBase.length, 'padding round trip keeps every cue (' + rtCues2.length + ')');
ok(rtCues2[3].borderX === 2 && rtCues2[3].borderY === 5 && rtCues2[3].color === '#00FF00',
   'padding + colour survive save/reload: ' + JSON.stringify(rtCues2[3]));
ok(rtText2.indexOf('\\xbord2\\ybord5') > 0, 'xbord/ybord tags written into the file');
ok(rtCues2[0].borderX === null && rtCues2[0].borderY === null, 'untouched cue has no padding override');

console.log(failures ? ('\n' + failures + ' FAILURE(S)') : '\nAll JS toolkit tests passed');
process.exit(failures ? 1 : 0);
