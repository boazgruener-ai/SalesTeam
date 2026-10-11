# SalesTeam — Export & Import: Design

Target release: **1.2.3** (test builds 1.2.2.x)
Status: **Design — AGREED 2026-10-09** (D1–D10 all as proposed). **Addition 2026-10-09: section 8a Microsoft
Dynamics (D11–D12) and section 8b One currency (D13–D15) — AGREED 2026-10-09, built in step 3.**
Requirements: EXPORT_IMPORT_REQUIREMENTS.md (agreed 2026-10-09).
Date: 2026-10-09

---

## 1. The design in one page

- **One import path for every format.** Each format only *reads* its file into SalesTeam's own row shape
  (workbook, SalesTeam CSV, HubSpot, Salesforce). Everything after that is shared: match, plan, check-first
  summary, safety copy, write, Decisions, logs.
- **A new pure module, `import-merge.js`**, matches file rows to existing accounts and contacts and builds
  the plan: new rows to add, empty fields to fill, differences to settle. Differences go through the
  **existing** `arbitrateAccount` from `web-findings-arbitration.js` — the same rules 1–11 — with the file's
  value in the place of the web finding, "current data" always preferred, and the import tolerance (10%).
- **Fills and accepted values are written as overrides** (`targetAccountExtras[...].overrides`, provenance
  `import`), exactly like web research autofill. The original workbook rows are never rewritten, so nothing
  an earlier import or the web research put there can be lost.
- **Differences that need a person** are stored on the account (`importFindings`) and appear in Decisions as
  a new kind, `import_finding`, shown only to the Team Lead (and deputy) in a team.
- **Import… and Restore are Team-Lead-only** in a team: hidden in the menus, refused by the hash router, and
  refused again in storage.
- **One Export… and one Import… dialog** on Target Accounts (Export… also on Target Contacts). Salesforce is a
  new small module next to `hubspot.js`.

---

## 2. What the code review found

### 2.1 Research workbook import (target-accounts.js ~4478–4645)

1. `parseFullTargetAccountsWorkbook` (in-house `xlsx-lite.js`, no library) → `{companies, contacts,
   aiInitiatives, aiInvestment, sources, exclusionList, aliases}`.
2. `importTargetAccounts(list)` — rebuilds the legacy `targetAccounts` map **from scratch** (keeps only
   the LinkedIn IDs). This map is team-synced per entry, so in a team the rebuild deletes entries for
   everyone.
3. `importTargetAccountsWorkbook(sheets)` (storage.js:1825) — **replaces** the workbook; keeps only rows
   with source Discovered / HubSpot and Web-research initiatives. Rows with source **"Web"** (onboarding
   web discovery, storage.js ~5458 and ~5561) are **dropped**.
4. `backfillCompanyExclusionsFromWorkbook` — additive; runs the relationships migration (Team Lead only).
5. `autoPrioritizeNewCompanies`, a status line (no pop-up), Activity Log `target_accounts_imported`.

### 2.2 Other imports

- HubSpot (`#hubspot-import-dialog`, target-accounts.js ~7075) → `addHubspotRowsToWorkbook`
  (storage.js:4653): adds new companies and contacts, skips existing ones completely.
- Restore: `restoreFromFile` (backup-restore.js) with `safetyCopyBeforeRestore()` (backup-restore.js:421) —
  a "before-restore" zip. In a team it only *warns*; any member can restore.

### 2.3 User edits and web findings

- Account edits: `targetAccountExtras[normalizeCompanyName]` → `overrides`, `webResearch`,
  `webFindingsDismissed`, `provenance`. Written by `saveTargetAccountExtra(key, patch, {src, base})`
  (3-way merge) or `bulkPatchExtras`. The effective view (`getAccountViews`) is `override || row`.
- Contacts: `targetContactExtras[contactKeyFor(company, fullName)]`.
- Web findings are **not stored**; they are recomputed from `webResearch.data` by
  `computeFindingProposals` → `{key, label, current, found, state}`. `arbitrateAccount({proposals, extra,
  ctx, settings, data})` returns `{decisions, patch}`; `autoResolveWebFindings` (storage.js:5288) applies
  it. Settings: `webFindingsArbitration` (team-shared whole key), `tolerancePct: 15`.

### 2.4 Decisions

- `getDecisionQueue` (storage.js:5922): kinds page_changed, id_taken, name_match, duplicate,
  lacking_evidence, finding, join_proposal. decisions.js shows one card, two choices, "apply to similar".
- Team Lead check: `leadRightsOf(membership, summary)` (team-groups.js:245) = lead or deputy.

### 2.5 Team sync

- `targetAccountsWorkbook` syncs **per row**: companies by `companyId`, contacts by `contactId`,
  initiatives by `initiativeId`. Extras sync per account.
