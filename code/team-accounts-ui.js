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
//   teamAccounts.onChange(fn)

import { summaryOffLimits } from "./team-claims.js";
import { leadRightsOf, isTeamLeadOf } from "./team-groups.js";

const KEY = "teamAccountStates"; // team-sync.js TEAM_ACCOUNTS_KEY
const MEMBERSHIP_KEY = "teamMembership";

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
  if (area !== "local" || (!changes[KEY] && !changes[MEMBERSHIP_KEY])) return;
  if (changes[KEY]) summary = changes[KEY].newValue || null;
  if (changes[MEMBERSHIP_KEY]) membership = changes[MEMBERSHIP_KEY].newValue || null;
  for (const fn of listeners) { try { fn(); } catch { /* one page's redraw must not stop another's */ } }
});

const nameOf = (m) => (m === summary?.me ? "you" : summary?.names?.[m] || "a colleague");

export const teamAccounts = {
  ready() {
    if (!loaded) {
      loaded = chrome.storage.local.get([KEY, MEMBERSHIP_KEY]).then((d) => {
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

  onChange(fn) { listeners.add(fn); },
};
