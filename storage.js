// Thin wrapper around chrome.storage.local for everything this extension persists:
// Topics/Job Topics/Negative Topics config, the deduped lead history (keyed by
// post/job URL, with status, priority, and negative-topic-match reason), scan
// timeframe/location settings, AI advisor settings (API key, personas,
// templates, history), and the last bulk-status-change record (for undo).
// Also does light self-healing migration on read - e.g. backfilling a missing
// `status` or `irrelevantReason` on old leads - so schema changes don't need a
// separate migration step.

const TOPICS_KEY = "topics";
const RESULTS_KEY = "results";
const TIMEFRAME_KEY = "timeframe";
const AUTHOR_TITLE_KEY = "authorTitle";
const INCLUDE_JOB_ADS_KEY = "includeJobAds";

export async function getIncludeJobAds() {
  const data = await chrome.storage.local.get(INCLUDE_JOB_ADS_KEY);
  return data[INCLUDE_JOB_ADS_KEY] === undefined ? true : Boolean(data[INCLUDE_JOB_ADS_KEY]);
}

export async function saveIncludeJobAds(includeJobAds) {
  await chrome.storage.local.set({ [INCLUDE_JOB_ADS_KEY]: includeJobAds });
}

export async function getTimeframe() {
  const data = await chrome.storage.local.get(TIMEFRAME_KEY);
  return data[TIMEFRAME_KEY] || "past-month";
}

export async function saveTimeframe(timeframe) {
  await chrome.storage.local.set({ [TIMEFRAME_KEY]: timeframe });
}

export async function getAuthorTitles() {
  const data = await chrome.storage.local.get(AUTHOR_TITLE_KEY);
  const value = data[AUTHOR_TITLE_KEY];
  // Guards against a leftover plain-string value from before this setting
  // supported multiple titles under the same storage key.
  return Array.isArray(value) ? value : [];
}

export async function saveAuthorTitles(authorTitles) {
  await chrome.storage.local.set({ [AUTHOR_TITLE_KEY]: authorTitles });
}

// Lets a filter be toggled off for scanning without losing its saved
// keyword list - flipping it back on restores exactly what was there.
const AUTHOR_TITLE_ENABLED_KEY = "authorTitleEnabled";

export async function getAuthorTitleEnabled() {
  const data = await chrome.storage.local.get(AUTHOR_TITLE_ENABLED_KEY);
  return data[AUTHOR_TITLE_ENABLED_KEY] === undefined ? true : Boolean(data[AUTHOR_TITLE_ENABLED_KEY]);
}

export async function saveAuthorTitleEnabled(enabled) {
  await chrome.storage.local.set({ [AUTHOR_TITLE_ENABLED_KEY]: enabled });
}

// Job search (LinkedIn's Jobs vertical, separate from Posts) settings.
const JOB_SEARCH_ENABLED_KEY = "jobSearchEnabled";
const JOB_SEARCH_LOCATION_KEY = "jobSearchLocation";
const JOB_SEARCH_TIMEFRAME_KEY = "jobSearchTimeframe";

export async function getJobSearchEnabled() {
  const data = await chrome.storage.local.get(JOB_SEARCH_ENABLED_KEY);
  return Boolean(data[JOB_SEARCH_ENABLED_KEY]);
}

export async function saveJobSearchEnabled(enabled) {
  await chrome.storage.local.set({ [JOB_SEARCH_ENABLED_KEY]: enabled });
}

// A LinkedIn geoId (e.g. Switzerland, Zurich Metro Area) - "" means any
// location. Jobs search needs a real structured location ID, unlike Posts'
// free-text keyword approach, so this is a small preset list rather than
// user-typed text.
export async function getJobSearchLocation() {
  const data = await chrome.storage.local.get(JOB_SEARCH_LOCATION_KEY);
  return data[JOB_SEARCH_LOCATION_KEY] || "";
}

export async function saveJobSearchLocation(geoId) {
  await chrome.storage.local.set({ [JOB_SEARCH_LOCATION_KEY]: geoId });
}

// User-growable list of {name, geoId} presets for the Job Search location
// dropdown, seeded with the two we found via live-page inspection. A geoId
// is an opaque LinkedIn-internal location ID (not derivable from plain
// text), so new ones have to be looked up on the live Jobs page and added
// here by hand - see jobs-content-script.js's header comment for how.
const JOB_SEARCH_LOCATION_PRESETS_KEY = "jobSearchLocationPresets";
const DEFAULT_JOB_LOCATION_PRESETS = [
  { name: "Switzerland", geoId: "106693272" },
  { name: "Zurich Metropolitan Area", geoId: "90009888" },
];

export async function getJobSearchLocationPresets() {
  const data = await chrome.storage.local.get(JOB_SEARCH_LOCATION_PRESETS_KEY);
  return data[JOB_SEARCH_LOCATION_PRESETS_KEY] || DEFAULT_JOB_LOCATION_PRESETS;
}

export async function saveJobSearchLocationPresets(presets) {
  await chrome.storage.local.set({ [JOB_SEARCH_LOCATION_PRESETS_KEY]: presets });
}

// Job Search's topics are additive with Posts', not either/or: there's
// always a dedicated area for job-only topics (e.g. "AI Engineer" OR "ML
// Engineer" - title-style terms that wouldn't make sense as a Post topic),
// and this toggle controls whether your enabled Post topics ALSO get
// included in the job search on top of those.
const JOB_SEARCH_USE_POST_TOPICS_KEY = "jobSearchUsePostTopics";
const JOB_TOPICS_KEY = "jobTopics";

export async function getJobSearchUsePostTopics() {
  const data = await chrome.storage.local.get(JOB_SEARCH_USE_POST_TOPICS_KEY);
  return data[JOB_SEARCH_USE_POST_TOPICS_KEY] === undefined
    ? true
    : Boolean(data[JOB_SEARCH_USE_POST_TOPICS_KEY]);
}

export async function saveJobSearchUsePostTopics(enabled) {
  await chrome.storage.local.set({ [JOB_SEARCH_USE_POST_TOPICS_KEY]: enabled });
}

export async function getJobTopics() {
  const data = await chrome.storage.local.get(JOB_TOPICS_KEY);
  return data[JOB_TOPICS_KEY] || [];
}

export async function saveJobTopics(jobTopics) {
  await chrome.storage.local.set({ [JOB_TOPICS_KEY]: jobTopics });
}

// Deliberately independent from the Posts timeframe - job ads go stale
// within weeks and there are many of them, while posts are sparse and
// benefit from a wider window, so these shouldn't be forced to match.
export async function getJobSearchTimeframe() {
  const data = await chrome.storage.local.get(JOB_SEARCH_TIMEFRAME_KEY);
  return data[JOB_SEARCH_TIMEFRAME_KEY] || "past-month";
}

