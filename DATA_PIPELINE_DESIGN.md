# SalesTeam — Data Pipeline & Readiness: Design

Target release: **1.2.0**
Status: **Design — decisions D1–D6 agreed 2026-09-24** (section 12). Implementation starts with build step 0.
Date: 2026-09-24
Builds on: `DATA_PIPELINE_REQUIREMENTS.md` (agreed 2026-09-24). Requirement numbers (R3.3, R12.2.5…)
refer to that document.

---

## 1. The design in one page

The requirements describe **what** has to happen. This document decides **where each part runs, what
it stores and in what order it is built.**

1. **One definition of readiness, in one pure module.** `readiness.js` takes one account and the
   user's targeting settings and returns its state (Ready / Usable / In progress / Needs your decision
   / Lacking evidence), the fields still missing, and whether the Scanner can see it. The pie, the
   scheduler, the Scanner's account selection and the "at least 5 Ready" gate all call this one
   function. That is how R3.4 is enforced in code rather than by discipline.
2. **The queue is derived, not stored.** Nothing persists a list of "jobs to do". What persists is
   each account's facts: field values, where each came from, and what was attempted when. The next
   piece of work is always computed fresh from those facts. So the pipeline resumes after a crash, a
   restart or a week away with no extra machinery. A stored queue could go stale, and this one
   cannot.
3. **The scheduler runs in the background worker, not in a page.** Today the three LinkedIn jobs
   (resolve, size, contacts) run inside the Target Accounts page and stop when it closes. Their code
   uses only `chrome.tabs`, so it moves to the background unchanged. The scan and bulk web research
   already run there.
4. **Depth-first, one account at a time.** Pick the best account that is not Ready yet. Run every
   job it still needs in dependency order, re-score it, recompute its readiness, then pick again. The
   first Ready accounts therefore appear within the first hour (R12.3.3).
5. **The pipeline stops at 75 touches in the rolling 24 hours.** It leaves the band from 75 to 99 for
   the Scanner. The LinkedIn budget is a rolling 24-hour window, not a calendar day (section 2.3), so
   "today's plan" means "until the window reaches 75".
6. **One warmed LinkedIn tab per session, and one visit per company page.** Today every job run spends
   a touch warming up on the feed, and the resolver and size fetch load the same company page
   separately. Sharing the tab and the page visit cuts the cost per account by about a fifth (section
   9).
7. **Built in six steps, each shippable on its own.** Step 1 is read-only: it computes readiness and
   draws the pie, with no automation yet. It already shows the user the truth about the data, and it
   tests the definition on real accounts before anything acts on it (section 11).

**The one real risk:** the LinkedIn jobs keep their tab in front, because Chrome slows down background
tabs and lookups then time out. Run automatically as they are built today, they would take over the
browser while the user is working. Section 8 proposes a dedicated SalesTeam window and a test to prove
it before anything else is built. **This is decision D1.**

---

## 2. What the code review found

These findings come from reading the code the requirements rely on. Each one shapes the design.

### 2.1 The LinkedIn jobs live in a page

`runCompanyIdResolution`, `runCompanySizeFetch` and `runContactDiscoveryForExistingCompanies` are
imported and started only by `target-accounts.js`. Close the tab and the job dies. A scheduler that
runs "by itself" (R12.2.2) cannot depend on a page being open.

**Consequence:** the scheduler lives in `background.js`, as the Scanner and bulk web research already
do. The three runners use only `chrome.tabs` and `chrome.storage`, with no DOM, so they can be
imported there as they are. The page keeps its buttons (support tier, R6.2.3). Those buttons send a
message to the background instead of running the job themselves.

### 2.2 The LinkedIn tab is kept in front on purpose

All three runners open their tab with `active: true` and set it active again on every navigation.
The comment in `company-resolve-extraction.js` explains why: in a background tab Chrome slows the
content script down, and lookups timed out. That is fine for a job the user just clicked and is
watching. **It is not acceptable for a job that starts by itself while the user is writing an
email.** See section 8.

### 2.3 The touch budget is a rolling 24 hours, not a day

`getLinkedinTouchStats()` counts touches in the last 24 hours. It keeps that window on purpose: a
burst on either side of midnight is still caught. So "plan the day's work" (R12.2.2) cannot mean
"spend 75 today". It means **work while the rolling count is below 75**. The existing
`formatTouchRelease()` already says when room frees up, and the progress line reuses it
(section 10.2).

