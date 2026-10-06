import { geoUrnForCountry } from "./geo-urn-map.js";
import { parseLooseNumber, DEFAULT_EXCHANGE_RATES } from "./value-normalize.js";
import { joinProposalItems, applyJoinProposal } from "./team-proposals.js";
import { listingRevenue } from "./discovery-filter.js";
import { DEFAULT_ARBITRATION_SETTINGS, arbitrateAccount, arbitrationContext } from "./web-findings-arbitration.js";
import { assessAccount, isScannable, deriveProvenance, applicableProvenance, provenanceValueKey, toEpochMs, seniorityLevelFromLabel, isGoodSource } from "./readiness.js";
import { LANE_MAX_PEOPLE, normalizeCompletionTargets, normalizeInitiativeStages, initiativeCounts, targetsStatus } from "./pipeline-plan.js";
import { accountInputsKey, effectivePipeline, lackingReason, duplicateGroups, idVerifiedFor, accountPairKey, sortDecisions, similarKey } from "./decision-rules.js";
import { computeFindingProposals, researchConfirms, webCitationFor, findingValue, findingUrl, isCitedValue, researchContacts, researchInitiatives, linkedinCompanyUrl } from "./web-research-apply.js";
import { mergeFieldChanges } from "./extras-merge.js";
import { normalizeCompanyName, buildExclusionMatcher, buildRelationshipMatcher, matchesExclusion, matchesRelationship, websiteDomain, webCompanyId } from "./company-identity.js";
import { splitCompanyLists, isRelationshipCategory, RELATIONSHIP_CATEGORIES, RELATIONSHIP_CATEGORY_LABELS } from "./relationships.js";
export { normalizeCompanyName, buildExclusionMatcher, websiteDomain };
export { RELATIONSHIP_CATEGORIES, RELATIONSHIP_CATEGORY_LABELS };
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

// --------------------------------------------------------------------------
// Scan settings - post topics, timeframe, author titles
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// Job-search settings
// --------------------------------------------------------------------------

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
// "Use the same location as in the main settings": the Job Listing Search takes its location from the target countries
// chosen in the Setup wizard (their LinkedIn location IDs are the confirmed ones in geo-urn-map.js). On by default;
// when no target country has a confirmed ID, the location picked by hand still applies.
const JOB_SEARCH_USE_MAIN_LOCATION_KEY = "jobSearchUseMainLocation";

export async function getJobSearchUseMainLocation() {
  const data = await chrome.storage.local.get(JOB_SEARCH_USE_MAIN_LOCATION_KEY);
  return data[JOB_SEARCH_USE_MAIN_LOCATION_KEY] !== false;
}

export async function saveJobSearchUseMainLocation(value) {
  await chrome.storage.local.set({ [JOB_SEARCH_USE_MAIN_LOCATION_KEY]: Boolean(value) });
}

// {name, geoId, extraCount} for the first target country that has a confirmed LinkedIn location ID, or null.
export async function getMainLocationForJobs() {
  const config = await getTargetUniverseConfig();
  const countries = [...new Set((config && config.countries) || [])];
  for (const name of countries) {
    const geoId = geoUrnForCountry(name);
    if (geoId) return { name, geoId, extraCount: countries.length - 1 };
  }
  return null;
}

export async function getEffectiveJobSearchLocation() {
  if (await getJobSearchUseMainLocation()) {
    const main = await getMainLocationForJobs();
    if (main) return main.geoId;
  }
  return getJobSearchLocation();
}

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

// --------------------------------------------------------------------------
// Seller context - company, website, ideal customer profile
// --------------------------------------------------------------------------

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

// 1.2.1 (onboarding research, design 3.1): the seller's own company name, asked on the wizard's "About you" step -
// needed to research the seller, and to recognise the seller's own company when it turns up in Web Discovery.
const SELLER_COMPANY_NAME_KEY = "sellerCompanyName";

export async function getSellerCompanyName() {
  const data = await chrome.storage.local.get(SELLER_COMPANY_NAME_KEY);
  return data[SELLER_COMPANY_NAME_KEY] || "";
}

export async function saveSellerCompanyName(name) {
  await chrome.storage.local.set({ [SELLER_COMPANY_NAME_KEY]: String(name || "").trim() });
}

// The seller research and the wizard proposals built from it (design 3.2): { status: "none" | "running" | "done" |
// "failed" | "stopped" | "skipped", at, heartbeatAt, costUsd, model, ms, seller: { name, website }, raw, briefing,
// proposals: { [step]: proposal }, accepted: { [step]: at }, error }. Nothing here is a setting: a proposal reaches the
// real settings keys only through the step's own save, when the user presses Next.
const SETUP_RESEARCH_KEY = "setupResearch";

export async function getSetupResearch() {
  const data = await chrome.storage.local.get(SETUP_RESEARCH_KEY);
  return { status: "none", proposals: {}, accepted: {}, ...(data[SETUP_RESEARCH_KEY] || {}) };
}

export async function saveSetupResearch(research) {
  await chrome.storage.local.set({ [SETUP_RESEARCH_KEY]: research });
}

// 1.2.1 step 6 (design 3.10): how big the list should be - { accounts, contactsPerAccount, initiativesPerAccount }.
// Contacts per account never exceeds the Target contacts step's maximum per account.
const COMPLETION_TARGETS_KEY = "completionTargets";

export async function getCompletionTargets() {
  const data = await chrome.storage.local.get([COMPLETION_TARGETS_KEY, TARGET_CONTACT_PROFILE_KEY]);
  return normalizeCompletionTargets(data[COMPLETION_TARGETS_KEY], data[TARGET_CONTACT_PROFILE_KEY]?.maxContactsPerAccount);
}

export async function saveCompletionTargets(targets) {
  const profile = await getTargetContactProfile();
  await chrome.storage.local.set({ [COMPLETION_TARGETS_KEY]: normalizeCompletionTargets(targets, profile.maxContactsPerAccount) });
}

// Design 3.7: the initiative stages the seller cares about, ranked: [{ id, checked }] (all seven, in order).
const INITIATIVE_STAGE_PREFERENCE_KEY = "initiativeStagePreference";

export async function getInitiativeStagePreference() {
  const data = await chrome.storage.local.get(INITIATIVE_STAGE_PREFERENCE_KEY);
  return normalizeInitiativeStages(data[INITIATIVE_STAGE_PREFERENCE_KEY]);
}

export async function saveInitiativeStagePreference(stages) {
  await chrome.storage.local.set({ [INITIATIVE_STAGE_PREFERENCE_KEY]: normalizeInitiativeStages(stages) });
}

// Design 3.8: companies the user wants in the list whatever their size or industry - [{ name, website }]. Web
// Discovery adds them first; an exclusion still wins.
const INCLUDED_COMPANIES_KEY = "includedCompanies";

export async function getIncludedCompanies() {
  const data = await chrome.storage.local.get(INCLUDED_COMPANIES_KEY);
  return Array.isArray(data[INCLUDED_COMPANIES_KEY]) ? data[INCLUDED_COMPANIES_KEY] : [];
}

export async function saveIncludedCompanies(companies) {
  const seen = new Set();
  const clean = [];
  for (const c of companies || []) {
    const name = String(c?.name || "").trim();
    const website = String(c?.website || "").trim();
    const key = normalizeCompanyName(name) || websiteDomain(website);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clean.push({ name: name || websiteDomain(website), ...(website ? { website } : {}) });
  }
  await chrome.storage.local.set({ [INCLUDED_COMPANIES_KEY]: clean });
}

// R8.3: what the web lanes actually cost on this install, summed per account - the Targets step's estimate uses it
// once 20 accounts have gone through a lane. { discovery: { accounts, usd }, lane: { accounts, usd, seconds } }.
const ONBOARDING_MEASURES_KEY = "onboardingMeasures";

export async function getOnboardingMeasures() {
  const data = await chrome.storage.local.get(ONBOARDING_MEASURES_KEY);
  return data[ONBOARDING_MEASURES_KEY] || { discovery: { accounts: 0, usd: 0 }, lane: { accounts: 0, usd: 0, seconds: 0 } };
}

export async function addOnboardingMeasure(lane, { accounts = 0, usd = 0, seconds = 0 }) {
  const m = await getOnboardingMeasures();
  const cur = m[lane] || { accounts: 0, usd: 0, seconds: 0 };
  m[lane] = { accounts: cur.accounts + accounts, usd: cur.usd + usd, seconds: (cur.seconds || 0) + seconds };
  await chrome.storage.local.set({ [ONBOARDING_MEASURES_KEY]: m });
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

// --------------------------------------------------------------------------
// Target universe - size buckets, seniority, contact profile, priority guidelines
// --------------------------------------------------------------------------

// Which companies to search for - also, since 2026-09-16, the ONE location
// setting driving lead filtering too (storage.js's own
// generalLocationFilterConfig, replacing what used to be a wholly separate
// locationFilterConfig). The wizard's own country picker offers the full
// ALL_COUNTRIES list (widened the same day, to match Location Filter's own
// scope) - Discovery's company search itself still only ever uses whichever
// selected countries happen to have a confirmed geoUrn (geo-urn-map.js),
// silently more permissive for lead filtering than for the real LinkedIn
// search facet it can build, surfaced via unscopedCountries rather than
// guessed at.
// Size targeting (PRD 6.20, redesigned 2026-09-16 from the earlier "Top N
// largest" vs. min/max-range toggle) - 5 fixed, independently checkable
// buckets, each carrying its own 1-3 (Low/Medium/High) priority when
// checked. Confirmed by the user (2026-09-15, built the next day): these
// boundaries don't line up 1:1 with LinkedIn's own confirmed companySize
// facet letters (B-I, company-discovery-extraction.js's SIZE_BUCKETS) - a
// bucket can span more than one LinkedIn letter (Small spans B/C/D) or line
// up exactly with one (Large = F exactly) - company-discovery-extraction.js
// computes the actual letters to request per checked bucket, this table
// only defines the buckets themselves.
export const SIZE_PRIORITY_BUCKETS = [
  { key: "S", label: "Small", min: 0, max: 200 },
  { key: "M", label: "Medium", min: 201, max: 500 },
  { key: "L", label: "Large", min: 501, max: 1000 },
  { key: "XL", label: "Extra Large", min: 1001, max: 5000 },
  { key: "XXL", label: "Extra Extra Large", min: 5001, max: Infinity },
];

function defaultSizeBuckets() {
  // All checked, Medium priority - the closest equivalent to the old
  // default ("Top N largest, no other size restriction"): a brand-new
  // wizard run (and, via the plain object-spread default below, an
  // existing saved config from before this redesign, which never has a
  // sizeBuckets key to override this) both start with no real restriction,
  // narrowed from here rather than forced to pick before continuing.
  const buckets = {};
  for (const b of SIZE_PRIORITY_BUCKETS) buckets[b.key] = { checked: true, priority: 2 };
  return buckets;
}

const TARGET_UNIVERSE_CONFIG_KEY = "targetUniverseConfig";
const DEFAULT_TARGET_UNIVERSE_CONFIG = {
  locationMode: "country", continents: [], countries: [],
  locationPriorities: {},
  sizeBuckets: null, // resolved to defaultSizeBuckets() below, not inline - see getTargetUniverseConfig
  maxCompanies: 200, industries: [],
};

// industries used to be a flat string[] (which industry names are
// included); redesigned 2026-09-16 into { name, priority }[] so each
// included industry also carries its own 1-3 priority, same idea as
// Size's per-bucket priority above. A config saved before this redesign
// still has the old flat-string shape in storage - normalized here (the
// single place every consumer reads targetUniverseConfig through) rather
// than requiring onboarding.js/company-discovery-extraction.js to each
// defend against both shapes themselves. Idempotent - already-normalized
// entries pass through unchanged, so this is cheap to run on every read.
function normalizeIndustries(industries) {
  return (industries || []).map((entry) =>
    typeof entry === "string" ? { name: entry, priority: 2 } : { name: entry.name, priority: entry.priority ?? 2 }
  );
}

// Extracted (2026-09-16, same day as the redesign, after a real bug this
// caused) so a config read from somewhere OTHER than a fresh
// getTargetUniverseConfig() call - specifically discoveryQueueState's own
// frozen configSnapshot, a raw deep-clone taken at a run's own Start time,
// never normalized on its own - can be normalized the exact same way
// before being compared against anything. Without this, a snapshot frozen
// before this same-day redesign (real case: a Discovery run started earlier
// the same session, before Size/Industry's schema changed) reads as
// sizeBuckets: {} (no buckets "checked") and industries: [{name: undefined,
// ...}] (a string has no .name) when read raw - both compare as
// unconditionally "changed" against any current config, a guaranteed false
// positive onboarding.js's stale-Discovery warning hit in exactly this way.
export function normalizeTargetUniverseConfig(config) {
  return {
    ...DEFAULT_TARGET_UNIVERSE_CONFIG,
    ...(config || {}),
    sizeBuckets: config?.sizeBuckets || defaultSizeBuckets(),
    industries: normalizeIndustries(config?.industries),
  };
}

export async function getTargetUniverseConfig() {
  const data = await chrome.storage.local.get(TARGET_UNIVERSE_CONFIG_KEY);
  return normalizeTargetUniverseConfig(data[TARGET_UNIVERSE_CONFIG_KEY]);
}

export async function saveTargetUniverseConfig(config) {
  await chrome.storage.local.set({ [TARGET_UNIVERSE_CONFIG_KEY]: config });
}

// Who to look for once a target company is found - distinct from Topics'
// keywords/andKeywords (sidepanel.js), which match post content, not a
// person's title.
const TARGET_CONTACT_PROFILE_KEY = "targetContactProfile";
// maxContactsPerAccount added 2026-09-15 (PRD 6.20 Phase 6) - default 10,
// per the user's own explicit request, up from an earlier "~4-5" estimate
// elsewhere in the plan.
// seniorityLevels added 2026-09-17 - LinkedIn's company People tab has no
// seniority-level facet (confirmed live via Claude in Chrome on
// linkedin.com/company/*/people/ - only free-text title search exists), so
// each selected level is just a shortcut that expands into keyword terms
// (SENIORITY_LEVEL_KEYWORDS below) and unions into titleKeywords before the
// existing keyword-chunk search runs (contact-discovery-extraction.js) -
// additive, never replacing the user's own typed exactTitles/titleKeywords.
// Shape: { id, priority }[] - same checkbox-plus-1/2/3-priority pattern as
// targetUniverseConfig.industries (onboarding.js's renderIndustryPriorityRows),
// per the user's own explicit request that seniority also feed lead
// prioritization, not just which contacts get kept - a matched contact gets
// tagged with the highest-priority selected level their headline shows
// (classifyCandidateSeniority, contact-discovery-extraction.js), stamped
// onto their contact row (buildDiscoveredContactRow's seniorityPriority),
// and usable from the Post-lead rule engine below via a new
// "authorSeniorityAtLeast" condition type.
const DEFAULT_TARGET_CONTACT_PROFILE = { exactTitles: [], titleKeywords: [], seniorityLevels: [], maxContactsPerAccount: 10 };

export const SENIORITY_LEVELS = [
  { id: "board", label: "Board / Chairman" },
  { id: "cLevel", label: "C-level" },
  { id: "vp", label: "VP-level" },
  { id: "head", label: "Head-level" },
  { id: "director", label: "Director-level" },
  { id: "manager", label: "Manager-level" },
];

export const SENIORITY_LEVEL_KEYWORDS = {
  board: ["Chairman", "Chairwoman", "Chairperson", "Board Member", "Board of Directors", "Non-Executive Director", "NED"],
  cLevel: [
    "CEO", "COO", "CFO", "CTO", "CMO", "CIO", "CISO", "CHRO", "CRO", "CPO", "CAIO", "CDO",
    "Chief Executive Officer", "Chief Operating Officer", "Chief Financial Officer", "Chief Technology Officer",
    "Chief Marketing Officer", "Chief Information Officer", "Chief Information Security Officer",
    "Chief Human Resources Officer", "Chief Revenue Officer", "Chief Product Officer", "Chief AI Officer",
    "Chief Data Officer", "Founder", "Co-Founder", "Managing Director", "Owner",
  ],
  vp: ["VP", "Vice President", "SVP", "Senior Vice President", "EVP", "Executive Vice President", "AVP", "Assistant Vice President"],
  head: ["Head of", "Global Head", "Regional Head"],
  director: ["Director", "Senior Director", "Sr Director", "Executive Director", "Group Director"],
  manager: ["Manager", "Senior Manager", "Sr Manager", "Team Lead"],
};

// Flattens the selected levels ({ id, priority }[]) into a deduped keyword
// list, case-insensitively (a level's own list never has internal dupes, but
// two selected levels could otherwise both contribute e.g. "Director").
export function expandSeniorityLevelKeywords(seniorityLevels) {
  const seen = new Set();
  const terms = [];
  for (const level of seniorityLevels || []) {
    const levelId = typeof level === "string" ? level : level.id;
    for (const term of SENIORITY_LEVEL_KEYWORDS[levelId] || []) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
    }
  }
  return terms;
}

// Which of the user's SELECTED seniority levels (Contacts step, highest priority wins) a plain
// job title demonstrates - used for contacts that did not come from LinkedIn Discovery (their
// workbook Job_Title is a clean single title, so no headline/company-segment handling is
// needed, unlike contact-discovery-extraction.js's classifyCandidateSeniority). Returns the
// { id, priority } level, or null when no levels are configured or none matches.
// Any "Chief … Officer" title is C-level, whatever sits between the two words (2026-09-25): the fixed
// keyword list only knew whole phrases, so "Chief Digital & Information Officer" (Sika) and "Group
// Chief Transformation Officer" matched no level at all.
export const CHIEF_OFFICER_RE = /\bchief\b[^|,;@]{0,60}?\bofficer\b/i;

export function classifyJobTitleSeniority(jobTitle, seniorityLevels) {
  const title = (jobTitle || "").toLowerCase();
  if (!title || !seniorityLevels || seniorityLevels.length === 0) return null;
  const sorted = [...seniorityLevels].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const level of sorted) {
    if (level.id === "cLevel" && CHIEF_OFFICER_RE.test(title)) return level;
    for (const term of SENIORITY_LEVEL_KEYWORDS[level.id] || []) {
      for (const variant of titleVariants(term)) {
        if (containsWholeWord(title, variant.toLowerCase())) return level;
      }
    }
  }
  return null;
}

// A contact carrying ONE seniorityPriority whichever way it was learned: a Discovered contact's
// stored value wins, otherwise the level its job title demonstrates. Read by the Post-lead
// "authorSeniorityAtLeast" rule so imported contacts count too.
export function withEffectiveSeniorityPriority(contact, seniorityLevels) {
  if (!contact || contact.seniorityPriority) return contact;
  const level = classifyJobTitleSeniority(contact.jobTitle, seniorityLevels);
  return level ? { ...contact, seniorityPriority: level.priority ?? null, seniorityLevel: level.id } : contact;
}

export async function getTargetContactProfile() {
  const data = await chrome.storage.local.get(TARGET_CONTACT_PROFILE_KEY);
  return { ...DEFAULT_TARGET_CONTACT_PROFILE, ...(data[TARGET_CONTACT_PROFILE_KEY] || {}) };
}

export async function saveTargetContactProfile(profile) {
  await chrome.storage.local.set({ [TARGET_CONTACT_PROFILE_KEY]: profile });
}

// The user's own ranked Size/Location/Industry priority guideline, feeding
// a future company-scoring pass (PRD 6.20 Phase 8, not yet built).
// Shrunk 2026-09-16 - topSize/topLocations/topIndustries removed outright,
// each superseded by a per-item priority living on its own step instead
// (Location's locationPriorities, Size's sizeBuckets[key].priority,
// Industry's industries[].priority, all targetUniverseConfig above) per the
// user's own confirmed direction (2026-09-15). A config saved before this
// redesign may still carry those old fields in storage - harmless leftover
// data, never read by anything now, not explicitly stripped.
const ACCOUNT_PRIORITY_GUIDELINES_KEY = "accountPriorityGuidelines";
const DEFAULT_ACCOUNT_PRIORITY_GUIDELINES = {
  criteriaOrder: ["size", "location", "industry"],
};

export async function getAccountPriorityGuidelines() {
  const data = await chrome.storage.local.get(ACCOUNT_PRIORITY_GUIDELINES_KEY);
  return { ...DEFAULT_ACCOUNT_PRIORITY_GUIDELINES, ...(data[ACCOUNT_PRIORITY_GUIDELINES_KEY] || {}) };
}

export async function saveAccountPriorityGuidelines(guidelines) {
  await chrome.storage.local.set({ [ACCOUNT_PRIORITY_GUIDELINES_KEY]: guidelines });
}

// --------------------------------------------------------------------------
// Exclusions, organization-type eligibility, company aliases
// --------------------------------------------------------------------------

// Unified company exclusion list (PRD 6.20, unified 2026-09-17 from 4
// separate lists - competitorCompanySlugs/recruiterCompanySlugs/
// existingCustomerCompanySlugs/existingPartnerCompanySlugs - into one list
// of { slug, category } entries). Reported directly: a ChatGPT-researched
// workbook can now arrive with its own "Exclusion List" sheet, itself one
// list with a category per row (competitor/customer/partner/other) - a
// single list here, with the same shape, is what makes cross-referencing
// the two straightforward instead of a 4-vs-1 mismatch. Deliberately still
// per-entry categorized (not just one flat list) for the same reason the
// old 4-list design gave for staying separate in the first place: a future
// "why was this excluded" view stays meaningful. "recruiter" has no
// equivalent on ChatGPT's side (its own vocabulary is competitor/customer/
// partner/other) but stays a first-class category here regardless - it's
// still what Discovery's own search results need filtered, ChatGPT's
// research just never populates it. slug is a LinkedIn company-page slug
// (parseLinkedinCompanySlug below), the same identity-based exclusion
// reasoning as always - sidesteps the legal-suffix/short-name/misspelling
// mess a name-based match would hit.
// 1.2.3 (EXCLUSIONS_RELATIONSHIPS_DESIGN.md 3.1): customer and partner are no longer exclusion categories - they
// moved to companyRelationships (RELATIONSHIP_CATEGORIES, relationships.js). Old entries of those categories can
// still sit in companyExclusions (an old backup, a team member before the move); the exclusion matcher skips them.
export const EXCLUSION_CATEGORIES = ["competitor", "recruiter", "other"];

export const EXCLUSION_CATEGORY_LABELS = {
  competitor: "Competitor",
  recruiter: "Recruiter / staffing agency",
  other: "Other",
};

const COMPANY_EXCLUSIONS_KEY = "companyExclusions";

// Well-known global staffing/recruiting/executive-search firms, seeded once
// (see migrateLegacyExclusionListsIfNeeded below) so the onboarding
// wizard's Exclusions step only asks the user to add local ones - each slug
// confirmed live against a real LinkedIn company page, per this project's
// "never guess a LinkedIn URL" discipline (one name, "Panda International,"
// has an unrelated same-named company; the slug here is the verified
// Staffing and Recruiting one, not a guess). 4 more added 2026-09-15,
// confirmed live during Phase 5 testing: a real keywords=<country>-anchored
// discovery search (see company-discovery-extraction.js's buildSearchUrl)
// surfaces staffing/recruiting firms disproportionately often, and these
// weren't yet covered by the seed list above - each is its own separate
// LinkedIn page from its global parent (lhhworldwide from Adecco Group's
// own "adecco" page; experis-switzerland from ManpowerGroup's own
// "manpowergroup" page), not a duplicate entry.
const DEFAULT_RECRUITER_SLUGS = [
  "adecco", "michael-page", "robert-walters", "hays", "harvey-nash", "manpowergroup",
  "heidrick-&-struggles", "spencer-stuart", "lionstep", "panda-international", "jobgether",
  "coople-switzerland", "lhhworldwide", "randstad-switzerland", "experis-switzerland",
];

const COMPANY_EXCLUSIONS_MIGRATED_KEY = "companyExclusionsMigrated";

// One-time migration guard (same pattern as LOCATION_HEURISTIC_V2_MIGRATED_KEY
// elsewhere in this file) - folds the 4 old separate keys (if this install
// ever had them) into one companyExclusions list, tagging each slug with
// the category its old list implied. Also covers a genuinely fresh
// install: the old recruiter list used null (not []) to mean "user never
// touched this, seed the defaults" - a fresh install's legacy read comes
// back undefined the same way, so it takes the same defaults-seeding
// branch below. Runs at most once per install; after that,
// COMPANY_EXCLUSIONS_MIGRATED_KEY short-circuits every future call.
async function migrateLegacyExclusionListsIfNeeded() {
  const guard = await chrome.storage.local.get(COMPANY_EXCLUSIONS_MIGRATED_KEY);
  if (guard[COMPANY_EXCLUSIONS_MIGRATED_KEY]) return;
  const legacy = await chrome.storage.local.get([
    "competitorCompanySlugs", "recruiterCompanySlugs", "existingCustomerCompanySlugs", "existingPartnerCompanySlugs",
  ]);
  const recruiterSlugs = legacy.recruiterCompanySlugs == null ? DEFAULT_RECRUITER_SLUGS : legacy.recruiterCompanySlugs;
  const merged = [
    ...(legacy.competitorCompanySlugs || []).map((slug) => ({ slug, category: "competitor" })),
    ...recruiterSlugs.map((slug) => ({ slug, category: "recruiter" })),
    ...(legacy.existingCustomerCompanySlugs || []).map((slug) => ({ slug, category: "customer" })),
    ...(legacy.existingPartnerCompanySlugs || []).map((slug) => ({ slug, category: "partner" })),
  ];
  await chrome.storage.local.set({ [COMPANY_EXCLUSIONS_KEY]: merged, [COMPANY_EXCLUSIONS_MIGRATED_KEY]: true });
}

export async function getCompanyExclusions() {
  await migrateLegacyExclusionListsIfNeeded();
  const data = await chrome.storage.local.get(COMPANY_EXCLUSIONS_KEY);
  return data[COMPANY_EXCLUSIONS_KEY] || [];
}

// Slugs the user took OFF the exclusion list (2026-09-29). The research workbook's Exclusion_List marks some
// companies "Competitor" (Excluded = Yes on the row) and the import copies them onto this list; before this,
// removing one in the wizard changed nothing, because the row's own flag still excluded it. A lifted slug
// overrides that flag, and the import's backfill never puts it back - so the user's removal survives a
// re-import. Putting the slug back on the list un-lifts it.
const COMPANY_EXCLUSIONS_LIFTED_KEY = "companyExclusionsLifted";

export async function getCompanyExclusionsLifted() {
  const data = await chrome.storage.local.get(COMPANY_EXCLUSIONS_LIFTED_KEY);
  return data[COMPANY_EXCLUSIONS_LIFTED_KEY] || [];
}

// The matcher every exclusion check uses: the list plus the lifted slugs, and (1.2.3) the customers / partners,
// which keep the workbook's own Excluded flag from hiding them (isCompanyRowExcluded).
export async function getExclusionMatcher() {
  const [exclusions, lifted, relationships] = await Promise.all([getCompanyExclusions(), getCompanyExclusionsLifted(), getCompanyRelationships()]);
  return buildExclusionMatcher(exclusions, lifted, buildRelationshipMatcher(relationships, exclusions));
}

// Customers and partners (1.2.3, design 3.1): { category: "customer" | "partner", slug?, name?, domain?, source?,
// sourceUrl? } - the same shape and matching as companyExclusions. Shared per entry in a team (team-keys.js).
const COMPANY_RELATIONSHIPS_KEY = "companyRelationships";

export async function getCompanyRelationships() {
  const data = await chrome.storage.local.get(COMPANY_RELATIONSHIPS_KEY);
  return data[COMPANY_RELATIONSHIPS_KEY] || [];
}

export async function saveCompanyRelationships(relationships) {
  await chrome.storage.local.set({ [COMPANY_RELATIONSHIPS_KEY]: (relationships || []).filter((e) => e && isRelationshipCategory(e.category)) });
}

// Both lists in one go (the Setup steps, Move to... - design 9.3): entries are sorted onto the right list by their
// category, whichever argument they came in.
export async function saveCompanyLists({ exclusions, relationships }) {
  const split = splitCompanyLists(exclusions || [], []);
  const keep = new Set();
  const rels = [...(relationships || []), ...split.relationships].filter((e) => {
    if (!e || !isRelationshipCategory(e.category)) return false;
    const k = JSON.stringify([e.category, e.slug || "", normalizeCompanyName(e.name || ""), websiteDomain(e.domain || "") || ""]);
    if (keep.has(k)) return false;
    keep.add(k);
    return true;
  });
  await saveCompanyExclusions(split.exclusions);
  await saveCompanyRelationships(rels);
}

// relationshipOf(matcher, { slug, name, website }) -> [] | ["customer"] | ["partner"] | both (company-identity.js).
export async function getRelationshipMatcher() {
  const [relationships, exclusions] = await Promise.all([getCompanyRelationships(), getCompanyExclusions()]);
  return buildRelationshipMatcher(relationships, exclusions);
}

// Design 4.1 / 4.2: moves customer / partner entries off the exclusion list onto companyRelationships. Idempotent
// (splitCompanyLists), so it runs on every update, after a restore and after a workbook import. In a team only the
// Team Admin's SalesTeam moves them - the sync layer carries the change to the members, whose matchers already
// treat leftover entries right. Returns { customer, partner } moved, or null when nothing was left to move.
const RELATIONSHIPS_NOTICE_KEY = "relationshipsMigrationNotice";

export async function migrateCompanyRelationshipsIfNeeded({ trigger = "update" } = {}) {
  const team = (await chrome.storage.local.get("teamMembership")).teamMembership;
  if (team && team.role !== "admin") return null;
  const [exclusions, relationships] = await Promise.all([getCompanyExclusions(), getCompanyRelationships()]);
  const split = splitCompanyLists(exclusions, relationships);
  if (split.exclusions.length === exclusions.length) return null;
  // Written directly, not via saveCompanyExclusions: a moved entry is not one the user took off the list, so its
  // slug is not "lifted".
  await chrome.storage.local.set({
    [COMPANY_EXCLUSIONS_KEY]: split.exclusions, [COMPANY_RELATIONSHIPS_KEY]: split.relationships,
  });
  const { customer, partner } = split.moved;
  if (customer + partner) {
    const prev = (await chrome.storage.local.get(RELATIONSHIPS_NOTICE_KEY))[RELATIONSHIPS_NOTICE_KEY];
    await chrome.storage.local.set({
      [RELATIONSHIPS_NOTICE_KEY]: { customer: customer + (prev?.customer || 0), partner: partner + (prev?.partner || 0), at: Date.now() },
    });
    await appendActivityLog({
      actor: "system", action: "relationships_migrated",
      label: `${relationshipsMovedText(split.moved)} (${trigger})`, newValue: { customer, partner, trigger },
    }).catch(() => {});
  }
  return split.moved;
}

