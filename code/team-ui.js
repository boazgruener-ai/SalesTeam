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
  getTeamFolder, pickTeamFolder, saveTeamFolder, clearTeamFolder, teamFolderPermission, requestTeamFolderPermission,
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

// Step 5b (Boaz): an account of mine that the Team Lead reassigned or released - so it does not just "disappear".
// Its own message, below a folder problem (which is a priority message); stays until OK.
const NOTICES_KEY = "teamNotices"; // team-sync.js TEAM_NOTICES_KEY
const NOTICE_BAR_ID = "team-notices";

async function paintTeamNotices() {
  const notices = (await chrome.storage.local.get(NOTICES_KEY))[NOTICES_KEY] || [];
  if (!notices.length) { clearStatusMessage(NOTICE_BAR_ID); return; }
  // "Boaz took over your account Amcor" when the admin reassigned it to themselves - not "… to Boaz" (1.2.1.9 test).
  const one = (n) => `${n.name} (${!n.to ? "now unassigned" : n.to === n.by ? `taken over by ${n.by}` : `now ${n.to}'s`})`;
  const byWho = [...new Set(notices.map((n) => n.by))].join(" and ");
  const single = (n) => (!n.to ? `${n.by} released your account ${n.name} - it is unassigned now`
    : n.to === n.by ? `${n.by} took over your account ${n.name}` : `${n.by} reassigned your account ${n.name} to ${n.to}`);
  const text = notices.length === 1
    ? `${single(notices[0])}.`
    : `${byWho} changed ${notices.length} of your accounts: ${notices.slice(0, 6).map(one).join(", ")}${notices.length > 6 ? ", …" : ""}.`;
  setStatusMessage(NOTICE_BAR_ID, { text, action: { label: "OK", onClick: () => chrome.storage.local.remove(NOTICES_KEY) } });
}

export function initTeamBar() {
  const paint = () => paintTeamBar().catch(() => {});
  const paintNotices = () => paintTeamNotices().catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[NOTICES_KEY]) paintNotices(); });
  paintNotices();
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

// Boaz 2026-10-08: one button, as for joining - choose the folder, and the backup and the setup follow by themselves.
async function onCreate() {
  const status = "team-create-status";
  const name = $("team-create-name").value.trim();
  const teamName = $("team-create-team").value.trim();
  if (!name || !teamName) { setText(status, "Enter your name and the team's name first.", true); return; }
  if (flowBusy) return;
  // The folder picker needs the click itself, so it comes first.
  let handle = null;
  try {
    handle = await pickTeamFolder({ save: false });
  } catch (err) {
    setText(status, `Could not open the folder: ${err.message}`, true);
    return;
  }
  if (!handle) return;
  const first = await checkPickedFolder("create", handle);
  if (!first.ok) { setText(status, first.text, true); return; }
  picked.create = handle;
  setText(status, `${first.text}\nCreating the team - saving a full backup of your data first…`);
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
      `The team "${teamName}" is set up, with you as Team Lead.\n\n` +
      `Its starting data: ${c.accounts ?? "?"} accounts, ${c.contacts ?? "?"} contacts and ${c.leads ?? "?"} leads (posts), plus your Setup and rules.\n\n` +
      "Next: share the folder with your colleagues (right-click it in File Explorer > Share, \"Can edit\"). Each of them then opens Settings > Team > Join a team.\n\n" +
      "SalesTeam shares while a SalesTeam page or the side panel is open.",
      { okLabel: "OK", cancelLabel: "Close" });
  } catch (err) {
    setText(status, `Not created: ${err.message}`, true);
  } finally {
    flowBusy = false;
    picked.create = null;
    $("team-create-btn").disabled = false;
  }
}

