# SalesTeam — Export & Import: Requirements

Target release: **1.2.3** (test builds 1.2.2.x, together with team advanced mode and Exclusions & Relationships)
Status: **Requirements — agreed 2026-10-09** (all questions in section 6 answered "as proposed"). Design: EXPORT_IMPORT_DESIGN.md.
**Additions 2026-10-09: Microsoft Dynamics (R10) and one currency (R11) — AGREED**, asked for by Boaz during the
1.2.2.13 test (Q8 Dynamics 365 Sales, Q9 yes, Q10 header rows asked from his wife's company).
Date: 2026-10-09

---

## 1. Why this exists

Export and import grew one button at a time: three CSV exports, an Export to HubSpot, an Import from
HubSpot, an Import Research Workbook and a Restore from backup, spread over the left menu of every page.
Salesforce is missing altogether.

Two problems matter more than the number of buttons:

- **An import can destroy data.** Import Research Workbook replaces every workbook account and contact
  with the file's rows. Accounts and contacts the onboarding research found on the web are **deleted**,
  accounts that are not in the new file disappear, and the file's values overwrite newer current ones.
- **In a team, anyone can import**, and whatever one member imports reaches everyone.

Agreed with Boaz 2026-10-09:

- **No import ever removes or replaces an account or contact.** An import adds what is new and fills in
  what is missing.
- When the file and the account disagree, the **same rules as the web research** decide; a person is asked
  only when the difference is **more than 10%**, and in a team only the **Team Lead** is asked.
- **Everyone can export; in a team only the Team Lead can import.**

---

## 2. How it works today (the starting point)

**Exports** (all in the left menu, under the dashboard they belong to):

- Export Accounts (CSV) and Export Contacts (CSV) — SalesTeam's own column names; asks "all or the
  filtered rows"; empty columns dropped.
- Export All (CSV) / Export Filtered (CSV) for Leads (Posts).
- Export to HubSpot… — two CSV files (companies, contacts) in HubSpot's property names.
- Settings > Backup — a full backup (.zip); Export Settings (optionally with the API key).

**Imports:**

- Import Research Workbook… (.xlsx) — **wholesale replace** of the workbook rows. Kept only: rows found by
  LinkedIn Discovery, rows imported from HubSpot, initiatives added by web research. Lost: accounts and
  contacts found on the web (onboarding research), workbook accounts missing from the new file, and any
  current value the file disagrees with. Status, notes and hand edits survive (stored separately).
- Import from HubSpot… — add-only: companies and contacts SalesTeam does not have are added; existing ones
  are skipped entirely, so missing information on them is never filled in.
- Restore from Backup… — brings back accounts, contacts and initiatives as they were in the backup; you
  tick which parts.
- Import Settings, Import Leads — in Settings > Backup.
- No Salesforce, and no import of a plain CSV.
- No team rule: every member sees and can use every import.

**Web research disagreements** (the rules this item reuses): `web-findings-arbitration.js`, rules 1–11,
settings in Settings > Change Settings > Advanced. Anything not decided automatically goes to Decisions.

---

## 3. Requirements

### R1 — One Export and one Import

- R1.1 Target Accounts gets one **Export…** and one **Import…** (button on the page and in the left menu),
  replacing the separate items.
- R1.2 **Export…** offers: **CSV** (SalesTeam's own columns), **HubSpot**, **Salesforce**, **Microsoft Dynamics** (R10). Then: accounts,
  contacts or both; all or only the rows the table shows (today's question).
- R1.3 **Import…** offers: **CSV**, **HubSpot**, **Salesforce**, **Microsoft Dynamics** and, last, **Research workbook (.xlsx)**
  (1.2.2.13: research now runs inside SalesTeam, so the workbook is rarely needed). The file
  type is recognised from its columns where possible; a wrong file says what it looks like instead.
- R1.4 Target Contacts gets the same Export… (contacts pre-selected). The Leads Dashboard keeps its own
  Export (leads are a different thing). Backup and Restore stay in Settings (Q2).

### R2 — Import only adds and fills

- R2.1 An import **never deletes** an account, contact or initiative, and never hides one. An account or
  contact that is not in the file is left exactly as it is.
- R2.2 A company in the file that SalesTeam does not have becomes a **new account**; a person who is not yet
  a contact of that account becomes a **new contact**. Matching: account by LinkedIn page, then website,
  then name (as today); contact by LinkedIn profile, then e-mail, then name within the account.
- R2.3 For an account or contact SalesTeam already has, every field that is **empty** in SalesTeam and
  filled in the file is **filled in** (web-research rule 1).
- R2.4 A field that is filled on both sides and **different** is settled by R3. The current value is
  never overwritten silently by anything outside those rules.
- R2.5 Status, notes, owner/assignment, claims, relationship and exclusions are never changed by an import
  (Q4 for the workbook's Excluded column).
- R2.6 This applies to every import type, the research workbook included. Re-importing the same workbook
  changes nothing.
- R2.7 Rows SalesTeam adds remember where they came from (source: Workbook, CSV, HubSpot, Salesforce) and
  the import date, shown on the account like today's "Imported" dot.

### R3 — Differences: the web-research rules, with a 10% threshold

When an account already has a value and the file has a different one, the web-research rules decide, with
the file's value in the place of the web finding ("current" vs "import"):

- R3.1 **Within 10%** (numbers: employees, revenue, local or worldwide) — the current value is kept. No
  decision, no question.
- R3.2 **Impossible values** (rule 2's checks: 0 employees with revenue, revenue in the wrong units,
  impossible revenue per employee) — an impossible imported value is thrown away; an impossible *current*
  value with a sensible import value is a decision.
- R3.3 **Fields that do not affect scoring** (revenue, currency, HQ city, local employees, registry fields,
  and text fields such as industry, description, website) — decided automatically: current kept
  (rule 3; Q1 asks whether revenue > 10% apart should be asked instead).
- R3.4 **Employees in the same size band** — current kept (rule 4).
- R3.5 **Employees more than 10% apart and in a different size band** — a **decision** (rule 6). The 10%
  replaces the web research's 15% tolerance for imports (rule 5) and is its own setting.
- R3.6 **HQ country** — rule 11 (group HQ over Swiss subsidiary, by the Local/Global classification);
  a different country that changes the location priority is a **decision** (rule 7).
- R3.7 **Worldwide figure that is only a copy of the local one** — the import's genuine worldwide figure is
  taken (rule 9).
- R3.8 **Weak evidence** — where the current value has no real evidence behind it and the file's value does
  (the workbook's evidence columns), the file's value is taken (rule 10).
- R3.9 **Revenue currency follows the amount**, as for web findings.
- R3.10 Contacts: a different job title, e-mail or LinkedIn profile on an existing contact — current kept,
  no decision (Q3).
- R3.11 The rule switches the user set for web research (Settings > Advanced) apply to imports too; only
  the tolerance is separate (10%).

### R4 — Decisions

- R4.1 Every import difference that needs a person appears in **Decisions** as "Import difference",
  showing **current** and **import** side by side with the file name and date, and the rule that sent it
  there. Choices: **Keep current** / **Use import**.
- R4.2 In a team, import decisions go to the **Team Lead only** (and the deputy while one is appointed).
  Members never see them. Without a team, the user gets them.
- R4.3 Choosing "Use import" writes the value like a hand edit and syncs to the team as usual.
- R4.4 A later import of the same value for the same field does not ask again while the decision is open,
  and not at all once it was answered "Keep current".

### R5 — Who can import and export

- R5.1 **Export: everyone**, in a team and alone. In a team with groups (advanced mode), a member exports
  only the accounts and contacts they can see.
- R5.2 **Import: Team Lead only** in a team (deputy too while appointed). Members do not see Import… at all
  — no greyed-out button (simple pages). Without a team, the user can import.
- R5.3 **Restore from backup** brings data back as it was, so it is a replace by nature: in a team, **Team
  Lead only**, with the existing "you choose what to restore" step and a clear warning that the team gets
  the restored data.
- R5.4 Import Settings: each member can import their own settings; settings the team shares (exclusions,
  relationships, groups) are imported only for the Team Lead (Q5).

### R6 — Before and after an import

- R6.1 **Check first.** After choosing the file, SalesTeam shows what the import would do, before writing
  anything: new accounts, new contacts, fields filled, differences kept automatically, differences for
  Decisions, rows skipped (and why). One button: **Import**, plus Cancel.
- R6.2 A backup is saved automatically just before the import writes anything (the existing automatic
  backup), so a bad file can always be undone with Restore.
- R6.3 Afterwards: one result pop-up with one OK, the same counts, and "n differences are waiting in
  Decisions" when there are any. An Activity Log line; in a team, a team log line ("Boaz imported
  HubSpot-companies.csv: 12 new accounts, 40 fields filled").
- R6.4 Large files are written in batches and persisted as they go, so a reload mid-import loses nothing
  that was already written.
- R6.5 New accounts join the normal pipeline queue; nothing is researched in a burst.

### R7 — Salesforce

- R7.1 **Export:** two CSV files, **Accounts** and **Contacts**, with Salesforce's standard field names
  (Account Name, Website, Industry, Employees, Annual Revenue, Billing City/Country, Description; First
  Name, Last Name, Title, Email, Account Name, LinkedIn as a description line), ready for Salesforce's Data
  Import Wizard. The pop-up says which file to import first (Accounts).
- R7.2 **Import:** a CSV exported from Salesforce (an Accounts or Contacts report, or Data Loader export).
  Columns recognised by Salesforce's field names and labels. Follows R2–R6.
- R7.3 Salesforce Leads (the object) are out of scope (Q6).

### R10 — Microsoft Dynamics 365 Sales (PROPOSED 2026-10-09)

- R10.1 **Export:** two files, **Accounts** and **Contacts**, with Dynamics 365 Sales' own column names (Account
  Name, Website, Industry, Number of Employees, Annual Revenue, Address 1: City, Address 1: Country/Region,
  Description; First Name, Last Name, Job Title, Email, Business Phone, Company Name, Address 1: City / Country,
  LinkedIn as a description line), ready for Dynamics' Import Data wizard. The pop-up says to import Accounts
  first, then Contacts (Company Name links each contact to its account). Revenue in the display currency.
- R10.2 **Import:** an Accounts or Contacts file exported from Dynamics with **Export to Excel** (.xlsx) or as a
  CSV. Columns recognised by Dynamics' display names and its field names (`name`, `websiteurl`,
  `numberofemployees`, `revenue`, `address1_city`, `address1_country`, `firstname`, `lastname`, `jobtitle`,
  `emailaddress1`, `parentcustomerid`). Dynamics' hidden "(Do Not Modify)" columns are ignored. Follows R2–R6.
- R10.3 Dynamics Leads and Opportunities are out of scope (as Salesforce Leads, Q6).
- R10.4 Like Salesforce, checked once against a real Dynamics 365 Sales environment before it ships (a free
  trial, or a header-only sample file from a company that uses it - no customer data needed).

### R11 — One currency (agreed 2026-10-09)

- R11.1 Revenues are shown and exported in the default currency (Change Settings > Advanced > Revenue &
  Currency, default USD, the Team Lead's in a team); the stored amount keeps its own currency.
- R11.2 Export column titles name the currency: "Global Revenue (USD)".
- R11.3 An import never assumes a currency: a per-row currency or one named in the column title is used;
  otherwise the user must choose before Import is possible, and a plausibility check warns when the figures
  look like another currency. (Design 8b, D13–D15.)

### R8 — CSV import (SalesTeam's own columns)

- R8.1 A CSV made by SalesTeam's own Export (or the same columns, e.g. edited in Excel) can be imported.
  Follows R2–R6. This lets a team move data between SalesTeam installs without a full backup.

### R9 — Help, PRD, release notes

- R9.1 Help: one "Export and import" topic: what each format is for, "an import only adds", the Team Lead
  rule, where differences go.
- R9.2 PRD section for Export/Import updated; release notes for 1.2.3.

---

## 4. Out of scope

- Live connections to HubSpot, Salesforce or Dynamics (API, sign-in, two-way sync) — files only.
- Importing Leads (Posts) from a CRM.
- Undo of a single import other than Restore from the automatic backup.
- A company-wide Admin role above teams (later item).

---

## 5. Build outline (for the design)

1. Fix first: workbook import becomes add-and-fill (R2) — removes the data loss on its own.
2. Pure module for import differences (reusing `web-findings-arbitration.js` with the 10% tolerance), with
   harness cases in `test_pure_modules.py`.
3. Check-first summary + Decisions "Import difference" + Team Lead routing.
4. One Export… / Import… menu; Team Lead gating; Restore gating.
5. Salesforce export and import; SalesTeam CSV import.
6. Help, PRD, release notes.

---

## 6. Questions for Boaz — answered 2026-10-09: all as proposed

- **Q1** Revenue, HQ city, industry etc. never affect scoring, so the web research keeps the current value
  without asking (rule 3). Same for imports — or should a revenue difference over 10% be asked too?
  *Proposed: same as web research (not asked).*
- **Q2** Backup / Restore stay in Settings, not in the new Import… menu? *Proposed: yes.*
- **Q3** Contacts: a different job title on an existing contact usually means the person changed role.
  Keep current without asking (proposed), or take the import's?
- **Q4** The research workbook's `Excluded = Yes` hides an account today. Keep that on import (it is the
  only way an import can hide an account), or ignore it and leave exclusions to Setup? *Proposed: keep, but
  only for accounts the import adds; an existing account is never hidden by an import.*
- **Q5** In a team, may a member still use Import Settings for their own settings? *Proposed: yes; shared
  settings only from the Team Lead.*
- **Q6** Salesforce: Accounts + Contacts only (proposed), or also Salesforce Leads?
- **Q7** Is a new "Import differences" tolerance setting wanted in Advanced, or is 10% fixed? *Proposed: a
  setting, default 10%.*

### Added 2026-10-09 (Microsoft Dynamics) — open

- **Q8** Which Dynamics? "Microsoft Dynamics" is two different products: **Dynamics 365 Sales** (the CRM -
  accounts, contacts, opportunities) and **Dynamics 365 Business Central** (accounting/ERP - customers,
  vendors). *Proposed: Dynamics 365 Sales.* Ask your wife's company which one they open to see their
  customers and contacts.
- **Q9** Same step as Salesforce (step 3, test builds 1.2.2.14+), both shipping in 1.2.3? *Proposed: yes.*
- **Q10** For the live check: a free Dynamics 365 Sales trial (30 days, set up by you), or only the **column
  header row** of an Accounts and a Contacts export from your wife's company (no data rows)? *Proposed: the
  header rows first - they show the real column names her company's Dynamics uses, including any custom
  columns - and the trial only if the import into Dynamics itself needs testing.*
