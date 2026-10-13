# SalesTeam — Notes on accounts, contacts and leads: Design

Target release: **1.2.4** (test builds 1.2.3.10, 1.2.3.11 …)
Status: **Design — agreed 2026-10-13.** Boaz agreed to D1–D8 as proposed (section 12).
Date: 2026-10-13
Builds on: `NOTES_REQUIREMENTS.md` (agreed 2026-10-13). Requirement numbers (R2.3, R5.4 …) refer to it.

---

## 1. The design in one page

1. **Every note is its own stored entry.** A new stored list, `notes`, holds one entry per note: what it
   is about, the text, when, and who. In a team each entry travels on its own, so two colleagues' notes
   written in the same second are both kept. Nothing is added to the account, contact or lead records
   themselves (section 3).
2. **A note points at its subject; the account timeline is worked out when it is shown.** A note says
   "on account X", "on contact Y" or "on lead Z". The account page collects the notes on the account, on
   its contacts and on its leads at the moment it is opened — the same way the page already finds an
   account's contacts and leads. Nothing has to be kept in step (section 4).
3. **Deleting marks the note as deleted; it does not remove the entry.** In the team's data a removed
   entry can come back when a colleague's later change arrives. A deleted mark cannot (section 3.3).
4. **Notes stay outside the "someone is editing this account" mechanism.** The Notes section is not one
   of the blocked parts of the page, writing a note does not take the account, and a note is sent to the
   team at once even while a colleague holds the account (section 5).
5. **Who sees a note is decided by the account, as today.** All of a team's data is already on every
   member's PC; the pages decide what is shown. Notes follow the same rule: a note is shown only where
   its account is (section 5.3).
6. **One Notes component, used on all three pages.** The same list, the same box and the same menu on
   the account page, the contact page and the lead detail (section 6).
7. **"Last note" is an ordinary column**, so sorting, the Columns menu and the CSV export come with it
   (sections 7 and 9).
8. **The AI is given the notes as a short block of text** — the latest ten — wherever it is asked about
   that account, contact or lead (section 8).

---

## 2. What the code review found

### 2.1 Nothing to build on, nothing in the way
There is no notes field today, on any record. Nothing has to be migrated.

### 2.2 How the team shares data
- Shared data is cut into rows. A change is kept **per field of a row**; when two members change the same
  field, the later one wins and the other is recorded as lost (`team-merge.js` `applyOp`).
- A list stored as one object "keyed by something stable" is shared as **one row per entry**
  (`team-keys.js` `TEAM_MAP_KEYS`, `team-rows.js`). This is what notes need.
- Removing an entry is sent as a delete. But a row "exists if there is no delete, or any field was changed
  after the delete" (`team-merge.js` `entityView`). So a colleague's edit that arrives after a delete
  brings the entry back, with everything it ever held. Account groups avoid this with a `deleted` field
  instead; notes do the same.
- Only one kind of row has a rule about *who* may write it: the account groups, which only the Team Lead
  writes (`rebuildGated`). There is no "only the author" rule anywhere today.

### 2.3 Who sees what
Visibility in a team is decided **when a page shows the data**, not by what is sent: every member's PC has
all rows. Pages ask `teamAccounts.canSee(accountKey)` and `teamAccounts.canSeeLead(lead)`; the Target
Accounts page filters its whole working copy once (`applyVisibleRows`), and lists, counts and exports work
on that copy.

### 2.4 The edit hold
- The account page blocks three parts while a colleague edits: the overview, the detail lists, the web
  research. The contact page blocks its overview. Anything outside those parts is neither blocked nor
  takes the account (the Sales Mentor chat is the existing example).
- **A trap:** any element on the page marked `data-unsaved` makes the page take the account again every
  few seconds (added in 1.2.3.2/1.2.3.3 so that an unsaved edit keeps the hold). An unsaved note must not
  use that mark, or typing a note would lock the account for everyone else.
- In the background, a change is held back under a colleague's hold only for rows whose id starts with
  `ta:`, `x:` or `wb:` (`team-claims.js` `accountKeyOfChange`). A row with another prefix is sent at once.

