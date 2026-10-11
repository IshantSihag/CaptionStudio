/* Mimic the web client's preview-refresh behaviour: rapid sequential frame
   fetches at random-ish positions with the previous in-flight fetch aborted.
   This is what triggers the server-side 500 / ConnectionAbortedError noise. */
const fs = require('fs');

const BASE = 'http://127.0.0.1:8910';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function main() {
  // Save the ASS once to mirror the user's rev 1 -> 2 save.
  const text = fs.readFileSync(
    'E:/shikha/YTDown.com_YouTube_the-scariest-thing-that-has-ever-happene_Media_9ff2CtQATqk_002_720p_captions/audio.ass', 'utf8');
  const save = await post('/api/ass', { text });
  console.log('save /api/ass ->', save.status, 'rev', save.json && save.json.rev);

  // Rapid-fire frame requests: start the next one shortly after the previous,
  // and abort whichever is still in flight (the browser does exactly this via
  // frameCtl.abort()).
  const times = [274.29, 274.29, 100, 274.29, 300, 274.29, 0, 274.29];
  let prev = null;
  const results = [];
  for (const t of times) {
    let ctl = new AbortController();
    if (prev) prev.ctl.abort(new DOMException('superseded', 'AbortError'));
    prev = { ctl, t };
    const p = fetch(`${BASE}/api/frame?t=${t.toFixed(2)}&rev=${save.json.rev}`, { signal: ctl.signal })
      .then(async (r) => {
        const buf = await r.arrayBuffer();
        results.push(`t=${t}: ${r.status} len=${buf.byteLength}`);
      })
      .catch((e) => { results.push(`t=${t}: ABORTED (${e.name})`); });
    await new Promise((res) => setTimeout(res, 120));
  }
  if (prev) prev.ctl.abort(new DOMException('superseded', 'AbortError'));
  await new Promise((res) => setTimeout(res, 3000));

  console.log(results.join('\n'));
  const had500 = await fetch(`${BASE}/api/frame?t=274.29&rev=${save.json.rev}`)
    .then((r) => r.status);
  console.log('final clean fetch:', had500);
}

main().catch((e) => { console.error(e); process.exit(1); });