// "12 customers and 3 partners are no longer excluded - they are now accounts with a Relationship tag" (R3.2).
export function relationshipsMovedText({ customer = 0, partner = 0 } = {}) {
  const parts = [];
  if (customer) parts.push(`${customer} customer${customer === 1 ? "" : "s"}`);
  if (partner) parts.push(`${partner} partner${partner === 1 ? "" : "s"}`);
  if (!parts.length) return "";
  const many = customer + partner !== 1;
  return `${parts.join(" and ")} ${many ? "are" : "is"} no longer excluded - ${many ? "they are now accounts" : "it is now an account"} with a Relationship tag`;
}

// The one-time pop-up after the move (R3.2): read once by a page, then cleared.
export async function takeRelationshipsMigrationNotice() {
  const notice = (await chrome.storage.local.get(RELATIONSHIPS_NOTICE_KEY))[RELATIONSHIPS_NOTICE_KEY];
  if (!notice) return null;
  await chrome.storage.local.remove(RELATIONSHIPS_NOTICE_KEY);
  return notice;
}

export async function saveCompanyExclusions(exclusions) {
  const [before, lifted] = await Promise.all([getCompanyExclusions(), getCompanyExclusionsLifted()]);
  const keptSlugs = new Set(exclusions.map((e) => e && e.slug).filter(Boolean));
  const removed = before.map((e) => e && e.slug).filter((s) => s && !keptSlugs.has(s));
  const nextLifted = [...new Set([...lifted, ...removed])].filter((s) => !keptSlugs.has(s));
  await chrome.storage.local.set({
    [COMPANY_EXCLUSIONS_KEY]: exclusions, [COMPANY_EXCLUSIONS_MIGRATED_KEY]: true, [COMPANY_EXCLUSIONS_LIFTED_KEY]: nextLifted,
  });
}

// A Companies-sheet row's own Excluded column (added 2026-09-17, confirmed
// live against Swiss_AI_Prospects_528_V55_FULL_17-9-2026.xlsx - a plain
// "Yes"/"No" text cell, blank on an older workbook that predates the
// column). true is also accepted for a workbook that happens to write it
// as a real boolean cell.
export function isExcludedFlagTruthy(value) {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().toLowerCase() === "yes";
  return false;
}

// A company is excluded if EITHER source says so: the workbook's own
// Excluded flag (ChatGPT's research-time exclusion), or this app's own
// companyExclusions list - either one is enough, independent of the other.
// The list matches by LinkedIn slug (via the row's linkedinLink), and since
// 1.2.1 step 1 also by normalised company name or website domain (design
// 3.9). `matcher` is buildExclusionMatcher(getCompanyExclusions()), built
// once by the caller rather than per row; a plain Set of slugs (the form
// before 1.2.1) is still accepted.
export function isCompanyRowExcluded(companyRow, matcher) {
  if (!companyRow) return false;
  const slug = parseLinkedinCompanySlug(companyRow.linkedinLink || "");
  // The workbook's flag counts unless the user took this company off the list (companyExclusionsLifted).
  const lifted = Boolean(slug && matcher && matcher.lifted && matcher.lifted.has(String(slug).toLowerCase()));
  // 1.2.3: nor when it is a customer / partner (matcher.kept) - those are accounts, not exclusions.
  const kept = Boolean(matcher && matcher.kept && matchesRelationship(matcher.kept, { slug, name: companyRow.company, website: companyRow.website }));
  if (isExcludedFlagTruthy(companyRow.excluded) && !lifted && !kept) return true;
  if (matcher instanceof Set) return slug ? matcher.has(slug) : false;
  return matchesExclusion(matcher, { slug, name: companyRow.company, website: companyRow.website });
}

// Real Exclusion_Reason values confirmed live (Swiss_AI_Prospects_528_V55) -
// "Competitor" only so far in that file, but the user's own description of
// the feature says Customer/Partner/Other are also possible values. Case-
// insensitive. "recruiter" has no ChatGPT-side equivalent (its own
// vocabulary is competitor/customer/partner/other) and simply won't appear
// here - an unrecognized/missing reason resolves to null below, meaning the
// company still gets excluded everywhere via its own Excluded flag
// (isCompanyRowExcluded doesn't depend on this), it just isn't backfilled
// into any specific named category.
const EXCLUSION_REASON_TO_CATEGORY = {
  competitor: "competitor",
  customer: "customer",
  partner: "partner",
  other: "other",
};

// Additive-only backfill (PRD 6.20, 2026-09-17, the user's own proposal): a
// company the workbook's Companies sheet marks Excluded=Yes, cross-
// referenced against that same workbook's own Exclusion_List sheet (joined
// by Company_ID, confirmed live as the reliable key both sheets already
// share) for its reason, gets added to this app's own companyExclusions
// list under the matching category - if it isn't already on it by
// LinkedIn slug - saving the user from re-entering by hand what the
// workbook's own research already found. Never removes anything - a
// company absent from a given import isn't evidence it stopped being a
// competitor/customer/partner, this app's own list stays authoritative for
// removal, per the user's explicit instruction. Call this right after
// importTargetAccountsWorkbook - Dashboard visibility and Discovery
// filtering don't depend on it succeeding (a company's own Excluded flag
// already hides/excludes it independently, see isCompanyRowExcluded /
// company-discovery-extraction.js), this only affects whether it also
// lands in a specific named category (for the Negative Topics builtin
// lists, and so the user can see/edit it in the wizard going forward).
export async function backfillCompanyExclusionsFromWorkbook(workbook) {
  const reasonByCompanyId = new Map(
    (workbook.exclusionList || [])
      .filter((row) => row.companyId)
      .map((row) => [row.companyId, String(row.exclusionReason || "").trim().toLowerCase()])
  );
  const excludedCompanies = (workbook.companies || []).filter((c) => isExcludedFlagTruthy(c.excluded));

  const [exclusions, lifted, relationships] = await Promise.all([getCompanyExclusions(), getCompanyExclusionsLifted(), getCompanyRelationships()]);
  // A slug the user took off the list stays off (companyExclusionsLifted).
  const existingSlugs = new Set([...exclusions.map((e) => e.slug), ...lifted]);
  const added = [];
  const addedRelationships = [];
  const relMatcher = buildRelationshipMatcher(relationships, exclusions);
  let skippedNoLink = 0;
  let skippedUnrecognizedReason = 0;

  for (const company of excludedCompanies) {
    const slug = parseLinkedinCompanySlug(company.linkedinLink || "");
    // 1.2.3 (R3.3): a Customer / Partner reason puts the company on the relationship list instead - it stays an
    // account (isCompanyRowExcluded: the list overrides the row's Excluded flag). Needs no LinkedIn link.
    const relReason = reasonByCompanyId.get(company.companyId);
    const relCategory = relReason ? EXCLUSION_REASON_TO_CATEGORY[relReason] : null;
    if (isRelationshipCategory(relCategory)) {
      const ident = { slug, name: company.company, website: company.website };
      if (!matchesExclusion(relMatcher[relCategory], ident)) {
        const domain = websiteDomain(company.website || "");
        const entry = {
          category: relCategory, ...(slug ? { slug } : {}), ...(company.company ? { name: company.company } : {}),
          ...(domain ? { domain } : {}), source: "workbook",
        };
        if (entry.slug || entry.name || entry.domain) addedRelationships.push(entry);
      }
      continue;
    }
    if (!slug) { skippedNoLink++; continue; }
    if (existingSlugs.has(slug)) continue;
    const reason = reasonByCompanyId.get(company.companyId);
    const category = reason ? EXCLUSION_REASON_TO_CATEGORY[reason] : null;
    if (!category) { skippedUnrecognizedReason++; continue; }
    added.push({ slug, category });
    existingSlugs.add(slug);
  }

  if (added.length) await saveCompanyExclusions([...exclusions, ...added]);
  if (addedRelationships.length) await saveCompanyRelationships([...relationships, ...addedRelationships]);
  // Customer / partner entries an older import put on the exclusion list move as well (design 4.1).
  await migrateCompanyRelationshipsIfNeeded({ trigger: "import" }).catch(() => null);
  return {
    addedCount: added.length, addedRelationshipCount: addedRelationships.length,
    skippedNoLink, skippedUnrecognizedReason, totalExcluded: excludedCompanies.length,
  };
}

// Organization-type eligibility (PRD 6.20, redesigned 2026-09-15 from an
// earlier same-day binary excludedIndustries version, replaced before it
// ever shipped a live run - a real ChatGPT-side audit of 17 companies Phase
// 5 found but the user's existing workbook didn't have made the binary
// version's limits concrete: MSF Switzerland and WWF Switzerland could be
// completely legitimate buyers depending on size/budget, while a 40-person
// volunteer group should be excluded for being too small, not for being an
// NGO - a plain "excluded industries" list can't express that distinction.
// Three states per confirmed non-standard-org-type industry display-name
// (see industry-id-map.js's EXCLUDABLE_INDUSTRIES for the confirmed set and
// why matching is text-based, not id-based - there's no per-card numeric
// industry id without an extra page visit): "yes" (treat as a fully normal
// candidate - the default for anything not explicitly set, never an
// opinionated built-in exclusion, per the user's own direction that a
// government/nonprofit-flavored name isn't automatically disqualifying),
// "no" (exclude wholesale, same mechanism the binary version had), or
// "review" (keep the company, but flag it for the user's own manual review
// - e.g. company-discovery-extraction.js tags the record rather than either
// silently treating it as a normal match or silently dropping it).
//
// This is the scaffolding for a fuller Organization Type taxonomy (for-
// profit corporation, state-owned enterprise, nonprofit foundation vs.
// association, industry association, university, program/initiative, etc.)
// the same ChatGPT audit proposed - only entries with a confirmed LinkedIn
// industryCompanyVertical id can actually be enforced (6 so far - see
// industry-id-map.js's EXCLUDABLE_INDUSTRIES for the current set), so the
// taxonomy grows the same incremental, live-confirmed-only way every other
// id table in this codebase does, not all at once.
const ORGANIZATION_TYPE_ELIGIBILITY_KEY = "organizationTypeEligibility";

export async function getOrganizationTypeEligibility() {
  const data = await chrome.storage.local.get(ORGANIZATION_TYPE_ELIGIBILITY_KEY);
  return data[ORGANIZATION_TYPE_ELIGIBILITY_KEY] || {};
}

export async function saveOrganizationTypeEligibility(eligibility) {
  await chrome.storage.local.set({ [ORGANIZATION_TYPE_ELIGIBILITY_KEY]: eligibility });
}

// User-maintained company alias list (PRD 6.20, added 2026-09-15, wired in
// 2026-09-15 after initially being deprioritized then reinstated by the
// user the same day) - maps a LinkedIn company-page slug that ISN'T an
// independently relevant buying organization (a brand, program, or
// local-market name run by a real company - e.g. "Audi Switzerland" is
// really AMAG; "ensa Switzerland" is a program run by Pro Mente Sana, both
// real cases the same ChatGPT audit surfaced) to the slug of the real,
// canonical company it should be treated as. Same manual, incrementally-
// grown, user-maintained pattern as competitorCompanySlugs/
// recruiterCompanySlugs - there's no reliable automatic way to detect "this
// LinkedIn page is really a brand/program of that one" without guessing, so
// this stays a deliberate, reviewable list the user builds up as they
// notice real cases, not an attempted algorithm. Deliberately just
// {aliasSlug, canonicalSlug} - no display-name fields - same reasoning as
// competitorCompanySlugs/recruiterCompanySlugs only ever storing the bare
// slug: a canonical company's real display name isn't known without an
// extra LinkedIn page visit, so nothing here invents one; wherever a
// canonical identity needs to be shown, the raw canonicalSlug is shown, not
// a guessed name. Entered in the onboarding wizard's Company aliases step as
// one `<alias URL> -> <canonical URL>` pair per line.
// Consumed by company-discovery-extraction.js to tag a discovered record
// with its canonical identity (canonicalSlug) rather than silently
// duplicate it as an independent account, and to skip a second card that
// resolves to the same canonical identity within one run - full merge-time
// de-duplication against an existing workbook is Phase 7's job once that's
// built, not this list's.
const COMPANY_ALIASES_KEY = "companyAliases";

export async function getCompanyAliases() {
  const data = await chrome.storage.local.get(COMPANY_ALIASES_KEY);
  return data[COMPANY_ALIASES_KEY] || [];
}

export async function saveCompanyAliases(aliases) {
  await chrome.storage.local.set({ [COMPANY_ALIASES_KEY]: aliases });
}

// Given a discovered card's own slug, returns the matching alias entry
// ({aliasSlug, canonicalSlug}) or null if this slug isn't a known alias of
// anything.
export function findCompanyAlias(slug, aliases) {
  return (aliases || []).find((a) => a.aliasSlug === slug) || null;
}

// Which languages to consider when building search keyword terms (e.g. a
// country's own local-language name - see company-discovery-extraction.js's
// buildSearchUrl) - added 2026-09-15. Plain language names, not a LinkedIn
// facet id - no live-confirmation discipline needed here the way
// geo-urn-map.js/industry-id-map.js need for LinkedIn's own internal ids,
// since these are just real language names. English is always implied
// (it's the base country name every entry in geo-urn-map.js is already
// keyed by) even if not explicitly selected, so the confirmed set below
// only needs to grow with additional languages, not re-add English.
const KEYWORD_SEARCH_LANGUAGES_KEY = "keywordSearchLanguages";
// --------------------------------------------------------------------------
// Keyword languages, onboarding state, LinkedIn slug parsing
// --------------------------------------------------------------------------

export const CONFIRMED_KEYWORD_LANGUAGES = ["German", "French"];

export async function getKeywordSearchLanguages() {
  const data = await chrome.storage.local.get(KEYWORD_SEARCH_LANGUAGES_KEY);
  return data[KEYWORD_SEARCH_LANGUAGES_KEY] || [];
}

