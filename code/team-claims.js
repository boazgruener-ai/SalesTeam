// Team use 1.2.2, build step 4 (TEAM_USE_DESIGN.md 6): which account a change belongs to, and what an account's
// claims look like to one member. PURE - no chrome.*, no DOM - so test_pure_modules.py runs it for real.
//
// A claim is on an ACCOUNT, named by its company key (the normalised company name, as the account page, the
// pipeline and every local home use it): "@<company key>". Every account and contact row resolves to that key
// without a join - targetAccounts / extras rows carry it in their id, a contact's extras key starts with it, a
// workbook row has its company name. (Design 4.1 planned the bare companyId; the key is what all homes share.)
// Leads and settings belong to no account claim.

import { getRecord, activeClaims, activeAssignments, isClaimConfirmed, stampWall } from "./team-merge.js";

export const claimIdFor = (companyKey) => `@${companyKey}`;

const companyName = (state, e, id) => {
  const v = getRecord(state, e, id)?.f.company?.v;
  return typeof v === "string" ? v : null;
};

// The company key a change record belongs to, or null. `normalize` is storage.js normalizeCompanyName.
export function accountKeyOfChange(state, ch, normalize) {
  if (!ch || (ch.e !== "account" && ch.e !== "contact")) return null;
  const id = String(ch.id);
  if (ch.e === "account" && (id.startsWith("ta:") || id.startsWith("x:"))) return id.slice(id.indexOf(":") + 1) || null;
  if (ch.e === "contact" && id.startsWith("x:")) {
    const i = id.indexOf("::");
    return i > 2 ? id.slice(2, i) : null;
  }
  if (!id.startsWith("wb:")) return null;
  let name = typeof ch.f?.company === "string" ? ch.f.company : companyName(state, ch.e, id);
  // A workbook contact without its own company name belongs to its company row.
  if (!name && ch.e === "contact") {
    const cid = ch.f?.companyId ?? getRecord(state, "contact", id)?.f.companyId?.v;
    if (cid != null) name = companyName(state, "account", `wb:${cid}`);
  }
  return name ? normalize(name) || null : null;
}

// Members counted for claims and pipeline shares: seen within `activeMs` (D5: 10 minutes).
export function activeMembersOf(lastSeen, now, activeMs) {
  return Object.keys(lastSeen || {}).filter((m) => now - (lastSeen[m] || 0) <= activeMs).sort();
}

// ctx: { me, now, lastSeen: {member: ms}, readUpTo: {member: ms}, activeMembers: [colleague ids], idleMs }
// -> { state, holder, mine, confirmed }
//   free     - nobody holds the account
//   checking - my claim is the earliest, but not every active colleague has been heard from since (6.3)
//   mine     - my claim is the earliest and confirmed
//   other    - a colleague holds it (I have no claim on it)
//   lost     - a colleague claimed it before me
export function claimView(state, companyKey, ctx) {
  const { me, now } = ctx;
  const claims = activeClaims(state, "account", claimIdFor(companyKey), {
    now, lastSeen: { ...(ctx.lastSeen || {}), [me]: now }, idleMs: ctx.idleMs,
  });
  const holder = claims[0] || null;
  const mine = claims.find((c) => c.member === me) || null;
  const confirmed = Boolean(mine) && isClaimConfirmed(mine.since, { me, activeMembers: ctx.activeMembers || [], readUpTo: ctx.readUpTo || {} });
  let view = "free";
  if (holder && holder.member === me) view = confirmed ? "mine" : "checking";
  else if (holder) view = mine ? "lost" : "other";
  return { state: view, holder: holder && { member: holder.member, since: holder.since, sinceWall: stampWall(holder.since) }, mine, confirmed };
}

// --------------------------------------------------------------------------
// Assignments (design 7, R6.1-R6.2) - build step 5
// --------------------------------------------------------------------------
// An assignment is kept on the same "@<company key>" record as the claims. It does not expire. The earliest active
// one counts; while mine is not yet confirmed by every active colleague (6.3) it shows as "checking".

// -> { assignee: { member, since, sinceWall } | null, mine, confirmed, lostTo }
//   mine     - I am the assignee
//   lostTo   - I assigned it to myself, but a colleague's assignment is earlier (team-sync withdraws mine)
export function assignmentView(state, companyKey, ctx) {
  const list = activeAssignments(state, "account", claimIdFor(companyKey));
  const first = list[0] || null;
  const mine = Boolean(first && first.member === ctx.me);
  const confirmed = mine && isClaimConfirmed(first.since, { me: ctx.me, activeMembers: ctx.activeMembers || [], readUpTo: ctx.readUpTo || {} });
  const lostTo = !mine && list.some((a) => a.member === ctx.me) ? first.member : null;
  return { assignee: first, mine, confirmed, lostTo };
}

// Why this member may not change, research, scan or contact an account (R6.2), or null when it may.
//   { reason: "assigned", member, sinceWall } - a colleague's account
//   { reason: "held", member, sinceWall }     - a colleague is updating it right now (a claim)
// Reading is never off-limits. The Team Lead is no exception: it can release or reassign, not work it.
export function offLimitsFor(state, companyKey, ctx) {
  const a = assignmentView(state, companyKey, ctx);
  if (a.assignee && !a.mine) return { reason: "assigned", member: a.assignee.member, sinceWall: a.assignee.sinceWall };
  const c = claimView(state, companyKey, ctx);
  if (c.state === "other" || c.state === "lost") return { reason: "held", member: c.holder.member, sinceWall: c.holder.sinceWall };
  return null;
}

// What every page needs for badges, the Mine / Unassigned filter and the list's off-limits checks, in one small
// object - only accounts with an assignment or an active claim are listed:
//   { [company key]: { a?: member, as?: wall ms, ac?: confirmed-by-me flag, h?: holder member, hs?: wall ms } }
export function teamAccountSummary(state, ctx) {
  const out = {};
  const records = state.entities?.account || {};
  for (const id of Object.keys(records)) {
    if (!id.startsWith("@")) continue;
    const key = id.slice(1);
    const a = assignmentView(state, key, ctx);
    const c = claimView(state, key, ctx);
    const entry = {};
    if (a.assignee) {
      entry.a = a.assignee.member;
      entry.as = a.assignee.sinceWall;
      if (a.mine && !a.confirmed) entry.ac = false;
    }
    if (c.holder) {
      entry.h = c.holder.member;
      entry.hs = c.holder.sinceWall;
    }
    if (entry.a || entry.h) out[key] = entry;
  }
  return out;
}

// The page side of the same rule, on one teamAccountSummary entry (null when nothing is known about the account).
export function summaryOffLimits(entry, me) {
  if (!entry) return null;
  if (entry.a && entry.a !== me) return { reason: "assigned", member: entry.a, sinceWall: entry.as };
  if (entry.h && entry.h !== me) return { reason: "held", member: entry.h, sinceWall: entry.hs };
  return null;
}
