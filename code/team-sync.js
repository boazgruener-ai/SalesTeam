// Team use 1.2.2, build step 2 (TEAM_USE_DESIGN.md 5, 3.3, 6.3, 8): the sync layer, run by the background worker.
// Inert unless this browser is a team member (chrome.storage.local.teamMembership).
//
// Local -> team: chrome.storage.onChanged marks a shared key dirty; a second later the key's current value is
//   cut into rows (team-rows.js) and compared with the SHADOW - the last state the team is known to have. The
//   differing fields become stamped change records in the OUTBOX (IndexedDB, saved before anything else).
//   None of the ~170 writers in storage.js is touched.
// Folder: the outbox is written as one change file per flush (members/<me>/changes/c-<n>.json), read back, and
//   only then dropped. Colleagues' files are read in order, merged (team-merge.js) and the affected rows written
//   back into local storage inside withAccountWriteLock; the shadow already holds them, so they are not sent
//   back out (no echo). Pages redraw on their own onChanged listeners.
// Timers (design 8.1): flush within 5 s, read every 15 s, heartbeat every 60 s, compact once a day - driven by a
//   30 s alarm and, while the folder is usable, by in-worker timers. The folder is usable only while a SalesTeam
//   page or the side panel is open (step 0); otherwise changes wait in the outbox.

import { withAccountWriteLock, normalizeCompanyName, contactKeyFor, getAccountViews, SIZE_PRIORITY_BUCKETS } from "./storage.js";
import { TEAM_SHARED_KEYS, isTeamSharedKey } from "./team-keys.js";
import { extractRows, diffRows, staleFieldUnsets, projectRow, projectKey, patchValue, rowTarget, rowKey, splitRowKey, canonicalRow } from "./team-rows.js";
import {
  newState, applyChange, createClock, tick, observe, formatStamp, compactChanges, stampWall, priorOf, retractChanges,
  pipelineOwner, DEFAULT_CLAIM_IDLE_MS, activeAssignments, isClaimConfirmed, stampMember,
  leadChain, setTeamCreator, isGatedRow,
} from "./team-merge.js";
import { groupsOn, groupIndex, groupsOf, groupFacts, memberGroups, OTHER_GROUP } from "./team-groups.js";
import {
  claimIdFor, accountKeyOfChange, activeMembersOf, claimView, assignmentView, offLimitsFor, teamAccountSummary,
} from "./team-claims.js";
import {
  teamDbGetAll, teamDbPutAll, teamDbClear, getTeamFolder, clearTeamFolder, teamFolderPermission,
  readTeamJson, writeTeamJson, listTeamNames, removeTeamFile, listTeamFolderTop,
} from "./team-folder.js";
import { teamLogEntries, appendTeamLog } from "./team-log.js";
import { joinOverlap, addBackValues, joinProposals, JOIN_PROPOSALS_KEY } from "./team-join.js";
import { INVITES_DIR, inviteState, inviteRefusal } from "./team-invites.js";

export const TEAM_MEMBERSHIP_KEY = "teamMembership";
// Step 5: assignments and active claims of every account, for the pages' badges, filter and list checks
// (team-claims.js teamAccountSummary + who I am). Personal, rewritten only when it changes.
export const TEAM_ACCOUNTS_KEY = "teamAccountStates";
// Step 5b (Boaz): "the Team Lead reassigned / released your account" - shown in the top bar until OK. Personal.
export const TEAM_NOTICES_KEY = "teamNotices";
// Step 6 (R3.11, design 4.3): the team log shown in the Activity Log - built from the change records written and read
// (team-log.js). Personal (each PC keeps what it has seen), backup-excluded.
export const TEAM_LOG_KEY = "teamLog";
// 1.2.3 step 1 (D16): "Boaz closed the team" - set on a member's PC when it stops sharing because the Team Lead closed
// the team, shown in the top bar until OK. Personal; cleared when this PC creates or joins a team.
export const TEAM_CLOSED_NOTICE_KEY = "teamClosedNotice";
const FORMAT = 1;
const ALARM = "team-sync";
const DIFF_DEBOUNCE_MS = 1000;
const FLUSH_DELAY_MS = 5000;
const READ_EVERY_MS = 15000;
const HEARTBEAT_EVERY_MS = 60000;
const KEEP_CHANGE_FILES_MS = 7 * 24 * 3600 * 1000;
const MAX_RECORDS_PER_FILE = 5000;
const MAX_FILES_PER_ROUND = 300;
const CLOBBER_WINDOW_MS = 15000;
const MEASURES_KEPT = 30;
const ONLINE_MS = 3 * 60000; // a colleague with a SalesTeam page open writes at least once a minute
// Step 4 (claims, design 6): colleagues seen in the last 10 minutes count (D5); while a claim of mine is being
// checked the folder is read every 5 s; a held claim is renewed at most once a minute; "not in sync" as team-ui.js.
const ACTIVE_MS = 10 * 60000;
const CLAIM_READ_EVERY_MS = 5000;
const CLAIM_REFRESH_MS = 60000;
const NOT_IN_SYNC_AFTER_MS = 2 * 60000;
const REREAD_VERSION = 1;

let membership = null;      // { memberId, name, teamId, teamName, role, joinedAt } or null
let membershipLoaded = false;
let mem = null;             // { state, shadow, outbox, inflight, meta } - loaded from IndexedDB once per worker life
let queue = Promise.resolve();
const dirty = new Set();
let diffTimer = null;
let tickTimer = null;
let ticking = false;
let lastError = null;
let folderState = "none";   // "none" | "granted" | "prompt" | "denied" | "error"
let lastOkAt = 0;           // last folder round that went through (step 3: "not in sync" is judged from it)
let errorSince = 0;         // first failed round since the last good one
let ackDue = false;         // a colleague's claim was just read: answer with a heartbeat at once (design 6.3)
// Rows this layer just wrote into local storage: { before, after, at }. A writer outside the account lock that
// read the map before our write and saved it after would put the OLD row back; seen within a few seconds, that
// is undone (the row is written again) instead of being sent to the team as a change.
const recentWriteBack = new Map();

function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

const errText = (err) => `${err?.name || "Error"}: ${err?.message || err}`;
const randomId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

async function loadMembership() {
  if (!membershipLoaded) {
    const data = await chrome.storage.local.get(TEAM_MEMBERSHIP_KEY);
    membership = data[TEAM_MEMBERSHIP_KEY] || null;
    membershipLoaded = true;
  }
  return membership;
}

// assigning: { key: { to, at } } - my assign records not yet confirmed; assignLost: { key: { to, winner, at } } - an
// assignment of mine that a colleague's earlier one beat (shown once on the account page, R6.1).
const emptyClaims = () => ({ mine: {}, held: {}, aside: {}, assigning: {}, assignLost: {} });

function emptyMeta() {
  return {
    nextN: 1, lastWrittenN: 0, clockLast: null, cursors: {}, lastFileWall: {}, hb: {}, profiles: {}, admins: [],
    basesApplied: [], ownFiles: [], snapN: 0, lastFlushAt: 0, lastReadAt: 0, lastHeartbeatAt: 0,
    lastCompactDay: null, measures: [],
  };
}

async function ensureLoaded() {
  if (mem) return mem;
  const got = await teamDbGetAll(["state", "shadow", "outbox", "inflight", "meta", "claims"]);
  mem = {
    state: got.state || newState(),
    shadow: got.shadow || {},
    outbox: got.outbox || [],
    inflight: got.inflight || null,
    meta: { ...emptyMeta(), ...(got.meta || {}) },
    // mine: { key: { kind, at, releaseWhenDone } } - my claims; held: { key: { records, prior } } - my edits waiting
    // for a claim to be confirmed; aside: { key: { records, at, lostTo } } - held edits of a lost claim (R3.3).
    claims: { ...emptyClaims(), ...(got.claims || {}) },
  };
  // No saved state (cleared, or lost): EVERY file is read again from the start - mine and my colleagues'. 1.2.2.8 (Boaz's
  // PC, 8 Oct): only my own files were re-read; the colleagues' cursors stayed, so their earlier records - among them
  // the Team Lead hand-backs - were gone from the state for good and this PC named a former member Team Lead.
  // REREAD_VERSION: the same full re-read once on every PC, to repair a state that lost records that way.
  if (!got.state || (mem.meta.rereadV || 0) < REREAD_VERSION) {
    mem.meta.selfCursor = 0;
    mem.meta.cursors = {};
    mem.meta.basesApplied = [];
    mem.meta.rereadV = REREAD_VERSION;
    // Re-reading the team's history from the start: what it holds already happened - no "made you Team Lead",
    // "reassigned your account" or "joined" from it (1.2.2.8 test: a backlog of years-old role changes in the top bar).
    mem.replaying = true;
  }
  mem.clock = createClock(membership?.memberId || "?", mem.meta.clockLast);
  return mem;
}

async function save(parts) {
  mem.meta.clockLast = formatStamp(mem.clock.wall, mem.clock.counter, mem.clock.member);
  const entries = {};
  for (const p of parts) entries[p] = mem[p];
  entries.meta = mem.meta;
  await teamDbPutAll(entries);
}

function measure(entry) {
  mem.meta.measures = [...(mem.meta.measures || []), { at: Date.now(), ...entry }].slice(-MEASURES_KEPT);
}

// --------------------------------------------------------------------------
// Local -> team
// --------------------------------------------------------------------------

// Compares one key's local value with the shadow; new records go into `out`. Rows a clobbering writer put back
// are collected in `rewrite` instead.
function diffKeyInto(key, value, out, rewrite) {
  const rows = extractRows(key, value);
  const shadowRows = mem.shadow[key] || {};
  const d = diffRows(shadowRows, rows);
  const now = Date.now();
  const newShadow = d.shadow;
  const guarded = (rk) => {
    const g = recentWriteBack.get(rk);
    if (!g || now - g.at > CLOBBER_WINDOW_MS) return false;
    const local = rows.has(rk) ? canonicalRow(rows.get(rk)) : null;
    if (local !== g.before) return false;
    rewrite.add(rk);
    if (g.after === null) delete newShadow[rk];
    else newShadow[rk] = g.after;
    return true;
  };
  for (const s of d.sets) {
    const rk = rowKey(s.e, s.id);
    if (guarded(rk)) continue;
    const f = s.isNew ? { ...staleFieldUnsets(mem.state, s.e, s.id, s.f), ...s.f } : s.f;
    out.push({ t: tick(mem.clock, now), e: s.e, id: s.id, op: "set", f });
  }
  for (const x of d.dels) {
    const rk = rowKey(x.e, x.id);
    if (guarded(rk)) continue;
    out.push({ t: tick(mem.clock, now), e: x.e, id: x.id, op: "delete" });
  }
  mem.shadow[key] = newShadow;
  return rows.size;
}

// Inside the queue. Returns the rows that must be written back (clobbered).
async function diffKeys(keys, values = null) {
  if (!keys.length) return new Set();
  const t0 = performance.now();
  if (!values) values = await chrome.storage.local.get(keys);
  const records = [];
  const rewrite = new Set();
  let rowCount = 0;
  for (const key of keys) rowCount += diffKeyInto(key, values[key], records, rewrite);
  if (records.length) holdOrSend(records);
  measure({ kind: "diff", keys: keys.join(","), rows: rowCount, records: records.length, ms: Math.round(performance.now() - t0) });
  await save(["state", "shadow", "outbox", "claims"]);
  if (records.length) scheduleTick(FLUSH_DELAY_MS);
  return rewrite;
}

