# SalesTeam — Onboarding Research: Requirements

Target release: **1.2.1** (test builds 1.2.0.1, 1.2.0.2 …)
Status: **Requirements — agreed 2026-09-28** (one proposal, R7.6's discovery buffer, to be confirmed in design). Design and implementation follow separately.
Date: 2026-09-28

---

## 1. Why this exists

A new user today has two ways to get from an empty install to a list of target accounts, and both
are poor:

- **Answer the Setup wizard from a blank page.** Eleven steps (Location, Size, Industry, two
  prioritisation steps, What you sell, Things you can offer, Ideal customer, Target contacts,
  Companies to exclude, Company aliases), each asking for something the user has to write out
  themselves, although most of it is already on their company's website. Then run LinkedIn
  Discovery, which can only search countries and industries that have a live-confirmed LinkedIn
  code.
- **Leave SalesTeam for ChatGPT.** Paste the Master Prompt (V1.34, some 5,000 lines), answer its
  questions (most of them the same questions the wizard just asked), wait while it researches, download
  an Excel workbook, come back and import it.

Boaz's verdict on the second path (2026-09-27): unfriendly, and a turn-off. It is also the path that
produces the best data, because it researches the seller before asking and searches the web for
accounts rather than only LinkedIn.

**The observation that makes this fixable: SalesTeam already has almost every part of what ChatGPT
does, on the user's own Anthropic API key.** It researches an account on the web with cited sources
(`researchAccountOnWeb`, 1.1.3). Since 1.2.0 its pipeline makes accounts Ready by itself, within a
daily LinkedIn limit and a monthly web budget. What is missing is three things:

1. research of **the seller** (the user's own company), turned into proposed wizard answers;
2. **finding accounts on the web** (discovery), not only enriching accounts already held;
3. **targets** that tell the pipeline how much is enough, so that it knows when to stop.

---

## 2. The product promise

> Enter your name, your company and its website. SalesTeam proposes your setup, you confirm or
> change it, and it builds your target account list in the background. No other tool is needed.

Two failure modes sit either side of that promise:

- **Proposals passed off as facts.** A wrongly proposed competitor that ends up excluded, an invented
  value-add offer that the AI later mentions in a message, an industry mapped to the wrong LinkedIn
  code. Each is small; together they destroy trust in the setup the user just "confirmed".
- **Surprises in time and money.** 400 accounts at 3 contacts each is **weeks** of LinkedIn budget
  and **tens of US dollars** of web research. If the user learns that only afterwards, it feels like
  a trick. (Note for the record: web research is not free. It runs on the user's Anthropic API key.)

---

## 3. Core concepts

### 3.1 Propose, never presume

This is the Master Prompt's "research before asking" principle (its section 1.4A), carried over
because it is the part that made ChatGPT's setup feel intelligent rather than laborious.

**R3.1.1** — Before a wizard step asks for something, SalesTeam checks whether the answer can be
found on the seller's website or other public sources. If it can, the step opens **pre-filled with a
proposal** instead of empty.

**R3.1.2** — A proposal is always **visibly marked as a proposal**, with the sources it came from,
until the user moves on with Next. It is never silently treated as confirmed configuration.

**R3.1.3** — The user can accept a proposal as it is, edit it, clear it, or ask for it to be
researched again. Pressing Next with a proposal on screen is the acceptance.

**R3.1.4** — A step with nothing to propose looks exactly as it does today. Research is an
improvement to the wizard, never a prerequisite for it.

**R3.1.5 — The Master Prompt's setup, with better controls (decided 2026-09-28).** The wizard asks what
the Master Prompt asks, in a similar order and with the same research-first proposals, but the
answer is given by direct manipulation, never typed as a command. In ChatGPT the user had to write
*"Remove 1, 4, 5, 8"* or *"item 1 rank 3, item 2 rank 1"*. In SalesTeam:

- a proposed **list** is shown as items with a **checkbox** each (include or not), plus Add;
- where order matters, each item has a **rank** that can be moved up or down;
- a single choice is a set of buttons or a dropdown, with the proposal preselected.

Section 5a maps each Master Prompt step to its wizard step.

### 3.2 Two clocks: configuring takes minutes, building takes days

Setting up and building the account list run on different clocks, and the design must not blur
them:

| | Configure | Build |
|---|---|---|
| **Where** | The Setup wizard, in the foreground | The 1.2.0 pipeline, in the background |
| **How long** | Minutes | Days to weeks, depending on the targets |
| **Limited by** | The user's attention | The daily LinkedIn limit and the monthly web budget |
| **Researches** | The seller | The accounts |

**R3.2.1** — The wizard never waits on the Build clock. It finishes in minutes, and the first Ready
accounts appear within the first hour (as in 1.2.0, R12.3.3).

### 3.3 Targets turn "keep ready" into "build until enough"

The 1.2.0 pipeline works on whatever accounts exist and stops when they are Ready. It has no idea how
many accounts the user actually wants. With discovery added, it needs one: otherwise it either
stops at zero (nothing to work on) or never stops (there is always another company on the web).

**R3.3.1** — The user sets **completion targets** (section 6). The pipeline discovers and enriches
until the targets are met, then goes back to idling on new data and expired verification, exactly as
1.2.0 does.

### 3.4 Web first, LinkedIn straight after — a change to 1.2.0's "Usable" (decided 2026-09-28)

**R3.4.1 — No LinkedIn during onboarding.** The wizard makes no LinkedIn visits (the Discovery scan it
offers at the end today leaves the onboarding path). LinkedIn search and enrichment start
**immediately when the wizard is finished**, under the standing consent given on its last step.

**R3.4.2 — Web-researched accounts are Usable before LinkedIn has seen them.** An account found and
researched on the web, with a cited source for its identity (name, website, HQ country), its
firmographics and why it fits, and a priority, is **Usable**: it appears in the working set, marked
*not yet verified on LinkedIn*. It becomes **Ready** only when LinkedIn has confirmed the company page
and the rest of 1.2.0's bar is met.

**This changes 1.2.0's definition.** In 1.2.0 (R3.1–R3.2) an account without a LinkedIn company id
is Incomplete and hidden, and Usable means *the Scanner can include it*. From 1.2.1, Usable means
*worth working on*, and a Usable account may not yet be scannable. **Confirmed by Boaz on 2026-09-28.** The Scanner's own selection
(`getScanTargetCompanyIds`: a LinkedIn id and a priority) does not change, so 1.2.0's R3.4 (one
definition for both) still holds for Ready. Whether the Usable pie slice is split into *on LinkedIn*
and *web only* is a design question.

**R3.4.3 — The Scanner starts from a few Ready accounts**, as 1.2.0 already decided (R12.3.4: a
minimum of 5 Ready, with the numbers stated when there are fewer). Web-only accounts never count
towards it.

---

## 4. The new start of the wizard

**R4.1 — A new first step, "About you".** It asks for:

| Field | Stored as | Notes |
|---|---|---|
| Your name | Profile name (exists, Settings > User Profile) | Used in signatures and drafting already |
| Your company's name | **new** | Needed to research the seller, and to recognise the seller's own company if it turns up in discovery |
| Your company's website | `companyWebsite` (exists, currently asked in "What you sell") | Moves to this step |
| Anthropic API key | exists (Settings) | Asked here only if not already set, because all research runs on it |

**R4.2 — One research pass, stated in cost before it runs.** After "About you", SalesTeam researches
the seller once: the website itself and a few web searches. The expected cost is shown on the
button before it starts (*"Research my company, about US$0.30"*; the real figure is to be measured in
design). The result is stored, so going Back and Next again does not repeat it.

**R4.2a — The user waits for it (decided 2026-09-28).** The research runs on a progress screen (one to
two minutes) that says what is being read (*"Reading acme.com/customers…"*), and the wizard continues
when every proposal is in. It never opens a step half-filled.

**R4.3 — Without a key, nothing is blocked.** A user with no API key, or who chooses **Skip
research**, gets today's wizard with empty fields and every step working. Research can be started
later from the same step.

**R4.4 — Research again, per step.** Each step that received a proposal offers **Research again**
(with an optional hint from the user, e.g. *"focus on our consulting services, not the software"*),
which re-runs only that step's part.

**R4.5 — Existing users are never overwritten.** When the wizard is re-run by someone who already
has settings, a proposal that differs from the saved value is shown **next to** it, as *current* and
*proposal*, and the saved value stays unless the user takes the proposal. (Wording rule: never
"your" for account data; name the two sides.)

**R4.6 — Offered once to existing installs, from Settings (decided 2026-09-28).** After the update to
1.2.1, a user who completed the wizard before is offered the seller research **once**, from Settings
(*"Research my company and propose improvements to my setup"*), with its cost stated. Accepting runs
the research and shows the proposals side by side with the current setup (R4.5). Declining is
remembered and not asked again; the action stays available in Settings.

---

## 5. What gets proposed, step by step

| Step | What is proposed | The constraint that must hold |
|---|---|---|
| **Location** | The countries the seller sells into: offices, language versions of the site, where its case studies are | Only countries the picker offers. LinkedIn Discovery still searches only countries with a confirmed geo code; web discovery is not limited by that (section 7) |
| **Size** | Company size bands, from who the seller's case studies and customer logos are | Existing bands only |
| **Industry** | The industries of the seller's customers and case studies | **Only industries with a confirmed LinkedIn industry id are ticked.** Others found go into the Ideal customer text, never to a guessed id |
| **Organization types** | Where evident (e.g. a seller to hospitals or the public sector) | Existing types only |
| **Discovery / Leads prioritisation** | Not researched. Defaults as today | — |
| **What you sell** | A short description of products, services and the problems they solve | Written from the seller's site, in the output language setting |
| **Things you can offer** | Real resources found on the seller's site: reports, white papers, webinars, a free assessment or demo, **each with its link** | **Nothing without a link to the page it came from.** This step promises the AI will never invent an offer; a proposal must not break that promise at the source |
| **Ideal customer** | A drafted profile: size, geography, what they invest in, trigger events | — |
| **Target contacts** | Exact titles, title keywords and seniority levels of the seller's likely buyers | — |
| **Companies to exclude** | Competitors, existing customers (from logos and case studies) and partners, **by name and website, with the source for each** | **Name and website are enough for onboarding** (decided 2026-09-28): no LinkedIn visit, and a LinkedIn URL is never guessed. Exclusions therefore also match by name and website domain, not only by LinkedIn URL |
| **Company aliases** | Not researched | — |
| **Completion targets** | New step, see section 6 | — |

**R5.1** — Every proposal shows its sources as links, in the form *"Proposed from
acme.com/about, acme.com/customers"*.

**R5.2** — Research that finds nothing for a step says so on that step (*"Nothing found on acme.com
for this. Enter it yourself, or Research again with a hint."*) rather than leaving an empty field that
looks like a failure.

**R5.3** — Proposals are written in the user's output-language setting.

---

## 5a. The Master Prompt's steps, and where each one lives

Following R3.1.5, this is the Master Prompt's setup (V1.34, steps 1–15) against the wizard.

| Master Prompt step | In the 1.2.1 wizard |
|---|---|
| 1. Project & sales objective | **Not carried over.** SalesTeam's objective is fixed: target accounts and the leads found on them. The seller's identity comes from "About you" |
| 2. Language & localisation | The existing output-language setting, **proposed from the language of the seller's website**, shown on "About you" |
| 3. Geography | Location |
| 4. Target account universe size | Completion targets (section 6) |
| 5. Organization types | Organization types (within the Industry step) |
| 6. Industries | Industry |
| 7. Company size | Size |
| 8. Account inclusion list | **New, optional step: "Companies you want included"** — accounts the user already has in mind, which Web Discovery adds first and never filters out. Not researched: only the user knows them |
| 9. Exclusion list | Companies to exclude |
| 10. Contact targeting | Target contacts: proposed titles as a checklist with a rank each |
| 11. Prioritisation scoring model | Discovery and Leads Prioritization (unchanged) |
| 12. Initiative stage preference | **New step: "Which initiative stages suit you best?"** — the seven stages (Experiments / PoC to Very mature / technology-native) as a ranked checklist, proposed in the Master Prompt's default order. Used to judge which initiatives count towards the initiative target |
| 13. Evidence model | **Not a step.** 1.2.0's readiness bar and evidence threshold already are the evidence model; the Master Prompt itself says not to expose the formula during setup |
| 14. Completion targets | Completion targets (section 6) |
| 15. Final summary & launch gate | Confirm: every answer, the cost and duration estimate (R8.1), and the one standing consent (1.2.0 R12.2.1) |

---

## 6. Completion targets

**R6.1 — A new wizard step, "How big should your list be?"**, before Confirm. It sets three numbers:

| Target | Proposed default | Meaning |
|---|---|---|
| Target accounts | **100** (decided 2026-09-28). At section 8's rates: about 3–4 days and about US$17–20 | How many accounts the pipeline builds up to |
| Contacts per account | **3** | Contacts at one of the chosen seniority levels. Capped by the existing *Maximum contacts per target account* (10) |
| Initiatives per account | **1** | A relevant initiative found by web research, i.e. one that fits *What you sell* |

**R6.2 — Ready does not change.** Ready stays what 1.2.0 defined: what the Scanner needs (a
LinkedIn id, a priority on verified firmographics, **at least 1** contact at a chosen seniority
level). Targets sit **above** Ready: an account is Ready as soon as it can be scanned, and the
pipeline keeps working on it, within budget, until it also meets the per-account targets. This keeps
the time to the first Ready accounts short, whatever the targets.

**R6.3 — When the pipeline stops.** It stops **discovering** when the number of Ready accounts plus
accounts still in progress reaches the account target, allowing for the share that will end up
Lacking evidence. It stops **enriching** an account when the account meets the per-account targets,
or when its jobs have given up (1.2.0's two-days rule).

**R6.4 — Targets are coverage, not a wall.** Some accounts will never have 3 findable contacts or a
public initiative. The dashboard reports each target as coverage (*"Contacts: 212 of 400 accounts
have 3"*), and an account that cannot reach a per-account target is not held back from anything.

**R6.5** — Targets can be changed later in Settings. Raising one resumes discovery or enrichment;
lowering one never deletes anything.

**R6.6** — Budget and investment evidence is recorded where web research finds it, as today, but is
**not a target** by default. Revenue likewise stays optional enrichment.

---

## 7. Finding accounts on the web: a new source

LinkedIn Discovery already exists, but it finds companies only by LinkedIn's own filters (confirmed
countries and industries, size), and it knows nothing about fit. The Master Prompt's strength is the
opposite: it finds companies *because* they fit — a relevant initiative, a known pain, a subsidiary in
the target country — and it deliberately looks beyond lists of the largest companies (its section 25:
large private employers, local subsidiaries, regional headquarters, public bodies, universities,
hospitals, associations, and companies surfaced through relevant initiatives).

**R7.1 — Web Discovery is a fifth source**, next to the four in 1.2.0 (workbook, LinkedIn Discovery,
Web Research, Scanner). It searches the web for organisations that match the Ideal customer in the
target geography, using the seller research and the confirmed wizard answers.

**R7.1a — The initial list comes from company listings, not from LinkedIn (decided 2026-09-28).** The
first accounts are built from published listings of companies in each target country, found by web
search. For example:

- **rankings of the largest companies** in country X (*"top 100 largest companies in Switzerland"*,
  by employees or revenue), from business press, statistics offices and similar publishers;
- **business directories** that exist for every country, such as Dun & Bradstreet's;
- **official company registries**, such as Zefix for Switzerland and its equivalents elsewhere — these
  list every registered company but do not rank them, so they mainly confirm identity, legal name and
  address (the workbook's existing Registry fields);
- any other web source that answers the same question for that country.

Listings are the fastest way to a solid starting list: the companies on them demonstrably exist, and
the source already states size, HQ and often industry.

**R7.1b — LinkedIn is assumed, and checked afterwards.** Practically all companies on a national
top-100 list have a LinkedIn company page; one or two exceptions are expected and not a concern. The
list is therefore built without LinkedIn, and LinkedIn confirms each company after onboarding
(R3.4.1). An exception simply ends as Lacking evidence (R7.7).

**R7.1c — The listing is chosen to match the targeting.** A top-100-largest list fits a seller whose
size targets are large companies. If the wizard's size bands, industries or organisation types point
elsewhere (e.g. mid-sized manufacturers, hospitals), the search asks for listings of *those* (a
ranking by industry, a directory filtered by size, a list of hospitals), and the companies taken from
any listing are filtered by the wizard's size, industry and exclusion answers before they are added.
The fit-driven search of the Master Prompt (its section 25: subsidiaries, regional headquarters,
public bodies, companies surfaced through relevant initiatives) **adds** to the listings; it does not
replace them.

**R7.2 — Every candidate arrives with evidence**: name, website, HQ country, one line on why it fits,
and the source URL(s) it was found on. **A candidate without a source is discarded.** A LinkedIn
company URL is kept only if a cited source shows it, and even then it is **verified by the
pipeline's resolve job** before it counts. Nothing is ever guessed.

**R7.3 — Candidates enter at Resolve identity**, like an imported workbook, and merge automatically
(the silent tier, as for LinkedIn Discovery in 1.2.0 R12.6): logged, reported in aggregate
(*"Web Discovery added 38 companies"*) and undoable by the existing soft delete.

**R7.4 — Deduplication, before anything is added**, against:

- existing accounts (by LinkedIn id, website domain and normalised name);
- **accounts the user removed** — a removed account is never brought back by discovery;
- the exclusion list (competitors, customers, partners, recruiters), by LinkedIn URL, name or website
  domain;
- the seller's own company;
- candidates already rejected by the pipeline (Lacking evidence).

A candidate that matches an existing account **only by name** goes to the decision queue (as 1.2.0
R12.6.3 does for LinkedIn Discovery).

**R7.5 — Best fit first.** From the listings and the searches, discovery adds the strongest-fitting
organisations first, so that the first days of the Build clock produce the best accounts. This is 1.2.0's depth-first rule applied to
discovery.

**R7.6 — Discover only as far ahead as can be processed.** LinkedIn can process roughly 30 accounts a
day (section 8). Discovering 400 candidates on day one would spend money on candidates that wait two
weeks for LinkedIn, by which time the targets or the wizard answers may have changed. Discovery runs in
**waves**, keeping a buffer of a few days' LinkedIn work ahead of the pipeline.

**Proposed (not yet decided; Boaz had no preference):** when LinkedIn can clear the whole account
target within about **7 days** (roughly 200 accounts at section 8's rates), discover the full target at
once, plus a margin for accounts that will end up Lacking evidence. That covers the default of 100:
all 100 are found and researched on the web within hours of Finish, and become Usable (R3.4.2) while
LinkedIn works through them. Only above that does discovery run in waves, 7 days of LinkedIn work
ahead. The margin is measured in design.

**R7.7 — A candidate that cannot be found on LinkedIn** is not a Ready account and never will be (the
Scanner needs the id). After the resolve job has given up, it becomes Lacking evidence, with the
reason *"Not found on LinkedIn"*. This is also the backstop against a candidate the web search got
wrong.

---

## 7a. Researching each account: web first, LinkedIn last (decided 2026-09-28)

Once a company is on the list (section 7), it needs what the Ready bar and the targets ask for: its
**size in employees**, its **HQ location**, optionally its **revenue**, and then **initiatives** and
**contacts**. Most of this is published, and the web is the cheaper and faster place to get it.

**R7a.1 — Traded companies first, from their own filings.** For a publicly traded company, the annual
and quarterly reports and its press releases are the best single source for almost everything
needed: HQ location, employees, revenue, initiatives, management, budgets and investments. Web
research looks for these first. Traded companies are researched before the others.

**R7a.2 — Every account's own website is read.** For each company, research opens its website and takes
as much as is relevant from it: HQ location, number of employees (mainly for companies that are not
traded, where no filing gives it), initiatives, **C-level and management names with their titles**,
and a short summary of the company.

**R7a.3 — Private companies, non-profits, associations and public bodies come second.** They publish
less, so they are harder to complete from the web. They are researched after the traded companies,
and are expected to rely on LinkedIn more often for the fields the web did not give.

**R7a.4 — LinkedIn only fills gaps and verifies.** After the web research, LinkedIn is used for two
things only:

- **to find what is still missing** — for example the employee count of a private company whose
  website does not state it, or contacts where the web gave none;
- **to verify what the web research found** — the company page (which the Scanner needs in any case,
  R7.7) and the LinkedIn profile of each contact found on the web.

It is **not** used to re-fetch a field that web research already found with a cited source; 1.2.0 already
counts such a field as verified (1.2.0 R5.2).

**R7a.5 — Contacts found on the web are matched to LinkedIn by name.** A contact named on the website or
in a report (e.g. *"Anna Muster, Chief Operating Officer"*) is looked up on LinkedIn by name, which the
1.2.0 pipeline already does for contacts without a profile. It counts towards Ready (at least one
contact at a chosen seniority level with a LinkedIn profile) only once its profile is found. The
company's LinkedIn People page is searched only when the web gave too few contacts to meet the target.

**R7a.6 — Every value keeps its source.** Each value found (a report, a press release, a page of the
company's website) is stored with the URL it came from, as web research already does, so the user can
check it and the arbitration of 1.2.0 can compare it with a LinkedIn value.

**For the design stage:** reading reports and websites costs more per account than 1.2.0's three-search
depth research, while LinkedIn touches per account should fall (no size fetch when the web gave one;
fewer People-page searches). Section 8's figures are to be re-measured on this basis. Whether pages
are opened with a web-fetch tool or through search results is a design choice.

---

## 8. Time and money, told up front

These estimates come from measurements already made for 1.2.0 (DATA_PIPELINE_DESIGN.md section 9, and
the first live web run of 2026-09-28). They are **for this document only**; the design stage must
measure web discovery before any number is shown to users. They predate section 7a (web first, LinkedIn last),
which should raise the web cost and lower the LinkedIn touches per account.

| | Per account | For 400 accounts |
|---|---|---|
| LinkedIn touches (resolve, size, contacts) | about 1.7–2.15 | about 700–860 |
| Days, at the pipeline ceiling of 60 touches a day | — | **about 12–14 days** |
| Web research, depth (3 searches) | about US$0.15 | about US$60 |
| Web discovery | not yet measured; estimate US$0.01–0.03 per account kept | about US$5–15 |
| Seller research, once | — | under US$1 |
| **Total** | | **about US$65–75, over about two weeks** |

**Boaz's expectation of "hours" is not reachable for a list of this size** within the LinkedIn posture
agreed for 1.2.0 (a ceiling of 60 of the 99 daily touches, the rest kept for scanning). Web
research is not limited by LinkedIn and can run ahead, but an account is not Ready until LinkedIn has
confirmed it. What *is* reachable in hours: the first 20–30 Ready accounts, and scanning from the
first 5.

**R8.1 — The targets step shows the cost and duration live**, recalculated as the numbers change:
*"400 accounts: about 13 days of your daily LinkedIn limit and about US$70 on your Anthropic API key.
First accounts ready within the hour."*

**R8.2** — The monthly web budget from 1.2.0 (R12.7) stays the one control on spending. The targets
step **proposes** a budget that matches the targets, and the user sets it. The budget is never
exceeded; when it runs out, discovery and web research pause and say so, exactly as 1.2.0 already does
for web research.

**R8.3** — After the first week, the estimate switches from these figures to the measured averages
for this user (as 1.2.0 R12.3.2).

---

## 9. What stays as it is

- **The research workbook import stays**, as an option for users who prefer to research elsewhere.
  It leaves the wizard's main path and is offered from the Import menu (where the Master Prompt can
  also be copied).
- **HubSpot import and export stay.** Salesforce import is on the roadmap (2026-09-27), but
  **not in 1.2.1** (decided 2026-09-28): it is its own later item.
- **LinkedIn Discovery stays** as a source, started by the user as today. **Running it automatically
  from the pipeline is postponed** to a later item (decided 2026-09-28); in 1.2.1, Web Discovery is
  the only source the pipeline starts by itself.
- **The Ready bar, freshness windows, evidence threshold, decision queue, Lacking-evidence rules
  and the LinkedIn ceiling of 1.2.0 are unchanged.** Only the meaning of Usable widens (R3.4.2).

---

## 10. Non-goals and explicit risks

**N10.1** — No server, no SalesTeam-paid research. Everything runs on the user's own Anthropic API
key, as today.

**N10.2** — No change to the LinkedIn posture: the pipeline ceiling of 60 touches a day stays,
visible in the browser, paced, within the daily limit.

**N10.3 — Never guess a LinkedIn URL, geoUrn or industry id** — not for proposals, not for
exclusions, not for discovered candidates. Research may propose; only LinkedIn confirms.

**N10.4** — This is not a port of the 5,000-line Master Prompt. The rules that earned their place
there are carried over where they matter (research before asking; discovery beyond the largest
companies; one company identity across parent, subsidiary and brand; association headcounts not
counted as employees; source quality). The rest is already covered by the pipeline.

**Risks:**

- **Web discovery can return companies that do not fit, or do not exist.** Mitigated by R7.2 (a
  source for every candidate) and R7.7 (LinkedIn as the backstop). The design must measure the
  share of candidates that survive to Ready.
- **A wrong proposal accepted with a single Next.** Mitigated by R3.1.2 (proposals visibly marked,
  with sources) and by keeping the Confirm step, which lists every answer before Finish.
- **Rate limits.** A bulk web run is aborted today by an HTTP 429 from the Anthropic API
  (`bulk-research.js`). Web discovery must back off and resume rather than stop.
- **Public messaging.** The store listing, website and Help must describe the new research
  accurately: *public sources on the web, researched on the user's own API key*. No claim of LinkedIn
  ToS compliance, as always.

---

## 11. Open questions for the design stage

1. ~~**Waiting for the seller research.**~~ **Answered (2026-09-28): the user waits** on a progress
   screen (R4.2a).
2. ~~**Exclusions by name.**~~ **Answered (2026-09-28): name and website are enough** for onboarding;
   exclusions match by name and domain too (section 5, R7.4). Decided with it: no LinkedIn during
   onboarding, LinkedIn straight after, and web-researched accounts count as Usable (R3.4).
3. ~~**LinkedIn Discovery.**~~ **Answered (2026-09-28): postponed.** It stays a button the user
   presses; automatic runs from the pipeline come in a later item (section 9).
4. **Discovery buffer.** No preference from Boaz. Proposed in R7.6: the whole target at once up to about
   7 days of LinkedIn work, waves above that. To be confirmed in design.
5. ~~**Default account target.**~~ **Answered (2026-09-28): 100** (R6.1).
6. ~~**Salesforce import.**~~ **Answered (2026-09-28): later**, its own item (section 9).
7. ~~**Initiative stage preference.**~~ **Answered (2026-09-28): carry it over**, as a ranked list
   (R3.1.5, section 5a). How much the rank weighs in scoring is left to design.
8. ~~**Seller research on an existing install.**~~ **Answered (2026-09-28): offered once, from
   Settings** (R4.6).

---

## 12. What already exists and is reused

- `researchAccountOnWeb` (`agent-shared.js`) — Anthropic's server-side web search on the user's key,
  with cited sources and cost per call; the basis of the seller research and of Web Discovery.
- The 1.2.0 pipeline: `readiness.js` (the bar), `pipeline-plan.js` (which job next, depth-first
  ranking, giving up after two days), `pipeline-runner.js`, the LinkedIn resolve / size / contacts jobs.
- The web budget and consent (`pipeline-automation.js`, `webBudgetBlocker`) and the Billing page's
  measured cost averages (`api-usage.js`).
- `addWebResearchInitiatives` (`storage.js`) — where initiatives found on the web already go.
- The decision queue with its red dot, and `web-findings-arbitration.js` for conflicting values.
- The Setup wizard (`onboarding.js`), including the existing `companyWebsite` field and the Profile
  name in Settings.
- `research-prompt.txt` (Master Prompt V1.34) — the reference for what good setup research and
  discovery look like; not code to run.
- The soft delete (`deletedAt`), the Activity Log with batched logging, and per-job undo.

**The missing pieces:** the seller research and the proposal display in the wizard; Web Discovery as
a pipeline job with deduplication; the completion targets and the stop rule; and the live cost and
duration estimate.
