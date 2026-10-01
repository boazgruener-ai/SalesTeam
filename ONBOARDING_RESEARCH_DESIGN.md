# SalesTeam — Onboarding Research: Design

Target release: **1.2.1** (test builds 1.2.0.1, 1.2.0.2 …)
Status: **Design — agreed 2026-09-28.** Boaz agreed to every recommendation in D1–D9 (section 12).
Date: 2026-09-28
Builds on: `ONBOARDING_RESEARCH_REQUIREMENTS.md` (agreed 2026-09-28). Requirement numbers (R4.2a,
R7a.7…) refer to that document; "1.2.0 R…" and "1.2.0 design …" refer to `DATA_PIPELINE_REQUIREMENTS.md`
and `DATA_PIPELINE_DESIGN.md`.

---

## 1. The design in one page

1. **Fix a data-loss risk first.** Every account write today reads the whole accounts store, changes
   it and writes it back, with nothing to stop two writes overlapping. Bulk web research already runs
   four accounts at once, so it can silently lose an update today. 1.2.1 adds a second lane that writes
   in parallel, so a single write lock comes first (section 2.2, build step 0).
2. **Two lanes, not one loop.** The 1.2.0 pipeline is one sequential loop that does LinkedIn and web
   work one account at a time. Web research does not touch LinkedIn, so it gets **its own lane** with
   four workers, like bulk research. The web lane makes 100 accounts **Usable within about an hour of
   Finish**; the LinkedIn loop follows behind it at its 60-visit ceiling and makes them Ready over four
   to five days.
3. **Pages are read, not only searched.** Anthropic's server-side **web fetch** tool opens a given
   URL — the account's own website, a listing page, an investor-relations page — on the user's key,
   with no new browser permission. It runs next to web search in the same request, on the model
   SalesTeam already uses (Sonnet 5). Reading a known page is cheaper and more precise than searching
   for it (section 2.4).
4. **Every value carries its own source URL.** The research answer changes from one source list per
   account to one source per field. A field with a source counts as verified (1.2.0 R5.2); a field
   without one does not. That is also what makes "one credible source is enough" (R7a.7) enforceable:
   research asks only for fields without one.
5. **Discovery starts from listings.** Web Discovery first finds listing pages for each target
   country (largest-company rankings, directories), reads them with web fetch, and filters the rows
   through the wizard's answers. A listing gives name, website, size and HQ in one go, so a
   discovered account often needs little more research.
6. **The wizard proposes; pure modules map.** One seller research call returns plain facts (country
   names, industry names, titles). A **pure** module maps them onto the wizard's own options — only
   countries the picker has, only industries with a confirmed LinkedIn id. The model never produces an
   id, so it can never invent one.
7. **Usable no longer requires LinkedIn** (confirmed 2026-09-28). `readiness.js` gains a second way to
   be Usable: a web identity with a source, a priority, and the targeting fields verified. Ready and the
   Scanner's selection do not change.
8. **Built in seven steps, each a test build** (section 11). The data layer and the two research lanes
   come first and run from Advanced tools, so their cost is measured on real accounts before the
   wizard shows a single estimate to a user.

**Honest revised numbers (section 9):** for the default target of 100 accounts, about **US$12–16** on
the user's key, **100 Usable accounts within the first hour**, and **all Ready in about 4–5 days** of
the LinkedIn ceiling. These are estimates until build steps 2–3 measure them.

---

## 2. What the code review found

### 2.1 Web and LinkedIn work share one sequential loop

`pipeline-runner.js` runs every job for one account, then the next account. Since build step 5 the web
jobs (`web_gap`, `web_full`) sit in the same loop. That was right for 1.2.0, where web research was
depth on accounts that already existed. For 1.2.1 it is the bottleneck: at about 20–30 s per research,
100 accounts one at a time take close to an hour of web work *interleaved* with LinkedIn visits that
are deliberately spaced 4–9 s apart. Bulk research (`bulk-research.js`) already proves four parallel
workers at ~18 s per account work.

### 2.2 Account writes are not protected against each other

`saveTargetAccountExtra` (`storage.js`) reads the entire `targetAccountExtras` map, changes one entry
and writes the whole map back. The workbook writers do the same with `targetAccountsWorkbook`. Two
writes that overlap — two bulk-research workers finishing together, or the pipeline and a worker — can
each read the old map, and the second write then silently drops the first one's change.
**This can already happen today** with bulk research's four workers. It is rare because the writes
are short, but it is silent, and 1.2.1 multiplies the concurrency.

**Fix (build step 0):** one in-memory write lock in `storage.js` — a promise chain that every
read-modify-write of `targetAccountExtras`, `targetAccountsWorkbook` and `targetAccounts` goes through.
The lock is a few lines and changes no data, but **it only protects writers in the same JavaScript
context**. The research lanes all run in the background worker, so they are covered. A page (the account
page, the accounts table) runs in its own context and writes directly, so a manual edit made while a lane
is running could still collide. Step 0 therefore also routes those page-side writes to the background
worker as a message, which applies them under the same lock. Step 0 starts by listing every page-side
caller of these writers, to size that part before building it.

**As built (step 0, 1.2.0.1):** the lock is a Web Lock (`navigator.locks`), not an in-memory chain. Web
Locks are shared by every context of the extension — the background worker and each open page — so the
page-side callers (almost all in `target-accounts.js`, plus full-backup restore) are covered as they are,
without a message round-trip. 23 writers wrap their unchanged body (`<name>Unlocked`); `getAccountViews`
and `autoResolveWebFindings` lock only their final re-read-and-write. The lock is not re-entrant, so the
two nested calls (`applyResolvedCompanyIds` → workbook sync, discovery merge → `applyResolvedCompanyIds`)
use the unlocked versions. A V8 run of the real `storage.js` with 20 overlapping saves kept 3 of 20
accounts before the lock and all 20 after it.

The lock alone does not stop a *stale* write: the account edit form, the findings review and research's
automatic fill each took a copy of the account's `overrides`, changed a few keys and wrote the whole copy
back, undoing anything written meanwhile (research filling a field while the form was open). They now pass
the copy they started from as `base`, and `saveTargetAccountExtra` applies only the keys that changed onto
the stored values (`extras-merge.js`, pure, tested). Live test 2026-09-28: bulk research of 20 accounts,
20 of 20 researched, US$1.50, a manual edit made during the run kept.

### 2.3 Sources are kept per research, not per field

`researchAccountOnWeb` returns one `sources` list for the whole answer, and
`applyPipelineWebResearch` stamps every value it takes with `src: "web", cited: true` if that list is
non-empty. So an employee count the model guessed is "cited" as long as *something* was cited. R7a.6 and
R7a.7 need the source of each value. The answer format changes (section 5.3).

### 2.4 Web fetch is available and fits

