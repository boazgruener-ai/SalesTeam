# Chrome Web Store listing — copy-paste reference

## Store listing name
SalesTeam - AI Sales Team for LinkedIn

## Summary (max 132 characters; comes from the manifest description)
Searches LinkedIn for relevant companies, contacts and posts, auto-filters noise, gets AI-prioritized results and drafts outreach.

## Category
Productivity (or "Business tools" if offered as a subcategory)

## Language
English

## Detailed description
SalesTeam turns LinkedIn into a self-building, prioritized pipeline of target accounts, contacts, and leads - then gives you an AI sales team to act on it.

WHAT IT DOES

- Target Account & Contact Discovery: point it at your ideal customer profile (industry, size, location) and it builds your target company and contact universe automatically, with AI-driven prioritization rules - import a research spreadsheet, or let it discover companies and contacts on LinkedIn itself.
- Define "Topics" (keyword groups) once, then click "Scan All Topics" to search LinkedIn Posts and Jobs for all of them in one go, scoped to your target accounts and contacts.
- Define "Negative Topics" too - competitors and recruiter/staffing posts that match the same keywords but are never real prospects get auto-filtered out, not left for you to skip past manually. Two are built in; add your own for any other recurring noise.
- Results are merged, deduplicated, and ranked, with matched keywords, hiring/freelance signals, and connection-degree shown on every lead.
- A Dashboard tab turns the results into a real pipeline view: pie charts by status, a sortable/filterable table, per-lead detail pages, CSV export, and safe bulk status changes (confirmation required, one level of undo). A Target Accounts Explorer does the same for your company/contact universe - priority, evidence level, and contact coverage at a glance.
- Built for personal use, the way a person would use these sites: your research draws on publicly available sources (company registries and websites, through the research prompt) and on platforms such as LinkedIn. Every scan starts when you click a button, every search and page visit happens in a browser tab you can see, and your browser stays open while it runs. There are no scheduled scans and no bulk page collection, and a built-in daily limit keeps searches and page visits modest. SalesTeam has no server or database of its own, never resells or shares data, and never sends messages for you.
YOUR AI SALES TEAM (optional, needs your own Anthropic API key)

- Automatic prioritization: after every scan, each new lead is scored 1 (highest) to 5 (lowest) by real fit and urgency - not just keyword overlap - so you always know what to work on first. Target companies get their own AI-judged Strategic Fit score the same way.
- AI-drafted opening messages for any lead - editable, and only ever copied for you to paste and send yourself. Nothing is auto-sent.
- Sales Mentor: an AI agent you can ask "Which lead should I approach first?" or general sales-strategy questions. It looks up your real lead data only when a question actually needs it.
- Customer Voice: an AI agent that roleplays as a realistic buyer, so you can pressure-test a message or approach before you send it.
The core scanning, filtering, and Dashboard features work with no AI key at all. The AI Sales Team features (prioritization, drafting, Sales Mentor, Customer Voice) are entirely optional, and require you to provide your own Anthropic API key, which is stored only on your device.

PRIVACY

SalesTeam only reads LinkedIn pages you're already viewing (Posts/Jobs search, Company/People search, company and profile pages), stores everything locally in your browser, and never sends anything to a server we operate. See the full privacy policy at: https://claude.ai/artifact/F8o4GecGJnb1LD8VQJ3npG

## Single purpose description (required field)
Searches LinkedIn's Posts, Jobs, Company, and People search results, plus individual company and profile pages, to build a target-account/contact universe and surface B2B sales leads, using the same logged-in LinkedIn session the user would browse with manually — no separate credentials or automation account. Also offers optional AI-assisted analysis, prioritization, and message drafting using the user's own Anthropic API key.

## Permission justifications (required field per permission)
storage:

Stores the user's search Topics, filters, leads, target account/contact lists, and AI conversation history locally in the browser.

sidePanel:

Displays quick links to open the Scanner, Target Accounts, Target Contacts and Posts dashboards, plus pipeline stats.

clipboardWrite:

Lets the user copy an AI-drafted message with one click, to paste into LinkedIn's own message compose box.

power:

Keeps the machine awake for the duration of a long-running search or lookup, so a multi-minute pass initiated by the user isn't interrupted by the system sleeping partway through.

unlimitedStorage:

Lets the extension keep the data a user builds up - imported research workbooks (thousands of contacts and initiatives), searched leads and conversation history - in the browser's local storage without hitting Chrome's default 10 MB limit, after which saving new data would start to fail. Nothing is uploaded; the data stays on the user's device.

Host permission - https://www.linkedin.com/*:

Required to read the Posts, Jobs, Company Search, People Search, individual company, and individual profile pages the user is already viewing (or that a user-triggered search opens in a background tab), in order to match leads and build/enrich the user's target-account and target-contact lists. The extension does not run on any other website.

Host permission - https://api.anthropic.com/*:

Required so the optional AI features (prioritization, message drafting, Sales Mentor, Customer Voice) can call Anthropic's API directly from the browser, authenticated with the user's own API key.

## Remote code question
Answer: No. The extension makes data API calls to Anthropic (text in, text out) - it does not fetch or execute remote JavaScript.

## Data usage disclosure (Chrome's "Privacy practices" tab)
- From Data Usage Checkboxes - only check: PII, Authentication Information and Website content.
Does this extension collect or transmit user data (Personal Identifiable Information) ? Yes - lead and target-account text and chat content, only when the optional AI features are used, sent directly to Anthropic's API using the user's own key.

- Is this data sold or used for purposes unrelated to the extension's function? No.
- Is this data used for advertising? No.
- Privacy policy URL: https://claude.ai/artifact/F8o4GecGJnb1LD8VQJ3npG

## Support URL (optional field)
https://claude.ai/artifact/MroEuwHoz9tbqAYoXWt3G5

(Must be shared with "anyone with the link" from the page's Share menu, or reviewers and users can't open it.)

## Visibility
Set to "Unlisted" (not "Public") so it's installable only by people you send the link to, without appearing in Chrome Web Store search.
