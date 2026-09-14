// Runs on an individual LinkedIn profile page (linkedin.com/in/*), scraping
// the person's current employer and stated location - two pieces of data a
// search-results-feed headline often doesn't carry (see PRD 6.3/Dashboard
// "Extract Companies & Locations from Profiles", and 6.14's Location Filter). Only ever
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

// Confirmed against a real profile (2026-09, Bean Blasius): the top card
// shows the current employer as its own badge - a company-page-style icon
// (svg id="company-accent-4", the same generic silhouette used everywhere
// on LinkedIn for an org without a custom logo) next to a plain
// <p><span>Company Name</span></p> - NOT wrapped in a link to a Company
// Page in this case (the badge is a role="button" div instead of an <a>,
// since this employer has no Company Page at all). A sibling badge for the
// person's school uses svg id="school-accent-4" instead, which is how the
// two are told apart (the user reported seeing exactly these two badges
// and suspecting they caused confusion). This renders immediately with the
// top card - unlike Experience, confirmed to be a scroll-triggered lazy
// section on this same profile (a "profile_top_card_experience_lazy_
// anchor_..." marker sits right before it, empty until scrolled into
// view) - so it's tried first, before anything Experience-dependent.
function companyNameFromTopCardBadge() {
  const topCard = document.querySelector("main") || document.body;
  const icon = topCard.querySelector("#company-accent-4");
  if (!icon) return null;
  const badge = icon.closest('[role="button"]') || icon.closest("a");
  if (!badge) return null;
  const span = badge.querySelector("p span") || badge.querySelector("p");
  const text = span ? span.textContent.replace(/\s+/g, " ").trim() : null;
  return text || null;
}

function extractCurrentCompany() {
  const badgeCompany = companyNameFromTopCardBadge();
  if (badgeCompany) return badgeCompany;

  const experience = findExperienceSection();
  if (experience) {
    const entry = experience.querySelector('[componentkey^="entity-collection-item-"]');
    const entryCompany = companyNameFromEntry(entry);
    if (entryCompany) return entryCompany;

    const companyLink = experience.querySelector('a[href*="/company/"]');
    const company = companyNameFromLink(companyLink);
    if (company) return company;
  }

  // Fallback: a company-page link anywhere in the top card - some profiles
  // show the current employer there directly, linked.
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
// Filter, PRD 6.14/6.7). Originally short and Switzerland-biased (this
// project's own primary market) - better to miss an unusual location
// (leaves it unclassified, never touched by the filter) than to
// misidentify unrelated top-card text as one.
// Reported directly: several leads at clearly-Swiss companies (SBB, IMD,
// Syngenta) still had no location extracted. Root cause - a Swiss LinkedIn
// profile very often shows the country/city in German or French, not
// English ("Zürich" not "Zurich," "Genève"/"Genf" not "Geneva," "Luzern" not
// "Lucerne," "Schweiz"/"Suisse" not "Switzerland") - none of which the
// English-only hint words below could ever match, silently, on every single
// visit. Added the native-language spellings actually seen on Swiss
// profiles alongside the English ones (kept in sync with CITY_TO_COUNTRY/
// COUNTRY_ALIASES in storage.js's classifyLocation, so what gets scraped
// here is also what gets correctly classified downstream by the Location
// Filter).
// Separately reported: "Nashville Metropolitan Area" (a real lead's actual
// profile text) has no country name in it at all - the same "Greater X
// Area" phrasing already handled for Switzerland's own major cities, just
// never extended past Switzerland. Added a modest set of other major metros
// a B2B tech/AI lead is likely to be based in - deliberately not an attempt
// at exhaustive world city coverage, same trade-off as the Swiss list.
//
// Country list below was a small hand-picked subset until this point, which
// kept causing exactly this class of bug one country at a time (Israel was
// the latest reported miss - "Atlit, Haifa District, Israel" - after
// India/UAE/Canada/New York, which WERE already recognized, also came back
// empty, pointing at the scrape-wait bug above as the bigger culprit, but
// Israel specifically was a real, separate gap). Replaced with the FULL
// country list storage.js's classifyLocation already recognizes (kept as a
// literal, manually-mirrored copy - content scripts can't import storage.js
// as an ES module, and duplicating the exact same source in an
// unregistered file was allowed to drift once already) so a country gap in
// one can no longer exist without the other having it too.
const LOCATION_HINT_WORDS = [
  // Aliases/native spellings that aren't already literal country names below.
  "schweiz", "suisse", "svizzera", "ch", "usa", "uk", "uae",
  // Full country list, mirroring storage.js's CONTINENT_COUNTRIES exactly.
  "united states", "canada",
  "mexico", "guatemala", "belize", "honduras", "el salvador", "nicaragua", "costa rica", "panama",
  "cuba", "dominican republic", "haiti", "jamaica", "trinidad and tobago", "bahamas", "barbados",
  "colombia", "venezuela", "ecuador", "peru", "brazil", "bolivia", "paraguay", "chile", "argentina",
  "uruguay", "guyana", "suriname",
  "united kingdom", "switzerland", "germany", "france", "italy", "spain", "portugal", "netherlands",
  "belgium", "luxembourg", "ireland", "austria", "sweden", "norway", "denmark", "finland", "iceland",
  "poland", "czech republic", "slovakia", "hungary", "romania", "bulgaria", "greece", "croatia",
  "slovenia", "serbia", "bosnia and herzegovina", "montenegro", "north macedonia", "albania", "kosovo",
  "estonia", "latvia", "lithuania", "ukraine", "belarus", "moldova", "malta", "cyprus", "liechtenstein",
  "monaco", "san marino", "andorra", "russia",
  "nigeria", "egypt", "south africa", "kenya", "morocco", "algeria", "tunisia", "libya", "ethiopia",
  "ghana", "tanzania", "uganda", "angola", "mozambique", "cameroon", "ivory coast", "senegal",
  "zimbabwe", "zambia", "rwanda", "botswana", "namibia", "mali", "niger", "chad", "sudan",
  "south sudan", "somalia", "madagascar", "malawi", "burkina faso", "benin", "togo", "sierra leone",
  "liberia", "mauritius", "gabon", "congo", "democratic republic of the congo", "guinea", "eritrea",
  "djibouti", "lesotho", "eswatini", "gambia", "burundi", "central african republic",
  "saudi arabia", "united arab emirates", "qatar", "kuwait", "bahrain", "oman", "yemen", "iraq",
  "iran", "israel", "jordan", "lebanon", "syria", "palestine", "turkey",
  "indonesia", "malaysia", "thailand", "vietnam", "philippines", "myanmar", "cambodia", "laos",
  "brunei", "timor-leste", "india", "pakistan", "bangladesh", "sri lanka", "nepal", "bhutan",
  "maldives", "afghanistan", "china", "japan", "south korea", "north korea", "taiwan", "hong kong",
  "mongolia", "macau", "kazakhstan", "uzbekistan", "turkmenistan", "kyrgyzstan", "tajikistan",
  "australia", "new zealand", "papua new guinea", "fiji", "singapore",
  // Swiss cities - includes German/French names actually seen on Swiss profiles.
  "zurich", "zürich", "geneva", "genève", "genf", "basel", "bern", "lausanne", "lucerne", "luzern",
  "winterthur", "st. gallen", "st gallen", "sankt gallen", "lugano", "zug",
  // Other major metros commonly shown as just "X Metropolitan Area"/"Greater X Area," no country named.
  "new york", "los angeles", "chicago", "san francisco", "nashville", "seattle", "austin", "boston",
  "dallas", "houston", "atlanta", "denver", "miami", "washington", "philadelphia", "phoenix",
  "san diego", "portland", "minneapolis", "detroit", "london", "manchester", "toronto", "vancouver",
  "montreal",
];

// "ch" (Switzerland's ISO country code, e.g. "Zürich, CH") is too short to
// safely plain-substring-match - it'd also match inside "which," "search,"
// "chief," and any other everyday word containing those two letters, which
// this project's whole design philosophy for this heuristic explicitly
// warns against (better to miss a location than misidentify unrelated text
// as one). Whole-word matching (the same `\b`-anchored approach storage.js's
// containsWholeWord already uses) is what makes "ch" safe to include at all.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeWord(haystackLower, word) {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(haystackLower);
}

