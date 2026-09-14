# -*- coding: utf-8 -*-
import re
import zipfile
import shutil
import docx
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

SALESTEAM_DIR = "C:/Users/41793/OneDrive/Documents/Personal/Claude Code/SalesTeam"


def fix_zoom(path):
    """python-docx's blank template omits <w:zoom>, which some strict OOXML
    validators (and occasionally Word itself) flag. Patch it in post-save."""
    tmp = path + ".tmp"
    shutil.copy(path, tmp)
    with zipfile.ZipFile(tmp, "r") as zin:
        names = zin.namelist()
        settings = zin.read("word/settings.xml").decode("utf-8")
        if "<w:zoom" not in settings:
            settings = settings.replace(
                "<w:settings",
                '<w:settings',
                1,
            )
            # Insert a zoom element right after the opening <w:settings ...> tag.
            m = re.search(r"(<w:settings[^>]*>)", settings)
            if m:
                settings = settings[:m.end()] + '<w:zoom w:percent="100"/>' + settings[m.end():]
        data = {}
        for n in names:
            data[n] = zin.read(n)
        data["word/settings.xml"] = settings.encode("utf-8")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            zout.writestr(n, data[n])
    import os
    os.remove(tmp)


def add_bullets(doc, items):
    for item in items:
        if isinstance(item, tuple):
            p = doc.add_paragraph(style="List Bullet")
            r = p.add_run(item[0])
            r.bold = True
            p.add_run(item[1])
        else:
            doc.add_paragraph(item, style="List Bullet")


def add_para_with_bold_lead(doc, lead, rest, style=None):
    p = doc.add_paragraph(style=style)
    r = p.add_run(lead)
    r.bold = True
    p.add_run(rest)
    return p


# =====================================================================
# PRD.docx
# =====================================================================
doc = docx.Document()

doc.add_heading("SalesTeam — Product Requirements Document", level=1)

p = doc.add_paragraph()
r = p.add_run("Status: "); r.bold = True
p.add_run("Living document, reflects the shipped product as of v0.30.0.")
p = doc.add_paragraph()
r = p.add_run("Note: "); r.bold = True
p.add_run(
    "No PRD file existed for this project before this document — it was assembled now from the full build "
    "history to serve as the canonical, up-to-date spec going forward. Update it alongside future features "
    "rather than letting it drift from RELEASE_NOTES.md."
)

doc.add_heading("1. Problem", level=2)
doc.add_paragraph(
    "A B2B software/AI-services salesperson finds new leads by manually searching LinkedIn Posts and Jobs "
    "for relevant activity (hiring signals, AI-adoption posts, etc.), then has to separately figure out who's "
    "worth approaching, draft an opening message, and keep track of who they've already contacted — all by "
    "hand, with no tooling built for this specific workflow. Existing CRM/sales-intelligence tools assume "
    "leads already exist in a system; they don't help find them on LinkedIn in the first place."
)

doc.add_heading("2. Goals", level=2)
add_bullets(doc, [
    "Turn a repeatable LinkedIn search into a one-click, multi-topic scan across both Posts and Jobs.",
    "Surface only real, addressable signal — automatically filter out competitors and recruiter/staffing "
    "noise that matches the same keywords but is never a prospect.",
    "Prioritize the result automatically, so the salesperson always knows what to work on first without "
    "having to ask an AI mentor the same question after every scan.",
    "Give the salesperson an AI team on top of the data: a mentor for strategy, a simulated buyer to "
    "pressure-test messages against, and reviewed (never auto-sent) drafting.",
    "Do all of this safely: manual-trigger only (no scheduled/background automation), nothing sent without "
    "explicit review, and destructive actions (bulk status changes) require deliberate friction.",
])

doc.add_heading("3. Non-goals", level=2)
add_bullets(doc, [
    "Not a full CRM. No pipeline stages beyond a simple status label, no deal value/forecasting, no team "
    "features (single-user, local-only storage).",
    "Never sends a message on the user's behalf. Drafts are generated for copy-paste only.",
    "No scheduled or background scanning. Every scan is a manual click, by design — this keeps the tool's "
    "behavior indistinguishable from a careful human user, not an automation bot, for LinkedIn ToS reasons.",
    "Not a general LinkedIn scraper — scoped to the Posts and Jobs search-results pages the user is already "
    "viewing, using their own authenticated session.",
])

doc.add_heading("4. User", level=2)
doc.add_paragraph(
    "Grounded in a real B2B sales role in Swiss enterprise software/AI consulting: manually searching "
    "LinkedIn for hiring/AI-adoption signals, contacting people who match, and needing a lightweight way to "
    "track who's been approached without adopting a heavyweight CRM for a one-person prospecting workflow."
)

doc.add_heading("5. Architecture", level=2)
p = doc.add_paragraph()
r = p.add_run("Project layout (v0.27.0): "); r.bold = True
p.add_run(
    "the repo root holds only living project documentation (this PRD, RELEASE_NOTES.md, README.md) and "
    "unrelated assets (pitch deck, screenshots) - everything else is organized into subfolders:"
)
add_bullets(doc, [
    ("/code — ", "the actual loadable extension (manifest.json + every .js/.html/.css file + icons/) plus "
     "the Python doc-generation scripts. Chrome's unpacked-extension loading requires manifest.json and "
     "everything it references to live together in one folder (no ../ escapes allowed), so this is the "
     "folder Chrome's “Load unpacked” points at."),
    ("/backup — ", "Settings/Leads export downloads (manual and automatic pre-scan) land here."),
    ("/exports — ", "CSV export downloads land here, plus target-accounts.json (see 6.11), generated by "
     "code/convert_target_accounts.py."),
    ("/log — ", "periodic Activity Log file exports land here (see 6.10)."),
    ("/builds — ", "every shipped release's zip is archived under its own builds/vX.Y.Z/ folder, alongside "
     "a copy of that exact version's manifest.json."),
])
doc.add_paragraph(
    "Chrome/Edge Manifest V3 extension, no server of its own. Four pages share one chrome.storage.local "
    "dataset:"
)
table = doc.add_table(rows=1, cols=2)
table.style = "Light Grid Accent 1"
hdr = table.rows[0].cells
hdr[0].text = "Page"
hdr[1].text = "Purpose"
rows_data = [
    ("Scanner (side panel)", "Topics (positive search keywords) + Negative Topics (auto-filters), Job "
     "Search config, the scan trigger, and the raw results list."),
    ("Dashboard (tab)", "The pipeline view — pie charts, a sortable/filterable/paginated lead table, "
     "per-lead detail page, bulk actions."),
    ("Advisors (tab)", "Cross-lead Sales Mentor and Customer Voice agent chats, for strategy questions not "
     "tied to one specific lead."),
    ("Settings (tab)", "Company context, Anthropic API key, message templates, output language, value-add "
     "offers — anything general-purpose, non-lead-specific. Home for any future general settings too."),
]
for name, purpose in rows_data:
    row = table.add_row().cells
    row[0].text = name
    row[1].text = purpose

doc.add_paragraph()
doc.add_paragraph(
    "background.js (service worker) orchestrates scans: sequentially runs each topic's search in one "
    "background tab, merges results, applies negative-topic filtering, optionally re-applies filters to "
    "existing leads, then runs the automatic prioritization pass — before ever reporting the scan complete."
)
doc.add_paragraph(
    "agent-shared.js is the shared AI engine (system prompts, tool definitions, the Anthropic fetch/tool-use "
    "loop) used identically by the Scanner-era code, Dashboard, and Advisors — one implementation, not a "
    "drifting copy per page."
)

doc.add_heading("6. Feature spec", level=2)

doc.add_heading("6.1 Topics (Scanner)", level=3)
add_bullets(doc, [
    "Named keyword groups, with an optional second \u201cAND with\u201d group (post must match one keyword "
    "from each group). Same shape reused for both Post topics and Job-specific topics.",
    "LinkedIn's own search-complexity limits are worked around automatically via query chunking (max 6 "
    "OR-terms per group) - the user can add however many keywords they want, and the "
    "cost is made visible rather than hidden: each topic shows its own live “N searches for this "
    "topic” hint, and a grand total across every enabled Post and Job topic (“Total: 10 "
    "searches this scan will run”) sits above the “Scan All "
    "Topics” button, turning orange past 30.",
    "AND-topics search additively, not multiplicatively (v0.25.0) - found necessary once a user's own topic "
    "redesign (a large bilingual AND-topic chasing a previously-empty topic) pushed one real scan to 68 "
    "sub-queries. Rather than combining a topic's two keyword groups into one LinkedIn query per pairing "
    "(which required a full cartesian product of concept-chunks x activity-chunks to cover every "
    "combination), the two groups now run as two independent, cheap LinkedIn searches (each a plain OR "
    "list), and the AND is applied client-side by intersecting the two raw result sets on the post's "
    "profileUrl (not its own key, which is usually snippet-derived and, confirmed live in v0.25.0, unstable "
    "for the same post across two independent searches - fixed in v0.25.1) - same logical AND "
    "(concept-AND-activity is still required to count as a match), additive cost "
    "instead of multiplicative (a 30x30 topic dropped from 48 sub-queries to 10). Completely invisible in "
    "the Topics UI - same keywords + andKeywords shape, same editing experience. To offset the fact that "
    "each phase now searches a broader, single-constraint corpus (versus LinkedIn doing the full "
    "intersection server-side before), these two phases scrape twice as deep (more scroll passes, not more "
    "LinkedIn requests) so a genuine double-match has a better chance of surviving the client-side join.",
    "Author-title filter (checked client-side against each post's visible headline, never sent to LinkedIn) "
    "and an \u201cinclude in-post job ads\u201d toggle.",
    "\u201cSuggest Lookalike Topics\u201d button - looks at the salesperson's own highest-priority (P1-P3) "
    "Post leads and asks the Sales Mentor what made them strong matches, then suggests new keywords for "
    "finding more like them. Post leads only, deliberately: Job leads carry no scraped body text (only "
    "title/company/location), so there's nothing to generalize from beyond the title itself, and this only "
    "ever writes into Post Topics anyway. Review-first like everything else here: each suggestion shows its "
    "reasoning and lets the user add it to an existing Topic, create a new one, or skip it - nothing is "
    "written until explicitly accepted.",
    "“Analyze Post Search Quality” button (Search Quality section, after Negative Topics) - the "
    "actual fix for the problem Lookalike Topics can't help with (it only has good examples once Posts "
    "already score well). Looks at every unactioned Post lead - “New” and “Irrelevant” "
    "- plus the current Topics and Negative Topics together, diagnoses what's likely limiting quality/volume, "
    "and proposes specific keyword changes across both - additions, removals, or a genuinely new "
    "Topic/Negative Topic. Including Irrelevant leads is deliberate: an over-aggressive Negative Topic "
    "keyword is invisible otherwise, and stats include an irrelevantByNegativeTopic breakdown plus each "
    "Irrelevant example's exact irrelevantReason, so a false positive (a generic platform mention, an "
    "in-house HR poster) is directly visible rather than assumed correct. Grounded in the configured company "
    "context so it can propose genuinely new keywords, not just react to mediocre examples - explicitly told "
    "that a Negative Topic can only ever reduce volume, never fix a shortage of good leads. Same "
    "review-first pattern: each suggestion can be redirected to a different existing topic or accepted as "
    "new, and a removal referencing a keyword that's already gone is filtered out rather than shown as a "
    "broken action. Still excludes Dismissed/Contacted/Responded/Converted - those are the salesperson's "
    "own decisions, not the system's.",
])

doc.add_heading("6.2 Negative Topics (Lead Filters)", level=3)
add_bullets(doc, [
    "Same shape and matching logic as a positive Topic (keywords OR-group, optional AND-with group), but "
    "checked client-side against an already-scraped lead's own text after the search comes back — never "
    "sent to LinkedIn as a query, and never removes a search result, only marks it.",
    "Each topic has an appliesTo scope: Post leads only, Job listings only, or both — because a signal "
    "that's noise on one vertical (a recruiter's own post) is completely normal on the other (a job ad "
    "naming an HR contact).",
    "Checked against a Post lead's snippet + headline + company (Job leads: title + company) - including "
    "company (v0.23.0) matters because it lets a negative topic target who the poster actually works for, a "
    "much more precise signal than a keyword that can also match a mere passing mention in the post body.",
    "Four built-in topics, seeded by the Sales Mentor's own review of a real scan, cannot be removed but "
    "every field (keywords, AND-group, scope, match field, enabled) is fully editable: Competitor Blocklist "
    "(applies to both - named competing consulting/services firms, deliberately excluding generic cloud/AI "
    "platform vendors like Microsoft/Google/AWS/NVIDIA, which get mentioned constantly as mere tooling "
    "references), Recruiter/Staffing Headline Filter (Post leads only - can false-positive on an in-house "
    "HR/Talent-Acquisition person posting their own employer's real opening), Known Recruiting Firms "
    "(applies to both, v0.23.0 - a curated list of known Swiss recruiting/staffing agencies matched against "
    "company only, a more reliable alternative to guessing from headline text), and AI/Cloud Vendor "
    "Blocklist (applies to both, v0.29.10 - Google, Microsoft, Amazon/AWS, NVIDIA, IBM, Oracle, SAP, "
    "Salesforce, Meta, OpenAI; matched against company only for the same reason Competitor Blocklist "
    "excludes them - a free-text mention of these vendors as tooling is noise, but a lead who actually works "
    "at one of them isn't this project's ICP).",
    "Match field (v0.29.10): each Negative Topic is either “Company + text” (default - checks the "
    "usual snippet/headline/company haystack) or “Company name only” (checks solely the lead's own "
    "company field, never post/job text) - the setting that makes the AI/Cloud Vendor Blocklist and Known "
    "Recruiting Firms safe against free-text false positives. Fixed a latent bug found while adding this: "
    "Known Recruiting Firms was documented as company-only but nothing enforced it before v0.29.10.",
    "Fuzzy company matching (v0.29.10): reported directly - a configured keyword without a legal-entity "
    "suffix (AG/GmbH/Ltd/Inc/LLC/...), a corporate-structure word (Group/Holding/International), or a "
    "regional suffix (Switzerland/Schweiz/Suisse) should still match a lead's company that has one, or vice "
    "versa (“Zühlke” vs “Zühlke Engineering AG”, “Randstad” vs "
    "“Randstad Switzerland”). Both the configured keyword and the lead's company are compared "
    "with these noise words stripped from both sides, bidirectionally. Additive to every topic's existing "
    "free-text matching, not a replacement, and confined to comparisons against company - never applied to "
    "free-text keyword matching itself.",
    "The user can add unlimited custom negative topics for any other recurring noise. New built-in defaults "
    "only apply to fresh installs - an existing configuration is the user's own live data and isn't touched "
    "automatically when a default changes (v0.29.10's AI/Cloud Vendor Blocklist and the Known Recruiting "
    "Firms match-field fix both follow this rule).",
    "A match sets the lead's status to Irrelevant and records both the topic and the specific keyword that "
    "matched (irrelevantReason), shown as a hover tooltip on the Dashboard's status pill — distinct from "
    "Dismissed, which is always the salesperson's own decision, never the system's.",
    "\u201cAlso re-apply these filters to existing leads on the next scan\u201d checkbox (Scanner tile, "
    "unchecked by default, not a saved setting) — when checked, the next scan also re-checks every "
    "currently-\u201cNew\u201d existing lead against the current negative topics. Never touches a lead "
    "already acted on.",
    "\u201cApply Negative Filters\u201d button (Scanner tile, next to the Negative Topics list) \u2014 "
    "re-checks every existing lead against whatever's currently configured, instantly, with no new scan "
    "needed. Fully bidirectional: a \u201cNew\u201d lead that now matches becomes Irrelevant, and an "
    "\u201cIrrelevant\u201d lead that no longer matches (because a keyword was edited or removed) reverts "
    "to \u201cNew\u201d \u2014 the on-next-scan checkbox above only ever caught the first direction. Reports "
    "exactly how many leads moved each way. Never touches a lead already acted on.",
    "A lead already marked Irrelevant, or missing a reason (predates this feature), gets its reason "
    "backfilled automatically, best-effort, the next time it's read.",
])

