# SalesTeam — Team Use: Design

Target release: **1.2.2** (test builds 1.2.1.2 …; 1.2.1.1 was the Setup styling fix)
Status: **Design — agreed 2026-10-03.** Boaz agreed to D1–D6 as proposed (section 12). Step 0 on one laptop
is done (findings in 2.6); OneDrive's delay between two PCs is measured at the end.
Date: 2026-10-02
Builds on: `TEAM_USE_REQUIREMENTS.md` (agreed 2026-10-02). Requirement numbers (R3.3, R6.5 …) refer to it.

---

## 1. The design in one page

1. **The team folder holds append-only change files, one writer per file.** Each member's SalesTeam
   writes only into its own sub-folder, and never changes a file once written. OneDrive therefore never
   sees two PCs writing the same file, so it never makes a conflict copy (section 3).
2. **Every member rebuilds the same picture from everyone's files.** A change is a small record —
   "Anna set field X of account Y to Z at time T". Merging is by fixed rules that give the same result on
   every PC, whatever order the files arrive in: for the same field, the later change wins (section 4).
3. **The existing code does not change.** `chrome.storage.local` stays the local copy every page reads
   and writes today. A new **sync layer** watches it (`chrome.storage.onChanged`, which already reports
   the old and the new value of every write), turns local changes into change records, and writes others'
   changes back into it. The pages already redraw on `onChanged`, so remote changes appear by themselves.
   None of the ~170 write sites in `storage.js` is touched (section 5).
4. **Claims are change records too.** "Anna claims account Y" is written like any other change. The
   earliest claim wins. A claim is *confirmed* as soon as every active colleague's heartbeat shows they
   have written something after it — if they had claimed earlier, it would have arrived with that
   (section 6). Typically that is a few seconds; meanwhile the screen says "Checking with the team…".
5. **An assignment is a claim that does not expire.** "Assign to me" and "Release" reuse the same
   mechanism (section 7).
6. **Local first, folder second.** Changes go into a local outbox at once and are written to the folder
   whenever it is connected. A missing reconnect click after a browser restart delays sharing; it never
   loses work (R3.12, section 8).
7. **The format is ready for Microsoft Graph later.** Immutable files with unique names are exactly what
   a server API handles well; Option B would replace the folder adapter only (section 3.4).

---

## 2. What the code review found

### 2.1 Shared data is a handful of storage keys, mostly whole maps
The data the team must share sits in a known list of `chrome.storage.local` keys (section 5.1). The big
ones are `targetAccountsWorkbook` (`companies[]` with `companyId`, `contacts[]` with `contactId` and
`companyId`), `targetAccounts` (keyed by normalised company name), `targetAccountExtras` and
`targetContactExtras` (keyed by company / contact key) and `results` (the leads, keyed by lead key). Every
row already has a stable id — the basis for per-entity records.

### 2.2 Writers rewrite whole maps
A writer reads a whole map, changes a few rows and writes the whole map back (protected within one
browser by `withAccountWriteLock`). The sync layer must therefore find *which rows* changed itself, by
comparing old and new value — the writers don't say.

### 2.3 `onChanged` is already the redraw signal
Pages (dashboard, target accounts, decisions dot, batch status, activity log …) and the background worker
listen to `chrome.storage.onChanged`. Writing a remote change into local storage is enough for every open
page to show it.

### 2.4 The folder mechanism exists
`backup-folder.js` keeps a folder handle in IndexedDB, checks `queryPermission`, and asks
`requestPermission` from a click (the "click to resume" banner). The team folder reuses the same pattern
with its own handle.

### 2.5 Open technical points for step 0
- Whether the background service worker may use a folder handle whose permission was granted on a page
  *[step 0]*. If not, the folder work runs in an open SalesTeam page (section 8.2).
- Whether Chrome keeps the folder permission across restarts for an extension ("allow on every visit")
  *[step 0]*. The backup folder suggests it does not.
- OneDrive's real delay for a small new file between two PCs *[step 0]*.

### 2.6 Step 0 findings so far (2026-10-03, one laptop, two Chrome profiles, 1.2.1.2)
- **Claim race: passed.** Both profiles claimed the same account at the same full minute; both showed the
  same winner (the earlier stamp). The merge rule of 6.2 works on real files.
- **Writing into the OneDrive folder is slow: about 2–2.6 s per new file**, even with only one profile
  writing (a local folder takes milliseconds). Chrome writes via a temporary file and a rename, OneDrive
  picks up every new file, and the virus scanner checks it.
- **A write can fail while OneDrive handles the file:** after 143 files, Chrome reported
  `InvalidStateError` ("the state had changed since it was read from disk") and left `bulk-143.json`
  **empty (0 bytes)**. No temporary (`.crswap`) files and no conflict copies were left behind.
