// Settings tab: form-bound persistence (via storage.js) for the Anthropic API
// key, per-scenario message templates, value-add offers, company context, and
// the AI output language - the shared configuration the Advisors and lead-
// drafting features read from.
import {
  getAnthropicApiKey,
  saveAnthropicApiKey,
  getMessageTemplates,
  saveMessageTemplates,
  getValueAddOffers,
  saveValueAddOffers,
  getCompanyContext,
  saveCompanyContext,
  getIdealCustomerProfile,
  saveIdealCustomerProfile,
  getOutputLanguage,
  saveOutputLanguage,
  importTargetAccounts,
  getTargetAccountsMeta,
  getTargetAccountScoreThreshold,
  saveTargetAccountScoreThreshold,
  importTargetAccountsWorkbook,
  exportTargetAccountsBackup,
  importTargetAccountsBackup,
  getTargetAccountsMissingLinkedinId,
  applyResolvedCompanyIds,
  markLinkedinResolveAttempted,
  getPrioritizationRules,
  savePrioritizationRuleOverride,
  appendActivityLog,
  getNegativeTopics,
  saveNegativeTopics,
  getLocationFilterConfig,
  saveLocationFilterConfig,
  reapplyLocationFilter,
  CONTINENT_LABELS,
  ALL_COUNTRIES,
} from "./storage.js";
import { sanitizeApiKey } from "./agent-shared.js";
import { parseFullTargetAccountsWorkbook } from "./xlsx-lite.js";
import { resolveConfirmText, runCompanyIdResolution } from "./company-resolve-extraction.js";
import { getLinkedinTouchStats } from "./linkedin-touch-log.js";

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

const outputLanguageSelect = document.getElementById("output-language-select");
const companyContextInput = document.getElementById("company-context-input");
const idealCustomerProfileInput = document.getElementById("ideal-customer-profile-input");
const anthropicApiKeyInput = document.getElementById("anthropic-api-key-input");
const messageTemplatesListEl = document.getElementById("message-templates-list");
const valueAddOffersInput = document.getElementById("value-add-offers-input");
const targetAccountsStatusEl = document.getElementById("target-accounts-status");
const importTargetAccountsBtn = document.getElementById("import-target-accounts-btn");
const importTargetAccountsFileInput = document.getElementById("import-target-accounts-file-input");
const exportTargetAccountsBtn = document.getElementById("export-target-accounts-btn");
const resolveCompanyIdsBtn = document.getElementById("resolve-company-ids-btn");
const stopResolveCompanyIdsBtn = document.getElementById("stop-resolve-company-ids-btn");
const resolveCompanyIdsStatusEl = document.getElementById("resolve-company-ids-status");
// Module-scoped, not local to the click handler below - the Stop button has
// its own separate click listener and needs to reach the same flag a
// currently-running resolve is reading via its shouldAbort callback.
let resolveAbortRequested = false;
const targetAccountThresholdInput = document.getElementById("target-account-threshold-input");
const prioritizationRulesTbodyEl = document.getElementById("prioritization-rules-tbody");
const locationFilterModeSelect = document.getElementById("location-filter-mode-select");
const locationFilterContinentsWrap = document.getElementById("location-filter-continents-wrap");
const locationFilterCountriesWrap = document.getElementById("location-filter-countries-wrap");
const locationFilterCountriesSearch = document.getElementById("location-filter-countries-search");
const locationFilterCountriesAvailable = document.getElementById("location-filter-countries-available");
const locationFilterCountriesSelected = document.getElementById("location-filter-countries-selected");
const locationFilterCountryAddBtn = document.getElementById("location-filter-country-add-btn");
const locationFilterCountryRemoveBtn = document.getElementById("location-filter-country-remove-btn");
const locationFilterCountriesCountEl = document.getElementById("location-filter-countries-count");
const locationFilterCountriesSaveBtn = document.getElementById("location-filter-countries-save-btn");
const locationFilterCountriesSaveStatusEl = document.getElementById("location-filter-countries-save-status");
const applyLocationFilterBtn = document.getElementById("apply-location-filter-btn");
const applyLocationFilterStatusEl = document.getElementById("apply-location-filter-status");

