// A curated FAQ + fuzzy free-text search, deliberately NOT an AI feature -
// no API key needed, instant, and the answers are exact/reviewed rather than
// generated. "Fuzzy" here means token-overlap across a question's own
// synonyms (so "enable topic" and "disable a search topic" hit the same
// entry) plus light typo tolerance (edit-distance on individual words) -
// not semantic/AI matching.

const CATEGORIES = ["Scanning & Topics", "Setup & Target Accounts", "Negative Topics & Filtering", "Leads Dashboard", "Advisors (AI)", "Team", "Settings & Backup"];

// Each entry's `keywords` exist purely to catch how someone might actually
// phrase a question - including the OPPOSITE of the literal answer (e.g.
// "disable" appears on the "enable a Topic" entry too), since the goal is
// matching intent/topic, not the exact wording of the canonical question.
const QA = [
  {
    id: "add-topic",
    category: "Scanning & Topics",
    question: "How do I add a new search Topic?",
    keywords: ["add", "create", "new", "topic", "keyword", "keywords", "search term"],
    answer: 'In the Scanner tile, click "+ Add Topic" under Topics, give it a name, and list keywords one per line. Add an optional "AND with" group if a post should only count when it mentions one keyword from EACH group.',
  },
  {
    id: "enable-disable-topic",
    category: "Scanning & Topics",
    question: "How do I enable or disable a Topic without deleting it?",
    keywords: ["enable", "disable", "turn on", "turn off", "toggle", "activate", "deactivate", "pause", "topic", "search topic"],
    answer: 'Every Topic card has a checkbox next to its name. Uncheck it to exclude that Topic from the next scan without losing its keywords - check it again any time to re-enable it.',
  },
  {
    id: "and-with-group",
    category: "Scanning & Topics",
    question: 'What does the "AND with" group on a Topic do?',
    keywords: ["and with", "and group", "activity keywords", "second group", "combine keywords"],
    answer: 'It\'s an optional second keyword group. If you fill it in, a post must match one keyword from your MAIN list AND one from this "AND with" list to count - useful for narrowing a broad topic (e.g. "AI" AND "hiring").',
  },
  {
    id: "job-search",
    category: "Scanning & Topics",
    question: "How do I search LinkedIn Jobs, not just Posts?",
    keywords: ["jobs", "job search", "job listing", "linkedin jobs", "vacancy", "vacancies", "enable job search"],
    answer: 'Turn on "Enable Job Search" in the Job Search section of the Scanner tile. By default it reuses your Post Topics\' keywords; you can also add Job-specific Topics, and set a location and how recent a posting must be.',
  },
  {
    id: "author-title-filter",
    category: "Scanning & Topics",
    question: "How does the Author Title filter work?",
    keywords: ["author title", "job title filter", "cto", "cio", "headline filter"],
    answer: 'List job titles (one per line, e.g. "CTO", "VP Engineering") and only posts whose author\'s visible headline contains one of them will be kept. This is checked locally after scraping - it\'s never sent to LinkedIn as part of the search.',
  },
  {
    id: "scan-stuck",
    category: "Scanning & Topics",
    question: "Why does a scan seem stuck or frozen?",
    keywords: ["stuck", "frozen", "hanging", "not finishing", "scan stopped", "stalled"],
    answer: "Every step of a scan (page load, waiting for results) is time-bounded, so it should never hang forever - if something genuinely fails, you'll get an error message instead of silence. If a scan still looks stuck for several minutes with no progress update, try again and let us know so it can be looked into.",
  },
  {
    id: "linkedin-use",
    category: "Scanning & Topics",
    question: "How SalesTeam works with online platforms and data sources?",
    keywords: ["linkedin", "terms", "policy", "policies", "rules", "safe", "safety", "ban", "banned", "restricted", "account", "scraping", "compliance", "limit", "touch budget", "resell", "data", "registry", "registries", "website", "websites", "public data", "platform", "platforms", "research"],
    answer: "SalesTeam is built with the rules of the online platforms and data sources it works with in mind. Its research draws on publicly available sources: the research prompt has an AI assistant consult public company registries and websites, and SalesTeam's own scans read pages of platforms such as LinkedIn. SalesTeam can also research companies on the public web itself - their own websites and web search results - through your own Anthropic API key, only if you switch web research on and within the monthly budget you set. It is designed for personal use, the way a person would use these sites: every scan starts when you click a button, and automatic account preparation runs only if you switch it on: you start it once; SalesTeam keeps your accounts ready within your daily LinkedIn limit, visible in your browser. Every search and page visit happens in a browser tab or window you can see, only while Chrome is open, and you can turn the automation off at any time in Settings. There is no bulk collection of pages. A built-in safety limit keeps the number of searches and page visits per day modest - within what one person could do by hand. SalesTeam has no server or database of its own, so it never collects, resells or shares anyone's data: everything it finds stays on your device (in a team, also in your team's own OneDrive folder), for your own and your team's use, and it never sends messages or connection requests for you. Because each platform's terms of use apply to how any tool is used on it (LinkedIn's terms, for example), we recommend keeping your use moderate and within the daily limit.",
  },
  {
    id: "manual-only",
    category: "Scanning & Topics",
    question: "Does SalesTeam scan automatically, or only when I click?",
    keywords: ["automatic", "automation", "background", "schedule", "scheduled", "run on its own", "manual", "ready", "account preparation", "turn off"],
    answer: 'Scans of posts and jobs are manual: every one starts with you clicking "Scan All Topics." Account preparation is the one thing that can run by itself, and only if you switch it on (at the end of Setup, or in Settings > Automation). You start it once; SalesTeam keeps your accounts ready within your daily LinkedIn limit, visible in your browser. It links accounts to LinkedIn, finds their size and key contacts in a small window of its own, only while Chrome is open, and makes way whenever you start a scan. Web research joins in only if you also tick it, within the monthly budget you set. Untick either one in Settings > Automation to stop it.',
  },
  {
    id: "setup-research",
    category: "Setup & Target Accounts",
    question: "Can SalesTeam fill in the Setup for me?",
    keywords: ["research my company", "propose", "proposal", "proposals", "about you", "website", "setup wizard", "onboarding", "fill in", "suggest settings", "improve setup"],
    answer: 'Yes, as proposals you can accept or ignore. In the Setup\'s first step, About you, enter your company and its website and press "Research my company" (about US$0.30 on your Anthropic API key). SalesTeam reads the company\'s website and proposes answers for Location, Size, Industry, What you sell, Things you can offer, Ideal customer, Target contacts, Companies to exclude and Customers and partners. Each proposal is shown next to the current setting, and nothing changes unless you take it. If you finished the Setup before version 1.2.1, Settings offers this once; it stays available any time under Settings > User Profile > Open About you.',
  },
  {
    id: "find-new-accounts",
    category: "Setup & Target Accounts",
    question: "How does SalesTeam find new target accounts?",
    keywords: ["new accounts", "find companies", "discover companies", "web discovery", "target accounts", "list", "listing", "how many accounts", "companies to include", "build my list"],
    answer: 'When you finish the Setup with automatic preparation and web research both ticked, SalesTeam builds the list for you. It first adds the companies you named under "Companies to include", then looks for companies that match your Location, Size and Industry answers in company listings on the public web, using web search on your Anthropic API key. Companies under "Companies to exclude" are never added. New accounts show "Web" as their Source. Each account is then researched on the web for what it still lacks (size, contacts, initiatives) within the monthly web budget you set, and checked on LinkedIn within your daily limit. The Setup\'s last step, "How big is your list", sets how many accounts, contacts per account and initiatives to aim for, and shows the estimated cost and time.',
  },
  {
    id: "export-accounts-contacts",
    category: "Setup & Target Accounts",
    question: "How do I export my accounts or contacts to Excel?",
    keywords: ["export", "csv", "excel", "spreadsheet", "download accounts", "download contacts", "accounts list", "contacts list", "crm", "salesforce", "hubspot"],
    answer: 'On the Target Accounts Dashboard, use "Export Accounts (CSV)" in the menu; on the Target Contacts Dashboard, "Export Contacts (CSV)". Each saves one file that opens in Excel, with every column of that table under SalesTeam\'s own column names. If a search or column filter is on, SalesTeam asks whether to export all of them or only the filtered ones. For HubSpot, "Export to HubSpot…" saves two files with HubSpot\'s own column names instead.',
  },
  {
    id: "exclude-companies",
    category: "Setup & Target Accounts",
    question: "How do I exclude a company (a competitor or a recruiter)?",
    keywords: ["exclude", "exclusion", "exclusions", "competitor", "competitors", "recruiter", "staffing", "blocklist", "hide company", "remove company", "never show", "companies to exclude", "move to", "other list"],
    answer: 'In Settings > Change Settings > "Companies to exclude" (the same step as in the Setup). It has three tables - Competitors, Recruiters / staffing agencies and Other - each with Company, LinkedIn page and Website, sorted A-Z, with a search box and a count. "+ Add" opens an empty row: give the name, the LinkedIn company page or the website (a LinkedIn page is the surest match), then OK. Each row\'s ⋮ menu has Edit, Remove and, under the heading "Move to" (a heading, not an item to click), the other lists to move the company to - including Customers and Partners. Press Save to keep the changes. An excluded company never shows up as an account, is never researched and its people are never treated as leads (posts). In a team, only the Team Lead can change these lists.',
  },
  {
    id: "customers-partners",
    category: "Setup & Target Accounts",
    question: "How do I mark a company as an existing customer or partner?",
    keywords: ["customer", "customers", "existing customer", "partner", "partners", "reseller", "relationship", "tag", "upsell", "renewal", "not excluded", "customers and partners"],
    answer: 'Customers and partners are not excluded: they stay normal accounts - researched, their contacts found and their leads (posts) kept - with a Customer or Partner tag on the account, its contacts and its leads. Mark one in either of two places: the account\'s ⋮ menu > "Relationship…" (tick Customer and/or Partner / reseller, then Save), or Settings > Change Settings > "Customers and partners", which has a Customers and a Partners / resellers table that work like the exclusion tables. A company can be both. A customer\'s priority is raised one level (P3 becomes P2, P2 becomes P1), with the line "Raised one level: existing customer" in its priority reason, unless you set the priority by hand; taking the tag off brings the old priority back. Sales Mentor, Customer Voice and every draft are told the company is a customer or partner, not a cold prospect. On Target Accounts the Relationship column shows the tag; its header menu filters by Any / Customer / Partner / None. If a company is on an exclusion list too, the exclusion wins and both rows are flagged red in Setup. In a team, only the Team Lead can change this.',
  },
  {
    id: "what-is-negative-topic",
    category: "Negative Topics & Filtering",
    question: "What is a Negative Topic?",
    keywords: ["negative topic", "negative filter", "exclude", "block", "blocklist", "filter out noise"],
    answer: 'The inverse of a regular Topic: instead of searching FOR it, any lead (post) matching a Negative Topic is marked "Irrelevant" automatically, since it\'s noise (a competitor, a recruiter\'s own post) rather than a real prospect. Checked after results come back - never sent to LinkedIn as a search.',
  },
  {
    id: "block-competitors-recruiters",
    category: "Negative Topics & Filtering",
    question: "How do I stop competitors or recruiters from showing up as leads?",
    keywords: ["competitor", "competitors", "recruiter", "recruiters", "staffing", "headhunter", "head hunter", "hide competitors"],
    answer: 'Several Negative Topics are built in for exactly this, in the Scanner tile. "Competitor Blocklist," "Recruiting Companies" and "Other Excluded Companies" are each just a checkbox now (customers and partners are not filtered out - leads from their people are kept) - the actual company lists live in the Setup\'s "Companies to exclude" step, not here, so edit them there (see "How do I exclude a company?"). "Recruiter/Staffing Headline Filter" is still its own separate, fully editable keyword list (it catches a person\'s own recruiter/staffing job title, not their employer). Add your own Negative Topic for any other kind of noise.',
  },
  {
    id: "apply-negative-filters",
    category: "Negative Topics & Filtering",
    question: "How do I re-apply negative filters to leads I already have, without a new scan?",
    keywords: ["re-apply", "reapply", "apply negative filters", "update existing leads", "retroactive", "without scanning"],
    answer: 'Click "Apply Negative Filters" in the Negative Topics section of the Scanner tile. It re-checks every "New" and "Irrelevant" lead (post) against your current filters right away - no scan needed - and can move leads in either direction (see the next question).',
  },
  {
    id: "irrelevant-back-to-new",
    category: "Negative Topics & Filtering",
    question: 'Can a lead marked "Irrelevant" come back to "New"?',
    keywords: ["undo irrelevant", "irrelevant to new", "restore", "revert", "un-block", "unblock", "loosen filter"],
    answer: 'Yes - if you edit or remove the Negative Topic that caught it, click "Apply Negative Filters" and any lead (post) that no longer matches anything reverts to "New" automatically. Leads you\'ve personally set to Dismissed/Contacted/Responded/Converted are never touched by this.',
  },
  {
    id: "why-is-lead-irrelevant",
    category: "Negative Topics & Filtering",
    question: 'Why does a lead show "Irrelevant," and how do I see why?',
    keywords: ["why irrelevant", "reason", "which keyword matched", "hover", "tooltip"],
    answer: 'Hover over the "Irrelevant" status pill on the Leads Dashboard - the tooltip names the exact Negative Topic AND the specific keyword that matched, e.g. \'Recruiter/Staffing Headline Filter (matched "Recruiter")\'.',
  },
  {
    id: "irrelevant-vs-dismissed",
    category: "Negative Topics & Filtering",
    question: '"Irrelevant" vs "Dismissed" - what\'s the difference?',
    keywords: ["irrelevant vs dismissed", "difference between statuses", "dismissed meaning"],
    answer: '"Irrelevant" is set automatically by a Negative Topic match - the system\'s own decision, always reversible. "Dismissed" is a status YOU set by hand from the Leads Dashboard, and is never touched by any automatic filter re-check.',
  },
  {
    id: "show-irrelevant-checkbox",
    category: "Leads Dashboard",
    question: 'How do I see Irrelevant leads on the Leads Dashboard again?',
    keywords: ["show irrelevant", "hidden leads", "where did leads go", "missing leads"],
    answer: 'Check "Show Irrelevant (negative-filtered) leads" next to the Status filter - it\'s unchecked by default to keep the table uncluttered. Or pick "Irrelevant" directly from the Status dropdown, which always shows them regardless of that checkbox.',
  },
  {
    id: "what-is-priority",
    category: "Leads Dashboard",
    question: "What is lead Priority (P1-P5), and how is it calculated?",
    keywords: ["priority", "p1", "p2", "p3", "p4", "p5", "score", "scoring", "how is priority decided"],
    answer: 'After every scan, the Sales Mentor scores each new lead (post) from P1 (highest - contact today) to P5 (lowest), based on real fit against what you sell, seniority, and genuine urgency signals - not just keyword overlap. Hover a priority pill to see its reason.',
  },
  {
    id: "no-priority-yet",
    category: "Leads Dashboard",
    question: "Why doesn't a lead have a priority yet?",
    keywords: ["no priority", "missing priority", "not scored", "unscored"],
    answer: 'Either it predates this feature, or the last scan ran with no Anthropic API key configured (prioritizing is skipped, not failed, in that case). Click "Prioritize Unscored Leads" on the Leads Dashboard to score every unscored lead in one batch, any time.',
  },
  {
    id: "bulk-change",
    category: "Leads Dashboard",
    question: "How do I change the status of many leads at once?",
    keywords: ["bulk change", "bulk status", "change many leads", "mass update", "dismiss all"],
    answer: 'Filter the table to whatever you want to change (e.g. Priority = P4 or P5), then click the small "Bulk Change…" button below the table. It shows exactly how many leads (posts) will be affected and requires you to pick a status and confirm before applying.',
  },
  {
    id: "undo-bulk-change",
    category: "Leads Dashboard",
    question: "How do I undo a bulk status change?",
    keywords: ["undo bulk", "undo mistake", "revert bulk change", "accidentally changed"],
    answer: 'Open the same "Bulk Change…" dialog and click "Undo Last Bulk Change" - it restores every lead (post) from that specific change back to its previous status. Only the single most recent bulk change can be undone this way.',
  },
  {
    id: "sort-filter-column",
    category: "Leads Dashboard",
    question: "How do I sort or filter a specific column in the table?",
    keywords: ["sort column", "filter column", "column dropdown", "excel style", "sort ascending", "sort descending", "empty table", "no leads", "nothing shown", "clear filters", "filters on", "missing leads"],
    answer: 'Click a column\'s title to toggle sort direction, or click the ▾ icon for a menu with Sort Ascending/Descending and a text filter for just that column. A filtered column has a blue header, and every filter that is on (search, status, column filters) is listed above the table, each with its own ✕ and a "Clear all" button. Filters are remembered for next time, so if a table looks empty, look there first. Column widths are also resizable by dragging their edges.',
  },
  {
    id: "export-csv",
    category: "Leads Dashboard",
    question: "How do I export my leads to a CSV file?",
    keywords: ["export", "csv", "download leads", "spreadsheet"],
    answer: 'On the Leads Dashboard, use "Export All (CSV)" for every lead (post), or "Export Filtered (CSV)" for exactly what the table is currently showing (respecting search, status, and column filters). Accounts and contacts have their own exports on the Target Accounts and Target Contacts Dashboards.',
  },
  {
    id: "search-all-leads",
    category: "Leads Dashboard",
    question: "How do I search across all my leads?",
    keywords: ["search leads", "find a lead", "search box"],
    answer: 'Use the search box at the top of the Leads Dashboard - it matches the title, content and creator name of each lead (post) at once.',
  },
  {
    id: "mentor-vs-customer-voice",
    category: "Advisors (AI)",
    question: "What's the difference between the Sales Mentor and Customer Voice?",
    keywords: ["mentor vs customer voice", "difference between agents", "which agent to ask"],
    answer: 'Sales Mentor gives strategy advice from your side (which lead (post) to prioritize, how to approach one, general sales process questions) and can draft messages. Customer Voice roleplays as a realistic buyer, so you can pressure-test a message or approach before sending it.',
  },
  {
    id: "ask-mentor-about-lead",
    category: "Advisors (AI)",
    question: "How do I ask about one specific lead vs. a general question?",
    keywords: ["specific lead question", "general question", "ask about a lead", "per lead advisor"],
    answer: 'For a question about ONE lead (post) you\'re looking at, use "Consult Sales Mentor" on that lead\'s own detail page on the Leads Dashboard - it already knows that lead\'s details. For strategy questions not tied to one lead, use the Sales Mentor on the Advisors page - it can look up any lead by name if a question needs it.',
  },
  {
    id: "team-what",
    category: "Team",
    question: "Can my whole sales team work with the same accounts and leads?",
    keywords: ["team", "colleagues", "share", "shared", "sharing", "together", "several users", "multiple users", "onedrive", "team use", "collaborate"],
    answer: 'Yes. In a team, colleagues share one set of accounts, contacts and leads (posts) through a OneDrive folder your team owns. Every member\'s SalesTeam reads and writes that folder; changes you make reach your colleagues by themselves, usually within a minute or two, depending on OneDrive, and theirs arrive on your computer. There is no SalesTeam server and no sign-in. One person creates the team and becomes its Team Lead; the others join. Each member still scans LinkedIn with their own LinkedIn account and their own daily limit. Start under Settings > Team.',
  },
  {
    id: "team-create",
    category: "Team",
    question: "How do I start a team?",
    keywords: ["create team", "start team", "new team", "set up team", "team lead", "team admin", "team folder", "share folder"],
    answer: 'Open Settings > Team > Create a team… and follow the numbered steps there: create an empty folder in OneDrive, right-click it and choose "Always keep on this device", share it with your colleagues so they can edit, then enter your name and the team\'s name, click "Choose the folder and create the team…" and choose the folder. If Chrome asks whether SalesTeam may view and edit the folder, choose "Allow on every visit". SalesTeam saves a full backup first, then copies your accounts, contacts, leads (posts), Setup and rules into the folder as the team\'s starting data. You become the Team Lead.',
  },
  {
    id: "team-join",
    category: "Team",
    question: "How do I join my team, and what happens to my own data?",
    keywords: ["join team", "join", "invited", "shared folder", "my own accounts", "my data", "replace", "add shortcut", "accounts i have"],
    answer: 'Open the e-mail in which a colleague shared the team folder, click "Add shortcut to My files", and in File Explorer > OneDrive set the folder to "Always keep on this device". Then open Settings > Team > Join a team…, enter your name and pick the folder. SalesTeam saves a full backup of your data first. Joining replaces the accounts, contacts, leads (posts), Setup and rules in this browser with the team\'s; accounts you have that the team does not are listed for you to tick, and the ones you tick are added to the team, assigned to you. Accounts both you and the team have, which you have already worked on, go to the Team Lead as join proposals under Decisions, who decides who keeps each one. Your API key, User Profile, drafts, Advisors chats, scanner settings, LinkedIn limits and Activity Log stay as they are.',
  },
  {
    id: "team-shared-personal",
    category: "Team",
    question: "What is shared with my team, and what stays on my computer?",
    keywords: ["shared", "personal", "private", "what is shared", "api key", "drafts", "visible to colleagues", "who contacted whom", "privacy", "team data"],
    answer: 'Shared with the whole team: accounts, contacts, leads (posts) and their statuses, the Setup (what you sell, ideal customer, target contacts, message templates) and the rules (exclusions, Negative Topics, prioritization). Everyone in the team sees the shared data, including who contacted whom and who changed what. Personal, never written to the team folder: your Anthropic API key, User Profile, drafts, Advisors chats, scanner settings (Topics, timeframe, job search), LinkedIn limits and counters, web budget and your Activity Log. The team folder lives in your team\'s own OneDrive; SalesTeam has no server and never sees it.',
  },
  {
    id: "team-assign",
    category: "Team",
    question: "How do I keep a colleague from working on an account I am working on?",
    keywords: ["assign", "assign to me", "release", "claim", "my accounts", "mine", "others", "unassigned", "owner", "badge", "blocked", "colleague", "collision", "work queue"],
    answer: 'Use "Assign to me" in the account\'s ⋮ menu (on the list row or on the account page). The account is then yours: colleagues can still read it, but only you can change it, work its contacts and leads (posts), and only your automatic preparation works on it. "Release" makes it unassigned again. The Company column shows "Mine" or the colleague\'s name, and the Mine / Others / Unassigned / All buttons above the Target Accounts table filter by it. On LinkedIn, a small badge on a company or profile page shows whom that account is assigned to.',
  },
  {
    id: "team-updating",
    category: "Team",
    question: 'Why does an account say "Checking with the team" or that a colleague is updating it?',
    keywords: ["checking with the team", "updating", "is updating", "blocked", "only can edit", "kept aside", "apply my changes", "lost", "a few seconds before you", "conflict"],
    answer: 'When you start changing an unassigned account, SalesTeam first checks that no colleague started on it at the same moment ("Checking with the team…", usually a few seconds). You can go on working; your changes stay on your computer until the check is done. If a colleague was a few seconds earlier, SalesTeam tells you, keeps your changes aside and offers "Apply my changes now" once the account is free again. While a colleague is updating an account, or it is assigned to them, you can read it but not change it. Nothing is ever silently overwritten.',
  },
  {
    id: "team-reconnect",
    category: "Team",
    question: 'What do "Click to reconnect to the team folder" and "Not in sync" mean?',
    keywords: ["reconnect", "not in sync", "team folder", "not connected", "offline", "sync", "onedrive paused", "permission", "allow on every visit", "read only"],
    answer: '"Click to reconnect" appears when Chrome needs your permission again to use the team folder (for example after you chose "Allow this time"). Click the top bar and allow it; choosing "Allow on every visit" avoids the question. Until then your changes wait on your computer and colleagues\' changes do not arrive. "Not in sync" means the team folder could not be read or written for a few minutes - OneDrive paused or signed out, the computer offline, or the folder not kept on this device. You can still read everything; changes are blocked until the folder works again, so that nobody works on old data. SalesTeam shares while a SalesTeam page or the side panel is open.',
  },
  {
    id: "team-admin",
    category: "Team",
    question: "What can only the Team Lead do?",
    keywords: ["team lead", "team admin", "admin", "administrator", "deputy", "roles", "permissions", "reassign", "release all", "remove", "restore", "setup", "remove from team", "join proposals"],
    answer: 'The Team Lead (the person who created the team) changes the Setup and the rules - members see them read-only. Only the Team Lead can remove and restore accounts and contacts, reassign a colleague\'s account or release all accounts of a colleague (for example when someone has left), decide join proposals under Decisions, and take a member off the team (Settings > Team > Remove from team…). Like everyone else, the Team Lead cannot change an account assigned to a colleague; to work on it, they reassign it to themselves first, and the colleague is told.',
  },
  {
    id: "team-log",
    category: "Team",
    question: "How do I see what my colleagues changed?",
    keywords: ["who changed", "colleagues changes", "team log", "activity log", "history", "audit", "who did what"],
    answer: 'Open the Activity Log and pick "Colleagues" (what your colleagues changed in the shared data, with the value before and after) or "Team" (every shared change in the team, yours included, with assignments, joins and leaves). Settings > Team lists the members, their role, whether they are online and how many accounts each has assigned.',
  },
  {
    id: "team-leave",
    category: "Team",
    question: "How do I leave a team?",
    keywords: ["leave team", "leave", "quit team", "stop sharing", "solo", "exit team"],
    answer: 'Settings > Team > Leave the team. This browser stops sharing; the data here stays as it is now, as your own copy. Your assigned accounts are released for your colleagues. Your files stay in the team folder for the record, and the Team Lead can take you off the members list.',
  },
  {
    id: "set-api-key",
    category: "Settings & Backup",
    question: "Where do I set my Anthropic API key?",
    keywords: ["api key", "anthropic key", "set up ai", "claude key"],
    answer: 'On the Settings page (its own blue button in the Scanner tile). It\'s stored only on this device and used only to call Anthropic\'s API directly from your browser - scanning itself never needs a key, only the AI features do.',
  },
  {
    id: "what-we-offer",
    category: "Settings & Backup",
    question: "Where do I describe what my company sells?",
    keywords: ["what we offer", "company context", "our services", "what do we sell"],
    answer: 'In Settings > Change Settings > "What you sell" (the same step as in the Setup). Every AI feature (drafting, Sales Mentor, Customer Voice) uses this to reason about real fit against a lead (post), not just react to their post in isolation. SalesTeam can also propose this text from your company\'s website - see "Can SalesTeam fill in the Setup for me?"',
  },
  {
    id: "message-templates",
    category: "Settings & Backup",
    question: "How do I edit message templates?",
    keywords: ["message template", "draft template", "edit template", "outreach template"],
    answer: 'On the Settings page, under "Message templates." The right one is auto-picked per lead (post) based on connection status and whether it\'s a hiring post, or you can choose manually on a lead\'s Dashboard detail page.',
  },
  {
    id: "backup-transfer",
    category: "Settings & Backup",
    question: "How do I back up my settings and leads, or move them to another computer?",
    keywords: ["backup", "export settings", "import settings", "transfer", "another computer", "move data"],
    answer: 'Use "Export" / "Import" in the Scanner tile - it saves everything (Topics, Negative Topics, leads (posts), templates) as one JSON file. Your API key is excluded by default; check the box if you deliberately want to include it.',
  },
];

