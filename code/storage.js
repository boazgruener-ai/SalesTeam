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

// The salesperson's own company website - added to the onboarding wizard
// (Phase 2) as groundwork for a future AI-assisted draft of Company
// Context/Ideal Customer Profile from the site's own content (not built
// yet - this just captures the URL so that future pass has something to
// read).
const COMPANY_WEBSITE_KEY = "companyWebsite";

export async function getCompanyWebsite() {
  const data = await chrome.storage.local.get(COMPANY_WEBSITE_KEY);
  return data[COMPANY_WEBSITE_KEY] || "";
}

export async function saveCompanyWebsite(website) {
  await chrome.storage.local.set({ [COMPANY_WEBSITE_KEY]: website });
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

// ---------------------------------------------------------------------
// Onboarding wizard (Discovery Phase 1/2) - captures what a Discovery scan
// (Phase 5/6, not yet built) should search for. Each key below follows this
// file's existing per-concern get/save pattern; see PRD 6.20 and the plan
// file for the full feature this scaffolds.

// Which companies to search for. Deliberately reuses locationFilterConfig's
// own {mode, continents, countries} shape for the location piece (below) -
// same concept, restricted at the UI level to whatever geo-urn-map.js has a
// confirmed geoUrn for, since (unlike Location Filter, which only classifies
// already-scraped text) this one has to build a real LinkedIn search facet.
const TARGET_UNIVERSE_CONFIG_KEY = "targetUniverseConfig";
const DEFAULT_TARGET_UNIVERSE_CONFIG = {
  locationMode: "country", continents: [], countries: [],
  sizeMode: "topN", topN: 200, minEmployees: null, maxEmployees: null,
  maxCompanies: 200, industries: [],
};

export async function getTargetUniverseConfig() {
  const data = await chrome.storage.local.get(TARGET_UNIVERSE_CONFIG_KEY);
  return { ...DEFAULT_TARGET_UNIVERSE_CONFIG, ...(data[TARGET_UNIVERSE_CONFIG_KEY] || {}) };
}

export async function saveTargetUniverseConfig(config) {
  await chrome.storage.local.set({ [TARGET_UNIVERSE_CONFIG_KEY]: config });
}

// Who to look for once a target company is found - distinct from Topics'
// keywords/andKeywords (sidepanel.js), which match post content, not a
// person's title.
const TARGET_CONTACT_PROFILE_KEY = "targetContactProfile";
const DEFAULT_TARGET_CONTACT_PROFILE = { exactTitles: [], titleKeywords: [] };

export async function getTargetContactProfile() {
  const data = await chrome.storage.local.get(TARGET_CONTACT_PROFILE_KEY);
  return { ...DEFAULT_TARGET_CONTACT_PROFILE, ...(data[TARGET_CONTACT_PROFILE_KEY] || {}) };
}

export async function saveTargetContactProfile(profile) {
  await chrome.storage.local.set({ [TARGET_CONTACT_PROFILE_KEY]: profile });
}

// The user's own ranked T-shirt-size priority guideline, feeding a future
// company-scoring pass (PRD 6.20 Phase 8, not yet built).
const ACCOUNT_PRIORITY_GUIDELINES_KEY = "accountPriorityGuidelines";
const DEFAULT_ACCOUNT_PRIORITY_GUIDELINES = {
  criteriaOrder: ["size", "location", "industry"],
  topSize: null, topLocations: [], topIndustries: [],
};

export async function getAccountPriorityGuidelines() {
  const data = await chrome.storage.local.get(ACCOUNT_PRIORITY_GUIDELINES_KEY);
  return { ...DEFAULT_ACCOUNT_PRIORITY_GUIDELINES, ...(data[ACCOUNT_PRIORITY_GUIDELINES_KEY] || {}) };
}

export async function saveAccountPriorityGuidelines(guidelines) {
  await chrome.storage.local.set({ [ACCOUNT_PRIORITY_GUIDELINES_KEY]: guidelines });
}

// LinkedIn company-page slugs (e.g. "neoxam") to exclude from Discovery
// results - deliberately identity-based, not name-based, to sidestep the
// legal-suffix/short-name/misspelling mess 6.16's resolver already had to
// solve for a different reason. See parseLinkedinCompanySlug below for how
// a pasted URL becomes one of these.
const COMPETITOR_COMPANY_SLUGS_KEY = "competitorCompanySlugs";

export async function getCompetitorCompanySlugs() {
  const data = await chrome.storage.local.get(COMPETITOR_COMPANY_SLUGS_KEY);
  return data[COMPETITOR_COMPANY_SLUGS_KEY] || [];
}

export async function saveCompetitorCompanySlugs(slugs) {
  await chrome.storage.local.set({ [COMPETITOR_COMPANY_SLUGS_KEY]: slugs });
}

// Same identity-based exclusion as competitorCompanySlugs above, same
// reason (a recruiter's name is just as prone to legal-suffix/short-name
// mismatches), but kept as its own separate list rather than merged -
// mirrors how the *existing* Negative Topics feature (6.2) already keeps
// "Competitor Blocklist" and "Known Recruiting Firms" as two distinct
// named lists, not one, so a future "why was this excluded" view stays
// meaningful. Not the same mechanism as that existing feature, though -
// this one is for the new Discovery company-search step (Phase 5, not yet
// built), which scrapes Company Search cards directly; Negative Topics
// text-matches already-scraped Post/Job leads, a different pipeline
// entirely.
const RECRUITER_COMPANY_SLUGS_KEY = "recruiterCompanySlugs";

// Well-known global staffing/recruiting/executive-search firms, seeded so
// the onboarding wizard's Recruiters step (Phase 2) only asks the user to
// add local ones - each slug confirmed live against a real LinkedIn company
// page, per this project's "never guess a LinkedIn URL" discipline (one
// name, "Panda International," has an unrelated same-named company; the
// slug here is the verified Staffing and Recruiting one, not a guess).
export const DEFAULT_RECRUITER_COMPANY_SLUGS = [
  "adecco", "michael-page", "robert-walters", "hays", "harvey-nash", "manpowergroup",
  "heidrick-&-struggles", "spencer-stuart", "lionstep", "panda-international", "jobgether",
];

export async function getRecruiterCompanySlugs() {
  const data = await chrome.storage.local.get(RECRUITER_COMPANY_SLUGS_KEY);
  return data[RECRUITER_COMPANY_SLUGS_KEY] || null;
}

export async function saveRecruiterCompanySlugs(slugs) {
  await chrome.storage.local.set({ [RECRUITER_COMPANY_SLUGS_KEY]: slugs });
}

// Gates whether the onboarding wizard is required (background.js's
// onInstalled) and whether a Discovery scan is allowed to start
// (sidepanel.js/target-accounts.js). null until every wizard step has been
// walked through and confirmed at least once.
const ONBOARDING_COMPLETED_AT_KEY = "onboardingCompletedAt";

export async function getOnboardingCompletedAt() {
  const data = await chrome.storage.local.get(ONBOARDING_COMPLETED_AT_KEY);
  return data[ONBOARDING_COMPLETED_AT_KEY] || null;
}

export async function markOnboardingCompleted() {
  const completedAt = Date.now();
  await chrome.storage.local.set({ [ONBOARDING_COMPLETED_AT_KEY]: completedAt });
  return completedAt;
}

// Reported directly: a real completed run took "tens of minutes to several
// hours" (25+ competitor LinkedIn URLs alone was the slowest part), so
// losing progress on an accidental tab close is a real cost, not a
// hypothetical one. Every step already auto-saves its own real value as
// soon as it's entered (below) - this just remembers which step to land on
// when the wizard is reopened, so a user isn't forced back through steps
// they already did. Not a distinct "Save Draft" action - consistent with
// this codebase's existing auto-save-always convention (e.g. Settings),
// saving happens continuously and reopening the page is itself "resume."
const ONBOARDING_PROGRESS_STEP_KEY = "onboardingProgressStepIndex";

export async function getOnboardingProgressStepIndex() {
  const data = await chrome.storage.local.get(ONBOARDING_PROGRESS_STEP_KEY);
  return data[ONBOARDING_PROGRESS_STEP_KEY] || 0;
}

export async function saveOnboardingProgressStepIndex(index) {
  await chrome.storage.local.set({ [ONBOARDING_PROGRESS_STEP_KEY]: index });
}

// Parses a pasted LinkedIn company-page URL down to its slug ("neoxam" from
// "https://www.linkedin.com/company/neoxam/about/?trk=..."), tolerating a
// missing protocol, a trailing sub-path, and query/hash noise. A LinkedIn
// company page can also be addressed by pure numeric ID instead of a slug
// (e.g. "/company/1035/") - returned as-is, since Phase 5's own card-scraped
// "slug" for such a company would equally just be that same numeric string,
// so the exact-match comparison still works either way. Returns null (never
// a guess) for anything that isn't recognizably a /company/<id-or-slug>/ URL.
export function parseLinkedinCompanySlug(url) {
  if (!url) return null;
  const match = String(url).trim().match(/linkedin\.com\/company\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
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

// A curated, slow-moving list of target companies (name, AI-priority score/
// label, industry, top AI initiatives) imported from an external research
// workbook, converted to JSON via code/convert_target_accounts.py. Keyed by
// normalizeCompanyName() (below) so a scanned lead's company field - however
// it was capitalized/punctuated - can be looked up directly. Re-imported
// wholesale every time the source workbook is refreshed (every few months),
// never merged incrementally.
const TARGET_ACCOUNTS_KEY = "targetAccounts";
const TARGET_ACCOUNTS_IMPORTED_AT_KEY = "targetAccountsImportedAt";
// v0.29.38: reported directly - re-importing a refreshed workbook multiple
// times in one day left an ambiguous "500 companies imported · Sep 9, 2026"
// status with no way to tell a just-finished import from a stale one hours
// earlier (date-only, no time) or confirm which of several similarly-named
// files was actually picked up. Stored alongside importedAt so Settings can
// show both.
const TARGET_ACCOUNTS_IMPORTED_FILENAME_KEY = "targetAccountsImportedFileName";
const TARGET_ACCOUNT_SCORE_THRESHOLD_KEY = "targetAccountScoreThreshold";
const DEFAULT_TARGET_ACCOUNT_SCORE_THRESHOLD = 70;

export async function importTargetAccounts(list, fileName = null) {
  // Carries a company's resolved LinkedIn ID (6.16) forward across a
  // wholesale re-import - reported directly as a real risk: this map is
  // rebuilt from scratch every import (by design, since the research
  // workbook itself is the source of truth for score/label/etc.), but a
  // company's LinkedIn ID is durable data that has nothing to do with
  // whatever changed in a refreshed workbook. Without this, refreshing the
  // workbook (or re-importing to pick up a newly-included company) would
  // silently discard every ID a resolver run had already found, forcing a
  // full re-resolution of the entire list every time.
  const previousMap = await getTargetAccounts();
  const map = {};
  for (const entry of list || []) {
    const key = normalizeCompanyName(entry.company);
    if (!key) continue;
    map[key] = {
      company: entry.company,
      industry: entry.industry || null,
      score: typeof entry.score === "number" ? entry.score : null,
      priorityLabel: entry.priorityLabel || null,
      researchStatus: entry.researchStatus || null,
      topInitiatives: entry.topInitiatives || null,
      // v0.29.37, see PRD 6.16: unlike linkedinCompanyId below, this comes
      // straight from the workbook (a Zefix cross-check done outside the
      // extension) and is refreshed on every import same as company/score/
      // etc. - no carry-forward needed, the workbook is the source of truth.
      officialName: entry.officialName || null,
      // v0.29.42, see PRD 6.16: two more workbook columns from the same
      // external cross-check - alternativeName (a commonly-used short/
      // acronym form, e.g. a cantonal bank's own initials) and linkedinLink
      // (a human/AI-verified LinkedIn company-page URL). Refreshed on every
      // import same as officialName above, for the same reason - the
      // workbook is the source of truth for all three.
      alternativeName: entry.alternativeName || null,
      linkedinLink: entry.linkedinLink || null,
      ...(previousMap[key]?.linkedinCompanyId ? { linkedinCompanyId: previousMap[key].linkedinCompanyId } : {}),
      // v0.29.39, see PRD 6.16: same durable-across-reimport treatment as
      // linkedinCompanyId above, for the same reason - a resolver run's
      // history has nothing to do with what changed in a refreshed
      // workbook.
      ...(previousMap[key]?.linkedinResolveAttemptedAt
        ? { linkedinResolveAttemptedAt: previousMap[key].linkedinResolveAttemptedAt }
        : {}),
    };
  }
  const importedAt = Date.now();
  await chrome.storage.local.set({
    [TARGET_ACCOUNTS_KEY]: map,
    [TARGET_ACCOUNTS_IMPORTED_AT_KEY]: importedAt,
    [TARGET_ACCOUNTS_IMPORTED_FILENAME_KEY]: fileName || null,
  });
  return { count: Object.keys(map).length, importedAt };
}

export async function getTargetAccounts() {
  const data = await chrome.storage.local.get(TARGET_ACCOUNTS_KEY);
  return data[TARGET_ACCOUNTS_KEY] || {};
}

export async function getTargetAccountsMeta() {
  const data = await chrome.storage.local.get([TARGET_ACCOUNTS_KEY, TARGET_ACCOUNTS_IMPORTED_AT_KEY, TARGET_ACCOUNTS_IMPORTED_FILENAME_KEY]);
  const map = data[TARGET_ACCOUNTS_KEY] || {};
  return {
    count: Object.keys(map).length,
    importedAt: data[TARGET_ACCOUNTS_IMPORTED_AT_KEY] || null,
    importedFileName: data[TARGET_ACCOUNTS_IMPORTED_FILENAME_KEY] || null,
  };
}

// EXPERIMENTAL (v0.29.25, see PRD 6.16): resolves a Target Account company's
// name to its LinkedIn numeric company ID (the same kind of ID
// authorCompany expects on a Post search, and geoUrn expects for a
// location - confirmed live against a real "currentCompany=[...]" link the
// user found in a real search results page, not guessed). Companies already
// resolved are skipped so a run only ever costs one visit per company, ever.
//
// Reported directly (v0.29.39): a company that fails stays "missing"
// forever, with nothing distinguishing "never tried" from "tried and
// failed" - since a "Limit to N" run always draws from the front of this
// same list in the same order, a handful of genuinely stubborn companies
// (a translated name, an acronym LinkedIn shows instead of the full name,
// etc.) kept consuming the whole budget of every run, before ever reaching
// a fresh, never-attempted company further down the list. Never-attempted
// companies (no linkedinResolveAttemptedAt - see markLinkedinResolveAttempted
// below) now sort first, so a run makes real forward progress through the
// full list before it ever revisits a known-stubborn one a second time;
// once every company has been attempted at least once, this naturally
// falls through to offering the stubborn remainder for retry/analysis,
// oldest-attempt-first (so a company isn't retried again and again ahead
// of one that's had a single attempt).
export async function getTargetAccountsMissingLinkedinId() {
  const map = await getTargetAccounts();
  return Object.entries(map)
    .filter(([, v]) => !v.linkedinCompanyId)
    .map(([key, v]) => ({
      key,
      company: v.company,
      officialName: v.officialName || null,
      alternativeName: v.alternativeName || null,
      linkedinLink: v.linkedinLink || null,
      attemptedAt: v.linkedinResolveAttemptedAt || null,
    }))
    .sort((a, b) => (a.attemptedAt || 0) - (b.attemptedAt || 0));
}

// Called after a resolver run with every company key it actually attempted
// (regardless of outcome - success, "no confident match," or a hard
// timeout all count as an attempt) - see getTargetAccountsMissingLinkedinId
// above for why this exists. Separate from applyResolvedCompanyIds (which
// only ever hears about successes) since a failed attempt still needs to
// stop being treated as "never tried."
export async function markLinkedinResolveAttempted(keys) {
  const map = await getTargetAccounts();
  const attemptedAt = Date.now();
  let marked = 0;
  for (const key of keys || []) {
    if (!map[key]) continue;
    map[key].linkedinResolveAttemptedAt = attemptedAt;
    marked++;
  }
  if (marked > 0) await chrome.storage.local.set({ [TARGET_ACCOUNTS_KEY]: map });
  return marked;
}

export async function applyResolvedCompanyIds(resolutions) {
  const map = await getTargetAccounts();
  let updated = 0;
  for (const r of resolutions) {
    if (!r.linkedinCompanyId || !map[r.key]) continue;
    map[r.key].linkedinCompanyId = r.linkedinCompanyId;
    updated++;
  }
  if (updated > 0) await chrome.storage.local.set({ [TARGET_ACCOUNTS_KEY]: map });
  return updated;
}

export async function getTargetAccountScoreThreshold() {
  const data = await chrome.storage.local.get(TARGET_ACCOUNT_SCORE_THRESHOLD_KEY);
  const value = data[TARGET_ACCOUNT_SCORE_THRESHOLD_KEY];
  return typeof value === "number" ? value : DEFAULT_TARGET_ACCOUNT_SCORE_THRESHOLD;
}

export async function saveTargetAccountScoreThreshold(threshold) {
  await chrome.storage.local.set({ [TARGET_ACCOUNT_SCORE_THRESHOLD_KEY]: threshold });
}

// The full relational slice of the workbook (Companies/Contacts/
// AI_Initiatives/AI_Investment/Sources - see xlsx-lite.js's
// parseFullTargetAccountsWorkbook and PRD 6.12), for the Target Accounts
// Explorer page. Deliberately separate from targetAccounts above: that map
// is the small, normalized-name-keyed projection auto-prioritization
// actually needs (6.11); this is the full browsable dataset, keyed by
// Company_ID as the workbook itself does, for the Explorer's company ->
// contacts/initiatives drill-down. Both are populated from the same Settings
// import action, in one pass over the same file.
const TARGET_ACCOUNTS_WORKBOOK_KEY = "targetAccountsWorkbook";
const TARGET_ACCOUNTS_WORKBOOK_IMPORTED_AT_KEY = "targetAccountsWorkbookImportedAt";

// The Contacts sheet schema has changed across three successive workbook
// exports so far - each normalized here, once, at import time, rather than
// in every place that reads lastVerified2, so a contact from any of the
// three ends up with the same shape and CONTACT_COLUMNS/CONTACT_LIST_COLUMNS/
// renderContactView (target-accounts.js) don't need to know which version
// produced it:
//  1. Original: two colliding "Last_Verified"/"Evidence_Quality" header
//     pairs, which xlsx-lite.js's parseGenericSheetRows suffixed apart into
//     lastVerified2/evidenceQuality2 (the real LinkedIn-verification pair) -
//     no normalization needed, already the field this code reads.
//  2. v24/v25: the duplicate pair dropped, replaced by a single dedicated
//     LinkedIn_Profile_URL column (camelCased to linkedinProfileUrl).
//  3. v28 (reported directly): LinkedIn_Profile_URL removed again, and
//     Source_URL removed too - every contact's LinkedIn link is now
//     consolidated into Profile_URL itself, which up to v25 held the
//     company's own bio page instead.
// Schema 3 can't be told apart from a schema-1/2 row with a blank
// Source_URL cell by looking at one row alone (a blank cell may not even
// appear as a key on that row - see xlsx-lite.js), so the presence of the
// sourceUrl/linkedinProfileUrl columns is checked across the whole contacts
// array, once per import, rather than per row. Schema 2's evidenceQuality2
// status text (e.g. "Current - LinkedIn verified") has no equivalent in
// schema 2 or 3 and is left blank rather than invented.
function normalizeContactRows(contacts) {
  const hasLinkedinProfileUrlColumn = contacts.some((c) => "linkedinProfileUrl" in c);
  const hasSourceUrlColumn = contacts.some((c) => "sourceUrl" in c);
  const linkedinConsolidatedIntoProfileUrl = !hasLinkedinProfileUrlColumn && !hasSourceUrlColumn;
  return contacts.map((contact) => {
    if (contact.lastVerified2 != null) return contact;
    if (contact.linkedinProfileUrl) {
      return { ...contact, lastVerified2: contact.linkedinProfileUrl };
    }
    if (linkedinConsolidatedIntoProfileUrl && contact.profileUrl) {
      // profileUrl no longer represents a distinct "bio page" separate from
      // the LinkedIn link in this schema - blanked here too so the "Bio
      // Page" column doesn't show the identical URL a second time under a
      // now-inaccurate label.
      return { ...contact, lastVerified2: contact.profileUrl, profileUrl: null };
    }
    return contact;
  });
}

export async function importTargetAccountsWorkbook(sheets) {
  const importedAt = Date.now();
  const normalized = {
    ...sheets,
    contacts: normalizeContactRows(sheets.contacts || []),
  };
  await chrome.storage.local.set({
    [TARGET_ACCOUNTS_WORKBOOK_KEY]: normalized,
    [TARGET_ACCOUNTS_WORKBOOK_IMPORTED_AT_KEY]: importedAt,
  });
  return { count: (sheets.companies || []).length, importedAt };
}

export async function getTargetAccountsWorkbook() {
  const data = await chrome.storage.local.get(TARGET_ACCOUNTS_WORKBOOK_KEY);
  return data[TARGET_ACCOUNTS_WORKBOOK_KEY] || { companies: [], contacts: [], aiInitiatives: [], aiInvestment: [], sources: [] };
}

export async function getTargetAccountsWorkbookMeta() {
  const data = await chrome.storage.local.get([TARGET_ACCOUNTS_WORKBOOK_KEY, TARGET_ACCOUNTS_WORKBOOK_IMPORTED_AT_KEY]);
  const sheets = data[TARGET_ACCOUNTS_WORKBOOK_KEY];
  return {
    count: sheets ? (sheets.companies || []).length : 0,
    importedAt: data[TARGET_ACCOUNTS_WORKBOOK_IMPORTED_AT_KEY] || null,
  };
}

// A standalone backup/restore pair for the Settings page's own Export/Import
// Target Accounts buttons - distinct from importTargetAccounts(list) above,
// which re-derives normalized keys from a plain company list. This restores
// the already-keyed map and the full Explorer workbook exactly as they were,
// so re-importing a research workbook isn't the only way to recover this data
// after e.g. clearing browser storage or moving to a new machine.
export async function exportTargetAccountsBackup() {
  const [targetAccounts, targetAccountsMeta, targetAccountsWorkbook, workbookMeta, targetAccountScoreThreshold] =
    await Promise.all([
      getTargetAccounts(),
      getTargetAccountsMeta(),
      getTargetAccountsWorkbook(),
      getTargetAccountsWorkbookMeta(),
      getTargetAccountScoreThreshold(),
    ]);
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    targetAccounts,
    targetAccountsImportedAt: targetAccountsMeta.importedAt,
    targetAccountsImportedFileName: targetAccountsMeta.importedFileName,
    targetAccountsWorkbook,
    targetAccountsWorkbookImportedAt: workbookMeta.importedAt,
    targetAccountScoreThreshold,
  };
}

export async function importTargetAccountsBackup(data) {
  await chrome.storage.local.set({
    [TARGET_ACCOUNTS_KEY]: data.targetAccounts || {},
    [TARGET_ACCOUNTS_IMPORTED_AT_KEY]: data.targetAccountsImportedAt || null,
    [TARGET_ACCOUNTS_IMPORTED_FILENAME_KEY]: data.targetAccountsImportedFileName || null,
    [TARGET_ACCOUNTS_WORKBOOK_KEY]:
      data.targetAccountsWorkbook || { companies: [], contacts: [], aiInitiatives: [], aiInvestment: [], sources: [] },
    [TARGET_ACCOUNTS_WORKBOOK_IMPORTED_AT_KEY]: data.targetAccountsWorkbookImportedAt || null,
  });
  if (typeof data.targetAccountScoreThreshold === "number") {
    await saveTargetAccountScoreThreshold(data.targetAccountScoreThreshold);
  }
  return {
    count: Object.keys(data.targetAccounts || {}).length,
    workbookCount: (data.targetAccountsWorkbook?.companies || []).length,
  };
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
      "BCG Platinion", "Deloitte", "EY", "PwC", "KPMG", "Accenture", "McKinsey", "Bain", "Zühlke", "Eraneos",
      "valantic", "Capco", "Artefact", "Techyon",
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
    // matchField: "company" makes this actually match ONLY the lead's own
    // `company` field, not a mere mention in a post's snippet/headline - the
    // precision this topic's whole premise depends on ("who the poster
    // actually works for," not self-description text or a passing mention).
    // Also gets the fuzzy suffix-stripped comparison from
    // matchesCompanyKeyword (below), so a short canonical name like
    // "Randstad" matches "Randstad Switzerland," "Randstad AG," etc. in
    // either direction without needing every legal variant spelled out.
    keywords: ["Adecco", "Randstad", "Michael Page", "PageGroup", "Swisslinx", "Robert Walters", "Hays"],
    andKeywords: [],
    enabled: true,
    appliesTo: "both",
    matchField: "company",
    builtin: true,
  },
  {
    id: "builtin-ai-vendors",
    name: "AI/Cloud Vendor Blocklist",
    // These are exactly the vendors builtin-competitors above deliberately
    // EXCLUDES, and for the same underlying reason free-text mentions of
    // them are noisy ("built on Azure," "runs on an NVIDIA GPU") - but a
    // company-scoped match sidesteps that entirely: matchField: "company"
    // means this only ever compares against the lead's own employer, never
    // post/job text, so it can safely block leads who actually work AT one
    // of these vendors (not competitors, but still not this project's ICP)
    // without resurrecting the tooling-mention false positives.
    keywords: ["Google", "Microsoft", "Amazon", "AWS", "NVIDIA", "IBM", "Oracle", "SAP", "Salesforce", "Meta", "OpenAI"],
    andKeywords: [],
    enabled: true,
    appliesTo: "both",
    matchField: "company",
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
//
// Below MIN_LENGTH_FOR_PREFIX_MATCH, both ends require a real word boundary
// (unchanged behavior) - short acronyms (AI, KI, ROI, GPT, LLM, PoC...) are
// exactly as long as plenty of unrelated whole words (Aid, Air, Kind, Kiste,
// Pod) that would become false positives the moment the trailing boundary is
// dropped. At or above it, only the LEADING boundary is required, so one
// root keyword also matches its own plurals and common conjugations (e.g.
// "pilot" -> "pilots", "engineer" -> "engineers"/"engineering", "transform"
// -> "transformation"/"transformations", German "Ingenieur" -> "Ingenieur/
// e/in/innen/wesen/wissenschaften") without maintaining a separate keyword
// entry per grammatical form. Reported directly (2026-09): two genuinely
// on-topic Holcim posts (Lily Wong, AI leadership) were silently missed by
// an AND-topic's activity-group check purely because the post used "use
// cases"/"pilots" (plural) against configured "use case"/"pilot" (singular)
// - a real, general gap, not a one-off. Known tradeoff: a keyword like
// "Prompt" now also matches inside "promptly" - accepted the same way this
// file already accepts "Llama" matching the animal, not just the AI model.
const MIN_LENGTH_FOR_PREFIX_MATCH = 4;

export function containsWholeWord(haystackLower, keyword) {
  const escaped = escapeRegExp(keyword.toLowerCase());
  const pattern = keyword.trim().length >= MIN_LENGTH_FOR_PREFIX_MATCH ? `\\b${escaped}` : `\\b${escaped}\\b`;
  return new RegExp(pattern, "i").test(haystackLower);
}

// Legal-entity suffixes and generic corporate-structure/regional words that
// otherwise make an identical company fail to match itself - e.g. a
// configured "Zühlke" vs a scraped "Zühlke Engineering AG", or a configured
// "PageGroup Switzerland" vs a scraped plain "PageGroup". Stripped as whole
// words (never mid-word) from BOTH the configured keyword and the lead's own
// company text before comparing, in EITHER direction - reported directly:
// "How do I handle when I put a company name without the AG/Ltd/Inc part,
// and it appears with, or vice versa? ... <company name> Switzerland, or
// vice versa? ... <company name> Group, or vice versa?" Deliberately kept to
// pure corporate-boilerplate tokens (no partial/fuzzy typo tolerance), so it
// can't accidentally treat two genuinely different companies as the same one.
// Exported (v0.29.36) - company-resolve-extraction.js reuses this exact list
// to strip the same kind of noise from a company name before searching for
// it on LinkedIn: confirmed live that "ARYZTA AG" gets no confident match on
// LinkedIn's Companies tab, but "ARYZTA" alone finds the real, verified
// company immediately - the same underlying problem as the country-
// qualifier fix (v0.29.28) this generalizes, not a new mechanism.
export const COMPANY_SUFFIX_NOISE_WORDS = new Set([
  "ag", "gmbh", "sa", "sarl", "ltd", "limited", "llc", "inc", "incorporated", "corp", "corporation",
  "plc", "co", "kg", "kgaa", "nv", "bv", "oy", "ab", "as", "spa", "srl", "pte", "pty",
  "group", "holding", "holdings", "international", "switzerland", "schweiz", "suisse", "svizzera",
]);

function normalizeCompanyForMatch(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[.,()]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !COMPANY_SUFFIX_NOISE_WORDS.has(word))
    .join(" ")
    .trim();
}

// Bidirectional: after stripping suffix noise from both sides, matches if
// EITHER string's remaining words are found (as a whole phrase) inside the
// other's. Bidirectional specifically because either side could be the
// "shorter" one - a configured keyword missing "AG" that a scraped company
// name has, or a configured keyword that spells out "Switzerland"/"Group"
// that the scraped company name omits. Exported for a settings/sidepanel
// preview and for tests; storage.js's own callers go through
// matchesNegativeTopic below.
export function matchesCompanyKeyword(companyText, keyword) {
  if (!companyText || !keyword) return false;
  const normCompany = normalizeCompanyForMatch(companyText);
  const normKeyword = normalizeCompanyForMatch(keyword);
  if (!normCompany || !normKeyword) return false;
  return containsWholeWord(normCompany, normKeyword) || containsWholeWord(normKeyword, normCompany);
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

  // matchField: "company" (Known Recruiting Firms, AI/Cloud Vendor Blocklist)
  // compares ONLY lead.company, via the fuzzy suffix-stripped comparison -
  // free-text snippet/headline mentions never count, which is exactly what
  // keeps the AI Vendor list from reintroducing the "built on Azure" false
  // positives builtin-competitors avoids by excluding these vendors outright.
  if (topic.matchField === "company") {
    const matchedKeyword = topic.keywords.find((kw) => matchesCompanyKeyword(lead.company, kw));
    if (!matchedKeyword) return null;
    const andGroup = topic.andKeywords || [];
    const andMatch = andGroup.length === 0 || andGroup.some((kw) => matchesCompanyKeyword(lead.company, kw));
    return andMatch ? matchedKeyword : null;
  }

  const haystack = negativeTopicHaystack(lead).toLowerCase();
  // Default ("any") field: the existing free-text whole-word check, OR'd
  // with the fuzzy company-suffix check - additive, so an existing topic's
  // free-text matching behavior is unchanged, it just ALSO now catches a
  // company-name variant that differs only by a legal-entity/regional/group
  // suffix (AG/Ltd/Inc, "<Company> Switzerland," "<Company> Group," in
  // either direction) without the user needing to list every variant.
  const matchedKeyword = topic.keywords.find(
    (kw) => containsWholeWord(haystack, kw) || matchesCompanyKeyword(lead.company, kw)
  );
  if (!matchedKeyword) return null;
  const andGroup = topic.andKeywords || [];
  const andMatch =
    andGroup.length === 0 ||
    andGroup.some((kw) => containsWholeWord(haystack, kw) || matchesCompanyKeyword(lead.company, kw));
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
      // A lead can independently be Irrelevant for a location mismatch too
      // (locationFilterReason, applyLocationFilterToResultsMap below) - only
      // restore to New once NEITHER reason still applies, so clearing one
      // can never silently un-hide a lead the other filter still wants
      // hidden.
      if (!detail && !lead.locationFilterReason) {
        lead.status = "New";
        delete lead.irrelevantReason;
        lead.statusUpdatedAt = now;
        restoredCount++;
        anyChanged = true;
      } else if (!detail) {
        // Still Irrelevant via the location filter alone - just drop the
        // now-stale negative-topic reason so nothing dangling remains.
        if (lead.irrelevantReason) {
          delete lead.irrelevantReason;
          anyChanged = true;
        }
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

// ---------------------------------------------------------------------
// Location Filter (6.14) - reviewable/reversible auto-filter by continent
// or country, using a lead's own location (Job leads: from the scrape;
// Post leads: from an opt-in profile visit, see applyExtractedCompanies'
// location parameter and profile-content-script.js). Deliberately parallel
// to Negative Topics above, not merged into it - a different input (a fixed
// geography choice, not free-text keywords) and a different confidence
// model (silence is never treated as a mismatch, whereas an empty Negative
// Topic keyword list simply never matches either, so the two already agree
// on "no data/no configured rule -> untouched").
// ---------------------------------------------------------------------

// Continent groupings shown in Settings (6.7) - modeled on the standard
// Americas/EMEA/APAC sales-territory split, with each of those three broken
// down one level further (Americas -> North America + Latin America; EMEA ->
// Europe + Africa + Middle East; APAC stays whole as "South East Asia").
// Deliberately not exhaustive of every country/territory on Earth - South
// Asia, East Asia, Central Asia, and Oceania have no separate bucket of
// their own and are folded into "South East Asia" (i.e. APAC, confirmed)
// rather than adding a 7th "Other" bucket, so these 6 checkboxes fully
// partition the globe. A location that still matches none of them is simply
// left unclassified (classifyLocation returns null) rather than guessed at.
const CONTINENT_COUNTRIES = {
  northAmerica: ["United States", "Canada"],
  latinAmerica: ["Mexico", "Guatemala", "Belize", "Honduras", "El Salvador", "Nicaragua", "Costa Rica", "Panama", "Cuba", "Dominican Republic", "Haiti", "Jamaica", "Trinidad and Tobago", "Bahamas", "Barbados", "Colombia", "Venezuela", "Ecuador", "Peru", "Brazil", "Bolivia", "Paraguay", "Chile", "Argentina", "Uruguay", "Guyana", "Suriname"],
  europe: ["United Kingdom", "Switzerland", "Germany", "France", "Italy", "Spain", "Portugal", "Netherlands", "Belgium", "Luxembourg", "Ireland", "Austria", "Sweden", "Norway", "Denmark", "Finland", "Iceland", "Poland", "Czech Republic", "Slovakia", "Hungary", "Romania", "Bulgaria", "Greece", "Croatia", "Slovenia", "Serbia", "Bosnia and Herzegovina", "Montenegro", "North Macedonia", "Albania", "Kosovo", "Estonia", "Latvia", "Lithuania", "Ukraine", "Belarus", "Moldova", "Malta", "Cyprus", "Liechtenstein", "Monaco", "San Marino", "Andorra", "Russia"],
  africa: ["Nigeria", "Egypt", "South Africa", "Kenya", "Morocco", "Algeria", "Tunisia", "Libya", "Ethiopia", "Ghana", "Tanzania", "Uganda", "Angola", "Mozambique", "Cameroon", "Ivory Coast", "Senegal", "Zimbabwe", "Zambia", "Rwanda", "Botswana", "Namibia", "Mali", "Niger", "Chad", "Sudan", "South Sudan", "Somalia", "Madagascar", "Malawi", "Burkina Faso", "Benin", "Togo", "Sierra Leone", "Liberia", "Mauritius", "Gabon", "Congo", "Democratic Republic of the Congo", "Guinea", "Eritrea", "Djibouti", "Lesotho", "Eswatini", "Gambia", "Burundi", "Central African Republic"],
  middleEast: ["Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Bahrain", "Oman", "Yemen", "Iraq", "Iran", "Israel", "Jordan", "Lebanon", "Syria", "Palestine", "Turkey"],
  southEastAsia: ["Indonesia", "Malaysia", "Singapore", "Thailand", "Vietnam", "Philippines", "Myanmar", "Cambodia", "Laos", "Brunei", "Timor-Leste", "India", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal", "Bhutan", "Maldives", "Afghanistan", "China", "Japan", "South Korea", "North Korea", "Taiwan", "Hong Kong", "Mongolia", "Macau", "Kazakhstan", "Uzbekistan", "Turkmenistan", "Kyrgyzstan", "Tajikistan", "Australia", "New Zealand", "Papua New Guinea", "Fiji"],
};

// Flattened, alphabetized list of every country CONTINENT_COUNTRIES/
// classifyLocation actually recognizes - the single source Settings' country
// picker (6.7) draws from, so a selected country can only ever be a name
// that's guaranteed to match a classified lead exactly. Reported directly:
// free-text country entry is error-prone (misspelling, an unrecognized
// alternate name) and failed silently - a picker limited to this exact list
// removes that failure mode by construction instead of trying to fuzzy-match
// free text later.
export const ALL_COUNTRIES = Object.values(CONTINENT_COUNTRIES).flat().sort((a, b) => a.localeCompare(b));

export const CONTINENT_LABELS = {
  northAmerica: "North America",
  latinAmerica: "Latin America",
  europe: "Europe (including UK and Switzerland)",
  africa: "Africa",
  middleEast: "Middle East",
  southEastAsia: "South East Asia",
};

// A few common alternate names LinkedIn location text actually uses,
// mapped to the canonical country name in CONTINENT_COUNTRIES above.
const COUNTRY_ALIASES = {
  usa: "United States", us: "United States", "u.s.": "United States", "u.s.a.": "United States",
  uk: "United Kingdom", "great britain": "United Kingdom", england: "United Kingdom",
  scotland: "United Kingdom", wales: "United Kingdom", "northern ireland": "United Kingdom",
  uae: "United Arab Emirates", czechia: "Czech Republic",
  "côte d'ivoire": "Ivory Coast", "cote d'ivoire": "Ivory Coast",
  drc: "Democratic Republic of the Congo", "congo-kinshasa": "Democratic Republic of the Congo",
  // A Swiss profile just as often names the country in German or French as
  // in English, or by its ISO code - reported directly, several leads at
  // obviously-Swiss companies had no location because their profile said
  // "Schweiz," "Suisse," or "CH," none of which this table recognized as
  // Switzerland. "ch" is safe here specifically because containsWholeWord
  // (used below) only ever matches it as an isolated word, never mid-word.
  schweiz: "Switzerland", suisse: "Switzerland", svizzera: "Switzerland", ch: "Switzerland",
};

// LinkedIn often shows just a metro-area name with no country at all -
// "Greater Zurich Area," "Nashville Metropolitan Area," "Greater New York
// City Area." Originally Switzerland-only (this project's primary market);
// reported directly after "Nashville Metropolitan Area" (Burke Holland) and
// other major non-Swiss cities came back with no classifiable location at
// all despite obviously being real, specific places ("Can you not infer
// from Nashville to the USA?"). Extended to a modest set of other major
// metros a B2B tech/AI lead is likely to be based in - deliberately a
// short, best-effort list (like the Swiss one before it), not an attempt at
// exhaustive world city coverage - a city not on this list is left
// unclassified rather than guessed at, same as any other unrecognized text.
const CITY_TO_COUNTRY = {
  // Switzerland (this project's primary market) - includes the German/
  // French names actually seen on Swiss profiles ("Zürich," "Genève"/
  // "Genf," "Luzern") alongside their English equivalents.
  zurich: "Switzerland", "zürich": "Switzerland", geneva: "Switzerland", "genève": "Switzerland",
  genf: "Switzerland", basel: "Switzerland", bern: "Switzerland", lausanne: "Switzerland",
  lucerne: "Switzerland", luzern: "Switzerland", winterthur: "Switzerland", "st. gallen": "Switzerland",
  "st gallen": "Switzerland", "sankt gallen": "Switzerland", lugano: "Switzerland", biel: "Switzerland",
  bienne: "Switzerland", zug: "Switzerland",
  // Major US metros commonly shown as just "X Metropolitan Area"/"Greater X Area."
  "new york": "United States", "new york city": "United States", "los angeles": "United States",
  chicago: "United States", "san francisco": "United States", nashville: "United States",
  seattle: "United States", austin: "United States", boston: "United States", dallas: "United States",
  houston: "United States", atlanta: "United States", denver: "United States", miami: "United States",
  washington: "United States", philadelphia: "United States", phoenix: "United States",
  "san diego": "United States", portland: "United States", minneapolis: "United States", detroit: "United States",
  // A handful of other major metros seen the same way.
  london: "United Kingdom", manchester: "United Kingdom",
  toronto: "Canada", vancouver: "Canada", montreal: "Canada",
  // Reported directly - real leads came back as "Greater Hamburg Area,"
  // "Greater Bengaluru Area," and "Greater Lyon/Rennes Area," none
  // classifiable, so a lead from clearly outside Switzerland went untouched
  // by the Location Filter. Same modest-list philosophy as above: the major
  // metros most likely to keep recurring for a Swiss/European AI-sales
  // audience, not an attempt at exhaustive world coverage.
  hamburg: "Germany", munich: "Germany", "münchen": "Germany", berlin: "Germany",
  frankfurt: "Germany", cologne: "Germany", "köln": "Germany", stuttgart: "Germany", dusseldorf: "Germany",
  "düsseldorf": "Germany",
  lyon: "France", rennes: "France", paris: "France", marseille: "France", toulouse: "France", nantes: "France",
  bengaluru: "India", bangalore: "India", mumbai: "India", delhi: "India", "new delhi": "India",
  hyderabad: "India", pune: "India", chennai: "India",
  milan: "Italy", milano: "Italy", rome: "Italy", roma: "Italy",
  madrid: "Spain", barcelona: "Spain",
  amsterdam: "Netherlands", rotterdam: "Netherlands",
  dublin: "Ireland", stockholm: "Sweden", copenhagen: "Denmark", oslo: "Norway", helsinki: "Finland",
  warsaw: "Poland", vienna: "Austria", brussels: "Belgium",
  dubai: "United Arab Emirates", "abu dhabi": "United Arab Emirates",
  tokyo: "Japan", sydney: "Australia", melbourne: "Australia",
};

let countryToContinentTable = null;
function countryToContinent() {
  if (!countryToContinentTable) {
    countryToContinentTable = {};
    for (const [continent, countries] of Object.entries(CONTINENT_COUNTRIES)) {
      for (const country of countries) countryToContinentTable[country.toLowerCase()] = { country, continent };
    }
  }
  return countryToContinentTable;
}

// Single source of truth for turning a raw LinkedIn location string into a
// {country, continent} pair - the content script only needs a much smaller
// local heuristic to find candidate text to report, not this full table.
// Returns null (never a guess) if nothing recognizable is found, so an
// unparseable or unfamiliar location is treated as "no data," not "no match."
export function classifyLocation(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const table = countryToContinent();

  for (const [countryLower, entry] of Object.entries(table)) {
    if (containsWholeWord(lower, countryLower)) return entry;
  }
  for (const [alias, canonical] of Object.entries(COUNTRY_ALIASES)) {
    if (containsWholeWord(lower, alias)) {
      const entry = table[canonical.toLowerCase()];
      if (entry) return entry;
    }
  }
  for (const [city, country] of Object.entries(CITY_TO_COUNTRY)) {
    if (containsWholeWord(lower, city)) {
      const entry = table[country.toLowerCase()];
      if (entry) return entry;
    }
  }
  return null;
}

const LOCATION_FILTER_CONFIG_KEY = "locationFilterConfig";
const DEFAULT_LOCATION_FILTER_CONFIG = { mode: "off", continents: [], countries: [] };

export async function getLocationFilterConfig() {
  const data = await chrome.storage.local.get(LOCATION_FILTER_CONFIG_KEY);
  return { ...DEFAULT_LOCATION_FILTER_CONFIG, ...(data[LOCATION_FILTER_CONFIG_KEY] || {}) };
}

export async function saveLocationFilterConfig(config) {
  await chrome.storage.local.set({ [LOCATION_FILTER_CONFIG_KEY]: config });
}

// Returns a reason string for a CONFIDENT, configured mismatch only - null
// whenever the filter is off, the lead has no location yet, or the location
// text couldn't be classified. Never returns a reason for "we don't know,"
// only for "we know, and it doesn't match."
export function matchesLocationFilter(lead, config) {
  if (!config || config.mode === "off" || !lead.location) return null;
  const classified = classifyLocation(lead.location);
  if (!classified) return null;

  const isMatch = config.mode === "continent"
    ? (config.continents || []).includes(classified.continent)
    : (config.countries || []).some((c) => c.trim().toLowerCase() === classified.country.toLowerCase());

  return isMatch ? null : `Location outside target region: ${lead.location} (${classified.country})`;
}

// Mirrors applyNegativeTopicsToResultsMap's New<->Irrelevant transition
// logic exactly, using a parallel locationFilterReason field so the two
// filters can compose without clobbering each other (see the restore-branch
// patch in applyNegativeTopicsToResultsMap above).
export function applyLocationFilterToResultsMap(resultsMap, config) {
  const now = Date.now();
  let blockedCount = 0;
  let restoredCount = 0;
  let anyChanged = false;
  for (const lead of Object.values(resultsMap)) {
    if (lead.status === "New") {
      const reason = matchesLocationFilter(lead, config);
      if (reason) {
        lead.status = "Irrelevant";
        lead.locationFilterReason = reason;
        lead.statusUpdatedAt = now;
        blockedCount++;
        anyChanged = true;
      }
    } else if (lead.status === "Irrelevant" && lead.locationFilterReason) {
      const reason = matchesLocationFilter(lead, config);
      if (!reason && !lead.irrelevantReason) {
        lead.status = "New";
        delete lead.locationFilterReason;
        lead.statusUpdatedAt = now;
        restoredCount++;
        anyChanged = true;
      } else if (!reason) {
        delete lead.locationFilterReason;
        anyChanged = true;
      } else if (lead.locationFilterReason !== reason) {
        lead.locationFilterReason = reason;
        anyChanged = true;
      }
    }
  }
  return { blockedCount, restoredCount, anyChanged };
}

// The Dashboard's on-demand "Apply Location Filter" button - the
// standalone, no-profile-visit-needed way to re-run the check above (e.g.
// after changing the continent/country selection in Settings).
export async function reapplyLocationFilter() {
  const [results, config] = await Promise.all([getResults(), getLocationFilterConfig()]);
  const { blockedCount, restoredCount, anyChanged } = applyLocationFilterToResultsMap(results, config);
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

// Same write path as applyLeadPriorities above, plus a targetAccountMatch
// flag so a lead auto-set this way (via partitionLeadsByTargetAccount's
// autoPriorities) stays distinguishable from one the Sales Mentor actually
// scored - used by the Dashboard's Prioritize Unscored/Re-score All
// Priorities buttons. background.js's scan-time pass sets the same flag
// itself inline instead of calling this, since it already holds one
// in-memory results object across the whole scan and writes it directly.
export async function applyTargetAccountPriorities(autoPriorities) {
  const results = await getResults();
  const scoredAt = Date.now();
  let changed = 0;
  for (const { key, priority, reason } of autoPriorities) {
    if (results[key] && Number.isInteger(priority) && priority >= 1 && priority <= 5) {
      results[key].priority = priority;
      results[key].priorityReason = reason || "";
      results[key].priorityScoredAt = scoredAt;
      results[key].targetAccountMatch = true;
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

// The fixed catalog of deterministic rules layered on top of the Sales
// Mentor for a qualifying Target Account match (see 6.11/6.13 in PRD.md) -
// each rule uses exactly one of the three effect types, matching the
// Settings page's own Ceiling/Floor/Decisive columns:
//   - "decisive": the rule sets the priority outright - no AI call at all
//     for that lead (the Sales Mentor never gets a say for it).
//   - "floor": the lead still goes to the Sales Mentor, but the returned
//     priority is clamped up to at least this value if the model said worse.
// The Sales Mentor's own judgment is always the base decision and can never
// itself be disabled - these rules only ever constrain or override it for
// leads that satisfy their specific condition. `description` and `type` are
// fixed in code, never stored/edited, so a saved override can never drift
// into describing behavior the code doesn't actually implement - only
// `enabled` and `value` are user-adjustable (see
// getPrioritizationRules/savePrioritizationRuleOverride below).
export const PRIORITIZATION_RULE_CATALOG = [
  {
    id: "job_company_cap",
    description: "Job listing at a qualifying Target Account company - there's no individual to contact, so the company match alone is capped.",
    type: "decisive",
    defaultValue: 3,
  },
  {
    id: "post_title_match",
    description: 'Post (or in-post job ad) whose own headline names a decision-maker role (CTO, CIO, CAIO, Head/VP of AI, etc.) at a qualifying Target Account company.',
    type: "decisive",
    defaultValue: 1,
  },
  {
    id: "post_topic_match",
    description: 'Post (or in-post job ad) sourced from a topic named "AI Transformation", at a qualifying Target Account company (checked only if the title-match rule above didn\'t already fire).',
    type: "decisive",
    defaultValue: 1,
  },
  {
    id: "post_company_floor",
    description: "Post (or in-post job ad) at a qualifying Target Account company that matched neither rule above - guaranteed a minimum priority, but the Sales Mentor can still say better.",
    type: "floor",
    defaultValue: 2,
  },
  {
    id: "job_signal_ceiling",
    description: "Job listing whose company matched a Target Account, but not confidently enough for the Job company cap above (a Provisional label or below-threshold score) - the Sales Mentor still decides, but is never allowed to rate it better than this, since there's still no individual to contact.",
    type: "ceiling",
    defaultValue: 3,
  },
];

const PRIORITIZATION_RULE_OVERRIDES_KEY = "prioritizationRuleOverrides";

export async function getPrioritizationRules() {
  const data = await chrome.storage.local.get(PRIORITIZATION_RULE_OVERRIDES_KEY);
  const overrides = data[PRIORITIZATION_RULE_OVERRIDES_KEY] || {};
  return PRIORITIZATION_RULE_CATALOG.map((rule) => ({
    ...rule,
    enabled: overrides[rule.id]?.enabled !== undefined ? overrides[rule.id].enabled : true,
    value: overrides[rule.id]?.value !== undefined ? overrides[rule.id].value : rule.defaultValue,
  }));
}

export async function savePrioritizationRuleOverride(id, { enabled, value } = {}) {
  const data = await chrome.storage.local.get(PRIORITIZATION_RULE_OVERRIDES_KEY);
  const overrides = data[PRIORITIZATION_RULE_OVERRIDES_KEY] || {};
  overrides[id] = {
    ...overrides[id],
    ...(enabled !== undefined ? { enabled } : {}),
    ...(value !== undefined ? { value } : {}),
  };
  await chrome.storage.local.set({ [PRIORITIZATION_RULE_OVERRIDES_KEY]: overrides });
}

// Target Contacts (PRD 6.12's Contacts sheet - real, externally-researched,
// pre-qualified decision-makers at Target Account companies, not a keyword
// heuristic) matching, feeding the Sales Mentor's own judgment as context -
// deliberately NOT a separate deterministic auto-priority rule or a second
// priority field, per the explicit decision this was built against: one
// combined priority, the AI weighs the signal itself.
function nameWordSet(name) {
  if (!name) return new Set();
  return new Set(
    name
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

// A Post lead's scraped author name often carries trailing credentials a
// person added to their own LinkedIn name (confirmed against real leads
// cross-referenced by hand: "Katja Roelants du Vivier, MSc", "Vikram Verma
// PMP®, CSM") that a strict full-string comparison would reject as "not
// the same person." Requiring every word of the Contacts sheet's (clean)
// full name to appear as a whole word in the author's name sidesteps
// needing a maintained list of credential abbreviations - it tolerates
// extra trailing (or interleaved) tokens on the author's side without
// needing to know what they are. Deliberately best-effort: a missed match
// only means this signal doesn't fire for that one lead, never a wrong
// person being flagged, since a company match (normalizeCompanyName) is
// required first, and at a few dozen contacts per company at most, a first
// name + last name collision within the same company is effectively nil.
function authorMatchesContactName(authorName, contactFullName) {
  const contactWords = nameWordSet(contactFullName);
  if (contactWords.size === 0) return false;
  const authorWords = nameWordSet(authorName);
  for (const w of contactWords) {
    if (!authorWords.has(w)) return false;
  }
  return true;
}

// Post leads only - a Job listing's "creator" is the company itself, not an
// individual, so there's no author name to match against a contact.
export function findTargetContactMatch(lead, contacts) {
  if (lead.type === "job" || !lead.author || !lead.company || contacts.length === 0) return null;
  const companyKey = normalizeCompanyName(lead.company);
  if (!companyKey) return null;
  for (const contact of contacts) {
    if (normalizeCompanyName(contact.company) !== companyKey) continue;
    if (authorMatchesContactName(lead.author, contact.fullName)) return contact;
  }
  return null;
}

// Pure decision function behind background.js's Target Account auto-priority
// step (see 6.11 in PRD.md) - kept separate/side-effect-free so it's directly
// unit-testable without running a whole scan. "Confident" deliberately
// excludes any Provisional/Insufficient Evidence/Out of Scope label, even at
// a very high score - the real workbook's highest scores cluster in a large
// Provisional bucket (thin evidence, not confirmed fit), so score alone
// isn't a safe basis for an automatic override.
export function evaluateTargetAccountMatch(company, targetAccounts, threshold) {
  const match = targetAccounts[normalizeCompanyName(company)];
  if (!match || match.score == null) return { match: null, qualifies: false };
  const confidentLabel = match.priorityLabel === "Very High" || match.priorityLabel === "High";
  return { match, qualifies: confidentLabel && match.score >= threshold };
}

function describeMatch(match) {
  return `${match.company} scored ${Math.round(match.score)}/100 (${match.priorityLabel})`;
}

// A real, named individual (Post leads, including an in-post job ad) with
// one of these in their own headline is a decision-maker worth an automatic
// top priority regardless of anything else - reported as a real gap after a
// batch of Job listings (no individual at all) outranked genuine people in
// these roles. Deliberately matched against free text (case-insensitive
// substring), not an exact-title equality check - real headlines combine
// titles with company names, other roles, and formatting LinkedIn users
// commonly add ("CTO @ Acme | ex-Google").
const HIGH_VALUE_TITLE_KEYWORDS = [
  "cto", "chief technology officer",
  "cio", "chief information officer",
  "caio", "chief ai officer", "chief artificial intelligence officer",
  "cdo", "chief digital officer",
  "head of ai", "vp of ai", "vice president of ai",
  "head of artificial intelligence", "vp of artificial intelligence",
  "head of digital transformation", "vp of digital transformation",
  "head of automation", "vp of automation",
  "head of innovation", "vp of innovation",
];

function matchingHighValueTitle(headline) {
  if (!headline) return null;
  const lower = headline.toLowerCase();
  return HIGH_VALUE_TITLE_KEYWORDS.find((kw) => lower.includes(kw)) || null;
}

// A lead found via the "AI Transformation" topic is itself a signal worth
// treating like a title match, even when the poster's own headline doesn't
// name a qualifying role - matched by substring against the topic's name
// (not an exact match) since this project's own topics are typically named
// with a language/variant suffix (e.g. "AI Transformation (EN)", "AI
// Transformation (EN + DE)").
function matchesAiTransformationTopic(matchedTopics) {
  return (matchedTopics || []).some((t) => (t.topicName || "").toLowerCase().includes("ai transformation"));
}

// Splits a list of not-yet-(re)scored leads against the imported Target
// Accounts list, applying PRIORITIZATION_RULE_CATALOG (above) - a rule that
// qualifies and is enabled goes into autoPriorities, ready for
// applyLeadPriorities below (or an equivalent inline write) - no AI call
// involved for a "decisive" rule at all, so the outcome is guaranteed and
// the reason is always an exact, quotable sentence naming which rule fired,
// rather than something the model chose (or didn't choose) to mention.
// Everything else comes back in toScore, unchanged except a lead that still
// matched (just not confidently enough, a disabled rule's condition, or a
// Post that qualifies without a title/topic hit) gets a shallow-cloned copy
// with a targetAccountSignal attached (and, for a qualifying Post with the
// floor rule enabled, a targetAccountFloor at that rule's configured value)
// so prioritizeLeads (agent-shared.js) can fold it into the Sales Mentor's
// own judgment - the Mentor's own judgment is always the base decision and
// is never itself disabled; these rules only ever constrain or override it
// for leads that satisfy their specific condition. A clone, not a mutation,
// so this transient hint is never accidentally persisted onto the real
// stored lead object. Shared by background.js's automatic post-scan pass
// and the Dashboard's manual Prioritize Unscored /
// Re-score All Priorities buttons, so every path applies the same rule -
// importing/updating the Target Accounts list retroactively affects leads
// re-scored afterward without requiring a fresh scan.
export async function partitionLeadsByTargetAccount(leads) {
  const targetAccounts = await getTargetAccounts();
  if (Object.keys(targetAccounts).length === 0) return { autoPriorities: [], toScore: leads };

  // Target Contacts (Companies-sheet-independent - the Contacts sheet of
  // the same workbook, PRD 6.12) - attached at the very end below to every
  // lead reaching toScore, regardless of which branch put it there, so a
  // contact match matters even for a lead whose company didn't clear the
  // score threshold above.
  const contacts = (await getTargetAccountsWorkbook()).contacts || [];

  const threshold = await getTargetAccountScoreThreshold();
  const rules = await getPrioritizationRules();
  const ruleById = Object.fromEntries(rules.map((r) => [r.id, r]));

  const autoPriorities = [];
  const toScore = [];
  for (const lead of leads) {
    const { match, qualifies } = evaluateTargetAccountMatch(lead.company, targetAccounts, threshold);

    if (qualifies && lead.type === "job") {
      // A Job lead's "creator" is the company itself, not an individual -
      // there's no real person to message, and a job ad alone (no named
      // contact, no stated initiative beyond "we're hiring") never earns
      // better than this rule's value, however highly the employer scored.
      // Applied directly rather than sent to the AI - there's nothing else
      // for the model to weigh for this specific decision. Disabling the
      // rule (Settings 6.7) leaves the lead to the Sales Mentor entirely,
      // same as a non-qualifying match already does.
      const rule = ruleById.job_company_cap;
      if (rule.enabled) {
        autoPriorities.push({
          key: lead.key,
          priority: rule.value,
          reason: `Target Account match: ${describeMatch(match)} - capped at Priority ${rule.value} (rule: Job company cap), since this is a Job listing with no individual contact to follow up with.`,
        });
        continue;
      }
      toScore.push({ ...lead, targetAccountSignal: match });
      continue;
    }

    if (qualifies) {
      // A Post lead (including an in-post job ad) has a real, named
      // individual behind it - a stronger signal than a Job listing. A
      // qualifying company plus a headline naming a real decision-maker
      // role, or a lead sourced from the "AI Transformation" topic, earns
      // an automatic top priority - applied directly, not left to the AI,
      // so the outcome is guaranteed regardless of how the model would have
      // phrased it. Either rule can be independently disabled in Settings.
      const titleRule = ruleById.post_title_match;
      const topicRule = ruleById.post_topic_match;
      const titleKeyword = titleRule.enabled ? matchingHighValueTitle(lead.headline) : null;
      const topicMatch = !titleKeyword && topicRule.enabled && matchesAiTransformationTopic(lead.matchedTopics);
      if (titleKeyword || topicMatch) {
        const rule = titleKeyword ? titleRule : topicRule;
        const why = titleKeyword
          ? `the post creator's own headline names a key AI/digital-transformation role ("${titleKeyword}")`
          : 'it was found via the "AI Transformation" topic';
        autoPriorities.push({
          key: lead.key,
          priority: rule.value,
          reason: `Target Account match: ${describeMatch(match)} - automatic Priority ${rule.value} (rule: ${titleKeyword ? "Post title match" : "Post topic match"}), since ${why}.`,
        });
        continue;
      }
      // Still a real contact at a confidently-scored company - guaranteed
      // at least this rule's floor value (targetAccountFloor, applied in
      // tagPrioritiesWithTargetAccountSignal below once the AI has scored
      // it), but the Sales Mentor's own judgment still picks between 1 and
      // the floor within that range based on the actual content. Disabling
      // the rule sends the lead to the AI as a plain signal with no floor.
      const floorRule = ruleById.post_company_floor;
      toScore.push(floorRule.enabled
        ? { ...lead, targetAccountSignal: match, targetAccountFloor: floorRule.value }
        : { ...lead, targetAccountSignal: match });
      continue;
    }

    if (match && lead.type === "job") {
      // A Provisional/below-threshold match still means this Job lead's
      // company is a researched, imported Target Account - the same "no
      // individual to contact" reasoning as job_company_cap above applies
      // regardless of confidence, but the score itself isn't confident enough
      // to trust the AI-free deterministic path. Reported directly: two
      // real Job leads with a "Very High - Provisional" signal still reached
      // Priority 1 - the AI's own soft guidance ("should rarely reach 1 or
      // 2") isn't a guarantee. This makes it one: the Sales Mentor still
      // decides, but tagPrioritiesWithTargetAccountSignal below clamps
      // whatever it returns to never beat this rule's value.
      const ceilingRule = ruleById.job_signal_ceiling;
      toScore.push(ceilingRule.enabled
        ? { ...lead, targetAccountSignal: match, targetAccountCeiling: ceilingRule.value }
        : { ...lead, targetAccountSignal: match });
    } else if (match) {
      toScore.push({ ...lead, targetAccountSignal: match });
    } else {
      toScore.push(lead);
    }
  }
  const toScoreWithContacts = toScore.map((lead) => {
    const contact = findTargetContactMatch(lead, contacts);
    return contact ? { ...lead, targetContactSignal: contact } : lead;
  });
  return { autoPriorities, toScore: toScoreWithContacts };
}

// prioritizeLeads (agent-shared.js) is told to mention a lead's
// targetAccountSignal/targetContactSignal in its own reason text when it
// influenced the call, but that's free-text AI writing, not a guaranteed
// template - it doesn't reliably say so every time, which made it look like
// the Target Accounts list wasn't being used at all even when it was. This
// makes the connection deterministic instead of relying on the model's
// phrasing: prepends fixed, always-present tags to any AI-returned priority
// whose lead carried either signal (matched against `leads` - the same
// array passed to prioritizeLeads, so a signal attached by
// partitionLeadsByTargetAccount above is still present). Also enforces
// targetAccountFloor (set on a qualifying Post lead by
// partitionLeadsByTargetAccount) - a real contact at a confidently-scored
// company is never allowed to end up worse than the floor, whatever the AI
// itself returned - and targetAccountCeiling (set on a Job lead with a
// Provisional/below-threshold match) the same way in the opposite direction,
// with either clamp stated plainly in the reason. The contact signal
// deliberately has no floor/ceiling of its own - per the explicit decision
// behind it (one combined priority, no second rule), it only ever reaches
// the outcome through the AI's own weighing, never a deterministic clamp.
export function tagPrioritiesWithTargetAccountSignal(priorities, leads) {
  const leadByKey = new Map(
    leads.filter((l) => l.targetAccountSignal || l.targetContactSignal).map((l) => [l.key, l])
  );
  return priorities.map((p) => {
    const lead = leadByKey.get(p.key);
    if (!lead) return p;
    let baseReason = p.reason || "";
    if (lead.targetContactSignal) {
      const c = lead.targetContactSignal;
      const tag = `[Target Contact match: ${c.fullName} - ${c.jobTitle}${c.seniority ? ` (${c.seniority})` : ""}] `;
      baseReason = tag + baseReason;
    }
    if (lead.targetAccountSignal) {
      const signal = lead.targetAccountSignal;
      const tag = `[Target Account signal: ${signal.company} scored ${Math.round(signal.score)}/100 (${signal.priorityLabel})] `;
      baseReason = tag + baseReason;
    }
    if (lead.targetAccountFloor && p.priority > lead.targetAccountFloor) {
      return {
        ...p,
        priority: lead.targetAccountFloor,
        reason: `${baseReason} (raised from Priority ${p.priority} to ${lead.targetAccountFloor} - a floor for a real contact at a confidently-scored Target Account.)`,
      };
    }
    if (lead.targetAccountCeiling && p.priority < lead.targetAccountCeiling) {
      return {
        ...p,
        priority: lead.targetAccountCeiling,
        reason: `${baseReason} (capped from Priority ${p.priority} to ${lead.targetAccountCeiling} - a Job listing has no individual contact, so a company signal alone can't earn better than this.)`,
      };
    }
    return { ...p, reason: baseReason };
  });
}

// Applied by background.js after the batched AI company-extraction pass
// (agent-shared.js's extractCompaniesForLeads), and by dashboard.js after a
// profile-visit pass (code/profile-content-script.js) - never overwrites a
// lead that already has a company/location, whether scraped (Job leads),
// extracted here before, or manually assigned via setLeadCompany below, so
// neither a scan nor a re-run of profile extraction can clobber a human's
// correction or an earlier result. `location` is optional - the AI headline
// extraction never has one to offer, only a profile visit does (see PRD
// 6.14) - and is written independently of company, so a profile that states
// one but not the other still saves whichever it found.
//
// `visited` (profile-extraction.js only - always undefined for the AI
// headline-extraction caller) marks the lead as checked via
// `profileVisitedAt` REGARDLESS of whether company/location came back non-
// empty - a profile genuinely has no findable location on it is a real,
// stable answer, not a reason to keep re-visiting the same profile on every
// future run (see leadsMissingProfileData in profile-extraction.js). Kept
// out of the returned count on purpose: that count means "got a company or
// location," not "was checked," so a run of leads that all turn out to have
// no location doesn't misreport 0 successes as 0 progress.
export async function applyExtractedCompanies(entries) {
  const results = await getResults();
  const extractedAt = Date.now();
  let changed = 0;
  let anyWrite = false;
  for (const { key, company, location, visited } of entries) {
    const lead = results[key];
    if (!lead) continue;
    let dataChanged = false;

    const trimmedCompany = (company || "").trim();
    if (!lead.company && trimmedCompany) {
      lead.company = trimmedCompany;
      lead.companyExtractedAt = extractedAt;
      dataChanged = true;
    }

    const trimmedLocation = (location || "").trim();
    if (!lead.location && trimmedLocation) {
      lead.location = trimmedLocation;
      lead.locationExtractedAt = extractedAt;
      dataChanged = true;
    }

    if (dataChanged) {
      changed++;
      anyWrite = true;
    }
    if (visited && !lead.profileVisitedAt) {
      lead.profileVisitedAt = extractedAt;
      anyWrite = true;
    }
  }
  if (anyWrite) await saveResults(results);
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

// Same pattern as setLeadCompany above - added after real leads came back
// with a clearly wrong extracted location (a website, the person's own name,
// their headline) with no way to correct or clear it short of editing
// storage directly.
export async function setLeadLocation(key, location) {
  const results = await getResults();
  if (!results[key]) return;
  const trimmed = (location || "").trim();
  if (trimmed) {
    results[key].location = trimmed;
  } else {
    delete results[key].location;
  }
  delete results[key].locationExtractedAt; // no longer an AI guess either way
  await saveResults(results);
}

// EXPERIMENTAL (v0.29.24, see PRD 6.15): writes the People-Search comparison
// method's findings onto separate peopleSearch* fields, deliberately never
// touching the existing company/location (still sourced from the profile-
// visit extraction) - this is comparison data for judging the new method's
// accuracy, not a second source of truth yet.
export async function applyPeopleSearchComparison(comparisons) {
  const results = await getResults();
  let updated = 0;
  const checkedAt = Date.now();
  for (const c of comparisons) {
    const lead = results[c.key];
    if (!lead) continue;
    lead.peopleSearchMatched = c.matched;
    lead.peopleSearchLocation = c.peopleSearchLocation || null;
    lead.peopleSearchCompany = c.peopleSearchCompany || null;
    lead.peopleSearchCheckedAt = checkedAt;
    updated++;
  }
  if (updated > 0) await saveResults(results);
  return updated;
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

// Chat history and a follow-up due-date for a Target Account/Contact (PRD
// 6.19) - deliberately its OWN storage, never written onto the imported
// workbook rows themselves (targetAccountsWorkbook, above). That whole blob
// is wholesale-replaced on every re-import (the external ChatGPT research
// refreshes every few months), which would silently wipe any chat history
// or due-date stored there. Keyed by normalizeCompanyName() - the same
// stable key targetAccounts/partitionLeadsByTargetAccount already use - so
// this data survives a re-import untouched even if the workbook's own
// companyId churns.
const TARGET_ACCOUNT_EXTRAS_KEY = "targetAccountExtras";

// A FUNCTION, not a shared constant - reported directly with real evidence:
// chatting with the Mentor inside a SIKA contact, then opening a
// never-before-seen Schindler account, showed SIKA's conversation under
// Schindler. Root cause: a single frozen EMPTY_EXTRA object used to be
// returned as the "no data yet" fallback for every key. Object.freeze only
// locks the object's OWN properties - it does nothing to the arrays those
// properties point to - so every entity with no saved extra got handed back
// the exact same mentorHistory/customerVoiceHistory array objects.
// runAgentTurn mutates its history array in place (push), so the very first
// message sent anywhere polluted that one shared array for every other
// not-yet-saved entity in the same page session, not just the one being
// chatted with. Each call now gets its own fresh object and fresh arrays.
function emptyExtra() {
  return { mentorHistory: [], customerVoiceHistory: [], nextActionDueAt: null };
}

export async function getTargetAccountExtras() {
  const data = await chrome.storage.local.get(TARGET_ACCOUNT_EXTRAS_KEY);
  return data[TARGET_ACCOUNT_EXTRAS_KEY] || {};
}

export async function getTargetAccountExtra(companyKey) {
  const extras = await getTargetAccountExtras();
  return extras[companyKey] || emptyExtra();
}

export async function saveTargetAccountExtra(companyKey, patch) {
  if (!companyKey) return;
  const extras = await getTargetAccountExtras();
  extras[companyKey] = { ...emptyExtra(), ...(extras[companyKey] || {}), ...patch };
  await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
}

// Same idea, per Target Contact - keyed by a composite of company + full
// name (contactKeyFor below) rather than the workbook's own contactId, for
// the same re-import-durability reason above. Reuses nameWordSet's own
// diacritic-folding/punctuation-stripping (already built for
// authorMatchesContactName) so this key is exactly as tolerant of
// formatting differences as the matching that finds a contact in the first
// place - a name that matches for prioritization purposes resolves to the
// identical extras key.
export function contactKeyFor(company, fullName) {
  const companyPart = normalizeCompanyName(company);
  const namePart = [...nameWordSet(fullName)].sort().join(" ");
  return companyPart && namePart ? `${companyPart}::${namePart}` : null;
}

const TARGET_CONTACT_EXTRAS_KEY = "targetContactExtras";

export async function getTargetContactExtras() {
  const data = await chrome.storage.local.get(TARGET_CONTACT_EXTRAS_KEY);
  return data[TARGET_CONTACT_EXTRAS_KEY] || {};
}

export async function getTargetContactExtra(contactKey) {
  const extras = await getTargetContactExtras();
  return extras[contactKey] || emptyExtra();
}

export async function saveTargetContactExtra(contactKey, patch) {
  if (!contactKey) return;
  const extras = await getTargetContactExtras();
  extras[contactKey] = { ...emptyExtra(), ...(extras[contactKey] || {}), ...patch };
  await chrome.storage.local.set({ [TARGET_CONTACT_EXTRAS_KEY]: extras });
}

// Reverse of findTargetContactMatch (above) - every Post lead authored by
// this specific contact, for the Contact view's "posts by this contact"
// list, instead of stopping at the first match.
export function findLeadsForContact(contact, leads) {
  return leads.filter((lead) => {
    if (lead.type === "job" || !lead.author || !lead.company) return false;
    if (normalizeCompanyName(lead.company) !== normalizeCompanyName(contact.company)) return false;
    return authorMatchesContactName(lead.author, contact.fullName);
  });
}

// Main Target Accounts dashboard flag (PRD 6.19): a company needs attention
// when it has a Post lead nobody has triaged yet, or a manually-set
// follow-up date that's already passed. Cheap enough to compute client-side
// over already-loaded data at this scale (500 companies, ~1000 leads) - no
// new index needed.
export function hasUnreviewedPost(companyKey, leads) {
  return leads.some(
    (lead) => lead.type !== "job" && lead.status === "New" && normalizeCompanyName(lead.company) === companyKey
  );
}

export function hasOverdueAction(extra) {
  return Boolean(extra?.nextActionDueAt && extra.nextActionDueAt < Date.now());
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

// One-time migration guard for the v0.29.12/13 location-detection fixes
// (German/French/CH spellings, then broader non-Swiss city coverage) - see
// the loop below for why this exists.
const LOCATION_HEURISTIC_V2_MIGRATED_KEY = "locationHeuristicV2Migrated";

// Same idea, second time around: v0.29.15 replaced the keyword-scan location
// heuristic with a structural one (personLocationFromContactInfoRow), but any
// lead visited-and-failed under the OLD keyword-based code between v0.29.11
// and v0.29.14 already has the v2 migration's profileVisitedAt reset behind
// it - the v2 flag only fires once, and it already fired before v0.29.15
// shipped. Without a fresh flag, those leads stay permanently "checked" and
// the structural fix never gets a chance to run on them at all.
const LOCATION_HEURISTIC_V3_MIGRATED_KEY = "locationHeuristicV3Migrated";

export async function getResults() {
  const data = await chrome.storage.local.get([
    RESULTS_KEY,
    LOCATION_HEURISTIC_V2_MIGRATED_KEY,
    LOCATION_HEURISTIC_V3_MIGRATED_KEY,
  ]);
  const results = data[RESULTS_KEY] || {};
  const alreadyMigratedLocationHeuristic = Boolean(data[LOCATION_HEURISTIC_V2_MIGRATED_KEY]);
  const alreadyMigratedLocationHeuristicV3 = Boolean(data[LOCATION_HEURISTIC_V3_MIGRATED_KEY]);
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
    // Cleans up a location scraped before jobs-content-script.js started
    // stripping LinkedIn's own work-arrangement tag - "(Hybrid)", "(Remote)",
    // "(On-site)" - which describes the job's arrangement, not the place, and
    // was leaking straight into this field for job leads scraped earlier.
    if (lead.location && /\((?:hybrid|remote|on-?site)\)/i.test(lead.location)) {
      const cleaned = lead.location.replace(/\(\s*(?:hybrid|remote|on-?site)\s*\)/gi, " ").replace(/\s+/g, " ").trim();
      lead.location = cleaned || null;
      healed = true;
    }
    // v0.29.11 introduced profileVisitedAt so a genuinely-checked profile
    // isn't re-queued forever - but that same run marked plenty of leads
    // "checked" using the OLD, narrower location-detection heuristic (English
    // Swiss names only, then no non-Swiss city coverage at all). Without this,
    // v0.29.12/13's language and city-coverage fixes could never help a lead
    // that already got (incorrectly) marked done under the old rules -
    // reported directly: "Nashville Metropolitan Area" (Burke Holland) and
    // "New York, United States" (Allie K. Miller) both clearly show a real
    // location, yet stayed empty. Runs once: any lead still missing a
    // location gets its profileVisitedAt cleared so the next
    // "Extract Companies & Locations from Profiles" run gives it a fair shot
    // under the current heuristic - never touches a lead that already has a
    // location.
    if (!alreadyMigratedLocationHeuristic && !lead.location && lead.profileVisitedAt) {
      delete lead.profileVisitedAt;
      healed = true;
    }
    // Second pass of the same fix, for the v0.29.15 structural rewrite - see
    // the constant's comment above. Runs once, independently of the v2 flag
    // (a lead could already be past v2's reset and still need this one).
    if (!alreadyMigratedLocationHeuristicV3 && !lead.location && lead.profileVisitedAt) {
      delete lead.profileVisitedAt;
      healed = true;
    }
  }
  if (healed) await saveResults(results);
  if (!alreadyMigratedLocationHeuristic) {
    await chrome.storage.local.set({ [LOCATION_HEURISTIC_V2_MIGRATED_KEY]: true });
  }
  if (!alreadyMigratedLocationHeuristicV3) {
    await chrome.storage.local.set({ [LOCATION_HEURISTIC_V3_MIGRATED_KEY]: true });
  }
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
const ACTIVITY_LOG_EXPORTED_DAYS_KEY = "activityLogExportedDays";

function activityLogDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${ACTIVITY_LOG_PREFIX}${y}-${m}-${d}`;
}

// relatedCompanyKey/relatedContactKey (v0.29.53, PRD 6.19) are optional -
// only the Account/Contact views and callers that already know the context
// pass them. An entry without either simply never matches
// getActivityLogForCompany/getActivityLogForContact below - there's no
// migration to backfill them onto pre-existing entries (consistent with how
// this store already treats schema growth elsewhere), so a company/contact's
// activity log genuinely only goes back to whenever this shipped.
export async function appendActivityLog({
  actor, action, label, prevValue, newValue, error, errorMessage, relatedCompanyKey, relatedContactKey,
}) {
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
    relatedCompanyKey: relatedCompanyKey || null,
    relatedContactKey: relatedContactKey || null,
  });
  await chrome.storage.local.set({ [key]: dayLog });

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - ACTIVITY_LOG_RETENTION_DAYS);
  const cutoffKey = activityLogDayKey(cutoff);
  const all = await chrome.storage.local.get(null);
  const staleKeys = Object.keys(all).filter((k) => k.startsWith(ACTIVITY_LOG_PREFIX) && k < cutoffKey);
  if (staleKeys.length > 0) await chrome.storage.local.remove(staleKeys);

  // The exported-days tracking list (see getPendingActivityLogExportDays
  // below) should never grow forever either - drop anything referring to a
  // day that's already aged out of retention.
  const exportedDays = all[ACTIVITY_LOG_EXPORTED_DAYS_KEY] || [];
  const prunedExportedDays = exportedDays.filter((d) => `${ACTIVITY_LOG_PREFIX}${d}` >= cutoffKey);
  if (prunedExportedDays.length !== exportedDays.length) {
    await chrome.storage.local.set({ [ACTIVITY_LOG_EXPORTED_DAYS_KEY]: prunedExportedDays });
  }
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

// Account/Contact view "Log of recent activities" (PRD 6.19) - filters the
// same flat log above on the optional relatedCompanyKey/relatedContactKey
// fields, newest first.
export async function getActivityLogForCompany(companyKey) {
  const all = await getActivityLog();
  return all.filter((e) => e.relatedCompanyKey === companyKey).reverse();
}

export async function getActivityLogForContact(contactKey) {
  const all = await getActivityLog();
  return all.filter((e) => e.relatedContactKey === contactKey).reverse();
}

// Backs the periodic file export to /log - piggybacks on an already-existing
// manual trigger (the side panel's Scan button, same as the settings/leads
// backups) rather than a chrome.alarms schedule, since this app deliberately
// never runs anything in the background on its own. Only ever returns
// "closed" days (not today, which is still being written to and would
// produce a different file every time it's re-exported the same day) that
// haven't already been exported, so a day's file is written exactly once.
export async function getPendingActivityLogExportDays() {
  const all = await chrome.storage.local.get(null);
  const todayKey = activityLogDayKey(new Date());
  const exported = new Set(all[ACTIVITY_LOG_EXPORTED_DAYS_KEY] || []);
  return Object.keys(all)
    .filter((k) => k.startsWith(ACTIVITY_LOG_PREFIX) && k !== todayKey && !exported.has(k.slice(ACTIVITY_LOG_PREFIX.length)))
    .sort()
    .map((k) => ({ date: k.slice(ACTIVITY_LOG_PREFIX.length), entries: all[k] || [] }));
}

export async function markActivityLogDayExported(date) {
  const data = await chrome.storage.local.get(ACTIVITY_LOG_EXPORTED_DAYS_KEY);
  const exported = new Set(data[ACTIVITY_LOG_EXPORTED_DAYS_KEY] || []);
  exported.add(date);
  await chrome.storage.local.set({ [ACTIVITY_LOG_EXPORTED_DAYS_KEY]: [...exported] });
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
    targetAccounts,
    targetAccountsImportedAt,
    targetAccountScoreThreshold,
    locationFilterConfig,
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
    getTargetAccounts(),
    getTargetAccountsMeta().then((meta) => meta.importedAt),
    getTargetAccountScoreThreshold(),
    getLocationFilterConfig(),
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
    targetAccounts,
    targetAccountsImportedAt,
    targetAccountScoreThreshold,
    locationFilterConfig,
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
    ...(data.targetAccounts
      ? [chrome.storage.local.set({
          [TARGET_ACCOUNTS_KEY]: data.targetAccounts,
          [TARGET_ACCOUNTS_IMPORTED_AT_KEY]: data.targetAccountsImportedAt || null,
        })]
      : []),
    ...(typeof data.targetAccountScoreThreshold === "number"
      ? [saveTargetAccountScoreThreshold(data.targetAccountScoreThreshold)]
      : []),
    ...(data.locationFilterConfig ? [saveLocationFilterConfig(data.locationFilterConfig)] : []),
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
