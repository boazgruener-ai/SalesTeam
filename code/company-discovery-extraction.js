import { withBatch } from "./batch-jobs.js";
// Orchestrates PRD 6.20 Phase 5 (Target Account & Contact Discovery -
// Company discovery scan): builds a LinkedIn Company Search URL from the
// onboarding wizard's targetUniverseConfig, pages through the results,
// scrapes each card via company-discovery-content-script.js, and keeps only
// companies whose OWN location resolves to a target country (Priority 1 -
// see the plan's tiering decision; a facet-matched card whose own location
// can't be confirmed is Priority 2, deferred past v1 and simply skipped).
// Modeled directly on company-resolve-extraction.js's orchestration pattern
// (navigateAndWaitResolve/waitForResolveResult, randomDelay pacing,
// chrome.power.requestKeepAwake, tab lifecycle in a finally block) -
// generalized from "resolve one company's id" to "page through many cards."
//
// Reads its config and resume point from discovery-queue.js's own state
// (state.configSnapshot, state.companyPhase) rather than taking a config
// argument - the queue module already owns exactly that (frozen at Start
// time so a mid-run wizard edit can't silently reconfigure a scan already
// under way, per its own docstring), and checkpoints back into it after
// every page so a stop (user-initiated or the shared touch budget) never
// loses more than one page's worth of progress.
//
// Search-facet construction (companyHqGeo/companySize/industryCompanyVertical)
// and result-card pagination (&page=N) both confirmed live 2026-09-15 - see
// company-discovery-content-script.js's own header comment for the card DOM
// evidence, and geo-urn-map.js/industry-id-map.js for which countries/
// industries actually have a confirmed id (anything not yet confirmed is
// simply left out of the facet rather than guessed - see
// buildSearchFacets' unscopedCountries/unscopedIndustries).

import {
  getCompanyExclusions,
  getOrganizationTypeEligibility,
  getCompanyAliases,
  findCompanyAlias,
  getCachedCompanyLocation,
  cacheCompanyLocation,
  appendDiscoveredCompanies,
  getDiscoveredCompanies,
  getKeywordSearchLanguages,
  CONTINENT_COUNTRIES,
  SIZE_PRIORITY_BUCKETS,
  getTargetAccountsWorkbook,
  parseLinkedinCompanySlug,
  normalizeCompanyName,
} from "./storage.js";
import { geoUrnForCountry } from "./geo-urn-map.js";
import { industryIdForName } from "./industry-id-map.js";
import { localCountryName } from "./country-local-names.js";
import { findIsoCountryCodeInText, COUNTRY_BY_ISO_CODE } from "./iso-country-codes.js";
import { getDiscoveryQueueState, checkpointCompanyPhase, advanceToContactPhase } from "./discovery-queue.js";
import { recordLinkedinTouch } from "./linkedin-touch-log.js";
import { checkTouchBudget } from "./touch-budget-guard.js";

const NAV_TIMEOUT_MS = 20000;
const PAGE_RESULT_TIMEOUT_MS = NAV_TIMEOUT_MS + 8000; // same derivation as company-resolve-extraction.js
const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 9000;
// Defensive only - not derived from a confirmed LinkedIn limit. The real
// stop conditions are a page returning zero cards (end of results) or the
// configured company cap being reached; this just prevents an unexpected
// bug (e.g. a page that always reports cards) from looping forever.
const MAX_PAGES_SAFETY_CAP = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

// LinkedIn's confirmed companySize facet letters (see this project's plan
// file / PRD 6.20 for how each was confirmed against the live filter UI).
const SIZE_BUCKETS = [
  { letter: "B", min: 1, max: 10 },
  { letter: "C", min: 11, max: 50 },
  { letter: "D", min: 51, max: 200 },
  { letter: "E", min: 201, max: 500 },
  { letter: "F", min: 501, max: 1000 },
  { letter: "G", min: 1001, max: 5000 },
  { letter: "H", min: 5001, max: 10000 },
  { letter: "I", min: 10001, max: Infinity },
];

