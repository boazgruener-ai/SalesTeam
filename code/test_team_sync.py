"""Runs the REAL team sync layer (team-sync.js) for several simulated members - 1.2.2 build step 2.

Each member is its own V8 context (py_mini_racer) with a fake chrome.storage.local, fake timers and a fake
IndexedDB; the team folder is one dict of path -> text that this script hands from member to member, so the
members share a folder with no sync delay. What runs is the shipped code: team-sync.js, team-rows.js,
team-keys.js and team-merge.js, with only team-folder.js (File System Access) and storage.js (the account
write lock) replaced by the stubs below.

    set PYTHONDONTWRITEBYTECODE=1
    python code/test_team_sync.py
"""
import io
import json
import os
import re
import sys

from py_mini_racer import MiniRacer

CODE_DIR = os.path.dirname(os.path.abspath(__file__))
REAL = ["value-normalize.js", "web-research-apply.js", "web-findings-arbitration.js", "geo-regions.js", "team-groups.js", "team-merge.js", "team-keys.js", "team-rows.js", "team-claims.js", "team-log.js", "team-join.js", "team-invites.js", "team-sync.js"]
IMPORT_RE = re.compile(r"""^\s*import\s+[^;]*?from\s+["\']([^"\']+)["\']\s*;\s*$""", re.M | re.S)

FAKES = r"""
var NOW = 1759480000000;
// Every clock the code reads - Date.now(), new Date() - follows NOW, so days can pass in a test.
var RealDate = Date;
function FakeDate() {
  if (arguments.length === 0) return new RealDate(NOW);
  return new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))();
}
FakeDate.now = function () { return NOW; };
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
FakeDate.prototype = RealDate.prototype;
Date = FakeDate;
var performance = { now: function () { return NOW; } };
var TIMERS = [], TIMER_ID = 0;
function setTimeout(fn, ms) { TIMER_ID += 1; TIMERS.push({ id: TIMER_ID, at: NOW + (ms || 0), fn: fn }); return TIMER_ID; }
function clearTimeout(id) { TIMERS = TIMERS.filter(function (t) { return t.id !== id; }); }
// Runs the next timer due by `target`; false when none is left. One timer per eval, so its promises settle.
function runNextTimer(target) {
  TIMERS.sort(function (a, b) { return a.at - b.at; });
  var t = TIMERS[0];
  if (!t || t.at > target) { NOW = Math.max(NOW, target); return false; }
  TIMERS.shift();
  NOW = Math.max(NOW, t.at);
  t.fn();
  return true;
}
var clone = function (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };

// chrome.storage.local - values are cloned on the way in and out, like the real one.
var STORE = {}, LISTENERS = [], ALARMS = {};
function fire(changes) { LISTENERS.forEach(function (l) { Promise.resolve().then(function () { l(clone(changes), 'local'); }); }); }
var chrome = {
  storage: {
    local: {
      get: function (keys) {
        var out = {};
        (typeof keys === 'string' ? [keys] : keys).forEach(function (k) { if (k in STORE) out[k] = clone(STORE[k]); });
        return Promise.resolve(out);
      },
      set: function (obj) {
        var changes = {};
        Object.keys(obj).forEach(function (k) { changes[k] = { oldValue: STORE[k], newValue: clone(obj[k]) }; STORE[k] = clone(obj[k]); });
        fire(changes);
        return Promise.resolve();
      },
      remove: function (keys) {
        var changes = {};
        [].concat(keys).forEach(function (k) { if (k in STORE) { changes[k] = { oldValue: STORE[k] }; delete STORE[k]; } });
        fire(changes);
        return Promise.resolve();
      },
    },
    onChanged: { addListener: function (fn) { LISTENERS.push(fn); } },
  },
  alarms: {
    create: function (name, o) { ALARMS[name] = o; return Promise.resolve(); },
    clear: function (name) { delete ALARMS[name]; return Promise.resolve(true); },
    get: function (name) { return Promise.resolve(ALARMS[name]); },
    onAlarm: { addListener: function () {} },
  },
  runtime: { getManifest: function () { return { version: 'test' }; } },
};

// storage.js stub: one writer at a time is all the test needs.
function withAccountWriteLock(fn) { return fn(); }
// 1.2.3: the account views the group computation reads (VIEWS - set by a test), and storage.js's size buckets.
var VIEWS = [];
function getAccountViews() { return Promise.resolve(clone(VIEWS)); }
var SIZE_PRIORITY_BUCKETS = [{ key: 'S', min: 0, max: 200 }, { key: 'M', min: 201, max: 500 }, { key: 'L', min: 501, max: 1000 },
  { key: 'XL', min: 1001, max: 5000 }, { key: 'XXL', min: 5001, max: Infinity }];
function normalizeCompanyName(n) { return String(n || '').toLowerCase().trim(); }
function contactKeyFor(company, fullName) { var c = normalizeCompanyName(company), n = String(fullName || '').toLowerCase().trim(); return c && n ? c + '::' + n : null; }

// team-folder.js stub: FOLDER is the shared folder (path -> text), DB the sync layer's IndexedDB.
var FOLDER = {}, DB = {}, FAIL_NEXT_WRITES = 0;
var ROOT = { root: true };
function teamDbGetAll(keys) { var out = {}; keys.forEach(function (k) { out[k] = clone(DB[k]); }); return Promise.resolve(out); }
function teamDbPutAll(entries) { Object.keys(entries).forEach(function (k) { DB[k] = clone(entries[k]); }); return Promise.resolve(); }
function teamDbClear() { DB = {}; return Promise.resolve(); }
var FOLDER_CLEARED = false;
function getTeamFolder() { return Promise.resolve(ROOT); }
function clearTeamFolder() { FOLDER_CLEARED = true; return Promise.resolve(); }
function teamFolderPermission() { return Promise.resolve('granted'); }
function pathOf(parts, name) { return parts.concat([name]).join('/'); }
function readTeamJson(root, parts, name) {
  var p = pathOf(parts, name);
  if (!(p in FOLDER)) return Promise.resolve({ status: 'missing' });
  var text = FOLDER[p];
  if (!text) return Promise.resolve({ status: 'incomplete' });
  try { return Promise.resolve({ status: 'ok', data: JSON.parse(text), text: text, bytes: text.length }); }
  catch (e) { return Promise.resolve({ status: 'incomplete' }); }
}
function writeTeamJson(root, parts, name, obj) {
  if (FAIL_NEXT_WRITES > 0) { FAIL_NEXT_WRITES -= 1; FOLDER[pathOf(parts, name)] = ''; return Promise.reject(new Error('InvalidStateError (simulated)')); }
  var text = JSON.stringify(obj);
  FOLDER[pathOf(parts, name)] = text;
  return Promise.resolve({ attempts: 1, bytes: text.length });
}
function listTeamNames(root, parts, kind) {
  var prefix = parts.length ? parts.join('/') + '/' : '';
  var names = {};
  Object.keys(FOLDER).forEach(function (p) {
    if (p.indexOf(prefix) !== 0) return;
    var rest = p.slice(prefix.length).split('/');
    if (kind === 'file' && rest.length === 1) names[rest[0]] = true;
    if (kind === 'directory' && rest.length > 1) names[rest[0]] = true;
  });
  return Promise.resolve(Object.keys(names).sort());
}
function removeTeamFile(root, parts, name) { var p = pathOf(parts, name); var had = p in FOLDER; delete FOLDER[p]; return Promise.resolve(had); }
function listTeamFolderTop() {
  var names = {};
  Object.keys(FOLDER).forEach(function (p) { names[p.split('/')[0]] = true; });
  return Promise.resolve(Object.keys(names).sort());
}
var LAST = null;
function run(p) { LAST = { pending: true }; p.then(function (r) { LAST = r; }, function (e) { LAST = { error: String(e && e.message || e) }; }); }
"""

_failures = []
_passes = 0


def check(label, actual, expected):
    global _passes
    if actual == expected:
        _passes += 1
    else:
        _failures.append("%s\n    expected: %r\n    actual:   %r" % (label, expected, actual))


def strip_module(name):
    src = io.open(os.path.join(CODE_DIR, name), encoding="utf-8").read()
    src = IMPORT_RE.sub("", src)
    # The read-round size can be made small, so a long history is read back over several rounds as on a real PC.
    src = src.replace("const MAX_FILES_PER_ROUND = ", "let MAX_FILES_PER_ROUND = ")
    return re.sub(r"^export\s+(?=(const|let|var|function|class|async)\b)", "", src, flags=re.M)


class Member:
    """One browser profile: its own context, storage, timers and IndexedDB."""

    def __init__(self, label, now_offset=0, before_notes=False):
        self.label = label
        self.ctx = MiniRacer()
        self.ctx.eval(FAKES)
        self.ctx.eval("NOW += %d;" % now_offset)
        self.ctx.eval("\n".join("// ===== %s =====\n%s" % (n, strip_module(n)) for n in REAL))
        if before_notes:
            # A colleague who has not updated yet (1.2.3): the same sync layer, but "notes" is not a shared key.
            self.ctx.eval("TEAM_MAP_KEYS.splice(TEAM_MAP_KEYS.findIndex(function (m) { return m.key === 'notes'; }), 1);"
                          "TEAM_SHARED_KEYS.splice(TEAM_SHARED_KEYS.indexOf('notes'), 1);")
        self.ctx.eval("initTeamSync();")
        self.settle()

    def e(self, js):
        return self.ctx.eval(js)

    def settle(self):
        self.ctx.eval("void 0")

    def set_local(self, values):
        self.e("chrome.storage.local.set(%s)" % json.dumps(values))
        self.settle()

    def local(self, key):
        return json.loads(self.e("JSON.stringify(STORE[%s] === undefined ? null : STORE[%s])" % (json.dumps(key), json.dumps(key))))

    def advance(self, ms):
        target = self.e("NOW + %d" % ms)
        while self.e("runNextTimer(%d)" % target):
            self.settle()
        self.settle()

    def call(self, js, folder):
        """Runs an async team-sync call against the shared folder; returns its result and the folder after."""
        self.e("FOLDER = %s;" % json.dumps(folder))
        self.e("run(%s)" % js)
        for _ in range(50):
            self.settle()
            if not self.e("LAST && LAST.pending === true"):
                break
            self.advance(1000)
        result = json.loads(self.e("JSON.stringify(LAST)"))
        return result, json.loads(self.e("JSON.stringify(FOLDER)"))

    def sync(self, folder):
        """Notices local changes (debounced diff), then one folder round: flush, read, write back."""
        self.e("FOLDER = %s;" % json.dumps(folder))
        self.advance(1500)
        folder = json.loads(self.e("JSON.stringify(FOLDER)"))  # a timer may have run a round meanwhile
        result, folder = self.call("runTick('now')", folder)
        self.advance(1500)  # our own write-back comes round through onChanged: must not be sent out again
        return result, json.loads(self.e("JSON.stringify(FOLDER)"))

    def status(self):
        self.e("run(getTeamSyncStatus())")
        self.settle()
        return json.loads(self.e("JSON.stringify(LAST)"))


SHARED = ["targetAccountsWorkbook", "targetAccounts", "results", "negativeTopics", "targetAccountExtras"]


def picture(m):
    return {k: m.local(k) for k in SHARED}


def deep_sorted(v):
    if isinstance(v, dict):
        return {k: deep_sorted(v[k]) for k in sorted(v)}
    if isinstance(v, list):
        rows = [deep_sorted(x) for x in v]
        # Workbook rows (dicts with an id) are compared as a set: a member who joins later gets the rows laid out
        # in the team's order, not in the order they were added on one PC - the table sorts them anyway.
        if rows and all(isinstance(x, dict) and any(k in x for k in ("companyId", "contactId", "initiativeId")) for x in rows):
            rows.sort(key=lambda x: json.dumps(x, sort_keys=True))
        return rows
    return v


