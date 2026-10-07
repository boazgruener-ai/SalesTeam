# SalesTeam — Exclusions & Relationships: Design

Target release: **1.2.3** (test builds 1.2.2.1, 1.2.2.2 …)
Status: **Design — agreed 2026-10-06.** Boaz agreed to D1–D8 as proposed (section 11).
Date: 2026-10-06
Builds on: `EXCLUSIONS_RELATIONSHIPS_REQUIREMENTS.md` (agreed 2026-10-06). Requirement numbers (R2.3, R5.4 …)
refer to it.

---

## 1. The design in one page

1. **A second list next to the exclusions.** Customers and partners move out of `companyExclusions` into a
   new stored list, `companyRelationships`, with exactly the same entry shape (`category`, `slug`, `name`,
   `domain`, `source`, `sourceUrl`) and the same matching (LinkedIn page, normalised name or website domain).
   Because every one of the ~20 places that hide excluded companies reads `companyExclusions`, moving the
   entries out is what makes those accounts reappear — none of those places has to change (section 3).
2. **The exclusion matcher ignores customer/partner even if they are still there.** `getExclusionMatcher`
   builds only from Competitor / Recruiter / Other entries. A customer entry left in `companyExclusions` (an
   old backup, a team member before the Team Admin has migrated) is therefore already harmless, and the
   relationship matcher reads it too. Migration is a tidy-up, not a switch that must happen at the right
   moment (section 4).
3. **The workbook's Excluded = Yes is overridden by a relationship**, the same way `companyExclusionsLifted`
   overrides it today: a row that matches a Customers / Partners entry is not hidden. The import never has
   to rewrite rows, and a re-import keeps working (section 4.3).
4. **Priority is raised when it is read, not when it is stored.** The stored AI priority is unchanged; one
   pure function, `effectivePriority`, raises a customer's priority by one level wherever priority is shown
   or used, unless the user set it by hand. Removing the Customer tag removes the raise at once, with no
   re-scoring (section 6).
5. **The tag is computed, never stored on the account.** Every screen asks the relationship matcher
   ("is this company on the lists?"). An account discovered later gets its tag the moment it exists (R2.3).
6. **One table component for all five lists.** A new `company-list-table.js` draws Competitors, Recruiters,
   Other (step "Companies to exclude") and Customers, Partners (new step "Customers and partners") with sort,
   search, count, + Add and a row ⋮ (Edit, Remove, Move to…). Both steps edit one draft of all five lists;
   Save on either step writes both keys (section 8).
7. **The AI is told** through the existing shared prompt blocks: one line in the account overview, the lead
   block and the outreach draft (section 7).

---

## 2. What the code review found

### 2.1 Exclusions today

- `EXCLUSION_CATEGORIES = ["competitor","recruiter","customer","partner","other"]` (storage.js:600), labels
  at :602-608, key `companyExclusions` (:610). Entry shape `{ slug?, name?, domain?, category, source?,
  sourceUrl? }`.
- `getCompanyExclusions()` (:659) runs a one-time legacy migration (flag `companyExclusionsMigrated`, which
  also seeds the 15 recruiters once — so a removed recruiter is never re-seeded; **R4.8 already holds**).
