import { withBatch } from "./batch-jobs.js";
// Shared orchestration for resolving a Target Account company's name to its
// LinkedIn numeric company ID - the missing piece needed to eventually scope
// Post search by authorCompany (see PRD 6.15's "what this doesn't solve").
// Confirmed live against real search-results HTML the user shared (not
// guessed): navigating to https://www.linkedin.com/search/results/companies/
// ?keywords=<name> - a plain, hand-built URL, no autocomplete interaction
// needed - renders a company-only results list, whose single (or top) card
// links to a "X connections/alumni work here" People-search, whose href
// always encodes currentCompany=["<id>"], nested inside the SAME anchor as
// the card's own name (see company-resolve-content-script.js for the
// confirmed DOM evidence). Cross-confirmed twice: Swiss Re's card gave 3845
// this way, matching the heroEntityKey the LinkedIn autocomplete itself
// produced for the same company earlier.
//
// This originally searched the "All" tab (results/all/) instead, on the
// premise that it reliably renders a single-entity "hero card" above the
// normal category-grouped results. Reported directly with real evidence
// that premise doesn't hold: a live run against "Aargauische Kantonalbank"
// got back a completely unrelated company, because the "All" tab actually
// led with a Post that merely MENTIONED the target company's name in its
// body text - confirmed via a user-shared screenshot, not guessed. The
// Companies-only tab has no such ambiguity: it only ever returns companies.
//
// A confident hero name can still have no currentCompany link anywhere on
// this search page at all (confirmed live for "Acino") - for that case,
// runCompanyIdResolution falls back to the hero's own company page, which
// carries a currentCompany link of its own (see company-resolve-content-
// script.js's runCompanyPageFallback).
//
// A confident match can also fail for a well-known company that
// definitely IS on LinkedIn (confirmed live for "ARYZTA AG," a real, large,
// listed Swiss company) when the Target Accounts sheet's full legal name
// carries a trailing corporate-suffix word LinkedIn's own page name
// doesn't: "ARYZTA AG" gets no confident match on the Companies tab, but
// "ARYZTA" alone finds the real, verified company immediately - the exact
// same underlying problem the country-qualifier fix (v0.29.28) solved for
// "3M Switzerland" vs "3M", just not limited to country words. Generalized
// (v0.29.36) to strip every trailing word storage.js's own
// COMPANY_SUFFIX_NOISE_WORDS already treats as corporate-boilerplate noise
// (AG, Holding, Group, Switzerland, etc.) for the exact same reason that
// list exists elsewhere - reused rather than duplicated, so the two never
// drift apart.
//
// Some names fail for neither reason - the research spreadsheet's name is
// just genuinely different from LinkedIn's, in ways no stripping can fix
// (a translated name, a wrong word, a typo). Rather than guess a broader
// automated transformation, v0.29.37 lets each company optionally carry an
// officialName (a Zefix/Swiss-commercial-registry cross-check done outside
// the extension, imported from the workbook's own Zefix_Official_Name
// column - see storage.js's importTargetAccounts), used in place of the
// research name when present. Confirmed live: "APG|SGA"'s officialName
// ("APG SGA SA") drops the literal "|" LinkedIn's search chokes on; "Bank
// Syz"'s officialName ("Banque Syz SA") is the correct French spelling the
// English research name never had - though neither is actually confirmed
// working yet (see below).
//
// Originally tried BOTH names per company (officialName first, then the
// research name on failure) - reverted the same day (v0.29.38) after a
// 20-company run with the two-name loop came back with hardTimeoutCount:
// 9, versus the 0 seen consistently since the v0.29.35 listener-race fix,
// immediately followed by a clean 3-company run on the identical code.
// Reported directly: every run before that one used exactly one search per
// company - the two-name fallback was the one thing that changed request
// volume per company, so it's reverted to isolate that variable rather
// than guess at the real cause (LinkedIn-side throttling from some kind of
// in-session burst rate is the leading theory - NOT cumulative volume
// across the day, since a 9-hour idle gap right before those two runs
// ruled that out directly). See runCompanyIdResolution's own comment.

import { COMPANY_SUFFIX_NOISE_WORDS } from "./storage.js";
import { recordLinkedinTouch } from "./linkedin-touch-log.js";
import { checkTouchBudget } from "./touch-budget-guard.js";

