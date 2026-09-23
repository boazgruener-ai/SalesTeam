// Turning the messy numbers that arrive from research into one comparable form.
//
// Employee counts and revenue figures reach this extension from four places that each write them
// differently: the imported research workbook, Claude's web research, LinkedIn's size band, and the
// user's own typing. What actually turns up in the data:
//
//   "6,500+"        EPFL's employee count - stored as a STRING, so resolveSizeBucket refuses it and
//                   the account silently gets no size nudge at all when it is scored
//   ">5,000"        ADM Switzerland, same problem
//   "102bn"         a magnitude suffix instead of the digits
//   "CHF 102m"      the currency written into the amount field
//   "102'000"       the Swiss thousands separator
//   "USD"           a currency code sitting in a numeric field, with no number at all
//   115             Swissmedic - a real number, but meaning 115 MILLION (a units error this module
//                   deliberately does NOT try to guess at; rule 2 of the arbitration flags it)
//
// Everything here is PURE - no chrome, no DOM, no network. The exchange rates are a static, dated
// table the user can edit in Settings; this is deliberately basic and makes no attempt to fetch a
// live rate.

// Looked up as a whole word rather than matched with \b: there is NO word boundary between a digit
// and a letter, so /\bm\b/ never matches the "m" in "1.5m" - which is the single most common way
// these values are written.
const MAGNITUDE_SUFFIXES = {
  t: 1e12, tn: 1e12, trn: 1e12, trillion: 1e12, trillions: 1e12,
  b: 1e9, bn: 1e9, bln: 1e9, billion: 1e9, billions: 1e9, mrd: 1e9, milliard: 1e9, milliarden: 1e9,
  m: 1e6, mn: 1e6, mm: 1e6, mio: 1e6, mln: 1e6, million: 1e6, millions: 1e6, millionen: 1e6,
  k: 1e3, thousand: 1e3, thousands: 1e3, tsd: 1e3,
};

// Codes recognised when one is written into an amount ("CHF 102m") or stands alone in a numeric
// field. ISO codes only - a bare "$" is handled separately since it is ambiguous across countries.
export const CURRENCY_CODES = [
  "USD", "CHF", "EUR", "GBP", "JPY", "CNY", "SEK", "NOK", "DKK", "CAD", "AUD", "SGD", "HKD", "INR", "BRL", "ZAR", "PLN", "CZK",
];

const SYMBOL_CURRENCY = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₣": "CHF" };

// Rates are "how many units of the TARGET currency one unit of this currency buys", expressed
// against USD. Static and approximate on purpose: the point is to stop a CHF figure and a USD
// figure looking like a disagreement when they are the same money, not to be an FX service. The
// user can edit every one of these in Settings, and asOf is shown next to them so a stale table is
// visible rather than silently trusted.
export const DEFAULT_EXCHANGE_RATES = {
  asOf: "2026-09-22",
  base: "USD",
  rates: {
    USD: 1,
    CHF: 1.25,
    EUR: 1.17,
    GBP: 1.35,
    JPY: 0.0065,
    CNY: 0.14,
    SEK: 0.105,
    NOK: 0.1,
    DKK: 0.157,
    CAD: 0.73,
    AUD: 0.66,
    SGD: 0.78,
    HKD: 0.128,
    INR: 0.0115,
    BRL: 0.185,
    ZAR: 0.056,
    PLN: 0.275,
    CZK: 0.047,
  },
};

export const SUPPORTED_CURRENCIES = Object.keys(DEFAULT_EXCHANGE_RATES.rates);

// The currency a raw value carries in itself, if any: "CHF 102m" -> "CHF", "USD" -> "USD", 102 -> null.
export function extractCurrency(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  for (const [symbol, code] of Object.entries(SYMBOL_CURRENCY)) {
    if (text.includes(symbol)) return code;
  }
  const upper = text.toUpperCase();
  for (const code of CURRENCY_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(upper)) return code;
  }
  return null;
}

