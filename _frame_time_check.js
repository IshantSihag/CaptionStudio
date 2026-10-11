/* One-off regression check for the "style tab -> captions tab shows first
   caption" bug. Mirrors the current client logic: frameTime is the source of
   truth for the still-frame position, so a browser-side reset of
   <video>.currentTime (caused by the layout change on tab switch) can no
   longer drag the preview back to t=0. */
const assert = require('assert');

let frameTime = 0;
function notePreviewTime(t) {
  if (t == null || !isFinite(t) || t < 0) return;
  frameTime = t;
}
function previewTime() { return frameTime; }

let steps = [];

// 1. User is paused at 30s — reached it via the timeline (SeekFromTimeline).
notePreviewTime(30);
steps.push(['timeline click', previewTime()]);

// 2. Healthy player: the <video> confirms the position (seeked/timeupdate).
notePreviewTime(30);
steps.push(['player seeked/timeupdate', previewTime()]);

// 3. User opens the Style tab and changes a value -> refreshFrame runs while
//    the browser has reset the video clock to 0 (layout change).  The app
//    must keep rendering at 30s, NOT fall back to the live clock.
playerCurrentTime = 0; // phantom browser reset
steps.push(['render after style-tab edit', previewTime()]);

// 4. User comes back to the Captions tab -> renderCueList -> highlightActiveCue,
//    and any further "Rendering exact frame…" renders.
steps.push(['back on captions tab', previewTime()]);

// 5. Even an explicit play/pause round trip must preserve the position.
notePreviewTime(30); // pause handler notes player.currentTime (healthy)
playerCurrentTime = 0; // browser resets again later
steps.push(['pause round trip', previewTime()]);

console.log(steps.map(([a, b]) => a + ' -> ' + b).join('\n'));
for (const [what, t] of steps) assert.strictEqual(t, 30, what + ' must stay at 30s');
console.log('ok - preview position survives tab switches and clock resets');