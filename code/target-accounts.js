// Target Accounts Dashboard: browses the full multi-sheet workbook imported
// on the Settings page (storage.js's importTargetAccountsWorkbook). Three
// hash-routed views (PRD 6.19): the list view (Companies sheet as the
// master table, priority-sorted, flagged for an unreviewed post or overdue
// follow-up), an Account view (#account=<companyKey>) with related
// Contacts/AI_Initiatives/AI_Investment/Sources rows joined client-side by
// Company_ID (camelCased companyId), and a Contact view
// (#contact=<contactKey>). Both detail views carry their own persisted
// Sales Mentor/Customer Voice chat. This workbook is a separate, richer
// dataset from the lightweight targetAccounts map (6.11) that drives
// auto-prioritization - importing the same .xlsx on Settings populates both
// in one action.
import {
  getTargetAccountsWorkbook,
  getTargetAccountsMeta,
  getTargetAccounts,
  importTargetAccounts,
  importTargetAccountsWorkbook,
  exportTargetAccountsBackup,
  importTargetAccountsBackup,
  appendActivityLog,
  getResults,
  normalizeCompanyName,
  getTargetAccountExtra,
  getTargetAccountExtras,
  saveTargetAccountExtra,
  getTargetContactExtra,
  getTargetContactExtras,
  saveTargetContactExtra,
  contactKeyFor,
  findLeadsForContact,
  hasUnreviewedPost,
  hasOverdueAction,
  getActivityLogForCompany,
  getActivityLogForContact,
  getAnthropicApiKey,
  getMentorPersona,
  getCompanyContext,
  getIdealCustomerProfile,
  getOutputLanguage,
  getCustomerPersona,
} from "./storage.js";
import { parseFullTargetAccountsWorkbook } from "./xlsx-lite.js";
import {
  sanitizeApiKey,
  runAgentTurn,
  buildAccountScopedMentorPrompt,
  buildAccountScopedCustomerVoicePrompt,
  buildContactScopedMentorPrompt,
  buildContactScopedCustomerVoicePrompt,
} from "./agent-shared.js";

const emptyStateEl = document.getElementById("empty-state");
const controlsEl = document.getElementById("explorer-controls");
const tableWrapEl = document.getElementById("table-wrap");
const searchInputEl = document.getElementById("search-input");
const columnsBtn = document.getElementById("columns-btn");
const resultCountEl = document.getElementById("result-count");
const colgroupEl = document.getElementById("companies-colgroup");
const theadEl = document.getElementById("companies-thead");
const tbodyEl = document.getElementById("companies-tbody");
const importTargetAccountsPageBtn = document.getElementById("import-target-accounts-page-btn");
const importTargetAccountsPageFileInput = document.getElementById("import-target-accounts-page-file-input");
const exportTargetAccountsPageBtn = document.getElementById("export-target-accounts-page-btn");
const targetAccountsPageIoStatusEl = document.getElementById("target-accounts-page-io-status");
const linkedinResolveStatusEl = document.getElementById("linkedin-resolve-status");
const paginationTopEl = document.getElementById("pagination-top");
const paginationBottomEl = document.getElementById("pagination-bottom");
const tableScrollTopEl = document.getElementById("table-scroll-top");
const tableScrollTopFillerEl = document.getElementById("table-scroll-top-filler");
const companiesTableEl = document.getElementById("companies-table");
const accountsStatsSectionEl = document.getElementById("accounts-stats-section");

const listTabBarEl = document.getElementById("list-tab-bar");
const tabAccountsEl = document.getElementById("tab-accounts");
const tabContactsEl = document.getElementById("tab-contacts");

const listViewEl = document.getElementById("list-view");
const accountViewEl = document.getElementById("account-view");
const contactViewEl = document.getElementById("contact-view");

// Target Contacts Dashboard (PRD 6.19) - a second list view in this same
// page, deliberately its own parallel set of DOM refs/state/render
// functions rather than a generalized shared table widget. See the plan
// this shipped from for the full reasoning: the Companies table's
// sort/filter/hide-columns/pagination machinery is large, already working,
// and currently hardwired around COMPANY_COLUMNS/workbook.companies -
// generalizing it risks regressing a table the user already depends on
// daily, for a codebase-hygiene win alone. Purely generic cell-formatting
// helpers (formatValue/formatExcelDate/formatNumber/renderCellContent/
// rawValue/sortValue/filterText - none of them actually reference
// COMPANY_COLUMNS, just whatever column object they're given) ARE reused
// directly below, since duplicating those would be pure risk with no
// reuse-vs-risk tradeoff to weigh.
const contactsListViewEl = document.getElementById("contacts-list-view");
const contactsEmptyStateEl = document.getElementById("contacts-empty-state");
const contactsStatsSectionEl = document.getElementById("contacts-stats-section");
const contactsExplorerControlsEl = document.getElementById("contacts-explorer-controls");
const contactsSearchInputEl = document.getElementById("contacts-search-input");
const contactsColumnsBtn = document.getElementById("contacts-columns-btn");
const contactsResultCountEl = document.getElementById("contacts-result-count");
const contactsColgroupEl = document.getElementById("contacts-colgroup");
const contactsTheadEl = document.getElementById("contacts-thead");
const contactsTbodyEl = document.getElementById("contacts-tbody");
const contactsTableEl = document.getElementById("contacts-table");
const contactsPaginationTopEl = document.getElementById("contacts-pagination-top");
const contactsPaginationBottomEl = document.getElementById("contacts-pagination-bottom");
const contactsTableScrollTopEl = document.getElementById("contacts-table-scroll-top");
const contactsTableScrollTopFillerEl = document.getElementById("contacts-table-scroll-top-filler");
const contactsTableWrapEl = document.getElementById("contacts-table-wrap");

let workbook = { companies: [], contacts: [], aiInitiatives: [], aiInvestment: [], sources: [] };
let allLeads = []; // getResults() as an array - flags/last-communication/posts-by-contact all need this
let accountExtras = {}; // getTargetAccountExtras() - due-dates drive the list view's flag column
let contactExtras = {}; // getTargetContactExtras() - same, for the Target Contacts Dashboard's flag column
let sortField = "aiPriorityScore";
let sortDirection = "desc";
let openMenuColumnId = null;
let columnFilters = {}; // { [columnId]: { text, exclude } }
let hiddenColumns = new Set();
let pageSize = 50; // 20/50/100 - reported directly, 500 companies unpaginated was too much to scroll through
let currentPage = 1;
let currentAccountKey = null; // normalizeCompanyName(company) of the account view currently open, if any
let currentContactKey = null; // contactKeyFor(...) of the contact view currently open, if any

// ---------------------------------------------------------------------
// Pie charts - hand-drawn inline SVG, same technique as the Posts
// Dashboard's own charts (dashboard.js's renderPieChart/computeStatusCounts/
// polarPoint) - copied rather than imported/generalized, since that
// function is hardwired to lead-status buckets and generalizing it would
// mean touching already-shipped, working code the user depends on daily
// for a codebase-hygiene win alone. This version takes pre-bucketed
// {label, count, color} slices directly, so one implementation covers
// every pie on both the Target Accounts and Target Contacts Dashboards -
// only the small computeXCounts() bucketing helpers differ per chart.
// ---------------------------------------------------------------------

function polarPoint(cx, cy, r, angle) {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

// onSliceClick is optional - the new pies here are informational (no
// existing single-column filter maps cleanly onto a derived/computed
// bucket like "AI Priority range" or "Account status"), unlike the Posts
// Dashboard's status pies which filter the table by clicking a slice.
function renderGenericPieChart(containerEl, slices, { unitLabel = "", onSliceClick } = {}) {
  containerEl.innerHTML = "";
  const nonZero = slices.filter((s) => s.count > 0);
  const total = nonZero.reduce((sum, s) => sum + s.count, 0);
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
    for (const slice of nonZero) {
      const sliceAngle = (slice.count / total) * Math.PI * 2;
      const endAngle = startAngle + sliceAngle;
      const path = document.createElementNS(svgNS, "path");
      let d;
      if (slice.count === total) {
        // A true 360-degree arc degenerates to nothing in SVG's arc
        // command, so a single all-one-bucket window draws as a
        // near-full circle - same fix as dashboard.js's own pie chart.
        d = "M 60 6 A 54 54 0 1 1 59.99 6 Z";
      } else {
        const [x1, y1] = polarPoint(60, 60, 54, startAngle);
        const [x2, y2] = polarPoint(60, 60, 54, endAngle);
        const largeArc = sliceAngle > Math.PI ? 1 : 0;
        d = `M 60 60 L ${x1} ${y1} A 54 54 0 ${largeArc} 1 ${x2} ${y2} Z`;
      }
      path.setAttribute("d", d);
      path.setAttribute("fill", slice.color);
      if (onSliceClick) {
        path.style.cursor = "pointer";
        path.addEventListener("click", () => onSliceClick(slice.label));
      }
      const titleEl = document.createElementNS(svgNS, "title");
      titleEl.textContent = `${slice.label}: ${slice.count}`;
      path.appendChild(titleEl);
      svg.appendChild(path);
      startAngle = endAngle;
    }
  }

  const legend = document.createElement("div");
  legend.className = "pie-legend";
  if (total === 0) {
    legend.innerHTML = `<span class="pie-empty">No ${unitLabel || "data"} yet.</span>`;
  } else {
    const totalRow = document.createElement("div");
    totalRow.style.fontWeight = "600";
    totalRow.style.marginBottom = "6px";
    totalRow.textContent = `${total} ${unitLabel}`;
    legend.appendChild(totalRow);
    for (const slice of nonZero) {
      const row = document.createElement("div");
      row.className = "pie-legend-row";
      if (onSliceClick) row.title = "Click to filter";
      const swatch = document.createElement("span");
      swatch.className = "pie-legend-swatch";
      swatch.style.background = slice.color;
      row.append(swatch, document.createTextNode(` ${slice.label}: ${slice.count}`));
      if (onSliceClick) row.addEventListener("click", () => onSliceClick(slice.label));
      legend.appendChild(row);
    }
  }

  containerEl.append(svg, legend);
}

