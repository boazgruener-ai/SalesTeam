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
