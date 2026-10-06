# SalesTeam — Exclusions & Relationships: Requirements

Target release: **1.2.3** (test builds 1.2.2.1, 1.2.2.2 …)
Status: **Requirements — agreed 2026-10-06** (all questions in section 6 answered). Design follows separately.
Date: 2026-10-06

---

## 1. Why this exists

SalesTeam keeps one list of companies to leave alone, with five categories: Competitor, Recruiter /
staffing agency, Existing customer, Existing partner / reseller, Other. Every entry, whatever its
category, hides the company **everywhere**: no account in Target Accounts, no research, no contacts, no
leads from its people, no discovery.

That is right for a competitor or a recruiter. It is wrong for a customer: an existing customer is often
the best place to sell more (another department, another offer, a renewal). A partner or reseller is a
company you work *with*, and can also be a customer.

So customers and partners stop being exclusions. They become a property of the account —
**Relationship** — and the account stays fully visible and fully researched. (Agreed 2026-10-05; no
stopgap in 1.2.2.)

The same item rebuilds the Setup exclusions screen, today five free-text boxes, as proper tables.

---

## 2. How it works today (the starting point)

- One stored list, `companyExclusions`: entries `{ category, slug?, name?, domain?, source? }`, matched
  to a company by LinkedIn slug, normalised name or website domain. In a team it is shared per entry and
  only the Team Admin changes it (1.2.2).
