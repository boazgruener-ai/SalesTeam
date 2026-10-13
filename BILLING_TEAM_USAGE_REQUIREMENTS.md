# SalesTeam — Billing: Team usage table: Requirements

Target release: **1.2.4**, one store release together with Notes, the Edge wording and the fixes of 1.2.3.1–1.2.3.9, submitted to the Chrome Web Store and the Edge Add-ons store (Boaz, 2026-10-13). Test builds 1.2.3.18, 1.2.3.19 …
Status: **Requirements — agreed 2026-10-13** (all questions in section 6 answered). Design follows separately.
Date: 2026-10-13

---

## 1. Why this exists

Every member of a team works with their own Anthropic API key, and SalesTeam Settings → Billing shows each
member what their own AI features and web research have cost. Nobody sees the whole picture: the Team Lead
cannot tell what the team spends in a month, or that one colleague's web research costs ten times as much
as everyone else's.

The Team usage table gives the Team Lead (and the deputy) that picture: one line per member with the
month's estimated cost, and a team total.

A second problem showed up on 2026-10-13: a test browser showed US$98.51 of usage that was never spent
there. The figures had arrived with a restored backup. The Billing page must say clearly whose usage it
shows, and must not show another PC's figures as its own.

---

## 2. How it works today (the starting point)

- SalesTeam counts every AI call it makes: tokens, web searches and an **estimated** cost in US dollars,
  per day, split into "Web research" and "Other AI features", and per feature. The count is kept for 400 days.
- The count is kept **in the browser** where the calls were made. It is not shared with the team, and
  neither is the API key.
- Settings → Billing shows: Today / This month so far / All time, day by day (last 31 days), by feature,
  the warning limit before an expensive action, and "Reset the counters…".
- The count **is part of a full backup**. Restoring a backup in another browser brings the first browser's
  figures along.
- A team has one Team Lead and, optionally, a deputy. The Team Lead sees the members in
  SalesTeam Settings → Team, but nothing about their usage.

---

## 3. Requirements

### R1 — Who sees what (decided by Boaz, 2026-10-13)

1. A **member** sees only their own usage. Members never see each other's costs — not in a table, not in
   the team log, not in an export.
2. The **Team Lead** and the **deputy** also see the Team usage table.
3. When the Team Lead role is handed over or taken over, the new Team Lead sees the table from then on and
   the former one no longer does. The same holds for the deputy.
4. Without a team there is no Team usage table and the page stays as it is today (apart from R2).

### R2 — The member's own usage: clearer wording

1. The page says whose usage it is: "What SalesTeam has used **on your Anthropic API key in this browser**."
2. In a team, one more sentence tells every member what is shared: "Your Team Lead sees your monthly
   total and your number of web researches. Nothing else is shared."
3. The tables of the member's own usage (totals, day by day, by feature) and the warning limit stay as they are.

### R3 — What each member's browser shares with the team

1. Per calendar month, three figures only: the **estimated cost in US$**, the **number of web researches**,
   and the **date the figures were last updated**.
2. Never shared: the API key, the days, the features, the tokens, which accounts were researched.
3. The figures are shared through the team folder, like everything else the team shares, and kept up to
   date by SalesTeam itself. The member presses no button.
4. Sharing starts with the month in which the member joined the team. Usage from before joining is not shared.
5. A member who works in the team from more than one browser is shown as **one line**, with the figures added up.

### R4 — The Team usage table

1. Place: SalesTeam Settings → Billing, a section "Team usage" below the member's own totals. Only the
   Team Lead and the deputy have this section.
2. One line per member, the Team Lead and the deputy included. Columns:

   | Column | Meaning |
   |---|---|
   | Member | The member's name |
   | This month (US$) | Estimated cost this calendar month so far |
   | Last month (US$) | Estimated cost of the month before |
   | Since joining (US$) | Estimated cost since the member joined the team |
   | Web researches this month | Number of web researches this calendar month |
   | Updated | When this member's figures last arrived |

3. A **Team total** line at the bottom.
4. Sorted by "This month", highest first. A click on a column heading sorts by that column.
5. A member whose SalesTeam is too old to share figures shows "No figures yet — needs SalesTeam 1.2.4"
   and is left out of the total.
6. A member who has left or was removed stays in the table, marked "(left)", so the month's and the
   year's totals stay right. The line goes at the end of the following calendar year.
7. A line below the table: "Estimates from Anthropic's published prices, counted by each member's
   SalesTeam. Each member's Anthropic Console shows the official figure."
8. The table only shows. It has no actions and no menu.

### R5 — Backup and restore; no reset

1. A full backup keeps the usage count, as today.
2. A restore brings the usage count back **only in the browser the backup was made in**. In any other
   browser the count there stays as it is. The restore summary says so in one line.
3. The **"Reset the counters…" button is removed** (Boaz, 2026-10-13). There is no reset. The count drops
   days older than 400 by itself, as today.

### R6 — Help, PRD, release notes, privacy text

1. Help: a new entry "What the team costs (Team usage)", and a sentence in "Working as a team".
2. A PRD section and the release notes.
3. The privacy text on the website and in the store listing is checked: a member's monthly usage totals
   are now among the data kept in the team folder.

---

## 4. Out of scope

- A budget or a spending limit per member, and warnings to the Team Lead when someone spends a lot.
- Days, features or accounts of a colleague's usage.
- Official figures from Anthropic. SalesTeam shows its own estimate only.
- One shared API key for the team, and charging costs on to anyone.
- An export of the table to a file.
- A chart.

---

## 5. Build outline (for the design)

| Step | What | Test build |
|---|---|---|
| 0 | Each member's browser shares its monthly totals through the team folder; measured with two browsers, including one member in two browsers | 1.2.3.18 |
| 1 | The Team usage table for the Team Lead and the deputy; hand-over; members who left; older versions | 1.2.3.19 |
| 2 | Own-usage wording, the restore rule, the Reset button removed | 1.2.3.20 |
| 3 | Help, PRD, release notes, privacy text check; the 1.2.4 package rebuilt | 1.2.4 |

---

## 6. Questions for Boaz — answered 2026-10-13

| # | Question | Answer |
|---|---|---|
| Q1 | The monthly totals lie in the team folder. SalesTeam shows them only to the Team Lead and the deputy, but a member who opens the folder's files by hand could find them. Is that acceptable, or must the figures be unreadable in the folder? | As recommended (Boaz, 2026-10-13): unreadable to members if the design finds a simple way; otherwise accepted, as the figures are monthly totals only. The design reports back before step 0. |
| Q2 | Share only the usage since the member joined the team (R3.4), or also the months before? | Only since joining (as recommended). |
| Q3 | Is "Last month" wanted as a column, or is "This month" and "Since joining" enough? | Keep it (as recommended). |
| Q4 | Should a member who left stay in the table (R4.6)? For how long? | Yes, until the end of the following calendar year; then the line goes (as recommended). |
| Q5 | Should "Reset the counters…" leave the Team Lead's figures untouched? | **Boaz, 2026-10-13: remove the button. No reset.** See R5.3. |
| Q6 | Is the table shown in every team, or only in advanced mode? | Every team (as recommended). |
| Q7 | Which store release does this ship as? | **Answered by Boaz, 2026-10-13:** in 1.2.4, together with Notes. 1.2.4 is submitted to the Chrome Web Store and the Edge Add-ons store once this table is done. The 1.2.4 package built on 2026-10-13 was never uploaded, so it is rebuilt at the end; the test builds until then are 1.2.3.18, 1.2.3.19 … |