doc.add_heading("6.3 Lead data model & statuses", level=3)
doc.add_paragraph(
    "Every lead (Post or Job listing) carries: status, statusUpdatedAt, priority + priorityReason + "
    "priorityScoredAt, irrelevantReason (if applicable), company + companyExtractedAt (if applicable), plus "
    "source-specific fields (author/headline/snippet for Posts; title/company/location for Jobs), "
    "firstSeenAt/lastSeenAt/postedAt, and matchedTopics."
)
doc.add_paragraph(
    "Statuses: New (default) \u2192 Contacted (manual, or automatic the moment a drafted message is copied) "
    "\u2192 Responded / Converted (manual) or Dismissed (manual) or Irrelevant (automatic, negative-topic "
    "match)."
)
p = doc.add_paragraph()
r = p.add_run("Company. "); r.bold = True
p.add_run(
    "Job leads get a clean company field straight from the scrape; Post leads never had one before v0.17.0 - "
    "only a free-text headline (e.g. \u201cHead of AI for IT @ Azqore\u201d). After every scan, a batched AI "
    "call extracts a best-guess company for every Post lead still missing one (silently skipped with no API "
    "key, same pattern as prioritization), with a \U0001F3E2 \u201cAssign Company\u201d row action to search "
    "every company already seen (native browser autocomplete) or type a new one, or clear it. A manually-set "
    "or previously-extracted company is never touched again by the automatic pass - companyExtractedAt is "
    "only ever set for an AI guess, cleared on manual assignment, so a scan can never silently overwrite a "
    "human's correction."
)
p = doc.add_paragraph()
r = p.add_run("Location (v0.29.22). "); r.bold = True
p.add_run(
    "Same pattern as Company above, for the same reason: a \U0001F4CD “Assign Location” row action "
    "to manually set or clear a lead's location (locationExtractedAt cleared on manual assignment, same "
    "never-overwrite guarantee), added after real extracted locations came back clearly wrong (see the "
    "Extract Companies & Locations v0.29.22 fix below) with no way to correct them short of editing storage "
    "directly. Clearing or changing it immediately re-applies the Location Filter (6.13)."
)
p = doc.add_paragraph()
r = p.add_run("Extract Companies & Locations from Profiles (v0.29.1, opt-in, Dashboard-only; renamed v0.29.21 - it always extracted both fields, but the button/labels only ever said Companies): "); r.bold = True
p.add_run(
    "the AI extraction above can only find a company that's actually present in the scraped headline text - and a LinkedIn search-results feed only ever shows a poster's own short headline, never their full profile. Confirmed live: a real profile page often shows a structured current employer that the person's headline never mentions at all. Fixing that requires visiting the person's own profile page, a materially bigger LinkedIn scraping footprint than reading a search-results feed - so this is a separate, explicit, manual Dashboard button, never part of the automatic per-scan pipeline. Filters to Post leads still missing a company with a profileUrl; confirms first, naming the real scope; visits one profile at a time in a background tab, paced with a randomized 4-9s delay between visits; reuses the same never-overwrite write path (applyExtractedCompanies) as headline extraction. A new content script (profile-content-script.js) only runs during this explicit action, gated on a profileExtractionActive flag, so ordinary profile browsing is never scraped. Fixed in v0.29.5 after a real 20-profile run returned 0 companies: LinkedIn's current profile page hydrates its Experience section in after the page's load event, so the extractor now polls for up to ~6s for it to appear; also, the company-page link wraps both the job title and company name as one text block, so it now reads the specific line holding the company name and strips the trailing employment-type suffix. The Experience-section lookup itself was also hardened to anchor on the section's own literal 'Experience' heading text rather than an id/class guess. Extended in v0.29.5 to also extract the person's stated location from the same visit (still unverified against a live sample), feeding the new Location Filter (6.13). Fixed in v0.29.6: a real run still crashed after 3 of 55 profiles - the orchestration resolved a bare null on a per-profile timeout, and destructuring null throws, aborting the whole run instead of skipping that one unresponsive profile; the timeout path now resolves an empty company/location pair instead. Fixed in v0.29.8: the confirmation dialog's time estimate only ever counted the pacing delay, not real page-load time (the dominant, most variable cost) - a real 55-profile run took ~15 minutes against an estimate implying 1.5-3; the estimate now folds in a rough typical page-load time too. Fixed in v0.29.9 after a real 55-profile run found a company for only 5: Experience entries are wrapped in a componentkey=\"entity-collection-item-...\" element regardless of whether the employer has a Company Page, but the extractor only ever looked for a link to one - it now reads the entry structurally first, working for both linked and unlinked employers. A profile that still yields nothing now attaches a small diagnostic bundle, surfaced via the Activity Log, so a still-mostly-failing run can be diagnosed without live DevTools access. The orchestration itself also moved into a shared profile-extraction.js module, used by both this button and a new side panel post-scan prompt (same backlog check, its own distinct progress phase, kept separate from the scan's own progress counter). Fixed in v0.29.10: a profile's current employer wasn't read at all when it only appears as the top card's company badge (next to the person's photo) rather than in the Experience section - confirmed live that Experience only renders after scrolling into view, while the badge renders immediately, so the badge is now checked first. Also confirmed this correctly tells a company badge apart from a sibling school/university badge on the same profile, since the two use distinct, badge-specific icon markers rather than a shared one. Fixed in v0.29.11: reported directly after a run showed \"Visiting profile X of 55\" against an expected ~20 (leads missing a company), and the count never shrank even across repeated runs - three real causes. The count always included every lead missing either a company or a location (by design, since the same visit covers both), which the confirmation dialog never made clear. The actual reason the number never went down: only a successful location find ever cleared a lead from the list, so a profile that was genuinely visited but has no findable location text (common, given the extractor's small Switzerland-biased hint-word list) stayed \"missing\" forever and got re-queued on every future run - fixed with a new profileVisitedAt field, set the moment a profile visit gets a real response from the page regardless of whether a location was found, excluding it from leadsMissingProfileData from then on (a hard timeout does NOT set it, so those are still retried). And leads sharing the same profile (e.g. two posts from the same person) were each visited separately even though one visit answers both - runProfileExtraction now groups leads by normalized profile URL, visits each real profile exactly once, and applies that result to every lead sharing it. The confirmation dialog and the \"Visiting profile X of Y\" counter both now show the real number of page visits, noting the covered lead count separately when it's larger. Fixed in v0.29.19: reported directly, a real lead (Jochen Eversmeier) still came back with both fields empty even though his profile's raw HTML was verified byte-for-byte correct against the current, PRIMARY extractors (personLocationFromContactInfoRow/companyNameFromTopCardBadge, v0.29.15) - but the diagnostic bundle above still only checked the OLD Experience-section/company-link signals from before that rewrite, so it couldn't say anything about whether the Contact info link or the company badge were even found. Added the missing signals (contactInfoLinkFound, contactInfoRowText, companyBadgeIconFound, companyBadgeText) so the next failure sample actually reflects the extraction path that's really in use. Fixed in v0.29.20 - the real root cause: the v0.29.19 bundle then showed {timedOut: true} (no message ever received) for three leads sharing a /in/<slug>/en/ locale-path profileUrl variant (scraped from a LinkedIn UI link that uses that format), despite one of them being independently verified to load and extract correctly. Visiting .../en/ redirects to .../?locale=en - a different path, just with the locale moved into a query param - and normalizeProfileUrl() (profile-extraction.js) only ever stripped the query string and one trailing slash, so the stored URL normalized to .../slug/en while the actual page's reported URL normalized to .../slug - never equal. The content script's genuinely correct result was silently rejected by waitForProfileScrapeResult's listener as belonging to a different profile, timing out 15 seconds later with nothing, on every single run regardless of any other fix shipped. Now matches on just the /in/<slug> prefix - the one part guaranteed constant across locale path, query string, or trailing slash - fixing both this matcher and groupByProfile's deduplication (two URL variants for the same person now correctly count as one visit). Also added navCompleted to navigateAndWaitProfile's result, attached to any future hard-timeout debug sample, so a genuinely different cause (navigation itself never finishing) is distinguishable from this one (page loaded fine, result silently discarded). Fixed in v0.29.21, three smaller follow-ups reported directly alongside v0.29.20: (1) the extension's own Errors page (chrome://extensions) showed a persistent Uncaught (in promise) Error: No tab with id: ... separate from the already-handled friendly scan-error message - both navigateAndWait (background.js) and navigateAndWaitProfile (profile-extraction.js) called chrome.tabs.update(tabId, { url }) without awaiting or catching its returned promise, so a tab closed out from under it (a case the surrounding listener/timeout already handles gracefully) still left a genuinely unhandled rejection behind; both now have .catch(() => {}) attached. (2) A lead whose visit hard-timed-out (the page never responded at all) used to read identically in the completion message to one that was visited fine but simply had no findable data - both just counted as not found. runProfileExtraction now also returns hardTimeoutCount, and the Dashboard/side-panel completion message and Activity Log entry both call it out explicitly instead of it only being discoverable later by noticing the count didn't move. (3) The button and every status/log message were renamed from Extract Companies from Profiles to Extract Companies & Locations from Profiles - it always extracted both fields, the name just never said so. (4) A real lead (Roland Markowski), visited after the v0.29.20 fix, came back with a company but still no location - a partial miss the diagnostic bundle never covered, since it only ever attached when BOTH fields came back empty. Widened to fire whenever EITHER field is still missing, and each debug sample now also states which of company/location it actually found. Fixed in v0.29.22, reported directly with several real examples: on a profile with no Location filled in on LinkedIn, personLocationFromContactInfoRow()'s position-only heuristic picked up a website (jobs.sbb.ch), the person's own name, their full headline/tagline, an education institution (“University of Toronto”), or a past job description instead - none of them a location. Added content-based rejection on top of the positional anchor: too long for a real location (>60 chars), contains a headline's “|”/“｜” separator, looks like a bare domain, names an institution (University/Institute/College/etc.), or exactly matches the profile's own name heading. Doesn't retroactively fix already-stored bad values, so a new \U0001F4CD “Assign Location” Dashboard action button (mirroring the existing \U0001F3E2 “Assign Company”) lets one be corrected or cleared by hand, re-applying the Location Filter immediately after (setLeadLocation, storage.js)."
)
p = doc.add_paragraph()
r = p.add_run("Location (Job leads), work-arrangement tag fix (v0.29.11): "); r.bold = True
p.add_run(
    "reported directly - LinkedIn appends a work-arrangement tag (\"(Hybrid)\", \"(Remote)\", \"(On-site)\") right onto or after a job's location text in jobs-content-script.js's scrape, which describes the job's arrangement, not the place (\"Zurich, Switzerland (Hybrid)\" isn't a place called that). Now stripped at the scrape source (stripWorkArrangementTag) so the Location Filter, the Dashboard's Location column, and Sales Mentor location parsing all only ever see the actual place. A location scraped before this fix and still carrying the tag is cleaned up automatically, best-effort, the next time getResults() reads it."
)
p = doc.add_paragraph()
r = p.add_run("Location, German/French/ISO-code fix (v0.29.12): "); r.bold = True
p.add_run(
    "reported directly - leads at obviously-Swiss companies (SBB, Syngenta, IMD Business School) still came back with no location. Root cause: both the location heuristic here and the Location Filter's classifier (6.13) only ever recognized English names - \"Zurich,\" \"Geneva,\" \"Lucerne,\" \"Switzerland\" - and a Swiss profile just as often shows the German/French spelling instead: \"Zürich,\" \"Genève\"/\"Genf\" (for Geneva), \"Luzern\" (for Lucerne), \"Schweiz\"/\"Suisse\" (for Switzerland), or the bare ISO code \"CH\" - none of which ever matched. Both LOCATION_HINT_WORDS (profile-content-script.js) and SWISS_CITIES/COUNTRY_ALIASES (classifyLocation, storage.js) now recognize these German/French spellings and \"CH,\" kept in sync. Adding \"CH\" required upgrading this heuristic's own matching from a plain substring test to whole-word matching first - a bare \"ch\" would otherwise also match inside \"which,\" \"search,\" \"chief,\" and any other word containing those two letters, which the project's own stated design philosophy for this heuristic explicitly warns against (better to miss a location than misidentify unrelated text as one). Only affects future visits - combined with v0.29.11's profileVisitedAt fix, any lead still missing a location (never having gotten a real response yet) is picked up and correctly classified on the next run."
)
p = doc.add_paragraph()
r = p.add_run("Location, scrape-wait early-exit fix - the actual dominant cause (v0.29.13): "); r.bold = True
p.add_run(
    "reported directly with a real profile (andreasbezner) whose location plainly says \"Switzerland,\" a word this extractor has always recognized, yet the lead's location still came back empty. Root cause: run()'s scrape-wait loop stopped polling the instant EITHER company OR location was found, not once BOTH were. Since v0.29.10 made company resolve almost instantly (the top-card badge renders immediately, unlike the lazy Experience section), the loop was exiting on the very first attempt on most profiles the moment company was found - before location, which can render a beat later, ever got a real chance across the remaining ~5.5s of polling. Very likely the single biggest cause of missing locations overall, well beyond either vocabulary gap below. Now waits for both (if (company && personLocation) break) before stopping early."
)
p = doc.add_paragraph()
r = p.add_run("Location, stuck-lead migration + non-Swiss city coverage (v0.29.13): "); r.bold = True
p.add_run(
    "also reported directly with two further real examples - Burke Holland's profile clearly shows \"Nashville Metropolitan Area,\" and Allie K. Miller's clearly shows \"New York, United States,\" yet both leads still had no location. Two more real causes. First, a lead already marked profileVisitedAt under the OLDER rules (pre-v0.29.12, or caught by the early-exit bug above) could never benefit from a later fix, since that field alone was enough to permanently skip it - fixed with a one-time migration (locationHeuristicV2Migrated) that clears profileVisitedAt on any lead still missing a location, so it gets a fair shot under the current rules on the next run. Second, \"Nashville Metropolitan Area\" has no country name in it at all - the same \"Greater Zurich Area\" phrasing already handled for Switzerland's own cities, never extended past Switzerland. CITY_TO_COUNTRY (renamed from the Switzerland-only SWISS_CITIES, storage.js) and the equivalent hint-word list in profile-content-script.js now also recognize a modest set of other major metros (New York, Los Angeles, Chicago, San Francisco, Nashville, Seattle, Austin, Boston, Dallas, Houston, Atlanta, Denver, Miami, Washington, Philadelphia, Phoenix, San Diego, Portland, Minneapolis, Detroit, London, Manchester, Toronto, Vancouver, Montreal) - deliberately a best-effort list, not exhaustive world city coverage, same trade-off already accepted for the Swiss cities."
)

doc.add_heading("6.4 Automatic lead prioritization", level=3)
add_bullets(doc, [
    "After every scan's searches finish and negative-topic filtering has run (including any opted-in "
    "re-apply pass), every lead still \u201cNew\u201d without a priority is sent to the Sales Mentor in one "
    "batch call (not per-lead), scored P1 (highest — drop everything, contact today) to P5 (lowest — "
    "unlikely fit, low urgency), each with a short reason, via a forced structured tool call (not free-text "
    "parsing, so the output is always well-formed).",
    "Scoring weighs real fit against the configured company context, seniority/decision power, and genuine "
    "urgency signals — explicitly not just topical keyword overlap. Sees a Post lead's company (v0.23.0, "
    "once extracted or assigned) and its isJobAd/isHiringPost flags, and is explicitly told not to penalize "
    "an in-post job ad just because the poster personally isn't senior - the poster is often HR or an "
    "unrelated employee sharing the opening, not the eventual contact, so what matters is the company-level "
    "signal; the next step is finding a better contact there, not necessarily messaging the poster.",
    "Treats Ideal Customer Profile fit as a secondary, moderating factor, not a pass/fail gate (v0.24.3 - a "
    "real bug found via user-supplied examples: an explicit AI-engineer/AI-developer hiring signal was being "
    "crushed to P4-5 purely for being outside Switzerland or not “enterprise,” even though "
    "isHiringPost/isJobAd and company were all being seen correctly). An on-topic need outside the exact ICP "
    "should typically land around 2-3; the bottom of the range (4-5) is reserved for no genuine buying "
    "signal at all, a clearly unrelated technical domain, or noise that should already have been filtered.",
    "Guards against the opposite failure too (v0.24.0): a post from someone who just talks about AI a lot "
    "at a company that clearly already runs AI at scale, that's really just industry commentary or "
    "thought leadership - reacting to AI news, sharing opinions/trends - with no expressed need, project, "
    "challenge, or hire of its own. Topical overlap and sounding senior aren't buying intent; the prompt "
    "scores that pattern low (4-5) on its own content. Refined in v0.29.23, reported directly with a real "
    "lead (Nicholas Blotti, “Head of AI for IT @ Azqore,” posting AI industry commentary with no expressed "
    "need, scored P4 - “this lead should be at least P2”): the original guard didn't distinguish a person "
    "who merely talks about AI from one whose own title names a genuine, formal AI leadership FUNCTION at "
    "the company (“Head of AI,” “Chief AI Officer,” “VP of AI,” “Director of Data Science,” etc., not a "
    "vague self-description like “AI enthusiast” or a consultant's own tagline). That role's mere existence "
    "is itself a real company-level signal - formal headcount/budget committed to AI, independent of "
    "whether this particular post shows a need - and now floors such leads at 2-3 rather than 4-5 on that "
    "basis alone; an actual expressed need/initiative/hire is still required to reach 1. Only affects future "
    "prioritization runs, not already-scored leads.",
    "Runs automatically, with no button — visible in the side panel as \u201cprioritizing N new leads\u2026\u201d "
    "before \u201cScan complete.\u201d Silently skipped (never fails the scan) if no Anthropic API key is "
    "configured.",
    "Never re-scores an already-scored lead, or a lead that isn't \u201cNew.\u201d",
    "\u201cPrioritize Unscored Leads\u201d button (Dashboard) catches up anything the automatic pass never "
    "reached — leads that predate the feature, or a scan that ran with no API key — scoring every unscored "
    "\u201cNew\u201d lead across the entire list, not just what's currently filtered on screen. Target "

    "Account matches (6.11) are applied first, deterministically, before whatever's left goes to the AI.",
    "\u201cRe-score All Priorities\u201d button (Dashboard, v0.24.0) re-runs the Mentor on every already-"
    "scored \u201cNew\u201d lead too, not just unscored ones - lets a prompt fix, a new/changed Ideal "

    "Customer Profile, or a freshly imported/updated Target Accounts list (6.11) retroactively apply to leads "
    "scored before it existed, with no new scan required. Same manual-override protection "
    "as everywhere else: a lead whose priority was set by hand (no priorityScoredAt) is never touched or "
    "resent to the AI. Confirms before running, since it overwrites existing AI-assigned priorities. The "
    "completion message reports two numbers: how many leads were successfully re-scored, and how many of "
    "those actually ended up with a different priority than before.",
    "Chunked batch prioritization (v0.24.2, applies to both buttons above): a single prioritize_leads call is "
    "capped at 8192 output tokens, which a large-enough batch (each lead needs a priority plus a written "
    "reason) could exceed mid-generation - coming back truncated/invalid and silently scoring nothing, with "
    "no way to tell that apart from “genuinely found nothing to score.” Both buttons now send 20 "
    "leads per AI call and apply each chunk's results as soon as it completes (so a later chunk failing "
    "doesn't lose earlier progress), and the status text shows real counted progress as each chunk lands - "
    "e.g. “Re-scoring 20 of 45 leads with the Sales Mentor…” - rather than only an "
    "elapsed-time guess with no sense of how much is left. The count reflects the chunk currently in flight, "
    "not only completed work (v0.24.5) - announced as each chunk starts, so the status never sits at a "
    "misleading “0 of N” while the first chunk is already running.",
    "Correlated re-scoring: if a scan finds a new lead from the same person (Post leads, matched by profile "
    "URL) or same company (Job leads, matched by normalized company) as an existing \u201cNew\u201d lead "
    "that's already scored, both get re-scored together in the same batch - a second signal from the same "
    "account can change the right priority. Still only ever touches \u201cNew\u201d leads; anything already "
    "acted on is never re-scored.",
    "Target Account matches (v0.28.0) are folded in before every batch call runs - during a scan, and in both "
    "Dashboard buttons above (v0.28.2, partitionLeadsByTargetAccount in storage.js) - so importing or "
    "updating the Target Accounts list retroactively re-prioritizes already-scanned leads via “Re-score "
    "All Priorities” without needing a fresh scan. See 6.11 for the full deterministic-vs-signal split.",
])

