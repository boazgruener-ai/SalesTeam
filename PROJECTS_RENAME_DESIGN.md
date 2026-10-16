# SalesTeam — "Initiatives" become "Projects", and no AI-specific names: Design

Target release: **1.2.4.6** (store release, with the 1.2.4.1 fixes); test builds 1.2.4.2 – 1.2.4.5
Status: **Design — agreed 2026-10-16** (D1–D8 as proposed)
Requirements: `PROJECTS_RENAME_REQUIREMENTS.md` (agreed 2026-10-16)

---

## 1. The design in one page

- **Only words change, never stored data.** Every key in a user's data, backup and team folder keeps its name
  (`aiInitiatives`, `initiativeName`, `initiativeStagePreference`, `aiInvestment…`, `aiMaturityFitScore` …). A
  colleague still on 1.2.4 keeps working with a colleague on 1.2.4.6 without noticing anything.
- **Roughly 80 user-visible texts** in about 20 files change from "initiative" to "project" and from "initiative stage" to
  "adoption stage". The full list is in section 3; it is a find-and-check pass, not new logic.
- **"Any stage / Only these stages"** is a choice above the stage list in Setup. "Any stage" is saved as all seven
  stages ticked in the default order — exactly what every older version already reads as "no preference" (D2).
- **SalesTeam's own export** writes the new names (`Projects.csv`, `Project_ID`, `Project_Name`, `Top_Projects`,
  and the R6 field names). **Every import reads the old and the new names.**
- **The AI-specific field names** already read without "AI" in the Target Accounts list. What is left is where the
  name is built from the internal key — the Activity Log, the team log and SalesTeam's CSV export headers, which
  today show "Ai maturity fit score". One shared table of display names fixes all three (D4).
- **The research** inside SalesTeam already asks only for what "could matter to the seller" and never for AI; it
  changes its word to "projects" and states plainly that relevance is judged against the seller's offer. The
  **outside research prompt** (the Master Prompt for ChatGPT, V1.35) is where "AI investment", "AI maturity" and the
  AI-specific scores are asked for; it gets a generic version, V1.36 (D6).
- **Before and after** is measured on the same accounts with two Setups — the current AI seller and a
  non-technology seller — before 1.2.4.6 is built (D7).

---

## 2. What the code review found

### 2.1 Where "initiative" lives

| Kind | Files (count of the word) | Changes? |
|---|---|---|
| Stored keys and code names (`aiInitiatives`, `initiativeId`, `initiativesPerAccount`, `INITIATIVE_STAGE_IDS`, `initiative-stages` step id …) | storage.js 56, team-keys.js, team-join.js, import-merge.js, pipeline-plan.js and most others | **No** (R3) |
| Texts a user reads | onboarding.html/.js, target-accounts.html/.js, batch-status.js, web-lane.js, pipeline-runner.js, pipeline-plan.js, decisions.js, backup-restore.js, full-backup.js, import-merge.js, help.js, 4 menu tooltips | **Yes** — section 3 |
| What the research is told | agent-shared.js (lane prompt, stage preference, short research topics, discovery, drafting context), pipeline-plan.js topic words | **Yes** — section 5 |
| File and column names of SalesTeam's own export | csv-export.js, xlsx-lite.js | **Yes**, written new, read old + new — section 4 |
| Import aliases | xlsx-lite.js, csv-import.js, import-columns.js | **Add** the new names, keep the old |

### 2.2 The AI-specific field names

- The Target Accounts list and its Columns menu already say "Investment (Global)", "Investment (Local)",
  "Investment Confidence", "Maturity Fit Score", "Use Case Fit Score", "Portfolio Profile" (target-accounts.js
  ~791–826). Two still differ from the agreed names: "Maturity Fit Score" → **"Adoption Fit Score"**, "Use Case Fit
  Score" → **"Use-case Fit Score"**. "Top Initiatives" → **"Top Projects"**.
- The **team log and Activity Log** build a field's name from its key (`team-log.js` `fieldName`): `aiMaturityFitScore`
  becomes "Ai maturity fit score". That is the "Ai …" users have seen.
- **SalesTeam's CSV export** does the same (`csv-export.js` `headerLabel`): headers "Ai Maturity Fit Score",
  "Ai Investment Switzerland", "Top Ai Initiatives".
- The **research workbook** (from the outside prompt) uses `AI_Investment`, `AI_Initiatives`, `Top_AI_Initiatives`;
  `xlsx-lite.js` already accepts both `Top_Initiatives` and `Top_AI_Initiatives`, and the sheets "Initiatives" /
  "AI_Initiatives", "Investment" / "AI_Investment".
- **None of SalesTeam's own research writes these scores.** Investment, maturity, use-case fit and portfolio profile
  come only from an imported workbook. So R7's "scores keep their meaning, generalized" is a change to the outside
  prompt only (D6).

### 2.3 The stage preference

- Stored as `initiativeStagePreference`: a ranked list `[{ id, checked }]` of the seven stages
  (`pipeline-plan.js` `normalizeInitiativeStages`). It is a shared team setting (team-keys.js).
- `initiativeCounts` decides whether a project counts towards the target; a project with no stage always counts.
- `agent-shared.js` `stagePreferenceText` tells the research nothing when all seven are ticked in the default order.

---

## 3. Step 0 — every visible text (1.2.4.2)

The rule for each text: "initiative" → "project", "initiative stage" → "adoption stage", "AI initiatives" →
"projects". Wording that would read badly after a plain swap is rewritten, not swapped (for example the Setup intro).

### 3.1 Setup (onboarding.html, onboarding.js)
- Step title: **"Which projects matter to you?"**; step name in the list and summary: **"Adoption stages"**.
- Intro: *"SalesTeam looks for each account's recent projects — a reason to get in touch. Choose whether the stage a
  project has reached matters to you."*
- The new choice (D1), then the stage list as today, shown only for "Only these stages":
  - ( ) **Any stage** — every project counts, whatever its stage.
  - ( ) **Only these stages** — tick the stages where what you sell helps, most important first.
- Targets: **"Relevant projects per account"**.
- Ideal-customer placeholder: "…actively investing in the kind of work you help with…" (no "initiative").
- Summary line: "Adoption stages: any stage" or "Adoption stages, most important first: Pilot, Scaling".

### 3.2 Account page and Target Accounts list (target-accounts.html, target-accounts.js)
- Overview "Top projects"; section **"Projects (n)"**, its columns "Project ID", "Project".
- List column and Columns menu "Top Projects"; edit form "Top projects".
- "Adoption Fit Score", "Use-case Fit Score" (section 2.2).
- Web research topic on the account page: "recent projects and news".
- Merge texts (dialog, confirm, Activity Log line): "contacts, projects, sources and Post leads".
- Bulk research topic tick box: **"Projects"**.
- Import dialog help text: "…to link Contacts, Projects, Investment, Sources and Aliases".

### 3.3 Research messages and status lines
- batch-status.js, web-lane.js, pipeline-runner.js, import-merge.js: "3 projects added", "Found: 12 people,
  5 projects …", "new project(s)".
- pipeline-plan.js status: "Projects: 8 of 12 accounts have 2 relevant projects".

### 3.4 Decisions, backup, menus, Help
- decisions.js: "moves the others' contacts, projects, sources and …".
- Backup (backup-restore.js, full-backup.js, settings.html): **"Accounts, contacts and projects"**; the README inside
  a backup lists `Projects.csv`.
- The four "Target Accounts Dashboard" tooltips (dashboard, scanner, settings, side panel): *"Browse Target Accounts —
  companies, contacts and projects"*.
- help.js: every answer that uses the word; one new entry (R5, step 4).

### 3.5 What is left alone
- Code comments and internal identifiers.
- The CRM export files (HubSpot, Salesforce, Dynamics) — R3.4. hubspot.js mentions the word once in a field note
  that HubSpot does not show; it stays.

---

## 4. Step 1 — import and export (1.2.4.3)

