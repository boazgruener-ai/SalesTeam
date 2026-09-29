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
// LinkedIn for an exclusion). Built once per list, not per row.
export function buildExclusionMatcher(exclusions) {
  const slugs = new Set();
  const names = new Set();
  const domains = new Set();
  for (const e of exclusions || []) {
    if (!e) continue;
    if (e.slug) slugs.add(String(e.slug).toLowerCase());
    const n = normalizeCompanyName(e.name || "");
    if (n) names.add(n);
    const d = websiteDomain(e.domain || "");
    if (d) domains.add(d);
  }
  return { slugs, names, domains };
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
