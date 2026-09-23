// Runs on a company's own People tab, keyword-filtered
// (linkedin.com/company/<slug>/people/?keywords=<expression>) - PRD 6.20
// Phase 6, experimental. Only ever active during an explicit, user-triggered
// contact-discovery run (contact-discovery-extraction.js sets
// contactDiscoveryActive before navigating here) - does nothing during
// normal browsing, same gating pattern as company-discovery-content-script.js.
//
// Confirmed live 2026-09-15, not guessed: global People Search has no
// structured Title filter at all (checked both the quick-filter pill row and
// the full "All filters" panel), but each company's own LinkedIn page has a
// People tab with its own keyword search box, and real boolean OR works
// there when capitalized (e.g. "CEO OR CTO" genuinely returned both
// CEO-titled and CTO-titled people, not a loose text match). No location or
// currentCompany= facet is needed - this page is already scoped to one
// company, and Phase 6 only ever runs on companies Phase 5 already
// location-vetted.
//
// **Confirmed the match is against a person's ENTIRE career history, not
// just their current role**: a real "CEO OR CTO" search here matched a
// card displaying "Senior Advisor" as its own headline - nothing "CEO" or
// "CTO" anywhere in the card's own text, the match came purely from a past
// role. This is exactly why this script reports each candidate's raw
// headline text back to the orchestrator rather than deciding a match
// itself - contact-discovery-extraction.js applies the real title/alias
// validation (storage.js's TITLE_ALIAS_GROUPS/titleVariants) against that
// text, discarding a candidate whose own displayed headline doesn't
// actually contain the target title/keyword or a known variant of it.
//
// Card structure, confirmed live against a real result set (12 cards for
// NeoXam's own People tab, "CEO OR CTO"): each candidate is
// <li class="org-people-profile-card__profile-card-spacing">, whose
// .artdeco-entity-lockup__title holds the person's name, whose
// .artdeco-entity-lockup__subtitle holds their own displayed headline/title
// text, and whose own a[href*="/in/"] gives the profile slug - real,
// semantic LinkedIn CSS class names (not hashed/obfuscated), unlike most of
// this project's other selectors.
//
// **Pagination NOT pursued for v1**: the visible "Page 2"/"Page 3"... controls
// under the result list are plain <button>s with no href - confirmed live a
// programmatic click on one did not change the rendered cards, so this
// isn't a simple &page=N URL the way Company Search's pagination is (see
// company-discovery-content-script.js). Deliberately not chased further:
// with a configurable cap of up to targetContactProfile.maxContactsPerAccount
// contacts per company (10, and this same NeoXam search's own FIRST screen
// already returned 12 raw candidates), deeper pagination isn't needed to
// reach that cap in the common case - a company with fewer than the cap's
// worth of qualifying candidates in this first batch simply returns
// whatever's genuinely there, not guessed at further.

(function () {

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function parseProfileSlug(href) {
  const match = (href || "").match(/\/in\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function findCandidateCards() {
  return Array.from(document.querySelectorAll("li.org-people-profile-card__profile-card-spacing"));
}

// LinkedIn's own transient error state for this page, confirmed live
// 2026-09-15: "We are unable to load people insights data at this time.
// Please refresh the page and try again." - seen twice in a row during a
// real automated run (ABB, UBS), while manually reloading the exact same
// URL immediately after rendered real cards with no error both times - the
// same class of automated-navigation timing issue already found and fixed
// for Phase 5's Company Search pages, not a genuine "no data" state. Text-
// matched so the orchestrator can tell this apart from a real zero-result
// page and retry instead of recording a false "no qualifying candidates."
function findInsightsLoadError() {
  const bodyText = document.body.innerText || "";
  return /unable to load people insights data/i.test(bodyText);
}

function extractCandidate(card) {
  const name = card.querySelector(".artdeco-entity-lockup__title")?.textContent;
  const subtitle = card.querySelector(".artdeco-entity-lockup__subtitle")?.textContent;
  const link = card.querySelector('a[href*="/in/"]');
  return {
    slug: parseProfileSlug(link?.getAttribute("href")),
    name: normalizeText(name),
    headlineText: normalizeText(subtitle),
  };
}

const POLL_INTERVAL_MS = 500;
// Same widened window as company-discovery-content-script.js's
// POLL_MAX_ATTEMPTS (20, ~10s), for the same reason - a real page-render
// latency margin, not just the 6s other extraction content scripts use.
const POLL_MAX_ATTEMPTS = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const { contactDiscoveryActive } = await chrome.storage.local.get(["contactDiscoveryActive"]);
  if (!contactDiscoveryActive || !location.pathname.includes("/people/")) return;

  let cards = [];
  let insightsLoadError = false;
  let caughtError = null;
  try {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      cards = findCandidateCards();
      if (cards.length > 0) break;
      insightsLoadError = findInsightsLoadError();
      if (insightsLoadError) break;
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    caughtError = err?.message || String(err);
  }

  const results = (caughtError ? [] : cards).map(extractCandidate).filter((c) => c.slug && c.name);
  console.log(`[SalesTeam] contact discovery scrape: ${results.length} candidate(s) found`, insightsLoadError ? "insightsLoadError=true" : "", caughtError ? `error=${caughtError}` : "");

  chrome.runtime.sendMessage({
    type: "CONTACT_DISCOVERY_RESULT",
    url: location.href.split("?")[0],
    results,
    insightsLoadError,
    caughtError,
  });
}

run().catch((err) => {
  // Belt and suspenders, same as every other extraction content script -
  // even a failure in run() itself still reports something rather than
  // leaving the orchestrator to time out with zero information.
  chrome.runtime.sendMessage({
    type: "CONTACT_DISCOVERY_RESULT",
    url: location.href.split("?")[0],
    results: [],
    caughtError: err?.message || String(err),
  }).catch(() => {});
});

})();
