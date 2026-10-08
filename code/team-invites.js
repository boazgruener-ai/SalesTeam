// Team advanced mode 1.2.3, build step 1b (TEAM_ADVANCED_MODE_DESIGN.md 10a, D17-D19): invitations. PURE - no chrome.*,
// no DOM - so test_pure_modules.py runs it for real.
//
// The Team Lead (or the deputy) writes invites/<id>.json into the team folder: { id, teamId, name, email, by, byName,
// at, status: "open" }. The colleague's PC joins with it and writes it back as accepted (acceptedBy, acceptedAt); the
// Team Lead can cancel an open one (cancelledBy, cancelledAt) - marked, never deleted, so a late join is refused.
// Nobody joins without an open invitation (D17).

export const INVITES_DIR = "invites";
export const TEAM_FOLDER_PREFIX = "SalesTeam - ";

export function inviteState(inv) {
  if (!inv) return "missing";
  if (inv.status === "cancelled") return "cancelled";
  if (inv.status === "accepted" || inv.acceptedBy) return "accepted";
  return "open";
}

// Open invitations, oldest first.
export function openInvites(invites) {
  return Object.values(invites || {}).filter((i) => i && inviteState(i) === "open")
    .sort((a, b) => (a.at || 0) - (b.at || 0) || String(a.name).localeCompare(String(b.name)));
}

// "Annick  Zütter " and "annick zutter" are the same person's name. The common accented letters are folded by table,
// so the result does not depend on the engine's Unicode data (the test harness's V8 has none).
const FOLD = { à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", ç: "c", è: "e", é: "e", ê: "e", ë: "e", ì: "i", í: "i", î: "i", ï: "i",
  ñ: "n", ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", ù: "u", ú: "u", û: "u", ü: "u", ý: "y", ÿ: "y" };
export function personKey(s) {
  return String(s || "").toLowerCase().replace(/[à-ÿ]/g, (c) => FOLD[c] || c).normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim();
}

// The invitation is for this person: the User Profile's name or e-mail is the invitation's.
export function inviteMatches(inv, profile) {
  if (!inv || !profile) return false;
  const name = personKey(profile.name);
  const email = personKey(profile.email);
  return Boolean((name && personKey(inv.name) === name) || (email && personKey(inv.email) === email));
}

// Why this invitation cannot be used to join (null = it can). `memberId`: the PC that tries.
export function inviteRefusal(inv, { teamId = null, memberId = null } = {}) {
  const state = inviteState(inv);
  if (state === "missing" || (teamId && inv.teamId && inv.teamId !== teamId)) {
    return "There is no invitation for you in this team. Ask the Team Lead to add you (Settings > Team > Add member…).";
  }
  if (state === "cancelled") return `The Team Lead cancelled this invitation${inv.cancelledByName ? ` (${inv.cancelledByName})` : ""}. Ask for a new one (Settings > Team > Add member…).`;
  if (state === "accepted" && inv.acceptedBy !== memberId) return "This invitation has just been used on another PC.";
  return null;
}

// The folder SalesTeam creates in OneDrive for a new team (D18): characters Windows does not allow in a name are
// dropped, as are trailing dots and spaces.
export function teamFolderName(teamName) {
  const clean = String(teamName || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return `${TEAM_FOLDER_PREFIX}${clean || "Team"}`;
}
