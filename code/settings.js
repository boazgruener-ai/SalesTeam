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
  appendActivityLog,
} from "./storage.js";
import { sanitizeApiKey } from "./agent-shared.js";
import { parseTargetAccountsWorkbook } from "./xlsx-lite.js";

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
  try {
    if (file.name.toLowerCase().endsWith(".json")) {
      list = JSON.parse(await file.text());
    } else {
      list = await parseTargetAccountsWorkbook(await file.arrayBuffer());
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
  await renderTargetAccountsStatus();
  appendActivityLog({
    actor: "user",
    action: "target_accounts_imported",
    label: `Imported Target Accounts list (${count} companies)`,
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
}

init();
