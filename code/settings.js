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
  getPrioritizationRules,
  savePrioritizationRuleOverride,
  appendActivityLog,
  getNegativeTopics,
  saveNegativeTopics,
  getLocationFilterConfig,
  saveLocationFilterConfig,
  reapplyLocationFilter,
  CONTINENT_LABELS,
} from "./storage.js";
import { sanitizeApiKey } from "./agent-shared.js";
import { parseFullTargetAccountsWorkbook } from "./xlsx-lite.js";

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

const outputLanguageSelect = document.getElementById("output-language-select");
const companyContextInput = document.getElementById("company-context-input");
const idealCustomerProfileInput = document.getElementById("ideal-customer-profile-input");
const anthropicApiKeyInput = document.getElementById("anthropic-api-key-input");
const messageTemplatesListEl = document.getElementById("message-templates-list");
const valueAddOffersInput = document.getElementById("value-add-offers-input");
const targetAccountsStatusEl = document.getElementById("target-accounts-status");
const importTargetAccountsBtn = document.getElementById("import-target-accounts-btn");
const importTargetAccountsFileInput = document.getElementById("import-target-accounts-file-input");
const targetAccountThresholdInput = document.getElementById("target-account-threshold-input");
const prioritizationRulesTbodyEl = document.getElementById("prioritization-rules-tbody");
const locationFilterModeSelect = document.getElementById("location-filter-mode-select");
const locationFilterContinentsWrap = document.getElementById("location-filter-continents-wrap");
const locationFilterCountriesWrap = document.getElementById("location-filter-countries-wrap");
const locationFilterCountriesInput = document.getElementById("location-filter-countries-input");
const applyLocationFilterBtn = document.getElementById("apply-location-filter-btn");
const applyLocationFilterStatusEl = document.getElementById("apply-location-filter-status");

let messageTemplates = [];
let negativeTopics = [];

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
    });
    logOnBlur(textarea, { action: "message_template_changed", labelFor: () => `Message Template "${template.name}" changed` });
    wrap.append(label, textarea);
    messageTemplatesListEl.appendChild(wrap);
  }
}

outputLanguageSelect.addEventListener("change", () => {
  const prevValue = outputLanguageSelect.dataset.prevValue || null;
  saveOutputLanguage(outputLanguageSelect.value);
  appendActivityLog({ actor: "user", action: "output_language_changed", label: `Output language changed to "${outputLanguageSelect.value}"`, prevValue, newValue: outputLanguageSelect.value });
  outputLanguageSelect.dataset.prevValue = outputLanguageSelect.value;
});

companyContextInput.addEventListener("input", () => {
  saveCompanyContext(companyContextInput.value);
});
logOnBlur(companyContextInput, { action: "company_context_changed", labelFor: () => "Company Context (\"What We Offer\") changed" });

idealCustomerProfileInput.addEventListener("input", () => {
  saveIdealCustomerProfile(idealCustomerProfileInput.value);
});
logOnBlur(idealCustomerProfileInput, { action: "ideal_customer_profile_changed", labelFor: () => "Ideal Customer Profile changed" });

valueAddOffersInput.addEventListener("input", () => {
  const offers = valueAddOffersInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  saveValueAddOffers(offers);
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

function formatImportedAt(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function renderTargetAccountsStatus() {
  const { count, importedAt } = await getTargetAccountsMeta();
  targetAccountsStatusEl.textContent = count > 0
    ? `${count} companies imported · ${formatImportedAt(importedAt)}`
    : "No target accounts imported yet.";
}

importTargetAccountsBtn.addEventListener("click", () => {
  importTargetAccountsFileInput.click();
});

importTargetAccountsFileInput.addEventListener("change", async () => {
  const file = importTargetAccountsFileInput.files[0];
  importTargetAccountsFileInput.value = "";
  if (!file) return;

  let list;
  let fullWorkbook = null;
  try {
    if (file.name.toLowerCase().endsWith(".json")) {
      // Legacy path (convert_target_accounts.py output) - no Contacts/AI
      // Initiatives/etc. to derive, so the Explorer (PRD 6.12) only gets
      // populated by a direct .xlsx import.
      list = JSON.parse(await file.text());
    } else {
      // One parse of the whole relational workbook covers both storage keys:
      // the lightweight score/label projection prioritization needs (6.11)
      // is just a re-shape of fullWorkbook.companies, so there's no need to
      // separately re-parse the Companies sheet a second time.
      fullWorkbook = await parseFullTargetAccountsWorkbook(await file.arrayBuffer());
      list = fullWorkbook.companies
        .filter((c) => c.aiPriorityScore != null)
        .map((c) => ({
          company: c.company,
          industry: c.industry,
          score: c.aiPriorityScore,
          priorityLabel: c.aiPriority,
          researchStatus: c.researchStatus,
          topInitiatives: c.topAiInitiatives,
        }));
    }
  } catch (err) {
    alert(`Couldn't import that file: ${err.message}`);
    return;
  }
  if (!Array.isArray(list)) {
    alert("That file doesn't look like a target-accounts export (expected a list of companies).");
    return;
  }

  const prevMeta = await getTargetAccountsMeta();
  const { count } = await importTargetAccounts(list);
  if (fullWorkbook) await importTargetAccountsWorkbook(fullWorkbook);
  await renderTargetAccountsStatus();
  appendActivityLog({
    actor: "user",
    action: "target_accounts_imported",
    label: `Imported Target Accounts list (${count} companies)${fullWorkbook ? " plus full Explorer data (Contacts, AI Initiatives, etc.)" : ""}`,
    prevValue: prevMeta.count,
    newValue: count,
  });
});

targetAccountThresholdInput.addEventListener("input", () => {
  const value = Number(targetAccountThresholdInput.value);
  if (Number.isFinite(value)) saveTargetAccountScoreThreshold(value);
});
logOnBlur(targetAccountThresholdInput, {
  action: "target_account_threshold_changed",
  labelFor: (oldVal, newVal) => `Target Account score threshold changed (${oldVal} → ${newVal})`,
});

function renderLocationFilterModeVisibility() {
  locationFilterContinentsWrap.style.display = locationFilterModeSelect.value === "continent" ? "" : "none";
  locationFilterCountriesWrap.style.display = locationFilterModeSelect.value === "country" ? "" : "none";
}

async function saveLocationFilterFromForm({ action, label, prevValue }) {
  const config = {
    mode: locationFilterModeSelect.value,
    continents: Array.from(document.querySelectorAll(".location-continent-checkbox:checked")).map((cb) => cb.value),
    countries: locationFilterCountriesInput.value.split("\n").map((line) => line.trim()).filter(Boolean),
  };
  await saveLocationFilterConfig(config);
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

locationFilterCountriesInput.addEventListener("input", () => {
  saveLocationFilterFromForm({});
});
logOnBlur(locationFilterCountriesInput, {
  action: "location_filter_countries_changed",
  labelFor: (oldVal, newVal) => {
    const oldCount = oldVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
    const newCount = newVal.split("\n").map((l) => l.trim()).filter(Boolean).length;
    return `Location Filter countries changed (${oldCount} → ${newCount} countries)`;
  },
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

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;

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
  locationFilterCountriesInput.value = locationConfig.countries.join("\n");
  renderLocationFilterModeVisibility();

  await renderPrioritizationRules();
}

init();
