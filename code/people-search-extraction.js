// Shared orchestration for an EXPERIMENTAL alternative to profile-extraction.js:
// instead of visiting a Post lead's own profile page, search LinkedIn People
// Search by the author's exact name, filtered to Switzerland (geoUrn -
// confirmed live by the user against LinkedIn's own "Locations" filter on
// People Search, v0.29.24), and read location/company straight off the
// matching result card. Deliberately does NOT replace runProfileExtraction
// yet - this only produces comparison data (see storage.js's
// applyPeopleSearchComparison) so the two methods' accuracy can be judged
// side by side before this is trusted as a real source. Same reasoning for
// running this as its own module: identical selection/pacing/timeout shape
// as profile-extraction.js, but a genuinely different target page and
// message type, not worth conflating into one file.
//
// Two ideas this exists to test, both confirmed against the live LinkedIn UI
// before writing this (never guessed): (1) Post Search has no location
// filter at all (confirmed: the Posts results filter bar has no Locations
// chip), so there is no way to geo-scope the ORIGINAL post search - this
// module cannot fix that, it only makes location-lookup for an already-found
// lead cheaper/more accurate. (2) People Search DOES support a location
// filter (confirmed: selecting Switzerland there produces
// geoUrn=["106693272"]), and its result cards show location and current
// company directly, without needing a full profile visit.

import { recordLinkedinTouch } from "./linkedin-touch-log.js";
import { checkTouchBudget } from "./touch-budget-guard.js";

// Switzerland's LinkedIn geoUrn ID, confirmed live by the user (2026-09) by
// applying the "Locations" filter on People Search and reading the resulting
// URL - not guessed or looked up from documentation.
const SWITZERLAND_GEO_URN = "106693272";

const PEOPLE_SEARCH_NAV_TIMEOUT_MS = 20000;
const PEOPLE_SEARCH_SCRAPE_TIMEOUT_MS = 15000;
const MIN_PEOPLE_SEARCH_DELAY_MS = 4000;
const MAX_PEOPLE_SEARCH_DELAY_MS = 9000;
// Same rough-estimate reasoning as profile-extraction.js's
// TYPICAL_PROFILE_LOAD_MS - a search-results page is likely lighter than a
// full profile page, but that hasn't been measured yet, so this reuses the
// same conservative assumption rather than guessing lower.
const TYPICAL_PEOPLE_SEARCH_LOAD_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPeopleSearchDelay() {
  return MIN_PEOPLE_SEARCH_DELAY_MS + Math.random() * (MAX_PEOPLE_SEARCH_DELAY_MS - MIN_PEOPLE_SEARCH_DELAY_MS);
}

