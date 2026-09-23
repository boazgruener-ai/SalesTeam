// Runs on a LinkedIn Companies-only search results page
// (linkedin.com/search/results/companies/*), and also on a company's own
// page (linkedin.com/company/*) as the location fallback - PRD 6.20 Phase 5,
// experimental. Only ever active during an explicit, user-triggered
// discovery run (company-discovery-extraction.js sets companyDiscoveryActive
// or companyDiscoveryLocationCheckActive before navigating here) - does
// nothing during normal browsing, same gating pattern as every other
// extraction content script (e.g. company-resolve-content-script.js, which
// this file's search-results scraping is directly modeled on).
//
// Deliberately "dumb" - reports raw scraped data only (name, industry text,
// location text, LinkedIn numeric id, slug), never decides whether a card
// is a confident match, in-target-country, or excluded. Content scripts in
// this codebase are plain scripts, not ES modules (no import/export
// available), so the "smart" logic - ISO country-code matching, competitor/
// recruiter exclusion, the permanent location cache - lives in
// company-discovery-extraction.js instead, where those already-written
// modules can be imported directly.
//
// Confirmed live (2026-09-15), not guessed: a Company Search results card
// is a single anchor (a[href*="linkedin.com/company/<slug>/"]) inside
// <section aria-label="Primary content">, whose first three <p> descendants
// are, in fixed order, the company name, its industry text, and its
// location text (confirmed across 5 real cards: Microsoft, Google, Oracle,
// Meta, Salesforce - CSS class names are auto-generated/obfuscated and not
// used for selection at all, only this positional structure is). The same
// anchor's innerHTML carries a currentCompany=%5B%22(\d+)%22 link (a "X
// people from your company were hired here" sub-link) for the numeric id -
// same regex precedent as company-resolve-content-script.js, scoped to this
// card's own anchor subtree for the same reason (a page-wide first-match
// lookup risks picking up an unrelated card's id).
//
// Pagination is page-number-based (&page=N in the URL, confirmed live by
// clicking "2" and reading the resulting URL), not an opaque cursor or
// infinite scroll - company-discovery-extraction.js navigates directly to
// each page URL rather than needing this script to drive scrolling/clicking.
//
// Wrapped in an IIFE (added after a real bug, confirmed live 2026-09-15):
// Chrome runs every content script belonging to one extension in a single
// shared per-page execution scope, not one scope per file - since this
// script and company-resolve-content-script.js are both registered on the
// same two URL patterns (search/results/companies/* and company/*), their
// top-level `const`/function declarations landed in that same shared scope
// and collided (both had their own POLL_INTERVAL_MS, sleep, normalizeText,
// findCurrentCompanyIdWithin, run, ...), throwing "Identifier ... has
// already been declared" and breaking whichever script ran second. An IIFE
// keeps every name in here private to this file regardless of what else
// gets injected alongside it.
(function () {

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function parseCompanySlug(href) {
  const match = (href || "").match(/linkedin\.com\/company\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function findCurrentCompanyIdWithin(container) {
  if (!container) return null;
  const match = container.innerHTML.match(/currentCompany=%5B%22(\d+)%22/);
  return match ? match[1] : null;
}

// The org-top-card's "X employees" link - same technique as company-resolve-
// content-script.js's findEmployeesLinkCompanyId, added 2026-09-15 after a
// real run showed 15 of 40 scraped cards (37.5%) had no id at all: a search-
// results card only carries a currentCompany= link when there's a "X people
// from your company work here" line to attach it to (network overlap), so a
// company with none is silently missing its id right on the card - the same
// "Acino gap" that module already solved. Confirmed there (not re-guessed
// here) that a company's own page reliably carries this link regardless of
// network overlap, via a different sub-link (the page's own "X employees"
// link), so runLocationFallback below - which already visits this page for
// the location fallback tier - recovers the id from the same visit too.
function findEmployeesLinkCompanyId() {
  const link = document.querySelector('a[href*="currentCompany=%5B%22"]');
  if (!link) return null;
  const match = link.getAttribute("href").match(/currentCompany=%5B%22(\d+)%22/);
  return match ? match[1] : null;
}

// Scoped to <section aria-label="Primary content"> - same reasoning as
// company-resolve-content-script.js's findHeroLink: confirmed to exist on
// this page type, and defense-in-depth against anything in a sidebar/ad
// rail matching the same href pattern. Deduped by href (stripped of any
// query string) since a card can contain more than one anchor sharing the
// same destination - one representative anchor per unique company is all
// that's needed, the first one encountered in DOM order.
function findCompanyCards() {
  const scope = document.querySelector('section[aria-label="Primary content"]') || document;
  const anchors = Array.from(scope.querySelectorAll('a[href*="linkedin.com/company/"]')).filter((a) =>
    /\/company\/[^/?#]+\/?$/.test(a.getAttribute("href") || "")
  );
  const seen = new Set();
  const cards = [];
  for (const a of anchors) {
    const href = (a.getAttribute("href") || "").split("?")[0];
    if (!href || seen.has(href)) continue;
    seen.add(href);
    cards.push(a);
  }
  return cards;
}

function extractCard(anchor) {
  const paragraphs = Array.from(anchor.querySelectorAll("p")).slice(0, 3).map((p) => normalizeText(p.textContent));
  return {
    slug: parseCompanySlug(anchor.getAttribute("href")),
    linkedinCompanyId: findCurrentCompanyIdWithin(anchor),
    name: paragraphs[0] || null,
    industryText: paragraphs[1] || null,
    locationText: paragraphs[2] || null,
  };
}

const POLL_INTERVAL_MS = 500;
// 20 attempts (~10s), not the 12 (~6s) other extraction content scripts in
// this codebase use. Bumped after a real bug found live 2026-09-15: a page
// 2 that demonstrably had real cards (confirmed by loading it directly and
// finding 30 anchors instantly) still came back with resultCount: 0 from a
// real orchestrated run - the poll window gave up before LinkedIn's async
// data fetch for that page finished rendering. Since findCompanyCards()
// already returns as soon as cards appear (this only ever affects the slow
// case, never adds latency to a fast page), there's no real cost to a wider
// margin here, and PAGE_RESULT_TIMEOUT_MS in company-discovery-extraction.js
// (28s) has plenty of headroom above this.
const POLL_MAX_ATTEMPTS = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSearchResultsScrape() {
  let cards = [];
  let caughtError = null;
  try {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      cards = findCompanyCards();
      if (cards.length > 0) break;
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    caughtError = err?.message || String(err);
  }

  const results = (caughtError ? [] : cards).map(extractCard).filter((c) => c.slug && c.name);
  console.log(`[SalesTeam] company discovery page scrape: ${results.length} card(s) found`, caughtError ? `error=${caughtError}` : "");

  chrome.runtime.sendMessage({
    type: "COMPANY_DISCOVERY_PAGE_RESULT",
    url: location.href.split("?")[0],
    results,
    caughtError,
  });
}

// Location fallback - confirmed live (2026-09-15) against real company
// pages (Adecco, Michael Page), not guessed: a company's own LinkedIn page
// embeds its full structured data (a Voyager/GraphQL response) inline via
// <code id="bpr-guid-...">, one of several such blocks on the page. Rather
// than assume which block or trust the FIRST one containing a "headquarter"
// field (confirmed live to be unreliable - the first such block on a real
// page was a "similar/affiliated pages" entry for a completely unrelated
// company, not the page's own subject), this reads the query response's own
// `data.data.<queryName>["*elements"][0]` reference (whatever the query
// name happens to be - confirmed to vary by page, e.g.
// organizationDashCompaniesByUniversalName) to find the PRIMARY entity's
// urn, then looks that exact urn up in `included` - an identity-based
// match, not a guess at which entity is "the" company.
function extractHeadquarterCountry() {
  const blocks = Array.from(document.querySelectorAll('code[id^="bpr-guid-"]'));
  for (const block of blocks) {
    if (!block.textContent.includes('"headquarter"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(block.textContent);
    } catch {
      continue;
    }
    const dataRoot = parsed?.data?.data;
    if (!dataRoot) continue;
    let primaryUrn = null;
    for (const key of Object.keys(dataRoot)) {
      const val = dataRoot[key];
      if (val && Array.isArray(val["*elements"]) && val["*elements"][0]) {
        primaryUrn = val["*elements"][0];
        break;
      }
    }
    if (!primaryUrn) continue;
    const primary = (parsed.included || []).find((e) => e && e.entityUrn === primaryUrn);
    if (primary?.headquarter?.address) {
      return {
        name: primary.name || null,
        country: primary.headquarter.address.country || null,
        city: primary.headquarter.address.city || null,
      };
    }
  }
  return null;
}

async function runLocationFallback() {
  let found = null;
  // companyId recovered from the SAME page visit as the location, added
  // 2026-09-15 - see findEmployeesLinkCompanyId's own comment for why.
  // Polls for both independently and stops as soon as both are in hand
  // (or the window runs out) rather than only ever waiting on headquarter
  // data the way this loop originally did.
  let companyId = null;
  let caughtError = null;
  try {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      if (!found) found = extractHeadquarterCountry();
      if (!companyId) companyId = findEmployeesLinkCompanyId();
      if (found && companyId) break;
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    caughtError = err?.message || String(err);
  }

  console.log(`[SalesTeam] company discovery location fallback: ${JSON.stringify(found)} id=${companyId}`, caughtError ? `error=${caughtError}` : "");

  chrome.runtime.sendMessage({
    type: "COMPANY_DISCOVERY_LOCATION_RESULT",
    url: location.href.split("?")[0],
    name: found?.name || null,
    country: found?.country || null,
    city: found?.city || null,
    linkedinCompanyId: companyId,
    caughtError,
  });
}

async function run() {
  const { companyDiscoveryActive, companyDiscoveryLocationCheckActive } = await chrome.storage.local.get([
    "companyDiscoveryActive",
    "companyDiscoveryLocationCheckActive",
  ]);
  if (companyDiscoveryLocationCheckActive && location.pathname.startsWith("/company/")) {
    await runLocationFallback();
    return;
  }
  if (companyDiscoveryActive && location.pathname.startsWith("/search/results/companies/")) {
    await runSearchResultsScrape();
  }
}

run().catch((err) => {
  // Belt and suspenders, same as every other extraction content script -
  // even a failure in run() itself still reports something rather than
  // leaving the orchestrator to time out with zero information.
  chrome.runtime.sendMessage({
    type: location.pathname.startsWith("/company/") ? "COMPANY_DISCOVERY_LOCATION_RESULT" : "COMPANY_DISCOVERY_PAGE_RESULT",
    url: location.href.split("?")[0],
    results: [],
    caughtError: err?.message || String(err),
  }).catch(() => {});
});

})();
