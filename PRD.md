# SalesTeam — Product Requirements Document

**Status:** Living document, reflects the shipped product as of v0.20.0.
**Note:** No PRD file existed for this project before this document — it was assembled now from the full
build history to serve as the canonical, up-to-date spec going forward. Update it alongside future features
rather than letting it drift from RELEASE_NOTES.md.

## 1. Problem

A B2B software/AI-services salesperson finds new leads by manually searching LinkedIn Posts and Jobs for
relevant activity (hiring signals, AI-adoption posts, etc.), then has to separately figure out who's worth
approaching, draft an opening message, and keep track of who they've already contacted — all by hand, with
no tooling built for this specific workflow. Existing CRM/sales-intelligence tools assume leads already exist
in a system; they don't help *find* them on LinkedIn in the first place.

## 2. Goals

- Turn a repeatable LinkedIn search into a one-click, multi-topic scan across both Posts and Jobs.
- Surface only real, addressable signal — automatically filter out competitors and recruiter/staffing noise
  that matches the same keywords but is never a prospect.
- Prioritize the result automatically, so the salesperson always knows what to work on first without having
  to ask an AI mentor the same question after every scan.
- Give the salesperson an AI team on top of the data: a mentor for strategy, a simulated buyer to pressure-test
  messages against, and reviewed (never auto-sent) drafting.
- Do all of this safely: manual-trigger only (no scheduled/background automation), nothing sent without
  explicit review, and destructive actions (bulk status changes) require deliberate friction.

## 3. Non-goals

- Not a full CRM. No pipeline stages beyond a simple status label, no deal value/forecasting, no team
  features (single-user, local-only storage).
- Never sends a message on the user's behalf. Drafts are generated for copy-paste only.
- No scheduled or background scanning. Every scan is a manual click, by design — this keeps the tool's
  behavior indistinguishable from a careful human user, not an automation bot, for LinkedIn ToS reasons.
- Not a general LinkedIn scraper — scoped to the Posts and Jobs search-results pages the user is already
  viewing, using their own authenticated session.

## 4. User

Grounded in a real B2B sales role in Swiss enterprise software/AI consulting: manually searching LinkedIn for
hiring/AI-adoption signals, contacting people who match, and needing a lightweight way to track who's been
approached without adopting a heavyweight CRM for a one-person prospecting workflow.

## 5. Architecture

Chrome/Edge Manifest V3 extension, no server of its own. Four pages share one `chrome.storage.local` dataset:

| Page | Purpose |
|---|---|
| **Scanner** (side panel) | Topics (positive search keywords) + Negative Topics (auto-filters), Job Search config, the scan trigger, and the raw results list. |
| **Dashboard** (tab) | The pipeline view — pie charts, a sortable/filterable/paginated lead table, per-lead detail page, bulk actions. |
| **Advisors** (tab) | Cross-lead Sales Mentor and Customer Voice agent chats, for strategy questions not tied to one specific lead. |
| **Settings** (tab) | Company context, Anthropic API key, message templates, output language, value-add offers — anything general-purpose, non-lead-specific. Home for any future general settings too. |

`background.js` (service worker) orchestrates scans: sequentially runs each topic's search in one background
tab, merges results, applies negative-topic filtering, optionally re-applies filters to existing leads, then
runs the automatic prioritization pass — before ever reporting the scan complete.

`agent-shared.js` is the shared AI engine (system prompts, tool definitions, the Anthropic fetch/tool-use
loop) used identically by the Scanner-era code, Dashboard, and Advisors — one implementation, not a drifting
copy per page.

## 6. Feature spec

### 6.1 Topics (Scanner)

- Named keyword groups, with an optional second "AND with" group (post must match one keyword from each
  group). Same shape reused for both Post topics and Job-specific topics.
- LinkedIn's own search-complexity limits are worked around automatically via query chunking (max 6 OR-terms
  per group, 9 total per sub-query) — invisible to the user, who just adds however many keywords they want.
