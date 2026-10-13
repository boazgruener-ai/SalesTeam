# SalesTeam — Billing: Team usage table: Design

Target release: **1.2.4** (test builds 1.2.3.18, 1.2.3.19 …)
Status: **Design — agreed 2026-10-13** (D1–D9; D1, D3 and D6 answered by Boaz, the others as proposed).
Requirements: `BILLING_TEAM_USAGE_REQUIREMENTS.md` (agreed 2026-10-13)

---

## 1. The design in one page

- Each member's SalesTeam writes **one small file of its own** into the team folder:
  `members/<member>/usage.json`, with the member's monthly totals (US$ and number of web researches).
- The file is **not** part of the data every PC syncs. It never reaches a colleague's SalesTeam, a
  colleague's backup or a colleague's export. Only the SalesTeam of the Team Lead and the deputy reads it.
- The totals inside the file are **encrypted for the Team Lead and the deputy** (D1). A member who opens the
  file in OneDrive sees no figures.
- SalesTeam Settings → Billing gets a **Team usage** section, shown only to the Team Lead and the deputy.
  It asks the background for the table when the page opens and once a minute while it stays open.
- The member's own page gets the clearer wording, loses the **Reset the counters…** button, and a restore
  no longer brings in another browser's count.
- A person who uses SalesTeam in two browsers (Chrome and Edge) is two members of the team today. In the
  table they are **one line**: members with the same name are added up (D3, R3.5).

---

## 2. What the code review found

### 2.1 The usage count
- `api-usage.js` keeps `apiUsage` in `chrome.storage.local`: per local day, a "Web research" and an
  "Other AI features" bucket (calls, tokens, searches, US$) and a per-feature list. Days older than 400 are dropped.
- "Web research" calls are what the member's own page already counts as web researches (account web
  research, the web lane, the LinkedIn profile search on the web). The table uses the same number (D8).
- `apiUsage` is personal (not in `team-keys.js`) and is in the full backup, under "Other data".

### 2.2 The team folder
- Each member has `members/<member>/` with `profile.json`, `heartbeat.json` (rewritten every minute while a
  SalesTeam page is open) and `changes/`. Everything in the folder is plain JSON.
- Shared data travels as change records that **every** PC merges and writes into its own storage. Usage
  totals sent that way would sit on every colleague's PC and in every colleague's backup. So they must not
  go that way (D2).
- Precedent (team advanced mode, D3 there): hiding accounts outside a member's groups is a view filter, "not
  a secrecy guarantee against a member who opens the folder". Costs are different: R1.1 says members
  **never** see each other's costs, and a cost file is the one file a colleague has a reason to look for.

### 2.3 Who is a member
- A member is one browser that joined: `joinTeam` makes a random member id, and an invitation can be used
  once. The same person in Chrome and in Edge is two members with two invitations. There is nothing in the
  data that says they are the same person except the **name**, which the Team Lead writes into the
  invitation. Each browser has to stay its own member for sharing (its own copy of the data, its own
  change files); making them one user everywhere - one line in Settings → Team, the same assigned accounts
  in both browsers - needs a sign-in and is the roadmap item "Microsoft sign-in". The table does not need
  to wait for that (D3).
- The Team Lead and the deputy are worked out from the team's records (`leadChain`), and every page already
  knows "I have the Team Lead's rights" from the team summary.
- A member who left or was removed is known (`left`, `removed`, with the date). Their files stay in the folder.

### 2.4 Backup and restore
- A backup is a snapshot of storage minus a short exclusion list; a restore writes the ticked categories
  back. Nothing says which browser a backup came from. That is how US$98.51 reached the Edge test browser.

### 2.5 Reset
- `clearApiUsage` is used only by the Reset button. Removing both has one side effect that is wanted: the
  average cost per web research (used for the pipeline's monthly web budget) is no longer thrown away.

---

## 3. Data

### 3.1 The member's monthly record — `teamUsageMonths` (personal, new)

```
{ teamId, joinedDay: "2026-10-13",
  months: { "2026-10": { usd: 4.21, researches: 31 }, "2026-11": { … } } }
```

- Worked out from `apiUsage`: the days from the join day on (D5), added up per calendar month.
- **A month's figures are never lowered** (D4): the record keeps the higher of what it holds and what the
  days add up to. So "Since joining" stays right after day 400, when old days are dropped.
- Personal: not shared, not in a backup, removed when the browser leaves the team or the team is closed.

### 3.2 The file in the team folder — `members/<member>/usage.json`

```
{ member, updated: "2026-10-13T18:02:11Z", v: 1,
  sealed: { iv, data, keys: { "<Team Lead id>": "…", "<deputy id>": "…" } } }
```

- `sealed` holds `{ months }` from 3.1, encrypted (section 4).
- Written by the member's own background worker in the folder round, after the heartbeat, when the months
  changed, when the Team Lead or the deputy changed, or when one of their keys changed. Written once right
  after joining too, so a member who has not used AI yet shows US$0.00 and not "No figures yet".
- A member whose SalesTeam is older than 1.2.4 has no such file: "No figures yet — needs SalesTeam 1.2.4" (R4.5).

### 3.3 The Team Lead's copy — `teamUsageTable` (personal, new)

```
{ teamId, readAt, members: { "<id>": { months, updated } } }
```

- What the Team Lead's (or deputy's) SalesTeam last read and opened. The table is drawn from it at once and
  refreshed from the folder.
- It also keeps the figures of members who left (their file is never rewritten).
- Personal, not in a backup. Removed as soon as this browser no longer has the Team Lead's rights, leaves
  the team, or the team is closed (R1.3).

### 3.4 A pure module: `team-usage.js`

No `chrome.*`, no DOM, run for real by `test_pure_modules.py`:

- `monthsFromDays(days, joinedDay)` — the monthly totals.
- `mergeMonths(kept, fresh)` — never lower.
- `usageTable(members, copies, today)` — the lines (one per name, D3), the Team total, "(left)", the line that goes at the end
  of the following calendar year (Q4), "No figures yet", and the sort order.

The encryption sits in its own small file (`team-usage-seal.js`, Web Crypto); the team harness
(`test_team_sync.py`) stubs it, as it stubs the folder.

---

## 4. Keeping the figures from colleagues (D1)

- Every member's SalesTeam makes a key pair once, when it joins (or on the first run of 1.2.4): the private
  key stays in that browser and cannot be exported; the public key is written to
  `members/<member>/usage-key.json`. So when someone becomes Team Lead or deputy, their key is already there.
- A member's totals are encrypted once with a fresh content key (AES-GCM), and that key is wrapped for the
  Team Lead and for the deputy with their public keys (RSA-OAEP). Standard browser cryptography, no library.
- **It heals itself.** A member always writes the whole of its months, so when the Team Lead changes, or the
  Team Lead reinstalls SalesTeam and gets a new key, each member's file is rewritten for the new key within
  a minute of that member's SalesTeam being open.
- **What it does not do:** it is protection against a colleague who opens the file, not against one who
  attacks. The folder is writable by every member, so a member could replace the Team Lead's public key file
  with their own. The PRD and Help say "encrypted for the Team Lead and the deputy", not "secure".
- **One gap:** the file of a member who has **left** is never rewritten. A new Team Lead who was not deputy
  before cannot open it; that line shows "Figures not available". The deputy can always open it, so a
  hand-over to the deputy loses nothing (D9).

If D1 is declined, `sealed` becomes plain `months` and everything else in this design stays the same.

---

## 5. The Team usage table (R4)

- A section **Team usage** in SalesTeam Settings → Billing, below the totals of the member's own usage and
  above "Day by day". Present only when this browser has the Team Lead's rights.
- When the Billing page opens it asks the background worker for the table (one message). The worker reads
  `usage.json` of every member, opens those it can, stores `teamUsageTable`, and answers. Repeated once a
  minute while the page is open (D7). Nothing is read while the page is closed.
- **One line per person (D3):** members with the same name (capitals and spaces ignored) are one line, with
  their figures added up and "(2 browsers)" after the name. "Updated" is the latest of them; the line is
  "(left)" only when all of them have left.