const NAV_TIMEOUT_MS = 20000;
// Covers the full wait from BEFORE navigation starts (see the listener-race
// fix below) through the content script's own ~6s polling cap - not just
// post-load extraction time the way it used to, since the clock now starts
// earlier. Derived from NAV_TIMEOUT_MS plus a buffer, not picked arbitrarily.
const RESOLVE_TIMEOUT_MS = NAV_TIMEOUT_MS + 8000;
const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 9000;
const TYPICAL_LOAD_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

// Strips every trailing corporate-suffix/qualifier word (AG, Holding,
// Group, Switzerland, etc.) one at a time, repeatedly - a company can carry
// more than one ("X Holding AG"). Trailing only, never mid-name, same
// reasoning as the original country-qualifier strip this generalizes: the
// word is real corporate boilerplate the research spreadsheet appends, not
// part of the actual searchable brand name. Stripped only for the search
// query itself - the resolved ID still gets written back onto the original
// Target Account entry regardless of this transformation.
// Diacritics folded before the noise-word lookup (v0.29.40) - reported
// directly with real evidence: "Edwards Lifesciences Sàrl" kept its
// trailing legal suffix in the search term because "sàrl" (accented, from
// the Zefix official name) never matched the noise-word set's plain "sarl"
// entry. Same fold as company-resolve-content-script.js's namesMatch, same
// reasoning - Unicode NFD + stripping combining marks turns "à" into "a".
function foldDiacritics(text) {
  return (text || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Parentheses added to the lastWord cleanup (v0.29.41) - reported directly
// with real evidence: "Ford Motor Company (Switzerland)" never got its
// trailing qualifier stripped the way "ARYZTA AG" did, because "(switzerland)"
// - parens still attached - never matched the noise-word set's plain
// "switzerland" entry. storage.js's own normalizeCompanyForMatch already
// strips () for the same reason elsewhere in this codebase.
function stripTrailingCorporateNoise(name) {
  let current = (name || "").trim();
  for (let i = 0; i < 5; i++) {
    const words = current.split(/\s+/);
    if (words.length <= 1) break;
    const lastWord = foldDiacritics(words[words.length - 1]).toLowerCase().replace(/[.,()]/g, "");
    if (!COMPANY_SUFFIX_NOISE_WORDS.has(lastWord)) break;
    current = words.slice(0, -1).join(" ").trim();
  }
  return current || name;
}

// Reported directly with real evidence: searching the "All" tab
// (results/all/) is fundamentally unreliable for this purpose - it leads
// with whatever category (often Posts) happens to rank first, and any
// company merely MENTIONED or linked inside a post's text matches
// a[href*="linkedin.com/company/"] just as well as a genuine company
// match would (confirmed live: "Aargauische Kantonalbank" search returned
// a Digiterra post that happened to mention "Aargauische Kantonalbank
// (AKB)" in its body text, and Digiterra's own company link got picked up
// as the "hero"). Searching the Companies-only tab instead (results/
// companies/) confirmed live to show ONLY company results, with no
// Posts/People/Jobs noise competing for a[href*="linkedin.com/company/"]
// at all - and its top result card is confirmed to be the exact same
// component/DOM shape as the "hero card" this file's extraction was
// originally built against, so no extraction logic needed to change.
function buildCompanyResolveUrl(companyName) {
  return `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(companyName)}`;
}

function normalizeName(name) {
  return (name || "").trim().toLowerCase();
}

export function estimateResolveMinutes(count) {
  const avgPacingMs = (MIN_DELAY_MS + MAX_DELAY_MS) / 2;
  return Math.ceil((count * (avgPacingMs + TYPICAL_LOAD_MS)) / 60000);
}

export function resolveConfirmText(count) {
  const estMinutes = estimateResolveMinutes(count);
  return `Experimental: this will look up ${count} Target Account company${count === 1 ? "" : "ies"} by name on LinkedIn ` +
    `to resolve its numeric company ID (roughly ${estMinutes} minute${estMinutes === 1 ? "" : "s"} - paced to avoid ` +
    "rapid-fire requests). Each company is only ever looked up once - already-resolved ones are skipped on future runs. Continue?";
}

// Reported directly: a genuine, reproducible chunk of companies hard-time
// out with ZERO diagnostic info (navCompleted: true, nothing else) across
// three previous fix attempts (v0.29.31's try/catch, v0.29.33's warm-up
// nav, and again after the v0.29.34 Companies-tab switch) - a real mystery
// that guessing a fourth time risks repeating. One thing this function has
// never actually verified: that "complete" fired for the URL it asked for.
// chrome.tabs.onUpdated resolves on the FIRST complete event for the tab,
// with no check that the tab's own url matches the intended target - if
// LinkedIn ever routes through an intermediate page (a checkpoint, an
// auth re-check) before landing on the real one, this would report
// navCompleted: true while the content script never runs on the intended
// page at all, producing exactly this symptom. finalUrl (from the same
// listener callback's own `tab` argument, no extra API call needed) lets a
// future debugSamples entry confirm or rule this out before changing any
// behavior based on it.
function navigateAndWaitResolve(tabId, url) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navCompleted: false, finalUrl: null });
      }
    }, NAV_TIMEOUT_MS);
    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === "complete" && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navCompleted: true, finalUrl: tab?.url || null });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // active: true re-asserted on every navigation, not just at tab
    // creation (see runCompanyIdResolution's own comment on why the tab is
    // active at all now) - keeps the tab foregrounded even if the user
    // switches to a different tab mid-run, since Chrome's background-tab
    // throttling cares about a tab's current focus state, not just how it
    // started out.
    chrome.tabs.update(tabId, { url, active: true }).catch(() => {});
    recordLinkedinTouch().catch(() => {});
  });
}