- **Risk found:** a new workbook can reuse a `companyId` ("C-001") that already belongs to a *different*
  company from an older file. With per-row sync keyed on the id, adding it as-is would overwrite that
  company's row for the whole team. New rows must get a fresh id when theirs is taken (D4).
- The team log folds changes per member + account, so a 300-account import shows ~300 lines.

### 2.6 Exports and menus

- `exportTableCsv(kind)` (target-accounts.js:6973) exports the rows the table shows — so it automatically
  inherits advanced-mode visibility once step 2 (Visibility) filters the table.
- HubSpot export builds its rows separately (`hubspotExportSelection`); it must use the same visible set.
- Left-menu buttons on dashboard.html, scanner.html, settings.html route through
  `showEmbeddedPage("target-accounts.html#action=X")` → `openActionFromHash` / `ACTION_DIALOG_IDS`.
- `buildAutoBackup` (storage.js:2478) is dead code (no callers) — removed in step 0.

---

## 3. The import pipeline

```
file ──read──▶ canonical rows ──match──▶ plan ──check-first──▶ safety copy ──write (batches)──▶ logs
      (per format)              (import-merge.js, pure)        (dialog)                      Decisions
```

### 3.1 Readers (one per format, all return the same shape)

`{ companies: [row], contacts: [row], initiatives: [row], investment: [row], sources: [row],
   exclusionList: [row], aliases: [row], format, fileName, currency }`

Rows use the workbook's own camelCase field names (`company`, `globalEmployees`, `globalHqCountry`,
`linkedinLink`, `website`, `fullName`, `jobTitle`, `publicBusinessEmail`, `profileUrl` …).

| Format | Reader | Notes |
|---|---|---|
| Research workbook | `parseFullTargetAccountsWorkbook` (exists) | all sheets |
| SalesTeam CSV | `salesteamCsvRows` (new, csv-import.js) | reverses the export's column labels (accounts or contacts file) |
| HubSpot | `hubspotCompanyRows` / `hubspotContactRows` (exist) | |
| Salesforce | `salesforceAccountRows` / `salesforceContactRows` (new, salesforce.js) | section 8 |

`detectImportFile(headers)` (pure, csv-import.js) tells SalesTeam / HubSpot / Salesforce and accounts /
contacts apart by their columns; a file that matches none says which columns it expected.

### 3.2 Matching (R2.2)

- **Account:** LinkedIn company page (slug or numeric id) → website domain → normalised name, plus the
  workbook's aliases. Reuses `company-identity.js` matchers (the ones exclusions use).
- **Contact:** LinkedIn profile → e-mail → `contactKeyFor(account, fullName)` within the matched account.
- A file contact whose company matches no account and is not in the file's companies gets a minimal account
  (as HubSpot import does today).
- Two file rows matching the same account: the first wins for fills; both are counted under "skipped" with
  the reason.

### 3.3 The plan (pure: `planImport(parsed, current, settings)`)

```
{ newCompanies: [row], newContacts: [row], newInitiatives, newInvestment, newSources,
  fills:     [{ key, kind: "account"|"contact", field, value }],
  kept:      [{ key, field, current, imported, rule, why }],      // settled: current stays
  taken:     [{ key, field, current, imported, rule, why }],      // settled: import wins (rules 9, 10)
  decisions: [{ key, field, current, imported, rule, why }],
  skipped:   [{ name, reason }],
  idRemaps:  { "C-001": "C-001-i3" } }
```

For each matched account: build proposals `{key: field, label, current: view[field], found: fileRow[field],
state}` for the compared fields (employees local/worldwide, revenue local/worldwide + currency, HQ country,
HQ city, industry, company type, registry fields, website, LinkedIn page, alternative name), then:

1. Drop proposals whose imported value equals current, or was answered "Keep current" before
   (`importFindingsDismissed[field] === value`, R4.4), or is already an open import finding with that value.
2. **R3.1 — within tolerance:** numeric fields whose two values are within `importTolerancePct` (default
   10%) of each other → `kept`, rule "within 10%". Runs *before* the rules so nothing within 10% can ever
   reach Decisions.
3. The rest → `arbitrateAccount` with `settings = { ...webFindingsArbitration, tolerancePct:
   importTolerancePct, sourcePreference: "existing" }` (the "ask about every difference" switch in
   `autoResolveWebFindings` is not used for imports — R3.1 decides that). Its decisions map:
   `apply` on an empty field → `fills`; `apply` on a filled field (rules 9, 10, 11) → `taken`; `dismiss` →
   `kept`; `review` → `decisions`. Rule 8 (impossible value → whole row discarded) applies per file row.
4. Contacts: empty fields → `fills`; any difference → `kept` (Q3: no decision).

