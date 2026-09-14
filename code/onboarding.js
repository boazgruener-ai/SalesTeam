// Onboarding wizard (PRD 6.20 Phase 1/2) - a linear, numbered explain -> enter
// -> confirm flow that captures targetUniverseConfig, targetContactProfile,
// accountPriorityGuidelines, and competitorCompanySlugs (storage.js), plus
// reuses the existing companyContext/idealCustomerProfile fields. Discovery
// scanning itself (Phase 5/6) isn't built yet - this page only ever collects
// and saves the targeting profile those future phases will read.
import {
  getTargetUniverseConfig, saveTargetUniverseConfig,
  getTargetContactProfile, saveTargetContactProfile,
  getAccountPriorityGuidelines, saveAccountPriorityGuidelines,
  getCompetitorCompanySlugs, saveCompetitorCompanySlugs,
  getRecruiterCompanySlugs, saveRecruiterCompanySlugs, DEFAULT_RECRUITER_COMPANY_SLUGS,
  getCompanyContext, saveCompanyContext,
  getIdealCustomerProfile, saveIdealCustomerProfile,
  getCompanyWebsite, saveCompanyWebsite,
  markOnboardingCompleted,
  getOnboardingProgressStepIndex, saveOnboardingProgressStepIndex,
  parseLinkedinCompanySlug,
  CONTINENT_LABELS,
} from "./storage.js";
import { mountLocationPicker } from "./location-picker.js";
import { CONFIRMED_COUNTRIES } from "./geo-urn-map.js";
import { CONFIRMED_INDUSTRIES } from "./industry-id-map.js";

const STEP_ORDER = ["location", "size", "industry", "priority", "company-context", "icp", "contacts", "competitors", "recruiters", "finish"];
const STEP_TITLES = {
  location: "Location", size: "Size", industry: "Industry", priority: "Priority guidelines",
  "company-context": "What you sell", icp: "Ideal customer", contacts: "Target contacts",
  competitors: "Competitors to exclude", recruiters: "Recruiters to exclude",
};

// Working copies, seeded from storage in init() and mutated in place as each
// step is validated. Persisted both on Confirm (the normal advance path)
// and continuously while a step is open but not yet confirmed (see
// scheduleAutoSave below) - a real completed run can take "tens of minutes
// to several hours," so a step's in-progress content shouldn't be lost to
// an accidental tab close before Confirm is clicked.
let targetUniverseConfig;
let accountPriorityGuidelines;
let targetContactProfile;
let competitorCompanySlugs = [];
let recruiterCompanySlugs = [];

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

function showStep(index) {
  currentStepIndex = index;
  const step = STEP_ORDER[index];
  for (const s of STEP_ORDER) {
    const sectionEl = el(`enter-${s}`);
    if (sectionEl) sectionEl.hidden = s !== step;
  }
  el("confirm-view").hidden = true;
  el("step-progress").textContent = step === "finish" ? "" : `Step ${index + 1} of ${STEP_ORDER.length - 1}`;
  if (step === "priority") renderPriorityStepOptions();
  if (step === "finish") renderFinishSummary();

  const backBtn = document.querySelector(`#enter-${step} .step-back-btn`);
  if (backBtn) backBtn.hidden = index === 0;

  // Reported directly: a real completed run took "tens of minutes to
  // several hours" - remembering the furthest step reached (not just which
  // steps were formally confirmed, and not regressed by using Back to
  // revisit an earlier one) means reopening this page after an accidental
  // close lands back where the user actually was, not at step 1.
  if (index > furthestStepIndex) {
    furthestStepIndex = index;
    saveOnboardingProgressStepIndex(furthestStepIndex);
  }
}

document.querySelectorAll(".step-back-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (currentStepIndex > 0) showStep(currentStepIndex - 1);
  });
});

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
  return { valid: true };
}

function validateSizeStep() {
  const maxCompanies = Number(el("size-max-companies-input").value);
  if (!Number.isInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > 500) {
    return { valid: false, error: "Maximum companies must be a whole number between 1 and 500." };
  }
  const mode = el("size-mode-select").value;
  if (mode === "topN") {
    const topN = Number(el("size-topn-input").value);
    if (!Number.isInteger(topN) || topN < 1) return { valid: false, error: "Enter a valid Top N." };
    targetUniverseConfig.sizeMode = "topN";
    targetUniverseConfig.topN = topN;
    targetUniverseConfig.minEmployees = null;
    targetUniverseConfig.maxEmployees = null;
  } else {
    const minRaw = el("size-min-input").value;
    const maxRaw = el("size-max-input").value;
    const min = minRaw ? Number(minRaw) : null;
    const max = maxRaw ? Number(maxRaw) : null;
    if (min === null && max === null) return { valid: false, error: "Enter a minimum, a maximum, or both." };
    if (min !== null && max !== null && min > max) return { valid: false, error: "Minimum can't be greater than maximum." };
    targetUniverseConfig.sizeMode = "range";
    targetUniverseConfig.minEmployees = min;
    targetUniverseConfig.maxEmployees = max;
    targetUniverseConfig.topN = null;
  }
  targetUniverseConfig.maxCompanies = maxCompanies;
  return { valid: true };
}

