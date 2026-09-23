// The full backup: ONE zip holding everything the extension stores, so a crash, a reinstall or a wiped
// profile can be recovered to the moment of the backup. It is a snapshot of chrome.storage.local minus a
// short exclusion list (rather than a hand-kept list of what to include), so data added to the extension
// later is covered automatically.
//
//   salesteam-backup-2026-09-19.zip
//     README.txt          what is inside and how to use it
//     manifest.json       date, extension version, what each category holds (read by the restore dialog)
//     spreadsheets/*.csv  the accounts workbook (Companies, Contacts, Initiatives, ...) and Leads, ready to
//                         upload to another system or open in Excel
//     data/<category>.json the raw stored data, grouped by category, for restoring
import { createZip, readZip, bytesToText } from "./backup-zip.js";
import { workbookCsvFiles, leadsToCsv } from "./csv-export.js";

// Never written to a backup file: the API key (a backup is plain text - re-enter it after a reinstall),
// this feature's own bookkeeping, transient scan state, and a re-derivable cache.
const EXCLUDED_EXACT = new Set(["anthropicApiKey", "lastAutoBackupAt", "lastBackupInfo", "scanAbortRequested", "companyLocationSizeCache"]);
const EXCLUDED_PREFIXES = ["currentScan", "currentJobScan"];

// category id -> { label, detail, keys | test }. A stored key belongs to the first category that claims
// it; anything nobody claims lands in "other" so nothing is ever silently dropped.
export const BACKUP_CATEGORIES = [
  {
    id: "scanner", label: "Scanner settings",
    detail: "Topics, negative topics, Job Search, timeframe, author-title filter, and which Target Account companies to scan.",
    keys: ["topics", "jobTopics", "timeframe", "authorTitle", "authorTitleEnabled", "includeJobAds", "jobSearchEnabled",
      "jobSearchLocation", "jobSearchLocationPresets", "jobSearchUseMainLocation", "jobSearchTimeframe", "jobSearchUsePostTopics", "negativeTopics",
      "scanCompanyPriorityScope"],
  },
  {
    id: "messaging", label: "Messaging & AI persona",
    detail: "Message templates, value-add offers, company context, ideal customer profile, personas and output language.",
    keys: ["messageTemplates", "valueAddOffers", "companyContext", "idealCustomerProfile", "mentorPersona", "customerPersona", "outputLanguage",
      "anthropicApiKey"], // only present in a backup when the user explicitly chose to include it
  },
  {
    id: "wizard", label: "Setup wizard configuration",
    detail: "Target universe, target contacts, exclusions, prioritization rules and guidelines, languages, your profile and company website, wizard progress.",
    keys: ["targetUniverseConfig", "targetContactProfile", "companyExclusions", "companyExclusionsMigrated", "companyAliases",
      "postPrioritizationRules", "prioritizationRuleOverrides", "accountPriorityGuidelines", "organizationTypeEligibility",
      "keywordSearchLanguages", "userProfile", "companyWebsite", "onboardingCompletedAt", "onboardingProgressStepIndex",
      "targetAccountScoreThreshold"],
  },
  {
    id: "accounts", label: "Accounts, contacts and initiatives",
    detail: "The imported research workbook as it was, including discovered companies already merged in. Replaces your current accounts and contacts.",
    keys: ["targetAccounts", "targetAccountsImportedAt", "targetAccountsImportedFileName", "targetAccountsWorkbook", "targetAccountsWorkbookImportedAt"],
  },
  {
    id: "edits", label: "Your edits to accounts and contacts",
    detail: "Manual overrides and priorities, follow-up dates, removed accounts, and Sales Mentor / Customer Voice chats.",
    keys: ["targetAccountExtras", "targetContactExtras"],
  },
  {
    id: "staged", label: "Discovery results waiting to be merged",
    detail: "Companies and contacts found by Discovery that have not gone through Review & Merge yet.",
    keys: ["discoveredCompanies", "discoveredContacts"],
  },
  {
    id: "leads", label: "Leads and conversations",
    detail: "Every lead with its status, priority and notes, plus the Sales Mentor and Customer Voice histories. Replaces your current leads.",
    keys: ["results", "advisorHistory", "customerVoiceHistory", "lastScanStartedAt", "lastBulkChange"],
  },
  {
    id: "activity", label: "Activity log",
    detail: "The record of what you and the extension did (kept 90 days).",
    test: (key) => key === "activityLog" || key.startsWith("activityLog:") || key === "activityLogExportedDays",
  },
  {
    id: "counters", label: "LinkedIn activity counters",
    detail: "The rolling count of automated LinkedIn visits behind the daily safety limit - restoring it keeps that limit honest after a reinstall.",
    keys: ["linkedinTouchLog"],
  },
  {
    id: "display", label: "Display preferences",
    detail: "Which table columns are shown, sort order, filters and page sizes.",
    // stored in the pages' localStorage, not chrome.storage - handled separately below
    virtual: true,
  },
  { id: "other", label: "Other data", detail: "Anything else the extension stored that is not listed above.", catchAll: true },
];