- `saveCompanyExclusions()` (:683) also maintains `companyExclusionsLifted` (slugs the user removed, which
  then override the workbook's Excluded flag). None of these use `withAccountWriteLock`.
- `buildExclusionMatcher(exclusions, lifted)` (company-identity.js:44) returns slug / name / domain Sets —
  **it drops the category**. `isCompanyRowExcluded(row, matcher)` (storage.js:712) applies the workbook flag
  (unless lifted) and then the matcher.
- Callers that hide an excluded company: Target Accounts `loadWorkbook` (target-accounts.js:3513), side
  panel counts (sidepanel.js:65), contact finding (storage.js:2054), size lookup (:2143), prioritisation
  scope (:3717), lead → account matching (:4072), `getAccountViews` → `view.excluded` (:4984/5005, read by
  pipeline-runner, pipeline-plan, readiness, decision-rules, web-lane, readiness/targets counts), LinkedIn
  Discovery (company-discovery-extraction.js:513), web discovery (web-discovery.js:176/276,
  discovery-filter.js:154), the wizard's match preview (onboarding.js:1204). **None reads the category**,
  which is why one list split into two is enough.

### 2.2 Import

`backfillCompanyExclusionsFromWorkbook` (storage.js:755, called at target-accounts.js:4422 after an import)
joins the workbook's Exclusion_List to rows with Excluded = Yes, maps `Exclusion_Reason` through
`EXCLUSION_REASON_TO_CATEGORY` (:731) and adds `{slug, category}` — slug only; rows without a LinkedIn link
are skipped. The Python side (`sheet_contract.py` `EXCLUSION_REASONS`, `validate_workbook.py`, the research
prompt) keeps Customer / Partner as valid reasons; only their meaning changes.

### 2.3 Lead filters

`builtin-customers` and `builtin-partners` (storage.js:2461/2472) are Negative Topics with `sourceList`
"customers" / "partners", filled from exclusion entries by `applyWizardSourceLists` (:2543). `getNegativeTopics`
(:2560) re-adds any missing built-in topic from `DEFAULT_NEGATIVE_TOPICS`, so the two must be removed from
the defaults **and** from the stored list. `applyNegativeTopicsToResultsMap` (:2786) re-applies filters in
both directions and puts leads back to "New" when nothing matches any more — the mechanism that brings back
leads hidden as "Existing Customers (matched …)". Labels in scanner.js:1197-1203.

### 2.4 Priority

- Computed by `prioritizeCompanies` (agent-shared.js:875): imported-confident → P1/P2, insufficient
  evidence → P5, otherwise a score bucketed by `bucketCompanyScore` (storage.js:3661: ≥85 P1, 70-84 P2,
  50-69 P3, <50 P4).
- Stored on the workbook row: `salesTeamPriority`, `…Score`, `…Reason`, `…ScoredAt` (:3743).
- Manual: `targetAccountExtras[key].overrides.salesTeamPriority` (+ `…Reason`); presence = set by hand.
- `getAccountViews` (storage.js:5001) is the one effective getter, read by pipeline order, Ready selection,
  scannable scope (readiness.js:288, P1–P3), web plan (pipeline-plan.js:232), decision queue. **Bypasses**
  that read row/override directly: target-accounts.js:700/1245 (pill), :3151 (range counts), :5844 (bulk),
  :6809 (HubSpot export scope); storage.js:4090 (lead matching → `accountConfidenceRank` :1563);
  hubspot.js:136; csv-export.js:30-32.

### 2.5 AI prompts (agent-shared.js)

- `accountOverviewBlock(company)` (:288) feeds the account- and contact-scoped Mentor and Customer Voice
  prompts (:307/323/353/373), wired from target-accounts.js via `currentAccountCompanyRow()`.
- `buildLeadScopedMentorPrompt` (:227) and `buildDraftPrompt` (:464, via `generateDraft` from
  dashboard.js:2089 and `toolDraftMessage` :1331) carry no account facts today.
- General Mentor sees leads through `toolListLeads` / `toolGetLeadDetails` (:1247/1282).

### 2.6 Screens

- Wizard: `ALL_STEPS` (onboarding.js:79) — first setup has 12 basic steps; `exclusions` is 11th, between
  `included` and `targets`. The step is five textareas parsed by `parseExclusionLine` (:1020); research
  proposals render as a tick list (`mountChecklist`, proposal-ui.js:113).
- **Bug found:** a proposal's checkbox `change` handler (proposal-ui.js:127) updates the item but never calls
  `opts.onChange`, so ticking / unticking a proposal does not run `syncExclusionTicks`; only "Add" and the
  rank arrows do. Fixed in step 3.
- No shared sortable / searchable table exists (the offers table has no sort, search or ⋮).
- Row ⋮: `accountMenuItems()` (target-accounts.js:2147) is the one builder for list row and page ⋮;
  admin-only items are added conditionally (hidden for members).
- Target Accounts columns: `COMPANY_COLUMNS` (:693); computed columns via `rawValue` / `renderCellContent`
  / `sortValue`. **Column filters are text-only** (`{text, exclude}`, :564). The id `targetCountryRelationship`
  ("Local / Global", :718) already exists — the new column is `relationship`.
- Leads Dashboard `companyCell` (dashboard.js:725) only has `lead.company`; no account data is loaded.
- Team: admin-only is enforced in the UI (`applyTeamMemberReadOnly`, onboarding.js:3078;
  `teamAccounts.isAdmin()`), not by the sync layer.

### 2.7 Step 0 as built (1.2.2.1, 2026-10-06)

- New pure `relationships.js` (`splitCompanyLists`, `raisePriority`, `effectivePriority`, `relationshipPromptLine`,
  `relationshipTagText`); company-identity.js: `buildExclusionMatcher` skips customer / partner and carries a `kept`
  relationship matcher, new `buildRelationshipMatcher`, `relationshipOf`, `matchesRelationship`. 52 new checks
  (676 in all); team-sync harness 125 checks unchanged.
- storage.js: `companyRelationships` with `get` / `save`, `saveCompanyLists`, `getRelationshipMatcher`;
  `getExclusionMatcher` passes the relationship matcher, so `isCompanyRowExcluded` lets a customer / partner
  through the workbook's Excluded flag. `EXCLUSION_CATEGORIES` is now competitor / recruiter / other.
- `migrateCompanyRelationshipsIfNeeded` runs on update (then one pipeline kick), at the end of
  `restoreFullBackup` and after the import backfill (which now puts Customer / Partner reasons on the new list,
  by slug, name or website). It writes the lists directly - a moved slug is not "lifted". Activity Log
  `relationships_migrated`; one-time pop-up on Target Accounts (key `relationshipsMigrationNotice`, personal).
- Team: list key appended in team-keys.js; backup wizard keys and the Decisions watch lists include it.
- **Interim until step 3:** the Setup step keeps its five boxes; the customer and partner boxes read and save the
  new list (`saveCompanyLists`). `parseCompanyListEntry` (3.2) moves to step 3, with the table that uses it.
- **Dry run on Boaz's backup of 2026-10-06 18:03 (1.2.1.11):** 41 exclusion entries (29 competitors, 11
  recruiters, 1 partner); one moves - IBM (partner, by LinkedIn slug), which is not an account, so no account comes
  back. The workbook's 10 Excluded = Yes rows are all Competitor. No lead is hidden by the customer / partner
  filters. So the live check on this data is small: IBM shows on the new list, nothing else changes.
