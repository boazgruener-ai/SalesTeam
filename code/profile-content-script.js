// Runs on an individual LinkedIn profile page (linkedin.com/in/*), scraping
// the person's current employer and stated location - two pieces of data a
// search-results-feed headline often doesn't carry (see PRD 6.3/Dashboard
// "Extract Companies from Profiles", and 6.14's Location Filter). Only ever
// active during an explicit, user-triggered extraction run (dashboard.js
// sets profileExtractionActive before navigating here) - this deliberately
// does nothing during normal browsing, so visiting a LinkedIn profile is
// never silently scraped.
//
// NOTE ON SELECTORS (unverified against a live profile at write time - see
// PRD 6.3): same durable-marker philosophy as content-script.js (hashed
// class names aren't stable hooks), but this file's exact selectors
// couldn't be checked against a real, logged-in LinkedIn session while
// building this. If it comes back empty/wrong on a real profile, that's the
// expected first thing to debug - inspect a live profile page and update
// the extractors below, the same maintenance path content-script.js already
// documents for itself.
//
// Approach: LinkedIn's profile sections carry a stable `id` attribute (used
// for its own in-page deep-linking, e.g. a URL ending in "#experience") -
// this looks for id="experience" as the anchor, then the first link to a
// Company Page (an <a href> containing "/company/") within it, since
// experience entries are listed most-recent-first and a link to a real
// Company Page is a durable, semantic marker regardless of surrounding
// class names. Falls back to the same kind of link anywhere in the page's
// top card (near the name/headline) if the Experience section isn't found
// or has no such link. Never guesses - returns null rather than a wrong name
// if neither is found.

// Confirmed against a real profile's Experience entry (2026-09): the
// company-page link wraps BOTH lines of the entry, e.g.
// <a href=".../company/123/"><p>Data Analyst</p><p>The Bank of Punjab ·
// Full-time</p></a> - so anchor.textContent alone returns the title and
// company concatenated ("Data AnalystThe Bank of Punjab · Full-time"). The
// company sits in the entry's SECOND <p>, itself suffixed with
// " · Full-time"/"· Part-time"/etc., which this strips.
function companyNameFromLink(anchor) {
  if (!anchor) return null;
  const paragraphs = anchor.querySelectorAll("p");
  const companyLine = paragraphs.length >= 2 ? paragraphs[1].textContent : anchor.textContent;
  const text = companyLine.split("·")[0].replace(/\s+/g, " ").trim();
  return text || null;
}

// Anchors on the literal "Experience" heading text rather than guessing at
// ids/classes - confirmed against a real profile (2026-09) that this
// section's own container has no plain id="experience" anymore (LinkedIn's
// newer Ember/"SDUI" profile rendering uses long generated ids instead,
// e.g. "...ExperienceTopLevelSection"); a heading whose own displayed text
// is "Experience" is far less likely to change than any id/class scheme.
// Falls back to the old id-substring guess in case a given profile variant
// still uses it.
function findExperienceSection() {
  const heading = Array.from(document.querySelectorAll("h1, h2, h3")).find(
    (h) => h.textContent.trim().toLowerCase() === "experience"
  );
  if (heading) {
    const section = heading.closest("section");
    if (section) return section;
  }
  return document.getElementById("experience") || document.querySelector('[id*="experience" i]');
}

// Each Experience list entry (confirmed against a real profile, 2026-09) is
// wrapped in an element carrying componentkey="entity-collection-item-...",
// REGARDLESS of whether the company itself is linked to a Company Page -
// e.g. a person's employer that has no LinkedIn Company Page at all still
// renders as the same <p>Title</p><p>Company · Type</p> pair inside one of
// these, just without the wrapping <a href="/company/...">. The earlier,
// link-only selector only ever found a company for someone whose employer
// happens to have a Company Page - which a real run confirmed is a small
// minority (5 of 55) - so this reads the entry structurally first and only
// falls back to the link-only approach for a profile variant that doesn't
// use this markup at all.
function companyNameFromEntry(entry) {
  if (!entry) return null;
  const paragraphs = entry.querySelectorAll("p");
  if (paragraphs.length < 2) return null;
  const text = paragraphs[1].textContent.split("·")[0].replace(/\s+/g, " ").trim();
  return text || null;
}