// Every bucket that overlaps [min, max] at all - a range like 150-600
// legitimately spans three of LinkedIn's own buckets (D, E, F), so this
// asks LinkedIn for all of them rather than picking just one.
function sizeLettersForRange(minEmployees, maxEmployees) {
  const min = minEmployees ?? 1;
  const max = maxEmployees ?? Infinity;
  return SIZE_BUCKETS.filter((b) => b.max >= min && b.min <= max).map((b) => b.letter);
}

// Size step redesign (2026-09-16) - targetUniverseConfig.sizeBuckets is now
// storage.js's 5 fixed, independently-checked priority buckets (S/M/L/XL/
// XXL), not a topN/min-max range. Facet-building only cares which buckets
// are CHECKED (their priority is captured for a future Phase 8 scoring
// pass, not consumed here) - unions sizeLettersForRange's own overlap logic
// per checked bucket's [min, max], reusing it rather than duplicating the
// same LinkedIn-letter-overlap computation for a second boundary set.
function sizeLettersForConfig(sizeBuckets) {
  const letters = new Set();
  for (const bucket of SIZE_PRIORITY_BUCKETS) {
    if (!sizeBuckets?.[bucket.key]?.checked) continue;
    for (const letter of sizeLettersForRange(bucket.min, bucket.max === Infinity ? null : bucket.max)) {
      letters.add(letter);
    }
  }
  return [...letters];
}

function encodeFacetValues(values) {
  const inner = values.map((v) => `%22${v}%22`).join("%2C");
  return `%5B${inner}%5D`;
}

// Expands the wizard's location choice (either a direct country list, or a
// continent list expanded via storage.js's own CONTINENT_COUNTRIES - the
// same table Settings' Location Filter already draws from) down to one
// **search unit per country per keyword-search language**
// (`{country, geoUrn, keywordText, language}`), plus which chosen countries
// have no confirmed geoUrn yet (surfaced to the caller rather than silently
// dropped, so an unusually narrow search has an explanation, not just fewer
// results than expected). targetCountrySet is the parallel plain-country-
// name set the per-card location check compares against, independent of
// which countries happen to have a confirmed geoUrn - a card's own location
// text can still confirm a country even when that country's facet id isn't
// known yet.
//
// One unit per country, not one combined multi-country search - changed
// 2026-09-15 alongside adding the keywords= country-name term below (see
// buildSearchUrl): a keyword can only ever be one term, so a combined
// multi-country query couldn't carry one anyway, and per-country queries
// also match this codebase's own established design rule for keyword-
// anchored searches ("get breadth from more distinct queries instead" -
// see the plan's "Result relevance degrades sharply with page depth" note).
//
// Keyword-search languages (storage.js's keywordSearchLanguages, wired in
// 2026-09-16 - previously saved by the onboarding wizard but never consumed
// here) add one further search unit per country per selected language,
// each anchored on that language's own name for the country (country-local-
// names.js) instead of the English name every country's base unit already
// searches under - the same real problem the English keyword term was
// added to solve (facet-only search leads with globally prominent
// companies, not genuinely local ones), but for a German/French-market
// company whose LinkedIn presence is more likely to surface under its own
// language's country name. Real cost, not free: each extra language is a
// fully separate paginated search per country, against the same shared
// touch budget every other page visit here draws from. A country in
// GEO_URN_MAP with no matching country-local-names.js entry for a selected
// language simply doesn't get that language's unit (unscopedLanguageUnits,
// surfaced the same way unscopedCountries/unscopedIndustries are) rather
// than guessing a translation.
function resolveTargetCountries(config, keywordSearchLanguages) {
  const countryNames =
    config.locationMode === "continent"
      ? [...new Set((config.continents || []).flatMap((c) => CONTINENT_COUNTRIES[c] || []))]
      : [...new Set(config.countries || [])];
  const searchUnits = [];
  const unscopedCountries = [];
  const unscopedLanguageUnits = [];
  for (const name of countryNames) {
    const urn = geoUrnForCountry(name);
    if (!urn) { unscopedCountries.push(name); continue; }
    searchUnits.push({ country: name, geoUrn: urn, keywordText: name, language: "English" });
    for (const language of keywordSearchLanguages || []) {
      const localName = localCountryName(name, language);
      if (localName) searchUnits.push({ country: name, geoUrn: urn, keywordText: localName, language });
      else unscopedLanguageUnits.push(`${name} (${language})`);
    }
  }
  return { targetCountrySet: new Set(countryNames), searchUnits, unscopedCountries, unscopedLanguageUnits };
}