- **Live check passed 2026-10-07** (Reload on the live install): pop-up shown once, account count unchanged,
  Activity Log line, IBM kept in the partner box across a Save. To fix in step 1: the pop-up says "it is now an
  account" even when the moved company is not one of the accounts (IBM).

### 2.8 Step 1 as built (1.2.2.2, 2026-10-07)

- Lead filters: `builtin-customers` / `builtin-partners` removed from the defaults and dropped from a stored list on
  its next read (`RETIRED_NEGATIVE_TOPIC_IDS`); the Scanner's two checkboxes are gone. On update,
  `restoreRelationshipFilteredLeads` re-judges **only** the leads whose Irrelevant reason starts "Existing
  Customers / Partners" against the current filters (other leads never move) and counts them into the pop-up.
- Priority: `accountPriorityFor(row, extra, relMatcher)` in storage.js (base, effective, raised, manual,
  relationship) feeds `getAccountViews` (`salesTeamPriority` is the effective value; `basePriority`,
  `priorityRaised`, `relationship` added) and lead matching in `partitionLeadsByTargetAccount`. Target Accounts
  uses it for the Priority column, the priority pie, bulk edit, the HubSpot export (scope and exported value, D4) and
  the account page (raised priority + "Raised one level: existing customer" line in the reason). The CSV table export
  follows the column. Backups keep the stored value.
