// Readers for the CSV imports (EXPORT_IMPORT_DESIGN.md 3.1, build step 2). Each format only READS its file into the
// research workbook's own row shape ({ companies, contacts }); everything after that - match, plan, check-first,
// safety copy, write, Decisions, logs - is the one import path every format shares (import-merge.js, storage.js).
//
//   detectImportFile(headers)  -> { format: "salesteam" | "hubspot", kind: "accounts" | "contacts" } or null
//   salesteamCsvRows(records, kind)  -> rows from a file SalesTeam itself exported (Export… > SalesTeam columns)
//   applyFileCurrency(parsed, currency)  -> revenue without a currency is read as `currency` (D7)
//
// PURE - no chrome APIs, no storage, no DOM (test_pure_modules.py runs it).

import { parseLooseNumber } from "./value-normalize.js";

// The column titles of the Target Accounts table (target-accounts.js COMPANY_COLUMNS) that hold a stored value. The
// computed ones (Priority, Status, Readiness, Size, Groups, the scores …) are SalesTeam's own and are worked out again
// after the import, so they are not read back. Keep in step with COMPANY_COLUMNS' labels.
export const SALESTEAM_ACCOUNT_COLUMNS = {
  "Company": "company",
  "Industry": "industry",
  "LinkedIn Link": "linkedinLink",
  "Company Type": "companyType",
  "Employees": "globalEmployees",
  "Global Revenue": "globalRevenue",
  "Global Revenue Currency": "revenueCurrency",
  "Imported Priority Score": "aiPriorityScore",
  "Imported Priority": "aiPriority",
  "Imported Priority Rationale": "priorityRationale",
  "Research Status": "researchStatus",
  "Evidence Status": "evidenceStatus",
  "Registry Official Name": "zefixOfficialName",
  "Alternative Company Name": "alternativeCompanyName",
  "Company ID": "companyId",
  "Primary Source": "primarySourceUrl",
  "Portfolio Profile": "aiPortfolioProfile",
  "Registry ID": "zefixUid",
  "Registry Address": "zefixAddress",
  "Prospect Status": "prospectStatus",
  "Global HQ City": "globalHqCity",
  "Global HQ Country": "globalHqCountry",
  "Main Local Location": "mainSwissLocation",
  "Local Decision Authority": "swissDecisionAuthority",
  "Revenue Period": "revenuePeriod",
  "Global Revenue Confidence": "globalRevenueConfidence",
  "Local Revenue": "swissRevenue",
  "Local Revenue Currency": "swissRevenueCurrency",
  "Local Revenue Period": "swissRevenuePeriod",
  "Local Revenue Confidence": "swissRevenueConfidence",
  "Global Employees Period": "globalEmployeesPeriod",
  "Global Employees Confidence": "globalEmployeesConfidence",
  "Employee Count (LinkedIn band)": "employeeCountText",
  "Local Employees": "swissEmployees",
  "Local Employees Period": "swissEmployeesPeriod",
  "Local Employees Confidence": "swissEmployeesConfidence",
  "Investment (Global)": "aiInvestmentGlobal",
  "Investment (Local)": "aiInvestmentSwitzerland",
  "Investment Confidence": "aiInvestmentConfidence",
  "Top Initiatives": "topAiInitiatives",
};

// Same for the Target Contacts table (target-accounts.js CONTACT_LIST_COLUMNS). Not Seniority: the table shows the level
// worked out from the job title there, not a stored value (1.2.2.13 round-trip test: 1,248 contacts "filled").
export const SALESTEAM_CONTACT_COLUMNS = {
  "Name": "fullName",
  "Company": "company",
  "Job Title": "jobTitle",
  "Function": "function",
  "Contact Link": "lastVerified2",
  "Business Email": "publicBusinessEmail",
  "Business Phone": "publicBusinessPhone",
  "Relevance": "aiRelevance",
  "Local": "swissBased",
  "City": "city",
  "Country": "country",
  "LinkedIn Status": "evidenceQuality2",
  "Bio Page": "profileUrl",
  "Source": "sourceUrl",
  "Source Evidence Quality": "evidenceQuality",
};

