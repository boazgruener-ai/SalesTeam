// PRD 6.20 Phase 10 (2026-09-18) - the Scanner, split out of the side panel
// into its own full tab. Historically this file WAS sidepanel.js - the user
// reframed the side panel's own purpose ("it can stay persistent while
// browsing LinkedIn... an assistant, an entry point, and a preview"), and
// concluded the Scanner "deserves its own big page tab to fit all the
// topics, settings, status and long list of results" (their own words).
// This file is an EXACT, unmodified copy of that original sidepanel.js -
// every id it reads via getElementById still exists in scanner.html
// (reorganized into the new left-nav shell, but nothing renamed or removed)
// - deliberately zero logic changes, to keep this move as low-risk as
// possible. The side panel itself now has its own new, much smaller
// sidepanel.js (Quick Launch + pipeline stats only).
//
// Manages Topics, Job Topics, and Negative Topics (add/edit/remove, with a
// live per-topic search-count hint), triggers a scan (background.js) and
// shows its progress, lists results, and provides Export/Import/backup plus
// the entry points to the Dashboard, Advisors, Settings, and Help pages.
import { askConfirm, mirrorStatusToPopup } from "./confirm-dialog.js";
import { guardBatchStart } from "./batch-jobs.js";
import { initBatchStatus } from "./batch-status.js";
import { applyOnboardingNavState } from "./settings-nav-state.js";
import {
  getTopics,
  saveTopics,
  getJobTopics,
  saveJobTopics,
  getResults,
  getTimeframe,
  saveTimeframe,
  saveAuthorTitles,
  getAuthorTitleEnabled,
  saveAuthorTitleEnabled,
  getTargetContactProfile,
  getIncludeJobAds,
  saveIncludeJobAds,
  getJobSearchEnabled,
  saveJobSearchEnabled,
  getJobSearchUsePostTopics,
  saveJobSearchUsePostTopics,
  getJobSearchLocation,
  getJobSearchUseMainLocation,
  saveJobSearchUseMainLocation,
  getMainLocationForJobs,
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
  getOnboardingCompletedAt,
  getCompanyContext,
  getIdealCustomerProfile,
  appendActivityLog,
  applyExtractedCompanies,
  reapplyLocationFilter,
  ALL_COUNTRIES,
  CONTINENT_LABELS,
  getScanCompanyScope,
  saveScanCompanyScope,
  getScanTargetCompanyIds,
  getAccountReadiness,
} from "./storage.js";
import { MIN_READY_TO_SCAN } from "./readiness.js";
import { getPipelineAutomation } from "./pipeline-automation.js";
import { runAutoBackupIfDue, startAutoBackup } from "./backup-restore.js";
import { mountLocationPicker } from "./location-picker.js";
import { sortResultsByRelevance } from "./ranking.js";
import { sanitizeApiKey, suggestLookalikeTopics, analyzePostSearch } from "./agent-shared.js";
import { leadsMissingProfileData, uniqueProfileCount, profileVisitConfirmText, runProfileExtraction } from "./profile-extraction.js";
import { getLinkedinTouchStats, formatTouchRelease, TOUCH_DANGER_THRESHOLD_24H } from "./linkedin-touch-log.js";

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
const openHelpBtn = document.getElementById("open-help-btn");
const openActivityLogBtn = document.getElementById("open-activity-log-btn");
const openTargetAccountsBtn = document.getElementById("open-target-accounts-btn");
const openTargetContactsBtn = document.getElementById("open-target-contacts-btn");
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
const stopScanBtn = document.getElementById("stop-scan-btn");
const progressTextEl = document.getElementById("progress-text");
const resultsListEl = document.getElementById("results-list");
const clearResultsBtn = document.getElementById("clear-results-btn");
const timeframeSelect = document.getElementById("timeframe-select");
const authorTitleListHintEl = document.getElementById("author-title-list-hint");
const authorTitleEnabledCheckbox = document.getElementById("author-title-enabled-checkbox");
const includeJobAdsCheckbox = document.getElementById("include-job-ads-checkbox");
const jobSearchEnabledCheckbox = document.getElementById("job-search-enabled-checkbox");
const jobSearchUsePostTopicsCheckbox = document.getElementById("job-search-use-post-topics-checkbox");
const scanCompanyScopeSelect = document.getElementById("scan-company-scope-select");
const jobSearchLocationSelect = document.getElementById("job-search-location-select");
const jobUseMainLocationCheckbox = document.getElementById("job-use-main-location-checkbox");
const jobMainLocationHintEl = document.getElementById("job-main-location-hint");
const jobManualLocationEl = document.getElementById("job-manual-location");
const newJobLocationNameInput = document.getElementById("new-job-location-name");
const newJobLocationGeoIdInput = document.getElementById("new-job-location-geoid");
const addJobLocationBtn = document.getElementById("add-job-location-btn");
const negativeTopicsListEl = document.getElementById("negative-topics-list");
const addNegativeTopicBtn = document.getElementById("add-negative-topic-btn");
const reapplyExistingCheckbox = document.getElementById("reapply-existing-checkbox");
const applyNegativeFiltersBtn = document.getElementById("apply-negative-filters-btn");
const applyNegativeFiltersStatus = document.getElementById("apply-negative-filters-status");
mirrorStatusToPopup(["apply-negative-filters-status"]);

let negativeTopics = [];
const jobSearchTimeframeSelect = document.getElementById("job-search-timeframe-select");
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
// Third scan phase (background.js's taSubQueries): Post searches scoped to Target Account
// companies that already have a resolved LinkedIn ID - every enabled topic's keywords merged into
// ONE list, chunked, times the company chunks. Was missing from this hint, which then read
// e.g. 18 while the running scan said "of 78". Kept in sync with background.js's
// AUTHOR_COMPANY_CHUNK_SIZE (100) and MAX_OR_TERMS.
const AUTHOR_COMPANY_CHUNK_SIZE = 100;
let resolvedTargetCompanyCount = 0;

