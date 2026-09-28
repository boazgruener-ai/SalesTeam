// The data pipeline's quiet status pill (DATA_PIPELINE_DESIGN.md 10.3): a small pill in the corner of
// every SalesTeam page while a pipeline run is going - "Preparing accounts · 2 of 5 · Nestlé" with a
// Stop button - and, once, a summary of what the run did. Deliberately not the sticky blue batch
// banner: that one is for a run the user is watching. Started from batch-status.js's initBatchStatus.
//
// Build step 3 adds, for the automatic pipeline: the page's kicks (on open and every 10 minutes, after
// making sure a backup from the last 12 hours exists - U1), the one-time consent question for existing
// users (U5), the pill's automatic form ("Preparing accounts · 21 ready · Nestlé" with Pause, no pop-up at
// the end - U3), and pipelineStatusLine(), the one line under the Pipeline status pie and in Settings.
import { askConfirm } from "./confirm-dialog.js";
import { runAutoBackupIfDue } from "./backup-restore.js";
import { getRunningBatch } from "./batch-jobs.js";
import { timeBelowCeiling } from "./linkedin-touch-log.js";
import { localDay, PIPELINE_TOUCH_CEILING } from "./pipeline-plan.js";
import { getOnboardingCompletedAt } from "./storage.js";
import {
  getPipelineAutomation, setPipelineAutomationEnabled, claimConsentQuestion, CONSENT_TITLE, CONSENT_TEXT,
  PIPELINE_AUTOMATION_KEY, PIPELINE_IDLE_KEY, PIPELINE_HOLD_KEY, PIPELINE_KICK_EVERY_MS,
} from "./pipeline-automation.js";

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
    // An automatic run's button is Pause: it stops and stays off for the rest of the day.
    const auto = stop.dataset.auto === "1";
    stop.textContent = auto ? "Pausing…" : "Stopping…";
    chrome.runtime.sendMessage({ type: auto ? "PIPELINE_PAUSE_TODAY" : "PIPELINE_STOP" }).catch(() => {});
  });
  pillEl.append(text, stop);
  document.body.append(pillEl);
  return pillEl;
}

function pillText(s) {
  const at = s.current ? ` · ${s.current}` : "";
  if (s.auto) return `Preparing accounts${s.ready != null ? ` · ${s.ready} ready` : ""}${at}`;
  return `Preparing accounts · ${Math.min(s.done + (s.current ? 1 : 0), s.limit)} of ${s.limit}${at}`;
}

