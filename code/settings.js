// Settings tab: form-bound persistence (via storage.js) for the Anthropic API
// key and the AI output language. "What We Offer"/"Ideal Customer Profile"/
// "Things you can offer", Location Filter, and Prioritization Rules all
// moved into the onboarding wizard (2026-09-16 - the wizard's Location step
// is now the one setting driving both Discovery's company search and lead
// filtering, and Prioritization Rules is now its own "Leads Prioritization"
// wizard step) - see onboarding.js for all of these. "Message templates"
// moved into dashboard.js's lead-detail view instead (2026-09-16, next to
// the template-select dropdown that already used them). Target Accounts
// (import/export, confidence threshold, Resolve LinkedIn Company IDs) moved
// to target-accounts.js instead (2026-09-16, reported directly: it belongs
// next to the data it actually affects, not on a separate settings page).
import { getApiUsage, sumDays, clearApiUsage, localDayKey, getCostWarningUsd, saveCostWarningUsd } from "./api-usage.js";
import { askConfirm } from "./confirm-dialog.js";
import { initBatchStatus } from "./batch-status.js";
import { watchPipelineStatusLine, kickPipelineFromPage, kickAndExplain } from "./pipeline-status.js";
import {
  getPipelineAutomation, setPipelineAutomationEnabled, setPipelinePausedDay, CONSENT_TITLE, CONSENT_TEXT, PIPELINE_AUTOMATION_KEY,
} from "./pipeline-automation.js";
import { localDay } from "./pipeline-plan.js";
import {
  getAnthropicApiKey,
  saveAnthropicApiKey,
  getOutputLanguage,
  saveOutputLanguage,
  appendActivityLog,
  getOnboardingCompletedAt,
  getOnboardingProgressStepIndex,
  getUserProfile,
  saveUserProfile,
  getTargetUniverseConfig,
  getTargetContactProfile,
  clearCompanyLocationSizeCache,
  getDiscoveredCompanies,
  getDiscoveredContacts,
  clearDiscoveredContacts,
  getTargetAccountsWorkbook,
  getTargetAccounts,
  normalizeCompanyName,
  exportSettings,
  exportLeads,
  importSettings,
  importLeads,
  getWebFindingsArbitration,
  saveWebFindingsArbitration,
  getRevenueNormalization,
  saveRevenueNormalization,
} from "./storage.js";
import { RULES as ARBITRATION_RULES, DEFAULT_ARBITRATION_SETTINGS } from "./web-findings-arbitration.js";
import { SUPPORTED_CURRENCIES, DEFAULT_EXCHANGE_RATES } from "./value-normalize.js";
import { chooseRestoreSections, extractBackupPart, startAutoBackup } from "./backup-restore.js";
import { sanitizeApiKey } from "./agent-shared.js";
import {
  getDiscoveryQueueState,
  startDiscoveryQueue,
  resumeDiscoveryQueue,
  checkpointCompanyPhase,
  checkpointContactPhase,
  advanceToContactPhase,
  completeDiscoveryQueue,
  resetDiscoveryQueue,
} from "./discovery-queue.js";
import { runCompanyDiscoveryPhase } from "./company-discovery-extraction.js";
import { runContactDiscoveryPhase } from "./contact-discovery-extraction.js";
import { getLinkedinTouchStats, formatTouchRelease } from "./linkedin-touch-log.js";

// Logs one activity-log entry per real edit (focus -> blur, value actually
// changed), not per keystroke - the field's own existing "input" listener
// keeps saving live as before; this only adds logging on top. Same pattern
// as sidepanel.js's logOnBlur.
function logOnBlur(el, { action, labelFor }) {
  let valueAtFocus = el.value;
  el.addEventListener("focus", () => { valueAtFocus = el.value; });
  el.addEventListener("blur", () => {
    if (el.value !== valueAtFocus) {
      appendActivityLog({ actor: "user", action, label: labelFor(valueAtFocus, el.value), prevValue: valueAtFocus, newValue: el.value });
    }
  });
}

// Reported directly: auto-save "feels weird, unsure if it saved" - this
// page still auto-saves on every change (safer than requiring an explicit
// Save everywhere, which would risk losing an edit if the user navigates
// away), but every save now flashes this one persistent, page-wide
// indicator so there's always visible confirmation it actually happened.
const saveStatusEl = document.getElementById("settings-save-status");
let saveStatusTimeout = null;
function flashSaved() {
  saveStatusEl.textContent = "Saved";
  saveStatusEl.classList.add("flash");
  clearTimeout(saveStatusTimeout);
  saveStatusTimeout = setTimeout(() => {
    saveStatusEl.textContent = "All changes saved";
    saveStatusEl.classList.remove("flash");
  }, 1500);
}

let currentUserProfile = { name: "", title: "", email: "" };

const editSetupBtn = document.getElementById("edit-setup-btn");
const editSetupStatusEl = document.getElementById("edit-setup-status");
const outputLanguageSelect = document.getElementById("output-language-select");
const anthropicApiKeyInput = document.getElementById("anthropic-api-key-input");
const profileNameInput = document.getElementById("profile-name-input");
const profileTitleInput = document.getElementById("profile-title-input");
const profileEmailInput = document.getElementById("profile-email-input");

outputLanguageSelect.addEventListener("change", () => {
  const prevValue = outputLanguageSelect.dataset.prevValue || null;
  saveOutputLanguage(outputLanguageSelect.value);
  flashSaved();
  appendActivityLog({ actor: "user", action: "output_language_changed", label: `Output language changed to "${outputLanguageSelect.value}"`, prevValue, newValue: outputLanguageSelect.value });
  outputLanguageSelect.dataset.prevValue = outputLanguageSelect.value;
});

// The API key is edited as a draft: nothing is stored until Save is pressed, and Cancel puts the stored key back
// (reported 2026-09-21: it used to save silently on every keystroke, with no Save or Cancel).
const apiKeySaveBtn = document.getElementById("api-key-save-btn");
const apiKeyCancelBtn = document.getElementById("api-key-cancel-btn");
const apiKeyStatusEl = document.getElementById("api-key-status");
let storedApiKey = "";