// The single most useful function here: every messy shape above -> a plain finite number, or null
// when there is genuinely no number in it ("USD", "not disclosed", "").
//
// What it deliberately does NOT do is guess at scale. "115" stays 115 even when the field almost
// certainly means 115 million - inventing six orders of magnitude is far worse than leaving the
// value alone for rule 2 of the arbitration to flag.
export function parseLooseNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;

  let text = raw.trim();
  if (!text) return null;

  // Strip currency symbols and codes, then the approximation marks that cluster around these
  // values: "~", "ca.", "approx.", ">", "<", "+", "about", "over", "more than".
  for (const symbol of Object.keys(SYMBOL_CURRENCY)) text = text.split(symbol).join(" ");
  text = text.replace(new RegExp(`\\b(${CURRENCY_CODES.join("|")})\\b`, "gi"), " ");
  text = text.replace(/\b(approx|approximately|circa|ca|about|around|over|under|more than|less than|est|estimated|employees|staff|fte)\b\.?/gi, " ");
  text = text.replace(/[~>=<+*]/g, " ").trim();
  if (!text) return null;

  // A magnitude suffix at the end, before the separators are stripped ("102 bn", "1.5m", "102M").
  let factor = 1;
  const suffix = text.match(/([a-zA-Z]+)\.?$/);
  if (suffix) {
    const found = MAGNITUDE_SUFFIXES[suffix[1].toLowerCase()];
    if (found) {
      factor = found;
      text = text.slice(0, suffix.index).trim();
    }
  }

  // Separators. Apostrophes are the Swiss thousands mark ("102'000"); spaces are used the same way.
  text = text.replace(/['’ \s]/g, "");
  // A comma is a thousands separator in this data ("6,500"), never a decimal point - but a lone
  // comma followed by exactly two digits at the end is a decimal in the European style ("1,5m").
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, "");
  else if (/^-?\d+,\d{1,2}$/.test(text)) text = text.replace(",", ".");
  else text = text.replace(/,/g, "");

  // Anything left that is not a plain number means this was prose, not a figure.
  if (!/^-?\d*\.?\d+$/.test(text)) return null;
  const n = Number(text) * factor;
  return Number.isFinite(n) ? n : null;
}

// True when the raw value holds something, but nothing numeric can be got out of it - the case that
// deserves a human ("not disclosed", a stray currency code). A blank is not a problem, just empty.
export function isUnparseableNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return false;
  return parseLooseNumber(raw) === null;
}

function rateFor(code, rates) {
  const table = rates?.rates || DEFAULT_EXCHANGE_RATES.rates;
  const value = table[String(code || "").toUpperCase()];
  return typeof value === "number" && value > 0 ? value : null;
}

// Amount in `from` -> amount in `to`, via the USD-based table. Returns null when either currency is
// unknown, so a caller can fall back to comparing the raw figures rather than inventing a number.
export function convertCurrency(amount, from, to, rates) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  const f = String(from || "").toUpperCase();
  const t = String(to || "").toUpperCase();
  if (!f || !t) return null;
  if (f === t) return amount;
  const fromRate = rateFor(f, rates);
  const toRate = rateFor(t, rates);
  if (fromRate === null || toRate === null) return null;
  return (amount * fromRate) / toRate;
}

// One money value, cleaned and converted: { amount, currency, converted }.
// `converted` says whether an exchange rate was actually applied, so the caller can be honest about
// it in the UI instead of presenting a converted figure as if it were reported.
export function normalizeMoney(rawAmount, rawCurrency, target, rates) {
  const amount = parseLooseNumber(rawAmount);
  if (amount === null) return { amount: null, currency: null, converted: false };
  const currency = (extractCurrency(rawAmount) || rawCurrency || "").toString().toUpperCase() || null;
  const to = String(target || DEFAULT_EXCHANGE_RATES.base).toUpperCase();
  if (!currency || currency === to) return { amount, currency: currency || to, converted: false };
  const converted = convertCurrency(amount, currency, to, rates);
  if (converted === null) return { amount, currency, converted: false };
  return { amount: converted, currency: to, converted: true };
}
