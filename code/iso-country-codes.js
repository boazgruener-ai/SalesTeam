// ISO 3166-1 alpha-2 country codes, mapped to the exact same canonical
// country names storage.js's CONTINENT_COUNTRIES/ALL_COUNTRIES already use -
// the free tier of Phase 5's location check (PRD 6.20) matches one of
// these codes directly against a Company Search card's own location text
// (e.g. "Zurich, CH"), before ever falling back to a page visit. Unlike
// geoUrn/industryCompanyVertical, this is a public, stable, non-LinkedIn
// standard - safe to hard-code in full rather than confirm live one entry
// at a time, since there's nothing LinkedIn-specific to guess here.
export const ISO_COUNTRY_CODES = {
  "United States": "US", Canada: "CA",
  Mexico: "MX", Guatemala: "GT", Belize: "BZ", Honduras: "HN", "El Salvador": "SV", Nicaragua: "NI",
  "Costa Rica": "CR", Panama: "PA", Cuba: "CU", "Dominican Republic": "DO", Haiti: "HT", Jamaica: "JM",
  "Trinidad and Tobago": "TT", Bahamas: "BS", Barbados: "BB", Colombia: "CO", Venezuela: "VE", Ecuador: "EC",
  Peru: "PE", Brazil: "BR", Bolivia: "BO", Paraguay: "PY", Chile: "CL", Argentina: "AR", Uruguay: "UY",
  Guyana: "GY", Suriname: "SR",
  "United Kingdom": "GB", Switzerland: "CH", Germany: "DE", France: "FR", Italy: "IT", Spain: "ES",
  Portugal: "PT", Netherlands: "NL", Belgium: "BE", Luxembourg: "LU", Ireland: "IE", Austria: "AT",
  Sweden: "SE", Norway: "NO", Denmark: "DK", Finland: "FI", Iceland: "IS", Poland: "PL",
  "Czech Republic": "CZ", Slovakia: "SK", Hungary: "HU", Romania: "RO", Bulgaria: "BG", Greece: "GR",
  Croatia: "HR", Slovenia: "SI", Serbia: "RS", "Bosnia and Herzegovina": "BA", Montenegro: "ME",
  "North Macedonia": "MK", Albania: "AL", Kosovo: "XK", Estonia: "EE", Latvia: "LV", Lithuania: "LT",
  Ukraine: "UA", Belarus: "BY", Moldova: "MD", Malta: "MT", Cyprus: "CY", Liechtenstein: "LI",
  Monaco: "MC", "San Marino": "SM", Andorra: "AD", Russia: "RU",
  Nigeria: "NG", Egypt: "EG", "South Africa": "ZA", Kenya: "KE", Morocco: "MA", Algeria: "DZ",
  Tunisia: "TN", Libya: "LY", Ethiopia: "ET", Ghana: "GH", Tanzania: "TZ", Uganda: "UG", Angola: "AO",
  Mozambique: "MZ", Cameroon: "CM", "Ivory Coast": "CI", Senegal: "SN", Zimbabwe: "ZW", Zambia: "ZM",
  Rwanda: "RW", Botswana: "BW", Namibia: "NA", Mali: "ML", Niger: "NE", Chad: "TD", Sudan: "SD",
  "South Sudan": "SS", Somalia: "SO", Madagascar: "MG", Malawi: "MW", "Burkina Faso": "BF", Benin: "BJ",
  Togo: "TG", "Sierra Leone": "SL", Liberia: "LR", Mauritius: "MU", Gabon: "GA", Congo: "CG",
  "Democratic Republic of the Congo": "CD", Guinea: "GN", Eritrea: "ER", Djibouti: "DJ", Lesotho: "LS",
  Eswatini: "SZ", Gambia: "GM", Burundi: "BI", "Central African Republic": "CF",
  "Saudi Arabia": "SA", "United Arab Emirates": "AE", Qatar: "QA", Kuwait: "KW", Bahrain: "BH",
  Oman: "OM", Yemen: "YE", Iraq: "IQ", Iran: "IR", Israel: "IL", Jordan: "JO", Lebanon: "LB",
  Syria: "SY", Palestine: "PS", Turkey: "TR",
  Indonesia: "ID", Malaysia: "MY", Singapore: "SG", Thailand: "TH", Vietnam: "VN", Philippines: "PH",
  Myanmar: "MM", Cambodia: "KH", Laos: "LA", Brunei: "BN", "Timor-Leste": "TL", India: "IN",
  Pakistan: "PK", Bangladesh: "BD", "Sri Lanka": "LK", Nepal: "NP", Bhutan: "BT", Maldives: "MV",
  Afghanistan: "AF", China: "CN", Japan: "JP", "South Korea": "KR", "North Korea": "KP", Taiwan: "TW",
  "Hong Kong": "HK", Mongolia: "MN", Macau: "MO", Kazakhstan: "KZ", Uzbekistan: "UZ",
  Turkmenistan: "TM", Kyrgyzstan: "KG", Tajikistan: "TJ", Australia: "AU", "New Zealand": "NZ",
  "Papua New Guinea": "PG", Fiji: "FJ",
};

// The reverse lookup - a card's location text carries a code, not a name;
// Phase 5 needs to go from a found code (e.g. "CH") back to the canonical
// country name to compare against targetUniverseConfig.countries.
export const COUNTRY_BY_ISO_CODE = Object.fromEntries(
  Object.entries(ISO_COUNTRY_CODES).map(([name, code]) => [code, name])
);

// "UK" is not actually the ISO 3166-1 code for the United Kingdom (that's
// "GB") but is overwhelmingly the more common real-world abbreviation in
// card text - worth also catching for free, kept as an explicit alias
// here rather than polluting ISO_COUNTRY_CODES (which stays a clean,
// authoritative ISO reference) with a non-standard entry.
const TEXT_MATCH_ALIASES = { UK: "United Kingdom" };

// Finds a standalone, word-bounded ISO code (or the UK alias above) in a
// card's raw location text (e.g. "Zurich, CH" or "London, UK") -
// deliberately anchored so a common short word (e.g. "IN" inside ordinary
// English text) isn't mistaken for a country code; requires the token to
// be surrounded by non-letter boundaries (start/end of string, comma,
// space, parenthesis), the same discipline containsWholeWord (storage.js)
// already applies elsewhere. Returns the canonical country name, or null
// if nothing is found - never a guess, the free tier of Phase 5's
// location check.
export function findIsoCountryCodeInText(text) {
  if (!text) return null;
  const upper = text.toUpperCase();
  const candidates = { ...COUNTRY_BY_ISO_CODE, ...TEXT_MATCH_ALIASES };
  for (const code of Object.keys(candidates)) {
    const pattern = new RegExp(`(?:^|[^A-Z])${code}(?:[^A-Z]|$)`);
    if (pattern.test(upper)) return candidates[code];
  }
  return null;
}
