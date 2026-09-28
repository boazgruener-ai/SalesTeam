import { withBatch } from "./batch-jobs.js";
// Orchestrates PRD 6.20 Phase 6 (Target Account & Contact Discovery -
// Contact discovery scan): for each company Phase 5 already discovered and
// location-vetted, visits that company's own People tab with a keyword
// search built from targetContactProfile, and keeps up to
// maxContactsPerAccount candidates whose own displayed headline genuinely
// contains a target title/keyword (or a known alias variant) - not just
// anyone LinkedIn's own search matched via stale career history. Modeled
// directly on company-discovery-extraction.js's orchestration pattern
// (navigateAndWait/waitForMessage, randomDelay pacing,
// chrome.power.requestKeepAwake, tab lifecycle in a finally block, per-item
// checkpointing) - generalized from "one page of many companies" to "one
// company at a time."
//
// Reads targetContactProfile (the who-to-look-for profile) and the list of
// companies to work through from getDiscoveredCompanies() (Phase 5's own
// staged output) directly - unlike company-discovery-extraction.js, there's
// no separate "config snapshot" to freeze, since targetContactProfile isn't
// something a mid-run wizard edit would silently reconfigure the same way
// (Phase 5's targetUniverseConfig shapes which companies get found at all;
// Phase 6 only shapes which of an already-fixed company list's people get
// kept, safe to read live).
//
// Search mechanics, People-tab card structure, and the career-history/
// pagination findings are all confirmed live 2026-09-15 - see
// contact-discovery-content-script.js's own header comment for the full
// evidence.

import {
  getTargetContactProfile,
  getDiscoveredCompanies,
  getDiscoveredContacts,
  appendDiscoveredContacts,
  titleVariants,
  containsWholeWord,
  normalizeCompanyName,
  getExistingCompaniesNeedingContacts,
  markContactDiscoveryAttempted,
  appendContactsToWorkbook,
  buildDiscoveredContactRow,
  expandSeniorityLevelKeywords,
  SENIORITY_LEVEL_KEYWORDS,
  CHIEF_OFFICER_RE,
} from "./storage.js";
import { getDiscoveryQueueState, checkpointContactPhase, completeDiscoveryQueue } from "./discovery-queue.js";
import { recordLinkedinTouch } from "./linkedin-touch-log.js";
import { checkTouchBudget } from "./touch-budget-guard.js";

const NAV_TIMEOUT_MS = 20000;
const PAGE_RESULT_TIMEOUT_MS = NAV_TIMEOUT_MS + 8000; // same derivation as company-discovery-extraction.js
const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 9000;
const DEFAULT_MAX_CONTACTS_PER_ACCOUNT = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

function buildPeopleSearchUrl(slug, keywordExpression) {
  return `https://www.linkedin.com/company/${encodeURIComponent(slug)}/people/?keywords=${encodeURIComponent(keywordExpression)}`;
}

// Confirmed live 2026-09-15: LinkedIn's People-tab insights backend
// reliably fails ("We are unable to load people insights data...") once the
// keywords= expression passes a real complexity ceiling - tested directly
// against ABB's own People tab, narrowing it precisely: 6 boolean OR-clauses
// rendered 12 real cards cleanly, 7 failed every single time (not
// intermittently - retrying a query this long never helps, confirmed
// separately from the render-timing bug the retry logic above exists for).
// Capped conservatively at this confirmed-safe number, never guessed higher.
const MAX_KEYWORD_TERMS = 6;