function scheduleDiff() {
  if (diffTimer) return;
  diffTimer = setTimeout(() => {
    diffTimer = null;
    const keys = [...dirty];
    dirty.clear();
    enqueue(async () => {
      if (!(await loadMembership())) return;
      await ensureLoaded();
      const rewrite = await diffKeys(keys);
      if (rewrite.size) await writeBack(rewrite);
    }).catch((err) => { lastError = `diff: ${errText(err)}`; });
  }, DIFF_DEBOUNCE_MS);
}

// --------------------------------------------------------------------------
// Team -> local
// --------------------------------------------------------------------------

// Inside the queue. Writes the merged rows `rks` into local storage, under the account write lock.
async function writeBack(rks) {
  const byKey = new Map();
  for (const rk of rks) {
    const { e, id } = splitRowKey(rk);
    const target = rowTarget(e, id);
    if (!target) continue;
    if (!byKey.has(target.key)) byKey.set(target.key, new Set());
    byKey.get(target.key).add(rk);
  }
  if (!byKey.size) return;
  const keys = [...byKey.keys()];
  await withAccountWriteLock(async () => {
    const values = await chrome.storage.local.get(keys);
    // A local change not yet seen goes out first, so writing the merged rows cannot overwrite it.
    for (const rk of await diffKeys(keys, values)) {
      const { e, id } = splitRowKey(rk);
      byKey.get(rowTarget(e, id).key)?.add(rk);
    }
    const toSet = {};
    const toRemove = [];
    const now = Date.now();
    for (const [key, set] of byKey) {
      const localRows = extractRows(key, values[key]);
      const updates = new Map();
      for (const rk of set) {
        const { e, id } = splitRowKey(rk);
        const fields = projectRow(mem.state, e, id);
        updates.set(rk, fields);
        const before = localRows.has(rk) ? canonicalRow(localRows.get(rk)) : null;
        const after = fields ? canonicalRow(fields) : null;
        const shadowRows = mem.shadow[key] || (mem.shadow[key] = {});
        if (after === null) delete shadowRows[rk];
        else shadowRows[rk] = after;
        if (before !== after) recentWriteBack.set(rk, { before, after, at: now });
      }
      const next = patchValue(key, values[key], updates);
      if (next === undefined) toRemove.push(key);
      else toSet[key] = next;
    }
    await save(["shadow"]);
    if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  });
  for (const [rk, g] of recentWriteBack) if (Date.now() - g.at > CLOBBER_WINDOW_MS) recentWriteBack.delete(rk);
}

// Inside the queue. Records read from colleagues -> merged state -> local storage.
// The account's display name for a notice: the company name of one of its rows, else the key.
function accountDisplayName(key) {
  for (const [id, rec] of Object.entries(mem.state.entities.account || {})) {
    if (id.startsWith("@")) continue;
    const v = rec.f.company?.v;
    if (typeof v === "string" && normalizeCompanyName(v) === key) return v;
  }
  return key;
}

// The previous values of my own records, taken as they are made (holdOrSend), for the log line written when they go
// out (flush). In memory only: after a worker restart a line simply has no previous values.
const ownPriors = new Map(); // record -> priorOf
const OWN_PRIORS_MAX = 20000;
const priorsFor = (records) => new Map(records.map((r) => [r, priorOf(mem.state, r)]));

// Inside the queue. "Boaz removed Annick from the team" - not a change record (a file in removed/), so logged here.
async function logMemberRemoved(member, by, at) {
  const entry = { at, m: by, op: "remove_member", kind: "member", key: null, ref: member, fields: [], rows: 1, mn: memberName(by), to: member, tn: memberName(member) };
  const prev = (await chrome.storage.local.get(TEAM_LOG_KEY))[TEAM_LOG_KEY];
  await chrome.storage.local.set({ [TEAM_LOG_KEY]: appendTeamLog(prev, [entry], Date.now()) });
}

// Inside the queue. Adds the log lines for these records (a base file is the team's starting point, not a change).
async function recordTeamLog(records, priors = null) {
  if (!records.length || !membership) return;
  const entries = teamLogEntries(records, mem.state, normalizeCompanyName, priors);
  if (!entries.length) return;
  const names = new Map();
  for (const [id, rec] of Object.entries(mem.state.entities.account || {})) {
    if (id.startsWith("@")) continue;
    const v = rec.f.company?.v;
    if (typeof v === "string") { const k = normalizeCompanyName(v); if (k && !names.has(k)) names.set(k, v); }
  }
  for (const e of entries) {
    if (e.key) e.name = names.get(e.key) || e.key;
    e.mn = memberName(e.m);
    if (e.to) e.tn = memberName(e.to);
  }
  const prev = (await chrome.storage.local.get(TEAM_LOG_KEY))[TEAM_LOG_KEY];
  await chrome.storage.local.set({ [TEAM_LOG_KEY]: appendTeamLog(prev, entries, Date.now()) });
}

async function applyRemote(records) {
  const affected = new Set();
  // A colleague (the Team Lead) took one of my accounts away: remember whether it was mine before this batch.
  const me = membership?.memberId;
  const takenFrom = new Map(); // "@key" -> author
  const leadsBefore = leadNow();
  for (const r of records) {
    if (r.op !== "unassign" || r.e !== "account" || !String(r.id).startsWith("@")) continue;
    const author = stampMember(r.t);
    if (author === me || (r.member || author) !== me) continue;
    if (activeAssignments(mem.state, "account", r.id).some((a) => a.member === me)) takenFrom.set(r.id, author);
  }
  for (const r of records) {
    if (!applyChange(mem.state, r)) continue;
    observe(mem.clock, r.t);
    if (r.op === "claim" || r.op === "assign") ackDue = true;
    if (rowTarget(r.e, r.id)) affected.add(rowKey(r.e, r.id));
    // 1.2.3: a Team Lead record decides which group records count - every group row may have changed.
    if (r.e === "team") for (const rk of gatedRowKeys()) affected.add(rk);
  }
  await save(["state"]);
  if (affected.size) await writeBack(affected);
  await noteRoleChange(leadsBefore, records);
  if (takenFrom.size && !mem.replaying) {
    const now = Date.now();
    const added = [];
    for (const [id, author] of takenFrom) {
      const list = activeAssignments(mem.state, "account", id);
      if (list.some((a) => a.member === me)) continue; // given back meanwhile
      const key = id.slice(1);
      added.push({ key, name: accountDisplayName(key), by: memberName(author), to: list[0] ? memberName(list[0].member) : null, at: now });
    }
    if (added.length) {
      const prev = (await chrome.storage.local.get(TEAM_NOTICES_KEY))[TEAM_NOTICES_KEY] || [];
      await chrome.storage.local.set({ [TEAM_NOTICES_KEY]: [...prev, ...added].slice(-50) });
    }
  }
  return affected.size;
}

// 1.2.3 step 1 (design 3.3, 3.4): "Boaz made you Team Lead" / "… deputy" / "ended your deputy role" - in the top bar
// until OK, on the PC whose role changed. Compared before and after a batch, so a record read twice says nothing.
async function noteRoleChange(before, records) {
  if (mem.replaying) return;
  const me = membership?.memberId;
  const after = leadNow();
  if (!me || !before.known || !after.known) return;
  const teamRecs = records.filter((r) => r && r.e === "team").sort((a, b) => (a.t < b.t ? 1 : -1));
  if (!teamRecs.length) return;
  const by = memberName(stampMember(teamRecs[0].t));
  const texts = [];
  if (after.lead === me && before.lead !== me) texts.push(`${by} made you Team Lead. You see every account and edit the groups.`);
  else if (before.lead === me && after.lead !== me) texts.push(`${memberName(after.lead)} is Team Lead now. You are a Member.`);
  if (after.deputy === me && before.deputy !== me) texts.push(`${by} made you deputy Team Lead: you have the Team Lead's rights until ${by} ends it.`);
  else if (before.deputy === me && after.deputy !== me && after.lead !== me) texts.push(`${by} ended your deputy role. You are a Member again.`);
  if (!texts.length) return;
  const now = Date.now();
  const prev = (await chrome.storage.local.get(TEAM_NOTICES_KEY))[TEAM_NOTICES_KEY] || [];
  await chrome.storage.local.set({ [TEAM_NOTICES_KEY]: [...prev, ...texts.map((text) => ({ kind: "role", text, at: now }))].slice(-50) });
}

// 1.2.3 step 1b (10a.2): "Annick Zutter joined the team" - on the PCs with the Team Lead's rights, when an invitation
// this PC knew as open is read back as accepted.
async function noteInvitesAccepted(before) {
  if (mem.replaying || !hasLeadRights()) return;
  const texts = [];
  for (const [id, inv] of Object.entries(mem.meta.invites || {})) {
    if (inviteState(before[id]) !== "open" || inviteState(inv) !== "accepted") continue;
    texts.push(`${inv.name} joined the team. Add ${inv.name} to groups in Settings > Team (⋮ next to the name > Groups…).`);
  }
  if (!texts.length) return;
  const now = Date.now();
  const prev = (await chrome.storage.local.get(TEAM_NOTICES_KEY))[TEAM_NOTICES_KEY] || [];
  await chrome.storage.local.set({ [TEAM_NOTICES_KEY]: [...prev, ...texts.map((text) => ({ kind: "joined", text, at: now }))].slice(-50) });
}