const NUMERIC = new Set(["globalEmployees", "globalRevenue", "swissEmployees", "swissRevenue", "aiPriorityScore"]);

// Columns only SalesTeam's own account export has - two of them tell it apart from any CRM file with a "Company" column.
const SALESTEAM_ACCOUNT_MARKERS = ["priority", "priority score", "priority reason", "readiness", "linkedin link", "web findings", "local / global", "size", "global revenue"];
const SALESTEAM_CONTACT_MARKERS = ["contact link", "business email", "job title", "seniority", "linkedin status"];

// Which file is this, from its header row alone. SalesTeam's own files are checked first: its contacts file has a
// "Name" column, which a HubSpot companies export also has.
export function detectImportFile(headers) {
  const h = new Set((headers || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean));
  const count = (names) => names.filter((n) => h.has(n)).length;
  const crmPerson = h.has("first name") || h.has("last name");
  if (h.has("name") && h.has("company") && !crmPerson && count(SALESTEAM_CONTACT_MARKERS) >= 1) return { format: "salesteam", kind: "contacts" };
  if (h.has("company") && !h.has("name") && !h.has("company name") && count(SALESTEAM_ACCOUNT_MARKERS) >= 2) return { format: "salesteam", kind: "accounts" };
  if (crmPerson || h.has("email")) return { format: "hubspot", kind: "contacts" };
  if (h.has("company name") || h.has("company domain name") || (h.has("name") && h.has("record id"))) return { format: "hubspot", kind: "accounts" };
  return null;
}

// "a SalesTeam contacts file", "a HubSpot companies export" - for "This looks like …" when the chosen kind is wrong.
export function describeImportFile(detected) {
  if (!detected) return null;
  if (detected.format === "salesteam") return `a SalesTeam ${detected.kind} file`;
  return `a HubSpot ${detected.kind === "accounts" ? "companies" : "contacts"} export`;
}

function cellValue(field, raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (NUMERIC.has(field)) return parseLooseNumber(text);
  return text;
}

// A file SalesTeam exported, read back: the stored columns by their table titles, nothing else. New rows are
// marked source "CSV" (design 4.2); the file's Source column is a row's old source, not where this one comes from.
export function salesteamCsvRows(records, kind) {
  const columns = kind === "contacts" ? SALESTEAM_CONTACT_COLUMNS : SALESTEAM_ACCOUNT_COLUMNS;
  const rows = [];
  for (const record of records || []) {
    const row = {};
    for (const [label, raw] of Object.entries(record || {})) {
      const field = columns[String(label).trim()];
      if (!field) continue;
      const v = cellValue(field, raw);
      if (v !== null && v !== undefined) row[field] = v;
    }
    if (kind === "contacts" ? !row.fullName : !row.company) continue;
    rows.push({ ...row, source: "CSV" });
  }
  return rows;
}

// D7: a file with revenue but no currency column (HubSpot, or a SalesTeam file whose currency column was empty) has
// its revenue read as `currency` - the display currency unless the Team Lead picks another in the Import dialog.
export function applyFileCurrency(parsed, currency) {
  if (!currency) return parsed;
  const companies = (parsed.companies || []).map((r) => {
    const next = { ...r };
    if (next.globalRevenue != null && !next.revenueCurrency) next.revenueCurrency = currency;
    if (next.swissRevenue != null && !next.swissRevenueCurrency) next.swissRevenueCurrency = currency;
    return next;
  });
  return { ...parsed, companies };
}

// Does the file carry revenue without saying in which currency? Then the Import dialog's currency choice applies.
export function fileNeedsCurrency(parsed) {
  return (parsed.companies || []).some((r) => (r.globalRevenue != null && !r.revenueCurrency) || (r.swissRevenue != null && !r.swissRevenueCurrency));
}