function refreshApiKeyButtons() {
  const dirty = sanitizeApiKey(anthropicApiKeyInput.value) !== storedApiKey;
  apiKeySaveBtn.disabled = !dirty;
  apiKeyCancelBtn.disabled = !dirty;
  if (dirty) apiKeyStatusEl.textContent = "Unsaved changes";
  else if (apiKeyStatusEl.textContent === "Unsaved changes") apiKeyStatusEl.textContent = "";
}
anthropicApiKeyInput.addEventListener("input", refreshApiKeyButtons);
apiKeySaveBtn.addEventListener("click", async () => {
  const value = sanitizeApiKey(anthropicApiKeyInput.value);
  await saveAnthropicApiKey(value);
  storedApiKey = value;
  // Deliberately never logs the actual key value - only that it changed.
  appendActivityLog({ actor: "user", action: "api_key_changed", label: value ? "Anthropic API key changed" : "Anthropic API key removed" });
  refreshApiKeyButtons();
  apiKeyStatusEl.textContent = "Saved ✓";
  setTimeout(() => { if (apiKeyStatusEl.textContent === "Saved ✓") apiKeyStatusEl.textContent = ""; }, 2500);
});
apiKeyCancelBtn.addEventListener("click", () => {
  anthropicApiKeyInput.value = storedApiKey;
  refreshApiKeyButtons();
});

// User Profile (2026-09-18, user's own request) - name/title/email saved
// together as one object rather than 3 separate storage keys, same shape
// storage.js's getUserProfile/saveUserProfile already use.
function saveProfileField(field, value) {
  currentUserProfile = { ...currentUserProfile, [field]: value };
  saveUserProfile(currentUserProfile);
  flashSaved();
}
profileNameInput.addEventListener("input", () => saveProfileField("name", profileNameInput.value));
profileTitleInput.addEventListener("input", () => saveProfileField("title", profileTitleInput.value));
profileEmailInput.addEventListener("input", () => saveProfileField("email", profileEmailInput.value));
logOnBlur(profileNameInput, { action: "user_profile_changed", labelFor: () => "User Profile name changed" });
logOnBlur(profileTitleInput, { action: "user_profile_changed", labelFor: () => "User Profile title changed" });
logOnBlur(profileEmailInput, { action: "user_profile_changed", labelFor: () => "User Profile email changed" });

// v0.29.38: reported directly - date-only made two same-day imports (e.g.
// re-importing a refreshed workbook to pick up a Zefix cross-check) show an
// identical status line, with no way to tell a just-finished import from a
// stale one hours earlier, or confirm it actually ran at all. Time added;
// still date-first since that's the more useful glance for anything not
// imported today.
editSetupBtn.addEventListener("click", () => {
  location.hash = "#wizard"; // the wizard opens inside this page (see openWizardInline), menu still on the left
});
document.getElementById("nav-change-settings").addEventListener("click", () => {
  if (location.hash === "#change-settings") setTimeout(routeSettings, 0); // re-click on the open item still re-shows it
});

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

// Messages from the frame this page hosts (the wizard / Change Settings).
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || !event.data) return;
  if (event.data.type === "salesteam-leave-settings") {
    // Change Settings' "Back to menu": when this page is itself shown inside another page (Posts, Accounts, Scanner),
    // close it and land back on that page - not on a Settings card the user never chose.
    if (window.parent !== window) window.parent.postMessage({ type: "salesteam-close-embedded" }, location.origin);
    else location.hash = "#profile-section";
  }
});

document.getElementById("embedded-page-close-btn").addEventListener("click", hideEmbeddedPage);
document.getElementById("app-nav-brand-name").addEventListener("click", hideEmbeddedPage);

if (new URLSearchParams(location.search).has("embedded")) {
  document.getElementById("app-shell").classList.add("embedded-mode");
}

document.getElementById("open-target-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html", "Target Accounts Dashboard"));
document.getElementById("nav-import-target-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=import-accounts", "Target Accounts Dashboard"));
document.getElementById("nav-restore-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=restore-accounts", "Target Accounts Dashboard"));
document.getElementById("nav-hubspot-export-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=export-hubspot", "Target Accounts Dashboard"));
document.getElementById("nav-hubspot-import-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=import-hubspot", "Target Accounts Dashboard"));
document.getElementById("nav-find-duplicates-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=find-duplicates", "Target Accounts Dashboard"));
document.getElementById("nav-resolve-target-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=resolve", "Target Accounts Dashboard"));
document.getElementById("nav-fetch-size-target-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=fetch-size", "Target Accounts Dashboard"));
document.getElementById("nav-prioritize-target-accounts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=prioritize", "Target Accounts Dashboard"));
document.getElementById("open-target-contacts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#contacts", "Target Contacts Dashboard"));
document.getElementById("nav-discover-contacts-btn").addEventListener("click", () => showEmbeddedPage("target-accounts.html#action=discover-contacts", "Target Contacts Dashboard"));
document.getElementById("open-dashboard-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html", "Posts Dashboard"));
document.getElementById("nav-prioritize-unscored-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=prioritize-unscored", "Posts Dashboard"));
document.getElementById("nav-rescore-all-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=rescore-all", "Posts Dashboard"));
document.getElementById("nav-extract-companies-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=extract-companies", "Posts Dashboard"));
document.getElementById("nav-extract-companies-profiles-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=extract-companies-profiles", "Posts Dashboard"));
document.getElementById("nav-apply-location-filter-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=apply-location-filter", "Posts Dashboard"));
document.getElementById("nav-export-csv-all-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=export-csv-all", "Posts Dashboard"));
document.getElementById("nav-export-csv-filtered-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=export-csv-filtered", "Posts Dashboard"));
document.getElementById("open-scanner-page-btn").addEventListener("click", () => showEmbeddedPage("scanner.html", "Scanner"));
document.getElementById("open-advisors-btn").addEventListener("click", () => showEmbeddedPage("advisors.html", "Advisors"));
document.getElementById("open-activity-log-btn").addEventListener("click", () => showEmbeddedPage("activity-log.html", "Activity Log"));
document.getElementById("open-help-btn").addEventListener("click", () => showEmbeddedPage("help.html", "Help"));

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

// Discovery Queue debug panel (PRD 6.20 Phase 4) - Phase 5/6 don't exist
// yet to drive this queue for real, so each button below simulates one
// loop iteration of what those phases will eventually do, exercising the
// exact same discovery-queue.js functions they'll call. Temporary -
// remove or fold into real Discovery progress UI once Phase 5/6 ship.
async function renderDiscoveryQueueState() {
  const state = await getDiscoveryQueueState();
  document.getElementById("discovery-queue-state-display").textContent = JSON.stringify(state, null, 2);
}

document.getElementById("discovery-queue-start-btn").addEventListener("click", async () => {
  const configSnapshot = {
    ...(await getTargetUniverseConfig()),
    ...(await getTargetContactProfile()),
  };
  await startDiscoveryQueue(configSnapshot);
});

document.getElementById("discovery-queue-checkpoint-company-btn").addEventListener("click", async () => {
  const state = await getDiscoveryQueueState();
  const n = state.companyPhase.discoveredCompanyKeys.length + 1;
  await checkpointCompanyPhase({
    nextSearchCursor: n,
    discoveredCompanyKeys: [...state.companyPhase.discoveredCompanyKeys, `test-company-${n}`],
  });
});

document.getElementById("discovery-queue-advance-contacts-btn").addEventListener("click", async () => {
  await advanceToContactPhase();
});

document.getElementById("discovery-queue-checkpoint-contact-btn").addEventListener("click", async () => {
  const state = await getDiscoveryQueueState();
  await checkpointContactPhase({ nextCompanyIndex: state.contactPhase.nextCompanyIndex + 1 });
});

document.getElementById("discovery-queue-complete-btn").addEventListener("click", async () => {
  await completeDiscoveryQueue();
});

// Reuses the exact same scanAbortRequested flag every other scan's Stop
// button already sets (sidepanel.js) - not a separate mechanism.
document.getElementById("discovery-queue-stop-btn").addEventListener("click", () => {
  chrome.storage.local.set({ scanAbortRequested: true });
});

document.getElementById("discovery-queue-reset-btn").addEventListener("click", async () => {
  await resetDiscoveryQueue();
  await chrome.storage.local.remove("scanAbortRequested");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.discoveryQueueState) renderDiscoveryQueueState();
});

// Phase 5 live test harness - drives the real company-discovery-extraction.js
// orchestrator against the saved onboarding criteria, checkpointing into the
// same Discovery Queue state the debug panel above shows. Temporary, same
// reasoning as that panel - remove once Phase 5 is wired into real progress UI.
const companyDiscoveryStatusEl = document.getElementById("company-discovery-status");
const companyDiscoveryResultsEl = document.getElementById("company-discovery-results-display");
let companyDiscoveryRunning = false;

async function runCompanyDiscoveryDebug() {
  if (companyDiscoveryRunning) return;
  companyDiscoveryRunning = true;
  await chrome.storage.local.remove("scanAbortRequested");
  companyDiscoveryStatusEl.textContent = "Running...";
  companyDiscoveryResultsEl.textContent = "";
  const companiesBefore = (await getDiscoveredCompanies()).length;
  try {
    const summary = await runCompanyDiscoveryPhase({
      onProgress: ({ country, language, page, foundSoFar, cap }) => {
        const countryText = language && language !== "English" ? `${country} (${language})` : country;
        companyDiscoveryStatusEl.textContent = `Running - ${countryText}, page ${page}, ${foundSoFar}/${cap} companies found...`;
      },
      shouldAbort: () => {
        // Read synchronously off the last-known storage snapshot instead of
        // an async get() here - same pattern this codebase's other scan
        // loops use for their own shouldAbort, via a listener-maintained
        // local flag below.
        return scanAbortRequestedFlag;
      },
    });
    // pageDebugSamples every entry with receivedMessage: false is the
    // signature of "the content script never actually ran/responded" (most
    // likely the extension needs a reload in chrome://extensions after a
    // content-script/manifest change) rather than "genuinely zero real
    // matches" - worth calling out plainly in the status line since it's
    // the difference between "reload the extension and retry" and "your
    // criteria are just too narrow."
    const noContentScriptResponse =
      summary.pageDebugSamples?.length > 0 && summary.pageDebugSamples.every((s) => !s.receivedMessage);
    companyDiscoveryStatusEl.textContent = summary.ranAnything
      ? `Done. ${JSON.stringify({ stoppedByAbort: summary.stoppedByAbort, stoppedByTouchBudget: summary.stoppedByTouchBudget, reachedCap: summary.reachedCap })}` +
        (noContentScriptResponse
          ? " WARNING: no page ever reported back - reload the extension in chrome://extensions and try again."
          : "")
      : `Did not run: ${summary.reason}`;
    companyDiscoveryResultsEl.textContent = JSON.stringify(summary, null, 2);
    // Discovery run history (PRD 6.20, added 2026-09-16) - a run's stats
    // used to only ever exist as this transient JSON blob above, gone the
    // moment the next run overwrites it. Logged here (the UI-driving
    // handler), not inside runCompanyDiscoveryPhase itself, matching this
    // codebase's own convention (background.js/dashboard.js log around
    // their scan calls, not inside them) - keeps the orchestration module
    // free of UI/activity-log concerns. addedThisRun is a before/after
    // getDiscoveredCompanies() diff, not summary.totalDiscovered (that's
    // the running total across every call so far, not this call's own
    // contribution - see runCompanyDiscoveryPhase's own comment on
    // acceptedCount). Only logged when the phase actually ran (not a
    // same-state no-op like "queue status is X, not discovering_companies").
    if (summary.ranAnything) {
      const configSnapshot = (await getDiscoveryQueueState()).configSnapshot || {};
      const addedThisRun = (await getDiscoveredCompanies()).length - companiesBefore;
      const locationsText = configSnapshot.locationMode === "continent"
        ? (configSnapshot.continents || []).join(", ") || "(none selected)"
        : (configSnapshot.countries || []).join(", ") || "(none selected)";
      const industriesText = (configSnapshot.industries || []).length ? configSnapshot.industries.join(", ") : "any";
      const sizeText = configSnapshot.sizeMode === "topN"
        ? `top ${configSnapshot.topN}`
        : `${configSnapshot.minEmployees ?? "any"}-${configSnapshot.maxEmployees ?? "any"} employees`;
      const languagesText = ["English", ...(summary.keywordSearchLanguages || [])].join(", ");
      appendActivityLog({
        actor: "user",
        action: "company_discovery_run",
        label: `Company discovery: ${addedThisRun} added (Priority 1), ${summary.pagesFetched} page(s) fetched. ` +
          `Locations: ${locationsText}. Industries: ${industriesText}. Size: ${sizeText}. Languages: ${languagesText}.` +
          (summary.stoppedByTouchBudget ? " Stopped - daily LinkedIn activity limit reached." : "") +
          (summary.stoppedByAbort ? " Stopped by user." : ""),
        newValue: { addedThisRun, totalDiscovered: summary.totalDiscovered, ...summary },
      });
    }
  } catch (err) {
    companyDiscoveryStatusEl.textContent = `Error: ${err?.message || err}`;
    appendActivityLog({ actor: "user", action: "company_discovery_run", label: "Company discovery run failed", error: true, errorMessage: err?.message || String(err) });
  } finally {
    companyDiscoveryRunning = false;
  }
}

