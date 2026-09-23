import { withBatch } from "./batch-jobs.js";
// Shared orchestration for visiting individual LinkedIn profile pages to
// recover a company/location a search-results-feed scrape couldn't see
// (see PRD 6.3). Used by both the Dashboard's "Extract Companies from
// Profiles" button and the side panel's post-scan prompt - one
// implementation so both entry points share identical selection/pacing/
// timeout behavior instead of drifting apart. Deliberately no dependency on
// storage.js: this module only visits pages and returns raw scrape results:
// {key, company, location} - the caller applies them (applyExtractedCompanies)
// and re-checks the Location Filter itself. linkedin-touch-log.js is a
// separate, single-purpose module (not storage.js) so recording a real
// LinkedIn navigation doesn't reintroduce that dependency.
import { recordLinkedinTouch } from "./linkedin-touch-log.js";

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

// Returns { navCompleted } so a hard scrape timeout right after can tell
// "the page itself never finished loading" (navCompleted: false, the real
// nav-level problem) apart from "the page loaded fine but the content
// script never responded" (navCompleted: true - a script-level problem,
// e.g. injection failure or a crash before it could send its result).
// Reported directly: three real leads (all sharing a "/en/" locale-path
// profileUrl variant, e.g. ".../jochen-eversmeier-28693717b/en/") hard-
// timed-out with no message ever received, yet the same URL loaded fine
// when opened normally - this distinction is what's needed to tell whether
// the automated background-tab navigation itself is the difference.
function navigateAndWaitProfile(tabId, url) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navCompleted: false });
      }
    }, PROFILE_NAV_TIMEOUT_MS);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete" && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navCompleted: true });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // active: true re-asserted on every navigation, not just at tab creation
    // (see runProfileExtraction's own comment on why the tab is active at
    // all now) - keeps it foregrounded even if the user switches tabs
    // mid-run, since Chrome's background-tab throttling cares about a tab's
    // current focus state, not just how it started out. Same fix as
    // background.js's navigateAndWait for the unawaited-promise/unhandled-
    // rejection issue below.
    chrome.tabs.update(tabId, { url, active: true }).catch(() => {});
    recordLinkedinTouch().catch(() => {});
  });
}

