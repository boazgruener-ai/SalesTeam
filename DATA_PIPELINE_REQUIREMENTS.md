# SalesTeam — Data Pipeline & Readiness: Requirements

Target release: **1.2.0**
Status: **Requirements — for review.** Design and implementation follow separately.
Date: 2026-09-22

---

## 1. Why this exists

SalesTeam has accumulated roughly a dozen data-maintenance actions — Import Research Workbook,
Resolve LinkedIn Company IDs, Fetch Company Size, Discover Contacts, Find & Merge Duplicates,
Extract Companies, Extract Companies & Locations from Profiles, Research Accounts on the Web,
Resolve Web Findings Automatically, Prioritize Companies, Prioritize Unscored Leads, Re-score All
Priorities, Apply Location Filter.

Each one was justified on its own. Together they are an operations manual rather than a product.

**These are not twelve tools. They are one pipeline with a dependency graph, exposed as twelve
nouns.** The ordering between them is real, not arbitrary: a company's size cannot be fetched
without a LinkedIn link, the link comes from the resolver, and prioritisation must run last because
it reads what all the others wrote. The user has been handed a build system in the shape of a menu
and asked to be the scheduler.

No salesperson can reasonably be expected to know that after an import they should run actions 2,
4, 5, 7, 8 and 9 in that order, then spend hours monitoring and reviewing the results.

**The decisive fact that makes this fixable: the system already knows when each job has work to
do.** `getTargetAccountsMissingLinkedinId()`, `getCompaniesNeedingSize()`,
`getExistingCompaniesNeedingContacts()` and their siblings already answer "is there anything
outstanding?" Nothing needs to be asked of the user to find that out.

**This is a redesign of the workflow, not of the work.** The code that does the actual work already
exists and largely stays. What changes is what decides to run it, when, and what the user is shown.

---

## 2. The product promise

> SalesTeam delivers a **verified, quality-controlled set of accounts, contacts and leads** that a
> salesperson can act on without having to check it first.

Two failure modes sit either side of that promise, and the requirements below exist to avoid both:

- **Shipping unreliable data.** Half-cleaned, half-complete data with missing priorities, absent
  LinkedIn profiles and unknown company sizes will not make customers happy, and quietly destroys
  trust in everything else the tool says.
- **Making the customer wait.** A new user who has just paid for SalesTeam cannot be told to come
  back in a week while their data is processed.

**The stated preference, which drives the whole design: a smaller understood subset of solid,
cleaned, verified data beats a large set with critical fields missing.** 100 reliable accounts is a
better product than 500 unreliable ones.

---

## 3. Core concept: readiness is a property of each account, not a phase of the project

This is the idea that resolves the tension in section 2, and most of the requirements follow from it.

Readiness is **not** a global state the whole dataset passes through. It is computed per account
from which fields are present and verified. Each account is therefore in one of:

| State | Meaning | Shown to the user? |
|---|---|---|
| **Ready** | Every field needed to work the account is present and verified. | Yes — this is the working set. |
| **Usable** | Enough to act on (identity, LinkedIn, at least one contact, a priority), with some enrichment still missing. | Yes, marked as such. |
| **Incomplete** | A critical field is missing or unverified. | No — it is in the pipeline, not in the user's way. |

**Consequence: the user does not wait for all 500 accounts. They start working the moment the first
ones cross the bar, and the working set grows underneath them.** The pipeline runs continuously in
the background; readiness is recomputed as data arrives. Time-to-first-value becomes hours, not a
week, without ever showing anyone a half-finished account.

This also gives the quality bar a place to live that is enforceable rather than aspirational: a
field either meets the standard or the account is not offered as Ready.

### 3.1 What "Ready" means, concretely: whatever the Scanner needs

The bar is not a matter of taste. **The Scanner is the product's main advantage, it is the one
source we want every user to run, and it can only work on accounts that are already complete
enough.** Garbage in, garbage out: the quality of the leads it finds is bounded by the quality of
the accounts it was given. So the definition of Ready is simply *what the Scanner requires*.

