// An import that only ADDS and FILLS (EXPORT_IMPORT_DESIGN.md 3.2-3.3, R2-R3). Every import format reads its file
// into the research workbook's own row shape; this module then decides, for each file row, what happens:
//   - a company or person SalesTeam does not have becomes a new account / contact;
//   - an empty field on an existing account or contact is filled in;
//   - a field filled on both sides and different is settled by the SAME rules as a web finding
//     (web-findings-arbitration.js), with the file's value in the place of the web finding, "current data"
//     preferred, and the import tolerance (default 10%) checked first - so nothing within it ever reaches
//     Decisions;
//   - nothing is ever removed, hidden or replaced, and an account removed in SalesTeam is not brought back.
// Before 1.2.3 a workbook import replaced every workbook row - deleting the accounts the web research had found.
//
// PURE - no chrome APIs, no storage, no DOM (test_pure_modules.py runs it). storage.js reads the stores, calls
// planImport and writes what it returns.

import { normalizeCompanyName, websiteDomain, linkedinCompanySlug } from "./company-identity.js";
import { parseLooseNumber, revenueUnitsCheck, withWholeEmployees } from "./value-normalize.js";
import { computeFindingProposals, isBlankFinding } from "./web-research-apply.js";
import { arbitrateAccount, arbitrationContext } from "./web-findings-arbitration.js";
import { createPersonIndex } from "./person-identity.js";

export const DEFAULT_IMPORT_TOLERANCE_PCT = 10;

// Filled when empty, never a question: identity and descriptive fields no score reads (R3.3).
export const COMPANY_FILL_ONLY_FIELDS = ["linkedinLink", "website", "companyType", "alternativeCompanyName"];
// A contact's fields are filled when empty; a different value keeps the current one, without a question (Q3).
export const CONTACT_FILL_FIELDS = ["jobTitle", "function", "seniority", "relevance", "city", "country", "publicBusinessEmail", "profileUrl", "lastVerified2"];

const NUMERIC_FIELDS = new Set(["globalEmployees", "swissEmployees", "globalRevenue", "swissRevenue"]);
const MONEY_CURRENCY = { globalRevenue: "revenueCurrency", swissRevenue: "swissRevenueCurrency" };
// The workbook's own evidence column for a field, used as the provenance of a value the import fills in.
const EVIDENCE_FIELD = {
  globalEmployees: "globalEmployeesConfidence", swissEmployees: "swissEmployeesConfidence",
  globalRevenue: "globalRevenueConfidence", swissRevenue: "swissRevenueConfidence",
};

// One comparable spelling of a value, for "this exact value was already answered / is already waiting".
export function importValueKey(v) {
  if (v === null || v === undefined) return "";
  const n = typeof v === "number" ? v : null;
  return n !== null && Number.isFinite(n) ? String(n) : String(v).trim().toLowerCase();
}

// A file row in the shape a web research answer has, so computeFindingProposals and the arbitration rules read
// the file's values exactly as they read a web finding.
export function importAsFinding(row) {
  const r = row || {};
  return {
    employeesGlobal: r.globalEmployees, employeesLocal: r.swissEmployees,
    revenueGlobal: r.globalRevenue, revenueLocal: r.swissRevenue,
    revenueCurrency: r.revenueCurrency, swissRevenueCurrency: r.swissRevenueCurrency,
    hqCity: r.globalHqCity, hqCountry: r.globalHqCountry,
    registryName: r.zefixOfficialName, registryId: r.zefixUid, registryAddress: r.zefixAddress,
    industry: r.industry,
  };
}

// ---- identity -------------------------------------------------------------------------------------------