const SCAN_SCOPE_LABELS = { P1: "P1 only", P2: "P1-P2", P3: "P1-P3", all: "all" };
let scanCompanyScope = "P2";
let plannedSearchTotal = 0;

async function refreshResolvedTargetCompanyCount() {
  scanCompanyScope = await getScanCompanyScope();
  resolvedTargetCompanyCount = (await getScanTargetCompanyIds(scanCompanyScope)).length;
  updateTotalSearchesHint();
}

// Compares what this scan needs with what the rolling 24h touch budget still allows, and says when
// more room frees up. Roughly one touch per search - profile visits etc. are extra.
async function renderRunCapacityHint() {
  const el = document.getElementById("run-capacity-hint");
  const stats = await getLinkedinTouchStats();
  const available = stats.availableNow;
  let text = `Touch budget: ${available} of ${TOUCH_DANGER_THRESHOLD_24H} available now (${stats.last24h} used in the last 24h).`;
  const tooBig = plannedSearchTotal > available;
  if (tooBig) text += ` This scan needs about ${plannedSearchTotal}, so it would stop early at the limit.`;
  const release = formatTouchRelease(stats);
  if (release && (tooBig || stats.level !== "ok")) text += ` ${release}`;
  el.textContent = text;
  el.classList.toggle("keyword-limit-hint-warn", tooBig || stats.level !== "ok");
}

function countTargetAccountSubQueries(enabledPostTopics) {
  if (resolvedTargetCompanyCount === 0 || enabledPostTopics.length === 0) return 0;
  const mergedKeywords = new Set(enabledPostTopics.flatMap((t) => [...t.keywords, ...(t.andKeywords || [])]));
  return Math.ceil(mergedKeywords.size / MAX_OR_TERMS) * Math.ceil(resolvedTargetCompanyCount / AUTHOR_COMPANY_CHUNK_SIZE);
}

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

  const targetAccountTotal = countTargetAccountSubQueries(enabledPostTopics);
  const total = postTotal + jobTotal + targetAccountTotal;
  plannedSearchTotal = total;
  renderRunCapacityHint();
  if (total === 0) {
    hintEl.textContent = "";
    return;
  }
  const parts = [`Posts: ${postTotal}`];
  if (jobSearchEnabledCheckbox.checked) parts.push(`Jobs: ${jobTotal}`);
  if (targetAccountTotal > 0) parts.push(`Target Account companies (${SCAN_SCOPE_LABELS[scanCompanyScope] || scanCompanyScope}): ${targetAccountTotal}`);
  const breakdown = parts.length > 1 ? ` (${parts.join(", ")})` : "";
  hintEl.textContent = `Total: ${total} search${total === 1 ? "" : "es"} this scan will run${breakdown}.`;
  hintEl.classList.toggle("keyword-limit-hint-warn", total >= 30);
}

function newTopic() {
  return {
    id: crypto.randomUUID(), name: "", keywords: [], andKeywords: [], enabled: true,
    // Per-topic Location Filter override (PRD Phase 9, 2026-09-16) - see
    // storage.js's effectiveLocationFilterConfigForTopic for how this
    // combines with the general (Settings-wide) config.
    useGeneralLocationFilter: true,
    locationFilterOverride: { mode: "off", continents: [], countries: [] },
  };
}

function applyChunkHint(hintEl, keywordCount, andKeywordCount, mode) {
  const { text, warn } = topicChunkHint(keywordCount, andKeywordCount, mode);
  hintEl.textContent = text;
  hintEl.classList.toggle("keyword-limit-hint-warn", warn);
}

// Per-topic Location Filter override section (PRD Phase 9, 2026-09-16) - a
// checkbox defaulting to "use the general (Settings-wide) config," which
// reveals an inline location-picker.js widget (the same shared module
// Settings' own Location Filter and the onboarding wizard's Location step
// already use) when unchecked. Built with document.createElement rather
// than static HTML ids, since topic cards are a dynamic, add/remove-able
// list - mountLocationPicker just needs real DOM element references, not
// specifically ones with ids. Persists immediately via onUpdate on every
// change (same auto-save-always convention every other topic-card field
// already follows) - unlike Settings' own countries dual-listbox, which
// stages behind an explicit Save button; that difference is a deliberate
// per-caller choice location-picker.js's own header comment says is
// intentionally left to each caller, not something to keep consistent
// between them.
function buildLocationOverrideSection(topic, topicKind, onUpdate) {
  const wrap = document.createElement("div");
  wrap.className = "topic-location-override";

  const toggleLabel = document.createElement("label");
  toggleLabel.className = "topic-location-override-toggle";
  const useGeneralCheckbox = document.createElement("input");
  useGeneralCheckbox.type = "checkbox";
  useGeneralCheckbox.checked = topic.useGeneralLocationFilter;
  toggleLabel.append(useGeneralCheckbox, document.createTextNode(" Use general Location Filter (Settings)"));
  wrap.appendChild(toggleLabel);

  const pickerWrap = document.createElement("div");
  pickerWrap.className = "topic-location-picker-wrap";
  pickerWrap.hidden = topic.useGeneralLocationFilter;
  wrap.appendChild(pickerWrap);

  const modeSelect = document.createElement("select");
  for (const [value, text] of [["off", "Off"], ["continent", "By continent"], ["country", "By country"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    modeSelect.appendChild(option);
  }
  const continentsWrap = document.createElement("div");
  continentsWrap.className = "topic-location-continents-wrap";
  for (const [value, text] of Object.entries(CONTINENT_LABELS)) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "location-continent-checkbox";
    checkbox.value = value;
    label.append(checkbox, document.createTextNode(" " + text));
    continentsWrap.appendChild(label);
  }
  const countriesWrap = document.createElement("div");
  const dualListbox = document.createElement("div");
  dualListbox.className = "dual-listbox";
  const availableCol = document.createElement("div");
  availableCol.className = "dual-listbox-col";
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "Search…";
  const available = document.createElement("select");
  available.multiple = true;
  available.size = 6;
  availableCol.append(search, available);
  const buttonsCol = document.createElement("div");
  buttonsCol.className = "dual-listbox-buttons";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.title = "Add the selected countries";
  addBtn.textContent = "→";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.title = "Remove the selected countries";
  removeBtn.textContent = "←";
  buttonsCol.append(addBtn, removeBtn);
  const selectedCol = document.createElement("div");
  selectedCol.className = "dual-listbox-col";
  const selectedLabel = document.createElement("label");
  const countEl = document.createElement("span");
  countEl.textContent = "0";
  selectedLabel.append("Selected (", countEl, ")");
  const selected = document.createElement("select");
  selected.multiple = true;
  selected.size = 6;
  selectedCol.append(selectedLabel, selected);
  dualListbox.append(availableCol, buttonsCol, selectedCol);
  countriesWrap.appendChild(dualListbox);

  pickerWrap.append(modeSelect, continentsWrap, countriesWrap);

  function persistOverride() {
    topic.locationFilterOverride = picker.getValue();
    onUpdate();
  }
  const picker = mountLocationPicker(
    { modeSelect, continentsWrap, countriesWrap, search, available, selected, addBtn, removeBtn, countEl },
    ALL_COUNTRIES,
    { onCountriesChange: persistOverride, onModeOrContinentChange: persistOverride },
  );
  picker.setValue(topic.locationFilterOverride);

  useGeneralCheckbox.addEventListener("change", () => {
    const prevValue = topic.useGeneralLocationFilter;
    topic.useGeneralLocationFilter = useGeneralCheckbox.checked;
    pickerWrap.hidden = topic.useGeneralLocationFilter;
    onUpdate();
    appendActivityLog({
      actor: "user", action: "topic_location_filter_override_changed",
      label: `${topicKind} "${topic.name || "(untitled)"}" ${topic.useGeneralLocationFilter ? "now uses the general Location Filter" : "now uses its own Location Filter override"}`,
      prevValue, newValue: topic.useGeneralLocationFilter,
    });
  });

  return wrap;
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
    // Backfills a topic saved before the per-topic Location Filter override
    // existed (PRD Phase 9, 2026-09-16) - general by default, same "opt-in
    // override" direction as everywhere else this pattern appears.
    if (topic.useGeneralLocationFilter === undefined) topic.useGeneralLocationFilter = true;
    if (!topic.locationFilterOverride) topic.locationFilterOverride = { mode: "off", continents: [], countries: [] };

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

    const locationOverrideSection = buildLocationOverrideSection(topic, topicKind, onUpdate);

    card.append(headerRow, keywordsTextarea, andLabel, andKeywordsTextarea, keywordsHint, locationOverrideSection, removeBtn);
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

// PRD 6.20 Phase 10 follow-up (2026-09-19), 6th round of direct feedback -
// see target-accounts.js's own copy of this comment for the full
// reasoning: every cross-page item now embeds in place, none open a new
// tab any more, and this page's own #app-nav hides itself when embedded
// elsewhere (the ?embedded=1 check below).
const pageNativeContentEl = document.getElementById("page-native-content");
const embeddedPageWrapEl = document.getElementById("embedded-page-wrap");
const embeddedPageBarEl = document.getElementById("embedded-page-bar");
const embeddedPageFrameEl = document.getElementById("embedded-page-frame");
const embeddedPageTitleEl = document.getElementById("embedded-page-title");

// 19th round of direct feedback (2026-09-19) - see target-accounts.js's own
// copy of this comment for the full reasoning: the host's own #app-nav
// stays visible the whole time an embedded page is showing and already
// works to switch away, so the bar/button is hidden unconditionally now.
function showEmbeddedPage(page, title) {
  const [base, hash] = page.split("#");
  const sep = base.includes("?") ? "&" : "?";
  const url = hash ? `${base}${sep}embedded=1#${hash}` : `${base}${sep}embedded=1`;
  const resolvedUrl = chrome.runtime.getURL(url);
  pageNativeContentEl.hidden = true;
  embeddedPageTitleEl.textContent = title;
  embeddedPageBarEl.hidden = true;
  // 26th round of direct feedback (2026-09-19) - see target-accounts.js's
  // own copy of this comment for the full reasoning: bounced through
  // about:blank first when re-requesting the exact same URL already
  // loaded, since an identical src assignment is a browser no-op
  // (re-clicking the same action item twice in a row would otherwise never
  // re-fire it).
  // Re-requesting the page that is already loaded: navigate the frame in place. (The old "bounce through about:blank
  // then set src again" could be dropped by the browser, leaving the frame blank - reported 2026-09-21: pressing
  // Change Settings a second time showed an empty screen.) A URL that differs only by its #hash is a same-page
  // navigation, so the page's own hashchange routing runs; an identical URL reloads it, re-running its action.
  let sameDocument = false;
  let willLoad = true;
  try {
    sameDocument = Boolean(embeddedPageFrameEl.contentWindow) &&
      embeddedPageFrameEl.contentWindow.location.href.split("#")[0] === resolvedUrl.split("#")[0];
  } catch (err) { /* cross-origin or not loaded yet: fall through to a plain src assignment */ }
  if (sameDocument) {
    // Identical URL (same action pressed again, e.g. after Cancel): a fragment-only "navigation" to it would do
    // nothing, so reload; a URL that differs only by #hash is routed by the page's own hashchange handler.
    const frameWindow = embeddedPageFrameEl.contentWindow;
    if (frameWindow.location.href === resolvedUrl) {
      frameWindow.location.reload();
    } else {
      frameWindow.location.replace(resolvedUrl);
      willLoad = false; // same-page navigation: no load event will follow
    }
  } else {
    embeddedPageFrameEl.src = resolvedUrl;
  }
  // Say so while the page loads - an opening page used to look like a blank screen.
  if (willLoad) {
    embeddedPageWrapEl.classList.add("embedded-loading");
    embeddedPageFrameEl.onload = () => {
      if (!embeddedPageFrameEl.src.startsWith("about:")) embeddedPageWrapEl.classList.remove("embedded-loading");
    };
  } else {
    embeddedPageWrapEl.classList.remove("embedded-loading");
  }
  embeddedPageWrapEl.hidden = false;
}

function hideEmbeddedPage() {
  embeddedPageWrapEl.hidden = true;
  embeddedPageFrameEl.src = "about:blank";
  pageNativeContentEl.hidden = false;
}

// Pages shown inside this one can ask it to close them (e.g. the "Back to menu" link of Change Settings).
window.addEventListener("message", (event) => {
  if (event.origin === location.origin && event.data && event.data.type === "salesteam-close-embedded") hideEmbeddedPage();
});

document.getElementById("embedded-page-close-btn").addEventListener("click", hideEmbeddedPage);
document.getElementById("app-nav-brand-name").addEventListener("click", hideEmbeddedPage);

if (new URLSearchParams(location.search).has("embedded")) {
  document.getElementById("app-shell").classList.add("embedded-mode");
}

openDashboardBtn.addEventListener("click", () => showEmbeddedPage("dashboard.html", "Posts Dashboard"));
document.getElementById("nav-prioritize-unscored-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=prioritize-unscored", "Posts Dashboard"));
document.getElementById("nav-rescore-all-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=rescore-all", "Posts Dashboard"));
document.getElementById("nav-extract-companies-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=extract-companies", "Posts Dashboard"));
document.getElementById("nav-extract-companies-profiles-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=extract-companies-profiles", "Posts Dashboard"));
document.getElementById("nav-apply-location-filter-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=apply-location-filter", "Posts Dashboard"));
document.getElementById("nav-export-csv-all-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=export-csv-all", "Posts Dashboard"));
document.getElementById("nav-export-csv-filtered-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=export-csv-filtered", "Posts Dashboard"));

openAdvisorsBtn.addEventListener("click", () => showEmbeddedPage("advisors.html", "Advisors"));

// Settings' own sections are single-section-routed (settings.js's
// routeSettings), each of these opens straight to that one section.
document.getElementById("open-settings-setup-btn").addEventListener("click", () => showEmbeddedPage("settings.html#setup-section", "Settings"));
document.getElementById("open-settings-change-btn").addEventListener("click", () => showEmbeddedPage("settings.html#change-settings", "Settings"));
applyOnboardingNavState(document.getElementById("open-settings-setup-btn")).catch(() => {});
document.getElementById("open-settings-profile-btn").addEventListener("click", () => showEmbeddedPage("settings.html#profile-section", "Settings"));
document.getElementById("open-settings-automation-btn").addEventListener("click", () => showEmbeddedPage("settings.html#automation-section", "Settings"));
document.getElementById("open-settings-language-btn").addEventListener("click", () => showEmbeddedPage("settings.html#language-section", "Settings"));
document.getElementById("open-settings-apikey-btn").addEventListener("click", () => showEmbeddedPage("settings.html#api-key-section", "Settings"));
document.getElementById("open-settings-backup-btn").addEventListener("click", () => showEmbeddedPage("settings.html#backup-section", "Settings"));
document.getElementById("open-settings-restore-btn").addEventListener("click", () => showEmbeddedPage("settings.html#restore-section", "Settings"));
document.getElementById("open-settings-billing-btn").addEventListener("click", () => showEmbeddedPage("settings.html#billing-section", "Settings"));
// Discrete on purpose (own muted, closed-by-default group at the bottom) -
// reported directly: only for a support session, never normal use.
document.getElementById("open-debug-queue-btn").addEventListener("click", () => showEmbeddedPage("settings.html#discovery-queue-section", "Settings"));
document.getElementById("open-debug-company-btn").addEventListener("click", () => showEmbeddedPage("settings.html#company-discovery-section", "Settings"));
document.getElementById("open-debug-contact-btn").addEventListener("click", () => showEmbeddedPage("settings.html#contact-discovery-section", "Settings"));

openHelpBtn.addEventListener("click", () => showEmbeddedPage("help.html", "Help"));

openActivityLogBtn.addEventListener("click", () => showEmbeddedPage("activity-log.html", "Activity Log"));

openTargetAccountsBtn.addEventListener("click", () => showEmbeddedPage("target-accounts.html", "Target Accounts Dashboard"));
document.getElementById("nav-import-target-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=import-accounts", "Target Accounts Dashboard"));
document.getElementById("nav-restore-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=restore-accounts", "Target Accounts Dashboard"));
document.getElementById("nav-hubspot-export-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=export-hubspot", "Target Accounts Dashboard"));
document.getElementById("nav-hubspot-import-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=import-hubspot", "Target Accounts Dashboard"));
document.getElementById("nav-find-duplicates-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=find-duplicates", "Target Accounts Dashboard"));
document.getElementById("nav-resolve-target-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=resolve", "Target Accounts Dashboard"));
document.getElementById("nav-fetch-size-target-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=fetch-size", "Target Accounts Dashboard"));
document.getElementById("nav-prioritize-target-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=prioritize", "Target Accounts Dashboard"));

