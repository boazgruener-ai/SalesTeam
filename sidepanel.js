// The main side panel - the extension's home screen. Manages Topics, Job
// Topics, and Negative Topics (add/edit/remove, with a live per-topic search-
// count hint), triggers a scan (background.js) and shows its progress, lists
// results, and provides Export/Import/backup plus the entry points to the
// Dashboard, Advisors, Settings, and Help pages.
import {
  getTopics,
  saveTopics,
  getJobTopics,
  saveJobTopics,
  getResults,
  getTimeframe,
  saveTimeframe,
  getAuthorTitles,
  saveAuthorTitles,
  getAuthorTitleEnabled,
  saveAuthorTitleEnabled,
  getIncludeJobAds,
  saveIncludeJobAds,
  getJobSearchEnabled,
  saveJobSearchEnabled,
  getJobSearchUsePostTopics,
  saveJobSearchUsePostTopics,
  getJobSearchLocation,
  saveJobSearchLocation,
  getJobSearchLocationPresets,
  saveJobSearchLocationPresets,
  getJobSearchTimeframe,
  saveJobSearchTimeframe,
  clearResults,
  exportSettings,
  importSettings,
  getNegativeTopics,
  saveNegativeTopics,
  reapplyBlocklist,
  getAnthropicApiKey,
} from "./storage.js";
import { sortResultsByRelevance } from "./ranking.js";
import { sanitizeApiKey, suggestLookalikeTopics } from "./agent-shared.js";

const openDashboardBtn = document.getElementById("open-dashboard-btn");
const openAdvisorsBtn = document.getElementById("open-advisors-btn");
const openSettingsBtn = document.getElementById("open-settings-btn");
const openHelpBtn = document.getElementById("open-help-btn");
const topicsListEl = document.getElementById("topics-list");
const addTopicBtn = document.getElementById("add-topic-btn");
const suggestTopicsBtn = document.getElementById("suggest-topics-btn");
const suggestTopicsStatusEl = document.getElementById("suggest-topics-status");
const suggestTopicsResultsEl = document.getElementById("suggest-topics-results");
const jobTopicsListEl = document.getElementById("job-topics-list");
const addJobTopicBtn = document.getElementById("add-job-topic-btn");
const scanBtn = document.getElementById("scan-btn");
const progressTextEl = document.getElementById("progress-text");
const resultsListEl = document.getElementById("results-list");
const clearResultsBtn = document.getElementById("clear-results-btn");
const timeframeSelect = document.getElementById("timeframe-select");
const authorTitleInput = document.getElementById("author-title-input");
const authorTitleEnabledCheckbox = document.getElementById("author-title-enabled-checkbox");
const includeJobAdsCheckbox = document.getElementById("include-job-ads-checkbox");
const jobSearchEnabledCheckbox = document.getElementById("job-search-enabled-checkbox");
const jobSearchUsePostTopicsCheckbox = document.getElementById("job-search-use-post-topics-checkbox");
const jobSearchLocationSelect = document.getElementById("job-search-location-select");
const newJobLocationNameInput = document.getElementById("new-job-location-name");
const newJobLocationGeoIdInput = document.getElementById("new-job-location-geoid");
const addJobLocationBtn = document.getElementById("add-job-location-btn");
const negativeTopicsListEl = document.getElementById("negative-topics-list");
const addNegativeTopicBtn = document.getElementById("add-negative-topic-btn");
const reapplyExistingCheckbox = document.getElementById("reapply-existing-checkbox");
const applyNegativeFiltersBtn = document.getElementById("apply-negative-filters-btn");
const applyNegativeFiltersStatus = document.getElementById("apply-negative-filters-status");

let negativeTopics = [];
const jobSearchTimeframeSelect = document.getElementById("job-search-timeframe-select");
const exportBtn = document.getElementById("export-btn");
const exportIncludeApiKeyCheckbox = document.getElementById("export-include-api-key-checkbox");
const importBtn = document.getElementById("import-btn");
const importFileInput = document.getElementById("import-file-input");
const exportCsvBtn = document.getElementById("export-csv-btn");

let topics = [];
let jobTopics = [];
let jobLocationPresets = [];