function importNameWords(name) {
  if (!name) return new Set();
  return new Set(String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
}

// Same as storage.js contactKeyFor - the key targetContactExtras is stored under.
export function importContactKey(company, fullName) {
  const companyPart = normalizeCompanyName(company);
  const namePart = [...importNameWords(fullName)].sort().join(" ");
  return companyPart && namePart ? `${companyPart}::${namePart}` : null;
}

function importProfileSlug(url) {
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(String(url || ""));
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

const lowerSlug = (url) => { const s = linkedinCompanySlug(url); return s ? s.toLowerCase() : null; };

// entries: [{ row, effective, deleted }]
function companyIndex(entries) {
  const byName = new Map(), bySlug = new Map(), byDomain = new Map();
  const add = (map, k, e) => { if (k && !map.has(k)) map.set(k, e); };
  for (const e of entries) addToCompanyIndex({ byName, bySlug, byDomain, add }, e);
  return { byName, bySlug, byDomain, add };
}

function addToCompanyIndex(index, e) {
  index.add(index.bySlug, lowerSlug(e.effective.linkedinLink), e);
  index.add(index.byDomain, websiteDomain(e.effective.website), e);
  index.add(index.byName, normalizeCompanyName(e.row.company), e);
  for (const a of e.row.aliases || []) index.add(index.byName, normalizeCompanyName(a), e);
}

// R2.2: LinkedIn company page, then website, then name (and the file row's own aliases).
function matchCompany(index, row) {
  const slug = lowerSlug(row.linkedinLink);
  if (slug && index.bySlug.has(slug)) return index.bySlug.get(slug);
  const domain = websiteDomain(row.website);
  if (domain && index.byDomain.has(domain)) return index.byDomain.get(domain);
  for (const name of [row.company, ...(row.aliases || [])]) {
    const k = normalizeCompanyName(name);
    if (k && index.byName.has(k)) return index.byName.get(k);
  }
  return null;
}

// An id the file brings that already belongs to another row would, with per-row team sync keyed on the id,
// overwrite that row for the whole team (design 2.5, D4). Such a row gets a fresh id.
function importFreeId(id, used, prefix) {
  let base = id ? String(id) : prefix;
  if (id && !used.has(base)) { used.add(base); return base; }
  for (let n = 1; ; n++) {
    const candidate = `${base}-i${n}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

// A CRM file cuts a value to its column's limit (Job Title: 100 characters in Dynamics, 128 in Salesforce) and a city
// to its first part. The start of the current value is that same value, not a difference (1.2.2.20 round-trip test:
// an export of 2,387 contacts came back with "84 differences", all of them job titles cut at 100).
function isStartOf(imported, current) {
  const a = importValueKey(imported), b = importValueKey(current);
  return a.length >= 3 && b.startsWith(a);
}

// ---- one existing account ---------------------------------------------------------------------------------

function withinTolerance(p, effective, data, tolerancePct) {
  if (p.state !== "different" || !NUMERIC_FIELDS.has(p.key)) return false;
  const a = parseLooseNumber(p.current);
  const b = typeof p.found === "number" ? p.found : parseLooseNumber(p.found);
  if (a === null || b === null) return false;
  const currencyKey = MONEY_CURRENCY[p.key];
  if (currencyKey) {
    const mine = effective[currencyKey] || effective.revenueCurrency;
    const theirs = data[currencyKey] || data.revenueCurrency;
    // Two currencies: computeFindingProposals has already compared them converted, with its own wider margin.
    if (mine && theirs && String(mine).trim().toUpperCase() !== String(theirs).trim().toUpperCase()) return false;
  }
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) <= tolerancePct / 100;
}

// Where an account's current value of `field` came from, when that is stronger than any file: a hand edit, LinkedIn,
// LinkedIn Discovery or cited web research. null when the value is the stored row's own (an earlier import) or an
// override an import or an uncited research put there - those an import may still replace by the rules.
const STRONGER_SOURCE_LABELS = { user: "a hand edit", linkedin: "LinkedIn", discovery: "LinkedIn Discovery", web: "cited web research" };
export function strongerSourceOf(extra, field) {
  const overrides = (extra && extra.overrides) || {};
  if (!(field in overrides) || isBlankFinding(overrides[field])) return null;
  const p = extra.provenance && extra.provenance[field];
  // An override without a provenance stamp (revenue, city, registry fields) was typed in or taken from a research.
  if (!p) return "an edit or a web research";
  if (p.src === "workbook" || (p.src === "web" && !p.cited)) return null;
  return STRONGER_SOURCE_LABELS[p.src] || p.src;
}

function currencyOfFound(key, data) {
  const c = key === "swissRevenue" ? (data.swissRevenueCurrency || data.revenueCurrency) : key === "globalRevenue" ? data.revenueCurrency : null;
  return isBlankFinding(c) ? null : c;
}

// D16: would this applied revenue be one written without its unit? opts.unitsMinimum = the targeting minimum
// (targetingMinimum in value-normalize.js); the global revenue is judged against the global headcount (the file's
// if it fills one too) and the minimum, the local one only against a real local headcount.
function unitsSuspect(p, effective, filled, data, opts) {
  if (p.key !== "globalRevenue" && p.key !== "swissRevenue") return false;
  const global = p.key === "globalRevenue";
  const employees = global
    ? (filled.globalEmployees ?? effective.globalEmployees ?? (typeof effective.employeeCount === "number" ? effective.employeeCount : null))
    : (filled.swissEmployees ?? effective.swissEmployees);
  return Boolean(revenueUnitsCheck(p.found, currencyOfFound(p.key, data), isBlankFinding(employees) ? null : employees,
    global ? opts.unitsMinimum || 0 : 0, opts.money || null));
}

// -> { overrides, evidence, findings, fills, taken, kept, decisions } for one matched account.
export function planCompanyUpdate(row, extra, fileRow, opts = {}) {
  const tolerancePct = Number.isFinite(Number(opts.tolerancePct)) ? Number(opts.tolerancePct) : DEFAULT_IMPORT_TOLERANCE_PCT;
  const overridesNow = (extra && extra.overrides) || {};
  const effective = { ...row, ...overridesNow };
  // An account with no stored headcount shows its LinkedIn size instead (the Employees column: employeeCount, else
  // the band ">5,000"). A file SalesTeam exported carries that shown value back - not new information, and a band
  // must not become a hard number (1.2.2.13 round-trip test: 8 accounts "filled" with the number from their band).
  if (isBlankFinding(effective.globalEmployees) && !isBlankFinding(fileRow.globalEmployees)) {
    const shown = typeof effective.employeeCount === "number" ? effective.employeeCount : parseLooseNumber(effective.employeeRange);
    if (shown !== null && shown === parseLooseNumber(fileRow.globalEmployees)) fileRow = { ...fileRow, globalEmployees: null };
  }
  const data = importAsFinding(fileRow);
  const answered = (extra && extra.importFindingsDismissed) || {};
  const open = (extra && extra.importFindings) || {};
  const out = { overrides: {}, evidence: {}, findings: {}, fills: [], taken: [], kept: [], decisions: [] };
  const note = (list, p, rule, why) => list.push({ field: p.key, label: p.label, current: p.current, imported: p.found, rule, why });

  let proposals = computeFindingProposals(row, overridesNow, data, opts.money || null)
    // R4.4: a value answered "Keep current" is not asked again, and one already waiting is not added twice.
    .filter((p) => !(p.key in answered && importValueKey(answered[p.key]) === importValueKey(p.found)))
    .filter((p) => !(open[p.key] && importValueKey(open[p.key].value) === importValueKey(p.found)));
  // R3.1 (D3): within the import tolerance the current value stays - before any rule, so it can never be asked.
  proposals = proposals.filter((p) => {
    if (!withinTolerance(p, effective, data, tolerancePct)) return true;
    note(out.kept, p, "tolerance", `the two values are within ${tolerancePct}% of each other`);
    return false;
  });
  // The currency follows its amount; once the amount is settled above, a lone currency difference means nothing.
  if (!proposals.some((p) => p.key === "globalRevenue")) {
    proposals = proposals.filter((p) => p.key !== "revenueCurrency" || p.state === "new");
  }

  if (proposals.length > 0) {
    const ctx = arbitrationContext(row, extra, { buckets: opts.buckets || [], locationTier: opts.locationTier || (() => null), contactCount: opts.contactCount || 0 });
    const settings = { ...(opts.settings || {}), tolerancePct, sourcePreference: "existing" };
    const { decisions } = arbitrateAccount({ proposals, extra: { overrides: overridesNow }, ctx, settings, data });
    for (const d of decisions) {
      const p = d.proposal;
      // 1.2.2.10 live test: rules 2, 10 and 11 replaced values that LinkedIn and cited web research had set (AXA's
      // LinkedIn headcount, Galenica's and Swiss Prime Site's cited counts, AXA's and Allianz's HQ country) - and the
      // pipeline then put three of them back. A file never overrules a person, LinkedIn or cited web research; it
      // may only replace what an earlier file put there.
      const stronger = p.state === "different" ? strongerSourceOf(extra, p.key === "revenueCurrency" ? "globalRevenue" : p.key) : null;
      if (d.action === "apply" && stronger) {
        note(out.kept, p, "source", `the current value comes from ${stronger}, which an import does not overrule`);
      } else if (d.action === "apply" && unitsSuspect(p, effective, out.overrides, data, opts)) {
        // D16: a revenue that lost its unit (491.1 CHF for a bank of 900) is not written; Decisions asks.
        note(out.decisions, p, "units", "the revenue looks written without its unit (millions / billions)");
        out.findings[p.key] = {
          value: p.found, current: p.current === undefined ? null : p.current, rule: "units",
          why: "the revenue looks written without its unit (millions / billions)",
          ...(currencyOfFound(p.key, data) ? { currency: currencyOfFound(p.key, data) } : {}),
          file: opts.fileName || null, at: opts.at || null,
        };
      } else if (d.action === "apply") {
        out.overrides[p.key] = p.found;
        const ev = EVIDENCE_FIELD[p.key] ? fileRow[EVIDENCE_FIELD[p.key]] : null;
        out.evidence[p.key] = ev || fileRow.evidenceStatus || null;
        note(p.state === "new" ? out.fills : out.taken, p, d.rule, d.why);
      } else if (d.action === "dismiss") {
        note(out.kept, p, d.rule, d.why);
      } else {
        if (p.key === "revenueCurrency") continue; // never its own question: it rides with the amount below
        // D16: a revenue the rules question because it lost its unit is asked as such ("Correct it").
        const units = unitsSuspect(p, effective, out.overrides, data, opts);
        const rule = units ? "units" : d.rule;
        const why = units ? "the revenue looks written without its unit (millions / billions)" : d.why;
        note(out.decisions, p, rule, why);
        out.findings[p.key] = {
          value: p.found, current: p.current === undefined ? null : p.current, rule, why,
          ...(p.key === "globalRevenue" && !isBlankFinding(data.revenueCurrency) ? { currency: data.revenueCurrency } : {}),
          ...(p.key === "swissRevenue" && !isBlankFinding(data.swissRevenueCurrency || data.revenueCurrency) ? { currency: data.swissRevenueCurrency || data.revenueCurrency } : {}),
          file: opts.fileName || null, at: opts.at || null,
        };
      }
    }
  }

  // A currency only travels with its amount: when the amount went to Decisions (D16), so does the currency.
  for (const [amount, cur] of Object.entries(MONEY_CURRENCY)) {
    if (out.findings[amount] && out.findings[amount].rule === "units" && cur in out.overrides) {
      delete out.overrides[cur];
      delete out.evidence[cur];
      out.fills = out.fills.filter((f) => f.field !== cur);
      out.taken = out.taken.filter((f) => f.field !== cur);
    }
  }

  for (const field of COMPANY_FILL_ONLY_FIELDS) {
    const v = fileRow[field];
    if (isBlankFinding(v) || (typeof v === "string" && !v.trim())) continue;
    if (!isBlankFinding(effective[field]) && String(effective[field]).trim()) continue;
    out.overrides[field] = typeof v === "string" ? v.trim() : v;
    out.fills.push({ field, label: field, current: null, imported: out.overrides[field], rule: 1, why: "the field was empty" });
  }
  return out;
}

// ---- the whole file ---------------------------------------------------------------------------------------

// parsed:  { companies, contacts, aiInitiatives, aiInvestment, sources } - file rows, workbook shape
// current: { companies, contacts, aiInitiatives, aiInvestment, sources, extras, contactExtras } - as stored
// opts:    { settings, money, buckets, locationTier, tolerancePct, contactCounts (Map companyId -> n), fileName, at }
export function planImport(parsed, current, opts = {}) {
  const extras = current.extras || {};
  const contactExtras = current.contactExtras || {};
  const at = opts.at || null;
  const plan = {
    newCompanies: [], newContacts: [], newInitiatives: [], newInvestment: [], newSources: [],
    companyPatches: {},   // account key -> { overrides, evidence, findings, aliases }
    contactPatches: {},   // contact key -> { overrides }
    fills: [], taken: [], kept: [], decisions: [], skipped: [],
    newCompanyNames: [],
    newCompanyIds: {},    // the file's companyId -> the id the new row was stored under
  };

  // Existing accounts, with their own edits on top (a website typed by the user is part of who the company is).
  const entries = (current.companies || []).filter((r) => r && r.company).map((row) => {
    const key = normalizeCompanyName(row.company);
    const extra = extras[key];
    return { row, key, extra, effective: { ...row, ...((extra && extra.overrides) || {}) }, deleted: Boolean(extra && extra.deletedAt), isNew: false };
  });
  const index = companyIndex(entries);
  const usedCompanyIds = new Set((current.companies || []).map((r) => r && r.companyId).filter(Boolean));
  const resolved = new Map(); // file companyId -> entry
  const touched = new Set();

  for (const rawRow of parsed.companies || []) {
    const fileRow = withWholeEmployees(rawRow); // a headcount is stored as a whole number
    const name = fileRow && typeof fileRow.company === "string" ? fileRow.company.trim() : "";
    if (!name) { plan.skipped.push({ name: "(no name)", reason: "the row has no company name" }); continue; }
    const hit = matchCompany(index, fileRow);
    if (hit) {
      if (fileRow.companyId) resolved.set(String(fileRow.companyId), hit);
      if (hit.deleted) { plan.skipped.push({ name, reason: `"${hit.row.company}" was removed in SalesTeam` }); continue; }
      if (touched.has(hit.key)) { plan.skipped.push({ name, reason: `the file has "${hit.row.company}" more than once` }); continue; }
      touched.add(hit.key);
      if (hit.isNew) continue;
      const contactCount = opts.contactCounts && hit.row.companyId ? opts.contactCounts.get(hit.row.companyId) || 0 : 0;
      const u = planCompanyUpdate(hit.row, hit.extra, fileRow, { ...opts, contactCount });
      const aliases = (fileRow.aliases || []).filter((a) => a && !(hit.row.aliases || []).includes(a) && normalizeCompanyName(a) !== hit.key);
      if (Object.keys(u.overrides).length || Object.keys(u.findings).length || aliases.length) {
        plan.companyPatches[hit.key] = { overrides: u.overrides, evidence: u.evidence, findings: u.findings, aliases };
      }
      for (const [list, items] of [[plan.fills, u.fills], [plan.taken, u.taken], [plan.kept, u.kept], [plan.decisions, u.decisions]]) {
        for (const i of items) list.push({ ...i, company: hit.row.company, key: hit.key });
      }
      continue;
    }
    const row = { ...fileRow, company: name, companyId: importFreeId(fileRow.companyId, usedCompanyIds, "C"), ...(at ? { importedAt: at } : {}) };
    plan.newCompanies.push(row);
    plan.newCompanyNames.push(name);
    if (fileRow.companyId) plan.newCompanyIds[String(fileRow.companyId)] = row.companyId;
    const entry = { row, key: normalizeCompanyName(name), extra: null, effective: row, deleted: false, isNew: true };
    addToCompanyIndex(index, entry);
    touched.add(entry.key);
    if (fileRow.companyId) resolved.set(String(fileRow.companyId), entry);
  }

  // Contacts: LinkedIn profile, then e-mail, then the name within the account.
  const bySlug = new Map(), byEmail = new Map(), byKey = new Map(), byId = new Map();
  const people = createPersonIndex();
  const indexContact = (c) => {
    const slug = importProfileSlug(c.lastVerified2 || c.linkedinProfileUrl);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, c);
    const email = c.publicBusinessEmail ? String(c.publicBusinessEmail).trim().toLowerCase() : "";
    if (email && !byEmail.has(email)) byEmail.set(email, c);
    const key = importContactKey(c.company, c.fullName);
    if (key && !byKey.has(key)) byKey.set(key, c);
    if (c.contactId && !byId.has(String(c.contactId))) byId.set(String(c.contactId), c);
    people.add(c.company, c, c);
  };
  (current.contacts || []).forEach(indexContact);
  const usedContactIds = new Set((current.contacts || []).map((c) => c && c.contactId).filter(Boolean));
  const contactsTouched = new Set();

  for (const fc of parsed.contacts || []) {
    const fullName = fc && typeof fc.fullName === "string" ? fc.fullName.trim() : "";
    if (!fullName) { plan.skipped.push({ name: "(no name)", reason: "a contact row has no name" }); continue; }
    let account = fc.companyId ? resolved.get(String(fc.companyId)) : null;
    if (!account && fc.company) account = matchCompany(index, { company: fc.company });
    if (!account && fc.company && String(fc.company).trim()) {
      // A person whose company is in neither SalesTeam nor the file gets a minimal account (as HubSpot import does).
      const row = { companyId: importFreeId(null, usedCompanyIds, "C-contact"), company: String(fc.company).trim(), researchStatus: "Created from an imported contact", ...(at ? { importedAt: at } : {}) };
      plan.newCompanies.push(row);
      plan.newCompanyNames.push(row.company);
      account = { row, key: normalizeCompanyName(row.company), extra: null, effective: row, deleted: false, isNew: true };
      addToCompanyIndex(index, account);
    }
    if (!account) { plan.skipped.push({ name: fullName, reason: "the contact has no company" }); continue; }
    if (account.deleted) { plan.skipped.push({ name: fullName, reason: `"${account.row.company}" was removed in SalesTeam` }); continue; }

    const slug = importProfileSlug(fc.lastVerified2 || fc.linkedinProfileUrl);
    const email = fc.publicBusinessEmail ? String(fc.publicBusinessEmail).trim().toLowerCase() : "";
    const nameKey = importContactKey(account.row.company, fullName);
    // Also under the company name the file gives: "Holcim Schweiz / Suisse / Svizzera" is an account of its own AND an
    // alias of Holcim Group, so the account match can land on the group while the person is stored under the
    // subsidiary (1.2.2.13 round-trip test: 6 existing contacts counted as new).
    const fileNameKey = fc.company ? importContactKey(fc.company, fullName) : null;
    // The entry's own id, when the file carries it (a file SalesTeam exported) and it is still that person: an id alone
    // proves nothing - another SalesTeam numbers its contacts the same way. Before the LinkedIn profile, because one
    // person stored twice shares the profile, and the first of the two would take the other's row (1.2.2.22
    // round-trip test: "CTO" compared with the twin entry's "Chief Technology Officer", and its empty city filled).
    const own = fc.contactId ? byId.get(String(fc.contactId)) : null;
    const ownKey = own ? importContactKey(own.company, own.fullName) : null;
    const hit = (own && (ownKey === nameKey || ownKey === fileNameKey) && own)
      || (slug && bySlug.get(slug)) || (email && byEmail.get(email)) || (nameKey && byKey.get(nameKey))
      || (fileNameKey && byKey.get(fileNameKey))
      // The same person written another way: "Dr. …", "Oezlem" / "Özlem", a middle name (person-identity.js).
      || people.find(account.row.company, fc) || (fc.company && people.find(fc.company, fc)) || null;
    if (hit) {
      const key = importContactKey(hit.company, hit.fullName);
      if (!key || contactsTouched.has(key) || hit.__new) continue;
      contactsTouched.add(key);
      const effective = { ...hit, ...((contactExtras[key] && contactExtras[key].overrides) || {}) };
      const overrides = {};
      for (const field of CONTACT_FILL_FIELDS) {
        const v = fc[field];
        if (isBlankFinding(v) || (typeof v === "string" && !v.trim())) continue;
        const cur = effective[field];
        if (isBlankFinding(cur) || (typeof cur === "string" && !cur.trim())) {
          overrides[field] = typeof v === "string" ? v.trim() : v;
          plan.fills.push({ field, label: field, current: null, imported: overrides[field], rule: 1, why: "the field was empty", company: hit.company, contact: hit.fullName, key });
        } else if (importValueKey(cur) !== importValueKey(v) && !isStartOf(v, cur)) {
          plan.kept.push({ field, label: field, current: cur, imported: v, rule: "contact", why: "a contact keeps its current value", company: hit.company, contact: hit.fullName, key });
        }
      }
      if (Object.keys(overrides).length) plan.contactPatches[key] = { overrides };
      continue;
    }
    const row = { ...fc, fullName, company: account.row.company, companyId: account.row.companyId, contactId: importFreeId(fc.contactId, usedContactIds, "P"), ...(at ? { importedAt: at } : {}) };
    Object.defineProperty(row, "__new", { value: true, enumerable: false });
    plan.newContacts.push(row);
    indexContact(row);
  }

  // Initiatives: added when the account does not list that name yet. Investment and source rows: added when new.
  const companyIdOf = (fileCompanyId) => { const e = fileCompanyId ? resolved.get(String(fileCompanyId)) : null; return e && !e.deleted ? e.row.companyId : null; };
  const initiativeKeys = new Set((current.aiInitiatives || []).map((i) => `${i.companyId}::${String(i.initiativeName || "").trim().toLowerCase()}`));
  const usedInitiativeIds = new Set((current.aiInitiatives || []).map((i) => i && i.initiativeId).filter(Boolean));
  for (const i of parsed.aiInitiatives || []) {
    const companyId = companyIdOf(i.companyId);
    const name = String(i.initiativeName || "").trim();
    if (!companyId || !name) continue;
    const k = `${companyId}::${name.toLowerCase()}`;
    if (initiativeKeys.has(k)) continue;
    initiativeKeys.add(k);
    plan.newInitiatives.push({ ...i, companyId, initiativeId: importFreeId(i.initiativeId, usedInitiativeIds, "I") });
  }
  const rowKey = (r) => JSON.stringify(Object.keys(r).filter((k) => !/Id$/.test(k) || k === "companyId").sort().map((k) => [k, r[k]]));
  for (const [sheet, target] of [["aiInvestment", plan.newInvestment], ["sources", plan.newSources]]) {
    const have = new Set((current[sheet] || []).map(rowKey));
    for (const r of parsed[sheet] || []) {
      const companyId = companyIdOf(r.companyId);
      if (!companyId) continue;
      const next = { ...r, companyId };
      const k = rowKey(next);
      if (have.has(k)) continue;
      have.add(k);
      target.push(next);
    }
  }

  plan.counts = {
    newCompanies: plan.newCompanies.length, newContacts: plan.newContacts.length, newInitiatives: plan.newInitiatives.length,
    filled: plan.fills.length, taken: plan.taken.length, kept: plan.kept.length, decisions: plan.decisions.length, skipped: plan.skipped.length,
  };
  return plan;
}

// What stands behind "1 empty field filled, 1 difference kept as it is" - one line each, for Details in the
// check-first summary (1.2.2.22: a round trip that did not come back empty could not say which rows it meant).
export function importDetailLines(plan, limit = 200) {
  const who = (x) => (x.contact ? `${x.contact} (${x.company})` : x.company);
  const lines = (items, text) => [
    ...items.slice(0, limit).map(text),
    ...(items.length > limit ? [`… and ${items.length - limit} more`] : []),
  ];
  return [
    ...lines(plan.fills || [], (x) => `Filled: ${who(x)} - ${x.label}: ${x.imported}`),
    ...lines(plan.taken || [], (x) => `Updated: ${who(x)} - ${x.label}: current ${x.current}, in the file ${x.imported}`),
    ...lines(plan.kept || [], (x) => `Kept as it is: ${who(x)} - ${x.label}: current ${x.current}, in the file ${x.imported} (${x.why})`),
  ];
}

// "12 new accounts, 3 new contacts, 41 empty fields filled, ..." - the counts in words, for the pop-up and the logs.
export function importSummaryText(counts) {
  const c = counts || {};
  const part = (n, one, many) => (n > 0 ? `${n} ${n === 1 ? one : many}` : null);
  const parts = [
    part(c.newCompanies, "new account", "new accounts"),
    part(c.newContacts, "new contact", "new contacts"),
    part(c.newInitiatives, "new initiative", "new initiatives"),
    part(c.filled, "empty field filled", "empty fields filled"),
    part(c.taken, "value taken from the file (the current one was weaker)", "values taken from the file (the current ones were weaker)"),
    part(c.kept, "difference kept as it is", "differences kept as they are"),
    part(c.decisions, "difference for Decisions", "differences for Decisions"),
    part(c.skipped, "row skipped", "rows skipped"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing new - everything in the file is already in SalesTeam";
}
