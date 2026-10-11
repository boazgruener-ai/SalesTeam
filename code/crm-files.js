// CRM files without a CRM login (EXPORT_IMPORT_DESIGN.md 8, 8a, D11): Salesforce and Microsoft Dynamics 365 Sales.
// One column table per CRM; the same functions read and write every CRM's files.
//
//   buildCrmFiles(crm, companies, contacts, opts)  -> { accountsCsv, contactsCsv, accountCount, contactCount }
//   crmAccountRows(crm, records) / crmContactRows(crm, records)  -> research-workbook rows, for the one import path
//   detectCrmFile(headers, preferred)  -> { format: crm, kind: "accounts" | "contacts" } or null (csv-import.js detectImportFile)
//
// Export writes exactly the titles of Salesforce's own sample files, in their order, so the Data Import Wizard maps
// every column by itself (design 8, agreed 2026-10-09); for Dynamics, the display names of its standard columns, which
// its Import Data wizard maps the same way (design 8a). What SalesTeam knows beyond them goes into Description as
// "Label: value" lines - read back on import, so a file goes out and comes back in unchanged.
//
// PURE - no chrome APIs, no storage, no DOM (test_pure_modules.py runs it).

import { parseLooseNumber } from "./value-normalize.js";

// One entry per column: the title the export writes (the wizard's field label) and the API names a Data Loader file
// or a report export may use instead. `key` says what the column holds, the same word in every CRM (a column without
// one is written empty and not read); `field` is the workbook row field the import reads it into. A column marked
// `importOnly` is read from the CRM's own files but never written.
export const CRM_COLUMNS = {
  salesforce: {
    accounts: [
      { key: "name", label: "Account Name", api: ["name", "account.name"], field: "company", max: 255 },
      { key: "revenue", label: "Annual Revenue", api: ["annualrevenue"], field: "globalRevenue" },
      { key: "street", label: "Billing Street", api: ["billingstreet"], max: 255 },
      { key: "city", label: "Billing City", api: ["billingcity"], max: 40 },
      { key: "state", label: "Billing State/Province", api: ["billingstate"] },
      { key: "zip", label: "Billing Zip/Postal Code", api: ["billingpostalcode"], max: 20 },
      { key: "country", label: "Billing Country", api: ["billingcountry"], max: 80 },
      { key: "description", label: "Description", api: ["description"] },
      { key: "employees", label: "Employees", api: ["numberofemployees"], field: "globalEmployees" },
      { label: "Fax", api: ["fax"] },
      { key: "industry", label: "Industry", api: ["industry"], field: "industry", max: 255 },
      { label: "Phone", api: ["phone"] },
      { label: "Shipping Street", api: ["shippingstreet"] },
      { label: "Shipping City", api: ["shippingcity"] },
      { label: "Shipping State/Province", api: ["shippingstate"] },
      { label: "Shipping Zip/Postal Code", api: ["shippingpostalcode"] },
      { label: "Shipping Country", api: ["shippingcountry"] },
      { key: "type", label: "Type", api: ["type"] },
      { key: "website", label: "Website", api: ["website"], max: 255 },
    ],
    contacts: [
      { key: "first", label: "First Name", api: ["firstname"], max: 40 },
      { key: "last", label: "Last Name", api: ["lastname"], max: 80 },
      { key: "email", label: "Email", api: ["email"], field: "publicBusinessEmail", max: 80 },
      { key: "phone", label: "Phone", api: ["phone"], field: "publicBusinessPhone", max: 40 },
      { key: "title", label: "Title", api: ["title"], field: "jobTitle", max: 128 },
      { key: "account", label: "Account Name", api: ["account.name", "accountname"], field: "company" },
      { label: "Mailing Street", api: ["mailingstreet"] },
      { key: "city", label: "Mailing City", api: ["mailingcity"], field: "city", max: 40 },
      { label: "Mailing State/Province", api: ["mailingstate"] },
      { label: "Mailing Zip/Postal Code", api: ["mailingpostalcode"] },
      { key: "country", label: "Mailing Country", api: ["mailingcountry"], field: "country", max: 80 },
      { key: "leadSource", label: "Lead Source", api: ["leadsource"] },
      { label: "Consent Status", api: [] },
      { key: "description", label: "Description", api: ["description"] },
    ],
    // Record ids in a report or Data Loader export - kept as the row's id so a second import of the same file
    // matches by them.
    idColumns: { accounts: ["account id", "id"], contacts: ["contact id", "id"] },
    idPrefix: "SF",
    name: "Salesforce",
    short: "Salesforce",
  },
  // Microsoft Dynamics 365 Sales (design 8a): the display names of the standard Account and Contact columns, and their
  // field names. Taken from Microsoft's documentation, not yet from a real export - see the live check in design 8a.
  dynamics: {
    accounts: [
      { key: "name", label: "Account Name", api: ["name"], field: "company", max: 160 },
      { key: "website", label: "Website", api: ["websiteurl"], max: 200 },
      { key: "type", label: "Relationship Type", api: ["customertypecode"] },
      { key: "employees", label: "Number of Employees", api: ["numberofemployees", "no. of employees"], field: "globalEmployees" },
      { key: "revenue", label: "Annual Revenue", api: ["revenue"], field: "globalRevenue" },
      { key: "street", label: "Address 1: Street 1", api: ["address1_line1"], max: 250 },
      { key: "city", label: "Address 1: City", api: ["address1_city"], max: 80 },
      { key: "zip", label: "Address 1: ZIP/Postal Code", api: ["address1_postalcode"], max: 20 },
      { key: "country", label: "Address 1: Country/Region", api: ["address1_country"], max: 80 },
      { key: "description", label: "Description", api: ["description"], max: 2000 },
      // Industry is a fixed list of values in Dynamics, and a value outside it stops the row - so SalesTeam writes its
      // industry into Description and only reads this column from an organisation's own file.
      { key: "industry", label: "Industry", api: ["industrycode"], field: "industry", importOnly: true },
      { key: "currency", label: "Currency", api: ["transactioncurrencyid"], importOnly: true },
    ],
    contacts: [
      { key: "first", label: "First Name", api: ["firstname"], max: 50 },
      { key: "last", label: "Last Name", api: ["lastname"], max: 50 },
      { key: "title", label: "Job Title", api: ["jobtitle"], field: "jobTitle", max: 100 },
      { key: "email", label: "Email", api: ["emailaddress1"], field: "publicBusinessEmail", max: 100 },
      { key: "phone", label: "Business Phone", api: ["telephone1"], field: "publicBusinessPhone", max: 50 },
      { key: "account", label: "Company Name", api: ["parentcustomerid", "parentcustomeridname", "account name"], field: "company" },
      { key: "city", label: "Address 1: City", api: ["address1_city"], field: "city", max: 80 },
      { key: "country", label: "Address 1: Country/Region", api: ["address1_country"], field: "country", max: 80 },
      { key: "description", label: "Description", api: ["description"], max: 2000 },
    ],
    // "Export to Excel" puts the record's id into a hidden first column, "(Do Not Modify) Account" / "… Contact".
    idColumns: { accounts: ["(do not modify) account", "accountid"], contacts: ["(do not modify) contact", "contactid"] },
    idPrefix: "DYN",
    name: "Microsoft Dynamics",
    short: "Dynamics",
    industryInDescription: true,
  },
};