let scanAbortRequestedFlag = false;
chrome.storage.local.get("scanAbortRequested").then((data) => {
  scanAbortRequestedFlag = Boolean(data.scanAbortRequested);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.scanAbortRequested) {
    scanAbortRequestedFlag = Boolean(changes.scanAbortRequested.newValue);
  }
});

document.getElementById("company-discovery-start-btn").addEventListener("click", async () => {
  const configSnapshot = {
    ...(await getTargetUniverseConfig()),
    ...(await getTargetContactProfile()),
  };
  await startDiscoveryQueue(configSnapshot);
  await runCompanyDiscoveryDebug();
});

document.getElementById("company-discovery-resume-btn").addEventListener("click", async () => {
  await resumeDiscoveryQueue();
  await runCompanyDiscoveryDebug();
});

document.getElementById("company-discovery-stop-btn").addEventListener("click", () => {
  chrome.storage.local.set({ scanAbortRequested: true });
});

document.getElementById("company-discovery-clear-cache-btn").addEventListener("click", async () => {
  await clearCompanyLocationSizeCache();
  companyDiscoveryStatusEl.textContent = "Location cache cleared.";
});

const companyDiscoveryCompaniesEl = document.getElementById("company-discovery-companies-display");
document.getElementById("company-discovery-show-companies-btn").addEventListener("click", async () => {
  const companies = await getDiscoveredCompanies();
  companyDiscoveryCompaniesEl.textContent = companies.length
    ? `${companies.length} discovered so far:\n\n` +
      companies
        .map((c) => {
          const reviewFlag = c.organizationTypeReviewLabel ? `  [REVIEW: ${c.organizationTypeReviewLabel}]` : "";
          const aliasFlag = c.canonicalSlug ? `  [ALIAS OF: linkedin.com/company/${c.canonicalSlug}]` : "";
          return `${c.name}  —  ${c.country}  (${c.resolvedVia})  —  linkedin.com/company/${c.slug}${reviewFlag}${aliasFlag}`;
        })
        .join("\n")
    : "No companies discovered yet.";
});

// Cross-checks Phase 5's discovered companies against the existing Dashboard
// (targetAccountsWorkbook - the ChatGPT-imported data target-accounts.js
// actually renders) - a sanity check on whether Discovery is finding
// genuinely new accounts or just re-finding ones already known. Two match
// signals, same discipline as target-accounts.js's own comparisons
// elsewhere: an exact LinkedIn company id match (via the legacy
// targetAccounts map, the only place linkedinCompanyId actually lives -
// see target-accounts.js's renderLinkedinResolveStatus comment) is the most
// reliable; normalizeCompanyName (storage.js, the same helper
// target-accounts.js itself uses for this exact kind of comparison) is the
// fallback for companies 6.16's resolver hasn't reached yet.
document.getElementById("company-discovery-compare-dashboard-btn").addEventListener("click", async () => {
  const [discovered, workbook, targetAccounts] = await Promise.all([
    getDiscoveredCompanies(),
    getTargetAccountsWorkbook(),
    getTargetAccounts(),
  ]);
  const dashboardIdSet = new Set(
    Object.values(targetAccounts)
      .map((a) => a.linkedinCompanyId)
      .filter(Boolean)
  );
  const dashboardNameSet = new Set((workbook.companies || []).map((c) => normalizeCompanyName(c.company)));

  const matched = [];
  const newOnes = [];
  const aliasFlagged = [];
  for (const c of discovered) {
    // An alias-resolved record's own name (e.g. "Audi Schweiz") isn't the
    // canonical company's real name (e.g. "AMAG") - storage.js's
    // companyAliases deliberately stores no display name for the canonical
    // company (see its own header comment for why), so there's nothing
    // reliable to run normalizeCompanyName against here. Rather than
    // silently reporting a possible false "new" (the canonical company may
    // well already be in the Dashboard under its real name), these are
    // called out separately for a manual look instead of auto-matched.
    if (c.canonicalSlug) {
      aliasFlagged.push(`${c.name}  →  alias of linkedin.com/company/${c.canonicalSlug}  (check manually - not auto-matched)`);
      continue;
    }
    const byId = dashboardIdSet.has(c.linkedinCompanyId);
    const byName = dashboardNameSet.has(normalizeCompanyName(c.name));
    if (byId || byName) {
      matched.push(`${c.name}  (matched by ${byId ? "LinkedIn id" : "name"})`);
    } else {
      newOnes.push(c.name);
    }
  }

  companyDiscoveryCompaniesEl.textContent =
    `${discovered.length} discovered total - ${matched.length} already in the Dashboard, ${newOnes.length} new, ${aliasFlagged.length} alias-flagged.\n\n` +
    `Already in Dashboard (${matched.length}):\n` + (matched.join("\n") || "(none)") +
    `\n\nNew, not yet in Dashboard (${newOnes.length}):\n` + (newOnes.join("\n") || "(none)") +
    `\n\nAlias-resolved, needs manual check (${aliasFlagged.length}):\n` + (aliasFlagged.join("\n") || "(none)");
});

// Phase 6 live test harness - same reasoning/pattern as the Phase 5 harness
// above. Unlike Phase 5, there's no separate "start" call - the queue is
// already positioned at status "discovering_contacts" once a Phase 5 run
// completes (advanceToContactPhase, inside company-discovery-extraction.js),
// so this just runs (or resumes) it directly.
const contactDiscoveryStatusEl = document.getElementById("contact-discovery-status");
const contactDiscoveryResultsEl = document.getElementById("contact-discovery-results-display");
const contactDiscoveryContactsEl = document.getElementById("contact-discovery-contacts-display");
let contactDiscoveryRunning = false;

