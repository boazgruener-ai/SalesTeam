// Activity Log page: renders every entry storage.js's appendActivityLog has
// recorded (both user actions and automatic extension actions, including
// errors), newest first, with simple client-side filtering. Read-only view
// except for "Clear Log" - the log itself, not the underlying data those
// actions touched.
import { getActivityLog, clearActivityLog } from "./storage.js";

const actorFilterEl = document.getElementById("log-actor-filter");
const searchInputEl = document.getElementById("log-search-input");
const errorsOnlyCheckbox = document.getElementById("log-errors-only-checkbox");
const countEl = document.getElementById("log-count");
const clearLogBtn = document.getElementById("log-clear-btn");
const emptyStateEl = document.getElementById("log-empty-state");
const noMatchStateEl = document.getElementById("log-no-match-state");
const tableEl = document.getElementById("log-table");
const tbodyEl = document.getElementById("log-tbody");

let allEntries = [];

function formatTimestamp(ms) {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.join("\n") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function entryMatchesSearch(entry, query) {
  if (!query) return true;
  const haystack = [
    entry.action,
    entry.label,
    formatValue(entry.prevValue),
    formatValue(entry.newValue),
    entry.errorMessage || "",
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function applyFilters() {
  const actor = actorFilterEl.value;
  const errorsOnly = errorsOnlyCheckbox.checked;
  const query = searchInputEl.value.trim().toLowerCase();

  const filtered = allEntries.filter((entry) => {
    if (actor !== "all" && entry.actor !== actor) return false;
    if (errorsOnly && !entry.error) return false;
    if (!entryMatchesSearch(entry, query)) return false;
    return true;
  });

  renderRows(filtered);
  countEl.textContent = allEntries.length === 0
    ? ""
    : `${filtered.length} of ${allEntries.length} entries`;
}

function valueCell(value) {
  const td = document.createElement("td");
  const text = formatValue(value);
  td.className = "log-value" + (text === "—" ? " log-value-empty" : "");
  td.textContent = text;
  return td;
}

function renderRows(entries) {
  tbodyEl.innerHTML = "";

  if (allEntries.length === 0) {
    emptyStateEl.hidden = false;
    noMatchStateEl.hidden = true;
    tableEl.hidden = true;
    return;
  }
  emptyStateEl.hidden = true;

  if (entries.length === 0) {
    noMatchStateEl.hidden = false;
    tableEl.hidden = true;
    return;
  }
  noMatchStateEl.hidden = true;
  tableEl.hidden = false;

  for (const entry of entries) {
    const tr = document.createElement("tr");
    if (entry.error) tr.className = "log-row-error";

    const timeTd = document.createElement("td");
    timeTd.className = "log-timestamp";
    timeTd.textContent = formatTimestamp(entry.timestamp);

    const actorTd = document.createElement("td");
    const actorPill = document.createElement("span");
    actorPill.className = `log-actor-pill log-actor-${entry.actor}`;
    actorPill.textContent = entry.actor === "extension" ? "Extension" : "User";
    actorTd.appendChild(actorPill);

    const actionTd = document.createElement("td");
    if (entry.error) {
      const icon = document.createElement("span");
      icon.className = "log-error-icon";
      icon.textContent = "⚠";
      actionTd.appendChild(icon);
    }
    actionTd.appendChild(document.createTextNode(entry.label || entry.action || ""));
    if (entry.error && entry.errorMessage) {
      const errDetail = document.createElement("div");
      errDetail.className = "log-value";
      errDetail.style.color = "var(--error-red)";
      errDetail.style.fontSize = "12px";
      errDetail.textContent = entry.errorMessage;
      actionTd.appendChild(errDetail);
    }

    tr.append(timeTd, actorTd, actionTd, valueCell(entry.prevValue), valueCell(entry.newValue));
    tbodyEl.appendChild(tr);
  }
}

async function loadLog() {
  const log = await getActivityLog();
  allEntries = [...log].reverse(); // newest first
  applyFilters();
}

actorFilterEl.addEventListener("change", applyFilters);
searchInputEl.addEventListener("input", applyFilters);
errorsOnlyCheckbox.addEventListener("change", applyFilters);

clearLogBtn.addEventListener("click", async () => {
  if (!confirm("Permanently delete every entry in the Activity Log? This cannot be undone. (This only clears the log itself - your leads and settings are never affected.)")) return;
  await clearActivityLog();
  await loadLog();
});

// Live-updates while this tab stays open - a scan can log many entries over
// its whole run, and this page shouldn't require a manual reload to see
// them, the same reasoning Dashboard/Advisors already apply to their own
// storage reads.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.activityLog) loadLog();
});

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
  await loadLog();
}

init();
