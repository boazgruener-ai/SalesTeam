// What a web research can propose for an account, and how it is compared with what the account already has.
// Shared by the Target Accounts page and the background bulk research.
import { parseLooseNumber, normalizeMoney, wholeEmployees, HEADCOUNT_FIELDS } from "./value-normalize.js";

// Revenue fields carry a currency in a SEPARATE field, so two figures can only be compared once
// both are expressed in the same one. Without this, a stored 113,530,000,000 USD and a found
// 91,350,000,000 CHF look like a disagreement when they are very nearly the same money.
//
// The workbook keeps TWO currency columns, and they belong to different amounts: Revenue_Currency
// goes with Global_Revenue, Swiss_Revenue_Currency with Swiss_Revenue (xlsx-lite.js maps the latter
// to `swissRevenueCurrency`). Normalising the local figure with the global currency happens to give
// the right answer on today's data - all 14 rows that carry both have them equal - but it is only
// luck, and a company reporting worldwide in USD and locally in CHF would be silently mis-converted.
//
// The web research reports only ONE currency (`revenueCurrency` in the agent's JSON), so the found
// side, and any row with no local currency of its own, fall back to it.
const MONEY_FIELDS = { globalRevenue: "revenueCurrency", swissRevenue: "swissRevenueCurrency" };

// Two figures in the SAME currency within 10% of each other are one fact reported slightly
// differently. Once a CONVERSION is involved the exchange rate is itself an estimate, and the
// comparison inherits that error. Measured across this dataset, the implied CHF->USD rate runs from
// 1.10 (MCH Group) to 1.35 (Luzerner Kantonalbank) depending on which year and which source each
// side used - an 11% spread that on its own exceeds the same-currency threshold. Judging a converted
// comparison as tightly as a same-currency one therefore manufactures disagreements that do not
// exist: MCH Group's 435,700,000 CHF against a stored 480,000,000 USD is the SAME MONEY at 1.102,
// and 11.9% apart at the table's 1.25.
const SAME_CURRENCY_TOLERANCE = 0.1;
const CROSS_CURRENCY_TOLERANCE = 0.25;
// 1.2.1 (ONBOARDING_RESEARCH_DESIGN.md 5.3): the research's DATA line gives each fact with ITS OWN source,
// { value, url, year } (a summary is { text, url }), instead of a plain value. A value counts as cited only
// when it carries a url - the model can no longer make a guessed number count by citing something else.
// A research stored before 1.2.1 (plain values) is still read; it keeps the old rule, cited when the
// research as a whole cited any source.
export function isCitedValue(raw) {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) && ("value" in raw || "text" in raw);
}

export function findingValue(raw) {
  if (!isCitedValue(raw)) return raw;
  return "value" in raw ? raw.value : raw.text;
}

export function findingUrl(raw) {
  if (!isCitedValue(raw) || typeof raw.url !== "string") return null;
  const url = raw.url.trim();
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}

// `raw` reads the field as the research wrote it; `from` its plain value, whichever format it is in.
const finding = (key, label, dataKey, numeric = false) =>
  ({ key, label, dataKey, numeric, raw: (d) => d[dataKey], from: (d) => findingValue(d[dataKey]) });

export const WEB_FINDING_FIELDS = [
  finding("globalEmployees", "Employees (global)", "employeesGlobal", true),
  finding("swissEmployees", "Employees (local)", "employeesLocal", true),
  finding("globalRevenue", "Revenue (global)", "revenueGlobal", true),
  finding("swissRevenue", "Revenue (local)", "revenueLocal", true),
  finding("revenueCurrency", "Revenue currency", "revenueCurrency"),
  finding("globalHqCity", "Global HQ city", "hqCity"),
  finding("globalHqCountry", "Global HQ country", "hqCountry"),
  finding("zefixOfficialName", "Registry official name", "registryName"),
  finding("zefixUid", "Registry ID", "registryId"),
  finding("zefixAddress", "Registry address", "registryAddress"),
  // 1.2.1 web lane: asked for only when the user's setup weighs industry, and then as one of the setup's own names.
  finding("industry", "Industry", "industry"),
];

