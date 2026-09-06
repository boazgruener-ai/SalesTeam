// Target Accounts Explorer: browses the full multi-sheet workbook imported
// on the Settings page (storage.js's importTargetAccountsWorkbook) - the
// Companies sheet as the master table, with each row expandable to show its
// related Contacts/AI_Initiatives/AI_Investment/Sources rows, joined
// client-side by Company_ID (camelCased companyId). See PRD 6.12. This is a
// separate, richer dataset from the lightweight targetAccounts map (6.11)
// that drives auto-prioritization - importing the same .xlsx on Settings
// populates both in one action.
import { getTargetAccountsWorkbook } from "./storage.js";

const emptyStateEl = document.getElementById("empty-state");
const controlsEl = document.getElementById("explorer-controls");
const tableWrapEl = document.getElementById("table-wrap");
const searchInputEl = document.getElementById("search-input");
const columnsBtn = document.getElementById("columns-btn");
const resultCountEl = document.getElementById("result-count");
const colgroupEl = document.getElementById("companies-colgroup");
const theadEl = document.getElementById("companies-thead");
const tbodyEl = document.getElementById("companies-tbody");

let workbook = { companies: [], contacts: [], aiInitiatives: [], aiInvestment: [], sources: [] };
let sortField = "aiPriorityScore";
let sortDirection = "desc";
let expandedCompanyId = null;
let openMenuColumnId = null;
let columnFilters = {}; // { [columnId]: { text, exclude } }
let hiddenColumns = new Set();

// Every column of the Companies sheet (v0.29.3) - the twelve marked visible
// below are the ones a salesperson looks at day to day; the rest (mostly
// confidence/period/scoring-methodology fields, useful for judging data
// quality rather than for triage) start hidden but are one click away via
// the Columns button or a column's own "Hide This Column" menu item.
const COMPANY_COLUMNS = [
  { id: "company", label: "Company", visible: true },
  { id: "industry", label: "Industry", visible: true },
  { id: "companyType", label: "Type", visible: true },
  { id: "globalEmployees", label: "Global Employees", visible: true, numeric: true },
  { id: "swissEmployees", label: "Swiss Employees", visible: true, numeric: true },
  { id: "globalRevenue", label: "Global Revenue", visible: true, numeric: true, currencyField: "revenueCurrency" },
  { id: "swissRevenue", label: "Swiss Revenue", visible: true, numeric: true, currencyField: "swissRevenueCurrency" },
  { id: "aiPriorityScore", label: "AI Score", visible: true, numeric: true },
  { id: "aiPriority", label: "AI Priority", visible: true, pill: true },
  { id: "evidenceCoverage", label: "Evidence Coverage", visible: true, percent: true },
  { id: "researchStatus", label: "Research Status", visible: true },
  { id: "priorityRationale", label: "Priority Rationale", visible: true, longText: true },
  // Hidden by default - available via the Columns button.
  { id: "prospectStatus", label: "Prospect Status" },
  { id: "globalHqCity", label: "Global HQ City" },
  { id: "globalHqCountry", label: "Global HQ Country" },
  { id: "mainSwissLocation", label: "Main Swiss Location" },
  { id: "swissDecisionAuthority", label: "Swiss Decision Authority" },
  { id: "revenuePeriod", label: "Revenue Period" },
  { id: "globalRevenueConfidence", label: "Global Revenue Confidence" },
  { id: "swissRevenuePeriod", label: "Swiss Revenue Period" },
  { id: "swissRevenueConfidence", label: "Swiss Revenue Confidence" },
  { id: "globalEmployeesPeriod", label: "Global Employees Period" },
  { id: "globalEmployeesConfidence", label: "Global Employees Confidence" },
  { id: "swissEmployeesPeriod", label: "Swiss Employees Period" },
  { id: "swissEmployeesConfidence", label: "Swiss Employees Confidence" },
  { id: "aiInvestmentGlobal", label: "AI Investment (Global)" },
  { id: "aiInvestmentSwitzerland", label: "AI Investment (Switzerland)" },
  { id: "aiInvestmentConfidence", label: "AI Investment Confidence" },
  { id: "topAiInitiatives", label: "Top AI Initiatives", longText: true },
  { id: "relevantContactsCount", label: "Relevant Contacts Count", numeric: true },
  { id: "swissSizeFitScore", label: "Swiss Size Fit Score", numeric: true },
  { id: "decisionAuthorityScore", label: "Decision Authority Score", numeric: true },
  { id: "aiMaturityFitScore", label: "AI Maturity Fit Score", numeric: true },
  { id: "aiInvestmentScore", label: "AI Investment Score", numeric: true },
  { id: "contactAccessScore", label: "Contact Access Score", numeric: true },
  { id: "aiUseCaseFitScore", label: "AI Use Case Fit Score", numeric: true },
  { id: "researchQuality", label: "Research Quality" },
  { id: "primarySourceUrl", label: "Primary Source", link: true },
  { id: "lastVerified", label: "Last Verified", date: true },
  { id: "aiPortfolioProfile", label: "AI Portfolio Profile" },
  { id: "aiPortfolioProfileConfidence", label: "AI Portfolio Profile Confidence" },
  { id: "companyId", label: "Company ID" },
  { id: "universeOrder", label: "Universe Order", numeric: true },
];

