// Team use 1.2.2, build step 5 (TEAM_USE_DESIGN.md 7, R6.2-R6.5): the pages' view of every account's assignment and
// active claim, kept by the background (team-sync.js TEAM_ACCOUNTS_KEY). Not in a team: everything here is a no-op -
// no badges, no filter, nothing off-limits.
//
//   await teamAccounts.ready()       - loaded once; later changes arrive by themselves
//   teamAccounts.inTeam()            - this PC is in a team
//   teamAccounts.offLimits(key)      - null, or { reason: "assigned" | "held" | "offline", name, since, text }
//   teamAccounts.badge(key)          - a <span> for a list row ("Anna" / "Mine" / "Anna is updating"), or null
//   teamAccounts.ownerFilter(key, f) - "mine" | "others" | "unassigned" | "all"
//   teamAccounts.isTeamLead()        - 1.2.3: the Team Lead, as decided by the team folder (team-groups.js)
//   teamAccounts.hasLeadRights()     - the Team Lead or the deputy (everything but hand-over, deputy, removing the lead)
//   teamAccounts.mayAccess(m, key)   - 1.2.3: may this member see and work the account (always, without groups)
//   teamAccounts.canSee(key)         - 1.2.3 step 2: is the account in one of my groups (always, without groups)
//   teamAccounts.canSeeLead(lead)    - the same for a lead, through its company
//   teamAccounts.groupPicker(selectEl, storageKey, onPick) - the Group dropdown above a table (design 7)
//   teamAccounts.onChange(fn)

import { summaryOffLimits } from "./team-claims.js";
import { leadRightsOf, isTeamLeadOf, canSeeAccount, canSeeLead, isLiveGroup } from "./team-groups.js";
import { normalizeCompanyName } from "./storage.js";

const KEY = "teamAccountStates"; // team-sync.js TEAM_ACCOUNTS_KEY
const MEMBERSHIP_KEY = "teamMembership";
const GROUPS_KEY = "teamGroups";
let groupRows = {};

let summary = null;
let membership = null;
let loaded = null;
const listeners = new Set();

function dayText(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes[KEY] && !changes[MEMBERSHIP_KEY] && !changes[GROUPS_KEY])) return;
  if (changes[GROUPS_KEY]) groupRows = changes[GROUPS_KEY].newValue || {};
  if (changes[KEY]) summary = changes[KEY].newValue || null;
  if (changes[MEMBERSHIP_KEY]) membership = changes[MEMBERSHIP_KEY].newValue || null;
  for (const fn of listeners) { try { fn(); } catch { /* one page's redraw must not stop another's */ } }
});

const nameOf = (m) => (m === summary?.me ? "you" : summary?.names?.[m] || "a colleague");