- AI: `relationshipPromptLine` in the account overview (account / contact Mentor and Customer Voice), the lead Mentor
  (Leads Dashboard), every outreach draft (`generateDraft` looks the company up itself) and the general Mentor's lead
  list (`relationship` field).
- Pop-up text moved into relationships.js (`relationshipsMovedText`, tested): it now counts the accounts that really
  come back and says "None of them is one of your accounts" otherwise (the IBM case), plus leads restored.
- Help: the Negative Topics entry no longer names the two filters. 681 pure checks, 125 team-sync checks.
- **Live check passed 2026-10-07:** Scanner checkboxes gone; a P3 account added as customer showed P2 with the
  reason line, the Mentor called it an existing customer, and removing it brought P3 back.

### 2.9 Step 2 as built (1.2.2.3, 2026-10-07)

- Tag `.relationship-tag` (purple outline pill; same style in dashboard.css): account page between the title and the
  ⋮ (`#account-relationship-tag`), contact page beside the Company field, Target Contacts company cell (after the
  team badge), Leads Dashboard Company column (matcher loaded at init, reloaded when either list key changes).
- Target Accounts column `relationship` ("Relationship", shown by default, right after Priority). Column definitions
  can now carry `filterOptions` + `filterMatch`: the header menu then shows Any / Customer / Partner / None radio
  buttons (applied on click), stored as `{ choice }` in the same `columnFilters`, with the usual chip, `col-filtered`
  mark and Clear all (D5). The CSV table export gets the column.
- ⋮ "Relationship…" after "Merge…" (no team, or the Team Admin): `#relationship-dialog` with two checkboxes and an
  explicit Save; `setAccountRelationship` (storage.js) adds an entry (slug, name, domain, `source: "account"`) or
  removes every entry of that category matching the account (also leftovers on the exclusion list); a pop-up only
  when more than one entry was removed. Activity Log `account_relationship_changed`.
- **Live check passed 2026-10-07** (Boaz, Chrome): column, tags (Customer, Customer · Partner), choice filter + chip,
  ⋮ Relationship… on list row and account page, P3 -> P2 and back.

### 2.10 Step 3 as built (1.2.2.4, 2026-10-07)

- New `company-list-table.js` (DOM): one list as a table - Company, LinkedIn page, Website; A-Z; search; count;
  + Add / Edit as an inline row (OK / Cancel, Enter / Escape) validated by the pure `parseCompanyListEntry`
  (company-identity.js, with `linkedinCompanySlug` and `sameCompanyEntry`); row ⋮ Edit, Remove, Move to (the other
  four lists); a nameless entry shows its slug or domain greyed; "found by research" link; red flag row (D2).
- Setup: "Companies to exclude" = Competitors, Recruiters / staffing agencies, Other; new step **"Customers and
  partners"** (`relationships`, right after it) = Customers, Partners / resellers. Both edit the one draft
  `companyExclusions`; Save on either writes both lists (`saveCompanyLists`, D7). The five textareas and the line
  parser are gone. Save is refused while a row is being edited.
- Proposals: setup-proposals.js now builds `exclusions` (competitors) and `relationships` (customers, partners) from
  one pass (a company named twice is still proposed once); a research stored before 1.2.3 is split on the fly
  (`stepProposal`). Ticks add / remove the company in its table; **proposal-ui.js fix**: a tick now calls `onChange`.
- Team member (R4.7): no + Add and no ⋮ (tables re-drawn once the read-only check has run).
- Checked in a new browser stand-in (scratchpad shim: fake `chrome.*` seeded from the 2026-10-06 backup; launch.json
  "st-shim"): load, Add with a bad LinkedIn link refused, Move to Customers + Save writes the right lists (IBM kept),
  flag on both rows, Edit, search, member read-only, old research split and tick-to-table. 693 pure checks.
- **Live check passed 2026-10-07** (Boaz, Chrome): tables, search, + Add, Move to Customers across the steps + Save,
  Remove. Note from the test: "Move to" is a heading in the row menu, not an item - say so in test steps and Help.

---