doc.add_heading("6.5 Dashboard", level=3)
add_bullets(doc, [
    "Pie charts (last 7 days / 30 days / all time), bucketed by each lead's real (parsed) post date, one "
    "colored slice per status; clicking a slice/legend row filters the table to that status.",
    "Table: Post Date, First Scanned, Source, Matched Topic / Matched Keywords (v0.24.4 - every Topic this "
    "lead matched and the specific keyword(s) that triggered each, deduplicated across topics; the same data "
    "the CSV export already carried, now visible and filterable directly in the table), Title, Content "
    "(3-line clamp, click to expand), Creator "
    "(link), Company, Location (v0.29.9 - a lead's own scraped/extracted location, same source as the "
    "Location Filter, 6.13; displayed with the classified country appended in parentheses when the raw "
    "text doesn't already name it, v0.29.22), Connection, Status (with Irrelevant-reason tooltip), Priority (P1\u2013P5 colored pill, "
    "tooltip shows the reason), Priority Reason (v0.28.4 - the same reason as real, selectable table text, "
    "3-line clamp/click-to-expand like Content; the hover tooltip alone couldn't be copied, screenshotted, "
    "or seen without a mouse), Last Activity, Actions (Open/Edit, Consult Mentor, Send Message, "
    "Assign Company, Assign Location, Dismiss). Every sortable column supports click-to-sort and an Excel-style per-column "
    "dropdown (sort asc/desc, free-text filter, and an 'Empty [Column] only' checkbox, v0.29.9, to isolate "
    "rows with nothing in a column). Column widths are user-resizable and persisted. Every column filter, "
    "the active sort, the global search text, and the Status dropdown are now persisted too (v0.29.22) - "
    "reported directly, previously only column widths/visibility survived a reopen, so a filter had to be "
    "re-entered every session. CSV export "
    "(both variants) includes Priority Reason too.",
    "Column show/hide (v0.28.6) - a growing column count meant the table couldn't fit on screen without "
    "horizontal scrolling. A “Columns” button opens an Excel-style checklist of every column "
    "(checked = visible); each column's existing sort/filter dropdown also gets a “Hide This "
    "Column” shortcut. At least one column always stays visible, so there's never a dead end with "
    "nothing left to click. A hidden column's width and any active filter are preserved and simply "
    "re-apply once it's shown again; visibility is per-browser (localStorage, same as column widths), "
    "not per-lead-dataset.",
    "\u201cGroup by Company\u201d checkbox - Excel-style outline grouping inside this same table (not a "
    "separate view): a collapsible header row per company (name, lead count, expand/collapse caret) with "
    "its leads nested underneath; leads with no company yet collect into a trailing \u201cUnknown "
    "company\u201d group. Each company header has a \u201cGet Account Summary\u201d button - a one-shot "
    "AI synthesis across every lead seen at that account, cached per session so re-opening it doesn't "
    "re-call the AI. Forces \u201cAll\u201d leads per page while active, restoring the prior page size "
    "when turned off.",
    "\u201cShow Irrelevant (negative-filtered) leads\u201d checkbox, unchecked by default and persisted — "
    "the general \u201cAll statuses\u201d view excludes Irrelevant leads so the table isn't dominated by "
    "filtered-out noise; explicitly selecting \u201cIrrelevant\u201d from the Status filter always shows "
    "them regardless.",
    "Pagination (20/50/100/All per page, remembered), global search (title/content/creator), CSV export "
    "(all leads, or exactly what's currently filtered — both include Priority).",
    "Bulk Change: a small, deliberately unobtrusive button (pagination row, not the main controls) opens a "
    "modal dialog — a red warning naming exactly how many currently-filtered leads will be affected, no "
    "default status pre-selected, a confirmation prompt on top of that, and an \u201cUndo Last Bulk "
    "Change\u201d button in the same dialog that restores every affected lead to its exact prior status (one "
    "level of undo, persists across Dashboard sessions until superseded by another bulk change). Closeable "
    "via a title-bar-style \u2715.",
    "Detail page (per lead): full content, status control, Priority override (v0.23.0 - a dropdown right "
    "next to Status lets the salesperson correct a priority the Mentor got wrong, or set one on a lead that "
    "was never scored; permanently protected from both the automatic per-scan pass and correlated "
    "re-scoring, since both key off whether the AI itself scored the lead, not just whether a priority "
    "exists), Draft Message (template-based, AI-generated, "
    "copy-to-clipboard — copying auto-advances status New \u2192 Contacted), and a lead-scoped "
    "Consult Mentor chat (persisted per lead) with two quick-action buttons - “Buyer Summary” "
    "and “Conversation Starters” - that send the same canned request an equivalent typed message "
    "would, through the identical conversation/history/tools, so the salesperson doesn't have to type the "
    "same standard requests for every lead.",
])

doc.add_heading("6.6 Advisors (Sales Mentor & Customer Voice)", level=3)
add_bullets(doc, [
    "Sales Mentor: persona-configurable agent for cross-lead strategy questions (\u201cwhich lead should I "
    "prioritize,\u201d general sales process advice) and drafting. Uses list_leads/get_lead_details tools "
    "only when a question actually needs real data — list_leads excludes Irrelevant leads and includes both "
    "Post and Job leads (tagged type + hasIndividualContact), instructing the Mentor to handle each "
    "appropriately.",
    "Customer Voice: persona-configurable agent that roleplays a realistic buyer, grounding itself in a "
    "named lead's real content when one is referenced, or a general persona otherwise.",
    "Both share one tool-use engine (runAgentTurn in agent-shared.js): bounded timeouts (2.5 min per "
    "conversational turn, 50s per tool call) with a live ticking status (\u201cThinking\u2026 (Ns)\u201d) so "
    "a genuinely long analysis reads as progress, not a hang.",
    "A stray Enter press while a turn is still in flight is a no-op (matches the Send button's disabled "
    "state) — previously this could start a second concurrent turn and silently lose a message.",
])

doc.add_heading("6.7 Settings", level=3)
doc.add_paragraph(
    "Language (English/German), company context (\u201cWhat We Offer,\u201d used by every AI feature to "
    "reason about real fit), Ideal Customer Profile (v0.23.0 - who's specifically being targeted: size, "
    "geography, what they're investing in; deliberately a separate field from \u201cWhat We Offer\u201d since "
    "the product and the target customer are different concepts, even though every relevant AI feature reads "
    "both together - not used by Customer Voice, which has no reason to reason about who the seller "
    "targets), Anthropic API key, message templates (auto-picked per lead by connection status "
    "/ job-ad detection, or chosen manually), value-add offers (a fixed list the AI may mention, never "
    "invents). Target Accounts (v0.28.0 - imported list, confidence threshold, and the configurable Prioritization Rules table, v0.29.4; see 6.11). "
    "Opened via its own blue button in the Scanner tile. The Advisors page reads these live (via "
    "chrome.storage.onChanged) rather than caching a stale copy, since editing now happens on a separate page."
)
add_bullets(doc, [
    "Persistent \u201cSaved\u201d indicator (v0.29.7) - every field here already auto-saves on change "
    "(kept deliberately - an explicit Save-everywhere model risks losing an edit if the user navigates away "
    "without clicking it), but that auto-save is invisible. A fixed, page-wide badge now flashes Saved on "
    "every write across the whole page and settles back to All changes saved a moment later. The Location "
    "Filter's country picker (6.13) is the one exception: it stages changes and requires its own explicit "
    "Save click, so it also gets its own local Unsaved changes/Saved status alongside this page-wide one.",
])

doc.add_heading("6.8 Backup / portability", level=3)
doc.add_paragraph(
    "Two independent export/import flows (side panel, v0.25.1) - restoring one can never touch or roll back "
    "the other, found necessary after a combined single-file design meant recovering lost leads also "
    "silently rolled back Topic edits made since that backup:"
)
add_bullets(doc, [
    "Settings: Topics, Job Topics, filters, personas, company context, message templates, negative topics, "
    "the imported Target Accounts list and its score threshold (v0.28.0, see 6.11), the Location Filter "
    "configuration (see 6.13), API key (opt-in per "
    "export, for deliberately sharing a spend-capped trial key). Import replaces "
    "wholesale - this is configuration a person deliberately set. Fixed in v0.29.22: asked directly whether "
    "this export covered everything in both the side panel and the Settings page - the Location Filter "
    "configuration was silently missing from export/import despite being genuine, hand-set configuration; "
    "now included. (The Target Accounts Explorer workbook, 6.12, is still deliberately excluded from this "
    "automatic export - see its own note below - but now has its own dedicated backup, next.)",
    "Target Accounts backup (v0.29.22, Settings page): a separate, on-demand “Export Target Accounts” "
    "button (next to the existing Import Target Accounts) downloads a standalone .json backup of the "
    "target-accounts map plus the full Explorer workbook - reported directly (“Need also a backup / "
    "export button for Target Accounts, as well as an Import button”), since re-importing a research "
    ".xlsx was previously the only way to recover this data at all. Import Target Accounts recognizes and "
    "restores this backup shape directly (distinct from both the legacy convert_target_accounts.py JSON and "
    "a fresh .xlsx import). Extended in v0.29.30: reported directly, having to leave the Target Accounts "
    "Explorer page (6.12) and go to Settings to back up or refresh the very data it's showing was an "
    "unnecessary detour. The same Import/Export buttons now also appear at the top of target-accounts.html, "
    "calling the exact same storage.js functions - Settings stays the source of truth for the score "
    "threshold and other configuration, but the actual import/export actions work from either page. Import "
    "works even before any data has been loaded (from the page's own empty state); Export only appears once "
    "there's something to back up.",
    "Leads: the full lead dataset, plus the generic Sales Mentor and Customer Voice conversation histories "
    "(previously not backed up anywhere at all, despite being genuinely irreplaceable). Import merges, "
    "never replaces - a lead or chat history already present locally is left exactly as-is; only what's "
    "genuinely missing locally gets restored, so importing an older backup can never discard newer local "
    "activity.",
    "Consistent “Importing…” → result-or-failure status for every import in the extension (v0.29.38) - "
    "reported directly as a general expectation, not just for Target Accounts (whose own version of this "
    "fix is under 6.11). Import Settings and Import Leads had no persistent status before this, relying "
    "purely on a dismissable alert() with no visible trace of a failure once closed. Both now show "
    "“Importing <file>…” immediately on file selection (two new status lines, import-settings-status/"
    "import-leads-status, sidepanel.html), then either a completion message with the filename and a full "
    "date/time timestamp (Import Leads: “N leads restored from file <name> at <date/time>”, replacing its "
    "old success alert() entirely) or a persistent “Import failed - “<file>” ... (<reason>)” "
    "message - a destructive-feeling Settings replacement still also alerts on failure, but a routine "
    "success no longer needs to interrupt.",
])
doc.add_paragraph(
    "Both files download automatically before every scan, so a scan-time failure never loses accumulated "
    "data. Downloads land in /backup (v0.27.0), not the project root - CSV exports land in /exports. "
    "“Clear Results” (side panel) is display-only - it clears that panel's own list, never "
    "chrome.storage.local; no action in the app deletes a saved lead except a person's own explicit "
    "per-lead status change."
)
p = doc.add_paragraph()
r = p.add_run("Empty-install warning (v0.27.1): "); r.bold = True
p.add_run(
    "Chrome ties an unpacked extension's storage to its install location, not its code - moving or "
    "reinstalling from a different path starts genuinely blank even though the old data still exists in a "
    "backup file, and no API lets a new install read an old one's storage to auto-migrate it. The side "
    "panel shows a banner whenever it finds zero Topics/Job Topics and zero leads, pointing directly at "
    "Import Settings/Import Leads instead of leaving an unexplained blank slate - worded to also make sense "
    "for a genuinely new install."
)
p = doc.add_paragraph()
r = p.add_run("Missing-API-key warning (v0.28.3): "); r.bold = True
p.add_run(
    "the API key is deliberately excluded from every automatic backup and from a manual export unless the "
    "“include API key” box is checked (a plain-text secret shouldn't be included by default) - so "
    "restoring Topics/leads after an empty-install recovery (above) brings the data back but not the key, "
    "silently breaking company extraction, prioritization, Draft Message, and both Advisors chats until "
    "each is clicked and fails. A second, separate side-panel banner now shows whenever there's real "
    "Topics/leads data but no API key configured, naming the AI features that need it and pointing "
    "straight at Settings - but only once there's real data, so it doesn't duplicate the empty-install "
    "banner above on a genuinely fresh install."
)

doc.add_heading("6.9 Help", level=3)
doc.add_paragraph(
    "A dedicated Help page (its own tab, opened from a “Help ↗” button next to Dashboard/"
    "Advisors/Settings): a curated set of Q&A entries covering every feature above, plus a free-text search "
    "box. Search is deliberately not an AI feature — no API key needed, instant, and answers are fixed/"
    "reviewed rather than generated. Matching is token-overlap across each entry's question and synonym "
    "keywords (so “enable a Topic” and “disable a search topic” surface the same entry) "
    "with light typo tolerance (edit-distance on individual words). Each result is a collapsible card."
)

doc.add_heading("6.10 Activity Log", level=3)
doc.add_paragraph(
    "A dedicated page (v0.26.0, its own tab, opened from an “Activity Log ↗” button next to "
    "Help) recording every meaningful User action and automatic Extension action, with old/new values where "
    "applicable and every error - prompted by two incidents in one session that were hard to diagnose "
    "without it: an AND-topic bug only visible via the background service worker's own DevTools console "
    "(unreliable - it clears itself when the worker goes idle), and a data-loss incident reconstructed "
    "after the fact from context clues."
)
add_bullets(doc, [
    "Written directly to chrome.storage.local from wherever each action actually happens - including "
    "inside background.js itself - never inferred from chrome.runtime.sendMessage broadcasts, which are "
    "lost entirely if no page happens to be listening (true of every scan-lifecycle message already, with "
    "no storage-backed fallback before this). The log is therefore complete even for a scan that ran while "
    "every page was closed.",
    "Covers: Topic/Job Topic/Negative Topic add/remove/enable/scope/keyword edits (old→new keyword counts), "
    "scans started/completed/errored, automatic negative-topic filtering (both on discovery and on "
    "re-apply) and automatic company extraction/prioritization (including correlated re-scoring) with "
    "their failures, Export/Import Settings and Leads, lead status/priority/company changes, Bulk Change + "
    "Undo, Prioritize/Re-score/Extract Companies, Apply Negative Filters, accepted Lookalike/Search-Quality "
    "suggestions, settings field edits, and clearing an AI conversation.",
    "Free-text fields log once per real edit (focus → blur, only if changed), not per keystroke - reverting "
    "a field back to its original value logs nothing. The Anthropic API key's actual value is never "
    "logged, only that it changed.",
    "Capped at 2000 entries (oldest dropped first) - no unlimitedStorage permission is declared (5MB real "
    "chrome.storage.local quota) and nothing else in the app guards against quota exhaustion, so the log is "
    "Never manually clearable (v0.26.2) - this is the one place to investigate what happened after "
    "something looks wrong, so no action anywhere deletes it. Stored as one array per calendar day "
    "(activityLog:YYYY-MM-DD) rather than one shared array; anything older than a 90-day retention window "
    "is pruned automatically on every write - a predictable “always the last 90 days” guarantee, "
    "not a raw entry-count cap that could exhaust itself faster during a single unusually active day. Log "
    "data from the earlier flat single-key scheme migrates automatically (bucketed by each entry's own "
    "timestamp) the first time it's read.",
    "Updates live via chrome.storage.onChanged (v0.26.1) - a scan can log many entries over its whole run, "
    "and this page doesn't require a manual reload to see them, the same reactive pattern the Dashboard/"
    "Advisors pages already use for their own storage reads.",
    "Periodic file export to /log (v0.27.0) - since this app never runs anything in the background on its "
    "own, this piggybacks on the existing manual Scan trigger (the same moment Settings/Leads backups "
    "already fire) rather than a chrome.alarms schedule. Each closed day (not today, which is still being "
    "written to) is exported to log/activityLog-YYYY-MM-DD.json exactly once, the first time a scan happens "
    "on or after the next day - a predictable, permission-free approximation of a daily export, not a true "
    "cron.",
])

