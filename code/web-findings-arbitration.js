// Deciding, without asking the user, what to do with a web-research finding that disagrees with
// what an account already holds.
//
// Why this exists: after researching the whole account universe, 257 of 541 accounts had at least
// one finding that "differed". Reviewing those by hand is hours of work and most of it is wasted,
// because the disagreements are overwhelmingly DEFINITIONAL rather than errors. The case that
// proved it: Glencore, stored 84,146 vs found 150,000 - both figures are correct (direct employees
// vs employees-and-contractors from the company's own reporting) and both land in the SAME size
// bucket (XXL), so the choice changes precisely nothing downstream.
//
// What "changes something downstream" means concretely: computeCompanyDeterministicPreScore
// (storage.js) reads only the employee count (through resolveSizeBucket) and globalHqCountry
// (through resolveLocationPriority). Revenue, revenue currency, HQ city, the local employee count
// and every registry field never enter any score. That single fact is what lets most of the 257 be
// settled mechanically.
//
import { parseLooseNumber } from "./value-normalize.js";

// This module is PURE - no chrome APIs, no storage, no DOM. The size-bucket table and the location
// priority lookup are passed IN (from storage.js's own SIZE_PRIORITY_BUCKETS and
// resolveLocationPriority) rather than duplicated here, so the two can never drift apart.

// The only two fields any score actually reads. Everything else is rule 3's "does not affect
// scoring" - which includes swissEmployees, even though the spec's shorthand listed only revenue,
// currency, city and the registry fields: the RULE is "does not affect scoring", and the local
// employee count genuinely does not.
export const SCORING_FIELDS = new Set(["globalEmployees", "globalHqCountry"]);

const EMPLOYEE_FIELDS = new Set(["globalEmployees", "swissEmployees"]);
const REVENUE_FIELDS = new Set(["globalRevenue", "swissRevenue"]);

export const SOURCE_PREFERENCES = [
  { value: "existing", label: "Existing/imported data" },
  { value: "web", label: "New web research" },
];

// All seven rules on, tolerance 15%, and keep-what-you-have on a tie. Keep-existing is the
// conservative default because the imported dataset is curated and internally consistent across
// 541 rows; it is a SETTING rather than a constant because another user's imported data may be
// worth a lot less than a fresh search.
export const DEFAULT_ARBITRATION_SETTINGS = {
  rule1EmptyApply: true,
  rule2IllogicalReview: true,
  rule3NonScoringAuto: true,
  rule4SameBucketAuto: true,
  rule5ToleranceAuto: true,
  rule6BucketChangeReview: true,
  rule7LocationTierReview: true,
  tolerancePct: 15,
  sourcePreference: "existing",
  // A LinkedIn-fetched count (employeeCountText set) is the company's own self-declared size band:
  // reliable for BUCKETING even though it is not an exact headcount. When this is on, a bucket
  // disagreement against a LinkedIn-sourced current value is settled in favour of LinkedIn instead
  // of being handed to the user.
  linkedinAuthoritative: true,
  illogical: {
    maxEmployees: 2500000,
    revenueUnitsFloor: 1000,
    revenueUnitsCeil: 1000000,
    revPerEmployeeMin: 1000,
    revPerEmployeeMax: 10000000,
  },
};

export const RULES = [
  { id: 1, setting: "rule1EmptyApply", kind: "auto", label: "Fill empty fields automatically", detail: "When the account has nothing in that field, use what the research found." },
  { id: 2, setting: "rule2IllogicalReview", kind: "review", label: "Always ask when a value looks wrong", detail: "0 employees at a company with revenue, an employee count that is not a number (\"6,500+\"), revenue that looks like it is in the wrong units, and the other impossible values listed below." },
  { id: 3, setting: "rule3NonScoringAuto", kind: "auto", label: "Decide fields that do not affect scoring automatically", detail: "Revenue, revenue currency, headquarters city, local employee count and the registry fields are never used to score or prioritise a company, so a disagreement there changes nothing." },
  { id: 4, setting: "rule4SameBucketAuto", kind: "auto", label: "Decide employee counts in the same size band automatically", detail: "84,146 or 150,000 - both are \"5001+\", so the choice has no effect." },
  { id: 5, setting: "rule5ToleranceAuto", kind: "auto", label: "Decide close employee counts automatically", detail: "Different size bands, but the two numbers are within the tolerance below of each other." },
  { id: 6, setting: "rule6BucketChangeReview", kind: "review", label: "Ask when an employee count changes the size band", detail: "A real change of size band is the one employee-count disagreement that can move a company's priority." },
  { id: 7, setting: "rule7LocationTierReview", kind: "review", label: "Ask when a headquarters country changes its priority", detail: "A different country only matters when it falls into a different location priority than the one you set up; when it does not, it is decided automatically." },
];