// Same page as Target Accounts (target-accounts.js's own #contacts hash
// route, PRD 6.19) - opened directly at that route rather than making the
// user land on Accounts and click the in-page tab every time.
openTargetContactsBtn.addEventListener("click", () => showEmbeddedPage("target-accounts.html#contacts", "Target Contacts Dashboard"));
document.getElementById("nav-discover-contacts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=discover-contacts", "Target Contacts Dashboard"));

document.getElementById("open-onboarding-link").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html#wizard") });
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
  return {
    id: crypto.randomUUID(), name: "", keywords: [], andKeywords: [], enabled: true,
    appliesTo: "both", matchField: "any", builtin: false,
  };
}

async function persistNegativeTopics() {
  await saveNegativeTopics(negativeTopics);
}

// Wizard-list-backed builtin topics (2026-09-16) - their `keywords` are
// computed by storage.js's getNegativeTopics() from the Setup wizard's own
// company-exclusion lists (competitorCompanySlugs/etc.), not edited here at
// all, so these render as just a checkbox + scope dropdown, not the full
// name/keywords/AND-group card below.
const NEGATIVE_TOPIC_SOURCE_LABELS = {
  competitors: "Filter out competitors, listed in the main settings",
  recruiters: "Filter out recruiting companies, listed in the main settings",
  customers: "Filter out existing customers, listed in the main settings",
  partners: "Filter out existing partners, listed in the main settings",
};

