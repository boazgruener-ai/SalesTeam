// Readers for the CSV imports (EXPORT_IMPORT_DESIGN.md 3.1, build step 2). Each format only READS its file into the
// research workbook's own row shape ({ companies, contacts }); everything after that - match, plan, check-first,
// safety copy, write, Decisions, logs - is the one import path every format shares (import-merge.js, storage.js).
//
//   detectImportFile(headers)  -> { format: "salesteam" | "hubspot" | "salesforce", kind: "accounts" | "contacts" } or null
//   salesteamCsvRows(records, kind)  -> rows from a file SalesTeam itself exported (Export… > SalesTeam columns)
//   applyFileCurrency(parsed, currency)  -> revenue without a currency is read as `currency` (D7, D15 case 3)
//   currencyPlausibility(pairs, chosen, money)  -> do the file's figures look like another currency? (D15)
//
// PURE - no chrome APIs, no storage, no DOM (test_pure_modules.py runs it).

import { parseLooseNumber, convertCurrency, extractCurrency, SUPPORTED_CURRENCIES } from "./value-normalize.js";
import { detectCrmFile, CRM_NAMES } from "./crm-files.js";

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

// D14: an export names its currency in the revenue titles - "Global Revenue (USD)" - and has no "… Currency" column.
// Read back (D15 case 2), the title's currency is that of every row without a currency column of its own (case 1).
const REVENUE_TITLES = { "global revenue": ["globalRevenue", "revenueCurrency"], "local revenue": ["swissRevenue", "swissRevenueCurrency"] };

// "Global Revenue (USD)" -> { field: "globalRevenue", currencyField: "revenueCurrency", currency: "USD" }, else null.
export function revenueTitleCurrency(label) {
  const m = String(label || "").trim().match(/^(.*\S)\s*\(([A-Za-z]{3})\)$/);
  const pair = m && REVENUE_TITLES[m[1].toLowerCase()];
  return pair ? { field: pair[0], currencyField: pair[1], currency: m[2].toUpperCase() } : null;
}

const NUMERIC = new Set(["globalEmployees", "globalRevenue", "swissEmployees", "swissRevenue", "aiPriorityScore"]);

// Columns only SalesTeam's own account export has - two of them tell it apart from any CRM file with a "Company" column.
const SALESTEAM_ACCOUNT_MARKERS = ["priority", "priority score", "priority reason", "readiness", "linkedin link", "web findings", "local / global", "size", "global revenue"];
const SALESTEAM_CONTACT_MARKERS = ["contact link", "business email", "job title", "seniority", "linkedin status"];

// Which file is this, from its header row alone. SalesTeam's own files are checked first: its contacts file has a
// "Name" column, which a HubSpot companies export also has.
export function detectImportFile(headers) {
  // "Global Revenue (USD)" counts as "global revenue" (D14).
  const h = new Set((headers || []).map((x) => String(x || "").trim().toLowerCase().replace(/\s*\([a-z]{3}\)$/, "")).filter(Boolean));
  const count = (names) => names.filter((n) => h.has(n)).length;
  const crmPerson = h.has("first name") || h.has("last name");
  if (h.has("name") && h.has("company") && !crmPerson && count(SALESTEAM_CONTACT_MARKERS) >= 1) return { format: "salesteam", kind: "contacts" };
  if (h.has("company") && !h.has("name") && !h.has("company name") && count(SALESTEAM_ACCOUNT_MARKERS) >= 2) return { format: "salesteam", kind: "accounts" };
  // Salesforce before HubSpot: both have First Name / Last Name / Email (crm-files.js tells them apart).
  const crm = detectCrmFile(headers);
  if (crm) return crm;
  if (crmPerson || h.has("email")) return { format: "hubspot", kind: "contacts" };
  if (h.has("company name") || h.has("company domain name") || (h.has("name") && h.has("record id"))) return { format: "hubspot", kind: "accounts" };
  return null;
}