// Outside the queue (file reading is slow). Reads base files and every colleague's new change files in order.
async function readFolder(root, me, { includeSelf = false } = {}) {
  const meta = mem.meta;
  const records = [];
  const update = { cursors: {}, lastFileWall: {}, hb: {}, profiles: {}, basesApplied: [], files: 0, bytes: 0, baseRecords: 0 };
  update.admins = (await listTeamNames(root, ["admins"], "file"))
    .map((n) => (/^(.+)\.json$/.exec(n) || [])[1]).filter(Boolean);
  // 1.2.3: the creator starts the Team Lead chain - read from team.json (createdBy), which names exactly one person;
  // admins/ may hold a leftover file from an earlier test team in the same folder.
  if (!meta.creator) {
    const tj = await readTeamJson(root, [], "team.json");
    if (tj.status === "ok" && tj.data.createdBy && (!membership?.teamId || tj.data.teamId === membership.teamId)) update.creator = tj.data.createdBy;
  }
  // D16: the Team Lead closed the team - closed.json at the top. Every PC stops sharing when it sees it.
  const closed = await readTeamJson(root, [], "closed.json");
  if (closed.status === "ok" && (!membership?.teamId || !closed.data.teamId || closed.data.teamId === membership.teamId)) update.closed = closed.data;
  // 1.2.3 step 1b (D17): the invitations - a handful of small files, read every round (Invited rows, "X joined").
  update.invites = {};
  for (const n of await listTeamNames(root, [INVITES_DIR], "file")) {
    const r = await readTeamJson(root, [INVITES_DIR], n);
    if (r.status === "ok" && r.data && r.data.id) update.invites[r.data.id] = r.data;
  }
  // Members the Team Lead removed (Boaz 2026-10-06): removed/<member>.json, written by the admin.
  update.removed = {};
  for (const n of await listTeamNames(root, ["removed"], "file")) {
    const id = (/^(.+)\.json$/.exec(n) || [])[1];
    if (!id || meta.removed?.[id]) continue;
    const r = await readTeamJson(root, ["removed"], n);
    if (r.status === "ok") update.removed[id] = { at: r.data.at || Date.now(), by: r.data.by || null };
  }
  for (const name of await listTeamNames(root, ["base"], "file")) {
    if (meta.basesApplied.includes(name)) continue;
    const r = await readTeamJson(root, ["base"], name);
    if (r.status !== "ok") continue;
    records.push(...(r.data.changes || []));
    update.baseRecords += (r.data.changes || []).length;
    update.basesApplied.push(name);
    update.files += 1;
    update.bytes += r.bytes;
  }
  for (const m of await listTeamNames(root, ["members"], "directory")) {
    // 1.2.2.6 (Boaz: "Boaz has 13 accounts assigned" on a colleague's PC, 0 on his own): my own files are read back
    // too, with their own cursor. A PC knew its own changes only from its saved state; if that was ever reset, its own
    // assignments, claims and edits were gone on that PC for good. Applying a record twice changes nothing.
    const self = m === me && !includeSelf;
    if (!self) {
      const hb = await readTeamJson(root, ["members", m], "heartbeat.json");
      if (hb.status === "ok") update.hb[m] = { at: hb.data.at, lastN: hb.data.lastN || 0, clock: hb.data.clock || null, left: hb.data.left || null };
      if (!meta.profiles[m]) {
        const p = await readTeamJson(root, ["members", m], "profile.json");
        if (p.status === "ok") update.profiles[m] = p.data;
      }
    }
    let cursor = self ? meta.selfCursor || 0 : meta.cursors[m] || 0;
    let snapshots = null;
    while (update.files < MAX_FILES_PER_ROUND) {
      const r = await readTeamJson(root, ["members", m, "changes"], `c-${cursor + 1}.json`);
      if (r.status === "ok") {
        records.push(...(r.data.changes || []));
        cursor += 1;
        // The newest stamp counts too: it follows the writer's clock, which has seen every claim it had read.
        if (!self) update.lastFileWall[m] = Math.max(Date.parse(r.data.written) || 0, ...(r.data.changes || []).map((c) => stampWall(c && c.t)));
        update.files += 1;
        update.bytes += r.bytes;
        continue;
      }
      if (r.status === "incomplete") break; // not finished yet - read again next round
      // Missing: compacted away (read the snapshot), or not arrived yet (wait).
      if (!snapshots) snapshots = (await listTeamNames(root, ["members", m, "snapshots"], "file"))
        .map((n) => Number((/^s-(\d+)\.json$/.exec(n) || [])[1]) || 0).filter((n) => n > 0).sort((a, b) => a - b);
      const snapN = snapshots.filter((n) => n > cursor).pop();
      if (!snapN) break;
      const s = await readTeamJson(root, ["members", m, "snapshots"], `s-${snapN}.json`);
      if (s.status !== "ok") break;
      records.push(...(s.data.changes || []));
      cursor = snapN;
      update.files += 1;
      update.bytes += s.bytes;
    }
    if (self) update.selfCursor = cursor;
    else update.cursors[m] = cursor;
  }
  return { records, update };
}

function commitReadUpdate(update) {
  const meta = mem.meta;
  Object.assign(meta.cursors, update.cursors);
  Object.assign(meta.lastFileWall, update.lastFileWall);
  Object.assign(meta.hb, update.hb);
  Object.assign(meta.profiles, update.profiles);
  meta.basesApplied = [...new Set([...meta.basesApplied, ...update.basesApplied])];
  if (update.admins) meta.admins = update.admins;
  if (update.creator) meta.creator = update.creator;
  if (update.selfCursor != null) meta.selfCursor = update.selfCursor;
  if (update.removed) meta.removed = { ...(meta.removed || {}), ...update.removed };
  if (update.closed) meta.closed = update.closed;
  if (update.invites) meta.invites = { ...(meta.invites || {}), ...update.invites };
  meta.lastReadAt = Date.now();
}

// --------------------------------------------------------------------------
// The folder round: flush, read, heartbeat, compact
// --------------------------------------------------------------------------

async function flush(root, me) {
  const batch = await enqueue(async () => {
    if (!mem.inflight && mem.outbox.length) {
      const changes = mem.outbox.slice(0, MAX_RECORDS_PER_FILE);
      mem.inflight = { n: mem.meta.nextN, written: new Date().toISOString(), changes };
      mem.outbox = mem.outbox.slice(changes.length);
      mem.meta.nextN += 1;
      await save(["inflight", "outbox"]);
    }
    return mem.inflight;
  });
  if (!batch) return false;
  const t0 = performance.now();
  // The same n and the same content on every retry: a half-written file is simply written again.
  const w = await writeTeamJson(root, ["members", me, "changes"], `c-${batch.n}.json`,
    { member: me, n: batch.n, written: batch.written, changes: batch.changes });
  await enqueue(async () => {
    mem.inflight = null;
    mem.meta.lastWrittenN = batch.n;
    mem.meta.lastFlushAt = Date.now();
    mem.meta.ownFiles = [...(mem.meta.ownFiles || []), { n: batch.n, at: Date.parse(batch.written) }];
    // Records are copies once saved to IndexedDB: matched to their previous values by stamp and row.
    const own = new Map();
    for (const r of batch.changes) {
      const p = ownPriors.get(`${r.t}|${r.e}|${r.id}`);
      if (p) { own.set(r, p); ownPriors.delete(`${r.t}|${r.e}|${r.id}`); }
    }
    await recordTeamLog(batch.changes, own);
    measure({ kind: "flush", n: batch.n, records: batch.changes.length, bytes: w.bytes, attempts: w.attempts, ms: Math.round(performance.now() - t0) });
    await save(["inflight"]);
  });
  return true;
}

// 1.2.3 (design 3.1): the group rows in the merged state - rewritten whole when the Team Lead chain changes.
function gatedRowKeys() {
  return Object.keys(mem.state.gated || {}).filter((id) => isGatedRow("setting", id)).map((id) => rowKey("setting", id));
}

// The team's creator starts the Team Lead chain. Once known, group records can be judged.
async function noteCreator() {
  // team.json's createdBy; failing that, admins/ only when it names one person - never a guess between several.
  const admins = mem.meta.admins || [];
  const creator = mem.meta.creator || (admins.length === 1 ? admins[0] : null);
  if (creator && setTeamCreator(mem.state, creator)) {
    await save(["state"]);
    await writeBack(new Set(gatedRowKeys()));
  }
}

async function readRound(root, me) {
  const t0 = performance.now();
  const { records, update } = await readFolder(root, me);
  await enqueue(async () => {
    const invitesBefore = { ...(mem.meta.invites || {}) };
    commitReadUpdate(update);
    await noteCreator();
    await noteInvitesAccepted(invitesBefore);
    for (const [id, r] of Object.entries(update.removed || {})) if (r.by && r.by !== me) await logMemberRemoved(id, r.by, r.at);
    // My own records read back are already in the log (written when they went out).
    const logged = records.slice(update.baseRecords).filter((r) => stampMember(r && r.t) !== me);
    const priors = logged.length ? priorsFor(logged) : null; // before applying: the previous values
    const rows = records.length ? await applyRemote(records) : 0;
    await recordTeamLog(logged, priors);
    measure({ kind: "read", files: update.files, bytes: update.bytes, records: records.length, rows, ms: Math.round(performance.now() - t0) });
    await save([]);
    if (update.files < MAX_FILES_PER_ROUND) mem.replaying = false; // caught up: from here on, what is read is news
  });
}

let leaving = false; // leaveTeam has written the sign-off heartbeat: a round still running must not overwrite it
async function heartbeat(root, me) {
  if (leaving) return;
  await writeTeamJson(root, ["members", me], "heartbeat.json",
    { member: me, name: membership.name, at: Date.now(), lastN: mem.meta.lastWrittenN, clock: tick(mem.clock, Date.now()), version: chrome.runtime.getManifest().version });
  mem.meta.lastHeartbeatAt = Date.now();
  ackDue = false;
}

// Design 3.3: once a day, this member's change files older than 7 days are folded into one snapshot.
async function compact(root, me) {
  const meta = mem.meta;
  const cutoff = Date.now() - KEEP_CHANGE_FILES_MS;
  const upTo = Math.max(0, ...(meta.ownFiles || []).filter((f) => f.at < cutoff && f.n <= meta.lastWrittenN).map((f) => f.n));
  if (upTo <= meta.snapN) return null;
  const records = [];
  if (meta.snapN) {
    const prev = await readTeamJson(root, ["members", me, "snapshots"], `s-${meta.snapN}.json`);
    if (prev.status !== "ok") return null;
    records.push(...(prev.data.changes || []));
  }
  for (let n = meta.snapN + 1; n <= upTo; n++) {
    const r = await readTeamJson(root, ["members", me, "changes"], `c-${n}.json`);
    if (r.status !== "ok") return null; // try again tomorrow, never snapshot with a gap
    records.push(...(r.data.changes || []));
  }
  const changes = compactChanges(records);
  await writeTeamJson(root, ["members", me, "snapshots"], `s-${upTo}.json`, { member: me, n: upTo, written: new Date().toISOString(), changes });
  // Only once the snapshot is safely written: drop what it replaces. Never another member's files.
  for (const name of await listTeamNames(root, ["members", me, "changes"], "file")) {
    const n = Number((/^c-(\d+)\.json$/.exec(name) || [])[1]) || 0;
    if (n && n <= upTo) await removeTeamFile(root, ["members", me, "changes"], name);
  }
  for (const name of await listTeamNames(root, ["members", me, "snapshots"], "file")) {
    if (name !== `s-${upTo}.json`) await removeTeamFile(root, ["members", me, "snapshots"], name);
  }
  meta.snapN = upTo;
  meta.ownFiles = meta.ownFiles.filter((f) => f.n > upTo);
  return { upTo, records: records.length, kept: changes.length };
}

async function connectedRoot() {
  const root = await getTeamFolder();
  if (!root) {
    folderState = "none";
    return null;
  }
  folderState = await teamFolderPermission(root);
  return folderState === "granted" ? root : null;
}

function scheduleTick(ms) {
  if (tickTimer) {
    if (ms >= READ_EVERY_MS) return;
    clearTimeout(tickTimer);
  }
  tickTimer = setTimeout(() => { tickTimer = null; runTick("timer").catch(() => {}); }, ms);
}