// Every column of the Companies sheet, in the same left-to-right order as
// the workbook itself (v0.29.42 - reordered to match Swiss_AI_Prospects_500_
// v16_reordered_columns.xlsx, reported directly: the user's own column order
// already puts the fields a salesperson actually triages on - AI Score,
// Evidence Coverage, the Zefix/alternative-name/LinkedIn-link cross-check -
// well to the left, so mirroring it here avoids the scrolling the old,
// independently-curated order caused). The columns marked visible below are
// the ones shown by default; the rest (mostly confidence/period/scoring-
// methodology fields, useful for judging data quality rather than for
// triage) start hidden but are one click away via the Columns button or a
// column's own "Hide This Column" menu item.
const COMPANY_COLUMNS = [
  // Hidden by default - available via the Columns button.
  { id: "companyId", label: "Company ID" },
  { id: "universeOrder", label: "Universe Order", numeric: true },
  { id: "company", label: "Company", visible: true },
  { id: "industry", label: "Industry", visible: true },
  { id: "aiUseCaseFitScore", label: "AI Use Case Fit Score", numeric: true },
  { id: "evidenceCoverage", label: "Evidence Coverage", visible: true, percent: true },
  { id: "aiPriorityScore", label: "AI Score", visible: true, numeric: true },
  { id: "aiPriority", label: "AI Priority", visible: true, pill: true },
  { id: "researchQuality", label: "Research Quality" },
  { id: "researchStatus", label: "Research Status", visible: true },
  { id: "priorityRationale", label: "Priority Rationale", visible: true, longText: true },
  { id: "primarySourceUrl", label: "Primary Source", link: true },
  { id: "lastVerified", label: "Last Verified", date: true },
  { id: "aiPortfolioProfile", label: "AI Portfolio Profile" },
  { id: "aiPortfolioProfileConfidence", label: "AI Portfolio Profile Confidence" },
  // v0.29.42: Evidence_Status and the Zefix/alternative-name/LinkedIn-link
  // cross-check columns (see storage.js's importTargetAccounts and PRD
  // 6.16) - not previously surfaced in the Explorer table at all.
  { id: "evidenceStatus", label: "Evidence Status", visible: true },
  { id: "zefixOfficialName", label: "Zefix Official Name", visible: true },
  { id: "zefixUid", label: "Zefix UID" },
  { id: "zefixAddress", label: "Zefix Address" },
  { id: "alternativeCompanyName", label: "Alternative Company Name", visible: true },
  { id: "linkedinLink", label: "LinkedIn Link", visible: true, link: true },
  { id: "prospectStatus", label: "Prospect Status" },
  { id: "companyType", label: "Type", visible: true },
  { id: "globalHqCity", label: "Global HQ City" },
  { id: "globalHqCountry", label: "Global HQ Country" },
  { id: "mainSwissLocation", label: "Main Swiss Location" },
  { id: "swissDecisionAuthority", label: "Swiss Decision Authority" },
  { id: "globalRevenue", label: "Global Revenue", visible: true, numeric: true, currencyField: "revenueCurrency" },
  { id: "revenuePeriod", label: "Revenue Period" },
  { id: "globalRevenueConfidence", label: "Global Revenue Confidence" },
  { id: "swissRevenue", label: "Swiss Revenue", visible: true, numeric: true, currencyField: "swissRevenueCurrency" },
  { id: "swissRevenuePeriod", label: "Swiss Revenue Period" },
  { id: "swissRevenueConfidence", label: "Swiss Revenue Confidence" },
  { id: "globalEmployees", label: "Global Employees", visible: true, numeric: true },
  { id: "globalEmployeesPeriod", label: "Global Employees Period" },
  { id: "globalEmployeesConfidence", label: "Global Employees Confidence" },
  { id: "swissEmployees", label: "Swiss Employees", visible: true, numeric: true },
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
];

// Reported directly: an older source workbook's Contacts sheet had two
// separate "Last_Verified"/"Evidence_Quality" column pairs with the exact
// same header text - a source-website verification date pair, then a
// distinct LinkedIn-verification pair (the actual verified profile URL + a
// status like "Current - LinkedIn verified"/"Legacy - LinkedIn reverify").
// Before parseGenericSheetRows (xlsx-lite.js) started suffixing a repeated
// header (lastVerified, lastVerified2, ...), the second pair silently
// overwrote the first under the same key - and this table's own "Profile"
// column was pointing at profileUrl (the company's own bio page, confirmed
// empty or non-LinkedIn for most rows in the real data), mislabeled
// "LinkedIn ↗" even though it usually isn't. lastVerified2/evidenceQuality2
// is the real LinkedIn pair; profileUrl relabeled to stop claiming it's
// LinkedIn when it usually isn't. A newer workbook schema (v24) dropped the
// duplicate pair and added a single dedicated LinkedIn_Profile_URL column
// instead - storage.js's importTargetAccountsWorkbook normalizes that into
// the same lastVerified2 field at import time, so this table doesn't need
// to care which schema a given contact came from.
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
  { label: "LinkedIn Profile", field: "lastVerified2", link: true, linkLabel: "LinkedIn ↗" },
  { label: "LinkedIn Status", field: "evidenceQuality2" },
  { label: "Bio Page", field: "profileUrl", link: true },
  { label: "Source", field: "sourceUrl", link: true },
  { label: "Source Last Verified", field: "lastVerified", date: true },
  { label: "Source Evidence Quality", field: "evidenceQuality" },
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
const FILTER_SORT_STATE_STORAGE_KEY = "salesteam-target-accounts-filter-sort-state";

// Persisted together as one blob, same reasoning as the Dashboard's identical
// helper - restoring these on open is what saves re-excluding "Insufficient
// Evidence"/"Out of Scope" rows (a reported annoyance) every session.
function saveFilterSortState() {
  try {
    localStorage.setItem(FILTER_SORT_STATE_STORAGE_KEY, JSON.stringify({
      columnFilters, sortField, sortDirection, searchQuery: searchInputEl.value, pageSize,
    }));
  } catch {
    // best-effort only - a filter/sort preference isn't worth surfacing an error for
  }
}

function loadFilterSortState() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_SORT_STATE_STORAGE_KEY) || "{}");
    if (saved.columnFilters && typeof saved.columnFilters === "object") columnFilters = saved.columnFilters;
    if (typeof saved.sortField === "string") sortField = saved.sortField;
    if (saved.sortDirection === "asc" || saved.sortDirection === "desc") sortDirection = saved.sortDirection;
    if (typeof saved.searchQuery === "string") searchInputEl.value = saved.searchQuery;
    if ([20, 50, 100].includes(saved.pageSize)) pageSize = saved.pageSize;
  } catch {
    // ignore a corrupted/missing saved blob - defaults already set above
  }
}

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