export const teamAccounts = {
  ready() {
    if (!loaded) {
      loaded = chrome.storage.local.get([KEY, MEMBERSHIP_KEY, GROUPS_KEY]).then((d) => {
        groupRows = d[GROUPS_KEY] || {};
        summary = d[KEY] || null;
        membership = d[MEMBERSHIP_KEY] || null;
      }).catch(() => {});
    }
    return loaded;
  },
  inTeam: () => Boolean(membership),
  isTeamLead: () => isTeamLeadOf(membership, summary),
  hasLeadRights: () => leadRightsOf(membership, summary),
  me: () => membership?.memberId || null,
  myName: () => membership?.name || null,
  // Step 5b (design 2.11): removing accounts or contacts is the Team Lead's in a team - it empties every member's list.
  canRemove() { return !membership || this.hasLeadRights(); },
  entry: (key) => (membership && key ? summary?.accounts?.[key] || null : null),

  // Everything that changes, researches, scans or contacts an account asks this first. Reading is never blocked.
  offLimits(key) {
    if (!membership) return null;
    if (!summary || !summary.inSync) {
      return { reason: "offline", text: "The team folder is not connected on this PC (or not in sync) - changes are blocked until it is (see the top bar)." };
    }
    const o = summaryOffLimits(this.entry(key), summary.me);
    if (!o) return null;
    const name = nameOf(o.member);
    return {
      ...o,
      name,
      text: o.reason === "assigned" ? `Assigned to ${name} since ${dayText(o.sinceWall)}` : `${name} is updating it (since ${dayText(o.sinceWall)})`,
    };
  },

  // R6.5: "Anna" / "Mine" / "Anna is updating" - the full "Assigned to Anna since 3 Oct" in the tooltip.
  badge(key) {
    const e = this.entry(key);
    if (!e) return null;
    const span = document.createElement("span");
    span.className = "team-badge";
    if (e.a) {
      const mine = e.a === summary.me;
      span.classList.add(mine ? "team-badge-mine" : "team-badge-other");
      // Shown as mine at once (Boaz, 2026-10-05): the rare same-second race is still settled in the background - the
      // later assignment is withdrawn and its member told on the account page.
      // Just the name (or "Mine", as the filter says) keeps the Company column narrow; the tooltip has the full text.
      span.textContent = mine ? "Mine" : nameOf(e.a);
      span.title = mine ? `Assigned to you since ${dayText(e.as)}` : `Assigned to ${nameOf(e.a)} since ${dayText(e.as)}`;
    } else if (e.h && e.h !== summary.me) {
      span.classList.add("team-badge-busy");
      span.textContent = `${nameOf(e.h)} is updating`;
      span.title = `${nameOf(e.h)} is updating this account (since ${dayText(e.hs)})`;
    } else {
      return null;
    }
    return span;
  },

  // R6.3: Mine / Others (assigned to a colleague) / Unassigned / All.
  ownerFilter(key, filter) {
    if (!membership || !filter || filter === "all") return true;
    const a = this.entry(key)?.a || null;
    if (filter === "mine") return a === summary?.me;
    if (filter === "others") return Boolean(a) && a !== summary?.me;
    return !a;
  },

  // 1.2.2.7: "Strategic Accounts, Swiss Accounts" - the account's groups by name (null without groups).
  groupNames(key) {
    if (!membership || !summary?.groupsOn) return null;
    return (summary.g?.[key] || ["other"]).map((g) => (g === "other" ? "Other" : groupRows[g]?.name || g)).join(", ");
  },

  // 1.2.3 step 1 (D10): Reassign to… offers only members with access - the Team Lead, the deputy, or a member of one of
  // the account's groups (a member in no group is in Other). Without groups everyone has access (R9.1).
  mayAccess(member, key) {
    if (!membership || !summary?.groupsOn) return true;
    if (member === summary.lead || member === summary.deputy) return true;
    const mine = summary.ofMember?.[member] || ["other"];
    return (summary.g?.[key] || ["other"]).some((g) => mine.includes(g));
  },

  // 1.2.3 step 2 (design 6): the view filter. An account in none of my groups, and a lead of one, are not shown.
  groupsOn: () => Boolean(membership && summary?.groupsOn),
  canSee: (key) => canSeeAccount(membership, summary, key),
  canSeeLead: (lead) => canSeeLead(membership, summary, lead, lead?.company ? normalizeCompanyName(lead.company) : ""),

  // Design 7 (Boaz, 2026-10-10): one Group dropdown above each table, so a member can work one group at a time.
  // A member is offered "All my groups" and the groups the Team Lead put them in; the Team Lead and the deputy
  // "All accounts", every group and Other. Hidden without groups, and for a member in a single group (nothing to
  // choose). The choice is remembered per page. Returns { paint(), value(), matches(key), matchesLead(lead) }.
  groupPicker(selectEl, storageKey, onPick) {
    let stored = "";
    try { stored = localStorage.getItem(storageKey) || ""; } catch { /* remembered for this visit only */ }
    let painted = null;
    const options = () => {
      if (!membership || !summary?.groupsOn) return [];
      const ids = this.hasLeadRights()
        ? [...Object.keys(groupRows).filter((id) => isLiveGroup(id, groupRows[id])), "other"]
        : (summary.myGroups?.length ? summary.myGroups : ["other"]);
      return ids.map((id) => ({ id, name: id === "other" ? "Other" : groupRows[id]?.name || id }))
        .sort((a, b) => (a.id === "other") - (b.id === "other") || a.name.localeCompare(b.name));
    };
    // The stored choice survives a moment without the summary (page start) and a group I am taken out of and put back.
    const value = () => {
      const opts = options();
      return opts.length >= 2 && opts.some((o) => o.id === stored) ? stored : "";
    };
    const picker = {
      value,
      matches: (key) => { const v = value(); return !v || (summary?.g?.[key] || ["other"]).includes(v); },
      // A lead of a company that is no account is in no group: shown under "All" only.
      matchesLead(lead) {
        const v = value();
        if (!v) return true;
        const key = lead?.company ? normalizeCompanyName(lead.company) : "";
        return Boolean(key && summary?.g?.[key]) && summary.g[key].includes(v);
      },
      paint: () => {
        if (!selectEl) return;
        const opts = options();
        selectEl.hidden = opts.length < 2;
        const all = this.hasLeadRights() ? "All accounts" : "All my groups";
        const signature = JSON.stringify([all, opts]);
        if (signature !== painted) {
          painted = signature;
          selectEl.innerHTML = "";
          for (const o of [{ id: "", name: all }, ...opts]) {
            const el = document.createElement("option");
            el.value = o.id;
            el.textContent = o.name;
            selectEl.appendChild(el);
          }
        }
        selectEl.value = value();
      },
    };
    selectEl?.addEventListener("change", () => {
      stored = selectEl.value;
      try { localStorage.setItem(storageKey, stored); } catch { /* remembered for this visit only */ }
      onPick();
    });
    return picker;
  },

  onChange(fn) { listeners.add(fn); },
};