function validateIndustryStep() {
  targetUniverseConfig.industries = Array.from(el("industry-checkbox-wrap").querySelectorAll("input:checked")).map((cb) => cb.value);
  return { valid: true };
}

// Static list (unlike Priority's dynamic checkboxes below, which depend on
// earlier steps) - built once at init(), not on every showStep().
function renderIndustryCheckboxes(selected) {
  const wrap = el("industry-checkbox-wrap");
  wrap.innerHTML = "";
  for (const industry of CONFIRMED_INDUSTRIES) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = industry;
    checkbox.checked = selected.includes(industry);
    label.append(checkbox, document.createTextNode(" " + industry));
    wrap.appendChild(label);
  }
}

function validatePriorityStep() {
  const order = ["priority-rank-1", "priority-rank-2", "priority-rank-3"].map((id) => el(id).value);
  if (new Set(order).size !== 3) return { valid: false, error: "Each rank must be a different criterion." };
  const topLocations = Array.from(el("priority-top-locations-wrap").querySelectorAll("input:checked")).map((cb) => cb.value);
  const topIndustries = Array.from(el("priority-top-industries-wrap").querySelectorAll("input:checked")).map((cb) => cb.value);
  if (topLocations.length > 3) return { valid: false, error: "Choose at most 3 top locations." };
  if (topIndustries.length > 2) return { valid: false, error: "Choose at most 2 top industries." };
  accountPriorityGuidelines.criteriaOrder = order;
  accountPriorityGuidelines.topSize = el("priority-top-size").value || null;
  accountPriorityGuidelines.topLocations = topLocations;
  accountPriorityGuidelines.topIndustries = topIndustries;
  return { valid: true };
}

function validateAlwaysStep() {
  return { valid: true };
}

function validateContactsStep() {
  const exactTitles = el("contacts-exact-titles-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  const titleKeywords = el("contacts-title-keywords-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (exactTitles.length === 0 && titleKeywords.length === 0) {
    return { valid: false, error: "Enter at least one exact title or title keyword." };
  }
  targetContactProfile.exactTitles = exactTitles;
  targetContactProfile.titleKeywords = titleKeywords;
  return { valid: true };
}

function validateCompetitorsStep() {
  competitorCompanySlugs = parseCompetitorLines(el("competitors-input").value);
  return { valid: true };
}

function validateRecruitersStep() {
  recruiterCompanySlugs = parseCompetitorLines(el("recruiters-input").value);
  return { valid: true };
}

const STEP_VALIDATORS = {
  location: validateLocationStep,
  size: validateSizeStep,
  industry: validateIndustryStep,
  priority: validatePriorityStep,
  "company-context": validateAlwaysStep,
  icp: validateAlwaysStep,
  contacts: validateContactsStep,
  competitors: validateCompetitorsStep,
  recruiters: validateRecruitersStep,
};

// ---------------------------------------------------------------------
// Per-step persistence (only ever called from the Confirm button).

async function persistStep(step) {
  switch (step) {
    case "location":
    case "size":
    case "industry":
      await saveTargetUniverseConfig(targetUniverseConfig);
      break;
    case "priority":
      await saveAccountPriorityGuidelines(accountPriorityGuidelines);
      break;
    case "company-context":
      await saveCompanyContext(el("company-context-input").value);
      await saveCompanyWebsite(el("company-website-input").value);
      break;
    case "icp":
      await saveIdealCustomerProfile(el("icp-input").value);
      break;
    case "contacts":
      await saveTargetContactProfile(targetContactProfile);
      break;
    case "competitors":
      await saveCompetitorCompanySlugs(competitorCompanySlugs);
      break;
    case "recruiters":
      await saveRecruiterCompanySlugs(recruiterCompanySlugs);
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
      break;
    }
    case "size": {
      const c = targetUniverseConfig;
      const sizeText = c.sizeMode === "topN"
        ? `the top ${c.topN} largest`
        : `companies with ${c.minEmployees ?? "any"}–${c.maxEmployees ?? "any"} employees`;
      appendPara(container, "Targeting ", { strong: sizeText }, `, up to `, { strong: String(c.maxCompanies) }, ` companies per Discovery run.`);
      break;
    }
    case "industry": {
      const industries = targetUniverseConfig.industries;
      if (industries.length) appendPara(container, "Industries: ", { strong: industries.join(", ") }, ".");
      else appendPara(container, "No industry restriction.");
      break;
    }
    case "priority": {
      const g = accountPriorityGuidelines;
      const orderLabels = { size: "Size", location: "Location", industry: "Industry" };
      appendPara(container, "Priority order: ", { strong: g.criteriaOrder.map((k) => orderLabels[k]).join(" > ") }, ".");
      if (g.topSize) appendPara(container, "Top size: ", { strong: g.topSize }, ".");
      if (g.topLocations.length) appendPara(container, "Top location(s): ", { strong: g.topLocations.map(formatLocationValue).join(", ") }, ".");
      if (g.topIndustries.length) appendPara(container, "Top industries: ", { strong: g.topIndustries.join(", ") }, ".");
      break;
    }
    case "company-context": {
      const value = el("company-context-input").value.trim();
      appendPara(container, value || "(left blank)");
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
      break;
    }
    case "competitors": {
      if (competitorCompanySlugs.length) {
        appendPara(container, `Excluding ${competitorCompanySlugs.length} competitor${competitorCompanySlugs.length === 1 ? "" : "s"}: `, { strong: competitorCompanySlugs.join(", ") }, ".");
      } else {
        appendPara(container, "No competitors to exclude.");
      }
      break;
    }
    case "recruiters": {
      if (recruiterCompanySlugs.length) {
        appendPara(container, `Excluding ${recruiterCompanySlugs.length} recruiter${recruiterCompanySlugs.length === 1 ? "" : "s"}/agenc${recruiterCompanySlugs.length === 1 ? "y" : "ies"}: `, { strong: recruiterCompanySlugs.join(", ") }, ".");
      } else {
        appendPara(container, "No recruiters/staffing agencies to exclude.");
      }
      break;
    }
  }
}