// Reported directly: Contacts/AI Initiatives/Sources under the Account
// view's company header were pushing the page well past one screen -
// collapsed by default (▸), expanding in place (▾) on click, so the page
// fits a standard browser window with minimal scrolling until a section is
// actually opened.
function buildSubtable(title, rows, columns, { rowClick } = {}) {
  const section = document.createElement("div");

  const heading = document.createElement("button");
  heading.type = "button";
  heading.className = "detail-section-title detail-section-toggle";
  const chevron = document.createElement("span");
  chevron.className = "detail-section-chevron";
  chevron.textContent = "▸";
  heading.append(chevron, document.createTextNode(`${title} (${rows.length})`));
  section.appendChild(heading);

  const body = document.createElement("div");
  body.hidden = true;
  section.appendChild(body);

  heading.addEventListener("click", () => {
    body.hidden = !body.hidden;
    chevron.textContent = body.hidden ? "▸" : "▾";
  });

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "detail-empty-note";
    empty.textContent = "None on record.";
    body.appendChild(empty);
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
    if (rowClick) {
      tr.className = "clickable-subtable-row";
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        rowClick(row);
      });
    }
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
  body.appendChild(wrap);
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
  wrap.appendChild(buildSubtable("Contacts", contacts, CONTACT_COLUMNS, {
    // Every row here has both companyId and fullName - see the Contacts
    // sheet's raw parsed shape (target-accounts.js header comment) - so
    // contactKeyFor (storage.js, same key the Contact view is opened by)
    // is always computable from what's already on the row.
    rowClick: (contact) => openContact(contactKeyFor(contact.company, contact.fullName)),
  }));

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
    currentPage = 1;
    saveFilterSortState();
    closeColumnMenu();
    renderTable();
  });
  const descBtn = document.createElement("button");
  descBtn.className = "col-menu-item";
  descBtn.textContent = "Sort Descending";
  descBtn.addEventListener("click", () => {
    sortField = column.id;
    sortDirection = "desc";
    currentPage = 1;
    saveFilterSortState();
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
    currentPage = 1;
    saveFilterSortState();
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
    currentPage = 1;
    saveFilterSortState();
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
  const flagCol = document.createElement("col");
  flagCol.style.width = "28px";
  colgroupEl.appendChild(flagCol);
  for (const col of visibleColumns()) {
    const colEl = document.createElement("col");
    if (col.longText) colEl.style.width = "260px";
    colgroupEl.appendChild(colEl);
  }
}

function renderTableHead() {
  theadEl.innerHTML = "";
  const tr = document.createElement("tr");
  const flagTh = document.createElement("th");
  flagTh.title = "Needs attention: an unreviewed post, or a follow-up that's overdue";
  flagTh.textContent = "⚑";
  tr.appendChild(flagTh);
  for (const column of visibleColumns()) {
    const th = document.createElement("th");

    const label = document.createElement("span");
    label.className = "th-label";
    label.textContent = column.label;
    label.title = "Click to sort";
    label.addEventListener("click", () => {
      sortDirection = sortField === column.id && sortDirection === "desc" ? "asc" : "desc";
      sortField = column.id;
      currentPage = 1;
      saveFilterSortState();
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

// Reported directly: 500 companies with no pagination was too much to
// scroll through, and the page-size/navigation controls should be
// reachable both above and below the table, not just one or the other.
// Returns a fresh DOM node each call (not a single element reused twice -
// duplicate ids aren't valid HTML) so the exact same control set can be
// dropped into paginationTopEl and paginationBottomEl independently; both
// act on the same shared pageSize/currentPage module state, so a change
// made in either bar is immediately reflected in the other on the next
// renderTable() (triggered by every button/select here).
function buildPaginationBar(totalCount) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);

  const bar = document.createElement("div");
  bar.className = "pagination-bar-inner";

  const sizeSelect = document.createElement("select");
  sizeSelect.title = "Rows per page";
  for (const size of [20, 50, 100]) {
    const opt = document.createElement("option");
    opt.value = String(size);
    opt.textContent = `${size} / page`;
    sizeSelect.appendChild(opt);
  }
  sizeSelect.value = String(pageSize);
  sizeSelect.addEventListener("change", () => {
    pageSize = parseInt(sizeSelect.value, 10);
    currentPage = 1;
    saveFilterSortState();
    renderTable();
  });

  function navBtn(label, title, goTo, disabled) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "page-nav-btn";
    btn.textContent = label;
    btn.title = title;
    btn.disabled = disabled;
    btn.addEventListener("click", () => {
      currentPage = goTo;
      renderTable();
    });
    return btn;
  }

  const indicator = document.createElement("span");
  indicator.className = "page-indicator";
  indicator.textContent = `Page ${currentPage} of ${totalPages}`;

  bar.append(
    sizeSelect,
    navBtn("«", "First page", 1, currentPage <= 1),
    navBtn("‹", "Previous page", currentPage - 1, currentPage <= 1),
    indicator,
    navBtn("›", "Next page", currentPage + 1, currentPage >= totalPages),
    navBtn("»", "Last page", totalPages, currentPage >= totalPages)
  );
  return bar;
}

// Mirrors the table's own horizontal scrollbar (which sits at the bottom of
// #table-wrap, potentially far below the viewport for a long table) with a
// second, thin scrollable strip above the table - reported directly, both
// should be reachable without scrolling down first. A dummy filler div
// matching the real table's scrollWidth is what gives the top strip
// something to scroll; the two stay in sync via the scroll listeners wired
// once in init() below.
function syncTopScrollWidth() {
  tableScrollTopFillerEl.style.width = `${companiesTableEl.scrollWidth}px`;
}

function renderTable() {
  renderColgroup();
  renderTableHead();

  const companies = sortedFilteredCompanies();
  resultCountEl.textContent = `${companies.length} of ${workbook.companies.length} companies`;
  const cols = visibleColumns();

  const totalPages = Math.max(1, Math.ceil(companies.length / pageSize));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const pageCompanies = companies.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  paginationTopEl.innerHTML = "";
  paginationTopEl.appendChild(buildPaginationBar(companies.length));
  paginationBottomEl.innerHTML = "";
  paginationBottomEl.appendChild(buildPaginationBar(companies.length));

  tbodyEl.innerHTML = "";
  for (const company of pageCompanies) {
    const companyKey = normalizeCompanyName(company.company);
    const tr = document.createElement("tr");
    tr.className = "company-row";

    const flagTd = document.createElement("td");
    flagTd.className = "flag-cell";
    const needsAttention = hasUnreviewedPost(companyKey, allLeads) || hasOverdueAction(accountExtras[companyKey]);
    if (needsAttention) {
      const flag = document.createElement("span");
      flag.className = "flag-icon";
      flag.title = hasOverdueAction(accountExtras[companyKey])
        ? "Overdue follow-up (and possibly an unreviewed post too)"
        : "Unreviewed post";
      flag.textContent = "🚩";
      flagTd.appendChild(flag);
    }
    tr.appendChild(flagTd);

    for (const column of cols) {
      const td = document.createElement("td");
      renderCellContent(td, company, column);
      tr.appendChild(td);
    }
    tr.addEventListener("click", (event) => {
      if (event.target.closest("a") || event.target.closest(".long-text-cell")) return;
      openAccount(companyKey);
    });
    tbodyEl.appendChild(tr);
  }

  syncTopScrollWidth();
}

// Search/sort/filter changes all narrow or reorder the result set - reset
// to page 1 each time, same reasoning dashboard.js's own pagination already
// uses, so a filter never leaves the view stranded on a now-empty later page.
// Every field already present on a raw `contacts` row (see xlsx-lite.js's
// parseGenericSheetRows and the CONTACT_COLUMNS sub-table used in the
// Account view for the same field set/labels). `company` is included here
// (and NOT in the Account view's nested CONTACT_COLUMNS) since this list
// spans every company - the company context isn't implied by a
// surrounding page the way it is when nested under one Account.
const CONTACT_LIST_COLUMNS = [
  { id: "fullName", label: "Name", visible: true },
  { id: "company", label: "Company", visible: true },
  { id: "jobTitle", label: "Job Title", visible: true },
  { id: "function", label: "Function", visible: true },
  { id: "seniority", label: "Seniority", visible: true },
  { id: "aiRelevance", label: "AI Relevance", visible: true, longText: true },
  { id: "swissBased", label: "Swiss Based" },
  { id: "city", label: "City" },
  { id: "country", label: "Country" },
  { id: "publicBusinessEmail", label: "Business Email" },
  { id: "lastVerified2", label: "LinkedIn Profile", visible: true, link: true, linkLabel: "LinkedIn ↗" },
  { id: "evidenceQuality2", label: "LinkedIn Status" },
  { id: "profileUrl", label: "Bio Page", link: true },
  { id: "sourceUrl", label: "Source", link: true },
  { id: "lastVerified", label: "Source Last Verified", date: true },
  { id: "evidenceQuality", label: "Source Evidence Quality" },
];

const CONTACT_HIDDEN_COLUMNS_STORAGE_KEY = "salesteam-target-contacts-hidden-columns";
const CONTACT_FILTER_SORT_STATE_STORAGE_KEY = "salesteam-target-contacts-filter-sort-state";

let contactSortField = "fullName";
let contactSortDirection = "asc";
let contactColumnFilters = {};
let contactHiddenColumns = new Set();
let contactPageSize = 50;
let contactCurrentPage = 1;

function loadContactHiddenColumns() {
  const defaultHidden = CONTACT_LIST_COLUMNS.filter((c) => !c.visible).map((c) => c.id);
  try {
    const saved = JSON.parse(localStorage.getItem(CONTACT_HIDDEN_COLUMNS_STORAGE_KEY));
    contactHiddenColumns = new Set(Array.isArray(saved) ? saved : defaultHidden);
  } catch {
    contactHiddenColumns = new Set(defaultHidden);
  }
}

function saveContactHiddenColumns() {
  try {
    localStorage.setItem(CONTACT_HIDDEN_COLUMNS_STORAGE_KEY, JSON.stringify([...contactHiddenColumns]));
  } catch {
    // best-effort only
  }
}

function visibleContactColumns() {
  return CONTACT_LIST_COLUMNS.filter((c) => !contactHiddenColumns.has(c.id));
}

function setContactColumnHidden(columnId, hidden) {
  if (hidden && CONTACT_LIST_COLUMNS.length - contactHiddenColumns.size <= 1) return false;
  if (hidden) contactHiddenColumns.add(columnId);
  else contactHiddenColumns.delete(columnId);
  saveContactHiddenColumns();
  renderContactsTable();
  return true;
}

function saveContactFilterSortState() {
  try {
    localStorage.setItem(CONTACT_FILTER_SORT_STATE_STORAGE_KEY, JSON.stringify({
      columnFilters: contactColumnFilters, sortField: contactSortField, sortDirection: contactSortDirection,
      searchQuery: contactsSearchInputEl.value, pageSize: contactPageSize,
    }));
  } catch {
    // best-effort only
  }
}

function loadContactFilterSortState() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONTACT_FILTER_SORT_STATE_STORAGE_KEY) || "{}");
    if (saved.columnFilters && typeof saved.columnFilters === "object") contactColumnFilters = saved.columnFilters;
    if (typeof saved.sortField === "string") contactSortField = saved.sortField;
    if (saved.sortDirection === "asc" || saved.sortDirection === "desc") contactSortDirection = saved.sortDirection;
    if (typeof saved.searchQuery === "string") contactsSearchInputEl.value = saved.searchQuery;
    if ([20, 50, 100].includes(saved.pageSize)) contactPageSize = saved.pageSize;
  } catch {
    // ignore a corrupted/missing saved blob - defaults already set above
  }
}

function matchesContactGlobalSearch(contact, query) {
  if (!query) return true;
  const haystack = `${contact.fullName || ""} ${contact.company || ""} ${contact.jobTitle || ""}`.toLowerCase();
  return haystack.includes(query);
}

function matchesContactColumnFilters(contact) {
  for (const [colId, filter] of Object.entries(contactColumnFilters)) {
    if (!filter || !filter.text) continue;
    const column = CONTACT_LIST_COLUMNS.find((c) => c.id === colId);
    if (!column) continue;
    const contains = filterText(contact, column).includes(filter.text.toLowerCase());
    if (filter.exclude ? contains : !contains) return false;
  }
  return true;
}

function sortedFilteredContacts() {
  const query = contactsSearchInputEl.value.trim().toLowerCase();
  const sortCol = CONTACT_LIST_COLUMNS.find((c) => c.id === contactSortField);
  const filtered = workbook.contacts.filter((c) => matchesContactGlobalSearch(c, query) && matchesContactColumnFilters(c));
  if (sortCol) {
    filtered.sort((a, b) => {
      const va = sortValue(a, sortCol);
      const vb = sortValue(b, sortCol);
      if ((va == null || va === "") && (vb == null || vb === "")) return 0;
      if (va == null || va === "") return 1;
      if (vb == null || vb === "") return -1;
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return contactSortDirection === "asc" ? cmp : -cmp;
    });
  }
  return filtered;
}