- Author-title filter (checked client-side against each post's visible headline, never sent to LinkedIn) and
  an "include in-post job ads" toggle.
- **"Suggest Lookalike Topics"** button — looks at the salesperson's own highest-priority (P1-P3) **Post**
  leads and asks the Sales Mentor what made them strong matches, then suggests new keywords for finding more
  like them. Post leads only, deliberately: Job leads carry no scraped body text (only title/company/location),
  so there's nothing to generalize from beyond the title itself, and this only ever writes into Post Topics
  anyway. Review-first like everything else here: each suggestion shows its reasoning and lets the user add it
  to an existing Topic, create a new one, or skip it — nothing is written until explicitly accepted.
- **"Analyze Post Search Quality"** button (Search Quality section, after Negative Topics) — the actual fix
  for the problem Lookalike Topics can't help with (it only has good examples once Posts already score well).
  Looks at every unactioned (`"New"`) Post lead plus the current Topics *and* Negative Topics together,
  diagnoses what's likely limiting quality/volume, and proposes specific keyword changes across both —
  additions, removals, or a genuinely new Topic/Negative Topic. Same review-first pattern: each suggestion
  can be redirected to a different existing topic or accepted as new, and a removal referencing a keyword
  that's already gone is filtered out rather than shown as a broken action.

### 6.2 Negative Topics (Lead Filters)

- Same shape and matching logic as a positive Topic (keywords OR-group, optional AND-with group), but checked
  client-side against an already-scraped lead's own text *after* the search comes back — never sent to
  LinkedIn as a query, and never removes a search result, only marks it.
- Each topic has an `appliesTo` scope: Post leads only, Job listings only, or both — because a signal that's
  noise on one vertical (a recruiter's own post) is completely normal on the other (a job ad naming an HR
  contact).
- Two built-in topics, seeded by the Sales Mentor's own review of a real scan, cannot be removed but every
  field (keywords, AND-group, scope, enabled) is fully editable:
  - **Competitor Blocklist** (applies to both) — named competitor consulting/vendor firms.
  - **Recruiter/Staffing Headline Filter** (Post leads only) — headline phrases like "Talent Acquisition,"
    "Recruiter."
- The user can add unlimited custom negative topics for any other recurring noise.
- A match sets the lead's status to **Irrelevant** and records both the topic *and* the specific keyword that
  matched (`irrelevantReason`, e.g. `Recruiter/Staffing Headline Filter (matched "Recruiter")`), shown as a
  hover tooltip on the Dashboard's status pill — distinct from **Dismissed**, which is always the
  salesperson's own decision, never the system's.
- "Also re-apply these filters to existing leads on the next scan" checkbox (Scanner tile, unchecked by
  default, not a saved setting) — when checked, the next scan also re-checks every currently-"New" existing
  lead against the current negative topics, catching ones that predate a topic being added/edited. Never
  touches a lead already acted on.
- **"Apply Negative Filters" button** (Scanner tile, next to the Negative Topics list) — re-checks *every*
  existing lead against whatever's currently configured, instantly, with no new scan needed. Fully
  bidirectional: a "New" lead that now matches becomes Irrelevant, and an "Irrelevant" lead that no longer
  matches (because a keyword was edited or removed) reverts to "New" — the on-next-scan checkbox above only
  ever caught the first direction. Reports exactly how many leads moved each way. Never touches a lead already
  acted on (Contacted/Dismissed/Responded/Converted).
- A lead already marked Irrelevant, or missing a reason (pre-dates this feature), gets its reason backfilled
  automatically, best-effort, the next time it's read.

### 6.3 Lead data model & statuses

Every lead (Post or Job listing) carries: `status`, `statusUpdatedAt`, `priority` + `priorityReason` +
`priorityScoredAt`, `irrelevantReason` (if applicable), `company` + `companyExtractedAt` (if applicable),
plus source-specific fields (author/headline/snippet for Posts; title/company/location for Jobs),
`firstSeenAt`/`lastSeenAt`/`postedAt`, and `matchedTopics`.

Statuses: `New` (default) → `Contacted` (manual, or automatic the moment a drafted message is copied) →
`Responded` / `Converted` (manual) or `Dismissed` (manual) or `Irrelevant` (automatic, negative-topic match).

**Company.** Job leads get a clean `company` field straight from the scrape; Post leads never had one before
v0.17.0 — only a free-text headline (e.g. "Head of AI for IT @ Azqore"). After every scan, a batched AI call
extracts a best-guess company for every Post lead still missing one (silently skipped with no API key, same
pattern as prioritization), with a "🏢 Assign Company" row action to search every company already seen
(native browser autocomplete) or type a new one, or clear it. A manually-set or previously-extracted company
is never touched again by the automatic pass — `companyExtractedAt` is only ever set for an AI guess, cleared
on manual assignment, so a scan can never silently overwrite a human's correction.

### 6.4 Automatic lead prioritization

- After every scan's searches finish and negative-topic filtering has run (including any opted-in re-apply
  pass), every lead still `"New"` without a priority is sent to the Sales Mentor in **one batch call** (not
  per-lead), scored **P1 (highest — drop everything, contact today) to P5 (lowest — unlikely fit, low
  urgency)**, each with a short reason, via a forced structured tool call (not free-text parsing, so the
  output is always well-formed).
