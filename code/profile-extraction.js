// Shared orchestration for visiting individual LinkedIn profile pages to
// recover a company/location a search-results-feed scrape couldn't see
// (see PRD 6.3). Used by both the Dashboard's "Extract Companies from
// Profiles" button and the side panel's post-scan prompt - one
// implementation so both entry points share identical selection/pacing/
// timeout behavior instead of drifting apart. Deliberately no dependency on
// storage.js: this module only visits pages and returns raw scrape results:
// {key, company, location} - the caller applies them (applyExtractedCompanies)
// and re-checks the Location Filter itself.

const PROFILE_NAV_TIMEOUT_MS = 20000;
const PROFILE_SCRAPE_TIMEOUT_MS = 15000;
const MIN_PROFILE_DELAY_MS = 4000;
const MAX_PROFILE_DELAY_MS = 9000;
// A rough, typical (not worst-case) combined page-navigation + scrape-poll
// time, for the confirmation dialog's estimate only - the actual per-profile
// cost is dominated by real LinkedIn page-load time (up to the
// PROFILE_NAV_TIMEOUT_MS ceiling), which varies a lot and isn't knowable in
// advance. An earlier version of this estimate only counted the pacing
// delay below and badly undercounted the real total (reported directly: a
// real run of 55 profiles took ~15 minutes, not the 1.5-3 the old estimate
// implied).
const TYPICAL_PROFILE_LOAD_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomProfileDelay() {
  return MIN_PROFILE_DELAY_MS + Math.random() * (MAX_PROFILE_DELAY_MS - MIN_PROFILE_DELAY_MS);
}

function navigateAndWaitProfile(tabId, url) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, PROFILE_NAV_TIMEOUT_MS);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete" && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

// Filters by profileUrl, not just "the next message that arrives" - a
// separate, unrelated tab the user happens to have open on a LinkedIn
// profile at the same time would otherwise be able to race this and resolve
// it with the wrong company.
function normalizeProfileUrl(url) {
  return (url || "").split("?")[0].replace(/\/$/, "");
}

function waitForProfileScrapeResult(expectedUrl) {
  const expected = normalizeProfileUrl(expectedUrl);
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ company: null, location: null, debug: { timedOut: true } });
      }
    }, PROFILE_SCRAPE_TIMEOUT_MS);
    function listener(message) {
      if (message?.type === "PROFILE_SCRAPE_RESULT" && normalizeProfileUrl(message.profileUrl) === expected && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ company: message.company || null, location: message.location || null, debug: message.debug || null });
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

// A lead worth visiting: a Post (or in-post job ad) - a Job lead's
// "creator" is the company itself, no person to check - missing a company
// or location, with a profileUrl to actually visit. Shared by both entry
// points so "how many leads need this" never disagrees between them.
export function leadsMissingProfileData(leads) {
  return leads.filter((l) => l.type !== "job" && (!l.company || !l.location) && l.profileUrl);
}

export function estimateProfileVisitMinutes(count) {
  const avgPacingMs = (MIN_PROFILE_DELAY_MS + MAX_PROFILE_DELAY_MS) / 2;
  return Math.ceil((count * (avgPacingMs + TYPICAL_PROFILE_LOAD_MS)) / 60000);
}

export function profileVisitConfirmText(count) {
  const estMinutes = estimateProfileVisitMinutes(count);
  return `This will visit ${count} individual LinkedIn profile page${count === 1 ? "" : "s"} one at a time ` +
    `(roughly ${estMinutes} minute${estMinutes === 1 ? "" : "s"} - real page-load time varies, paced to avoid rapid-fire ` +
    "requests) to look for a stated current employer and location. Continue?";
}

// Caps how many failed profiles' diagnostics get kept per run - a handful
// is plenty to spot a pattern (a shared cause across everyone that failed)
// without bloating the Activity Log entry that reports them.
const MAX_DEBUG_SAMPLES = 3;

// Visits each lead's profile page one at a time, paced with a randomized
// delay between visits, and resolves with:
// - found: {key, company, location} for leads where something was found
// - debugSamples: up to MAX_DEBUG_SAMPLES {profileUrl, ...diagnostics} for
//   leads where nothing was found at all, so a mostly-failing run can be
//   diagnosed (from the Activity Log) without needing to catch a
//   background tab's live console during an unattended multi-profile run.
// Never touches chrome.storage.local's results map itself - the caller
// applies `found` (applyExtractedCompanies, storage.js) and re-checks the
// Location Filter on its own terms.
export async function runProfileExtraction(leads, { onProgress } = {}) {
  const found = [];
  const debugSamples = [];
  let tab;
  try {
    await chrome.storage.local.set({ profileExtractionActive: true });
    tab = await chrome.tabs.create({ url: "about:blank", active: false });
    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      if (onProgress) onProgress(i + 1, leads.length);
      await navigateAndWaitProfile(tab.id, lead.profileUrl);
      const { company, location, debug } = await waitForProfileScrapeResult(lead.profileUrl);
      if (company || location) {
        found.push({ key: lead.key, company, location });
      } else if (debug && debugSamples.length < MAX_DEBUG_SAMPLES) {
        debugSamples.push({ profileUrl: lead.profileUrl, ...debug });
      }
      if (i < leads.length - 1) await sleep(randomProfileDelay());
    }
  } finally {
    await chrome.storage.local.remove("profileExtractionActive").catch(() => {});
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
  return { found, debugSamples };
}
