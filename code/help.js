// A curated FAQ + fuzzy free-text search, deliberately NOT an AI feature -
// no API key needed, instant, and the answers are exact/reviewed rather than
// generated. "Fuzzy" here means token-overlap across a question's own
// synonyms (so "enable topic" and "disable a search topic" hit the same
// entry) plus light typo tolerance (edit-distance on individual words) -
// not semantic/AI matching.

const CATEGORIES = ["Scanning & Topics", "Negative Topics & Filtering", "Dashboard & Leads", "Advisors (AI)", "Settings & Backup"];

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
    id: "manual-only",
    category: "Scanning & Topics",
    question: "Does SalesTeam scan automatically, or only when I click?",
    keywords: ["automatic", "background", "schedule", "scheduled", "run on its own", "manual"],
    answer: 'Manual only, by design - nothing runs on a schedule or in the background. Every scan starts with you clicking "Scan All Topics," so it behaves like a person browsing, not a bot.',
  },
  {
    id: "what-is-negative-topic",
    category: "Negative Topics & Filtering",
    question: "What is a Negative Topic?",
    keywords: ["negative topic", "negative filter", "exclude", "block", "blocklist", "filter out noise"],
    answer: 'The inverse of a regular Topic: instead of searching FOR it, any lead matching a Negative Topic is marked "Irrelevant" automatically, since it\'s noise (a competitor, a recruiter\'s own post) rather than a real prospect. Checked after results come back - never sent to LinkedIn as a search.',
  },
  {
    id: "block-competitors-recruiters",
    category: "Negative Topics & Filtering",
    question: "How do I stop competitors or recruiters from showing up as leads?",
    keywords: ["competitor", "competitors", "recruiter", "recruiters", "staffing", "headhunter", "head hunter", "hide competitors"],
    answer: 'Two Negative Topics are built in for exactly this - "Competitor Blocklist" and "Recruiter/Staffing Headline Filter" - in the Scanner tile. Edit their keyword lists any time, or add your own Negative Topic for any other kind of noise.',
  },
  {
    id: "apply-negative-filters",
    category: "Negative Topics & Filtering",
    question: "How do I re-apply negative filters to leads I already have, without a new scan?",
    keywords: ["re-apply", "reapply", "apply negative filters", "update existing leads", "retroactive", "without scanning"],
    answer: 'Click "Apply Negative Filters" in the Negative Topics section of the Scanner tile. It re-checks every "New" and "Irrelevant" lead against your current filters right away - no scan needed - and can move leads in either direction (see the next question).',
  },
  {
    id: "irrelevant-back-to-new",
    category: "Negative Topics & Filtering",
    question: 'Can a lead marked "Irrelevant" come back to "New"?',
    keywords: ["undo irrelevant", "irrelevant to new", "restore", "revert", "un-block", "unblock", "loosen filter"],
    answer: 'Yes - if you edit or remove the Negative Topic that caught it, click "Apply Negative Filters" and any lead that no longer matches anything reverts to "New" automatically. Leads you\'ve personally set to Dismissed/Contacted/Responded/Converted are never touched by this.',
  },
  {
    id: "why-is-lead-irrelevant",
    category: "Negative Topics & Filtering",
    question: 'Why does a lead show "Irrelevant," and how do I see why?',
    keywords: ["why irrelevant", "reason", "which keyword matched", "hover", "tooltip"],
    answer: 'Hover over the "Irrelevant" status pill on the Dashboard - the tooltip names the exact Negative Topic AND the specific keyword that matched, e.g. \'Recruiter/Staffing Headline Filter (matched "Recruiter")\'.',
  },
  {
    id: "irrelevant-vs-dismissed",
    category: "Negative Topics & Filtering",
    question: '"Irrelevant" vs "Dismissed" - what\'s the difference?',
    keywords: ["irrelevant vs dismissed", "difference between statuses", "dismissed meaning"],
    answer: '"Irrelevant" is set automatically by a Negative Topic match - the system\'s own decision, always reversible. "Dismissed" is a status YOU set by hand from the Dashboard, and is never touched by any automatic filter re-check.',
  },
  {
    id: "show-irrelevant-checkbox",
    category: "Dashboard & Leads",
    question: 'How do I see Irrelevant leads on the Dashboard again?',
    keywords: ["show irrelevant", "hidden leads", "where did leads go", "missing leads"],
    answer: 'Check "Show Irrelevant (negative-filtered) leads" next to the Status filter - it\'s unchecked by default to keep the table uncluttered. Or pick "Irrelevant" directly from the Status dropdown, which always shows them regardless of that checkbox.',
  },
  {
    id: "what-is-priority",
    category: "Dashboard & Leads",
    question: "What is lead Priority (P1-P5), and how is it calculated?",
    keywords: ["priority", "p1", "p2", "p3", "p4", "p5", "score", "scoring", "how is priority decided"],
    answer: 'After every scan, the Sales Mentor scores each new lead from P1 (highest - contact today) to P5 (lowest), based on real fit against what you sell, seniority, and genuine urgency signals - not just keyword overlap. Hover a priority pill to see its reason.',
  },
  {
    id: "no-priority-yet",
    category: "Dashboard & Leads",
    question: "Why doesn't a lead have a priority yet?",
    keywords: ["no priority", "missing priority", "not scored", "unscored"],
    answer: 'Either it predates this feature, or the last scan ran with no Anthropic API key configured (prioritizing is skipped, not failed, in that case). Click "Prioritize Unscored Leads" on the Dashboard to score every unscored lead in one batch, any time.',
  },
  {
    id: "bulk-change",
    category: "Dashboard & Leads",
    question: "How do I change the status of many leads at once?",
    keywords: ["bulk change", "bulk status", "change many leads", "mass update", "dismiss all"],
    answer: 'Filter the table to whatever you want to change (e.g. Priority = P4 or P5), then click the small "Bulk Change…" button below the table. It shows exactly how many leads will be affected and requires you to pick a status and confirm before applying.',
  },
  {
    id: "undo-bulk-change",
    category: "Dashboard & Leads",
    question: "How do I undo a bulk status change?",
    keywords: ["undo bulk", "undo mistake", "revert bulk change", "accidentally changed"],
    answer: 'Open the same "Bulk Change…" dialog and click "Undo Last Bulk Change" - it restores every lead from that specific change back to its previous status. Only the single most recent bulk change can be undone this way.',
  },
  {
    id: "sort-filter-column",
    category: "Dashboard & Leads",
    question: "How do I sort or filter a specific column in the table?",
    keywords: ["sort column", "filter column", "column dropdown", "excel style", "sort ascending", "sort descending"],
    answer: 'Click a column\'s title to toggle sort direction, or click the ▾ icon for a menu with Sort Ascending/Descending and a text filter for just that column. Column widths are also resizable by dragging their edges.',
  },
  {
    id: "export-csv",
    category: "Dashboard & Leads",
    question: "How do I export my leads to a CSV file?",
    keywords: ["export", "csv", "download leads", "spreadsheet"],
    answer: 'On the Dashboard, use "Export All (CSV)" for every lead, or "Export Filtered (CSV)" for exactly what the table is currently showing (respecting search, status, and column filters).',
  },
  {
    id: "search-all-leads",
    category: "Dashboard & Leads",
    question: "How do I search across all my leads?",
    keywords: ["search leads", "find a lead", "search box"],
    answer: 'Use the search box at the top of the Dashboard - it matches against a lead\'s title, content, and creator name at once.',
  },
  {
    id: "mentor-vs-customer-voice",
    category: "Advisors (AI)",
    question: "What's the difference between the Sales Mentor and Customer Voice?",
    keywords: ["mentor vs customer voice", "difference between agents", "which agent to ask"],
    answer: 'Sales Mentor gives strategy advice from your side (which lead to prioritize, how to approach one, general sales process questions) and can draft messages. Customer Voice roleplays as a realistic buyer, so you can pressure-test a message or approach before sending it.',
  },
  {
    id: "ask-mentor-about-lead",
    category: "Advisors (AI)",
    question: "How do I ask about one specific lead vs. a general question?",
    keywords: ["specific lead question", "general question", "ask about a lead", "per lead advisor"],
    answer: 'For a question about ONE lead you\'re looking at, use "Consult Sales Mentor" on that lead\'s own Dashboard detail page - it already knows that lead\'s details. For strategy questions not tied to one lead, use the Sales Mentor on the Advisors page - it can look up any lead by name if a question needs it.',
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
    answer: 'On the Settings page, under "What We Offer." Every AI feature (drafting, Sales Mentor, Customer Voice) uses this to reason about real fit against a lead, not just react to their post in isolation.',
  },
  {
    id: "message-templates",
    category: "Settings & Backup",
    question: "How do I edit message templates?",
    keywords: ["message template", "draft template", "edit template", "outreach template"],
    answer: 'On the Settings page, under "Message templates." The right one is auto-picked per lead based on connection status and whether it\'s a hiring post, or you can choose manually on a lead\'s Dashboard detail page.',
  },
  {
    id: "backup-transfer",
    category: "Settings & Backup",
    question: "How do I back up my settings and leads, or move them to another computer?",
    keywords: ["backup", "export settings", "import settings", "transfer", "another computer", "move data"],
    answer: 'Use "Export" / "Import" in the Scanner tile - it saves everything (Topics, Negative Topics, leads, templates) as one JSON file. Your API key is excluded by default; check the box if you deliberately want to include it.',
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