const CONTACT_COLUMNS = [
  { label: "Contact ID", field: "contactId" },
  { label: "Name", field: "fullName" },
  { label: "Job Title", field: "jobTitle" },
  { label: "Function", field: "function" },
  { label: "Seniority", field: "seniority" },
  { label: "AI Relevance", field: "aiRelevance" },
  { label: "Swiss Based", field: "swissBased" },
  { label: "City", field: "city" },
  { label: "Country", field: "country" },
  { label: "Business Email", field: "publicBusinessEmail" },
  { label: "Profile", field: "profileUrl", link: true, linkLabel: "LinkedIn ↗" },
  { label: "Source", field: "sourceUrl", link: true },
  { label: "Last Verified", field: "lastVerified", date: true },
  { label: "Evidence Quality", field: "evidenceQuality" },
];

const INITIATIVE_COLUMNS = [
  { label: "Initiative ID", field: "initiativeId" },
  { label: "Initiative", field: "initiativeName" },
  { label: "Category", field: "aiCategory" },
  { label: "Scope", field: "scope" },
  { label: "Business Function", field: "businessFunction" },
  { label: "Description", field: "description" },
  { label: "Status", field: "status" },
  { label: "Announced", field: "announcedDate", date: true },
  { label: "Investment Amount", field: "investmentAmount" },
  { label: "Currency", field: "currency" },
  { label: "Technology/Partner", field: "technologyOrPartner" },
  { label: "Source", field: "sourceUrl", link: true },
  { label: "Last Verified", field: "lastVerified", date: true },
  { label: "Evidence Quality", field: "evidenceQuality" },
];

const INVESTMENT_COLUMNS = [
  { label: "Year", field: "year" },
  { label: "Scope", field: "scope" },
  { label: "Amount Low", field: "amountLow" },
  { label: "Amount High", field: "amountHigh" },
  { label: "Currency", field: "currency" },
  { label: "Source", field: "sourceUrl", link: true },
];

const SOURCE_COLUMNS = [
  { label: "Type", field: "sourceType" },
  { label: "Title", field: "sourceTitle" },
  { label: "Used For", field: "usedFor" },
  { label: "Evidence Quality", field: "evidenceQuality" },
  { label: "Link", field: "url", link: true },
];

const HIDDEN_COLUMNS_STORAGE_KEY = "salesteam-target-accounts-hidden-columns";