export async function runTick(reason = "alarm") {
  if (ticking) return { busy: true };
  ticking = true;
  try {
    if (!(await loadMembership())) return { member: false };
    await enqueue(ensureLoaded);
    const me = membership.memberId;
    const root = await connectedRoot();
    if (!root) return { folder: folderState }; // the alarm comes back; no timer keeps the worker awake for nothing
    if (mem.meta.lastWrittenN === 0 && !mem.inflight) {
      // Our own numbering restarts at 1 only if this member has written nothing - never overwrite a file a
      // colleague may already have read (the local state was lost, e.g. site data cleared).
      const own = (await listTeamNames(root, ["members", me, "changes"], "file"))
        .map((n) => Number((/^c-(\d+)\.json$/.exec(n) || [])[1]) || 0);
      const top = Math.max(0, ...own, mem.meta.snapN || 0);
      if (top >= mem.meta.nextN) await enqueue(async () => { mem.meta.nextN = top + 1; mem.meta.lastWrittenN = top; await save([]); });
    }
    while (await flush(root, me)) { /* everything waiting goes out */ }
    const now = Date.now();
    const readEvery = claimsPending() ? CLAIM_READ_EVERY_MS : READ_EVERY_MS;
    if (reason === "now" || now - mem.meta.lastReadAt >= readEvery - 1000) await readRound(root, me);
    if (mem?.meta.closed) {
      // D16: the Team Lead closed the team - stop sharing; the data here stays as this member's own copy.
      const c = mem.meta.closed;
      const teamName = membership.teamName;
      await leaveLocally();
      await chrome.storage.local.set({ [TEAM_CLOSED_NOTICE_KEY]: { teamName, by: c.byName || "The Team Lead", at: c.at || Date.now() } });
      return { closed: true };
    }
    if (mem?.meta.removed?.[me]) {
      // The Team Lead removed this member: stop sharing, as Leave does (the local copy stays as a solo copy).
      await leaveLocally();
      return { removed: true };
    }
    // Answer a colleague's claim at once: their claim is confirmed when we have written something after it (6.3).
    if (ackDue || now - Math.max(mem.meta.lastHeartbeatAt, mem.meta.lastFlushAt) >= HEARTBEAT_EVERY_MS) await heartbeat(root, me);
    await enqueue(resolveClaims);
    while (await flush(root, me)) { /* held edits of a confirmed claim, and our releases, go out at once */ }
    const today = new Date().toISOString().slice(0, 10);
    if (mem.meta.lastCompactDay !== today) {
      const result = await compact(root, me);
      if (result) measure({ kind: "compact", ...result });
      mem.meta.lastCompactDay = today;
    }
    await enqueue(() => save([]));
    lastError = null;
    lastOkAt = Date.now();
    errorSince = 0;
    return { ok: true };
  } catch (err) {
    lastError = `${reason}: ${errText(err)}`;
    if (!errorSince) errorSince = Date.now();
    folderState = folderState === "granted" ? "error" : folderState;
    return { ok: false, error: lastError };
  } finally {
    ticking = false;
    if (membership && mem) await enqueue(publishSummary).catch(() => {});
    if (membership && folderState === "granted") {
      scheduleTick(mem && claimsPending() ? CLAIM_READ_EVERY_MS : mem?.outbox?.length ? FLUSH_DELAY_MS : READ_EVERY_MS);
    }
  }
}

// --------------------------------------------------------------------------
// Claims (build step 4, design 6): claim, then confirm; held edits; kept aside
// --------------------------------------------------------------------------
// A claim is on an account (team-claims.js names it by company key). While my claim is being checked, my edits to
// that account's rows (account and contact homes) are applied here but HELD - not sent. Confirmed: they go out.
// Lost (a colleague claimed first): they are taken back out of the merged state, the rows on this PC get the
// winner's values again, and the edits are KEPT ASIDE until I apply or discard them (R3.3 - nothing lost silently).

// Design 6.3: a colleague's heartbeat counts only once every change file it vouches for has been read. Its clock has
// seen every claim that colleague had read, so a heartbeat stamped after my claim proves they have nothing earlier.
function readUpToOf(hb, cursor, fileWall) {
  if (!hb || cursor < (hb.lastN || 0)) return fileWall;
  return Math.max(hb.at || 0, stampWall(hb.clock), fileWall);
}

function claimContext(now = Date.now()) {
  const meta = mem.meta;
  const me = membership.memberId;
  const lastSeen = {};
  const readUpTo = {};
  for (const m of Object.keys({ ...meta.cursors, ...meta.hb, ...meta.profiles })) {
    if (m === me || meta.hb[m]?.left || meta.removed?.[m]) continue; // a member who left takes no part in claims or shares
    const hb = meta.hb[m];
    const fileWall = meta.lastFileWall[m] || 0;
    lastSeen[m] = Math.max(hb?.at || 0, fileWall);
    readUpTo[m] = readUpToOf(hb, meta.cursors[m] || 0, fileWall);
  }
  return { me, now, lastSeen, readUpTo, activeMembers: activeMembersOf(lastSeen, now, ACTIVE_MS), idleMs: DEFAULT_CLAIM_IDLE_MS };
}

const memberName = (m) => (m === membership?.memberId ? membership.name : mem.meta.profiles[m]?.name || mem.meta.hb[m]?.name || "A colleague");
const inSyncNow = () => !(lastError && errorSince && Date.now() - errorSince >= NOT_IN_SYNC_AFTER_MS);
// 1.2.3 (design 3.1, 3.2): the Team Lead is decided by the team folder - the creator, then the hand-over, deputy and
// take-over records (team-groups.js teamLeadOf). Before the first folder read the creator is not known yet; until
// then membership.role is the answer (create: Team Lead, join: Member). Every role check goes through these.
function leadNow() {
  const c = mem ? leadChain(mem.state) : null;
  if (c && c.creator) return { lead: c.lead, deputy: c.deputy, known: true };
  return { lead: membership?.role === "admin" ? membership.memberId : null, deputy: null, known: false };
}
const isTeamLead = (member = membership?.memberId) => Boolean(member) && leadNow().lead === member;
// The Team Lead's rights: the Team Lead, or the deputy while there is one (3.4) - everything but hand-over, deputy
// and removing the Team Lead.
const hasLeadRights = (member = membership?.memberId) => {
  const l = leadNow();
  return Boolean(member) && (l.lead === member || l.deputy === member);
};

// --------------------------------------------------------------------------
// Account groups (design 5.4) - computed here, published with the summary
// --------------------------------------------------------------------------
// Only in advanced mode (a live group exists). The groups of each account are recomputed when the groups, pins or
// account data change, at most every 2 s; who is in which group (cheap) on every publish.
const GROUP_INPUT_KEYS = ["teamGroups", "teamGroupPins", "targetAccountsWorkbook", "targetAccounts", "targetAccountExtras",
  "companyRelationships", "companyExclusions"];
const GROUPS_EVERY_MS = 2000;
let groupsByKey = null; // { key: [group ids] } or null (basic mode)
let groupsDirty = true;
let groupsAt = 0;
let groupsTimer = null;

function currentTeam() {
  const meta = mem.meta;
  const me = membership.memberId;
  return [me, ...Object.keys({ ...meta.cursors, ...meta.hb, ...meta.profiles })
    .filter((m) => m !== me && !meta.hb[m]?.left && !meta.removed?.[m])].sort();
}

// groups: the teamGroups map; pins: teamGroupPins. Returns { byKey, accounts, viewsMs, ms }.
async function computeGroupsOf(groups, pins, team) {
  const t0 = performance.now();
  const views = await getAccountViews({ persistDerived: false });
  const t1 = performance.now();
  const index = groupIndex(groups, team);
  const byKey = {};
  for (const v of views) byKey[v.key] = groupsOf(v.key, groupFacts(v, { buckets: SIZE_PRIORITY_BUCKETS }), index, pins || {});
  return { byKey, index, accounts: views.length, viewsMs: Math.round(t1 - t0), ms: Math.round(performance.now() - t1) };
}

async function refreshGroups() {
  const got = await chrome.storage.local.get(["teamGroups", "teamGroupPins"]);
  if (!groupsOn(got.teamGroups)) { groupsByKey = null; return; }
  const r = await computeGroupsOf(got.teamGroups, got.teamGroupPins, currentTeam());
  groupsByKey = r.byKey;
  measure({ kind: "groups", accounts: r.accounts, groups: r.index.live.length, views_ms: r.viewsMs, ms: r.ms });
}

let groupsRunning = false;
function startGroupsRefresh() {
  if (groupsRunning) return;
  const wait = GROUPS_EVERY_MS - (Date.now() - groupsAt);
  if (wait > 0) { markGroupsDirty(wait); return; }
  groupsRunning = true;
  groupsDirty = false;
  groupsAt = Date.now();
  refreshGroups()
    .catch((err) => { lastError = `groups: ${errText(err)}`; })
    .finally(() => {
      groupsRunning = false;
      groupsAt = Date.now(); // the next run starts at least 2 s after this one ended
      if (membership && mem) enqueue(publishSummary).catch(() => {});
    });
}

function markGroupsDirty(delay = GROUPS_EVERY_MS) {
  groupsDirty = true;
  if (groupsTimer) return;
  groupsTimer = setTimeout(() => {
    groupsTimer = null;
    if (membership && mem) startGroupsRefresh();
  }, delay);
}

// Step 0 measurement on the live data (dev page): sample groups - one per region, a size filter, a 20-account list.
export async function measureGroups() {
  const sample = {};
  for (const r of ["northAmerica", "latinAmerica", "europe", "africa", "middleEast", "southEastAsia"]) {
    sample[`g-${r}`] = { name: r, kind: "filter", filter: { region: [r] }, members: [] };
  }
  sample["g-big"] = { name: "Big", kind: "filter", filter: { size: ["XL", "XXL"], scope: ["global"] }, members: [] };
  const first = (await getAccountViews({ persistDerived: false })).slice(0, 20).map((v) => v.key);
  sample["g-named"] = { name: "Named", kind: "named", accounts: first, members: [] };
  const runs = [];
  let last = null;
  for (let i = 0; i < 3; i++) { last = await computeGroupsOf(sample, {}, []); runs.push({ views_ms: last.viewsMs, groups_ms: last.ms }); }
  const counts = {};
  for (const ids of Object.values(last.byKey)) for (const g of ids) counts[g] = (counts[g] || 0) + 1;
  const l = membership && mem ? leadNow() : null;
  return { ok: true, accounts: last.accounts, groups: Object.keys(sample).length, runs, counts,
    lead: l ? { lead: l.lead && memberName(l.lead), deputy: l.deputy && memberName(l.deputy), fromFolder: l.known } : null };
}

// Inside the queue. The pages' copy of every account's assignment and active claim (TEAM_ACCOUNTS_KEY).
let lastSummaryJson = null;
async function publishSummary() {
  if (!membership || !mem) return;
  const ctx = claimContext();
  const accounts = teamAccountSummary(mem.state, ctx);
  const names = {};
  for (const e of Object.values(accounts)) for (const m of [e.a, e.h]) if (m && !names[m]) names[m] = memberName(m);
  // 1.2.2.7 (Annick's Leave the team took minutes): the groups are recomputed OUTSIDE the queue - reading every
  // account takes ~0.5 s and ran on every account change, so Settings > Team, Leave and Assign waited behind it.
  // The summary goes out now with the groups as last computed; a fresh computation publishes again when done.
  if (groupsDirty) startGroupsRefresh();
  const leads = leadNow();
  // admin (= the Team Lead's rights) stays for the readers built before 1.2.3; lead / deputy are the answer now.
  const value = {
    me: ctx.me, admin: hasLeadRights(), lead: leads.lead, deputy: leads.deputy, leadKnown: leads.known,
    inSync: folderState === "granted" && inSyncNow(), folder: folderState, names, accounts,
  };
  for (const m of [leads.lead, leads.deputy]) if (m && !names[m]) names[m] = memberName(m);
  if (groupsByKey) {
    // Design 5.4: per account its group ids (g), and the groups I am in (Other when none, D9).
    const got = await chrome.storage.local.get("teamGroups");
    value.groupsOn = true;
    const index = groupIndex(got.teamGroups, currentTeam());
    value.myGroups = memberGroups(ctx.me, index);
    if (!value.myGroups.length) value.myGroups = [OTHER_GROUP];
    // Step 1: everyone's groups - Reassign to… offers only members with access to the account.
    value.ofMember = index.ofMember;
    value.g = groupsByKey;
  }
  const json = JSON.stringify(value);
  if (json === lastSummaryJson) return;
  lastSummaryJson = json;
  await chrome.storage.local.set({ [TEAM_ACCOUNTS_KEY]: value });
}

