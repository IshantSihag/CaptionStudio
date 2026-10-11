/* Try to provoke the server-side frame 500: fire many CONCURRENT /api/frame
   requests for different positions/revs, like the client does when style
   edits re-render the preview rapidly. */
const fs = require('fs');

const BASE = 'http://127.0.0.1:8910';
const text = fs.readFileSync(
  'E:/shikha/YTDown.com_YouTube_the-scariest-thing-that-has-ever-happene_Media_9ff2CtQATqk_002_720p_captions/audio.ass', 'utf8');

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.status;
}

async function main() {
  // Bump revs a few times to simulate consecutive saves.
  let rev = 1;
  for (let i = 0; i < 3; i++) rev = await post('/api/ass', { text });

  const times = [274.29, 30, 400, 100.5, 200, 274.29, 10, 500, 274.29, 250];
  let bad = 0;
  for (let round = 0; round < 8; round++) {
    const jobs = times.map((t) =>
      fetch(`${BASE}/api/frame?t=${t.toFixed(2)}&rev=${rev}`)
        .then(async (r) => ({ t, status: r.status, len: (await r.arrayBuffer()).byteLength }))
        .catch((e) => ({ t, status: 'ERR:' + e.name })));
    const res = await Promise.all(jobs);
    for (const r of res) if (r.status !== 200) { bad++; console.log('NON-200:', JSON.stringify(r)); }
  }
  console.log(bad ? `FAILED: ${bad} non-200 responses` : 'ok - all parallel frame renders returned 200');
}

main().catch((e) => { console.error(e); process.exit(1); });