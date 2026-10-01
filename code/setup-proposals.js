// Onboarding research (ONBOARDING_RESEARCH_DESIGN.md 3.4): turns the seller research's answer - plain names and
// texts, each with the page it came from - into the Setup wizard's own values. What cannot be mapped is dropped
// (and named in the step's note), never guessed: only countries the location picker has, only the industries
// the wizard offers (each has a live-confirmed LinkedIn id), only resources on the seller's own site.
//
// PURE: no chrome.*, no DOM, no URL class. Executed and asserted on by test_pure_modules.py.
import { ISO_COUNTRY_CODES } from "./iso-country-codes.js";
import { COUNTRY_LOCAL_NAMES } from "./country-local-names.js";
import { normalizeCompanyName, websiteDomain } from "./company-identity.js";
import { parseLooseNumber } from "./value-normalize.js";
import { seniorityLevelFromLabel } from "./readiness.js";

// The steps that receive a proposal, and the answer's keys each one is built from. "Research again" on a step
// asks for these keys only.
export const PROPOSAL_STEP_KEYS = {
  about: ["siteLanguage"],
  location: ["sellsToCountries"],
  size: ["customerSizes"],
  industry: ["customerIndustries", "organizationTypes"],
  "company-context": ["summary"],
  "value-add-offers": ["resources"],
  icp: ["idealCustomer", "customerIndustries"],
  contacts: ["buyerTitles"],
  exclusions: ["competitors", "customers", "partners"],
};

const MAX_TITLES = 10;
const MAX_KEYWORDS = 6;
const MAX_RESOURCES = 10;
const MAX_EXCLUSIONS_PER_CATEGORY = 15;

const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

const isWebUrl = (u) => /^https?:\/\/[^\s/]+\.[^\s]+/i.test(String(u || "").trim());
const webUrlOrNull = (u) => (isWebUrl(u) ? String(u).trim() : null);
const cleanText = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max || 2000);
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

// A host on the seller's own domain: the domain itself or a subdomain of it (shop.acme.com for acme.com).
export function isOnDomain(url, domain) {
  const d = websiteDomain(url);
  if (!d || !domain) return false;
  return d === domain || d.endsWith("." + domain);
}

// "https://www.acme.com/about/" -> "acme.com/about": how a source is named in the banner (R5.1).
export function sourceLabel(url) {
  const s = String(url || "").trim();
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#\s]+)([^?#\s]*)/i.exec(s);
  if (!m) return s;
  const host = m[1].toLowerCase().replace(/^www\d*\./, "");
  const path = m[2].replace(/\/+$/, "");
  const label = host + path;
  return label.length > 60 ? label.slice(0, 57) + "…" : label;
}

// ---------------------------------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------------------------------

// Common names the answer may use for a country the picker lists under another name, and regions that stand for
// a fixed set of countries. A wider region ("Europe", "worldwide") maps to nothing: it is too broad to tick.
const COUNTRY_ALIASES = {
  usa: "United States", us: "United States", "united states of america": "United States", america: "United States",
  uk: "United Kingdom", "great britain": "United Kingdom", britain: "United Kingdom", england: "United Kingdom",
  holland: "Netherlands", "the netherlands": "Netherlands", czechia: "Czech Republic", "cote d ivoire": "Ivory Coast",
  uae: "United Arab Emirates", "republic of korea": "South Korea", korea: "South Korea", turkiye: "Turkey",
};
const REGION_COUNTRIES = {
  dach: ["Germany", "Austria", "Switzerland"],
  benelux: ["Belgium", "Netherlands", "Luxembourg"],
  nordics: ["Denmark", "Finland", "Iceland", "Norway", "Sweden"],
  "nordic countries": ["Denmark", "Finland", "Iceland", "Norway", "Sweden"],
  scandinavia: ["Denmark", "Norway", "Sweden"],
  "baltic states": ["Estonia", "Latvia", "Lithuania"],
  baltics: ["Estonia", "Latvia", "Lithuania"],
};

// One answered name -> the picker's countries (usually one; a region such as "DACH" gives several), [] if none.
export function mapCountryName(name, pickerCountries) {
  const key = fold(name);
  if (!key) return [];
  const byFold = new Map((pickerCountries || []).map((c) => [fold(c), c]));
  const take = (names) => names.filter((n) => byFold.has(fold(n))).map((n) => byFold.get(fold(n)));
  if (byFold.has(key)) return [byFold.get(key)];
  if (COUNTRY_ALIASES[key]) return take([COUNTRY_ALIASES[key]]);
  if (REGION_COUNTRIES[key]) return take(REGION_COUNTRIES[key]);
  for (const [country, local] of Object.entries(COUNTRY_LOCAL_NAMES)) {
    if (Object.values(local).some((n) => fold(n) === key)) return take([country]);
  }
  const raw = String(name || "").trim();
  if (/^[A-Z]{2}$/.test(raw)) {
    const hit = Object.keys(ISO_COUNTRY_CODES).find((c) => ISO_COUNTRY_CODES[c] === raw);
    if (hit) return take([hit]);
  }
  return [];
}

function mapCountries(items, pickerCountries) {
  const value = [];
  const dropped = [];
  const sources = [];
  for (const it of list(items)) {
    const hits = mapCountryName(it.name, pickerCountries);
    if (!hits.length) { if (cleanText(it.name, 80)) dropped.push(cleanText(it.name, 80)); continue; }
    for (const h of hits) if (!value.includes(h)) value.push(h);
    if (webUrlOrNull(it.url)) sources.push(it.url);
  }
  return { value, dropped: [...new Set(dropped)], sources };
}

// ---------------------------------------------------------------------------------------------------
// Size bands
// ---------------------------------------------------------------------------------------------------

// Words for a size without a number. "Large" alone means the large end (Large and above); "enterprise" and
// "multinational" the two largest bands.
const SIZE_WORDS = [
  [/\b(sme|smes|small and medium|small and mid|kmu|pme)\b/, ["S", "M"]],
  [/\b(start ?ups?|small (companies|businesses|firms))\b/, ["S"]],
  [/\b(mid ?sized?|medium ?sized?|mid ?market|midmarket|mittelstand|mid ?caps?)\b/, ["M", "L"]],
  [/\b(enterprises?|corporates?|corporations|multinationals?|global companies|fortune|large caps?|blue chips?)\b/, ["XL", "XXL"]],
  [/\b(large|big)\b/, ["L", "XL", "XXL"]],
];

// One size statement -> the band keys it covers. Numbers win over words: a stated range ticks every band it
// overlaps, "500+" every band above 500, "up to 200" every band below.
export function sizeBandsForStatement(item, bands) {
  const b = Array.isArray(bands) ? bands : [];
  let min = parseLooseNumber(item && item.minEmployees);
  let max = parseLooseNumber(item && item.maxEmployees);
  const text = fold(item && item.text);
  if (min === null && max === null && text) {
    const nums = (String(item.text).match(/\d[\d.,']*\s*(?:k|000)?/gi) || [])
      .map((n) => parseLooseNumber(n.trim())).filter((n) => n !== null && n > 0);
    if (nums.length >= 2) { min = Math.min(nums[0], nums[1]); max = Math.max(nums[0], nums[1]); }
    else if (nums.length === 1) {
      if (/\b(up to|less than|fewer than|under|below|max|maximum)\b/.test(text)) max = nums[0];
      else min = nums[0];
    }
  }
  if (min !== null || max !== null) {
    const lo = min === null ? 0 : min;
    const hi = max === null ? Infinity : max;
    if (!(hi >= lo)) return [];
    // A band counts when the range really overlaps it, not when they only touch ("200-1,000" is not Small, 0-200).
    return b.filter((band) => band.max > lo && band.min <= hi).map((band) => band.key);
  }
  const keys = new Set();
  for (const [re, ks] of SIZE_WORDS) if (re.test(text)) ks.forEach((k) => keys.add(k));
  return b.map((band) => band.key).filter((k) => keys.has(k));
}

function mapSizes(items, bands) {
  const keys = new Set();
  const sources = [];
  const texts = [];
  for (const it of list(items)) {
    const hit = sizeBandsForStatement(it, bands);
    if (!hit.length) continue;
    hit.forEach((k) => keys.add(k));
    if (cleanText(it.text, 120)) texts.push(cleanText(it.text, 120));
    if (webUrlOrNull(it.url)) sources.push(it.url);
  }
  return { value: (bands || []).map((band) => band.key).filter((k) => keys.has(k)), texts, sources };
}

// ---------------------------------------------------------------------------------------------------
// Industries and organisation types
// ---------------------------------------------------------------------------------------------------

// The wizard's industries are the 11 GICS sectors. The research names each customer industry and, where it is
// clear, the sector it belongs to - picked from that closed list - so the model never produces an id. Code
// takes the sector only when it is one of the wizard's names; otherwise the industry's own name, if it IS one.
export function mapIndustry(item, wizardIndustries) {
  const byFold = new Map((wizardIndustries || []).map((n) => [fold(n), n]));
  return byFold.get(fold(item && item.sector)) || byFold.get(fold(item && item.name)) || null;
}

// Organisation types the answer may name -> the wizard's types (industry-id-map.js EXCLUDABLE_INDUSTRIES).
const ORG_TYPE_PATTERNS = [
  [/\b(non ?profits?|ngos?|charit(y|ies)|foundations?|not for profit)\b/, "Non-profit Organizations"],
  [/\b(public sector|government|public administration|municipalit(y|ies)|cantons?|ministr(y|ies)|public authorit(y|ies)|federal|agencies)\b/, "Government Administration"],
  [/\b(international organi[sz]ations?|international affairs|un agencies|united nations|intergovernmental)\b/, "International Affairs"],
  [/\b(universit(y|ies)|higher education|colleges?|business schools?)\b/, "Higher Education"],
  [/\b(research (institutes?|institutions?|organi[sz]ations?|centers?|centres?|services))\b/, "Research Services"],
  [/\b(associations?|civic|social organi[sz]ations?|clubs?|federations?)\b/, "Civic and Social Organizations"],
];

export function mapOrganizationType(name, wizardTypes) {
  const text = fold(name);
  const types = new Set(wizardTypes || []);
  const exact = (wizardTypes || []).find((t) => fold(t) === text);
  if (exact) return exact;
  for (const [re, type] of ORG_TYPE_PATTERNS) if (re.test(text) && types.has(type)) return type;
  return null;
}

function mapIndustries(industryItems, orgItems, ctx) {
  const value = [];
  const unmapped = [];
  const sources = [];
  for (const it of list(industryItems)) {
    const name = cleanText(it.name, 80);
    const hit = mapIndustry(it, ctx.industries);
    if (hit) { if (!value.includes(hit)) value.push(hit); if (webUrlOrNull(it.url)) sources.push(it.url); }
    // Every customer industry also goes to the Ideal customer text when the wizard has no exactly matching
    // name: a sector is coarse ("Health Care"), the industry itself ("Medical devices") is what the seller said.
    if (name && !(ctx.industries || []).some((n) => fold(n) === fold(name))) unmapped.push(name);
  }
  const orgTypes = [];
  for (const it of list(orgItems)) {
    const hit = mapOrganizationType(it.name, ctx.orgTypes);
    if (hit && !orgTypes.includes(hit)) { orgTypes.push(hit); if (webUrlOrNull(it.url)) sources.push(it.url); }
  }
  return { value, unmapped: [...new Set(unmapped)], orgTypes, sources };
}

// ---------------------------------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------------------------------

// Words that say how senior a title is, or join it - not what the person does, so never a title keyword.
const TITLE_STOP_WORDS = new Set([
  "chief", "officer", "head", "of", "and", "the", "for", "vice", "president", "vp", "svp", "evp", "director",
  "manager", "senior", "sr", "junior", "lead", "leader", "global", "group", "regional", "executive", "general",
  "deputy", "assistant", "associate", "principal", "member", "board", "chair", "chairman", "chairwoman",
  "management", "team", "department", "in", "at", "to", "a", "an", "c", "level", "&", "ceo", "coo", "cfo", "cto",
  "cio", "cmo", "cdo", "cro", "cpo", "ciso", "chro", "caio", "md", "partner", "owner", "founder", "co",
]);

// "CTO", "CDO" and the like are C-level even where readiness.js's patterns (written for research labels) miss them.
export function seniorityOfTitle(title) {
  const t = String(title || "").trim();
  if (/^c[a-z]{1,3}o$/i.test(t) || /\bC[A-Z]{1,3}O\b/.test(t)) return "cLevel";
  return seniorityLevelFromLabel(t);
}

export function titleKeywords(titles) {
  const counts = new Map();
  const display = new Map();
  for (const title of titles) {
    const seen = new Set();
    for (const raw of String(title).split(/[^A-Za-zÀ-ÿ0-9]+/)) {
      const w = fold(raw);
      if (!w || w.length < 3 || TITLE_STOP_WORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) || 0) + 1);
      if (!display.has(w)) display.set(w, raw.charAt(0).toUpperCase() + raw.slice(1));
    }
  }
  // A keyword widens the LinkedIn People search a lot, so only words that recur across the buyer titles.
  return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEYWORDS).map(([w]) => display.get(w));
}

function mapContacts(items) {
  const exactTitles = [];
  const sources = [];
  for (const it of list(items)) {
    const title = cleanText(it.title, 100);
    if (!title || exactTitles.some((t) => fold(t) === fold(title))) continue;
    exactTitles.push(title);
    if (webUrlOrNull(it.url)) sources.push(it.url);
  }
  const titles = exactTitles.slice(0, MAX_TITLES);
  const seniority = [];
  for (const t of titles) {
    const level = seniorityOfTitle(t);
    if (level && !seniority.includes(level)) seniority.push(level);
  }
  return { exactTitles: titles, keywords: titleKeywords(titles), seniority, sources };
}

// ---------------------------------------------------------------------------------------------------
// Resources and exclusions
// ---------------------------------------------------------------------------------------------------

// "Things you can offer" promises that the AI never invents an offer, so a resource is kept only with a link to
// a page on the seller's own site (a report on a third-party site is not the seller's to offer).
function mapResources(items, sellerDomain) {
  const out = [];
  let dropped = 0;
  for (const it of list(items)) {
    const title = cleanText(it.title, 160);
    const url = webUrlOrNull(it.url);
    if (!title || !url || !sellerDomain || !isOnDomain(url, sellerDomain)) { dropped++; continue; }
    if (out.some((r) => r.url === url || fold(r.text) === fold(title))) continue;
    out.push({ text: title, url });
  }
  return { items: out.slice(0, MAX_RESOURCES), dropped, sources: out.map((r) => r.url) };
}

// The stored form of an offer: one line, which drafting reads as it is ("Title - https://...").
export function offerLine(item) {
  const text = cleanText(item && item.text, 160);
  const url = webUrlOrNull(item && item.url);
  return url ? `${text} - ${url}` : text;
}

const EXCLUSION_KEYS = [["competitors", "competitor"], ["customers", "customer"], ["partners", "partner"]];

// Name and website are enough (R5, decided 2026-09-28): no LinkedIn visit, and a LinkedIn link is never guessed.
// An entry needs a website or a source page; the seller itself never ends up on its own exclusion list.
function mapExclusions(raw, ctx) {
  const items = [];
  const seen = new Set();
  const sellerName = normalizeCompanyName(ctx.sellerName || "");
  for (const [key, category] of EXCLUSION_KEYS) {
    let n = 0;
    for (const it of list(raw[key])) {
      const name = cleanText(it.name, 120);
      const website = websiteDomain(it.website) ? String(it.website).trim() : null;
      const domain = websiteDomain(website);
      const sourceUrl = webUrlOrNull(it.url);
      if (!name || (!domain && !sourceUrl)) continue;
      const norm = normalizeCompanyName(name);
      if ((sellerName && norm === sellerName) || (domain && ctx.sellerDomain && domain === ctx.sellerDomain)) continue;
      if (seen.has(norm) || (domain && seen.has(domain))) continue;
      seen.add(norm);
      if (domain) seen.add(domain);
      items.push({ name, website, domain, category, sourceUrl });
      if (++n >= MAX_EXCLUSIONS_PER_CATEGORY) break;
    }
  }
  return { items, sources: items.map((e) => e.sourceUrl).filter(Boolean) };
}

// ---------------------------------------------------------------------------------------------------
// The whole answer
// ---------------------------------------------------------------------------------------------------

const LANGUAGE_BY_CODE = { de: "german", fr: "french", en: "english" };

export function outputLanguageForSite(code) {
  const c = String(code || "").trim().toLowerCase().slice(0, 2);
  return LANGUAGE_BY_CODE[c] || null;
}

const uniqueSources = (urls) => [...new Set((urls || []).filter(isWebUrl).map((u) => String(u).trim()))].slice(0, 6);
const textField = (v) => (v && typeof v === "object" ? { text: cleanText(v.text, 2000), url: webUrlOrNull(v.url) } : { text: cleanText(v, 2000), url: null });

// raw: the research's DATA answer (design 3.3). ctx: { countries (the picker's), sizeBuckets, industries (the
// wizard's names), orgTypes, sellerName, sellerWebsite }. `only` (optional): the steps to build - the others are
// left out, for a "Research again" on one step. Returns { [step]: proposal }, each with `found`.
export function buildSetupProposals(raw, ctx, only) {
  const r = raw && typeof raw === "object" ? raw : {};
  const c = { ...(ctx || {}) };
  c.sellerDomain = websiteDomain(c.sellerWebsite);
  const want = (step) => !only || only.includes(step);
  const out = {};

  if (want("about")) {
    const outputLanguage = outputLanguageForSite(r.siteLanguage);
    out.about = { outputLanguage, found: !!outputLanguage, sources: [] };
  }
  if (want("location")) {
    const m = mapCountries(r.sellsToCountries, c.countries);
    out.location = { value: m.value, dropped: m.dropped, sources: uniqueSources(m.sources), found: m.value.length > 0 };
  }
  if (want("size")) {
    const m = mapSizes(r.customerSizes, c.sizeBuckets);
    out.size = { value: m.value, texts: m.texts, sources: uniqueSources(m.sources), found: m.value.length > 0 };
  }
  const ind = mapIndustries(r.customerIndustries, r.organizationTypes, c);
  if (want("industry")) {
    out.industry = { value: ind.value, unmapped: ind.unmapped, orgTypes: ind.orgTypes, sources: uniqueSources(ind.sources), found: ind.value.length > 0 || ind.orgTypes.length > 0 };
  }
  if (want("company-context")) {
    const s = textField(r.summary);
    out["company-context"] = { value: s.text, sources: uniqueSources([s.url]), found: !!s.text };
  }
  if (want("value-add-offers")) {
    const m = mapResources(r.resources, c.sellerDomain);
    out["value-add-offers"] = { items: m.items, dropped: m.dropped, sources: uniqueSources(m.sources), found: m.items.length > 0 };
  }
  if (want("icp")) {
    const s = textField(r.idealCustomer);
    // Industries the wizard cannot tick (R5, N10.3) are kept here, in the seller's own words.
    const extra = ind.unmapped.length ? `Customer industries: ${ind.unmapped.join(", ")}.` : "";
    const value = [s.text, extra].filter(Boolean).join("\n\n");
    out.icp = { value, sources: uniqueSources([s.url]), found: !!value };
  }
  if (want("contacts")) {
    const m = mapContacts(r.buyerTitles);
    out.contacts = { exactTitles: m.exactTitles, keywords: m.keywords, seniority: m.seniority, sources: uniqueSources(m.sources), found: m.exactTitles.length > 0 };
  }
  if (want("exclusions")) {
    const m = mapExclusions(r, c);
    out.exclusions = { items: m.items, sources: uniqueSources(m.sources), found: m.items.length > 0 };
  }
  return out;
}

// The steps a "Research again" on `step` rebuilds: the Industry step's answer also feeds the Ideal customer note.
export function stepsRebuiltBy(step) {
  if (step === "industry") return ["industry", "icp"];
  return [step];
}

// Which of a list proposal's items start ticked (R4.5): on a first setup all of them; for a setup already
// completed only those already in the saved value, so nothing saved changes unless the user ticks it.
export function initiallyTicked(itemKeys, savedKeys, completedBefore) {
  const saved = new Set((savedKeys || []).map(fold));
  return (itemKeys || []).map((k) => (completedBefore ? saved.has(fold(k)) : true));
}

// A checklist's result merged with the step's own free lines: ticked items first (in their order), then the
// free lines that are not one of the checklist's items, case- and accent-insensitively de-duplicated.
export function mergeChecklistWithLines(checklist, lines) {
  const itemKeys = new Set((checklist || []).map((i) => fold(i.text)));
  const out = [];
  const seen = new Set();
  const add = (s) => { const k = fold(s); if (k && !seen.has(k)) { seen.add(k); out.push(String(s).trim()); } };
  for (const i of checklist || []) if (i.checked) add(i.text);
  for (const l of lines || []) if (!itemKeys.has(fold(l))) add(l);
  return out;
}