// Combines exactTitles + titleKeywords into one or more boolean-OR
// expressions (chunks), expanding each ORIGINAL term through
// titleVariants() so an acronym and its full form are both searched even
// though the user only entered one - confirmed live LinkedIn's own search
// already does some of this server-side, but not reliably enough to skip
// building it explicitly (see storage.js's TITLE_ALIAS_GROUPS comment).
// Built in priority order (exactTitles before titleKeywords, matching
// classifyCandidate's own exact-before-keyword priority).
//
// Reported directly, 2026-09-17: the original version capped at
// MAX_KEYWORD_TERMS and permanently dropped whatever didn't fit in one
// query - a real profile with more than 6 title/keyword variants (common:
// a handful of exact titles plus several broader keywords) silently never
// got some of its own configured terms searched at all, batch after
// batch, with no way to ever cover them short of shrinking the profile.
// Fixed by chunking instead of dropping: every term still gets its own
// alias group kept together (never split across chunks), a variant
// already placed in an earlier chunk is never repeated in a later one
// (globalSeen), and a new chunk starts whenever the current one would
// exceed MAX_KEYWORD_TERMS - so a 14-term profile becomes 3 real per-
// company LinkedIn visits instead of 1, each covering a distinct slice,
// rather than 1 visit covering 6 and silently ignoring the other 8
// forever. The real cost: a company needing N chunks now costs N touches
// here, not 1 - an accepted, deliberate tradeoff (the user's own request)
// for actually covering every configured term.
//
// droppedTerms is now only ever non-empty for the genuinely pathological
// case of a single term whose own alias group alone exceeds
// MAX_KEYWORD_TERMS (titleVariants() would have to return 7+ variants for
// one term) - truncated to its own dedicated chunk rather than never
// searched, since splitting a term from its own aliases mid-chunk isn't
// meaningfully different from dropping a few of that one term's own
// synonyms.
// Folds any selected seniority levels' expanded keyword terms into the
// profile's own titleKeywords (deduped) - additive, per the user's own
// confirmed direction (2026-09-17), never replacing what they typed.
// Applied once, right after getTargetContactProfile(), so both this
// function and classifyCandidate below see the same effective keyword set
// without either needing its own seniority-aware logic.
function withSeniorityKeywords(profile) {
  const seniorityTerms = expandSeniorityLevelKeywords(profile.seniorityLevels);
  if (seniorityTerms.length === 0) return profile;
  const existing = new Set((profile.titleKeywords || []).map((t) => t.toLowerCase()));
  const merged = [...(profile.titleKeywords || [])];
  for (const term of seniorityTerms) {
    if (existing.has(term.toLowerCase())) continue;
    existing.add(term.toLowerCase());
    merged.push(term);
  }
  return { ...profile, titleKeywords: merged };
}

function buildKeywordExpressionChunks(profile) {
  const orderedTerms = [...(profile.exactTitles || []), ...(profile.titleKeywords || [])];
  const globalSeen = new Set();
  const chunks = [];
  const droppedTerms = [];
  let currentVariants = [];
  let currentTerms = [];

  function flushChunk() {
    if (currentVariants.length === 0) return;
    chunks.push({
      expression: currentVariants.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" OR "),
      includedTerms: currentTerms,
    });
    currentVariants = [];
    currentTerms = [];
  }

  for (const term of orderedTerms) {
    let variants = titleVariants(term).filter((v) => !globalSeen.has(v));
    if (variants.length === 0) continue; // every variant already covered by an earlier term's own aliases
    if (variants.length > MAX_KEYWORD_TERMS) {
      droppedTerms.push(term);
      variants = variants.slice(0, MAX_KEYWORD_TERMS);
    }
    if (currentVariants.length + variants.length > MAX_KEYWORD_TERMS) flushChunk();
    for (const v of variants) {
      globalSeen.add(v);
      currentVariants.push(v);
    }
    currentTerms.push(term);
  }
  flushChunk();

  return { chunks, droppedTerms };
}