export const CRM_NAMES = Object.fromEntries(Object.entries(CRM_COLUMNS).map(([k, v]) => [k, v.name]));
// The one-word name used in file names ("SalesTeam-Dynamics-accounts-…").
export const CRM_SHORT_NAMES = Object.fromEntries(Object.entries(CRM_COLUMNS).map(([k, v]) => [k, v.short]));

// The lines SalesTeam writes into Description and reads back. SALESTEAM_ID marks a file SalesTeam exported: in such a
// file the Billing / Mailing columns were worked out from these lines and are not read again.
const DESCRIPTION_LINES = {
  accounts: [
    ["Industry", "industry"], // written only where the CRM's own Industry column cannot take it (industryInDescription)
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

function descriptionText(kind, row, extra, table) {
  const lines = [...extra];
  for (const [label, field] of DESCRIPTION_LINES[kind]) {
    if (field === "industry" && !table.industryInDescription) continue;
    const v = row[field];
    if (v != null && String(v).trim() !== "") lines.push(`${label}: ${String(v).replace(/\s*[\r\n]+\s*/g, " ").trim()}`);
  }
  const id = kind === "accounts" ? row.companyId : row.contactId;
  if (id) lines.push(`${SALESTEAM_ID}: ${id}`);
  return lines.join("\n");
}

// Salesforce's Account Type list: Customer, Partner, Prospect … (the samples hold Customer / Reseller); Dynamics'
// Relationship Type has the same three. A customer that is also a partner is a Customer.
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
  const accountCols = table.accounts.filter((col) => !col.importOnly);
  const contactCols = table.contacts.filter((col) => !col.importOnly);
  const accountRows = (companies || []).map((c) => {
    const b = billingOf(c, opts.registryCountry);
    const priority = c.salesTeamPriority
      ? `SalesTeam priority: ${c.salesTeamPriority}${c.salesTeamPriorityScore != null ? ` (score ${Math.round(c.salesTeamPriorityScore)})` : ""}`
      : null;
    const website = c.website || "";
    const byKey = {
      name: c.company,
      revenue: wholeNumber(c.globalRevenue),
      street: b.street, city: b.city, state: b.state, zip: b.zip, country: b.country,
      description: descriptionText("accounts", c, priority ? [priority] : [], table),
      employees: wholeNumber(c.globalEmployees),
      industry: c.industry || "",
      type: accountType(c.relationship),
      website,
    };
    return accountCols.map((col) => fit(col, byKey[col.key]));
  });
  const contactRows = (contacts || []).map((p) => {
    const [first, last] = splitName(p.fullName);
    const byKey = {
      first, last,
      email: p.publicBusinessEmail || "", phone: p.publicBusinessPhone || "", title: p.jobTitle || "",
      // Exactly as in the accounts file, so the wizard links each contact to its account.
      account: p.company || "",
      city: shortCity(p.city), country: p.country || "",
      // No LinkedIn value in the standard list; "Other" exists in every org. Consent Status stays empty: SalesTeam
      // never knows whether a person agreed to marketing.
      leadSource: "Other",
      description: descriptionText("contacts", p, [], table),
    };
    return contactCols.map((col) => fit(col, byKey[col.key]));
  });
  return {
    accountsCsv: toCsv(accountCols.map((c) => c.label), accountRows),
    contactsCsv: toCsv(contactCols.map((c) => c.label), contactRows),
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
  if (!col) return "";
  for (const name of [col.label.toLowerCase(), ...col.api]) if (lower[name]) return lower[name];
  return "";
}
function column(table, kind, key) {
  return table[kind].find((c) => c.key === key);
}

// Dynamics' Currency column names the currency ("Swiss Franc") or gives its code; a name not listed here is left
// open, so Import asks (D15 case 3) instead of guessing.
const CURRENCY_NAMES = {
  "us dollar": "USD", "united states dollar": "USD", "dollar": "USD", "euro": "EUR", "swiss franc": "CHF",
  "pound sterling": "GBP", "british pound": "GBP", "uk pound": "GBP", "japanese yen": "JPY", "yen": "JPY",
  "canadian dollar": "CAD", "australian dollar": "AUD", "swedish krona": "SEK", "norwegian krone": "NOK",
  "danish krone": "DKK", "singapore dollar": "SGD", "hong kong dollar": "HKD", "indian rupee": "INR",
  "chinese yuan": "CNY", "yuan renminbi": "CNY", "brazilian real": "BRL", "south african rand": "ZAR",
  "polish zloty": "PLN", "czech koruna": "CZK",
};
export function currencyOfName(text) {
  const t = String(text || "").trim();
  if (/^[A-Za-z]{3}$/.test(t)) return t.toUpperCase();
  return CURRENCY_NAMES[t.toLowerCase()] || null;
}

function readDescription(kind, text) {
  const out = {};
  let salesteam = false;
  let id = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1] === SALESTEAM_ID) { salesteam = true; id = m[2]; continue; }
    const hit = DESCRIPTION_LINES[kind].find(([label]) => label === m[1]);
    if (hit) out[hit[1]] = m[2];
  }
  return { fields: out, salesteam, id };
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
    const company = cell(lower, column(table, "accounts", "name"));
    if (!company) continue;
    const desc = readDescription("accounts", cell(lower, column(table, "accounts", "description")));
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
    const currency = currencyOfName(cell(lower, column(table, "accounts", "currency")));
    if (currency && row.globalRevenue != null) row.revenueCurrency = currency;
    const website = withHttp(cell(lower, column(table, "accounts", "website")));
    if (website) row.website = website;
    Object.assign(row, desc.fields);
    // A SalesTeam export's Billing columns were worked out from the Description lines above - read nothing twice.
    // A CRM's own file: the billing address is where the company is.
    if (!desc.salesteam) {
      const city = cell(lower, column(table, "accounts", "city"));
      const country = cell(lower, column(table, "accounts", "country"));
      if (city) row.globalHqCity = city;
      if (country) row.globalHqCountry = country;
    }
    const recordId = recordIdOf(lower, table.idColumns.accounts);
    rows.push({ ...row, companyId: rowId(table.idPrefix, recordId, company), researchStatus: `Imported from ${table.name}`, source: table.name });
  }
  return rows;
}