document.getElementById("contact-discovery-run-btn").addEventListener("click", async () => {
  if (contactDiscoveryRunning) return;
  contactDiscoveryRunning = true;
  await chrome.storage.local.remove("scanAbortRequested");
  contactDiscoveryStatusEl.textContent = "Running...";
  contactDiscoveryResultsEl.textContent = "";
  try {
    const summary = await runContactDiscoveryPhase({
      onProgress: ({ company, index, total }) => {
        contactDiscoveryStatusEl.textContent = `Running - company ${index + 1}/${total}: ${company}...`;
      },
      shouldAbort: () => scanAbortRequestedFlag,
    });
    // droppedTerms - confirmed live 2026-09-15: LinkedIn's People-tab
    // insights backend reliably fails past ~6 boolean OR-clauses in the
    // keywords= expression, so a Target Contacts profile with more titles/
    // keywords than that gets trimmed (exactTitles prioritized first) -
    // surfaced plainly here since a silently-trimmed search would otherwise
    // look identical to "these titles just don't exist at this company."
    const droppedNote = summary.droppedTerms?.length
      ? ` WARNING: ${summary.droppedTerms.length} title/keyword(s) dropped from the search (LinkedIn's own query-complexity limit, ~6 terms) - not searched for at all: ${summary.droppedTerms.join(", ")}.`
      : "";
    contactDiscoveryStatusEl.textContent = summary.ranAnything
      ? `Done. ${JSON.stringify({ stoppedByAbort: summary.stoppedByAbort, stoppedByTouchBudget: summary.stoppedByTouchBudget, reachedEnd: summary.reachedEnd })}${droppedNote}`
      : `Did not run: ${summary.reason}`;
    contactDiscoveryResultsEl.textContent = JSON.stringify(summary, null, 2);
    // Discovery run history - see runCompanyDiscoveryDebug's own comment on
    // why this is logged here (the UI handler) rather than inside
    // runContactDiscoveryPhase. Unlike Phase 5's totalDiscovered,
    // totalNewContacts here is already this call's own contribution, not a
    // running total (runContactDiscoveryPhase resets it to 0 every call).
    if (summary.ranAnything) {
      appendActivityLog({
        actor: "user",
        action: "contact_discovery_run",
        label: `Contact discovery: ${summary.totalNewContacts} contacts found across ${summary.companiesProcessed}/${summary.totalCompanies} companies ` +
          `(${summary.companiesWithNoMatch} with no match). Searched: ${summary.includedTerms.join(", ")}.` +
          (summary.droppedTerms?.length ? ` Dropped (query too complex): ${summary.droppedTerms.join(", ")}.` : "") +
          (summary.stoppedByTouchBudget ? " Stopped - daily LinkedIn activity limit reached." : "") +
          (summary.stoppedByAbort ? " Stopped by user." : ""),
        newValue: summary,
      });
    }
  } catch (err) {
    contactDiscoveryStatusEl.textContent = `Error: ${err?.message || err}`;
    appendActivityLog({ actor: "user", action: "contact_discovery_run", label: "Contact discovery run failed", error: true, errorMessage: err?.message || String(err) });
  } finally {
    contactDiscoveryRunning = false;
  }
});

document.getElementById("contact-discovery-stop-btn").addEventListener("click", () => {
  chrome.storage.local.set({ scanAbortRequested: true });
});

document.getElementById("contact-discovery-show-btn").addEventListener("click", async () => {
  const contacts = await getDiscoveredContacts();
  contactDiscoveryContactsEl.textContent = contacts.length
    ? `${contacts.length} discovered so far:\n\n` +
      contacts
        .map((c) => `${c.name}  —  ${c.headlineText}  (${c.tier})  —  ${c.companyName}  —  linkedin.com/in/${c.slug}`)
        .join("\n")
    : "No contacts discovered yet.";
});

document.getElementById("contact-discovery-clear-btn").addEventListener("click", async () => {
  await clearDiscoveredContacts();
  contactDiscoveryStatusEl.textContent = "Discovered contacts cleared.";
  contactDiscoveryContactsEl.textContent = "";
});

// checkpointContactPhase advances nextCompanyIndex after every company
// regardless of outcome (so a real stop never loses more than one
// company's worth of progress) - which also means a company that was
// wrongly recorded as "no candidates" (e.g. the insights-load-error bug
// found live 2026-09-15) stays skipped on a normal Resume, since it's
// already past that index. This resets just the contact-phase cursor
// (not the whole queue - a full Reset would also make Phase 5 re-walk its
// search pages) so a full contact-discovery re-run can pick up companies a
// bug caused to be missed the first time, without re-doing Phase 5.
document.getElementById("contact-discovery-restart-btn").addEventListener("click", async () => {
  await checkpointContactPhase({ nextCompanyIndex: 0 });
  contactDiscoveryStatusEl.textContent = "Contact-phase cursor reset to company 1 - existing discovered contacts were NOT cleared.";
});

// See sidepanel.js's own copy of this function for the full reasoning
// (LinkedIn's "unusual activity" warning after a day of concentrated
// testing, ~315 automated visits reconstructed after the fact) - shown here
// too since the company-ID resolver (this page's own biggest single
// contributor to that day's total) can be run from Settings without the
// side panel ever being open.
async function renderLinkedinTouchStat() {
  const el = document.getElementById("linkedin-touch-stat");
  const touchStats = await getLinkedinTouchStats();
  const { today, last24h, last7d, level } = touchStats;
  el.textContent = `LinkedIn touches (automated): ${today} today · ${last24h} in the last 24h · ${last7d} in the last 7 days` +
    (level === "ok" ? "" : ` — ${formatTouchRelease(touchStats)}`);
  el.classList.toggle("linkedin-touch-stat-warn", level === "warn");
  el.classList.toggle("linkedin-touch-stat-danger", level === "danger");
}

// PRD 6.20 Phase 10 follow-up (2026-09-18), user's own direct feedback:
// this page used to be one long scroll with anchor-jump nav items (every
// section always rendered, just scrolled to) - now exactly one
// .settings-card shows at a time, chosen by the nav, so the Setup Wizard's
// own explanation and the 3 debug test panels don't clutter the page by
// default any more. Same hash-based routing shape as target-accounts.js/
// dashboard.js's own #key=value views, just keyed by a bare section id
// instead. Defaults to the Setup section (the most useful first stop) when
// the hash is empty or doesn't match any known section.
const SETTINGS_SECTION_IDS = [
  "setup-section", "automation-section", "profile-section", "language-section", "api-key-section", "backup-section", "restore-section", "billing-section",
  "discovery-queue-section", "company-discovery-section", "contact-discovery-section",
];

let onboardingIsComplete = false;

function currentSectionId() {
  const hash = location.hash.slice(1);
  if (SETTINGS_SECTION_IDS.includes(hash)) return hash;
  // The Onboarding card is only the landing page while the setup is unfinished.
  return onboardingIsComplete ? "profile-section" : "setup-section";
}

// "Change Settings": the same topics as the setup wizard, but as a plain list of settings - no steps, no Next/Back.
function openChangeSettingsInline() {
  if (embeddedPageWrapEl.hidden || !embeddedPageFrameEl.src.includes("mode=settings")) {
    showEmbeddedPage("onboarding.html?mode=settings", "Change Settings");
  }
  document.querySelectorAll("#app-nav .nav-item.active").forEach((e) => e.classList.remove("active"));
  document.getElementById("nav-change-settings")?.classList.add("active");
}

