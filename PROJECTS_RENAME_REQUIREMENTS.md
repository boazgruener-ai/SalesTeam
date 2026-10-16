# SalesTeam — "Initiatives" become "Projects", and no AI-specific names: Requirements

Target release: **1.2.4.x** (Boaz, 2026-10-16: no 1.2.5) - the store release is the last test build, 1.2.4.6, together with the fixes of 1.2.4.1 (test builds 1.2.4.2, 1.2.4.3 …)
Status: **Requirements — agreed 2026-10-16** (all questions in section 6 answered). Design follows separately.
Date: 2026-10-16

---

## 1. Why this exists

SalesTeam calls the evidence it finds about an account "initiatives", and asks the seller which "initiative stages"
matter. "Initiative" means something new, usually in technology. It does not fit a seller of office supplies,
marketing services or a product that has been around for decades, whose customers are not "launching initiatives".

Two different things carry the word today (Boaz, 2026-10-16):

1. **The account's list:** evidence the customer has published that it is doing something relevant — "Zurich AI
   Lab", "AI / GenAI for Energy Flow Management". These are **projects**.
2. **The stages:** Proof of concept, Exploration, Pilot, Early production, Scaling, Mature, Tech native — how far
   along that project is.

One word cannot cover both, so each gets its own: **Projects** for the list, and a stage word for the stages
(section 6, Q1).

The same goes for every name that assumes the seller sells AI (Boaz, 2026-10-16, repeating an earlier decision):
"AI investment", "AI maturity fit score", "AI portfolio profile" and the like become generic names, and the research
stops asking for AI specifically and asks for what matters to the seller's own offer (R6, R7). "AI" stays only where
it describes SalesTeam's own AI (the AI-scored priority, the AI features, the Advisors).

---

## 2. How it works today (the starting point)

- **Setup**, step "Which initiatives matter to you?" (step name "Initiative stages"): the seven stages, ticked and
  ordered. At least one must be ticked. Initiatives at an unticked stage are left out and do not count towards the
  target. All seven ticked in the default order means "no preference": the research is told nothing about stages.
- **Setup**, targets: "Relevant initiatives per account" (0–5), part of what makes an account Ready.
- **Account page:** "Top initiatives" in the overview, and an "Initiatives (n)" section listing each one with its
  stage, date and source.
- **Target Accounts list:** a "Top Initiatives" column; the account edit form has "Top initiatives".
- **Research** (by hand and automatic): finds initiatives, each with a stage; the result message counts "initiatives
  added". The bulk web research has an "Initiatives" topic tick box.
- **Import, export, backup:** the research workbook and SalesTeam's own export have an "Initiatives" sheet / file
  (`Initiatives.csv`, columns `Initiative_ID`, `Initiative_Name`) and a `Top_Initiatives` column; a backup's
  category is "Accounts, contacts and initiatives"; Merge (Decisions) says it moves "contacts, initiatives, sources".
- **Menus:** the tooltip of "Target Accounts Dashboard" says "companies, contacts, and AI initiatives".
- **Help, PRD, release notes, website, store listing** use the word in about 60 places.
- **Stored data** uses `aiInitiatives`, `initiativeName`, `initiativeStagePreference` and similar names.
- **AI-specific fields about the customer:** `aiInvestment`, `aiInvestmentGlobal`, `aiInvestmentSwitzerland`,
  `aiInvestmentConfidence`, `aiInvestmentScore`, `aiMaturityFitScore`, `aiUseCaseFitScore`, `aiPortfolioProfile`,
  `aiPortfolioProfileConfidence`, and in the research workbook `AI_Investment`, `AI_Initiatives` and similar columns.
  Several show up for users as "Ai investment confidence", "Ai maturity fit score" (for example in the Activity Log),
  and one field is named after one country (Switzerland).
- **The research** (web research by hand and automatic, discovery, the research prompt for an outside AI assistant)
  asks for AI initiatives and AI investment.
- **SalesTeam's own AI** is also called AI: the AI-scored priority (`aiPriority`), "AI features", the AI Sales Team.
  That use is correct and stays.

---

## 3. Requirements

### R1 — The words

1. "Initiative" / "Initiatives" becomes **"Project" / "Projects"** in everything a user reads.
2. "Initiative stage(s)" becomes **"Adoption stage(s)"** (Q1).
3. The seven stage names stay as they are (Proof of concept … Tech native), unless Q2 changes them.
4. "AI initiatives" in texts becomes "projects" — the word "AI" is dropped where it only described the evidence.

### R2 — Where it changes

1. **Setup:** the step title, its intro, its name in the step list and the summary, and "Relevant projects per
   account" in the targets. The ideal-customer example text no longer says "initiative".
2. **Account page:** "Top projects", and the section "Projects (n)".
3. **Target Accounts list:** the column "Top projects" (and its name in the Columns menu), the edit form field.
4. **Research:** result messages ("5 projects added"), the Activity Log lines, the bulk research topic tick box
   "Projects", the automatic research's status lines.
5. **Decisions:** Merge moves "contacts, projects, sources".
6. **Backup:** the category "Accounts, contacts and projects"; the README inside a backup.
7. **Menus and tooltips:** "Browse Target Accounts - companies, contacts and projects".
8. **Help, PRD, release notes, website, store listings (Chrome and Edge)**.

### R3 — What does not change

1. **Stored data keeps its names** (`aiInitiatives`, `initiativeName`, …). Nothing is converted; backups, team data
   and colleagues on an older version keep working.
