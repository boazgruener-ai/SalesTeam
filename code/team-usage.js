// Billing "Team usage" (BILLING_TEAM_USAGE_DESIGN.md 3): the monthly totals a member's browser shares with the
// Team Lead and the deputy. PURE - no chrome.*, no DOM - so test_pure_modules.py runs it for real.
//
// A member shares, per calendar month, the estimated cost in US$ and the number of web researches - nothing
// about days, features, tokens or accounts (R3.1, R3.2).

// The user's own calendar day (not UTC), as YYYY-MM-DD - the same key api-usage.js counts under.
export function usageDayKey(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

const roundUsd = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

// days: api-usage.js's { "YYYY-MM-DD": { webResearch: { calls, usd, ... }, other: { usd, ... } } }.
// Only the days from joinedDay on count (D5: nothing from before joining). -> { "YYYY-MM": { usd, researches } }
export function monthsFromDays(days, joinedDay = null) {
  const out = {};
  for (const [day, d] of Object.entries(days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (joinedDay && day < joinedDay)) continue;
    const month = day.slice(0, 7);
    const m = out[month] || (out[month] = { usd: 0, researches: 0 });
    m.usd += (d?.webResearch?.usd || 0) + (d?.other?.usd || 0);
    m.researches += d?.webResearch?.calls || 0;
  }
  for (const m of Object.values(out)) m.usd = roundUsd(m.usd);
  return out;
}

// D4: a month's shared figures are never lowered - the days older than 400 are dropped from the count, and the
// month they belonged to must not shrink with them.
export function mergeMonths(kept, fresh) {
  const out = {};
  for (const month of new Set([...Object.keys(kept || {}), ...Object.keys(fresh || {})])) {
    const a = kept?.[month] || {};
    const b = fresh?.[month] || {};
    out[month] = { usd: roundUsd(Math.max(a.usd || 0, b.usd || 0)), researches: Math.max(a.researches || 0, b.researches || 0) };
  }
  return out;
}

// One text per set of months, whatever order they were added in - "did anything change" without comparing objects
// (chrome.storage hands back a new object on every read).
export function monthsKey(months) {
  return Object.keys(months || {}).sort().map((m) => `${m}:${roundUsd(months[m].usd)}:${months[m].researches || 0}`).join("|");
}
