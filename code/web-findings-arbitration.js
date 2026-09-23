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
import { WEB_FINDING_FIELDS } from "./web-research-apply.js";

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
  { value: "existing", label: "Current data" },
  { value: "web", label: "Web findings" },
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
  // One implausible number condemns the whole briefing for that account. His decision, against my
  // advice: see RULES below and the comment on discardWholeBriefing for the trade-off.
  rule8DiscardWholeBriefing: true,
  rule9TakeGlobalOverCopiedLocal: true,
  rule10PreferWebOverWeakEvidence: true,
  rule11KeepGroupHqOverLocalEntity: true,
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
  { id: 2, setting: "rule2IllogicalReview", kind: "review", label: "Throw away web findings that cannot be right, and ask when the current value looks wrong", detail: "A web finding that fails the checks below is discarded and the current value kept - there is nothing to decide. You are asked only when the questionable value is the current one, or when the field is empty so there is nothing to fall back on. Catches 0 employees at a company with revenue, a count that is not a number (\"6,500+\"), revenue in the wrong units, and a revenue-per-employee figure that cannot be real." },
  { id: 3, setting: "rule3NonScoringAuto", kind: "auto", label: "Decide fields that do not affect scoring automatically", detail: "Revenue, revenue currency, headquarters city, local employee count and the registry fields are never used to score or prioritise a company, so a disagreement there changes nothing." },
  { id: 4, setting: "rule4SameBucketAuto", kind: "auto", label: "Decide employee counts in the same size band automatically", detail: "84,146 or 150,000 - both are \"5001+\", so the choice has no effect." },
  { id: 5, setting: "rule5ToleranceAuto", kind: "auto", label: "Decide close employee counts automatically", detail: "Different size bands, but the two numbers are within the tolerance below of each other." },
  { id: 6, setting: "rule6BucketChangeReview", kind: "review", label: "Ask when an employee count changes the size band", detail: "A real change of size band is the one employee-count disagreement that can move a company's priority." },
  { id: 7, setting: "rule7LocationTierReview", kind: "review", label: "Ask when a headquarters country changes its priority", detail: "A different country only matters when it falls into a different location priority than the one you set up; when it does not, it is decided automatically." },
  { id: 9, setting: "rule9TakeGlobalOverCopiedLocal", kind: "auto", label: "Fill in a worldwide figure that is only a copy of the local one", detail: "When an account's worldwide employee count or revenue is identical to its local one, that field was never really filled in. If the research then matches the local figure exactly - so it is certainly describing the same company - and reports a genuinely bigger worldwide figure, that figure is taken. A company that only operates in one country reports the same number for both, so nothing is taken there." },
  { id: 10, setting: "rule10PreferWebOverWeakEvidence", kind: "auto", label: "Take the web finding when the current value is weakly sourced", detail: "The imported workbook records how good it believes each of its own figures to be. Where that record shows no real evidence behind the current value - no official reporting, no annual report, no named database - a question about it is not worth asking, and the web finding is taken instead. Where the current value does cite proper evidence, the disagreement is still put to you." },
  { id: 11, setting: "rule11KeepGroupHqOverLocalEntity", kind: "auto", label: "Decide the headquarters country from the account's Local / Global classification", detail: "The headquarters country means where the whole group is based. The research often reports the Swiss subsidiary's seat instead - Bayer (Schweiz) AG, Moderna Switzerland, Lidl Schweiz. When the account is classified Global, the country that is not Switzerland is kept or taken; when it is Local, Switzerland is. When the account has no classification, Switzerland found against another country on the account is treated as the subsidiary and the current country kept; the opposite case is still put to you." },
  { id: 8, setting: "rule8DiscardWholeBriefing", kind: "auto", label: "Throw away a whole research result when any part of it cannot be right", detail: "If one number in a company's research is impossible, nothing else it found is used either - the current values are kept throughout. A research run that gets one fact plainly wrong has not earned trust in the rest. Note that this can discard a finding that was perfectly good, so switch it off if you would rather judge each field on its own." },
];