let messageTemplates = [];
let negativeTopics = [];
// Only ever populated from ALL_COUNTRIES (the picker below draws from that
// same list) - a selected entry can only ever be a name guaranteed to match
// classifyLocation()'s canonical output exactly. Reported directly: moving
// countries in/out of the filter shouldn't take effect on every single
// click while the user is still building up their list - so this is a
// staged, in-memory selection that only actually saves (and logs one
// activity entry) when the dedicated Save Countries button is clicked.
let selectedCountries = [];
let savedCountriesSnapshot = [];

function renderMessageTemplates() {
  messageTemplatesListEl.innerHTML = "";
  for (const template of messageTemplates) {
    const wrap = document.createElement("div");
    wrap.className = "template-card";
    const label = document.createElement("div");
    label.className = "template-name";
    label.textContent = template.name;
    const textarea = document.createElement("textarea");
    textarea.value = template.instructions;
    textarea.addEventListener("input", () => {
      template.instructions = textarea.value;
      saveMessageTemplates(messageTemplates);
      flashSaved();
    });
    logOnBlur(textarea, { action: "message_template_changed", labelFor: () => `Message Template "${template.name}" changed` });
    wrap.append(label, textarea);
    messageTemplatesListEl.appendChild(wrap);
  }
}

outputLanguageSelect.addEventListener("change", () => {
  const prevValue = outputLanguageSelect.dataset.prevValue || null;
  saveOutputLanguage(outputLanguageSelect.value);
  flashSaved();
  appendActivityLog({ actor: "user", action: "output_language_changed", label: `Output language changed to "${outputLanguageSelect.value}"`, prevValue, newValue: outputLanguageSelect.value });
  outputLanguageSelect.dataset.prevValue = outputLanguageSelect.value;
});

companyContextInput.addEventListener("input", () => {
  saveCompanyContext(companyContextInput.value);
  flashSaved();
});
logOnBlur(companyContextInput, { action: "company_context_changed", labelFor: () => "Company Context (\"What We Offer\") changed" });

idealCustomerProfileInput.addEventListener("input", () => {
  saveIdealCustomerProfile(idealCustomerProfileInput.value);
  flashSaved();
});
logOnBlur(idealCustomerProfileInput, { action: "ideal_customer_profile_changed", labelFor: () => "Ideal Customer Profile changed" });

valueAddOffersInput.addEventListener("input", () => {
  const offers = valueAddOffersInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  saveValueAddOffers(offers);
  flashSaved();
});
logOnBlur(valueAddOffersInput, {
  action: "value_add_offers_changed",
  labelFor: (oldVal, newVal) => {
    const oldCount = oldVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
    const newCount = newVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
    return `Value-Add Offers changed (${oldCount} → ${newCount} offers)`;
  },
});

anthropicApiKeyInput.addEventListener("input", () => {
  saveAnthropicApiKey(sanitizeApiKey(anthropicApiKeyInput.value));
  flashSaved();
});
anthropicApiKeyInput.addEventListener("blur", () => {
  // Deliberately never logs the actual key value, before or after - only
  // that it was touched.
  if (anthropicApiKeyInput.dataset.touched) {
    appendActivityLog({ actor: "user", action: "api_key_changed", label: "Anthropic API key changed" });
  }
});
anthropicApiKeyInput.addEventListener("focus", () => { anthropicApiKeyInput.dataset.touched = ""; });
anthropicApiKeyInput.addEventListener("input", () => { anthropicApiKeyInput.dataset.touched = "1"; });

