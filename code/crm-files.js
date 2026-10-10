// CRM files without a CRM login (EXPORT_IMPORT_DESIGN.md 8, 8a, D11): Salesforce today, Microsoft Dynamics 365 Sales
// once the header rows of a real export are in (Q10). One column table per CRM; the same functions read and write
// every CRM's files.
//
//   buildCrmFiles(crm, companies, contacts, opts)  -> { accountsCsv, contactsCsv, accountCount, contactCount }
//   crmAccountRows(crm, records) / crmContactRows(crm, records)  -> research-workbook rows, for the one import path
//   detectCrmFile(headers)  -> { format: crm, kind: "accounts" | "contacts" } or null (csv-import.js detectImportFile)
//
// Export writes exactly the titles of Salesforce's own sample files, in their order, so the Data Import Wizard maps
// every column by itself (design 8, agreed 2026-10-09). What SalesTeam knows beyond them goes into Description as
// "Label: value" lines - read back on import, so a file goes out and comes back in unchanged.
//
// PURE - no chrome APIs, no storage, no DOM (test_pure_modules.py runs it).

import { parseLooseNumber } from "./value-normalize.js";

// One entry per column: the title the export writes (the wizard's field label) and the API names a Data Loader file
// or a report export may use instead. `field` is the workbook row field the import reads it into.
export const CRM_COLUMNS = {
  salesforce: {
    accounts: [
      { label: "Account Name", api: ["name", "account.name"], field: "company", max: 255 },
      { label: "Annual Revenue", api: ["annualrevenue"], field: "globalRevenue" },
      { label: "Billing Street", api: ["billingstreet"], max: 255 },
      { label: "Billing City", api: ["billingcity"], max: 40 },
      { label: "Billing State/Province", api: ["billingstate"] },
      { label: "Billing Zip/Postal Code", api: ["billingpostalcode"], max: 20 },
      { label: "Billing Country", api: ["billingcountry"], max: 80 },
      { label: "Description", api: ["description"] },
      { label: "Employees", api: ["numberofemployees"], field: "globalEmployees" },
      { label: "Fax", api: ["fax"] },
      { label: "Industry", api: ["industry"], field: "industry", max: 255 },
      { label: "Phone", api: ["phone"] },
      { label: "Shipping Street", api: ["shippingstreet"] },
      { label: "Shipping City", api: ["shippingcity"] },
      { label: "Shipping State/Province", api: ["shippingstate"] },
      { label: "Shipping Zip/Postal Code", api: ["shippingpostalcode"] },
      { label: "Shipping Country", api: ["shippingcountry"] },
      { label: "Type", api: ["type"] },
      { label: "Website", api: ["website"], max: 255 },
    ],
    contacts: [
      { label: "First Name", api: ["firstname"], max: 40 },
      { label: "Last Name", api: ["lastname"], max: 80 },
      { label: "Email", api: ["email"], field: "publicBusinessEmail", max: 80 },
      { label: "Phone", api: ["phone"], field: "publicBusinessPhone", max: 40 },
      { label: "Title", api: ["title"], field: "jobTitle", max: 128 },
      { label: "Account Name", api: ["account.name", "accountname"], field: "company" },
      { label: "Mailing Street", api: ["mailingstreet"] },
      { label: "Mailing City", api: ["mailingcity"], field: "city", max: 40 },
      { label: "Mailing State/Province", api: ["mailingstate"] },
      { label: "Mailing Zip/Postal Code", api: ["mailingpostalcode"] },
      { label: "Mailing Country", api: ["mailingcountry"], field: "country", max: 80 },
      { label: "Lead Source", api: ["leadsource"] },
      { label: "Consent Status", api: [] },
      { label: "Description", api: ["description"] },
    ],
    // Record ids in a report or Data Loader export - kept as the row's id so a second import of the same file
    // matches by them.
    idColumns: { accounts: ["account id", "id"], contacts: ["contact id", "id"] },
    idPrefix: "SF",
    name: "Salesforce",
  },
};

