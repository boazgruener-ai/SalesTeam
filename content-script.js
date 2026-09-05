// Runs on LinkedIn's post-content search results page. Reads which topic is
// currently being scanned from storage (set by background.js immediately
// before it navigated here), scrapes the visible post cards, and reports
// them back to the background script.
//
// NOTE ON SELECTORS: LinkedIn's CSS class names are auto-generated/hashed
// (e.g. "_42fbde90") and are NOT usable as stable hooks — they can change on
// every deploy. Instead this relies on more durable markers found by
// inspecting a live post card:
//   - every real post (not ads) has a visually-hidden <h2>Feed post</h2>
//     label, used here as the card boundary.
//   - the post's own text lives in an element with data-testid="expandable-
//     text-box".
//   - the author's name is recoverable from their avatar image's
//     alt="View {Name}'s profile" text.
// This assumes an English-language LinkedIn UI ("Feed post" is localized).
// If scraping stops working, re-run the live-page inspection to find what
// changed and update the constants/extractors below.

const FEED_POST_LABEL = "Feed post";
const MAX_WAIT_MS = 8000;
const POLL_INTERVAL_MS = 300;
const MAX_SCROLL_PASSES = 15;
// Used for an AND-topic's two independent concept-only/activity-only
// searches (background.js's currentScanDeepScroll) - each is a broader,
// single-constraint search than the old combined query, so a real
// double-match needs a bigger scraped pool to have a chance of surviving
// the client-side intersection. Still bounded by STAGNANT_PASSES_TO_STOP,
// so this only takes longer when there's genuinely more content to load.
const DEEP_MAX_SCROLL_PASSES = 30;
const STAGNANT_PASSES_TO_STOP = 2;
const SCROLL_PAUSE_MS = 1500;

function findCards() {
  const headers = Array.from(document.querySelectorAll("h2")).filter(
    (h) => h.textContent.trim() === FEED_POST_LABEL
  );
  return headers
    .map((h) => h.closest('[data-display-contents="true"]') || h.parentElement?.parentElement)
    .filter(Boolean);
}

function waitForCards() {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const cards = findCards();
      if (cards.length > 0 || Date.now() - start > MAX_WAIT_MS) {
        clearInterval(interval);
        resolve(cards);
      }
    }, POLL_INTERVAL_MS);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ties the author's name and profile URL to the exact same avatar element,
