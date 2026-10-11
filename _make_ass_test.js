/* Node test for the browser-side ASS toolkit in static/app.js.
   Extracts the toolkit section, appends assertions and runs the result:
      node _make_ass_test.js && node _ass_test.gen.js            */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'static', 'app.js'), 'utf8');
const start = src.indexOf('/* ============================ ASS toolkit');
const end = src.indexOf('/* ============================ app state');
if (start < 0 || end < 0) { console.error('MARKERS NOT FOUND'); process.exit(1); }
const toolkit = src.slice(start, end);

// A small but complete ASS sample (CRLF line endings, like ffmpeg writes on
// Windows and like many real-world files arrive).
const dialogue = (i, start, end, text) =>
  'Dialogue: 0,' + start + ',' + end + ',Default,,0,0,0,,' + text;
const sample = [
  '[Script Info]',
  '; Caption Studio test sample',
  'ScriptType: v4.00+',
  'PlayResX: 1280',
  'PlayResY: 720',
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  dialogue(0, '0:00:00.00', '0:00:01.20', 'FIRST CAPTION'),
  dialogue(0, '0:00:01.20', '0:00:02.40', 'Second caption'),
  dialogue(0, '0:00:02.40', '0:00:03.00', 'Third'),
  dialogue(0, '0:00:03.00', '0:00:04.25', 'Fourth caption\\Nwith a break'),
  dialogue(0, '0:00:04.25', '0:00:05.50', 'Fifth'),
  dialogue(0, '0:00:05.50', '0:00:06.75', 'Sixth'),
  dialogue(0, '0:00:06.75', '0:00:08.00', 'Seventh'),
  dialogue(0, '0:00:08.00', '0:00:09.10', 'Eighth'),
  dialogue(0, '0:00:09.10', '0:00:10.00', 'Ninth'),
  '',
].join('\r\n');

const test = toolkit + '\n' + `
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
ok(rebuilt.split('\\n').find(l => l.startsWith('PlayResX')) === 'PlayResX: 1280\\r' || rebuilt.split('\\n').find(l => l.startsWith('PlayResX')) === 'PlayResX: 1280', 'header untouched: ' + JSON.stringify(rebuilt.split('\\n').find(l => l.startsWith('PlayResX'))));
ok(rebuilt.indexOf('Style: Default,Arial,40,') >= 0, 'style line untouched');
const origLines = SAMPLE.split('\\n').filter(l => !l.startsWith('Dialogue:'));
const newLines = rebuilt.split('\\n').filter(l => !l.startsWith('Dialogue:'));
ok(origLines.join('\\n') === newLines.join('\\n'), 'every non-dialogue line is byte-identical');

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
const withNew = rebuildAss(emptied, [{start: 1.5, end: 3.25, text: 'Brand\\\\Nnew line', extras: {}}]);
ok(parseCuesFromAss(withNew).length === 1, 'new cue added to empty file');
ok(parseCuesFromAss(withNew)[0].text === 'Brand\\\\Nnew line', 'new cue text with line break kept');

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
ok(s2raw.split('\\n').filter(l => l.startsWith('Style:')).length === 1, 'still exactly one style line');
ok(updateStyleInText(SAMPLE, {Fontsize: '55'}).split('\\n').length === SAMPLE.split('\\n').length, 'no lines added/removed');

// 9. multi-line text <-> display conversion helpers (mirrored in editor code)
const display = String('a\\\\Nb').replace(/\\\\N/gi, '\\n');
const model = String('a\\nb').replace(/\\r?\\n/g, '\\\\N');
ok(display === 'a\\nb' && model === 'a\\\\Nb', 'newline <-> \\\\N conversion');

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
const ov1 = extractOverrides('{\\\\1c&H00FF00&\\\\b1\\\\i1}Hello');
ok(ov1.color === '#00FF00' && ov1.bold === true && ov1.italic === true && ov1.text === 'Hello',
   'extracts colour/bold/italic: ' + JSON.stringify(ov1));
const ov2 = extractOverrides('{\\\\pos(10,20)\\\\1c&H0000FF&}Hi');
ok(ov2.color === '#FF0000' && ov2.text === '{\\\\pos(10,20)}Hi',
   'unknown tags stay in the text: ' + JSON.stringify(ov2));
const ov3 = extractOverrides('plain text');
ok(ov3.color === null && ov3.bold === null && ov3.italic === null && ov3.text === 'plain text',
   'text without tags untouched');
const ov4 = extractOverrides('{\\\\b100}weighted');
ok(ov4.bold === null && ov4.text === '{\\\\b100}weighted',
   'bold weight 100 is not mistaken for a bold toggle');
ok(composeOverrides({}) === '' && composeOverrides({ color: null, bold: null, italic: null }) === '',
   'no overrides -> no tag');
ok(composeOverrides({ color: '#FF0000', bold: true, italic: false }) === '{\\\\1c&H0000FF&\\\\b1\\\\i0}',
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
ok(rtText.indexOf('\\\\1c&H00FF00&') > 0, 'override tag written into the file');

// 13. horizontal / vertical padding (\\xbord / \\ybord)
const pb1 = extractOverrides('{\\\\xbord1\\\\ybord6}PAD');
ok(pb1.borderX === 1 && pb1.borderY === 6 && pb1.text === 'PAD',
   'extracts x/y padding: ' + JSON.stringify(pb1));
const pb2 = extractOverrides('{\\\\bord4}X');
ok(pb2.borderX === 4 && pb2.borderY === 4 && pb2.text === 'X',
   'bord sets both axes: ' + JSON.stringify(pb2));
ok(composeOverrides({ borderX: 2, borderY: 5 }) === '{\\\\xbord2\\\\ybord5}',
   'compose x/y padding: ' + composeOverrides({ borderX: 2, borderY: 5 }));
ok(composeOverrides({ borderX: 7, borderY: 7 }) === '{\\\\bord7}',
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
ok(rtText2.indexOf('\\\\xbord2\\\\ybord5') > 0, 'xbord/ybord tags written into the file');
ok(rtCues2[0].borderX === null && rtCues2[0].borderY === null, 'untouched cue has no padding override');

console.log(failures ? ('\\n' + failures + ' FAILURE(S)') : '\\nAll JS toolkit tests passed');
process.exit(failures ? 1 : 0);
`;

fs.writeFileSync(path.join(__dirname, '_ass_test.gen.js'),
  'const SAMPLE = ' + JSON.stringify(sample) + ';\n' + test);
console.log('generated test written');
