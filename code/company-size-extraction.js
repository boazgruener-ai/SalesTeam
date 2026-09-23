import { withBatch } from "./batch-jobs.js";
// Orchestrates PRD 6.20 Phase 8's own real gap, fixed 2026-09-17 per the
// user's own explicit request ("size is a very important piece of
// information for an account... we must be able to have this for every
// discovered company"): a Discovered-only company never carries a real
// employee count (company-discovery-content-script.js's extractCard only
// ever reads name/industry/location off a search-result card - LinkedIn
// never shows size there), so computeCompanyDeterministicPreScore's size
// nudge (storage.js) could never fire for one, no matter how the user
// configured Size priorities. Confirmed live that a company's OWN page DOES
// show it - see company-size-content-script.js's own header comment for the
// full DOM evidence. Modeled directly on company-resolve-extraction.js's
// own direct-link path (resolveViaDirectLink) - a company here always
// already carries its own linkedinLink (from Discovery or the import), so
// there's no name-based search/matching step needed at all, just one
// navigation and one read per company.

import { recordLinkedinTouch } from "./linkedin-touch-log.js";
import { checkTouchBudget } from "./touch-budget-guard.js";

const NAV_TIMEOUT_MS = 20000;
const RESULT_TIMEOUT_MS = NAV_TIMEOUT_MS + 8000;
const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 9000;
const TYPICAL_LOAD_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

export function estimateSizeFetchMinutes(count) {
  const avgPacingMs = (MIN_DELAY_MS + MAX_DELAY_MS) / 2;
  return Math.ceil((count * (avgPacingMs + TYPICAL_LOAD_MS)) / 60000);
}

export function sizeFetchConfirmText(count) {
  const estMinutes = estimateSizeFetchMinutes(count);
  return `This will visit ${count} compan${count === 1 ? "y" : "ies"}' own LinkedIn pages to read their displayed ` +
    `employee-count (roughly ${estMinutes} minute${estMinutes === 1 ? "" : "s"} - paced to avoid rapid-fire ` +
    "requests). Each company is only ever visited once - already-sized ones are skipped on future runs. Continue?";
}

// Same listener-race fix as company-resolve-extraction.js's own
// navigateAndWaitResolve (registered by the caller BEFORE this starts
// navigating, not after) - a document_idle content script on a JS-heavy
// SPA page can run and message back before the tab's own "complete" event
// fires, so the result listener has to already be live.
function navigateAndWait(tabId, url) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; chrome.tabs.onUpdated.removeListener(listener); resolve({ navCompleted: false }); }
    }, NAV_TIMEOUT_MS);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete" && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navCompleted: true });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url, active: true }).catch(() => {});
    recordLinkedinTouch().catch(() => {});
  });
}

function waitForSizeResult(companyKey) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ resolved: false, employeeCount: null, sizeBandText: null, debug: { timedOut: true } });
      }
    }, RESULT_TIMEOUT_MS);
    function listener(message) {
      if (message?.type === "COMPANY_SIZE_RESULT" && message.companyKey === companyKey && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve({
          resolved: Boolean(message.resolved),
          employeeCount: message.employeeCount ?? null,
          sizeBandText: message.sizeBandText || null,
          debug: message.debug || null,
        });
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

const MAX_DEBUG_SAMPLES = 8;

// Visits each company one at a time, paced like every other extraction
// module here. companies: { key, company, companyId, linkedinLink }[] -
// see storage.js's getCompaniesNeedingSize. Returns:
// - results: { companyId, employeeCount, sizeBandText }[] for every company
//   the page confirmed a real band for.
// - debugSamples: up to 8 failures, same diagnostic shape as the other
//   extraction modules.
// - attemptedKeys: every company actually reached this run, success or
//   failure - markCompanySizeFetchAttempted needs exactly this list so a
//   genuinely-tried-but-unreadable company doesn't keep hogging the front
//   of the next run's queue (getCompaniesNeedingSize's own never-attempted-
//   first ordering).
async function runCompanySizeFetchImpl(companies, { onProgress, shouldAbort } = {}) {
  const results = [];
  const debugSamples = [];
  const attemptedKeys = [];
  let stoppedByTouchBudget = false;
  let stoppedByAbort = false;
  let tab;
  try {
    chrome.power.requestKeepAwake("system");
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
    // Same cold-start warm-up as company-resolve-extraction.js - a fresh
    // tab's very first navigation is unreliable for getting the content
    // script running before this orchestration's own timeout gives up.
    await navigateAndWait(tab.id, "https://www.linkedin.com/feed/");
    for (let i = 0; i < companies.length; i++) {
      if (shouldAbort && shouldAbort()) { stoppedByAbort = true; break; }
      if (await checkTouchBudget()) { stoppedByTouchBudget = true; break; }
      const company = companies[i];
      if (onProgress) onProgress({ index: i, total: companies.length, company: company.company });
      attemptedKeys.push(company.key);

      await chrome.storage.local.set({ companySizeFetchActive: true, companySizeFetchTarget: company.key });
      const resultPromise = waitForSizeResult(company.key);
      await navigateAndWait(tab.id, company.linkedinLink);
      const { resolved, employeeCount, sizeBandText, debug } = await resultPromise;

      if (resolved && employeeCount != null) {
        results.push({ companyId: company.companyId, employeeCount, sizeBandText });
      } else if (debugSamples.length < MAX_DEBUG_SAMPLES) {
        debugSamples.push({ company: company.company, sizeBandText, ...debug });
      }
      if (i < companies.length - 1) await sleep(randomDelay());
    }
  } finally {
    chrome.power.releaseKeepAwake();
    await chrome.storage.local.remove(["companySizeFetchActive", "companySizeFetchTarget"]).catch(() => {});
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
  return { results, debugSamples, attemptedKeys, stoppedByTouchBudget, stoppedByAbort };
}

export function runCompanySizeFetch(...args) {
  return withBatch("Looking up company sizes on LinkedIn", () => runCompanySizeFetchImpl(...args));
}