// Same combined sort/filter/hide popup as the Companies table's
// toggleColumnMenu, duplicated (not shared) since it closes over
// company-specific state (columnFilters/sortField/renderTable) - closeColumnMenu/
// onDocumentClickCloseMenu ARE shared as-is below, since only one popup can
// ever be open at a time regardless of which table it belongs to.
function toggleContactColumnMenu(column, anchorEl) {
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
    contactSortField = column.id;
    contactSortDirection = "asc";
    contactCurrentPage = 1;
    saveContactFilterSortState();
    closeColumnMenu();
    renderContactsTable();
  });
  const descBtn = document.createElement("button");
  descBtn.className = "col-menu-item";
  descBtn.textContent = "Sort Descending";
  descBtn.addEventListener("click", () => {
    contactSortField = column.id;
    contactSortDirection = "desc";
    contactCurrentPage = 1;
    saveContactFilterSortState();
    closeColumnMenu();
    renderContactsTable();
  });
  popup.append(ascBtn, descBtn, document.createElement("hr"));

  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.className = "col-filter-input";
  filterInput.placeholder = `Filter ${column.label}…`;
  filterInput.value = contactColumnFilters[column.id]?.text || "";

  const excludeLabel = document.createElement("label");
  excludeLabel.className = "col-filter-exclude-label";
  const excludeCheckbox = document.createElement("input");
  excludeCheckbox.type = "checkbox";
  excludeCheckbox.checked = contactColumnFilters[column.id]?.exclude || false;
  excludeLabel.append(excludeCheckbox, document.createTextNode("Exclude matches"));

  const applyFilter = () => {
    const text = filterInput.value.trim();
    contactColumnFilters[column.id] = text ? { text, exclude: excludeCheckbox.checked } : null;
    contactCurrentPage = 1;
    saveContactFilterSortState();
    closeColumnMenu();
    renderContactsTable();
  };
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyFilter();
  });

  const actionsRow = document.createElement("div");
  actionsRow.className = "col-menu-actions";
  const applyBtn = document.createElement("button");
  applyBtn.title = "Filter the table by this column";
  applyBtn.textContent = "Apply";
  applyBtn.addEventListener("click", applyFilter);
  const clearBtn = document.createElement("button");
  clearBtn.title = "Remove this column's filter";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    delete contactColumnFilters[column.id];
    contactCurrentPage = 1;
    saveContactFilterSortState();
    closeColumnMenu();
    renderContactsTable();
  });
  actionsRow.append(applyBtn, clearBtn);
  popup.append(filterInput, excludeLabel, actionsRow, document.createElement("hr"));

  const hideBtn = document.createElement("button");
  hideBtn.className = "col-menu-item";
  hideBtn.title = `Hide the ${column.label} column - bring it back from the Columns button`;
  hideBtn.textContent = "Hide This Column";
  hideBtn.addEventListener("click", () => {
    closeColumnMenu();
    setContactColumnHidden(column.id, true);
  });
  popup.appendChild(hideBtn);

  document.body.appendChild(popup);
  const popupWidth = popup.offsetWidth;
  const left = Math.min(anchorRect.right - popupWidth, window.innerWidth - popupWidth - 8);
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top = `${anchorRect.bottom + 2}px`;

  setTimeout(() => document.addEventListener("click", onDocumentClickCloseMenu, { once: true }), 0);
}

function toggleContactColumnsPanel() {
  if (document.querySelector(".columns-panel")) {
    closeColumnMenu();
    return;
  }
  closeColumnMenu();

  const anchorRect = contactsColumnsBtn.getBoundingClientRect();
  const popup = document.createElement("div");
  popup.className = "col-menu-popup columns-panel";

  for (const column of CONTACT_LIST_COLUMNS) {
    const row = document.createElement("label");
    row.className = "columns-panel-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !contactHiddenColumns.has(column.id);
    checkbox.addEventListener("change", () => {
      if (!setContactColumnHidden(column.id, !checkbox.checked)) checkbox.checked = true;
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

contactsColumnsBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleContactColumnsPanel();
});

function renderContactsColgroup() {
  contactsColgroupEl.innerHTML = "";
  const flagCol = document.createElement("col");
  flagCol.style.width = "28px";
  contactsColgroupEl.appendChild(flagCol);
  for (const col of visibleContactColumns()) {
    const colEl = document.createElement("col");
    if (col.longText) colEl.style.width = "260px";
    contactsColgroupEl.appendChild(colEl);
  }
}

function renderContactsTableHead() {
  contactsTheadEl.innerHTML = "";
  const tr = document.createElement("tr");
  const flagTh = document.createElement("th");
  flagTh.title = "Needs attention: an unreviewed post by this contact, or a follow-up that's overdue";
  flagTh.textContent = "⚑";
  tr.appendChild(flagTh);
  for (const column of visibleContactColumns()) {
    const th = document.createElement("th");
    const label = document.createElement("span");
    label.className = "th-label";
    label.textContent = column.label;
    label.title = "Click to sort";
    label.addEventListener("click", () => {
      contactSortDirection = contactSortField === column.id && contactSortDirection === "desc" ? "asc" : "desc";
      contactSortField = column.id;
      contactCurrentPage = 1;
      saveContactFilterSortState();
      renderContactsTable();
    });
    th.appendChild(label);

    if (contactSortField === column.id) {
      const arrow = document.createElement("span");
      arrow.textContent = contactSortDirection === "asc" ? " ▲" : " ▼";
      th.appendChild(arrow);
    }
    if (contactColumnFilters[column.id]?.text) {
      const dot = document.createElement("span");
      dot.className = "filter-active-dot";
      const f = contactColumnFilters[column.id];
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
      toggleContactColumnMenu(column, th);
    });
    th.appendChild(menuBtn);

    tr.appendChild(th);
  }
  contactsTheadEl.appendChild(tr);
}

function syncContactsTopScrollWidth() {
  contactsTableScrollTopFillerEl.style.width = `${contactsTableEl.scrollWidth}px`;
}

function hasUnreviewedPostForContact(contact) {
  return findLeadsForContact(contact, allLeads).some((l) => l.type !== "job" && l.status === "New");
}

function renderContactsTable() {
  renderContactsColgroup();
  renderContactsTableHead();

  const contacts = sortedFilteredContacts();
  contactsResultCountEl.textContent = `${contacts.length} of ${workbook.contacts.length} contacts`;
  const cols = visibleContactColumns();

  const totalPages = Math.max(1, Math.ceil(contacts.length / contactPageSize));
  contactCurrentPage = Math.min(Math.max(1, contactCurrentPage), totalPages);
  const pageContacts = contacts.slice((contactCurrentPage - 1) * contactPageSize, contactCurrentPage * contactPageSize);

  contactsPaginationTopEl.innerHTML = "";
  contactsPaginationTopEl.appendChild(buildContactsPaginationBar(contacts.length));
  contactsPaginationBottomEl.innerHTML = "";
  contactsPaginationBottomEl.appendChild(buildContactsPaginationBar(contacts.length));

  contactsTbodyEl.innerHTML = "";
  for (const contact of pageContacts) {
    const contactKey = contactKeyFor(contact.company, contact.fullName);
    const tr = document.createElement("tr");
    tr.className = "company-row";

    const flagTd = document.createElement("td");
    flagTd.className = "flag-cell";
    const overdue = hasOverdueAction(contactExtras[contactKey]);
    if (overdue || hasUnreviewedPostForContact(contact)) {
      const flag = document.createElement("span");
      flag.className = "flag-icon";
      flag.title = overdue ? "Overdue follow-up (and possibly an unreviewed post too)" : "Unreviewed post";
      flag.textContent = "🚩";
      flagTd.appendChild(flag);
    }
    tr.appendChild(flagTd);

    for (const column of cols) {
      const td = document.createElement("td");
      renderCellContent(td, contact, column);
      tr.appendChild(td);
    }
    tr.addEventListener("click", (event) => {
      if (event.target.closest("a") || event.target.closest(".long-text-cell")) return;
      if (contactKey) openContact(contactKey);
    });
    contactsTbodyEl.appendChild(tr);
  }

  syncContactsTopScrollWidth();
}

// Same page-size/First-Prev-Next-Last pattern as buildPaginationBar, its own
// copy since it closes over contactPageSize/contactCurrentPage/
// renderContactsTable instead of the Companies table's equivalents.
function buildContactsPaginationBar(totalCount) {
  const totalPages = Math.max(1, Math.ceil(totalCount / contactPageSize));
  contactCurrentPage = Math.min(Math.max(1, contactCurrentPage), totalPages);

  const bar = document.createElement("div");
  bar.className = "pagination-bar-inner";

  const sizeSelect = document.createElement("select");
  sizeSelect.title = "Rows per page";
  for (const size of [20, 50, 100]) {
    const opt = document.createElement("option");
    opt.value = String(size);
    opt.textContent = `${size} / page`;
    sizeSelect.appendChild(opt);
  }
  sizeSelect.value = String(contactPageSize);
  sizeSelect.addEventListener("change", () => {
    contactPageSize = parseInt(sizeSelect.value, 10);
    contactCurrentPage = 1;
    saveContactFilterSortState();
    renderContactsTable();
  });

  function navBtn(label, title, goTo, disabled) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "page-nav-btn";
    btn.textContent = label;
    btn.title = title;
    btn.disabled = disabled;
    btn.addEventListener("click", () => {
      contactCurrentPage = goTo;
      renderContactsTable();
    });
    return btn;
  }

  const indicator = document.createElement("span");
  indicator.className = "page-indicator";
  indicator.textContent = `Page ${contactCurrentPage} of ${totalPages}`;

  bar.append(
    sizeSelect,
    navBtn("«", "First page", 1, contactCurrentPage <= 1),
    navBtn("‹", "Previous page", contactCurrentPage - 1, contactCurrentPage <= 1),
    indicator,
    navBtn("›", "Next page", contactCurrentPage + 1, contactCurrentPage >= totalPages),
    navBtn("»", "Last page", totalPages, contactCurrentPage >= totalPages)
  );
  return bar;
}

// Target Contacts Dashboard stats (PRD 6.19) - same "full set, not the
// currently-filtered table" reasoning as the Accounts Dashboard's pies.
const CONTACT_STATUS_ORDER = ["Not contacted", "Contacted", "Responded"];
const CONTACT_STATUS_COLORS = { "Not contacted": "#9e9e9e", "Contacted": "#0a66c2", "Responded": "#2e7d32" };

function computeContactStatusCounts(contacts) {
  const counts = Object.fromEntries(CONTACT_STATUS_ORDER.map((k) => [k, 0]));
  for (const c of contacts) counts[leadStatusBucket(findLeadsForContact(c, allLeads))]++;
  return CONTACT_STATUS_ORDER.map((label) => ({ label, count: counts[label], color: CONTACT_STATUS_COLORS[label] }));
}