// config.industries is storage.js's { name, priority }[] (redesigned
// 2026-09-16 from a flat string[]) - only .name matters for facet-building;
// priority is captured for a future Phase 8 scoring pass, not consumed here.
// 27th round of direct feedback (2026-09-19): industryIdForName now returns
// an array (a GICS sector, e.g. Materials, can carry more than one LinkedIn
// id - see industry-id-map.js) - spread instead of a single push; the
// dedup below already handles a Sector's ids overlapping another Sector's.
function resolveIndustryIds(config) {
  const ids = [];
  const unscopedIndustries = [];
  for (const { name } of config.industries || []) {
    const idsForName = industryIdForName(name);
    if (idsForName.length > 0) ids.push(...idsForName);
    else unscopedIndustries.push(name);
  }
  return { industryIds: [...new Set(ids)], unscopedIndustries };
}

// keywords=<country name> added 2026-09-15 after a real, confirmed problem:
// a facet-only query (no keyword) ranks results toward "companies you
// follow"/globally prominent companies regardless of how narrow the facets
// are - confirmed live, a Switzerland-only facet search led with Microsoft,
// Google, Meta, Oracle, Salesforce (only 3 of the first 10 genuinely
// Swiss-HQ'd), and removing the industry facet made the ratio *worse*, not
// better, ruling out industry selection as the cause. Adding the country
// name as a keyword raised that to 9 of 10 genuinely Swiss-located results
// in the same live test - confirmed by the user independently the same way.
// Known tradeoff, not free: this also surfaces country-named entities that
// aren't real sales prospects (a tourism board, a government agency, a
// think tank) - accepted as reviewable noise rather than built around, and
// per the plan's own prior finding, keyword-anchored searches can degrade
// with page depth - not yet confirmed how deep this specific term holds up.
function buildSearchUrl({ geoUrn, keywordText, sizeLetters, industryIds, page }) {
  const params = [`keywords=${encodeURIComponent(keywordText)}`, `companyHqGeo=${encodeFacetValues([geoUrn])}`];
  if (sizeLetters.length) params.push(`companySize=${encodeFacetValues(sizeLetters)}`);
  if (industryIds.length) params.push(`industryCompanyVertical=${encodeFacetValues(industryIds)}`);
  params.push(`page=${page}`);
  return `https://www.linkedin.com/search/results/companies/?${params.join("&")}`;
}

function companyPageUrl(slug) {
  return `https://www.linkedin.com/company/${encodeURIComponent(slug)}/`;
}

// Registered before navigation starts, same listener-race reasoning as
// company-resolve-extraction.js's navigateAndWaitResolve/waitForResolveResult
// (a document_idle content script can run and postMessage before "complete"
// fires, especially on LinkedIn's JS-heavy SPA pages). Unlike that file,
// this orchestration never has two of its own requests in flight at once -
// every page fetch and every fallback-tier location check is awaited fully,
// one at a time, before the next begins - so matching on message type alone
// (not also on a name/url, which the resolve module needs because it can
// legitimately have a search attempt and a fallback attempt overlapping in
// theory) is sufficient here.
function navigateAndWait(tabId, url) {
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
    chrome.tabs.update(tabId, { url, active: true }).catch(() => {});
    recordLinkedinTouch().catch(() => {});
  });
}

