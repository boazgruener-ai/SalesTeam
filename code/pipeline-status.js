// The data pipeline's quiet status pill (DATA_PIPELINE_DESIGN.md 10.3): a small pill in the corner of
// every SalesTeam page while a pipeline run is going - "Preparing accounts · 2 of 5 · Nestlé" with a
// Stop button - and, once, a summary of what the run did. Deliberately not the sticky blue batch
// banner: that one is for a run the user is watching. Started from batch-status.js's initBatchStatus.
import { askConfirm } from "./confirm-dialog.js";

const PIPELINE_STATE_KEY = "pipelineState"; // pipeline-runner.js
const STALE_MS = 60000; // the runner writes a heartbeat every 10 s

let pillEl = null;
let announcing = false;

function ensurePill() {
  if (pillEl) return pillEl;
  pillEl = document.createElement("div");
  pillEl.id = "pipeline-status-pill";
  pillEl.setAttribute("role", "status");
  pillEl.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;display:none;gap:10px;align-items:center;" +
    "background:#fff;border:1px solid #c9d7e8;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.12);color:#1a1a1a;" +
    "padding:6px 8px 6px 14px;font:13px system-ui,sans-serif;max-width:calc(100vw - 32px);";
  const text = document.createElement("span");
  text.id = "pipeline-status-text";
  text.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  const stop = document.createElement("button");
  stop.type = "button";
  stop.id = "pipeline-status-stop";
  stop.textContent = "Stop";
  stop.title = "Stop after the account in progress";
  stop.style.cssText = "border:1px solid #c9d7e8;background:#f5f8fc;border-radius:999px;padding:2px 10px;cursor:pointer;font:inherit;";
  stop.addEventListener("click", () => {
    stop.disabled = true;
    stop.textContent = "Stopping…";
    chrome.runtime.sendMessage({ type: "PIPELINE_STOP" }).catch(() => {});
  });
  pillEl.append(text, stop);
  document.body.append(pillEl);
  return pillEl;
}

function pillText(s) {
  const at = s.current ? ` · ${s.current}` : "";
  return `Preparing accounts · ${Math.min(s.done + (s.current ? 1 : 0), s.limit)} of ${s.limit}${at}`;
}

const WHY = {
  limit: "",
  nothing_left: "Every account that can be worked on today has been handled.",
  budget: "Stopped at 75 LinkedIn page visits in the last 24 hours. Room frees up as older visits pass 24 hours.",
  user: "Stopped by you.",
  busy: "Stopped because another batch process started",
  window_closed: "Stopped because its LinkedIn window was closed.",
  interrupted: "It was interrupted (the browser or the extension was restarted). Everything already found is saved.",
  error: "Stopped because of an error",
};

export function pipelineResultText(s) {
  const lines = (s.accounts || []).map((a) => `• ${a.company} (${a.touches} visit${a.touches === 1 ? "" : "s"}): ${a.lines.length ? a.lines.join("; ") : "nothing changed"}`);
  const avg = s.done > 0 ? ` - ${(s.touches / s.done).toFixed(1)} per account` : "";
  let why = WHY[s.stoppedReason] ?? "";
  if (s.stoppedReason === "busy") why += s.busyLabel ? `: ${s.busyLabel}.` : ".";
  if (s.stoppedReason === "error") why += s.error ? `: ${s.error}` : ".";
  return `Pipeline run finished.\n\n${s.done} account${s.done === 1 ? "" : "s"} handled, ${s.touches} LinkedIn page visit${s.touches === 1 ? "" : "s"}${avg}` +
    ` (the first visit of a run warms up the window).` +
    (s.readyBefore != null && s.readyAfter != null ? `\nReady accounts: ${s.readyBefore} before, ${s.readyAfter} now.` : "") +
    (lines.length ? `\n\n${lines.join("\n")}` : "") + (why ? `\n\n${why}` : "");
}

async function render(state) {
  if (state && state.status === "running" && Date.now() - (state.heartbeatAt || 0) > STALE_MS) {
    // The background worker is gone (an extension reload): close the record and its window.
    if (state.windowId) chrome.windows.remove(state.windowId).catch(() => {});
    await chrome.storage.local.set({ [PIPELINE_STATE_KEY]: { ...state, status: "finished", stoppedReason: "interrupted", current: null, finishedAt: Date.now() } });
    return;
  }
  const running = Boolean(state) && state.status === "running";
  if (running) {
    const pill = ensurePill();
    pill.style.display = "flex";
    pill.querySelector("#pipeline-status-text").textContent = pillText(state);
  } else if (pillEl) {
    pillEl.style.display = "none";
    const stop = pillEl.querySelector("#pipeline-status-stop");
    stop.disabled = false;
    stop.textContent = "Stop";
  }
  if (state && state.status === "finished" && !state.acknowledged && document.visibilityState === "visible" && !announcing) {
    announcing = true;
    // Claim the announcement first, so a second open page does not show the same pop-up.
    const fresh = (await chrome.storage.local.get(PIPELINE_STATE_KEY))[PIPELINE_STATE_KEY];
    if (fresh && !fresh.acknowledged) {
      await chrome.storage.local.set({ [PIPELINE_STATE_KEY]: { ...fresh, acknowledged: true } });
      await askConfirm(pipelineResultText(fresh), { okLabel: "OK", cancelLabel: "Close" });
    }
    announcing = false;
  }
}

export async function initPipelineStatus() {
  const read = async () => (await chrome.storage.local.get(PIPELINE_STATE_KEY))[PIPELINE_STATE_KEY] || null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[PIPELINE_STATE_KEY]) render(changes[PIPELINE_STATE_KEY].newValue || null);
  });
  document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible") render(await read()); });
  setInterval(async () => { const s = await read(); if (s && s.status === "running") render(s); }, 15000);
  render(await read());
}