// Mirrors the limits in background.js - a single OR-group tops out at 6
// terms, and when a topic's optional second "AND with" group is used, the
// combined total across both groups tops out at 9. Lists longer than this
// get auto-split into multiple sub-searches at scan time.
const MAX_OR_TERMS = 6;
const TOTAL_TERM_BUDGET = 9;

// Mirrors background.js's splitBudget() exactly - when both a topic's
// keyword group and its "AND with" group are large, LinkedIn's 9-term
// combined ceiling forces both chunk sizes to shrink below 6, which is what
// makes concept-chunks × AND-chunks multiply up fast. This lets the topic
// editor show the real number of searches a topic will run, instead of the
// user finding out only after asking for a manual audit.
function splitBudget(countA, countB) {
  let sizeA = Math.min(MAX_OR_TERMS, countA);
  let sizeB = Math.min(MAX_OR_TERMS, countB);
  while (sizeA + sizeB > TOTAL_TERM_BUDGET && (sizeA > 1 || sizeB > 1)) {
    if (sizeA >= sizeB && sizeA > 1) sizeA--;
    else if (sizeB > 1) sizeB--;
    else break;
  }
  return { sizeA, sizeB };
}

// Post topics: concept-chunks × AND-chunks (multiplicative) once an AND
// group is present - matches background.js's planTopicChunks.
function countPostSubQueries(keywordCount, andKeywordCount) {
  if (keywordCount === 0) return 0;
  if (andKeywordCount === 0) return Math.ceil(keywordCount / MAX_OR_TERMS);
  const { sizeA, sizeB } = splitBudget(keywordCount, andKeywordCount);
  return Math.ceil(keywordCount / sizeA) * Math.ceil(andKeywordCount / sizeB);
}

// Job topics: one flat combined OR-list (both groups merged), chunked
// straight by MAX_OR_TERMS - matches background.js's jobKeywordChunks.
function countJobSubQueries(keywordCount, andKeywordCount) {
  const total = keywordCount + andKeywordCount;
  return total === 0 ? 0 : Math.ceil(total / MAX_OR_TERMS);
}

function topicChunkHint(keywordCount, andKeywordCount, mode) {
  const n = mode === "jobs"
    ? countJobSubQueries(keywordCount, andKeywordCount)
    : countPostSubQueries(keywordCount, andKeywordCount);
  if (n <= 1) return { text: n === 1 ? "1 search for this topic." : "", warn: false };
  return {
    text: `${n} searches for this topic — LinkedIn splits large keyword lists into multiple searches ` +
      `automatically, so this one topic takes ${n}× as long as a single search.`,
    warn: n >= 6,
  };
}

function newTopic() {
  return { id: crypto.randomUUID(), name: "", keywords: [], andKeywords: [], enabled: true };
}

function applyChunkHint(hintEl, keywordCount, andKeywordCount, mode) {
  const { text, warn } = topicChunkHint(keywordCount, andKeywordCount, mode);
  hintEl.textContent = text;
  hintEl.classList.toggle("keyword-limit-hint-warn", warn);
}

