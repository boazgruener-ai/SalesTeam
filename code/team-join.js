// Team use 1.2.2, build step 6 (TEAM_USE_DESIGN.md 9.2 step 4, R6.7): what a joining member has that the team does
// not, and what both have that the member has already worked on. PURE - no chrome.*, no DOM - so
// test_pure_modules.py runs it for real.
//
// Joining replaces the member's shared data with the team's (team-sync.js joinTeam). Before that:
//   - accounts only the member has are listed; the member ticks which to bring in. Those come back AFTER the replace
//     as the member's own changes (addBackValues) - the sync layer then sends them out like any other edit;
//   - accounts both have, where the member has worked (leads contacted, a follow-up date, a Sales Mentor
//     conversation), become JOIN PROPOSALS: the Team Admin decides in Decisions who keeps each one. The member's
//     contacted leads for those accounts come back too, so the team knows who was approached (no second approach).
// Accounts are matched like everywhere else: the normalised company name, else the LinkedIn company id.

export const WORKED_LEAD_STATUSES = ["Contacted", "Responded", "Converted"];
export const JOIN_PROPOSALS_KEY = "teamJoinProposals";
// An account's or contact's status set by hand (targetAccountExtras / targetContactExtras manualStatus): Contacted and
// Responded are outreach too (live test 1.2.1.11: a contact set to Contacted was missed - only leads were counted).
const MANUAL_RANK = { Contacted: 1, Responded: 2 };
const manualRank = (x) => MANUAL_RANK[x?.manualStatus] || 0;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

// How the member has worked on an account, in words ([] = not worked). Only work the TEAM does not already have counts
// (live test 1.2.1.11: a member who had left and rejoins holds the team's own data - everyone's contacted leads and
// follow-ups looked like hers, 19 accounts instead of the one she worked on). `team` null = nothing to compare with.
// `details` (optional array): one entry per thing done - { what: "lead" | "contact" | "account" | "follow-up" |
// "conversation", name, status, at } - for "Show details" on the Team Admin's card. `contactName(contact extras key)`:
// the person's name as the list shows it (the key's name part is sorted, lower-case words).
export function workedOn(key, values, normalize, team = null, teamKey = key, details = null, contactName = null) {
  const how = [];
  const add = (d) => { if (details && details.length < 100) details.push(d); };
  const worked = (l) => l && WORKED_LEAD_STATUSES.includes(l.status);
  const leads = Object.entries(values.results || {})
    .filter(([id, l]) => worked(l) && normalize(l.company) === key && !(team && worked(team.results?.[id]) && team.results[id].status === l.status));
  if (leads.length) how.push(`${leads.length} lead${leads.length === 1 ? "" : "s"} contacted`);
  for (const [, l] of leads) add({ what: "lead", name: l.author || "(a lead)", status: l.status, at: l.contactedAt || l.statusUpdatedAt || null });
  const nameOf = (ck) => contactName?.(ck) || ck.slice(ck.indexOf("::") + 2).replace(/\b\w/g, (c) => c.toUpperCase());
  const pairs = [[values.targetAccountExtras?.[key], team?.targetAccountExtras?.[teamKey], null],
    ...Object.entries(values.targetContactExtras || {}).filter(([k]) => k.startsWith(`${key}::`))
      .map(([k, v]) => [v, team?.targetContactExtras?.[`${teamKey}${k.slice(key.length)}`], k])].filter(([x]) => x);
  const marked = ([x, t]) => manualRank(x) > manualRank(t);
  const accountPair = pairs.find((p) => p[2] === null);
  if (accountPair && marked(accountPair)) {
    how.push(`the account marked ${accountPair[0].manualStatus}`);
    add({ what: "account", name: "The account itself", status: accountPair[0].manualStatus, at: accountPair[0].manualStatusAt || null });
  }
  const contactPairs = pairs.filter((p) => p[2] !== null && marked(p));
  if (contactPairs.length) how.push(`${contactPairs.length} contact${contactPairs.length === 1 ? "" : "s"} marked Contacted`);
  for (const [x, , k] of contactPairs) add({ what: "contact", name: nameOf(k), status: x.manualStatus, at: x.manualStatusAt || null });
  const followUps = pairs.filter(([x, t]) => x.nextActionDueAt && x.nextActionDueAt !== t?.nextActionDueAt);
  if (followUps.length) how.push("a follow-up date");
  for (const [x, , k] of followUps) add({ what: "follow-up", name: k ? nameOf(k) : "The account itself", status: "Follow-up due", at: x.nextActionDueAt });
  const talk = (x) => (x?.mentorHistory || []).length + (x?.customerVoiceHistory || []).length;
  const talks = pairs.filter(([x, t]) => talk(x) > talk(t));
  if (talks.length) how.push("a Sales Mentor conversation");
  for (const [, , k] of talks) add({ what: "conversation", name: k ? nameOf(k) : "The account itself", status: "Sales Mentor conversation", at: null });
  return how;
}

