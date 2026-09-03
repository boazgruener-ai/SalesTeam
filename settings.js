import {
  getAnthropicApiKey,
  saveAnthropicApiKey,
  getMessageTemplates,
  saveMessageTemplates,
  getValueAddOffers,
  saveValueAddOffers,
  getCompanyContext,
  saveCompanyContext,
  getOutputLanguage,
  saveOutputLanguage,
} from "./storage.js";
import { sanitizeApiKey } from "./agent-shared.js";

const outputLanguageSelect = document.getElementById("output-language-select");
const companyContextInput = document.getElementById("company-context-input");
const anthropicApiKeyInput = document.getElementById("anthropic-api-key-input");
const messageTemplatesListEl = document.getElementById("message-templates-list");
const valueAddOffersInput = document.getElementById("value-add-offers-input");

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
    wrap.append(label, textarea);
    messageTemplatesListEl.appendChild(wrap);
  }
}

outputLanguageSelect.addEventListener("change", () => {
  saveOutputLanguage(outputLanguageSelect.value);
});

companyContextInput.addEventListener("input", () => {
  saveCompanyContext(companyContextInput.value);
});

valueAddOffersInput.addEventListener("input", () => {
  const offers = valueAddOffersInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  saveValueAddOffers(offers);
});

anthropicApiKeyInput.addEventListener("input", () => {
  saveAnthropicApiKey(sanitizeApiKey(anthropicApiKeyInput.value));
});

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;

  outputLanguageSelect.value = await getOutputLanguage();
  companyContextInput.value = await getCompanyContext();
  anthropicApiKeyInput.value = await getAnthropicApiKey();

  messageTemplates = await getMessageTemplates();
  renderMessageTemplates();

  valueAddOffersInput.value = (await getValueAddOffers()).join("\n");
}

init();
