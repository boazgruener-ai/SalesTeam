// Spreadsheet (CSV) versions of the accounts workbook and the leads, written into every full backup
// (full-backup.js) so a salesperson can lift them straight out - upload to Salesforce / another CRM,
// or open in Excel and share - without needing the extension. UTF-8 with a byte-order mark and CRLF
// line ends, which is what Excel expects.
import { AI_FIELD_ALIASES, HOME_FIELD_ALIASES } from "./xlsx-lite.js";
import { customerFieldName } from "./field-names.js";

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// For the files a user exports from a table (Boaz, 2026-10-02): a column empty in every exported row is left out, and a
// column filled in fewer than half of them moves to the right-hand end, so the well-filled columns come first. Order is
// otherwise kept. Returns { headers, rows }.
export function compactCsvColumns(headers, rows) {
  const filled = headers.map((_, i) => rows.filter((r) => String(r[i] ?? "").trim() !== "").length);
  const keep = headers.map((_, i) => i).filter((i) => filled[i] > 0);
  const order = [...keep.filter((i) => filled[i] * 2 >= rows.length), ...keep.filter((i) => filled[i] * 2 < rows.length)];
  return { headers: order.map((i) => headers[i]), rows: rows.map((r) => order.map((i) => r[i])) };
}

export function toCsv(headers, rows) {
  return "﻿" + [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

// Readable column titles for internal field ids that would otherwise read badly (older field ids kept
// their first workbook's country-specific spelling internally; the spreadsheet uses the neutral wording
// the Explorer shows). Anything not listed is turned into words automatically.
const HEADER_OVERRIDES = {
  salesTeamPriority: "Priority",
  salesTeamPriorityScore: "Priority Score",
  salesTeamPriorityReason: "Priority Reason",
  priority: "Imported Priority",
  priorityScore: "Imported Priority Score",
  priorityRationale: "Imported Priority Rationale",
  zefixOfficialName: "Registry Official Name",
  zefixUid: "Registry ID",
  zefixAddress: "Registry Address",
  mainSwissLocation: "Main Local Location",
  swissDecisionAuthority: "Local Decision Authority",
  swissRevenue: "Local Revenue",
  swissRevenueCurrency: "Local Revenue Currency",
  swissRevenuePeriod: "Local Revenue Period",
  swissRevenueConfidence: "Local Revenue Confidence",
  swissEmployees: "Local Employees",
  swissEmployeesPeriod: "Local Employees Period",
  swissEmployeesConfidence: "Local Employees Confidence",
  investmentSwitzerland: "Investment (Local)",
  investmentGlobal: "Investment (Global)",
  swissSizeFitScore: "Local Size Fit Score",
  swissBased: "Local",
  targetCountryRelationship: "Local / Global",
  // 1.2.4.3 (projects design section 4): the stored names keep "initiative", the export says "project".
  topInitiatives: "Top Projects",
  initiativeId: "Project ID",
  initiativeName: "Project Name",
  companyType: "Company Type",
  linkedinLink: "LinkedIn Link",
  lastVerified2: "Contact Link",
  evidenceQuality2: "LinkedIn Status",
};

// Bookkeeping fields that mean nothing outside the extension.
const INTERNAL_FIELDS = new Set(["salesTeamPriorityScoredAt", "sizeFetchAttemptedAt", "linkedinResolveAttemptedAt"]);

function headerLabel(key) {
  if (HEADER_OVERRIDES[key]) return HEADER_OVERRIDES[key];
  // 1.2.4.4 (R6): no "AI" in a customer field's column title - "Adoption fit score" -> "Adoption Fit Score".
  const named = customerFieldName(key);
  if (named) return named.replace(/(^|[\s(])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");
  return words
    .map((w) => {
      const lower = w.toLowerCase();
      if (lower === "id") return "ID";
      if (lower === "url") return "URL";
      if (lower === "hq") return "HQ";
      if (lower === "linkedin") return "LinkedIn";
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

// A row can carry the same value under two ids (the imported workbook's spelling and SalesTeam's
// alias, e.g. priorityScore/aiPriorityScore, or homeEmployees/swissEmployees) - keep one.
function normalizeRow(row) {
  const r = { ...row };
  for (const [shortKey, aiKey] of Object.entries(AI_FIELD_ALIASES)) {
    if (r[shortKey] === undefined && r[aiKey] !== undefined) r[shortKey] = r[aiKey];
    delete r[aiKey];
  }
  for (const [homeKey, legacyKey] of Object.entries(HOME_FIELD_ALIASES)) {
    if (r[legacyKey] === undefined && r[homeKey] !== undefined) r[legacyKey] = r[homeKey];
    delete r[homeKey];
  }
  for (const key of INTERNAL_FIELDS) delete r[key];
  return r;
}

function cellText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cellText).join(" | ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// One sheet of the accounts workbook (array of row objects) -> CSV text, or null if there are no rows.
// Columns are the union of every row's fields in first-seen order; a column that is empty everywhere is dropped.
export function rowsToCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const normalized = rows.map(normalizeRow);
  const keys = [];
  const seen = new Set();
  for (const row of normalized) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); keys.push(key); }
    }
  }
  const used = keys.filter((k) => normalized.some((r) => r[k] !== undefined && r[k] !== null && r[k] !== ""));
  return toCsv(used.map(headerLabel), normalized.map((r) => used.map((k) => cellText(r[k]))));
}

const WORKBOOK_SHEET_FILES = {
  companies: "Companies.csv",
  contacts: "Contacts.csv",
  aiInitiatives: "Projects.csv", // 1.2.4.3: was Initiatives.csv (projects design section 4)
  aiInvestment: "Investment.csv",
  sources: "Sources.csv",
  aliases: "Aliases.csv",
  exclusionList: "Exclusion_List.csv",
};

// -> { "Companies.csv": text, ... } for every non-empty sheet of the stored workbook.
export function workbookCsvFiles(workbook) {
  const files = {};
  for (const [sheet, fileName] of Object.entries(WORKBOOK_SHEET_FILES)) {
    const csv = rowsToCsv((workbook || {})[sheet]);
    if (csv) files[fileName] = csv;
  }
  return files;
}

function localStamp(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The leads (Posts and Job listings) as one flat sheet, newest first, same meaning as the Posts
// Dashboard's own CSV export plus location and the matched topics/keywords.
export function leadsToCsv(results) {
  const leads = Object.values(results || {});
  if (leads.length === 0) return null;
  const isJob = (l) => l.type === "job";
  const rows = leads
    .sort((a, b) => (b.postedAt || b.firstSeenAt || 0) - (a.postedAt || a.firstSeenAt || 0))
    .map((l) => [
      localStamp(l.postedAt || l.firstSeenAt),
      localStamp(l.firstSeenAt),
      isJob(l) ? "Job Listing" : l.isJobAd ? "In-Post Job Ad" : "Post",
      isJob(l) ? (l.title || "") : (l.headline || l.author || ""),
      isJob(l) ? [l.title, l.company, l.location].filter(Boolean).join(" · ") : (l.snippet || ""),
      isJob(l) ? (l.company || "") : (l.author || ""),
      l.company || "",
      l.location || "",
      l.connectionDegree || "",
      l.status || "New",
      l.priority ? `P${l.priority}` : "",
      l.priorityReason || "",
      (l.matchedTopics || []).map((t) => t.topicName).join("; "),
      [...new Set((l.matchedTopics || []).flatMap((t) => t.matchedKeywords || []))].join("; "),
      (isJob(l) ? l.jobUrl : l.profileUrl) || "",
      (isJob(l) ? l.jobUrl : l.postUrl) || "",
    ]);
  return toCsv(
    ["Post Date", "First Scanned", "Source", "Title", "Content", "Creator", "Company", "Location", "Connection",
      "Status", "Priority", "Priority Reason", "Matched Topics", "Matched Keywords", "Profile / Job URL", "Post / Job URL"],
    rows
  );
}

// ---- 1.2.4.3: the Excel workbook of Export… (xlsx-write.js) ----
// The research workbook's own layout - sheets Companies, Contacts, Projects (+ Leads, lead-shape.js, on export); headers Company_ID, Full_Name,
// Top_Projects … - so Import… reads the file back (xlsx-lite.js camelCases each header into the stored field id).

// Headers the workbook reader needs on Companies even when empty (xlsx-lite.js NEEDED_HEADER_ALIASES), and the
// spellings that are not the plain word-by-word form of the field id.
const WORKBOOK_REQUIRED_COMPANY_HEADERS = ["Company", "Industry", "Priority_Score", "Priority", "Research_Status", "Top_Projects"];
const WORKBOOK_HEADER_OVERRIDES = {
  topInitiatives: "Top_Projects",
  initiativeId: "Project_ID",
  initiativeName: "Project_Name",
  maturityFitScore: "Adoption_Fit_Score", // 1.2.4.4 (R6); the import reads Maturity_Fit_Score too
  linkedinLink: "LinkedIn Link", // the research workbook's own spelling (sheet_contract.py)
  alternativeCompanyName: "Alternative Company Name",
};

const WORKBOOK_WORDS = { id: "ID", url: "URL", hq: "HQ", uid: "UID", linkedin: "LinkedIn" };
// "globalHqCity" -> "Global_HQ_City", "companyId" -> "Company_ID"; xlsx-lite.js's camelCaseHeader reverses it (it
// lower-cases every word, so the spelling of a word never matters to the import).
export function workbookHeader(key) {
  if (WORKBOOK_HEADER_OVERRIDES[key]) return WORKBOOK_HEADER_OVERRIDES[key];
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").split("_")
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (WORKBOOK_WORDS[lower]) return WORKBOOK_WORDS[lower];
      if (i > 0 && (lower === "or" || lower === "and" || lower === "of")) return lower; // Technology_or_Partner
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join("_");
}

// A row with the user's edits laid over it (`overrides`, keyed by the stored ids - an edit to an ai… field also sets
// its short twin, which normalizeRow keeps), in the workbook's neutral Home_ spelling.
function workbookRow(row, overrides) {
  const r = { ...row, ...(overrides || {}) };
  for (const [shortKey, aiKey] of Object.entries(AI_FIELD_ALIASES)) {
    if (overrides && overrides[aiKey] !== undefined) r[shortKey] = overrides[aiKey];
  }
  const n = normalizeRow(r);
  for (const [homeKey, legacyKey] of Object.entries(HOME_FIELD_ALIASES)) {
    if (n[legacyKey] !== undefined) { n[homeKey] = n[legacyKey]; delete n[legacyKey]; }
  }
  return n;
}

function workbookSheet(name, rows, required = []) {
  const keys = [];
  const seen = new Set();
  for (const row of rows) {
    for (const [key, v] of Object.entries(row)) {
      if (seen.has(key) || v === undefined || v === null || v === "") continue;
      seen.add(key);
      keys.push(key);
    }
  }
  const headers = keys.map(workbookHeader);
  for (const h of required) if (!headers.includes(h)) { headers.push(h); keys.push(null); }
  const cell = (v) => (v == null ? "" : typeof v === "number" ? v : cellText(v));
  return { name, headers, rows: rows.map((r) => keys.map((k) => (k ? cell(r[k]) : ""))) };
}

// { companies, contacts, projects }: stored rows; `overridesOf(kind, row)` -> that row's edits or null.
export function workbookExportSheets({ companies, contacts, projects }, overridesOf = () => null) {
  return [
    workbookSheet("Companies", companies.map((c) => workbookRow(c, overridesOf("account", c))), WORKBOOK_REQUIRED_COMPANY_HEADERS),
    workbookSheet("Contacts", contacts.map((c) => workbookRow(c, overridesOf("contact", c)))),
    workbookSheet("Projects", projects.map((p) => workbookRow(p, null))),
  ];
}