function loadHiddenColumns() {
  const defaultHidden = COMPANY_COLUMNS.filter((c) => !c.visible).map((c) => c.id);
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_COLUMNS_STORAGE_KEY));
    hiddenColumns = new Set(Array.isArray(saved) ? saved : defaultHidden);
  } catch {
    hiddenColumns = new Set(defaultHidden);
  }
}

function saveHiddenColumns() {
  try {
    localStorage.setItem(HIDDEN_COLUMNS_STORAGE_KEY, JSON.stringify([...hiddenColumns]));
  } catch {
    // best-effort only - a column-visibility preference isn't worth surfacing an error for
  }
}

function visibleColumns() {
  return COMPANY_COLUMNS.filter((c) => !hiddenColumns.has(c.id));
}

// Always leaves at least one column visible - hiding every column would
// leave a table with an unrecoverable, empty-looking header.
function setColumnHidden(columnId, hidden) {
  if (hidden && COMPANY_COLUMNS.length - hiddenColumns.size <= 1) return false;
  if (hidden) hiddenColumns.add(columnId);
  else hiddenColumns.delete(columnId);
  saveHiddenColumns();
  renderTable();
  return true;
}

function formatNumber(value) {
  if (value == null || value === "") return "—";
  const num = typeof value === "number" ? value : parseFloat(value);
  return Number.isNaN(num) ? String(value) : num.toLocaleString();
}

function formatValue(value) {
  if (value == null || value === "") return "—";
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}

// xlsx-lite.js deliberately doesn't read styles.xml (see its own file
// comment), so a date-formatted cell comes through as its raw numeric serial
// (days since 1899-12-30, Excel's own epoch) rather than a date string - a
// field like Last_Verified would otherwise render as a meaningless number
// like 46270. Only applied to fields already known to be dates, not blindly
// to every number, since plenty of other numeric fields (scores, employee
// counts) aren't dates and would be misread as one.
function formatExcelDate(value) {
  if (typeof value !== "number") return formatValue(value);
  const ms = Date.UTC(1899, 11, 30) + value * 86400000;
  return new Date(ms).toLocaleDateString();
}

function priorityPillClass(label) {
  if (!label) return "priority-pill-other";
  const normalized = label.toLowerCase();
  if (normalized.startsWith("very high")) return "priority-pill-veryhigh";
  if (normalized.startsWith("high")) return "priority-pill-high";
  return "priority-pill-other";
}

function rawValue(company, column) {
  return company[column.id];
}

function sortValue(company, column) {
  const v = rawValue(company, column);
  if (column.numeric || column.date) return typeof v === "number" ? v : (v == null || v === "" ? null : parseFloat(v));
  return v == null ? "" : String(v).toLowerCase();
}

function filterText(company, column) {
  const v = rawValue(company, column);
  return v == null ? "" : String(v).toLowerCase();
}

function matchesGlobalSearch(company, query) {
  if (!query) return true;
  const haystack = `${company.company || ""} ${company.industry || ""}`.toLowerCase();
  return haystack.includes(query);
}

function matchesColumnFilters(company) {
  for (const [colId, filter] of Object.entries(columnFilters)) {
    if (!filter || !filter.text) continue;
    const column = COMPANY_COLUMNS.find((c) => c.id === colId);
    if (!column) continue;
    const contains = filterText(company, column).includes(filter.text.toLowerCase());
    if (filter.exclude ? contains : !contains) return false;
  }
  return true;
}

function sortedFilteredCompanies() {
  const query = searchInputEl.value.trim().toLowerCase();
  const sortCol = COMPANY_COLUMNS.find((c) => c.id === sortField);
  const filtered = workbook.companies.filter((c) => matchesGlobalSearch(c, query) && matchesColumnFilters(c));
  if (sortCol) {
    filtered.sort((a, b) => {
      const va = sortValue(a, sortCol);
      const vb = sortValue(b, sortCol);
      if ((va == null || va === "") && (vb == null || vb === "")) return 0;
      if (va == null || va === "") return 1;
      if (vb == null || vb === "") return -1;
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sortDirection === "asc" ? cmp : -cmp;
    });
  }
  return filtered;
}

