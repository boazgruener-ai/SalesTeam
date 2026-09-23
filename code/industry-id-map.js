// GICS Sector name -> LinkedIn industryCompanyVertical numeric id(s),
// confirmed live only (PRD 6.20 Phase 0 item #1), never guessed - same
// discipline and same incremental-growth shape as geo-urn-map.js.
//
// 27th round of direct feedback (2026-09-19) - rebuilt from a flat
// LinkedIn-label list (9 entries, e.g. "Technology, Information and
// Internet", "Financial Services") to the 11 GICS (Global Industry
// Classification Standard) Sectors instead: "the GICS list looks cleaner
// and more logical... present the 11 industry names from GICS and silently
// map them to the LinkedIn industry IDs (1 or 2 per sector)." LinkedIn's
// own taxonomy is a flat, company-self-selected list, not a hierarchical
// one - GICS Sector doesn't always match a single LinkedIn label 1:1, so a
// value here is an ARRAY of ids (1 or 2 confirmed so far; LinkedIn's search
// facet already accepts multiple ids at once, so this needs no special
// handling downstream - see company-discovery-extraction.js's
// resolveIndustryIds). Every id below was confirmed the same way as
// always: applying that exact LinkedIn Company Search "Industry" filter
// live and reading the resulting industryCompanyVertical id off the URL,
// not assumed from the filter panel's own displayed label.
//
// NOTE: this is a rename, not just an addition - a user's previously
// saved Settings/onboarding industry selections were stored under the OLD
// LinkedIn-label names (e.g. "Financial Services") and will no longer
// match any entry here (only "Utilities" happens to read the same in both
// schemes). They simply stop showing as checked rather than erroring -
// re-pick from the new 11-sector list after upgrading.
export const INDUSTRY_ID_MAP = {
  // LinkedIn "Oil and Gas" (only close single match; "Oil, Gas, and
  // Mining" was ruled out as too broad, since Materials/Mining below needs
  // its own separate id).
  Energy: ["57"],
  // GICS Materials spans Chemicals, Construction Materials, Containers &
  // Packaging, Metals & Mining, Paper & Forest Products - no single
  // LinkedIn label covers that; "Mining" + "Chemical Manufacturing" (both
  // general/parent categories, not a narrower sub-type like "Coal Mining"
  // or "Agricultural Chemical Manufacturing") were confirmed as the
  // closest 2-id combination.
  Materials: ["56", "54"],
  // LinkedIn "Manufacturing" - already confirmed pre-GICS; an imperfect
  // but reasonable single-label proxy for GICS Industrials (which also
  // spans commercial/professional services and transportation, neither
  // with its own confirmed id yet).
  Industrials: ["25"],
  // LinkedIn "Retail" (general, not a narrower sub-type like "Retail
  // Apparel and Fashion") - confirmed live: Walmart, Target, Nike, Lowe's,
  // The Home Depot.
  "Consumer Discretionary": ["27"],
  // LinkedIn "Food and Beverages" - already confirmed pre-GICS; narrower
  // than the full GICS Consumer Staples group (which also covers Household
  // & Personal Products), accepted as the closest available proxy.
  "Consumer Staples": ["34"],
  // LinkedIn "Hospitals and Health Care" + "Pharmaceutical Manufacturing" -
  // both already confirmed pre-GICS; together cover GICS Health Care's own
  // 2-way split (Equipment & Services vs. Pharmaceuticals/Biotech/Life
  // Sciences).
  "Health Care": ["14", "15"],
  // LinkedIn "Financial Services" - already confirmed pre-GICS.
  Financials: ["43"],
  // LinkedIn "Technology, Information and Internet" - already confirmed
  // pre-GICS.
  "Information Technology": ["6"],
  // LinkedIn "Telecommunications" - already confirmed pre-GICS; narrower
  // than GICS Communication Services (which also covers Media &
  // Entertainment, not yet confirmed), accepted as the closest available
  // proxy.
  "Communication Services": ["8"],
  // LinkedIn "Utilities" - already confirmed pre-GICS; the one sector
  // whose GICS name and LinkedIn label happen to read identically.
  Utilities: ["59"],
  // LinkedIn "Real Estate" (general) - confirmed live: JLL, CBRE, Cushman &
  // Wakefield, Zillow, Greystar. Covers both of GICS's own Real Estate
  // industry groups (Equity REITs and Real Estate Management &
  // Development) under one LinkedIn label.
  "Real Estate": ["44"],
};

