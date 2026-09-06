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
const resultCountEl = document.getElementById("result-count");
const tbodyEl = document.getElementById("companies-tbody");

let workbook = { companies: [], contacts: [], aiInitiatives: [], aiInvestment: [], sources: [] };
let sortField = "aiPriorityScore";
let sortDirection = "desc";
let expandedCompanyId = null;

function formatNumber(value) {
  if (value == null || value === "") return "—";
  const num = typeof value === "number" ? value : parseFloat(value);
  return Number.isNaN(num) ? String(value) : num.toLocaleString();
}

// xlsx-lite.js deliberately doesn't read styles.xml (see its own file
// comment), so a date-formatted cell comes through as its raw numeric serial
// (days since 1899-12-30, Excel's own epoch) rather than a date string - a
// field like Last_Verified would otherwise render as a meaningless number
// like 46270. Only applied to fields already known to be dates (below), not
// blindly to every number, since plenty of other numeric fields (scores,
// employee counts) aren't dates and would be misread as one.
function formatExcelDate(value) {
  if (typeof value !== "number") return formatValue(value);
  const ms = Date.UTC(1899, 11, 30) + value * 86400000;
  return new Date(ms).toLocaleDateString();
}

function formatValue(value) {
  if (value == null || value === "") return "—";
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}

function priorityPillClass(label) {
  if (!label) return "priority-pill-other";
  const normalized = label.toLowerCase();
  if (normalized.startsWith("very high")) return "priority-pill-veryhigh";
  if (normalized.startsWith("high")) return "priority-pill-high";
  return "priority-pill-other";
}

function matchesSearch(company, query) {
  if (!query) return true;
  const haystack = `${company.company || ""} ${company.industry || ""}`.toLowerCase();
  return haystack.includes(query);
}

function sortedFilteredCompanies() {
  const query = searchInputEl.value.trim().toLowerCase();
  const filtered = workbook.companies.filter((c) => matchesSearch(c, query));
  filtered.sort((a, b) => {
    const va = a[sortField];
    const vb = b[sortField];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return sortDirection === "asc" ? cmp : -cmp;
  });
  return filtered;
}

function updateSortIndicators() {
  for (const th of document.querySelectorAll("#companies-table th[data-sort]")) {
    th.textContent = th.textContent.replace(/ [▲▼]$/, "");
    if (th.dataset.sort === sortField) th.textContent += sortDirection === "asc" ? " ▲" : " ▼";
  }
}

function detailField(label, value) {
  const wrap = document.createElement("div");
  const labelEl = document.createElement("div");
  labelEl.className = "detail-field-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = "detail-field-value";
  valueEl.textContent = value;
  wrap.append(labelEl, valueEl);
  return wrap;
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
  section.appendChild(table);
  return section;
}

