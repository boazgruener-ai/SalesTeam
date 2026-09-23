// Onboarding wizard (PRD 6.20 Phase 1/2) - a linear, numbered explain -> enter
// -> confirm flow that captures targetUniverseConfig, targetContactProfile,
// accountPriorityGuidelines, companyExclusions, organizationTypeEligibility,
// companyAliases, companyContext, idealCustomerProfile and valueAddOffers
// (storage.js) - the sole home for the first two of those (moved out of
// settings.html 2026-09-16, which now just points here) and, since the same
// day, valueAddOffers too (also moved out of settings.html, as a new
// optional step here). Phase 5/6 (company/contact discovery scanning)
// consume everything captured here.
import {
  getTargetUniverseConfig, saveTargetUniverseConfig,
  getTargetContactProfile, saveTargetContactProfile,
  getAccountPriorityGuidelines, saveAccountPriorityGuidelines,
  getCompanyExclusions, saveCompanyExclusions, EXCLUSION_CATEGORIES, EXCLUSION_CATEGORY_LABELS,
  getCompanyAliases, saveCompanyAliases,
  getOrganizationTypeEligibility, saveOrganizationTypeEligibility,
  getKeywordSearchLanguages, saveKeywordSearchLanguages, CONFIRMED_KEYWORD_LANGUAGES,
  getCompanyContext, saveCompanyContext,
  getIdealCustomerProfile, saveIdealCustomerProfile,
  getCompanyWebsite, saveCompanyWebsite,
  getValueAddOffers, saveValueAddOffers,
  markOnboardingCompleted,
  getOnboardingProgressStepIndex, saveOnboardingProgressStepIndex,
  parseLinkedinCompanySlug,
  CONTINENT_LABELS,
  CONTINENT_COUNTRIES,
  ALL_COUNTRIES,
  SIZE_PRIORITY_BUCKETS,
  normalizeTargetUniverseConfig,
  clearDiscoveredCompanies,
  clearDiscoveredContacts,
  getPrioritizationRules,
  savePrioritizationRuleOverride,
  getTargetAccountScoreThreshold,
  saveTargetAccountScoreThreshold,
  getPostPrioritizationRules,
  savePostPrioritizationRules,
  getTopics,
  getTargetAccountsWorkbook,
  SENIORITY_LEVELS,
} from "./storage.js";
import { startAutoBackup } from "./backup-restore.js";
import { mountLocationPicker } from "./location-picker.js";
import { AI_FIELD_ALIASES } from "./xlsx-lite.js";
import { CONFIRMED_INDUSTRIES, EXCLUDABLE_INDUSTRIES } from "./industry-id-map.js";
import { getDiscoveryQueueState, resetDiscoveryQueue } from "./discovery-queue.js";

// Shared 1-3 priority scale (Location/Size/Industry, all added 2026-09-16) -
// same Low/Medium/High labels, same numeric values, everywhere it's used.
const PRIORITY_LABELS = { 1: "Low", 2: "Medium", 3: "High" };

const STEP_ORDER = [
  "location", "size", "industry", "priority", "leads-prioritization", "company-context", "value-add-offers",
  "icp", "contacts", "exclusions", "aliases", "finish",
];
const STEP_TITLES = {
  location: "Location", size: "Size", industry: "Industry", priority: "Discovery Prioritization",
  "leads-prioritization": "Leads Prioritization",
  "company-context": "What you sell", "value-add-offers": "Things you can offer",
  icp: "Ideal customer", contacts: "Target contacts",
  exclusions: "Companies to exclude",
  aliases: "Company aliases",
};

// Short display names for storage.js's PRIORITIZATION_RULE_CATALOG ids (used
// by the Leads Prioritization step below) - the catalog's own `id` is a
// stable key, not meant as UI text. Moved here from settings.js 2026-09-16
// along with the rest of that step.
const PRIORITIZATION_RULE_LABELS = {
  job_company_cap: "Job company cap",
  job_signal_ceiling: "Job signal ceiling",
};

// Post rule builder (PRD 6.20, generalized 2026-09-16) - replaces the old
// fixed 8-cell floor table with user-editable rules built from a small,
// generic condition vocabulary (not tied to this deployment's own Swiss/AI
// specifics), per the user's own explicit spec: "Column X contains (v1 OR
// v2) AND Post Author is in Contacts of Company AND Post matched on
// (Topic-X OR Topic-Y)". Author-title keyword matching was deliberately
// left out of this vocabulary (see storage.js) - the user's own call: a
// Target Contact match already implies the title matched the Setup
// wizard's own title settings, so a separate title heuristic is redundant.
// engine/evaluation lives in storage.js (getPostPrioritizationRules /
// evaluatePostPrioritizationRules); this is purely the editor.
const POST_RULE_CONDITION_TYPES = [
  { type: "column", label: "Workbook column" },
  { type: "companyHasMatch", label: "Account is in the Target Accounts list" },
  { type: "authorIsTargetContact", label: "Post author is a Target Contact" },
  { type: "authorSeniorityAtLeast", label: "Post author's seniority is at least" },
  { type: "topicMatch", label: "Post matched a Topic" },
];

// Same 1/2/3 = Low/Medium/High scale as the Contacts step's seniority
// priorities (SENIORITY_PRIORITY_OPTIONS below) and Industry's own priority
// select - kept as one shared list rather than two so the wording can never
// drift between where a priority is set and where it's read back.
const SENIORITY_PRIORITY_OPTIONS = [["1", "Low"], ["2", "Medium"], ["3", "High"]];

// Working copies, seeded from storage in init() and mutated in place as each
// step is validated. Persisted both on Confirm (the normal advance path)
// and continuously while a step is open but not yet confirmed (see
// scheduleAutoSave below) - a real completed run can take "tens of minutes
// to several hours," so a step's in-progress content shouldn't be lost to
// an accidental tab close before Confirm is clicked.
let targetUniverseConfig;
let accountPriorityGuidelines;
let targetContactProfile;
// Unified { slug, category } list (storage.js's companyExclusions) - built
// fresh from the 5 per-category textareas on validate, same convention as
// every other wizard-array-field (see validateExclusionsStep below).
let companyExclusions = [];
let companyAliases = [];
let organizationTypeEligibility = {};
let keywordSearchLanguages = [];
let prioritizationRules = [];
let postPrioritizationRules = [];
// Real configured Topic names (sidepanel.js's own Topics list), shown as a
// reference under each Topic-match condition's input - loaded once in
// init(), not re-fetched per render since Topics aren't edited from here.
let availableTopicNames = [];
// Every column name actually present on any row of the real, currently-
// imported Target Accounts workbook's Companies sheet (target-accounts.js's
// import already camelCases whatever headers the user's own .xlsx has - see
// xlsx-lite.js's parseGenericSheetRows - so this reflects that workbook's
// real shape, not a hardcoded guess at which ~6 of its ~40 columns matter).
// Reported directly, 2026-09-17: a fixed short list was "not generic
// enough" for a Column condition meant to work against any workbook.
let availableCompanyColumnNames = [];

// The scan criteria the most recent Discovery run (if any) actually used -
// discovery-queue.js's own configSnapshot, frozen at that run's Start, not
// today's possibly-since-edited wizard settings. Loaded once in init();
// null if Discovery has never been started, in which case there's nothing
// for an edit here to make stale, so the warning below never fires.
let priorDiscoveryConfigSnapshot = null;
// scanAffectingFields() of the settings as they were when the wizard opened (see warnIfDiscoveryNowStale).
let scanFieldsAtOpen = null;
// "Change Settings" (onboarding.html?mode=settings): the same topics as a plain settings list - no numbering, no
// Next/Back, no "Setup complete" step. Used from the Settings menu once the setup has been completed.
const settingsMode = new URLSearchParams(location.search).get("mode") === "settings";

let locationPicker;
let currentStepIndex = 0;
// Only ever increases - tracks the furthest step reached (not the current
// one, which Back can move backward) so resuming later never regresses
// past-visited progress.
let furthestStepIndex = 0;

function formatLocationValue(value) {
  return CONTINENT_LABELS[value] || value;
}

function el(id) { return document.getElementById(id); }

// Shared wizard nav bar (redesigned 2026-09-16, replacing a per-step
// Back/Next pair duplicated in every section - see onboarding.html's own
// comment on #wizard-nav-bar). showStep() owns its visibility/labels;
// #nav-next-btn/#nav-back-btn read STEP_ORDER[currentStepIndex] directly
// rather than a per-button data-step attribute, since there's now only one
// of each button, not one per section.
// The wizard normally runs INSIDE the Settings page (settings.html#wizard), so the app menu stays visible on the left;
// leaving it just returns that page to its Setup card. Opened on its own (an old link), it goes to settings.html instead.
function leaveWizard() {
  if (window.top !== window) {
    // Same page, just closes the embedded wizard (works whatever the page's query string). The PARENT is the Settings
    // page that hosts this frame - when Settings itself is embedded in another page (opened from the Posts or
    // Accounts menu), window.top is that outer page and changing its hash did nothing (reported 2026-09-21).
    if (settingsMode) window.parent.postMessage({ type: "salesteam-leave-settings" }, location.origin);
    else window.parent.location.hash = "#setup-section";
    return;
  }
  window.location.href = "settings.html";
}

function updateNavBar(step, index) {
  const navBar = el("wizard-nav-bar");
  if (step === "finish") {
    navBar.hidden = false;
    el("nav-back-btn").hidden = false;
    el("nav-exit-btn").hidden = false;
    el("nav-save-exit-btn").hidden = true;
    el("nav-save-btn").hidden = true;
    el("nav-next-btn").hidden = true;
  } else {
    navBar.hidden = false;
    el("nav-back-btn").hidden = index === 0;
    el("nav-exit-btn").hidden = false;
    el("nav-save-exit-btn").hidden = false;
    el("nav-save-btn").hidden = false;
    el("nav-next-btn").hidden = false;
  }
  for (const btn of el("wizard-step-list").children) {
    btn.classList.toggle("wizard-step-list-active", btn.dataset.step === step);
  }
}

// Step index (added 2026-09-16) - one button per real step (STEP_TITLES has
// no entry for "finish", so it's naturally excluded), built once since
// STEP_ORDER/STEP_TITLES are static. Clicking jumps straight to that step,
// same as Back already does (showStep directly, no confirm screen) -
// persists whatever's on the CURRENT step first (same immediate
// validate+persist as Save & Exit, bypassing the auto-save debounce) so
// jumping away mid-edit never loses anything.
function renderWizardStepList() {
  const listEl = el("wizard-step-list");
  listEl.innerHTML = "";
  STEP_ORDER.forEach((step, index) => {
    if (step === "finish") return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.step = step;
    btn.textContent = settingsMode ? STEP_TITLES[step] : `${index + 1}. ${STEP_TITLES[step]}`;
    btn.addEventListener("click", async () => {
      const currentStep = STEP_ORDER[currentStepIndex];
      if (currentStep !== "finish" && currentStep !== step) {
        STEP_VALIDATORS[currentStep]?.();
        await persistStep(currentStep);
      }
      showStep(index);
    });
    listEl.appendChild(btn);
  });
}

function showStep(index) {
  const hintEl = document.getElementById("change-settings-hint");
  if (hintEl) hintEl.hidden = true;
  currentStepIndex = index;
  const step = STEP_ORDER[index];
  for (const s of STEP_ORDER) {
    const sectionEl = el(`enter-${s}`);
    if (sectionEl) sectionEl.hidden = s !== step;
  }
  el("confirm-view").hidden = true;
  el("step-progress").textContent = step === "finish" ? "" : `Step ${index + 1} of ${STEP_ORDER.length - 1}`;
  if (step === "location") renderLocationPriorityRows();
  if (step === "finish") renderFinishSummary();
  updateNavBar(step, index);

  // Reported directly: a real completed run took "tens of minutes to
  // several hours" - remembering the furthest step reached (not just which
  // steps were formally confirmed, and not regressed by using Back to
  // revisit an earlier one) means reopening this page after an accidental
  // close lands back where the user actually was, not at step 1.
  if (!settingsMode && index > furthestStepIndex) {
    furthestStepIndex = index;
    saveOnboardingProgressStepIndex(furthestStepIndex);
  }
}

// Change Settings: nothing is open until a setting is picked from the list at the top.
function showSettingsHome() {
  for (const s of STEP_ORDER) {
    const sectionEl = el(`enter-${s}`);
    if (sectionEl) sectionEl.hidden = true;
  }
  el("confirm-view").hidden = true;
  currentStepIndex = STEP_ORDER.length - 1; // the "finish" slot: nothing to persist when leaving it
  el("wizard-nav-bar").hidden = false;
  el("nav-save-btn").hidden = true;
  let hint = el("change-settings-hint");
  if (!hint) {
    hint = document.createElement("p");
    hint.id = "change-settings-hint";
    hint.textContent = "Choose the setting you want to change from the list above.";
    el("onboarding-main").prepend(hint);
  }
  hint.hidden = false;
}

el("nav-back-btn").addEventListener("click", () => {
  if (currentStepIndex > 0) showStep(currentStepIndex - 1);
});

el("nav-next-btn").addEventListener("click", () => {
  const step = STEP_ORDER[currentStepIndex];
  clearStepError(step);
  const { valid, error } = STEP_VALIDATORS[step]();
  if (!valid) {
    showStepError(step, error);
    return;
  }
  showConfirm(step);
});

// "Save and back to Settings" (reported directly, 2026-09-15: changing one
// setting shouldn't mean clicking Back repeatedly through the whole wizard)
// - validates+persists the CURRENT step immediately (bypassing
// scheduleAutoSave's debounce, same real persistence, not a separate draft
// layer) then navigates away. Skipped on the finish step, which has no
// fields of its own left to persist and its own dedicated navigation.
el("nav-save-exit-btn").addEventListener("click", async () => {
  const step = STEP_ORDER[currentStepIndex];
  if (step !== "finish") {
    STEP_VALIDATORS[step]?.();
    await persistStep(step);
  }
  await warnIfDiscoveryNowStale();
  if (await offerRescoreIfRulesChanged()) return;
  leaveWizard();
});

// Plain "Save" (reported directly, 2026-09-21: only Save & Exit existed): saves the current step now, shows a
// confirmation, and stays on the step.
el("nav-save-btn").addEventListener("click", async () => {
  const step = STEP_ORDER[currentStepIndex];
  if (step === "finish") return;
  const status = el("nav-save-status");
  const result = STEP_VALIDATORS[step]?.();
  if (result && result.valid === false) {
    status.textContent = result.error || "Please fix this step first.";
    return;
  }
  await persistStep(step);
  status.textContent = "Saved ✓";
  setTimeout(() => { if (status.textContent === "Saved ✓") status.textContent = ""; }, 2500);
});

// "Exit" (added 2026-09-16, reported directly: "if I just want to look at
// the settings and not change anything," Save & Exit's immediate persist +
// possible stale-Discovery dialog both read as unwanted for a pure look-
// don't-touch visit) - leaves straight away, skipping both. Doesn't undo
// anything already committed by the debounced autosave (scheduleAutoSave)
// while this step was open - there's no separate draft layer to roll back,
// consistent with this wizard's existing auto-save-always convention - it
// only skips the *extra* work Save & Exit does on top of that: forcing an
// immediate flush of whatever hasn't autosaved yet, and the stale-Discovery
// check that flush could trigger.
el("nav-exit-btn").addEventListener("click", () => {
  leaveWizard();
});

// v1 stale-Discovery warning (PRD 6.20, added 2026-09-16 - "the same blunt
// behavior the user first proposed": no computed delta, just a heads-up and
// a binary choice. A real delta re-scan (re-evaluate already-discovered
// companies locally, only discover the newly-qualifying ones, never
// silently delete a company/contact a user might already be mid-
// conversation with) is agreed as a later-phase improvement once Phase 7
// (merge into the real workbook) exists - staged discoveredCompanies/
// discoveredContacts records don't carry chat history/priority/due-dates to
// preserve yet, so there's nothing meaningful to "relabel instead of
// delete" until then.
//
// Only size/location/industry INCLUSION and target-contact titles/keywords
// are scan-affecting - a priority-only edit (Location/Size/Industry all now
// carry one) never changes which companies get searched, only a future
// Phase 8 scoring pass, so it's deliberately excluded from this comparison.
//
// priorDiscoveryConfigSnapshot is normalized via storage.js's
// normalizeTargetUniverseConfig before it ever reaches here (see init()) -
// a real false-positive bug, found live 2026-09-16, from comparing a
// pre-schema-redesign snapshot (frozen at that run's own Start, never
// re-normalized on its own) directly against a freshly-normalized current
// config: every field this function reads would silently read as empty/
// garbage for that one comparison, so the warning fired unconditionally
// even with no real edit. Fixed at the source (init()), not here.
//
// Returns one JSON-stringified value per named category, not one combined
// signature - reported directly, 2026-09-16: the dialog text originally
// always listed all four categories regardless of which actually changed,
// which reads as a guess and is misleading. Comparing category-by-category
// (see changedScanAffectingCategories below) lets the dialog name only the
// ones that are genuinely different.
function scanAffectingFields(config, contactProfile) {
  const checkedSizeBuckets = Object.entries(config.sizeBuckets || {})
    .filter(([, b]) => b.checked)
    .map(([key]) => key)
    .sort();
  return {
    Location: JSON.stringify([config.locationMode, [...(config.continents || [])].sort(), [...(config.countries || [])].sort()]),
    Size: JSON.stringify(checkedSizeBuckets),
    Industry: JSON.stringify((config.industries || []).map((i) => i.name).sort()),
    "Target-contact titles/keywords": JSON.stringify([
      [...(contactProfile.exactTitles || [])].sort(),
      [...(contactProfile.titleKeywords || [])].sort(),
    ]),
  };
}

function changedScanAffectingCategories(before, after) {
  return Object.keys(before).filter((key) => before[key] !== after[key]);
}

// Reported directly, 2026-09-16 - a native confirm()'s OK/Cancel can't be
// relabeled, and generic labels read as ambiguous here (what does OK even
// mean?), so this got its own real <dialog> with explicitly-named buttons
// instead (onboarding.html's #stale-discovery-dialog, same pattern
// dashboard.html's assign-*/bulk-change dialogs already use). Wrapped in a
// Promise so warnIfDiscoveryNowStale below can still just await the user's
// choice, same shape as the confirm() it replaced.
function showStaleDiscoveryDialog(changedCategories) {
  return new Promise((resolve) => {
    const dialog = el("stale-discovery-dialog");
    el("stale-discovery-changed-list").textContent = changedCategories.join(", ");
    function onClear() { cleanup(); resolve(true); }
    function onKeep() { cleanup(); resolve(false); }
    function cleanup() {
      dialog.close();
      el("stale-discovery-clear-btn").removeEventListener("click", onClear);
      el("stale-discovery-keep-btn").removeEventListener("click", onKeep);
    }
    el("stale-discovery-clear-btn").addEventListener("click", onClear);
    el("stale-discovery-keep-btn").addEventListener("click", onKeep);
    dialog.showModal();
  });
}