function extractCurrentCompany() {
  const experience = findExperienceSection();
  if (experience) {
    const entry = experience.querySelector('[componentkey^="entity-collection-item-"]');
    const entryCompany = companyNameFromEntry(entry);
    if (entryCompany) return entryCompany;

    const companyLink = experience.querySelector('a[href*="/company/"]');
    const company = companyNameFromLink(companyLink);
    if (company) return company;
  }

  // Fallback: a company-page link near the top of the page (top card) -
  // some profiles show the current employer there directly.
  const topCard = document.querySelector("main") || document.body;
  const topCandidates = Array.from(topCard.querySelectorAll('a[href*="/company/"]')).slice(0, 3);
  for (const anchor of topCandidates) {
    const company = companyNameFromLink(anchor);
    if (company) return company;
  }

  return null;
}

// A small, LOCAL list just for spotting plausible location text on the page
// - NOT the full classification authority (that's classifyLocation in
// storage.js, applied later once this raw string reaches the Location
// Filter, PRD 6.14/6.7). Deliberately short and Switzerland-biased (this
// project's own primary market) - better to miss an unusual location
// (leaves it unclassified, never touched by the filter) than to
// misidentify unrelated top-card text as one.
const LOCATION_HINT_WORDS = [
  "switzerland", "united states", "united kingdom", "germany", "france", "italy", "spain", "india",
  "pakistan", "canada", "australia", "netherlands", "poland", "brazil", "mexico", "china", "japan",
  "singapore", "uae", "united arab emirates", "ireland", "sweden", "austria", "belgium", "portugal",
  "zurich", "geneva", "basel", "bern", "lausanne", "lucerne", "winterthur", "st. gallen", "lugano", "zug",
];

function looksLikeLocation(text) {
  if (!text || text.length > 100) return false;
  const lower = text.toLowerCase();
  return LOCATION_HINT_WORDS.some((w) => lower.includes(w));
}

// Location text lives in the profile's top card, directly under the name/
// headline - restricting the search to elements BEFORE the Experience
// section (rather than the whole page) avoids matching an unrelated country/
// city mention buried in someone's Experience or About text instead. Checks
// each element's own direct text (not a large container's full combined
// text) so it lands on the actual short location line, not some ancestor
// wrapping half the page. Never guesses - returns null if nothing in the
// top card looks like a location.
function extractPersonLocation() {
  const experience = findExperienceSection();
  const topCard = document.querySelector("main") || document.body;

  for (const el of topCard.querySelectorAll("span, div, li")) {
    if (experience && (experience.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent.trim())
      .join(" ")
      .trim();
    if (looksLikeLocation(ownText)) return ownText;
  }
  return null;
}

// A small diagnostic bundle attached only when extraction still finds
// nothing after the poll below - lets the run be diagnosed from the
// Activity Log (dashboard.js/sidepanel.js collect a few of these) instead
// of needing to catch a background tab's live DevTools console during a
// fast, unattended multi-profile run.
function collectDiagnostics() {
  const experience = findExperienceSection();
  return {
    title: document.title,
    url: location.href.split("?")[0],
    headings: Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 8).map((h) => h.textContent.trim()),
    experienceSectionFound: Boolean(experience),
    entryCount: experience ? experience.querySelectorAll('[componentkey^="entity-collection-item-"]').length : 0,
    anyCompanyLinkOnPage: Boolean(document.querySelector('a[href*="/company/"]')),
  };
}

const EXTRACTION_POLL_INTERVAL_MS = 500;
const EXTRACTION_POLL_MAX_ATTEMPTS = 12; // ~6s total - see run()'s comment for why this exists.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const { profileExtractionActive } = await chrome.storage.local.get("profileExtractionActive");
  if (!profileExtractionActive) return; // Not part of an active, user-triggered run; do nothing.

  // LinkedIn's current profile page (Ember/"Voyager", goober CSS-in-JS, no
  // static markup - see this page's own <head>) renders its content
  // client-side, in pieces, after the initial page load event - the event
  // `run_at: "document_idle"` fires on. Confirmed live: a run against 20
  // real profiles returned 0 companies even for a profile independently
  // confirmed to show one, which points at this timing gap rather than the
  // selectors themselves. Polls for the Experience section (or a location
  // candidate) to actually exist before giving up, rather than trusting a
  // single snapshot taken too early.
  let company = null;
  let personLocation = null;
  for (let attempt = 0; attempt < EXTRACTION_POLL_MAX_ATTEMPTS; attempt++) {
    company = extractCurrentCompany();
    personLocation = extractPersonLocation();
    if (company || personLocation) break;
    await sleep(EXTRACTION_POLL_INTERVAL_MS);
  }
  console.log(`[SalesTeam] profile scrape at ${location.href}: company=`, company, "location=", personLocation);

  chrome.runtime.sendMessage({
    type: "PROFILE_SCRAPE_RESULT",
    profileUrl: location.href.split("?")[0],
    company,
    location: personLocation,
    debug: (!company && !personLocation) ? collectDiagnostics() : null,
  });
}

run();