function isExcluded(key) {
  return EXCLUDED_EXACT.has(key) || EXCLUDED_PREFIXES.some((p) => key.startsWith(p));
}

function categoryOf(key) {
  for (const cat of BACKUP_CATEGORIES) {
    if (cat.catchAll || cat.virtual) continue;
    if (cat.keys ? cat.keys.includes(key) : cat.test(key)) return cat.id;
  }
  return "other";
}

function readLocalStorage() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out[k] = localStorage.getItem(k);
    }
  } catch { /* localStorage unavailable: display preferences are simply not backed up */ }
  return out;
}

function summarize(id, data) {
  const count = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);
  switch (id) {
    case "scanner": return `${count(data.topics)} topics, ${count(data.jobTopics)} job topics`;
    case "accounts": {
      const wb = data.targetAccountsWorkbook || {};
      return `${count(wb.companies)} companies, ${count(wb.contacts)} contacts, ${count(wb.aiInitiatives)} initiatives`;
    }
    case "edits": return `${count(data.targetAccountExtras)} account edits, ${count(data.targetContactExtras)} contact edits`;
    case "staged": return `${count(data.discoveredCompanies)} companies, ${count(data.discoveredContacts)} contacts`;
    case "leads": return `${count(data.results)} leads`;
    case "activity": {
      const entries = Object.entries(data).reduce((n, [k, v]) => n + (k.startsWith("activityLog:") ? count(v) : 0), 0);
      return `${entries} entries`;
    }
    case "display": return `${Object.keys(data).length} saved preferences`;
    default: return `${Object.keys(data).length} item${Object.keys(data).length === 1 ? "" : "s"}`;
  }
}

// -> { categories: { id: { key: value } } } for every category that has something in it.
export async function snapshotAll({ includeApiKey = false } = {}) {
  const stored = await chrome.storage.local.get(null);
  const grouped = {};
  for (const [key, value] of Object.entries(stored)) {
    if (isExcluded(key) && !(includeApiKey && key === "anthropicApiKey")) continue;
    const id = categoryOf(key);
    (grouped[id] ||= {})[key] = value;
  }
  const display = readLocalStorage();
  if (Object.keys(display).length > 0) grouped.display = display;
  return grouped;
}

