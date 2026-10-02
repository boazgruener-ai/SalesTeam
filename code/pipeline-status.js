// The data pipeline's status (DATA_PIPELINE_DESIGN.md 10.3), on every SalesTeam page. Since 2026-09-29 it is
// shown in the one status bar at the top (status-bar.js) at all times - which account a run is working on,
// with Pause, or why it is waiting - instead of a small pill in the corner. Once, a pop-up summarises a run
// the user started. Started from batch-status.js's initBatchStatus.
//
// Build step 3 adds, for the automatic pipeline: the page's kicks (on open and every 10 minutes, after
// making sure a backup from the last 12 hours exists - U1), the one-time consent question for existing
// users (U5), and pipelineStatusLine(), the one line under the Pipeline status pie, in Settings and in the bar.
import { askConfirm } from "./confirm-dialog.js";
import { setStatusMessage, clearStatusMessage } from "./status-bar.js";
import { runAutoBackupIfDue } from "./backup-restore.js";
import { getRunningBatch } from "./batch-jobs.js";
import { timeBelowCeiling } from "./linkedin-touch-log.js";
import { localDay, PIPELINE_TOUCH_CEILING, LINKEDIN_LOGGED_OUT_KEY, LINKEDIN_LOGGED_OUT_WAIT_MS, linkedinLoggedOutRecently } from "./pipeline-plan.js";
import { getOnboardingCompletedAt } from "./storage.js";
import { WEB_LANE_STATE_KEY } from "./web-lane.js";
import { WEB_DISCOVERY_STATE_KEY } from "./discovery-report.js";
import {
  getPipelineAutomation, setPipelineAutomationEnabled, claimConsentQuestion, CONSENT_TITLE, CONSENT_TEXT,
  PIPELINE_AUTOMATION_KEY, PIPELINE_IDLE_KEY, PIPELINE_HOLD_KEY, PIPELINE_KICK_EVERY_MS,
  webBudgetState, PIPELINE_WEB_SPEND_KEY,
} from "./pipeline-automation.js";

const PIPELINE_STATE_KEY = "pipelineState"; // pipeline-runner.js
const STALE_MS = 60000; // the runner writes a heartbeat every 10 s

let announcing = false;
let stopping = false; // Pause/Stop was clicked for the run on screen

// 2026-09-29 (Boaz): the automatic pipeline is always shown in the ONE status bar at the top (status-bar.js),
// running or not - "I do not see any status of the automation". It replaces the small pill in the bottom
// right corner and the grey line being the only sign of it. While it runs: which account, with Pause (Stop for
// a run the user started). Otherwise: why it is waiting (pipelineStatusLine). A job the user starts puts its
// own message on top; this one comes back when that job ends.
const BAR_ID = "pipeline";

function barText(s) {
  const at = s.current ? ` · working on ${s.current}` : "";
  if (s.auto) return `Automatic preparation: preparing accounts${s.ready != null ? ` · ${s.ready} ready` : ""}${at}`;
  return `Pipeline run: ${Math.min(s.done + (s.current ? 1 : 0), s.limit)} of ${s.limit} accounts${at}`;
}

function isLive(state) {
  return Boolean(state) && state.status === "running" && Date.now() - (state.heartbeatAt || 0) <= STALE_MS;
}

async function paintBar(state) {
  if (isLive(state)) {
    const auto = Boolean(state.auto);
    setStatusMessage(BAR_ID, {
      text: barText(state),
      action: {
        label: stopping ? (auto ? "Pausing…" : "Stopping…") : auto ? "Pause for today" : "Stop",
        disabled: stopping,
        onClick: () => {
          stopping = true;
          paintBar(state);
          chrome.runtime.sendMessage({ type: auto ? "PIPELINE_PAUSE_TODAY" : "PIPELINE_STOP" }).catch(() => {});
        },
      },
    });
    return;
  }
  stopping = false;
  // 1.2.0.56 (Boaz, after Finish Setup): while new accounts are being found, the bar showed "All accounts processed
  // for today" - stale (no accounts yet) and it hid the "Finding new accounts" message (the bar shows the message set
  // first). That message is the one that matters then, so the idle text steps aside; it comes back when it ends.
  if (await discoveryRunning()) { clearStatusMessage(BAR_ID); return; }
  try {
    const line = await pipelineStatusLine();
    setStatusMessage(BAR_ID, { text: /^Automatic preparation/.test(line) ? line : `Automatic preparation: ${line}` });
  } catch { /* leave the last text */ }
}