// Reported directly, twice over: the originally-proposed 2nd pie here
// (LinkedIn verification status) was wrong on the facts - every contact
// from a ChatGPT import already has a verified working LinkedIn link, so
// the pie would show one 100% slice and nothing else. The next proposal
// (account coverage - how many accounts have >=1 contact) turned out to
// already be the Accounts Dashboard's own Contact coverage pie, just
// rescoped (isRelevantAccount, above) rather than duplicated here. Left as
// a single pie for now rather than inventing a replacement nobody asked
// for - Seniority or Function breakdowns would be reasonable next
// candidates if a 2nd pie is wanted later.
function renderContactsStats() {
  renderGenericPieChart(document.getElementById("pie-contact-status"), computeContactStatusCounts(workbook.contacts), { unitLabel: "contacts" });
}

contactsSearchInputEl.addEventListener("input", () => {
  contactCurrentPage = 1;
  saveContactFilterSortState();
  renderContactsTable();
});

let syncingContactsTableScroll = false;
contactsTableScrollTopEl.addEventListener("scroll", () => {
  if (syncingContactsTableScroll) return;
  syncingContactsTableScroll = true;
  contactsTableWrapEl.scrollLeft = contactsTableScrollTopEl.scrollLeft;
  syncingContactsTableScroll = false;
});
contactsTableWrapEl.addEventListener("scroll", () => {
  if (syncingContactsTableScroll) return;
  syncingContactsTableScroll = true;
  contactsTableScrollTopEl.scrollLeft = contactsTableWrapEl.scrollLeft;
  syncingContactsTableScroll = false;
});

// ---- Tab bar - switches between the two list views (Target Accounts /
// Target Contacts), hidden on the Account/Contact detail views. ----
// Reported directly: this one page serves two dashboards (a hash-routed
// tab switch, not separate HTML files), but the <h1>/tab title stayed the
// static "Target Accounts Dashboard" no matter which was showing - the
// Target Contacts Dashboard looked identical to the Accounts one at a
// glance. Kept in sync with the button labels in sidepanel.html.
const PAGE_TITLES = { accounts: "Target Accounts Dashboard", contacts: "Target Contacts Dashboard" };

function showListTab(tab) {
  listViewEl.hidden = tab !== "accounts";
  contactsListViewEl.hidden = tab !== "contacts";
  tabAccountsEl.classList.toggle("active", tab === "accounts");
  tabContactsEl.classList.toggle("active", tab === "contacts");
  document.getElementById("page-title-text").textContent = `SalesTeam ${PAGE_TITLES[tab]}`;
  document.title = `SalesTeam ${PAGE_TITLES[tab]}`;
}

searchInputEl.addEventListener("input", () => {
  currentPage = 1;
  saveFilterSortState();
  renderTable();
});

// Two-way scroll sync between the thin strip above the table and the
// table's own native horizontal scrollbar below it - a `scrollLeft` write
// that matches the current value doesn't re-fire this element's own
// "scroll" event, so this can't loop between the two listeners.
let syncingTableScroll = false;
tableScrollTopEl.addEventListener("scroll", () => {
  if (syncingTableScroll) return;
  syncingTableScroll = true;
  tableWrapEl.scrollLeft = tableScrollTopEl.scrollLeft;
  syncingTableScroll = false;
});
tableWrapEl.addEventListener("scroll", () => {
  if (syncingTableScroll) return;
  syncingTableScroll = true;
  tableScrollTopEl.scrollLeft = tableWrapEl.scrollLeft;
  syncingTableScroll = false;
});

// Live-updates while this tab stays open, same reasoning as the Activity Log
// and Dashboard - re-importing on the Settings page shouldn't require a
// manual reload here to see the fresh data.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("targetAccountsWorkbook" in changes) loadWorkbook();
  // Resolving LinkedIn company IDs (6.16) writes to the lightweight
  // targetAccounts map, not the workbook - a resolver run left going while
  // this page stays open should update the progress indicator live, same
  // reasoning as the workbook's own live-update above.
  else if ("targetAccounts" in changes) renderLinkedinResolveStatus();
  // A new scan finishing, or a lead's status changing, can flip the list
  // view's flag column (an unreviewed post appearing/getting actioned) -
  // and a due-date set/cleared from an Account view does the same. Only
  // the list view's flag column depends on these; an open Account/Contact
  // view already reflects the storage write that caused it directly.
  else if ("results" in changes) {
    getResults().then((results) => { allLeads = Object.values(results); if (!listViewEl.hidden) renderTable(); });
  } else if ("targetAccountExtras" in changes) {
    getTargetAccountExtras().then((extras) => { accountExtras = extras; if (!listViewEl.hidden) renderTable(); });
  }
});

// Target Accounts Dashboard stats (PRD 6.19) - computed over the FULL
// company set, not whatever's currently searched/filtered in the table
// below, same reasoning as the Posts Dashboard's own pies (a 7-day/30-day/
// all-time snapshot, independent of the leads table's own filters) - these
// are meant to answer "what does the whole target list look like," not
// "what does my current search look like." Recomputed on every
// loadWorkbook() (a fresh import, or any storage change affecting leads/
// due-dates), not on every keystroke in the search box.
const AI_PRIORITY_RANGE_ORDER = ["90-100", "80-90", "70-80", "60-70", "Below 60", "No score"];
const AI_PRIORITY_RANGE_COLORS = {
  "90-100": "#b71c1c", "80-90": "#e64a19", "70-80": "#f9a825",
  "60-70": "#689f38", "Below 60": "#78909c", "No score": "#cfcfcf",
};

function aiPriorityRangeLabel(score) {
  if (score == null || score === "") return "No score";
  if (score >= 90) return "90-100";
  if (score >= 80) return "80-90";
  if (score >= 70) return "70-80";
  if (score >= 60) return "60-70";
  return "Below 60";
}

function computeAiPriorityRangeCounts(companies) {
  const counts = Object.fromEntries(AI_PRIORITY_RANGE_ORDER.map((k) => [k, 0]));
  for (const c of companies) counts[aiPriorityRangeLabel(c.aiPriorityScore)]++;
  return AI_PRIORITY_RANGE_ORDER.map((label) => ({ label, count: counts[label], color: AI_PRIORITY_RANGE_COLORS[label] }));
}

// Real values confirmed against the actual imported workbook, not guessed:
// "Rich Evidence" / "Sufficient Evidence" / "Insufficient - Missing baseline".
const EVIDENCE_LEVEL_ORDER = ["Rich Evidence", "Sufficient Evidence", "Insufficient - Missing baseline"];
const EVIDENCE_LEVEL_COLORS = {
  "Rich Evidence": "#2e7d32", "Sufficient Evidence": "#f9a825", "Insufficient - Missing baseline": "#c62828",
};

function computeEvidenceLevelCounts(companies) {
  const counts = Object.fromEntries(EVIDENCE_LEVEL_ORDER.map((k) => [k, 0]));
  for (const c of companies) {
    if (counts[c.evidenceStatus] !== undefined) counts[c.evidenceStatus]++;
  }
  return EVIDENCE_LEVEL_ORDER.map((label) => ({ label, count: counts[label], color: EVIDENCE_LEVEL_COLORS[label] }));
}

// Reported directly: a coverage/status stat that includes every
// "Insufficient - Missing baseline" account (roughly 200 of 500) alongside
// the ~300 genuinely-researched ones is misleading - those accounts were
// never going to have contacts or outreach yet, so lumping them into "0
// contacts"/"Not contacted" makes an otherwise-real number meaningless.
// Contact coverage and Account Coverage (below) both scope to this set.
function isRelevantAccount(company) {
  return company.evidenceStatus === "Rich Evidence" || company.evidenceStatus === "Sufficient Evidence";
}

// No stored "account status" field exists, nor should one be invented -
// derived the same way lastCommunicationFor already is, from the account's
// own associated leads' real status (storage.js's LEAD_STATUSES).
const ACCOUNT_STATUS_ORDER = ["Not contacted", "Contacted", "Responded"];
const ACCOUNT_STATUS_COLORS = { "Not contacted": "#9e9e9e", "Contacted": "#0a66c2", "Responded": "#2e7d32" };

function leadStatusBucket(leads) {
  if (leads.some((l) => l.status === "Responded" || l.status === "Converted")) return "Responded";
  if (leads.some((l) => l.status === "Contacted")) return "Contacted";
  return "Not contacted";
}

function computeAccountStatusCounts(companies) {
  const counts = Object.fromEntries(ACCOUNT_STATUS_ORDER.map((k) => [k, 0]));
  for (const c of companies) {
    const companyKey = normalizeCompanyName(c.company);
    const leads = allLeads.filter((l) => normalizeCompanyName(l.company) === companyKey);
    counts[leadStatusBucket(leads)]++;
  }
  return ACCOUNT_STATUS_ORDER.map((label) => ({ label, count: counts[label], color: ACCOUNT_STATUS_COLORS[label] }));
}

// Proposed 4th pie (PRD 6.19): directly actionable for where the project
// actually is right now - contacts research is mid-rollout, and none of
// the other three pies surface that gap at all. Scoped to isRelevantAccount
// (Rich/Sufficient Evidence only) - reported directly, an Insufficient-
// Evidence account was never going to have contacts researched, so
// including it would just dilute "0 contacts" with accounts nothing was
// ever attempted for.
const CONTACT_COVERAGE_ORDER = ["0 contacts", "1-2 contacts", "3+ contacts"];
const CONTACT_COVERAGE_COLORS = { "0 contacts": "#c62828", "1-2 contacts": "#f9a825", "3+ contacts": "#2e7d32" };

function computeContactCoverageCounts(companies) {
  const counts = Object.fromEntries(CONTACT_COVERAGE_ORDER.map((k) => [k, 0]));
  for (const c of companies.filter(isRelevantAccount)) {
    const n = workbook.contacts.filter((ct) => ct.companyId === c.companyId).length;
    counts[n === 0 ? "0 contacts" : n <= 2 ? "1-2 contacts" : "3+ contacts"]++;
  }
  return CONTACT_COVERAGE_ORDER.map((label) => ({ label, count: counts[label], color: CONTACT_COVERAGE_COLORS[label] }));
}

