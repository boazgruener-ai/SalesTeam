// Country -> LinkedIn geoUrn mapping, confirmed live only (PRD 6.20 Phase 0
// item #3) - never guessed. Deliberately its own tiny file, not folded into
// storage.js, so it can grow one confirmed entry at a time without churning
// a large shared file, and so the onboarding wizard's Location step
// (Phase 2) can import just this small confirmed list rather than the full
// ~150-country ALL_COUNTRIES set Location Filter (6.13) uses - unlike that
// feature (which only classifies already-scraped text), this one has to
// build a real LinkedIn search facet, so an unconfirmed country simply isn't
// offered yet rather than risking a guessed/wrong geoUrn.
export const GEO_URN_MAP = {
  Switzerland: "106693272",
  Germany: "101282230",
  Greece: "104677530",
  Australia: "101452733",
  Belgium: "100565514",
  Canada: "101174742",
  "Costa Rica": "101739942",
  "United Kingdom": "101165590",
  Chile: "104621616",
  Colombia: "100876405",
};

// The onboarding wizard's country picker draws from this, not
// ALL_COUNTRIES - see the file header above for why.
export const CONFIRMED_COUNTRIES = Object.keys(GEO_URN_MAP).sort((a, b) => a.localeCompare(b));

export function geoUrnForCountry(country) {
  return GEO_URN_MAP[country] || null;
}
