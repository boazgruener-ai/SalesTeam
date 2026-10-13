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

// ---- The Team usage table (design 5; R4) - what the Team Lead and the deputy see ----

const usagePersonKey = (name) => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
const usagePreviousMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

// members: [{ id, name, joined (ms), left (ms, or null while a member), months (or null), updated (ms), state }]
//   state "ok"     - months are this member's figures
//         "none"   - no usage file: their SalesTeam is older than 1.2.4 (R4.5)
//         "locked" - a file that was not sealed for this reader (design 4: a member who left before a hand-over)
// today: "YYYY-MM-DD".
// One line per PERSON (D3): members with the same name are added up. -> { rows, total }
export function usageTable(members, today) {
  const month = today.slice(0, 7);
  const last = usagePreviousMonth(month);
  const year = Number(today.slice(0, 4));
  const people = new Map();
  for (const m of members || []) {
    const key = usagePersonKey(m.name) || m.id;
    if (!people.has(key)) people.set(key, []);
    people.get(key).push(m);
  }
  const rows = [];
  for (const group of people.values()) {
    const left = group.every((m) => m.left) ? Math.max(...group.map((m) => m.left)) : null;
    const withFigures = group.filter((m) => m.state === "ok" && m.months);
    const state = withFigures.length ? "ok" : group.some((m) => m.state === "locked") ? "locked" : "none";
    // Q4: a member who left stays until the end of the following calendar year. One who left without ever
    // sharing a figure has nothing to keep.
    if (left && (new Date(left).getFullYear() + 1 < year || state === "none")) continue;
    const row = {
      // "(2 browsers)" counts the browsers still in the team - an earlier membership that has left is not one of them
      name: group[0].name || "A colleague", browsers: left ? group.length : group.filter((m) => !m.left).length, left, state,
      // the figures count from the day of joining (D5): the first browser's, when a person has two
      joined: Math.min(...group.map((m) => m.joined || Infinity)),
      thisMonth: 0, lastMonth: 0, since: 0, researches: 0, updated: 0,
    };
    if (!Number.isFinite(row.joined)) row.joined = 0;
    for (const m of withFigures) {
      row.thisMonth += m.months[month]?.usd || 0;
      row.lastMonth += m.months[last]?.usd || 0;
      row.researches += m.months[month]?.researches || 0;
      for (const v of Object.values(m.months)) row.since += v.usd || 0;
      row.updated = Math.max(row.updated, m.updated || 0);
    }
    for (const f of ["thisMonth", "lastMonth", "since"]) row[f] = roundUsd(row[f]);
    rows.push(row);
  }
  rows.sort((a, b) => b.thisMonth - a.thisMonth || a.name.localeCompare(b.name));
  const total = { thisMonth: 0, lastMonth: 0, since: 0, researches: 0 };
  for (const r of rows) if (r.state === "ok") for (const f of Object.keys(total)) total[f] += r[f];
  for (const f of ["thisMonth", "lastMonth", "since"]) total[f] = roundUsd(total[f]);
  return { rows, total };
}