function buildDetailContent(company) {
  const wrap = document.createElement("div");

  const fields = document.createElement("div");
  fields.className = "detail-fields";
  fields.append(
    detailField("Company Type", formatValue(company.companyType)),
    detailField("Prospect Status", formatValue(company.prospectStatus)),
    detailField("Swiss Decision Authority", formatValue(company.swissDecisionAuthority)),
    detailField("Global HQ", [company.globalHqCity, company.globalHqCountry].filter(Boolean).join(", ") || "—"),
    detailField("Global Revenue", `${formatNumber(company.globalRevenue)} ${company.revenueCurrency || ""}`.trim()),
    detailField("Swiss Revenue", company.swissRevenue != null ? `${formatNumber(company.swissRevenue)} ${company.swissRevenueCurrency || ""}`.trim() : "—"),
    detailField("Global Employees", formatNumber(company.globalEmployees)),
    detailField("Swiss Employees", formatNumber(company.swissEmployees)),
    detailField("AI Investment (Global)", formatValue(company.aiInvestmentGlobal)),
    detailField("AI Investment (Switzerland)", formatValue(company.aiInvestmentSwitzerland)),
    detailField("AI Portfolio Profile", formatValue(company.aiPortfolioProfile)),
    detailField("Research Quality", formatValue(company.researchQuality)),
    detailField("Evidence Coverage", formatValue(company.evidenceCoverage)),
    detailField("Last Verified", formatExcelDate(company.lastVerified)),
  );
  wrap.appendChild(fields);

  if (company.priorityRationale) {
    const rationale = document.createElement("p");
    rationale.className = "detail-field-value";
    rationale.textContent = company.priorityRationale;
    wrap.appendChild(rationale);
  }
  if (company.primarySourceUrl) {
    const link = document.createElement("a");
    link.href = company.primarySourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Primary source ↗";
    wrap.appendChild(link);
  }

  const contacts = workbook.contacts.filter((c) => c.companyId === company.companyId);
  wrap.appendChild(buildSubtable("Contacts", contacts, [
    { label: "Name", field: "fullName" },
    { label: "Job Title", field: "jobTitle" },
    { label: "Seniority", field: "seniority" },
    { label: "AI Relevance", field: "aiRelevance" },
    { label: "Swiss Based", field: "swissBased" },
    { label: "Profile", field: "profileUrl", link: true, linkLabel: "LinkedIn ↗" },
  ]));

  const initiatives = workbook.aiInitiatives.filter((i) => i.companyId === company.companyId);
  wrap.appendChild(buildSubtable("AI Initiatives", initiatives, [
    { label: "Initiative", field: "initiativeName" },
    { label: "Category", field: "aiCategory" },
    { label: "Status", field: "status" },
    { label: "Announced", field: "announcedDate", date: true },
    { label: "Description", field: "description" },
    { label: "Source", field: "sourceUrl", link: true },
  ]));

  const investments = workbook.aiInvestment.filter((v) => v.companyId === company.companyId);
  if (investments.length > 0) {
    wrap.appendChild(buildSubtable("AI Investment", investments, [
      { label: "Year", field: "year" },
      { label: "Scope", field: "scope" },
      { label: "Amount Low", field: "amountLow" },
      { label: "Amount High", field: "amountHigh" },
      { label: "Currency", field: "currency" },
      { label: "Source", field: "sourceUrl", link: true },
    ]));
  }

  const sources = workbook.sources.filter((s) => s.companyId === company.companyId);
  if (sources.length > 0) {
    wrap.appendChild(buildSubtable("Sources", sources, [
      { label: "Type", field: "sourceType" },
      { label: "Title", field: "sourceTitle" },
      { label: "Used For", field: "usedFor" },
      { label: "Evidence Quality", field: "evidenceQuality" },
      { label: "Link", field: "url", link: true },
    ]));
  }

  return wrap;
}

function renderTable() {
  const companies = sortedFilteredCompanies();
  resultCountEl.textContent = `${companies.length} of ${workbook.companies.length} companies`;
  updateSortIndicators();

  tbodyEl.innerHTML = "";
  for (const company of companies) {
    const tr = document.createElement("tr");
    tr.className = "company-row";
    if (expandedCompanyId === company.companyId) tr.classList.add("expanded");

    const pill = document.createElement("span");
    pill.className = `priority-pill ${priorityPillClass(company.aiPriority)}`;
    pill.textContent = company.aiPriority || "—";

    const priorityTd = document.createElement("td");
    priorityTd.appendChild(pill);

    tr.append(
      cell(company.company),
      cell(company.industry),
      cell(company.companyType),
      cell(formatNumber(company.swissEmployees)),
      cell(company.globalRevenue != null ? `${formatNumber(company.globalRevenue)} ${company.revenueCurrency || ""}`.trim() : "—"),
      cell(company.aiPriorityScore != null ? Math.round(company.aiPriorityScore) : "—"),
      priorityTd,
      cell(company.researchStatus),
    );
    tr.addEventListener("click", () => {
      expandedCompanyId = expandedCompanyId === company.companyId ? null : company.companyId;
      renderTable();
    });
    tbodyEl.appendChild(tr);

    if (expandedCompanyId === company.companyId) {
      const detailTr = document.createElement("tr");
      detailTr.className = "detail-row";
      const td = document.createElement("td");
      td.colSpan = 8;
      td.appendChild(buildDetailContent(company));
      detailTr.appendChild(td);
      tbodyEl.appendChild(detailTr);
    }
  }
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text ?? "—";
  return td;
}

for (const th of document.querySelectorAll("#companies-table th[data-sort]")) {
  th.addEventListener("click", () => {
    const field = th.dataset.sort;
    sortDirection = sortField === field && sortDirection === "desc" ? "asc" : "desc";
    sortField = field;
    renderTable();
  });
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
  await loadWorkbook();
}

init();