// Step 6 (R6.7): the accounts only this browser has - tick which to bring into the team. Resolves to the ticked keys,
// or null on Cancel. `shared`: accounts the team has too that this member worked on (told; the Team Lead decides).
function chooseAccountsToBring(localOnly, shared) {
  return new Promise((resolve) => {
    const el = (tag, css, text) => { const n = document.createElement(tag); if (css) n.style.cssText = css; if (text) n.textContent = text; return n; };
    const dlg = el("dialog", "border:none;border-radius:10px;padding:20px 24px;width:560px;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,.25);font-size:13px;line-height:1.5;color:#1f2933");
    dlg.append(el("h3", "margin:0 0 10px", "Your own accounts"));
    const boxes = [];
    if (localOnly.length) {
      dlg.append(el("p", "margin:0 0 10px", `${localOnly.length} account${localOnly.length === 1 ? " is" : "s are"} in your list but not in the team's. Tick the ones to bring into the team - your colleagues will see them. The others are removed here (they stay in the backup).`));
      const tools = el("div", "margin:0 0 6px;display:flex;gap:6px");
      const all = el("button", "", "Tick all");
      const none = el("button", "", "Tick none");
      all.type = none.type = "button";
      tools.append(all, none);
      const list = el("div", "max-height:300px;overflow:auto;border:1px solid #d0d7de;border-radius:6px;padding:6px 10px;margin:0 0 12px");
      for (const a of localOnly) {
        const row = el("label", "display:flex;gap:8px;align-items:baseline;padding:3px 0;cursor:pointer");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.value = a.key;
        boxes.push(cb);
        const bits = [`${a.contacts} contact${a.contacts === 1 ? "" : "s"}`, `${a.leads} lead${a.leads === 1 ? "" : "s"}`, ...(a.worked || [])];
        const text = el("span");
        text.append(el("strong", "", a.name), document.createTextNode(` - ${bits.join(", ")}`));
        row.append(cb, text);
        list.append(row);
      }
      all.addEventListener("click", () => boxes.forEach((b) => { b.checked = true; }));
      none.addEventListener("click", () => boxes.forEach((b) => { b.checked = false; }));
      dlg.append(tools, list);
    }
    if (shared.length) {
      dlg.append(el("p", "margin:0 0 6px", `${shared.length === 1 ? "This account you worked on is" : `These ${shared.length} accounts you worked on are`} also in the team's list. The team's version is kept; the Team Lead decides in Decisions whether you take ${shared.length === 1 ? "it" : "them"} over. Whom you contacted there (contacts and leads) is kept, so nobody approaches the same person twice.`));
      const list = el("ul", "max-height:200px;overflow:auto;margin:0 0 12px;padding-left:20px");
      for (const a of shared) {
        const li = el("li", "padding:1px 0");
        li.append(el("strong", "", a.name), document.createTextNode(` - ${(a.worked || []).join(", ")}`));
        list.append(li);
      }
      dlg.append(list);
    }
    const actions = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:6px");
    const cancel = el("button", "", "Cancel");
    const ok = el("button", "", "Join the team");
    cancel.type = ok.type = "button";
    ok.className = "team-primary-btn";
    actions.append(cancel, ok);
    dlg.append(actions);
    const done = (value) => { dlg.close(); dlg.remove(); resolve(value); };
    cancel.addEventListener("click", () => done(null));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
    ok.addEventListener("click", () => done(boxes.filter((b) => b.checked).map((b) => b.value)));
    document.body.append(dlg);
    dlg.showModal();
  });
}