function renderAccountsStats() {
  renderGenericPieChart(document.getElementById("pie-ai-priority"), computeAiPriorityRangeCounts(workbook.companies), { unitLabel: "companies" });
  renderGenericPieChart(document.getElementById("pie-evidence-level"), computeEvidenceLevelCounts(workbook.companies), { unitLabel: "companies" });
  renderGenericPieChart(document.getElementById("pie-account-status"), computeAccountStatusCounts(workbook.companies), { unitLabel: "companies" });
  renderGenericPieChart(document.getElementById("pie-contact-coverage"), computeContactCoverageCounts(workbook.companies), { unitLabel: "companies" });
}

async function loadWorkbook() {
  const [wb, results, extras, cExtras] = await Promise.all([
    getTargetAccountsWorkbook(), getResults(), getTargetAccountExtras(), getTargetContactExtras(),
  ]);
  workbook = wb;
  allLeads = Object.values(results);
  accountExtras = extras;
  contactExtras = cExtras;
  const hasData = workbook.companies.length > 0;
  const hasContacts = workbook.contacts.length > 0;
  emptyStateEl.hidden = hasData;
  controlsEl.hidden = !hasData;
  tableWrapEl.hidden = !hasData;
  paginationTopEl.hidden = !hasData;
  paginationBottomEl.hidden = !hasData;
  tableScrollTopEl.hidden = !hasData;
  accountsStatsSectionEl.hidden = !hasData;
  exportTargetAccountsPageBtn.hidden = !hasData;
  hasWorkbookData = hasData;
  contactsEmptyStateEl.hidden = hasContacts;
  contactsExplorerControlsEl.hidden = !hasContacts;
  contactsTableWrapEl.hidden = !hasContacts;
  contactsPaginationTopEl.hidden = !hasContacts;
  contactsPaginationBottomEl.hidden = !hasContacts;
  contactsTableScrollTopEl.hidden = !hasContacts;
  contactsStatsSectionEl.hidden = !hasContacts;
  if (hasData) {
    renderTable();
    renderAccountsStats();
  }
  if (hasContacts) {
    renderContactsTable();
    renderContactsStats();
  }
  // Re-derive the tab bar's visibility for whichever view is currently
  // active (a live re-import while the page stays open on an Account/
  // Contact detail view shouldn't suddenly show the tab bar there).
  showView(parseHash().view);
  await renderLinkedinResolveStatus();
}

// EXPERIMENTAL (v0.29.25/6.16): shows progress toward resolving every
// Target Account company to a LinkedIn numeric ID (needed for the
// authorCompany-scoped Post search, 6.17) - reported directly, since a
// resolver run happens in small chunks over many sessions ("Limit to N",
// v0.29.29), there was no way to see overall progress without re-reading
// the Activity Log after every single run. Reads the lightweight
// targetAccounts map (not the workbook) since that's where linkedinCompanyId
// actually lives.
async function renderLinkedinResolveStatus() {
  const targetAccounts = await getTargetAccounts();
  const entries = Object.values(targetAccounts);
  if (entries.length === 0) {
    linkedinResolveStatusEl.hidden = true;
    return;
  }
  const resolvedCount = entries.filter((a) => a.linkedinCompanyId).length;
  linkedinResolveStatusEl.hidden = false;
  linkedinResolveStatusEl.textContent =
    `LinkedIn company IDs resolved: ${resolvedCount} of ${entries.length} (Settings → Resolve LinkedIn Company IDs).`;
}

// Same Import/Export as Settings' Target Accounts section (6.8/6.11) -
// reported directly: having to leave this page to back up or refresh the
// data it's actually showing was an unnecessary detour. Calls the exact
// same storage.js functions, just triggered from here too.
importTargetAccountsPageBtn.addEventListener("click", () => {
  importTargetAccountsPageFileInput.click();
});

// v0.29.38, see PRD 6.11: the same "Importing…" / persistent result-or-
// failure status pattern as Settings' own Target Accounts import, applied
// here too since this is a genuinely separate code path (not shared) - it
// had drifted from Settings' version in two real ways, not just cosmetic
// ones: no officialName mapping (6.16's Zefix cross-check silently
// wouldn't have carried through an import done from this page instead of
// Settings) and no filename passed to importTargetAccounts (so this page's
// imports never recorded which file was used).
function formatImportStamp(ms) {
  return new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

importTargetAccountsPageFileInput.addEventListener("change", async () => {
  const file = importTargetAccountsPageFileInput.files[0];
  importTargetAccountsPageFileInput.value = "";
  if (!file) return;
  targetAccountsPageIoStatusEl.textContent = `Importing ${file.name}…`;

  let list;
  let fullWorkbook = null;
  try {
    if (file.name.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(await file.text());
      if (parsed && !Array.isArray(parsed) && (parsed.targetAccounts || parsed.targetAccountsWorkbook)) {
        const prevMeta = await getTargetAccountsMeta();
        const { count, workbookCount } = await importTargetAccountsBackup(parsed);
        await loadWorkbook();
        targetAccountsPageIoStatusEl.textContent =
          `Restored ${count} companies${workbookCount ? `, ${workbookCount} in Explorer workbook,` : ""} from file ${file.name} at ${formatImportStamp(Date.now())}`;
        appendActivityLog({
          actor: "user",
          action: "target_accounts_imported",
          label: `Restored Target Accounts backup (${count} companies${workbookCount ? `, ${workbookCount} in Explorer workbook` : ""})`,
          prevValue: prevMeta.count,
          newValue: count,
        });
        return;
      }
      list = parsed;
    } else {
      fullWorkbook = await parseFullTargetAccountsWorkbook(await file.arrayBuffer());
      list = fullWorkbook.companies
        .filter((c) => c.company && c.company.trim())
        .map((c) => ({
          company: c.company,
          industry: c.industry,
          score: c.aiPriorityScore,
          priorityLabel: c.aiPriority,
          researchStatus: c.researchStatus,
          topInitiatives: c.topAiInitiatives,
          officialName: c.zefixOfficialName || null,
          alternativeName: c.alternativeCompanyName || null,
          linkedinLink: c.linkedinLink || null,
        }));
    }
  } catch (err) {
    targetAccountsPageIoStatusEl.textContent = `Import failed - "${file.name}" doesn't look like a valid, uncorrupted .xlsx or .json export (${err.message}).`;
    return;
  }
  if (!Array.isArray(list)) {
    targetAccountsPageIoStatusEl.textContent = `Import failed - "${file.name}" doesn't look like a Target Accounts export or backup (expected a list of companies).`;
    return;
  }

  const prevMeta = await getTargetAccountsMeta();
  const { count } = await importTargetAccounts(list, file.name);
  if (fullWorkbook) await importTargetAccountsWorkbook(fullWorkbook);
  await loadWorkbook();
  targetAccountsPageIoStatusEl.textContent = `${count} companies imported from file ${file.name} at ${formatImportStamp(Date.now())}`;
  appendActivityLog({
    actor: "user",
    action: "target_accounts_imported",
    label: `Imported Target Accounts list (${count} companies)${fullWorkbook ? " plus full Explorer data (Contacts, AI Initiatives, etc.)" : ""}`,
    prevValue: prevMeta.count,
    newValue: count,
  });
});

exportTargetAccountsPageBtn.addEventListener("click", async () => {
  const data = await exportTargetAccountsBackup();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `target-accounts-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  appendActivityLog({
    actor: "user",
    action: "target_accounts_exported",
    label: `Exported Target Accounts backup (${Object.keys(data.targetAccounts || {}).length} companies, ${(data.targetAccountsWorkbook?.companies || []).length} in Explorer workbook)`,
  });
});

// ---- Account/Contact views (PRD 6.19) ----

function formatDateTime(epochMs) {
  return epochMs ? new Date(epochMs).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
}

// Reported directly: the previous one-field-per-line <dl> made the overview
// take far more vertical space than the data warranted. Short fields
// (name, industry, employee counts, etc.) now flow into a single compact
// card, wrapping automatically at 3-5 per row depending on available width
// (CSS grid auto-fill, not a hardcoded column count - label lengths vary
// too much for a fixed count to hold up, e.g. "Employees (Switzerland)" vs
// "Type"). A field marked `long: true` (paragraph-length text like "Top AI
// initiatives") gets its own full-width row below the grid instead -
// cramming a paragraph into a grid cell would defeat the point of a compact
// card.
function buildOverviewCard(fields) {
  const card = document.createElement("div");
  card.className = "overview-card";

  // `node` (e.g. the follow-up due-date <input>+Clear button, moved in from
  // their hidden HTML spot rather than recreated - see wireDueDateInput's
  // existing event wiring, which targets those exact elements) takes
  // priority over `value`/`link` when given, for a field that needs a real
  // interactive control inside the card instead of static text.
  // `expandable` only applies to grid (short) fields - a long field already
  // gets a full-width row with normal wrapping (.overview-long-field), so
  // truncating it to one line first would fight that, not help it.
  function buildField(label, value, link, node, expandable) {
    const field = document.createElement("div");
    const dt = document.createElement("div");
    dt.className = "overview-label";
    dt.textContent = label;
    const dd = document.createElement("div");
    dd.className = "overview-value";
    if (node) {
      dd.appendChild(node);
    } else if (link) {
      const a = document.createElement("a");
      a.href = value;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Open ↗";
      dd.appendChild(a);
    } else {
      dd.textContent = value;
      if (expandable) {
        // Same click-to-expand/collapse pattern as the Posts Dashboard's
        // own truncated cells (dashboard.js's contentCell/.content-cell) -
        // reported directly, asked for the identical behavior here: a
        // truncated field's full value opens on click, growing in place,
        // and collapses back on a second click. Always wired, not just
        // when actually truncated (same as the Dashboard's own version
        // does it) - harmless no-op for a value that already fits.
        dd.title = "Click to expand/collapse";
        dd.classList.add("overview-value-expandable");
        dd.addEventListener("click", () => dd.classList.toggle("expanded"));
      }
    }
    field.append(dt, dd);
    return field;
  }

  const shortFields = fields.filter((f) => f.node || (!f.long && f.value != null && f.value !== ""));
  const longFields = fields.filter((f) => f.long && !f.node && f.value != null && f.value !== "");

  if (shortFields.length > 0) {
    const grid = document.createElement("div");
    grid.className = "overview-grid";
    for (const { label, value, link, node } of shortFields) grid.appendChild(buildField(label, value, link, node, true));
    card.appendChild(grid);
  }

  for (const { label, value } of longFields) {
    const row = buildField(label, value, false, null, false);
    row.className = "overview-long-field";
    card.appendChild(row);
  }

  return card;
}

// Same collapsed-by-default toggle as buildSubtable's Contacts/AI
// Initiatives/Sources sections, applied to the Contact view's own list
// sections (Posts/Web mentions/Recent Activity) and the Account view's
// Recent Activity - reported directly, same goal (fit one screen with
// minimal scrolling). Unlike buildSubtable, these headers are static HTML
// (<h3>), not rebuilt every render, so this wires the click listener once
// (idempotent - safe to call on every render) and resets to closed each
// time a different account/contact is opened, rather than inheriting
// whatever was left open on the previous one.
function wireCollapsibleHeader(headerEl, bodyEl) {
  let chevron = headerEl.querySelector(".detail-section-chevron");
  if (!chevron) {
    chevron = document.createElement("span");
    chevron.className = "detail-section-chevron";
    headerEl.prepend(chevron);
    headerEl.classList.add("collapsible-h3");
    headerEl.addEventListener("click", () => {
      bodyEl.hidden = !bodyEl.hidden;
      chevron.textContent = bodyEl.hidden ? "▸" : "▾";
    });
  }
  bodyEl.hidden = true;
  chevron.textContent = "▸";
}

function renderActivityList(el, entries) {
  el.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "detail-empty-note";
    empty.textContent = "No logged activity yet for this record (only activity since this feature shipped is tracked).";
    el.appendChild(empty);
    return;
  }
  for (const entry of entries.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "entity-activity-row";
    const time = document.createElement("span");
    time.className = "entity-activity-time";
    time.textContent = formatDateTime(entry.timestamp);
    row.appendChild(time);
    row.appendChild(document.createTextNode(entry.label || entry.action || ""));
    el.appendChild(row);
  }
}

function openLeadInDashboard(key) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html#lead=${encodeURIComponent(key)}`) });
}