## 3. Data

### 3.1 The new key

```
companyRelationships: [
  { category: "customer" | "partner", slug?, name?, domain?, source?, sourceUrl? }
]
```

- At least one of slug / name / domain, as for exclusions. A company that is both customer and partner has
  two entries (one per category) — so "Move to…" and team merging stay one-row operations.
- `RELATIONSHIP_CATEGORIES = ["customer","partner"]`, labels "Customer", "Partner / reseller".
- `EXCLUSION_CATEGORIES` becomes `["competitor","recruiter","other"]`; the old values are kept in a
  `LEGACY_RELATIONSHIP_CATEGORIES` set used only by the migration and the matchers.
- Storage functions (storage.js, next to the exclusion ones): `getCompanyRelationships()`,
  `saveCompanyRelationships(list)`, `getRelationshipMatcher()`, and `saveCompanyLists({exclusions,
  relationships})` that writes both keys in one `set` (used by the wizard and Move to…).

### 3.2 Matchers (pure, company-identity.js)

- `buildExclusionMatcher(exclusions, lifted)` gains one filter: entries whose category is customer / partner
  are skipped. That single line makes every hiding place in 2.1 ignore them.
- New `buildRelationshipMatcher(relationships, legacyExclusions)` → `{ customer: {slugs,names,domains},
  partner: {…} }` from `companyRelationships` **plus** any customer / partner entries still in
  `companyExclusions`.
- New `relationshipOf(matcher, {slug, name, website})` → `[]`, `["customer"]`, `["partner"]` or both.
- `parseExclusionLine` moves from onboarding.js into company-identity.js as `parseCompanyListEntry(name,
  linkedin, website)` (refuses a LinkedIn link that is not a company page, normalises the domain) so the
  table and the ⋮ dialog share it and it is tested.

### 3.3 Team

- `team-keys.js` `TEAM_LIST_KEYS` gains `{ key: "companyRelationships", e: "setting", prefix:
  "companyRelationships:", identity: ["category","slug","name","domain"] }` — appended, so the tests that
  assume `TEAM_LIST_KEYS[0]` is `companyExclusions` keep passing. `TEAM_SHARED_KEYS` and `rowTarget` pick it
  up automatically.
- Also add the key to `full-backup.js` wizard keys (:42), `decisions.js:17` and `decisions-dot.js:10`.
- Who may change it: Team Admin only, enforced in the UI like exclusions (R2.5, R4.7).

---

## 4. Migration and import (R3)

### 4.1 Moving the entries

Pure `splitCompanyLists(exclusions, relationships)` (new pure module `relationships.js`) → `{ exclusions,
relationships, moved: {customer, partner} }`: every customer / partner entry leaves `exclusions` and is
added to `relationships` unless an equal entry is already there. **Idempotent and flag-free**: running it on
already-migrated data changes nothing, so it is safe to run whenever, including after a restore.

It runs in `migrateCompanyRelationshipsIfNeeded()` (storage.js), called:

- from `background.js` `onInstalled` (reason `update`), next to `repairListingRevenueInMillions`;
- at the end of `restoreFullBackup` (full-backup.js:233 — no post-restore hook exists today; one call is
  added) (R3.5);
- after `backfillCompanyExclusionsFromWorkbook` (4.3).

When it moves something it also:

1. removes `builtin-customers` / `builtin-partners` from the stored `negativeTopics` (and from
   `DEFAULT_NEGATIVE_TOPICS`, so the backfill does not re-add them) and runs
   `applyNegativeTopicsToResultsMap` once — leads hidden by those filters come back as "New" (R5.1);
2. writes one Activity Log line, action `relationships_migrated`, with the counts;
3. shows the finish pop-up text (R3.2): "12 customers and 3 partners are no longer excluded — they are now
   accounts with a Relationship tag. 41 leads from their people are back in the Leads Dashboard.";
4. kicks the pipeline once. The accounts join the normal queue in priority order — no burst (R3.2). They
   were never prioritised (excluded from `getCompaniesForPrioritization`), so the pipeline's local re-score
   (`rescoreDerivedPriorities`) gives them a priority on its next run.