// The onboarding wizard's Industry step draws from this, not free text -
// see the file header above for why.
export const CONFIRMED_INDUSTRIES = Object.keys(INDUSTRY_ID_MAP).sort((a, b) => a.localeCompare(b));

// Always returns an array (empty if unconfirmed) - a GICS sector can carry
// more than one LinkedIn id (see Materials/Health Care above), and
// company-discovery-extraction.js's resolveIndustryIds already collects
// facet ids into an array regardless, so this never needs special-casing
// the single-vs-multiple-id cases downstream.
export function industryIdForName(name) {
  return INDUSTRY_ID_MAP[name] || [];
}

// Confirmed live 2026-09-15 (PRD 6.20) - non-standard-organization-type
// industries the onboarding wizard's Organization Type step offers a
// three-state Yes/No/Review eligibility choice for (storage.js's
// organizationTypeEligibility - see its own header comment for why a plain
// exclude list isn't enough: a real ChatGPT-side audit found legitimate
// potential buyers, like MSF Switzerland and WWF Switzerland, that a binary
// exclude/include can't distinguish from ones too small to matter). Kept
// separate from INDUSTRY_ID_MAP/CONFIRMED_INDUSTRIES above (the INCLUSION
// catalog the Industry step's own checkbox list draws from) so these never
// show up there by mistake. Cross-verified in isolation, not assumed from a
// combined selection (same duplicate-ID caution as everywhere else in this
// codebase): with only "Government Administration" checked,
// industryCompanyVertical=["75"]; with only "Non-profit Organizations"
// checked, ["100"].
//
// This is only the confirmed-so-far subset of a much larger aspirational
// taxonomy the same ChatGPT audit proposed - for-profit corporation,
// private company, state-owned enterprise, public-sector organization,
// government agency, nonprofit foundation, nonprofit association, NGO,
// industry association, university/research institution, program/
// initiative, other. Each of those needs its own live-confirmed LinkedIn
// industryCompanyVertical id (or ids - a broader category like "nonprofit"
// may span more than one real LinkedIn vertical) before it can be added
// here and actually enforced - same incremental, never-guessed growth as
// every other id table in this codebase, not built all at once.
//
// The id is recorded for completeness/future use (e.g. a future company-
// page industry-vertical check), but v1 enforcement
// (company-discovery-extraction.js) matches a card's own DISPLAYED industry
// text instead, not this id - confirmed live the two don't always agree:
// the World Health Organization and UNHCR are both categorized under
// Non-profit Organizations by this id, but their cards display
// "International Affairs" as their own industry text. A card matching by
// this id but displaying different text isn't caught without an extra page
// visit - a real touch-budget cost not spent automatically for this, so
// it's an accepted v1 gap (some misses), not a guess at every possible
// sub-label a member of these categories might display instead.
export const EXCLUDABLE_INDUSTRIES = {
  "Non-profit Organizations": "100",
  "Government Administration": "75",
  "International Affairs": "74",
  "Higher Education": "68",
  "Research Services": "70",
  "Civic and Social Organizations": "90",
};

// "Think Tanks", "Executive Offices" and "International Trade and
// Development" were tried live and confirmed NOT to exist as their own
// LinkedIn industryCompanyVertical labels (no autocomplete match in the
// "+ Add an industry" search, even after allowing for the panel's render
// delay) - not omissions, ruled out.
//
// This TYPE list is deliberately separate from SCALE. Per the user
// (2026-09-15): "Do not exclude by legal form. Rank by operating scale,
// buying potential and fit. Membership numbers, volunteers, ecosystem
// reach, or brand visibility should never substitute for employee/budget
// scale." A large research institute, university, or humanitarian
// organization (e.g. CERN, ETH Zurich, ICRC, WEF, Swiss National Bank,
// FINMA, FIFA/UEFA) can be a perfectly good target account despite its
// organization type - this map only lets the user flag TYPES for review or
// exclusion; it is not where scale/size judgment happens (that's a
// separate, not-yet-built concern - see the plan doc).
