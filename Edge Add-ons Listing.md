# Microsoft Edge Add-ons listing — copy-paste reference

For Partner Center (partner.microsoft.com) → Edge → SalesTeam. The package is the same file as for the Chrome Web
Store: `builds/v1.2.4/SalesTeam-v1.2.4.zip`. The description below is the same text as in
`Chrome Web Store Listing.md` — when one changes, change the other.

## Package
Upload `builds/v1.2.4/SalesTeam-v1.2.4.zip` (Packages → drag the zip in).

## Availability
- Visibility: **Public** (or **Hidden** to give it only to people you send the link to).
- Markets: all markets.

## Properties
- Category: **Productivity**
- Privacy policy requirements — "Does this extension access, collect or transmit personal information?": **Yes**
- Privacy policy URL: https://aisalesteam.app/privacy.html
- Website URL: https://aisalesteam.app
- Support contact details: https://aisalesteam.app/support.html
- Mature content: **No**

## Store listing (language: English)

### Display name (comes from the package)
SalesTeam - AI Sales Team for LinkedIn

### Short description (comes from the package's manifest description)
Searches LinkedIn for relevant companies, contacts and posts, auto-filters noise, gets AI-prioritized results and drafts outreach.

### Description (max 10,000 characters)
SalesTeam turns LinkedIn into a self-building, prioritized pipeline of target accounts, contacts, and leads (posts) - then gives you an AI sales team to act on it.

WHAT IT DOES