// priorDiscoveryConfigSnapshot already carries both targetUniverseConfig
// and targetContactProfile's fields merged onto one object - see
// discovery-queue.js's startDiscoveryQueue and how settings.js's own
// "Start Discovery" button builds it.
async function warnIfDiscoveryNowStale() {
  if (!priorDiscoveryConfigSnapshot) return; // Discovery never started - nothing to go stale
  const before = scanAffectingFields(priorDiscoveryConfigSnapshot, priorDiscoveryConfigSnapshot);
  const after = scanAffectingFields(targetUniverseConfig, targetContactProfile);
  // Only what THIS visit changed counts - settings that already differed from the last Discovery run before the
  // wizard opened must not trigger the question again (reported directly, 2026-09-21: it named Location and
  // Industry after an edit to a scoring rule).
  const changedCategories = changedScanAffectingCategories(before, after)
    .filter((category) => !scanFieldsAtOpen || scanFieldsAtOpen[category] !== after[category]);
  if (changedCategories.length === 0) return;

  const clearNow = await showStaleDiscoveryDialog(changedCategories);
  scanFieldsAtOpen = after; // asked once per change; a later visit that changes nothing more stays quiet
  if (clearNow) {
    await resetDiscoveryQueue();
    await clearDiscoveredCompanies();
    await clearDiscoveredContacts();
    priorDiscoveryConfigSnapshot = null;
  }
}

// ---------------------------------------------------------------------
// Per-step validation - reads the step's DOM inputs into the working state
// above, returns { valid, error }. Never partially mutates state on a
// failed validation.

function validateLocationStep() {
  const value = locationPicker.getValue();
  if (value.mode === "continent" && value.continents.length === 0) {
    return { valid: false, error: "Choose at least one continent." };
  }
  if (value.mode === "country" && value.countries.length === 0) {
    return { valid: false, error: "Choose at least one country." };
  }
  targetUniverseConfig.locationMode = value.mode;
  targetUniverseConfig.continents = value.continents;
  targetUniverseConfig.countries = value.countries;
  const priorities = {};
  for (const row of el("location-priority-wrap").querySelectorAll(".priority-item-row")) {
    priorities[row.dataset.key] = Number(row.querySelector(".priority-item-select").value);
  }
  targetUniverseConfig.locationPriorities = priorities;
  return { valid: true };
}

// Location priority (added 2026-09-16) - which granularity applies depends
// on what was actually selected, confirmed by the user: per-continent only
// when *multiple* continents were picked; per-country otherwise (a single
// picked continent, expanded via storage.js's CONTINENT_COUNTRIES, or
// locationMode "country" directly).
function locationPriorityItems(value) {
  if (value.mode === "continent") {
    if (value.continents.length > 1) return value.continents;
    if (value.continents.length === 1) return CONTINENT_COUNTRIES[value.continents[0]] || [];
    return [];
  }
  return value.countries;
}

// Rebuilt every time the Location step's own continent/country selection
// changes (not just once on step entry, unlike Size/Industry's priority
// rows below, which don't depend on anything else) - see
// refreshLocationPriorityRows for how an in-progress edit survives a
// granularity change (e.g. adding a second continent switches from
// per-country to per-continent rows mid-step).
function renderLocationPriorityRows() {
  const value = locationPicker.getValue();
  const items = locationPriorityItems(value);
  const isPerContinent = value.mode === "continent" && value.continents.length > 1;
  const wrap = el("location-priority-wrap");
  wrap.innerHTML = "";
  for (const item of items) {
    const current = targetUniverseConfig.locationPriorities?.[item] || 2;
    const row = document.createElement("div");
    row.className = "priority-item-row";
    row.dataset.key = item;
    const name = document.createElement("span");
    name.className = "priority-item-name";
    name.textContent = isPerContinent ? formatLocationValue(item) : item;
    const select = document.createElement("select");
    select.className = "priority-item-select";
    for (const [value_, text] of [["1", "Low"], ["2", "Medium"], ["3", "High"]]) {
      const option = document.createElement("option");
      option.value = value_;
      option.textContent = text;
      option.selected = String(current) === value_;
      select.appendChild(option);
    }
    row.append(name, select);
    wrap.appendChild(row);
  }
}

// Captures whatever's currently on-screen (including in-progress priority
// edits) into targetUniverseConfig BEFORE rebuilding the row list, so a
// granularity change mid-step (e.g. picking a second continent) doesn't
// silently drop priorities the user already set for the items that carry
// over.
function refreshLocationPriorityRows() {
  validateLocationStep();
  renderLocationPriorityRows();
}

function validateSizeStep() {
  const maxCompanies = Number(el("size-max-companies-input").value);
  if (!Number.isInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > 500) {
    return { valid: false, error: "Maximum companies must be a whole number between 1 and 500." };
  }
  const sizeBuckets = {};
  for (const row of el("size-buckets-wrap").querySelectorAll(".priority-item-row")) {
    sizeBuckets[row.dataset.key] = {
      checked: row.querySelector('input[type="checkbox"]').checked,
      priority: Number(row.querySelector(".priority-item-select").value),
    };
  }
  if (!Object.values(sizeBuckets).some((b) => b.checked)) {
    return { valid: false, error: "Choose at least one size range." };
  }
  targetUniverseConfig.sizeBuckets = sizeBuckets;
  targetUniverseConfig.maxCompanies = maxCompanies;
  return { valid: true };
}