// v0.29.38: reported directly - date-only made two same-day imports (e.g.
// re-importing a refreshed workbook to pick up a Zefix cross-check) show an
// identical status line, with no way to tell a just-finished import from a
// stale one hours earlier, or confirm it actually ran at all. Time added;
// still date-first since that's the more useful glance for anything not
// imported today.
function formatImportedAt(ms) {
  return new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function renderTargetAccountsStatus() {
  const { count, importedAt, importedFileName } = await getTargetAccountsMeta();
  targetAccountsStatusEl.textContent = count > 0
    ? `${count} companies imported${importedFileName ? ` from file ${importedFileName}` : ""} at ${formatImportedAt(importedAt)}`
    : "No target accounts imported yet.";
}

importTargetAccountsBtn.addEventListener("click", () => {
  importTargetAccountsFileInput.click();
});

importTargetAccountsFileInput.addEventListener("change", async () => {
  const file = importTargetAccountsFileInput.files[0];
  importTargetAccountsFileInput.value = "";
  if (!file) return;
  // v0.29.38: reported directly, alongside the date-only ambiguity fix
  // above - parsing a large multi-sheet workbook isn't instant, and with
  // no feedback between the click and the final status line, a click that
  // hadn't actually registered yet looked identical to one still running.
  // Replaced below either way - by the real success status, or by a
  // specific failure message (not just a dismissable alert).
  targetAccountsStatusEl.textContent = `Importing ${file.name}…`;

  let list;
  let fullWorkbook = null;
  try {
    if (file.name.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(await file.text());
      // A backup from this page's own Export Target Accounts button (an
      // object keyed by targetAccounts/targetAccountsWorkbook) restores
      // exactly as exported - distinct from the legacy convert_target_
      // accounts.py output below, which is a plain array with no workbook.
      if (parsed && !Array.isArray(parsed) && (parsed.targetAccounts || parsed.targetAccountsWorkbook)) {
        const prevMeta = await getTargetAccountsMeta();
        const { count, workbookCount } = await importTargetAccountsBackup(parsed);
        await renderTargetAccountsStatus();
        flashSaved();
        appendActivityLog({
          actor: "user",
          action: "target_accounts_imported",
          label: `Restored Target Accounts backup (${count} companies${workbookCount ? `, ${workbookCount} in Explorer workbook` : ""})`,
          prevValue: prevMeta.count,
          newValue: count,
        });
        return;
      }
      // Legacy path (convert_target_accounts.py output) - no Contacts/AI
      // Initiatives/etc. to derive, so the Explorer (PRD 6.12) only gets
      // populated by a direct .xlsx import.
      list = parsed;
    } else {
      // One parse of the whole relational workbook covers both storage keys:
      // the lightweight score/label projection prioritization needs (6.11)
      // is just a re-shape of fullWorkbook.companies, so there's no need to
      // separately re-parse the Companies sheet a second time.
      fullWorkbook = await parseFullTargetAccountsWorkbook(await file.arrayBuffer());
      // Reported directly: a company with no AI Priority score (e.g. marked
      // "Out of Scope" - a competitor or AI vendor, deliberately excluded
      // from ever qualifying for the priority boost below) used to be
      // dropped from this map entirely, which also meant it could never be
      // resolved to a LinkedIn company ID or included in the Target
      // Account-scoped Post search (6.16/6.17) - losing real search
      // coverage for a reason that had nothing to do with search scoping.
      // Safe to include unconditionally: evaluateTargetAccountMatch already
      // nulls out any match whose score is null, so a score-less company
      // here still never qualifies for the P1 boost or the AI's signal-
      // weighting - this only affects things that key off "is this company
      // in the map at all," which is exactly what 6.16/6.17 need.
      list = fullWorkbook.companies
        .filter((c) => c.company && c.company.trim())
        .map((c) => ({
          company: c.company,
          industry: c.industry,
          score: c.aiPriorityScore,
          priorityLabel: c.aiPriority,
          researchStatus: c.researchStatus,
          topInitiatives: c.topAiInitiatives,
          // v0.29.37, see PRD 6.16: a Zefix (Swiss commercial registry)
          // cross-check, done outside the extension against a workbook
          // column that doesn't exist in every import - a company's own
          // researched name is used whenever this is blank.
          officialName: c.zefixOfficialName || null,
          // v0.29.42: same external cross-check, two more columns - a
          // commonly-used short/acronym name and a human/AI-verified
          // LinkedIn company-page URL (see company-resolve-extraction.js).
          alternativeName: c.alternativeCompanyName || null,
          linkedinLink: c.linkedinLink || null,
        }));
    }
  } catch (err) {
    // Reported directly, alongside the "Importing…" feedback above: reverting
    // straight to the last-successful status on failure (silently, as this
    // used to) left no visible trace that anything had gone wrong once the
    // alert was dismissed - the persistent status line now states the
    // failure and the actual reason, not just a transient popup.
    targetAccountsStatusEl.textContent = `Import failed - "${file.name}" doesn't look like a valid, uncorrupted .xlsx or .json export (${err.message}).`;
    alert(`Couldn't import that file: ${err.message}`);
    return;
  }
  if (!Array.isArray(list)) {
    targetAccountsStatusEl.textContent = `Import failed - "${file.name}" doesn't look like a Target Accounts export or backup (expected a list of companies).`;
    alert("That file doesn't look like a target-accounts export (expected a list of companies).");
    return;
  }

  const prevMeta = await getTargetAccountsMeta();
  const { count } = await importTargetAccounts(list, file.name);
  if (fullWorkbook) await importTargetAccountsWorkbook(fullWorkbook);
  await renderTargetAccountsStatus();
  flashSaved();
  appendActivityLog({
    actor: "user",
    action: "target_accounts_imported",
    label: `Imported Target Accounts list (${count} companies)${fullWorkbook ? " plus full Explorer data (Contacts, AI Initiatives, etc.)" : ""}`,
    prevValue: prevMeta.count,
    newValue: count,
  });
});

// Same download-a-json-file pattern as the side panel's Export Settings/
// Export Leads buttons, kept local here since this is the only file-download
// this page needs - not worth importing across files for one function.
exportTargetAccountsBtn.addEventListener("click", async () => {
  const data = await exportTargetAccountsBackup();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `target-accounts-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  appendActivityLog({
    actor: "user",
    action: "target_accounts_exported",
    label: `Exported Target Accounts backup (${Object.keys(data.targetAccounts || {}).length} companies, ${(data.targetAccountsWorkbook?.companies || []).length} in Explorer workbook)`,
  });
});

// EXPERIMENTAL (v0.29.25, see PRD 6.16): resolves each Target Account
// company's LinkedIn numeric company ID, needed for a future feature that
// scopes Post search to only these companies' employees (authorCompany).
const resolveCompanyIdsLimitInput = document.getElementById("resolve-company-ids-limit-input");

resolveCompanyIdsBtn.addEventListener("click", async () => {
  let toResolve = await getTargetAccountsMissingLinkedinId();
  const limit = parseInt(resolveCompanyIdsLimitInput.value, 10);
  if (Number.isFinite(limit) && limit > 0 && limit < toResolve.length) {
    toResolve = toResolve.slice(0, limit);
  }
  if (toResolve.length === 0) {
    resolveCompanyIdsStatusEl.textContent = "Nothing to do - every Target Account company already has a resolved LinkedIn company ID.";
    return;
  }
  if (!confirm(resolveConfirmText(toResolve.length))) return;

  resolveCompanyIdsBtn.disabled = true;
  stopResolveCompanyIdsBtn.hidden = false;
  stopResolveCompanyIdsBtn.disabled = false;
  stopResolveCompanyIdsBtn.textContent = "Stop";
  resolveAbortRequested = false;
  try {
    const { results: resolved, debugSamples, hardTimeoutCount, notConfidentCount, attemptedKeys, stoppedByTouchBudget } = await runCompanyIdResolution(toResolve, {
      onProgress: (i, total) => { resolveCompanyIdsStatusEl.textContent = `Resolving company ${i} of ${total}…`; },
      shouldAbort: () => resolveAbortRequested,
    });
    const updated = await applyResolvedCompanyIds(resolved);
    // v0.29.39, see PRD 6.16: marks every company this run actually
    // attempted - not just the successes applyResolvedCompanyIds already
    // knows about - as no longer "never tried," so a future run's queue
    // (getTargetAccountsMissingLinkedinId) prioritizes fresh companies over
    // retrying this same stubborn handful again immediately. attemptedKeys
    // (v0.29.45), not toResolve.map(key) - since a stopped-early run means
    // most of toResolve was never actually reached, and marking those as
    // "attempted" would wrongly deprioritize them the next time this same
    // list is built.
    await markLinkedinResolveAttempted(attemptedKeys);
    // Reported directly: the old message only ever accounted for resolved +
    // hard-timed-out, silently leaving a gap for a real third outcome (no
    // confident match found, but no error either) with no explanation -
    // every company in the run is now accounted for in this one line.
    // "Will retry" wording softened (v0.29.39): a failed company is no
    // longer guaranteed to be retried on the very next run - it's now
    // deprioritized behind every still-never-attempted company instead.
    // "stopped by you" wording added (v0.29.45) when the run ended early via
    // the Stop button - attemptedKeys.length is how many companies were
    // actually reached, distinct from toResolve.length (the full requested
    // batch) once a run can end before finishing it.
    // v0.30.0: a run can also stop itself when the shared 75/99 LinkedIn
    // touch budget is hit (touch-budget-guard.js) - distinguished from the
    // user's own Stop button so the wording says which one actually happened.
    const stoppedSuffix = stoppedByTouchBudget
      ? ` - stopped automatically, daily LinkedIn activity limit reached (${toResolve.length - attemptedKeys.length} of ${toResolve.length} never attempted this run; resume tomorrow).`
      : resolveAbortRequested
        ? ` - stopped by you (${toResolve.length - attemptedKeys.length} of ${toResolve.length} never attempted this run).`
        : ".";
    resolveCompanyIdsStatusEl.textContent = `Done - ${updated} of ${attemptedKeys.length} compan${attemptedKeys.length === 1 ? "y" : "ies"} resolved` +
      (hardTimeoutCount > 0 ? `, ${hardTimeoutCount} failed due to an error (will retry once every other company's been attempted)` : "") +
      (notConfidentCount > 0 ? `, ${notConfidentCount} found no confident match (will retry once every other company's been attempted)` : "") +
      stoppedSuffix;
    appendActivityLog({
      actor: stoppedByTouchBudget ? "extension" : "user",
      action: "company_ids_resolved",
      label: `Resolve LinkedIn Company IDs: ${updated} of ${attemptedKeys.length} resolved` +
        (hardTimeoutCount > 0 ? `, ${hardTimeoutCount} failed due to an error` : "") +
        (notConfidentCount > 0 ? `, ${notConfidentCount} found no confident match` : "") +
        (stoppedByTouchBudget ? ", stopped automatically (daily LinkedIn activity limit reached)" : resolveAbortRequested ? ", stopped early by you" : "") +
        (debugSamples.length > 0 ? ` - ${debugSamples.length} unresolved sample(s) attached for diagnosis` : ""),
      newValue: { updated, total: attemptedKeys.length, requested: toResolve.length, hardTimeoutCount, notConfidentCount, debugSamples, stoppedByUser: resolveAbortRequested, stoppedByTouchBudget },
    });
  } catch (err) {
    resolveCompanyIdsStatusEl.textContent = `Something went wrong: ${err.message}`;
    appendActivityLog({ actor: "user", action: "company_ids_resolved", label: "Resolve LinkedIn Company IDs failed", error: true, errorMessage: err.message });
  } finally {
    resolveCompanyIdsBtn.disabled = false;
    stopResolveCompanyIdsBtn.hidden = true;
    await renderLinkedinTouchStat();
  }
});

// v0.29.45: checked before starting a new company (see runCompanyIdResolution's
// own shouldAbort check), not mid-attempt - one company's own resolution is a
// few seconds, a fine granularity to wait out rather than interrupt. Disabled
// immediately so a slow in-flight company can't look like the click didn't
// register.
stopResolveCompanyIdsBtn.addEventListener("click", () => {
  resolveAbortRequested = true;
  stopResolveCompanyIdsBtn.disabled = true;
  stopResolveCompanyIdsBtn.textContent = "Stopping…";
});

targetAccountThresholdInput.addEventListener("input", () => {
  const value = Number(targetAccountThresholdInput.value);
  if (Number.isFinite(value)) {
    saveTargetAccountScoreThreshold(value);
    flashSaved();
  }
});
logOnBlur(targetAccountThresholdInput, {
  action: "target_account_threshold_changed",
  labelFor: (oldVal, newVal) => `Target Account score threshold changed (${oldVal} → ${newVal})`,
});

function renderLocationFilterModeVisibility() {
  locationFilterContinentsWrap.style.display = locationFilterModeSelect.value === "continent" ? "" : "none";
  locationFilterCountriesWrap.style.display = locationFilterModeSelect.value === "country" ? "" : "none";
}

function renderCountryLists() {
  const query = locationFilterCountriesSearch.value.trim().toLowerCase();
  const selectedSet = new Set(selectedCountries);

  locationFilterCountriesAvailable.innerHTML = "";
  for (const country of ALL_COUNTRIES) {
    if (selectedSet.has(country)) continue;
    if (query && !country.toLowerCase().includes(query)) continue;
    const option = document.createElement("option");
    option.value = country;
    option.textContent = country;
    locationFilterCountriesAvailable.appendChild(option);
  }

  locationFilterCountriesSelected.innerHTML = "";
  for (const country of [...selectedCountries].sort((a, b) => a.localeCompare(b))) {
    const option = document.createElement("option");
    option.value = country;
    option.textContent = country;
    locationFilterCountriesSelected.appendChild(option);
  }
  locationFilterCountriesCountEl.textContent = String(selectedCountries.length);
  renderCountriesSaveState();
}

function countriesAreDirty() {
  if (selectedCountries.length !== savedCountriesSnapshot.length) return true;
  const saved = new Set(savedCountriesSnapshot);
  return selectedCountries.some((c) => !saved.has(c));
}

function renderCountriesSaveState() {
  const dirty = countriesAreDirty();
  locationFilterCountriesSaveBtn.disabled = !dirty;
  locationFilterCountriesSaveStatusEl.textContent = dirty ? "Unsaved changes." : "";
}

async function saveLocationFilterFromForm({ action, label, prevValue }) {
  const config = {
    mode: locationFilterModeSelect.value,
    continents: Array.from(document.querySelectorAll(".location-continent-checkbox:checked")).map((cb) => cb.value),
    countries: [...selectedCountries],
  };
  await saveLocationFilterConfig(config);
  flashSaved();
  if (action) appendActivityLog({ actor: "user", action, label, prevValue, newValue: config });
  // The Prioritization Rules table's own "Location Filter" row shows
  // whether mode !== "off" - keep it in sync even when the mode changes via
  // this form rather than that row's own checkbox.
  await renderPrioritizationRules();
  return config;
}

locationFilterModeSelect.addEventListener("change", async () => {
  const prevValue = locationFilterModeSelect.dataset.prevValue || "off";
  renderLocationFilterModeVisibility();
  await saveLocationFilterFromForm({
    action: "location_filter_mode_changed",
    label: `Location Filter mode changed to "${locationFilterModeSelect.value}"`,
    prevValue,
  });
  locationFilterModeSelect.dataset.prevValue = locationFilterModeSelect.value;
});

for (const checkbox of document.querySelectorAll(".location-continent-checkbox")) {
  checkbox.addEventListener("change", async () => {
    const config = await saveLocationFilterFromForm({});
    appendActivityLog({
      actor: "user",
      action: "location_filter_continents_changed",
      label: `Location Filter continents changed (${config.continents.map((c) => CONTINENT_LABELS[c]).join(", ") || "none"})`,
      newValue: config.continents,
    });
  });
}

function addSelectedCountries(countries) {
  const toAdd = countries.filter((c) => !selectedCountries.includes(c));
  if (toAdd.length === 0) return;
  selectedCountries = [...selectedCountries, ...toAdd];
  renderCountryLists();
}

function removeSelectedCountries(countries) {
  const before = selectedCountries.length;
  const toRemove = new Set(countries);
  selectedCountries = selectedCountries.filter((c) => !toRemove.has(c));
  if (selectedCountries.length === before) return;
  renderCountryLists();
}

locationFilterCountriesSearch.addEventListener("input", renderCountryLists);

locationFilterCountryAddBtn.addEventListener("click", () => {
  addSelectedCountries(Array.from(locationFilterCountriesAvailable.selectedOptions).map((o) => o.value));
});
locationFilterCountryRemoveBtn.addEventListener("click", () => {
  removeSelectedCountries(Array.from(locationFilterCountriesSelected.selectedOptions).map((o) => o.value));
});
locationFilterCountriesAvailable.addEventListener("dblclick", (e) => {
  if (e.target.tagName === "OPTION") addSelectedCountries([e.target.value]);
});
locationFilterCountriesSelected.addEventListener("dblclick", (e) => {
  if (e.target.tagName === "OPTION") removeSelectedCountries([e.target.value]);
});

locationFilterCountriesSaveBtn.addEventListener("click", async () => {
  const before = savedCountriesSnapshot.length;
  const config = await saveLocationFilterFromForm({
    action: "location_filter_countries_changed",
    label: `Location Filter countries changed (${before} → ${selectedCountries.length} countries)`,
    prevValue: savedCountriesSnapshot,
  });
  savedCountriesSnapshot = [...config.countries];
  renderCountriesSaveState();
  locationFilterCountriesSaveStatusEl.textContent = "Saved.";
});

applyLocationFilterBtn.addEventListener("click", async () => {
  applyLocationFilterBtn.disabled = true;
  try {
    const { blockedCount, restoredCount } = await reapplyLocationFilter();
    if (blockedCount === 0 && restoredCount === 0) {
      applyLocationFilterStatusEl.textContent = "Done - no leads needed to change.";
    } else {
      const parts = [];
      if (blockedCount > 0) parts.push(`${blockedCount} lead${blockedCount === 1 ? "" : "s"} newly marked Irrelevant`);
      if (restoredCount > 0) parts.push(`${restoredCount} lead${restoredCount === 1 ? "" : "s"} restored to New`);
      applyLocationFilterStatusEl.textContent = `Done - ${parts.join(", ")}.`;
    }
    appendActivityLog({
      actor: "user", action: "location_filter_applied",
      label: `Applied Location Filter: ${blockedCount} marked Irrelevant, ${restoredCount} restored to New`,
      newValue: { blockedCount, restoredCount },
    });
  } finally {
    applyLocationFilterBtn.disabled = false;
  }
});

// Short display names for storage.js's PRIORITIZATION_RULE_CATALOG ids -
// the catalog's own `id` is a stable key, not meant as UI text.
const PRIORITIZATION_RULE_LABELS = {
  job_company_cap: "Job company cap",
  post_title_match: "Post title match",
  post_topic_match: "Post topic match",
  post_company_floor: "Post company floor",
  job_signal_ceiling: "Job signal ceiling",
};

function ruleValueCell(rule) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = "5";
  input.value = rule.value;
  input.title = `${rule.type === "decisive" ? "Decisive" : rule.type === "floor" ? "Floor" : "Ceiling"} value for this rule`;
  input.addEventListener("change", async () => {
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      input.value = rule.value;
      return;
    }
    const prevValue = rule.value;
    rule.value = value;
    await savePrioritizationRuleOverride(rule.id, { value });
    flashSaved();
    appendActivityLog({
      actor: "user",
      action: "prioritization_rule_value_changed",
      label: `Prioritization rule "${PRIORITIZATION_RULE_LABELS[rule.id] || rule.id}" value changed`,
      prevValue,
      newValue: value,
    });
  });
  td.appendChild(input);
  return td;
}

