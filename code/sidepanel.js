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
  exportSettings,
  importSettings,
  exportLeads,
  importLeads,
  getPendingActivityLogExportDays,
  markActivityLogDayExported,
  getNegativeTopics,
  saveNegativeTopics,
  reapplyBlocklist,
  getAnthropicApiKey,
  getCompanyContext,
  getIdealCustomerProfile,
  appendActivityLog,
} from "./storage.js";
import { sortResultsByRelevance } from "./ranking.js";
import { sanitizeApiKey, suggestLookalikeTopics, analyzePostSearch } from "./agent-shared.js";

// Logs one activity-log entry per real edit (focus -> blur, value actually
// changed), not per keystroke - the field's own existing "input" listener
// keeps saving live as before; this only adds logging on top. Shared across
// every free-text field in this file (topic name/keywords/andKeywords,
// author titles, negative-topic name/keywords) so each site is one line
// instead of a bespoke focus/blur pair.
function logOnBlur(el, { action, labelFor }) {
  let valueAtFocus = el.value;
  el.addEventListener("focus", () => { valueAtFocus = el.value; });
  el.addEventListener("blur", () => {
    if (el.value !== valueAtFocus) {
      appendActivityLog({ actor: "user", action, label: labelFor(valueAtFocus, el.value), prevValue: valueAtFocus, newValue: el.value });
    }
  });
}

const openDashboardBtn = document.getElementById("open-dashboard-btn");
const openAdvisorsBtn = document.getElementById("open-advisors-btn");
const openSettingsBtn = document.getElementById("open-settings-btn");
const openHelpBtn = document.getElementById("open-help-btn");
const openActivityLogBtn = document.getElementById("open-activity-log-btn");
const openTargetAccountsBtn = document.getElementById("open-target-accounts-btn");
const topicsListEl = document.getElementById("topics-list");
const addTopicBtn = document.getElementById("add-topic-btn");
const suggestTopicsBtn = document.getElementById("suggest-topics-btn");
const suggestTopicsStatusEl = document.getElementById("suggest-topics-status");
const suggestTopicsResultsEl = document.getElementById("suggest-topics-results");
const analyzeSearchQualityBtn = document.getElementById("analyze-search-quality-btn");
const searchQualityStatusEl = document.getElementById("search-quality-status");
const searchQualityResultsEl = document.getElementById("search-quality-results");
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
const exportSettingsBtn = document.getElementById("export-settings-btn");
const exportIncludeApiKeyCheckbox = document.getElementById("export-include-api-key-checkbox");
const importSettingsBtn = document.getElementById("import-settings-btn");
const importSettingsFileInput = document.getElementById("import-settings-file-input");
const exportLeadsBtn = document.getElementById("export-leads-btn");
const importLeadsBtn = document.getElementById("import-leads-btn");
const importLeadsFileInput = document.getElementById("import-leads-file-input");
const exportCsvBtn = document.getElementById("export-csv-btn");

let topics = [];
let jobTopics = [];
let jobLocationPresets = [];

// Mirrors the limit in background.js - a single OR-group tops out at 6
// terms. Lists longer than this get auto-split into multiple sub-searches
// at scan time.
const MAX_OR_TERMS = 6;