function lastCommunicationFor(leadsForEntity) {
  const contacted = leadsForEntity
    .filter((l) => ["Contacted", "Responded", "Converted"].includes(l.status))
    .map((l) => l.statusUpdatedAt || 0);
  return contacted.length > 0 ? Math.max(...contacted) : null;
}

// Reported directly: "Last contact made" and "Follow-up due" belong in the
// same overview card as the rest of the account/contact's stats, not as
// separate rows below it. The due-date input/Clear button live in the HTML
// as plain hidden elements (not inside the overview div at all) precisely
// so they can be un-hidden and moved into a card field here on every
// render, rather than recreated - wireDueDateInput's event listeners stay
// attached to these same two elements throughout.
function dueDateFieldNode(inputEl, clearBtnEl) {
  inputEl.hidden = false;
  clearBtnEl.hidden = false;
  const wrap = document.createElement("span");
  wrap.className = "due-date-field";
  wrap.append(inputEl, clearBtnEl);
  return wrap;
}

function wireDueDateInput(inputEl, clearBtnEl, getExtra, saveExtra, { entityLabel, relatedCompanyKey, relatedContactKey }) {
  getExtra().then((extra) => {
    inputEl.value = extra.nextActionDueAt ? new Date(extra.nextActionDueAt).toISOString().slice(0, 10) : "";
  });
  inputEl.addEventListener("change", () => {
    const ms = inputEl.value ? new Date(`${inputEl.value}T00:00:00`).getTime() : null;
    saveExtra({ nextActionDueAt: ms });
    appendActivityLog({
      actor: "user",
      action: "follow_up_due_date_set",
      label: `Follow-up due date set for ${entityLabel} (${inputEl.value})`,
      newValue: ms,
      relatedCompanyKey,
      relatedContactKey,
    });
  });
  clearBtnEl.addEventListener("click", () => {
    inputEl.value = "";
    saveExtra({ nextActionDueAt: null });
    appendActivityLog({
      actor: "user",
      action: "follow_up_due_date_cleared",
      label: `Follow-up due date cleared for ${entityLabel}`,
      relatedCompanyKey,
      relatedContactKey,
    });
  });
}