function emptyValueCell() {
  const td = document.createElement("td");
  td.className = "rule-value-empty";
  td.textContent = "—";
  return td;
}

// Builds a row for a rule that isn't part of PRIORITIZATION_RULE_CATALOG -
// it doesn't set a P-level, it excludes a lead to Irrelevant outright - but
// the user explicitly asked these show up here too, for the same
// transparency/toggle-in-one-place reason, since they equally override
// whatever the Sales Mentor would have said.
function exclusionRuleRow({ name, description, enabled, onToggle }) {
  const tr = document.createElement("tr");

  const nameTd = document.createElement("td");
  nameTd.textContent = name;

  const descTd = document.createElement("td");
  descTd.className = "rule-description";
  descTd.textContent = description;

  const enabledTd = document.createElement("td");
  const enabledCheckbox = document.createElement("input");
  enabledCheckbox.type = "checkbox";
  enabledCheckbox.checked = enabled;
  enabledCheckbox.title = "Disable to let the Sales Mentor decide these leads entirely on its own";
  enabledCheckbox.addEventListener("change", () => onToggle(enabledCheckbox.checked));
  enabledTd.appendChild(enabledCheckbox);

  tr.append(nameTd, descTd, emptyValueCell(), emptyValueCell(), emptyValueCell(), enabledTd);
  return tr;
}