// rather than matching them independently, so a company page or a mentioned
// third party elsewhere in the card can't get mismatched in as the "author".
// A company/organization page's avatar alt text reads "...'s page" rather
// than "...'s profile", so this also naturally excludes company-authored
// posts - useful since a salesperson wants an individual to contact, not a
// page.
function extractAuthor(card) {
  const avatarImg = card.querySelector('img[alt^="View "]');
  if (!avatarImg) return null;

  const match = avatarImg.alt.match(/^View (.+?)(?:’|')s profile$/);
  if (!match) return null;

  const anchor = avatarImg.closest('a[href*="/in/"]');
  if (!anchor) return null;

  return { name: match[1], profileUrl: anchor.href.split("?")[0], anchor };
}

// LinkedIn shows a "1st"/"2nd"/"3rd+" connection-degree badge next to the
// author's name, e.g. "Matthew Laird, MSN, PMHNP-BC • 3rd+" - used to pick a
// warmer or cooler message-drafting template for a lead. Confirmed via live
// inspection: every ancestor element here carries a data-view-name="null"
// attribute (a literal string, not an absent attribute) all the way up, so
// an attribute-selector scope search matches the anchor itself immediately
// and always comes back empty. Walking up plain parentElement links to the
// first ancestor with non-empty text (same technique as extractHeadline)
// lands on the header line containing name + degree + headline + timestamp.
function extractConnectionDegree(anchor) {
  let el = anchor;
  for (let i = 0; i < 6 && el; i++) {
    const text = el.textContent.trim();
    if (text) {
      const match = text.match(/\b(1st|2nd|3rd)\b/);
      return match ? match[1] : null;
    }
    el = el.parentElement;
  }
  return null;
}

// Posts with an embedded job listing are recruiter ads rather than someone
// personally expressing interest - but a company running AI job ads is
// itself a signal they're investing in AI, which can be a useful lead too.
// Whether to include them is a user setting (isJobAd tags them either way
// so they stay visually distinct from "person expressing interest" leads).
function hasEmbeddedJobListing(card) {
  return Boolean(card.querySelector('a[href*="/jobs/view/"]'));
}

function visibilityContainer(card) {
  const visibilityIcon = Array.from(card.querySelectorAll("svg")).find((svg) =>
    (svg.getAttribute("aria-label") || "").startsWith("Visibility")
  );
  return visibilityIcon?.closest("p") || null;
}

function extractTimestamp(card) {
  const container = visibilityContainer(card);
  if (!container) return "";
  const match = container.textContent.match(/^\s*([\w\d]+)\s*•/);
  return match ? match[1] : "";
}

// Some profiles show an extra "featured link" row (e.g. "Book an
// appointment", "View my newsletter") between the real headline and the
// timestamp - this is just that link's caption, not the person's headline.
function isJustALinkCaption(el) {
  const anchor = el.tagName === "A" ? el : el.querySelector("a");
  if (!anchor) return false;
  const anchorText = anchor.textContent.trim();
  return anchorText.length > 0 && anchorText === el.textContent.trim();
}

// The author's headline/bio (e.g. "CTO at Katoen Natie") sits in a sibling
// block just above the timestamp, sharing the timestamp's wrapper structure
// with an occasional empty spacer div (and occasionally a featured-link row)
// in between. Shown on each result card for extra context, and used by the
// location/title filters below.
function extractHeadline(card) {
  const timestampContainer = visibilityContainer(card);
  let sibling = timestampContainer?.parentElement?.previousElementSibling;
  while (sibling) {
    const text = sibling.textContent.trim();
    if (text && !isJustALinkCaption(sibling)) return text;
    sibling = sibling.previousElementSibling;
  }
  return "";
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word match, not raw substring - a naive .includes() on a short
// keyword like "AI" also matches inside unrelated words (e.g. "AljurAId"),
// which is a real false-positive source for 2-3 letter terms.
function containsWholeWord(haystackLower, keyword) {
  return new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`, "i").test(haystackLower);
}

// Best-effort only: LinkedIn's search can match a post semantically without
// it literally containing any searched term, so this can legitimately come
// back empty even for a real match - it's meant to help a user (and us,
// when debugging) sanity-check *why* a result showed up, not as a guarantee.
function findMatchingKeywords(searchedKeywords, text) {
  const haystack = text.toLowerCase();
  return searchedKeywords.filter((kw) => containsWholeWord(haystack, kw));
}

// Author-title filter is applied here against the already-scraped headline,
// rather than sent to LinkedIn as a query parameter - LinkedIn's search
// silently breaks past a small total-term budget shared across the whole
// query (confirmed: 9 terms works, 10 doesn't), so folding it into the query
// meant constantly fighting that limit. This is approximate rather than
// LinkedIn's fuller server-side profile match, but it never competes for
// that budget, so topic keywords can always use the full per-search limit.
// (Location is instead handled by putting location terms in a topic's own
// "AND with" group, which goes through LinkedIn's real query - see the
// side panel's Topics section.)
function matchesFilter(text, filterKeywords) {
  if (!filterKeywords || filterKeywords.length === 0) return true;
  const haystack = text.toLowerCase();
  return filterKeywords.some((kw) => containsWholeWord(haystack, kw));
}

// Plain-text hiring/recruiting posts don't use LinkedIn's structured job
// widget (so hasEmbeddedJobListing misses them entirely), but they're a
// distinct signal worth flagging separately from a genuine opinion/interest
// post. Freelance/contract language is its own sub-flag - a company looking
// to outsource work is a different (arguably more relevant, for a services
// pitch) signal than one hiring in-house.
const HIRING_PHRASES = [
  "we're hiring",
  "we are hiring",
  "now hiring",
  "hiring now",
  "join our team",
  "send your cv",
  "send your resume",
  "walk-in interview",
  "we're looking for",
  "we are looking for",
  "looking for a passionate",
  "looking for an experienced",
  "looking for skilled",
];

const FREELANCE_PHRASES = [
  "freelance",
  "freelancer",
  "ongoing contract",
  "contract work",
  "dm me with your portfolio",
  "send your portfolio",
  "your portfolio",
  "turnaround time",
];

function containsAnyPhrase(text, phrases) {
  const haystack = text.toLowerCase();
  return phrases.some((phrase) => haystack.includes(phrase));
}

function extractPost(card, rank, searchedKeywords, authorTitles, includeJobAds) {
  try {
    const isJobAd = hasEmbeddedJobListing(card);
    if (isJobAd && !includeJobAds) return null;

    const authorInfo = extractAuthor(card);
    if (!authorInfo) return null; // no individual author found (e.g. a company page post)

    const snippet = card.querySelector('[data-testid="expandable-text-box"]')?.textContent.trim() || "";
    const timestampText = extractTimestamp(card);
    const headline = extractHeadline(card);

    if (!matchesFilter(headline, authorTitles)) {
      return null;
    }

    // LinkedIn doesn't expose a plain link to the exact post in the static
    // page (only to the author's profile) - the real permalink is only
    // generated on-click via the "..." menu's "Copy link to post" action.
    // Rather than simulate that click per post, we leave postUrl empty and
    // key/dedupe on profile + snippet instead of a post-specific URL.
    const postLinkEl = card.querySelector('a[href*="/feed/update/"], a[href*="/posts/"]');
    const postUrl = postLinkEl ? postLinkEl.href.split("?")[0] : "";

    if (!snippet) return null;

    const key = postUrl || `${authorInfo.profileUrl}::${snippet.slice(0, 80)}`;
    const matchedKeywords = findMatchingKeywords(searchedKeywords || [], `${snippet} ${headline}`);
    const isHiringPost = containsAnyPhrase(snippet, HIRING_PHRASES);
    const isFreelancePost = containsAnyPhrase(snippet, FREELANCE_PHRASES);
    const connectionDegree = extractConnectionDegree(authorInfo.anchor);

    return {
      key,
      author: authorInfo.name,
      profileUrl: authorInfo.profileUrl,
      postUrl,
      snippet,
      timestampText,
      headline,
      matchedKeywords,
      isJobAd,
      isHiringPost,
      isFreelancePost,
      connectionDegree,
      rank,
    };
  } catch {
    return null;
  }
}

async function scrollUntilPlateau(maxPasses = MAX_SCROLL_PASSES) {
  let lastCount = findCards().length;
  let stagnantPasses = 0;

  for (let i = 0; i < maxPasses; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(SCROLL_PAUSE_MS);

    const count = findCards().length;
    if (count > lastCount) {
      stagnantPasses = 0;
    } else {
      stagnantPasses++;
      if (stagnantPasses >= STAGNANT_PASSES_TO_STOP) break;
    }
    lastCount = count;
  }
}

async function scrapeCurrentPage(searchedKeywords, authorTitles, includeJobAds, deepScroll) {
  await waitForCards();
  await scrollUntilPlateau(deepScroll ? DEEP_MAX_SCROLL_PASSES : MAX_SCROLL_PASSES);

  const cards = findCards();
  console.log(`[LinkedIn Lead Scanner] ${cards.length} card element(s) matched selectors.`);
  const posts = cards
    .map((card, index) => extractPost(card, index, searchedKeywords, authorTitles, includeJobAds))
    .filter(Boolean);
  for (const post of posts) {
    console.log(
      `[LinkedIn Lead Scanner] post by ${post.author}: matchedKeywords=`,
      post.matchedKeywords,
      `snippet="${post.snippet.slice(0, 100)}"`
    );
  }
  return posts;
}

async function run() {
  const {
    currentScanTopicId,
    currentScanTopicName,
    currentScanKeywords,
    currentScanDeepScroll,
    authorTitle: authorTitles,
    includeJobAds,
    authorTitleEnabled,
  } = await chrome.storage.local.get([
    "currentScanTopicId",
    "currentScanTopicName",
    "currentScanKeywords",
    "currentScanDeepScroll",
    "authorTitle",
    "includeJobAds",
    "authorTitleEnabled",
  ]);
  if (!currentScanTopicId) return; // Not part of an active scan; do nothing.

  // A filter can be toggled off while keeping its keyword list saved -
  // treat it as empty (no restriction) when disabled, default enabled.
  const effectiveAuthorTitles = authorTitleEnabled === false ? [] : authorTitles || [];

  console.log(`[LinkedIn Lead Scanner] searching for keywords:`, currentScanKeywords);
  console.log(`[LinkedIn Lead Scanner] client-side filters - titles:`, effectiveAuthorTitles, `includeJobAds:`, includeJobAds);

  // Defaults to true (include job ads) when never explicitly set.
  const shouldIncludeJobAds = includeJobAds === undefined ? true : Boolean(includeJobAds);
  const posts = await scrapeCurrentPage(currentScanKeywords || [], effectiveAuthorTitles, shouldIncludeJobAds, Boolean(currentScanDeepScroll));
  console.log(`[LinkedIn Lead Scanner] topic "${currentScanTopicName}": found ${posts.length} post(s).`);

  chrome.runtime.sendMessage({
    type: "SCRAPE_RESULT",
    topicId: currentScanTopicId,
    topicName: currentScanTopicName,
    posts,
  });
}

run();
