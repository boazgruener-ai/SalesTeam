// Team use 1.2.2, build step 2 (TEAM_USE_DESIGN.md 5.1): which chrome.storage.local keys the team shares.
// PURE - the one place a storage key is classified, so a new key has to be put on a side once, deliberately.
// The dev page (zz_team_sync.html) lists every key in storage that is on neither list.
//
// How a shared key is cut into rows (team-rows.js):
//   workbook - targetAccountsWorkbook: one row per company / contact / AI initiative (by its id), the rest whole
//   map      - an object keyed by something stable: one row per entry
//   whole    - one row holding the whole value (field "$v"): the later change wins the whole setting

export const TEAM_WORKBOOK_KEY = "targetAccountsWorkbook";

// Sheets of the workbook that have their own id. A row without an id (or with an id another row already has)
// travels with the rest of the workbook, so nothing is lost.
export const TEAM_WORKBOOK_SHEETS = [
  { sheet: "companies", idField: "companyId", e: "account", prefix: "wb:" },
  { sheet: "contacts", idField: "contactId", e: "contact", prefix: "wb:" },
  { sheet: "aiInitiatives", idField: "initiativeId", e: "setting", prefix: "wb.aiInitiatives:" },
];
export const TEAM_WORKBOOK_REST_ID = "wb:rest";

// Per-lead fields that never leave the PC (drafts and Sales Mentor history are personal, R3.6).
export const PERSONAL_LEAD_FIELDS = ["draftMessage", "draftTemplateId", "draftGeneratedAt", "mentorHistory"];

export const TEAM_MAP_KEYS = [
  { key: "targetAccounts", e: "account", prefix: "ta:" },
  { key: "targetAccountExtras", e: "account", prefix: "x:" },
  { key: "targetContactExtras", e: "contact", prefix: "x:" },
  { key: "results", e: "lead", prefix: "", personal: PERSONAL_LEAD_FIELDS },
  { key: "discoveryNameDecisions", e: "setting", prefix: "discoveryNameDecisions:" },
  { key: "companyLocationSizeCache", e: "setting", prefix: "companyLocationSizeCache:" },
];

export const TEAM_WHOLE_KEYS = [
  // accounts
  "keptSeparateAccountPairs",
  // seller setup (D3: changed by the Team Admin only - enforced in step 5)
  "companyContext", "companyWebsite", "sellerCompanyName", "setupResearch", "idealCustomerProfile",
  "targetUniverseConfig", "targetContactProfile", "accountPriorityGuidelines", "completionTargets",
  "initiativeStagePreference", "includedCompanies", "valueAddOffers", "messageTemplates",
  // rules
  "companyExclusions", "companyExclusionsLifted", "organizationTypeEligibility", "companyAliases",
  "negativeTopics", "prioritizationRuleOverrides", "postPrioritizationRules", "webFindingsArbitration",
  "revenueNormalization", "targetAccountScoreThreshold", "jobRulesMinConfidence", "keywordSearchLanguages",
];

export const TEAM_SHARED_KEYS = [TEAM_WORKBOOK_KEY, ...TEAM_MAP_KEYS.map((m) => m.key), ...TEAM_WHOLE_KEYS];

// Never synced. Not exhaustive by necessity - anything not shared stays local - but listing them makes an
// unclassified key stand out on the dev page.
export const TEAM_PERSONAL_KEYS = [
  "anthropicApiKey", "userProfile", "outputLanguage", "mentorPersona", "customerPersona",
  "advisorHistory", "customerVoiceHistory", "lastBulkChange", "lastWebDiscoveryAdd", "onboardingMeasures",
  "onboardingCompletedAt", "onboardingProgressStepIndex",
  "topics", "jobTopics", "timeframe", "authorTitle", "authorTitleEnabled", "includeJobAds", "jobSearchEnabled",
  "jobSearchLocation", "jobSearchTimeframe", "jobSearchUseMainLocation", "jobSearchLocationPresets",
  "jobSearchUsePostTopics", "scanCompanyPriorityScope", "lastScanStartedAt",
  "discoveredCompanies", "discoveredContacts",
  "activityLog", "activityLogExportedDays", "activityLogPrunedDay",
  "targetAccountsImportedAt", "targetAccountsImportedFileName", "targetAccountsWorkbookImportedAt",
  "companyExclusionsMigrated", "locationHeuristicV2Migrated", "locationHeuristicV3Migrated",
  // the team layer's own state
  "teamMembership", "teamSyncStatus",
];

export function teamKeyKind(key) {
  if (key === TEAM_WORKBOOK_KEY) return "workbook";
  if (TEAM_MAP_KEYS.some((m) => m.key === key)) return "map";
  if (TEAM_WHOLE_KEYS.includes(key)) return "whole";
  return null;
}

export function isTeamSharedKey(key) {
  return teamKeyKind(key) !== null;
}

// "shared" | "personal" | "unclassified". Keys written per day or per id (activityLog-2026-10-03, ...) count by
// their prefix.
export function classifyStorageKey(key) {
  if (isTeamSharedKey(key)) return "shared";
  if (TEAM_PERSONAL_KEYS.includes(key)) return "personal";
  if (TEAM_PERSONAL_KEYS.some((p) => key.startsWith(`${p}-`) || key.startsWith(`${p}:`))) return "personal";
  return "unclassified";
}
