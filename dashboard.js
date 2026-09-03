// Dashboard tab: the full-page view of every lead. Renders three pie charts
// (7 days / 30 days / all time) by status, a sortable/searchable/filterable
// leads table, and per-lead priority scoring. Also owns the "Bulk Change"
// dialog (mass status changes with a confirmation step and one-level undo)
// and the "Prioritize Unscored Leads" action.
import {
  getResults,
  updateLeadStatus,
  bulkUpdateLeadStatus,
  updateLeadMentorHistory,
  LEAD_STATUSES,
  getAnthropicApiKey,
  getMentorPersona,
  getCompanyContext,
  getOutputLanguage,
  getMessageTemplates,
  getValueAddOffers,
  getLastScanStartedAt,
  applyLeadPriorities,
  getLastBulkChange,
  undoLastBulkChange,
} from "./storage.js";
import { sortResultsByRelevance } from "./ranking.js";
import {
  sanitizeApiKey,
  generateDraft,
  pickDefaultTemplateId,
  runAgentTurn,
  buildLeadScopedMentorPrompt,
  DRAFT_MESSAGE_TOOL,
  toolDraftMessage,
  prioritizeLeads,
} from "./agent-shared.js";

const STATUS_COLORS = {
  New: "#0a66c2",
  Contacted: "#d9731e",
  Dismissed: "#9e9e9e",
  Responded: "#2e7d32",
  Converted: "#6a1b9a",
  Irrelevant: "#c62828",
};

const listViewEl = document.getElementById("list-view");
const detailViewEl = document.getElementById("detail-view");
const tbody = document.getElementById("results-tbody");
const resultCountEl = document.getElementById("result-count");
const searchInput = document.getElementById("search-input");
const statusFilterSelect = document.getElementById("status-filter-select");
const showIrrelevantCheckbox = document.getElementById("show-irrelevant-checkbox");
const bulkChangeDialog = document.getElementById("bulk-change-dialog");
const openBulkChangeBtn = document.getElementById("open-bulk-change-btn");
const bulkStatusSelect = document.getElementById("bulk-status-select");
const bulkApplyBtn = document.getElementById("bulk-apply-btn");
const bulkCancelBtn = document.getElementById("bulk-cancel-btn");
const bulkStatusText = document.getElementById("bulk-status-text");
const bulkUndoBtn = document.getElementById("bulk-undo-btn");
const bulkUndoText = document.getElementById("bulk-undo-text");
const prioritizeUnscoredBtn = document.getElementById("prioritize-unscored-btn");
const prioritizeStatusEl = document.getElementById("prioritize-status");

const SHOW_IRRELEVANT_STORAGE_KEY = "salesteam-dashboard-show-irrelevant";
let showIrrelevant = false;

let allLeads = [];
let lastScanStartedAt = 0;
let messageTemplates = [];
let valueAddOffers = [];
let companyContext = "";
let mentorPersona = "";
let outputLanguage = "english";

let statusFilter = "all";
let pageSize = 20;
let currentPage = 1;

const PAGE_SIZE_STORAGE_KEY = "salesteam-dashboard-page-size";
let searchText = "";

let currentDetailLead = null;
let mentorHistory = [];

// ---------------------------------------------------------------------
// Lead shape helpers - a lead is either a Post (author/headline/snippet) or
// a Job listing (title/company/location), see storage.js's mergeTopicPosts/
// mergeJobPosts for the two shapes.
// ---------------------------------------------------------------------

function leadTitle(lead) {
  return lead.type === "job" ? (lead.title || "Untitled role") : (lead.headline || lead.author || "Untitled");
}

function leadContent(lead) {
  return lead.type === "job"
    ? [lead.title, lead.company, lead.location].filter(Boolean).join(" · ")
    : (lead.snippet || "");
}

function leadCreatorName(lead) {
  return lead.type === "job" ? (lead.company || "Unknown company") : (lead.author || "Unknown");
}

function leadCreatorUrl(lead) {
  return lead.type === "job" ? lead.jobUrl : lead.profileUrl;
}

function leadSourceLabel(lead) {
  if (lead.type === "job") return "Job Listing";
  if (lead.isJobAd) return "In-Post Job Ad";
  return "Post";
}

function leadSourceClass(lead) {
  if (lead.type === "job") return "source-joblisting";
  if (lead.isJobAd) return "source-jobad";
  return "source-post";
}

// The real (estimated) post date, not when the scanner happened to find it -
// see storage.js's parseRelativeTimestamp. Falls back to firstSeenAt only
// for the rare case both parsing attempts (fresh scrape and self-heal) failed.
function leadDate(lead) {
  return lead.postedAt || lead.firstSeenAt || 0;
}

function isNewFromLastScan(lead) {
  return lastScanStartedAt > 0 && (lead.firstSeenAt || 0) >= lastScanStartedAt;
}

// When a lead's status was last touched by a person - or, if never touched,
// when it was added. Sorting this ascending surfaces the leads that have
// gone the longest without any action (still "New" since they first showed
// up, or stuck in whatever status they were last set to).
function leadLastActivity(lead) {
  return lead.statusUpdatedAt || lead.firstSeenAt || 0;
}

// Assigned automatically by the Sales Mentor as a post-scan step (see
// background.js) - 1 = highest priority, 5 = lowest. A lead that hasn't
// been through that pass yet (e.g. it's Irrelevant/Dismissed/etc., or predates
// this feature) has no priority at all, sorted to the very end rather than
// treated as "5" so it's visually distinct from a genuinely low-priority lead.
function leadPrioritySortValue(lead) {
  return lead.priority || 99;
}