// ---- Chat panels - same factory as advisors.js's global Sales Mentor/
// Customer Voice chats (createAgentChat there), duplicated here rather than
// imported since this is a separate page with its own DOM ids and no shared
// nav/module between extension pages (see every other cross-page link in
// this codebase). No tools: unlike the lead-scoped Mentor chat (dashboard.js,
// draft_message needs a real lead key), the account/contact's own info is
// already embedded directly in the system prompt - unlike a Post lead, a
// Target Contact may have no scanned lead/key to draft against at all.
function createAgentChat({ buildSystemPrompt, historyEl, statusEl, inputEl, sendBtn, clearBtn, getHistoryFn, saveHistoryFn, label, getRelatedKeys }) {
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
          if (block.type === "text" && block.text.trim()) appendBubble("agent", block.text);
        }
      }
    }
  }

  async function send() {
    if (sendBtn.disabled) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";

    const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
    sendBtn.disabled = true;
    try {
      await runAgentTurn(text, {
        history,
        apiKey,
        buildSystemPrompt,
        tools: [],
        executeTool: async () => ({ error: "No tools available in this chat." }),
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
    if (!confirm("Clear this conversation? This can't be undone.")) return;
    const prevLength = history.length;
    history = [];
    await saveHistoryFn([]);
    render();
    appendActivityLog({
      actor: "user",
      action: "conversation_cleared",
      label: `Cleared ${label} conversation (${prevLength} message(s))`,
      ...(getRelatedKeys ? getRelatedKeys() : {}),
    });
  });

  return {
    async init() {
      history = await getHistoryFn();
      render();
    },
  };
}

const accountMentorChat = createAgentChat({
  buildSystemPrompt: () => buildAccountScopedMentorPrompt(currentAccountCompanyRow(), { mentorPersona: currentSettingsCache.mentorPersona, companyContext: currentSettingsCache.companyContext, idealCustomerProfile: currentSettingsCache.idealCustomerProfile, outputLanguage: currentSettingsCache.outputLanguage }),
  historyEl: document.getElementById("account-mentor-history"),
  statusEl: document.getElementById("account-mentor-status"),
  inputEl: document.getElementById("account-mentor-input"),
  sendBtn: document.getElementById("account-mentor-send-btn"),
  clearBtn: document.getElementById("account-mentor-clear-btn"),
  getHistoryFn: async () => (await getTargetAccountExtra(currentAccountKey)).mentorHistory,
  saveHistoryFn: (history) => saveTargetAccountExtra(currentAccountKey, { mentorHistory: history }),
  label: "Account Mentor",
  getRelatedKeys: () => ({ relatedCompanyKey: currentAccountKey }),
});

const accountVoiceChat = createAgentChat({
  buildSystemPrompt: () => buildAccountScopedCustomerVoicePrompt(currentAccountCompanyRow(), { companyContext: currentSettingsCache.companyContext, customerPersona: currentSettingsCache.customerPersona, outputLanguage: currentSettingsCache.outputLanguage }),
  historyEl: document.getElementById("account-voice-history"),
  statusEl: document.getElementById("account-voice-status"),
  inputEl: document.getElementById("account-voice-input"),
  sendBtn: document.getElementById("account-voice-send-btn"),
  clearBtn: document.getElementById("account-voice-clear-btn"),
  getHistoryFn: async () => (await getTargetAccountExtra(currentAccountKey)).customerVoiceHistory,
  saveHistoryFn: (history) => saveTargetAccountExtra(currentAccountKey, { customerVoiceHistory: history }),
  label: "Account Customer Voice",
  getRelatedKeys: () => ({ relatedCompanyKey: currentAccountKey }),
});

const contactMentorChat = createAgentChat({
  buildSystemPrompt: () => buildContactScopedMentorPrompt(currentContactRow(), currentContactAccountRow(), { mentorPersona: currentSettingsCache.mentorPersona, companyContext: currentSettingsCache.companyContext, idealCustomerProfile: currentSettingsCache.idealCustomerProfile, outputLanguage: currentSettingsCache.outputLanguage }),
  historyEl: document.getElementById("contact-mentor-history"),
  statusEl: document.getElementById("contact-mentor-status"),
  inputEl: document.getElementById("contact-mentor-input"),
  sendBtn: document.getElementById("contact-mentor-send-btn"),
  clearBtn: document.getElementById("contact-mentor-clear-btn"),
  getHistoryFn: async () => (await getTargetContactExtra(currentContactKey)).mentorHistory,
  saveHistoryFn: (history) => saveTargetContactExtra(currentContactKey, { mentorHistory: history }),
  label: "Contact Mentor",
  getRelatedKeys: () => ({ relatedContactKey: currentContactKey }),
});

const contactVoiceChat = createAgentChat({
  buildSystemPrompt: () => buildContactScopedCustomerVoicePrompt(currentContactRow(), currentContactAccountRow(), { companyContext: currentSettingsCache.companyContext, customerPersona: currentSettingsCache.customerPersona, outputLanguage: currentSettingsCache.outputLanguage }),
  historyEl: document.getElementById("contact-voice-history"),
  statusEl: document.getElementById("contact-voice-status"),
  inputEl: document.getElementById("contact-voice-input"),
  sendBtn: document.getElementById("contact-voice-send-btn"),
  clearBtn: document.getElementById("contact-voice-clear-btn"),
  getHistoryFn: async () => (await getTargetContactExtra(currentContactKey)).customerVoiceHistory,
  saveHistoryFn: (history) => saveTargetContactExtra(currentContactKey, { customerVoiceHistory: history }),
  label: "Contact Customer Voice",
  getRelatedKeys: () => ({ relatedContactKey: currentContactKey }),
});

// Chat system prompts are built fresh per turn (see agent-shared.js), so
// they need live access to the currently-open account/contact row and to
// company-context/persona settings - cached here and refreshed whenever a
// view opens, same "fresh every turn, cached per navigation" reasoning
// dashboard.js's lead-scoped chat already uses.
let currentSettingsCache = { mentorPersona: "", companyContext: "", idealCustomerProfile: "", customerPersona: "", outputLanguage: "english" };

async function refreshSettingsCache() {
  const [mentorPersona, companyContext, idealCustomerProfile, customerPersona, outputLanguage] = await Promise.all([
    getMentorPersona(), getCompanyContext(), getIdealCustomerProfile(), getCustomerPersona(), getOutputLanguage(),
  ]);
  currentSettingsCache = { mentorPersona, companyContext, idealCustomerProfile, customerPersona, outputLanguage };
}

function currentAccountCompanyRow() {
  return workbook.companies.find((c) => normalizeCompanyName(c.company) === currentAccountKey) || {};
}

function currentContactRow() {
  return workbook.contacts.find((c) => contactKeyFor(c.company, c.fullName) === currentContactKey) || {};
}

function currentContactAccountRow() {
  const contact = currentContactRow();
  return workbook.companies.find((c) => normalizeCompanyName(c.company) === normalizeCompanyName(contact.company));
}

// ---- Account view ----

async function renderAccountView(companyKey) {
  currentAccountKey = companyKey;
  const company = currentAccountCompanyRow();
  document.getElementById("account-title").textContent = company.company || "(unknown company)";

  const companyLeads = allLeads.filter((l) => normalizeCompanyName(l.company) === companyKey);

  const dueDateInputEl = document.getElementById("account-due-date-input");
  const dueDateClearBtnEl = document.getElementById("account-due-date-clear-btn");
  wireDueDateInput(
    dueDateInputEl,
    dueDateClearBtnEl,
    () => getTargetAccountExtra(companyKey),
    (patch) => saveTargetAccountExtra(companyKey, patch),
    { entityLabel: company.company, relatedCompanyKey: companyKey }
  );

  document.getElementById("account-overview").innerHTML = "";
  document.getElementById("account-overview").appendChild(buildOverviewCard([
    { label: "Official name", value: company.zefixOfficialName && company.zefixOfficialName !== company.company ? company.zefixOfficialName : null },
    { label: "Alt. name", value: company.alternativeCompanyName },
    { label: "LinkedIn", value: company.linkedinLink, link: true },
    // No distinct "company website" column exists in the source workbook -
    // this is the closest stand-in, not invented data (see PRD 6.19).
    { label: "Website (source)", value: company.primarySourceUrl, link: true },
    { label: "Industry", value: company.industry },
    { label: "Address", value: company.zefixAddress },
    { label: "Employees (Global)", value: formatNumber(company.globalEmployees) },
    { label: "Employees (CH)", value: formatNumber(company.swissEmployees) },
    { label: "Revenue (Global)", value: company.globalRevenue ? `${formatNumber(company.globalRevenue)} ${company.revenueCurrency || ""}`.trim() : null },
    { label: "Revenue (CH)", value: company.swissRevenue ? `${formatNumber(company.swissRevenue)} ${company.swissRevenueCurrency || ""}`.trim() : null },
    { label: "AI Priority", value: company.aiPriority ? `${company.aiPriority}${company.aiPriorityScore ? ` (${Math.round(company.aiPriorityScore)}/100)` : ""}` : null },
    { label: "AI Coverage", value: company.evidenceCoverage != null ? `${Math.round(company.evidenceCoverage * 100)}%` : null },
    { label: "Type", value: company.companyType },
    { label: "AI Budget", value: [company.aiInvestmentGlobal, company.aiInvestmentSwitzerland].filter(Boolean).join(" / ") || null },
    { label: "Last contact", value: formatDateTime(lastCommunicationFor(companyLeads)) },
    { label: "Follow-up due", node: dueDateFieldNode(dueDateInputEl, dueDateClearBtnEl) },
    { label: "Top AI initiatives", value: company.topAiInitiatives, long: true },
  ]));

  const listsEl = document.getElementById("account-detail-lists");
  listsEl.innerHTML = "";
  listsEl.appendChild(buildDetailContent(company));

  renderActivityList(document.getElementById("account-activity-list"), await getActivityLogForCompany(companyKey));
  wireCollapsibleHeader(document.getElementById("account-activity-toggle"), document.getElementById("account-activity-list"));

  await refreshSettingsCache();
  await Promise.all([accountMentorChat.init(), accountVoiceChat.init()]);
}

// ---- Contact view ----

async function renderContactView(contactKey) {
  currentContactKey = contactKey;
  const contact = currentContactRow();
  document.getElementById("contact-title").textContent = contact.fullName || "(unknown contact)";

  const contactLeads = findLeadsForContact(contact, allLeads);

  const dueDateInputEl = document.getElementById("contact-due-date-input");
  const dueDateClearBtnEl = document.getElementById("contact-due-date-clear-btn");
  wireDueDateInput(
    dueDateInputEl,
    dueDateClearBtnEl,
    () => getTargetContactExtra(contactKey),
    (patch) => saveTargetContactExtra(contactKey, patch),
    { entityLabel: contact.fullName, relatedContactKey: contactKey }
  );

  document.getElementById("contact-overview").innerHTML = "";
  document.getElementById("contact-overview").appendChild(buildOverviewCard([
    { label: "Title", value: contact.jobTitle },
    { label: "Company", value: contact.company },
    { label: "Function", value: contact.function },
    { label: "Seniority", value: contact.seniority },
    { label: "LinkedIn", value: contact.lastVerified2, link: true },
    { label: "Business email", value: contact.publicBusinessEmail },
    { label: "Last contact", value: formatDateTime(lastCommunicationFor(contactLeads)) },
    { label: "Follow-up due", node: dueDateFieldNode(dueDateInputEl, dueDateClearBtnEl) },
    { label: "AI relevance", value: contact.aiRelevance, long: true },
  ]));

  const postsEl = document.getElementById("contact-posts-list");
  postsEl.innerHTML = "";
  if (contactLeads.length === 0) {
    const empty = document.createElement("p");
    empty.className = "detail-empty-note";
    empty.textContent = "No scanned posts from this contact yet.";
    postsEl.appendChild(empty);
  } else {
    for (const lead of contactLeads) {
      const row = document.createElement("div");
      row.className = "entity-activity-row";
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = `${(lead.snippet || "").slice(0, 100) || "(post)"} — ${lead.status}`;
      link.addEventListener("click", (e) => { e.preventDefault(); openLeadInDashboard(lead.key); });
      row.appendChild(link);
      postsEl.appendChild(row);
    }
  }

  // Gap, not a bug: the Sources sheet only joins by companyId, not
  // contactId (confirmed against the real workbook) - there's no richer
  // per-contact mentions list in the data today, only this one field
  // already on the contact's own row. A future ChatGPT research ask, not
  // something to fix in code.
  const mentionsEl = document.getElementById("contact-mentions-list");
  mentionsEl.innerHTML = "";
  if (contact.sourceUrl) {
    const a = document.createElement("a");
    a.href = contact.sourceUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Source ↗";
    mentionsEl.appendChild(a);
  } else {
    const empty = document.createElement("p");
    empty.className = "detail-empty-note";
    empty.textContent = "None on record.";
    mentionsEl.appendChild(empty);
  }

  renderActivityList(document.getElementById("contact-activity-list"), await getActivityLogForContact(contactKey));
  wireCollapsibleHeader(document.getElementById("contact-posts-toggle"), document.getElementById("contact-posts-list"));
  wireCollapsibleHeader(document.getElementById("contact-mentions-toggle"), document.getElementById("contact-mentions-list"));
  wireCollapsibleHeader(document.getElementById("contact-activity-toggle"), document.getElementById("contact-activity-list"));

  await refreshSettingsCache();
  await Promise.all([contactMentorChat.init(), contactVoiceChat.init()]);
}

// ---- Hash routing - same pattern as dashboard.js's #lead=<key> detail view ----

function parseHash() {
  const hash = location.hash.slice(1);
  const params = new URLSearchParams(hash);
  if (params.has("account")) return { view: "account", key: params.get("account") };
  if (params.has("contact")) return { view: "contact", key: params.get("contact") };
  // Plain "#contacts" (no key, no "=") - the Target Contacts Dashboard list
  // view, distinct from "#contact=<key>" (one specific Contact view) above.
  if (hash === "contacts") return { view: "contactsList" };
  return { view: "list" };
}

// The tab bar itself is only ever shown on the two list-type views (never
// on an Account/Contact detail view) AND only once there's real data to
// switch between (hasWorkbookData, set by loadWorkbook - no point showing
// tabs before any workbook has ever been imported).
let hasWorkbookData = false;

function showView(view) {
  const isListLike = view === "list" || view === "contactsList";
  listViewEl.hidden = view !== "list";
  contactsListViewEl.hidden = view !== "contactsList";
  accountViewEl.hidden = view !== "account";
  contactViewEl.hidden = view !== "contact";
  listTabBarEl.hidden = !isListLike || !hasWorkbookData;
  if (isListLike) showListTab(view === "contactsList" ? "contacts" : "accounts");
}

async function route() {
  closeColumnMenu();
  const { view, key } = parseHash();
  if (view === "account" && key) {
    showView("account");
    await renderAccountView(key);
  } else if (view === "contact" && key) {
    showView("contact");
    await renderContactView(key);
  } else if (view === "contactsList") {
    showView("contactsList");
  } else {
    showView("list");
  }
}

function openAccount(companyKey) {
  location.hash = `account=${encodeURIComponent(companyKey)}`;
}

function openContact(contactKey) {
  location.hash = `contact=${encodeURIComponent(contactKey)}`;
}

for (const backLink of [document.getElementById("account-back-link"), document.getElementById("contact-back-link")]) {
  backLink.addEventListener("click", (e) => {
    e.preventDefault();
    location.hash = "";
  });
}

window.addEventListener("hashchange", route);

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
  loadHiddenColumns();
  loadFilterSortState();
  loadContactHiddenColumns();
  loadContactFilterSortState();
  await loadWorkbook();
  await route();
}

init();