// Shared renderer for both the Post topics list and the Job-specific topics
// list - they're the exact same data shape and editing UI, just persisted
// and stored separately. mode ("posts" or "jobs") picks which chunking math
// the live search-count hint uses, since the two verticals chunk differently.
function renderTopicCards(topicsArray, listEl, { onUpdate, onRemove, mode }) {
  listEl.innerHTML = "";

  if (topicsArray.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No topics yet. Add one below.";
    listEl.appendChild(empty);
    return;
  }

  for (const topic of topicsArray) {
    if (topic.enabled === undefined) topic.enabled = true;
    if (!topic.andKeywords) topic.andKeywords = [];

    const card = document.createElement("div");
    card.className = "topic-card";
    if (!topic.enabled) card.classList.add("topic-disabled");

    const headerRow = document.createElement("div");
    headerRow.className = "topic-header-row";

    const enabledCheckbox = document.createElement("input");
    enabledCheckbox.type = "checkbox";
    enabledCheckbox.checked = topic.enabled;
    enabledCheckbox.title = "Include this topic in the next scan";
    enabledCheckbox.addEventListener("change", () => {
      topic.enabled = enabledCheckbox.checked;
      card.classList.toggle("topic-disabled", !topic.enabled);
      onUpdate();
    });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Topic name (e.g. AI Transformation)";
    nameInput.value = topic.name;
    // "input" (not "change") so this is persisted immediately on every
    // keystroke - otherwise a scan started before blurring the field would
    // read a stale (possibly still-empty) name/keyword list from storage.
    nameInput.addEventListener("input", () => {
      topic.name = nameInput.value;
      onUpdate();
    });

    headerRow.append(enabledCheckbox, nameInput);

    const keywordsTextarea = document.createElement("textarea");
    keywordsTextarea.placeholder = "One keyword or phrase per line";
    keywordsTextarea.value = topic.keywords.join("\n");

    const andLabel = document.createElement("label");
    andLabel.className = "and-keywords-label";
    andLabel.textContent = "AND with (optional) — post must ALSO mention one of these";

    const andKeywordsTextarea = document.createElement("textarea");
    andKeywordsTextarea.placeholder = "e.g. project, development, transformation";
    andKeywordsTextarea.value = topic.andKeywords.join("\n");

    const keywordsHint = document.createElement("p");
    keywordsHint.className = "keyword-limit-hint";
    applyChunkHint(keywordsHint, topic.keywords.length, topic.andKeywords.length, mode);

    keywordsTextarea.addEventListener("input", () => {
      topic.keywords = keywordsTextarea.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      applyChunkHint(keywordsHint, topic.keywords.length, topic.andKeywords.length, mode);
      onUpdate();
    });

    andKeywordsTextarea.addEventListener("input", () => {
      topic.andKeywords = andKeywordsTextarea.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      applyChunkHint(keywordsHint, topic.keywords.length, topic.andKeywords.length, mode);
      onUpdate();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-topic-btn";
    removeBtn.textContent = "Remove topic";
    removeBtn.addEventListener("click", () => onRemove(topic));

    card.append(headerRow, keywordsTextarea, andLabel, andKeywordsTextarea, keywordsHint, removeBtn);
    listEl.appendChild(card);
  }
}

async function persistTopics() {
  await saveTopics(topics);
}

function renderTopics() {
  renderTopicCards(topics, topicsListEl, {
    onUpdate: persistTopics,
    onRemove: (topic) => {
      topics = topics.filter((t) => t.id !== topic.id);
      persistTopics();
      renderTopics();
    },
    mode: "posts",
  });
}

async function persistJobTopics() {
  await saveJobTopics(jobTopics);
}

function renderJobTopics() {
  renderTopicCards(jobTopics, jobTopicsListEl, {
    onUpdate: persistJobTopics,
    onRemove: (topic) => {
      jobTopics = jobTopics.filter((t) => t.id !== topic.id);
      persistJobTopics();
      renderJobTopics();
    },
    mode: "jobs",
  });
}

openDashboardBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

openAdvisorsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("advisors.html") });
});

openSettingsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

openHelpBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
});

addTopicBtn.addEventListener("click", () => {
  topics.push(newTopic());
  persistTopics();
  renderTopics();
});

// "Lookalike" topic suggestions: looks at the salesperson's own best-scoring
// leads (P1, falling back to P1+P2 if there aren't many P1s yet) for keyword
// ideas that would surface more leads like them - review-first, exactly like
// every other config-mutating flow here: nothing is added to Topics until
// the user checks a suggestion and clicks "Add Selected".
let lastLookalikeSuggestions = [];

async function computeQualifyingLeadsForLookalike() {
  const resultsMap = await getResults();
  const leads = Object.values(resultsMap);
  let qualifying = leads.filter((l) => l.priority === 1);
  if (qualifying.length < 5) {
    qualifying = leads.filter((l) => l.priority === 1 || l.priority === 2);
  }
  return qualifying.slice(0, 30);
}

