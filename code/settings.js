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

let messageTemplates = [];

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
  await renderPrioritizationRules();
}

init();