// My own record: into the outbox and the merged state at once.
function pushOwn(record) {
  applyChange(mem.state, record);
  mem.outbox.push(record);
}

// Inside the queue (diffKeys). New local records go out, except those of an account whose claim of mine is still
// being checked (or lost, until resolveClaims has dealt with it): those are held. Both are applied to the state.
function holdOrSend(records) {
  const { claims } = mem;
  const views = new Map();
  let ctx = null;
  for (const r of records) {
    if (r.op === "set" && ownPriors.size < OWN_PRIORS_MAX) ownPriors.set(`${r.t}|${r.e}|${r.id}`, priorOf(mem.state, r));
    const key = accountKeyOfChange(mem.state, r, normalizeCompanyName);
    let hold = false;
    if (key && claims.mine[key]) {
      if (claims.held[key]) hold = true;
      else {
        if (!views.has(key)) views.set(key, claimView(mem.state, key, ctx || (ctx = claimContext())).state);
        hold = views.get(key) === "checking" || views.get(key) === "lost";
      }
    }
    if (hold) {
      const h = claims.held[key] || (claims.held[key] = { records: [], prior: {} });
      const rk = rowKey(r.e, r.id);
      const before = priorOf(mem.state, r);
      if (!h.prior[rk]) h.prior[rk] = before;
      else for (const [f, v] of Object.entries(before.f)) if (!(f in h.prior[rk].f)) h.prior[rk].f[f] = v;
      h.records.push(r);
      applyChange(mem.state, r);
    } else {
      pushOwn(r);
    }
  }
}

function claimsPending() {
  const { claims } = mem;
  if (Object.keys(claims.held).length || Object.keys(claims.assigning).length) return true;
  const keys = Object.keys(claims.mine);
  if (!keys.length || !membership) return false;
  const ctx = claimContext();
  return keys.some((k) => claimView(mem.state, k, ctx).state === "checking");
}

function releaseOwn(key, now) {
  pushOwn({ t: tick(mem.clock, now), e: "account", id: claimIdFor(key), op: "release" });
  delete mem.claims.mine[key];
}

// Inside the queue. Settles every claim of mine that the latest read decided.
async function resolveClaims() {
  if (!membership) return;
  const { claims } = mem;
  const keys = [...new Set([...Object.keys(claims.mine), ...Object.keys(claims.held)])];
  const assignKeys = Object.keys(claims.assigning);
  if (!keys.length && !assignKeys.length) return;
  const ctx = claimContext();
  const now = ctx.now;
  const rewrite = new Set();
  let changed = false;
  // Assignments (R6.1): two members assigning within seconds - the earlier keeps it; the later one is withdrawn
  // (it would otherwise become the assignee the moment the winner releases) and told once.
  for (const key of assignKeys) {
    const { to } = claims.assigning[key];
    const list = activeAssignments(mem.state, "account", claimIdFor(key));
    const first = list[0];
    const stillActive = list.some((a) => a.member === to);
    if (!stillActive) {
      delete claims.assigning[key]; // released or reassigned meanwhile
    } else if (first.member !== to) {
      pushOwn({ t: tick(mem.clock, now), e: "account", id: claimIdFor(key), op: "unassign", ...(to === ctx.me ? {} : { member: to }) });
      claims.assignLost[key] = { to, winner: first.member, at: now };
      delete claims.assigning[key];
    } else if (isClaimConfirmed(first.since, { me: ctx.me, activeMembers: ctx.activeMembers, readUpTo: ctx.readUpTo })) {
      delete claims.assigning[key];
    } else {
      continue;
    }
    changed = true;
  }
  for (const key of keys) {
    const v = claimView(mem.state, key, ctx);
    const held = claims.held[key];
    if (v.state === "lost" || (v.state === "other" && held)) {
      if (held) {
        retractChanges(mem.state, held.records, held.prior);
        for (const r of held.records) rewrite.add(rowKey(r.e, r.id));
        const prev = claims.aside[key];
        claims.aside[key] = { records: [...(prev?.records || []), ...held.records], at: now, lostTo: v.holder?.member || null };
        delete claims.held[key];
      }
      // A lost claim is withdrawn: it would otherwise become the holder the moment the winner is done.
      if (claims.mine[key]) releaseOwn(key, now);
      changed = true;
      continue;
    }
    if (v.state === "mine" || v.state === "free") {
      if (held) {
        mem.outbox.push(...held.records);
        delete claims.held[key];
        changed = true;
      }
      // Free with a claim of mine: it ran out (5 minutes without a sign of life) - nothing to hold any more.
      if (claims.mine[key] && (claims.mine[key].releaseWhenDone || v.state === "free")) {
        if (v.state === "free") delete claims.mine[key];
        else releaseOwn(key, now);
        changed = true;
      }
    }
  }
  if (changed) await save(["state", "outbox", "claims"]);
  if (rewrite.size) await writeBack(rewrite);
}

function describeClaim(key) {
  const ctx = claimContext();
  const v = claimView(mem.state, key, ctx);
  const a = assignmentView(mem.state, key, ctx);
  const aside = mem.claims.aside[key];
  const lost = mem.claims.assignLost[key];
  const admin = hasLeadRights();
  return {
    member: true,
    key,
    state: v.state,
    holder: v.holder ? { name: memberName(v.holder.member), me: v.holder.member === ctx.me, since: v.holder.sinceWall } : null,
    // Step 5 (design 7): the assignment, and what this member may do about it.
    assignee: a.assignee ? {
      id: a.assignee.member, name: memberName(a.assignee.member), me: a.mine, since: a.assignee.sinceWall,
      checking: a.mine && !a.confirmed || Boolean(mem.claims.assigning[key]),
    } : null,
    assignLost: lost ? { winner: memberName(lost.winner), at: lost.at, forMe: lost.to === ctx.me, to: memberName(lost.to) } : null,
    admin,
    // Admin: the members it can reassign to (itself included).
    team: admin ? [ctx.me, ...Object.keys({ ...mem.meta.cursors, ...mem.meta.hb, ...mem.meta.profiles }).filter((m) => m !== ctx.me).sort()]
      .map((m) => ({ id: m, name: memberName(m) })) : null,
    held: mem.claims.held[key]?.records.length || 0,
    aside: aside ? {
      changes: aside.records.reduce((n, r) => n + (r.op === "set" ? Object.keys(r.f || {}).length : 1), 0),
      at: aside.at,
      lostTo: aside.lostTo ? memberName(aside.lostTo) : null,
    } : null,
    inSync: folderState === "granted" && inSyncNow(),
    folder: folderState,
  };
}

// Inside the queue. Refuses while the folder is not usable or not in sync (6.6: a claim nobody can see is no claim).
async function claimInner(key, kind) {
  if (!key) return { ok: false, reason: "no_key" };
  if (!(await connectedRoot())) return { ok: false, reason: "offline", ...describeClaim(key) };
  if (!inSyncNow()) return { ok: false, reason: "not_in_sync", ...describeClaim(key) };
  const ctx = claimContext();
  const a = assignmentView(mem.state, key, ctx);
  if (a.assignee && !a.mine) return { ok: false, reason: "assigned", ...describeClaim(key) };
  const v = claimView(mem.state, key, ctx);
  if (v.state === "other" || v.state === "lost") return { ok: false, reason: "held", ...describeClaim(key) };
  const now = Date.now();
  const m = mem.claims.mine[key];
  if (!m || v.state === "free" || now - m.at >= CLAIM_REFRESH_MS) {
    // Also a renewal: the claim's 5-minute idle clock runs from my latest claim record (team-merge activeClaims).
    pushOwn({ t: tick(mem.clock, now), e: "account", id: claimIdFor(key), op: "claim", kind });
    mem.claims.mine[key] = { kind, at: now, releaseWhenDone: false };
    await save(["state", "outbox", "claims"]);
    scheduleTick(0);
  } else if (m.releaseWhenDone) {
    m.releaseWhenDone = false;
    await save(["claims"]);
  }
  return { ok: true, ...describeClaim(key) };
}

// Before a member edits an account (the account page) or the pipeline starts on it. Not in a team: always ok.
export function claimAccount(key, { kind = "edit" } = {}) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: true };
    await ensureLoaded();
    return claimInner(key, kind);
  });
}

// Leaving the account page, or the pipeline done with it. Edits still held wait for the outcome first.
export function releaseAccount(key) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: true };
    await ensureLoaded();
    const m = mem.claims.mine[key];
    if (!m) return { ok: true };
    if (mem.claims.held[key]) m.releaseWhenDone = true;
    else releaseOwn(key, Date.now());
    await save(["state", "outbox", "claims"]);
    scheduleTick(FLUSH_DELAY_MS);
    return { ok: true };
  });
}

export function getClaimStatus(key) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false };
    await ensureLoaded();
    await connectedRoot();
    await resolveClaims();
    return describeClaim(key);
  });
}

// "Apply my changes": the kept-aside edits, stamped anew, under a new claim - held until it is confirmed.
export function applyKeptAside(key) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false };
    await ensureLoaded();
    const aside = mem.claims.aside[key];
    if (!aside) return { ok: true, ...describeClaim(key) };
    const claimed = await claimInner(key, "edit");
    if (!claimed.ok) return claimed;
    const now = Date.now();
    const h = mem.claims.held[key] || (mem.claims.held[key] = { records: [], prior: {} });
    const rows = new Set();
    for (const r of aside.records) {
      const nr = { ...r, t: tick(mem.clock, now) };
      const rk = rowKey(nr.e, nr.id);
      const before = priorOf(mem.state, nr);
      if (!h.prior[rk]) h.prior[rk] = before;
      else for (const [f, v] of Object.entries(before.f)) if (!(f in h.prior[rk].f)) h.prior[rk].f[f] = v;
      h.records.push(nr);
      applyChange(mem.state, nr);
      rows.add(rk);
    }
    delete mem.claims.aside[key];
    await save(["state", "claims"]);
    await writeBack(rows);
    await resolveClaims();
    scheduleTick(0);
    return { ok: true, ...describeClaim(key) };
  });
}

export function discardKeptAside(key) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false };
    await ensureLoaded();
    delete mem.claims.aside[key];
    await save(["claims"]);
    return { ok: true, ...describeClaim(key) };
  });
}