doc.add_heading("6.11 Target Accounts (v0.28.0, extended through v0.29.5)", level=3)
doc.add_paragraph(
    "A curated, externally-researched list of target companies - one row per company, scored 0-100 for "
    "AI-consulting sales fit (AI_Priority_Score), with a categorical label (Very High, Very High - "
    "Provisional, High, High - Provisional, Out of Scope, Insufficient Evidence), industry, and top AI "
    "initiatives - feeding directly into lead prioritization (6.4) so a scanned lead at a well-researched, "
    "high-priority company doesn't have to wait on/rely purely on the AI's own judgment of an unfamiliar name."
)
add_bullets(doc, [
    "Source & import: maintained externally as an Excel workbook (ChatGPT-researched, updated roughly every "
    "few months). The Settings page's “Import Target Accounts” button (same file-picker pattern "
    "as Import Settings/Import Leads, 6.8) reads the .xlsx file directly - no conversion step. "
    "code/xlsx-lite.js is a small, dependency-free in-browser reader (v0.28.1) purpose-built for this one "
    "sheet: it unzips the workbook (native DecompressionStream) and reads its Companies sheet's XML (native "
    "DOMParser) rather than bundling a third-party xlsx library into an extension that already holds "
    "LinkedIn/Anthropic host permissions. code/convert_target_accounts.py (the original v0.28.0 approach, "
    "converting to exports/target-accounts.json first) still works and is kept as an optional offline/CLI "
    "path, but isn't part of the normal workflow anymore. Matched against a lead's company field via the "
    "existing normalizeCompanyName() (already used for company grouping elsewhere), so exact legal-suffix/"
    "punctuation differences don't block a match. Fixed in v0.29.27: reported directly (the Company ID "
    "resolver, 6.16, reported 486 instead of 500) - this import used to only include a company in the map "
    "if it had a non-null AI Priority score, silently dropping every company deliberately marked Out of "
    "Scope (competitors/AI vendors) entirely, so they could never be resolved to a LinkedIn ID or included "
    "in the Target Account-scoped Post search (6.17) either - a side effect that had nothing to do with why "
    "they were excluded in the first place. Verified safe before widening: evaluateTargetAccountMatch "
    "already nulls out any match whose score is null, so including these companies changes nothing about "
    "the P1 auto-boost or the AI's signal-weighting - they still never qualify. Now imports every company "
    "with a name, regardless of score. Also fixed in the same release: this map is rebuilt from scratch on "
    "every import (by design), but a company's resolved LinkedIn ID (6.16) is now carried forward across a "
    "re-import by matching company name - durable data that has nothing to do with whatever changed in a "
    "refreshed workbook, so refreshing it never forces a full re-resolution of the whole list.",
    "Job leads: fixed at Priority 3, always (v0.29.2, tightened from v0.28.5) - a Job lead's "
    "“creator” is the company itself, not a real, contactable individual, and a job ad typically "
    "states nothing beyond the hiring itself. A Job listing at a qualifying company never does better than "
    "Priority 3 no matter how highly the employer scored - set directly, no AI call. A Job lead whose "
    "company is only Provisional/below-threshold still gets the older soft-signal treatment below.",
    "Post leads (including an in-post job ad): Priority 1 when the headline names a decision-maker role, "
    "or the lead came from the “AI Transformation” topic (v0.29.2) - a real person is a "
    "fundamentally stronger signal than an employer name alone. matchingHighValueTitle() in storage.js "
    "checks the lead's own headline against a curated list: CTO/CIO/CAIO/CDO and spelled-out forms, "
    "Head/VP of AI, Head/VP of Digital Transformation, Head/VP of Automation, Head/VP of Innovation. "
    "Independently, a lead from a topic named “AI Transformation” also qualifies - a title match "
    "takes precedence when both apply. Fixed, no AI call, so the reason is always an exact sentence naming "
    "which condition fired. The lead also gets a targetAccountMatch: true flag.",
    "Post leads otherwise: floor of Priority 2 (v0.29.2) - a qualifying company with no title/topic match "
    "is still a real contact worth more than average, just not automatically the top priority. Sent to the "
    "AI as a signal (targetAccountFloor: 2), and the returned priority is clamped up to 2 if the model "
    "itself returned 3-5 - the Mentor's own judgment still picks between 1 and 2 within that range. The "
    "clamp is stated plainly in the reason whenever it actually changes the value.",
    "Soft signal otherwise (a Provisional/below-threshold match on either lead type) - passed into the "
    "same batch AI prioritization call (6.4) as context, weighted per the Post/Job distinction (a Job's "
    "signal is explicitly weighted more conservatively - roughly one priority level of lift, not straight "
    "to 1 or 2). The Mentor is told to mention it in its own reason when it influenced the call, but "
    "that's free-text AI writing, not a guaranteed template - it didn't reliably say so. Fixed in v0.28.4: "
    "every AI-returned priority for a lead that carried a signal now gets a fixed [Target Account signal: "
    "Company scored N/100 (Label)] tag deterministically prepended to its reason, regardless of what the "
    "model itself wrote.",
    "Job lead, Provisional/below-threshold match: hard ceiling of Priority 3 (v0.29.17) - reported directly, "
    "two real Job leads with a Very High - Provisional signal (Basler Kantonalbank, Nestle) still reached "
    "Priority 1 despite the soft should rarely reach 1 or 2 guidance above - a guideline the model can and "
    "did ignore. Consistent with this project's preference for deterministic guarantees over relying on the "
    "model to follow soft instructions, a Job lead with ANY Target Account match now carries a "
    "targetAccountCeiling (new Job signal ceiling rule, Settings, default 3) - the Sales Mentor still "
    "decides freely, but tagPrioritiesWithTargetAccountSignal (storage.js) clamps any returned priority "
    "better than the ceiling back down to it, using the same clamp-and-annotate mechanism the Post company "
    "floor rule already uses in the opposite direction. Uses the Prioritization Rules table's Ceiling "
    "column, previously unused by any rule. Can be disabled like every other rule here, in which case a "
    "Provisional-matched Job lead returns to the earlier unconstrained soft-signal behavior.",
    "Applies everywhere prioritization runs (v0.28.2) - the same split "
    "(partitionLeadsByTargetAccount in storage.js) runs during a scan's automatic pass and both "
    "Dashboard buttons (6.4), not just at scan time. Concretely: importing a new/updated Target "
    "Accounts list and then clicking Re-score All Priorities immediately re-prioritizes every "
    "eligible existing lead - no new scan needed.",
    "Threshold and the imported list itself live in Settings (6.7) and travel with a Settings export/import "
    "(6.8), so a fresh install or a restored backup doesn't lose them.",
    "Every rule above is configurable, and the whole set is visible in one place (v0.29.4) - a "
    "Prioritization Rules table on Settings (6.7) lists the five rules above with columns for "
    "Ceiling/Floor/Decisive value and Enabled - each rule occupies exactly one of those three value "
    "columns, matching its fixed effect type. A rule's own description and effect type are fixed in "
    "code (PRIORITIZATION_RULE_CATALOG in storage.js), never stored or edited - only its value and "
    "enabled state are user-adjustable. Disabling a rule leaves those leads to the Sales Mentor's own "
    "judgment as a plain signal. The Mentor's own judgment is always the base decision for every lead "
    "and can't itself be disabled, only constrained or overridden by an enabled rule that applies. "
    "Extended in v0.29.5 with two further transparency rows, Competitor Blocklist and Location Filter - see 6.13.",
    "Import status shows time and filename, not just a date (v0.29.38) - reported directly: re-importing a "
    "refreshed research workbook more than once in one day (e.g. to pick up a Zefix cross-check column, "
    "6.16) left an ambiguous “500 companies imported · Sep 9, 2026” status with no way to tell a "
    "just-finished import from a stale one hours earlier, or confirm it actually ran. The imported-at "
    "timestamp now includes the time, and the status line also shows the source filename "
    "(targetAccountsImportedFileName, storage.js), useful with several similarly-named candidate workbooks "
    "in play at once - final message reads “N companies imported from file <name> at <date/time>”. Carried "
    "through the Export/Import Target Accounts backup flow (6.7) too, so a restored backup doesn't leave a "
    "stale filename from whatever was imported before it. A second, related complaint fixed the same way: "
    "parsing a large multi-sheet workbook isn't instant, and with no feedback between the click and the "
    "final status, a click that hadn't registered yet looked identical to one still running. The status "
    "line now shows “Importing <filename>…” immediately on file selection, replaced by the real result "
    "either way. A third: on failure, silently reverting straight back to the last-successful status (once "
    "the dismissable alert was closed) left no visible trace anything had gone wrong - the status line now "
    "states the failure and the actual reason persistently instead, e.g. Import failed - “<file>” doesn't "
    "look like a valid, uncorrupted .xlsx or .json export (<error detail>). Generalized to every import flow "
    "in the extension, not just this one - see 6.8 for Import Settings/Leads, and 6.12 for a real parity bug "
    "this surfaced in the Explorer page's own separate copy of this same import.",
    "Two more externally-researched columns imported (v0.29.42): alternativeName (a commonly-used "
    "short/acronym form, e.g. a cantonal bank's own initials) and linkedinLink (a human/AI-verified "
    "LinkedIn company-page URL - validated for 499 of 500 companies). Same refresh-every-import treatment "
    "as officialName - see 6.16, which is what actually consumes both.",
])

doc.add_heading("6.12 Target Accounts Explorer (v0.29.0, extended v0.29.3)", level=3)
doc.add_paragraph(
    "The lightweight targetAccounts map (6.11) only carries what auto-prioritization needs - a score, "
    "label, and top initiative per company. The source workbook has real relational depth beyond that: "
    "Companies (the hub) plus Contacts, AI_Initiatives, AI_Investment, and Sources, each referencing a "
    "company via Company_ID. This page browses all of it."
)
add_bullets(doc, [
    "One import, two datasets - the same “Import Target Accounts” .xlsx pick on Settings "
    "(6.7) populates both the lightweight map (6.11) and the full relational dataset here, via "
    "xlsx-lite.js's parseFullTargetAccountsWorkbook (a generic per-sheet reader that keeps every "
    "column instead of parseCompanyRows' six named ones) and storage.js's "
    "importTargetAccountsWorkbook/getTargetAccountsWorkbook. Column headers are camelCased "
    "(Company_ID -> companyId). A .json import (the legacy convert_target_accounts.py path) only ever "
    "populates the lightweight map.",
    "New page - code/target-accounts.html/.js/.css, opened via a “Target Accounts ↗” "
    "button next to Activity Log in the side panel (same no-manifest-entry pattern as Activity Log/Help).",
    "Master table, every Companies column - every field the sheet has is a real, toggleable "
    "table column (two currency fields are folded into their paired amount column's display rather than "
    "shown separately). Sixteen start visible - the rest start hidden. Same Columns button + per-column "
    "“Hide This Column” menu item as the Dashboard (6.5). Sortable per column, plus a free-text search box "
    "across company name/industry. Sorted by AI Score descending by default.",
    "Column order and set updated to match the workbook (v0.29.42) - reported directly: the externally-"
    "maintained workbook (Swiss_AI_Prospects_500_v16_reordered_columns.xlsx) already orders its own "
    "columns with triage-relevant fields (AI Score, Evidence Coverage, the Zefix/alternative-name/"
    "LinkedIn-link cross-check) well to the left, so COMPANY_COLUMNS was reordered to mirror it exactly, "
    "left to right, rather than keeping its own independently-curated order and forcing horizontal "
    "scrolling to reach them. Also added six columns not previously surfaced here at all: evidenceStatus, "
    "zefixOfficialName, zefixUid, zefixAddress, alternativeCompanyName (visible by default, alongside "
    "evidenceStatus/zefixOfficialName), and linkedinLink (visible, rendered as a clickable link like "
    "primarySourceUrl) - see 6.16 for what actually populates and consumes alternativeCompanyName/"
    "linkedinLink.",
    "Per-column filtering with an exclude mode (v0.29.3) - each column's menu has a text filter plus "
    "an “Exclude matches” checkbox, so filtering out companies whose AI Priority contains "
    "“Insufficient Evidence” is one click rather than impossible with a plain "
    "contains-only search. Persisted (v0.29.22, localStorage, same as the hidden-columns list): reported "
    "directly (“I keep having to refilter (remove) the Insufficient Evidence ones and the Out of Scope "
    "ones”) - column filters, sort order, and the search box now all survive closing and reopening this "
    "page, including a fresh extension load.",
    "Row click expands a detail panel in place: a primary-source link, plus the company's related "
    "Contacts and AI Initiatives (every column of each sheet, v0.29.3) - filtered client-side by "
    "matching companyId - and AI Investment/Sources sub-tables (unchanged, curated columns) when a "
    "company has either.",
    "Deliberately not included in Settings export/import (6.8) - the full dataset (~700 rows across "
    "five sheets) would otherwise get rewritten into every automatic pre-scan backup. Re-picking the "
    "same .xlsx file in Settings is the recovery path if storage is ever wiped. v0.29.22 added a separate, "
    "on-demand alternative for this exact recovery case - an “Export Target Accounts” button (6.8) that "
    "backs up this workbook (plus the lightweight map) into one .json file, without touching the automatic "
    "per-scan Settings export this note describes.",
    "A parity bug found and fixed (v0.29.38) - the “Import Target Accounts” button this page also carries "
    "(v0.29.30, see 6.8) is a genuinely separate code path from Settings' own, not a shared one, and had "
    "silently drifted from it in two real ways. It never mapped a workbook's zefixOfficialName column at "
    "all, so an import done from this page instead of Settings would silently skip the resolver's "
    "official-name improvement (6.16); and it never passed a filename to importTargetAccounts, so this "
    "page's own imports never recorded which file was used. Both fixed to match Settings' version exactly, "
    "alongside the same “Importing…” → result-or-failure status treatment described in 6.8.",
])

doc.add_heading("6.13 Location Filter (v0.29.5)", level=3)
doc.add_paragraph(
    "Many scanned leads come from outside Switzerland, the actual sales territory - previously the only "
    "lever was Topic-level location keywords at LinkedIn-query time, described by the user as best effort. "
    "Once a lead's own stated location is known (a Job lead's own scraped location, or a Post lead's "
    "location from an opt-in profile visit - 6.3), that data can drive a real, reviewable auto-filter, the "
    "same mechanism Negative Topics (6.2) already uses, never a silent delete."
)
add_bullets(doc, [
    "Configuration lives in Settings (6.7), one of three modes: Off (default), By continent (six "
    "checkboxes: North America, Latin America, Europe including UK and Switzerland, Africa, Middle East, "
    "South East Asia), or By country - a dual-listbox picker (v0.29.7, replacing an initial free-text textarea): a searchable, alphabetized list of every recognized country on the left, an arrow pair (or double-click) to move a selection into the filter on the right. Only ever offers names from ALL_COUNTRIES (the same list classifyLocation matches against), so a selected country is guaranteed to match exactly - a misspelling is no longer possible. Stages changes locally and only saves (one write, one activity-log entry) when its own Save Countries button is clicked. The six continents mirror standard "
    "Americas/EMEA/APAC sales territories, split one level further; since they don't geographically cover "
    "the whole world on their own, the remaining regions fold into South East Asia rather than adding a "
    "seventh Other bucket.",
    "classifyLocation() in storage.js checks a fixed country-to-continent table (~150 countries plus "
    "common aliases) first, then a small Swiss-city fallback list for LinkedIn's Greater X Area phrasing. "
    "Never guesses - returns nothing rather than a wrong classification. Fixed in v0.29.12: both the "
    "country aliases and the Swiss-city fallback list only ever recognized English names - reported "
    "directly, leads at obviously-Swiss companies (SBB, Syngenta, IMD Business School) had no "
    "classifiable location because their profile said Schweiz/Suisse/CH (not Switzerland) or "
    "Zurich/Geneve/Luzern in their native spelling (not Zurich/Geneva/Lucerne). COUNTRY_ALIASES and "
    "SWISS_CITIES now also recognize these German/French spellings and the bare ISO code CH (matched "
    "only as a whole word, so it can't fire inside an unrelated word), kept in sync with the equivalent "
    "hint-word list in profile-content-script.js that finds the raw location text in the first place. "
    "Extended in v0.29.13, renamed to CITY_TO_COUNTRY: reported directly, \"Nashville Metropolitan Area\" "
    "(a real lead's own profile text) has no country name at all, the same \"Greater X Area\" phrasing "
    "already handled for Swiss cities but never extended further. Now also recognizes a modest, "
    "best-effort set of other major metros (New York, Los Angeles, Chicago, San Francisco, Nashville, "
    "Seattle, Austin, Boston, Dallas, Houston, Atlanta, Denver, Miami, Washington, Philadelphia, Phoenix, "
    "San Diego, Portland, Minneapolis, Detroit, London, Manchester, Toronto, Vancouver, Montreal) - not "
    "an attempt at exhaustive world city coverage, same trade-off already accepted for the Swiss list. "
    "Separately, and likely the bigger fix overall: the profile scraper's own scrape-wait loop "
    "(profile-content-script.js) used to stop polling the moment EITHER company OR location was found, "
    "not once BOTH were - reported directly with a real profile (andreasbezner) whose location plainly "
    "says \"Switzerland,\" a word always recognized, yet still came back empty. Since company now resolves "
    "almost instantly via the top-card badge (v0.29.10), the loop was exiting before location - which can "
    "render a beat later - ever got a fair chance. Now waits for both before stopping early. Fixed in "
    "v0.29.14: reported directly with five more real profiles - Bengaluru/India, Dubai/UAE, Canada, "
    "\"New York City Metropolitan Area,\" and Atlit/Haifa/Israel all still came back with no location. "
    "Four of the five (India, UAE, Canada, New York) were already-recognized words, so their failure "
    "wasn't a vocabulary gap - consistent with the two fixes above not yet having been tested against a "
    "live re-run. Israel was a genuine, separate gap - never in the hint-word list at all, despite "
    "already being a recognized country for classifyLocation. Rather than keep closing one missed "
    "country at a time, LOCATION_HINT_WORDS now mirrors the FULL country list classifyLocation already "
    "recognizes (~150 countries) instead of a hand-picked subset, so a country gap in one can no longer "
    "exist without the other having it too. Fixed in v0.29.15 - the real fix: after several more rounds "
    "of one-more-missing-country/city reports that kept recurring no matter how large the recognized-word "
    "list grew, real profile HTML (shared directly) revealed the location text isn't identified by "
    "keyword-matching its content at all. Structurally, it's always the first paragraph in a small row "
    "that also contains the Contact info overlay link - a stable, always-present feature of every "
    "profile's top card regardless of language or how obscure the location is. "
    "personLocationFromContactInfoRow() (profile-content-script.js) now tries this first, capturing "
    "whatever text is actually there with no dependency on recognizing it - the keyword-scan approach "
    "above is now only a fallback for a profile layout this hasn't been checked against. Classification "
    "into a country/continent is unaffected - classifyLocation's tables still do that, just against a "
    "much more reliably captured raw string. Fixed in v0.29.16: reported directly, re-running Extract "
    "Companies from Profiles on v0.29.15 against the same 53 leads still only got a location for 9, no "
    "real improvement over the v0.29.14 baseline, despite v0.29.15's fix being content-independent and "
    "expected to work on nearly every profile. Root cause: the profileVisitedAt migration guard is "
    "one-time, and it had already fired during earlier v0.29.14 testing - so every lead visited-and-failed "
    "under the OLD keyword-scan code between v0.29.11 and v0.29.14 was already past that reset, stayed "
    "permanently marked checked, and never got a chance to run under v0.29.15's new structural extractor "
    "at all. Same underlying pattern as the v0.29.13 fix, recurring because a one-time migration flag only "
    "ever covers the ONE fix it shipped with. Added a second, independent one-time migration "
    "(locationHeuristicV3Migrated) that clears profileVisitedAt once more for any lead still missing a "
    "location, so v0.29.15's fix gets a real shot at every lead that hasn't already succeeded. Extended in "
    "v0.29.22: reported directly with real examples, several clearly non-Swiss leads (Greater Hamburg Area, "
    "Greater Bengaluru Area, Greater Lyon Area, Greater Rennes Area) went untouched by the filter since none "
    "of their metros were recognized. Added Germany, France, India, Italy, Spain, Netherlands, Ireland, the "
    "Nordics, Poland, Austria, Belgium, the UAE, Japan, and Australia's major metros - same modest, "
    "best-effort trade-off, not exhaustive coverage. Also, per direct feedback (prefer the country, or "
    "combine the two, e.g. “Greater Hamburg Area (Germany)”) - the Dashboard's Location column "
    "(6.5) now appends the classified country in parentheses whenever the raw text doesn't already name it, "
    "using this exact same function, so the display hint and the filter's actual behavior can never "
    "disagree.",
    "A lead is only ever marked Irrelevant for a confident, configured mismatch - one with no location "
    "data yet, or text that can't be confidently classified, is never touched.",
    "Composes with Negative Topics (6.2) via a parallel locationFilterReason field - each filter's own "
    "restore-to-New logic checks that the other reason is also absent before restoring.",
    "Applied automatically after every Extract Companies & Locations from Profiles run, and on demand via a "
    "standalone Apply Location Filter button (Dashboard and Settings).",
    "Visible and toggleable from the Prioritization Rules table (6.11) alongside Competitor Blocklist, "
    "for the same transparency reason - both exclude a lead to Irrelevant outright rather than setting a "
    "priority level. The built-in Competitor Blocklist also gained PwC, KPMG, Accenture, McKinsey, and "
    "Bain for fresh installs.",
])