function showConfirm(step) {
  el(`enter-${step}`).hidden = true;
  const confirmView = el("confirm-view");
  confirmView.hidden = false;
  renderSummaryInto(step, el("confirm-summary"));

  el("confirm-change-btn").onclick = () => {
    confirmView.hidden = true;
    el(`enter-${step}`).hidden = false;
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

document.querySelectorAll(".step-next-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const step = btn.dataset.step;
    clearStepError(step);
    const { valid, error } = STEP_VALIDATORS[step]();
    if (!valid) {
      showStepError(step, error);
      return;
    }
    showConfirm(step);
  });
});

// ---------------------------------------------------------------------
// Step 1: Location - mounted once at init() with CONFIRMED_COUNTRIES
// (geo-urn-map.js), not the full ALL_COUNTRIES list Settings' Location
// Filter uses - see geo-urn-map.js for why.

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

  el("priority-top-size").value = accountPriorityGuidelines.topSize || "";

  const locWrap = el("priority-top-locations-wrap");
  locWrap.innerHTML = "";
  const locationValues = targetUniverseConfig.locationMode === "continent"
    ? targetUniverseConfig.continents
    : targetUniverseConfig.countries;
  for (const value of locationValues) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = value;
    checkbox.checked = accountPriorityGuidelines.topLocations.includes(value);
    label.append(checkbox, document.createTextNode(" " + formatLocationValue(value)));
    locWrap.appendChild(label);
  }

  const indWrap = el("priority-top-industries-wrap");
  indWrap.innerHTML = "";
  const industries = targetUniverseConfig.industries;
  el("priority-top-industries-empty").hidden = industries.length > 0;
  for (const industry of industries) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = industry;
    checkbox.checked = accountPriorityGuidelines.topIndustries.includes(industry);
    label.append(checkbox, document.createTextNode(" " + industry));
    indWrap.appendChild(label);
  }
}

// ---------------------------------------------------------------------
// Step 2: Size mode toggling

el("size-mode-select").addEventListener("change", () => {
  const mode = el("size-mode-select").value;
  el("size-topn-wrap").hidden = mode !== "topN";
  el("size-range-wrap").hidden = mode !== "range";
});

// ---------------------------------------------------------------------
// Step 8: Competitors - live per-line parse feedback as the user types,
// separate from (and not a substitute for) the Next-button validation
// above, which just re-derives the same parsed list on submit.

function parseCompetitorLines(rawValue) {
  return rawValue.split("\n").map((l) => l.trim()).filter(Boolean).map(parseLinkedinCompanySlug).filter(Boolean);
}