// --------------------------------------------------------------------------
// Assign to me / release (build step 5, design 7, R6.1-R6.4)
// --------------------------------------------------------------------------
// "Assign to me" writes `assign`, "Release" writes `unassign`. An assignment does not expire. A member assigns only
// a free account to itself and releases only its own; the Team Lead can also release or reassign anyone's. Nobody
// assigns an account a colleague is updating right now (the claim says so) - try again when they are done.

async function assignInner(key, to) {
  if (!key) return { ok: false, reason: "no_key" };
  if (!(await connectedRoot())) return { ok: false, reason: "offline", ...describeClaim(key) };
  if (!inSyncNow()) return { ok: false, reason: "not_in_sync", ...describeClaim(key) };
  const ctx = claimContext();
  const me = ctx.me;
  const target = to || me;
  const admin = hasLeadRights();
  if (target !== me && !admin) return { ok: false, reason: "not_lead", ...describeClaim(key) };
  const a = assignmentView(mem.state, key, ctx);
  const current = a.assignee?.member || null;
  if (current === target) return { ok: true, ...describeClaim(key) };
  if (current && current !== me && !admin) return { ok: false, reason: "assigned", ...describeClaim(key) };
  const c = claimView(mem.state, key, ctx);
  if (c.state === "other" || c.state === "lost") return { ok: false, reason: "held", ...describeClaim(key) };
  const now = Date.now();
  const id = claimIdFor(key);
  if (current) pushOwn({ t: tick(mem.clock, now), e: "account", id, op: "unassign", ...(current === me ? {} : { member: current }) });
  pushOwn({ t: tick(mem.clock, now), e: "account", id, op: "assign", ...(target === me ? {} : { member: target }) });
  mem.claims.assigning[key] = { to: target, at: now };
  delete mem.claims.assignLost[key];
  await save(["state", "outbox", "claims"]);
  await publishSummary();
  scheduleTick(0);
  return { ok: true, ...describeClaim(key) };
}

export function assignAccount(key, { to = null } = {}) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: false };
    await ensureLoaded();
    return assignInner(key, to);
  });
}

export function unassignAccount(key) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: false };
    await ensureLoaded();
    if (!(await connectedRoot())) return { ok: false, reason: "offline", ...describeClaim(key) };
    if (!inSyncNow()) return { ok: false, reason: "not_in_sync", ...describeClaim(key) };
    const ctx = claimContext();
    // The admin clears every active assignment - the winner's and any not yet withdrawn - so nothing is left to
    // take over; a member releases its own.
    const list = activeAssignments(mem.state, "account", claimIdFor(key));
    if (!list.length) return { ok: true, ...describeClaim(key) };
    const admin = hasLeadRights();
    if (list[0].member !== ctx.me && !admin) return { ok: false, reason: "not_lead", ...describeClaim(key) };
    const now = Date.now();
    for (const x of admin ? list : list.filter((y) => y.member === ctx.me)) {
      pushOwn({ t: tick(mem.clock, now), e: "account", id: claimIdFor(key), op: "unassign", ...(x.member === ctx.me ? {} : { member: x.member }) });
    }
    delete mem.claims.assigning[key];
    delete mem.claims.assignLost[key];
    await save(["state", "outbox", "claims"]);
    await publishSummary();
    scheduleTick(0);
    return { ok: true, ...describeClaim(key) };
  });
}

export function dismissAssignNotice(key) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false };
    await ensureLoaded();
    delete mem.claims.assignLost[key];
    await save(["claims"]);
    return { ok: true, ...describeClaim(key) };
  });
}

// Admin, Settings > Team: release every account assigned to one member (someone who left the team, R6.4).
export function unassignAllOf(member) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: false };
    await ensureLoaded();
    if (!hasLeadRights()) return { ok: false, reason: "not_lead" };
    if (!(await connectedRoot()) || !inSyncNow()) return { ok: false, reason: "offline" };
    const now = Date.now();
    let count = 0;
    for (const id of Object.keys(mem.state.entities.account || {})) {
      if (!id.startsWith("@")) continue;
      if (!activeAssignments(mem.state, "account", id).some((x) => x.member === member)) continue;
      pushOwn({ t: tick(mem.clock, now), e: "account", id, op: "unassign", ...(member === membership.memberId ? {} : { member }) });
      count++;
    }
    if (count) {
      await save(["state", "outbox"]);
      await publishSummary();
      scheduleTick(0);
    }
    return { ok: true, count };
  });
}

// Boaz 2026-10-06: the Team Lead removes a member - e.g. an old membership of someone who left before "left" was
// recorded, or a colleague who stopped without signing off. Their accounts are released and removed/<member>.json
// tells every PC; they then show under "Former members". If that member's SalesTeam is still running, it leaves the
// team on its next round (runTick).
export function removeMember(member) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: false };
    await ensureLoaded();
    if (!hasLeadRights()) return { ok: false, reason: "not_lead" };
    if (member === membership.memberId) return { ok: false, reason: "self" };
    if (member === leadNow().lead) return { ok: false, reason: "not_lead" };
    const root = await connectedRoot();
    if (!root || !inSyncNow()) return { ok: false, reason: "offline" };
    const now = Date.now();
    let count = 0;
    for (const id of Object.keys(mem.state.entities.account || {})) {
      if (!id.startsWith("@") || !activeAssignments(mem.state, "account", id).some((x) => x.member === member)) continue;
      pushOwn({ t: tick(mem.clock, now), e: "account", id, op: "unassign", member });
      count++;
    }
    await writeTeamJson(root, ["removed"], `${member}.json`, { member, by: membership.memberId, at: now });
    await logMemberRemoved(member, membership.memberId, now);
    mem.meta.removed = { ...(mem.meta.removed || {}), [member]: { at: now, by: membership.memberId } };
    await save(["state", "outbox"]);
    await publishSummary();
    scheduleTick(0);
    return { ok: true, count };
  });
}

// 1.2.3 step 1 (design 3.3, 3.4, D15): hand-over and deputy - a team|lead / team|deputy record, valid only from the
// Team Lead (team-groups.js teamLeadOf), so only the Team Lead may write one. Sent at once; this PC follows the new
// rule straight away (leadNow reads the merged state), so a former Team Lead cannot keep editing groups meanwhile.
function writeLeadRecord(id, member) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: false };
    await ensureLoaded();
    if (!isTeamLead()) return { ok: false, reason: "not_lead" };
    const l = leadNow();
    if (member && (member === l.lead || !currentTeam().includes(member))) return { ok: false, reason: "not_member" };
    if (id === "deputy" && (member || null) === (l.deputy || null)) return { ok: true, lead: l };
    if (!(await connectedRoot()) || !inSyncNow()) return { ok: false, reason: "offline" };
    const f = { member: member || null };
    if (id === "deputy" && !member) f.was = l.deputy; // for the team log: whose deputy role ended
    pushOwn({ t: tick(mem.clock, Date.now()), e: "team", id, op: "set", f });
    await save(["state", "outbox"]);
    markGroupsDirty();
    await publishSummary();
    scheduleTick(0);
    return { ok: true, lead: leadNow() };
  });
}

export function makeTeamLead(member) {
  if (!member) return Promise.resolve({ ok: false, reason: "not_member" });
  return writeLeadRecord("lead", member);
}

export function setDeputy(member) {
  return writeLeadRecord("deputy", member || null);
}

// D16: the Team Lead closes the team. closed.json tells every PC to stop sharing (each keeps its data as its own copy);
// assignments and claims end with the team, and nobody can join the folder again. Then this PC stops sharing too.
export async function closeTeam() {
  const r = await enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: false };
    await ensureLoaded();
    if (!isTeamLead()) return { ok: false, reason: "not_lead" };
    const root = await connectedRoot();
    if (!root) return { ok: false, reason: "offline" };
    await writeTeamJson(root, [], "closed.json", { teamId: membership.teamId, by: membership.memberId, byName: membership.name, at: Date.now() });
    // D16: open invitations end with the team.
    for (const n of await listTeamNames(root, [INVITES_DIR], "file")) {
      const r = await readTeamJson(root, [INVITES_DIR], n);
      if (r.status === "ok" && inviteState(r.data) === "open") {
        await writeTeamJson(root, [INVITES_DIR], n, { ...r.data, status: "cancelled", cancelledBy: membership.memberId, cancelledByName: membership.name, cancelledAt: Date.now() });
      }
    }
    return { ok: true };
  });
  if (!r.ok) return r;
  leaving = true;
  try { await leaveLocally(); } finally { leaving = false; }
  return { ok: true, closed: true };
}

// 1.2.3 step 1b (D17, 10a.1): the Team Lead or the deputy invites a colleague by name and e-mail. No groups: those are
// set after the colleague has joined (until then they are in Other). Written straight into the team folder.
export function inviteMember({ name, email = "" } = {}) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: false };
    await ensureLoaded();
    if (!hasLeadRights()) return { ok: false, reason: "not_lead" };
    const clean = String(name || "").trim();
    if (!clean) return { ok: false, reason: "no_name" };
    const root = await connectedRoot();
    if (!root) return { ok: false, reason: "offline" };
    const id = randomId("i");
    const invite = { id, teamId: membership.teamId, name: clean, email: String(email || "").trim(), by: membership.memberId, byName: membership.name, at: Date.now(), status: "open" };
    await writeTeamJson(root, [INVITES_DIR], `${id}.json`, invite);
    mem.meta.invites = { ...(mem.meta.invites || {}), [id]: invite };
    await save([]);
    return { ok: true, invite };
  });
}

// Marked cancelled, not deleted: a PC that joins with it later is refused.
export function cancelInvite(id) {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false, ok: false };
    await ensureLoaded();
    if (!hasLeadRights()) return { ok: false, reason: "not_lead" };
    const root = await connectedRoot();
    if (!root) return { ok: false, reason: "offline" };
    const r = await readTeamJson(root, [INVITES_DIR], `${id}.json`);
    if (r.status !== "ok") return { ok: false, reason: "missing" };
    const state = inviteState(r.data);
    if (state === "accepted") return { ok: false, reason: "accepted", name: r.data.name };
    const next = state === "cancelled" ? r.data
      : { ...r.data, status: "cancelled", cancelledBy: membership.memberId, cancelledByName: membership.name, cancelledAt: Date.now() };
    if (state === "open") await writeTeamJson(root, [INVITES_DIR], `${id}.json`, next);
    mem.meta.invites = { ...(mem.meta.invites || {}), [id]: next };
    await save([]);
    return { ok: true };
  });
}

// For pages: how many accounts each member has assigned (Settings > Team).
export function assignmentCounts() {
  return enqueue(async () => {
    if (!(await loadMembership())) return { member: false };
    await ensureLoaded();
    const counts = {};
    for (const id of Object.keys(mem.state.entities.account || {})) {
      if (!id.startsWith("@")) continue;
      const first = activeAssignments(mem.state, "account", id)[0];
      if (first) counts[first.member] = (counts[first.member] || 0) + 1;
    }
    return { ok: true, counts };
  });
}