doc.add_heading("6.15 Compare via People Search (v0.29.24, experimental)", level=3)
doc.add_paragraph(
    "Follow-up to the v0.29.22 Location Filter fixes: with accurate location classification finally in "
    "place, the number of surviving Post leads dropped sharply relative to Job leads - reported directly, "
    "raising a strategic question: is that fixable? Investigated live against LinkedIn's own UI rather than "
    "guessed."
)
add_bullets(doc, [
    "Post Search has no location filter at all - confirmed by a screenshot of the real filter bar (Posts, "
    "Sort by, Date posted, Content type, From member, All filters - no Locations option). Job Search is "
    "geo-scoped by LinkedIn's own geoId parameter (buildJobSearchUrl, background.js) before results ever "
    "reach the extension; Post Search (buildSearchUrl) has no equivalent - it's a pure global keyword "
    "match. This makes the imbalance structural, not a bug - a much larger fraction of what a global "
    "keyword search finds is genuinely not Swiss, and the Location Filter is now correctly surfacing that "
    "instead of silently missing it. Nothing in this feature changes that - it only affects how location/"
    "company is determined for a lead the (unscoped) Post search already found.",
    "People Search DOES support a location filter - confirmed live: selecting Switzerland there produces "
    "geoUrn=[“106693272”]. Its result cards also show location and current company directly, "
    "without needing a full profile visit.",
    "What this feature does: a new, explicitly experimental Dashboard button, “Compare via People "
    "Search…,” looks up each Post lead's author by exact name in People Search filtered to "
    "Switzerland (people-search-extraction.js, mirroring profile-extraction.js's visiting/pacing/timeout "
    "shape exactly, including the same .catch(() => {}) unhandled-rejection fix). A new content script "
    "(people-search-content-script.js, matching linkedin.com/search/results/people/*, gated the same way "
    "as profile-content-script.js) reads the matching result's location/company. To avoid mistaking a "
    "same-named stranger for the right person, a result only counts as a match when its headline is also a "
    "close match (word-overlap heuristic, not exact) to the post's own already-known headline - anything "
    "less confident is skipped, not guessed.",
    "Comparison mode, not a replacement - deliberately does not touch the existing profile-visit extraction "
    "or overwrite company/location. Results are written to separate peopleSearchLocation/"
    "peopleSearchCompany/peopleSearchMatched/peopleSearchCheckedAt fields (applyPeopleSearchComparison, "
    "storage.js) and compared against the existing values - location compared via classifyLocation's "
    "country rather than exact string equality, so a German vs. English spelling of the same real place "
    "doesn't read as a disagreement. Agree/disagree counts for both fields are surfaced in the completion "
    "message and Activity Log, so this method's real-world accuracy can be judged before it's ever trusted "
    "as a source.",
    "Same “unverified against real HTML” caveat profile-content-script.js started with - this "
    "file's selectors were built from a screenshot of a real, Switzerland-filtered People Search, not real "
    "HTML, and may need a live-tuning pass the same way that file did.",
    "What this doesn't solve: attacking the actual Post-vs-Job imbalance at the root would mean flipping "
    "the search order entirely - searching People (which supports geo-filtering) by relevant title "
    "keywords first, then checking for recent on-topic activity - rather than searching Posts globally and "
    "hoping the author turns out to be Swiss. That's a distinct, larger piece of work, not yet scoped or "
    "built.",
])