// Size step redesign (2026-09-16) - 5 fixed, independently-checked buckets
// (storage.js's SIZE_PRIORITY_BUCKETS), each carrying its own 1-3 priority
// when checked, replacing the old "Top N largest" vs. min/max-range toggle
// entirely. Rendered once at init() (unlike Location's priority rows, these
// don't depend on anything set elsewhere, so no need to rebuild on step
// re-entry - state simply persists in the DOM the same way e.g. the
// Contacts step's textareas do).
function renderSizeBucketRows(sizeBuckets) {
  const wrap = el("size-buckets-wrap");
  wrap.innerHTML = "";
  for (const bucket of SIZE_PRIORITY_BUCKETS) {
    const current = sizeBuckets?.[bucket.key] || { checked: true, priority: 2 };
    const row = document.createElement("div");
    row.className = "priority-item-row";
    row.dataset.key = bucket.key;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = current.checked;
    const name = document.createElement("span");
    name.className = "priority-item-name";
    const rangeText = bucket.max === Infinity ? `${bucket.min}+` : `${bucket.min}-${bucket.max}`;
    name.textContent = `${bucket.label} (${rangeText} employees)`;
    const select = document.createElement("select");
    select.className = "priority-item-select";
    for (const [value, text] of [["1", "Low"], ["2", "Medium"], ["3", "High"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = String(current.priority) === value;
      select.appendChild(option);
    }
    select.disabled = !current.checked;
    checkbox.addEventListener("change", () => {
      select.disabled = !checkbox.checked;
      row.classList.toggle("priority-item-unchecked", !checkbox.checked);
    });
    row.classList.toggle("priority-item-unchecked", !current.checked);
    row.append(checkbox, name, select);
    wrap.appendChild(row);
  }
}

// Same checkbox-plus-priority pattern as renderIndustryPriorityRows above,
// over the fixed SENIORITY_LEVELS list (storage.js) instead of a dynamic
// industries list - added 2026-09-17 per the user's own explicit request
// that seniority feed lead prioritization, not just which contacts get
// kept. `selected` is targetContactProfile.seniorityLevels, storage.js's
// own { id, priority }[].
function renderSeniorityLevelPriorityRows(selected) {
  const byId = new Map(selected.map((s) => [s.id, s.priority]));
  const wrap = el("seniority-checkbox-wrap");
  wrap.innerHTML = "";
  for (const level of SENIORITY_LEVELS) {
    const checked = byId.has(level.id);
    const priority = byId.get(level.id) ?? 2;
    const row = document.createElement("div");
    row.className = "priority-item-row";
    row.dataset.key = level.id;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    const name = document.createElement("span");
    name.className = "priority-item-name";
    name.textContent = level.label;
    const select = document.createElement("select");
    select.className = "priority-item-select";
    for (const [value, text] of SENIORITY_PRIORITY_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = String(priority) === value;
      select.appendChild(option);
    }
    select.disabled = !checked;
    checkbox.addEventListener("change", () => {
      select.disabled = !checkbox.checked;
      row.classList.toggle("priority-item-unchecked", !checkbox.checked);
    });
    row.classList.toggle("priority-item-unchecked", !checked);
    row.append(checkbox, name, select);
    wrap.appendChild(row);
  }
}

function validateIndustryStep() {
  const industries = [];
  for (const row of el("industry-checkbox-wrap").querySelectorAll(".priority-item-row")) {
    if (row.querySelector('input[type="checkbox"]').checked) {
      industries.push({ name: row.dataset.key, priority: Number(row.querySelector(".priority-item-select").value) });
    }
  }
  targetUniverseConfig.industries = industries;
  const eligibility = {};
  for (const radio of el("organization-type-wrap").querySelectorAll("input[type=radio]:checked")) {
    eligibility[radio.name] = radio.value;
  }
  organizationTypeEligibility = eligibility;
  keywordSearchLanguages = Array.from(el("languages-checkbox-wrap").querySelectorAll("input:checked")).map((cb) => cb.value);
  return { valid: true };
}

// Industry step redesign (2026-09-16) - each industry keeps its inclusion
// checkbox (same "presence = included" meaning as before), plus a new 1-3
// priority select, shown/enabled only while checked, defaulting to Medium
// (2) - same idea as Size's per-bucket priority above. Static list (unlike
// Location's priority rows, this doesn't depend on anything set elsewhere)
// - built once at init(), not on every showStep(). `selected` is
// targetUniverseConfig.industries, storage.js's { name, priority }[].
function renderIndustryPriorityRows(selected) {
  const byName = new Map(selected.map((i) => [i.name, i.priority]));
  const wrap = el("industry-checkbox-wrap");
  wrap.innerHTML = "";
  for (const industry of CONFIRMED_INDUSTRIES) {
    const checked = byName.has(industry);
    const priority = byName.get(industry) ?? 2;
    const row = document.createElement("div");
    row.className = "priority-item-row";
    row.dataset.key = industry;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    const name = document.createElement("span");
    name.className = "priority-item-name";
    name.textContent = industry;
    const select = document.createElement("select");
    select.className = "priority-item-select";
    for (const [value, text] of [["1", "Low"], ["2", "Medium"], ["3", "High"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = String(priority) === value;
      select.appendChild(option);
    }
    select.disabled = !checked;
    checkbox.addEventListener("change", () => {
      select.disabled = !checkbox.checked;
      row.classList.toggle("priority-item-unchecked", !checkbox.checked);
    });
    row.classList.toggle("priority-item-unchecked", !checked);
    row.append(checkbox, name, select);
    wrap.appendChild(row);
  }
}

// Organization Type eligibility (see storage.js's organizationTypeEligibility
// and industry-id-map.js's EXCLUDABLE_INDUSTRIES for the full reasoning) -
// one row per confirmed non-standard-org-type industry, each its own
// Yes/No/Review radio group (grouped by the industry's own name as the
// radio `name`, so each row's three options are mutually exclusive without
// needing a synthetic id). Defaults to "yes" (a fully normal candidate)
// when nothing is saved for that industry yet - never an opinionated
// built-in exclusion.
function renderOrganizationTypeRows(eligibility) {
  const wrap = el("organization-type-wrap");
  wrap.innerHTML = "";
  for (const industry of Object.keys(EXCLUDABLE_INDUSTRIES)) {
    const current = eligibility[industry] || "yes";
    const row = document.createElement("div");
    row.className = "organization-type-row";
    const name = document.createElement("span");
    name.className = "organization-type-name";
    name.textContent = industry;
    const choices = document.createElement("div");
    choices.className = "organization-type-choices";
    for (const [value, text] of [["yes", "Yes"], ["review", "Review"], ["no", "No"]]) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = industry;
      radio.value = value;
      radio.checked = current === value;
      label.append(radio, document.createTextNode(" " + text));
      choices.appendChild(label);
    }
    row.append(name, choices);
    wrap.appendChild(row);
  }
}

// Same pattern again, over CONFIRMED_KEYWORD_LANGUAGES (English is always
// implied - see storage.js's own comment - so it isn't offered as a
// checkbox to uncheck here).
function renderLanguageCheckboxes(selected) {
  const wrap = el("languages-checkbox-wrap");
  wrap.innerHTML = "";
  for (const language of CONFIRMED_KEYWORD_LANGUAGES) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = language;
    checkbox.checked = selected.includes(language);
    label.append(checkbox, document.createTextNode(" " + language));
    wrap.appendChild(label);
  }
}

function validatePriorityStep() {
  const order = ["priority-rank-1", "priority-rank-2", "priority-rank-3"].map((id) => el(id).value);
  if (new Set(order).size !== 3) return { valid: false, error: "Each rank must be a different criterion." };
  accountPriorityGuidelines.criteriaOrder = order;
  return { valid: true };
}

function validateAlwaysStep() {
  return { valid: true };
}

function validateLeadsPrioritizationStep() {
  const threshold = Number(el("leads-prioritization-threshold-input").value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    return { valid: false, error: "Target Account confidence threshold must be a number from 0 to 100." };
  }
  for (const row of el("leads-prioritization-rules-tbody").querySelectorAll("tr")) {
    const rule = prioritizationRules.find((r) => r.id === row.dataset.key);
    if (!rule) continue;
    rule.enabled = row.querySelector(".rule-enabled-checkbox").checked;
    const valueInput = row.querySelector(".rule-value-input");
    if (valueInput) rule.value = Number(valueInput.value);
  }
  syncPostRulesFromDom();
  return { valid: true };
}

// Re-reads the Post rule builder's DOM (built by renderPostPrioritizationRules)
// back into the working postPrioritizationRules array - same convention as
// the Job table loop just above. Called from the shared debounced
// autosave (via validateLeadsPrioritizationStep) for plain field edits;
// structural changes (add/remove/reorder rule or condition) instead mutate
// the array directly and re-render, since a mid-render DOM read can't
// recover a just-added/removed node's identity.
function syncPostRulesFromDom() {
  const list = el("post-rules-list");
  if (!list) return;
  for (const card of list.querySelectorAll(":scope > .rule-card")) {
    const rule = postPrioritizationRules[Number(card.dataset.ruleIndex)];
    if (!rule) continue;
    rule.name = card.querySelector(".post-rule-name-input").value;
    rule.effectType = card.querySelector(".post-rule-effect-select").value;
    rule.value = Number(card.querySelector(".post-rule-value-input").value);
    rule.enabled = card.querySelector(".post-rule-enabled-checkbox").checked;
    for (const row of card.querySelectorAll(":scope > .rule-conditions-list > .rule-condition-row")) {
      const cond = rule.conditions[Number(row.dataset.condIndex)];
      if (!cond) continue;
      if (cond.type === "column") {
        cond.column = row.querySelector(".cond-column-input").value.trim();
        cond.operator = row.querySelector(".cond-operator-select").value;
        if (cond.operator === "atLeast" || cond.operator === "atMost") {
          cond.value = Number(row.querySelector(".cond-numeric-value-input").value);
          delete cond.values;
        } else {
          cond.values = row.querySelector(".cond-values-textarea").value
            .split("\n").map((l) => l.trim()).filter(Boolean);
          delete cond.value;
        }
      } else if (cond.type === "topicMatch") {
        cond.topicNameContainsAnyOf = row.querySelector(".cond-topics-textarea").value
          .split("\n").map((l) => l.trim()).filter(Boolean);
      } else if (cond.type === "authorSeniorityAtLeast") {
        cond.value = Number(row.querySelector(".cond-seniority-value-select").value);
      }
    }
  }
}

function validateContactsStep() {
  const exactTitles = el("contacts-exact-titles-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  const titleKeywords = el("contacts-title-keywords-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (exactTitles.length === 0 && titleKeywords.length === 0) {
    return { valid: false, error: "Enter at least one exact title or title keyword." };
  }
  const maxContactsPerAccount = Number(el("contacts-max-per-account-input").value);
  if (!Number.isInteger(maxContactsPerAccount) || maxContactsPerAccount < 1) {
    return { valid: false, error: "Maximum contacts per target account must be a whole number of at least 1." };
  }
  targetContactProfile.exactTitles = exactTitles;
  targetContactProfile.titleKeywords = titleKeywords;
  targetContactProfile.maxContactsPerAccount = maxContactsPerAccount;
  const seniorityLevels = [];
  for (const row of el("seniority-checkbox-wrap").querySelectorAll(".priority-item-row")) {
    if (row.querySelector('input[type="checkbox"]').checked) {
      seniorityLevels.push({ id: row.dataset.key, priority: Number(row.querySelector(".priority-item-select").value) });
    }
  }
  targetContactProfile.seniorityLevels = seniorityLevels;
  return { valid: true };
}

// Config: which textarea feeds which category, in display order - the
// single source of truth for the Exclusions step's validate/render/init
// logic below, so adding a category later is a one-line change here.
const EXCLUSION_CATEGORY_INPUTS = EXCLUSION_CATEGORIES.map((category) => ({
  category,
  inputId: `exclusions-${category}-input`,
  listId: `exclusions-${category}-parsed-list`,
}));

function validateExclusionsStep() {
  companyExclusions = EXCLUSION_CATEGORY_INPUTS.flatMap(({ category, inputId }) =>
    parseCompetitorLines(el(inputId).value).map((slug) => ({ slug, category }))
  );
  return { valid: true };
}

function validateAliasesStep() {
  companyAliases = parseAliasLines(el("aliases-input").value);
  return { valid: true };
}

const STEP_VALIDATORS = {
  location: validateLocationStep,
  size: validateSizeStep,
  industry: validateIndustryStep,
  priority: validatePriorityStep,
  "leads-prioritization": validateLeadsPrioritizationStep,
  "company-context": validateAlwaysStep,
  "value-add-offers": validateAlwaysStep,
  icp: validateAlwaysStep,
  contacts: validateContactsStep,
  exclusions: validateExclusionsStep,
  aliases: validateAliasesStep,
};

// ---------------------------------------------------------------------
// Per-step persistence (only ever called from the Confirm button).

// When the scoring rules really changed, leave a flag the Posts Dashboard turns into a "Re-score existing leads now?"
// prompt (re-scoring is only ever needed after the rules change, so it is offered here rather than as a menu item).
function currentScoringSignature() {
  return JSON.stringify({
    rules: prioritizationRules.map((r) => [r.id, r.enabled, r.value]),
    threshold: Number(el("leads-prioritization-threshold-input").value),
    post: postPrioritizationRules,
  });
}

// The rules as they were when the wizard opened - the baseline for "did this visit change them", so the very first
// change is caught too (no stored signature exists yet then).
let scoringSignatureAtOpen = null;
let scoringRulesChangedThisVisit = false;

async function flagScoringRulesChangeIfAny() {
  const signature = currentScoringSignature();
  const { scoringRulesSignature } = await chrome.storage.local.get("scoringRulesSignature");
  const baseline = scoringRulesSignature || scoringSignatureAtOpen;
  const patch = { scoringRulesSignature: signature };
  if (baseline && baseline !== signature) {
    patch.scoringRulesChangedAt = Date.now();
    scoringRulesChangedThisVisit = true;
  }
  await chrome.storage.local.set(patch);
}

function showRescoreDialog() {
  return new Promise((resolve) => {
    const dialog = el("rescore-dialog");
    const done = (value) => {
      dialog.close();
      el("rescore-now-btn").onclick = null;
      el("rescore-later-btn").onclick = null;
      resolve(value);
    };
    el("rescore-now-btn").onclick = () => done(true);
    el("rescore-later-btn").onclick = () => done(false);
    dialog.showModal();
  });
}

// After Save & Exit / Finish: offer the re-score right when the user has just changed the rules. "Re-score now" opens
// the Posts Dashboard, which starts the re-score (its own confirmation still applies). Returns true when it navigated.
async function offerRescoreIfRulesChanged() {
  if (!scoringRulesChangedThisVisit) return false;
  scoringRulesChangedThisVisit = false;
  const now = await showRescoreDialog();
  if (!now) return false;
  const target = "dashboard.html#action=rescore-all";
  if (window.top !== window) window.top.location.href = target;
  else window.location.href = target;
  return true;
}

async function persistStep(step) {
  switch (step) {
    case "location":
    case "size":
      await saveTargetUniverseConfig(targetUniverseConfig);
      break;
    case "industry":
      await saveTargetUniverseConfig(targetUniverseConfig);
      await saveOrganizationTypeEligibility(organizationTypeEligibility);
      await saveKeywordSearchLanguages(keywordSearchLanguages);
      break;
    case "priority":
      await saveAccountPriorityGuidelines(accountPriorityGuidelines);
      break;
    case "leads-prioritization":
      await Promise.all(prioritizationRules.map((rule) =>
        savePrioritizationRuleOverride(rule.id, { enabled: rule.enabled, value: rule.value })
      ));
      await saveTargetAccountScoreThreshold(Number(el("leads-prioritization-threshold-input").value));
      await savePostPrioritizationRules(postPrioritizationRules);
      await flagScoringRulesChangeIfAny();
      break;
    case "company-context":
      await saveCompanyContext(el("company-context-input").value);
      await saveCompanyWebsite(el("company-website-input").value);
      break;
    case "value-add-offers":
      await saveValueAddOffers(
        el("value-add-offers-input").value.split("\n").map((l) => l.trim()).filter(Boolean)
      );
      break;
    case "icp":
      await saveIdealCustomerProfile(el("icp-input").value);
      break;
    case "contacts":
      await saveTargetContactProfile(targetContactProfile);
      break;
    case "exclusions":
      await saveCompanyExclusions(companyExclusions);
      break;
    case "aliases":
      await saveCompanyAliases(companyAliases);
      break;
  }
}

// ---------------------------------------------------------------------
// Per-step confirm-screen summary - built as real DOM nodes (not innerHTML)
// so nothing typed into a textarea needs manual escaping.

function appendPara(container, ...segments) {
  const p = document.createElement("p");
  for (const seg of segments) {
    if (typeof seg === "string") {
      p.appendChild(document.createTextNode(seg));
    } else {
      const strong = document.createElement("strong");
      strong.textContent = seg.strong;
      p.appendChild(strong);
    }
  }
  container.appendChild(p);
  return p;
}

function renderSummaryInto(step, container) {
  container.innerHTML = "";
  switch (step) {
    case "location": {
      const c = targetUniverseConfig;
      const where = c.locationMode === "continent"
        ? c.continents.map(formatLocationValue).join(", ")
        : c.countries.join(", ");
      appendPara(container, "Targeting companies in: ", { strong: where }, ` (by ${c.locationMode}).`);
      const priorities = Object.entries(c.locationPriorities || {}).filter(([, p]) => p !== 2);
      if (priorities.length) {
        const isPerContinent = c.locationMode === "continent" && c.continents.length > 1;
        appendPara(
          container, "Non-default priority: ",
          { strong: priorities.map(([k, p]) => `${isPerContinent ? formatLocationValue(k) : k} (${PRIORITY_LABELS[p]})`).join(", ") },
          "."
        );
      }
      break;
    }
    case "size": {
      const c = targetUniverseConfig;
      const checkedBuckets = SIZE_PRIORITY_BUCKETS.filter((b) => c.sizeBuckets?.[b.key]?.checked);
      const sizeText = checkedBuckets.length
        ? checkedBuckets.map((b) => `${b.label} (${PRIORITY_LABELS[c.sizeBuckets[b.key].priority]})`).join(", ")
        : "(none selected)";
      appendPara(container, "Size ranges: ", { strong: sizeText }, `. Up to `, { strong: String(c.maxCompanies) }, ` companies per Discovery run.`);
      break;
    }
    case "industry": {
      const industries = targetUniverseConfig.industries;
      if (industries.length) {
        appendPara(
          container, "Industries: ",
          { strong: industries.map((i) => `${i.name} (${PRIORITY_LABELS[i.priority]})`).join(", ") },
          "."
        );
      } else {
        appendPara(container, "No industry restriction.");
      }
      const nonDefault = Object.entries(organizationTypeEligibility).filter(([, v]) => v !== "yes");
      if (nonDefault.length) {
        appendPara(container, "Organization types: ", { strong: nonDefault.map(([k, v]) => `${k} (${v})`).join(", ") }, ".");
      }
      appendPara(container, "Languages considered: ", { strong: ["English", ...keywordSearchLanguages].join(", ") }, ".");
      break;
    }
    case "priority": {
      const g = accountPriorityGuidelines;
      const orderLabels = { size: "Size", location: "Location", industry: "Industry" };
      appendPara(container, "Priority order: ", { strong: g.criteriaOrder.map((k) => orderLabels[k]).join(" > ") }, ".");
      break;
    }
    case "leads-prioritization": {
      appendPara(container, "Target Account confidence threshold: ", { strong: el("leads-prioritization-threshold-input").value }, ".");
      const disabled = prioritizationRules.filter((r) => !r.enabled);
      if (disabled.length === 0) {
        appendPara(container, `All ${prioritizationRules.length} rules enabled.`);
      } else {
        appendPara(
          container, `${prioritizationRules.length - disabled.length} of ${prioritizationRules.length} rules enabled. Disabled: `,
          { strong: disabled.map((r) => PRIORITIZATION_RULE_LABELS[r.id] || r.id).join(", ") },
          "."
        );
      }
      const enabledPostRules = postPrioritizationRules.filter((r) => r.enabled);
      appendPara(
        container, "Post rules: ",
        { strong: `${enabledPostRules.length} of ${postPrioritizationRules.length} enabled` },
        "."
      );
      break;
    }
    case "company-context": {
      const value = el("company-context-input").value.trim();
      appendPara(container, value || "(left blank)");
      break;
    }
    case "value-add-offers": {
      const offers = el("value-add-offers-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
      if (offers.length) appendPara(container, `${offers.length} offer${offers.length === 1 ? "" : "s"}: `, { strong: offers.join(", ") }, ".");
      else appendPara(container, "(left blank)");
      break;
    }
    case "icp": {
      const value = el("icp-input").value.trim();
      appendPara(container, value || "(left blank)");
      break;
    }
    case "contacts": {
      if (targetContactProfile.exactTitles.length) appendPara(container, "Exact titles: ", { strong: targetContactProfile.exactTitles.join(", ") });
      if (targetContactProfile.titleKeywords.length) appendPara(container, "Title keywords: ", { strong: targetContactProfile.titleKeywords.join(", ") });
      if ((targetContactProfile.seniorityLevels || []).length) {
        const priorityLabel = (p) => SENIORITY_PRIORITY_OPTIONS.find(([v]) => v === String(p))?.[1] || p;
        const labelById = new Map(SENIORITY_LEVELS.map((l) => [l.id, l.label]));
        appendPara(container, "Preferred seniority: ", {
          strong: targetContactProfile.seniorityLevels
            .map((s) => `${labelById.get(s.id) || s.id} (${priorityLabel(s.priority)})`)
            .join(", "),
        });
      }
      appendPara(container, "Up to ", { strong: String(targetContactProfile.maxContactsPerAccount) }, " contacts per target account.");
      break;
    }
    case "exclusions": {
      if (companyExclusions.length) {
        for (const category of EXCLUSION_CATEGORIES) {
          const slugs = companyExclusions.filter((e) => e.category === category).map((e) => e.slug);
          if (slugs.length) {
            appendPara(
              container, `Excluding ${slugs.length} ${EXCLUSION_CATEGORY_LABELS[category].toLowerCase()}${slugs.length === 1 ? "" : "s"}: `,
              { strong: slugs.join(", ") }, "."
            );
          }
        }
      } else {
        appendPara(container, "No companies to exclude.");
      }
      break;
    }
    case "aliases": {
      if (companyAliases.length) {
        appendPara(container, `Mapping ${companyAliases.length} alias${companyAliases.length === 1 ? "" : "es"}: `, { strong: companyAliases.map((a) => `${a.aliasSlug} → ${a.canonicalSlug}`).join(", ") }, ".");
      } else {
        appendPara(container, "No company aliases mapped.");
      }
      break;
    }
  }
}

function showConfirm(step) {
  el(`enter-${step}`).hidden = true;
  const confirmView = el("confirm-view");
  confirmView.hidden = false;
  el("wizard-nav-bar").hidden = true; // confirm-view has its own Change/Confirm buttons
  renderSummaryInto(step, el("confirm-summary"));

  el("confirm-change-btn").onclick = () => {
    confirmView.hidden = true;
    el(`enter-${step}`).hidden = false;
    updateNavBar(step, currentStepIndex);
  };
  el("confirm-btn").onclick = async () => {
    await persistStep(step);
    confirmView.hidden = true;
    showStep(currentStepIndex + 1);
  };
}

function showStepError(step, message) {
  const errorEl = document.querySelector(`#enter-${step} .step-error`);
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
}

function clearStepError(step) {
  const errorEl = document.querySelector(`#enter-${step} .step-error`);
  if (errorEl) errorEl.hidden = true;
}

// ---------------------------------------------------------------------
// Step 1: Location - mounted once at init() with the full ALL_COUNTRIES
// list (storage.js), not just geo-urn-map.js's smaller CONFIRMED_COUNTRIES
// subset - widened 2026-09-16 when this step became the one location
// setting driving both Discovery's company search AND lead filtering
// (previously Settings' own separate Location Filter, now unified here).
// Discovery's own search still only ever uses whichever selected countries
// have a confirmed geoUrn; the rest just apply to filtering leads.

function renderLocationModeVisibility() {
  const mode = el("location-mode-select").value;
  el("location-continents-wrap").style.display = mode === "continent" ? "" : "none";
  el("location-countries-wrap").style.display = mode === "country" ? "" : "none";
}

// ---------------------------------------------------------------------
// Step 4: Priority guidelines - the rank selects and top-location/industry
// checkbox lists are rebuilt every time this step is (re-)entered, since
// the location/industry choices they draw from can only be known after
// steps 1 and 3 have run.

// Priority step redesign (2026-09-16) - shrunk to just the criteriaOrder
// ranking; topSize/topLocations/topIndustries removed outright, each
// superseded by a per-item priority living on its own step instead
// (Location/Size/Industry above). Rendered once at init() like Size/
// Industry - doesn't need Location's "rebuild on every entry" treatment,
// since criteriaOrder doesn't depend on anything chosen elsewhere.
function renderPriorityStepOptions() {
  const criteria = ["size", "location", "industry"];
  const labels = { size: "Size", location: "Location", industry: "Industry" };
  const currentOrder = accountPriorityGuidelines.criteriaOrder;
  ["priority-rank-1", "priority-rank-2", "priority-rank-3"].forEach((id, i) => {
    const select = el(id);
    select.innerHTML = "";
    for (const c of criteria) {
      const option = document.createElement("option");
      option.value = c;
      option.textContent = labels[c];
      select.appendChild(option);
    }
    select.value = currentOrder[i] || criteria[i];
  });
}

// ---------------------------------------------------------------------
// Leads Prioritization - moved here from settings.js 2026-09-16 (was its
// own "Prioritization Rules" section there). Unlike that page's old
// save-immediately-on-change table, this follows the wizard's normal
// convention: rows edit the working `prioritizationRules` array in place,
// validateLeadsPrioritizationStep re-reads the DOM into it, and
// persistStep's "leads-prioritization" case is what actually calls
// savePrioritizationRuleOverride, on Confirm or the shared debounced
// autosave - same as every other step, not a special case. Rendered once
// at init() - doesn't depend on anything chosen elsewhere, like Size/
// Industry's checkbox lists.
//
// The Settings page version also showed 2 unrelated "exclusion rule" rows
// (Competitor Blocklist, Location Filter) as a shortcut into their own
// real toggles elsewhere - dropped here (not moved), since they aren't
// actually part of PRIORITIZATION_RULE_CATALOG and each already has its
// own real control (side panel's Negative Topics; this wizard's Location
// step).
function ruleValueCell(rule) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = "5";
  input.value = rule.value;
  input.className = "rule-value-input";
  input.title = `${rule.type === "decisive" ? "Decisive" : rule.type === "floor" ? "Floor" : "Ceiling"} value for this rule`;
  td.appendChild(input);
  return td;
}

function emptyValueCell() {
  const td = document.createElement("td");
  td.className = "rule-value-empty";
  td.textContent = "—";
  return td;
}

function renderLeadsPrioritizationRules() {
  const tbody = el("leads-prioritization-rules-tbody");
  tbody.innerHTML = "";
  for (const rule of prioritizationRules) {
    const tr = document.createElement("tr");
    tr.dataset.key = rule.id;

    const nameTd = document.createElement("td");
    nameTd.textContent = PRIORITIZATION_RULE_LABELS[rule.id] || rule.id;

    const descTd = document.createElement("td");
    descTd.className = "rule-description";
    descTd.textContent = rule.description;

    const ceilingTd = rule.type === "ceiling" ? ruleValueCell(rule) : emptyValueCell();
    const floorTd = rule.type === "floor" ? ruleValueCell(rule) : emptyValueCell();
    const decisiveTd = rule.type === "decisive" ? ruleValueCell(rule) : emptyValueCell();

    const enabledTd = document.createElement("td");
    const enabledCheckbox = document.createElement("input");
    enabledCheckbox.type = "checkbox";
    enabledCheckbox.className = "rule-enabled-checkbox";
    enabledCheckbox.checked = rule.enabled;
    enabledCheckbox.title = "Disable to let the Sales Mentor decide these leads entirely on its own";
    enabledTd.appendChild(enabledCheckbox);

    tr.append(nameTd, descTd, ceilingTd, floorTd, decisiveTd, enabledTd);
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------
// Post rule builder (PRD 6.20, generalized 2026-09-16) - full visual editor
// for storage.js's getPostPrioritizationRules/savePostPrioritizationRules
// (see the constants/comment above PRIORITIZATION_RULE_LABELS). Unlike the
// Job table above, structural edits (add/remove/reorder a rule or
// condition) can't wait for the shared debounced autosave to re-read the
// DOM - a just-removed node has nothing left to read - so those mutate
// `postPrioritizationRules` directly and re-render immediately; plain
// field edits (typing a name, picking an operator's values) are instead
// picked up by syncPostRulesFromDom via the normal autosave path, same
// convention as everywhere else in this wizard.

// Small DOM-builder helper, used only by this section - keeps the deeply
// nested rule/condition markup below readable without resorting to
// innerHTML (which would need manual escaping for user-typed rule names,
// column ids, and condition values).
function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "list") node.setAttribute("list", value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node[key] = value;
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function defaultPostRuleCondition(type) {
  switch (type) {
    case "column": return { type: "column", column: "", operator: "equalsAnyOf", values: [] };
    case "topicMatch": return { type: "topicMatch", topicNameContainsAnyOf: [] };
    case "authorSeniorityAtLeast": return { type: "authorSeniorityAtLeast", value: 2 };
    default: return { type };
  }
}

function defaultPostRule() {
  return { id: crypto.randomUUID(), name: "New rule", conditions: [], effectType: "floor", value: 3, enabled: true };
}

function postRuleValueTitle(effectType) {
  if (effectType === "decisive") return "Sets Priority to this value directly, skipping the Sales Mentor";
  if (effectType === "ceiling") return "Never lets the Sales Mentor's Priority go above this";
  return "Never lets the Sales Mentor's Priority go below this";
}

function addPostRule() {
  postPrioritizationRules.push(defaultPostRule());
  renderPostPrioritizationRules();
  scheduleAutoSave();
}

function removePostRule(ruleIndex) {
  postPrioritizationRules.splice(ruleIndex, 1);
  renderPostPrioritizationRules();
  scheduleAutoSave();
}

function movePostRule(ruleIndex, delta) {
  const target = ruleIndex + delta;
  if (target < 0 || target >= postPrioritizationRules.length) return;
  const [rule] = postPrioritizationRules.splice(ruleIndex, 1);
  postPrioritizationRules.splice(target, 0, rule);
  renderPostPrioritizationRules();
  scheduleAutoSave();
}

function addPostRuleCondition(ruleIndex, type) {
  postPrioritizationRules[ruleIndex].conditions.push(defaultPostRuleCondition(type));
  renderPostPrioritizationRules();
  scheduleAutoSave();
}

function removePostRuleCondition(ruleIndex, condIndex) {
  postPrioritizationRules[ruleIndex].conditions.splice(condIndex, 1);
  renderPostPrioritizationRules();
  scheduleAutoSave();
}

function buildPostRuleConditionRow(ruleIndex, cond, condIndex) {
  const row = h("div", { className: "rule-condition-row", dataset: { condIndex: String(condIndex) } });
  if (condIndex > 0) row.appendChild(h("span", { className: "rule-condition-and-label", textContent: "AND" }));

  if (cond.type === "column") {
    row.appendChild(h("span", { className: "rule-condition-type-label", textContent: "Column" }));
    const isNumeric = cond.operator === "atLeast" || cond.operator === "atMost";
    const columnInput = h("input", {
      type: "text", className: "cond-column-input", value: cond.column || "",
      placeholder: "e.g. aiPriority", list: "post-rule-column-options",
    });
    const operatorSelect = h("select", { className: "cond-operator-select" }, [
      h("option", { value: "equalsAnyOf", textContent: "equals any of" }),
      h("option", { value: "containsAnyOf", textContent: "contains any of" }),
      h("option", { value: "atLeast", textContent: "is at least" }),
      h("option", { value: "atMost", textContent: "is at most" }),
    ]);
    operatorSelect.value = cond.operator || "equalsAnyOf";
    const valuesTextarea = h("textarea", {
      className: "cond-values-textarea", placeholder: "One value per line", hidden: isNumeric,
    });
    valuesTextarea.value = (cond.values || []).join("\n");
    const numericInput = h("input", {
      type: "number", className: "cond-numeric-value-input", value: cond.value ?? 0, hidden: !isNumeric,
    });
    operatorSelect.addEventListener("change", () => {
      cond.operator = operatorSelect.value;
      const nowNumeric = cond.operator === "atLeast" || cond.operator === "atMost";
      if (nowNumeric) { delete cond.values; cond.value = cond.value ?? 0; } else { delete cond.value; cond.values = cond.values || []; }
      renderPostPrioritizationRules();
      scheduleAutoSave();
    });
    row.appendChild(h("div", { className: "rule-condition-fields" }, [columnInput, operatorSelect, valuesTextarea, numericInput]));
  } else if (cond.type === "companyHasMatch") {
    row.appendChild(h("span", { className: "rule-condition-type-label", textContent: "Account appears in the Target Accounts list" }));
  } else if (cond.type === "authorIsTargetContact") {
    row.appendChild(h("span", { className: "rule-condition-type-label", textContent: "Post's author is a verified Target Contact" }));
  } else if (cond.type === "authorSeniorityAtLeast") {
    row.appendChild(h("span", { className: "rule-condition-type-label", textContent: "Post's author is a verified Target Contact whose matched seniority is at least" }));
    const senioritySelect = h("select", { className: "cond-seniority-value-select" },
      SENIORITY_PRIORITY_OPTIONS.map(([value, text]) => h("option", { value, textContent: text })));
    senioritySelect.value = String(cond.value ?? 2);
    const fields = h("div", { className: "rule-condition-fields" }, [senioritySelect]);
    fields.appendChild(h("p", {
      className: "field-hint",
      textContent: "Only matches a contact discovered while a seniority level was selected in the Contacts step - see that step's own priority for each level.",
    }));
    row.appendChild(fields);
  } else if (cond.type === "topicMatch") {
    row.appendChild(h("span", { className: "rule-condition-type-label", textContent: "Post matched a Topic named" }));
    const topicsTextarea = h("textarea", { className: "cond-topics-textarea", placeholder: "One topic name (or partial name) per line" });
    topicsTextarea.value = (cond.topicNameContainsAnyOf || []).join("\n");
    const fields = h("div", { className: "rule-condition-fields" }, [topicsTextarea]);
    if (availableTopicNames.length) {
      fields.appendChild(h("p", { className: "field-hint", textContent: `Your configured topics: ${availableTopicNames.join(", ")}` }));
    }
    row.appendChild(fields);
  }

  row.appendChild(h("button", {
    type: "button", className: "cond-remove-btn", title: "Remove this condition", textContent: "✕",
    onclick: () => removePostRuleCondition(ruleIndex, condIndex),
  }));
  return row;
}

function buildPostRuleCard(rule, ruleIndex) {
  const nameInput = h("input", { type: "text", className: "post-rule-name-input", value: rule.name });
  const effectSelect = h("select", { className: "post-rule-effect-select" }, [
    h("option", { value: "floor", textContent: "Floor" }),
    h("option", { value: "ceiling", textContent: "Ceiling" }),
    h("option", { value: "decisive", textContent: "Decisive" }),
  ]);
  effectSelect.value = rule.effectType;
  const valueInput = h("input", {
    type: "number", className: "post-rule-value-input", min: "1", max: "5", value: rule.value,
    title: postRuleValueTitle(rule.effectType),
  });
  effectSelect.addEventListener("change", () => { valueInput.title = postRuleValueTitle(effectSelect.value); });
  const enabledLabel = h("label", { className: "post-rule-enabled-label" }, [
    h("input", { type: "checkbox", className: "post-rule-enabled-checkbox", checked: rule.enabled }),
    " Enabled",
  ]);

  const header = h("div", { className: "rule-card-header" }, [
    nameInput, effectSelect, valueInput, enabledLabel,
    h("button", { type: "button", className: "rule-move-btn", title: "Move up", textContent: "↑", onclick: () => movePostRule(ruleIndex, -1) }),
    h("button", { type: "button", className: "rule-move-btn", title: "Move down", textContent: "↓", onclick: () => movePostRule(ruleIndex, 1) }),
    h("button", { type: "button", className: "rule-remove-btn", textContent: "Delete rule", onclick: () => removePostRule(ruleIndex) }),
  ]);

  const conditionsWrap = h(
    "div", { className: "rule-conditions-list" },
    rule.conditions.map((cond, condIndex) => buildPostRuleConditionRow(ruleIndex, cond, condIndex))
  );

  const addRow = h("div", { className: "rule-condition-add-row" }, [
    h("span", { textContent: "+ Add condition:" }),
    ...POST_RULE_CONDITION_TYPES.map((ct) => h("button", {
      type: "button", className: "add-condition-btn", textContent: ct.label,
      onclick: () => addPostRuleCondition(ruleIndex, ct.type),
    })),
  ]);

  return h("div", { className: "rule-card", dataset: { ruleIndex: String(ruleIndex) } }, [header, conditionsWrap, addRow]);
}

function renderPostPrioritizationRules() {
  const list = el("post-rules-list");
  list.innerHTML = "";
  postPrioritizationRules.forEach((rule, ruleIndex) => list.appendChild(buildPostRuleCard(rule, ruleIndex)));
}

function populatePostRuleColumnOptions() {
  const datalist = el("post-rule-column-options");
  datalist.innerHTML = "";
  for (const columnName of availableCompanyColumnNames) {
    datalist.appendChild(h("option", { value: columnName }));
  }
}

el("add-post-rule-btn").addEventListener("click", addPostRule);

// ---------------------------------------------------------------------
// Step 9: Companies to exclude - live per-line parse feedback as the user
// types, separate from (and not a substitute for) the Next-button
// validation above, which just re-derives the same parsed list on submit.
// One render function shared by all 5 category textareas (unified
// 2026-09-17 from 4 nearly-identical copies, one per old separate step) -
// EXCLUSION_CATEGORY_INPUTS (above, next to validateExclusionsStep) is the
// single source of truth for which textarea/list pair goes with which
// category.

function parseCompetitorLines(rawValue) {
  return rawValue.split("\n").map((l) => l.trim()).filter(Boolean).map(parseLinkedinCompanySlug).filter(Boolean);
}

// Step 12: Company aliases - each line is "<alias URL> -> <canonical URL>";
// a line missing the "->" separator, or where either side isn't a real
// LinkedIn company URL, is simply dropped (surfaced as a bad line in
// renderAliasesParsedList below, same as a bad exclusion line).
function parseAliasLines(rawValue) {
  const aliases = [];
  for (const line of rawValue.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [aliasPart, canonicalPart] = line.split("->");
    if (canonicalPart === undefined) continue;
    const aliasSlug = parseLinkedinCompanySlug(aliasPart);
    const canonicalSlug = parseLinkedinCompanySlug(canonicalPart);
    if (aliasSlug && canonicalSlug && aliasSlug !== canonicalSlug) aliases.push({ aliasSlug, canonicalSlug });
  }
  return aliases;
}

function renderExclusionParsedList(inputId, listId) {
  const lines = el(inputId).value.split("\n").map((l) => l.trim()).filter(Boolean);
  const listEl = el(listId);
  listEl.innerHTML = "";
  for (const line of lines) {
    const slug = parseLinkedinCompanySlug(line);
    const row = document.createElement("div");
    row.className = slug ? "competitor-line-ok" : "competitor-line-bad";
    row.textContent = slug ? `✓ ${slug}` : `✗ couldn't find a LinkedIn company page in "${line}"`;
    listEl.appendChild(row);
  }
}

for (const { inputId, listId } of EXCLUSION_CATEGORY_INPUTS) {
  el(inputId).addEventListener("input", () => renderExclusionParsedList(inputId, listId));
}

// ---------------------------------------------------------------------
// Step 12: Company aliases - live per-line parse feedback, same idea as
// the Exclusions step above but each line is a pair, not a single slug.

function renderAliasesParsedList() {
  const lines = el("aliases-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  const listEl = el("aliases-parsed-list");
  listEl.innerHTML = "";
  for (const line of lines) {
    const [aliasPart, canonicalPart] = line.split("->");
    const aliasSlug = parseLinkedinCompanySlug(aliasPart);
    const canonicalSlug = canonicalPart !== undefined ? parseLinkedinCompanySlug(canonicalPart) : null;
    const row = document.createElement("div");
    if (canonicalPart === undefined) {
      row.className = "competitor-line-bad";
      row.textContent = `✗ "${line}" is missing "->" between the alias and canonical URLs`;
    } else if (!aliasSlug || !canonicalSlug) {
      row.className = "competitor-line-bad";
      row.textContent = `✗ couldn't find a LinkedIn company page on both sides of "${line}"`;
    } else if (aliasSlug === canonicalSlug) {
      row.className = "competitor-line-bad";
      row.textContent = `✗ "${aliasSlug}" can't be an alias of itself`;
    } else {
      row.className = "competitor-line-ok";
      row.textContent = `✓ ${aliasSlug} → ${canonicalSlug}`;
    }
    listEl.appendChild(row);
  }
}

el("aliases-input").addEventListener("input", renderAliasesParsedList);

// ---------------------------------------------------------------------
// Continuous auto-save ("Save Draft" without a separate action) - reported
// directly: the competitors step alone can take a long time (looking up
// 25+ companies on LinkedIn one at a time), so losing whatever's been typed
// into the *current*, not-yet-confirmed step to an accidental tab close is
// a real cost. Reuses each step's own validator purely for its
// state-capturing side effect (every validator mutates the relevant
// working-state object regardless of whether it returns valid: true) and
// then persists via the same persistStep used on Confirm - same real
// storage, not a separate draft layer, consistent with this codebase's
// existing auto-save-always convention (Settings). Debounced so fast
// typing doesn't trigger a storage write per keystroke.
let autoSaveTimeout = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(async () => {
    const step = STEP_ORDER[currentStepIndex];
    if (step === "finish") return;
    STEP_VALIDATORS[step]?.();
    await persistStep(step);
  }, 800);
}
el("onboarding-main").addEventListener("input", scheduleAutoSave);
el("onboarding-main").addEventListener("change", scheduleAutoSave);

// ---------------------------------------------------------------------
// Step 9: Finish - recaps every earlier step (reusing the same per-step
// summary renderer the confirm screens use) plus the Finish button.

function renderFinishSummary() {
  const container = el("finish-summary");
  container.innerHTML = "";
  for (const step of STEP_ORDER) {
    if (step === "finish") continue;
    const heading = document.createElement("h4");
    heading.textContent = STEP_TITLES[step];
    container.appendChild(heading);
    renderSummaryInto(step, container);
  }
}

// Auto-navigates to settings.html once saved (redesigned 2026-09-16) -
// reported directly: the old "relabel to Setup saved and stop" left the
// user stranded on the onboarding tab with no way back except closing it.
el("finish-back-to-menu-link").addEventListener("click", (event) => {
  event.preventDefault();
  el("finish-btn").click();
});

// Change Settings: leaving saves the open setting first, then runs the same checks as Save & Exit.
el("change-back-to-menu-link").addEventListener("click", async (event) => {
  event.preventDefault();
  const step = STEP_ORDER[currentStepIndex];
  if (step !== "finish") {
    STEP_VALIDATORS[step]?.();
    await persistStep(step);
  }
  await warnIfDiscoveryNowStale();
  if (await offerRescoreIfRulesChanged()) return;
  leaveWizard();
});

el("finish-btn").addEventListener("click", async () => {
  await markOnboardingCompleted();
  await warnIfDiscoveryNowStale();
  if (await offerRescoreIfRulesChanged()) return;
  leaveWizard();
});

// ---------------------------------------------------------------------

async function init() {
  el("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
  renderWizardStepList();

  targetUniverseConfig = await getTargetUniverseConfig();
  accountPriorityGuidelines = await getAccountPriorityGuidelines();
  targetContactProfile = await getTargetContactProfile();
  const discoveryQueueState = await getDiscoveryQueueState();
  // Normalized the same way a fresh getTargetUniverseConfig() read always
  // is (storage.js's normalizeTargetUniverseConfig) - this snapshot is a
  // raw deep-clone frozen at the run's own Start time, never normalized on
  // its own, so a run started before the Size/Industry schema redesign
  // would otherwise always compare as "changed" against any current
  // config, a real false-positive bug found live 2026-09-16.
  priorDiscoveryConfigSnapshot = discoveryQueueState.status === "idle"
    ? null
    : normalizeTargetUniverseConfig(discoveryQueueState.configSnapshot);
  // Recruiter defaults (well-known global agencies) are seeded once, inside
  // getCompanyExclusions itself (storage.js's migrateLegacyExclusionListsIfNeeded) -
  // this step just reads back whatever that returns, same as every other field.
  companyExclusions = await getCompanyExclusions();
  organizationTypeEligibility = await getOrganizationTypeEligibility();
  keywordSearchLanguages = await getKeywordSearchLanguages();

  locationPicker = mountLocationPicker(
    {
      modeSelect: el("location-mode-select"),
      continentsWrap: el("location-continents-wrap"),
      countriesWrap: el("location-countries-wrap"),
      search: el("location-countries-search"),
      available: el("location-countries-available"),
      selected: el("location-countries-selected"),
      addBtn: el("location-country-add-btn"),
      removeBtn: el("location-country-remove-btn"),
      countEl: el("location-countries-count"),
    },
    ALL_COUNTRIES,
    // The dual-listbox's add/remove buttons move <option> elements
    // programmatically, which fires neither a native "change" nor "input"
    // event on anything - the delegated auto-save listener below would
    // never see it, so this step's own picker changes need their own
    // explicit hook into the same auto-save. Also refreshes the Location
    // priority rows below, since their granularity depends on this same
    // selection.
    {
      onCountriesChange: () => { refreshLocationPriorityRows(); scheduleAutoSave(); },
      onModeOrContinentChange: () => { refreshLocationPriorityRows(); scheduleAutoSave(); },
    },
  );
  locationPicker.setValue({
    mode: targetUniverseConfig.locationMode === "off" ? "country" : targetUniverseConfig.locationMode,
    continents: targetUniverseConfig.continents,
    countries: targetUniverseConfig.countries,
  });
  renderLocationModeVisibility();
  el("location-mode-select").addEventListener("change", renderLocationModeVisibility);

  renderSizeBucketRows(targetUniverseConfig.sizeBuckets);
  el("size-max-companies-input").value = targetUniverseConfig.maxCompanies;

  renderIndustryPriorityRows(targetUniverseConfig.industries);
  renderOrganizationTypeRows(organizationTypeEligibility);
  renderLanguageCheckboxes(keywordSearchLanguages);
  // Any industry (clear) / Select all - toggle every row's checkbox plus its
  // select's disabled state and unchecked styling directly, since setting
  // .checked programmatically doesn't fire the row's own 'change' listener
  // (renderIndustryPriorityRows) that normally keeps those in sync.
  function setAllIndustryRows(checked) {
    for (const row of el("industry-checkbox-wrap").querySelectorAll(".priority-item-row")) {
      row.querySelector('input[type="checkbox"]').checked = checked;
      row.querySelector(".priority-item-select").disabled = !checked;
      row.classList.toggle("priority-item-unchecked", !checked);
    }
    scheduleAutoSave();
  }
  el("industry-select-none-btn").addEventListener("click", () => setAllIndustryRows(false));
  el("industry-select-all-btn").addEventListener("click", () => setAllIndustryRows(true));
  renderPriorityStepOptions();
  el("leads-prioritization-threshold-input").value = await getTargetAccountScoreThreshold();
  prioritizationRules = await getPrioritizationRules();
  renderLeadsPrioritizationRules();
  postPrioritizationRules = await getPostPrioritizationRules();
  availableTopicNames = (await getTopics()).map((t) => t.name).filter(Boolean);
  const workbook = await getTargetAccountsWorkbook();
  // Excludes the internal "ai"-prefixed alias keys (xlsx-lite.js's
  // AI_FIELD_ALIASES) - reported directly, 2026-09-17: these still showed
  // up as suggested column names even after the user's real workbook fully
  // dropped every "AI" mention from its own headers. Since that aliasing
  // is now bidirectional (a legacy AI_-prefixed workbook backfills the
  // short key too, not just the reverse), the short name is always the
  // one to show - it's genuinely present either way, and it's what an
  // actual column header looks like today.
  const aiAliasTargets = new Set(Object.values(AI_FIELD_ALIASES));
  availableCompanyColumnNames = Array.from(
    new Set((workbook.companies || []).flatMap((c) => Object.keys(c)))
  ).filter((key) => !aiAliasTargets.has(key)).sort();
  populatePostRuleColumnOptions();
  renderPostPrioritizationRules();
  el("company-context-input").value = await getCompanyContext();
  el("company-website-input").value = await getCompanyWebsite();
  el("value-add-offers-input").value = (await getValueAddOffers()).join("\n");
  el("icp-input").value = await getIdealCustomerProfile();
  el("contacts-exact-titles-input").value = targetContactProfile.exactTitles.join("\n");
  el("contacts-title-keywords-input").value = targetContactProfile.titleKeywords.join("\n");
  el("contacts-max-per-account-input").value = targetContactProfile.maxContactsPerAccount ?? 10;
  renderSeniorityLevelPriorityRows(targetContactProfile.seniorityLevels || []);
  for (const { category, inputId, listId } of EXCLUSION_CATEGORY_INPUTS) {
    const slugs = companyExclusions.filter((e) => e.category === category).map((e) => e.slug);
    el(inputId).value = slugs.map((slug) => `https://www.linkedin.com/company/${slug}/`).join("\n");
    renderExclusionParsedList(inputId, listId);
  }
  companyAliases = await getCompanyAliases();
  el("aliases-input").value = companyAliases
    .map((a) => `https://www.linkedin.com/company/${a.aliasSlug}/ -> https://www.linkedin.com/company/${a.canonicalSlug}/`)
    .join("\n");
  renderAliasesParsedList();

  // Resume where a previous session left off, not always step 1 - see
  // showStep()'s own comment for why this matters for a run that can take
  // "tens of minutes to several hours." Bounded to a valid index in case
  // STEP_ORDER's length ever changes between visits.
  scoringSignatureAtOpen = currentScoringSignature();
  scanFieldsAtOpen = scanAffectingFields(targetUniverseConfig, targetContactProfile);
  if (settingsMode) {
    document.body.classList.add("settings-mode");
    el("page-title-text").textContent = "Change Settings";
    el("page-subtitle-setup").hidden = true;
    el("page-subtitle-change").hidden = false;
    el("linkedin-use-note").hidden = true; // the note belongs to the first-time setup, not to Change Settings
    el("change-back-to-menu-link").hidden = false;
    showSettingsHome();
    return;
  }
  const savedStepIndex = await getOnboardingProgressStepIndex();
  furthestStepIndex = 0;
  showStep(Math.min(Math.max(savedStepIndex, 0), STEP_ORDER.length - 1));
}

// The page stays hidden until init() has chosen what to show, so the default first step never flashes on screen
// (reported 2026-09-21: Change Settings briefly showed a setup step before its own list).
init().finally(() => document.documentElement.classList.add("wizard-ready"));

// Inside the Settings page the menu is already on the left, so this page's own "SalesTeam menu" button is not needed.
if (window.top !== window) document.documentElement.classList.add("in-settings-shell");

// On a fresh install (right after a reinstall) this page offers "restore from a backup"; see backup-restore.js.
startAutoBackup();