function renderCellContent(td, company, column) {
  const value = rawValue(company, column);

  if (column.pill) {
    if (!value) { td.textContent = "—"; return; }
    const pill = document.createElement("span");
    pill.className = `priority-pill ${priorityPillClass(value)}`;
    pill.textContent = value;
    td.appendChild(pill);
    return;
  }
  if (column.link) {
    if (!value) { td.textContent = "—"; return; }
    const a = document.createElement("a");
    a.href = value;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Open ↗";
    td.appendChild(a);
    return;
  }

  let text;
  if (column.date) text = formatExcelDate(value);
  else if (column.percent) text = value == null || value === "" ? "—" : `${Math.round(value * 100)}%`;
  else if (column.numeric) {
    text = formatNumber(value);
    if (column.currencyField && value != null && value !== "") text = `${text} ${company[column.currencyField] || ""}`.trim();
  } else {
    text = formatValue(value);
  }

  if (column.longText) {
    td.className = "long-text-cell";
    td.textContent = text;
    if (value) {
      td.title = "Click to expand/collapse";
      td.addEventListener("click", (e) => { e.stopPropagation(); td.classList.toggle("expanded"); });
    }
  } else {
    td.textContent = text;
  }
}

function buildSubtable(title, rows, columns) {
  const section = document.createElement("div");
  const heading = document.createElement("div");
  heading.className = "detail-section-title";
  heading.textContent = `${title} (${rows.length})`;
  section.appendChild(heading);

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "detail-empty-note";
    empty.textContent = "None on record.";
    section.appendChild(empty);
    return section;
  }

  const table = document.createElement("table");
  table.className = "detail-subtable";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const col of columns) {
      const td = document.createElement("td");
      if (col.link && row[col.field]) {
        const a = document.createElement("a");
        a.href = row[col.field];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = col.linkLabel || "Open ↗";
        td.appendChild(a);
      } else {
        td.textContent = col.date ? formatExcelDate(row[col.field]) : formatValue(row[col.field]);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const wrap = document.createElement("div");
  wrap.className = "detail-subtable-wrap";
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

function buildDetailContent(company) {
  const wrap = document.createElement("div");

  if (company.primarySourceUrl) {
    const link = document.createElement("a");
    link.href = company.primarySourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Primary source ↗";
    wrap.appendChild(link);
    wrap.appendChild(document.createElement("br"));
    wrap.appendChild(document.createElement("br"));
  }

  const contacts = workbook.contacts.filter((c) => c.companyId === company.companyId);
  wrap.appendChild(buildSubtable("Contacts", contacts, CONTACT_COLUMNS));

  const initiatives = workbook.aiInitiatives.filter((i) => i.companyId === company.companyId);
  wrap.appendChild(buildSubtable("AI Initiatives", initiatives, INITIATIVE_COLUMNS));

  const investments = workbook.aiInvestment.filter((v) => v.companyId === company.companyId);
  if (investments.length > 0) wrap.appendChild(buildSubtable("AI Investment", investments, INVESTMENT_COLUMNS));

  const sources = workbook.sources.filter((s) => s.companyId === company.companyId);
  if (sources.length > 0) wrap.appendChild(buildSubtable("Sources", sources, SOURCE_COLUMNS));

  return wrap;
}

function closeColumnMenu() {
  openMenuColumnId = null;
  document.querySelectorAll(".col-menu-popup").forEach((el) => el.remove());
}

function onDocumentClickCloseMenu(event) {
  if (!event.target.closest(".col-menu-popup") && !event.target.closest(".col-menu-btn") && !event.target.closest("#columns-btn")) {
    closeColumnMenu();
  } else if (openMenuColumnId || document.querySelector(".columns-panel")) {
    document.addEventListener("click", onDocumentClickCloseMenu, { once: true });
  }
}

// Combined sort/filter/hide menu per column - filter supports an "exclude"
// mode (e.g. hide every company whose AI Priority contains "Insufficient
// Evidence") since the plain "contains" search box alone can only narrow
// down to matches, not away from them.
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

  const ascBtn = document.createElement("button");
  ascBtn.className = "col-menu-item";
  ascBtn.textContent = "Sort Ascending";
  ascBtn.addEventListener("click", () => {
    sortField = column.id;
    sortDirection = "asc";
    closeColumnMenu();
    renderTable();
  });
  const descBtn = document.createElement("button");
  descBtn.className = "col-menu-item";
  descBtn.textContent = "Sort Descending";
  descBtn.addEventListener("click", () => {
    sortField = column.id;
    sortDirection = "desc";
    closeColumnMenu();
    renderTable();
  });
  popup.append(ascBtn, descBtn, document.createElement("hr"));

  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.className = "col-filter-input";
  filterInput.placeholder = `Filter ${column.label}…`;
  filterInput.value = columnFilters[column.id]?.text || "";

  const excludeLabel = document.createElement("label");
  excludeLabel.className = "col-filter-exclude-label";
  const excludeCheckbox = document.createElement("input");
  excludeCheckbox.type = "checkbox";
  excludeCheckbox.checked = columnFilters[column.id]?.exclude || false;
  excludeLabel.append(excludeCheckbox, document.createTextNode('Exclude matches (e.g. hide "Insufficient Evidence")'));

  const applyFilter = () => {
    const text = filterInput.value.trim();
    columnFilters[column.id] = text ? { text, exclude: excludeCheckbox.checked } : null;
    closeColumnMenu();
    renderTable();
  };
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyFilter();
  });

  const actionsRow = document.createElement("div");
  actionsRow.className = "col-menu-actions";
  const applyBtn = document.createElement("button");
  applyBtn.title = `Filter the table by this column`;
  applyBtn.textContent = "Apply";
  applyBtn.addEventListener("click", applyFilter);
  const clearBtn = document.createElement("button");
  clearBtn.title = "Remove this column's filter";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    delete columnFilters[column.id];
    closeColumnMenu();
    renderTable();
  });
  actionsRow.append(applyBtn, clearBtn);
  popup.append(filterInput, excludeLabel, actionsRow, document.createElement("hr"));

  const hideBtn = document.createElement("button");
  hideBtn.className = "col-menu-item";
  hideBtn.title = `Hide the ${column.label} column - bring it back from the Columns button`;
  hideBtn.textContent = "Hide This Column";
  hideBtn.addEventListener("click", () => {
    closeColumnMenu();
    setColumnHidden(column.id, true);
  });
  popup.appendChild(hideBtn);

  document.body.appendChild(popup);
  const popupWidth = popup.offsetWidth;
  const left = Math.min(anchorRect.right - popupWidth, window.innerWidth - popupWidth - 8);
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top = `${anchorRect.bottom + 2}px`;

  setTimeout(() => document.addEventListener("click", onDocumentClickCloseMenu, { once: true }), 0);
}

