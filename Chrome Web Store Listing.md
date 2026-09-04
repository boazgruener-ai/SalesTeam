# Chrome Web Store listing — copy-paste reference

## Store listing name
SalesTeam - AI Sales Team for LinkedIn

## Summary (max 132 characters)
Scan LinkedIn for leads, auto-filter noise, get AI-prioritized results in a Dashboard, and draft outreach with an AI sales team.

## Category
Productivity (or "Business tools" if offered as a subcategory)

## Language
English

## Detailed description

SalesTeam turns LinkedIn's Posts and Jobs search into a prioritized pipeline of leads - then gives you an AI
sales team to act on it.

WHAT IT DOES
- Define "Topics" (keyword groups) once, then click "Scan All Topics" to search LinkedIn Posts and Jobs for
  all of them in one go.
- Define "Negative Topics" too - competitors and recruiter/staffing posts that match the same keywords but
  are never real prospects get auto-filtered out, not left for you to skip past manually. Two are built in;
  add your own for any other recurring noise.
- Results are merged, deduplicated, and ranked, with matched keywords, hiring/freelance signals, and
  connection-degree shown on every lead.
- A Dashboard tab turns the results into a real pipeline view: pie charts by status, a sortable/filterable
  table, per-lead detail pages, CSV export, and safe bulk status changes (confirmation required, one level of
  undo).
- 100% manual-trigger. Nothing runs on a schedule or in the background - every scan starts with you clicking
  a button, so it behaves like a careful human, not an automation bot.

YOUR AI SALES TEAM (optional, needs your own Anthropic API key)
- Automatic prioritization: after every scan, each new lead is scored 1 (highest) to 5 (lowest) by real fit
  and urgency - not just keyword overlap - so you always know what to work on first.
- AI-drafted opening messages for any lead - editable, and only ever copied for you to paste and send
  yourself. Nothing is auto-sent.
- Sales Mentor: an AI agent you can ask "Which lead should I approach first?" or general sales-strategy
  questions. It looks up your real lead data only when a question actually needs it.
- Customer Voice: an AI agent that roleplays as a realistic buyer, so you can pressure-test a message or
  approach before you send it.

The core scanning, filtering, and Dashboard features work with no AI key at all. The AI Sales Team features
(prioritization, drafting, Sales Mentor, Customer Voice) are entirely optional, and require you to provide
your own Anthropic API key, which is stored only on your device.

PRIVACY
SalesTeam only reads LinkedIn Posts/Jobs search pages you're already viewing, stores everything locally in
your browser, and never sends anything to a server we operate. See the full privacy policy at:
https://claude.ai/code/artifact/727687e7-bf9b-4f4f-b3c1-5ce26b341049

## Single purpose description (required field)
Scans LinkedIn's Posts and Jobs search results for user-defined topics to surface B2B sales leads, using
the same logged-in LinkedIn session the user would browse with manually — no separate credentials or
automation account. Also offers optional AI-assisted analysis and message drafting using the user's own
Anthropic API key.

## Permission justifications (required field per permission)

storage:
Stores the user's search Topics, filters, scraped leads, and AI conversation history locally in the browser.

sidePanel:
Displays the extension's core UI (search Topics, Negative Topics/filters, scan trigger, and results) in
Chrome's side panel, with links to open the Dashboard, Advisors, Settings, and Help pages in their own tabs.

clipboardWrite:
Lets the user copy an AI-drafted message with one click, to paste into LinkedIn's own message compose box.

Host permission - https://www.linkedin.com/*:
Required to read the Posts and Jobs search-results pages the user is already viewing, in order to scrape and
match leads. The extension does not run on any other LinkedIn page or any other website.

Host permission - https://api.anthropic.com/*:
Required so the optional AI features (message drafting, Sales Mentor, Customer Voice) can call Anthropic's
API directly from the browser, authenticated with the user's own API key.

## Remote code question
Answer: No. The extension makes data API calls to Anthropic (text in, text out) - it does not fetch or
execute remote JavaScript.

## Data usage disclosure (Chrome's "Privacy practices" tab)
- Does this extension collect or transmit user data? Yes - lead text and chat content, only when the
  optional AI features are used, sent directly to Anthropic's API using the user's own key.
- Is this data sold or used for purposes unrelated to the extension's function? No.
- Is this data used for advertising? No.
- Privacy policy URL: https://claude.ai/code/artifact/727687e7-bf9b-4f4f-b3c1-5ce26b341049

## Visibility
Set to "Unlisted" (not "Public") so it's installable only by people you send the link to, without appearing
in Chrome Web Store search.
