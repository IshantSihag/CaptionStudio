/* Heavier stress: many concurrent frame renders across distinct positions,
   repeated over several rounds. Reports any non-200 / network error, and
   checks that aborted-request noise still reproduces the ConnectionAborted
   traceback (the exact thing the user pasted). */
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
  const args = process.argv.slice(2);
  const mode = args[0] || 'parallel';
  const rev = await post('/api/ass', { text });

  if (mode === 'abort') {
    // Reproduce the user's ConnectionAbortedError noise: abort in-flight fetches.
    let prev = null;
    for (let i = 0; i < 6; i++) {
      if (prev) prev.ctl.abort();
      const ctl = new AbortController();
      prev = { ctl };
      const t = [274.29, 300, 100, 274.29, 50, 274.29][i];
      fetch(`${BASE}/api/frame?t=${t.toFixed(2)}&rev=${rev}`, { signal: ctl.signal })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 4000));
    console.log('abort-mode done');
    return;
  }

  const positions = [274.29, 30, 400, 100.5, 200, 274.29, 10, 500, 274.29, 250, 55, 340];
  let failures = [];
  for (let round = 0; round < 12; round++) {
    const jobs = positions.map((t) =>
      fetch(`${BASE}/api/frame?t=${t.toFixed(2)}&rev=${rev}`)
        .then(async (r) => ({ t, status: r.status }))
        .then(async (r) => (r.status === 200 ? r : { ...r, failed: true, code: (await (await fetch(`${BASE}/api/frame?t=${r.t.toFixed(2)}&rev=${rev}`)).json().catch(() => ({}))).error }))
        .catch((e) => ({ t, status: 'ERR:' + e.name, failed: true })));
    const res = await Promise.all(jobs);
    for (const r of res) if (r.failed) failures.push(r);
  }
  console.log(failures.length ? JSON.stringify(failures, null, 1) : 'ok - zero failures across all rounds');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });