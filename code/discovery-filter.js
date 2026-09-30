// Web Discovery's decisions (ONBOARDING_RESEARCH_DESIGN.md 4.2-4.3): which rows read off a listing page are
// kept, how many to take from each size band, and in which order. The calls that find and read the listings
// live in agent-shared.js and web-discovery.js; everything that DECIDES is here, so it can be tested.
//
// PURE: no chrome.*, no DOM, no URL class. Executed and asserted on by test_pure_modules.py.
import { normalizeCompanyName, websiteDomain, matchesExclusion } from "./company-identity.js";
import { parseLooseNumber } from "./value-normalize.js";

// Start margin (D3): 15% more than the target, since some accounts end Lacking evidence. Replaced by the
// measured share once there is one (R7.6).
export const DISCOVERY_MARGIN = 0.15;

export const DISCOVERY_DROP_REASONS = {
  noName: "no company name",
  seller: "your own company",
  excluded: "on your exclusion list",
  removed: "an account you removed",
  existing: "already an account",
  duplicate: "listed twice",
  size: "outside the sizes you target",
  industry: "outside the industries you target",
  orgType: "an organisation type you exclude",
};

// The log-scale centre of a size band (design 4.3, D9): sqrt(min x max). Small (open at the bottom) uses 100,
// Extra Extra Large (open at the top) uses 10,000.
export function bandCentre(band) {
  if (!band) return null;
  if (!(band.min > 0)) return 100;
  if (!Number.isFinite(band.max)) return 10000;
  return Math.round(Math.sqrt(band.min * band.max));
}

export function bandOf(employees, bands) {
  const n = parseLooseNumber(employees);
  if (n === null || n < 0) return null;
  return (bands || []).find((b) => n >= b.min && n <= (Number.isFinite(b.max) ? b.max : Infinity)) || null;
}

// How many accounts to find: the target plus the margin, rounded up.
export function discoveryWanted(target, margin = DISCOVERY_MARGIN) {
  const t = Math.max(1, Math.round(Number(target) || 0));
  return Math.ceil(t * (1 + (Number(margin) || 0)) - 1e-9);
}

// The ticked bands with their share of `wanted`, in proportion to their priority (1-3), largest share first.
// sizeBuckets: { S: { checked, priority }, ... }; bands: SIZE_PRIORITY_BUCKETS. Shares add up to `wanted`
// (largest remainder); a band's share can be 0 when `wanted` is smaller than the number of bands.
export function bandTargets(sizeBuckets, bands, wanted) {
  const ticked = (bands || []).filter((b) => sizeBuckets && sizeBuckets[b.key] && sizeBuckets[b.key].checked);
  const list = ticked.length ? ticked : (bands || []);
  const weight = (b) => Math.max(1, Number(sizeBuckets && sizeBuckets[b.key] && sizeBuckets[b.key].priority) || 2);
  const total = list.reduce((a, b) => a + weight(b), 0) || 1;
  const out = list.map((b, i) => {
    const exact = (wanted * weight(b)) / total;
    return { key: b.key, label: b.label, min: b.min, max: b.max, centre: bandCentre(b), priority: weight(b), count: Math.floor(exact), rest: exact - Math.floor(exact), i };
  });
  let left = wanted - out.reduce((a, b) => a + b.count, 0);
  for (const b of [...out].sort((x, y) => y.rest - x.rest || y.priority - x.priority || x.i - y.i)) {
    if (left <= 0) break;
    b.count++;
    left--;
  }
  return out
    .sort((x, y) => y.priority - x.priority || x.i - y.i)
    .map(({ rest, i, ...b }) => b);
}

// true when the ticked bands are the largest ones (design 4.3: a top-N-largest ranking fits only then).
export function targetsLargest(sizeBuckets, bands) {
  const ticked = (bands || []).filter((b) => sizeBuckets && sizeBuckets[b.key] && sizeBuckets[b.key].checked);
  if (ticked.length === 0 || ticked.length === (bands || []).length) return true;
  return ticked.every((b) => b.min >= 1001);
}

// The identity sets the filter checks a row against. accounts: [{ company, website, linkedinCompanyId,
// deleted }] - every workbook row, removed ones included.
export function buildKnownCompanies(accounts) {
  const known = { names: new Set(), domains: new Set(), removedNames: new Set(), removedDomains: new Set() };
  for (const a of accounts || []) {
    const n = normalizeCompanyName(a.company || "");
    const d = websiteDomain(a.website || "");
    if (a.deleted) {
      if (n) known.removedNames.add(n);
      if (d) known.removedDomains.add(d);
    } else {
      if (n) known.names.add(n);
      if (d) known.domains.add(d);
    }
  }
  return known;
}

// One listing row, cleaned: { name, website, domain, hqCountry, employees (number|null), revenue, currency,
// year, industry, industryMatch, isPublic, rank, sourceUrl }.
export function cleanListingRow(raw, fallbackSourceUrl) {
  const r = raw || {};
  const name = String(r.name || "").replace(/\s+/g, " ").trim();
  const website = String(r.website || "").trim() || null;
  const employees = parseLooseNumber(r.employees);
  const revenue = parseLooseNumber(r.revenue);
  const rank = parseLooseNumber(r.rank);
  const industryMatch = r.industryMatch === undefined ? null : r.industryMatch;
  return {
    name, website, domain: websiteDomain(website || ""),
    hqCountry: String(r.hqCountry || "").trim() || null,
    employees: employees !== null && employees >= 0 ? Math.round(employees) : null,
    revenue: revenue !== null && revenue >= 0 ? revenue : null,
    currency: /^[A-Z]{3}$/.test(String(r.currency || "").trim().toUpperCase()) ? String(r.currency).trim().toUpperCase() : null,
    year: parseLooseNumber(r.year),
    industry: String(r.industry || "").trim() || null,
    industryMatch: industryMatch === null ? null : String(industryMatch).trim(),
    isPublic: r.isPublic === true ? true : r.isPublic === false ? false : null,
    rank: rank !== null ? rank : null,
    sourceUrl: String(r.sourceUrl || fallbackSourceUrl || "").trim() || null,
  };
}

// Design 4.2: each row passes, in order, the seller's own company, the exclusion list, the accounts the user
// removed, the existing accounts, the rows already kept (listed twice), then - only where the row states it -
// the ticked size bands, the industries and the excluded organisation types. A row that states no size is
// kept: research finds it.
// ctx: { seller: { name, website }, exclusions (buildExclusionMatcher), known (buildKnownCompanies),
//        sizeBuckets, bands, industryNames: [..] (empty = no industry targeting),
//        excludedOrgTypes: [..] (industry names the Organisation types step set to "no") }
// Returns { kept: [row], dropped: [{ row, reason }] }. `known` gains the kept rows, so a later call with the
// same ctx drops them as "listed twice".
export function filterListingRows(rows, ctx) {
  const c = ctx || {};
  const known = c.known || buildKnownCompanies([]);
  if (!known.keptNames) { known.keptNames = new Set(); known.keptDomains = new Set(); }
  const sellerName = normalizeCompanyName((c.seller && c.seller.name) || "");
  const sellerDomain = websiteDomain((c.seller && c.seller.website) || "");
  const industries = (c.industryNames || []).map((n) => String(n).toLowerCase());
  const orgTypes = new Set((c.excludedOrgTypes || []).map((n) => String(n).toLowerCase()));
  const ticked = (c.bands || []).filter((b) => c.sizeBuckets && c.sizeBuckets[b.key] && c.sizeBuckets[b.key].checked);
  const kept = [];
  const dropped = [];
  for (const row of rows || []) {
    const n = normalizeCompanyName(row.name || "");
    const d = row.domain || websiteDomain(row.website || "");
    let reason = null;
    if (!n) reason = "noName";
    else if ((sellerName && n === sellerName) || (sellerDomain && d === sellerDomain)) reason = "seller";
    else if (c.exclusions && matchesExclusion(c.exclusions, { name: row.name, website: row.website })) reason = "excluded";
    else if (known.removedNames.has(n) || (d && known.removedDomains.has(d))) reason = "removed";
    else if (known.names.has(n) || (d && known.domains.has(d))) reason = "existing";
    else if (known.keptNames.has(n) || (d && known.keptDomains.has(d))) reason = "duplicate";
    else if (row.employees !== null && row.employees !== undefined && ticked.length > 0 && ticked.length < (c.bands || []).length &&
      !ticked.some((b) => row.employees >= b.min && row.employees <= (Number.isFinite(b.max) ? b.max : Infinity))) reason = "size";
    // The listing call maps a stated industry onto the wizard's names: "none" when the company clearly
    // belongs to none of them, null when unsure - only "none" drops the row.
    else if (industries.length > 0 && row.industryMatch && row.industryMatch.toLowerCase() === "none") reason = "industry";
    else if (orgTypes.size > 0 && row.industry && orgTypes.has(row.industry.toLowerCase())) reason = "orgType";
    if (reason) { dropped.push({ row, reason }); continue; }
    known.keptNames.add(n);
    if (d) known.keptDomains.add(d);
    kept.push(row);
  }
  return { kept, dropped };
}

// Counts per drop reason: { existing: 12, size: 3, ... }.
export function dropCounts(dropped) {
  const out = {};
  for (const d of dropped || []) out[d.reason] = (out[d.reason] || 0) + 1;
  return out;
}

// Design 4.3: included companies first, then within each band by pre-score (higher first), then by how close
// the headcount is to the band's centre (log scale), then by listing rank. Each band gets its share of
// `wanted`; a band short of rows leaves its share to the others, and rows without a headcount come after
// every row with one.
// rows: kept rows, each with { preScore (number|null), included (bool) }. targets: bandTargets(...).
// Returns the chosen rows, best first, at most `wanted`.
export function chooseDiscoveryRows(rows, targets, wanted) {
  const logDist = (emp, centre) => (emp > 0 && centre > 0 ? Math.abs(Math.log(emp) - Math.log(centre)) : Infinity);
  const cmp = (centre) => (a, b) =>
    (Number(b.preScore) || 0) - (Number(a.preScore) || 0) ||
    logDist(a.employees, centre) - logDist(b.employees, centre) ||
    (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
    String(a.name).localeCompare(String(b.name));
  const chosen = [];
  const taken = new Set();
  const take = (r) => { if (!taken.has(r) && chosen.length < wanted) { taken.add(r); chosen.push(r); } };
  for (const r of rows.filter((x) => x.included)) take(r);
  const bandsList = targets || [];
  const inBand = (r, b) => r.employees !== null && r.employees !== undefined && r.employees >= b.min && r.employees <= (Number.isFinite(b.max) ? b.max : Infinity);
  const perBand = bandsList.map((b) => ({ b, list: rows.filter((r) => !taken.has(r) && inBand(r, b)).sort(cmp(b.centre)) }));
  // Scale the band shares to what is left after the included companies.
  const room = Math.max(0, wanted - chosen.length);
  const shareTotal = bandsList.reduce((a, b) => a + b.count, 0) || 1;
  for (const { b, list } of perBand) {
    const share = Math.round((b.count * room) / shareTotal);
    for (const r of list.slice(0, share)) take(r);
  }
  // What is still free: first the rest of the rows with a headcount (their band's order), then those without.
  const withSize = perBand.flatMap(({ list }) => list).filter((r) => !taken.has(r));
  withSize.sort((a, b) => (Number(b.preScore) || 0) - (Number(a.preScore) || 0) || (a.rank ?? Infinity) - (b.rank ?? Infinity));
  for (const r of withSize) take(r);
  const noSize = rows.filter((r) => !taken.has(r) && (r.employees === null || r.employees === undefined)).sort(cmp(null));
  for (const r of noSize) take(r);
  for (const r of rows) take(r); // headcounts outside every target band (no size targeting at all)
  return chosen;
}