// The Setup wizard, shown in this page's content area (as an embedded page) so the app menu stays on the left the
// whole time - it used to open as a bare full-page tab whose only way back to the menu was the "Exit" button.
function openWizardInline() {
  if (embeddedPageWrapEl.hidden || !embeddedPageFrameEl.src.startsWith(chrome.runtime.getURL("onboarding.html"))) {
    showEmbeddedPage("onboarding.html", "Setup");
  }
  document.querySelectorAll("#app-nav .nav-item.active").forEach((e) => e.classList.remove("active"));
  document.getElementById("nav-setup-section")?.classList.add("active");
}

function routeSettings() {
  if (location.hash === "#wizard") {
    openWizardInline();
    return;
  }
  if (location.hash === "#change-settings") {
    openChangeSettingsInline();
    return;
  }
  // A Settings card can only be seen when no other page is displayed over this page's content area. Clicking a
  // Settings menu item while (say) the Accounts Dashboard is shown used to change the hash and select the card
  // behind that page - so "nothing happened" until a browser refresh cleared the embedded page.
  if (!embeddedPageWrapEl.hidden) hideEmbeddedPage();
  const activeId = currentSectionId();
  for (const id of SETTINGS_SECTION_IDS) {
    const sectionEl = document.getElementById(id);
    if (sectionEl) sectionEl.hidden = id !== activeId;
    const navEl = document.getElementById(`nav-${id}`);
    if (navEl) navEl.classList.toggle("active", id === activeId);
  }
}

window.addEventListener("hashchange", routeSettings);
// Re-clicking the item that is already selected does not change the hash (so no hashchange fires) - route on the
// click itself as well, so it still brings the card back to the front.
document.querySelectorAll('#app-nav a.nav-item[href^="#"]').forEach((link) => {
  link.addEventListener("click", () => setTimeout(routeSettings, 0));
});

// STEP_ORDER (onboarding.js) has 11 real steps + a final "finish" entry -
// kept as a plain constant here rather than importing onboarding.js itself
// (a self-wiring page script, not a data module - same reasoning every
// other cross-page reference in this codebase avoids importing one page's
// script from another). Re-sync this number if a step is ever added there.
const ONBOARDING_TOTAL_STEPS = 11;

async function renderOnboardingProgress() {
  const [completedAt, stepIndex] = await Promise.all([getOnboardingCompletedAt(), getOnboardingProgressStepIndex()]);
  const completedCount = completedAt ? ONBOARDING_TOTAL_STEPS : Math.min(stepIndex, ONBOARDING_TOTAL_STEPS);
  const pct = Math.round((completedCount / ONBOARDING_TOTAL_STEPS) * 100);
  const label = completedAt ? "Completed" : `${completedCount} of ${ONBOARDING_TOTAL_STEPS} completed`;

  onboardingIsComplete = Boolean(completedAt);
  document.getElementById("nav-setup-section").hidden = onboardingIsComplete;
  document.getElementById("nav-onboarding-progress").textContent =
    completedCount === 0 ? "(not started)" : `(${completedCount} of ${ONBOARDING_TOTAL_STEPS} done)`;
  document.getElementById("onboarding-progress-label").textContent = label;
  document.getElementById("onboarding-progress-fill").style.width = `${pct}%`;
  document.getElementById("onboarding-progress-fill").classList.toggle("onboarding-progress-fill-done", Boolean(completedAt));
}

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;

  onboardingIsComplete = Boolean(await getOnboardingCompletedAt());
  routeSettings();

  await renderLinkedinTouchStat();
  setInterval(renderLinkedinTouchStat, 30000);

  const onboardingCompletedAt = await getOnboardingCompletedAt();
  editSetupStatusEl.textContent = onboardingCompletedAt
    ? `Last completed ${new Date(onboardingCompletedAt).toLocaleDateString()}.`
    : "Not completed yet.";
  await renderOnboardingProgress();

  await renderDiscoveryQueueState();

  outputLanguageSelect.value = await getOutputLanguage();
  outputLanguageSelect.dataset.prevValue = outputLanguageSelect.value;
  storedApiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
  anthropicApiKeyInput.value = storedApiKey;
  refreshApiKeyButtons();

  currentUserProfile = await getUserProfile();
  profileNameInput.value = currentUserProfile.name;
  profileTitleInput.value = currentUserProfile.title;
  profileEmailInput.value = currentUserProfile.email;
}

init();

// Automatic daily backup (once per 24h across all open pages) - see backup-restore.js.
startAutoBackup();


// ---- Billing page: usage and estimated cost of the AI calls made on the user's own API key ----
function fmtUsd(n) {
  if (!n) return "$0.00";
  return n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}
function fmtNum(n) { return Math.round(n || 0).toLocaleString(); }

function billingRow(label, s, bold) {
  const tr = document.createElement("tr");
  if (bold) tr.className = "billing-total-row";
  const cells = [label, fmtNum(s.total.calls), fmtNum(s.total.inputTokens + s.total.cacheTokens), fmtNum(s.total.outputTokens), fmtNum(s.total.searches),
    fmtUsd(s.webResearch.usd), fmtUsd(s.other.usd), fmtUsd(s.total.usd)];
  for (const c of cells) {
    const td = document.createElement("td");
    td.textContent = c;
    tr.appendChild(td);
  }
  return tr;
}

function billingHeader(table, first) {
  table.innerHTML = "";
  const tr = document.createElement("tr");
  for (const h of [first, "Calls", "Tokens in", "Tokens out", "Web searches", "Web research US$", "Other AI US$", "Total US$"]) {
    const th = document.createElement("th");
    th.textContent = h;
    tr.appendChild(th);
  }
  table.appendChild(tr);
}