### 2.5 Keys
- Account key: the normalised company name. Contact key: `<account key>::<name>`. Lead key: the post's
  (or job ad's) web address.
- A lead is tied to its account and contact **by name when it is shown**, not by a stored link.
- Merging two accounts or two contacts changes keys: the merge functions in `storage.js` already move the
  extras from the dropped key to the kept one. Notes have to be moved in the same place.
- Removing an account or contact only sets a flag; restoring clears it. Notes need nothing there — they
  are hidden with the account and are back when it is.

### 2.6 Lists
- Target Accounts and Target Contacts: column tables (`COMPANY_COLUMNS`, `CONTACT_LIST_COLUMNS`), one
  function for a cell's value and one for its sort value. A column marked `longText` is cut short and
  opens on a click — the behaviour asked for in R2.6. SalesTeam's own CSV export writes every column of
  these tables, so a new column is exported without further work.
- Leads: its own column table (`COLUMNS` in `dashboard.js`) with the same ideas.
- Which columns a user hid is remembered in the browser. A **new** column that should be shown by default
  needs care there, so that it appears without resetting the user's other choices.
- The search boxes look at fixed fields only (company and industry; name, company and title; title,
  content and creator).

### 2.7 AI prompts — a finding that changes R6.3
The Sales Mentor on a **lead** and the **message draft** are given only the lead itself today: author,
headline, post text, topics and the customer/partner line. They are **not** given the account's or the
contact's data. Account and contact data go only into the Mentor chats on the account page and the contact
page.

So R6.3 as first written ("exactly like the account data that is already sent today") was not accurate for
these two: notes are the first account-level text they receive. R6.3 was corrected on 2026-10-13 (decision D6).

### 2.8 Export
- Salesforce and Dynamics files carry a **Description** column, built from fixed lines ("Priority: …",
  "SalesTeam id: …"). Dynamics cuts it at 2,000 characters. On import SalesTeam reads those lines back, so
  a note line must not look like one of them.
- HubSpot files are built in a separate file (`hubspot.js`), not reviewed yet. Whether HubSpot's import
  takes notes as notes, or only as a text property, is checked in build step 6.

### 2.9 Logs and backup
- The Activity Log takes an entry with an action, a label and the account or contact it concerns; the
  account and contact pages show those entries under Recent Activity.
- The team log is written from the shared changes and by default includes the changed value (up to 120
  characters). For notes the text has to be left out (R8.2).
- A backup holds everything stored, so notes are included without work; they only need to be put in the
  right group of the "what to restore" choice.

---

## 3. Data

### 3.1 The new key

`notes` — one object, keyed by the note's id:

```
notes = {
  "<note id>": {
    on: "account" | "contact" | "lead",
    key: "<account key | contact key | lead key>",
    text: "…",                // up to 2,000 characters
    at: 1791619200000,        // written
    by: "<member id>" | null, // null without a team
    byName: "Boaz" | null,    // kept with the note, so it still reads right when the author has left (R4.5)
    editedAt: null | <time>,
    deletedAt: null | <time>,
    deletedBy: null | "<member id>"
  }
}
```

- The id is random and made once (`crypto.randomUUID()`), so two PCs can never make the same one.
- One object for all notes is enough: a note is at most 2,000 characters, and even several thousand notes
  are small beside the account data already stored.

### 3.2 A pure module: `notes.js`

Everything that is a rule lives in one file without storage or screen code, so it runs in the test
harness (`test_pure_modules.py`):

- `noteEntry(on, key, text, author, now)` — a new note; trims the text and cuts it at 2,000.
- `liveNotes(notes)` — without the deleted ones.
- `notesOn(notes, on, key)` — one subject's notes, newest first.
- `accountTimeline(notes, accountKey, leadKeys)` — the account's own notes, the notes on its contacts
  (their key starts with the account key) and the notes on the leads given; newest first; each marked
  with what it is about.
- `lastNoteByAccount / ByContact / ByLead` — the indexes behind the Last note column.
- `mayEdit(note, me)` and `mayDelete(note, me, leadRights)` — R3.
- `rekeyNotes(notes, moves)` — for merges (section 10).
- `notesPromptBlock(notes, max)` and `notesExportLines(notes)` — sections 8 and 9.
- `noteLine(note, inTeam)` — "Oct 10, 2026 — Boaz: …".

`storage.js` gets four small functions on top: `getNotes`, `addNote`, `editNote`, `deleteNote`.

### 3.3 Deleting
`deleteNote` sets `deletedAt` and `deletedBy` and **empties the text**. The entry stays. A colleague's
edit of the same note that arrives later changes the text field but not the deleted mark, so the note
stays deleted on every PC.

### 3.4 Team
- `notes` joins `TEAM_MAP_KEYS` with its own row prefix `note:`. One row per note, so R1.4 holds by
  construction.
- The prefix is not one of the three the edit hold looks at, so a note is never held back (R4.4).
- The row is filed under the existing entity type "account". An older SalesTeam in the same team (a
  colleague who has not updated yet) then stores the rows without showing them. **Step 0 measures this**
  with one browser on the new build and one on 1.2.3.
- **Rights (R3) are applied on the page**, the same way visibility is: Edit is offered only to the
  author, Delete to the author, the Team Lead and the deputy. There is no check in the team's merge. Agreed as
  decision D3.

---

## 4. Which notes belong where

| Shown on | Notes |
|---|---|
| Account page (timeline, R2.3) | on the account; on its contacts; on its leads |
| Contact page | on that contact |
| Lead detail | on that lead |
| Last note, Target Accounts | the latest of the account's timeline |
| Last note, Target Contacts | the latest on the contact |
| Last note, Leads | the latest on the lead |

- A contact's notes are found by the contact key, which begins with the account key.
- A lead's notes are found through the leads the page already lists for that account (matched by company
  name, as today).