// Same card shape as renderTopicCards above (name, keywords, optional
// AND-group) - a negative topic is checked the same way, just against an
// already-scraped lead's own text afterward instead of ever being sent to
// LinkedIn as a search query. `builtin` topics just skip the remove button;
// every field on them (including whether they're enabled) stays editable -
// except the wizard-list-backed ones above, which get their own simpler
// card (see the sourceList branch below).
function renderNegativeTopics() {
  negativeTopicsListEl.innerHTML = "";

  // The four "listed in the main settings" company filters are shown together at the top, custom filters after them.
  const orderedTopics = [...negativeTopics.filter((t) => t.sourceList), ...negativeTopics.filter((t) => !t.sourceList)];
  for (const topic of orderedTopics) {
    if (topic.enabled === undefined) topic.enabled = true;
    if (!topic.andKeywords) topic.andKeywords = [];
    if (!topic.appliesTo) topic.appliesTo = "both";
    if (!topic.matchField) topic.matchField = "any";

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

    if (topic.sourceList) {
      const label = document.createElement("span");
      label.className = "negative-topic-source-label";
      label.textContent = NEGATIVE_TOPIC_SOURCE_LABELS[topic.sourceList] || topic.name;
      headerRow.append(enabledCheckbox, label, appliesToSelect);
      card.appendChild(headerRow);

      const hint = document.createElement("p");
      hint.className = "field-hint";
      hint.textContent = topic.keywords.length
        ? `${topic.keywords.length} compan${topic.keywords.length === 1 ? "y" : "ies"} configured in the Setup wizard.`
        : "No companies configured yet - add some in the Setup wizard.";
      card.appendChild(hint);

      negativeTopicsListEl.appendChild(card);
      continue;
    }

    const matchFieldSelect = document.createElement("select");
    matchFieldSelect.title = "What this filter's keywords are checked against";
    for (const [value, label] of [["any", "Company + text"], ["company", "Company name only"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      matchFieldSelect.appendChild(option);
    }
    matchFieldSelect.value = topic.matchField;
    matchFieldSelect.addEventListener("change", () => {
      const prevValue = topic.matchField;
      topic.matchField = matchFieldSelect.value;
      persistNegativeTopics();
      appendActivityLog({
        actor: "user", action: "negative_topic_match_field_changed",
        label: `Negative Topic "${topic.name || "(untitled)"}" match field changed`,
        prevValue, newValue: topic.matchField,
      });
    });

    headerRow.append(enabledCheckbox, nameInput, appliesToSelect, matchFieldSelect);

    const keywordsTextarea = document.createElement("textarea");
    keywordsTextarea.placeholder = "One keyword or phrase per line - a lead matching any one of these is filtered out. Company names auto-match despite AG/Ltd/Inc, Switzerland, or Group suffixes on either side.";
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
  if (!(await askConfirm("Check all your existing leads against your Negative Topics now?\n\nExisting leads with status New that match a negative topic are removed from your lists; leads that no longer match any filter come back. Nothing is deleted. No LinkedIn activity is used."))) return;
  applyNegativeFiltersBtn.disabled = true;
  applyNegativeFiltersStatus.textContent = "Checking existing leads…";
  try {
    const { blockedCount, restoredCount } = await reapplyBlocklist();
    if (blockedCount === 0 && restoredCount === 0) {
      applyNegativeFiltersStatus.textContent = "Done - no leads needed to change.";
    } else {
      const parts = [];
      if (blockedCount > 0) parts.push(`${blockedCount} lead${blockedCount === 1 ? "" : "s"} filtered out`);
      if (restoredCount > 0) parts.push(`${restoredCount} lead${restoredCount === 1 ? "" : "s"} brought back`);
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
    "Headline",
    "Company",
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
      isJob ? "" : r.headline,
      r.company || "",
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

// The line above the Results: how many leads are listed, by kind and by priority - shown for a fresh scan and for
// earlier results alike.
function renderResultsStats(results) {
  const el = document.getElementById("results-stats");
  if (!el) return;
  if (results.length === 0) {
    el.textContent = "";
    return;
  }
  const shown = results.filter((r) => (r.status || "New") !== "Irrelevant");
  const filteredOut = results.length - shown.length;
  const kinds = { posts: 0, "in-post job ads": 0, "job listings": 0 };
  const priorities = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let unscored = 0;
  for (const r of shown) {
    if (r.type === "job") kinds["job listings"]++;
    else if (r.isJobAd) kinds["in-post job ads"]++;
    else kinds.posts++;
    if (priorities[r.priority] !== undefined) priorities[r.priority]++;
    else unscored++;
  }
  const singular = { posts: "post", "in-post job ads": "in-post job ad", "job listings": "job listing" };
  const kindText = Object.entries(kinds).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${n === 1 ? singular[k] : k}`).join(", ");
  const priorityText = [1, 2, 3, 4, 5].filter((p) => priorities[p] > 0).map((p) => `P${p}: ${priorities[p]}`)
    .concat(unscored > 0 ? [`not scored: ${unscored}`] : []).join(", ");
  el.textContent = `${shown.length} lead${shown.length === 1 ? "" : "s"} listed` +
    (kindText ? ` (${kindText})` : "") +
    (priorityText ? ` - priority ${priorityText}` : "") +
    (filteredOut > 0 ? ` - ${filteredOut} more filtered out by your negative topics or location filter` : "") + ".";
}

function renderResults(sortedResults) {
  resultsListEl.innerHTML = "";
  renderResultsStats(sortedResults);

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

// The actual title list is no longer edited here (2026-09-16) - it's
// derived from the Setup wizard's Target Contacts profile (exactTitles +
// titleKeywords), the same list Phase 6 contact discovery already uses, so
// there's one list to maintain, not two that can silently drift apart. This
// checkbox still just toggles whether the filter applies at scan time -
// unrelated to where the titles themselves come from.
async function refreshAuthorTitlesFromTargetContacts() {
  const profile = await getTargetContactProfile();
  const combined = [...(profile.exactTitles || []), ...(profile.titleKeywords || [])];
  await saveAuthorTitles(combined);
  authorTitleListHintEl.textContent = combined.length
    ? `Currently: ${combined.join(", ")} (edit in the Setup wizard's Target Contacts step).`
    : "No target-contact titles configured yet - set them in the Setup wizard's Target Contacts step.";
}

authorTitleEnabledCheckbox.addEventListener("change", () => {
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

scanCompanyScopeSelect.addEventListener("change", async () => {
  await saveScanCompanyScope(scanCompanyScopeSelect.value);
  await refreshResolvedTargetCompanyCount();
  appendActivityLog({ actor: "user", action: "scan_company_scope_changed", label: `Scan "Target Account companies to scan" set to ${SCAN_SCOPE_LABELS[scanCompanyScopeSelect.value] || scanCompanyScopeSelect.value}`, newValue: scanCompanyScopeSelect.value });
});

// "Use the same location as in the main settings" - the manual location controls are only shown when it is off, or when
// none of the target countries has a confirmed LinkedIn location ID.
async function refreshJobLocationMode() {
  const useMain = await getJobSearchUseMainLocation();
  const main = await getMainLocationForJobs();
  jobUseMainLocationCheckbox.checked = useMain;
  if (useMain && main) {
    jobMainLocationHintEl.textContent = `Job listings are searched in ${main.name}` +
      (main.extraCount > 0 ? ` (your first target country - LinkedIn searches one location at a time; ${main.extraCount} other target countr${main.extraCount === 1 ? "y is" : "ies are"} not covered).` : ".");
    jobManualLocationEl.hidden = true;
  } else {
    jobMainLocationHintEl.textContent = useMain
      ? "None of your target countries has a LinkedIn location ID SalesTeam knows yet - pick the location below."
      : "";
    jobManualLocationEl.hidden = false;
  }
}
jobUseMainLocationCheckbox.addEventListener("change", async () => {
  await saveJobSearchUseMainLocation(jobUseMainLocationCheckbox.checked);
  appendActivityLog({ actor: "user", action: "job_search_use_main_location_toggled", label: `"Use the same location as in the main settings" for Job Listing Search ${jobUseMainLocationCheckbox.checked ? "enabled" : "disabled"}` });
  await refreshJobLocationMode();
});

jobSearchLocationSelect.addEventListener("change", () => {
  saveJobSearchLocation(jobSearchLocationSelect.value);
});

jobSearchTimeframeSelect.addEventListener("change", () => {
  saveJobSearchTimeframe(jobSearchTimeframeSelect.value);
});

document.querySelectorAll(".action-dialog-close-btn").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest("dialog").close());
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

// Build step 3, U4 as refined 2026-09-25: 0 Ready accounts blocks the scan; 1 to MIN_READY_TO_SCAN - 1
// explains and offers "Scan anyway"; MIN_READY_TO_SCAN or more scans straight away.
async function confirmReadyGate() {
  let ready = 0;
  let total = 0;
  try {
    const rows = await getAccountReadiness();
    total = rows.length;
    ready = rows.filter((r) => r.assessment.state === "ready").length;
  } catch {
    return true; // the gate is advice; never block a scan on a failed count
  }
  if (ready >= MIN_READY_TO_SCAN) return true;
  const auto = await getPipelineAutomation();
  const more = total === 0 ? " Import your target accounts, or run Discovery, first."
    : auto.enabled ? " SalesTeam is preparing more automatically while Chrome is open."
    : " Automatic preparation can get them ready: Settings > Automation.";
  if (ready === 0) {
    const have = total === 0 ? "You have no target accounts yet." : "None of your accounts is Ready yet.";
    await askConfirm(`${have} The Scanner needs at least one Ready account to start.${more}`, { okLabel: "OK", cancelLabel: "Close" });
    return false;
  }
  return askConfirm(
    `You have ${ready} Ready account${ready === 1 ? "" : "s"}. The Scanner works best with at least ${MIN_READY_TO_SCAN}: ` +
    `it searches for posts from people at your accounts, and only well-prepared accounts give good matches.${more}`,
    { okLabel: "Scan anyway", cancelLabel: "Cancel" },
  );
}

scanBtn.addEventListener("click", async () => {
  if (!(await confirmReadyGate())) return;
  if (!(await guardBatchStart("Scanner (searching LinkedIn for posts and jobs)", askConfirm))) return;
  scanBtn.disabled = true;
  progressTextEl.textContent = "Checking backup…";
  // A scan never starts without a full backup from the last 12 hours (the daily one usually already exists);
  // this click is a gesture, so a folder permission Chrome asks for again can be requested right here.
  await runAutoBackupIfDue({ force: true, gesture: true }).catch((err) => {
    console.error("[SalesTeam] Pre-scan backup failed:", err);
  });
  progressTextEl.textContent = "Starting scan…";
  chrome.runtime.sendMessage({ type: "SCAN_ALL", reapplyToExisting: reapplyExistingCheckbox.checked });
  appendActivityLog({ actor: "user", action: "scan_started", label: "Started a scan" });
  stopScanBtn.hidden = false;
  stopScanBtn.disabled = false;
  stopScanBtn.textContent = "Stop Scan";
});

// v0.29.45: reported directly - a scan whose search count can now run into
// the hundreds (6.17's Target Account phase) had no way to stop early short
// of force-closing the extension. Storage-based, checked by background.js's
// own checkAbort() at the same per-sub-query checkpoint every loop already
// has - so the worst-case delay between this click and the scan actually
// stopping is one in-flight search, not the rest of the run. Disabled
// immediately (not just on the eventual SCAN_ABORTED message) so a slow
// in-flight search can't look like the click didn't register.
stopScanBtn.addEventListener("click", () => {
  stopScanBtn.disabled = true;
  stopScanBtn.textContent = "Stopping…";
  chrome.storage.local.set({ scanAbortRequested: true });
});

// A scan's own "topic X of Y" progress is a different, much shorter phase
// than visiting individual profiles - reported directly: folding profile
// visits into the scan's own progress counter would be misleading (the
// scan can look "done" while a much longer phase is still silently
// running). Kept as a distinct, explicitly-confirmed second phase instead,
// scoped the same way as the Dashboard's own button (any Post/job-ad lead
// still missing a company or location, not just this scan's new ones - the
// backlog matters just as much as fresh leads, per the same report).
async function promptAndRunProfileExtraction(results) {
  const toVisit = leadsMissingProfileData(results);
  if (toVisit.length === 0) return;
  if (!(await guardBatchStart("Reading LinkedIn profiles", askConfirm))) return;
  if (!(await askConfirm(
    `${toVisit.length} lead${toVisit.length === 1 ? "" : "s"} (including any from before this scan) ` +
    `${toVisit.length === 1 ? "is" : "are"} missing a company or location. ` +
    profileVisitConfirmText(uniqueProfileCount(toVisit), toVisit.length)
  ))) {
    return;
  }

  scanBtn.disabled = true;
  try {
    const { found: scraped, debugSamples, hardTimeoutCount } = await runProfileExtraction(toVisit, {
      onProgress: (i, total) => { progressTextEl.textContent = `Visiting profile ${i} of ${total}…`; },
    });
    const found = scraped.length > 0 ? await applyExtractedCompanies(scraped) : 0;
    const { blockedCount: locationBlockedCount } = await reapplyLocationFilter();
    await renderResultsFromStorage();
    // Same distinction as the Dashboard's button (see dashboard.js) - a
    // genuine hard-timeout failure now reads differently from "visited fine,
    // nothing findable" instead of both silently counting as "not found."
    progressTextEl.textContent = `Done - ${found} of ${toVisit.length} lead${toVisit.length === 1 ? "" : "s"} got a company/location from their profile` +
      (hardTimeoutCount > 0 ? `, ${hardTimeoutCount} failed due to an error (will retry next run - see Activity Log)` : "") +
      (locationBlockedCount > 0 ? `, ${locationBlockedCount} filtered out by the Location Filter.` : ".");
    appendActivityLog({
      actor: "user",
      action: "companies_extracted_from_profiles",
      label: `Extract Companies & Locations from Profiles: ${found} of ${toVisit.length} lead${toVisit.length === 1 ? "" : "s"} updated, ${locationBlockedCount} marked Irrelevant by Location Filter` +
        (hardTimeoutCount > 0 ? `, ${hardTimeoutCount} failed due to an error` : "") +
        (debugSamples.length > 0 ? ` - ${debugSamples.length} failure sample(s) attached for diagnosis` : ""),
      newValue: { found, total: toVisit.length, locationBlockedCount, hardTimeoutCount, debugSamples },
    });
  } catch (err) {
    progressTextEl.textContent = `Something went wrong visiting profiles: ${err.message}`;
    appendActivityLog({ actor: "user", action: "companies_extracted_from_profiles", label: "Extract Companies & Locations from Profiles failed", error: true, errorMessage: err.message });
  } finally {
    scanBtn.disabled = false;
    await renderLinkedinTouchStat();
  }
}

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
    stopScanBtn.hidden = true;
    renderResults(message.results);
    renderLinkedinTouchStat();
    promptAndRunProfileExtraction(message.results);
  } else if (message?.type === "SCAN_ERROR") {
    progressTextEl.textContent = message.message;
    scanBtn.disabled = false;
    stopScanBtn.hidden = true;
    renderResultsFromStorage(); // pick up any leads saved before the failure
    renderLinkedinTouchStat();
  } else if (message?.type === "SCAN_ABORTED") {
    progressTextEl.textContent = message.message;
    scanBtn.disabled = false;
    stopScanBtn.hidden = true;
    renderResultsFromStorage(); // pick up any leads saved before stopping
    renderLinkedinTouchStat();
  }
});

// Reported directly (2026-09-10): a single day of concentrated testing
// (scan + profile-extraction + repeated company-ID-resolver runs) triggered
// LinkedIn's own "unusual activity" account warning - reconstructed after
// the fact at ~315 automated page visits that day, an invisible number until
// it was already too late. This makes that number visible up front instead,
// refreshed on load and periodically while the panel stays open (a scan or
// profile-extraction run can run long enough for the count to move
// meaningfully within one session).
async function renderLinkedinTouchStat() {
  const el = document.getElementById("linkedin-touch-stat");
  const touchStats = await getLinkedinTouchStats();
  const { today, last24h, last7d, level } = touchStats;
  el.textContent = `LinkedIn touches (automated): ${today} today · ${last24h} in the last 24h · ${last7d} in the last 7 days` +
    (level === "ok" ? "" : ` — ${formatTouchRelease(touchStats)}`);
  el.classList.toggle("linkedin-touch-stat-warn", level === "warn");
  el.classList.toggle("linkedin-touch-stat-danger", level === "danger");
}

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;

  await renderLinkedinTouchStat();
  setInterval(renderLinkedinTouchStat, 30000);

  topics = await getTopics();
  renderTopics();

  jobTopics = await getJobTopics();
  renderJobTopics();

  timeframeSelect.value = await getTimeframe();
  authorTitleEnabledCheckbox.checked = await getAuthorTitleEnabled();
  await refreshAuthorTitlesFromTargetContacts();
  includeJobAdsCheckbox.checked = await getIncludeJobAds();

  jobSearchEnabledCheckbox.checked = await getJobSearchEnabled();
  jobSearchUsePostTopicsCheckbox.checked = await getJobSearchUsePostTopics();
  jobLocationPresets = await getJobSearchLocationPresets();
  renderJobLocationOptions(await getJobSearchLocation());
  await refreshJobLocationMode();
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
  // backup (Settings > Backup & Restore). Only shown
  // once there's real data to act on - a genuinely fresh install already
  // gets the banner above, which covers "add a key" as part of setup anyway.
  const hasApiKey = Boolean((await getAnthropicApiKey()) || "");
  const hasSomeData = !noTopicsConfigured || !noLeadsFound;
  document.getElementById("missing-api-key-banner").hidden = hasApiKey || !hasSomeData;

  // Setup (PRD 6.20 Phase 1/2) walks a fresh install through this
  // automatically (background.js's onInstalled), but a user who closed that
  // tab without finishing, or upgraded from a version that predates it,
  // needs a way back in too.
  document.getElementById("onboarding-required-banner").hidden = Boolean(await getOnboardingCompletedAt());
}

init();

// PRD 6.20 Phase 10 follow-up (2026-09-19) - collapsible nav, see
// target-accounts.js's own copy of this comment for the full reasoning.
const NAV_COLLAPSED_KEY = "salesteam-nav-collapsed";
const navCollapseBtn = document.getElementById("nav-collapse-btn");
function applyNavCollapsed(collapsed) {
  document.getElementById("app-shell").classList.toggle("nav-collapsed", collapsed);
  navCollapseBtn.textContent = collapsed ? "»" : "«";
  navCollapseBtn.title = collapsed ? "Expand the menu" : "Collapse the menu";
}
applyNavCollapsed(localStorage.getItem(NAV_COLLAPSED_KEY) === "1");
navCollapseBtn.addEventListener("click", () => {
  const collapsed = !document.getElementById("app-shell").classList.contains("nav-collapsed");
  applyNavCollapsed(collapsed);
  localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
});

// Keeps the Author title filter and the wizard-list-backed Negative Topics
// (Competitor Blocklist/Recruiting Companies/Existing Customers/Existing
// Partners) in sync if the Setup wizard's underlying lists are edited on
// another tab while this side panel stays open - getNegativeTopics() itself
// already recomputes fresh on every call (so a scan always uses the current
// lists regardless), this just keeps what's ON SCREEN here from going
// stale in the meantime.
const WIZARD_LIST_SYNC_KEYS = new Set([
  "targetContactProfile", "competitorCompanySlugs", "recruiterCompanySlugs",
  "existingCustomerCompanySlugs", "existingPartnerCompanySlugs",
]);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("targetContactProfile" in changes) refreshAuthorTitlesFromTargetContacts();
  if (Object.keys(changes).some((key) => WIZARD_LIST_SYNC_KEYS.has(key) && key !== "targetContactProfile")) {
    getNegativeTopics().then((fresh) => {
      negativeTopics = fresh;
      renderNegativeTopics();
    });
  }
});

// Keep the "Total: N searches" hint honest about the Target Account company phase.
getScanCompanyScope().then((scope) => { scanCompanyScopeSelect.value = scope; });
refreshResolvedTargetCompanyCount();
setInterval(renderRunCapacityHint, 30000);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.targetAccounts || changes.targetAccountsWorkbook || changes.targetAccountExtras || changes.scanCompanyPriorityScope) {
    refreshResolvedTargetCompanyCount();
  }
  if (changes.linkedinTouchLog) renderRunCapacityHint();
});

// Automatic daily backup (once per 24h across all open pages) - see backup-restore.js.
startAutoBackup();
initBatchStatus();
