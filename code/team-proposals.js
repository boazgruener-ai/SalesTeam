// Team use 1.2.2, build step 6 (TEAM_USE_DESIGN.md 9.2, R6.7): join proposals in Decisions. A member who joined with
// accounts the team already had, and had worked on them, left one proposal per account (team-join.js); the Team
// Admin decides who keeps each: the member who proposed it, or as it is now (the current assignee, or unassigned).
// Shown to the Team Lead only. Deciding assigns through the sync layer (TEAM_ASSIGN) and removes the proposal.
import { JOIN_PROPOSALS_KEY } from "./team-join.js";
import { groupIndex, groupsOf, groupFacts, livePins, sameGroups, mayAccess, OTHER_GROUP } from "./team-groups.js";

const SUMMARY_KEY = "teamAccountStates"; // team-sync.js TEAM_ACCOUNTS_KEY

export async function joinProposalItems() {
  const v = await chrome.storage.local.get([JOIN_PROPOSALS_KEY, SUMMARY_KEY, "teamMembership", "targetAccountExtras"]);
  const summary = v[SUMMARY_KEY];
  if (!v.teamMembership || !summary?.admin) return [];
  const name = (m) => (m === summary.me ? "you" : summary.names?.[m] || "a colleague");
  const items = [];
  for (const [id, p] of Object.entries(v[JOIN_PROPOSALS_KEY] || {})) {
    if (!p || !p.key || v.targetAccountExtras?.[p.key]?.deletedAt) continue;
    const now = summary.accounts?.[p.key]?.a || null;
    // Already settled meanwhile (the admin assigned it to the proposer some other way): nothing to ask.
    if (now && now === p.by) continue;
    const proposer = p.byName || name(p.by);
    const keepLabel = now ? `Keep with ${now === summary.me ? "me" : name(now)}` : "Leave unassigned";
    // The proposed owner first (R6.7): the member who worked on it - unless a colleague already has it assigned.
    const give = ["give", `Give it to ${proposer}`];
    const keep = ["keep", keepLabel];
    items.push({
      id: `join:${id}`, kind: "join_proposal", accountKey: p.key, company: p.name || p.key, priority: null,
      // "Also for Anna's other N join proposals" (decisions.js): the same answer for everything one member proposed.
      similar: `join:${p.by}`,
      choices: now ? [keep, give] : [give, keep],
      payload: { proposalId: id, by: p.by, byName: proposer, at: p.at, worked: p.worked || [], details: p.details || [], current: now ? name(now) : null, currentId: now },
    });
  }
  return items.sort((a, b) => (a.payload.at || 0) - (b.payload.at || 0));
}

async function removeProposal(id) {
  const v = await chrome.storage.local.get(JOIN_PROPOSALS_KEY);
  const map = { ...(v[JOIN_PROPOSALS_KEY] || {}) };
  if (!(id in map)) return;
  delete map[id];
  await chrome.storage.local.set({ [JOIN_PROPOSALS_KEY]: map });
}

const REFUSED = {
  offline: "the team folder is not connected",
  not_in_sync: "SalesTeam is not in sync with the team",
  held: "a colleague is updating this account right now - try again in a few minutes",
  not_lead: "only the Team Lead can do this",
};

export async function applyJoinProposal(item, choice) {
  const p = item.payload || {};
  if (choice === "give") {
    const r = await chrome.runtime.sendMessage({ type: "TEAM_ASSIGN", key: item.accountKey, to: p.by });
    if (!r || r.ok === false) throw new Error(REFUSED[r?.reason] || "the assignment did not go through - try again in a moment");
    await removeProposal(p.proposalId);
    return `"${item.company}": given to ${p.byName}`;
  }
  await removeProposal(p.proposalId);
  return `"${item.company}": ${p.current ? `kept with ${p.current}` : "left unassigned"} (${p.byName}'s join proposal declined)`;
}