async function renderPrioritizationRules() {
  const rules = await getPrioritizationRules();
  prioritizationRulesTbodyEl.innerHTML = "";
  for (const rule of rules) {
    const tr = document.createElement("tr");

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
    enabledCheckbox.checked = rule.enabled;
    enabledCheckbox.title = "Disable to let the Sales Mentor decide these leads entirely on its own";
    enabledCheckbox.addEventListener("change", async () => {
      const wasEnabled = rule.enabled;
      rule.enabled = enabledCheckbox.checked;
      await savePrioritizationRuleOverride(rule.id, { enabled: enabledCheckbox.checked });
      flashSaved();
      appendActivityLog({
        actor: "user",
        action: "prioritization_rule_toggled",
        label: `Prioritization rule "${PRIORITIZATION_RULE_LABELS[rule.id] || rule.id}" ${enabledCheckbox.checked ? "enabled" : "disabled"}`,
        prevValue: wasEnabled,
        newValue: enabledCheckbox.checked,
      });
    });
    enabledTd.appendChild(enabledCheckbox);

    tr.append(nameTd, descTd, ceilingTd, floorTd, decisiveTd, enabledTd);
    prioritizationRulesTbodyEl.appendChild(tr);
  }

  const competitorTopic = negativeTopics.find((t) => t.id === "builtin-competitors");
  if (competitorTopic) {
    prioritizationRulesTbodyEl.appendChild(exclusionRuleRow({
      name: "Competitor Blocklist",
      description: `A lead whose company or content matches the Competitor Blocklist (in the side panel's Negative Topics) is marked Irrelevant outright - it's not a buyer. Currently: ${competitorTopic.keywords.join(", ")}.`,
      enabled: competitorTopic.enabled,
      onToggle: async (checked) => {
        const wasEnabled = competitorTopic.enabled;
        competitorTopic.enabled = checked;
        await saveNegativeTopics(negativeTopics);
        flashSaved();
        appendActivityLog({
          actor: "user",
          action: "prioritization_rule_toggled",
          label: `Prioritization rule "Competitor Blocklist" ${checked ? "enabled" : "disabled"}`,
          prevValue: wasEnabled,
          newValue: checked,
        });
      },
    }));
  }

  const locationConfig = await getLocationFilterConfig();
  prioritizationRulesTbodyEl.appendChild(exclusionRuleRow({
    name: "Location Filter",
    description: "A lead whose location is confidently classified outside your configured target geography (above) is marked Irrelevant outright. A lead with no location data, or unclassifiable text, is never touched.",
    enabled: locationConfig.mode !== "off",
    onToggle: async (checked) => {
      const wasOn = locationConfig.mode !== "off";
      if (!checked) {
        locationConfig.mode = "off";
      } else {
        locationConfig.mode = locationFilterModeSelect.value !== "off" ? locationFilterModeSelect.value : "continent";
      }
      await saveLocationFilterConfig(locationConfig);
      flashSaved();
      locationFilterModeSelect.value = locationConfig.mode;
      renderLocationFilterModeVisibility();
      appendActivityLog({
        actor: "user",
        action: "prioritization_rule_toggled",
        label: `Prioritization rule "Location Filter" ${checked ? "enabled" : "disabled"}`,
        prevValue: wasOn,
        newValue: checked,
      });
    },
  }));
}