// Post topics: concept and AND-chunks are each searched independently
// (additive), then joined client-side on post key - matches background.js's
// planTopicChunks/scanAllTopics. This lets the topic editor show the real
// number of searches a topic will run, instead of the user finding out only
// after asking for a manual audit.
function countPostSubQueries(keywordCount, andKeywordCount) {
  if (keywordCount === 0) return 0;
  const conceptChunks = Math.ceil(keywordCount / MAX_OR_TERMS);
  const activityChunks = andKeywordCount > 0 ? Math.ceil(andKeywordCount / MAX_OR_TERMS) : 0;
  return conceptChunks + activityChunks;
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

// Grand total across everything a real scan will actually run - mirrors
// background.js's scanAllTopics exactly: enabled Post topics (AND-style
// chunking), plus, if Job Search is on, enabled Job-only topics (flat
// chunking) and, if "use Post topics for Jobs" is also on, those same Post
// topics AGAIN but flat-chunked for Jobs (Job Search is additive with Posts,
// not either/or - see background.js). Recomputed on every topic/checkbox
// change so growth is visible immediately, not just per-topic.
function updateTotalSearchesHint() {
  const hintEl = document.getElementById("total-searches-hint");
  const enabledPostTopics = topics.filter((t) => t.enabled !== false);
  const postTotal = enabledPostTopics.reduce(
    (sum, t) => sum + countPostSubQueries(t.keywords.length, (t.andKeywords || []).length), 0);

  let jobTotal = 0;
  if (jobSearchEnabledCheckbox.checked) {
    const enabledJobOnlyTopics = jobTopics.filter((t) => t.enabled !== false);
    jobTotal += enabledJobOnlyTopics.reduce(
      (sum, t) => sum + countJobSubQueries(t.keywords.length, (t.andKeywords || []).length), 0);
    if (jobSearchUsePostTopicsCheckbox.checked) {
      jobTotal += enabledPostTopics.reduce(
        (sum, t) => sum + countJobSubQueries(t.keywords.length, (t.andKeywords || []).length), 0);
    }
  }

  const total = postTotal + jobTotal;
  if (total === 0) {
    hintEl.textContent = "";
    return;
  }
  const breakdown = jobSearchEnabledCheckbox.checked ? ` (Posts: ${postTotal}, Jobs: ${jobTotal})` : "";
  hintEl.textContent = `Total: ${total} search${total === 1 ? "" : "es"} this scan will run${breakdown}.`;
  hintEl.classList.toggle("keyword-limit-hint-warn", total >= 30);
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

  const topicKind = mode === "jobs" ? "Job Topic" : "Topic";
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
      const prevValue = topic.enabled;
      topic.enabled = enabledCheckbox.checked;
      card.classList.toggle("topic-disabled", !topic.enabled);
      onUpdate();
      appendActivityLog({
        actor: "user", action: "topic_enabled_changed",
        label: `${topicKind} "${topic.name || "(untitled)"}" ${topic.enabled ? "enabled" : "disabled"}`,
        prevValue, newValue: topic.enabled,
      });
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
    logOnBlur(nameInput, {
      action: "topic_renamed",
      labelFor: (oldVal, newVal) => `${topicKind} renamed: "${oldVal || "(untitled)"}" → "${newVal || "(untitled)"}"`,
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
    logOnBlur(keywordsTextarea, {
      action: "topic_keywords_changed",
      labelFor: (oldVal, newVal) => {
        const oldCount = oldVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
        const newCount = newVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
        return `${topicKind} "${topic.name || "(untitled)"}" keywords changed (${oldCount} → ${newCount} keywords)`;
      },
    });

    andKeywordsTextarea.addEventListener("input", () => {
      topic.andKeywords = andKeywordsTextarea.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      applyChunkHint(keywordsHint, topic.keywords.length, topic.andKeywords.length, mode);
      onUpdate();
    });
    logOnBlur(andKeywordsTextarea, {
      action: "topic_and_keywords_changed",
      labelFor: (oldVal, newVal) => {
        const oldCount = oldVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
        const newCount = newVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
        return `${topicKind} "${topic.name || "(untitled)"}" AND-with keywords changed (${oldCount} → ${newCount} keywords)`;
      },
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-topic-btn";
    removeBtn.title = `Permanently remove this ${topicKind.toLowerCase()}`;
    removeBtn.textContent = "Remove topic";
    removeBtn.addEventListener("click", () => {
      appendActivityLog({
        actor: "user", action: "topic_removed",
        label: `${topicKind} "${topic.name || "(untitled)"}" removed (${topic.keywords.length} keywords)`,
        prevValue: { name: topic.name, keywords: topic.keywords, andKeywords: topic.andKeywords }, newValue: null,
      });
      onRemove(topic);
    });

    card.append(headerRow, keywordsTextarea, andLabel, andKeywordsTextarea, keywordsHint, removeBtn);
    listEl.appendChild(card);
  }
}

async function persistTopics() {
  await saveTopics(topics);
  updateTotalSearchesHint();
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
  updateTotalSearchesHint();
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

openActivityLogBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("activity-log.html") });
});

openTargetAccountsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("target-accounts.html") });
});

addTopicBtn.addEventListener("click", () => {
  topics.push(newTopic());
  persistTopics();
  renderTopics();
  appendActivityLog({ actor: "user", action: "topic_added", label: "Added a new Topic" });
});

// "Lookalike" topic suggestions: looks at the salesperson's own best-scoring
// leads (P1-P3) for keyword ideas that would surface more leads like them -
// review-first, exactly like every other config-mutating flow here: nothing
// is added to Topics until the user checks a suggestion and clicks "Add
// Selected". Post leads only, deliberately - Job leads only ever carry a
// title/company/location (no scraped body text), so there's nothing for the
// Mentor to actually generalize from beyond the title itself, and it would
// just echo job-title language back as a "keyword" - which also can't help,
// since this only ever writes into Post Topics, not Job Topics.
let lastLookalikeSuggestions = [];

async function computeQualifyingLeadsForLookalike() {
  const resultsMap = await getResults();
  const leads = Object.values(resultsMap);
  const qualifying = leads.filter((l) => l.type !== "job" && [1, 2, 3].includes(l.priority));
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
  addBtn.title = "Add the checked keyword suggestions to your Topics";
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
  if (added > 0) {
    appendActivityLog({ actor: "user", action: "lookalike_suggestions_applied", label: `Accepted ${added} Suggest Lookalike Topics keyword${added === 1 ? "" : "s"}`, newValue: added });
  }
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

// "Analyze Post Search Quality": the actual fix for the problem Lookalike
// Topics can't help with (it only has good examples to learn from once
// Posts are already scoring well). Looks at every unactioned ("New") Post
// lead plus the current Topics/Negative Topics config together, and
// proposes specific keyword changes across both - review-first, same as
// everywhere else: nothing is written until "Apply Selected" is clicked.
let lastSearchQualitySuggestions = [];

// Includes Irrelevant leads (not just "New") deliberately - an over-eager
// Negative Topic keyword can be the actual reason for a Post shortage, and
// that's invisible unless the analysis can see what got filtered out. Still
// excludes Dismissed/Contacted/Responded/Converted - those are the human's
// own decisions, not the system's, and not what this is auditing.
async function computeQualifyingLeadsForSearchAnalysis() {
  const resultsMap = await getResults();
  const leads = Object.values(resultsMap).filter((l) => l.type !== "job" && (l.status === "New" || l.status === "Irrelevant"));
  const stats = {
    total: leads.length,
    byStatus: { New: 0, Irrelevant: 0 },
    byPriority: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, unscored: 0 },
    irrelevantByNegativeTopic: {},
  };
  for (const lead of leads) {
    stats.byStatus[lead.status] = (stats.byStatus[lead.status] || 0) + 1;
    if (lead.priority) stats.byPriority[lead.priority]++;
    else stats.byPriority.unscored++;
    if (lead.status === "Irrelevant" && lead.irrelevantReason) {
      const topicName = lead.irrelevantReason.split(" (matched")[0];
      stats.irrelevantByNegativeTopic[topicName] = (stats.irrelevantByNegativeTopic[topicName] || 0) + 1;
    }
  }
  // Cap each status separately so a lopsided total (e.g. mostly Irrelevant)
  // can't crowd the other status out of the example set entirely.
  const byRecency = (a, b) => (b.firstSeenAt || 0) - (a.firstSeenAt || 0);
  const newExamples = leads.filter((l) => l.status === "New").sort(byRecency).slice(0, 20);
  const irrelevantExamples = leads.filter((l) => l.status === "Irrelevant").sort(byRecency).slice(0, 20);
  return { examples: [...newExamples, ...irrelevantExamples], stats };
}