2. **Imports keep accepting the old names:** a workbook or CSV with an "Initiatives" sheet, `Initiatives.csv`,
   `Initiative_ID`, `Initiative_Name` or `Top_Initiatives` imports exactly as today. The new names are accepted too.
3. **Internal names in the code and in stored data stay** (`aiInvestment`, `aiMaturityFitScore`, …), as in R3.1:
   they are keys in every user's data, backups and team folder, and renaming them would need a conversion on every
   PC of a team at once, for no visible gain. What users see is renamed (R6).
4. **The CRM export files** (HubSpot, Salesforce, Microsoft Dynamics) keep the column names the CRMs were tested with.

### R4 — The stages become optional

1. A seller for whom stages do not matter can say so: the step offers **"Any stage"** (see Q3 for how), which means
   no preference — nothing is left out because of its stage, and every project counts towards the target.
2. This is already how "all seven ticked in the default order" behaves; R4 makes it a clear, one-click choice
   instead of a hidden effect.

### R6 — No AI-specific names for the customer's data

1. Every field about the customer that users can see loses "AI" (proposed names, Q6):

   | Today | New |
   |---|---|
   | AI investment | Investment |
   | AI investment (global) / (Switzerland) | Investment (global) / Investment (local) |
   | AI investment confidence | Investment confidence |
   | AI investment score | Investment score |
   | AI maturity fit score | Adoption fit score |
   | AI use-case fit score | Use-case fit score |
   | AI portfolio profile (and its confidence) | Portfolio profile (and its confidence) |
   | AI initiatives | Projects |

2. This applies everywhere the names appear: the account page, the lists and their Columns menu, the edit form, the
   Activity Log and team log, findings and Decisions, exports' headers, Help, PRD, website and listings.
3. The field named after Switzerland is shown as "local", meaning the country of the seller's target market.
4. Imports keep reading the old column names (`AI_Investment`, `AI_Initiatives`, …) and also read the new ones.
5. "AI" stays where it means SalesTeam's own AI.

### R7 — Research that follows the seller's offer, not AI

1. The research instructions (web research by hand and automatic, discovery, the research prompt for an outside AI
   assistant) no longer ask for AI initiatives and AI investment. They ask for projects and investment that matter to
   **what the seller offers**, as described in the Setup (company context, offer, ideal customer).
2. The scores keep their meaning, generalized: the adoption fit score says how well the customer's stage of adopting
   what the seller offers fits; the investment score how much the customer invests in it.
3. Because this changes what is found, it is **measured before and after** on the same accounts (an AI seller's
   Setup, as today, and a non-technology Setup), and the results are compared before it ships.

### R5 — Help, PRD, release notes

1. A Help entry or sentence explaining projects and their stages, and that "Any stage" suits sellers whose customers
   do not adopt what they sell in stages.
2. PRD, release notes, website and both store listings use the new words.

---

## 4. Out of scope

- Renaming stored data or internal names in the code (R3.3).
- New fields for non-technology sellers (for example contract renewal dates). The existing fields are generalized,
  not extended.
- New stage names beyond what Q2 decides.

---

## 5. Build outline (for the design)

| Step | What | Test build |
|---|---|---|
| 0 | Every user-visible text in the extension: Setup, account page, list, research messages, Decisions, backup, menus; "Any stage" | 1.2.4.2 |
| 1 | Import and export: new names written in SalesTeam's own export, old and new names read on import (tested with an old workbook and a new export) | 1.2.4.3 |
| 2 | No AI-specific names: every visible field name (R6), logs, findings, exports, imports reading old and new | 1.2.4.4 |
| 3 | Research instructions follow the seller's offer (R7); measured before and after with two Setups | 1.2.4.5 |
| 4 | Help, PRD, release notes, website, store listings | 1.2.4.6 (store release) |

---

## 6. Questions for Boaz — answered 2026-10-16

| # | Question | Answer |
|---|---|---|
| Q1 | Which stage word? A finding from the code: a stage belongs to **each project**, not to the customer as a whole — "Zurich AI Lab: Pilot", "Energy Flow Management: Scaling". "Adoption stage" (agreed in chat) still reads well; "Project stage" would pair directly with "Projects". | **Adoption stage** (Boaz, 2026-10-16). |
| Q2 | Keep the seven stage names (Proof of concept, Exploration, Pilot, Early production, Scaling, Mature, Tech native)? | Keep (Boaz). |
| Q3 | How does the seller choose "Any stage"? (a) a choice above the list, "Any stage / Only these stages", or (b) allow ticking none. | Yes - a choice above the list, "Any stage / Only these stages" (Boaz). |
| Q4 | SalesTeam's **own export** (CSV and workbook): write `Projects.csv`, `Project_ID`, `Project_Name`, `Top_Projects` (new), or keep the old names? | Yes - new names written, old and new read (Boaz). |
| Q5 | Which release? | **Answered by Boaz, 2026-10-16:** a 1.2.4.x build, not 1.2.5 - shipped as 1.2.4.6 together with the 1.2.4.1 fixes (space below the chat boxes, the Status box, row click on Leads). |
| Q6 | The new field names in R6.1 — "Investment", "Adoption fit score", "Use-case fit score", "Portfolio profile", "Investment (local)"? | Yes, as in the table; "Adoption fit score" pairs with Q1 (Boaz). |
| Q7 | Internal names in the code and stored data keep "ai…" (R3.3), and only what users see changes? | Yes (Boaz: "if it is required"). It is not required for the rename itself, but it is the safe way: renaming the stored names would need a data conversion on every PC of a team at once. |
| Q8 | R7 (research follows the seller's offer) in this release, or as the next item? | Yes, in this release, measured before it ships (Boaz). |
