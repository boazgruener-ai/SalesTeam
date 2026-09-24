// THROWAWAY - build step 0, see window-test.js. The round runs in the service worker; this page only
// starts/stops it and renders the state it writes to chrome.storage.local.
import { getLinkedinTouchStats } from "./linkedin-touch-log.js";

const STATE_KEY = "windowTestState";

const HOW = {
  visible: "Keep the small SalesTeam test window (top-left) on screen and uncovered for the whole round. You can keep working in other windows beside it.",
  covered: "During the countdown, click into a maximised window (this Chrome window, or another app) so that it completely covers the small test window. Leave it covered until the round ends.",
  minimised: "Nothing to do: the test minimises its window by itself.",
  locked: "During the countdown, press Win+L to lock the screen. Unlock after the estimated time. The machine must stay awake (locking does not put it to sleep).",
};

const $ = (id) => document.getElementById(id);
const condition = () => document.querySelector('input[name="condition"]:checked').value;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
const secs = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)}s`);

function probeText(p) {
  if (!p) return "-";
  if (p.timedOut) return '<span class="bad">no answer</span>';
  const hidden = p.visibilityAtStart === "hidden" || p.visibilityAtEnd === "hidden";
  const vis = p.visibilityAtStart === p.visibilityAtEnd ? p.visibilityAtEnd : `${p.visibilityAtStart} -> ${p.visibilityAtEnd}`;
  return `<span class="${hidden ? "bad" : "good"}">${vis}</span><br>${p.framesPerSec} frames/s<br>timer gap ${p.maxTimerGapMs} ms`;
}

function render(state) {
  const rounds = state?.rounds || [];
  const running = rounds.find((r) => r.id === state?.running);
  if (running) {
    const left = running.status === "countdown" ? Math.max(0, Math.round((running.countdownEndsAt - Date.now()) / 1000)) : null;
    $("status").textContent = `Running (${running.condition}): ${running.status}${left != null ? ` - ${left}s to arrange the window` : ""}`;
  } else {
    $("status").textContent = "Idle.";
  }
  $("start").disabled = Boolean(running);
  $("rounds").innerHTML = rounds.slice().reverse().map((r) => {
    const s = r.summary;
    const detail = (r.lookups || []).map((l) =>
      `${esc(l.company)}: ${l.timedOut ? '<span class="bad">TIMEOUT</span>' : `result ${secs(l.resultMs)}`}, nav ${secs(l.navMs)}, ` +
      `${l.resolved ? (l.idMatches ? "id ok" : '<span class="bad">id MISMATCH</span>') : "not resolved"}, window ${l.windowBefore}/${l.windowAfter}`
    ).join("<br>");
    return `<tr>
      <td>${r.condition}<br><span class="note">${new Date(r.startedAt).toLocaleTimeString()}</span></td>
      <td>${r.status}${r.stoppedBy ? `<br>stopped: ${r.stoppedBy}` : ""}${r.error ? `<br><span class="bad">${esc(r.error)}</span>` : ""}</td>
      <td>${probeText(r.probeStart)}</td>
      <td>${probeText(r.probeEnd)}</td>
      <td>${s ? s.lookups : (r.lookups || []).length} / ${r.requestedLookups}</td>
      <td>${s ? `<span class="${s.timeouts ? "bad" : "good"}">${s.timeouts}</span>` : "-"}</td>
      <td>${s ? `${secs(s.avgResultMs)} / ${secs(s.maxResultMs)}` : "-"}</td>
      <td>${r.focusStolenAtCreate || s?.workerEverFocused ? '<span class="bad">yes</span>' : "no"}</td>
      <td>${detail ? `<details><summary>${r.lookups.length} lookups</summary>${detail}</details>` : "-"}</td>
    </tr>`;
  }).join("");
}

async function refresh() {
  render((await chrome.storage.local.get(STATE_KEY))[STATE_KEY]);
  const stats = await getLinkedinTouchStats();
  $("touches").textContent = `LinkedIn touches in the last 24 hours: ${stats.last24h}. The test stops by itself at 75.`;
}

function updateHow() {
  const n = Number($("lookups").value) || 0;
  const estMin = Math.ceil((Number($("countdown").value) + 20 + n * 15) / 60);
  $("how").textContent = `${HOW[condition()]} Estimated round length: about ${estMin} minute${estMin === 1 ? "" : "s"}.`;
}

document.querySelectorAll('input[name="condition"]').forEach((el) => el.addEventListener("change", updateHow));
$("lookups").addEventListener("input", updateHow);
$("countdown").addEventListener("input", updateHow);

$("start").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({
    type: "WINDOW_TEST_START",
    condition: condition(),
    lookups: Number($("lookups").value) || 0,
    countdownSec: Number($("countdown").value) || 0,
  });
  if (!res?.ok) alert(res?.error || "Could not start the round.");
});
$("stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "WINDOW_TEST_STOP" }));
$("clear").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "WINDOW_TEST_CLEAR" });
  if (!res?.ok) alert(res?.error || "Could not clear.");
});
$("copy").addEventListener("click", async () => {
  const state = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
  await navigator.clipboard.writeText(JSON.stringify(state.rounds || [], null, 2));
  $("copy").textContent = "Copied";
  setTimeout(() => { $("copy").textContent = "Copy results (JSON)"; }, 1500);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STATE_KEY] || changes.linkedinTouchLog)) refresh();
});
setInterval(refresh, 1000); // keeps the countdown ticking
updateHow();
refresh();
