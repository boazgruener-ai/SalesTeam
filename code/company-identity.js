// Who a company IS, without LinkedIn: its normalised name, its website domain, the id of a row found on the
// web, and whether the user's exclusion list names it (ONBOARDING_RESEARCH_DESIGN.md 3.9 and 4.4).
//
// PURE: no chrome.*, no DOM, no URL class (the test harness's V8 has none). Executed and asserted on by
// test_pure_modules.py. storage.js re-exports normalizeCompanyName, so every existing import still works.

// Best-effort match key for grouping leads by company - not authoritative
// (e.g. "Azqore" vs "Azqore SA" collapse to the same key, but an unusual
// suffix this doesn't know about won't). Always show the lead's own raw
// `company` string alongside any grouping so a bad merge is still visible.
const COMPANY_SUFFIX_RE = /\s+(sa|ag|gmbh|inc|ltd|llc|corp|plc|co|sarl|srl|bv|nv|group|holding|holdings)\s*$/i;

export function normalizeCompanyName(name) {
  if (!name) return "";
  const collapsed = name.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  return collapsed.replace(COMPANY_SUFFIX_RE, "").trim();
}

// "https://www.Nestle.com/ch/en?x=1" -> "nestle.com"; "nestle.com" -> "nestle.com". Lower-cased, "www." (and
// "www2." etc.) stripped, port and path dropped. null for anything without a dot in the host - a bare word
// is a name, not a website.
export function websiteDomain(url) {
  const s = String(url || "").trim().toLowerCase();
  if (!s) return null;
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/?#\s]*@)?([^/?#:\s]+)/.exec(s);
  if (!m) return null;
  const host = m[1].replace(/^www\d*\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

// The companyId of a row found on the web (source "Web"): "W-<domain>", or "W-<normalised name>" when it has
// no website. Stable, so the same company found again by a later discovery maps onto the same row.
export function webCompanyId(website, name) {
  const domain = websiteDomain(website);
  if (domain) return `W-${domain}`;
  const n = normalizeCompanyName(name);
  return n ? `W-${n}` : null;
}

// companyExclusions entries are { slug?, name?, domain?, category, source? }: a LinkedIn slug (as before
// 1.2.1), and/or a company name and website domain (proposed by onboarding research, which never visits
// LinkedIn for an exclusion). Built once per list, not per row. `lifted`: LinkedIn slugs the user took off
// the list, which also overrides the research workbook's own Excluded flag (storage.js isCompanyRowExcluded).
//
// 1.2.3 (EXCLUSIONS_RELATIONSHIPS_DESIGN.md 3.2): customer / partner entries are NOT exclusions - they are skipped
// here even when still on the list (an old backup, a team member before the Team Admin's copy has moved them), so
// no exclusion check hides a customer. `kept`: a relationship matcher (buildRelationshipMatcher) - a company on it
// is not hidden by the research workbook's own Excluded flag either (isCompanyRowExcluded), like a lifted slug.
const RELATIONSHIP_CATEGORY_SET = new Set(["customer", "partner"]);

function identitySets(entries) {
  const slugs = new Set();
  const names = new Set();
  const domains = new Set();
  for (const e of entries || []) {
    if (!e) continue;
    if (e.slug) slugs.add(String(e.slug).toLowerCase());
    const n = normalizeCompanyName(e.name || "");
    if (n) names.add(n);
    const d = websiteDomain(e.domain || "");
    if (d) domains.add(d);
  }
  return { slugs, names, domains };
}

export function buildExclusionMatcher(exclusions, lifted, kept = null) {
  const { slugs, names, domains } = identitySets((exclusions || []).filter((e) => e && !RELATIONSHIP_CATEGORY_SET.has(e.category)));
  const liftedSlugs = new Set((lifted || []).filter(Boolean).map((s) => String(s).toLowerCase()));
  return { slugs, names, domains, lifted: liftedSlugs, kept: kept || null };
}

// { customer: {slugs,names,domains}, partner: {...} } from the relationship list plus any customer / partner
// entries still on the exclusion list (design 3.2) - so tags are right before the move has happened.
export function buildRelationshipMatcher(relationships, legacyExclusions) {
  const all = [...(relationships || []), ...(legacyExclusions || []).filter((e) => e && RELATIONSHIP_CATEGORY_SET.has(e.category))];
  return {
    customer: identitySets(all.filter((e) => e && e.category === "customer")),
    partner: identitySets(all.filter((e) => e && e.category === "partner")),
  };
}

// The categories a company matches: [], ["customer"], ["partner"] or ["customer", "partner"].
export function relationshipOf(matcher, company = {}) {
  if (!matcher) return [];
  return ["customer", "partner"].filter((c) => matcher[c] && matchesExclusion(matcher[c], company));
}

// true when the relationship matcher names the company in any category.
export function matchesRelationship(matcher, company = {}) {
  return relationshipOf(matcher, company).length > 0;
}

// true when the matcher names this company by its LinkedIn slug, its normalised name or its website domain.
export function matchesExclusion(matcher, { slug, name, website } = {}) {
  if (!matcher) return false;
  if (slug && matcher.slugs.has(String(slug).toLowerCase())) return true;
  const n = normalizeCompanyName(name || "");
  if (n && matcher.names.has(n)) return true;
  const d = websiteDomain(website || "");
  return Boolean(d && matcher.domains.has(d));
}

// The LinkedIn company-page slug of a URL ("https://www.linkedin.com/company/acme-ag/" -> "acme-ag"), or null. Same
// rule as storage.js parseLinkedinCompanySlug, here so the pure modules can use it.
export function linkedinCompanySlug(url) {
  if (!url) return null;
  const match = String(url).trim().match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

// One row of a Setup company list (1.2.3 design 9.2): Company, LinkedIn page, Website - at least one of the three.
// -> { entry: { name?, slug?, domain? } } or { error }. A LinkedIn link must be a company page; never guessed.
export function parseCompanyListEntry({ name, linkedin, website } = {}) {
  const n = String(name || "").trim();
  const l = String(linkedin || "").trim();
  const w = String(website || "").trim();
  if (!n && !l && !w) return { error: "Enter the company's name, its LinkedIn page or its website." };
  const entry = {};
  if (n) entry.name = n;
  if (l) {
    const slug = linkedinCompanySlug(l);
    if (!slug) return { error: "The LinkedIn link must be a company page (linkedin.com/company/...)." };
    entry.slug = slug;
  }
  if (w) {
    if (/linkedin\.com/i.test(w)) return { error: "Put the LinkedIn link in the LinkedIn page column, not as the website." };
    const domain = websiteDomain(w);
    if (!domain) return { error: "The website is not a web address (for example acme.ch)." };
    entry.domain = domain;
  }
  return { entry };
}

// Same company? Two list entries (or an entry and a company) by slug, normalised name or domain.
export function sameCompanyEntry(a, b) {
  if (!a || !b) return false;
  if (a.slug && b.slug && String(a.slug).toLowerCase() === String(b.slug).toLowerCase()) return true;
  const na = normalizeCompanyName(a.name || "");
  if (na && na === normalizeCompanyName(b.name || "")) return true;
  const da = websiteDomain(a.domain || "");
  return Boolean(da && da === websiteDomain(b.domain || ""));
}
