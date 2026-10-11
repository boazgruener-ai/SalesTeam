// Team advanced mode 1.2.3, step 0 (TEAM_ADVANCED_MODE_DESIGN.md 5.1): the country -> region table, moved out of
// storage.js so the pure group matching (team-groups.js) can use it. storage.js imports it back - still one copy.
// PURE - no chrome.*, no DOM.

// Continent groupings shown in Settings (6.7) - modeled on the standard
// Americas/EMEA/APAC sales-territory split, with each of those three broken
// down one level further (Americas -> North America + Latin America; EMEA ->
// Europe + Africa + Middle East; APAC stays whole as "South East Asia").
// Deliberately not exhaustive of every country/territory on Earth - South
// Asia, East Asia, Central Asia, and Oceania have no separate bucket of
// their own and are folded into "South East Asia" (i.e. APAC, confirmed)
// rather than adding a 7th "Other" bucket, so these 6 checkboxes fully
// partition the globe. A location that still matches none of them is simply
// left unclassified (classifyLocation returns null) rather than guessed at.
export const CONTINENT_COUNTRIES = {
  northAmerica: ["United States", "Canada"],
  latinAmerica: ["Mexico", "Guatemala", "Belize", "Honduras", "El Salvador", "Nicaragua", "Costa Rica", "Panama", "Cuba", "Dominican Republic", "Haiti", "Jamaica", "Trinidad and Tobago", "Bahamas", "Barbados", "Colombia", "Venezuela", "Ecuador", "Peru", "Brazil", "Bolivia", "Paraguay", "Chile", "Argentina", "Uruguay", "Guyana", "Suriname"],
  europe: ["United Kingdom", "Switzerland", "Germany", "France", "Italy", "Spain", "Portugal", "Netherlands", "Belgium", "Luxembourg", "Ireland", "Austria", "Sweden", "Norway", "Denmark", "Finland", "Iceland", "Poland", "Czech Republic", "Slovakia", "Hungary", "Romania", "Bulgaria", "Greece", "Croatia", "Slovenia", "Serbia", "Bosnia and Herzegovina", "Montenegro", "North Macedonia", "Albania", "Kosovo", "Estonia", "Latvia", "Lithuania", "Ukraine", "Belarus", "Moldova", "Malta", "Cyprus", "Liechtenstein", "Monaco", "San Marino", "Andorra", "Russia"],
  africa: ["Nigeria", "Egypt", "South Africa", "Kenya", "Morocco", "Algeria", "Tunisia", "Libya", "Ethiopia", "Ghana", "Tanzania", "Uganda", "Angola", "Mozambique", "Cameroon", "Ivory Coast", "Senegal", "Zimbabwe", "Zambia", "Rwanda", "Botswana", "Namibia", "Mali", "Niger", "Chad", "Sudan", "South Sudan", "Somalia", "Madagascar", "Malawi", "Burkina Faso", "Benin", "Togo", "Sierra Leone", "Liberia", "Mauritius", "Gabon", "Congo", "Democratic Republic of the Congo", "Guinea", "Eritrea", "Djibouti", "Lesotho", "Eswatini", "Gambia", "Burundi", "Central African Republic"],
  middleEast: ["Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Bahrain", "Oman", "Yemen", "Iraq", "Iran", "Israel", "Jordan", "Lebanon", "Syria", "Palestine", "Turkey"],
  southEastAsia: ["Indonesia", "Malaysia", "Singapore", "Thailand", "Vietnam", "Philippines", "Myanmar", "Cambodia", "Laos", "Brunei", "Timor-Leste", "India", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal", "Bhutan", "Maldives", "Afghanistan", "China", "Japan", "South Korea", "North Korea", "Taiwan", "Hong Kong", "Mongolia", "Macau", "Kazakhstan", "Uzbekistan", "Turkmenistan", "Kyrgyzstan", "Tajikistan", "Australia", "New Zealand", "Papua New Guinea", "Fiji"],
};

export const CONTINENT_LABELS = {
  northAmerica: "North America",
  latinAmerica: "Latin America",
  europe: "Europe (including UK and Switzerland)",
  africa: "Africa",
  middleEast: "Middle East",
  southEastAsia: "South East Asia",
};

// The region a country is in ("europe"), or null for an unknown or unlisted country - never a guess.
const REGION_BY_COUNTRY = new Map();
for (const [region, countries] of Object.entries(CONTINENT_COUNTRIES)) for (const c of countries) REGION_BY_COUNTRY.set(c.toLowerCase(), region);
export function regionOfCountry(country) {
  if (typeof country !== "string" || !country.trim()) return null;
  return REGION_BY_COUNTRY.get(country.trim().toLowerCase()) || null;
}
