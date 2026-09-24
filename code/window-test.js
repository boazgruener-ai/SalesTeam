// THROWAWAY - build step 0 of the 1.2.0 data pipeline (DATA_PIPELINE_DESIGN.md section 8, decision D1).
// Delete this file, window-test.html/-page.js/-probe.html/-probe.js and the one import in background.js
// once the answer is recorded in the design doc.
//
// Question: can the pipeline visit LinkedIn from a dedicated UNFOCUSED window, without the `active: true`
// trick the user-started runners use (company-resolve-extraction.js), while that window is
// (a) visible, (b) covered by other windows, (c) minimised, (d) on a locked screen with the machine awake?
//
// Runs here in the service worker, not in the harness page, because that is where the pipeline will run:
// a page-hosted loop would itself be throttled when the screen locks and blur the result.
//
// Read-only on account data: it re-checks accounts that ALREADY have a linkedinCompanyId and compares the
// id it reads back. It never writes to the account stores. It does record touches (they are real visits),
// and it stops at the 75 warn line in the rolling 24h - the same ceiling the pipeline will use - rather
// than calling checkTouchBudget, which would set the shared scanAbortRequested flag as a side effect.
import { getTargetAccounts, normalizeCompanyName } from "./storage.js";
import { recordLinkedinTouch, getLinkedinTouchStats, TOUCH_WARN_THRESHOLD_24H } from "./linkedin-touch-log.js";
import { acquireBatch, BatchBusyError } from "./batch-jobs.js";

const STATE_KEY = "windowTestState";
const STOP_KEY = "windowTestStopRequested";
// Same numbers as company-resolve-extraction.js, so a timeout here means what it means there.
const NAV_TIMEOUT_MS = 20000;
const RESOLVE_TIMEOUT_MS = NAV_TIMEOUT_MS + 8000;
const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 9000;
const PROBE_TIMEOUT_MS = 25000;
const MAX_LOOKUPS = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);

async function getState() {
  return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || { rounds: [], usedKeys: [] };
}
async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}
async function stopRequested() {
  return Boolean((await chrome.storage.local.get(STOP_KEY))[STOP_KEY]);
}

// Primary keys only (the map also holds alias keys), with both an id to compare against and a link to
// visit, not used in an earlier round - so no round is flattered by LinkedIn's own caching of a page.
async function pickAccounts(count, usedKeys) {
  const map = await getTargetAccounts();
  const used = new Set(usedKeys);
  const pool = Object.entries(map)
    .filter(([key, v]) => key === normalizeCompanyName(v.company) && v.linkedinLink && v.linkedinCompanyId && !v.deletedAt && !used.has(key))
    .map(([key, v]) => ({ key, ...v }));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

// Note: NO `active: true` - that is the whole point of the test.
function navigate(tabId, url, { touch = true } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ navCompleted: false, navMs: Date.now() - started, finalUrl: null });
    }, NAV_TIMEOUT_MS);
    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete" || settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ navCompleted: true, navMs: Date.now() - started, finalUrl: tab?.url || null });
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(() => {});
    if (touch) recordLinkedinTouch().catch(() => {});
  });
}

function waitForMessage(match, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ message: null, ms: Date.now() - started });
    }, timeoutMs);
    function listener(message) {
      if (settled || !match(message)) return;
      settled = true;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ message, ms: Date.now() - started });
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

// Zero-touch: loads our own probe page into the SAME tab, so it reports how Chrome is treating that tab
// right now (visibilityState, whether animation frames run, how late timers fire).
async function runProbe(tabId, label) {
  const nonce = `${label}-${Date.now()}`;
  const wait = waitForMessage((m) => m?.type === "WINDOW_TEST_PROBE_RESULT" && m.nonce === nonce, PROBE_TIMEOUT_MS);
  await navigate(tabId, chrome.runtime.getURL(`window-test-probe.html?nonce=${encodeURIComponent(nonce)}`), { touch: false });
  const { message } = await wait;
  return message ? message.probe : { timedOut: true };
}

async function windowState(windowId) {
  try {
    const w = await chrome.windows.get(windowId);
    return { state: w.state, focused: w.focused };
  } catch {
    return { state: "gone", focused: false };
  }
}

async function lookup(tabId, windowId, account) {
  const candidates = [account.company, account.officialName, account.alternativeName].filter(Boolean);
  await chrome.storage.local.set({
    companyResolveActive: true,
    companyResolveDirectLink: true,
    companyResolveTarget: account.company,
    companyResolveTargetCandidates: candidates,
  });
  const expected = (account.company || "").trim().toLowerCase();
  const before = await windowState(windowId);
  const resultWait = waitForMessage(
    (m) => m?.type === "COMPANY_RESOLVE_RESULT" && (m.companyName || "").trim().toLowerCase() === expected,
    RESOLVE_TIMEOUT_MS,
  );
  const nav = await navigate(tabId, account.linkedinLink);
  const { message, ms } = await resultWait;
  const after = await windowState(windowId);
  return {
    company: account.company,
    navCompleted: nav.navCompleted,
    navMs: nav.navMs,
    resultMs: message ? ms : null,
    timedOut: !message,
    resolved: Boolean(message?.resolved),
    idMatches: message?.resolved ? String(message.linkedinCompanyId) === String(account.linkedinCompanyId) : null,
    finalUrl: nav.finalUrl,
    windowBefore: before.state,
    windowAfter: after.state,
    workerFocused: before.focused || after.focused,
  };
}

