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

import { withAccountWriteLock } from "./storage.js";
import { TEAM_SHARED_KEYS, isTeamSharedKey } from "./team-keys.js";
import { extractRows, diffRows, staleFieldUnsets, projectRow, projectKey, patchValue, rowTarget, rowKey, splitRowKey, canonicalRow } from "./team-rows.js";
import { newState, applyChange, createClock, tick, observe, formatStamp, compactChanges } from "./team-merge.js";
import {
  teamDbGetAll, teamDbPutAll, teamDbClear, getTeamFolder, clearTeamFolder, teamFolderPermission,
  readTeamJson, writeTeamJson, listTeamNames, removeTeamFile, listTeamFolderTop,
} from "./team-folder.js";

export const TEAM_MEMBERSHIP_KEY = "teamMembership";
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

function emptyMeta() {
  return {
    nextN: 1, lastWrittenN: 0, clockLast: null, cursors: {}, lastFileWall: {}, hb: {}, profiles: {}, admins: [],
    basesApplied: [], ownFiles: [], snapN: 0, lastFlushAt: 0, lastReadAt: 0, lastHeartbeatAt: 0,
    lastCompactDay: null, measures: [],
  };
}

async function ensureLoaded() {
  if (mem) return mem;
  const got = await teamDbGetAll(["state", "shadow", "outbox", "inflight", "meta"]);
  mem = {
    state: got.state || newState(),
    shadow: got.shadow || {},
    outbox: got.outbox || [],
    inflight: got.inflight || null,
    meta: { ...emptyMeta(), ...(got.meta || {}) },
  };
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
  if (records.length) {
    for (const r of records) applyChange(mem.state, r);
    mem.outbox.push(...records);
  }
  measure({ kind: "diff", keys: keys.join(","), rows: rowCount, records: records.length, ms: Math.round(performance.now() - t0) });
  await save(["state", "shadow", "outbox"]);
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
async function applyRemote(records) {
  const affected = new Set();
  for (const r of records) {
    if (!applyChange(mem.state, r)) continue;
    observe(mem.clock, r.t);
    if (rowTarget(r.e, r.id)) affected.add(rowKey(r.e, r.id));
  }
  await save(["state"]);
  if (affected.size) await writeBack(affected);
  return affected.size;
}

// Outside the queue (file reading is slow). Reads base files and every colleague's new change files in order.
async function readFolder(root, me, { includeSelf = false } = {}) {
  const meta = mem.meta;
  const records = [];
  const update = { cursors: {}, lastFileWall: {}, hb: {}, profiles: {}, basesApplied: [], files: 0, bytes: 0 };
  update.admins = (await listTeamNames(root, ["admins"], "file"))
    .map((n) => (/^(.+)\.json$/.exec(n) || [])[1]).filter(Boolean);
  for (const name of await listTeamNames(root, ["base"], "file")) {
    if (meta.basesApplied.includes(name)) continue;
    const r = await readTeamJson(root, ["base"], name);
    if (r.status !== "ok") continue;
    records.push(...(r.data.changes || []));
    update.basesApplied.push(name);
    update.files += 1;
    update.bytes += r.bytes;
  }
  for (const m of await listTeamNames(root, ["members"], "directory")) {
    if (m === me && !includeSelf) continue;
    const hb = await readTeamJson(root, ["members", m], "heartbeat.json");
    if (hb.status === "ok") update.hb[m] = { at: hb.data.at, lastN: hb.data.lastN || 0 };
    if (!meta.profiles[m]) {
      const p = await readTeamJson(root, ["members", m], "profile.json");
      if (p.status === "ok") update.profiles[m] = p.data;
    }
    let cursor = meta.cursors[m] || 0;
    let snapshots = null;
    while (update.files < MAX_FILES_PER_ROUND) {
      const r = await readTeamJson(root, ["members", m, "changes"], `c-${cursor + 1}.json`);
      if (r.status === "ok") {
        records.push(...(r.data.changes || []));
        cursor += 1;
        update.lastFileWall[m] = Date.parse(r.data.written) || Date.now();
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
    update.cursors[m] = cursor;
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
    measure({ kind: "flush", n: batch.n, records: batch.changes.length, bytes: w.bytes, attempts: w.attempts, ms: Math.round(performance.now() - t0) });
    await save(["inflight"]);
  });
  return true;
}

async function readRound(root, me) {
  const t0 = performance.now();
  const { records, update } = await readFolder(root, me);
  await enqueue(async () => {
    commitReadUpdate(update);
    const rows = records.length ? await applyRemote(records) : 0;
    measure({ kind: "read", files: update.files, bytes: update.bytes, records: records.length, rows, ms: Math.round(performance.now() - t0) });
    await save([]);
  });
}

async function heartbeat(root, me) {
  await writeTeamJson(root, ["members", me], "heartbeat.json",
    { member: me, name: membership.name, at: Date.now(), lastN: mem.meta.lastWrittenN, version: chrome.runtime.getManifest().version });
  mem.meta.lastHeartbeatAt = Date.now();
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
    if (reason === "now" || now - mem.meta.lastReadAt >= READ_EVERY_MS - 1000) await readRound(root, me);
    if (now - Math.max(mem.meta.lastHeartbeatAt, mem.meta.lastFlushAt) >= HEARTBEAT_EVERY_MS) await heartbeat(root, me);
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
    if (membership && folderState === "granted") scheduleTick(mem?.outbox?.length ? FLUSH_DELAY_MS : READ_EVERY_MS);
  }
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
  mem = { state: newState(), shadow: {}, outbox: [], inflight: null, meta: emptyMeta() };
  mem.clock = createClock(memberId);
  recentWriteBack.clear();
}

async function setMembership(value) {
  membership = value;
  membershipLoaded = true;
  if (value) await chrome.storage.local.set({ [TEAM_MEMBERSHIP_KEY]: value });
  else await chrome.storage.local.remove(TEAM_MEMBERSHIP_KEY);
}

async function writeProfile(root, m) {
  await writeTeamJson(root, ["members", m.memberId], "profile.json",
    { member: m.memberId, name: m.name, joinedAt: m.joinedAt, version: chrome.runtime.getManifest().version });
}

// The creator: an empty folder becomes the team; this member's shared data becomes its base.
export function createTeam({ name, teamName }) {
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
    for (const r of base) applyChange(mem.state, r);
    await writeTeamJson(root, [], "team.json", { teamId: m.teamId, name: m.teamName, format: FORMAT, createdBy: memberId, createdAt: m.joinedAt });
    await writeTeamJson(root, ["admins"], `${memberId}.json`, { member: memberId, grantedBy: memberId, at: m.joinedAt });
    await writeProfile(root, m);
    const baseName = `base-${m.joinedAt.replace(/[:.]/g, "-")}.json`;
    const w = await writeTeamJson(root, ["base"], baseName, { member: memberId, written: m.joinedAt, kind: "base", changes: base });
    mem.meta.basesApplied = [baseName];
    measure({ kind: "create", records: base.length, bytes: w.bytes, ms: Math.round(performance.now() - t0) });
    await save(["state", "shadow", "outbox", "inflight"]);
    await setMembership(m);
    lastOkAt = Date.now();
    errorSince = 0;
    lastError = null;
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    return { ok: true, memberId, records: base.length, bytes: w.bytes, counts: localCounts(values) };
  });
}