function renderLookalikeSuggestions(suggestions) {
  lastLookalikeSuggestions = suggestions;
  suggestTopicsResultsEl.innerHTML = "";
  const existingTopicOptions = topics
    .map((t) => `<option value="${t.id}">${t.name || "(unnamed topic)"}</option>`)
    .join("");
  suggestions.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "lookalike-suggestion-row";
    const label = document.createElement("label");
    label.className = "checkbox-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(i);
    const exampleCount = s.exampleLeadKeys?.length || 0;
    label.append(
      checkbox,
      document.createTextNode(
        ` ${s.suggestedKeyword} — ${s.rationale} (${exampleCount} example${exampleCount === 1 ? "" : "s"})`
      )
    );
    const select = document.createElement("select");
    select.dataset.index = String(i);
    select.innerHTML = `<option value="__new__">+ New Topic named "${s.suggestedKeyword}"</option>` + existingTopicOptions;
    row.append(label, select);
    suggestTopicsResultsEl.appendChild(row);
  });
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.id = "suggest-topics-add-btn";
  addBtn.textContent = "Add Selected";
  addBtn.addEventListener("click", applySelectedLookalikeSuggestions);
  suggestTopicsResultsEl.appendChild(addBtn);
  suggestTopicsResultsEl.hidden = false;
}

async function applySelectedLookalikeSuggestions() {
  const rows = [...suggestTopicsResultsEl.querySelectorAll(".lookalike-suggestion-row")];
  let added = 0;
  for (const row of rows) {
    const checkbox = row.querySelector("input[type=checkbox]");
    if (!checkbox.checked) continue;
    const suggestion = lastLookalikeSuggestions[Number(checkbox.dataset.index)];
    const select = row.querySelector("select");
    if (select.value === "__new__") {
      topics.push({ id: crypto.randomUUID(), name: suggestion.suggestedKeyword, keywords: [suggestion.suggestedKeyword], andKeywords: [], enabled: true });
    } else {
      const topic = topics.find((t) => t.id === select.value);
      if (topic && !topic.keywords.includes(suggestion.suggestedKeyword)) {
        topic.keywords.push(suggestion.suggestedKeyword);
      }
    }
    added++;
  }
  if (added > 0) {
    await persistTopics();
    renderTopics();
  }
  suggestTopicsStatusEl.textContent = `Added ${added} keyword${added === 1 ? "" : "s"}.`;
  suggestTopicsResultsEl.hidden = true;
  suggestTopicsResultsEl.innerHTML = "";
}

suggestTopicsBtn.addEventListener("click", async () => {
  suggestTopicsBtn.disabled = true;
  suggestTopicsResultsEl.hidden = true;
  suggestTopicsResultsEl.innerHTML = "";
  suggestTopicsStatusEl.textContent = "Looking at your highest-priority leads…";
  try {
    const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
    if (!apiKey) {
      suggestTopicsStatusEl.textContent = "Add an Anthropic API key on the Settings page first.";
      return;
    }
    const qualifying = await computeQualifyingLeadsForLookalike();
    if (qualifying.length === 0) {
      suggestTopicsStatusEl.textContent = "Not enough high-priority leads yet - run a scan first.";
      return;
    }
    const suggestions = await suggestLookalikeTopics(qualifying, { apiKey });
    if (suggestions.length === 0) {
      suggestTopicsStatusEl.textContent = "Nothing new stood out this time.";
      return;
    }
    suggestTopicsStatusEl.textContent = `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} - review and add the ones you want:`;
    renderLookalikeSuggestions(suggestions);
  } catch (err) {
    suggestTopicsStatusEl.textContent = `Something went wrong: ${err.message}`;
  } finally {
    suggestTopicsBtn.disabled = false;
  }
});

addJobTopicBtn.addEventListener("click", () => {
  jobTopics.push(newTopic());
  persistJobTopics();
  renderJobTopics();
});