doc.add_heading("6.16 Resolve LinkedIn Company IDs (v0.29.25, experimental)", level=3)
doc.add_paragraph(
    "A different idea for fixing the Post-vs-Job imbalance at the root than 6.15's People-first approach: "
    "search Companies located in Switzerland (using the existing curated Target Accounts list, 6.11/500 "
    "companies) first, then scope Post search to just those companies' employees via LinkedIn's "
    "authorCompany filter - confirmed live to genuinely restrict results (a manually-built 52-company test "
    "list correctly narrowed the results, filter chip and all; LinkedIn accepted at least that many IDs in "
    "one search with no visible error)."
)
add_bullets(doc, [
    "The missing piece: authorCompany needs LinkedIn's own numeric company IDs, and the Target Accounts "
    "data only ever had company names from the research spreadsheet. Found in real HTML the user shared, "
    "not guessed: navigating to https://www.linkedin.com/search/results/all/?keywords=<name> (a plain, "
    "hand-built URL - no autocomplete interaction needed) shows a “hero card” for the best-matching "
    "single entity, and that card's own “X connections/alumni work here” link always encodes "
    "currentCompany=[“<id>”] - reliably the first such occurrence anywhere on the page, appearing in the "
    "hero card and its own job-listing sub-cards well before any unrelated “People also viewed” sidebar "
    "company shows up later in the markup. Cross-confirmed twice: Swiss Re's hero card gave 3845 this way, "
    "exactly matching the heroEntityKey LinkedIn's own search-suggestion dropdown had already produced for "
    "the same company earlier in the investigation.",
    "New “Resolve LinkedIn Company IDs…” button (Settings, next to Target Accounts) looks up each Target "
    "Account company still missing an ID this way (company-resolve-extraction.js/"
    "company-resolve-content-script.js, matching linkedin.com/search/results/all/*, gated the same way as "
    "the other extraction content scripts, same visiting/pacing/timeout shape). A resolution only counts "
    "if the hero card's own displayed name loosely matches the company being searched for (tolerating "
    "legal-suffix differences like “Ltd”/“AG”) - a mismatch or missing link is left "
    "unresolved, not guessed, and gets picked up again on a future run. Resolved IDs are written onto that "
    "company's Target Account record (linkedinCompanyId, applyResolvedCompanyIds, storage.js) - each "
    "company is only ever looked up once.",
    "Fixed in v0.29.28: reported directly after a full day-long run resolved only 28 of 486 companies "
    "(434 “failed due to an error”). Diagnosed from the run's own debugSamples: most failures "
    "weren't timeouts at all - a real currentCompany= ID was found on the page, but the hero-card name "
    "came back null, so the resolution was correctly rejected rather than guessed, just never counted as a "
    "success. Root cause, confirmed live with real examples (“3M Switzerland,” “AbbVie "
    "Switzerland”): the Target Accounts sheet marks which subsidiary was researched by appending a "
    "country qualifier to the company name, but LinkedIn's own company page is just the global brand "
    "(“3M,” not “3M Switzerland”) - searching the qualified name never produces the "
    "confident hero card the resolver depends on (confirmed two ways: LinkedIn's own Companies search tab "
    "returned a literal “No results found” for “3M Switzerland,” while “3M” "
    "alone produced a clean hero card immediately). Fixed by stripping a trailing country qualifier "
    "(Switzerland/Schweiz/Suisse/Svizzera) from the company name before searching "
    "(stripCountryQualifier) - the resolved ID still gets written back onto the original, unqualified "
    "Target Account entry. Doesn't help a genuine timeout (e.g. “Aargauische Kantonalbank,” a "
    "real Swiss-native name with no qualifier to strip) - a separate, smaller category not yet addressed.",
    "Fixed in v0.29.31: reported directly with a 20-company test run after the v0.29.28 fix - 9 resolved, "
    "6 hard-timed-out with the exact same empty-info pattern as before (navCompleted: true, nothing else), "
    "confirmed reproducible across three unrelated real company names, none sharing the country-qualifier "
    "issue already fixed. That pattern (a real timeout with zero information) means the content script "
    "itself never reached its own sendMessage call - the only way that happens is an uncaught exception "
    "somewhere in its polling/extraction logic silently killing it before it could report anything, "
    "previously costing the full 15-second orchestration timeout to even notice. Wrapped the polling loop "
    "in a try/catch that still sends a real result immediately if something throws, with the actual error "
    "message attached (debug.caughtError) - converts a mystery 15-second hang into an instant, informative "
    "failure. Doesn't fix the underlying cause yet, but the next run's debugSamples should finally show "
    "what it actually is.",
    "“Limit to N” option (v0.29.29) - reported directly: iterating on a fix by re-running against the "
    "full list each time isn't productive when a run can take hours. An optional number field next to the "
    "button caps a run to the first N still-unresolved companies, so a fix can be validated in a couple of "
    "minutes before committing to a full run. Blank (the default) still resolves everything.",
    "Fixed in v0.29.32: reported directly (“Done - 4 of 20 resolved, 6 failed due to an error... "
    "what about the remaining 10?”) - the completion message only ever accounted for resolved and "
    "hard-timed-out counts, silently omitting a real third outcome: the content script responded fine and "
    "quickly, but couldn't confidently confirm a match (no hero card, or the hero name didn't match well "
    "enough), correctly declining to guess but invisible in the summary. runCompanyIdResolution now also "
    "returns notConfidentCount, and the completion message/Activity Log entry account for all three "
    "outcomes so every company in a run is explained.",
    "Resolved-ID progress indicator (v0.29.32) - reported directly: since a run happens in small chunks "
    "over many sessions (“Limit to N,” above), there was no way to see overall progress toward "
    "all 500 without re-checking the Activity Log after every single run. The Target Accounts Explorer "
    "page (6.12) now shows “LinkedIn company IDs resolved: X of Y,” updating live if a resolver "
    "run happens while the page stays open.",
    "Tried in v0.29.33 (not a confirmed fix): reported directly with strong repeat evidence - after "
    "confirming the v0.29.31 error-catching fix was actually loaded (reloaded the extension, re-ran), the "
    "exact same three companies still hard-timed-out with zero diagnostic info, no caughtError ever "
    "appearing - ruling out an uncaught exception entirely. Since these never resolve, they never leave the "
    "“still missing” pool and land back at the front of every future run's queue, pointing at a "
    "cold-start problem with the freshly-created background tab rather than anything about those specific "
    "companies: the very first navigation right after chrome.tabs.create may not reliably get the content "
    "script running before the orchestration's 15-second timeout gives up, while every later navigation in "
    "the same run works fine once the tab is “warmed up.” Added a throwaway warm-up navigation "
    "(to linkedin.com/feed/) before the real per-company loop starts, so the first real lookup is never "
    "also the tab's first navigation ever - not yet confirmed whether this actually resolves the same "
    "three companies.",
    "Tried in v0.29.34, not the real fix: the v0.29.33 warm-up run surfaced two further, distinct patterns "
    "once the previous hard-timeouts cleared. For “Aargauische Kantonalbank” (a real ID found, but heroName "
    "null): confirmed against the real hero-card HTML the user shared that the name and the ID-carrying “X "
    "connections/alumni work here” link both sit nested inside the SAME company-page anchor - LinkedIn builds "
    "its DOM via direct element creation rather than HTML parsing, so a nested link here is real, not a "
    "parsing artifact. The old code searched for the name and the ID independently, each its own page-wide "
    "first-match lookup, with no guarantee both came from the same entity; the ID lookup was scoped to the "
    "confirmed hero anchor's own subtree instead of the whole page (kept - a genuine improvement, just not "
    "the one that mattered here). For “Acino” (a confident name, but no ID anywhere on the search page): "
    "confirmed against the real HTML of Acino's own LinkedIn page that a company's own page carries a "
    "currentCompany link too, under the org-top-card's “X employees” link (though that one can list several "
    "ids in one array, unlike the hero card's single-id array). When the search page yields a confident name "
    "but no ID, the content script reports the hero's own company-page URL back to the orchestrator, which "
    "navigates there as a second step and reads the first id off that page's own link - a genuine second "
    "content script registration for linkedin.com/company/*, gated inert-during-normal-browsing the same way "
    "as every other extraction content script. A follow-up test still resolved 0 of 10, though - “Aargauische "
    "Kantonalbank” (the exact company used to confirm the anchor nesting) came back with both name and ID "
    "null, a different symptom than either pattern this fix targeted.",
    "Fixed in v0.29.34: the real root cause, confirmed via a user-shared screenshot, not guessed - the "
    "resolver had always searched LinkedIn's “All” tab (results/all/) on the premise that it reliably "
    "renders a single-entity “hero card.” That premise doesn't hold: the “All” tab leads with whatever "
    "category ranks first, often Posts, and any company merely MENTIONED inside a post's body text matches "
    "a[href*=\"linkedin.com/company/\"] just as well as a genuine top match would. Confirmed concretely: the "
    "top hit for “Aargauische Kantonalbank” was a Digiterra post whose text read “...customer story with "
    "Aargauische Kantonalbank (AKB),” - that mention's own link is what kept getting picked up, consistently, "
    "run after run, regardless of the anchor-scoping fix above. Fixed by switching the search target to "
    "LinkedIn's Companies-only tab (results/companies/?keywords=<name>), confirmed live to show ONLY company "
    "results with no Posts/People/Jobs noise. Its result card turned out to be the exact same DOM shape as "
    "the original “hero card,” so none of the extraction logic itself needed to change - only the search URL "
    "and the matching manifest content-script registration. Confirmed working: a follow-up 10-company test "
    "run resolved 4 (up from 0 on every prior “All”-tab run), with the one non-timeout failure being a clean, "
    "correct “no result,” not a wrong match.",
    "A separate, still-open issue: hard timeouts - unrelated to the tab fix above - remain the dominant "
    "failure mode (5 of 10 in that same test run), affecting different companies each time and now including "
    "a case where the company-page fallback navigation itself timed out. Given how many resolver runs have "
    "been fired against LinkedIn in one session while debugging this, throttling/rate-limiting on LinkedIn's "
    "side is a real possibility worth ruling out before writing more extraction code against what might just "
    "be slow or degraded responses - not yet investigated.",
    "Fixed in v0.29.35 - a real listener race, found via evidence: three previous fix attempts at this exact "
    "symptom (v0.29.31's try/catch, v0.29.33's warm-up navigation, and this Companies-tab switch itself) had "
    "all left it unexplained. Added finalUrl (the tab's own URL at the moment chrome.tabs.onUpdated reports "
    "“complete,” read straight off the listener callback's own tab argument) to test whether the tab was "
    "landing on the intended page at all before guessing further. A follow-up 10-company run showed finalUrl "
    "exactly matching the intended URL for 4 of 5 hard timeouts - the tab genuinely landed on the right "
    "page, “complete” fired correctly, and the content script's message still never arrived. The real bug: "
    "waitForResolveResult (the message listener) was only ever registered AFTER navigateAndWaitResolve "
    "resolved - i.e. only after the tab's “complete” event, which reflects the full page load including "
    "subresources. But a document_idle content script typically runs around DOMContentLoaded, which on a "
    "JS-heavy SPA like LinkedIn usually fires BEFORE “complete” - so the content script could find its "
    "result and call sendMessage before this file's own listener was even registered, and that message was "
    "simply lost, with no error anywhere. Fixed by calling waitForResolveResult before starting navigation "
    "(for both the main search and the company-page fallback), so its listener is live for the entire "
    "navigation instead of only after; RESOLVE_TIMEOUT_MS bumped accordingly (derived from NAV_TIMEOUT_MS "
    "plus a buffer, not picked arbitrarily) so slower-loading pages don't lose extraction time to the "
    "earlier registration. A fifth case (“Arbonia”) showed a genuinely different failure - the company-page "
    "fallback navigation itself never completed within 20s - not addressed by this fix. Confirmed working: "
    "a follow-up 5-company run resolved 3, with zero hard timeouts for the first time in this entire "
    "investigation - the other 2 came back as clean, correctly-diagnosed “no confident match” rather than "
    "silent failures. The company-page fallback path (Arbonia's failure mode) wasn't exercised in that run, "
    "so that specific case remains unconfirmed either way. Reported directly with a screenshot: "
    "“Accelleron Industries” genuinely has “No results found” on LinkedIn's own Companies tab - its “no "
    "confident match” wasn't a bug, just an accurate reflection that this company isn't on LinkedIn at all, "
    "and it'll correctly keep finding nothing on every future run by design.",
    "Fixed in v0.29.36: with hard timeouts gone, a follow-up 10-company run still had 8 “no confident "
    "matches.” Two were confirmed genuine (see above), but the rest included real, large, listed Swiss "
    "companies (“ARYZTA AG,” “Ascom Holding,” “Avolta AG”) unlikely to have zero LinkedIn presence - worth "
    "checking rather than assuming. Confirmed live, not guessed: searching “ARYZTA AG” (the Target Accounts "
    "sheet's full legal name) gets no confident match, but “ARYZTA” alone finds the real, verified company "
    "page immediately; “Ascom” alone likewise finds the real company where “Ascom Holding” didn't. The exact "
    "same underlying problem as the country-qualifier fix (v0.29.28, “3M Switzerland” vs “3M”) - just not "
    "limited to country words, and stripCountryQualifier never handled anything else. Rather than "
    "hand-picking new suffix words, reused storage.js's own COMPANY_SUFFIX_NOISE_WORDS set (AG, GmbH, "
    "Holding, Group, Switzerland, etc.) - already used elsewhere for the exact same class of problem "
    "(Negative Topic company matching, 6.9) - now exported and imported into company-resolve-extraction.js "
    "so the two lists can't drift apart. stripCountryQualifier replaced with stripTrailingCorporateNoise, "
    "which strips every trailing noise word one at a time (a company can carry more than one, e.g. “X "
    "Holding AG”) rather than just a single country suffix. Confirmed working: a follow-up 9-company run "
    "resolved 5 (up from 2 of 10 before this fix), still with zero hard timeouts. The remaining 4 “no "
    "confident matches” included the two already-confirmed genuine non-matches plus two new, not-yet-checked "
    "ones (“Balgrist University Hospital,” “Bank Syz”) - no wrong matches reported, namesMatch doing its job "
    "even with the broader stripped query.",
    "A known, deliberately unfixed limitation, registered rather than auto-fixed: “Balgrist University "
    "Hospital” checked live - the real LinkedIn entity is named in German (“Universitätsklinik Balgrist”), "
    "not just the English name plus a suffix. Searching “Balgrist” alone returns 7 different companies "
    "(“Balgrist Campus AG,” “Balgrist Tec AG,” “Balgrist Apotheke,” etc.), with the correct one ranking "
    "first only because it's clearly the largest/most-verified entity - not something namesMatch actually "
    "confirmed. Generalizing the strip-list to drop words like “University”/“Hospital” the way AG/Holding "
    "get dropped would risk real false positives elsewhere (those words can carry genuine distinguishing "
    "meaning, unlike pure corporate-boilerplate suffixes) - deliberately not attempted. Left as a "
    "correctly-unresolved, narrow edge case; a future fix idea (not yet built) is searching both the "
    "English and a German/local-language form of a name rather than broadening what gets stripped.",
    "Another distinct pattern found (not auto-fixed): a 20-company batch resolved 8 of 20, and 3 of the “no "
    "confident matches” (Banque Cantonale de Genève, Banque Cantonale Neuchâteloise, Becton "
    "Dickinson Switzerland) actually found the right hero card and a real currentCompany ID (heroLinkFound: "
    "true) - namesMatch correctly declined to accept “BCGE”/“BCN”/“BD” as a match, since LinkedIn displays "
    "these companies under an abbreviation with no reliable, deterministic derivation from the full name "
    "(confirmed live: Swiss cantonal bank abbreviations don't even follow one consistent rule - “BCGE” uses "
    "the canton-code style, “BCN” doesn't). Deliberately not auto-matched: a loose acronym heuristic risks "
    "the opposite failure - accepting a WRONG company elsewhere in the list, worse than today's safe "
    "non-match.",
    "Added in v0.29.37 - a Zefix-verified official name, tried first when present: separately, the user had "
    "ChatGPT cross-check all 500 Target Accounts companies against Zefix (the Swiss commercial registry) by "
    "UID and address, producing a Zefix_Official_Name workbook column (493 of 500 matched; the 7 unmatched "
    "needed genuine human judgment ChatGPT declined to guess at). Checked live against companies already "
    "known to have resolver issues: fixes “APG|SGA” (officialName “APG SGA SA” drops the literal | "
    "LinkedIn's search chokes on) and “Bank Syz” (officialName “Banque Syz SA” - the correct French "
    "spelling, matching what the user found manually on LinkedIn as “Banque SYZ & CO”). Does NOT fix the "
    "BCGE/BCN/BD acronym cases above (official names are unchanged or trivially different) or Balgrist "
    "(officialName “Schweizerischer Verein Balgrist” is a real but different legal entity - still not what "
    "LinkedIn's own page is named). parseFullTargetAccountsWorkbook (xlsx-lite.js) already keeps every "
    "workbook column camelCased, so Zefix_Official_Name arrives as zefixOfficialName with no parser changes "
    "needed; Settings' import carries it into each Target Account record as officialName (storage.js), "
    "refreshed on every import like the rest of the workbook's own data - unlike the durable "
    "linkedinCompanyId that gets carried forward across a re-import instead. runCompanyIdResolution now "
    "builds a candidate list per company - the stripped officialName first (when present and actually "
    "different after stripping), then the stripped research name - and tries each in turn until one "
    "resolves; the existing corporate-suffix stripping (v0.29.36) applies to both equally, since an "
    "official Zefix legal name carries its own “AG”/“SA”/“Holding” just as often as the research name does. "
    "debugSamples now records every name actually tried (triedNames).",
    "First test run's numbers didn't add up: a 20-company run (2 names tried per company, roughly doubling "
    "request volume) came back with hardTimeoutCount: 9 - a real jump from the 0 seen consistently since "
    "the v0.29.35 listener-race fix, including on the exact same fully-diagnosed “tab landed on the right "
    "page, message never arrived” signature that fix targeted. A follow-up 3-company run on the same code "
    "came back clean (hardTimeoutCount: 0), which at first suggested cumulative daily volume (this was "
    "roughly the 10th+ resolver run against LinkedIn in one session) - but reported directly, that theory "
    "doesn't survive a real fact: there was a 9-hour gap with zero resolver activity right before these two "
    "runs, which should have cleared any daily-cumulative throttling entirely.",
    "Reverted (not a code regression, but not fully explained either): checked directly whether the "
    "two-candidate loop was missing a pacing delay between the first and second name attempt - it wasn't; "
    "if (c > 0) await sleep(randomDelay()) already used the exact same 4-9s delay as between companies. "
    "Reported directly, and correct: every run before today used exactly one search per company - the "
    "two-name fallback was the one thing that changed request volume per company in a 20-company run, so "
    "it's reverted to isolate that variable and make future runs directly comparable to every one before "
    "it, whatever the real underlying cause turns out to be (a shorter in-session burst threshold rather "
    "than daily-cumulative volume remains the leading theory, not yet confirmed). Only the research name is "
    "used as a fallback now, and only when a company has no officialName at all (7 of 500, per the Zefix "
    "cross-check) - not as a second attempt after the official name fails. Consequence: whether “APG|SGA” "
    "and “Bank Syz” actually resolve with their official name is still unconfirmed either way, since the "
    "only run that tried both names for them was the same suspect 20-company run.",
    "Queue prioritization fixed (v0.29.39) - reported directly: with no distinction between “never "
    "attempted” and “tried and failed,” and a run always drawing from the front of the same list in the "
    "same order, a handful of genuinely stubborn companies kept consuming the whole budget of every run "
    "before ever reaching a fresh company further down the list. Added linkedinResolveAttemptedAt "
    "(storage.js), set on every company a run actually attempts (success or failure) via a new "
    "markLinkedinResolveAttempted - carried forward across a workbook re-import the same way "
    "linkedinCompanyId already is. getTargetAccountsMissingLinkedinId now sorts never-attempted companies "
    "first, so a run makes real forward progress through the full list before ever revisiting a "
    "known-stubborn one - once every company has been attempted at least once, this naturally falls through "
    "to offering the stubborn remainder for retry/analysis, oldest-attempt-first.",
    "A real bug found while testing this: “APG|SGA” resolved a genuine, correct hero card and ID "
    "(11414625, heroName “APG|SGA AG”) but was still rejected. Cause: the search term had already replaced "
    "the literal | with a space to avoid breaking LinkedIn's own search, but the hero card's real displayed "
    "name still has the | - “apg sga” (space) and “apg|sga ag” (pipe) are different literal strings to a "
    "plain substring check, even though they're obviously the same company. namesMatch "
    "(company-resolve-content-script.js) now normalizes pure separator punctuation (|, &, comma, period, "
    "hyphen) to whitespace before comparing - not an acronym/fuzzy matcher, and deliberately doesn't touch "
    "the BCGE/BCN/BD cases (a genuine abbreviation with no shared substring at all, punctuation or not), "
    "which stay correctly unmatched for a different reason.",
    "Confirmed working (v0.29.39 queue fix): the first run after shipping only resolved 1 of 10, which read "
    "like a regression - reported directly, and correct: every company's attemptedAt started at null "
    "together, so that run's ordering was still effectively arbitrary, not evidence the fix failed. The very "
    "next 20-company run resolved 8 of 20 (40%), and surfaced “Bergbahnen Engelberg-Trübsee-Titlis,” a "
    "company never seen in any prior debug sample - real forward progress into fresh companies, as intended.",
    "A second accent bug found in that same 20-company run, fixed in v0.29.40: “Dätwyler” got a real, "
    "correct hero card (heroName “Datwyler Group”) but was rejected - namesMatch lowercases before comparing "
    "but never strips accents, so “dätwyler” and “datwyler group” are different literal strings. Fixed with a "
    "foldDiacritics helper (Unicode NFD decomposition, then stripping the resulting combining marks) applied "
    "before the existing punctuation fold. The same gap existed in stripTrailingCorporateNoise "
    "(company-resolve-extraction.js): “Edwards Lifesciences Sàrl” kept its trailing legal suffix in the "
    "search query because “sàrl” never matched the noise-word set's plain “sarl” entry - same fold applied "
    "to that comparison only, the search term itself keeps its original accents.",
    "Confirmed working (v0.29.40 accent fold): the very next run (10 companies) resolved 7 of 10 (70%), "
    "with hardTimeoutCount: 0 for the third consecutive run since the two-name-loop revert (v0.29.38) - "
    "40 companies total now with zero hard timeouts on the single-name-only code.",
    "A third punctuation bug found in that same run, fixed in v0.29.41: “Fresenius Kabi Switzerland” got a "
    "real, correct hero card and ID (65191466, heroName “Fresenius Kabi Schweiz”) but was rejected - search "
    "term “Fresenius Kabi (Schweiz)” has a literal ( sitting where a space needs to be, and "
    "normalizeForNameMatch didn't treat ( / ) as separator punctuation the way it already did |, &, comma, "
    "period, and hyphen. Same gap in stripTrailingCorporateNoise: “Ford Switzerland”'s official name "
    "“Ford Motor Company (Switzerland)” never got its trailing qualifier stripped the way “ARYZTA AG” did, "
    "because “(switzerland)” - parens still attached - never matched the noise-word set's plain "
    "“switzerland” entry. storage.js's own normalizeCompanyForMatch already treated () this way for the "
    "same reason elsewhere in the codebase - this resolver code just hadn't caught up yet. "
    "“Fundamenta Real Estate AG” correctly declined a match against “Fundamental Real "
    "Estate Investment Partners” in the same run - a genuinely different company with a similar name, not "
    "a bug.",
    "Open, unconfirmed: an earlier run also saw heroLinkFound: false (no hero card at all) for five companies "
    "searched by their Zefix official name - Chocoladefabriken Lindt & Sprüngli, Cicor Technologies, "
    "Compagnie Financière Richemont, Compagnie Financière Tradition, Dottikon ES. Lindt is consistent with "
    "the Balgrist pattern (the Zefix legal name is more formal than the brand LinkedIn actually uses), but "
    "this hasn't been checked against LinkedIn's real search results yet - flagged rather than guessed at. "
    "Separately, “DSV Air & Sea Switzerland” correctly declined a match (hero card was DSV's global parent "
    "page, not the Swiss entity) - working as intended, not a bug.",
    "Confirmed working, all of it: the full 500-company list was run to completion (416 of 500 resolved, "
    "83.2%). Cross-checked against the final unresolved list - APG|SGA, Dätwyler, Edwards Lifesciences, "
    "Fresenius Kabi Switzerland, and Ford Switzerland (the specific companies each fix above was built for) "
    "are all absent from it, confirming the punctuation, accent, and parentheses fixes, and the queue-"
    "prioritization fix, all actually worked. The 84 that remained split into real, distinct buckets, "
    "diagnosed by tracing each officialName through the actual code (not guessed): a repeat-offender "
    "company-page-fallback bug (6+ companies - Bank Syz, Basellandschaftliche Kantonalbank, Geneva Airport, "
    "SWICA, Swiss Mobiliar, Takeda - all correctly reach the right company page but extract no id there, "
    "still undiagnosed for lack of a live LinkedIn session to inspect it with); verbose full legal/branch-"
    "registration names with the real brand buried mid-string (Gaznat, Skyguide, STMicroelectronics, "
    "Trafigura, Versigent, Pax, Securitas Group) that no safe trailing-word stripping can ever reach; "
    "cross-language names (Swiss Post's German officialName vs. its English LinkedIn brand); the already-"
    "known, deliberately-unfixed acronym cases (BCGE, BCN, “BD”); and a trailing place-of-registration name "
    "(“OC Oerlikon Corporation AG, Pfäffikon”) that blocks stripTrailingCorporateNoise from ever reaching "
    "the AG before it, since the stripper only ever looks at the very last word.",
    "Resolver architecture changed to a direct-link primary path (v0.29.42) - a follow-up external "
    "cross-check (the same one behind officialName, done outside the extension) added two more workbook "
    "columns: Alternative Company Name (a commonly-used short/acronym form - solving the cantonal-bank "
    "acronym cases above without any risky automated guessing, since a human/AI already did the actual "
    "disambiguation) and LinkedIn Link (a validated LinkedIn company-page URL - 499 of 500 companies, "
    "including catching real-world cases no on-site search could ever get right, like a hospital whose old "
    "LinkedIn page now redirects as deprecated after a rename). Reported directly, and agreed: since that "
    "URL is already known-correct, navigating straight to it and reading the id off the page sidesteps "
    "essentially every failure mode above - verbose legal names, translated names, LinkedIn's own search "
    "ranking returning a related-but-wrong company - none of which are name-matching problems once the "
    "destination is already known. company-resolve-extraction.js's resolveViaDirectLink is now the primary "
    "path for any company with a linkedinLink; the existing search-based path (resolveOneName) is kept "
    "as-is, used only as a fallback for the rare company with none. company-resolve-content-script.js's new "
    "runDirectLinkResolve still does its own sanity check - the page's own title (parsed via "
    "extractCompanyPageTitleName, a pattern confirmed against every debug sample collected across this "
    "whole feature's development) against every name known for the company (company/officialName/"
    "alternativeName) - before trusting the id, since a supplied link has never been confirmed against a "
    "hero card the way the search-based path's has. The company-page-"
    "fallback bug above becomes the single highest-value remaining fix under this design, since it's now "
    "the one thing standing between a validated link and a resolved id for the majority of the list.",
    "A wrong link found live, and a broader re-audit that followed (v0.29.42) - a 10-company test run "
    "flagged three “no confident match” results despite a validated link; live-checking one directly "
    "(SWICA) found the supplied link pointed to an unrelated Welsh carnival-arts organization that happens "
    "to share the exact name - a same-name collision no name-based sanity check can catch, since the wrong "
    "page's own name matches just as well as the right one's would. Reported back to the external "
    "cross-check with this concrete example; it re-screened all 500 for the same risk (223 flagged as "
    "short/generic/ambiguous enough to warrant a manual identity check - industry + Swiss location/parent "
    "relationship, not just a name match) and found five more genuine wrong links this way (Ypsomed, "
    "Avolta AG, Emmi AG, Swiss Life, Belimed - each pointing to an unrelated same/similar-named company) "
    "plus one it caught independently (CSL Behring's previously-valid link had gone 404 since first "
    "validated; corrected to the current parent CSL corporate page, which explicitly lists CSL Behring as "
    "one of its businesses). Live-verified directly, not taken on faith: BLKB, Swiss Life Group, and CSL "
    "all confirmed to be the real, correct pages.",
    "The Alternative Company Name gap that caused those three “no confident match” results, closed "
    "(v0.29.42) - reported directly: the three declines (BCN, Balgrist, Bank Syz) all had a validated, "
    "correct link, but Alternative Company Name was blank for all three, leaving the sanity check nothing "
    "to compare the real LinkedIn page name against beyond the research/official name, neither of which "
    "shares any words with an acronym like “BCN” or a rename like “Universitätsklinik Balgrist.” Fixed at "
    "the source, not in code: since the external cross-check already visits and validates every page, it "
    "was asked to also write back each page's actual displayed name into that column whenever it differs "
    "- 406 previously-blank cells filled, 13 replaced for not exactly matching the validated page, 419 "
    "changed in total.",
    "A second real bug found and fixed, from a 25-company run (v0.29.43): the direct-link path hard-timed "
    "out on 15 of 25 companies - reported directly, and the theory tested live rather than guessed: "
    "manually navigating to one of the exact same failing URLs, in an active tab, loaded the real page "
    "fully in ~3 seconds, ruling out LinkedIn-side slowness or blocking outright. The one thing that had "
    "never changed: the resolver's tab is created backgrounded (active: false) and stays that way for the "
    "whole run. The old search-based path almost exclusively hit lightweight search-results pages and "
    "never showed this problem across 60+ companies; the new direct-link path exclusively hits full "
    "company pages - heavier pages Chrome's background-tab throttling can apparently stall badly enough "
    "that the content script never gets far enough to send a message at all within the 28s window (the "
    "debug data backs this up: not merely a slow “complete” event, but zero message ever received). "
    "runCompanyIdResolution's tab is now created active, and navigateAndWaitResolve re-asserts "
    "active: true on every navigation (not just at creation, since Chrome's throttling cares about a "
    "tab's current focus, not how it started) - the tradeoff being a visible tab jumping between company "
    "pages during a run instead of working invisibly in the background. Confirmed working: the next run "
    "after shipping resolved 10 of 10 companies with zero hard timeouts.",
    "A “Stop” button (v0.29.45) - added alongside the scan's own Stop Scan button (6.17) for the "
    "same reason: a long-running resolve batch had no way to stop early short of closing Settings entirely. "
    "runCompanyIdResolution now takes a shouldAbort callback, checked before starting each new company (not "
    "mid-attempt - one company's own resolution is only a few seconds, a fine granularity to let finish "
    "rather than interrupt). Returns a new attemptedKeys list alongside its existing results/debugSamples - "
    "distinct from the full requested batch once a run can end early, and used instead of it for "
    "markLinkedinResolveAttempted: marking a company that was never actually reached this run as "
    "“attempted” would have wrongly deprioritized it the next time this same queue is built "
    "(getTargetAccountsMissingLinkedinId). The completion message states how many of the "
    "originally-requested batch were never attempted when the run was stopped early.",
    "This is a prerequisite, not the finished feature - the actual company-scoped Post search (chunking "
    "resolved IDs into authorCompany batches, merging keywords across every enabled Topic into one search "
    "per chunk so total search count stays roughly constant regardless of how many Topics exist, then "
    "classifying each returned post against every Topic's own keyword/AND rules locally via the existing "
    "fullTopicMatchedKeywords, exactly as already described in 6.15) is separate work - now built, see 6.17.",
])