export const CRM_NAMES = Object.fromEntries(Object.entries(CRM_COLUMNS).map(([k, v]) => [k, v.name]));

// The lines SalesTeam writes into Description and reads back. SALESTEAM_ID marks a file SalesTeam exported: in such a
// file the Billing / Mailing columns were worked out from these lines and are not read again.
const DESCRIPTION_LINES = {
  accounts: [
    ["Company type", "companyType"],
    ["LinkedIn", "linkedinLink"],
    ["HQ city", "globalHqCity"],
    ["HQ country", "globalHqCountry"],
    ["Registry address", "zefixAddress"],
  ],
  contacts: [
    ["LinkedIn", "lastVerified2"],
  ],
};
const SALESTEAM_ID = "SalesTeam id";

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
// UTF-8 byte-order mark and CRLF, as csv-export.js toCsv writes (what Excel and the wizard expect).
function toCsv(headers, rows) {
  return "﻿" + [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return [parts[0] || "", ""];
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
}

const COUNTRY_LIKE = /^[A-Za-z][A-Za-z .'-]{3,}$/;

// "Rütistrasse 12, 8952 Schlieren" -> { street, zip, city }; "…, 1023 Crissier, VD, Switzerland" also gives state and
// country. An address in no such shape (e.g. "Meilen, Switzerland") -> null.
export function splitRegistryAddress(address) {
  const parts = String(address || "").split(",").map((s) => s.trim()).filter(Boolean);
  const at = parts.findIndex((p) => /^\d{4,5}\s+\S/.test(p));
  if (at < 1) return null;
  const [, zip, city] = parts[at].match(/^(\d{4,5})\s+(.+)$/);
  const tail = parts.slice(at + 1);
  const country = tail.length && COUNTRY_LIKE.test(tail[tail.length - 1]) ? tail.pop() : null;
  return { street: parts.slice(0, at).join(", "), zip, city, state: tail.join(", ") || null, country };
}

// Billing address (design 8): the registry address where there is one, else the HQ city and country. The registry is
// the local company register, so its country is the one the address names, else `registryCountry` (the single target
// country from Setup), else the HQ country when the HQ is in the same city; otherwise it stays empty rather than
// putting a Swiss street under a French HQ.
function billingOf(c, registryCountry) {
  const reg = splitRegistryAddress(c.zefixAddress);
  if (reg) {
    const sameCity = c.globalHqCity && String(c.globalHqCity).trim().toLowerCase() === reg.city.toLowerCase();
    // No state: with Salesforce's state and country lists on, a canton ("VD" for McDonald's Switzerland) is refused
    // for a country without states there (live test 2026-10-10). It stays in Description's registry address.
    return { street: reg.street, city: reg.city, state: "", zip: reg.zip, country: reg.country || registryCountry || (sameCity ? c.globalHqCountry : "") || "" };
  }
  return { street: "", city: shortCity(c.globalHqCity), state: "", zip: "", country: c.globalHqCountry || "" };
}

// A city field holds one city: "Harrison, New York (global); Geneva (Swiss/European office)" (PepsiCo, refused at
// 63 characters - Salesforce allows 40) -> "Harrison, New York". The whole text stays in Description's "HQ city" line.
export function shortCity(text) {
  let city = String(text || "").split(/[;(]/)[0].trim();
  if (city.length > 40) city = city.split(",")[0].trim();
  return city;
}

// Salesforce's Employees is a whole number: "72.8" was refused for six accounts (live test 2026-10-10).
function wholeNumber(v) {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "number" ? v : parseLooseNumber(v);
  return Number.isFinite(n) ? Math.round(n) : "";
}

// A value longer than its column allows refuses the whole row, so it is cut to the limit.
function fit(col, value) {
  const text = value ?? "";
  return col.max && typeof text === "string" && text.length > col.max ? text.slice(0, col.max).trim() : text;
}

function descriptionText(kind, row, extra) {
  const lines = [...extra];
  for (const [label, field] of DESCRIPTION_LINES[kind]) {
    const v = row[field];
    if (v != null && String(v).trim() !== "") lines.push(`${label}: ${String(v).replace(/\s*[\r\n]+\s*/g, " ").trim()}`);
  }
  const id = kind === "accounts" ? row.companyId : row.contactId;
  if (id) lines.push(`${SALESTEAM_ID}: ${id}`);
  return lines.join("\n");
}

// Salesforce's Account Type list: Customer, Partner, Prospect … (the samples hold Customer / Reseller). A customer that
// is also a partner is a Customer.
function accountType(relationship) {
  const rel = relationship || [];
  return rel.includes("customer") ? "Customer" : rel.includes("partner") ? "Partner" : "Prospect";
}

// companies: the rows as the table shows them (overrides applied), revenue already in the default currency (D14),
// with `relationship` (["customer", "partner"]), `salesTeamPriority` and `salesTeamPriorityScore`.
// contacts: the rows as shown. opts.registryCountry: see billingOf.
export function buildCrmFiles(crm, companies, contacts, opts = {}) {
  const table = CRM_COLUMNS[crm];
  if (!table) throw new Error(`Unknown CRM "${crm}"`);
  const accountRows = (companies || []).map((c) => {
    const b = billingOf(c, opts.registryCountry);
    const priority = c.salesTeamPriority
      ? `SalesTeam priority: ${c.salesTeamPriority}${c.salesTeamPriorityScore != null ? ` (score ${Math.round(c.salesTeamPriorityScore)})` : ""}`
      : null;
    const website = c.website || "";
    const byLabel = {
      "Account Name": c.company,
      "Annual Revenue": wholeNumber(c.globalRevenue),
      "Billing Street": b.street, "Billing City": b.city, "Billing State/Province": b.state,
      "Billing Zip/Postal Code": b.zip, "Billing Country": b.country,
      "Description": descriptionText("accounts", c, priority ? [priority] : []),
      "Employees": wholeNumber(c.globalEmployees),
      "Industry": c.industry || "",
      "Type": accountType(c.relationship),
      "Website": website,
    };
    return table.accounts.map((col) => fit(col, byLabel[col.label]));
  });
  const contactRows = (contacts || []).map((p) => {
    const [first, last] = splitName(p.fullName);
    const byLabel = {
      "First Name": first, "Last Name": last,
      "Email": p.publicBusinessEmail || "", "Phone": p.publicBusinessPhone || "", "Title": p.jobTitle || "",
      // Exactly as in the accounts file, so the wizard links each contact to its account.
      "Account Name": p.company || "",
      "Mailing City": shortCity(p.city), "Mailing Country": p.country || "",
      // No LinkedIn value in the standard list; "Other" exists in every org. Consent Status stays empty: SalesTeam
      // never knows whether a person agreed to marketing.
      "Lead Source": "Other",
      "Description": descriptionText("contacts", p, []),
    };
    return table.contacts.map((col) => fit(col, byLabel[col.label]));
  });
  return {
    accountsCsv: toCsv(table.accounts.map((c) => c.label), accountRows),
    contactsCsv: toCsv(table.contacts.map((c) => c.label), contactRows),
    accountCount: accountRows.length,
    contactCount: contactRows.length,
  };
}

// ------------------------------------------------------------------ import

function lowerKeys(record) {
  return Object.fromEntries(Object.entries(record || {}).map(([k, v]) => [String(k).trim().toLowerCase(), String(v ?? "").trim()]));
}

// The value of a column, by its title or any of its API names.
function cell(lower, col) {
  for (const name of [col.label.toLowerCase(), ...col.api]) if (lower[name]) return lower[name];
  return "";
}
function column(table, kind, label) {
  return table[kind].find((c) => c.label === label);
}

function readDescription(kind, text) {
  const out = {};
  let salesteam = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1] === SALESTEAM_ID) { salesteam = true; continue; }
    const hit = DESCRIPTION_LINES[kind].find(([label]) => label === m[1]);
    if (hit) out[hit[1]] = m[2];
  }
  return { fields: out, salesteam };
}