- **Background worker: works only while a SalesTeam page is open.** With the test page open, the
  background saw permission `granted` and wrote into the folder. Ten seconds after the page was closed,
  it saw `prompt` and failed (`NotAllowedError`): Chrome withdraws the folder permission when the last
  SalesTeam page closes. So section 8.2 becomes: the background does the folder work **while any SalesTeam
  page is open** (it then holds the permission); with none open, changes wait in the outbox and are written
  when a page opens again. **The side panel alone is enough** (19:21: tab closed, side panel open ->
  `granted`, background wrote), so a member who keeps the SalesTeam side panel open shares continuously.
- **After a browser restart: `granted` without asking** — confirmed with `chrome://restart` (a guaranteed
  full restart), 2026-10-03. The reconnect click of R3.12 stays as a fallback only, rarely seen.
- **This depends on the choice in Chrome's permission dialog** (live test of step 2, 2026-10-04). With
  **"Allow this time"**, closing every SalesTeam page leaves the folder at `prompt` even after a page is opened
  again: nothing syncs until a Reconnect click (changes wait locally, nothing is lost). With **"Allow on every
  visit"**, all pages closed, a change made meanwhile by a colleague, page reopened with no click: `granted`, and
  the change arrived. So the create / join instructions (step 3) must say: choose **"Allow on every visit"**;
  the "Click to reconnect" top-bar message is for whoever chose "this time".
- **Consequences for the design (firm rules):**
  1. **Few, bundled files.** One change file per flush (at most every 5 s), heartbeat folded into the same
     write where possible; never one file per change.
  2. **Every write is retried** (re-open the handles, back off 1 s, 3 s, 10 s), and stays in the outbox
     until a read-back confirms the file is complete.
  3. **Readers tolerate incomplete files:** an empty or unparsable file is "not finished yet", skipped and
     read again next round — never an error, never treated as data.