// Fields the user is never asked about, whatever the rules conclude. A revenue currency is an
// internal unit marker: every figure is converted into the chosen display currency before it is
// shown or compared, so the stored code is an implementation detail and a question about it has no
// meaning for the person answering it. Reported directly: "Revenue currency - should NEVER be
// reviewed. It should simply always be USD, after currency conversion."
const NEVER_REVIEW_FIELDS = new Set(["revenueCurrency", "swissRevenueCurrency"]);

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
    // Kept INSIDE the employee guard. It used to sit outside it, so an account whose stored local
    // count exceeded its global one had every one of its findings marked "your current value looks
    // wrong" - revenue currency, HQ city, registry fields, all of it - and every one was escalated
    // to the user by rule 2. A contradiction about employee counts says nothing about a currency
    // code.
    if (globalNow !== null && swissNow !== null && swissNow > globalNow) {
      add("current", `the account already says ${formatNum(swissNow)} local employees against ${formatNum(globalNow)} worldwide`);
    }
  }

  // Revenue per employee, when both halves are known on the side being judged.
  //
  // On the FOUND side this deliberately reaches for the OTHER values from the SAME research run
  // where it has them, and only falls back to the account's own. The case that showed why: a
  // briefing reporting 2,600 employees AND 2,234 of revenue is incoherent on its own terms - under
  // 1 per employee per year - and saying so is far stronger than measuring its revenue against an
  // employee count that came from somewhere else entirely. It also catches BOTH halves, so the
  // whole implausible pair is thrown out rather than just the one field that happened to be
  // compared against good data.
  if (REVENUE_FIELDS.has(key) || EMPLOYEE_FIELDS.has(key)) {
    for (const { side, raw } of sides) {
      const n = asNumber(raw);
      if (n === null) continue;
      const otherRevenue = side === "found"
        ? (asNumber(ctx?.found?.globalRevenue) ?? asNumber(ctx?.effective?.globalRevenue))
        : asNumber(ctx?.effective?.globalRevenue);
      const otherEmployees = side === "found"
        ? (asNumber(ctx?.found?.globalEmployees) ?? globalNow)
        : globalNow;
      const revenue = REVENUE_FIELDS.has(key) ? n : otherRevenue;
      const employees = EMPLOYEE_FIELDS.has(key) ? n : otherEmployees;
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
function decideFinding(proposal, ctx, settings) {
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
        : { action: "dismiss", rule, why: `${why}; kept the current value because the web finding does not look right` };
    }
    return prefersWeb
      ? { action: "apply", rule, why: `${why}; the source preference is set to web findings` }
      : { action: "dismiss", rule, why: `${why}; the source preference is set to current data` };
  };

  const currentIsIllogical = problems.some((p) => p.side === "current");

  if (problems.length > 0 && s.rule2IllogicalReview) {
    // Asking about a value that is plainly junk wastes the one resource this whole mechanism exists
    // to protect. When ONLY the incoming value fails the checks and the account already holds a
    // sound one, there is nothing to decide: keep what is there. A human is needed only when the
    // questionable value is the one already stored, or when there is nothing to fall back on.
    if (!currentIsIllogical && !currentIsBlank) {
      return {
        action: "dismiss",
        rule: 2,
        foundImplausible: true,
        why: `kept the current value - the web finding is not plausible: ${problems.filter((p) => p.side === "found").map((p) => p.text).join("; ")}`,
      };
    }
    return { ...review(2, problems.map((p) => p.text).join("; ")), foundImplausible: foundIsIllogical };
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
        return auto(5, `the two counts differ by ${(diff * 100).toFixed(1)}%, within the ${s.tolerancePct}% tolerance set for this`);
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

export function arbitrateFinding(proposal, ctx, settings) {
  const s = { ...DEFAULT_ARBITRATION_SETTINGS, ...(settings || {}) };
  const decision = decideFinding(proposal, ctx, settings);
  // `foundImplausible` is marked HERE rather than inside rule 2's branch, and the difference is not
  // cosmetic: rules 8 and 9 both read it, so while it was set only when rule 2 was switched ON,
  // switching rule 2 off silently disabled rule 8 as well and removed the floor that stops rule 9
  // writing a rejected value. A found value is implausible or it is not; whether the user asked to
  // be consulted about it is a separate question.
  const foundImplausible = Boolean(decision.foundImplausible)
    || illogicalReasons(proposal, ctx, s.illogical).some((r) => r.side === "found");
  decision.foundImplausible = foundImplausible;
  if (decision.action === "review" && NEVER_REVIEW_FIELDS.has(proposal.key)) {
    return {
      ...decision,
      action: "dismiss",
      why: "the currency is never put to you - every figure is shown in the chosen currency whatever the stored code says",
    };
  }
  return decision;
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
    // Not "review": asking about a currency on its own is meaningless (see NEVER_REVIEW_FIELDS).
    // It is left alone until the amount it belongs to is settled - and if the user then takes the
    // found amount, the review dialog applies the found currency with it.
    return follow("dismiss", "the revenue figure it belongs to is still to be decided, so the currency is left as it is for now");
  }
  // The amount is staying (kept, or not in question at all), so the currency stays too.
  return currency.action === "apply"
    ? follow("dismiss", "the revenue figure it belongs to is not changing, so changing the currency alone would misstate it")
    : decisions;
}

// The worldwide/local field pairs. A stored worldwide figure that is byte-identical to the local
// one is not a measurement, it is a field that was never populated.
const GLOBAL_LOCAL_PAIRS = [
  { global: "globalEmployees", local: "swissEmployees", label: "employee count" },
  { global: "globalRevenue", local: "swissRevenue", label: "revenue" },
];

function materiallyDifferent(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) > 0.1;
}