- Scoring weighs real fit against the configured company context, seniority/decision power, and genuine
  urgency signals — explicitly not just topical keyword overlap.
- Runs automatically, with no button — visible in the side panel as "prioritizing N new leads…" before "Scan
  complete." Silently skipped (never fails the scan) if no Anthropic API key is configured.
- Never re-scores an already-scored lead, or a lead that isn't `"New"`.
- **"Prioritize Unscored Leads" button** (Dashboard) catches up anything the automatic pass never reached —
  leads that predate the feature, or a scan that ran with no API key — scoring every unscored `"New"` lead
  across the *entire* list, not just what's currently filtered on screen.
- **Correlated re-scoring**: if a scan finds a new lead from the same person (Post leads, matched by profile
  URL) or same company (Job leads, matched by normalized company) as an existing `"New"` lead that's already
  scored, both get re-scored together in the same batch — a second signal from the same account can change
  the right priority. Still only ever touches `"New"` leads; anything already acted on is never re-scored.

### 6.5 Dashboard

- **Pie charts** (last 7 days / 30 days / all time), bucketed by each lead's real (parsed) post date, one
  colored slice per status; clicking a slice/legend row filters the table to that status.
- **Table**: Post Date, First Scanned, Source, Title, Content (3-line clamp, click to expand), Creator (link),
  **Company**, Connection, Status (with Irrelevant-reason tooltip), **Priority** (P1–P5 colored pill, tooltip
  shows the Mentor's reason), Last Activity, Actions (Open/Edit, Consult Mentor, Send Message, 🏢 Assign
  Company, Dismiss). Every sortable column supports click-to-sort and an Excel-style per-column dropdown (sort
  asc/desc, free-text filter). Column widths are user-resizable and persisted.
- **"Group by Company"** checkbox — Excel-style outline grouping inside this same table (not a separate view):
  a collapsible header row per company (name, lead count, expand/collapse caret) with its leads nested
  underneath; leads with no company yet collect into a trailing "Unknown company" group. Each company header
  has a **"Get Account Summary"** button — a one-shot AI synthesis across every lead seen at that account,
  cached per session so re-opening it doesn't re-call the AI. Forces "All" leads per page while active (a
  company's leads have to stay together), restoring the prior page size when turned off.
- **"Show Irrelevant (negative-filtered) leads" checkbox**, unchecked by default and persisted — the general
  "All statuses" view excludes Irrelevant leads so the table isn't dominated by filtered-out noise; explicitly
  selecting "Irrelevant" from the Status filter always shows them regardless.