const WHY = {
  limit: "",
  nothing_left: "Every account that can be worked on today has been handled.",
  budget: `Stopped at ${PIPELINE_TOUCH_CEILING} LinkedIn page visits in the last 24 hours. Room frees up as older visits pass 24 hours.`,
  linkedin_limit_web_done: `Stopped at ${PIPELINE_TOUCH_CEILING} LinkedIn page visits in the last 24 hours, and no account needs web research just now (the web budget is not used up). It carries on as older visits pass 24 hours.`,
  user: "Stopped by you.",
  made_way: "Paused to make way for a job you started",
  busy: "Stopped because another batch process started",
  window_closed: "Stopped because its LinkedIn window was closed.",
  linkedin_logged_out: "Stopped because LinkedIn is not logged in in this browser. Log in at linkedin.com - it tries again by itself.",
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
  await paintBar(state);
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
    ? "Automatic preparation is on and has started. It works in a small LinkedIn window of its own; the bar at " +
      "the top of the page shows which account it is on, with Pause."
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

// 1.2.0.10: while the LinkedIn visits are used up, what the web side is doing - Boaz could not tell (2026-10-01).
async function webSideText() {
  const lane = (await chrome.storage.local.get(WEB_LANE_STATE_KEY))[WEB_LANE_STATE_KEY];
  if (lane && lane.status === "running" && Date.now() - (lane.heartbeatAt || 0) <= STALE_MS) {
    return `web research goes on (${lane.done} of ${lane.total} accounts)`;
  }
  const w = await webBudgetState();
  if (w.reason === "off") return "web research is off";
  if (w.reason === "used_up" || w.reason === "zero") return "web research budget used up";
  if (w.reason) return "web research paused";
  return "no account needs web research just now";
}

async function discoveryRunning() {
  const d = (await chrome.storage.local.get(WEB_DISCOVERY_STATE_KEY))[WEB_DISCOVERY_STATE_KEY];
  return Boolean(d) && d.status === "running" && Date.now() - (d.heartbeatAt || 0) <= STALE_MS;
}

// The one line under the Pipeline status pie (design 10.2, U3) and in Settings > Automation.
export async function pipelineStatusLine() {
  const auto = await getPipelineAutomation();
  const store = await chrome.storage.local.get([PIPELINE_STATE_KEY, PIPELINE_IDLE_KEY, PIPELINE_HOLD_KEY, LINKEDIN_LOGGED_OUT_KEY]);
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
  // 1.2.0.32: LinkedIn work found the login wall - the one thing the user has to do.
  const loggedOutAt = store[LINKEDIN_LOGGED_OUT_KEY];
  if (linkedinLoggedOutRecently(loggedOutAt)) {
    return `LinkedIn is not logged in in this browser - please log in at linkedin.com · LinkedIn work tries again around ${timeLabel(loggedOutAt + LINKEDIN_LOGGED_OUT_WAIT_MS)} · ${await webSideText()}`;
  }
  const release = await timeBelowCeiling(PIPELINE_TOUCH_CEILING);
  if (release) return `LinkedIn limit for automation reached · resumes around ${timeLabel(release)} · ${await webSideText()}`;
  if (await discoveryRunning()) return "Researching new target accounts on the web - preparation starts on each one as it is added.";
  const idle = store[PIPELINE_IDLE_KEY];
  if (idle && idle.reason === "nothing_left") return "All accounts processed for today. Your daily LinkedIn limit is now free for scanning.";
  if (idle && idle.reason === "no_backup") return "Waiting for today's backup before starting. It is made while a SalesTeam page is open.";
  return "Automatic preparation is on. It starts on its own while Chrome is open.";
}

// Build step 5 (W6, R12.7.3): the web research line, under the pie and in Settings > Automation. A zero
// or used-up budget is stated, not hidden. Empty while automatic preparation itself is off - the line
// above already says so, and web research runs only inside it.
function usd(n) {
  return `US$${(Number(n) || 0).toFixed(2).replace(/\.00$/, "")}`;
}

export async function webStatusLine() {
  const auto = await getPipelineAutomation();
  if (!auto.enabled) return "";
  const w = await webBudgetState();
  const without = "Accounts will still be made ready from LinkedIn, but without web details.";
  switch (w.reason) {
    case "off": return `Web research is off. ${without} You can turn it on in Settings > Automation.`;
    case "no_key": return `Web research is paused: there is no Anthropic API key. ${without} Add a key in Settings > API key to continue.`;
    case "zero": return `Web research is paused: the monthly budget is US$0. ${without} Set a budget in Settings > Automation to continue.`;
    case "used_up": return `Web research is paused: this month's budget of ${usd(w.monthlyUsd)} is used up. ${without} Raise the budget to continue.`;
    case "credit": return `Web research is paused for today: the Anthropic API credit balance is empty. ${without} Add credits in the Anthropic Console under Plans & Billing; it tries again tomorrow, or at once when the key or the budget changes.`;
    case "limit": return `Web research is paused for today: the spending limit set in the Anthropic Console is reached. ${without} Raise it there under Settings > Limits; it tries again tomorrow, or at once when the key or the budget changes.`;
    default: return `Web research is on: ${usd(w.spentUsd)} of ${usd(w.monthlyUsd)} used this month (${w.researches} research${w.researches === 1 ? "" : "es"}).`;
  }
}

export function watchWebStatusLine(el) {
  if (!el) return;
  const paint = async () => {
    try { const text = await webStatusLine(); el.textContent = text; el.hidden = !text; } catch { /* leave the last text */ }
  };
  const keys = [PIPELINE_AUTOMATION_KEY, PIPELINE_WEB_SPEND_KEY, PIPELINE_STATE_KEY];
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && keys.some((k) => changes[k])) paint(); });
  setInterval(paint, 60000);
  paint();
}

