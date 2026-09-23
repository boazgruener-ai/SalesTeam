// PRD 6.20 Phase 10 (2026-09-18) - the side panel, rebuilt from scratch
// (NOT the old sidepanel.js relocated - that file is now scanner.js,
// unchanged, powering the new scanner.html tab). The user's own reframing:
// the panel is the one surface that stays persistent while actively
// browsing LinkedIn, so it should work as a launcher + at-a-glance status,
// not a working area in its own right. Two jobs only: Quick Launch (jump to
// every other page in one click) and a pipeline stats summary (Target
// Accounts/Contacts counts, leads by status) - both read-only, no forms,
// no scan configuration.
import {
  getTargetAccountsWorkbook,
  getTargetAccountExtras,
  getTargetContactExtras,
  getCompanyExclusions,
  isCompanyRowExcluded,
  normalizeCompanyName,
  contactKeyFor,
  getResults,
  LEAD_STATUSES,
  getAnthropicApiKey,
  getOnboardingCompletedAt,
} from "./storage.js";
import { startAutoBackup } from "./backup-restore.js";
import { getLinkedinTouchStats, formatTouchRelease } from "./linkedin-touch-log.js";

function openTab(page) {
  chrome.tabs.create({ url: chrome.runtime.getURL(page) });
}

document.getElementById("open-scanner-btn").addEventListener("click", () => openTab("scanner.html"));
document.getElementById("open-target-accounts-btn").addEventListener("click", () => openTab("target-accounts.html"));
// Same page as Target Accounts (target-accounts.js's own #contacts hash
// route, PRD 6.19) - opened directly at that route rather than making the
// user land on Accounts and click the in-page tab every time.
document.getElementById("open-target-contacts-btn").addEventListener("click", () => openTab("target-accounts.html#contacts"));
document.getElementById("open-dashboard-btn").addEventListener("click", () => openTab("dashboard.html"));
document.getElementById("open-settings-btn").addEventListener("click", () => openTab("settings.html"));

document.getElementById("open-onboarding-link").addEventListener("click", (event) => {
  event.preventDefault();
  openTab("settings.html#wizard");
});

// Same reasoning/copy as the old sidepanel.js's own renderLinkedinTouchStat
// (reported directly, 2026-09-10: a day of concentrated testing triggered
// LinkedIn's "unusual activity" warning at ~315 invisible automated
// touches) - kept in the panel since it's the one place that's visible the
// whole time a user is actually browsing LinkedIn, unlike a tab they only
// open occasionally.
async function renderLinkedinTouchStat() {
  const el = document.getElementById("linkedin-touch-stat");
  const touchStats = await getLinkedinTouchStats();
  const { today, last24h, last7d, level } = touchStats;
  el.textContent = `LinkedIn touches (automated): ${today} today · ${last24h} in the last 24h · ${last7d} in the last 7 days` +
    (level === "ok" ? "" : ` — ${formatTouchRelease(touchStats)}`);
  el.classList.toggle("linkedin-touch-stat-warn", level === "warn");
  el.classList.toggle("linkedin-touch-stat-danger", level === "danger");
}