function renderCompetitorsParsedList() {
  const lines = el("competitors-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  const listEl = el("competitors-parsed-list");
  listEl.innerHTML = "";
  for (const line of lines) {
    const slug = parseLinkedinCompanySlug(line);
    const row = document.createElement("div");
    row.className = slug ? "competitor-line-ok" : "competitor-line-bad";
    row.textContent = slug ? `✓ ${slug}` : `✗ couldn't find a LinkedIn company page in "${line}"`;
    listEl.appendChild(row);
  }
}

el("competitors-input").addEventListener("input", renderCompetitorsParsedList);

// ---------------------------------------------------------------------
// Step 9: Recruiters/staffing agencies - identical mechanics to Competitors
// above (reuses parseCompetitorLines directly, not a copy).

function renderRecruitersParsedList() {
  const lines = el("recruiters-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  const listEl = el("recruiters-parsed-list");
  listEl.innerHTML = "";
  for (const line of lines) {
    const slug = parseLinkedinCompanySlug(line);
    const row = document.createElement("div");
    row.className = slug ? "competitor-line-ok" : "competitor-line-bad";
    row.textContent = slug ? `✓ ${slug}` : `✗ couldn't find a LinkedIn company page in "${line}"`;
    listEl.appendChild(row);
  }
}

el("recruiters-input").addEventListener("input", renderRecruitersParsedList);

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

el("finish-btn").addEventListener("click", async () => {
  await markOnboardingCompleted();
  const btn = el("finish-btn");
  btn.textContent = "✓ Setup saved";
  btn.disabled = true;
});

// ---------------------------------------------------------------------

async function init() {
  el("version-text").textContent = `v${chrome.runtime.getManifest().version}`;

  targetUniverseConfig = await getTargetUniverseConfig();
  accountPriorityGuidelines = await getAccountPriorityGuidelines();
  targetContactProfile = await getTargetContactProfile();
  competitorCompanySlugs = await getCompetitorCompanySlugs();
  // null (never saved, distinct from an intentionally-emptied []) means
  // this is the first time this step has been reached - seed it with the
  // well-known global agencies so the user only has to add local ones.
  const savedRecruiterSlugs = await getRecruiterCompanySlugs();
  recruiterCompanySlugs = savedRecruiterSlugs === null ? DEFAULT_RECRUITER_COMPANY_SLUGS : savedRecruiterSlugs;

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
    CONFIRMED_COUNTRIES,
    // The dual-listbox's add/remove buttons move <option> elements
    // programmatically, which fires neither a native "change" nor "input"
    // event on anything - the delegated auto-save listener below would
    // never see it, so this step's own picker changes need their own
    // explicit hook into the same auto-save.
    { onCountriesChange: scheduleAutoSave, onModeOrContinentChange: scheduleAutoSave },
  );
  locationPicker.setValue({
    mode: targetUniverseConfig.locationMode === "off" ? "country" : targetUniverseConfig.locationMode,
    continents: targetUniverseConfig.continents,
    countries: targetUniverseConfig.countries,
  });
  renderLocationModeVisibility();
  el("location-mode-select").addEventListener("change", renderLocationModeVisibility);

  if (targetUniverseConfig.sizeMode === "range") {
    el("size-mode-select").value = "range";
    el("size-min-input").value = targetUniverseConfig.minEmployees ?? "";
    el("size-max-input").value = targetUniverseConfig.maxEmployees ?? "";
    el("size-topn-wrap").hidden = true;
    el("size-range-wrap").hidden = false;
  } else {
    el("size-topn-input").value = targetUniverseConfig.topN ?? 200;
  }
  el("size-max-companies-input").value = targetUniverseConfig.maxCompanies;

  renderIndustryCheckboxes(targetUniverseConfig.industries);
  el("company-context-input").value = await getCompanyContext();
  el("company-website-input").value = await getCompanyWebsite();
  el("icp-input").value = await getIdealCustomerProfile();
  el("contacts-exact-titles-input").value = targetContactProfile.exactTitles.join("\n");
  el("contacts-title-keywords-input").value = targetContactProfile.titleKeywords.join("\n");
  el("competitors-input").value = competitorCompanySlugs.map((slug) => `https://www.linkedin.com/company/${slug}/`).join("\n");
  renderCompetitorsParsedList();
  el("recruiters-input").value = recruiterCompanySlugs.map((slug) => `https://www.linkedin.com/company/${slug}/`).join("\n");
  renderRecruitersParsedList();

  // Resume where a previous session left off, not always step 1 - see
  // showStep()'s own comment for why this matters for a run that can take
  // "tens of minutes to several hours." Bounded to a valid index in case
  // STEP_ORDER's length ever changes between visits.
  const savedStepIndex = await getOnboardingProgressStepIndex();
  furthestStepIndex = 0;
  showStep(Math.min(Math.max(savedStepIndex, 0), STEP_ORDER.length - 1));
}

init();
