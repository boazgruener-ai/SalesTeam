// THROWAWAY - build step 0, see window-test.js. Loaded into the worker window's own tab for a few seconds,
// touching nothing on LinkedIn. It reports how Chrome is treating that tab right now:
// - visibilityState: "hidden" means Chrome considers the window hidden (minimised, or covered/locked
//   if Windows occlusion tracking is on) and may throttle it;
// - animation frames: these stop entirely in a hidden page, so a count near 0 is the clearest signal;
// - timer lateness: how late a 100 ms interval fires, which shows throttling directly.
const PROBE_MS = 8000;
const TICK_MS = 100;
const nonce = new URLSearchParams(location.search).get("nonce");

const started = performance.now();
const visibilityAtStart = document.visibilityState;
const visibilityChanges = [];
document.addEventListener("visibilitychange", () => {
  visibilityChanges.push({ atMs: Math.round(performance.now() - started), state: document.visibilityState });
});

let frames = 0;
(function frame() { frames++; requestAnimationFrame(frame); })();

let ticks = 0;
let maxGapMs = 0;
let last = performance.now();
const interval = setInterval(() => {
  const now = performance.now();
  maxGapMs = Math.max(maxGapMs, now - last);
  last = now;
  ticks++;
}, TICK_MS);

setTimeout(() => {
  clearInterval(interval);
  const elapsedMs = performance.now() - started;
  const probe = {
    visibilityAtStart,
    visibilityAtEnd: document.visibilityState,
    visibilityChanges,
    hasFocus: document.hasFocus(),
    elapsedMs: Math.round(elapsedMs),
    framesPerSec: Math.round((frames / elapsedMs) * 1000 * 10) / 10,
    ticks,
    expectedTicks: Math.floor(PROBE_MS / TICK_MS),
    maxTimerGapMs: Math.round(maxGapMs),
  };
  document.getElementById("status").textContent = `Done: ${probe.visibilityAtEnd}, ${probe.framesPerSec} frames/s.`;
  chrome.runtime.sendMessage({ type: "WINDOW_TEST_PROBE_RESULT", nonce, probe }).catch(() => {});
}, PROBE_MS);