export async function saveKeywordSearchLanguages(languages) {
  await chrome.storage.local.set({ [KEYWORD_SEARCH_LANGUAGES_KEY]: languages });
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

// Permanent per-company location/size cache (PRD 6.20 Phase 5, decided
// 2026-09-14) - the point that makes the free-tier/fallback-tier location
// design practical. Keyed by LinkedIn company ID (the same id 6.16's
// resolver already writes to each Target Account as linkedinCompanyId, and
// Phase 5's own card-scraping captures too). Country is cached forever, no
// revisit - a company's registered country doesn't change. sizeBucket isn't
// populated by Phase 5 yet (Priority 1 doesn't need it, per the same
// 2026-09-14 decision that size needs no separate check for this tier), but
// the field exists now so a future Priority 2 pass, or 6.16's own resolver,
// can populate it without a schema change.
const COMPANY_LOCATION_SIZE_CACHE_KEY = "companyLocationSizeCache";

// --------------------------------------------------------------------------
// Caches - company location/size, discovered companies & contacts
// --------------------------------------------------------------------------

export async function getCompanyLocationSizeCache() {
  const data = await chrome.storage.local.get(COMPANY_LOCATION_SIZE_CACHE_KEY);
  return data[COMPANY_LOCATION_SIZE_CACHE_KEY] || {};
}

export async function getCachedCompanyLocation(linkedinCompanyId) {
  const cache = await getCompanyLocationSizeCache();
  return cache[linkedinCompanyId] || null;
}

export async function cacheCompanyLocation(linkedinCompanyId, { country, sizeBucket, resolvedVia }) {
  const cache = await getCompanyLocationSizeCache();
  cache[linkedinCompanyId] = {
    country: country ?? cache[linkedinCompanyId]?.country ?? null,
    sizeBucket: sizeBucket ?? cache[linkedinCompanyId]?.sizeBucket ?? null,
    resolvedVia,
    resolvedAt: Date.now(),
  };
  await chrome.storage.local.set({ [COMPANY_LOCATION_SIZE_CACHE_KEY]: cache });
}

// Debug-panel escape hatch (PRD 6.20 Phase 5 testing) - a stale entry
// written before a resolution bug was fixed would otherwise keep
// short-circuiting to the old wrong value forever, since this cache is
// designed to never expire on its own (country is cached "forever, no
// revisit" by design - see the plan's own reasoning). Not exposed as a
// normal-use feature; nothing in this codebase clears this cache during
// ordinary operation.
export async function clearCompanyLocationSizeCache() {
  await chrome.storage.local.remove(COMPANY_LOCATION_SIZE_CACHE_KEY);
}

// Staging area for a company-discovery run's results (Phase 5) - kept apart
// from targetAccountsWorkbook while a run is live, so a discarded/redone
// run never touches committed data. Phase 7 (not yet built) merges a
// finished run's contents into targetAccountsWorkbook itself, tagged
// source: "discovered".
const DISCOVERED_COMPANIES_KEY = "discoveredCompanies";

export async function getDiscoveredCompanies() {
  const data = await chrome.storage.local.get(DISCOVERED_COMPANIES_KEY);
  return data[DISCOVERED_COMPANIES_KEY] || [];
}

export async function appendDiscoveredCompanies(newCompanies) {
  const existing = await getDiscoveredCompanies();
  const existingIds = new Set(existing.map((c) => c.linkedinCompanyId));
  const toAdd = newCompanies.filter((c) => !existingIds.has(c.linkedinCompanyId));
  const merged = [...existing, ...toAdd];
  await chrome.storage.local.set({ [DISCOVERED_COMPANIES_KEY]: merged });
  return merged;
}

export async function clearDiscoveredCompanies() {
  await chrome.storage.local.remove(DISCOVERED_COMPANIES_KEY);
}

// Staging area for a contact-discovery run's results (Phase 6) - same
// pattern as discoveredCompanies above (kept apart from targetAccountsWorkbook
// while a run is live; Phase 7 merges a finished run's contents in,
// tagged source: "discovered"). Deduped by profile slug, not a numeric id -
// contact-discovery-content-script.js never has a reason to look up a
// numeric LinkedIn id for a person the way it does for a company.
const DISCOVERED_CONTACTS_KEY = "discoveredContacts";

export async function getDiscoveredContacts() {
  const data = await chrome.storage.local.get(DISCOVERED_CONTACTS_KEY);
  return data[DISCOVERED_CONTACTS_KEY] || [];
}

export async function appendDiscoveredContacts(newContacts) {
  const existing = await getDiscoveredContacts();
  const existingSlugs = new Set(existing.map((c) => c.slug));
  const toAdd = newContacts.filter((c) => !existingSlugs.has(c.slug));
  const merged = [...existing, ...toAdd];
  await chrome.storage.local.set({ [DISCOVERED_CONTACTS_KEY]: merged });
  return merged;
}

export async function clearDiscoveredContacts() {
  await chrome.storage.local.remove(DISCOVERED_CONTACTS_KEY);
}

// Describes the desired Sales Mentor character (background, style) - seeded
// with a sensible default so the field shows something useful/editable right
// away rather than starting blank.
const MENTOR_PERSONA_KEY = "mentorPersona";
const DEFAULT_MENTOR_PERSONA =
  "A senior B2B sales expert with 25 years of experience, approachable and available any time - there's no " +
  "such thing as a stupid question. Deep expertise in LinkedIn-based lead generation, social selling, and " +
  "B2B sales strategy.";

// --------------------------------------------------------------------------
// Personas, user profile, output language
// --------------------------------------------------------------------------

export async function getMentorPersona() {
  const data = await chrome.storage.local.get(MENTOR_PERSONA_KEY);
  return data[MENTOR_PERSONA_KEY] || DEFAULT_MENTOR_PERSONA;
}

export async function saveMentorPersona(persona) {
  await chrome.storage.local.set({ [MENTOR_PERSONA_KEY]: persona });
}

// The salesperson's own name/title/email (Settings' new User Profile
// section, 2026-09-18, user's own request) - not an account/login system,
// just enough for drafted messages to sign off as a real person instead of
// nobody. name/title threaded into buildDraftPrompt (agent-shared.js) and
// the Account/Contact Mentor prompts (the only two prompts that ever write
// a draft directly in their own reply rather than through the
// draft_message tool - see userProfileBlock there). email isn't used
// anywhere yet - added ahead of a future notification feature (the user's
// own words: "let the user know about something, per their preferences"),
// stored now so that feature doesn't need its own separate settings UI
// later.
const USER_PROFILE_KEY = "userProfile";

export async function getUserProfile() {
  const data = await chrome.storage.local.get(USER_PROFILE_KEY);
  return { name: "", title: "", email: "", ...(data[USER_PROFILE_KEY] || {}) };
}

export async function saveUserProfile(profile) {
  await chrome.storage.local.set({ [USER_PROFILE_KEY]: profile });
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

// --------------------------------------------------------------------------
// Account write lock (1.2.1 build step 0, ONBOARDING_RESEARCH_DESIGN.md 2.2)
// --------------------------------------------------------------------------

// Every read-modify-write of targetAccounts, targetAccountsWorkbook and targetAccountExtras reads the WHOLE
// map, changes a few entries and writes the whole map back - so two writers that overlap (four bulk-research
// workers finishing together, the pipeline and a manual edit on the account page) could each read the old map,
// and the second write silently dropped the first one's change. Every such writer now runs inside this lock.
// It is a Web Lock rather than an in-memory promise chain because Web Locks are shared by every context of the
// extension's origin - the background worker AND each open SalesTeam page - so a page-side edit queues behind a
// background write instead of racing it, with no message round-trip. A lock whose holder is closed or reloaded
// mid-write is released by the browser.
// NOT re-entrant: a writer already inside the lock must call another writer's `...Unlocked` version, or it waits
// for itself forever. Each locked writer is a one-line wrapper passing its `arguments` to `<name>Unlocked`, so
// the unlocked body and its signature stay exactly as they were.
const ACCOUNT_WRITE_LOCK = "salesteam-account-writes";
let accountWriteChain = Promise.resolve(); // fallback only, for a context without navigator.locks

export function withAccountWriteLock(fn) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request(ACCOUNT_WRITE_LOCK, () => fn());
  const run = accountWriteChain.then(() => fn());
  accountWriteChain = run.catch(() => {});
  return run;
}

// --------------------------------------------------------------------------
// Target Accounts - import, metadata, scan scope, score threshold
// --------------------------------------------------------------------------

export async function importTargetAccounts(list, fileName = null) { return withAccountWriteLock(() => importTargetAccountsUnlocked(...arguments)); }
async function importTargetAccountsUnlocked(list, fileName = null) {
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
  let companyCount = 0;
  for (const entry of list || []) {
    const key = normalizeCompanyName(entry.company);
    if (!key) continue;
    companyCount++;
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
      // 28th round of direct feedback (2026-09-19), see xlsx-lite.js's own
      // RELATIONAL_SHEETS comment for the full reasoning - kept on the
      // record for reference/display; the SECOND pass below is what
      // actually makes these usable for lookup.
      aliases: entry.aliases || [],
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
  // Second pass, after every company's own PRIMARY key is already
  // registered above - a known alias (legal name, former name, trading
  // name, search variant, etc., from the workbook's own Aliases sheet, see
  // xlsx-lite.js) becomes an ADDITIONAL lookup key pointing at the same
  // record, so a scanned lead's company text matches evaluateTargetAccountMatch
  // (and every other normalizeCompanyName(x)-keyed lookup against this map)
  // even when it only matches a company's alias, not its primary name - the
  // actual gap this round closes: "Zurich Financial Services" (a former
  // name) previously never matched "Zurich Insurance Group." Run as its own
  // pass, not inline above, so a company's own real primary name always
  // wins a collision regardless of list order; an alias never overwrites an
  // already-registered PRIMARY key (a company's real identity always takes
  // precedence over another company's alias), but may still overwrite an
  // earlier-registered alias of a different company - an accepted,
  // last-write-wins tradeoff for the rare case two companies share an
  // informal name, no worse than normalizeCompanyName's own existing
  // collision behavior for primary names.
  const primaryKeys = new Set(Object.keys(map));
  for (const entry of list || []) {
    const key = normalizeCompanyName(entry.company);
    if (!key || !map[key]) continue;
    for (const alias of entry.aliases || []) {
      const aliasKey = normalizeCompanyName(alias);
      if (!aliasKey || primaryKeys.has(aliasKey)) continue;
      map[aliasKey] = map[key];
    }
  }
  const importedAt = Date.now();
  await chrome.storage.local.set({
    [TARGET_ACCOUNTS_KEY]: map,
    [TARGET_ACCOUNTS_IMPORTED_AT_KEY]: importedAt,
    [TARGET_ACCOUNTS_IMPORTED_FILENAME_KEY]: fileName || null,
  });
  return { count: companyCount, importedAt };
}

export async function getTargetAccounts() {
  const data = await chrome.storage.local.get(TARGET_ACCOUNTS_KEY);
  return data[TARGET_ACCOUNTS_KEY] || {};
}

export async function getTargetAccountsMeta() {
  const data = await chrome.storage.local.get([TARGET_ACCOUNTS_KEY, TARGET_ACCOUNTS_IMPORTED_AT_KEY, TARGET_ACCOUNTS_IMPORTED_FILENAME_KEY]);
  const map = data[TARGET_ACCOUNTS_KEY] || {};
  // 28th round of direct feedback (2026-09-19), fixed same day after live
  // testing showed an inflated count: Object.keys(map).length now includes
  // every alias key alongside each company's own primary key (see
  // importTargetAccounts). The first fix attempt deduped by object identity
  // (new Set on the values) - doesn't work here, since this data just came
  // through a chrome.storage.local.get, which always deserializes into
  // fresh objects (never === to each other even for the same underlying
  // company). Deduped by each record's own `company` string instead (a
  // plain value, unaffected by serialization).
  return {
    count: new Set(Object.values(map).map((v) => normalizeCompanyName(v.company))).size,
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
// Every alternative name known for an account (1.2 step 4, option A): the workbook's own alternative-name
// columns plus the Alt. name(s) the user typed on the account (overrides.alternativeCompanyName, a list).
// The resolver searches LinkedIn with these when the main name finds nothing - how an account like
// "Swiss Air-Rescue Rega", whose page is simply "Rega", gets found without anyone typing a LinkedIn link.
// Names equal to the account's own name or official name are left out; duplicates are removed.
export function accountAlternativeNames(company, officialName, sources) {
  const skip = new Set([normalizeCompanyName(company), normalizeCompanyName(officialName)].filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const src of sources || []) {
    const list = Array.isArray(src) ? src : [src];
    for (const entry of list) {
      for (const part of String(entry || "").split(/[;\n]+/)) {
        const name = part.trim();
        const key = normalizeCompanyName(name);
        if (!name || !key || skip.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push(name);
      }
    }
  }
  return out;
}

export async function getTargetAccountsMissingLinkedinId() {
  const [map, extras] = await Promise.all([getTargetAccounts(), getTargetAccountExtras()]);
  // 28th round of direct feedback (2026-09-19): getTargetAccounts() now has
  // an extra key per known alias, all pointing at the SAME record object
  // (see importTargetAccounts) - without the key === normalizeCompanyName(v.company)
  // check below, an unresolved company with (say) 4 aliases would queue for
  // 5 separate live LinkedIn lookups instead of 1, wasting real touch
  // budget on the exact same company. Only a record's own PRIMARY key
  // equals its own normalized company name by construction; an alias key
  // (built from a different string) generally won't.
  // "Missing" means missing EITHER half of the pair (2026-09-22). An account can hold a resolved
  // linkedinCompanyId and still have no linkedinLink - the imported workbook simply never carried one
  // - and until this was widened nothing would ever revisit it, because the old test was
  // `!v.linkedinCompanyId` alone. Such an account is also invisible to Fetch Company Size, which
  // requires a link. A run over one of these costs the same single lookup and now stores both halves.
  return Object.entries(map)
    .filter(([key, v]) => key === normalizeCompanyName(v.company) && (!v.linkedinCompanyId || !v.linkedinLink))
    .map(([key, v]) => ({
      key,
      company: v.company,
      officialName: v.officialName || null,
      alternativeName: v.alternativeName || null,
      alternativeNames: accountAlternativeNames(v.company, v.officialName, [v.alternativeName, extras[key]?.overrides?.alternativeCompanyName]),
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
export async function markLinkedinResolveAttempted(keys) { return withAccountWriteLock(() => markLinkedinResolveAttemptedUnlocked(...arguments)); }
async function markLinkedinResolveAttemptedUnlocked(keys) {
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

// Which Target Account companies the scan's company phase searches (Scanner > Run): only those
// whose SalesTeam Priority is at or above the chosen level. "P2" = P1 and P2 (the default), "all" =
// every scannable company, P1-P5. Since 1.2 build step 1 a company with no Priority at all is not
// scanned under any scope (readiness.isScannable) - the automatic scoring after every import and
// merge gives every live company one, so this only ever skips a company nothing has scored yet.
// Read by BOTH background.js (the real scan) and scanner.js (the "Total: N
// searches" hint), so the hint and the scan can never disagree.
const SCAN_COMPANY_SCOPE_KEY = "scanCompanyPriorityScope";
export const SCAN_COMPANY_SCOPES = ["P1", "P2", "P3", "all"];

export async function getScanCompanyScope() {
  const data = await chrome.storage.local.get(SCAN_COMPANY_SCOPE_KEY);
  return SCAN_COMPANY_SCOPES.includes(data[SCAN_COMPANY_SCOPE_KEY]) ? data[SCAN_COMPANY_SCOPE_KEY] : "P2";
}

export async function saveScanCompanyScope(scope) {
  await chrome.storage.local.set({ [SCAN_COMPANY_SCOPE_KEY]: SCAN_COMPANY_SCOPES.includes(scope) ? scope : "P2" });
}

// Rebuilt on the one account join and readiness.isScannable (1.2 build step 1, design 3.4), so the
// scan selects exactly the accounts the Pipeline status pie calls Ready or Usable. Two old gaps close
// with it: scope "all" used to skip the deleted/excluded filter, and a Discovered company - whose id
// lives on its workbook row, not in the targetAccounts map - was never scanned at all.
export async function getScanTargetCompanyIds(scope) {
  const views = await getAccountViews({ persistDerived: false });
  return [...new Set(views.filter((v) => isScannable(v, scope)).map((v) => v.linkedinCompanyId))];
}

// Each resolution may carry checkedLink - the LinkedIn page the id was actually read from - and src
// ("linkedin" for the resolver, "discovery" for a Discovery card). Both go into the account's
// provenance in the same write: an id only counts as verified once it was read off the very page the
// account's link points to (1.2 build step 1; step 0 found 6 of 30 stored ids disagreeing with it).
export async function applyResolvedCompanyIds(resolutions) { return withAccountWriteLock(() => applyResolvedCompanyIdsUnlocked(...arguments)); }
async function applyResolvedCompanyIdsUnlocked(resolutions) {
  const [map, extras, workbookBefore] = await Promise.all([getTargetAccounts(), getTargetAccountExtras(), getTargetAccountsWorkbook()]);
  let updated = 0;
  let refused = 0;
  const at = Date.now();
  // W7 (build step 5): which live account holds which LinkedIn company id, and each account's own link.
  const rowByKey = new Map();
  const holders = new Map();   // id -> [{ key, company, link }]
  for (const row of workbookBefore.companies || []) {
    if (!row.company) continue;
    const k = normalizeCompanyName(row.company);
    if (!rowByKey.has(k)) rowByKey.set(k, row);
    if (extras[k]?.deletedAt) continue;
    const id = map[k]?.linkedinCompanyId || row.linkedinCompanyId;
    if (!id) continue;
    const link = extras[k]?.overrides?.linkedinLink || row.linkedinLink || map[k]?.linkedinLink || null;
    if (!holders.has(String(id))) holders.set(String(id), []);
    holders.get(String(id)).push({ key: k, company: row.company, link });
  }
  // Accounts with no entry in the map (Discovered rows keep their id on the workbook row) get the id
  // written onto that row instead, when the caller allows it (the 1.2 pipeline's re-check).
  const rowWrites = new Map();
  for (const r of resolutions) {
    if (!r.linkedinCompanyId) continue;
    // W7: a company found by NAME - the account had no LinkedIn link of its own to check the page
    // against - whose id another live account already holds is not written. Two accounts on one LinkedIn
    // company is exactly how a name search goes wrong (HT5 AG / PSI, Basilea / ADC before step 4). The
    // account waits in Decisions instead: the same company, or not. The caller can read `r.refused`.
    const ownLink = extras[r.key]?.overrides?.linkedinLink || rowByKey.get(r.key)?.linkedinLink || map[r.key]?.linkedinLink || null;
    const others = (holders.get(String(r.linkedinCompanyId)) || []).filter((h) => h.key !== r.key);
    if (!ownLink && others.length > 0 && !r.sharedIdConfirmed) {
      const other = others[0];
      r.refused = {
        pageId: String(r.linkedinCompanyId), pageUrl: r.companyPageUrl || r.checkedLink || null,
        otherKey: other.key, otherCompany: other.company, otherLink: other.link, day: localDayString(at),
      };
      const cur = extras[r.key] || emptyExtra();
      extras[r.key] = { ...cur, pipeline: { ...(cur.pipeline || {}), idTaken: r.refused } };
      refused++;
      continue;
    }
    const previousId = map[r.key]?.linkedinCompanyId || null;
    if (!map[r.key]) {
      if (!r.allowWorkbookRow) continue;
      rowWrites.set(r.key, r);
    } else {
      map[r.key].linkedinCompanyId = r.linkedinCompanyId;
    }
    // Fill a MISSING linkedinLink from the page the resolver actually landed on - never overwrite
    // one the workbook already carries (2026-09-22). 24 accounts imported with no link had resolved
    // ids all along and no way to get a link: the resolver read this url and threw it away, and
    // getTargetAccountsMissingLinkedinId() would never queue them again since they HAVE an id.
    // A missing link also made them permanently ineligible for Fetch Company Size, which requires one.
    if (map[r.key] && r.companyPageUrl && !map[r.key].linkedinLink) map[r.key].linkedinLink = r.companyPageUrl;
    const cur = extras[r.key] || emptyExtra();
    // A re-check that read a different id overwrites the old one (agreed 2026-09-25, design T4): the
    // page the account's own link points to is its identity. The old id stays on record here.
    const oldId = previousId || r.previousId || null;
    const replaced = oldId && String(oldId) !== String(r.linkedinCompanyId) ? { replaced: oldId } : {};
    extras[r.key] = {
      ...cur,
      provenance: {
        ...(cur.provenance || {}),
        linkedinCompanyId: { src: r.src || "linkedin", at, link: r.checkedLink || r.companyPageUrl || null, v: r.linkedinCompanyId, ...replaced },
      },
    };
    updated++;
  }
  if (rowWrites.size > 0) {
    const workbook = await getTargetAccountsWorkbook();
    const companies = (workbook.companies || []).map((c) => {
      const r = rowWrites.get(normalizeCompanyName(c.company));
      if (!r) return c;
      return { ...c, linkedinCompanyId: r.linkedinCompanyId, linkedinLink: c.linkedinLink || r.companyPageUrl || null };
    });
    await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...workbook, companies } });
  }
  if (updated > 0 || refused > 0) await chrome.storage.local.set({ [TARGET_ACCOUNTS_KEY]: map, [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
  // ...and again into the WORKBOOK, which is a genuinely separate store (see syncLinkedinLinksToWorkbook).
  await syncLinkedinLinksToWorkbookUnlocked(); // already holding the account write lock
  return updated;
}

// targetAccounts (the lightweight map, keyed by normalized name, where linkedinCompanyId lives) and
// targetAccountsWorkbook (companies[], what the Accounts table renders and what getCompaniesNeedingSize
// reads) are TWO SEPARATE storage keys holding the same companies. Writing a resolved linkedinLink into
// the map alone therefore changed nothing anybody could see - the table kept showing no link and Fetch
// Company Size kept skipping the account (2026-09-22, found only after two live runs resolved ids and
// the "no LinkedIn url" count stayed at 24).
//
// Copies every link the map has into the workbook row that lacks one. Never the reverse, and never an
// overwrite: the workbook's own imported link always wins. Cheap and idempotent, so it is safe to call
// on page load - which is what repairs accounts already resolved before this existed, with no further
// LinkedIn lookups.
export async function syncLinkedinLinksToWorkbook() { return withAccountWriteLock(() => syncLinkedinLinksToWorkbookUnlocked(...arguments)); }
async function syncLinkedinLinksToWorkbookUnlocked() {
  const [map, data] = await Promise.all([
    getTargetAccounts(),
    chrome.storage.local.get(TARGET_ACCOUNTS_WORKBOOK_KEY),
  ]);
  const wb = data[TARGET_ACCOUNTS_WORKBOOK_KEY];
  if (!wb || !Array.isArray(wb.companies)) return 0;
  // Keyed by the map's own primary key so an alias entry can't win over the real record.
  const linkByKey = new Map();
  for (const [key, v] of Object.entries(map)) {
    if (v && v.linkedinLink && key === normalizeCompanyName(v.company)) linkByKey.set(key, v.linkedinLink);
  }
  if (linkByKey.size === 0) return 0;
  let changed = 0;
  const companies = wb.companies.map((c) => {
    if (c.linkedinLink || !c.company) return c;
    const url = linkByKey.get(normalizeCompanyName(c.company));
    if (!url) return c;
    changed++;
    return { ...c, linkedinLink: url };
  });
  if (changed > 0) {
    await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...wb, companies } });
  }
  return changed;
}

export async function getTargetAccountScoreThreshold() {
  const data = await chrome.storage.local.get(TARGET_ACCOUNT_SCORE_THRESHOLD_KEY);
  const value = data[TARGET_ACCOUNT_SCORE_THRESHOLD_KEY];
  return typeof value === "number" ? value : DEFAULT_TARGET_ACCOUNT_SCORE_THRESHOLD;
}

export async function saveTargetAccountScoreThreshold(threshold) {
  await chrome.storage.local.set({ [TARGET_ACCOUNT_SCORE_THRESHOLD_KEY]: threshold });
}

// 1.2.0.46 (Boaz): the Job rules' "how sure must we be that this is a real Target Account" is a level the user picks
// (Very High / High / Medium / Low, default High) instead of a 0-100 number nobody could read. An account's level is
// the research workbook's own label when it has one, else SalesTeam's own Priority (P1 Very High, P2 High, P3 Medium,
// P4-P5 Low) - so accounts found on the web or LinkedIn count too, which the old workbook-score rule never let them.
export const CONFIDENCE_LEVELS = [
  { id: "very_high", label: "Very High", rank: 4 },
  { id: "high", label: "High", rank: 3 },
  { id: "medium", label: "Medium", rank: 2 },
  { id: "low", label: "Low", rank: 1 },
];
const JOB_RULES_MIN_CONFIDENCE_KEY = "jobRulesMinConfidence";
const DEFAULT_JOB_RULES_MIN_CONFIDENCE = "high";

export async function getJobRulesMinConfidence() {
  const data = await chrome.storage.local.get(JOB_RULES_MIN_CONFIDENCE_KEY);
  const value = data[JOB_RULES_MIN_CONFIDENCE_KEY];
  return CONFIDENCE_LEVELS.some((l) => l.id === value) ? value : DEFAULT_JOB_RULES_MIN_CONFIDENCE;
}

export async function saveJobRulesMinConfidence(level) {
  if (!CONFIDENCE_LEVELS.some((l) => l.id === level)) return;
  await chrome.storage.local.set({ [JOB_RULES_MIN_CONFIDENCE_KEY]: level });
}

// 4..1, 0 for a "Provisional" workbook label (not confirmed, never enough), null when nothing says.
export function accountConfidenceRank(workbookLabel, salesTeamPriority) {
  const label = String(workbookLabel || "").trim().toLowerCase();
  if (label) {
    if (label.includes("provisional")) return 0;
    if (label.startsWith("very high")) return 4;
    if (label.startsWith("high")) return 3;
    if (label.startsWith("medium")) return 2;
    if (label.startsWith("low")) return 1;
  }
  const p = Number(String(salesTeamPriority || "").replace(/^P/i, ""));
  if (p === 1) return 4;
  if (p === 2) return 3;
  if (p === 3) return 2;
  if (p === 4 || p === 5) return 1;
  return null;
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

// --------------------------------------------------------------------------
// Target Accounts workbook - merge, contact discovery, size, backup
// --------------------------------------------------------------------------

// A fresh Import Target Accounts is a wholesale replace of the ChatGPT-
// researched sheets - but Phase 7's merged Discovery rows (source:
// "Discovered", below) are a completely independent dataset that happens to
// live in the same workbook, not part of what's being re-imported. Carried
// forward across the replace so routinely refreshing the research workbook
// doesn't silently discard real, LinkedIn-sourced Discovery data. Safe from
// an ID collision by construction - discovered rows use the
// "D-"-prefixed companyId/contactId scheme (mergeDiscoveredIntoWorkbook
// below), which can never collide with a real workbook's own Company_ID/
// Contact_ID. Known, accepted limitation NOT solved here: unlike
// mergeDiscoveredIntoWorkbook's own identity-aware merge (by
// normalizeCompanyName, not companyId), this preserve step does not check
// whether the freshly-imported sheet happens to already include a company
// that was previously only known via Discovery - if so, both rows survive
// as separate entries until a future manual cleanup, rather than being
// silently collapsed into one. A rare case (the fresh ChatGPT research
// would have to specifically cover a company Discovery already found on
// its own), not treated as a bug.
export async function importTargetAccountsWorkbook(sheets) { return withAccountWriteLock(() => importTargetAccountsWorkbookUnlocked(...arguments)); }
async function importTargetAccountsWorkbookUnlocked(sheets) {
  const importedAt = Date.now();
  const existing = await getTargetAccountsWorkbook();
  // Rows that did not come from the research workbook (LinkedIn Discovery, HubSpot import) survive a workbook re-import.
  const preservedCompanies = (existing.companies || []).filter((c) => c.source === "Discovered" || c.source === "HubSpot");
  const preservedContacts = (existing.contacts || []).filter((c) => c.source === "Discovered" || c.source === "HubSpot");
  // Initiatives added by the web research survive too, re-attached by company name to the new workbook's company ids.
  const idByName = new Map((sheets.companies || []).map((c) => [normalizeCompanyName(c.company), c.companyId]));
  for (const c of preservedCompanies) idByName.set(normalizeCompanyName(c.company), c.companyId);
  const preservedInitiatives = (existing.aiInitiatives || [])
    .filter((i) => i.source === "Web research")
    .map((i) => ({ ...i, companyId: idByName.get(normalizeCompanyName(i.company)) || null }))
    .filter((i) => i.companyId);
  const normalized = {
    ...sheets,
    aiInitiatives: [...(sheets.aiInitiatives || []), ...preservedInitiatives],
    companies: [...(sheets.companies || []), ...preservedCompanies],
    contacts: [...normalizeContactRows(sheets.contacts || []), ...preservedContacts],
  };
  await chrome.storage.local.set({
    [TARGET_ACCOUNTS_WORKBOOK_KEY]: normalized,
    [TARGET_ACCOUNTS_WORKBOOK_IMPORTED_AT_KEY]: importedAt,
  });
  return { count: (sheets.companies || []).length, importedAt };
}

// source (added 2026-09-16, PRD 6.20 Phase 7): distinguishes a ChatGPT-
// researched row from one merged in by mergeDiscoveredIntoWorkbook below.
// Backfilled as a read-time default rather than a one-time migration write -
// every row imported before this shipped simply has no `source` field
// stored, and is treated as "Imported" here, forever, with nothing to
// migrate.
export async function getTargetAccountsWorkbook() {
  const data = await chrome.storage.local.get(TARGET_ACCOUNTS_WORKBOOK_KEY);
  const wb = data[TARGET_ACCOUNTS_WORKBOOK_KEY] || { companies: [], contacts: [], aiInitiatives: [], aiInvestment: [], sources: [] };
  return { ...wb, companies: (wb.companies || []).map((c) => (c.source ? c : { ...c, source: "Imported" })) };
}

// Phase 7 - merges Phases 5/6's staged discoveredCompanies/discoveredContacts
// into targetAccountsWorkbook itself, so the Explorer (target-accounts.js)
// shows one unified list instead of two disconnected ones the user has to
// mentally merge - decided directly once the near-term pilot user's own
// situation made "keep fully separate" the wrong default (see
// giggly-watching-feather.md's Phase 7 section for the full reasoning).
//
// A company's real identity throughout target-accounts.js is
// normalizeCompanyName(company.company) - NOT companyId, which only ever
// exists to join Contacts/Initiatives/Investment/Sources to their own
// company row (currentAccountCompanyRow, the row-click handler that opens
// an account, hasUnreviewedPost/lead-matching all key off the normalized
// NAME). A discovered card whose name resolves to an account ChatGPT (or an
// earlier merge) already knows about is attributed to that EXISTING row
// instead of creating a confusing second row for the same real company -
// only a genuinely new company gets a new "D-"-prefixed row. Discovered
// contacts follow whichever row their company actually resolved to, so
// contactKeyFor(company, fullName) - the real routing/chat-history/
// due-date identity for a contact, same re-import-durability reasoning as
// company - always lines up with the right account.
function discoveredCompanyRowId(linkedinCompanyId) {
  return `D-${linkedinCompanyId}`;
}

function discoveredContactRowId(slug) {
  return `D-${slug}`;
}

function buildDiscoveredCompanyRow(dc) {
  return {
    companyId: discoveredCompanyRowId(dc.linkedinCompanyId),
    // Kept as its own field, not just baked into companyId/linkedinLink -
    // lets a FUTURE merge match against this row by exact LinkedIn ID
    // instead of falling back to name matching, the same way this merge
    // itself prefers an ID match for a ChatGPT-imported row below.
    linkedinCompanyId: dc.linkedinCompanyId,
    company: dc.name,
    industry: dc.industryText || null,
    globalHqCountry: dc.country || null,
    linkedinLink: dc.slug ? `https://www.linkedin.com/company/${dc.slug}/` : null,
    // researchStatus is a free-text ChatGPT-workbook column, closest
    // existing fit for a short discovered-row status note - reusing it
    // (rather than adding a dedicated column just for this) surfaces the
    // organization-type review flag (company-discovery-extraction.js's
    // organizationTypeEligibility: "review" choice) without new UI.
    researchStatus: dc.organizationTypeReviewLabel
      ? `Discovered - review organization type: ${dc.organizationTypeReviewLabel}`
      : "Discovered",
    source: "Discovered",
  };
}

export function buildDiscoveredContactRow(dcontact, companyRow) {
  return {
    contactId: discoveredContactRowId(dcontact.slug),
    companyId: companyRow.companyId,
    // The resolved row's own canonical name, not necessarily dcontact's own
    // companyName - matters when the company resolved to an EXISTING row
    // (ChatGPT-imported or merged earlier), so contactKeyFor below lines up
    // with that row's own identity, not a possibly-differently-spelled
    // variant this particular discovered card happened to carry.
    company: companyRow.company,
    fullName: dcontact.name,
    // headlineText is the closest available signal to a real job title -
    // LinkedIn's own free-text headline, not a cleanly parsed title field,
    // same caveat as everywhere else this project reads a headline as a
    // stand-in for a title.
    jobTitle: dcontact.headlineText || null,
    aiRelevance: dcontact.tier === "exact" ? "Exact title match" : dcontact.tier === "keyword" ? "Keyword match" : null,
    // seniorityLevel/seniorityPriority (2026-09-17) - the highest-priority
    // selected seniority level this contact's headline demonstrated at this
    // company (classifyCandidateSeniority, contact-discovery-extraction.js),
    // or null when no seniority levels were configured or none matched.
    // seniorityPriority is the plain 1/2/3 (Low/Medium/High) the user
    // assigned that level in the Contacts step - read directly by the
    // Post-lead rule engine's "authorSeniorityAtLeast" condition below.
    seniorityLevel: dcontact.seniorityLevel || null,
    seniorityPriority: dcontact.seniorityPriority || null,
    lastVerified2: dcontact.slug ? `https://www.linkedin.com/in/${dcontact.slug}/` : null,
    // The day LinkedIn showed this person at this company - what readiness counts as the contact's
    // verified date (R3.6). Rows merged before 1.2 have none and fall back to the account's
    // contactDiscoveryAttemptedAt, else the import date (getAccountViews).
    lastVerified: new Date().toISOString().slice(0, 10),
    source: "Discovered",
  };
}

// Shared by the real merge and the side panel's own pending-count preview,
// so "how many would this add" and "what actually got added" can never
// silently disagree. Both returned lists are already fully-built rows
// (buildDiscoveredCompanyRow/buildDiscoveredContactRow already applied),
// not staging records - a preview call and the real merge do identical
// identity-resolution work, the merge just also persists the result.
//
// Company matching (reported directly, worried a NAME-only match "could be
// prone to errors" - a fair concern, since two different companies can
// share enough of a normalized name to collide, and normalizeCompanyName's
// own AG/Ltd/Switzerland-suffix stripping is deliberately lenient): now
// prefers an EXACT LinkedIn numeric company ID match first, falling back to
// the name match only when no ID is available on either side. A discovered
// company always carries its own real linkedinCompanyId
// (company-discovery-extraction.js). An EXISTING row can supply one two
// ways: a Discovered row from an earlier merge carries its own
// linkedinCompanyId directly (buildDiscoveredCompanyRow, above); a
// ChatGPT-imported row's is looked up from the separate targetAccounts map
// (6.11/6.16) by normalized name, since that's the only place "Resolve
// LinkedIn Company IDs" (an experimental, batch-run, opt-in feature) writes
// it - most rows won't have one resolved yet, so name matching remains the
// only signal available for those, not a fallback ever fully retired.
// 1.2 build step 4 (R12.6.3, V2): a discovered company that matches an existing account by NAME only is
// held back - not merged, no id written onto the existing row, its contacts kept waiting - until the user
// says in the decision queue whether it is the same company. Almost every account has a LinkedIn id now,
// so a name match that is not an id match usually means "same name, different LinkedIn company".
// Decisions are keyed by the discovered company's LinkedIn id: "same" or "different".
const DISCOVERY_NAME_DECISIONS_KEY = "discoveryNameDecisions";

export async function getDiscoveryNameDecisions() {
  const data = await chrome.storage.local.get(DISCOVERY_NAME_DECISIONS_KEY);
  return data[DISCOVERY_NAME_DECISIONS_KEY] || {};
}

export async function saveDiscoveryNameDecision(discoveredId, choice) {
  const decisions = await getDiscoveryNameDecisions();
  decisions[String(discoveredId)] = choice;
  await chrome.storage.local.set({ [DISCOVERY_NAME_DECISIONS_KEY]: decisions });
}

// "Different company": added as its own account under a name that cannot collide with the existing one -
// accounts are keyed by their normalized name, so two rows called "Sunrise" would share one record.
function distinctDiscoveredName(dc) {
  return `${dc.name} (LinkedIn: ${dc.slug || dc.linkedinCompanyId})`;
}

async function computeDiscoveredMergeDiff() {
  const [discoveredCompanies, discoveredContacts, workbook, targetAccountsMap, nameDecisions] = await Promise.all([
    getDiscoveredCompanies(),
    getDiscoveredContacts(),
    getTargetAccountsWorkbook(),
    getTargetAccounts(),
    getDiscoveryNameDecisions(),
  ]);

  const companyByName = new Map(workbook.companies.map((c) => [normalizeCompanyName(c.company), c]));
  const companyByLinkedinId = new Map();
  for (const c of workbook.companies) {
    const id = c.linkedinCompanyId || targetAccountsMap[normalizeCompanyName(c.company)]?.linkedinCompanyId;
    if (id) companyByLinkedinId.set(id, c);
  }
  const discoveredCompanyById = new Map(discoveredCompanies.map((dc) => [dc.linkedinCompanyId, dc]));

  const newCompanyRows = [];
  // { discovered, existing, matchedBy } per already-represented company -
  // not silently dropped, surfaced to the merge preview UI so a match can
  // actually be looked at (and, if it looks wrong, caught) before
  // committing, not just trusted blind.
  const matchedCompanies = [];
  // Name-only matches still waiting for the user's decision (V2), and where each discovered company's
  // contacts go: its own new row, the existing account, or nowhere yet.
  const heldNameMatches = [];
  const heldIds = new Set();
  const rowByDiscoveredId = new Map();
  for (const dc of discoveredCompanies) {
    const idMatch = dc.linkedinCompanyId ? companyByLinkedinId.get(dc.linkedinCompanyId) : null;
    if (idMatch) {
      matchedCompanies.push({ discovered: dc, existing: idMatch, matchedBy: "id" });
      rowByDiscoveredId.set(dc.linkedinCompanyId, idMatch);
      continue;
    }
    const nameKey = normalizeCompanyName(dc.name);
    const nameMatch = companyByName.get(nameKey);
    const decision = dc.linkedinCompanyId ? nameDecisions[String(dc.linkedinCompanyId)] : null;
    if (nameMatch && decision !== "different") {
      if (decision === "same") {
        matchedCompanies.push({ discovered: dc, existing: nameMatch, matchedBy: "name" });
        rowByDiscoveredId.set(dc.linkedinCompanyId, nameMatch);
      } else {
        heldNameMatches.push({ discovered: dc, existing: nameMatch });
        if (dc.linkedinCompanyId) heldIds.add(dc.linkedinCompanyId);
      }
      continue;
    }
    const row = nameMatch ? { ...buildDiscoveredCompanyRow(dc), company: distinctDiscoveredName(dc) } : buildDiscoveredCompanyRow(dc);
    if (dc.linkedinCompanyId) rowByDiscoveredId.set(dc.linkedinCompanyId, row);
    // So a later discovered dupe in this same batch also resolves here,
    // by either signal.
    companyByName.set(normalizeCompanyName(row.company), row);
    if (dc.linkedinCompanyId) companyByLinkedinId.set(dc.linkedinCompanyId, row);
    newCompanyRows.push(row);
  }

  const existingContactKeys = new Set(workbook.contacts.map((c) => contactKeyFor(c.company, c.fullName)));
  const newContactRows = [];
  // Two distinct "not added" reasons, tracked separately (2026-09-17, the
  // user's own request for a fuller breakdown) - a genuine duplicate
  // (duplicateContactsSkipped, the common case: this exact person at this
  // exact company is already on file) vs. an orphaned record
  // (orphanedContactsSkipped, should be rare: the contact's own company
  // was itself excluded/removed from discoveredCompanies since this
  // contact was staged, so there's nothing to attribute it to).
  let duplicateContactsSkipped = 0;
  let orphanedContactsSkipped = 0;
  let heldContacts = 0;
  for (const dcontact of discoveredContacts) {
    const dc = discoveredCompanyById.get(dcontact.companyKey);
    // Its company is a name match still waiting for the user: the contact waits with it.
    if (dc?.linkedinCompanyId && heldIds.has(dc.linkedinCompanyId)) { heldContacts++; continue; }
    let companyRow = dc?.linkedinCompanyId ? rowByDiscoveredId.get(dc.linkedinCompanyId) : null;
    if (!companyRow && dc) companyRow = companyByName.get(normalizeCompanyName(dc.name));
    if (!companyRow && dc?.linkedinCompanyId) companyRow = companyByLinkedinId.get(dc.linkedinCompanyId);
    if (!companyRow) { orphanedContactsSkipped++; continue; } // the company this contact belongs to was never itself discovered/known
    const row = buildDiscoveredContactRow(dcontact, companyRow);
    const key = contactKeyFor(row.company, row.fullName);
    if (!key) { orphanedContactsSkipped++; continue; }
    if (existingContactKeys.has(key)) { duplicateContactsSkipped++; continue; }
    existingContactKeys.add(key);
    newContactRows.push(row);
  }

  return {
    workbook, newCompanyRows, newContactRows, matchedCompanies, heldNameMatches, heldContacts,
    totalDiscoveredCompanies: discoveredCompanies.length,
    totalDiscoveredContacts: discoveredContacts.length,
    duplicateContactsSkipped,
    orphanedContactsSkipped,
  };
}

// Preview-only, no storage write - lets the UI show "X companies, Y
// contacts ready to merge" before the user commits (the "review" half of
// the plan's "review-and-confirm" design).
export async function getPendingDiscoveredMergeCounts() {
  const { newCompanyRows, newContactRows } = await computeDiscoveredMergeDiff();
  return { companiesPending: newCompanyRows.length, contactsPending: newContactRows.length };
}

// Reported directly: a bare count before merging doesn't let the user
// actually look at anything - "I do not understand the benefit of asking
// the user to confirm something that they know nothing about." Real names
// (plus a LinkedIn link, so a spot-check is one click away) so the merge
// dialog can show what's actually about to be added, not just how many -
// and, per the follow-up concern about name-matching being error-prone,
// also lists which discovered companies matched an EXISTING row (and how -
// "id" or "name") instead of leaving that silent.
export async function getPendingDiscoveredMergePreview() {
  const { newCompanyRows, newContactRows, matchedCompanies, heldNameMatches } = await computeDiscoveredMergeDiff();
  return {
    nameMatchesWaiting: heldNameMatches.length,
    companies: newCompanyRows.map((c) => ({ name: c.company, country: c.globalHqCountry, linkedinLink: c.linkedinLink })),
    contacts: newContactRows.map((c) => ({ name: c.fullName, company: c.company })),
    matchedCompanies: matchedCompanies.map((m) => ({
      discoveredName: m.discovered.name,
      existingName: m.existing.company,
      matchedBy: m.matchedBy,
      linkedinLink: m.discovered.slug ? `https://www.linkedin.com/company/${m.discovered.slug}/` : null,
    })),
  };
}

export async function mergeDiscoveredIntoWorkbook() { return withAccountWriteLock(() => mergeDiscoveredIntoWorkbookUnlocked(...arguments)); }
async function mergeDiscoveredIntoWorkbookUnlocked() {
  const {
    workbook, newCompanyRows, newContactRows, matchedCompanies, heldNameMatches, heldContacts,
    totalDiscoveredCompanies, totalDiscoveredContacts, duplicateContactsSkipped, orphanedContactsSkipped,
  } = await computeDiscoveredMergeDiff();
  const targetAccountsMap = await getTargetAccounts();

  // Free LinkedIn ID backfill (2026-09-16, per the user's own proposal): a
  // company matched by NAME (not already by ID) just proved, via this exact
  // Discovery card, what its real LinkedIn company ID is - company-
  // discovery-extraction.js already scraped it, so writing it back onto the
  // existing ChatGPT-imported row (targetAccounts map, the same one
  // "Resolve LinkedIn Company IDs" itself writes to) costs no extra
  // LinkedIn visit at all. The NEXT merge, or the Resolve queue's own "still
  // missing an ID" list, sees this company as an exact ID match from here
  // on, not a name-matched one - each real Discovery run incrementally
  // resolves more of the 500 for free, exactly the "resolve as we go"
  // policy the user asked for, no separate touch-costing action needed for
  // this specific case. A matchedBy: "id" company already had one; only
  // "name" matches are missing one to backfill.
  // Since 1.2 step 4 a "name" match here is one the user confirmed as the same company in the decision
  // queue; the id is written only when the account has none - one it already has is left for the
  // pipeline's re-check against the account's own page to settle.
  const idBackfills = matchedCompanies
    .filter((m) => m.matchedBy === "name" && m.discovered.linkedinCompanyId)
    .filter((m) => !(m.existing.linkedinCompanyId || targetAccountsMap[normalizeCompanyName(m.existing.company)]?.linkedinCompanyId))
    .map((m) => ({
      key: normalizeCompanyName(m.existing.company),
      linkedinCompanyId: m.discovered.linkedinCompanyId,
      src: "discovery",
      checkedLink: m.discovered.slug ? `https://www.linkedin.com/company/${m.discovered.slug}/` : null,
    }));
  const idsBackfilled = idBackfills.length > 0 ? await applyResolvedCompanyIdsUnlocked(idBackfills) : 0; // already holding the lock

  // How many distinct companies the new contacts actually landed on -
  // reported directly, 2026-09-17: "55 contacts added" alone doesn't say
  // whether that's spread across many companies or piled onto a few, which
  // the user wanted visible in the merge status text.
  const companiesReceivingContacts = new Set(newContactRows.map((r) => r.companyId)).size;

  const baseResult = {
    totalDiscoveredCompanies, companiesMatched: matchedCompanies.length, idsBackfilled,
    nameMatchesWaiting: heldNameMatches.length, contactsWaiting: heldContacts,
    totalDiscoveredContacts, duplicateContactsSkipped, orphanedContactsSkipped,
  };

  if (newCompanyRows.length === 0 && newContactRows.length === 0) {
    return { ...baseResult, companiesAdded: 0, contactsAdded: 0, companiesReceivingContacts: 0 };
  }
  const merged = {
    ...workbook,
    companies: [...workbook.companies, ...newCompanyRows],
    contacts: [...workbook.contacts, ...newContactRows],
  };
  await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: merged });
  return {
    ...baseResult,
    companiesAdded: newCompanyRows.length, contactsAdded: newContactRows.length, companiesReceivingContacts,
  };
}

// Contact Discovery for Existing Companies (PRD 6.20, 2026-09-17, the
// user's own request): Phase 6 only ever finds contacts for companies
// Phase 5 *just* discovered in the same run - reported directly as a real
// gap once the user pointed out most of a real 528-company ChatGPT-
// imported workbook only has 1-2 contacts each. This is a separate,
// independent action (own candidate list, own resume-tracking, no
// discoveryQueueState coupling at all) - modeled on the existing "Resolve
// LinkedIn Company IDs" feature (6.16), the closest analog: iterates
// existing workbook rows, one LinkedIn visit each, writes results directly
// (no separate review/merge step - see below for why), same
// never-attempted-first resume ordering via a per-company "attempted at"
// timestamp instead of a persisted cursor.
//
// Real design fork resolved directly with the user: a newly-found
// contact's own company is already known with certainty here (unlike
// Phase 5/6, where computeDiscoveredMergeDiff has to resolve identity
// against possibly-ambiguous name/ID matches) - so there's no dedup
// ambiguity to review before committing. Confirmed with the user: write
// directly to the workbook, same as "Resolve LinkedIn Company IDs" already
// does, rather than routing through discoveredContacts + the Review & Merge
// dialog (which, as built, can only resolve a contact via a matching entry
// in discoveredCompanies - a company that was never itself discovered has
// no such entry, so contacts for it would silently be dropped by that path
// without further changes there). A wrong result can still be undone via
// the existing "Remove Contact…" soft-delete.
export async function getExistingCompaniesNeedingContacts(maxExistingContacts = 2) {
  const [workbook, extras, exclusions] = await Promise.all([
    getTargetAccountsWorkbook(), getTargetAccountExtras(), getCompanyExclusions(),
  ]);
  const exclusionMatcher = await getExclusionMatcher();
  const contactCountByCompanyId = new Map();
  for (const contact of workbook.contacts || []) {
    if (!contact.companyId) continue;
    contactCountByCompanyId.set(contact.companyId, (contactCountByCompanyId.get(contact.companyId) || 0) + 1);
  }
  return (workbook.companies || [])
    .filter((c) => c.company && c.companyId)
    .filter((c) => !extras[normalizeCompanyName(c.company)]?.deletedAt)
    .filter((c) => !isCompanyRowExcluded(c, exclusionMatcher))
    .map((c) => {
      const key = normalizeCompanyName(c.company);
      return {
        key,
        company: c.company,
        companyId: c.companyId,
        slug: parseLinkedinCompanySlug(c.linkedinLink || ""),
        contactCount: contactCountByCompanyId.get(c.companyId) || 0,
        attemptedAt: extras[key]?.contactDiscoveryAttemptedAt || null,
      };
    })
    .filter((c) => c.slug && c.contactCount < maxExistingContacts)
    .sort((a, b) => (a.attemptedAt || 0) - (b.attemptedAt || 0));
}

// Called after a run with every company key actually attempted (regardless
// of outcome), same "never-tried sorts first" reasoning as
// markLinkedinResolveAttempted above - otherwise a handful of genuinely
// contact-less companies would keep consuming the whole budget of every
// run, ahead of a company this feature hasn't tried yet.
export async function markContactDiscoveryAttempted(keys) { return withAccountWriteLock(() => markContactDiscoveryAttemptedUnlocked(...arguments)); }
async function markContactDiscoveryAttemptedUnlocked(keys) {
  const extras = await getTargetAccountExtras();
  const attemptedAt = Date.now();
  let marked = 0;
  for (const key of keys || []) {
    extras[key] = { ...emptyExtra(), ...(extras[key] || {}), contactDiscoveryAttemptedAt: attemptedAt };
    marked++;
  }
  if (marked > 0) await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
  return marked;
}

// Direct write for the existing-companies path above - dedups against
// already-present contacts the same way computeDiscoveredMergeDiff does
// (contactKeyFor identity), so re-running this after a partial/stopped run
// never double-adds the same person.
export async function appendContactsToWorkbook(newContactRows) { return withAccountWriteLock(() => appendContactsToWorkbookUnlocked(...arguments)); }
async function appendContactsToWorkbookUnlocked(newContactRows) {
  if (!newContactRows || newContactRows.length === 0) return 0;
  const workbook = await getTargetAccountsWorkbook();
  const existingContactKeys = new Set((workbook.contacts || []).map((c) => contactKeyFor(c.company, c.fullName)));
  const toAdd = [];
  for (const row of newContactRows) {
    const key = contactKeyFor(row.company, row.fullName);
    if (!key || existingContactKeys.has(key)) continue;
    existingContactKeys.add(key);
    toAdd.push(row);
  }
  if (toAdd.length === 0) return 0;
  const merged = { ...workbook, contacts: [...(workbook.contacts || []), ...toAdd] };
  await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: merged });
  return toAdd.length;
}

// "Fetch Company Size" (2026-09-17, PRD 6.20 Phase 8) - a Discovered-only
// company never carries a real employee count (LinkedIn's company-search
// result cards never show it - only a company's own page does, confirmed
// live, see company-size-content-script.js's own header comment), so
// Phase 8's deterministic size nudge could never fire for one no matter how
// Size priorities were configured. Per the user's own explicit request
// ("we must be able to have this for every discovered company"), this reads
// every company (imported OR Discovered, whichever is missing a real
// number) via a real LinkedIn visit. Same never-attempted-first ordering
// and soft-delete/exclusion filtering as getExistingCompaniesNeedingContacts
// above.
export async function getCompaniesNeedingSize() {
  const [workbook, extras, exclusions] = await Promise.all([
    getTargetAccountsWorkbook(), getTargetAccountExtras(), getCompanyExclusions(),
  ]);
  const exclusionMatcher = await getExclusionMatcher();
  return (workbook.companies || [])
    .filter((c) => c.company && c.companyId && c.linkedinLink)
    // The count must be read THROUGH the account's own overrides, not off the workbook row alone.
    // A web research (bulk-research.js autofills every empty field it finds) and a manual edit both
    // write to extras[key].overrides, never back onto the row - so a company whose employee count
    // arrived that way still looked "missing" here and was queued for a LinkedIn visit that had
    // nothing to learn. The Accounts table already reads through overrides (rawValue), so the banner
    // and the table used to disagree about the very same company.
    .filter((c) => {
      const ov = extras[normalizeCompanyName(c.company)]?.overrides || {};
      const global = ov.globalEmployees ?? c.globalEmployees;
      const local = ov.swissEmployees ?? c.swissEmployees;
      // parseLooseNumber, not typeof === "number" (1.2 build step 1, design 2.5.1): EPFL's count is the
      // string "6,500+" and used to queue a LinkedIn visit it did not need, on every run.
      return parseLooseNumber(global) === null && parseLooseNumber(local) === null;
    })
    .filter((c) => !extras[normalizeCompanyName(c.company)]?.deletedAt)
    .filter((c) => !isCompanyRowExcluded(c, exclusionMatcher))
    .map((c) => {
      const key = normalizeCompanyName(c.company);
      return {
        key,
        company: c.company,
        companyId: c.companyId,
        linkedinLink: c.linkedinLink,
        attemptedAt: extras[key]?.sizeFetchAttemptedAt || null,
      };
    })
    .sort((a, b) => (a.attemptedAt || 0) - (b.attemptedAt || 0));
}

// Called after a run with every company key actually attempted (regardless
// of outcome) - same reasoning as markContactDiscoveryAttempted above, so a
// handful of companies whose page never yields a readable size don't keep
// consuming the whole budget of every future run ahead of ones never tried.
export async function markCompanySizeFetchAttempted(keys) { return withAccountWriteLock(() => markCompanySizeFetchAttemptedUnlocked(...arguments)); }
async function markCompanySizeFetchAttemptedUnlocked(keys) {
  const extras = await getTargetAccountExtras();
  const attemptedAt = Date.now();
  let marked = 0;
  for (const key of keys || []) {
    extras[key] = { ...emptyExtra(), ...(extras[key] || {}), sizeFetchAttemptedAt: attemptedAt };
    marked++;
  }
  if (marked > 0) await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
  return marked;
}

// Read-mutate-write onto targetAccountsWorkbook.companies, same pattern as
// appendContactsToWorkbook/markContactDiscoveryAttempted above. Writes
// straight onto globalEmployees - the SAME field an imported row already
// uses - so Phase 8's own computeCompanyDeterministicPreScore buckets a
// Discovered company's size with zero special-casing, indistinguishable
// from an imported one once stored. employeeCountText (the raw LinkedIn
// band, e.g. "501-1K employees") is kept alongside purely for display -
// never read by the deterministic scorer, which only ever wants the number.
export async function applyCompanySizeResults(results) { return withAccountWriteLock(() => applyCompanySizeResultsUnlocked(...arguments)); }
async function applyCompanySizeResultsUnlocked(results) {
  if (!results || results.length === 0) return 0;
  const [workbook, extras] = await Promise.all([getTargetAccountsWorkbook(), getTargetAccountExtras()]);
  const byId = new Map(results.map((r) => [r.companyId, r]));
  let applied = 0;
  const at = Date.now();
  const companies = (workbook.companies || []).map((c) => {
    const r = byId.get(c.companyId);
    if (!r) return c;
    applied++;
    // Provenance in the same write as the value (1.2 build step 1, design 4.2).
    const key = normalizeCompanyName(c.company);
    const cur = extras[key] || emptyExtra();
    extras[key] = { ...cur, provenance: { ...(cur.provenance || {}), globalEmployees: { src: "linkedin", at, v: r.employeeCount } } };
    return { ...c, globalEmployees: r.employeeCount, employeeCountText: r.sizeBandText ? `${r.sizeBandText} employees` : null };
  });
  await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...workbook, companies }, [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
  return applied;
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
  const [targetAccounts, targetAccountsMeta, targetAccountsWorkbook, workbookMeta, targetAccountScoreThreshold, staged, extras] =
    await Promise.all([
      getTargetAccounts(),
      getTargetAccountsMeta(),
      getTargetAccountsWorkbook(),
      getTargetAccountsWorkbookMeta(),
      getTargetAccountScoreThreshold(),
      chrome.storage.local.get([DISCOVERED_COMPANIES_KEY, DISCOVERED_CONTACTS_KEY]),
      chrome.storage.local.get([TARGET_ACCOUNT_EXTRAS_KEY, TARGET_CONTACT_EXTRAS_KEY]),
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
    // Discovery results still waiting for "Review & Merge" (already-merged ones are ordinary rows of
    // targetAccountsWorkbook above, marked source "Discovered").
    discoveredCompanies: staged[DISCOVERED_COMPANIES_KEY] || [],
    discoveredContacts: staged[DISCOVERED_CONTACTS_KEY] || [],
    // The user's own edits per account/contact: manual overrides and priorities, follow-up dates,
    // removals, and Sales Mentor / Customer Voice chats. Keyed by normalized company name / contact key.
    targetAccountExtras: extras[TARGET_ACCOUNT_EXTRAS_KEY] || {},
    targetContactExtras: extras[TARGET_CONTACT_EXTRAS_KEY] || {},
  };
}

// Which parts of a Target Accounts backup exist in `data` (restore dialog offers exactly these):
// accounts (the imported workbook + lookup map), edits (your overrides/follow-ups/chats),
// staged (discovery results waiting for Review & Merge).
export function availableTargetAccountsSections(data) {
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const ids = [];
  if (data.targetAccounts || data.targetAccountsWorkbook) ids.push("accounts");
  if (isObj(data.targetAccountExtras) || isObj(data.targetContactExtras)) ids.push("edits");
  if (Array.isArray(data.discoveredCompanies) || Array.isArray(data.discoveredContacts)) ids.push("staged");
  return ids;
}

// `sections` = a Set of the ids above; omitted/null restores everything the file carries. The
// returned counts describe what was actually restored (null when "accounts" was not selected).
export async function importTargetAccountsBackup(data, sections = null) { return withAccountWriteLock(() => importTargetAccountsBackupUnlocked(...arguments)); }
async function importTargetAccountsBackupUnlocked(data, sections = null) {
  const has = (id) => !sections || sections.has(id);
  const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

  if (has("accounts")) {
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
  }
  // Your own edits per account/contact - only when the backup carries them (an older backup has none).
  if (has("edits") && (isPlainObject(data.targetAccountExtras) || isPlainObject(data.targetContactExtras))) {
    await chrome.storage.local.set({
      ...(isPlainObject(data.targetAccountExtras) ? { [TARGET_ACCOUNT_EXTRAS_KEY]: data.targetAccountExtras } : {}),
      ...(isPlainObject(data.targetContactExtras) ? { [TARGET_CONTACT_EXTRAS_KEY]: data.targetContactExtras } : {}),
    });
  }
  // Discovery results not yet merged - never wipes staged discoveries that exist locally just because the
  // file predates this field.
  if (has("staged") && (Array.isArray(data.discoveredCompanies) || Array.isArray(data.discoveredContacts))) {
    await chrome.storage.local.set({
      ...(Array.isArray(data.discoveredCompanies) ? { [DISCOVERED_COMPANIES_KEY]: data.discoveredCompanies } : {}),
      ...(Array.isArray(data.discoveredContacts) ? { [DISCOVERED_CONTACTS_KEY]: data.discoveredContacts } : {}),
    });
  }
  return {
    // 28th round of direct feedback (2026-09-19), fixed same day - see getTargetAccountsMeta's own comment
    // for why this dedupes by the record's `company` string rather than object identity: `data` here came
    // through JSON.parse (a backup file), which has the exact same "never === across keys" issue as a
    // chrome.storage.local round trip.
    count: has("accounts")
      ? new Set(Object.values(data.targetAccounts || {}).map((v) => normalizeCompanyName(v.company))).size
      : null,
    workbookCount: has("accounts") ? (data.targetAccountsWorkbook?.companies || []).length : null,
  };
}

// The single-file automatic backup (backup-restore.js, once per 24h): the settings backup and the
// Target Accounts backup together, so one dated file holds everything a restore needs.
export async function buildAutoBackup() {
  return {
    kind: "salesteam-auto-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    settings: await exportSettings(false),
    targetAccounts: await exportTargetAccountsBackup(),
  };
}

// AI message drafting settings. The API key is deliberately excluded from
// exportSettings/importSettings below - each installer (e.g. the wife's
// laptop) should use their own Anthropic key, not inherit whoever's key
// happened to be in the backup file.
const ANTHROPIC_API_KEY_KEY = "anthropicApiKey";

// --------------------------------------------------------------------------
// API key, message templates, value-add offers
// --------------------------------------------------------------------------

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
// sourceList (added 2026-09-16): marks a builtin topic whose `keywords` are
// no longer independently editable here - they're computed on every
// getNegativeTopics() read from the matching Setup-wizard exclusion list
// (competitorCompanySlugs/recruiterCompanySlugs/existingCustomerCompanySlugs/
// existingPartnerCompanySlugs, storage.js), via applyWizardSourceLists
// below. Reported directly: maintaining a separate free-text keyword list
// here duplicated the wizard's own company lists, which are the more
// deliberately-curated, identity-based source of truth (LinkedIn company
// slugs, not name text) - "it is better to use the lists from the Wizard."
// Any `keywords` value below is a placeholder, immediately overwritten by
// applyWizardSourceLists before this array is ever returned or used to
// match a lead.
const DEFAULT_NEGATIVE_TOPICS = [
  {
    id: "builtin-competitors",
    name: "Competitor Blocklist",
    sourceList: "competitors",
    keywords: [],
    andKeywords: [],
    enabled: true,
    appliesTo: "both",
    matchField: "company",
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
    name: "Recruiting Companies",
    sourceList: "recruiters",
    keywords: [],
    andKeywords: [],
    enabled: true,
    appliesTo: "both",
    matchField: "company",
    builtin: true,
  },
  {
    id: "builtin-customers",
    name: "Existing Customers",
    sourceList: "customers",
    keywords: [],
    andKeywords: [],
    enabled: true,
    appliesTo: "both",
    matchField: "company",
    builtin: true,
  },
  {
    id: "builtin-partners",
    name: "Existing Partners",
    sourceList: "partners",
    keywords: [],
    andKeywords: [],
    enabled: true,
    appliesTo: "both",
    matchField: "company",
    builtin: true,
  },
  // 1.2.0.25 (Boaz, 2026-10-01): companies excluded as "Other" are filtered out of lead scans too, so an excluded
  // company is never a lead whatever its category. Added to existing installs by the backfill in getNegativeTopics.
  {
    id: "builtin-other-exclusions",
    name: "Other Excluded Companies",
    sourceList: "others",
    keywords: [],
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

// Converts a LinkedIn company-page slug (e.g. "randstad-switzerland") into a
// space-separated pseudo-name ("randstad switzerland") that matchesCompanyKeyword's
// fuzzy suffix-stripped comparison can match against a lead's own real
// company text - the same normalization already strips "switzerland"/"ag"/
// etc. as noise words from both sides, so a slug's locale/legal-suffix
// segment doesn't need to exactly echo the lead's own company text.
function slugToCompanyKeyword(slug) {
  return slug.replace(/-/g, " ");
}

// Old plural sourceList values ("competitors" etc., unchanged since 6.20 to
// avoid a data migration for already-saved negativeTopics entries) mapped
// to the unified companyExclusions list's own singular category names.
const NEGATIVE_TOPIC_SOURCE_CATEGORY = {
  competitors: "competitor",
  recruiters: "recruiter",
  customers: "customer",
  partners: "partner",
  others: "other",
};

// Resolves against the unified companyExclusions list (2026-09-17) - the
// recruiter-defaults null-fallback this used to need its own copy of now
// lives once, in getCompanyExclusions itself, so a user who never touched
// the Exclusions wizard step still gets the sensible built-in recruiter
// exclusions here too, same as before, with no separate fallback to keep
// in sync.
async function applyWizardSourceLists(topics) {
  const sourceListsNeeded = [...new Set(topics.filter((t) => t.sourceList).map((t) => t.sourceList))];
  if (sourceListsNeeded.length === 0) return topics;
  const exclusions = await getCompanyExclusions();
  const resolved = Object.fromEntries(
    sourceListsNeeded.map((key) => [
      key,
      // An entry named without a LinkedIn slug (1.2.1, design 3.9) contributes its name.
      exclusions.filter((e) => (e.slug || e.name) && e.category === NEGATIVE_TOPIC_SOURCE_CATEGORY[key]).map((e) => (e.slug ? slugToCompanyKeyword(e.slug) : String(e.name).trim())),
    ])
  );
  return topics.map((t) => (t.sourceList ? { ...t, keywords: resolved[t.sourceList] || [], matchField: "company" } : t));
}

// --------------------------------------------------------------------------
// Negative topics & blocklist
// --------------------------------------------------------------------------

export async function getNegativeTopics() {
  const data = await chrome.storage.local.get([NEGATIVE_TOPICS_KEY, "competitorBlocklist", "recruiterHeadlineBlocklist"]);
  let topics = data[NEGATIVE_TOPICS_KEY];

  if (!topics) {
    // One-time migration from the flat blocklists this replaced (a short-lived
    // earlier version of this same feature) - carries over any edits already
    // made there instead of silently resetting to the built-in defaults.
    if (data.competitorBlocklist || data.recruiterHeadlineBlocklist) {
      topics = DEFAULT_NEGATIVE_TOPICS.map((topic) => {
        if (topic.id === "builtin-competitors" && data.competitorBlocklist) return { ...topic, keywords: data.competitorBlocklist };
        if (topic.id === "builtin-recruiters" && data.recruiterHeadlineBlocklist) return { ...topic, keywords: data.recruiterHeadlineBlocklist };
        return topic;
      });
      await saveNegativeTopics(topics);
    } else {
      topics = DEFAULT_NEGATIVE_TOPICS;
    }
  } else {
    // Backfill (2026-09-16): a stored array from before builtin-competitors/
    // builtin-recruiting-firms became wizard-list-backed (sourceList), or
    // from before builtin-customers/builtin-partners existed at all - never
    // silently resets a user's own custom topics or edits, only adds what's
    // missing/stale by id. Persisted immediately so future reads (and
    // sidepanel.js's own in-memory copy) don't need to re-backfill.
    let changed = false;
    for (const def of DEFAULT_NEGATIVE_TOPICS) {
      if (!def.sourceList) continue;
      const existing = topics.find((t) => t.id === def.id);
      if (!existing) {
        topics = [...topics, { ...def }];
        changed = true;
      } else if (!existing.sourceList) {
        existing.sourceList = def.sourceList;
        existing.matchField = "company";
        changed = true;
      }
    }
    if (changed) await saveNegativeTopics(topics);
  }

  return applyWizardSourceLists(topics);
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

// --------------------------------------------------------------------------
// Location filter - continents, countries, classification
// --------------------------------------------------------------------------

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
export const CONTINENT_COUNTRIES = {
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

// Bidirectional exec-title acronym <-> full-title equivalence groups (PRD
// 6.20 Phase 6, added 2026-09-15) - same pattern as COUNTRY_ALIASES above,
// grows incrementally, not exhaustive. Needed because LinkedIn's own People
// Search does real acronym normalization server-side - confirmed live: a
// keywords=CIO search on a real company's People tab matched a card whose
// displayed title read "Chief Information Officer...", with no literal
// "CIO" substring anywhere in it - but this codebase's own client-side
// match-validation (contact-discovery-extraction.js's classifyCandidate)
// has no equivalent table on its own, so a query built from one form would
// otherwise incorrectly reject a genuine match written in the other form.
const TITLE_ALIAS_GROUPS = [
  ["CEO", "Chief Executive Officer"],
  ["CTO", "Chief Technology Officer"],
  ["CIO", "Chief Information Officer"],
  ["CFO", "Chief Financial Officer"],
  ["COO", "Chief Operating Officer"],
  ["CMO", "Chief Marketing Officer"],
  ["CHRO", "Chief Human Resources Officer"],
  ["CPO", "Chief Product Officer"],
  ["CISO", "Chief Information Security Officer"],
  ["VP", "Vice President"],
  ["SVP", "Senior Vice President"],
  ["EVP", "Executive Vice President"],
];

// Every known-equivalent form of `term` (including itself), or just `[term]`
// unchanged if it isn't part of any known group - never guesses at a
// relationship this table doesn't already know about.
export function titleVariants(term) {
  const normalized = (term || "").trim().toLowerCase();
  if (!normalized) return [];
  const group = TITLE_ALIAS_GROUPS.find((g) => g.some((v) => v.toLowerCase() === normalized));
  return group || [term];
}

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

// Unified with the onboarding wizard's own Location step (targetUniverseConfig)
// 2026-09-16 - previously a wholly separate locationFilterConfig setting,
// edited in its own Settings section. Reported directly: having two
// independent "where do I do business" settings (one scoping Discovery's
// company search, one filtering already-scanned leads) was confusing even
// to design, and there's no real case for wanting them to genuinely
// diverge - so they're now literally the same config, edited in one place
// (the wizard). This function just reshapes targetUniverseConfig's own
// {locationMode, continents, countries} into the {mode, continents,
// countries} shape matchesLocationFilter below already expects (kept
// as-is, unrenamed, to avoid a much larger rename across every caller).
// Real behavior change worth knowing about: the old setting supported
// mode: "off" (no lead-location restriction at all, independent of
// whatever Discovery searched for) - the wizard's Location step is
// required (at least one continent/country), so that "unrestricted leads"
// state no longer exists; leads are now always scoped to the same
// geography Discovery searches for.
function generalLocationFilterConfig(universeConfig) {
  return { mode: universeConfig.locationMode, continents: universeConfig.continents, countries: universeConfig.countries };
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

// Per-topic Location Filter override (PRD Phase 9, added 2026-09-16) - a
// Topic/Job Topic can opt out of the general (Settings-wide) config with
// its own useGeneralLocationFilter: false + locationFilterOverride
// (sidepanel.js's newTopic/renderTopicCards). Falls back to the general
// config for any topic missing the field entirely (a topic saved before
// this existed) - same "opt-in override, general by default" direction as
// every other per-topic-vs-general choice already in this codebase.
function effectiveLocationFilterConfigForTopic(topic, generalConfig) {
  if (!topic || topic.useGeneralLocationFilter !== false) return generalConfig;
  return topic.locationFilterOverride || generalConfig;
}

// A lead can match more than one Topic/Job Topic (lead.matchedTopics) - each
// may use the general config or its own override. A lead is blocked only if
// EVERY matched topic's own effective config would exclude it; it survives
// if it satisfies at least one - conservative by design, same discipline as
// matchesLocationFilter's own "never returns a reason for 'we don't know'"
// comment: a lead found via two topics shouldn't be hidden just because one
// of them happens to have a narrower override than the other.
// topicLookup: Map<topicId, topic> covering both getTopics()/getJobTopics()
// (a lead's matchedTopics can reference either) - build once per call via
// buildTopicLookup, not per lead.
export function matchesLocationFilterForLead(lead, generalConfig, topicLookup) {
  const matchedTopics = lead.matchedTopics || [];
  if (matchedTopics.length === 0) return matchesLocationFilter(lead, generalConfig);
  let reason = null;
  for (const mt of matchedTopics) {
    const topic = topicLookup?.get(mt.topicId);
    const config = effectiveLocationFilterConfigForTopic(topic, generalConfig);
    reason = matchesLocationFilter(lead, config);
    if (!reason) return null; // passes under at least one matched topic's own config
  }
  return reason; // blocked under every matched topic - report the last reason computed
}

export function buildTopicLookup(topics, jobTopics) {
  const map = new Map();
  for (const t of [...(topics || []), ...(jobTopics || [])]) map.set(t.id, t);
  return map;
}

// Mirrors applyNegativeTopicsToResultsMap's New<->Irrelevant transition
// logic exactly, using a parallel locationFilterReason field so the two
// filters can compose without clobbering each other (see the restore-branch
// patch in applyNegativeTopicsToResultsMap above). topicLookup (optional,
// see buildTopicLookup) enables the per-topic override resolution above;
// omitted, every lead falls back to the plain general-config check.
export function applyLocationFilterToResultsMap(resultsMap, config, topicLookup) {
  const now = Date.now();
  let blockedCount = 0;
  let restoredCount = 0;
  let anyChanged = false;
  const resolve = (lead) => (topicLookup ? matchesLocationFilterForLead(lead, config, topicLookup) : matchesLocationFilter(lead, config));
  for (const lead of Object.values(resultsMap)) {
    if (lead.status === "New") {
      const reason = resolve(lead);
      if (reason) {
        lead.status = "Irrelevant";
        lead.locationFilterReason = reason;
        lead.statusUpdatedAt = now;
        blockedCount++;
        anyChanged = true;
      }
    } else if (lead.status === "Irrelevant" && lead.locationFilterReason) {
      const reason = resolve(lead);
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
// after changing the wizard's Location step, or a Topic's own override).
// Also the only real application point today (side panel's own profile-
// extraction flow and manual per-lead location assignment both call this
// too, in dashboard.js/sidepanel.js) - background.js's scanAllTopics itself
// doesn't call this at all, a pre-existing gap unrelated to the per-topic
// redesign here, not newly introduced by it.
export async function reapplyLocationFilter() {
  const [results, universeConfig, topics, jobTopics] = await Promise.all([
    getResults(), getTargetUniverseConfig(), getTopics(), getJobTopics(),
  ]);
  const config = generalLocationFilterConfig(universeConfig);
  const topicLookup = buildTopicLookup(topics, jobTopics);
  const { blockedCount, restoredCount, anyChanged } = applyLocationFilterToResultsMap(results, config, topicLookup);
  if (anyChanged) await saveResults(results);
  return { blockedCount, restoredCount };
}

// --------------------------------------------------------------------------
// Leads - status, drafts, bulk changes, priorities
// --------------------------------------------------------------------------

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
// `by` (1.2.2 step 5b): in a team, the member who marked the lead Contacted - the Leads Dashboard warns a colleague
// before a second approach to the same person.
export async function updateLeadStatus(key, status, { by = null } = {}) {
  if (!LEAD_STATUSES.includes(status)) return;
  const results = await getResults();
  if (results[key]) {
    results[key].status = status;
    results[key].statusUpdatedAt = Date.now();
    if (status === "Contacted" && by) {
      results[key].contactedBy = by;
      results[key].contactedAt = Date.now();
    }
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

// normalizeCompanyName lives in company-identity.js (pure, tested) since 1.2.1 step 1; re-exported at the top
// of this file so every existing import from storage.js still works.

// --------------------------------------------------------------------------
// Prioritization rules & company scoring
// --------------------------------------------------------------------------

// The fixed catalog of deterministic rules layered on top of the Sales
// Mentor for a qualifying Target Account match (see 6.11/6.13 in PRD.md) -
// each rule uses exactly one of the three effect types, matching the
// Setup wizard's own Ceiling/Floor/Decisive columns:
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
//
// Job-lead only, below - Post leads no longer have their own catalog
// entries as of 2026-09-16. The former post_title_match/post_topic_match/
// post_company_floor (each independently toggleable, one value apiece) were
// replaced by the generic Post prioritization rule engine (see
// getPostPrioritizationRules/evaluatePostPrioritizationRules below) - a
// user-editable set of AND/OR conditions (workbook column match, company-
// in-list, author-is-target-contact, topic match) with a floor/ceiling/
// decisive effect, rather than a fixed set of toggleable single-value
// rules the way the old design (and this Job-only catalog) still works.
export const PRIORITIZATION_RULE_CATALOG = [
  {
    id: "job_company_cap",
    description: "Job listing at a Target Account at or above the level chosen above - there's no individual to contact, so it gets this priority automatically, without an AI call.",
    type: "decisive",
    defaultValue: 3,
  },
  {
    id: "job_signal_ceiling",
    description: "Job listing at a Target Account below the level chosen above - the Sales Mentor still decides, but is never allowed to rate it better than this, since there's still no individual to contact.",
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
// A lead's company against the Target Accounts: the workbook-scored entry when there is one, else the account row
// itself (web / LinkedIn accounts have no targetAccounts entry), with SalesTeam's own Priority as its confidence.
// qualifies = its confidence level is at least minConfidence (a CONFIDENCE_LEVELS id).
export function evaluateTargetAccountMatch(company, targetAccounts, minConfidence, companyRow = null, salesTeamPriority = null) {
  const mapped = targetAccounts[normalizeCompanyName(company)];
  const scored = mapped && mapped.score != null ? mapped : null;
  if (!scored && !companyRow) return { match: null, qualifies: false };
  const priority = salesTeamPriority || companyRow?.salesTeamPriority || null;
  const match = scored
    ? { ...scored, salesTeamPriority: priority }
    : { company: companyRow.company, score: null, priorityLabel: null, salesTeamPriority: priority };
  const rank = accountConfidenceRank(match.priorityLabel, priority);
  const minRank = CONFIDENCE_LEVELS.find((l) => l.id === minConfidence)?.rank ?? 3;
  return { match, qualifies: rank != null && rank >= minRank };
}

// ---------------------------------------------------------------------------
// PRD 6.20 Phase 8 - Company-level AI prioritization (2026-09-17, fully
// scoped in a real design conversation with the user - see the plan file's
// own "Phase 8" section). Scores every ELIGIBLE company in
// targetAccountsWorkbook.companies (imported AND Discovered alike, unified
// there since Phase 7) into a P1-P5 priority + short reason - the same
// P1-P5 scale leads already use, mirroring the existing, already-proven
// lead-prioritization pattern (agent-shared.js's prioritizeLeads) rather
// than inventing a new mechanism.
//
// Written onto NEW fields - salesTeamPriority/salesTeamPriorityScore/
// salesTeamPriorityReason - deliberately never aiPriority/aiPriorityScore
// (the IMPORT's own conclusion, AI_FIELD_ALIASES-backfilled from the plain
// priority/priorityScore short keys) - both already mean something else on
// this exact same row (the workbook's own pre-existing research
// conclusion), and colliding with them would silently corrupt the Post-lead
// rule engine's existing seed rules (which key off "column": "priority").
// This is SalesTeam's own, separate judgment, always distinguishable from
// the import's on the same row.
//
// Core principle, stated directly by the user and load-bearing here: THE
// IMPORTED WORKBOOK IS ALWAYS OPTIONAL. Most future SalesTeam customers
// won't have one at all - this has to work as a first-class path on
// SalesTeam's own Discovery data alone (Scenario 1 below), not as a
// fallback for when "real" data is missing.
//
// The user's own 4 scenarios:
//   1. Discovered by SalesTeam, not in the import at all - only SalesTeam's
//      own data exists. Scored in full (deterministic + optional AI).
//   2. In the import with sufficient evidence (the SAME "confident"
//      definition evaluateTargetAccountMatch above already uses:
//      priorityLabel is Very High or High AND priorityScore is at or above
//      the existing Target Account confidence threshold - reusing that
//      exact setting, not a second hardcoded check) - trust it directly:
//      Very High -> P1, High -> P2. No AI call, no deterministic pass.
//   3. In the import, insufficient evidence, AND no SalesTeam signal (no
//      matched contact at all) - too little to justify computing a real
//      score. Floor P5 (a practical no-op - nothing rates worse), deferring
//      entirely to the Sales Mentor's own per-lead judgment rather than
//      manufacturing a number from too little evidence.
//   4. In the import, insufficient evidence, BUT SalesTeam has a real
//      signal to add (at least one matched contact, from Discovery or the
//      import's own Contacts sheet) - combine SalesTeam's own signals with
//      whatever genuine research text the import does have. Scored the
//      same way as Scenario 1.
// "Has a SalesTeam signal" is approximated by contact presence - the
// clearest, concrete proxy actually available for "SalesTeam's Discovery
// work touched this company" (there's no separate flag recording whether
// Company Discovery independently re-found an already-imported company;
// the deterministic score below already weights contacts heavily, so this
// is a reasonable v1 proxy, not a hardcoded guess). A dedicated
// "also independently discovered" flag is a v2 refinement, not v1.

const COMPANY_PRIORITY_BASELINE = 50;
const COMPANY_PRIORITY_LOCATION_WEIGHT = 8;
const COMPANY_PRIORITY_SIZE_WEIGHT = 8;
const COMPANY_PRIORITY_INDUSTRY_WEIGHT = 8;

function companyPriorityNudge(priority, weight) {
  if (priority === 3) return weight;
  if (priority === 1) return -weight;
  return 0;
}

let _continentByCountry = null;
function continentForCountry(country) {
  if (!_continentByCountry) {
    _continentByCountry = {};
    for (const [continent, countries] of Object.entries(CONTINENT_COUNTRIES)) {
      for (const c of countries) _continentByCountry[c] = continent;
    }
  }
  return _continentByCountry[country] || null;
}

// locationPriorities is keyed by whichever granularity the wizard's own
// Location step actually used (per-country, or per-continent when more than
// one continent was picked - see onboarding.js's locationPriorityItems) - a
// company row only ever carries a plain country (globalHqCountry), so this
// tries a direct country-name key first, falling back to that country's own
// continent when the saved config is keyed by continent instead.
export function resolveLocationPriority(country, locationPriorities) {
  if (!country || !locationPriorities) return null;
  if (locationPriorities[country] != null) return locationPriorities[country];
  const continent = continentForCountry(country);
  if (continent && locationPriorities[continent] != null) return locationPriorities[continent];
  return null;
}

// A Discovered-only company never carries a real size - LinkedIn's own size
// FACET scopes the search, but the specific bucket a given result actually
// falls into is never scraped back per-row (company-discovery-extraction.js
// caches sizeBucket: null for exactly this reason). Only an imported row's
// own globalEmployees/swissEmployees gives real usable size data - missing
// size naturally contributes no nudge either way below, not a hardcoded
// default.
// Reads through parseLooseNumber rather than demanding a real number, because it does not always
// get one: EPFL's employee count is stored as the STRING "6,500+" and ADM Switzerland's as ">5,000".
// Both used to fall straight through this function as null, so those companies silently got no size
// nudge at all when they were scored - a bug that was invisible because nothing anywhere said so.
function resolveSizeBucket(employeeCount) {
  const n = parseLooseNumber(employeeCount);
  if (n === null) return null;
  return SIZE_PRIORITY_BUCKETS.find((b) => n >= b.min && n <= b.max) || null;
}

// Free (no AI call) - runs for every Scenario 1/4 company. Starts from a
// neutral baseline of 50 (matching ChatGPT's own score-then-label
// convention) and nudges it per the user's own explicit weighting:
// Location/Size/Industry priority (each already a Low/Med/High wizard
// setting) get a small, symmetric +-8; matched Target Contact count gets a
// much bigger, SATURATING (not linear) weight, deliberately front-loaded
// onto "does at least one real contact exist at all" - the qualitative jump
// that matters most. A flat "+X per contact" would over-value the 3rd
// contact almost as much as the first, which doesn't match how much each
// additional contact actually adds once there's already a way in.
export function computeCompanyDeterministicPreScore(company, contactCount, targetUniverseConfig) {
  let score = COMPANY_PRIORITY_BASELINE;
  const reasonParts = [];

  const locationPriority = resolveLocationPriority(company.globalHqCountry, targetUniverseConfig.locationPriorities);
  if (locationPriority != null && locationPriority !== 2) {
    score += companyPriorityNudge(locationPriority, COMPANY_PRIORITY_LOCATION_WEIGHT);
    reasonParts.push(`${locationPriority === 3 ? "high" : "low"}-priority location (${company.globalHqCountry})`);
  }

  // parseLooseNumber on BOTH, not `typeof === "number"`: EPFL's count is the string "6,500+" and
  // ADM's is ">5,000". The old test failed those, silently fell through to swissEmployees (usually
  // empty) and left the company with no size nudge at all - the very bug resolveSizeBucket was
  // taught to parse around, still reached through this caller.
  const employeeCount = parseLooseNumber(company.globalEmployees) ?? parseLooseNumber(company.swissEmployees);
  const sizeBucket = resolveSizeBucket(employeeCount);
  const sizePriority = sizeBucket ? targetUniverseConfig.sizeBuckets?.[sizeBucket.key]?.priority : null;
  if (sizePriority != null && sizePriority !== 2) {
    score += companyPriorityNudge(sizePriority, COMPANY_PRIORITY_SIZE_WEIGHT);
    reasonParts.push(`${sizePriority === 3 ? "high" : "low"}-priority size (${sizeBucket.label})`);
  }

  const industryEntry = (targetUniverseConfig.industries || []).find(
    (i) => i.name && company.industry && i.name.toLowerCase() === company.industry.toLowerCase()
  );
  if (industryEntry && industryEntry.priority !== 2) {
    score += companyPriorityNudge(industryEntry.priority, COMPANY_PRIORITY_INDUSTRY_WEIGHT);
    reasonParts.push(`${industryEntry.priority === 3 ? "high" : "low"}-priority industry (${company.industry})`);
  }

  let contactsNudge = 0;
  if (contactCount >= 3) contactsNudge = 30;
  else if (contactCount === 2) contactsNudge = 25;
  else if (contactCount === 1) contactsNudge = 18;
  score += contactsNudge;
  if (contactCount > 0) reasonParts.push(`${contactCount} matched contact${contactCount === 1 ? "" : "s"}`);

  return { score: Math.max(0, Math.min(100, score)), reasonParts };
}

// >=85 P1, 70-84 P2, 50-69 P3, <50 P4 - P5 is reserved for Scenario 3's
// explicit floor (getCompaniesForPrioritization/prioritizeCompanies below),
// never reached by bucketing a low score here.
export function bucketCompanyScore(score) {
  if (score >= 85) return "P1";
  if (score >= 70) return "P2";
  if (score >= 50) return "P3";
  return "P4";
}

// Same "confident" definition evaluateTargetAccountMatch above already uses
// (Very High/High only, never Provisional or any other label, at or above
// the SAME Target Account confidence threshold setting) - reused rather
// than inventing a second, hardcoded evidence check. Reads the row's own
// aiPriority/aiPriorityScore directly (guaranteed populated either way
// since xlsx-lite.js's AI_FIELD_ALIASES backfill is bidirectional).
export function hasSufficientImportEvidence(company, threshold) {
  const label = company.aiPriority;
  const score = company.aiPriorityScore;
  if (typeof score !== "number") return false;
  return (label === "Very High" || label === "High") && score >= threshold;
}

// Classifies a company into the user's own 4 scenarios (see this section's
// header comment) - pure, no side effects, directly testable per-company.
export function classifyCompanyPrioritizationScenario(company, contactCount, threshold) {
  if (company.source !== "Imported") return 1;
  if (hasSufficientImportEvidence(company, threshold)) return 2;
  return contactCount > 0 ? 4 : 3;
}

// Companies eligible for Phase 8 scoring right now, each pre-classified into
// its scenario - same soft-delete/exclusion filtering as every other
// company-list read (getExistingCompaniesNeedingContacts above). Excludes
// a company already scored (salesTeamPriority set) unless rescoreAll is
// true, so a repeated run only costs anything for genuinely new companies
// by default.
// rescoreDerived (1.2 build step 1, design 2.5.3): also returns companies whose stored priority was
// computed locally, so it is re-scored as data arrives - an account scored P4 before its contacts were
// found no longer stays P4 for good. Never a manual override, and never an AI-judged score (its reason
// carries "Strategic Fit:"): AI re-prioritisation stays a user action.
function isDerivedPriority(row, extra) {
  if (extra?.overrides?.salesTeamPriority) return false;
  return !/Strategic Fit:/.test(row.salesTeamPriorityReason || "");
}

export async function getCompaniesForPrioritization({ rescoreAll = false, rescoreDerived = false } = {}) {
  const [workbook, extras, exclusions, threshold] = await Promise.all([
    getTargetAccountsWorkbook(), getTargetAccountExtras(), getCompanyExclusions(), getTargetAccountScoreThreshold(),
  ]);
  const exclusionMatcher = await getExclusionMatcher();
  const contactCountByCompanyId = new Map();
  for (const contact of workbook.contacts || []) {
    if (!contact.companyId) continue;
    contactCountByCompanyId.set(contact.companyId, (contactCountByCompanyId.get(contact.companyId) || 0) + 1);
  }
  return (workbook.companies || [])
    .filter((c) => c.company && c.companyId)
    .filter((c) => !extras[normalizeCompanyName(c.company)]?.deletedAt)
    .filter((c) => !isCompanyRowExcluded(c, exclusionMatcher))
    .filter((c) => rescoreAll || !c.salesTeamPriority || (rescoreDerived && isDerivedPriority(c, extras[normalizeCompanyName(c.company)])))
    .map((c) => {
      const contactCount = contactCountByCompanyId.get(c.companyId) || 0;
      // Scored through the account's own overrides, not off the bare row (2026-09-22). Neither a web
      // research nor a manual edit ever writes back onto the workbook row - both land in
      // extras[key].overrides - so scoring the raw row silently ignored every employee count, HQ
      // country and revenue figure the web research found. The asymmetry was the giveaway: a size from
      // "Fetch Company Size" DOES move a score, because that one writes onto the row (applyCompanySizeResults),
      // while the same number found on the web did not. The Accounts table has always shown the
      // override as the truth (rawValue), so the score now reflects the values the user actually sees.
      // The merged object is only ever read - prioritizeCompanies returns {companyId, priority,
      // priorityScore, priorityReason} and applyCompanyPrioritizationResults writes just those four
      // back by companyId - so an override can never leak into stored row data this way. company and
      // companyId are re-asserted from the row regardless: they key the write-back and the name
      // lookups, and an override must not be able to repoint either.
      const overrides = extras[normalizeCompanyName(c.company)]?.overrides;
      const merged = overrides ? { ...c, ...overrides, company: c.company, companyId: c.companyId } : c;
      return { company: merged, contactCount, scenario: classifyCompanyPrioritizationScenario(merged, contactCount, threshold) };
    });
}

// Read-mutate-write onto targetAccountsWorkbook.companies, same pattern as
// appendContactsToWorkbook/markContactDiscoveryAttempted above.
// results: { companyId, priority, priorityScore, priorityReason }[].
export async function applyCompanyPrioritizationResults(results) { return withAccountWriteLock(() => applyCompanyPrioritizationResultsUnlocked(...arguments)); }
async function applyCompanyPrioritizationResultsUnlocked(results) {
  if (!results || results.length === 0) return 0;
  const workbook = await getTargetAccountsWorkbook();
  const byId = new Map(results.map((r) => [r.companyId, r]));
  let applied = 0;
  const scoredAt = Date.now();
  const companies = (workbook.companies || []).map((c) => {
    const r = byId.get(c.companyId);
    if (!r) return c;
    applied++;
    return {
      ...c,
      salesTeamPriority: r.priority,
      salesTeamPriorityScore: r.priorityScore,
      salesTeamPriorityReason: r.priorityReason,
      salesTeamPriorityScoredAt: scoredAt,
    };
  });
  await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...workbook, companies } });
  return applied;
}

function describeMatch(match) {
  if (match.score != null && match.priorityLabel) return `${match.company} scored ${Math.round(match.score)}/100 (${match.priorityLabel})`;
  return `${match.company}${match.salesTeamPriority ? ` (SalesTeam Priority ${match.salesTeamPriority})` : ""}`;
}

// Generic, user-defined Post-lead prioritization rules (2026-09-16) -
// reported directly: an earlier fixed 8-cell table hardcoded here (crossing
// company confidence against a title/topic signal) was "VERY connected to
// the Swiss, ChatGPT AI priorities, and the AI services offered...
// definitely NOT transferable to a generic SalesTeam app." A different
// user's research workbook has entirely different columns, label text, and
// Topic names - none of that can be hardcoded in product code. Job leads
// keep PRIORITIZATION_RULE_CATALOG's fixed 2-rule catalog above (a
// structural fact - "a Job listing has no individual to contact" - not
// tied to any one market or workbook schema); only Post leads (which
// depend entirely on THIS user's own columns/labels/topics) get this fully
// generic engine instead.
//
// Each rule: { id, name, conditions: [...], effectType: "floor"|"ceiling"|
// "decisive", value: 1-5, enabled }. `conditions` are ALL required (AND) -
// each condition type provides its own OR (any-of) semantics so a single
// condition can express "column X is A or B or C":
//   - { type: "column", column: <field name from the Target Accounts
//       Dashboard's own company row>, operator: "containsAnyOf" (text) |
//       "atLeast" | "atMost" (numeric), values: [...] (containsAnyOf) |
//       value: number (atLeast/atMost) }
//   - { type: "companyHasMatch" } - the lead's company has ANY row in the
//     Target Accounts workbook at all, regardless of any column value -
//     what makes a "column" condition further down effectively optional/
//     inclusive rather than requiring an exact label.
//   - { type: "authorIsTargetContact" } - the post's author matches a
//     verified Contacts-sheet entry at the same company
//     (findTargetContactMatch) - deliberately NOT a headline-keyword guess;
//     per the user's own reasoning, a verified Contacts-sheet match already
//     implies a qualifying title, so no separate title condition exists.
//   - { type: "authorSeniorityAtLeast", value: 1-3 } - the matched contact
//     (same findTargetContactMatch match as authorIsTargetContact - false if
//     there's no matched contact at all) carries a seniorityPriority at or
//     above this value. seniorityPriority is stamped onto a Discovered
//     contact by Contact Discovery when their headline demonstrates one of
//     the user's own selected/prioritized seniority levels (Contacts step -
//     see targetContactProfile.seniorityLevels and
//     classifyCandidateSeniority in contact-discovery-extraction.js); an
//     imported (non-Discovered) contact row has none stored, so its level is
//     derived from its job title instead (withEffectiveSeniorityPriority,
//     2026-09-19 - same value the Target Contacts table shows), and it matches
//     only when levels are configured and its title demonstrates one - same
//     "best-effort, never a hard requirement" posture as every other optional
//     signal here.
//   - { type: "topicMatch", topicNameContainsAnyOf: [...] } - the lead was
//     found via a Topic/Job Topic whose own name contains one of these
//     (case-insensitive substring, tolerant of a topic's own language-
//     variant suffix, e.g. "Enterprise AI Buying Signals (EN)").
// Rules are evaluated in stored order, first FULLY-matching enabled rule
// wins (same short-circuit shape the old fixed table, and Job leads'
// PRIORITIZATION_RULE_CATALOG chain, both always used) - a broader
// catch-all rule belongs last, not first, since later rules never get
// checked once an earlier one matches.
//
// Seeded below with the user's own original 8-branch spec, translated into
// this generic shape - existing installs see identical behavior to before
// this generalization, fully editable from here on. The numeric 70
// (Very High/High's own score cutoff) is now a plain, independently-edited
// condition value on these specific seed rules, NOT the same setting as
// the wizard's "Target Account confidence threshold" field above (that one
// still only governs the separate Job-lead rules) - changing one no longer
// changes the other, a real, deliberate decoupling now that Post rules are
// fully generic.
const POST_PRIORITIZATION_RULES_KEY = "postPrioritizationRules";

const DEFAULT_POST_PRIORITIZATION_RULES = [
  {
    id: "seed-qualifying-contact-topic",
    name: "Qualifying account + Target Contact + buying-readiness topic",
    conditions: [
      { type: "column", column: "priority", operator: "equalsAnyOf", values: ["Very High", "High"] },
      { type: "column", column: "priorityScore", operator: "atLeast", value: 70 },
      { type: "authorIsTargetContact" },
      { type: "topicMatch", topicNameContainsAnyOf: ["AI Transformation", "Enterprise AI Buying Signals"] },
    ],
    effectType: "floor", value: 1, enabled: true,
  },
  {
    id: "seed-qualifying-contact",
    name: "Qualifying account + Target Contact",
    conditions: [
      { type: "column", column: "priority", operator: "equalsAnyOf", values: ["Very High", "High"] },
      { type: "column", column: "priorityScore", operator: "atLeast", value: 70 },
      { type: "authorIsTargetContact" },
    ],
    effectType: "floor", value: 2, enabled: true,
  },
  {
    id: "seed-qualifying-topic",
    name: "Qualifying account + buying-readiness topic",
    conditions: [
      { type: "column", column: "priority", operator: "equalsAnyOf", values: ["Very High", "High"] },
      { type: "column", column: "priorityScore", operator: "atLeast", value: 70 },
      { type: "topicMatch", topicNameContainsAnyOf: ["AI Transformation", "Enterprise AI Buying Signals"] },
    ],
    effectType: "floor", value: 1, enabled: true,
  },
  {
    id: "seed-qualifying-only",
    name: "Qualifying account only",
    conditions: [
      { type: "column", column: "priority", operator: "equalsAnyOf", values: ["Very High", "High"] },
      { type: "column", column: "priorityScore", operator: "atLeast", value: 70 },
    ],
    effectType: "floor", value: 3, enabled: true,
  },
  {
    id: "seed-other-contact-topic",
    name: "Account in list + Target Contact + buying-readiness topic",
    conditions: [
      { type: "companyHasMatch" },
      { type: "authorIsTargetContact" },
      { type: "topicMatch", topicNameContainsAnyOf: ["AI Transformation", "Enterprise AI Buying Signals"] },
    ],
    effectType: "floor", value: 2, enabled: true,
  },
  {
    id: "seed-other-contact",
    name: "Account in list + Target Contact",
    conditions: [
      { type: "companyHasMatch" },
      { type: "authorIsTargetContact" },
    ],
    effectType: "floor", value: 3, enabled: true,
  },
  {
    id: "seed-other-topic",
    name: "Account in list + buying-readiness topic",
    conditions: [
      { type: "companyHasMatch" },
      { type: "topicMatch", topicNameContainsAnyOf: ["AI Transformation", "Enterprise AI Buying Signals"] },
    ],
    effectType: "floor", value: 2, enabled: true,
  },
  {
    id: "seed-other-only",
    name: "Account in list, no other signal",
    conditions: [
      { type: "companyHasMatch" },
    ],
    effectType: "floor", value: 5, enabled: true,
  },
];

// Reverse of xlsx-lite.js's own AI_FIELD_ALIASES (short-column-name ->
// "ai"-prefixed internal key) - kept as its own small local copy rather
// than an import, since storage.js is deliberately a dependency-free
// module (see its own header comment) and this is only a handful of
// entries. Used below to normalize any rule saved before 2026-09-17 (when
// the default seed rules themselves still referenced "aiPriority"/
// "aiPriorityScore" directly) back to the short name a real, de-AI'd
// workbook actually has - reported directly: the fixed defaults alone
// don't help a rule a user already saved (or the wizard's own debounced
// autosave already persisted) before this fix shipped.
const AI_ALIAS_TO_SHORT_COLUMN = {
  aiPriorityScore: "priorityScore",
  aiPriority: "priority",
  aiPortfolioProfile: "portfolioProfile",
  aiPortfolioProfileConfidence: "portfolioProfileConfidence",
  aiInvestmentGlobal: "investmentGlobal",
  aiInvestmentSwitzerland: "investmentSwitzerland",
  aiInvestmentConfidence: "investmentConfidence",
  topAiInitiatives: "topInitiatives",
  aiMaturityFitScore: "maturityFitScore",
  aiUseCaseFitScore: "useCaseFitScore",
  aiRelevance: "relevance",
  aiInvestmentScore: "investmentScore",
};

function normalizePostRuleColumnNames(rules) {
  return rules.map((rule) => ({
    ...rule,
    conditions: rule.conditions.map((c) =>
      c.type === "column" && AI_ALIAS_TO_SHORT_COLUMN[c.column]
        ? { ...c, column: AI_ALIAS_TO_SHORT_COLUMN[c.column] }
        : c
    ),
  }));
}

// --------------------------------------------------------------------------
// Post prioritization & target-account signal
// --------------------------------------------------------------------------

export async function getPostPrioritizationRules() {
  const data = await chrome.storage.local.get(POST_PRIORITIZATION_RULES_KEY);
  const rules = data[POST_PRIORITIZATION_RULES_KEY] || DEFAULT_POST_PRIORITIZATION_RULES;
  return normalizePostRuleColumnNames(rules);
}

export async function savePostPrioritizationRules(rules) {
  await chrome.storage.local.set({ [POST_PRIORITIZATION_RULES_KEY]: rules });
}

function evaluateRuleCondition(condition, { companyRow, hasCompanyMatch, contact, lead }) {
  switch (condition.type) {
    case "companyHasMatch":
      return hasCompanyMatch;
    case "column": {
      if (!companyRow) return false;
      const raw = companyRow[condition.column];
      // "equalsAnyOf" (exact, whole-value match) vs "containsAnyOf"
      // (substring) are deliberately separate operators, not one - a label
      // column can carry a meaningful compound value (e.g. this project's
      // own ChatGPT export appends " - Provisional" to a thinner-evidence
      // account's otherwise-identical label), where a substring check would
      // silently match the base label anyway and defeat the whole point of
      // that suffix. containsAnyOf stays available for a genuinely
      // substring-appropriate column (e.g. matching a Topic name that
      // carries its own language-variant suffix).
      if (condition.operator === "equalsAnyOf" || condition.operator === "containsAnyOf") {
        if (!condition.values || condition.values.length === 0) return raw != null && raw !== "";
        const text = String(raw ?? "").toLowerCase();
        return condition.values.some((v) => {
          const needle = String(v).toLowerCase();
          return condition.operator === "equalsAnyOf" ? text === needle : text.includes(needle);
        });
      }
      const num = typeof raw === "number" ? raw : parseFloat(raw);
      if (Number.isNaN(num)) return false;
      if (condition.operator === "atLeast") return num >= condition.value;
      if (condition.operator === "atMost") return num <= condition.value;
      return false;
    }
    case "authorIsTargetContact":
      return Boolean(contact);
    case "authorSeniorityAtLeast":
      return Boolean(contact) && Number(contact.seniorityPriority) >= condition.value;
    case "topicMatch": {
      const names = (lead.matchedTopics || []).map((t) => (t.topicName || "").toLowerCase());
      return (condition.topicNameContainsAnyOf || []).some((substr) =>
        names.some((n) => n.includes(String(substr).toLowerCase()))
      );
    }
    default:
      return false;
  }
}

// First fully-matching enabled rule wins - returns it directly (its own
// effectType/value), or null if nothing matched (no floor/ceiling/decisive
// at all, pure Sales Mentor judgment).
function evaluatePostPrioritizationRules(rules, ctx) {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.conditions.length > 0 && rule.conditions.every((c) => evaluateRuleCondition(c, ctx))) {
      return rule;
    }
  }
  return null;
}

// Splits a list of not-yet-(re)scored leads against the imported Target
// Accounts list. Two independent mechanisms, by lead type:
//   - Job leads still use PRIORITIZATION_RULE_CATALOG's job_company_cap
//     (decisive, qualifying company - straight into autoPriorities, ready
//     for applyLeadPriorities below, no AI call at all) and
//     job_signal_ceiling (a non-qualifying match, clamps the AI's own
//     result instead of replacing it).
//   - Post leads (2026-09-16) use the fully generic, user-editable rule
//     engine above (getPostPrioritizationRules/
//     evaluatePostPrioritizationRules) instead of a fixed catalog - can be
//     decisive, floor, or ceiling depending on what the matched rule's own
//     effectType says, unlike Job leads' two hardcoded rules.
// Every lead reaching toScore gets a shallow-cloned copy (never a mutation,
// so this transient hint is never accidentally persisted onto the real
// stored lead object) carrying whichever of targetAccountSignal/
// targetContactSignal/targetAccountFloor/targetAccountCeiling actually
// apply - the Sales Mentor's own judgment is always the base decision and
// is never itself disabled; these only ever constrain or override it for a
// lead that satisfies their specific condition. Shared by background.js's
// automatic post-scan pass and the Dashboard's manual Prioritize Unscored /
// Re-score All Priorities buttons, so every path applies the same rules -
// importing/updating the Target Accounts list retroactively affects leads
// re-scored afterward without requiring a fresh scan.
export async function partitionLeadsByTargetAccount(leads) {
  const targetAccounts = await getTargetAccounts();
  const workbook = await getTargetAccountsWorkbook();
  if (Object.keys(targetAccounts).length === 0 && workbook.companies.length === 0) {
    return { autoPriorities: [], toScore: leads };
  }

  // Target Contacts (Companies-sheet-independent - the Contacts sheet of
  // the same workbook, PRD 6.12) - checked inline below for every Post lead
  // (findTargetContactMatch), regardless of whether its company cleared the
  // score threshold, since the rule engine itself needs to know.
  const contacts = workbook.contacts || [];
  // Full company row (every column, not just the lightweight targetAccounts
  // projection) - what the generic Post-lead rule engine's own "column"
  // conditions actually check against, since those can reference any field
  // a user's workbook happens to have, not just score/priorityLabel.
  const companyByName = new Map(workbook.companies.map((c) => [normalizeCompanyName(c.company), c]));
  const postRules = await getPostPrioritizationRules();
  const seniorityLevels = (await getTargetContactProfile()).seniorityLevels || [];
  // A company excluded either way (the workbook's own Excluded column, or
  // this app's own companyExclusions blocklist - isCompanyRowExcluded
  // checks both) is never a Target Account for prioritization purposes,
  // full stop - treated exactly like a lead with no match at all, for
  // both Job and Post leads, regardless of how high its own score is.
  // Added 2026-09-17: a workbook that scores a competitor normally instead
  // of writing "Out of Scope" (the whole reason this column exists) would
  // otherwise still trigger an automatic floor/ceiling here.
  const exclusionMatcher = await getExclusionMatcher();
  const isExcludedCompanyName = (name) => isCompanyRowExcluded(companyByName.get(normalizeCompanyName(name)) || { company: name }, exclusionMatcher);

  const minConfidence = await getJobRulesMinConfidence();
  const accountExtras = await getTargetAccountExtras();
  const rules = await getPrioritizationRules();
  const ruleById = Object.fromEntries(rules.map((r) => [r.id, r]));

  const autoPriorities = [];
  const toScore = [];
  for (const lead of leads) {
    if (isExcludedCompanyName(lead.company)) {
      toScore.push(lead);
      continue;
    }
    const leadCompanyKey = normalizeCompanyName(lead.company);
    const leadCompanyRow = companyByName.get(leadCompanyKey) || null;
    const { match, qualifies } = evaluateTargetAccountMatch(lead.company, targetAccounts, minConfidence, leadCompanyRow,
      accountExtras[leadCompanyKey]?.overrides?.salesTeamPriority || null);

    if (match && lead.type === "job") {
      if (qualifies) {
        // A Job lead's "creator" is the company itself, not an individual -
        // there's no real person to message, and a job ad alone (no named
        // contact, no stated initiative beyond "we're hiring") never earns
        // better than this rule's value, however highly the employer
        // scored. Applied directly rather than sent to the AI - there's
        // nothing else for the model to weigh for this specific decision.
        // Disabling the rule leaves the lead to the Sales Mentor entirely,
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
      // A Provisional/below-threshold match still means this Job lead's
      // company is a researched, imported Target Account - the same "no
      // individual to contact" reasoning as job_company_cap above applies
      // regardless of confidence, but the score itself isn't confident
      // enough to trust the AI-free deterministic path. Reported directly:
      // two real Job leads with a "Very High - Provisional" signal still
      // reached Priority 1 - the AI's own soft guidance ("should rarely
      // reach 1 or 2") isn't a guarantee. This makes it one: the Sales
      // Mentor still decides, but tagPrioritiesWithTargetAccountSignal
      // below clamps whatever it returns to never beat this rule's value.
      const ceilingRule = ruleById.job_signal_ceiling;
      toScore.push(ceilingRule.enabled
        ? { ...lead, targetAccountSignal: match, targetAccountCeiling: ceilingRule.value }
        : { ...lead, targetAccountSignal: match });
      continue;
    }

    if (lead.type !== "job") {
      // Post-lead generic rule engine (2026-09-16, see
      // getPostPrioritizationRules/evaluatePostPrioritizationRules above) -
      // a real, named individual behind every Post is a stronger signal
      // than a Job listing, so this checks the user's own full set of
      // conditions (any workbook column, Target Contact match, Topic
      // match) instead of the fixed title-or-topic check Job leads get.
      const companyRow = companyByName.get(normalizeCompanyName(lead.company)) || null;
      const contact = withEffectiveSeniorityPriority(findTargetContactMatch(lead, contacts), seniorityLevels);
      const matchedRule = evaluatePostPrioritizationRules(postRules, {
        companyRow, hasCompanyMatch: Boolean(companyRow), contact, lead,
      });
      if (matchedRule && matchedRule.effectType === "decisive") {
        autoPriorities.push({
          key: lead.key,
          priority: matchedRule.value,
          reason: `Target Account rule "${matchedRule.name}" - automatic Priority ${matchedRule.value}.`,
        });
        continue;
      }
      const clone = { ...lead };
      // targetAccountSignal still comes from the lightweight targetAccounts
      // map (match/qualifies, computed above) - unrelated to which generic
      // rule matched, just the same AI-context tag this always carried, for
      // whatever the Sales Mentor's own prompt does with it.
      if (match) clone.targetAccountSignal = match;
      if (contact) clone.targetContactSignal = contact;
      if (matchedRule && matchedRule.effectType === "floor") clone.targetAccountFloor = matchedRule.value;
      if (matchedRule && matchedRule.effectType === "ceiling") clone.targetAccountCeiling = matchedRule.value;
      toScore.push(clone);
      continue;
    }

    // A Job lead with no match at all - every Post lead is already caught
    // by the branch above regardless of match (evaluatePostPrioritizationRules
    // itself returns null, i.e. no floor/ceiling/decisive, when nothing
    // matches), so only a matchless Job lead ever reaches here.
    toScore.push(lead);
  }
  // Every Post lead already had findTargetContactMatch checked inline above
  // (needed there for the floor table itself) - a separate post-loop pass
  // used to do this after the fact, back when contact-matching was only a
  // soft AI-context tag never needed for a floor decision. Job leads never
  // have one (findTargetContactMatch returns null immediately for them), so
  // there's nothing left for a second pass to add.
  return { autoPriorities, toScore };
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
// targetAccountFloor - a Post lead at a matched Target Account, whether
// confidently ("qualifies") or not, is never allowed to end up worse than
// the generic Post prioritization rule engine's own computed floor
// (evaluatePostPrioritizationRules, called from partitionLeadsByTargetAccount),
// whatever the AI itself returned - and targetAccountCeiling (set on a Job
// lead with a Provisional/below-threshold match) the same way in the
// opposite direction, with either clamp stated plainly in the reason.
// Reported directly, 2026-09-16: a Target Contact match used to
// deliberately have no floor of its own, reaching the outcome only through
// the AI's own weighing - the rule engine now folds it directly into the
// floor value instead (a stronger, verified signal than the plain company
// match alone), superseding that earlier decision.
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
      const tag = `[Target Account signal: ${describeMatch(signal)}] `;
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

// --------------------------------------------------------------------------
// Lead field setters, advisor & customer-voice history
// --------------------------------------------------------------------------

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
// deletedAt (added 2026-09-16, PRD 6.19/6.20 Phase 7 follow-up): reported
// directly - a merged Discovery row needs a way to be removed if it turns
// out wrong (Phase 5 is brand new, unproven beyond its first live run), but
// per the user's own explicit choice, never a hard delete - kept forever,
// just hidden from every view, "in case we will want to undo the delete in
// the future." Lives here (extras), not on the workbook row itself, for the
// exact same reason nextActionDueAt does: survives a re-import untouched.
// Works identically for an imported (ChatGPT) row too, not just a
// discovered one - no reason to restrict it.
// overrides (added 2026-09-18, PRD 6.20 Phase 10 Step 3): a per-field edit
// layer for the handful of imported/Discovered columns the user can edit
// (Industry, Employees, Revenue, etc. - see ACCOUNT_EDIT_FIELDS/
// CONTACT_EDIT_FIELDS in target-accounts.js) - lives here rather than on the
// workbook row itself for the exact same re-import-durability reason as
// nextActionDueAt/deletedAt above. Only fields explicitly edited get a key;
// an absent key means "still showing the imported/Discovered value," so a
// later re-import's fresh data keeps flowing through untouched for every
// field the user never actually edited. Deliberately excludes the company
// name / contact full name themselves - those are the stable identity keys
// this whole extras store (and lead-matching, and every other join in the
// codebase) is keyed by; overriding them would silently orphan a contact's
// own chat history, due date, and every lead match still looking for the
// old name.
function emptyExtra() {
  return { mentorHistory: [], customerVoiceHistory: [], nextActionDueAt: null, deletedAt: null, overrides: {} };
}

// --------------------------------------------------------------------------
// Target account & contact extras, merges, HubSpot rows
// --------------------------------------------------------------------------

export async function getTargetAccountExtras() {
  const data = await chrome.storage.local.get(TARGET_ACCOUNT_EXTRAS_KEY);
  return data[TARGET_ACCOUNT_EXTRAS_KEY] || {};
}

export async function getTargetAccountExtra(companyKey) {
  const extras = await getTargetAccountExtras();
  // Filled in from emptyExtra: an entry can hold only some fields (team use: a status carried over on joining, a row
  // arriving from a colleague) - the chats then found no history array and the page threw (live test 1.2.1.11).
  return { ...emptyExtra(), ...(extras[companyKey] || {}) };
}

// src says where a changed override came from: "user" (a manual edit, the default) or "web" (an
// accepted web finding). It is recorded per field in the same write (1.2 build step 1, design 4.2).
// `base` (optional): the copy of `overrides` / `webFindingsDismissed` the caller started from, e.g.
// { base: { overrides: snapshot } }. Given one, only the keys the caller changed relative to it are applied onto the
// stored object, so a change another writer made meanwhile is kept (extras-merge.js). Without it the object in
// `patch` replaces the stored one whole, as before.
export async function saveTargetAccountExtra(companyKey, patch, { src = "user", base = null } = {}) { return withAccountWriteLock(() => saveTargetAccountExtraUnlocked(...arguments)); }
async function saveTargetAccountExtraUnlocked(companyKey, patch, { src = "user", base = null } = {}) {
  if (!companyKey) return;
  const extras = await getTargetAccountExtras();
  const before = extras[companyKey] || {};
  if (base && patch) {
    patch = { ...patch };
    for (const field of ["overrides", "webFindingsDismissed"]) {
      if (patch[field] && field in base) patch[field] = mergeFieldChanges(base[field], patch[field], before[field]);
    }
  }
  const next = { ...emptyExtra(), ...before, ...patch };
  if (patch && patch.overrides) next.provenance = stampOverrideProvenance(before.overrides, patch.overrides, next, src);
  extras[companyKey] = next;
  await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
}

// Merges one Target Account (dropKey) into another (keepKey) - both are normalizeCompanyName keys. Everything that
// hangs off the dropped account moves to the kept one: its contacts, initiatives, investment and source rows, its
// Post leads (re-pointed by company name), its manual status and per-contact extras. The dropped row is removed from
// the workbook and its name is kept as an alternative name of the survivor, so nothing is lost.
// A re-import replaces the workbook wholesale, so the dropped account is also soft-deleted in the extras store (keyed
// by name, which survives re-imports) - it stays hidden if the research file still carries the old row.
const MERGE_STATUS_RANK = { Contacted: 1, Responded: 2 };
const MERGE_SKIP_FILL_KEYS = new Set([
  "companyId", "company", "source", "universeOrder", "excluded", "aliases",
  "salesTeamPriority", "salesTeamPriorityScore", "salesTeamPriorityReason", "salesTeamPriorityScoredAt",
]);

// Two rows can carry the very same company name (a researched row and a LinkedIn-discovered one), so their name key is
// identical: keepId/dropId (the workbook's own companyId) then tell them apart.
// "Keep separate" decisions from Find & Merge Duplicates: pairs of accounts the user says are NOT the same company, so
// they are never proposed again. Each entry is "idA|idB" (sorted; the workbook's companyId, or the normalized name when a
// row has none).
const KEPT_SEPARATE_KEY = "keptSeparateAccountPairs";

export async function getKeptSeparatePairs() {
  const data = await chrome.storage.local.get(KEPT_SEPARATE_KEY);
  return new Set(data[KEPT_SEPARATE_KEY] || []);
}

export async function addKeptSeparatePairs(pairKeys) {
  const current = await getKeptSeparatePairs();
  for (const k of pairKeys) current.add(k);
  await chrome.storage.local.set({ [KEPT_SEPARATE_KEY]: [...current] });
}

export async function clearKeptSeparatePairs() {
  await chrome.storage.local.set({ [KEPT_SEPARATE_KEY]: [] });
}

// HubSpot import: ADDS companies and contacts SalesTeam does not have yet (matched by company name / person). Nothing
// existing is changed or removed. A contact whose company is unknown gets a minimal company row so it has a home.
export async function addHubspotRowsToWorkbook(companyRows, contactRows) { return withAccountWriteLock(() => addHubspotRowsToWorkbookUnlocked(...arguments)); }
async function addHubspotRowsToWorkbookUnlocked(companyRows, contactRows) {
  const wb = await getTargetAccountsWorkbook();
  const companies = [...(wb.companies || [])];
  const contacts = [...(wb.contacts || [])];
  const byKey = new Map(companies.map((c) => [normalizeCompanyName(c.company), c]));
  const counts = { companiesAdded: 0, companiesAlreadyHad: 0, companiesCreatedFromContacts: 0, contactsAdded: 0, contactsAlreadyHad: 0 };
  for (const row of companyRows) {
    const key = normalizeCompanyName(row.company);
    if (!key) continue;
    if (byKey.has(key)) { counts.companiesAlreadyHad++; continue; }
    companies.push(row);
    byKey.set(key, row);
    counts.companiesAdded++;
  }
  const contactKeys = new Set(contacts.map((c) => contactKeyFor(c.company, c.fullName)));
  let created = 0;
  for (const row of contactRows) {
    const companyKey = normalizeCompanyName(row.company);
    if (!companyKey) continue;
    let company = byKey.get(companyKey);
    if (!company) {
      created++;
      company = { companyId: `HS-c-${Date.now()}-${created}`, company: row.company, researchStatus: "Created from a HubSpot contact", source: "HubSpot" };
      companies.push(company);
      byKey.set(companyKey, company);
      counts.companiesCreatedFromContacts++;
    }
    const key = contactKeyFor(company.company, row.fullName);
    if (!key || contactKeys.has(key)) { counts.contactsAlreadyHad++; continue; }
    contactKeys.add(key);
    contacts.push({ ...row, company: company.company, companyId: company.companyId });
    counts.contactsAdded++;
  }
  if (counts.companiesAdded > 0 || counts.companiesCreatedFromContacts > 0 || counts.contactsAdded > 0) {
    await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...wb, companies, contacts } });
  }
  return counts;
}

// Initiatives found by the web research are added to the account's Initiatives list (same sheet as the research workbook's
// initiatives, so they appear in the account view and in exports). A name already listed for the company is not added again.
export async function addWebResearchInitiatives(companyId, companyName, items) { return withAccountWriteLock(() => addWebResearchInitiativesUnlocked(...arguments)); }
async function addWebResearchInitiativesUnlocked(companyId, companyName, items) {
  const wb = await getTargetAccountsWorkbook();
  const existing = wb.aiInitiatives || [];
  const have = new Set(existing.filter((i) => i.companyId === companyId).map((i) => String(i.initiativeName || "").trim().toLowerCase()));
  const today = new Date().toISOString().slice(0, 10);
  const added = [];
  for (const item of items || []) {
    const name = String(item?.name || "").trim();
    if (!name || have.has(name.toLowerCase())) continue;
    have.add(name.toLowerCase());
    added.push({
      initiativeId: `WR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${added.length + 1}`,
      companyId,
      company: companyName,
      initiativeName: name,
      description: item.description || null,
      status: item.status || null,
      announcedDate: item.date || null,
      stage: item.stage || null, // 1.2.1 web lane: one of INITIATIVE_STAGES (web-research-apply.js)
      sourceUrl: item.sourceUrl || null,
      lastVerified: today,
      evidenceQuality: "Web research (not verified)",
      source: "Web research",
    });
  }
  if (added.length > 0) await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...wb, aiInitiatives: [...existing, ...added] } });
  return added.length;
}

export async function mergeTargetAccounts(keepKey, dropKey, { keepId = null, dropId = null } = {}) { return withAccountWriteLock(() => mergeTargetAccountsUnlocked(...arguments)); }
async function mergeTargetAccountsUnlocked(keepKey, dropKey, { keepId = null, dropId = null } = {}) {
  const sameKey = keepKey === dropKey;
  if (!keepKey || !dropKey || (sameKey && (!keepId || !dropId || keepId === dropId))) throw new Error("Pick two different accounts to merge.");
  const workbook = await getTargetAccountsWorkbook();
  const companies = workbook.companies || [];
  const keep = companies.find((c) => normalizeCompanyName(c.company) === keepKey && (!keepId || c.companyId === keepId));
  const drop = companies.find((c) => normalizeCompanyName(c.company) === dropKey && (!dropId || c.companyId === dropId) && c !== keep);
  if (!keep || !drop) throw new Error("One of the accounts could not be found.");
  const sameRowId = Boolean(keep.companyId) && keep.companyId === drop.companyId;

  const isDropRow = (row) =>
    (!sameRowId && drop.companyId && row.companyId === drop.companyId) ||
    (!sameKey && row.company && normalizeCompanyName(row.company) === dropKey);
  const moveToKeep = (row) => ({
    ...row,
    ...(row.company !== undefined ? { company: keep.company } : {}),
    ...(keep.companyId ? { companyId: keep.companyId } : {}),
  });

  // Contacts: moved, and a person who is already on the kept account is not added twice.
  const keptContactKeys = new Set((workbook.contacts || [])
    .filter((c) => !isDropRow(c))
    .filter((c) => (keep.companyId ? c.companyId === keep.companyId : normalizeCompanyName(c.company) === keepKey))
    .map((c) => contactKeyFor(keep.company, c.fullName)));
  const movedContactKeys = []; // { oldKey, newKey }
  const contacts = [];
  let contactsMoved = 0;
  let contactsDuplicate = 0;
  for (const c of workbook.contacts || []) {
    if (!isDropRow(c)) { contacts.push(c); continue; }
    const oldKey = contactKeyFor(c.company, c.fullName);
    const newKey = contactKeyFor(keep.company, c.fullName);
    if (newKey && keptContactKeys.has(newKey)) { contactsDuplicate++; if (oldKey) movedContactKeys.push({ oldKey, newKey }); continue; }
    if (newKey) keptContactKeys.add(newKey);
    if (oldKey && newKey) movedContactKeys.push({ oldKey, newKey });
    contacts.push(moveToKeep(c));
    contactsMoved++;
  }

  const relinkSheet = (rows) => (rows || []).map((r) => (isDropRow(r) ? moveToKeep(r) : r));
  const countMoved = (rows) => (rows || []).filter(isDropRow).length;
  const initiativesMoved = countMoved(workbook.aiInitiatives);
  const sourcesMoved = countMoved(workbook.sources);

  // Survivor: fill blanks from the dropped row, and keep the dropped name/aliases.
  const merged = { ...keep };
  for (const [k, v] of Object.entries(drop)) {
    if (MERGE_SKIP_FILL_KEYS.has(k)) continue;
    const empty = (x) => x === undefined || x === null || x === "" || (Array.isArray(x) && x.length === 0);
    if (empty(merged[k]) && !empty(v)) merged[k] = v;
  }
  const aliasSet = new Set([...(keep.aliases || []), ...(drop.aliases || []), drop.company].filter(Boolean));
  aliasSet.delete(keep.company);
  merged.aliases = [...aliasSet];

  const newCompanies = companies.filter((c) => c !== drop).map((c) => (c === keep ? merged : c));
  await chrome.storage.local.set({
    [TARGET_ACCOUNTS_WORKBOOK_KEY]: {
      ...workbook,
      companies: newCompanies,
      contacts,
      aiInitiatives: relinkSheet(workbook.aiInitiatives),
      aiInvestment: relinkSheet(workbook.aiInvestment),
      sources: relinkSheet(workbook.sources),
    },
  });

  // Account extras: highest manual status wins, chats are combined, the dropped name becomes an alternative name.
  const accountExtras = await getTargetAccountExtras();
  const keepExtra = { ...emptyExtra(), ...(accountExtras[keepKey] || {}) };
  const dropExtra = sameKey ? emptyExtra() : { ...emptyExtra(), ...(accountExtras[dropKey] || {}) };
  const rank = (s) => MERGE_STATUS_RANK[s] || 0;
  if (rank(dropExtra.manualStatus) > rank(keepExtra.manualStatus)) {
    keepExtra.manualStatus = dropExtra.manualStatus;
    keepExtra.manualStatusAt = dropExtra.manualStatusAt || Date.now();
  }
  keepExtra.mentorHistory = [...(keepExtra.mentorHistory || []), ...(dropExtra.mentorHistory || [])];
  keepExtra.customerVoiceHistory = [...(keepExtra.customerVoiceHistory || []), ...(dropExtra.customerVoiceHistory || [])];
  if (dropExtra.nextActionDueAt && (!keepExtra.nextActionDueAt || dropExtra.nextActionDueAt < keepExtra.nextActionDueAt)) {
    keepExtra.nextActionDueAt = dropExtra.nextActionDueAt;
  }
  const currentAlt = keepExtra.overrides?.alternativeCompanyName;
  const altList = Array.isArray(currentAlt) ? currentAlt : (currentAlt ? [currentAlt] : (Array.isArray(keep.alternativeCompanyName) ? keep.alternativeCompanyName : (keep.alternativeCompanyName ? [keep.alternativeCompanyName] : [])));
  const altSet = new Set([...altList, drop.company].filter((n) => n && n !== keep.company));
  keepExtra.overrides = { ...(keepExtra.overrides || {}), alternativeCompanyName: [...altSet] };
  keepExtra.deletedAt = null;
  accountExtras[keepKey] = keepExtra;
  // Same name key = same extras entry: nothing to hide, or the surviving account would disappear with it.
  if (!sameKey) accountExtras[dropKey] = { ...dropExtra, deletedAt: Date.now(), mergedInto: keepKey };
  await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: accountExtras });

  // Contact extras follow each contact to its new key (status, chats, edits).
  if (movedContactKeys.length > 0) {
    const contactExtras = await getTargetContactExtras();
    for (const { oldKey, newKey } of movedContactKeys) {
      if (oldKey === newKey) continue;
      const from = contactExtras[oldKey];
      if (!from) continue;
      const to = contactExtras[newKey];
      if (!to) contactExtras[newKey] = from;
      else if (rank(from.manualStatus) > rank(to.manualStatus)) contactExtras[newKey] = { ...to, manualStatus: from.manualStatus, manualStatusAt: from.manualStatusAt };
      delete contactExtras[oldKey];
    }
    await chrome.storage.local.set({ [TARGET_CONTACT_EXTRAS_KEY]: contactExtras });
  }

  // Post leads are tied to an account by company name.
  const results = await getResults();
  let leadsMoved = 0;
  for (const lead of Object.values(results)) {
    if (!sameKey && lead.company && normalizeCompanyName(lead.company) === dropKey) { lead.company = keep.company; leadsMoved++; }
  }
  if (leadsMoved > 0) await saveResults(results);

  return { keepName: keep.company, dropName: drop.company, contactsMoved, contactsDuplicate, initiativesMoved, sourcesMoved, leadsMoved };
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
  return { ...emptyExtra(), ...(extras[contactKey] || {}) }; // filled in, as getTargetAccountExtra
}

export async function saveTargetContactExtra(contactKey, patch) {
  if (!contactKey) return;
  const extras = await getTargetContactExtras();
  extras[contactKey] = { ...emptyExtra(), ...(extras[contactKey] || {}), ...patch };
  await chrome.storage.local.set({ [TARGET_CONTACT_EXTRAS_KEY]: extras });
}

// --------------------------------------------------------------------------
// Bulk edit of account/contact extras (2026-09-22)
// --------------------------------------------------------------------------

// The Target Accounts / Contacts tables' "Bulk edit" (checkbox selection, then one change applied to
// every selected row). Same reasoning as bulkUpdateLeadStatus above: saveTargetAccountExtra re-reads
// and rewrites the WHOLE extras map per call, so looping it over a few hundred selected rows is a few
// hundred full read-modify-writes. This is one read, every patch, one write.
//
// patchByKey is { extrasKey: patch } and the CALLER resolves each row's patch, because `overrides` is a
// nested object: a blind `{ ...before, overrides: {...} }` would replace the whole overrides map and
// throw away everything a web research autofilled into it. The page merges (or deletes) per row and
// hands the finished object here. Clearing an override means OMITTING the key, not setting it null -
// rawValue() treats a present-but-null override as a real empty value and hides the row's own data.
// One undo record PER KIND of bulk change, not one shared between them. They used to share a
// single key, which meant a routine Bulk edit silently destroyed the ability to undo an automatic
// web-findings resolve that had touched hundreds of accounts - the undo was still on screen and
// would simply put back the wrong thing, or nothing. Each slot holds one level, independently.
//
// Slot names are looked up in this map rather than passed through as storage keys, so a caller can
// never invent a key and quietly write its undo record somewhere nothing will ever read it.
export const EXTRAS_UNDO_SLOTS = {
  bulkEdit: "lastBulkExtrasChange",
  webFindings: "lastWebFindingsArbitrationChange",
};

const LAST_BULK_EXTRAS_CHANGE_KEY = EXTRAS_UNDO_SLOTS.bulkEdit;

function extrasUndoKey(slot) {
  const key = EXTRAS_UNDO_SLOTS[slot];
  if (!key) throw new Error(`Unknown extras undo slot "${slot}"`);
  return key;
}

export async function bulkPatchExtras(scope, patchByKey, slot = "bulkEdit") { return withAccountWriteLock(() => bulkPatchExtrasUnlocked(...arguments)); }
async function bulkPatchExtrasUnlocked(scope, patchByKey, slot = "bulkEdit") {
  const isAccounts = scope === "accounts";
  const storageKey = isAccounts ? TARGET_ACCOUNT_EXTRAS_KEY : TARGET_CONTACT_EXTRAS_KEY;
  const extras = isAccounts ? await getTargetAccountExtras() : await getTargetContactExtras();
  const previous = {};
  let changed = 0;
  for (const [key, patch] of Object.entries(patchByKey || {})) {
    if (!key || !patch) continue;
    const before = extras[key] || {};
    // Only the fields this patch actually touches are snapshotted, so an undo puts those back and
    // leaves everything else on the record (web research, mentor history) exactly as it is now.
    previous[key] = Object.fromEntries(
      Object.keys(patch).map((f) => [f, before[f] === undefined ? null : before[f]])
    );
    extras[key] = { ...emptyExtra(), ...before, ...patch };
    // Provenance is not snapshotted for undo: an undone value no longer matches the entry's `v`, so
    // readiness ignores the stale entry and derives the field again (readiness.applicableProvenance).
    if (isAccounts && patch.overrides) {
      extras[key].provenance = stampOverrideProvenance(before.overrides, patch.overrides, extras[key], slot === "webFindings" ? "web" : "user");
    }
    changed++;
  }
  if (changed === 0) return 0;
  await chrome.storage.local.set({
    [storageKey]: extras,
    [extrasUndoKey(slot)]: { timestamp: Date.now(), scope, previous },
  });
  return changed;
}

export async function getLastBulkExtrasChange(slot = "bulkEdit") {
  const key = extrasUndoKey(slot);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

// One level of undo, matching "Undo last Bulk change" on the Leads Dashboard - not a full history.
// Clears the record afterwards so a second click has nothing left to do.
export async function undoLastBulkExtrasChange(slot = "bulkEdit") { return withAccountWriteLock(() => undoLastBulkExtrasChangeUnlocked(...arguments)); }
async function undoLastBulkExtrasChangeUnlocked(slot = "bulkEdit") {
  const record = await getLastBulkExtrasChange(slot);
  if (!record) return 0;
  const isAccounts = record.scope === "accounts";
  const storageKey = isAccounts ? TARGET_ACCOUNT_EXTRAS_KEY : TARGET_CONTACT_EXTRAS_KEY;
  const extras = isAccounts ? await getTargetAccountExtras() : await getTargetContactExtras();
  let restored = 0;
  for (const [key, prev] of Object.entries(record.previous || {})) {
    if (!extras[key]) continue;
    // A row that had no overrides at all before is restored to {} rather than null - emptyExtra()'s
    // own shape - so later code can keep reading extra.overrides without a null guard.
    const revert = Object.fromEntries(
      Object.entries(prev).map(([f, v]) => [f, v === null && f === "overrides" ? {} : v])
    );
    extras[key] = { ...emptyExtra(), ...extras[key], ...revert };
    restored++;
  }
  if (restored > 0) await chrome.storage.local.set({ [storageKey]: extras });
  await chrome.storage.local.remove(extrasUndoKey(slot));
  return restored;
}

// --------------------------------------------------------------------------
// Web findings - automatic arbitration (2026-09-22)
// --------------------------------------------------------------------------

// The rules, tolerance and source preference behind "Resolve findings automatically" on the Target
// Accounts page. Stored as a flat patch over DEFAULT_ARBITRATION_SETTINGS (web-findings-arbitration.js,
// which holds the defaults and the logic and knows nothing about storage), so a rule added later
// arrives switched on for everyone without a migration.
const WEB_FINDINGS_ARBITRATION_KEY = "webFindingsArbitration";

export async function getWebFindingsArbitration() {
  const data = await chrome.storage.local.get(WEB_FINDINGS_ARBITRATION_KEY);
  const saved = data[WEB_FINDINGS_ARBITRATION_KEY] || {};
  const savedIllogical = { ...(saved.illogical || {}) };
  // 1.2.0.59: the old default 10,000,000 saved with the Settings card is the old default, not a choice -
  // it threw out real commodity-trader revenue (Gunvor, 90 million per employee).
  if (savedIllogical.revPerEmployeeMax === 10000000) delete savedIllogical.revPerEmployeeMax;
  return {
    ...DEFAULT_ARBITRATION_SETTINGS,
    ...saved,
    illogical: { ...DEFAULT_ARBITRATION_SETTINGS.illogical, ...savedIllogical },
  };
}

// Which currency every revenue figure is expressed in once it has been cleaned up, and the rates
// used to get there. Deliberately basic: a static, dated table the user can correct by hand. Kept
// apart from the arbitration settings because it applies to far more than arbitration - anything
// that reads or compares a revenue figure goes through it.
const REVENUE_NORMALIZATION_KEY = "revenueNormalization";

export async function getRevenueNormalization() {
  const data = await chrome.storage.local.get(REVENUE_NORMALIZATION_KEY);
  const saved = data[REVENUE_NORMALIZATION_KEY] || {};
  return {
    targetCurrency: saved.targetCurrency || DEFAULT_EXCHANGE_RATES.base,
    asOf: saved.asOf || DEFAULT_EXCHANGE_RATES.asOf,
    rates: { ...DEFAULT_EXCHANGE_RATES.rates, ...(saved.rates || {}) },
  };
}

export async function saveRevenueNormalization(patch) {
  const current = await getRevenueNormalization();
  const next = { ...current, ...patch, rates: { ...current.rates, ...(patch?.rates || {}) } };
  await chrome.storage.local.set({ [REVENUE_NORMALIZATION_KEY]: next });
  return next;
}

export async function saveWebFindingsArbitration(patch) {
  const current = await getWebFindingsArbitration();
  const next = {
    ...current,
    ...patch,
    illogical: { ...current.illogical, ...(patch?.illogical || {}) },
  };
  await chrome.storage.local.set({ [WEB_FINDINGS_ARBITRATION_KEY]: next });
  return next;
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

// --------------------------------------------------------------------------
// Account views, readiness and provenance (1.2 data pipeline, build step 1)
// --------------------------------------------------------------------------

// DATA_PIPELINE_DESIGN.md 2.4: an account's data lives in three stores (targetAccounts map, workbook
// row, extras) that every selector used to join for itself, and the joins had drifted apart. This is
// the one join. It returns one flat view per live workbook company - overrides applied, contacts
// attached, deleted/excluded flagged - in the shape readiness.js's assessAccount expects. Anything
// that decides which accounts to work on reads accounts through here.

// The fields whose origin is recorded per value (design 4.1). An override of one of these is stamped
// with its source when it is written; see stampOverrideProvenance.
const PROVENANCE_FIELDS = ["globalHqCountry", "globalEmployees", "swissEmployees", "industry"];

// Records where each changed override came from, in the same write as the value (design 4.2).
// src "web" is an accepted web finding: since 1.2.1 cited only when the research gave THAT value a url of
// its own, which becomes the provenance's link (onboarding design 5.3; a research stored before 1.2.1
// keeps the old rule, cited when it had any source). Anything else is a manual edit, which D2 counts as
// verified from the moment it was typed.
function stampOverrideProvenance(prevOverrides, nextOverrides, extra, src) {
  const provenance = { ...(extra.provenance || {}) };
  const now = Date.now();
  for (const field of PROVENANCE_FIELDS) {
    const value = nextOverrides?.[field];
    if (value === undefined || value === null || value === "") continue;
    if (provenanceValueKey(value) === provenanceValueKey(prevOverrides?.[field])) continue;
    if (src === "web") {
      const research = extra.webResearch || {};
      const c = webCitationFor(research.data, research.sources, field, value);
      provenance[field] = { src: "web", at: research.at || now, cited: Boolean(c && c.cited), ...(c && c.link ? { link: c.link } : {}), v: value };
    } else {
      provenance[field] = { src: "user", at: now, v: value };
    }
  }
  return provenance;
}

// The website a web research found for an account, when the research stands behind it: a url of its own
// (1.2.1 format), or any source at all (a research stored before 1.2.1).
function citedResearchWebsite(research) {
  const raw = research && research.data ? research.data.website : null;
  if (!raw) return null;
  const value = findingValue(raw);
  if (!value) return null;
  if (isCitedValue(raw)) return findingUrl(raw) ? String(value).trim() : null;
  return (research.sources || []).length > 0 ? String(raw).trim() : null;
}

// Builds the views. With persistDerived (the default), provenance that had to be derived from
// what is already stored (design 4.3) is written back once, so the next read finds it stored and the
// guess is never made again for that value.
export async function getAccountViews({ persistDerived = true } = {}) {
  const data = await chrome.storage.local.get([TARGET_ACCOUNTS_WORKBOOK_IMPORTED_AT_KEY, TARGET_ACCOUNTS_IMPORTED_AT_KEY]);
  const [map, workbook, extras, contactExtras, exclusions, contactProfile] = await Promise.all([
    getTargetAccounts(), getTargetAccountsWorkbook(), getTargetAccountExtras(), getTargetContactExtras(),
    getCompanyExclusions(), getTargetContactProfile(),
  ]);
  const importedAt = data[TARGET_ACCOUNTS_WORKBOOK_IMPORTED_AT_KEY] || data[TARGET_ACCOUNTS_IMPORTED_AT_KEY] || null;
  const exclusionMatcher = await getExclusionMatcher();
  const seniorityLevels = contactProfile.seniorityLevels || [];
  const now = Date.now();

  const contactsByCompanyId = new Map();
  for (const ct of workbook.contacts || []) {
    if (!ct.companyId) continue;
    const ctKey = contactKeyFor(ct.company, ct.fullName);
    if (contactExtras[ctKey]?.deletedAt) continue;
    if (!contactsByCompanyId.has(ct.companyId)) contactsByCompanyId.set(ct.companyId, []);
    contactsByCompanyId.get(ct.companyId).push(ct);
  }

  // Excluded by NAME, not per row - the same rule the Target Accounts table applies (loadWorkbook): when
  // two rows share a name (a researched row and a Discovered one) and either is excluded, both are. Per
  // row, the pie counted 541 accounts against the table's 540.
  const excludedKeys = new Set(
    (workbook.companies || []).filter((c) => c.company && isCompanyRowExcluded(c, exclusionMatcher)).map((c) => normalizeCompanyName(c.company))
  );
  const views = [];
  const derived = {};   // key -> { field: provenance } still to be written back
  for (const row of workbook.companies || []) {
    if (!row.company || !row.companyId) continue;
    const key = normalizeCompanyName(row.company);
    const extra = extras[key] || {};
    const ov = extra.overrides || {};
    const mapEntry = map[key];
    const view = {
      key,
      companyId: row.companyId,
      company: row.company,
      source: row.source || "Imported",
      linkedinCompanyId: mapEntry?.linkedinCompanyId || row.linkedinCompanyId || null,
      linkedinLink: ov.linkedinLink || row.linkedinLink || mapEntry?.linkedinLink || null,
      salesTeamPriority: ov.salesTeamPriority || row.salesTeamPriority || null,
      evidenceStatus: row.evidenceStatus || null,
      lastVerified: row.lastVerified ?? null,
      deleted: Boolean(extra.deletedAt),
      excluded: excludedKeys.has(key),
      importedAt,
      provenance: extra.provenance || {},
      // For the pipeline (build step 2): the resolver's name search, and the per-account job state.
      officialName: row.officialName || null,
      alternativeName: row.alternativeName || null,
      alternativeNames: accountAlternativeNames(row.company, row.officialName, [
        row.alternativeName, mapEntry?.alternativeName, ov.alternativeCompanyName ?? row.alternativeCompanyName,
      ]),
      // Step 4 (R12.5.2): what the pipeline was given for this account. When it changes (a re-import, an
      // edited link, name or Alt. name, a rules change), earlier failed attempts no longer count.
      inputsKey: accountInputsKey([importedAt, row.company, row.officialName, row.alternativeName, ov.linkedinLink,
        JSON.stringify(ov.alternativeCompanyName ?? null)]),
      universeOrder: row.universeOrder ?? null,
      // Build step 5: when the last FULL web research ran. A short one (only some topics) does not count.
      // A web-lane research (1.2.1) asks only for what is missing, so it counts as a full one.
      webFullResearchAt: extra.webResearch && (!extra.webResearch.topics || extra.webResearch.by === "lane") ? extra.webResearch.at || null : null,
      // 1.2.1 step 1 (onboarding design 6.1): what identifies the account without LinkedIn - its website
      // (a "Web" row's own, an edit, or one its web research cited) and the source it was found in.
      website: ov.website || row.website || citedResearchWebsite(extra.webResearch) || null,
      primarySourceUrl: row.primarySourceUrl || null,
      // The user gave the LinkedIn lookup something new to try (pipeline-plan.js userRetryFirst).
      userIdentityEdit: Boolean(ov.linkedinLink) || [].concat(ov.alternativeCompanyName ?? []).some((n) => String(n || "").trim() !== ""),
    };
    view.pipeline = effectivePipeline(extra.pipeline, view.inputsKey);
    for (const field of PROVENANCE_FIELDS) view[field] = ov[field] ?? row[field] ?? null;

    // A contact is relevant when it is at one of the wizard's seniority levels (R3.6). The research
    // workbook's own Seniority column decides when it names a level ("Specialist" names none, and then
    // the contact is not relevant); only a contact without that column falls back to the job-title
    // guess, which misses titles like "Chief Digital & Information Officer". With no levels configured
    // there is nothing to match against, so any contact counts rather than none.
    const discoveryAt = extra.contactDiscoveryAttemptedAt || importedAt;
    const selectedLevelIds = new Set(seniorityLevels.map((l) => (typeof l === "string" ? l : l.id)));
    // The level itself (1.2.1 step 4, design 7.2): the pipeline looks up the most senior contact first.
    const levelOf = (ct) => {
      if (ct.seniorityLevel) return ct.seniorityLevel;   // Discovered: already matched against these levels
      if (ct.seniority != null && String(ct.seniority).trim() !== "") {
        const levelId = seniorityLevelFromLabel(ct.seniority);
        return levelId && selectedLevelIds.has(levelId) ? levelId : null;
      }
      const level = classifyJobTitleSeniority(ct.jobTitle, seniorityLevels);
      return level ? level.id : null;
    };
    view.contacts = (contactsByCompanyId.get(row.companyId) || []).map((ct) => ({
      contactKey: contactKeyFor(ct.company, ct.fullName),
      fullName: ct.fullName,
      relevant: seniorityLevels.length === 0 || Boolean(levelOf(ct)),
      level: levelOf(ct),
      source: ct.source || null,
      linkedinUrl: ct.lastVerified2 || null,
      verifiedAt: toEpochMs(ct.lastVerified) || (ct.source === "Discovered" ? discoveryAt : null),
    }));

    const facts = {
      overridden: Object.fromEntries(PROVENANCE_FIELDS.map((f) => [f, ov[f] !== undefined && ov[f] !== null && ov[f] !== ""])),
      webResearch: extra.webResearch || null,
      // Per field: does the web research stand behind the value in place, and with which url (design 5.3).
      webCitations: extra.webResearch && extra.webResearch.data
        ? Object.fromEntries(PROVENANCE_FIELDS.map((f) => [f, webCitationFor(extra.webResearch.data, extra.webResearch.sources, f, view[f])]))
        : null,
      linkedinResolveAttemptedAt: mapEntry?.linkedinResolveAttemptedAt || null,
      sizeFetchAttemptedAt: extra.sizeFetchAttemptedAt || null,
      employeeCountText: row.employeeCountText || null,
    };
    for (const field of ["linkedinCompanyId", ...PROVENANCE_FIELDS]) {
      if (applicableProvenance(view, field)) continue;
      const p = deriveProvenance(view, field, facts, now);
      if (!p) continue;
      view.provenance = { ...view.provenance, [field]: p };
      (derived[key] = derived[key] || {})[field] = p;
    }
    // Build step 5: a cited web research that found the SAME value confirms it. An agreeing value is
    // never a finding, so without this a weakly evidenced workbook value stayed unverified however
    // often the web agreed. Only upgrades: a good source that is at least as recent is left alone.
    const research = extra.webResearch;
    // Since 1.2.1 a value confirms only when the research cited a url for THAT value (design 5.3).
    if (research && research.at && research.data) {
      for (const field of researchConfirms(row, ov, research.data, null, WEB_CONFIRM_FIELDS)) {
        if (!isPresent(view[field])) continue;
        const citation = webCitationFor(research.data, research.sources, field, view[field]);
        if (!citation || !citation.cited) continue;
        const cur = applicableProvenance(view, field);
        if (cur && isGoodSource(cur) && (cur.at || 0) >= research.at) continue;
        const p = { src: "web", at: research.at, cited: true, ...(citation.link ? { link: citation.link } : {}), v: view[field], confirmed: true };
        view.provenance = { ...view.provenance, [field]: p };
        (derived[key] = derived[key] || {})[field] = p;
      }
    }
    view.lacking = lackingReason(view, view.pipeline);
    views.push(view);
  }

  if (persistDerived && Object.keys(derived).length > 0) {
    // Re-read right before writing and touch only provenance, so a write that landed in between
    // (a web research, an edit) is never overwritten by this snapshot. Only this re-read-and-write holds
    // the account write lock - the views above are a plain read.
    await withAccountWriteLock(async () => {
      const fresh = await getTargetAccountExtras();
      for (const [key, fields] of Object.entries(derived)) {
        const cur = fresh[key] || emptyExtra();
        fresh[key] = { ...cur, provenance: { ...(cur.provenance || {}), ...fields } };
      }
      await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: fresh });
    });
  }
  return views;
}

// The fields a web research can confirm for readiness (build step 5): the headcount and the HQ country.
const WEB_CONFIRM_FIELDS = ["globalEmployees", "swissEmployees", "globalHqCountry"];

function isPresent(v) {
  return v !== null && v !== undefined && v !== "";
}

function localDayString(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- Web research in the pipeline (build step 5, DATA_PIPELINE_DESIGN.md section 6, W1-W8) ----

// W5: resolves the open web findings of every researched account (or only `onlyKeys`) with the same
// rules as Target Accounts > Resolve findings automatically, and writes the result in one go. What the
// rules cannot settle stays open and so appears in Decisions (V6). Never touches that button's Undo:
// every settled finding is in the Activity Log, and a dismissed one is kept, so it can be taken back
// from the account's Review findings dialog. Returns { accounts, applied, dismissed, review }.
export async function autoResolveWebFindings({ onlyKeys = null } = {}) {
  const [workbook, extras, config, savedSettings, money] = await Promise.all([
    getTargetAccountsWorkbook(), getTargetAccountExtras(), getTargetUniverseConfig(), getWebFindingsArbitration(), getRevenueNormalization(),
  ]);
  // 1.2.0.51: "Ask me about every difference" (Setup's Finish, Settings > How to handle research findings) - only
  // empty fields are still filled, and a web value that cannot be right is still thrown away; every other rule that
  // would decide for the user is off, so each real difference goes to Decisions.
  const settings = savedSettings.askEveryDifference
    ? Object.fromEntries(Object.entries(savedSettings).map(([k, v]) =>
      [k, /^rule\d+/.test(k) && k !== "rule1EmptyApply" && k !== "rule2IllogicalReview" ? false : v]))
    : savedSettings;
  const only = onlyKeys ? new Set(onlyKeys) : null;
  const moneySettings = revenueMoneySettings(money);
  const locationTier = (country) => resolveLocationPriority(country, config.locationPriorities);
  const contactCounts = new Map();
  for (const c of workbook.contacts || []) if (c.companyId) contactCounts.set(c.companyId, (contactCounts.get(c.companyId) || 0) + 1);
  const patches = {};
  const entries = [];
  const out = { accounts: 0, applied: 0, dismissed: 0, review: 0 };
  const seen = new Set();
  for (const company of workbook.companies || []) {
    if (!company.company) continue;
    const key = normalizeCompanyName(company.company);
    if (seen.has(key) || (only && !only.has(key))) continue;
    seen.add(key);
    const extra = extras[key];
    if (!extra || !extra.webResearch || extra.deletedAt) continue;
    const data = extra.webResearch.data;
    const proposals = computeFindingProposals(company, extra.overrides, data, moneySettings)
      .map((p) => ({ ...p, dismissed: isDismissedWebFinding(extra.webFindingsDismissed, p) }));
    if (!proposals.some((p) => !p.dismissed)) continue;
    const ctx = arbitrationContext(company, extra, { buckets: SIZE_PRIORITY_BUCKETS, locationTier, contactCount: contactCounts.get(company.companyId) || 0 });
    const { decisions, patch } = arbitrateAccount({ proposals, extra, ctx, settings, data });
    for (const d of decisions) {
      if (d.action === "review") { out.review++; continue; }
      if (d.action === "apply") out.applied++; else out.dismissed++;
      const outcome = d.action === "apply"
        ? `took the web value ${d.proposal.found}`
        : `kept the current value ${d.proposal.current === null ? "(empty)" : d.proposal.current}`;
      entries.push({
        actor: "extension",
        action: "web_finding_auto_resolved",
        label: `${company.company} - ${d.proposal.label}: ${outcome} (automatic, rule ${d.rule}: ${d.why})`,
        prevValue: d.proposal.current === undefined ? null : d.proposal.current,
        newValue: d.action === "apply" ? d.proposal.found : d.proposal.current,
        relatedCompanyKey: key,
      });
    }
    if (patch) { patches[key] = patch; out.accounts++; }
  }
  if (Object.keys(patches).length > 0) {
    // Re-read right before writing, under the account write lock, so a write that landed while the rules
    // ran is not lost.
    await withAccountWriteLock(async () => {
      const fresh = await getTargetAccountExtras();
      for (const [key, patch] of Object.entries(patches)) {
        const before = fresh[key] || emptyExtra();
        const next = { ...emptyExtra(), ...before, ...patch };
        if (patch.overrides) next.provenance = stampOverrideProvenance(before.overrides, patch.overrides, next, "web");
        fresh[key] = next;
      }
      await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: fresh });
    });
    await appendActivityLogBatch(entries);
  }
  return out;
}

// Stores one research the pipeline ran, the same way the bulk research does: the briefing, its
// initiatives, every finding for an EMPTY field taken at once (W5: "empty fields are always filled"),
// then the automatic resolve for this account. `topics` marks a short research (only some topics), which
// does not count as the account's full research. Returns { filled, initiatives, applied, dismissed, review }.
export async function applyPipelineWebResearch(key, result, { topics = null } = {}) {
  const workbook = await getTargetAccountsWorkbook();
  const company = (workbook.companies || []).find((c) => c.company && normalizeCompanyName(c.company) === key);
  if (!company) return null;
  await saveTargetAccountExtra(key, {
    webResearch: {
      text: result.text, sources: result.sources, searches: result.searches, at: Date.now(), data: result.data || null,
      stopped: result.stopped, costUsd: result.costUsd, topics: topics && topics.length ? topics : null, by: "pipeline",
    },
  });
  const initiatives = await addWebResearchInitiatives(company.companyId, company.company, result.data?.initiatives);
  return { ...(await fillEmptyAndResolve(key, company, result.data)), initiatives };
}

// W5: every finding for an EMPTY field is taken at once, then the automatic resolve for this account.
// Returns { filled, applied, dismissed, review }.
async function fillEmptyAndResolve(key, company, data) {
  const extras = await getTargetAccountExtras();
  const money = await getRevenueNormalization();
  const fresh = computeFindingProposals(company, extras[key]?.overrides, data, revenueMoneySettings(money)).filter((p) => p.state === "new");
  if (fresh.length > 0) {
    const overrides = { ...(extras[key]?.overrides || {}) };
    for (const p of fresh) overrides[p.key] = p.found;
    await saveTargetAccountExtra(key, { overrides }, { src: "web", base: { overrides: extras[key]?.overrides } });
    appendActivityLogBatch(fresh.map((p) => ({
      actor: "extension", action: "web_finding_auto_resolved",
      label: `${company.company} - ${p.label}: took the web value ${p.found} (automatic, the field was empty)`,
      prevValue: null, newValue: p.found, relatedCompanyKey: key,
    }))).catch(() => {});
  }
  const resolved = await autoResolveWebFindings({ onlyKeys: [key] });
  return { filled: fresh.length, applied: resolved.applied, dismissed: resolved.dismissed, review: resolved.review };
}

// 1.2.1 web lane (ONBOARDING_RESEARCH_DESIGN.md 5.3-5.5): stores one lane research. The research before it
// is kept one level back (webResearchPrevious), since a lane research only answers the topics it was asked;
// provenance already stamped from the earlier one stays as it is. Then, like applyPipelineWebResearch: the
// initiatives (now with their stage), every empty field filled, the automatic resolve. New in the lane:
// named people become contact rows (source "Web"), with the LinkedIn profile link a web search listed for
// them (D10 - such a contact counts towards Ready without a LinkedIn visit), a known contact without a
// profile gets the one found, and an account with no LinkedIn page gets the company page the search listed
// (the LinkedIn lane still confirms it on its first visit).
// Returns { filled, initiatives, contacts, profiles, linkedinPage, applied, dismissed, review } or null.
export async function applyWebLaneResearch(key, result, { topics = null } = {}) {
  const workbook = await getTargetAccountsWorkbook();
  const company = (workbook.companies || []).find((c) => c.company && normalizeCompanyName(c.company) === key);
  if (!company) return null;
  const data = result.data || null;
  const before = (await getTargetAccountExtras())[key] || {};
  await saveTargetAccountExtra(key, {
    webResearch: {
      text: result.text, sources: result.sources, searches: result.searches, fetches: result.fetches || 0, at: Date.now(), data,
      stopped: result.stopped, costUsd: result.costUsd, topics: topics && topics.length ? topics : null, by: "lane",
    },
    ...(before.webResearch ? { webResearchPrevious: before.webResearch } : {}),
  });
  const initiatives = await addWebResearchInitiatives(company.companyId, company.company, researchInitiatives(data));
  const out = { ...(await fillEmptyAndResolve(key, company, data)), initiatives, contacts: 0, profiles: 0, linkedinPage: null };

  // People
  const found = researchContacts(data);
  if (found.length > 0 && company.companyId) {
    const levels = ((await getTargetContactProfile()).seniorityLevels || []).filter((l) => l && typeof l === "object");
    const today = new Date().toISOString().slice(0, 10);
    const known = new Map((workbook.contacts || []).filter((ct) => ct.companyId === company.companyId)
      .map((ct) => [contactKeyFor(company.company, ct.fullName), ct]));
    const rows = [];
    // At most LANE_MAX_PEOPLE new people per research, those at a chosen seniority level first, most senior first
    // (the prompt asks for that too; 2026-10-01 a research named up to 16).
    const rankOf = (p) => {
      const level = classifyJobTitleSeniority(p.title, levels);
      const i = level ? SENIORITY_LEVELS.findIndex((l) => l.id === level.id) : -1;
      return i < 0 ? SENIORITY_LEVELS.length : i;
    };
    const ranked = found.map((p, i) => ({ p, i, r: rankOf(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
    let newPeople = 0;
    for (const p of ranked) {
      const ctKey = contactKeyFor(company.company, p.fullName);
      const existing = known.get(ctKey);
      if (existing) {
        if (p.linkedinUrl && !existing.lastVerified2 && (await setContactLinkedinProfile(ctKey, p.linkedinUrl)) !== undefined) out.profiles++;
        continue;
      }
      if (newPeople >= LANE_MAX_PEOPLE) continue;
      newPeople++;
      const level = classifyJobTitleSeniority(p.title, levels);
      rows.push({
        contactId: `WEB-${company.companyId}-${ctKey.replace(/[^a-z0-9]+/gi, "-").slice(-40)}`,
        companyId: company.companyId,
        company: company.company,
        fullName: p.fullName,
        jobTitle: p.title,
        seniorityLevel: level ? level.id : null,
        seniorityPriority: level ? level.priority ?? null : null,
        lastVerified2: p.linkedinUrl || null,
        // The day the web showed this person at this company - with a profile link, what readiness counts as verified.
        lastVerified: p.linkedinUrl ? today : null,
        primarySourceUrl: p.sourceUrl,
        source: "Web",
      });
    }
    out.contacts = await appendContactsToWorkbook(rows);
    out.profiles += rows.filter((r) => r.lastVerified2).length;
  }

  // The company's LinkedIn page, only where the account has none.
  const page = linkedinCompanyUrl(data && data.linkedinCompanyUrl);
  if (page) {
    const extras = await getTargetAccountExtras();
    const map = await getTargetAccounts();
    const ov = extras[key]?.overrides || {};
    if (!ov.linkedinLink && !company.linkedinLink && !map[key]?.linkedinLink) {
      await saveTargetAccountExtra(key, { overrides: { ...ov, linkedinLink: page } }, { src: "web", base: { overrides: extras[key]?.overrides } });
      out.linkedinPage = page;
    }
  }
  return out;
}

// ---- 1.2.1 Web Discovery (ONBOARDING_RESEARCH_DESIGN.md 4.4): companies found on listing pages become "Web" rows ----

const LAST_WEB_DISCOVERY_ADD_KEY = "lastWebDiscoveryAdd";

// Every workbook row as the discovery filter needs it (discovery-filter.js buildKnownCompanies): removed ones too.
export async function getDiscoveryKnownAccounts() {
  const [workbook, extras, map] = await Promise.all([getTargetAccountsWorkbook(), getTargetAccountExtras(), getTargetAccounts()]);
  return (workbook.companies || []).filter((r) => r && r.company).map((r) => {
    const key = normalizeCompanyName(r.company);
    const ov = extras[key]?.overrides || {};
    return {
      company: r.company, website: ov.website || r.website || null,
      linkedinCompanyId: r.linkedinCompanyId || map[key]?.linkedinCompanyId || null, deleted: Boolean(extras[key]?.deletedAt),
    };
  });
}

// rows: chosen discovery rows (discovery-filter.js cleanListingRow shape). A row whose name or website became an
// account since the filter ran is skipped. Silent tier (1.2.0 R6.2.1): the caller writes one Activity Log line;
// undoLastWebDiscovery removes them again (soft delete; the caller records them with saveLastDiscoveryAdd). Returns { added: [{ key, companyId, company }], skipped }.
// 1.2.0.62: accounts found on a web listing before 1.2.0.61 kept its "Revenue (USD millions)" figures as they
// stand (Gunvor 62,030, Nestle 89,791), and every one of them came to the user as "the current data looks wrong".
// Repairs those rows once, with the same rule the listing reader now applies (listingRevenue). Idempotent: a
// repaired figure is in plain units and passes the rule unchanged, so running it again changes nothing.
export async function repairListingRevenueInMillions() { return withAccountWriteLock(async () => {
  const workbook = await getTargetAccountsWorkbook();
  const fixed = [];
  const companies = (workbook.companies || []).map((c) => {
    if (c.source !== "Web") return c;
    const rev = parseLooseNumber(c.globalRevenue);
    const emp = parseLooseNumber(c.globalEmployees);
    const repaired = listingRevenue(rev, emp);
    if (rev === null || repaired === rev) return c;
    fixed.push(c.company);
    return { ...c, globalRevenue: repaired };
  });
  if (!fixed.length) return 0;
  await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...workbook, companies } });
  await appendActivityLog({
    actor: "system", action: "data_repair",
    label: `Revenue read from a listing in millions put into plain units for ${fixed.length} account${fixed.length === 1 ? "" : "s"}: ${fixed.join(", ")}`,
  }).catch(() => {});
  return fixed.length;
}); }

export async function addWebDiscoveredCompanies(rows, { runAt = Date.now() } = {}) { return withAccountWriteLock(() => addWebDiscoveredCompaniesUnlocked(...arguments)); }
async function addWebDiscoveredCompaniesUnlocked(rows, { runAt = Date.now() } = {}) {
  const workbook = await getTargetAccountsWorkbook();
  const extras = await getTargetAccountExtras();
  const names = new Set();
  const domains = new Set();
  const ids = new Set();
  let maxOrder = 0;
  for (const r of workbook.companies || []) {
    if (!r || !r.company) continue;
    const key = normalizeCompanyName(r.company);
    names.add(key);
    const d = websiteDomain(extras[key]?.overrides?.website || r.website || "");
    if (d) domains.add(d);
    if (r.companyId) ids.add(r.companyId);
    if (Number(r.universeOrder) > maxOrder) maxOrder = Number(r.universeOrder);
  }
  const newRows = [];
  const added = [];
  let skipped = 0;
  for (const row of rows || []) {
    const key = normalizeCompanyName(row.name || "");
    const domain = websiteDomain(row.website || "");
    const companyId = webCompanyId(row.website, row.name);
    if (!key || !companyId || names.has(key) || (domain && domains.has(domain)) || ids.has(companyId)) { skipped++; continue; }
    names.add(key);
    if (domain) domains.add(domain);
    ids.add(companyId);
    newRows.push({
      companyId, company: row.name, website: row.website || null,
      globalHqCountry: row.hqCountry || null,
      globalEmployees: row.employees ?? null,
      globalRevenue: row.revenue ?? null, revenueCurrency: row.revenue != null ? row.currency || null : null,
      industry: row.industry || null,
      companyType: row.isPublic === true ? "Publicly traded" : row.isPublic === false ? "Private" : null,
      primarySourceUrl: row.sourceUrl || null,
      researchStatus: "Found on the web",
      source: "Web",
      universeOrder: ++maxOrder,
      webDiscoveredAt: runAt,
    });
    added.push({ key, companyId, company: row.name });
  }
  if (newRows.length === 0) return { added, skipped };
  await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...workbook, companies: [...(workbook.companies || []), ...newRows] } });
  return { added, skipped };
}

// What the last "Find new accounts" run added, LinkedIn and web parts together: { at, keys, companyIds }.
export async function saveLastDiscoveryAdd(record) {
  await chrome.storage.local.set({ [LAST_WEB_DISCOVERY_ADD_KEY]: record });
}

export async function getLastWebDiscoveryAdd() {
  return (await chrome.storage.local.get(LAST_WEB_DISCOVERY_ADD_KEY))[LAST_WEB_DISCOVERY_ADD_KEY] || null;
}

// Removes (soft delete, like Remove Account) the accounts the last "Find new accounts" run added and that are still there.
export async function undoLastWebDiscovery() { return withAccountWriteLock(() => undoLastWebDiscoveryUnlocked()); }
async function undoLastWebDiscoveryUnlocked() {
  const last = await getLastWebDiscoveryAdd();
  if (!last) return 0;
  const extras = await getTargetAccountExtras();
  const at = Date.now();
  let removed = 0;
  for (const key of last.keys || []) {
    if (extras[key]?.deletedAt) continue;
    extras[key] = { ...emptyExtra(), ...(extras[key] || {}), deletedAt: at };
    removed++;
  }
  await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
  await chrome.storage.local.remove(LAST_WEB_DISCOVERY_ADD_KEY);
  return removed;
}

// ---- Writes made by the 1.2 data pipeline (build step 2, DATA_PIPELINE_DESIGN.md 5.5 and T1-T4) ----

// Merges into extras[key].pipeline - attempts per job, contacts already searched, the day last handled.
export async function savePipelineAccountState(key, patch) { return withAccountWriteLock(() => savePipelineAccountStateUnlocked(...arguments)); }
async function savePipelineAccountStateUnlocked(key, patch) {
  const extras = await getTargetAccountExtras();
  const cur = extras[key] || emptyExtra();
  extras[key] = { ...cur, pipeline: { ...(cur.pipeline || {}), ...patch } };
  await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
}

// LinkedIn's size band against the count already stored (pipeline-plan.js sizeVerdict). "confirm"
// keeps the stored count and records it as verified by LinkedIn - it is usually more precise than the
// band. "fill" and "replace" write LinkedIn's number (the band's lower bound); "replace" keeps the old
// count in the trace. The count is checked through the account's override when it has one - the value
// the table and readiness show - and a replaced override is replaced in place, so it cannot go on
// shadowing the row. Returns { kept, previous }.
export async function applyEmployeeCheck(key, { verdict, employeeCount, sizeBandText }) { return withAccountWriteLock(() => applyEmployeeCheckUnlocked(...arguments)); }
async function applyEmployeeCheckUnlocked(key, { verdict, employeeCount, sizeBandText }) {
  if (!verdict) return null;
  const [workbook, extras] = await Promise.all([getTargetAccountsWorkbook(), getTargetAccountExtras()]);
  const cur = extras[key] || emptyExtra();
  const ov = cur.overrides || {};
  const present = (v) => v !== undefined && v !== null && v !== "";
  const overridden = present(ov.globalEmployees);
  const at = Date.now();
  const bandText = sizeBandText ? `${sizeBandText} employees` : null;
  let found = false;
  let kept = null;
  let previous = null;
  const companies = (workbook.companies || []).map((c) => {
    if (found || normalizeCompanyName(c.company) !== key) return c;
    found = true;
    const current = overridden ? ov.globalEmployees : c.globalEmployees;
    if (verdict === "confirm" && present(current)) {
      kept = current;
      return { ...c, employeeCountText: c.employeeCountText || bandText };
    }
    previous = present(current) ? current : null;
    kept = employeeCount;
    return overridden ? c : { ...c, globalEmployees: employeeCount, employeeCountText: bandText };
  });
  if (!found) return null;
  const overrides = overridden && kept !== ov.globalEmployees ? { ...ov, globalEmployees: kept } : ov;
  extras[key] = {
    ...cur,
    overrides,
    provenance: {
      ...(cur.provenance || {}),
      globalEmployees: { src: "linkedin", at, v: kept, band: sizeBandText || null, ...(previous !== null ? { replaced: previous } : {}) },
    },
    sizeFetchAttemptedAt: at,
  };
  await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...workbook, companies }, [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
  return { kept, previous };
}

// T1: the profile found for a known contact, or the confirmation that a known profile still shows the
// person at the company. Written onto the workbook contact row (Contact Link = lastVerified2, dated
// lastVerified), which is what readiness reads. Returns the previous Contact Link, or undefined when
// the contact is gone.
export async function setContactLinkedinProfile(contactKey, profileUrl) { return withAccountWriteLock(() => setContactLinkedinProfileUnlocked(...arguments)); }
async function setContactLinkedinProfileUnlocked(contactKey, profileUrl) {
  const workbook = await getTargetAccountsWorkbook();
  let previous;
  const today = new Date().toISOString().slice(0, 10);
  const contacts = (workbook.contacts || []).map((ct) => {
    if (previous !== undefined || contactKeyFor(ct.company, ct.fullName) !== contactKey) return ct;
    previous = ct.lastVerified2 || null;
    return { ...ct, lastVerified2: profileUrl, lastVerified: today };
  });
  if (previous === undefined) return undefined;
  await chrome.storage.local.set({ [TARGET_ACCOUNTS_WORKBOOK_KEY]: { ...workbook, contacts } });
  return previous;
}

// 1.2.1 step 6 (design 8, R6.3-R6.4): the list measured against the user's targets - the stop rule's input and the
// coverage lines under the Target Accounts pie. `readiness`: getAccountReadiness()'s answer when the caller has it.
export async function getTargetsStatus({ readiness = null, discoveryAllowed = true } = {}) {
  const [rows, workbook, targets, stages] = await Promise.all([
    readiness ? Promise.resolve(readiness) : getAccountReadiness(), getTargetAccountsWorkbook(), getCompletionTargets(), getInitiativeStagePreference(),
  ]);
  const initiatives = new Map();
  for (const i of workbook.aiInitiatives || []) {
    if (i.companyId && initiativeCounts(i.stage, stages)) initiatives.set(i.companyId, (initiatives.get(i.companyId) || 0) + 1);
  }
  const entries = rows.map(({ view, assessment }) => ({
    state: assessment.state,
    relevantContacts: (view.contacts || []).filter((c) => c.relevant).length,
    initiatives: initiatives.get(view.companyId) || 0,
  }));
  return targetsStatus(entries, targets, { discoveryAllowed });
}

// The user's targeting settings in the shape readiness.js wants (design 3.1).
export async function getReadinessConfig() {
  const [universe, contactProfile] = await Promise.all([getTargetUniverseConfig(), getTargetContactProfile()]);
  return {
    locationPriorities: universe.locationPriorities || {},
    sizeBuckets: universe.sizeBuckets || {},
    industries: universe.industries || [],
    seniorityLevels: contactProfile.seniorityLevels || [],
  };
}

// Every live account with its assessment - what the Pipeline status pie and the Readiness column draw.
// Since step 4 an account with an item in the decision queue is "Needs your decision", and one that is
// Lacking evidence (and not kept) is "Lacking evidence".
export async function getAccountReadiness() {
  const [views, cfg] = await Promise.all([getAccountViews(), getReadinessConfig()]);
  const queue = await buildDecisionQueueShared(views);
  const decisionKeys = new Set(queue.items.filter((i) => i.kind !== "lacking_evidence").map((i) => i.accountKey));
  const now = Date.now();
  return views
    .filter((v) => !v.deleted && !v.excluded)
    .map((view) => ({
      view,
      assessment: assessAccount(view, cfg, now, {
        decision: decisionKeys.has(view.key), lacking: Boolean(view.lacking), keep: Boolean(view.pipeline && view.pipeline.keep),
      }),
    }));
}

// --------------------------------------------------------------------------
// The decision queue (1.2 build step 4, DATA_PIPELINE_DESIGN.md section 7, touch-ups V1-V8)
// --------------------------------------------------------------------------

// V1: the queue is BUILT from the data every time, never stored as a list, so it cannot go stale: settle
// a finding in the account's own Review dialog, or let new data reach a Lacking account, and its item is
// simply not built any more. Only the user's answers are stored, each where its own data lives.

// The rows duplicateGroups works on: one per live workbook company, with the LinkedIn id it carries
// itself (a Discovered row) or through the map, and whether that id was re-checked against its page.
async function duplicateRows() {
  const [workbook, map, extras] = await Promise.all([getTargetAccountsWorkbook(), getTargetAccounts(), getTargetAccountExtras()]);
  return (workbook.companies || [])
    .filter((r) => r && r.company && r.companyId && !extras[normalizeCompanyName(r.company)]?.deletedAt)
    .map((r) => {
      const key = normalizeCompanyName(r.company);
      const linkedinLink = r.linkedinLink || map[key]?.linkedinLink || null;
      const linkedinCompanyId = r.linkedinCompanyId || map[key]?.linkedinCompanyId || null;
      return {
        companyId: r.companyId, key, company: r.company, source: r.source || "Imported", universeOrder: r.universeOrder ?? null,
        linkedinCompanyId: linkedinCompanyId ? String(linkedinCompanyId) : null,
        idVerified: idVerifiedFor(extras[key]?.provenance?.linkedinCompanyId, linkedinLink, r.source),
        slug: parseLinkedinCompanySlug(linkedinLink || "") || null,
        registryId: r.zefixUid || null,
        city: extras[key]?.overrides?.globalHqCity ?? r.globalHqCity ?? null,
        country: extras[key]?.overrides?.globalHqCountry ?? r.globalHqCountry ?? null,
      };
    });
}

// V3: merges every duplicate group that is safe to merge without asking (same LinkedIn id, re-checked on
// at least one member). Returns how many rows were merged away. Called after a Discovery merge and after
// each pipeline run.
export async function settleSafeDuplicates() {
  const groups = duplicateGroups(await duplicateRows(), await getKeptSeparatePairs()).filter((g) => g.auto);
  let merged = 0;
  for (const g of groups) {
    const keep = g.members[0];
    for (const drop of g.members.slice(1)) {
      try {
        const r = await mergeTargetAccounts(keep.key, drop.key, { keepId: keep.companyId, dropId: drop.companyId });
        merged++;
        appendActivityLog({
          actor: "extension",
          action: "target_accounts_merged",
          label: `Merged duplicate "${r.dropName}" into "${r.keepName}" automatically: same LinkedIn company (${keep.linkedinCompanyId}). ${r.contactsMoved} contacts moved, ${r.contactsDuplicate} already there`,
          relatedCompanyKey: keep.key,
        }).catch(() => {});
      } catch { /* one group failing leaves the others */ }
    }
  }
  return merged;
}

// R12.6.1: a finished Discovery run is merged by itself. Matches by LinkedIn id merge silently; name-only
// matches wait in the decision queue (V2). Then the safe duplicates are settled.
export async function autoMergeDiscoveryResults() {
  const r = await mergeDiscoveredIntoWorkbook();
  const merged = await settleSafeDuplicates();
  if (r.companiesAdded > 0 || r.contactsAdded > 0 || r.nameMatchesWaiting > 0 || merged > 0) {
    appendActivityLog({
      actor: "extension",
      action: "discovered_merged_into_workbook",
      label: `Discovery results merged automatically: ${r.companiesAdded} compan${r.companiesAdded === 1 ? "y" : "ies"} and ${r.contactsAdded} contact${r.contactsAdded === 1 ? "" : "s"} added` +
        (r.nameMatchesWaiting > 0 ? `; ${r.nameMatchesWaiting} matched an account by name only and wait for your decision` : "") +
        (merged > 0 ? `; ${merged} duplicate${merged === 1 ? "" : "s"} merged` : ""),
      newValue: { ...r, duplicatesMerged: merged },
    }).catch(() => {});
  }
  return { ...r, duplicatesMerged: merged };
}

function findingValueKey(v) {
  return typeof v === "number" ? String(v) : String(v ?? "").trim().toLowerCase();
}

// The same test as the Review findings dialog (target-accounts.js isDismissedFinding): a finding turned
// down stays quiet, but a later research that finds a DIFFERENT value asks again.
function isDismissedWebFinding(dismissed, proposal) {
  if (!dismissed || !Object.prototype.hasOwnProperty.call(dismissed, proposal.key)) return false;
  const a = dismissed[proposal.key];
  const b = proposal.found;
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a), y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && x === y;
  }
  return findingValueKey(a) === findingValueKey(b);
}

function revenueMoneySettings(money) {
  return { targetCurrency: money.targetCurrency, rates: { rates: money.rates } };
}

// Builds the queue. `views` may be passed by a caller that already has them. Returns { items, count }.
async function buildDecisionQueue(views) {
  const [allViews, workbook, extras, kept, money, diff, discoveredContacts] = await Promise.all([
    views || getAccountViews({ persistDerived: false }), getTargetAccountsWorkbook(), getTargetAccountExtras(),
    getKeptSeparatePairs(), getRevenueNormalization(), computeDiscoveredMergeDiff(), getDiscoveredContacts(),
  ]);
  const live = allViews.filter((v) => !v.deleted && !v.excluded);
  const byKey = new Map(live.map((v) => [v.key, v]));
  const items = [];
  const base = (v) => ({ accountKey: v.key, company: v.company, priority: v.salesTeamPriority || null });

  // A changed LinkedIn page the pipeline could not accept by itself (V4)
  for (const v of live) {
    const pc = v.pipeline && v.pipeline.pageChange;
    if (!pc || pc.kept) continue;
    items.push({ ...base(v), id: `page:${v.key}:${pc.pageId}`, kind: "page_changed",
      payload: { ...pc, currentId: v.linkedinCompanyId || null, link: v.linkedinLink || null } });
  }

  // A LinkedIn company found by name that another account already holds (W7)
  for (const v of live) {
    const it = v.pipeline && v.pipeline.idTaken;
    if (!it || it.kept) continue;
    const other = byKey.get(it.otherKey);
    items.push({ ...base(v), id: `taken:${v.key}:${it.pageId}`, kind: "id_taken",
      payload: { ...it, currentLink: v.linkedinLink || null, currentCountry: v.globalHqCountry || null,
        otherCountry: other ? other.globalHqCountry || null : null, otherGone: !other } });
  }

  // Discovery companies that match an account by name only (V2)
  for (const m of diff.heldNameMatches) {
    const key = normalizeCompanyName(m.existing.company);
    const v = byKey.get(key);
    const dc = m.discovered;
    items.push({
      accountKey: key, company: m.existing.company, priority: v ? v.salesTeamPriority : null,
      id: `name:${dc.linkedinCompanyId}`, kind: "name_match",
      payload: {
        discoveredId: dc.linkedinCompanyId, discoveredName: dc.name, discoveredCountry: dc.country || null,
        discoveredIndustry: dc.industryText || null, discoveredLink: dc.slug ? `https://www.linkedin.com/company/${dc.slug}/` : null,
        discoveredContacts: discoveredContacts.filter((c) => c.companyKey === dc.linkedinCompanyId).length,
        existingId: v ? v.linkedinCompanyId : null, existingLink: v ? v.linkedinLink : (m.existing.linkedinLink || null),
        existingCountry: m.existing.globalHqCountry || null, existingIndustry: m.existing.industry || null,
      },
    });
  }

  // Duplicates that are not safe to merge silently (V3)
  for (const g of duplicateGroups(await duplicateRows(), kept)) {
    if (g.auto) continue;
    const first = byKey.get(g.members[0].key);
    items.push({
      accountKey: g.members[0].key, company: g.members[0].company, priority: first ? first.salesTeamPriority : null,
      id: `dup:${g.members.map((m) => m.companyId).sort().join("|")}`, kind: "duplicate",
      payload: {
        reasons: g.reasons,
        members: g.members.map((m) => ({
          companyId: m.companyId, key: m.key, company: m.company, source: m.source, linkedinCompanyId: m.linkedinCompanyId,
          link: m.slug ? `https://www.linkedin.com/company/${m.slug}/` : null, slug: m.slug,
          registryId: m.registryId, city: m.city, country: m.country,
          contacts: (workbook.contacts || []).filter((c) => c.companyId === m.companyId).length,
        })),
      },
    });
  }

  // Lacking evidence (R12.5)
  for (const v of live) {
    if (!v.lacking || (v.pipeline && v.pipeline.keep)) continue;
    items.push({ ...base(v), id: `lack:${v.key}:${v.lacking.reason}`, kind: "lacking_evidence",
      payload: { reason: v.lacking.reason, text: v.lacking.text, link: v.linkedinLink || null, source: v.source } });
  }

  // Web findings the automatic resolve left for the user (V6). The currency is never asked on its own:
  // it goes with the revenue amount.
  const moneySettings = revenueMoneySettings(money);
  const rowByKey = new Map((workbook.companies || []).filter((r) => r.company).map((r) => [normalizeCompanyName(r.company), r]));
  for (const v of live) {
    const extra = extras[v.key];
    const row = rowByKey.get(v.key);
    if (!extra || !extra.webResearch || !row) continue;
    for (const p of computeFindingProposals(row, extra.overrides, extra.webResearch.data, moneySettings)) {
      if (p.key === "revenueCurrency" || isDismissedWebFinding(extra.webFindingsDismissed, p)) continue;
      items.push({ ...base(v), id: `finding:${v.key}:${p.key}:${findingValueKey(p.found)}`, kind: "finding",
        payload: { field: p.key, label: p.label, current: p.current, found: p.found, state: p.state,
          sources: (extra.webResearch.sources || []).length } });
    }
  }

  const sorted = sortDecisions(items).map((i) => ({ ...i, similar: similarKey(i) }));
  return { items: sorted, count: sorted.length };
}

// The Decisions dot and the Readiness column both need the queue as a page opens, and each build reads the
// three large account stores (about 9 MB) and scores every web finding. One build is shared by every caller
// within SHARED_QUEUE_MS (1.2.0.2: Target Accounts built it twice per load). The queue is only read here;
// applyDecision works on the item it is handed, and a later call after the window builds afresh.
const SHARED_QUEUE_MS = 2000;
let sharedQueue = null; // { at, promise }
function buildDecisionQueueShared(views) {
  if (sharedQueue && Date.now() - sharedQueue.at < SHARED_QUEUE_MS) return sharedQueue.promise;
  const promise = buildDecisionQueue(views);
  sharedQueue = { at: Date.now(), promise };
  promise.catch(() => { if (sharedQueue && sharedQueue.promise === promise) sharedQueue = null; });
  return promise;
}

export async function getDecisionQueue() {
  // Team use step 6 (R6.7): the Team Admin's join proposals come first - a colleague is waiting on them.
  const [q, proposals] = await Promise.all([buildDecisionQueueShared(), joinProposalItems().catch(() => [])]);
  return proposals.length ? { items: [...proposals, ...q.items], count: q.count + proposals.length } : q;
}

// Clears an account's failed attempts, empty-page mark, Keep and pending page change: something new
// arrived for it (R12.5.2), so the pipeline tries it again from scratch.
async function resetPipelineFor(key) { return withAccountWriteLock(() => resetPipelineForUnlocked(...arguments)); }
async function resetPipelineForUnlocked(key) {
  const extras = await getTargetAccountExtras();
  const cur = extras[key] || emptyExtra();
  extras[key] = { ...cur, pipeline: { ...(cur.pipeline || {}), attempts: {}, profileTried: [], emptyPage: null, keep: false, pageChange: null, lastRunDay: null } };
  await chrome.storage.local.set({ [TARGET_ACCOUNT_EXTRAS_KEY]: extras });
}

// Applies one answer. item is a queue item as built above; choice is one of its kind's two choices:
//   page_changed: "accept" | "keep"          name_match: "same" | "different"
//   duplicate: "merge" | "separate"          lacking_evidence: "keep" | "remove"
//   finding: "web" | "current"
// Returns a short line saying what was done, for the page and the Activity Log.
export async function applyDecision(item, choice) {
  if (item.kind === "join_proposal") {
    const done = await applyJoinProposal(item, choice);
    appendActivityLog({ actor: "user", action: "decision", label: `Decision: ${done}`, relatedCompanyKey: item.accountKey, newValue: { kind: item.kind, choice } }).catch(() => {});
    return done;
  }
  const p = item.payload || {};
  let label;
  if (item.kind === "page_changed") {
    if (choice === "accept") {
      // The page the account's own link opens is its identity (T4): the id read there is taken, checked
      // against that same link, and the old one is kept on record.
      await applyResolvedCompanyIds([{
        key: item.accountKey, linkedinCompanyId: p.pageId, checkedLink: p.link || null, allowWorkbookRow: true, previousId: p.currentId || p.fromId || null,
      }]);
      await resetPipelineFor(item.accountKey);
      label = `"${item.company}": LinkedIn page accepted as "${p.pageName}" (id ${p.currentId || "none"} -> ${p.pageId})`;
    } else {
      await savePipelineAccountState(item.accountKey, { pageChange: { ...(item.payload || {}), kept: true } });
      label = `"${item.company}": kept the current LinkedIn company, not "${p.pageName}"`;
    }
  } else if (item.kind === "name_match") {
    await saveDiscoveryNameDecision(p.discoveredId, choice === "same" ? "same" : "different");
    const r = await mergeDiscoveredIntoWorkbook();
    if (choice === "same") await resetPipelineFor(item.accountKey);
    label = choice === "same"
      ? `Discovery's "${p.discoveredName}" is the same company as "${item.company}": ${r.contactsAdded} contact${r.contactsAdded === 1 ? "" : "s"} added to it`
      : `Discovery's "${p.discoveredName}" is a different company from "${item.company}": added as a new account`;
  } else if (item.kind === "duplicate") {
    const members = p.members || [];
    if (choice === "merge") {
      const keep = members[0];
      const parts = [];
      for (const drop of members.slice(1)) {
        const r = await mergeTargetAccounts(keep.key, drop.key, { keepId: keep.companyId, dropId: drop.companyId });
        parts.push(`"${r.dropName}" (${r.contactsMoved} contacts moved)`);
      }
      label = `Merged ${parts.join(", ")} into "${keep.company}"`;
    } else {
      const pairs = [];
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pairs.push(accountPairKey(members[i], members[j]));
      await addKeptSeparatePairs(pairs);
      label = `Kept ${members.map((m) => `"${m.company}"`).join(" and ")} as separate companies`;
    }
  } else if (item.kind === "lacking_evidence") {
    if (choice === "remove") {
      await saveTargetAccountExtra(item.accountKey, { deletedAt: Date.now() });
      label = `Removed "${item.company}" (${p.text})`;
    } else {
      await savePipelineAccountState(item.accountKey, { keep: true });
      label = `Kept "${item.company}" although it lacks evidence (${p.text}); not retried until something new arrives`;
    }
  } else if (item.kind === "finding") {
    const extras = await getTargetAccountExtras();
    const extra = extras[item.accountKey] || emptyExtra();
    const overrides = { ...(extra.overrides || {}) };
    const dismissed = { ...(extra.webFindingsDismissed || {}) };
    if (choice === "web") {
      overrides[p.field] = p.found;
      delete dismissed[p.field];
      // A revenue amount and its currency are one fact in two fields (as in the Review findings dialog).
      if (p.field === "globalRevenue") {
        const money = await getRevenueNormalization();
        const row = ((await getTargetAccountsWorkbook()).companies || []).find((c) => c.company && normalizeCompanyName(c.company) === item.accountKey);
        const currency = computeFindingProposals(row || {}, extra.overrides, extra.webResearch?.data, revenueMoneySettings(money))
          .find((x) => x.key === "revenueCurrency");
        if (currency) { overrides.revenueCurrency = currency.found; delete dismissed.revenueCurrency; }
      }
      await saveTargetAccountExtra(item.accountKey, { overrides, webFindingsDismissed: dismissed }, { src: "web", base: { overrides: extra.overrides, webFindingsDismissed: extra.webFindingsDismissed } });
      label = `"${item.company}": ${p.label} set to the web finding (${p.found})`;
    } else {
      dismissed[p.field] = p.found;
      await saveTargetAccountExtra(item.accountKey, { webFindingsDismissed: dismissed });
      label = `"${item.company}": kept the current ${p.label} (${p.current ?? "empty"}), not the web finding (${p.found})`;
    }
  } else if (item.kind === "id_taken") {
    if (choice === "same") {
      // The user says both accounts are the one LinkedIn company: the id is written after all, and the
      // two are then either merged by themselves (same id, one re-checked: V3) or shown as a duplicate.
      const res = { key: item.accountKey, linkedinCompanyId: p.pageId, companyPageUrl: p.pageUrl || null, checkedLink: p.pageUrl || null,
        allowWorkbookRow: true, sharedIdConfirmed: true };
      await applyResolvedCompanyIds([res]);
      await savePipelineAccountState(item.accountKey, { idTaken: null });
      await settleSafeDuplicates().catch(() => {});
      label = `"${item.company}" is the same LinkedIn company as "${p.otherCompany}" (id ${p.pageId})`;
    } else {
      await savePipelineAccountState(item.accountKey, { idTaken: { ...p, kept: true } });
      label = `"${item.company}" is not "${p.otherCompany}": the LinkedIn company found by name (id ${p.pageId}) was not taken, and it is not searched by name again`;
    }
  } else {
    throw new Error(`Unknown decision kind: ${item.kind}`);
  }
  appendActivityLog({ actor: "user", action: "decision", label: `Decision: ${label}`, relatedCompanyKey: item.accountKey, newValue: { kind: item.kind, choice } }).catch(() => {});
  return label;
}

// When the most recent scan started - lets the Dashboard flag which leads
// were first discovered by that specific scan (a persistent equivalent of
// the side panel's transient in-memory "NEW" badge, which only ever existed
// for the length of one side-panel session and never survived a reload).
const LAST_SCAN_STARTED_AT_KEY = "lastScanStartedAt";

// --------------------------------------------------------------------------
// Scan state, topics, lead statuses, results
// --------------------------------------------------------------------------

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
const ACTIVITY_LOG_PRUNED_DAY_KEY = "activityLogPrunedDay";

function activityLogDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${ACTIVITY_LOG_PREFIX}${y}-${m}-${d}`;
}

// --------------------------------------------------------------------------
// Activity log
// --------------------------------------------------------------------------

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

  // Retention pruning once per day, not per entry (1.2.0.2): it used to read the ENTIRE store (about 10 MB -
  // the workbook and every account's research) on every single log line, which was measured at seconds per
  // call and made the pages sluggish. getKeys() lists the keys without reading any values.
  const { [ACTIVITY_LOG_PRUNED_DAY_KEY]: prunedDay } = await chrome.storage.local.get(ACTIVITY_LOG_PRUNED_DAY_KEY);
  if (prunedDay === key) return;
  await chrome.storage.local.set({ [ACTIVITY_LOG_PRUNED_DAY_KEY]: key });
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - ACTIVITY_LOG_RETENTION_DAYS);
  const cutoffKey = activityLogDayKey(cutoff);
  const allKeys = chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const staleKeys = allKeys.filter((k) => k.startsWith(ACTIVITY_LOG_PREFIX) && k < cutoffKey);
  if (staleKeys.length > 0) await chrome.storage.local.remove(staleKeys);

  // The exported-days tracking list (see getPendingActivityLogExportDays
  // below) should never grow forever either - drop anything referring to a
  // day that's already aged out of retention.
  const all = await chrome.storage.local.get(ACTIVITY_LOG_EXPORTED_DAYS_KEY);
  const exportedDays = all[ACTIVITY_LOG_EXPORTED_DAYS_KEY] || [];
  const prunedExportedDays = exportedDays.filter((d) => `${ACTIVITY_LOG_PREFIX}${d}` >= cutoffKey);
  if (prunedExportedDays.length !== exportedDays.length) {
    await chrome.storage.local.set({ [ACTIVITY_LOG_EXPORTED_DAYS_KEY]: prunedExportedDays });
  }
}

// Many entries in ONE read and ONE write. appendActivityLog above is fine for a single user action
// but is far too expensive to loop: it ends with chrome.storage.local.get(null), which reads the
// ENTIRE local store - the whole workbook and every account's saved research text - once per entry.
// An auto-arbitration pass logs one line per resolved finding, which is hundreds at a time.
// Retention pruning is deliberately left out here: appendActivityLog runs often enough on its own,
// and it is the only reason that full read exists.
export async function appendActivityLogBatch(entries) {
  const list = (entries || []).filter(Boolean);
  if (list.length === 0) return 0;
  const now = Date.now();
  const byDay = {};
  for (const e of list) {
    const key = activityLogDayKey(new Date(e.timestamp || now));
    (byDay[key] || (byDay[key] = [])).push({
      timestamp: e.timestamp || now,
      actor: e.actor,
      action: e.action,
      label: e.label,
      prevValue: e.prevValue === undefined ? null : e.prevValue,
      newValue: e.newValue === undefined ? null : e.newValue,
      error: Boolean(e.error),
      errorMessage: e.errorMessage || null,
      relatedCompanyKey: e.relatedCompanyKey || null,
      relatedContactKey: e.relatedContactKey || null,
    });
  }
  const existing = await chrome.storage.local.get(Object.keys(byDay));
  const write = {};
  for (const [key, added] of Object.entries(byDay)) {
    write[key] = [...(existing[key] || []), ...added];
  }
  await chrome.storage.local.set(write);
  return list.length;
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
// Configuration the Setup wizard (and its Settings pages) stores as raw keys, carried in the settings
// backup as one block (`wizardSettings`) so a restore on a fresh machine/profile brings the whole
// setup back, not just the Scanner topics. Deliberately NOT included: the Anthropic API key (own
// opt-in above) and companyLocationSizeCache (a re-derivable cache).
function wizardSettingsBackupKeys() {
  return [
    TARGET_UNIVERSE_CONFIG_KEY,
    TARGET_CONTACT_PROFILE_KEY,
    COMPANY_EXCLUSIONS_KEY,
    COMPANY_EXCLUSIONS_MIGRATED_KEY, // keeps the one-time staffing-firm seeding from re-running over a restored list
    COMPANY_ALIASES_KEY,
    POST_PRIORITIZATION_RULES_KEY,
    PRIORITIZATION_RULE_OVERRIDES_KEY,
    JOB_RULES_MIN_CONFIDENCE_KEY,
    ACCOUNT_PRIORITY_GUIDELINES_KEY,
    ORGANIZATION_TYPE_ELIGIBILITY_KEY,
    KEYWORD_SEARCH_LANGUAGES_KEY,
    USER_PROFILE_KEY,
    COMPANY_WEBSITE_KEY,
    SELLER_COMPANY_NAME_KEY,
    SETUP_RESEARCH_KEY,
    COMPLETION_TARGETS_KEY,
    INITIATIVE_STAGE_PREFERENCE_KEY,
    INCLUDED_COMPANIES_KEY,
    ONBOARDING_COMPLETED_AT_KEY,
    ONBOARDING_PROGRESS_STEP_KEY,
  ];
}

// --------------------------------------------------------------------------
// Export / import - settings and leads
// --------------------------------------------------------------------------

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
    scanCompanyPriorityScope,
    wizardSettings,
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
    getScanCompanyScope(),
    chrome.storage.local.get(wizardSettingsBackupKeys()),
    includeApiKey ? getAnthropicApiKey() : Promise.resolve(undefined),
  ]);
  const webFindingsArbitration = await getWebFindingsArbitration();
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
    scanCompanyPriorityScope,
    wizardSettings,
    webFindingsArbitration,
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

// Which parts of a settings backup exist in `data` and can be restored on their own - the restore
// dialog (backup-restore.js) offers exactly these. Ids: scanner, messaging, wizard, accountsLookup.
export function availableSettingsSections(data) {
  const ids = [];
  if (data.topics !== undefined || data.jobTopics !== undefined || data.timeframe !== undefined) ids.push("scanner");
  if (data.messageTemplates || data.valueAddOffers || data.companyContext !== undefined || data.mentorPersona
      || data.customerPersona !== undefined || data.outputLanguage !== undefined) ids.push("messaging");
  if (data.wizardSettings && typeof data.wizardSettings === "object") ids.push("wizard");
  if (data.targetAccounts) ids.push("accountsLookup");
  return ids;
}

// `sections` = a Set of the ids above to restore; omitted/null restores everything the file carries
// (the original behaviour). Whatever is not selected is left exactly as it is right now.
export async function importSettings(data, sections = null) { return withAccountWriteLock(() => importSettingsUnlocked(...arguments)); }
async function importSettingsUnlocked(data, sections = null) {
  const has = (id) => !sections || sections.has(id);
  await Promise.all([
    ...(has("scanner") ? [
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
      ...(data.negativeTopics ? [saveNegativeTopics(data.negativeTopics)] : []),
      ...(data.scanCompanyPriorityScope ? [saveScanCompanyScope(data.scanCompanyPriorityScope)] : []),
    ] : []),
    ...(has("messaging") ? [
      ...(data.messageTemplates ? [saveMessageTemplates(data.messageTemplates)] : []),
      ...(data.valueAddOffers ? [saveValueAddOffers(data.valueAddOffers)] : []),
      saveCompanyContext(data.companyContext || ""),
      saveIdealCustomerProfile(data.idealCustomerProfile || ""),
      ...(data.mentorPersona ? [saveMentorPersona(data.mentorPersona)] : []),
      saveCustomerPersona(data.customerPersona || ""),
      saveOutputLanguage(data.outputLanguage || "english"),
      // Only present if the exporter deliberately chose to include it (e.g. sharing one spend-capped
      // trial key across a small team) - never overwrites an existing key with nothing.
      ...(data.anthropicApiKey ? [saveAnthropicApiKey(data.anthropicApiKey)] : []),
    ] : []),
    ...(has("wizard") ? [
      // Only the known wizard keys are ever written (never an arbitrary key from a file), and only when
      // the backup carries the block - an older backup leaves the current wizard setup alone.
      ...(data.wizardSettings && typeof data.wizardSettings === "object"
        ? [chrome.storage.local.set(Object.fromEntries(
            Object.entries(data.wizardSettings).filter(([key]) => wizardSettingsBackupKeys().includes(key))))]
        : []),
      ...(typeof data.targetAccountScoreThreshold === "number"
        ? [saveTargetAccountScoreThreshold(data.targetAccountScoreThreshold)]
        : []),
      ...(data.webFindingsArbitration && typeof data.webFindingsArbitration === "object"
        ? [saveWebFindingsArbitration(data.webFindingsArbitration)]
        : []),
    ] : []),
    ...(has("accountsLookup") && data.targetAccounts
      ? [chrome.storage.local.set({
          [TARGET_ACCOUNTS_KEY]: data.targetAccounts,
          [TARGET_ACCOUNTS_IMPORTED_AT_KEY]: data.targetAccountsImportedAt || null,
        })]
      : []),
    // A backup from before the Location Filter/wizard Location unification (2026-09-16) may still carry
    // a locationFilterConfig field - silently ignored, not migrated; that concept no longer exists.
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

// --------------------------------------------------------------------------
// Post-merge helpers - relative timestamps, topic & job posts
// --------------------------------------------------------------------------

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