// See sidepanel.js's own copy of this function for the full reasoning
// (LinkedIn's "unusual activity" warning after a day of concentrated
// testing, ~315 automated visits reconstructed after the fact) - shown here
// too since the company-ID resolver (this page's own biggest single
// contributor to that day's total) can be run from Settings without the
// side panel ever being open.
async function renderLinkedinTouchStat() {
  const el = document.getElementById("linkedin-touch-stat");
  const { last24h, last7d, level } = await getLinkedinTouchStats();
  el.textContent = `LinkedIn touches (automated): ${last24h} in the last 24h · ${last7d} in the last 7 days`;
  el.classList.toggle("linkedin-touch-stat-warn", level === "warn");
  el.classList.toggle("linkedin-touch-stat-danger", level === "danger");
}

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;

  await renderLinkedinTouchStat();
  setInterval(renderLinkedinTouchStat, 30000);

  outputLanguageSelect.value = await getOutputLanguage();
  outputLanguageSelect.dataset.prevValue = outputLanguageSelect.value;
  companyContextInput.value = await getCompanyContext();
  idealCustomerProfileInput.value = await getIdealCustomerProfile();
  anthropicApiKeyInput.value = await getAnthropicApiKey();

  messageTemplates = await getMessageTemplates();
  renderMessageTemplates();

  valueAddOffersInput.value = (await getValueAddOffers()).join("\n");

  targetAccountThresholdInput.value = await getTargetAccountScoreThreshold();
  await renderTargetAccountsStatus();

  negativeTopics = await getNegativeTopics();

  const locationConfig = await getLocationFilterConfig();
  locationFilterModeSelect.value = locationConfig.mode;
  locationFilterModeSelect.dataset.prevValue = locationConfig.mode;
  for (const checkbox of document.querySelectorAll(".location-continent-checkbox")) {
    checkbox.checked = locationConfig.continents.includes(checkbox.value);
  }
  selectedCountries = [...locationConfig.countries];
  savedCountriesSnapshot = [...locationConfig.countries];
  renderCountryLists();
  renderLocationFilterModeVisibility();

  await renderPrioritizationRules();
}

init();