// Reported directly with real evidence, after finalUrl (above) ruled out
// the "wrong page loaded" theory: 4 of 5 hard timeouts in one test run had
// finalUrl exactly matching the intended URL - the tab genuinely landed on
// the right page, "complete" fired correctly, and the content script's
// message still never arrived. The real bug: this used to be called only
// AFTER navigateAndWaitResolve resolved, i.e. only after the tab's
// "complete" event (the full load, including subresources). But a
// document_idle content script typically runs around DOMContentLoaded,
// which on a JS-heavy SPA like LinkedIn usually fires BEFORE "complete" -
// so the content script can find its result and call sendMessage before
// this function's own listener is even registered, and that message is
// simply lost, with no error anywhere (matches the symptom exactly: no
// caughtError, no content-script-side timeout, just silence). Callers now
// invoke this BEFORE starting navigation (see runCompanyIdResolution) so
// the listener is live for the entire navigation, not just after it.
function waitForResolveResult(expectedName) {
  const expected = normalizeName(expectedName);
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ resolved: false, linkedinCompanyId: null, companyPageUrl: null, debug: { timedOut: true } });
      }
    }, RESOLVE_TIMEOUT_MS);
    function listener(message) {
      if (message?.type === "COMPANY_RESOLVE_RESULT" && normalizeName(message.companyName) === expected && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve({
          resolved: Boolean(message.resolved),
          linkedinCompanyId: message.linkedinCompanyId || null,
          companyPageUrl: message.companyPageUrl || null,
          debug: message.debug || null,
        });
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

// Bumped from 3: actively hunting the still-open hard-timeout mystery right
// now, and a 10-company test run has had up to 5 timeouts in one go - 3
// samples wasn't enough to see the new finalUrl field across more than a
// couple of them at once.
const MAX_DEBUG_SAMPLES = 8;

// One full attempt at resolving a single search term: the search-page
// navigation, plus the company-page fallback (the "Acino" gap) if that
// term gets a confident name with no ID anywhere. Pulled out of the main
// loop (v0.29.37) so it can be tried against more than one candidate name
// per company - see the officialName comment below.
async function resolveOneName(tab, searchName) {
  // companyResolveDirectLink explicitly cleared, not just omitted -
  // chrome.storage.local.set merges rather than replaces, so a prior
  // company's direct-link attempt (see resolveViaDirectLink) would
  // otherwise leave it set to true and silently misroute this one through
  // the content script's direct-link branch instead of the search-page one.
  await chrome.storage.local.set({
    companyResolveActive: true,
    companyResolveTarget: searchName,
    companyResolveDirectLink: false,
  });
  // Registered BEFORE navigation starts, not after - see
  // waitForResolveResult's own comment for why (a real listener race,
  // confirmed via finalUrl evidence, not a guess).
  const resultPromise = waitForResolveResult(searchName);
  const { navCompleted, finalUrl } = await navigateAndWaitResolve(tab.id, buildCompanyResolveUrl(searchName));
  let { resolved, linkedinCompanyId, debug, companyPageUrl } = await resultPromise;
  let usedFallback = false;
  let fallbackFinalUrl = null;
  // A confident name with no id anywhere on the search page (the
  // "Acino" gap) - retry on the company's own page rather than giving
  // up, since companyPageUrl is only ever set once the name already
  // matched confidently (see company-resolve-content-script.js).
  if (!resolved && companyPageUrl) {
    usedFallback = true;
    await sleep(randomDelay());
    const fallbackResultPromise = waitForResolveResult(searchName);
    const fallbackNav = await navigateAndWaitResolve(tab.id, companyPageUrl);
    fallbackFinalUrl = fallbackNav.finalUrl;
    const fallbackResult = await fallbackResultPromise;
    resolved = fallbackResult.resolved;
    linkedinCompanyId = fallbackResult.linkedinCompanyId;
    debug = fallbackResult.debug || debug;
  }
  return {
    searchName,
    resolved,
    linkedinCompanyId,
    debug,
    navCompleted,
    finalUrl,
    usedFallback,
    fallbackFinalUrl,
    // Only ever set once the name matched confidently (see
    // company-resolve-content-script.js), so it is safe to store as the company's own page.
    companyPageUrl,
  };
}

// v0.29.42, see PRD 6.16: the new primary path for a company that carries a
// linkedinLink - an external cross-check (done outside the extension, the
// same one that produced officialName) validated 499 of 500 companies'
// actual LinkedIn company-page URL, including catching cases no on-site
// search could ever get right (a hospital that renamed itself, a page
// LinkedIn itself now redirects as deprecated). Reported directly: since
// that URL is already known-correct, navigating straight to it and reading
// the id off the page sidesteps every failure mode the search-based path
// (below) exists to work around - verbose legal names, translated names,
// LinkedIn's own search ranking returning a related-but-wrong company - none
// of which are name-matching problems once the destination is already
// known. company-resolve-content-script.js's runDirectLinkResolve still does
// its own sanity check (the page's own title against every name known for
// this company) before trusting the id, since this URL has never been
// confirmed against a hero card the way the search-based path's has.
async function resolveViaDirectLink(tab, company) {
  const expectedName = company.company;
  const candidateNames = [company.company, company.officialName, company.alternativeName].filter(Boolean);
  await chrome.storage.local.set({
    companyResolveActive: true,
    companyResolveDirectLink: true,
    companyResolveTarget: expectedName,
    companyResolveTargetCandidates: candidateNames,
  });
  const resultPromise = waitForResolveResult(expectedName);
  const { navCompleted, finalUrl } = await navigateAndWaitResolve(tab.id, company.linkedinLink);
  const { resolved, linkedinCompanyId, debug } = await resultPromise;
  return {
    searchName: `[direct link] ${company.linkedinLink}`,
    resolved,
    linkedinCompanyId,
    debug,
    navCompleted,
    finalUrl,
    usedFallback: false,
    fallbackFinalUrl: null,
  };
}

// Visits each company one at a time, paced like the other extraction
// modules, and resolves with:
// - results: {key, linkedinCompanyId} for every company that resolved
//   confidently (a hero-name mismatch or no currentCompany link found at
//   all is never guessed at - simply left unresolved for a future run).
// - debugSamples, hardTimeoutCount: same diagnostic shape as the other
//   extraction modules.
// 29th round of direct feedback (2026-09-19): "it seems that this stopped
// the Resolve LinkedIn Company IDs that was already running... it seems to
// start again at 502, even though it should have continued from were it
// last stopped." Root cause: this function held every result in memory for
// the WHOLE run and only ever persisted them once, at the very end (the
// caller's applyResolvedCompanyIds/markLinkedinResolveAttempted calls,
// after this promise resolves). A graceful Stop click still works fine
// (shouldAbort just ends the loop early, this function still returns
// normally, the caller's end-of-run persistence still runs) - but reloading
// the extension (exactly what an unrelated code change asked the user to
// do) tears down the whole JS execution context instantly, with no chance
// for anything "at the end" to ever run. Every company this run had already
// resolved, gone. onCompanyDone (new) is called after EVERY company's own
// outcome is known, so the caller can persist immediately, one company at a
// time - an abrupt interruption now loses at most whichever single company
// was still in flight, never the whole run's progress.
async function runCompanyIdResolutionImpl(companies, { onProgress, shouldAbort, onCompanyDone } = {}) {
  const results = [];
  const debugSamples = [];
  // v0.29.45: every company actually reached this run, success or failure -
  // distinct from `companies` (the full requested batch) once shouldAbort
  // can end the run early. markLinkedinResolveAttempted needs exactly this
  // list, not the full batch - a company never reached this run was never
  // attempted, and marking it as if it were would wrongly deprioritize it
  // behind companies that genuinely were tried, the next time the queue is
  // built (getTargetAccountsMissingLinkedinId).
  const attemptedKeys = [];
  let hardTimeoutCount = 0;
  let stoppedByTouchBudget = false;
  // Reported directly: a completion message only ever accounted for
  // "resolved" and "hard-timed-out," silently omitting a real THIRD outcome
  // - the content script responded fine and quickly, but couldn't
  // confidently confirm a match (no hero card, or the hero name didn't
  // match well enough) - correctly declining to guess, but invisible in the
  // summary, leaving a real gap between the two reported numbers and the
  // total with no explanation.
  let notConfidentCount = 0;
  let tab;
  try {
    // Reported directly with real evidence (v0.29.43): the direct-link path
    // (resolveViaDirectLink) hard-timed out on 15 of 25 companies in one
    // run - manually navigating to one of the exact same failing URLs, in
    // an active tab, loaded the real page fully in ~3s, ruling out
    // LinkedIn-side slowness or blocking. The one thing that differs: this
    // tab has always been created backgrounded (active: false) and stayed
    // that way for the whole run. The old search-based path almost
    // exclusively hit lightweight search-results pages and never showed
    // this problem across 60+ companies; the new direct-link path
    // exclusively hits full company pages - heavier pages Chrome's
    // background-tab throttling can stall badly enough that the content
    // script never gets far enough to even send a message within the 28s
    // window, backed up by the debug data: not just a slow "complete"
    // event, but zero message ever received. Made active here (and kept
    // active on every navigation, see navigateAndWaitResolve) to test
    // whether that's the actual cause - the visible tradeoff is a tab
    // visibly jumping between company pages during a run instead of
    // working invisibly in the background.
    // Same reasoning as scanAllTopics (background.js) and runProfileExtraction
    // (profile-extraction.js): a large batch can run long enough that system
    // sleep mid-run freezes it for however long the machine was asleep.
    // Released in the finally below on every exit path.
    chrome.power.requestKeepAwake("system");
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
    // Reported directly, with real evidence: the exact same few companies
    // hard-timed-out with zero diagnostic info on every run (not a name-
    // specific issue - they simply never resolve, so they always land back
    // at the front of the next run's queue). That points at a cold-start
    // problem with the freshly-created tab rather than anything about those
    // companies: the very first navigation right after chrome.tabs.create
    // may not reliably get the content script running before the
    // orchestration's own timeout gives up, while every later navigation in
    // the same run works fine once the tab is "warmed up." A throwaway
    // warm-up navigation here means the first REAL company lookup is never
    // also the tab's first navigation ever.
    await navigateAndWaitResolve(tab.id, "https://www.linkedin.com/feed/");
    for (let i = 0; i < companies.length; i++) {
      // v0.29.45: checked before starting a new company, not mid-attempt -
      // one company's own resolution (a few seconds) is short enough that
      // waiting for it to finish is a fine granularity, and it keeps this
      // function's return shape (results/debugSamples/counts) exactly as-is
      // for however far it got, no special-casing needed for a stop versus
      // reaching the end of the list normally.
      if (shouldAbort && shouldAbort()) break;
      // v0.30.0: the shared 75/99 LinkedIn touch budget (touch-budget-guard.js)
      // now stops this run too, not just background.js's scan - checked at the
      // same per-company checkpoint as the user's own Stop button above.
      if (await checkTouchBudget()) { stoppedByTouchBudget = true; break; }
      const company = companies[i];
      if (onProgress) onProgress(i + 1, companies.length);
      attemptedKeys.push(company.key);

      let attempt = null;
      const triedNames = [];
      // v0.29.42, see PRD 6.16 and resolveViaDirectLink's own comment: a
      // company with an externally-validated linkedinLink skips name-based
      // search entirely - reported directly, this eliminates the whole
      // class of failures the logic below exists to work around, for the
      // ~499 of 500 companies that have one.
      if (company.linkedinLink) {
        attempt = await resolveViaDirectLink(tab, company);
        triedNames.push(`[direct link] ${company.linkedinLink}`);
      } else {
        // v0.29.37, see PRD 6.16: a Zefix (Swiss commercial registry)
        // cross-check, done outside the extension, gives some companies an
        // officialName that's a genuinely better LinkedIn search term than
        // the research spreadsheet's own name - confirmed live for
        // "APG|SGA" (whose officialName "APG SGA SA" drops the literal "|"
        // LinkedIn's search chokes on) and "Bank Syz" (officialName
        // "Banque Syz SA" - the correct French spelling the English-
        // language research name never had). Used only as a fallback for
        // the handful of companies with no linkedinLink at all (1 of 500,
        // per the external cross-check, plus any future re-import without
        // that column).
        //
        // Originally tried the officialName first, then fell back to the
        // research name on failure - reverted (v0.29.38) after a 20-company
        // run (roughly doubling request volume per company) came back with
        // hardTimeoutCount: 9, a real jump from the 0 seen consistently
        // since the v0.29.35 listener-race fix, immediately followed by a
        // clean 0-timeout 3-company run on the same code. Reported directly:
        // every run before today used exactly one search per company at the
        // same ~4-9s pacing this file has always used - the two-name
        // fallback was the one thing that changed request volume per
        // company, so removing it makes a run directly comparable to every
        // prior one again, isolating whether that volume increase (not a
        // code regression - the pacing between names was already the same
        // randomDelay() used between companies, confirmed on inspection) is
        // what's triggering LinkedIn-side throttling. Only the research
        // name is used as a fallback now, and only when there's no
        // officialName at all - not as a second attempt after the official
        // name fails.
        const candidateNames = [stripTrailingCorporateNoise(company.officialName || company.company)];
        for (let c = 0; c < candidateNames.length; c++) {
          if (c > 0) await sleep(randomDelay());
          attempt = await resolveOneName(tab, candidateNames[c]);
          triedNames.push(candidateNames[c]);
          if (attempt.resolved) break;
        }
      }

      const { resolved, linkedinCompanyId, debug, navCompleted, finalUrl, usedFallback, fallbackFinalUrl, companyPageUrl } = attempt;
      const hardTimedOut = Boolean(debug?.timedOut);
      if (hardTimedOut) hardTimeoutCount++;
      else if (!resolved) notConfidentCount++;
      // companyPageUrl is the company's REAL LinkedIn page url, read off the page this run just
      // landed on. It used to be captured and then dropped here, which left accounts that resolved
      // an id but had no linkedinLink in the imported workbook with no link at all - and, because
      // getCompaniesNeedingSize() requires linkedinLink, permanently ineligible for Fetch Company
      // Size too (2026-09-22). Passed through so applyResolvedCompanyIds can fill a MISSING link.
      if (resolved && linkedinCompanyId) results.push({ key: company.key, linkedinCompanyId, companyPageUrl: companyPageUrl || null });
      if (onCompanyDone) await onCompanyDone(company.key, resolved && linkedinCompanyId ? linkedinCompanyId : null, companyPageUrl || null);
      if (!resolved && debug && debugSamples.length < MAX_DEBUG_SAMPLES) {
        // finalUrl/fallbackFinalUrl - see navigateAndWaitResolve's own
        // comment: lets a hard timeout distinguish "the tab genuinely
        // landed on the intended page and the content script still never
        // responded" from "it landed somewhere else entirely" before
        // changing any behavior based on it. triedNames records every
        // search term actually attempted (research name, officialName, or
        // both) so a future diagnosis doesn't have to guess which one this
        // sample reflects.
        debugSamples.push({
          company: company.company,
          triedNames,
          navCompleted,
          finalUrl,
          usedFallback,
          ...(usedFallback ? { fallbackFinalUrl } : {}),
          ...debug,
        });
      }
      if (i < companies.length - 1) await sleep(randomDelay());
    }
  } finally {
    chrome.power.releaseKeepAwake();
    await chrome.storage.local
      .remove(["companyResolveActive", "companyResolveTarget", "companyResolveDirectLink", "companyResolveTargetCandidates"])
      .catch(() => {});
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
  return { results, debugSamples, hardTimeoutCount, notConfidentCount, attemptedKeys, stoppedByTouchBudget };
}

export function runCompanyIdResolution(...args) {
  return withBatch("Looking up LinkedIn company IDs", () => runCompanyIdResolutionImpl(...args));
}