| Where | Written from 1.2.4.3 | Also read on import |
|---|---|---|
| CSV export file | `Projects.csv` | `Initiatives.csv` |
| Its columns | `Project ID`, `Project Name` (`Project_ID`, `Project_Name` in the workbook) | `Initiative ID`, `Initiative_ID`, `Initiative Name`, `Initiative_Name` |
| Companies column | `Top Projects` / `Top_Projects` | `Top Initiatives`, `Top_Initiatives`, `Top_AI_Initiatives` |
| Workbook sheet | `Projects` | `Initiatives`, `AI_Initiatives` |

- The mapping stays in one place per format, as today: `xlsx-lite.js` aliases, `csv-import.js` header map,
  `import-columns.js` (the "what can I import" help), `csv-export.js` file names.
- **D3 — the workbook's own export writes the new names**, so an export re-imported into 1.2.4 (a colleague not yet
  updated) would not find its Projects sheet. Proposed: accept that — 1.2.4.6 goes to everyone through the store
  within days, and the team folder, which is how colleagues really share, is not affected (it uses stored keys).
- Tested with: the V66 workbook, the last V1.35 workbook, a CSV export from 1.2.4 (old names), and a 1.2.4.3
  export re-imported (new names).

---

## 5. Step 2 — no AI-specific names (1.2.4.4)

### 5.1 One table of display names (D4)
- A new small pure module, **`field-names.js`**, holds the display name of every customer field whose key starts with
  `ai…` or carries a country:

  | Key | Shown as |
  |---|---|
  | `aiInvestment`, `aiInvestmentGlobal`, `aiInvestmentSwitzerland` | Investment, Investment (global), Investment (local) |
  | `aiInvestmentConfidence`, `aiInvestmentScore` | Investment confidence, Investment score |
  | `aiMaturityFitScore`, `aiUseCaseFitScore` | Adoption fit score, Use-case fit score |
  | `aiPortfolioProfile`, `aiPortfolioProfileConfidence` | Portfolio profile, Portfolio profile confidence |
  | `topAiInitiatives`, `aiInitiatives` | Top projects, Projects |

- Used by `team-log.js` `fieldName` (Activity Log, team log, Decisions) and `csv-export.js` `headerLabel` (export
  headers, title case there). The list columns in target-accounts.js keep their own labels, aligned to the same words.
- `test_pure_modules.py` gets a case: every `ai…` field in the xlsx-lite.js field map has a display name without "AI".
- `aiPriority`, `aiPriorityScore` (SalesTeam's own AI) are **not** in the table — they keep "Priority" as today.

### 5.2 Import reads the old CSV headers too
- `csv-import.js` gets the new headers ("Adoption Fit Score", "Use-case Fit Score", "Top Projects") **and** the old
  generated ones ("Ai Maturity Fit Score", "Ai Investment Switzerland", "Top Ai Initiatives"), so a CSV exported by
  any earlier version still imports.

---

## 6. Step 3 — research follows the seller's offer (1.2.4.5)

### 6.1 Inside SalesTeam (agent-shared.js, pipeline-plan.js)
- Lane research: *"Projects: only ones from about the last two years where what the seller offers could help — a
  programme, an investment, a change or a problem the company has made public — each with its stage …"*.
- Stage preference: "The seller cares about projects at these stages …"; nothing said for "Any stage" (unchanged).
- Short research topic: "recent projects that could matter to the seller".
- Discovery search: "companies with recent projects that match what the seller offers".
- Drafting and scoring context ("Top projects: …", "grounded in its real projects above").
- The research **already** carries the company context and the ideal customer in every call
  (`companyContextBlock`, `idealCustomerProfileBlock`), so no new Setup input is needed.
- The answer format the code parses does not change (the JSON still has the same keys), so `web-research-apply.js`
  and its tests are untouched.

### 6.2 The outside research prompt (D6)
- **V1.36** of the Master Prompt, written from V1.35 in `ChatGPT Market Research`: "AI initiatives" → projects that
  matter to the seller's offer; "AI investment" → investment in what the seller offers; maturity → adoption stage;
  the scores defined against the seller's offer. Sheet and column names: the new ones from section 4; the AI-free
  ones for the fields (`Investment_Global`, `Adoption_Fit_Score` …), with the importer reading both.
- `sheet_contract.py` / `validate_workbook.py` accept both name sets.

### 6.3 Measuring before and after (D7)
- **Accounts:** 6 accounts already in the list — 3 technology-heavy, 3 traditional (manufacturing, retail, services).
- **Setups:** A = Boaz's current Setup (AI seller); B = a non-technology seller (proposed: an office-furniture supplier
  to mid-size companies, D8).
