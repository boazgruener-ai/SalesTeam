// Shows the progress of the background web research on every SalesTeam page: a bar at the top with a Stop button while it
// runs, and a pop-up with the result when it finishes (once, on whichever page is in front). Also reports a run whose
// background worker died (no sign of life) so nothing looks busy forever.
import { askConfirm } from "./confirm-dialog.js";
import { BULK_STATE_KEY, getRunningBatch } from "./batch-jobs.js";
import { initPipelineStatus } from "./pipeline-status.js";
import { setStatusMessage, clearStatusMessage } from "./status-bar.js";

const STALE_MS = 180000;
let onChange = null;

function usd(n) {
  return n < 0.005 ? "less than $0.01" : `$${n.toFixed(2)}`;
}

function bannerText(s) {
  const waitSec = s.pausedUntil ? Math.max(0, Math.round((s.pausedUntil - Date.now()) / 1000)) : 0;
  const paused = waitSec > 0 ? ` Paused - Anthropic asked us to slow down; resuming in about ${waitSec < 90 ? `${waitSec} s` : `${Math.round(waitSec / 60)} min`}.` : "";
  return `Researching accounts on the web in the background: ${s.done} of ${s.total} done${s.failed ? `, ${s.failed} failed` : ""} - about ${usd(s.spent)} so far.${paused} ` +
    "You can keep using SalesTeam.";
}

// Why a run stopped early, in plain words ("" when it simply finished).
function stopReasonText(s) {
  const budgetText = s.budget > 0 ? usd(s.budget) : "";
  return s.stoppedReason === "budget" ? `Stopped because the cost reached your limit of ${budgetText}.`
    : s.stoppedReason === "user" ? "Stopped by you."
    : s.stoppedReason === "interrupted" ? "It was interrupted (the browser or the extension was restarted). What was already saved is kept."
    : s.stoppedReason === "credit" ? "Stopped because your Anthropic API credit balance is empty. Add credits in the Anthropic Console under Plans & Billing, then start the research again - everything found so far is saved."
    : s.stoppedReason === "limit" ? `Stopped because you reached the spending limit set on your Anthropic API account. This is a cap you configure in the Console - not your credit balance, which still has money in it. Raise it under Settings > Limits, or wait for it to reset, then start the research again; everything found so far is saved.${s.lastError ? `\n\n${s.lastError}` : ""}`
    : s.stoppedReason === "rate_limit" ? `Paused because Anthropic kept answering "too many requests", even after waiting in between. Start the research again later for the accounts not yet done - everything found so far is saved.`
    : s.stoppedReason === "errors" ? `Stopped because of errors${s.lastError ? `: ${s.lastError}` : "."}` : "";
}

// A run that an error stopped keeps a red bar until the user closes it (the pop-up alone was easy to miss).
const ERROR_REASONS = new Set(["credit", "limit", "rate_limit", "errors", "interrupted"]);
const ERROR_BAR_HOURS = 24;

function resultText(s) {
  const completed = s.done - s.failed;
  const notStarted = s.total - s.done;
  const why = stopReasonText(s);
  return `Web research finished.\n\n${completed} of ${s.total} account${s.total === 1 ? "" : "s"} researched` +
    `${s.failed ? `, ${s.failed} failed` : ""}${notStarted > 0 ? `, ${notStarted} not started` : ""}.\n` +
    `${s.initiatives} initiative${s.initiatives === 1 ? "" : "s"} added, ${s.filled} empty field${s.filled === 1 ? "" : "s"} filled in.\n` +
    (s.toReview > 0 ? `${s.toReview} account${s.toReview === 1 ? " has" : "s have"} findings that differ from your data - open them in Target Accounts and use "Review findings…".\n` : "") +
    `Estimated cost: about ${usd(s.spent)} (see Settings > Billing).` + (why ? `\n\n${why}` : "");
}

let stopping = false;
function stopRun() {
  stopping = true;
  chrome.runtime.sendMessage({ type: "BULK_WEB_RESEARCH_STOP" }).catch(() => {});
  chrome.storage.local.get(BULK_STATE_KEY).then((d) => render(d[BULK_STATE_KEY] || null));
}
async function closeErrorBar() {
  const fresh = (await chrome.storage.local.get(BULK_STATE_KEY))[BULK_STATE_KEY];
  if (fresh) await chrome.storage.local.set({ [BULK_STATE_KEY]: { ...fresh, barClosed: true } });
  clearStatusMessage("bulk");
}

let announcing = false;
async function render(state) {
  if (state && state.status === "running" && (Date.now() - (state.heartbeatAt || 0) > STALE_MS || (Date.now() - (state.startedAt || 0) > 5000 && !(await getRunningBatch())))) {
    // the worker is gone: close the record so the batch lock and the banner do not stay on forever
    await chrome.storage.local.set({ [BULK_STATE_KEY]: { ...state, status: "done", stoppedReason: state.stoppedReason || "interrupted", runningKeys: [], finishedAt: Date.now() } });
    return;
  }
  const running = !!state && state.status === "running";
  if (running) {
    setStatusMessage("bulk", {
      text: bannerText(state),
      action: { label: stopping ? "Stopping…" : "Stop", disabled: stopping, onClick: stopRun },
    });
  } else if (state && state.status === "done" && ERROR_REASONS.has(state.stoppedReason) && !state.barClosed &&
      Date.now() - (state.finishedAt || 0) < ERROR_BAR_HOURS * 3600000) {
    stopping = false;
    setStatusMessage("bulk", {
      tone: "error",
      text: `Web research stopped: ${stopReasonText(state).split("\n")[0]}`,
      action: { label: "Close", onClick: closeErrorBar },
    });
  } else {
    stopping = false;
    clearStatusMessage("bulk");
  }
  if (onChange) onChange(state);
  if (state && state.status === "done" && !state.acknowledged && document.visibilityState === "visible" && !announcing) {
    announcing = true;
    // claim the announcement first, so a second open page does not show the same pop-up
    const fresh = (await chrome.storage.local.get(BULK_STATE_KEY))[BULK_STATE_KEY];
    if (fresh && !fresh.acknowledged) {
      await chrome.storage.local.set({ [BULK_STATE_KEY]: { ...fresh, acknowledged: true } });
      await askConfirm(resultText(fresh), { okLabel: "OK", cancelLabel: "Close" });
    }
    announcing = false;
  }
}

// `changed` (optional) is called with the state whenever it changes (for a page that refreshes its own data).
export async function initBatchStatus(changed) {
  if (window.self !== window.top) return; // an embedded page: the page around it already shows the bar and the pop-up
  onChange = changed || null;
  initPipelineStatus(); // the data pipeline's own quiet pill, on the same pages
  const read = async () => (await chrome.storage.local.get(BULK_STATE_KEY))[BULK_STATE_KEY] || null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[BULK_STATE_KEY]) render(changes[BULK_STATE_KEY].newValue || null);
  });
  document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible") render(await read()); });
  // a stalled worker never writes again, so look at the heartbeat now and then
  setInterval(async () => { const s = await read(); if (s && s.status === "running") render(s); }, 5000);
  render(await read());
}