function leadPriorityLabel(lead) {
  return lead.priority ? `P${lead.priority}` : "";
}

function formatDateTime(epochMs) {
  if (!epochMs) return "";
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function makeLink(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

async function currentSettings() {
  return {
    apiKey: sanitizeApiKey((await getAnthropicApiKey()) || ""),
    messageTemplates,
    valueAddOffers,
    companyContext,
    outputLanguage,
  };
}

async function loadSettings() {
  [messageTemplates, valueAddOffers, companyContext, mentorPersona, outputLanguage] = await Promise.all([
    getMessageTemplates(),
    getValueAddOffers(),
    getCompanyContext(),
    getMentorPersona(),
    getOutputLanguage(),
  ]);
}

async function loadLeads() {
  const [resultsMap, scanStartedAt] = await Promise.all([getResults(), getLastScanStartedAt()]);
  allLeads = sortResultsByRelevance(resultsMap);
  lastScanStartedAt = scanStartedAt;
}

// ---------------------------------------------------------------------
// Pie charts - hand-drawn inline SVG (no chart library: this extension
// never loads remote code, see the Web Store "remote code" answer). Each
// chart buckets by firstSeenAt (a real discovery timestamp), not LinkedIn's
// own relative display strings, which aren't real dates - see storage.js.
// ---------------------------------------------------------------------

function computeStatusCounts(leads) {
  const counts = {};
  for (const s of LEAD_STATUSES) counts[s] = 0;
  for (const lead of leads) {
    const status = lead.status || "New";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function polarPoint(cx, cy, r, angle) {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

function renderPieChart(containerEl, leads, onSliceClick) {
  containerEl.innerHTML = "";
  const counts = computeStatusCounts(leads);
  const total = leads.length;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 120 120");

  if (total === 0) {
    const circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("cx", "60");
    circle.setAttribute("cy", "60");
    circle.setAttribute("r", "54");
    circle.setAttribute("fill", "#eee");
    svg.appendChild(circle);
  } else {
    let startAngle = -Math.PI / 2;
    for (const status of LEAD_STATUSES) {
      const n = counts[status];
      if (n === 0) continue;
      const sliceAngle = (n / total) * Math.PI * 2;
      const endAngle = startAngle + sliceAngle;
      const path = document.createElementNS(svgNS, "path");
      let d;
      if (n === total) {
        // A true 360-degree arc degenerates to nothing in SVG's arc command,
        // so a single all-one-status window is drawn as a near-full circle.
        d = "M 60 6 A 54 54 0 1 1 59.99 6 Z";
      } else {
        const [x1, y1] = polarPoint(60, 60, 54, startAngle);
        const [x2, y2] = polarPoint(60, 60, 54, endAngle);
        const largeArc = sliceAngle > Math.PI ? 1 : 0;
        d = `M 60 60 L ${x1} ${y1} A 54 54 0 ${largeArc} 1 ${x2} ${y2} Z`;
      }
      path.setAttribute("d", d);
      path.setAttribute("fill", STATUS_COLORS[status]);
      path.style.cursor = "pointer";
      path.addEventListener("click", () => onSliceClick(status));
      const titleEl = document.createElementNS(svgNS, "title");
      titleEl.textContent = `${status}: ${n}`;
      path.appendChild(titleEl);
      svg.appendChild(path);
      startAngle = endAngle;
    }
  }

  const legend = document.createElement("div");
  legend.className = "pie-legend";
  if (total === 0) {
    legend.innerHTML = '<span class="pie-empty">No leads in this window.</span>';
  } else {
    const totalRow = document.createElement("div");
    totalRow.style.fontWeight = "600";
    totalRow.style.marginBottom = "6px";
    totalRow.textContent = `${total} lead${total === 1 ? "" : "s"}`;
    legend.appendChild(totalRow);
    for (const status of LEAD_STATUSES) {
      if (counts[status] === 0) continue;
      const row = document.createElement("div");
      row.className = "pie-legend-row";
      row.title = "Click to filter the table by this status";
      const swatch = document.createElement("span");
      swatch.className = "pie-legend-swatch";
      swatch.style.background = STATUS_COLORS[status];
      row.append(swatch, document.createTextNode(` ${status}: ${counts[status]}`));
      row.addEventListener("click", () => onSliceClick(status));
      legend.appendChild(row);
    }
  }

  containerEl.append(svg, legend);
}

function renderAllPieCharts() {
  const now = Date.now();
  const since = (days) => now - days * 24 * 60 * 60 * 1000;
  const last7 = allLeads.filter((l) => leadDate(l) >= since(7));
  const last30 = allLeads.filter((l) => leadDate(l) >= since(30));
  const onSliceClick = (status) => {
    statusFilterSelect.value = status;
    statusFilter = status;
    renderTableFromScratch();
  };
  renderPieChart(document.getElementById("pie-7"), last7, onSliceClick);
  renderPieChart(document.getElementById("pie-30"), last30, onSliceClick);
  renderPieChart(document.getElementById("pie-all"), allLeads, onSliceClick);
}

// ---------------------------------------------------------------------
// Table: a data-driven column config drives header rendering, per-column
// Excel-style sort/filter menus, resizing, and row rendering all from one
// place, so adding/reordering a column never means editing five functions.
// ---------------------------------------------------------------------

const MIN_COL_WIDTH = 70;
const COL_WIDTHS_STORAGE_KEY = "salesteam-dashboard-column-widths";

// "NEW" here means "first appeared in the most recent scan" - a different
// concept from status "New" (meaning "not yet acted on"), see the storage.js
// lastScanStartedAt comment. A lead can be both, either, or neither.
function titleCell(td, lead) {
  td.textContent = leadTitle(lead);
  if (isNewFromLastScan(lead)) {
    const badge = document.createElement("span");
    badge.className = "new-scan-badge";
    badge.textContent = "NEW";
    badge.title = "First appeared in your most recent scan";
    td.appendChild(badge);
  }
}

function sourceCell(td, lead) {
  const badge = document.createElement("span");
  badge.className = `source-badge ${leadSourceClass(lead)}`;
  badge.textContent = leadSourceLabel(lead);
  td.appendChild(badge);
}

// Shows up to 3 lines by default (CSS line-clamp, not a fixed character
// count, so it wraps naturally at the column's actual width); clicking
// toggles the full text, which grows the row in place, then click again to
// collapse back to 3 lines.
function contentCell(td, lead) {
  td.className = "content-cell";
  td.textContent = leadContent(lead);
  td.title = "Click to expand/collapse";
  td.addEventListener("click", () => {
    td.classList.toggle("expanded");
  });
}

function creatorCell(td, lead) {
  const creatorUrl = leadCreatorUrl(lead);
  if (creatorUrl) {
    const link = makeLink(creatorUrl, leadCreatorName(lead));
    link.className = "creator-link";
    td.appendChild(link);
  } else {
    td.textContent = leadCreatorName(lead);
  }
}

function connectionCell(td, lead) {
  if (lead.connectionDegree) {
    const pill = document.createElement("span");
    pill.className = "connection-pill";
    pill.textContent = lead.connectionDegree;
    td.appendChild(pill);
  } else {
    td.textContent = "—";
  }
}

function statusCell(td, lead) {
  const status = lead.status || "New";
  const pill = document.createElement("span");
  pill.className = `status-pill status-${status.toLowerCase()}`;
  pill.textContent = status;
  // Names both the topic AND the specific keyword within it that matched
  // (e.g. 'Recruiter/Staffing Headline Filter (matched "Recruiter")') - a
  // topic can hold several keywords, so the topic name alone isn't enough
  // to tell which one is actually responsible for a given lead.
  if (status === "Irrelevant" && lead.irrelevantReason) {
    pill.title = lead.irrelevantReason;
  }
  td.appendChild(pill);
}

function priorityCell(td, lead) {
  if (!lead.priority) {
    td.textContent = "—";
    return;
  }
  const pill = document.createElement("span");
  pill.className = `priority-pill priority-${lead.priority}`;
  pill.textContent = leadPriorityLabel(lead);
  if (lead.priorityReason) pill.title = lead.priorityReason;
  td.appendChild(pill);
}

function makeIconBtn(icon, title, onClick, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn" + (extraClass ? " " + extraClass : "");
  btn.title = title;
  btn.textContent = icon;
  btn.addEventListener("click", onClick);
  return btn;
}

function actionsCell(td, lead) {
  td.className = "actions-cell";
  td.append(
    makeIconBtn("✎", "Open / Edit", () => openDetail(lead.key)),
    makeIconBtn("🧭", "Consult Mentor", () => openDetail(lead.key, "mentor")),
    makeIconBtn("✉", "Send Message", () => openDetail(lead.key, "draft")),
    makeIconBtn(
      "✕",
      "Dismiss",
      async () => {
        await updateLeadStatus(lead.key, "Dismissed");
        await loadLeads();
        renderAllPieCharts();
        renderTable();
      },
      "dismiss-btn"
    )
  );
}

// Every column in one place: how to sort by it (getSortValue - omitted for
// non-sortable columns), how to match it against a per-column filter
// (getFilterText - omitted for non-filterable columns), and how to render
// its cell. Default widths are starting points only - see loadColumnWidths.
const COLUMNS = [
  { id: "date", label: "Post Date", width: 150, getSortValue: leadDate, getFilterText: (l) => formatDateTime(leadDate(l)),
    render: (td, l) => { td.style.whiteSpace = "nowrap"; td.textContent = formatDateTime(leadDate(l)); } },
  { id: "firstScanned", label: "First Scanned", width: 150, getSortValue: (l) => l.firstSeenAt || 0, getFilterText: (l) => formatDateTime(l.firstSeenAt),
    render: (td, l) => { td.style.whiteSpace = "nowrap"; td.textContent = formatDateTime(l.firstSeenAt); } },
  { id: "source", label: "Source", width: 130, getSortValue: leadSourceLabel, getFilterText: leadSourceLabel, render: sourceCell },
  { id: "title", label: "Title", width: 220, getSortValue: leadTitle, getFilterText: leadTitle, render: titleCell },
  { id: "content", label: "Content", width: 280, getFilterText: leadContent, render: contentCell },
  { id: "creator", label: "Creator", width: 160, getSortValue: leadCreatorName, getFilterText: leadCreatorName, render: creatorCell },
  { id: "connection", label: "Connection", width: 110, getSortValue: (l) => l.connectionDegree || "", getFilterText: (l) => l.connectionDegree || "", render: connectionCell },
  { id: "status", label: "Status", width: 110, getSortValue: (l) => l.status || "New", getFilterText: (l) => l.status || "New", render: statusCell },
  { id: "priority", label: "Priority", width: 100, getSortValue: leadPrioritySortValue, getFilterText: (l) => leadPriorityLabel(l) || "not scored", render: priorityCell },
  { id: "lastActivity", label: "Last Activity", width: 150, getSortValue: leadLastActivity, getFilterText: (l) => formatDateTime(leadLastActivity(l)),
    render: (td, l) => { td.style.whiteSpace = "nowrap"; td.textContent = formatDateTime(leadLastActivity(l)); } },
  { id: "actions", label: "Actions", width: 150, render: actionsCell },
];

let columnWidths = {};
let columnFilters = {}; // { [columnId]: "filter text" }
let sortColumn = "date";
let sortDirection = "desc";
let openMenuColumnId = null;

function loadPageSize() {
  const saved = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
  pageSize = saved === "all" ? "all" : (parseInt(saved, 10) || 20);
  document.getElementById("page-size-select").value = String(pageSize);
}

function loadShowIrrelevant() {
  showIrrelevant = localStorage.getItem(SHOW_IRRELEVANT_STORAGE_KEY) === "true";
  showIrrelevantCheckbox.checked = showIrrelevant;
}

function loadColumnWidths() {
  columnWidths = {};
  for (const col of COLUMNS) columnWidths[col.id] = col.width;
  try {
    const saved = JSON.parse(localStorage.getItem(COL_WIDTHS_STORAGE_KEY) || "{}");
    Object.assign(columnWidths, saved);
  } catch {
    // ignore a corrupted/missing saved-widths blob - defaults already set above
  }
}

function saveColumnWidths() {
  try {
    localStorage.setItem(COL_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths));
  } catch {
    // best-effort only - a column-width preference isn't worth surfacing an error for
  }
}

function applyFilterSortSearch() {
  let leads = allLeads.slice();

  if (statusFilter !== "all") {
    leads = leads.filter((l) => (l.status || "New") === statusFilter);
  } else if (!showIrrelevant) {
    // Explicitly picking "Irrelevant" from the Status filter above always
    // shows them regardless of this checkbox - this default-hide only
    // applies to the general "All statuses" view, which is what was getting
    // cluttered with negative-filtered leads nobody wants to look at.
    leads = leads.filter((l) => (l.status || "New") !== "Irrelevant");
  }

  if (searchText.trim()) {
    const q = searchText.trim().toLowerCase();
    leads = leads.filter((l) => {
      const haystack = [leadTitle(l), leadContent(l), leadCreatorName(l)].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }

  for (const col of COLUMNS) {
    const filterVal = (columnFilters[col.id] || "").trim();
    if (filterVal && col.getFilterText) {
      const q = filterVal.toLowerCase();
      leads = leads.filter((l) => String(col.getFilterText(l) || "").toLowerCase().includes(q));
    }
  }

  const sortCol = COLUMNS.find((c) => c.id === sortColumn);
  if (sortCol && sortCol.getSortValue) {
    leads.sort((a, b) => {
      const va = sortCol.getSortValue(a);
      const vb = sortCol.getSortValue(b);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sortDirection === "asc" ? cmp : -cmp;
    });
  }

  return leads;
}

function closeColumnMenu() {
  openMenuColumnId = null;
  document.querySelectorAll(".col-menu-popup").forEach((el) => el.remove());
}

// The popup is appended to <body> and positioned with `fixed` using the
// trigger button's real on-screen coordinates, rather than being a normal
// descendant of the <th> it belongs to. A `th` inside a table inside
// #table-section's overflow:auto scroll area is exactly the kind of nesting
// that silently clips or hides an absolutely-positioned popup in some
// browsers/zoom levels even though it's still technically in the DOM - this
// sidesteps that whole class of bug instead of fighting it.
function toggleColumnMenu(column, anchorEl) {
  if (openMenuColumnId === column.id) {
    closeColumnMenu();
    return;
  }
  closeColumnMenu();
  openMenuColumnId = column.id;

  const anchorRect = anchorEl.getBoundingClientRect();
  const popup = document.createElement("div");
  popup.className = "col-menu-popup";

  if (column.getSortValue) {
    const ascBtn = document.createElement("button");
    ascBtn.className = "col-menu-item";
    ascBtn.textContent = "Sort Ascending";
    ascBtn.addEventListener("click", () => {
      sortColumn = column.id;
      sortDirection = "asc";
      closeColumnMenu();
      renderTableFromScratch();
    });
    const descBtn = document.createElement("button");
    descBtn.className = "col-menu-item";
    descBtn.textContent = "Sort Descending";
    descBtn.addEventListener("click", () => {
      sortColumn = column.id;
      sortDirection = "desc";
      closeColumnMenu();
      renderTableFromScratch();
    });
    popup.append(ascBtn, descBtn);
  }

  if (column.getFilterText) {
    if (column.getSortValue) popup.appendChild(document.createElement("hr"));
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.className = "col-filter-input";
    filterInput.placeholder = `Filter ${column.label}…`;
    filterInput.value = columnFilters[column.id] || "";
    const applyFilter = () => {
      columnFilters[column.id] = filterInput.value.trim();
      closeColumnMenu();
      renderTableFromScratch();
    };
    filterInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") applyFilter();
    });
    const actionsRow = document.createElement("div");
    actionsRow.className = "col-menu-actions";
    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply";
    applyBtn.addEventListener("click", applyFilter);
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      columnFilters[column.id] = "";
      closeColumnMenu();
      renderTableFromScratch();
    });
    actionsRow.append(applyBtn, clearBtn);
    popup.append(filterInput, actionsRow);
  }

  // Positioned after being appended (so its real rendered width is known),
  // clamped so it can't render off the right edge of the viewport.
  document.body.appendChild(popup);
  const popupWidth = popup.offsetWidth;
  const left = Math.min(anchorRect.right - popupWidth, window.innerWidth - popupWidth - 8);
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top = `${anchorRect.bottom + 2}px`;

  setTimeout(() => document.addEventListener("click", onDocumentClickCloseMenu, { once: true }), 0);
}

function onDocumentClickCloseMenu(event) {
  if (!event.target.closest(".col-menu-popup") && !event.target.closest(".col-menu-btn")) {
    closeColumnMenu();
  } else if (openMenuColumnId) {
    // clicked back into the still-open menu/trigger - keep listening for the next real outside click
    document.addEventListener("click", onDocumentClickCloseMenu, { once: true });
  }
}

function startColumnResize(event, column) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = columnWidths[column.id];

  function onMove(moveEvent) {
    const next = Math.max(MIN_COL_WIDTH, startWidth + (moveEvent.clientX - startX));
    columnWidths[column.id] = next;
    const col = document.querySelector(`col[data-col-id="${column.id}"]`);
    if (col) col.style.width = next + "px";
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    saveColumnWidths();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function renderColgroup() {
  const colgroup = document.getElementById("results-colgroup");
  colgroup.innerHTML = "";
  for (const col of COLUMNS) {
    const colEl = document.createElement("col");
    colEl.dataset.colId = col.id;
    colEl.style.width = columnWidths[col.id] + "px";
    colgroup.appendChild(colEl);
  }
}

function renderTableHead() {
  const thead = document.getElementById("results-thead");
  thead.innerHTML = "";
  const tr = document.createElement("tr");

  for (const column of COLUMNS) {
    const th = document.createElement("th");
    th.className = "resizable-th";

    const label = document.createElement("span");
    label.className = "th-label";
    label.textContent = column.label;
    if (column.getSortValue) {
      label.classList.add("sortable");
      label.title = "Click to sort";
      label.addEventListener("click", () => {
        sortDirection = sortColumn === column.id && sortDirection === "asc" ? "desc" : "asc";
        sortColumn = column.id;
        renderTableFromScratch();
      });
    }
    th.appendChild(label);

    if (sortColumn === column.id) {
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.textContent = sortDirection === "asc" ? " ▲" : " ▼";
      th.appendChild(arrow);
    }

    if (columnFilters[column.id]) {
      const filterDot = document.createElement("span");
      filterDot.className = "filter-active-dot";
      filterDot.title = `Filtered: "${columnFilters[column.id]}"`;
      th.appendChild(filterDot);
    }

    if (column.getSortValue || column.getFilterText) {
      const menuBtn = document.createElement("button");
      menuBtn.type = "button";
      menuBtn.className = "col-menu-btn";
      menuBtn.textContent = "▾";
      menuBtn.title = "Sort / Filter this column";
      menuBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleColumnMenu(column, th);
      });
      th.appendChild(menuBtn);
    }

    const handle = document.createElement("span");
    handle.className = "col-resize-handle";
    handle.addEventListener("mousedown", (event) => startColumnResize(event, column));
    th.appendChild(handle);

    tr.appendChild(th);
  }

  thead.appendChild(tr);
}

function buildRow(lead) {
  const tr = document.createElement("tr");
  for (const column of COLUMNS) {
    const td = document.createElement("td");
    column.render(td, lead);
    tr.appendChild(td);
  }
  return tr;
}

function renderPaginationControls(totalLeads) {
  const totalPages = pageSize === "all" ? 1 : Math.max(1, Math.ceil(totalLeads / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  document.getElementById("page-indicator").textContent = `Page ${currentPage} of ${totalPages}`;
  document.getElementById("page-first-btn").disabled = currentPage <= 1;
  document.getElementById("page-prev-btn").disabled = currentPage <= 1;
  document.getElementById("page-next-btn").disabled = currentPage >= totalPages;
  document.getElementById("page-last-btn").disabled = currentPage >= totalPages;
}

function renderTable() {
  renderColgroup();
  renderTableHead();

  const leads = applyFilterSortSearch();
  const anyColumnFilter = Object.values(columnFilters).some((v) => v && v.trim());
  const filtered = anyColumnFilter || statusFilter !== "all" || searchText.trim() || !showIrrelevant;
  resultCountEl.textContent = `${leads.length} of ${allLeads.length} leads${filtered ? " (filtered)" : ""}`;

  renderPaginationControls(leads.length);

  tbody.innerHTML = "";
  if (leads.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = COLUMNS.length;
    td.className = "empty-state";
    td.textContent = allLeads.length === 0 ? "No leads yet. Run a scan from the side panel." : "No leads match your filters.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const pageLeads = pageSize === "all"
    ? leads
    : leads.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  for (const lead of pageLeads) tbody.appendChild(buildRow(lead));
}

// Any change to what's being shown (search, a filter, sort, status) should
// land the user back on page 1 - otherwise "page 3" from a previous, larger
// result set could now be empty or show unrelated rows.
function renderTableFromScratch() {
  currentPage = 1;
  renderTable();
}

function populateStatusFilterOptions() {
  for (const s of LEAD_STATUSES) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    statusFilterSelect.appendChild(opt);
    // Deliberately no default selection (the dialog's placeholder option
    // stays selected) - a bulk action should require an explicit choice,
    // not inherit whatever the last picked status happened to be.
    const bulkOpt = document.createElement("option");
    bulkOpt.value = s;
    bulkOpt.textContent = s;
    bulkStatusSelect.appendChild(bulkOpt);
  }
}

// ---------------------------------------------------------------------
// Detail view - full lead info, status control, Draft Message, and a
// lead-scoped Sales Mentor consultation. Reachable via #lead=<key> so it's
// deep-linkable and survives back/forward navigation.
// ---------------------------------------------------------------------

function openDetail(key, focus) {
  location.hash = `lead=${encodeURIComponent(key)}${focus ? `&focus=${focus}` : ""}`;
}

function parseHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return { lead: params.get("lead"), focus: params.get("focus") };
}

function showListView() {
  listViewEl.hidden = false;
  detailViewEl.hidden = true;
}

function renderDetail(lead) {
  currentDetailLead = lead;
  mentorHistory = lead.mentorHistory || [];

  document.getElementById("detail-title").textContent = leadTitle(lead);
  document.getElementById("detail-meta").textContent =
    `${leadSourceLabel(lead)} · ${leadCreatorName(lead)} · found ${formatDateTime(lead.firstSeenAt)}`;

  const statusSelect = document.getElementById("detail-status-select");
  statusSelect.innerHTML = "";
  for (const s of LEAD_STATUSES) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    statusSelect.appendChild(opt);
  }
  statusSelect.value = lead.status || "New";

  document.getElementById("detail-full-content").textContent = leadContent(lead) || "(no content captured)";

  const linksEl = document.getElementById("detail-links");
  linksEl.innerHTML = "";
  const primaryUrl = lead.type === "job" ? lead.jobUrl : lead.postUrl;
  if (primaryUrl) linksEl.appendChild(makeLink(primaryUrl, lead.type === "job" ? "View Job" : "View Post"));
  if (lead.type !== "job" && lead.profileUrl) linksEl.appendChild(makeLink(lead.profileUrl, "View Profile"));

  const draftSection = document.getElementById("detail-draft-section");
  if (lead.type === "job") {
    draftSection.style.display = "none";
  } else {
    draftSection.style.display = "";
    const templateSelect = document.getElementById("detail-template-select");
    templateSelect.innerHTML = "";
    for (const t of messageTemplates) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      templateSelect.appendChild(opt);
    }
    templateSelect.value = lead.draftTemplateId || pickDefaultTemplateId(lead, messageTemplates);
    document.getElementById("detail-draft-textarea").value = lead.draftMessage || "";
    document.getElementById("detail-draft-status").textContent = "";
  }

  renderMentorHistory();
  document.getElementById("detail-mentor-status").textContent = "";
}

function showDetailView(lead, focus) {
  listViewEl.hidden = true;
  detailViewEl.hidden = false;
  renderDetail(lead);
  if (focus === "mentor") document.getElementById("detail-mentor-input").focus();
  else if (focus === "draft") document.getElementById("detail-draft-btn").focus();
}

function route() {
  const { lead: key, focus } = parseHash();
  if (key) {
    const lead = allLeads.find((l) => l.key === key);
    if (lead) {
      showDetailView(lead, focus);
      return;
    }
  }
  showListView();
}

document.getElementById("back-to-list-link").addEventListener("click", (event) => {
  event.preventDefault();
  location.hash = "";
});

document.getElementById("detail-status-select").addEventListener("change", async (event) => {
  if (!currentDetailLead) return;
  await updateLeadStatus(currentDetailLead.key, event.target.value);
  await loadLeads();
  currentDetailLead = allLeads.find((l) => l.key === currentDetailLead.key) || currentDetailLead;
  renderAllPieCharts();
  renderTable();
});

document.getElementById("detail-draft-btn").addEventListener("click", async () => {
  if (!currentDetailLead) return;
  const btn = document.getElementById("detail-draft-btn");
  const statusEl = document.getElementById("detail-draft-status");
  const textarea = document.getElementById("detail-draft-textarea");
  const templateId = document.getElementById("detail-template-select").value;
  btn.disabled = true;
  statusEl.textContent = "Drafting…";
  try {
    const settings = await currentSettings();
    textarea.value = await generateDraft(currentDetailLead, templateId, settings);
    statusEl.textContent = "";
    currentDetailLead.draftMessage = textarea.value;
    currentDetailLead.draftTemplateId = templateId;
  } catch (err) {
    statusEl.textContent = `Couldn't draft a message: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("detail-copy-btn").addEventListener("click", async () => {
  const textarea = document.getElementById("detail-draft-textarea");
  if (!textarea.value.trim()) return;
  await navigator.clipboard.writeText(textarea.value);
  const statusEl = document.getElementById("detail-draft-status");
  statusEl.textContent = "Copied — paste it into LinkedIn's message box and review before sending.";
  setTimeout(() => {
    if (statusEl.textContent.startsWith("Copied")) statusEl.textContent = "";
  }, 4000);

  // Copying a draft is the clearest signal we actually have that the lead is
  // about to be contacted (we can't see LinkedIn's own send button) - only
  // auto-advances from "New" specifically, so it never overwrites a status
  // someone already set on purpose (Dismissed, Responded, Converted, or an
  // already-"Contacted" lead being copied again).
  if (currentDetailLead && currentDetailLead.status === "New") {
    await updateLeadStatus(currentDetailLead.key, "Contacted");
    currentDetailLead.status = "Contacted";
    document.getElementById("detail-status-select").value = "Contacted";
    await loadLeads();
    renderAllPieCharts();
  }
});

function appendMentorBubble(kind, text) {
  const historyEl = document.getElementById("detail-mentor-history");
  const bubble = document.createElement("div");
  bubble.className = `agent-bubble agent-bubble-${kind}`;
  bubble.textContent = text;
  historyEl.appendChild(bubble);
  historyEl.scrollTop = historyEl.scrollHeight;
}

function renderMentorHistory() {
  const historyEl = document.getElementById("detail-mentor-history");
  historyEl.innerHTML = "";
  for (const message of mentorHistory) {
    if (message.role === "user" && typeof message.content === "string") {
      appendMentorBubble("you", message.content);
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) appendMentorBubble("agent", block.text);
        else if (block.type === "tool_use") appendMentorBubble("tool", `🔧 Checking: ${block.name}`);
      }
    }
  }
}

async function sendMentorMessage() {
  if (!currentDetailLead) return;
  const sendBtn = document.getElementById("detail-mentor-send-btn");
  // The Enter-key shortcut below calls sendMentorMessage() directly,
  // bypassing the browser's own disabled-button protection - without this
  // guard, a stray Enter while a turn is still in flight starts a second
  // runAgentTurn concurrently, racing on the same shared mentorHistory array
  // and silently losing or scrambling whichever message loses the race.
  if (sendBtn.disabled) return;
  const leadKey = currentDetailLead.key; // captured now - currentDetailLead may be swapped mid-turn by a draft_message refresh
  const input = document.getElementById("detail-mentor-input");
  const statusEl = document.getElementById("detail-mentor-status");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
  sendBtn.disabled = true;
  try {
    const settings = await currentSettings();
    await runAgentTurn(text, {
      history: mentorHistory,
      apiKey,
      buildSystemPrompt: () => buildLeadScopedMentorPrompt(currentDetailLead, { mentorPersona, companyContext, outputLanguage }),
      tools: currentDetailLead.type === "job" ? [] : [DRAFT_MESSAGE_TOOL],
      executeTool: async (name, input2) => {
        if (name === "draft_message") {
          return toolDraftMessage(input2, settings, async () => {
            await loadLeads();
            currentDetailLead = allLeads.find((l) => l.key === currentDetailLead.key) || currentDetailLead;
            const textarea = document.getElementById("detail-draft-textarea");
            if (currentDetailLead.draftMessage) textarea.value = currentDetailLead.draftMessage;
          });
        }
        return { error: `Unknown tool: ${name}` };
      },
      saveHistory: (history) => updateLeadMentorHistory(leadKey, history),
      onStatus: (msg) => { statusEl.textContent = msg; },
      onProgress: renderMentorHistory,
    });
  } finally {
    sendBtn.disabled = false;
  }
}

document.getElementById("detail-mentor-send-btn").addEventListener("click", sendMentorMessage);
document.getElementById("detail-mentor-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMentorMessage();
  }
});

document.getElementById("detail-mentor-clear-btn").addEventListener("click", async () => {
  if (!currentDetailLead) return;
  if (!confirm("Clear this conversation? This can't be undone.")) return;
  mentorHistory = [];
  await updateLeadMentorHistory(currentDetailLead.key, []);
  renderMentorHistory();
});

// ---------------------------------------------------------------------
// CSV export - same idea as the side panel's, kept small and local here
// rather than shared, since the two column sets differ (this one includes
// Status; the side panel's includes drafting/badge detail this view
// already shows visually instead of in the file).
// ---------------------------------------------------------------------

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportLeadsToCsv(leads, filenameTag) {
  if (leads.length === 0) {
    alert("No leads to export.");
    return;
  }
  const headers = ["Post Date", "First Scanned", "Source", "Title", "Content", "Creator", "Connection", "Status", "Priority", "URL"];
  const rows = leads.map((lead) => [
    formatDateTime(leadDate(lead)),
    formatDateTime(lead.firstSeenAt),
    leadSourceLabel(lead),
    leadTitle(lead),
    leadContent(lead),
    leadCreatorName(lead),
    lead.connectionDegree || "",
    lead.status || "New",
    leadPriorityLabel(lead),
    leadCreatorUrl(lead) || (lead.type === "job" ? lead.jobUrl : lead.postUrl) || "",
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `salesteam-leads-${filenameTag}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById("export-csv-all-btn").addEventListener("click", () => {
  exportLeadsToCsv(allLeads, "all");
});

// Catches up every lead the automatic per-scan pass never got to - leads
// that predate this feature, or a scan that finished with no API key
// configured yet. Scores ALL currently-unscored "New" leads regardless of
// the table's active filters (unlike Bulk Change below, which deliberately
// only touches what's filtered) - the whole point is to leave nothing behind.
prioritizeUnscoredBtn.addEventListener("click", async () => {
  const toScore = allLeads.filter((l) => l.status === "New" && !l.priority);
  if (toScore.length === 0) {
    prioritizeStatusEl.textContent = "Nothing to do - every \"New\" lead already has a priority.";
    return;
  }
  prioritizeUnscoredBtn.disabled = true;
  prioritizeStatusEl.textContent = `Prioritizing ${toScore.length} lead${toScore.length === 1 ? "" : "s"} with the Sales Mentor…`;
  try {
    const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
    if (!apiKey) {
      prioritizeStatusEl.textContent = "Add an Anthropic API key on the Settings page first.";
      return;
    }
    const priorities = await prioritizeLeads(toScore, { apiKey, mentorPersona, companyContext, outputLanguage });
    const changed = await applyLeadPriorities(priorities);
    prioritizeStatusEl.textContent = `Done - ${changed} lead${changed === 1 ? "" : "s"} scored.`;
    await loadLeads();
    renderAllPieCharts();
    renderTable();
  } catch (err) {
    prioritizeStatusEl.textContent = `Something went wrong: ${err.message}`;
  } finally {
    prioritizeUnscoredBtn.disabled = false;
  }
});

// "Filtered" means everything matching the current search/column filters/
// status filter, across every page - not just the rows currently visible on
// this one page of the table. Sort order doesn't affect which leads are
// included, only applyFilterSortSearch's filtering does, so this reuses it
// directly rather than re-deriving the filter logic.
document.getElementById("export-csv-filtered-btn").addEventListener("click", () => {
  exportLeadsToCsv(applyFilterSortSearch(), "filtered");
});

// Applies to everything the current search/status/column filters are
// showing - across all pages, not just the one on screen - e.g. filter to
// Priority "P4"/"P5", then bulk-dismiss the lot in one action instead of
// clicking Dismiss on each row.
// Tucked behind a small button + a real modal (rather than inline in the
// main controls row) specifically because this changes many leads at once -
// easy to fat-finger if it were as accessible as Export/Dismiss. The dialog
// itself carries a red warning, requires an explicit status choice (no
// default), and the confirm() below is a second, deliberate speed bump on
// top of that - plus a same-session Undo as a last resort if someone still
// gets past both.
async function refreshUndoButtonState() {
  const record = await getLastBulkChange();
  bulkUndoBtn.disabled = !record;
  bulkUndoText.textContent = record
    ? `Last bulk change: ${Object.keys(record.previousStatuses).length} lead(s) → "${record.newStatus}" on ${new Date(record.timestamp).toLocaleString()}.`
    : "Nothing to undo.";
}

openBulkChangeBtn.addEventListener("click", async () => {
  const filteredLeads = applyFilterSortSearch();
  document.getElementById("bulk-dialog-count").textContent = String(filteredLeads.length);
  document.getElementById("bulk-dialog-count-plural").textContent = filteredLeads.length === 1 ? "" : "s";
  bulkStatusSelect.value = "";
  bulkStatusText.textContent = "";
  await refreshUndoButtonState();
  bulkChangeDialog.showModal();
});

bulkCancelBtn.addEventListener("click", () => {
  bulkChangeDialog.close();
});

document.getElementById("bulk-close-x-btn").addEventListener("click", () => {
  bulkChangeDialog.close();
});

bulkApplyBtn.addEventListener("click", async () => {
  const targetStatus = bulkStatusSelect.value;
  if (!targetStatus) {
    bulkStatusText.textContent = "Choose a status first.";
    return;
  }
  const filteredLeads = applyFilterSortSearch();
  if (filteredLeads.length === 0) {
    bulkStatusText.textContent = "No leads match the current filters.";
    return;
  }
  if (!confirm(`Change ${filteredLeads.length} currently-filtered lead${filteredLeads.length === 1 ? "" : "s"} to "${targetStatus}"? You can undo this specific change from this same dialog afterward, but not once you've made another bulk change.`)) {
    return;
  }
  bulkApplyBtn.disabled = true;
  try {
    const changed = await bulkUpdateLeadStatus(filteredLeads.map((l) => l.key), targetStatus);
    bulkStatusText.textContent = `Done - ${changed} lead${changed === 1 ? "" : "s"} changed to "${targetStatus}".`;
    await refreshUndoButtonState();
    await loadLeads();
    renderAllPieCharts();
    renderTableFromScratch();
  } finally {
    bulkApplyBtn.disabled = false;
  }
});

bulkUndoBtn.addEventListener("click", async () => {
  bulkUndoBtn.disabled = true;
  try {
    const restored = await undoLastBulkChange();
    bulkUndoText.textContent = restored > 0 ? `Undone - ${restored} lead(s) restored to their previous status.` : "Nothing to undo.";
    await loadLeads();
    renderAllPieCharts();
    renderTableFromScratch();
  } finally {
    await refreshUndoButtonState();
  }
});

// ---------------------------------------------------------------------
// Wiring + init
// ---------------------------------------------------------------------

searchInput.addEventListener("input", (event) => {
  searchText = event.target.value;
  renderTableFromScratch();
});

statusFilterSelect.addEventListener("change", (event) => {
  statusFilter = event.target.value;
  renderTableFromScratch();
});

showIrrelevantCheckbox.addEventListener("change", () => {
  showIrrelevant = showIrrelevantCheckbox.checked;
  try {
    localStorage.setItem(SHOW_IRRELEVANT_STORAGE_KEY, String(showIrrelevant));
  } catch {
    // best-effort only - a display preference isn't worth surfacing an error for
  }
  renderTableFromScratch();
});

document.getElementById("page-size-select").addEventListener("change", (event) => {
  pageSize = event.target.value === "all" ? "all" : parseInt(event.target.value, 10);
  try {
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(pageSize));
  } catch {
    // best-effort only - not worth surfacing an error for a UI preference
  }
  renderTableFromScratch();
});

document.getElementById("page-first-btn").addEventListener("click", () => {
  currentPage = 1;
  renderTable();
});

document.getElementById("page-prev-btn").addEventListener("click", () => {
  currentPage = Math.max(1, currentPage - 1);
  renderTable();
});

document.getElementById("page-next-btn").addEventListener("click", () => {
  currentPage = currentPage + 1;
  renderTable();
});

document.getElementById("page-last-btn").addEventListener("click", () => {
  currentPage = Number.MAX_SAFE_INTEGER; // clamped to the real last page inside renderPaginationControls
  renderTable();
});

window.addEventListener("hashchange", route);

// Keeps the Dashboard live if a scan completes (or a lead's status/draft
// changes) while this tab is open, e.g. run from the side panel in another
// tab at the same time.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.results) return;
  loadLeads().then(() => {
    renderAllPieCharts();
    renderTable();
  });
});

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
  loadColumnWidths();
  loadPageSize();
  loadShowIrrelevant();
  await loadSettings();
  await loadLeads();
  populateStatusFilterOptions();
  renderAllPieCharts();
  renderTable();
  route();
}

init();
