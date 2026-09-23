// HubSpot import / export by FILE (no HubSpot login, no API key, no extra permission).
//   Export: two CSV files (companies, contacts) whose column names are HubSpot's own property labels, so HubSpot's
//           import tool maps them automatically. SalesTeam-only values go in extra columns ("SalesTeam ...") that
//           HubSpot offers to create as new properties.
//   Import: a CSV exported from HubSpot (companies or contacts). Only ADDS what SalesTeam does not have yet - it
//           never replaces or deletes anything.
import { toCsv } from "./csv-export.js";
import { normalizeCompanyName } from "./storage.js";

// ------------------------------------------------------------------ CSV reader (RFC 4180: quotes, commas, newlines)
export function parseCsv(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { headers, records };
}

// The value of the first column whose header matches one of the (case-insensitive) names.
function pick(record, names) {
  const lower = Object.fromEntries(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) if (lower[n] !== undefined && lower[n] !== "") return lower[n];
  return "";
}

function toNumber(text) {
  if (!text) return null;
  const n = Number(String(text).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && String(text).match(/\d/) ? n : null;
}

// "companies" or "contacts", judged from the header row.
export function detectHubspotFile(headers) {
  const h = headers.map((x) => x.toLowerCase());
  if (h.includes("first name") || h.includes("last name") || h.includes("email")) return "contacts";
  if (h.includes("company name") || h.includes("company domain name") || h.includes("name")) return "companies";
  return null;
}

let counter = 0;
function slugId(prefix, text) {
  counter++;
  return `${prefix}-${normalizeCompanyName(text).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x"}-${counter}`;
}

export function hubspotCompanyRows(records) {
  const rows = [];
  for (const r of records) {
    const company = pick(r, ["company name", "name"]);
    if (!company) continue;
    const recordId = pick(r, ["record id", "company id"]);
    const domain = pick(r, ["company domain name", "website url", "domain"]);
    rows.push({
      companyId: recordId ? `HS-${recordId}` : slugId("HS", company),
      company,
      industry: pick(r, ["industry"]) || null,
      globalEmployees: toNumber(pick(r, ["number of employees", "employees"])),
      globalRevenue: toNumber(pick(r, ["annual revenue", "revenue"])),
      globalHqCity: pick(r, ["city"]) || null,
      globalHqCountry: pick(r, ["country/region", "country"]) || null,
      linkedinLink: pick(r, ["linkedin company page", "linkedin url", "linkedin"]) || null,
      primarySourceUrl: domain ? (domain.startsWith("http") ? domain : `https://${domain}`) : null,
      researchStatus: "Imported from HubSpot",
      source: "HubSpot",
    });
  }
  return rows;
}

export function hubspotContactRows(records) {
  const rows = [];
  for (const r of records) {
    const first = pick(r, ["first name"]);
    const last = pick(r, ["last name"]);
    const fullName = `${first} ${last}`.trim() || pick(r, ["name", "full name"]);
    const company = pick(r, ["associated company", "company name", "company"]);
    if (!fullName || !company) continue;
    const recordId = pick(r, ["record id", "contact id"]);
    rows.push({
      contactId: recordId ? `HS-${recordId}` : slugId("HSC", fullName),
      company,
      fullName,
      jobTitle: pick(r, ["job title"]) || null,
      publicBusinessEmail: pick(r, ["email"]) || null,
      publicBusinessPhone: pick(r, ["phone number", "mobile phone number"]) || null,
      lastVerified2: pick(r, ["linkedin url", "linkedin profile", "linkedin"]) || null,
      source: "HubSpot",
    });
  }
  return rows;
}

// ------------------------------------------------------------------ export
const COMPANY_HEADERS = [
  "Company name", "Industry", "City", "Country/Region", "Number of Employees", "Annual Revenue", "LinkedIn Company Page",
  "Description", "SalesTeam Priority", "SalesTeam Priority Score", "SalesTeam Status",
];
const CONTACT_HEADERS = [
  "First Name", "Last Name", "Email", "Phone Number", "Job Title", "Company name", "LinkedIn URL",
  "SalesTeam Seniority", "SalesTeam Function", "SalesTeam Status",
];

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/);
  if (parts.length <= 1) return [parts[0] || "", ""];
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
}

// companies / contacts: the rows to export; statusOf(kind, row) -> "Not contacted" | "Contacted" | "Responded"
export function buildHubspotFiles(companies, contacts, statusOfCompany, statusOfContact) {
  const companyRows = companies.map((c) => [
    c.company, c.industry || "", c.globalHqCity || "", c.globalHqCountry || "",
    c.globalEmployees ?? "", c.globalRevenue ?? "", c.linkedinLink || "",
    [].concat(c.topAiInitiatives || c.topInitiatives || "").join("; "),
    c.salesTeamPriority || "", c.salesTeamPriorityScore != null ? Math.round(c.salesTeamPriorityScore) : "",
    statusOfCompany(c),
  ]);
  const contactRows = contacts.map((c) => {
    const [first, last] = splitName(c.fullName);
    return [
      first, last, c.publicBusinessEmail || "", c.publicBusinessPhone || "", c.jobTitle || "", c.company || "",
      c.lastVerified2 || "", c.seniorityLevel || c.seniority || "", c.function || "", statusOfContact(c),
    ];
  });
  return {
    companiesCsv: toCsv(COMPANY_HEADERS, companyRows),
    contactsCsv: toCsv(CONTACT_HEADERS, contactRows),
    companyCount: companyRows.length,
    contactCount: contactRows.length,
  };
}
