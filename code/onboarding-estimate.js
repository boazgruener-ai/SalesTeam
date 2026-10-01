// Cost and time of building the account list (1.2.1, ONBOARDING_RESEARCH_DESIGN.md section 9, R8). Pure: the wizard's
// "How big should your list be?" step shows it live, and Finish pre-fills the web budget from it (R8.2).
//
// The defaults are the measurements of build steps 2-4, not the design's first guesses: Web Discovery about US$0.02
// per account added (1.2.0.8), a web lane research about US$0.10-0.22 per account (1.2.0.7 / 1.2.0.13), about 25 s
// each with four workers. Once 20 accounts have gone through a lane on this install, its measured average is used
// instead (R8.3).

export const ESTIMATE_DEFAULTS = {
  discoveryUsdPerAccount: 0.02,
  researchUsdPerAccount: [0.12, 0.22],
  researchSecondsPerAccount: 25,
  webWorkers: 4,
  // Company page ~1.1, profile 1 (a third already found on the web), People page ~0.5 (design 9, D10).
  linkedinTouchesPerAccount: 2.6,
  linkedinTouchesPerDay: 60,
};
export const MEASURED_MIN_ACCOUNTS = 20;

// `accounts`: the target; `existing`: live accounts already in the list; `ready`: of those, Ready ones. `measured`:
// { discovery: { accounts, usd }, lane: { accounts, usd, seconds } } as kept by the lanes. Returns the numbers and
// the sentence the Targets step shows.
export function onboardingEstimate({ accounts, existing = 0, ready = 0, measured = null } = {}) {
  const d = ESTIMATE_DEFAULTS;
  const target = Math.max(0, Math.round(Number(accounts) || 0));
  const have = Math.max(0, Math.round(Number(existing) || 0));
  const toDiscover = Math.max(0, target - have);
  const readyNow = Math.max(0, Math.round(Number(ready) || 0));
  const toBuild = Math.max(0, target - Math.min(target, readyNow));

  const m = measured || {};
  const disc = m.discovery && m.discovery.accounts >= MEASURED_MIN_ACCOUNTS ? m.discovery.usd / m.discovery.accounts : d.discoveryUsdPerAccount;
  const laneMeasured = m.lane && m.lane.accounts >= MEASURED_MIN_ACCOUNTS;
  const per = laneMeasured ? [m.lane.usd / m.lane.accounts, m.lane.usd / m.lane.accounts] : d.researchUsdPerAccount;
  const secs = laneMeasured && m.lane.seconds > 0 ? m.lane.seconds / m.lane.accounts : d.researchSecondsPerAccount;

  const usdLow = toDiscover * disc + toBuild * per[0];
  const usdHigh = toDiscover * disc + toBuild * per[1];
  const webMinutes = Math.ceil((toBuild * secs) / d.webWorkers / 60);
  const touches = Math.round(toBuild * d.linkedinTouchesPerAccount);
  const days = touches / d.linkedinTouchesPerDay;
  return {
    accounts: target, toDiscover, toBuild, usdLow, usdHigh, webMinutes, touches, days,
    measured: { discovery: disc !== d.discoveryUsdPerAccount, lane: Boolean(laneMeasured) },
    budgetUsd: suggestedBudget(usdHigh),
    text: estimateText({ target, toDiscover, toBuild, usdLow, usdHigh, webMinutes, days, ready: readyNow }),
  };
}

// R8.2: the web budget pre-filled from the estimate, rounded up to whole US$5 (at least US$5).
export function suggestedBudget(usdHigh) {
  return Math.max(5, Math.ceil((Number(usdHigh) || 0) / 5) * 5);
}

function usdText(lo, hi) {
  const r = (n) => (n < 10 ? Math.round(n * 2) / 2 : Math.round(n));
  const a = r(lo);
  const b = r(hi);
  return a === b ? `about US$${a}` : `about US$${a}-${b}`;
}

function daysText(days) {
  if (days <= 0) return null;
  if (days < 1) return "under a day";
  const lo = Math.max(1, Math.floor(days));
  const hi = Math.ceil(days);
  return lo === hi ? `about ${lo} day${lo === 1 ? "" : "s"}` : `about ${lo}-${hi} days`;
}

function minutesText(min) {
  if (min <= 60) return "within the hour";
  const h = Math.ceil(min / 60);
  return `within about ${h} hours`;
}

export function estimateText({ target, toDiscover, toBuild, usdLow, usdHigh, webMinutes, days, ready = target }) {
  if (toBuild === 0 && toDiscover === 0) return `${target} accounts: your list already has ${ready} Ready accounts - nothing more to build.`;
  const parts = [];
  const li = daysText(days);
  parts.push(`${target} accounts: ${li ? `${li} of your daily LinkedIn limit and ` : ""}${usdText(usdLow, usdHigh)} on your Anthropic API key.`);
  if (toDiscover > 0) parts.push(`SalesTeam finds ${toDiscover} new account${toDiscover === 1 ? "" : "s"} on the web.`);
  parts.push(`Your accounts will be usable ${minutesText(webMinutes)}; the first Ready ones within the day.`);
  return parts.join(" ");
}