function withHttp(url) {
  const u = String(url || "").trim();
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

let counter = 0;
function rowId(prefix, recordId, name) {
  if (recordId) return `${prefix}-${recordId}`;
  counter++;
  return `${prefix}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x"}-${counter}`;
}

function recordIdOf(lower, names) {
  for (const n of names) if (lower[n]) return lower[n];
  return "";
}

export function crmAccountRows(crm, records) {
  const table = CRM_COLUMNS[crm];
  const rows = [];
  for (const record of records || []) {
    const lower = lowerKeys(record);
    const company = cell(lower, column(table, "accounts", "Account Name"));
    if (!company) continue;
    const desc = readDescription("accounts", cell(lower, column(table, "accounts", "Description")));
    const row = { company };
    for (const col of table.accounts) {
      if (!col.field || col.field === "company") continue;
      const raw = cell(lower, col);
      if (!raw) continue;
      // Revenue keeps a currency it names ("CHF 102m"); a plain number is read in the currency the Team Lead
      // chooses (D15 case 3, applyFileCurrency).
      row[col.field] = col.field === "globalEmployees" ? parseLooseNumber(raw) : raw;
    }
    if (row.globalRevenue != null) {
      const n = parseLooseNumber(row.globalRevenue);
      if (/^[\d\s.,'’]+$/.test(row.globalRevenue) && n != null) row.globalRevenue = n;
    }
    if (row.globalEmployees == null) delete row.globalEmployees;
    const website = withHttp(cell(lower, column(table, "accounts", "Website")));
    if (website) row.website = website;
    Object.assign(row, desc.fields);
    // A SalesTeam export's Billing columns were worked out from the Description lines above - read nothing twice.
    // A CRM's own file: the billing address is where the company is.
    if (!desc.salesteam) {
      const city = cell(lower, column(table, "accounts", "Billing City"));
      const country = cell(lower, column(table, "accounts", "Billing Country"));
      if (city) row.globalHqCity = city;
      if (country) row.globalHqCountry = country;
    }
    const recordId = recordIdOf(lower, table.idColumns.accounts);
    rows.push({ ...row, companyId: rowId(table.idPrefix, recordId, company), researchStatus: `Imported from ${table.name}`, source: table.name });
  }
  return rows;
}

export function crmContactRows(crm, records) {
  const table = CRM_COLUMNS[crm];
  const rows = [];
  for (const record of records || []) {
    const lower = lowerKeys(record);
    const first = cell(lower, column(table, "contacts", "First Name"));
    const last = cell(lower, column(table, "contacts", "Last Name"));
    const fullName = `${first} ${last}`.trim() || lower["full name"] || lower.name || "";
    const company = cell(lower, column(table, "contacts", "Account Name"));
    if (!fullName || !company) continue;
    const row = { company, fullName };
    for (const col of table.contacts) {
      if (!col.field || col.field === "company") continue;
      const raw = cell(lower, col);
      if (raw) row[col.field] = raw;
    }
    Object.assign(row, readDescription("contacts", cell(lower, column(table, "contacts", "Description"))).fields);
    const recordId = recordIdOf(lower, table.idColumns.contacts);
    rows.push({ ...row, contactId: rowId(table.idPrefix, recordId, fullName), source: table.name });
  }
  return rows;
}

// From the header row alone. Salesforce: "Account Name" (accounts file) or a person with an "Account Name" / Mailing /
// Lead Source column (contacts) - HubSpot says "Company name" and "Associated Company" instead.
export function detectCrmFile(headers) {
  const h = new Set((headers || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean));
  const person = h.has("first name") || h.has("last name") || h.has("firstname") || h.has("lastname");
  const sfContact = ["account name", "account.name", "mailing city", "mailing country", "mailingcity", "mailingcountry", "lead source", "leadsource"];
  if (person && sfContact.some((n) => h.has(n))) return { format: "salesforce", kind: "contacts" };
  if (!person && (h.has("account name") || h.has("billing country") || h.has("billingcountry") || (h.has("name") && (h.has("annualrevenue") || h.has("numberofemployees")))))
    return { format: "salesforce", kind: "accounts" };
  return null;
}