function isBlank(v) {
  return v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v));
}

// Everything numeric goes through value-normalize.js, so "6,500+" (EPFL), ">5,000" (ADM) and
// "102m" are understood as the numbers they plainly are rather than being treated as junk. Only a
// value with no number in it at all - "USD", "not disclosed" - still comes back null, and that is
// the case that genuinely deserves a human.
function asNumber(v) {
  return parseLooseNumber(v);
}

export function sizeBucketKey(value, buckets) {
  const n = asNumber(value);
  if (n === null) return null;
  const b = (buckets || []).find((x) => n >= x.min && n <= x.max);
  return b ? b.key : null;
}

// Every reason this specific value cannot be trusted, on either side of the comparison. Checked on
// BOTH the found and the current value: an illogical value is never auto-applied, and an illogical
// existing value is never silently auto-kept either.
// ctx carries the account's other effective values, because several of these are cross-field.
export function illogicalReasons(proposal, ctx, limits) {
  const lim = { ...DEFAULT_ARBITRATION_SETTINGS.illogical, ...(limits || {}) };
  const out = [];
  const add = (side, text) => out.push({ side, text });
  const key = proposal.key;
  const sides = [
    { side: "found", raw: proposal.found },
    { side: "current", raw: proposal.current },
  ].filter((s) => !isBlank(s.raw));

  for (const { side, raw } of sides) {
    const n = asNumber(raw);
    if (EMPLOYEE_FIELDS.has(key) || REVENUE_FIELDS.has(key)) {
      if (n === null) {
        add(side, `the ${side === "found" ? "found" : "stored"} value "${raw}" has no number in it at all`);
        continue;
      }
      if (n < 0) add(side, `the ${side === "found" ? "found" : "stored"} value is negative`);
    }
    if (EMPLOYEE_FIELDS.has(key) && n !== null) {
      if (n > lim.maxEmployees) add(side, `${formatNum(n)} employees is larger than any real employer`);
      if (n === 0 && (ctx?.hasRevenue || (ctx?.contactCount || 0) > 0)) {
        add(side, "0 employees, on a company that has revenue or known contacts");
      }
    }
  }

  // A units error shows up as one side being three orders of magnitude off the other - Swissmedic
  // is stored as `115`, meaning ~115 million CHF. Neither value is wrong on its own; only the pair
  // reveals it.
  if (REVENUE_FIELDS.has(key)) {
    const f = asNumber(proposal.found);
    const c = asNumber(proposal.current);
    if (f !== null && c !== null) {
      const lo = Math.min(f, c), hi = Math.max(f, c);
      if (lo > 0 && lo < lim.revenueUnitsFloor && hi >= lim.revenueUnitsCeil) {
        add(lo === c ? "current" : "found", `${formatNum(lo)} against ${formatNum(hi)} looks like a units mistake (millions written as units)`);
      }
    }
  }

  // swissEmployees must never exceed globalEmployees. Checked against what the account would hold
  // if this finding were applied, not only against what it holds now.
  const globalNow = asNumber(ctx?.effective?.globalEmployees);
  const swissNow = asNumber(ctx?.effective?.swissEmployees);
  if (key === "globalEmployees" || key === "swissEmployees") {
    const foundN = asNumber(proposal.found);
    const g = key === "globalEmployees" ? foundN : globalNow;
    const s = key === "swissEmployees" ? foundN : swissNow;
    if (g !== null && s !== null && s > g) {
      add("found", `it would leave ${formatNum(s)} local employees at a company with ${formatNum(g)} worldwide`);
    }
  }
  if (globalNow !== null && swissNow !== null && swissNow > globalNow) {
    add("current", `the account already says ${formatNum(swissNow)} local employees against ${formatNum(globalNow)} worldwide`);
  }

  // Revenue per employee, when both halves are known on the side being judged.
  if (REVENUE_FIELDS.has(key) || EMPLOYEE_FIELDS.has(key)) {
    for (const { side, raw } of sides) {
      const n = asNumber(raw);
      if (n === null) continue;
      const revenue = REVENUE_FIELDS.has(key) ? n : asNumber(ctx?.effective?.globalRevenue);
      const employees = EMPLOYEE_FIELDS.has(key) ? n : globalNow;
      if (revenue === null || employees === null || employees <= 0 || revenue <= 0) continue;
      const rpe = revenue / employees;
      if (rpe < lim.revPerEmployeeMin || rpe > lim.revPerEmployeeMax) {
        add(side, `it implies ${formatNum(Math.round(rpe))} of revenue per employee`);
      }
    }
  }

  return out;
}

function formatNum(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : String(n);
}

function showValue(v) {
  if (isBlank(v)) return "(empty)";
  return typeof v === "number" ? formatNum(v) : String(v);
}

