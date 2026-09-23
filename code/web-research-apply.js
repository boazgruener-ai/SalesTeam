// What a web research can propose for an account, and how it is compared with what the account already has.
// Shared by the Target Accounts page and the background bulk research.
import { parseLooseNumber, normalizeMoney } from "./value-normalize.js";

// Revenue fields carry a currency in a SEPARATE field, so two figures can only be compared once
// both are expressed in the same one. Without this, a stored 113,530,000,000 USD and a found
// 91,350,000,000 CHF look like a disagreement when they are very nearly the same money.
//
// The workbook keeps TWO currency columns, and they belong to different amounts: Revenue_Currency
// goes with Global_Revenue, Swiss_Revenue_Currency with Swiss_Revenue (xlsx-lite.js maps the latter
// to `swissRevenueCurrency`). Normalising the local figure with the global currency happens to give
// the right answer on today's data - all 14 rows that carry both have them equal - but it is only
// luck, and a company reporting worldwide in USD and locally in CHF would be silently mis-converted.
//
// The web research reports only ONE currency (`revenueCurrency` in the agent's JSON), so the found
// side, and any row with no local currency of its own, fall back to it.
const MONEY_FIELDS = { globalRevenue: "revenueCurrency", swissRevenue: "swissRevenueCurrency" };

// Two figures in the SAME currency within 10% of each other are one fact reported slightly
// differently. Once a CONVERSION is involved the exchange rate is itself an estimate, and the
// comparison inherits that error. Measured across this dataset, the implied CHF->USD rate runs from
// 1.10 (MCH Group) to 1.35 (Luzerner Kantonalbank) depending on which year and which source each
// side used - an 11% spread that on its own exceeds the same-currency threshold. Judging a converted
// comparison as tightly as a same-currency one therefore manufactures disagreements that do not
// exist: MCH Group's 435,700,000 CHF against a stored 480,000,000 USD is the SAME MONEY at 1.102,
// and 11.9% apart at the table's 1.25.
const SAME_CURRENCY_TOLERANCE = 0.1;
const CROSS_CURRENCY_TOLERANCE = 0.25;
export const WEB_FINDING_FIELDS = [
  { key: "globalEmployees", label: "Employees (global)", from: (d) => d.employeesGlobal, numeric: true },
  { key: "swissEmployees", label: "Employees (local)", from: (d) => d.employeesLocal, numeric: true },
  { key: "globalRevenue", label: "Revenue (global)", from: (d) => d.revenueGlobal, numeric: true },
  { key: "swissRevenue", label: "Revenue (local)", from: (d) => d.revenueLocal, numeric: true },
  { key: "revenueCurrency", label: "Revenue currency", from: (d) => d.revenueCurrency },
  { key: "globalHqCity", label: "Global HQ city", from: (d) => d.hqCity },
  { key: "globalHqCountry", label: "Global HQ country", from: (d) => d.hqCountry },
  { key: "zefixOfficialName", label: "Registry official name", from: (d) => d.registryName },
  { key: "zefixUid", label: "Registry ID", from: (d) => d.registryId },
  { key: "zefixAddress", label: "Registry address", from: (d) => d.registryAddress },
];

export function isBlankFinding(v) {
  return v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v));
}

// [{key, label, found, current, state: "new" | "different"}] - values equal to (or within 10% of) what the account has are left out.
// `money` is optional: { targetCurrency, rates }. When it is passed, revenue figures are compared
// after being converted into the one target currency; without it they are compared as written,
// which is the old behaviour and still correct whenever both sides share a currency.
export function computeFindingProposals(company, overrides, data, money = null) {
  if (!data) return [];
  const effective = { ...(company || {}), ...(overrides || {}) };
  const out = [];
  for (const f of WEB_FINDING_FIELDS) {
    let found = f.from(data);
    if (isBlankFinding(found)) continue;
    // parseLooseNumber, not Number(): a found "102m" or ">5,000" is a perfectly good figure written
    // in a way Number() throws away entirely.
    if (f.numeric) { found = parseLooseNumber(found); if (found === null) continue; } else found = String(found).trim();
    const current = effective[f.key];
    if (isBlankFinding(current)) { out.push({ key: f.key, label: f.label, found, current: null, state: "new" }); continue; }
    if (f.numeric) {
      let a = parseLooseNumber(current);
      let b = found;
      let converted = false;
      const currencyKey = MONEY_FIELDS[f.key];
      if (currencyKey && money?.targetCurrency) {
        const mine = normalizeMoney(current, effective[currencyKey] || effective.revenueCurrency, money.targetCurrency, money.rates);
        const theirs = normalizeMoney(found, data[currencyKey] || data.revenueCurrency, money.targetCurrency, money.rates);
        if (mine.amount !== null && theirs.amount !== null) {
          a = mine.amount;
          b = theirs.amount;
          converted = mine.converted || theirs.converted;
        }
      }
      const tolerance = converted ? CROSS_CURRENCY_TOLERANCE : SAME_CURRENCY_TOLERANCE;
      if (a !== null && Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) <= tolerance) continue;
    } else if (String(current).trim().toLowerCase() === String(found).toLowerCase()) continue;
    out.push({ key: f.key, label: f.label, found, current, state: "different" });
  }
  return out;
}
