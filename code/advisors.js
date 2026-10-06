// Advisors page: two AI-agent chat interfaces built on the same tool-use
// loop (createAgentChat, below) - the Sales Mentor (strategy advice, grounded
// in real lead data via tool calls) and the Customer Voice (a simulated buyer
// persona to pressure-test outreach messages against). Also owns the persona/
// company-context/template settings that shape both agents' system prompts.
import { askConfirm, askChoice } from "./confirm-dialog.js";
import {
  getAnthropicApiKey,
  getMessageTemplates,
  getValueAddOffers,
  getCompanyContext,
  getIdealCustomerProfile,
  getMentorPersona,
  saveMentorPersona,
  getUserProfile,
  getCustomerPersona,
  saveCustomerPersona,
  getOutputLanguage,
  getAdvisorHistory,
  saveAdvisorHistory,
  clearAdvisorHistory,
  getCustomerVoiceHistory,
  saveCustomerVoiceHistory,
  clearCustomerVoiceHistory,
  appendActivityLog,
} from "./storage.js";
import {
  sanitizeApiKey,
  runAgentTurn,
  buildMentorSystemPrompt,
  buildCustomerSystemPrompt,
  LEAD_LOOKUP_TOOLS,
  DRAFT_MESSAGE_TOOL,
  executeMentorTool,
  executeReadOnlyLeadTool,
} from "./agent-shared.js";

const mentorPersonaInput = document.getElementById("mentor-persona-input");
const customerPersonaInput = document.getElementById("customer-persona-input");
const advisorHistoryEl = document.getElementById("advisor-history");
const advisorStatusEl = document.getElementById("advisor-status");
const advisorInput = document.getElementById("advisor-input");
const advisorSendBtn = document.getElementById("advisor-send-btn");
const advisorClearBtn = document.getElementById("advisor-clear-btn");
const customerHistoryEl = document.getElementById("customer-history");
const customerStatusEl = document.getElementById("customer-status");
const customerInput = document.getElementById("customer-input");
const customerSendBtn = document.getElementById("customer-send-btn");
const customerClearBtn = document.getElementById("customer-clear-btn");

let messageTemplates = [];
let valueAddOffers = [];
let companyContext = "";
let idealCustomerProfile = "";
let mentorPersona = "";
let customerPersona = "";
let outputLanguage = "english";
let userProfile = { name: "", title: "", email: "" };

async function draftSettings() {
  return {
    apiKey: sanitizeApiKey((await getAnthropicApiKey()) || ""),
    messageTemplates,
    valueAddOffers,
    companyContext,
    userProfile,
    outputLanguage,
  };
}