function waitForMessage(type, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve(null);
      }
    }, timeoutMs);
    function listener(message) {
      if (message?.type === type && !settled) {
        settled = true;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message);
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

async function fetchSearchPage(tab, url) {
  await chrome.storage.local.set({ companyDiscoveryActive: true, companyDiscoveryLocationCheckActive: false });
  const resultPromise = waitForMessage("COMPANY_DISCOVERY_PAGE_RESULT", PAGE_RESULT_TIMEOUT_MS);
  const { navCompleted } = await navigateAndWait(tab.id, url);
  const message = await resultPromise;
  // receivedMessage distinguishes "the content script ran and genuinely
  // found zero cards" from "no message ever arrived at all" (extension not
  // reloaded after a content-script registration change, the page took
  // longer than the content script's own ~6s poll cap to render, or the
  // content script threw before it could report anything) - reported
  // directly, an early debug run came back with zero results and no way to
  // tell which of those it was, since only the final card count was ever
  // surfaced.
  return {
    navCompleted,
    receivedMessage: Boolean(message),
    results: message?.results || [],
    caughtError: message?.caughtError || null,
  };
}

// The fallback tier - visits a company's own page to read its structured
// headquarters field (see company-discovery-content-script.js's
// extractHeadquarterCountry) and, since 2026-09-15, its numeric LinkedIn id
// too (findEmployeesLinkCompanyId - the same "Acino gap" fix already proven
// in company-resolve-content-script.js: a search-results card only carries
// its id when there's network overlap to attach a "hired here" link to, but
// a company's own page always carries one via its own "X employees" link).
// Called whenever a card's own location isn't already known AND/OR its id
// is missing from the card - a real LinkedIn page visit either way, so it's
// paced and touch-budget-checked exactly like every other navigation here,
// not treated as free.
async function fetchLocationFallback(tab, slug) {
  await chrome.storage.local.set({ companyDiscoveryActive: false, companyDiscoveryLocationCheckActive: true });
  const resultPromise = waitForMessage("COMPANY_DISCOVERY_LOCATION_RESULT", PAGE_RESULT_TIMEOUT_MS);
  const { navCompleted } = await navigateAndWait(tab.id, companyPageUrl(slug));
  const message = await resultPromise;
  return {
    navCompleted,
    country: message?.country || null,
    city: message?.city || null,
    linkedinCompanyId: message?.linkedinCompanyId || null,
    caughtError: message?.caughtError || null,
  };
}

export function estimateDiscoveryMinutes(maxCompanies) {
  const avgPacingMs = (MIN_DELAY_MS + MAX_DELAY_MS) / 2;
  // Rough: assumes ~10 cards/page (typical LinkedIn results density, not a
  // confirmed constant) plus one fallback-tier visit for roughly half the
  // cards - just enough for the wizard's own confirmation text, not a
  // precise ETA.
  const estimatedPages = Math.max(1, Math.ceil(maxCompanies / 10));
  const estimatedFallbackVisits = Math.ceil(maxCompanies / 2);
  return Math.ceil(((estimatedPages + estimatedFallbackVisits) * avgPacingMs) / 60000);
}

// Runs (or resumes) the company-discovery phase of the queue in
// discovery-queue.js, one page of Company Search results at a time.
// Returns a summary of this call's own activity - the authoritative running
// totals live in the queue state itself (getDiscoveryQueueState), since a
// multi-day run is expected to call this more than once.
async function runCompanyDiscoveryPhaseImpl({ onProgress, shouldAbort } = {}) {
  const state = await getDiscoveryQueueState();
  if (state.status !== "discovering_companies") {
    return { ranAnything: false, reason: `queue status is "${state.status}", not "discovering_companies"` };
  }
  const config = state.configSnapshot;
  const keywordSearchLanguages = await getKeywordSearchLanguages();
  const { targetCountrySet, searchUnits, unscopedCountries, unscopedLanguageUnits } = resolveTargetCountries(config, keywordSearchLanguages);
  const { industryIds, unscopedIndustries } = resolveIndustryIds(config);
  const sizeLetters = sizeLettersForConfig(config.sizeBuckets);
  const effectiveCap = config.maxCompanies || Infinity;

  const [companyExclusions, organizationTypeEligibility, companyAliases, existingWorkbook] = await Promise.all([
    getCompanyExclusions(),
    getOrganizationTypeEligibility(),
    getCompanyAliases(),
    getTargetAccountsWorkbook(),
  ]);
  // Every category (competitor/recruiter/customer/partner/other, storage.js's
  // unified companyExclusions) is excluded from Discovery outright, same
  // mechanics regardless of category - the category only matters for
  // *why*, shown elsewhere, not for whether a card gets skipped here.
  const excludedSlugSet = new Set(companyExclusions.map((e) => e.slug));
  // Reported directly, 2026-09-17: Discovery had no idea which companies
  // were already in the real Target Accounts workbook (528 ChatGPT-
  // researched rows, in the user's own real case) - it would happily
  // re-find, count against the cap, and spend a fallback-tier LinkedIn
  // visit on a company already known, only for Phase 7's own merge to
  // later recognize it as a duplicate and throw the "discovery" away.
  // Skipped here instead, before any touch-costing action, same reasoning
  // as the alias-duplicate check just below - identity-preferred (a
  // LinkedIn slug match, parsed from the workbook row's own linkedinLink)
  // with a normalizeCompanyName fallback for a row that has no LinkedIn
  // link on file, same ID-preferred/name-fallback pattern Phase 7's own
  // merge dedup uses, for the same reason (name alone is fragile against
  // translated names/acronyms/typos).
  const existingCompanySlugSet = new Set(
    (existingWorkbook.companies || []).map((c) => parseLinkedinCompanySlug(c.linkedinLink || "")).filter(Boolean)
  );
  const existingCompanyNameSet = new Set(
    (existingWorkbook.companies || []).map((c) => normalizeCompanyName(c.company)).filter(Boolean)
  );
  // Organization Type eligibility (storage.js's organizationTypeEligibility -
  // "yes"/"no"/"review" per confirmed non-standard-org-type industry,
  // defaulting to "yes" when unset) - matches a card's own DISPLAYED
  // industry text exactly, not the industryCompanyVertical id used to build
  // the search facet - see industry-id-map.js's EXCLUDABLE_INDUSTRIES for
  // why the two don't always agree (a company categorized here can display
  // a different, more specific industry label), an accepted v1 gap rather
  // than an extra page visit per card.

  // Cursor is now {unitIndex, page} - one search unit per target country
  // (see resolveTargetCountries) - not a bare page number. Guarded against
  // a stale cursor from before this shape existed (a plain number, from an
  // earlier test run): falls back to the start rather than crashing.
  const cursor =
    state.companyPhase.nextSearchCursor && typeof state.companyPhase.nextSearchCursor === "object"
      ? state.companyPhase.nextSearchCursor
      : { unitIndex: 0, page: 1 };
  let unitIndex = cursor.unitIndex || 0;
  let page = cursor.page || 1;
  // processedKeys - every card seen so far, included or excluded, across
  // every resumed call of this phase - purely a dedupe/resume set, never
  // compared against effectiveCap. acceptedCount is the actual output size
  // (the count that matters for the cap), seeded from the already-staged
  // discoveredCompanies rather than derived from processedKeys - an
  // excluded-by-location or blocklisted card must never count against a
  // user's "give me 200 companies" cap the way an accepted one does.
  const processedKeys = new Set(state.companyPhase.discoveredCompanyKeys || []);
  const alreadyDiscovered = await getDiscoveredCompanies();
  let acceptedCount = alreadyDiscovered.length;
  // Company alias resolution (storage.js's companyAliases/findCompanyAlias) -
  // a card whose slug is a known alias (e.g. "Audi Schweiz") is attributed to
  // its real canonical company (e.g. AMAG) rather than written up as its own
  // independent account. "Identity" here (identitySlugSet) is the canonical
  // slug when a card resolves through an alias, or the card's own slug
  // otherwise - whichever a record is actually about. Seeded from every
  // company already staged before this call (including by an earlier
  // resumed call of this same phase), not just this call's own finds, so a
  // company already represented - directly or via a different alias -
  // earlier in the same run is never written up twice.
  const identitySlugSet = new Set(alreadyDiscovered.map((c) => c.canonicalSlug || c.slug));
  const newlyDiscovered = [];
  let excludedByBlocklist = 0;
  let excludedByOrganizationType = 0;
  let flaggedForReviewCount = 0;
  let excludedByAliasDuplicate = 0;
  let excludedByAlreadyInWorkbook = 0;
  let excludedByLocation = 0;
  let skippedNoId = 0;
  let stoppedByTouchBudget = false;
  let stoppedByAbort = false;
  let hitSafetyCap = false;
  let reachedCap = acceptedCount >= effectiveCap;
  let pagesFetched = 0;
  let tab;
  // Same diagnostic-sample idea as company-resolve-extraction.js's
  // debugSamples - one entry per page fetched, capped, so a run that finds
  // nothing is debuggable (extension not reloaded / content script never
  // ran vs. genuinely zero real matches) instead of a silent empty summary.
  const pageDebugSamples = [];
  const MAX_PAGE_DEBUG_SAMPLES = 5;

  try {
    chrome.power.requestKeepAwake("system");
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
    // Same cold-start warm-up as company-resolve-extraction.js's
    // runCompanyIdResolution - a fresh tab's very first navigation risks
    // missing the timeout window before the content script is reliably
    // running.
    await navigateAndWait(tab.id, "https://www.linkedin.com/feed/");

    // Outer loop: one search unit (a country x keyword-search-language pair,
    // see resolveTargetCountries) at a time, not one combined multi-country
    // query, so each gets its own keywords=<country name in that language>
    // term (see buildSearchUrl). hitSafetyCap distinguishes "the global
    // MAX_PAGES_SAFETY_CAP backstop fired" (something's likely wrong - stop
    // the whole run, don't just move on to the next unit) from a normal
    // per-unit exhaustion.
    while (unitIndex < searchUnits.length && !reachedCap) {
      const unit = searchUnits[unitIndex];
      let unitExhausted = false;

      while (!reachedCap && pagesFetched < MAX_PAGES_SAFETY_CAP) {
        if (shouldAbort && shouldAbort()) { stoppedByAbort = true; break; }
        if (await checkTouchBudget()) { stoppedByTouchBudget = true; break; }

        const url = buildSearchUrl({ geoUrn: unit.geoUrn, keywordText: unit.keywordText, sizeLetters, industryIds, page });
        let { navCompleted, receivedMessage, results, caughtError } = await fetchSearchPage(tab, url);
        pagesFetched++;
        // A page that comes back with zero cards isn't reliably "end of
        // results" - confirmed live 2026-09-15: a real orchestrated run
        // reported resultCount: 0 for a page that demonstrably had real
        // cards (30 anchors, found instantly loading it directly) - a
        // rendering-latency miss, not genuine exhaustion. Originally a
        // single same-page retry; reported directly again 2026-09-17
        // (same signature: navCompleted/receivedMessage both true, 0
        // results, on a page directly confirmed via Claude in Chrome to
        // render 10 real, correctly-structured cards within 2-3s even in
        // the same rapid same-tab navigation sequence this loop uses) -
        // one retry evidently isn't always enough. Bumped to up to 2
        // retries (3 attempts total), each with the same real pacing
        // delay as a normal page fetch, before a zero-result page is
        // trusted as genuine exhaustion - the most a transient miss
        // (rendering latency, or LinkedIn occasionally serving a
        // degraded/empty panel to automated-looking traffic mid-session)
        // can be defended against without a fundamentally different
        // signal than "did real cards eventually show up."
        const MAX_ZERO_RESULT_RETRIES = 2;
        for (let retryCount = 0; retryCount < MAX_ZERO_RESULT_RETRIES && results.length === 0 && receivedMessage && !caughtError; retryCount++) {
          await sleep(randomDelay());
          const retry = await fetchSearchPage(tab, url);
          ({ navCompleted, receivedMessage, results, caughtError } = retry);
        }
        if (pageDebugSamples.length < MAX_PAGE_DEBUG_SAMPLES) {
          pageDebugSamples.push({ country: unit.country, language: unit.language, page, url, navCompleted, receivedMessage, resultCount: results.length, caughtError });
        }
        if (onProgress) onProgress({ country: unit.country, language: unit.language, page, foundSoFar: acceptedCount, cap: effectiveCap });

        if (results.length === 0) { unitExhausted = true; break; } // end of results for this country (confirmed by retry)

        for (const card of results) {
          if (reachedCap) break;
          if (shouldAbort && shouldAbort()) { stoppedByAbort = true; break; }

          if (excludedSlugSet.has(card.slug)) { excludedByBlocklist++; continue; }
          // "no" excludes wholesale (same as the old binary version); "review"
          // keeps the company but tags it (organizationTypeReviewLabel, used
          // below when building the discovered-company record) instead of
          // silently treating it as a normal match or silently dropping it;
          // "yes" (including unset/default) is a fully normal candidate.
          const orgTypeChoice = card.industryText ? organizationTypeEligibility[card.industryText] : undefined;
          if (orgTypeChoice === "no") { excludedByOrganizationType++; continue; }
          const organizationTypeReviewLabel = orgTypeChoice === "review" ? card.industryText : null;
          if (organizationTypeReviewLabel) flaggedForReviewCount++;

          // Alias resolution happens before the id/location fallback-tier
          // visit below (same reasoning as the blocklist check above - a
          // card that's about to be discarded as a duplicate shouldn't cost
          // a real LinkedIn page visit first). A card matching a known alias
          // is attributed to its canonicalSlug identity; a second card that
          // resolves to the same identity (whether directly or via a
          // different alias) earlier in this same run is a real duplicate,
          // not a new account.
          const alias = findCompanyAlias(card.slug, companyAliases);
          const cardIdentitySlug = alias ? alias.canonicalSlug : card.slug;
          if (identitySlugSet.has(cardIdentitySlug)) { excludedByAliasDuplicate++; continue; }

          // Already in the real Target Accounts workbook (ChatGPT-imported or
          // an earlier Discovery merge) - see this block's own header
          // comment above for why this has to happen before the
          // touch-costing fallback-tier visit below, same as the alias
          // check just above.
          if (existingCompanySlugSet.has(cardIdentitySlug) || existingCompanyNameSet.has(normalizeCompanyName(card.name))) {
            excludedByAlreadyInWorkbook++;
            continue;
          }

          let key = card.linkedinCompanyId || null;
          if (key && processedKeys.has(key)) continue;

          let country = findIsoCountryCodeInText(card.locationText);
          let resolvedVia = country ? "free_tier_card_text" : null;

          if (!country && key) {
            const cached = await getCachedCompanyLocation(key);
            if (cached?.country) {
              country = cached.country;
              resolvedVia = "cache";
            }
          }

          // A fallback-tier company-page visit is needed if the id is still
          // missing - a card only carries its currentCompany= id when
          // there's network overlap to attach a "hired here" link to (the
          // same "Acino gap" already solved in company-resolve-content-
          // script.js; confirmed live 2026-09-15 that 15 of 40 real cards,
          // 37.5%, had none, silently discarded before this fix) - and/or
          // if the location is still unconfirmed. One visit recovers
          // whichever piece(s) are actually missing.
          if (!key || !country) {
            if (await checkTouchBudget()) { stoppedByTouchBudget = true; break; }
            await sleep(randomDelay());
            const fallback = await fetchLocationFallback(tab, card.slug);
            if (!key && fallback.linkedinCompanyId) {
              key = fallback.linkedinCompanyId;
              if (processedKeys.has(key)) continue;
            }
            if (!country && fallback.country) {
              // fallback.country is a raw ISO-2 code straight from the
              // page's own structured data (e.g. "CH") - findIsoCountryCodeInText
              // (free tier) and targetCountrySet both deal in canonical
              // country names (e.g. "Switzerland") instead, so this has to
              // go through the same COUNTRY_BY_ISO_CODE reverse-lookup the
              // free tier uses before it's comparable/cacheable. Bug found
              // live 2026-09-15: without this, every fallback-tier
              // resolution silently failed the targetCountrySet.has() check
              // regardless of the real country, excluding companies that
              // should have been Priority 1 matches (confirmed: a real run
              // with 10 genuine Swiss-HQ cards on the page came back with
              // excludedByLocation: 10, totalDiscovered: 0).
              const fallbackCountryName = COUNTRY_BY_ISO_CODE[fallback.country] || null;
              if (fallbackCountryName) {
                country = fallbackCountryName;
                resolvedVia = "fallback_tier_company_page";
              }
            }
          }

          if (!key) { skippedNoId++; continue; }

          if (country && (resolvedVia === "free_tier_card_text" || resolvedVia === "fallback_tier_company_page")) {
            await cacheCompanyLocation(key, { country, sizeBucket: null, resolvedVia });
          }

          if (!country || !targetCountrySet.has(country)) {
            // Either no location could be confirmed at all, or it confirmed
            // to a country outside the target set - Priority 2 (facet-matched
            // but card-location-unconfirmed) is deferred past v1, so both
            // cases are simply excluded here rather than guessed at.
            excludedByLocation++;
            processedKeys.add(key);
            continue;
          }

          processedKeys.add(key);
          identitySlugSet.add(cardIdentitySlug);
          newlyDiscovered.push({
            linkedinCompanyId: key,
            slug: card.slug,
            name: card.name,
            industryText: card.industryText,
            country,
            resolvedVia,
            organizationTypeReviewLabel,
            // Only present when card.slug is a known alias (storage.js's
            // companyAliases) - the real, canonical company this record is
            // actually about. slug/name above stay the literal, actually-
            // discovered LinkedIn page, unaltered - canonicalSlug is where a
            // consumer (settings.js's viewer, a future Phase 7 merge) should
            // look to treat this as that company's own record instead.
            canonicalSlug: alias ? alias.canonicalSlug : null,
            discoveredAt: Date.now(),
          });
          acceptedCount++;
          if (acceptedCount >= effectiveCap) reachedCap = true;
          await sleep(randomDelay());
        }

        if (newlyDiscovered.length) {
          await appendDiscoveredCompanies(newlyDiscovered.splice(0, newlyDiscovered.length));
        }
        // Only advance the page cursor when this page's cards were all
        // actually looked at. A mid-page abort/touch-budget stop leaves
        // `page` where it is, so a resume re-fetches this same page - the
        // cards already in processedKeys are skipped again for free (see
        // the dedupe check above), and the ones the stop cut off short get
        // a real second chance instead of being silently skipped forever
        // the next time this run resumes.
        const stoppedMidPage = stoppedByAbort || stoppedByTouchBudget;
        if (!stoppedMidPage) page++;
        await checkpointCompanyPhase({ nextSearchCursor: { unitIndex, page }, discoveredCompanyKeys: [...processedKeys] });

        if (stoppedMidPage || reachedCap) break;
        await sleep(randomDelay());
      }

      if (!unitExhausted && !reachedCap && !stoppedByAbort && !stoppedByTouchBudget && pagesFetched >= MAX_PAGES_SAFETY_CAP) {
        hitSafetyCap = true;
      }
      if (stoppedByAbort || stoppedByTouchBudget || hitSafetyCap || reachedCap) break;

      // This country is exhausted - move to the next one, page resets to 1.
      unitIndex++;
      page = 1;
      await checkpointCompanyPhase({ nextSearchCursor: { unitIndex, page }, discoveredCompanyKeys: [...processedKeys] });
    }

    // Every fetched page's content script silently never responded at all
    // (receivedMessage: false on all of them) - almost certainly a systemic
    // problem (the extension wasn't reloaded after a content-script
    // registration change, or the page never got past LinkedIn's own
    // loading state within the content script's poll window), not "zero
    // real matches." Treated as inconclusive rather than done, so the queue
    // stays in discovering_companies and a retry (after fixing the actual
    // cause) picks up cleanly - advancing to a contact phase with nothing
    // to work from would otherwise strand the run.
    const contentScriptNeverResponded = pageDebugSamples.length > 0 && pageDebugSamples.every((s) => !s.receivedMessage);
    if (!stoppedByAbort && !stoppedByTouchBudget && !hitSafetyCap && !contentScriptNeverResponded) {
      // Either the cap was reached or every target country's results ran
      // out - both mean this phase is genuinely done, not just paused, so
      // hand off to Phase 6 the same way discovery-queue.js's own
      // docstring describes.
      await advanceToContactPhase();
    }
  } finally {
    chrome.power.releaseKeepAwake();
    await chrome.storage.local
      .remove(["companyDiscoveryActive", "companyDiscoveryLocationCheckActive"])
      .catch(() => {});
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }

  return {
    ranAnything: true,
    pagesFetched,
    totalDiscovered: acceptedCount,
    excludedByBlocklist,
    excludedByOrganizationType,
    flaggedForReviewCount,
    excludedByAliasDuplicate,
    excludedByAlreadyInWorkbook,
    excludedByLocation,
    skippedNoId,
    unscopedCountries,
    unscopedIndustries,
    unscopedLanguageUnits,
    keywordSearchLanguages,
    stoppedByTouchBudget,
    stoppedByAbort,
    hitSafetyCap,
    reachedCap,
    pageDebugSamples,
  };
}

export function runCompanyDiscoveryPhase(...args) {
  return withBatch("Discovery of companies", () => runCompanyDiscoveryPhaseImpl(...args));
}
