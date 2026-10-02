// Onboarding wizard (PRD 6.20 Phase 1/2) - a linear, numbered explain -> enter
// -> confirm flow that captures targetUniverseConfig, targetContactProfile,
// accountPriorityGuidelines, companyExclusions, organizationTypeEligibility,
// companyAliases, companyContext, idealCustomerProfile and valueAddOffers
// (storage.js) - the sole home for the first two of those (moved out of
// settings.html 2026-09-16, which now just points here) and, since the same
// day, valueAddOffers too (also moved out of settings.html, as a new
// optional step here). Phase 5/6 (company/contact discovery scanning)
// consume everything captured here.
import { rescoreDerivedPriorities } from "./auto-score.js";
import {
  getPipelineAutomation, setPipelineAutomationEnabled, CONSENT_TITLE, CONSENT_TEXT,
  setWebResearchAutomation, WEB_CONSENT_TITLE, WEB_CONSENT_TEXT, DEFAULT_WEB_BUDGET_USD,
} from "./pipeline-automation.js";
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
  getJobRulesMinConfidence,
  saveJobRulesMinConfidence,
  CONFIDENCE_LEVELS,
  getPostPrioritizationRules,
  savePostPrioritizationRules,
  getTopics,
  getTargetAccountsWorkbook,
  SENIORITY_LEVELS,
  getUserProfile, saveUserProfile, getOutputLanguage, saveOutputLanguage,
  getAnthropicApiKey, saveAnthropicApiKey, getSellerCompanyName, saveSellerCompanyName,
  getSetupResearch, saveSetupResearch, getOnboardingCompletedAt, appendActivityLog,
  getCompletionTargets, saveCompletionTargets, getInitiativeStagePreference, saveInitiativeStagePreference,
  getIncludedCompanies, saveIncludedCompanies, getOnboardingMeasures, getTargetsStatus,
} from "./storage.js";
import { INITIATIVE_STAGE_LABELS, normalizeInitiativeStages, normalizeCompletionTargets, TARGET_LIMITS } from "./pipeline-plan.js";
import { onboardingEstimate } from "./onboarding-estimate.js";
import { researchSeller, SELLER_RESEARCH_ESTIMATE_USD, sanitizeApiKey } from "./agent-shared.js";
import {
  buildSetupProposals, PROPOSAL_STEP_KEYS, stepsRebuiltBy, initiallyTicked, mergeChecklistWithLines, offerLine, sourceLabel,
} from "./setup-proposals.js";
import { renderProposalBanner, mountChecklist } from "./proposal-ui.js";
import { normalizeCompanyName, websiteDomain, buildExclusionMatcher, matchesExclusion } from "./company-identity.js";
import { startAutoBackup } from "./backup-restore.js";
import { mountLocationPicker } from "./location-picker.js";
import { AI_FIELD_ALIASES } from "./xlsx-lite.js";
import { CONFIRMED_INDUSTRIES, EXCLUDABLE_INDUSTRIES } from "./industry-id-map.js";
import { getDiscoveryQueueState, resetDiscoveryQueue } from "./discovery-queue.js";

// Shared 1-3 priority scale (Location/Size/Industry, all added 2026-09-16) -
// same Low/Medium/High labels, same numeric values, everywhere it's used.
const PRIORITY_LABELS = { 1: "Low", 2: "Medium", 3: "High" };

const STEP_ORDER = [
  "about", "location", "size", "industry", "priority", "leads-prioritization", "company-context", "value-add-offers",
  "icp", "contacts", "initiative-stages", "included", "exclusions", "aliases", "targets", "finish",
];
const STEP_TITLES = {
  about: "About you", location: "Location", size: "Size", industry: "Industry", priority: "Discovery Prioritization",
  "leads-prioritization": "Leads Prioritization",
  "company-context": "What you sell", "value-add-offers": "Things you can offer",
  icp: "Ideal customer", contacts: "Target contacts",
  "initiative-stages": "Initiative stages", included: "Companies to include",
  exclusions: "Companies to exclude",
  aliases: "Company aliases",
  targets: "How big is your list",
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
// 1.2.1 step 6: [{ id, checked }] in the user's order; [{ name, website }]; { accounts, contactsPerAccount, initiativesPerAccount }.
let initiativeStages = normalizeInitiativeStages(null);
let includedCompanies = [];
let completionTargets = normalizeCompletionTargets(null);
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
// Setup was saved (design 5.4, build step 3): targeting may have changed, so the derived priorities are
// re-scored at once (local, free), and the automatic pipeline is kicked. The kick does nothing unless
// automation is on.
async function afterSetupSaved() {
  try { await rescoreDerivedPriorities(); } catch { /* the next Target Accounts open re-scores anyway */ }
  chrome.runtime.sendMessage({ type: "PIPELINE_KICK", source: "setup_saved" }).catch(() => {});
}

function leaveWizard() {
  afterSetupSaved().finally(leaveWizardNow);
}

function leaveWizardNow() {
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
    // 1.2.0.41: on a step, "Save & Exit to menu" already leaves - a second exit button only added doubt. It stays on
    // the finish screen, which has no Save & Exit.
    el("nav-exit-btn").hidden = !settingsMode;
    el("nav-save-exit-btn").hidden = false;
    el("nav-save-btn").hidden = false;
    // Change Settings ends at the last setting: there is no Setup complete step after it.
    el("nav-next-btn").hidden = settingsMode && index >= STEP_ORDER.length - 2;
    // Boaz, 2026-10-01: on the last step "Next" did not say that Finish Setup comes after it.
    el("nav-next-btn").textContent = !settingsMode && index === STEP_ORDER.length - 2 ? "Next: review and finish" : "Next";
    el("nav-back-btn").textContent = settingsMode ? "Previous" : "Back";
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
  el("enter-research").hidden = true;
  el("step-progress").textContent = step === "finish" ? "" : `Step ${index + 1} of ${STEP_ORDER.length - 1}`;
  if (step === "about") renderAboutResearchBox();
  renderProposalForStep(step);
  if (step === "location") renderLocationPriorityRows();
  if (step === "included") renderIncludedParsedList();
  if (step === "targets") renderTargetsStep();
  if (step === "finish") { renderFinishSummary(); prefillBudgetFromEstimate(); }
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
  el("nav-back-btn").hidden = true;
  el("nav-next-btn").hidden = true;
  let hint = el("change-settings-hint");
  if (!hint) {
    hint = document.createElement("p");
    hint.id = "change-settings-hint";
    hint.textContent = "Choose the setting you want to change from the list above.";
    el("onboarding-main").prepend(hint);
  }
  hint.hidden = false;
}

// Change Settings (Boaz, 2026-10-01): Previous / Next beside Save. Each saves the open setting first - a list of
// settings has no Confirm screen - and does not move on while the setting has an error.
async function saveOpenSettingThenShow(index) {
  const step = STEP_ORDER[currentStepIndex];
  clearStepError(step);
  const { valid, error } = STEP_VALIDATORS[step]();
  if (!valid) {
    showStepError(step, error);
    return;
  }
  await persistStep(step);
  showStep(index);
}

el("nav-back-btn").addEventListener("click", () => {
  if (currentStepIndex <= 0) return;
  if (settingsMode) saveOpenSettingThenShow(currentStepIndex - 1);
  else showStep(currentStepIndex - 1);
});

el("nav-next-btn").addEventListener("click", () => {
  const step = STEP_ORDER[currentStepIndex];
  if (settingsMode) {
    if (currentStepIndex < STEP_ORDER.length - 2) saveOpenSettingThenShow(currentStepIndex + 1);
    return;
  }
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
  if ((step === "value-add-offers" || step === "contacts") && checklists[step]) renderProposalForStep(step);
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
  // maxCompanies is not asked here any more (1.2.0.43): it is set in Settings > Company Discovery (support) and kept.
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
// What each LinkedIn organization type covers - the hover tip on the Industry step (Boaz, 2026-10-01: "International
// Affairs", "Research Services" and "Civic and Social Organizations" are not clear without one).
const ORGANIZATION_TYPE_TIPS = {
  "Non-profit Organizations": "Charities, foundations, NGOs and other organizations that do not work for profit, e.g. aid organizations and environmental foundations.",
  "Government Administration": "Public administrations at every level - federal, cantonal or state, and city - including ministries, offices and public agencies.",
  "International Affairs": "International and intergovernmental organizations and diplomatic bodies, e.g. United Nations agencies and other international organizations.",
  "Higher Education": "Universities, universities of applied sciences, colleges and business schools.",
  "Research Services": "Research institutes and laboratories, publicly funded or private, contract research organizations and think tanks.",
  "Civic and Social Organizations": "Associations and federations - industry and trade associations, professional bodies, chambers, clubs and other member organizations.",
};

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
    if (ORGANIZATION_TYPE_TIPS[industry]) {
      row.title = ORGANIZATION_TYPE_TIPS[industry];
      const tip = document.createElement("span");
      tip.className = "organization-type-tip";
      tip.textContent = "ⓘ";
      tip.setAttribute("aria-label", ORGANIZATION_TYPE_TIPS[industry]);
      name.append(" ", tip);
    }
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

// What the chosen level means for job ads, in one line (1.2.0.46).
const JOBS_MIN_CONFIDENCE_HINTS = {
  very_high: "Only your very best accounts count: few job ads get the automatic cap, the Sales Mentor ranks most of them itself (never better than the ceiling below).",
  high: "Recommended. Strong accounts count; a job ad at a weaker account is still ranked by the Sales Mentor, never better than the ceiling below.",
  medium: "Most accounts count: more job ads get the automatic priority without an AI call - cheaper, but less nuanced.",
  low: "Every rated account counts: nearly every job ad at a Target Account gets the automatic priority.",
};

function renderJobsMinConfidenceHint() {
  el("jobs-min-confidence-hint").textContent = JOBS_MIN_CONFIDENCE_HINTS[el("jobs-min-confidence-select").value] || "";
}

function validateLeadsPrioritizationStep() {
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
  let exactTitles = el("contacts-exact-titles-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  let titleKeywords = el("contacts-title-keywords-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  // Proposed titles and keywords (1.2.1): the box's lines, then the ticked proposals.
  if (checklists.contacts) {
    exactTitles = boxThenTicked(exactTitles, checklists.contacts.titles);
    if (checklists.contacts.keywords) titleKeywords = boxThenTicked(titleKeywords, checklists.contacts.keywords);
  }
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
  // The textareas hold LinkedIn pages only. Entries named by company name or website instead (1.2.1, design
  // 3.9) are not shown there, so they are carried over untouched - and a listed slug keeps any name/domain
  // stored with it.
  const bySlug = new Map(companyExclusions.filter((e) => e.slug).map((e) => [`${e.category}|${e.slug}`, e]));
  let withoutSlug = companyExclusions.filter((e) => !e.slug);
  // The research's proposals (1.2.1): every proposed company is decided by its checkbox - ticked ones are kept by
  // name and website, unticked ones dropped; other name/website entries are carried as before.
  const list = checklists.exclusions;
  if (list) {
    const proposed = new Set((setupResearch.proposals?.exclusions?.items || []).map(exclusionKey));
    const items = list.getItems();
    for (const i of items) if (i.meta) proposed.add(exclusionKey({ category: i.meta.category, name: i.text }));
    withoutSlug = [
      ...withoutSlug.filter((e) => !proposed.has(exclusionKey(e))),
      ...items.filter((i) => i.checked).map((i) => (i.meta
        ? { name: i.text, ...(i.meta.domain ? { domain: i.meta.domain } : {}), category: i.meta.category, source: "research", ...(i.meta.sourceUrl ? { sourceUrl: i.meta.sourceUrl } : {}) }
        : { name: i.text, category: "other", source: "user" })),
    ].filter((e, idx, all) => all.findIndex((x) => exclusionKey(x) === exclusionKey(e)) === idx);
  }
  companyExclusions = [
    ...EXCLUSION_CATEGORY_INPUTS.flatMap(({ category, inputId }) =>
      parseCompetitorLines(el(inputId).value).map((slug) => ({ ...(bySlug.get(`${category}|${slug}`) || {}), slug, category }))
    ),
    ...withoutSlug,
  ];
  return { valid: true };
}

function validateAboutStep() {
  const website = el("about-website-input").value.trim();
  if (website && !websiteDomain(website)) {
    return { valid: false, error: "The website does not look like a web address (for example https://yourcompany.com)." };
  }
  return { valid: true };
}

function validateAliasesStep() {
  companyAliases = parseAliasLines(el("aliases-input").value);
  return { valid: true };
}

// ---- 1.2.1 step 6: Initiative stages, Companies to include, How big is your list (design 3.7, 3.8, 3.10) ----

const STAGE_TIPS = {
  poc: "a first proof of concept is planned or running",
  exploration: "the company is looking into the topic, no project yet",
  pilot: "a pilot with real users",
  early_production: "first use in production",
  scaling: "being rolled out across the company",
  mature: "established, now being improved",
  tech_native: "the technology is the company's own product or core",
};

function renderInitiativeStages() {
  const wrap = el("initiative-stages-list");
  wrap.innerHTML = "";
  initiativeStages.forEach((stage, i) => {
    const row = document.createElement("div");
    row.className = "priority-item-row" + (stage.checked ? "" : " priority-item-unchecked");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = stage.checked;
    box.id = `initiative-stage-${stage.id}`;
    box.addEventListener("change", () => { stage.checked = box.checked; row.classList.toggle("priority-item-unchecked", !box.checked); });
    const name = document.createElement("label");
    name.className = "priority-item-name";
    name.htmlFor = box.id;
    name.textContent = `${i + 1}. ${INITIATIVE_STAGE_LABELS[stage.id]}`;
    const tip = document.createElement("span");
    tip.className = "stage-tip";
    tip.textContent = STAGE_TIPS[stage.id] || "";
    const move = (delta, label, text) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "stage-move-btn";
      b.textContent = text;
      b.title = label;
      b.disabled = i + delta < 0 || i + delta >= initiativeStages.length;
      b.addEventListener("click", () => {
        const [moved] = initiativeStages.splice(i, 1);
        initiativeStages.splice(i + delta, 0, moved);
        renderInitiativeStages();
        scheduleAutoSave();
      });
      return b;
    };
    row.append(box, name, tip, move(-1, "Move up", "↑"), move(1, "Move down", "↓"));
    wrap.appendChild(row);
  });
}

function validateInitiativeStagesStep() {
  if (!initiativeStages.some((s) => s.checked)) return { valid: false, error: "Tick at least one stage." };
  return { valid: true };
}

// "Acme AG, https://www.acme.ch" / "Acme AG" / "https://www.acme.ch" -> { name, website }.
function parseIncludedLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const comma = text.lastIndexOf(",");
  const tail = comma >= 0 ? text.slice(comma + 1).trim() : "";
  if (tail && /\./.test(tail) && !/\s/.test(tail) && websiteDomain(tail)) {
    const name = text.slice(0, comma).trim();
    return { name: name || websiteDomain(tail), website: tail };
  }
  if (!/\s/.test(text) && /^(https?:\/\/|www\.)/i.test(text) && websiteDomain(text)) return { name: websiteDomain(text), website: text };
  return { name: text };
}

function parseIncludedLines(value) {
  const seen = new Set();
  const out = [];
  for (const line of String(value || "").split("\n")) {
    const c = parseIncludedLine(line);
    const key = c && (normalizeCompanyName(c.name) || websiteDomain(c.website || ""));
    if (!c || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Each company as read, flagged when it is also on the exclusion list (the exclusion wins, design 3.8).
function renderIncludedParsedList() {
  const wrap = el("included-parsed-list");
  wrap.innerHTML = "";
  const matcher = buildExclusionMatcher(companyExclusions);
  for (const c of parseIncludedLines(el("included-input").value)) {
    const row = document.createElement("div");
    const excluded = matchesExclusion(matcher, { name: c.name, website: c.website });
    row.className = "included-parsed-row" + (excluded ? " included-conflict" : "");
    row.textContent = `${excluded ? "⚠ " : "✓ "}${c.name}${c.website ? ` - ${websiteDomain(c.website)}` : " (no website)"}` +
      (excluded ? " - also on your exclusion list, so it will not be added" : "");
    wrap.appendChild(row);
  }
}

function validateIncludedStep() {
  includedCompanies = parseIncludedLines(el("included-input").value);
  return { valid: true };
}

// Contacts per account can be at most the Target contacts step's maximum per account.
function contactsTargetMax() {
  const cap = Math.round(Number(targetContactProfile?.maxContactsPerAccount));
  return Math.min(Number.isFinite(cap) && cap >= 1 ? cap : Infinity, TARGET_LIMITS.contactsPerAccount[1]);
}

function validateTargetsStep() {
  const raw = {
    accounts: el("targets-accounts-input").value,
    contactsPerAccount: el("targets-contacts-input").value,
    initiativesPerAccount: el("targets-initiatives-input").value,
  };
  const checks = [
    ["accounts", "Accounts", TARGET_LIMITS.accounts],
    ["contactsPerAccount", "Contacts per account", [TARGET_LIMITS.contactsPerAccount[0], contactsTargetMax()]],
    ["initiativesPerAccount", "Relevant initiatives per account", TARGET_LIMITS.initiativesPerAccount],
  ];
  for (const [key, label, [lo, hi]] of checks) {
    const n = Number(raw[key]);
    if (raw[key] === "" || !Number.isInteger(n) || n < lo || n > hi) return { valid: false, error: `${label} must be a whole number from ${lo} to ${hi}.` };
  }
  completionTargets = normalizeCompletionTargets(raw, targetContactProfile?.maxContactsPerAccount);
  return { valid: true };
}

// The live estimate (R8.1) needs the list as it is now - read once per visit, when it is first wanted.
let estimateBasis = null;
async function loadEstimateBasis() {
  if (!estimateBasis) {
    const [status, measured] = await Promise.all([getTargetsStatus().catch(() => null), getOnboardingMeasures()]);
    estimateBasis = { existing: status ? status.accounts : 0, ready: status ? status.ready : 0, measured };
  }
  return estimateBasis;
}

function currentEstimate(basis) {
  const accounts = Number(el("targets-accounts-input").value) || completionTargets.accounts;
  return onboardingEstimate({ accounts, ...basis });
}

async function renderTargetsStep() {
  const max = contactsTargetMax();
  el("targets-contacts-input").max = String(max);
  el("targets-contacts-hint").textContent = `At most ${max} - your maximum contacts per target account (Target contacts step).`;
  const out = el("targets-estimate");
  if (!estimateBasis) out.textContent = "Working out the estimate…";
  const basis = await loadEstimateBasis();
  out.textContent = currentEstimate(basis).text +
    (basis.existing ? ` Your list has ${basis.existing} account${basis.existing === 1 ? "" : "s"} now, ${basis.ready} of them Ready.` : "");
  // Change Settings (Boaz, 2026-10-01): raising a target does nothing while the automation that builds the list is off.
  if (settingsMode) {
    const a = await getPipelineAutomation();
    const off = !a.enabled ? "Automatic preparation is off" : !a.webEnabled ? "Automatic web research is off" : null;
    if (off) out.textContent += ` ${off} (Settings > Automation), so SalesTeam does not build the list towards these numbers until you turn it on.`;
  }
}

// R8.2: the web budget pre-filled from the estimate, rounded up - never lowered below what is already set.
async function prefillBudgetFromEstimate() {
  const note = el("finish-web-budget-note");
  note.textContent = "";
  if (settingsMode) return;
  const est = currentEstimate(await loadEstimateBasis());
  if (est.usdHigh <= 0) return;
  const input = el("finish-web-budget");
  if ((Number(input.value) || 0) < est.budgetUsd) input.value = String(est.budgetUsd);
  note.textContent = ` Your list of ${est.accounts} accounts needs about US$${Math.round(est.usdLow)}-${Math.ceil(est.usdHigh)} of web research.`;
}

const STEP_VALIDATORS = {
  about: validateAboutStep,
  location: validateLocationStep,
  size: validateSizeStep,
  industry: validateIndustryStep,
  priority: validatePriorityStep,
  "leads-prioritization": validateLeadsPrioritizationStep,
  "company-context": validateAlwaysStep,
  "value-add-offers": validateAlwaysStep,
  icp: validateAlwaysStep,
  contacts: validateContactsStep,
  "initiative-stages": validateInitiativeStagesStep,
  included: validateIncludedStep,
  exclusions: validateExclusionsStep,
  aliases: validateAliasesStep,
  targets: validateTargetsStep,
};

// ---------------------------------------------------------------------
// Per-step persistence (only ever called from the Confirm button).

// When the scoring rules really changed, leave a flag the Leads Dashboard turns into a "Re-score existing leads now?"
// prompt (re-scoring is only ever needed after the rules change, so it is offered here rather than as a menu item).
function currentScoringSignature() {
  return JSON.stringify({
    rules: prioritizationRules.map((r) => [r.id, r.enabled, r.value]),
    jobsMinConfidence: el("jobs-min-confidence-select").value,
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
// the Leads Dashboard, which starts the re-score (its own confirmation still applies). Returns true when it navigated.
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
  await markProposalAccepted(step);
  switch (step) {
    case "about": {
      const profile = await getUserProfile();
      await saveUserProfile({ ...profile, name: el("about-name-input").value.trim() });
      await saveSellerCompanyName(el("about-company-input").value);
      await saveCompanyWebsite(el("about-website-input").value.trim());
      await saveOutputLanguage(el("about-language-select").value);
      const key = sanitizeApiKey(el("about-api-key-input").value || "");
      if (!el("about-api-key-wrap").hidden && key) await saveAnthropicApiKey(key);
      break;
    }
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
      await saveJobRulesMinConfidence(el("jobs-min-confidence-select").value);
      await savePostPrioritizationRules(postPrioritizationRules);
      await flagScoringRulesChangeIfAny();
      break;
    case "company-context":
      await saveCompanyContext(el("company-context-input").value);
      break;
    case "value-add-offers":
      await saveValueAddOffers(currentValueAddOffers());
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
    case "initiative-stages":
      await saveInitiativeStagePreference(initiativeStages);
      break;
    case "included":
      await saveIncludedCompanies(includedCompanies);
      break;
    case "targets":
      await saveCompletionTargets(completionTargets);
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
    case "about": {
      const name = el("about-name-input").value.trim();
      const company = el("about-company-input").value.trim();
      const website = el("about-website-input").value.trim();
      appendPara(container, "You: ", { strong: name || "(no name)" }, company ? ", selling for " : "", company ? { strong: company } : "",
        website ? ` (${website})` : "", ".");
      const language = el("about-language-select");
      appendPara(container, "SalesTeam writes in ", { strong: language.options[language.selectedIndex]?.text || language.value }, ".");
      break;
    }
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
      appendPara(container, "Size ranges: ", { strong: sizeText }, ".");
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
      const level = CONFIDENCE_LEVELS.find((l) => l.id === el("jobs-min-confidence-select").value);
      appendPara(container, "Job ads - minimum Target Account level: ", { strong: level ? level.label : "High" }, ".");
      const disabled = prioritizationRules.filter((r) => !r.enabled);
      if (disabled.length === 0) {
        appendPara(container, `Job ad rules: all ${prioritizationRules.length} enabled.`);
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
      const offers = currentValueAddOffers();
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
          const slugs = companyExclusions.filter((e) => e.category === category).map((e) => e.slug || e.name || e.domain).filter(Boolean);
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
    case "initiative-stages": {
      const ticked = initiativeStages.filter((x) => x.checked).map((x) => INITIATIVE_STAGE_LABELS[x.id]);
      appendPara(container, "Initiative stages, most important first: ", { strong: ticked.join(", ") || "(none)" }, ".");
      break;
    }
    case "included": {
      if (includedCompanies.length) {
        appendPara(container, `${includedCompanies.length} compan${includedCompanies.length === 1 ? "y" : "ies"} to include: `,
          { strong: includedCompanies.map((c) => c.name).join(", ") }, ".");
      } else {
        appendPara(container, "No companies named.");
      }
      break;
    }
    case "targets": {
      const t = completionTargets;
      appendPara(container, "Build the list to ", { strong: `${t.accounts} accounts` }, ", each with ", { strong: `${t.contactsPerAccount} contacts` },
        " and ", { strong: `${t.initiativesPerAccount} relevant initiative${t.initiativesPerAccount === 1 ? "" : "s"}` }, ".");
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
  await setPipelineAutomationEnabled(el("finish-automation-checkbox").checked, "Setup wizard");
  // W4: web research only with automatic preparation on, since it runs inside it.
  const webOn = el("finish-automation-checkbox").checked && el("finish-web-checkbox").checked;
  await setWebResearchAutomation({ enabled: webOn, monthlyUsd: webOn ? Math.max(0, Number(el("finish-web-budget").value) || 0) : undefined }, "Setup wizard");
  await markOnboardingCompleted();
  // Design 3.11 (R3.4.1): Finish starts building the list - Web Discovery, then the web lane; the LinkedIn lane is
  // kicked. The background does it; the wizard never visits LinkedIn.
  if (el("finish-automation-checkbox").checked) chrome.runtime.sendMessage({ type: "ONBOARDING_BUILD_START" }).catch(() => {});
  await warnIfDiscoveryNowStale();
  if (await offerRescoreIfRulesChanged()) return;
  leaveWizard();
});

// ---------------------------------------------------------------------
// Onboarding research (1.2.1, ONBOARDING_RESEARCH_DESIGN.md 3.1-3.6). About you offers one research of the seller's
// website; setup-proposals.js maps its answer onto the wizard's options, and each step that follows shows what it
// proposes. Nothing reaches a setting until the step's own save runs (Next, Save, or the user editing the step).

// A setup completed before (R4.5): proposals sit beside the current setting and are taken only with "Use proposal".
let completedBefore = false;
let setupResearch = { status: "none", proposals: {}, accepted: {} };
// Steps whose proposal was put into the form during this visit - not again when the user comes back with Back.
const appliedThisVisit = new Set();
// The proposal checklists, mounted once per visit and step (re-mounted after Research again or Use proposal).
const checklists = {};
let researchController = null;
let researchSkipRequested = false;

const RESEARCHED_STEPS_TEXT = "Location, Size, Industry, What you sell, Things you can offer, Ideal customer, Target contacts and Companies to exclude";
const RESEARCH_AGAIN_COST_TEXT = "about US$0.10";

const usd = (n) => `US$${(Number(n) || 0).toFixed(2)}`;

function sellerSite() {
  return websiteDomain(el("about-website-input").value) || websiteDomain(setupResearch.seller?.website) || "";
}

function proposalCtx() {
  return {
    countries: ALL_COUNTRIES, sizeBuckets: SIZE_PRIORITY_BUCKETS, industries: CONFIRMED_INDUSTRIES,
    orgTypes: Object.keys(EXCLUDABLE_INDUSTRIES),
    sellerName: el("about-company-input").value.trim(), sellerWebsite: el("about-website-input").value.trim(),
  };
}

function textareaLines(id) {
  return el(id).value.split("\n").map((l) => l.trim()).filter(Boolean);
}

function languageLabel(value) {
  const option = [...el("about-language-select").options].find((o) => o.value === value);
  return option ? option.textContent.replace(/\s*\(.*\)$/, "") : value;
}

function renderAboutResearchBox() {
  const site = sellerSite();
  el("about-research-error").hidden = true;
  if (setupResearch.status === "done") {
    const when = setupResearch.at ? new Date(setupResearch.at).toLocaleDateString() : "";
    el("about-research-text").textContent =
      `Researched ${site || "your company's website"}${when ? ` on ${when}` : ""} for ${usd(setupResearch.costUsd)}. ` +
      "The next steps show what it proposes.";
    el("about-research-btn").textContent = `Research my company again (about ${usd(SELLER_RESEARCH_ESTIMATE_USD)})`;
    return;
  }
  const before = {
    failed: "The last research did not finish. ",
    stopped: "The last research was stopped before its answer was in. ",
  }[setupResearch.status] || "";
  el("about-research-text").textContent =
    `${before}SalesTeam can read ${site || "your company's website"} and propose answers for ${RESEARCHED_STEPS_TEXT}. ` +
    "Or press Next and fill them in yourself.";
  el("about-research-btn").textContent = `Research my company (about ${usd(SELLER_RESEARCH_ESTIMATE_USD)})`;
}

el("about-research-btn").addEventListener("click", async () => {
  const errorEl = el("about-research-error");
  errorEl.hidden = true;
  const fail = (message) => { errorEl.textContent = message; errorEl.hidden = false; };
  const { valid, error } = validateAboutStep();
  if (!valid) return fail(error);
  if (!websiteDomain(el("about-website-input").value)) return fail("Enter your company's website first.");
  await persistStep("about");
  if (!(await getAnthropicApiKey())) return fail("Add your Anthropic API key above first - the research runs on it.");
  el("about-api-key-wrap").hidden = true;
  await runSellerResearch();
});

// 1.2.1 step 7 (design 3.12, R4.6): the once-only offer, also at the top of Change Settings - this page covers the
// Settings cards that carry the same box (1.2.0.36 showed it only there, so it went unseen). Same rule as settings.js:
// a finished setup whose research never ran, and not declined.
function renderSettingsResearchOffer() {
  let box = el("settings-research-offer");
  const show = completedBefore && setupResearch.status === "none" && !setupResearch.declinedInSettings;
  if (!show) {
    if (box) box.hidden = true;
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.id = "settings-research-offer";
    box.className = "wizard-note settings-research-offer";
    const text = document.createElement("p");
    text.innerHTML = "<strong>New:</strong> ";
    text.append("SalesTeam can research your company's website and propose improvements to the setup " +
      `(about ${usd(SELLER_RESEARCH_ESTIMATE_USD)}). The proposals are shown next to the current settings; nothing ` +
      "changes unless you take one.");
    const yes = document.createElement("button");
    yes.type = "button";
    yes.textContent = "Research";
    yes.addEventListener("click", () => {
      box.hidden = true;
      showStep(STEP_ORDER.indexOf("about"));
      el("about-research-btn").click();
    });
    const no = document.createElement("button");
    no.type = "button";
    no.textContent = "No thanks";
    no.addEventListener("click", async () => {
      box.hidden = true;
      setupResearch = { ...setupResearch, declinedInSettings: Date.now() };
      await saveSetupResearch(setupResearch);
      try {
        await appendActivityLog({ actor: "user", action: "setup_research", label: "Declined the setup research offered in Settings" });
      } catch { /* the log is informational */ }
    });
    const row = document.createElement("div");
    row.className = "settings-research-offer-buttons";
    row.append(yes, no);
    box.append(text, row);
    el("wizard-nav-bar").after(box);
  }
  box.hidden = false;
}

// ---- The progress screen (design 3.6) ----

// The research is one AI call that decides itself how many pages to read, so there are no fixed steps to count. The
// screen shows time instead: a bar and "about N seconds left" against the measured duration (45-60 s, design 3.6),
// and what it has read so far. Past that time it says it is still working, and that it ends by itself at 4 minutes.
const SELLER_RESEARCH_EXPECTED_MS = 60000;
const SELLER_RESEARCH_CUTOFF_MS = 4 * 60000;
let researchProgressTimer = null;
let researchStartedAt = 0;
let researchPagesRead = 0;
let researchSearches = 0;

function renderResearchProgress() {
  const elapsed = Date.now() - researchStartedAt;
  const fraction = Math.min(elapsed / SELLER_RESEARCH_EXPECTED_MS, 1);
  // Up to 90% on the expected time, then creeping towards 99% - the bar never fills before the answer is in.
  const pct = fraction < 1 ? fraction * 90 : 90 + 9 * Math.min((elapsed - SELLER_RESEARCH_EXPECTED_MS) / (SELLER_RESEARCH_CUTOFF_MS - SELLER_RESEARCH_EXPECTED_MS), 1);
  el("research-progress-fill").style.width = `${pct.toFixed(1)}%`;
  const left = Math.ceil((SELLER_RESEARCH_EXPECTED_MS - elapsed) / 1000);
  const read = [
    researchPagesRead ? `${researchPagesRead} page${researchPagesRead === 1 ? "" : "s"} read` : "",
    researchSearches ? `${researchSearches} search${researchSearches === 1 ? "" : "es"}` : "",
  ].filter(Boolean).join(", ");
  const timeText = left > 5
    ? `About ${left} seconds left`
    : "Taking a little longer than usual - still working; the steps open by themselves when the answer is in";
  el("research-eta").textContent = `${timeText}${read ? ` · ${read} so far` : ""}`;
}

function startResearchProgress() {
  researchStartedAt = Date.now();
  researchPagesRead = 0;
  researchSearches = 0;
  el("research-progress").hidden = false;
  clearInterval(researchProgressTimer);
  renderResearchProgress();
  researchProgressTimer = setInterval(renderResearchProgress, 1000);
}

function stopResearchProgress() {
  clearInterval(researchProgressTimer);
  researchProgressTimer = null;
  el("research-progress").hidden = true;
}

function showResearchScreen(seller) {
  for (const s of STEP_ORDER) {
    const sectionEl = el(`enter-${s}`);
    if (sectionEl) sectionEl.hidden = true;
  }
  el("confirm-view").hidden = true;
  el("wizard-nav-bar").hidden = true;
  el("step-progress").textContent = "";
  el("enter-research").hidden = false;
  el("research-intro").textContent =
    `SalesTeam is reading ${sourceLabel(seller.website)} to propose answers for the next steps. This usually takes about ` +
    "a minute; please wait - the setup goes on by itself when the answer is in.";
  el("research-lines").innerHTML = "";
  el("research-cost").textContent = "";
  el("research-error").hidden = true;
  addResearchLine(null, "Starting the research…");
  setResearchButtons(true);
  startResearchProgress();
}

function setResearchButtons(running) {
  el("research-stop-btn").hidden = !running;
  el("research-skip-btn").hidden = !running;
  el("research-retry-btn").hidden = running;
  el("research-continue-btn").hidden = running;
}

function addResearchLine(toolName, input) {
  let text;
  if (toolName === "web_fetch") { text = `Reading ${sourceLabel(input?.url || "a page")}…`; researchPagesRead++; }
  else if (toolName === "web_search") { text = `Searching: ${input?.query || "…"}`; researchSearches++; }
  else text = String(input || "");
  if (!text) return;
  const li = document.createElement("li");
  li.textContent = text;
  el("research-lines").append(li);
}

function showResearchEnded(message) {
  el("research-error").textContent = message;
  el("research-error").hidden = false;
  setResearchButtons(false);
}

function continueAfterResearch() {
  el("enter-research").hidden = true;
  showStep(STEP_ORDER.indexOf("location"));
}

async function logSetupResearch(label) {
  try {
    await appendActivityLog({ actor: "user", action: "setup_research", label });
  } catch { /* the log is for measuring only */ }
}

function researchMeasures(result) {
  return `${usd(result.costUsd)}, ${Math.round((result.ms || 0) / 1000)} s, ${result.fetches || 0} pages read, ` +
    `${result.searches || 0} searches`;
}

async function runSellerResearch() {
  const seller = { name: el("about-company-input").value.trim(), website: el("about-website-input").value.trim() };
  showResearchScreen(seller);
  researchSkipRequested = false;
  researchController = new AbortController();
  const startedAt = Date.now();
  setupResearch = { ...setupResearch, status: "running", at: startedAt, heartbeatAt: startedAt, seller, error: null };
  await saveSetupResearch(setupResearch);
  // A heartbeat, so a page closed mid-research is recognised as interrupted when the wizard opens again (init).
  const heartbeat = setInterval(() => {
    setupResearch.heartbeatAt = Date.now();
    saveSetupResearch(setupResearch).catch(() => {});
  }, 15000);
  let result = null;
  let failure = null;
  try {
    result = await researchSeller(
      seller,
      { sectors: CONFIRMED_INDUSTRIES, outputLanguage: el("about-language-select").value },
      { apiKey: await getAnthropicApiKey() },
      {
        signal: researchController.signal,
        onTool: addResearchLine,
        onCost: (cost) => { el("research-cost").textContent = `Cost so far: about ${usd(cost)}`; },
      },
    );
  } catch (err) {
    failure = err;
  } finally {
    clearInterval(heartbeat);
    researchController = null;
    stopResearchProgress();
  }
  const site = sourceLabel(seller.website);

  if (result && result.data) {
    const proposals = buildSetupProposals(result.data, proposalCtx());
    setupResearch = {
      status: "done", at: startedAt, costUsd: result.costUsd, model: result.model, ms: result.ms,
      searches: result.searches, fetches: result.fetches, seller, raw: result.data, briefing: result.briefing,
      proposals, accepted: {},
    };
    await saveSetupResearch(setupResearch);
    appliedThisVisit.clear();
    for (const key of Object.keys(checklists)) delete checklists[key];
    const found = Object.entries(proposals).filter(([, p]) => p.found).map(([step]) => STEP_TITLES[step]);
    await logSetupResearch(`Setup research of ${site}: ${researchMeasures(result)}; proposals for ${found.length} steps` +
      `${found.length ? ` (${found.join(", ")})` : ""}`);
    continueAfterResearch();
    return;
  }

  if (researchSkipRequested) {
    setupResearch = { ...setupResearch, status: "skipped" };
    await saveSetupResearch(setupResearch);
    if (result) await logSetupResearch(`Setup research of ${site} skipped: ${researchMeasures(result)}`);
    continueAfterResearch();
    return;
  }

  let message;
  let status = "failed";
  if (failure) message = `The research could not be done: ${failure.message || failure}`;
  else if (result.stopped === "user") { status = "stopped"; message = "Stopped before the answer was in, so there is nothing to propose."; }
  else if (result.stopped === "timeout") message = "The research was cut off after 4 minutes, before its answer was in.";
  else message = "The research did not return a usable answer.";
  setupResearch = { ...setupResearch, status, error: message };
  await saveSetupResearch(setupResearch);
  if (result) await logSetupResearch(`Setup research of ${site} ended without an answer (${status}): ${researchMeasures(result)}`);
  showResearchEnded(`${message} Try again, or continue and fill in the steps yourself.`);
}

el("research-stop-btn").addEventListener("click", () => { researchController?.abort(); });
el("research-skip-btn").addEventListener("click", () => {
  researchSkipRequested = true;
  researchController?.abort();
});
el("research-retry-btn").addEventListener("click", () => { runSellerResearch(); });
el("research-continue-btn").addEventListener("click", continueAfterResearch);

// ---- Proposals on the steps (design 3.5) ----

function setRowTicks(wrapId, keys) {
  for (const row of el(wrapId).querySelectorAll(".priority-item-row")) {
    const checked = keys.has(row.dataset.key);
    row.querySelector('input[type="checkbox"]').checked = checked;
    const select = row.querySelector(".priority-item-select");
    if (select) select.disabled = !checked;
    row.classList.toggle("priority-item-unchecked", !checked);
  }
}

// Puts a step's proposal into the form. On a first setup this happens when the step opens; on a setup completed
// before, only with "Use proposal" (tickAll: the proposal's list items are ticked too).
function applyProposal(step, p, { tickAll = false } = {}) {
  switch (step) {
    case "about":
      if (p.outputLanguage) el("about-language-select").value = p.outputLanguage;
      break;
    case "location":
      if (!p.value.length) break;
      locationPicker.setValue({ mode: "country", continents: [], countries: p.value });
      renderLocationModeVisibility();
      refreshLocationPriorityRows();
      break;
    case "size":
      if (p.value.length) setRowTicks("size-buckets-wrap", new Set(p.value));
      break;
    case "industry":
      if (p.value.length) setRowTicks("industry-checkbox-wrap", new Set(p.value));
      for (const type of p.orgTypes || []) {
        const radio = [...el("organization-type-wrap").querySelectorAll("input[type=radio]")].find((r) => r.name === type && r.value === "yes");
        if (radio) radio.checked = true;
      }
      break;
    case "company-context":
      if (p.value) el("company-context-input").value = p.value;
      break;
    case "icp":
      if (p.value) el("icp-input").value = p.value;
      break;
    case "contacts":
      if (p.seniority?.length) setRowTicks("seniority-checkbox-wrap", new Set(p.seniority));
      break;
  }
  if (tickAll) {
    const c = checklists[step];
    for (const list of c && c.getItems ? [c] : Object.values(c || {})) list?.setAllChecked(true);
  }
}

function proposalNotes(step, p) {
  if (!p) return [];
  const notes = [];
  const proposalLine = (text) => { if (completedBefore && text) notes.push(`Proposal: ${text}`); };
  switch (step) {
    case "about":
      notes.push(`The website is in ${languageLabel(p.outputLanguage)}. SalesTeam can write in ${languageLabel(p.outputLanguage)} too.`);
      break;
    case "location":
      proposalLine(p.value.join(", "));
      if (p.websiteCountry) notes.push(`${sellerSite() || "The website"} is a website of ${p.websiteCountry}, so ${p.websiteCountry} comes first.`);
      if (p.group?.length) notes.push(`Countries where only the group works, not ticked: ${p.group.join(", ")}. Add any of them yourself if you sell there too.`);
      if (p.dropped?.length) notes.push(`Also named, but not a country in the list here: ${p.dropped.join(", ")}.`);
      break;
    case "size":
      proposalLine(p.value.map((k) => SIZE_PRIORITY_BUCKETS.find((b) => b.key === k)?.label || k).join(", "));
      if (p.texts?.length) notes.push(`The website says: ${p.texts.join("; ")}.`);
      break;
    case "industry":
      proposalLine(p.value.join(", "));
      if (p.unmapped?.length) {
        notes.push(`Named on the website but not in the list here (added to the Ideal customer text instead): ${p.unmapped.join(", ")}.`);
      }
      if (p.orgTypes?.length) notes.push(`Also sells to: ${p.orgTypes.join(", ")} - set to Yes below.`);
      break;
    case "company-context":
    case "icp":
      proposalLine(p.value);
      break;
    case "value-add-offers":
      notes.push("These can go into a message to a lead as a small give-away - a report, an eBook, a webinar - that gives them a reason to reply. " +
        (completedBefore || setupResearch.accepted?.[step]
          ? "Tick the ones the AI may offer when it drafts a message."
          : "They are in the list below: remove any the AI should not offer when it drafts a message."));
      if (p.dropped) {
        notes.push(`${p.dropped} more found without a page of their own on ${sellerSite() || "the website"} - left out, since the AI may only offer what has a real page.`);
      }
      break;
    case "exclusions":
      // Boaz, 2026-10-01: say what excluding does.
      notes.push("An excluded company never shows up in your Target Accounts and is never scanned for leads: its people are " +
        "not searched, and a post from it that a keyword scan finds is marked Irrelevant.");
      if (p.items?.length) notes.push("Matched by name and website - no LinkedIn page is needed for these.");
      break;
  }
  return notes;
}

const exclusionKey = (e) => `${e.category}|${normalizeCompanyName(e.name || "")}`;

function mountStepChecklists(step, p, accepted) {
  if (!p || !p.found || checklists[step]) return;
  // R4.5: on a setup completed before, or once this step was accepted, the ticks show what is saved.
  const ticks = (keys, saved) => initiallyTicked(keys, saved, completedBefore || accepted);
  if (step === "value-add-offers") {
    // The box below the checklist is the list of offers (Boaz, 2026-10-01: ticking and saving should move an item
    // there). The checklist shows only proposals not in it yet - ticked on a first setup until the step is accepted.
    const lines = textareaLines("value-add-offers-input");
    const texts = p.items.map(offerLine);
    // 1.2.0.30 (Boaz): on a first setup the offers go straight into the box, like Target contacts (1.2.0.29).
    if (!completedBefore && !accepted) {
      el("value-add-offers-input").value = mergeChecklistWithLines([], [...lines, ...texts]).join("\n");
      el("value-add-offers-checklist").hidden = true;
      checklists[step] = null;
      return;
    }
    const inBox = initiallyTicked(texts, lines, true);
    const open = p.items.map((item, i) => ({ text: texts[i], sourceUrl: item.url })).filter((_, i) => !inBox[i]);
    const tickNew = !completedBefore && !accepted;
    checklists[step] = mountChecklist(el("value-add-offers-checklist"),
      open.map((item) => ({ ...item, checked: tickNew })),
      {
        title: open.length
          ? "Found on the website - tick the ones the AI may offer, then Save: they move to the list below"
          : "Every offer found on the website is in the list below.",
        addPlaceholder: "Add another offer", onChange: scheduleAutoSave,
      });
  } else if (step === "contacts") {
    // Same as offers (Boaz, 2026-10-01): the two boxes are the lists, ticked proposals move into them on Save.
    const tickNew = !completedBefore && !accepted;
    // 1.2.0.29 (Boaz): on a first setup a list of ticked titles above an empty box read as "nothing proposed" - the
    // proposals go straight into the boxes, like every other step's proposal. The tick lists stay for a setup
    // completed before, where a proposal must not replace what is saved.
    if (tickNew) {
      el("contacts-exact-titles-input").value = mergeChecklistWithLines([], [...textareaLines("contacts-exact-titles-input"), ...p.exactTitles]).join("\n");
      el("contacts-title-keywords-input").value = mergeChecklistWithLines([], [...textareaLines("contacts-title-keywords-input"), ...p.keywords]).join("\n");
      el("contacts-titles-checklist").hidden = true;
      el("contacts-keywords-checklist").hidden = true;
      checklists[step] = { titles: null, keywords: null };
      return;
    }
    const open = (keys, lines) => {
      const inBox = initiallyTicked(keys, lines, true);
      return keys.filter((_, i) => !inBox[i]).map((text) => ({ text, checked: tickNew }));
    };
    const titles = open(p.exactTitles, textareaLines("contacts-exact-titles-input"));
    const keywords = open(p.keywords, textareaLines("contacts-title-keywords-input"));
    checklists[step] = {
      titles: mountChecklist(el("contacts-titles-checklist"), titles, {
        title: titles.length ? "Proposed exact titles - tick the ones to search for, then Save: they move to the box below" : "Every proposed title is in the box below.",
        addPlaceholder: "Add a title", onChange: scheduleAutoSave,
      }),
      keywords: p.keywords.length
        ? mountChecklist(el("contacts-keywords-checklist"), keywords, {
          title: keywords.length ? "Proposed title keywords - tick, then Save: they move to the box below" : "Every proposed keyword is in the box below.",
          addPlaceholder: "Add a keyword", onChange: scheduleAutoSave,
        })
        : null,
    };
  } else if (step === "exclusions") {
    const keys = p.items.map(exclusionKey);
    const t = ticks(keys, companyExclusions.filter((e) => !e.slug).map(exclusionKey));
    checklists[step] = mountChecklist(el("exclusions-checklist"),
      p.items.map((item, i) => ({
        text: item.name, checked: t[i], sourceUrl: item.sourceUrl, meta: item,
        label: `${EXCLUSION_CATEGORY_LABELS[item.category] || item.category}${item.domain ? ` · ${item.domain}` : ""}`,
      })),
      { title: "Found by the research - tick the ones to exclude", addPlaceholder: "Add a company by name (excluded as Other)", onChange: scheduleAutoSave });
  }
}

function renderProposalForStep(step) {
  const slot = el(`proposal-${step}`);
  if (!slot) return;
  let p = setupResearch.proposals?.[step];
  // About you shows a proposal only when it would change something: the website's language.
  if (step === "about" && !(p && p.found && p.outputLanguage !== el("about-language-select").value)) p = undefined;
  const accepted = !!setupResearch.accepted?.[step];
  if (p && p.found && step !== "about" && !completedBefore && !accepted && !appliedThisVisit.has(step)) applyProposal(step, p);
  foldProposalsIntoBoxes(step);
  if (p) appliedThisVisit.add(step);
  mountStepChecklists(step, p, accepted);
  renderProposalBanner(slot, {
    proposal: p, site: sellerSite(), completedBefore: completedBefore || step === "about", accepted,
    notes: proposalNotes(step, p),
    onUse: p && p.found
      ? () => {
        applyProposal(step, p, { tickAll: true });
        scheduleAutoSave();
        if (step === "about") {
          // The language now matches, so About you's proposal box goes away - leave a line saying what happened.
          renderProposalForStep(step);
          slot.hidden = false;
          slot.innerHTML = "";
          const done = document.createElement("p");
          done.className = "proposal-used-status";
          done.textContent = `${languageLabel(p.outputLanguage)} is now your output language and saved - no need to press Save.`;
          slot.append(done);
        }
      }
      : null,
    useLabel: step === "about" && p ? `Use ${languageLabel(p.outputLanguage)}` : "Use proposal",
    onResearchAgain: step === "about" ? null : (hint) => researchStepAgain(step, hint),
    againCostText: RESEARCH_AGAIN_COST_TEXT,
  });
}

// R4.4: re-runs only this step's part of the research, with the user's hint. The step's proposal is replaced; on a
// first setup it is put into the form again.
async function researchStepAgain(step, hint) {
  const apiKey = await getAnthropicApiKey();
  if (!apiKey) throw new Error("add your Anthropic API key on the first step (About you) first");
  const seller = { name: el("about-company-input").value.trim(), website: el("about-website-input").value.trim() };
  if (!websiteDomain(seller.website)) throw new Error("enter your company's website on the first step (About you) first");
  const result = await researchSeller(seller, {
    only: PROPOSAL_STEP_KEYS[step], hint, sectors: CONFIRMED_INDUSTRIES, outputLanguage: el("about-language-select").value,
  }, { apiKey });
  await logSetupResearch(`Setup research again (${STEP_TITLES[step]}${hint ? `, hint "${hint.slice(0, 80)}"` : ""}): ${researchMeasures(result)}`);
  if (!result.data) throw new Error(result.stopped === "timeout" ? "it was cut off after 4 minutes" : "no usable answer came back");
  const raw = { ...(setupResearch.raw || {}), ...result.data };
  const rebuilt = buildSetupProposals(raw, proposalCtx(), stepsRebuiltBy(step));
  const accepted = { ...(setupResearch.accepted || {}) };
  // Only this step is proposed afresh; another step rebuilt with it (the Ideal customer note) keeps its acceptance.
  delete accepted[step];
  appliedThisVisit.delete(step);
  delete checklists[step];
  setupResearch = {
    ...setupResearch, status: setupResearch.status === "done" ? "done" : setupResearch.status, raw,
    proposals: { ...(setupResearch.proposals || {}), ...rebuilt }, accepted,
    costUsd: (setupResearch.costUsd || 0) + (result.costUsd || 0),
  };
  await saveSetupResearch(setupResearch);
  renderProposalForStep(step);
}

async function markProposalAccepted(step) {
  if (!setupResearch.proposals?.[step] || setupResearch.accepted?.[step]) return;
  setupResearch = { ...setupResearch, accepted: { ...(setupResearch.accepted || {}), [step]: Date.now() } };
  await saveSetupResearch(setupResearch);
}

// A box's lines first, then the ticked proposals of its checklist, de-duplicated.
function boxThenTicked(lines, list) {
  if (!list) return lines;
  return mergeChecklistWithLines([], [...lines, ...list.getItems().filter((i) => i.checked).map((i) => i.text)]);
}

function currentValueAddOffers() {
  return boxThenTicked(textareaLines("value-add-offers-input"), checklists["value-add-offers"]);
}

// Offers, titles and keywords: moves the ticked proposals into the box below; the checklists are mounted again with
// what is left.
function foldProposalsIntoBoxes(step) {
  const c = checklists[step];
  if (!c) return;
  if (step === "value-add-offers") {
    el("value-add-offers-input").value = currentValueAddOffers().join("\n");
  } else if (step === "contacts") {
    el("contacts-exact-titles-input").value = boxThenTicked(textareaLines("contacts-exact-titles-input"), c.titles).join("\n");
    el("contacts-title-keywords-input").value = boxThenTicked(textareaLines("contacts-title-keywords-input"), c.keywords).join("\n");
  } else {
    return;
  }
  delete checklists[step];
}

// ---------------------------------------------------------------------

async function init() {
  el("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
  el("finish-automation-title").textContent = CONSENT_TITLE;
  el("finish-automation-text").textContent = CONSENT_TEXT;
  const automation = await getPipelineAutomation();
  el("finish-automation-checkbox").checked = automation.enabled;
  el("finish-web-title").textContent = WEB_CONSENT_TITLE;
  el("finish-web-text").textContent = WEB_CONSENT_TEXT;
  el("finish-web-checkbox").checked = automation.webEnabled;
  el("finish-web-budget").value = String(automation.webMonthlyUsd > 0 ? automation.webMonthlyUsd : DEFAULT_WEB_BUDGET_USD);
  const syncWebBox = () => {
    const on = el("finish-automation-checkbox").checked;
    el("finish-web-checkbox").disabled = !on;
    el("finish-web-budget").disabled = !on || !el("finish-web-checkbox").checked;
  };
  el("finish-automation-checkbox").addEventListener("change", syncWebBox);
  el("finish-web-checkbox").addEventListener("change", syncWebBox);
  syncWebBox();
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
  el("jobs-min-confidence-select").value = await getJobRulesMinConfidence();
  renderJobsMinConfidenceHint();
  el("jobs-min-confidence-select").addEventListener("change", () => { renderJobsMinConfidenceHint(); scheduleAutoSave(); });
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
  el("about-name-input").value = (await getUserProfile()).name || "";
  el("about-company-input").value = await getSellerCompanyName();
  el("about-website-input").value = await getCompanyWebsite();
  el("about-language-select").value = await getOutputLanguage();
  el("about-api-key-wrap").hidden = !!(await getAnthropicApiKey());
  completedBefore = !!(await getOnboardingCompletedAt());
  setupResearch = await getSetupResearch();
  if (setupResearch.status === "running" && Date.now() - (setupResearch.heartbeatAt || setupResearch.at || 0) > 60000) {
    // The page was closed or reloaded while the research ran: nothing came in.
    setupResearch = { ...setupResearch, status: "failed", error: "The research was interrupted (the page was closed or reloaded)." };
    await saveSetupResearch(setupResearch);
  }
  // 1.2.0.27: offers on a sibling domain of the same brand now count - a research stored before is mapped again from
  // its saved answer (local, free), so its dropped offers come back without a new research.
  if (setupResearch.raw && setupResearch.proposals?.["value-add-offers"] && !setupResearch.proposals["value-add-offers"].found) {
    const again = buildSetupProposals(setupResearch.raw, proposalCtx(), ["value-add-offers"])["value-add-offers"];
    if (again && again.found) {
      setupResearch = { ...setupResearch, proposals: { ...setupResearch.proposals, "value-add-offers": again } };
      await saveSetupResearch(setupResearch);
    }
  }
  // 1.2.0.29: titles with a translation in brackets are mapped again without it (local, free).
  if (setupResearch.raw && (setupResearch.proposals?.contacts?.exactTitles || []).some((t) => /[([]/.test(t))) {
    const again = buildSetupProposals(setupResearch.raw, proposalCtx(), ["contacts"]).contacts;
    if (again) {
      setupResearch = { ...setupResearch, proposals: { ...setupResearch.proposals, contacts: again } };
      await saveSetupResearch(setupResearch);
    }
  }
  el("value-add-offers-input").value = (await getValueAddOffers()).join("\n");
  el("icp-input").value = await getIdealCustomerProfile();
  el("contacts-exact-titles-input").value = targetContactProfile.exactTitles.join("\n");
  el("contacts-title-keywords-input").value = targetContactProfile.titleKeywords.join("\n");
  el("contacts-max-per-account-input").value = targetContactProfile.maxContactsPerAccount ?? 10;
  renderSeniorityLevelPriorityRows(targetContactProfile.seniorityLevels || []);
  for (const { category, inputId, listId } of EXCLUSION_CATEGORY_INPUTS) {
    const slugs = companyExclusions.filter((e) => e.category === category && e.slug).map((e) => e.slug);
    el(inputId).value = slugs.map((slug) => `https://www.linkedin.com/company/${slug}/`).join("\n");
    renderExclusionParsedList(inputId, listId);
  }
  companyAliases = await getCompanyAliases();
  el("aliases-input").value = companyAliases
    .map((a) => `https://www.linkedin.com/company/${a.aliasSlug}/ -> https://www.linkedin.com/company/${a.canonicalSlug}/`)
    .join("\n");
  renderAliasesParsedList();
  initiativeStages = await getInitiativeStagePreference();
  renderInitiativeStages();
  includedCompanies = await getIncludedCompanies();
  el("included-input").value = includedCompanies.map((c) => (c.website ? `${c.name}, ${c.website}` : c.name)).join("\n");
  el("included-input").addEventListener("input", renderIncludedParsedList);
  completionTargets = await getCompletionTargets();
  el("targets-accounts-input").value = completionTargets.accounts;
  el("targets-contacts-input").value = completionTargets.contactsPerAccount;
  el("targets-initiatives-input").value = completionTargets.initiativesPerAccount;
  for (const id of ["targets-accounts-input", "targets-contacts-input", "targets-initiatives-input"]) {
    el(id).addEventListener("input", () => { if (estimateBasis) renderTargetsStep(); });
  }

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
    const askedStep = new URLSearchParams(location.search).get("step");
    if (askedStep && STEP_TITLES[askedStep]) showStep(STEP_ORDER.indexOf(askedStep));
    else showSettingsHome();
    renderSettingsResearchOffer();
    // Settings' once-only offer (design 3.12): About you opens with the research started. The button's own checks
    // apply - with no company website or API key it says what is missing instead.
    if (askedStep === "about" && new URLSearchParams(location.search).get("research") === "1") el("about-research-btn").click();
    return;
  }
  const savedStepIndex = await getOnboardingProgressStepIndex();
  furthestStepIndex = 0;
  // About you came with 1.2.1: a setup saved before it never saw the step, so it opens there first.
  const aboutNeverFilled = !el("about-company-input").value.trim() && !el("about-website-input").value.trim()
    && setupResearch.status === "none";
  showStep(aboutNeverFilled ? 0 : Math.min(Math.max(savedStepIndex, 0), STEP_ORDER.length - 1));
}

// The page stays hidden until init() has chosen what to show, so the default first step never flashes on screen
// (reported 2026-09-21: Change Settings briefly showed a setup step before its own list).
init().finally(() => document.documentElement.classList.add("wizard-ready"));

// Inside the Settings page the menu is already on the left, so this page's own "SalesTeam menu" button is not needed.
if (window.top !== window) document.documentElement.classList.add("in-settings-shell");

// On a fresh install (right after a reinstall) this page offers "restore from a backup"; see backup-restore.js.
startAutoBackup();