export async function saveJobSearchTimeframe(timeframe) {
  await chrome.storage.local.set({ [JOB_SEARCH_TIMEFRAME_KEY]: timeframe });
}

// A free-text description of the salesperson's own company/offering,
// shared across all three AI features (drafting, Sales Mentor, Customer
// Voice) so they can reason about real fit against what's actually being
// sold, not just the lead's own post content in isolation.
const COMPANY_CONTEXT_KEY = "companyContext";

export async function getCompanyContext() {
  const data = await chrome.storage.local.get(COMPANY_CONTEXT_KEY);
  return data[COMPANY_CONTEXT_KEY] || "";
}

export async function saveCompanyContext(context) {
  await chrome.storage.local.set({ [COMPANY_CONTEXT_KEY]: context });
}

// Deliberately separate from Company Context above - "what we offer" (the
// product/service) and "who we're targeting" (company size, geography, what
// they're investing in) are different concepts a salesperson thinks about
// independently, even though every AI feature ends up reading both together.
const IDEAL_CUSTOMER_PROFILE_KEY = "idealCustomerProfile";

export async function getIdealCustomerProfile() {
  const data = await chrome.storage.local.get(IDEAL_CUSTOMER_PROFILE_KEY);
  return data[IDEAL_CUSTOMER_PROFILE_KEY] || "";
}

export async function saveIdealCustomerProfile(profile) {
  await chrome.storage.local.set({ [IDEAL_CUSTOMER_PROFILE_KEY]: profile });
}

// Describes the desired Sales Mentor character (background, style) - seeded
// with a sensible default so the field shows something useful/editable right
// away rather than starting blank.
const MENTOR_PERSONA_KEY = "mentorPersona";
const DEFAULT_MENTOR_PERSONA =
  "A senior B2B software & AI-services sales expert with 25 years of experience, approachable and " +
  "available any time - there's no such thing as a stupid question. Deep expertise in LinkedIn-based lead " +
  "generation, social selling, and B2B sales strategy.";

export async function getMentorPersona() {
  const data = await chrome.storage.local.get(MENTOR_PERSONA_KEY);
  return data[MENTOR_PERSONA_KEY] || DEFAULT_MENTOR_PERSONA;
}

export async function saveMentorPersona(persona) {
  await chrome.storage.local.set({ [MENTOR_PERSONA_KEY]: persona });
}

// Describes the target buyer persona (company type, role, seniority) that
// Customer Voice should default to for general questions not tied to one
// specific lead. Left blank by default (unlike the Mentor persona) since
// there's no safe generic default for who your actual target buyer is -
// see buildCustomerSystemPrompt in sidepanel.js for how an empty value is
// handled.
const CUSTOMER_PERSONA_KEY = "customerPersona";

export async function getCustomerPersona() {
  const data = await chrome.storage.local.get(CUSTOMER_PERSONA_KEY);
  return data[CUSTOMER_PERSONA_KEY] || "";
}

export async function saveCustomerPersona(persona) {
  await chrome.storage.local.set({ [CUSTOMER_PERSONA_KEY]: persona });
}

// Which language drafted messages and the Sales Mentor should respond in.
// Customer Voice additionally mirrors a grounded lead's own post language
// when one is available - see buildCustomerSystemPrompt in sidepanel.js.
const OUTPUT_LANGUAGE_KEY = "outputLanguage";

export async function getOutputLanguage() {
  const data = await chrome.storage.local.get(OUTPUT_LANGUAGE_KEY);
  return data[OUTPUT_LANGUAGE_KEY] || "english";
}

export async function saveOutputLanguage(language) {
  await chrome.storage.local.set({ [OUTPUT_LANGUAGE_KEY]: language });
}

// AI message drafting settings. The API key is deliberately excluded from
// exportSettings/importSettings below - each installer (e.g. the wife's
// laptop) should use their own Anthropic key, not inherit whoever's key
// happened to be in the backup file.
const ANTHROPIC_API_KEY_KEY = "anthropicApiKey";

export async function getAnthropicApiKey() {
  const data = await chrome.storage.local.get(ANTHROPIC_API_KEY_KEY);
  return data[ANTHROPIC_API_KEY_KEY] || "";
}

export async function saveAnthropicApiKey(apiKey) {
  await chrome.storage.local.set({ [ANTHROPIC_API_KEY_KEY]: apiKey });
}

// Which wording/tone to use depends on how "warm" the relationship already
// is - a 1st-degree connection gets a casual note, a cold contact gets a
// softer, lower-pressure one, and a hiring/job-ad lead gets acknowledgment
// of what they're building out rather than a personal-post reference. IDs
// are fixed so the side panel can auto-pick the right one per lead; names
// and instructions are freely editable so this can match the salesperson's
// own voice.
const MESSAGE_TEMPLATES_KEY = "messageTemplates";
const DEFAULT_MESSAGE_TEMPLATES = [
  {
    id: "first-degree",
    name: "Already connected (1st-degree)",
    instructions:
      "You're already connected on LinkedIn with this person. Keep it warm, casual, and personal - like " +
      "messaging someone you already know, not a cold pitch. Reference their post naturally. No formal " +
      "introduction needed.",
  },
  {
    id: "warm-content",
    name: "Not yet connected",
    instructions:
      "You are not yet connected with this person. Be soft and low-pressure: briefly introduce yourself in " +
      "one clause, reference their specific post genuinely (not generically), and end with an open, " +
      "no-pressure question rather than a pitch or a meeting ask. Do not offer your own services or " +
      "capabilities as a value proposition, and do not position yourself as someone who could help with " +
      "their project - end with a genuine, curious question about what they built or why, not a soft pitch " +
      "or an offer to help.",
  },
  {
    id: "hiring-lead",
    name: "Hiring / job-ad lead",
    instructions:
      "This lead is a hiring post or job ad, not a personal opinion post. Acknowledge what they're building " +
      "out or hiring for specifically, and offer something genuinely useful rather than pitching a sale " +
      "outright.",
  },
];

export async function getMessageTemplates() {
  const data = await chrome.storage.local.get(MESSAGE_TEMPLATES_KEY);
  return data[MESSAGE_TEMPLATES_KEY] || DEFAULT_MESSAGE_TEMPLATES;
}

export async function saveMessageTemplates(templates) {
  await chrome.storage.local.set({ [MESSAGE_TEMPLATES_KEY]: templates });
}

// A short list of REAL things the salesperson can offer (an article link, a
// report, "free 20-minute demo"). The AI is instructed to only ever mention
// something from this list, verbatim, and never invent its own - an LLM
// asked to "offer something interesting" with no real options will happily
// hallucinate a report or link that doesn't exist.
const VALUE_ADD_OFFERS_KEY = "valueAddOffers";

export async function getValueAddOffers() {
  const data = await chrome.storage.local.get(VALUE_ADD_OFFERS_KEY);
  return data[VALUE_ADD_OFFERS_KEY] || [];
}