// One finding in, one decision out.
//
//   { action: "apply" | "dismiss" | "review", rule, why }
//
// "apply" writes the found value into overrides; "dismiss" records the found value as turned down
// (the existing "Keep mine" marker) so the Web Findings column stops counting it; "review" leaves
// it exactly as it is, for the user.
//
// The rules are evaluated in the order the spec numbers them, with one exception: the illogical
// guard runs before rule 1, because rule 1 itself is written "apply, unless it is illogical".
//
// UNTICKING A RULE ALWAYS MOVES IN THE SAFE DIRECTION. For the four auto rules that means the case
// stops being decided and goes to the user. For the three "always ask" rules it means the guard no
// longer forces a review and the finding continues through the remaining rules - but an illogical
// FOUND value is still never written in, so the worst a fall-through can do is keep what the
// account already has.
export function arbitrateFinding(proposal, ctx, settings) {
  const s = { ...DEFAULT_ARBITRATION_SETTINGS, ...(settings || {}) };
  const prefersWeb = s.sourcePreference === "web";
  const currentIsBlank = proposal.state === "new" || isBlank(proposal.current);

  const problems = illogicalReasons(proposal, ctx, s.illogical);
  const foundIsIllogical = problems.some((p) => p.side === "found");

  const review = (rule, why) => ({ action: "review", rule, why });
  // The one floor that holds whatever the settings say: a value that does not look right is never
  // written into the account. When there is nothing to fall back on (the field is empty), that
  // leaves only the user.
  const auto = (rule, why) => {
    if (foundIsIllogical) {
      return currentIsBlank
        ? review(rule, `${why}, but the found value does not look right`)
        : { action: "dismiss", rule, why: `${why}; kept your own value because the found one does not look right` };
    }
    return prefersWeb
      ? { action: "apply", rule, why: `${why}; you chose to prefer new web research` }
      : { action: "dismiss", rule, why: `${why}; you chose to keep existing data` };
  };

  if (problems.length > 0 && s.rule2IllogicalReview) {
    return review(2, problems.map((p) => p.text).join("; "));
  }

  if (currentIsBlank) {
    if (!s.rule1EmptyApply) return review(1, "the field is empty, and filling empty fields automatically is switched off");
    if (foundIsIllogical) return review(1, `the field is empty, but ${problems.find((p) => p.side === "found").text}`);
    return { action: "apply", rule: 1, why: "the account had nothing in this field" };
  }

  if (!SCORING_FIELDS.has(proposal.key)) {
    if (!s.rule3NonScoringAuto) return review(3, "this field is not used for scoring, and deciding those automatically is switched off");
    return auto(3, "this field is never used to score or prioritise a company");
  }

  if (proposal.key === "globalEmployees") {
    const buckets = ctx?.buckets || [];
    const foundBucket = sizeBucketKey(proposal.found, buckets);
    const currentBucket = sizeBucketKey(proposal.current, buckets);
    const bucketLabel = (k) => (buckets.find((b) => b.key === k)?.label) || k;

    if (foundBucket && currentBucket && foundBucket === currentBucket) {
      if (!s.rule4SameBucketAuto) return review(4, "both counts are in the same size band, and deciding those automatically is switched off");
      return auto(4, `${showValue(proposal.current)} and ${showValue(proposal.found)} are both "${bucketLabel(currentBucket)}", so the choice changes no score`);
    }

    const f = asNumber(proposal.found);
    const c = asNumber(proposal.current);
    if (f !== null && c !== null) {
      const diff = Math.abs(f - c) / Math.max(Math.abs(f), Math.abs(c), 1);
      if (diff <= (Number(s.tolerancePct) || 0) / 100) {
        if (!s.rule5ToleranceAuto) return review(5, "the two counts are close, and deciding those automatically is switched off");
        return auto(5, `the two counts differ by ${(diff * 100).toFixed(1)}%, within your ${s.tolerancePct}% tolerance`);
      }
    }

    if (s.linkedinAuthoritative && ctx?.employeesFromLinkedin) {
      return { action: "dismiss", rule: 6, why: `the stored count is the size band ${showValue(proposal.current)} published by the company itself on LinkedIn, which you set as authoritative` };
    }
    if (!s.rule6BucketChangeReview) {
      return auto(6, `the counts fall in different size bands ("${bucketLabel(currentBucket)}" against "${bucketLabel(foundBucket)}"), and asking about that is switched off`);
    }
    return review(6, `${showValue(proposal.current)} and ${showValue(proposal.found)} fall in different size bands ("${bucketLabel(currentBucket) || "unknown"}" against "${bucketLabel(foundBucket) || "unknown"}"), which can change this company's priority`);
  }

  // globalHqCountry - the only other field a score reads.
  const tierOf = ctx?.locationTier || (() => null);
  const currentTier = tierOf(proposal.current);
  const foundTier = tierOf(proposal.found);
  if (currentTier === foundTier) {
    return auto(7, `both countries fall in the same location priority, so the choice changes no score`);
  }
  if (!s.rule7LocationTierReview) {
    return auto(7, "the country change moves the location priority, and asking about that is switched off");
  }
  return review(7, `moving from ${showValue(proposal.current)} to ${showValue(proposal.found)} changes this company's location priority`);
}