def same(a, b):
    return json.dumps(deep_sorted(a)) == json.dumps(deep_sorted(b))


def invite(lead, name, folder, email=""):
    """1.2.3 step 1b (D17): nobody joins without an invitation - the Team Lead writes one first."""
    r, folder = lead.call("inviteMember({ name: %s, email: %s })" % (json.dumps(name), json.dumps(email)), folder)
    return (r.get("invite") or {}).get("id"), folder


def main():
    folder = {}
    anna = Member("anna")
    anna.set_local({
        "targetAccountsWorkbook": {
            "companies": [
                {"companyId": "c-1", "company": "Acme AG", "status": "New", "city": "Bern"},
                {"companyId": "c-2", "company": "Beta SA", "status": "New"},
            ],
            "contacts": [{"contactId": "p-1", "companyId": "c-1", "fullName": "Ann Muster"}],
            "aiInitiatives": [], "aiInvestment": [], "sources": [],
        },
        "targetAccounts": {"acme ag": {"score": 80}, "beta sa": {"score": 40}},
        "results": {"lead-1": {"author": "Ann", "status": "New", "draftMessage": "Anna's draft"},
                    "lead-2": {"author": "Bob", "status": "New"}},
        "negativeTopics": ["jobs"],
        "anthropicApiKey": "sk-anna",
    })

    # 1. Anna creates the team: the folder gets team.json, her profile and the base.
    r, folder = anna.call("createTeam({ name: 'Anna', teamName: 'Test team' })", folder)
    check("create: ok", r.get("ok"), True)
    check("create: team.json written", "team.json" in folder, True)
    check("create: one base file", len([p for p in folder if p.startswith("base/")]), 1)
    base = json.loads([v for p, v in folder.items() if p.startswith("base/")][0])
    check("create: Anna's draft is not in the base", "Anna's draft" in json.dumps(base), False)
    check("create: the API key is not in the base", "sk-anna" in json.dumps(base), False)
    r, folder = anna.sync(folder)
    check("create: nothing to send right after creating", anna.status()["lastWrittenN"], 0)

    # 2. Ben joins: his shared data becomes the team's, his personal data stays.
    ben = Member("ben", now_offset=7)
    ben.set_local({
        "targetAccountsWorkbook": {"companies": [{"companyId": "c-9", "company": "Ben Corp"}], "contacts": []},
        "results": {"lead-9": {"author": "Zed", "draftMessage": "Ben's draft"}},
        "negativeTopics": ["hiring"],
        "anthropicApiKey": "sk-ben",
    })
    r, folder = ben.call("joinTeam({ name: 'Ben' })", folder)
    check("invite: joining without an invitation is refused", ("no invitation" in (r.get("error") or ""), ben.local("teamMembership")), (True, None))
    inv, folder = invite(ben, "Ben", folder)
    check("invite: a non-member cannot invite", inv, None)
    inv, folder = invite(anna, "Ben", folder, "ben@example.com")
    check("invite: the Team Lead invites - invites/<id>.json, open", json.loads(folder["invites/%s.json" % inv])["status"], "open")
    r, folder = ben.call("joinTeam({ name: 'Benjamin', inviteId: '%s' })" % inv, folder)
    check("join: ok", r.get("ok"), True)
    check("invite: Ben joins with the invitation's name", (r.get("name"), ben.local("teamMembership")["name"]), ("Ben", "Ben"))
    acc = json.loads(folder["invites/%s.json" % inv])
    check("invite: written back as accepted by Ben", (acc["status"], acc["acceptedBy"]), ("accepted", r.get("memberId")))
    bob = Member("bob", now_offset=9)
    r2, folder = bob.call("joinTeam({ inviteId: '%s' })" % inv, folder)
    check("invite: an invitation cannot be used twice", ("another PC" in (r2.get("error") or ""), bob.local("teamMembership")), (True, None))
    inv2, folder = invite(anna, "Bob", folder)
    r2, folder = anna.call("cancelInvite('%s')" % inv2, folder)
    check("invite: cancelled", (r2.get("ok"), json.loads(folder["invites/%s.json" % inv2])["status"]), (True, "cancelled"))
    r2, folder = bob.call("joinTeam({ inviteId: '%s' })" % inv2, folder)
    check("invite: a cancelled invitation is refused", ("cancelled" in (r2.get("error") or ""), bob.local("teamMembership")), (True, None))
    r2, folder = anna.call("cancelInvite('%s')" % inv, folder)
    check("invite: an accepted invitation cannot be cancelled", (r2.get("ok"), r2.get("reason")), (False, "accepted"))
    check("join: Ben has the team's picture", same(picture(ben), {**picture(anna), "results": {
        "lead-1": {"author": "Ann", "status": "New"}, "lead-2": {"author": "Bob", "status": "New"}}}), True)
    check("join: Ben keeps his API key", ben.local("anthropicApiKey"), "sk-ben")
    r, folder = ben.sync(folder)
    check("join: joining sends nothing back (no echo)", ben.status()["lastWrittenN"], 0)

    # 3. Anna edits; Ben gets it; Ben's write-back is not echoed.
    wb = anna.local("targetAccountsWorkbook")
    wb["companies"][0]["status"] = "Contacted"
    anna.set_local({"targetAccountsWorkbook": wb})
    r, folder = anna.sync(folder)
    check("edit: Anna wrote one change file", "members/%s/changes/c-1.json" % anna.status()["me"]["memberId"] in folder, True)
    c1 = json.loads(folder["members/%s/changes/c-1.json" % anna.status()["me"]["memberId"]])
    check("edit: one record, one field", [(x["id"], sorted(x["f"])) for x in c1["changes"]], [("wb:c-1", ["status"])])
    r, folder = ben.sync(folder)
    check("edit: Ben sees Anna's status", ben.local("targetAccountsWorkbook")["companies"][0]["status"], "Contacted")
    check("edit: Ben sent nothing back", ben.status()["lastWrittenN"], 0)

    # 4. Both edit the same company at once: different fields both survive, the same field goes to the later one.
    wa = anna.local("targetAccountsWorkbook"); wa["companies"][0]["city"] = "Zurich"; wa["companies"][0]["note"] = "Anna"
    anna.set_local({"targetAccountsWorkbook": wa})
    anna.advance(1500)
    wbn = ben.local("targetAccountsWorkbook"); wbn["companies"][0]["phone"] = "+41"; wbn["companies"][0]["note"] = "Ben"
    ben.set_local({"targetAccountsWorkbook": wbn})
    ben.advance(1500)
    r, folder = anna.sync(folder)
    r, folder = ben.sync(folder)
    r, folder = anna.sync(folder)
    a_c1 = anna.local("targetAccountsWorkbook")["companies"][0]
    check("concurrent: Anna's city and Ben's phone both kept", (a_c1.get("city"), a_c1.get("phone")), ("Zurich", "+41"))
    check("concurrent: the same field goes to the later change (Ben)", a_c1.get("note"), "Ben")
    check("concurrent: Anna and Ben have the same picture", same(picture(anna)["targetAccountsWorkbook"], picture(ben)["targetAccountsWorkbook"]), True)

    # 5. Leads: Ben deletes one, Anna edits her (personal) draft and a shared field of the other.
    rb = ben.local("results"); del rb["lead-2"]; ben.set_local({"results": rb})
    ra = anna.local("results"); ra["lead-1"]["draftMessage"] = "Anna's new draft"; ra["lead-1"]["status"] = "Contacted"
    anna.set_local({"results": ra})
    r, folder = ben.sync(folder)
    r, folder = anna.sync(folder)
    r, folder = ben.sync(folder)
    check("leads: Ben's delete reached Anna", "lead-2" in anna.local("results"), False)
    check("leads: Anna keeps her draft", anna.local("results")["lead-1"].get("draftMessage"), "Anna's new draft")
    check("leads: Ben gets the status, not the draft", ben.local("results")["lead-1"], {"author": "Ann", "status": "Contacted"})

    # 6. A writer outside the lock puts an old map back over a remote change: undone, not sent to the team.
    stale = ben.local("negativeTopics")
    anna.set_local({"negativeTopics": ["jobs", "recruiting"]})
    r, folder = anna.sync(folder)
    sent_before = ben.status()["lastWrittenN"]
    r, folder = ben.sync(folder)
    check("clobber: Ben got Anna's topics", ben.local("negativeTopics"), ["jobs", "recruiting"])
    ben.set_local({"negativeTopics": stale})   # the stale writer saves its old copy
    r, folder = ben.sync(folder)
    check("clobber: the stale copy is undone on Ben's PC", ben.local("negativeTopics"), ["jobs", "recruiting"])
    check("clobber: ... and never sent to the team", ben.status()["lastWrittenN"], sent_before)
    r, folder = anna.sync(folder)
    check("clobber: Anna still has her topics", anna.local("negativeTopics"), ["jobs", "recruiting"])

    # 7. A failed write (OneDrive's InvalidStateError) leaves an empty file: readers skip it, the writer retries.
    ta = anna.local("targetAccounts"); ta["acme ag"]["score"] = 95; anna.set_local({"targetAccounts": ta})
    anna.e("FAIL_NEXT_WRITES = 1;")
    r, folder = anna.sync(folder)
    check("failed write: reported, not lost", bool(r.get("error")), True)
    r, folder = ben.sync(folder)
    check("failed write: Ben skips the empty file", ben.local("targetAccounts")["acme ag"]["score"], 80)
    r, folder = anna.sync(folder)
    r, folder = ben.sync(folder)
    check("failed write: the retry gets through", ben.local("targetAccounts")["acme ag"]["score"], 95)

    # 8. Status: who is there, and what has been read from them (design 6.3).
    st = ben.status()
    check("status: Ben sees Anna", [m["name"] for m in st["members"]], ["Anna"])
    check("status: Ben has read everything Anna wrote", st["members"][0]["cursor"], anna.status()["lastWrittenN"])
    check("status: comparison cost is measured", any(x["kind"] == "diff" for x in st["measures"]), True)
    # Step 3 (Settings > Team): roles, online, what joining does to the setup.
    check("status: Ben sees Anna as Team Admin", st["members"][0]["admin"], True)
    check("status: Anna counts as online (written just now)", (st["members"][0]["online"], st["online"]), (True, 1))
    check("status: a good round is remembered, no error", (st["lastOkAt"] > 0, st["errorSince"], st["lastError"]), (True, 0, None))
    check("join: Ben's setup counts as done (it came with the team)", bool(ben.local("onboardingCompletedAt")), True)
    check("status: Anna sees Ben as a member, not an admin", [m["admin"] for m in anna.status()["members"]], [False])

    # 1.2.3 Export & Import step 1: the Team Lead's import (rows appended, importRun on every touched account) reaches
    # Ben without deleting the account his web research found, and his team log shows it as ONE line.
    wb = ben.local("targetAccountsWorkbook")
    wb["companies"].append({"companyId": "W-1", "company": "Webfound AG", "source": "Web"})
    ben.set_local({"targetAccountsWorkbook": wb})
    r, folder = ben.sync(folder)
    r, folder = anna.sync(folder)
    run = {"id": "imp-9", "file": "research.xlsx", "at": 1, "by": "Anna", "summary": "1 new account, 1 empty field filled"}
    wb = anna.local("targetAccountsWorkbook")
    wb["companies"].append({"companyId": "C-9", "company": "Gamma AG", "source": "Workbook"})
    wb["contacts"].append({"contactId": "P-9", "companyId": "C-9", "fullName": "Gil"})
    ex = anna.local("targetAccountExtras") or {}
    ex["gamma ag"] = {"importRun": run}
    ex["acme ag"] = {**ex.get("acme ag", {}), "overrides": {"industry": "Banking"}, "importRun": run}
    anna.set_local({"targetAccountsWorkbook": wb, "targetAccountExtras": ex})
    r, folder = anna.sync(folder)
    r, folder = ben.sync(folder)
    names = sorted(c["company"] for c in ben.local("targetAccountsWorkbook")["companies"])
    check("import: Ben gets the new account and keeps his web-found one", ("Gamma AG" in names, "Webfound AG" in names), (True, True))
    check("import: Anna keeps Ben's web-found account too", "Webfound AG" in [c["company"] for c in anna.local("targetAccountsWorkbook")["companies"]], True)
    lines = [x for x in ben.local("teamLog") or [] if x.get("kind") == "import"]
    check("import: Ben's team log has one line for the import", [(x.get("ref"), sorted(x.get("accounts") or [])) for x in lines],
          [("research.xlsx", ["acme ag", "gamma ag"])])

    # 9. Eight days later Anna compacts; a new member still gets the full picture.
    anna.e("NOW += 8 * 24 * 3600 * 1000; DB.meta.lastCompactDay = null; if (mem) mem.meta.lastCompactDay = null;")
    ta = anna.local("targetAccounts"); ta["beta sa"]["score"] = 41; anna.set_local({"targetAccounts": ta})
    r, folder = anna.sync(folder)
    check("compact: the round ran without error", r, {"ok": True})
    me = anna.status()["me"]["memberId"]
    snaps = [p for p in folder if p.startswith("members/%s/snapshots/" % me)]
    left = [p for p in folder if p.startswith("members/%s/changes/" % me)]
    check("compact: one snapshot written", len(snaps), 1)
    check("compact: only the newest change file is left", len(left), 1)
    cleo = Member("cleo", now_offset=8 * 24 * 3600 * 1000 + 20)
    r, folder = anna.sync(folder)
    check("invite: Anna is told Ben joined", [n["text"].split(".")[0] for n in anna.local("teamNotices") or [] if n.get("kind") == "joined"], ["Ben joined the team"])
    st = anna.status()
    check("invite: status lists the invitations", sorted(i["status"] for i in st.get("invites", [])), ["accepted", "cancelled"])
    inv, folder = invite(anna, "Cleo", folder)
    r, folder = cleo.call("joinTeam({ inviteId: '%s' })" % inv, folder)
    r, folder = ben.sync(folder)
    check("compact: Cleo joining after compaction has the same picture as Anna",
          same({k: v for k, v in picture(cleo).items() if k != "results"}, {k: v for k, v in picture(anna).items() if k != "results"}), True)
    check("compact: ... and as Ben", same(picture(cleo), picture(ben)), True)

    # 10. Cleo leaves: sync stops, her data stays, the folder is forgotten on her PC, her files stay in the folder.
    me = cleo.status()["me"]["memberId"]
    r, folder = cleo.call("leaveTeam()", folder)
    check("leave: ok", r.get("ok"), True)
    check("leave: no longer a member", cleo.status(), {"member": False})
    check("leave: her data stays", same(picture(cleo)["targetAccounts"], picture(ben)["targetAccounts"]), True)
    check("leave: the team folder is forgotten on her PC", cleo.e("FOLDER_CLEARED"), True)
    check("leave: her files stay in the folder", any(p.startswith("members/%s/" % me) for p in folder), True)

    # 11. Step 4 - claims (design 6). Two fresh members on a fresh folder, clocks aligned.
    folder = {}
    dora = Member("dora")
    dora.set_local({
        "targetAccountsWorkbook": {"companies": [
            {"companyId": "c-1", "company": "Acme AG"}, {"companyId": "c-2", "company": "Beta SA"}], "contacts": []},
        "targetAccountExtras": {"acme ag": {"status": "New"}, "beta sa": {"status": "New"}},
    })
    r, folder = dora.call("createTeam({ name: 'Dora', teamName: 'Claims', invites: [{ name: 'Eli', email: 'eli@example.com' }, { name: 'Fay' }, { name: '' }] })", folder)
    check("create with invitations: two written, open", (r.get("invited"), sorted(json.loads(v)["name"] for p, v in folder.items() if p.startswith("invites/"))), (2, ["Eli", "Fay"]))
    invited = {json.loads(v)["name"]: json.loads(v)["id"] for p, v in folder.items() if p.startswith("invites/")}
    check("create: team.json names the creator", json.loads(folder["team.json"]).get("createdByName"), "Dora")
    eli = Member("eli")
    r, folder = eli.call("joinTeam({ inviteId: '%s' })" % invited["Eli"], folder)
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    dora_id = dora.status()["me"]["memberId"]
    eli_id = eli.status()["me"]["memberId"]

    def files_of(member_id):
        return [json.loads(v) for k, v in sorted(folder.items()) if k.startswith("members/%s/changes/" % member_id) and v]

    def sent_values(member_id, row_id, field):
        return [c["f"][field] for f in files_of(member_id) for c in f["changes"]
                if c.get("id") == row_id and c.get("op") == "set" and field in c.get("f", {})]

    def extras(m, key):
        return (m.local("targetAccountExtras") or {}).get(key, {})

    # A. Dora claims Acme: "checking" while Eli has not written since; her edit is held, the claim goes out.
    r, folder = dora.call("claimAccount('acme ag')", folder)
    check("claim: Dora's claim is taken", (r.get("ok"), r.get("state")), (True, "checking"))
    x = dora.local("targetAccountExtras"); x["acme ag"]["status"] = "Contacted"; dora.set_local({"targetAccountExtras": x})
    r, folder = dora.sync(folder)
    check("claim: the claim is in Dora's change file", any(c.get("op") == "claim" for f in files_of(dora_id) for c in f["changes"]), True)
    check("claim: Dora's edit is held, not sent", sent_values(dora_id, "x:acme ag", "status"), [])
    check("claim: Dora's own screen shows her edit", extras(dora, "acme ag").get("status"), "Contacted")
    r, folder = eli.call("getClaimStatus('acme ag')", folder)
    r, folder = eli.sync(folder)
    r, folder = eli.call("getClaimStatus('acme ag')", folder)
    check("claim: Eli sees Dora updating Acme", (r.get("state"), (r.get("holder") or {}).get("name")), ("other", "Dora"))
    r, folder = eli.call("claimAccount('acme ag')", folder)
    check("claim: Eli cannot claim it meanwhile", (r.get("ok"), r.get("reason")), (False, "held"))
    check("claim: Eli answered the claim with a heartbeat at once", "clock" in json.loads(folder["members/%s/heartbeat.json" % eli_id]), True)
    r, folder = dora.sync(folder)
    r, folder = dora.call("getClaimStatus('acme ag')", folder)
    check("claim: confirmed once Eli's heartbeat is read", r.get("state"), "mine")
    check("claim: ... and the held edit went out", sent_values(dora_id, "x:acme ag", "status"), ["Contacted"])
    r, folder = eli.sync(folder)
    check("claim: Eli gets Dora's edit", extras(eli, "acme ag").get("status"), "Contacted")
    r, folder = dora.call("releaseAccount('acme ag')", folder)
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    r, folder = eli.call("getClaimStatus('acme ag')", folder)
    check("claim: released - Acme is free for Eli", r.get("state"), "free")

    # B. A race on Beta: Eli claims first, Dora a second later, neither has seen the other's claim yet.
    t = max(dora.e("NOW"), eli.e("NOW")) + 1000
    dora.e("NOW = %d" % t)
    eli.e("NOW = %d" % t)
    r, folder = eli.call("claimAccount('beta sa')", folder)
    xe = eli.local("targetAccountExtras"); xe["beta sa"]["status"] = "Lost"; eli.set_local({"targetAccountExtras": xe})
    dora.e("NOW += 1000")
    r, folder = dora.call("claimAccount('beta sa')", folder)
    check("race: Dora's claim is taken too (she cannot know yet)", r.get("ok"), True)
    xd = dora.local("targetAccountExtras"); xd["beta sa"]["status"] = "Won"; xd["beta sa"]["note"] = "Dora"
    dora.set_local({"targetAccountExtras": xd})
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    r, folder = eli.call("getClaimStatus('beta sa')", folder)
    check("race: Eli's earlier claim wins", r.get("state"), "mine")
    check("race: Eli's held edit went out", sent_values(eli_id, "x:beta sa", "status"), ["Lost"])
    r, folder = dora.sync(folder)
    r, folder = dora.call("getClaimStatus('beta sa')", folder)
    check("race: Dora sees she lost - Eli is updating", (r.get("state"), (r.get("holder") or {}).get("name")), ("other", "Eli"))
    check("race: Dora's two changes are kept aside", ((r.get("aside") or {}).get("changes"), (r.get("aside") or {}).get("lostTo")), (2, "Eli"))
    check("race: Dora's screen shows Eli's values again", (extras(dora, "beta sa").get("status"), "note" in extras(dora, "beta sa")), ("Lost", False))
    check("race: Dora's held edit was never sent", sent_values(dora_id, "x:beta sa", "status"), [])
    r, folder = eli.sync(folder)
    check("race: Eli never sees Dora's edit", (extras(eli, "beta sa").get("status"), "note" in extras(eli, "beta sa")), ("Lost", False))
    r, folder = dora.call("applyKeptAside('beta sa')", folder)
    check("race: applying is refused while Eli holds it", (r.get("ok"), r.get("reason")), (False, "held"))

    # C. Eli is done; Dora applies her kept-aside changes - held under her new claim, then sent.
    r, folder = eli.call("releaseAccount('beta sa')", folder)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    r, folder = dora.call("applyKeptAside('beta sa')", folder)
    check("apply: Dora's changes are back on her screen", (r.get("ok"), extras(dora, "beta sa").get("status"), extras(dora, "beta sa").get("note")), (True, "Won", "Dora"))
    check("apply: nothing kept aside any more", r.get("aside"), None)
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    check("apply: Eli gets Dora's changes", (extras(eli, "beta sa").get("status"), extras(eli, "beta sa").get("note")), ("Won", "Dora"))
    check("apply: both have the same picture", same(picture(dora), picture(eli)), True)

    # D. The pipeline's shares (design 6.5): every account to exactly one active member; none that a colleague holds.
    keys = ["acct %d" % i for i in range(40)]
    js = "teamWorkGate().then(function (g) { return { connected: g.connected, may: %s.map(function (k) { return g.mayWork(k); }) }; })" % json.dumps(keys)
    rd, folder = dora.call(js, folder)
    re_, folder = eli.call(js, folder)
    check("shares: the gate is connected", (rd.get("connected"), re_.get("connected")), (True, True))
    check("shares: every account goes to exactly one of them", all(a != b for a, b in zip(rd["may"], re_["may"])), True)
    check("shares: both get some", (sum(rd["may"]) > 5, sum(re_["may"]) > 5), (True, True))
    r, folder = eli.call("teamWorkGate().then(function (g) { return g.discovery; })", folder)
    check("shares: without groups every member's pipeline may run Discovery (1.2.3 step 5: unchanged)", r, True)
    r, folder = eli.call("claimAccount('beta sa', { kind: 'pipeline' })", folder)
    check("shares: Eli's pipeline may not claim Beta while Dora still holds it", (r.get("ok"), r.get("reason")), (False, "held"))
    r, folder = dora.call("releaseAccount('beta sa')", folder)
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    r, folder = eli.call("claimAccount('beta sa', { kind: 'pipeline' })", folder)
    check("shares: once Dora released it, Eli's pipeline claims it", r.get("ok"), True)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    rd, folder = dora.call("teamWorkGate().then(function (g) { return g.mayWork('beta sa'); })", folder)
    check("shares: an account Eli holds is not Dora's to work", rd, False)

    # E. Step 5 - assign to me / release (design 7, R6.1-R6.4). Dora is the Team Admin, Eli a member.
    r, folder = eli.call("releaseAccount('beta sa')", folder)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    r, folder = dora.call("assignAccount('acme ag')", folder)
    check("assign: Dora assigns Acme to herself - checking first", (r.get("ok"), (r.get("assignee") or {}).get("me"), (r.get("assignee") or {}).get("checking")), (True, True, True))
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    r, folder = eli.call("getClaimStatus('acme ag')", folder)
    check("assign: Eli sees Acme assigned to Dora", ((r.get("assignee") or {}).get("name"), (r.get("assignee") or {}).get("me")), ("Dora", False))
    r, folder = eli.call("claimAccount('acme ag')", folder)
    check("assign: Eli cannot claim Dora's account to edit it", (r.get("ok"), r.get("reason")), (False, "assigned"))
    r, folder = eli.call("assignAccount('acme ag')", folder)
    check("assign: Eli cannot take it", (r.get("ok"), r.get("reason")), (False, "assigned"))
    r, folder = eli.call("unassignAccount('acme ag')", folder)
    check("assign: Eli cannot release Dora's account", (r.get("ok"), r.get("reason")), (False, "not_lead"))
    r, folder = eli.call("teamWorkGate().then(function (g) { return [g.mayWork('acme ag'), g.offLimits('acme ag')]; })", folder)
    check("assign: off-limits to Eli's pipeline and bulk research", (r[0], (r[1] or {}).get("reason"), (r[1] or {}).get("name")), (False, "assigned", "Dora"))
    summary = eli.local("teamAccountStates") or {}
    check("assign: Eli's pages get the badge data", ((summary.get("accounts") or {}).get("acme ag", {}).get("a"), (summary.get("names") or {}).get(dora_id)), (dora_id, "Dora"))
    r, folder = dora.sync(folder)
    r, folder = dora.call("getClaimStatus('acme ag')", folder)
    check("assign: confirmed for Dora once Eli has been heard from", ((r.get("assignee") or {}).get("me"), (r.get("assignee") or {}).get("checking")), (True, False))
    owner = dora.e("pipelineOwner('acme ag', %s)" % json.dumps(sorted([dora_id, eli_id])))
    r, folder = dora.call("teamWorkGate().then(function (g) { return g.mayWork('acme ag'); })", folder)
    check("assign: Dora's pipeline works her account whatever the share (share: %s)" % ("Dora" if owner == dora_id else "Eli"), r, True)

    # A race: Eli assigns Gamma first, Dora a second later, before either has read the other.
    t = max(dora.e("NOW"), eli.e("NOW")) + 1000
    dora.e("NOW = %d" % t)
    eli.e("NOW = %d" % t)
    r, folder = eli.call("assignAccount('gamma ag')", folder)
    dora.e("NOW += 1000")
    r, folder = dora.call("assignAccount('gamma ag')", folder)
    check("assign race: Dora's assignment is taken too (she cannot know yet)", r.get("ok"), True)
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    r, folder = dora.call("getClaimStatus('gamma ag')", folder)
    check("assign race: the earlier one (Eli) keeps it", ((r.get("assignee") or {}).get("name"), (r.get("assignLost") or {}).get("forMe")), ("Eli", True))
    r, folder = eli.sync(folder)
    r, folder = eli.call("getClaimStatus('gamma ag')", folder)
    check("assign race: Eli has it, confirmed", ((r.get("assignee") or {}).get("me"), (r.get("assignee") or {}).get("checking")), (True, False))
    r, folder = eli.call("unassignAccount('gamma ag')", folder)
    check("release: Eli releases his own", r.get("ok"), True)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    r, folder = dora.call("getClaimStatus('gamma ag')", folder)
    check("release: Gamma is unassigned - Dora's lost assignment was withdrawn, not revived", r.get("assignee"), None)

    # The admin reassigns, and releases all of a member's accounts.
    r, folder = eli.call("assignAccount('delta ag')", folder)
    r, folder = eli.call("assignAccount('epsilon ag')", folder)
    r, folder = eli.call("assignAccount('delta ag', { to: '%s' })" % dora_id, folder)
    check("admin: a member cannot assign to someone else", (r.get("ok"), r.get("reason")), (False, "not_lead"))
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    r, folder = dora.call("assignAccount('delta ag', { to: '%s' })" % dora_id, folder)
    check("admin: Dora reassigns Eli's Delta to herself", (r.get("ok"), (r.get("assignee") or {}).get("me")), (True, True))
    r, folder = dora.call("assignmentCounts()", folder)
    check("admin: counts per member", (r["counts"].get(dora_id), r["counts"].get(eli_id)), (2, 1))
    r, folder = dora.call("unassignAllOf('%s')" % eli_id, folder)
    check("admin: release all of Eli's accounts", (r.get("ok"), r.get("count")), (True, 1))
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    r, folder = eli.call("getClaimStatus('epsilon ag')", folder)
    check("admin: Eli sees Epsilon unassigned", r.get("assignee"), None)
    r, folder = eli.call("getClaimStatus('delta ag')", folder)
    check("admin: Eli sees Delta with Dora", (r.get("assignee") or {}).get("name"), "Dora")
    notices = sorted((n["key"], n["by"], n["to"]) for n in (eli.local("teamNotices") or []))
    check("notice: Eli is told which accounts the admin took (reassigned / released)",
          notices, [("delta ag", "Dora", "Dora"), ("epsilon ag", "Dora", None)])
    # 1.2.2.32: several accounts in one job - one save, one change file.
    r, folder = dora.sync(folder)
    files_before = dora.status()["lastWrittenN"]
    r, folder = dora.call("assignAccounts(['zeta ag', 'eta ag'], { to: '%s' })" % eli_id, folder)
    check("assign many: both accounts in one answer", [(x["key"], x["ok"]) for x in r.get("results", [])], [("zeta ag", True), ("eta ag", True)])
    r, folder = dora.sync(folder)
    check("assign many: one change file for both", dora.status()["lastWrittenN"] - files_before, 1)
    r, folder = eli.sync(folder)
    r, folder = eli.call("getClaimStatus('eta ag')", folder)
    check("assign many: Eli has Eta", (r.get("assignee") or {}).get("me"), True)
    r, folder = dora.call("unassignAccounts(['zeta ag', 'eta ag', 'nobody ag'])", folder)
    check("release many: both released, an unassigned one is fine", [x["ok"] for x in r.get("results", [])], [True, True, True])
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    r, folder = eli.call("getClaimStatus('eta ag')", folder)
    check("release many: Eta is unassigned for Eli", r.get("assignee"), None)
    check("notice: nothing for Dora - she did it herself (only 'Eli joined')", [x for x in dora.local("teamNotices") or [] if x.get("kind") != "joined"], [])

    # 1.2.2.6 (Boaz: 13 assigned to him on Annick's PC, 0 on his own): a PC whose saved state is lost gets its own
    # changes back from its own files in the folder.
    r, folder = dora.call("assignmentCounts()", folder)
    before = r.get("counts", {})
    dora.e("DB.state = undefined; mem = null;")
    r, folder = dora.sync(folder)
    r, folder = dora.call("assignmentCounts()", folder)
    check("lost state: Dora's own assignments come back from her files", (r.get("counts", {}), bool(before)), (before, True))
    log_before = len(dora.local("teamLog") or [])
    r, folder = dora.sync(folder)
    check("lost state: reading my own files back adds no team-log lines", len(dora.local("teamLog") or []), log_before)

    # 1.2.3 step 0 (TEAM_ADVANCED_MODE_DESIGN.md 3.1, 4.2): the Team Lead comes from the folder; only the Team Lead's
    # group records count - on every PC.
    r, folder = dora.call("Promise.resolve(publishSummary ? 1 : 0)", folder)
    st = dora.local("teamAccountStates") or {}
    check("lead: Dora (the creator) is Team Lead, read from the folder", (st.get("lead"), st.get("leadKnown"), st.get("admin")), (dora_id, True, True))
    r, folder = eli.sync(folder)
    st = eli.local("teamAccountStates") or {}
    check("lead: Eli sees Dora as Team Lead, himself without the rights", (st.get("lead"), st.get("leadKnown"), st.get("admin")), (dora_id, True, False))
    dora.e("VIEWS = %s" % json.dumps([
        {"key": "acme ag", "globalHqCountry": "Switzerland", "globalEmployees": 6000},
        {"key": "beta sa", "globalHqCountry": "France", "globalEmployees": 300},
        {"key": "gamma ag", "globalHqCountry": None}]))
    dora.set_local({"teamGroups": {"g-ch": {"name": "Swiss", "kind": "filter", "filter": {"country": ["Switzerland"]}, "members": [eli_id]}}})
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    check("groups: the Team Lead's group reaches Eli", ((eli.local("teamGroups") or {}).get("g-ch") or {}).get("name"), "Swiss")
    group_notes = lambda m: [n["text"] for n in (m.local("teamNotices") or []) if n.get("kind") == "group"]
    check("groups: Eli is told that groups were set up, and which are his", group_notes(eli), ["Dora set up account groups. You now see the accounts of your group: Swiss."])
    check("groups: the Team Lead is told nothing", group_notes(dora), [])
    # 1.2.3.5 (Boaz, 2026-10-13): "Eli joined the team. Add Eli to groups…" is done once Eli is in a group.
    r, folder = dora.sync(folder)
    check("joined: the 'add Eli to groups' sentence goes by itself once Eli is in a group",
          [n["text"] for n in (dora.local("teamNotices") or []) if n.get("kind") == "joined"], [])
    eli.set_local({"teamGroups": {"g-ch": {"name": "Eli renamed it", "kind": "filter", "filter": {"country": ["Switzerland"]}, "members": [eli_id]},
                                  "g-eli": {"name": "Eli's own", "kind": "named", "accounts": [], "members": [eli_id]}}})
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    groups = dora.local("teamGroups") or {}
    check("groups: a member's group changes are ignored on the Team Lead's PC", (groups.get("g-ch", {}).get("name"), "g-eli" in groups), ("Swiss", False))
    dora.advance(2500)
    st = dora.local("teamAccountStates") or {}
    check("groups: the summary carries each account's groups (unknown country -> Other)",
          (st.get("groupsOn"), st.get("g")), (True, {"acme ag": ["g-ch"], "beta sa": ["other"], "gamma ag": ["other"]}))
    check("groups: the Team Lead in no group is in Other (D9)", st.get("myGroups"), ["other"])
    # 1.2.3 step 4 (design 8.2, 8.3): group changes. Eli is in Swiss only; Dora is Team Lead.
    def set_views(acme, beta):
        v = json.dumps([{"key": "acme ag", "company": "Acme AG", "globalHqCountry": acme, "globalEmployees": 6000},
                        {"key": "beta sa", "company": "Beta SA", "globalHqCountry": beta, "globalEmployees": 300},
                        {"key": "gamma ag", "globalHqCountry": None}])
        for m in (dora, eli):
            m.e("VIEWS = %s" % v)

    def research(m, key, country, folder):
        """New data for one account, written on m's PC (what research, the pipeline or an edit does)."""
        m.e("FOLDER = %s;" % json.dumps(folder))
        extras = m.local("targetAccountExtras") or {}
        extras[key] = dict(extras.get(key) or {}, overrides=dict((extras.get(key) or {}).get("overrides") or {}, globalHqCountry=country))
        m.set_local({"targetAccountExtras": extras})
        m.advance(1500)
        m.advance(3000)
        return json.loads(m.e("JSON.stringify(FOLDER)"))  # a release is sent at once

    def both(folder):
        for m in (dora, eli, dora, eli):
            r, folder = m.sync(folder)
        for m in (dora, eli):
            m.e("markGroupsDirty(0)")
            m.advance(3000)
        return folder

    summ = lambda m: m.local("teamAccountStates") or {}
    owner = lambda m, key: ((summ(m).get("accounts") or {}).get(key) or {}).get("a")
    kept = {k: owner(dora, k) for k in ("acme ag", "beta sa")}  # put back at the end, for the tests further down
    set_views("Switzerland", "France")
    r, folder = dora.call("unassignAccount('beta sa')", folder)
    r, folder = dora.call("assignAccount('acme ag', { to: '%s' })" % eli_id, folder)
    folder = both(folder)
    check("pin: Acme is Eli's, in Swiss, on both PCs", [(owner(m, "acme ag"), summ(m)["g"].get("acme ag")) for m in (dora, eli)], [(eli_id, ["g-ch"])] * 2)
    # Research on Eli's PC moves his own account out of his group: pinned, not moved.
    set_views("Germany", "France")
    folder = research(eli, "acme ag", "Germany", folder)
    pin = (eli.local("teamGroupPins") or {}).get("acme ag") or {}
    check("pin: research on an assigned account pins it to its old groups",
          (pin.get("groups"), pin.get("proposed"), pin.get("for"), pin.get("by"), pin.get("reason")), (["g-ch"], ["other"], eli_id, eli_id, "country Switzerland → Germany"))
    check("pin: Eli keeps the account, still in Swiss", (owner(eli, "acme ag"), summ(eli)["g"].get("acme ag")), (eli_id, ["g-ch"]))
    folder = both(folder)
    check("pin: the Team Lead's PC holds it in Swiss too", (owner(dora, "acme ag"), summ(dora)["g"].get("acme ag"), "acme ag" in (dora.local("teamGroupPins") or {})), (eli_id, ["g-ch"], True))
    # The Team Lead answers "Move it" (team-proposals.js applyGroupMove): the release, then the pin goes.
    r, folder = dora.call("releaseVoided([{ key: 'acme ag', member: '%s', into: 'Other' }])" % eli_id, folder)
    check("move it: the Team Lead's release goes through", (r.get("ok"), r.get("count")), (True, 1))
    dora.set_local({"teamGroupPins": {k: v for k, v in (dora.local("teamGroupPins") or {}).items() if k != "acme ag"}})
    folder = both(folder)
    check("move it: Acme is in Other and unassigned on both PCs", [(owner(m, "acme ag"), summ(m)["g"].get("acme ag")) for m in (dora, eli)], [(None, ["other"])] * 2)
    check("move it: Eli no longer sees it", "g-ch" in summ(eli).get("myGroups", []) and "other" not in summ(eli).get("myGroups", []), True)
    told = [n["text"] for n in (eli.local("teamNotices") or []) if n.get("kind") == "group" and "no longer in your groups" in n.get("text", "")]
    check("move it: Eli is told why", (len(told), "moved to Other - it is no longer in your groups" in (told or [""])[0]), (1, True))
    r, folder = eli.call("releaseVoided([{ key: 'beta sa', member: '%s' }])" % dora_id, folder)
    check("release: only the Team Lead may write one", (r.get("ok"), r.get("reason")), (False, "not_lead"))
    # An unassigned account moves at once, whoever's PC found the data.
    set_views("Germany", "Switzerland")
    folder = research(eli, "beta sa", "Switzerland", folder)
    check("unassigned: research moves it at once, no pin", (summ(eli)["g"].get("beta sa"), "beta sa" in (eli.local("teamGroupPins") or {})), (["g-ch"], False))
    folder = both(folder)
    # D6: taken out of the group, Eli's assignment there is void on every PC - nothing has to be written for that.
    r, folder = dora.call("assignAccount('beta sa', { to: '%s' })" % eli_id, folder)
    folder = both(folder)
    check("void: Beta is Eli's", [owner(m, "beta sa") for m in (dora, eli)], [eli_id, eli_id])
    swiss = lambda members: {"teamGroups": {"g-ch": {"name": "Swiss", "kind": "filter", "filter": {"country": ["Switzerland"]}, "members": members}}}
    dora.set_local(swiss([]))
    folder = both(folder)
    check("void: out of the group, the assignment no longer shows - on both PCs", [owner(m, "beta sa") for m in (dora, eli)], [None, None])
    rd, folder = dora.call("teamWorkGate().then(function (g) { return g.offLimits('beta sa'); })", folder)
    check("void: and keeps nobody out", rd, None)
    dora.set_local(swiss([eli_id]))
    folder = both(folder)
    check("void: back in the group (nothing was released), it shows again", [owner(m, "beta sa") for m in (dora, eli)], [eli_id, eli_id])
    # The Team Lead's own change applies at once: the assignee left without access is released, with the reason.
    set_views("Germany", "France")
    folder = research(dora, "beta sa", "France", folder)
    folder = both(folder)
    check("lead's change: no pin, Beta in Other, released", ("beta sa" in (dora.local("teamGroupPins") or {}), summ(dora)["g"].get("beta sa"), owner(dora, "beta sa"), owner(eli, "beta sa")), (False, ["other"], None, None))
    r, folder = dora.call("assignmentCounts()", folder)
    check("lead's change: the release is a real one (not only void)", r.get("counts", {}).get(eli_id), None)
    lines = [x for x in (eli.local("teamLog") or []) if x.get("why") == "groups"]
    check("log: the releases say why", (len(lines) >= 2, lines[-1].get("into") if lines else None), (True, "Other"))
    for key, was in kept.items():
        if was:
            r, folder = dora.call("assignAccount('%s', { to: '%s' })" % (key, was), folder)
    folder = both(folder)

    # 1.2.3 step 5 (design 9, R7): the pipeline's shares with groups. Dora is Team Lead, Eli is in Swiss only.
    sw = ["sw %d" % i for i in range(40)]
    ot = ["ot %d" % i for i in range(40)]
    views_before = dora.e("JSON.stringify(VIEWS)")
    v5 = json.dumps(json.loads(views_before) + [{"key": k, "globalHqCountry": "Switzerland"} for k in sw] + [{"key": k, "globalHqCountry": "France"} for k in ot])
    for m in (dora, eli):
        m.e("VIEWS = %s" % v5)
    folder = both(folder)

    def shares(m, keys, folder):
        return m.call("teamWorkGate().then(function (g) { return %s.map(function (k) { return g.mayWork(k); }); })" % json.dumps(keys), folder)

    def shares_both(folder):
        out = []
        for m, keys in ((dora, sw), (eli, sw), (dora, ot), (eli, ot)):
            r, folder = shares(m, keys, folder)
            out.append(r)
        return out, folder

    (dsw, esw, dot, eot), folder = shares_both(folder)
    check("step 5: a group's accounts are worked by its member, not by the Team Lead", (sum(dsw), sum(esw)), (0, 40))
    check("step 5: Other, with no member in it, goes to the Team Lead - never to a member without access", (sum(dot), sum(eot)), (40, 0))
    r, folder = eli.call("teamWorkGate().then(function (g) { return [g.discovery, g.offLimits('ot 0'), g.offLimits('sw 0')]; })", folder)
    check("step 5: a member's pipeline runs no Discovery; bulk research stays inside the groups", r, [False, {"reason": "groups"}, None])
    r, folder = dora.call("teamWorkGate().then(function (g) { return g.discovery; })", folder)
    check("step 5: the Team Lead's pipeline runs Discovery", r, True)
    # "All accounts": published with the heartbeat, so both PCs build the same candidates.
    dora.set_local({"teamLeadResearch": "all"})
    folder = both(folder)
    check("step 5: the choice travels with the heartbeat", json.loads(folder["members/%s/heartbeat.json" % dora_id]).get("research"), "all")
    (dsw, esw, dot, eot), folder = shares_both(folder)
    check("step 5, All accounts: every account of the group goes to exactly one of them", all(a != b for a, b in zip(dsw, esw)), True)
    check("step 5, All accounts: both get some", (sum(dsw) > 5, sum(esw) > 5), (True, True))
    check("step 5, All accounts: Other is still the Team Lead's alone", (sum(dot), sum(eot)), (40, 0))
    dora.set_local({"teamLeadResearch": "gaps"})
    folder = both(folder)
    (dsw, esw, dot, eot), folder = shares_both(folder)
    check("step 5: back to filling gaps", (sum(dsw), sum(esw)), (0, 40))
    # Eli is not heard from for 11 minutes: his group has nobody online, so the Team Lead's pipeline covers it.
    dora.e("FOLDER = %s;" % json.dumps(folder))
    dora.advance(11 * 60000)
    folder = json.loads(dora.e("JSON.stringify(FOLDER)"))
    dsw, folder = shares(dora, sw, folder)
    check("step 5: a group with nobody online goes to the Team Lead", sum(dsw), 40)
    eli.e("FOLDER = %s;" % json.dumps(folder))
    eli.advance(11 * 60000)
    folder = json.loads(eli.e("JSON.stringify(FOLDER)"))
    folder = both(folder)
    (dsw, esw, dot, eot), folder = shares_both(folder)
    check("step 5: Eli is back, and his group is his again", (sum(dsw), sum(esw)), (0, 40))
    for m in (dora, eli):
        m.e("VIEWS = %s" % views_before)
    folder = both(folder)

    # Back to basic mode for the rest of the test: the group is deleted (marked).
    dora.set_local({"teamGroups": {"g-ch": {"name": "Swiss", "kind": "filter", "filter": {"country": ["Switzerland"]}, "members": [eli_id], "deleted": True}}})
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    dora.advance(2500)
    check("groups: deleted -> basic mode again", (dora.local("teamAccountStates") or {}).get("groupsOn"), None)

    # 1.2.3 step 1 (design 3.3, 3.4): hand-over and deputy. Each PC reaches the same Team Lead; a group record counts
    # only from whoever had the rights at its stamp.
    merged_groups = lambda m: sorted(k[len("teamGroups:"):] for k in json.loads(m.e("JSON.stringify(Object.keys(mem.state.entities.setting || {}))")) if k.startswith("teamGroups:"))
    with_group = lambda m, gid, name: dict(m.local("teamGroups") or {}, **{gid: {"name": name, "kind": "named", "accounts": ["acme ag"], "members": []}})
    r, folder = eli.call("makeTeamLead('%s')" % dora_id, folder)
    check("hand-over: a Member cannot hand over", (r.get("ok"), r.get("reason")), (False, "not_lead"))
    r, folder = dora.call("makeTeamLead('%s')" % eli_id, folder)
    check("hand-over: Dora makes Eli Team Lead", r.get("ok"), True)
    st = dora.local("teamAccountStates") or {}
    check("hand-over: Dora's PC follows at once (no rights any more)", (st.get("lead"), st.get("admin")), (eli_id, False))
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    st = eli.local("teamAccountStates") or {}
    check("hand-over: Eli's PC sees Eli as Team Lead", (st.get("lead"), st.get("admin")), (eli_id, True))
    check("hand-over: Eli is told in the top bar", any(n.get("kind") == "role" and n.get("text", "").startswith("Dora made you Team Lead") for n in eli.local("teamNotices") or []), True)
    check("hand-over: Dora's team log says so", any(x.get("kind") == "team" and x.get("ref") == "lead" and x.get("to") == eli_id for x in dora.local("teamLog") or []), True)
    r, folder = dora.call("makeTeamLead('%s')" % dora_id, folder)
    check("hand-over: the former Team Lead cannot take it back", (r.get("ok"), r.get("reason")), (False, "not_lead"))
    dora.set_local({"teamGroups": with_group(dora, "g-dora", "Dora after the hand-over")})
    r, folder = dora.sync(folder)
    eli.set_local({"teamGroups": with_group(eli, "g-eli2", "Eli as Team Lead")})
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    check("hand-over: the former Team Lead's group record is ignored on both PCs",
          ("g-dora" in merged_groups(eli), "g-dora" in merged_groups(dora), "g-dora" in (eli.local("teamGroups") or {})), (False, False, False))
    check("hand-over: the new Team Lead's group reaches Dora", ((dora.local("teamGroups") or {}).get("g-eli2") or {}).get("name"), "Eli as Team Lead")
    # Deputy: Eli makes Dora deputy - her group records count; ended - they do not.
    r, folder = dora.call("setDeputy('%s')" % dora_id, folder)
    check("deputy: a Member cannot name a deputy", r.get("reason"), "not_lead")
    r, folder = eli.call("setDeputy('%s')" % dora_id, folder)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    st = dora.local("teamAccountStates") or {}
    check("deputy: Dora is deputy, with the rights", (st.get("deputy"), st.get("admin")), (dora_id, True))
    check("deputy: Dora is told", any(n.get("kind") == "role" and "made you deputy" in n.get("text", "") for n in dora.local("teamNotices") or []), True)
    r, folder = dora.call("setDeputy(null)", folder)
    check("deputy: a deputy cannot end or name a deputy", r.get("reason"), "not_lead")
    r, folder = dora.call("makeTeamLead('%s')" % dora_id, folder)
    check("deputy: a deputy cannot make themselves Team Lead", r.get("reason"), "not_lead")
    dora.set_local({"teamGroups": with_group(dora, "g-dep", "Dora as deputy")})
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    check("deputy: the deputy's group reaches Eli", ((eli.local("teamGroups") or {}).get("g-dep") or {}).get("name"), "Dora as deputy")
    r, folder = eli.call("setDeputy(null)", folder)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    st = dora.local("teamAccountStates") or {}
    check("deputy: ended - Dora is a Member again", (st.get("deputy"), st.get("admin")), (None, False))
    check("deputy: the team log names whose deputy role ended",
          any(x.get("kind") == "team" and x.get("ref") == "deputy" and x.get("to") == dora_id and not (x.get("after") or {}).get("member") for x in dora.local("teamLog") or []), True)
    dora.set_local({"teamGroups": with_group(dora, "g-late", "Dora after the deputy role")})
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    check("deputy: after it ends, her group records are ignored again", "g-late" in merged_groups(eli), False)
    check("deputy: what she wrote as deputy stays", "g-dep" in merged_groups(eli), True)
    # Back to Dora as Team Lead for the rest of the test; the groups are deleted (marked) - basic mode again.
    r, folder = eli.call("makeTeamLead('%s')" % dora_id, folder)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    check("hand-over: and back to Dora", ((dora.local("teamAccountStates") or {}).get("lead"), (eli.local("teamAccountStates") or {}).get("lead")), (dora_id, dora_id))
    gone = {k: dict(v, deleted=True) for k, v in (dora.local("teamGroups") or {}).items() if k != "other"}
    dora.set_local({"teamGroups": gone})
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    dora.advance(2500)
    check("hand-over: groups deleted again -> basic mode", (dora.local("teamAccountStates") or {}).get("groupsOn"), None)
    dora.e("chrome.storage.local.remove('teamNotices')")
    eli.e("chrome.storage.local.remove('teamNotices')")
    dora.settle()
    eli.settle()

    # F. Step 5b - the do-not-contact list is one row per entry (R6.8): two members adding at once both keep theirs.
    base = [{"slug": "adecco", "category": "recruiter"}]
    dora.set_local({"companyExclusions": base})
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    check("dnc: Eli has Dora's list", eli.local("companyExclusions"), base)
    dora.set_local({"companyExclusions": base + [{"name": "Foo GmbH", "category": "customer", "addedBy": "Dora"}]})
    eli.set_local({"companyExclusions": base + [{"name": "Bar SA", "category": "competitor", "addedBy": "Eli"}]})
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    names = lambda m: sorted(x.get("name") or x.get("slug") for x in (m.local("companyExclusions") or []))
    check("dnc: both additions survive on Dora's PC", names(dora), ["Bar SA", "Foo GmbH", "adecco"])
    check("dnc: ... and on Eli's", names(eli), ["Bar SA", "Foo GmbH", "adecco"])
    dora.advance(20000)  # past the clobber window: a removal seconds after a row arrived looks like a stale writer
    dora.set_local({"companyExclusions": [x for x in dora.local("companyExclusions") if x.get("name") != "Bar SA"]})
    r, folder = dora.sync(folder)
    r, folder = eli.sync(folder)
    check("dnc: the admin's removal reaches Eli", names(eli), ["Foo GmbH", "adecco"])

    # Step 6 (R6.7): Fay joins with accounts of her own. Gamma (ticked) comes into the team, Delta (not ticked) does not;
    # Acme AG, which the team has and where she contacted a lead, becomes a join proposal and her lead is kept.
    fay = Member("fay", now_offset=11)
    fay.set_local({
        "targetAccounts": {"acme ag": {"company": "Acme AG"}, "gamma": {"company": "Gamma"}, "delta": {"company": "Delta"}},
        "targetAccountsWorkbook": {"companies": [{"companyId": "c-1", "company": "Gamma"}, {"companyId": "c-7", "company": "Delta"}], "contacts": []},
        "results": {"lead-f1": {"author": "Pia", "company": "Acme AG", "status": "Contacted"}, "lead-f2": {"author": "Max", "company": "Delta", "status": "New"}},
    })
    r, folder = fay.call("previewJoin({ inviteId: '%s' })" % invited["Fay"], folder)
    check("join preview: accounts only Fay has", sorted(a["key"] for a in r.get("localOnly", [])), ["delta", "gamma"])
    check("join preview: shared and worked on", [(a["key"], a["worked"]) for a in r.get("shared", [])], [("acme ag", ["1 lead contacted"])])
    check("join preview: Fay is not in the team yet", fay.local("teamMembership"), None)
    r, folder = fay.call("joinTeam({ addKeys: ['gamma'], inviteId: '%s' })" % invited["Fay"], folder)
    check("join with own data: ok, 1 brought (assigned to Fay), 1 proposal", (r.get("ok"), r.get("brought")), (True, {"accounts": 1, "proposals": 1, "assigned": 1}))
    r, folder = fay.sync(folder)
    fay_id = fay.status()["me"]["memberId"]
    check("join with own data: Gamma kept, Delta gone", (sorted(fay.local("targetAccounts")), sorted(c["company"] for c in fay.local("targetAccountsWorkbook")["companies"])),
          (["gamma"], ["Acme AG", "Beta SA", "Gamma"]))
    gamma_rows = [c for c in fay.local("targetAccountsWorkbook")["companies"] if c["company"] == "Gamma"]
    check("join with own data: Gamma's clashing id c-1 renamed", [c["companyId"] for c in gamma_rows], ["c-1-%s" % fay_id])
    r, folder = dora.sync(folder)
    check("join with own data: Dora gets Gamma", "gamma" in (dora.local("targetAccounts") or {}), True)
    check("join with own data: Dora's Acme AG row untouched", [c["company"] for c in dora.local("targetAccountsWorkbook")["companies"] if c["companyId"] == "c-1"], ["Acme AG"])
    check("join with own data: Fay's contacted lead reaches Dora", (dora.local("results") or {}).get("lead-f1", {}).get("status"), "Contacted")
    check("join with own data: Delta's lead does not", "lead-f2" in (dora.local("results") or {}), False)
    props = dora.local("teamJoinProposals") or {}
    check("join proposal: Dora has it", [(v["key"], v["by"], v["byName"]) for v in props.values()], [("acme ag", fay_id, "Fay")])
    check("join proposal: details name the lead", [(d["what"], d["name"]) for v in props.values() for d in v.get("details", [])], [("lead", "Pia")])
    log = dora.local("teamLog") or []
    check("team log: Dora's PC logged Fay's changes", any(x["m"] == fay_id and x.get("mn") == "Fay" and x.get("key") == "gamma" for x in log), True)
    check("team log: claims are not logged", any(x["op"] in ("claim", "release") for x in log), False)
    check("team log: new values kept", any(x.get("key") == "gamma" and x.get("after", {}).get("company") == "Gamma" for x in log), True)
    # The admin declines: the proposal goes on every PC.
    dora.advance(20000)  # past the clobber window
    dora.set_local({"teamJoinProposals": {}})
    r, folder = dora.sync(folder)
    r, folder = fay.sync(folder)
    check("join proposal: removal reaches Fay", fay.local("teamJoinProposals") or {}, {})
    # Boaz 2026-10-06: leaving hands back the leaver's accounts and signs off.
    r, folder = fay.call("assignAccount('gamma')", folder)
    r, folder = fay.sync(folder)
    r, folder = dora.sync(folder)
    r, folder = dora.call("assignmentCounts()", folder)
    check("leave: Fay holds Gamma before leaving", r.get("counts", {}).get(fay_id), 1)
    r, folder = fay.call("leaveTeam()", folder)
    check("leave: released 1, signed off", (r.get("ok"), r.get("released"), r.get("signedOff")), (True, 1, True))
    r, folder = dora.sync(folder)
    r, folder = dora.call("assignmentCounts()", folder)
    check("leave: Gamma is free for Dora", r.get("counts", {}).get(fay_id), None)
    st = dora.status()
    check("leave: Dora sees Fay as left, not online", [(m["name"], bool(m.get("left")), m["online"]) for m in st["members"] if m["id"] == fay_id], [("Fay", True, False)])
    # Boaz 2026-10-06: the Team Admin removes a member who never signed off (Eli): accounts released, Former members.
    r, folder = eli.call("assignAccount('beta sa')", folder)
    r, folder = eli.sync(folder)
    r, folder = dora.sync(folder)
    r, folder = dora.call("removeMember('%s')" % eli_id, folder)
    check("remove member: ok, 1 account released", (r.get("ok"), r.get("count")), (True, 1))
    check("remove member: removed/<id>.json written", "removed/%s.json" % eli_id in folder, True)
    r, folder = dora.sync(folder)
    st = dora.status()
    check("remove member: Dora lists Eli as removed", [(bool(m.get("removed")), m["online"]) for m in st["members"] if m["id"] == eli_id], [(True, False)])
    r, folder = eli.sync(folder)
    check("remove member: Eli's own PC stops sharing", eli.local("teamMembership"), None)

    # 1.2.3 step 1 (D16): the Team Lead closes the team. Hal (a member) stops sharing and is told; nobody can join again.
    hal = Member("hal", now_offset=13)
    inv, folder = invite(dora, "Hal", folder)
    r, folder = hal.call("joinTeam({ inviteId: '%s' })" % inv, folder)
    inv_open, folder = invite(dora, "Jo", folder)
    r, folder = hal.sync(folder)
    r, folder = dora.sync(folder)
    r, folder = hal.call("closeTeam()", folder)
    check("close: a Member cannot close the team", (r.get("ok"), r.get("reason")), (False, "not_lead"))
    kept = picture(dora)
    r, folder = dora.call("closeTeam()", folder)
    check("close: the Team Lead closes it", (r.get("ok"), r.get("closed")), (True, True))
    check("close: closed.json written, Dora's PC stops sharing", ("closed.json" in folder, dora.local("teamMembership")), (True, None))
    check("close: open invitations are cancelled with it", json.loads(folder["invites/%s.json" % inv_open])["status"], "cancelled")
    check("close: Dora keeps her data as it was", (same(picture(dora), kept), bool(kept["targetAccounts"])), (True, True))
    r, folder = hal.sync(folder)
    check("close: Hal's PC stops sharing by itself", (r.get("closed"), hal.local("teamMembership")), (True, None))
    check("close: Hal is told who closed it", (hal.local("teamClosedNotice") or {}).get("by"), "Dora")
    by_id = lambda pic: dict(pic, targetAccountsWorkbook=dict(pic["targetAccountsWorkbook"], companies=sorted(pic["targetAccountsWorkbook"]["companies"], key=lambda c: c["companyId"])))
    check("close: Hal keeps the team's data as his own copy (row order aside)", same(by_id(picture(hal)), by_id(kept)), True)
    ivy = Member("ivy", now_offset=15)
    r, folder = ivy.call("previewJoin()", folder)
    check("close: a closed team cannot be joined", "closed" in (r.get("error") or ""), True)
    r, folder = ivy.call("joinTeam({ name: 'Ivy' })", folder)
    check("close: ... not even directly", ("closed" in (r.get("error") or ""), ivy.local("teamMembership")), (True, None))

    # 1.2.2.8 (Boaz's PC, 8 Oct): the saved team state is lost while the cursors survive. Every file is read again, so
    # the colleague's hand-back is not lost and the Team Lead stays right; nothing is logged twice.
    folder = {}
    kim = Member("kim")
    kim.set_local({"targetAccounts": {"acme ag": {"score": 1}}})
    r, folder = kim.call("createTeam({ name: 'Kim', teamName: 'Lost state' })", folder)
    inv, folder = invite(kim, "Lou", folder)
    lou = Member("lou", now_offset=5)
    r, folder = lou.call("joinTeam({ inviteId: '%s' })" % inv, folder)
    kim_id, lou_id = kim.status()["me"]["memberId"], lou.status()["me"]["memberId"]
    r, folder = kim.sync(folder)
    r, folder = kim.call("makeTeamLead('%s')" % lou_id, folder)
    r, folder = kim.sync(folder)
    r, folder = lou.sync(folder)
    r, folder = lou.call("makeTeamLead('%s')" % kim_id, folder)
    check("lost state: Lou hands it back", r.get("ok"), True)
    r, folder = lou.sync(folder)
    r, folder = kim.sync(folder)
    check("lost state: Kim is Team Lead before", kim.status()["lead"]["lead"], kim_id)
    log_before = len([x for x in kim.local("teamLog") or [] if x.get("kind") == "team"])
    kim.e("chrome.storage.local.remove('teamNotices')")
    kim.e("delete DB.state; delete DB.shadow; mem = null; MAX_FILES_PER_ROUND = 1;")
    for _ in range(8):
        r, folder = kim.sync(folder)
    kim.e("MAX_FILES_PER_ROUND = 300;")
    check("lost state: Kim is still Team Lead after", kim.status()["lead"]["lead"], kim_id)
    check("lost state: the re-read history says nothing in the top bar (1.2.2.8)", kim.local("teamNotices") or [], [])
    check("lost state: the hand-overs are not logged twice", len([x for x in kim.local("teamLog") or [] if x.get("kind") == "team"]), log_before)

    # 1.2.2.8 (Boaz's PC, 8 Oct: 7921 rows re-sent): a lost SHADOW must not send every local row out again. Lou edits
    # Acme meanwhile; Kim's stale Acme must not overwrite it. Only Kim's row the team has never seen goes out.
    r, folder = lou.sync(folder)
    ta = lou.local("targetAccounts"); ta["acme ag"]["score"] = 5; lou.set_local({"targetAccounts": ta})
    r, folder = lou.sync(folder)
    sent_before = sum(len(f["changes"]) for f in files_of(kim_id))
    kim.e("delete DB.state; delete DB.shadow; mem = null; MAX_FILES_PER_ROUND = 1;")
    ta = kim.local("targetAccounts"); ta["beta ag"] = {"score": 2}; kim.set_local({"targetAccounts": ta})
    for _ in range(8):
        r, folder = kim.sync(folder)
    kim.e("MAX_FILES_PER_ROUND = 300;")
    sent = [c for f in files_of(kim_id) for c in f["changes"]][sent_before:]
    check("lost shadow: Kim sends only the row the team never had", sorted({c.get("id") for c in sent}), ["ta:beta ag"])
    check("lost shadow: Kim gets Lou's newer Acme", (kim.local("targetAccounts") or {}).get("acme ag", {}).get("score"), 5)
    r, folder = kim.sync(folder)
    check("lost shadow: nothing more goes out afterwards", len([c for f in files_of(kim_id) for c in f["changes"]]) - sent_before, len(sent))
    r, folder = lou.sync(folder)
    check("lost shadow: Lou keeps Acme 5 and gets Beta", ((lou.local("targetAccounts") or {}).get("acme ag", {}).get("score"),
          (lou.local("targetAccounts") or {}).get("beta ag", {}).get("score")), (5, 2))

    # 1.2.2.27: one of Lou's change files holds only zero bytes (Boaz's folder, 10 Oct). Kim waits at it and gets
    # nothing Lou wrote afterwards - until Lou's own PC rebuilds the file from what it knows.
    lou_id = lou.status()["me"]["memberId"]
    ta = lou.local("targetAccounts"); ta["acme ag"]["score"] = 6; lou.set_local({"targetAccounts": ta})
    r, folder = lou.sync(folder)
    damaged = "members/%s/changes/c-%d.json" % (lou_id, lou.status()["lastWrittenN"])
    original = json.loads(folder[damaged])["changes"]
    folder[damaged] = "\x00" * len(folder[damaged])
    ta = lou.local("targetAccounts"); ta["beta ag"]["score"] = 9; lou.set_local({"targetAccounts": ta})
    r, folder = lou.sync(folder)
    r, folder = kim.sync(folder)
    tk = kim.local("targetAccounts") or {}
    check("damaged file: Kim waits at it - neither that change nor the later one arrives",
          (tk.get("acme ag", {}).get("score"), tk.get("beta ag", {}).get("score")), (5, 2))
    # Found on the next pass over its own files, rebuilt once it has been unreadable for a minute (timer rounds).
    lou.e("FOLDER = %s;" % json.dumps(folder))
    lou.advance(120000)
    folder = json.loads(lou.e("JSON.stringify(FOLDER)"))
    repaired = json.loads(folder[damaged])
    check("damaged file: Lou's PC writes it again with the same records", (repaired.get("repaired"), repaired["changes"]), (True, original))
    r, folder = kim.sync(folder)
    tk = kim.local("targetAccounts") or {}
    check("damaged file: Kim now has both changes", (tk.get("acme ag", {}).get("score"), tk.get("beta ag", {}).get("score")), (6, 9))
    r, folder = lou.sync(folder)
    check("damaged file: Lou's own read moves on", lou.status()["measures"][-1].get("kind") != "repair", True)

    # D13: a Team Lead who is gone. After 30 days without a sign of the Team Lead's SalesTeam the deputy may take over
    # (nobody else while there is a deputy); every PC then reaches the same Team Lead, and everyone is told.
    folder = {}
    mia = Member("mia")
    mia.set_local({"targetAccounts": {"acme ag": {"score": 1}}})
    r, folder = mia.call("createTeam({ name: 'Mia', teamName: 'Take over' })", folder)
    inv, folder = invite(mia, "Noa", folder)
    noa = Member("noa", now_offset=5)
    r, folder = noa.call("joinTeam({ inviteId: '%s' })" % inv, folder)
    inv, folder = invite(mia, "Oli", folder)
    oli = Member("oli", now_offset=9)
    r, folder = oli.call("joinTeam({ inviteId: '%s' })" % inv, folder)
    for m in (mia, noa, oli, mia, noa, oli):
        r, folder = m.sync(folder)
    mia_id, noa_id, oli_id = (m.status()["me"]["memberId"] for m in (mia, noa, oli))
    r, folder = mia.call("setDeputy('%s')" % noa_id, folder)
    for m in (mia, noa, oli):
        r, folder = m.sync(folder)
    check("take-over: not offered while the Team Lead is around", (noa.status().get("takeOver"), oli.status().get("takeOver")), (None, None))
    r, folder = noa.call("takeOverAsTeamLead()", folder)
    check("take-over: refused while the Team Lead is around", (r.get("ok"), r.get("reason")), (False, "lead_seen"))
    for m in (noa, oli):
        m.e("NOW += 31 * 24 * 3600 * 1000;")
    for m in (noa, oli, noa, oli):
        r, folder = m.sync(folder)
    check("take-over: after 31 days the deputy is offered it", (noa.status().get("takeOver") or {}).get("can"), True)
    check("take-over: a member is told the deputy can", ((oli.status().get("takeOver") or {}).get("can"), (oli.status().get("takeOver") or {}).get("deputyName")), (False, "Noa"))
    r, folder = oli.call("takeOverAsTeamLead()", folder)
    check("take-over: a member cannot while there is a deputy", (r.get("ok"), r.get("reason")), (False, "deputy_first"))
    r, folder = noa.call("takeOverAsTeamLead()", folder)
    check("take-over: the deputy takes over", (r.get("ok"), noa.status()["lead"].get("lead"), noa.status()["lead"].get("deputy")), (True, noa_id, None))
    r, folder = noa.sync(folder)
    r, folder = oli.sync(folder)
    check("take-over: the member's PC sees the new Team Lead", (oli.status()["lead"].get("lead"), oli.status().get("takeOver")), (noa_id, None))
    check("take-over: the member is told", any(n.get("kind") == "role" and n.get("text", "").startswith("Noa took over as Team Lead, because Mia") for n in oli.local("teamNotices") or []), True)
    check("take-over: the team log says so", any(x.get("kind") == "team" and x.get("ref") == "takeover" for x in oli.local("teamLog") or []), True)
    mia.e("NOW += 31 * 24 * 3600 * 1000 + 60000;")
    r, folder = mia.sync(folder)
    r, folder = mia.sync(folder)
    check("take-over: the returning Team Lead is a Member", (mia.status()["lead"].get("lead"), mia.status()["admin"] if "admin" in mia.status() else False), (noa_id, False))
    check("take-over: and is told why", any(n.get("kind") == "role" and "had not been seen in the team for 30 days. You are a Member now" in n.get("text", "") for n in mia.local("teamNotices") or []), True)
    r, folder = noa.sync(folder)  # Noa's PC reads that Mia is back
    back, folder = noa.call("makeTeamLead('%s')" % mia_id, folder)
    r, folder = noa.sync(folder)
    r, folder = mia.sync(folder)
    check("take-over: the new Team Lead can hand the role back", (back.get("ok"), back.get("reason"), mia.status()["lead"].get("lead")), (True, None, mia_id))

    # 1.2.3.2 (Boaz, 2026-10-13): an edit hold ends soon after the edit is saved, and after a minute without a touch -
    # not only when the account page is left or after five idle minutes.
    folder = {}
    pia = Member("pia")
    pia.set_local({"targetAccountExtras": {"acme ag": {"status": "New"}, "beta ag": {"status": "New"}}})
    r, folder = pia.call("createTeam({ name: 'Pia', teamName: 'Short holds' })", folder)
    inv, folder = invite(pia, "Quin", folder)
    quin = Member("quin", now_offset=7)
    r, folder = quin.call("joinTeam({ inviteId: '%s' })" % inv, folder)
    for m in (pia, quin, pia, quin):
        r, folder = m.sync(folder)
    quin_id = quin.status()["me"]["memberId"]
    def wait(m, ms, folder):  # time passes on m's PC; what its timers write stays in the folder
        m.e("FOLDER = %s;" % json.dumps(folder))
        m.advance(ms)
        return json.loads(m.e("JSON.stringify(FOLDER)"))
    releases = lambda: [c for f in folder if f.startswith("members/%s/changes/" % quin_id) for c in json.loads(folder[f])["changes"] if c.get("op") == "release"]
    r, folder = quin.call("claimAccount('acme ag')", folder)
    x = quin.local("targetAccountExtras"); x["acme ag"]["status"] = "Contacted"; quin.set_local({"targetAccountExtras": x})
    for m in (quin, pia, quin, pia):
        r, folder = m.sync(folder)
    r, folder = pia.call("getClaimStatus('acme ag')", folder)
    check("short hold: right after the save the colleague still holds it", (r.get("state"), (r.get("holder") or {}).get("name")), ("other", "Quin"))
    check("short hold: the saved edit arrived", ((pia.local("targetAccountExtras") or {}).get("acme ag") or {}).get("status"), "Contacted")
    folder = wait(quin, 12000, folder)
    r, folder = quin.sync(folder)
    r, folder = pia.sync(folder)
    r, folder = pia.call("getClaimStatus('acme ag')", folder)
    check("short hold: about ten seconds after the save the account is free", (r.get("state"), len(releases())), ("free", 1))
    r, folder = pia.call("claimAccount('acme ag')", folder)
    check("short hold: the colleague can take it now", r.get("ok"), True)
    # No edit at all: the hold ends after a minute without a touch.
    pia.e("NOW = Math.max(NOW, %d);" % quin.e("NOW"))  # both PCs' clocks agree, as real ones do
    r, folder = pia.sync(folder)
    q, folder = quin.call("claimAccount('beta ag')", folder)
    check("short hold: a second account is taken", (q.get("ok"), q.get("reason")), (True, None))
    for m in (quin, pia, quin, pia):
        r, folder = m.sync(folder)
    r, folder = pia.call("getClaimStatus('beta ag')", folder)
    check("short hold: a touch without an edit holds the account", r.get("state"), "other")
    folder = wait(quin, 30000, folder)
    r, folder = quin.call("claimAccount('beta ag')", folder)  # still working on it: the page touches again
    folder = wait(quin, 40000, folder)
    r, folder = quin.sync(folder)
    r, folder = pia.sync(folder)
    r, folder = pia.call("getClaimStatus('beta ag')", folder)
    check("short hold: a touch within the minute keeps it", r.get("state"), "other")
    folder = wait(quin, 65000, folder)
    r, folder = quin.sync(folder)
    r, folder = pia.sync(folder)
    r, folder = pia.call("getClaimStatus('beta ag')", folder)
    check("short hold: a minute without a touch frees it", r.get("state"), "free")

    # 1.2.4 Notes, build step 0 (NOTES_DESIGN.md 3.3, 3.4, 5): every note is a row of its own.
    pia_id = pia.status()["me"]["memberId"]

    def note(on, key, text, by, name, at):
        return {"on": on, "key": key, "text": text, "at": at, "by": by, "byName": name, "editedAt": None, "deletedAt": None, "deletedBy": None}

    def put_note(m, note_id, value):
        notes = m.local("notes") or {}
        notes[note_id] = value
        m.set_local({"notes": notes})

    def note_changes(member_id, note_id):
        return [c for k, v in sorted(folder.items()) if k.startswith("members/%s/changes/" % member_id) and v
                for c in json.loads(v)["changes"] if c.get("id") == "note:%s" % note_id]

    def all_round(folder, members):
        for m in list(members) * 2:
            r, folder = m.sync(folder)
        return folder

    def apart(m, member_id, ms, seen):
        # Time passes on m's PC while it sees only the folder as it was (`seen`): OneDrive has not brought the
        # colleague's newest file yet. What m writes meanwhile still reaches the real folder.
        wrote = wait(m, ms, seen)
        folder.update({k: v for k, v in wrote.items() if k.startswith("members/%s/" % member_id)})

    # A. Two colleagues write a note on the same account at the same moment: both are kept (R1.4).
    put_note(pia, "n-pia", note("account", "acme ag", "Pia called.", pia_id, "Pia", 1000))
    put_note(quin, "n-quin", note("account", "acme ag", "Quin wrote.", quin_id, "Quin", 1000))
    folder = all_round(folder, (pia, quin))
    check("notes: two notes at the same moment - both on both PCs",
          (sorted(pia.local("notes")), sorted(quin.local("notes")), same(pia.local("notes"), quin.local("notes"))), (["n-pia", "n-quin"], ["n-pia", "n-quin"], True))
    check("notes: a note travels as its own row, filed under the account type",
          [(c.get("e"), c.get("op"), c["f"].get("text")) for c in note_changes(pia_id, "n-pia")], [("account", "set", "Pia called.")])
    check("notes: no line in the team log yet, and never the text (R8.2)",
          ["Pia called." in json.dumps(m.local("teamLog") or []) or "note:" in json.dumps(m.local("teamLog") or []) for m in (pia, quin)], [False, False])

    # B. A delete against a colleague's later edit: the note stays deleted on every PC (D2).
    gone = dict(pia.local("notes")["n-pia"], text="", deletedAt=2000, deletedBy=pia_id)
    put_note(pia, "n-pia", gone)
    seen = dict(folder)
    r, folder = pia.sync(folder)                       # the delete is out; Quin has not read it
    apart(quin, quin_id, 120000, seen)
    check("notes: Quin has not read the delete yet", quin.local("notes")["n-pia"]["deletedAt"], None)
    put_note(quin, "n-pia", dict(note("account", "acme ag", "Edited later.", pia_id, "Pia", 1000), editedAt=3000))
    folder = all_round(folder, (quin, pia))
    check("notes: deleted, then edited later by a colleague - still deleted on both PCs",
          [(m.local("notes")["n-pia"]["deletedAt"], m.local("notes")["n-pia"]["deletedBy"]) for m in (pia, quin)], [(2000, pia_id), (2000, pia_id)])
    # ... and the other way round: the edit is made first, the delete later.
    put_note(quin, "n-quin", dict(quin.local("notes")["n-quin"], text="Quin edited.", editedAt=3000))
    seen = dict(folder)
    r, folder = quin.sync(folder)
    apart(pia, pia_id, 400000, seen)
    check("notes: Pia has not read the edit yet", pia.local("notes")["n-quin"]["text"], "Quin wrote.")
    put_note(pia, "n-quin", dict(note("account", "acme ag", "", quin_id, "Quin", 1000), deletedAt=4000, deletedBy=pia_id))
    folder = all_round(folder, (pia, quin))
    check("notes: edited, then deleted later - deleted and without its text on both PCs",
          [(m.local("notes")["n-quin"]["deletedAt"], m.local("notes")["n-quin"]["text"]) for m in (pia, quin)], [(4000, ""), (4000, "")])
    check("notes: the entries stay (a removed entry could come back)", (sorted(pia.local("notes")), same(pia.local("notes"), quin.local("notes"))), (["n-pia", "n-quin"], True))

    # C. A note goes out while the account is held - the holder's and a colleague's (R4.4).
    r, folder = quin.call("claimAccount('beta ag')", folder)
    check("notes: Quin takes Beta for editing", r.get("ok"), True)
    put_note(quin, "n-holder", note("account", "beta ag", "Holder's note.", quin_id, "Quin", 5000))
    r, folder = quin.sync(folder)
    check("notes: the holder's note is sent at once", len(note_changes(quin_id, "n-holder")), 1)
    r, folder = pia.sync(folder)
    r, folder = pia.call("getClaimStatus('beta ag')", folder)
    check("notes: Pia sees Quin editing Beta", r.get("state"), "other")
    put_note(pia, "n-colleague", note("account", "beta ag", "Written while Quin edits.", pia_id, "Pia", 6000))
    r, folder = pia.sync(folder)
    check("notes: a colleague's note is sent while the account is held", len(note_changes(pia_id, "n-colleague")), 1)
    r, folder = quin.sync(folder)
    r, folder = quin.call("getClaimStatus('beta ag')", folder)
    check("notes: ... it arrives on the holder's PC, who still holds the account",
          ((quin.local("notes").get("n-colleague") or {}).get("text"), r.get("state")), ("Written while Quin edits.", "mine"))
    r, folder = quin.call("releaseAccount('beta ag')", folder)
    folder = all_round(folder, (quin, pia))

    # D. A colleague who has not updated yet (still on 1.2.3) is not disturbed, and gets the notes after updating.
    inv, folder = invite(pia, "Rex", folder)
    rex = Member("rex", now_offset=11, before_notes=True)
    rex.set_local({"notes": {"n-own": note("account", "acme ag", "Not a shared key on this build.", None, None, 1)}})
    r, folder = rex.call("joinTeam({ inviteId: '%s' })" % inv, folder)
    check("notes, older build: joins", r.get("ok"), True)
    folder = all_round(folder, (rex, pia, quin))
    rex_id = rex.status()["me"]["memberId"]
    x = rex.local("targetAccountExtras"); x["acme ag"]["status"] = "Responded"; rex.set_local({"targetAccountExtras": x})
    put_note(pia, "n-after", note("account", "acme ag", "Written after Rex joined.", pia_id, "Pia", 7000))
    folder = all_round(folder, (rex, pia, quin, rex))
    check("notes, older build: syncs without an error", (rex.status().get("lastError"), r.get("ok")), (None, True))
    check("notes, older build: its own change still reaches the team", ((pia.local("targetAccountExtras") or {}).get("acme ag") or {}).get("status"), "Responded")
    check("notes, older build: it writes no note rows, and its own data is untouched",
          ([k for k in folder if k.startswith("members/%s/changes/" % rex_id) and "note:" in folder[k]], sorted(rex.local("notes"))), ([], ["n-own"]))
    check("notes, older build: the team's notes are all still there",
          (sorted(pia.local("notes")), same(pia.local("notes"), quin.local("notes"))), (["n-after", "n-colleague", "n-holder", "n-pia", "n-quin"], True))
    # Rex updates: the notes read by the older build are written to this PC once; the note Rex had goes to the team.
    rex.e("TEAM_MAP_KEYS.push({ key: 'notes', e: 'account', prefix: 'note:' }); TEAM_SHARED_KEYS.push('notes'); mem.meta.newKeysV = 0;")
    folder = all_round(folder, (rex, pia, quin))
    check("notes, after updating: the colleague has every note, and the team has theirs",
          (sorted(rex.local("notes")), same(rex.local("notes"), pia.local("notes")), same(pia.local("notes"), quin.local("notes"))),
          (["n-after", "n-colleague", "n-holder", "n-own", "n-pia", "n-quin"], True, True))
    check("notes, after updating: a deleted note is still deleted there", rex.local("notes")["n-pia"]["deletedAt"], 2000)

    print()
    for f in _failures:
        print("FAIL  %s" % f)
    print()
    if _failures:
        print("%d passed, %d FAILED" % (_passes, len(_failures)))
        return 1
    print("%d checks passed." % _passes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