export async function saveValueAddOffers(offers) {
  await chrome.storage.local.set({ [VALUE_ADD_OFFERS_KEY]: offers });
}

// Negative ("block") topics: same shape and AND/OR keyword logic as a real
// search Topic (see getTopics/saveTopics below), but matched purely
// client-side against an already-scraped lead's own text instead of ever
// being sent to LinkedIn as a search query - a lead matching one is noise
// (a competitor, a recruiter filling a seat), never worth a salesperson's
// time. `appliesTo` ("post" | "job" | "both") matters because a signal that's
// noise on one vertical can be completely normal on the other - e.g. a job
// ad naming a recruiter/HR contact is normal, but an individual recruiter's
// own Post is noise, which is why the built-in recruiter topic below is
// post-only. Seeded with two topics the Sales Mentor itself suggested after
// reviewing a real scanned lead set - `builtin: true` just means the UI
// won't offer to remove them, their keywords stay fully editable, and a
// user can add their own topics alongside them for any other kind of noise.
const NEGATIVE_TOPICS_KEY = "negativeTopics";
const DEFAULT_NEGATIVE_TOPICS = [
  {
    id: "builtin-competitors",
    name: "Competitor Blocklist",
    // Deliberately excludes generic cloud/AI platform vendors (Microsoft,
    // Google, AWS, NVIDIA, etc.) - those get mentioned constantly as mere
    // tooling references in unrelated posts ("built on Azure," "runs on an
    // NVIDIA GPU"), which made this list kill a large share of genuinely
    // good leads. Keep this to firms that actually compete for the same
    // consulting/services work.
    keywords: [
      "BCG Platinion", "Deloitte", "EY", "Zühlke", "Eraneos", "valantic", "Capco", "Artefact", "Techyon",
    ],
    andKeywords: [],
    enabled: true,
    appliesTo: "both",
    builtin: true,
  },
  {
    id: "builtin-recruiters",
    name: "Recruiter/Staffing Headline Filter",
    keywords: ["Talent Acquisition", "Recruiter", "Recruitment", "Technology Resourcer", "Human Resources at"],
    andKeywords: [],
    enabled: true,
    appliesTo: "post",
    builtin: true,
  },
  {
    id: "builtin-recruiting-firms",
    name: "Known Recruiting Firms",
    // Matched against the lead's own `company` (see negativeTopicHaystack
    // below) - a far more precise signal than a headline/snippet keyword,
    // since it targets who the poster actually works for rather than
    // self-description text or a passing mention. Short canonical names, not
    // full legal names, so "Randstad" still matches "Randstad Switzerland."
    keywords: ["Adecco", "Randstad", "Michael Page", "PageGroup", "Swisslinx", "Robert Walters", "Hays"],
    andKeywords: [],
    enabled: true,
    appliesTo: "both",
    builtin: true,
  },
];

export async function getNegativeTopics() {
  const data = await chrome.storage.local.get([NEGATIVE_TOPICS_KEY, "competitorBlocklist", "recruiterHeadlineBlocklist"]);
  if (data[NEGATIVE_TOPICS_KEY]) return data[NEGATIVE_TOPICS_KEY];

  // One-time migration from the flat blocklists this replaced (a short-lived
  // earlier version of this same feature) - carries over any edits already
  // made there instead of silently resetting to the built-in defaults.
  if (data.competitorBlocklist || data.recruiterHeadlineBlocklist) {
    const migrated = DEFAULT_NEGATIVE_TOPICS.map((topic) => {
      if (topic.id === "builtin-competitors" && data.competitorBlocklist) return { ...topic, keywords: data.competitorBlocklist };
      if (topic.id === "builtin-recruiters" && data.recruiterHeadlineBlocklist) return { ...topic, keywords: data.recruiterHeadlineBlocklist };
      return topic;
    });
    await saveNegativeTopics(migrated);
    return migrated;
  }

  return DEFAULT_NEGATIVE_TOPICS;
}

export async function saveNegativeTopics(topics) {
  await chrome.storage.local.set({ [NEGATIVE_TOPICS_KEY]: topics });
}