- **Runs:** "Web research" by hand on each account: 1.2.4.4 with Setup A (before), 1.2.4.5 with Setup A and with
  Setup B (after) — 18 runs, about US$ 0.30–0.50 in all.
- **Compared, per account:** number of projects found; how many Boaz judges relevant to that Setup's offer; whether
  Setup B's projects differ from Setup A's (they must, or the research is still AI-biased); cost per run.
- **Pass:** Setup A finds about as many relevant projects as before; Setup B finds projects relevant to furniture
  (office moves, new sites, renovations, hiring growth), not AI projects.
- Results go in a short table in the release notes' build history and in memory.

---

## 7. Step 4 — Help and documents (1.2.4.6, store release)

- **Help:** new entry *"What are projects and adoption stages?"* — what a project is, the seven stages, "Any stage"
  for sellers whose customers do not adopt what they sell in stages.
- **PRD:** every "initiative" → "project" in the text; section numbering unchanged; `gen_docs.py` mirrored in the
  same pass (grep for every changed heading and bullet).
- **Release notes v1.2.4.6:** the rename, Any stage, the export names, the research change and its measurement, and
  the 1.2.4.1 fixes (space below the chat boxes, the lead Status/Priority size, row click on Leads).
- **Website** (`website/build.py`) and **both store listings** (Chrome, Edge): the word, and any "AI initiatives".
  Listing-only text needs no new build.
- Manifest and PRD "Current version" 1.2.4.6; `build_package.py`.

---

## 8. Decisions for Boaz

| # | Decision | Proposed |
|---|---|---|
| D1 | "Any stage / Only these stages" — which is selected for a new Setup? | **Any stage**: most sellers do not think in stages; the list is one click away. Existing Setups keep what they have (all seven in default order shows as Any stage). |
| D2 | How "Any stage" is stored | As **all seven ticked in the default order** — what every version already reads as no preference, so an older colleague in the team behaves the same. The user's last "Only these" ticks are kept in a separate personal key, so switching back restores them. |
| D3 | The export's new names cannot be read by a colleague still on 1.2.4 | **Accept** — the store update reaches everyone within days, and the team folder is unaffected. |
| D4 | One shared table of display names (`field-names.js`) for the logs and the export | **Yes** — one place, tested, instead of three copies. |
| D5 | The 1.2.4.1 fixes (built, not yet committed) | Commit them first as 1.2.4.1 once you have checked them, so step 0 starts clean. |
| D6 | The outside research prompt | **V1.36** written by me from V1.35, for you to run in ChatGPT; the importer reads both name sets. Not bundled in the extension (unchanged). |
| D7 | Measurement | 6 accounts × (before A, after A, after B) = 18 hand-started web researches, about US$ 0.50. |
| D8 | The non-technology seller for Setup B | An office-furniture supplier to mid-size companies (or one you prefer). |

---

## 9. Build plan

| Step | What | Test build | Checks |
|---|---|---|---|
| — | 1.2.4.1 fixes committed (D5) | 1.2.4.1 | your check |
| 0 | Visible texts, Any stage | 1.2.4.2 | syntax check; Setup round trip; an older-format stage list shows correctly |
| 1 | Import and export names | 1.2.4.3 | 4 import files (section 4); `validate_workbook.py` |
| 2 | Display-name table, logs, export headers | 1.2.4.4 | `test_pure_modules.py`; Activity Log shows no "Ai …" |
| 3 | Research wording + V1.36 prompt; measured (6.3) | 1.2.4.5 | 18 runs, results table |
| 4 | Help, PRD, release notes, website, listings | 1.2.4.6 | docx regenerated; package built |