function buildPeopleSearchUrl(authorName) {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(authorName)}` +
    `&origin=FACETED_SEARCH&geoUrn=%5B%22${SWITZERLAND_GEO_URN}%22%5D`;
}

function normalizeAuthorName(name) {
  return (name || "").trim().toLowerCase();
}

// A Post lead worth checking: a real named author (a Job lead's "creator" is
// the company itself - no person to look up), skipping anything already
// checked this way (peopleSearchCheckedAt set) so a run doesn't keep
// re-querying the same people forever, same reasoning as
// profile-extraction.js's profileVisitedAt guard.
export function leadsForPeopleSearchComparison(leads) {
  return leads.filter((l) => l.type !== "job" && l.author && l.author.trim() && !l.peopleSearchCheckedAt);
}

// The same author can back more than one lead (two posts from the same
// person) - grouped so each real person is only searched once. Each lead's
// own `headline` is the author's LinkedIn headline, not the post's, so it's
// identical across every lead in a group; the first one is representative.
function groupByAuthor(leads) {
  const groups = new Map();
  for (const lead of leads) {
    const key = normalizeAuthorName(lead.author);
    if (!groups.has(key)) groups.set(key, { authorName: lead.author, headline: lead.headline || "", leads: [] });
    groups.get(key).leads.push(lead);
  }
  return [...groups.values()];
}

export function uniquePeopleSearchAuthorCount(leads) {
  return groupByAuthor(leads).length;
}

export function estimatePeopleSearchMinutes(count) {
  const avgPacingMs = (MIN_PEOPLE_SEARCH_DELAY_MS + MAX_PEOPLE_SEARCH_DELAY_MS) / 2;
  return Math.ceil((count * (avgPacingMs + TYPICAL_PEOPLE_SEARCH_LOAD_MS)) / 60000);
}

export function peopleSearchConfirmText(authorCount, leadCount = authorCount) {
  const estMinutes = estimatePeopleSearchMinutes(authorCount);
  const sharedNote = leadCount !== authorCount ? ` (covering ${leadCount} leads sharing these authors)` : "";
  return `Experimental: this will look up ${authorCount} author${authorCount === 1 ? "" : "s"} by name in LinkedIn People ` +
    `Search, filtered to Switzerland${sharedNote} (roughly ${estMinutes} minute${estMinutes === 1 ? "" : "s"} - paced to avoid ` +
    "rapid-fire requests). Results are only stored for comparison against existing data - they do not overwrite the " +
    "lead's company or location. Continue?";
}

// Mirrors profile-extraction.js's navigateAndWaitProfile exactly, including
// the .catch(() => {}) fix for the same unhandled-promise-rejection class of
// bug (chrome.tabs.update's returned promise rejecting if the tab closes out
// from under it).
function navigateAndWaitPeopleSearch(tabId, url) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navCompleted: false });
      }
    }, PEOPLE_SEARCH_NAV_TIMEOUT_MS);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete" && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navCompleted: true });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(() => {});
    recordLinkedinTouch().catch(() => {});
  });
}

// Filters by authorName, not just "the next message" - same reasoning as
// profile-extraction.js's profileUrl filtering, in case an unrelated tab is
// also open on a People Search page at the same time.
function waitForPeopleSearchResult(expectedAuthorName) {
  const expected = normalizeAuthorName(expectedAuthorName);
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ matched: false, location: null, company: null, debug: { timedOut: true } });
      }
    }, PEOPLE_SEARCH_SCRAPE_TIMEOUT_MS);
    function listener(message) {
      if (message?.type === "PEOPLE_SEARCH_RESULT" && normalizeAuthorName(message.authorName) === expected && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve({
          matched: Boolean(message.matched),
          location: message.location || null,
          company: message.company || null,
          debug: message.debug || null,
        });
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

const MAX_DEBUG_SAMPLES = 3;

// Visits each unique author's People Search page one at a time, paced like
// profile-extraction.js, and resolves with:
// - results: {key, matched, peopleSearchLocation, peopleSearchCompany} for
//   every lead in every checked group (matched: false when no confident
//   name+headline match was found among the results - never a guess).
// - debugSamples: up to MAX_DEBUG_SAMPLES diagnostic bundles for unmatched/
//   timed-out lookups, same purpose as profile-extraction.js's.
// - hardTimeoutCount: how many leads (not groups) hit a hard timeout.
// Never touches chrome.storage.local's results map - the caller applies
// `results` (applyPeopleSearchComparison, storage.js) itself.
export async function runPeopleSearchComparison(leads, { onProgress } = {}) {
  const groups = groupByAuthor(leads);
  const results = [];
  const debugSamples = [];
  let hardTimeoutCount = 0;
  let stoppedByTouchBudget = false;
  let tab;
  try {
    // Same reasoning as scanAllTopics (background.js) and the other
    // extraction modules: a multi-lead run can take long enough that system
    // sleep mid-run freezes it for however long the machine was asleep.
    // Released in the finally below on every exit path.
    chrome.power.requestKeepAwake("system");
    tab = await chrome.tabs.create({ url: "about:blank", active: false });
    for (let i = 0; i < groups.length; i++) {
      // v0.30.0: this loop had no abort check of any kind before - the
      // shared 75/99 LinkedIn touch budget (touch-budget-guard.js) is the
      // first one it gets, checked at the same per-item granularity every
      // other LinkedIn-navigating loop in this codebase already uses.
      if (await checkTouchBudget()) { stoppedByTouchBudget = true; break; }
      const group = groups[i];
      if (onProgress) onProgress(i + 1, groups.length);
      // The content script needs to know WHO it's looking for and what
      // headline counts as a confident match - stored per-visit (one tab,
      // one target at a time, same sequential-visit shape as
      // profile-extraction.js) rather than passed via the URL, since the
      // headline can contain characters awkward to round-trip through a
      // query string.
      await chrome.storage.local.set({
        peopleSearchExtractionActive: true,
        peopleSearchTarget: { authorName: group.authorName, headline: group.headline },
      });
      const { navCompleted } = await navigateAndWaitPeopleSearch(tab.id, buildPeopleSearchUrl(group.authorName));
      const { matched, location, company, debug } = await waitForPeopleSearchResult(group.authorName);
      const hardTimedOut = Boolean(debug?.timedOut);
      if (hardTimedOut) hardTimeoutCount += group.leads.length;
      for (const lead of group.leads) {
        results.push({ key: lead.key, matched, peopleSearchLocation: location, peopleSearchCompany: company });
      }
      if (!matched && debug && debugSamples.length < MAX_DEBUG_SAMPLES) {
        debugSamples.push({ authorName: group.authorName, navCompleted, ...debug });
      }
      if (i < groups.length - 1) await sleep(randomPeopleSearchDelay());
    }
  } finally {
    chrome.power.releaseKeepAwake();
    await chrome.storage.local.remove(["peopleSearchExtractionActive", "peopleSearchTarget"]).catch(() => {});
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
  return { results, debugSamples, hardTimeoutCount, stoppedByTouchBudget };
}