// Shared with fullTopicMatchedKeywords/fullTopicMatchedJobKeywords in
// background.js, which tag scan results with which of a (positive) topic's
// keywords a post genuinely contains.
export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word match, not raw substring - a naive .includes() on a short
// keyword like "AI" also matches inside unrelated words (e.g. "AljurAId"),
// which is a real false-positive source for 2-3 letter terms.
export function containsWholeWord(haystackLower, keyword) {
  return new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`, "i").test(haystackLower);
}

// A job lead's searchable text is its title+company; a post lead's is its
// snippet+headline - the same fields (and the same word-boundary matching)
// a real search Topic would be checked against, so a negative topic behaves
// exactly like a familiar Topic, just inverted and applied after the fact.
function negativeTopicHaystack(lead) {
  return lead.type === "job"
    ? `${lead.title || ""} ${lead.company || ""}`
    // Post leads' `company` (AI-extracted or manually assigned, since v0.17.0)
    // is included here deliberately - a much more precise signal than
    // headline/snippet text alone. It's what makes a company-name-based
    // negative topic (e.g. a list of known recruiting firms, matched against
    // who the poster actually works for) meaningfully more reliable than a
    // generic keyword that can also match a mere passing mention.
    : `${lead.snippet || ""} ${lead.headline || ""} ${lead.company || ""}`;
}

// Returns the SPECIFIC keyword that matched (not just true/false) - a topic
// can hold several keywords, and knowing which one actually caught a lead
// is exactly what's needed to explain (and debug) an unexpected match, e.g.
// a lead still flagged Irrelevant after removing one keyword because a
// DIFFERENT keyword in the same topic independently matches it too.
function matchesNegativeTopic(lead, topic) {
  if (topic.enabled === false) return null;
  if (topic.appliesTo === "post" && lead.type === "job") return null;
  if (topic.appliesTo === "job" && lead.type !== "job") return null;
  if (!topic.keywords || topic.keywords.length === 0) return null; // unconfigured topic never matches
  const haystack = negativeTopicHaystack(lead).toLowerCase();
  const matchedKeyword = topic.keywords.find((kw) => containsWholeWord(haystack, kw));
  if (!matchedKeyword) return null;
  const andGroup = topic.andKeywords || [];
  const andMatch = andGroup.length === 0 || andGroup.some((kw) => containsWholeWord(haystack, kw));
  return andMatch ? matchedKeyword : null;
}

// Returns { topicName, keyword } for the first matching negative topic, or
// null if none match. Best-effort, not exact - a keyword that's a common
// word could over-match, which is exactly why this is reviewable/editable
// (via the Dashboard's status column) rather than a silent hard delete.
export function matchingNegativeTopicDetail(lead, negativeTopics) {
  for (const topic of negativeTopics || []) {
    const keyword = matchesNegativeTopic(lead, topic);
    if (keyword) return { topicName: topic.name, keyword };
  }
  return null;
}

// Thin boolean-ish wrapper (a non-empty string is truthy) for callers that
// only need the topic name, not which keyword within it matched.
export function matchingNegativeTopicName(lead, negativeTopics) {
  return matchingNegativeTopicDetail(lead, negativeTopics)?.topicName || "";
}

// The single-string format stored as a lead's irrelevantReason - shown
// verbatim as the Dashboard's hover tooltip, so it needs to name both the
// topic AND the specific keyword within it, not just the topic.
export function formatIrrelevantReason(detail) {
  return detail ? `${detail.topicName} (matched "${detail.keyword}")` : "";
}

// Re-checks every "New" or "Irrelevant" lead in resultsMap against the
// CURRENT negative topics and moves it whichever direction the current
// filters now say it belongs - New -> Irrelevant for a newly-caught match,
// and Irrelevant -> New for a lead that no longer matches anything (e.g. a
// topic was edited or removed since it was caught). Deliberately only ever
// touches these two statuses: anything the salesperson already acted on
// (Contacted, Dismissed, Responded, Converted) is a human decision and stays
// exactly as they left it, never silently overwritten in either direction.
// Mutates resultsMap in place; callers own reading/saving it (background.js
// re-applies this to its own in-memory scan state without an extra storage
// round-trip - see the "reapplyToExisting" step in scanAllTopics).
export function applyNegativeTopicsToResultsMap(resultsMap, negativeTopics) {
  const now = Date.now();
  let blockedCount = 0;
  let restoredCount = 0;
  let anyChanged = false;
  for (const lead of Object.values(resultsMap)) {
    if (lead.status === "New") {
      const detail = matchingNegativeTopicDetail(lead, negativeTopics);
      if (detail) {
        lead.status = "Irrelevant";
        lead.irrelevantReason = formatIrrelevantReason(detail);
        lead.statusUpdatedAt = now;
        blockedCount++;
        anyChanged = true;
      }
    } else if (lead.status === "Irrelevant") {
      const detail = matchingNegativeTopicDetail(lead, negativeTopics);
      if (!detail) {
        lead.status = "New";
        delete lead.irrelevantReason;
        lead.statusUpdatedAt = now;
        restoredCount++;
        anyChanged = true;
      } else {
        // Still Irrelevant, but refresh the reason in case a DIFFERENT
        // keyword/topic is what's matching now - e.g. the one that first
        // caught it was since removed, but another one in the same (or a
        // different) topic still catches it. Without this, the hover
        // tooltip could keep pointing at a keyword that no longer exists,
        // which is exactly what made this case confusing to debug. This
        // counts as a change too (anyChanged), even though neither
        // blockedCount nor restoredCount moves for it - those two only
        // track actual status transitions, not in-place reason refreshes,
        // so a caller that gates its save on "count > 0" would otherwise
        // silently compute the refresh and then never persist it.
        const refreshed = formatIrrelevantReason(detail);
        if (lead.irrelevantReason !== refreshed) {
          lead.irrelevantReason = refreshed;
          anyChanged = true;
        }
      }
    }
  }
  return { blockedCount, restoredCount, anyChanged };
}

// The Scanner tile's on-demand "Apply Negative Filters" button - the
// standalone, no-scan-needed way to run the bidirectional check above.
export async function reapplyBlocklist() {
  const [results, negativeTopics] = await Promise.all([getResults(), getNegativeTopics()]);
  const { blockedCount, restoredCount, anyChanged } = applyNegativeTopicsToResultsMap(results, negativeTopics);
  if (anyChanged) await saveResults(results);
  return { blockedCount, restoredCount };
}

// Persists a generated draft onto its lead so it survives closing/reopening
// the side panel, instead of being lost the moment the in-memory render is
// replaced by the next scan or reload.
export async function updateResultDraft(key, { draftMessage, draftTemplateId }) {
  const results = await getResults();
  if (results[key]) {
    results[key].draftMessage = draftMessage;
    results[key].draftTemplateId = draftTemplateId;
    results[key].draftGeneratedAt = Date.now();
    await saveResults(results);
  }
}

// Used by the Dashboard's status dropdown and its one-click Dismiss row
// action. Silently no-ops on an unknown key or status value rather than
// throwing, since this is always called from a UI that already has the
// current lead list in front of it.
export async function updateLeadStatus(key, status) {
  if (!LEAD_STATUSES.includes(status)) return;
  const results = await getResults();
  if (results[key]) {
    results[key].status = status;
    results[key].statusUpdatedAt = Date.now();
    await saveResults(results);
  }
}

// Used by the Dashboard's "Bulk Change" action - one read/write for the
// whole batch (e.g. "dismiss every currently-filtered low-priority lead")
// instead of N round-trips through updateLeadStatus. Records exactly what
// changed (see LAST_BULK_CHANGE_KEY below) so a mistaken bulk action can be
// undone - a real risk given how easy this is to trigger for a batch of
// leads at once. Returns how many leads actually existed and got changed.
const LAST_BULK_CHANGE_KEY = "lastBulkChange";

export async function bulkUpdateLeadStatus(keys, status) {
  if (!LEAD_STATUSES.includes(status)) return 0;
  const results = await getResults();
  const now = Date.now();
  const previousStatuses = {};
  let changed = 0;
  for (const key of keys) {
    if (results[key]) {
      previousStatuses[key] = results[key].status || "New";
      results[key].status = status;
      results[key].statusUpdatedAt = now;
      changed++;
    }
  }
  if (changed > 0) {
    await saveResults(results);
    await chrome.storage.local.set({
      [LAST_BULK_CHANGE_KEY]: { timestamp: now, newStatus: status, previousStatuses },
    });
  }
  return changed;
}

export async function getLastBulkChange() {
  const data = await chrome.storage.local.get(LAST_BULK_CHANGE_KEY);
  return data[LAST_BULK_CHANGE_KEY] || null;
}

// Restores every lead touched by the most recent bulkUpdateLeadStatus call
// to whatever status it had right before that change - a single level of
// undo, not a full history (matches "Undo last Bulk change", not "undo any
// past bulk change"). Clears the record afterward, so a second undo click
// has nothing left to do rather than re-applying the same restore.
export async function undoLastBulkChange() {
  const record = await getLastBulkChange();
  if (!record) return 0;
  const results = await getResults();
  const now = Date.now();
  let restored = 0;
  for (const [key, previousStatus] of Object.entries(record.previousStatuses)) {
    if (results[key]) {
      results[key].status = previousStatus;
      results[key].statusUpdatedAt = now;
      restored++;
    }
  }
  if (restored > 0) await saveResults(results);
  await chrome.storage.local.remove(LAST_BULK_CHANGE_KEY);
  return restored;
}

// Applies a batch of {key, priority, reason} results from agent-shared.js's
// prioritizeLeads() onto the actual stored leads - shared by background.js's
// automatic post-scan pass and the Dashboard's on-demand "Prioritize
// Unscored Leads" button, so both write priorities the exact same way. Not
// gated on current status here (the caller decides which leads to score in
// the first place) - just validates the priority itself is a real 1-5 value
// before writing it.
export async function applyLeadPriorities(priorities) {
  const results = await getResults();
  const scoredAt = Date.now();
  let changed = 0;
  for (const { key, priority, reason } of priorities) {
    if (results[key] && Number.isInteger(priority) && priority >= 1 && priority <= 5) {
      results[key].priority = priority;
      results[key].priorityReason = reason || "";
      results[key].priorityScoredAt = scoredAt;
      changed++;
    }
  }
  if (changed > 0) await saveResults(results);
  return changed;
}

// Lets the salesperson override a priority the Mentor got wrong (or set one
// on a lead that never got scored). Deliberately leaves priorityScoredAt
// unset/cleared - that field means "the AI scored this," and both the
// automatic per-scan pass (`!r.priority` filter) and the correlated
// re-scoring pass (which requires priorityScoredAt on an already-scored
// lead before adding it to the re-score batch) key off its presence, so a
// manual override can never be silently clobbered by either. An empty
// priority clears it back to unset, making the lead eligible for automatic
// scoring again.
export async function setLeadPriority(key, priority) {
  const results = await getResults();
  if (!results[key]) return;
  if (Number.isInteger(priority) && priority >= 1 && priority <= 5) {
    results[key].priority = priority;
    results[key].priorityReason = "Manually set by the salesperson.";
  } else {
    delete results[key].priority;
    delete results[key].priorityReason;
  }
  delete results[key].priorityScoredAt;
  await saveResults(results);
}

// Best-effort match key for grouping leads by company - not authoritative
// (e.g. "Azqore" vs "Azqore SA" collapse to the same key, but an unusual
// suffix this doesn't know about won't). Always show the lead's own raw
// `company` string alongside any grouping so a bad merge is still visible.
const COMPANY_SUFFIX_RE = /\s+(sa|ag|gmbh|inc|ltd|llc|corp|plc|co|sarl|srl|bv|nv|group|holding|holdings)\s*$/i;

export function normalizeCompanyName(name) {
  if (!name) return "";
  const collapsed = name.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  return collapsed.replace(COMPANY_SUFFIX_RE, "").trim();
}

// Applied by background.js after the batched AI company-extraction pass
// (agent-shared.js's extractCompaniesForLeads) - never overwrites a lead
// that already has a company, whether it was scraped (Job leads), extracted
// here before, or manually assigned via setLeadCompany below, so a scan can
// never clobber a human's correction.
export async function applyExtractedCompanies(entries) {
  const results = await getResults();
  const extractedAt = Date.now();
  let changed = 0;
  for (const { key, company } of entries) {
    const trimmed = (company || "").trim();
    if (results[key] && !results[key].company && trimmed) {
      results[key].company = trimmed;
      results[key].companyExtractedAt = extractedAt;
      changed++;
    }
  }
  if (changed > 0) await saveResults(results);
  return changed;
}

// Lets the salesperson correct or fill in a company the AI extraction got
// wrong or couldn't determine - takes precedence forever after, since
// applyExtractedCompanies above only ever touches leads with no company yet.
// An empty company clears it back to unset, making it eligible for
// extraction again on the next scan.
export async function setLeadCompany(key, company) {
  const results = await getResults();
  if (!results[key]) return;
  const trimmed = (company || "").trim();
  if (trimmed) {
    results[key].company = trimmed;
  } else {
    delete results[key].company;
  }
  delete results[key].companyExtractedAt; // no longer an AI guess either way
  await saveResults(results);
}

// Persists the Dashboard detail page's lead-scoped Sales Mentor conversation
// onto the lead itself, so it survives closing/reopening that lead - same
// pattern as updateResultDraft, just a different field.
export async function updateLeadMentorHistory(key, history) {
  const results = await getResults();
  if (results[key]) {
    results[key].mentorHistory = history;
    await saveResults(results);
  }
}

// Conversation history for the Sales Advisor agent, persisted so it
// survives closing/reopening the side panel. Stores raw Anthropic API
// message objects (including tool_use/tool_result blocks), not just display
// text - the API needs the exact prior structure to continue a tool-use
// conversation correctly.
const ADVISOR_HISTORY_KEY = "advisorHistory";

export async function getAdvisorHistory() {
  const data = await chrome.storage.local.get(ADVISOR_HISTORY_KEY);
  return data[ADVISOR_HISTORY_KEY] || [];
}

export async function saveAdvisorHistory(history) {
  await chrome.storage.local.set({ [ADVISOR_HISTORY_KEY]: history });
}

export async function clearAdvisorHistory() {
  await chrome.storage.local.set({ [ADVISOR_HISTORY_KEY]: [] });
}

// Same pattern as the Sales Mentor's history above, for the separate
// Customer Voice agent conversation.
const CUSTOMER_VOICE_HISTORY_KEY = "customerVoiceHistory";

export async function getCustomerVoiceHistory() {
  const data = await chrome.storage.local.get(CUSTOMER_VOICE_HISTORY_KEY);
  return data[CUSTOMER_VOICE_HISTORY_KEY] || [];
}

export async function saveCustomerVoiceHistory(history) {
  await chrome.storage.local.set({ [CUSTOMER_VOICE_HISTORY_KEY]: history });
}

export async function clearCustomerVoiceHistory() {
  await chrome.storage.local.set({ [CUSTOMER_VOICE_HISTORY_KEY]: [] });
}

// When the most recent scan started - lets the Dashboard flag which leads
// were first discovered by that specific scan (a persistent equivalent of
// the side panel's transient in-memory "NEW" badge, which only ever existed
// for the length of one side-panel session and never survived a reload).
const LAST_SCAN_STARTED_AT_KEY = "lastScanStartedAt";

export async function getLastScanStartedAt() {
  const data = await chrome.storage.local.get(LAST_SCAN_STARTED_AT_KEY);
  return data[LAST_SCAN_STARTED_AT_KEY] || 0;
}

export async function saveLastScanStartedAt(epochMs) {
  await chrome.storage.local.set({ [LAST_SCAN_STARTED_AT_KEY]: epochMs });
}

export async function getTopics() {
  const data = await chrome.storage.local.get(TOPICS_KEY);
  return data[TOPICS_KEY] || [];
}

export async function saveTopics(topics) {
  await chrome.storage.local.set({ [TOPICS_KEY]: topics });
}

// The set of values the Dashboard's status column/pie-charts understand.
// "New" is the default for every lead until a person (or the Dashboard's
// Dismiss action) sets it to something else. "Irrelevant" is the one status
// a person doesn't have to set by hand - a lead lands there automatically at
// scan time if it matches one of the negative topics below (distinct from
// "Dismissed", which is always a person's own decision).
export const LEAD_STATUSES = ["New", "Contacted", "Dismissed", "Responded", "Converted", "Irrelevant"];

export async function getResults() {
  const data = await chrome.storage.local.get(RESULTS_KEY);
  const results = data[RESULTS_KEY] || {};
  // Self-healing migration: `status` didn't exist before the Dashboard
  // feature, so any lead scraped before this shipped is missing it. Backfill
  // to "New" here (rather than a one-off migration script) so every reader
  // of getResults() - the side panel, the Dashboard, CSV export - always
  // sees a status-complete lead, and the fix persists after the first read.
  let healed = false;
  let negativeTopicsCache = null;
  for (const key of Object.keys(results)) {
    const lead = results[key];
    if (!lead.status) {
      lead.status = "New";
      healed = true;
    }
    // "Blocked" was renamed to "Irrelevant" (clearer distinction from
    // "Dismissed", which is always a person's own decision) - without this,
    // a lead scored before the rename would keep showing the old status
    // literal forever (no pie-chart color, no pill CSS, silently reappearing
    // in the Mentor's list_leads since that now only excludes "Irrelevant").
    if (lead.status === "Blocked") {
      lead.status = "Irrelevant";
      healed = true;
    }
    // Best-effort backfill for a lead marked Irrelevant before reason
    // tracking existed (including ones just migrated from "Blocked" above) -
    // re-checks against the CURRENT negative topics so the Dashboard's hover
    // tooltip has something to show. Stays blank if nothing matches anymore
    // (e.g. the topic that originally caught it was since edited or removed)
    // rather than guessing. Fetched lazily, once, only if actually needed.
    if (lead.status === "Irrelevant" && !lead.irrelevantReason) {
      if (!negativeTopicsCache) negativeTopicsCache = await getNegativeTopics();
      const detail = matchingNegativeTopicDetail(lead, negativeTopicsCache);
      if (detail) {
        lead.irrelevantReason = formatIrrelevantReason(detail);
        healed = true;
      }
    }
    // `postedAt` (an estimated real post date, parsed from LinkedIn's own
    // relative text) didn't exist before the Dashboard's pie charts needed
    // to bucket leads by real post age rather than scan/discovery date.
    // Best-effort backfill: parse the lead's stored relative-time text
    // against the last moment it was actually scraped (lastSeenAt) - the
    // closest available approximation to "now" at the time that text was
    // read - falling back to just using firstSeenAt as-is if parsing fails.
    if (!lead.postedAt) {
      const rawText = lead.type === "job" ? lead.postedText : lead.timestampText;
      const reference = lead.lastSeenAt || lead.firstSeenAt || Date.now();
      lead.postedAt = parseRelativeTimestamp(rawText, reference) || lead.firstSeenAt || reference;
      healed = true;
    }
  }
  if (healed) await saveResults(results);
  return results;
}

export async function saveResults(results) {
  await chrome.storage.local.set({ [RESULTS_KEY]: results });
}

// In-app audit trail of both user actions (topic edits, exports, scans
// clicked, lead status/priority changes...) and automatic extension actions
// (scan lifecycle, auto-prioritization, auto negative-topic filtering,
// errors) - so any of this is visible without opening the background
// service worker's DevTools console, which the user found unreliable
// (it clears itself when the worker goes idle). Written directly here from
// wherever each action actually happens, including inside background.js -
// NOT inferred from chrome.runtime.sendMessage broadcasts, which are lost
// entirely if no page happens to be listening (confirmed: background.js's
// scan-lifecycle messages have no storage-backed fallback today).
//
// Deliberately never manually clearable - this is the one place to
// investigate "what happened" after something looks wrong, so it must
// never be at risk of being wiped by mistake. Stored as one array per
// calendar day (activityLog:YYYY-MM-DD) rather than one giant array, and
// self-prunes anything older than the retention window on every write -
// a predictable "always the last 90 days" guarantee, not a raw entry-count
// cap that could silently drop recent history during a single unusually
// active day. Each day's own write only touches that day's (small) array,
// not the entire accumulated history.
const ACTIVITY_LOG_PREFIX = "activityLog:";
const LEGACY_ACTIVITY_LOG_KEY = "activityLog"; // pre-90-day-retention flat array (v0.26.0/0.26.1)
const ACTIVITY_LOG_RETENTION_DAYS = 90;

function activityLogDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${ACTIVITY_LOG_PREFIX}${y}-${m}-${d}`;
}