// Every undismissed finding on one account, decided. Returns the decisions plus the single extras
// patch that carries them out - built here rather than in storage so the nested `overrides` map is
// merged, never replaced (a blind overwrite would throw away everything a web research autofilled).
// Clearing an override means OMITTING the key, never setting it to null.
// A revenue amount and its currency are ONE fact written in two fields, and the rules above judge
// every field on its own - so without this they can be settled in opposite directions and quietly
// corrupt the pair. The real case that exposed it: this workbook was normalised to USD throughout
// ("Nestle 113,530,000,000 USD"), while the web research reports the currency these companies
// actually publish in, CHF. Take the found CHF while keeping the stored USD-denominated number and
// the account reads 113.53bn CHF - wrong by about a quarter, with nothing anywhere to show it.
//
// The rule is simply: THE CURRENCY FOLLOWS THE AMOUNT. If the revenue figure is being replaced, the
// currency is replaced with it; if the figure stays, so does the currency. A currency is never
// applied on its own. When the amount went to human review the currency goes there too, so the pair
// is always looked at together.
// `revenueCurrency` is the GLOBAL revenue's currency specifically - the workbook pairs
// Revenue_Currency with Global_Revenue and keeps Swiss_Revenue_Currency for the local figure. So it
// follows globalRevenue and nothing else: letting it trail a change to the LOCAL amount would
// rewrite the worldwide figure's currency on the strength of an unrelated finding.
const CURRENCY_PARTNER_KEY = "globalRevenue";

function coupleCurrencyToAmount(decisions, ctx) {
  const currency = decisions.find((d) => d.proposal.key === "revenueCurrency");
  if (!currency) return decisions;
  const amount = decisions.find((d) => d.proposal.key === CURRENCY_PARTNER_KEY);
  const stored = ctx?.effective?.[CURRENCY_PARTNER_KEY];
  const hasStoredAmount = stored !== null && stored !== undefined && stored !== "";
  // Nothing to be inconsistent with: no amount stored and none being proposed.
  if (!amount && !hasStoredAmount) return decisions;

  const follow = (action, why) => decisions.map((d) => (d === currency ? { ...d, action, why } : d));
  if (amount && amount.action === "apply") {
    return currency.action === "apply"
      ? decisions
      : follow("apply", "the revenue figure is being replaced, and the currency has to move with it");
  }
  if (amount && amount.action === "review") {
    return follow("review", "the revenue figure it belongs to is waiting for your decision, and the two have to agree");
  }
  // The amount is staying (kept, or not in question at all), so the currency stays too.
  return currency.action === "apply"
    ? follow("dismiss", "the revenue figure it belongs to is not changing, so changing the currency alone would misstate it")
    : decisions;
}

export function arbitrateAccount({ proposals, extra, ctx, settings }) {
  let decisions = [];
  for (const p of proposals) {
    if (p.dismissed) continue;
    const d = arbitrateFinding(p, ctx, settings);
    decisions.push({ ...d, proposal: p });
  }
  decisions = coupleCurrencyToAmount(decisions, ctx);
  const applied = decisions.filter((d) => d.action === "apply");
  const dismissed = decisions.filter((d) => d.action === "dismiss");
  if (applied.length === 0 && dismissed.length === 0) return { decisions, patch: null };

  const overrides = { ...(extra?.overrides || {}) };
  const marks = { ...(extra?.webFindingsDismissed || {}) };
  for (const d of applied) {
    overrides[d.proposal.key] = d.proposal.found;
    delete marks[d.proposal.key];
  }
  for (const d of dismissed) marks[d.proposal.key] = d.proposal.found;

  const patch = {};
  if (applied.length > 0) patch.overrides = overrides;
  patch.webFindingsDismissed = marks;
  return { decisions, patch };
}

export function summarize(perAccount) {
  const counts = { accounts: 0, applied: 0, dismissed: 0, review: 0, byRule: {} };
  for (const { decisions } of perAccount) {
    let touched = false;
    for (const d of decisions) {
      if (d.action === "apply") { counts.applied++; touched = true; }
      else if (d.action === "dismiss") { counts.dismissed++; touched = true; }
      else counts.review++;
      const bucket = counts.byRule[d.rule] || (counts.byRule[d.rule] = { apply: 0, dismiss: 0, review: 0 });
      bucket[d.action]++;
    }
    if (touched) counts.accounts++;
  }
  return counts;
}