async function runRound({ condition, lookups, countdownSec }) {
  const state = await getState();
  const round = {
    id: Date.now(),
    condition,
    requestedLookups: lookups,
    startedAt: new Date().toISOString(),
    status: "starting",
    lookups: [],
  };
  state.rounds.push(round);
  state.running = round.id;
  await saveState(state);
  const persist = async (patch = {}) => {
    Object.assign(round, patch);
    const s = await getState();
    const i = s.rounds.findIndex((r) => r.id === round.id);
    if (i >= 0) s.rounds[i] = round;
    s.usedKeys = state.usedKeys;
    await saveState(s);
  };

  await chrome.storage.local.remove(STOP_KEY);
  let win = null;
  try {
    const accounts = lookups > 0 ? await pickAccounts(lookups, state.usedKeys || []) : [];
    if (lookups > 0 && accounts.length === 0) {
      await persist({ status: "error", error: "No accounts with both a LinkedIn link and a LinkedIn id are left to test with." });
      return;
    }

    // Remember what had focus, to check afterwards that the worker window did not take it.
    const focusedBefore = await chrome.windows.getLastFocused().catch(() => null);
    win = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal", width: 560, height: 640, left: 40, top: 40 });
    const tabId = win.tabs[0].id;
    if (condition === "minimised") await chrome.windows.update(win.id, { state: "minimized" });
    const focusedAfter = await chrome.windows.getLastFocused().catch(() => null);
    await persist({
      status: "countdown",
      countdownEndsAt: Date.now() + countdownSec * 1000,
      focusStolenAtCreate: Boolean(focusedAfter && focusedAfter.id === win.id && focusedBefore?.id !== win.id),
    });
    // Time for the tester to arrange the condition: cover the window, or press Win+L.
    for (let t = 0; t < countdownSec; t++) {
      if (await stopRequested()) break;
      await sleep(1000);
    }

    await persist({ status: "probing", probeStart: await runProbe(tabId, "start") });

    if (accounts.length > 0 && !(await stopRequested())) {
      await persist({ status: "warming up" });
      // Mirrors the real runner's warm-up visit, so the first real lookup is never the tab's first
      // LinkedIn navigation. Counts as a touch.
      await navigate(tabId, "https://www.linkedin.com/feed/");
      for (let i = 0; i < accounts.length; i++) {
        if (await stopRequested()) { await persist({ stoppedBy: "user" }); break; }
        const { last24h } = await getLinkedinTouchStats();
        if (last24h >= TOUCH_WARN_THRESHOLD_24H) { await persist({ stoppedBy: `touch ceiling (${last24h} in 24h)` }); break; }
        await persist({ status: `lookup ${i + 1} of ${accounts.length}` });
        state.usedKeys = [...(state.usedKeys || []), accounts[i].key];
        round.lookups.push(await lookup(tabId, win.id, accounts[i]));
        await persist();
        if (i < accounts.length - 1) await sleep(randomDelay());
      }
    }

    await persist({ status: "probing", probeEnd: await runProbe(tabId, "end") });
    const done = round.lookups;
    const ok = done.filter((l) => !l.timedOut).map((l) => l.resultMs);
    await persist({
      status: "done",
      finishedAt: new Date().toISOString(),
      summary: {
        lookups: done.length,
        timeouts: done.filter((l) => l.timedOut).length,
        resolved: done.filter((l) => l.resolved).length,
        idMismatches: done.filter((l) => l.idMatches === false).length,
        avgResultMs: ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
        maxResultMs: ok.length ? Math.max(...ok) : null,
        workerEverFocused: done.some((l) => l.workerFocused),
      },
    });
  } catch (err) {
    await persist({ status: "error", error: err?.message || String(err) });
  } finally {
    await chrome.storage.local
      .remove(["companyResolveActive", "companyResolveTarget", "companyResolveDirectLink", "companyResolveTargetCandidates", STOP_KEY])
      .catch(() => {});
    if (win) await chrome.windows.remove(win.id).catch(() => {});
    const s = await getState();
    s.running = null;
    await saveState(s);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "WINDOW_TEST_START") {
    const lookups = Math.max(0, Math.min(MAX_LOOKUPS, Number(message.lookups) || 0));
    const countdownSec = Math.max(0, Math.min(60, Number(message.countdownSec) || 0));
    acquireBatch(`Worker-window test (${message.condition})`).then((release) => {
      sendResponse({ ok: true });
      // Same trick as background.js's withKeepAlive, held for the whole round: the waits here can run
      // 28s with no extension-API activity, long enough for Chrome to stop an idle service worker.
      const keepAlive = setInterval(() => chrome.storage.local.get("keepAlive").catch(() => {}), 4000);
      runRound({ condition: message.condition, lookups, countdownSec }).finally(() => {
        clearInterval(keepAlive);
        release();
      });
    }).catch((err) => sendResponse({ ok: false, error: err instanceof BatchBusyError ? err.message : String(err?.message || err) }));
    return true;
  }
  if (message?.type === "WINDOW_TEST_STOP") {
    chrome.storage.local.set({ [STOP_KEY]: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "WINDOW_TEST_CLEAR") {
    getState().then((s) => (s.running ? { ok: false, error: "A round is running." } : saveState({ rounds: [], usedKeys: s.usedKeys || [] }).then(() => ({ ok: true }))))
      .then(sendResponse);
    return true;
  }
});