export async function appendActivityLog({ actor, action, label, prevValue, newValue, error, errorMessage }) {
  const now = new Date();
  const key = activityLogDayKey(now);
  const data = await chrome.storage.local.get(key);
  const dayLog = data[key] || [];
  dayLog.push({
    timestamp: now.getTime(),
    actor,
    action,
    label,
    prevValue: prevValue === undefined ? null : prevValue,
    newValue: newValue === undefined ? null : newValue,
    error: Boolean(error),
    errorMessage: errorMessage || null,
  });
  await chrome.storage.local.set({ [key]: dayLog });

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - ACTIVITY_LOG_RETENTION_DAYS);
  const cutoffKey = activityLogDayKey(cutoff);
  const all = await chrome.storage.local.get(null);
  const staleKeys = Object.keys(all).filter((k) => k.startsWith(ACTIVITY_LOG_PREFIX) && k < cutoffKey);
  if (staleKeys.length > 0) await chrome.storage.local.remove(staleKeys);
}

export async function getActivityLog() {
  const all = await chrome.storage.local.get(null);

  // One-time migration from the old flat single-key scheme - bucket each
  // existing entry by its own timestamp's local day, then remove the old
  // key so this only ever runs once.
  const legacy = all[LEGACY_ACTIVITY_LOG_KEY];
  if (Array.isArray(legacy) && legacy.length > 0) {
    const buckets = {};
    for (const entry of legacy) {
      const key = activityLogDayKey(new Date(entry.timestamp));
      (buckets[key] = buckets[key] || []).push(entry);
    }
    const toWrite = {};
    for (const key of Object.keys(buckets)) {
      toWrite[key] = [...(all[key] || []), ...buckets[key]].sort((a, b) => a.timestamp - b.timestamp);
    }
    await chrome.storage.local.set(toWrite);
    await chrome.storage.local.remove(LEGACY_ACTIVITY_LOG_KEY);
    Object.assign(all, toWrite);
    delete all[LEGACY_ACTIVITY_LOG_KEY];
  }

  const dayKeys = Object.keys(all).filter((k) => k.startsWith(ACTIVITY_LOG_PREFIX)).sort();
  const combined = [];
  for (const key of dayKeys) combined.push(...(all[key] || []));
  return combined;
}

