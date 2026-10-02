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
SalesTeam turns LinkedIn into a self-building, prioritized pipeline of target accounts, contacts, and leads (posts) - then gives you an AI sales team to act on it.

WHAT IT DOES

- Guided setup that proposes its own answers: enter your company's website and SalesTeam reads it and proposes your locations, company sizes, industries, offer, ideal customer and target contacts - each shown next to the current setting, taken only if you choose it.
- Target Account & Contact Discovery: point it at your ideal customer profile (industry, size, location) and say how big the list should be, and it builds your target company and contact universe - finding matching companies in company listings on the public web, plus any you name yourself, with an estimate of cost and time up front. You can also import a research spreadsheet, or discover companies and contacts on LinkedIn.
- Accounts kept ready automatically: switch it on once and SalesTeam links your accounts to their LinkedIn pages, finds their size and their key contacts, and shows how many are ready to work - within your daily LinkedIn limit, in a small window of its own, making way whenever you start a scan. What it cannot settle by itself waits for you in one Decisions list. Turn it off at any time in Settings > Automation.
- Define "Topics" (keyword groups) once, then click "Scan All Topics" to search LinkedIn Posts and Jobs for all of them in one go, scoped to your target accounts and contacts.
- Define "Negative Topics" too - competitors and recruiter/staffing posts that match the same keywords but are never real prospects get auto-filtered out, not left for you to skip past manually. Two are built in; add your own for any other recurring noise.
- Results are merged, deduplicated, and ranked, with matched keywords, hiring/freelance signals, and connection-degree shown on every lead (post).
- The Leads Dashboard turns the leads (posts) into a real pipeline view: pie charts by status, a sortable/filterable table, per-lead detail pages, CSV export, every active filter shown above the table with one-click clear, and safe bulk status changes (confirmation required, one level of undo). A Target Accounts Explorer does the same for your company/contact universe - priority, evidence level, and contact coverage at a glance, with accounts and contacts each exportable as a spreadsheet that opens in Excel, or as HubSpot import files.
- Built for personal use, the way a person would use these sites: your research draws on publicly available sources (company registries and websites, through the research prompt or SalesTeam's own web research on your Anthropic API key) and on platforms such as LinkedIn. Every scan starts when you click a button. Automatic account preparation runs only if you switch it on: You start it once; SalesTeam keeps your accounts ready within your daily LinkedIn limit, visible in your browser, and you can turn it off at any time. Every search and page visit happens in a browser tab or window you can see, only while your browser is open. There is no bulk page collection, and a built-in daily limit keeps searches and page visits modest. SalesTeam has no server or database of its own, never resells or shares data, and never sends messages for you.
YOUR AI SALES TEAM (optional, needs your own Anthropic API key)

- Automatic prioritization: after every scan, each new lead (post) is scored 1 (highest) to 5 (lowest) by real fit and urgency - not just keyword overlap - so you always know what to work on first. Target companies get their own AI-judged Strategic Fit score the same way.
- AI-drafted opening messages for any lead (post) - editable, and only ever copied for you to paste and send yourself. Nothing is auto-sent.
- Sales Mentor: an AI agent you can ask "Which lead should I approach first?" or general sales-strategy questions. It looks up your real lead data only when a question actually needs it.
- Customer Voice: an AI agent that roleplays as a realistic buyer, so you can pressure-test a message or approach before you send it.
- Web research: researches your accounts on the public web, with sources you can open and check. Click to research an account, or let account preparation do it within a monthly budget you set, never above it.
The core scanning, filtering, and Dashboard features work with no AI key at all. The AI Sales Team features (prioritization, drafting, Sales Mentor, Customer Voice) are entirely optional, and require you to provide your own Anthropic API key, which is stored only on your device.

PRIVACY

SalesTeam only reads LinkedIn pages opened in your own browser (Posts/Jobs search, Company/People search, company and profile pages), stores everything locally in your browser, and never sends anything to a server we operate. See the full privacy policy at: https://aisalesteam.app/privacy.html

## Privacy tab - fields in the order they appear on the page

### 1. Single purpose description (required field)
Searches LinkedIn's Posts, Jobs, Company, and People search results, plus individual company and profile pages, to build a target-account/contact universe and surface B2B sales leads (posts), using the same logged-in LinkedIn session the user would browse with manually — no separate credentials or automation account. Also offers optional AI-assisted analysis, prioritization, and message drafting using the user's own Anthropic API key.

### 2. Permission justifications (one field per permission)

storage justification:

Stores the user's search Topics, filters, leads, target account/contact lists, and AI conversation history locally in the browser.

unlimitedStorage justification:

Lets the extension keep the data a user builds up - imported research workbooks (thousands of contacts and initiatives), searched leads (posts) and conversation history - in the browser's local storage without hitting Chrome's default 10 MB limit, after which saving new data would start to fail. Nothing is uploaded; the data stays on the user's device.

sidePanel justification:

Displays quick links to open the Scanner, Target Accounts, Target Contacts and Posts dashboards, plus pipeline stats.

clipboardWrite justification:

Lets the user copy an AI-drafted message with one click, to paste into LinkedIn's own message compose box.

power justification:

Keeps the machine awake for the duration of a long-running search or lookup, so a multi-minute pass initiated by the user isn't interrupted by the system sleeping partway through.

### 3. Host permission justification (one field - paste both paragraphs)

Host permission - https://www.linkedin.com/*:
Required to read the Posts, Jobs, Company Search, People Search, individual company, and individual profile pages the user is already viewing (or that a user-triggered search, or the automatic account preparation the user has switched on, opens in a tab or a small window of its own), in order to match leads (posts) and build/enrich the user's target-account and target-contact lists. The extension does not run on any other website.

Host permission - https://api.anthropic.com/*:
Required so the optional AI features (prioritization, message drafting, web research, Sales Mentor, Customer Voice) can call Anthropic's API directly from the browser, authenticated with the user's own API key.

### 4. Are you using remote code?
Answer: No. The extension makes data API calls to Anthropic (text in, text out) - it does not fetch or execute remote JavaScript.

### 5. Data usage - what user data do you collect
- From Data Usage Checkboxes - only check: PII, Authentication Information and Website content.
Does this extension collect or transmit user data (Personal Identifiable Information) ? Yes - lead (post) and target-account text and chat content, only when the optional AI features are used, sent directly to Anthropic's API using the user's own key.

### 6. I certify that the following disclosures are true (tick all three)
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### 7. Privacy policy
- Privacy policy URL: https://aisalesteam.app/privacy.html

## Support URL (optional field)
https://aisalesteam.app/support.html

(Both pages are on the SalesTeam website, aisalesteam.app, and open for anyone.)

## Visibility
Set to "Unlisted" (not "Public") so it's installable only by people you send the link to, without appearing in Chrome Web Store search.