doc.add_heading("6.17 Target Account-scoped Post search (v0.29.26, experimental)", level=3)
doc.add_paragraph(
    "Completes the plan from 6.15 (diagnosis) and 6.16 (the company-ID resolver): every scan now also "
    "searches Posts scoped to resolved Target Account companies via authorCompany, instead of relying "
    "purely on each Topic's own unscoped global keyword search - the actual root-cause fix for the "
    "Post-vs-Job imbalance, not just a comparison tool."
)
add_bullets(doc, [
    "One search per company-chunk, not per Topic - every enabled Topic's keywords (both groups) are "
    "merged into one deduplicated list first (mergedTopicKeywords, background.js), chunked at the existing "
    "MAX_OR_TERMS (6). Resolved company IDs are chunked at AUTHOR_COMPANY_CHUNK_SIZE - this keeps the "
    "phase's total search count dependent on keyword/company volume, not on how many Topics exist - a "
    "dedicated search per Topic per company-chunk would have multiplied instead of added. Raised from 50 "
    "to 100 (v0.29.44): reported directly, once 499 of 500 Target Account companies were resolved (6.16), "
    "this phase alone pushed a scan from 24 total searches to 134 - “way too much, will take forever,” and "
    "the math backed that up (110 extra searches ≈ 20-25 minutes added, at this file's own 3-8s pacing). "
    "Tested live rather than guessed: 100 real ids in one search read an exact “99” on the filter chip (a "
    "real LinkedIn-side dedup of one duplicate id shared by two different companies, not a bug) - a precise "
    "count proving LinkedIn parsed and applied the full array. 200 was inconclusive: LinkedIn's own chip UI "
    "stops giving an exact count past 99 (“99+,” the same convention as “500+” connections), so there's no "
    "way to tell from the UI alone whether the backend genuinely filtered on all 200 or silently capped "
    "around 99 - not guessed at either way. 100 is the highest chunk size with real, verifiable evidence "
    "behind it; halves the company-chunk count (10 -> 5) and roughly halves this phase's added time "
    "accordingly.",
    "Local classification, not a trusted query result - a post found this way didn't come from any single "
    "Topic's own dedicated search, so it can't be assumed to satisfy any particular Topic's rule. Each one "
    "is checked directly against every enabled Topic's full rule via localTopicMatch (background.js): any "
    "keyword match for a plain OR-topic, or at least one keyword from both groups for an AND-topic. This is "
    "a genuine text-based double-check - more rigorous, in fact, than the existing two-separate-searches-"
    "then-join approach the rest of this file uses for AND-topics, which only ever trusts that both "
    "searches happened to surface the same post, never confirming its text actually contains both kinds of "
    "terms.",
    "Reuses the same scraping pipeline as every other search (content-script.js's run(), gated on "
    "currentScanTopicId) with a synthetic per-chunk ID (target-account-search-<n>) so waitForScrapeResult "
    "can match it - no changes needed to the content script itself.",
    "Only activates once at least one Target Account company has a resolved LinkedIn ID (6.16) - nothing "
    "changes for an install that hasn't run that resolver yet. Folded into the scan's single unified "
    "progress counter (totalSubQueries), labeled “Target Account companies” in the side panel, "
    "same as Job Topics already get their own label within the same counter.",
    "A “Stop Scan” button, added once this phase could push a scan into the hundreds of searches "
    "(v0.29.45) - reported directly, once 499 of 500 Target Account companies were resolved, this phase "
    "alone pushed one scan from 24 total searches to 134 (“way too much, will take forever,” 6.17's own "
    "chunk-size note above), and there was previously no way to stop a long scan short of force-closing "
    "the extension. A new scanAbortRequested storage flag, set by the side panel's Stop Scan button (shown "
    "only while a scan is running), is checked by a new checkAbort() at the exact same per-sub-query "
    "checkpoint every one of this file's loops already has (Post topics, Job topics, and this Target "
    "Account phase) - so the worst-case delay between clicking Stop and the scan actually stopping is one "
    "in-flight search, not the rest of the run. Whatever was found before stopping is already saved (this "
    "file's existing per-topic checkpoint saves, plus a final save in the same catch path a genuine error "
    "already went through) and reported back with its own distinct “Scan stopped by you” message - not "
    "logged as an error, since it's a deliberate action, not a failure. Same “starts over from the first "
    "topic next time” caveat as a genuine error, for the same reason (no per-topic resume point exists "
    "either way).",
    "System sleep held off for the duration of a scan (v0.29.46) - reported directly: a scan left running "
    "unattended while the machine went to sleep came back hours later only a handful of steps further in - "
    "all JS timers simply freeze during system sleep, so wall-clock time away doesn't reflect real scan "
    "progress (confirmed: the counter resumed advancing at its normal pace the moment the machine woke back "
    "up, with no error, matching a paused-not-stuck explanation rather than a genuine hang). scanAllTopics "
    "(background.js) now calls chrome.power.requestKeepAwake(\"system\") right before its main try and "
    "chrome.power.releaseKeepAwake() in the finally (new \"power\" permission, manifest.json) - blocks "
    "system sleep only, the screen can still turn off. The same pattern was added to the other three "
    "long-running, multi-visit loops for the same reason: runProfileExtraction (profile-extraction.js), "
    "runCompanyIdResolution (company-resolve-extraction.js, 6.16), and runPeopleSearchComparison "
    "(people-search-extraction.js, 6.15).",
    "Real evidence this phase is working (v0.29.50) - reported directly, from a natural before/after in "
    "actual saved data: the Post:Job lead ratio was ~0.42:1 across two full snapshots taken before any "
    "Target Account company had a resolved LinkedIn ID (2026-09-06/07, this phase literally could not run "
    "yet - see its own resolvedCompanyIds.length > 0 gate above), versus ~0.86:1 once 499 of 500 were "
    "resolved (2026-09-10) - Job leads barely moved in that window while Post leads more than doubled, "
    "notable because this phase only ever touches Post search, never Job search. A same-day cross-reference "
    "(once both CSV exports below also carried a real Company column) found 41 of 65 new Post leads from "
    "one day's scan (63%) were authored by someone at a Target Account company - direct evidence, not "
    "inference, that this phase is driving new Post lead discovery rather than the ratio shift being "
    "incidental to other changes made in the same window.",
    "Both CSV exports gained a real Company column (v0.29.50) - the analysis above was blocked at first: "
    "the Dashboard's CSV export had no Company column for Post leads at all, and the side panel's own CSV "
    "export conflated “Headline / Company” into one ambiguous column that, for a Post lead, actually held "
    "the headline, not the company. dashboard.js's exportLeadsToCsv gained a leadCompany() helper and "
    "dedicated column; sidepanel.js's resultsToCsv split its old combined column into real “Headline” (Post "
    "leads only) and “Company” (both lead types) columns - both now match what the JSON leads backup "
    "already exposed cleanly.",
])

doc.add_heading("6.19 Target Accounts Dashboard, Account & Contact views (v0.29.53, experimental)", level=3)
doc.add_paragraph(
    "A deliberate rearchitecture, reported directly: with real Target Accounts (500 companies) and, now, "
    "real Target Contacts (83 externally-vetted decision-makers) imported, the externally-researched "
    "account/contact data is the salesperson's actual primary asset - scanned posts are an enhancement on "
    "top of it, not the starting point. The Target Accounts Explorer (6.12) evolves in place (same page, "
    "same filenames - no navigation change needed) from a flat, filterable company table into a hash-routed "
    "hub: a priority-sorted, flag-annotated main dashboard, plus a full Account view and Contact view per "
    "record, each with its own persisted Sales Mentor/Customer Voice conversation. The Post view is "
    "unchanged - dashboard.js's existing #lead=<key> detail view - both new views link out to it rather "
    "than duplicating it."
)
add_bullets(doc, [
    "Two real architectural conflicts, resolved deliberately, not by accident: (1) targetAccountsWorkbook "
    "(6.12) is wholesale-replaced on every re-import - chat history/due-dates stored on those rows would be "
    "wiped the next time the ChatGPT research refreshes. (2) “Overdue action” has no precedent anywhere in "
    "this codebase (confirmed: no dueDate/reminder/overdue field existed before this). Decided with the "
    "user before writing any code: account/contact data lives in separate storage (below), and overdue is "
    "a manual due-date field, not an automatic staleness heuristic.",
    "New storage, storage.js: targetAccountExtras (getTargetAccountExtra/saveTargetAccountExtra), keyed by "
    "normalizeCompanyName() - the same stable key targetAccounts/partitionLeadsByTargetAccount already use, "
    "so this data survives a workbook re-import untouched regardless of whether the workbook's own "
    "companyId churns. targetContactExtras (getTargetContactExtra/saveTargetContactExtra), keyed by "
    "contactKeyFor(company, fullName) - a composite of normalizeCompanyName plus a sorted, diacritic-folded "
    "word-set of the name (reusing the exact normalization authorMatchesContactName/findTargetContactMatch, "
    "6.11, already use for prioritization matching - a name that matches for scoring purposes resolves to "
    "the identical extras key). Each extra holds {mentorHistory, customerVoiceHistory, nextActionDueAt}.",
    "Activity Log gains two optional fields (relatedCompanyKey/relatedContactKey, appendActivityLog) - "
    "passed by callers that know the context (the new views' own actions, and, best-effort, dashboard.js's "
    "detail-view status-change handler). getActivityLogForCompany/getActivityLogForContact filter the "
    "existing flat log on these fields. No migration for entries predating this - consistent with this "
    "store's existing tolerance for schema growth (self-healing on read elsewhere), an account/contact's "
    "visible activity history genuinely only goes back to when this shipped.",
    "“Last communication” is derived, not stored - max(statusUpdatedAt) across leads matching the account/"
    "contact whose status is Contacted/Responded/Converted.",
    "findLeadsForContact(contact, leads) (storage.js) - the reverse of findTargetContactMatch (6.11): every "
    "Post lead by this specific contact, not just the first match, for the Contact view's post list.",
    "List view: the existing Companies table (COMPANY_COLUMNS, search/sort/column-hide/filter all "
    "unchanged), already defaulting to aiPriorityScore descending - satisfies “sorted by descending "
    "priority” with no change needed there. New leading “flag” column: hasUnreviewedPost(companyKey, leads) "
    "(any Post lead at that company still \"New\") or hasOverdueAction(extra) (nextActionDueAt in the "
    "past). Row click now navigates to #account=<companyKey> instead of the old in-place expandedCompanyId "
    "row-expand (removed - a rich detail page doesn't fit in an inline row).",
    "Account view (#account=<companyKey>): overview fields all already present on a companies row, no gaps "
    "except one - company, zefixOfficialName, alternativeCompanyName, linkedinLink, industry, "
    "zefixAddress, globalEmployees/swissEmployees, globalRevenue/swissRevenue, aiPriorityScore/aiPriority, "
    "evidenceCoverage (“AI Coverage”), companyType, aiInvestmentGlobal/aiInvestmentSwitzerland (“AI "
    "Budget”), topAiInitiatives. Gap, not a bug: no distinct “company website” column exists in the "
    "workbook - primarySourceUrl is labeled as the closest stand-in, not invented data; a future ChatGPT "
    "research ask, not a code fix. Reuses buildSubtable/buildDetailContent (6.12) for Contacts/AI "
    "Initiatives/Sources - buildSubtable gained an optional rowClick so a Contacts row now navigates to "
    "that person's Contact view instead of just displaying text. Plus: last-communication line, a follow-up "
    "due-date date input, and the Activity Log/chat sections below.",
    "Contact view (#contact=<contactKey>): fullName, jobTitle, function, seniority, aiRelevance, "
    "lastVerified2 (the real LinkedIn link, correctly labeled since the duplicate-header fix above). Post "
    "list via findLeadsForContact, each linking out to the unchanged Post view (dashboard.html#lead=<key>, "
    "opened via chrome.tabs.create - the same cross-page pattern every other link in this codebase already "
    "uses). Gap, not a bug: the Sources sheet only joins by companyId, not contactId - “web pages "
    "mentioning the contact” is, for now, just the contact's own single sourceUrl field; same "
    "future-research-ask flag as the website gap above. Due-date input, Activity Log, chat sections.",
    "Chat panels, both views - agent-shared.js gains four new prompt builders, modeled on "
    "buildLeadScopedMentorPrompt/buildAccountSummaryPrompt (6.4): buildAccountScopedMentorPrompt, "
    "buildAccountScopedCustomerVoicePrompt, buildContactScopedMentorPrompt, "
    "buildContactScopedCustomerVoicePrompt. The contact-scoped pair deliberately embeds the parent "
    "account's topAiInitiatives/aiPriority alongside the contact's own role, per an explicit requirement: "
    "a drafted message needs to be able to say “I read that you are doing a project to automate your "
    "customer support...” - the initiative context has to be in the prompt, not just the contact's title. "
    "No draft_message tool binding here (unlike the lead-scoped Mentor chat) - that tool needs a real "
    "scanned lead's key, which a Target Contact may not have one of at all if they haven't posted; the "
    "prompt instead points to that post's own page (where draft_message already works) when one exists. "
    "target-accounts.js gets its own copy of advisors.js's createAgentChat(...) factory (small duplicate, "
    "not a shared import - this codebase's established convention for separate extension pages with no "
    "shared nav module) instantiated four times, saveHistory wired to the new extras stores.",
    "Priority-scoring precedent this reuses, not reinvents: the underlying Contact-matching logic "
    "(authorMatchesContactName, credential-tolerant word-subset matching) and the targetAccountSignal/"
    "targetContactSignal feed into prioritizeLeads were already built (6.11) before this - this feature is "
    "UI and durable-storage layered on data that already flows into scoring today.",
    "Not yet confirmed live at ship time - the flag column, Account/Contact navigation, and all four chat "
    "panels have been built and manually traced against real imported data (two known contacts - Christian "
    "Sebregondi/Zürcher Kantonalbank, François Réf/Geberit - should both flag and open correctly) but not "
    "yet exercised in the browser at that point.",
    "Overview redesigned as one compact card (v0.29.54) - reported directly, with a reference screenshot: "
    "the overview should read as a single card across the page width, 3-5 fields per row, not a tall "
    "one-field-per-line list. buildOverviewCard (renamed from buildOverviewList) flows short fields into a "
    "responsive CSS auto-fill/minmax grid rather than a hardcoded column count - label lengths vary too "
    "much (“Type” vs. “Employees (Switzerland)”) for a fixed count to hold up at every width. A field "
    "marked long: true (paragraph text like “Top AI initiatives”) gets its own full-width row below the "
    "grid instead. “Last contact made” and “Follow-up due” moved into the same card as regular fields (a "
    "follow-up request - previously separate rows below it); the due-date input/Clear button live in the "
    "HTML as plain hidden elements outside the overview div specifically so dueDateFieldNode can un-hide "
    "and move them into a card field on every render rather than recreating them, keeping "
    "wireDueDateInput's event listeners attached to the same elements throughout. Truncated short values "
    "get a native title tooltip so nothing is silently lost to the compact layout.",
    "Contacts/AI Initiatives/Sources default to collapsed (v0.29.55) - reported directly: these sub-tables "
    "under the company header were pushing the Account view well past one screen, with the goal of fitting "
    "a standard browser window with minimal scrolling. buildSubtable now renders each section's heading as "
    "a clickable toggle (closed/open) with the body hidden by default - same content as before, just closed "
    "until asked for. Applies uniformly to Contacts, AI Initiatives, AI Investment, and Sources, since they "
    "all go through this one shared function.",
    "Contact view's Posts/Web mentions/Recent Activity, and the Account view's Recent Activity, also "
    "default to collapsed (v0.29.56) - same goal as the entry above, extended to the remaining list "
    "sections on both views. New wireCollapsibleHeader applies the same toggle to a static h3 heading "
    "instead of a rebuilt-every-render button (buildSubtable's own toggle) - wired once (idempotent, safe "
    "to call on every render) and reset to closed each time a different account/contact opens, so a "
    "section left open on one record doesn't stay open when navigating to the next.",
    "Mentor/Customer Voice chats side by side, wrapping to vertical when narrow (v0.29.57) - reported "
    "directly: prefer the two chats side by side (Mentor left, Voice right) in a normal-size window, "
    "switching to vertical automatically once the window gets narrow. Both views' chat sections share an "
    ".agent-chat-row flex container (flex-wrap: wrap, 24px gap); each .agent-chat-section gets flex: 1 1 "
    "360px, so the columns sit side by side whenever there's room for both plus the gap and the second "
    "wraps below the first once the window gets too narrow - no hardcoded breakpoint, the flex-basis plus "
    "gap is the threshold. View max-width widened 900px to 1200px so two real chat columns have actual "
    "room. Pure HTML/CSS re-wrap, no JS or element-ID changes.",
    "Fixed: a shared-mutable-default bug leaked one entity's chat into another's (v0.29.58) - reported "
    "directly with a precise repro: chatting with the Mentor inside a SIKA contact, then opening a "
    "never-before-seen Schindler Group account, showed SIKA's conversation there instead of an empty chat. "
    "getTargetAccountExtra/getTargetContactExtra used to return a single shared, module-level EMPTY_EXTRA "
    "object as the “no data yet” fallback for every key - Object.freeze only locks an object's own "
    "properties, not the arrays those properties point to, so every not-yet-saved entity got handed back "
    "the exact same mentorHistory/customerVoiceHistory array objects, and runAgentTurn's in-place push "
    "polluted that one shared array for every other not-yet-saved entity in the same page session. Fixed "
    "by replacing the constant with emptyExtra(), a plain function returning fresh objects/arrays on every "
    "call, used in both the read-fallback and the save-merge path on all four functions. Checked the rest "
    "of the codebase for the same pattern - the pre-existing global and per-lead chat stores already "
    "returned fresh [] literals per call, so this was specific to the new account/contact extras store. "
    "This confirms, rather than changes, the intended design: per-account, per-contact, and per-post (the "
    "existing lead-scoped Mentor chat) conversations are meant to stay fully separate, with the Advisors "
    "page's own chat staying separate too for generic/strategic questions with no specific account or "
    "contact in view.",
    "List-view pagination and a top horizontal scrollbar (v0.29.59) - reported directly: 500 companies "
    "with no pagination was too much to scroll through, and both the page-size/navigation controls and the "
    "horizontal scrollbar to see columns off to the right should be reachable at the top of the table, not "
    "just the bottom. New buildPaginationBar() - a page-size select (20/50/100) plus First/Previous/Next/"
    "Last buttons - is built twice (identical content, since duplicate ids aren't valid HTML) and dropped "
    "into a container above and below the table, both acting on the same shared pageSize/currentPage "
    "module state. Page size is persisted alongside the existing filter/sort state; every search, sort, or "
    "filter change resets to page 1 so a filter never strands the view on a now-empty later page. A thin "
    "scrollable strip (#table-scroll-top) sits above the table with a dummy filler matching the real "
    "table's scrollWidth, kept in sync with the table's own native horizontal scrollbar via a two-way "
    "scroll listener.",
    "Overview card fields click-to-expand (v0.29.60) - reported directly with a screenshot: a truncated "
    "field (e.g. “Team Head Digital Workpl...”) in the Account/Contact overview card should use the same "
    "click-to-expand/collapse behavior already used on the Posts Dashboard's own truncated cells "
    "(dashboard.js's contentCell/.content-cell) - click to see the full value, click again to collapse. "
    "buildField (target-accounts.js) takes an expandable flag - every plain-text field in the compact grid "
    "gets an .overview-value-expandable class and a click listener toggling .expanded, same pattern as "
    ".content-cell. Long fields (e.g. “Top AI initiatives”, already shown full-width with normal wrapping) "
    "deliberately don't get this - truncating them to one line first would fight the point of breaking "
    "them out to their own row. Wired the same way the Dashboard does it: always active, not just when a "
    "value happens to be actually truncated.",
    "Three parallel dashboards, pie-chart stats, and a Target Contacts Dashboard (v0.29.61) - reported "
    "directly, three linked requests. Naming: “Target Accounts Dashboard” / “Target Contacts Dashboard” / "
    "“Posts Dashboard” - fully descriptive, parallel names rather than an ambiguous “The Dashboard,” so the "
    "tab title and page heading always say which of the three is showing; file names unchanged, only "
    "display text. New renderGenericPieChart(containerEl, slices, {unitLabel, onSliceClick}) - the Posts "
    "Dashboard's own renderPieChart (dashboard.js) is hardwired to lead-status buckets; rather than "
    "generalize it (real regression risk to an already-shipped chart), this is a fresh, genuinely generic "
    "version in target-accounts.js, same SVG technique, taking pre-bucketed {label, count, color} slices - "
    "one implementation reused by every pie on both new dashboards. Target Accounts Dashboard gets four "
    "pies: AI Priority range (bucketing the real aiPriorityScore field into 90-100/80-90/70-80/60-70/"
    "below-60/no-score - 17 of 500 companies have no score, given its own slice rather than folded into "
    "“below 60”), Evidence level (real workbook values, not guessed: Rich Evidence/Sufficient Evidence/"
    "Insufficient - Missing baseline), Account status (Not contacted/Contacted/Responded - no stored "
    "“account status” field exists or should exist; derived from the account's own associated leads' real "
    "status, same reasoning as lastCommunicationFor), and a proposed 4th, Contact coverage (0/1-2/3+ known "
    "Target Contacts per account, via workbook.contacts grouped by companyId) - the most actionable "
    "addition given contacts research is still mid-rollout (83 of 500 accounts covered when this shipped), "
    "a gap none of the other three pies surface. Target Contacts Dashboard (new #contacts hash route in "
    "the same page, a tab bar switches between the two list views, hidden on Account/Contact detail "
    "views): a full second sortable/filterable/paginated table across every Target Contact. Deliberately "
    "its own parallel state/column-config/render functions (CONTACT_LIST_COLUMNS, contactSortField, "
    "renderContactsTable, buildContactsPaginationBar, etc.), not a generalized shared table widget - the "
    "Companies table's sort/filter/hide-columns/pagination machinery is large and already working; "
    "refactoring it into something reusable risks regressing a table the user depends on daily for a "
    "codebase-hygiene win alone. The purely generic cell-formatting helpers it already had "
    "(renderCellContent, rawValue, sortValue, filterText, formatValue, formatExcelDate, formatNumber - "
    "none of them actually reference COMPANY_COLUMNS, just whatever column object they're given) ARE "
    "reused directly, since duplicating those would be pure risk with no reuse-vs-risk tradeoff to weigh. "
    "Same flag column meaning as the Accounts list (hasOverdueAction on the contact's own "
    "targetContactExtras due-date, or an unreviewed post via findLeadsForContact); row click opens the "
    "existing Contact view (contactKeyFor/openContact). Two pies: Contact status (same derivation as "
    "Account status, scoped via findLeadsForContact) and a proposed 2nd, LinkedIn verification (Current - "
    "LinkedIn verified/Legacy - LinkedIn reverify/Not verified, bucketing evidenceQuality2 - the exact "
    "field the duplicate-header fix, v0.29.51, made trustworthy in the first place). Posts Dashboard: "
    "creatorCell now calls findTargetContactMatch (storage.js, exported - already built for the "
    "priority-signal feature, 6.11) and appends a “Target Contact” badge/link when a post's author is a "
    "known Target Contact; clicking it opens target-accounts.html#contact=<key>, the same cross-page "
    "pattern openLeadInDashboard already uses in the opposite direction. Target Contacts are loaded once "
    "at page init and refreshed only via a dedicated targetAccountsWorkbook storage-change listener "
    "branch, not re-fetched on every one of the Posts Dashboard's frequent loadLeads() calls. Not yet "
    "confirmed live at ship time.",
    "Side panel navigation fixed (v0.29.62) - reported directly: the new Target Contacts Dashboard had no "
    "side panel button at all, only reachable as an in-page tab from the Accounts Dashboard. A new “Target "
    "Contacts Dashboard” button opens target-accounts.html#contacts directly (the same in-page hash route "
    "the tab bar itself uses). Side panel button order changed to Target Accounts Dashboard, Target "
    "Contacts Dashboard, Posts Dashboard, Advisors, Settings, Activity Log, Help - Help kept last per "
    "explicit instruction, to stay last as more buttons get added over time.",
    "Two proposed pies corrected on the facts, not just removed (v0.29.63) - reported directly: the "
    "Contacts Dashboard's “LinkedIn verification” pie (proposed in the v0.29.61 entry above) was wrong - "
    "every contact from a ChatGPT import already has a verified working LinkedIn link, so it would only "
    "ever show one 100% slice. A follow-up proposal (account coverage - how many accounts have at least 1 "
    "contact, “around 68/301 (22.6%)”) turned out to already be the Accounts Dashboard's own Contact "
    "coverage pie, just needing a fix rather than a duplicate. New isRelevantAccount(company) is the real "
    "fix both issues pointed at: a coverage/status stat that includes every “Insufficient - Missing "
    "baseline” account (roughly 200 of 500) alongside the ~300 genuinely-researched ones is misleading, "
    "since those accounts were never going to have contacts researched yet. computeContactCoverageCounts "
    "now filters to Rich/Sufficient Evidence accounts only, matching the ~301-company denominator reported "
    "directly. The Contacts Dashboard's broken LinkedIn-verification pie was removed outright rather than "
    "replaced with an invented substitute - left as a single pie (Contact status) for now; Seniority or "
    "Function breakdowns would be reasonable next candidates if a 2nd pie is wanted later.",
    "Page heading/tab title now dynamic (v0.29.64) - reported directly: this one page serves both "
    "dashboards via a hash-routed tab switch, not separate HTML files, but the h1 and browser tab title "
    "stayed the static “SalesTeam Target Accounts Dashboard” regardless of which list was actually showing "
    "- the two looked identical at a glance. showListTab(tab) now updates both document.title and the h1 "
    "text (wrapped in a new #page-title-text span so it can be updated without disturbing the adjacent "
    "version number) to match whichever list is active, kept in sync with the same names used on the side "
    "panel's own buttons.",
    "Contacts-sheet schema change handled, LinkedIn Profile link fixed (v0.29.65) - the user imported "
    "Swiss_AI_Prospects_500_v24_contacts_expanded.xlsx, whose Contacts sheet dropped the old duplicate "
    "Last_Verified/Evidence_Quality header pair (the source of lastVerified2/evidenceQuality2, v0.29.51) "
    "in favor of a single dedicated LinkedIn_Profile_URL column. Left unhandled, the “LinkedIn Profile” "
    "link would have gone silently blank across the Account view's Contacts sub-table, the Contacts "
    "Dashboard's LinkedIn Profile column, and the Contact view's overview, for every contact from the new "
    "export. importTargetAccountsWorkbook (storage.js) now normalizes each contact row at import time - "
    "lastVerified2 is backfilled from the new linkedinProfileUrl field when the old field is absent - so "
    "CONTACT_COLUMNS/CONTACT_LIST_COLUMNS/renderContactView don't need to know which schema produced a "
    "given contact. The old schema's evidenceQuality2 status text has no equivalent in the new one and is "
    "left blank rather than invented; data already imported before this fix needs a re-import to "
    "normalize, since this runs at import time, not on every read. Reported directly: of the workbook's "
    "301 sufficiently-evidenced accounts (matching the user's figure exactly, confirmed against the "
    "workbook's own Dashboard sheet) and 169 total contact rows, only 22 contacts have LinkedIn_Profile_URL "
    "populated - this doesn't reconcile against “166 verified contacts,” and no field or summary KPI "
    "producing 166 was found in the workbook. Flagged rather than guessed at; the “151 accounts with 1+ "
    "contact” figure was not independently re-verified against this import.",
    "Third Contacts-sheet schema variant handled (v0.29.66) - the user had ChatGPT clean up v25's low "
    "LinkedIn-link coverage; the result, Swiss_AI_Prospects_500_v28_linkedin_profiles_verified.xlsx, "
    "restructures the sheet a third way - Source_URL and LinkedIn_Profile_URL (v0.29.65's dedicated "
    "column) are both removed, and Profile_URL (previously the company's own bio page) is repurposed to "
    "hold the verified LinkedIn link directly. Verified directly: 199 contacts, 183 with a real "
    "linkedin.com Profile_URL, matching the user's reported numbers exactly; 301/181/60.1% coverage "
    "unchanged from v25, as expected. normalizeContactRows (storage.js, generalized from v0.29.65's "
    "per-row version) now detects the schema once per import by checking whether the linkedinProfileUrl/"
    "sourceUrl columns exist anywhere in the whole contacts array - a single row's blank cell isn't "
    "reliable, since a blank cell may not produce a key on that row at all (xlsx-lite.js). When both "
    "columns are absent, profileUrl is read as the LinkedIn link and then blanked on the normalized "
    "contact, so “Bio Page” doesn't duplicate “LinkedIn Profile” under a now-wrong label. Runs at import "
    "time, same as v0.29.65 - already-imported data needs a re-import.",
])