### 2.4 Each account's data lives in three stores

| Store | Holds |
|---|---|
| `targetAccounts` (a map keyed by normalised name, with alias keys) | `linkedinCompanyId`, `linkedinLink`, resolve attempts |
| `targetAccountsWorkbook.companies[]` / `.contacts[]` | the imported rows, `salesTeamPriority`, sizes from LinkedIn |
| `targetAccountExtras[key]` | `overrides` (web research, manual edits), `deletedAt`, attempt timestamps |

Every selector today does its own join of these three stores, and they have drifted apart (2.5).
**Readiness needs one join, done once:** `getAccountViews()` returns one merged object per account
(primary key only, overrides applied, deleted and excluded accounts removed, contacts attached). Every
pipeline component reads accounts only through it.

### 2.5 Three defects the readiness work would otherwise inherit

1. **`getCompaniesNeedingSize()` treats "6,500+" as missing.** It tests `typeof … !== "number"`. This
   is the same bug class fixed in `computeCompanyDeterministicPreScore` on 2026-09-22, still alive in
   a second caller. EPFL would be queued for a LinkedIn visit it does not need, every run. Fix: use
   `parseLooseNumber`.
2. **Scan scope "all" skips the deleted and excluded filter.** `getScanTargetCompanyIds("all")`
   returns every account with an id, including soft-deleted ones. The P1–P3 scopes filter correctly.
   The fix comes for free once the function is rebuilt on `readiness.isScannable` (section 3.4).
3. **Priorities are never re-scored as data arrives.** `autoPrioritizeNewCompanies` scores only
   accounts with no priority yet (`rescoreAll: false`). An account scored P4 before its contacts were
   found stays P4 after they arrive, and may stay outside the Scanner's P2 scope for good. R6.4.2
   requires the opposite. Fix: section 5.3.

### 2.6 Where a value came from is not recorded per field

Web research and manual edits both write plain values into `extras[key].overrides`. The sources of
a web research are kept per **account** (`extras[key].webResearch.sources`), not per field. So today
nothing can tell "headcount from LinkedIn" apart from "headcount typed in by hand" or "headcount from
an uncited web answer". R5.1 requires exactly that distinction. Section 4 adds it.

---

## 3. Readiness

### 3.1 The module

`code/readiness.js`, **pure**: no `chrome.*`, no DOM, no imports from `storage.js`. It is covered by
`test_pure_modules.py` like `value-normalize.js`, so the definition the whole product rests on is
executed and asserted on, not just read.

```js
assessAccount(view, cfg, now) -> {
  state,        // "ready" | "usable" | "in_progress" | "needs_decision" | "lacking_evidence"
  scannable,    // boolean: has a LinkedIn id and a P1-P5 priority, not deleted or excluded
  missing,      // [{ field, reason: "absent" | "unverified" | "expired" }]
  nextJobs,     // job ids that would close a gap, in dependency order (section 5)
}
isScannable(view, scope)   // the Scanner's selection, the same test as `scannable`, plus the scope
requiredFields(cfg)        // R3.5: which fields this user's targeting actually depends on
```

`cfg` is built once from the Setup wizard: `targetUniverseConfig` (location priorities, size
buckets, industries) and the target contact profile's `seniorityLevels`.

### 3.2 The rules

**Which fields are required depends on the user's settings (R3.5).**

| Field | Required when | Verified when (R5.2) |
|---|---|---|
| `linkedinCompanyId` | always | from LinkedIn, less than 12 months old |
| `salesTeamPriority` | always | present (priority is computed, so there is nothing to verify) |
| `globalHqCountry` | `locationPriorities` has an entry other than "medium" | good source, less than 12 months old¹ |
| `globalEmployees` | a size bucket has a priority other than "medium" | good source, less than 6 months old |
| `industry` | `industries` holds an entry with a priority other than "medium" | good source, less than 12 months old¹ |
| A relevant contact | always (R3.6) | at least 1 contact at a wizard seniority level (`classifyJobTitleSeniority` returns one), with a LinkedIn profile, less than 6 months old |

¹ The requirements set no freshness window for country or industry, because both rarely change.
12 months is proposed here, the same as company identity.

"Good source" means one of the three sources R5.2 accepts: LinkedIn, web research with a cited
source, or the workbook with the account's Evidence Status at Sufficient or better.

**"Other than medium"** is the exact test `computeCompanyDeterministicPreScore` uses. A priority of 2
(medium) adds nothing to the score, so it cannot change any decision, so it must not hold an account
back. Reusing the scoring function's own test keeps the two from drifting apart.