// Exports configuration only (topics, filters, personas, etc.) - deliberately
// NOT the lead history, so restoring settings from an older backup can never
// roll back leads found/scored since then, and vice versa (see exportLeads).
// Chrome's local storage isn't a file the user can find or back up
// themselves, so this is the only way to not lose tuned keyword lists if the
// extension is ever uninstalled or the profile is reset.
//
// The API key is excluded by default (each installer should use their own),
// but includeApiKey lets it be included deliberately - e.g. sharing one
// spend-capped trial key across a small team before they get their own.
export async function exportSettings(includeApiKey = false) {
  const [
    topics,
    jobTopics,
    timeframe,
    authorTitles,
    includeJobAds,
    authorTitleEnabled,
    jobSearchEnabled,
    jobSearchUsePostTopics,
    jobSearchLocation,
    jobSearchLocationPresets,
    jobSearchTimeframe,
    messageTemplates,
    valueAddOffers,
    negativeTopics,
    companyContext,
    idealCustomerProfile,
    mentorPersona,
    customerPersona,
    outputLanguage,
    anthropicApiKey,
  ] = await Promise.all([
    getTopics(),
    getJobTopics(),
    getTimeframe(),
    getAuthorTitles(),
    getIncludeJobAds(),
    getAuthorTitleEnabled(),
    getJobSearchEnabled(),
    getJobSearchUsePostTopics(),
    getJobSearchLocation(),
    getJobSearchLocationPresets(),
    getJobSearchTimeframe(),
    getMessageTemplates(),
    getValueAddOffers(),
    getNegativeTopics(),
    getCompanyContext(),
    getIdealCustomerProfile(),
    getMentorPersona(),
    getCustomerPersona(),
    getOutputLanguage(),
    includeApiKey ? getAnthropicApiKey() : Promise.resolve(undefined),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    topics,
    jobTopics,
    timeframe,
    authorTitles,
    includeJobAds,
    authorTitleEnabled,
    jobSearchEnabled,
    jobSearchUsePostTopics,
    jobSearchLocation,
    jobSearchLocationPresets,
    jobSearchTimeframe,
    messageTemplates,
    valueAddOffers,
    negativeTopics,
    companyContext,
    idealCustomerProfile,
    mentorPersona,
    customerPersona,
    outputLanguage,
    ...(anthropicApiKey !== undefined ? { anthropicApiKey } : {}),
  };
}

// Exports every piece of accumulated, hard-to-reconstruct data - a separate
// file from exportSettings on purpose (configuration you'd deliberately set),
// so restoring one never touches the other. Leads (results, which already
// carries each lead's own per-lead mentorHistory), plus the generic
// cross-lead Sales Mentor and Customer Voice conversation histories - none
// of these can be regenerated by re-running a scan or re-typing a setting,
// which is exactly why they need to survive something wiping storage.
export async function exportLeads() {
  const [results, advisorHistory, customerVoiceHistory, lastScanStartedAt] = await Promise.all([
    getResults(),
    getAdvisorHistory(),
    getCustomerVoiceHistory(),
    getLastScanStartedAt(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    results,
    advisorHistory,
    customerVoiceHistory,
    lastScanStartedAt,
  };
}

export async function importSettings(data) {
  await Promise.all([
    saveTopics(data.topics || []),
    saveTimeframe(data.timeframe || "past-month"),
    saveAuthorTitles(data.authorTitles || []),
    saveIncludeJobAds(data.includeJobAds === undefined ? true : Boolean(data.includeJobAds)),
    saveAuthorTitleEnabled(data.authorTitleEnabled === undefined ? true : Boolean(data.authorTitleEnabled)),
    saveJobSearchEnabled(Boolean(data.jobSearchEnabled)),
    saveJobSearchLocation(data.jobSearchLocation || ""),
    ...(data.jobSearchLocationPresets ? [saveJobSearchLocationPresets(data.jobSearchLocationPresets)] : []),
    saveJobSearchTimeframe(data.jobSearchTimeframe || "past-month"),
    saveJobSearchUsePostTopics(
      data.jobSearchUsePostTopics === undefined ? true : Boolean(data.jobSearchUsePostTopics)
    ),
    saveJobTopics(data.jobTopics || []),
    ...(data.messageTemplates ? [saveMessageTemplates(data.messageTemplates)] : []),
    ...(data.valueAddOffers ? [saveValueAddOffers(data.valueAddOffers)] : []),
    ...(data.negativeTopics ? [saveNegativeTopics(data.negativeTopics)] : []),
    saveCompanyContext(data.companyContext || ""),
    saveIdealCustomerProfile(data.idealCustomerProfile || ""),
    ...(data.mentorPersona ? [saveMentorPersona(data.mentorPersona)] : []),
    saveCustomerPersona(data.customerPersona || ""),
    saveOutputLanguage(data.outputLanguage || "english"),
    // Only present if the exporter deliberately chose to include it (e.g.
    // sharing one spend-capped trial key across a small team) - never
    // overwrites an existing key with nothing if the import doesn't have one.
    ...(data.anthropicApiKey ? [saveAnthropicApiKey(data.anthropicApiKey)] : []),
  ]);
}

// Restores leads from a backup by MERGING, not replacing - a lead already
// present locally is left exactly as-is (its current status/priority/etc.
// are presumably more up to date than a snapshot taken earlier), and only a
// lead genuinely missing locally gets added back. This is a recovery tool
// for something unexpected wiping leads (there's no in-app action that does
// that deliberately), not a routine sync mechanism - a full replace would
// risk discarding real work done since the backup was taken.
export async function importLeads(data) {
  const backupResults = data.results || {};
  const currentResults = await getResults();
  let restored = 0;
  for (const [key, lead] of Object.entries(backupResults)) {
    if (!currentResults[key]) {
      currentResults[key] = lead;
      restored++;
    }
  }
  if (restored > 0) await saveResults(currentResults);

  // The two conversation histories and the last-scan timestamp aren't keyed
  // maps, so there's no per-entry merge to do - same "never clobber real
  // current data" principle as the leads merge above, applied at the whole-
  // value level: only restore one if there's genuinely nothing current to
  // protect (an empty history, a never-set timestamp).
  const [currentAdvisorHistory, currentCustomerVoiceHistory, currentLastScanStartedAt] = await Promise.all([
    getAdvisorHistory(),
    getCustomerVoiceHistory(),
    getLastScanStartedAt(),
  ]);
  if (currentAdvisorHistory.length === 0 && (data.advisorHistory || []).length > 0) {
    await saveAdvisorHistory(data.advisorHistory);
  }
  if (currentCustomerVoiceHistory.length === 0 && (data.customerVoiceHistory || []).length > 0) {
    await saveCustomerVoiceHistory(data.customerVoiceHistory);
  }
  if (!currentLastScanStartedAt && data.lastScanStartedAt) {
    await saveLastScanStartedAt(data.lastScanStartedAt);
  }

  return restored;
}

// LinkedIn shows a relative age ("2h", "3 days ago", "Posted 22 hours ago",
// occasionally doubled up as "22 hours ago22 hours ago") rather than a real
// date - there is no absolute post date anywhere in the page. This turns
// that display text into a best-effort real timestamp (epoch ms) by
// subtracting the parsed duration from referenceMs (the moment the text was
// actually scraped, i.e. "now" at scrape/merge time) - close enough for
// bucketing leads by real post age, which a raw relative string can't do at
// all. Returns null if the text doesn't match any known LinkedIn format.
const RELATIVE_TIME_UNIT_MS = {
  s: 1000, sec: 1000, second: 1000,
  m: 60 * 1000, min: 60 * 1000, minute: 60 * 1000,
  h: 60 * 60 * 1000, hr: 60 * 60 * 1000, hour: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000, day: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000, wk: 7 * 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000,
  mo: 30 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000, yr: 365 * 24 * 60 * 60 * 1000, year: 365 * 24 * 60 * 60 * 1000,
};

export function parseRelativeTimestamp(text, referenceMs) {
  if (!text) return null;
  if (/\bjust now\b|\bnow\b/i.test(text)) return referenceMs;
  const match = text.match(/(\d+)\s*(mo|month|min|minute|yr|year|wk|week|hr|hour|day|sec|second|[smhdwy])s?\b/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const ms = RELATIVE_TIME_UNIT_MS[match[2].toLowerCase()];
  if (!ms || !Number.isFinite(n)) return null;
  return referenceMs - n * ms;
}

// Merges freshly scraped posts for one topic into the existing results map.
// Keyed by post.key (the real post URL when LinkedIn exposes one, otherwise
// a profile+snippet fallback - see content-script.js). Mutates
// existingResults in place (matchedTopics/lastSeenAt on existing entries);
// returns the count of brand-new leads auto-marked Irrelevant by a negative
// topic on discovery, so a caller (background.js) can log one aggregate
// activity-log entry for the whole scan rather than one per lead - calling
// the (async, storage-backed) activity log once per matched post here would
// risk a lost-update race between concurrent read-modify-write cycles.
export function mergeTopicPosts(existingResults, topic, scrapedPosts, negativeTopics = []) {
  const now = Date.now();
  let newlyIrrelevantCount = 0;
  for (const post of scrapedPosts) {
    const existing = existingResults[post.key];
    const matchedKeywords = post.matchedKeywords || [];
    if (existing) {
      const topicMatch = existing.matchedTopics.find((t) => t.topicId === topic.id);
      if (topicMatch) {
        for (const kw of matchedKeywords) {
          if (!topicMatch.matchedKeywords.includes(kw)) topicMatch.matchedKeywords.push(kw);
        }
      } else {
        existing.matchedTopics.push({
          topicId: topic.id,
          topicName: topic.name,
          rank: post.rank,
          matchedKeywords,
        });
      }
      existing.lastSeenAt = now;
      existing.snippet = post.snippet || existing.snippet;
      existing.timestampText = post.timestampText || existing.timestampText;
      existing.connectionDegree = post.connectionDegree || existing.connectionDegree;
      // Recomputed from whatever fresh relative text this scan just read -
      // a fresh reading is generally at least as accurate as one computed
      // days ago, since LinkedIn's own relative display only gets coarser
      // with age (e.g. settles into "1w" instead of exact days).
      const reparsed = parseRelativeTimestamp(existing.timestampText, now);
      if (reparsed) existing.postedAt = reparsed;
    } else {
      const newLead = {
        key: post.key,
        postUrl: post.postUrl,
        author: post.author,
        profileUrl: post.profileUrl,
        headline: post.headline,
        snippet: post.snippet,
        timestampText: post.timestampText,
        isJobAd: post.isJobAd,
        isHiringPost: post.isHiringPost,
        isFreelancePost: post.isFreelancePost,
        connectionDegree: post.connectionDegree || null,
        status: "New",
        firstSeenAt: now,
        lastSeenAt: now,
        postedAt: parseRelativeTimestamp(post.timestampText, now) || now,
        matchedTopics: [{ topicId: topic.id, topicName: topic.name, rank: post.rank, matchedKeywords }],
      };
      const negativeTopicMatch = matchingNegativeTopicDetail(newLead, negativeTopics);
      if (negativeTopicMatch) {
        newLead.status = "Irrelevant";
        newLead.irrelevantReason = formatIrrelevantReason(negativeTopicMatch);
        newlyIrrelevantCount++;
      }
      existingResults[post.key] = newLead;
    }
  }
  return newlyIrrelevantCount;
}

// Same merge/dedupe pattern as mergeTopicPosts, but for job listings scraped
// from LinkedIn's Jobs vertical - a different lead shape (title/company/
// location instead of author/snippet), stored in the same results map with
// type: "job" so both kinds show up together in one merged, ranked list.
export function mergeJobPosts(existingResults, topic, scrapedJobs, negativeTopics = []) {
  const now = Date.now();
  let newlyIrrelevantCount = 0;
  for (const job of scrapedJobs) {
    const existing = existingResults[job.key];
    const matchedKeywords = job.matchedKeywords || [];
    if (existing) {
      const topicMatch = existing.matchedTopics.find((t) => t.topicId === topic.id);
      if (topicMatch) {
        for (const kw of matchedKeywords) {
          if (!topicMatch.matchedKeywords.includes(kw)) topicMatch.matchedKeywords.push(kw);
        }
      } else {
        existing.matchedTopics.push({
          topicId: topic.id,
          topicName: topic.name,
          rank: job.rank,
          matchedKeywords,
        });
      }
      existing.lastSeenAt = now;
      existing.postedText = job.postedText || existing.postedText;
      const reparsed = parseRelativeTimestamp(existing.postedText, now);
      if (reparsed) existing.postedAt = reparsed;
    } else {
      const newLead = {
        key: job.key,
        type: "job",
        title: job.title,
        company: job.company,
        location: job.location,
        postedText: job.postedText,
        jobUrl: job.jobUrl,
        status: "New",
        firstSeenAt: now,
        lastSeenAt: now,
        postedAt: parseRelativeTimestamp(job.postedText, now) || now,
        matchedTopics: [{ topicId: topic.id, topicName: topic.name, rank: job.rank, matchedKeywords }],
      };
      const negativeTopicMatch = matchingNegativeTopicDetail(newLead, negativeTopics);
      if (negativeTopicMatch) {
        newLead.status = "Irrelevant";
        newLead.irrelevantReason = formatIrrelevantReason(negativeTopicMatch);
        newlyIrrelevantCount++;
      }
      existingResults[job.key] = newLead;
    }
  }
  return newlyIrrelevantCount;
}