// Same listener-race reasoning as company-discovery-extraction.js's
// navigateAndWait - registered before navigation starts.
function navigateAndWait(tabId, url, { activate = true } = {}) {
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
    chrome.tabs.update(tabId, activate ? { url, active: true } : { url }).catch(() => {});
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

async function fetchContactCandidates(tab, url, nav = {}) {
  await chrome.storage.local.set({ contactDiscoveryActive: true });
  const resultPromise = waitForMessage("CONTACT_DISCOVERY_RESULT", PAGE_RESULT_TIMEOUT_MS);
  const { navCompleted } = await navigateAndWait(tab.id, url, nav);
  const message = await resultPromise;
  return {
    navCompleted,
    receivedMessage: Boolean(message),
    results: message?.results || [],
    insightsLoadError: Boolean(message?.insightsLoadError),
    caughtError: message?.caughtError || null,
  };
}

// LinkedIn's own common headline convention, confirmed against the real
// 77-contact batch: "Role @ Company" segments strung together with a
// delimiter - "·" (Robin Waech: "Head Intelligent Robotics & ML @ AXA ·
// CTO @ Material Upcycling AG"), ";" (Stefan Palzer: "Chief Technology
// Officer ... at Nestlé; Board member Merck KGaA"), or "/" (Georges El
// Nachar: "Global Head of Platforms / Technology lover / CTO"). Splitting
// on these is what makes segment-level company attribution possible below -
// not exhaustive of every way a headline could be written, just the
// delimiters actually observed.
const HEADLINE_SEGMENT_SPLIT_RE = /[·|;/]/;
// "@ X" / "at X" / German "bei X" / French "chez X" at the tail of a
// segment - the actual company-attachment patterns seen in the real batch
// (Thomas Kurlus "at Nestlé Nespresso", Robin Waech "@ Material Upcycling
// AG", Thomas Fischbacher "bei AXA Mobility Services AG").
//
// Bug caught before shipping (2026-09-15): a single \b in front of the
// whole alternation (`\b(?:@|at|bei|chez)`) looks correct but silently
// never matches the "@" branch at all - \b requires a \w/\W transition, and
// since both "@" and the space that normally precedes it ("ML @ AXA") are
// \W, there's no transition there for \b to anchor on. Verified directly
// (Python's re, same \b semantics): the naive version returned no match at
// all for either of Robin Waech's own two "@"-segments - the exact case
// this whole fix exists for - while still "working" on the "at"-based
// examples, so it would have looked fine until tested against the specific
// case that motivated it. Fixed by giving "@" its own un-anchored
// alternative (it doesn't need \b - "@" is distinct enough on its own)
// while keeping \b for the word-based markers, which do need it.
const SEGMENT_COMPANY_MARKER_RE = /(?:@\s*|\b(?:at|bei|chez)\s+)(.+)$/i;

function extractSegmentCompany(segment) {
  const match = segment.match(SEGMENT_COMPANY_MARKER_RE);
  return match ? match[1].trim() : null;
}

// True only when this specific segment names a company AND it's confidently
// a DIFFERENT one from the target - a segment with no company marker at all
// (most bare titles: "CTO", "CIO & CISO") is deliberately never treated as
// a conflict, same reasoning as the null-company-mentioned case in
// classifyCandidate's own comment: no evidence either way, default to
// keeping rather than guessing a mismatch that isn't there.
function segmentConflictsWithCompany(segment, companyName) {
  if (!companyName) return false;
  const found = extractSegmentCompany(segment);
  if (!found) return false;
  const normFound = normalizeCompanyName(found);
  const normTarget = normalizeCompanyName(companyName);
  if (!normFound || !normTarget) return false;
  return !(normFound.includes(normTarget) || normTarget.includes(normFound));
}

// Accepted only if a target term (or a known alias variant) genuinely
// appears, tied to the target company, in the candidate's own displayed
// headline text - otherwise the match came from stale/past employment
// history or a second, unrelated current role (confirmed live: a "Senior
// Advisor" card matched a CEO-OR-CTO search purely from career history,
// nothing CEO/CTO-shaped anywhere in the card's own text), the same
// "confident match or skip" discipline this codebase already applies
// elsewhere. Returns "exact" (matched an exactTitles term), "keyword"
// (matched a titleKeywords term), or null (no real match, discard) -
// exact-title matches are ranked ahead of keyword-only ones when a company
// has more qualifying candidates than the cap.
//
// Bug found and fixed 2026-09-15 after reviewing a real batch of 77
// discovered contacts: this originally used plain headline.includes(term),
// which matches a short acronym inside a completely unrelated word - "CTO"
// matched "Director" (di-recto-r), "sector", "rector"; "AI" matched
// "Affairs", "Airworthiness", "Airplanes" - real false positives found in
// that batch, not a hypothetical. storage.js's own containsWholeWord
// already exists specifically to prevent this exact class of bug (its own
// header comment cites the identical "AI matching inside AljurAId" case) -
// this now reuses it instead of a second, worse implementation.
//
// Second bug found reviewing the same batch, fixed the same day: matching
// against the WHOLE headline let a title tied to a completely different
// company count as a match - Robin Waech's card ("Head Intelligent
// Robotics & ML @ AXA · CTO @ Material Upcycling AG") was kept as an exact
// CTO match at AXA Switzerland, when the CTO title is actually held at
// Material Upcycling AG, an unrelated company mentioned in the same
// headline (whether from a past role or a genuinely-held second job -
// either way, not relevant to a search scoped to AXA). Checking the whole
// headline for the target company's presence doesn't fix this: Robin
// Waech's headline DOES mention AXA too, just in a different segment - only
// segment-level attribution (below) tells the two apart. Whichever segment
// the matched term appears in is checked against segmentConflictsWithCompany
// before accepting it; a conflicting segment is skipped, not an automatic
// disqualification of the whole candidate, so a later segment or term can
// still produce a genuine match.
// Shared by classifyCandidate's exact/keyword tiers and
// classifyCandidateSeniority below - same segment-scoped, alias-aware,
// company-conflict-checked matching either way, just against a different
// term list.
function headlineMatchesAnyTerm(headlineText, companyName, terms) {
  if (!headlineText) return false;
  const rawSegments = headlineText.split(HEADLINE_SEGMENT_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  const segments = rawSegments.length > 0 ? rawSegments : [headlineText];
  for (const term of terms || []) {
    for (const variant of titleVariants(term)) {
      for (const segment of segments) {
        if (!containsWholeWord(segment.toLowerCase(), variant)) continue;
        if (segmentConflictsWithCompany(segment, companyName)) continue;
        return true;
      }
    }
  }
  return false;
}

function headlineChiefOfficerSegment(headlineText, companyName) {
  const rawSegments = headlineText.split(HEADLINE_SEGMENT_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  const segments = rawSegments.length > 0 ? rawSegments : [headlineText];
  return segments.some((segment) => CHIEF_OFFICER_RE.test(segment) && !segmentConflictsWithCompany(segment, companyName));
}

function classifyCandidate(candidate, companyName, profile) {
  const headlineText = candidate.headlineText || "";
  if (!headlineText) return null;
  if (headlineMatchesAnyTerm(headlineText, companyName, profile.exactTitles)) return "exact";
  if (headlineMatchesAnyTerm(headlineText, companyName, profile.titleKeywords)) return "keyword";
  return null;
}

// Tags a matched candidate with which of the user's SELECTED seniority
// levels their headline demonstrates, at THIS company specifically (same
// segment/company-conflict scoping as classifyCandidate, so a past "CFO @
// PreviousCo, now Manager @ AXA" headline is tagged Manager at AXA, not
// CFO). When more than one selected level matches (e.g. a headline naming
// both a Director and a VP role), the user's own highest-priority level
// wins - ties keep whichever came first in profile.seniorityLevels. Returns
// null when nothing configured or nothing matched (most contacts, and any
// contact matched only via exactTitles/titleKeywords with no seniority
// levels selected at all).
function classifyCandidateSeniority(candidate, companyName, seniorityLevels) {
  const headlineText = candidate.headlineText || "";
  if (!headlineText || !seniorityLevels || seniorityLevels.length === 0) return null;
  const sorted = [...seniorityLevels].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const level of sorted) {
    // Same "Chief … Officer" rule as classifyJobTitleSeniority, applied per headline segment so a
    // segment naming another company ("ex-Chief Risk Officer @ OtherCo") still does not count.
    if (level.id === "cLevel" && headlineChiefOfficerSegment(headlineText, companyName)) return level;
    if (headlineMatchesAnyTerm(headlineText, companyName, SENIORITY_LEVEL_KEYWORDS[level.id])) return level;
  }
  return null;
}

// Shared by runContactDiscoveryPhase and runContactDiscoveryForExistingCompanies
// below - visits a company's People tab once per keyword chunk
// (buildKeywordExpressionChunks above), merging candidates by slug so a
// person LinkedIn happens to surface under more than one chunk's query
// isn't double-counted. Each chunk is a real, separately touch-budget-
// checked LinkedIn visit - a company needing N chunks costs N touches, not
// 1 (see buildKeywordExpressionChunks' own comment for why this replaced
// the old single-query-with-dropped-terms behavior). Returns
// stoppedByTouchBudget: true (with whatever candidates were already
// gathered from completed chunks) rather than discarding a company's
// partial progress just because a later chunk couldn't run.
async function fetchContactCandidatesForCompany(tab, slug, companyLabel, keywordChunks, pageDebugSamples, maxPageDebugSamples, nav = {}) {
  const bySlug = new Map();
  let stoppedByTouchBudget = false;
  for (let i = 0; i < keywordChunks.length; i++) {
    if (await checkTouchBudget()) { stoppedByTouchBudget = true; break; }
    const url = buildPeopleSearchUrl(slug, keywordChunks[i].expression);
    let { navCompleted, receivedMessage, results, insightsLoadError, caughtError } = await fetchContactCandidates(tab, url, nav);
    // Same zero-result retry as elsewhere in this file - see runContactDiscoveryPhase's own comment.
    for (let retryCount = 0; retryCount < 2 && results.length === 0 && receivedMessage && !caughtError; retryCount++) {
      await sleep(randomDelay());
      const retry = await fetchContactCandidates(tab, url, nav);
      ({ navCompleted, receivedMessage, results, insightsLoadError, caughtError } = retry);
    }
    if (pageDebugSamples.length < maxPageDebugSamples) {
      pageDebugSamples.push({
        company: companyLabel, url, navCompleted, receivedMessage, insightsLoadError,
        resultCount: results.length, caughtError, chunk: i + 1, chunkCount: keywordChunks.length,
      });
    }
    for (const r of results) {
      if (!bySlug.has(r.slug)) bySlug.set(r.slug, r);
    }
    if (i < keywordChunks.length - 1) await sleep(randomDelay());
  }
  return { candidates: Array.from(bySlug.values()), stoppedByTouchBudget };
}

// Runs (or resumes) the contact-discovery phase of the queue, one company
// at a time. Returns a summary of this call's own activity - the
// authoritative running totals live in discoveredContacts/the queue state
// itself, since a multi-day run is expected to call this more than once.
async function runContactDiscoveryPhaseImpl({ onProgress, shouldAbort } = {}) {
  const state = await getDiscoveryQueueState();
  if (state.status !== "discovering_contacts") {
    return { ranAnything: false, reason: `queue status is "${state.status}", not "discovering_contacts"` };
  }
  const profile = withSeniorityKeywords(await getTargetContactProfile());
  const maxContactsPerAccount = profile.maxContactsPerAccount || DEFAULT_MAX_CONTACTS_PER_ACCOUNT;
  const { chunks: keywordChunks, droppedTerms } = buildKeywordExpressionChunks(profile);
  const includedTerms = keywordChunks.flatMap((c) => c.includedTerms);
  if (keywordChunks.length === 0) {
    return { ranAnything: false, reason: "no target-contact titles/keywords configured (Contacts step)" };
  }

  const companies = await getDiscoveredCompanies();
  let companyIndex = state.contactPhase.nextCompanyIndex || 0;

  let companiesProcessed = 0;
  let totalNewContacts = 0;
  let companiesWithNoMatch = 0;
  let stoppedByTouchBudget = false;
  let stoppedByAbort = false;
  let tab;
  const pageDebugSamples = [];
  const MAX_PAGE_DEBUG_SAMPLES = 5;

  try {
    chrome.power.requestKeepAwake("system");
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
    // Same cold-start warm-up as company-discovery-extraction.js.
    await navigateAndWait(tab.id, "https://www.linkedin.com/feed/");

    for (; companyIndex < companies.length; companyIndex++) {
      if (shouldAbort && shouldAbort()) { stoppedByAbort = true; break; }

      const company = companies[companyIndex];
      if (onProgress) onProgress({ company: company.name, index: companyIndex, total: companies.length });

      const { candidates: results, stoppedByTouchBudget: budgetStoppedMidCompany } =
        await fetchContactCandidatesForCompany(tab, company.slug, company.name, keywordChunks, pageDebugSamples, MAX_PAGE_DEBUG_SAMPLES);
      if (budgetStoppedMidCompany) { stoppedByTouchBudget = true; break; }
      companiesProcessed++;

      const classified = [];
      for (const candidate of results) {
        const tier = classifyCandidate(candidate, company.name, profile);
        if (!tier) continue;
        const seniority = classifyCandidateSeniority(candidate, company.name, profile.seniorityLevels);
        classified.push({ ...candidate, tier, seniorityLevel: seniority?.id ?? null, seniorityPriority: seniority?.priority ?? null });
      }
      // Exact-title matches ranked ahead of keyword-only ones - added
      // 2026-09-15 per the user's own request, so a company with more
      // qualifying candidates than the cap doesn't just keep whichever
      // happened to appear first in LinkedIn's own result order.
      classified.sort((a, b) => (a.tier === "exact" ? -1 : 0) - (b.tier === "exact" ? -1 : 0));
      const kept = classified.slice(0, maxContactsPerAccount);

      if (kept.length === 0) {
        companiesWithNoMatch++;
      } else {
        await appendDiscoveredContacts(
          kept.map((c) => ({
            slug: c.slug,
            name: c.name,
            headlineText: c.headlineText,
            tier: c.tier,
            seniorityLevel: c.seniorityLevel,
            seniorityPriority: c.seniorityPriority,
            companyKey: company.linkedinCompanyId,
            companyName: company.name,
            discoveredAt: Date.now(),
          }))
        );
        totalNewContacts += kept.length;
      }

      await checkpointContactPhase({ nextCompanyIndex: companyIndex + 1 });
      if (companyIndex < companies.length - 1) await sleep(randomDelay());
    }

    if (!stoppedByAbort && !stoppedByTouchBudget && companyIndex >= companies.length) {
      // Every discovered company has been visited - this phase (and the
      // whole Discovery run) is genuinely done, not just paused.
      await completeDiscoveryQueue();
    }
  } finally {
    chrome.power.releaseKeepAwake();
    await chrome.storage.local.remove(["contactDiscoveryActive"]).catch(() => {});
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }

  return {
    ranAnything: true,
    companiesProcessed,
    totalCompanies: companies.length,
    totalNewContacts,
    companiesWithNoMatch,
    includedTerms,
    droppedTerms,
    stoppedByTouchBudget,
    stoppedByAbort,
    reachedEnd: companyIndex >= companies.length,
    pageDebugSamples,
  };
}

// "Discover Contacts for Existing Companies" (PRD 6.20, 2026-09-17, the
// user's own request) - the counterpart to runContactDiscoveryPhase above,
// but for companies already in the real Target Accounts workbook instead
// of ones Phase 5 just found. Deliberately independent of
// discoveryQueueState entirely (no status gate, no shared cursor) - this
// can run any time, regardless of whether a Phase 5/6 Discovery run is
// idle/in-progress/done, since it operates on a completely different
// company list (storage.js's getExistingCompaniesNeedingContacts) that a
// real workbook (528 ChatGPT-imported companies, in the user's own case)
// can make far larger than a typical Discovery run's own find-count - a
// multi-day, resumable action is the realistic case, not the exception.
// Resume tracking is per-company (markContactDiscoveryAttempted, same
// never-attempted-first ordering as 6.16's "Resolve LinkedIn Company IDs"),
// not a persisted list-position cursor, so this fetches a fresh candidate
// list every call - the "already attempted" data itself IS the resume
// state, and it stays correct even if the workbook changes between calls
// (a company imported/merged/excluded since the last run is naturally
// picked up or dropped, not stuck at a stale index).
async function runContactDiscoveryForExistingCompaniesImpl({ onProgress, shouldAbort, limit, maxExistingContacts } = {}) {
  const profile = withSeniorityKeywords(await getTargetContactProfile());
  const maxContactsPerAccount = profile.maxContactsPerAccount || DEFAULT_MAX_CONTACTS_PER_ACCOUNT;
  const { chunks: keywordChunks, droppedTerms } = buildKeywordExpressionChunks(profile);
  const includedTerms = keywordChunks.flatMap((c) => c.includedTerms);
  if (keywordChunks.length === 0) {
    return { ranAnything: false, reason: "no target-contact titles/keywords configured (Contacts step)" };
  }

  const candidates = await getExistingCompaniesNeedingContacts(maxExistingContacts || 2);
  const companies = typeof limit === "number" ? candidates.slice(0, limit) : candidates;
  if (companies.length === 0) {
    return { ranAnything: false, reason: "no existing companies currently need contact discovery" };
  }

  let companiesProcessed = 0;
  let totalNewContacts = 0;
  let companiesWithNoMatch = 0;
  let stoppedByTouchBudget = false;
  let stoppedByAbort = false;
  const attemptedKeys = [];
  let tab;
  const pageDebugSamples = [];
  const MAX_PAGE_DEBUG_SAMPLES = 5;

  try {
    chrome.power.requestKeepAwake("system");
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
    await navigateAndWait(tab.id, "https://www.linkedin.com/feed/");

    for (const company of companies) {
      if (shouldAbort && shouldAbort()) { stoppedByAbort = true; break; }

      if (onProgress) onProgress({ company: company.company, index: companiesProcessed, total: companies.length });

      const { candidates: results, stoppedByTouchBudget: budgetStoppedMidCompany } =
        await fetchContactCandidatesForCompany(tab, company.slug, company.company, keywordChunks, pageDebugSamples, MAX_PAGE_DEBUG_SAMPLES);
      if (budgetStoppedMidCompany) { stoppedByTouchBudget = true; break; }
      companiesProcessed++;
      attemptedKeys.push(company.key);

      const classified = [];
      for (const candidate of results) {
        const tier = classifyCandidate(candidate, company.company, profile);
        if (!tier) continue;
        const seniority = classifyCandidateSeniority(candidate, company.company, profile.seniorityLevels);
        classified.push({ ...candidate, tier, seniorityLevel: seniority?.id ?? null, seniorityPriority: seniority?.priority ?? null });
      }
      classified.sort((a, b) => (a.tier === "exact" ? -1 : 0) - (b.tier === "exact" ? -1 : 0));
      const kept = classified.slice(0, Math.max(0, maxContactsPerAccount - company.contactCount));

      if (kept.length === 0) {
        companiesWithNoMatch++;
      } else {
        const rows = kept.map((c) =>
          buildDiscoveredContactRow(
            { slug: c.slug, name: c.name, headlineText: c.headlineText, tier: c.tier, seniorityLevel: c.seniorityLevel, seniorityPriority: c.seniorityPriority },
            { companyId: company.companyId, company: company.company }
          )
        );
        const added = await appendContactsToWorkbook(rows);
        totalNewContacts += added;
      }

      if (companiesProcessed < companies.length) await sleep(randomDelay());
    }
  } finally {
    chrome.power.releaseKeepAwake();
    await chrome.storage.local.remove(["contactDiscoveryActive"]).catch(() => {});
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
    if (attemptedKeys.length > 0) await markContactDiscoveryAttempted(attemptedKeys);
  }

  return {
    ranAnything: true,
    companiesProcessed,
    totalCandidates: companies.length,
    totalNewContacts,
    companiesWithNoMatch,
    includedTerms,
    droppedTerms,
    stoppedByTouchBudget,
    stoppedByAbort,
    pageDebugSamples,
  };
}

export function runContactDiscoveryPhase(...args) {
  return withBatch("Discovery of contacts", () => runContactDiscoveryPhaseImpl(...args));
}

export function runContactDiscoveryForExistingCompanies(...args) {
  return withBatch("Discovery of contacts for existing companies", () => runContactDiscoveryForExistingCompaniesImpl(...args));
}

// ---------------------------------------------------------------------------------------------------
// One account at a time, on a tab the caller owns - the 1.2 pipeline's entry points
// (DATA_PIPELINE_DESIGN.md 5.1 and step 2 touch-up T1). No tab of their own, no warm-up, no keep-awake.
// ---------------------------------------------------------------------------------------------------

// True when the headline ties the person to companies, and every one of them is a different company
// from the target - someone who has left, or a namesake elsewhere. A headline naming no company at all
// is not a conflict (same no-evidence-no-guess rule as segmentConflictsWithCompany).
function headlineNamesOnlyOtherCompanies(headlineText, companyName) {
  if (!headlineText) return false;
  const marked = headlineText.split(HEADLINE_SEGMENT_SPLIT_RE).filter((seg) => extractSegmentCompany(seg));
  return marked.length > 0 && marked.every((seg) => segmentConflictsWithCompany(seg, companyName));
}

// T1: the company's People tab, searched for one known person's name - 1 touch. Returns every result,
// each flagged `conflict` when its headline names only other companies; pipeline-plan.js's
// pickProfileMatch decides. `received` is false when the page never answered (not a real "not found").
export async function searchCompanyPeopleByName(tab, slug, companyName, keywords, { activate = false } = {}) {
  try {
    const { receivedMessage, results, caughtError } = await fetchContactCandidates(tab, buildPeopleSearchUrl(slug, keywords), { activate });
    return {
      received: receivedMessage && !caughtError,
      candidates: (results || []).map((r) => ({ ...r, conflict: headlineNamesOnlyOtherCompanies(r.headlineText, companyName) })),
      touches: 1,
    };
  } finally {
    await chrome.storage.local.remove(["contactDiscoveryActive"]).catch(() => {});
  }
}

// Title-based discovery for one account - the loop body of runContactDiscoveryForExistingCompanies.
// company: { key, company, companyId, slug, contactCount }. Returns { ranAnything, received, added, touches }.
export async function discoverContactsForAccount(tab, company, { activate = false } = {}) {
  const profile = withSeniorityKeywords(await getTargetContactProfile());
  const maxContactsPerAccount = profile.maxContactsPerAccount || DEFAULT_MAX_CONTACTS_PER_ACCOUNT;
  const { chunks: keywordChunks } = buildKeywordExpressionChunks(profile);
  if (keywordChunks.length === 0) return { ranAnything: false, reason: "no target-contact titles/keywords configured (Contacts step)", added: 0, touches: 0 };
  const pageDebugSamples = [];
  try {
    const { candidates: results, stoppedByTouchBudget } =
      await fetchContactCandidatesForCompany(tab, company.slug, company.company, keywordChunks, pageDebugSamples, keywordChunks.length * 3, { activate });
    const touches = pageDebugSamples.length;
    const received = pageDebugSamples.some((p) => p.receivedMessage && !p.caughtError);
    const classified = [];
    for (const candidate of results) {
      const tier = classifyCandidate(candidate, company.company, profile);
      if (!tier) continue;
      const seniority = classifyCandidateSeniority(candidate, company.company, profile.seniorityLevels);
      classified.push({ ...candidate, tier, seniorityLevel: seniority?.id ?? null, seniorityPriority: seniority?.priority ?? null });
    }
    classified.sort((a, b) => (a.tier === "exact" ? -1 : 0) - (b.tier === "exact" ? -1 : 0));
    const kept = classified.slice(0, Math.max(0, maxContactsPerAccount - (company.contactCount || 0)));
    const added = kept.length === 0 ? 0 : await appendContactsToWorkbook(kept.map((c) =>
      buildDiscoveredContactRow(
        { slug: c.slug, name: c.name, headlineText: c.headlineText, tier: c.tier, seniorityLevel: c.seniorityLevel, seniorityPriority: c.seniorityPriority },
        { companyId: company.companyId, company: company.company }
      )
    ));
    if (received) await markContactDiscoveryAttempted([company.key]);
    return { ranAnything: true, received, added, touches, stoppedByTouchBudget };
  } finally {
    await chrome.storage.local.remove(["contactDiscoveryActive"]).catch(() => {});
  }
}
