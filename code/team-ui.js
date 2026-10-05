// Team use 1.2.2, build step 3 (TEAM_USE_DESIGN.md 8.3, 8.4, 9, 10): what a page shows of the team.
//   initTeamBar()      - every SalesTeam page (from initBatchStatus): the one top-bar message when this browser is in
//                        a team but cannot share - "Click to reconnect to the team folder" or "Not in sync". Nothing
//                        while all is well, so the pipeline's line keeps the bar.
//   initTeamSettings() - Settings > Team: create / join / leave, the folder, colleagues, sync state.
// The folder work itself runs in the background worker (team-sync.js); this file only asks it (TEAM_* messages).
import { setStatusMessage, clearStatusMessage } from "./status-bar.js";
import { askConfirm } from "./confirm-dialog.js";
import { backupNow } from "./backup-restore.js";
import { getUserProfile } from "./storage.js";
import {
  getTeamFolder, pickTeamFolder, saveTeamFolder, teamFolderPermission, requestTeamFolderPermission,
  readTeamJson, listTeamFolderTop,
} from "./team-folder.js";

const MEMBERSHIP_KEY = "teamMembership"; // team-sync.js TEAM_MEMBERSHIP_KEY
const PIPELINE_STATE_KEY = "pipelineState"; // pipeline-runner.js
const BAR_ID = "team";
// One failed round is often OneDrive holding a file for a moment (retried by itself); two minutes of failures is not.
const NOT_IN_SYNC_AFTER_MS = 2 * 60000;

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (r === undefined) throw new Error("SalesTeam's background did not answer - reload the extension on chrome://extensions.");
  return r;
}

async function getMembership() {
  return (await chrome.storage.local.get(MEMBERSHIP_KEY))[MEMBERSHIP_KEY] || null;
}

