/* Burst: many concurrent identical requests on a fresh uncached key.
   Prints any 500 response's JSON body plus any client-side network errors. */
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

async function main() {
  const rev = await post('/api/ass', { text });
  const rounds = 8;
  const problems = [];
  for (let round = 0; round < rounds; round++) {
    const t = (200 + Math.random()).toFixed(2);
    const url = `${BASE}/api/frame?t=${t}&rev=${rev}`;
    const N = 16;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        fetch(url)
          .then(async (r) => ({ status: r.status, body: await r.text() }))
          .catch((e) => ({ status: 'ERR:' + e.name, body: e.message }))));
    const bad = results.filter((r) => r.status !== 200);
    if (bad.length) problems.push({ round, t, bad });
  }
  console.log(problems.length ? JSON.stringify(problems) : 'ok - no failures across burst rounds');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });