# SalesTeam — Notes on accounts, contacts and leads: Requirements

Target release: **1.2.4**, one store release together with the Edge wording and the fixes of 1.2.3.1–1.2.3.9 (test builds 1.2.3.10, 1.2.3.11 …)
Status: **Requirements — agreed 2026-10-13** (all questions in section 6 answered). Design follows separately.
Date: 2026-10-13

---

## 1. Why this exists

SalesTeam knows a lot about an account — size, contacts, initiatives, leads, status — but it has no place
for what the seller did and learned: "I messaged her and sent the brochure", "budget is frozen until
January", "ask for Mr. Keller, not the CIO".

Today that knowledge lives in the seller's head, in a CRM, or in a separate file. In a team it is worse:
a colleague who opens the account cannot see what was already done, and the Team Lead cannot see what
happened last.

Notes fix that. A note is a short free text that SalesTeam dates and signs by itself, kept on the account,
the contact or the lead (post) it is about, and visible to everyone who can see that account.

Boaz's example: *"Oct-10-2026: I messaged <contact> and sent him our product brochure."*

---

## 2. How it works today (the starting point)

- There is **no notes field** anywhere: not on accounts, not on contacts, not on leads (posts).
- What comes closest:
  - **Status** (Not contacted / Contacted / Responded) says *that* something happened, not what.
  - **Follow-up due** is a date without a text.
  - **Activity Log** records what SalesTeam and the user did in the app (edited, assigned, researched).
    It is one long list for everything, it is personal to each PC, and nothing can be written into it by hand.
  - **Sales Mentor chat** on a lead is personal and never shared with the team.
- In a team, what a member changes on an account, a contact or a lead is shared through the team folder.
  A change is kept per record and per field: when two colleagues change the same field at the same time,
  the later one wins. A single shared text box for notes would therefore lose one colleague's text.
- While a colleague is editing an account, its editable parts are blocked for everyone else.

---

## 3. Requirements

### R1 — What a note is

1. A note has: the **text**, the **date and time** it was written, and the **author**. SalesTeam fills in
   date and author; the user only types the text.
2. The text is free text, several lines allowed, up to 2,000 characters.
3. A note belongs to exactly one account, one contact or one lead (post).
4. Notes are a **dated list**, newest first — not one text box. Each note is stored on its own, so two
   colleagues' notes written at the same moment are both kept.
5. Shown as: `Oct 10, 2026 — Boaz: I messaged Anna Muster and sent her our product brochure.`
   Without a team the author is left out.
6. A note does **not** change anything else by itself: not the Status, not Follow-up due, not the priority.

### R2 — Where notes are written and read

1. A **Notes** section on the account page, the contact page and the lead (post) detail.
2. The section shows the list of notes and, above it, a box to write a new one with an **Add note**
   button. Nothing is saved until the button is pressed (rule of 2026-10-06: Save is always explicit). An
   unsaved text is warned about before leaving the page, like other unsaved changes.
3. The **account page** shows one timeline: the notes on the account itself, and the notes on its contacts
   and its leads, each marked with what it is about ("on Anna Muster", "on the post of 3 Oct"). So the
   account page answers "what was the last thing that happened here?" in one place.
4. The contact page and the lead detail show only their own notes.
5. A long list shows the latest five; **Show all** opens the rest.

### R3 — Changing and deleting notes (agreed 2026-10-13)

1. The **author** may edit and delete their own notes.
2. The **Team Lead** (and the deputy) may delete any note, not edit it.
3. An edited note keeps its original date and is marked "(edited)".
4. Deleting asks first ("Delete this note?"). A deleted note is gone for the whole team.

### R4 — Notes in a team (agreed 2026-10-13)

1. Notes are **shared**: everyone who can see an account sees its notes and the notes of its contacts and leads.
2. **Anyone who can see an account may add a note** — also on an account assigned to a colleague.
3. Who can see an account is decided as today (assignment, account groups). An account a member cannot
   see shows them no notes either, in no list, column or export.
4. Adding a note does **not** take the account for editing, and is **not** blocked while a colleague is
   editing the account. Notes never collide: each one is its own entry.
5. A note keeps its author's name when the author later leaves the team.
6. Without a team, notes simply stay on this PC, like all other data.

### R5 — The "Last note" column (agreed 2026-10-13)