- Columns as R4.2: Member · This month (US$) · Last month (US$) · Since joining (US$) · Web researches this
  month · Updated. The Team Lead's own line comes from their own record, not from the folder.
- Team total at the bottom; sorted by "This month", highest first; a click on a heading sorts by it (the
  small sort helper of the Activity Log is reused).
- While the folder is not connected: the last copy is shown with "Team folder not connected — figures as of
  <time>".
- The line below the table as R4.7. No actions, no menu.

---

## 6. The member's own page (R2, R5.3)

- First paragraph: "What SalesTeam's AI features have used **on your Anthropic API key in this browser**: …"
  (rest as today).
- In a team, for a member: "Your Team Lead sees your monthly total and your number of web researches.
  Nothing else is shared." For the Team Lead and the deputy the sentence is left out; they see the table.
- The **Reset the counters…** button, its confirmation and `clearApiUsage` are removed. The Help entry and
  the PRD lose their mention of it.

---

## 7. Backup and restore (R5.1, R5.2)

- Each browser gets a random **install id** once (`installId`, personal, never restored).
- A backup writes the install id into its `manifest.json`. The usage count moves out of "Other data" into
  its own category, "Usage and cost count".
- On restore: the same install id → the category is offered and ticked, as the others. Another install id,
  or a backup from before 1.2.4 (no id) → the category is **not offered**, and the summary says: "The usage
  and cost count was not restored — this backup is from another browser."
- Consequence (D6): after SalesTeam is removed and installed again, the browser is a new one, and the count
  is not restored. In a team nothing is lost for the Team Lead: they keep their copy of the months already read.

---

## 8. Build steps

| Step | What | Test build |
|---|---|---|
| 0 | `team-usage.js` and its tests; the monthly record; key pair; `usage.json` written and rewritten; a check line on the developer page. Measured with two browsers | 1.2.3.18 |
| 1 | The Team usage table; hand-over to the deputy and to a member; a member who left; a colleague still on 1.2.3 | 1.2.3.19 |
| 2 | Own-page wording; Reset removed; install id and the restore rule | 1.2.3.20 |
| 3 | Help, PRD 6.28, release notes, privacy text on the website and in the listing; the 1.2.4 package rebuilt | 1.2.4 |

Also in step 3: the Edge package and the Edge listing text, so 1.2.4 can go to both stores.

---

## 9. Decisions — agreed 2026-10-13

| # | Decision | Proposal |
|---|---|---|
| D1 | Encrypt the totals in the team folder for the Team Lead and the deputy (section 4)? This is the answer to Q1. | **Yes.** It is contained (one small file, standard browser cryptography) and heals itself. It is what makes "members never see each other's costs" true for someone who opens the folder. Its limit and its one gap are stated in section 4. |
| D2 | The totals travel in a file of their own, not with the shared data. | Yes. Otherwise they would sit on every colleague's PC and in their backups. |
| D3 | A person in two browsers is one line in the table (R3.5, Boaz 2026-10-13): members with the same name are added up and marked "(2 browsers)". One user everywhere in SalesTeam comes with the sign-in item. | Yes. The Team Lead writes the name into the invitation, so the same name is the Team Lead's own statement that it is the same person. |
| D4 | A month's shared figures are never lowered. | Yes. Keeps "Since joining" right after 400 days. |
| D5 | "Since joining" counts from the day of joining, not from the first of that month. | Yes (R3.4: nothing from before joining). |
| D6 | The restore rule is strict: another browser, a reinstalled SalesTeam, or a backup from before 1.2.4 → the count is not restored. | Yes. Any softer rule lets foreign figures in again, and in a team they would reach the Team Lead. |
| D7 | The table is read when the Billing page opens and once a minute while it is open. | Yes. No folder traffic for a page nobody is looking at. |
| D8 | "Web researches" is the number of Web research calls the member's own page shows. | Yes. One number, the same in both places. |
| D9 | After a hand-over to someone who was not deputy, members who had already left show "Figures not available". | Accept. It only arises with D1, and a hand-over to the deputy avoids it. |