// The pipeline and the web lane (design 6.5, R3.5): null when not in a team. Otherwise `connected` (no automatic
// work while the team cannot see it) and mayWork(key): not held by a colleague, and in this member's share of the
// accounts (rendezvous over the members active now - a joining or leaving member moves only its own share).
export async function teamWorkGate() {
  if (!(await loadMembership())) return null;
  return enqueue(async () => {
    await ensureLoaded();
    const connected = Boolean(await connectedRoot()) && inSyncNow();
    const ctx = claimContext();
    const members = [ctx.me, ...ctx.activeMembers];
    return {
      connected,
      mayWork(key) {
        if (!connected || !key) return false;
        const now = claimContext();
        // Step 5 (R6.2, Q6): a colleague's assigned account is off-limits; my own assigned ones are always mine.
        if (offLimitsFor(mem.state, key, now)) return false;
        if (assignmentView(mem.state, key, now).mine) return true;
        const state = claimView(mem.state, key, now).state;
        // An account I already hold is mine to finish, whatever the share says now.
        return state === "mine" || state === "checking" || pipelineOwner(key, members) === ctx.me;
      },
      // Work the member started itself (bulk research of chosen accounts): no shares, only R6.2.
      offLimits(key) {
        if (!connected) return { reason: "offline" };
        const o = key ? offLimitsFor(mem.state, key, claimContext()) : null;
        return o && { ...o, name: memberName(o.member) };
      },
    };
  });
}

// --------------------------------------------------------------------------
// Create, join, leave (the developer page for now; Settings > Team in step 3)
// --------------------------------------------------------------------------

async function requireRoot() {
  const root = await getTeamFolder();
  if (!root) throw new Error("No team folder picked yet.");
  const perm = await teamFolderPermission(root);
  if (perm !== "granted") throw new Error(`Folder permission is "${perm}" - reconnect the folder first.`);
  return root;
}

async function startFresh(memberId) {
  await teamDbClear();
  mem = { state: newState(), shadow: {}, outbox: [], inflight: null, meta: emptyMeta(), claims: emptyClaims() };
  mem.clock = createClock(memberId);
  mem.meta.rereadV = REREAD_VERSION; // a new state reads everything anyway
  recentWriteBack.clear();
}

async function setMembership(value) {
  membership = value;
  membershipLoaded = true;
  if (value) {
    await chrome.storage.local.set({ [TEAM_MEMBERSHIP_KEY]: value });
    await chrome.storage.local.remove(TEAM_CLOSED_NOTICE_KEY);
  }
  else await chrome.storage.local.remove(TEAM_MEMBERSHIP_KEY);
}

async function writeProfile(root, m) {
  await writeTeamJson(root, ["members", m.memberId], "profile.json",
    { member: m.memberId, name: m.name, joinedAt: m.joinedAt, version: chrome.runtime.getManifest().version, ...(m.invite ? { invite: m.invite } : {}) });
}

// The creator: an empty folder becomes the team; this member's shared data becomes its base.
// 1.2.3 step 1b (Boaz 2026-10-08): `invites` - [{ name, email }], the colleagues the Team Lead invites while setting
// the team up, so each of them only accepts (Settings > Team > Join a team).
export function createTeam({ name, teamName, invites = [] }) {
  return enqueue(async () => {
    if (await loadMembership()) throw new Error("This browser is already in a team - leave it first.");
    const root = await requireRoot();
    const top = (await listTeamFolderTop(root)).filter((n) => !n.startsWith(".") && n !== "desktop.ini");
    if (top.length) throw new Error(`The folder is not empty (${top.slice(0, 5).join(", ")}). Pick an empty folder.`);
    const t0 = performance.now();
    const memberId = randomId("m");
    const m = { memberId, name: name || "Member", teamId: randomId("t"), teamName: teamName || "SalesTeam Team", role: "admin", joinedAt: new Date().toISOString() };
    await startFresh(memberId);
    const values = await chrome.storage.local.get(TEAM_SHARED_KEYS);
    const base = [];
    const now = Date.now();
    for (const key of TEAM_SHARED_KEYS) {
      const rows = extractRows(key, values[key]);
      for (const [rk, fields] of rows) {
        const { e, id } = splitRowKey(rk);
        base.push({ t: tick(mem.clock, now), e, id, op: "set", f: fields });
      }
      mem.shadow[key] = diffRows({}, rows).shadow;
    }
    setTeamCreator(mem.state, memberId);
    mem.meta.creator = memberId;
    for (const r of base) applyChange(mem.state, r);
    await writeTeamJson(root, [], "team.json", { teamId: m.teamId, name: m.teamName, format: FORMAT, createdBy: memberId, createdByName: m.name, createdAt: m.joinedAt });
    await writeTeamJson(root, ["admins"], `${memberId}.json`, { member: memberId, grantedBy: memberId, at: m.joinedAt });
    await writeProfile(root, m);
    const baseName = `base-${m.joinedAt.replace(/[:.]/g, "-")}.json`;
    const w = await writeTeamJson(root, ["base"], baseName, { member: memberId, written: m.joinedAt, kind: "base", changes: base });
    mem.meta.basesApplied = [baseName];
    mem.meta.invites = {};
    for (const x of invites || []) {
      const invName = String(x?.name || "").trim();
      if (!invName) continue;
      const id = randomId("i");
      const invite = { id, teamId: m.teamId, name: invName, email: String(x.email || "").trim(), by: memberId, byName: m.name, at: Date.now(), status: "open" };
      await writeTeamJson(root, [INVITES_DIR], `${id}.json`, invite);
      mem.meta.invites[id] = invite;
    }
    measure({ kind: "create", records: base.length, bytes: w.bytes, ms: Math.round(performance.now() - t0) });
    await save(["state", "shadow", "outbox", "inflight", "claims"]);
    await setMembership(m);
    lastOkAt = Date.now();
    errorSince = 0;
    lastError = null;
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    return { ok: true, memberId, records: base.length, bytes: w.bytes, counts: localCounts(values), invited: Object.keys(mem.meta.invites).length };
  });
}

// A contact's name by its extras key, from the member's own workbook (for the join proposal's details).
function contactNamer(workbook) {
  const names = new Map();
  for (const c of workbook?.contacts || []) {
    const k = c && c.fullName ? contactKeyFor(c.company, c.fullName) : null;
    if (k && !names.has(k)) names.set(k, c.fullName);
  }
  return (k) => names.get(k) || null;
}

// The keys the join overlap looks at (team-join.js).
const JOIN_KEYS = ["targetAccounts", "targetAccountExtras", "targetContactExtras", "targetAccountsWorkbook", "results", JOIN_PROPOSALS_KEY];

// Step 6 (R6.7): before joining - what this browser has that the team does not, and what both have that this member
// has worked on. Reads the folder into a throw-away picture; nothing is saved.
export function previewJoin({ inviteId = null } = {}) {
  return enqueue(async () => {
    if (await loadMembership()) throw new Error("This browser is already in a team - leave it first.");
    const root = await requireRoot();
    const team = await readTeamJson(root, [], "team.json");
    if (team.status !== "ok") throw new Error("This folder has no team in it (team.json is missing or not synced yet).");
    await refuseClosed(root);
    await readInvite(root, inviteId, team.data.teamId, null);
    await startFresh(randomId("m"));
    try {
      const { records } = await readFolder(root, "-");
      for (const r of records) applyChange(mem.state, r);
      const teamValues = {};
      for (const key of JOIN_KEYS) teamValues[key] = patchValue(key, undefined, projectKey(mem.state, key));
      const local = await chrome.storage.local.get(JOIN_KEYS);
      return { ok: true, ...joinOverlap(local, teamValues, normalizeCompanyName, { contactName: contactNamer(local.targetAccountsWorkbook) }) };
    } finally {
      await teamDbClear();
      mem = null;
    }
  });
}

// D17: no joining without an open invitation. Returns the invitation; throws with the reason it cannot be used.
async function readInvite(root, inviteId, teamId, memberId) {
  const r = inviteId ? await readTeamJson(root, [INVITES_DIR], `${inviteId}.json`) : { status: "missing" };
  const inv = r.status === "ok" ? r.data : null;
  const refusal = inviteRefusal(inv, { teamId, memberId });
  if (refusal) throw new Error(refusal);
  return inv;
}

// D16: a closed team cannot be joined again.
async function refuseClosed(root) {
  const c = await readTeamJson(root, [], "closed.json");
  if (c.status === "ok") throw new Error(`This team was closed${c.data.byName ? ` by ${c.data.byName}` : ""} - it cannot be joined any more.`);
}

// A member: this browser's shared keys are REPLACED by the team picture (personal keys stay). The caller
// (Settings > Team) takes a full backup first. Step 6 (R6.7): `addKeys` - accounts only this member has, which it
// brings in (they come back after the replace as its own changes); accounts both have that this member worked on
// become join proposals for the Team Lead, and its contacted leads for them come back too.
// 1.2.3 step 1b (D17, 10a.2): `inviteId` - the open invitation this PC joins with; its name is the member's name. It is
// written back as accepted before anything here changes, and read back: a PC that accepted the same one a moment
// earlier wins ("This invitation has just been used on another PC"). Should the join then fail, it is opened again.
export function joinTeam({ name = null, addKeys = [], inviteId = null } = {}) {
  return enqueue(async () => {
    if (await loadMembership()) throw new Error("This browser is already in a team - leave it first.");
    const root = await requireRoot();
    const team = await readTeamJson(root, [], "team.json");
    if (team.status !== "ok") throw new Error("This folder has no team in it (team.json is missing or not synced yet).");
    await refuseClosed(root);
    const memberId = randomId("m");
    const inv = await readInvite(root, inviteId, team.data.teamId, memberId);
    const file = `${inv.id}.json`;
    await writeTeamJson(root, [INVITES_DIR], file, { ...inv, status: "accepted", acceptedBy: memberId, acceptedAt: Date.now() });
    await readInvite(root, inv.id, team.data.teamId, memberId);
    try {
      return await joinWithInvite(root, team, memberId, inv.name || name, inv.id, addKeys);
    } catch (err) {
      const back = await readTeamJson(root, [INVITES_DIR], file).catch(() => null);
      if (back?.status === "ok" && back.data.acceptedBy === memberId) await writeTeamJson(root, [INVITES_DIR], file, inv).catch(() => {});
      throw err;
    }
  });
}

