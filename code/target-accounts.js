// Target Accounts Dashboard: browses the full multi-sheet workbook (this
// page's own Import Target Accounts button - storage.js's
// importTargetAccountsWorkbook; Settings no longer has a copy of this,
// moved here entirely 2026-09-16). Three hash-routed views (PRD 6.19): the
// list view (Companies sheet as the master table, priority-sorted, flagged
// for an unreviewed post or overdue follow-up), an Account view
// (#account=<companyKey>) with related Contacts/AI_Initiatives/
// AI_Investment/Sources rows joined client-side by Company_ID (camelCased
// companyId), and a Contact view (#contact=<contactKey>). Both detail views
// carry their own persisted Sales Mentor/Customer Voice chat. This workbook
// is a separate, richer dataset from the lightweight targetAccounts map
// (6.11) that drives auto-prioritization - importing the same .xlsx
// populates both in one action. Also owns the confidence threshold and the
// experimental Resolve LinkedIn Company IDs action (6.16), both likewise
// moved here from Settings the same day.
import { askConfirm, mirrorStatusToPopup } from "./confirm-dialog.js";
import { applyOnboardingNavState } from "./settings-nav-state.js";
import {
  getTargetAccountsWorkbook,
  getTargetAccountsMeta,
  getTargetAccounts,
  importTargetAccounts,
  importTargetAccountsWorkbook,
  exportTargetAccountsBackup,
  importTargetAccountsBackup,
  getTargetAccountsMissingLinkedinId,
  applyResolvedCompanyIds,
  markLinkedinResolveAttempted,
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
  getUserProfile,
  getIdealCustomerProfile,
  getOutputLanguage,
  getCustomerPersona,
  getOnboardingCompletedAt,
  getPendingDiscoveredMergeCounts,
  getPendingDiscoveredMergePreview,
  mergeDiscoveredIntoWorkbook,
  mergeTargetAccounts,
  addHubspotRowsToWorkbook,
  addWebResearchInitiatives,
  getKeptSeparatePairs,
  addKeptSeparatePairs,
  clearKeptSeparatePairs,
  getCompanyExclusions,
  isCompanyRowExcluded,
  backfillCompanyExclusionsFromWorkbook,
  getExistingCompaniesNeedingContacts,
  getTargetUniverseConfig,
  getTargetContactProfile,
  classifyJobTitleSeniority,
  getCompaniesForPrioritization,
  applyCompanyPrioritizationResults,
  bulkPatchExtras,
  getLastBulkExtrasChange,
  undoLastBulkExtrasChange,
  getWebFindingsArbitration,
  getRevenueNormalization,
  appendActivityLogBatch,
  resolveLocationPriority,
  SIZE_PRIORITY_BUCKETS,
  syncLinkedinLinksToWorkbook,
  getCompaniesNeedingSize,
  markCompanySizeFetchAttempted,
  applyCompanySizeResults,
  SENIORITY_LEVELS,
  exportSettings,
  exportLeads,
  importSettings,
  importLeads,
} from "./storage.js";
import { chooseRestoreSections, extractBackupPart, startAutoBackup, safetyCopyBeforeRestore } from "./backup-restore.js";
import { parseFullBackup, restoreFullBackup } from "./full-backup.js";
import { IMPORT_COLUMNS } from "./import-columns.js";
import { confirmIfCostly, getCostWarningUsd, getApiUsage, sumDays } from "./api-usage.js";
import { isBlankFinding, computeFindingProposals as computeProposalsFor, WEB_FINDING_FIELDS } from "./web-research-apply.js";
import { DEFAULT_EXCHANGE_RATES } from "./value-normalize.js";
import { arbitrateAccount, summarize as summarizeArbitration, RULES as ARBITRATION_RULES } from "./web-findings-arbitration.js";
import { guardBatchStart, getRunningBatch, busyMessage, withBatch } from "./batch-jobs.js";
import { initBatchStatus } from "./batch-status.js";
import { parseCsv, detectHubspotFile, hubspotCompanyRows, hubspotContactRows, buildHubspotFiles } from "./hubspot.js";
import { parseFullTargetAccountsWorkbook } from "./xlsx-lite.js";
import { resolveConfirmText, runCompanyIdResolution } from "./company-resolve-extraction.js";
import { runContactDiscoveryForExistingCompanies } from "./contact-discovery-extraction.js";
import { sizeFetchConfirmText, runCompanySizeFetch } from "./company-size-extraction.js";
import { appendActionsCol, appendActionsTh, appendActionsTd } from "./actions-column.js";
import {
  sanitizeApiKey,
  runAgentTurn,
  buildAccountScopedMentorPrompt,
  researchAccountOnWeb,
  buildAccountScopedCustomerVoicePrompt,
  buildContactScopedMentorPrompt,
  buildContactScopedCustomerVoicePrompt,
  prioritizeCompanies,
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
const targetAccountsPageIoStatusEl = document.getElementById("target-accounts-page-io-status");
// Import / restore progress and results appear as a pop-up, not only as a line of text on the page.
mirrorStatusToPopup(["target-accounts-page-io-status", "account-web-research-status", "hubspot-import-status"]);
const resolveCompanyIdsBtn = document.getElementById("resolve-company-ids-btn");
const stopResolveCompanyIdsBtn = document.getElementById("stop-resolve-company-ids-btn");
const resolveCompanyIdsLimitInput = document.getElementById("resolve-company-ids-limit-input");
const resolveCompanyIdsStatusEl = document.getElementById("resolve-company-ids-status");
const discoverContactsExistingBtn = document.getElementById("discover-contacts-existing-btn");
const stopDiscoverContactsExistingBtn = document.getElementById("stop-discover-contacts-existing-btn");
const discoverContactsExistingLimitInput = document.getElementById("discover-contacts-existing-limit-input");
const discoverContactsExistingStatusEl = document.getElementById("discover-contacts-existing-status");
const prioritizeCompaniesBtn = document.getElementById("prioritize-companies-btn");
const prioritizeCompaniesRescoreCheckbox = document.getElementById("prioritize-companies-rescore-checkbox");
const prioritizeCompaniesAiCheckbox = document.getElementById("prioritize-companies-ai-checkbox");
const prioritizeCompaniesLimitInput = document.getElementById("prioritize-companies-limit-input");
const prioritizeCompaniesStatusEl = document.getElementById("prioritize-companies-status");
const fetchCompanySizeBtn = document.getElementById("fetch-company-size-btn");
const stopFetchCompanySizeBtn = document.getElementById("stop-fetch-company-size-btn");
const fetchCompanySizeLimitInput = document.getElementById("fetch-company-size-limit-input");
const fetchCompanySizeStatusEl = document.getElementById("fetch-company-size-status");
let sizeFetchAbortRequested = false;
// Module-scoped, not local to the click handler below - the Stop button has
// its own separate click listener and needs to reach the same flag a
// currently-running resolve is reading via its shouldAbort callback.
let resolveAbortRequested = false;
let contactDiscoveryExistingAbortRequested = false;
const linkedinResolveStatusEl = document.getElementById("linkedin-resolve-status");
const pageHeaderMergeRowEl = document.getElementById("page-header-merge-row");
const mergeDiscoveredBtn = document.getElementById("merge-discovered-btn");
const mergeDiscoveredStatusEl = document.getElementById("merge-discovered-status");

// PRD 6.20 Phase 10 (2026-09-17/18) - left nav's own trigger buttons just
// open the matching dialog; every control/handler inside each dialog is
// unchanged from the old always-visible header rows (same ids), so no other
// wiring in this file needed to change. Close buttons are generic - each
// just closes whichever <dialog> it's inside, no per-dialog logic needed.
document.getElementById("nav-resolve-btn").addEventListener("click", () => {
  document.getElementById("resolve-dialog").showModal();
});
document.getElementById("nav-discover-contacts-btn").addEventListener("click", () => {
  document.getElementById("discover-contacts-dialog").showModal();
});
document.getElementById("nav-fetch-size-btn").addEventListener("click", () => {
  document.getElementById("fetch-size-dialog").showModal();
});
document.getElementById("nav-find-duplicates-btn").addEventListener("click", async () => {
  await renderFindDuplicates();
  document.getElementById("find-duplicates-dialog").showModal();
});
document.getElementById("find-duplicates-close-btn").addEventListener("click", () => document.getElementById("find-duplicates-dialog").close());
document.getElementById("nav-prioritize-btn").addEventListener("click", () => {
  document.getElementById("prioritize-companies-dialog").showModal();
});
document.querySelectorAll(".action-dialog-close-btn").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest("dialog").close());
});
const paginationTopEl = document.getElementById("pagination-top");
const paginationBottomEl = document.getElementById("pagination-bottom");
const tableScrollTopEl = document.getElementById("table-scroll-top");
const tableScrollTopFillerEl = document.getElementById("table-scroll-top-filler");
const companiesTableEl = document.getElementById("companies-table");
const accountsStatsSectionEl = document.getElementById("accounts-stats-section");

const tabAccountsEl = document.getElementById("tab-accounts");
const tabContactsEl = document.getElementById("tab-contacts");
const navGroupAccountsEl = document.getElementById("nav-group-accounts");
const navGroupContactsEl = document.getElementById("nav-group-contacts");

// PRD 6.20 Phase 10 follow-up (2026-09-19), 6th round of direct feedback:
// EVERY cross-page nav item now embeds in place, none open a new tab any
// more - "I do not see any reason for a new tab... once you open it in a
// new tab, there is no more any way to come back to the main menu." The 4
// simple pages (Advisors/Activity Log/Help - "Pipeline Overview" removed
// entirely per the same feedback, see below) have no nav shell of their
// own, so embedding just shows their real content. The 3 "big" pages
// (Target Accounts/Posts Dashboard/Scanner/Settings) DO have their own
// full #app-shell/#app-nav - embedding one as-is would nest a second
// sidebar inside this page's own. Fixed with a `?embedded=1` query param
// each of those pages' own JS checks for (see this file's own `route()`/
// init() below) to hide ITS OWN #app-nav when loaded inside an iframe,
// relying on the host page's nav + "← Back" for further navigation
// instead. showEmbeddedPage adds that flag automatically (inserted before
// any #hash, since a URL's query has to precede its fragment) so every
// call site below stays a plain (page[#hash], title) pair.
const pageNativeContentEl = document.getElementById("page-native-content");
const embeddedPageWrapEl = document.getElementById("embedded-page-wrap");
const embeddedPageBarEl = document.getElementById("embedded-page-bar");
const embeddedPageFrameEl = document.getElementById("embedded-page-frame");
const embeddedPageTitleEl = document.getElementById("embedded-page-title");

// 19th round of direct feedback (2026-09-19): "The Advisors, Activity Log
// and Help pages, all still have this <-Back button at the top. Please
// remove it" - then, same round, immediately widened: "Also Scanner page
// has this <--Back button... remove it from all pages!" The host's own
// #app-nav stays visible the whole time an embedded page is showing and
// already works to switch away - the bar/button never added anything a
// nav click didn't already do, so it's hidden unconditionally now rather
// than only for some pages.
function showEmbeddedPage(page, title) {
  const [base, hash] = page.split("#");
  const sep = base.includes("?") ? "&" : "?";
  const url = hash ? `${base}${sep}embedded=1#${hash}` : `${base}${sep}embedded=1`;
  const resolvedUrl = chrome.runtime.getURL(url);
  pageNativeContentEl.hidden = true;
  embeddedPageTitleEl.textContent = title;
  embeddedPageBarEl.hidden = true;
  // 26th round of direct feedback (2026-09-19): "Re-score All Priorities...
  // only works once and never again, unless I click Open Posts Dashboard
  // again, which seems to reset/unfreeze it." Root cause: re-clicking the
  // SAME action item twice in a row sets the iframe's src to the EXACT
  // SAME URL it already has - assigning an identical src is a total no-op
  // in browsers (no navigation, not even a hashchange event), so neither
  // init() nor the hashchange listener ever get a second chance to re-run
  // the action. "Open Posts Dashboard" only "fixed" it by accident, since
  // its own hash always differs from whatever action was last triggered,
  // which is always a real, distinct navigation. Bounced through
  // about:blank first whenever the requested URL matches what's already
  // loaded, forcing a genuinely fresh navigation (and a fresh init() run)
  // every time, regardless of whether the target page/action repeats.
  // Re-requesting the page that is already loaded: navigate the frame in place. (The old "bounce through about:blank
  // then set src again" could be dropped by the browser, leaving the frame blank - reported 2026-09-21: pressing
  // Change Settings a second time showed an empty screen.) A URL that differs only by its #hash is a same-page
  // navigation, so the page's own hashchange routing runs; an identical URL reloads it, re-running its action.
  let sameDocument = false;
  let willLoad = true;
  try {
    sameDocument = Boolean(embeddedPageFrameEl.contentWindow) &&
      embeddedPageFrameEl.contentWindow.location.href.split("#")[0] === resolvedUrl.split("#")[0];
  } catch (err) { /* cross-origin or not loaded yet: fall through to a plain src assignment */ }
  if (sameDocument) {
    // Identical URL (same action pressed again, e.g. after Cancel): a fragment-only "navigation" to it would do
    // nothing, so reload; a URL that differs only by #hash is routed by the page's own hashchange handler.
    const frameWindow = embeddedPageFrameEl.contentWindow;
    if (frameWindow.location.href === resolvedUrl) {
      frameWindow.location.reload();
    } else {
      frameWindow.location.replace(resolvedUrl);
      willLoad = false; // same-page navigation: no load event will follow
    }
  } else {
    embeddedPageFrameEl.src = resolvedUrl;
  }
  // Say so while the page loads - an opening page used to look like a blank screen.
  if (willLoad) {
    embeddedPageWrapEl.classList.add("embedded-loading");
    embeddedPageFrameEl.onload = () => {
      if (!embeddedPageFrameEl.src.startsWith("about:")) embeddedPageWrapEl.classList.remove("embedded-loading");
    };
  } else {
    embeddedPageWrapEl.classList.remove("embedded-loading");
  }
  embeddedPageWrapEl.hidden = false;
}

function hideEmbeddedPage() {
  embeddedPageWrapEl.hidden = true;
  embeddedPageFrameEl.src = "about:blank";
  pageNativeContentEl.hidden = false;
}

// Pages shown inside this one can ask it to close them (e.g. the "Back to menu" link of Change Settings).
window.addEventListener("message", (event) => {
  if (event.origin === location.origin && event.data && event.data.type === "salesteam-close-embedded") hideEmbeddedPage();
});

document.getElementById("embedded-page-close-btn").addEventListener("click", hideEmbeddedPage);
document.getElementById("app-nav-brand-name").addEventListener("click", hideEmbeddedPage);

// This page's OWN half of the embedding scheme above: when SOMETHING ELSE
// embeds this page via ?embedded=1, hide this page's own #app-nav (it
// would otherwise nest a second sidebar inside the host page's one) -
// applied synchronously, before any async init work, so there's no flash
// of the full layout first.
if (new URLSearchParams(location.search).has("embedded")) {
  document.getElementById("app-shell").classList.add("embedded-mode");
}

document.getElementById("open-dashboard-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html", "Posts Dashboard"));
document.getElementById("nav-prioritize-unscored-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=prioritize-unscored", "Posts Dashboard"));
document.getElementById("nav-rescore-all-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=rescore-all", "Posts Dashboard"));
document.getElementById("nav-extract-companies-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=extract-companies", "Posts Dashboard"));
document.getElementById("nav-extract-companies-profiles-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=extract-companies-profiles", "Posts Dashboard"));
document.getElementById("nav-apply-location-filter-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=apply-location-filter", "Posts Dashboard"));
document.getElementById("nav-export-csv-all-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=export-csv-all", "Posts Dashboard"));
document.getElementById("nav-export-csv-filtered-btn").addEventListener("click", () => showEmbeddedPage("dashboard.html#action=export-csv-filtered", "Posts Dashboard"));
document.getElementById("open-scanner-page-btn").addEventListener("click", () => showEmbeddedPage("scanner.html", "Scanner"));

document.getElementById("open-settings-setup-btn").addEventListener("click", () => showEmbeddedPage("settings.html#setup-section", "Settings"));
document.getElementById("open-settings-change-btn").addEventListener("click", () => showEmbeddedPage("settings.html#change-settings", "Settings"));
applyOnboardingNavState(document.getElementById("open-settings-setup-btn")).catch(() => {});
document.getElementById("open-settings-profile-btn").addEventListener("click", () => showEmbeddedPage("settings.html#profile-section", "Settings"));
document.getElementById("open-settings-language-btn").addEventListener("click", () => showEmbeddedPage("settings.html#language-section", "Settings"));
document.getElementById("open-settings-apikey-btn").addEventListener("click", () => showEmbeddedPage("settings.html#api-key-section", "Settings"));
document.getElementById("open-settings-backup-btn").addEventListener("click", () => showEmbeddedPage("settings.html#backup-section", "Settings"));
document.getElementById("open-settings-restore-btn").addEventListener("click", () => showEmbeddedPage("settings.html#restore-section", "Settings"));
document.getElementById("open-settings-billing-btn").addEventListener("click", () => showEmbeddedPage("settings.html#billing-section", "Settings"));
document.getElementById("open-advisors-btn").addEventListener("click", () => showEmbeddedPage("advisors.html", "Advisors"));
document.getElementById("open-activity-log-btn").addEventListener("click", () => showEmbeddedPage("activity-log.html", "Activity Log"));
document.getElementById("open-help-btn").addEventListener("click", () => showEmbeddedPage("help.html", "Help"));
document.getElementById("open-debug-queue-btn").addEventListener("click", () => showEmbeddedPage("settings.html#discovery-queue-section", "Settings"));
document.getElementById("open-debug-company-btn").addEventListener("click", () => showEmbeddedPage("settings.html#company-discovery-section", "Settings"));
document.getElementById("open-debug-contact-btn").addEventListener("click", () => showEmbeddedPage("settings.html#contact-discovery-section", "Settings"));

// PRD 6.20 Phase 10 follow-up (2026-09-19) - collapsible nav ("a dynamic
// frame that I can extend... or retract, to have more space for the main
// window"). Persisted (localStorage, not chrome.storage - purely a local
// display preference, not data) so it stays collapsed/expanded across
// page navigations within this browser profile, not just this one tab.
const NAV_COLLAPSED_KEY = "salesteam-nav-collapsed";
const navCollapseBtn = document.getElementById("nav-collapse-btn");
function applyNavCollapsed(collapsed) {
  document.getElementById("app-shell").classList.toggle("nav-collapsed", collapsed);
  navCollapseBtn.textContent = collapsed ? "»" : "«";
  navCollapseBtn.title = collapsed ? "Expand the menu" : "Collapse the menu";
}
applyNavCollapsed(localStorage.getItem(NAV_COLLAPSED_KEY) === "1");
navCollapseBtn.addEventListener("click", () => {
  const collapsed = !document.getElementById("app-shell").classList.contains("nav-collapsed");
  applyNavCollapsed(collapsed);
  localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
});

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
let sortField = "salesTeamPriorityScore";
let sortDirection = "desc";
let openMenuColumnId = null;
let columnFilters = {}; // { [columnId]: { text, exclude } }
let hiddenColumns = new Set();
let pageSize = 50; // 20/50/100 - reported directly, 500 companies unpaginated was too much to scroll through
let currentPage = 1;
let currentAccountKey = null; // normalizeCompanyName(company) of the account view currently open, if any
let currentContactKey = null; // contactKeyFor(...) of the contact view currently open, if any

// PRD 6.20 Phase 10 Step 3 (2026-09-18) - Edit mode toggle, reset whenever
// the open account/contact actually changes (see renderAccountView/
// renderContactView) so it never leaks from one entity to the next; stays
// on across a Save/Cancel's own re-render of the SAME entity. pendingEdit*
// lets the table row's own "Edit" kebab item open straight into edit mode
// after navigating there (a hash change is the only signal route() gets,
// so there's no other way to pass "and start editing" along with it).
let accountEditMode = false;
let contactEditMode = false;
let pendingAccountEditKey = null;
let pendingContactEditKey = null;

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
// bucket like "Priority range" or "Account status"), unlike the Posts
// Dashboard's status pies which filter the table by clicking a slice.
// percentOf (29th round of direct feedback, 2026-09-19): "a Percentage next
// to each number (the % from the total of 544)" - optional and opt-in, so
// every other pie on this page keeps its existing legend untouched; only
// the caller that actually wants a percentage (Contact coverage, against
// the full company count, not just this pie's own filtered subtotal) needs
// to pass it.
function renderGenericPieChart(containerEl, slices, { unitLabel = "", onSliceClick, percentOf } = {}) {
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
      const percentText = percentOf > 0 ? ` (${Math.round((slice.count / percentOf) * 100)}%)` : "";
      row.append(swatch, document.createTextNode(` ${slice.label}: ${slice.count}${percentText}`));
      if (onSliceClick) row.addEventListener("click", () => onSliceClick(slice.label));
      legend.appendChild(row);
    }
  }

  containerEl.append(svg, legend);
}

// Company Explorer columns, in display order (left to right). Reordered 2026-09-19
// (reported directly): the columns a salesperson triages on come first and are the
// only ones visible by default; everything imported from a research workbook, and
// every data-quality/methodology field, starts hidden and is one click away via the
// Columns button or a column's own "Hide This Column" menu item. Order of THIS list
// is the on-screen order. Visibility defaults come from `visible` below, but a saved
// per-browser choice wins (HIDDEN_COLUMNS_STORAGE_KEY) - hence its "-v2" suffix, which
// discards saved choices made under the previous default layout, once.
const COMPANY_COLUMNS = [
  // --- Shown by default ---
  { id: "company", label: "Company", visible: true },
  { id: "industry", label: "Industry", visible: true },
  // SalesTeam's own company-level priority (storage.js's prioritizeCompanies /
  // applyCompanyPrioritizationResults). Distinct from the imported workbook's own
  // conclusion (aiPriority* / priorityRationale, labelled "Imported ..." below).
  { id: "salesTeamPriority", label: "Priority", visible: true, pill: true },
  { id: "salesTeamPriorityScore", label: "Priority Score", visible: true, numeric: true },
  { id: "salesTeamPriorityReason", label: "Priority Reason", visible: true, longText: true },
  // Not a stored field - computed live from every lead matched to this company by
  // name (see accountStatusPillClass/renderCellContent), same rollup the pie uses.
  { id: "accountStatus", label: "Status", visible: true, pill: true },
  // Also computed, not stored: what the last web research of this account found that its data
  // does not already say, minus whatever the user chose to keep their own value for. Without it
  // the findings are only reachable through each account's own "Review findings…" button, which
  // is unusable across hundreds of rows. Filter this column on "review" to list them.
  { id: "webFindings", label: "Web Findings", visible: true },
  { id: "linkedinLink", label: "LinkedIn Link", visible: true, link: true },
  // Schema 1.1 (V1.32 research prompt): Target_Country_Relationship = "Local company" / "Global company" (where the
  // group is headquartered relative to the project's home market). Older workbooks have no such column - the value then
  // falls back to Company_Type, which in the first workbook (V66) carried that same classification.
  { id: "targetCountryRelationship", label: "Local / Global", visible: true },
  // Ownership only (Public / Private / Cooperative / State-owned...). Empty for older workbooks, where Company_Type
  // carried the Local/Global classification that the column above already shows.
  { id: "companyType", label: "Company Type", visible: true },
  { id: "globalEmployees", label: "Employees", visible: true, numeric: true },
  { id: "globalRevenue", label: "Global Revenue", visible: true, numeric: true, currencyField: "revenueCurrency" },

  // --- Hidden by default: imported research-workbook fields ---
  // "Imported" (workbook) or "Discovered" (mergeDiscoveredIntoWorkbook, storage.js).
  { id: "source", label: "Source", pill: true },
  { id: "aiPriorityScore", label: "Imported Priority Score", numeric: true },
  { id: "aiPriority", label: "Imported Priority", pill: true },
  { id: "priorityRationale", label: "Imported Priority Rationale", longText: true },
  { id: "researchStatus", label: "Research Status" },
  { id: "evidenceStatus", label: "Evidence Status" },
  { id: "evidenceCoverage", label: "Evidence Coverage", percent: true },
  { id: "zefixOfficialName", label: "Registry Official Name" },
  { id: "alternativeCompanyName", label: "Alternative Company Name" },
  { id: "companyId", label: "Company ID" },
  { id: "universeOrder", label: "Universe Order", numeric: true },
  { id: "aiUseCaseFitScore", label: "Use Case Fit Score", numeric: true },
  { id: "researchQuality", label: "Research Quality" },
  { id: "primarySourceUrl", label: "Primary Source", link: true },
  { id: "lastVerified", label: "Last Verified", date: true },
  { id: "aiPortfolioProfile", label: "Portfolio Profile" },
  { id: "aiPortfolioProfileConfidence", label: "Portfolio Profile Confidence" },
  { id: "zefixUid", label: "Registry ID" },
  { id: "zefixAddress", label: "Registry Address" },
  { id: "prospectStatus", label: "Prospect Status" },
  { id: "globalHqCity", label: "Global HQ City" },
  { id: "globalHqCountry", label: "Global HQ Country" },
  { id: "mainSwissLocation", label: "Main Local Location" },
  { id: "swissDecisionAuthority", label: "Local Decision Authority" },
  { id: "revenuePeriod", label: "Revenue Period" },
  { id: "globalRevenueConfidence", label: "Global Revenue Confidence" },
  { id: "swissRevenue", label: "Local Revenue", numeric: true, currencyField: "swissRevenueCurrency" },
  { id: "swissRevenuePeriod", label: "Local Revenue Period" },
  { id: "swissRevenueConfidence", label: "Local Revenue Confidence" },
  { id: "globalEmployeesPeriod", label: "Global Employees Period" },
  { id: "globalEmployeesConfidence", label: "Global Employees Confidence" },
  // "Fetch Company Size" (2026-09-17) - the raw LinkedIn band text (e.g. "501-1K
  // employees") a size-fetch run wrote alongside globalEmployees' own lower-bound
  // number, for display only - never read by Phase 8's deterministic scorer.
  { id: "employeeCountText", label: "Employee Count (LinkedIn band)" },
  { id: "swissEmployees", label: "Local Employees", numeric: true },
  { id: "swissEmployeesPeriod", label: "Local Employees Period" },
  { id: "swissEmployeesConfidence", label: "Local Employees Confidence" },
  { id: "aiInvestmentGlobal", label: "Investment (Global)" },
  { id: "aiInvestmentSwitzerland", label: "Investment (Local)" },
  { id: "aiInvestmentConfidence", label: "Investment Confidence" },
  { id: "topAiInitiatives", label: "Top Initiatives", longText: true },
  { id: "relevantContactsCount", label: "Relevant Contacts Count", numeric: true },
  { id: "swissSizeFitScore", label: "Local Size Fit Score", numeric: true },
  { id: "decisionAuthorityScore", label: "Decision Authority Score", numeric: true },
  { id: "aiMaturityFitScore", label: "Maturity Fit Score", numeric: true },
  { id: "aiInvestmentScore", label: "Investment Score", numeric: true },
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
  { label: "Relevance", field: "aiRelevance" },
  { label: "Local", field: "swissBased" },
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

const HIDDEN_COLUMNS_STORAGE_KEY = "salesteam-target-accounts-hidden-columns-v3";
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
  // Alt. name(s) (target-accounts.js's ACCOUNT_EDIT_FIELDS) is the one field
  // that can hold an array once overridden - joined for display everywhere
  // an array might show up (this table's own cells included), rather than
  // falling through to Array's own bare comma-join.
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
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

// Separate from priorityPillClass above - "Imported"/"Discovered" aren't
// priority levels, and both would otherwise land in that function's shared
// "other" (gray) fallback, defeating the point of a distinguishing badge.
function sourcePillClass(label) {
  return label === "Discovered" ? "priority-pill-discovered" : "priority-pill-other";
}

// salesTeamPriority's own P1-P5 scale (Phase 8) - separate from
// priorityPillClass above, which only understands aiPriority's Very
// High/High/... labels.
function salesTeamPriorityPillClass(label) {
  const key = String(label || "").toLowerCase();
  return ["p1", "p2", "p3", "p4", "p5"].includes(key) ? `priority-pill-${key}` : "priority-pill-other";
}

// accountStatus/contactStatus's own 3-value scale (Not contacted/Contacted/
// Responded) - same colors as the pie charts' own CONTACT_STATUS_COLORS/
// ACCOUNT_STATUS_COLORS below, so the row pill and the pie legend never
// visually disagree.
function statusPillClass(status) {
  if (status === "Contacted") return "priority-pill-status-contacted";
  if (status === "Responded") return "priority-pill-status-responded";
  return "priority-pill-status-notcontacted";
}

// accountStatus/contactStatus aren't real stored fields - computed fresh
// here the exact same way computeAccountStatusCounts/computeContactStatusCounts
// already do for the pie charts, so the row pill, the pie legend, sorting,
// and filtering can never disagree with each other (all four read through
// this one function).
// "Keep mine" in the Review findings dialog records the value that was turned down, not just the
// field name - so the same finding stays quiet, but a LATER research that turns up a DIFFERENT
// value for that field surfaces again instead of being silently swallowed forever.
function findingValuesMatch(a, b) {
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a), y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && x === y;
  }
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