That is already written down in code rather than opinion. `getScanTargetCompanyIds()`
(`storage.js`) selects the accounts a scan will actually cover, and it filters on exactly:

- a resolved **`linkedinCompanyId`** — without one the account is invisible to the Scanner, full stop;
- a **`salesTeamPriority`** of P1–P5 within the chosen scope — an unscored account is invisible at
  every scope except "all";
- present in the workbook, not deleted, not excluded.

And because priority is itself computed from **`globalEmployees`** and **`globalHqCountry`**
(`computeCompanyDeterministicPreScore`), those two fields are transitively required as well — an
account with a priority derived from missing firmographics has a number, but not a trustworthy one.

**R3.1** — An account is **Incomplete** when the Scanner cannot see it at all: no resolved LinkedIn
company id, or no priority.

**R3.2** — An account is **Usable** when the Scanner can include it — id and priority both present —
but its priority rests on unverified or missing employee count or HQ country, or it has no contacts.

**R3.3** — An account is **Ready** when the Scanner can include it, its priority rests on *verified*
employee count and HQ country, and it has at least one contact with a LinkedIn profile, so that a
post's author can be matched to a known person rather than only to a company.

**R3.4** — The readiness bar and the Scanner's selection must be derived from **one** definition. If
they are allowed to drift, the tool will promise accounts as Ready that the Scanner then silently
skips — the most damaging failure available to us, because it is invisible.

### 3.2 The field tiers — and why two of them are conditional

Not every field earns the same standing, and the interesting discovery is that **some fields are
mandatory only because of how the user configured their own targeting.** The readiness bar is
therefore *computed from the Setup wizard's configuration*, not hardcoded.

| Field | Tier | Why |
|---|---|---|
| `linkedinCompanyId` | **Mandatory** | No id, no scan. Absolute. |
| `salesTeamPriority` | **Mandatory** | Unscored accounts are outside every scope but "all". |
| `globalHqCountry` | **Mandatory *if* a target region is set** | Feeds `resolveLocationPriority`. If the user targets the whole world with no location priorities, it gates nothing. |
| `globalEmployees` | **Mandatory *if* size priorities are set** | Feeds `resolveSizeBucket`. |
| `industry` | **Mandatory *if* industry priorities are set** | `computeCompanyDeterministicPreScore` only reads it when `targetUniverseConfig.industries` holds a matching entry. Otherwise it changes nothing. |
| Matched contacts | **Strongly recommended — see R3.6** | Far more load-bearing than it looks. |
| Registry fields, revenue, HQ city | **Nice to have** | Read by nobody who decides anything. |

**R3.5** — The readiness bar is **derived from the user's own targeting configuration**. A field that
cannot affect any decision for this user must not hold an account back from being Ready. Requiring
industry from a user who never set an industry priority would manufacture Incomplete accounts for
no benefit.

### 3.3 Contacts are not a nice-to-have — they dominate the score

Checking the actual weights in `computeCompanyDeterministicPreScore` changes the tier this belongs
in. Starting from a baseline of 50:

| Signal | Contribution |
|---|---|
| Location priority | ± 8 |
| Size priority | ± 8 |
| Industry priority | ± 8 |
| **1 matched contact** | **+18** |
| **2 matched contacts** | **+25** |
| **3+ matched contacts** | **+30** |

**Matched contacts are the single largest term — one contact outweighs location, size and industry
combined.** The consequence matters: an account with no contacts is systematically scored lower, and
a lower score means a lower priority band, and a lower band can put it **outside the Scanner's P1/P2
scope entirely.**

So "no contacts" does not merely weaken lead prioritisation. **It can make the account invisible to
the Scanner altogether** — by the same mechanism, though one step removed, as having no LinkedIn id.

**R3.6** — Contact discovery is part of getting an account Ready, not an optional enrichment after
it. An account with a resolved id and a priority but no contacts is **Usable, never Ready**.

