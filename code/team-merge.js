// Team use 1.2.2, build step 1 (TEAM_USE_DESIGN.md sections 3.2, 4, 6, 7): the merge engine.
// PURE - no chrome.*, no DOM, no clock of its own (callers pass `now`) - so test_pure_modules.py runs it for real.
//
// Every member's SalesTeam writes change records into its own files in the team folder; every member reads
// everyone's records and folds them into one state with applyChange(). The one property everything rests on:
// the SAME set of records gives the SAME state on every PC, whatever order they arrive in and however often
// one is read again. Each rule below keeps that property: values are last-writer-wins by stamp, deletes and
// claims keep maxima/minima, and nothing depends on arrival order.
//
// 1.2.3 (TEAM_ADVANCED_MODE_DESIGN.md 3.1, 4.2): group rows (teamGroups:*) count only if their author had the Team
// Lead's rights at their stamp. Who that was depends on the team|lead/deputy/takeover records, which may arrive
// after the group records they decide - so group records are KEPT (state.gated) and their rows rebuilt from the
// valid ones whenever either side changes. That keeps the merge order-free.

import { teamLeadOf, leadRightsAt } from "./team-groups.js";

// --------------------------------------------------------------------------
// Stamps - a hybrid logical clock
// --------------------------------------------------------------------------
// A stamp is "<wall ms, 13 digits>-<counter, 4 digits>-<member id>", so plain string comparison orders it:
// first by time, then by counter (several changes in one millisecond), then by member (two members in the
// same millisecond - a fixed, arbitrary but identical tie-break on every PC). The clock never goes backwards
// on one PC, and after reading a colleague's later stamp it moves past it, so a change made after seeing
// another change is always ordered after it even when the two PCs' clocks differ by a few seconds.

const WALL_DIGITS = 13;
const COUNTER_DIGITS = 4;
const MAX_COUNTER = 9999;

export function formatStamp(wall, counter, member) {
  return `${String(wall).padStart(WALL_DIGITS, "0")}-${String(counter).padStart(COUNTER_DIGITS, "0")}-${member}`;
}

export function parseStamp(stamp) {
  const m = /^(\d{13})-(\d{4})-(.+)$/.exec(String(stamp || ""));
  if (!m) return null;
  return { wall: Number(m[1]), counter: Number(m[2]), member: m[3] };
}

export const stampWall = (stamp) => parseStamp(stamp)?.wall ?? 0;
export const stampMember = (stamp) => parseStamp(stamp)?.member ?? null;
export const compareStamps = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

export function createClock(member, last = null) {
  const p = parseStamp(last);
  return { member, wall: p ? p.wall : 0, counter: p ? p.counter : 0 };
}

// The next stamp for a change made now. Returns the stamp; the clock object is advanced in place.
export function tick(clock, now) {
  if (now > clock.wall) {
    clock.wall = now;
    clock.counter = 0;
  } else {
    clock.counter += 1;
    // More than 9999 changes in one millisecond (a team's base: every row at once) - borrow the next
    // millisecond, so the counter keeps its 4 digits and the stamp still sorts after the previous one.
    if (clock.counter > MAX_COUNTER) {
      clock.wall += 1;
      clock.counter = 0;
    }
  }
  return formatStamp(clock.wall, clock.counter, clock.member);
}

