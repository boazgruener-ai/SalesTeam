// Backup & restore, shared by every extension page:
//
//  - the daily automatic full backup (one dated zip, see full-backup.js), written to the folder the user
//    chose (Daily/ subfolder) or, if none is chosen, to the Downloads folder;
//  - manual "Back up now" and "Restore from backup" (the Settings > Backup & Restore card);
//  - the restore dialog (chooseRestoreSections): a restore REPLACES current values, so nothing is ticked by
//    default and the user picks exactly which parts to restore;
//  - restoring the older single-purpose JSON backups (settings / leads / Target Accounts), so nothing made
//    before the full backup existed is stranded.
import {
  availableSettingsSections, availableTargetAccountsSections, appendActivityLog,
  importSettings, importTargetAccountsBackup, importLeads,
} from "./storage.js";
import { buildFullBackupZip, parseFullBackup, restoreFullBackup } from "./full-backup.js";
import {
  folderPickerSupported, getStoredFolder, clearStoredFolder, pickBackupFolder, folderPermission,
  requestFolderPermission, writeToFolder,
} from "./backup-folder.js";
import { RETENTION_POLICIES, applyRetention, describeRetention } from "./backup-retention.js";

// ---------------------------------------------------------------- restore dialog
const SETTINGS_SECTION_INFO = {
  scanner: { label: "Scanner settings", detail: "Topics, negative topics, Job Search, timeframe, author-title filter, and which Target Account companies to scan." },
  messaging: { label: "Messaging & AI persona", detail: "Message templates, value-add offers, company context, ideal customer profile, personas and output language." },
  wizard: { label: "Setup wizard configuration", detail: "Target universe, target contacts, exclusions, prioritization rules and guidelines, languages, your profile and company website, wizard progress." },
  accountsLookup: { label: "Target Accounts lookup list", detail: "The small company list used to recognise Target Accounts in new leads." },
};

const TARGET_ACCOUNTS_SECTION_INFO = {
  accounts: { label: "Accounts, contacts and initiatives", detail: "The imported research workbook as it was, including discovered companies already merged in." },
  edits: { label: "Your edits to accounts and contacts", detail: "Manual overrides and priorities, follow-up dates, removed accounts, and Sales Mentor / Customer Voice chats." },
  staged: { label: "Discovery results waiting to be merged", detail: "Companies and contacts found by Discovery that have not gone through Review & Merge yet." },
};

// A combined automatic-backup JSON (the format before the full-backup zip) holds two backups; the Import
// Target Accounts button accepts it too and takes out the part it needs. Any other data passes through.
export function extractBackupPart(data, part) {
  if (data && data.kind === "salesteam-auto-backup") return data[part] || {};
  return data;
}

function runningVersion() {
  try { return chrome.runtime.getManifest().version; } catch { return ""; }
}

// 1 if a > b, -1 if a < b, 0 if equal (dotted numeric versions like 1.0.0).
function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function backupDateText(data) {
  const iso = data.createdAt || data.exportedAt;
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86400000);
  const ago = days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
  const version = data.extensionVersion ? ` by SalesTeam v${data.extensionVersion}` : "";
  return `This backup was made on ${new Date(t).toLocaleString()} (${ago})${version}.`;
}

function ensureStyle() {
  if (document.getElementById("backup-restore-style")) return;
  const style = document.createElement("style");
  style.id = "backup-restore-style";
  style.textContent = `
    #backup-restore-dialog { max-width: 560px; width: calc(100vw - 32px); border: 1px solid #c9cdd4; border-radius: 10px; padding: 20px 22px; font: 13px/1.45 system-ui, sans-serif; color: #1f2933; background: #fff; }
    #backup-restore-dialog::backdrop { background: rgba(0,0,0,.35); }
    #backup-restore-dialog h2 { margin: 0 0 6px; font-size: 16px; }
    #backup-restore-dialog .br-date { margin: 0 0 10px; color: #52606d; }
    #backup-restore-dialog .br-warning { margin: 0 0 12px; padding: 9px 11px; border: 1px solid #e0b04a; background: #fff6e0; border-radius: 6px; }
    #backup-restore-dialog label.br-item { display: flex; gap: 9px; align-items: flex-start; padding: 7px 0; border-top: 1px solid #eceff3; cursor: pointer; }
    #backup-restore-dialog label.br-item input { margin-top: 3px; }
    #backup-restore-dialog .br-item-label { font-weight: 600; }
    #backup-restore-dialog .br-item-detail { color: #52606d; font-size: 12px; }
    #backup-restore-dialog .br-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 14px; }
    #backup-restore-dialog .br-actions .br-spacer { margin-right: auto; }
    #backup-restore-dialog button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #9aa5b1; background: #fff; cursor: pointer; }
    #backup-restore-dialog button.br-primary { background: #b4232c; border-color: #b4232c; color: #fff; }
    #backup-restore-dialog button:disabled { opacity: .5; cursor: not-allowed; }
    #salesteam-backup-banner, .salesteam-banner { position: fixed; top: 0; left: 0; right: 0; z-index: 99999; display: flex; gap: 12px; align-items: center; justify-content: center; padding: 8px 14px; background: #fff3cd; border-bottom: 1px solid #e0b04a; font: 13px system-ui, sans-serif; color: #1f2933; flex-wrap: wrap; }
    .salesteam-banner.in-flow, #salesteam-backup-banner.in-flow { position: sticky; }
    #salesteam-backup-banner button, .salesteam-banner button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid #9aa5b1; background: #fff; cursor: pointer; }
  `;
  document.head.appendChild(style);
}

