// Team use 1.2.2, build step 6 (TEAM_USE_DESIGN.md 9.2, R6.7): join proposals in Decisions. A member who joined with
// accounts the team already had, and had worked on them, left one proposal per account (team-join.js); the Team
// Admin decides who keeps each: the member who proposed it, or as it is now (the current assignee, or unassigned).
// Shown to the Team Admin only. Deciding assigns through the sync layer (TEAM_ASSIGN) and removes the proposal.
import { JOIN_PROPOSALS_KEY } from "./team-join.js";

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
  not_admin: "only the Team Admin can do this",
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