// --------------------------------------------------------------------------------------------------------------
// 1.2.3 team advanced mode, step 4 (TEAM_ADVANCED_MODE_DESIGN.md 8.2, R5.2): group moves. New data would change the
// groups of an ASSIGNED account; the sync layer pinned it to its old groups (teamGroupPins) until the Team Lead says
// Move it (the pin goes, the new groups apply, an assignee without access there is released). One answer only
// (Boaz, 2026-10-11: no "Keep it where it is" - an account kept in a group whose filter it does not match is wrong;
// a Team Lead who disagrees with the data corrects the data, and the card goes by itself). Shown to the Team Lead and
// the deputy only. Where the account would go is
// computed from the data as it is NOW, not from what the pin recorded - research may have run again since.
// --------------------------------------------------------------------------------------------------------------
const PINS_KEY = "teamGroupPins";
const GROUPS_KEY = "teamGroups";

// loadViews: () => the account views (storage.js getAccountViews - passed in, storage.js imports this module).
export async function groupMoveItems(loadViews, buckets) {
  const v = await chrome.storage.local.get([PINS_KEY, GROUPS_KEY, SUMMARY_KEY, "teamMembership"]);
  const summary = v[SUMMARY_KEY];
  if (!v.teamMembership || !summary?.admin || !summary.groupsOn) return [];
  const assigned = {};
  for (const [key, e] of Object.entries(summary.accounts || {})) if (e?.a) assigned[key] = e.a;
  const open = Object.entries(livePins(v[PINS_KEY], assigned));
  if (!open.length) return [];
  const groups = v[GROUPS_KEY] || {};
  const index = groupIndex(groups, Object.keys(summary.ofMember || {}));
  const leads = { lead: summary.lead, deputy: summary.deputy };
  const views = new Map((await loadViews()).map((x) => [x.key, x]));
  const name = (m) => (m === summary.me ? "you" : summary.names?.[m] || "a colleague");
  const groupNames = (ids) => ids.map((id) => (id === OTHER_GROUP ? "Other" : groups[id]?.name || id)).join(", ");
  const items = [];
  for (const [key, pin] of open) {
    const view = views.get(key);
    if (!view) continue;
    const now = groupsOf(key, groupFacts(view, { buckets }), index, null);
    const old = groupsOf(key, null, index, { [key]: pin });
    if (sameGroups(now, old)) continue; // the data went back meanwhile: nothing to decide
    const member = assigned[key];
    items.push({
      id: `gmove:${key}:${now.join("+")}`, kind: "group_move", accountKey: key, company: view.company || key, priority: null,
      similar: "gmove", choices: [["move", "Move it"]],
      payload: { reason: pin.reason || "", from: groupNames(old), to: groupNames(now), assignee: name(member), assigneeId: member,
        keeps: mayAccess(member, now, index, leads), by: pin.by ? name(pin.by) : null, at: pin.at || null },
    });
  }
  return items.sort((a, b) => (a.payload.at || 0) - (b.payload.at || 0));
}

async function writePin(key, change) {
  const map = { ...((await chrome.storage.local.get(PINS_KEY))[PINS_KEY] || {}) };
  if (!(key in map)) return;
  const next = change(map[key]);
  if (next) map[key] = next; else delete map[key];
  await chrome.storage.local.set({ [PINS_KEY]: map });
}

export async function applyGroupMove(item) {
  const p = item.payload || {};
  // The release first: if it is refused, the account stays pinned and can be decided again.
  if (!p.keeps) {
    const r = await chrome.runtime.sendMessage({ type: "TEAM_RELEASE_VOID", items: [{ key: item.accountKey, member: p.assigneeId, into: p.to }] });
    if (!r || r.ok === false) throw new Error(REFUSED[r?.reason] || "the move did not go through - try again in a moment");
  }
  await writePin(item.accountKey, () => null);
  return `"${item.company}": moved to ${p.to}${p.keeps ? "" : ` - released from ${p.assignee}`}`;
}
