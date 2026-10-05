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
REAL = ["team-merge.js", "team-keys.js", "team-rows.js", "team-sync.js"]
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
    return re.sub(r"^export\s+(?=(const|let|var|function|class|async)\b)", "", src, flags=re.M)


class Member:
    """One browser profile: its own context, storage, timers and IndexedDB."""

    def __init__(self, label, now_offset=0):
        self.label = label
        self.ctx = MiniRacer()
        self.ctx.eval(FAKES)
        self.ctx.eval("NOW += %d;" % now_offset)
        self.ctx.eval("\n".join("// ===== %s =====\n%s" % (n, strip_module(n)) for n in REAL))
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
        return [deep_sorted(x) for x in v]
    return v


def same(a, b):
    return json.dumps(deep_sorted(a)) == json.dumps(deep_sorted(b))


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
    check("join: ok", r.get("ok"), True)
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
    r, folder = cleo.call("joinTeam({ name: 'Cleo' })", folder)
    r, folder = ben.sync(folder)
    check("compact: Cleo joining after compaction has the same picture as Anna",
          same({k: v for k, v in picture(cleo).items() if k != "results"}, {k: v for k, v in picture(anna).items() if k != "results"}), True)
    check("compact: ... and as Ben", same(picture(cleo), picture(ben)), True)

    # 10. Cleo leaves: sync stops, her data stays, the folder is forgotten on her PC, her files stay in the folder.
    me = cleo.status()["me"]["memberId"]
    r, folder = cleo.call("leaveTeam()", folder)
    check("leave: ok", r, {"ok": True})
    check("leave: no longer a member", cleo.status(), {"member": False})
    check("leave: her data stays", same(picture(cleo)["targetAccounts"], picture(ben)["targetAccounts"]), True)
    check("leave: the team folder is forgotten on her PC", cleo.e("FOLDER_CLEARED"), True)
    check("leave: her files stay in the folder", any(p.startswith("members/%s/" % me) for p in folder), True)

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
