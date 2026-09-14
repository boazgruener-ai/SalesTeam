// Industry name -> LinkedIn industryCompanyVertical numeric ID mapping,
// confirmed live only (PRD 6.20 Phase 0 item #1), never guessed - same
// discipline and same incremental-growth shape as geo-urn-map.js. LinkedIn's
// own Company Search "Industry" filter panel shows a small default/
// suggested subset (not the full ~200+ catalog) unless "+ Add an industry"
// is used to search further - every entry below was confirmed that way,
// reading the real industryCompanyVertical id off the resulting URL, not
// assumed from the filter panel's own displayed labels.
export const INDUSTRY_ID_MAP = {
  "Financial Services": "43",
  "Technology, Information and Internet": "6",
  "Consumer Services": "91",
  "Food and Beverages": "34",
  "Telecommunications": "8",
  "Hospitals and Health Care": "14",
  "Manufacturing": "25",
  "Pharmaceutical Manufacturing": "15",
  "Utilities": "59",
};

// The onboarding wizard's Industry step draws from this, not free text -
// see the file header above for why.
export const CONFIRMED_INDUSTRIES = Object.keys(INDUSTRY_ID_MAP).sort((a, b) => a.localeCompare(b));

export function industryIdForName(name) {
  return INDUSTRY_ID_MAP[name] || null;
}