// Boaz 2026-10-08: one button - choose the folder, and the backup and the join follow by themselves, with messages.
// (Pick the folder + Back up and join + a confirm was three steps for one decision, already taken by clicking Join.)
async function onJoin() {
  const status = "team-join-status";
  const name = $("team-join-name").value.trim();
  if (!name) { setText(status, "Enter your name first.", true); return; }
  if (flowBusy) return;
  const pipe = (await chrome.storage.local.get(PIPELINE_STATE_KEY))[PIPELINE_STATE_KEY];
  if (pipelineRunning(pipe)) {
    setText(status, "Automatic preparation is working right now. Click \"Pause for today\" in the bar at the top first, then click Join again.", true);
    return;
  }
  // The folder picker needs the click itself, so it comes first.
  let handle = null;
  try {
    handle = await pickTeamFolder({ save: false });
  } catch (err) {
    setText(status, `Could not open the folder: ${err.message}`, true);
    return;
  }
  if (!handle) return;
  const first = await checkPickedFolder("join", handle);
  if (!first.ok) { setText(status, first.text, true); return; }
  picked.join = handle;
  setText(status, `${first.text}\nJoining - saving a full backup of your data first…`);
  flowBusy = true;
  $("team-join-btn").disabled = true;
  try {
    // The backup first, straight after the click: saving it may need Chrome's permission for the backup folder.
    const b = await backupFirst(status);
    const recheck = await checkPickedFolder("join", picked.join);
    if (!recheck.ok) throw new Error(recheck.text);
    await saveTeamFolder(picked.join);
    setText(status, `${b}\nReading the team's data to compare it with yours…`);
    const preview = await send({ type: "TEAM_JOIN_PREVIEW" });
    if (!preview.ok) { await clearTeamFolder(); throw new Error(preview.error || "could not read the team's data"); }
    let addKeys = [];
    if (preview.localOnly.length || preview.shared.length) {
      addKeys = await chooseAccountsToBring(preview.localOnly, preview.shared);
      if (addKeys === null) { await clearTeamFolder(); throw new Error("Cancelled - nothing was changed."); }
    }
    setText(status, `${b}\nJoining - reading the team's data…`);
    const r = await send({ type: "TEAM_JOIN", name, addKeys });
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
      (r.brought?.accounts ? `\n\nYou brought ${r.brought.accounts} of your own account${r.brought.accounts === 1 ? "" : "s"} into the team${r.brought.assigned ? " - assigned to you" : ""}.` : "") +
      (r.brought?.proposals ? `\n\n${r.brought.proposals} account${r.brought.proposals === 1 ? "" : "s"} you worked on ${r.brought.proposals === 1 ? "is" : "are"} waiting for the Team Lead's decision (Decisions).` : "") +
      (missing.length ? `\n\nStill to do, for you alone: ${missing.join("; ")}.` : "") +
      "\n\nSalesTeam shares while a SalesTeam page or the side panel is open.",
      { okLabel: "OK", cancelLabel: "Close" });
  } catch (err) {
    setText(status, `Not joined: ${err.message}`, true);
  } finally {
    flowBusy = false;
    picked.join = null;
    $("team-join-btn").disabled = false;
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
  let mine = 0;
  try { mine = ((await send({ type: "TEAM_ASSIGN_COUNTS" })).counts || {})[m.memberId] || 0; } catch { /* unknown */ }
  const go = await askConfirm(
    `Leave the team "${m.teamName}"?\n\nThis browser stops sharing. The data here stays as it is now, as your own copy; ` +
    "your colleagues keep the team's data. What you wrote stays in the team folder." +
    (mine ? `\n\nYour ${mine} assigned account${mine === 1 ? "" : "s"} become${mine === 1 ? "s" : ""} unassigned, so colleagues can work on ${mine === 1 ? "it" : "them"}.` : ""),
    { okLabel: "Leave the team", cancelLabel: "Stay", danger: true });
  if (!go) return;
  try {
    const r = await send({ type: "TEAM_LEAVE" });
    if (!r.ok) throw new Error(r.error || "could not leave");
    setText("team-member-status", "");
    if (mine && !r.signedOff) {
      await askConfirm("You have left the team. The team folder could not be reached, so your assigned accounts are still marked as yours for your colleagues - the Team Lead can release them (Settings > Team > Release all).", { okLabel: "OK", cancelLabel: "Close" });
    }
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
    // 1.2.3 (design 3.2): the role comes from the team folder (st.lead), the stored role only until it is read.
    const leads = st?.lead?.known ? st.lead : { lead: m.role === "admin" ? m.memberId : null, deputy: null };
    const roleOf = (id) => (id === leads.lead ? "Team Lead" : id === leads.deputy ? "Deputy Team Lead" : "Member");
    const role = roleOf(m.memberId);
    // Boaz 2026-10-08: the Team Lead does not leave the team they lead (Close the team, D16, comes in step 1).
    $("team-leave-btn").hidden = m.memberId === leads.lead;
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
      // Step 5 (R6.4): how many accounts each member has, and the admin's "release all" (someone who left).
      let counts = {};
      try { counts = (await send({ type: "TEAM_ASSIGN_COUNTS" })).counts || {}; } catch { /* the column stays empty */ }
      const isAdmin = m.memberId === leads.lead || m.memberId === leads.deputy;
      const table = $("team-members-table");
      table.replaceChildren(memberRow(["Name", "Role", "Last seen", "", "Accounts assigned", ""]));
      table.firstChild.classList.add("team-members-head");
      table.append(memberRow([`${m.name} (you)`, role, "now", connected ? "online" : "not connected", String(counts[m.memberId] || 0), ""]));
      let formerShown = false;
      const sortedMembers = [...(st.members || [])].sort((x, y) => Boolean(x.left) - Boolean(y.left));
      for (const c of sortedMembers) {
        if (c.left && !formerShown) {
          formerShown = true;
          const head = memberRow(["Former members", "", "", "", "", ""]);
          head.classList.add("team-members-head");
          table.append(head);
        }
        const row = memberRow([c.name, roleOf(c.id), c.left ? `${c.removed ? "removed" : "left"} ${timeText(c.left)}` : timeText(c.lastSeen), c.online ? "online" : "", String(counts[c.id] || 0)]);
        if (c.left) row.style.color = "#8a8f98";
        const td = document.createElement("td");
        if (isAdmin && counts[c.id]) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "secondary";
          b.textContent = "Release all";
          b.title = `Unassign all ${counts[c.id]} accounts of ${c.name} - e.g. when ${c.name} has left the team`;
          b.addEventListener("click", async () => {
            if (!(await askConfirm(`Release all ${counts[c.id]} accounts assigned to ${c.name}?

They become unassigned - anyone in the team can then take them.`, { okLabel: "Release all", cancelLabel: "Cancel" }))) return;
            b.disabled = true;
            try {
              const r = await send({ type: "TEAM_UNASSIGN_ALL", member: c.id });
              setText("team-member-sync", r.ok ? `${r.count} account${r.count === 1 ? "" : "s"} of ${c.name} released.` : "Could not release them - the team folder is not connected or not in sync.", !r.ok);
            } catch (err) { setText("team-member-sync", err.message, true); }
            renderTeamSettings();
          });
          td.append(b);
        }
        if (isAdmin && !c.left && c.id !== leads.lead) {
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "secondary";
          rm.textContent = "Remove from team…";
          rm.title = `Take ${c.name} off the team - e.g. an old membership, or a colleague who stopped without leaving`;
          rm.addEventListener("click", async () => {
            const n = counts[c.id] || 0;
            if (!(await askConfirm(`Remove ${c.name} (last seen ${timeText(c.lastSeen) || "never"}) from the team?\n\n` +
              (n ? `Their ${n} assigned account${n === 1 ? "" : "s"} become${n === 1 ? "s" : ""} unassigned. ` : "") +
              `${c.name} is listed under Former members; what they changed stays in the team log. If their SalesTeam is still running, it stops sharing. To come back, they join the team again.`,
              { okLabel: "Remove from team", cancelLabel: "Cancel", danger: true }))) return;
            rm.disabled = true;
            try {
              const r = await send({ type: "TEAM_REMOVE_MEMBER", member: c.id });
              setText("team-member-sync", r.ok ? `${c.name} removed from the team${r.count ? ` - ${r.count} account${r.count === 1 ? "" : "s"} released` : ""}.` : "Could not remove - the team folder is not connected or not in sync.", !r.ok);
            } catch (err) { setText("team-member-sync", err.message, true); }
            renderTeamSettings();
          });
          td.append(rm);
        }
        row.append(td);
        table.append(row);
      }
      if (!(st.members || []).length) table.append(memberRow(["No colleague has joined yet.", "", "", "", "", ""]));
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
    setText("team-create-status", "");
    setText("team-join-status", "");
    showFlow(null);
  }));
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
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[MEMBERSHIP_KEY]) renderTeamSettings(); });
  // The colleagues' "last seen" and the waiting count move on their own: every 5 s while the card is on screen, every
  // 30 s otherwise (the menu badge).
  let ticks = 0;
  setInterval(() => { ticks += 1; if (!$("team-section").hidden || ticks % 6 === 0) renderTeamSettings(); }, 5000);
  renderTeamSettings();
}
