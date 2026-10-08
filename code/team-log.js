// Team use 1.2.2, build step 6 (TEAM_USE_DESIGN.md 4.3, R3.11): the team log in the Activity Log page - who changed
// what, and when, across the team. PURE - no chrome.*, no DOM - so test_pure_modules.py runs it for real.
//
// Built from the change records themselves (the ones written to and read from the team folder), not a second log
// kept beside them. One change file holds one record per changed row, so the records of one member, one kind of
// change and one account (or lead / setting) in a batch become ONE line: "Anna changed UBS: status, notes (3 rows)".
// Claims and their releases are left out - a page renews its claim every minute while someone works, which would
// drown everything else; what the claim was for shows up as the changes it made.

import { stampWall, stampMember } from "./team-merge.js";
import { accountKeyOfChange } from "./team-claims.js";

export const TEAM_LOG_KEPT = 3000;
export const TEAM_LOG_DAYS = 90;
const SKIPPED_OPS = new Set(["claim", "release"]);
const INTERNAL_FIELD = (f) => f.startsWith("$");

const leadLabel = (state, id) => {
  const f = state?.entities?.lead?.[id]?.f;
  const author = f?.author?.v;
  return typeof author === "string" && author ? author : null;
};

// What a record is about: { kind, key, ref } - key = the account's company key (accounts and contacts), ref = the
// row id for leads and settings.
function subjectOf(state, r, normalize) {
  const id = String(r.id);
  if (r.e === "account" && id.startsWith("@")) return { kind: "account", key: id.slice(1), ref: null };
  if (r.e === "account" || r.e === "contact") {
    const key = accountKeyOfChange(state, r, normalize);
    if (key) return { kind: r.e, key, ref: null };
    return { kind: r.e, key: null, ref: id };
  }
  if (r.e === "lead") return { kind: "lead", key: null, ref: id };
  // 1.2.3: the Team Lead chain (team|lead, team|deputy, team|takeover).
  if (r.e === "team") return { kind: "team", key: null, ref: id };
  return { kind: "setting", key: null, ref: id.replace(/:.*$/, "") || id };
}

// A value as the log shows it: short text (an unset field -> null).
const VALUE_MAX = 120;
export function logValue(v) {
  if (v === null || v === undefined || (typeof v === "object" && v.$unset)) return null;
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;
}

// records -> log entries, oldest first: { at, m, op, kind, key, ref, label, fields, rows, to, before, after }.
// `normalize` is storage.js normalizeCompanyName. `priors` (optional): Map record -> team-merge.js priorOf(state, record)
// taken BEFORE the record was applied - the previous values (live test 1.2.1.11: the Previous / New Value columns
// were empty). before/after: { field: shown value }, the first previous and the last new value of each field.
export function teamLogEntries(records, state, normalize, priors = null) {
  const groups = new Map();
  for (const r of records || []) {
    if (!r || SKIPPED_OPS.has(r.op)) continue;
    const m = stampMember(r.t);
    const at = stampWall(r.t);
    if (!m || !at) continue;
    const s = subjectOf(state, r, normalize);
    const op = r.op === "touch" ? "touch" : r.op;
    const g = `${m}|${op}|${s.kind}|${s.key ?? ""}|${s.ref ?? ""}|${op === "assign" || op === "unassign" ? r.member || "" : ""}`;
    let entry = groups.get(g);
    if (!entry) {
      entry = { at, m, op, kind: s.kind, key: s.key, ref: s.ref, label: null, fields: [], rows: 0, before: {}, after: {} };
      if (op === "assign" || op === "unassign") entry.to = r.member || m;
      if (s.kind === "lead") entry.label = leadLabel(state, s.ref);
      if (s.kind === "team") entry.to = r.f?.member || r.f?.was || null;
      groups.set(g, entry);
    }
    entry.at = Math.max(entry.at, at);
    entry.rows += 1;
    if (op === "set" && r.f && typeof r.f === "object") {
      const prior = priors?.get(r) || null;
      for (const f of Object.keys(r.f)) {
        if (INTERNAL_FIELD(f)) continue;
        if (!entry.fields.includes(f)) {
          entry.fields.push(f);
          if (prior) entry.before[f] = logValue(prior.f?.[f]?.v);
        }
        entry.after[f] = logValue(r.f[f]);
      }
      // Remove / Restore (an account's or contact's deletedAt set or cleared) says so in words.
      if ("deletedAt" in r.f) entry.removed = Boolean(r.f.deletedAt) && !r.f.deletedAt.$unset;
    }
  }
  return [...groups.values()].sort((a, b) => a.at - b.at);
}