// Every account of one side: { key: { name, linkedinCompanyId } } - from targetAccounts and the workbook's companies
// (an account can be in either, or both).
function accountsOf(values, normalize) {
  const out = {};
  for (const [k, v] of Object.entries(values.targetAccounts || {})) {
    if (v) out[k] = { name: v.company || k, linkedinCompanyId: v.linkedinCompanyId || null };
  }
  for (const c of values.targetAccountsWorkbook?.companies || []) {
    const k = c && normalize(c.company);
    if (!k) continue;
    if (!out[k]) out[k] = { name: c.company, linkedinCompanyId: c.linkedinCompanyId || null };
    else if (!out[k].linkedinCompanyId && c.linkedinCompanyId) out[k].linkedinCompanyId = c.linkedinCompanyId;
  }
  return out;
}

function teamKeyFinder(teamAccounts) {
  const byId = new Map();
  for (const [k, v] of Object.entries(teamAccounts)) if (v.linkedinCompanyId) byId.set(String(v.linkedinCompanyId), k);
  return (key, entry) => {
    if (has(teamAccounts, key)) return key;
    const id = entry?.linkedinCompanyId ? String(entry.linkedinCompanyId) : null;
    return id && byId.has(id) ? byId.get(id) : null;
  };
}

// { localOnly: [{ key, name, contacts, leads, worked: [] }], shared: [{ key, localKey, name, worked: [] }] }
// shared lists only accounts the member has worked on. Removed accounts (deletedAt) on the member's side are skipped.
export function joinOverlap(local, team, normalize, { contactName = null } = {}) {
  const teamAccounts = accountsOf(team, normalize);
  const teamKeyOf = teamKeyFinder(teamAccounts);
  const localOnly = [];
  const shared = [];
  const contactsOf = (key) => (local.targetAccountsWorkbook?.contacts || []).filter((c) => c && normalize(c.company) === key).length;
  const leadsOf = (key) => Object.values(local.results || {}).filter((l) => l && normalize(l.company) === key).length;
  for (const [key, entry] of Object.entries(accountsOf(local, normalize))) {
    if (local.targetAccountExtras?.[key]?.deletedAt) continue;
    const name = entry.name;
    const teamKey = teamKeyOf(key, entry);
    const details = [];
    const worked = teamKey ? workedOn(key, local, normalize, team, teamKey, details, contactName) : workedOn(key, local, normalize);
    if (teamKey) {
      if (worked.length) shared.push({ key: teamKey, localKey: key, name: teamAccounts[teamKey].name || name, worked, details });
    } else {
      localOnly.push({ key, name, contacts: contactsOf(key), leads: leadsOf(key), worked });
    }
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  return { localOnly: localOnly.sort(byName), shared: shared.sort(byName) };
}

// A row id that is free in `taken`: the member's own id is kept when it is free, else made unique with the member id.
function freeId(id, taken, memberId) {
  if (id != null && id !== "" && !taken.has(String(id))) return id;
  let n = 1;
  let next = `${id ?? "J"}-${memberId}`;
  while (taken.has(next)) next = `${id ?? "J"}-${memberId}-${++n}`;
  return next;
}

// The team's values (as they are in storage right after the replace) with the member's chosen accounts put back:
// their targetAccounts / extras entries, workbook company, contact and initiative rows (ids that clash with a team
// row get a new one), contact extras and leads; plus the member's contacted leads of the shared accounts the team
// does not have yet. Returns only the keys that change: { [storage key]: new value }.
// `sharedKeys`: the shared accounts worked on - local keys, or { localKey, key } (key = the team's) when they differ.
export function addBackValues(local, team, addKeys, sharedKeys, normalize, memberId) {
  const keys = new Set(addKeys || []);
  const sharedList = (sharedKeys || []).map((x) => (typeof x === "string" ? { localKey: x, key: x } : x));
  const shared = new Set(sharedList.map((x) => x.localKey));
  const out = {};
  if (!keys.size && !shared.size) return out;

  if (keys.size) {
    const ta = { ...(team.targetAccounts || {}) };
    const ax = { ...(team.targetAccountExtras || {}) };
    const cx = { ...(team.targetContactExtras || {}) };
    for (const k of keys) {
      if (local.targetAccounts?.[k]) ta[k] = local.targetAccounts[k];
      if (local.targetAccountExtras?.[k]) ax[k] = local.targetAccountExtras[k];
    }
    for (const [ck, v] of Object.entries(local.targetContactExtras || {})) {
      const i = ck.indexOf("::");
      if (i > 0 && keys.has(ck.slice(0, i)) && !has(cx, ck)) cx[ck] = v;
    }
    out.targetAccounts = ta;
    out.targetAccountExtras = ax;
    out.targetContactExtras = cx;

    const lwb = local.targetAccountsWorkbook || {};
    const twb = team.targetAccountsWorkbook || {};
    const wb = { ...twb };
    const sheetIds = (rows, f) => new Set((rows || []).map((r) => r && r[f]).filter((v) => v != null && v !== "").map(String));
    const companyIds = sheetIds(twb.companies, "companyId");
    const idMap = new Map();
    const companies = [...(twb.companies || [])];
    for (const row of lwb.companies || []) {
      if (!row || !keys.has(normalize(row.company))) continue;
      const id = freeId(row.companyId, companyIds, memberId);
      companyIds.add(String(id));
      if (row.companyId != null) idMap.set(String(row.companyId), id);
      companies.push({ ...row, companyId: id });
    }
    const moved = (row) => row && (keys.has(normalize(row.company)) || (row.companyId != null && idMap.has(String(row.companyId)) && !row.company));
    const remapCompany = (row) => (row.companyId != null && idMap.has(String(row.companyId)) ? { ...row, companyId: idMap.get(String(row.companyId)) } : row);
    const contactIds = sheetIds(twb.contacts, "contactId");
    const contacts = [...(twb.contacts || [])];
    for (const row of lwb.contacts || []) {
      if (!moved(row)) continue;
      const id = freeId(row.contactId, contactIds, memberId);
      contactIds.add(String(id));
      contacts.push({ ...remapCompany(row), contactId: id });
    }
    const initIds = sheetIds(twb.aiInitiatives, "initiativeId");
    const inits = [...(twb.aiInitiatives || [])];
    for (const row of lwb.aiInitiatives || []) {
      if (!moved(row)) continue;
      const id = freeId(row.initiativeId, initIds, memberId);
      initIds.add(String(id));
      inits.push({ ...remapCompany(row), initiativeId: id });
    }
    wb.companies = companies;
    wb.contacts = contacts;
    if (Array.isArray(twb.aiInitiatives) || inits.length) wb.aiInitiatives = inits;
    out.targetAccountsWorkbook = wb;
  }

  const results = { ...(team.results || {}) };
  let leadsAdded = 0;
  for (const [id, lead] of Object.entries(local.results || {})) {
    if (!lead) continue;
    const k = normalize(lead.company);
    const isWorked = WORKED_LEAD_STATUSES.includes(lead.status);
    if (has(results, id)) {
      // The team has the lead but not as contacted: the member's outreach is carried over (status and who / when).
      if (shared.has(k) && isWorked && !WORKED_LEAD_STATUSES.includes(results[id]?.status)) {
        const carried = { status: lead.status };
        for (const f of ["contactedBy", "contactedAt", "statusUpdatedAt"]) if (lead[f] != null) carried[f] = lead[f];
        results[id] = { ...results[id], ...carried };
        leadsAdded += 1;
      }
      continue;
    }
    if (keys.has(k) || (shared.has(k) && WORKED_LEAD_STATUSES.includes(lead.status))) {
      results[id] = lead;
      leadsAdded += 1;
    }
  }
  if (leadsAdded) out.results = results;

  // Statuses set by hand on the shared accounts and their contacts: carried over where the member's is further on.
  if (sharedList.length) {
    const ax = { ...(out.targetAccountExtras || team.targetAccountExtras || {}) };
    const cx = { ...(out.targetContactExtras || team.targetContactExtras || {}) };
    let changed = false;
    const carry = (map, k, from) => {
      if (manualRank(from) <= manualRank(map[k])) return;
      map[k] = { ...(map[k] || {}), manualStatus: from.manualStatus, manualStatusAt: from.manualStatusAt || null };
      changed = true;
    };
    for (const { localKey, key } of sharedList) {
      if (local.targetAccountExtras?.[localKey]) carry(ax, key, local.targetAccountExtras[localKey]);
      for (const [ck, v] of Object.entries(local.targetContactExtras || {})) {
        if (ck.startsWith(`${localKey}::`)) carry(cx, `${key}${ck.slice(localKey.length)}`, v);
      }
    }
    if (changed) { out.targetAccountExtras = ax; out.targetContactExtras = cx; }
  }
  return out;
}

// The proposals the member writes on joining (one per shared account worked on). `assignee`: the account's
// assignee in the team right now (member id) or null. Keyed `<member>~<account key>` - one per member and account.
export function joinProposals(shared, { memberId, memberName, at, assigneeOf }) {
  const out = {};
  for (const s of shared || []) {
    out[`${memberId}~${s.key}`] = { key: s.key, name: s.name, by: memberId, byName: memberName, at, worked: s.worked, details: s.details || [], assignee: assigneeOf(s.key) || null };
  }
  return out;
}