function isDismissedFinding(dismissed, proposal) {
  if (!dismissed || !Object.prototype.hasOwnProperty.call(dismissed, proposal.key)) return false;
  return findingValuesMatch(dismissed[proposal.key], proposal.found);
}

// Every proposal the stored research still yields for this account, each marked with whether the
// user already turned it down. The table column counts the undismissed ones; the dialog shows them
// all, so a "Keep mine" can be taken back.
function annotatedProposals(company, extra) {
  if (!extra?.webResearch) return [];
  return computeProposalsFor(company, extra.overrides, extra.webResearch.data, moneySettings)
    .map((p) => ({ ...p, dismissed: isDismissedFinding(extra.webFindingsDismissed, p) }));
}

function rawValue(company, column) {
  if (column.id === "webFindings") {
    if (company.fullName != null) return null;
    const extra = accountExtras[normalizeCompanyName(company.company)];
    if (!extra?.webResearch) return null;
    const open = annotatedProposals(company, extra).filter((p) => !p.dismissed).length;
    return open > 0 ? `${open} to review` : "Researched";
  }
  if (column.id === "accountStatus") {
    const key = normalizeCompanyName(company.company);
    const leads = allLeads.filter((l) => normalizeCompanyName(l.company) === key);
    return effectiveStatus(leadStatusBucket(leads), accountExtras[key]?.manualStatus);
  }
  if (column.id === "contactStatus") {
    const key = contactKeyFor(company.company, company.fullName);
    return effectiveStatus(leadStatusBucket(findLeadsForContact(company, allLeads)), contactExtras[key]?.manualStatus);
  }
  // A contact row always has fullName, a company row never does - reused
  // below to pick the right extras store without a second parameter.
  const overrides = (company.fullName != null
    ? contactExtras[contactKeyFor(company.company, company.fullName)]
    : accountExtras[normalizeCompanyName(company.company)]
  )?.overrides;
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, column.id)) return overrides[column.id];
  if (company.fullName == null && column.id === "companyType" && !company.targetCountryRelationship) return null;
  if (company.fullName == null && column.id === "targetCountryRelationship") {
    return company.targetCountryRelationship || localizeTypeWording(company.companyType) || null;
  }
  if (company.fullName != null && (column.id === "seniority" || column.id === "seniorityPriority")) {
    const s = effectiveContactSeniority(company);
    return s ? (column.id === "seniority" ? s.label : s.priority) : null;
  }
  if (company.fullName == null && column.id === "globalEmployees") return effectiveEmployees(company).value;
  return company[column.id];
}

// One SINGLE Seniority value per contact, whichever way it was learned: the level
// SalesTeam's own classifier finds in the job title / headline (against the levels chosen in
// the Setup wizard) wins; when none is configured or matches, the imported workbook's plain
// Seniority text is shown as-is. fromImport marks a value derived from imported data
// (a green dot in the table); values from a Discovered contact carry no dot.
// rawValue() runs for every cell of every row and cannot await, so the currency settings are
// cached here and refreshed by loadWorkbook() rather than read per comparison.
let moneySettings = { targetCurrency: DEFAULT_EXCHANGE_RATES.base, rates: DEFAULT_EXCHANGE_RATES };

let seniorityLevelConfig = [];
function effectiveContactSeniority(contact) {
  const discovered = contact.source === "Discovered";
  if (contact.seniorityLevel) {
    return { label: SENIORITY_LEVEL_LABELS[contact.seniorityLevel] || contact.seniorityLevel, priority: contact.seniorityPriority ?? null, fromImport: false };
  }
  const level = classifyJobTitleSeniority(contact.jobTitle, seniorityLevelConfig);
  if (level) return { label: SENIORITY_LEVEL_LABELS[level.id] || level.id, priority: level.priority ?? null, fromImport: !discovered };
  if (contact.seniority) return { label: contact.seniority, priority: null, fromImport: !discovered };
  return null;
}

// One SINGLE employee figure: an exact number if any source has one (imported count, or
// Fetch Company Size), else the imported size-range text. fromImport is false when the value
// was read from LinkedIn (a Discovered row, or a row with a fetched LinkedIn band).
function effectiveEmployees(company) {
  const fromLinkedin = company.source === "Discovered" || Boolean(company.employeeCountText);
  const num = typeof company.globalEmployees === "number" ? company.globalEmployees
    : typeof company.employeeCount === "number" ? company.employeeCount : null;
  if (num != null) return { value: num, fromImport: !fromLinkedin };
  if (company.employeeRange) return { value: company.employeeRange, fromImport: !fromLinkedin };
  return { value: null, fromImport: false };
}

// The imported workbook's own wording for company type can name the target country
// ("Swiss company"); shown country-neutrally, stored data untouched.
function localizeTypeWording(value) {
  return typeof value === "string" ? value.replace(/\bSwiss\b/g, "Local") : value;
}

function sortValue(company, column) {
  // Sorted by the COUNT, not by the label - "12 to review" belongs above "3 to review", which is
  // not what a lexical sort of the cell text does. Researched-with-nothing-open sorts below both,
  // never-researched below that.
  if (column.id === "webFindings") {
    const v = rawValue(company, column);
    if (!v) return -1;
    return v === "Researched" ? 0 : parseInt(v, 10);
  }
  if (company.fullName == null && column.id === "globalEmployees") {
    const ev = effectiveEmployees(company).value;
    if (typeof ev === "number") return ev;
    const m = typeof ev === "string" ? ev.replace(/,/g, "").match(/\d+/) : null;
    return m ? Number(m[0]) : null;
  }
  const v = column.id === "companyType" ? localizeTypeWording(rawValue(company, column)) : rawValue(company, column);
  if (column.numeric || column.date) return typeof v === "number" ? v : (v == null || v === "" ? null : parseFloat(v));
  return v == null ? "" : String(v).toLowerCase();
}