// A Full Name column written "Muster, Anna" (Dynamics' full-name format is a setting of the organisation; seen in a
// real export) -> "Anna Muster". A name with no comma, or with more than one, is left as it is.
function firstNameFirst(fullName) {
  const parts = String(fullName).split(",").map((p) => p.trim());
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : String(fullName).trim();
}

export function crmContactRows(crm, records) {
  const table = CRM_COLUMNS[crm];
  const rows = [];
  for (const record of records || []) {
    const lower = lowerKeys(record);
    const first = cell(lower, column(table, "contacts", "first"));
    const last = cell(lower, column(table, "contacts", "last"));
    const fullName = `${first} ${last}`.trim() || firstNameFirst(lower["full name"] || lower.fullname || lower.name || "");
    const company = cell(lower, column(table, "contacts", "account"));
    if (!fullName || !company) continue;
    const row = { company, fullName };
    for (const col of table.contacts) {
      if (!col.field || col.field === "company") continue;
      const raw = cell(lower, col);
      if (raw) row[col.field] = raw;
    }
    const desc = readDescription("contacts", cell(lower, column(table, "contacts", "description")));
    Object.assign(row, desc.fields);
    const recordId = recordIdOf(lower, table.idColumns.contacts);
    // A file SalesTeam exported names the very entry each row came from ("SalesTeam id: C0632") - Import matches by it
    // first, so a person stored twice is not compared with the other entry (1.2.2.22 round-trip test).
    rows.push({ ...row, contactId: desc.id || rowId(table.idPrefix, recordId, fullName), source: table.name });
  }
  return rows;
}

