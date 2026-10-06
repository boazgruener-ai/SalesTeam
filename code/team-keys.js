// Team use 1.2.2, build step 2 (TEAM_USE_DESIGN.md 5.1): which chrome.storage.local keys the team shares.
// PURE - the one place a storage key is classified, so a new key has to be put on a side once, deliberately.
// The dev page (zz_team_sync.html) lists every key in storage that is on neither list.
//
// How a shared key is cut into rows (team-rows.js):
//   workbook - targetAccountsWorkbook: one row per company / contact / AI initiative (by its id), the rest whole
//   map      - an object keyed by something stable: one row per entry
//   list     - an array of entries known by their content: one row per entry (TEAM_LIST_KEYS)
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
  // step 6 (R6.7): a joining member's claims on accounts the team already has - the Team Admin decides in Decisions
  { key: "teamJoinProposals", e: "setting", prefix: "teamJoinProposals:" },
];

export const TEAM_WHOLE_KEYS = [
  // accounts
  "keptSeparateAccountPairs",
  // seller setup (D3: changed by the Team Admin only - enforced in step 5)
  "companyContext", "companyWebsite", "sellerCompanyName", "setupResearch", "idealCustomerProfile",
  "targetUniverseConfig", "targetContactProfile", "accountPriorityGuidelines", "completionTargets",
  "initiativeStagePreference", "includedCompanies", "valueAddOffers", "messageTemplates",
  // rules
  "companyExclusionsLifted", "organizationTypeEligibility", "companyAliases",
  "negativeTopics", "prioritizationRuleOverrides", "postPrioritizationRules", "webFindingsArbitration",
  "revenueNormalization", "targetAccountScoreThreshold", "jobRulesMinConfidence", "keywordSearchLanguages",
];

// list - an array whose entries are known by their content (step 5b): one row per entry, so two members adding at the
// same time both keep theirs - as a whole key only the later list would survive. The exclusion list (competitors,
// customers, partners, recruiters): changed by the Team Admin only (Setup is the admin's, D3; R6.8 as changed 2026-10-05).
export const TEAM_LIST_KEYS = [
  { key: "companyExclusions", e: "setting", prefix: "companyExclusions:", identity: ["category", "slug", "name", "domain"] },
  // 1.2.3: customers and partners (EXCLUSIONS_RELATIONSHIPS_DESIGN.md 3.3) - same shape, same rule (Team Admin only)
  { key: "companyRelationships", e: "setting", prefix: "companyRelationships:", identity: ["category", "slug", "name", "domain"] },
];
// The row id of one list entry: its identity fields, lower-cased (an entry that is not an object: its JSON).
export function listEntryId(spec, entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return `=${JSON.stringify(entry)}`;
  return spec.identity.map((f) => String(entry[f] ?? "").trim().toLowerCase()).join("|");
}
export const TEAM_SHARED_KEYS = [TEAM_WORKBOOK_KEY, ...TEAM_MAP_KEYS.map((m) => m.key), ...TEAM_LIST_KEYS.map((l) => l.key), ...TEAM_WHOLE_KEYS];

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
  "companyExclusionsMigrated", "relationshipsMigrationNotice", "locationHeuristicV2Migrated", "locationHeuristicV3Migrated",
  // the team layer's own state
  "teamMembership", "teamSyncStatus", "teamAccountStates", "teamNotices", "teamLog",
];

export function teamKeyKind(key) {
  if (key === TEAM_WORKBOOK_KEY) return "workbook";
  if (TEAM_MAP_KEYS.some((m) => m.key === key)) return "map";
  if (TEAM_LIST_KEYS.some((l) => l.key === key)) return "list";
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