const WHY = {
  limit: "",
  nothing_left: "Every account that can be worked on today has been handled.",
  budget: `Stopped at ${PIPELINE_TOUCH_CEILING} LinkedIn page visits in the last 24 hours. Room frees up as older visits pass 24 hours.`,
  user: "Stopped by you.",
  made_way: "Paused to make way for a job you started",
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
  if (s.stoppedReason === "made_way") why += s.madeWayFor ? `: ${s.madeWayFor}.` : ".";
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
    const btn = pill.querySelector("#pipeline-status-stop");
    const auto = state.auto ? "1" : "0";
    if (btn.dataset.auto !== auto) {
      btn.dataset.auto = auto;
      btn.textContent = state.auto ? "Pause" : "Stop";
      btn.title = state.auto ? "Pause automatic preparation for the rest of today" : "Stop after the account in progress";
    }
  } else if (pillEl) {
    pillEl.style.display = "none";
    const stop = pillEl.querySelector("#pipeline-status-stop");
    stop.disabled = false;
    delete stop.dataset.auto;
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

// ---------------------------------------------------------------------------------------------------
// Build step 3: the automatic pipeline, seen from a page
// ---------------------------------------------------------------------------------------------------

// U1: an automatic run needs a backup from the last 24 hours, and only a page can save one. So before it
// kicks, the page makes sure one from the last 12 hours exists (the same rule as before a scan).
// Resolves with the background's answer ({ started, reason }), or null when automation is off.
export async function kickPipelineFromPage(source) {
  if (!(await getPipelineAutomation()).enabled) return null;
  await runAutoBackupIfDue({ force: true }).catch(() => {});
  return chrome.runtime.sendMessage({ type: "PIPELINE_KICK", source }).catch(() => null);
}

// Right after the user turns automation on, always say what happened: it started, or why it cannot start
// yet (found in the first live test: a blocked start - the 75-visit limit - looked like nothing at all).
export async function kickAndExplain(source) {
  const res = await kickPipelineFromPage(source);
  const text = res && res.started
    ? "Automatic preparation is on and has started. It works in a small LinkedIn window of its own; the pill in " +
      "the bottom right corner shows which account it is on, with Pause."
    : `Automatic preparation is on, but it cannot start right now.\n\n${await pipelineStatusLine()}`;
  await askConfirm(text, { okLabel: "OK", cancelLabel: "Close" });
}

// U5: existing users are asked once, on the first SalesTeam page they open after updating. New users are
// asked at the end of the setup wizard instead, so nobody is asked before Setup is done.
async function maybeAskConsent() {
  if (!(await getOnboardingCompletedAt())) return;
  if (!(await claimConsentQuestion())) return;
  const yes = await askConfirm(`${CONSENT_TITLE}\n\n${CONSENT_TEXT}`, { okLabel: "Turn on", cancelLabel: "Not now" });
  await setPipelineAutomationEnabled(yes, "asked once after the update");
  if (yes) await kickAndExplain("consent");
}

function timeLabel(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `tomorrow ${time}`;
}

// The one line under the Pipeline status pie (design 10.2, U3) and in Settings > Automation.
export async function pipelineStatusLine() {
  const auto = await getPipelineAutomation();
  const store = await chrome.storage.local.get([PIPELINE_STATE_KEY, PIPELINE_IDLE_KEY, PIPELINE_HOLD_KEY]);
  const state = store[PIPELINE_STATE_KEY];
  if (state && state.status === "running" && Date.now() - (state.heartbeatAt || 0) <= STALE_MS) {
    const what = state.auto ? "Preparing accounts" : "Pipeline run in progress";
    return state.current ? `${what} · working on ${state.current}` : what;
  }
  if (!auto.enabled) return "Automatic preparation is off. You can turn it on in Settings > Automation.";
  if (auto.pausedDay === localDay()) return "Automatic preparation is paused for today. Resume it in Settings > Automation.";
  const running = await getRunningBatch();
  if (running && !running.pipeline) {
    return /^Scanner/.test(running.label) ? "Paused while you scan" : `Paused while this runs: ${running.label}`;
  }
  if ((store[PIPELINE_HOLD_KEY] || 0) > Date.now()) return "Paused while you start a job of your own";
  const release = await timeBelowCeiling(PIPELINE_TOUCH_CEILING);
  if (release) return `LinkedIn limit for automation reached · resumes around ${timeLabel(release)}`;
  const idle = store[PIPELINE_IDLE_KEY];
  if (idle && idle.reason === "nothing_left") return "All accounts processed for today. Your daily LinkedIn limit is now free for scanning.";
  if (idle && idle.reason === "no_backup") return "Waiting for today's backup before starting. It is made while a SalesTeam page is open.";
  return "Automatic preparation is on. It starts on its own while Chrome is open.";
}

// Keeps an element showing pipelineStatusLine(), refreshed whenever what it depends on changes.
export function watchPipelineStatusLine(el) {
  if (!el) return;
  const paint = async () => { try { el.textContent = await pipelineStatusLine(); } catch { /* leave the last text */ } };
  const keys = [PIPELINE_STATE_KEY, PIPELINE_IDLE_KEY, PIPELINE_HOLD_KEY, PIPELINE_AUTOMATION_KEY, "activeBatchJob"];
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && keys.some((k) => changes[k])) paint(); });
  setInterval(paint, 60000);
  paint();
}

export async function initPipelineStatus() {
  const read = async () => (await chrome.storage.local.get(PIPELINE_STATE_KEY))[PIPELINE_STATE_KEY] || null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[PIPELINE_STATE_KEY]) render(changes[PIPELINE_STATE_KEY].newValue || null);
  });
  document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible") render(await read()); });
  setInterval(async () => { const s = await read(); if (s && s.status === "running") render(s); }, 15000);
  render(await read());
  // Build step 3: this page kicks the automatic pipeline now and every 10 minutes while it is open.
  maybeAskConsent().catch(() => {});
  kickPipelineFromPage("page_open");
  setInterval(() => kickPipelineFromPage("page_open"), PIPELINE_KICK_EVERY_MS);
}