// true when a research answer uses the per-field format for any of its facts.
export function isPerFieldResearch(data) {
  if (!data) return false;
  return WEB_FINDING_FIELDS.some((f) => isCitedValue(f.raw(data))) || ["website", "isPublic", "summary"].some((k) => isCitedValue(data[k]));
}

// Does this research stand behind `current` as the value of `key`, and with which source? Returns
// { cited, link } or null. Per-field answer: only when its value for the field agrees with `current`, cited
// only with a url of its own. Pre-1.2.1 answer: the old rule (cited when the research had any source).
export function webCitationFor(data, sources, key, current) {
  if (!data) return null;
  const f = WEB_FINDING_FIELDS.find((x) => x.key === key);
  const raw = f ? f.raw(data) : undefined;
  if (isCitedValue(raw)) {
    if (!valuesAgree(f, findingValue(raw), current)) return null;
    const link = findingUrl(raw);
    return { cited: Boolean(link), link };
  }
  if (isPerFieldResearch(data)) return null;
  return Array.isArray(sources) && sources.length > 0 ? { cited: true, link: null } : null;
}

function valuesAgree(f, found, current) {
  if (isBlankFinding(found) || isBlankFinding(current)) return false;
  if (f.numeric) {
    const a = parseLooseNumber(current);
    const b = parseLooseNumber(found);
    return a !== null && b !== null && Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) <= SAME_CURRENCY_TOLERANCE;
  }
  return String(current).trim().toLowerCase() === String(found).trim().toLowerCase();
}

// Build step 5: the fields a research CONFIRMS - it found a value, the account has one, and the two agree
// (the same test that keeps a matching value from ever becoming a finding). A value that agrees is never
// a finding, so without this a weakly evidenced workbook value would stay unverified however often the
// web agreed with it. `keys` limits the fields looked at.
export function researchConfirms(company, overrides, data, money = null, keys = null) {
  if (!data) return [];
  const effective = { ...(company || {}), ...(overrides || {}) };
  const differing = new Set(computeFindingProposals(company, overrides, data, money).map((p) => p.key));
  const out = [];
  for (const f of WEB_FINDING_FIELDS) {
    if (keys && !keys.includes(f.key)) continue;
    const found = f.from(data);
    if (isBlankFinding(found) || (f.numeric && parseLooseNumber(found) === null)) continue;
    if (isBlankFinding(effective[f.key]) || differing.has(f.key)) continue;
    out.push(f.key);
  }
  return out;
}

export function isBlankFinding(v) {
  return v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v));
}

// [{key, label, found, current, state: "new" | "different"}] - values equal to (or within 10% of) what the account has are left out.
// `money` is optional: { targetCurrency, rates }. When it is passed, revenue figures are compared
// after being converted into the one target currency; without it they are compared as written,
// which is the old behaviour and still correct whenever both sides share a currency.
export function computeFindingProposals(company, overrides, data, money = null) {
  if (!data) return [];
  const effective = { ...(company || {}), ...(overrides || {}) };
  const out = [];
  for (const f of WEB_FINDING_FIELDS) {
    let found = f.from(data);
    if (isBlankFinding(found)) continue;
    // parseLooseNumber, not Number(): a found "102m" or ">5,000" is a perfectly good figure written
    // in a way Number() throws away entirely.
    if (f.numeric) { found = parseLooseNumber(found); if (found === null) continue; } else found = String(found).trim();
    if (HEADCOUNT_FIELDS.includes(f.key)) found = wholeEmployees(found);
    const current = effective[f.key];
    if (isBlankFinding(current)) { out.push({ key: f.key, label: f.label, found, current: null, state: "new" }); continue; }
    if (f.numeric) {
      let a = parseLooseNumber(current);
      let b = found;
      let converted = false;
      const currencyKey = MONEY_FIELDS[f.key];
      if (currencyKey && money?.targetCurrency) {
        const mine = normalizeMoney(current, effective[currencyKey] || effective.revenueCurrency, money.targetCurrency, money.rates);
        const theirs = normalizeMoney(found, findingValue(data[currencyKey]) || findingValue(data.revenueCurrency), money.targetCurrency, money.rates);
        if (mine.amount !== null && theirs.amount !== null) {
          a = mine.amount;
          b = theirs.amount;
          converted = mine.converted || theirs.converted;
        }
      }
      const tolerance = converted ? CROSS_CURRENCY_TOLERANCE : SAME_CURRENCY_TOLERANCE;
      if (a !== null && Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) <= tolerance) continue;
    } else if (String(current).trim().toLowerCase() === String(found).toLowerCase()) continue;
    out.push({ key: f.key, label: f.label, found, current, state: "different" });
  }
  return out;
}