**R3.7** — What matters is *relevant* contacts, not a count. The Scanner's value comes from matching
a post's author to a known, senior, relevant person: a post about an AI initiative from a Head of AI
at a high-fit company is worth far more than the same post from an unknown author. The contact bar
should therefore be expressed against the seniority levels configured in the Setup wizard — at least
one contact matching them — rather than as a bare number.


---

## 3a. The shape of it

![The pipeline as a ring: four sources entering at different points, the working set in the middle.](docs/pipeline-ring.png)

The pipeline is **cyclic, not linear**. Drawing it as a left-to-right sequence would imply an end
that does not exist:

- accounts that do not clear the readiness gate go round again;
- verification expires (R5.3), so even a Ready account eventually re-enters for re-enrichment;
- the Scanner never stops producing signals.

**The four sources enter at different points**, according to what each actually produces — this is
the detail that prose keeps losing. The imported workbook arrives as unverified breadth and enters
at Collect. LinkedIn Discovery arrives already identified, so it enters at Resolve identity. Web
Research adds depth to accounts already held, so it enters at Enrich.

**None of them is a one-off.** A workbook is imported more than once, Discovery and Web Research are
re-run as the universe grows, and the Scanner runs continuously — hence the small repeat loop on
each source in the diagram. Treating them as setup-time events would be the same mistake as drawing
the pipeline as a line.

**The Scanner is not merely an input: it both reads and feeds the working set.** It consults the set
to know which accounts to scan — they must already carry a LinkedIn company id and a priority — and
returns signals to that same set. It is the only source inside the loop rather than feeding it, and
that feedback is precisely why the readiness bar is defined as what the Scanner needs (section 3.1).

The diagram is generated, not drawn by hand: `python code/gen_pipeline_diagram.py` writes both
`docs/pipeline-ring.svg` and `docs/pipeline-ring.png` from one layout, so the two cannot drift.

---

## 4. Data sources

Data does not only arrive by import. There are four sources. **None is mandatory, none is exclusive
of the others, and each can deliver data at a different stage of the pipeline.**

| Source | Cost | Constraint | What it produces |
|---|---|---|---|
| **Imported research workbook** | free, instant | none | Breadth: many accounts and contacts at once, unverified |
| **LinkedIn Discovery** | LinkedIn touches | daily touch budget | Company and contact identity, authoritative |
| **Web Research** | US$ per account on the user's API key | API budget / spend limit | Depth: firmographics, initiatives, registry data |
| **Scanner** | LinkedIn touches | daily touch budget | Intent signals — posts and jobs indicating a reason to act |

**The Scanner is different in kind from the other three, and the design must reflect it.** The other
three produce *entities* (accounts and contacts) and converge — once an account is enriched, there
is nothing more to do until the data ages. The Scanner produces *signals*, which are time-sensitive
and never stop arriving. It is also SalesTeam's main advantage and the one source we actively want
every user to run.

So the pipeline has **two different clocks**: entity enrichment, which converges and then idles, and
signal capture, which is continuous. They should not be modelled as the same kind of job.

**The Scanner also depends on the pipeline's output in a way the others do not.** Discovery and Web
Research work on whatever they are pointed at; the Scanner can only scan accounts that already have
a resolved LinkedIn company id and a priority. It is therefore both the pipeline's most valuable
consumer and the clearest measure of whether the pipeline is doing its job — if the Scanner has few
accounts to scan, the pipeline has not delivered, whatever the raw account count says.

---

## 5. Provenance and what "verified" means

"Verified, reliable, quality-controlled" has to be made precise, or it cannot be enforced.

**R5.1** — Every field that can come from more than one source must carry, alongside its value:
its **source**, an **evidence quality**, and a **last-verified date**.

**R5.2** — A field counts as *verified* when it has a source, an evidence quality at or above a
configured threshold, and a last-verified date within a configured freshness window.

**R5.3 — Staleness must expire verification.** A field verified on 2026-09-05 is trustworthy today
and will not be in eighteen months. Without a decay policy, "verified" silently becomes false over
time and the quality promise erodes invisibly. A field whose verification has expired returns to
unverified and re-enters the pipeline.