// Dynamics 365's "Export to Excel" writes the column titles in the organisation's language ("Firmenname",
// "Adresse 1: Ort") and keeps the field name of every column in a hidden sheet, as one text:
//   account:<checksum>:accountid=%28Nicht%20%c3%a4ndern%29%20Firma&name=Firmenname&address1_city=Adresse%201%3a%20Ort&…
// (seen in real exports of a German organisation, 2026-10-10). -> { "firmenname": "name", … }, or null when the text
// is not in that shape.
export function dynamicsFieldNames(fieldKey) {
  const m = String(fieldKey || "").match(/^([a-z0-9_]+):[^:]*:(.+)$/i);
  if (!m) return null;
  const byTitle = {};
  for (const pair of m[2].split("&")) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    let title;
    try { title = decodeURIComponent(pair.slice(at + 1)); } catch { continue; }
    title = title.trim().toLowerCase();
    if (title && !byTitle[title]) byTitle[title] = pair.slice(0, at).trim().toLowerCase();
  }
  return Object.keys(byTitle).length ? byTitle : null;
}

// A file read by xlsx-lite.js parseFirstSheetRecords, with its titles replaced by Dynamics' field names where the
// file's hidden sheet gives them - so a German, French … export is read like an English one. Any other file is
// returned as it is.
export function withDynamicsFieldNames(sheet) {
  const byTitle = dynamicsFieldNames(sheet && sheet.fieldKey);
  if (!byTitle) return sheet;
  const named = (title) => byTitle[String(title).trim().toLowerCase()] || title;
  return {
    headers: sheet.headers.map(named),
    records: sheet.records.map((record) => Object.fromEntries(Object.entries(record).map(([k, v]) => [named(k), v]))),
  };
}

