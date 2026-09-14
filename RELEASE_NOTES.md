# SalesTeam — v0.30.0

## Added: unified LinkedIn safety budget - one shared 75/99 daily limit now actually governs (and stops) every automated feature, not just Post/Job scanning

- First phase of the Target Account & Contact Discovery plan (self-service company/contact discovery, replacing the manual ChatGPT-workbook workflow for new users - see PRD 6.20 for the full plan). This phase is self-contained: the daily automated-LinkedIn-activity budget that already existed (`linkedin-touch-log.js`, added v0.29.49 after a real "unusual activity" warning) was purely informational until now - hitting its old 100/day "danger" threshold only recolored a status label; nothing actually stopped. Decided directly: LinkedIn doesn't care which internal feature triggered a request, so one shared budget should govern every feature, with real enforcement, not just Post/Job/Target-Account scanning.
- Thresholds raised and tightened: warn at **75** (was 50), hard stop at **99** (was 100) - `TOUCH_WARN_THRESHOLD_24H`/`TOUCH_DANGER_THRESHOLD_24H` in `linkedin-touch-log.js`.
- New shared `touch-budget-guard.js` - `checkTouchBudget()` is the one place every LinkedIn-navigating module now checks the budget, and it sets the same `scanAbortRequested` storage flag every cooperative-stop check already watches, so hitting the limit in any one feature stops every other one running at the same time too, not just itself.
- Wired into `background.js`'s `checkAbort()` (governs Post/Job/Target-Account-scoped scanning), `company-resolve-extraction.js`'s per-company loop, and `people-search-extraction.js`'s per-author loop - the last of which had **no** abort check of any kind before this, a pre-existing gap closed as part of unifying the budget rather than left for later.
- Every affected status message and Activity Log entry now says plainly when a run stopped itself automatically ("daily LinkedIn activity limit reached - resume tomorrow") versus when the user clicked Stop themselves - distinguished by a `stoppedByTouchBudget` flag each module now returns, not silently conflated into the existing "stopped by you" wording.

## Fixed: a third Contacts-sheet schema variant (v28) - Source_URL and LinkedIn_Profile_URL removed, Profile_URL now holds the actual LinkedIn link

- The user had ChatGPT clean up the v25 workbook's low LinkedIn-link coverage; the result, `Swiss_AI_Prospects_500_v28_linkedin_profiles_verified.xlsx`, restructures the Contacts sheet a third way - `Source_URL` and `LinkedIn_Profile_URL` (the v24/v25 dedicated column, v0.29.65) are both removed, and `Profile_URL` (previously the company's own bio page) is repurposed to hold the actual verified LinkedIn profile link directly. Verified directly: 199 contacts, 183 with a `Profile_URL` that is a real `linkedin.com` link - matching the user's reported numbers exactly; 301/181/60.1% account-coverage figures unchanged from v25, as expected (contact links were cleaned up, not the contact list itself).
- `normalizeContactRows` (`storage.js`, generalized from v0.29.65's per-row `normalizeContactRow`) now detects which of three schema variants a workbook uses by checking, once per import across the whole `contacts` array, whether the `linkedinProfileUrl`/`sourceUrl` columns exist at all - a single row's blank cell isn't a reliable signal, since a blank cell may not even produce a key on that row (xlsx-lite.js). When both columns are absent (v28's shape), `profileUrl` is read as the LinkedIn link and then blanked on the normalized contact, so the "Bio Page" column doesn't show the same URL a second time under a now-inaccurate label.
- As with v0.29.65, this runs at import time - data already imported before this fix needs a re-import to pick up the corrected mapping.

---

# SalesTeam — v0.29.65

## Fixed: a newer workbook export's cleaned-up Contacts schema broke the "LinkedIn Profile" link

- The user imported `Swiss_AI_Prospects_500_v24_contacts_expanded.xlsx`, whose Contacts sheet schema changed: the old duplicate `Last_Verified`/`Evidence_Quality` header pair (which `lastVerified2`/`evidenceQuality2` were reading, v0.29.51) is gone, replaced by a single dedicated `LinkedIn_Profile_URL` column. Since the display code still read `lastVerified2`, the "LinkedIn Profile" link would have gone silently blank across the Account view's Contacts sub-table, the Target Contacts Dashboard's LinkedIn Profile column, and the Contact view's own overview - for every contact from this newer export.
- `importTargetAccountsWorkbook` (`storage.js`) now normalizes each contact row at import time: if `lastVerified2` is absent but the new `linkedinProfileUrl` is present, it's copied across. The three display sites (`CONTACT_COLUMNS`, `CONTACT_LIST_COLUMNS`, `renderContactView` in `target-accounts.js`) are unchanged - they don't need to know which workbook schema a given contact came from. The old schema's `evidenceQuality2` status text (e.g. "Current - LinkedIn verified") has no equivalent in the new one and is left blank rather than invented.
- Re-importing `Swiss_AI_Prospects_500_v24_contacts_expanded.xlsx` (or any future export) picks up this fix; data already imported under v0.29.64 needs a re-import to normalize, since this runs at import time, not on every read.
- Reported directly: the workbook's own "Dashboard" summary sheet confirmed 301 sufficiently-evidenced accounts, matching exactly. Direct inspection of the raw Contacts sheet found 169 total contact rows, of which only 22 have the new `LinkedIn_Profile_URL` populated (the remaining 138 populated rows have only the older `Profile_URL`, the company bio page, not a personal LinkedIn profile) - this doesn't reconcile against the reported "166 verified contacts," and no field or summary-sheet KPI in the workbook was found that produces 166. Flagged rather than guessed at.

---

# SalesTeam — v0.29.64

## Fixed: Target Contacts Dashboard had the same page heading/tab title as Target Accounts Dashboard

- Reported directly: this one page serves both dashboards via a hash-routed tab switch, not separate HTML files, but the `<h1>` and browser tab title stayed the static "SalesTeam Target Accounts Dashboard" no matter which list was actually showing - the two looked identical at a glance.
- `showListTab(tab)` (`target-accounts.js`) now updates both `document.title` and the `<h1>` text (wrapped in a new `#page-title-text` span so it can be updated without disturbing the adjacent version number) to match whichever list is active - "SalesTeam Target Accounts Dashboard" or "SalesTeam Target Contacts Dashboard," kept in sync with the same names used on the side panel's own buttons.

---

# SalesTeam — v0.29.63

## Fixed: two proposed pies turned out to be wrong/redundant on the facts - both corrected, not just removed

- Reported directly: the Target Contacts Dashboard's "LinkedIn verification" pie was wrong - every contact from a ChatGPT import already has a verified working LinkedIn link, so the pie would only ever show one 100% slice. A follow-up proposal (account coverage - how many accounts have at least 1 contact, "around 68/301 (22.6%)") turned out to already be the Accounts Dashboard's own Contact coverage pie, just needing a fix rather than a duplicate.
- New `isRelevantAccount(company)` (`target-accounts.js`) - the real fix both issues pointed at: a coverage/status stat that includes every "Insufficient - Missing baseline" account (roughly 200 of 500) alongside the ~300 genuinely-researched ones is misleading, since those accounts were never going to have contacts researched yet. The Accounts Dashboard's Contact coverage pie is now scoped to Rich/Sufficient Evidence accounts only, matching the ~301-company denominator reported directly.
- The Contacts Dashboard's broken LinkedIn-verification pie removed outright rather than replaced with an invented substitute - left as a single pie (Contact status) for now; Seniority or Function breakdowns would be reasonable next candidates if a 2nd pie is wanted later.

---

# SalesTeam — v0.29.62

## Fixed: no side panel button for the new Target Contacts Dashboard; reordered the nav buttons

- Reported directly: the Target Contacts Dashboard (v0.29.61) had no way to reach it from the side panel - it only existed as an in-page tab on the Target Accounts Dashboard.
- New "Target Contacts Dashboard ↗" button opens `target-accounts.html#contacts` directly - the exact same in-page hash route the tab bar itself uses, so it lands straight on the Contacts list rather than requiring a click-through from Accounts.
- Side panel button order changed to: Target Accounts Dashboard, Target Contacts Dashboard, Posts Dashboard, Advisors, Settings, Activity Log, Help - Help kept last per explicit instruction, to stay last as more buttons get added over time.

---

# SalesTeam — v0.29.61

## Added: Target Accounts Dashboard, a new Target Contacts Dashboard, and Posts Dashboard - three parallel, fully-named dashboards with pie-chart stats