- Guided setup that proposes its own answers: enter your company's website and SalesTeam reads it and proposes your locations, company sizes, industries, offer, ideal customer and target contacts - each shown next to the current setting, taken only if you choose it.
- Target Account & Contact Discovery: point it at your ideal customer profile (industry, size, location) and say how big the list should be, and it builds your target company and contact universe - finding matching companies in company listings on the public web, plus any you name yourself, with an estimate of cost and time up front. You can also import a research spreadsheet, or discover companies and contacts on LinkedIn.
- Accounts kept ready automatically: switch it on once and SalesTeam links your accounts to their LinkedIn pages, finds their size and their key contacts, and shows how many are ready to work - within your daily limit, in a small window of its own, making way whenever you start a scan. What it cannot settle by itself waits for you in one Decisions list. Turn it off at any time in Settings > Automation.
- Define "Topics" (keyword groups) once, then click "Scan All Topics" to search LinkedIn Posts and Jobs for all of them in one go, scoped to your target accounts and contacts.
- Define "Negative Topics" too - competitors and recruiter/staffing posts that match the same keywords but are never real prospects get auto-filtered out, not left for you to skip past manually. Two are built in; add your own for any other recurring noise.
- Results are merged, deduplicated, and ranked, with matched keywords, hiring/freelance signals, and connection-degree shown on every lead (post).
- The Leads Dashboard turns the leads (posts) into a real pipeline view: pie charts by status, a sortable/filterable table, per-lead detail pages, CSV export, every active filter shown above the table with one-click clear, and tick leads to change their status in bulk (confirmation required, one level of undo). A Target Accounts Explorer does the same for your company/contact universe - priority, evidence level, and contact coverage at a glance, with accounts and contacts each exportable as a spreadsheet that opens in Excel, or as import files for common CRM systems.
- Notes on accounts, contacts and leads (posts): write down what you did and what you learned - SalesTeam adds the date and your name. Each account shows one timeline with the notes on its contacts and leads, a "Last note" column shows where something happened last, and in a team everyone who sees an account sees its notes.
- Data protection built in: choose how long leads are kept (deleted automatically after 6, 12 or 24 months), delete a contact or lead permanently, and answer a person's request in one place - find everything SalesTeam holds about them, save it as a PDF, or erase it and keep them from being stored again. Removals, merges and deletions ask for a reason, and the Activity Log (kept 12 months) can be exported for audits.
- Work as a team: colleagues share one set of accounts, contacts and leads (posts) through a OneDrive folder your team owns - changes reach everyone by themselves. "Assign to me" keeps an account yours so nobody else works it, the Team Lead owns the Setup, can reassign accounts and can split the accounts into groups so that each member sees and works their own part of the list, and a small badge on LinkedIn company and profile pages shows who has the account. Each member scans with their own LinkedIn account and their own daily limit; API keys, drafts and scanner settings stay personal; the Team Lead sees each member's monthly AI usage total. No SalesTeam server and no sign-in.
- Built for personal use, the way a person would use these sites: your research draws on publicly available sources (company registries and websites, through the research prompt or SalesTeam's own web research on your Anthropic API key) and on platforms such as LinkedIn. Every scan starts when you click a button. Automatic account preparation runs only if you switch it on: You start it once; SalesTeam keeps your accounts ready within your daily limit, visible in your browser, and you can turn it off at any time. Every search and page visit happens in a browser tab or window you can see, only while your browser is open. There is no bulk page collection, and a built-in daily limit keeps searches and page visits modest. SalesTeam has no server or database of its own, never resells or shares data, and never sends messages for you. In a team, the shared data lives only in your team's own OneDrive folder.
YOUR AI SALES TEAM (optional, needs your own Anthropic API key)

- Automatic prioritization: after every scan, each new lead (post) is scored 1 (highest) to 5 (lowest) by real fit and urgency - not just keyword overlap - so you always know what to work on first. Target companies get their own AI-judged Strategic Fit score the same way.
- AI-drafted opening messages for any lead (post) - editable, and only ever copied for you to paste and send yourself. Nothing is auto-sent.
- Sales Mentor: an AI agent you can ask "Which lead should I approach first?" or general sales-strategy questions. It looks up your real lead data only when a question actually needs it.
- Customer Voice: an AI agent that roleplays as a realistic buyer, so you can pressure-test a message or approach before you send it.
- Web research: researches your accounts on the public web - size, headquarters and recent projects where what you sell could help - with sources you can open and check. Click to research an account, or let account preparation do it within a monthly budget you set, never above it.
The core scanning, filtering, and Dashboard features work with no AI key at all. The AI Sales Team features (prioritization, drafting, Sales Mentor, Customer Voice) are entirely optional, and require you to provide your own Anthropic API key, which is stored only on your device.

PRIVACY

SalesTeam only reads LinkedIn pages opened in your own browser (Posts/Jobs search, Company/People search, company and profile pages), stores everything locally in your browser - and, if you work as a team, in a OneDrive folder your team owns and shares - and never sends anything to a server we operate. You decide how long leads are kept, and can delete anyone's data permanently from Settings > Data protection. See the full privacy policy at: https://aisalesteam.app/privacy.html

### Search terms (up to 7 terms, each at most 30 characters, 21 words in all)
- LinkedIn leads
- sales prospecting
- target accounts
- lead generation
- AI sales assistant
- sales outreach
- B2B sales

### Store logo and screenshots
- Store logo: 300 x 300 px (the SalesTeam icon).
- Screenshots: the same as for the Chrome Web Store (1280 x 800 px), in `Screen shots/Store 1.2.1/` or newer.

## Notes for certification (not shown to users)
SalesTeam is a sales tool for people who use LinkedIn in their own browser. To test it:

1. Install the extension and open its side panel (click the SalesTeam icon). No SalesTeam account or sign-in exists.
2. The Setup, the Target Accounts, Target Contacts and Leads dashboards, Settings, Help and the Activity Log all work without any account.
3. Scanning LinkedIn needs a LinkedIn account that is logged in in the same browser. SalesTeam only reads pages LinkedIn shows to that user; a scan starts when the user clicks Start.
4. The AI features (prioritization, message drafts, Sales Mentor, web research) are optional and need the user's own Anthropic API key, entered under Settings → Anthropic API Key. Without a key these features say so and nothing else is affected.
5. Team use is optional: it needs a OneDrive folder the user chooses. Without a team nothing is shared.

All data is kept in the browser's local storage. SalesTeam has no server. The only network calls are to linkedin.com (pages the user's own session can open) and, when the user has entered a key, to api.anthropic.com.
