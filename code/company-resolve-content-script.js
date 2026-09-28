// Runs on a LinkedIn Companies-only search results page
// (linkedin.com/search/results/companies/*), and also on a company's own
// page (linkedin.com/company/*) as a fallback - EXPERIMENTAL, see PRD 6.16
// and company-resolve-extraction.js. Only ever active during an explicit,
// user-triggered resolution run (company-resolve-extraction.js sets
// companyResolveActive and a companyResolveTarget before navigating here) -
// does nothing during normal browsing, same gating pattern as the other
// extraction content scripts.
//
// Confirmed against real HTML the user shared (not guessed): the search
// page's "hero card" - the featured single-entity match for the search
// query, at the top of the results - is ONE anchor
// (a[href*="linkedin.com/company/..."]) wrapping both the hero's own name
// (its first nested <p>) AND a "X connections/alumni work here" People-
// search link whose href encodes currentCompany=["<id>"], nested inside
// that SAME anchor (confirmed live for "Aargauische Kantonalbank" - the
// href is genuinely a descendant of the company-page anchor, not merely
// adjacent to it; LinkedIn builds its DOM via direct element creation
// rather than HTML-parsing, so the "no nested <a> in the DOM" rule that
// would normally apply to parsed markup doesn't hold here). The old code
// searched for the name and the ID independently, each as its own
// page-wide lookup (first match anywhere in document.body.innerHTML) -
// safe most of the time since the hero card is usually first in DOM order,
// but a real desync risk whenever some other match happens to sit earlier
// on the page. Scoping the ID lookup to the confirmed hero anchor's own
// subtree ties both to the same entity and removes that risk entirely.
//
// Confirmed against real HTML the user shared for the "Acino" gap (a
// confident hero name with no currentCompany link anywhere on the search
// page at all): a company's own page - not the search page - has a
// currentCompany link too, under the org-top-card's "X employees" link
// (e.g. currentCompany=%5B%22255145%22%2C%22145413%22%2C%222360196%22%5D -
// note this one can list SEVERAL ids, unlike the single-id array the hero
// card's own link carries). When the search page yields a confident name
// but no ID, the orchestrator (company-resolve-extraction.js) navigates to
// the hero's own company-page href as a fallback and this script's
// runCompanyPageFallback reads the first id off that same link.
//
// Reported directly with real evidence, one run after the two fixes above:
// scoping name+id to a shared anchor doesn't help if that anchor is itself
// the wrong one. A live run against "Aargauische Kantonalbank" (searched via
// the "All" tab, results/all/, at the time) returned a completely unrelated
// company as document's first a[href*="linkedin.com/company/"]. Root cause
// found from a user-shared screenshot, not guessed: the "All" tab doesn't
// reliably lead with a company "hero card" at all - it leads with whatever
// category ranks first, often Posts, and any company merely MENTIONED
// inside a post's text (or its author's own company link) matches
// a[href*="linkedin.com/company/"] just as well as a genuine top company
// match would. Confirmed concretely: the top hit was a Digiterra post whose
// body text happened to read "...customer story with Aargauische
// Kantonalbank (AKB)," and that mention's own link is what got picked up.
// A "Primary content" section scoping attempt (kept in findHeroLink below)
// did NOT fix this - Posts genuinely is part of primary content, not a
// sidebar artifact. The actual fix was upstream, in
// company-resolve-extraction.js: search LinkedIn's Companies-only tab
// (results/companies/) instead of "All" - confirmed live to show ONLY
// company results, and its result card is the exact same DOM shape as the
// "hero card" the extraction below was built against, so nothing here
// needed to change once the right page is being searched.
//
// Wrapped in an IIFE (2026-09-19, real bug confirmed live via a console
// error - "Identifier 'POLL_INTERVAL_MS' has already been declared" on a
// plain https://www.linkedin.com/company/... page visit): Chrome runs
// every content script belonging to one extension in a single shared
// per-page execution scope, not one scope per file. This script and
// company-size-content-script.js are both registered on
// https://www.linkedin.com/company/* (manifest.json), and both had their
// own top-level POLL_INTERVAL_MS/POLL_MAX_ATTEMPTS/sleep/normalizeText/run
// - landing in that same shared scope and colliding, which crashed
// whichever of the two loaded second. Same fix already applied to
// company-discovery-content-script.js for the identical collision found
// 2026-09-15 against THIS file - see its own header comment - that fix
// only wrapped the discovery script, leaving this one (the older of the
// two) still exposed to collide with whatever else got added later, which
// is exactly what happened once company-size-content-script.js shipped.
(function () {

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

// Scoped to <section aria-label="Primary content"> - confirmed to exist on
// the Companies-tab page too, and harmless there since there's normally
// only ever one real result to find. Kept as defense-in-depth against
// whatever might legitimately live in a page's <aside> (ads, right-rail
// widgets), even though it turned out NOT to be the fix for the original
// "Digiterra" misfire (see header comment - that was a wrong-tab problem,
// not a wrong-DOM-scope problem). Falls back to a page-wide search only if
// LinkedIn ever drops that aria-label; namesMatch still prevents a wrong
// link from ever being reported as resolved either way, so a bad fallback
// pick just degrades to "not confident," never a wrong ID.
function findHeroLink() {
  return (
    document.querySelector('section[aria-label="Primary content"] a[href*="linkedin.com/company/"]') ||
    document.querySelector('a[href*="linkedin.com/company/"]')
  );
}

function findHeroCompanyName(heroLink) {
  if (!heroLink) return null;
  const nameEl = heroLink.querySelector("p");
  return nameEl ? normalizeText(nameEl.textContent) : null;
}

// Scoped to the hero anchor's own subtree rather than the whole page - see
// header comment. The regex deliberately does NOT require the array to end
// right after the first id (no trailing %5D) - the company-page fallback's
// own currentCompany link can list multiple ids in one array, and the
// first one is what we want there too.
function findCurrentCompanyIdWithin(container) {
  if (!container) return null;
  const match = container.innerHTML.match(/currentCompany=%5B%22(\d+)%22/);
  return match ? match[1] : null;
}

// The org-top-card's "X employees" link - the only currentCompany-carrying
// link confirmed to exist on a company's own page (see header comment).
function findEmployeesLinkCompanyId() {
  const link = document.querySelector('a[href*="currentCompany=%5B%22"]');
  if (!link) return null;
  const match = link.getAttribute("href").match(/currentCompany=%5B%22(\d+)%22/);
  return match ? match[1] : null;
}

// Loose match tolerating legal-suffix differences ("Swiss Re" vs "Swiss Re
// Ltd") - exact equality would miss too many real companies whose LinkedIn
// page name isn't quite what a research spreadsheet calls them.
//
// Punctuation normalized before comparing (v0.29.39) - reported directly
// with real evidence: "APG|SGA" resolved a real, correct hero card and ID
// (11414625, heroName "APG|SGA AG") but was rejected anyway, because the
// SEARCH term had already replaced the "|" with a space to avoid breaking
// LinkedIn's own search (see stripTrailingCorporateNoise's caller), while
// the hero card's genuine displayed name still has the "|" - "apg sga"
// (space) is a different literal string from "apg|sga ag" (pipe), even
// though they're obviously the same company. This only normalizes pure
// separator punctuation (|, &, comma, period, hyphen) to whitespace - not
// an acronym/fuzzy matcher, and deliberately doesn't touch the BCGE/BCN/BD
// cases (an abbreviation with no shared substring at all, punctuation or
// not) that were correctly left unmatched for a different reason.
//
// Diacritics folded too (v0.29.40) - reported directly with real evidence:
// "Dätwyler" got a real, correct hero card (heroName "Datwyler Group") but
// was rejected, because "dätwyler" and "datwyler group" are different
// literal strings - LinkedIn's own page name drops the umlaut, the research
// name doesn't. Unicode NFD + stripping combining marks turns "ä" into
// plain "a" before comparing, same reasoning as the punctuation fold above.
function foldDiacritics(text) {
  return (text || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Parentheses added to the separator set (v0.29.41) - reported directly with
// real evidence: "Fresenius Kabi (Schweiz)" resolved a real, correct hero
// card (heroName "Fresenius Kabi Schweiz", id 65191466) but was rejected,
// because "(" and ")" weren't in this list - "fresenius kabi (schweiz)"
// isn't a literal substring match against "fresenius kabi schweiz" when the
// "(" sits where a space needs to be. storage.js's own
// normalizeCompanyForMatch already treats () as separator punctuation for
// the same reason elsewhere in this codebase.
// "+" and "/" are separators too, and the German umlaut spellings fold the same way as the umlaut
// itself (1.2 build step 2, first pipeline run): "Kühne + Nagel" never matched LinkedIn's "Kuehne+Nagel".
function normalizeForNameMatch(text) {
  return foldDiacritics((text || "").toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u"))
    .replace(/[|&,.()\-+/]/g, " ")
    .replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(target, hero) {
  if (!target || !hero) return false;
  const a = normalizeForNameMatch(target);
  const b = normalizeForNameMatch(hero);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function collectDiagnostics(extra) {
  return {
    title: document.title,
    url: location.href.split("?")[0],
    ...extra,
  };
}

const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 12; // ~6s, same reasoning as the other extraction content scripts

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The company-page fallback: called instead of the search-page logic below
// when this script finds itself navigated to linkedin.com/company/* - the
// orchestrator only ever sends it here after the search page already
// confirmed a matching hero name, so there's no name to re-check, just the
// id to find (see header comment for where it lives on this page type).
// Wrapped in the same try/catch-and-report-anyway shape as run() below, for
// the same reason (see its own comment).
async function runCompanyPageFallback(expectedName) {
  let companyId = null;
  let caughtError = null;
  try {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      companyId = findEmployeesLinkCompanyId();
      if (companyId) break;
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    caughtError = err?.message || String(err);
  }

  const resolved = Boolean(!caughtError && companyId);
  console.log(`[SalesTeam] company resolve (page fallback) for "${expectedName}": id=${companyId} resolved=${resolved}`, caughtError ? `error=${caughtError}` : "");

  chrome.runtime.sendMessage({
    type: "COMPANY_RESOLVE_RESULT",
    companyName: expectedName,
    resolved,
    linkedinCompanyId: resolved ? companyId : null,
    // This path already runs ON the company's own page, so its own url is the link (2026-09-22) -
    // the same thing applyResolvedCompanyIds needs to fill a missing linkedinLink.
    companyPageUrl: resolved ? location.href : null,
    debug: resolved ? null : { ...collectDiagnostics({ fallbackPage: true, currentCompanyIdFound: companyId }), caughtError },
  });
}

// Reads the company's own displayed name off a company page's <title> -
// every debug sample collected across this feature's whole development has
// shown the exact same shape ("(4) SWICA Versicherungen AG: About |
// LinkedIn", "(1) Aéroport International de Genève-Cointrin: About |
// LinkedIn", etc.): an optional leading "(N)" notification-count badge (not
// part of the name, present or absent depending on the viewer's own account
// state), then the real name, then ": About | LinkedIn". No dedicated name
// element has been confirmed for this page type - this is the only company-
// page name signal actually observed so far, real evidence rather than a
// guessed selector.
function extractCompanyPageTitleName() {
  let title = normalizeText(document.title);
  title = title.replace(/^\(\d+\)\s*/, "");
  title = title.replace(/\s*[:|]?\s*About\s*\|\s*LinkedIn\s*$/i, "");
  title = title.replace(/\s*\|\s*LinkedIn\s*$/i, "");
  return title || null;
}

// v0.29.42, see PRD 6.16: the new primary resolution path - rather than
// searching LinkedIn's own Companies tab and matching a hero card, navigates
// straight to a LinkedIn company-page URL an external cross-check already
// validated (the workbook's new "LinkedIn Link" column) and reads the id
// directly off that page, skipping name-based search entirely for the ~499
// of 500 companies that have one. Distinct from runCompanyPageFallback
// above: that one is only ever reached AFTER a search page already
// confirmed a matching hero name, so it has nothing left to check but the
// id. Arriving here via a supplied link has never had that confirmation -
// the link could be stale, or wrong - so this does its own sanity check
// (the page's own title against every name known for this company) before
// trusting the id, rather than blindly extracting whatever's on the page.
async function runDirectLinkResolve(expectedName, candidateNames) {
  let companyId = null;
  let caughtError = null;
  try {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      companyId = findEmployeesLinkCompanyId();
      if (companyId) break;
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    caughtError = err?.message || String(err);
  }

  const pageName = extractCompanyPageTitleName();
  const nameConfirmed = Boolean(!caughtError && pageName && (candidateNames || []).some((n) => namesMatch(n, pageName)));
  const resolved = Boolean(nameConfirmed && companyId);
  console.log(`[SalesTeam] company resolve (direct link) for "${expectedName}": page="${pageName}" id=${companyId} resolved=${resolved}`, caughtError ? `error=${caughtError}` : "");

  chrome.runtime.sendMessage({
    type: "COMPANY_RESOLVE_RESULT",
    companyName: expectedName,
    resolved,
    linkedinCompanyId: resolved ? companyId : null,
    debug: resolved
      ? null
      : { ...collectDiagnostics({ directLink: true, pageName, currentCompanyIdFound: companyId }), caughtError },
  });
}

// Reported directly: a genuine, reproducible chunk of companies (confirmed
// across three unrelated real names - none sharing the country-qualifier
// issue fixed separately) come back as a hard timeout with NO diagnostic
// info at all (navCompleted: true, nothing else) - meaning no message was
// EVER sent, not that one was sent late. The only way that happens is an
// uncaught exception somewhere in the polling/extraction logic below,
// silently killing this script before it reaches its own sendMessage call -
// previously invisible, and previously cost the full 15s orchestration
// timeout to even notice. Wrapping the whole thing means a real error now
// gets reported immediately, with its actual message attached, instead of
// silently burning the full wait with nothing to show for it.
async function run() {
  const { companyResolveActive, companyResolveTarget, companyResolveDirectLink, companyResolveTargetCandidates } =
    await chrome.storage.local.get([
      "companyResolveActive",
      "companyResolveTarget",
      "companyResolveDirectLink",
      "companyResolveTargetCandidates",
    ]);
  if (!companyResolveActive || !companyResolveTarget) return;

  // Checked before the plain company-page branch below - a direct-link
  // navigation also lands on a linkedin.com/company/* URL, but needs the
  // sanity-checked path (see runDirectLinkResolve's own comment), not the
  // blind extraction runCompanyPageFallback does after a search already
  // confirmed the name.
  if (companyResolveDirectLink) {
    await runDirectLinkResolve(companyResolveTarget, companyResolveTargetCandidates || [companyResolveTarget]);
    return;
  }

  if (location.pathname.startsWith("/company/")) {
    await runCompanyPageFallback(companyResolveTarget);
    return;
  }

  let heroLink = null;
  let heroName = null;
  let companyId = null;
  let caughtError = null;
  try {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      heroLink = findHeroLink();
      heroName = findHeroCompanyName(heroLink);
      companyId = findCurrentCompanyIdWithin(heroLink);
      if (heroName && companyId) break;
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    caughtError = err?.message || String(err);
  }

  const nameConfirmed = Boolean(!caughtError && heroName && namesMatch(companyResolveTarget, heroName));
  const resolved = Boolean(nameConfirmed && companyId);
  // The "Acino" gap: a confident name with no id anywhere on THIS page -
  // hand the orchestrator the hero's own company-page href so it can retry
  // there instead of giving up.
  // Sent on a SUCCESSFUL resolve too, as of 2026-09-22. It used to be gated on !resolved, since a
  // retry url is pointless once the id is in hand - but on a confident match this href IS the
  // company's own LinkedIn page, and accounts imported without a linkedinLink have no other way to
  // get one (applyResolvedCompanyIds fills a MISSING link from it; it never overwrites). The retry
  // branch in company-resolve-extraction.js tests `!resolved && companyPageUrl`, so it is unaffected.
  const companyPageUrl = nameConfirmed && heroLink?.href ? heroLink.href : null;
  console.log(`[SalesTeam] company resolve for "${companyResolveTarget}": hero="${heroName}" id=${companyId} resolved=${resolved}`, caughtError ? `error=${caughtError}` : "");

  chrome.runtime.sendMessage({
    type: "COMPANY_RESOLVE_RESULT",
    companyName: companyResolveTarget,
    resolved,
    linkedinCompanyId: resolved ? companyId : null,
    companyPageUrl,
    // heroLinkFound/heroLinkHref added to tell apart "no hero anchor ever
    // rendered" (genuinely no confident match, or too slow this run) from
    // "hero anchor found, but neither name nor id extracted from within it"
    // (a real extraction bug) - the two look identical from heroName/
    // currentCompanyIdFound alone.
    debug: resolved
      ? null
      : {
          ...collectDiagnostics({ heroName, currentCompanyIdFound: companyId, heroLinkFound: Boolean(heroLink), heroLinkHref: heroLink?.href || null }),
          caughtError,
        },
  });
}

run().catch((err) => {
  // Belt and suspenders: even a failure in run() itself (e.g. the initial
  // storage.local.get call) still reports something rather than leaving the
  // orchestration side to time out with zero information.
  chrome.runtime.sendMessage({
    type: "COMPANY_RESOLVE_RESULT",
    companyName: null,
    resolved: false,
    linkedinCompanyId: null,
    debug: { caughtError: err?.message || String(err), url: location.href.split("?")[0] },
  }).catch(() => {});
});

})();
