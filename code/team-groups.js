// Team advanced mode 1.2.3, step 0 (TEAM_ADVANCED_MODE_DESIGN.md 3, 5, 8.3): the Team Lead chain and account groups.
// PURE - no chrome.*, no DOM, no clock of its own - so test_pure_modules.py runs it for real, and every PC computes the
// same answer from the same shared data (R10.2).
//
//   teamLeadOf(creator, records, opts)  the Team Lead and deputy, from the creator and the team|lead/deputy/takeover records
//   leadRightsAt(chain, member, stamp)  had this member the Team Lead's rights when this stamp was written?
//   groupFacts(view, { buckets })       an account view -> the plain values a filter looks at
//   matchesFilter(facts, filter)        any of a field's values, all fields together; an unknown value never matches
//   groupsOf(key, facts, index, pins)   the account's group ids (["other"] when none)
//   groupIndex(groups, team)            live groups, members per group (a member in no group is in Other)
//   mayAccess / accessOf                who may see and work an account: Team Lead, deputy, members of its groups
//   voidAssignments                     assignments whose assignee no longer has access (D6 - computed on every PC)
//   groupCounts                         per group: accounts, assigned, unassigned, ready

import { regionOfCountry } from "./geo-regions.js";
import { sizeBucketKey, localOrGlobal } from "./web-findings-arbitration.js";

export const OTHER_GROUP = "other";
// D13: a Team Lead who has written nothing for this long can be taken over from (the deputy first).
export const TAKEOVER_AFTER_MS = 30 * 24 * 3600 * 1000;
export const GROUP_FILTER_FIELDS = ["region", "country", "size", "scope", "industry", "companyType", "priority", "relationship"];
export const GROUP_KINDS = ["filter", "named"];

// A stamp is "<13-digit wall ms>-<4-digit counter>-<member>" (team-merge.js); read here without importing it.
const STAMP_RE = /^(\d{13})-(\d{4})-(.+)$/;
const wallOf = (t) => Number((STAMP_RE.exec(String(t || "")) || [])[1] || 0);
const authorOf = (t) => (STAMP_RE.exec(String(t || "")) || [])[3] || null;

// --------------------------------------------------------------------------
// The Team Lead chain (design 3.1, 3.4, D13)
// --------------------------------------------------------------------------
// records: [{ t, id: "lead" | "deputy" | "takeover", member }] in any order. Walked in stamp order from the creator:
//   lead     - "<author> makes <member> Team Lead": valid only from the current Team Lead. The deputy ends with it.
//   deputy   - "<author> makes <member> deputy" (member null: ends the deputy): valid only from the current Team Lead.
//   takeover - "<author> takes over as Team Lead": valid only if the current Team Lead wrote nothing in the
//              TAKEOVER_AFTER_MS before it, and the author is the deputy - or anyone when there is no deputy.
// activeWithin(member, fromWall, toWall): did the member write any change record in that window. Without it no
// take-over can be checked, so none counts.
// Same records -> same Team Lead on every PC, whatever order they arrived in.
export function teamLeadOf(creator, records, { activeWithin = null, takeoverMs = TAKEOVER_AFTER_MS } = {}) {
  let lead = creator || null;
  let deputy = null;
  const segments = [{ from: null, lead, deputy }];
  const ignored = [];
  const sorted = [...(records || [])].filter((r) => r && r.t).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  for (const r of sorted) {
    const author = authorOf(r.t);
    const member = r.member || null;
    let ok = false;
    if (lead && author) {
      if (r.id === "lead") {
        ok = author === lead && Boolean(member) && member !== lead;
        if (ok) { lead = member; deputy = null; }
      } else if (r.id === "deputy") {
        ok = author === lead && member !== lead && (member !== null || deputy !== null);
        if (ok) deputy = member;
      } else if (r.id === "takeover") {
        const t = wallOf(r.t);
        const quiet = typeof activeWithin === "function" && !activeWithin(lead, t - takeoverMs, t);
        ok = member === author && author !== lead && quiet && (deputy ? author === deputy : true);
        if (ok) { lead = author; deputy = null; }
      }
    }
    if (ok) segments.push({ from: r.t, lead, deputy });
    else ignored.push(r.t);
  }
  return { creator: creator || null, lead, deputy, segments, ignored };
}