// Same reusable chat-wiring pattern as the side panel's Sales Mentor/Customer
// Voice used before this page existed: DOM wiring here, the actual tool-use
// loop lives in agent-shared.js's runAgentTurn so both pages share it.
function createAgentChat({ buildSystemPrompt, tools, historyEl, statusEl, inputEl, sendBtn, clearBtn, executeTool, getHistoryFn, saveHistoryFn, clearHistoryFn, label, beforeSend }) {
  let history = [];

  function appendBubble(kind, text) {
    const bubble = document.createElement("div");
    bubble.className = `agent-bubble agent-bubble-${kind}`;
    bubble.textContent = text;
    historyEl.appendChild(bubble);
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  function render() {
    historyEl.innerHTML = "";
    for (const message of history) {
      if (message.role === "user" && typeof message.content === "string") {
        appendBubble("you", message.content);
      } else if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim()) {
            appendBubble("agent", block.text);
          } else if (block.type === "tool_use") {
            appendBubble("tool", `🔧 Checking: ${block.name}`);
          }
        }
      }
    }
  }

  async function send() {
    // The Enter-key shortcut below calls send() directly, bypassing the
    // browser's own disabled-button protection - without this guard, a
    // stray Enter while a turn is still in flight starts a second
    // runAgentTurn concurrently, racing on the same shared `history` array
    // and silently losing or scrambling whichever message loses the race.
    if (sendBtn.disabled) return;
    const text = inputEl.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    let proceed = false;
    try { proceed = beforeSend ? await beforeSend() : true; } finally { sendBtn.disabled = false; }
    if (!proceed) return;
    inputEl.value = "";

    const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
    sendBtn.disabled = true;
    try {
      await runAgentTurn(text, {
        history,
        apiKey,
        buildSystemPrompt,
        tools,
        executeTool,
        saveHistory: saveHistoryFn,
        onStatus: (msg) => { statusEl.textContent = msg; },
        onProgress: render,
      });
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  clearBtn.addEventListener("click", async () => {
    if (!(await askConfirm("Clear this conversation? This can't be undone.", { okLabel: "Clear conversation", cancelLabel: "Keep it", danger: true }))) return;
    const prevLength = history.length;
    history = [];
    await clearHistoryFn();
    render();
    appendActivityLog({ actor: "user", action: "conversation_cleared", label: `Cleared ${label} conversation (${prevLength} message(s))`, prevValue: prevLength, newValue: 0 });
  });

  return {
    async init() {
      history = await getHistoryFn();
      render();
    },
  };
}

const salesMentor = createAgentChat({
  buildSystemPrompt: () => buildMentorSystemPrompt({ mentorPersona, companyContext, idealCustomerProfile, outputLanguage }),
  tools: [...LEAD_LOOKUP_TOOLS, DRAFT_MESSAGE_TOOL],
  historyEl: advisorHistoryEl,
  statusEl: advisorStatusEl,
  inputEl: advisorInput,
  sendBtn: advisorSendBtn,
  clearBtn: advisorClearBtn,
  executeTool: async (name, input) => executeMentorTool(name, input, await draftSettings(), null),
  getHistoryFn: getAdvisorHistory,
  saveHistoryFn: saveAdvisorHistory,
  clearHistoryFn: clearAdvisorHistory,
  label: "Sales Mentor",
  beforeSend: () => mentorPersonaEditor.beforeSend(),
});

const customerVoice = createAgentChat({
  buildSystemPrompt: () => buildCustomerSystemPrompt({ companyContext, customerPersona, outputLanguage }),
  tools: LEAD_LOOKUP_TOOLS,
  historyEl: customerHistoryEl,
  statusEl: customerStatusEl,
  inputEl: customerInput,
  sendBtn: customerSendBtn,
  clearBtn: customerClearBtn,
  executeTool: executeReadOnlyLeadTool,
  getHistoryFn: getCustomerVoiceHistory,
  saveHistoryFn: saveCustomerVoiceHistory,
  clearHistoryFn: clearCustomerVoiceHistory,
  label: "Customer Voice",
  beforeSend: () => customerPersonaEditor.beforeSend(),
});

document.getElementById("open-dashboard-link").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

document.getElementById("open-settings-link").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

// Persona fields are saved only by their Save button (rule 2026-10-06: no
// save-on-change). The chat always uses the SAVED persona (mentorPersona /
// customerPersona above); sending with unsaved edits asks which one to use.
function wirePersona({ inputEl, saveBtn, statusEl, getSaved, setSaved, saveFn, action, label }) {
  const isDirty = () => inputEl.value !== getSaved();
  const refresh = () => {
    saveBtn.disabled = !isDirty();
    if (isDirty()) statusEl.textContent = "Unsaved changes";
    else if (statusEl.textContent === "Unsaved changes") statusEl.textContent = "";
  };
  const save = async () => {
    if (!isDirty()) return;
    saveBtn.disabled = true;
    const prev = getSaved();
    const next = inputEl.value;
    setSaved(next);
    await saveFn(next);
    appendActivityLog({ actor: "user", action, label: `${label} persona changed`, prevValue: prev, newValue: next });
    refresh();
    statusEl.textContent = "Saved ✓";
    setTimeout(() => { if (statusEl.textContent === "Saved ✓") statusEl.textContent = ""; }, 3000);
  };
  inputEl.addEventListener("input", refresh);
  saveBtn.addEventListener("click", save);
  return {
    isDirty,
    refresh,
    // Resolves true when the send should go ahead.
    async beforeSend() {
      if (!isDirty()) return true;
      const choice = await askChoice(`Your ${label} persona edits aren't saved yet. The chat uses the saved persona.`,
        [{ value: "save", label: "Save and send" }, { value: "saved", label: "Send with the saved persona" }]);
      if (!choice) return false;
      if (choice === "save") await save();
      return true;
    },
  };
}

const mentorPersonaEditor = wirePersona({
  inputEl: mentorPersonaInput,
  saveBtn: document.getElementById("mentor-persona-save-btn"),
  statusEl: document.getElementById("mentor-persona-save-status"),
  getSaved: () => mentorPersona,
  setSaved: (v) => { mentorPersona = v; },
  saveFn: saveMentorPersona,
  action: "mentor_persona_changed",
  label: "Sales Mentor",
});

const customerPersonaEditor = wirePersona({
  inputEl: customerPersonaInput,
  saveBtn: document.getElementById("customer-persona-save-btn"),
  statusEl: document.getElementById("customer-persona-save-status"),
  getSaved: () => customerPersona,
  setSaved: (v) => { customerPersona = v; },
  saveFn: saveCustomerPersona,
  action: "customer_persona_changed",
  label: "Customer Voice",
});

window.addEventListener("beforeunload", (event) => {
  if (mentorPersonaEditor.isDirty() || customerPersonaEditor.isDirty()) { event.preventDefault(); event.returnValue = ""; }
});

// companyContext/outputLanguage/messageTemplates/valueAddOffers are now
// edited exclusively on the separate Settings page - this page only reads
// them (for buildMentorSystemPrompt/buildCustomerSystemPrompt/draftSettings
// above), so if they're edited there while this page is already open in
// another tab, refresh the local copies instead of going stale until reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.companyContext) companyContext = changes.companyContext.newValue || "";
  if (changes.idealCustomerProfile) idealCustomerProfile = changes.idealCustomerProfile.newValue || "";
  if (changes.outputLanguage) outputLanguage = changes.outputLanguage.newValue || "english";
  if (changes.messageTemplates) messageTemplates = changes.messageTemplates.newValue || [];
  if (changes.valueAddOffers) valueAddOffers = changes.valueAddOffers.newValue || [];
  if (changes.userProfile) userProfile = { name: "", title: "", email: "", ...(changes.userProfile.newValue || {}) };
  // Personas saved elsewhere: take the new saved value, but never overwrite unsaved edits in the field.
  if (changes.mentorPersona) {
    const wasDirty = mentorPersonaEditor.isDirty();
    mentorPersona = changes.mentorPersona.newValue || "";
    if (!wasDirty) mentorPersonaInput.value = mentorPersona;
    mentorPersonaEditor.refresh();
  }
  if (changes.customerPersona) {
    const wasDirty = customerPersonaEditor.isDirty();
    customerPersona = changes.customerPersona.newValue || "";
    if (!wasDirty) customerPersonaInput.value = customerPersona;
    customerPersonaEditor.refresh();
  }
});

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;

  outputLanguage = await getOutputLanguage();
  companyContext = await getCompanyContext();
  idealCustomerProfile = await getIdealCustomerProfile();
  messageTemplates = await getMessageTemplates();
  valueAddOffers = await getValueAddOffers();
  userProfile = await getUserProfile();

  mentorPersona = await getMentorPersona();
  mentorPersonaInput.value = mentorPersona;

  customerPersona = await getCustomerPersona();
  customerPersonaInput.value = customerPersona;

  await salesMentor.init();
  await customerVoice.init();
}

init();