function toggleColumnsPanel() {
  if (document.querySelector(".columns-panel")) {
    closeColumnMenu();
    return;
  }
  closeColumnMenu();

  const anchorRect = columnsBtn.getBoundingClientRect();
  const popup = document.createElement("div");
  popup.className = "col-menu-popup columns-panel";

  for (const column of COMPANY_COLUMNS) {
    const row = document.createElement("label");
    row.className = "columns-panel-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !hiddenColumns.has(column.id);
    checkbox.addEventListener("change", () => {
      if (!setColumnHidden(column.id, !checkbox.checked)) checkbox.checked = true;
    });
    row.append(checkbox, document.createTextNode(column.label));
    popup.appendChild(row);
  }

  document.body.appendChild(popup);
  const popupWidth = popup.offsetWidth;
  const left = Math.min(anchorRect.right - popupWidth, window.innerWidth - popupWidth - 8);
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top = `${anchorRect.bottom + 2}px`;

  setTimeout(() => document.addEventListener("click", onDocumentClickCloseMenu, { once: true }), 0);
}

columnsBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleColumnsPanel();
});

function renderColgroup() {
  colgroupEl.innerHTML = "";
  for (const col of visibleColumns()) {
    const colEl = document.createElement("col");
    if (col.longText) colEl.style.width = "260px";
    colgroupEl.appendChild(colEl);
  }
}