// The segment in force when `stamp` was written (a record is judged by the rights its author had at that moment).
function segmentAt(chain, stamp) {
  const segs = chain?.segments || [];
  let seg = segs[0] || null;
  for (const s of segs) if (s.from === null || s.from < stamp) seg = s;
  return seg;
}

// Team Lead or deputy at that stamp - the rights that may change groups (design 4.2, 3.4).
export function leadRightsAt(chain, member, stamp) {
  const seg = segmentAt(chain, stamp);
  return Boolean(seg && member && (member === seg.lead || member === seg.deputy));
}

// Now: the Team Lead's rights (lead or active deputy) - everything except hand-over, deputy and removing the lead.
export function chainLeadRights(chain, member) {
  return Boolean(chain && member && (member === chain.lead || member === chain.deputy));
}

// --------------------------------------------------------------------------
// Facts and filters (design 5.1, 5.2)
// --------------------------------------------------------------------------

const plainText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const sameText = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// buckets: storage.js's SIZE_PRIORITY_BUCKETS - the same buckets the Size column and size priority use (D4).
export function groupFacts(view, { buckets = [] } = {}) {
  const v = view || {};
  return {
    region: regionOfCountry(v.globalHqCountry),
    country: plainText(v.globalHqCountry),
    size: sizeBucketKey(v.globalEmployees, buckets),
    scope: localOrGlobal(v),
    industry: plainText(v.industry),
    companyType: plainText(v.companyType),
    priority: plainText(v.salesTeamPriority),
    relationship: Array.isArray(v.relationship) ? v.relationship : [],
  };
}

export function filterHasConditions(filter) {
  return GROUP_FILTER_FIELDS.some((f) => Array.isArray(filter?.[f]) && filter[f].length > 0);
}

// Each field with values must match (any of its values); an empty field is no condition. An unknown fact (null)
// never matches a field that has values - an account without a country is not "Europe" (R2.5). Relationship is a
// list: "customer" / "partner" match if the account has it, "none" matches an account with neither.
export function matchesFilter(facts, filter) {
  for (const field of GROUP_FILTER_FIELDS) {
    const wanted = filter?.[field];
    if (!Array.isArray(wanted) || !wanted.length) continue;
    const fact = facts?.[field];
    if (field === "relationship") {
      const list = Array.isArray(fact) ? fact : [];
      if (!wanted.some((w) => (w === "none" ? list.length === 0 : list.includes(w)))) return false;
      continue;
    }
    if (fact == null || fact === "") return false;
    if (!wanted.some((w) => w != null && sameText(w, fact))) return false;
  }
  return true;
}

// --------------------------------------------------------------------------
// Groups and members (design 4.1, 5.3, D9)
// --------------------------------------------------------------------------
// groups: the merged teamGroups map { id: row }; team: the current members (not left, not removed).

export function isLiveGroup(id, g) {
  return id !== OTHER_GROUP && Boolean(g) && !g.deleted && GROUP_KINDS.includes(g.kind);
}

// Advanced mode is on as soon as one live group exists (R9.1: no groups = exactly 1.2.2).
export function groupsOn(groups) {
  return Object.entries(groups || {}).some(([id, g]) => isLiveGroup(id, g));
}

export function groupIndex(groups, team) {
  const teamSet = new Set(team || []);
  const live = Object.keys(groups || {}).filter((id) => isLiveGroup(id, groups[id])).sort().map((id) => ({ id, ...groups[id] }));
  const members = {};
  const inSome = new Set();
  for (const g of live) {
    members[g.id] = [...new Set((g.members || []).filter((m) => teamSet.has(m)))].sort();
    for (const m of members[g.id]) inSome.add(m);
  }
  // Other: its own members, plus every member in no group (D9 - computed, nothing written).
  const otherOwn = (groups?.[OTHER_GROUP]?.members || []).filter((m) => teamSet.has(m));
  members[OTHER_GROUP] = [...new Set([...otherOwn, ...[...teamSet].filter((m) => !inSome.has(m))])].sort();
  const ofMember = {};
  for (const [gid, list] of Object.entries(members)) for (const m of list) (ofMember[m] || (ofMember[m] = [])).push(gid);
  for (const m of Object.keys(ofMember)) ofMember[m].sort();
  return { live, members, ofMember, on: live.length > 0 };
}

