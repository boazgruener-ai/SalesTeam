// Activity Log page: renders every entry storage.js's appendActivityLog has
// recorded (both user actions and automatic extension actions, including
// errors), newest first, with simple client-side filtering. Deliberately
// read-only - this is the one place to investigate "what happened" after
// something looks wrong, so nothing here can delete it. Old entries age out
// on their own (storage.js prunes anything past the 90-day retention
// window), not via any action on this page.
import { getActivityLog } from "./storage.js";
import { teamLogText, fieldName, shownFields } from "./team-log.js";

// Team use step 6 (R3.11): the team log (team-sync.js TEAM_LOG_KEY) - who in the team changed what. "Team" shows
// everyone's shared changes, mine included; "All actors" adds only colleagues' lines (mine are already here as User
// and Extension entries).
const TEAM_LOG_KEY = "teamLog";

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
    // Everything: this PC's log plus colleagues' lines (my own team lines only where nothing else records them). Me /
    // Automatic: this PC's log by actor. Colleagues: others' team lines. Team: every team line, mine included.
    const show = actor === "team" ? entry.team
      : actor === "colleagues" ? entry.team && !entry.mine
      : actor === "user" ? (entry.team ? entry.mine && entry.ownOnlyHere : entry.actor === "user")
      : actor === "extension" ? !entry.team && entry.actor === "extension"
      : !(entry.team && entry.mine && !entry.ownOnlyHere);
    if (!show) return false;
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
// Leads Dashboard's Content cell; a click expands/collapses. Only a value that actually overflows
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
    // The same names as the filter: Me / Automatic / the colleague's name.
    actorPill.textContent = entry.team ? (entry.mine ? "Me" : entry.who) : entry.actor === "extension" ? "Automatic" : "Me";
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

// "field: value" lines for the Previous / New Value columns (null = empty).
function fieldLines(values, fields) {
  if (!values) return null;
  const shownValue = (f, v) => {
    if (v === null || v === undefined) return "(empty)";
    // A time stored as milliseconds ("...At" fields) reads as a date.
    if (/At$/.test(f) && /^\d{12,}$/.test(String(v))) return new Date(Number(v)).toLocaleString();
    return v;
  };
  const lines = shownFields(fields || Object.keys(values)).filter((f) => f in values).map((f) => `${fieldName(f)}: ${shownValue(f, values[f])}`);
  return lines.length ? lines : null;
}

function teamRows(teamLog, me) {
  return (Array.isArray(teamLog) ? teamLog : []).map((e) => ({
    team: true,
    mine: e.m === me,
    // My own assignments, releases and member removals are only in the team log - shown under All actors too.
    ownOnlyHere: ["assign", "unassign", "remove_member"].includes(e.op),
    actor: "team",
    who: e.m === me ? "You" : e.mn || "A colleague",
    timestamp: e.at,
    label: `${e.m === me ? "You" : e.mn || "A colleague"} ${teamLogText(e, (k) => e.name || k, (m) => (m === me ? "you" : e.tn || "a colleague"))}`,
    // A join proposal's bookkeeping fields say nothing to a reader - the line itself says what happened.
    prevValue: e.ref === "teamJoinProposals" ? null : e.before && Object.keys(e.before).length ? fieldLines(e.before, e.fields) : null,
    newValue: e.ref === "teamJoinProposals" ? null : fieldLines(e.after, e.fields),
  }));
}

async function loadLog() {
  const [log, stored] = await Promise.all([getActivityLog(), chrome.storage.local.get([TEAM_LOG_KEY, "teamMembership"])]);
  const me = stored.teamMembership?.memberId || null;
  const team = teamRows(stored[TEAM_LOG_KEY], me);
  document.getElementById("log-actor-team-option").hidden = !me && !team.length;
  document.getElementById("log-actor-colleagues-option").hidden = !me && !team.length;
  allEntries = [...log, ...team].sort((a, b) => b.timestamp - a.timestamp); // newest first
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
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith("activityLog:") || k === "activityLog" || k === TEAM_LOG_KEY)) loadLog();
});

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
  await loadLog();
}

init();