// Rule 9, from his reading of a real account (Rhenus Alpina): stored worldwide employees 1,550 and
// stored local employees 1,550; stored worldwide revenue 454,000,000 and stored local revenue
// 454,000,000 - while the research reported 39,000 and 8,200,000,000 worldwide, AND matched both
// local figures EXACTLY. His inference: "the Employee (local) and the Revenue (local) that were web
// found are exactly matching those in the Current values", so the research is certainly describing
// the same company, and the stored worldwide fields are just copies of the local ones.
//
// This is the only rule that WRITES rather than keeps, so the three conditions are all required and
// each carries its weight:
//   1. stored global === stored local  -> the field is a duplicate, not a curated value
//   2. found local === stored local    -> corroboration: the same company, not a parent or a sibling
//   3. found global materially differs from found LOCAL -> the company really does have a wider
//      footprint. A purely domestic company reports the same figure for both, so this fails and
//      nothing is taken - which is what keeps a cantonal bank safe.
// Rule 8 runs after this one, so an implausible briefing still overrides it.
function takeGlobalWhenStoredIsACopyOfLocal(decisions, ctx, settings) {
  if (!settings.rule9TakeGlobalOverCopiedLocal) return decisions;
  return decisions.map((d) => {
    const pair = GLOBAL_LOCAL_PAIRS.find((x) => x.global === d.proposal.key);
    // foundImplausible is skipped, and this is the floor that matters: rule 9 is the only rule that
    // WRITES, so without this it could overrule rule 2 and put a value the checks had already
    // rejected straight into the account. Caught by the test that pairs a corroborated employee
    // count with an impossible revenue in the same briefing.
    if (!pair || d.action === "apply" || d.foundImplausible) return d;
    const storedGlobal = parseLooseNumber(ctx?.effective?.[pair.global]);
    const storedLocal = parseLooseNumber(ctx?.effective?.[pair.local]);
    const foundLocal = parseLooseNumber(ctx?.researched?.[pair.local]);
    const foundGlobal = parseLooseNumber(d.proposal.found);
    if (storedGlobal === null || storedLocal === null || foundLocal === null || foundGlobal === null) return d;
    if (storedGlobal !== storedLocal) return d;
    if (foundLocal !== storedLocal) return d;
    if (!materiallyDifferent(foundGlobal, foundLocal)) return d;
    return {
      ...d,
      action: "apply",
      rule: 9,
      why: `the current worldwide ${pair.label} was only a copy of the local one, and the web finding matched the local figure exactly while reporting a genuinely larger worldwide one`,
    };
  });
}

// What the imported workbook says about the quality of its OWN figures, per field. These columns
// exist in the research workbook (Global_Employees_Confidence and friends) and were never used for
// anything until now.
const STORED_CONFIDENCE_FIELDS = {
  globalEmployees: "globalEmployeesConfidence",
  swissEmployees: "swissEmployeesConfidence",
  globalRevenue: "globalRevenueConfidence",
  swissRevenue: "swissRevenueConfidence",
};

// Phrases that mean a real source stands behind the figure. Matching on the PRESENCE of evidence
// rather than the absence keeps an unrecognised wording on the safe side: anything this does not
// recognise is treated as well-evidenced and still goes to the user.
const STRONG_EVIDENCE_MARKERS = ["official", "annual report", "reported", "validated", "audited", "filing", "s&p"];

function storedEvidenceIsWeak(ctx, key) {
  const field = STORED_CONFIDENCE_FIELDS[key];
  if (!field) return false;
  const text = String(ctx?.effective?.[field] ?? "").trim().toLowerCase();
  if (!text) return false; // no record at all is not evidence of weakness - leave it to the user
  return !STRONG_EVIDENCE_MARKERS.some((m) => text.includes(m));
}