// After reading a colleague's stamp: make sure our next stamp sorts after it.
export function observe(clock, stamp) {
  const p = parseStamp(stamp);
  if (!p) return;
  if (p.wall > clock.wall || (p.wall === clock.wall && p.counter > clock.counter)) {
    clock.wall = p.wall;
    clock.counter = p.counter;
  }
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
// state.entities[e][id] = {
//   f:    { field: { v, t } }          winning value and stamp per field
//   del:  stamp | null                 latest delete
//   act:  { member: stamp }            latest change of any kind per member on this entity (claim expiry)
//   cl:   { member: [stamps] }         claim stamps per member;   rl: { member: stamp } latest release
//   as:   { member: [stamps] }         assignment stamps per assignee; ua: { member: stamp } latest unassign
//   tc:   { stamp: { member, note } }  outreach touches (a set, keyed by stamp)
// }
// state.lost = { "<e>|<id>|<field>|<stamp>": { e, id, field, v, t, by } }  values overwritten by a later one
// state.seen = { "<stamp>|<e>|<id>": true }   records already applied (re-reading a file changes nothing)
// 1.2.3:
// state.gated    = { id: { stamp: record } }   every group record; its row holds only the valid ones (rebuildGated)
// state.teamRecs = { stamp: { id, member } }  the Team Lead chain: lead / deputy / takeover records
// state.days     = { member: { day: 1 } }      days a member wrote anything - a take-over needs the lead quiet (D13)
// state.creator  = member | null              the team's creator (admins/ in the folder), the chain's start

export const ENTITY_TYPES = ["account", "contact", "lead", "setting", "team"];
export const OPS = ["set", "delete", "claim", "release", "assign", "unassign", "touch"];

export function newState() {
  return { entities: {}, lost: {}, seen: {}, gated: {}, teamRecs: {}, days: {}, creator: null };
}

// Rows only the Team Lead (or the deputy) may write (design 4.2). Setup and rules keep their screen lock (D2).
export const GATED_PREFIXES = ["teamGroups:"];
export const isGatedRow = (e, id) => e === "setting" && GATED_PREFIXES.some((p) => String(id).startsWith(p));
export const TEAM_RECORD_IDS = ["lead", "deputy", "takeover"];
const MERGE_DAY_MS = 24 * 3600 * 1000;

function noteDay(state, stamp) {
  const p = parseStamp(stamp);
  if (p) (state.days[p.member] || (state.days[p.member] = {}))[Math.floor(p.wall / MERGE_DAY_MS)] = 1;
}

// A state saved before 1.2.3 has none of the new parts. Its days come from the records already applied (seen).
function ensureTeamParts(state) {
  if (!state.gated) state.gated = {};
  if (!state.teamRecs) state.teamRecs = {};
  if (state.creator === undefined) state.creator = null;
  if (!state.days) {
    state.days = {};
    for (const k of Object.keys(state.seen || {})) noteDay(state, k.split("|")[0]);
  }
}

function record(state, e, id) {
  const byType = state.entities[e] || (state.entities[e] = {});
  return byType[id] || (byType[id] = { f: {}, del: null, act: {}, cl: {}, rl: {}, as: {}, ua: {}, tc: {} });
}

function maxStamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function addStamp(list, stamp) {
  if (list.includes(stamp)) return list;
  return [...list, stamp].sort();
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A change record: { t, e, id, op, f?, member?, note? }. Returns false for a record that is malformed or
// already applied, true otherwise. Never throws on bad input - a half-written file must not stop a merge.
export function applyChange(state, ch) {
  if (!ch || typeof ch !== "object") return false;
  const { t, e, id, op } = ch;
  const author = stampMember(t);
  if (!author || !ENTITY_TYPES.includes(e) || id == null || id === "" || !OPS.includes(op)) return false;
  const seenKey = `${t}|${e}|${id}`;
  if (state.seen[seenKey]) return false;
  state.seen[seenKey] = true;

  ensureTeamParts(state);
  noteDay(state, t);
  if (isGatedRow(e, id)) {
    const byStamp = state.gated[String(id)] || (state.gated[String(id)] = {});
    byStamp[t] = ch;
    rebuildGated(state, String(id));
    return true;
  }
  applyOp(state, ch, author);
  if (e === "team" && TEAM_RECORD_IDS.includes(String(id)) && op === "set") {
    state.teamRecs[t] = { id: String(id), member: ch.f?.member ?? null };
    rebuildGated(state);
  }
  return true;
}

function applyOp(state, ch, author) {
  const { t, e, id, op } = ch;
  const rec = record(state, e, String(id));
  rec.act[author] = maxStamp(rec.act[author], t);

  switch (op) {
    case "set": {
      for (const [field, v] of Object.entries(ch.f || {})) {
        const cur = rec.f[field];
        if (!cur) {
          rec.f[field] = { v, t };
          continue;
        }
        if (cur.t === t) continue;
        const [winner, loser] = t > cur.t ? [{ v, t }, cur] : [cur, { v, t }];
        rec.f[field] = winner;
        if (!sameValue(winner.v, loser.v)) {
          state.lost[`${e}|${id}|${field}|${loser.t}`] = { e, id: String(id), field, v: loser.v, t: loser.t };
        }
      }
      break;
    }
    case "delete":
      rec.del = maxStamp(rec.del, t);
      break;
    case "claim":
      rec.cl[author] = addStamp(rec.cl[author] || [], t);
      break;
    case "release":
      rec.rl[author] = maxStamp(rec.rl[author], t);
      break;
    case "assign": {
      // An admin can assign to someone else (ch.member); by default the author assigns to themselves.
      const to = ch.member || author;
      rec.as[to] = addStamp(rec.as[to] || [], t);
      break;
    }
    case "unassign": {
      const from = ch.member || author;
      rec.ua[from] = maxStamp(rec.ua[from], t);
      break;
    }
    case "touch":
      rec.tc[t] = { member: author, note: ch.note ?? null };
      break;
  }
}

// --------------------------------------------------------------------------
// The Team Lead and the gated (group) rows - 1.2.3
// --------------------------------------------------------------------------

export function leadChain(state) {
  ensureTeamParts(state);
  const records = Object.entries(state.teamRecs).map(([t, r]) => ({ t, id: r.id, member: r.member }));
  const activeWithin = (member, from, to) => {
    const days = state.days[member] || {};
    for (let d = Math.floor(from / MERGE_DAY_MS); d <= Math.floor(to / MERGE_DAY_MS); d++) if (days[d]) return true;
    return false;
  };
  return teamLeadOf(state.creator, records, { activeWithin });
}

// The creator is read from the folder (admins/<member>.json). Returns true when it changed (the rows are rebuilt).
export function setTeamCreator(state, member) {
  ensureTeamParts(state);
  if ((member || null) === state.creator) return false;
  state.creator = member || null;
  rebuildGated(state);
  return true;
}

// A gated row is rebuilt from scratch out of the records whose author had the Team Lead's rights at their stamp.
// Without a known creator nobody has them (yet), so nothing counts until the first folder read.
function rebuildGated(state, onlyId = null) {
  const chain = leadChain(state);
  for (const id of onlyId ? [onlyId] : Object.keys(state.gated)) {
    if (state.entities.setting) delete state.entities.setting[id];
    const prefix = `setting|${id}|`;
    for (const k of Object.keys(state.lost)) if (k.startsWith(prefix)) delete state.lost[k];
    const recs = Object.values(state.gated[id] || {}).sort((a, b) => compareStamps(a.t, b.t));
    for (const r of recs) {
      const author = stampMember(r.t);
      if (leadRightsAt(chain, author, r.t)) applyOp(state, r, author);
    }
  }
}

// Group records ignored because their author was not Team Lead (or deputy) then - for the team log (4.2).
export function ignoredGated(state) {
  ensureTeamParts(state);
  const chain = leadChain(state);
  const out = [];
  for (const byStamp of Object.values(state.gated)) {
    for (const r of Object.values(byStamp)) if (!leadRightsAt(chain, stampMember(r.t), r.t)) out.push(r);
  }
  return out.sort((a, b) => compareStamps(a.t, b.t));
}

export function applyChanges(state, changes) {
  let applied = 0;
  for (const ch of changes || []) if (applyChange(state, ch)) applied += 1;
  return applied;
}

// --------------------------------------------------------------------------
// Reading the state
// --------------------------------------------------------------------------

export function getRecord(state, e, id) {
  return state.entities[e]?.[String(id)] || null;
}

// What an entity looks like after the merge. A delete wins over earlier changes and loses to later ones:
// any field set after the delete revives the row (design 4.2 - the safer side for sales data).
export function entityView(state, e, id) {
  const rec = getRecord(state, e, id);
  if (!rec) return null;
  const values = {};
  const changedBy = {};
  let last = null;
  let revived = false;
  // Sorted, so the view is identical on every PC regardless of the order the fields first arrived in.
  for (const field of Object.keys(rec.f).sort()) {
    const { v, t } = rec.f[field];
    values[field] = v;
    changedBy[field] = { member: stampMember(t), at: stampWall(t) };
    last = maxStamp(last, t);
    if (rec.del && t > rec.del) revived = true;
  }
  const exists = !rec.del || revived;
  if (rec.del) last = maxStamp(last, rec.del);
  return {
    exists,
    values,
    changedBy,
    lastChanged: last ? { member: stampMember(last), at: stampWall(last) } : null,
  };
}

// Overwritten values (R3.11 - nothing disappears silently), oldest first.
export function lostValues(state, { e = null, id = null } = {}) {
  // `by` is the field's CURRENT winner, looked up now - which value happened to overwrite it first depends on
  // arrival order, so it is never stored.
  return Object.values(state.lost)
    .filter((x) => (e == null || x.e === e) && (id == null || x.id === String(id)))
    .map((x) => ({ ...x, by: getRecord(state, x.e, x.id)?.f[x.field]?.t ?? null }))
    .sort((a, b) => compareStamps(a.t, b.t) || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}

export function touches(state, e, id) {
  const rec = getRecord(state, e, id);
  if (!rec) return [];
  return Object.entries(rec.tc)
    .map(([t, x]) => ({ member: x.member, at: stampWall(t), note: x.note, t }))
    .sort((a, b) => compareStamps(a.t, b.t));
}

// --------------------------------------------------------------------------
// Claims (design section 6)
// --------------------------------------------------------------------------
// A member's claim is active from the FIRST claim stamp after their latest release, and ends when:
// - they release it, or
// - they have done nothing on the entity for `idleMs` (5 min), or
// - their heartbeat is older than `idleMs` (browser closed, PC asleep).
// Among active claims the EARLIEST start wins (ties by member, via the stamp). Same files -> same winner.

export const DEFAULT_CLAIM_IDLE_MS = 5 * 60 * 1000;

function activeStart(stamps, releasedAt) {
  for (const s of stamps || []) if (!releasedAt || s > releasedAt) return s;
  return null;
}

// lastSeen: { member: wall ms of their latest heartbeat or file }. A member missing from it counts as unseen.
export function activeClaims(state, e, id, { now, lastSeen = {}, idleMs = DEFAULT_CLAIM_IDLE_MS } = {}) {
  const rec = getRecord(state, e, id);
  if (!rec) return [];
  const out = [];
  for (const [member, stamps] of Object.entries(rec.cl)) {
    const start = activeStart(stamps, rec.rl[member]);
    if (!start) continue;
    const lastAct = stampWall(rec.act[member]);
    const seen = lastSeen[member] ?? 0;
    if (now - lastAct > idleMs) continue;
    if (now - seen > idleMs) continue;
    out.push({ member, since: start, sinceWall: stampWall(start) });
  }
  return out.sort((a, b) => compareStamps(a.since, b.since));
}

export function claimHolder(state, e, id, opts) {
  return activeClaims(state, e, id, opts)[0] || null;
}

// Design 6.3: a claim made at `claimStamp` is confirmed once, for every OTHER active member, something they
// wrote after the claim's time has been read - anything they claimed earlier was written before that and so
// has been seen already. readUpTo: { member: wall ms of the newest file read from them }.
export function isClaimConfirmed(claimStamp, { me, activeMembers = [], readUpTo = {} }) {
  const at = stampWall(claimStamp);
  return activeMembers.filter((m) => m !== me).every((m) => (readUpTo[m] ?? 0) > at);
}

// --------------------------------------------------------------------------
// Held edits of a lost claim (design 6.3, step 4): taken back out of the state
// --------------------------------------------------------------------------
// A member's edits on an account whose claim is still being checked are applied to its own state (so its screen
// shows them) but not sent. If the claim is lost, they are retracted: every field they won goes back to the best
// other value known - what it was before they were held (`prior`) or a colleague's value they overwrote, whichever
// is later. Nothing else is touched, so a colleague's later change stays exactly as it is.

// What a record is about to overwrite: { f: { field: {v, t} | null }, del }. Taken before the record is applied.
export function priorOf(state, ch) {
  const rec = getRecord(state, ch?.e, ch?.id);
  const f = {};
  for (const field of Object.keys(ch?.f || {})) f[field] = rec?.f[field] ? { ...rec.f[field] } : null;
  return { f, del: rec?.del ?? null };
}

// prior: { "<e>|<id>": priorOf(...) of the FIRST held record on that row }.
export function retractChanges(state, records, prior = {}) {
  const stamps = new Set((records || []).map((r) => r && r.t));
  for (const r of records || []) {
    if (!r || !r.t) continue;
    delete state.seen[`${r.t}|${r.e}|${r.id}`];
    const rec = getRecord(state, r.e, r.id);
    if (!rec) continue;
    const before = prior[`${r.e}|${r.id}`] || { f: {}, del: null };
    if (r.op === "set") {
      for (const field of Object.keys(r.f || {})) {
        const prefix = `${r.e}|${r.id}|${field}|`;
        const lostKeys = Object.keys(state.lost).filter((k) => k.startsWith(prefix));
        for (const k of lostKeys) if (stamps.has(state.lost[k].t)) delete state.lost[k];
        if (!rec.f[field] || !stamps.has(rec.f[field].t)) continue;
        let best = before.f[field] && !stamps.has(before.f[field].t) ? before.f[field] : null;
        for (const k of lostKeys) {
          const x = state.lost[k];
          if (x && (!best || x.t > best.t)) best = { v: x.v, t: x.t };
        }
        if (best) {
          rec.f[field] = { v: best.v, t: best.t };
          delete state.lost[prefix + best.t];
        } else {
          delete rec.f[field];
        }
      }
    } else if (r.op === "delete" && rec.del === r.t) {
      rec.del = before.del && !stamps.has(before.del) ? before.del : null;
    }
  }
}

// --------------------------------------------------------------------------
// Assignments (design section 7) - a claim that does not expire
// --------------------------------------------------------------------------
// Assigned from the first assign stamp after the latest unassign of that member; the earliest active
// assignment wins (two members assigning within seconds: the earlier keeps it).

export function assignee(state, e, id) {
  return activeAssignments(state, e, id)[0] || null;
}

// Every active assignment, earliest first: [{ member, since, sinceWall }]. Only the first counts; a later one is a
// member who lost a race and has not withdrawn yet (team-sync withdraws it).
export function activeAssignments(state, e, id) {
  const rec = getRecord(state, e, id);
  if (!rec) return [];
  const out = [];
  for (const [member, stamps] of Object.entries(rec.as)) {
    const start = activeStart(stamps, rec.ua[member]);
    if (start) out.push({ member, since: start, sinceWall: stampWall(start) });
  }
  return out.sort((a, b) => compareStamps(a.since, b.since));
}

// --------------------------------------------------------------------------
// Compaction (design 3.3) - one member's own records, shortened for a snapshot
// --------------------------------------------------------------------------
// A field set several times keeps only its latest value - on the record that set it, with that record's
// stamp, so a reader that already applied the original record skips the shortened one (same seen key) and a
// reader that did not gets exactly the winning values. Every other op is kept as it is.

// 1.2.3: the Team Lead chain and group records are kept whole - which of them counts depends on who was Team Lead
// at each stamp, so an earlier one is never "superseded". And each day keeps at least one record (a shortened
// one with no fields if need be): a take-over (D13) asks whether the Team Lead wrote anything in the last 30 days,
// and that answer must not depend on whether a PC read the original files or the snapshot.
const keptWhole = (ch) => ch.e === "team" || isGatedRow(ch.e, ch.id);

export function compactChanges(records) {
  const latest = {};
  for (const ch of records || []) {
    if (!ch || ch.op !== "set" || !ch.t || keptWhole(ch)) continue;
    for (const field of Object.keys(ch.f || {})) {
      const k = `${ch.e}|${ch.id}|${field}`;
      if (!latest[k] || ch.t > latest[k]) latest[k] = ch.t;
    }
  }
  const out = [];
  const dropped = [];
  const kept = new Set();
  for (const ch of records || []) {
    if (!ch || !ch.t) continue;
    const seenKey = `${ch.t}|${ch.e}|${ch.id}`;
    if (kept.has(seenKey)) continue;
    kept.add(seenKey);
    if (ch.op !== "set" || keptWhole(ch)) {
      out.push(ch);
      continue;
    }
    const f = {};
    for (const [field, v] of Object.entries(ch.f || {})) if (latest[`${ch.e}|${ch.id}|${field}`] === ch.t) f[field] = v;
    if (Object.keys(f).length) out.push({ ...ch, f });
    else dropped.push(ch);
  }
  const dayOf = (ch) => Math.floor(stampWall(ch.t) / MERGE_DAY_MS);
  const days = new Set(out.map(dayOf));
  for (const ch of dropped) {
    if (days.has(dayOf(ch))) continue;
    days.add(dayOf(ch));
    out.push({ ...ch, f: {} });
  }
  return out.sort((a, b) => compareStamps(a.t, b.t));
}

// --------------------------------------------------------------------------
// The pipeline's share of unassigned accounts (design 6.5) - rendezvous hashing
// --------------------------------------------------------------------------
// Each account goes to the member for whom hash(member|account) is highest. When a member joins or leaves,
// only the accounts that member wins (or won) move; everyone else's share stays put.

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // murmur3's finaliser. Without it, FNV-1a orders two members almost the same way for every account: real ids
  // made in the same session (same "...osg" time suffix) split 40 accounts 40:0 (step 4 test).
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function pipelineOwner(accountId, members) {
  let best = null;
  let bestScore = -1;
  for (const m of [...(members || [])].sort()) {
    const score = fnv1a(`${m}|${accountId}`);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}