**The states, checked in this order:**

1. **Needs your decision:** an open item in the decision queue concerns this account (section 7).
2. **Lacking evidence:** R12.5 is met (section 5.5), and the user has not chosen Keep.
3. **Ready:** scannable, and every required field is present and verified.
4. **Usable:** scannable, with something still missing or unverified.
5. **In progress:** not scannable, and the pipeline still has a job it can try.

An account that is not scannable and has nothing left to try is, by construction, Lacking evidence.
So In progress can never be a dead end.

### 3.3 Where "verified" gets its date

| Source | Verified-at date |
|---|---|
| LinkedIn resolver, size fetch, contact discovery | the date of the visit |
| Web research with at least one cited source | `webResearch.at` |
| Workbook with Evidence Status at Sufficient or better | the company's `Last_Verified` column; if empty, the import date (**D6**) |
| Manual edit in SalesTeam | the date of the edit (**D2**: does a manual edit count as verified?) |

### 3.4 One definition, used everywhere (R3.4)

- `getScanTargetCompanyIds(scope)` is rebuilt as `getAccountViews()` → `isScannable(view, scope)`.
  It stays the single function `background.js` and `scanner.js` both call, so the scan and its
  "Total: N searches" hint still cannot disagree. Defect 2.5.2 disappears with the rewrite.
- The pie, the scheduler and the Scanner gate all call `assessAccount`.
- A test in `test_pure_modules.py` asserts, for a fixture set of accounts, that every account
  `assessAccount` calls Ready or Usable is one `isScannable(view, "all")` accepts. Nothing other than
  review would catch a drift between the two, so it gets a test.

### 3.5 Caching

Assessing 544 accounts is a few milliseconds of pure JavaScript, so there is no cached state to go
stale. The pie recomputes it on every `chrome.storage.onChanged` for the three stores (R12.1.4), and
the scheduler recomputes it before each pick. Throttle the redraws to one per 500 ms, because an
import writes many times in a row.

---

## 4. Provenance

### 4.1 Schema

It is added to `targetAccountExtras`, next to `overrides`, because extras is already the per-account
store every writer can reach:

```js
extras[key].provenance = {
  linkedinCompanyId: { src: "linkedin", at: 1758700000000 },
  globalEmployees:   { src: "web", at: 1758600000000, cited: true },
  globalHqCountry:   { src: "workbook", at: 1756000000000, evidence: "Rich Evidence" },
  industry:          { src: "user", at: 1758710000000 },
}
```

`src` is one of `linkedin | web | workbook | user | discovery`. `discovery` is LinkedIn Discovery,
which counts as LinkedIn. Contacts keep their existing `lastVerified` / `lastVerified2` pair, so no
new contact schema is needed. A contact counts as verified when it has a LinkedIn profile URL and
either date is within 6 months.

### 4.2 Who writes it

Every function that writes one of the tracked fields also writes that field's provenance, **in the
same `chrome.storage.local.set`**. Values and provenance can then never disagree after a crash.
The writers:
`applyResolvedCompanyIds`, `applyCompanySizeResults`, the web-research apply path
(`web-research-apply.js` → `saveTargetAccountExtra`), the workbook import, the Discovery merge,
`mergeTargetAccounts`, and the Accounts table's inline edit.

### 4.3 Existing data: derived once, on first run (R12.8.1)

No separate migration step. The first time 1.2.0 assesses an account with no `provenance` entry, it
derives one from what is already stored and writes it:

| Field present, and… | Derived provenance |
|---|---|
| `linkedinCompanyId` | `linkedin`, at `linkedinResolveAttemptedAt`, otherwise the import date |
| `globalEmployees` on the row with `employeeCountText` (from Fetch Company Size) | `linkedin`, at `sizeFetchAttemptedAt` |
| a value in `overrides`, and `webResearch.sources` is not empty | `web`, cited, at `webResearch.at` |
| a value in `overrides`, and no web research | `user`, at the import date |
| a value on the imported row | `workbook`, with the row's Evidence Status and `Last_Verified` |

Deriving it once and then writing it matters: from then on the account has real provenance, and the
guessing rules above never run for it again.

---

## 5. Jobs and the scheduler

### 5.1 Jobs become descriptors (R6.1)

`code/pipeline-jobs.js` describes each job. Every runner stays in its current file, unchanged except
for a new entry point that runs one account at a time.

```js
{
  id: "resolve",
  label: "Link to LinkedIn",
  tier: "linkedin",               // "silent" | "linkedin" | "web"
  touches: (view) => view.linkedinLink ? 1 : 1.3,   // an estimate, used for planning and messages only
  needs:   (view, a) => a.missing.some((m) => m.field === "linkedinCompanyId"),
  after:   [],                    // dependencies, by job id
  runOne:  (ctx, view) => ...,    // calls the existing runner with a one-account list
}
```

| Job | Tier | After | Existing code it wraps |
|---|---|---|---|
| `merge-discovery` | silent | — | `mergeDiscoveredIntoWorkbook` (name-only matches go to the decision queue, R12.6.3) |
| `normalize` | silent | — | `value-normalize.js` |
| `dedupe-safe` | silent | — | `mergeTargetAccounts`, only for pairs with the same LinkedIn id; the rest go to the decision queue |
| `resolve` | linkedin | — | `runCompanyIdResolution` |
| `size` | linkedin | `resolve` | `runCompanySizeFetch` (free when `resolve` just loaded the same company page, see 9.2) |
| `contacts` | linkedin | `resolve` | `runContactDiscoveryForExistingCompanies` |
| `web` | web | — | `researchAccountOnWeb` via `bulk-research.js` |
| `arbitrate` | silent | `web` | `web-findings-arbitration.js` |
| `score` | silent | all of the above | `prioritizeCompanies(…, { useAI: false })` for this one account |

`after` is used to compute the order (R6.1.2). A job whose `needs` is false does not run and is not
mentioned (R6.1.3).

### 5.2 The loop

```
onTrigger():                                          # section 5.4
  if !consent.linkedin: return                        # R12.8.3: 1.1.x behaviour until consent
  runSilentPass(all accounts)                         # merge, normalize, dedupe-safe, score: free and local
  while true:
    if pauseRequested or stopRequested: break         # a user scan, or the Stop button
    if touches24h >= PIPELINE_TOUCH_CEILING (75): break
    account = pickNext()                              # 5.3
    if !account: break                                # nothing left: "All accounts processed"
    withBatch("SalesTeam is preparing accounts", () => runAccount(account))
  closeWorkerTab()

runAccount(a):
  for job in orderedJobs where job.needs(a):
    if job.tier == "linkedin" and touches24h + job.touches(a) > 75: return
    if job.tier == "web" and !webBudgetLeft(): continue          # R12.7.3
    result = job.runOne(ctx, a)                                  # writes values + provenance
    recordAttempt(a, job, result)                                # 5.5
    a = reassess(a)
  score(a); logBatch(a)                                          # R8.1, R8.2
```

**The batch lock is taken per account, not for the whole day.** Between two accounts it is free. A
user who starts a scan therefore waits at most for the account in progress, usually under a minute,
and never gets the "one batch at a time" refusal because of the pipeline (Q5 in the requirements).
The scan button sets `pipelinePauseRequested`. The loop sees it at the next account boundary and
stops. When the scan releases the lock, the pipeline resumes by itself (5.4).

### 5.3 Picking the next account (R6.4.1, R6.4.2)

```
candidates = accounts where state is "in_progress" or "usable" and a job with needs() == true can run
sort by:
  1. provisional priority, P1 first (an unscored account counts as P3)
  2. fewest estimated touches to Ready: finish what is almost finished
  3. never attempted before attempted, oldest attempt first (today's ordering rule)
```

**Provisional priority** is the deterministic score computed from whatever is present, as today.
After each account the scheduler re-scores that account (`score` job). This is the fix for defect
2.5.3. Because the candidate list is recomputed at every pick, an account whose score jumped after its
contacts were found moves up at once, with no special re-ordering step.

Re-scoring is limited to accounts whose score is **derived**. Scenario 2 accounts (imported with
confident AI evidence, `hasSufficientImportEvidence`) keep their imported score, as today. A manual
priority override (`extras.overrides.salesTeamPriority`) is never touched.

### 5.4 Triggers: when the loop starts

No `chrome.alarms`. The decision was to start on the first Chrome launch of the day, not at midnight
(R12.2.4).