// Filters by profileUrl, not just "the next message that arrives" - a
// separate, unrelated tab the user happens to have open on a LinkedIn
// profile at the same time would otherwise be able to race this and resolve
// it with the wrong company.
//
// Confirmed root cause of a real hard-timeout failure (three leads,
// including jochen-eversmeier-28693717b, all with "no message ever
// received" despite the content script demonstrably finding and sending the
// right data): a lead's stored profileUrl can be the "/in/<slug>/en/"
// locale-path variant (scraped from certain LinkedIn UI links that use it,
// e.g. a post-author link in someone's own Activity carousel) rather than
// the canonical "/in/<slug>/" form. Visiting that URL, LinkedIn redirects it
// to "/in/<slug>/?locale=en" - a DIFFERENT path, just with the locale moved
// into a query param instead. The old version of this function only ever
// stripped the query string and one trailing slash, so it normalized the
// stored "/en/" URL to ".../slug/en" but the actual page's reported URL to
// just ".../slug" - never equal, so a genuinely correct, successfully-sent
// result was silently rejected as "not a match" and the wait timed out.
// Matching on just the "/in/<slug>" prefix - the one part that's always the
// same regardless of locale path, query string, or trailing slash - fixes
// this for good instead of chasing one locale variant at a time.
function normalizeProfileUrl(url) {
  const match = (url || "").match(/^(https?:\/\/[^/]+\/in\/[^/?#]+)/i);
  return match ? match[1].toLowerCase() : (url || "").split("?")[0].replace(/\/$/, "");
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
// or location, with a profileUrl to actually visit, AND never already
// checked (profileVisitedAt unset). That last condition matters: without
// it, a lead whose profile has no findable location text (common - the
// heuristic is a small, Switzerland-biased hint-word list) would never
// leave this list, since only a successful find used to clear it - so the
// same leads kept coming back on every single run, run after run, forever.
export function leadsMissingProfileData(leads) {
  return leads.filter((l) => l.type !== "job" && (!l.company || !l.location) && !l.profileVisitedAt && l.profileUrl);
}

// The same person can back more than one lead needing a visit - e.g. two
// separate posts from someone whose company was never captured on either.
// Reported directly: a run showing "55" against an expected ~20 (leads
// missing a company) turned out to be both leads missing *location* too
// (also in scope, see leadsMissingProfileData above) AND several leads
// sharing one profileUrl, each counted separately. Grouping by normalized
// profileUrl is what lets runProfileExtraction visit each real profile only
// once no matter how many leads point at it.
function groupByProfile(leads) {
  const groups = new Map();
  for (const lead of leads) {
    const key = normalizeProfileUrl(lead.profileUrl);
    if (!groups.has(key)) groups.set(key, { profileUrl: lead.profileUrl, leads: [] });
    groups.get(key).leads.push(lead);
  }
  return [...groups.values()];
}

// The real number of page visits a run will make - what the confirmation
// dialog and progress counter should show, since it's what actually
// determines how long the run takes (not how many leads benefit from it).
export function uniqueProfileCount(leads) {
  return groupByProfile(leads).length;
}

export function estimateProfileVisitMinutes(count) {
  const avgPacingMs = (MIN_PROFILE_DELAY_MS + MAX_PROFILE_DELAY_MS) / 2;
  return Math.ceil((count * (avgPacingMs + TYPICAL_PROFILE_LOAD_MS)) / 60000);
}

// leadCount, when it differs from visitCount, means some leads share a
// profile - called out explicitly so the dialog's number matches what the
// user can already see (fewer distinct people than leads missing data).
export function profileVisitConfirmText(visitCount, leadCount = visitCount) {
  const estMinutes = estimateProfileVisitMinutes(visitCount);
  const sharedNote = leadCount !== visitCount ? ` (covering ${leadCount} leads that share these profiles)` : "";
  return `This will visit ${visitCount} individual LinkedIn profile page${visitCount === 1 ? "" : "s"}${sharedNote} one at a time ` +
    `(roughly ${estMinutes} minute${estMinutes === 1 ? "" : "s"} - real page-load time varies, paced to avoid rapid-fire ` +
    "requests) to look for a stated current employer and location. Continue?";
}

// Caps how many failed profiles' diagnostics get kept per run - a handful
// is plenty to spot a pattern (a shared cause across everyone that failed)
// without bloating the Activity Log entry that reports them.
const MAX_DEBUG_SAMPLES = 3;

// Visits each lead's profile page one at a time, paced with a randomized
// delay between visits, and resolves with:
// - found: {key, company, location, visited} for every lead whose profile
//   actually responded (visited: true even when company/location are both
//   null - see the comment at the push site below) - a hard timeout is the
//   only case with visited: false, so it's retried on the next run instead
//   of being marked permanently checked.
// - debugSamples: up to MAX_DEBUG_SAMPLES {profileUrl, company, location,
//   ...diagnostics} for leads where EITHER field is still missing (a total
//   miss or a partial one - a real lead reported directly got a company but
//   no location, which produced no sample at all until this was widened
//   from "both missing"), so a mostly-failing run can be diagnosed (from
//   the Activity Log) without needing to catch a background tab's live
//   console during an unattended multi-profile run.
// - hardTimeoutCount: how many leads (not groups) hit a hard timeout, so
//   the caller's completion message can say so plainly instead of a silent
//   failure reading identically to "this person's profile just has no
//   findable location" (reported directly).
// Never touches chrome.storage.local's results map itself - the caller
// applies `found` (applyExtractedCompanies, storage.js) and re-checks the
// Location Filter on its own terms.
async function runProfileExtractionImpl(leads, { onProgress } = {}) {
  // Deduped to one visit per real profile (see groupByProfile above) - a
  // result found for the shared profile is applied to every lead pointing
  // at it, so two posts from the same person cost one visit, not two.
  const groups = groupByProfile(leads);
  const found = [];
  const debugSamples = [];
  let hardTimeoutCount = 0;
  let tab;
  try {
    // Same reasoning as scanAllTopics (background.js): this can run long
    // enough (dozens of profiles) that a machine going to sleep mid-run
    // freezes it for however long the machine was asleep, not a real hang.
    // "system" only blocks sleep, not the screen turning off; released in
    // the finally below on every exit path.
    chrome.power.requestKeepAwake("system");
    await chrome.storage.local.set({ profileExtractionActive: true });
    // v0.29.47: reported directly with real evidence - a 65-profile run
    // hard-timed-out on 10 (all navCompleted: true, content script's result
    // never arrived), the exact same signature already root-caused for
    // runCompanyIdResolution's resolver (v0.29.43): a backgrounded tab
    // (active: false) gets throttled by Chrome badly enough on a heavy page
    // that the content script never gets far enough to send its message
    // within the timeout. That fix (making the tab active, kept active on
    // every navigation - see navigateAndWaitProfile) took the resolver's
    // hard-timeout rate from 15/25 to 0/10, confirmed over multiple runs;
    // applying the same fix here. Tradeoff: a visible tab jumping between
    // profiles during a run instead of working invisibly in the background.
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (onProgress) onProgress(i + 1, groups.length);
      const { navCompleted } = await navigateAndWaitProfile(tab.id, group.profileUrl);
      const { company, location, debug } = await waitForProfileScrapeResult(group.profileUrl);
      // A hard timeout (content script never responded at all - tab didn't
      // load, extension context lost, etc.) is worth retrying next run.
      // Anything else is a REAL answer from the page, even "found nothing" -
      // e.g. this person's location just isn't detectable by the (small,
      // Switzerland-biased) hint-word list. Marking those `visited` too is
      // what stops a lead with no findable location from being re-queued
      // and re-visited on every single future run forever - previously the
      // only way a lead ever left this list was a successful find, so a
      // profile the extractor could never read a location from stayed
      // permanently stuck in the count (reported directly: the same ~55
      // leads, run after run, even after several profile-extraction runs).
      const hardTimedOut = Boolean(debug?.timedOut);
      // Counted separately from a genuine "found nothing" result - reported
      // directly: the completion message only ever said "X of Y got a
      // company/location," which reads identically whether the rest simply
      // had no findable data or the visit silently failed outright (e.g.
      // the v0.29.20 profileUrl-matching bug). Surfaced per-lead, not per-
      // group, since that's the unit the rest of the status line counts in.
      if (hardTimedOut) hardTimeoutCount += group.leads.length;
      for (const lead of group.leads) {
        found.push({ key: lead.key, company, location, visited: !hardTimedOut });
      }
      // Widened from "both missing" to "either missing" alongside the same
      // change in profile-content-script.js - a partial miss (one field
      // found, the other not, e.g. a real lead that got a company but no
      // location) is just as worth diagnosing as a total miss, and used to
      // produce no sample at all.
      if ((!company || !location) && debug && debugSamples.length < MAX_DEBUG_SAMPLES) {
        debugSamples.push({ profileUrl: group.profileUrl, navCompleted, company, location, ...debug });
      }
      if (i < groups.length - 1) await sleep(randomProfileDelay());
    }
  } finally {
    chrome.power.releaseKeepAwake();
    await chrome.storage.local.remove("profileExtractionActive").catch(() => {});
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
  return { found, debugSamples, hardTimeoutCount };
}

export function runProfileExtraction(...args) {
  return withBatch("Reading LinkedIn profiles", () => runProfileExtractionImpl(...args));
}