- A note on a lead whose company is not an account in Target Accounts shows on the lead only.

---

## 5. In a team

### 5.1 No hold, no block
- The Notes section is a part of the page **beside** the blocked parts, not inside them. A colleague
  editing the account does not grey it out.
- Typing in the note box does not take the account.
- An unsaved note is marked `data-unsaved-note`, a mark of its own. The "leave this page?" warning looks
  for both marks; the edit hold looks only for the old one (section 2.4).

### 5.2 Sent at once
A note is written to the team folder with the next sync, whoever holds the account.

### 5.3 Visibility
- Account note: shown where `canSee(account key)`.
- Contact note: shown where `canSee` of the account part of the contact key.
- Lead note: shown where `canSeeLead(lead)`.
- The lists and the export already work on the filtered copy, so they only ever look up notes for rows
  the member sees.

### 5.4 The author's name
`byName` is written into the note from the member's team name. It does not depend on that member still
being in the team later. Without a team no author is stored or shown.

---

## 6. Screens

### 6.1 The Notes section (one component, `notes-ui.js`)

```
NOTES (7)
┌──────────────────────────────────────────────────────────────────────┐
│ Write a note…                                                         │
└──────────────────────────────────────────────────────────────────────┘
[ Add note ]                                                    0 / 2,000

 Oct 13, 2026 — Boaz: Call with Anna Muster. Budget is frozen until January,      ⋮
 she asked to be contacted again mid-December. Sent the brochure …
 Oct 10, 2026 — Edge Test · on Anna Muster: I messaged her and sent our           ⋮
 product brochure.
 Oct 3, 2026 — Boaz · on the post of Oct 3: Liked and commented.                   ⋮
 Sep 28, 2026 — Boaz: First call, spoke to the assistant.                           ⋮
                                                                     ▼ scrolls
```

- **Height (R2.5):** the list is eight text lines high — four notes of two lines — and scrolls.
- **Two lines per note (R2.6):** a longer note is cut with "…"; a click on the note opens it in full,
  another click closes it. Same behaviour as the long text cells in the tables.
- **Date:** "Oct 13, 2026"; the time shows on hover. "(edited)" after the date when it was changed.
- **⋮ per note:** *Edit…* (author only) and *Delete…* (author, Team Lead, deputy). A note the viewer may
  do nothing with has no ⋮.
- **Edit…** puts the text back into the box; the button reads **Save note**, with **Cancel** beside it.
- **Delete…** asks "Delete this note? It is deleted for the whole team."
- **Add note** is greyed out while the box is empty, and shows "Saving…" while it saves.
- Without a team: no author, no "for the whole team".

### 6.2 Where the section sits
- **Account page:** directly under the overview card, above Contacts / Initiatives / Sources.
- **Contact page:** directly under the overview card.
- **Lead detail:** under the post's content, above the message draft.

Agreed as decision D4.

---

## 7. The "Last note" column, sorting and search

- **Value:** "Oct 13, 2026 — Boaz: Call with Anna Muster. Budget is …"; it is a `longText` column, so it
  is cut short and opens on a click.
- **Sort value:** the note's time. Rows without a note sort last, as empty values do today.
- **Default (R5.2):** shown on Target Accounts, hidden on Target Contacts and Leads.
- **Existing users:** the column appears on Target Accounts without changing which other columns the
  user has hidden (section 2.6).
- **Search (R5.5):** the three search boxes also match the text of the notes that belong to the row (for
  an account: its timeline).

---

## 8. AI (R6)

`notesPromptBlock` produces, for the latest ten notes at most:

```
Notes written by the sales team (newest first):
- 2026-10-13 Boaz: Call with Anna Muster. Budget is frozen until January …
- 2026-10-10 Edge Test (on Anna Muster): I messaged her and sent our product brochure.
```

It is added to:

| Prompt | Notes given |
|---|---|
| Sales Mentor on a lead | on the lead, on its contact, on its account |
| Message draft | on the lead, on its contact, on its account |
| Sales Mentor on the account page | the account's timeline |
| Sales Mentor on the contact page | on the contact, on its account |