// ---- 1.2.1 web lane (ONBOARDING_RESEARCH_DESIGN.md 5.3-5.5): the parts of the answer that are lists ----

const HTTP_URL_RE = /^https?:\/\/\S+$/i;
const ROLE_NOT_NAME_RE = /^(the|our|a|an|its)\s|\b(ceo|cfo|cio|cto|coo|cdo|chief|head|officer|director|manager|board|team|department|n\/a|unknown)\b/i;
const cleanUrl = (u) => (typeof u === "string" && HTTP_URL_RE.test(u.trim()) ? u.trim() : null);

// "https://ch.linkedin.com/in/anna-muster-12ab/?trk=x" -> "https://www.linkedin.com/in/anna-muster-12ab/"; null for anything else.
export function linkedinProfileUrl(url) {
  const m = /^https?:\/\/([a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([^/?#\s]+)/i.exec(String(url || "").trim());
  return m ? `https://www.linkedin.com/in/${m[2]}/` : null;
}

// Same for a company page: "https://www.linkedin.com/company/<slug>/", or null.
export function linkedinCompanyUrl(url) {
  const m = /^https?:\/\/([a-z]{2,3}\.|www\.)?linkedin\.com\/company\/([^/?#\s]+)/i.exec(String(url || "").trim());
  return m ? `https://www.linkedin.com/company/${m[2]}/` : null;
}

// Named people the research found on the company's own site or in a report: [{ fullName, title, sourceUrl }].
// A person is kept only with a first AND last name and a source of their own (R7a.5) - "the CFO" alone, or a
// name nobody cited, is not a contact.
export function researchContacts(data) {
  const out = [];
  const seen = new Set();
  for (const c of (data && Array.isArray(data.contacts) ? data.contacts : [])) {
    const fullName = String((c && c.fullName) || "").replace(/\s+/g, " ").trim();
    const sourceUrl = cleanUrl(c && c.sourceUrl);
    if (!sourceUrl || fullName.split(" ").filter((w) => /[a-z]/i.test(w)).length < 2 || fullName.length > 80) continue;
    // A role is not a name: "The CFO", "Head of Group IT".
    if (ROLE_NOT_NAME_RE.test(fullName)) continue;
    const k = fullName.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    // D10 (2026-09-29): the person's LinkedIn profile link as a web search listed it - no LinkedIn visit.
    const profile = cleanUrl(c && c.linkedinUrl);
    out.push({ fullName, title: String((c && c.title) || "").trim() || null, sourceUrl, linkedinUrl: linkedinProfileUrl(profile) });
  }
  return out;
}

export const INITIATIVE_STAGES = ["poc", "exploration", "pilot", "early_production", "scaling", "mature", "tech_native"];

// Initiatives as addWebResearchInitiatives stores them, with the stage kept only when it is one of the seven.
export function researchInitiatives(data) {
  return (data && Array.isArray(data.initiatives) ? data.initiatives : [])
    .filter((i) => i && String(i.name || "").trim())
    .map((i) => ({
      name: String(i.name).trim(), description: i.description || null, date: i.date || null, status: i.status || null,
      stage: INITIATIVE_STAGES.includes(i.stage) ? i.stage : null, sourceUrl: cleanUrl(i.sourceUrl),
    }));
}

// true / false when the research said (either format), else null.
export function researchIsPublic(data) {
  const v = data ? findingValue(data.isPublic) : null;
  return v === true || v === false ? v : null;
}
