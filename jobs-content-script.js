// Runs on LinkedIn's Jobs search-results page. Reads which topic is
// currently being scanned from storage (set by background.js immediately
// before it navigated here), scrapes the visible job cards, and reports
// them back to the background script.
//
// NOTE ON SELECTORS: like the Posts scraper, LinkedIn's CSS classes here are
// auto-generated/hashed and not usable as stable hooks. Found via live-page
// inspection:
//   - the job list is a virtualized list at [data-testid="lazy-column"];
//     each direct child of it is one job card.
//   - each card carries componentkey="job-card-component-ref-<numeric job
//     id>", which gives us the canonical job URL without clicking anything.
//   - the job title sits in a <p> inside a [data-display-contents="true"]
//     wrapper, as two spans: one with a "(Verified job)" a11y suffix to
//     strip, one aria-hidden visual duplicate.
//   - company and location are plain sibling elements right after that
//     title wrapper, in a small fixed-position container.
// If scraping stops working, re-run the live-page inspection to find what
// changed and update the selectors below.

const JOB_LIST_SELECTOR = '[data-testid="lazy-column"]';
const MAX_WAIT_MS = 8000;
const POLL_INTERVAL_MS = 300;
const MAX_SCROLL_PASSES = 15;
const STAGNANT_PASSES_TO_STOP = 2;
const SCROLL_PAUSE_MS = 1500;

function findJobCards() {
  const list = document.querySelector(JOB_LIST_SELECTOR);
  return list ? Array.from(list.children) : [];
}

function waitForJobCards() {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const cards = findJobCards();
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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeWord(haystackLower, keyword) {
  return new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`, "i").test(haystackLower);
}

function findMatchingKeywords(searchedKeywords, text) {
  const haystack = text.toLowerCase();
  return searchedKeywords.filter((kw) => containsWholeWord(haystack, kw));
}

function extractJobId(card) {
  const el = card.querySelector('[componentkey^="job-card-component-ref-"]');
  const key = el?.getAttribute("componentkey") || "";
  const match = key.match(/^job-card-component-ref-(\d+)$/);
  return match ? match[1] : null;
}

function extractTitleWrapper(card) {
  const titleP = card.querySelector('[data-display-contents="true"] p');
  return { titleP, titleWrapper: titleP?.closest('[data-display-contents="true"]') || null };
}

function extractJobTitle(titleP) {
  const labeledSpan = titleP?.querySelector("span");
  return labeledSpan?.textContent.replace(/\s*\(Verified job\)\s*$/, "").trim() || "";
}

function extractCompanyAndLocation(titleWrapper) {
  const infoContainer = titleWrapper?.parentElement;
  const children = infoContainer ? Array.from(infoContainer.children) : [];
  const company = children[1]?.textContent.trim() || "";
  const location = children
    .slice(2)
    .map((el) => el.textContent.trim())
    .filter(Boolean)
    .join(" ");
  return { company, location };
}

function extractPostedText(card) {
  const texts = Array.from(card.querySelectorAll("p, span")).map((el) => el.textContent.trim());
  const posted = texts.find((t) => /^Posted\s+/i.test(t));
  return posted ? posted.replace(/^Posted\s+/i, "") : "";
}

function extractJobPost(card, rank, searchedKeywords) {
  try {
    const jobId = extractJobId(card);
    if (!jobId) return null;

    const { titleP, titleWrapper } = extractTitleWrapper(card);
    const title = extractJobTitle(titleP);
    if (!title) return null;

    const { company, location } = extractCompanyAndLocation(titleWrapper);
    const postedText = extractPostedText(card);
    const jobUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
    const matchedKeywords = findMatchingKeywords(searchedKeywords || [], `${title} ${company}`);

    return { key: jobUrl, jobId, title, company, location, postedText, jobUrl, matchedKeywords, rank };
  } catch {
    return null;
  }
}

async function scrollUntilPlateau() {
  const list = document.querySelector(JOB_LIST_SELECTOR);
  if (!list) return;

  let lastCount = findJobCards().length;
  let stagnantPasses = 0;

  for (let i = 0; i < MAX_SCROLL_PASSES; i++) {
    list.scrollTop = list.scrollHeight;
    await sleep(SCROLL_PAUSE_MS);

    const count = findJobCards().length;
    if (count > lastCount) {
      stagnantPasses = 0;
    } else {
      stagnantPasses++;
      if (stagnantPasses >= STAGNANT_PASSES_TO_STOP) break;
    }
    lastCount = count;
  }
}

async function scrapeCurrentPage(searchedKeywords) {
  await waitForJobCards();
  await scrollUntilPlateau();

  const cards = findJobCards();
  console.log(`[LinkedIn Lead Scanner] ${cards.length} job card(s) found.`);
  const jobs = cards.map((card, index) => extractJobPost(card, index, searchedKeywords)).filter(Boolean);
  for (const job of jobs) {
    console.log(`[LinkedIn Lead Scanner] job: "${job.title}" @ ${job.company} (${job.location})`);
  }
  return jobs;
}

async function run() {
  const { currentJobScanTopicId, currentJobScanTopicName, currentJobScanKeywords } =
    await chrome.storage.local.get([
      "currentJobScanTopicId",
      "currentJobScanTopicName",
      "currentJobScanKeywords",
    ]);
  if (!currentJobScanTopicId) return; // Not part of an active job scan; do nothing.

  console.log(`[LinkedIn Lead Scanner] job search for keywords:`, currentJobScanKeywords);

  const jobs = await scrapeCurrentPage(currentJobScanKeywords || []);
  console.log(`[LinkedIn Lead Scanner] topic "${currentJobScanTopicName}": found ${jobs.length} job(s).`);

  chrome.runtime.sendMessage({
    type: "JOB_SCRAPE_RESULT",
    topicId: currentJobScanTopicId,
    topicName: currentJobScanTopicName,
    jobs,
  });
}

run();