### 2.7 Step 2 as built (1.2.1.4, 2026-10-03)
- **Files:** `team-keys.js` (which keys are shared — pure), `team-rows.js` (local values ↔ rows ↔ changes —
  pure), `team-folder.js` (the folder adapter: retried writes with read-back, tolerant reads, IndexedDB),
  `team-sync.js` (the engine, in the background worker). `team-merge.js` gained `compactChanges` and a clock
  that borrows the next millisecond after 9,999 stamps in one (a team's base stamps every row at once).
- **Rows per local home** instead of one joined account record — see 4.1.
- **Heartbeat:** one `heartbeat.json` per member, rewritten by its only writer (one writer per file, so no
  conflict copies), written only when the member has sent no change file for 60 s. A heartbeat counts for
  "read up to" (6.3) only once every change file it vouches for has been read.
- **Clobber guard:** a writer outside the account lock (e.g. `saveResults`) that read a map before a colleague's
  change was written back, and saved it after, would put the old row back. A row that returns to exactly its
  pre-write-back value within 15 s is written again and **not** sent to the team.
- **Never overwrites its own numbering:** a member whose local state was lost continues after the highest
  change file it finds in its folder.
- **Timers:** a 30 s `chrome.alarms` alarm (new permission `alarms` — shows no warning) plus in-worker timers
  (flush 5 s, read 15 s) while the folder is usable; none while it is not, so the worker can sleep.
- **Comparison cost (5.4), measured** with 600 accounts × 30 fields, 3,000 contacts and 2,000 leads (2.2 MB +
  1.4 MB): one edited field → about 0.2 s for compare + save, including copying the values, on a 1 s debounce.
  Creating the team: base file 3.8 MB, 0.4 s; joining from it: 0.8 s (plus OneDrive's ~2.5 s per file write).
  The live measurements are on the test page.
- **Tests:** `test_pure_modules.py` (row mapping, compaction, clock — 568 checks) and the new
  `test_team_sync.py`, which runs the real `team-sync.js` for three simulated members on a fake storage and an
  in-memory shared folder: create, join, edit, concurrent edits, lead delete vs draft, clobber, failed write
  (empty file) and retry, status, compaction and joining after it (35 checks).
- **Developer test page:** `zz_team_sync.html` — pick folder, create / join / leave, sync now, status with
  colleagues and measurements, unclassified storage keys. Settings > Team replaces it in step 3.

### 2.8 Step 3 as built (1.2.1.6, 2026-10-04)
- **Settings > Team** (`team-ui.js`, card in `settings.html`, menu item "Team" with an "N online" badge): *Create a
  team…* and *Join a team…*, each with numbered click-by-click instructions (OneDrive folder, "Always keep on this
  device", sharing, and **"Allow on every visit"** in Chrome's dialog — 2.6). The picked folder is checked before
  anything is saved (create: empty; join: `team.json` present and readable) and stored only when the action runs.
  Then a full backup, then create / join. In a team: who you are and your role, the folder (connected / Reconnect /
  pick again — must be the same team), what waits to be written, last written / read, the last problem, members with
  role, last seen and "online" (anything written in the last 3 minutes), *Sync now*, *Leave the team…*.
- **Join** marks the Setup as done (`onboardingCompletedAt`): the seller setup came with the team. Afterwards the member
  is told what is still personal to fill in (API key, User Profile). Join refuses while automatic preparation is running
  ("Pause for today" first).
- **Leave** also forgets the folder on this PC.
- **Top bar** (`initTeamBar`, on every page): only when something needs doing — "Click to reconnect to the team folder"
  (button *Reconnect*), "SalesTeam cannot use the team folder … pick it again" (permission denied / no folder), or "Not in
  sync" (button *Try again*). The status bar gained **priority** messages so these stay above the pipeline's line. A
  healthy team shows nothing in the bar (the "online" count is on the menu item) — the bar stays the pipeline's.
- **"Not in sync" is judged from this PC's side only:** folder rounds failing for 2 minutes. *Deviation from 8.4:* the
  colleague-silence rule ("no news for 10 minutes while their heartbeats said they were active") cannot tell a paused
  OneDrive from a colleague who closed the laptop lid or quit Chrome — none of these leaves a sign-off — and a false
  "not in sync" would block work. Colleagues' silence is shown as their "last seen" instead. Blocking edits while not in
  sync comes with the claims in step 4, where it matters (6.6).
- **Backups and restore:** `teamMembership` is no longer written into backups (it belongs with the sync state in
  IndexedDB and the folder permission). A restore while in a team asks first — what it puts back is sent to every
  colleague.
- **Tests:** `test_team_sync.py` 45 checks (+ roles, online, join marks Setup done, leave).

### 2.9 Step 4 as built (1.2.1.7, 2026-10-05)
- **Claims are named by company key** (the normalised company name), `account|@<key>` — *deviation from 4.1's bare
  `companyId`*. Every local home already resolves to the key without a join: `ta:`/`x:` rows carry it in their id, a
  contact's extras key begins with it, a workbook row has its company name (a workbook contact without one: its
  company row). The account page and the pipeline both work by that key. Leads and settings belong to no claim.
  Pure helpers in the new `team-claims.js`: which account a change belongs to, and the claim state as one member sees
  it — *free*, *checking*, *mine* (confirmed), *other* (a colleague holds it), *lost* (a colleague claimed first).
- **Held edits (6.1, 6.3):** while my claim is *checking*, my changes to that account's account and contact rows are
  applied on my PC but kept out of the change files. Confirmed → they go out at once. Lost → they are taken back out
  of the merged state (`retractChanges` in `team-merge.js`: each field goes back to the later of its value before the
  held edits and any colleague value they overwrote; a colleague's later change is untouched), the rows on my PC get
  the winner's values again, and the edits are **kept aside**. My lost claim is withdrawn (a `release`), so it cannot
  become the holder when the winner is done. Held and kept-aside edits live in IndexedDB with the rest of the sync
  state — a reload loses nothing.
- **Confirmation is fast:** a member that reads a colleague's claim writes its heartbeat at once (an "ack"), and the
  heartbeat carries the member's clock stamp — that clock has seen every claim the member had read, so it proves
  "nothing earlier from me" even if the two PCs' clocks differ. While a claim of mine is checking, the folder is read
  every 5 s instead of 15 s. With no colleague active (seen in the last 10 minutes, D5) a claim is confirmed at once.
- **Account and contact pages** (`team-claims-ui.js`): the first touch of an editable control (the overview, the ⋮
  menu, the contacts list, the web research card) claims the account; renewed at most once a minute while the member
  works; released when the page shows something else (a claim also runs out after 5 idle minutes, R3.4). A strong
  notice under the title shows what the team sees: "Anna is updating this account (since 09:41)" — the editable parts
  then take no clicks or focus, links still work (reading is never blocked); "Checking with the team…"; a lost claim
  with "your N changes were kept aside" and **Apply my changes now** (possible once the account is free — stamped
  anew under a new claim) / **Discard them**; and **not in sync / folder not connected**: changes blocked (R3.8, 6.6).
  A contact's claim is its account's.
- **Pipeline and web lane (6.5):** each round asks the gate — not connected or not in sync: the run stops ("team
  folder not connected"; in a team, automatic work runs only while colleagues can see what it works on). Otherwise it
  works only accounts no colleague holds and that fall in this member's rendezvous share of the members active now.
  It claims an account before starting on it and renews the claim every minute; it does **not** wait for the
  confirmation — its writes are held like anyone's, so a lost race costs at most the research (~US$0.08), never data.
  Released when done. The web lane filters its list the same way and claims each account before researching it.
- **Rendezvous hash fixed:** FNV-1a alone ordered two members almost identically for every account — two real ids
  made in the same session split 40 accounts 40:0. A murmur3 finaliser on the score fixed it (19:21 in the test).
- **Not yet (step 5):** the Target Accounts list's row actions, bulk edit, the Leads Dashboard and the user-started
  bulk research do not ask for claims yet; they get the off-limits checks together with assignments.
- **Also:** the once-only "research your company website" offer in Settings is no longer shown to members (D3).
- **Tests:** `test_pure_modules.py` +24 (account key of every row kind, the five claim states, retracting held sets and
  deletes, re-applying) = 592; `test_team_sync.py` +30 = 75 (claim → held → ack → confirmed → sent; a two-member race
  with kept-aside and apply after release; pipeline shares disjoint and covering; a held account refused to a
  colleague's pipeline).

### 2.11 Added to 5b by Boaz (2026-10-05): removing accounts
- **Remove is admin-only in a team** - the row menu, the account page and bulk edit. (Removal is shared: it takes the
  account off every member's list.) Not in a team: unchanged.
- **Bulk edit:** the "Remove these N accounts from the list" checkbox moves into a collapsed **Advanced** part of the
  dialog (removing many rows at once is the dangerous one).
- **Every removal stays a soft delete** (`deletedAt` on the extras row - already true for Remove, bulk remove, undo of
  a discovery run and merge).
- **Removed accounts view:** lists every removed account with its **removal date** (and, in a team, who removed it),
  checkboxes, select-all, sortable by date, and a bulk **Restore** - so a removal done on a given day can be undone
  in one go. Team Admin only in a team; anyone when solo. Accounts removed by a *merge* are shown as "merged into X"
  and restored only by undoing the merge, not here (restoring one alone would bring back a duplicate) - *agreed*.
- **Contacts too** (agreed 2026-10-05): the view has an **Accounts / Contacts** switch; removed contacts the same way
  (date, who, checkboxes, bulk Restore), and Remove of a contact is admin-only in a team as well. A contact whose
  account is itself removed is restored with a hint to restore the account too.

### 2.10 Step 5a as built (1.2.1.8, 2026-10-05)
- **Step 5 split in two builds** so each is live-testable: 5a = assignments (this), 5b = team-wide check,
  do-not-contact, outreach check (1.2.1.9). Step 6 moves to 1.2.1.10.
- **Assignments** live on the claim's record (`account|@<company key>`). `team-merge.js activeAssignments` lists the
  active ones, earliest first; `team-claims.js assignmentView` / `offLimitsFor` / `teamAccountSummary` (pure) say who
  has an account, whether my assignment is confirmed or lost, and why an account is off-limits to me (*assigned* to a
  colleague, or *held* - a colleague updating it).
- **team-sync:** `TEAM_ASSIGN` (to me; the admin may pass `to`), `TEAM_UNASSIGN` (own; the admin: anyone's - every
  active assignment, so nothing is left to take over), `TEAM_UNASSIGN_ALL` (admin, Settings > Team "Release all"),
  `TEAM_ASSIGN_COUNTS`, `TEAM_ASSIGN_DISMISS`. Refused when the folder is not connected / not in sync, or while a
  colleague is updating the account. A race (R6.1): the earlier assignment wins; the later one is **withdrawn** by its
  author's sync (an `unassign`, else it would take over when the winner releases) and shown once ("Ben assigned this
  account to themselves a few seconds before you"). Reading an `assign` triggers the ack heartbeat like a claim, so
  confirmation is as fast. A claim on a colleague's assigned account is refused (`assigned`).
  **Changed after the first live try (Boaz, 2026-10-05):** "checking with the team" took ~10 s on OneDrive (write,
  colleague's 15 s read, ack, our 5 s read) - too long. Assign to me now checks only that the account is unassigned
  (and nobody is updating it) and shows **"Assigned to you" at once**. The confirmation still runs in the background:
  in the rare same-second race the later assignment is withdrawn and its member sees the notice on the account page.
  Edits stay protected by claims (held until confirmed), so nothing is lost either way.
- **Pipeline / web lane (Q6):** `mayWork` refuses a colleague's assigned account and always allows my own (outside
  my rendezvous share too). **Bulk research** (user-started) leaves out off-limits accounts before the start, claims
  each account while researching it, and reports how many were left out.
- **Pages** read `teamAccountStates` (personal key, written by the background only when it changes; excluded from
  backups): `team-accounts-ui.js` gives badges ("Anna", "Mine", "Anna is updating"; "Assigned to Anna since 3 Oct" in the tooltip), the owner filter and off-limits
  checks. Account / contact page: an assignment line under the title (Assign to me / Release; admin: Release
  (unassign) and Reassign to…); a colleague's assigned account is blocked like a held one. Target Accounts list:
  badge after the company name (accounts and contacts lists), Mine / Others / Unassigned / All (Boaz 2026-10-05: Others added, Everyone's renamed All; remembered in the
  browser profile = per member), row menu Assign to me / Release, and Edit / Merge / Remove / Review findings disabled
  on a colleague's account with the reason as tooltip; bulk bar Assign to me / Release; bulk edit skips a colleague's
  accounts (and their contacts) and says how many.
- **D3 enforced:** a member sees Setup / Change Settings read-only with a strong note; only their own name, API key
  and language stay editable. The exclusion list can therefore only be changed by the admin until 5b gives members a
  "do not contact" action.
- **Settings > Team:** an "Accounts assigned" column; admin "Release all" per colleague.
- **Tests:** `test_pure_modules.py` +12 = 604; `test_team_sync.py` +20 = 95 (assign → confirmed; refused claim /
  assign / release for the colleague; gate off-limits; badge data; a two-member race with withdrawal; release;
  admin reassign, counts and release all).

---

## 3. The team folder

### 3.1 Layout

```
SalesTeam Team/                      (the folder Boaz creates and shares)
  team.json                          team id, name, format version, created by — written once by the creator
  admins/<memberId>.json             one file per admin grant (written by an admin)
  members/<memberId>/
    profile.json                     name, e-mail, joined at, SalesTeam version
    heartbeat.json                   "last seen" + highest change number written (see 6.3); rewritten by its one writer
    changes/c-<n>.json               change files, numbered 1, 2, 3 … per member, never rewritten
    snapshots/s-<n>.json             this member's compacted state up to change n (section 3.3)
  base/base-<time>.json              the starting data the creator brought in (R3.9)
```

`memberId` is a random id created on joining, stored locally (personal), so two people with the same name
or two PCs of the same person never collide. A person on two PCs is two members with the same name.

### 3.2 A change file
A change file holds the changes collected over a few seconds (flush every 5 s while there are changes,
section 8.1):

```json
{ "member": "m-7f3a", "n": 412, "written": "2026-10-03T09:41:07.120Z",
  "changes": [
    { "t": "1759484467011-0-m-7f3a", "e": "account", "id": "c-1042",
      "op": "set", "f": { "status": "Contacted", "nextAction": "Call 7 Oct" } },
    { "t": "1759484467950-0-m-7f3a", "e": "account", "id": "c-1042",
      "op": "claim", "kind": "edit" }
  ] }
```

- `t` is a **hybrid logical clock** stamp (wall-clock ms, counter, member) — orders changes the same way on
  every PC even when two PCs' clocks differ by a few seconds, and never goes backwards on one PC.
- `e` / `id` name the entity (section 4.1); `op` is `set`, `delete`, `claim`, `release`, `assign`,
  `unassign`, `touch` (an outreach, R3.6). The do-not-contact list (R6.8) needs no op of its own: it is a
  `team` entity whose fields are the entries, set and cleared with `set` (built in step 1, `team-merge.js`).
- `f` holds only the fields that changed (top-level fields of the row; nested values travel whole).

### 3.3 Keeping the folder small
Change files are small but many. Each member compacts **its own** files: once a day it writes
`snapshots/s-<n>.json` (its latest value per field it has written, with stamps) and deletes its change
files ≤ n that are older than 7 days. Readers that are behind fall back to the snapshot. Nobody ever
deletes another member's files.

### 3.4 Why this format survives a later move to Microsoft Graph (Option B)
Every file has a unique name and is written once — the case Graph handles atomically (create with
"fail if exists"). Moving to Option B replaces the folder adapter (`team-folder.js`) and nothing else;
the claim rule could then also be tightened to a server-decided lock.

---

## 4. Merging: the same picture on every PC

### 4.1 Entities
| Entity `e` | id | Comes from (local storage) |
|---|---|---|
| `account` | `companyId` | `targetAccountsWorkbook.companies[]`, `targetAccounts[normalised name]`, `targetAccountExtras[companyKey]` |
| `contact` | `contactId` (belongs to an account by `companyId`) | `targetAccountsWorkbook.contacts[]`, `targetContactExtras[contactKey]` |
| `lead` | lead key | `results[key]` minus personal fields (draft, Sales Mentor history) |
| `setting` | storage key | each shared setting key (section 5.1), whole value |
| `team` | fixed ids | members, admins, the do-not-contact list |

*Originally planned:* an account's three local homes joined into one record by company key ↔ `companyId`,
with namespaced fields (`wb.`, `ta.`, `x.`). *Replaced in step 2, because a join breaks on duplicate company
names, rows with no workbook match and renames.* **As built (2.7):** each local home is its own
row, with the home in the id — `account|wb:<companyId>`, `account|ta:<company key>`, `account|x:<company key>`,
`contact|wb:<contactId>`, `contact|x:<contact key>`, `lead|<lead key>`, `setting|<storage key>`. Writing back is
exact without any join, and a renamed company simply moves its `ta:`/`x:` rows, as it does locally. Claims and
assignments (steps 4–5) use the bare `companyId` (`account|c-1042`), which is never a data row.

### 4.2 Rules (`team-merge.js`, pure, tested in `test_pure_modules.py`)
- **Same field, two values:** the change with the later stamp wins. The losing value is kept in the team
  log (R3.11), so nothing disappears silently.
- **Delete vs. change:** a delete wins over earlier changes and loses to later ones (a later edit
  "revives" the row — the safer side for sales data).
- **Claims:** section 6. **Assignments:** section 7.
- **Order-free:** applying the same set of changes in any order gives the same result. This is the
  property the tests check most (shuffle the changes, compare results).

### 4.3 Who changed what (R3.11)
Every merged field remembers the stamp and member of its winning change. "Last changed by Anna, 3 Oct
09:41" on an account is read from there; the team log in the Activity Log page is built from the change
files themselves — no separate log to keep in sync.

---

## 5. The sync layer

### 5.1 Shared and personal keys (R3.6)

| Shared (synced) | Personal (never leaves the PC) |
|---|---|
| `targetAccountsWorkbook`, `targetAccounts`, `targetAccountExtras`, `targetContactExtras`, `keptSeparateAccountPairs`, `discoveryNameDecisions`, `companyLocationSizeCache` | `anthropicApiKey`, `userProfile`, `outputLanguage`, `mentorPersona`, `customerPersona` |
| `results` (leads), except draft and Sales Mentor fields | `advisorHistory`, `customerVoiceHistory`, drafts |
| Seller setup: `companyContext`, `companyWebsite`, `sellerCompanyName`, `setupResearch`, `idealCustomerProfile`, `targetUniverseConfig`, `targetContactProfile`, `accountPriorityGuidelines`, `completionTargets`, `initiativeStagePreference`, `includedCompanies`, `valueAddOffers`, `messageTemplates` | Activity Log, `lastBulkChange`, `lastWebDiscoveryAdd` (undo stays personal), `onboardingMeasures`, onboarding progress |
| Rules: `companyExclusions` (+ lifted), `organizationTypeEligibility`, `companyAliases`, `negativeTopics`, `prioritizationRuleOverrides`, `postPrioritizationRules`, `webFindingsArbitration`, `revenueNormalization`, `targetAccountScoreThreshold`, `jobRulesMinConfidence`, `keywordSearchLanguages` | Scanner settings: topics, timeframe, author titles, job search (**D2**); LinkedIn limits and counters; web budget; `discoveredCompanies` / `discoveredContacts` staging |

The list lives in one place (`team-keys.js`) so a new storage key has to be classified once, deliberately.

### 5.2 Local → team (`team-sync.js`)
1. The background worker listens to `chrome.storage.onChanged` for shared keys only.
2. It compares the **new value with its shadow copy** — the last state it knows the team has — row by row
   (by id; a per-row fingerprint makes unchanged rows cheap to skip), and emits `set`/`delete` changes
   for the fields that differ.
3. Changes go to the **outbox** at once — written before anything else happens, so a reload loses nothing
   ("persist as you go"). *As built:* the outbox, the shadow and the merged state live in IndexedDB
   (`salesteam-team`), saved in one transaction, not in `chrome.storage.local` — the merged state is several MB
   and must not wake every page's `onChanged` listener.
4. The shadow is updated.

Comparing against the shadow, not against `oldValue`, is what stops echoes: when the sync layer itself
writes a colleague's change into local storage, the shadow already holds it, so no change is re-emitted.

### 5.3 Team → local
1. Every 15 s while connected (and right after a reconnect), read each member's new change files.
2. Merge them into the shadow by the rules of section 4.
3. Write the affected rows back into the local keys **inside `withAccountWriteLock`**, so a remote change
   queues behind a local writer instead of racing it.
4. Pages redraw by themselves (2.3).

### 5.4 Cost of the comparison *[measured in step 2 — see 2.7: no fallback needed]*
`targetAccountsWorkbook` is the largest value (a few MB with ~600 accounts). Comparing it on every write
is fine for a few writes a second; the pipeline writes more often in bursts. If the comparison shows in
the measurements, the fallback is to debounce (compare at most once per second per key, against the
latest value) — still without touching the writers.

---

## 6. Claims: claim, then confirm (R3.3–R3.5)

### 6.1 Taking a claim
Before a member edits an account (first change on the account page) or the pipeline starts work on it,
SalesTeam writes a `claim` change and flushes at once. Locally the account shows **"Checking with the
team…"**; edits are possible but held in the outbox, not yet sent.

### 6.2 Who wins
Among the unexpired claims on an entity, the **earliest stamp wins** (ties by member id). Every PC applies
the same rule to the same files, so all reach the same winner.

### 6.3 When a claim is confirmed
Each member's heartbeat (every 60 s, and with every flush) records the highest change number it has
written. A claim made at time T is **confirmed** once, for every *active* colleague (heartbeat seen in
the last 10 minutes), a heartbeat or change written after T has been read. Anything that colleague
claimed before T was written before that file, so it would already have been seen. With OneDrive's usual
delay this takes seconds. Then:
- **won:** "Checking…" disappears; held edits are sent; the account shows "Anna is updating (since 09:41)"
  on colleagues' screens.
- **lost:** "Ben started on this account a few seconds before you — your changes are kept aside." The held
  edits stay in a "kept aside" list for that account and can be re-applied when Ben is done (R3.3).

### 6.4 Expiry and release (R3.4)
An edit claim ends when the member leaves the account page, after 5 minutes without a change, or when the
member's heartbeat is more than 5 minutes old (browser closed, PC asleep). Release is a `release`
change, written like any other. Anyone can see who holds a claim and since when.

### 6.5 The pipeline (R3.5)
- It skips accounts claimed or assigned by others.
- It works only its **own share of the unassigned accounts**: each active member gets the accounts for
  which "this member's id + the account id" scores highest (rendezvous hashing). When a member joins or
  leaves, only that member's share moves.
- It claims an account before research and starts only once the claim is confirmed (a few seconds, against
  a research run of ~20 s).
- A rare double research inside the sync window costs ~US$0.08 and merges harmlessly by field.

### 6.6 The accepted edge case
A member whose PC was offline without SalesTeam noticing could, on reconnecting, deliver an older claim that
beats one already confirmed. SalesTeam prevents most of it by refusing claims while "not in sync" (R3.8 —
no colleague's file read for 10 minutes while colleagues are active); what remains is reported to both
members as a lost claim, never as silent data loss.

---

## 7. Assign to me / release (R6.1–R6.4)

- **Assign to me** writes `assign` on the account; **Release** writes `unassign`. Assignment uses the
  confirmation of 6.3 (two members assigning within seconds: the earlier one keeps it, R6.1).
- An assignment does not expire. The Team Admin can unassign or reassign anyone's account (R6.4);
  members only their own.
- **Assigned accounts are off-limits** to colleagues: their edits, scans, research, pipeline and outreach
  are blocked, reading stays open (R6.2, Q6).
- **Badge (R6.5):** "Assigned to Anna since 3 Oct" / "Anna is updating (since 09:41)" on account and contact
  rows and detail pages, and as a small badge injected on LinkedIn company and profile pages by the
  existing LinkedIn content script (looked up by company id / profile slug).
- **Filter (R6.3):** Mine / Others / Unassigned / All on Target Accounts, remembered per member.
- **Team-wide check (R6.6):** scans, discovery and imports look the candidate up in the merged picture
  (normalised name, `companyId`, LinkedIn URL) before adding; what a colleague holds is flagged, not
  duplicated. Before drafting or logging outreach to a contact, the `touch` history and the assignment are
  checked — no second approach.
- **Do-not-contact (R6.8):** `companyExclusions` becomes team data; members add (`dnc`), only an admin
  removes.

---

## 8. Where the code runs, and reconnecting

### 8.1 Timers
Flush the outbox every 5 s while non-empty; read colleagues every 15 s; heartbeat every 60 s; compact
once a day. In the background worker these run on `chrome.alarms` plus the pipeline's existing wake-ups.

### 8.2 Background or page *[step 0 decides]*
- **Preferred:** the background worker holds the folder handle (from IndexedDB) and does all folder work,
  so sharing continues with no SalesTeam page open.
- **Fallback:** if the worker cannot use the handle, the folder work runs in whichever SalesTeam page is
  open, with a Web Lock (`salesteam-team-sync`) so exactly one page does it. The outbox still fills from
  the background; it is written out when a page is open.

### 8.3 Reconnect (R3.12)
When the folder permission is missing (after a browser restart), the top bar shows one message: **"Click
to reconnect to the team folder"** — the existing top-bar message slot, not a pop-up. One click grants it;
the outbox is written out and colleagues' changes are read in.

### 8.4 Not in sync (R3.8)
If the folder is unreachable, or no colleague's new file has been read for 10 minutes while their
heartbeats said they were active, SalesTeam shows **"Not in sync — showing team data from 09:41"** and
blocks edits to shared entities. Personal work (drafts, settings that are personal) continues.
*As built in step 3 (2.8): judged from this PC's folder rounds only; colleagues' silence is shown as "last seen".*

---

## 9. Starting and joining a team (R3.9, R6.7)

### 9.1 Create (the future admin)
1. Settings > Team > **Create a team**. Numbered instructions: create a folder in OneDrive, share it with
   the team ("Can edit"), make sure it is "Always keep on this device".
2. Pick the folder (must be empty). SalesTeam takes a **full backup first** (existing backup code).
3. It writes `team.json`, the creator's member folder and `base/base-<time>.json` (all shared keys as they
   are), and marks the creator as admin.

### 9.2 Join
1. Settings > Team > **Join a team**: same instructions (accept the share, "Add shortcut to My files",
   "Always keep on this device"), then pick the folder (must contain `team.json`).
2. Full backup of the member's own data first.
3. SalesTeam reads base + all change files and builds the team picture.
4. **Overlap check (R6.7):** accounts the member holds that the team does not are offered for adding (the
   member ticks which); accounts both hold where the member has worked (status, contacts touched) are
   written as **join proposals** — the Team Admin sees them in Decisions and decides who keeps each one,
   with the proposed owner preselected.
5. The member's shared keys are replaced by the team picture; personal keys stay as they are.

### 9.3 Leave
Settings > Team > **Leave**: the local copy stays as a solo copy; SalesTeam stops syncing. The member's
files stay in the folder for the record (the admin can remove the member).

---

## 10. What the user sees (summary)

- **Top bar:** team state — "Team: 3 online" / "Click to reconnect to the team folder" / "Not in sync —
  showing team data from 09:41" (one place, strong, per the messaging rule).
- **Settings > Team:** folder, members (name, last seen, admin), create / join / leave, admin actions.
- **Accounts and contacts:** Assigned / Updating badges, Assign to me / Release, Mine / Others /
  Unassigned / All filter, "Last changed by".
- **Notices:** lost claim ("Ben started a few seconds before you"), flagged duplicates on scan / add.
- **Decisions:** join proposals for the admin.
- **LinkedIn:** the assignment badge on company and profile pages.
- **Help, privacy policy, store listing, website:** a team paragraph — data in the team's own OneDrive,
  visible to every team member; no SalesTeam server (messaging rules apply: no ToS claims).

---

## 11. Build steps

| Step | Content | Build |
|---|---|---|
| 0 | **Two-PC test** (no product code): sync delay over a day, simultaneous claims, no conflict copies, folder handle in the background worker, permission after restart | 1.2.1.2 (test page `zz_team_spike.html` + background probe) |
| 1 | `team-merge.js` (pure): stamps, change records, merge rules, claims, confirmation, rendezvous shares — with tests in `test_pure_modules.py` | 1.2.1.3 |
| 2 | `team-folder.js` + `team-sync.js`: folder adapter, outbox, shadow, local→team and team→local, heartbeat, compaction; `team-keys.js`; measure comparison cost | 1.2.1.4 (message-routing fix: 1.2.1.5) |
| 3 | Create / join / leave, Settings > Team, backups, top-bar states, reconnect, not-in-sync (as built: 2.8) | 1.2.1.6 |
| 4 | Claims in the UI and the pipeline (claim, confirm, held edits, lost-claim notice, shares) (as built: 2.9) | 1.2.1.7 |
| 5a | Assign to me / release, admin reassign / release all, badges, Mine / Others / Unassigned / All filter, off-limits checks on list row actions, bulk edit and bulk research, setup read-only for members (D3) (as built: 2.10) | 1.2.1.8 |
| 5b | Team-wide check on scan / discovery / import, do-not-contact as team data (members add, admin removes), outreach check on the Leads Dashboard; **Remove admin-only** + Removed accounts view with bulk restore (Boaz 2026-10-05, see below) | 1.2.1.9 |
| 6 | Join proposals in Decisions, LinkedIn badge, team log in Activity Log | 1.2.1.10 |
| 7 | Help, privacy, listing, website, release notes, PRD; test with the real team → **1.2.2** | 1.2.2 |

Each step is tested by Reload on the live install and on a second PC sharing the folder.

---

## 12. Decisions (all agreed 2026-10-03, as proposed)

- **D1 — Step 0 hardware.** *Answered 2026-10-03: one laptop with two Chrome profiles now (done); the
  OneDrive delay between two PCs is tested at the end, with Boaz's wife.* Original question: The test needs two PCs on one OneDrive folder. The simplest: two PCs of yours,
  both signed in to **your** OneDrive (same account, so no sharing is needed for the test — each PC's
  SalesTeam is a separate member). Do you have two? Otherwise your PC + your wife's with a shared folder
  (needs a personal Microsoft account on her side; see the note in the chat on sharing).
- **D2 — Scanner settings (topics, timeframe, author titles, job search): personal or team?** Proposal:
  **personal** for 1.2.2 — each member scans their own LinkedIn feed with their own focus; the leads found
  are shared either way.
- **D3 — Who may change the shared seller setup and rules** (offers, ideal customer, exclusions, targets,
  prioritisation)? Proposal: **Team Admin only**; members see them read-only, and can add to do-not-contact.
- **D4 — Message templates: shared (team voice) or personal?** Proposal: **shared**, with the member's own
  name and signature filled in from their personal profile.
- **D5 — Timings:** edit claim expires after 5 min idle; "not in sync" after 10 min without colleagues'
  news; reading every 15 s. Agree as starting values, to be tuned after step 0?
- **D6 — A person on two PCs** counts as two members with the same name (simplest, safe). Agree?