doc.add_heading("6.20 Target Account & Contact Discovery (in progress, v0.30.0+)", level=3)
doc.add_paragraph(
    "Today's Target Accounts data (6.12/6.19) comes entirely from an Excel workbook the user manually gets "
    "ChatGPT to deep-research outside the extension, in small iterative chunks - unsustainable for a "
    "product intended for distribution/sale to other salespeople, since a new customer shouldn't need "
    "ChatGPT or manual Excel work just to reach a usable state. This feature makes the extension able to "
    "build that company/contact universe itself. Full phased plan on file (giggly-watching-feather.md); "
    "summarized here as work lands. Decided directly with the user: the onboarding wizard's country/region "
    "coverage should eventually span LinkedIn's full country list (each needing a live-verified geoUrn, "
    "added incrementally - no LinkedIn URL parameter is ever guessed in this codebase, always confirmed "
    "live first); discovered companies/contacts stay in their own storage, never merged into the "
    "ChatGPT-imported targetAccountsWorkbook (dashboards combine both sources for display, tagged by "
    "origin); every onboarding step (location, size/cap, industry, priority guidelines, company context, "
    "ideal customer profile, target-contact titles/keywords) must be completed before a Discovery scan can "
    "start, not just the mechanically-necessary ones, since Company Context/ICP also feed the new "
    "company-level AI prioritization pass. Planned phases: a required first-run onboarding wizard (none "
    "exists today); a live-verification spike for LinkedIn's company-search size/industry facets and "
    "People Search's multi-title/company-scoping support; a resumable multi-day scan queue (company "
    "discovery, then per-company contact discovery, paced under 6.20's unified touch budget, no "
    "chrome.alarms - always a deliberate “Continue” click); and a lightweight in-extension "
    "company-prioritization pass (reusing the existing prioritizeLeads()/tool-call pattern from 6.11, "
    "informed by a simple ranked Size/Location/Industry “T-shirt size” priority guideline) so discovered "
    "companies get a usable priority without needing ChatGPT's deep research behind them. v0.30.0 shipped "
    "the first, self-contained phase: the unified safety-budget enforcement described in Section 7 below."
)

doc.add_heading("7. Non-functional requirements", level=2)
add_bullets(doc, [
    "Manual-trigger only — no alarms, no background scanning, ever.",
    "Local-first privacy — all data in chrome.storage.local; the only outbound calls are to linkedin.com "
    "(reading pages already open) and api.anthropic.com (only when AI features are used, with the user's "
    "own key). No server operated by this project.",
    "No remote code — no bundler-fetched or eval'd remote JavaScript (a Chrome Web Store policy "
    "requirement); Dashboard's pie charts are hand-drawn inline SVG rather than a chart library for this "
    "reason.",
    "Self-healing data migrations — schema changes (e.g. the \u201cBlocked\u201d \u2192 \u201cIrrelevant\u201d "
    "rename, missing postedAt/status on old leads) backfill automatically on next read, never requiring a "
    "manual migration step or losing existing data.",
    "Bounded AI calls — every Anthropic fetch has a timeout; a stalled connection now fails with a clear "
    "message inside whatever bound is appropriate (2.5 min conversational, 45s draft, 50s tool execution) "
    "instead of hanging indefinitely.",
    "Resilient, honestly-worded scan failures (v0.29.18) - scanAllTopics() (background.js) saves whatever "
    "leads were found so far and surfaces a clear SCAN_ERROR message instead of dying silently if a mid-scan "
    "error occurs (a closed tab, a transient extension API failure, Chrome terminating the service worker "
    "mid-run). Reported directly: the message's original wording (try scanning again to pick up the rest) "
    "implied an efficient resume from where it stopped, but there's no per-topic checkpoint - every scan "
    "always restarts at topic 1. Nothing is actually lost or duplicated (already-saved leads are matched by "
    "key on a re-scan), so the message was corrected to say so plainly rather than promise a resume feature "
    "that doesn't exist.",
    "LinkedIn touch-volume visibility (v0.29.49) - reported directly: a single day of concentrated testing "
    "(one scan, one profile-extraction run, and nine separate company-ID-resolver runs spread from 00:54 to "
    "12:23 UTC) triggered LinkedIn's own “unusual activity” account warning. Reconstructed after the fact "
    "from real timestamped data - not a guess: ~315 automated page visits that day, with company-ID "
    "resolution alone (171) the single largest contributor, more than the scan and profile-extraction "
    "combined, running independently across the whole day rather than in one obvious burst. A new "
    "linkedin-touch-log.js module (deliberately its own tiny file, not folded into storage.js, so modules "
    "that intentionally have no dependency on it - profile-extraction.js, people-search-extraction.js - "
    "don't reintroduce one) records every real navigation from all four sources as a trimmed rolling-window "
    "timestamp log (7-day retention), not a running total, so the visible count reflects genuine recent "
    "activity. Surfaced as a persistent “LinkedIn touches (automated): N in the last 24h, M in the last 7 "
    "days” line on both the side panel and Settings, color-coded amber past 50/24h and red past 100/24h - "
    "both well below the ~315 that triggered the real warning. Not a gate at the time - nothing was blocked "
    "or throttled, purely visibility.",
    "Unified safety budget, now actually enforced (v0.30.0) - decided directly as part of scoping 6.20: "
    "since LinkedIn doesn't care which internal feature triggered a request, one shared daily budget should "
    "govern every automated feature, and it should actually stop something, not just recolor a label. "
    "Thresholds tightened to warn at 75 / hard stop at 99 (linkedin-touch-log.js). New "
    "touch-budget-guard.js - checkTouchBudget() is the one place every LinkedIn-navigating loop now checks "
    "the budget; hitting it sets the same scanAbortRequested flag every cooperative-stop check already "
    "watches (background.js's checkAbort(), company-resolve-extraction.js, people-search-extraction.js), so "
    "one feature hitting the limit stops every other one running at the same time too. "
    "people-search-extraction.js's loop had no abort check of any kind before this - closed as part of the "
    "same change, not left as a gap. Every affected status message/Activity Log entry now distinguishes "
    "“stopped by you” from “stopped automatically - daily LinkedIn activity limit reached” via a "
    "stoppedByTouchBudget flag each module now returns.",
])

doc.add_heading("8. Open items / known gaps", level=2)
add_bullets(doc, [
    "LinkedIn's DOM structure for search results is unstable; content-script selectors need occasional "
    "maintenance when scraping breaks.",
    "Negative-topic and Author-title matching is keyword-based, not exact — a common word can over-match, "
    "which is why every automatic status change is reviewable and reversible, never a silent delete.",
    "No CRM push (Salesforce/other) yet — leads live only in this extension.",
    "Company grouping is normalized-string matching, not brand/subsidiary aliasing - it handles minor "
    "legal-suffix variation (“Azqore” vs “Azqore SA”) but has no way to know that "
    "different names are the same company (e.g. “Google Inc.” vs “Alphabet,” "
    "“Facebook” vs “Meta”). A proper alias/merge mechanism is planned as later work, "
    "likely alongside a dedicated Companies view (deferred for now in favor of the in-table grouping above).",
    "Chrome Web Store submission was rejected once (v0.15.0, excessive scripting/tabs permissions that "
    "weren't actually used) and resubmitted after removing them (v0.15.1); awaiting review as of this "
    "writing.",
])

doc.add_heading("9. Version history", level=2)
doc.add_paragraph(
    "See RELEASE_NOTES.md for the full, dated changelog. Current version: 0.30.0."
)

for section in doc.sections:
    section.top_margin = Pt(50)
    section.bottom_margin = Pt(50)

prd_path = SALESTEAM_DIR + "/PRD.docx"
doc.save(prd_path)
fix_zoom(prd_path)
print("Saved PRD.docx")