| Trigger | Where it comes from |
|---|---|
| Chrome starts | `chrome.runtime.onStartup` in `background.js` |
| A SalesTeam page opens, or is open every 10 minutes | the page sends `PIPELINE_KICK`, the same pattern as `runAutoBackupIfDue` |
| An import finishes (workbook, HubSpot) | the import sends `PIPELINE_KICK` |
| A Discovery run finishes | `completeDiscoveryQueue` → merge (R12.6.1) → kick |
| A user scan finishes | the scan's release → kick (resumes after the pause) |
| Targeting settings change | Setup wizard save → re-score everything (silent) → kick |

A kick while the loop is already running does nothing. The loop re-reads the accounts before each
pick, so it will see the new data anyway.

**What happens after the budget is spent:** the loop stops. Room frees up as old touches leave the
24-hour window. The next kick (a page open, or Chrome's next start) picks the work up. Waking the
extension up with nothing open would need an alarm, which is deliberately not used. In practice
Chrome is open most of the day and SalesTeam pages are open when the user works, so this loses
little.

Before the first account of each day, the loop calls `runAutoBackupIfDue({ force: true })`. The
snapshot before automated changes (R8.4) then comes from the existing backup, with no new code.

### 5.5 Attempts and "Lacking evidence" (R12.5)

```js
extras[key].pipeline = {
  attempts: { resolve: ["2026-09-24", "2026-09-25"], size: ["2026-09-24"] },  // local dates
  emptyPage: "2026-09-24",       // R12.5.3, set by the resolver or size fetch
  lackingSince: "2026-09-25",
  keep: false,                   // the user chose Keep: stop retrying, leave it in the pie
  inputsHash: "…",               // hash of the import row / discovery data at the last attempt
}
```

- A job for a mandatory field that has failed on **2 different days** stops being offered for that
  account. An empty LinkedIn page counts at once.
- When every job that could make the account scannable has stopped, the account is **Lacking
  evidence**. The reason text is built from `missing` plus `attempts`, for example: *"No LinkedIn
  page found. Tried on 24 and 25 September."* (R12.5.5)
- **Retried only when something new arrives (R12.5.2):** if `inputsHash` changes (re-import,
  Discovery merge, manual edit), the attempts are cleared.
- **Recognising an empty page:** the size content script already reads the company page. An
  employee count of 0, or "0-1 employees" with no posts, sets `emptyPage`. The exact test is written
  after looking at the 3–4 real cases (build step 4).

The existing `linkedinResolveAttemptedAt`, `sizeFetchAttemptedAt` and `contactDiscoveryAttemptedAt`
stay, so the support-tier buttons keep their ordering. The pipeline writes both.

---

## 6. Web research in the pipeline (R12.7)

- **Separate consent, separate budget:** `webResearchBudget = { monthlyUsd, spentThisMonth, month }`.
  The existing per-account cost estimate and `api-usage.js` provide the figures. The month rolls over
  on the first run in a new month.
- **When it runs:** inside `runAccount`, for accounts that are scannable and have never been
  researched (or whose research is older than 12 months). It never blocks Ready (R12.7.4). If the
  budget is 0 or used up, the job is skipped and the paused message is shown (R12.7.3).
- **Its results go through the existing arbitration (`arbitrate` job).** Differences that cannot
  change a decision are settled silently. Those that can go to the decision queue (R5.4).
- **D3:** should web research run **before** Fetch Company Size for accounts with no headcount? A
  cited web headcount is verified (R5.2) and saves a LinkedIn touch, which is the scarcer resource.
  It costs US$ instead. Recommendation: yes, when the web budget allows, because touches limit how
  fast accounts become Ready and dollars do not.

---

## 7. The decision queue (R6.3.3, R12.4)

One list, stored as `decisionQueue: [{ id, kind, accountKey, createdAt, payload }]`, shown on one
page with **Next / Skip / Keep** and the kind-specific actions:

| Kind | Created by | Actions |
|---|---|---|
| `name_match` | Discovery merge, a company matched by name only (R12.6.3) | Same company (merge) / Different company (add as new) |
| `duplicate` | `dedupe-safe`, a pair it cannot settle safely | Merge / Keep both |
| `finding` | arbitration, a difference that could change a decision | Keep current / Use web finding |
| `lacking_evidence` | 5.5 | Keep / Remove (soft delete, R12.5.4) |

- **Red dot (R12.4.1):** the menu item that opens the queue shows a dot while the queue is not empty.
  Every page that draws the menu redraws on `chrome.storage.onChanged` for `decisionQueue`.
- Wording follows the house rule: the two sides are "current" and "web finding", never "your".
- The per-account **Review findings…** dialog stays and shows only that account's `finding` items.

---

## 8. The LinkedIn tab without taking over the browser — decision D1

Today's behaviour (a foreground tab, re-activated on every navigation) works only because the user
just clicked the button and expects to watch. The pipeline needs something else. Options, best first:

**A. A dedicated SalesTeam window (recommended).** At the start of a run the pipeline creates one
small, normal (not minimised) window with `focused: false`, holding the single LinkedIn tab. A tab
that is the active tab of its own visible window is not a "background tab" for Chrome's throttling,
yet it does not take the user's tab or focus. It is visible in the browser, which keeps the LinkedIn
posture (N9.3), and the user can glance at it. The window closes when the run ends.
*Risk:* on Windows, Chrome also treats a window that is completely covered by other windows as
hidden, and may slow it down anyway. **Build step 0 is a test that answers this** before anything
is built on top of it.

**B. Run only while the user is away.** `chrome.idle` (the `idle` permission, which shows no install
warning) says when the machine has had no input for N minutes. The pipeline runs then, in a
foreground tab, and pauses as soon as the user is back. It is always reliable, but it finishes much
more slowly and only when the laptop is on and unattended.

**C. Today's foreground tab, run automatically.** Rejected: it would take over the browser while the
user works.

**Recommendation: A, with B as the fallback if the test fails on covered windows.** Either way, the
pipeline **does not keep the computer awake** (`chrome.power.requestKeepAwake`). The user-started
jobs do, because the user is waiting for them. Keeping a laptop awake for work nobody is waiting for
would be a new, unannounced behaviour (**D4**).

**What "awake" means here (clarified 2026-09-24).** It means *not in sleep mode*. The screen saver,
the display turning off and the screen lock are all separate from sleep. The user-started jobs
request `"system"` keep-awake, which stops Windows from sleeping but still lets the display turn off
and the screen lock. The pipeline requests nothing, so:

- **Sleep** (Windows' own power settings): Chrome is frozen, and the pipeline stops mid-account.
  Nothing is lost, because each result is saved as it arrives. It resumes at the next kick after
  wake-up.
- **Screen saver, display off, or screen locked while the machine stays awake:** Chrome keeps
  running, so the pipeline *can* in principle continue. **But** Chrome on Windows treats a locked
  screen or a display that is off like a fully covered window, and may slow its pages down in the
  same way. This is exactly the risk in option A. **So step 0 tests it too.** If lookups time out
  while the screen is locked, the pipeline pauses when `chrome.idle` reports `"locked"` and resumes
  on unlock. That uses the same `idle` permission as fallback B.


### Step 0 result (tested 2026-09-24/25): option A works, no fallback needed

A throwaway harness ran real company-page lookups (the direct-link path, the heaviest page and the
one that caused the old timeouts) from a window created with `focused: false`, never made active,
with no keep-awake. A zero-touch probe page in the same tab recorded how Chrome treated the window.

| Condition | Chrome's view of the window | Lookups | Timeouts | Avg / max result |
|---|---|---|---|---|
| (a) visible | visible, 60 frames/s | 10/10 | 0 | 2.3 s / 3.6 s |
| (b) covered | hidden, 0.1 frames/s, timers held to ~1 s | 10/10 | 0 | 2.0 s / 2.6 s |
| (c) minimised | hidden, same as covered (probe only) | — | — | — |
| (d) screen locked, machine awake | hidden, same as covered | 10/10 | 0 | 2.2 s / 3.1 s |

- **Hidden does not mean broken.** Chrome stops drawing a covered, minimised or locked window and
  slows its timers, but the page still loads and the content script still reads it and reports back
  as fast as when visible. The old background-tab timeouts are not reproduced by a hidden window.
- **The window never took focus** in any round, and does not need to be activated once to work.
- **Consequences for the design:** the fallback (B, run only while the user is away) is not needed,
  and neither is the pause on `chrome.idle` "locked" described above. The `idle` permission is not
  required. The window will usually open behind the user's work, which is expected and harmless.
- **Found in passing, not a window issue:** 6 of the 30 lookups read a different company id from the
  one stored for that account (Octapharma, Comet Holding, Lalique Group, Komax Holding, FMV, BNP
  Paribas Switzerland). Since the Scanner selects accounts by that id, this is a readiness question
  for step 1: a stored id should be re-checked against its own LinkedIn page before it counts as
  verified. Which side is wrong has not been established yet.

---

## 9. Cost: touches per account, measured on real data

### 9.1 The real workbook (`Swiss_AI_Prospects_544_V66_FULL`, counts only)

| | Accounts | Share |
|---|---|---|
| Companies | 544 | |
| with a LinkedIn company link | 519 | 95% |
| with a global employee count | 372 | 68% |
| with Evidence Status at Sufficient or better | 335 | 62% |
| with at least one contact | 496 | 91% |
| with at least one contact **with a LinkedIn profile** | 196 | 36% |

**The contact bar is the largest gap:** 91% of accounts have a contact, but only 36% have one with a
LinkedIn profile. Most accounts will therefore need a People visit, whatever else they have.

### 9.2 Touches per account

| Job | Touches | Notes |
|---|---|---|
| Resolve, with a link | 1 | loads the company page |
| Resolve, name only | about 1.3 | a search page, plus the company page when the search shows no link |
| Size | 1 → **0** | loads **the same company page** the resolver just loaded. Reading the size in that same visit makes it free |
| Contacts | 1 | the company's People page |
| Warm-up | 1 per **run**, not per account | today every job run starts with a feed visit. One shared, warmed tab per session pays it once |

**Averaged over the 544 accounts:** about **2.15 touches per account** with the jobs as built today,
and about **1.7** with the size read during the resolver's own visit.

### 9.3 What that means for the user

| | Jobs as built today | With the shared page visit |
|---|---|---|
| Accounts made Ready per 75 touches | about 35 | about 44 |
| Days to clear 544 accounts | about 16 | about 12 |
| First Ready account | within minutes | within minutes |

These are **upper-bound estimates from the workbook alone.** An existing installation has already
resolved many ids and fetched many sizes, so the real backlog is smaller. On the other hand, the
seniority filter (R3.7) will reject some contacts that exist today, so the real figure is uncertain in
both directions. **The pipeline logs the touches each account actually cost.** After the first week,
the progress line switches from these estimates to the measured average (R12.3.2).

**Worth doing in 1.2.0:** the shared warm tab and the shared company-page visit together cut the time
to clear the backlog by about a quarter, with no change to the LinkedIn posture. Both are local changes to
the runners' entry points.

---

## 10. What the user sees

### 10.1 Setup wizard: the consent (R12.2.1, R12.8.3)

The last step checks readiness to start: target region, sizes and seniority levels set, LinkedIn
signed in. Then it offers:

> **Keep my accounts ready automatically**
> SalesTeam links accounts to LinkedIn, finds their size and their key contacts, within your daily
> LinkedIn limit. You start it once; it carries on each time Chrome is open, in its own small window.
> [Turn on]  [Not now]

Web research is a separate, optional line with a monthly US$ amount (R12.7.1). Existing users see the
same card once after updating, on whichever SalesTeam page they open first. Both switches also live
in **Settings > Automation**, where they can be turned off at any time.

### 10.2 Target Accounts Dashboard: the pie and one line (R12.1)

A new first pie, **Pipeline status**, drawn with the existing `renderGenericPieChart`, which already
takes `onSliceClick`. Clicking a slice filters the accounts table through a new **Readiness** column.
Under it, one line, chosen from:

- *"38 ready · working on Nestlé · about 25 more by the end of the day"*
- *"38 ready · LinkedIn limit for automation reached · resumes around 14:10"* (from `formatTouchRelease`)
- *"Paused while you scan"*
- *"All accounts processed. Your daily LinkedIn limit is now free for scanning."* (R12.2.5)
- *"Web research is paused: this month's budget of US$20 is used up. …"* (R12.7.3)

### 10.3 While it runs

The existing batch banner is designed for a run the user started and is watching. It is sticky and
blue, with a Stop button. The pipeline gets a **quiet status pill** in the page header instead:
*"Preparing accounts · 38 ready"*, with Pause. R7.3 asks for progress that is visible but not
intrusive. The full banner still appears for user-started jobs, as today.

### 10.4 Scanner (R12.3.4–5)

`MIN_READY_TO_SCAN = 5`, one named constant in `readiness.js`. Below it the Scanner explains itself:
*"You have 3 Ready accounts. The Scanner needs at least 5 to start. About 12 more are expected by
the end of the day."* The Scanner's selection itself is unchanged in meaning: it scans scannable
accounts (Ready **and** Usable) in the chosen P-scope, as today. The gate counts only Ready, so the
first scan runs on the accounts that are best prepared.

### 10.5 Menu

**Decisions** is added to the menu, with the red dot. **Review & Merge Discovery Results**, **Resolve
LinkedIn Company IDs**, **Fetch Company Size**, **Discover Contacts for Existing Companies** and **Find
& Merge Duplicates** move to Advanced tools (support tier). They stay fully working. Each one's
confirm text gains a line: *"The automatic pipeline normally does this for you."*

---

## 11. Build order

Each step ships on its own, as a patch release inside the 1.2 line, and makes the next one safer.

| Step | Scope | Visible result | LinkedIn automation? |
|---|---|---|---|
| **0. Worker-window test** | A throwaway harness: run 20 company lookups in an unfocused window while it is (a) visible, (b) covered, (c) minimised, (d) with the screen locked and the machine awake. Count timeouts. | answers D1 | test only |
| **1. Readiness, read-only** | `readiness.js` + tests, `getAccountViews()`, provenance schema + one-time derivation, the three defect fixes (2.5), `getScanTargetCompanyIds` rebuilt on `isScannable`, the pie + Readiness column | the truth about the data, on the dashboard | no |
| **2. Scheduler, manual start** | `pipeline-jobs.js`, the loop in `background.js`, the runners' one-account entry points, the shared warm tab + shared company-page visit, attempts, the status pill. Started from a support-tier **Run pipeline now** button | depth-first runs, measured touches per account | only when clicked |
| **3. Automatic** | consent card + Settings > Automation, the triggers (5.4), pause-for-scan, the daily backup before the first run, the worker window (per D1), the Scanner gate | the product behaviour of R12.2 | yes |
| **4. Decisions** | decision queue page + red dot, automatic Discovery merge with name-only matches queued, `dedupe-safe`, Lacking evidence + empty-page detection, menu moves | the user is involved only where R12.4 says | yes |
| **5. Web research lane** | consent + monthly budget, the `web` + `arbitrate` jobs, the paused message | depth without clicking | yes |
| **6. Public wording** | store listing, website, Help: *"You start it once…"* (R12.2.3); remove the "no chrome.alarms, ever" comment in `discovery-queue.js` and replace it with the actual rule (no alarms; kicks on start and on page open) | honest messaging before 1.2.0 goes to the store | — |

**Steps 0 and 1 carry no risk and settle the two biggest unknowns:** whether the window works, and
whether the Ready definition matches what the user sees as ready on real accounts. Step 1 can ship to
the store on its own.

Per the versioning policy, bumping to 1.2.0 is Boaz's call. This plan assumes the steps are
internal builds, and that 1.2.0 is whichever build he decides to submit.

---

## 12. Decisions — all agreed 2026-09-24

Boaz agreed to every recommendation below. D4 was clarified: see section 8, *What "awake" means here*.

| # | Question | Decision |
|---|---|---|
| **D1** | How does the pipeline visit LinkedIn without taking over the browser? | A dedicated unfocused SalesTeam window, proven by the step 0 test; "only while the user is away" as the fallback (section 8). **Step 0 passed on 2026-09-25**: 30/30 lookups, 0 timeouts, visible, covered and locked; no fallback needed |
| **D2** | Does a value the user typed in count as verified? | **Yes**, dated when it was typed, and it expires like any other. The user is an authoritative source about their own market, and re-fetching a value they just corrected by hand would overwrite their judgement with LinkedIn's |
| **D3** | Web research before Fetch Company Size, when the web budget allows? | **Yes**, because LinkedIn touches are the bottleneck and dollars are not (section 6) |
| **D4** | May the automatic pipeline keep the computer awake? | **No**, only user-started jobs do (section 8) |
| **D5** | Freshness windows for HQ country and industry, which the requirements leave open | **12 months**, the same as company identity (section 3.2) |
| **D6** | A workbook row with Evidence Status at Sufficient or better but an empty `Last_Verified`: from when is it verified? | **From the import date.** That is generous but honest: it is the date SalesTeam first saw it, and the value still expires after its window |

---

## 13. Not in this design

- **Point-in-time restore to any moment (R8.4 in full).** The daily backup taken before the first
  run gives a daily snapshot, which is enough for 1.2.0. Restoring to an arbitrary timestamp comes
  later.
- **Team use** (shared data, claim-to-work). It is parked, and the design does not preclude it:
  per-account state lives in extras, which a shared store would carry as it is.
- **An AI-based priority in the automatic loop.** The loop scores locally (`useAI: false`) and costs
  nothing. AI re-prioritisation stays a user action.