// "a SalesTeam contacts file", "a HubSpot companies export" - for "This looks like …" when the chosen kind is wrong.
export function describeImportFile(detected) {
  if (!detected) return null;
  if (detected.format === "salesteam") return `a SalesTeam ${detected.kind} file`;
  if (CRM_NAMES[detected.format]) return `a ${CRM_NAMES[detected.format]} ${detected.kind} export`;
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
    const titled = {};
    for (const [label, raw] of Object.entries(record || {})) {
      const title = kind === "contacts" ? null : revenueTitleCurrency(label);
      const field = title ? title.field : columns[String(label).trim()];
      if (!field) continue;
      const v = cellValue(field, raw);
      if (v === null || v === undefined) continue;
      row[field] = v;
      if (title) titled[title.currencyField] = title.currency;
    }
    for (const [currencyField, currency] of Object.entries(titled)) if (!row[currencyField]) row[currencyField] = currency;
    if (kind === "contacts" ? !row.fullName : !row.company) continue;
    rows.push({ ...row, source: "CSV" });
  }
  return rows;
}

// D15 case 3: a file with revenue but no currency anywhere (HubSpot, or an older SalesTeam file whose currency column was
// empty) has its revenue read as `currency` - the one the Team Lead chose; it is never guessed.
export function applyFileCurrency(parsed, currency) {
  if (!currency) return parsed;
  const companies = (parsed.companies || []).map((r) => {
    const next = { ...r };
    if (next.globalRevenue != null && !next.revenueCurrency && !extractCurrency(next.globalRevenue)) next.revenueCurrency = currency;
    // A local revenue without a currency of its own is in the global one (import-merge.js, the web findings).
    if (next.swissRevenue != null && !next.swissRevenueCurrency && !next.revenueCurrency && !extractCurrency(next.swissRevenue)) next.swissRevenueCurrency = currency;
    return next;
  });
  return { ...parsed, companies };
}

// Does the file carry revenue without saying in which currency? Then Import asks for it (D15 case 3).
export function fileNeedsCurrency(parsed) {
  // A value that names its own currency ("CHF 102m", a research workbook cell) needs no question.
  const open = (v, ...currencies) => v != null && v !== "" && !currencies.some(Boolean) && !extractCurrency(v);
  return (parsed.companies || []).some((r) => open(r.globalRevenue, r.revenueCurrency) || open(r.swissRevenue, r.swissRevenueCurrency, r.revenueCurrency));
}

// D15 plausibility: the file's revenue, read in `chosen`, against what the same accounts already hold. pairs:
// [{ file, stored, storedCurrency }]; money: { targetCurrency, rates }. When the median ratio file / stored sits near 1
// the choice fits. When it sits near an exchange rate instead - CHF figures read as USD come out 1.25x too low against
// stored USD - and reading the file in another currency would bring it near 1, that currency is returned:
// { likely: "CHF", median, pairs }. Otherwise null: too few accounts to tell, or a gap no currency explains (other years,
// units), which is not this check's business.
export const PLAUSIBILITY_MIN_PAIRS = 3;
const CURRENCY_FIT = Math.log(1.05);

export function currencyPlausibility(pairs, chosen, money) {
  const rates = money && money.rates;
  const fallback = (money && money.targetCurrency) || chosen;
  const ratios = [];
  for (const p of pairs || []) {
    const file = convertCurrency(p.file, chosen, "USD", rates);
    const stored = convertCurrency(p.stored, p.storedCurrency || fallback, "USD", rates);
    if (file > 0 && stored > 0) ratios.push(file / stored);
  }
  if (ratios.length < PLAUSIBILITY_MIN_PAIRS) return null;
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid] : Math.sqrt(ratios[mid - 1] * ratios[mid]);
  const off = Math.abs(Math.log(median));
  if (off < CURRENCY_FIT) return null;
  let best = null;
  for (const code of SUPPORTED_CURRENCIES) {
    if (code === String(chosen).toUpperCase()) continue;
    // Reading the file in `code` multiplies each of its amounts by rate(code) / rate(chosen).
    const ratio = convertCurrency(median, code, chosen, rates);
    const codeOff = ratio > 0 ? Math.abs(Math.log(ratio)) : Infinity;
    if (!best || codeOff < best.off) best = { code, off: codeOff };
  }
  if (!best || best.off >= CURRENCY_FIT || best.off >= off / 2) return null;
  return { likely: best.code, median, pairs: ratios.length };
}
