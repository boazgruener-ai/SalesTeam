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
    answer: "SalesTeam is built with the rules of the online platforms and data sources it works with in mind. Its research draws on publicly available sources: the research prompt has an AI assistant consult public company registries and websites, and SalesTeam's own scans read pages of platforms such as LinkedIn. SalesTeam can also research companies on the public web itself - their own websites and web search results - through your own Anthropic API key, only if you switch web research on and within the monthly budget you set. It is designed for personal use, the way a person would use these sites: every scan starts when you click a button, and automatic account preparation runs only if you switch it on: you start it once; SalesTeam keeps your accounts ready within your daily LinkedIn limit, visible in your browser. Every search and page visit happens in a browser tab or window you can see, only while your browser is open, and you can turn the automation off at any time in Settings. There is no bulk collection of pages. A built-in safety limit keeps the number of searches and page visits per day modest - within what one person could do by hand. SalesTeam has no server or database of its own, so it never collects, resells or shares anyone's data: everything it finds stays on your device (in a team, also in your team's own OneDrive folder), for your own and your team's use, and it never sends messages or connection requests for you. Because each platform's terms of use apply to how any tool is used on it (LinkedIn's terms, for example), we recommend keeping your use moderate and within the daily limit.",
  },
  {
    id: "manual-only",
    category: "Scanning & Topics",
    question: "Does SalesTeam scan automatically, or only when I click?",
    keywords: ["automatic", "automation", "background", "schedule", "scheduled", "run on its own", "manual", "ready", "account preparation", "turn off"],
    answer: 'Scans of posts and jobs are manual: every one starts with you clicking "Scan All Topics." Account preparation is the one thing that can run by itself, and only if you switch it on (at the end of Setup, or in Settings > Automation). You start it once; SalesTeam keeps your accounts ready within your daily LinkedIn limit, visible in your browser. It links accounts to LinkedIn, finds their size and key contacts in a small window of its own, only while your browser is open, and makes way whenever you start a scan. Web research joins in only if you also tick it, within the monthly budget you set. Untick either one in Settings > Automation to stop it.',
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
    answer: 'When you finish the Setup with web research ticked, SalesTeam builds the list for you (the LinkedIn work is a separate choice and is not needed for this). It first adds the companies you named under "Companies to include", then looks for companies that match your Location, Size and Industry answers in company listings on the public web, using web search on your Anthropic API key. Companies under "Companies to exclude" are never added. New accounts show "Web" as their Source. Each account is then researched on the web for what it still lacks (size, contacts, initiatives) within the monthly web budget you set, and checked on LinkedIn within your daily limit. The Setup\'s last step, "How big is your list", sets how many accounts, contacts per account and initiatives to aim for, and shows the estimated cost and time.',
  },
  {
    id: "export-accounts-contacts",
    category: "Setup & Target Accounts",
    question: "How do I export my accounts or contacts to Excel?",
    keywords: ["export", "csv", "excel", "spreadsheet", "download accounts", "download contacts", "accounts list", "contacts list", "crm", "salesforce", "hubspot", "dynamics"],
    answer: 'Use "Export…" in the Target Accounts Dashboard menu (or in the Target Contacts Dashboard menu for contacts). Choose the format - CSV with SalesTeam\'s own column names, which opens in Excel, or HubSpot, Salesforce or Microsoft Dynamics, each with its own column names - and what to export: accounts, contacts, or both (the accounts and their contacts, as two files). If a search or column filter is on, SalesTeam asks whether to export all of them or only the filtered ones. For HubSpot, Salesforce and Microsoft Dynamics, import the accounts (companies) file first, then the contacts file.',
  },
  {
    id: "import-accounts-contacts",
    category: "Setup & Target Accounts",
    question: "How do I import accounts or contacts from a file?",
    keywords: ["import", "import accounts", "import contacts", "csv", "excel", "workbook", "hubspot", "salesforce", "dynamics", "crm", "add accounts", "upload", "file"],
    answer: 'Use "Import…" in the Target Accounts Dashboard menu (or in the Target Contacts Dashboard menu). Choose the file type - a SalesTeam CSV, a HubSpot export, a Salesforce export, a Microsoft Dynamics export or a research workbook - then accounts, contacts or both, and choose the file. Before anything is saved, SalesTeam shows what the import will do: how many accounts and contacts are new, how many empty fields will be filled and how many differences it found - open "Details" there to see each one. An import only adds and fills in - nothing you have is replaced or removed - and a safety copy of your data is saved first. Where the file and an account disagree by more than 10%, the same rules as for web findings decide; the differences that could change a priority come to Decisions as "Import difference", where you choose "Keep current" or "Use import". In a team, Import… is for the Team Lead and the deputy.',
  },
  {
    id: "import-currency",
    category: "Setup & Target Accounts",
    question: "Why does Import ask me for a currency?",
    keywords: ["currency", "import", "revenue", "usd", "chf", "eur", "which currency", "wrong currency"],
    answer: 'Because the file has revenue figures but does not say in which currency, and SalesTeam never guesses - a file in Swiss francs read as US dollars would make every revenue wrong. Choose the currency of the file and press Continue. If the figures look like another currency than the one you chose, SalesTeam says so before you continue. Files exported from SalesTeam name their currency and are not asked.',
  },
  {
    id: "crm-salesforce",
    category: "Setup & Target Accounts",
    question: "How do I move my accounts and contacts into Salesforce?",
    keywords: ["salesforce", "crm", "export", "data import wizard", "accounts", "contacts", "duplicate", "import twice", "update existing"],
    answer: 'Use "Export…", choose Salesforce and "Both". You get an accounts file and a contacts file with Salesforce\'s own column names. In Salesforce, open the Data Import Wizard and import the accounts file first, then the contacts file - each contact is linked to its account by Account Name, and every column is mapped by itself. Type is Customer, Partner or Prospect; the priority, the LinkedIn page, your notes and SalesTeam\'s id are in Description. Annual Revenue is in your default currency, which the export pop-up names. Import each file once: a second import of the same file is refused by Salesforce\'s own duplicate rules. To bring in later changes - new notes, for example - choose "Update existing records" where your Salesforce offers it; the short import on the Accounts list only adds accounts that are new and skips the ones it already has. Salesforce may also skip a person who has the same name at two accounts - that is a duplicate rule of your Salesforce organisation, not an error in the file. To go the other way, export accounts or contacts from Salesforce as CSV and use "Import…" with Salesforce.',
  },
  {
    id: "crm-dynamics",
    category: "Setup & Target Accounts",
    question: "How do I move my accounts and contacts into Microsoft Dynamics?",
    keywords: ["dynamics", "microsoft dynamics", "dynamics 365", "crm", "export", "export to excel", "import from csv", "accounts", "contacts"],
    answer: 'Use "Export…", choose Microsoft Dynamics and "Both". You get an accounts file and a contacts file with the column names of Dynamics 365 Sales. In Dynamics, import the accounts file first (Accounts > Import from Excel > Import from CSV), then the contacts file the same way under Contacts - each contact is linked to its account by Company Name. Relationship Type is Customer, Partner or Prospect. The industry, the priority, the LinkedIn page and SalesTeam\'s id are in Description: Dynamics\' own Industry field only accepts its own list of values. Annual Revenue is in your default currency, which the export pop-up names. To go the other way, open your accounts or contacts in Dynamics, choose "Export to Excel", and use "Import…" with Microsoft Dynamics - the Excel file is read as it is, whatever language your Dynamics is in. A contact needs a company in the file to be imported.',
  },
  {
    id: "same-person",
    category: "Setup & Target Accounts",
    question: "Why does Decisions ask \"Same person?\"",
    keywords: ["same person", "duplicate contact", "duplicate contacts", "merge contacts", "twice", "keep both", "namesake"],
    answer: 'Because two contacts of the same account look like one person - the same LinkedIn profile, or the same name written differently (with and without a title such as "Dr.", with a middle name or an initial, or "oe" for "ö"). Choose "Merge" to keep one entry with everything both knew, including the status and the conversation, or "Keep both" when they really are two people. New contacts from the web research and from imports are checked the same way, so a person is not added twice.',
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
    id: "notes",
    category: "Setup & Target Accounts",
    question: "Where can I write down what I did or learned about an account, a contact or a lead?",
    keywords: ["notes", "note", "write down", "comment", "comments", "remark", "history", "what happened", "last contact", "timeline", "last note", "journal", "log a call", "add note", "edit note", "delete note"],
    answer: 'In the Notes section: on an account\'s page and a contact\'s page it is directly under the overview, on a lead\'s (post\'s) page under its content. Type the text and press "Add note"; SalesTeam adds the date and, in a team, your name. Nothing is saved until you press the button. The list shows the newest note first, four notes at a time, and scrolls; a long note is cut at two lines and opens with a click. The account page shows one timeline: the notes on the account, on its contacts and on its leads, each marked with what it is about. To change or remove a note, use the ⋮ next to it: you can edit and delete your own notes, and an edited note keeps its date and shows "(edited)". The Target Accounts, Target Contacts and Leads tables have a "Last note" column (on Contacts and Leads, switch it on under Columns); click its title to sort by it. The search box above each table also finds text inside notes. Notes are part of every backup and of the CSV and CRM export files; an import does not read notes.',
  },
  {
    id: "notes-team",
    category: "Team",
    question: "Who sees my notes in a team, and who can change them?",
    keywords: ["notes", "note", "team notes", "shared notes", "colleague notes", "who sees notes", "delete note", "edit note", "team lead notes", "private note"],
    answer: 'Notes are shared: everyone who can see an account sees its notes and the notes on its contacts and leads (posts), with the author\'s name. Anyone who can see an account can add a note, also on an account assigned to a colleague or one a colleague is editing at that moment - writing a note does not take the account. Two notes written at the same moment are both kept. Only the author can edit a note; the author, the Team Lead and the deputy can delete it, and a deleted note is gone for the whole team. There are no private notes. A note you wrote before joining the team carries no name: in the team it can no longer be edited, and only the Team Lead or the deputy can delete it.',
  },
  {
    id: "notes-ai",
    category: "Advisors (AI)",
    question: "Do the Sales Mentor and the message drafts use my notes?",
    keywords: ["notes", "note", "mentor notes", "draft notes", "ai notes", "sent to ai", "privacy", "what is sent", "anthropic", "brochure already sent"],
    answer: 'Yes. When you ask the Sales Mentor about a lead (post) or let SalesTeam draft a message, it is given the latest ten notes on that lead, on its contact and on its account, so a draft does not offer what you already sent and the Mentor knows what was said. The Sales Mentor on an account\'s page reads the account\'s notes (with those on its contacts and leads), and on a contact\'s page the contact\'s and the account\'s notes. Notes are sent to the AI service only at that moment - when you use the Sales Mentor or a message draft - with your own Anthropic API key. Nothing is sent when you only write or read notes.',
  },
  {
    id: "team-what",
    category: "Team",
    question: "Can my whole sales team work with the same accounts and leads?",
    keywords: ["team", "colleagues", "share", "shared", "sharing", "together", "several users", "multiple users", "onedrive", "team use", "collaborate"],
    answer: 'Yes. In a team, colleagues share one set of accounts, contacts and leads (posts) through a OneDrive folder your team owns. Every member\'s SalesTeam reads and writes that folder; changes you make reach your colleagues by themselves, usually within a minute or two, depending on OneDrive, and theirs arrive on your computer. There is no SalesTeam server and no sign-in. One person creates the team and becomes its Team Lead; the others join. Each member still scans LinkedIn with their own LinkedIn account and their own daily limit. Notes on accounts, contacts and leads are shared too, so a colleague who opens an account sees what was already done. Start under Settings > Team.',
  },
  {
    id: "team-create",
    category: "Team",
    question: "How do I start a team?",
    keywords: ["create team", "start team", "new team", "set up team", "team lead", "team admin", "team folder", "share folder"],
    answer: 'Open Settings > Team > Create a team…. Click "Choose the team folder…". In the window that opens, click OneDrive on the left, then New folder, type the team\'s name and press Enter, then Select Folder - and, if your browser asks, "Allow" (or "Allow on every visit" where it is offered). The folder\'s name fills in the team name. Enter your name and the colleagues to invite (name and e-mail), then click "Create the team…". SalesTeam saves a full backup first, then copies your accounts, contacts, leads (posts), Setup and rules into the folder as the team\'s starting data. You become the Team Lead. One step SalesTeam cannot do for you: share the folder with your colleagues in OneDrive (File Explorer > right-click the folder > Share, "Can edit"). You can invite more colleagues later with Settings > Team > Add member….',
  },
  {
    id: "team-join",
    category: "Team",
    question: "How do I join my team, and what happens to my own data?",
    keywords: ["join team", "join", "invited", "shared folder", "my own accounts", "my data", "replace", "add shortcut", "accounts i have"],
    answer: 'You join with an invitation from your Team Lead - ask them to invite you if you have none. 1. In the e-mail from your Team Lead, click Open: the team\'s folder opens on the OneDrive website. 2. There, click "Add shortcut to My files"; after a minute the folder is on your PC too. 3. Back in SalesTeam, open Settings > Team > Join a team, click "Choose your team\'s folder…", then OneDrive on the left, your team\'s folder and Select Folder - and, if your browser asks, "Allow" (or "Allow on every visit" where it is offered). Once your invitation is there, the top bar of every SalesTeam page says so, and Join… takes you straight to it; click Join Team. Your name comes from the invitation. SalesTeam saves a full backup of your data first. Joining replaces the accounts, contacts, leads (posts), Setup and rules in this browser with the team\'s; accounts you have that the team does not are listed for you to tick, and the ones you tick are added to the team, assigned to you. Accounts both you and the team have, which you have already worked on, go to the Team Lead as join proposals under Decisions, who decides who keeps each one. Your API key, User Profile, drafts, Advisors chats, scanner settings, LinkedIn limits and Activity Log stay as they are.',
  },
  {
    id: "team-shared-personal",
    category: "Team",
    question: "What is shared with my team, and what stays on my computer?",
    keywords: ["shared", "personal", "private", "what is shared", "api key", "drafts", "visible to colleagues", "who contacted whom", "privacy", "team data"],
    answer: 'Shared with the whole team: accounts, contacts, leads (posts) and their statuses, the notes on them, the Setup (what you sell, ideal customer, target contacts, message templates) and the rules (exclusions, Negative Topics, prioritization). Everyone in the team sees the shared data, including who contacted whom and who changed what. Personal, never written to the team folder: your Anthropic API key, User Profile, drafts, Advisors chats, scanner settings (Topics, timeframe, job search), LinkedIn limits and counters, web budget and your Activity Log. One thing is shared with the Team Lead and the deputy only: your monthly AI usage total and your number of web researches (see "What does the team spend on AI?"). The team folder lives in your team\'s own OneDrive; SalesTeam has no server and never sees it.',
  },
  {
    id: "team-assign",
    category: "Team",
    question: "How do I keep a colleague from working on an account I am working on?",
    keywords: ["assign", "assign to me", "release", "claim", "my accounts", "mine", "others", "unassigned", "owner", "badge", "blocked", "colleague", "collision", "work queue"],
    answer: 'Use "Assign to me" in the account\'s ⋮ menu (on the list row or on the account page). The account is then yours: colleagues can still read it, but only you can change it, work its contacts and leads (posts), and only your automatic preparation works on it. "Release" makes it unassigned again. The Company column shows "Mine" or the colleague\'s name, and the Mine / Others / Unassigned / All buttons above the Target Accounts table filter by it. Once the Team Lead has set up account groups, the buttons are an "Assigned" dropdown instead (Assigned or not / Assigned to me / Assigned to others / Unassigned), also on Target Contacts and the Leads Dashboard, and you can assign to yourself only accounts of your groups. On LinkedIn, a small badge on a company or profile page shows whom that account is assigned to.',
  },
  {
    id: "team-updating",
    category: "Team",
    question: 'Why does an account say "Checking with the team" or that a colleague is updating it?',
    keywords: ["checking with the team", "updating", "is updating", "blocked", "only can edit", "kept aside", "apply my changes", "lost", "a few seconds before you", "conflict"],
    answer: 'When you start changing an unassigned account, SalesTeam first checks that no colleague started on it at the same moment ("Checking with the team…", usually a few seconds). You can go on working; your changes stay on your computer until the check is done. If a colleague was a few seconds earlier, SalesTeam tells you, keeps your changes aside and offers "Apply my changes now" once the account is free again. While a colleague is updating an account, or it is assigned to them, you can read it but not change it. An account a colleague is updating is free again a few seconds after they save, or after a minute if they changed nothing. Nothing is ever silently overwritten.',
  },
  {
    id: "team-reconnect",
    category: "Team",
    question: 'What do "Click to reconnect to the team folder" and "Not in sync" mean?',
    keywords: ["reconnect", "not in sync", "team folder", "not connected", "offline", "sync", "onedrive paused", "permission", "allow on every visit", "read only"],
    answer: '"Click to reconnect" appears when your browser needs your permission again to use the team folder (for example after you chose "Allow this time"). Click the top bar and allow it; choosing "Allow on every visit", where your browser offers it, avoids the question. Until then your changes wait on your computer and colleagues\' changes do not arrive. "Not in sync" means the team folder could not be read or written for a few minutes - OneDrive paused or signed out, the computer offline, or the folder not kept on this device. You can still read everything; changes are blocked until the folder works again, so that nobody works on old data. SalesTeam shares while a SalesTeam page or the side panel is open.',
  },
  {
    id: "team-admin",
    category: "Team",
    question: "What can only the Team Lead do?",
    keywords: ["team lead", "team admin", "admin", "administrator", "deputy", "roles", "permissions", "reassign", "release all", "remove", "restore", "setup", "remove from team", "join proposals", "groups", "make team lead", "hand over", "close the team", "take over", "team lead gone", "team lead left", "no team lead"],
    answer: 'The Team Lead (at first, the person who created the team) changes the Setup and the rules - members see them read-only. Only the Team Lead invites colleagues (Settings > Team > Add member…; ⋮ Cancel invitation on an Invited row), removes and restores accounts and contacts, reassigns a colleague\'s account or releases all accounts of a colleague (for example when someone has left), decides join proposals under Decisions, and takes a member off the team (⋮ next to the name > Remove from team…). The Team Lead can hand the role to a colleague (⋮ > Make Team Lead…), name a deputy who has the same rights until the Team Lead ends it (⋮ > Make deputy…), and close the team (Close the team…) - everyone then keeps the data as their own copy. If the Team Lead\'s SalesTeam has not been seen in the team for 30 days, Settings > Team offers "Take over as Team Lead…" to the deputy - or, when there is no deputy, to every member - so that a team is never left without a Team Lead; the former Team Lead becomes a Member and can be given the role back. Only the Team Lead and the deputy set up account groups, put members into them and move an account from one group to another; they see every account, whatever its group, and in a team with groups only their SalesTeam looks for new companies (Discovery). Like everyone else, the Team Lead cannot change an account assigned to a colleague; to work on it, they reassign it to themselves first, and the colleague is told.',
  },
  {
    id: "team-groups",
    category: "Team",
    question: "What are account groups, and how do I set them up?",
    keywords: ["group", "groups", "account groups", "territory", "region", "vip", "named accounts", "filter", "new group", "advanced mode", "other", "split accounts", "who sees which accounts", "queues"],
    answer: 'Account groups split the team\'s accounts between the members, for example by country, by size, or as a list of named accounts. Only the Team Lead (and the deputy) sets them up: Settings > Team > Groups > "+ New group". Give the group a name, then choose its kind. "Filter" takes every account that matches the conditions you tick (Region, Country, Size, Local / Global, Industry, Company type, Priority, Relationship) - including accounts found later. "Named accounts" is a list you tick yourself. The kind is fixed once saved. Tick the members, check the preview ("Matches 42 accounts - 30 unassigned, 12 assigned") and click Save; nothing changes before Save. An account can be in several groups. An account that matches no group is in "Other", and a member who is in no group works Other. The Groups table shows each group\'s members and its Accounts, Assigned, Unassigned and Ready counts; click the Accounts, Unassigned or Ready count to open those accounts. As long as there are no groups, everyone sees and works every account.',
  },
  {
    id: "team-groups-member",
    category: "Team",
    question: "Why do I see only some of the team's accounts?",
    keywords: ["only some accounts", "missing accounts", "cannot see", "not in your groups", "my groups", "all my groups", "group dropdown", "hidden", "fewer accounts", "account disappeared", "visibility"],
    answer: 'Your Team Lead has set up account groups. You see and work the accounts of the groups you are in - with their contacts and leads (posts) - on every page, in the counts and charts, in Decisions and in the files you export. The Team Lead and the deputy see everything. Settings > Team > Groups shows the groups and marks yours. If you are in more than one group, the "Group" dropdown above the Target Accounts, Target Contacts and Leads tables switches between "All my groups" and one of them; the "Assigned" dropdown next to it filters by who has the account. The top bar tells you when you are added to or taken out of a group. A lead (post) from a company that is not a team account yet is seen by whoever scanned it and by the Team Lead. Groups organise the work; they are not a way to keep data secret: the team folder and a full backup still hold all of the team\'s data.',
  },
  {
    id: "team-group-move",
    category: "Team",
    question: "What happens when an account moves to another group?",
    keywords: ["move account", "moved to", "another group", "add to group", "remove from group", "no longer in your groups", "waiting for the team lead", "move it", "lost account", "group change", "released"],
    answer: 'Only the Team Lead and the deputy move accounts. For a named-accounts group they use "Add to group…" or "Remove from group…" in the account\'s ⋮ menu or above the table for the ticked accounts; for a filter group they edit the filter, or the account\'s own data. Before saving, SalesTeam says how many accounts move and who loses an assigned account ("Anna 2, Luc 1"). If an account assigned to you moves to a group you are not in, it is released and the top bar tells you ("… moved to VIP - it is no longer in your groups"). If you change an account by hand in a way that would take it out of its group (country, company type, industry), Save is refused - ask the Team Lead to make the change. When research finds new data on an assigned account that would move it (for example a new employee count), the data is saved but the account stays where it is: the Groups column says "waiting for the Team Lead\'s decision", and the Team Lead gets a card under Decisions with "Move it".',
  },
  {
    id: "team-groups-pipeline",
    category: "Team",
    question: "In a team with groups, which accounts does my SalesTeam research?",
    keywords: ["pipeline", "research", "my pipeline researches", "automatic preparation", "which accounts", "api key cost", "discovery", "team lead only", "all accounts", "nobody online", "groups"],
    answer: 'Your automatic preparation and web research work only on accounts of your groups, and share them with the group\'s other members who are online, so no account is researched twice. The research of your groups therefore runs on your own Anthropic API key. Team Lead and deputy: under Settings > Team, "My pipeline researches:" has two choices, saved with Save. "Only accounts no member can work on right now" (the default) covers your own assigned accounts and what nobody else can work on at the moment - a group with no member online, and Other when no member is in it. "All accounts" takes an equal share of every group, which is faster but uses more of your API key. In a team with groups, new companies are looked for (Discovery) only by the Team Lead\'s and the deputy\'s SalesTeam; Web Discovery started by hand works for everyone.',
  },
  {
    id: "team-usage",
    category: "Team",
    question: "What does the team spend on AI? (Team usage)",
    keywords: ["team usage", "cost", "costs", "spend", "usage", "anthropic usage", "billing", "api key cost", "who spends", "monthly total", "web researches", "team total", "joined", "encrypted"],
    answer: 'Every member works with their own Anthropic API key, and Settings > Anthropic Usage shows each member what their own SalesTeam has used in this browser. The Team Lead and the deputy see one more section there, "Team usage": one line per member with the day they joined, this month, last month, the total since joining, the number of web researches this month and when the figures last arrived, plus a team total. Click a column title to sort. Only usage from the day a member joined the team is counted - what someone used before is not shown. Members never see each other\'s figures: each member\'s SalesTeam shares only its monthly total and its number of web researches, and writes them to the team folder encrypted for the Team Lead and the deputy. Nothing about days, features or accounts is shared. The figures are SalesTeam\'s estimates; each member\'s Anthropic Console shows the official cost. "No figures yet - needs SalesTeam 1.2.4" means that colleague has not updated yet.',
  },
  {
    id: "team-two-browsers",
    category: "Team",
    question: "Can I use SalesTeam in two browsers, for example Chrome and Edge?",
    keywords: ["two browsers", "second browser", "chrome and edge", "edge", "another browser", "second pc", "two computers", "same person", "2 browsers", "copy settings"],
    answer: 'We recommend one browser per person. SalesTeam has no sign-in, so a second browser is a second member of the team: it needs its own invitation, it appears as its own line under Settings > Team, and the accounts assigned to you in one browser show in the other as a colleague\'s. If you do need a second browser: the Team Lead invites it under exactly the same name and puts it into the same groups. Everything the team shares - accounts, contacts, leads (posts), notes, the Setup and the rules - is then the same in both. Your own settings (API key, scanner topics, personas, language) are kept per browser; copy them with Settings > Backup in the first browser and Restore in the second, ticking only the settings you want. In "Team usage", the Team Lead sees members with the same name as one line, marked "(2 browsers)".',
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
    answer: 'Normally you ask the Team Lead to remove you (the Team Lead does that in Settings > Team: the ⋮ next to your name, then Remove from team…). When that is not possible, use the "Leave the team…" link at the bottom of Settings > Team. This browser stops sharing; the data here stays as it is now, as your own copy. Your assigned accounts are released for your colleagues. Your files stay in the team folder for the record, and the Team Lead can take you off the members list.',
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