// Rule 10. In this workbook 148 of 277 stored employee counts carry the confidence "External source"
// with the period "Current ranking (verified 2026-09-05)" - a figure lifted from a list that ranks
// companies, not from anything that reports headcount. Medartis Holding is the case that showed it:
// a stored 747 with that provenance against a web finding of ~1,200 taken from the company's own
// website. Asking a human to adjudicate between a company's own statement and a ranking snapshot is
// not a real question.
//
// Deliberately narrow in two ways. It only ever converts a REVIEW into an apply - it never touches a
// decision the other rules already settled, so it removes questions without rewriting anything that
// was not going to be asked about anyway. And it fires only where the workbook itself records weak
// evidence; an unrecognised or missing confidence is treated as strong and still reaches the user.
function preferWebWhenStoredEvidenceIsWeak(decisions, ctx, settings) {
  if (!settings.rule10PreferWebOverWeakEvidence) return decisions;
  return decisions.map((d) => {
    if (d.action !== "review" || d.foundImplausible) return d;
    if (!storedEvidenceIsWeak(ctx, d.proposal.key)) return d;
    const recorded = ctx.effective[STORED_CONFIDENCE_FIELDS[d.proposal.key]];
    return {
      ...d,
      action: "apply",
      rule: 10,
      why: `the current value is recorded as "${recorded}", which is weaker evidence than the sources behind the web finding`,
    };
  });
}

// Rule 11. The web research is asked for "HQ country" and answers for the entity it actually read
// about, which for a company in this universe is very often the local "(Schweiz) AG" subsidiary. The
// imported globalHqCountry means the GROUP parent. Bayer (Schweiz) AG vs Germany, Moderna Switzerland
// GmbH vs United States, Lidl Schweiz AG vs Germany - three of the remaining reviews on 2026-09-23,
// and the briefing often does not even name the parent's country, which led him to pick Switzerland
// by mistake more than once.
//
// First choice, his suggestion: the account's own Local / Global classification. Where it says
// Global, the headquarters is by definition NOT the local country, so whichever side is not
// Switzerland is the answer; where it says Local, the side that IS Switzerland is. In the V66
// workbook that classification (Company_Type, or Target_Country_Relationship in schema 1.1) agrees
// with Global_HQ_Country on every one of the 541 rows, so it is trustworthy evidence rather than a
// guess. When both sides or neither side fit it, it proves nothing and the question stays.
//
// Fallback, when the classification is empty or unrecognised ("National tourism organization /
// public-law corporation"): decide on the pair of countries alone - Switzerland found against a
// foreign current country is overwhelmingly the subsidiary's seat. That direction only; Switzerland
// stored against a foreign finding could be a genuine error in the workbook, so it still reaches the
// user.
//
// Converts a review OR an apply, so a web-first source preference cannot write the subsidiary's
// country over the group's either. Only an apply of a value the classification supports is left
// alone - that one is already right.
const LOCAL_MARKET_COUNTRY_NAMES = new Set(["switzerland", "schweiz", "suisse", "svizzera", "ch", "che"]);

function isLocalMarketCountry(v) {
  return LOCAL_MARKET_COUNTRY_NAMES.has(String(v ?? "").trim().toLowerCase());
}

// "International company - Swiss subsidiary" is GLOBAL: the group is abroad, and that is exactly the
// case this rule exists for, so global is tested first.
function localOrGlobal(effective) {
  for (const raw of [effective?.targetCountryRelationship, effective?.companyType]) {
    const t = String(raw ?? "").toLowerCase();
    if (!t.trim()) continue;
    if (/\b(global|international|multinational|foreign)\b/.test(t)) return "global";
    if (/\b(local|swiss|schweizer|suisse)\b/.test(t)) return "local";
  }
  return null;
}

