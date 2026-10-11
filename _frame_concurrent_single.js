/* Fire exactly two concurrent identical frame requests at an uncached key and
   print both full responses (status + body text) to see the 500 error message. */
const fs = require('fs');
const BASE = 'http://127.0.0.1:8910';
const text = fs.readFileSync(
  'E:/shikha/YTDown.com_YouTube_the-scariest-thing-that-has-ever-happene_Media_9ff2CtQATqk_002_720p_captions/audio.ass', 'utf8');

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return j.rev ?? r.status;
}

async function main() {
  const rev = await post('/api/ass', { text });
  // A unique position that is guaranteed uncached.
  const t = (123.4 + Math.random()).toFixed(2);
  const url = `${BASE}/api/frame?t=${t}&rev=${rev}`;
  const out = await Promise.all([
    (async () => { try { const r = await fetch(url); return { s: r.status, b: (await r.text()).slice(0, 400) }; } catch (e) { return { s: 'ERR:' + e.name, b: String(e.message).slice(0, 300) }; } })(),
    (async () => { try { const r = await fetch(url); return { s: r.status, b: (await r.text()).slice(0, 400) }; } catch (e) { return { s: 'ERR:' + e.name, b: String(e.message).slice(0, 300) }; } })(),
  ]);
  console.log(JSON.stringify({ t, rev, out }, null, 1));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });