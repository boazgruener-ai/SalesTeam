// Activity Log page: renders every entry storage.js's appendActivityLog has
// recorded (both user actions and automatic extension actions, including
// errors), newest first, with simple client-side filtering. Deliberately
// read-only - this is the one place to investigate "what happened" after
// something looks wrong, so nothing here can delete it. Old entries age out
// on their own (storage.js prunes anything past the 90-day retention
// window), not via any action on this page.
import { getActivityLog } from "./storage.js";

const actorFilterEl = document.getElementById("log-actor-filter");
const searchInputEl = document.getElementById("log-search-input");
const errorsOnlyCheckbox = document.getElementById("log-errors-only-checkbox");
const countEl = document.getElementById("log-count");
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

// Long values (a pasted JSON blob, a list of diagnostic samples) are clamped to 4 lines, like the
// Posts Dashboard's Content cell; a click expands/collapses. Only a value that actually overflows
// gets the pointer cursor and hover tip (markExpandableValues, after the rows are in the DOM).
function valueCell(value, { wide = false } = {}) {
  const td = document.createElement("td");
  const text = formatValue(value);
  td.className = "log-value" + (text === "—" ? " log-value-empty" : "") + (wide ? " log-value-wide" : "");
  const inner = document.createElement("div");
  inner.className = "log-value-inner clamped";
  inner.textContent = text;
  td.appendChild(inner);
  return td;
}

function markExpandableValues() {
  for (const inner of tbodyEl.querySelectorAll(".log-value-inner")) {
    if (inner.scrollHeight <= inner.clientHeight + 1) continue;
    inner.classList.add("log-value-expandable");
    inner.title = "Click to expand/collapse";
    inner.addEventListener("click", () => inner.classList.toggle("expanded"));
  }
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

    tr.append(timeTd, actorTd, actionTd, valueCell(entry.prevValue), valueCell(entry.newValue, { wide: true }));
    tbodyEl.appendChild(tr);
  }
  markExpandableValues();
}

async function loadLog() {
  const log = await getActivityLog();
  allEntries = [...log].reverse(); // newest first
  applyFilters();
}

actorFilterEl.addEventListener("change", applyFilters);
searchInputEl.addEventListener("input", applyFilters);
errorsOnlyCheckbox.addEventListener("change", applyFilters);

// Live-updates while this tab stays open - a scan can log many entries over
// its whole run, and this page shouldn't require a manual reload to see
// them, the same reasoning Dashboard/Advisors already apply to their own
// storage reads. Each day's entries live under their own "activityLog:
// YYYY-MM-DD" key (storage.js) rather than one shared key, so this checks
// for any changed key with that prefix, not one fixed key name.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith("activityLog:") || k === "activityLog")) loadLog();
});

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
  await loadLog();
}

init();