**R5.4** — Where several sources disagree, reconciliation must be automatic wherever the difference
cannot change any decision, and must reach the user only where it genuinely can. The web-findings
arbitration built in 1.1.3 is the first instance of this and should generalise from "web research
versus stored" to "any source versus any source".

**Note: the schema is already part-way there.** Contacts carry `evidenceQuality` / `lastVerified`
and a second `evidenceQuality2` / `lastVerified2` pair for LinkedIn; companies carry
`Global_Revenue_Confidence` and `Revenue_Period`; a LinkedIn-fetched headcount is distinguishable by
`employeeCountText`. Provenance partly exists — it is neither systematic nor surfaced.

---

## 6. Functional requirements

### 6.1 Jobs become descriptors, not buttons

**R6.1.1** — Each existing maintenance action is described declaratively: an id, a user-facing
label, the jobs it depends on, a selector answering *what work is outstanding right now*, a cost
estimate, and the runner that already exists.

**R6.1.2** — Execution order is **derived** from declared dependencies. It is never hand-maintained
and never asked of the user.

**R6.1.3** — A job whose selector returns nothing does not run and is not mentioned. Adding a
capability later must not add a menu item or a decision for the user.

### 6.2 Three tiers of exposure

**The boundary between tiers is not cheap-versus-expensive. It is provably reversible versus not.**

**R6.2.1 — Silent.** Deterministic, local, no external call, no judgement: value cleaning, currency
normalisation, linking already-resolved records, reconciling differences that cannot affect any
decision. These run without being asked for and without being announced individually.

**R6.2.2 — One consent, one batch.** Anything that spends money or LinkedIn touches. A single
dialog, a single budget, a single progress indicator, a single summary — not one per job.

**R6.2.3 — Support only.** Every individual action remains available for a support engineer, for
debugging, repair and emergencies, in the existing muted Advanced tools group. It is not part of the
normal user's surface.

**R6.2.4** — Anything silent must be reversible, logged, and reported in aggregate. See section 8.

### 6.3 Entry points, not tool menus

**R6.3.1** — After any source delivers data, the user is asked **at most one question**, phrased as
an outcome and priced in their terms. For example: *"112 companies have no employee count, 24 are
not linked to LinkedIn, 380 have never been researched. Getting these ready will use about 91
LinkedIn page views and about US$38. [Start now] [Overnight] [Not yet]"*.

**R6.3.2** — Declining must be safe and repeatable. The work stays outstanding and the offer can be
accepted later.

**R6.3.3** — Findings that require human judgement are presented as a **queue** with next / skip /
keep, not as a table the user must know how to filter.

### 6.4 Scheduling policy

**R6.4.1 — Depth-first, not breadth-first.** Given a limited budget, the pipeline completes the
highest-priority accounts fully rather than partially enriching everything. This is the direct
implementation of "100 solid beats 500 broken", and it inverts today's behaviour, where
"Fetch Company Size for all 142" is breadth-first by construction.

**R6.4.2 — Priority is circular, and the resolution must be explicit.** Priority is computed *from*
enriched data, yet it determines enrichment order. Resolution: compute a provisional priority from
whatever is available, enrich in that order, and re-score as data arrives.

**R6.4.3 — The pipeline is resumable across days.** The LinkedIn touch budget (75 warn / 99 hard,
shared across every automated feature) means a full pass over a 500-account universe **cannot**
complete in one day. The pipeline is therefore a persistent queue that resumes where it stopped, not
a single run.

**R6.4.4** — The user is told the truth about progress and duration: *"38 accounts ready, 63 more
tomorrow"*. Never a spinner with no end in sight.

**R6.4.5** — Existing budget guards, the single-batch mutex and the cross-page progress bar with a
Stop button are reused, not replaced.

---

## 7. Working with incomplete data

**R7.1** — SalesTeam must function with whatever data it currently has. The pipeline never blocks
the product.