function keepGroupHqOverLocalEntity(decisions, ctx, settings) {
  if (!settings.rule11KeepGroupHqOverLocalEntity) return decisions;
  const type = localOrGlobal(ctx?.effective);
  return decisions.map((d) => {
    const p = d.proposal;
    if (p.key !== "globalHqCountry" || d.foundImplausible || isBlank(p.current) || isBlank(p.found)) return d;

    if (type) {
      const fits = (v) => isLocalMarketCountry(v) === (type === "local");
      const currentFits = fits(p.current);
      const foundFits = fits(p.found);
      if (currentFits === foundFits) return d;
      const label = type === "global" ? "a Global company, so its headquarters is outside Switzerland" : "a Local company, so its headquarters is in Switzerland";
      if (currentFits) {
        if (d.action === "dismiss") return d;
        return { ...d, action: "dismiss", rule: 11, why: `the account is classified as ${label}; kept ${showValue(p.current)}` };
      }
      return { ...d, action: "apply", rule: 11, why: `the account is classified as ${label}; took ${showValue(p.found)} from the research` };
    }

    if (d.action === "dismiss") return d;
    if (isLocalMarketCountry(p.current) || !isLocalMarketCountry(p.found)) return d;
    return {
      ...d,
      action: "dismiss",
      rule: 11,
      why: `the research found Switzerland, which is most likely the Swiss company's own seat rather than the group's; kept ${showValue(p.current)} as the group headquarters`,
    };
  });
}

// Rule 8, and the reasoning is the user's own: "If one or more of the Web finding fields is not
// logical, we should probably automatically discard the whole set of findings for that company."
// A research run that reports something impossible has not earned trust in the rest of what it
// says, and the safe action - keep what the account already has - costs nothing to reverse.
//
// The inference is about the SOURCE, not the field, and that is what makes it sound. In his words:
// "I do not know if Australia or Switzerland is the right location, based on the data shown. I only
// know that one or two of the web findings is not logical, so my assumption is that the Web source
// that was used was not reliable." A research run is a single act of evidence-gathering; showing it
// reported something impossible impeaches the run, and you do not get to keep the convenient parts
// of a witness you have just discredited.
//
// Note what is NOT being claimed: keeping the stored value is not an assertion that the stored value
// is right. It is declining to act on untrustworthy evidence, which is why this is the conservative
// action rather than a destructive one. Nothing is lost either - the briefing text and its sources
// stay on the account, and a LATER research run finding the same thing surfaces it again, because a
// dismissal records the turned-down VALUE rather than the field.
//
// The cost is still real and worth watching: CSL Vifor's HQ finding (Switzerland against a stored
// Australia) is a genuine entity ambiguity - CSL Limited is Australian, Vifor Pharma was Swiss
// before CSL acquired it - and it is discarded along with the junk. The rule is a setting for that
// reason, the Activity Log names rule 8 on every line it touches, and the whole pass has one-click
// undo. An account whose briefing was discarded this way is really a candidate for RE-RESEARCHING,
// not for review - worth building on in 1.2.0.
function discardWholeBriefingIfImplausible(decisions, settings) {
  if (!settings.rule8DiscardWholeBriefing) return decisions;
  if (!decisions.some((d) => d.foundImplausible)) return decisions;
  return decisions.map((d) => (d.foundImplausible || d.action === "dismiss" ? d : {
    ...d,
    action: "dismiss",
    rule: 8,
    why: "another finding in the same research result cannot be right, so nothing from it was taken",
  }));
}

export function arbitrateAccount({ proposals, extra, ctx, settings, data }) {
  // Every value this research run reported, so a finding can be judged against the rest of the same
  // briefing rather than only against the account (see illogicalReasons).
  const found = {};
  for (const p of proposals) found[p.key] = p.found;
  // `found` holds only the DISPUTED values. `researched` holds everything the run reported,
  // including the fields that matched and so never became a finding - which is precisely the
  // evidence rule 9 needs (a local figure agreeing exactly is not a finding, but it is proof).
  const researched = {};
  if (data) {
    for (const f of WEB_FINDING_FIELDS) {
      const v = f.from(data);
      if (v !== null && v !== undefined && v !== "") researched[f.key] = v;
    }
  }
  const ctxWithFound = { ...ctx, found, researched };

  let decisions = [];
  for (const p of proposals) {
    if (p.dismissed) continue;
    const d = arbitrateFinding(p, ctxWithFound, settings);
    decisions.push({ ...d, proposal: p });
  }
  const merged = { ...DEFAULT_ARBITRATION_SETTINGS, ...(settings || {}) };
  decisions = takeGlobalWhenStoredIsACopyOfLocal(decisions, ctxWithFound, merged);
  decisions = preferWebWhenStoredEvidenceIsWeak(decisions, ctxWithFound, merged);
  decisions = keepGroupHqOverLocalEntity(decisions, ctxWithFound, merged);
  // After rule 9, deliberately: a briefing with an impossible number in it overrides anything rule 9
  // concluded from the rest of the same briefing.
  decisions = discardWholeBriefingIfImplausible(decisions, merged);
  decisions = coupleCurrencyToAmount(decisions, ctxWithFound);
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