async function renderBilling() {
  if (!document.getElementById("billing-section")) return;
  const days = await getApiUsage();
  const today = localDayKey();
  const month = today.slice(0, 7);
  const allKeys = Object.keys(days).sort();

  const totals = document.getElementById("billing-totals");
  billingHeader(totals, "Period");
  totals.appendChild(billingRow("Today", sumDays(days, allKeys.filter((k) => k === today))));
  totals.appendChild(billingRow("This month so far", sumDays(days, allKeys.filter((k) => k.startsWith(month)))));
  totals.appendChild(billingRow("All time", sumDays(days, allKeys), true));

  const all = sumDays(days, allKeys);
  document.getElementById("billing-average").textContent = all.webResearch.calls > 0
    ? `Web research so far: ${all.webResearch.calls} research${all.webResearch.calls === 1 ? "" : "es"}, ${fmtNum(all.webResearch.searches)} web searches, about ${fmtUsd(all.webResearch.usd / all.webResearch.calls)} per research, of which about $0.01 per web search is the search fee.`
    : "No web research has been run yet.";

  const daysTable = document.getElementById("billing-days");
  billingHeader(daysTable, "Day");
  const lastDays = allKeys.slice(-31).reverse();
  if (lastDays.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.textContent = "Nothing counted yet.";
    tr.appendChild(td);
    daysTable.appendChild(tr);
  }
  for (const k of lastDays) daysTable.appendChild(billingRow(k, sumDays(days, [k])));

  // Cost per feature: all time with tokens, plus today and this month so far.
  const features = {};
  const bump = (name, f, bucket) => {
    features[name] = features[name] || { calls: 0, inputTokens: 0, outputTokens: 0, searches: 0, all: 0, month: 0, today: 0 };
    const row = features[name];
    if (bucket === "all") {
      row.calls += f.calls || 0;
      row.inputTokens += f.inputTokens || 0;
      row.outputTokens += f.outputTokens || 0;
      row.searches += f.searches || 0;
    }
    row[bucket] += f.usd || 0;
  };
  for (const k of allKeys) for (const [name, f] of Object.entries(days[k].byFeature || {})) {
    bump(name, f, "all");
    if (k.startsWith(month)) bump(name, f, "month");
    if (k === today) bump(name, f, "today");
  }
  const ft = document.getElementById("billing-features");
  ft.innerHTML = "";
  const head = document.createElement("tr");
  for (const h of ["Feature", "Calls", "Tokens in", "Tokens out", "Web searches", "Today US$", "This month US$", "All time US$"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  ft.appendChild(head);
  for (const [name, f] of Object.entries(features).sort((a, b) => b[1].all - a[1].all)) {
    const tr = document.createElement("tr");
    for (const c of [name, fmtNum(f.calls), fmtNum(f.inputTokens), fmtNum(f.outputTokens), fmtNum(f.searches), fmtUsd(f.today), fmtUsd(f.month), fmtUsd(f.all)]) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    ft.appendChild(tr);
  }
}

document.getElementById("billing-reset-btn").addEventListener("click", async () => {
  if (!(await askConfirm("Reset the usage and cost counters to zero?\n\nThis only clears SalesTeam's own count. Nothing changes on your Anthropic account.", { okLabel: "Reset", cancelLabel: "Cancel", danger: true }))) return;
  await clearApiUsage();
  await renderBilling();
});
chrome.storage.onChanged.addListener((changes) => { if (changes.apiUsage) renderBilling(); });
renderBilling();

// Warning limit setting
const billingWarningInput = document.getElementById("billing-warning-input");
const billingWarningSaveBtn = document.getElementById("billing-warning-save-btn");
const billingWarningStatus = document.getElementById("billing-warning-status");
let storedWarningUsd = 2;
async function loadWarningLimit() {
  storedWarningUsd = await getCostWarningUsd();
  billingWarningInput.value = String(storedWarningUsd);
  billingWarningSaveBtn.disabled = true;
}
billingWarningInput.addEventListener("input", () => {
  billingWarningSaveBtn.disabled = Number(billingWarningInput.value) === storedWarningUsd || billingWarningInput.value === "";
  billingWarningStatus.textContent = billingWarningSaveBtn.disabled ? "" : "Unsaved changes";
});
billingWarningSaveBtn.addEventListener("click", async () => {
  await saveCostWarningUsd(Number(billingWarningInput.value));
  await loadWarningLimit();
  billingWarningStatus.textContent = "Saved ✓";
  setTimeout(() => { if (billingWarningStatus.textContent === "Saved ✓") billingWarningStatus.textContent = ""; }, 2500);
});
loadWarningLimit();
initBatchStatus();

// ---- Automation (1.2 data pipeline, build step 3) ----
const automationCheckbox = document.getElementById("automation-enabled-checkbox");
const automationResumeBtn = document.getElementById("automation-resume-btn");
document.getElementById("automation-enabled-label").textContent = CONSENT_TITLE;
document.getElementById("automation-consent-text").textContent = CONSENT_TEXT;
async function renderAutomationCard() {
  const a = await getPipelineAutomation();
  automationCheckbox.checked = a.enabled;
  automationResumeBtn.hidden = !(a.enabled && a.pausedDay === localDay());
}
automationCheckbox.addEventListener("change", async () => {
  await setPipelineAutomationEnabled(automationCheckbox.checked, "Settings");
  if (automationCheckbox.checked) kickAndExplain("settings");
  else chrome.runtime.sendMessage({ type: "PIPELINE_STOP" }).catch(() => {});
});
automationResumeBtn.addEventListener("click", async () => {
  await setPipelinePausedDay(null);
  kickPipelineFromPage("resume");
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[PIPELINE_AUTOMATION_KEY]) renderAutomationCard(); });
renderAutomationCard();
watchPipelineStatusLine(document.getElementById("automation-status-line"));

// ---- Web Findings - Automatic Arbitration ----
// The seven rule rows are generated from ARBITRATION_RULES rather than written into settings.html,
// so a rule added to the mechanism cannot quietly go missing from the page that is supposed to
// control it. Everything here saves on change - there is no Save button - matching the rest of this
// page; the stored object is a flat patch over DEFAULT_ARBITRATION_SETTINGS.
const webFindingsNumberFields = [
  { id: "web-findings-tolerance", path: ["tolerancePct"], min: 0, max: 100 },
  { id: "web-findings-max-employees", path: ["illogical", "maxEmployees"], min: 1 },
  { id: "web-findings-rev-floor", path: ["illogical", "revenueUnitsFloor"], min: 0 },
  { id: "web-findings-rev-ceil", path: ["illogical", "revenueUnitsCeil"], min: 0 },
  { id: "web-findings-rpe-min", path: ["illogical", "revPerEmployeeMin"], min: 0 },
  { id: "web-findings-rpe-max", path: ["illogical", "revPerEmployeeMax"], min: 0 },
];

function webFindingsEl(id) {
  return document.getElementById(id);
}

function buildWebFindingsRuleRows() {
  const wrap = webFindingsEl("web-findings-rules");
  wrap.innerHTML = "";
  for (const rule of ARBITRATION_RULES) {
    const label = document.createElement("label");
    label.className = "checkbox-label web-findings-rule";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `web-findings-rule-${rule.id}`;
    box.dataset.setting = rule.setting;
    label.appendChild(box);
    // Named, not numbered - see ruleLabel() in target-accounts.js for why.
    label.appendChild(document.createTextNode(` ${rule.label}`));
    const detail = document.createElement("p");
    detail.className = "field-hint web-findings-rule-detail";
    detail.textContent = rule.detail;
    wrap.appendChild(label);
    wrap.appendChild(detail);
    box.addEventListener("change", async () => {
      await saveWebFindingsArbitration({ [rule.setting]: box.checked });
      flashSaved();
      appendActivityLog({
        actor: "user",
        action: "web_findings_arbitration_changed",
        label: `Web findings arbitration: "${rule.label}" turned ${box.checked ? "on" : "off"}`,
        prevValue: String(!box.checked),
        newValue: String(box.checked),
      });
    });
  }
}

function fillWebFindingsForm(settings) {
  for (const rule of ARBITRATION_RULES) {
    const box = webFindingsEl(`web-findings-rule-${rule.id}`);
    if (box) box.checked = Boolean(settings[rule.setting]);
  }
  for (const f of webFindingsNumberFields) {
    const el = webFindingsEl(f.id);
    if (!el) continue;
    const value = f.path.length === 2 ? settings[f.path[0]]?.[f.path[1]] : settings[f.path[0]];
    el.value = value ?? "";
  }
  webFindingsEl("web-findings-preference").value = settings.sourcePreference || "existing";
  webFindingsEl("web-findings-linkedin-authoritative").checked = Boolean(settings.linkedinAuthoritative);
}

async function initWebFindingsArbitration() {
  if (!webFindingsEl("web-findings-rules")) return;
  buildWebFindingsRuleRows();
  fillWebFindingsForm(await getWebFindingsArbitration());

  for (const f of webFindingsNumberFields) {
    const el = webFindingsEl(f.id);
    if (!el) continue;
    // "change", not "input": half-typed numbers should not be saved, and an empty box should put
    // the default back rather than store a NaN that every later comparison would silently fail.
    el.addEventListener("change", async () => {
      const raw = Number(el.value);
      const fallback = f.path.length === 2
        ? DEFAULT_ARBITRATION_SETTINGS[f.path[0]][f.path[1]]
        : DEFAULT_ARBITRATION_SETTINGS[f.path[0]];
      let value = Number.isFinite(raw) && el.value !== "" ? raw : fallback;
      if (f.min !== undefined) value = Math.max(f.min, value);
      if (f.max !== undefined) value = Math.min(f.max, value);
      el.value = value;
      const patch = f.path.length === 2 ? { [f.path[0]]: { [f.path[1]]: value } } : { [f.path[0]]: value };
      await saveWebFindingsArbitration(patch);
      flashSaved();
    });
  }

  webFindingsEl("web-findings-preference").addEventListener("change", async (e) => {
    await saveWebFindingsArbitration({ sourcePreference: e.target.value });
    flashSaved();
    appendActivityLog({
      actor: "user",
      action: "web_findings_arbitration_changed",
      label: `Web findings arbitration: on a tie, prefer "${e.target.value === "web" ? "new web research" : "existing/imported data"}"`,
      newValue: e.target.value,
    });
  });

  webFindingsEl("web-findings-linkedin-authoritative").addEventListener("change", async (e) => {
    await saveWebFindingsArbitration({ linkedinAuthoritative: e.target.checked });
    flashSaved();
  });

  webFindingsEl("web-findings-reset-btn").addEventListener("click", async () => {
    if (!(await askConfirm(
      "Put every rule, tolerance and threshold here back to the way SalesTeam ships them?\n\nThis only changes the settings - nothing already decided on your accounts is touched.",
      { okLabel: "Put back the defaults", cancelLabel: "Cancel" }
    ))) return;
    const next = await saveWebFindingsArbitration(DEFAULT_ARBITRATION_SETTINGS);
    fillWebFindingsForm(next);
    webFindingsEl("web-findings-status").textContent = "Back to the defaults.";
    flashSaved();
    appendActivityLog({ actor: "user", action: "web_findings_arbitration_reset", label: "Web findings arbitration settings put back to the defaults" });
  });
}

initWebFindingsArbitration();

// ---- Revenue & Currency ----
// The rates grid is generated from SUPPORTED_CURRENCIES for the same reason the rule rows are
// generated from ARBITRATION_RULES: a currency added to the module should not need a second edit
// here to become visible.
async function initRevenueCurrency() {
  const select = document.getElementById("revenue-currency-select");
  if (!select) return;
  const grid = document.getElementById("revenue-rates-grid");
  const asOfInput = document.getElementById("revenue-rates-asof-input");
  const statusEl = document.getElementById("revenue-currency-status");

  select.innerHTML = "";
  for (const code of SUPPORTED_CURRENCIES) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = code;
    select.appendChild(option);
  }

  const fill = (settings) => {
    select.value = settings.targetCurrency;
    asOfInput.value = settings.asOf || "";
    document.getElementById("revenue-rates-asof").textContent =
      `Rates as last checked on ${settings.asOf || "an unknown date"}.`;
    grid.innerHTML = "";
    for (const code of SUPPORTED_CURRENCIES) {
      const label = document.createElement("label");
      label.textContent = `1 ${code} = ? USD`;
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.0001";
      input.min = "0";
      input.style.width = "140px";
      input.value = settings.rates[code] ?? "";
      input.disabled = code === DEFAULT_EXCHANGE_RATES.base;
      input.addEventListener("change", async () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || value <= 0) {
          input.value = settings.rates[code] ?? "";
          statusEl.textContent = "A rate has to be a number greater than zero.";
          return;
        }
        await saveRevenueNormalization({ rates: { [code]: value } });
        statusEl.textContent = `Saved - 1 ${code} = ${value} USD.`;
        flashSaved();
      });
      grid.appendChild(label);
      grid.appendChild(input);
    }
  };

  fill(await getRevenueNormalization());

  select.addEventListener("change", async () => {
    const next = await saveRevenueNormalization({ targetCurrency: select.value });
    fill(next);
    flashSaved();
    appendActivityLog({
      actor: "user",
      action: "revenue_currency_changed",
      label: `Revenue is now shown and compared in ${select.value}`,
      newValue: select.value,
    });
  });

  asOfInput.addEventListener("change", async () => {
    const next = await saveRevenueNormalization({ asOf: asOfInput.value });
    fill(next);
    flashSaved();
  });

  document.getElementById("revenue-rates-reset-btn").addEventListener("click", async () => {
    if (!(await askConfirm(
      "Put every exchange rate back to the values SalesTeam ships with?\n\nThe currency you display revenue in is not changed.",
      { okLabel: "Put back the defaults", cancelLabel: "Cancel" }
    ))) return;
    const next = await saveRevenueNormalization({ rates: DEFAULT_EXCHANGE_RATES.rates, asOf: DEFAULT_EXCHANGE_RATES.asOf });
    fill(next);
    statusEl.textContent = "Rates back to the defaults.";
    flashSaved();
  });
}

initRevenueCurrency();