The last two were added by decision D5 (now R6.4). Each note is cut at 500 characters in the
prompt, so ten notes cannot crowd out the rest.

---

## 9. Export and backup (R7)

### 9.1 SalesTeam's own CSV
- **Last note** comes with the column.
- **Notes** is a second, export-only column (it never shows in a list or in the Columns menu): every note
  of the row, one per line, "2026-10-13 Boaz: text".

### 9.2 Salesforce and Microsoft Dynamics
Their import has no place for notes on an account or contact file, so the notes go into **Description**,
after the lines that are there today:

```
Priority: P1 …
Notes:
- 2026-10-13 Boaz: Call with Anna Muster. Budget is frozen until January …
- 2026-10-10 Edge Test (on Anna Muster): I messaged her and sent our product brochure.
SalesTeam id: …
```

- Each note line starts with "- ", so SalesTeam's own import never mistakes it for one of its lines.
- Dynamics allows 2,000 characters: the newest notes are written first, and whole notes are left out
  from the oldest until it fits. The "SalesTeam id" line is always kept.
- An account's Description carries its timeline; a contact's carries the contact's notes.

### 9.3 HubSpot
Decided in build step 6, after reading `hubspot.js` and trying it in HubSpot: as real HubSpot notes if
its import accepts them in the same file, otherwise in the description property like the other two.

### 9.4 Backup and restore
Included by itself. `notes` is listed with the accounts group, so "restore accounts" brings the notes too.

---

## 10. Merging and removing (R7.5, R7.6)

- **Merging two accounts** (`mergeTargetAccounts`): the notes on the dropped account move to the kept
  one, and the notes on contacts whose key changes move with them — in the same place where the extras
  are moved today.
- **Merging two contacts** (`mergeTargetContacts`): the dropped contact's notes move to the kept one.
- **Removing and restoring:** nothing to do (section 2.5).
- Lead notes are not affected by a merge: a lead keeps its key.

---

## 11. Build steps

| Step | What | Test build |
|---|---|---|
| 0 | `notes.js` + harness cases; `notes` in the team's shared keys; storage functions. Measured with two browsers: two notes at the same moment both kept; a delete against a later edit stays deleted; a colleague still on 1.2.3 is not disturbed; a note goes out while the account is held | 1.2.3.10 |
| 1 | `notes-ui.js`; Notes section on the account page (account's own notes): add, list, two-line cut, scroll, Edit…, Delete… | 1.2.3.11 |
| 2 | Contact page and lead detail; the account timeline with contact and lead notes | 1.2.3.12 |
| 3 | Last note column in the three lists, sorting, search | 1.2.3.13 |
| 4 | Notes in the four AI prompts | 1.2.3.14 |
| 5 | CSV Notes column, backup group, merges, Activity Log and team log lines | 1.2.3.15 |
| 6 | Notes in the Salesforce, Dynamics and HubSpot files; tried in each CRM | 1.2.3.16 |
| 7 | Help, PRD section, release notes, privacy text (R6.3), listing and website check | 1.2.4 |

---

## 12. Decisions (all agreed 2026-10-13, as proposed)

| # | Decision | Reason |
|---|---|---|
| D1 | Notes are a new stored list of their own, one entry per note, not a field on the account. | Yes. It is the only way two colleagues' notes both survive. |
| D2 | Deleting marks a note deleted and empties its text; the entry stays in the team's data. | Yes. A removed entry could come back; a marked one cannot. |
| D3 | "Only the author edits, only author / Team Lead / deputy delete" is applied by what the page offers, not checked again when the team's changes are merged. | Yes. It is how visibility already works, and every member runs the same SalesTeam. A second check in the merge is new machinery for a case that cannot arise through the screens. |
| D4 | Where the Notes section sits: under the overview card on the account and contact pages; under the post's content on the lead detail. | As proposed, so notes are seen without scrolling. |
| D5 | The Sales Mentor chats on the **account page** and the **contact page** read the notes too (the requirements name only the Mentor on a lead and the drafts). | Yes. Asking the Mentor about an account while it ignores your notes on it would be odd. |
| D6 | R6.3 is corrected: the lead Mentor and the draft get no account data today, so the notes are **new** text sent to the AI service for them. Help and the privacy text say that notes are sent when you use the Mentor or a draft. | Corrected in the requirements. Nothing else changes. |
| D7 | In the AI prompt a note is cut at 500 characters and only the latest ten are given. | Yes. |
| D8 | Dynamics' 2,000-character Description: newest notes first, oldest left out when it does not fit. | Yes. The alternative is cutting a note in the middle. |
