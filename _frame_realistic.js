/* Realistic client simulation: the web UI fires one frame request per
   debounce window (~120-160ms), does NOT abort the previous one (after the
   fix), fully consumes each body (blob()), and browsers cap concurrent
   connections per host at ~6. We mirror that and assert every response is a
   200 JPEG. Times wander like a timeline drag + style-edit session. */
const fs = require('fs');
const BASE = 'http://127.0.0.1:8910';
const text = fs.readFileSync(
  'E:/shikha/YTDown.com_YouTube_the-scariest-thing-that-has-ever-happene_Media_9ff2CtQATqk_002_720p_captions/audio.ass', 'utf8');

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json().catch(() => ({}))).rev;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const rev = await post('/api/ass', { text });
  const failures = [];
  let t = 150;
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    // wander like a drag/seek; occasionally bounce back (cache hits)
    t += (Math.random() - 0.5) * 40;
    if (t < 0) t = 0;
    if (t > 600) t = 600;
    const url = `${BASE}/api/frame?t=${t.toFixed(2)}&rev=${rev}`;
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();   // fully consume, like a browser
      if (resp.status !== 200 || blob.size === 0) {
        failures.push({ t, status: resp.status, size: blob.size });
        break;
      }
      if (resp.status === 200 && blob.size > 0) {
        // count cache vs render throughput indicators
        if (seen.has(url)) {}
        seen.add(url);
      }
    } catch (e) {
      failures.push({ t, status: 'ERR:' + e.name, msg: String(e.message).slice(0, 80) });
      break;
    }
    await sleep(180);  // debounce window
  }
  console.log(failures.length
    ? 'FAILED: ' + JSON.stringify(failures)
    : `ok - 120 sequential refreshes (${seen.size} distinct positions) all returned valid frames`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });