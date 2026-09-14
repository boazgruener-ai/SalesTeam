// Runs on a LinkedIn People Search results page
// (linkedin.com/search/results/people/*) - EXPERIMENTAL, see PRD 6.15 and
// people-search-extraction.js. Only ever active during an explicit,
// user-triggered comparison run (people-search-extraction.js sets
// peopleSearchExtractionActive and a peopleSearchTarget before navigating
// here) - does nothing during normal browsing, same gating pattern as
// profile-content-script.js.
//
// NOTE ON SELECTORS (unverified against a live search results page at write
// time): built from a screenshot the user shared of a real, Switzerland-
// filtered People Search, not real HTML - the same situation
// profile-content-script.js started in (see its own header comment), which
// took many rounds of live-evidence fixes to get right. This is expected to
// need the same kind of tuning once run against a real page; the diagnostic
// bundle below exists specifically so that can happen from the Activity Log
// instead of guessing blind a second time.
//
// Approach: anchor on the one thing certain to be stable regardless of
// LinkedIn's hashed class names - every result card contains a link to that
// person's own profile (a[href*="/in/"]). For each such link, this walks up
// to a containing block and reads its visible text lines in order, expecting
// roughly: [name, headline, location, "Current: ... at Company", mutual-
// connections line]. Matches the FIRST result whose name is an exact match
// (case/whitespace-insensitive) for the target author AND whose headline is
// a close match to the target's own known headline (word-overlap check) -
// never guesses at a same-named stranger.

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

// A handful of UI chrome strings that show up as their own text block inside
// a result card but are never the name/headline/location - filtered out so
// they don't get mistaken for one of those three lines.
const CARD_NOISE_PATTERNS = [
  /^message$/i, /^connect$/i, /^follow(ing)?$/i, /^pending$/i, /^view .* profile$/i,
  /mutual connection/i, /^\d+(st|nd|rd|th)?\+?$/i, /followers$/i, /^skills:/i, /^current:/i,
];

function isNoiseLine(text) {
  return CARD_NOISE_PATTERNS.some((re) => re.test(text));
}

// Word-overlap heuristic - no fuzzy-matching library, just a plain fraction
// of significant (4+ letter) words shared between the two headlines, so a
// same-named stranger with an unrelated headline doesn't get treated as a
// match. Threshold picked to tolerate minor wording drift between when the
// post was scraped and when this search runs, not to be a strict diff.
function headlineSimilarity(a, b) {
  const words = (text) => new Set((text || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

const HEADLINE_MATCH_THRESHOLD = 0.4;

// Walks up from a profile-link anchor to find its enclosing result-card
// container - stops as soon as an ancestor's own text is meaningfully larger
// than the link's (i.e. it now includes the headline/location/etc, not just
// the name), capped so a malformed page can't walk all the way to <body>.
function findCardContainer(anchor) {
  let node = anchor;
  const anchorTextLen = normalizeText(anchor.textContent).length;
  for (let i = 0; i < 8 && node.parentElement; i++) {
    node = node.parentElement;
    if (normalizeText(node.textContent).length > anchorTextLen + 20) return node;
  }
  return node;
}

// Every distinct, non-empty, non-noise text line inside a card, in DOM
// order - the closest thing to "what a person visually reads top to bottom"
// obtainable without knowing LinkedIn's real element structure.
function cardTextLines(container) {
  const lines = [];
  const seen = new Set();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node) {
    const hasElementChildWithText = Array.from(node.children).some((c) => normalizeText(c.textContent));
    if (!hasElementChildWithText) {
      const text = normalizeText(node.textContent);
      if (text && text.length <= 300 && !isNoiseLine(text) && !seen.has(text)) {
        seen.add(text);
        lines.push(text);
      }
    }
    node = walker.nextNode();
  }
  return lines;
}

// A short line naming Switzerland (or a Swiss canton/major city) or shaped
// like "City, Region, Country" - deliberately narrow, since every candidate
// here already came from a Switzerland-filtered search, so most genuine
// location lines will say so directly. Not the project's full classifier
// (storage.js's classifyLocation) - just enough to pick the right line out
// of the card's other text.
function looksLikeLocationLine(text) {
  if (!text || text.length > 60) return false;
  if (/switzerland|schweiz|suisse|svizzera/i.test(text)) return true;
  return text.split(",").length >= 2;
}

function companyFromCurrentLine(line) {
  if (!line) return null;
  const afterLabel = line.replace(/^current:\s*/i, "");
  const idx = afterLabel.lastIndexOf(" at ");
  if (idx === -1) return null;
  const company = afterLabel.slice(idx + 4).trim();
  return company || null;
}

function collectDiagnostics(candidateCount) {
  return {
    title: document.title,
    url: location.href.split("?")[0],
    candidateCardsFound: candidateCount,
    headings: Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 5).map((h) => normalizeText(h.textContent)),
  };
}

const SEARCH_POLL_INTERVAL_MS = 500;
const SEARCH_POLL_MAX_ATTEMPTS = 12; // ~6s, same reasoning as profile-content-script.js

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findBestMatch(targetName, targetHeadline) {
  const anchors = Array.from(document.querySelectorAll('a[href*="/in/"]'));
  const normalizedTarget = normalizeText(targetName).toLowerCase();
  let candidateCount = 0;
  for (const anchor of anchors) {
    const anchorName = normalizeText(anchor.textContent);
    if (!anchorName || anchorName.toLowerCase() !== normalizedTarget) continue;
    candidateCount++;
    const container = findCardContainer(anchor);
    const lines = cardTextLines(container);
    const currentLineIndex = lines.findIndex((l) => /^current:/i.test(l) || / at /i.test(l) && l.length < 150);
    // The line most likely to be the headline: the first substantial line
    // that isn't the name itself, isn't a location, and isn't the "Current:"
    // employer line.
    const headlineLine = lines.find((l) => l !== anchorName && !looksLikeLocationLine(l) && !/^current:/i.test(l));
    if (headlineSimilarity(targetHeadline, headlineLine) < HEADLINE_MATCH_THRESHOLD) continue;
    const locationLine = lines.find((l) => looksLikeLocationLine(l)) || null;
    const rawCurrentLine = currentLineIndex >= 0 ? lines[currentLineIndex] : lines.find((l) => /^current:/i.test(l));
    return { matched: true, location: locationLine, company: companyFromCurrentLine(rawCurrentLine), candidateCount };
  }
  return { matched: false, location: null, company: null, candidateCount };
}

async function run() {
  const { peopleSearchExtractionActive, peopleSearchTarget } =
    await chrome.storage.local.get(["peopleSearchExtractionActive", "peopleSearchTarget"]);
  if (!peopleSearchExtractionActive || !peopleSearchTarget) return;

  const { authorName, headline } = peopleSearchTarget;
  let result = { matched: false, location: null, company: null, candidateCount: 0 };
  for (let attempt = 0; attempt < SEARCH_POLL_MAX_ATTEMPTS; attempt++) {
    result = findBestMatch(authorName, headline);
    if (result.matched) break;
    await sleep(SEARCH_POLL_INTERVAL_MS);
  }
  console.log(`[SalesTeam] people search lookup for "${authorName}":`, result);

  chrome.runtime.sendMessage({
    type: "PEOPLE_SEARCH_RESULT",
    authorName,
    matched: result.matched,
    location: result.location,
    company: result.company,
    debug: result.matched ? null : collectDiagnostics(result.candidateCount),
  });
}

run();