// The stored log with new entries added: newest last, at most TEAM_LOG_KEPT, none older than TEAM_LOG_DAYS.
export function appendTeamLog(log, entries, now) {
  const cutoff = now - TEAM_LOG_DAYS * 24 * 3600 * 1000;
  // 1.2.2.8: a record read a second time (the folder re-read after this PC's team state was lost) is logged once.
  const seen = new Set();
  const sig = (e) => JSON.stringify([e.at, e.m, e.op, e.kind, e.key, e.ref, e.fields, e.to]);
  return [...(Array.isArray(log) ? log : []), ...entries]
    .filter((e) => e && e.at >= cutoff && !seen.has(sig(e)) && seen.add(sig(e)))
    .sort((a, b) => a.at - b.at)
    .slice(-TEAM_LOG_KEPT);
}

// Field names as people read them (Boaz, live test: "manualStatus" should say Status). Anything not listed: the
// camelCase name in words ("nextActionDueAt" -> "Next action due at").
const FIELD_NAMES = {
  manualStatus: "Status", status: "Status", notes: "Notes", priorityTier: "Priority", aiPriority: "Priority",
  nextActionDueAt: "Follow-up date", deletedAt: "Removed", deletedBy: "Removed by", company: "Company name",
  linkedinLink: "LinkedIn link", linkedinCompanyId: "LinkedIn company id", fullName: "Name", title: "Title",
  contactedBy: "Contacted by", contactedAt: "Contacted on", overrides: "Edited fields", webResearch: "Web research",
  mentorHistory: "Sales Mentor conversation", customerVoiceHistory: "Customer Voice conversation", pipeline: "Preparation",
  lastVerified2: "Contact link", industry: "Industry", employees: "Employees",
};
export function fieldName(f) {
  if (FIELD_NAMES[f]) return FIELD_NAMES[f];
  const words = String(f).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : String(f);
}
// The fields a line shows: a "<field>At" time stamp that only goes with a field changed in the same line is left out
// (manualStatus + manualStatusAt -> Status).
export function shownFields(fields) {
  const all = fields || [];
  return all.filter((f) => !(/At$/.test(f) && all.includes(f.slice(0, -2))));
}

// One line for the Activity Log: "changed UBS: status, notes", "assigned UBS to Anna", ...
// `name(key)`: the account's display name; `who(member)`: a member's name.
export function teamLogText(entry, name, who) {
  const what = entry.key ? name(entry.key) : entry.kind === "lead" ? `the lead ${entry.label || entry.ref}` : entry.ref;
  const shown = shownFields(entry.fields).map(fieldName);
  const fields = shown.length ? `: ${shown.slice(0, 8).join(", ")}${shown.length > 8 ? ` +${shown.length - 8}` : ""}` : "";
  const part = entry.kind === "contact" ? (entry.rows > 1 ? ` (${entry.rows} contacts)` : " (a contact)") : "";
  // The join proposals' own bookkeeping (team-join.js): said in words, not as a setting's fields.
  if (entry.kind === "setting" && entry.ref === "teamJoinProposals") {
    const n = entry.rows > 1 ? `${entry.rows} join proposals` : "a join proposal";
    return entry.op === "delete" ? `settled ${n}` : `made ${n} (accounts they had worked on before joining)`;
  }
  if (entry.kind === "team") {
    if (entry.ref === "lead") return `made ${who(entry.to)} Team Lead`;
    if (entry.ref === "deputy") return entry.after?.member ? `made ${who(entry.to)} deputy Team Lead` : `ended ${entry.to ? `${who(entry.to)}'s` : "the"} deputy role`;
    if (entry.ref === "takeover") return "took over as Team Lead";
  }
  switch (entry.op) {
    case "assign": return entry.to === entry.m ? `assigned ${what} to themselves` : `assigned ${what} to ${who(entry.to)}`;
    case "unassign": return entry.to === entry.m ? `released ${what}` : `released ${what} from ${who(entry.to)}`;
    case "delete": return `deleted ${entry.kind === "setting" ? "the setting " : ""}${what}${part}`;
    case "touch": return `logged outreach on ${what}${part}`;
    case "remove_member": return `removed ${who(entry.to)} from the team`;
    default:
      if (entry.removed === true) return `removed ${what}${part}`;
      if (entry.removed === false && entry.fields.every((f) => f === "deletedAt" || f === "deletedBy")) return `restored ${what}${part}`;
      return entry.kind === "setting" ? `changed the setting ${what}${fields}` : `changed ${what}${part}${fields}`;
  }
}