function linesFrom(textarea) {
  return textarea.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function newNegativeTopic() {
  return { id: crypto.randomUUID(), name: "", keywords: [], andKeywords: [], enabled: true, appliesTo: "both", builtin: false };
}

async function persistNegativeTopics() {
  await saveNegativeTopics(negativeTopics);
}

// Same card shape as renderTopicCards above (name, keywords, optional
// AND-group) - a negative topic is checked the same way, just against an
// already-scraped lead's own text afterward instead of ever being sent to
// LinkedIn as a search query. `builtin` topics just skip the remove button;
// every field on them (including whether they're enabled) stays editable.
function renderNegativeTopics() {
  negativeTopicsListEl.innerHTML = "";

  for (const topic of negativeTopics) {
    if (topic.enabled === undefined) topic.enabled = true;
    if (!topic.andKeywords) topic.andKeywords = [];
    if (!topic.appliesTo) topic.appliesTo = "both";

    const card = document.createElement("div");
    card.className = "topic-card";
    if (!topic.enabled) card.classList.add("topic-disabled");

    const headerRow = document.createElement("div");
    headerRow.className = "topic-header-row";

    const enabledCheckbox = document.createElement("input");
    enabledCheckbox.type = "checkbox";
    enabledCheckbox.checked = topic.enabled;
    enabledCheckbox.title = "Apply this filter on future scans";
    enabledCheckbox.addEventListener("change", () => {
      topic.enabled = enabledCheckbox.checked;
      card.classList.toggle("topic-disabled", !topic.enabled);
      persistNegativeTopics();
    });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Filter name (e.g. Students / Interns)";
    nameInput.value = topic.name;
    nameInput.addEventListener("input", () => {
      topic.name = nameInput.value;
      persistNegativeTopics();
    });

    const appliesToSelect = document.createElement("select");
    appliesToSelect.title = "Which kind of lead this filter checks";
    for (const [value, label] of [["both", "Posts + Jobs"], ["post", "Post leads only"], ["job", "Job listings only"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      appliesToSelect.appendChild(option);
    }
    appliesToSelect.value = topic.appliesTo;
    appliesToSelect.addEventListener("change", () => {
      topic.appliesTo = appliesToSelect.value;
      persistNegativeTopics();
    });

    headerRow.append(enabledCheckbox, nameInput, appliesToSelect);

    const keywordsTextarea = document.createElement("textarea");
    keywordsTextarea.placeholder = "One keyword or phrase per line - a lead matching any one of these is marked Irrelevant";
    keywordsTextarea.value = topic.keywords.join("\n");
    keywordsTextarea.addEventListener("input", () => {
      topic.keywords = linesFrom(keywordsTextarea);
      persistNegativeTopics();
    });

    const andLabel = document.createElement("label");
    andLabel.className = "and-keywords-label";
    andLabel.textContent = "AND with (optional) — lead must ALSO match one of these";

    const andKeywordsTextarea = document.createElement("textarea");
    andKeywordsTextarea.placeholder = "e.g. student, internship";
    andKeywordsTextarea.value = topic.andKeywords.join("\n");
    andKeywordsTextarea.addEventListener("input", () => {
      topic.andKeywords = linesFrom(andKeywordsTextarea);
      persistNegativeTopics();
    });

    card.append(headerRow, keywordsTextarea, andLabel, andKeywordsTextarea);

    if (!topic.builtin) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-topic-btn";
      removeBtn.textContent = "Remove filter";
      removeBtn.addEventListener("click", () => {
        negativeTopics = negativeTopics.filter((t) => t.id !== topic.id);
        persistNegativeTopics();
        renderNegativeTopics();
      });
      card.appendChild(removeBtn);
    }

    negativeTopicsListEl.appendChild(card);
  }
}

addNegativeTopicBtn.addEventListener("click", () => {
  negativeTopics.push(newNegativeTopic());
  persistNegativeTopics();
  renderNegativeTopics();
});

// Immediate, no-scan-needed alternative to the "apply on next scan" checkbox
// above - every field here already autosaves as you type, so by the time
// this is clicked, whatever's on screen is already what's stored; this just
// runs the same bidirectional check against it right now.
applyNegativeFiltersBtn.addEventListener("click", async () => {
  applyNegativeFiltersBtn.disabled = true;
  applyNegativeFiltersStatus.textContent = "Checking existing leads…";
  try {
    const { blockedCount, restoredCount } = await reapplyBlocklist();
    if (blockedCount === 0 && restoredCount === 0) {
      applyNegativeFiltersStatus.textContent = "Done - no leads needed to change.";
    } else {
      const parts = [];
      if (blockedCount > 0) parts.push(`${blockedCount} lead${blockedCount === 1 ? "" : "s"} newly marked Irrelevant`);
      if (restoredCount > 0) parts.push(`${restoredCount} lead${restoredCount === 1 ? "" : "s"} restored to New`);
      applyNegativeFiltersStatus.textContent = `Done - ${parts.join(", ")}.`;
    }
  } finally {
    applyNegativeFiltersBtn.disabled = false;
  }
});

function renderJobLocationOptions(selectedValue) {
  jobSearchLocationSelect.innerHTML = "";

  const anyOption = document.createElement("option");
  anyOption.value = "";
  anyOption.textContent = "Any location";
  jobSearchLocationSelect.appendChild(anyOption);

  for (const preset of jobLocationPresets) {
    const option = document.createElement("option");
    option.value = preset.geoId;
    option.textContent = preset.name;
    jobSearchLocationSelect.appendChild(option);
  }

  jobSearchLocationSelect.value = selectedValue || "";
}

addJobLocationBtn.addEventListener("click", async () => {
  const name = newJobLocationNameInput.value.trim();
  const geoId = newJobLocationGeoIdInput.value.trim();
  if (!name || !geoId) {
    alert("Enter both a location name and its geoId (found via the live-page URL inspection trick).");
    return;
  }

  jobLocationPresets.push({ name, geoId });
  await saveJobSearchLocationPresets(jobLocationPresets);
  renderJobLocationOptions(geoId);
  await saveJobSearchLocation(geoId);

  newJobLocationNameInput.value = "";
  newJobLocationGeoIdInput.value = "";
});

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatDate(epochMs) {
  return epochMs ? new Date(epochMs).toLocaleDateString() : "";
}

function resultsToCsv(sortedResults) {
  const headers = [
    "Type",
    "Author / Job Title",
    "Headline / Company",
    "Location",
    "Topics",
    "Matched Keywords",
    "Snippet",
    "Profile URL",
    "Post/Job URL",
    "Posted",
    "In-Post Job Ad",
    "Hiring Post",
    "Freelance/Contract Post",
    "First Found",
  ];
  const rows = sortedResults.map((r) => {
    const topicNames = r.matchedTopics.map((t) => t.topicName).join("; ");
    const allKeywords = [...new Set(r.matchedTopics.flatMap((t) => t.matchedKeywords || []))].join("; ");
    const isJob = r.type === "job";
    return [
      isJob ? "Job Listing" : "Post",
      isJob ? r.title : r.author,
      isJob ? r.company : r.headline,
      isJob ? r.location : "",
      topicNames,
      allKeywords,
      isJob ? "" : r.snippet,
      isJob ? "" : r.profileUrl,
      isJob ? r.jobUrl : r.postUrl,
      isJob ? r.postedText : r.timestampText,
      !isJob && r.isJobAd ? "Yes" : "No",
      !isJob && r.isHiringPost ? "Yes" : "No",
      !isJob && r.isFreelancePost ? "Yes" : "No",
      formatDate(r.firstSeenAt),
    ];
  });
  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

function buildTagsEl(matchedTopics) {
  const tags = document.createElement("div");
  tags.className = "topic-tags";
  for (const match of matchedTopics) {
    const tag = document.createElement("span");
    tag.className = "topic-tag";
    const keywords = match.matchedKeywords || [];
    tag.textContent = keywords.length > 0 ? `${match.topicName}: ${keywords.join(", ")}` : match.topicName;
    tags.appendChild(tag);
  }
  return tags;
}

function makeLink(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

// Each card links straight into that lead's Dashboard detail page for
// status, drafting, and Sales Mentor consultation - this list stays a fast,
// read-only overview of what a scan just found. See the Dashboard for
// everything else.
function openInDashboard(key) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html#lead=${encodeURIComponent(key)}`) });
}

function renderPostCard(card, result) {
  const header = document.createElement("div");
  header.className = "result-header";

  const author = document.createElement("span");
  author.className = "author";
  author.textContent = result.author || "Unknown author";
  if (result.isNew) {
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = "NEW";
    author.appendChild(badge);
  }
  if (result.isJobAd) {
    const jobBadge = document.createElement("span");
    jobBadge.className = "job-ad-badge";
    jobBadge.textContent = "IN-POST JOB AD";
    author.appendChild(jobBadge);
  }
  if (result.isHiringPost) {
    const hiringBadge = document.createElement("span");
    hiringBadge.className = "hiring-badge";
    hiringBadge.textContent = "HIRING";
    author.appendChild(hiringBadge);
  }
  if (result.isFreelancePost) {
    const freelanceBadge = document.createElement("span");
    freelanceBadge.className = "freelance-badge";
    freelanceBadge.textContent = "FREELANCE/CONTRACT";
    author.appendChild(freelanceBadge);
  }

  if (result.connectionDegree) {
    const degree = document.createElement("span");
    degree.className = "connection-degree";
    degree.textContent = result.connectionDegree;
    author.appendChild(degree);
  }

  const timestamp = document.createElement("span");
  timestamp.className = "timestamp";
  timestamp.textContent = result.timestampText || "";

  header.append(author, timestamp);

  const headline = document.createElement("div");
  headline.className = "headline";
  headline.textContent = result.headline || "";

  const snippet = document.createElement("div");
  snippet.className = "snippet";
  snippet.textContent = result.snippet;

  const links = document.createElement("div");
  if (result.postUrl) links.appendChild(makeLink(result.postUrl, "View Post"));
  if (result.profileUrl) links.appendChild(makeLink(result.profileUrl, "View Profile"));
  const dashboardLink = document.createElement("a");
  dashboardLink.href = "#";
  dashboardLink.textContent = "Open in Dashboard →";
  dashboardLink.addEventListener("click", (event) => {
    event.preventDefault();
    openInDashboard(result.key);
  });
  links.appendChild(dashboardLink);

  card.append(header, headline, buildTagsEl(result.matchedTopics), snippet, links);
}

function renderJobCard(card, result) {
  card.classList.add("job-result-card");

  const header = document.createElement("div");
  header.className = "result-header";

  const title = document.createElement("span");
  title.className = "author";
  title.textContent = result.title || "Untitled role";
  if (result.isNew) {
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = "NEW";
    title.appendChild(badge);
  }
  const jobBadge = document.createElement("span");
  jobBadge.className = "job-ad-badge";
  jobBadge.textContent = "JOB LISTING";
  title.appendChild(jobBadge);

  const timestamp = document.createElement("span");
  timestamp.className = "timestamp";
  timestamp.textContent = result.postedText || "";

  header.append(title, timestamp);

  const headline = document.createElement("div");
  headline.className = "headline";
  headline.textContent = [result.company, result.location].filter(Boolean).join(" · ");

  const links = document.createElement("div");
  if (result.jobUrl) links.appendChild(makeLink(result.jobUrl, "View Job"));
  const dashboardLink = document.createElement("a");
  dashboardLink.href = "#";
  dashboardLink.textContent = "Open in Dashboard →";
  dashboardLink.addEventListener("click", (event) => {
    event.preventDefault();
    openInDashboard(result.key);
  });
  links.appendChild(dashboardLink);

  card.append(header, headline, buildTagsEl(result.matchedTopics), links);
}

function renderResults(sortedResults) {
  resultsListEl.innerHTML = "";

  if (sortedResults.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No results yet. Run a scan to find leads.";
    resultsListEl.appendChild(empty);
    return;
  }

  for (const result of sortedResults) {
    const card = document.createElement("div");
    card.className = "result-card";

    if (result.type === "job") {
      renderJobCard(card, result);
    } else {
      renderPostCard(card, result);
    }

    resultsListEl.appendChild(card);
  }
}

async function renderResultsFromStorage() {
  const resultsMap = await getResults();
  const sorted = sortResultsByRelevance(resultsMap).map((r) => ({ ...r, isNew: false }));
  renderResults(sorted);
}

timeframeSelect.addEventListener("change", () => {
  saveTimeframe(timeframeSelect.value);
});

authorTitleInput.addEventListener("input", () => {
  const titles = authorTitleInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  saveAuthorTitles(titles);
});

authorTitleEnabledCheckbox.addEventListener("change", () => {
  authorTitleInput.disabled = !authorTitleEnabledCheckbox.checked;
  saveAuthorTitleEnabled(authorTitleEnabledCheckbox.checked);
});

includeJobAdsCheckbox.addEventListener("change", () => {
  saveIncludeJobAds(includeJobAdsCheckbox.checked);
});

jobSearchEnabledCheckbox.addEventListener("change", () => {
  saveJobSearchEnabled(jobSearchEnabledCheckbox.checked);
});

jobSearchUsePostTopicsCheckbox.addEventListener("change", () => {
  saveJobSearchUsePostTopics(jobSearchUsePostTopicsCheckbox.checked);
});

jobSearchLocationSelect.addEventListener("change", () => {
  saveJobSearchLocation(jobSearchLocationSelect.value);
});

jobSearchTimeframeSelect.addEventListener("change", () => {
  saveJobSearchTimeframe(jobSearchTimeframeSelect.value);
});

// Shared by the manual Export Settings button and the automatic pre-scan
// backup below. Settings already save immediately on every edit, so this
// isn't protecting against unsaved changes - it's a real file outside
// chrome.storage.local entirely, which is what actually survives things a
// storage-level save can't: switching the unpacked extension to a different
// folder (a different folder path is a different extension ID to Chrome,
// with its own empty storage), a corrupted profile, or an accidental
// uninstall.
async function downloadSettingsBackup(filenamePrefix, includeApiKey = false) {
  const data = await exportSettings(includeApiKey);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenamePrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener("click", async () => {
  const includeApiKey = exportIncludeApiKeyCheckbox.checked;
  if (includeApiKey && !confirm(
    "This export will include your Anthropic API key in plain text. Only send this file to people you " +
    "trust with that key's spending. Continue?"
  )) {
    return;
  }
  await downloadSettingsBackup("salesteam-backup", includeApiKey);
});

importBtn.addEventListener("click", () => {
  importFileInput.click();
});

importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files[0];
  importFileInput.value = "";
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert("That file isn't valid JSON - couldn't import it.");
    return;
  }

  if (!confirm("Import this backup? It will replace your current topics, filters, and results.")) return;

  await importSettings(data);
  await init();
});

exportCsvBtn.addEventListener("click", async () => {
  const resultsMap = await getResults();
  const sorted = sortResultsByRelevance(resultsMap);
  if (sorted.length === 0) {
    alert("No leads to export yet - run a scan first.");
    return;
  }

  const csv = resultsToCsv(sorted);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `linkedin-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

clearResultsBtn.addEventListener("click", async () => {
  if (!confirm("Clear all saved leads? This can't be undone.")) return;
  await clearResults();
  renderResults([]);
});

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  progressTextEl.textContent = "Backing up settings…";
  // A real file outside the extension's own storage - see
  // downloadSettingsBackup's comment for why this is the backup that
  // actually matters, not a chrome.storage.local save (which already
  // happens continuously as you type, independent of scanning).
  await downloadSettingsBackup("salesteam-auto-backup").catch((err) => {
    console.error("[SalesTeam] Pre-scan settings backup failed:", err);
  });
  progressTextEl.textContent = "Starting scan…";
  chrome.runtime.sendMessage({ type: "SCAN_ALL", reapplyToExisting: reapplyExistingCheckbox.checked });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SCAN_PROGRESS") {
    progressTextEl.textContent = `Searching: ${message.topicName} (${message.current} of ${message.total})…`;
  } else if (message?.type === "SCAN_PRIORITIZING") {
    progressTextEl.textContent = `Search done — prioritizing ${message.count} new lead${message.count === 1 ? "" : "s"} with the Sales Mentor…`;
  } else if (message?.type === "SCAN_COMPLETE") {
    const newCount = message.results.filter((r) => r.isNew).length;
    progressTextEl.textContent =
      `Scan complete — ${message.results.length} total leads (${newCount} new).`;
    scanBtn.disabled = false;
    renderResults(message.results);
  } else if (message?.type === "SCAN_ERROR") {
    progressTextEl.textContent = message.message;
    scanBtn.disabled = false;
    renderResultsFromStorage(); // pick up any leads saved before the failure
  }
});

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;

  topics = await getTopics();
  renderTopics();

  jobTopics = await getJobTopics();
  renderJobTopics();

  timeframeSelect.value = await getTimeframe();
  authorTitleInput.value = (await getAuthorTitles()).join("\n");
  authorTitleEnabledCheckbox.checked = await getAuthorTitleEnabled();
  authorTitleInput.disabled = !authorTitleEnabledCheckbox.checked;
  includeJobAdsCheckbox.checked = await getIncludeJobAds();

  jobSearchEnabledCheckbox.checked = await getJobSearchEnabled();
  jobSearchUsePostTopicsCheckbox.checked = await getJobSearchUsePostTopics();
  jobLocationPresets = await getJobSearchLocationPresets();
  renderJobLocationOptions(await getJobSearchLocation());
  jobSearchTimeframeSelect.value = await getJobSearchTimeframe();

  negativeTopics = await getNegativeTopics();
  renderNegativeTopics();

  await renderResultsFromStorage();
}

init();