**R7.2** — The working set shown to the user contains only Ready and Usable accounts (section 3).

**R7.3** — Pipeline progress is visible but not intrusive: the user can always see how many accounts
are ready, how many are being worked on, and what is waiting.

**R7.4 — The quality gate must not become a wall.** A new user with nothing yet Ready must still see
what is happening and when to expect results, rather than an empty screen.

---

## 8. Audit, undo and restore

**R8.1** — Every automated action — cleaning, arbitration decisions, merges, enrichment, scoring —
is written to the Activity Log with enough detail to reconstruct what happened: the account, the
field, the value before and after, the source, and the rule or job responsible.

**R8.2** — Batched logging is mandatory for high-volume jobs. Single-entry logging reads the entire
local store per call and cannot be used in a loop.

**R8.3** — Every batch job has its **own** undo slot. A shared slot means one routine action
silently destroys another's undo.

**R8.4 — Point-in-time restore (may follow in a later stage).** Before each batch job, the current
data state is written to disk as a snapshot, and the user can later restore to the state as of a
given date and time — in the manner of database backups. The existing automatic-backup mechanism and
its folder structure are the basis for this.

**R8.5 — Snapshots must carry a schema version, and a restore across incompatible versions must
refuse with an explanation rather than proceed.** A restore that half-works is worse than one that
declines.

---

## 9. Non-goals and explicit risks

**N9.1 — Automate the action, never the discovery.** Silent automation removes the user's ability to
notice when it is wrong. The USD/CHF currency-pair defect found in 1.1.3 was caught only because a
human was looking at a preview table; had it run silently on import, the affected accounts would
have been quietly wrong indefinitely. Anything silent must be reversible, logged, and reported in
aggregate — *"cleaned 284 values, 3 looked unusual, here they are"*.

**N9.2** — No live exchange-rate service, no server, no change to the extension's no-backend
position.

**N9.3** — This does not change the LinkedIn usage posture: user-initiated, visible in the browser,
paced, within the daily touch limit.

**N9.4** — Not a rewrite of the jobs themselves. They keep working as they do.

---

## 10. Open questions for the design stage

1. ~~What exactly makes an account Ready?~~ **Answered (sections 3.1–3.3): whatever the Scanner
   needs, computed from the user's own targeting configuration.** What remains is narrower — the
   freshness thresholds in R5.2, and the exact contact bar in R3.7 (how many, at what seniority).
2. **How large is the starting subset?** Is the first target a fixed number (100), a priority tier
   (all of P1), or whatever can be completed in the first 24 hours?
3. **How much consent is enough?** One approval per pipeline run, per day, or a standing
   "keep my data ready" setting with a budget cap?
4. **Freshness windows.** How long does each kind of field stay verified — headcount, revenue,
   contacts, LinkedIn identity? These plainly differ.
5. **Scanner integration.** Signals are continuous and entity enrichment converges; do they share
   one budget and one queue, or two?
6. **Migration.** What happens to an existing installation whose 541 accounts have never been
   assessed against a readiness bar?

---

## 11. What already exists and is reused

Worth stating plainly, because the remaining gap is smaller than it appears:

- `batch-jobs.js` — the single-batch mutex and busy guard.
- `batch-status.js` — the cross-page progress bar with a Stop button.
- `withBatch()` — already wraps all ten long-running jobs uniformly.
- The per-job selectors that answer "what is outstanding" — already written.
- The Activity Log, plus batched appending added in 1.1.3 — the audit spine.
- `buildAutoBackup()` and its Daily / Manual / Before-restore folder structure — most of the
  restore story.
- `web-findings-arbitration.js` — the reconciliation model, ready to generalise.
- `value-normalize.js` — the cleaning and currency layer.
- `syncLinkedinLinksToWorkbook()` called from `loadWorkbook()` — **the silent-repair pattern already
  working in production**, and the model for tier 1.

**The missing piece is the scheduler.** `batch-jobs.js` enforces "one job at a time"; nothing yet
decides *which* job, or *what next*.