function looksLikeLocation(text) {
  if (!text || text.length > 100) return false;
  const lower = text.toLowerCase();
  return LOCATION_HINT_WORDS.some((w) => containsWholeWord(lower, w));
}

// Confirmed against a real profile's raw HTML (2026-09, Allie K. Miller):
// the top card's location text isn't identified by its CONTENT at all - it's
// structurally the first paragraph in a small row that always also contains
// the "Contact info" overlay link:
// <div><p>New York, United States</p><p>·</p><p><a href=".../overlay/
// contact-info/">Contact info</a></p></div>. That link is a stable,
// semantic, always-present feature of every profile's top card, regardless
// of language or how obscure the location text is - a far more durable
// anchor than any keyword list, and the reason this is tried FIRST, ahead of
// the keyword-scan fallback below. Reported directly after several rounds
// of "one more country/city missing" reports (Nashville, Bengaluru, Dubai,
// Israel...) that kept recurring no matter how large the word list grew -
// this removes the dependency on recognizing the text at all for the common
// case.
// A bare domain, e.g. "jobs.sbb.ch" or "example.com" - no spaces, at least
// one dot, nothing but word characters/hyphens/dots. Real location text
// never looks like this.
function looksLikeUrlOrDomain(text) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(text);
}

// Whole-word institution names - "University of Toronto" etc. Real location
// text never names an institution.
const NON_LOCATION_INSTITUTION_WORDS = [
  "university", "universität", "université", "universidad", "institute", "college", "hochschule", "école",
];

// Reported directly with several real examples on profiles with no Location
// filled in on LinkedIn: the position-only heuristic below picked up a
// website ("jobs.sbb.ch"), the person's own name, their full headline/
// tagline ("Assistant Professor of... | Rhodes Scholar | ..."), an education
// institution ("University of Toronto"), and a past job description ("SAS
// Japan - Sales Manager｜Insurence") - none of them a location. A real
// location line is always short and never contains a headline's "|"/"｜"
// separators, so these checks catch what the positional anchor alone can't,
// same "report nothing rather than something wrong" philosophy as the
// keyword-scan fallback below.
function looksLikeInvalidLocationText(text) {
  if (text.length > 60) return true;
  if (/[|｜]/.test(text)) return true;
  if (looksLikeUrlOrDomain(text)) return true;
  const lower = text.toLowerCase();
  if (NON_LOCATION_INSTITUTION_WORDS.some((w) => containsWholeWord(lower, w))) return true;
  const nameHeading = document.querySelector("h1");
  if (nameHeading && text === nameHeading.textContent.replace(/\s+/g, " ").trim()) return true;
  return false;
}

function personLocationFromContactInfoRow() {
  const contactInfoLink = document.querySelector('a[href*="/overlay/contact-info/"]');
  if (!contactInfoLink) return null;
  const containerP = contactInfoLink.closest("p");
  const container = containerP ? containerP.parentElement : null;
  const firstChild = container ? container.firstElementChild : null;
  if (!firstChild || firstChild === containerP) return null;
  const text = firstChild.textContent.replace(/\s+/g, " ").trim();
  if (!text || text === "·") return null;
  if (looksLikeInvalidLocationText(text)) return null;
  return text;
}

// Location text lives in the profile's top card, directly under the name/
// headline - restricting the search to elements BEFORE the Experience
// section (rather than the whole page) avoids matching an unrelated country/
// city mention buried in someone's Experience or About text instead. Checks
// each element's own direct text (not a large container's full combined
// text) so it lands on the actual short location line, not some ancestor
// wrapping half the page. Never guesses - returns null if nothing in the
// top card looks like a location. Only reached if the structural
// "Contact info" row above wasn't found - a layout LinkedIn hasn't been
// checked against yet.
function extractPersonLocation() {
  const structural = personLocationFromContactInfoRow();
  if (structural) return structural;

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
  const topCard = document.querySelector("main") || document.body;
  // Reported directly: this bundle predates the v0.29.15 structural rewrite
  // (personLocationFromContactInfoRow/companyNameFromTopCardBadge) and only
  // ever checked the OLD Experience-section/company-link signals - useless
  // for diagnosing a profile where those still-current, PRIMARY extractors
  // are the ones failing. Added the actual signals those two functions rely
  // on, so a failure sample can show whether the "Contact info" link or the
  // company badge were even found at all, not just the fallback path's state.
  const contactInfoLink = document.querySelector('a[href*="/overlay/contact-info/"]');
  return {
    title: document.title,
    url: location.href.split("?")[0],
    headings: Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 8).map((h) => h.textContent.trim()),
    contactInfoLinkFound: Boolean(contactInfoLink),
    contactInfoRowText: contactInfoLink
      ? (contactInfoLink.closest("p")?.parentElement?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200)
      : null,
    companyBadgeIconFound: Boolean(topCard.querySelector("#company-accent-4")),
    companyBadgeText: (() => {
      const icon = topCard.querySelector("#company-accent-4");
      const badge = icon && (icon.closest('[role="button"]') || icon.closest("a"));
      const span = badge && (badge.querySelector("p span") || badge.querySelector("p"));
      return span ? span.textContent.replace(/\s+/g, " ").trim() : null;
    })(),
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
  // Reported directly with a real profile (andreasbezner) whose location
  // plainly says "Switzerland" - a word this extractor has always
  // recognized - yet the lead's location still came back empty. Root cause:
  // this loop used to stop polling the moment EITHER field was found. Since
  // v0.29.10 made company resolve almost instantly (the top-card badge
  // renders immediately, unlike the lazy-loaded Experience section), the
  // loop now exits on the very first attempt on most profiles the moment
  // company is found - before location, which can render a beat later, ever
  // gets a real chance across the remaining ~5.5s of attempts. Now waits for
  // BOTH before stopping early, so a company hit no longer cuts location's
  // polling window short.
  let company = null;
  let personLocation = null;
  for (let attempt = 0; attempt < EXTRACTION_POLL_MAX_ATTEMPTS; attempt++) {
    company = extractCurrentCompany();
    personLocation = extractPersonLocation();
    if (company && personLocation) break;
    await sleep(EXTRACTION_POLL_INTERVAL_MS);
  }
  console.log(`[SalesTeam] profile scrape at ${location.href}: company=`, company, "location=", personLocation);

  chrome.runtime.sendMessage({
    type: "PROFILE_SCRAPE_RESULT",
    profileUrl: location.href.split("?")[0],
    company,
    location: personLocation,
    // Reported directly: a real lead (Roland Markowski) got a company but no
    // location - a partial miss this only ever diagnosed when BOTH fields
    // came back empty, so this exact case produced no debug sample at all.
    // Widened to fire whenever either field is still missing.
    debug: (!company || !personLocation) ? collectDiagnostics() : null,
  });
}

run();