function findTopicArrayByTarget(target) {
  return target === "negativeTopic" ? negativeTopics : topics;
}

function findTopicByName(target, name) {
  const array = findTopicArrayByTarget(target);
  const lower = (name || "").trim().toLowerCase();
  return array.find((t) => (t.name || "").trim().toLowerCase() === lower);
}

function keywordExistsInTopic(topic, keyword) {
  const lower = (keyword || "").trim().toLowerCase();
  return (topic.keywords || []).some((k) => k.toLowerCase() === lower) ||
    (topic.andKeywords || []).some((k) => k.toLowerCase() === lower);
}

function renderSearchAnalysisResults(diagnosis, suggestions) {
  lastSearchQualitySuggestions = suggestions;
  searchQualityResultsEl.innerHTML = "";

  if (diagnosis) {
    const diagnosisEl = document.createElement("p");
    diagnosisEl.className = "field-hint search-quality-diagnosis";
    diagnosisEl.textContent = diagnosis;
    searchQualityResultsEl.appendChild(diagnosisEl);
  }

  const visibleIndexes = [];
  suggestions.forEach((s, i) => {
    // A remove_keyword suggestion referencing a keyword/topic that's since
    // changed (or the AI simply got wrong) would be a broken, confusing
    // action - skip it rather than show something that can't actually apply.
    if (s.action === "remove_keyword") {
      const topic = findTopicByName(s.target, s.topicName);
      if (!topic || !keywordExistsInTopic(topic, s.keyword)) return;
    }
    visibleIndexes.push(i);

    const row = document.createElement("div");
    row.className = "lookalike-suggestion-row";
    const label = document.createElement("label");
    label.className = "checkbox-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(i);
    const targetLabel = s.target === "negativeTopic" ? "Negative Topic" : "Topic";
    const actionLabel = s.action === "remove_keyword" ? "Remove" : "Add";
    const fromTo = s.action === "remove_keyword" ? "from" : s.isNewTopic ? "as a new" : "to";
    label.append(
      checkbox,
      document.createTextNode(
        ` [${targetLabel}] ${actionLabel} "${s.keyword}" ${fromTo} "${s.topicName}" — ${s.rationale}`
      )
    );
    row.appendChild(label);

    if (s.action === "add_keyword") {
      const select = document.createElement("select");
      select.dataset.index = String(i);
      const existingOptions = findTopicArrayByTarget(s.target)
        .map((t) => `<option value="${t.id}">${t.name || "(unnamed topic)"}</option>`)
        .join("");
      select.innerHTML = `<option value="__new__">+ New ${targetLabel} named "${s.topicName}"</option>` + existingOptions;
      // Best-guess default: if the AI's suggested topic name matches an existing one, pre-select it
      // instead of defaulting to "new" - isNewTopic is what the AI itself thinks, but a real match wins.
      const matched = !s.isNewTopic && findTopicByName(s.target, s.topicName);
      if (matched) select.value = matched.id;
      row.appendChild(select);
    }

    searchQualityResultsEl.appendChild(row);
  });

  if (visibleIndexes.length === 0) {
    const noneEl = document.createElement("p");
    noneEl.className = "field-hint";
    noneEl.textContent = "No actionable suggestions this time.";
    searchQualityResultsEl.appendChild(noneEl);
    searchQualityResultsEl.hidden = false;
    return 0;
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.id = "search-quality-apply-btn";
  addBtn.title = "Apply the checked keyword changes to your Topics/Negative Topics";
  addBtn.textContent = "Apply Selected";
  addBtn.addEventListener("click", applySelectedSearchAnalysisSuggestions);
  searchQualityResultsEl.appendChild(addBtn);
  searchQualityResultsEl.hidden = false;
  return visibleIndexes.length;
}

async function applySelectedSearchAnalysisSuggestions() {
  const rows = [...searchQualityResultsEl.querySelectorAll(".lookalike-suggestion-row")];
  let topicsChanged = false;
  let negativeTopicsChanged = false;
  let applied = 0;

  for (const row of rows) {
    const checkbox = row.querySelector("input[type=checkbox]");
    if (!checkbox.checked) continue;
    const suggestion = lastSearchQualitySuggestions[Number(checkbox.dataset.index)];
    const array = findTopicArrayByTarget(suggestion.target);

    if (suggestion.action === "add_keyword") {
      const select = row.querySelector("select");
      if (select.value === "__new__") {
        const newTopicEntry = suggestion.target === "negativeTopic"
          ? { ...newNegativeTopic(), name: suggestion.topicName, keywords: [suggestion.keyword], appliesTo: suggestion.appliesTo || "both" }
          : { ...newTopic(), name: suggestion.topicName, keywords: [suggestion.keyword] };
        array.push(newTopicEntry);
      } else {
        const topic = array.find((t) => t.id === select.value);
        if (topic && !keywordExistsInTopic(topic, suggestion.keyword)) topic.keywords.push(suggestion.keyword);
      }
    } else if (suggestion.action === "remove_keyword") {
      const topic = findTopicByName(suggestion.target, suggestion.topicName);
      if (topic) {
        const lower = suggestion.keyword.trim().toLowerCase();
        topic.keywords = (topic.keywords || []).filter((k) => k.toLowerCase() !== lower);
        topic.andKeywords = (topic.andKeywords || []).filter((k) => k.toLowerCase() !== lower);
      }
    }

    if (suggestion.target === "negativeTopic") negativeTopicsChanged = true;
    else topicsChanged = true;
    applied++;
  }

  if (topicsChanged) { await persistTopics(); renderTopics(); }
  if (negativeTopicsChanged) { await persistNegativeTopics(); renderNegativeTopics(); }

  searchQualityStatusEl.textContent = `Applied ${applied} change${applied === 1 ? "" : "s"}.`;
  searchQualityResultsEl.hidden = true;
  searchQualityResultsEl.innerHTML = "";
  if (applied > 0) {
    appendActivityLog({ actor: "user", action: "search_quality_suggestions_applied", label: `Accepted ${applied} Analyze Post Search Quality suggestion${applied === 1 ? "" : "s"}`, newValue: applied });
  }
}

analyzeSearchQualityBtn.addEventListener("click", async () => {
  analyzeSearchQualityBtn.disabled = true;
  searchQualityResultsEl.hidden = true;
  searchQualityResultsEl.innerHTML = "";
  searchQualityStatusEl.textContent = "Looking at your Post search setup…";
  try {
    const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
    if (!apiKey) {
      searchQualityStatusEl.textContent = "Add an Anthropic API key on the Settings page first.";
      return;
    }
    const { examples, stats } = await computeQualifyingLeadsForSearchAnalysis();
    if (stats.total === 0) {
      searchQualityStatusEl.textContent = "No unactioned Post leads yet - run a scan first.";
      return;
    }
    const companyContext = await getCompanyContext();
    const idealCustomerProfile = await getIdealCustomerProfile();
    const { diagnosis, suggestions } = await analyzePostSearch(examples, topics, negativeTopics, stats, { apiKey, companyContext, idealCustomerProfile });
    const visibleCount = renderSearchAnalysisResults(diagnosis, suggestions);
    searchQualityStatusEl.textContent = visibleCount > 0
      ? `${visibleCount} suggestion${visibleCount === 1 ? "" : "s"} - review and apply the ones you want:`
      : "Analysis complete - no changes suggested.";
  } catch (err) {
    searchQualityStatusEl.textContent = `Something went wrong: ${err.message}`;
  } finally {
    analyzeSearchQualityBtn.disabled = false;
  }
});

addJobTopicBtn.addEventListener("click", () => {
  jobTopics.push(newTopic());
  persistJobTopics();
  renderJobTopics();
  appendActivityLog({ actor: "user", action: "topic_added", label: "Added a new Job Topic" });
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
      const prevValue = topic.enabled;
      topic.enabled = enabledCheckbox.checked;
      card.classList.toggle("topic-disabled", !topic.enabled);
      persistNegativeTopics();
      appendActivityLog({
        actor: "user", action: "negative_topic_enabled_changed",
        label: `Negative Topic "${topic.name || "(untitled)"}" ${topic.enabled ? "enabled" : "disabled"}`,
        prevValue, newValue: topic.enabled,
      });
    });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Filter name (e.g. Students / Interns)";
    nameInput.value = topic.name;
    nameInput.addEventListener("input", () => {
      topic.name = nameInput.value;
      persistNegativeTopics();
    });
    logOnBlur(nameInput, {
      action: "negative_topic_renamed",
      labelFor: (oldVal, newVal) => `Negative Topic renamed: "${oldVal || "(untitled)"}" → "${newVal || "(untitled)"}"`,
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
      const prevValue = topic.appliesTo;
      topic.appliesTo = appliesToSelect.value;
      persistNegativeTopics();
      appendActivityLog({
        actor: "user", action: "negative_topic_applies_to_changed",
        label: `Negative Topic "${topic.name || "(untitled)"}" scope changed`,
        prevValue, newValue: topic.appliesTo,
      });
    });

    headerRow.append(enabledCheckbox, nameInput, appliesToSelect);

    const keywordsTextarea = document.createElement("textarea");
    keywordsTextarea.placeholder = "One keyword or phrase per line - a lead matching any one of these is marked Irrelevant";
    keywordsTextarea.value = topic.keywords.join("\n");
    keywordsTextarea.addEventListener("input", () => {
      topic.keywords = linesFrom(keywordsTextarea);
      persistNegativeTopics();
    });
    logOnBlur(keywordsTextarea, {
      action: "negative_topic_keywords_changed",
      labelFor: (oldVal, newVal) => {
        const oldCount = oldVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
        const newCount = newVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
        return `Negative Topic "${topic.name || "(untitled)"}" keywords changed (${oldCount} → ${newCount} keywords)`;
      },
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
    logOnBlur(andKeywordsTextarea, {
      action: "negative_topic_and_keywords_changed",
      labelFor: (oldVal, newVal) => {
        const oldCount = oldVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
        const newCount = newVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
        return `Negative Topic "${topic.name || "(untitled)"}" AND-with keywords changed (${oldCount} → ${newCount} keywords)`;
      },
    });

    card.append(headerRow, keywordsTextarea, andLabel, andKeywordsTextarea);

    if (!topic.builtin) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-topic-btn";
      removeBtn.title = "Permanently remove this Negative Topic";
      removeBtn.textContent = "Remove filter";
      removeBtn.addEventListener("click", () => {
        negativeTopics = negativeTopics.filter((t) => t.id !== topic.id);
        persistNegativeTopics();
        renderNegativeTopics();
        appendActivityLog({
          actor: "user", action: "negative_topic_removed",
          label: `Negative Topic "${topic.name || "(untitled)"}" removed`,
          prevValue: { name: topic.name, keywords: topic.keywords, andKeywords: topic.andKeywords }, newValue: null,
        });
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
  appendActivityLog({ actor: "user", action: "negative_topic_added", label: "Added a new Negative Topic" });
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
    appendActivityLog({
      actor: "user", action: "negative_filters_applied",
      label: `Applied Negative Filters: ${blockedCount} marked Irrelevant, ${restoredCount} restored to New`,
      newValue: { blockedCount, restoredCount },
    });
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
  appendActivityLog({ actor: "user", action: "timeframe_changed", label: `Posted-within timeframe changed to "${timeframeSelect.value}"`, newValue: timeframeSelect.value });
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
  appendActivityLog({ actor: "user", action: "author_title_filter_toggled", label: `Author title filter ${authorTitleEnabledCheckbox.checked ? "enabled" : "disabled"}`, newValue: authorTitleEnabledCheckbox.checked });
});

includeJobAdsCheckbox.addEventListener("change", () => {
  saveIncludeJobAds(includeJobAdsCheckbox.checked);
  appendActivityLog({ actor: "user", action: "include_job_ads_toggled", label: `Include in-post job ads ${includeJobAdsCheckbox.checked ? "enabled" : "disabled"}`, newValue: includeJobAdsCheckbox.checked });
});

jobSearchEnabledCheckbox.addEventListener("change", () => {
  saveJobSearchEnabled(jobSearchEnabledCheckbox.checked);
  updateTotalSearchesHint();
  appendActivityLog({ actor: "user", action: "job_search_toggled", label: `Job Search ${jobSearchEnabledCheckbox.checked ? "enabled" : "disabled"}`, newValue: jobSearchEnabledCheckbox.checked });
});

jobSearchUsePostTopicsCheckbox.addEventListener("change", () => {
  saveJobSearchUsePostTopics(jobSearchUsePostTopicsCheckbox.checked);
  updateTotalSearchesHint();
  appendActivityLog({ actor: "user", action: "job_search_use_post_topics_toggled", label: `"Also use Post topics for Job Search" ${jobSearchUsePostTopicsCheckbox.checked ? "enabled" : "disabled"}`, newValue: jobSearchUsePostTopicsCheckbox.checked });
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
// The "download" attribute accepts a relative path with folders, which
// Chrome creates/reuses under whatever the browser's own download location
// is - relies on that download location being this project's own folder
// (confirmed), not an arbitrary path this code can't otherwise control.
function downloadJsonAs(data, path) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadJson(data, folder, filenamePrefix) {
  downloadJsonAs(data, `${folder}/${filenamePrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
}

async function downloadSettingsBackup(filenamePrefix, includeApiKey = false) {
  await downloadJson(await exportSettings(includeApiKey), "backup", filenamePrefix);
}

async function downloadLeadsBackup(filenamePrefix) {
  await downloadJson(await exportLeads(), "backup", filenamePrefix);
}

// Piggybacks on the manual Scan trigger (see scanBtn below) rather than a
// background schedule - this app never runs anything on its own. Each
// "closed" day (not today, which is still being written to) gets exported
// exactly once, the first time a scan happens on or after the next day -
// not a true daily cron, but a predictable, permission-free approximation
// of one.
async function exportPendingActivityLogDays() {
  const pending = await getPendingActivityLogExportDays();
  for (const { date, entries } of pending) {
    if (entries.length > 0) downloadJsonAs({ date, entries }, `log/activityLog-${date}.json`);
    await markActivityLogDayExported(date);
  }
}

exportSettingsBtn.addEventListener("click", async () => {
  const includeApiKey = exportIncludeApiKeyCheckbox.checked;
  if (includeApiKey && !confirm(
    "This export will include your Anthropic API key in plain text. Only send this file to people you " +
    "trust with that key's spending. Continue?"
  )) {
    return;
  }
  await downloadSettingsBackup("salesteam-settings-backup", includeApiKey);
  appendActivityLog({ actor: "user", action: "settings_exported", label: "Exported Settings backup" });
});

importSettingsBtn.addEventListener("click", () => {
  importSettingsFileInput.click();
});

importSettingsFileInput.addEventListener("change", async () => {
  const file = importSettingsFileInput.files[0];
  importSettingsFileInput.value = "";
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert("That file isn't valid JSON - couldn't import it.");
    return;
  }

  if (!confirm("Import this settings backup? It will replace your current Topics, filters, and other settings - your leads are never touched by this.")) return;

  await importSettings(data);
  await init();
  appendActivityLog({ actor: "user", action: "settings_imported", label: "Imported Settings backup (replaced current Topics/filters/settings)" });
});

exportLeadsBtn.addEventListener("click", async () => {
  await downloadLeadsBackup("salesteam-leads-backup");
  appendActivityLog({ actor: "user", action: "leads_exported", label: "Exported Leads backup" });
});

importLeadsBtn.addEventListener("click", () => {
  importLeadsFileInput.click();
});

importLeadsFileInput.addEventListener("change", async () => {
  const file = importLeadsFileInput.files[0];
  importLeadsFileInput.value = "";
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert("That file isn't valid JSON - couldn't import it.");
    return;
  }

  const restored = await importLeads(data);
  alert(restored > 0
    ? `Restored ${restored} lead${restored === 1 ? "" : "s"} that weren't already saved locally.`
    : "Nothing to restore - every lead in that backup is already saved locally.");
  if (restored > 0) await renderResultsFromStorage();
  appendActivityLog({ actor: "user", action: "leads_imported", label: `Imported Leads backup - restored ${restored} lead${restored === 1 ? "" : "s"}`, newValue: restored });
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
  a.download = `exports/linkedin-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// Visual only - never touches storage. A saved lead is never deleted by
// anything in this app except a user's own explicit per-lead action; this
// just declutters this panel's own view (e.g. before a re-scan). Reopening
// the side panel, or running a new scan, shows every saved lead again.
clearResultsBtn.addEventListener("click", () => {
  renderResults([]);
  appendActivityLog({ actor: "user", action: "results_view_cleared", label: "Cleared results view (leads are not deleted)" });
});

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  progressTextEl.textContent = "Backing up settings and leads…";
  // Real files outside the extension's own storage - see exportSettings'
  // comment for why this is the backup that actually matters, not a
  // chrome.storage.local save (which already happens continuously as you
  // type/scan, independent of this). Two separate files, same reasoning as
  // the manual Export buttons: restoring one should never be able to roll
  // back the other.
  await Promise.all([
    downloadSettingsBackup("salesteam-auto-settings-backup"),
    downloadLeadsBackup("salesteam-auto-leads-backup"),
  ]).catch((err) => {
    console.error("[SalesTeam] Pre-scan backup failed:", err);
  });
  await exportPendingActivityLogDays().catch((err) => {
    console.error("[SalesTeam] Activity Log export failed:", err);
  });
  progressTextEl.textContent = "Starting scan…";
  chrome.runtime.sendMessage({ type: "SCAN_ALL", reapplyToExisting: reapplyExistingCheckbox.checked });
  appendActivityLog({ actor: "user", action: "scan_started", label: "Started a scan" });
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
  updateTotalSearchesHint();

  negativeTopics = await getNegativeTopics();
  renderNegativeTopics();

  await renderResultsFromStorage();

  // Chrome ties storage to the extension's install location - a moved or
  // reinstalled unpacked extension starts genuinely blank even though the
  // old data still exists in a backup file, which is exactly what happened
  // when this project's code moved into /code (v0.27.0). Can't be fixed by
  // auto-restoring (no API lets one extension read another's storage,
  // even a former version of itself under a different path) - this is the
  // next best thing: point straight at the fix instead of leaving it a
  // silent, alarming blank slate.
  const noTopicsConfigured = topics.length === 0 && jobTopics.length === 0;
  const results = await getResults();
  const noLeadsFound = Object.keys(results).length === 0;
  document.getElementById("empty-state-banner").hidden = !(noTopicsConfigured && noLeadsFound);

  // A missing API key silently breaks company extraction, prioritization,
  // Draft Message, and both Advisors chats - each surfaces its own "Add an
  // Anthropic API key" message when actually clicked, but nothing said so
  // up front. Worth flagging distinctly from the banner above: this is the
  // exact gap that bit the empty-install incident (v0.27.1) a second time -
  // a Settings restore brought Topics/leads back but not the key, since it's
  // deliberately excluded from automatic backups and opt-in on a manual
  // export (see downloadSettingsBackup/exportSettingsBtn below). Only shown
  // once there's real data to act on - a genuinely fresh install already
  // gets the banner above, which covers "add a key" as part of setup anyway.
  const hasApiKey = Boolean((await getAnthropicApiKey()) || "");
  const hasSomeData = !noTopicsConfigured || !noLeadsFound;
  document.getElementById("missing-api-key-banner").hidden = hasApiKey || !hasSomeData;
}

init();