export function membersOf(groupId, index) {
  return index?.members?.[groupId] || [];
}

export function memberGroups(member, index) {
  return index?.ofMember?.[member] || [];
}

// The account's groups: its pin when it has one (8.2: research does not move an assigned account by itself), else
// every filter it matches and every named list it is on, else Other (R2.3, R2.5, R2.7).
export function groupsOf(key, facts, index, pins = null) {
  const liveIds = new Set((index?.live || []).map((g) => g.id));
  const pin = pins?.[key];
  if (pin && Array.isArray(pin.groups)) {
    const kept = pin.groups.filter((g) => liveIds.has(g) || g === OTHER_GROUP);
    if (kept.length) return [...new Set(kept)].sort();
  }
  const out = [];
  for (const g of index?.live || []) {
    if (g.kind === "named" ? (g.accounts || []).includes(key) : filterHasConditions(g.filter) && matchesFilter(facts, g.filter)) out.push(g.id);
  }
  return out.length ? out : [OTHER_GROUP];
}

// leads: { lead, deputy } (teamLeadOf). The Team Lead and the deputy see everything.
export function mayAccess(member, groupIds, index, leads) {
  if (!member) return false;
  if (!index?.on) return true;
  if (member === leads?.lead || member === leads?.deputy) return true;
  const mine = memberGroups(member, index);
  return (groupIds || []).some((g) => mine.includes(g));
}

export function accessOf(groupIds, index, leads) {
  const out = new Set([leads?.lead, leads?.deputy].filter(Boolean));
  for (const g of groupIds || []) for (const m of membersOf(g, index)) out.add(m);
  return [...out].sort();
}

// D6: an assignment whose assignee has no access through the account's current groups is void on every PC.
// assignments: { key: member }, groupsByKey: { key: [groupIds] } -> [{ key, member }].
export function voidAssignments(assignments, groupsByKey, index, leads) {
  if (!index?.on) return [];
  const out = [];
  for (const key of Object.keys(assignments || {}).sort()) {
    const member = assignments[key];
    if (member && !mayAccess(member, groupsByKey?.[key] || [OTHER_GROUP], index, leads)) out.push({ key, member });
  }
  return out;
}

// Settings > Team, the Groups table (10.2): per group id (Other included) { accounts, assigned, unassigned, ready }.
// assignments: { key: member } (already without void ones); ready: { key: true }.
export function groupCounts(groupsByKey, index, { assignments = {}, ready = {} } = {}) {
  const out = {};
  for (const g of [...(index?.live || []).map((x) => x.id), OTHER_GROUP]) out[g] = { accounts: 0, assigned: 0, unassigned: 0, ready: 0 };
  for (const [key, ids] of Object.entries(groupsByKey || {})) {
    for (const g of ids || []) {
      const c = out[g];
      if (!c) continue;
      c.accounts += 1;
      if (assignments[key]) c.assigned += 1; else c.unassigned += 1;
      if (ready[key]) c.ready += 1;
    }
  }
  return out;
}

// The editor's Save check (5.2): "" when the group may be saved, else the reason in plain words.
export function groupProblem(g) {
  if (!g || !plainText(g.name)) return "Give the group a name.";
  if (!GROUP_KINDS.includes(g.kind)) return "Choose Filter or Named accounts.";
  if (g.kind === "filter" && !filterHasConditions(g.filter)) return "Add at least one condition - or use All accounts.";
  return "";
}

// Pages and storage.js (design 3.2): the Team Lead's rights, from the summary the background publishes
// (teamAccountStates: lead, deputy, leadKnown). Before the background has read the folder once, membership.role
// is the answer - the same fallback the background uses.
export function leadRightsOf(membership, summary) {
  if (!membership) return false;
  if (summary && summary.leadKnown) return membership.memberId === summary.lead || membership.memberId === summary.deputy;
  return membership.role === "admin";
}

export function isTeamLeadOf(membership, summary) {
  if (!membership) return false;
  if (summary && summary.leadKnown) return membership.memberId === summary.lead;
  return membership.role === "admin";
}