- Pagination (20/50/100/All per page, remembered), global search (title/content/creator), CSV export (all
  leads, or exactly what's currently filtered — both include Priority).
- **Bulk Change**: a small, deliberately unobtrusive button (pagination row, not the main controls) opens a
  modal dialog — a red warning naming exactly how many currently-filtered leads will be affected, no default
  status pre-selected, a confirmation prompt on top of that, and an **"Undo Last Bulk Change"** button in the
  same dialog that restores every affected lead to its exact prior status (one level of undo, persists across
  Dashboard sessions until superseded by another bulk change). Closeable via a title-bar-style ✕.
- **Detail page** (per lead): full content, status control, Draft Message (template-based, AI-generated,
  copy-to-clipboard — copying auto-advances status New → Contacted), and a lead-scoped Consult Mentor chat
  (persisted per lead) with two quick-action buttons — "Buyer Summary" and "Conversation Starters" — that send
  the same canned request an equivalent typed message would, through the identical conversation/history/tools,
  so the salesperson doesn't have to type the same standard requests for every lead.

### 6.6 Advisors (Sales Mentor & Customer Voice)

- **Sales Mentor**: persona-configurable agent for cross-lead strategy questions ("which lead should I
  prioritize," general sales process advice) and drafting. Uses `list_leads`/`get_lead_details` tools only
  when a question actually needs real data — `list_leads` excludes Irrelevant leads and includes both Post
  and Job leads (tagged `type` + `hasIndividualContact`), instructing the Mentor to handle each appropriately
  (draft a message for a Post lead; suggest finding an individual contact for a Job lead).
- **Customer Voice**: persona-configurable agent that roleplays a realistic buyer, grounding itself in a named
  lead's real content when one is referenced, or a general persona otherwise.
- Both share one tool-use engine (`runAgentTurn` in `agent-shared.js`): bounded timeouts (2.5 min per
  conversational turn, 50s per tool call) with a live ticking status ("Thinking… (Ns)") so a genuinely long
  analysis reads as progress, not a hang — this exists because a truly stalled request previously hung
  indefinitely with no error.
- A stray Enter press while a turn is still in flight is a no-op (matches the Send button's disabled state) —
  previously this could start a second concurrent turn and silently lose a message.

### 6.7 Settings

Language (English/German), company context ("What We Offer," used by every AI feature to reason about real
fit), Anthropic API key, message templates (auto-picked per lead by connection status / job-ad detection, or
chosen manually), value-add offers (a fixed list the AI may mention, never invents). Opened via its own blue
button in the Scanner tile. The Advisors page reads these live (via `chrome.storage.onChanged`) rather than
caching a stale copy, since editing now happens on a separate page.

### 6.8 Backup / portability

Export/Import Settings (side panel) — everything above plus the full lead dataset, as one JSON file. API key
excluded by default (opt-in per export, for deliberately sharing a spend-capped trial key). An automatic
backup download fires before every scan, so a scan-time failure never loses accumulated data.

### 6.9 Help

A dedicated Help page (its own tab, opened from a "Help ↗" button next to Dashboard/Advisors/Settings): a
curated set of Q&A entries covering every feature above, plus a free-text search box. Search is deliberately
not an AI feature — no API key needed, instant, and answers are fixed/reviewed rather than generated. Matching
is token-overlap across each entry's question and synonym keywords (so "enable a Topic" and "disable a search
topic" surface the same entry) with light typo tolerance (edit-distance on individual words). Each result is
a collapsible card.

## 7. Non-functional requirements

- **Manual-trigger only** — no `alarms`, no background scanning, ever.
- **Local-first privacy** — all data in `chrome.storage.local`; the only outbound calls are to
  `linkedin.com` (reading pages already open) and `api.anthropic.com` (only when AI features are used, with
  the user's own key). No server operated by this project.
- **No remote code** — no bundler-fetched or eval'd remote JavaScript (a Chrome Web Store policy
  requirement); Dashboard's pie charts are hand-drawn inline SVG rather than a chart library for this reason.
- **Self-healing data migrations** — schema changes (e.g. the "Blocked" → "Irrelevant" rename, missing
  `postedAt`/`status` on old leads) backfill automatically on next read, never requiring a manual migration
  step or losing existing data.
- **Bounded AI calls** — every Anthropic fetch has a timeout; a stalled connection now fails with a clear
  message inside whatever bound is appropriate (2.5 min conversational, 45s draft, 50s tool execution)
  instead of hanging indefinitely.

## 8. Open items / known gaps

- LinkedIn's DOM structure for search results is unstable; content-script selectors need occasional
  maintenance when scraping breaks.
- Negative-topic and Author-title matching is keyword-based, not exact — a common word can over-match, which
  is why every automatic status change is reviewable and reversible, never a silent delete.
- No CRM push (Salesforce/other) yet — leads live only in this extension.
- Company grouping is normalized-string matching, not brand/subsidiary aliasing — it handles minor legal-suffix
  variation ("Azqore" vs "Azqore SA") but has no way to know that different names are the same company (e.g.
  "Google Inc." vs "Alphabet," "Facebook" vs "Meta"). A proper alias/merge mechanism is planned as later work,
  likely alongside a dedicated Companies view (deferred for now in favor of the in-table grouping above).
- Chrome Web Store submission was rejected once (v0.15.0, excessive `scripting`/`tabs` permissions that
  weren't actually used) and resubmitted after removing them (v0.15.1); awaiting review as of this writing.

## 9. Version history

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the full, dated changelog. Current version: **0.20.0**.