function timeText(ms) {
  if (!ms) return "never";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

// Top-level folder entries that do not make a folder "not empty" (Windows and OneDrive put these in).
const ignorable = (name) => name.startsWith(".") || name.toLowerCase() === "desktop.ini";

// The folder's state as this page sees it. A page holds the permission whenever the background does (step 0).
async function folderState() {
  const handle = await getTeamFolder();
  if (!handle) return { handle: null, permission: "none" };
  return { handle, permission: await teamFolderPermission(handle) };
}

// From a click only (Chrome asks the user). Then the background writes out what waited and reads colleagues.
async function reconnect() {
  const { handle } = await folderState();
  if (!handle) return "none";
  const permission = await requestTeamFolderPermission(handle);
  if (permission === "granted") await send({ type: "TEAM_SYNC_NOW" }).catch(() => {});
  return permission;
}

function openTeamSettings() {
  const url = chrome.runtime.getURL("settings.html#team-section");
  if (location.pathname.endsWith("/settings.html")) location.hash = "#team-section";
  else location.href = url;
}

// ---------------------------------------------------------------------------------------------------
// The top bar (design 8.3 reconnect, 8.4 not in sync)
// ---------------------------------------------------------------------------------------------------

let barBusy = false;

async function paintTeamBar() {
  const membership = await getMembership();
  if (!membership) { clearStatusMessage(BAR_ID); return; }
  const { handle, permission } = await folderState();
  if (!handle || permission === "denied") {
    setStatusMessage(BAR_ID, {
      tone: "error", priority: true,
      text: `Team "${membership.teamName}": SalesTeam cannot use the team folder on this PC. Your changes wait here and colleagues' changes do not arrive. Pick the folder again in Settings > Team.`,
      action: { label: "Open Settings > Team", onClick: openTeamSettings },
    });
    return;
  }
  if (permission !== "granted") {
    setStatusMessage(BAR_ID, {
      tone: "error", priority: true,
      text: `Click to reconnect to the team folder "${handle.name}". Until then your changes wait on this PC and colleagues' changes do not arrive.`,
      action: {
        label: barBusy ? "Reconnecting…" : "Reconnect", disabled: barBusy,
        onClick: async () => {
          barBusy = true;
          paintTeamBar();
          try { await reconnect(); } finally { barBusy = false; paintTeamBar(); }
        },
      },
    });
    return;
  }
  let st = null;
  try { st = await send({ type: "TEAM_SYNC_STATUS" }); } catch { return; }
  if (st && st.member && st.lastError && st.errorSince && Date.now() - st.errorSince >= NOT_IN_SYNC_AFTER_MS) {
    const mins = Math.round((Date.now() - st.errorSince) / 60000);
    setStatusMessage(BAR_ID, {
      tone: "error", priority: true,
      text: `Not in sync - the team folder could not be read or written for ${mins} minutes. Showing team data from ${timeText(st.lastReadAt)}; ` +
        "your changes wait on this PC. Check that OneDrive is running and signed in.",
      action: {
        label: barBusy ? "Trying…" : "Try again", disabled: barBusy,
        onClick: async () => {
          barBusy = true;
          paintTeamBar();
          try { await send({ type: "TEAM_SYNC_NOW" }); } catch { /* shown on the next paint */ } finally { barBusy = false; paintTeamBar(); }
        },
      },
    });
    return;
  }
  clearStatusMessage(BAR_ID);
}

export function initTeamBar() {
  const paint = () => paintTeamBar().catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[MEMBERSHIP_KEY]) paint(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") paint(); });
  setInterval(paint, 15000);
  paint();
}

// ---------------------------------------------------------------------------------------------------
// Settings > Team
// ---------------------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const picked = { create: null, join: null };
let flowBusy = false;

function setText(id, text, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("team-error", isError);
}

function showFlow(which) {
  $("team-solo").hidden = Boolean(which);
  $("team-create").hidden = which !== "create";
  $("team-join").hidden = which !== "join";
}

async function prefillName(inputId) {
  const input = $(inputId);
  if (input.value.trim()) return;
  try { input.value = (await getUserProfile())?.name || ""; } catch { /* left empty */ }
}

function pipelineRunning(state) {
  return Boolean(state) && state.status === "running" && Date.now() - (state.heartbeatAt || 0) <= 60000;
}

// Checks the folder before anything is saved or backed up: empty for a new team, a team in it for joining.
async function checkPickedFolder(which, handle) {
  if (which === "create") {
    const top = (await listTeamFolderTop(handle)).filter((n) => !ignorable(n));
    if (top.length) return { ok: false, text: `The folder "${handle.name}" is not empty (${top.slice(0, 4).join(", ")}${top.length > 4 ? " …" : ""}). Pick a new, empty folder.` };
    return { ok: true, text: `Folder: "${handle.name}" (empty - good).` };
  }
  const team = await readTeamJson(handle, [], "team.json");
  if (team.status === "missing") return { ok: false, text: `The folder "${handle.name}" has no team in it. Pick the folder your colleague shared - or, if it is the right one, wait until OneDrive has copied its files (green ticks) and pick it again.` };
  if (team.status !== "ok") return { ok: false, text: `The folder "${handle.name}" is still being copied by OneDrive. Wait a minute and pick it again.` };
  return { ok: true, text: `Folder: "${handle.name}" - team "${team.data.name}", created ${timeText(Date.parse(team.data.createdAt))}.`, team: team.data };
}

async function onPick(which) {
  const status = `team-${which}-status`;
  try {
    const handle = await pickTeamFolder({ save: false });
    if (!handle) return;
    const check = await checkPickedFolder(which, handle);
    picked[which] = check.ok ? handle : null;
    setText(status, check.text, !check.ok);
  } catch (err) {
    picked[which] = null;
    setText(status, `Could not open the folder: ${err.message}`, true);
  }
  $(`team-${which}-btn`).disabled = !picked[which];
}

// A full backup before the local data is turned into team data or replaced by it (design 9.1-9.2, R8 migration).
async function backupFirst(status) {
  setText(status, "Saving a full backup of your data first…");
  try {
    const r = await backupNow();
    return `Backup saved: ${r.fileName} (${r.where}).`;
  } catch (err) {
    const go = await askConfirm(`The backup could not be saved (${err.message}).\n\nContinue without a backup?`, { okLabel: "Continue without", cancelLabel: "Stop", danger: true });
    if (!go) throw new Error("Stopped - nothing was changed.");
    return "No backup (you chose to continue without one).";
  }
}

async function onCreate() {
  const status = "team-create-status";
  const name = $("team-create-name").value.trim();
  const teamName = $("team-create-team").value.trim();
  if (!name || !teamName) { setText(status, "Enter your name and the team's name first.", true); return; }
  if (!picked.create || flowBusy) return;
  flowBusy = true;
  $("team-create-btn").disabled = true;
  try {
    // The backup first, straight after the click: saving it may need Chrome's permission for the backup folder.
    const b = await backupFirst(status);
    const recheck = await checkPickedFolder("create", picked.create);
    if (!recheck.ok) throw new Error(recheck.text);
    await saveTeamFolder(picked.create);
    setText(status, `${b}\nCreating the team - copying your data into the folder…`);
    const r = await send({ type: "TEAM_CREATE", name, teamName });
    if (!r.ok) throw new Error(r.error || "the team could not be created");
    picked.create = null;
    showFlow(null);
    await renderTeamSettings();
    const c = r.counts || {};
    await askConfirm(
      `The team "${teamName}" is set up, with you as Team Admin.\n\n` +
      `Its starting data: ${c.accounts ?? "?"} accounts, ${c.contacts ?? "?"} contacts and ${c.leads ?? "?"} leads (posts), plus your Setup and rules.\n\n` +
      "Next: share the folder with your colleagues (right-click it in File Explorer > Share, \"Can edit\"). Each of them then opens Settings > Team > Join a team.\n\n" +
      "SalesTeam shares while a SalesTeam page or the side panel is open.",
      { okLabel: "OK", cancelLabel: "Close" });
  } catch (err) {
    setText(status, `Not created: ${err.message}`, true);
  } finally {
    flowBusy = false;
    $("team-create-btn").disabled = !picked.create;
  }
}

async function onJoin() {
  const status = "team-join-status";
  const name = $("team-join-name").value.trim();
  if (!name) { setText(status, "Enter your name first.", true); return; }
  if (!picked.join || flowBusy) return;
  const pipe = (await chrome.storage.local.get(PIPELINE_STATE_KEY))[PIPELINE_STATE_KEY];
  if (pipelineRunning(pipe)) {
    setText(status, "Automatic preparation is working right now. Click \"Pause for today\" in the bar at the top first, then click Join again.", true);
    return;
  }
  const go = await askConfirm(
    "Join the team?\n\nThe accounts, contacts, leads (posts), Setup and rules in this browser are replaced by the team's. " +
    "Anything you have that the team does not is removed here - it stays in the backup saved next.\n\n" +
    "Your API key, User Profile, drafts, Advisors chats, scanner settings, LinkedIn limits and Activity Log stay as they are.",
    { okLabel: "Back up and join", cancelLabel: "Cancel" });
  if (!go) return;
  flowBusy = true;
  $("team-join-btn").disabled = true;
  try {
    // The backup first, straight after the click: saving it may need Chrome's permission for the backup folder.
    const b = await backupFirst(status);
    const recheck = await checkPickedFolder("join", picked.join);
    if (!recheck.ok) throw new Error(recheck.text);
    await saveTeamFolder(picked.join);
    setText(status, `${b}\nJoining - reading the team's data…`);
    const r = await send({ type: "TEAM_JOIN", name });
    if (!r.ok) throw new Error(r.error || "could not join");
    picked.join = null;
    showFlow(null);
    await renderTeamSettings();
    const c = r.counts || {};
    const missing = await personalGaps();
    await askConfirm(
      `You are now in the team "${recheck.team?.name || ""}".\n\n` +
      `This browser now holds the team's ${c.accounts ?? "?"} accounts, ${c.contacts ?? "?"} contacts and ${c.leads ?? "?"} leads (posts). ` +
      "Changes you make are shared with your colleagues, and theirs arrive here by themselves." +
      (missing.length ? `\n\nStill to do, for you alone: ${missing.join("; ")}.` : "") +
      "\n\nSalesTeam shares while a SalesTeam page or the side panel is open.",
      { okLabel: "OK", cancelLabel: "Close" });
  } catch (err) {
    setText(status, `Not joined: ${err.message}`, true);
  } finally {
    flowBusy = false;
    $("team-join-btn").disabled = !picked.join;
  }
}

// What a member still has to fill in for themselves - the team brings the shared setup, not these.
async function personalGaps() {
  const out = [];
  const data = await chrome.storage.local.get(["anthropicApiKey"]);
  if (!data.anthropicApiKey) out.push("add your own Anthropic API key (Settings > Anthropic API Key)");
  try { if (!(await getUserProfile())?.name) out.push("enter your name and title (Settings > User Profile), for drafted messages"); } catch { /* skip */ }
  return out;
}

async function onLeave() {
  const m = await getMembership();
  if (!m) return;
  const go = await askConfirm(
    `Leave the team "${m.teamName}"?\n\nThis browser stops sharing. The data here stays as it is now, as your own copy; ` +
    "your colleagues keep the team's data. What you wrote stays in the team folder.",
    { okLabel: "Leave the team", cancelLabel: "Stay", danger: true });
  if (!go) return;
  try {
    const r = await send({ type: "TEAM_LEAVE" });
    if (!r.ok) throw new Error(r.error || "could not leave");
    setText("team-member-status", "");
  } catch (err) {
    setText("team-member-status", `Could not leave: ${err.message}`, true);
  }
  renderTeamSettings();
}

async function onRepick() {
  const m = await getMembership();
  if (!m) return;
  try {
    const handle = await pickTeamFolder({ save: false });
    if (!handle) return;
    const team = await readTeamJson(handle, [], "team.json");
    if (team.status !== "ok" || team.data.teamId !== m.teamId) {
      setText("team-member-status", `"${handle.name}" is not the folder of the team "${m.teamName}". Pick that team's folder.`, true);
      return;
    }
    await saveTeamFolder(handle);
    await send({ type: "TEAM_SYNC_NOW" }).catch(() => {});
    setText("team-member-status", `Connected to "${handle.name}".`);
  } catch (err) {
    setText("team-member-status", `Could not open the folder: ${err.message}`, true);
  }
  renderTeamSettings();
  paintTeamBar().catch(() => {});
}

function memberRow(cells) {
  const tr = document.createElement("tr");
  for (const c of cells) {
    const td = document.createElement("td");
    td.textContent = c;
    tr.append(td);
  }
  return tr;
}

let rendering = false;

export async function renderTeamSettings() {
  const section = $("team-section");
  if (!section || rendering) return;
  rendering = true;
  try {
    const m = await getMembership();
    const badge = $("nav-team-badge");
    $("team-member").hidden = !m;
    if (!m) {
      if (badge) badge.textContent = "";
      if ($("team-create").hidden && $("team-join").hidden) $("team-solo").hidden = false;
      return;
    }
    $("team-solo").hidden = true;
    $("team-create").hidden = true;
    $("team-join").hidden = true;
    const { handle, permission } = await folderState();
    let st = null;
    try { st = await send({ type: "TEAM_SYNC_STATUS" }); } catch (err) { setText("team-member-sync", err.message, true); }
    const role = m.role === "admin" ? "Team Admin" : "Member";
    setText("team-member-who", `You are ${m.name} in the team "${m.teamName}" (${role}), since ${timeText(Date.parse(m.joinedAt))}.`);
    const connected = handle && permission === "granted";
    setText("team-member-folder",
      !handle ? "Team folder: not set on this PC - pick it again."
        : connected ? `Team folder: "${handle.name}" - connected.`
          : permission === "denied" ? `Team folder: "${handle.name}" - SalesTeam is not allowed to use it. Pick it again.`
            : `Team folder: "${handle.name}" - not connected. Click Reconnect.`, !connected);
    $("team-reconnect-btn").hidden = !handle || connected || permission === "denied";
    $("team-repick-btn").hidden = Boolean(connected);
    if (st && st.member) {
      const waiting = (st.outbox || 0) + (st.inflight ? st.inflight.records : 0);
      const lines = [
        waiting ? `${waiting} change${waiting === 1 ? "" : "s"} of yours wait to be written to the team folder.` : "All your changes are in the team folder.",
        `Last written: ${timeText(st.lastFlushAt)} · colleagues' changes last read: ${timeText(st.lastReadAt)}.`,
      ];
      if (st.lastError) lines.push(`Last problem: ${st.lastError}${st.errorSince ? ` (since ${timeText(st.errorSince)})` : ""}. SalesTeam tries again by itself.`);
      setText("team-member-sync", lines.join("\n"), Boolean(st.lastError));
      const table = $("team-members-table");
      table.replaceChildren(memberRow(["Name", "Role", "Last seen", ""]));
      table.firstChild.classList.add("team-members-head");
      table.append(memberRow([`${m.name} (you)`, role, "now", connected ? "online" : "not connected"]));
      for (const c of st.members || []) {
        table.append(memberRow([c.name, c.admin ? "Team Admin" : "Member", timeText(c.lastSeen), c.online ? "online" : ""]));
      }
      if (!(st.members || []).length) table.append(memberRow(["No colleague has joined yet.", "", "", ""]));
      if (badge) badge.textContent = connected ? `${st.online} online` : "!";
    } else if (badge) {
      badge.textContent = connected ? "" : "!";
    }
  } finally {
    rendering = false;
  }
}

export function initTeamSettings() {
  if (!$("team-section")) return;
  $("team-show-create-btn").addEventListener("click", () => { showFlow("create"); prefillName("team-create-name"); });
  $("team-show-join-btn").addEventListener("click", () => { showFlow("join"); prefillName("team-join-name"); });
  document.querySelectorAll("#team-section .team-cancel-btn").forEach((b) => b.addEventListener("click", () => {
    picked.create = null;
    picked.join = null;
    $("team-create-btn").disabled = true;
    $("team-join-btn").disabled = true;
    setText("team-create-status", "");
    setText("team-join-status", "");
    showFlow(null);
  }));
  $("team-create-pick-btn").addEventListener("click", () => onPick("create"));
  $("team-join-pick-btn").addEventListener("click", () => onPick("join"));
  $("team-create-btn").addEventListener("click", onCreate);
  $("team-join-btn").addEventListener("click", onJoin);
  $("team-leave-btn").addEventListener("click", onLeave);
  $("team-repick-btn").addEventListener("click", onRepick);
  $("team-reconnect-btn").addEventListener("click", async () => {
    const p = await reconnect();
    setText("team-member-status", p === "granted" ? "Reconnected." : "Not reconnected - Chrome did not allow it.", p !== "granted");
    renderTeamSettings();
    paintTeamBar().catch(() => {});
  });
  $("team-sync-now-btn").addEventListener("click", async () => {
    $("team-sync-now-btn").disabled = true;
    try {
      const r = await send({ type: "TEAM_SYNC_NOW" });
      setText("team-member-status", r.ok ? `Synced at ${timeText(Date.now())}.` : r.folder ? "Not connected to the team folder." : `Problem: ${r.error || "unknown"}`, !r.ok);
    } catch (err) {
      setText("team-member-status", err.message, true);
    } finally {
      $("team-sync-now-btn").disabled = false;
      renderTeamSettings();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[MEMBERSHIP_KEY]) renderTeamSettings(); });
  // The colleagues' "last seen" and the waiting count move on their own: every 5 s while the card is on screen, every
  // 30 s otherwise (the menu badge).
  let ticks = 0;
  setInterval(() => { ticks += 1; if (!$("team-section").hidden || ticks % 6 === 0) renderTeamSettings(); }, 5000);
  renderTeamSettings();
}
