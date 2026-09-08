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

const NAV_TIMEOUT_MS = 20000;
const RESOLVE_TIMEOUT_MS = 15000;
const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 9000;
const TYPICAL_LOAD_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

// Confirmed live with real examples: the Target Accounts sheet marks which
// subsidiary was researched by appending a country qualifier to the company
// name ("3M Switzerland," "AbbVie Switzerland"), but LinkedIn's own company
// page is just the global brand name ("3M") - searching the qualified name
// breaks the "hero card" match that searching the unqualified name gets
// reliably (verified: "3M Switzerland" got no confident hero card and a
// literal "No results found" on LinkedIn's own Companies search tab; "3M"
// alone got a clean one). Stripped only for the search query itself - the
// resolved ID still gets written back onto the original Target Account
// entry regardless of this transformation.
const TRAILING_COUNTRY_QUALIFIERS = [" switzerland", " schweiz", " suisse", " svizzera"];

function stripCountryQualifier(name) {
  const lower = (name || "").toLowerCase();
  for (const suffix of TRAILING_COUNTRY_QUALIFIERS) {
    if (lower.endsWith(suffix)) return name.slice(0, name.length - suffix.length).trim();
  }
  return name;
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

function navigateAndWaitResolve(tabId, url) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navCompleted: false });
      }
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
    chrome.tabs.update(tabId, { url }).catch(() => {});
  });
}

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

const MAX_DEBUG_SAMPLES = 3;

// Visits each company one at a time, paced like the other extraction
// modules, and resolves with:
// - results: {key, linkedinCompanyId} for every company that resolved
//   confidently (a hero-name mismatch or no currentCompany link found at
//   all is never guessed at - simply left unresolved for a future run).
// - debugSamples, hardTimeoutCount: same diagnostic shape as the other
//   extraction modules.
export async function runCompanyIdResolution(companies, { onProgress } = {}) {
  const results = [];
  const debugSamples = [];
  let hardTimeoutCount = 0;
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
    tab = await chrome.tabs.create({ url: "about:blank", active: false });
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
      const company = companies[i];
      if (onProgress) onProgress(i + 1, companies.length);
      // The content script matches the hero card's name against this same
      // stripped form - namesMatch's substring check would likely tolerate
      // either form, but there's no reason to search for one name and
      // compare against a different one when both can be identical.
      const searchName = stripCountryQualifier(company.company);
      await chrome.storage.local.set({
        companyResolveActive: true,
        companyResolveTarget: searchName,
      });
      const { navCompleted } = await navigateAndWaitResolve(tab.id, buildCompanyResolveUrl(searchName));
      let { resolved, linkedinCompanyId, debug, companyPageUrl } = await waitForResolveResult(searchName);
      let usedFallback = false;
      // A confident name with no id anywhere on the search page (the
      // "Acino" gap) - retry on the company's own page rather than giving
      // up, since companyPageUrl is only ever set once the name already
      // matched confidently (see company-resolve-content-script.js).
      if (!resolved && companyPageUrl) {
        usedFallback = true;
        await sleep(randomDelay());
        await navigateAndWaitResolve(tab.id, companyPageUrl);
        const fallbackResult = await waitForResolveResult(searchName);
        resolved = fallbackResult.resolved;
        linkedinCompanyId = fallbackResult.linkedinCompanyId;
        debug = fallbackResult.debug || debug;
      }
      const hardTimedOut = Boolean(debug?.timedOut);
      if (hardTimedOut) hardTimeoutCount++;
      else if (!resolved) notConfidentCount++;
      if (resolved && linkedinCompanyId) results.push({ key: company.key, linkedinCompanyId });
      if (!resolved && debug && debugSamples.length < MAX_DEBUG_SAMPLES) {
        debugSamples.push({ company: company.company, navCompleted, usedFallback, ...debug });
      }
      if (i < companies.length - 1) await sleep(randomDelay());
    }
  } finally {
    await chrome.storage.local.remove(["companyResolveActive", "companyResolveTarget"]).catch(() => {});
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
  return { results, debugSamples, hardTimeoutCount, notConfidentCount };
}