- Reported directly, three linked requests: rename the Target Accounts hub now that it's the real starting point, add pie-chart stats there and on a brand-new Target Contacts list, and flag known Target Contacts on the Posts Dashboard's Creator column with a link to their Contact view.
- Naming: "Target Accounts Dashboard" / "Target Contacts Dashboard" / "Posts Dashboard" - three parallel, fully descriptive names rather than an ambiguous "The Dashboard," so the browser tab and page heading say which one you're looking at at a glance. File names unchanged, only display text.
- New `renderGenericPieChart(containerEl, slices, {unitLabel, onSliceClick})` (`target-accounts.js`) - same hand-drawn SVG technique as the Posts Dashboard's own pie charts, copied rather than generalizing the existing one (which is hardwired to lead-status buckets) to avoid any regression risk to an already-shipped chart. One implementation, reused for every pie on both new dashboards.
- **Target Accounts Dashboard**: four pies - AI Priority range (90-100/80-90/70-80/60-70/below-60/no-score, bucketing the real `aiPriorityScore` field), Evidence level (real workbook values: Rich Evidence/Sufficient Evidence/Insufficient - Missing baseline), Account status (Not contacted/Contacted/Responded - derived from each account's own associated leads, no new stored field), and Contact coverage (0/1-2/3+ known Target Contacts per account - proposed as the most actionable 4th pie given contacts research is still mid-rollout).
- **Target Contacts Dashboard** (new `#contacts` route in the same page): a full second sortable/filterable/paginated table across all Target Contacts (deliberately its own parallel state/render functions, not a generalized shared table widget - the Companies table's machinery is large and already working, and refactoring it risks regressing something the user depends on daily; the purely generic cell-formatting helpers it already had - `renderCellContent`, `formatValue`, etc. - are reused directly). Flag column (⚑) for an unreviewed post or overdue follow-up; row click opens the existing Contact view. Two pies: Contact status (same derivation as Account status) and LinkedIn verification (Current - LinkedIn verified/Legacy - LinkedIn reverify/Not verified, using the field the duplicate-header fix v0.29.51 made trustworthy). A small tab bar switches between the two list views, hidden on Account/Contact detail views.
- **Posts Dashboard**: `creatorCell` now calls `findTargetContactMatch` (exported from `storage.js`, already built for the priority-signal feature) and appends a "🎯 Target Contact" badge/link when a post's author is a known Target Contact - clicking it opens `target-accounts.html#contact=<key>`, the same cross-page pattern already used elsewhere (e.g. `openLeadInDashboard` in the opposite direction). Contacts loaded once at page init and refreshed on a live `targetAccountsWorkbook` storage-change listener, not re-fetched on every lead-list refresh.
- Not yet confirmed live - built and cross-checked (no dangling DOM IDs, no duplicate declarations, all braces/parens balanced) but not yet exercised in the browser.

---

# SalesTeam — v0.29.60

## Added: overview card fields now click-to-expand, same as the Posts Dashboard's truncated cells

- Reported directly with a screenshot: a truncated field (e.g. "Team Head Digital Workpl...") in the Account/Contact overview card should use the same click-to-expand/collapse behavior already used on the Posts Dashboard's own truncated cells (`dashboard.js`'s `contentCell`/`.content-cell`) - click to see the full value, click again to collapse.
- `buildField` (`target-accounts.js`) now takes an `expandable` flag - every plain-text field in the compact grid gets a `.overview-value-expandable` class and a click listener toggling `.expanded`, same pattern as `.content-cell`. Long fields (e.g. "Top AI initiatives", already shown full-width with normal wrapping) deliberately don't get this - truncating them to one line first would fight the point of breaking them out to their own row.
- Wired the same way the Dashboard does it: always active, not just when a value happens to be actually truncated - harmless no-op for a short value that already fits.

---

# SalesTeam — v0.29.59

## Added: pagination (20/50/100 per page) and a second horizontal scrollbar above the Target Accounts table

- Reported directly: 500 companies with no pagination was too much to scroll through, and both the page-size/navigation controls and the horizontal scrollbar to see columns off to the right should be reachable at the top of the table, not just the bottom.
- New `buildPaginationBar()` (`target-accounts.js`) - a page-size select (20/50/100) plus First/Previous/Next/Last buttons - built twice (identical content, since duplicate ids aren't valid HTML) and dropped into a container above and below the table, both acting on the same shared `pageSize`/`currentPage` state. Page size is persisted (same blob as the existing filter/sort state); every search, sort, or filter change resets to page 1 so a filter never strands the view on a now-empty later page.
- A thin scrollable strip (`#table-scroll-top`) sits above the table with a dummy filler matching the real table's `scrollWidth`, kept in sync with the table's own native horizontal scrollbar via a two-way scroll listener - scrolling either one moves both.

---

# SalesTeam — v0.29.58

## Fixed: a never-before-chatted-with account/contact showed a DIFFERENT account/contact's Mentor conversation

- Reported directly with a precise repro: chatted with the Sales Mentor inside a SIKA contact, then opened a never-before-seen Schindler Group account - the Mentor chat there showed the SIKA conversation instead of being empty.
- Root cause: `getTargetAccountExtra`/`getTargetContactExtra` (`storage.js`) returned a single shared, module-level `EMPTY_EXTRA` object as the "no data yet" fallback for every key. `Object.freeze` only locks an object's own properties - it does nothing to the arrays those properties point to - so every entity with no saved extra got handed back the exact same `mentorHistory`/`customerVoiceHistory` array objects. `runAgentTurn` mutates its history array in place (push), so the very first message sent anywhere polluted that one shared array for every other not-yet-saved entity in the same page session, not just the one actually being chatted with.
- Fixed by replacing the shared constant with `emptyExtra()`, a plain function returning a fresh object and fresh arrays on every call - used in both the read-fallback and the save-merge path in `getTargetAccountExtra`/`saveTargetAccountExtra`/`getTargetContactExtra`/`saveTargetContactExtra`.
- Checked the rest of the codebase for the same pattern: the pre-existing global (`advisorHistory`/`customerVoiceHistory`) and per-lead (`mentorHistory`) chat stores already return a fresh `[]` literal per call rather than a shared constant, so this was specific to the new account/contact extras store, not a wider issue.
- Confirms the intended design (already correct before this bug): per-account, per-contact, and per-post (existing lead-scoped Mentor chat) conversations are meant to stay fully separate, with the Advisors page's own chat staying separate too for generic/strategic questions with no specific account or contact in view.

---

# SalesTeam — v0.29.57

## Changed: Sales Mentor and Customer Voice chats now sit side by side (Mentor left, Voice right), stacking vertically only when the window is too narrow

- Reported directly: prefer the two chats side by side in a normal-size window, switching to vertical automatically once the window gets narrow.
- Both views' chat sections now share a `.agent-chat-row` flex container (`flex-wrap: wrap`, 24px gap) instead of stacking unconditionally - each `.agent-chat-section` gets `flex: 1 1 360px`, so the two columns sit side by side whenever there's room for both plus the gap, and the second one wraps below the first on its own once the window gets too narrow - no hardcoded breakpoint, the flex-basis plus gap IS the threshold.
- `#account-view`/`#contact-view`'s max width widened from 900px to 1200px so two real chat columns have actual room, not just the single-column width from before.
- No JS changes - element IDs are unchanged, this is purely a re-wrap in HTML plus new CSS.

---

# SalesTeam — v0.29.56

## Changed: Contact view's Posts/Web mentions/Recent Activity, and the Account view's Recent Activity, also default to collapsed

- Follow-up to v0.29.55's Contacts/AI Initiatives/Sources collapse - same goal, extended to the remaining list sections on both views so the whole page fits one screen with minimal scrolling.
- New `wireCollapsibleHeader` (`target-accounts.js`) applies the same ▸/▾ toggle to a static `<h3>` heading instead of a rebuilt-every-render button (`buildSubtable`'s own toggle) - wired once (idempotent, safe to call on every render) and reset to closed each time a different account/contact opens, so a section left open on one record doesn't stay open when navigating to the next.

---

# SalesTeam — v0.29.55

## Changed: Contacts/AI Initiatives/Sources default to collapsed on the Account view

- Reported directly: these sub-tables under the company header were pushing the Account view well past one screen - the goal is to fit a standard browser window with minimal scrolling.
- `buildSubtable` (`target-accounts.js`) now renders each section's heading as a clickable toggle (▸ closed / ▾ open) with the body hidden by default - clicking expands it in place, same content as before, just closed until asked for. Applies uniformly to Contacts, AI Initiatives, AI Investment, and Sources, since they all go through this one shared function.

---

# SalesTeam — v0.29.54

## Changed: Account/Contact overview redesigned as one compact card instead of one field per line

- Reported directly, with a reference screenshot: the overview should read as a single card across the page width, 3-5 fields per row, not a tall one-field-per-line list - the whole thing shouldn't take more than 4-5 lines.
- `buildOverviewList` replaced with `buildOverviewCard` (`target-accounts.js`) - short fields flow into a responsive grid (CSS `auto-fill`/`minmax`, not a hardcoded column count, since label lengths vary too much - "Type" vs. "Employees (Switzerland)" - for a fixed count to hold up at every width). A field marked `long: true` (paragraph text like "Top AI initiatives") gets its own full-width row below the grid instead, so a long value doesn't force the whole card wider or truncate badly.
- "Last contact made" and "Follow-up due" moved into the same card as regular fields, per a follow-up request - previously separate rows below it. The due-date `<input>`/Clear button live in the HTML as plain hidden elements outside the overview div specifically so they can be un-hidden and moved into a card field on every render (`dueDateFieldNode`) rather than recreated - `wireDueDateInput`'s event listeners stay attached to the same two elements throughout.
- Truncated short values get a hover tooltip (native `title`) so nothing is silently lost to the compact layout.

---

# SalesTeam — v0.29.53

## Added: Target Accounts Dashboard, Account view, and Contact view - a real rearchitecture, not an incremental tweak

- Reported directly: with real Target Accounts and now real Target Contacts imported, the externally-researched account/contact data is the actual primary asset - scanned posts are an enhancement on top of it, not the starting point. The Target Accounts Explorer evolves in place (same page, same filenames) from a flat table into a hash-routed hub: a priority-sorted, flag-annotated main dashboard plus a full Account view and Contact view per record, each with its own persisted Sales Mentor/Customer Voice chat. The Post view is unchanged - both new views link out to it rather than duplicating it.
- Two real conflicts resolved deliberately before writing code: the imported workbook blob is wholesale-replaced on every re-import (would wipe chat history/due-dates stored on those rows), and "overdue action" had zero precedent anywhere in this codebase. Decided with the user: account/contact data lives in separate storage keyed by the same stable `normalizeCompanyName()`/contact-name key already used for prioritization matching, and "overdue" is a manual due-date field, not an automatic staleness guess.
- New `storage.js` stores: `targetAccountExtras`/`targetContactExtras` (chat history + follow-up due date each), `findLeadsForContact` (every post by one contact, not just the first match), `hasUnreviewedPost`/`hasOverdueAction` (drive the new flag column), and two optional Activity Log fields (`relatedCompanyKey`/`relatedContactKey`) so a company/contact's own activity history can be filtered going forward.
- List view: unchanged columns/search/filter, already defaulted to AI Score descending - a new "⚑" column flags any account with an unreviewed post or a passed due-date. Row click now opens a full Account view instead of the old in-place row-expand.
- Account view: every requested overview field (official/alternative name, LinkedIn, industry, address, employees/revenue Global+Switzerland, AI Priority/Coverage/Budget, top initiatives), last-communication date, a follow-up due-date, Contacts (now clickable through to their own Contact view)/AI Initiatives/Sources sub-tables (reused from the Explorer as-is), Activity Log, and two chat panels.
- Contact view: name/title/LinkedIn/function/seniority/AI relevance, last-communication date, every post by this contact (linking to the unchanged Post view), web mentions, due-date, Activity Log, two chat panels.
- Four new prompt builders in `agent-shared.js` (`buildAccountScopedMentorPrompt`/`CustomerVoicePrompt`, `buildContactScopedMentorPrompt`/`CustomerVoicePrompt`). The contact-scoped pair deliberately embeds the parent account's own AI initiatives alongside the contact's role, per an explicit requirement - a drafted message needs to reference the real initiative ("I read that you are doing a project to automate your customer support..."), not just the contact's title.
- Two honest data gaps flagged, not invented around: no distinct "company website" column exists in the workbook (`primarySourceUrl` used as the closest stand-in), and the Sources sheet only joins by company, not by contact, so "web mentions" for a contact is just their own single `sourceUrl` field today. Both are future ChatGPT research asks, not code fixes.
- Not yet confirmed live - built and manually traced against real imported data (two known real matches, Christian Sebregondi/Zürcher Kantonalbank and François Réf/Geberit, should both flag and open correctly) but not yet exercised in the browser.

---

# SalesTeam — v0.29.52

## Added: Target Contacts now feed the Sales Mentor's prioritization as a signal - a post by a known, vetted decision-maker weighs heavily toward Priority 1

- Per the explicit decision behind this: one combined priority, no separate multiplier or second priority field - the signal feeds the same `prioritizeLeads` call as context, same pattern as the existing company-level `targetAccountSignal`, not a new deterministic auto-priority rule.
- `partitionLeadsByTargetAccount` (`storage.js`) now also matches a Post lead's own scraped author name against the imported Target Contacts data (the Contacts sheet, 6.12) - scoped to the same company first (`normalizeCompanyName`, the same key the `targetAccounts` map itself uses), then every word of the contact's (clean) full name must appear as a whole word in the author's scraped name. Deliberately tolerant of trailing credentials real people add to their own LinkedIn name (confirmed against real leads: "Katja Roelants du Vivier, MSc", "Vikram Verma PMP®, CSM") rather than maintaining a list of abbreviations to strip.
- `agent-shared.js`'s prioritization prompt now explains `targetContactSignal` to the Sales Mentor as a materially stronger signal than the company-level one alone - it confirms not just that the company fits, but that this exact person is already a vetted, researched decision-maker. A post from a confirmed Target Contact should typically land at Priority 1 unless the post's own content gives a real reason not to; a lead carrying both signals (high-priority company + confirmed contact + real post) is described as the strongest case a batch can contain.
- `tagPrioritiesWithTargetAccountSignal` (unchanged name, extended scope) now also prepends a `[Target Contact match: ...]` tag whenever a contact signal was present, so the connection is deterministic rather than relying on the model reliably mentioning it in free text - same reasoning as the existing Target Account tag.
- Confirmed working against real, already-saved data (zero LinkedIn contact): replaying the exact matching logic against today's leads and the newly-imported 83 Target Contacts found two genuine matches - Christian Sebregondi (Zürcher Kantonalbank, "Head Artificial Intelligence") and François Réf (Geberit, "Head of AI Competence Centre") - both exact name+company matches, not fuzzy edge cases. Not yet confirmed live through an actual prioritization run.

---

# SalesTeam — v0.29.51

## Fixed: duplicate column headers in the Contacts sheet silently overwrote real data; the Explorer's "LinkedIn" link pointed at the wrong URL

- Reported directly, checking the first real Contacts data (83 contacts, `Swiss_AI_Prospects_500_v19_contacts_enriched.xlsx`) before importing it: the Contacts sheet has two separate "Last_Verified"/"Evidence_Quality" column pairs with identical header text - a source-website verification date pair, then a distinct LinkedIn-verification pair (the actual verified profile URL plus a status like "Current - LinkedIn verified"/"Legacy - LinkedIn reverify"). `parseGenericSheetRows` (`xlsx-lite.js`) built a plain object keyed by header name, so the second pair silently overwrote the first with no error - and the Target Accounts Explorer's own "Profile" column was labeled "LinkedIn ↗" while actually reading `Profile_URL`, which in the real data is the company's own bio page (or empty), not LinkedIn at all.
- `parseGenericSheetRows` now suffixes a repeated header (`lastVerified`, `lastVerified2`, `lastVerified3`, ...) so every column's data survives under its own key instead of colliding - a general fix protecting any future relational sheet from the same silent-overwrite risk, not just this one.
- `CONTACT_COLUMNS` (`target-accounts.js`) updated to match: a new "LinkedIn Profile" column (the real verified URL, `lastVerified2`) and "LinkedIn Status" column (`evidenceQuality2`) now show what the label always claimed to show; the original date/quality pair is kept too, relabeled "Source Last Verified"/"Source Evidence Quality" so it's not lost, just no longer confused with the LinkedIn pair; "Profile" relabeled "Bio Page" since it usually isn't LinkedIn.
- Confirmed the other four relational sheets (Companies, AI_Initiatives, AI_Investment, Sources) have no duplicate headers in this workbook - only Contacts was affected.
- Nothing new to import separately: Settings' existing "Import Target Accounts" already parses the full workbook (companies *and* Contacts/AI_Initiatives/etc.) in one click - this fix just makes sure the Contacts data that lands displays correctly.

---

# SalesTeam — v0.29.50

## Fixed: neither CSV export had a real Company column - blocked a genuine analysis the JSON leads backup could already do

- Reported directly, while trying to measure whether the Target Account-scoped Post search phase (6.17) is actually improving the Post-vs-Job imbalance: the Dashboard's "Export Leads (CSV)" has no Company column for Post leads at all, and the side panel's own CSV export conflated "Headline / Company" into one ambiguous column that, for a Post lead, actually held the *headline*, not the company - the JSON leads backup already has both fields cleanly separate.
- `dashboard.js`'s `exportLeadsToCsv` gets a new `leadCompany()` helper and a dedicated "Company" column. `sidepanel.js`'s `resultsToCsv` splits its old combined "Headline / Company" column into two real ones - "Headline" (Post leads only, blank for Job listings, matching the existing convention) and "Company" (both lead types, sourced from `lead.company` the same way the JSON backup already does).
- Confirmed useful immediately: cross-referencing a fresh JSON leads export's now-consistent company data against the 500-company Target Accounts list found 41 of 65 new Post leads found in one day's scan (63%) were authored by someone at a Target Account company - real, direct evidence the Target Account phase is driving new Post lead discovery, not just a keyword-search coincidence.

---

# SalesTeam — v0.29.49

## Added: visible LinkedIn touch-volume counter, so heavy automated activity is never invisible again

- Reported directly: a single day of concentrated testing (one scan, one profile-extraction run, and nine separate company-ID-resolver runs spread from 00:54 to 12:23 UTC) triggered LinkedIn's own "unusual activity" account warning. Reconstructed after the fact from real timestamped data (not a guess): ~315 automated page visits that day - company-ID resolution alone (171) was the single largest contributor, more than the scan and profile-extraction combined, and it ran independently across the whole day rather than in one obvious burst.
- New `linkedin-touch-log.js` module records every real navigation from all four LinkedIn-touching sources (`background.js`'s scan, `profile-extraction.js`, `company-resolve-extraction.js`, `people-search-extraction.js`) as a trimmed rolling-window timestamp log, not a running total - kept as its own tiny file rather than folded into `storage.js` so modules that deliberately have no dependency on it (`profile-extraction.js`, `people-search-extraction.js`) don't reintroduce one.
- A persistent "LinkedIn touches (automated): N in the last 24h · M in the last 7 days" line now shows on both the side panel and Settings (Settings needed too, since the resolver - the biggest single contributor - can run there with the side panel closed), color-coded amber past 50/24h and red past 100/24h - both well below the ~315 that triggered the real warning. Refreshed on load, every 30s while the page stays open, and right after a scan/profile-extraction/resolver run finishes.
- Not a gate - nothing is blocked or throttled. The volume was already happening; it just wasn't visible until it was too late once. This applies to every install, not just this account - the same invisible-volume risk exists for anyone else running SalesTeam.

---

# SalesTeam — v0.29.48

## Fixed: AND-topic keyword matching required an exact singular/plural (and EN/DE conjugation) match - a configured "pilot" never matched a post's own "pilots"

- Reported directly with two real, on-topic Holcim posts (Lily Wong, AI leadership) that a configured AND-topic should have caught but didn't. Root cause, confirmed by replaying the exact matching logic offline against the real post text: `containsWholeWord`'s `\bkeyword\b` requires an exact whole-word match on *both* ends, so a configured singular ("pilot") never matches its own plural ("pilots"). The topic's own keyword list already showed a prior manual workaround for exactly this gap - both "project" and "projects" listed separately - just never generalized.
- `containsWholeWord` (`storage.js`, `content-script.js`, `jobs-content-script.js`) now only requires the *leading* boundary for keywords of 4+ characters, so one root keyword also matches its own grammatical family for free - "engineer" now matches engineers/engineering, "transform" matches transformation(s), German "Ingenieur" matches Ingenieur/e/in/innen/wesen/wissenschaften - with zero new keyword entries needed for any of those. Below 4 characters (AI, KI, ROI, GPT, LLM, PoC), both boundaries are still required - short acronyms are exactly as long as plenty of unrelated whole words (Aid, Air, Kind, Kiste) that would become false positives the moment the trailing boundary is dropped. `profile-content-script.js`'s own separate copy (used for a different, already-tuned location-detection heuristic) was deliberately left untouched.
- A few configured keywords in the "AI Transformation (EN + DE)" topic needed a *shorter root*, not just the suffix tolerance, to reach irregular forms: "implementation" → "implement" (also covers implemented/implementing); "automation" → "automat" (also covers automate/automated/automating); "development" → "develop" (also covers developed/developing); German "Implementierung" → "Implementier" and "Automatisierung" → "Automatisier" (both also cover their "-iert"/"-ieren" verb forms); German "Entwicklung" → "Entwick" (e-elision means "Entwicklung" and "entwickeln" only share this shorter prefix, not the full noun form). True synonyms that aren't grammatical variants at all - "PoC" vs. "Proof of Concept", "ROI" vs. "Return On Investment" - were added as separate entries rather than folded into the suffix mechanism, since "PoC"/"ROI" themselves stay short-and-strict.
- Offline verification (replaying the real topic keywords against the real post text, zero LinkedIn contact) confirmed the fix closes a genuine gap for one of the two reported posts ("pilot"/"pilots"); the other post already matched under the *old* logic too (a second, singular "use case" occurrence later in the body that a first read-through missed) - pointing at a separate, unconfirmed cause: matching only ever runs against `post.snippet` (LinkedIn's own truncated search-result preview), never the full post body, so a match sitting late in a long post may simply not be present in what got scraped. Not yet confirmed live.

---

# SalesTeam — v0.29.47

## Fixed: 10 of 65 profile visits hard-timed out - same backgrounded-tab throttling bug already fixed once for the Company ID resolver

- Reported directly with real evidence: a 65-profile "Extract Companies & Locations from Profiles" run hard-timed-out on 10 (found: 55, hardTimeoutCount: 10). Two of three attached debug samples (`peterwanda`, `ftomasini`) showed the exact signature already root-caused for `runCompanyIdResolution` (v0.29.43): `navCompleted: true` but the content script's result never arrived - the page loaded, the script just never got far enough to send it in time.
- `runProfileExtraction`'s tab has always been created backgrounded (`active: false`), same as the resolver's was before v0.29.43 - and the same fix applies: Chrome's background-tab throttling can stall a heavy page badly enough that the content script never sends a message within the scrape timeout. `profile-extraction.js`'s tab is now created active, and `navigateAndWaitProfile` re-asserts `active: true` on every navigation, not just at creation - identical to the resolver's `navigateAndWaitResolve`. Tradeoff: a visible tab jumping between profiles during a run instead of working invisibly in the background.
- The third sample (`notte`) wasn't a hard timeout at all - a real, successful visit that found `location: "Zurich, Switzerland"` but no company (`anyCompanyLinkOnPage: false`), counted correctly among the 55 successes, not the 10 failures. Not a bug: this profile's Experience section is genuinely present but empty (`entryCount: 0`).
- Not yet confirmed working - awaiting the next run's hard-timeout count.

---

# SalesTeam — v0.29.46

## Added: system sleep is now held off for the duration of a scan or any multi-profile run

- Reported directly: a scan left running unattended came back 3 hours later only a handful of profiles further into the post-scan "Visiting profile…" phase - far slower than the ~15-25s/profile this should take. Confirmed live: the counter resumed advancing at its normal pace the instant the machine woke back up, with no error - the machine going to sleep had simply frozen every JS timer for as long as it was asleep, indistinguishable from a hang until the wake-up timing lined up with the resume.
- `scanAllTopics` (`background.js`) now calls `chrome.power.requestKeepAwake("system")` right before its main scan loop starts and `chrome.power.releaseKeepAwake()` in the `finally` that already runs on every exit path (success, Stop Scan, or error) - a new `"power"` permission in `manifest.json`. Only blocks system sleep; the screen itself can still turn off.
- Same pattern added to the extension's three other long-running, multi-visit loops for the same reason: `runProfileExtraction` (`profile-extraction.js`), `runCompanyIdResolution` (`company-resolve-extraction.js`), and `runPeopleSearchComparison` (`people-search-extraction.js`).

---

# SalesTeam — v0.29.45

## Added: Stop buttons for both the scan and the LinkedIn Company ID resolver

- Reported directly: with the Target Account-scoped Post search phase (6.17) now able to push a scan into the hundreds of searches, there was no way to stop a long-running scan short of force-closing the extension. A new **"Stop Scan"** button in the side panel (shown only while a scan is running) sets a `scanAbortRequested` storage flag, checked by a new `checkAbort()` at the exact same per-sub-query checkpoint every one of `background.js`'s scan loops already has (Post topics, Job topics, Target Account companies) - so the delay between clicking Stop and the scan actually stopping is at most one in-flight search. Whatever was found before stopping is already saved (the existing per-topic checkpoints, plus a final save on the same path a genuine error already used) and reported with its own "Scan stopped by you" message, logged as a deliberate stop rather than a failure.
- Same idea for the Company ID resolver: a new **"Stop"** button next to "Resolve LinkedIn Company IDs…" in Settings. `runCompanyIdResolution` now takes a `shouldAbort` callback, checked before starting each new company (not mid-attempt). Returns a new `attemptedKeys` list - distinct from the full requested batch once a run can end early - used instead of it to mark which companies were actually attempted, so a company never reached this run isn't wrongly deprioritized behind ones that genuinely were tried, the next time the queue is built. The completion message states how many of the requested batch were never attempted when stopped early.

---

# SalesTeam — v0.29.44

## Changed: scan search count cut roughly in half once 499 of 500 companies got resolved - the author-company chunk size was still set for a much smaller list

- Reported directly: with 499 of 500 Target Account companies now resolved (6.16), the Target Account-scoped Post search phase (6.17) alone pushed one scan from 24 total searches to 134 - "way too much, will take forever." The math backed that up: 110 extra searches at this file's own 3-8s pacing works out to roughly 20-25 minutes added to a scan.
- `AUTHOR_COMPANY_CHUNK_SIZE` raised from 50 to 100 (`background.js`) - tested live rather than guessed: 100 real ids in one authorCompany search read an exact "99" on LinkedIn's own filter chip (one duplicate id shared by two different companies, a real LinkedIn-side dedup, not a bug) - a precise count proving LinkedIn parsed and applied the full array. Tried 200 too, but that result is inconclusive, not confirmed working: LinkedIn's chip UI stops giving an exact count past 99 ("99+", the same convention as "500+" connections), so there's no way to tell from the UI alone whether the backend genuinely filtered on all 200 or silently capped around 99. 100 is the highest chunk size with real, verifiable evidence behind it - halves the company-chunk count (10 → 5) and roughly halves this phase's added scan time.

---

# SalesTeam — v0.29.43

## Fixed: direct-link resolver hard-timed out on the majority of a 25-company run - the tab was backgrounded, and company pages are too heavy for that

- Reported directly: a 25-company run on the new direct-link resolver (v0.29.42) hard-timed out on 15 of 25. Tested live rather than guessed: manually navigating to one of the exact same failing URLs, in an active tab, loaded the real page fully in ~3 seconds - ruling out LinkedIn-side slowness or blocking. The one constant across every version of this resolver: its tab has always been created backgrounded (`active: false`). The old search-based path almost exclusively hit lightweight search-results pages and never hit this in 60+ companies; the new direct-link path exclusively hits full company pages - heavier pages Chrome's background-tab throttling can apparently stall badly enough that the content script never sends a message at all within the 28s window (confirmed in the debug data - not a slow "complete" event, zero message ever received). `runCompanyIdResolution`'s tab is now created active, and `navigateAndWaitResolve` re-asserts `active: true` on every navigation, not just at creation. Tradeoff: a visible tab jumping between company pages during a run, instead of working invisibly in the background. **Confirmed working**: the next run after shipping resolved 10 of 10 companies with zero hard timeouts.
- **Two more real problems found and fixed at the data source, not in code**: a 10-company test run flagged three "no confident match" results despite each having a validated LinkedIn link. Live-checking one (SWICA) found the link pointed to an unrelated Welsh carnival-arts company sharing the same name - a same-name collision no name-based check can catch, since the wrong page's name matches just as well as the right one's would. Reported to the external cross-check with this concrete example; a re-screen of all 500 (223 flagged as ambiguous enough to warrant a real industry/location check, not just a name match) found five more genuine wrong links this way (Ypsomed, Avolta AG, Emmi AG, Swiss Life, Belimed) plus one it caught independently (CSL Behring's link had gone 404 since first validated - corrected to the parent CSL page). Live-verified directly: BLKB, Swiss Life Group, and CSL all confirmed correct.
- **`Alternative Company Name` gap closed**: the three "no confident match" companies (BCN, Balgrist, Bank Syz) all had correct links but a blank `Alternative Company Name`, leaving the sanity check nothing to compare the real page name against beyond the research/official name - neither of which shares words with an acronym or a rename. Since the external cross-check already visits every page, it now writes back the page's actual displayed name whenever it differs (406 blank cells filled, 13 replaced, 419 changed total).

---

# SalesTeam — v0.29.42

## Changed: resolver's primary path is now a validated LinkedIn link, not name-based search; Explorer columns reordered to match the workbook

- **Full 500-company run completed: 416 of 500 resolved (83.2%)**, confirming every fix from v0.29.39-41 actually worked - APG|SGA, Dätwyler, Edwards Lifesciences, Fresenius Kabi Switzerland, and Ford Switzerland (the specific companies each fix was built for) are all absent from the final unresolved list. The 84 that remained were traced through the actual code, not guessed at, and split into: a repeat-offender company-page-fallback bug (6+ companies - Bank Syz, Basellandschaftliche Kantonalbank, Geneva Airport, SWICA, Swiss Mobiliar, Takeda - all correctly reach the right page but extract no id there, still undiagnosed); verbose full legal/branch-registration names with the real brand buried mid-string, which no trailing-word stripping can reach (Gaznat, Skyguide, STMicroelectronics, Trafigura, Versigent, Pax, Securitas Group); cross-language names (Swiss Post); the known, deliberately-unfixed acronym cases (BCGE, BCN, "BD"); and a newly-found trailing place-of-registration pattern ("OC Oerlikon Corporation AG, Pfäffikon") that blocks the noise-word stripper from ever reaching the "AG" before it, since it only ever looks at the very last word.
- **Resolver architecture changed to a direct-link primary path.** A follow-up external cross-check (ChatGPT, cross-referencing real web search/knowledge - not just the Swiss commercial registry) added two more workbook columns: `Alternative Company Name` (a commonly-used short/acronym form - solves the cantonal-bank acronym cases above without risky automated guessing, since a human/AI already did the disambiguation) and `LinkedIn Link` (a validated company-page URL for 499 of 500 companies, including catching real-world cases no on-site search could ever get right - e.g. a hospital whose old LinkedIn page now redirects as deprecated after a rename). Reported directly, and agreed: since the URL is already known-correct, navigating straight to it and reading the id off the page sidesteps essentially every failure mode above. `company-resolve-extraction.js`'s new `resolveViaDirectLink` is the primary path for any company with a `linkedinLink`; the existing search-based path is kept, unchanged, as a fallback for the rare company with none - so nothing about the proven single-search-per-company pacing changes. `company-resolve-content-script.js`'s new `runDirectLinkResolve` still does its own sanity check (the page's own `<title>`, parsed via a new `extractCompanyPageTitleName`, against every name known for the company) before trusting the id, since a supplied link has never been confirmed against a hero card the way the search-based path's has. Not yet run against real data - the company-page-fallback bug above is now the single highest-value remaining fix, since it's the one thing standing between a validated link and a resolved id for most of the list.
- **Target Accounts Explorer columns reordered to match the workbook**, plus six columns not previously surfaced there at all (`Evidence_Status`, `Zefix_Official_Name`, `Zefix_UID`, `Zefix_Address`, `Alternative Company Name`, `LinkedIn Link`) - reported directly: the externally-maintained workbook's own column order already puts triage-relevant fields well to the left, so mirroring it avoids the horizontal scrolling the Explorer's independently-curated order caused.

## Fixed: parentheses ("Fresenius Kabi (Schweiz)", "Ford Motor Company (Switzerland)") were being rejected the same way accents and pipes were

- Reported directly, from a 10-company run that resolved 7 of 10: "Fresenius Kabi Switzerland" got a real, correct hero card and ID (`65191466`, `heroName: "Fresenius Kabi Schweiz"`) but was rejected anyway - search term `"Fresenius Kabi (Schweiz)"` has a literal `(` sitting where a space needs to be, and `normalizeForNameMatch` (`company-resolve-content-script.js`) didn't treat `(`/`)` as separator punctuation the way it already did `|`, `&`, comma, period, and hyphen. Added.
- Same gap in `stripTrailingCorporateNoise` (`company-resolve-extraction.js`): "Ford Switzerland"'s official name `"Ford Motor Company (Switzerland)"` never got its trailing qualifier stripped the way `"ARYZTA AG"` did, because `"(switzerland)"` - parens still attached - never matched the noise-word set's plain `"switzerland"` entry. Same fix applied to that lookup.
- `storage.js`'s own `normalizeCompanyForMatch` already treated `()` as separator punctuation for the exact same reason (Negative Topic company matching) - this resolver code just hadn't gotten the same treatment yet.
- Not a bug, for the record: "Fundamenta Real Estate AG" correctly declined a match against "Fundamental Real Estate Investment Partners" in the same run - a genuinely different company with a similar name, not a punctuation issue.
- Not yet confirmed working - awaiting the next test run.

---

# SalesTeam — v0.29.40

## Fixed: accented company names ("Dätwyler", "Sàrl") were being rejected by literal-string matching

- Reported directly, from a 20-company run: "Dätwyler" got a real, correct hero card (`heroName: "Datwyler Group"`) but was rejected anyway - `namesMatch` (`company-resolve-content-script.js`) lowercases before comparing but never strips accents, so `"dätwyler"` and `"datwyler group"` are different literal strings (ä vs a). Fixed with a `foldDiacritics` helper (Unicode NFD decomposition + stripping the resulting combining marks) applied before the existing punctuation normalization.
- Same gap existed the other direction in `stripTrailingCorporateNoise` (`company-resolve-extraction.js`): "Edwards Lifesciences Sàrl" kept its trailing legal suffix in the search query because `"sàrl"` (accented, from the Zefix official name) never matched the noise-word set's plain `"sarl"` entry. Same fold applied to the noise-word lookup only - the search term itself keeps its original accents, only the *comparison* is accent-insensitive.
- Two small, separately-maintained `foldDiacritics` helpers rather than one shared one - `company-resolve-content-script.js` is a plain injected content script with no module imports, matching this project's existing convention of small local duplicates over premature shared abstraction (see `formatImportStamp` in `sidepanel.js`/`settings.js`).
- **Confirmed working**: the very next run (10 companies) resolved 7 of 10 (70%), with `hardTimeoutCount: 0` for the third consecutive run since the two-name-loop revert (v0.29.38) - 40 companies total now with zero hard timeouts on the single-name-only code.

---

# SalesTeam — v0.29.39

## Fixed: resolver queue kept retrying the same stubborn companies instead of making progress; a real name-matching bug fixed along the way

- Reported directly: with no distinction between "never attempted" and "tried and failed" in the data, and a run always drawing from the front of the same list in the same order, a handful of genuinely stubborn companies (a translated name, an acronym LinkedIn shows instead of the full one) kept consuming the whole budget of every run before ever reaching a fresh company further down the list - "wasting time trying to resolve the same companies again and again."
- Added `linkedinResolveAttemptedAt` (`storage.js`) - set on every company a run actually attempts, success or failure, via a new `markLinkedinResolveAttempted`, called from `settings.js` after every run. Carried forward across a workbook re-import the same way `linkedinCompanyId` already is - a resolver run's history has nothing to do with what changed in a refreshed workbook. `getTargetAccountsMissingLinkedinId` now sorts never-attempted companies first, so a run makes real forward progress through the full list before it ever revisits a known-stubborn one - once every company has been attempted at least once, this naturally falls through to offering the stubborn remainder for retry/analysis, oldest-attempt-first. Completion message wording softened to match ("will retry once every other company's been attempted" instead of "will retry next run," which is no longer guaranteed).
- **Confirmed working**: a 10-company run right after this shipped surfaced "Bergbahnen Engelberg-Trübsee-Titlis" - a company never seen in any debug sample before - and the very next 20-company run resolved 8 of 20 (40%), a sharp jump from the 1-of-10 seen immediately after shipping (which was itself explained by every company's `attemptedAt` starting at `null` together, so that first run's ordering was still effectively arbitrary - not a sign the fix wasn't working).
- **A real bug found while testing this**: "APG|SGA" resolved a genuine, correct hero card and ID (`11414625`, `heroName: "APG|SGA AG"`) but was still rejected. Cause: the search term had already replaced the literal `|` with a space to avoid breaking LinkedIn's own search, but the hero card's real displayed name still has the `|` - "apg sga" (space) and "apg|sga ag" (pipe) are different literal strings to a plain substring check, even though they're obviously the same company. `namesMatch` (`company-resolve-content-script.js`) now normalizes pure separator punctuation (`|`, `&`, `,`, `.`, `-`) to whitespace before comparing - not an acronym/fuzzy matcher, and deliberately doesn't touch the BCGE/BCN/BD cases (a genuine abbreviation with no shared substring at all, punctuation or not), which stay correctly unmatched for a different reason.

---

# SalesTeam — v0.29.38

## Fixed: every import flow's status was ambiguous, with no persistent feedback while running or on failure

- Reported directly: re-importing a refreshed research workbook more than once in one day (e.g. to pick up the new Zefix cross-check column, 6.16) left an ambiguous "500 companies imported · Sep 9, 2026" status - date-only, so there was no way to tell a just-finished import from a stale one hours earlier, or confirm it actually ran, especially with several similarly-named candidate workbook files in play at once.
- `formatImportedAt` (`settings.js`) now includes the time, not just the date. The status line also shows the source filename - `importTargetAccounts` (`storage.js`) now takes an optional `fileName` and stores it (`targetAccountsImportedFileName`), returned from `getTargetAccountsMeta` alongside `importedAt`. Final message reads "N companies imported from file \<name\> at \<date/time\>".
- Carried through the Export/Import Target Accounts backup flow too (`exportTargetAccountsBackup`/`importTargetAccountsBackup`), so a restored backup doesn't leave a stale filename behind from whatever was imported before it.
- Reported directly, same underlying complaint: parsing a large multi-sheet workbook isn't instant, and with no feedback between the click and the final status line, a click that hadn't actually registered yet looked identical to one still running. The status line now shows "Importing \<filename\>…" immediately on file selection, replaced by the real result either way.
- Reported directly: on failure, silently reverting straight back to the last-successful status (once the dismissable `alert()` was closed) left no visible trace that anything had gone wrong. The status line now states the failure and the actual reason persistently instead - `Import failed - "<file>" doesn't look like a valid, uncorrupted .xlsx or .json export (<error detail>).` for a parse-level failure, or a similar message when the file parses fine but isn't a recognized Target Accounts shape at all.
- **Generalized to every import flow in the extension, not just Target Accounts** - reported directly as a general expectation. Import Settings and Import Leads (side panel) had no persistent status at all before this, relying purely on a dismissable `alert()`; both now get the same "Importing…" → result-or-failure-with-reason treatment, via two new status lines (`import-settings-status`/`import-leads-status`, `sidepanel.html`). Import Leads' completion (`N leads restored from file <name> at <date/time>`) replaces its old success `alert()` entirely - failures still alert too, for the same reason a destructive-feeling settings replacement does, but a success no longer needs to interrupt.
- **A real parity bug found and fixed along the way**: the Target Accounts Explorer page (6.12) has its own, separate copy of the import handler (`target-accounts.js`, added v0.29.30 for backing up/refreshing data without leaving the page) - it had silently drifted from Settings' version in two ways, not just cosmetically. It never mapped `zefixOfficialName` at all, so an import done from this page instead of Settings would silently skip 6.16's official-name resolver improvement; and it never passed a filename to `importTargetAccounts`, so this page's imports never recorded which file was used. Both fixed to match Settings' version exactly.

---

# SalesTeam — v0.29.37

## Added: resolver tries a Zefix-verified official company name first, when the workbook has one

- Reported directly: a 20-company batch resolved 8 of 20 (2 hard timeouts, both isolated - not the listener race recurring; 10 "no confident match"). Digging into the no-confident-match samples surfaced a genuinely new pattern: 3 of them (Banque Cantonale de Genève, Banque Cantonale Neuchâteloise, Becton Dickinson Switzerland) actually found the right hero card and a real currentCompany ID (`heroLinkFound: true`) - `namesMatch` just correctly declined to accept "BCGE"/"BCN"/"BD" as a match for the full name, since LinkedIn displays these companies under an abbreviation with no reliable, deterministic way to derive it from the full name (confirmed live: Swiss cantonal bank abbreviations don't even follow one consistent rule - "BCGE" uses the canton code style, "BCN" doesn't). Deliberately not auto-matched: a loose acronym heuristic risks the opposite failure - accepting a *wrong* company somewhere else in the list, worse than today's safe non-match.
- Separately, the user had ChatGPT cross-check all 500 Target Accounts companies against Zefix (the Swiss commercial registry) by UI + address, producing a `Zefix_Official_Name` column (493 of 500 matched; the 7 unmatched needed genuine human judgment ChatGPT declined to guess at, e.g. "Amcor" - several plausible Swiss group entities, no unambiguous pick). Checked live against the companies already known to have resolver issues: this fixes "APG|SGA" (officialName "APG SGA SA" drops the literal `|` LinkedIn's search chokes on) and "Bank Syz" (officialName "Banque Syz SA" - the correct French spelling, matching what the user found manually on LinkedIn as "Banque SYZ & CO"). It does NOT fix the BCGE/BCN/BD acronym cases above (official names are unchanged or trivially different) or "Balgrist University Hospital" (officialName "Schweizerischer Verein Balgrist" is a real but different legal entity - still not what LinkedIn's own page is named).
- `parseFullTargetAccountsWorkbook` (`xlsx-lite.js`) already keeps every workbook column camelCased, so `Zefix_Official_Name` arrives as `zefixOfficialName` with no parser changes needed. Settings' import now carries it into each Target Account record as `officialName` (`storage.js`'s `importTargetAccounts`) - refreshed on every import like the rest of the workbook's own data, unlike the durable `linkedinCompanyId` that gets carried forward across a re-import instead. `getTargetAccountsMissingLinkedinId` passes it through to the resolver.
- `runCompanyIdResolution` (`company-resolve-extraction.js`) originally built a candidate list per company - the stripped officialName first, then the stripped research name - trying each until one resolved.
- **First test run's numbers didn't add up**: a 20-company run (2 names tried per company, roughly doubling request volume) came back with `hardTimeoutCount: 9` - a real jump from the `0` seen consistently since the v0.29.35 listener-race fix, including on the exact same fully-diagnosed "tab landed on the right page, message never arrived" signature that fix targeted. A follow-up 3-company run on the same code came back clean (`hardTimeoutCount: 0`), which at first suggested cumulative daily volume (this was roughly the 10th+ resolver run against LinkedIn in one session) - but reported directly, that theory doesn't survive a real fact: there was a 9-hour gap with zero resolver activity right before these two runs, which should have cleared any daily-cumulative throttling entirely.
- **Reverted (not a code regression, but not fully explained either)**: checked directly whether the two-candidate loop was missing a pacing delay between the first and second name attempt - it wasn't; `if (c > 0) await sleep(randomDelay())` already used the exact same 4-9s delay as between companies. Reported directly, and correct: every run before today used exactly one search per company - the two-name fallback was the one thing that changed request volume per company in a 20-company run, so it's reverted to isolate that variable and make future runs directly comparable to every one before it, whatever the real underlying cause turns out to be (a shorter in-session burst threshold rather than daily-cumulative volume remains the leading theory, not yet confirmed). Only the research name is used as a fallback now, and only when a company has no officialName at all (7 of 500, per the Zefix cross-check) - not as a second attempt after the official name fails. Consequence: whether "APG|SGA" and "Bank Syz" actually resolve with their official name is still unconfirmed either way, since the only run that tried both names for them was the same suspect 20-company run.

---

# SalesTeam — v0.29.36

## Fixed: resolver missed real, well-known companies whose sheet name carries a trailing corporate suffix

- Reported directly, following up on the v0.29.35 fix: with hard timeouts gone, a 10-company run still had 8 "no confident matches." Two ("Accelleron Industries," "APG|SGA") were confirmed genuine - directly searching LinkedIn for either shows "No results found." But the rest included real, large, listed Swiss companies ("ARYZTA AG," "Ascom Holding," "Avolta AG") unlikely to have zero LinkedIn presence, worth checking rather than assuming.
- Confirmed live, not guessed: searching "ARYZTA AG" (the Target Accounts sheet's full legal name) gets no confident match on LinkedIn's Companies tab, but "ARYZTA" alone finds the real, verified company page immediately. The exact same underlying problem as the country-qualifier fix (v0.29.28, "3M Switzerland" vs "3M") - just not limited to country words, and the resolver's own `stripCountryQualifier` never handled anything else.
- Rather than hand-picking new suffix words to strip, reused `storage.js`'s own `COMPANY_SUFFIX_NOISE_WORDS` set (AG, GmbH, Holding, Group, Switzerland, etc.) - already used elsewhere for the exact same class of problem (Negative Topic company matching), now exported and imported into `company-resolve-extraction.js` so the two lists can't drift apart. `stripCountryQualifier` replaced with `stripTrailingCorporateNoise`, which strips every trailing noise word one at a time (a company can carry more than one, e.g. "X Holding AG") rather than just a single country suffix.
- **Confirmed working**: a follow-up 9-company run resolved 5 (up from 2 of 10 before this fix), still with `hardTimeoutCount: 0`. The remaining 4 "no confident matches" included the two already-confirmed genuine non-matches (Accelleron Industries, APG|SGA) plus two new, not-yet-checked ones ("Balgrist University Hospital," "Bank Syz") - no wrong matches reported, `namesMatch` doing its job even with the broader stripped query.
- **A known, deliberately unfixed limitation, registered rather than auto-fixed**: "Balgrist University Hospital" checked live - the real LinkedIn entity is named in German ("Universitätsklinik Balgrist"), not just the English name plus a suffix. Searching "Balgrist" alone returns 7 different companies ("Balgrist Campus AG," "Balgrist Tec AG," "Balgrist Apotheke," etc.), with the correct one ranking first only because it's clearly the largest/most-verified entity - not something `namesMatch` actually confirmed. Generalizing the strip-list to drop words like "University"/"Hospital" the way AG/Holding get dropped would risk real false positives elsewhere (those words can carry genuine distinguishing meaning, unlike pure corporate-boilerplate suffixes) - deliberately not attempted. Left as a correctly-unresolved, narrow edge case; a future fix idea (not yet built) is searching both the English and a German/local-language form of a name rather than broadening what gets stripped.

---

# SalesTeam — v0.29.35

## Fixed: the hard-timeout mystery - a real listener race, found via evidence

- Reported directly: three previous fix attempts at this exact symptom - v0.29.31's try/catch, v0.29.33's warm-up navigation, and testing after the v0.29.34 Companies-tab switch - have all left a genuine, reproducible chunk of companies hard-timing-out with ZERO diagnostic info (`navCompleted: true`, nothing else, no `caughtError`). Guessing a fourth fix without new evidence risks repeating that pattern.
- One thing `navigateAndWaitResolve` (`company-resolve-extraction.js`) had never actually verified: that the `chrome.tabs.onUpdated` "complete" event it resolves on fired for the URL it asked for, rather than for some intermediate page (a LinkedIn checkpoint, an auth re-check) the tab happened to pass through first. Added `finalUrl` (read straight off the same listener callback's own `tab` argument, no extra API call needed) to the navigation result, threaded into `debugSamples`, to test that theory. Also bumped `MAX_DEBUG_SAMPLES` from 3 to 8 for visibility into more than a couple of timeouts per run.
- **The redirect theory was ruled out, and the real bug found**: a follow-up 10-company run showed `finalUrl` exactly matching the intended URL for 4 of 5 hard timeouts - the tab genuinely landed on the right page, "complete" fired correctly, and the content script's message still never arrived. The actual bug: `waitForResolveResult` (the message listener) was only ever registered AFTER `navigateAndWaitResolve` resolved - i.e. only after the tab's "complete" event, which reflects the full page load including subresources. But a `document_idle` content script typically runs around `DOMContentLoaded`, which on a JS-heavy SPA like LinkedIn usually fires BEFORE "complete" - so the content script could find its result and call `sendMessage` before this file's own listener was even registered, and that message was simply lost, with no error anywhere. Matches the symptom exactly: no `caughtError`, no content-script-side timeout, just silence.
- **Fixed** by calling `waitForResolveResult` BEFORE starting navigation (for both the main search and the company-page fallback), so its listener is live for the entire navigation instead of only after. `RESOLVE_TIMEOUT_MS` bumped accordingly (now covers from before navigation starts through the content script's own ~6s polling cap, derived from `NAV_TIMEOUT_MS` plus a buffer rather than picked arbitrarily) so slower-loading pages don't lose extraction time to the earlier listener registration.
- A fifth case ("Arbonia") showed a genuinely different failure: `fallbackFinalUrl: null` - the company-page fallback navigation itself never completed within 20s, a real slow/failed load rather than a listener race. Not addressed by this fix; needs its own evidence if it keeps recurring.
- **Confirmed working**: a follow-up 5-company run resolved 3, with `hardTimeoutCount: 0` - zero hard timeouts, the first time in this entire investigation. The other 2 ("Accelleron Industries," "APG|SGA") came back as clean, correctly-diagnosed "no confident match" (the content script responded fine, genuinely found no result for those names) rather than silent failures. The company-page fallback path (Arbonia's failure mode) wasn't exercised in this run, so that specific case remains unconfirmed either way.
- Reported directly with a screenshot: "Accelleron Industries" genuinely has "No results found" when searched directly on LinkedIn's own Companies tab - the resolver's "no confident match" for it wasn't a bug, just an accurate reflection that this company (as researched/named) isn't on LinkedIn at all. It'll keep landing back at the front of every future run's queue and keep correctly finding nothing, by design - not something to guess a fix for.

---

# SalesTeam — v0.29.34

## Fixed: resolver was searching the wrong LinkedIn tab, matching unrelated companies; switched to the Companies-only tab

- Reported directly, with real HTML the user shared (not guessed): the v0.29.33 warm-up run surfaced two new, genuinely distinct patterns after the cold-start fix removed the previous hard-timeouts. "Aargauische Kantonalbank" got a real ID (`97930`) but `heroName` came back `null`; "Acino" got a confident `heroName` but `currentCompanyIdFound: null`. Both were previously invisible failure modes, not guessed at.
- For "Aargauische Kantonalbank": the old content script (`company-resolve-content-script.js`) searched for the hero's name and its `currentCompany` ID independently, each as its own page-wide first-match lookup - safe only as long as the hero card happens to be first in DOM order for both searches, with no guarantee they're pulling from the same entity. Confirmed against the real hero-card HTML: the name (`<p>`) and the ID-carrying "X connections/alumni work here" link are both genuinely nested inside the SAME `a[href*="linkedin.com/company/..."]` anchor - LinkedIn builds its DOM via direct element creation rather than HTML parsing, so nested `<a>` elements are real here, not a parsing artifact. `findCurrentCompanyIdWithin` now scopes the ID regex to that confirmed hero anchor's own subtree instead of `document.body.innerHTML`, tying both to the same entity by construction.
- For "Acino": confirmed against the real HTML of Acino's own LinkedIn page that a company page (not the search-results page) carries its own `currentCompany=` link, under the org-top-card's "X employees" link - though that one can list several IDs in one array (`currentCompany=%5B%22255145%22%2C%22145413%22%2C%222360196%22%5D`), unlike the hero card's single-ID array. When the search page yields a confident name but no ID anywhere, the content script now reports the hero's own company-page URL; `runCompanyIdResolution` (`company-resolve-extraction.js`) navigates there as a second step and `runCompanyPageFallback` reads the first ID off that page's own link. Manifest gains a matching `linkedin.com/company/*` content-script registration, gated the same inert-during-normal-browsing way as every other extraction content script.
- Debug samples now also record `usedFallback` so a future diagnosis can tell which path a company took.
- **Not yet confirmed working**: a follow-up 10-company test run resolved 0. Notably, "Aargauische Kantonalbank" - the exact company whose hero card was used to build the anchor-scoping fix above - came back with both `heroName` and `currentCompanyIdFound` null this time, not the "confident name, no id" pattern the fallback targets. Since real evidence already proves a hero card exists for this company, this reads as either a timing issue (the hero anchor hadn't rendered within the poll window this run) or the anchor genuinely wasn't found at all - `heroName`/`currentCompanyIdFound` alone can't tell those apart from "hero anchor found but nothing extracted from within it" (a real bug in the scoped extraction). Added `heroLinkFound`/`heroLinkHref` to the debug output to disambiguate on the next run before changing any extraction logic further.
- **Suspected cause, tried, disproven by the next run**: `heroLinkFound: true`, but `heroLinkHref` pointed at an entirely unrelated company ("Digiterra powered by Crealogix") - proof that `document.querySelector('a[href*="linkedin.com/company/"]')` (first match anywhere on the page) isn't reliably the hero card at all. First hypothesis: a sidebar/suggested-companies widget rendering ahead of the real hero card. Tried scoping `findHeroLink` to `section[aria-label="Primary content"] a[href*="linkedin.com/company/"]` first, on the theory that the sidebar lives in a preceding `<aside>` outside that section. **This did not fix it** - the very next run returned the exact same "Digiterra" result for the same company, plus a new unrelated company ("Intercargo") for "Accelleron Industries," meaning the real cause was something the section scoping couldn't touch.
- **Actual root cause, confirmed via a user-shared screenshot**: the "All" tab (`results/all/`) this resolver searched doesn't reliably lead with a company "hero card" at all - it leads with whatever category ranks first, and that's often Posts. Any company merely MENTIONED inside a post's body text (or its author's own company link) matches `a[href*="linkedin.com/company/"]` just as well as a genuine top company match would. Confirmed concretely: the top hit for "Aargauische Kantonalbank" was a Digiterra post whose text read "...customer story with Aargauische Kantonalbank (AKB)" - that mention's own link is what kept getting picked up, consistently, run after run.
- **Fixed**: switched the search target from LinkedIn's "All" tab to its Companies-only tab (`results/companies/?keywords=<name>`), confirmed live to show ONLY company results with no Posts/People/Jobs noise. Its result card turned out to be the exact same DOM shape as the original "hero card" (same nested-anchor structure, same "X works here · Y followers" line) - so none of the extraction logic itself needed to change, only `buildCompanyResolveUrl` (`company-resolve-extraction.js`) and the matching manifest content-script registration (`linkedin.com/company/*` search results → `linkedin.com/search/results/companies/*`). The "Primary content" section scoping from the disproven attempt above is left in place as harmless defense-in-depth, not because it turned out to matter.
- **Confirmed working**: a follow-up 10-company test run against the Companies tab resolved 4 (up from 0 on every "All"-tab run before this fix), with the one non-timeout failure ("Accelleron Industries," `heroLinkFound: false`) being a clean "no result" - correctly declining to guess rather than matching something wrong, not a bug.
- **A separate, still-open issue, now with more evidence**: hard timeouts, unrelated to the tab fix above, remain the dominant failure mode - 5 of 10 in this same run. "Aevis Victoria" hard-timed-out on the search page itself, the same zero-diagnostic pattern previously flagged in v0.29.31/33 as still-unexplained (now seen for a third distinct company, after "Accelleron Industries" and others). "Acino" hard-timed-out for a *second* time specifically on the company-page fallback navigation (`usedFallback: true`) - no longer a single data point. Given the sheer volume of resolver runs fired against LinkedIn in one session while debugging this, throttling/rate-limiting on LinkedIn's side is a real possibility worth ruling out before writing more extraction code against what might just be slow or degraded responses - not yet investigated.

---

# SalesTeam — v0.29.33

## Tried: a cold-start warm-up navigation for the Company ID resolver's hard timeouts

- Reported directly with strong repeat evidence: after confirming the v0.29.31 error-catching fix was actually loaded (reloaded the extension, re-ran), the exact same three companies (Aargauische Kantonalbank, Accelleron Industries, Acino) still hard-timed-out with zero diagnostic info (`navCompleted: true`, nothing else) - no `caughtError` ever appeared, ruling out an uncaught exception as the cause entirely. Since these never resolve, they never leave the "still missing" pool and land back at the front of every future run's queue - pointing at a cold-start problem with the freshly-created background tab rather than anything about those specific companies: the very first navigation right after `chrome.tabs.create` may not reliably get the content script running before the orchestration's own 15-second timeout gives up, while every later navigation in the same run works fine once the tab is "warmed up."
- Tried a throwaway warm-up navigation (to `linkedin.com/feed/`) right after creating the resolver's tab, before the real per-company loop starts - so the first real company lookup is never also the tab's first navigation ever. Marked as a try, not a confirmed fix, since the exact mechanism (if this hypothesis is even right) hasn't been directly observed - worth checking whether these same three companies finally succeed or produce different diagnostic info on the next run.

---

# SalesTeam — v0.29.32

## Added: resolved-ID progress indicator on Target Accounts, and a fixed completion message that hid a real third outcome

- Reported directly: "Done - 4 of 20 companies resolved, 6 failed due to an error... what about the remaining 10?" The completion message only ever accounted for resolved and hard-timed-out counts, silently omitting a real third outcome - the content script responded fine and quickly, but couldn't confidently confirm a match (no hero card, or the hero name didn't match well enough), correctly declining to guess but invisible in the summary. `runCompanyIdResolution` (`company-resolve-extraction.js`) now also returns `notConfidentCount`, and the completion message/Activity Log entry (`settings.js`) account for all three outcomes so every company in a run is explained.
- Reported directly: since a resolver run happens in small chunks over many sessions ("Limit to N," v0.29.29), there was no way to see overall progress without re-checking the Activity Log after every run. Added a "LinkedIn company IDs resolved: X of Y" indicator to the Target Accounts Explorer page (`target-accounts.html`/`.js`), updating live if a resolver run happens while the page stays open.

---

# SalesTeam — v0.29.31

## Fixed: resolver hard-timeouts had zero diagnostic info - a silent, uncaught exception was the likely cause

- Reported directly with a 20-company test run after the v0.29.28 fix: 9 resolved, 6 hard-timed-out with the exact same empty-info pattern as before (`navCompleted: true`, nothing else) - confirmed reproducible across three unrelated real company names (Aargauische Kantonalbank, Accelleron Industries, Acino), none sharing the country-qualifier issue already fixed. `navCompleted: true` with no message ever received at all means the content script itself never reached its own `sendMessage` call - the only way that happens is an uncaught exception somewhere in its polling/extraction logic, silently killing it before it could report anything, previously invisible and previously costing the full 15-second orchestration timeout to even notice.
- Wrapped the polling loop in `company-resolve-content-script.js` in a try/catch that still sends a real result immediately if something throws, with the actual error message attached (`debug.caughtError`) - converts a mystery 15-second hang into an instant, informative failure. Added a second, outer catch around the whole script as a last resort in case even the initial setup throws.
- Doesn't fix the underlying cause yet (whatever specific error these companies' pages trigger) - but the next run's `debugSamples` should finally show what it actually is, instead of nothing at all.

---

# SalesTeam — v0.29.30

## Added: Import/Export Target Accounts buttons on the Target Accounts Explorer page too

- Reported directly: having to leave the Explorer page and go to Settings to back up or refresh the very data it's showing was an unnecessary detour. Added the same "Import Target Accounts…"/"Export Target Accounts…" buttons to the top of `target-accounts.html`, calling the exact same `storage.js` functions Settings already uses (`importTargetAccounts`/`importTargetAccountsWorkbook`/`importTargetAccountsBackup`/`exportTargetAccountsBackup`) - Settings remains the source of truth for the score threshold and other Target Account configuration, but the actual import/export actions now work from either page. Import works even before any data has been loaded (from the empty state), and Export only appears once there's something to back up.

---

# SalesTeam — v0.29.29

## Added: a "Limit to N companies" option for the Company ID resolver

- Reported directly: after a full day-long resolver run, iterating on a fix by re-running against all ~486 companies each time isn't productive - a quick way to validate a fix on a small sample first was needed. Added an optional "Limit to N" number field next to the "Resolve LinkedIn Company IDs" button (Settings) - leave it blank to resolve everything still missing an ID (unchanged default), or set it to test against just the first N still-unresolved companies, completing in a couple of minutes instead of hours.

---

# SalesTeam — v0.29.28

## Fixed: Company ID resolver failed for 89% of companies - country-qualified names broke the hero-card match

- Reported directly: a full day-long resolver run reported "28 of 486 companies resolved, 434 failed due to an error." Diagnosed from the run's own `debugSamples` (Activity Log): most failures weren't timeouts at all - a real `currentCompany=` ID was found on the page, but the hero-card name extraction came back `null`, so the resolution was correctly rejected (never guessed) but never counted as a success either.
- Root cause, confirmed live with real examples ("3M Switzerland," "AbbVie Switzerland"): the Target Accounts sheet marks which subsidiary was researched by appending a country qualifier to the company name, but LinkedIn's own company page is just the global brand ("3M," not "3M Switzerland"). Searching the qualified name never produces LinkedIn's confident "hero card" the resolver depends on - confirmed two ways: LinkedIn's own Companies search tab returned a literal "No results found" for "3M Switzerland," and the general search showed no hero card for it either, while searching "3M" alone produced a clean, verified hero card immediately.
- Fixed by stripping a trailing country qualifier (" Switzerland," " Schweiz," " Suisse," " Svizzera") from the company name before searching (`stripCountryQualifier`, `company-resolve-extraction.js`) - the resolved ID still gets written back onto the original Target Account entry regardless of this transformation, only the search query itself changes. Doesn't help a company whose failure was a genuine timeout (e.g. "Aargauische Kantonalbank," a real Swiss-native name with no qualifier to strip) - that's a separate, smaller category not yet addressed.

---

# SalesTeam — v0.29.27

## Fixed: Target Accounts import silently dropped score-less companies, and re-importing would have wiped resolved LinkedIn IDs

- Reported directly: the Company ID resolver (v0.29.25) reported "486" instead of the expected 500 companies. Root cause: the `.xlsx` import (`settings.js`) only ever included a company in the lightweight `targetAccounts` map if it had a non-null AI Priority score - the 14 companies deliberately marked "Out of Scope" (competitors/AI vendors, with no score by design) were silently excluded entirely, so they could never be resolved to a LinkedIn ID or included in the Target Account-scoped Post search (6.16/6.17), for a reason that had nothing to do with search scoping. Verified safe before fixing: `evaluateTargetAccountMatch` (`storage.js`) already nulls out any match whose score is null, so including these companies has zero effect on the P1 auto-boost or the AI's signal-weighting - they'll still never qualify. Now imports every company with a name, regardless of score.
- Caught before it could bite: `importTargetAccounts` (`storage.js`) rebuilds this map from scratch on every import (by design - the workbook is the source of truth for score/label/etc.), but its entries never carried a `linkedinCompanyId` field forward. Re-importing to pick up the fix above - or any future refresh of the research workbook - would have silently discarded every LinkedIn ID a resolver run had already found, forcing a full re-resolution of the entire list every single time. Now carries a company's resolved ID forward across a re-import, matched by company name - durable data that has nothing to do with whatever changed in a refreshed workbook.

---

# SalesTeam — v0.29.26

## Added: experimental Target Account-scoped Post search, attacking the Post-vs-Job imbalance at the root

- Completes the plan built up over the last few versions (6.15's diagnosis, 6.16's company-ID resolver): every scan now also searches Posts scoped to resolved Target Account companies via LinkedIn's `authorCompany` filter, instead of relying purely on each Topic's own unscoped global keyword search - the actual root-cause fix for the imbalance, not just a comparison tool.
- Every enabled Topic's keywords (both groups, deduplicated) are merged into ONE search per company-chunk - deliberately not one search per Topic per chunk, so this phase's cost depends on total keyword/company volume, not on how many Topics exist (a dedicated search per Topic would multiply instead of add). Resolved company IDs are chunked at 50 per search (`AUTHOR_COMPANY_CHUNK_SIZE`, `background.js`) - confirmed live that 52 works in one search, staying comfortably under that rather than chasing the exact ceiling.
- Since a post found this way didn't come from any single Topic's own dedicated search, it's checked locally against every enabled Topic's own full rule (`localTopicMatch`, `background.js`) - any keyword for a plain OR-topic, or at least one keyword from BOTH groups for an AND-topic. This is a genuine text-based double-check, more rigorous than the existing two-separate-searches-then-join approach used elsewhere in this file, which only ever trusts that both searches happened to surface the same post rather than confirming its text actually contains both kinds of terms.
- Only activates once at least one Target Account company has a resolved LinkedIn ID (v0.29.25's resolver) - nothing changes for an install that hasn't run that yet.

---

# SalesTeam — v0.29.25

## Added: experimental LinkedIn Company ID resolver (Settings)

- Follow-up to a new idea for fixing the Post-vs-Job imbalance at the root: rather than searching People by title, search Companies located in Switzerland (from the existing Target Accounts list), then scope Post search to just those companies' employees via LinkedIn's `authorCompany` filter - confirmed live to genuinely restrict results (a 52-company test list correctly narrowed the results, chip and all). But `authorCompany` needs LinkedIn's own numeric company IDs, and the Target Accounts data only ever had company names.
- The missing piece was found in real HTML the user shared, not guessed: navigating to `https://www.linkedin.com/search/results/all/?keywords=<name>` (a plain URL, no autocomplete interaction needed) shows a "hero card" for the best-matching company, and that card's own "X connections/alumni work here" link always encodes `currentCompany=["<id>"]` - reliably the *first* such occurrence anywhere on the page, before any unrelated "People also viewed" sidebar company. Cross-confirmed twice: Swiss Re's hero card gave `3845` this way, exactly matching the `heroEntityKey` LinkedIn's own search-suggestion dropdown had already produced for the same company.
- New "Resolve LinkedIn Company IDs…" button (Settings, next to Target Accounts) looks up each Target Account company missing an ID this way (`company-resolve-extraction.js`/`company-resolve-content-script.js`, matching `linkedin.com/search/results/all/*`, same gating/pacing/timeout pattern as the other extraction modules) and writes the resolved ID onto that company's Target Account record (`linkedinCompanyId`, `applyResolvedCompanyIds`, `storage.js`). A resolution only counts if the hero card's own displayed name loosely matches the company being searched for - a mismatch is left unresolved, not guessed.
- This is a prerequisite, not the finished feature - the actual company-scoped Post search (chunking resolved IDs into `authorCompany` batches, merging keywords across topics so search count stays roughly constant regardless of topic count) is separate work, not yet built.

---

# SalesTeam — v0.29.24

## Added: experimental Location/Company lookup via LinkedIn People Search (comparison mode)

- Follow-up to the v0.29.22 Location Filter fixes: real numbers showed the filter now correctly discards the large majority of Post leads as non-Swiss, which raised a strategic question - is the Post-vs-Job imbalance fixable? Investigated live against LinkedIn's actual UI (not guessed): (1) Post Search's own filter bar has no "Locations" option at all - confirmed by the user's screenshot - so there is no way to geo-scope the original keyword search for Posts the way Job Search's `geoId` already scopes Job leads to Switzerland from the start. This means the imbalance is structural, not a bug - a much larger fraction of globally-matched Posts are genuinely non-Swiss, and the Location Filter is now correctly surfacing that instead of missing it. (2) People Search DOES support a location filter - confirmed live, selecting Switzerland produces `geoUrn=["106693272"]` - and its result cards show the person's location and current company directly, without a full profile visit.
- Built on finding (2): a new, explicitly EXPERIMENTAL Dashboard button, "Compare via People Search…", looks up each Post lead's author by exact name in People Search filtered to Switzerland (`people-search-extraction.js`, mirroring `profile-extraction.js`'s visiting/pacing/timeout shape), and a new content script (`people-search-content-script.js`, matching `linkedin.com/search/results/people/*`) reads the matching result's location/company. A same-named stranger is never mistaken for the right person: only a result whose headline is also a close match (word-overlap, not exact) to the post's own already-known headline is accepted - anything less confident is skipped, not guessed.
- Deliberately does NOT replace the existing profile-visit extraction yet - results are written to separate `peopleSearch*` fields (`applyPeopleSearchComparison`, `storage.js`) and compared against the existing `location`/`company` (location compared via `classifyLocation`'s country, so a German vs. English spelling of the same real place doesn't read as a disagreement), with agree/disagree counts surfaced in the completion message and Activity Log - a way to judge this method's real-world accuracy before it's trusted as a source, not a finished feature.
- Selectors in `people-search-content-script.js` were built from a screenshot, not real HTML (same situation `profile-content-script.js` started in) - may need a live-tuning pass once run against a real page, same as that file did.

---

# SalesTeam — v0.29.23

## Changed: a senior AI-leadership title is now its own priority signal, even without an expressed need

- Reported directly with a real lead: Nicholas Blotti, "Head of AI for IT @ Azqore," posting AI industry commentary with no expressed need, scored P4 - "even though the account should be highly rated and the contact is super valuable... this lead should be at least P2." The prioritization prompt (`buildPrioritizationPrompt`, `agent-shared.js`) previously treated ANY "impressive AI-sounding title" with no expressed need as a WEAK lead belonging at 4-5, specifically to guard against over-scoring generic thought-leadership - but that guard didn't distinguish a person who merely talks about AI a lot from one whose own title names a genuine, formal AI leadership function at the company (Head of AI, Chief AI Officer, VP of AI, Director of Data Science, etc.). The existence of that role is itself a real company-level signal - formal headcount/budget committed to AI - independent of whether this particular post shows a need, and is a materially different case from a random employee's generic commentary. Such leads now have a floor of 2-3 rather than 4-5 on that basis alone; an actual expressed need/initiative/hire is still required to reach 1. A vague self-description ("AI enthusiast," "AI advisor," an independent consultant's own tagline) does NOT qualify for this carve-out and is still governed by the original rule. Only affects future prioritization runs (a new scan, or "Re-score All Priorities") - doesn't retroactively re-score already-scored leads.

---

# SalesTeam — v0.29.22

## Added: Target Accounts backup/restore, persistent Dashboard/Target Accounts filters, location-accuracy fixes, and a manual Location fix-up control

- Reported directly: "Need also a backup / export button for Target Accounts, as well as an Import button." The Settings page's "Import Target Accounts" button only ever imported (from the research `.xlsx` or the legacy `convert_target_accounts.py` JSON) - there was no way to get the currently-stored data back out. Added an "Export Target Accounts" button next to it, downloading a `.json` backup of both the lightweight scoring map and the full Explorer workbook (Contacts/AI Initiatives/AI Investment/Sources); "Import Target Accounts" now also recognizes this backup shape (an object, distinct from the legacy plain-array format) and restores it exactly via new `exportTargetAccountsBackup`/`importTargetAccountsBackup` functions (`storage.js`).
- Asked directly in response: "are you covering all settings in the side panel (scanner) plus the settings in the Setting page?" for the side panel's existing Export/Import Settings. The honest answer was partly no - `exportSettings`/`importSettings` (`storage.js`) never touched the Location Filter's `locationFilterConfig` at all, despite it being genuine, hand-set configuration; now included. (The Target Accounts Explorer workbook stays deliberately excluded from this specific automatic export, which fires before every scan - see the dedicated backup button above instead.)
- Reported directly: "In Target accounts, I keep having to refilter (remove) the Insufficient Evidence ones and the Out of Scope ones" - and more generally, "can you save the existing state of them for the next time I open them (even in a new extension open)? I mean, including the columns selected, the columns widths, the filters, etc." Column widths/hidden columns were already persisted on the Dashboard, but column filters, sort order, search text, and the status dropdown were not on either page - so filters like "exclude Insufficient Evidence" had to be re-entered every session. Both `dashboard.js` and `target-accounts.js` now persist their full filter/sort/search state (`localStorage`, same mechanism as the existing column-width/visibility prefs) and restore it automatically on open.
- Reported directly, with several real examples: some leads' locations came back as `jobs.sbb.ch`, `jobs.finma.ch`, a person's own name ("Dr. Bernhard Koelmel"), a full headline/tagline ("Assistant Professor of Computer Science | Rhodes Scholar | NEP-AI Expert | UAE Youth Ambassador"), an education institution ("University of Toronto"), and a past job description ("SAS Japan - Sales Manager｜Insurence") - none of them a location. Root cause: `personLocationFromContactInfoRow()` (`profile-content-script.js`) trusted the first element before the "Contact info" link unconditionally; on a profile with no Location filled in on LinkedIn, that position can hold almost anything else instead. Now rejects text that's too long for a real location (>60 chars), contains a headline's "|"/"｜" separator, looks like a bare domain, names an education institution (University/Institute/College, etc.), or exactly matches the profile's own name heading - same "no location is better than a wrong one" philosophy as the rest of this extractor. Does not retroactively clear already-stored bad values from before this fix - so also added a new **"📍 Assign Location"** action button (Dashboard, next to the existing "🏢 Assign Company") to manually correct or clear a lead's location, mirroring Assign Company exactly (`setLeadLocation`, `storage.js`); clearing it also re-applies the Location Filter immediately.
- Reported directly, with real examples: many leads clearly outside Switzerland (Greater Hamburg Area, Greater Bengaluru Area, Greater Lyon Area, Greater Rennes Area) weren't caught by the Location Filter, because `classifyLocation()`'s metro-to-country list only covered Swiss/US/UK/Canadian cities - an unrecognized metro name is always left unclassified (never a guess), which the filter correctly treats as "no data, don't touch." Extended the list with Germany/France/India/Italy/Spain/Netherlands/Ireland/Scandinavia/Poland/Austria/Belgium/UAE/Japan/Australia's major metros. Also, per direct feedback ("I prefer to have in these cases, the country, rather than the name of the Metropolitan... combine the 2, like this: Greater Hamburg Area (Germany)") - the Dashboard's Location column now appends the classified country in parentheses whenever the raw text doesn't already name it, using the exact same classification the filter itself uses, so what's displayed and what the filter does can never disagree.

---

# SalesTeam — v0.29.21

## Fixed: an uncaught error on the extension's Errors page, a silent failure that read like "nothing found," and a misleading button name

- Reported directly: the extension card in `chrome://extensions` showed a persistent error - "Uncaught (in promise) Error: No tab with id: ..." - separate from the friendly "Scan stopped early" message already shown for the same underlying event. Root cause: both `navigateAndWait` (`background.js`) and `navigateAndWaitProfile` (`profile-extraction.js`) called `chrome.tabs.update(tabId, { url })` without awaiting or catching its returned promise - a tab closed out from under it (a case the surrounding listener/timeout already handles gracefully) still left a genuinely unhandled rejection behind. Both now have `.catch(() => {})` attached; this doesn't change behavior, it just stops the same event from being reported twice.
- Reported directly: "It would help if when such error occurs, you also write this in the results line of the Extract Companies from Profiles button." A lead whose visit hard-timed out (the page never responded at all - e.g. the v0.29.20 profileUrl-matching bug) used to read identically to one that was visited fine but simply had no findable company/location, both just counting as "not found." `runProfileExtraction` now also returns `hardTimeoutCount`; the Dashboard and side-panel completion messages, and the Activity Log entry, both call it out explicitly ("N failed due to an error - will retry next run") instead of it only being discoverable later by noticing the count didn't move.
- Reported directly: "BTW, it is actually Extract Companies & Locations from profiles" - the button, its tooltip, every completion message, and every Activity Log label said "Extract Companies from Profiles," even though the feature has always extracted both fields. Renamed everywhere to "Extract Companies & Locations from Profiles."
- Reported directly: after the v0.29.20 fix landed, a real lead (Roland Markowski) came back with a company but still no location - a partial miss the diagnostic bundle never covered, since it only ever attached when BOTH fields came back empty. Widened to fire whenever EITHER field is still missing, and each debug sample now also states which of company/location it actually found, so a partial miss is just as diagnosable from the Activity Log as a total one.

---

# SalesTeam — v0.29.20

## Fixed: the real root cause of the Jochen Eversmeier saga - a locale-path URL variant was silently rejected as "not a match"

- Confirmed with hard evidence after the v0.29.19 diagnostic bundle showed `{timedOut: true}` (no message ever received at all) for three leads - Jochen Eversmeier, Andy Huber, and Roland Markows - despite the content script demonstrably finding and sending the right company/location for at least one of them (verified byte-for-byte against real profile HTML). All three leads' stored `profileUrl` happened to be the `/in/<slug>/en/` locale-path variant (scraped from a LinkedIn UI link that uses that format, e.g. a post-author link in someone's own Activity carousel) rather than the canonical `/in/<slug>/` form.
- Root cause: visiting `.../en/` redirects to `.../?locale=en` - a DIFFERENT path, just with the locale moved into a query param. `normalizeProfileUrl()` (`profile-extraction.js`) only ever stripped the query string and one trailing slash, so it normalized the stored URL to `.../slug/en` but the actual page's reported URL to just `.../slug` - never equal. The content script ran correctly, found the right data, and sent it back - but `waitForProfileScrapeResult`'s listener silently rejected the message as belonging to a different profile, and the wait timed out 15 seconds later with nothing, over and over, on every run, no matter how many other fixes shipped.
- Fixed by matching on just the `/in/<slug>` prefix - the one part of the URL guaranteed to stay the same regardless of locale path, query string, or trailing slash - instead of comparing the full path. Also fixes `groupByProfile`'s deduplication the same way: two leads pointing at the same person via different URL variants now correctly count as one profile visit instead of two.
- Also added: `navigateAndWaitProfile` now reports whether the page navigation itself actually completed (`navCompleted`), attached to any future hard-timeout debug sample - so a genuinely different cause (the page never loading at all) is now distinguishable from this one (the page loaded and worked fine, but the result was silently discarded) without another multi-day investigation.

---

# SalesTeam — v0.29.19

## Fixed: the failure-diagnostic bundle still checked the OLD extraction signals, not the ones that actually matter now

- Reported directly: a real lead (Jochen Eversmeier) came back with both company and location empty, despite his profile's raw HTML being verified byte-for-byte structurally correct against the current extractors - the "Contact info" row held his location text exactly as expected, and the company badge held his employer exactly as expected. No selector bug could be found by inspection.
- Root cause of not being able to diagnose it further: `collectDiagnostics()` (`profile-content-script.js`) - the bundle attached to a failed extraction and surfaced in the Dashboard's Activity Log specifically so a failure can be diagnosed without needing to catch a background tab's live console during a fast, unattended run - still only checked the OLD signals (the Experience section, a generic company-page link) from before v0.29.15's structural rewrite. It never checked whether the "Contact info" link or the company badge - the actual PRIMARY extraction path now - were found on the page at all, so it couldn't explain a failure in that path.
- Added the missing signals: `contactInfoLinkFound`, `contactInfoRowText`, `companyBadgeIconFound`, `companyBadgeText`. The next time a lead fails both fields, its debug sample (up to 3 per run, in the Activity Log) will show whether these primary extractors found anything at all on the live page during the actual automated visit - the missing piece of evidence needed to tell a genuine selector/timing bug apart from something else in the pipeline.

---

# SalesTeam — v0.29.18

## Fixed: misleading message after a scan error promised a resume that doesn't exist

- Reported directly: after a scan failed mid-run ("Scan stopped early due to an error (No tab with id: ...)"), clicking "Scan All Topics" again did not pick up where it left off - it restarted from topic 1, sub-query 1.
- That's actually correct, safe behavior - `scanAllTopics()` has no per-topic checkpoint, so every scan always starts over from the first topic. Nothing was lost or duplicated (leads found before the error were already saved, and re-scanning the same topics just re-matches the same lead keys) - but the error message's wording ("try scanning again to pick up the rest") oversold this as an efficient resume, which it isn't.
- Corrected the message text to set the right expectation: leads found before the error are safe, but scanning again takes as long as a full scan, not just "the rest." No behavior change - this is a wording fix only, since building an actual resume mechanism wasn't what was reported or asked for.

---

# SalesTeam — v0.29.17

## Fixed: a Job listing at a Provisional-scored Target Account could still reach Priority 1

- Reported directly: two real Job leads (Basler Kantonalbank Senior PO Data&AI, scored 98/100 "Very High - Provisional"; Nestlé Head of AI & Digital, scored 86/100 "Very High - Provisional") both landed at Priority 1, despite the project's stated rule that a Job listing - no individual to contact - should be capped at Priority 3.
- By design (v0.29.2), the deterministic "Job company cap" only fires for a CONFIDENT match (`Very High`/`High`, never `Provisional`, above the score threshold) - a Provisional match like both of these is intentionally sent to the Sales Mentor instead, with only a soft instruction ("a job ad naming no initiative beyond the hiring itself should rarely reach 1 or 2"). That's not a code bug, but it isn't a guarantee either - the model ignored it for both leads.
- Given this project's consistent preference for deterministic rules over relying on the model to follow soft guidance (the same reasoning behind the Job company cap itself), added a new rule - **Job signal ceiling** (Settings' Prioritization Rules table, default value 3) - using the "Ceiling" column that already existed in that table's UI but had no rule using it yet. A Job lead whose company matches a Target Account at ANY confidence (Provisional or below-threshold included) now carries a `targetAccountCeiling`; the Sales Mentor still decides freely, but `tagPrioritiesWithTargetAccountSignal` (`storage.js`) clamps any returned priority better than the ceiling back down to it, with the clamp stated plainly in the reason - the same mechanism the existing Post company floor rule already uses in the opposite direction.
- Like every other rule in this table, it can be disabled from Settings, in which case a Provisional-matched Job lead goes back to the Sales Mentor as a plain, unconstrained signal - exactly as it did before this fix.

---

# SalesTeam — v0.29.16

## Fixed: leads that failed under the old keyword-based heuristic never got a chance to benefit from v0.29.15's structural fix

- Reported directly: after upgrading to v0.29.15 and re-running "Extract Companies from Profiles" against the same 53 leads, only 9 got a location - no meaningful improvement over the 9/53 baseline measured on v0.29.14, despite v0.29.15's fix being a fundamental, content-independent rewrite that should work on nearly every profile (every profile has a "Contact info" link).
- Root cause: `profileVisitedAt` is only cleared by a **one-time** migration, and that migration (added in v0.29.11, for the v0.29.12/13 fixes) had already run during earlier testing on v0.29.14 - before v0.29.15 even existed. Every lead visited-and-failed under the old keyword-scan code between v0.29.11 and v0.29.14 was already past that one-time reset, so it stayed permanently marked "checked" and was silently excluded from ever being visited again - v0.29.15's new structural extractor never got a chance to run on any of them.
- This is the same symptom as v0.29.13's "already-checked leads couldn't benefit from the fix" bug, recurring because a one-time migration flag can only ever protect against the ONE fix it shipped alongside - a later, unrelated fix needs its own fresh flag. Added a second one-time migration (`locationHeuristicV3Migrated`, independent of the v2 flag) that clears `profileVisitedAt` once more for any lead still missing a location, so v0.29.15's structural fix gets a real shot at every lead that hasn't already succeeded.
- Company extraction was unaffected by this bug (47 of 53 leads already have a company) - the remaining 6 without one were already confirmed, in an earlier check, to genuinely have no company listed on their profile.

---

# SalesTeam — v0.29.15

## Fixed: location extraction no longer depends on recognizing the text at all

- After several rounds of "one more missing country/city" reports (Nashville, Bengaluru, Dubai, Israel...) that kept recurring no matter how large the recognized-word list grew, real profile HTML (Allie K. Miller's page, shared directly) revealed the actual fix: the location text isn't identified by keyword-matching its content at all. Structurally, it's always the first paragraph in a small row that also contains the "Contact info" overlay link - `<div><p>New York, United States</p><p>·</p><p><a href=".../overlay/contact-info/">Contact info</a></p></div>`.
- That "Contact info" link is a stable, always-present feature of every profile's top card, regardless of language or how obscure the location text is. The extractor now finds the location this way first - capturing whatever's actually there, word-list or not - falling back to the old keyword-scan approach only if this structural anchor isn't found on a given profile layout.
- This is the real fix for the pattern this project kept hitting: recognizing more words was never going to be a complete answer, since there's no bounded list of every city/region a lead might be in. Reading the page's own structure removes that dependency entirely for the common case.
- Classification into a country/continent for the Location Filter is unaffected by this - it still uses `classifyLocation`'s country/city tables, just against a much more reliably captured raw string.

---

# SalesTeam — v0.29.14

## Fixed: the location word list was a hand-picked subset that kept missing individual countries one at a time

- Reported directly with five more real profiles after v0.29.13: Bengaluru/India, Dubai/UAE, Canada, "New York City Metropolitan Area," and Atlit/Haifa/Israel all still came back with no location.
- Four of these five (India, UAE, Canada, New York) were already-recognized words - their failure isn't a vocabulary gap, it's consistent with the scrape-wait early-exit bug and the `profileVisitedAt` lock-in, both fixed in v0.29.13 but not yet tested against a live re-run. **Israel was a genuine, separate gap** - never in the word list at all, despite already being a recognized country for the Location Filter's own classifier.
- Rather than keep adding one missed country at a time, `profile-content-script.js`'s location word list is now the FULL country list `classifyLocation` (`storage.js`) already recognizes - about 150 countries, mirrored in full - instead of a hand-picked subset. A country gap in one can no longer exist without the other having it too.
- If a location is still missing after this, re-checking with the actual profile's HTML markup (not just its visible text) will be the fastest way to pin down whatever's left - the DOM-traversal logic itself, not word coverage, would be the remaining suspect.

---

# SalesTeam — v0.29.13

## Fixed: the profile scraper stopped waiting for location the moment it found a company - the actual dominant cause of missing locations

- Reported directly with a real profile (andreasbezner) whose location plainly says "Switzerland" - a word this extractor has always recognized, no vocabulary gap involved - yet the lead's location still came back empty. Root cause: the scrape-wait loop stopped polling the instant EITHER company OR location was found, not once BOTH were. Since v0.29.10 made company resolve almost instantly (the top-card badge renders immediately, unlike the lazy-loaded Experience section), the loop was exiting on the very first attempt on most profiles the moment company was found - before location, which can render a beat later, ever got a real chance across the remaining ~5.5 seconds of polling. This was very likely the single biggest cause of missing locations overall, well beyond the vocabulary gaps below. Now waits for both before stopping early.
- Also reported directly with two further real examples: Burke Holland's profile clearly shows "Nashville Metropolitan Area," and Allie K. Miller's clearly shows "New York, United States" - yet both leads still had no location. Two more real causes:
- **Already-checked leads couldn't benefit from the v0.29.12 language fix.** v0.29.11 marks a profile "checked" (`profileVisitedAt`) the moment a visit gets a real response, specifically so a lead with no findable location isn't re-queued forever - but that same mechanism meant a lead checked under the OLDER, narrower heuristic (or under the early-exit bug above) stayed marked "checked" even after the underlying issue was fixed, so it could never get a second look. Fixed with a one-time migration: any lead still missing a location gets its `profileVisitedAt` cleared once, so it's picked up again on the next run under the current (better) rules.
- **"Nashville Metropolitan Area" has no country name in it at all.** LinkedIn often shows just a metro-area name with nothing else - the same "Greater Zurich Area" phrasing already handled for Switzerland's own cities, but never extended past Switzerland. Added a modest set of other major metros (New York, Los Angeles, Chicago, San Francisco, Nashville, Seattle, Austin, Boston, Dallas, Houston, Atlanta, Denver, Miami, Washington, Philadelphia, Phoenix, San Diego, Portland, Minneapolis, Detroit, London, Manchester, Toronto, Vancouver, Montreal) to both the location-detection heuristic and the Location Filter's classifier - deliberately a best-effort list, not exhaustive world city coverage, same trade-off already accepted for the Swiss cities.
- Combined, any lead still missing a location - including ones already visited once under the old rules - will be picked up and correctly classified on the next "Extract Companies from Profiles" run.

---

# SalesTeam — v0.29.12

## Fixed: location extraction missed profiles that showed their country/city in German or French

- Reported directly: leads at obviously-Swiss companies (SBB, Syngenta, IMD Business School) still came back with no location after a profile visit. Root cause: the location heuristic and the Location Filter's classifier both only ever recognized English names - "Zurich," "Geneva," "Lucerne," "Switzerland" - and a Swiss LinkedIn profile just as often shows "Zürich," "Genève"/"Genf," "Luzern," "Schweiz"/"Suisse," or the bare ISO code "CH," none of which ever matched.
- Both the profile scraper's location detection (`profile-content-script.js`) and the Location Filter's classifier (`classifyLocation`, `storage.js`) now also recognize these German/French spellings and "CH," kept in sync so what gets scraped is also what gets correctly classified.
- "CH" is only two letters, so matching it as a raw substring would also match inside "which," "search," "chief," and plenty of other everyday words. The profile scraper's location-detection check (previously a plain substring test) was upgraded to whole-word matching first, specifically so "CH" could be added safely - it now only counts as a hit when it stands alone as its own word.
- This only helps *future* profile visits - it doesn't retroactively fix a location already (not) recorded, but combined with v0.29.11's fix (a checked lead is only skipped once it actually got a real response, not just once it was queued), any lead still missing a location will be picked up and re-checked correctly on the next "Extract Companies from Profiles" run.

---

# SalesTeam — v0.29.11

## Fixed: "Extract Companies from Profiles" kept showing the same count run after run, visited the same person twice, and a job's location carried its work-arrangement tag

- Reported directly: a run showed "Visiting profile X of 55" against an expected ~20 (leads missing a company), and the count stayed at 55 even across repeated runs. Three real causes, all fixed:
- **The count was never just "missing a company."** It's every lead missing EITHER a company OR a location (by design, since v0.29.5 added location extraction to the same visit) - a lead that already has a company but no location was counted too, which the confirmation dialog never made clear.
- **The real reason the number never shrank**: only a *successful* location find ever marked a lead as done. A profile that was actually visited but simply has no location text on it (common - the extractor's location heuristic is a small, Switzerland-biased hint-word list) stayed permanently "missing," so it kept getting queued and re-visited on every single future run, forever, even though nothing new was ever going to be found there. Every lead now gets a `profileVisitedAt` timestamp the moment its profile visit actually completes (a real response from the page, not a network/tab timeout) - regardless of whether a location was found - so a profile genuinely without one is checked once and never re-queued again. A hard timeout (the tab never loaded, the extension lost context, etc.) is NOT marked this way, so it's still retried next run.
- **Duplicate visits**: two posts (or an in-post job ad) from the same person, each still missing data, were visited as two separate profile pages even though one visit answers both. `runProfileExtraction` now groups by profile URL first and visits each real profile exactly once, applying that one result to every lead that shares it.
- The confirmation dialog and the "Visiting profile X of Y…" progress counter now both show the real number of page visits about to happen, noting how many leads that covers when it's more than the visit count (e.g. "This will visit 20 individual LinkedIn profile pages (covering 55 leads that share these profiles)...").

## Fixed: a job's scraped location carried its work-arrangement tag ("(Hybrid)", "(Remote)", "(On-site)")

- Reported directly: LinkedIn appends this tag right onto (or immediately after) a job listing's location text, and it describes the job's arrangement, not the place - e.g. "Zurich, Switzerland (Hybrid)" isn't a place called "Zurich, Switzerland (Hybrid)."
- Stripped at the scrape source (`jobs-content-script.js`) so every downstream consumer (the Location Filter, the Dashboard's Location column, Sales Mentor location parsing) only ever sees the actual place.
- A location scraped before this fix and still carrying the tag is cleaned up automatically, best-effort, the next time it's read - no manual cleanup needed for existing leads.

---

# SalesTeam — v0.29.10

## New: Negative Topics do fuzzy company matching + an AI/Cloud Vendor Blocklist; fixed a profile's top-card company badge not being read; fixed "Known Recruiting Firms" matching post text, not just company

- Reported directly: "How do I handle when I put a company name without the AG/Ltd/Inc part, and it appears with, or vice versa? ... in Switzerland it is called `<company name>` Switzerland, or vice versa? ... the formal name is `<company name>` Group, or vice versa?" A configured keyword and a lead's own `company` text are now compared with legal-entity suffixes (AG, GmbH, Ltd, Inc, LLC, ...), corporate-structure words (Group, Holding, International), and regional suffixes (Switzerland, Schweiz, Suisse) stripped from BOTH sides first, in either direction - so "Zühlke" now matches "Zühlke Engineering AG," "Randstad" matches "Randstad Switzerland," etc., without needing every legal variant spelled out. This is additive to every existing Negative Topic's own free-text matching, not a replacement.
- Also reported: many leads work at Google, Microsoft, NVIDIA, and similar - not competitors, but not this project's ICP either. New built-in **AI/Cloud Vendor Blocklist** negative topic (Google, Microsoft, Amazon/AWS, NVIDIA, IBM, Oracle, SAP, Salesforce, Meta, OpenAI). These are the exact vendors the Competitor Blocklist deliberately excludes, for the exact reason a plain keyword match against them is noisy (a post merely mentioning "built on Azure" or "runs on an NVIDIA GPU") - so this new topic checks ONLY the lead's own company (never post/job text), which a new **"Company name only" / "Company + text"** selector on every Negative Topic card now controls.
- Fixed a real latent bug found while building the above: "Known Recruiting Firms" was documented in-code as matching only a lead's own company, but nothing actually enforced that - it could be triggered by a mere mention of e.g. "Randstad" in a post's snippet. It's now set to "Company name only," matching its original intent.
- Fixed: a profile's stated current employer wasn't read when it appears as the top card's company badge (next to the person's photo) rather than in the Experience section - confirmed against real profiles that Experience only renders after scrolling, while the badge renders immediately, so it's now checked first. Also confirmed this correctly ignores a sibling school/university badge on the same profile (the two use different, badge-specific icon markers).
- These two new built-in defaults - the AI/Cloud Vendor Blocklist, and "Known Recruiting Firms" switching to company-only matching - only apply to a **fresh install**. An existing configuration is never silently changed, since Negative Topics are your own live settings. To pick these up yourself: open the side panel's Negative Topics, add an "AI/Cloud Vendor Blocklist" topic if you want it, and switch "Known Recruiting Firms" to "Company name only" in its new selector.
- Verified against real profile data (top-card badge extraction) and by tracing representative cases for the fuzzy matching (a company with/without a legal suffix, with/without "Switzerland," with/without "Group," in both directions) - no automated test harness was available in this environment (no Node.js on this machine's shell), so this shipped on careful manual verification rather than an executed test suite.

---

# SalesTeam — v0.29.9

## Fixed: company extraction only worked for employers with a Company Page; post-scan profile-visiting phase; Location column + Empty-only filter

- Reported with real data: a 55-profile run found a company for only 5. A second real DOM sample showed why - Experience entries are wrapped in a `componentkey="entity-collection-item-..."` element regardless of whether the employer has a Company Page, but the extractor only ever looked for a link to one. It now reads the entry structurally first (works for both linked and unlinked employers) and only falls back to the link-only approach otherwise.
- Also added: when a profile still yields nothing after the poll, the content script now attaches a small diagnostic bundle (headings found, whether an Experience section/entry/company-link exists at all) - up to 3 samples per run are attached to the run's Activity Log entry, so a still-mostly-failing run can be diagnosed without catching a background tab's console live.
- New: after every scan, the side panel now checks the same backlog the Dashboard's "Extract Companies from Profiles" button does (any Post/job-ad lead - from this scan or earlier - missing a company or location) and, if any qualify, prompts to visit their profiles right there, with its own distinct "Visiting profile X of Y…" progress phase - kept separate from the scan's own "topic X of Y" counter rather than folded into or silently running after it. Requested directly: "we risk that the number of leads without company and location will grow and become a real problem" - this is scoped to the whole backlog, not just this scan's new leads, specifically so it can't quietly regrow.
- The visiting/pacing/timeout orchestration moved out of `dashboard.js` into a new shared `profile-extraction.js`, used by both entry points so they can never drift apart.
- New Dashboard **Location** column, next to Company.
- New **"Empty [Column] only"** checkbox in every column's filter menu (Dashboard) - reported directly: there was no way to isolate rows with nothing in a column (e.g. every lead still missing a Company), since a blank filter box was correctly treated as "no filter."
- Verified via harness: the new structural entry extraction against both a linked and an unlinked real-sample entry, the diagnostic bundle's fields on a total failure, the shared module's batch results/progress-callback/debug-sample behavior end-to-end with a mocked `chrome.tabs`/`chrome.runtime`, and a full `dashboard.js` load confirming the Location column renders and the Empty-only filter correctly narrows the table.

---

# SalesTeam — v0.29.8

## Fixed: "Extract Companies from Profiles" time estimate badly undercounted the real total

- Reported: a real 55-profile run took roughly 15 minutes, well past the "1.5-3 minutes" implied by the confirmation dialog and by an earlier explanation I gave - some individual profiles were taking 25+ seconds, apparently past the "15 second" figure mentioned for the scrape wait.
- That 15-second figure was only ever the wait for the page's *already-loaded* content to appear - it never included the time to navigate to and load the profile page itself (up to a 20-second ceiling), which is the dominant, most variable real-world cost and was missing from both the time estimate and my explanation entirely.
- The confirmation dialog's estimate now folds in a rough typical page-load time alongside the deliberate pacing delay, instead of only counting the pacing - much closer to the real total, and the dialog itself now notes that real page-load time varies.
- No change to the actual extraction behavior or timeouts - this only corrects the estimate shown before starting, so expectations match what actually happens.

---

# SalesTeam — v0.29.7

## Changed: Location Filter country picker + a page-wide "Saved" indicator on Settings

- Reported: free-text country entry for the Location Filter is error-prone - a misspelling or an unrecognized alternate name just fails to match silently, with no feedback that anything's wrong.
- The country textarea is replaced with a dual-listbox picker: a searchable, alphabetized list of every recognized country on the left, an arrow pair (or double-click) to move countries into the filter on the right. The picker only ever offers names guaranteed to match exactly, so a misspelling is no longer possible.
- Also reported: moving several countries in/out shouldn't each take effect on the spot while still building up the list. The picker now stages changes locally and only saves (one write, one activity-log entry) when its own **Save Countries** button is clicked - disabled until there's an actual pending change, with its own "Unsaved changes"/"Saved" status.
- Separately reported: Settings already auto-saves every field, but that "feels weird, unsure if it was saved or not." Kept auto-save (an explicit Save-everywhere model risks losing an edit if you navigate away without clicking it) but added one persistent, page-wide "Saved" badge that flashes on every write across the whole page, then settles back to "All changes saved."
- Verified via harness: the country picker's search/add/remove/double-click interactions, staged-vs-persisted state before and after clicking Save Countries, and the page-wide save indicator flashing both for the staged country-picker save and for an ordinary auto-saved field.

---

# SalesTeam — v0.29.6

## Fixed: "Extract Companies from Profiles" crashing after a few profiles

- Reported: a run stopped after 3 of 55 profiles with "Cannot destructure property 'company' of '(intermediate value)' as it is null." "Apply Location Filter" then correctly found 0 leads to change - not a separate bug, just a symptom of extraction having crashed before almost any lead got a location.
- Root cause: the per-profile wait resolved a bare `null` when a profile didn't respond within its 15-second timeout, and `const { company, location } = ...` destructuring `null` throws - aborting the entire run instead of just skipping that one unresponsive profile.
- Fixed: the timeout path now resolves `{ company: null, location: null }`, so one slow/unresponsive profile is skipped like any other miss and the run continues through the rest of the list.

---

# SalesTeam — v0.29.5

## New: Location Filter (by continent or country) + two more transparency rows on Prioritization Rules

- Reported, with a real example: a PwC Switzerland lead scored Priority 3 instead of `Irrelevant` - a competitor, not a buyer. Also requested: "add a rule that puts a lead as Irrelevant because its location is outside the target geography (Switzerland)," configurable by continent or by country from Settings, which would also make a Topic's own location keywords unnecessary going forward.
- New **Location Filter** on Settings: Off / By continent (North America, Latin America, Europe including UK and Switzerland, Africa, Middle East, South East Asia) / By country (free-text list). A lead whose classified location doesn't match gets marked Irrelevant automatically - reviewable and reversible, exactly like Negative Topics, never a silent delete. A lead with no location yet, or text that can't be confidently classified, is never touched.
- The six continents mirror standard Americas/EMEA/APAC sales territories, split one level further (per the user's own stated rationale); since they don't geographically cover the whole world on their own, the remaining regions (South/East/Central Asia, Oceania) fold into "South East Asia" rather than adding a seventh "Other" bucket.
- "Extract Companies from Profiles" (v0.29.1) now also captures a person's stated location from the same profile visit, and automatically re-checks the Location Filter once the run finishes. A new standalone **"Apply Location Filter"** button (Dashboard and Settings) re-checks on demand, e.g. after a Settings change.
- The Prioritization Rules table (v0.29.4) now also lists **Competitor Blocklist** and **Location Filter** as two further rows, reflecting and toggling their real enabled state, for the same transparency reason as the four rules already there - both exclude a lead to Irrelevant outright rather than setting a priority level. The built-in Competitor Blocklist itself also gained PwC, KPMG, Accenture, McKinsey, and Bain for fresh installs (an existing, already-saved list needed the same firms added by hand).
- Verified via harness: location classification against real strings seen this session (Zurich/Switzerland, Lahore/Pakistan, "Greater Zurich Area," USA, UAE, unparseable text), the filter's continent/country/off modes and no-location/unclassifiable-never-touched guarantee, composition with Negative Topics in both directions (neither auto-filter wrongly restores a lead the other still wants hidden), the extended profile scrape writing both company and location independently, and the Settings UI end-to-end (mode toggle, continent/country persistence, and the Prioritization Rules table's two new rows staying in sync with both the dedicated form and their own row checkbox).

## Fixed: "Extract Companies from Profiles" returning 0 companies on a real run

- Reported with a real example: a live 20-profile run found 0 companies, including a profile independently confirmed to show one clearly ("The Bank of Punjab"). Diagnosed from a real DOM sample the user provided.
- **Root cause 1**: LinkedIn's current profile page is a heavily client-rendered app with no static markup - its Experience section hydrates in after the page's own load event, which is when the extraction script previously ran, once, with no retry. It now polls for up to ~6 seconds for the section to actually appear before giving up.
- **Root cause 2**: the company-page link wraps both the job title and the company name as one block of text, so reading the whole link's text returned them run together (e.g. "Data AnalystThe Bank of Punjab · Full-time"). It now reads the specific line that holds the company name and strips the trailing employment-type suffix.
- Also hardened the Experience-section lookup itself to anchor on the section's own literal "Experience" heading text, rather than guessing at an id/class - a more durable marker against this app's generated ids.
- Verified via harness against the real DOM sample provided (correct company extracted, not concatenated with the title; a deliberately-planted "Switzerland" mention inside the Experience section still correctly excluded from location) and a simulated 1.5s hydration delay (confirmed the extractor waits for and finds the late-arriving content instead of giving up instantly).

---

# SalesTeam — v0.29.4

## New: configurable Prioritization Rules table on Settings

- Requested: "Can we store, and also display in settings, the rules for prioritization? This way, the user can also see what is driving the prioritization and can also decide to disable any of them." Also asked for the Sales Mentor to always remain the base decision - these rules should only ever constrain or override it, never replace it, and it can't itself be disabled.
- The four deterministic rules added in v0.29.2 (Job company cap, Post title match, Post topic match, Post company floor) are now data-driven instead of hardcoded constants, and shown as a real table on Settings: Rule, Description, Ceiling, Floor, Decisive, Enabled - each rule occupies exactly one of the three value columns, matching its fixed effect type.
- A rule's description and effect type are fixed in code and never stored or edited - only its value and enabled state are user-adjustable, so a saved change can never drift into describing behavior the code doesn't actually implement.
- Disabling a rule leaves those leads to the Sales Mentor's own judgment as a plain signal, exactly like a non-qualifying company match already works. The Mentor's own judgment is always the base decision for every lead and can't itself be disabled.
- Verified via harness: changing a rule's value takes effect immediately (including a live example - editing the Job company cap from 3 to 4 and confirming the next partition call reflects it), disabling a rule correctly routes those leads to the AI-signal path instead of auto-prioritizing them, and the Settings UI's number/checkbox inputs round-trip correctly (including rejecting an out-of-range value and reverting the input).

---

# SalesTeam — v0.29.3

## Changed: Target Accounts Explorer gets all 44 company columns, filtering, and full sub-tables

- Reported: "Columns should support filtering - example: I would almost always want to filter out the companies with AI Priority containing 'Insufficient Evidence'" and "Many columns in the main sheet (Companies) are missing from the excel."
- The master table now exposes every Companies-sheet field as a real, toggleable column (43 columns covering all 44 raw fields - the two currency fields are folded into their paired revenue column's display). Twelve start visible: Company, Industry, Type, Global/Swiss Employees, Global/Swiss Revenue, AI Score, AI Priority, Evidence Coverage, Research Status, and (newly promoted to the main table) Priority Rationale. The rest start hidden, one click away via the same **Columns** button and per-column **"Hide This Column"** item already built for the Dashboard (v0.28.6).
- New per-column filtering, including an **exclude mode** - a checkbox next to each column's text filter to hide matching rows instead of narrowing to them, so filtering out "Insufficient Evidence" (409 of 500 companies) is one click.
- The Contacts and AI Initiatives sub-tables in a company's detail panel now show every column of those sheets, not a curated subset.
- Verified via harness: default column set and full 43-column availability, exclude-mode filtering (confirmed a company correctly disappears/reappears), the Columns panel toggling a hidden column on, and both expanded sub-tables rendering all their columns correctly.

---

# SalesTeam — v0.29.2

## Changed: sharper, fully deterministic Target Account priority rules

- Reported: even after v0.28.5 (Job leads no longer forced to P1), Job listings were still routinely outranking real people because their conservative-but-still-AI-judged signal could land anywhere. Also asked for Post leads to be judged on more than just the company - a real decision-maker's own title, or the topic that surfaced them, should matter too - and for all of it to be transparent, not just an AI black box.
- **Job leads at a qualifying (70+, non-Provisional) company are now fixed at Priority 3, full stop** - no AI call involved, never better regardless of the ad's own content, since there's no individual to contact and nothing else to weigh.
- **Post leads (including in-post job ads) get an automatic Priority 1** when the poster's own headline names a decision-maker role (CTO, CIO, CAIO, CDO and spelled-out forms, Head/VP of AI, Head/VP of Digital Transformation, Head/VP of Automation, Head/VP of Innovation) or the lead was found via a topic named "AI Transformation" - also fixed, no AI call, so the reason is always an exact sentence naming which condition fired.
- **Post leads that qualify without a title/topic match get a floor of Priority 2** - still sent to the Sales Mentor for judgment (it can still say P1 if the content itself is strong), but the returned priority is clamped up to 2 if the model said worse, with the clamp stated plainly in the reason.
- Provisional/below-threshold matches on either lead type are unaffected - still just a soft signal into the existing AI pass, unchanged from v0.28.4/v0.28.5.
- Verified via harness: all five new/changed paths (Job fixed-P3, Post title-match, Post topic-match, Post floor-clamp when the AI scores low, Post floor-clamp correctly *not* firing when the AI already meets it) plus the untouched Provisional soft-signal path - 17 assertions, all passing.

---

# SalesTeam — v0.29.1

## New (opt-in): Extract Companies from Profiles

- Reported with a real example: "Extract Companies" found 0 companies for a batch of Post leads, but a couple of those posters clearly show a real employer on their actual LinkedIn profile (e.g. Ameer Hamza → The Bank of Punjab) - just not in their headline text, which is all the search-results-feed scrape ever sees. The AI extraction step can only find what's already in the scraped headline; it has no access to a page never fetched.
- New Dashboard button, **"Extract Companies from Profiles…"**, separate from the existing headline-based one: visits each remaining company-less Post lead's own profile page, one at a time, in a background tab, looking for their current employer. Confirms first, naming exactly how many profiles it's about to visit and a rough time estimate.
- Deliberately **not** part of the automatic per-scan pipeline, and deliberately paced with a randomized 4-9s delay between visits (not a fixed bot-like interval) - individually visiting profile pages is a meaningfully bigger LinkedIn scraping footprint than reading a search-results feed, so this stays a manual, explicit, opt-in action. Each lead is only ever visited once, the same way headline extraction already never re-touches a lead that already has a company.
- New content script (`profile-content-script.js`, matches `linkedin.com/in/*`) only ever runs during this explicit action (gated on a storage flag), so a profile visited during ordinary browsing is never scraped.
- **Known limitation**: this session's tooling has no authenticated LinkedIn session, so the new scraping selectors could not be verified against a real, live profile page before shipping - unlike everything else this session, which was fully harness-tested. The orchestration (confirmation, pacing, tab lifecycle, writing results) was fully verified; the actual DOM selectors are a first attempt and may need a live-tuning pass.

---

# SalesTeam — v0.29.0

## New: Target Accounts Explorer - browse the full company workbook

- Requested: the lightweight Target Accounts import (v0.28.0) only ever kept a score/label/top-initiative slice of the workbook - the user wanted to actually see the full data: every company, its known contacts, and its AI initiatives, linked the same way the workbook itself links them (via Company_ID).
- One import now populates two datasets from the same file pick: the existing lightweight map that drives auto-prioritization, and a new full relational dataset (Companies/Contacts/AI_Initiatives/AI_Investment/Sources) for browsing.
- New **"Target Accounts ↗"** page (button next to Activity Log in the side panel): a sortable/filterable Companies table; click a row to expand it and see its full record plus its related Contacts and AI Initiatives (and AI Investment/Sources when present), filtered by Company_ID.
- `code/xlsx-lite.js` gained a generic per-sheet reader (keeps every column, camelCased) alongside the existing six-column Companies-only one, so the full workbook - not just a fixed handful of fields - is available in the browser without a third-party parsing library.
- Deliberately not bundled into Settings export/import - that data is small, but the full workbook (~700 rows across five sheets) would otherwise get rewritten into every automatic pre-scan backup. Re-picking the same `.xlsx` file in Settings is the recovery path if storage is ever wiped.
- Verified: parsed the real 500-company workbook end-to-end (500/43/91/7/116 rows across all five sheets, matching ground truth exactly) and confirmed the Settings import path populates both datasets from one file pick; harness-tested the new page's sorting, search filtering, and company → contacts/initiatives drill-down against seeded data.

---

# SalesTeam — v0.28.6

## New: show/hide Dashboard columns (Excel-style)

- Requested: the growing column count (Matched Keywords, Company, Priority Reason, etc.) meant the table no longer fit on screen without scrolling right.
- New **"Columns"** button (next to Group by Company) opens a checklist of every column - checked means visible. Each column's existing sort/filter dropdown also gets a quick **"Hide This Column"** item.
- At least one column always stays visible - the last one can't be hidden, so there's never a dead end with no menu left to bring anything back from.
- A hidden column's width and any active filter are preserved and just re-apply once it's shown again. Visibility is remembered per-browser, same as column widths.
- Verified via harness: hiding/showing a column via both the panel and the per-column shortcut correctly updates the header, colgroup, and every row in lockstep; the choice survives a page reload; attempting to hide the last visible column is a no-op and the checkbox correctly stays checked.

---

# SalesTeam — v0.28.5

## Fixed: Job listings no longer get an automatic P1/P2 purely from their employer's Target Account score

- Reported: the top-priority leads were nearly all Job listings, boosted purely by their employer's score even though a job ad's "creator" is the company itself, not a real, contactable person - and the ad typically says nothing beyond the hiring itself. A Post lead is different: there's a real, named individual to follow up with, sometimes a key role (CTO/CIO/Head of AI) in their own right - a genuinely strong lead.
- Job leads no longer get the deterministic Priority 1 override at all, regardless of how confidently their company matches. A Job lead's company match - confident or not - is now always routed to the Sales Mentor as a signal instead, with explicit instructions to weigh it much more conservatively than a Post's: roughly one priority level of lift over what the ad's own content alone would justify, not a jump straight to 1 or 2 on the company's strength alone. Post leads are unaffected - a confident match still gets the deterministic Priority 1, since there's a real person to act on.
- Verified via harness: a Post and a Job lead at the same confidently-scored company are partitioned differently - only the Post gets the hard override; the Job lead is routed to the AI path with the signal still attached.

---

# SalesTeam — v0.28.4

## Changed: Priority reasons are now visible/copyable, and always name a Target Account signal

- Reported after running Re-score All Priorities: "I do not understand most of the tool tips for the priorities" and "since the tool tips reasons are not a column in the table, I cannot copy paste it or screenshot them" - the reason was only ever shown as a native hover tooltip on the priority pill, which can't be selected, copied, or captured cleanly.
- New **Priority Reason** column on the Dashboard table - the same text as the tooltip, but real, selectable content with the same 3-line clamp/click-to-expand as the Content column. Also added to both CSV exports.
- Found and fixed the actual root cause of the confusing tooltips: for a lead that only had a *soft* Target Account signal (Provisional label, or below the score threshold - see 6.11), the Sales Mentor was merely *told* to mention it in its own reason text when relevant, but that's free-text AI writing, not a guaranteed template - it didn't reliably say so, making it look like the Excel data wasn't being used at all even when it was. Every AI-returned priority for a signaled lead now gets a fixed `[Target Account signal: Company scored N/100 (Label)]` tag deterministically prepended to its reason, regardless of the model's own phrasing - the connection to the workbook is now always visible.
- Verified via harness: a lead with a signal gets the fixed tag prepended ahead of the AI's own reason; a lead without one is completely unaffected.

---

# SalesTeam — v0.28.3

## New: warns when the extension has data but no Anthropic API key configured

- Root-caused a real incident: after v0.27.0's folder move wiped storage (see v0.27.1), the Settings backup the user restored brought Topics and leads back but not the Anthropic API key - it's deliberately excluded from every automatic backup, and opt-in (behind a confirmation) on a manual export, so a plain-text secret is never included by default. The key stayed empty from that point on, silently breaking company extraction, prioritization, Draft Message, and both Advisors chats - each only said so when actually clicked ("Add an Anthropic API key on the Settings page first"), with nothing surfacing the gap up front. This is the same category of problem the v0.27.1 empty-state banner addressed, just for a different field.
- Added a second, separate side-panel banner: shown whenever there are real Topics/leads but no API key configured, naming exactly which features need it and pointing at Settings. Deliberately only shown once there's real data, so it doesn't duplicate the existing empty-install banner on a genuinely fresh install (that one already covers "add a key" as part of first-time setup).
- Verified via harness across three scenarios: data + no key (new banner only), data + key (neither banner), and a fresh install with nothing at all (only the original empty-state banner, not both).

---

# SalesTeam — v0.28.2

## Fixed: Target Account matches now also apply via Prioritize Unscored/Re-score All Priorities

- Reported: after importing the Target Accounts workbook, clicking "Re-score All Priorities" on the Dashboard didn't apply the new company priorities - only a fresh scan did, since the Target Account matching logic only lived inside background.js's scan flow.
- Both "Prioritize Unscored Leads" and "Re-score All Priorities" now run the same Target Account check first (`partitionLeadsByTargetAccount`, new shared function in `storage.js`): a confidently-scored match gets Priority 1 immediately, with no AI call and no scan needed; everything else still goes to the Sales Mentor, with a softer match (if any) folded in as a signal, exactly like a scan already did. Importing or updating the Target Accounts list now retroactively re-prioritizes existing leads on demand.
- Found and fixed a real bug in the same code path while refactoring it: the "soft signal" case was mutating the actual stored lead object before sending it to the AI, so a transient `targetAccountSignal` hint was ending up permanently saved on the lead. It's now attached to a throwaway clone instead - verified via a direct test that the original stored object is untouched after re-scoring.
- Also gives a lead auto-prioritized via either Dashboard button the same `targetAccountMatch: true` flag a scan-time match already got, so it stays distinguishable from a Mentor-scored lead regardless of which of the three paths set it.
- Verified via browser harness: re-scoring a seeded batch (one confident match, one Provisional match, one non-match) sets Priority 1 immediately and correctly on the confident match with no API key required, leaves the Provisional one for the AI path, and leaves the non-match untouched; confirmed the original lead object is never mutated by the soft-signal path.

---

# SalesTeam — v0.28.1

## Changed: Target Accounts now imports the .xlsx workbook directly - no conversion step

- Reported right after v0.28.0 shipped: pointing the "Import Target Accounts" file picker at the .xlsx workbook showed no files, since the button only accepted `.json` - the intended flow was to run `convert_target_accounts.py` first, but that's an easy step to forget or not know how to run, especially without Claude Code open.
- Removed that step entirely. New `code/xlsx-lite.js` is a small, dependency-free in-browser `.xlsx` reader purpose-built for this one workbook: it unzips the file with the browser's native `DecompressionStream` and reads the `Companies` sheet's XML with the native `DOMParser` - no third-party parsing library added to an extension that already holds LinkedIn/Anthropic host permissions.
- The Import button now accepts `.xlsx` directly (still also accepts the old `.json` export, for anyone who kept using the Python script). `code/convert_target_accounts.py` still works as an optional offline/CLI path, just no longer required.
- One real bug found and fixed along the way: the actual workbook uses a non-default XML namespace prefix (`<x:sheet>` rather than `<sheet>`) and package-root-relative paths in its relationships file (`/xl/worksheets/sheet3.xml` rather than `worksheets/sheet3.xml`) - both are valid per the OOXML spec but less common, and the first version of the parser (written and tested against the spec, not yet the real file) missed both. Fixed with namespace-aware element lookups and OPC-correct path resolution.
- Verified: parsed the real 500-company workbook directly in a browser and diffed every field of all 490 scored companies against the already-verified Python-script output - exact match. Re-ran the full Settings import flow (real file picker → real workbook → status line) with no console errors.

---

# SalesTeam — v0.28.0

## New: Target Accounts - auto-Priority-1 from an externally-researched company list

- The first piece of a two-part idea: a separately-maintained Excel workbook (ChatGPT-researched) scores 500 Swiss companies for AI-consulting sales fit — a 0-100 score plus a label (`Very High`, `Very High - Provisional`, `High`, `High - Provisional`, `Out of Scope`, `Insufficient Evidence`). The goal: a scanned lead at a well-researched, high-scoring company shouldn't have to wait on the AI's own judgment of an unfamiliar name.
- New `code/convert_target_accounts.py` script converts the workbook's `Companies` sheet to `exports/target-accounts.json` — re-run manually whenever the workbook is refreshed (every few months); the extension never reads the `.xlsx` directly.
- New Settings section: **Import Target Accounts** button (same file-picker pattern as Import Settings/Leads) plus a configurable auto-Priority-1 score threshold (default 70).
- **Deterministic Priority 1**: a "New" lead with no priority yet, whose company matches a target account labeled `Very High` or `High` (never a `Provisional`/`Insufficient Evidence`/`Out of Scope` one) at or above the threshold, is automatically set to Priority 1 during the scan's post-processing, before the batch AI prioritization pass runs. Deliberately excludes Provisional/low-evidence matches from this hard override — inspecting the real workbook found the *highest* scores concentrated in a large "Provisional" cluster (thin evidence, not confirmed fit), so a blind score-only threshold would have auto-prioritized speculative matches with full confidence.
- **Soft signal otherwise**: a match that doesn't clear that bar is still passed into the existing AI prioritization call as context, so the Sales Mentor weighs it alongside its usual judgment. Either way, the priority pill's tooltip (`priorityReason`) names the match and its score, so it's always clear when the target-account list influenced a call.
- Company matching reuses the existing `normalizeCompanyName()` (already used for company grouping elsewhere) rather than adding new matching logic.
- The imported list and threshold travel with a Settings export/import, so they survive a fresh install or restored backup like every other setting.
- Verified: ran the conversion script against the real workbook (490 companies with a score, matching the expected per-label distribution); browser-harness test confirmed a confident high-score match gets auto-Priority-1 with the expected tooltip text, a Provisional match is left for the AI pass with the signal attached, and a non-matching company is untouched.

---

# SalesTeam — v0.27.1

## New: warns when the extension comes up completely empty

- Reported after v0.27.0's folder move: reinstalling the extension pointed at its new `/code` location came up with zero leads and zero settings, with no explanation - alarming, even though the data wasn't actually lost (it lives in a `/backup` file, restorable via Import Settings/Import Leads).
- Root cause of *why* this happens at all: Chrome ties an unpacked extension's storage to its install location, not its code or manifest content - moving or reinstalling from a different path is a different extension as far as Chrome is concerned, with its own blank storage. There's no API that lets a new install read an old one's storage, even a former version of itself at a different path, so this can't be fixed with automatic migration.
- Added the next best thing: the side panel now shows a clear banner whenever it finds zero Topics/Job Topics and zero leads, explaining what likely happened and pointing directly at Import Settings/Import Leads instead of leaving a silent, unexplained blank slate. Worded to also make sense for a genuinely new install with nothing to restore.
- Going forward this specific incident shouldn't recur: `/code` is now the permanent, stable install location - every future update edits those files in place, so reloading the extension (the refresh icon in `chrome://extensions`) never changes the install path or resets storage again.
- Verified via harness: the banner shows when both Topics and leads are empty, and stays hidden as soon as either has real data.

---

# SalesTeam — v0.27.0

## Changed: project folder reorganized into /code, /backup, /exports, /log, /builds

- Requested for a cleaner project folder - everything used to sit flat at the SalesTeam root: extension source, every backup/export download, and every historical release zip all mixed together.
- **`/code`** — the actual loadable extension (manifest.json, every .js/.html/.css file, icons/) plus the Python doc-generation scripts (previously living outside the project entirely, in a session scratchpad). Chrome's unpacked-extension loading requires manifest.json and everything it references to stay in one folder together (no `../` escapes allowed), so this is the one folder Chrome's "Load unpacked" now needs to point at - **this is the one manual step needed after updating**: remove the old unpacked extension and re-load it pointing at `SalesTeam/code`.
- **`/backup`** — Export Settings/Leads (manual and automatic pre-scan) now download here instead of the project root.
- **`/exports`** — CSV exports (side panel and Dashboard) now download here instead of the project root.
- **`/log`** — new: a **periodic Activity Log export**. Since this app deliberately never runs anything in the background on its own, this piggybacks on the existing manual Scan trigger (the same moment settings/leads backups already fire): each *closed* day (not today, which is still being written to) gets exported to `log/activityLog-YYYY-MM-DD.json` exactly once, the first time a scan happens on or after the next day. Not a true daily cron, but a predictable, permission-free approximation of one - no new manifest permission needed.
- **`/builds`** — every release's zip now gets archived under its own `builds/vX.Y.Z/` folder (including a copy of that exact version's manifest.json, extracted from its zip), replacing the previous practice of deleting the old zip when a new one shipped. All prior releases still in the repo were backfilled into this structure.
- Along the way, found and fixed a real gap: `.gitignore`'s old filename-pattern rules for backups (`salesteam-auto-backup-*.json` etc.) had silently stopped covering the newer split filenames (`salesteam-auto-leads-backup-*`/`salesteam-auto-settings-backup-*`, introduced in v0.25.1) - replaced with folder-level ignores (`/backup/`, `/exports/`, `/log/`) that can't drift out of sync with a future naming change the same way.
- Verified via harness: the reorganized extension loads and renders correctly from its new `/code` location with no broken internal references; the new pending-export-day tracking correctly excludes today, exports each closed day exactly once, and never re-exports a day already marked done.

---

# SalesTeam — v0.26.2

## Changed: Activity Log can no longer be manually cleared - and every button in the app now has a hover tooltip

- Reported: "Please remove this Clear Log button. I do not want to delete the activity log ever. It is my only way to investigate if anything broke." The 2000-entry cap was also a raw count that could silently drop recent history during a single unusually active day - replaced with a predictable, always-90-days retention window instead.
- Removed the "Clear Log" button and `clearActivityLog()` entirely - there is no action anywhere in the app that can delete this log.
- Rearchitected storage: one array per calendar day (`activityLog:YYYY-MM-DD`) instead of one shared array. Each write only touches that day's (small) array, and anything older than 90 days is pruned automatically on every append - a predictable "always the last 90 days" guarantee instead of a count that could exhaust itself faster during a busy day. Existing log data from v0.26.0/v0.26.1's flat single-key scheme is migrated automatically (bucketed by each entry's own timestamp) the first time the log is read, then the old key is removed.
- Also finished the hover-tooltip pass from earlier - every remaining untitled button across the Dashboard (including the lead detail/edit page, Bulk Change, Assign Company), Advisors, and Help now has a `title` explaining what it does, matching what was already done for the side panel.
- Verified via harness: today's entries land in the correct day-bucket; a 100-day-old bucket is pruned while a 30-day-old one survives; a simulated legacy flat-array log is correctly split into per-day buckets and the old key removed.

---

# SalesTeam — v0.26.1

## Fixed: Activity Log didn't update live while open

- Reported immediately after shipping v0.26.0: clearing results and starting a scan while the Activity Log tab was already open showed only the "Cleared results" entry - the scan's own logging never appeared until the page was manually reloaded.
- Root cause: the page loaded its data once on open and never refreshed - a static snapshot, not a live view, unlike the Dashboard/Advisors pages which already react to `chrome.storage.onChanged`.
- Fixed by adding the same `chrome.storage.onChanged` listener, re-loading and re-applying the current filters whenever the log changes - matching the pattern already established elsewhere in the app.
- Verified via harness: simulating a background-written log append (no message, no reload) updates the open page automatically.

---

# SalesTeam — v0.26.0

## New: in-app Activity Log - every user and extension action, without opening DevTools

- Prompted by today's two incidents: an AND-topic bug that could only be diagnosed via the background service worker's DevTools console (which the user found unreliable - it cleared itself when the worker went idle, showing empty at exactly the moment it was needed), and a data-loss incident that had to be reconstructed after the fact from context clues. Both would have been immediately obvious with a persistent, in-app log.
- New **Activity Log** page (side panel's top-nav row, next to Help) records both **User** actions (topic/negative-topic add/remove/enable/edit with keyword-count old→new, running a scan, Export/Import Settings and Leads, lead status/priority/company changes, Bulk Change + Undo, Prioritize/Re-score/Extract Companies, Apply Negative Filters, accepted Lookalike/Search-Quality suggestions, settings field edits, clearing an AI conversation) and **Extension** actions (scan lifecycle, automatic negative-topic filtering on discovery and on re-apply, automatic company extraction, automatic prioritization including correlated re-scoring, and every error along the way) - each with Date/Time, Actor, Action, Previous Value, New Value.
- **Critical design point**: written directly to `chrome.storage.local` from wherever each action actually happens - including inside `background.js` itself - never inferred from `chrome.runtime.sendMessage` broadcasts, which are silently lost entirely if no page happens to be open when a scan runs (confirmed: this was already true of every scan-lifecycle message before this feature, with no storage-backed fallback). So the log is complete even for a scan that ran while both the side panel and this log page were closed.
- Free-text fields (topic keywords, company context, message templates, etc.) log once per real edit (focus → blur, only if the value actually changed), not once per keystroke - editing a field and reverting it back logs nothing.
- The Anthropic API key's actual value is never logged, only "API key changed" - before/after values are always `null` for that one field specifically.
- Capped at 2000 entries (oldest dropped first) - chrome.storage.local has no `unlimitedStorage` permission here (5MB real quota), and nothing else in the app currently guards against quota exhaustion, so the log is deliberately self-limiting. A "Clear Log" button (confirm-gated, clearly worded as permanent) resets it if wanted - this only clears the log itself, never any lead or setting.
- Filterable by actor (All/User/Extension), free-text search, and an "Errors only" toggle; error rows are visually flagged.
- Verified via harness: the storage-level cap/append logic; real focus→edit→blur logging on a live topic keyword textarea (and confirming a no-op focus/blur logs nothing); Add/Remove Topic and Scan-started logging; the Activity Log page's rendering and all three filters against seeded data, including Clear Log; a full scan run correctly logging `scan_completed` and an aggregate `negative_filters_auto_applied` count; and the API key field's blur handler never carrying the actual key text.

---

# SalesTeam — v0.25.1

## Fixed: v0.25.0's AND-topic join never actually intersected anything

- Reported immediately after shipping v0.25.0: every AND-topic came back with "0 intersected" leads, live on real LinkedIn - a strictly worse outcome than the original problem, since these topics now produced zero leads via a different mechanism.
- Root cause: the concept/activity intersection was keyed on `post.key`, which falls back to `profileUrl + first 80 characters of the snippet` whenever LinkedIn doesn't expose a real permalink (the common case). That snippet excerpt is very likely not stable for the same real post across two independent searches - LinkedIn appears to center the shown excerpt on wherever the matched term sits in the post body, so a concept-match excerpt and an activity-match excerpt of the identical post can start at completely different points, producing two different keys for one real post and guaranteeing they'd never intersect.
- Fixed by joining on `profileUrl` instead - the author's identity, which doesn't depend on which excerpt LinkedIn happened to show. The post's own snippet-based `key` is untouched everywhere else (Dashboard rows, CSV export, cross-scan dedup). Same fix also applies to a same-phase duplicate (the same post surfacing via two chunks of one group), which was likely silently affected by the identical instability.
- Verified via harness with the same real post deliberately given three different snippet excerpts across its three appearances (mirroring the live symptom) - the fix correctly intersects it as one match, while genuinely different people are still correctly excluded.

## Fixed: "Clear Results" permanently deleted every saved lead - now it only clears the view

- Discovered mid-investigation of the bug above: "Clear Results" (side panel) never just cleared the visible list - it called `clearResults()`, wiping chrome.storage.local's entire lead database, with only a confirm() dialog standing between a click and permanently losing everything (which is exactly what happened this session: 185 real leads gone).
- Fixed at the actual behavior, not just the label: the button is now purely visual - it clears this panel's own displayed list and never touches storage. A saved lead is no longer deletable by anything in the app except a person's own explicit per-lead action. Reopening the panel, or running a new scan, shows every saved lead again.
- Also removed the now-dead `clearResults()` storage function entirely, so there's no destructive path left to accidentally wire back up later.

## New: Settings and Leads now back up as two separate files - and the auto-backup covers everything persistent

- Reported alongside the incident above: the combined backup/restore file meant recovering lost leads would also silently roll back any Topic/settings edits made since that backup was taken - a real cost the user hit firsthand needing to recover from the "Clear Results" incident.
- Split into two independent files and flows: **Export/Import Settings** (Topics, Job Topics, filters, personas, company context, message templates, API key) and **Export/Import Leads** (the full lead history, plus - newly captured, previously missing from any backup entirely - the generic Sales Mentor and Customer Voice conversation histories, which live in their own storage separate from any one lead). Restoring one can never touch or roll back the other.
- **Import Leads merges, it never replaces**: a lead already saved locally is left exactly as-is (its current status/priority are presumably more current than an older snapshot); only a lead genuinely missing locally gets restored back in. Same principle for the two chat histories - only restored if the current one is empty, never overwriting a live conversation.
- The automatic pre-scan backup now downloads both files every time, replacing the single combined `salesteam-auto-backup-*.json`.
- Verified via harness: exporting leads includes both chat histories and the last-scan timestamp; importing a backup with a stale version of an existing lead leaves the local (newer) one untouched while still restoring a genuinely-missing lead; a non-empty local chat history survives an import that carries a different one.

## Minor GUI fixes

- The Dashboard/Advisors/Settings/Help buttons (side panel) were wrapping their trailing arrow onto a second line instead of sitting beside the label - fixed with `white-space: nowrap`.
- Added hover tooltips (native `title` text) explaining what each button does, across the side panel - continuing across the rest of the app in a follow-up.

---

# SalesTeam — v0.25.0

## Changed: AND-topics now search additively, not multiplicatively - the same AND, at a fraction of the cost

- Real problem: the user built a well-designed AND-topic (~23-30 "AI" concept keywords AND'd with ~23-30 "transformation/project/initiative" activity keywords, EN + DE) specifically to fix the "AI Transformation" topic generating zero leads. It worked as a search, but pushed one real scan to 68 sub-queries - because the AND was enforced by combining both keyword groups into ONE LinkedIn query per pairing, requiring a full cartesian product of concept-chunks × activity-chunks. Dropping the AND entirely (discussed and rejected) defeats the purpose: "AI" alone floods with irrelevant chatter, "transformation" alone floods with unrelated business posts - the join of the two is the actual signal my wife needs.
- Fixed at the root, per the user's own proposed design: the two keyword groups now run as **two independent, cheap LinkedIn searches** (each a plain OR list, chunked straight at 6 terms - no combining), and the AND is applied **client-side** by intersecting the two raw result sets on the post's own key, keeping only posts that appeared in both. Same logical AND, additive sub-query cost instead of multiplicative - a 30×30 topic that cost 48 sub-queries now costs 10. The Topics UI and data model are completely unchanged; this is invisible to the salesperson.
- Recall trade-off, identified and mitigated before shipping: today, LinkedIn intersects both groups server-side across its entire index before the app's bounded scrape takes its slice, so that slice is already 100% genuine double-matches. Under the new design, each phase searches a broader single-constraint corpus, and a real double-match could rank below the scraped cutoff in one phase and never reach the intersection. Mitigated by scraping deeper (more scroll passes, doubled) specifically on these two phases only - more scrolling per page, not more LinkedIn requests, so it adds latency, not detection risk.
- The per-topic and grand-total search-count hints (side panel, v0.19.0/v0.24.6) automatically reflect the new additive math - no separate change needed there.
- Verified via a mocked harness around the actual scan loop: sub-query count for an AND-topic is additive (2 concept chunks + 1 activity chunk = 3, not 2×1... or worse for larger lists); a post matching only one group is correctly excluded from the topic's final matches; a post matching both groups survives with the better (lower) of its ranks across both a same-phase duplicate and the cross-phase merge; a topic with no AND group is completely unaffected (regression-checked). Real-world lead volume/quality still needs a live scan to judge, the same way the earlier prioritization-prompt fix did.

---

# SalesTeam — v0.24.6

## New: total-searches-per-scan estimate in the side panel

- Each Topic already showed its own "N searches for this topic" hint (v0.19.0-era), but there was no grand total anywhere - the user had to add these up by hand (a real scan hit 68 sub-queries, discovered only after starting it) to know what a scan would actually cost before running it.
- New live total, right above the "Scan All Topics" button: "Total: 76 searches this scan will run (Posts: 60, Jobs: 16)." - sums every enabled Post topic's AND-style chunk count plus, when Job Search is on, every enabled Job-only topic and (if "use Post topics for Jobs" is also on) those same Post topics again, flat-chunked for Jobs - mirroring background.js's scanAllTopics exactly, including the additive (not either/or) relationship between Job-only topics and Post topics reused for Jobs.
- Recomputes on every topic edit, add, remove, enable/disable toggle, and either Job Search checkbox - so growth is visible immediately as keywords are added, not just per-topic. Turns orange past 30 total searches, the same visual treatment already used for a single expensive topic.
- Verified via harness against the exact numbers from the "68 rounds" investigation (2 topics, 23×23 each): computed 60 Post sub-queries with Job Search off, and correctly added 16 more (2 topics × 8 flat-chunked sub-queries each) once Job Search + "use Post topics for Jobs" were both on.

---

# SalesTeam — v0.24.5

## Fixed: bulk prioritization progress said "0 of N" while the first chunk was already running

- Reported: clicking "Re-score All Priorities" showed "Re-scoring 0 of 136 leads…" - misleading, since the first chunk of 20 was already in flight, not stalled at zero.
- The progress callback fired after each chunk finished, so the count only ever reflected completed work, starting at 0 before anything had a chance to complete. Moved it to fire as each chunk starts instead, so the status now reads "Re-scoring 20 of 136 leads…" from the first moment - the count in flight, not the count already done.
- Verified via harness: the status now progresses "Re-scoring 45 leads…" → "Re-scoring 20 of 45…" → "Re-scoring 40 of 45…" → "Re-scoring 45 of 45…" → "Done" - no "0 of 45" step.

---

# SalesTeam — v0.24.4

## New: Matched Topic and Matched Keywords columns on the Dashboard

- Two new sortable/filterable table columns, right after Source: **Matched Topic** (every Topic this lead matched, e.g. from a re-scan with edited keywords) and **Matched Keywords** (the actual keyword(s) that triggered each match, deduplicated across topics) - the same data the CSV export already carried, now visible and filterable directly in the table without exporting.
- Lets a question like "which topics are actually producing leads" or "what keyword is dragging in this noise" be answered by sorting/filtering the table directly, the same workflow already used to investigate the AI Transformation topic and the Negative Topic false positives earlier.
- Verified via harness: a lead matching multiple topics shows both joined with "; ", keywords are deduplicated across topics, a lead with no match shows "—", and the column-filter dropdown correctly narrows the table by topic name.

---

# SalesTeam — v0.24.3

## Fixed: Ideal Customer Profile mismatch was crushing strong buying signals to the bottom of the scale

- Reported: several leads with an explicit, on-topic hiring signal for exactly the kind of work sold (an AI Engineer job ad with LangGraph/agentic AI/RAG requirements at vFairs; a contract AI Developer hire using LangChain/Anthropic at a mental-health practice; a walk-in AI Developer hire at an Indian software company) were all scoring P4-P5 - the bottom of the range - despite the clear technical fit.
- Traced through the actual detection: `isHiringPost`/`isJobAd` and `company` extraction were all working correctly for these leads - the AI genuinely saw the hiring signal and the company. The defect was in how the prompt weighed things: geography/company-size mismatch against the Ideal Customer Profile (Switzerland, enterprise) was being treated as effectively disqualifying, overriding an otherwise strong, explicit buying-intent signal.
- Fixed by making the prompt explicit that Ideal Customer Profile fit is a secondary, moderating factor, not a pass/fail gate - a real, on-topic need outside the exact ICP should typically land around 2-3, not the bottom. The bottom of the range (4-5) is reserved for leads with no genuine buying signal at all, a clearly unrelated technical domain, or noise that should already have been filtered - not simply "real need, wrong location."
- Not mechanically testable the way the chunking fix was (this changes the AI's judgment, not the app's data flow) - re-run "Re-score All Priorities" against your real leads to see the effect.

---

# SalesTeam — v0.24.2

## Fixed: bulk prioritization silently scored nothing on a large batch

- Reported: "Re-score All Priorities" ran for 70+ seconds and finished with "0 leads re-scored, 0 changed priority" - and separately, that the elapsed-time-only status from v0.24.1 didn't say how much longer there was to go.
- Root cause: prioritization sent every eligible lead in a single AI call, with the response capped at 8192 output tokens. With enough leads (each needing a priority plus a written reason), that cap could be hit mid-generation - the tool call comes back truncated/invalid, and the app had no way to tell that apart from "the model legitimately found nothing to score," so it silently applied zero results.
- Fixed by chunking both "Prioritize Unscored Leads" and "Re-score All Priorities" into batches of 20 leads per AI call, applying each chunk's results as soon as it completes (so a later chunk failing doesn't lose earlier progress) rather than one unbounded call for the whole list.
- This also directly answers the progress-visibility ask: the status now shows real counted progress - "Re-scoring 20 of 45 leads with the Sales Mentor…" - updating after every chunk, instead of only an elapsed-time guess with no sense of how much is left.
- Verified via harness with 45 leads (3 chunks of 20/20/5): confirmed the outgoing calls are correctly split, the status text progresses through real counts as each chunk lands, and a manually-set priority is still never sent.

---

# SalesTeam — v0.24.1

## Fixed: no feedback while Re-score All Priorities was running, and no visibility into what actually changed

- Reported: clicking "Re-score All Priorities" gave no indication whether it had run, completed, or was still working - a single unbatched AI call across every eligible lead can genuinely take tens of seconds, and the button gave no sign of life during that wait.
- Now ticks a live elapsed-time status while the call is in flight ("Re-scoring 160 leads with the Sales Mentor… (12s)"), the same pattern already used for long Sales Mentor chat turns, so a real wait reads as progress rather than a hang.
- The completion message now reports two numbers, not one: how many leads were successfully re-scored, and how many of those actually ended up with a *different* priority than before (comparing each lead's prior priority to its new one) - e.g. "Done - 160 leads re-scored, 34 changed priority." Previously it only ever reported the first number, which doesn't tell you whether the re-score changed anything.
- Verified via harness with a simulated slow API call: the status ticks through multiple elapsed-second values before completing, and the changed-priority count correctly distinguishes a lead whose new score matches its old one from one that actually moved.

---

# SalesTeam — v0.24.0

## New: Re-score All Priorities, and a prompt fix for thought-leadership posts scoring too high

- Reported: two AI-scored leads that clearly didn't deserve their priority - a P3 post that was just industry commentary on AI market trends from someone at an outsourcing company, and a specific example (a "Head of AI for IT" post that was really just a roundup of AI industry news, no expressed need) scored P3 when it should be P4-5. Both share a pattern: an impressive, on-topic-sounding title or company, but the post itself contains no actual buying-intent signal.
- Strengthened the prioritization prompt: topical overlap and an impressive poster title are not buying intent on their own. A post that's really just industry commentary or thought leadership - reacting to AI news, sharing opinions/trends - with no expressed need, project, challenge, or hire of its own is now explicitly called out as a weak lead (4-5), regardless of how senior or on-topic the poster looks.
- New **Re-score All Priorities** button on the Dashboard, next to "Prioritize Unscored Leads" - re-runs AI prioritization on every "New" lead the Mentor has already scored, not just unscored ones, so prompt fixes and the new Ideal Customer Profile (v0.23.0) can retroactively apply to leads scored before they existed. Same manual-override protection as everywhere else: a priority you set yourself (no `priorityScoredAt`) is never touched or resent to the AI. Prompts for confirmation first, since it overwrites existing AI-assigned priorities.
- Verified via harness: an unscored lead and a previously-AI-scored lead are both sent and re-scored; a manually-set priority and a non-"New" lead are both left completely untouched and never sent to the AI.

---

# SalesTeam — v0.23.0

## New: Ideal Customer Profile setting, and manual Priority override

- New "Ideal Customer Profile" field on the Settings page, deliberately separate from "What We Offer" - who you're targeting (company size, geography, what they're investing in) is a different concept from what you sell, even though every AI feature reads both together. Threaded into prioritization, the Sales Mentor (both the cross-lead and per-lead chat), Account Summaries, and Analyze Post Search Quality - everywhere "is this the right kind of prospect" reasoning happens. Not used by Customer Voice (a simulated buyer has no reason to reason about who the seller targets).
- New **Priority** dropdown on the Dashboard lead detail page, right next to Status - lets you override a priority the Mentor got wrong, or set one on a lead that was never scored. A manual override is permanently protected from both the automatic per-scan pass and the correlated re-scoring pass (v0.17.1) - neither can silently overwrite a human's call, since both key off whether the AI itself scored the lead (`priorityScoredAt`), not just whether a priority exists. Clearing it back to "Not scored" makes the lead eligible for automatic scoring again.

---

# SalesTeam — v0.22.1

## Fixed: automatic prioritization couldn't see a Post lead's company or job-ad flags

- Reported: after fixing the Negative Topic false positives, Post leads still weren't scoring P1-P3 - a real example (a bank running an internal AI/Digital Transformation program, hiring an AI Engineer) scored P4 when it should plausibly have been P2-P3.
- Root cause: `summarizeLeadForPrioritization` never included a Post lead's `company` (AI-extracted since v0.17.0) or its `isJobAd`/`isHiringPost` flags - the batch auto-scoring pass had strictly less context than the interactive Mentor chat gets for the same lead via `list_leads`. Company-level signal (a real company running a relevant program) was invisible to the score.
- Also strengthened the prompt: for an in-post job ad, the poster is often HR, a recruiter, or an unrelated employee sharing the opening, not the eventual contact - it's now told explicitly not to penalize the score just because the poster personally lacks seniority, since the real signal is the company-level program, and the next step is finding a better contact there.
- Verified via harness: the outgoing request now includes `company`/`isJobAd`/`isHiringPost`/`isFreelancePost` for Post leads, and the prompt carries the new guidance.

---

# SalesTeam — v0.22.0

## New: negative topics can now match a lead's company, and a Known Recruiting Firms filter

- Negative Topics can now check a Post lead's `company` (AI-extracted or manually assigned, since v0.17.0) in addition to headline/snippet text - a far more precise signal, since it targets who the poster actually works for rather than a self-description or a passing mention.
- New built-in "Known Recruiting Firms" negative topic, matched against company name: Adecco, Randstad, Michael Page, PageGroup, Swisslinx, Robert Walters, Hays - a more reliable alternative to guessing from headline text.
- Default `Competitor Blocklist` no longer includes generic cloud/AI platform vendors (Microsoft, Google, AWS, NVIDIA) - those get mentioned constantly as mere tooling references in unrelated posts, which was killing a large share of genuinely good leads. Kept to firms that actually compete for the same consulting/services work.
- These are new *defaults* for fresh installs only - an existing configuration isn't touched automatically, since Negative Topics are the user's own live settings. To pick up the fix: manually remove the platform-vendor keywords from your own `Competitor Blocklist`, and add a `Known Recruiting Firms` negative topic yourself if you want it (or ask the Sales Mentor's "Analyze Post Search Quality" to suggest it now that it can see the improvement is possible).

---

# SalesTeam — v0.21.0

## Analyze Post Search Quality now also looks at Irrelevant leads - and found a real bug doing it

- The user found two concrete examples of legitimate leads (a real product company's in-post job ad) wrongly marked Irrelevant, and traced both to real issues: `Recruiter/Staffing Headline Filter` is too blunt (an in-house HR/Talent-Acquisition poster's own employer opening isn't the same as a third-party staffing agency), and `Competitor Blocklist` mixes actual competing consultancies with generic cloud/AI platform names (Microsoft, Google, AWS, NVIDIA) that get mentioned constantly as mere tooling references, not evidence of a competitor.
- This was invisible to "Analyze Post Search Quality" because it was scoped to skip Irrelevant leads entirely - exactly the leads that would reveal an over-aggressive Negative Topic. Now includes them: new `stats.irrelevantByNegativeTopic` breakdown shows which Negative Topic is suppressing how many leads, each Irrelevant example carries its exact `irrelevantReason`, and the Mentor is explicitly told not to assume a classification is correct just because it happened - a generic platform mention or an in-house HR poster are named as classic false positives to flag as removal suggestions.
- Still excludes Dismissed/Contacted/Responded/Converted - those are the salesperson's own decisions, not the system's, and not what this audits.

---

# SalesTeam — v0.20.1

## Fixed: Analyze Post Search Quality only ever suggested more Negative Topics

- Reported: with zero P1-P3 Post leads, every suggestion was another Negative Topic (narrowing further, not helping). Root cause: the analysis never had access to the company context (what the business actually sells), so the Mentor had nothing to reason from except a pile of uniformly mediocre example posts - which naturally pushes toward "here's what's wrong with these" (negative topics) rather than "here's what a good one would look like" (new positive keywords, which requires knowing what to look for).
- Now passes company context into the analysis, and explicitly tells the model that a Negative Topic can only ever reduce volume, never fix a shortage of good leads - when there are zero or few P1-P3 leads, it must propose new Topic keywords or a new Topic grounded in what the company actually sells, not just narrow further.

---

# SalesTeam — v0.20.0

## New: "Analyze Post Search Quality" - diagnose and fix why Posts aren't scoring well

- New button in the Scanner side panel (Search Quality section, after Negative Topics) has the Sales Mentor look at every unactioned ("New") Post lead plus your current Topics and Negative Topics together, diagnose what's likely limiting quality or volume, and propose specific keyword changes across both - additions, removals, or a genuinely new Topic or Negative Topic.
- This is the actual fix for the problem "Suggest Lookalike Topics" can't help with: that feature only has good examples to learn from once Posts are already scoring well. This one looks at what's actually coming through (even if none of it scores highly yet) and the search configuration itself.
- Fully review-first, same as every other config-mutating flow in the app: each suggestion shows its reasoning, add-suggestions let you redirect to an existing Topic/Negative Topic or accept a new one, and nothing is written until you check it and click "Apply Selected." A removal suggestion referencing a keyword that's already gone (edited since, or the AI got it wrong) is filtered out rather than shown as a broken action.

---

# SalesTeam — v0.19.1

## Fixed: Lookalike Topics was learning from Job leads and suggesting job-title keywords

- The v0.18.0 feature gathered example leads from every type (Posts and Jobs) but only ever wrote suggestions into Post Topics. Since Job leads carry no scraped body text - only title/company/location - the AI had nothing to generalize from except the job title itself, and just echoed it back as a "keyword." When most high-priority leads happen to be Job leads, this actively pulled Post Topics toward job-title language instead of helping find more Posts.
- Now restricted to Post leads only (P1-P3, widened from just P1), since only Posts have real content to learn from and only Post Topics get written to.

---

# SalesTeam — v0.19.0

## New: Group by Company, Excel-style, right in the leads table

- New **Company** column on the Dashboard table, sortable and filterable like any other.
- New "Group by Company" checkbox clusters leads by company - Excel-style outline grouping, right inside the same table (not a separate view): a collapsible header row per company (name, lead count, expand/collapse caret) with its leads nested underneath. Leads with no company yet collect into a trailing "Unknown company" group.
- Each company group has a "Get Account Summary" button - a one-shot AI synthesis across every lead seen at that account (who the real decision-maker looks like, what's collectively happening, a suggested angle), cached per session so re-opening it doesn't re-call the AI.
- Grouping needs a company's leads to stay together, so it temporarily shows "All" leads per page (restoring your previous page-size choice when you turn grouping back off).
- Known limitation, same one noted in v0.17.0: this groups by normalized company name (handles minor legal-suffix differences like "Azqore" vs "Azqore SA"), not by brand/subsidiary aliasing (e.g. "Google Inc." vs "Alphabet") - that needs a proper merge tool, planned as later work.

---

# SalesTeam — v0.18.0

## New: "Suggest Lookalike Topics" - find more leads like your best ones

- New button in the Scanner tile's Topics section looks at your highest-priority (P1, or P1+P2 if you don't have many P1s yet) leads and asks the Sales Mentor what made them strong matches, then suggests new search keywords for finding more like them - the positive counterpart to Negative Topics, which only ever filter noise out.
- Fully review-first, like every other config-changing action in the app: each suggestion shows its reasoning and lets you choose whether to add it to an existing Topic or create a new one, or skip it - nothing is added to your actual Topics until you check it and click "Add Selected."

---

# SalesTeam — v0.17.1

## Improved: priority now re-checks when a second signal shows up for the same lead

- Automatic prioritization previously only ever scored a brand-new lead in isolation. Now, if a scan finds a new lead from the same person (Post leads, matched by profile URL) or the same company (Job leads, matched by the normalized company name from v0.17.0) as an existing "New" lead that's already been scored, both get re-scored together - a second signal from the same account can genuinely change the right priority.
- Only ever touches leads still in "New" status - anything you've acted on (Contacted, Dismissed, Responded, Converted) or that's Irrelevant is never re-scored, no matter what correlates.

---

# SalesTeam — v0.17.0

## New: leads now get a Company - AI-extracted for Posts, manual override always available

- Job leads already had a clean company field from the scrape; Post leads never did - only a free-text headline like "Head of AI for IT @ Azqore". After every scan, a batched AI call now extracts a best-guess company name for every Post lead still missing one (skipped silently with no API key, same as lead prioritization). A "Extract Companies" button on the Dashboard catches up any leads that predate this or ran with no API key.
- New "Assign Company" icon on every lead row opens a small dialog to search every company already seen across your leads (native browser autocomplete) or type a brand-new one - or clear it back to blank. A manually-set (or previously extracted) company is never touched again by the automatic extraction pass, so a scan can't silently overwrite a correction.
- This is foundational groundwork for grouping leads by company on the Dashboard, coming next.
- Known limitation, by design for now: this only normalizes minor legal-suffix variation (e.g. "Azqore" vs "Azqore SA"). It has no way to know that different brand names or subsidiaries are the same company (e.g. "Google Inc." vs "Alphabet", "Facebook" vs "Meta") - that needs a proper alias/merge mechanism, planned as later work alongside a dedicated Companies view.

---

# SalesTeam — v0.16.0

## New: "Buyer Summary" and "Conversation Starters" quick-action buttons

- The lead detail page's Sales Mentor chat now has two one-click buttons above the message box - "Buyer Summary" and "Conversation Starters" - so you don't have to type the same standard requests for every lead. They send the exact same request an equivalent typed message would, through the same conversation you'd get by typing it yourself (same history, same lead-scoped context, same Draft Message tool access).
- First of several features inspired by a look at LinkedIn Sales Navigator's AI features - built natively using data already scraped and your own Anthropic API key, no Sales Navigator subscription needed.

---

# SalesTeam — v0.15.1

## Fixed: Chrome Web Store rejection for excessive permissions

- The Chrome Web Store rejected the v0.15.0 submission for requesting `scripting` and `tabs` without actually needing them - a legitimate finding, not a false flag. Content scripts are injected via the manifest's static `content_scripts` block, which never needed the `scripting` permission (that's only for dynamic `chrome.scripting.executeScript()`, never used here). Every `chrome.tabs.*` call in the code (`create`/`update`/`remove`/`query`/`onUpdated`) only touches tab IDs and load status, never `url`/`title`/`favIconUrl` - the only things the `tabs` permission actually gates.
- Removed both from `manifest.json`. No functional change - every tab-management call already worked without them, since this extension only manages tabs it created itself or ones already covered by its `linkedin.com` host permission.
- Updated the Chrome Web Store listing's permission-justification section to drop the now-removed entries.

---

# SalesTeam — v0.15.0

## New: in-app Help page, with fuzzy-matching Q&A search

- New "Help ↗" button next to Dashboard/Advisors/Settings, opening a dedicated Help page with ~27 curated Q&As across Topics, Negative Topics, Dashboard, Advisors, and Settings, plus a free-text search box.
- Search is deliberately not AI-based - it's an instant, client-side fuzzy/synonym matcher (tokenizes the query, tolerates typos and word-order/prefix variation, no network call or API key needed). It's built to answer a *fixed* set of canonical questions, not generate new text, so two different phrasings of the same question reliably land on the same answer - e.g. "Enable topic" and "disable a search topic" both surface "How do I enable or disable a Topic without deleting it?" as the top result.
- Each result is a collapsible card; clicking the question expands/collapses its answer.

---

# SalesTeam — v0.14.2

## Fixed: the v0.14.1 tooltip fix wasn't actually being saved

- The refreshed "(matched...)" reason from v0.14.1 was computed correctly in memory, but "Apply Negative Filters" only wrote changes back to storage when a lead's *status* actually flipped - a lead that stayed Irrelevant (because a different keyword in the same topic still caught it) got its reason silently discarded instead of saved, so the tooltip kept showing the old topic-only text forever.
- Fixed: any reason refresh now counts as a real change worth saving, not just a status flip. Verified directly: a lead already Irrelevant with the old-format reason now correctly picks up the new "(matched ...)" text after clicking "Apply Negative Filters," even though its status doesn't change.

---

# SalesTeam — v0.14.1

## Irrelevant status tooltip now names the specific keyword, not just the topic

- Not a bug fix - "Apply Negative Filters" correctly leaves a lead Irrelevant when it matches more than one keyword and you only remove one of them. But the hover tooltip only ever named the *topic* ("Recruiter/Staffing Headline Filter"), which made that completely indistinguishable from "this didn't work" when a topic holds several keywords.
- The tooltip now names both, e.g. `Recruiter/Staffing Headline Filter (matched "Recruiter")` - and refreshes every time "Apply Negative Filters" runs, even for a lead that stays Irrelevant, in case a *different* keyword in the same topic is what's actually catching it now.

---

# SalesTeam — v0.14.0

## New: "Apply Negative Filters" - instant, bidirectional, no scan needed

- Editing a negative topic only ever affected *future* scans, or (if you checked "apply on next scan") newly-caught matches among existing leads - it never handled the reverse: a lead already marked "Irrelevant" whose matching topic you later edited or removed just stayed Irrelevant forever, with no way back short of manually changing it.
- Both the on-demand action and the existing "apply on next scan" checkbox are now **bidirectional**: every "New" lead gets re-checked (moving to Irrelevant if it now matches), and every "Irrelevant" lead gets re-checked too (moving back to New if it no longer matches anything). A lead you've already acted on yourself - Contacted, Dismissed, Responded, Converted - is never touched by either direction; this only ever second-guesses the system's own past decision, never yours.
- New **"Apply Negative Filters"** button, right in the Scanner tile's Negative Topics section (not a separate tab) - since every field there already autosaves as you type, this just runs the check against whatever's currently on screen, with no need to wait for or trigger a new scan. Shows exactly how many leads moved each direction.
- Verified with leads covering every case: a New lead that newly matches, an Irrelevant lead that no longer matches, an Irrelevant lead that still matches (correctly left alone), and a Dismissed lead that matches but must never be touched.

---

# SalesTeam — v0.13.3

## Hardened scans against a specific stuck-scan cause, ahead of testing on a new machine

- `keepAliveSleep` (pings local storage every few seconds so Chrome doesn't decide the extension's service worker is idle and kill it mid-scan) only ever covered the deliberate delay *between* searches - it never covered the up-to-35-second window each search itself can spend waiting on page navigation (20s) and the content script's scrape result (15s). A single slow page load - plausible on an unfamiliar or monitored network - could leave the service worker with enough silent, API-free time to get killed by Chrome outright, which looks exactly like "the scan is stuck forever," since the process that would have reported completion no longer exists.
- Extended the same keepalive ping to cover *every* wait in the scan loop (both Posts and Jobs), not just the delay between them. Verified in isolation: pings fire on schedule while a wait is pending and stop cleanly the moment it resolves, with the original result passed through unchanged.
- This is a hardening fix, not a confirmed root-cause fix - the previous stuck-scan report was never conclusively diagnosed. Worth watching closely on the first real test on a different machine (a work laptop, likely a different network) to see if it recurs.

---

# SalesTeam — v0.13.2

## Hover an "Irrelevant" status to see why

- The Dashboard's status pill now shows a tooltip naming the specific negative topic that caught it (currently always "Competitor Blocklist" or "Recruiter/Staffing Headline Filter", but it'll show any custom negative topic you add too - it's not hardcoded to just those two).
- Recorded going forward at the moment a lead is marked Irrelevant (a fresh scan, "Re-apply to existing leads", or the reapply-on-scan checkbox).
- Existing Irrelevant leads that predate this (including ones just migrated from the old "Blocked" status) get the reason filled in automatically, best-effort, by re-checking them against your current negative topics the next time they're read - no rescan needed.

---

# SalesTeam — v0.13.1

## Bulk Change dialog: added a close (✕) button

- Top-right corner, styled like a Windows title-bar close button (turns red on hover) - same effect as Cancel, just where people instinctively look for it.

---

# SalesTeam — v0.13.0

## Dashboard: hide Irrelevant leads by default, and a much safer Bulk Change

- **New "Show Irrelevant (negative-filtered) leads" checkbox** next to the status filter, unchecked by default - the Dashboard's "All statuses" view no longer clutters the table with every negative-filtered lead. Explicitly picking "Irrelevant" from the Status dropdown still shows them regardless of the checkbox. The preference is remembered across visits.
- **Bulk Change moved and locked down.** It's no longer an always-visible control next to the search bar - it's now a small, deliberately unobtrusive "Bulk Change…" button tucked into the pagination row below the table. Clicking it opens a real popup dialog with:
  - A red warning stating exactly how many currently-filtered leads will be affected.
  - No default status pre-selected - you must explicitly choose one before Apply does anything.
  - The same confirmation prompt as before, on top of all that.
  - A new **"Undo Last Bulk Change"** button in the same dialog, which restores every affected lead to whatever status it had immediately before - a real safety net if a bulk change happens by mistake despite the above. Only holds one level of undo (the most recent bulk change), and the record persists even if you close the Dashboard and come back later.

---

# SalesTeam — v0.12.2

## Status renamed: "Blocked" → "Irrelevant"

- Clearer distinction from "Dismissed": "Dismissed" is always a person's own decision, while this status is the system's - a lead the negative-topic filters recognized as a competitor or recruiter/staffing post, never one you reviewed yourself.
- Existing leads already marked "Blocked" migrate automatically the next time the extension reads them - no action needed, nothing lost, same reviewable/reversible behavior as before.
- Updated everywhere: the status enum, the Dashboard's pill color and pie-chart slice, CSV export, the Mentor's prompts and tool descriptions, and the Scanner tile's Negative Topics copy.

---

# SalesTeam — v0.12.1

## New: "Prioritize Unscored Leads" button on the Dashboard

- Automatic prioritization (v0.11.0) only ever scores leads at the moment a scan finishes - it was never meant to, and doesn't, retroactively catch up leads that predate the feature or a scan that ran with no API key configured. If you never noticed the Priority column was empty, this is why.
- New button next to the CSV exports: **"Prioritize Unscored Leads"** - finds every currently-"New" lead across your whole list (not just what's filtered on screen) that doesn't have a priority yet, and scores all of them in one batch, same as the automatic pass. Shows a status message the whole way through ("Prioritizing N leads…", then "Done - N leads scored"), and tells you plainly if there's nothing left to do or if you haven't added an API key yet.

---

# SalesTeam — v0.12.0

## New Settings page + compact button row

- **"AI Settings" moved off the Advisors page onto its own new Settings page** - language, "What We Offer," Anthropic API key, message templates, and value-add offers. Any general (non-lead-specific) settings added later will live here too, rather than getting bolted onto whichever page happens to need them first. Opened via a new blue "Settings ↗" button in the Scanner tile, alongside Dashboard and Advisors. The Advisors page still *uses* these settings (for the Mentor/Customer Voice and drafting) - it just no longer edits them, and now picks up live edits made on the Settings page in another tab instead of needing a reload.
- **All 3 blue buttons (Dashboard, Advisors, Settings) now sit in one row**, shortened ("Open Full Dashboard ↗" → "Dashboard ↗", etc.) and evenly sized to fit.
- **Export/Import resized to match** the new compact button style, but deliberately not stretched to fill the row - there's visible room left for a future backup-related button instead of the two growing to fill the gap.

---

# SalesTeam — v0.11.1

## "Re-apply to existing leads" redone as a checkbox

- Replaced the "Re-apply to existing leads" link (which sat oddly right under "+ Add Negative Topic") with a checkbox at the **top** of the Negative Topics section, below the explanation and above the first filter - with real spacing so it doesn't crowd either.
- Unchecked by default every time you open the side panel. When checked and you click "Scan All Topics", that scan will - after its own searches finish and the usual automatic blocking of newly-found leads happens - also re-check every currently-"New" *existing* lead against your negative topics, in case one you added or edited since then now matches. It's a one-shot choice for that scan, not a saved setting, so it never keeps silently re-running after you forget it's checked.

---

# SalesTeam — v0.11.0

## Automatic lead prioritization + bulk status changes

- **Negative Topics moved to the Scanner tile** (side panel), right below Job Search - now sitting alongside the positive search Topics they're the inverse of, instead of on the separate Advisors page. Same editor, same built-ins, same "Re-apply to existing leads" button - just relocated. Any edits already made carry over automatically.
- **New: automatic Mentor prioritization after every scan.** Once a scan's search results are in and the negative-topic filters have blocked the obvious noise, the Sales Mentor scores every remaining "New" lead from **P1 (highest - drop everything, contact today) to P5 (lowest - unlikely fit, low urgency)** in one batch pass, with a short reason for each. This runs automatically as part of the scan itself (visible as "prioritizing N new leads…" in the side panel's progress text) - no button to click. A lead already scored, or not currently "New" (Blocked/Dismissed/etc.), is never re-scored, so this only ever costs an API call for genuinely new work.
- **New "Priority" column on the Dashboard** - a colored P1-P5 pill (hover for the Mentor's reason), sortable and filterable exactly like every other column. Sort ascending to work top-down from your best leads; unscored leads (not yet run through prioritization, or filtered out as Blocked) show as "—" and sort to the end. Also added to both CSV exports.
- **New "Bulk change filtered leads to…" control** next to the search bar - pick a target status, hit Apply, and every lead matching your *current* filters (search text, status, any column filter - e.g. Priority = P4 or P5) gets changed in one action, not one row at a time. Asks for confirmation first and tells you how many leads it touched. Useful for clearing out a backlog: filter to low priority, bulk-dismiss the lot.
- Fixed a small pre-existing gap: a "Blocked" lead's status pill had no color defined (v0.10.0 added the status but missed its pill styling) - it now shows in red like the pie chart already did.

---

# SalesTeam — v0.10.1

## Lead Filters redesigned as "Negative Topics" - reuses the search Topic concept

- **Replaces the flat blocklist text boxes from v0.10.0** with the exact same card-based editor as your search Topics (name, keywords, optional "AND with" group) - just inverted: a lead matching a negative topic is noise, not a prospect.
- **AND-logic filtering is now possible**, not just a flat keyword list - e.g. a custom topic with keywords "student" AND-with "internship" only blocks a lead mentioning *both*, not either alone.
- **New "Applies to" selector per filter**: Posts + Jobs, Post leads only, or Job listings only - replaces the old hardcoded rule that the recruiter filter never touches job listings. That rule still exists, it's just now how the built-in "Recruiter/Staffing Headline Filter" topic is configured (Post leads only) rather than special-cased in code.
- **The two built-ins carry over unchanged** (same companies, same recruiter phrases) - "Competitor Blocklist" (Posts + Jobs) and "Recruiter/Staffing Headline Filter" (Post leads only). They can't be removed, but every field on them - name, keywords, AND-group, applies-to, even disabling them - is fully editable.
- **Add your own filters** with "+ Add Negative Topic" - e.g. a "Students/Interns" filter, a geography exclusion, anything else that keeps showing up as noise.
- "Re-apply to existing leads" still works the same way - re-checks every currently-"New" lead against the current filters, never touching one you've already acted on.
- If you'd already edited the v0.10.0 blocklists, those edits carry over automatically the first time this loads - no need to re-enter anything.

---

# SalesTeam — v0.10.0

## New: automatic competitor/recruiter blocklist

- **Where**: new "Lead Filters" section on the Advisors page.
- **Competitor blocklist** (company name, one per line) — matched against a job listing's employer, or best-effort against a Post lead's headline. Pre-filled with the list the Sales Mentor itself suggested after reviewing a real scan (BCG Platinion, Deloitte, EY, Zühlke, Eraneos, valantic, Capco, Artefact, Techyon, NVIDIA, Google, AWS, Microsoft, and a few more) - fully editable.
- **Recruiter/staffing headline filter** (Post leads only) — matched against a Post lead's own headline ("Talent Acquisition", "Recruiter", "Recruitment", etc.). Deliberately never applied to Jobs-vertical listings, since a job ad naming a recruiter or HR contact as the point of contact is completely normal there - only an individual recruiter's *own* post is noise.
- A match sets the lead's status to a new **"Blocked"** value automatically at scan time (its own pie-chart/status-filter color, never a silent delete) - reviewable and reversible any time from the Dashboard, exactly like any other status.
- **"Re-apply to existing leads"** button re-checks every currently-"New" lead against the current lists - lets a blocklist edit clean up your existing ~130 leads too, not just future scans. Never touches a lead you've already acted on (Contacted/Dismissed/Responded/Converted) or already reviewed as Blocked.
- The Sales Mentor and Customer Voice's `list_leads` tool now skips Blocked leads by default, so the noise that prompted this (competitors and recruiter posts crowding out real prospects in "rank my leads" style questions) is gone at the source rather than something the Mentor has to explain away every time.

---

# SalesTeam — v0.9.7

## Fixed: a message sent while the agent was still replying could silently vanish

- **Root cause**: pressing Enter to send always fired immediately, even while a previous question to the same chat (Sales Mentor, Customer Voice, or a lead's Consult Mentor) was still being answered - the Send button correctly disables itself while a turn is in progress, but the Enter-key shortcut didn't check that, so a second turn could start concurrently and race with the first one on the same conversation history. Whichever one lost the race could end up dropped rather than answered - consistent with a message only "going through" on the second try.
- Enter now does nothing while a turn is still in progress, matching the disabled Send button, in all three chat surfaces (Advisors page's two agents, and the Dashboard's per-lead Consult Mentor).

---

# SalesTeam — v0.9.6

## Sales Mentor now sees job listings too, not just Post leads

- **Fixed**: on the Advisors page, asking the Sales Mentor to rank/prioritize "all your leads" only ever considered LinkedIn Post leads - Jobs-vertical job listings were silently excluded from `list_leads`/`get_lead_details`, so a question like "rank the top 5 out of my 122 leads" was really only ever ranking a subset (e.g. 25), with no indication of that beyond the Mentor's own footnote.
- A hiring job ad is real buying signal even with no individual scraped to contact yet, so it shouldn't be invisible to the Mentor - it's now included, tagged with `type: "job"` and `hasIndividualContact: false` so the Mentor can tell the two kinds apart.
- The Mentor's instructions now spell out the difference: for a Post lead it can draft an opening message as before; for a job listing (no individual contact scraped) it should instead suggest finding a specific person at that company to reach out to, or flag it as a signal worth tracking.
- This only affects the general Advisors page's Sales Mentor/Customer Voice (the tools that survey *all* leads) - the Dashboard's per-lead "Consult Mentor" panel already handled job vs. post leads correctly since it's scoped to one known lead at a time.

---

# SalesTeam — v0.9.5

## Fixed: Advisors chat could hang indefinitely with no error

- **Root cause**: a stalled connection to Anthropic's API had no timeout at all, so if the response never came back, the chat just sat on "Checking: list_leads" (or "Thinking…") forever with nothing in the console — exactly what was reported after asking the Sales Mentor to rank the leads and pick the top 5.
- **Bounded timeouts added**: the agent conversation call now gives up after 2.5 minutes, tool execution (reading your leads, drafting a message) after 50 seconds, and message drafting after 45 seconds — each with a clear, readable error instead of an endless spinner.
- **Progress is now visible while it's working**: "Thinking…" and "Using tool: …" now tick up a live seconds counter ("Thinking… (14s)…") instead of sitting static, so a real, longer analysis (like reasoning over 100+ leads) reads as "still working" rather than "frozen" — the two looked identical before, which is exactly what made the original hang impossible to tell apart from normal-but-slow. 2.5 minutes is intentionally generous for a "look at everything and rank it" style question; a truly stalled connection will still fail cleanly well before then.

---

# SalesTeam — v0.9.4

## Lead-activity tracking

- **New "Last Activity" column** — shows when a lead's status was last changed by hand, or when it was first found if it's never been touched. Sort it ascending to surface the leads that have gone the longest without any action.
- **Status auto-advances New → Contacted** when you copy a drafted message for that lead (the clearest signal available that you're about to reach out — we can't see LinkedIn's own send button). Only fires from "New" specifically, so it never overwrites Dismissed/Responded/Converted, or a lead you'd already marked Contacted yourself.

---

# SalesTeam — v0.9.3

- **Default page size is now 20** (was 50).
- **CSV export split into two buttons**: "Export All (CSV)" and "Export Filtered (CSV)" — the latter exports exactly what your current search/column filters/status filter are showing (across all pages, not just the one you're looking at), with a distinct filename (`salesteam-leads-filtered-...` vs `salesteam-leads-all-...`) so the two don't get mixed up in your Downloads folder. Both now also include the Post Date and First Scanned columns to match the table.

---

# SalesTeam — v0.9.2

## Found and fixed the column-menu bug

- **The column ▾ menu should actually work now.** Root cause: the popup was a child of its column's header cell, positioned absolutely - but that header cell lives inside the table, which lives inside a horizontally-scrolling container. That nesting can silently clip an absolutely-positioned popup in some browsers/zoom levels even though it's technically still in the DOM (no error, nothing visibly wrong, it just never appears) - consistent with what was reported (no console error, every column affected). Rewritten to render the popup as a direct child of the page itself, positioned using the button's real on-screen coordinates - verified working end-to-end (open, sort, filter, apply, close) with real clicks, not just script-triggered ones.
- The sort-direction arrow on the active sort column is now visually distinct (smaller, gray) from the ▾ menu icon, so they're not mistaken for two dropdown buttons on the same column.
- "Show N per page" options changed to 20 / 50 / 100 / All.

---

# SalesTeam — v0.9.1

## Pagination + another pass on the column menu

- **Pagination.** A "Show: 50/100/250/500/All per page" selector plus First/Prev/Next/Last controls under the table - needed once you're past a handful of leads. Any change to search/filter/sort takes you back to page 1.
- **Column ▾ menu made much easier to hit** - it now spans the header's full height (not just a small 22×22 square), so there's a lot more room for a real click to land on it. If it's still unresponsive after this, that points to something environment-specific (e.g. the browser not having picked up the new CSS) rather than a hitbox problem - worth a full reload (not just "refresh") if so.

---

# SalesTeam — v0.9.0

## Dashboard fixes and new columns

- **Fixed: column header click-to-sort didn't work.** Rebuilding the header row for the Excel-style menus accidentally dropped the "click the header text to sort" behavior entirely. Clicking a column title now toggles ascending/descending again, same as before.
- **Fixed: the column ▾ menu was very hard to click.** Its hit target was only ~12×16px. Enlarged to a proper 22×22px button.
- **Content column now shows up to 3 lines by default**, click to expand the row to full content, click again to collapse — instead of a flat 80-character cut.
- **Pie charts now bucket by real post date, not scan date.** Previously "last 7 days / 30 days / all time" used when the scanner *discovered* a lead, which clusters together if you scan in bursts — so all three charts could show identical numbers. They now use an estimated real post date, parsed from LinkedIn's own relative text ("2h", "3 days ago") at scrape time. Existing leads are backfilled automatically.
- **The "NEW" badge is back**, now on the Dashboard too (previously only in the side panel, and only during that session). It means "first appeared in your most recent scan" — a new "Post Date" column shows the estimated real post date, and a new "First Scanned" column shows when your scanner found it, so you can filter/sort by either independently of lead status.
- "Open Advisors" button is now blue, matching "Open Full Dashboard" — the two navigation buttons are now visually distinct from the smaller gray Export/Import utility buttons.

---

# SalesTeam — v0.8.0

## Dashboard improvements + a new Advisors page

**Dashboard:**
- **Fixed column sorting.** Clicking "Source" (or several other columns) could only ever apply one sort direction — it never actually toggled. Every column now supports real ascending/descending sorting.
- **Excel-style per-column menus.** Each column header has a ▾ menu: Sort Ascending, Sort Descending, and a Filter box. An active filter shows a small dot on the header; the result count shows "(filtered)" when anything is narrowing the list. The old single global "Sort by" dropdown is gone — column headers now do that job, the way a spreadsheet does.
- **Resizable columns.** Drag the edge of any column header; widths are remembered (per browser, via localStorage) across reloads.
- **The per-lead Sales Mentor conversation now persists.** Previously reset every time you left and came back to a lead. Now saved on the lead itself, with a "Clear conversation" button. (Draft Message was already persisting correctly — no change needed there.)

**New: the Advisors page** (`Open Advisors ↗` button in the side panel) — the generic, cross-lead counterpart to the Dashboard's per-lead pages:
- A persistent **Sales Mentor** conversation for cross-lead strategy questions ("which lead should I prioritize this week?").
- **Customer Voice** for general buyer-persona pressure-testing.
- **AI Settings**: your Anthropic API key, "What We Offer," message templates, and language — all moved here from the side panel, since they're used by both the Dashboard and this page, not just scanning.

**Side panel, pared down:** now just Topics, Scan, and a read-only Results list — the per-lead Draft Message section and the Sales Mentor/Customer Voice/Templates sections moved out (see above). Each result card now has an "Open in Dashboard →" link that jumps straight to that lead's detail page.

---

# SalesTeam — v0.7.0

## New: the Leads Dashboard

- **A full Dashboard, in its own browser tab.** New "Open Full Dashboard ↗" button at the top of the side panel opens it. Nothing about the side panel changes — this is a second, complementary view over the same leads.
- **Pipeline stats at the top** — three pie charts (last 7 days, last 30 days, all time) showing your leads broken down by status. Click a slice (or its legend) to filter the table below by that status instantly.
- **Every lead has a status now**: New, Contacted, Dismissed, Responded, or Converted. Every lead scraped before this version is automatically backfilled to "New" the first time it's read — nothing to do manually.
- **A big, sortable, searchable table** of every lead — date found, source (Post / In-Post Job Ad / Job Listing), title, a click-to-expand content preview, the creator (linked to their profile or the job posting), connection level, and status. Sort by clicking any column header or via the "Sort by" dropdown; free-text search filters across title, content, and creator.
- **Per-row quick actions**: Open/Edit (full detail page), Consult Mentor, Send Message, and one-click Dismiss.
- **A full lead-detail page** — every field, a status dropdown, a Draft Message panel (same drafting logic as the side panel), and a Sales Mentor conversation scoped to that one specific lead.
- Under the hood: the Sales Mentor/Customer Voice AI engine (the tool-use loop, lead-lookup tools, and drafting logic) was extracted into a new shared `agent-shared.js` module so the Dashboard and the side panel run the exact same code, not two copies that could drift apart. The side panel's own behavior is unchanged.

---

# SalesTeam — v0.6.5

## New since v0.6.4

- **Scan-complete message now shows how many leads are new.** Previously just "Scan complete — 41 total leads." Now also breaks out how many of those are new since your last scan, e.g. "Scan complete — 41 total leads (7 new)." ("New" means: not already in your saved Results before this scan started — the same definition behind each lead's NEW badge.)

---

# SalesTeam — v0.6.4

## Fixes since v0.6.3

- **Fixed a second, separate cause of a scan hanging with no error.** `navigateAndWait()` (waiting for each search page to finish loading) had no timeout — on a network/machine where a page occasionally never fires "complete" (a proxy, a corporate security interstitial, a managed/throttled network), it would hang forever with nothing ever thrown, meaning even v0.6.2's new error handling couldn't catch or report it. Added a 20-second timeout that proceeds anyway, matching the timeout pattern already used elsewhere (waiting for the content script's scrape result).

---

# SalesTeam — v0.6.3

## New since v0.6.2

- **Automatic settings backup before every scan.** Clicking "Scan All Topics" now silently downloads a full settings backup first (Topics, templates, personas, everything except your API key), landing in Downloads with an "salesteam-auto-backup-..." filename. This protects against things a storage-level save can't - like accidentally reloading the unpacked extension from a different folder, which Chrome treats as a brand-new extension with empty storage. (Your settings were already saving immediately on every edit - this doesn't change that; it adds a real file outside the extension entirely as a second line of defense.)

---

# SalesTeam — v0.6.2

## Fixes since v0.6.1

- **Fixed a scan that could silently freeze partway through with no way to recover.** `scanAllTopics()` had no error handling at all — any failure (a closed tab, a transient extension API hiccup, or Chrome terminating the background service worker mid-run, a known Manifest V3 risk for long tasks) killed the scan with zero feedback: no error message, the Scan button stuck disabled forever, and every lead found in that run lost, since results were only saved once at the very end.
- Now: errors show a real message and re-enable the Scan button so you can just retry; results save progressively after every topic (not only at the end), so a later failure only loses the *rest* of the scan, not what was already found; and a lightweight keep-alive touch during each delay reduces the chance of the underlying service-worker termination happening at all.

---

# SalesTeam — v0.6.1

## New since v0.6.0

- **Live "N searches for this topic" counter** on every Topic and Job Topic card, updating as you type. Uses the exact same chunking math as the real scan (including the multiplicative concept×AND-group effect that made one topic alone responsible for over half of a recent 41-search scan), so you see the real cost while editing instead of needing a manual audit. Turns orange at 6+ searches to flag topics worth reconsidering.

---

# SalesTeam — v0.6.0

## New since v0.5.1

- **Message language setting** (English / German) for AI drafting and the Sales Mentor — useful for the Swiss market, where most Posts/Jobs content is in Standard German rather than English.
- **Customer Voice now mirrors a lead's actual language** when grounded in one specific real lead, regardless of the language setting — more authentic than a fixed toggle for something roleplaying a real person. Falls back to the language setting for general questions with no specific lead.
- Reminder: Topics' keyword lists already accepted any language before this release — German search terms can simply be typed into the existing keyword boxes alongside English ones.

---

# SalesTeam — v0.5.1

## New since v0.5.0

- **Optional API key sharing in Export Settings.** A new checkbox ("Include Anthropic API key in this export") lets you deliberately bundle your key into a settings export — for sharing one spend-capped trial key across a small team before they set up their own. Off by default, with a confirmation prompt when turned on, since it's a real secret once included.
- Extension renamed from LinkedIn Lead Scanner to **SalesTeam** throughout (manifest, side panel title, icons — now a magnifying glass with "ST" lettering).

---

# LinkedIn Lead Scanner — v0.5.0

## New since v0.4.1

- **Mentor persona setting** (in the Sales Mentor section) — describes the Mentor's background/style (e.g. years of experience, industry focus, tone). Pre-filled with a sensible default; edit it to match how you actually want advice delivered.
- **Target customer persona setting** (in the Customer Voice section) — describes who your ideal buyer actually is (company type, role, seniority). Used only for general questions with no specific lead named; a named real lead's actual data always takes priority over this generic persona.
- Both are included in Export/Import Settings, so they can be shared to a second installation the same way Topics and templates already are.

---

# LinkedIn Lead Scanner — v0.4.1

## Fixes since v0.4.0

- **Connection-degree detection now actually works.** The scraper was checking a `data-view-name="null"` attribute that's present (as that literal string) on nearly every element in LinkedIn's DOM, so it always matched the wrong node and came back empty. Fixed to walk up to the first ancestor with real text, confirmed against live posts (1st/2nd/3rd correctly detected).
- **New "What We Offer" setting**, shared by AI drafting, the Sales Mentor, and Customer Voice. Previously all three reasoned only from a lead's own post, with zero idea what your company actually sells — meaning advice and drafts couldn't reason about real fit, only surface relevance. Add a description once in AI Message Drafting settings and all three features pick it up immediately.
- **Longer agent replies.** Sales Mentor and Customer Voice were capped at 1024 tokens, cutting off detailed strategic answers mid-sentence. Raised to 2048.

---

# LinkedIn Lead Scanner — v0.4.0

## New since v0.3.0

**An "AI board of advisors" — two agents built on shared infrastructure**
- The former "Sales Advisor" is now the **Sales Mentor**: a 25-years-experience, always-available persona. Answers general strategy questions directly from its own expertise, and only reaches for the `list_leads`/`get_lead_details` tools when a question is actually about specific leads — the same agent handles both without you needing to pick a mode.
- New **Customer Voice** agent: roleplays as a realistic B2B buyer so you can bounce a message or approach off it before sending. Name a specific lead and it grounds itself in their real scraped post (via the same tools, read-only); ask a general question and it answers as a typical buyer in this space instead.
- Both agents are built from one reusable chat engine (same tool-use loop, different persona/system prompt/tool access) — a genuine multi-agent architecture sharing infrastructure, not three separate one-off builds.

---

# LinkedIn Lead Scanner — v0.3.0

## New since v0.2.0

**Sales Advisor (a real AI agent, not just generative text)**
- A chat panel where you can ask things like "Which lead should I approach first?" or "How should I approach Gabel?"
- Unlike the message drafter (a single fixed prompt), this gives Claude tools it decides on its own whether to use: `list_leads` (survey what's available), `get_lead_details` (dig into one lead), and `draft_message` (generate a draft as part of its answer) — genuine multi-step tool-calling, the core mechanic of agentic AI.
- Uses a stronger model (Sonnet) than the drafting feature, since giving real prioritization/approach advice is a reasoning task, not a quick templated draft.
- All three tools only read/generate local data already in your Results list — none of them touch LinkedIn or send anything.
- Conversation persists across closing/reopening the side panel; "Clear Conversation" resets it.

---

# LinkedIn Lead Scanner — v0.2.0

## New since v0.1.0

**AI-drafted opening messages (Post leads only)**
- "Draft Message" button on each Post lead generates a short, personalized LinkedIn message via Claude, using that lead's matched post content, headline, and topic — never auto-sent, always shown as editable text with a Copy button, so you review and send it yourself inside LinkedIn.
- Three editable templates (auto-picked per lead, or choose manually): already connected (1st-degree), not yet connected, and hiring/job-ad leads — each with its own tone.
- An optional "things you can offer" list (a real article, report, or demo offer) the AI may reference — it's instructed to never invent one that isn't on your list.
- Requires your own Anthropic API key, entered under "AI Message Drafting" in settings (stored locally only, and excluded from Export/Import Settings so each installation uses its own key).
- Best-effort detection of LinkedIn's 1st/2nd/3rd-degree connection badge to pick the right template tone — not yet live-verified against LinkedIn's current DOM, so it may need the same kind of selector tuning as other scraping in this extension.

---

# LinkedIn Lead Scanner — v0.1.0 (First Alpha)

A Chrome extension that manually scans LinkedIn for people and companies talking about — or hiring for — topics you care about, so you can find and reach out to real leads instead of scrolling your feed.

## What it does

**Topics**
- Define named topics as keyword lists (e.g. "AI Transformation": AI, Artificial Intelligence, Machine Learning...).
- Each topic can optionally have a second "AND with" group, so a post must mention something from *both* groups (e.g. an AI term AND a project/development term).
- Enable/disable individual topics without deleting them or losing their keywords.
- No need to keep keyword lists short — LinkedIn silently breaks on overly long/complex searches, so the extension automatically splits a topic into multiple smaller searches behind the scenes and merges the results back into one list.

**One-click scanning**
- "Scan All Topics" runs every enabled topic as its own search, then merges everything into a single list, ranked by relevance (posts/jobs matching more topics rank higher, then by how well-matched and how recent).
- Fully manual — nothing runs automatically or on a schedule, so there's no risk to your LinkedIn account from unattended automation.

**Posts Search filters**
- "Posted within" timeframe (any time / 24h / week / month).
- "Author title contains" — narrow to specific job titles (CTO, Director, VP, etc.), checked against each author's visible headline.
- Include/exclude posts that have an embedded job ad.

**Job Search (LinkedIn's separate Jobs section)**
- Toggle on to also search LinkedIn Jobs listings, not just Posts.
- Job-specific topics (e.g. "AI Engineer" OR "ML Engineer") — additive with your Post topics, not a replacement.
- Location filter (Switzerland, Zurich Metropolitan Area, and you can add more locations yourself).
- Its own independent "Date posted" filter, since job ads go stale much faster than posts.

**Lead types, clearly labeled**
- **Post** — someone's personal post matching a topic.
- **In-Post Job Ad** — a post with LinkedIn's job-listing widget attached.
- **Job Listing** — a result from LinkedIn's dedicated Jobs section.
- **Hiring** / **Freelance/Contract** badges — flags plain-text posts that use hiring or freelance-outsourcing language, even without a formal job widget.
- **NEW** badge — marks leads found for the first time since your last scan.

**Every result shows**
- Which topic(s) and which specific keyword(s) actually matched.
- Author/company, headline, snippet or job details, and a direct link to the profile, post, or job.

**Managing your data**
- **Export Leads (CSV)** — download all leads for Excel/Sheets/CRM.
- **Export/Import Settings** — back up or transfer your topics, filters, and lead history as a JSON file (e.g. to set up a second person with your tuned topics).
- **Clear Results** — wipe accumulated leads and start fresh.

## Known limitations (alpha)

- Location/author-title filtering for Posts is approximate — it checks the visible headline/post text, not LinkedIn's full profile data.
- No exact post permalink for most posts (LinkedIn doesn't expose one without extra clicks) — you get a link to the author's profile and the visible snippet instead.
- LinkedIn's search-complexity limits (and the Jobs vertical's virtualized list requiring a visible tab) were reverse-engineered through live testing — they could shift if LinkedIn changes its site.
- Currently assumes an English-language LinkedIn UI.