// Keeps an element showing pipelineStatusLine(), refreshed whenever what it depends on changes.
export function watchPipelineStatusLine(el) {
  if (!el) return;
  const paint = async () => { try { el.textContent = await pipelineStatusLine(); } catch { /* leave the last text */ } };
  const keys = [PIPELINE_STATE_KEY, PIPELINE_IDLE_KEY, PIPELINE_HOLD_KEY, PIPELINE_AUTOMATION_KEY, "activeBatchJob", WEB_LANE_STATE_KEY];
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
  // The waiting text depends on more than the run record (the automation switch, a hold, a job of the user's,
  // the LinkedIn visits freeing up), so it is repainted when those change and once a minute.
  const waitKeys = [PIPELINE_IDLE_KEY, PIPELINE_HOLD_KEY, PIPELINE_AUTOMATION_KEY, "activeBatchJob", WEB_LANE_STATE_KEY, WEB_DISCOVERY_STATE_KEY];
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local" && waitKeys.some((k) => changes[k])) paintBar(await read());
  });
  setInterval(async () => paintBar(await read()), 60000);
  render(await read());
  // Build step 3: this page kicks the automatic pipeline now and every 10 minutes while it is open.
  maybeAskConsent().catch(() => {});
  kickPipelineFromPage("page_open");
  setInterval(() => kickPipelineFromPage("page_open"), PIPELINE_KICK_EVERY_MS);
}
