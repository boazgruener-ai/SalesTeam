// Activity Log page: renders every entry storage.js's appendActivityLog has
// recorded (both user actions and automatic extension actions, including
// errors), newest first, with simple client-side filtering. Deliberately
// read-only - this is the one place to investigate "what happened" after
// something looks wrong, so nothing here can delete it. Old entries age out
// on their own (storage.js prunes anything past the 90-day retention
// window), not via any action on this page.
import { getActivityLog } from "./storage.js";
import { teamLogText, fieldName, shownFields } from "./team-log.js";
import { orderedColumns, makeColumnDraggable, resetOrderItem } from "./column-order.js";

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
    return matchesColumnFilters(entry);
  });
  sortEntries(filtered);

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

  renderHead();
  const cols = visibleColumns();
  for (const entry of entries) {
    const tr = document.createElement("tr");
    if (entry.error) tr.className = "log-row-error";
    for (const c of cols) tr.appendChild(c.render(entry));
    tbodyEl.appendChild(tr);
  }
  markExpandableValues();
}

// --------------------------------------------------------------------------
// Columns (Boaz 2026-10-08: every data table has the same column features as Target Accounts) - click a title to
// sort, ▾ for sort / filter / hide, Columns to show / hide or reset the order, drag a title to move the column.
// Sort, filters and hidden columns are remembered in this browser (localStorage), like the other tables.
// --------------------------------------------------------------------------
const actorText = (entry) => (entry.team ? (entry.mine ? "Me" : entry.who) : entry.actor === "extension" ? "Automatic" : "Me");
const COLUMNS = [
  {
    id: "time", label: "Date & Time", sortValue: (e) => e.timestamp || 0, text: (e) => formatTimestamp(e.timestamp),
    render(entry) {
      const td = document.createElement("td");
      td.className = "log-timestamp";
      td.textContent = formatTimestamp(entry.timestamp);
      return td;
    },
  },
  {
    id: "actor", label: "Actor", text: actorText,
    render(entry) {
      const td = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = `log-actor-pill log-actor-${entry.actor}`;
      // The same names as the filter: Me / Automatic / the colleague's name.
      pill.textContent = actorText(entry);
      td.appendChild(pill);
      return td;
    },
  },
  {
    id: "action", label: "Action", text: (e) => `${e.label || e.action || ""}${e.errorMessage ? ` ${e.errorMessage}` : ""}`,
    render(entry) {
      const td = document.createElement("td");
      if (entry.error) {
        const icon = document.createElement("span");
        icon.className = "log-error-icon";
        icon.textContent = "⚠";
        td.appendChild(icon);
      }
      td.appendChild(document.createTextNode(entry.label || entry.action || ""));
      if (entry.error && entry.errorMessage) {
        const errDetail = document.createElement("div");
        errDetail.className = "log-value";
        errDetail.style.color = "var(--error-red)";
        errDetail.style.fontSize = "12px";
        errDetail.textContent = entry.errorMessage;
        td.appendChild(errDetail);
      }
      return td;
    },
  },
  { id: "prev", label: "Previous Value", text: (e) => formatValue(e.prevValue), render: (e) => valueCell(e.prevValue) },
  { id: "new", label: "New Value", text: (e) => formatValue(e.newValue), render: (e) => valueCell(e.newValue, { wide: true }) },
];
const ORDER_KEY = "salesteam-activity-log-column-order-v1";
const STATE_KEY = "salesteam-activity-log-columns-v1";

let colState = { hidden: [], sort: { id: "time", dir: "desc" }, filters: {} };
try {
  const saved = JSON.parse(localStorage.getItem(STATE_KEY));
  if (saved && typeof saved === "object") colState = { ...colState, ...saved, filters: saved.filters || {} };
} catch { /* defaults */ }
function saveColState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(colState)); } catch { /* this visit only */ }
}

function visibleColumns() {
  return orderedColumns(COLUMNS, ORDER_KEY).filter((c) => !colState.hidden.includes(c.id));
}

function matchesColumnFilters(entry) {
  for (const [id, f] of Object.entries(colState.filters)) {
    const col = COLUMNS.find((c) => c.id === id);
    if (!col || !f?.text) continue;
    const has = String(col.text(entry) || "").toLowerCase().includes(f.text.toLowerCase());
    if (f.exclude ? has : !has) return false;
  }
  return true;
}

function sortEntries(list) {
  const col = COLUMNS.find((c) => c.id === colState.sort?.id) || COLUMNS[0];
  const dir = colState.sort?.dir === "asc" ? 1 : -1;
  const key = col.sortValue || ((e) => String(col.text(e) || "").toLowerCase());
  list.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || (b.timestamp || 0) - (a.timestamp || 0);
  });
}

function setSort(id, dir) {
  colState.sort = { id, dir };
  saveColState();
  applyFilters();
}

let openPopup = null;
function closeColumnMenu() {
  if (openPopup) { openPopup.remove(); openPopup = null; }
}
function showPopup(anchor, popup) {
  closeColumnMenu();
  document.body.appendChild(popup);
  const r = anchor.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(r.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8))}px`;
  popup.style.top = `${r.bottom + 2}px`;
  openPopup = popup;
  setTimeout(() => document.addEventListener("click", function close(e) {
    if (popup.contains(e.target)) { document.addEventListener("click", close, { once: true }); return; }
    closeColumnMenu();
  }, { once: true }), 0);
}
function menuItem(text, onClick, { disabled = false } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "col-menu-item";
  b.textContent = text;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

// ▾ on a column: Sort A→Z / Z→A, a "contains" filter (or "does not contain"), Hide.
function openColumnMenu(col, th) {
  if (openPopup?.dataset.col === col.id) { closeColumnMenu(); return; }
  const popup = document.createElement("div");
  popup.className = "col-menu-popup";
  popup.dataset.col = col.id;
  const asc = col.id === "time" ? "Oldest first" : "Sort A → Z";
  const desc = col.id === "time" ? "Newest first" : "Sort Z → A";
  popup.append(menuItem(asc, () => { closeColumnMenu(); setSort(col.id, "asc"); }), menuItem(desc, () => { closeColumnMenu(); setSort(col.id, "desc"); }));
  popup.appendChild(document.createElement("hr"));
  const f = colState.filters[col.id] || { text: "", exclude: false };
  const input = document.createElement("input");
  input.type = "text";
  input.className = "col-menu-filter";
  input.placeholder = "Filter: contains…";
  input.value = f.text || "";
  const ex = document.createElement("label");
  ex.className = "col-menu-check";
  const exBox = document.createElement("input");
  exBox.type = "checkbox";
  exBox.checked = Boolean(f.exclude);
  ex.append(exBox, document.createTextNode(" Does not contain"));
  const apply = () => {
    const text = input.value.trim();
    if (text) colState.filters[col.id] = { text, exclude: exBox.checked };
    else delete colState.filters[col.id];
    saveColState();
    applyFilters();
  };
  input.addEventListener("input", apply);
  exBox.addEventListener("change", apply);
  popup.append(input, ex, menuItem("Clear filter", () => { input.value = ""; exBox.checked = false; apply(); }, { disabled: !f.text }));
  popup.appendChild(document.createElement("hr"));
  popup.appendChild(menuItem("Hide this column", () => { closeColumnMenu(); setHidden(col.id, true); }, { disabled: visibleColumns().length <= 1 }));
  showPopup(th, popup);
  input.focus();
}

function setHidden(id, hidden) {
  const set = new Set(colState.hidden);
  if (hidden) set.add(id); else set.delete(id);
  if (COLUMNS.length - set.size < 1) return false;
  colState.hidden = [...set];
  saveColState();
  applyFilters();
  return true;
}

function openColumnsPanel(btn) {
  if (openPopup?.dataset.col === "*") { closeColumnMenu(); return; }
  const popup = document.createElement("div");
  popup.className = "col-menu-popup columns-panel";
  popup.dataset.col = "*";
  popup.append(resetOrderItem(ORDER_KEY, closeColumnMenu, applyFilters), document.createElement("hr"));
  for (const col of orderedColumns(COLUMNS, ORDER_KEY)) {
    const row = document.createElement("label");
    row.className = "columns-panel-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !colState.hidden.includes(col.id);
    cb.addEventListener("change", () => { if (!setHidden(col.id, !cb.checked)) cb.checked = true; });
    row.append(cb, document.createTextNode(col.label));
    popup.appendChild(row);
  }
  showPopup(btn, popup);
}

function renderHead() {
  const thead = document.getElementById("log-thead");
  const tr = document.createElement("tr");
  for (const col of visibleColumns()) {
    const th = document.createElement("th");
    makeColumnDraggable(th, col, COLUMNS, ORDER_KEY, applyFilters);
    const label = document.createElement("span");
    label.className = "th-label";
    label.textContent = col.label;
    label.title = "Click to sort";
    label.addEventListener("click", () => setSort(col.id, colState.sort?.id === col.id && colState.sort.dir === "desc" ? "asc" : "desc"));
    th.appendChild(label);
    if (colState.sort?.id === col.id) th.appendChild(document.createTextNode(colState.sort.dir === "asc" ? " ▲" : " ▼"));
    if (colState.filters[col.id]?.text) {
      th.classList.add("col-filtered");
      th.title = `Filtered: ${colState.filters[col.id].exclude ? "does not contain" : "contains"} "${colState.filters[col.id].text}"`;
    }
    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "col-menu-btn";
    menu.textContent = "▾";
    menu.title = "Sort / Filter / Hide this column";
    menu.addEventListener("click", (e) => { e.stopPropagation(); openColumnMenu(col, th); });
    th.appendChild(menu);
    tr.appendChild(th);
  }
  thead.replaceChildren(tr);
}

document.getElementById("log-columns-btn").addEventListener("click", (e) => { e.stopPropagation(); openColumnsPanel(e.currentTarget); });

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