- A matching entry hides the company in: Target Accounts and Target Contacts, the side panel, Discovery on
  LinkedIn and on the web, the background pipeline, and lead scans (the built-in lead filters "Existing
  Customers", "Existing Partners", "Competitors", "Recruiters", "Other Excluded Companies").
- The research workbook can also exclude: a Companies row with `Excluded = Yes` is hidden on its own, and
  the import copies it onto the list with the category from the Exclusion_List sheet's `Exclusion_Reason`
  (Competitor, Customer, Partner, Other).
- Taking a company off the list overrides the workbook's flag and survives a re-import
  (`companyExclusionsLifted`).
- Setup step "Any companies to exclude?": the seller research proposes competitors, customers and partners
  as tickable items; ticks write lines into five text boxes, one per category ("Name", "LinkedIn URL" or
  "Name - URL"); the boxes are what is saved.
- 15 well-known recruiters are seeded once on a new install.

---

## 3. Requirements

### R1 — Exclusions: three lists, behaviour unchanged

- R1.1 Exclusion categories are **Competitor**, **Recruiter / staffing agency**, **Other**.
- R1.2 An excluded company stays hidden everywhere, exactly as today.
- R1.3 Customer and Partner are no longer exclusion categories anywhere: not in Setup, not in lead filters,
  not in the import.

### R2 — Relationship: a property of the account

- R2.1 Values: **Customer**, **Partner / reseller**. An account can have none, one or both.
- R2.2 An account with a relationship is a normal account: listed, researched, contacts found, leads
  scanned, assignable in a team, counted in readiness and targets.
- R2.3 **Where it lives (Q1, agreed):** two lists, Customers and Partners, matched to accounts the same way
  exclusions are (LinkedIn page, name or website). The account shows the relationship because it matches
  the list. This means a company named as a customer *before* it is an account gets the tag the moment it
  is discovered or imported, and there is one place to see all customers.
- R2.4 **Where it shows:**
  - account page — a tag next to the name ("Customer", "Partner", "Customer · Partner");
  - Target Accounts list — a "Relationship" column (on by default) and a filter (Any / Customer /
    Partner / None);
  - contact page and Target Contacts list — the account's tag next to the company name;
  - Leads Dashboard — the same tag in the Company column.
- R2.5 **Who changes it:** the Setup lists (R4). The account page ⋮ menu also gets "Relationship…"
  (tick Customer / Partner), which adds or removes the company on the lists — one action set per entity,
  same in the list row ⋮ and page ⋮. In a team: Team Admin only (consistent with 1.2.2's rule that
  re-classifying is the admin's job); members see the tag, not the menu item.

### R3 — Migration and import

- R3.1 On first run of the new version, every existing Customer / Partner exclusion entry moves to the
  Customers / Partners list. The accounts it hid **reappear**, with their tag.
- R3.2 Accounts that reappear are not researched in a burst: they join the normal pipeline queue like any
  other account. The finish pop-up / Activity Log says how many came back ("12 customers and 3 partners are
  no longer excluded — they are now accounts with a Relationship tag").
- R3.3 Workbook import: a row with `Excluded = Yes` and `Exclusion_Reason` Customer or Partner is **not
  hidden**; it goes on the Customers / Partners list instead. Competitor / Other (or no reason) stay
  excluded, as today.
- R3.4 In a team, the migration runs once, on the Team Admin's SalesTeam; members' copies follow through
  the shared list (a member's own pre-team entries are carried in the same way when they join).
- R3.5 Backup/restore: an older backup restored into the new version is migrated the same way (R3.1).

### R4 — Setup: tables instead of text boxes

- R4.1 (Q4, agreed) Setup step "Any companies to exclude?" shows **Competitors**, **Recruiters / staffing agencies**,
  **Other**. A new step right after it, **"Customers and partners"**, shows **Customers** and
  **Partners / resellers** in the same form. (Same form in Change Settings.)
- R4.2 (Q3, agreed) Each list is a table: **Company**, **LinkedIn page**, **Website** (either link may be empty —
  research-found entries have a website and never a guessed LinkedIn page), sorted alphabetically by
  company, with a search box (by name) and a count ("Competitors — 14").
- R4.3 **+ Add** opens a row to type into: name, and a LinkedIn page or website (at least one of the
  three). A LinkedIn link that is not a company page is refused with a message, as today.
- R4.4 Each row has a **⋮** menu: **Edit**, **Remove**, **Move to…** (any other list on either step —
  e.g. a recruiter that became a customer moves to Customers).
- R4.5 Seller research proposals stay: competitors land in the Competitors table, customers in
  Customers, partners in Partners, each marked as proposed until accepted, as today.
- R4.6 Explicit Save, as everywhere: nothing changes until Save; leaving with unsaved changes asks.
- R4.7 In a team, both steps are read-only for members ("only the Team Admin can change it").
- R4.8 Removing a seeded recruiter stays removed (it is not seeded again).

### R5 — What the relationship changes downstream

- R5.1 (Q2, agreed) Lead scans: the built-in "Existing Customers" and "Existing Partners" lead filters
  are removed; leads from customers' **and** partners' people are kept and carry the tag.
- R5.2 (Q5, agreed — in 1.2.3) AI drafting and the Sales Mentor for an account / contact / lead of a customer are told it is an
  existing customer (so an opener is not a cold introduction); same for a partner.
- R5.4 (Q6, agreed) **A customer ranks higher.** Selling more to an existing customer is easier than
  winning a new one, so a Customer account's priority is raised **one level** (P3 → P2, P2 → P1; P1 stays
  P1). It is a fixed rule applied after the AI priority, not left to the AI, so it is predictable and
  visible: the priority reason gets the line "Raised one level: existing customer". A priority the user
  set by hand is not changed. Removing the Customer tag removes the raise. A partner only (not also a
  customer) stays neutral. The raised priority counts everywhere priority counts (pipeline order, Ready
  selection, lead matching).
- R5.3 Discovery treats a customer or partner as a normal company (it can become an account; it is not
  skipped).

### R6 — Help, PRD, release notes

- R6.1 Help: update the Exclusions entry, new "Customers and partners" entry.
- R6.2 PRD section for the feature + release-notes entry; listing/website only if the text there mentions
  excluding customers (check).

---

## 4. Out of scope

- Other relationship types (prospect, former customer, supplier…) — the property is built so more values
  can be added later, but 1.2.3 ships Customer and Partner.
- Customer data from a CRM (HubSpot / Salesforce import) — roadmap item of its own.
- Per-contact relationship (e.g. "this person is our champion").

---

## 5. Build outline (for the design)

0. Data: Customers / Partners lists (shared per entry in a team, like `companyExclusions`); matcher;
   migration; import change. Pure-module tests first.
1. Downstream: exclusion checks ignore customer/partner; lead filters; AI context; customer priority raise.
2. Display: tag on account / contact / lead, list column + filter, ⋮ "Relationship…".
3. Setup: the two table steps (shared table component), research proposals into tables.
4. Help, PRD, release notes → 1.2.3.

---

## 6. Questions for Boaz — answered 2026-10-06

- **Q1 — Lists vs. a field on the account (R2.3).** I propose the relationship lives on Customers /
  Partners lists matched to accounts (so a customer named in Setup is tagged when it turns up later), and
  the account page edits the list. The alternative is a plain field on the account, set only on accounts
  that already exist. Lists OK? **Answer: lists OK.**
- **Q2 — Leads from partners (R5.1).** Customers' leads: clearly keep. Partners' people: keep too (they
  can also be customers), or keep hiding partner leads unless the partner is also a customer? **Answer: keep (show partners' leads).**
- **Q3 — Website column (R4.2).** You asked for Company and LinkedIn columns. Research-found entries only
  have a website (we never guess a LinkedIn page), so I added a Website column. OK? **Answer: OK.**
- **Q4 — Separate Setup step (R4.1).** Customers and partners in their own step after Exclusions, or both
  groups on the one Exclusions step with two headings? **Answer: own step.**
- **Q5 — AI context (R5.2).** Include in 1.2.3, or keep this item to data + screens? **Answer: yes, the AI is told — in 1.2.3.**
- **Q6 — Priority.** Should being a customer change an account's priority (P1–P3) or ranking, or stay
  neutral for now? **Answer: raise it — upselling to a customer is easier than winning a new one.** See R5.4.