// From the header row alone. Salesforce: "Account Name" (accounts file) or a person with an "Account Name" / Mailing /
// Lead Source column (contacts) - HubSpot says "Company name" and "Associated Company" instead. Dynamics: the hidden
// "(Do Not Modify) …" columns of Export to Excel, "Address 1: …", "Business Phone", "Main Phone" or its field names.
// A file with nothing but titles both CRMs use ("Account Name", "Website") is `preferred`'s when that is a CRM.
const DYNAMICS_MARKS = ["business phone", "main phone", "relationship type", "number of employees", "primary contact",
  "websiteurl", "telephone1", "emailaddress1", "parentcustomerid", "customertypecode", "accountid", "contactid"];
const SALESFORCE_MARKS = ["billing city", "billing country", "billingcity", "billingcountry", "mailing city", "mailing country",
  "mailingcity", "mailingcountry", "lead source", "leadsource", "annualrevenue", "account id", "contact id", "account.name"];

export function detectCrmFile(headers, preferred) {
  const list = (headers || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean);
  const h = new Set(list);
  const person = h.has("first name") || h.has("last name") || h.has("firstname") || h.has("lastname");
  const dynamics = list.some((n) => n.startsWith("(do not modify)") || n.startsWith("address 1:") || n.startsWith("address1_")) || DYNAMICS_MARKS.some((n) => h.has(n));
  if (dynamics) {
    if (person || h.has("full name") || h.has("fullname") || h.has("(do not modify) contact") || h.has("contactid")) return { format: "dynamics", kind: "contacts" };
    if (h.has("account name") || h.has("name") || h.has("(do not modify) account") || h.has("accountid")) return { format: "dynamics", kind: "accounts" };
  }
  const shared = preferred === "dynamics" && !SALESFORCE_MARKS.some((n) => h.has(n)) ? "dynamics" : "salesforce";
  const sfContact = ["account name", "account.name", "mailing city", "mailing country", "mailingcity", "mailingcountry", "lead source", "leadsource"];
  if (person && sfContact.some((n) => h.has(n))) return { format: shared, kind: "contacts" };
  if (!person && (h.has("account name") || h.has("billing country") || h.has("billingcountry") || (h.has("name") && (h.has("annualrevenue") || h.has("numberofemployees")))))
    return { format: shared, kind: "accounts" };
  return null;
}