// Same soft-delete/exclusion filtering as target-accounts.js's own
// loadWorkbook, so this count matches what the Dashboard actually shows -
// not a raw, unfiltered row count that would overstate the real list.
async function computePipelineStats() {
  const [workbook, accountExtras, contactExtras, companyExclusions, results] = await Promise.all([
    getTargetAccountsWorkbook(),
    getTargetAccountExtras(),
    getTargetContactExtras(),
    getCompanyExclusions(),
    getResults(),
  ]);
  const exclusionSlugSet = new Set(companyExclusions.map((e) => e.slug));
  const excludedKeys = new Set(
    (workbook.companies || [])
      .filter((c) => isCompanyRowExcluded(c, exclusionSlugSet))
      .map((c) => normalizeCompanyName(c.company))
  );
  const isAccountDeleted = (key) => Boolean(accountExtras[key]?.deletedAt);

  const accountCount = (workbook.companies || []).filter((c) => {
    if (!c.company) return false;
    const key = normalizeCompanyName(c.company);
    return !isAccountDeleted(key) && !excludedKeys.has(key);
  }).length;

  const contactCount = (workbook.contacts || []).filter((c) => {
    const key = normalizeCompanyName(c.company);
    const contactKey = contactKeyFor(c.company, c.fullName);
    return !contactExtras[contactKey]?.deletedAt && !isAccountDeleted(key) && !excludedKeys.has(key);
  }).length;

  const leadsByStatus = {};
  for (const status of LEAD_STATUSES) leadsByStatus[status] = 0;
  // Leads the Negative Topics or Location Filter marked Irrelevant are not real leads for this user, so they are
  // left out of the counts (reported directly, 2026-09-21) and only mentioned as a filtered-out note.
  const allLeads = Object.values(results);
  let irrelevantCount = 0;
  for (const lead of allLeads) {
    const status = lead.status || "New";
    if (status === "Irrelevant") { irrelevantCount++; continue; }
    leadsByStatus[status] = (leadsByStatus[status] || 0) + 1;
  }

  return { accountCount, contactCount, leadsByStatus, totalLeads: allLeads.length - irrelevantCount, irrelevantCount };
}

const LEAD_STATUS_COLORS = {
  New: "#0A66C2",
  Contacted: "#D9731E",
  Dismissed: "#9e9e9e",
  Responded: "#2e7d32",
  Converted: "#6a1b9a",
  Irrelevant: "#c62828",
};

async function renderPipelineStats() {
  const { accountCount, contactCount, leadsByStatus, totalLeads, irrelevantCount } = await computePipelineStats();
  document.getElementById("stat-target-accounts").textContent = accountCount;
  document.getElementById("stat-target-contacts").textContent = contactCount;

  const wrap = document.getElementById("lead-status-stats");
  wrap.innerHTML = "";
  if (totalLeads === 0) {
    const empty = document.createElement("p");
    empty.className = "field-hint";
    empty.textContent = "No leads yet - run a scan to get started.";
    wrap.appendChild(empty);
    return;
  }
  const title = document.createElement("div");
  title.className = "lead-status-stats-title";
  title.textContent = `Leads by status (${totalLeads} total)`;
  if (irrelevantCount > 0) title.title = `${irrelevantCount} more were filtered out automatically as irrelevant (Negative Topics or Location Filter) and are not counted.`;
  wrap.appendChild(title);
  for (const status of LEAD_STATUSES) {
    const count = leadsByStatus[status] || 0;
    if (count === 0) continue;
    const row = document.createElement("div");
    row.className = "lead-status-row";
    const swatch = document.createElement("span");
    swatch.className = "lead-status-swatch";
    swatch.style.background = LEAD_STATUS_COLORS[status] || "#888";
    const label = document.createElement("span");
    label.className = "lead-status-label";
    label.textContent = status;
    const value = document.createElement("span");
    value.className = "lead-status-value";
    value.textContent = count;
    row.append(swatch, label, value);
    wrap.appendChild(row);
  }
}

async function init() {
  document.getElementById("version-text").textContent = `v${chrome.runtime.getManifest().version}`;

  await renderLinkedinTouchStat();
  setInterval(renderLinkedinTouchStat, 30000);

  await renderPipelineStats();

  // Same posture as the old sidepanel.js's own missing-api-key check - only
  // shown once there's real data to act on, since a genuinely fresh install
  // already gets the onboarding-required banner below, which covers "add a
  // key" as part of setup anyway.
  const [hasApiKey, stats] = await Promise.all([
    getAnthropicApiKey().then((k) => Boolean(k || "")),
    computePipelineStats(),
  ]);
  const hasSomeData = stats.accountCount > 0 || stats.contactCount > 0 || stats.totalLeads > 0;
  document.getElementById("missing-api-key-banner").hidden = hasApiKey || !hasSomeData;

  document.getElementById("onboarding-required-banner").hidden = Boolean(await getOnboardingCompletedAt());
}

init();

// Automatic daily backup (once per 24h across all open pages) - see backup-restore.js.
startAutoBackup();