Step 1 removes the negative topics even when nothing moves (a user with no customer entries still has the
two empty filters in the scanner list).

### 4.2 Team (R3.4)

The migration runs only with no team or when `teamMembership.role === "admin"`. A member's copy needs nothing:
its exclusion matcher already ignores customer / partner entries (3.2) and its relationship matcher already
reads them, so tags and visibility are right before the admin's migration arrives. When the admin migrates,
the sync layer carries "row removed from `companyExclusions`, row added to `companyRelationships`" like any
other edit. A member's own pre-team entries are carried the same way when they join (they go through the
same list merge as today's exclusions).

### 4.3 Workbook import (R3.3)

- `backfillCompanyExclusionsFromWorkbook`: a reason of Customer / Partner adds the entry to
  `companyRelationships` instead. Because relationships need no LinkedIn link, such rows also use the row's
  name and website when there is no slug (today's slug-only rule stays for exclusions).
- `isCompanyRowExcluded`: the workbook's Excluded = Yes is ignored when the row matches the relationship
  matcher — the same override that `lifted` gives today. So a re-import that brings back Excluded = Yes keeps
  the customer visible.
- Python: no contract change; `validate_workbook.py`'s message and the research prompt's wording ("Customer /
  Partner rows are kept as accounts and tagged") are updated in step 4.

---

## 5. Downstream (R5)

- **Hiding:** unchanged code; customers / partners are no longer in the exclusion matcher (R1.2, R2.2).
- **Discovery (R5.3):** follows automatically — LinkedIn and web discovery use the exclusion matcher.
- **Readiness, targets, Ready selection, team assignment:** follow automatically through `view.excluded`.
- **Lead filters (R5.1):** removed (4.1); scanner.js labels for `customers` / `partners` removed.
  `partitionLeadsByTargetAccount` treats a customer's lead as a target-account match (it no longer excludes).

---

## 6. Customer priority raise (R5.4)

### 6.1 The rule (pure, relationships.js)

```
raisePriority("P1") = "P1"; "P2" -> "P1"; "P3" -> "P2"; "P4" -> "P3"; "P5" -> "P4"   (D3)
effectivePriority({ priority, manual, relationship }) =
    manual || !relationship.includes("customer") ? { priority, raised: false }
                                                 : { priority: raisePriority(priority), raised: priority !== "P1" }
RAISED_REASON = "Raised one level: existing customer"
```

A partner only is neutral. No priority yet → nothing to raise.

### 6.2 Where it applies

- `getAccountViews` computes `view.relationship` (from the matcher) and sets `view.salesTeamPriority` to the
  effective value, keeping `view.basePriority` and `view.priorityRaised`. Pipeline order, Ready selection,
  scannable scope, web plan and the decision queue all read the view, so they follow (R5.4 "counts
  everywhere").
- The bypasses in 2.4 are routed through one helper `accountPriority(row, extra, relMatcher)` in storage.js:
  the Target Accounts pill and range counts, bulk edit's current value, lead matching
  (`evaluateTargetAccountMatch` → `accountConfidenceRank`), HubSpot export, CSV export (D4).
- `getCompaniesForPrioritization` and the scoring itself keep using the **stored** priority — the raise is
  never written, so it is never raised twice and never sticks after the tag is removed.
- The priority reason shown in the account page and the column tooltip gets `RAISED_REASON` as an extra line
  when `priorityRaised`.
- A manual priority (`overrides.salesTeamPriority`) is shown as set — no raise, no line.

---

## 7. AI context (R5.2)

One sentence, built by `relationshipPromptLine(relationship, sellerCompanyName)` in relationships.js:

- Customer: "Relationship: {Company} is an existing customer of {seller}. Do not write or advise as if this
  were a first contact; build on the existing relationship (more departments, further offers, renewal)."
- Partner: "Relationship: {Company} is an existing partner / reseller of {seller} — a company you work with,
  not a cold prospect."
- Both: the two combined.

Inserted in:

- `accountOverviewBlock` (agent-shared.js:288) → account and contact Mentor + Customer Voice prompts.
  `currentAccountCompanyRow()` / `currentContactAccountRow()` add `relationship` from the view.
- `buildLeadScopedMentorPrompt` (:227) and `buildDraftPrompt` (:464): a new optional `relationship`
  argument, looked up by the Leads Dashboard (dashboard.js:2089, :2188) and by `toolDraftMessage` (:1331).
- `toolListLeads` / `toolGetLeadDetails`: a `relationship` field per lead, so the general Mentor knows too.

---

## 8. Screens

### 8.1 The tag (R2.4)

- Pill `.relationship-tag` ("Customer", "Partner", "Customer · Partner"), styled like the existing small
  outline pills (`.readiness-web-only-tag`), in a colour of its own.
- Account page: between `h2#account-title` and the ⋮ (target-accounts.html:452).
- Contact page: next to the Company field (target-accounts.js:6551); Target Contacts list: next to the team
  badge in the company cell (:2931).
- Leads Dashboard: `companyCell` (dashboard.js:725) after the team badge. The dashboard loads
  `getRelationshipMatcher()` once and redraws on `onChanged` of either list key; lookup by
  `normalizeCompanyName(lead.company)`, plus the slug when the lead carries a company link.

### 8.2 Target Accounts column and filter

- `COMPANY_COLUMNS` gains `{ id: "relationship", label: "Relationship", visible: true }`, a computed column
  (`rawValue` / `renderCellContent` draws the pill / `sortValue`).
- Column filters are text-only today. The column menu gets a second filter kind, **choice**: a column with
  `filterOptions` shows radio buttons (Any / Customer / Partner / None) instead of the text box. Stored in
  `columnFilters` as `{choice}`, shown as a chip ("Relationship: Customer"), marked `th.col-filtered`,
  cleared by Clear all — so it behaves like every other filter (D5).

### 8.3 ⋮ "Relationship…" (R2.5)

- `accountMenuItems` adds "Relationship…" after "Merge…", only when there is no team or the user is the
  Team Admin (hidden for members, like the other admin items). Same builder → same in list row and page ⋮.
- Dialog: two checkboxes, Customer and Partner / reseller, pre-ticked from the matcher, explicit Save.
- Ticking adds an entry `{category, slug (from the account's LinkedIn link), name, domain (from its
  website), source: "account"}`; unticking removes **every** entry of that category that matches the account
  (it may have been added by slug, name or domain), and says so if it was more than one.

---

## 9. Setup: the two table steps (R4)

### 9.1 Steps

- `ALL_STEPS` gains `relationships` right after `exclusions`, in the basic steps: first setup becomes 13
  steps (Onboarding progress counts follow `STEP_ORDER`). Title "Customers and partners"; the exclusions step
  keeps "Companies to exclude".
- `STEP_VALIDATORS` and `persistStep` get the new id; both steps save through `saveCompanyLists`.

### 9.2 The table component (`company-list-table.js`, new)

`mountCompanyListTable(el, { listId, label, draft, otherLists, readOnly, onChange })`:

- Columns **Company**, **LinkedIn page**, **Website**; rows sorted A–Z by company; search box (by name);
  heading with count ("Competitors — 14").
- **+ Add** opens an empty row in edit mode; Save row / Cancel; validation by `parseCompanyListEntry`
  (message under the row, as today).
- Row **⋮**: **Edit** (row to edit mode), **Remove**, **Move to…** (sub-list of the other four lists).
- A research-found row shows a small "source" link (`sourceUrl`).
- A company on an exclusion list **and** on Customers / Partners gets a red flag on both rows ("also on
  Competitors — it stays hidden while it is excluded") (D2).
- `readOnly` (team member): no + Add, no ⋮, note "Only the Team Admin can change this" (R4.7).

### 9.3 One draft for both steps (D7)

The wizard keeps one in-memory draft `{competitor, recruiter, other, customer, partner}`, loaded from both
keys. Either step's Save validates and writes **both** keys in one `saveCompanyLists` call, and clears the
dirty mark of both steps. A Move to… a list on the other step says "Moved to Customers (next step) — saved
when you press Save". Leaving with unsaved changes asks, as everywhere (R4.6). The five textareas and their
parsed-list divs go; `companyExclusionsLifted` keeps being maintained by `saveCompanyExclusions` (a removed
slug still overrides the workbook flag).

### 9.4 Research proposals (R4.5)

Kept as the tick list above the tables (D6): competitors on the exclusions step, customers and partners on
the new step (`EXCLUSION_KEYS` in setup-proposals.js is split; the categories stay). Ticking adds the row to
its table marked "proposed", unticking removes it; the proposal-ui.js bug in 2.6 is fixed by calling
`changed()` in the checkbox handler. The first setup pre-fill (ticked proposals straight into the tables)
works as today.

---

## 10. Build steps

| Step | Content | Build |
|---|---|---|
| 0 | Data: `companyRelationships` key + storage functions; `relationships.js` (pure: `splitCompanyLists`, `raisePriority`, `effectivePriority`, `relationshipPromptLine`) and matcher changes in company-identity.js, all tested in `test_pure_modules.py`; team key, backup, decisions lists; migration (update, restore, import) with log line and pop-up; workbook flag override. **Dry run on the latest backup first: how many customers / partners move, how many accounts and leads come back.** | 1.2.2.1 |
| 1 | Downstream: negative topics removed + leads restored, `partitionLeadsByTargetAccount`, priority raise in `getAccountViews` + the bypasses, reason line, AI prompt lines | 1.2.2.2 |
| 2 | Display: tag on account / contact / Contacts list / Leads Dashboard; Relationship column + choice filter; ⋮ Relationship… | 1.2.2.3 |
| 3 | Setup: `company-list-table.js`, the two steps, one draft, proposals into tables, tick-sync fix, team read-only (as built: 2.10) | 1.2.2.4 |
| 4 | Help (Exclusions entry updated, new "Customers and partners"), PRD section + gen_docs mirror, release notes, workbook prompt/validator wording, listing/website check (R6) → **1.2.3** | 1.2.3 |

Each step: `check_js_syntax.py`, `test_pure_modules.py`, `test_team_sync.py` (steps 0 and 3), then Reload on
the live install.

---

## 11. Decisions (all agreed 2026-10-06, as proposed)

- **D1 — A separate list, not a category in the same list.** `companyRelationships` is a new key rather than
  keeping customer / partner entries inside `companyExclusions`. Reason: every hiding place reads that list
  without looking at the category; a separate key means none of them can hide a customer by mistake, now or
  in future code. Agree?
- **D2 — A company on both an exclusion list and Customers / Partners** (e.g. a competitor that also buys from
  you): proposal — **the exclusion wins** (it stays hidden) and both rows are flagged red in Setup so you can
  decide. Agree?
- **D3 — P4 and P5 customers.** R5.4 names P3 → P2 and P2 → P1. Proposal: the same one-level rule for all,
  so a P4 customer becomes P3 (and so enters the scannable P1–P3 scope) and a P5 becomes P4. Agree, or should
  P4 / P5 stay as they are?
- **D4 — Exports and HubSpot** carry the raised priority (what you see on screen), not the stored one. Agree?
- **D5 — Relationship filter** as Any / Customer / Partner / None buttons inside the column's header menu (a
  new "choice" filter type, with the usual chip and Clear all), rather than a separate row of buttons above
  the table. Agree?
- **D6 — Research proposals** stay a tick list above the tables (as today), rather than proposed rows inside
  the table with Accept / ✕. Agree?
- **D7 — Save on either step saves both** (one draft of all five lists), so a Move to… between the two steps
  cannot be half-saved. Agree?
- **D8 — Leads come back.** Leads hidden today as "Existing Customers / Partners (matched …)" go back to "New"
  in the Leads Dashboard after the update (the pop-up gives the count). Some may be old. Agree, or bring back
  only leads from the last N days?