The server-side web fetch tool (`web_fetch_20260209`) works on Sonnet 5, can be declared next to
`web_search` in one request, takes `max_uses` and `max_content_tokens` (a cap on how much of a page is
read, which caps the cost), and **fetches only URLs already present in the conversation** — so a URL
must be given in the prompt or appear in a search result first. That restriction suits this design:
the account's website, the listing page and a report link are all known before the call. It is billed as
the tokens of the page read (to be confirmed against Anthropic's pricing page in step 2), whereas each
web search costs US$0.01 plus the tokens of every result it returns.

### 2.5 Exclusions hold LinkedIn slugs only

`companyExclusions` is a list of LinkedIn company slugs per category (competitor, recruiter, customer,
partner). R5 decided that onboarding proposes exclusions by **name and website**. The entries gain two
optional fields and matching gains two tests (section 3.9).

### 2.6 Readiness: Usable means scannable

`assessAccount` (`readiness.js`) returns `usable` only when `isScannable` is true, which needs a
LinkedIn company id. Every web-only account is therefore `in_progress` today. Section 6 changes this.

### 2.7 A 429 stops a bulk web run

`bulk-research.js` aborts the whole run on an HTTP 429 (rate limit) from the Anthropic API. A web lane
that runs for an hour after every onboarding must back off and resume instead (section 5.6).

### 2.8 The wizard

`onboarding.js` has twelve steps in `STEP_ORDER`, a shared Confirm view per step, and the two consents
(LinkedIn automation, web research budget) on the Finish step. The company website is asked in "What
you sell"; there is no field for the seller's company name. The wizard does not start any LinkedIn
Discovery itself; the Discovery scan is started from Settings.

---

## 3. The wizard

### 3.1 Step order

| # | Step | Status | Proposal from research |
|---|---|---|---|
| 1 | **About you** — name, company name, website, API key if missing, output language | **new** | output language (from the site's language) |
| — | **Researching your company…** (progress screen, R4.2a) | **new** | — |
| 2 | Location | changed | countries |
| 3 | Size | changed | size bands |
| 4 | Industry (+ organization types) | changed | industries, organization types |
| 5 | Discovery Prioritization | unchanged | — |
| 6 | Leads Prioritization | unchanged | — |
| 7 | What you sell | changed (website moves to step 1) | description |
| 8 | Things you can offer | changed | resources, each with its link |
| 9 | Ideal customer | changed | draft |
| 10 | Target contacts | changed | titles, keywords, seniority levels |
| 11 | **Initiative stages** | **new** | the Master Prompt's default order |
| 12 | **Companies you want included** | **new**, optional | none (only the user knows them) |
| 13 | Companies to exclude | changed | competitors, customers, partners by name + website |
| 14 | Company aliases | unchanged | — |
| 15 | **How big should your list be?** (targets + live estimate) | **new** | — |
| — | Confirm → Finish (consents, budget) | changed | proposed budget |

Order follows the Master Prompt (R3.1.5, section 5a of the requirements): geography, size, industry,
then offering, customer, contacts, initiative stages, inclusion, exclusion, targets, launch.

### 3.2 Where proposals live

One storage key, `setupResearch`:

```
setupResearch = {
  status: "none" | "running" | "done" | "failed" | "skipped",
  at, costUsd, model,
  seller: { name, website },
  raw: { ...the DATA answer, section 3.3 },            // kept for "Research again" and support
  proposals: {                                          // after mapping (3.4)
    location:  { value: [...picker ids], sources: [url], note },
    size:      { value: [...bucket ids], sources, note },
    industry:  { value: [...confirmed industry ids], unmapped: ["Medical devices", ...], sources },
    orgTypes, companyContext, valueAddOffers: [{ text, url }], icp,
    contacts:  { exactTitles: [...], keywords: [...], seniority: [...ids] },
    exclusions: [{ name, website, category, sourceUrl }],
    outputLanguage,
  },
  offeredInSettings: false, declinedInSettings: false,  // R4.6
}
```

A step reads its proposal when it opens. **Nothing is written to the real settings keys until the user
presses Next** (R3.1.2–3); pressing Next with the proposal on screen is the acceptance, and the step's
existing save code runs as today.

### 3.3 The seller research call

One call, streamed like `researchAccountOnWeb` (same Stop, timeout and cost recording):

- **Model:** `AGENT_MODEL` (Sonnet 5), as every other research.
- **Tools:** `web_fetch` (`max_uses: 6`, `max_content_tokens: 8000`) and `web_search` (`max_uses: 3`).
- **Input:** company name and website. The prompt tells the model to open the home page first, then the
  pages that answer the questions (about, products/services, customers/case studies, partners,
  resources/downloads, careers for office locations), and to search only for what the site does not
  say (competitors, mainly).
- **Output:** a short briefing (shown nowhere; kept for support) and a `DATA:` line of JSON in which
  **every item carries the URL it came from**:

```
{ "summary": {text, url}, "offerings": [{text, url}], "problemsSolved": [{text, url}],
  "sellsToCountries": [{name, url}], "customerSizes": [{text, url}],
  "customerIndustries": [{name, url}], "organizationTypes": [{name, url}],
  "buyerTitles": [{title, url}],
  "resources": [{title, url}],                      // real pages only: reports, webinars, demo offers
  "competitors": [{name, website, url}], "customers": [{name, website, url}],
  "partners": [{name, website, url}], "siteLanguage": "de" | ... }
```

Cost, estimated: six pages at up to 8,000 tokens and three searches — **about US$0.15–0.30** on Sonnet 5.
The button shows the estimate (R4.2); step 4 replaces it with the measured average.

### 3.4 Mapping answers onto wizard options — `setup-proposals.js` (pure)

The model returns names; a pure module turns them into the wizard's own values, and **drops what it
cannot map rather than guessing**:

| Answer | Mapped with | If it cannot be mapped |
|---|---|---|
| `sellsToCountries` | `iso-country-codes.js` + `country-local-names.js` → the location picker's ids | dropped, listed in the step's note |
| `customerSizes` | text → the Size step's buckets (reusing `parseLooseNumber` and the bucket bounds) | no proposal |
| `customerIndustries` | exact and alias match against `industry-id-map.js` (live-confirmed ids only) | **not ticked**; added as a line to the Ideal customer draft (R5, N10.3) |
| `organizationTypes` | the wizard's fixed list | dropped |
| `buyerTitles` | exact titles as given; keywords = frequent title words; seniority via `seniorityLevelFromLabel` (`readiness.js`) | — |
| `resources` | kept only with a URL on the seller's own domain | dropped (the Things-you-can-offer promise) |
| competitors, customers, partners | kept only with a website or a source URL | dropped |

`test_pure_modules.py` gains cases for each row, including the ones that must *not* map (a made-up
industry name, a resource on a third-party domain).

### 3.5 Showing a proposal — `proposal-ui.js`

One small shared component, used by every researched step:

- a banner *"Proposed from acme.com/about, acme.com/customers — keep, change or clear it"*, with the
  links (R5.1) and **Research again** with an optional hint (R4.4), which re-runs the seller research
  limited to that step's fields;
- for a **list**, one row per item: a **checkbox** (include), the text (editable), a **rank** with ↑/↓
  where order matters (contact titles, initiative stages), and **Add** (R3.1.5);
- *"Nothing found on acme.com for this…"* when a step received nothing (R5.2).

For an existing user (R4.5) a differing proposal is shown next to the saved value as **current** and
**proposal**, with *Use proposal* per item; the saved value stays unless taken.

### 3.6 The progress screen (R4.2a)

Shown between About you and Location while `setupResearch.status === "running"`. It lists what is
being read, from the stream (*"Reading acme.com/customers…"*, *"Searching: acme competitors
Switzerland"*), the cost so far, and **Stop** (keeps whatever was found) and **Skip research**. The wizard
continues to Location when the answer is in. If the call fails, the screen says so with **Try again** or
**Continue without research** (R4.3).

### 3.7 Initiative stages (new step 11)

`initiativeStagePreference: ["poc", "exploration", "pilot", "early_production", "scaling", "mature",
"tech_native"]` — the seven stages of the Master Prompt, as a ranked checklist (a stage can be
unticked). Default: the Master Prompt's order. It is passed to account research (section 5.2) to judge
which initiatives are relevant, and so which count towards the initiative target. Its weight in
priority scoring is out of scope (requirements, open question 7).

### 3.8 Companies you want included (new step 12)

`includedCompanies: [{ name, website }]`, optional, typed by the user. Web Discovery adds these first,
before any listing, and they bypass the size and industry filters (they do not bypass exclusions: a
company on both lists is flagged on the step instead).

### 3.9 Exclusions by name and website

`companyExclusions` entries gain optional `name` and `domain` beside `slug`, and a `source`
(`"user"` / `"research"`). `isCompanyExcluded(row)` matches by LinkedIn slug (as today), **or**
normalised name (`normalizeCompanyName`), **or** website domain (lower-cased, `www.` stripped). No
LinkedIn visit is ever made for an exclusion (R5, decided).

### 3.10 Targets (new step 15)

`completionTargets = { accounts: 100, contactsPerAccount: 3, initiativesPerAccount: 1 }`. Contacts
per account is capped by the existing *Maximum contacts per target account*. Under the fields, the live
estimate (R8.1) from `onboarding-estimate.js` (section 9): *"100 accounts: about 4–5 days of your daily
LinkedIn limit and about US$14 on your Anthropic API key. Your first 100 accounts will be usable within
the hour; the first Ready ones within the day."*

### 3.11 Finish

The two consents stay as they are (1.2.0 design 10.1), with the web budget **pre-filled** from the
estimate, rounded up (R8.2). **Finish** saves, then kicks Web Discovery and both lanes (R3.4.1). The
wizard never makes a LinkedIn visit.

### 3.12 Existing installs (R4.6)

After the update, Settings shows once: *"New: SalesTeam can research your company and propose
improvements to your setup (about US$0.30)."* **Research** runs the same call and opens the wizard in
current / proposal mode (3.5); **No thanks** sets `declinedInSettings`. The action stays under Settings >
Setup.

---

## 4. Web Discovery

> **D11, 2026-09-30: the web first, LinkedIn optional.** Web listings (sections 4.1-4.4) find the accounts. The
> LinkedIn company search is an option, off by default, for about a fifth of the target: it finds mostly local
> branches of international groups, which listings tend to miss. It was tried first the same day ("LinkedIn first")
> and dropped as the main source: LinkedIn's free company search does not hold its location filter, so it needs the
> country name as a keyword and then returns mostly companies with the country in their name. Details in "As built
> (step 3)", section 11.

### 4.1 Two calls per target country — `web-discovery.js` (background)

1. **Find listings.** A call with `web_search` (`max_uses: 3`) asks for listing pages that match the
   targeting (R7.1c): for large-company targets *"largest companies in Switzerland by employees"*; for
   others a ranking by industry, a directory filtered by size, a list of hospitals… It returns up to
   five candidate listing URLs with what each lists and how many rows.
2. **Read listings.** One call per listing with `web_fetch` (`max_uses: 2`, `max_content_tokens:
   30000`) returns the rows: `{ name, website, hqCountry, employees, revenue, currency, year, industry,
   isPublic, rank, sourceUrl }`. A listing that spans several pages is read page by page up to the
   number needed.

Registries (Zefix and its equivalents) are **not** used to find companies — they do not rank — but to
confirm identity during account research when a legal name is needed (R7.1a).

### 4.2 Filtering — `discovery-filter.js` (pure)

Each row passes, in order: the seller's own company → the exclusion list (3.9) → accounts the user
removed (`deletedAt`) → existing accounts (by LinkedIn id, domain, normalised name) → rows the pipeline
already marked Lacking evidence → the wizard's size buckets, industries and organisation types, when
the row states them. A row that states no size is **kept** (research will find it). A name-only match to
an existing account goes to the decision queue (R7.4, reusing 1.2.0's name-match item).

### 4.3 Order and quantity

- Included companies first (3.8), then the listing rows by **the deterministic pre-score**
  (`computeCompanyDeterministicPreScore`, location and size priorities from the row), then listing rank.
- **How many:** `target × (1 + margin)`, margin **15%** to start, replaced by the measured share of
  accounts that end Lacking evidence after the first runs (R7.6). If LinkedIn cannot clear the whole
  target within 7 days (about 200 accounts at section 9's rates), discovery runs in waves of 7 days of
  LinkedIn work (R7.6 proposal; D3).
- If the listings run out before the target, the **fit search** of the Master Prompt (its section 25:
  subsidiaries, regional HQs, public bodies, companies with relevant initiatives) runs as a third call
  with `web_search` (R7.1c).

**Size-targeted discovery (D9, agreed 2026-09-28).** The size bands are the wizard's own
(`SIZE_PRIORITY_BUCKETS`: Small 0–200, Medium 201–500, Large 501–1,000, Extra Large 1,001–5,000, Extra
Extra Large 5,001+), shown with their ranges on the Size step, where the user ticks the bands to cover —
there is no standard definition, so the ranges are always visible. Discovery follows them:

- **Listings match the bands.** A top-100-largest ranking is used only when the ticked bands are the
  largest ones; otherwise the listing call asks for companies of the ticked range (by industry,
  region or directory), never the largest ones by default (R7.1c).
- **The target is split across the ticked bands in proportion to their priorities** (e.g. 100 accounts,
  Large High and Medium Medium → about 60 and 40).
- **Centre of the band first.** Within a band, candidates are ordered by how close their headcount is to
  the band's log-scale midpoint (√(min × max): ~707 for Large, ~317 for Medium, ~2,236 for Extra Large;
  Small and Extra Extra Large, open at one end, use 100 and 10,000). This replaces the idea of
  collecting *all* companies of a band and taking 50 either side of its median: no free source lists
  every company of a band with its headcount, and company counts rise steeply towards a band's lower
  end, so its median would sit near the bottom. Fit still comes first: the centre distance ranks
  candidates of equal pre-score, so a strong fit at the band's edge beats a weak fit at its centre.
  Candidates without a headcount yet rank after those with one.

### 4.4 Adding the accounts

A new row source, **"Web"**:

```
{ companyId: "W-<domain>" (or "W-<normalised name>" when no website), company, website,
  globalHqCountry, globalEmployees, globalRevenue, revenueCurrency, industry, isPublic,
  primarySourceUrl: <listing url>, researchStatus: "Found on the web", source: "Web" }
```

Each value from the listing gets its provenance at once: `{ src: "web", cited: true, link: sourceUrl,
at }`. The merge is silent-tier (1.2.0 R6.2.1): one Activity Log line (*"Web Discovery added 104
companies from 3 listings"*), one undo slot of its own, reversible by the soft delete.

---

## 5. Account research: the web lane

### 5.1 Its own lane

`web-lane.js` in the background worker, modelled on `bulk-research.js`: **four workers**, each takes the
next account that needs web research and writes its result through the write lock (2.2). It runs
**independently of the LinkedIn loop** and does not hold the batch lock for the run; the LinkedIn loop
keeps its per-account lock. A user action still pauses both (1.2.0 U2).

Order: **traded companies first** (R7a.1; `isPublic` from the listing, else unknown), then by priority,
then by listing rank. Private companies, non-profits and public bodies follow (R7a.3).

Spending: the monthly web budget from 1.2.0 (`webBudgetBlocker`) gates every call, exactly as today.

### 5.2 One research per account, asking only for what is missing

`missingWebTopics(view, cfg, targets)` (pure, in `pipeline-plan.js`) lists the fields that have **no
applicable, cited provenance**: HQ, employees, revenue (only if the user set a revenue target),
industry (only if industry priorities are set), initiatives below target, relevant contacts below
target, summary. **If the list is empty, no call is made** (R7a.7). A value that came from a listing
already has a source, so a listed account typically needs only initiatives, contacts and a summary.

The call:

- **Tools:** `web_fetch` (`max_uses: 4`, `max_content_tokens: 10000`) and `web_search` (`max_uses: 2`).
- **Input:** the account's name, website, and **the facts already known, each with its source**, and
  the instruction to research only the listed topics.
- **Where to look, in order:** for a traded company its latest annual or quarterly report and
  investor-relations news (R7a.1); for every company its own website — home, about, leadership /
  management, news (R7a.2). Search only for what those pages do not give.
- **Context passed in:** *What you sell*, the Ideal customer and the initiative-stage ranking (3.7), so
  that initiatives are judged for relevance and stage.

### 5.3 The answer, per field with its source

The `DATA:` line changes from plain values to `{ value, url }` per field, and gains contacts:

```
{ "employeesGlobal": {value, url, year}, "employeesLocal": {...}, "revenueGlobal": {value, url, year},
  "revenueCurrency": "CHF", "hqCity": {...}, "hqCountry": {...}, "isPublic": {value, url},
  "summary": {text, url},
  "initiatives": [{ name, description, date, stage, status, sourceUrl }],
  "contacts": [{ fullName, title, sourceUrl }],       // named people on the site or in a report
  "budgets": [{ text, amount, currency, year, sourceUrl }] }
```

`applyPipelineWebResearch` stamps each value's provenance with **its own** `link` and marks it `cited`
only when that value has a URL. A value without a URL is stored as a finding but counts as
**unverified** (1.2.0 R5.2) — so the model cannot make a number count by citing something else.
`computeFindingProposals` and the arbitration rules (`web-findings-arbitration.js`) keep working on
`value`; the older plain format is still read, so a research stored before 1.2.1 is not lost.

A **second source** is sought only when the arbitration produces a conflict that could change a decision
(1.2.0 R5.4) — that is the existing decision-queue path, not a new rule.

### 5.4 Contacts from the web

Each named person becomes a contact row, `source: "Web"`, no LinkedIn URL, seniority from
`seniorityLevelFromLabel` / `classifyJobTitleSeniority`. They count towards the contacts target at once
but **not towards Ready** until their LinkedIn profile is found (R7a.5, 1.2.0 R3.3). The existing
profile job (search by name, `doProfile`) does that — see 7.2 for how many.

### 5.5 Initiatives

As today, through `addWebResearchInitiatives`, now with a `stage`. An initiative counts towards the
target when its stage is ticked in the initiative-stage step and it relates to *What you sell*.

### 5.6 Rate limits

On a 429 the worker waits for the `retry-after` time (or 30 s, doubling to 5 min), and the other workers
pause with it. After five 429s in a row the lane stops for the day and says so in the progress line.
Nothing is aborted; the accounts stay queued (2.7).

---

## 6. Readiness: Usable without LinkedIn

### 6.1 The rule — `readiness.js`

`assessAccount` gains one branch, after Ready and before In progress:

```
else if (scannable) state = "usable";                        // as today: usableVia "linkedin"
else if (webUsable(view, cfg, now)) state = "usable";        // new:     usableVia "web"
else state = "in_progress";
```

`webUsable` is true when:

- the account has a **website or a primary source URL, with a cited source** (its identity);
- it has a **priority** (P1–P5);
- every **targeting field** in `requiredFields(cfg)` other than the LinkedIn id and contacts —
  HQ country, employees, industry, as the user's own targeting requires (1.2.0 R3.5) — is verified.

The assessment returns `usableVia: "linkedin" | "web"`. `isScannable`, the Ready bar and the Scanner's
selection are **unchanged** (`MIN_READY_TO_SCAN` rises from 5 to 10, D7, section 7.3), so 1.2.0 R3.4 still holds for Ready (R3.4.2–3).

### 6.2 What the user sees

The Usable slice stays **one slice**; its tooltip and the table filter say *"62 usable — 48 not yet on
LinkedIn"*, and the accounts table shows a small *web only* tag. (D1: one slice or two.)

### 6.3 Priority of a web-only account

It is scored by the existing deterministic pre-score from its web values, with no contacts, and is
re-scored as data arrives (1.2.0 design 5.3). It starts lower than it will end — which is fine, because
the ranking of the LinkedIn loop re-reads priorities on every pick.

---

## 7. LinkedIn after the web

### 7.1 Order

`rankCandidates` gains one rule: **an account whose web research is queued or running is not offered to
the LinkedIn loop** until the web lane is done with it — otherwise LinkedIn would search the People page
for contacts the website is about to name. Exceptions: the web lane is blocked (no budget, no key, 429
stop), or the account has waited more than a day.

### 7.2 Jobs per account after web research

| Job | When | Touches |
|---|---|---|
| Resolve | always (the Scanner needs the id) | 1 with a LinkedIn link from the web, ~1.3 by name |
| Size | only if the web gave no cited employee count | 0 — read during the resolve visit (1.2.0) |
| Profile by name | for the **most senior relevant** web contact | 1 |
| People page | only if the relevant contacts with a profile are still below target | 1 |

**D2:** verify **one** web contact by name (enough for Ready), then use one People-page visit for the rest,
rather than one name search per web contact. Three name searches would cost three touches for what the
People page usually gives in one.

### 7.3 The first 10 Ready, then the rest (D7, agreed 2026-09-28)

A Leads scan over fewer than about 10 verified accounts is unlikely to find posts by target titles, and
borrowing touches from the user's scanning room cannot work, because a scan the user starts later cannot
be predicted and spent touches cannot be given back. So the first day trades a short wait for a useful
first scan, and the ceiling is never raised:

- **`MIN_READY_TO_SCAN` rises from 5 to 10**, every day, not only the first (after day 1 the Ready count
  only grows, so it is the same in practice and simpler). **This changes 1.2.0 R12.3.4 (5).** The gate
  stays soft: 0 Ready blocks the scan; 1–9 explain and offer **Scan anyway**, with the progress and time
  left (*"6 of 10 accounts ready, about 25 minutes to go"*).
- **Until 10 accounts are Ready, the LinkedIn loop works only towards Ready:** it picks the accounts with
  the fewest touches to Ready (web research done, a web contact to verify), takes each only as far as
  Ready (company page and one relevant contact with a profile), and postpones what lies above Ready —
  contacts 2–3, the People page for the target, the next discovery wave. Expected: 13–15 accounts
  attempted, about 30–35 touches, **about an hour** (to be measured in build step 4).
- The Finish screen says it: *"Your first 10 accounts will be ready in about an hour; the Scanner opens
  then."*
- **The pipeline ceiling stays at 60** of the 99 in any rolling 24 hours. Because the window rolls, day 2
  does not start with a fresh 99: the guarantee is **at least 39 touches for the user's scans at any
  moment**. Build step 4 measures the touches a typical scan of 10–20 accounts needs; if 39 proves too
  few, the answer is a lower pipeline ceiling, never a borrowed one.

---

## 8. The stop rule (R6.3)

`targetsStatus(assessments, targets)` (pure) returns what is still owed:

- **discover** while `ready + usable + in_progress < targets.accounts × (1 + margin)` and the listings
  or fit search can still add candidates;
- **enrich an account** while it is below its per-account targets and its jobs have not given up;
- **idle** otherwise — back to 1.2.0 behaviour (new data, expired verification).

Raising a target in Settings re-kicks discovery; lowering one never removes accounts (R6.5). The Target
Accounts Dashboard shows the targets as coverage lines under the pie (R6.4): *"Contacts: 212 of 400
accounts have 3."*

---

## 9. Cost and time — `onboarding-estimate.js` (pure)

Rates on Sonnet 5: US$2 per million input tokens, US$10 per million output, US$0.01 per web search; web
fetch billed as page tokens (to confirm in step 2).

| | Estimate per account | For 100 accounts |
|---|---|---|
| Seller research (once) | — | US$0.15–0.30 |
| Web Discovery (listings) | ~US$0.01 | ~US$1 |
| Account research (2–4 page reads, 0–2 searches, ~40k input) | ~US$0.10–0.14 | ~US$10–14 |
| **Money** | | **~US$12–16** |
| Web lane, 4 workers at ~25–35 s | | **~15–20 minutes** to Usable |
| LinkedIn touches (resolve ~1.1, profile 1, People page ~0.5) | ~2.6 | ~260 |
| **At the 60-visit ceiling** | | **~4–5 days** to Ready |

The estimate function takes these as defaults and switches to this user's measured averages once 20
accounts have gone through each lane (R8.3). The requirements' section 8 table (written before web-first)
is superseded by this one.

---

## 10. Pure modules and tests

New or extended pure modules, all executed by `test_pure_modules.py`:

| Module | Holds |
|---|---|
| `setup-proposals.js` (new) | mapping the seller research onto wizard options (3.4) |
| `discovery-filter.js` (new) | the filter chain and dedupe of listing rows (4.2) |
| `onboarding-estimate.js` (new) | the cost and time estimate (9) |
| `readiness.js` | `webUsable`, `usableVia` (6.1) |
| `pipeline-plan.js` | `missingWebTopics`, `targetsStatus`, the web-before-LinkedIn ranking rule (5.2, 7.1, 8) |
| `web-research-apply.js` | reading the per-field `{value, url}` format and the old one (5.3) |

Cases that must be in the tests from the start: an industry with no confirmed id is not ticked; a
resource on another domain is dropped; a removed account is never re-added by discovery; a value without
a URL does not count as verified; nothing missing means no research call.

---

## 11. Build order

Each step is a test build (1.2.0.1, 1.2.0.2 …) and can be checked on its own. The research lanes run
from **Advanced tools** before the wizard uses them, so their real cost is measured first.

| Step | Build | Shows the user | Check |
|---|---|---|---|
| **0** | Write lock in `storage.js` (2.2); 429 back-off in bulk research (5.6) | nothing | bulk research of 20 accounts, no lost write; a forced 429 resumes |
| **1** | Per-field provenance format (5.3), `webUsable` (6), "Web" row source (4.4), exclusions by name/domain (3.9), the pure modules' tests | Usable count includes web-only accounts | `test_pure_modules.py`; existing accounts unchanged |
| **2** | Web lane with web fetch, `missingWebTopics`, contacts from the web; Advanced > *Research accounts on the web (new)* | nothing new in normal use | **measure** cost and time per account on 20 real accounts, traded and private |
| **3** | Account discovery from web listings; optional LinkedIn search for local branches (D11); Advanced > *Find new accounts (new)* | new accounts appear as "Web" (and "Discovered" from LinkedIn) | **measure** web cost per listing, rows kept after filtering, share of web accounts found on LinkedIn |
| **4** | LinkedIn after web (7): ranking rule, one profile search + People page; first 10 Ready first and the Scanner at 10 (7.3, D7) | fewer People-page visits | touches per account vs. section 9; time to 10 Ready; touches per Leads scan (D7) |
| **5** | Wizard: About you, seller research, progress screen, proposals on the existing steps, `proposal-ui.js` | the new wizard start | a clean profile with 3 real company websites |
| **6** | Wizard: initiative stages, included companies, targets with the estimate, Finish kicks both lanes; stop rule (8); coverage lines | the full onboarding | a full onboarding in a clean profile, 100 accounts |
| **7** | Settings offer for existing installs (3.12); Help, store listing and website wording; release notes; **1.2.1** | — | store package |

**As built (step 1, 1.2.0.4):** a new pure module, `company-identity.js`, holds `normalizeCompanyName`
(moved out of `storage.js`, which re-exports it), `websiteDomain`, `webCompanyId` ("W-<domain>" or
"W-<normalised name>") and the exclusion matcher: `isCompanyRowExcluded` now takes
`buildExclusionMatcher(exclusions)` and matches slug, name or domain (Discovery's card check too). The
wizard's Exclusions step shows LinkedIn pages only, so it carries name/domain entries through a save
untouched. `web-research-apply.js` reads both answer formats (`findingValue`, `findingUrl`) and decides
per field with `webCitationFor`: a value is cited only with a url of its own, and only when it agrees
with the value in place; a research stored before 1.2.1 keeps the old rule. Every place that stamped
`cited` from the research's whole source list now uses it (override stamping, the confirm pass,
`deriveProvenance` via `facts.webCitations`). For `webUsable`, the identity test is a website (with or
without `https://`) or an `http(s)` primary source url; a website comes from the row, an edit, or a
research that cited it. Measured on the 2026-09-29 backup: of 551 live accounts, 11 are not scannable
and one of them (Swiss Air-Rescue Rega, P3) becomes Usable via the web; nothing else changes, and every
stored research is in the old format, so no provenance changes. `MIN_READY_TO_SCAN` stays 5 until step 4.
Two fixes in the same build, from Boaz's check of those numbers: a slug taken off the exclusion list in
the wizard is kept in `companyExclusionsLifted` and overrides the research workbook's own Excluded flag
(before, the ten companies its Exclusion_List marks "Competitor" could not be included again, and the
import's backfill put them back); and an account the user gave an Alt. name or LinkedIn link is taken
first by the pipeline until it has been tried once with it (`userRetryFirst`, pipeline-plan.js).

**As built (step 2, 1.2.0.6):** `web-lane.js` (background, four workers, no batch lock; refuses to start while a
bulk web research runs) is started from Advanced tools > *Research accounts on the web (new)…* with a number of
accounts and a cost cap. `missingWebTopics` (pipeline-plan.js) asks for HQ and employees without a good fresh
source, industry only when the setup weighs it, initiatives and relevant contacts below
`DEFAULT_COMPLETION_TARGETS` (3 contacts, 1 initiative - the Targets step sets them in step 6), and a summary; an
account with nothing missing is skipped, and one the lane researched in the last 30 days is not asked again.
`webLaneOrder`: traded first, then priority, then listing order. On the 2026-09-29 backup, 519 of the accounts
need something (515 of them contacts), and the workbook's Company Type says whether a company is listed for
**none** of them ("Swiss company", "International company"), so the first lane pass runs in priority order; each
research answers `isPublic`, which the measurement uses to split traded from private. The call
(`researchAccountForLane`, agent-shared.js): `web_fetch_20260209` (4 uses, 10,000 tokens a page) and
`web_search_20260209` (2 uses), falling back to the basic versions if refused; Sonnet 5; the facts already known
go in with their sources. `applyWebLaneResearch` (storage.js) keeps the research before it as
`webResearchPrevious`, stores initiatives with their `stage`, fills empty fields and runs the automatic resolve
(shared with the 1.2.0 pipeline via `fillEmptyAndResolve`), adds named people as `source: "Web"` contact rows
(a name needs two words, no role words, and a source url of its own), gives a known contact without a profile
the one found, and fills an empty LinkedIn company link (D10). Industry became a web finding field. A lane
research counts as the account's full research (`webFullResearchAt`). When a run ends, the pop-up and the
Activity Log give cost, time, searches and pages read per account, traded and private apart. Web fetch has no
per-use fee: the pages read are billed as input tokens, which the measurement includes.

**First measurement (1.2.0.6, 2026-09-29/30, 24 real accounts):** about US$0.09 per private company and US$0.19
for the one publicly traded company (below the design's estimate); 42 named people added from the web; but only
**2 of 42** came with a LinkedIn profile link, and private companies took **about 204 s each** (the traded one
20 s), close to the 4-minute cut-off. The second run stopped at 19 of 20 on the user's own Anthropic Console
monthly limit (not a fault). **1.2.0.7:** a separate **profile search** after each research (Haiku 4.5, at most 2
web searches, about US$0.01-0.02): the model only runs `site:linkedin.com/in "<company>" "<name>" OR ...`, and code
decides (`profilesFromSearchResults`, pipeline-plan.js): a result counts only when its title names the person
(first and last name, umlauts and titles folded) AND a distinctive word of the company, and exactly one profile
matches. It covers up to 6 people per account without a profile - new web contacts and those already known
(343 accounts on the backup have some) - so `missingWebTopics` gains a `profiles` topic; an account missing only
profiles gets only the profile search. The 30-day skip now applies to the main research and the profile search
separately (`webProfileSearchAt`). Every account writes one Activity Log line (time, cost, searches, pages read,
rounds, cut off, profiles found), and the dialog shows the last run account by account, to find the cause of the
slow private-company researches before changing anything there.
The list showed the cause: 13 of 20 researches **hung** until the cut-off (about US$0.037, nothing found) on the
dynamic-filtering tool versions (20260209), while the rest finished in about 20 s; the lane now uses the basic
versions first. **Second measurement (1.2.0.7, 2026-09-30, 20 accounts): no hangs**, US$1.98 in all - publicly
traded (9): about US$0.135 and 26 s each, 66 contacts added; the rest (11, mostly a profile search only): about
US$0.070 and 9 s each. Profile search: **38 of 104 people** found on LinkedIn from search results (was 2 of 42),
and Ready went from 136 to 144 without a LinkedIn visit. Planning figures for 9 and step 4: about US$0.10 per
account for the web lane with profiles, and about a third of the people get their profile from the web - the rest
still need one LinkedIn search each.

**As built (step 3, 1.2.0.8) - the web first, LinkedIn optional (D11).** Advanced tools > *Find new accounts
(new)…* (all four pages) asks for a target (default 10), a web cost cap, and whether to also search LinkedIn.
`web-discovery.js` (background):

1. **The web** finds the accounts: up to five listing pages per country found with `web_search`, each read with
   `web_fetch` (30,000 tokens a page, a second page if the list continues); rows filtered by `discovery-filter.js`
   (pure, tested): seller, exclusions, removed, existing, listed twice, then size band, industry (the call maps a
   stated industry onto the wizard's names; only a clear "none" drops the row) and excluded organisation types. When
   the listings run short, the fit search. `chooseDiscoveryRows`: included companies first, then per band
   (`bandTargets`: `target x 1.15` split by band priority) by pre-score, centre of the band, listing rank; rows
   without a headcount last. Added as "Web" rows (`addWebDiscoveredCompanies`, under the write lock); the pipeline
   looks each up on LinkedIn later.
2. **LinkedIn, only when ticked**, for about a fifth of the target plus what the web fell short of: the automatic
   pipeline steps aside; under one batch lock the existing company Discovery (`company-discovery-extraction.js`)
   runs once per size band, in a small unfocused window (as the pipeline's), with the country name as keyword and
   headquarters confirmed in a target country; merged via `autoMergeDiscoveryResults` (a name-only match waits in
   the decision queue).

**Why LinkedIn is not the main source (2026-09-30).** A first run with LinkedIn first added 12 accounts from 5 result
pages at no cost - but nearly all had the country in their name (Huawei Switzerland, Audi Switzerland, Škoda
Switzerland…): LinkedIn's free company search does not hold its location filter (with Switzerland ticked and no
keyword, or even the keyword "a", it leads with Microsoft, Google and other companies outside Switzerland), so the
search needs the country name as a keyword, which matches company names. Other keywords (legal forms, cities) would
give a biased, country-specific sample, not a complete list. Kept as the option for what it does find well: local
branches of international groups.

Every added account is scored at once (`rescoreDerivedPriorities`). One undo for the whole run (*Remove the accounts
the last run added*, a soft delete). The dialog's last-run details list each listing (and LinkedIn band), and how
many of the added accounts the LinkedIn work has found since.

**Measured (1.2.0.8, 2026-09-30, web only, target 10 -> 12 wanted, Switzerland, sizes 501+):** 12 of 12 added for
**US$0.28 in all - about US$0.02 per account** (one search for listings about US$0.14; three listings read, about
US$0.05 each). 50 rows read, 23 kept after filtering (15 already an account, 6 listed twice, 6 outside the sizes);
no fit search needed. The accounts are homegrown companies of the right size (Syngenta, Firmenich, Bell Food Group,
Alpiq, Zurich Insurance Group, Raiffeisenbank…) - the opposite of the LinkedIn run's "X Switzerland" branches. Far
below the design's estimate for discovery. Still to see: how many of them the pipeline finds on LinkedIn.

**As built (step 4, 1.2.0.9) - LinkedIn after the web.** All in the existing pipeline (`pipeline-plan.js`,
`pipeline-runner.js`); nothing new on screen except the Scanner's gate.

- **7.1, the web lane goes first:** a web lane run now records the accounts it still has to research
  (`pendingKeys`, queued or running). `heldForWebLane` keeps them out of `rankCandidates` while the run is
  alive; a run that has stopped (budget, key, 429), whose record is more than 2 minutes old (a reload), or that
  started more than a day ago holds nothing.
- **7.2 / D2, one name search, then the People page:** account views now carry each contact's seniority level
  (`level`) and `source`; `profileContactToTry` takes the **most senior** relevant contact without a profile
  first. After one name search in a pass, `jobsNeeded` offers the People page (`contacts`) instead of a second
  name search; only once the People page has given up (two failed days) are further names searched (up to 3 a
  day, as before). Resolve already uses the LinkedIn company link the web found (D10), and size already rides on
  the resolve visit or is skipped when the web gave a cited count.
- **7.3 / D7, the first 10 Ready:** `MIN_READY_TO_SCAN` is **10**. While fewer accounts are Ready,
  `rankCandidates` (`readyGoal`) puts first the accounts whose remaining gaps LinkedIn can close (id, employees,
  contact, priority - `readyByLinkedin`), fewest estimated touches first, ahead of priority; an account that also
  needs the web for its HQ or industry waits. The jobs already stop at Ready (a contact gap closes with one
  verified contact), so nothing above Ready is done for an account before the goal is met. The Scanner's gate
  says *"6 of 10 accounts Ready, about 25 minutes to go"* while automatic preparation is on
  (`readyEtaMinutes`: 6 minutes per Ready account to come until 3 have been measured, then the measured pace).
- **Measurements:** every *Pipeline:* Activity Log line ends with the account's LinkedIn page visits and "now
  Ready"; the first run that finds fewer than 10 Ready starts `pipelineReadyGoal` (accounts, visits, pipeline
  work time), and reaching 10 writes one line - *"First 10 accounts Ready (from N): X min after the pipeline
  started, Y min of pipeline work, Z LinkedIn page visits on W accounts"*. Every Leads scan writes *"Leads
  scan: N LinkedIn page visits in M min"* (D7: are 39 free touches enough?). Measured once per install, so on
  an install that already has 10 Ready only the per-account and per-scan lines apply; time to 10 Ready needs
  the small test target (Boaz's end goal, 10 accounts).

**1.2.0.10 (Boaz, 2026-10-01) - the web goes on while LinkedIn waits.** With the pipeline's LinkedIn visits used up
the top bar said only *"LinkedIn limit for automation reached"*, and nothing ran on the web: the pipeline's own web
research (missing headcount or HQ, a full research once a year) had nothing left, and the web lane ran only by hand.
Now (a part of step 6 brought forward): when a kick finds the LinkedIn limit reached and the pipeline idle, and the
monthly web budget allows, it starts the **web lane automatically**, 20 accounts per run. Each account's cost counts
against the monthly web budget; before every account the run checks that automatic preparation is on, not paused
for today, and that the budget still allows; an empty credit balance or a Console limit blocks the pipeline's web
research for the day too. No pop-up at the end, one Activity Log line (*"Automatic web research: ..."*). The bar
says what the web side is doing: *"... resumes around 09:06 PM · web research goes on (3 of 20 accounts)"*, or
*"· no account needs web research just now"*, *"· web research is off"*, *"· web research budget used up"*.

**First automatic run (1.2.0.10, 2026-10-01, 20 accounts):** US$4.32, about **US$0.22 per account** - twice the
planning figure (traded US$0.26 / 28 s, others US$0.18 / 21 s); about 165 people added (6-16 per account), LinkedIn
profiles from search results for 46 of 117 (39%). Ready went from 146 to only 147: most of these accounts still need
the LinkedIn re-check of their company id (391 accounts in all), which only LinkedIn can do. **1.2.0.12 (Boaz): at
most 5 people per research** (`LANE_MAX_PEOPLE`), at the seniority levels chosen in Setup, most senior first - asked
in the prompt and enforced when the people are added.
**1.2.0.13 (Boaz):** the web lane first takes the accounts it can make Ready on its own - LinkedIn company verified,
a verified relevant contact the only thing missing (`onlyContactMissing`, `webLaneOrder`'s `readyByWeb`) - then
traded, priority and listing order as before.
**Second automatic run (1.2.0.13, 2026-10-01, 20 accounts):** US$4.10, about US$0.205 per account; 72 people
added (the cap works), profiles from search results for 38 of 83 (46%); **Ready 147 -> 158** - about US$0.37 per
Ready account, no LinkedIn visit. The cap hardly moved the cost: it is the research reading search results and
pages (input), not the people. **1.2.0.14 (Boaz):** a research that asks only for contacts runs on **Haiku 4.5**
(`LANE_CONTACTS_MODEL`, half Sonnet 5's token price; searches unchanged at US$0.01) - expected about US$0.11-0.12 per
account; the Activity Log line says "Haiku", to compare people and profiles found with the Sonnet runs.

**As built (step 5, 1.2.0.15) - the wizard proposes.** Branch `feature/onboarding-step5` (off step 4).

- **About you** is the new step 1 (13 numbered steps): your name (`userProfile.name`), your company's name (new key
  `sellerCompanyName`, now also the seller Web Discovery leaves out), the website (`companyWebsite`, moved here from
  What you sell), the Anthropic API key (shown only while none is saved) and the output language (the Settings one).
  A box offers *"Research my company (about US$0.30)"*; Next without it gives today's wizard (R4.3).
- **The research** (`researchSeller`, agent-shared.js): Sonnet 5 through the lane's call helper (basic tool versions
  first, thinking off), web fetch 6 x 8,000 tokens, web search 3, one `DATA:` answer with a URL on every item (3.3).
  Two additions to the answer: `idealCustomer` (the Ideal customer draft) and a `sector` per customer industry,
  picked from the wizard's closed list of 11 GICS sectors - the wizard's industries are sectors, so exact-name
  matching alone would almost never tick one. Texts come in the output language, keys and country names in English.
  It runs in the wizard page (not the background): a heartbeat marks a research whose page was closed as interrupted.
- **The progress screen** (3.6) lists each page read and each search as it happens (`onToolInput`, new in
  `streamWebResearch`), the cost so far, Stop and Skip research; on the answer it goes on to Location. Failed,
  stopped or cut off: Try again or Continue without research. **Deviation:** Stop keeps nothing from the call that
  was stopped - the answer arrives as one `DATA:` line at the end, so a stopped call has none (proposals of an earlier
  research stay).
- **`setup-proposals.js`** (pure, 37 checks): countries (picker names, aliases, local names, ISO codes, DACH /
  Benelux / Nordics; "Europe" is too broad - dropped and named in the note), size bands (stated numbers, else size
  words; a band counts only when the range really overlaps it), industries (only the wizard's sector names; every
  industry the wizard has no exact name for goes to the Ideal customer text), organisation types (set to Yes),
  titles (de-duplicated, at most 10), keywords (only words that recur across the titles), seniority (incl. "CTO"),
  resources (only pages on the seller's own domain or a subdomain), exclusions (name + website or source page, the
  seller never itself, de-duplicated across the three lists).
- **`proposal-ui.js`**: the banner (*"Proposed from acme.ch/about, ... - keep it, change it or clear it. Next accepts
  what is on screen."*, or *"Nothing found on acme.ch for this..."*), Research again with a hint (only that step's
  answer keys, fewer uses, about US$0.10), and the checklist (checkbox, editable text, rank up/down, Add). Used for
  offers, exact titles (ranked), keywords and exclusions; ticked items come first, then the lines typed in the box.
- **First setup vs completed before (R4.5):** on a first setup a step's proposal is put into the form when the step
  opens, once per visit; on a setup completed before, it is shown beside the current setting (*"Research proposal
  ... the current setting stays as it is unless you use the proposal"*, with the proposal's values) and taken only
  with **Use proposal**; checklist items start unticked unless already saved. A proposal counts as accepted when the
  step is saved (`setupResearch.accepted`), after which its ticks show what is saved. About you shows a proposal
  only when the website's language differs from the output language (*"Use German"*).
- Exclusions found by the research are stored by name and domain with `source: "research"` and `sourceUrl`.
- Every research writes one Activity Log line (cost, time, pages read, searches, steps with a proposal) - the
  measurement that replaces the US$0.30 estimate.
- Not in this step (step 6/7): initiative stages, included companies, targets, Finish kicking both lanes, the
  Settings offer for existing installs (3.12).

Checked outside Chrome with a stand-in for `chrome.storage`: the wizard loads; a finished research pre-fills every
step and saves through Next; unticking removes, rank order is kept; on a completed setup nothing changes until Use
proposal; the progress screen streams a (simulated) answer to Location; Stop ends on Try again / Continue. **Not yet
run against the real API** - that is Boaz's check: a clean profile with 3 real company websites.

**1.2.0.16 (Boaz, 2026-10-01):** on a setup completed before, nothing led to About you - he looked for the company
and website in Settings > User Profile (name, title, email), and the wizard opened on the last step reached. Now the
User Profile card says where the company and website are set, with **Open About you** (Change Settings opened on that
one setting, `onboarding.html?mode=settings&step=about`), and Setup opens on About you for an install that has never
filled it in (no company, no website, no research).

**1.2.0.17 (Boaz, 2026-10-01) - group websites.** The first real research (TIMETOACT, a Swiss company on the group's
site `timetoact-group.ch`) proposed the whole group's seven countries; the team sells in Switzerland only. Now the
research answers for the company named on About you, and marks each country `scope: "company"` or `"group"`;
`setup-proposals.js` ticks the website's own country first (country-code domain: `.ch` -> Switzerland, `.co.uk` ->
United Kingdom; `.com`/`.eu` say nothing), then the company's countries, and names the group-only countries in the
note (*"Countries where only the group works, not ticked: ..."*). The website's country alone is not a finding: with
no country in the answer the step still says "Nothing found". 7 new checks (445).

**1.2.0.18 (Boaz, 2026-10-01):** the Industry step's organization types read as if private and publicly traded
companies were missing. Retitled *"Organization types other than companies"*, with the first line saying companies are
always included, and each type has a hover tip on what it covers (e.g. *Civic and Social Organizations*: associations,
federations, chambers, clubs).

**1.2.0.19 (Boaz, 2026-10-01):** Things you can offer is titled *"What can you offer a lead to start a conversation?"*,
and its proposal box says what the items are for (a give-away in a message to a lead, a reason to reply). Checklist
items are no longer struck through when unticked - the text stays normal and a ticked item is bold.

**1.2.0.20 (Boaz, 2026-10-01):** ticking offers and pressing Save left them in the checklist, so the save looked as if
it had not worked. The box below is now the list of offers: Save (and coming back to the step) moves the ticked
proposals into it, and the checklist keeps only the proposals not taken yet. Change Settings has **Previous** and
**Next** beside Save again; each saves the open setting first and stays put while it has an error.

**1.2.0.21 (Boaz, 2026-10-01):** Target contacts works the same way: proposed titles and keywords not yet in their box
are listed above it, and Save moves the ticked ones into the box. The up/down rank of proposed titles is dropped (a
box keeps the order of its lines) - a deviation from R3.1.5's ranked titles, by Boaz's choice.

**First real research (1.2.0.15, 2026-10-01, timetoact-group.ch):** US$0.34, 45 s, 5 pages read, 1 search, proposals
for all 9 steps - in line with the US$0.30 estimate, which stays until more researches are measured. Boaz went through
every step on 1.2.0.21: no further comments. **Step 5 DONE.**

**As built (step 6, 1.2.0.22) - the full onboarding.** Branch `feature/onboarding-step6` (off step 5). The wizard
now has 15 numbered steps, in the order of 3.1.

- **Initiative stages** (step 11, `initiativeStagePreference`): the seven stages as a ranked checklist - tick, and
  move up/down with arrows, each with a one-line tip. At least one must stay ticked. The web lane's prompt names the
  ticked stages in the user's order and asks it to leave out the others (only when they differ from all seven in
  the default order), and an initiative counts towards the target only at a ticked stage; one with no stage
  (imported before 1.2.1) still counts (`initiativeCounts`).
- **Companies to include** (step 12, `includedCompanies`): one per line, *"Name, https://website"*, the name alone
  or the website alone. Each line is shown as read; one that is also on the exclusion list is flagged in red and is
  not added (the exclusion wins). Web Discovery adds them first, before any listing, with no web call and no size or
  industry filter; they count towards the accounts it was asked for. The run's report says how many were added,
  already in the list, or left out as excluded.
- **How big should your list be?** (step 15, `completionTargets`): accounts (10-2000), contacts per account (1 to the
  Target contacts step's maximum per account) and relevant initiatives per account (0-5); an out-of-range number is
  an error on Next. Below the fields, the live estimate from **`onboarding-estimate.js`** (new pure module): it counts
  the accounts still to find (target minus the live accounts) and still to build (target minus Ready). Its
  defaults are the measured figures, not section 9's first guesses: discovery US$0.02 an account, research
  US$0.12-0.22, 25 s an account over four workers, 2.6 LinkedIn touches an account at 60 a day. For 100 accounts on a
  clean install: *"about 4-5 days of your daily LinkedIn limit and about US$14-24 on your Anthropic API key ... usable
  within the hour"*. Once 20 accounts have gone through a lane on this install, its own average takes over (R8.3,
  key `onboardingMeasures`, added to by the web lane per account and by Web Discovery per run).
- **Finish:** the web budget is pre-filled from the estimate, rounded up to whole US$5, never lowered below what is
  set, with a note of the estimate beside it. With automatic preparation ticked, Finish sends
  `ONBOARDING_BUILD_START`: the background (`startOnboardingBuild`, pipeline-runner.js) runs Web Discovery for the
  accounts owed and, when it ends, the web lane for up to the accounts target, both paid from the monthly web budget;
  with nothing to discover the web lane starts at once. The LinkedIn pipeline is kicked as before. Discovery from
  Finish ends with its usual pop-up.
- **The stop rule (8):** `targetsStatus` (pipeline-plan.js, pure) counts Ready, Usable and In progress accounts
  against the targets and returns `discover` / `enrich` / `idle`. On every automatic kick (after the setup is
  finished, not paused, web budget available) the pipeline runs Web Discovery quietly for what is owed - **once per
  accounts target** (`discoveryMayRun`, key `autoDiscoveryLast`): again only when the target is raised (R6.5) or a
  week later. This bounds the cost when listings have nothing more to give; without it, accounts that wait for a
  decision would make every kick look short. Enrichment needs nothing new: the web lane and the pipeline already
  ask only for what an account lacks, now against the user's targets instead of the defaults.
- **Coverage lines (R6.4):** under the Target Accounts pie - *"Your targets - Accounts: 87 of 100 in the list.
  Contacts: 52 of 87 accounts have 3. Initiatives: 40 of 87 accounts have 1 relevant initiative."* (`coverageLines`).
- The three new keys are in the settings backup.

Checked: new pure-module checks for targets, stages, the stop rule and the estimate (477 in all); the wizard in the chrome.storage stand-in - the new steps, ranking
and unticking, the exclusion flag, the contacts cap error, the live estimate at 100 and 250 accounts, the budget
pre-fill (US$60 for 250), the confirm summaries, and Finish sending `ONBOARDING_BUILD_START`. **Not yet run in
Chrome:** the full onboarding in a clean profile with 100 accounts - Boaz's check.

**1.2.0.23 (Boaz, 2026-10-01, during the clean-profile test):** **Use proposal** gave no sign that anything
happened, nor whether Save was still needed. The button now turns into *"Used ✓"* with a green line: *"The proposal is
now in the form below and saved - no need to press Save. Change it if you like, or go on with Next."* (the step saves
itself a moment later); on About you, *"German is now your output language and saved"*. **Companies to include** could
read as "list all your target customers here": it now says SalesTeam builds the target list itself from the setup's
criteria, and this step is only for companies wanted in the list whether or not the research finds them.
Also in 1.2.0.23: an automatic Web Discovery is marked done for its target (`autoDiscoveryLast`) when it **ends**, not
when it starts - a run cut off by an extension reload is started again by the next kick for what is still owed
(before, it would have waited a week).

**1.2.0.24 (Boaz, 2026-10-01):** the Exclusions step's proposal box says what excluding does: *"An excluded company
never shows up in your Target Accounts, and its people are never searched for leads. A post from a competitor,
recruiter, customer or partner that a keyword scan finds is marked Irrelevant."* (Companies excluded as *Other* have no
such post filter - a keyword-scan post from one of them still comes through; raised with Boaz.)

**1.2.0.25 (Boaz, 2026-10-01):** a fifth built-in lead filter, *Other Excluded Companies* (`builtin-other-exclusions`,
source list `others` -> category `other`, on by default, added to existing installs by the `getNegativeTopics`
backfill), so an excluded company is never a lead whatever its category. The Exclusions note now says: *"An excluded
company never shows up in your Target Accounts and is never scanned for leads: its people are not searched, and a post
from it that a keyword scan finds is marked Irrelevant."*

**1.2.0.26 (Boaz, 2026-10-01, on his main profile):** the Targets step said *"your list already has 100 Ready accounts"*
with 121 Ready - it now gives the real count. In Change Settings it also says when automatic preparation or automatic
web research is off (*"... so SalesTeam does not build the list towards these numbers until you turn it on"*): raising a
target there otherwise did nothing, silently. (A setup completed before has no Finish button - Change Settings saves
each setting on its own; the full onboarding is tested in a clean profile.)

**1.2.0.27 (Boaz, 2026-10-01, clean profile):** Things you can offer said *"Nothing found on timetoact.ch"* and *"16
more found without a page of their own"*: the website typed was timetoact.ch, but its pages live on the group's
timetoact-group.ch, so every resource failed the own-domain test. `isOnDomain` (setup-proposals.js) now also accepts a
**sibling domain of the same brand** (`sameBrandDomain`): the name parts before the ending are equal (acme.ch / acme.de)
or one is a hyphen-part of the other (timetoact / timetoact-group), at least 4 letters; any other domain is still
refused. A research stored before is mapped again from its saved answer when the wizard opens (local, free), so its
dropped offers come back without a new research. 9 new checks (487).

---

## 12. Decisions — all agreed (D1-D9 2026-09-28, D10 2026-09-29, D11 2026-09-30)

Boaz agreed to every recommendation below.

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Usable pie: one slice (with *not yet on LinkedIn* in the tooltip and a tag in the table) or two slices | **One slice** — two Usable slices invite the question which one to work on, and both are workable |
| **D2** | Contacts from the web: verify one by name, then one People-page visit — or one name search per web contact | **One by name, then People page** (7.2): about 1 touch less per account |
| **D3** | Discovery margin 15% and the 7-day wave threshold (~200 accounts) | **Yes**, both replaced by measurements after the first runs |
| **D4** | Four web workers, as in bulk research | **Yes**; more raises the 429 risk for little gain |
| **D5** | Traded companies first, by the listing's or the research's `isPublic` | **Yes** (R7a.1) |
| **D6** | Build step 0 (the write lock) ships alone as 1.2.0.1, because it fixes a risk in the version already in the store's queue | **Yes** — it is small and independent of everything else |
| **D7** | Raise the pipeline's LinkedIn ceiling (e.g. 60 → 75) after onboarding to build faster? | **No** — the Scanner needs **10 Ready** (was 5, soft gate), and the pipeline goes for the first 10 Ready before anything else (7.3). The ceiling stays 60, guaranteeing at least 39 touches for scans; touches per scan are measured in step 4. Boaz's proposal, 2026-09-28 |
| **D8** | Use touches left under the 60 at night (e.g. 01:00–05:00) for extra LinkedIn work? | **No change.** The pipeline already resumes whenever it is under 60 in the rolling 24 hours, day or night, while Chrome and a SalesTeam page are open. Night adds no capacity (a touch at 03:00 counts until 03:00 next day). Not added: a background timer without a page open, or keeping the computer awake at night (1.2.0 D4 stands; unseen 03:00 activity would contradict "visible in your browser") |
| **D9** | Discovery for medium or small companies instead of the largest | **Size-band listings, the target split by band priority, centre of each band first** (4.3). Bands stay the wizard's S/M/L/XL/XXL, shown with their ranges on the Size step. Boaz's proposal, adapted 2026-09-28 |
| **D10** | The LinkedIn ceiling of 60 makes Ready slow (about 5 visits per account: company page, People page, one search per contact) | **The web lane collects LinkedIn links from search results** - the company page and each named person's profile - at no LinkedIn visit. A profile link found that way **counts towards Ready** (the contact's verified date is the day the web showed it); LinkedIn is visited only to confirm the company page and for what the web did not find. Expected: about 1-2 visits per account instead of about 5. The ceiling stays 60. Boaz's choice, 2026-09-29 |
| **D11** | Find new accounts on the web (listings) or with the LinkedIn company search? | **The web first, LinkedIn optional.** Web listings find the accounts; the LinkedIn company search is an option (off by default) for about a fifth of the target, because it finds mostly local branches of international groups. LinkedIn first was tried the same day and dropped: its free company search does not hold the location filter, and the country-name keyword it then needs matches company names, so the list is neither reliable nor complete. Boaz, 2026-09-30 |

---

## 13. Not in this design

- Salesforce import (later item, decided).
- LinkedIn Discovery started by the pipeline on its own (postponed, decided). Onboarding's own account discovery does
  offer it as an option for local branches of international groups (D11, 2026-09-30).
- The initiative-stage ranking as a weight in priority scoring (requirements, open question 7).
- Team use (1.2.2).