function renderTableHead() {
  theadEl.innerHTML = "";
  const tr = document.createElement("tr");
  for (const column of visibleColumns()) {
    const th = document.createElement("th");

    const label = document.createElement("span");
    label.className = "th-label";
    label.textContent = column.label;
    label.title = "Click to sort";
    label.addEventListener("click", () => {
      sortDirection = sortField === column.id && sortDirection === "desc" ? "asc" : "desc";
      sortField = column.id;
      renderTable();
    });
    th.appendChild(label);

    if (sortField === column.id) {
      const arrow = document.createElement("span");
      arrow.textContent = sortDirection === "asc" ? " ▲" : " ▼";
      th.appendChild(arrow);
    }
    if (columnFilters[column.id]?.text) {
      const dot = document.createElement("span");
      dot.className = "filter-active-dot";
      const f = columnFilters[column.id];
      dot.title = `Filtered: "${f.text}"${f.exclude ? " (excluded)" : ""}`;
      th.appendChild(dot);
    }

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "col-menu-btn";
    menuBtn.textContent = "▾";
    menuBtn.title = "Sort / Filter / Hide this column";
    menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleColumnMenu(column, th);
    });
    th.appendChild(menuBtn);

    tr.appendChild(th);
  }
  theadEl.appendChild(tr);
}

function renderTable() {
  renderColgroup();
  renderTableHead();

  const companies = sortedFilteredCompanies();
  resultCountEl.textContent = `${companies.length} of ${workbook.companies.length} companies`;
  const cols = visibleColumns();

  tbodyEl.innerHTML = "";
  for (const company of companies) {
    const tr = document.createElement("tr");
    tr.className = "company-row";
    if (expandedCompanyId === company.companyId) tr.classList.add("expanded");

    for (const column of cols) {
      const td = document.createElement("td");
      renderCellContent(td, company, column);
      tr.appendChild(td);
    }
    tr.addEventListener("click", (event) => {
      if (event.target.closest("a") || event.target.closest(".long-text-cell")) return;
      expandedCompanyId = expandedCompanyId === company.companyId ? null : company.companyId;
      renderTable();
    });
    tbodyEl.appendChild(tr);

    if (expandedCompanyId === company.companyId) {
      const detailTr = document.createElement("tr");
      detailTr.className = "detail-row";
      const td = document.createElement("td");
      td.colSpan = cols.length;
      td.appendChild(buildDetailContent(company));
      detailTr.appendChild(td);
      tbodyEl.appendChild(detailTr);
    }
  }
}

searchInputEl.addEventListener("input", renderTable);

// Live-updates while this tab stays open, same reasoning as the Activity Log
// and Dashboard - re-importing on the Settings page shouldn't require a
// manual reload here to see the fresh data.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("targetAccountsWorkbook" in changes)) loadWorkbook();
});

async function loadWorkbook() {
  workbook = await getTargetAccountsWorkbook();
  const hasData = workbook.companies.length > 0;
  emptyStateEl.hidden = hasData;
  controlsEl.hidden = !hasData;
  tableWrapEl.hidden = !hasData;
  if (hasData) renderTable();
}

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
  loadHiddenColumns();
  await loadWorkbook();
}

init();