// kind: "settings" | "targetAccounts" | "full" (data = the manifest of a full-backup zip). Resolves to a Set of
// section ids, or null if cancelled (or if there is nothing that can be restored - the user is told so).
export function chooseRestoreSections(kind, data) {
  const isFull = kind === "full";
  const isSettings = kind === "settings";
  let info;
  let available;
  if (isFull) {
    info = Object.fromEntries(Object.entries(data.categories || {}).map(([id, c]) => [id, { label: c.label, detail: `${c.detail} In this backup: ${c.summary}.` }]));
    available = Object.keys(data.categories || {});
    if (available.includes("leads")) {
      // Two ways to bring leads back - merging never deletes anything you have now, replacing rolls back to the backup.
      const leadsSummary = data.categories.leads.summary;
      info.leadsMerge = { label: "Leads and conversations - only add the ones I'm missing", detail: `Keeps every lead you have now and adds any lead from the backup that is missing. Safe. In this backup: ${leadsSummary}.` };
      info.leads = { label: "Leads and conversations - replace ALL my current leads", detail: `Rolls your leads back to exactly what the backup holds; leads found since are lost. In this backup: ${leadsSummary}.` };
      available.splice(available.indexOf("leads"), 0, "leadsMerge");
    }
  } else {
    info = isSettings ? SETTINGS_SECTION_INFO : TARGET_ACCOUNTS_SECTION_INFO;
    available = isSettings ? availableSettingsSections(data) : availableTargetAccountsSections(data);
  }
  if (available.length === 0) {
    alert("That file doesn't contain anything this page can restore.");
    return Promise.resolve(null);
  }

  ensureStyle();
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.id = "backup-restore-dialog";

    const title = document.createElement("h2");
    title.textContent = isFull ? "Restore from backup" : isSettings ? "Restore settings from backup" : "Restore Target Accounts from backup";
    dialog.appendChild(title);

    const dateText = backupDateText(data);
    if (dateText) {
      const p = document.createElement("p");
      p.className = "br-date";
      p.textContent = dateText;
      dialog.appendChild(p);
    }

    const current = runningVersion();
    if (isFull && data.extensionVersion && current && compareVersions(data.extensionVersion, current) > 0) {
      const newer = document.createElement("p");
      newer.className = "br-warning";
      newer.textContent =
        `This backup comes from a NEWER version of SalesTeam (v${data.extensionVersion}) than the one you are running ` +
        `(v${current}). Update the extension first - restoring it into an older version may not work correctly.`;
      dialog.appendChild(newer);
    }

    const warning = document.createElement("p");
    warning.className = "br-warning";
    warning.textContent =
      "Restoring REPLACES your current values for the parts you tick below. Anything you changed since this " +
      "backup was made - in those parts - will be lost. Parts you leave unticked are not touched" +
      (isFull ? ". A copy of your current data is saved first." : ", and your leads are never affected.");
    dialog.appendChild(warning);

    const boxes = [];
    for (const id of available) {
      const label = document.createElement("label");
      label.className = "br-item";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = id;
      const text = document.createElement("span");
      const name = document.createElement("span");
      name.className = "br-item-label";
      name.textContent = info[id].label;
      const detail = document.createElement("div");
      detail.className = "br-item-detail";
      detail.textContent = info[id].detail;
      text.append(name, detail);
      label.append(box, text);
      dialog.appendChild(label);
      boxes.push(box);
    }

    const actions = document.createElement("div");
    actions.className = "br-actions";
    const selectAll = document.createElement("button");
    selectAll.type = "button";
    selectAll.className = "br-spacer";
    selectAll.textContent = "Select all";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "br-primary";
    restore.textContent = "Restore selected";
    restore.disabled = true;
    actions.append(selectAll, cancel, restore);
    dialog.appendChild(actions);

    const sync = () => { restore.disabled = !boxes.some((b) => b.checked); };
    const byId = Object.fromEntries(boxes.map((b) => [b.value, b]));
    boxes.forEach((b) => b.addEventListener("change", () => {
      // "add missing leads" and "replace all leads" exclude each other
      if (b.checked && b.value === "leads" && byId.leadsMerge) byId.leadsMerge.checked = false;
      if (b.checked && b.value === "leadsMerge" && byId.leads) byId.leads.checked = false;
      sync();
    }));
    // "Select all" takes the safe leads option (merge), never the destructive replace.
    selectAll.addEventListener("click", () => { boxes.forEach((b) => { b.checked = b.value !== "leads" || !byId.leadsMerge; }); sync(); });

    const finish = (result) => { dialog.close(); dialog.remove(); resolve(result); };
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    restore.addEventListener("click", () => finish(new Set(boxes.filter((b) => b.checked).map((b) => b.value))));

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

// ---------------------------------------------------------------- where a backup goes
const LAST_AUTO_BACKUP_KEY = "lastAutoBackupAt";
const LAST_BACKUP_INFO_KEY = "lastBackupInfo";
const BACKUP_PREFS_KEY = "autoBackupPrefs";
// folderPathNote: the folder's full path as the user typed it - Chrome only reveals a folder's name to an extension.
const DEFAULT_BACKUP_PREFS = { enabled: true, time: "02:00", retention: "all", folderPathNote: "" };
const SUBFOLDER = { manual: "Manual", "before-restore": "Before-restore" };

export async function getBackupPrefs() {
  const data = await chrome.storage.local.get(BACKUP_PREFS_KEY);
  return { ...DEFAULT_BACKUP_PREFS, ...(data[BACKUP_PREFS_KEY] || {}) };
}

export async function saveBackupPrefs(prefs) {
  await chrome.storage.local.set({ [BACKUP_PREFS_KEY]: { ...DEFAULT_BACKUP_PREFS, ...prefs } });
}

// "backup/Daily/2026-09" -> "C:\\...\\backup/Daily/2026-09" when the user typed the folder's full path; otherwise unchanged.
async function prettyWhere(where) {
  const [prefs, handle] = [await getBackupPrefs(), await getStoredFolder()];
  if (prefs.folderPathNote && handle && (where === handle.name || where.startsWith(handle.name + "/"))) {
    return prefs.folderPathNote + where.slice(handle.name.length);
  }
  return where;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function localDateStamp(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function localDateTimeStamp(d = new Date()) { return `${localDateStamp(d)}_${pad2(d.getHours())}${pad2(d.getMinutes())}`; }
function versionTag() { const v = runningVersion(); return v ? `_v${v}` : ""; }

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Daily backups go into a folder per month (Daily/2026-09/) so a year of them stays browsable.
function subPath(kind) {
  return kind === "daily" ? ["Daily", localDateStamp().slice(0, 7)] : [SUBFOLDER[kind]];
}

// Saves `blob` as `fileName` under the right subfolder of the chosen folder, or to Downloads when no folder
// is chosen. `gesture`: true when the call comes from a user click (then a folder permission Chrome asks
// for again after a restart can be requested right here); false for the automatic backup, which then reports
// needsPermission instead so the caller can show the "click to resume" banner.
// -> { ok: true, where } | { ok: false, needsPermission: true }
async function saveBackupFile(blob, fileName, kind, { gesture = false } = {}) {
  const handle = await getStoredFolder();
  if (handle) {
    let permission = await folderPermission(handle);
    if (permission === "prompt" && gesture) permission = await requestFolderPermission(handle);
    if (permission === "granted") {
      await writeToFolder(handle, subPath(kind), fileName, blob);
      return { ok: true, where: `${handle.name}/${subPath(kind).join("/")}` };
    }
    if (!gesture) return { ok: false, needsPermission: true };
    // the user declined the permission prompt: fall through to Downloads rather than losing the backup
  }
  downloadBlob(blob, fileName);
  return { ok: true, where: "your Downloads folder" };
}

async function recordBackup(info) {
  await chrome.storage.local.set({ [LAST_BACKUP_INFO_KEY]: { ...info, at: Date.now() } });
}

// ---------------------------------------------------------------- fresh install / storage status / retention
// True when nothing of the user's is stored yet (a new install, or one wiped by a reinstall). There is nothing to
// back up then, and it is exactly when "restore from a backup" is what the user needs.
async function isFreshInstall() {
  const d = await chrome.storage.local.get(["topics", "results", "targetAccountsWorkbook", "onboardingCompletedAt", "onboardingProgressStepIndex", "targetUniverseConfig"]);
  const hasTopics = Array.isArray(d.topics) && d.topics.length > 0;
  const hasLeads = d.results && Object.keys(d.results).length > 0;
  const hasWorkbook = d.targetAccountsWorkbook && (d.targetAccountsWorkbook.companies || []).length > 0;
  return !hasTopics && !hasLeads && !hasWorkbook && !d.onboardingCompletedAt && !(d.onboardingProgressStepIndex > 0) && !d.targetUniverseConfig;
}

// -> { used, quota, pct, level: "ok" | "warn" | "danger", unlimited }
// chrome.storage.local.QUOTA_BYTES is a STATIC constant (10 MB). It does not change when the
// extension holds unlimitedStorage, so measuring against it told the user "84% full, new data can't
// be saved" while the 10 MB ceiling did not actually apply (reported 2026-09-22, at 8.4 MB, with
// unlimitedStorage in the manifest since 1.1.3). Read the granted permission instead and report no
// quota at all when it is held - there is then no ceiling to be a percentage of.
export async function storageStatus() {
  const used = await chrome.storage.local.getBytesInUse(null);
  const unlimited = (chrome.runtime.getManifest().permissions || []).includes("unlimitedStorage");
  const quota = unlimited ? 0 : (chrome.storage.local.QUOTA_BYTES || 0);
  const pct = quota ? Math.round((used / quota) * 100) : 0;
  return { used, quota, pct, unlimited, level: pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok" };
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

async function runRetentionIfNeeded() {
  const prefs = await getBackupPrefs();
  if (prefs.retention === "all" || !RETENTION_POLICIES[prefs.retention]) return;
  const handle = await getStoredFolder();
  if (!handle || (await folderPermission(handle)) !== "granted") return;
  try {
    const r = await applyRetention(handle, prefs.retention);
    if (r.deleted > 0) {
      appendActivityLog({ actor: "extension", action: "backup_retention", label: `Removed ${r.deleted} old daily backup${r.deleted === 1 ? "" : "s"} (${mb(r.freedBytes)} MB) - setting: "${RETENTION_POLICIES[prefs.retention].label}"` });
    }
  } catch (err) {
    appendActivityLog({ actor: "extension", action: "backup_retention", label: "Cleaning up old backups failed", error: true, errorMessage: err.message });
  }
}

// ---------------------------------------------------------------- the banner
function showBanner(message, buttonText, onClick) {
  ensureStyle();
  document.getElementById("salesteam-backup-banner")?.remove();
  const banner = document.createElement("div");
  banner.id = "salesteam-backup-banner";
  if (!document.getElementById("app-shell")) banner.classList.add("in-flow");
  const text = document.createElement("span");
  text.textContent = message;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = buttonText;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await onClick(); banner.remove(); } catch (err) { text.textContent = `Backup failed: ${err.message}`; button.disabled = false; }
  });
  banner.append(text, button);
  document.body.prepend(banner);
}

// ---------------------------------------------------------------- the daily automatic backup
// The backup is due when none has been made since the most recent occurrence of the chosen time of day
// (default 02:00). It runs the first time an extension page is open at or after that time - a page can save a
// file, the background worker cannot - so "02:00" means "the first time SalesTeam is opened after 02:00".
export function isBackupDue(lastAt, timeStr, now = new Date()) {
  const [h, m] = String(timeStr || "02:00").split(":").map(Number);
  const scheduledToday = new Date(now);
  scheduledToday.setHours(h || 0, m || 0, 0, 0);
  const lastOccurrence = now >= scheduledToday ? scheduledToday : new Date(scheduledToday.getTime() - 86400000);
  return (lastAt || 0) < lastOccurrence.getTime();
}

async function performBackup(kind, { gesture = false, includeApiKey = false } = {}) {
  const fileName = `salesteam-${kind === "before-restore" ? "before-restore" : "backup"}-${kind === "daily" ? localDateStamp() : localDateTimeStamp()}${versionTag()}.zip`;
  const blob = await buildFullBackupZip({ includeApiKey });
  const result = await saveBackupFile(blob, fileName, kind, { gesture });
  if (result.ok) await recordBackup({ name: fileName, where: result.where, kind, size: blob.size });
  return { ...result, fileName, size: blob.size };
}

// `force` skips the schedule and instead requires only that no backup exists from the last 12 hours (used when
// a scan starts, so a scan never begins without a recent backup; the click is a gesture, so a folder
// permission can be requested there).
export async function runAutoBackupIfDue({ force = false, gesture = false } = {}) {
  const run = async () => {
    const prefs = await getBackupPrefs();
    if (!prefs.enabled && !force) return false;
    if (await isFreshInstall()) return false; // nothing to protect yet
    const { [LAST_AUTO_BACKUP_KEY]: last = 0 } = await chrome.storage.local.get(LAST_AUTO_BACKUP_KEY);
    if (force ? Date.now() - last < 12 * 3600 * 1000 : !isBackupDue(last, prefs.time)) return false;
    // Claim the slot first so a second page opening at the same moment doesn't also save one.
    await chrome.storage.local.set({ [LAST_AUTO_BACKUP_KEY]: Date.now() });
    try {
      const result = await performBackup("daily", { gesture });
      if (!result.ok) {
        await chrome.storage.local.set({ [LAST_AUTO_BACKUP_KEY]: last });
        showBanner("SalesTeam backups are paused: Chrome needs your OK to write to your backup folder again.", "Allow and back up now", async () => {
          const again = await performBackup("daily", { gesture: true });
          await chrome.storage.local.set({ [LAST_AUTO_BACKUP_KEY]: Date.now() });
          appendActivityLog({ actor: "extension", action: "auto_backup", label: `Automatic daily full backup saved to ${again.where}` });
          if (again.where !== "your Downloads folder") await runRetentionIfNeeded();
        });
        return false;
      }
      appendActivityLog({ actor: "extension", action: "auto_backup", label: `Automatic daily full backup saved to ${result.where}` });
      if (result.where !== "your Downloads folder") await runRetentionIfNeeded();
      return true;
    } catch (err) {
      await chrome.storage.local.set({ [LAST_AUTO_BACKUP_KEY]: last }).catch(() => {});
      appendActivityLog({ actor: "extension", action: "auto_backup", label: "Automatic daily backup failed", error: true, errorMessage: err.message });
      return false;
    }
  };
  try {
    if (navigator.locks) return await navigator.locks.request("salesteam-auto-backup", run);
    return await run();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- manual backup and restore
export async function backupNow({ includeApiKey = false } = {}) {
  const result = await performBackup("manual", { gesture: true, includeApiKey });
  appendActivityLog({ actor: "user", action: "full_backup_exported", label: `Full backup saved (${result.fileName}) to ${result.where}` });
  return result;
}

export async function safetyCopyBeforeRestore() {
  if (await isFreshInstall()) return true; // nothing to lose
  try {
    await performBackup("before-restore", { gesture: true });
    return true;
  } catch (err) {
    return confirm(`Couldn't save a safety copy of your current data first (${err.message}). Restore anyway?`);
  }
}

// One entry point for every kind of backup file: the full zip, or one of the older JSON backups.
// Returns a one-line description of what happened, or null if the user cancelled.
export async function restoreFromFile(file) {
  if (file.name.toLowerCase().endsWith(".zip")) {
    const parsed = await parseFullBackup(await file.arrayBuffer());
    const sections = await chooseRestoreSections("full", parsed.manifest);
    if (!sections) return null;
    if (!(await safetyCopyBeforeRestore())) return null;
    await restoreFullBackup(parsed, sections);
    if (sections.has("leadsMerge") && parsed.data.leads) await importLeads(parsed.data.leads);
    appendActivityLog({ actor: "user", action: "full_backup_restored", label: `Restored backup ${file.name} (${[...sections].join(", ")})` });
    return `Restored ${[...sections].join(", ")} from ${file.name}.`;
  }

  // older single-purpose JSON backups
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    throw new Error(`That file isn't a backup zip or valid JSON (${err.message}).`);
  }
  const parts = [];
  const combined = data && data.kind === "salesteam-auto-backup";
  const settings = combined ? data.settings : data;
  const accounts = combined ? data.targetAccounts : data;
  if (settings && availableSettingsSections(settings).length > 0 && (settings.topics !== undefined || settings.wizardSettings || settings.messageTemplates)) parts.push("settings");
  if (accounts && (accounts.targetAccountsWorkbook || (accounts.targetAccounts && accounts.version !== undefined && accounts.targetAccountsImportedAt !== undefined))) parts.push("targetAccounts");
  if (!combined && data && data.results && typeof data.results === "object") parts.push("leads");
  if (parts.length === 0) throw new Error("That file isn't a SalesTeam backup this version can restore.");

  const done = [];
  if (parts.includes("settings")) {
    const sections = await chooseRestoreSections("settings", settings);
    if (sections) {
      if (!(await safetyCopyBeforeRestore())) return null;
      await importSettings(settings, sections);
      done.push(`settings (${[...sections].join(", ")})`);
    }
  }
  if (parts.includes("targetAccounts")) {
    const sections = await chooseRestoreSections("targetAccounts", accounts);
    if (sections) {
      if (!done.length && !(await safetyCopyBeforeRestore())) return null;
      await importTargetAccountsBackup(accounts, sections);
      done.push(`Target Accounts (${[...sections].join(", ")})`);
    }
  }
  if (parts.includes("leads")) {
    if (confirm("Add any leads from this backup that are missing locally? Leads you already have are never overwritten.")) {
      const restored = await importLeads(data);
      done.push(`${restored} lead${restored === 1 ? "" : "s"}`);
    }
  }
  if (done.length === 0) return null;
  appendActivityLog({ actor: "user", action: "backup_restored", label: `Restored ${done.join("; ")} from ${file.name}` });
  return `Restored ${done.join("; ")} from ${file.name}.`;
}

// ---------------------------------------------------------------- reinstall: find a backup in a folder
const BACKUP_FILE_NAME = /^salesteam-backup-(\d{4})-(\d{2})-(\d{2})(?:_(\d{4}))?_v[\d.]+\.zip$/;

// Looks through a folder (and up to three levels of subfolders, skipping Before-restore) for SalesTeam backup zips.
// -> newest first: [{ name, path, size, sortKey, entry }]
async function findBackupsInFolder(handle) {
  const found = [];
  const walk = async (dir, depth, parts) => {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === "file") {
        const m = BACKUP_FILE_NAME.exec(name);
        if (m) found.push({ name, path: [...parts, name].join("/"), sortKey: `${m[1]}${m[2]}${m[3]}${m[4] || "0000"}`, entry });
      } else if (entry.kind === "directory" && depth < 3 && name !== "Before-restore") {
        await walk(entry, depth + 1, [...parts, name]);
      }
    }
  };
  await walk(handle, 0, []);
  found.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  for (const f of found.slice(0, 30)) {
    try { f.size = (await f.entry.getFile()).size; } catch { f.size = 0; }
  }
  return found;
}

function chooseBackupFromList(items) {
  ensureStyle();
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.id = "backup-restore-dialog";
    const title = document.createElement("h2");
    title.textContent = "Choose the backup to restore";
    const note = document.createElement("p");
    note.className = "br-date";
    note.textContent = `${items.length} backup${items.length === 1 ? "" : "s"} found, newest first. The newest one is usually what you want.`;
    dialog.append(title, note);

    const radios = [];
    for (const item of items.slice(0, 30)) {
      const label = document.createElement("label");
      label.className = "br-item";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "backup-choice";
      const text = document.createElement("span");
      const name = document.createElement("span");
      name.className = "br-item-label";
      name.textContent = item.name;
      const detail = document.createElement("div");
      detail.className = "br-item-detail";
      detail.textContent = `${item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) + " - " : ""}${mb(item.size)} MB`;
      text.append(name, detail);
      label.append(radio, text);
      dialog.appendChild(label);
      radios.push({ radio, item });
    }
    radios[0].radio.checked = true;

    const actions = document.createElement("div");
    actions.className = "br-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const use = document.createElement("button");
    use.type = "button";
    use.className = "br-primary";
    use.textContent = "Use this backup";
    actions.append(cancel, use);
    dialog.appendChild(actions);

    const finish = (result) => { dialog.close(); dialog.remove(); resolve(result); };
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    use.addEventListener("click", () => finish(radios.find((r) => r.radio.checked)?.item || null));
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

// For a reinstall: the folder handle was lost with the old install, so the user points at the backup folder
// again. That same folder then becomes the backup folder for new backups. Must be called from a click.
export async function restoreFromFolderFlow() {
  if (!folderPickerSupported()) throw new Error("This browser can't open a folder for SalesTeam. Use \"Choose a backup file\" instead.");
  const handle = await pickBackupFolder();
  if (!handle) return null;
  await requestFolderPermission(handle);
  const items = await findBackupsInFolder(handle);
  if (items.length === 0) {
    alert("No SalesTeam backups (salesteam-backup-….zip) were found in that folder or its subfolders.");
    return null;
  }
  const chosen = await chooseBackupFromList(items);
  if (!chosen) return null;
  return restoreFromFile(await chosen.entry.getFile());
}

function finishRestore(message) {
  alert(`${message}\n\nThe page will now reload.`);
  location.reload();
}

const RESTORE_BANNER_DISMISSED_KEY = "salesteam-restore-banner-dismissed";

// Shown on a fresh install (nothing stored yet), i.e. right after a reinstall.
async function maybeShowFreshInstallBanner() {
  try { if (localStorage.getItem(RESTORE_BANNER_DISMISSED_KEY)) return; } catch { /* show it */ }
  if (!(await isFreshInstall())) return;
  ensureStyle();
  document.getElementById("salesteam-restore-banner")?.remove();
  const banner = document.createElement("div");
  banner.id = "salesteam-restore-banner";
  banner.className = "salesteam-banner" + (document.getElementById("app-shell") ? "" : " in-flow");
  const text = document.createElement("span");
  text.textContent = "Reinstalled SalesTeam? You can get your data back from a backup.";
  const folderBtn = document.createElement("button");
  folderBtn.type = "button";
  folderBtn.textContent = "Find my backups in a folder…";
  const fileBtn = document.createElement("button");
  fileBtn.type = "button";
  fileBtn.textContent = "Choose a backup file…";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "Dismiss";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,.json,application/zip,application/json";
  input.hidden = true;
  banner.append(text, folderBtn, fileBtn, close, input);

  folderBtn.addEventListener("click", async () => {
    try {
      const message = await restoreFromFolderFlow();
      if (message) finishRestore(message);
    } catch (err) { alert(err.message); }
  });
  fileBtn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    try {
      const message = await restoreFromFile(file);
      if (message) finishRestore(message);
    } catch (err) { alert(err.message); }
  });
  close.addEventListener("click", () => { try { localStorage.setItem(RESTORE_BANNER_DISMISSED_KEY, "1"); } catch { /* ignore */ } banner.remove(); });
  document.body.prepend(banner);
}

