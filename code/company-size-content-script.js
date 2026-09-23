// Runs on a company's own LinkedIn page (linkedin.com/company/*), reading
// its displayed employee-count band. PRD 6.20 Phase 8's own deterministic
// pre-score has always had a real gap for Discovered companies: LinkedIn's
// company-SEARCH result cards never show size at all (confirmed directly,
// live, 2026-09-17 - company-discovery-content-script.js's own extractCard
// only ever reads name/industry/location off a search card, and the user
// independently confirmed the same by eye: "I do not see the size on the
// company cards, resulting from a search"). The user asked directly for
// size to be captured for every discovered company since it's "a very
// important piece of information for an account" - reported directly that
// a company's OWN page does show it, which a live check confirmed.
//
// Confirmed against 3 real company pages of very different sizes (not
// guessed): adesso Schweiz AG showed "501-1K employees", Nestle showed
// "10K+ employees", EBP Schweiz showed "201-500 employees" - all inside
// the org top-card's own info-list (industry - location - followers -
// size), a stable, semantic LinkedIn class name
// (org-top-card-summary-info-list), not a hashed one.
//
// The size segment is NOT reliably a clickable link - a real, live-found
// gap in the assumption this was first built on: adesso/Nestle's employee
// count sat inside a currentCompany=-carrying anchor (the same one
// company-resolve-content-script.js's findEmployeesLinkCompanyId already
// reads for a different purpose), but EBP Schweiz's identical-looking text
// was plain, unlinked text, and that same page also happened to have an
// UNRELATED currentCompany= link elsewhere ("2 people from your company
// were hired here") that a naive "first currentCompany= link on the page"
// selector would have wrongly matched instead. Reading the whole info-list
// element's own text and pattern-matching for "<band> employees" is what
// actually works across every page type tried - not assuming the value is
// always, or only, inside a link.
//
// Only ever active during an explicit, user-triggered "Fetch Company Size"
// run (company-size-extraction.js sets companySizeFetchActive/
// companySizeFetchTarget before navigating here) - does nothing during
// normal browsing, same gating pattern as every other extraction content
// script in this project.
//
// Wrapped in an IIFE (2026-09-19, real bug confirmed live via a console
// error - "Identifier 'POLL_INTERVAL_MS' has already been declared" on a
// plain https://www.linkedin.com/company/... page visit): Chrome runs
// every content script belonging to one extension in a single shared
// per-page execution scope, not one scope per file. This script and
// company-resolve-content-script.js are both registered on
// https://www.linkedin.com/company/* (manifest.json), and both had their
// own top-level POLL_INTERVAL_MS/POLL_MAX_ATTEMPTS/sleep/normalizeText/run
// - landing in that same shared scope and colliding, which crashed
// whichever of the two loaded second (silently killing the "Fetch Company
// Size" run whenever that happened, since its own run() never got to send
// back a result). Same fix already applied to company-discovery-content-
// script.js for the identical collision found 2026-09-15 - see its own
// header comment - just not carried over to this file, added afterward.
(function () {

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

// LinkedIn's own fixed company-size facet bands, mapped to the LOWER bound
// of each band - not a guessed midpoint. Chosen deliberately: every band's
// lower bound falls exactly on one of storage.js's own SIZE_PRIORITY_BUCKETS
// min boundaries (S/M/L/XL/XXL), so the existing resolveSizeBucket()/
// computeCompanyDeterministicPreScore logic (Phase 8) buckets a value
// written here correctly with zero special-casing - it's just another
// globalEmployees number, indistinguishable from an imported one once
// stored.
const SIZE_BAND_TO_EMPLOYEE_COUNT = {
  "1-10": 1,
  "11-50": 11,
  "51-200": 51,
  "201-500": 201,
  "501-1k": 501,
  "1k-5k": 1001,
  "5k-10k": 5001,
  "10k+": 10001,
};

function bandToEmployeeCount(bandText) {
  if (!bandText) return null;
  const key = bandText.toLowerCase().replace(/,/g, "");
  if (SIZE_BAND_TO_EMPLOYEE_COUNT[key] != null) return SIZE_BAND_TO_EMPLOYEE_COUNT[key];
  // Fallback for a plain, un-banded number - not confirmed live on any real
  // page so far (every company tried showed a band), cheap insurance
  // against a page variant this project hasn't seen yet rather than
  // dropping a genuine value silently.
  const plain = parseInt(bandText.replace(/,/g, ""), 10);
  return Number.isFinite(plain) && plain > 0 ? plain : null;
}

// The org top-card's own info-list (industry - location - followers -
// size) - confirmed live via direct DOM inspection, 2026-09-17.
function findCompanySizeText() {
  const infoList = document.querySelector(".org-top-card-summary-info-list");
  if (!infoList) return null;
  const text = normalizeText(infoList.textContent);
  const match = text.match(/([\d,]+(?:[KM])?(?:-[\d,]+(?:[KM])?)?\+?)\s*employees/i);
  return match ? match[1] : null;
}

const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 20; // ~10s, same as company-discovery-content-script.js's own widened window

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const { companySizeFetchActive, companySizeFetchTarget } = await chrome.storage.local.get([
    "companySizeFetchActive",
    "companySizeFetchTarget",
  ]);
  if (!companySizeFetchActive || !companySizeFetchTarget) return;

  let sizeBandText = null;
  let caughtError = null;
  try {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      sizeBandText = findCompanySizeText();
      if (sizeBandText) break;
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    caughtError = err?.message || String(err);
  }

  const employeeCount = bandToEmployeeCount(sizeBandText);
  const resolved = Boolean(!caughtError && employeeCount != null);
  console.log(`[SalesTeam] company size fetch for "${companySizeFetchTarget}": band="${sizeBandText}" count=${employeeCount} resolved=${resolved}`, caughtError ? `error=${caughtError}` : "");

  chrome.runtime.sendMessage({
    type: "COMPANY_SIZE_RESULT",
    companyKey: companySizeFetchTarget,
    resolved,
    employeeCount: resolved ? employeeCount : null,
    sizeBandText,
    debug: resolved ? null : { title: document.title, url: location.href.split("?")[0], sizeBandText, caughtError },
  });
}

run().catch((err) => {
  // Belt and suspenders, same as every other extraction content script here -
  // a failure in run() itself still reports something rather than leaving
  // the orchestration side to time out with zero information.
  chrome.runtime.sendMessage({
    type: "COMPANY_SIZE_RESULT",
    companyKey: null,
    resolved: false,
    employeeCount: null,
    debug: { caughtError: err?.message || String(err), url: location.href.split("?")[0] },
  }).catch(() => {});
});

})();