const STOP_WORDS = new Set([
  "a", "an", "the", "how", "can", "i", "do", "does", "is", "are", "to", "of", "in", "on", "for", "my",
  "it", "this", "that", "with", "and", "or", "what", "when", "where", "why", "will", "me", "not", "so",
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

for (const entry of QA) {
  entry._searchTokens = tokenize([entry.question, ...entry.keywords].join(" "));
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Exact match scores highest; a shared prefix (e.g. "block"/"blocklist") or
// a short edit-distance (typo tolerance, scaled to word length so it's
// stricter on short words) score lower but nonzero.
function wordSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length > 2 && b.length > 2 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
  if (a.length >= 4 && b.length >= 4) {
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    if (dist === 1) return 0.75;
    if (dist === 2 && maxLen >= 7) return 0.5;
  }
  return 0;
}

// Average, over each query token, of its best similarity to any token in
// the entry - so a query only needs to share its IMPORTANT words with an
// entry's question/keywords, not match the exact phrasing.
function scoreEntry(queryTokens, entry) {
  if (queryTokens.length === 0) return 0;
  let total = 0;
  for (const qTok of queryTokens) {
    let best = 0;
    for (const eTok of entry._searchTokens) {
      const sim = wordSimilarity(qTok, eTok);
      if (sim > best) best = sim;
    }
    total += best;
  }
  return total / queryTokens.length;
}

const MATCH_THRESHOLD = 0.45;

export function searchHelp(query) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  return QA
    .map((entry) => ({ entry, score: scoreEntry(queryTokens, entry) }))
    .filter((r) => r.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.entry);
}

export function allHelpEntriesByCategory() {
  return CATEGORIES.map((category) => ({
    category,
    entries: QA.filter((e) => e.category === category),
  })).filter((group) => group.entries.length > 0);
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

const searchInput = document.getElementById("help-search-input");
const resultsEl = document.getElementById("help-results");
const noResultsEl = document.getElementById("help-no-results");

function makeQaCard(entry) {
  const card = document.createElement("div");
  card.className = "qa-card";
  const q = document.createElement("button");
  q.type = "button";
  q.className = "qa-question";
  q.title = "Click to expand/collapse the answer";
  q.textContent = entry.question;
  const a = document.createElement("p");
  a.className = "qa-answer";
  a.textContent = entry.answer;
  a.hidden = true;
  q.addEventListener("click", () => {
    a.hidden = !a.hidden;
    q.classList.toggle("qa-question-open", !a.hidden);
  });
  card.append(q, a);
  return card;
}

function renderDefault() {
  resultsEl.innerHTML = "";
  noResultsEl.hidden = true;
  for (const { category, entries } of allHelpEntriesByCategory()) {
    const heading = document.createElement("h3");
    heading.textContent = category;
    resultsEl.appendChild(heading);
    for (const entry of entries) resultsEl.appendChild(makeQaCard(entry));
  }
}

function renderSearchResults(query) {
  const matches = searchHelp(query);
  resultsEl.innerHTML = "";
  if (matches.length === 0) {
    noResultsEl.hidden = false;
    return;
  }
  noResultsEl.hidden = true;
  const heading = document.createElement("h3");
  heading.textContent = `Results for "${query}"`;
  resultsEl.appendChild(heading);
  for (const entry of matches) {
    const card = makeQaCard(entry);
    card.querySelector(".qa-answer").hidden = false; // search results open by default - no extra click needed
    card.querySelector(".qa-question").classList.add("qa-question-open");
    resultsEl.appendChild(card);
  }
}

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  if (q.length === 0) renderDefault();
  else renderSearchResults(q);
});

document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
renderDefault();