// A warning once storage is getting full - past 100% Chrome refuses to save new data.
async function maybeShowStorageWarning() {
  const st = await storageStatus().catch(() => null);
  // No quota means unlimitedStorage is granted: there is no ceiling to warn about.
  if (!st || st.unlimited || !st.quota || st.pct < 80) return;
  showBanner(
    `SalesTeam's storage is ${st.pct}% full (${mb(st.used)} of ${mb(st.quota)} MB). When it is full, new data can't be saved.`,
    "Open Backup",
    async () => { location.href = chrome.runtime.getURL("settings.html#backup-section"); }
  );
}

// ---------------------------------------------------------------- Settings > Backup & Restore card
// True while the backup settings on the card have been edited but not yet saved with "Save backup settings";
// a re-render must not overwrite what the user is in the middle of choosing.
let backupCardDirty = false;

// A pasted Windows path often arrives wrapped in quotes ("Copy as path"); drop them and stray spaces.
function cleanPath(text) {
  return String(text || "").trim().replace(/^["']+|["']+$/g, "").trim();
}

async function renderBackupCard() {
  const el = (id) => document.getElementById(id);
  if (!el("backup-section")) return;

  const prefs = await getBackupPrefs();
  if (!backupCardDirty) {
    el("backup-auto-enabled").checked = prefs.enabled;
    el("backup-time-input").value = prefs.time;
    el("backup-folder-path-note").value = prefs.folderPathNote || "";
  }
  el("backup-time-input").disabled = !el("backup-auto-enabled").checked;
  el("backup-save-btn").disabled = !backupCardDirty;

  const handle = await getStoredFolder();
  let folderText = "Downloads folder (default)";
  let permissionNote = "";
  if (handle) {
    // Chrome only tells an extension a folder's NAME, never its full path; the path shown is what the user typed.
    folderText = prefs.folderPathNote ? `${prefs.folderPathNote}  (folder: ${handle.name})` : handle.name;
    if ((await folderPermission(handle)) !== "granted") permissionNote = " - Chrome will ask for permission again; click \"Back up now\" or the banner to allow it.";
  }
  el("backup-folder-name").textContent = folderText + permissionNote;
  el("backup-folder-path-row").hidden = !handle;
  el("backup-use-downloads-btn").hidden = !handle;
  el("backup-choose-folder-btn").hidden = !folderPickerSupported();

  const { [LAST_BACKUP_INFO_KEY]: last } = await chrome.storage.local.get(LAST_BACKUP_INFO_KEY);
  el("backup-last-status").textContent = last
    ? `Last backup: ${new Date(last.at).toLocaleString()} - ${last.name} (${(last.size / 1048576).toFixed(1)} MB) saved to ${await prettyWhere(last.where)}.`
    : "No backup has been made yet.";

  try {
    const st = await storageStatus();
    const bar = el("backup-storage-bar");
    bar.max = 100;
    bar.value = Math.min(100, st.pct);
    bar.dataset.level = st.level;
    el("backup-storage-usage").textContent = st.quota
      ? `Storage used by SalesTeam: ${mb(st.used)} MB of ${mb(st.quota)} MB (${st.pct}%).` +
        (st.level === "ok" ? "" : st.level === "warn"
          ? " Getting full - once it is full, new data can't be saved."
          : " Almost full - new data will soon fail to save. Back up now.")
      : `Storage used by SalesTeam: ${mb(st.used)} MB.`;
  } catch { /* usage is informational only */ }

  // retention (only meaningful with a chosen folder: Downloads files can't be managed by the extension)
  const select = el("backup-retention-select");
  if (!backupCardDirty) select.value = RETENTION_POLICIES[prefs.retention] ? prefs.retention : "all";
  select.disabled = !handle;
  const info = el("backup-retention-info");
  const runBtn = el("backup-retention-run-btn");
  runBtn.hidden = true;
  if (!handle) {
    info.textContent = "Retention needs a backup folder - choose one above. (Backups in the Downloads folder are never deleted.)";
  } else {
    let text = RETENTION_POLICIES[select.value].detail;
    if ((await folderPermission(handle)) === "granted") {
      try {
        const d = await describeRetention(handle, select.value);
        text += ` The Daily folder holds ${d.total} backup${d.total === 1 ? "" : "s"} (${mb(d.bytes)} MB).`;
        if (select.value !== "all" && d.wouldDelete > 0) {
          text += ` ${d.wouldDelete} would be removed (${mb(d.freedBytes)} MB) - this happens after the next daily backup.`;
          // deleting always uses the SAVED setting, so the button waits until the edit is saved
          runBtn.hidden = backupCardDirty;
          if (backupCardDirty) text += " Save your settings to enable \"Remove them now\".";
          runBtn.dataset.count = String(d.wouldDelete);
          runBtn.dataset.bytes = String(d.freedBytes);
        }
      } catch { /* listing is informational only */ }
    }
    info.textContent = text;
  }
}

// Runs the schedule check right now (used after the user changes the time or switches backups on) and reports
// the outcome on the card. The change is a click, so a folder permission Chrome asks for again can be requested.
async function checkDailyBackupNow() {
  const status = document.getElementById("backup-action-status");
  status.textContent = "Checking the daily backup…";
  const ran = await runAutoBackupIfDue({ gesture: true });
  if (ran) {
    status.textContent = "A daily backup was due and has been saved.";
  } else {
    const prefs = await getBackupPrefs();
    const [h, m] = String(prefs.time).split(":").map(Number);
    const next = new Date();
    next.setHours(h || 0, m || 0, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    status.textContent = prefs.enabled
      ? `No daily backup is due right now. The next one is made the first time SalesTeam is open after ${next.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.`
      : "Automatic daily backups are off.";
  }
  renderBackupCard();
}

function wireBackupCard() {
  const el = (id) => document.getElementById(id);
  if (!el("backup-section")) return;

  el("backup-now-btn").addEventListener("click", async () => {
    const includeKey = el("backup-include-api-key").checked;
    if (includeKey && !confirm("This backup will contain your Anthropic API key in plain text. Only keep or share the file with people you trust with that key's spending. Continue?")) return;
    el("backup-now-btn").disabled = true;
    el("backup-action-status").textContent = "Backing up…";
    try {
      const r = await backupNow({ includeApiKey: includeKey });
      el("backup-action-status").textContent = `Saved ${r.fileName} to ${await prettyWhere(r.where)}.`;
    } catch (err) {
      el("backup-action-status").textContent = `Backup failed: ${err.message}`;
    }
    el("backup-now-btn").disabled = false;
    renderBackupCard();
  });

  el("backup-restore-btn").addEventListener("click", () => el("backup-restore-file-input").click());
  el("backup-restore-file-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      const message = await restoreFromFile(file);
      if (!message) { el("restore-action-status").textContent = "Restore cancelled."; return; }
      alert(`${message}\n\nA copy of your previous data was saved first (salesteam-before-restore-….zip). The page will now reload.`);
      location.reload();
    } catch (err) {
      alert(err.message);
      el("restore-action-status").textContent = `Restore failed: ${err.message}`;
    }
  });

  // Editing a backup setting only marks the card as changed; nothing is written until "Save backup settings".
  const markDirty = () => {
    backupCardDirty = true;
    el("backup-save-btn").disabled = false;
    el("backup-save-status").textContent = "Unsaved changes - click \"Save backup settings\".";
    el("backup-time-input").disabled = !el("backup-auto-enabled").checked;
    renderBackupCard(); // refreshes the retention preview for the value now selected
  };
  el("backup-folder-path-note").addEventListener("input", markDirty);
  el("backup-auto-enabled").addEventListener("change", markDirty);
  el("backup-time-input").addEventListener("input", markDirty);
  el("backup-retention-select").addEventListener("change", markDirty);

  el("backup-save-btn").addEventListener("click", async () => {
    const wanted = {
      enabled: el("backup-auto-enabled").checked,
      time: el("backup-time-input").value || DEFAULT_BACKUP_PREFS.time,
      retention: el("backup-retention-select").value,
      folderPathNote: cleanPath(el("backup-folder-path-note").value),
    };
    el("backup-save-btn").disabled = true;
    await saveBackupPrefs(wanted);
    const saved = await getBackupPrefs(); // read it back: confirm it really stuck
    const ok = Object.keys(wanted).every((k) => saved[k] === wanted[k]);
    const at = new Date().toLocaleTimeString();
    if (ok) {
      backupCardDirty = false;
      appendActivityLog({ actor: "user", action: "backup_settings_saved", label: `Backup settings saved: daily backup ${wanted.enabled ? `on at ${wanted.time}` : "off"}, retention "${RETENTION_POLICIES[wanted.retention].label}"` });
      el("backup-save-status").textContent =
        `✓ Saved at ${at}: daily backup ${wanted.enabled ? `on, at ${wanted.time}` : "off"}; keeping old backups: ${RETENTION_POLICIES[wanted.retention].label.toLowerCase()}.`;
      if (wanted.enabled) await checkDailyBackupNow(); // a time already passed today makes a backup due right away
    } else {
      el("backup-save-btn").disabled = false;
      el("backup-save-status").textContent = "Couldn't save the settings - please try again.";
    }
    renderBackupCard();
  });

  el("backup-choose-folder-btn").addEventListener("click", async () => {
    try {
      const previous = await getStoredFolder();
      const handle = await pickBackupFolder();
      if (handle) {
        // a typed path belongs to the OLD folder - drop it unless the user picked the same one again
        let same = false;
        try { same = Boolean(previous) && (await previous.isSameEntry(handle)); } catch { /* treat as different */ }
        if (!same) await saveBackupPrefs({ ...(await getBackupPrefs()), folderPathNote: "" });
        // asking for write permission right away, while the click is still fresh
        await requestFolderPermission(handle);
        // Chrome only reveals the folder's NAME; ask once for the full path so the card can show which folder it is
        if (!same || !(await getBackupPrefs()).folderPathNote) {
          const typed = cleanPath(window.prompt(
            `Chrome only tells SalesTeam the folder's name ("${handle.name}"), not where it is.\n\n` +
            "To show the full path on this page, paste it here.\n" +
            "(In File Explorer: hold Shift, right-click the folder, choose \"Copy as path\".)\n\nLeave empty to skip.", ""));
          if (typed) await saveBackupPrefs({ ...(await getBackupPrefs()), folderPathNote: typed });
        }
        backupCardDirty = false;
        el("backup-save-status").textContent = "";
        el("backup-action-status").textContent = `✓ Backup folder set to "${handle.name}". New backups will be saved there.`;
        appendActivityLog({ actor: "user", action: "backup_folder_chosen", label: `Backup folder set to "${handle.name}"` });
      }
    } catch (err) {
      el("backup-action-status").textContent = `Couldn't set the folder: ${err.message}`;
    }
    renderBackupCard();
  });
  el("backup-use-downloads-btn").addEventListener("click", async () => {
    await clearStoredFolder();
    await saveBackupPrefs({ ...(await getBackupPrefs()), folderPathNote: "" });
    backupCardDirty = false;
    el("backup-action-status").textContent = "✓ New backups will now be saved to your browser's Downloads folder.";
    appendActivityLog({ actor: "user", action: "backup_folder_cleared", label: "Backup folder reset to the Downloads folder" });
    renderBackupCard();
  });

  el("backup-find-btn").addEventListener("click", async () => {
    try {
      const message = await restoreFromFolderFlow();
      if (message) finishRestore(message);
    } catch (err) {
      alert(err.message);
    }
    renderBackupCard();
  });
  el("backup-find-btn").hidden = !folderPickerSupported();

  el("backup-retention-run-btn").addEventListener("click", async () => {
    const runBtn = el("backup-retention-run-btn");
    const handle = await getStoredFolder();
    if (!handle) return;
    if (!confirm(`Permanently delete ${runBtn.dataset.count} older daily backup${runBtn.dataset.count === "1" ? "" : "s"} (${mb(Number(runBtn.dataset.bytes))} MB) from "${handle.name}/Daily"? This cannot be undone. Backups in Manual and Before-restore are never touched.`)) return;
    const prefs = await getBackupPrefs();
    const r = await applyRetention(handle, prefs.retention);
    appendActivityLog({ actor: "user", action: "backup_retention", label: `Removed ${r.deleted} old daily backup${r.deleted === 1 ? "" : "s"} (${mb(r.freedBytes)} MB)` });
    el("backup-action-status").textContent = `Removed ${r.deleted} old backup${r.deleted === 1 ? "" : "s"} (${mb(r.freedBytes)} MB).`;
    renderBackupCard();
  });


  renderBackupCard();
}

// Convenience for a page: wire the Settings card (if this page has it), check the schedule now, then hourly
// while the page stays open.
export function startAutoBackup() {
  wireBackupCard();
  // A page can be shown inside another SalesTeam page (an iframe); only the top window schedules backups and shows
  // banners, so nothing runs or appears twice.
  if (window.top !== window) return;
  maybeShowFreshInstallBanner();
  maybeShowStorageWarning();
  runAutoBackupIfDue();
  // once a minute: cheap (two small storage reads), and it means a chosen time of day is met within a minute
  setInterval(runAutoBackupIfDue, 60 * 1000);
}