async function joinWithInvite(root, team, memberId, name, inviteId, addKeys) {
  {
    const t0 = performance.now();
    const m = { memberId, name: name || "Member", teamId: team.data.teamId, teamName: team.data.name, role: "member", joinedAt: new Date().toISOString(), invite: inviteId };
    await startFresh(memberId);
    const { records, update } = await readFolder(root, memberId);
    commitReadUpdate(update);
    for (const r of records) {
      applyChange(mem.state, r);
      observe(mem.clock, r.t);
    }
    // A member joining sees the team's history so far (setMembership comes later, so it is set for the log here).
    membership = m;
    await recordTeamLog(records.slice(update.baseRecords));
    membership = null;
    // Every shared key becomes exactly the team's: team rows written, rows the team does not have removed.
    let brought = { accounts: 0, proposals: 0 };
    await withAccountWriteLock(async () => {
      const values = await chrome.storage.local.get(TEAM_SHARED_KEYS);
      const local = {};
      for (const key of JOIN_KEYS) local[key] = values[key];
      const toSet = {};
      const toRemove = [];
      for (const key of TEAM_SHARED_KEYS) {
        const teamRows = projectKey(mem.state, key);
        const updates = new Map(teamRows);
        for (const rk of extractRows(key, values[key]).keys()) if (!teamRows.has(rk)) updates.set(rk, null);
        const next = patchValue(key, values[key], updates);
        mem.shadow[key] = diffRows({}, extractRows(key, next)).shadow;
        if (next === undefined) { if (values[key] !== undefined) toRemove.push(key); }
        else toSet[key] = next;
      }
      await save(["state", "shadow", "outbox", "inflight", "claims"]);
      await setMembership(m);
      if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
      if (toRemove.length) await chrome.storage.local.remove(toRemove);
      // What this member brings in, written AFTER the team picture: it differs from the shadow, so the diff sends it
      // out as this member's own changes.
      const teamValues = {};
      for (const key of JOIN_KEYS) teamValues[key] = toSet[key];
      const overlap = joinOverlap(local, teamValues, normalizeCompanyName, { contactName: contactNamer(local.targetAccountsWorkbook) });
      const wanted = new Set(addKeys || []);
      const add = overlap.localOnly.filter((a) => wanted.has(a.key)).map((a) => a.key);
      const extra = addBackValues(local, teamValues, add, overlap.shared.map((s) => ({ localKey: s.localKey, key: s.key })), normalizeCompanyName, memberId);
      if (overlap.shared.length) {
        const proposals = joinProposals(overlap.shared, {
          memberId, memberName: m.name, at: Date.now(),
          assigneeOf: (key) => activeAssignments(mem.state, "account", claimIdFor(key))[0]?.member || null,
        });
        extra[JOIN_PROPOSALS_KEY] = { ...(teamValues[JOIN_PROPOSALS_KEY] || {}), ...proposals };
      }
      if (Object.keys(extra).length) await chrome.storage.local.set(extra);
      brought = { accounts: add.length, proposals: overlap.shared.length, keys: add };
    });
    // Boaz 2026-10-06: the accounts this member brings in are assigned to them - they found them, so they work them.
    let assigned = 0;
    for (const key of brought.keys) {
      const r = await assignInner(key, null).catch(() => null);
      if (r?.ok) assigned++;
    }
    brought = { accounts: brought.accounts, proposals: brought.proposals, assigned };
    await writeProfile(root, m);
    await heartbeat(root, memberId);
    // The seller setup came with the team (it is shared), so this member does not walk the Setup wizard - only the
    // personal parts (API key, User Profile) are theirs to fill in. Live test of step 2: without this, every page
    // showed "complete your setup" after joining.
    if (!(await chrome.storage.local.get("onboardingCompletedAt")).onboardingCompletedAt) {
      await chrome.storage.local.set({ onboardingCompletedAt: Date.now() });
    }
    measure({ kind: "join", files: update.files, bytes: update.bytes, records: records.length, ms: Math.round(performance.now() - t0) });
    await save([]);
    lastOkAt = Date.now();
    errorSince = 0;
    lastError = null;
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    const after = await chrome.storage.local.get(["targetAccountsWorkbook", "results"]);
    return { ok: true, memberId, name: m.name, files: update.files, records: records.length, counts: localCounts(after), brought };
  }
}

function localCounts(values) {
  const wb = values.targetAccountsWorkbook || {};
  return { accounts: (wb.companies || []).length, contacts: (wb.contacts || []).length, leads: Object.keys(values.results || {}).length };
}

// The local copy stays as it is (a solo copy); this member's files stay in the folder for the record.
// Boaz 2026-10-06: leaving hands back this member's assigned accounts and signs off (heartbeat `left`), so colleagues
// see "left" and the accounts are free - when the folder is reachable. Otherwise the Team Lead uses Release all.
export async function leaveTeam() {
  let released = 0;
  let signedOff = false;
  leaving = true;
  try {
    if (await loadMembership()) {
      const root = await connectedRoot();
      if (root && inSyncNow()) {
        const me = membership.memberId;
        released = await enqueue(async () => {
          await ensureLoaded();
          const now = Date.now();
          let n = 0;
          for (const id of Object.keys(mem.state.entities.account || {})) {
            if (!id.startsWith("@") || !activeAssignments(mem.state, "account", id).some((x) => x.member === me)) continue;
            pushOwn({ t: tick(mem.clock, now), e: "account", id, op: "unassign" });
            n++;
          }
          if (n) await save(["state", "outbox"]);
          return n;
        });
        for (let i = 0; i < 10 && (mem.inflight || mem.outbox.length); i++) await flush(root, me);
        await enqueue(async () => {
          await writeTeamJson(root, ["members", me], "heartbeat.json",
            { member: me, name: membership.name, at: Date.now(), lastN: mem.meta.lastWrittenN, clock: tick(mem.clock, Date.now()), left: Date.now(), version: chrome.runtime.getManifest().version });
        });
        signedOff = !mem.inflight && !mem.outbox.length;
      }
    }
  } catch { /* leaving still goes ahead; the admin can release what is left */ }
  const done = await leaveLocally().finally(() => { leaving = false; });
  return { ...done, released, signedOff };
}

function leaveLocally() {
  return enqueue(async () => {
    await chrome.alarms.clear(ALARM);
    await setMembership(null);
    await teamDbClear();
    await clearTeamFolder();
    await chrome.storage.local.remove([TEAM_ACCOUNTS_KEY, TEAM_NOTICES_KEY, TEAM_LOG_KEY]);
    lastSummaryJson = null;
    mem = null;
    recentWriteBack.clear();
    lastError = null;
    lastOkAt = 0;
    errorSince = 0;
    folderState = "none";
    return { ok: true };
  });
}

// --------------------------------------------------------------------------
// Status (dev page now; top bar and claims in steps 3-4)
// --------------------------------------------------------------------------

export async function getTeamSyncStatus() {
  if (!(await loadMembership())) return { member: false };
  await enqueue(ensureLoaded);
  const meta = mem.meta;
  const members = Object.keys({ ...meta.cursors, ...meta.hb, ...meta.profiles })
    .filter((m) => m !== membership.memberId).sort()
    .map((m) => {
      const hb = meta.hb[m];
      const cursor = meta.cursors[m] || 0;
      const fileWall = meta.lastFileWall[m] || 0;
      const lastSeen = Math.max(hb?.at || 0, fileWall);
      return {
        id: m,
        name: meta.profiles[m]?.name || hb?.name || m,
        admin: leadNow().lead === m,
        deputy: leadNow().deputy === m,
        left: hb?.left || meta.removed?.[m]?.at || null,
        removed: Boolean(meta.removed?.[m]),
        online: !hb?.left && !meta.removed?.[m] && Date.now() - lastSeen <= ONLINE_MS,
        cursor,
        lastSeen,
        // Design 6.3: a heartbeat counts only once every change it vouches for has been read.
        readUpTo: readUpToOf(hb, cursor, fileWall),
      };
    });
  return {
    member: true,
    me: membership,
    lead: leadNow(),
    folder: folderState,
    outbox: mem.outbox.length,
    inflight: mem.inflight ? { n: mem.inflight.n, records: mem.inflight.changes.length } : null,
    lastWrittenN: meta.lastWrittenN,
    snapN: meta.snapN,
    lastFlushAt: meta.lastFlushAt,
    lastReadAt: meta.lastReadAt,
    lastHeartbeatAt: meta.lastHeartbeatAt,
    members,
    invites: Object.values(meta.invites || {}),
    online: members.filter((m) => m.online).length,
    lastOkAt,
    errorSince,
    entities: Object.fromEntries(Object.entries(mem.state.entities).map(([e, byId]) => [e, Object.keys(byId).length])),
    measures: meta.measures,
    lastError,
  };
}

// --------------------------------------------------------------------------
// Wiring (called once from background.js, at the top level so the listeners survive a worker restart)
// --------------------------------------------------------------------------

export function initTeamSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (TEAM_MEMBERSHIP_KEY in changes) {
      membership = changes[TEAM_MEMBERSHIP_KEY].newValue || null;
      membershipLoaded = true;
    }
    if (membershipLoaded && !membership) return;
    if (membership && GROUP_INPUT_KEYS.some((k) => k in changes)) markGroupsDirty();
    let any = false;
    for (const key of Object.keys(changes)) {
      if (isTeamSharedKey(key)) {
        dirty.add(key);
        any = true;
      }
    }
    if (any) scheduleDiff();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) runTick("alarm").catch(() => {});
  });
  // A worker that starts (again) compares every shared key once: a change made while it was asleep, or lost
  // with a worker that was stopped mid-diff, is found here - the shadow, not the event, is the reference.
  loadMembership().then((m) => {
    if (!m) return;
    for (const key of TEAM_SHARED_KEYS) dirty.add(key);
    scheduleDiff();
    chrome.alarms.get(ALARM).then((a) => { if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); }).catch(() => {});
    setTimeout(() => runTick("start").catch(() => {}), 3000);
  }).catch(() => {});
}

// background.js routes TEAM_* messages here. Returns true when it will answer asynchronously.
export function handleTeamMessage(message, sendResponse) {
  const reply = (p) => { p.then(sendResponse).catch((err) => sendResponse({ ok: false, error: err.message })); return true; };
  switch (message?.type) {
    case "TEAM_CREATE": return reply(createTeam(message));
    case "TEAM_JOIN_PREVIEW": return reply(previewJoin({ inviteId: message.inviteId || null }));
    case "TEAM_JOIN": return reply(joinTeam(message));
    case "TEAM_LEAVE": return reply(leaveTeam());
    case "TEAM_SYNC_NOW": return reply(runTick("now"));
    case "TEAM_SYNC_STATUS": return reply(getTeamSyncStatus());
    case "TEAM_MEASURE_GROUPS": return reply(measureGroups());
    case "TEAM_CLAIM": return reply(claimAccount(message.key, { kind: message.kind || "edit" }));
    case "TEAM_RELEASE": return reply(releaseAccount(message.key));
    case "TEAM_CLAIM_STATUS": return reply(getClaimStatus(message.key));
    case "TEAM_ASIDE_APPLY": return reply(applyKeptAside(message.key));
    case "TEAM_ASIDE_DISCARD": return reply(discardKeptAside(message.key));
    case "TEAM_ASSIGN": return reply(assignAccount(message.key, { to: message.to || null }));
    case "TEAM_UNASSIGN": return reply(unassignAccount(message.key));
    case "TEAM_ASSIGN_DISMISS": return reply(dismissAssignNotice(message.key));
    case "TEAM_UNASSIGN_ALL": return reply(unassignAllOf(message.member));
    case "TEAM_REMOVE_MEMBER": return reply(removeMember(message.member));
    case "TEAM_ASSIGN_COUNTS": return reply(assignmentCounts());
    case "TEAM_MAKE_LEAD": return reply(makeTeamLead(message.member));
    case "TEAM_SET_DEPUTY": return reply(setDeputy(message.member || null));
    case "TEAM_CLOSE": return reply(closeTeam());
    case "TEAM_INVITE": return reply(inviteMember({ name: message.name, email: message.email }));
    case "TEAM_CANCEL_INVITE": return reply(cancelInvite(message.id));
    default: return null;
  }
}