The rules module stays untouched except one addition: `arbitrateAccount` accepts `dismissField` (default
`webFindingsDismissed`) so its patch can target `importFindingsDismissed` — or the adapter maps the patch;
decided in the build (whichever keeps `test_pure_modules.py`'s existing cases unchanged).

### 3.4 Check first (R6.1)

The Import dialog runs `planImport` and shows the counts in plain words, before anything is written:

> **HubSpot-companies.csv** — 12 new accounts · 3 new contacts · 41 empty fields filled · 9 differences kept
> automatically · 2 differences for Decisions · 1 row skipped (no company name)
> Revenue in this file is read as **USD** [▾] *(only for files without a currency column)*
> [Import] [Cancel]

"Details" (a `<details>`) lists the new accounts and the decisions, so the Team Lead can see what is coming.

### 3.5 Writing (R6.2, R6.4)

1. `safetyCopyBeforeRestore()` → renamed `safetyCopyBefore(reason)`; reason "before-import". Same fresh-
   install skip and fallback question.
2. Inside `withAccountWriteLock`, the plan is **recomputed** against the stored data (a sync may have
   landed while the dialog was open), then written in **batches of 100 accounts**, each batch persisted
   before the next: new workbook rows appended (ids remapped, D4), legacy `targetAccounts` entries **added**
   for new companies only (never rebuilt), overrides via the extras merge with provenance `import`,
   `importFindings` for decisions.
3. Each written override/finding carries `importRun: {id, file, at, by}` on the extra so the team log can
   fold one import into one line per member (2.5).
4. `autoPrioritizeNewCompanies()` for the new accounts only; they join the normal pipeline queue (R6.5).

### 3.6 After (R6.3)

- One pop-up, one OK: the same counts as the check, "2 differences are waiting in Decisions" when any.
- Activity Log: `import_done {format, file, counts}`.
- Team log: team-log.js folds all changes carrying the same `importRun.id` into **one line**: "Boaz
  imported HubSpot-companies.csv: 12 new accounts, 41 fields filled".

---

## 4. Data

### 4.1 New fields on an account extra (`targetAccountExtras[key]`)

```
importFindings:          { globalEmployees: { value: 5000, file: "x.xlsx", at, by, rule, why } }
importFindingsDismissed: { globalEmployees: 5000 }      // "Keep current" answered for that value
importRun:               { id, file, at, by }            // last import that touched this account
```

Both maps merge per field in `extras-merge.js` (same 3-way merge as `overrides` / `webFindingsDismissed`),
so two members' answers cannot clobber each other.

### 4.2 Row source

New rows get `source: "Workbook" | "CSV" | "HubSpot" | "Salesforce"` and `importedAt`. Existing
`"Imported"` (read-time default) stays as the label for old workbook rows; the "Imported" dot shows for all
of them (R2.7).

### 4.3 Settings

`importTolerancePct` (default 10) added to `webFindingsArbitration` — already team-shared, so the Team Lead's
value applies to the team. UI: one field in Change Settings > Advanced > "How to handle research findings":
"Imports: ask only when the difference is more than [10] %".

---

## 5. Decisions (R4)

- `buildDecisionQueue` gets kind **`import_finding`**: id `import:<key>:<field>:<value>`, payload
  `{field, label, current, imported, file, at, by, rule, why}`. Revenue currency is never its own card
  (it follows the amount, as for web findings).
- Card: "Import difference — Employees (worldwide)". Two columns **Current** / **Import** (with the file
  name and date under Import), the rule's reason, buttons **Keep current** / **Use import**. "Apply to
  similar" works as for web findings.
- `applyDecision`: Keep current → `importFindingsDismissed[field] = value`, finding removed. Use import →
  `overrides[field] = value` with provenance `user` (R4.3), finding removed.
- **Routing (R4.2):** in a team the queue includes `import_finding` items only when
  `leadRightsOf(membership, summary)`; members never see them or the red dot for them. Without a team they
  are always included.

---

## 6. Who may import (R5)

- One helper, `mayImport()` (team-groups.js or a small team-roles helper): no team → true; team →
  `leadRightsOf(...)`.
- **Menus:** Import… and Restore… are not rendered for members (left menu on all pages, Target Accounts
  page buttons, Settings > Restore). No greyed-out buttons.
- **Router:** `openActionFromHash` ignores `#action=import` / `restore-accounts` for members.
- **Storage:** the import writer and `restoreFromFile` re-check and refuse with "Only the Team Lead can
  import", so an old tab or a stale page cannot slip through.
- **Restore (R5.3):** the existing team warning stays and now names the Team Lead's responsibility.
- **Import Settings (R5.5):** for members, the team-shared sections (exclusions, relationships, research-
  findings rules, groups) are left out of the section list; personal settings import as today.
- **Export (R5.1):** everyone. All exports read the same visible-rows source as the table, so advanced-mode
  visibility (step 2, Visibility) limits them automatically.

---

## 7. Screens

### 7.1 Export… (Target Accounts; Target Contacts with contacts pre-selected)

One dialog: **Format** (CSV — SalesTeam columns / HubSpot / Salesforce) → **What** (Accounts, Contacts,
Both) → **Rows** (All / Only the rows the table shows — asked only when a filter or search is on) →
**Export**. Then today's one-OK result pop-up (HubSpot and Salesforce say which file to import first).

### 7.2 Import… (Target Accounts, Team Lead / solo only)

One dialog: **What are you importing?** Research workbook (.xlsx) / SalesTeam CSV / HubSpot export /
Salesforce export → **Choose file…** → the check-first summary (3.4) → **Import**. A file that does not look
like the chosen kind says what it looks like ("This looks like a HubSpot contacts export").

### 7.3 Menus

- Left menu, Target Accounts Dashboard group: **Import…**, **Export…** (replacing Import Research
  Workbook…, Export Accounts (CSV), Export to HubSpot…, Import from HubSpot…). Target Contacts group:
  **Export…**. Restore from Backup… leaves the Target Accounts group; it stays in Settings > Restore (D9).
- Routes: `#action=import`, `#action=export` (+ `&what=contacts`); the old action names stay as aliases.
- Leads Dashboard exports, Backup and Restore are unchanged.

---

## 8. Salesforce (R7)

- **Export** (`buildSalesforceFiles`, salesforce.js, pure): two CSVs for the Data Import Wizard.
  - Accounts: Account Name, Website, Industry, Employees, Annual Revenue (converted to the display
    currency), Billing City, Billing Country, Type (Public/Private), Description (SalesTeam priority, LinkedIn
    page, relationship).
  - Contacts: First Name, Last Name, Title, Email, Account Name, Mailing City, Mailing Country, Description
    (LinkedIn profile).
  - Pop-up: "Import Accounts first, then Contacts (match Contacts to Accounts by Account Name)."
- **Import** (`salesforceAccountRows` / `salesforceContactRows`): recognises both labels ("Account Name",
  "Annual Revenue", "Employees", "Billing Country") and API names (`Name`, `AnnualRevenue`,
  `NumberOfEmployees`, `BillingCountry`, `FirstName`, `LastName`, `Account.Name`, `Title`, `Email`), as
  in report exports and Data Loader files.
- Live check needed: Salesforce's Industry is a picklist; free-text industries may be rejected by orgs with
  a restricted picklist. If so, the export leaves Industry out and puts it in Description (decided at test).
- **Salesforce's own sample files (Boaz, 2026-10-09)** fix the column titles. The export writes exactly these,
  in this order, so the Data Import Wizard maps every column by itself; columns SalesTeam has no value for stay
  empty. *Agreed 2026-10-09 (Boaz: all four - Type, revenue currency, Lead Source, Consent Status):*
  - **Accounts:** Account Name, Annual Revenue, Billing Street, Billing City, Billing State/Province, Billing
    Zip/Postal Code, Billing Country, Description, Employees, Fax, Industry, Phone, Shipping Street, Shipping City,
    Shipping State/Province, Shipping Zip/Postal Code, Shipping Country, Type, Website.
    - **Type is the relationship, not Public/Private** (the samples hold Customer / Reseller - Salesforce's
      Account Type list): customer -> Customer, partner -> Partner, everyone else -> Prospect. Public/private goes
      into Description with the priority, LinkedIn page and SalesTeam id.
    - Billing address from the registry address where there is one, else the HQ city and country. Shipping, Phone
      and Fax stay empty.
    - **Annual Revenue is a plain number with no currency in its title** (the wizard would not map
      "Annual Revenue (USD)" by itself), so the export pop-up names the currency (D14), and an import of such a
      file asks for it (D15 case 3).
  - **Contacts:** First Name, Last Name, Email, Phone, Title, Account Name, Mailing Street, Mailing City, Mailing
    State/Province, Mailing Zip/Postal Code, Mailing Country, Lead Source, Consent Status, plus **Description**
    (the LinkedIn profile; the wizard maps it by name).
    - Account Name exactly as in the accounts file, so the wizard links each contact to its account.
    - **Lead Source "Other"**, not "Social": the standard list has no LinkedIn value, and "Other" exists in every
      org.
    - **Consent Status always empty**: SalesTeam never knows whether a person agreed to marketing, and must not
      claim it.
  - Import reads the same titles (and the API names above), so a file exported from Salesforce in this shape comes
    back in as it went out.
- **Built in 1.2.2.16** (pure `crm-files.js`, one column table per CRM - Dynamics adds its own table once the header
  rows are in). Export… and Import… offer Salesforce; files `SalesTeam-Salesforce-accounts/contacts-<stamp>.csv`.
  - **Description holds "Label: value" lines** - priority (with score), company type, LinkedIn page, HQ city, HQ
    country, registry address, `SalesTeam id` (contacts: LinkedIn profile, id) - and Import reads them back. A file
    whose Description carries `SalesTeam id` is SalesTeam's own: its Billing columns were worked out from those lines
    and are not read again, so the HQ round-trips exactly. A Salesforce org's own file: Billing City / Country are read
    as the HQ city / country.
  - **Billing address:** a registry address of the form "street, ZIP city[, state][, country]" is split into the
    Billing columns; its country is the one the address names, else Setup's single target country, else the HQ
    country when the HQ is in the same city, else empty (about 100 accounts hold a Swiss registry address under a
    foreign HQ - a French Billing Country under a Winterthur street would be wrong). An address in no such shape
    leaves Billing Street empty and uses the HQ city and country.
  - Record ids ("Account ID" / "Contact ID" / "Id") become `SF-<id>`; a revenue that names its currency ("USD 1,500,000")
    keeps it, a plain number is asked for (D15 case 3). Industry is written as free text - still to be checked
    against a real org's picklist.
- **First real import (Salesforce Starter trial, 2026-10-10):** 559 of 569 added, 1 skipped, 9 refused. Industry as
  free text was accepted. Fixed in 1.2.2.17: Employees and Annual Revenue are written as whole numbers (six refusals
  for values such as 72.8); Billing State is never written (a canton "VD" is refused for Switzerland when the org's
  state and country lists are on); a city is one city, cut at ";" or "(" and at most 40 characters (PepsiCo's 63-character
  HQ text) - the full text stays in Description; every column is cut to Salesforce's length limit. The other two
  (Luzerner Kantonsspital, Novartis Pharma Schweiz) were Salesforce's own duplicate rule matching another account -
  an org setting, not a file error.
- **Headcount stored as a whole number (Boaz, 2026-10-10).** The six refused Employees values were full-time
  equivalents from annual reports (Swiss National Bank 941.2). Since 1.2.2.17 every way in rounds them before they are
  stored - web findings, imports, hand edits (`wholeEmployees`, value-normalize.js) - and `repairEmployeeDecimals` rounds
  what was stored before, once, on the update (workbook rows, overrides, open import differences; one Activity Log line).

---

## 8a. Microsoft Dynamics 365 Sales (R10) — BUILT in 1.2.2.19, import checked with real files in 1.2.2.20, export check open

- **Built in 1.2.2.19 (2026-10-10)** without the header rows of a real export (Q10 - they had not arrived): the column
  table in `crm-files.js` holds the display names and field names of Dynamics 365 Sales' standard columns, from
  Microsoft's documentation. What differs from the proposal below:
  - **Accounts written:** Account Name, Website, Relationship Type, Number of Employees, Annual Revenue, Address 1:
    Street 1, Address 1: City, Address 1: ZIP/Postal Code, Address 1: Country/Region, Description. The address comes
    from the registry address, as for Salesforce. **Relationship Type** is Customer / Partner / Prospect.
  - **Industry is not written as a column.** It is an option set, and a value outside it stops the row, so the
    industry goes into Description ("Industry: …") and is read back from there. An organisation's own file has its
    Industry column read.
  - **Contacts written:** First Name, Last Name, Job Title, Email, Business Phone, Company Name, Address 1: City,
    Address 1: Country/Region, Description.
  - **No Currency column is written** (it is a lookup by the currency's name in the organisation); the export pop-up
    names the currency, as for Salesforce. On import a Currency column is read by code or by name ("Swiss Franc"); a
    name SalesTeam does not know leaves the question open (D15 case 3).
  - **"(Do Not Modify) Account" / "… Contact"** hold the record's id in an Export to Excel file: kept as the row id
    (`DYN-<id>`), so a second import of the same file matches by it. The other "(Do Not Modify)" columns are ignored.
  - A contacts view with only **Full Name** (Dynamics' default view) is read. A file with nothing but titles both
    CRMs use ("Account Name", "Website") is read as the file type chosen in the Import window.
  - `.xlsx`: `parseFirstSheetRecords` (xlsx-lite.js) reads the first sheet; checked in a browser with a file in the
    shape of Export to Excel (hidden columns, second hidden sheet).
  - Harness: 31 cases (955 in all).
- **Real files, 1.2.2.20 (2026-10-10):** two Export to Excel files of a German organisation ("Meine aktiven Firmen",
  "Meine aktiven Kontakte"). What they showed:
  - **The column titles are in the organisation's language** - "(Nicht ändern) Firma", "Firmenname", "Adresse 1: Ort",
    "Vorname", "Nachname", "Position", "Telefon (geschäftlich)". 1.2.2.19 knew only the English titles and did not
    recognise these files.
  - **The file itself names every column's field.** A very hidden sheet "hiddenSheet" holds one text in cell A1:
    `account:<checksum>:accountid=<title>&name=<title>&address1_city=<title>&…` (titles URL-encoded). `xlsx-lite.js`
    hands that text on as `fieldKey`; `withDynamicsFieldNames` (pure, `crm-files.js`) replaces each title with its
    field name before the file is recognised and read. No list of titles per language is kept.
  - The same title can mean two things: "Firmenname" is `name` in the accounts file and `parentcustomerid` in the
    contacts file. The field names settle it.
  - **Full Name is "Last, First"** in this organisation ("Muster, Anna"): turned round when a view holds only Full
    Name. First Name / Last Name are used when the view has them.
  - A column of a related record ("E-Mail (Primärer Kontakt) (Kontakt)") has a field name with a prefix
    (`<id>.emailaddress1`) and is not read. Custom columns are not read.
  - A contact with no company ("Firmenname" empty) is skipped, as in every import.
  - A CSV file from a Dynamics that is not in English has no hidden sheet and is not recognised - use Export to Excel.
  - Harness: 8 more cases (963 in all); both real files run through the import code.
- **Round trip, 1.2.2.21-1.2.2.23 (2026-10-10):** an export to a Dynamics file, imported again, said "1 empty field
  filled, 84 differences kept as they are". It must say nothing (as for every format). Causes and fixes:
  - Job titles cut to the column limit (100; Salesforce 128) counted as contact differences. `import-merge.js`
    `isStartOf`: a file value that is the start of the current one is not a difference. Nothing is written either
    way - a contact keeps its current value.
  - One person stored twice with the same LinkedIn profile: the file row matched the other entry. `crmContactRows`
    now takes `contactId` from the Description line "SalesTeam id", and `planImport` matches a contact by its own id
    first - only when the name is still that person, since another SalesTeam numbers its contacts the same way.
  - The summary could not say which rows it meant. `importDetailLines` adds a line per Filled / Updated / Kept entry
    to Details.
  - The limits are per CRM; an organisation's own Export to Excel file carries its real limits as data validations
    (Job Title 165 in the files received) - of use if SalesTeam later writes into such a file.
- **Still open - the export (R10.4):** SalesTeam's Dynamics files have English column titles. Does Dynamics' import map
  every column by itself, in particular in an organisation in another language, and take the files without refusals
  (as Salesforce's did only after 1.2.2.17). The real files also show that Dynamics' own **Import from Excel** expects
  the organisation's own exported file (titles in its language plus the hidden sheet) - writing into such a file is a
  possible way to an import with no column mapping at all; not decided.

*The proposal as agreed 2026-10-09:*


- **One module for both CRMs' shape.** Salesforce and Dynamics differ only in column names, so `crm-files.js`
  (pure) holds one column table per CRM - `{ field, label, apiName }` per column - and three functions that take
  the table: `buildCrmFiles(crm, companies, contacts, money)`, `crmAccountRows(crm, records)`,
  `crmContactRows(crm, records)`. Salesforce (section 8) uses the same module; no second copy of the logic.
- **Export** (`buildCrmFiles("dynamics", …)`): two CSVs for Dynamics' Import Data wizard.
  - Accounts: Account Name, Website, Industry, Number of Employees, Annual Revenue (display currency),
    Address 1: City, Address 1: Country/Region, Description (SalesTeam priority, LinkedIn page, relationship).
  - Contacts: First Name, Last Name, Job Title, Email, Business Phone, Company Name, Address 1: City,
    Address 1: Country/Region, Description (LinkedIn profile).
  - Pop-up: "In Dynamics: Import Data — Accounts first, then Contacts (Company Name links each contact)."
- **Import** (`crmAccountRows("dynamics", …)` / `crmContactRows`): recognises display names and field names
  (`name`, `websiteurl`, `numberofemployees`, `revenue`, `address1_city`, `address1_country`, `industrycode`,
  `firstname`, `lastname`, `fullname`, `jobtitle`, `emailaddress1`, `telephone1`, `parentcustomerid`).
  Columns starting "(Do Not Modify)" are skipped. A "Currency" column (ISO code or Dynamics' currency name,
  e.g. "Swiss Franc") is read when present; otherwise D7 applies.
- **.xlsx as well as .csv:** Dynamics' everyday export is "Export to Excel" (.xlsx, one sheet). The Import
  dialog accepts .xlsx for Dynamics and reads the first sheet with the existing `xlsx-lite.js` reader.
- `detectImportFile` learns both CRMs, so a wrong choice still says what the file looks like ("This looks like
  a Dynamics contacts export").
- **Live check:** the header rows of a real Accounts and Contacts export (Q10) fix the column names; Industry is
  an option set in Dynamics (like Salesforce's picklist) - if the wizard rejects free text, the export puts the
  industry in Description instead (decided at test, same as Salesforce).

## 8b. One currency — the default currency everywhere (D13–D15, agreed 2026-10-09)

Boaz, 1.2.2.13 test: revenues should read in one currency - the default one in Change Settings > Advanced >
Revenue & Currency (`revenueNormalization.targetCurrency`, default USD, team-shared: the Team Lead's applies) -
and an import must never read a CHF file as USD.

- **D13 — Shown in the default currency, stored as found.** The Global / Local Revenue cells show the amount
  converted to the default currency (`normalizeMoney`, the rates already used for scoring); the original amount
  and currency are in the cell's tooltip ("from 2.4 m CHF"). The stored value and its currency are never
  rewritten, so changing the default currency later loses nothing. Sorting and filters use the converted amount.
- **D14 — Every export in the default currency, named in the column title.** "Global Revenue (USD)", "Local
  Revenue (USD)" in the SalesTeam CSV (its separate "… Currency" columns are dropped), and the same amounts in
  the HubSpot, Salesforce and Dynamics files, whose revenue column titles carry the currency where the CRM's
  import accepts it (otherwise the export pop-up names it).
- **D15 — An import never guesses a file's currency.** In this order:
  1. a currency column per row (Dynamics' Currency, an older SalesTeam CSV) - each row in its own currency;
  2. a currency in the revenue column title ("Global Revenue (USD)") - that currency;
  3. neither - the check-first summary asks "Revenue in this file is in: [choose…]" with **no pre-selected
     answer**; Import stays disabled until one is chosen (replaces 1.2.2.13's dropdown that defaulted to the
     display currency). Files without revenue figures are not asked.
  - **Plausibility check:** for accounts already holding a revenue, the median ratio file / stored (both
    converted with the chosen currency) is computed; when it sits near an exchange rate instead of near 1 (e.g.
    0.9 for CHF read as USD) the summary warns: "These figures look like CHF, not USD - check the currency."
    Pure (`currencyPlausibility` in csv-import.js), with harness cases.
  - **Built in 1.2.2.15.** Table cells, sorting, text filters and the account page show the default currency, the
    original in the tooltip (account page: "(from … CHF)"); a local revenue without its own currency is in the global
    one. SalesTeam CSV titles "Global Revenue (USD)" / "Local Revenue (USD)" without the "… Currency" columns; the
    HubSpot file keeps the title "Annual Revenue" (HubSpot maps it by that exact name) and the export pop-up says
    "Annual Revenue is in USD". The currency question is its own small pop-up right after the file is read (before
    the check-first summary), so the plausibility warning shows as soon as a currency is picked; it is asked for the
    research workbook too, and not for a value that names its currency ("CHF 102m"). The Import window's dropdown
    is gone.
- **D16 — Revenue written without its unit (millions / billions).** Found in the 1.2.2.13 HubSpot export: seven
  accounts held revenues such as Cornèr Bank 491.1 CHF, Metrohm 400 CHF, ISS Schweiz 914 CHF, Lindt & Sprüngli
  Schweiz 5.92 CHF - all from web research answers that lost "million"/"billion". The arbitration's units rule
  only fires on a *pair* (stored against found); into an empty field a lone value was filled as it came.
  - **Check (pure, `revenueUnitsCheck`):** revenue per employee, using the larger of the employee count and the
    **targeting minimum** - the low end of the smallest size band ticked in Setup (`targetUniverseConfig.sizeBuckets`
    against `SIZE_PRIORITY_BUCKETS`: 201 when 201-500 is the smallest ticked, 1,001 when it is 1,001-5,000; Boaz
    2026-10-09: never a fixed 200) - so it works even when the headcount is missing or wrong. When the smallest
    ticked band starts at 0 (0-200), only a real employee count is used, and an account without one is not judged. Below 10,000 per employee per year (in the default currency) the value is impossible for a company in
    scope. The likely unit is the one of ×1,000 / ×1,000,000 / ×1,000,000,000 that puts revenue per employee
    between 20,000 and 2,000,000 (Lindt 5.92 → 5.92 bn; Cornèr 491.1 → 491.1 m); none fits → no suggestion.
  - **Going forward:** a web finding, import or edit that would *fill* such a value is not written; it becomes a
    Decisions card instead.
  - **Existing data:** each account already holding such a value gets a Decisions card - "Revenue 491.1 CHF looks
    like it is in millions → 491.1 million CHF?" - **Correct it** / **Keep**. Nothing is changed without an answer.
  - An account below the targeting minimum with a credible tiny revenue (HT5 AG: an empty holding, 0 employees) is
    out of scope rather than a units error - the card offers **Remove account** as well.
  - **Built in 1.2.2.14.** Pure `revenueUnitsCheck` and `targetingMinimum` in value-normalize.js (local revenue is
    judged only against a real local headcount). Decisions kind "Revenue without its unit", one card per value, from
    three places: a stored value (**Correct it** / **Keep** - Keep remembers the value), a web finding for an empty
    field and an import (**Correct it** / **Don't use it**); **Remove account** only when the real headcount is below
    the targeting minimum, and no unit is suggested when the value is credible for that headcount (HT5 AG).
    "Also for the others" groups cards with the same origin and unit. Web fills (pipeline, bulk research, automatic
    resolve) and imports hold such a value and its currency back. A hand edit is not blocked: a value typed without
    its unit shows up as a card right after Save. Checked against the 9 Oct export: exactly the 7 accounts + HT5 AG
    of 570 are flagged.

## 9. Research workbook specifics

- Workbook rows that match an existing account go through the plan like any other format — **no row is
  replaced**. Rows for companies SalesTeam does not have are added.
- Initiatives / investment / sources: added when new (by company + name / id), never removed — same as
  `addWebResearchInitiatives`.
- Aliases: new aliases added to the account; existing kept.
- `Excluded = Yes` (Q4): copied onto the exclusion list **only for companies the import adds**; an existing
  account is never hidden by an import. The relationships migration still runs (Team Lead only).
- Legacy `targetAccounts` map: entries added for new companies; existing entries untouched (no rebuild).
- `targetAccountsWorkbookImportedAt` still set (personal key).

---

## 10. Build steps

| Step | Build | Content |
|---|---|---|
| 0 | next 1.2.2.x | `import-merge.js` (pure) + harness cases; workbook import goes through it (add-and-fill, id remap, no legacy-map rebuild, exclusions only for new companies); `importFindings` + Decisions kind `import_finding` with Team Lead routing; `importTolerancePct` + Advanced field; dead `buildAutoBackup` removed. **Removes the data loss on its own.** |
| 1 | +1 | Check-first summary, `safetyCopyBefore("before-import")`, batched writes, result pop-up, Activity Log, `importRun` + one team-log line; `mayImport()` gating of Import, Restore and team-shared Import Settings sections |
| 2 | +1 | One Export… / Import… dialogs and menus (all pages), routes + aliases; SalesTeam CSV import; HubSpot import through the plan (fills gaps on existing accounts) |
| 3 | +1 | Salesforce **and Microsoft Dynamics** export and import (one pure `crm-files.js` + harness cases); Dynamics .xlsx import; **one currency (8b, D13–D15)**; **revenue units check + Decisions (D16)**; live checks (Salesforce dev org; Dynamics header rows or trial, Q10) |
| 4 | — | Help "Export and import", PRD section, release notes (1.2.3) |

Each step: `check_js_syntax.py`, `test_pure_modules.py`, `test_team_sync.py` (step 0–1: a two-member case —
member's import refused, Lead's import reaches the member without deleting the member's web-found rows).

---

## 11. Decisions — agreed 2026-10-09, all as proposed

- **D1** Fills and accepted import values are written as **overrides** (like web research), never into the
  original workbook rows. *Proposed.*
- **D2** Import differences are stored on the account (`importFindings`) and shown in Decisions as their own
  kind, Team Lead + deputy only. *Proposed.*
- **D3** "Within 10%" is checked **before** the rules, for every numeric field — so nothing within 10% ever
  reaches Decisions, whatever the rule switches say. *Proposed.*
- **D4** A new row whose id is already used by another company gets a fresh id (protects team rows).
  *Proposed.*
- **D5** Check-first summary before every import, with an optional details list. *Proposed.*
- **D6** One team-log line per import instead of one line per account. *Proposed.*
- **D7** Files without a currency column: revenue read as the display currency, changeable in the check-first
  dialog. *Proposed.*
- **D8** The import tolerance lives with the research-findings settings (team-shared, Team Lead's value
  applies). *Proposed.*
- **D9** "Restore from Backup…" leaves the Target Accounts menu group; Restore stays in Settings. *Proposed.*
- **D10** Build order: this item's step 0 **before** advanced-mode step 2 (Visibility), because step 0
  stops a real data loss. *Proposed.*

### Added 2026-10-09 — PROPOSED

- **D11** Salesforce and Dynamics share one pure module (`crm-files.js`) with a column table per CRM, instead of
  a `salesforce.js` and a `dynamics.js` with the same logic twice. A third CRM later is one more table.
- **D12** The Dynamics import reads its own "Export to Excel" .xlsx directly (no "save as CSV first" step for
  the user).
- **D13–D15** One currency: shown and exported in the default currency, an import never guesses (section 8b).
- **D16** Revenue written without its unit: checked against the targeting minimum, fixed only through Decisions
  (section 8b). *Agreed 2026-10-09.*
- *D11–D15 agreed 2026-10-09 (Boaz: Dynamics 365 Sales, same step as Salesforce, currency as proposed).*