function readmeText(createdAt, version, categories) {
  return [
    "SalesTeam full backup",
    "=====================",
    `Made: ${new Date(createdAt).toLocaleString()}   Extension version: ${version}`,
    "",
    "WHAT IS IN THIS ZIP",
    "  spreadsheets/   Your data as CSV files - open in Excel, or import into Salesforce or another CRM:",
    "                    Companies.csv, Contacts.csv, Initiatives.csv, Investment.csv, Sources.csv, Aliases.csv,",
    "                    Exclusion_List.csv (the accounts workbook) and Leads.csv (Posts and Job listings).",
    "                  Share the accounts files with or without Leads.csv.",
    "  data/           The raw data SalesTeam restores from, one file per category. Do not edit.",
    "  manifest.json   What the backup contains.",
    "",
    "HOW TO RESTORE",
    "  In SalesTeam, open Settings > \"Restore\" > \"Restore from backup...\" and pick this zip (no need to unzip it).",
    "  You choose which parts to restore; nothing is replaced unless you tick it.",
    "",
    "NOT INCLUDED",
    "  Your Anthropic API key, unless it was included on purpose (a backup file is plain text - otherwise enter the key again after a reinstall).",
    "",
    "CONTENTS",
    ...Object.entries(categories).map(([id, c]) => `  ${c.label}: ${c.summary}`),
    "",
  ].join("\r\n");
}

// -> Blob of the zip. `now` only for tests.
export async function buildFullBackupZip({ includeApiKey = false } = {}) {
  const grouped = await snapshotAll({ includeApiKey });
  const createdAt = new Date().toISOString();
  const version = chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : "";

  const categories = {};
  const files = [];
  for (const cat of BACKUP_CATEGORIES) {
    const data = grouped[cat.id];
    if (!data) continue;
    categories[cat.id] = { label: cat.label, detail: cat.detail, summary: summarize(cat.id, data), keys: Object.keys(data) };
    files.push({ name: `data/${cat.id}.json`, data: JSON.stringify(data) });
  }

  const spreadsheets = [];
  const accountCsvs = workbookCsvFiles((grouped.accounts || {}).targetAccountsWorkbook);
  for (const [name, text] of Object.entries(accountCsvs)) spreadsheets.push({ name: `spreadsheets/${name}`, data: text });
  const leadsCsv = leadsToCsv((grouped.leads || {}).results);
  if (leadsCsv) spreadsheets.push({ name: "spreadsheets/Leads.csv", data: leadsCsv });

  const manifest = {
    kind: "salesteam-full-backup",
    format: 1,
    createdAt,
    extensionVersion: version,
    categories,
    spreadsheets: spreadsheets.map((f) => f.name),
    includesApiKey: Boolean(includeApiKey),
    excluded: [...(includeApiKey ? [] : ["anthropicApiKey"]), "transient scan state", "location/size cache"],
  };

  return createZip([
    { name: "README.txt", data: readmeText(createdAt, version, categories) },
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    ...spreadsheets,
    ...files,
  ]);
}

// ArrayBuffer of a backup zip -> { manifest, data: { categoryId: { key: value } } }. Throws a readable
// message if the file is not a SalesTeam full backup.
export async function parseFullBackup(arrayBuffer) {
  let entries;
  try {
    entries = await readZip(arrayBuffer);
  } catch (err) {
    throw new Error(`That isn't a readable zip file (${err.message}).`);
  }
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error("That zip isn't a SalesTeam backup (no manifest.json).");
  const manifest = JSON.parse(bytesToText(manifestBytes));
  if (manifest.kind !== "salesteam-full-backup") throw new Error("That zip isn't a SalesTeam full backup.");
  const data = {};
  for (const id of Object.keys(manifest.categories || {})) {
    const bytes = entries.get(`data/${id}.json`);
    if (bytes) data[id] = JSON.parse(bytesToText(bytes));
  }
  return { manifest, data };
}

// Writes the chosen categories back. `selected` = Set of category ids. Each selected category REPLACES the
// current values of the keys it contains; keys in categories you did not select are not touched.
export async function restoreFullBackup(parsed, selected) {
  for (const id of selected) {
    const data = parsed.data[id];
    if (!data) continue;
    if (id === "display") {
      for (const [k, v] of Object.entries(data)) {
        try { localStorage.setItem(k, v); } catch { /* ignore a preference that cannot be stored */ }
      }
    } else {
      await chrome.storage.local.set(data);
    }
  }
}
