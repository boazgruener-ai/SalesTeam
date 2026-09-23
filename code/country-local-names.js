// Country -> local-language name mapping, keyed by the same canonical
// English country name geo-urn-map.js's GEO_URN_MAP uses. Unlike that file
// and industry-id-map.js, these aren't LinkedIn-specific facts that need
// live confirmation against the real UI - a country's own name in German or
// French is ordinary, verifiable real-world knowledge, not something
// LinkedIn defines - so this table is filled in directly rather than grown
// one live-confirmed entry at a time. Still deliberately scoped to only the
// countries geo-urn-map.js's GEO_URN_MAP already covers (a language name for
// a country Phase 5 can't even search yet would be dead data), and still
// never guessed AT - a country added to GEO_URN_MAP without a matching
// entry here simply isn't offered in that language (see
// company-discovery-extraction.js's resolveTargetCountries and its
// unscopedLanguageCountries), not silently skipped without a trace.
//
// Consumed by company-discovery-extraction.js's resolveTargetCountries to
// build one additional Company Search unit per selected keyword-search
// language (storage.js's keywordSearchLanguages) per country, each using
// that language's own name as the keywords= anchor term instead of the
// English name every country always searches under.
export const COUNTRY_LOCAL_NAMES = {
  Switzerland: { German: "Schweiz", French: "Suisse" },
  Germany: { German: "Deutschland", French: "Allemagne" },
  Greece: { German: "Griechenland", French: "Grèce" },
  Australia: { German: "Australien", French: "Australie" },
  Belgium: { German: "Belgien", French: "Belgique" },
  Canada: { German: "Kanada", French: "Canada" },
  "Costa Rica": { German: "Costa Rica", French: "Costa Rica" },
  "United Kingdom": { German: "Vereinigtes Königreich", French: "Royaume-Uni" },
  Chile: { German: "Chile", French: "Chili" },
  Colombia: { German: "Kolumbien", French: "Colombie" },
};

export function localCountryName(country, language) {
  return COUNTRY_LOCAL_NAMES[country]?.[language] || null;
}
