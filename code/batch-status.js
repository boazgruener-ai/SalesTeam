// Shows the progress of the background web research on every SalesTeam page: a bar at the top with a Stop button while it
// runs, and a pop-up with the result when it finishes (once, on whichever page is in front). Also reports a run whose
// background worker died (no sign of life) so nothing looks busy forever.
import { askConfirm } from "./confirm-dialog.js";
import { BULK_STATE_KEY, getRunningBatch } from "./batch-jobs.js";

const STALE_MS = 180000;
let bannerEl = null;
let onChange = null;

function usd(n) {
  return n < 0.005 ? "less than $0.01" : `$${n.toFixed(2)}`;
}

function ensureBanner() {
  if (bannerEl) return bannerEl;
  bannerEl = document.createElement("div");
  bannerEl.id = "batch-status-banner";
  bannerEl.setAttribute("role", "status");
  bannerEl.style.cssText = "position:sticky;top:0;z-index:2147483000;display:none;gap:12px;align-items:center;justify-content:space-between;" +
    "background:#eef4fb;border-bottom:2px solid #0a66c2;color:#1a1a1a;padding:6px 16px;font:13px system-ui,sans-serif;";
  const text = document.createElement("span");
  text.id = "batch-status-text";
  const stop = document.createElement("button");
  stop.id = "batch-status-stop";
  stop.type = "button";
  stop.textContent = "Stop";
  stop.addEventListener("click", () => {
    stop.disabled = true;
    chrome.runtime.sendMessage({ type: "BULK_WEB_RESEARCH_STOP" }).catch(() => {});
  });
  bannerEl.append(text, stop);
  document.body.prepend(bannerEl);
  return bannerEl;
}

function bannerText(s) {
  return `Researching accounts on the web in the background: ${s.done} of ${s.total} done${s.failed ? `, ${s.failed} failed` : ""} - about ${usd(s.spent)} so far. ` +
    "You can keep using SalesTeam.";
}

function resultText(s) {
  const completed = s.done - s.failed;
  const notStarted = s.total - s.done;
  const budgetText = s.budget > 0 ? usd(s.budget) : "";
  const why = s.stoppedReason === "budget" ? `Stopped because the cost reached your limit of ${budgetText}.`
    : s.stoppedReason === "user" ? "Stopped by you."
    : s.stoppedReason === "interrupted" ? "It was interrupted (the browser or the extension was restarted). What was already saved is kept."
    : s.stoppedReason === "credit" ? "Stopped because your Anthropic API credit balance is empty. Add credits in the Anthropic Console under Plans & Billing, then start the research again - everything found so far is saved."
    : s.stoppedReason === "limit" ? `Stopped because you reached the spending limit set on your Anthropic API account. This is a cap you configure in the Console - not your credit balance, which still has money in it. Raise it under Settings > Limits, or wait for it to reset, then start the research again; everything found so far is saved.${s.lastError ? `\n\n${s.lastError}` : ""}`
    : s.stoppedReason === "errors" ? `Stopped because of errors${s.lastError ? `: ${s.lastError}` : "."}` : "";
  return `Web research finished.\n\n${completed} of ${s.total} account${s.total === 1 ? "" : "s"} researched` +
    `${s.failed ? `, ${s.failed} failed` : ""}${notStarted > 0 ? `, ${notStarted} not started` : ""}.\n` +
    `${s.initiatives} initiative${s.initiatives === 1 ? "" : "s"} added, ${s.filled} empty field${s.filled === 1 ? "" : "s"} filled in.\n` +
    (s.toReview > 0 ? `${s.toReview} account${s.toReview === 1 ? " has" : "s have"} findings that differ from your data - open them in Target Accounts and use "Review findings…".\n` : "") +
    `Estimated cost: about ${usd(s.spent)} (see Settings > Billing).` + (why ? `\n\n${why}` : "");
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
    const banner = ensureBanner();
    banner.style.display = "flex";
    banner.querySelector("#batch-status-text").textContent = bannerText(state);
    banner.querySelector("#batch-status-stop").disabled = false;
  } else if (bannerEl) {
    bannerEl.style.display = "none";
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
  const read = async () => (await chrome.storage.local.get(BULK_STATE_KEY))[BULK_STATE_KEY] || null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[BULK_STATE_KEY]) render(changes[BULK_STATE_KEY].newValue || null);
  });
  document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible") render(await read()); });
  // a stalled worker never writes again, so look at the heartbeat now and then
  setInterval(async () => { const s = await read(); if (s && s.status === "running") render(s); }, 5000);
  render(await read());
}