1. A **Last note** column in the three lists: the date and the beginning of the latest note; the full
   text on hover.
2. **Shown by default on Target Accounts; hidden by default on Target Contacts and Leads.** The Columns
   menu switches it on or off, as for every other column.
3. On Target Accounts the column counts the notes on the account, its contacts and its leads (the same
   timeline as R2.3).
4. The column sorts by date, so "accounts with the most recent activity" and "accounts with no note yet"
   are one click away.
5. The search box above each list also finds text inside notes.

### R6 — Sales Mentor and message drafts read the notes (agreed 2026-10-13)

1. When the Sales Mentor answers about a lead, and when SalesTeam drafts a message, the notes on the lead,
   its contact and its account are given to the AI together with the other account data — the latest
   ten notes at most.
2. So a draft does not offer the brochure that was already sent, and the Mentor knows what was said.
3. Notes are sent to the AI service only in these two cases, with the user's own API key, exactly like
   the account data that is already sent today. Help and the privacy text say so.

### R7 — Export, backup, removal, merging

1. **Backup and restore** include all notes.
2. **Export to CSV (SalesTeam's own columns)** gets two columns: **Last note** and **Notes** (every note
   as one line "date — author: text").
3. The **CRM export files** (HubSpot, Salesforce, Microsoft Dynamics) carry the notes too (Boaz,
   2026-10-13): each exported account with the notes of its timeline (R2.3), each exported contact with
   its own notes. Where the CRM's import has a place for notes, they go there; where it has none, they go
   into the description, below the text that is already written there. The design sets this per CRM, and
   each one is tested in the real CRM, as the export files were.
4. **Import** does not read notes. (Rule of 2026-10-09: an import only adds and fills, it never replaces.)
5. When two accounts or two contacts are **merged** (duplicates, "Same person?"), the notes of both are kept.
6. When an account is **removed**, its notes go with it and come back if it is restored from "Removed…".

### R8 — Activity Log

1. Adding, editing and deleting a note is written to the Activity Log ("Note added on Belimed"), and in a
   team to the team's log with the author's name.
2. The note's text is not repeated in the log.

### R9 — Help, PRD, release notes

1. A Help entry "Notes on accounts, contacts and leads", and a sentence in "Working as a team".
2. A PRD section, the release notes, and a check of the store listing and website text.

---

## 4. Out of scope

- Reminders and tasks. (Follow-up due stays as it is.)
- Attachments, pictures, formatted text, links to files.
- Mentioning a colleague in a note, or notifying anyone about a new note.
- Private notes that only the author sees. Every note is visible to everyone who sees the account.
- Notes on AI initiatives.
- Reading notes from a CRM file on import.
- Setting Status or Follow-up due from a note.

---

## 5. Build outline (for the design)

| Step | What | Test build |
|---|---|---|
| 0 | How a note is stored and shared so that no note is lost in a team; measured with two browsers | 1.2.3.10 |
| 1 | Notes section on the account page: add, list, edit, delete | 1.2.3.11 |
| 2 | Contact page and lead detail; the account timeline with contact and lead notes | 1.2.3.12 |
| 3 | Last note column in the three lists, sorting, search | 1.2.3.13 |
| 4 | Sales Mentor and message drafts read the notes | 1.2.3.14 |
| 5 | CSV export, backup, merge and removal, Activity Log | 1.2.3.15 |
| 6 | Notes in the HubSpot, Salesforce and Dynamics export files; tested in each CRM | 1.2.3.16 |
| 7 | Help, PRD, release notes, listing check | 1.2.4 |

---

## 6. Questions for Boaz — answered 2026-10-13

| # | Question | Answer |
|---|---|---|
| Q1 | Should the account page show one timeline with the notes on its contacts and leads too, or only the account's own notes? | One timeline (as recommended). |
| Q2 | Is 2,000 characters per note enough? | Yes (as recommended). |
| Q3 | Should notes go into the HubSpot / Salesforce / Dynamics export files? | **Yes, and in 1.2.4** (Boaz; the recommendation was to leave it for later). See R7.3 and build step 6. |
| Q4 | Should the search box above the lists also search inside notes? | Yes (as recommended). |
| Q5 | Which store release does this ship as? | One release, 1.2.4, with the Edge wording and the fixes of 1.2.3.1–1.2.3.9. |