function filterText(company, column) {
  const v = column.id === "companyType" ? localizeTypeWording(rawValue(company, column)) : rawValue(company, column);
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

// seniorityLevel/seniorityPriority are stored as raw ids/numbers (the
// wizard's own SENIORITY_LEVELS id, and a plain 1-3) - mapped to a readable
// label only at display time, same reasoning as every other id-vs-label
// split in this codebase (aiPriority pills, etc.).
const SENIORITY_LEVEL_LABELS = Object.fromEntries(SENIORITY_LEVELS.map((l) => [l.id, l.label]));
const SENIORITY_PRIORITY_LABELS = { 1: "Low", 2: "Medium", 3: "High" };

// A small green dot after a value that came from the imported research workbook (values read
// from LinkedIn carry no dot). Only the dot itself has a hover tip, never the whole cell, so it
// cannot clash with a column's own hover (e.g. the long-text expand hint).
function appendImportedDot(td) {
  const dot = document.createElement("span");
  dot.className = "imported-dot";
  dot.title = "From your imported research workbook";
  td.appendChild(dot);
}

function renderCellContent(td, company, column) {
  const value = column.id === "companyType" ? localizeTypeWording(rawValue(company, column)) : rawValue(company, column);

  if (company.fullName != null && column.id === "seniority") {
    td.textContent = value || "—";
    if (value && effectiveContactSeniority(company)?.fromImport) appendImportedDot(td);
    return;
  }
  if (company.fullName != null && column.id === "seniorityPriority") {
    td.textContent = value ? (SENIORITY_PRIORITY_LABELS[value] || value) : "—";
    if (value && effectiveContactSeniority(company)?.fromImport) appendImportedDot(td);
    return;
  }
  if (company.fullName == null && column.id === "globalEmployees") {
    td.textContent = typeof value === "number" ? value.toLocaleString() : (value || "—");
    if (value != null && value !== "" && effectiveEmployees(company).fromImport) appendImportedDot(td);
    return;
  }
  if (column.id === "accountStatus" || column.id === "contactStatus") {
    const pill = document.createElement("span");
    pill.className = `priority-pill ${statusPillClass(value)}`;
    pill.textContent = value;
    td.appendChild(pill);
    return;
  }
  if (column.id === "webFindings") {
    if (!value) { td.textContent = "—"; return; }
    const pill = document.createElement("span");
    const toReview = value !== "Researched";
    pill.className = `priority-pill ${toReview ? "priority-pill-findings-open" : "priority-pill-findings-done"}`;
    pill.textContent = value;
    pill.title = toReview
      ? "The web research found facts this account's data does not already say. Open the account and use “Review findings…”."
      : "Researched on the web - nothing left that differs from what this account already has.";
    td.appendChild(pill);
    return;
  }

  if (column.pill) {
    if (!value) { td.textContent = "—"; return; }
    const pillClass = column.id === "source" ? sourcePillClass(value)
      : column.id === "salesTeamPriority" ? salesTeamPriorityPillClass(value)
      : priorityPillClass(value);
    const pill = document.createElement("span");
    pill.className = `priority-pill ${pillClass}`;
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
    // the clamp goes on an inner element - a clamped <td> stops being a table cell and merges with a neighbouring one
    const inner = document.createElement("div");
    inner.className = "long-text-cell";
    inner.textContent = text;
    if (value) {
      inner.title = "Click to expand/collapse";
      inner.addEventListener("click", (e) => { e.stopPropagation(); inner.classList.toggle("expanded"); });
    }
    td.appendChild(inner);
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
  wrap.appendChild(buildSubtable("Initiatives", initiatives, INITIATIVE_COLUMNS));

  const investments = workbook.aiInvestment.filter((v) => v.companyId === company.companyId);
  if (investments.length > 0) wrap.appendChild(buildSubtable("Investment", investments, INVESTMENT_COLUMNS));

  const sources = workbook.sources.filter((s) => s.companyId === company.companyId);
  if (sources.length > 0) wrap.appendChild(buildSubtable("Sources", sources, SOURCE_COLUMNS));

  return wrap;
}

let openRowMenuKey = null;
function closeColumnMenu() {
  openMenuColumnId = null;
  openRowMenuKey = null;
  document.querySelectorAll(".col-menu-popup").forEach((el) => el.remove());
}

function onDocumentClickCloseMenu(event) {
  if (
    !event.target.closest(".col-menu-popup") &&
    !event.target.closest(".col-menu-btn") &&
    !event.target.closest("#columns-btn") &&
    !event.target.closest(".kebab-btn")
  ) {
    closeColumnMenu();
  } else if (openMenuColumnId || openRowMenuKey || document.querySelector(".columns-panel")) {
    document.addEventListener("click", onDocumentClickCloseMenu, { once: true });
  }
}

// Generic per-row action menu (PRD 6.20 Phase 10, 2026-09-17) - the
// Accounts/Contacts tables and their own detail pages all share this for
// their kebab (⋮) dropdown. Reuses the exact same .col-menu-popup/
// .col-menu-item classes and close-on-outside-click machinery as the column
// header menu above (closeColumnMenu already clears any open popup
// regardless of which kind opened it) rather than a parallel, near-
// duplicate implementation. items: { label, onClick, disabled, title,
// danger }[] - disabled renders greyed-out and inert (used for Edit/Merge,
// not yet built); danger gets the same red hover as Dismiss elsewhere.
function openRowActionMenu(anchorEl, rowKey, items) {
  if (openRowMenuKey === rowKey) {
    closeColumnMenu();
    return;
  }
  closeColumnMenu();
  openRowMenuKey = rowKey;

  const popup = document.createElement("div");
  popup.className = "col-menu-popup";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "col-menu-item" + (item.danger ? " danger" : "");
    btn.textContent = item.label;
    if (item.title) btn.title = item.title;
    if (item.disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => {
        closeColumnMenu();
        item.onClick();
      });
    }
    popup.appendChild(btn);
  }

  document.body.appendChild(popup);
  const anchorRect = anchorEl.getBoundingClientRect();
  const popupWidth = popup.offsetWidth;
  const left = Math.min(anchorRect.right - popupWidth, window.innerWidth - popupWidth - 8);
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top = `${anchorRect.bottom + 2}px`;

  setTimeout(() => document.addEventListener("click", onDocumentClickCloseMenu, { once: true }), 0);
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

// --------------------------------------------------------------------------
// Bulk edit: row selection (2026-09-22)
// --------------------------------------------------------------------------
// Selection is kept as a Set of extras keys (normalizeCompanyName / contactKeyFor), NOT of row
// objects or indexes: those keys are what the extras store is keyed by, and they survive paging,
// re-sorting, a filter change and a loadWorkbook() refresh. Selecting rows, filtering to something
// else and selecting more therefore accumulates, which is deliberate - the header checkbox is
// scoped to what is currently filtered, so "select all" never silently reaches rows you cannot see.
const rowSelection = { accounts: new Set(), contacts: new Set() };
// The keys and the filtered total from the last render of each table, captured in renderTable /
// renderContactsTable so the header checkbox and the bar never recompute (and never disagree with)
// what is actually on screen.
const lastPageKeys = { accounts: [], contacts: [] };
const lastFilteredCount = { accounts: 0, contacts: 0 };

function selectionSet(scope) {
  return rowSelection[scope];
}

// Gmail's rule, confirmed against the real thing (2026-09-22): the header checkbox ticks THIS PAGE
// only, and reaching every row matching the filter is a second, explicit click in the bar. Selecting
// hundreds of invisible rows should never be the accidental outcome of one tick.
function pageKeysFor(scope) {
  return lastPageKeys[scope];
}

function filteredKeysFor(scope) {
  return scope === "accounts"
    ? sortedFilteredCompanies().map((c) => normalizeCompanyName(c.company)).filter(Boolean)
    : sortedFilteredContacts().map((c) => contactKeyFor(c.company, c.fullName)).filter(Boolean);
}

function selectCol() {
  const col = document.createElement("col");
  col.style.width = "34px";
  return col;
}

function selectAllTh(scope) {
  const th = document.createElement("th");
  th.className = "select-cell";
  const keys = pageKeysFor(scope);
  const selected = selectionSet(scope);
  const chosen = keys.filter((k) => selected.has(k)).length;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = keys.length > 0 && chosen === keys.length;
  cb.indeterminate = chosen > 0 && chosen < keys.length;
  cb.title = `Select the ${keys.length} row${keys.length === 1 ? "" : "s"} on this page`;
  cb.addEventListener("change", () => {
    for (const k of keys) {
      if (cb.checked) selected.add(k); else selected.delete(k);
    }
    rerenderForScope(scope);
  });
  th.appendChild(cb);
  return th;
}

function selectTd(scope, key) {
  const td = document.createElement("td");
  td.className = "select-cell";
  if (!key) return td;
  const selected = selectionSet(scope);
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selected.has(key);
  cb.addEventListener("change", () => {
    if (cb.checked) selected.add(key); else selected.delete(key);
    // Only the bar and the header tri-state need to change - re-rendering the whole table on every
    // tick would lose scroll position and feel broken while ticking a run of rows by hand.
    renderBulkBar(scope);
    refreshSelectAllHeader(scope);
  });
  td.appendChild(cb);
  return td;
}

function rerenderForScope(scope) {
  if (scope === "accounts") renderTable(); else renderContactsTable();
  renderBulkBar(scope);
}

function refreshSelectAllHeader(scope) {
  const thead = scope === "accounts" ? theadEl : contactsTheadEl;
  const cb = thead.querySelector("th.select-cell input[type=checkbox]");
  if (!cb) return;
  const keys = filteredKeysFor(scope);
  const selected = selectionSet(scope);
  const chosen = keys.filter((k) => selected.has(k)).length;
  cb.checked = keys.length > 0 && chosen === keys.length;
  cb.indeterminate = chosen > 0 && chosen < keys.length;
}

function renderBulkBar(scope) {
  const bar = document.getElementById(scope === "accounts" ? "accounts-bulk-bar" : "contacts-bulk-bar");
  const countEl = document.getElementById(scope === "accounts" ? "accounts-bulk-count" : "contacts-bulk-count");
  const extendEl = document.getElementById(scope === "accounts" ? "accounts-bulk-extend" : "contacts-bulk-extend");
  if (!bar || !countEl) return;
  const selected = selectionSet(scope);
  const n = selected.size;
  const noun = (count) => scope === "accounts" ? (count === 1 ? "account" : "accounts") : (count === 1 ? "contact" : "contacts");
  bar.hidden = n === 0;
  countEl.textContent = `${n} ${noun(n)} selected`;
  if (!extendEl) return;

  // Gmail's second step. Offered only once this page is fully ticked and the filter actually reaches
  // further than this page - otherwise there is nothing to extend to and the link would just be noise.
  const pageKeys = pageKeysFor(scope);
  const total = lastFilteredCount[scope];
  const wholePageSelected = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  if (wholePageSelected && n < total) {
    extendEl.hidden = false;
    extendEl.disabled = false;
    extendEl.textContent = `Select all ${total} ${noun(total)} matching the current filter`;
    extendEl.onclick = () => {
      for (const k of filteredKeysFor(scope)) selected.add(k);
      rerenderForScope(scope);
    };
  } else if (wholePageSelected && total > 0 && n >= total) {
    // Confirmation, not an action - disabled so it reads as a statement rather than another button.
    extendEl.hidden = false;
    extendEl.disabled = true;
    extendEl.textContent = `All ${total} ${noun(total)} matching the filter are selected`;
    extendEl.onclick = null;
  } else {
    extendEl.hidden = true;
    extendEl.disabled = false;
    extendEl.onclick = null;
  }
}

function clearSelection(scope) {
  selectionSet(scope).clear();
  rerenderForScope(scope);
}

// --------------------------------------------------------------------------
// Bulk edit: the dialog (2026-09-22)
// --------------------------------------------------------------------------
let bulkEditScope = "accounts";

function bulkEditEl(id) {
  return document.getElementById(id);
}

async function openBulkEditDialog(scope) {
  bulkEditScope = scope;
  const n = selectionSet(scope).size;
  if (n === 0) return;
  const noun = scope === "accounts" ? (n === 1 ? "account" : "accounts") : (n === 1 ? "contact" : "contacts");
  bulkEditEl("bulk-edit-title").textContent = `Bulk edit ${n} ${noun}`;
  bulkEditEl("bulk-edit-intro").textContent =
    `Every field below starts on "Leave unchanged" - only what you actually change is written, to all ${n} selected ${noun}.`;
  bulkEditEl("bulk-edit-remove-label").textContent = `Remove ${n === 1 ? "this" : "these"} ${n} ${noun} from the list`;
  // Priority is a company-level field - a contact has no salesTeamPriority of its own.
  const showPriority = scope === "accounts";
  bulkEditEl("bulk-edit-priority-label").hidden = !showPriority;
  bulkEditEl("bulk-edit-priority").hidden = !showPriority;
  for (const id of ["bulk-edit-status", "bulk-edit-priority", "bulk-edit-due-mode"]) bulkEditEl(id).value = "";
  bulkEditEl("bulk-edit-due-date").value = "";
  bulkEditEl("bulk-edit-due-date").disabled = true;
  bulkEditEl("bulk-edit-remove").checked = false;
  bulkEditEl("bulk-edit-status-text").textContent = "";
  const undoBtn = bulkEditEl("bulk-edit-undo-btn");
  const record = await getLastBulkExtrasChange();
  undoBtn.hidden = !record;
  if (record) {
    const count = Object.keys(record.previous || {}).length;
    undoBtn.textContent = `Undo the last bulk edit (${count} ${record.scope === "accounts" ? "account" : "contact"}${count === 1 ? "" : "s"})`;
  }
  bulkEditEl("bulk-edit-dialog").showModal();
}

// One row's patch. Built here rather than in storage.js because `overrides` is nested: it has to be
// merged onto whatever that row already has, and CLEARING a priority means deleting the key, not
// writing null - rawValue() reads a present-but-null override as a real empty value and would hide
// the row's own calculated priority instead of falling back to it.
function buildBulkPatch(scope, key, { status, priority, dueMode, dueMs, remove }) {
  const extras = scope === "accounts" ? accountExtras : contactExtras;
  const patch = {};
  if (status === "__auto__") { patch.manualStatus = null; patch.manualStatusAt = null; }
  else if (status) { patch.manualStatus = status; patch.manualStatusAt = Date.now(); }
  if (scope === "accounts" && priority) {
    const overrides = { ...(extras[key]?.overrides || {}) };
    if (priority === "__clear__") delete overrides.salesTeamPriority;
    else overrides.salesTeamPriority = priority;
    patch.overrides = overrides;
  }
  if (dueMode === "set") patch.nextActionDueAt = dueMs;
  else if (dueMode === "clear") patch.nextActionDueAt = null;
  if (remove) patch.deletedAt = Date.now();
  return patch;
}

document.getElementById("accounts-bulk-edit-btn").addEventListener("click", () => openBulkEditDialog("accounts"));
document.getElementById("contacts-bulk-edit-btn").addEventListener("click", () => openBulkEditDialog("contacts"));
document.getElementById("accounts-bulk-clear-btn").addEventListener("click", () => clearSelection("accounts"));
document.getElementById("contacts-bulk-clear-btn").addEventListener("click", () => clearSelection("contacts"));

document.getElementById("bulk-edit-due-mode").addEventListener("change", (e) => {
  const dateEl = bulkEditEl("bulk-edit-due-date");
  dateEl.disabled = e.target.value !== "set";
  if (e.target.value !== "set") dateEl.value = "";
});

document.getElementById("bulk-edit-undo-btn").addEventListener("click", async () => {
  const restored = await undoLastBulkExtrasChange();
  bulkEditEl("bulk-edit-undo-btn").hidden = true;
  bulkEditEl("bulk-edit-status-text").textContent = `Undone - ${restored} row${restored === 1 ? "" : "s"} put back.`;
  appendActivityLog({ actor: "user", action: "bulk_edit_undone", label: `Undid the last bulk edit (${restored} rows)` });
  await loadWorkbook();
  rerenderForScope(bulkEditScope);
});

document.getElementById("bulk-edit-apply-btn").addEventListener("click", async () => {
  const scope = bulkEditScope;
  const keys = [...selectionSet(scope)];
  const status = bulkEditEl("bulk-edit-status").value;
  const priority = bulkEditEl("bulk-edit-priority").value;
  const dueMode = bulkEditEl("bulk-edit-due-mode").value;
  const dueValue = bulkEditEl("bulk-edit-due-date").value;
  const remove = bulkEditEl("bulk-edit-remove").checked;
  const statusEl = bulkEditEl("bulk-edit-status-text");

  if (!status && !priority && !dueMode && !remove) {
    statusEl.textContent = "Nothing is set to change.";
    return;
  }
  if (dueMode === "set" && !dueValue) {
    statusEl.textContent = "Pick a date, or choose Clear.";
    return;
  }
  // Removal is the one irreversible-feeling action here (it is undoable, but it makes rows vanish
  // from every list at once), so it gets its own confirm on top of the dialog.
  if (remove && !(await askConfirm(
    `Remove ${keys.length} ${scope === "accounts" ? "account" : "contact"}${keys.length === 1 ? "" : "s"} from your list?\n\nThey won't show up anywhere after this, but nothing is permanently erased and this bulk edit can be undone.`,
    { okLabel: "Remove", cancelLabel: "Cancel", danger: true }
  ))) return;

  const dueMs = dueValue ? new Date(`${dueValue}T00:00:00`).getTime() : null;
  const patchByKey = {};
  for (const key of keys) patchByKey[key] = buildBulkPatch(scope, key, { status, priority, dueMode, dueMs, remove });
  const changed = await bulkPatchExtras(scope, patchByKey);

  const parts = [];
  if (status) parts.push(status === "__auto__" ? "status back to auto from leads" : `status to ${status}`);
  if (scope === "accounts" && priority) parts.push(priority === "__clear__" ? "priority cleared" : `priority to ${priority}`);
  if (dueMode === "set") parts.push(`next action due ${dueValue}`);
  else if (dueMode === "clear") parts.push("next action date cleared");
  if (remove) parts.push("removed from the list");
  appendActivityLog({
    actor: "user",
    action: "bulk_edit_applied",
    label: `Bulk edit on ${changed} ${scope === "accounts" ? "account" : "contact"}${changed === 1 ? "" : "s"}: ${parts.join(", ")}`,
  });

  bulkEditEl("bulk-edit-dialog").close();
  selectionSet(scope).clear();
  await loadWorkbook();
  rerenderForScope(scope);
});

function renderColgroup() {
  colgroupEl.innerHTML = "";
  colgroupEl.appendChild(selectCol());
  const flagCol = document.createElement("col");
  flagCol.style.width = "28px";
  colgroupEl.appendChild(flagCol);
  for (const col of visibleColumns()) {
    const colEl = document.createElement("col");
    if (col.longText) colEl.style.width = "260px";
    colgroupEl.appendChild(colEl);
  }
  appendActionsCol(colgroupEl);
}

function renderTableHead() {
  theadEl.innerHTML = "";
  const tr = document.createElement("tr");
  tr.appendChild(selectAllTh("accounts"));
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
  appendActionsTh(tr);
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
  const companies = sortedFilteredCompanies();
  resultCountEl.textContent = `${companies.length} of ${workbook.companies.length} companies`;
  const cols = visibleColumns();

  const totalPages = Math.max(1, Math.ceil(companies.length / pageSize));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const pageCompanies = companies.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // The head is rendered AFTER the page slice because its select-all checkbox is scoped to this
  // page's rows (the Gmail rule), so it needs the clamped currentPage - not the one from before
  // a filter change shrank the page count.
  lastPageKeys.accounts = pageCompanies.map((c) => normalizeCompanyName(c.company)).filter(Boolean);
  lastFilteredCount.accounts = companies.length;
  renderColgroup();
  renderTableHead();

  paginationTopEl.innerHTML = "";
  paginationTopEl.appendChild(buildPaginationBar(companies.length));
  paginationBottomEl.innerHTML = "";
  paginationBottomEl.appendChild(buildPaginationBar(companies.length));

  tbodyEl.innerHTML = "";
  for (const company of pageCompanies) {
    const companyKey = normalizeCompanyName(company.company);
    const tr = document.createElement("tr");
    tr.className = "company-row";
    tr.appendChild(selectTd("accounts", companyKey));

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

    appendActionsTd(tr, (kebabBtn) => openRowActionMenu(kebabBtn, `account-${companyKey}`, [
      { label: "Open", onClick: () => openAccount(companyKey) },
      { label: "Edit", onClick: () => { pendingAccountEditKey = companyKey; openAccount(companyKey); } },
      { label: "Merge…", onClick: () => openMergeAccountsDialog(companyKey) },
      { label: "Remove", danger: true, onClick: () => removeAccount(companyKey, company.company) },
    ]));

    tr.addEventListener("click", (event) => {
      if (event.target.closest("a") || event.target.closest(".long-text-cell") || event.target.closest(".kebab-btn") || event.target.closest(".select-cell")) return;
      openAccount(companyKey);
    });
    tbodyEl.appendChild(tr);
  }

  syncTopScrollWidth();
  renderBulkBar("accounts");
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
  // --- Shown by default, in this order (reordered 2026-09-19, reported directly) ---
  { id: "fullName", label: "Name", visible: true },
  { id: "company", label: "Company", visible: true },
  // Not a real stored field - computed live from every lead matched to this contact
  // (findLeadsForContact, same author+company matching the pie already uses), so the two can
  // never disagree. There is deliberately no per-contact status EDITOR - status lives on a lead
  // (a real Post/Job, the actual communication event), not on the contact itself; change it
  // from that lead's own detail page on the Posts Dashboard.
  { id: "contactStatus", label: "Status", visible: true, pill: true },
  { id: "jobTitle", label: "Job Title", visible: true },
  { id: "function", label: "Function", visible: true },
  // One combined value (see effectiveContactSeniority): the level found in the job title /
  // headline, else the imported workbook's own text. A green dot marks an imported-sourced value.
  { id: "seniority", label: "Seniority", visible: true },
  { id: "lastVerified2", label: "LinkedIn Profile", visible: true, link: true, linkLabel: "LinkedIn ↗" },
  { id: "publicBusinessEmail", label: "Business Email", visible: true },
  // publicBusinessPhone has no imported counterpart at all - the source workbook never carried
  // a phone field - so it is ALWAYS just an override with nothing to diff against.
  { id: "publicBusinessPhone", label: "Business Phone", visible: true },

  // --- Hidden by default, one click away via the Columns button ---
  { id: "aiRelevance", label: "Relevance", longText: true },
  { id: "seniorityPriority", label: "Seniority Priority", numeric: true },
  { id: "swissBased", label: "Local" },
  { id: "city", label: "City" },
  { id: "country", label: "Country" },
  { id: "evidenceQuality2", label: "LinkedIn Status" },
  { id: "profileUrl", label: "Bio Page", link: true },
  { id: "sourceUrl", label: "Source", link: true },
  { id: "lastVerified", label: "Source Last Verified", date: true },
  { id: "evidenceQuality", label: "Source Evidence Quality" },
];

const CONTACT_HIDDEN_COLUMNS_STORAGE_KEY = "salesteam-target-contacts-hidden-columns-v2";
const CONTACT_FILTER_SORT_STATE_STORAGE_KEY = "salesteam-target-contacts-filter-sort-state-v2";

// "default" = the composite order below (Company, Seniority, Status, Name); clicking a column
// header switches to sorting by that single column.
let contactSortField = "default";
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

// Default Contacts order: Company A-Z, then most senior first (Board, C-level, VP, Head,
// Director, Manager, then everything unclassified), then engaged contacts first (Responded,
// Contacted, then Not contacted), then Name A-Z. Seniority is ranked from the job title against
// ALL levels (not just the ones configured in the wizard), so the order does not depend on setup.
const ALL_SENIORITY_LEVELS_BY_RANK = SENIORITY_LEVELS.map((l, i) => ({ id: l.id, priority: SENIORITY_LEVELS.length - i }));
const CONTACT_STATUS_SORT_ORDER = { Responded: 0, Contacted: 1, "Not contacted": 2 };

function contactSeniorityRank(contact) {
  const id = contact.seniorityLevel || classifyJobTitleSeniority(contact.jobTitle, ALL_SENIORITY_LEVELS_BY_RANK)?.id;
  const idx = SENIORITY_LEVELS.findIndex((l) => l.id === id);
  return idx >= 0 ? idx : SENIORITY_LEVELS.length;
}

function sortContactsDefault(contacts) {
  const keyed = contacts.map((c) => ({
    c,
    company: (c.company || "").toLowerCase(),
    rank: contactSeniorityRank(c),
    status: CONTACT_STATUS_SORT_ORDER[rawValue(c, { id: "contactStatus" })] ?? 3,
    name: (c.fullName || "").toLowerCase(),
  }));
  keyed.sort((a, b) =>
    a.company.localeCompare(b.company) || a.rank - b.rank || a.status - b.status || a.name.localeCompare(b.name));
  return keyed.map((k) => k.c);
}

function sortedFilteredContacts() {
  const query = contactsSearchInputEl.value.trim().toLowerCase();
  const sortCol = CONTACT_LIST_COLUMNS.find((c) => c.id === contactSortField);
  const filtered = workbook.contacts.filter((c) => matchesContactGlobalSearch(c, query) && matchesContactColumnFilters(c));
  if (contactSortField === "default") return sortContactsDefault(filtered);
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
  contactsColgroupEl.appendChild(selectCol());
  const flagCol = document.createElement("col");
  flagCol.style.width = "28px";
  contactsColgroupEl.appendChild(flagCol);
  for (const col of visibleContactColumns()) {
    const colEl = document.createElement("col");
    if (col.longText) colEl.style.width = "260px";
    contactsColgroupEl.appendChild(colEl);
  }
  appendActionsCol(contactsColgroupEl);
}

function renderContactsTableHead() {
  contactsTheadEl.innerHTML = "";
  const tr = document.createElement("tr");
  tr.appendChild(selectAllTh("contacts"));
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
  appendActionsTh(tr);
  contactsTheadEl.appendChild(tr);
}

function syncContactsTopScrollWidth() {
  contactsTableScrollTopFillerEl.style.width = `${contactsTableEl.scrollWidth}px`;
}

function hasUnreviewedPostForContact(contact) {
  return findLeadsForContact(contact, allLeads).some((l) => l.type !== "job" && l.status === "New");
}

function renderContactsTable() {
  const contacts = sortedFilteredContacts();
  contactsResultCountEl.textContent = `${contacts.length} of ${workbook.contacts.length} contacts`;
  const cols = visibleContactColumns();

  const totalPages = Math.max(1, Math.ceil(contacts.length / contactPageSize));
  contactCurrentPage = Math.min(Math.max(1, contactCurrentPage), totalPages);
  const pageContacts = contacts.slice((contactCurrentPage - 1) * contactPageSize, contactCurrentPage * contactPageSize);

  // Head after the slice - same reason as renderTable above.
  lastPageKeys.contacts = pageContacts.map((c) => contactKeyFor(c.company, c.fullName)).filter(Boolean);
  lastFilteredCount.contacts = contacts.length;
  renderContactsColgroup();
  renderContactsTableHead();

  contactsPaginationTopEl.innerHTML = "";
  contactsPaginationTopEl.appendChild(buildContactsPaginationBar(contacts.length));
  contactsPaginationBottomEl.innerHTML = "";
  contactsPaginationBottomEl.appendChild(buildContactsPaginationBar(contacts.length));

  contactsTbodyEl.innerHTML = "";
  for (const contact of pageContacts) {
    const contactKey = contactKeyFor(contact.company, contact.fullName);
    const tr = document.createElement("tr");
    tr.className = "company-row";
    tr.appendChild(selectTd("contacts", contactKey));

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

    appendActionsTd(tr, (kebabBtn) => openRowActionMenu(kebabBtn, `contact-${contactKey}`, [
      { label: "Open", onClick: () => openContact(contactKey) },
      { label: "Edit", onClick: () => { pendingContactEditKey = contactKey; openContact(contactKey); } },
      { label: "Remove", danger: true, onClick: () => removeContact(contactKey, contact.fullName) },
    ]));

    tr.addEventListener("click", (event) => {
      if (event.target.closest("a") || event.target.closest(".long-text-cell") || event.target.closest(".kebab-btn") || event.target.closest(".select-cell")) return;
      if (contactKey) openContact(contactKey);
    });
    contactsTbodyEl.appendChild(tr);
  }

  syncContactsTopScrollWidth();
  renderBulkBar("contacts");
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
  for (const c of contacts) {
    const contactKey = contactKeyFor(c.company, c.fullName);
    const status = effectiveStatus(leadStatusBucket(findLeadsForContact(c, allLeads)), contactExtras[contactKey]?.manualStatus);
    counts[status]++;
  }
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
  // 30th round of direct feedback (2026-09-19): these used to be an
  // else-if chain off the branch above - a single batched onChanged event
  // touching BOTH targetAccountsWorkbook and targetAccounts (or any two of
  // these) would silently skip every branch after the first match. Each
  // condition is independent now, so every changed key this page cares
  // about gets handled, regardless of what else changed alongside it in
  // the same event.
  if ("targetAccounts" in changes) renderLinkedinResolveStatus();
  // A new scan finishing, or a lead's status changing, can flip the list
  // view's flag column (an unreviewed post appearing/getting actioned) -
  // and a due-date set/cleared from an Account view does the same. Only
  // the list view's flag column depends on these; an open Account/Contact
  // view already reflects the storage write that caused it directly.
  if ("results" in changes) {
    getResults().then((results) => { allLeads = Object.values(results); if (!listViewEl.hidden) renderTable(); });
  }
  if ("targetAccountExtras" in changes) {
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
// The pie shows SalesTeam's own Priority (P1-P5), the same value as the table's Priority
// column (manual overrides included), not the imported workbook's separate score.
const PRIORITY_LEVEL_ORDER = ["P1", "P2", "P3", "P4", "P5", "Not scored yet"];
const PRIORITY_LEVEL_COLORS = {
  P1: "#b71c1c", P2: "#e64a19", P3: "#f9a825", P4: "#689f38", P5: "#78909c", "Not scored yet": "#cfcfcf",
};

function computeAiPriorityRangeCounts(companies) {
  const counts = Object.fromEntries(PRIORITY_LEVEL_ORDER.map((k) => [k, 0]));
  for (const c of companies) {
    const p = rawValue(c, { id: "salesTeamPriority" });
    counts[PRIORITY_LEVEL_ORDER.includes(p) && p !== "Not scored yet" ? p : "Not scored yet"]++;
  }
  return PRIORITY_LEVEL_ORDER.map((label) => ({ label, count: counts[label], color: PRIORITY_LEVEL_COLORS[label] }));
}

// Real values confirmed against the actual imported workbook, not guessed -
// originally just "Rich Evidence" / "Sufficient Evidence" / "Insufficient -
// Missing baseline". 30th round of direct feedback (2026-09-19): "The
// Evidence coverage pie needs to also include the 'insufficiently
// evidenced' number so we will make up the 100% and 561 companies" - a live
// diagnostic (chrome.storage.local read) found this had drifted into the
// SAME class of bug the Contact coverage pie had two rounds ago: the V66
// workbook's real values are "Rich Evidence" (158), "Sufficient Evidence"
// (176), "Provisional Evidence" (156, an entirely new bucket - not a rename
// of anything above, and nearly as large as Rich Evidence), "Full Evidence"
// (1, also new), "Insufficient Evidence" (53, the label itself changed -
// dropped "- Missing baseline"), and 27 companies with no evidenceStatus at
// all. Only Rich/Sufficient Evidence matched the old hardcoded list, so 184
// of 571 companies (Provisional + Full + Insufficient + unset) silently
// vanished from the pie - exactly Contact coverage's original bug, just
// with 3 missing buckets instead of 1.
// Fixed to not just patch today's 5 known values, but to never silently
// drop a company again if a future workbook renames/adds a status once
// more: an unrecognized (or missing) evidenceStatus now falls into "Not yet
// researched" rather than disappearing, so this pie's own total always
// equals the company count, unconditionally.
const EVIDENCE_LEVEL_ORDER = ["Full Evidence", "Rich Evidence", "Sufficient Evidence", "Provisional Evidence", "Insufficient Evidence", "Not yet researched"];
const EVIDENCE_LEVEL_COLORS = {
  "Full Evidence": "#1b5e20",
  "Rich Evidence": "#2e7d32",
  "Sufficient Evidence": "#f9a825",
  "Provisional Evidence": "#ef6c00",
  "Insufficient Evidence": "#c62828",
  "Not yet researched": "#9e9e9e",
};
const KNOWN_EVIDENCE_LEVELS = new Set(EVIDENCE_LEVEL_ORDER);

function computeEvidenceLevelCounts(companies) {
  const counts = Object.fromEntries(EVIDENCE_LEVEL_ORDER.map((k) => [k, 0]));
  for (const c of companies) {
    counts[KNOWN_EVIDENCE_LEVELS.has(c.evidenceStatus) ? c.evidenceStatus : "Not yet researched"]++;
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

const ACCOUNT_STATUS_ORDER = ["Not contacted", "Contacted", "Responded"];
const ACCOUNT_STATUS_COLORS = { "Not contacted": "#9e9e9e", "Contacted": "#0a66c2", "Responded": "#2e7d32" };

function leadStatusBucket(leads) {
  if (leads.some((l) => l.status === "Responded" || l.status === "Converted")) return "Responded";
  if (leads.some((l) => l.status === "Contacted")) return "Contacted";
  return "Not contacted";
}

// A manual override (2026-09-18, the user's own explicit request) - stored
// as manualStatus/manualStatusAt on targetAccountExtras/targetContactExtras
// (same durable-record pattern as deletedAt/nextActionDueAt already use),
// for two real gaps the pure lead-derived status left uncovered: (1) a
// "cold" contact/account with no scanned lead at all could never show
// anything but "Not contacted" no matter what the user actually did, since
// there was no lead for a status to live on; (2) sometimes you just want to
// set it directly. The lead-derived bucket and the manual override are
// combined by taking whichever ranks higher - a manual "Contacted" can
// never silently downgrade an account leads already show as "Responded".
const STATUS_RANK = { "Not contacted": 0, "Contacted": 1, "Responded": 2 };

function effectiveStatus(leadBucket, manualStatus) {
  if (!manualStatus) return leadBucket;
  return (STATUS_RANK[manualStatus] ?? -1) > STATUS_RANK[leadBucket] ? manualStatus : leadBucket;
}

// Advance-only write, for the automatic "I copied a drafted message from
// the Mentor" trigger (wired below on each Mentor chat's own agent bubbles)
// - copying twice, or copying after already manually marking "Responded",
// should never regress the stored value. A user picking a status directly
// from the manual dropdown always writes exactly what they picked instead
// (see the "Status" overview field below) - this helper is only for the
// automatic trigger.
async function advanceManualStatus(getExtraFn, saveExtraFn, key, newStatus) {
  const current = (await getExtraFn(key))?.manualStatus || null;
  if (current && STATUS_RANK[current] >= STATUS_RANK[newStatus]) return false;
  await saveExtraFn(key, { manualStatus: newStatus, manualStatusAt: Date.now() });
  return true;
}

function computeAccountStatusCounts(companies) {
  const counts = Object.fromEntries(ACCOUNT_STATUS_ORDER.map((k) => [k, 0]));
  for (const c of companies) {
    const companyKey = normalizeCompanyName(c.company);
    const leads = allLeads.filter((l) => normalizeCompanyName(l.company) === companyKey);
    const status = effectiveStatus(leadStatusBucket(leads), accountExtras[companyKey]?.manualStatus);
    counts[status]++;
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
// Reported directly, 2026-09-18: "0 contacts" (a relevant account nothing's
// been researched for yet) drowned out the actual coverage signal - split
// into its own real tiers instead ("1-2 contacts" was too coarse to tell a
// single-contact account, the riskiest kind - one departure and the account
// has no contact at all - from a properly-covered one). Zero-contact
// accounts were deliberately left uncounted here at the time, not folded
// into "1 contact" - this pie was specifically about HOW WELL a covered
// account is covered.
// Reversed, 29th round of direct feedback (2026-09-19): "is missing the
// number of Accounts with 0 contacts. Please add this number to the Pie
// chart" - with the new V66 workbook's own contact coverage much higher
// (90% per the user), the zero-contact count is no longer noise drowning
// out the signal, it's now itself the actionable gap.
// isRelevantAccount filter dropped, same-day follow-up: "The percentages do
// not add up to 100% and it says there are only 332 companies and not 544."
// The filter (332 of 544 companies) stayed while percentOf was computed
// against the full 544 - the two numbers were never going to reconcile.
// Since the whole point of this round was making 0-contacts itself visible
// and countable, filtering some companies out of the pie ENTIRELY (not just
// into the 0-contacts bucket) no longer serves any purpose - counts every
// company now, so the pie's own total and percentOf always agree.
const CONTACT_COVERAGE_ORDER = ["0 contacts", "1 contact", "2 contacts", "3+ contacts"];
const CONTACT_COVERAGE_COLORS = { "0 contacts": "#c62828", "1 contact": "#f9a825", "2 contacts": "#66bb6a", "3+ contacts": "#2e7d32" };

function computeContactCoverageCounts(companies) {
  const counts = Object.fromEntries(CONTACT_COVERAGE_ORDER.map((k) => [k, 0]));
  for (const c of companies) {
    const n = workbook.contacts.filter((ct) => ct.companyId === c.companyId).length;
    counts[n === 0 ? "0 contacts" : n === 1 ? "1 contact" : n === 2 ? "2 contacts" : "3+ contacts"]++;
  }
  return CONTACT_COVERAGE_ORDER.map((label) => ({ label, count: counts[label], color: CONTACT_COVERAGE_COLORS[label] }));
}

function renderAccountsStats() {
  renderGenericPieChart(document.getElementById("pie-ai-priority"), computeAiPriorityRangeCounts(workbook.companies), { unitLabel: "companies" });
  renderGenericPieChart(document.getElementById("pie-evidence-level"), computeEvidenceLevelCounts(workbook.companies), { unitLabel: "companies" });
  renderGenericPieChart(document.getElementById("pie-account-status"), computeAccountStatusCounts(workbook.companies), { unitLabel: "companies" });
  renderGenericPieChart(document.getElementById("pie-contact-coverage"), computeContactCoverageCounts(workbook.companies), { unitLabel: "companies", percentOf: workbook.companies.length });
}

// Soft delete (added 2026-09-16, reported directly): a removed account/
// contact is never actually erased - deletedAt lives on its extras record
// (targetAccountExtras/targetContactExtras, same storage nextActionDueAt
// already uses, for the same re-import-durability reason), keyed by the
// same normalizeCompanyName()/contactKeyFor() identity every other lookup
// on this page already uses. Filtered out at load time below rather than
// per call site - this page reads workbook.companies/.contacts directly in
// well over a dozen places (search/filter, both tables, all four pies,
// account/contact lookups), and filtering once here means every one of
// them sees a deleted row as if it were never there, with no risk of
// missing a spot.
function isAccountDeleted(companyKey) {
  return Boolean(accountExtras[companyKey]?.deletedAt);
}

function isContactDeleted(contact) {
  const contactKey = contactKeyFor(contact.company, contact.fullName);
  if (contactExtras[contactKey]?.deletedAt) return true;
  // A contact at a deleted company is hidden too, without needing its own
  // deletedAt - restoring the company later (not yet a self-service action,
  // per the user's own scoping - "in case we will want to undo... in the
  // future") brings its contacts back automatically along with it, rather
  // than needing each one separately restored.
  return isAccountDeleted(normalizeCompanyName(contact.company));
}

async function loadWorkbook() {
  // Before the read, not after: copies any linkedinLink the resolver stored in the lightweight
  // targetAccounts map into the workbook row that has none (2026-09-22). The two are separate storage
  // keys, and only the workbook is rendered here - so without this, a link the resolver genuinely
  // found stays invisible. Idempotent and does nothing once every row already has one.
  await syncLinkedinLinksToWorkbook();
  const [wb, results, extras, cExtras, companyExclusions] = await Promise.all([
    getTargetAccountsWorkbook(), getResults(), getTargetAccountExtras(), getTargetContactExtras(), getCompanyExclusions(),
  ]);
  allLeads = Object.values(results);
  seniorityLevelConfig = (await getTargetContactProfile()).seniorityLevels || [];
  const money = await getRevenueNormalization();
  moneySettings = { targetCurrency: money.targetCurrency, rates: { rates: money.rates } };
  accountExtras = extras;
  contactExtras = cExtras;
  // Excluded (added 2026-09-17, the user's own confirmed design: "Hide from
  // Dashboard entirely, which is what we do for our own excluded
  // companies") - a company the workbook's own Excluded column marks "Yes",
  // or that matches this app's own companyExclusions blocklist by LinkedIn
  // slug (isCompanyRowExcluded checks both), is hidden the same way a soft-
  // deleted account is: filtered out here, once, not per call site - never
  // actually dropped from storage, so nothing is lost if either source
  // later stops flagging it.
  const exclusionSlugSet = new Set(companyExclusions.map((e) => e.slug));
  const excludedCompanyKeys = new Set(
    wb.companies.filter((c) => isCompanyRowExcluded(c, exclusionSlugSet)).map((c) => normalizeCompanyName(c.company))
  );
  workbook = {
    ...wb,
    companies: wb.companies.filter((c) =>
      !isAccountDeleted(normalizeCompanyName(c.company)) && !excludedCompanyKeys.has(normalizeCompanyName(c.company))
    ),
    contacts: wb.contacts.filter((c) => !isContactDeleted(c) && !excludedCompanyKeys.has(normalizeCompanyName(c.company))),
  };
  const hasData = workbook.companies.length > 0;
  const hasContacts = workbook.contacts.length > 0;
  emptyStateEl.hidden = hasData;
  controlsEl.hidden = !hasData;
  tableWrapEl.hidden = !hasData;
  paginationTopEl.hidden = !hasData;
  paginationBottomEl.hidden = !hasData;
  tableScrollTopEl.hidden = !hasData;
  accountsStatsSectionEl.hidden = !hasData;
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
  await renderDiscoveredMergeStatus();
}

// EXPERIMENTAL (v0.29.25/6.16): shows progress toward resolving every
// Target Account company to a LinkedIn numeric ID (needed for the
// authorCompany-scoped Post search, 6.17) - reported directly, since a
// resolver run happens in small chunks over many sessions ("Limit to N",
// v0.29.29), there was no way to see overall progress without re-reading
// the Activity Log after every single run. Reads the lightweight
// targetAccounts map (not the workbook) since that's where linkedinCompanyId
// actually lives.
// 30th round of direct feedback (2026-09-19): "still reads 514... it stayed
// at 514" even after direct storage inspection confirmed the true count had
// already reached 539. Root cause: a live resolve run's own incremental
// persistence (onCompanyDone, see the 29th round) fires TWO storage writes
// per company (applyResolvedCompanyIds + markLinkedinResolveAttempted),
// each triggering this page's own storage.onChanged listener - up to ~50
// calls to this function in rapid succession over one run. Each call does
// its own async chrome.storage.local.get(), and those reads can genuinely
// complete out of order (no guarantee the Nth call to START is also the Nth
// to FINISH) - a call triggered earlier in the run finishing its read AFTER
// a later call would overwrite the DOM with stale data, and nothing here
// ever corrected it since no further event was guaranteed to fire
// afterward. renderToken is a simple "only the most recently STARTED call
// is allowed to update the DOM" guard - any call that finds a newer one has
// since started discards its own (now-stale) result instead of applying it.
let renderLinkedinResolveStatusToken = 0;
async function renderLinkedinResolveStatus() {
  const myToken = ++renderLinkedinResolveStatusToken;
  const targetAccounts = await getTargetAccounts();
  if (myToken !== renderLinkedinResolveStatusToken) return;
  // 28th round of direct feedback (2026-09-19), fixed same day after live
  // testing showed "2139 of 2242" instead of a real company count - fixed
  // by deduping instead of counting every alias key as its own company.
  // 30th round follow-up, a SECOND real bug in that same fix, found live:
  // "still reads 514" even after a direct storage read confirmed the true
  // count had reached 539. The dedup-via-Map approach (new Map(entries).
  // values(), keyed on normalizeCompanyName(v.company)) picks whichever
  // entry happens to be inserted LAST among a company's primary key + all
  // its alias keys - and applyResolvedCompanyIds only ever updates the
  // PRIMARY key's own record when a company resolves (storage.js). Each
  // alias key still points at its own separate, stale copy from import
  // time (chrome.storage.local destroys object references on every round
  // trip - an alias's copy is never touched again after creation). Since
  // alias keys are inserted into the map AFTER every company's primary key
  // (see importTargetAccounts's two-pass construction), the Map's
  // last-write-wins collapse silently preferred the STALE alias copy
  // (still unresolved) over the fresh, correctly-resolved primary one -
  // for exactly the companies that have aliases, undercounting resolved
  // ones. Fixed the same way getTargetAccountsMissingLinkedinId already
  // was (28th round): filter to entries whose own KEY equals their
  // record's normalized company name - only a PRIMARY key satisfies that
  // by construction, so alias-keyed duplicates (and their stale data)
  // never enter the count at all.
  const entries = Object.entries(targetAccounts)
    .filter(([key, v]) => key === normalizeCompanyName(v.company))
    .map(([, v]) => v);
  if (entries.length === 0) {
    linkedinResolveStatusEl.hidden = true;
    return;
  }
  const resolvedCount = entries.filter((a) => a.linkedinCompanyId).length;
  linkedinResolveStatusEl.hidden = false;
  // Contextual hints instead of permanent menu buttons (the repair actions live under "Advanced tools"): only shown
  // while there is something left to fix.
  // What a resolve run will actually queue: an account missing EITHER half of the pair. Counting only
  // missing ids here would advertise "3" and then process 27, because getTargetAccountsMissingLinkedinId
  // was widened to pick up accounts that hold an id but no linkedinLink (2026-09-22).
  const needingResolve = entries.filter((a) => !a.linkedinCompanyId || !a.linkedinLink).length;
  // Each hint below is its own link-button appended after this text, and each one ENDS in a number or
  // STARTS with one. Without the comma here and the full stop after the first hint, the two numbers ran
  // together on screen - "Resolve the remaining 5 142 companies have no employee count" - and there was
  // no way to see which number belonged to which action.
  linkedinResolveStatusEl.textContent =
    `LinkedIn company IDs resolved: ${resolvedCount} of ${entries.length}${needingResolve > 0 ? "," : "."}`;
  if (needingResolve > 0) {
    appendHintAction(linkedinResolveStatusEl, `look up ${needingResolve} missing ID${needingResolve === 1 ? "" : "s"} or links`, "nav-resolve-btn", ".");
  }
  const needingSize = (await getCompaniesNeedingSize()).length;
  if (myToken !== renderLinkedinResolveStatusToken) return;
  if (needingSize > 0) appendHintAction(linkedinResolveStatusEl, `${needingSize} ${needingSize === 1 ? "company has" : "companies have"} no employee count - fetch`, "nav-fetch-size-btn");
}

function appendHintAction(parentEl, label, targetBtnId, suffix = "") {
  parentEl.appendChild(document.createTextNode(" "));
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "text-link-btn";
  btn.textContent = label;
  btn.addEventListener("click", () => document.getElementById(targetBtnId).click());
  parentEl.appendChild(btn);
  // Punctuation is appended OUTSIDE the button so it is not underlined as part of the link text.
  if (suffix) parentEl.appendChild(document.createTextNode(suffix));
}

// PRD 6.20 Phase 7 (2026-09-16, built) - the Setup wizard's Target Account &
// Contact Discovery scan stages what it finds in discoveredCompanies/
// discoveredContacts (Phases 5/6), kept apart from this workbook while a run
// is live so a discarded/redone run never touches committed data. This row
// only appears once there's something actually staged and not yet merged -
// most installs never see it, since Phase 5/6 aren't run yet. "Review &
// Merge" - not automatic on a run reaching status "done" - so merging into
// real, shared workbook data is always a deliberate action, consistent with
// every other data-mutating button on this page (Import, Resolve LinkedIn
// Company IDs) already requiring a click, several a confirm() too.
async function renderDiscoveredMergeStatus() {
  const { companiesPending, contactsPending } = await getPendingDiscoveredMergeCounts();
  const hasPending = companiesPending > 0 || contactsPending > 0;
  pageHeaderMergeRowEl.hidden = !hasPending;
  if (!hasPending) return;
  mergeDiscoveredStatusEl.textContent =
    `${companiesPending} compan${companiesPending === 1 ? "y" : "ies"}, ${contactsPending} contact${contactsPending === 1 ? "" : "s"} ready to merge.`;
}

// Reported directly, 2026-09-16: a native confirm()'s generic OK/Cancel read
// as unclear here too - same complaint already fixed once this session for
// onboarding.html's stale-discovery dialog, same real <dialog>/showModal()
// fix, explicitly-labeled buttons ("Add Them"/"Cancel") instead of relying
// on wording alone to explain what accepting vs. dismissing actually does.
// Second round of direct feedback, same day: a bare count doesn't let the
// user look at anything before committing - "I do not understand the
// benefit of asking the user to confirm something that they know nothing
// about." Now lists real names (companies link straight to LinkedIn, so a
// spot-check is one click), capped so the dialog stays usable for a large
// batch.
const MERGE_PREVIEW_LIST_CAP = 15;

function buildMergePreviewSection(title, items, renderItem) {
  if (items.length === 0) return null;
  const section = document.createElement("div");
  const heading = document.createElement("h4");
  heading.textContent = title;
  section.appendChild(heading);
  const list = document.createElement("ul");
  for (const item of items.slice(0, MERGE_PREVIEW_LIST_CAP)) {
    const li = document.createElement("li");
    renderItem(li, item);
    list.appendChild(li);
  }
  section.appendChild(list);
  if (items.length > MERGE_PREVIEW_LIST_CAP) {
    const more = document.createElement("div");
    more.className = "merge-preview-more";
    more.textContent = `+ ${items.length - MERGE_PREVIEW_LIST_CAP} more`;
    section.appendChild(more);
  }
  return section;
}

function showMergeDiscoveredDialog(preview) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("merge-discovered-dialog");
    const previewEl = document.getElementById("merge-discovered-dialog-preview");
    previewEl.innerHTML = "";

    const companiesSection = buildMergePreviewSection(
      `Companies (${preview.companies.length})`, preview.companies,
      (li, c) => {
        const name = document.createElement("span");
        name.textContent = c.country ? `${c.name} — ${c.country}` : c.name;
        li.appendChild(name);
        if (c.linkedinLink) {
          const a = document.createElement("a");
          a.href = c.linkedinLink;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "LinkedIn ↗";
          li.appendChild(a);
        }
      }
    );
    if (companiesSection) previewEl.appendChild(companiesSection);

    const contactsSection = buildMergePreviewSection(
      `Contacts (${preview.contacts.length})`, preview.contacts,
      (li, c) => {
        const name = document.createElement("span");
        name.textContent = `${c.name} — ${c.company}`;
        li.appendChild(name);
      }
    );
    if (contactsSection) previewEl.appendChild(contactsSection);

    // Reported directly, same day: a name-only match "could be prone to
    // errors" - matchedBy: "id" (an exact LinkedIn company ID match,
    // trustworthy) vs "name" (the fuzzy fallback, worth a second look) is
    // shown explicitly so a wrong name match can actually be caught here,
    // not discovered later.
    const matchedSection = buildMergePreviewSection(
      `Already in your list (${preview.matchedCompanies.length})`, preview.matchedCompanies,
      (li, m) => {
        const name = document.createElement("span");
        name.textContent = `${m.discoveredName} → ${m.existingName} (matched by ${m.matchedBy === "id" ? "LinkedIn ID" : "name"})`;
        li.appendChild(name);
        if (m.linkedinLink) {
          const a = document.createElement("a");
          a.href = m.linkedinLink;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "LinkedIn ↗";
          li.appendChild(a);
        }
      }
    );
    if (matchedSection) previewEl.appendChild(matchedSection);

    function onConfirm() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function cleanup() {
      dialog.close();
      document.getElementById("merge-discovered-confirm-btn").removeEventListener("click", onConfirm);
      document.getElementById("merge-discovered-cancel-btn").removeEventListener("click", onCancel);
    }
    document.getElementById("merge-discovered-confirm-btn").addEventListener("click", onConfirm);
    document.getElementById("merge-discovered-cancel-btn").addEventListener("click", onCancel);
    dialog.showModal();
  });
}

mergeDiscoveredBtn.addEventListener("click", async () => {
  const preview = await getPendingDiscoveredMergePreview();
  if (preview.companies.length === 0 && preview.contacts.length === 0) {
    mergeDiscoveredStatusEl.textContent = "Nothing to merge - already up to date.";
    return;
  }
  const confirmed = await showMergeDiscoveredDialog(preview);
  if (!confirmed) return;

  mergeDiscoveredBtn.disabled = true;
  mergeDiscoveredStatusEl.textContent = "Merging…";
  try {
    const {
      companiesAdded, contactsAdded, companiesMatched, idsBackfilled, companiesReceivingContacts,
      totalDiscoveredCompanies, totalDiscoveredContacts, duplicateContactsSkipped, orphanedContactsSkipped,
    } = await mergeDiscoveredIntoWorkbook();
    appendActivityLog({
      actor: "user",
      action: "discovered_merged_into_workbook",
      label: `Merged Discovery results into Target Accounts workbook (${companiesAdded} companies, ${contactsAdded} contacts added; ${companiesMatched} already on the list, ${idsBackfilled} of those got a LinkedIn ID backfilled for free)`,
      newValue: {
        companiesAdded, contactsAdded, companiesMatched, idsBackfilled, companiesReceivingContacts,
        totalDiscoveredCompanies, totalDiscoveredContacts, duplicateContactsSkipped, orphanedContactsSkipped,
      },
    });
    // loadWorkbook() re-renders this same row via renderDiscoveredMergeStatus
    // - since nothing's pending anymore, that hides it before this
    // completion message would ever be seen. Restored right after so the
    // user actually gets to see what happened, not just a row disappearing.
    await loadWorkbook();
    const mergedPriority = await autoPrioritizeNewCompanies().catch(() => ({ applied: 0, summary: "" }));
    pageHeaderMergeRowEl.hidden = false;
    // Rewritten 2026-09-17, reported directly as ambiguous, then asked for a
    // fuller breakdown - two clearly separated sentences (Companies/
    // Contacts), each its own discovered/added/duplicate breakdown, rather
    // than one run-on sentence mixing both. Deliberately doesn't report
    // "how many companies had no contacts found" - that's the Contact
    // Discovery run's own stat (companiesWithNoMatch), not something this
    // merge step can see: a company with zero kept contacts is never staged
    // into discoveredContacts in the first place, so by merge time there's
    // no trace of it left to count.
    let companiesLine = `Companies: ${totalDiscoveredCompanies} discovered, ${companiesAdded} added, ${companiesMatched} already on your list (not duplicated)`;
    if (idsBackfilled > 0) companiesLine += ` - ${idsBackfilled} of those just got a LinkedIn ID for free`;
    companiesLine += ".";

    let statusText = `Done. ${companiesLine}`;
    if (totalDiscoveredContacts > 0) {
      let contactsLine = `Contacts: ${totalDiscoveredContacts} discovered, ${contactsAdded} added, ${duplicateContactsSkipped} already on file (not duplicated)`;
      if (contactsAdded > 0) contactsLine += `, across ${companiesReceivingContacts} compan${companiesReceivingContacts === 1 ? "y" : "ies"}`;
      if (orphanedContactsSkipped > 0) contactsLine += ` - ${orphanedContactsSkipped} skipped (their own company is no longer part of this batch)`;
      contactsLine += ".";
      statusText += ` ${contactsLine}`;
    }
    if (mergedPriority.applied > 0) statusText += ` Priorities calculated for ${mergedPriority.applied} new compan${mergedPriority.applied === 1 ? "y" : "ies"} (${mergedPriority.summary}).`;
    mergeDiscoveredStatusEl.textContent = statusText;
  } finally {
    mergeDiscoveredBtn.disabled = false;
  }
});

// Import/Export/Resolve LinkedIn Company IDs - moved here from Settings
// (6.7/6.8/6.16) 2026-09-16, reported directly: this management belongs
// next to the data it actually affects, not on a separate settings page.
// Was previously a duplicate code path kept in sync with Settings' own copy
// by hand (see the v0.29.38 parity-bug note below) - now the only copy.
// The confidence threshold that used to prompt here before opening the file
// picker was removed again the same day, once genuinely understood: it
// governs Leads Prioritization (which companies' leads get an automatic
// priority boost), not what gets imported/exported here - every company in
// the workbook is included either way, regardless of score. It now lives in
// the Setup wizard's "Leads Prioritization" step, next to the rules it
// actually gates.
// Two more ways in, for when this page is shown without its own menu (opened from another page's menu): a button in
// the empty state, and the small dialog that the other pages' "Import Target Accounts…" menu item opens.
// The file picker serves two different jobs, chosen by which dialog opened it (reported 2026-09-21: one "Import" item
// that took a workbook OR a backup was unclear): a research workbook (.xlsx) or a backup (.zip / .json).
let importPickerMode = "research";

function openImportDialog() {
  renderImportColumnsHelp();
  document.getElementById("import-help-status").textContent = "";
  document.getElementById("import-accounts-dialog").showModal();
}

document.getElementById("empty-import-btn").addEventListener("click", openImportDialog);
document.getElementById("restore-target-accounts-page-btn").addEventListener("click", () => {
  document.getElementById("restore-accounts-dialog").showModal();
});
document.getElementById("restore-accounts-choose-btn").addEventListener("click", () => {
  document.getElementById("restore-accounts-dialog").close();
  importPickerMode = "restore";
  importTargetAccountsPageFileInput.accept = ".zip,.json,application/json,application/zip";
  importTargetAccountsPageFileInput.click();
});

function renderImportColumnsHelp() {
  const wrap = document.getElementById("import-columns-list");
  if (wrap.childElementCount > 0) return;
  const intro = document.createElement("p");
  intro.textContent = "Minimum to import: a Companies sheet with a Company column, one row per account. Add Company_ID to link Contacts, Initiatives, Investment, Sources and Aliases to their company. The research format also expects these mandatory columns (the empty template marks them in dark blue):";
  wrap.appendChild(intro);
  for (const [sheet, cols] of Object.entries(IMPORT_COLUMNS)) {
    const p = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `${sheet}: `;
    p.append(strong, document.createTextNode(cols.mandatory.join(", ")));
    wrap.appendChild(p);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fetchPromptText() {
  const response = await fetch(chrome.runtime.getURL("research-prompt.txt"));
  if (!response.ok) throw new Error("the research prompt file is missing from this installation");
  return response.text();
}

document.getElementById("import-copy-prompt-btn").addEventListener("click", async () => {
  const status = document.getElementById("import-help-status");
  try {
    const text = await fetchPromptText();
    await navigator.clipboard.writeText(text);
    status.textContent = `Research prompt copied (${text.length.toLocaleString()} characters). Paste it into ChatGPT or another AI assistant and answer its questions; it ends by giving you the Excel workbook to import here.`;
  } catch (err) {
    status.textContent = `Couldn't copy the prompt: ${err.message}. Use "Download research prompt (.txt)" instead.`;
  }
});
document.getElementById("import-download-prompt-btn").addEventListener("click", async () => {
  const status = document.getElementById("import-help-status");
  try {
    downloadBlob(new Blob([await fetchPromptText()], { type: "text/plain;charset=utf-8" }), "SalesTeam-research-prompt.txt");
    status.textContent = "Saved SalesTeam-research-prompt.txt to your Downloads folder.";
  } catch (err) {
    status.textContent = `Couldn't save the prompt: ${err.message}.`;
  }
});
document.getElementById("import-download-template-btn").addEventListener("click", async () => {
  const status = document.getElementById("import-help-status");
  try {
    const response = await fetch(chrome.runtime.getURL("Target_Accounts_Template.xlsx"));
    if (!response.ok) throw new Error("the template file is missing from this installation");
    downloadBlob(await response.blob(), "SalesTeam-Target-Accounts-Template.xlsx");
    status.textContent = "Saved SalesTeam-Target-Accounts-Template.xlsx to your Downloads folder. Mandatory columns have dark blue headers; hover a header for its description.";
  } catch (err) {
    status.textContent = `Couldn't save the template: ${err.message}.`;
  }
});

document.getElementById("import-accounts-choose-btn").addEventListener("click", () => {
  document.getElementById("import-accounts-dialog").close();
  importPickerMode = "research";
  importTargetAccountsPageFileInput.accept = ".xlsx";
  importTargetAccountsPageFileInput.click();
});

importTargetAccountsPageBtn.addEventListener("click", () => {
  openImportDialog();
});

// EXPERIMENTAL (v0.29.25, see PRD 6.16): resolves each Target Account
// company's LinkedIn numeric company ID, needed for a future feature that
// scopes Post search to only these companies' employees (authorCompany).
resolveCompanyIdsBtn.addEventListener("click", async () => {
  if (!(await guardBatchStart("Looking up LinkedIn company IDs", askConfirm))) return;
  let toResolve = await getTargetAccountsMissingLinkedinId();
  const limit = parseInt(resolveCompanyIdsLimitInput.value, 10);
  if (Number.isFinite(limit) && limit > 0 && limit < toResolve.length) {
    toResolve = toResolve.slice(0, limit);
  }
  if (toResolve.length === 0) {
    resolveCompanyIdsStatusEl.textContent = "Nothing to do - every Target Account company already has a resolved LinkedIn company ID.";
    return;
  }
  if (!(await askConfirm(resolveConfirmText(toResolve.length)))) return;

  resolveCompanyIdsBtn.disabled = true;
  stopResolveCompanyIdsBtn.hidden = false;
  stopResolveCompanyIdsBtn.disabled = false;
  stopResolveCompanyIdsBtn.textContent = "Stop";
  resolveAbortRequested = false;
  try {
    const { results: resolved, debugSamples, hardTimeoutCount, notConfidentCount, attemptedKeys, stoppedByTouchBudget } = await runCompanyIdResolution(toResolve, {
      onProgress: (i, total) => { resolveCompanyIdsStatusEl.textContent = `Resolving company ${i} of ${total}…`; },
      shouldAbort: () => resolveAbortRequested,
      // 29th round of direct feedback (2026-09-19): see company-resolve-
      // extraction.js's own comment on runCompanyIdResolution for the full
      // reasoning - persists each company's own outcome the moment it's
      // known, not just once at the very end, so reloading the extension
      // (or any other abrupt interruption) mid-run loses at most one
      // in-flight company, not the whole run. The bulk calls below still
      // run too, on a normal/graceful finish - redundant but harmless
      // (re-applying already-persisted data), kept so the completion
      // summary's own counts stay exactly as accurate as before.
      onCompanyDone: async (key, linkedinCompanyId, companyPageUrl) => {
        if (linkedinCompanyId) await applyResolvedCompanyIds([{ key, linkedinCompanyId, companyPageUrl }]);
        await markLinkedinResolveAttempted([key]);
      },
    });
    const updated = await applyResolvedCompanyIds(resolved);
    await markLinkedinResolveAttempted(attemptedKeys);
    const stoppedSuffix = stoppedByTouchBudget
      ? ` - stopped automatically, daily LinkedIn activity limit reached (${toResolve.length - attemptedKeys.length} of ${toResolve.length} never attempted this run; resume tomorrow).`
      : resolveAbortRequested
        ? ` - stopped by you (${toResolve.length - attemptedKeys.length} of ${toResolve.length} never attempted this run).`
        : ".";
    resolveCompanyIdsStatusEl.textContent = `Done - ${updated} of ${attemptedKeys.length} compan${attemptedKeys.length === 1 ? "y" : "ies"} resolved` +
      (hardTimeoutCount > 0 ? `, ${hardTimeoutCount} failed due to an error (will retry once every other company's been attempted)` : "") +
      (notConfidentCount > 0 ? `, ${notConfidentCount} found no confident match (will retry once every other company's been attempted)` : "") +
      stoppedSuffix;
    appendActivityLog({
      actor: stoppedByTouchBudget ? "extension" : "user",
      action: "company_ids_resolved",
      label: `Resolve LinkedIn Company IDs: ${updated} of ${attemptedKeys.length} resolved` +
        (hardTimeoutCount > 0 ? `, ${hardTimeoutCount} failed due to an error` : "") +
        (notConfidentCount > 0 ? `, ${notConfidentCount} found no confident match` : "") +
        (stoppedByTouchBudget ? ", stopped automatically (daily LinkedIn activity limit reached)" : resolveAbortRequested ? ", stopped early by you" : "") +
        (debugSamples.length > 0 ? ` - ${debugSamples.length} unresolved sample(s) attached for diagnosis` : ""),
      newValue: { updated, total: attemptedKeys.length, requested: toResolve.length, hardTimeoutCount, notConfidentCount, debugSamples, stoppedByUser: resolveAbortRequested, stoppedByTouchBudget },
    });
    await renderLinkedinResolveStatus();
  } catch (err) {
    resolveCompanyIdsStatusEl.textContent = `Something went wrong: ${err.message}`;
    appendActivityLog({ actor: "user", action: "company_ids_resolved", label: "Resolve LinkedIn Company IDs failed", error: true, errorMessage: err.message });
  } finally {
    resolveCompanyIdsBtn.disabled = false;
    stopResolveCompanyIdsBtn.hidden = true;
  }
});

// v0.29.45: checked before starting a new company (see runCompanyIdResolution's
// own shouldAbort check), not mid-attempt - one company's own resolution is a
// few seconds, a fine granularity to wait out rather than interrupt. Disabled
// immediately so a slow in-flight company can't look like the click didn't
// register.
stopResolveCompanyIdsBtn.addEventListener("click", () => {
  resolveAbortRequested = true;
  stopResolveCompanyIdsBtn.disabled = true;
  stopResolveCompanyIdsBtn.textContent = "Stopping…";
});

// "Discover Contacts for Existing Companies" (PRD 6.20, 2026-09-17, the
// user's own request) - same UI pattern as Resolve LinkedIn Company IDs
// just above (Limit-to-N, Stop, status text), but for companies already in
// this workbook that have fewer contacts than the configured cap, instead
// of ones missing a LinkedIn company ID. Writes directly to the workbook -
// no separate review/merge step, see storage.js's own comment on
// getExistingCompaniesNeedingContacts for why that's safe here (unlike
// Phase 5/6, there's no identity ambiguity to review before committing).
discoverContactsExistingBtn.addEventListener("click", async () => {
  if (!(await guardBatchStart("Discovery of contacts for existing companies", askConfirm))) return;
  let toVisit = await getExistingCompaniesNeedingContacts();
  const limit = parseInt(discoverContactsExistingLimitInput.value, 10);
  if (Number.isFinite(limit) && limit > 0 && limit < toVisit.length) {
    toVisit = toVisit.slice(0, limit);
  }
  if (toVisit.length === 0) {
    discoverContactsExistingStatusEl.textContent = "Nothing to do - every Target Account company already has enough contacts on file.";
    return;
  }
  const estMinutes = Math.round((toVisit.length * 6.5) / 60) || 1;
  if (!(await askConfirm(
    `This will look up contacts at ${toVisit.length} existing Target Account compan${toVisit.length === 1 ? "y" : "ies"} ` +
    `via LinkedIn (roughly ${estMinutes} minute${estMinutes === 1 ? "" : "s"} - paced to avoid rapid-fire requests). ` +
    "Found contacts are added directly - a wrong one can be removed afterward from its own Contact page. Continue?"
  ))) return;

  discoverContactsExistingBtn.disabled = true;
  stopDiscoverContactsExistingBtn.hidden = false;
  stopDiscoverContactsExistingBtn.disabled = false;
  stopDiscoverContactsExistingBtn.textContent = "Stop";
  contactDiscoveryExistingAbortRequested = false;
  try {
    const {
      ranAnything, reason, companiesProcessed, totalCandidates, totalNewContacts, companiesWithNoMatch,
      droppedTerms, stoppedByTouchBudget, stoppedByAbort,
    } = await runContactDiscoveryForExistingCompanies({
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      onProgress: (p) => { discoverContactsExistingStatusEl.textContent = `Checking company ${p.index + 1} of ${p.total}: ${p.company}…`; },
      shouldAbort: () => contactDiscoveryExistingAbortRequested,
    });
    if (!ranAnything) {
      discoverContactsExistingStatusEl.textContent = `Nothing to do - ${reason}.`;
    } else {
      const stoppedSuffix = stoppedByTouchBudget
        ? ` - stopped automatically, daily LinkedIn activity limit reached (${totalCandidates - companiesProcessed} of ${totalCandidates} not yet visited this run; resume anytime).`
        : stoppedByAbort
          ? ` - stopped by you (${totalCandidates - companiesProcessed} of ${totalCandidates} not yet visited this run).`
          : ".";
      discoverContactsExistingStatusEl.textContent =
        `Done - ${totalNewContacts} new contact${totalNewContacts === 1 ? "" : "s"} added across ${companiesProcessed} compan${companiesProcessed === 1 ? "y" : "ies"} checked` +
        (companiesWithNoMatch > 0 ? ` (${companiesWithNoMatch} had no matching contact)` : "") +
        (droppedTerms && droppedTerms.length > 0 ? ` - ${droppedTerms.length} title/keyword term(s) dropped by the search-complexity cap` : "") +
        stoppedSuffix;
      await loadWorkbook();
      appendActivityLog({
        actor: stoppedByTouchBudget ? "extension" : "user",
        action: "existing_company_contacts_discovered",
        label: `Discover Contacts for Existing Companies: ${totalNewContacts} new contact(s) across ${companiesProcessed} compan${companiesProcessed === 1 ? "y" : "ies"}` +
          (stoppedByTouchBudget ? ", stopped automatically (daily LinkedIn activity limit reached)" : stoppedByAbort ? ", stopped early by you" : ""),
        newValue: { totalNewContacts, companiesProcessed, totalCandidates, companiesWithNoMatch, stoppedByTouchBudget, stoppedByAbort },
      });
    }
  } catch (err) {
    discoverContactsExistingStatusEl.textContent = `Something went wrong: ${err.message}`;
    appendActivityLog({ actor: "user", action: "existing_company_contacts_discovered", label: "Discover Contacts for Existing Companies failed", error: true, errorMessage: err.message });
  } finally {
    discoverContactsExistingBtn.disabled = false;
    stopDiscoverContactsExistingBtn.hidden = true;
  }
});

stopDiscoverContactsExistingBtn.addEventListener("click", () => {
  contactDiscoveryExistingAbortRequested = true;
  stopDiscoverContactsExistingBtn.disabled = true;
  stopDiscoverContactsExistingBtn.textContent = "Stopping…";
});

// Runs the same no-AI prioritization as the Prioritize Companies button for every company that has no Priority yet -
// right after an import or a Discovery merge, so the Priority / Priority Score / Priority Reason columns are filled
// straight away instead of staying empty until the button is clicked (imported research that is already confident
// becomes P1/P2 with its own score; everything else is scored from the Setup wizard's rules and its contacts).
// Free: local computation only - no AI call, no LinkedIn visit. Returns { applied, summary } (applied 0 = nothing new).
async function autoPrioritizeNewCompanies() {
  const eligible = await getCompaniesForPrioritization({ rescoreAll: false });
  if (eligible.length === 0) return { applied: 0, summary: "" };
  const [targetUniverseConfig, mentorPersona, companyContext, idealCustomerProfile, outputLanguage] = await Promise.all([
    getTargetUniverseConfig(), getMentorPersona(), getCompanyContext(), getIdealCustomerProfile(), getOutputLanguage(),
  ]);
  const results = await prioritizeCompanies(
    eligible, targetUniverseConfig,
    { apiKey: null, mentorPersona, companyContext, idealCustomerProfile, outputLanguage },
    { useAI: false }
  );
  const applied = await applyCompanyPrioritizationResults(results);
  const counts = { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 };
  for (const r of results) if (counts[r.priority] != null) counts[r.priority]++;
  const summary = ["P1", "P2", "P3", "P4", "P5"].filter((p) => counts[p] > 0).map((p) => `${counts[p]} ${p}`).join(", ");
  appendActivityLog({
    actor: "extension",
    action: "companies_prioritized",
    label: `Priorities calculated automatically for ${applied} new compan${applied === 1 ? "y" : "ies"} (${summary})`,
    newValue: { applied, counts, useAI: false, automatic: true },
  });
  await loadWorkbook();
  return { applied, summary };
}

// PRD 6.20 Phase 8 (2026-09-17) - no LinkedIn touches at all (this is pure
// local computation plus, optionally, one batch Claude call), so unlike the
// two handlers above there's no Stop button or touch-budget messaging -
// just a single request/response.
prioritizeCompaniesBtn.addEventListener("click", async () => {
  if (!(await guardBatchStart("Prioritizing companies with AI", askConfirm))) return;
  const useAI = prioritizeCompaniesAiCheckbox.checked;
  const rescoreAll = prioritizeCompaniesRescoreCheckbox.checked;
  const limit = parseInt(prioritizeCompaniesLimitInput.value, 10);

  let eligible = await getCompaniesForPrioritization({ rescoreAll });
  if (Number.isFinite(limit) && limit > 0 && limit < eligible.length) {
    eligible = eligible.slice(0, limit);
  }
  if (eligible.length === 0) {
    prioritizeCompaniesStatusEl.textContent = rescoreAll
      ? "Nothing to do - no eligible companies in the Target Accounts list."
      : "Nothing to do - every eligible company already has a Priority (check “Rescore already-scored companies too” to redo them).";
    return;
  }

  if (useAI) {
    const aiCount = eligible.filter((e) => e.scenario === 1 || e.scenario === 4).length;
    if (aiCount > 0 && !(await askConfirm(
      `This will call Claude to judge Strategic Fit for ${aiCount} compan${aiCount === 1 ? "y" : "ies"} ` +
      "(the rest resolve without AI - already-confident imported research, or floored for lack of any evidence). Continue?"
    ))) return;
    if (aiCount > 0 && !(await confirmIfCostly("companyFit", aiCount, "Judging these companies with AI", askConfirm))) return;
  }

  prioritizeCompaniesBtn.disabled = true;
  prioritizeCompaniesStatusEl.textContent = `Scoring ${eligible.length} compan${eligible.length === 1 ? "y" : "ies"}…`;
  try {
    const [targetUniverseConfig, mentorPersona, companyContext, idealCustomerProfile, outputLanguage, apiKey] = await Promise.all([
      getTargetUniverseConfig(),
      getMentorPersona(),
      getCompanyContext(),
      getIdealCustomerProfile(),
      getOutputLanguage(),
      useAI ? getAnthropicApiKey() : Promise.resolve(null),
    ]);
    const settings = { apiKey, mentorPersona, companyContext, idealCustomerProfile, outputLanguage };
    const results = await withBatch("Prioritizing companies with AI", () => prioritizeCompanies(eligible, targetUniverseConfig, settings, {
      useAI,
      onProgress: (p) => {
        prioritizeCompaniesStatusEl.textContent =
          `Scoring ${eligible.length} compan${eligible.length === 1 ? "y" : "ies"} - Strategic Fit batch ${p.chunkIndex + 1} of ${p.totalChunks}…`;
      },
    }));
    const applied = await applyCompanyPrioritizationResults(results);

    const counts = { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 };
    for (const r of results) if (counts[r.priority] != null) counts[r.priority]++;
    const summary = ["P1", "P2", "P3", "P4", "P5"].filter((p) => counts[p] > 0).map((p) => `${counts[p]} ${p}`).join(", ");
    prioritizeCompaniesStatusEl.textContent = `Done - ${applied} compan${applied === 1 ? "y" : "ies"} scored (${summary}).`;
    await loadWorkbook();
    appendActivityLog({
      actor: "user",
      action: "companies_prioritized",
      label: `Prioritize Companies: ${applied} scored (${summary})${useAI ? ", including AI Strategic Fit" : ""}`,
      newValue: { applied, counts, useAI, rescoreAll },
    });
  } catch (err) {
    prioritizeCompaniesStatusEl.textContent = `Something went wrong: ${err.message}`;
    appendActivityLog({ actor: "user", action: "companies_prioritized", label: "Prioritize Companies failed", error: true, errorMessage: err.message });
  } finally {
    prioritizeCompaniesBtn.disabled = false;
  }
});

// "Fetch Company Size" (2026-09-17, PRD 6.20 Phase 8) - real LinkedIn
// touches, one per company (unlike Prioritize Companies above), so this
// mirrors Discover Contacts for Existing Companies' pattern (Stop button,
// touch-budget messaging) rather than Prioritize Companies' simpler one.
fetchCompanySizeBtn.addEventListener("click", async () => {
  if (!(await guardBatchStart("Looking up company sizes on LinkedIn", askConfirm))) return;
  let toVisit = await getCompaniesNeedingSize();
  const limit = parseInt(fetchCompanySizeLimitInput.value, 10);
  if (Number.isFinite(limit) && limit > 0 && limit < toVisit.length) {
    toVisit = toVisit.slice(0, limit);
  }
  if (toVisit.length === 0) {
    fetchCompanySizeStatusEl.textContent = "Nothing to do - every company already has a size on file.";
    return;
  }
  if (!(await askConfirm(sizeFetchConfirmText(toVisit.length)))) return;

  fetchCompanySizeBtn.disabled = true;
  stopFetchCompanySizeBtn.hidden = false;
  stopFetchCompanySizeBtn.disabled = false;
  stopFetchCompanySizeBtn.textContent = "Stop";
  sizeFetchAbortRequested = false;
  try {
    const { results, attemptedKeys, stoppedByTouchBudget, stoppedByAbort } = await runCompanySizeFetch(toVisit, {
      onProgress: (p) => { fetchCompanySizeStatusEl.textContent = `Checking company ${p.index + 1} of ${p.total}: ${p.company}…`; },
      shouldAbort: () => sizeFetchAbortRequested,
    });
    const applied = await applyCompanySizeResults(results);
    if (attemptedKeys.length > 0) await markCompanySizeFetchAttempted(attemptedKeys);

    const stoppedSuffix = stoppedByTouchBudget
      ? ` - stopped automatically, daily LinkedIn activity limit reached (${toVisit.length - attemptedKeys.length} not yet visited this run; resume anytime).`
      : stoppedByAbort
        ? ` - stopped by you (${toVisit.length - attemptedKeys.length} not yet visited this run).`
        : ".";
    fetchCompanySizeStatusEl.textContent =
      `Done - ${applied} of ${attemptedKeys.length} compan${attemptedKeys.length === 1 ? "y" : "ies"} checked got a real size` + stoppedSuffix;
    await loadWorkbook();
    appendActivityLog({
      actor: stoppedByTouchBudget ? "extension" : "user",
      action: "company_size_fetched",
      label: `Fetch Company Size: ${applied} of ${attemptedKeys.length} checked` +
        (stoppedByTouchBudget ? ", stopped automatically (daily LinkedIn activity limit reached)" : stoppedByAbort ? ", stopped early by you" : ""),
      newValue: { applied, attempted: attemptedKeys.length, stoppedByTouchBudget, stoppedByAbort },
    });
  } catch (err) {
    fetchCompanySizeStatusEl.textContent = `Something went wrong: ${err.message}`;
    appendActivityLog({ actor: "user", action: "company_size_fetched", label: "Fetch Company Size failed", error: true, errorMessage: err.message });
  } finally {
    fetchCompanySizeBtn.disabled = false;
    stopFetchCompanySizeBtn.hidden = true;
  }
});

stopFetchCompanySizeBtn.addEventListener("click", () => {
  sizeFetchAbortRequested = true;
  stopFetchCompanySizeBtn.disabled = true;
  stopFetchCompanySizeBtn.textContent = "Stopping…";
});

// v0.29.38, see PRD 6.11: "Importing…" / persistent result-or-failure
// status, not a transient alert - this was originally a separate code path
// from Settings' own copy, kept in sync by hand (and once drifted from it -
// see the historical parity-bug note in PRD.md 6.12); now the only copy,
// since Settings' Target Accounts management moved here entirely
// (2026-09-16).
function formatImportStamp(ms) {
  return new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

importTargetAccountsPageFileInput.addEventListener("change", async () => {
  const file = importTargetAccountsPageFileInput.files[0];
  importTargetAccountsPageFileInput.value = "";
  if (!file) return;
  const lowerName = file.name.toLowerCase();
  const isBackupFile = lowerName.endsWith(".zip") || lowerName.endsWith(".json");
  if (importPickerMode === "research" && isBackupFile) {
    targetAccountsPageIoStatusEl.textContent = `"${file.name}" is a backup file, not a research workbook. Use "Restore Accounts & Contacts from Backup…" to load it.`;
    return;
  }
  if (importPickerMode === "restore" && !isBackupFile) {
    targetAccountsPageIoStatusEl.textContent = `"${file.name}" is not a backup file (.zip or .json). Use "Import Research Workbook…" for an Excel workbook.`;
    return;
  }
  targetAccountsPageIoStatusEl.textContent = `${importPickerMode === "restore" ? "Reading" : "Importing"} ${file.name}…`;

  let list;
  let fullWorkbook = null;
  // Declared here, not inside the `else` block below where it's first
  // built, so the second usage further down (reattaching aliases onto
  // fullWorkbook.companies once we're past the try/catch) can still see
  // it - a real bug caught live, 2026-09-19: the first version declared
  // this with `const` inside that nested block, throwing a silent
  // ReferenceError the moment execution reached the second usage (BEFORE
  // importTargetAccountsWorkbook() ran), which left the import status
  // stuck on "Importing X…" forever and meant the Explorer workbook
  // (Contacts/Initiatives/etc.) never actually got imported at all.
  let aliasesByCompanyId = new Map();
  try {
    if (lowerName.endsWith(".zip")) {
      // A full backup zip: offer only the account-related parts (accounts / contacts / initiatives, your edits to them,
      // and staged Discovery results) - settings, leads and the rest stay untouched.
      const parsed = await parseFullBackup(await file.arrayBuffer());
      const accountParts = ["accounts", "edits", "staged"];
      const limited = {
        ...parsed.manifest,
        categories: Object.fromEntries(Object.entries(parsed.manifest.categories || {}).filter(([id]) => accountParts.includes(id))),
      };
      const sections = await chooseRestoreSections("full", limited);
      if (!sections) { targetAccountsPageIoStatusEl.textContent = "Restore cancelled."; return; }
      targetAccountsPageIoStatusEl.textContent = "Saving a safety copy of your current data first…";
      if (!(await safetyCopyBeforeRestore())) { targetAccountsPageIoStatusEl.textContent = "Restore cancelled."; return; }
      const prevMeta = await getTargetAccountsMeta();
      await restoreFullBackup(parsed, sections);
      await loadWorkbook();
      const now = await getTargetAccountsMeta();
      targetAccountsPageIoStatusEl.textContent =
        `Restored ${[...sections].join(", ")} from ${file.name} at ${formatImportStamp(Date.now())} (${workbook.companies.length} accounts now loaded).`;
      appendActivityLog({
        actor: "user",
        action: "target_accounts_imported",
        label: `Restored Target Accounts from backup zip (${[...sections].join(", ")})`,
        prevValue: prevMeta.count,
        newValue: now.count,
      });
      return;
    }
    if (lowerName.endsWith(".json")) {
      const parsed = extractBackupPart(JSON.parse(await file.text()), "targetAccounts");
      if (parsed && !Array.isArray(parsed) && (parsed.targetAccounts || parsed.targetAccountsWorkbook || parsed.targetAccountExtras)) {
        const sections = await chooseRestoreSections("targetAccounts", parsed);
        if (!sections) { targetAccountsPageIoStatusEl.textContent = "Restore cancelled."; return; }
        const prevMeta = await getTargetAccountsMeta();
        const { count, workbookCount } = await importTargetAccountsBackup(parsed, sections);
        await loadWorkbook();
        targetAccountsPageIoStatusEl.textContent = count === null
          ? `Restored ${[...sections].join(", ")} from file ${file.name} at ${formatImportStamp(Date.now())}`
          : `Restored ${count} companies${workbookCount ? `, ${workbookCount} in Explorer workbook,` : ""} from file ${file.name} at ${formatImportStamp(Date.now())}`;
        appendActivityLog({
          actor: "user",
          action: "target_accounts_imported",
          label: count === null
            ? `Restored Target Accounts backup (${[...sections].join(", ")})`
            : `Restored Target Accounts backup (${count} companies${workbookCount ? `, ${workbookCount} in Explorer workbook` : ""}; ${[...sections].join(", ")})`,
          prevValue: prevMeta.count,
          newValue: count,
        });
        return;
      }
      list = parsed;
    } else {
      fullWorkbook = await parseFullTargetAccountsWorkbook(await file.arrayBuffer());
      // 28th round of direct feedback (2026-09-19): "it could be a good
      // idea to import and integrate these aliases now" - the workbook's
      // own Aliases sheet (companyId -> multiple name variants: legal name,
      // former name, trading name, search variant, etc.) grouped here by
      // companyId so each company row carries every alias string LinkedIn
      // might show for it. storage.js's importTargetAccounts is what
      // actually uses this - indexing the lead-matching lookup by every
      // known alias, not just the row's own primary `company` name.
      for (const a of fullWorkbook.aliases || []) {
        if (!a.companyId || !a.alias) continue;
        if (!aliasesByCompanyId.has(a.companyId)) aliasesByCompanyId.set(a.companyId, new Set());
        aliasesByCompanyId.get(a.companyId).add(a.alias.trim());
      }
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
          aliases: c.companyId && aliasesByCompanyId.has(c.companyId)
            ? [...aliasesByCompanyId.get(c.companyId)]
            : [],
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
  // Exclusion backfill (added 2026-09-17, the user's own proposal) - runs
  // right after the workbook itself is stored, so backfillCompanyExclusionsFromWorkbook
  // reads the same Excluded/Exclusion_List data this import just brought
  // in. Additive only (see its own comment in storage.js) - never touches
  // an existing entry, so it's safe to run on every import, not just the
  // first one.
  let backfill = null;
  if (fullWorkbook) {
    // Same aliases attached to `list` above, carried onto the richer
    // Explorer workbook rows too (storage.js's computeDiscoveredMergeDiff
    // matches a newly-discovered company by name against these same rows -
    // without this, a discovered card whose displayed name only matches a
    // known ALIAS, not the row's own primary company name, would wrongly
    // be treated as a brand-new company instead of the existing account).
    for (const c of fullWorkbook.companies || []) {
      if (c.companyId && aliasesByCompanyId.has(c.companyId)) {
        c.aliases = [...aliasesByCompanyId.get(c.companyId)];
      }
    }
    await importTargetAccountsWorkbook(fullWorkbook);
    backfill = await backfillCompanyExclusionsFromWorkbook(fullWorkbook);
  }
  await loadWorkbook();
  const backfillNote = backfill && backfill.addedCount > 0
    ? ` - ${backfill.addedCount} excluded compan${backfill.addedCount === 1 ? "y" : "ies"} added to your own exclusion lists (Setup wizard)`
    : "";
  // 29th round of direct feedback (2026-09-19): "shouldn't it also mention
  // [the new contacts]? XXX contacts read or something like that?" -
  // "plus full Explorer data (Contacts, Initiatives, etc.)" named the
  // sheets but never said how much was actually in them. Real counts,
  // omitting a sheet entirely when this workbook doesn't have one (e.g. an
  // older export with no Initiatives sheet) rather than showing "0" for
  // something that was never expected to be there.
  const explorerCounts = fullWorkbook
    ? [
        [fullWorkbook.contacts?.length, "contact"],
        [fullWorkbook.aiInitiatives?.length, "initiative"],
        [fullWorkbook.aiInvestment?.length, "investment record"],
        [fullWorkbook.sources?.length, "source"],
      ]
        .filter(([n]) => n > 0)
        .map(([n, label]) => `${n} ${label}${n === 1 ? "" : "s"}`)
        .join(", ")
    : "";
  const explorerNote = explorerCounts ? ` plus ${explorerCounts}` : "";
  // fill the Priority columns right away (see autoPrioritizeNewCompanies) - a failure here never fails the import
  const autoPriority = await autoPrioritizeNewCompanies().catch(() => ({ applied: 0, summary: "" }));
  const priorityNote = autoPriority.applied > 0 ? ` - priorities calculated for ${autoPriority.applied} (${autoPriority.summary})` : "";
  targetAccountsPageIoStatusEl.textContent = `${count} companies${explorerNote} imported from file ${file.name} at ${formatImportStamp(Date.now())}${backfillNote}${priorityNote}`;
  appendActivityLog({
    actor: "user",
    action: "target_accounts_imported",
    label: `Imported Target Accounts list (${count} companies${explorerNote})${backfillNote}`,
    prevValue: prevMeta.count,
    newValue: count,
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
// too much for a fixed count to hold up, e.g. "Employees (Local)" vs
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

// PRD 6.20 Phase 10 Step 3 (2026-09-18), narrowed the same day from direct
// feedback after seeing the first version live: the user only trusts
// self-correction for real CLASSIFICATION mistakes (Industry/Type - picked
// from a dropdown of values ALREADY used elsewhere in the workbook, never
// free text, so a typo/near-duplicate can never fragment the real category
// list), the Alt. name list, and Top Initiatives. Everything else this
// first version made editable (LinkedIn/Website URLs, Address, Employees,
// Revenue, Budget) got walked back on purpose - the user's own reasoning:
// unless they're pulling from an official source (a financial report, a
// press release), they have no better data than SalesTeam's own research,
// and LinkedIn/Website links specifically should stay something SalesTeam
// verifies, not something a user free-types over. Company name / contact
// full name stay excluded too, same identity-key reasoning as before (see
// storage.js's emptyExtra()).
function distinctColumnValues(companies, key) {
  const values = new Set();
  for (const c of companies) {
    const v = (c[key] || "").trim();
    if (v) values.add(v);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

const ACCOUNT_EDIT_FIELDS = [
  { key: "industry", label: "Industry", type: "select", options: () => distinctColumnValues(workbook.companies, "industry") },
  { key: "targetCountryRelationship", label: "Local / Global", type: "select",
    options: () => [...new Set(["Local company", "Global company", ...distinctColumnValues(workbook.companies, "targetCountryRelationship")])] },
  { key: "companyType", label: "Company Type", type: "select", options: () => distinctColumnValues(workbook.companies, "companyType") },
  { key: "alternativeCompanyName", label: "Alt. name(s)", type: "list" },
  { key: "topAiInitiatives", label: "Top initiatives", type: "textarea" },
];

// Narrowed 2026-09-18, same day, same direct feedback as ACCOUNT_EDIT_FIELDS
// above: LinkedIn URL dropped (SalesTeam-verified, not something a user
// should free-type over - same reasoning as Accounts' own LinkedIn field),
// Seniority changed from free text to a dropdown of values already used
// elsewhere in the workbook (same distinctColumnValues approach as
// Industry/Type, same "don't let typos spawn near-duplicate categories"
// reasoning), and Business Phone added alongside Business Email.
const CONTACT_EDIT_FIELDS = [
  { key: "jobTitle", label: "Title", type: "text" },
  { key: "function", label: "Function", type: "text" },
  { key: "seniority", label: "Seniority", type: "select", options: () => distinctColumnValues(workbook.contacts, "seniority") },
  { key: "publicBusinessEmail", label: "Business email", type: "text" },
  { key: "publicBusinessPhone", label: "Business phone", type: "text" },
  { key: "aiRelevance", label: "Relevance", type: "textarea" },
];

// effectiveRow already has overrides merged in (see renderAccountView/
// renderContactView) - fields pre-fill with whatever's currently shown, not
// just the raw imported value, so re-opening Edit after a save (or on a
// row with an existing override) shows the value actually in effect.
// statusOpts ({ leadBucket, manualStatus }) adds a Status select to the form (reported directly, 2026-09-21: Status
// must be editable from Edit, not only from the read-only view). It writes the same manual override as the view's own
// select and is handed to onSave as the second argument - undefined when the choice was left alone.
function buildEditForm(fields, effectiveRow, onSave, onCancel, statusOpts) {
  const form = document.createElement("div");
  form.className = "overview-card overview-edit-form";

  const shortFields = fields.filter((f) => f.type !== "textarea" && f.type !== "list");
  const longFields = fields.filter((f) => f.type === "textarea" || f.type === "list");
  const inputs = {};

  let statusSelect = null;
  if (shortFields.length > 0 || statusOpts) {
    const grid = document.createElement("div");
    grid.className = "overview-grid";
    if (statusOpts) {
      const field = document.createElement("div");
      const dt = document.createElement("div");
      dt.className = "overview-label";
      dt.textContent = "Status";
      statusSelect = document.createElement("select");
      statusSelect.className = "edit-field-input";
      statusSelect.title = "Never lets the shown status go backward while leads themselves show a higher one";
      for (const opt of [MANUAL_STATUS_AUTO_OPTION, "Contacted", "Responded"]) {
        const optionEl = document.createElement("option");
        optionEl.value = opt;
        // The auto option must preview the LEAD bucket alone, not effectiveStatus - picking it clears
        // manualStatus, so the lead bucket is exactly what you get. Showing effectiveStatus here meant
        // that on a record with a manual "Contacted" over leads that say "Not contacted", the option
        // read "currently Contacted" and then selecting it displayed "Not contacted" (reported 2026-09-22).
        optionEl.textContent = opt === MANUAL_STATUS_AUTO_OPTION ? `${opt} - currently ${statusOpts.leadBucket}` : opt;
        statusSelect.appendChild(optionEl);
      }
      statusSelect.value = statusOpts.manualStatus || MANUAL_STATUS_AUTO_OPTION;
      field.append(dt, statusSelect);
      grid.appendChild(field);
    }
    for (const f of shortFields) {
      const field = document.createElement("div");
      const dt = document.createElement("div");
      dt.className = "overview-label";
      dt.textContent = f.label;
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        input.className = "edit-field-input";
        const currentValue = effectiveRow[f.key] || "";
        const optionValues = new Set(f.options());
        if (currentValue) optionValues.add(currentValue);
        const blankOpt = document.createElement("option");
        blankOpt.value = "";
        blankOpt.textContent = "(none)";
        input.appendChild(blankOpt);
        // Type shows country-neutral wording (see localizeTypeWording) but each option's
        // value stays the stored text, so saving without a change never creates an override.
        const optionLabel = (v) => (f.key === "companyType" ? localizeTypeWording(v) : v);
        for (const opt of [...optionValues].sort((a, b) => optionLabel(a).localeCompare(optionLabel(b)))) {
          const optionEl = document.createElement("option");
          optionEl.value = opt;
          optionEl.textContent = optionLabel(opt);
          input.appendChild(optionEl);
        }
        input.value = currentValue;
      } else {
        input = document.createElement("input");
        input.type = f.type === "number" ? "number" : "text";
        input.className = "edit-field-input";
        const value = effectiveRow[f.key];
        input.value = value == null ? "" : value;
      }
      inputs[f.key] = input;
      field.append(dt, input);
      grid.appendChild(field);
    }
    form.appendChild(grid);
  }

  for (const f of longFields) {
    const row = document.createElement("div");
    row.className = "overview-long-field";
    const dt = document.createElement("div");
    dt.className = "overview-label";
    dt.textContent = f.label;
    const textarea = document.createElement("textarea");
    textarea.className = "edit-field-input edit-field-textarea";
    textarea.rows = 3;
    const value = effectiveRow[f.key];
    if (f.type === "list") {
      textarea.placeholder = "One name per line";
      const lines = Array.isArray(value) ? value : (value ? [value] : []);
      textarea.value = lines.join("\n");
    } else {
      textarea.value = value == null ? "" : value;
    }
    inputs[f.key] = textarea;
    row.append(dt, textarea);
    form.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "overview-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "edit-save-btn";
  saveBtn.textContent = "Save changes";
  saveBtn.addEventListener("click", () => {
    const values = {};
    for (const f of fields) {
      values[f.key] = f.type === "list"
        ? inputs[f.key].value.split("\n").map((s) => s.trim()).filter(Boolean)
        : inputs[f.key].value;
    }
    let statusChoice;
    if (statusSelect) {
      const picked = statusSelect.value === MANUAL_STATUS_AUTO_OPTION ? null : statusSelect.value;
      if (picked !== (statusOpts.manualStatus || null)) statusChoice = picked;
    }
    onSave(values, statusChoice);
  });
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "edit-cancel-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", onCancel);
  actions.append(saveBtn, cancelBtn);
  form.appendChild(actions);

  return form;
}

// Diffs the edit form's submitted string values against the field's raw
// IMPORTED value (never the override-merged one) - a field left exactly as
// imported never gets an override key at all, so a later re-import keeps
// flowing through it untouched; only fields actually pushed away from the
// imported value stay frozen at the user's own edit. Returns { overrides,
// changedLabels } - overrides is a full replacement object ready to hand
// straight to saveTargetAccountExtra/saveTargetContactExtra.
function diffEditFormValues(fields, importedRow, existingOverrides, formValues) {
  const overrides = { ...existingOverrides };
  const changedLabels = [];
  for (const f of fields) {
    const wasOverridden = Object.prototype.hasOwnProperty.call(existingOverrides, f.key);
    if (f.type === "list") {
      // The imported row only ever has a single string (alternativeCompanyName
      // pre-dates this list upgrade) - treated as a one-entry list for
      // comparison purposes, so opening/closing Edit without touching this
      // field never manufactures a spurious override.
      const normalized = formValues[f.key];
      const importedList = importedRow[f.key] ? [importedRow[f.key]] : [];
      const prevEffective = wasOverridden ? existingOverrides[f.key] : importedList;
      const equalsImported = JSON.stringify(normalized) === JSON.stringify(importedList);
      const equalsPrev = JSON.stringify(normalized) === JSON.stringify(prevEffective);
      if (equalsImported) {
        if (wasOverridden) { delete overrides[f.key]; changedLabels.push(f.label); }
      } else if (!equalsPrev) {
        overrides[f.key] = normalized;
        changedLabels.push(f.label);
      }
      continue;
    }
    const raw = formValues[f.key];
    const trimmed = typeof raw === "string" ? raw.trim() : raw;
    const normalized = f.type === "number" ? (trimmed === "" ? null : Number(trimmed)) : (trimmed === "" ? null : trimmed);
    const importedValue = importedRow[f.key] ?? null;
    const prevEffective = wasOverridden ? existingOverrides[f.key] : importedValue;
    if (normalized === importedValue) {
      if (wasOverridden) { delete overrides[f.key]; changedLabels.push(f.label); }
    } else if (normalized !== prevEffective) {
      overrides[f.key] = normalized;
      changedLabels.push(f.label);
    }
  }
  return { overrides, changedLabels };
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

document.getElementById("open-onboarding-link").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html#wizard") });
});

// manualStatusAt (2026-09-18) folds in the manual-override timestamp - a
// "cold" account/contact with no lead at all previously could never show a
// Last Contact date no matter what the user actually did, since this only
// ever read from lead.statusUpdatedAt.
function lastCommunicationFor(leadsForEntity, manualStatusAt) {
  const contacted = leadsForEntity
    .filter((l) => ["Contacted", "Responded", "Converted"].includes(l.status))
    .map((l) => l.statusUpdatedAt || 0);
  if (manualStatusAt) contacted.push(manualStatusAt);
  return contacted.length > 0 ? Math.max(...contacted) : null;
}

// The Status overview field (2026-09-18) - a pill showing the effective
// status (leads vs. manual override, whichever ranks higher - see
// effectiveStatus above) plus a small select for setting/clearing the
// manual override directly ("should be able to set it manually for both
// contacts and accounts" - the user's own explicit request). Unlike
// advanceManualStatus (the automatic "copied a message" trigger), this
// always writes exactly what's picked - an explicit user choice, not an
// automatic one, so it's allowed to "downgrade" the stored manualStatus
// (though the effective display can never go backward while leads
// themselves still show a higher one). Picking "(auto from leads)" clears
// the override entirely (manualStatus: null), handing status back to
// whatever leads alone say.
const MANUAL_STATUS_AUTO_OPTION = "(auto from leads)";

function statusFieldNode(leadBucket, manualStatus, onSetManual) {
  const wrap = document.createElement("div");
  wrap.className = "status-field-wrap";

  const pill = document.createElement("span");
  const effective = effectiveStatus(leadBucket, manualStatus);
  pill.className = `priority-pill ${statusPillClass(effective)}`;
  pill.textContent = effective;
  wrap.appendChild(pill);

  const select = document.createElement("select");
  select.className = "status-manual-select";
  select.title = "Set this status manually - never lets the display go backward while leads themselves show a higher one";
  for (const opt of [MANUAL_STATUS_AUTO_OPTION, "Contacted", "Responded"]) {
    const option = document.createElement("option");
    option.value = opt;
    option.textContent = opt;
    select.appendChild(option);
  }
  select.value = manualStatus || MANUAL_STATUS_AUTO_OPTION;
  select.addEventListener("change", () => onSetManual(select.value === MANUAL_STATUS_AUTO_OPTION ? null : select.value));
  wrap.appendChild(select);

  return wrap;
}

// Reported directly, 2026-09-18: a manual override of SalesTeam's own
// Phase 8 priority score needs a reason attached every time, not just a
// bare value swap - "if I manually override the automatic priority, I
// should be requested to also enter a new/or edit the Priority Reason, or
// mark [it] as 'overridden by user'." Unlike statusFieldNode above (which
// saves the instant the <select> changes), moving to a manual P1-P5 value
// here only reveals the reason box + a Set button - nothing is written
// until the reason is confirmed. Moving back to auto clears both
// immediately (no reason needed to un-override, same as Status's own
// instant-clear behavior).
const MANUAL_PRIORITY_AUTO_OPTION = "(auto from scoring)";
const DEFAULT_MANUAL_PRIORITY_REASON = "Overridden by user";

function salesTeamPriorityFieldNode(autoPriority, autoScore, autoReason, manualPriority, manualReason, onSetManual) {
  const wrap = document.createElement("div");
  wrap.className = "status-field-wrap";

  const effective = manualPriority || autoPriority;
  const pill = document.createElement("span");
  pill.className = `priority-pill ${effective ? salesTeamPriorityPillClass(effective) : "priority-pill-other"}`;
  pill.textContent = effective ? `${effective}${!manualPriority && autoScore != null ? ` (${Math.round(autoScore)}/100)` : ""}` : "Not scored";
  const effectiveReason = manualPriority ? manualReason : autoReason;
  if (effectiveReason) pill.title = effectiveReason;
  wrap.appendChild(pill);

  const select = document.createElement("select");
  select.className = "status-manual-select";
  select.title = "Manually override SalesTeam's own automatic priority - requires a reason";
  for (const opt of [MANUAL_PRIORITY_AUTO_OPTION, "P1", "P2", "P3", "P4", "P5"]) {
    const option = document.createElement("option");
    option.value = opt;
    option.textContent = opt;
    select.appendChild(option);
  }
  select.value = manualPriority || MANUAL_PRIORITY_AUTO_OPTION;
  wrap.appendChild(select);

  const reasonWrap = document.createElement("div");
  reasonWrap.className = "priority-override-reason-wrap";
  reasonWrap.hidden = !manualPriority;
  const reasonInput = document.createElement("input");
  reasonInput.type = "text";
  reasonInput.className = "edit-field-input priority-override-reason-input";
  reasonInput.placeholder = "Reason for override";
  reasonInput.value = manualReason || DEFAULT_MANUAL_PRIORITY_REASON;
  const setBtn = document.createElement("button");
  setBtn.type = "button";
  setBtn.className = "edit-save-btn priority-override-set-btn";
  setBtn.textContent = "Set";
  const commit = () => onSetManual(select.value, reasonInput.value.trim() || DEFAULT_MANUAL_PRIORITY_REASON);
  setBtn.addEventListener("click", commit);
  reasonInput.addEventListener("keydown", (event) => { if (event.key === "Enter") commit(); });
  reasonWrap.append(reasonInput, setBtn);
  wrap.appendChild(reasonWrap);

  select.addEventListener("change", () => {
    if (select.value === MANUAL_PRIORITY_AUTO_OPTION) {
      reasonWrap.hidden = true;
      onSetManual(null, null);
    } else {
      reasonWrap.hidden = false;
      reasonInput.value = manualReason || DEFAULT_MANUAL_PRIORITY_REASON;
      reasonInput.focus();
    }
  });

  return wrap;
}

// Reported directly: "Last contact made" and "Follow-up due" belong in the
// same overview card as the rest of the account/contact's stats, not as
// separate rows below it. The due-date input/Clear button live in the HTML
// as plain hidden elements (not inside the overview div at all) precisely
// so they can be un-hidden and moved into a card field here on every
// render, rather than recreated - wireDueDateInput's event listeners stay
// attached to these same two elements throughout.
// Parks the two controls back in the (hidden) view root before the overview is cleared: entering Edit mode clears the
// overview card they were moved into, which used to delete them from the page - the next render (Save or Cancel) then
// could not find them and threw, leaving the edit form on screen (found 2026-09-21).
function parkDueDateControls(viewRootId, inputEl, clearBtnEl) {
  inputEl.hidden = true;
  clearBtnEl.hidden = true;
  document.getElementById(viewRootId).append(inputEl, clearBtnEl);
}

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
function createAgentChat({ buildSystemPrompt, historyEl, statusEl, inputEl, sendBtn, clearBtn, getHistoryFn, saveHistoryFn, label, getRelatedKeys, onCopyDraft }) {
  let history = [];

  function appendBubble(kind, text) {
    const bubble = document.createElement("div");
    bubble.className = `agent-bubble agent-bubble-${kind}`;
    const textNode = document.createElement("span");
    textNode.className = "agent-bubble-text";
    textNode.textContent = text;
    bubble.appendChild(textNode);
    if (kind === "agent" && onCopyDraft) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "agent-bubble-copy-btn";
      copyBtn.textContent = "Copy";
      copyBtn.title = "Copy this message and mark as contacted";
      copyBtn.addEventListener("click", async () => {
        copyBtn.disabled = true;
        const prevLabel = copyBtn.textContent;
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = "Copied";
          await onCopyDraft(text);
        } finally {
          setTimeout(() => {
            copyBtn.textContent = prevLabel;
            copyBtn.disabled = false;
          }, 1500);
        }
      });
      bubble.appendChild(copyBtn);
    }
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
    if (!(await askConfirm("Clear this conversation? This can't be undone.", { okLabel: "Clear conversation", cancelLabel: "Keep it", danger: true }))) return;
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
  buildSystemPrompt: () => buildAccountScopedMentorPrompt(currentAccountCompanyRow(), { mentorPersona: currentSettingsCache.mentorPersona, companyContext: currentSettingsCache.companyContext, idealCustomerProfile: currentSettingsCache.idealCustomerProfile, userProfile: currentSettingsCache.userProfile, outputLanguage: currentSettingsCache.outputLanguage }),
  historyEl: document.getElementById("account-mentor-history"),
  statusEl: document.getElementById("account-mentor-status"),
  inputEl: document.getElementById("account-mentor-input"),
  sendBtn: document.getElementById("account-mentor-send-btn"),
  clearBtn: document.getElementById("account-mentor-clear-btn"),
  getHistoryFn: async () => (await getTargetAccountExtra(currentAccountKey)).mentorHistory,
  saveHistoryFn: (history) => saveTargetAccountExtra(currentAccountKey, { mentorHistory: history }),
  label: "Account Mentor",
  getRelatedKeys: () => ({ relatedCompanyKey: currentAccountKey }),
  onCopyDraft: async () => {
    const changed = await advanceManualStatus(getTargetAccountExtra, saveTargetAccountExtra, currentAccountKey, "Contacted");
    if (!changed) return;
    const company = currentAccountCompanyRow();
    appendActivityLog({
      actor: "user",
      action: "target_account_status_changed",
      label: `"${company.company || currentAccountKey}" status auto-changed to Contacted (mentor message copied)`,
      newValue: "Contacted",
      relatedCompanyKey: currentAccountKey,
    });
    await loadWorkbook();
    await renderAccountView(currentAccountKey);
  },
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
  buildSystemPrompt: () => buildContactScopedMentorPrompt(currentContactRow(), currentContactAccountRow(), { mentorPersona: currentSettingsCache.mentorPersona, companyContext: currentSettingsCache.companyContext, idealCustomerProfile: currentSettingsCache.idealCustomerProfile, userProfile: currentSettingsCache.userProfile, outputLanguage: currentSettingsCache.outputLanguage }),
  historyEl: document.getElementById("contact-mentor-history"),
  statusEl: document.getElementById("contact-mentor-status"),
  inputEl: document.getElementById("contact-mentor-input"),
  sendBtn: document.getElementById("contact-mentor-send-btn"),
  clearBtn: document.getElementById("contact-mentor-clear-btn"),
  getHistoryFn: async () => (await getTargetContactExtra(currentContactKey)).mentorHistory,
  saveHistoryFn: (history) => saveTargetContactExtra(currentContactKey, { mentorHistory: history }),
  label: "Contact Mentor",
  getRelatedKeys: () => ({ relatedContactKey: currentContactKey }),
  onCopyDraft: async () => {
    const changed = await advanceManualStatus(getTargetContactExtra, saveTargetContactExtra, currentContactKey, "Contacted");
    if (!changed) return;
    const contact = currentContactRow();
    appendActivityLog({
      actor: "user",
      action: "target_contact_status_changed",
      label: `"${contact.fullName || currentContactKey}" status auto-changed to Contacted (mentor message copied)`,
      newValue: "Contacted",
      relatedContactKey: currentContactKey,
    });
    await loadWorkbook();
    await renderContactView(currentContactKey);
  },
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
let currentSettingsCache = { mentorPersona: "", companyContext: "", idealCustomerProfile: "", customerPersona: "", userProfile: { name: "", title: "", email: "" }, outputLanguage: "english" };

async function refreshSettingsCache() {
  const [mentorPersona, companyContext, idealCustomerProfile, customerPersona, userProfile, outputLanguage] = await Promise.all([
    getMentorPersona(), getCompanyContext(), getIdealCustomerProfile(), getCustomerPersona(), getUserProfile(), getOutputLanguage(),
  ]);
  currentSettingsCache = { mentorPersona, companyContext, idealCustomerProfile, customerPersona, userProfile, outputLanguage };
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

// "Web research" card: shows the last saved research for this account (kept in the account's extras, so it is part of
// backups) and can run a new one. Several accounts can be researched at the same time (up to 3).
const webResearchRunning = new Map(); // account key -> { startedAt, controller }
const WEB_RESEARCH_MAX_PARALLEL = 3;

function formatUsd(n) {
  return n < 0.005 ? "less than $0.01" : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(2)}`;
}

// [{key, label, found, current, state: "new" | "different", dismissed}] for this account (the comparison
// itself is in web-research-apply.js; `dismissed` is this page's own "Keep mine" marker). `data` is passed
// in because a research that has just finished is not in accountExtras yet.
function computeFindingProposals(companyKey, data) {
  const company = workbook.companies.find((c) => normalizeCompanyName(c.company) === companyKey) || {};
  const extra = accountExtras[companyKey];
  return computeProposalsFor(company, extra?.overrides, data, moneySettings)
    .map((p) => ({ ...p, dismissed: isDismissedFinding(extra?.webFindingsDismissed, p) }));
}

function openFindings(proposals) {
  return proposals.filter((p) => !p.dismissed);
}

// ---- Resolving web findings automatically ----
// After researching the whole universe, 257 of 541 accounts had at least one finding that "differed"
// from stored data. Almost none of those are errors: Glencore stored 84,146 against a found 150,000 is
// direct employees versus employees-and-contractors, both correct, both "5001+", so whichever wins
// changes no score anywhere. The rules themselves live in web-findings-arbitration.js (pure, and the
// one place that knows what each rule means); this page supplies the account context and the preview,
// and writes the result through bulkPatchExtras.

const autoFindingsEl = (id) => document.getElementById(id);
let lastArbitration = null;

// Named, never numbered. A number is only meaningful while the list is complete and unchanged -
// drop a rule later and every remaining number either shifts or leaves a hole, and the Activity Log
// entries written before the change stop meaning what they say.
function ruleLabel(id) {
  const r = ARBITRATION_RULES.find((x) => x.id === Number(id));
  return r ? r.label : "an unknown rule";
}

// Everything the rules need about one account that is not in the finding itself. Both the illogical
// checks and rules 4-7 are cross-field ("0 employees, but it has revenue"; "does this country move
// the location priority?"), so the effective row - stored data with the account's own overrides on
// top, exactly what the table shows - is what gets handed over, never the bare workbook row.
function arbitrationCtxFor(company, extra, { buckets, locationTier, contactCounts }) {
  const effective = { ...company, ...(extra?.overrides || {}) };
  const revenue = Number(effective.globalRevenue);
  return {
    buckets,
    locationTier,
    effective,
    hasRevenue: Number.isFinite(revenue) && revenue > 0,
    contactCount: contactCounts.get(company.companyId) || 0,
    // A LinkedIn-fetched count is the company's own published size band - not an exact headcount, but
    // the most trustworthy thing there is for deciding which band it belongs in.
    employeesFromLinkedin: Boolean(company.employeeCountText) || company.source === "Discovered",
  };
}

// A dry run over every researched account. Writes nothing - the dialog renders this, and the same
// result object is what the Resolve button then commits.
async function computeAutoArbitration() {
  const settings = await getWebFindingsArbitration();
  const config = await getTargetUniverseConfig();
  const locationTier = (country) => resolveLocationPriority(country, config.locationPriorities);
  const contactCounts = new Map();
  for (const c of workbook.contacts) {
    if (!c.companyId) continue;
    contactCounts.set(c.companyId, (contactCounts.get(c.companyId) || 0) + 1);
  }
  const perAccount = [];
  const patchByKey = {};
  // Findings the research itself already took, before arbitration ever saw them: with "Fill in empty
  // fields automatically" ticked, bulk-research.js writes every empty-field finding straight into
  // overrides as it goes. That is rule 1's job, done during the run - which is why rule 1 reads zero
  // here on a dataset researched with autofill on, and why it is worth showing rather than leaving
  // the user to wonder where those values came from.
  let autofilled = 0;
  let autofilledAccounts = 0;
  for (const company of workbook.companies) {
    const key = normalizeCompanyName(company.company);
    const extra = accountExtras[key];
    if (!extra?.webResearch) continue;
    const data = extra.webResearch.data;
    const overrides = extra.overrides || {};
    let tookHere = 0;
    for (const f of WEB_FINDING_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(overrides, f.key)) continue;
      const found = data ? f.from(data) : null;
      if (isBlankFinding(found)) continue;
      if (findingValuesMatch(overrides[f.key], found)) tookHere++;
    }
    if (tookHere > 0) { autofilled += tookHere; autofilledAccounts++; }
    const proposals = annotatedProposals(company, extra);
    if (proposals.length === 0) continue;
    const ctx = arbitrationCtxFor(company, extra, { buckets: SIZE_PRIORITY_BUCKETS, locationTier, contactCounts });
    const { decisions, patch } = arbitrateAccount({ proposals, extra, ctx, settings });
    if (decisions.length === 0) continue;
    perAccount.push({ key, name: company.company, decisions });
    if (patch) patchByKey[key] = patch;
  }
  return { settings, perAccount, patchByKey, autofilled, autofilledAccounts, counts: summarizeArbitration(perAccount) };
}

function renderAutoFindingsPreview(result) {
  const { counts, perAccount, autofilled, autofilledAccounts } = result;
  const total = counts.applied + counts.dismissed + counts.review;
  // No prose summary: the table carries its own totals, which is both shorter and harder to
  // misread than a sentence restating them.
  autoFindingsEl("auto-findings-summary").textContent = total === 0
    ? "There are no open findings left to resolve."
    : "";

  const table = autoFindingsEl("auto-findings-breakdown");
  table.innerHTML = "";
  const row = (cells, className) => {
    const tr = document.createElement("tr");
    if (className) tr.className = className;
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    table.appendChild(tr);
    return tr;
  };

  const head = document.createElement("tr");
  for (const h of ["Rule", "Takes the web value", "Keeps current", "Asks you"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  table.appendChild(head);

  // EVERY rule, always, including the ones with nothing to do - a rule that silently vanishes from
  // the table reads as a rule that is missing rather than a rule with no work.
  for (const rule of ARBITRATION_RULES) {
    const b = counts.byRule[rule.id] || { apply: 0, dismiss: 0, review: 0 };
    row([ruleLabel(rule.id), String(b.apply), String(b.dismiss), String(b.review)]);
  }
  row([
    `Total \u2014 ${total} finding${total === 1 ? "" : "s"} on ${perAccount.length} account${perAccount.length === 1 ? "" : "s"}`,
    String(counts.applied),
    String(counts.dismissed),
    String(counts.review),
  ], "auto-findings-total-row");
  if (autofilled > 0) {
    row([
      `Already taken from the web during the research, before these rules ran (\u201cFill in empty fields automatically\u201d) \u2014 on ${autofilledAccounts} account${autofilledAccounts === 1 ? "" : "s"}`,
      String(autofilled),
      "0",
      "0",
    ], "auto-findings-note-row");
  }

  // A sample rather than all of them: at 500+ findings a full list is unreadable and slow to build,
  // and the Activity Log gets the complete record anyway once the run happens.
  const changing = [];
  for (const account of perAccount) {
    for (const d of account.decisions) {
      if (d.action === "review") continue;
      changing.push({ account: account.name, ...d });
      if (changing.length >= 40) break;
    }
    if (changing.length >= 40) break;
  }
  const wrap = autoFindingsEl("auto-findings-examples-wrap");
  const ex = autoFindingsEl("auto-findings-examples");
  wrap.hidden = changing.length === 0;
  wrap.open = false;
  ex.innerHTML = "";
  if (changing.length > 0) {
    const exHead = document.createElement("tr");
    for (const h of ["Account", "Field", "Outcome", "Why"]) {
      const th = document.createElement("th");
      th.textContent = h;
      exHead.appendChild(th);
    }
    ex.appendChild(exHead);
    const show = (v) => (v === null || v === undefined || v === "" ? "(empty)" : typeof v === "number" ? formatNumber(v) : String(v));
    for (const c of changing) {
      const tr = document.createElement("tr");
      const outcome = c.action === "apply"
        ? `takes ${show(c.proposal.found)}, over the current ${show(c.proposal.current)}`
        : `keeps the current ${show(c.proposal.current)}, over ${show(c.proposal.found)}`;
      for (const text of [c.account, c.proposal.label, outcome, c.why]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      ex.appendChild(tr);
    }
  }

  const settleNow = counts.applied + counts.dismissed;
  autoFindingsEl("auto-findings-run-btn").disabled = settleNow === 0;
  // Spelled out next to the button, not only in the paragraph at the top - what it will do and
  // whether it can be taken back are the two things worth knowing at the moment of pressing it.
  autoFindingsEl("auto-findings-button-note").textContent = settleNow === 0
    ? "Nothing can be settled automatically right now."
    : `Settles ${settleNow} finding${settleNow === 1 ? "" : "s"} in one go and leaves ${counts.review} for you to review by hand. You are asked to confirm first, and it has its own one-click undo afterwards.`;
}

async function openAutoFindingsDialog() {
  autoFindingsEl("auto-findings-status").textContent = "Working out what can be settled automatically…";
  autoFindingsEl("auto-findings-summary").textContent = "";
  autoFindingsEl("auto-findings-breakdown").innerHTML = "";
  autoFindingsEl("auto-findings-examples-wrap").hidden = true;
  autoFindingsEl("auto-findings-run-btn").disabled = true;
  const undoBtn = autoFindingsEl("auto-findings-undo-btn");
  // This dialog's own undo slot - a Bulk edit in between no longer destroys it.
  const record = await getLastBulkExtrasChange("webFindings");
  undoBtn.hidden = !record;
  if (record) {
    const count = Object.keys(record.previous || {}).length;
    undoBtn.textContent = `Undo the last automatic resolve (${count} account${count === 1 ? "" : "s"})`;
  }
  autoFindingsEl("auto-findings-dialog").showModal();
  lastArbitration = await computeAutoArbitration();
  renderAutoFindingsPreview(lastArbitration);
  autoFindingsEl("auto-findings-status").textContent = "";
}

async function runAutoArbitration() {
  if (!lastArbitration) return;
  const { patchByKey, perAccount, counts } = lastArbitration;
  const keys = Object.keys(patchByKey);
  if (keys.length === 0) return;
  // An explicit confirm even though the whole dialog is a preview: "Resolve them" was read as
  // "let me review them one by one" and pressed, which wrote 327 decisions in one click. The
  // preview is not a confirmation if the button next to it does not say what it is about to do.
  if (!(await askConfirm(
    `${counts.applied + counts.dismissed} findings will be settled automatically now, and ${counts.review} will be left for you to review by hand.\n\n` +
    `SETTLED NOW (${counts.applied + counts.dismissed}):\n` +
    `\u2022 ${counts.applied} will take the value found on the web, replacing what the account holds\n` +
    `\u2022 ${counts.dismissed} will keep the account's current value and stop asking about it\n\n` +
    `LEFT FOR YOU (${counts.review}):\n` +
    "\u2022 nothing is written to these. They stay on the Accounts table - filter the Web Findings " +
    "column on \"review\" and work through them one account at a time.\n\n" +
    "REVERSIBLE: yes. Undo appears on this dialog straight afterwards and puts every one of them " +
    "back in a single click. It has its own undo, so editing accounts in the meantime will not " +
    "take it away - only running this again replaces it. Every decision is also written to the " +
    "Activity Log, with the account, the field, the value that won and the rule that decided it.\n\n" +
    "Proceed?",
    { okLabel: "Proceed", cancelLabel: "Cancel" }
  ))) return;
  autoFindingsEl("auto-findings-status").textContent = "Saving…";
  const changed = await bulkPatchExtras("accounts", patchByKey, "webFindings");

  // One Activity Log line per settled finding, naming the account, the field, the value that won and
  // the rule that decided it. This is the only way a wrong pattern is ever noticeable - without it the
  // mechanism is invisible and nobody would know to open its settings at all. appendActivityLogBatch,
  // never appendActivityLog in a loop: the single-entry version reads the WHOLE local store per call.
  const entries = [];
  for (const account of perAccount) {
    for (const d of account.decisions) {
      if (d.action === "review") continue;
      const outcome = d.action === "apply"
        ? `took the web value ${d.proposal.found}`
        : `kept the current value ${d.proposal.current === null ? "(empty)" : d.proposal.current}`;
      entries.push({
        actor: "extension",
        action: "web_finding_auto_resolved",
        label: `${account.name} - ${d.proposal.label}: ${outcome} (${ruleLabel(d.rule)}: ${d.why})`,
        prevValue: d.proposal.current === undefined ? null : d.proposal.current,
        newValue: d.action === "apply" ? d.proposal.found : d.proposal.current,
        relatedCompanyKey: account.key,
      });
    }
  }
  entries.push({
    actor: "user",
    action: "web_findings_auto_resolve_run",
    label: `Resolved web findings automatically on ${changed} account${changed === 1 ? "" : "s"}: took the web value on ${counts.applied}, kept the current data on ${counts.dismissed}, left ${counts.review} to review`,
  });
  await appendActivityLogBatch(entries);

  // The dialog stays open afterwards, showing the Undo button. Closing it on success is what hid
  // Undo the first time this ran: the button is only shown when a previous bulk change exists, and
  // that is read when the dialog OPENS - so straight after a run it was correct and invisible.
  await loadWorkbook();
  rerenderForScope("accounts");
  const settled = counts.applied + counts.dismissed;
  lastArbitration = await computeAutoArbitration();
  renderAutoFindingsPreview(lastArbitration);
  const undoBtn = autoFindingsEl("auto-findings-undo-btn");
  undoBtn.hidden = false;
  undoBtn.textContent = `Undo this - put back all ${changed} account${changed === 1 ? "" : "s"}`;
  autoFindingsEl("auto-findings-run-btn").disabled = true;
  autoFindingsEl("auto-findings-status").textContent =
    `Done - ${settled} finding${settled === 1 ? "" : "s"} settled across ${changed} account${changed === 1 ? "" : "s"}. ` +
    `${counts.review} left for you to decide: filter the Web Findings column on "review". ` +
    "Every decision is in the Activity Log. Changed your mind? Undo is right here, and stays here until the next automatic resolve.";
}

document.getElementById("auto-findings-page-btn").addEventListener("click", openAutoFindingsDialog);
document.getElementById("auto-findings-run-btn").addEventListener("click", runAutoArbitration);
document.getElementById("auto-findings-undo-btn").addEventListener("click", async () => {
  const restored = await undoLastBulkExtrasChange("webFindings");
  autoFindingsEl("auto-findings-undo-btn").hidden = true;
  autoFindingsEl("auto-findings-status").textContent = `Undone - ${restored} account${restored === 1 ? "" : "s"} put back.`;
  appendActivityLog({ actor: "user", action: "web_findings_auto_resolve_undone", label: `Undid the last automatic resolve of web findings (${restored} accounts)` });
  await loadWorkbook();
  rerenderForScope("accounts");
  lastArbitration = await computeAutoArbitration();
  renderAutoFindingsPreview(lastArbitration);
});

function webResearchRunningText(companyKey) {
  const seconds = Math.round((Date.now() - webResearchRunning.get(companyKey).startedAt) / 1000);
  return `Researching on the web… ${seconds} s so far (usually under a minute, at most 4 minutes). Press Stop to end it and keep what was found.`;
}

function renderWebResearchCard(companyKey) {
  const $ = (id) => document.getElementById(id);
  const btn = $("account-web-research-btn");
  const stopBtn = $("account-web-research-stop-btn");
  const running = webResearchRunning.has(companyKey);
  const inBulk = bulkRunningKeys.has(companyKey);
  const busy = running || inBulk;
  stopBtn.hidden = !running;
  btn.disabled = busy;
  const saved = accountExtras[companyKey]?.webResearch || null;
  const textEl = $("account-web-research-text");
  const moreBtn = $("account-web-research-more-btn");
  const sourcesDetails = $("account-web-research-sources-details");
  const applyRow = $("account-web-research-apply-row");
  $("account-web-research-sources").innerHTML = "";
  applyRow.hidden = true;
  if (busy) {
    $("account-web-research-hint").textContent = running ? webResearchRunningText(companyKey) : "Being researched right now as part of the web research of many accounts (see the bar at the top).";
    btn.textContent = "Researching…";
  }
  if (!saved) {
    if (!busy) $("account-web-research-hint").textContent = "Not done yet for this account.";
    textEl.hidden = true;
    moreBtn.hidden = true;
    sourcesDetails.hidden = true;
    if (!busy) btn.textContent = "Research this account on the web…";
    return;
  }
  if (!busy) {
    $("account-web-research-hint").textContent = `Researched ${formatDateTime(saved.at)}${saved.stopped ? " (stopped early)" : ""} - ${saved.searches} web search${saved.searches === 1 ? "" : "es"}${saved.costUsd != null ? `, about ${formatUsd(saved.costUsd)}` : ""}. Check the sources before relying on it.`;
    btn.textContent = "Research again…";
  }
  textEl.textContent = saved.text;
  textEl.hidden = false;
  const long = saved.text.length > 700;
  textEl.classList.toggle("clamped", long);
  moreBtn.hidden = !long;
  moreBtn.textContent = "Show the full briefing";
  moreBtn.onclick = () => {
    const clamped = textEl.classList.toggle("clamped");
    moreBtn.textContent = clamped ? "Show the full briefing" : "Show less";
  };
  const sources = saved.sources || [];
  sourcesDetails.hidden = sources.length === 0;
  sourcesDetails.open = false;
  $("account-web-research-sources-summary").textContent = `Sources (${sources.length})`;
  for (const s of sources) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = s.title || s.url;
    li.appendChild(a);
    $("account-web-research-sources").appendChild(li);
  }
  const proposals = computeFindingProposals(companyKey, saved.data);
  if (proposals.length > 0) {
    const open = openFindings(proposals);
    const fresh = open.filter((p) => p.state === "new").length;
    applyRow.hidden = false;
    $("account-web-research-apply-hint").textContent = open.length > 0
      ? `${open.length} finding${open.length === 1 ? "" : "s"} could update this account${fresh ? ` (${fresh} fill empty fields)` : ""}.`
      : `Nothing left to review - you chose to keep your own value for ${proposals.length === 1 ? "the one finding" : `all ${proposals.length} findings`}.`;
  }
}

document.getElementById("account-web-research-stop-btn").addEventListener("click", () => {
  const run = webResearchRunning.get(currentAccountKey);
  if (run) {
    document.getElementById("account-web-research-hint").textContent = "Stopping - saving what has been found so far…";
    run.controller.abort();
  }
});

document.getElementById("account-web-research-btn").addEventListener("click", async () => {
  const companyKey = currentAccountKey;
  const company = currentAccountCompanyRow();
  if (!companyKey || !company.company) return;
  if (webResearchRunning.has(companyKey)) return;
  const statusEl = document.getElementById("account-web-research-status");
  if (!(await askConfirm(
    `Search the public web for "${company.company}"?\n\nThe search runs on Anthropic's servers with your own API key: several web searches plus the AI's reading of them, which costs a small amount. It can take up to a minute (at most 4 minutes) and you can press Stop at any time to keep what was found so far. No LinkedIn activity is used. The result is saved on this account with its sources, and any initiatives found are added to its Initiatives list.`,
    { okLabel: "Search the web", cancelLabel: "Cancel" }))) return;
  if (webResearchRunning.size >= WEB_RESEARCH_MAX_PARALLEL) {
    await askConfirm(`${webResearchRunning.size} researches are already running. Please wait for one to finish before starting another.`, { okLabel: "OK", cancelLabel: "Close" });
    return;
  }
  const controller = new AbortController();
  webResearchRunning.set(companyKey, { startedAt: Date.now(), controller });
  renderWebResearchCard(companyKey);
  const ticker = setInterval(() => {
    if (webResearchRunning.has(companyKey) && currentAccountKey === companyKey && !controller.signal.aborted) {
      document.getElementById("account-web-research-hint").textContent = webResearchRunningText(companyKey);
    }
  }, 1000);
  statusEl.textContent = `Researching "${company.company}" on the web (this can take up to a minute)…`;
  try {
    const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
    const config = await getTargetUniverseConfig();
    const result = await researchAccountOnWeb(company, {
      apiKey,
      companyContext: currentSettingsCache.companyContext,
      idealCustomerProfile: currentSettingsCache.idealCustomerProfile,
      outputLanguage: currentSettingsCache.outputLanguage,
      targetCountries: config.countries || [],
    }, { onStatus: (message) => { statusEl.textContent = message; }, signal: controller.signal });
    await saveTargetAccountExtra(companyKey, { webResearch: { text: result.text, sources: result.sources, searches: result.searches, at: Date.now(), data: result.data || null, stopped: result.stopped, costUsd: result.costUsd } });
    const initiativesAdded = await addWebResearchInitiatives(company.companyId, company.company, result.data?.initiatives);
    await loadWorkbook();
    webResearchRunning.delete(companyKey);
    if (currentAccountKey === companyKey) await renderAccountView(companyKey);
    const proposals = openFindings(computeFindingProposals(companyKey, result.data));
    appendActivityLog({ actor: "user", action: "account_web_research", label: `Web research for "${company.company}": ${result.sources.length} sources, ${result.searches} searches, ${initiativesAdded} initiatives added${result.stopped ? " (stopped early)" : ""}`, relatedCompanyKey: companyKey });
    statusEl.textContent = `Done - web research for "${company.company}" saved on this account${result.stopped ? " (stopped early - partial result)" : ""}: ${result.sources.length} source${result.sources.length === 1 ? "" : "s"}, ${initiativesAdded} initiative${initiativesAdded === 1 ? "" : "s"} added to its Initiatives list. Estimated cost: ${formatUsd(result.costUsd)}.` +
      (proposals.length > 0 ? ` ${proposals.length} finding${proposals.length === 1 ? "" : "s"} can update the account's data - use "Review findings…".` : "");
  } catch (err) {
    statusEl.textContent = `Something went wrong: ${err.message}`;
  } finally {
    clearInterval(ticker);
    webResearchRunning.delete(companyKey);
    if (currentAccountKey === companyKey) renderWebResearchCard(companyKey);
  }
});

// ---- Research many accounts on the web in one go ----
// The run itself is done by the extension's background worker (bulk-research.js), so it goes on whichever page is open. This
// page only chooses the accounts, shows the estimate and starts it; batch-status.js shows the progress everywhere.
const BULK_WORKERS = 4; // must match WORKERS in bulk-research.js
// Roughly how long one account takes one worker. Measured at ~18s across a 84-account run; the old
// estimate assumed 60s and overstated a large run by more than 3x.
const BULK_SECONDS_PER_ACCOUNT = 20;
const BULK_DEFAULT_FULL_USD = 0.12; // used until SalesTeam has real research costs of its own to average
const BULK_MISSING_FACTOR = 0.6;
let bulkRunningKeys = new Set(); // accounts the background run is researching right now

const BULK_TOPICS = {
  employees: { label: "employees", missing: (e) => isBlankFinding(e.globalEmployees) || isBlankFinding(e.swissEmployees) },
  revenue: { label: "revenue", missing: (e) => isBlankFinding(e.globalRevenue) || isBlankFinding(e.swissRevenue) },
  headquarters: { label: "headquarters (city and country)", missing: (e) => isBlankFinding(e.globalHqCity) || isBlankFinding(e.globalHqCountry) },
  registry: { label: "official registry data (legal name, ID, address)", missing: (e) => isBlankFinding(e.zefixUid) || isBlankFinding(e.zefixOfficialName) || isBlankFinding(e.zefixAddress) },
  initiatives: { label: "recent initiatives and news", missing: (e, c) => !(workbook.aiInitiatives || []).some((i) => i.companyId === c.companyId) },
};

function bulkAccountPriority(company) {
  const p = accountExtras[normalizeCompanyName(company.company)]?.overrides?.salesTeamPriority || company.salesTeamPriority;
  return ["P1", "P2", "P3", "P4", "P5"].includes(p) ? p : "none";
}

// The accounts the dialog's current choices would research, with the topics each one needs.
function bulkSelection() {
  const dlg = document.getElementById("bulk-research-dialog");
  const priorities = new Set([...dlg.querySelectorAll(".bulk-priority:checked")].map((c) => c.value));
  const topics = [...dlg.querySelectorAll(".bulk-topic:checked")].map((c) => c.value);
  const onlyMissing = document.getElementById("bulk-mode-missing").checked;
  const skipDone = document.getElementById("bulk-skip-done").checked;
  const items = [];
  for (const company of workbook.companies) {
    const key = normalizeCompanyName(company.company);
    if (!key || webResearchRunning.has(key)) continue;
    if (!priorities.has(bulkAccountPriority(company))) continue;
    if (skipDone && accountExtras[key]?.webResearch) continue;
    const effective = { ...company, ...(accountExtras[key]?.overrides || {}) };
    if (onlyMissing) {
      const needed = topics.filter((t) => BULK_TOPICS[t].missing(effective, company));
      if (needed.length === 0) continue;
      items.push({ key, onlyTopics: needed.map((t) => BULK_TOPICS[t].label) });
    } else {
      items.push({ key, onlyTopics: null });
    }
  }
  // "Research at most N accounts" - capped here, so the estimate, the summary and the start button
  // all work from the same list. The workbook order is kept, so the cap takes the first N matches.
  const matched = items.length;
  const cap = Number(document.getElementById("bulk-max-accounts")?.value) || 0;
  const capped = cap > 0 ? items.slice(0, cap) : items;
  return { items: capped, topics, onlyMissing, matched, capApplied: capped.length < matched };
}

async function bulkPerAccountUsd() {
  const usage = await getApiUsage();
  const all = sumDays(usage, Object.keys(usage)).webResearch;
  return all.calls >= 3 ? all.usd / all.calls : BULK_DEFAULT_FULL_USD;
}

function bulkEstimate(items, each) {
  return items.reduce((sum, it) => sum + each * (it.onlyTopics ? BULK_MISSING_FACTOR : 1), 0);
}

// How many of these accounts a cost limit actually pays for. Accounts are not all the same price
// (an "only what is missing" account costs less), so this walks the list in the order it will run
// rather than dividing the budget by an average.
function bulkAccountsWithinBudget(items, each, budget) {
  let spent = 0;
  for (let i = 0; i < items.length; i++) {
    spent += each * (items[i].onlyTopics ? BULK_MISSING_FACTOR : 1);
    if (spent > budget) return i;
  }
  return items.length;
}

async function refreshBulkSummary() {
  const { items, onlyMissing, topics, matched, capApplied } = bulkSelection();
  const each = await bulkPerAccountUsd();
  const estimate = bulkEstimate(items, each);
  const el = document.getElementById("bulk-research-summary");
  const budget = document.getElementById("bulk-budget-input");
  if (!budget.dataset.touched) budget.value = String(Math.max(0.5, Math.ceil(estimate * 1.5 * 2) / 2));
  const running = await getRunningBatch();
  document.getElementById("bulk-research-start-btn").disabled = items.length === 0 || (onlyMissing && topics.length === 0) || !!running;
  if (running) el.textContent = busyMessage(running, "web research of these accounts").replace(/\n\n/g, " ");
  else if (onlyMissing && topics.length === 0) el.textContent = "Tick at least one thing to look for.";
  else if (items.length === 0) el.textContent = "No accounts match these choices.";
  else {
    const minutes = Math.max(1, Math.round(items.length / BULK_WORKERS * BULK_SECONDS_PER_ACCOUNT / 60));
    // What the cost limit means in accounts - the thing the dollar figure alone does not tell you.
    const limit = Number(budget.value) || 0;
    const reach = limit > 0 ? bulkAccountsWithinBudget(items, each, limit) : items.length;
    const budgetReach = limit <= 0 ? ""
      : reach >= items.length ? `\n\nYour limit of ${formatUsd(limit)} covers all ${items.length} of them.`
      : `\n\nYour limit of ${formatUsd(limit)} covers only about ${reach} of them - the rest would be left for a later run. Raise the limit, or use "at most" to pick a smaller set on purpose.`;
    el.textContent = `${items.length} account${items.length === 1 ? "" : "s"} selected` +
      `${capApplied ? ` (of ${matched} matching - limited by "at most")` : ""}. Estimated cost: about ${formatUsd(estimate)} ` +
      `(up to about ${formatUsd(estimate * 1.5)}), taking roughly ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
      "Based on " + (each === BULK_DEFAULT_FULL_USD ? "a typical research" : "what your earlier researches cost") + "; the real cost is shown while it runs." +
      budgetReach;
  }
}

for (const el of document.querySelectorAll("#bulk-research-dialog input")) {
  el.addEventListener("change", () => { if (el.id === "bulk-budget-input") el.dataset.touched = "1"; refreshBulkSummary(); });
}
// refreshBulkSummary on every keystroke, not just on blur: the summary now says how many accounts
// the limit pays for, which is the whole point of typing a number in here.
document.getElementById("bulk-budget-input").addEventListener("input", (e) => { e.target.dataset.touched = "1"; refreshBulkSummary(); });
document.getElementById("bulk-max-accounts").addEventListener("input", () => { refreshBulkSummary(); saveBulkPrefs(); });
// The choices in the dialog are remembered, so a start that is refused (another batch is running) or a later visit
// does not make the user fill them in again.
const BULK_PREFS_KEY = "bulkResearchPrefs";
async function saveBulkPrefs() {
  const dlg = document.getElementById("bulk-research-dialog");
  const budget = document.getElementById("bulk-budget-input");
  await chrome.storage.local.set({ [BULK_PREFS_KEY]: {
    priorities: [...dlg.querySelectorAll(".bulk-priority:checked")].map((c) => c.value),
    topics: [...dlg.querySelectorAll(".bulk-topic:checked")].map((c) => c.value),
    skipDone: document.getElementById("bulk-skip-done").checked,
    onlyMissing: document.getElementById("bulk-mode-missing").checked,
    autofill: document.getElementById("bulk-autofill").checked,
    budget: budget.dataset.touched ? budget.value : null,
    maxAccounts: document.getElementById("bulk-max-accounts").value || null,
  } });
}
async function loadBulkPrefs() {
  const p = (await chrome.storage.local.get(BULK_PREFS_KEY))[BULK_PREFS_KEY];
  const dlg = document.getElementById("bulk-research-dialog");
  const budget = document.getElementById("bulk-budget-input");
  budget.dataset.touched = "";
  if (!p) return;
  dlg.querySelectorAll(".bulk-priority").forEach((c) => { c.checked = p.priorities.includes(c.value); });
  dlg.querySelectorAll(".bulk-topic").forEach((c) => { c.checked = p.topics.includes(c.value); });
  document.getElementById("bulk-skip-done").checked = p.skipDone;
  document.getElementById("bulk-mode-missing").checked = p.onlyMissing;
  document.getElementById("bulk-mode-all").checked = !p.onlyMissing;
  document.getElementById("bulk-autofill").checked = p.autofill;
  if (p.budget) { budget.value = p.budget; budget.dataset.touched = "1"; }
  document.getElementById("bulk-max-accounts").value = p.maxAccounts || "";
}
for (const el of document.querySelectorAll("#bulk-research-dialog input")) el.addEventListener("change", () => saveBulkPrefs());
document.getElementById("bulk-budget-input").addEventListener("input", () => saveBulkPrefs());

document.getElementById("bulk-research-page-btn").addEventListener("click", async () => {
  // opens even while another batch is running, so the choices can be prepared; Start is disabled (and explained) until it is free
  await loadBulkPrefs();
  await refreshBulkSummary();
  document.getElementById("bulk-research-dialog").showModal();
});

document.getElementById("bulk-research-start-btn").addEventListener("click", async () => {
  const { items } = bulkSelection();
  if (items.length === 0) return;
  if (!(await guardBatchStart("web research of many accounts", askConfirm))) { await refreshBulkSummary(); return; } // the dialog and its choices stay as they are
  const estimate = bulkEstimate(items, await bulkPerAccountUsd());
  const budget = Number(document.getElementById("bulk-budget-input").value) || 0;
  const limit = await getCostWarningUsd();
  const overLimit = limit > 0 && estimate >= limit;
  if (!(await askConfirm(
    `Research ${items.length} account${items.length === 1 ? "" : "s"} on the web?\n\n` +
    `Estimated cost: about ${formatUsd(estimate)} on your Anthropic API key (up to about ${formatUsd(estimate * 1.5)}).` +
    (overLimit ? ` This is more than your warning limit of ${formatUsd(limit)} (Settings > Billing).` : "") +
    (budget > 0 ? `\nIt stops by itself when the cost reaches ${formatUsd(budget)}.` : "") +
    "\n\nIt runs in the background: you can move to any other SalesTeam page and keep working. A bar at the top shows the progress and has a Stop button; everything found so far is kept, and a pop-up tells you when it is finished.",
    { okLabel: "Start", cancelLabel: "Cancel" }))) return;
  const reply = await chrome.runtime.sendMessage({ type: "BULK_WEB_RESEARCH_START", items, budget, autofill: document.getElementById("bulk-autofill").checked }).catch((err) => ({ ok: false, error: err.message }));
  if (!reply?.ok) {
    await askConfirm(reply?.error || "The web research could not be started.", { okLabel: "OK", cancelLabel: "Close" });
    return;
  }
  document.getElementById("bulk-research-dialog").close();
  appendActivityLog({ actor: "user", action: "bulk_web_research_started", label: `Started web research for ${items.length} accounts` });
});

// Keeps this page's data and account card current while the background run works.
let bulkLastStatus = null;
async function onBulkStateChange(state) {
  const previous = bulkRunningKeys;
  bulkRunningKeys = new Set(state?.status === "running" ? state.runningKeys || [] : []);
  const ended = bulkLastStatus === "running" && state?.status === "done";
  bulkLastStatus = state?.status || null;
  if (document.getElementById("bulk-research-dialog").open) refreshBulkSummary();
  const finishedCurrent = currentAccountKey && previous.has(currentAccountKey) && !bulkRunningKeys.has(currentAccountKey);
  if (finishedCurrent || ended) await loadWorkbook();
  if (currentAccountKey && (finishedCurrent || ended || previous.has(currentAccountKey) !== bulkRunningKeys.has(currentAccountKey))) {
    await renderAccountView(currentAccountKey);
  }
}

// "Review findings…": the researched facts side by side with what the account already has. Empty fields are ticked for
// "Use it", values that differ are not - existing data is only replaced when the user ticks it. Saved values are kept as
// the account's own edits, so they survive a later re-import of the research workbook. "Keep mine" is the other half:
// it records the turned-down value so the Web Findings column stops counting the finding (see isDismissedFinding).
document.getElementById("account-web-research-apply-btn").addEventListener("click", () => {
  const companyKey = currentAccountKey;
  const saved = accountExtras[companyKey]?.webResearch;
  const proposals = computeFindingProposals(companyKey, saved?.data);
  const table = document.getElementById("web-research-apply-table");
  table.innerHTML = "";
  const head = document.createElement("tr");
  for (const h of ["Use it", "Keep mine", "Field", "Found on the web", "You have now"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  table.appendChild(head);
  const show = (v) => (v === null || v === undefined ? "-" : typeof v === "number" ? formatNumber(v) : String(v));
  proposals.forEach((p, i) => {
    const tr = document.createElement("tr");
    // Two ticks per row, never both: "Use it" saves the found value, "Keep mine" records that this
    // exact finding was turned down so the Web Findings column stops counting it. A row already
    // turned down opens with "Keep mine" ticked, so it can be taken back by unticking it.
    const use = document.createElement("input");
    use.type = "checkbox";
    use.className = "finding-use";
    use.checked = p.state === "new" && !p.dismissed;
    use.dataset.index = String(i);
    const keep = document.createElement("input");
    keep.type = "checkbox";
    keep.className = "finding-keep";
    keep.checked = p.dismissed;
    keep.dataset.index = String(i);
    use.addEventListener("change", () => { if (use.checked) keep.checked = false; });
    keep.addEventListener("change", () => { if (keep.checked) use.checked = false; });
    for (const cb of [use, keep]) {
      const td = document.createElement("td");
      td.appendChild(cb);
      tr.appendChild(td);
    }
    for (const text of [p.label, show(p.found), p.state === "new" ? "(empty)" : show(p.current)]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  });
  document.getElementById("web-research-apply-status").textContent = "";
  document.getElementById("web-research-apply-confirm-btn").onclick = async () => {
    const picked = (sel) => [...table.querySelectorAll(sel)].filter((c) => c.checked).map((c) => proposals[Number(c.dataset.index)]);
    const chosen = picked("input.finding-use");
    const kept = picked("input.finding-keep");
    // Unticking a "Keep mine" on a row that was dismissed before is itself a change - it brings the
    // finding back - so an otherwise empty confirm is only "nothing to do" when nothing moved.
    const revived = proposals.filter((p) => p.dismissed && !kept.includes(p));
    if (chosen.length === 0 && kept.length === 0 && revived.length === 0) {
      document.getElementById("web-research-apply-status").textContent = "Nothing is ticked.";
      return;
    }
    const overrides = { ...(accountExtras[companyKey]?.overrides || {}) };
    for (const p of chosen) overrides[p.key] = p.found;
    const dismissed = { ...(accountExtras[companyKey]?.webFindingsDismissed || {}) };
    for (const p of chosen) delete dismissed[p.key];
    for (const p of revived) delete dismissed[p.key];
    for (const p of kept) dismissed[p.key] = p.found;
    await saveTargetAccountExtra(companyKey, { overrides, webFindingsDismissed: dismissed });
    const parts = [];
    if (chosen.length) parts.push(`saved ${chosen.map((p) => p.label).join(", ")}`);
    if (kept.length) parts.push(`kept own value for ${kept.map((p) => p.label).join(", ")}`);
    if (revived.length) parts.push(`re-opened ${revived.map((p) => p.label).join(", ")}`);
    appendActivityLog({ actor: "user", action: "account_web_findings_applied", label: `Web research findings on "${currentAccountCompanyRow().company}": ${parts.join("; ")}`, relatedCompanyKey: companyKey });
    document.getElementById("web-research-apply-dialog").close();
    await loadWorkbook();
    await renderAccountView(companyKey);
  };
  document.getElementById("web-research-apply-dialog").showModal();
});

async function renderAccountView(companyKey, { startInEdit = false } = {}) {
  if (companyKey !== currentAccountKey) accountEditMode = false;
  currentAccountKey = companyKey;
  if (startInEdit) accountEditMode = true;
  const company = currentAccountCompanyRow();
  document.getElementById("account-title").textContent = company.company || "(unknown company)";

  const companyLeads = allLeads.filter((l) => normalizeCompanyName(l.company) === companyKey);
  const accountOverrides = accountExtras[companyKey]?.overrides || {};
  const effectiveCompany = { ...company, ...accountOverrides };

  const dueDateInputEl = document.getElementById("account-due-date-input");
  const dueDateClearBtnEl = document.getElementById("account-due-date-clear-btn");
  parkDueDateControls("account-view", dueDateInputEl, dueDateClearBtnEl);
  wireDueDateInput(
    dueDateInputEl,
    dueDateClearBtnEl,
    () => getTargetAccountExtra(companyKey),
    (patch) => saveTargetAccountExtra(companyKey, patch),
    { entityLabel: company.company, relatedCompanyKey: companyKey }
  );

  const overviewEl = document.getElementById("account-overview");
  overviewEl.innerHTML = "";
  if (accountEditMode) {
    overviewEl.appendChild(buildEditForm(ACCOUNT_EDIT_FIELDS, effectiveCompany, async (formValues, newStatus) => {
      const { overrides, changedLabels } = diffEditFormValues(ACCOUNT_EDIT_FIELDS, company, accountOverrides, formValues);
      await saveTargetAccountExtra(companyKey, { overrides });
      if (newStatus !== undefined) {
        await saveTargetAccountExtra(companyKey, { manualStatus: newStatus, manualStatusAt: newStatus ? Date.now() : null });
        appendActivityLog({
          actor: "user",
          action: "target_account_status_changed",
          label: `"${company.company}" status manually ${newStatus ? `set to ${newStatus}` : "reset to auto (from leads)"}`,
          newValue: newStatus || "(auto)",
        });
      }
      if (changedLabels.length > 0) {
        appendActivityLog({
          actor: "user",
          action: "target_account_edited",
          label: `"${company.company}" edited - changed: ${changedLabels.join(", ")}`,
          relatedCompanyKey: companyKey,
        });
      }
      accountEditMode = false;
      await loadWorkbook();
      await renderAccountView(companyKey);
    }, () => {
      accountEditMode = false;
      renderAccountView(companyKey);
    }, { leadBucket: leadStatusBucket(companyLeads), manualStatus: accountExtras[companyKey]?.manualStatus || null }));
  } else {
    const accountManualStatus = accountExtras[companyKey]?.manualStatus || null;
    overviewEl.appendChild(buildOverviewCard([
      {
        label: "Status",
        node: statusFieldNode(leadStatusBucket(companyLeads), accountManualStatus, async (newStatus) => {
          await saveTargetAccountExtra(companyKey, { manualStatus: newStatus, manualStatusAt: newStatus ? Date.now() : null });
          appendActivityLog({
            actor: "user",
            action: "target_account_status_changed",
            label: `"${company.company}" status manually ${newStatus ? `set to ${newStatus}` : "reset to auto (from leads)"}`,
            newValue: newStatus || "(auto)",
          });
          await loadWorkbook();
          await renderAccountView(companyKey);
        }),
      },
      {
        label: "SalesTeam Priority",
        node: salesTeamPriorityFieldNode(
          company.salesTeamPriority,
          company.salesTeamPriorityScore,
          company.salesTeamPriorityReason,
          accountOverrides.salesTeamPriority || null,
          accountOverrides.salesTeamPriorityReason || null,
          async (newPriority, newReason) => {
            const overrides = { ...accountOverrides };
            if (newPriority) {
              overrides.salesTeamPriority = newPriority;
              overrides.salesTeamPriorityReason = newReason;
            } else {
              delete overrides.salesTeamPriority;
              delete overrides.salesTeamPriorityReason;
            }
            await saveTargetAccountExtra(companyKey, { overrides });
            appendActivityLog({
              actor: "user",
              action: "target_account_priority_overridden",
              label: newPriority
                ? `"${company.company}" SalesTeam Priority manually set to ${newPriority} (${newReason})`
                : `"${company.company}" SalesTeam Priority reset to auto (from scoring)`,
              newValue: newPriority || "(auto)",
              relatedCompanyKey: companyKey,
            });
            await loadWorkbook();
            await renderAccountView(companyKey);
          }
        ),
      },
      { label: "Source", value: effectiveCompany.source },
      { label: "Research Status", value: effectiveCompany.researchStatus },
      { label: "Official name", value: effectiveCompany.zefixOfficialName && effectiveCompany.zefixOfficialName !== effectiveCompany.company ? effectiveCompany.zefixOfficialName : null },
      { label: "Alt. name", value: effectiveCompany.alternativeCompanyName },
      { label: "LinkedIn", value: effectiveCompany.linkedinLink, link: true },
      // No distinct "company website" column exists in the source workbook -
      // this is the closest stand-in, not invented data (see PRD 6.19).
      { label: "Website (source)", value: effectiveCompany.primarySourceUrl, link: true },
      { label: "Industry", value: effectiveCompany.industry },
      { label: "Address", value: effectiveCompany.zefixAddress },
      { label: "Employees (Global)", value: formatNumber(effectiveCompany.globalEmployees) },
      { label: "Employees (Local)", value: formatNumber(effectiveCompany.swissEmployees) },
      { label: "Revenue (Global)", value: effectiveCompany.globalRevenue ? `${formatNumber(effectiveCompany.globalRevenue)} ${effectiveCompany.revenueCurrency || ""}`.trim() : null },
      { label: "Revenue (Local)", value: effectiveCompany.swissRevenue ? `${formatNumber(effectiveCompany.swissRevenue)} ${effectiveCompany.swissRevenueCurrency || ""}`.trim() : null },
      { label: "Priority", value: company.aiPriority ? `${company.aiPriority}${company.aiPriorityScore ? ` (${Math.round(company.aiPriorityScore)}/100)` : ""}` : null },
      { label: "Evidence Coverage", value: company.evidenceCoverage != null ? `${Math.round(company.evidenceCoverage * 100)}%` : null },
      { label: "Local / Global", value: effectiveCompany.targetCountryRelationship || localizeTypeWording(effectiveCompany.companyType) },
      { label: "Company Type", value: effectiveCompany.targetCountryRelationship ? localizeTypeWording(effectiveCompany.companyType) : null },
      { label: "Budget", value: [effectiveCompany.aiInvestmentGlobal, effectiveCompany.aiInvestmentSwitzerland].filter(Boolean).join(" / ") || null },
      { label: "Last contact", value: formatDateTime(lastCommunicationFor(companyLeads, accountExtras[companyKey]?.manualStatusAt)) },
      { label: "Follow-up due", node: dueDateFieldNode(dueDateInputEl, dueDateClearBtnEl) },
      { label: "Top initiatives", value: effectiveCompany.topAiInitiatives, long: true },
    ]));
  }

  const listsEl = document.getElementById("account-detail-lists");
  listsEl.innerHTML = "";
  listsEl.appendChild(buildDetailContent(company));
  renderWebResearchCard(companyKey);

  renderActivityList(document.getElementById("account-activity-list"), await getActivityLogForCompany(companyKey));
  wireCollapsibleHeader(document.getElementById("account-activity-toggle"), document.getElementById("account-activity-list"));

  await refreshSettingsCache();
  await Promise.all([accountMentorChat.init(), accountVoiceChat.init()]);
}

// ---- Contact view ----

async function renderContactView(contactKey, { startInEdit = false } = {}) {
  if (contactKey !== currentContactKey) contactEditMode = false;
  currentContactKey = contactKey;
  if (startInEdit) contactEditMode = true;
  const contact = currentContactRow();
  document.getElementById("contact-title").textContent = contact.fullName || "(unknown contact)";

  const contactLeads = findLeadsForContact(contact, allLeads);
  const contactOverrides = contactExtras[contactKey]?.overrides || {};
  const effectiveContact = { ...contact, ...contactOverrides };

  const dueDateInputEl = document.getElementById("contact-due-date-input");
  const dueDateClearBtnEl = document.getElementById("contact-due-date-clear-btn");
  parkDueDateControls("contact-view", dueDateInputEl, dueDateClearBtnEl);
  wireDueDateInput(
    dueDateInputEl,
    dueDateClearBtnEl,
    () => getTargetContactExtra(contactKey),
    (patch) => saveTargetContactExtra(contactKey, patch),
    { entityLabel: contact.fullName, relatedContactKey: contactKey }
  );

  const overviewEl = document.getElementById("contact-overview");
  overviewEl.innerHTML = "";
  if (contactEditMode) {
    overviewEl.appendChild(buildEditForm(CONTACT_EDIT_FIELDS, effectiveContact, async (formValues, newStatus) => {
      const { overrides, changedLabels } = diffEditFormValues(CONTACT_EDIT_FIELDS, contact, contactOverrides, formValues);
      await saveTargetContactExtra(contactKey, { overrides });
      if (newStatus !== undefined) {
        await saveTargetContactExtra(contactKey, { manualStatus: newStatus, manualStatusAt: newStatus ? Date.now() : null });
        appendActivityLog({
          actor: "user",
          action: "target_contact_status_changed",
          label: `"${contact.fullName}" status manually ${newStatus ? `set to ${newStatus}` : "reset to auto (from leads)"}`,
          newValue: newStatus || "(auto)",
        });
      }
      if (changedLabels.length > 0) {
        appendActivityLog({
          actor: "user",
          action: "target_contact_edited",
          label: `"${contact.fullName}" edited - changed: ${changedLabels.join(", ")}`,
          relatedContactKey: contactKey,
        });
      }
      contactEditMode = false;
      await loadWorkbook();
      await renderContactView(contactKey);
    }, () => {
      contactEditMode = false;
      renderContactView(contactKey);
    }, { leadBucket: leadStatusBucket(contactLeads), manualStatus: contactExtras[contactKey]?.manualStatus || null }));
  } else {
    const contactManualStatus = contactExtras[contactKey]?.manualStatus || null;
    overviewEl.appendChild(buildOverviewCard([
      {
        label: "Status",
        node: statusFieldNode(leadStatusBucket(contactLeads), contactManualStatus, async (newStatus) => {
          await saveTargetContactExtra(contactKey, { manualStatus: newStatus, manualStatusAt: newStatus ? Date.now() : null });
          appendActivityLog({
            actor: "user",
            action: "target_contact_status_changed",
            label: `"${contact.fullName}" status manually ${newStatus ? `set to ${newStatus}` : "reset to auto (from leads)"}`,
            newValue: newStatus || "(auto)",
          });
          await loadWorkbook();
          await renderContactView(contactKey);
        }),
      },
      { label: "Title", value: effectiveContact.jobTitle },
      { label: "Company", value: effectiveContact.company },
      { label: "Function", value: effectiveContact.function },
      { label: "Seniority", value: effectiveContact.seniority },
      { label: "LinkedIn", value: effectiveContact.lastVerified2, link: true },
      { label: "Business email", value: effectiveContact.publicBusinessEmail },
      { label: "Business phone", value: effectiveContact.publicBusinessPhone },
      // The workbook's OWN provenance pair (Evidence_Quality / Last_Verified), imported all along but
      // reachable only from the Account page's nested contacts sub-table and a hidden list column -
      // so a contact with no LinkedIn profile looked like it had no evidence at all, when in fact it
      // was verified against an official company source (reported 2026-09-22). Distinct from
      // lastVerified2/evidenceQuality2 above, which are the LINKEDIN verification pair and are
      // legitimately blank for a contact the research never found on LinkedIn.
      { label: "Source Evidence Quality", value: effectiveContact.evidenceQuality },
      { label: "Source Last Verified", value: formatExcelDate(effectiveContact.lastVerified) },
      { label: "Bio Page", value: effectiveContact.profileUrl, link: true },
      { label: "Last contact", value: formatDateTime(lastCommunicationFor(contactLeads, contactExtras[contactKey]?.manualStatusAt)) },
      { label: "Follow-up due", node: dueDateFieldNode(dueDateInputEl, dueDateClearBtnEl) },
      { label: "Relevance", value: effectiveContact.aiRelevance, long: true },
    ]));
  }

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

// Set by loadWorkbook() - not currently read anywhere (the mega-menu's own
// Target Accounts/Target Contacts nav items are always shown, workbook or
// not, 2026-09-19), kept for whatever future UI wants to know "is there
// real data yet" without a separate check.
let hasWorkbookData = false;

function showView(view) {
  const isListLike = view === "list" || view === "contactsList";
  listViewEl.hidden = view !== "list";
  contactsListViewEl.hidden = view !== "contactsList";
  accountViewEl.hidden = view !== "account";
  contactViewEl.hidden = view !== "contact";
  if (isListLike) showListTab(view === "contactsList" ? "contacts" : "accounts");
  // Reported directly, 2026-09-19: viewing a Contact (list or a single
  // Contact's own detail page) kept showing "Target Accounts Dashboard" as
  // the open/bold nav group - a real bug, not cosmetic (the two are now
  // separate groups, see #app-nav's own comment). Tracks the real current
  // side, not just the list views.
  const onContactsSide = view === "contactsList" || view === "contact";
  navGroupAccountsEl.open = !onContactsSide;
  navGroupContactsEl.open = onContactsSide;
}

async function route() {
  closeColumnMenu();
  // Mirrors settings.js's own routeSettings: routing to this page's content while another page is
  // embedded has to close the embedded page, or the route runs against content that stays hidden.
  if (!embeddedPageWrapEl.hidden) hideEmbeddedPage();
  const { view, key } = parseHash();
  if (view === "account" && key) {
    showView("account");
    const startInEdit = pendingAccountEditKey === key;
    pendingAccountEditKey = null;
    await renderAccountView(key, { startInEdit });
  } else if (view === "contact" && key) {
    showView("contact");
    const startInEdit = pendingContactEditKey === key;
    pendingContactEditKey = null;
    await renderContactView(key, { startInEdit });
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

// Reported directly, 2026-09-18: both back-links always went to "" (the
// Target Accounts list), even from a Contact page - the contact link's own
// label said "Back to Target Accounts" too, so this was a real navigation
// bug, not just a copy mistake. A contact can be reached from other places
// too (an Account page's own Contacts subtable), but the Target Contacts
// list is by far the primary path there, so it's the sane default rather
// than building full referrer tracking for this.
document.getElementById("account-back-link").addEventListener("click", (e) => {
  e.preventDefault();
  location.hash = "";
});
document.getElementById("contact-back-link").addEventListener("click", (e) => {
  e.preventDefault();
  location.hash = "contacts";
});

// ---- HubSpot export / import (by file) ----
const HUBSPOT_SCOPE_RANK = { P1: 1, P2: 2, P3: 3 };

function hubspotExportSelection() {
  const scope = document.getElementById("hubspot-export-scope").value;
  const maxRank = HUBSPOT_SCOPE_RANK[scope] || 99;
  const companies = workbook.companies.filter((c) => {
    if (maxRank === 99) return true;
    const rank = Number(String(accountExtras[normalizeCompanyName(c.company)]?.overrides?.salesTeamPriority || c.salesTeamPriority || "P9").replace("P", ""));
    return rank <= maxRank;
  });
  // "Export at most N companies" - applied before the contact set is derived, so the contacts that
  // come along are exactly the ones belonging to the companies actually exported. The scope dropdown
  // alone is too coarse to try HubSpot out: P1 on its own is already hundreds of accounts.
  const matched = companies.length;
  const cap = Number(document.getElementById("hubspot-export-max")?.value) || 0;
  const capped = cap > 0 ? companies.slice(0, cap) : companies;
  const ids = new Set(capped.map((c) => c.companyId));
  const names = new Set(capped.map((c) => normalizeCompanyName(c.company)));
  const contacts = workbook.contacts.filter((c) => (c.companyId && ids.has(c.companyId)) || names.has(normalizeCompanyName(c.company)));
  return { companies: capped, contacts, matched, capApplied: capped.length < matched };
}

function refreshHubspotExportSummary() {
  const { companies, contacts, matched, capApplied } = hubspotExportSelection();
  document.getElementById("hubspot-export-summary").textContent =
    `${companies.length} compan${companies.length === 1 ? "y" : "ies"}` +
    `${capApplied ? ` (of ${matched} matching - limited by "at most")` : ""}` +
    ` and ${contacts.length} contact${contacts.length === 1 ? "" : "s"} will be exported.`;
}
document.getElementById("hubspot-export-scope").addEventListener("change", refreshHubspotExportSummary);
document.getElementById("hubspot-export-max").addEventListener("input", refreshHubspotExportSummary);
document.getElementById("hubspot-export-page-btn").addEventListener("click", () => {
  refreshHubspotExportSummary();
  document.getElementById("hubspot-export-dialog").showModal();
});
document.getElementById("hubspot-import-page-btn").addEventListener("click", () => {
  document.getElementById("hubspot-import-status").hidden = true;
  document.getElementById("hubspot-import-dialog").showModal();
});

document.getElementById("hubspot-export-btn").addEventListener("click", async () => {
  const { companies, contacts } = hubspotExportSelection();
  if (companies.length === 0) {
    await askConfirm("There are no accounts to export for this choice.", { okLabel: "OK", cancelLabel: "Close" });
    return;
  }
  const statusOfCompany = (c) => effectiveStatus(leadStatusBucket(allLeads.filter((l) => normalizeCompanyName(l.company) === normalizeCompanyName(c.company))), accountExtras[normalizeCompanyName(c.company)]?.manualStatus);
  const statusOfContact = (c) => effectiveStatus(leadStatusBucket(findLeadsForContact(c, allLeads)), contactExtras[contactKeyFor(c.company, c.fullName)]?.manualStatus);
  const files = buildHubspotFiles(companies, contacts, statusOfCompany, statusOfContact);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([files.companiesCsv], { type: "text/csv;charset=utf-8" }), `SalesTeam-HubSpot-companies-${stamp}.csv`);
  await new Promise((r) => setTimeout(r, 400)); // two downloads in a row: give the browser a moment between them
  downloadBlob(new Blob([files.contactsCsv], { type: "text/csv;charset=utf-8" }), `SalesTeam-HubSpot-contacts-${stamp}.csv`);
  document.getElementById("hubspot-export-dialog").close();
  appendActivityLog({ actor: "user", action: "hubspot_exported", label: `Exported ${files.companyCount} companies and ${files.contactCount} contacts to HubSpot files` });
  await askConfirm(`Saved two files to your Downloads folder:\n\n${files.companyCount} companies: SalesTeam-HubSpot-companies-${stamp}.csv\n${files.contactCount} contacts: SalesTeam-HubSpot-contacts-${stamp}.csv\n\nIn HubSpot, import the companies file first, then the contacts file.`, { okLabel: "OK", cancelLabel: "Close" });
});

document.getElementById("hubspot-import-choose-btn").addEventListener("click", () => document.getElementById("hubspot-import-file-input").click());
document.getElementById("hubspot-import-file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const statusEl = document.getElementById("hubspot-import-status");
  statusEl.hidden = false;
  try {
    const { headers, records } = parseCsv(await file.text());
    const kind = detectHubspotFile(headers);
    if (!kind || records.length === 0) {
      statusEl.textContent = `Import failed - "${file.name}" does not look like a HubSpot companies or contacts export (it needs a "Company name" column, or "First Name"/"Last Name"/"Email" columns).`;
      return;
    }
    const companyRows = kind === "companies" ? hubspotCompanyRows(records) : [];
    const contactRows = kind === "contacts" ? hubspotContactRows(records) : [];
    const found = kind === "companies" ? `${companyRows.length} companies` : `${contactRows.length} contacts`;
    if (companyRows.length + contactRows.length === 0) {
      statusEl.textContent = `Import failed - no usable ${kind} rows were found in "${file.name}".`;
      return;
    }
    if (!(await askConfirm(`Add the ${found} in "${file.name}" to your Target Accounts?\n\nOnly ones SalesTeam does not have yet are added; nothing existing is changed or removed.`, { okLabel: "Add them", cancelLabel: "Cancel" }))) {
      statusEl.textContent = "Import cancelled.";
      return;
    }
    statusEl.textContent = `Importing ${file.name}…`;
    const counts = await addHubspotRowsToWorkbook(companyRows, contactRows);
    await loadWorkbook();
    const priority = await autoPrioritizeNewCompanies().catch(() => ({ applied: 0 }));
    const parts = [];
    if (kind === "companies") parts.push(`${counts.companiesAdded} ${counts.companiesAdded === 1 ? "company" : "companies"} added, ${counts.companiesAlreadyHad} already in SalesTeam`);
    else {
      parts.push(`${counts.contactsAdded} ${counts.contactsAdded === 1 ? "contact" : "contacts"} added, ${counts.contactsAlreadyHad} already in SalesTeam`);
      if (counts.companiesCreatedFromContacts > 0) parts.push(`${counts.companiesCreatedFromContacts} new ${counts.companiesCreatedFromContacts === 1 ? "company" : "companies"} created for contacts whose company was not in SalesTeam`);
    }
    if (priority.applied > 0) parts.push(`priorities calculated for ${priority.applied}`);
    statusEl.textContent = `Done - ${parts.join("; ")}.`;
    appendActivityLog({ actor: "user", action: "hubspot_imported", label: `Imported HubSpot ${kind} file "${file.name}": ${parts.join("; ")}` });
  } catch (err) {
    statusEl.textContent = `Import failed - ${err.message}`;
  }
});

// ---- Merge duplicate accounts ----
// A duplicate is the same real company entered twice - typically a ChatGPT-researched row and a LinkedIn-discovered one
// under a slightly different name. Candidates are ranked first: same LinkedIn page, same company ID, or one account's
// name / alias / alternative name equal to the other's (after the usual AG/Ltd/Group normalization).
function accountNameVariants(company) {
  const alt = company.alternativeCompanyName;
  const names = [company.company, ...(Array.isArray(company.aliases) ? company.aliases : []), ...(Array.isArray(alt) ? alt : [alt])];
  return new Set(names.filter(Boolean).map((n) => normalizeCompanyName(n)).filter(Boolean));
}

function linkedinSlugOf(company) {
  const m = /linkedin\.com\/company\/([^/?#]+)/i.exec(company.linkedinLink || "");
  return m ? m[1].toLowerCase() : "";
}

function findMergeCandidates(companyKey) {
  const me = workbook.companies.find((c) => normalizeCompanyName(c.company) === companyKey);
  if (!me) return { likely: [], others: [] };
  const myNames = accountNameVariants(me);
  const mySlug = linkedinSlugOf(me);
  const likely = [];
  const others = [];
  for (const c of workbook.companies) {
    const key = normalizeCompanyName(c.company);
    if (!key || key === companyKey || accountExtras[key]?.deletedAt) continue;
    const sameSlug = mySlug && linkedinSlugOf(c) === mySlug;
    const sameId = me.companyId && c.companyId === me.companyId;
    const sharedName = [...accountNameVariants(c)].some((n) => myNames.has(n));
    (sameSlug || sameId || sharedName ? likely : others).push(c);
  }
  const byName = (a, b) => a.company.localeCompare(b.company);
  return { likely: likely.sort(byName), others: others.sort(byName) };
}

function describeMergeImpact(dropCompany) {
  const dropKey = normalizeCompanyName(dropCompany.company);
  const sameRow = (r) => (dropCompany.companyId && r.companyId === dropCompany.companyId) || (r.company && normalizeCompanyName(r.company) === dropKey);
  const contacts = workbook.contacts.filter(sameRow).length;
  const initiatives = (workbook.aiInitiatives || []).filter(sameRow).length;
  const sources = (workbook.sources || []).filter(sameRow).length;
  const leads = allLeads.filter((l) => l.company && normalizeCompanyName(l.company) === dropKey).length;
  return `"${dropCompany.company}" will disappear. Moving over: ${contacts} contact${contacts === 1 ? "" : "s"}, ${initiatives} initiative${initiatives === 1 ? "" : "s"}, ${sources} source${sources === 1 ? "" : "s"}, ${leads} Post lead${leads === 1 ? "" : "s"}.`;
}

// ---- Find & Merge Duplicates (Advanced tools) ----
// Proposes pairs (sometimes more than two) of accounts that look like the same company: identical normalized name, or the
// same LinkedIn company page. (Alias overlap is deliberately not used here - short aliases like "SIG" would pair unrelated
// companies; the single-account Merge dialog still offers those as "likely duplicates" for a human to judge.)
// A pair the user marked "Keep separate" is remembered (storage.js keptSeparateAccountPairs) and never proposed again.
function accountPairKey(a, b) {
  const idOf = (c) => c.companyId || normalizeCompanyName(c.company);
  return [idOf(a), idOf(b)].sort().join("|");
}

function findDuplicateGroups(keptSeparate) {
  const rows = workbook.companies.filter((c) => normalizeCompanyName(c.company));
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const seen = { name: new Map(), slug: new Map() };
  const link = (kind, value, i) => {
    if (!value) return;
    if (seen[kind].has(value)) {
      const other = seen[kind].get(value);
      if (keptSeparate.has(accountPairKey(rows[other], rows[i]))) return;
      const a = find(other);
      const b = find(i);
      if (a !== b) parent[b] = a;
    } else seen[kind].set(value, i);
  };
  rows.forEach((c, i) => { link("name", normalizeCompanyName(c.company), i); link("slug", linkedinSlugOf(c), i); });
  const groups = new Map();
  rows.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const names = new Set(members.map((m) => normalizeCompanyName(m.company)));
    const slugs = members.map(linkedinSlugOf).filter(Boolean);
    const reasons = [];
    if (names.size < members.length) reasons.push("same name");
    if (slugs.length > new Set(slugs).size) reasons.push("same LinkedIn page");
    // Default keeper: a researched (imported) row over a discovered one, then the lowest universe order.
    members.sort((a, b) => (a.source === "Discovered") - (b.source === "Discovered") || (a.universeOrder ?? 1e9) - (b.universeOrder ?? 1e9));
    out.push({ members, reasons });
  }
  return out.sort((a, b) => a.members[0].company.localeCompare(b.members[0].company));
}

function describeAccountRow(c) {
  const contacts = workbook.contacts.filter((r) => c.companyId && r.companyId === c.companyId).length;
  const kind = c.source === "Discovered" ? "discovered" : "researched";
  return `${c.company} - ${kind}, ${contacts} contact${contacts === 1 ? "" : "s"}`;
}

async function mergeDuplicateGroup(group, keepIndex) {
  const keep = group.members[keepIndex];
  for (const drop of group.members) {
    if (drop === keep) continue;
    const r = await mergeTargetAccounts(normalizeCompanyName(keep.company), normalizeCompanyName(drop.company), { keepId: keep.companyId, dropId: drop.companyId });
    appendActivityLog({
      actor: "user",
      action: "target_accounts_merged",
      label: `Merged "${r.dropName}" into "${r.keepName}" (${r.contactsMoved} contacts moved, ${r.contactsDuplicate} already there, ${r.initiativesMoved} initiatives, ${r.sourcesMoved} sources, ${r.leadsMoved} Post leads)`,
      relatedCompanyKey: normalizeCompanyName(keep.company),
    });
  }
}

async function renderFindDuplicates(statusMessage = "") {
  const listEl = document.getElementById("find-duplicates-list");
  const statusEl = document.getElementById("find-duplicates-status");
  const mergeAllBtn = document.getElementById("find-duplicates-merge-all-btn");
  const resetBtn = document.getElementById("find-duplicates-reset-btn");
  const keptSeparate = await getKeptSeparatePairs();
  const groups = findDuplicateGroups(keptSeparate);
  const count = groups.length;
  listEl.innerHTML = "";
  statusEl.textContent = statusMessage || (count === 0 ? "No duplicates found." : `${count} possible duplicate${count === 1 ? "" : "s"} found.`);
  mergeAllBtn.hidden = count === 0;
  mergeAllBtn.disabled = false;
  mergeAllBtn.textContent = count > 1 ? `Merge all ${count}` : "Merge all";
  resetBtn.disabled = false;
  resetBtn.hidden = keptSeparate.size === 0;
  resetBtn.textContent = `Show the ${keptSeparate.size} pair${keptSeparate.size === 1 ? "" : "s"} you kept separate again`;
  resetBtn.onclick = async () => {
    await clearKeptSeparatePairs();
    await renderFindDuplicates("Suggestions restored.");
  };

  // While one merge or "merge all" is running, everything else in the list is locked and says what is happening.
  const setBusy = (busy, message) => {
    listEl.querySelectorAll("button, input").forEach((el) => { el.disabled = busy; });
    mergeAllBtn.disabled = busy;
    resetBtn.disabled = busy;
    if (message) statusEl.textContent = message;
  };

  groups.forEach((group, gi) => {
    const box = document.createElement("div");
    box.className = "duplicate-group";
    const reason = document.createElement("div");
    reason.className = "duplicate-group-reason";
    reason.textContent = `Looks like the same company (${group.reasons.join(", ") || "similar"}) - keep:`;
    box.appendChild(reason);
    group.members.forEach((m, mi) => {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `dup-keep-${gi}`;
      radio.value = String(mi);
      radio.checked = mi === 0;
      label.append(radio, document.createTextNode(" " + describeAccountRow(m)));
      box.appendChild(label);
    });
    const keepIndexOf = () => Number(box.querySelector(`input[name="dup-keep-${gi}"]:checked`).value);

    const mergeBtn = document.createElement("button");
    mergeBtn.type = "button";
    mergeBtn.className = "duplicate-merge-btn";
    mergeBtn.textContent = "Merge";
    mergeBtn.addEventListener("click", async () => {
      const keepIndex = keepIndexOf();
      if (!(await askConfirm(`Merge these ${group.members.length} accounts into "${group.members[keepIndex].company}"?\n\nTheir contacts, initiatives, sources and Post leads move to it, and the other entries disappear. This can't be undone from the app.`, { okLabel: "Merge", cancelLabel: "Cancel", danger: true }))) return;
      setBusy(true, `Merging "${group.members[keepIndex].company}"…`);
      mergeBtn.textContent = "Merging…";
      try {
        await mergeDuplicateGroup(group, keepIndex);
        await loadWorkbook();
        await renderFindDuplicates("Merged.");
      } catch (err) {
        setBusy(false, `Merge failed: ${err.message}`);
        mergeBtn.textContent = "Merge";
      }
    });

    const separateBtn = document.createElement("button");
    separateBtn.type = "button";
    separateBtn.className = "duplicate-separate-btn";
    separateBtn.textContent = "Keep separate";
    separateBtn.title = "These are different companies - do not propose them again";
    separateBtn.addEventListener("click", async () => {
      const sameName = new Set(group.members.map((m) => normalizeCompanyName(m.company))).size < group.members.length;
      const names = group.members.map((m) => `"${m.company}"`).join(" and ");
      const caveat = sameName
        ? "\n\nNote: they have exactly the same name, and SalesTeam identifies a company by its name - so their status, notes and Post leads stay shared. If they really are different companies, give one of them a different name in your research workbook and import it again."
        : "";
      if (!(await askConfirm(`Keep ${names} as separate companies?\n\nThey will not be proposed as duplicates again. You can bring the suggestions back with "Show … again" at the bottom of this window.${caveat}`, { okLabel: "Keep separate", cancelLabel: "Cancel" }))) return;
      const pairKeys = [];
      for (let a = 0; a < group.members.length; a++) {
        for (let b = a + 1; b < group.members.length; b++) pairKeys.push(accountPairKey(group.members[a], group.members[b]));
      }
      await addKeptSeparatePairs(pairKeys);
      appendActivityLog({ actor: "user", action: "duplicates_kept_separate", label: `Kept separate (not duplicates): ${group.members.map((m) => `"${m.company}"`).join(", ")}` });
      await renderFindDuplicates("Kept separate.");
    });
    const actions = document.createElement("div");
    actions.className = "duplicate-actions";
    actions.append(mergeBtn, separateBtn);
    box.appendChild(actions);
    listEl.appendChild(box);
  });

  mergeAllBtn.onclick = async () => {
    if (!(await askConfirm(`Merge all ${count} proposals, keeping the researched account in each? Anything you would rather keep separate should be marked first. This can't be undone from the app.`, { okLabel: "Merge all", cancelLabel: "Cancel", danger: true }))) return;
    let done = 0;
    try {
      for (const group of groups) {
        setBusy(true, `Merging ${done + 1} of ${count}: "${group.members[0].company}"…`);
        await mergeDuplicateGroup(group, 0);
        done++;
      }
    } catch (err) {
      await loadWorkbook();
      await renderFindDuplicates(`Stopped after ${done} of ${count}: ${err.message}`);
      return;
    }
    await loadWorkbook();
    await renderFindDuplicates(`Merged ${done}.`);
  };
}

function openMergeAccountsDialog(companyKey) {
  const me = workbook.companies.find((c) => normalizeCompanyName(c.company) === companyKey);
  if (!me) return;
  const dialog = document.getElementById("merge-accounts-dialog");
  const select = document.getElementById("merge-accounts-other-select");
  const confirmBtn = document.getElementById("merge-accounts-confirm-btn");
  const previewEl = document.getElementById("merge-accounts-preview");
  document.getElementById("merge-accounts-this-name").textContent = me.company;

  const { likely, others } = findMergeCandidates(companyKey);
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose the duplicate…";
  select.appendChild(placeholder);
  const addGroup = (label, rows) => {
    if (rows.length === 0) return;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const c of rows) {
      const opt = document.createElement("option");
      opt.value = normalizeCompanyName(c.company);
      opt.textContent = c.source === "Discovered" ? `${c.company} (discovered)` : c.company;
      group.appendChild(opt);
    }
    select.appendChild(group);
  };
  addGroup("Likely duplicates", likely);
  addGroup("All other accounts", others);

  const otherOf = () => workbook.companies.find((c) => normalizeCompanyName(c.company) === select.value);
  const keepRadio = (v) => dialog.querySelector(`input[name="merge-accounts-keep"][value="${v}"]`);
  const refresh = () => {
    const other = otherOf();
    confirmBtn.disabled = !other;
    document.getElementById("merge-accounts-keep-fieldset").hidden = !other;
    if (!other) { previewEl.textContent = "Pick the account that is a duplicate of this one."; return; }
    document.getElementById("merge-accounts-keep-this").textContent = me.company;
    document.getElementById("merge-accounts-keep-other").textContent = other.company;
    previewEl.textContent = describeMergeImpact(keepRadio("other").checked ? me : other);
  };
  select.onchange = () => {
    const other = otherOf();
    // Default: keep the researched (imported) account over a LinkedIn-discovered one.
    if (other) keepRadio(me.source === "Discovered" && other.source !== "Discovered" ? "other" : "this").checked = true;
    refresh();
  };
  dialog.querySelectorAll('input[name="merge-accounts-keep"]').forEach((r) => { r.onchange = refresh; });
  refresh();

  document.getElementById("merge-accounts-cancel-btn").onclick = () => dialog.close();
  confirmBtn.onclick = async () => {
    const other = otherOf();
    if (!other) return;
    const keepOther = keepRadio("other").checked;
    const keepKey = keepOther ? normalizeCompanyName(other.company) : companyKey;
    const dropKey = keepOther ? companyKey : normalizeCompanyName(other.company);
    confirmBtn.disabled = true;
    try {
      const r = await mergeTargetAccounts(keepKey, dropKey);
      appendActivityLog({
        actor: "user",
        action: "target_accounts_merged",
        label: `Merged "${r.dropName}" into "${r.keepName}" (${r.contactsMoved} contacts moved, ${r.contactsDuplicate} already there, ${r.initiativesMoved} initiatives, ${r.sourcesMoved} sources, ${r.leadsMoved} Post leads)`,
        relatedCompanyKey: keepKey,
        newValue: { keepKey, dropKey },
      });
      dialog.close();
      await loadWorkbook();
      // From an Account page: show the surviving account. From the table, loadWorkbook already re-rendered it.
      if (location.hash.startsWith("#account=")) {
        location.hash = `account=${encodeURIComponent(keepKey)}`;
        await renderAccountView(keepKey);
      }
    } catch (err) {
      previewEl.textContent = `Merge failed: ${err.message}`;
      confirmBtn.disabled = false;
    }
  };
  dialog.showModal();
}

// Soft delete (2026-09-16, extracted into reusable functions 2026-09-17 so
// both the detail page's own kebab AND each table row's kebab call the same
// code - previously wired directly to one specific button's click event). A
// plain native confirm() is fine here (unlike the merge dialog above) -
// "remove this one named thing, yes or no" has no real ambiguity to explain.
// onDetailPage clears the hash (nothing left to show) - a table row calling
// this stays on the table, just re-rendered without that row.
async function removeAccount(companyKey, companyName, { onDetailPage = false } = {}) {
  if (!companyName) return;
  if (!(await askConfirm(`Remove "${companyName}" from your Target Accounts list?\n\nIt won't show up anywhere after this, but nothing is permanently erased.`, { okLabel: "Remove", cancelLabel: "Cancel", danger: true }))) return;
  await saveTargetAccountExtra(companyKey, { deletedAt: Date.now() });
  appendActivityLog({
    actor: "user",
    action: "target_account_removed",
    label: `Removed Target Account "${companyName}" from the list`,
    newValue: { companyKey },
  });
  if (onDetailPage) location.hash = "";
  await loadWorkbook();
}

async function removeContact(contactKey, fullName, { onDetailPage = false } = {}) {
  if (!fullName) return;
  if (!(await askConfirm(`Remove "${fullName}" from your Target Accounts list?\n\nIt won't show up anywhere after this, but nothing is permanently erased.`, { okLabel: "Remove", cancelLabel: "Cancel", danger: true }))) return;
  await saveTargetContactExtra(contactKey, { deletedAt: Date.now() });
  appendActivityLog({
    actor: "user",
    action: "target_contact_removed",
    label: `Removed Target Contact "${fullName}" from the list`,
    newValue: { contactKey },
  });
  if (onDetailPage) location.hash = "";
  await loadWorkbook();
}

// PRD 6.20 Phase 10 (2026-09-17) - the detail page's own kebab, replacing
// the old prominent "Remove Account…"/"Remove Contact…" link. Edit/Merge
// are disabled placeholders (not yet built) rather than omitted, so the
// full eventual action set is visible now and nothing has to be re-taught
// once they ship.
document.getElementById("account-actions-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  const company = currentAccountCompanyRow();
  openRowActionMenu(event.currentTarget, `detail-account-${currentAccountKey}`, [
    { label: "Edit", onClick: () => { accountEditMode = true; renderAccountView(currentAccountKey); } },
    { label: "Merge…", onClick: () => openMergeAccountsDialog(currentAccountKey) },
    { label: "Merge", disabled: true, title: "Coming soon" },
    { label: "Remove", danger: true, onClick: () => removeAccount(currentAccountKey, company.company, { onDetailPage: true }) },
  ]);
});

document.getElementById("contact-actions-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  const contact = currentContactRow();
  openRowActionMenu(event.currentTarget, `detail-contact-${currentContactKey}`, [
    { label: "Edit", onClick: () => { contactEditMode = true; renderContactView(currentContactKey); } },
    { label: "Remove", danger: true, onClick: () => removeContact(currentContactKey, contact.fullName, { onDetailPage: true }) },
  ]);
});

// 23rd round of direct feedback (2026-09-19), same-day follow-up: "it
// sometimes works and sometimes not... I cannot figure out any logical
// rule." Root cause - when the embedding host sets the iframe's src to a
// new URL that only differs in the #hash from what it's ALREADY showing
// (e.g. clicking Resolve right after Fetch Company Size, both
// target-accounts.html, just a different #action=), the browser treats
// that as an in-page hash change, not a real navigation - the whole
// document (and its script) never reloads, so init()'s own one-time call
// to openActionFromHash() never got a chance to run again. hashchange
// fires either way, so calling it here too (function hoisted, defined
// below) covers both cases: a real reload (init() calls it) and a
// same-document hash-only change (this listener calls it).
window.addEventListener("hashchange", () => {
  route();
  openActionFromHash();
});
// Reported 2026-09-22 and repeatable: "Target Accounts" is <a href="#"> (the empty hash this page
// normally already sits on) and "Target Contacts" is <a href="#contacts">, and both were routed by
// hashchange alone. Clicking the one whose hash is already set fires NO hashchange, so nothing ran:
// with another page embedded (Posts Dashboard, say) the embedded page stayed up and the click looked
// completely dead until a browser refresh. settings.js already carries this same fix for its own
// #app-nav links; these two tabs were the one place it was missed. The timeout lets the browser apply
// the href's hash first, so route() reads the intended one.
for (const link of document.querySelectorAll('#app-nav a.nav-item[href^="#"]')) {
  link.addEventListener("click", () => setTimeout(route, 0));
}

// 23rd round of direct feedback (2026-09-19): "If I have a sub-menu open,
// it must show all entries, not only 1... it should do what I meant it to
// do, even if my main central tab is pointing to a completely different
// sub-menu." Every OTHER page's own copy of "Target Accounts Dashboard"/
// "Target Contacts Dashboard" now duplicates these same dialog-opening
// items (not just the base "open this page" button) - each one links here
// with "#action=X" (see those pages' own HTML comments), opened
// automatically on load. Same idea as Settings' own #setup-section/etc,
// just for a dialog instead of a page section.
const ACTION_DIALOG_IDS = {
  "import-accounts": "import-accounts-dialog",
  "restore-accounts": "restore-accounts-dialog",
  "export-hubspot": "hubspot-export-dialog",
  "import-hubspot": "hubspot-import-dialog",
  resolve: "resolve-dialog",
  "fetch-size": "fetch-size-dialog",
  prioritize: "prioritize-companies-dialog",
  "discover-contacts": "discover-contacts-dialog",
  "find-duplicates": "find-duplicates-dialog",
};
function openActionFromHash() {
  const action = new URLSearchParams(location.hash.slice(1)).get("action");
  const dialogId = ACTION_DIALOG_IDS[action];
  if (!dialogId) return;
  // 25th round of direct feedback (2026-09-19): "I even managed to get 2
  // different pop-ups appear at the same time, because I clicked on a new
  // action without closing the previous pop-up." Native <dialog>s don't
  // close each other automatically - showModal() just stacks a new one on
  // top of whatever's still open. Worse, calling showModal() on a dialog
  // that's ALREADY open (e.g. re-triggering the same action) throws a
  // spec-defined InvalidStateError, silently aborting the rest of this
  // function - a likely cause of some of the "click did nothing" reports.
  // Closing every one of these dialogs first guarantees at most one is
  // ever open, and that showModal() below never hits an already-open one.
  for (const otherId of Object.values(ACTION_DIALOG_IDS)) {
    const otherDialog = document.getElementById(otherId);
    if (otherDialog.open) otherDialog.close();
  }
  // Discover Contacts is a Target Contacts action - show that side
  // underneath the dialog (not the Accounts list), so closing it lands
  // the user somewhere that makes sense for what they clicked.
  if (action === "discover-contacts") showView("contactsList");
  if (action === "export-hubspot") refreshHubspotExportSummary();
  if (action === "import-hubspot") { document.getElementById("hubspot-import-status").hidden = true; }
  if (action === "find-duplicates") { renderFindDuplicates().then(() => document.getElementById(dialogId).showModal()); return; }
  if (action === "import-accounts") { renderImportColumnsHelp(); document.getElementById("import-help-status").textContent = ""; }
  document.getElementById(dialogId).showModal();
}

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
  // Same gate as the side panel's own onboarding-required banner - a
  // Discovery scan (PRD 6.20, not yet built) will need this page too, so
  // flag the gap here as well rather than only where a scan is triggered.
  document.getElementById("onboarding-required-banner").hidden = Boolean(await getOnboardingCompletedAt());
  loadHiddenColumns();
  loadFilterSortState();
  // A sort saved while the old default layout was active may point at a column that is now hidden.
  if (hiddenColumns.has(sortField)) sortField = "salesTeamPriorityScore";
  loadContactHiddenColumns();
  loadContactFilterSortState();
  await loadWorkbook();
  await route();
  openActionFromHash();
  initBatchStatus(onBulkStateChange);
}

init();

// Automatic daily backup (once per 24h across all open pages) - see backup-restore.js.
startAutoBackup();