// A member: this browser's shared keys are REPLACED by the team picture (personal keys stay). The caller
// (dev page; Settings > Team in step 3) takes a full backup first.
export function joinTeam({ name }) {
  return enqueue(async () => {
    if (await loadMembership()) throw new Error("This browser is already in a team - leave it first.");
    const root = await requireRoot();
    const team = await readTeamJson(root, [], "team.json");
    if (team.status !== "ok") throw new Error("This folder has no team in it (team.json is missing or not synced yet).");
    const t0 = performance.now();
    const memberId = randomId("m");
    const m = { memberId, name: name || "Member", teamId: team.data.teamId, teamName: team.data.name, role: "member", joinedAt: new Date().toISOString() };
    await startFresh(memberId);
    const { records, update } = await readFolder(root, memberId);
    commitReadUpdate(update);
    for (const r of records) {
      applyChange(mem.state, r);
      observe(mem.clock, r.t);
    }
    // Every shared key becomes exactly the team's: team rows written, rows the team does not have removed.
    await withAccountWriteLock(async () => {
      const values = await chrome.storage.local.get(TEAM_SHARED_KEYS);
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
      await save(["state", "shadow", "outbox", "inflight"]);
      await setMembership(m);
      if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
      if (toRemove.length) await chrome.storage.local.remove(toRemove);
    });
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
    return { ok: true, memberId, files: update.files, records: records.length, counts: localCounts(after) };
  });
}

function localCounts(values) {
  const wb = values.targetAccountsWorkbook || {};
  return { accounts: (wb.companies || []).length, contacts: (wb.contacts || []).length, leads: Object.keys(values.results || {}).length };
}

// The local copy stays as it is (a solo copy); this member's files stay in the folder for the record.
export function leaveTeam() {
  return enqueue(async () => {
    await chrome.alarms.clear(ALARM);
    await setMembership(null);
    await teamDbClear();
    await clearTeamFolder();
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
        admin: (meta.admins || []).includes(m),
        online: Date.now() - lastSeen <= ONLINE_MS,
        cursor,
        lastSeen,
        // Design 6.3: a heartbeat counts only once every change it vouches for has been read.
        readUpTo: hb && cursor >= (hb.lastN || 0) ? Math.max(hb.at, fileWall) : fileWall,
      };
    });
  return {
    member: true,
    me: membership,
    folder: folderState,
    outbox: mem.outbox.length,
    inflight: mem.inflight ? { n: mem.inflight.n, records: mem.inflight.changes.length } : null,
    lastWrittenN: meta.lastWrittenN,
    snapN: meta.snapN,
    lastFlushAt: meta.lastFlushAt,
    lastReadAt: meta.lastReadAt,
    lastHeartbeatAt: meta.lastHeartbeatAt,
    members,
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
    case "TEAM_JOIN": return reply(joinTeam(message));
    case "TEAM_LEAVE": return reply(leaveTeam());
    case "TEAM_SYNC_NOW": return reply(runTick("now"));
    case "TEAM_SYNC_STATUS": return reply(getTeamSyncStatus());
    default: return null;
  }
}
