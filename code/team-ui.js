// Team use 1.2.2, build step 3 (TEAM_USE_DESIGN.md 8.3, 8.4, 9, 10): what a page shows of the team.
//   initTeamBar()      - every SalesTeam page (from initBatchStatus): the one top-bar message when this browser is in
//                        a team but cannot share - "Click to reconnect to the team folder" or "Not in sync". Nothing
//                        while all is well, so the pipeline's line keeps the bar.
//   initTeamSettings() - Settings > Team: create / join / leave / close, the folder, members (⋮), groups, sync state.
// The folder work itself runs in the background worker (team-sync.js); this file only asks it (TEAM_* messages).
import { setStatusMessage, clearStatusMessage } from "./status-bar.js";
import { askConfirm, showNotice } from "./confirm-dialog.js";
import { backupNow } from "./backup-restore.js";
import { getUserProfile } from "./storage.js";
import { groupIndex, OTHER_GROUP } from "./team-groups.js";
import { renderTeamGroups, editMemberGroups, kebabButton } from "./team-groups-ui.js";
import {
  getTeamFolder, pickTeamFolder, saveTeamFolder, clearTeamFolder, teamFolderPermission, requestTeamFolderPermission,
  readTeamJson, listTeamFolderTop, getOneDriveFolder, oneDriveFolderFromClick, oneDriveFolderIfAllowed, findTeams,
  saveTeamFolderVia, teamFolderVia,
} from "./team-folder.js";
import { openInvites, inviteMatches, inviteState, personKey } from "./team-invites.js";

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
  // D18: a team folder reached through the OneDrive folder - Chrome asks for the OneDrive folder, which covers it.
  if ((await teamFolderVia()) === "onedrive") {
    const oneDrive = await getOneDriveFolder();
    if (oneDrive) await requestTeamFolderPermission(oneDrive);
  }
  let permission = await teamFolderPermission(handle);
  if (permission !== "granted") permission = await requestTeamFolderPermission(handle);
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
  const all = (await chrome.storage.local.get(NOTICES_KEY))[NOTICES_KEY] || [];
  if (!all.length) { clearStatusMessage(NOTICE_BAR_ID); return; }
  // 1.2.3 step 1: "Boaz made you Team Lead" and the like - each its own sentence, before the accounts.
  // 1.2.3 step 1b: "Annick Zutter joined the team" (kind "joined") is a sentence of its own too.
  const isText = (n) => n.kind === "role" || n.kind === "joined";
  // Only the latest role sentence counts (an older "made you Team Lead" is history), and a line said twice is said once.
  const lastRole = all.filter((n) => n.kind === "role").pop();
  const roles = [...new Set(all.filter((n) => n.kind === "joined" || n === lastRole).map((n) => n.text))];
  const notices = all.filter((n) => !isText(n));
  if (!notices.length) {
    setStatusMessage(NOTICE_BAR_ID, { priority: true, text: roles.join(" "), action: { label: "OK", onClick: () => chrome.storage.local.remove(NOTICES_KEY) } });
    return;
  }
  // "Boaz took over your account Amcor" when the admin reassigned it to themselves - not "… to Boaz" (1.2.1.9 test).
  const one = (n) => `${n.name} (${!n.to ? "now unassigned" : n.to === n.by ? `taken over by ${n.by}` : `now ${n.to}'s`})`;
  const byWho = [...new Set(notices.map((n) => n.by))].join(" and ");
  const single = (n) => (!n.to ? `${n.by} released your account ${n.name} - it is unassigned now`
    : n.to === n.by ? `${n.by} took over your account ${n.name}` : `${n.by} reassigned your account ${n.name} to ${n.to}`);
  const text = [...roles, notices.length === 1
    ? `${single(notices[0])}.`
    : `${byWho} changed ${notices.length} of your accounts: ${notices.slice(0, 6).map(one).join(", ")}${notices.length > 6 ? ", …" : ""}.`].join(" ");
  setStatusMessage(NOTICE_BAR_ID, { priority: true, text, action: { label: "OK", onClick: () => chrome.storage.local.remove(NOTICES_KEY) } });
}

// D16: the Team Lead closed the team - told once on each member's PC, which stopped sharing by itself.
const CLOSED_KEY = "teamClosedNotice"; // team-sync.js TEAM_CLOSED_NOTICE_KEY
const CLOSED_BAR_ID = "team-closed";

async function paintTeamClosed() {
  const c = (await chrome.storage.local.get(CLOSED_KEY))[CLOSED_KEY];
  if (!c) { clearStatusMessage(CLOSED_BAR_ID); return; }
  setStatusMessage(CLOSED_BAR_ID, { priority: true,
    text: `${c.by} closed the team "${c.teamName}" (${timeText(c.at)}). SalesTeam no longer shares on this PC; the data here stays as your own copy.`,
    action: { label: "OK", onClick: () => chrome.storage.local.remove(CLOSED_KEY) },
  });
}

// 1.2.2.8 (Boaz): not in a team while an invitation for this person waits in OneDrive - said on every page, so nobody
// goes on working alone without knowing. Looked for only when the OneDrive folder is already allowed (Chrome asks only
// from a click), at most every 5 minutes per page.
const INVITE_BAR_ID = "team-invite";
const INVITE_LOOK_EVERY_MS = 5 * 60000;
let inviteLookedAt = 0;

async function paintTeamInvitation() {
  if (await getMembership()) { clearStatusMessage(INVITE_BAR_ID); return; }
  if (Date.now() - inviteLookedAt < INVITE_LOOK_EVERY_MS) return;
  inviteLookedAt = Date.now();
  const toJoin = () => { location.href = chrome.runtime.getURL("settings.html?team=join#team-section"); };
  // Boaz (1.2.2.8 test): with the Join screen open, the bar's Join… is greyed out - it was pressed already.
  const joinOpen = () => document.getElementById("team-join")?.hidden === false; // read when the bar is set, after the scan
  // 1.2.2.8 live test: the bar stayed empty and nobody could tell why - so it now says when it cannot look, and when an
  // invitation is there but not in this person's name, instead of going quiet. Priority: under the always-present pipeline line it was never seen.
  const saved = await getOneDriveFolder();
  if (!saved) { clearStatusMessage(INVITE_BAR_ID); return; }
  const oneDrive = await oneDriveFolderIfAllowed();
  if (!oneDrive) {
    setStatusMessage(INVITE_BAR_ID, { priority: true,
      text: "You are not in a team. To look for your team invitation, Chrome needs your permission again for the team's folder.",
      action: { label: "Allow…", onClick: async () => { await requestTeamFolderPermission(saved); inviteLookedAt = 0; paintTeamInvitation().catch(() => {}); } },
    });
    return;
  }
  const teams = await withInvitations(await findTeams(oneDrive));
  invitedCache = { at: Date.now(), teams };
  const t = teams.find((x) => x.mine.length);
  if (t) {
    setStatusMessage(INVITE_BAR_ID, { priority: true,
      text: `${t.mine[0].byName || "Your Team Lead"} has invited you to the team "${t.team.name}" - join it to share accounts, contacts and leads with your colleagues.`,
      action: { label: "Join…", onClick: toJoin, disabled: joinOpen() },
    });
    return;
  }
  const other = teams[0];
  if (!other) { clearStatusMessage(INVITE_BAR_ID); return; }
  const names = other.open.map((i) => `"${i.name}"`).join(", ");
  setStatusMessage(INVITE_BAR_ID, { priority: true,
    text: `The team "${other.team.name}" has an open invitation for ${names} - not the name or e-mail in your User Profile (Settings). If it is for you, join with it.`,
    action: { label: "Join…", onClick: toJoin, disabled: joinOpen() },
  });
}

export function initTeamBar() {
  const paintInvite = () => paintTeamInvitation().catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[MEMBERSHIP_KEY]) { inviteLookedAt = 0; paintInvite(); } });
  setInterval(paintInvite, 60000);
  paintInvite();
  const paint = () => paintTeamBar().catch(() => {});
  const paintNotices = () => paintTeamNotices().catch(() => {});
  const paintClosed = () => paintTeamClosed().catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[NOTICES_KEY]) paintNotices(); });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[CLOSED_KEY]) paintClosed(); });
  paintNotices();
  paintClosed();
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
  // Boaz (1.2.2.8 test): the page heading names the screen - "SalesTeam Settings → Create Team".
  const title = document.getElementById("settings-title");
  if (title && !$("team-section").hidden) title.textContent = `SalesTeam Settings → ${{ create: "Create Team", join: "Join Team" }[which] || "Team"}`;
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
    if (top.length) return { ok: false, text: `The folder "${handle.name}" already has files in it. Choose the team folder again and click New folder to make an empty one.` };
    return { ok: true, text: `Folder: "${handle.name}" (empty - good).` };
  }
  const team = await readTeamJson(handle, [], "team.json");
  if (team.status === "missing") return { ok: false, text: `The folder "${handle.name}" has no team in it. Pick the folder your colleague shared - or, if it is the right one, wait until OneDrive has copied its files (green ticks) and pick it again.` };
  if (team.status !== "ok") return { ok: false, text: `The folder "${handle.name}" is still being copied by OneDrive. Wait a minute and pick it again.` };
  const closed = await readTeamJson(handle, [], "closed.json");
  if (closed.status === "ok") return { ok: false, text: `The team "${team.data.name}" in "${handle.name}" was closed${closed.data.byName ? ` by ${closed.data.byName}` : ""} - it cannot be joined any more.` };
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

// Invitee rows (name, e-mail) - in Create and in Add member…. Returns { el, read() -> [{ name, email }] }.
function inviteeEditor(rows = 1) {
  const box = document.createElement("div");
  const list = document.createElement("div");
  const addRow = (focus = false) => {
    const row = document.createElement("div");
    row.className = "team-invitee-row";
    const name = Object.assign(document.createElement("input"), { type: "text", placeholder: "Name, e.g. Annick Zutter" });
    const email = Object.assign(document.createElement("input"), { type: "email", placeholder: "E-mail (to tell people of the same name apart)" });
    const del = Object.assign(document.createElement("button"), { type: "button", textContent: "×", title: "Remove this row" });
    del.addEventListener("click", () => { row.remove(); if (!list.children.length) addRow(); });
    row.append(name, email, del);
    list.append(row);
    if (focus) name.focus();
  };
  for (let i = 0; i < rows; i++) addRow();
  const more = Object.assign(document.createElement("button"), { type: "button", textContent: "+ Another colleague" });
  more.addEventListener("click", () => addRow(true));
  const tools = document.createElement("div");
  tools.className = "settings-buttons-row";
  tools.append(more);
  box.append(list, tools);
  const read = () => [...list.children].map((r) => {
    const [n, e] = r.querySelectorAll("input");
    return { name: n.value.trim(), email: e.value.trim() };
  }).filter((x) => x.name || x.email);
  return { el: box, read };
}

let createInvitees = null;

// Boaz (1.2.2.8 test): Chrome will not open the OneDrive folder itself when Windows keeps Desktop/Documents in it
// ("contains system files") - so the team folder itself is chosen: a new folder made inside OneDrive with New folder in
// Chrome's window. Its name fills in the team name.
let createFolder = null;

function paintCreateFolder() {
  $("team-create-onedrive").textContent = createFolder ? `"${createFolder.name}"` : "Not chosen yet.";
  $("team-create-onedrive-btn").textContent = createFolder ? "Choose another folder…" : "Choose the team folder…";
  $("team-create-onedrive-hint").hidden = Boolean(createFolder);
  $("team-create-btn").disabled = flowBusy || !createFolder;
}

async function onChooseCreateFolder() {
  const status = "team-create-status";
  let handle = null;
  try {
    handle = await pickTeamFolder({ save: false });
  } catch (err) {
    setText(status, `Could not open the folder: ${err.message}`, true);
    return;
  }
  if (!handle) return;
  const check = await checkPickedFolder("create", handle);
  setText(status, check.ok ? "" : check.text, !check.ok);
  createFolder = check.ok ? handle : null;
  if (createFolder && !$("team-create-team").value.trim()) $("team-create-team").value = createFolder.name;
  paintCreateFolder();
}

// D19: only a Team Lead creates a team - said once more before the Create form opens.
async function onShowCreate() {
  const go = await askConfirm("Create a team as Team Lead?\n\nOnly the Team Lead creates the team. If a colleague has invited you, use Join a team instead.",
    { okLabel: "I am the Team Lead", cancelLabel: "Cancel" });
  if (!go) return;
  showFlow("create");
  prefillName("team-create-name");
  createFolder = null;
  paintCreateFolder();
  if (!createInvitees) {
    createInvitees = inviteeEditor(2);
    $("team-create-invitees").replaceChildren(createInvitees.el);
  }
}

// 1.2.3 step 1b: create in the team folder chosen above, with the invitations typed in.
async function onCreate() {
  const status = "team-create-status";
  const name = $("team-create-name").value.trim();
  const teamName = $("team-create-team").value.trim();
  if (!name || !teamName) { setText(status, "Enter your name and the team's name first.", true); return; }
  const invites = createInvitees ? createInvitees.read() : [];
  const nameless = invites.filter((x) => !x.name);
  if (nameless.length) { setText(status, `Enter a name for ${nameless.map((x) => x.email).join(", ")} - or remove the row.`, true); return; }
  if (flowBusy || !createFolder) return;
  const handle = createFolder;
  // Chrome's permission question needs the click itself, so it comes first.
  if ((await teamFolderPermission(handle)) !== "granted" && (await requestTeamFolderPermission(handle)) !== "granted") {
    setText(status, "Chrome did not allow SalesTeam to use the folder. Click Create the team… again and choose Allow.", true);
    return;
  }
  picked.create = handle;
  setText(status, `Team folder: "${handle.name}".\nCreating the team - saving a full backup of your data first…`);
  flowBusy = true;
  $("team-create-btn").disabled = true;
  let done = false;
  try {
    // The backup first, straight after the click: saving it may need Chrome's permission for the backup folder.
    const b = await backupFirst(status);
    const recheck = await checkPickedFolder("create", picked.create);
    if (!recheck.ok) throw new Error(recheck.text);
    await saveTeamFolderVia(picked.create, null);
    setText(status, `${b}\nCreating the team - copying your data into the folder…`);
    const r = await send({ type: "TEAM_CREATE", name, teamName, invites });
    if (!r.ok) throw new Error(r.error || "the team could not be created");
    done = true;
    picked.create = null;
    createInvitees = null;
    $("team-create-invitees").replaceChildren();
    showFlow(null);
    await renderTeamSettings();
    const c = r.counts || {};
    const invitedNames = invites.map((x) => x.name);
    // Boaz (1.2.2.8 test): a result with one OK, and only the next step.
    showNotice(
      `The team "${teamName}" is set up, with you as Team Lead. It starts with ${c.accounts ?? "?"} accounts, ${c.contacts ?? "?"} contacts and ${c.leads ?? "?"} leads (posts).\n\n` +
      (invitedNames.length ? `Invited: ${invitedNames.join(", ")}.\n\nNext: share` : "Next: invite your colleagues with Add member… below, and share") +
      ` the folder "${handle.name}" with them - in File Explorer, right-click it > Share, type their e-mail addresses, Can edit, Send.`);
  } catch (err) {
    setText(status, `Not created: ${err.message}`, true);
  } finally {
    flowBusy = false;
    picked.create = null;
    if (done) createFolder = null;
    paintCreateFolder();
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

// ---- Join (1.2.3 step 1b, D17, D18): the team from a list, then the invitation ----
// join.teams: what the last look found - [{ handle, folderName, team, creatorName, invites, open, mine }]; join.via:
// "onedrive" when found in the OneDrive folder, null when the team folder was chosen directly.
const join = { teams: [], via: null };
let invitedCache = { at: 0, teams: [] };

function dayText(ms) {
  return ms ? new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" }) : "";
}

// Teams with an open invitation; those whose invitation names this person (User Profile) first.
async function withInvitations(found) {
  let profile = null;
  try { profile = await getUserProfile(); } catch { /* matched by nothing */ }
  return found.map((t) => {
    const open = openInvites(Object.fromEntries(t.invites.map((i) => [i.id, i])));
    return { ...t, open, mine: open.filter((i) => inviteMatches(i, profile)) };
  }).filter((t) => t.open.length)
    .sort((a, b) => Boolean(b.mine.length) - Boolean(a.mine.length) || String(a.team.name).localeCompare(String(b.team.name)));
}

function showInvitesOf(index) {
  const t = join.teams[index];
  const box = $("team-join-invites");
  box.replaceChildren();
  if (!t) return;
  const pick = t.mine[0] || (t.open.length === 1 ? t.open[0] : null);
  // Boaz (1.2.2.8 test): one invitation, in this person's name - said in one line, nothing to choose.
  if (t.open.length === 1 && t.mine.length === 1) {
    const inv = t.mine[0];
    const rb = Object.assign(document.createElement("input"), { type: "radio", name: "team-invite", value: inv.id, checked: true, hidden: true });
    const p = Object.assign(document.createElement("p"), { className: "team-join-invited" });
    const b = document.createElement("strong");
    b.textContent = inv.name;
    p.append(rb, document.createTextNode(`${inv.byName || "The Team Lead"} invited you as `), b,
      document.createTextNode(`${inv.at ? ` on ${dayText(inv.at)}` : ""}${inv.email ? ` (${inv.email})` : ""}.`));
    box.append(p);
    $("team-join-btn").textContent = "Join Team";
    $("team-join-btn").disabled = false;
    return;
  }
  box.append(Object.assign(document.createElement("p"), { className: "field-hint", textContent: "Your invitation:" }));
  for (const inv of t.open) {
    const lab = document.createElement("label");
    lab.className = "team-invite-choice";
    const rb = Object.assign(document.createElement("input"), { type: "radio", name: "team-invite", value: inv.id, checked: inv === pick });
    rb.addEventListener("change", () => { $("team-join-btn").disabled = false; });
    const b = document.createElement("strong");
    b.textContent = inv.name;
    lab.append(rb, document.createTextNode(` ${inv.byName || "The Team Lead"} invited: `), b,
      document.createTextNode(`${inv.email ? ` (${inv.email})` : ""}${inv.at ? `, ${dayText(inv.at)}` : ""}`));
    box.append(lab);
  }
  $("team-join-btn").textContent = "Join Team"; // Boaz: nobody can join as someone else - the name says nothing
  $("team-join-btn").disabled = !pick;
}

// `foundNames`: every team found, with an invitation or not - named when none has one for this person.
function showTeams(teams, via, foundNames = []) {
  join.teams = teams;
  join.via = via;
  const sel = $("team-join-team");
  sel.replaceChildren();
  for (const [i, t] of teams.entries()) {
    const created = [t.creatorName ? `created by ${t.creatorName}` : "", dayText(Date.parse(t.team.createdAt))].filter(Boolean).join(", ");
    sel.append(new Option(`${t.team.name}${created ? ` - ${created}` : ""}${t.mine.length ? "" : " (no invitation in your name)"}`, String(i)));
  }
  $("team-join-choose").hidden = !teams.length;
  if (teams.length) {
    showInvitesOf(0);
    setText("team-join-status", teams.length === 1 ? "" : `${teams.length} teams have an invitation open - choose yours.`);
  } else {
    // Boaz (1.2.2.8 test): name the team, so the member knows what to ask for; nothing meant for the Team Lead.
    const names = foundNames.map((n) => `"${n}"`);
    setText("team-join-status", names.length === 1
      ? `You have no invitation to the team ${names[0]} yet. Ask your Team Lead to invite you.`
      : names.length
        ? `You have no invitation to the teams ${names.slice(0, -1).join(", ")} or ${names.at(-1)} yet. Ask your Team Lead to invite you.`
        // Boaz (1.2.2.8 test, KISS): one step for the member - the only one OneDrive cannot do for them.
        : "There is no SalesTeam team in this folder. Choose the folder your Team Lead shared with you.", true);
    $("team-join-invites").replaceChildren();
  }
  // Boaz (1.2.2.8 test): one way on - with the team listed, Find my team… and its explanation step back (Look again
  // stays, at the bottom). One team: its name is the heading, no list to choose from.
  const one = teams.length === 1;
  $("team-join-team").hidden = one;
  $("team-join-team-label").hidden = one;
  $("team-join-title").textContent = one ? `Join the team "${teams[0].team.name}"` : "Join a team";
  $("team-find-row").hidden = teams.length > 0;
  // Boaz (1.2.2.8 test): no "Look again" - after the first search (Chrome's permission needs that click) SalesTeam
  // keeps looking by itself while nothing joinable is found.
  // A wrong folder: Choose your team's folder… stays, to choose again.
  $("team-find-btn").hidden = foundNames.length > 0 || teams.length > 0;
  const waiting = !teams.some((t) => t.mine.length) && foundNames.length > 0;
  if (waiting) $("team-join-status").textContent += " SalesTeam then shows Join Team here by itself.";
  scheduleAutoLook(waiting && via === "onedrive");
  $("team-join-intro").hidden = true; // it explains Find my team…, which has been clicked
  $("team-join-row").hidden = !teams.length;
  // The ways round a team not found (help, Look again, another folder) only when no invitation in this name is listed.
}

let autoLookTimer = null;
function scheduleAutoLook(on) {
  clearTimeout(autoLookTimer);
  autoLookTimer = on ? setTimeout(autoLook, 30000) : null;
}
async function autoLook() {
  if ($("team-join").hidden || flowBusy) return;
  const oneDrive = await oneDriveFolderIfAllowed();
  if (!oneDrive) return;
  try {
    const found = await findTeams(oneDrive);
    const teams = await withInvitations(found);
    invitedCache = { at: Date.now(), teams };
    if ($("team-join").hidden) return;
    showTeams(teams, "onedrive", found.map((t) => t.team.name));
  } catch { scheduleAutoLook(true); }
}

// Find my team…: the OneDrive folder (asked for once), then every team in it with an invitation open.
// Boaz (1.2.2.8 test): the team's folder itself is chosen (Chrome refuses OneDrive itself on many PCs); it is kept, so
// SalesTeam can look again by itself until the invitation is there.
async function onFindTeams({ repick = true } = {}) {
  if (flowBusy) return;
  const status = "team-join-status";
  let oneDrive = null;
  try {
    oneDrive = await oneDriveFolderFromClick({ repick });
  } catch (err) {
    setText(status, `Could not open the folder: ${err.message}`, true);
    return;
  }
  if (!oneDrive) {
    setText(status, "SalesTeam needs your team's folder. Click Choose your team's folder… again and allow it.", true);
    return;
  }
  setText(status, `Looking for teams in "${oneDrive.name}"…`);
  try {
    const found = await findTeams(oneDrive);
    const teams = await withInvitations(found);
    invitedCache = { at: Date.now(), teams };
    showTeams(teams, "onedrive", found.map((t) => t.team.name));
  } catch (err) {
    setText(status, `Could not look in "${oneDrive.name}": ${err.message}`, true);
  }
}

// Boaz 2026-10-08: one button - the backup and the join follow by themselves, with messages.
async function onJoin() {
  const status = "team-join-status";
  const entry = join.teams[Number($("team-join-team").value)];
  const inviteId = document.querySelector('input[name="team-invite"]:checked')?.value;
  const inv = entry?.open.find((i) => i.id === inviteId);
  if (!entry || !inv) { setText(status, "Choose the team and your invitation first.", true); return; }
  if (flowBusy) return;
  const pipe = (await chrome.storage.local.get(PIPELINE_STATE_KEY))[PIPELINE_STATE_KEY];
  if (pipelineRunning(pipe)) {
    setText(status, "Automatic preparation is working right now. Click \"Pause for today\" in the bar at the top first, then click Join again.", true);
    return;
  }
  const first = await checkPickedFolder("join", entry.handle);
  if (!first.ok) { setText(status, first.text, true); return; }
  picked.join = entry.handle;
  setText(status, `${first.text}\nJoining as ${inv.name} - saving a full backup of your data first…`);
  flowBusy = true;
  $("team-join-btn").disabled = true;
  try {
    // The backup first, straight after the click: saving it may need Chrome's permission for the backup folder.
    const b = await backupFirst(status);
    const recheck = await checkPickedFolder("join", picked.join);
    if (!recheck.ok) throw new Error(recheck.text);
    const still = await readTeamJson(picked.join, ["invites"], `${inv.id}.json`);
    if (still.status === "ok" && inviteState(still.data) !== "open") {
      throw new Error(inviteState(still.data) === "cancelled" ? "The Team Lead cancelled this invitation. Ask for a new one." : "This invitation has just been used on another PC.");
    }
    await saveTeamFolderVia(picked.join, join.via);
    setText(status, `${b}\nReading the team's data to compare it with yours…`);
    const preview = await send({ type: "TEAM_JOIN_PREVIEW", inviteId: inv.id });
    if (!preview.ok) { await clearTeamFolder(); throw new Error(preview.error || "could not read the team's data"); }
    let addKeys = [];
    if (preview.localOnly.length || preview.shared.length) {
      addKeys = await chooseAccountsToBring(preview.localOnly, preview.shared);
      if (addKeys === null) { await clearTeamFolder(); throw new Error("Cancelled - nothing was changed."); }
    }
    setText(status, `${b}\nJoining - reading the team's data…`);
    const r = await send({ type: "TEAM_JOIN", inviteId: inv.id, addKeys });
    if (!r.ok) { await clearTeamFolder(); throw new Error(r.error || "could not join"); }
    picked.join = null;
    showFlow(null);
    await renderTeamSettings();
    const c = r.counts || {};
    const missing = await personalGaps();
    showNotice(
      `You are now in the team "${recheck.team?.name || ""}", as ${r.name || inv.name}. This browser holds the team's ${c.accounts ?? "?"} accounts, ${c.contacts ?? "?"} contacts and ${c.leads ?? "?"} leads (posts); your changes and your colleagues' are shared by themselves.` +
      (r.brought?.accounts ? `

You brought ${r.brought.accounts} of your own account${r.brought.accounts === 1 ? "" : "s"} into the team${r.brought.assigned ? " - assigned to you" : ""}.` : "") +
      (r.brought?.proposals ? `

${r.brought.proposals} account${r.brought.proposals === 1 ? "" : "s"} you worked on ${r.brought.proposals === 1 ? "is" : "are"} waiting for the Team Lead's decision (Decisions).` : "") +
      (missing.length ? `

Still to do, for you alone: ${missing.join("; ")}.` : ""));
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
  // Boaz 2026-10-08 (Annick: "I pressed Leave the team but nothing happens"): say at once that something is happening,
  // and never wait on the background for more than 5 s just to count the assigned accounts.
  setText("team-member-status", "Leave the team: checking your assigned accounts…");
  const counted = await Promise.race([
    send({ type: "TEAM_ASSIGN_COUNTS" }).then((r) => ({ ok: true, r }), (err) => ({ ok: false, error: err.message })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "SalesTeam's background did not answer within 5 seconds" }), 5000)),
  ]);
  if (counted.ok) mine = (counted.r.counts || {})[m.memberId] || 0;
  setText("team-member-status", counted.ok ? "" : `Could not count your assigned accounts (${counted.error}) - you can still leave.`, !counted.ok);
  if (!counted.ok) console.warn("SalesTeam Leave the team:", counted.error);
  const go = await askConfirm(
    `Leave the team "${m.teamName}"?\n\nThis browser stops sharing. The data here stays as it is now, as your own copy; ` +
    "your colleagues keep the team's data. What you wrote stays in the team folder." +
    (mine ? `\n\nYour ${mine} assigned account${mine === 1 ? "" : "s"} become${mine === 1 ? "s" : ""} unassigned, so colleagues can work on ${mine === 1 ? "it" : "them"}.` : ""),
    { okLabel: "Leave the team", cancelLabel: "Stay", danger: true });
  if (!go) return;
  setText("team-member-status", "Leaving the team - handing back your accounts and signing off…");
  try {
    const r = await send({ type: "TEAM_LEAVE" });
    if (!r.ok) throw new Error(r.error || "could not leave");
    setText("team-member-status", "");
    if (mine && !r.signedOff) {
      await askConfirm("You have left the team. The team folder could not be reached, so your assigned accounts are still marked as yours for your colleagues - the Team Lead can release them (Settings > Team > Release all).", { okLabel: "OK", cancelLabel: null });
    }
  } catch (err) {
    setText("team-member-status", `Could not leave: ${err.message}`, true);
  }
  renderTeamSettings();
}

// D16: the Team Lead closes the team instead of leaving it. Every PC stops sharing and keeps its data as its own copy.
async function onClose() {
  const m = await getMembership();
  if (!m) return;
  let st = null;
  try { st = await send({ type: "TEAM_SYNC_STATUS" }); } catch { /* counted as nobody below */ }
  const others = (st?.members || []).filter((c) => !c.left && !c.removed);
  const text = others.length
    ? `Close the team "${m.teamName}"?\n\nEveryone stops sharing; each person keeps a copy of the data as it is now. ` +
      "All assignments end, and nobody can join the team folder again. This cannot be undone.\n\n" +
      "To keep the team going without you, make someone else Team Lead instead (⋮ next to their name > Make Team Lead…), then leave as a Member."
    : `Close the team "${m.teamName}"?\n\nNobody else has joined it. Your data stays here as it is.`;
  if (!(await askConfirm(text, { okLabel: "Close the team", cancelLabel: "Cancel", danger: true }))) return;
  $("team-close-btn").disabled = true;
  try {
    const r = await send({ type: "TEAM_CLOSE" });
    if (!r.ok) {
      throw new Error(r.reason === "offline" ? "the team folder is not connected on this PC - reconnect it first, so your colleagues are told"
        : r.reason === "not_lead" ? "only the Team Lead can close the team" : r.error || "try again in a moment");
    }
    setText("team-member-status", "");
    await askConfirm(`The team "${m.teamName}" is closed.\n\nThis browser works on its own again, with the data as it is now. ` +
      (others.length ? "Your colleagues' SalesTeam stops sharing the next time it reads the team folder, and tells them. " : "") +
      "You can create or join another team at any time.", { okLabel: "OK", cancelLabel: null });
  } catch (err) {
    setText("team-member-status", `Not closed: ${err.message}`, true);
  } finally {
    $("team-close-btn").disabled = false;
  }
  renderTeamSettings();
}

const REFUSALS = {
  offline: "the team folder is not connected on this PC, or not in sync",
  not_lead: "only the Team Lead can do this",
  not_member: "that person is not a current member of the team",
};

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

// One member's ⋮ (design 10.1, D10, D15). No placeholder items: what this person may not do is simply not there.
function memberMenuItems(c, { isSelf, isLead, hasRights, leads, counts, gctx, current }) {
  const items = [];
  if (!hasRights) return items;
  const n = counts[c.id] || 0;
  if (current && !isSelf && isLead) {
    items.push({ label: "Make Team Lead…", onClick: () => onMakeLead(c, leads) });
    if (leads.deputy === c.id) items.push({ label: "End deputy", onClick: () => onSetDeputy(null, c) });
    else items.push({ label: "Make deputy…", onClick: () => onSetDeputy(c, null, leads) });
  }
  if (current) items.push({ label: "Groups…", onClick: () => editMemberGroups(c.id, gctx) });
  if (n) {
    items.push({
      label: "Release all",
      title: `Unassign all ${n} accounts of ${c.name} - e.g. when ${c.name} has left the team`,
      onClick: async () => {
        if (!(await askConfirm(`Release all ${n} accounts assigned to ${c.name}?\n\nThey become unassigned - anyone in the team can then take them.`, { okLabel: "Release all", cancelLabel: "Cancel" }))) return;
        try {
          const r = await send({ type: "TEAM_UNASSIGN_ALL", member: c.id });
          setText("team-member-sync", r.ok ? `${r.count} account${r.count === 1 ? "" : "s"} of ${c.name} released.` : "Could not release them - the team folder is not connected or not in sync.", !r.ok);
        } catch (err) { setText("team-member-sync", err.message, true); }
        renderTeamSettings();
      },
    });
  }
  // The deputy cannot remove the Team Lead (3.4); nobody removes themselves (they leave).
  if (current && !isSelf && c.id !== leads.lead) {
    items.push({
      label: "Remove from team…", danger: true,
      title: `Take ${c.name} off the team - e.g. an old membership, or a colleague who stopped without leaving`,
      onClick: async () => {
        if (!(await askConfirm(`Remove ${c.name} (last seen ${timeText(c.lastSeen) || "never"}) from the team?\n\n` +
          (n ? `Their ${n} assigned account${n === 1 ? "" : "s"} become${n === 1 ? "s" : ""} unassigned. ` : "") +
          `${c.name} is listed under Former members; what they changed stays in the team log. If their SalesTeam is still running, it stops sharing. To come back, they join the team again.`,
        { okLabel: "Remove from team", cancelLabel: "Cancel", danger: true }))) return;
        try {
          const r = await send({ type: "TEAM_REMOVE_MEMBER", member: c.id });
          setText("team-member-sync", r.ok ? `${c.name} removed from the team${r.count ? ` - ${r.count} account${r.count === 1 ? "" : "s"} released` : ""}.` : "Could not remove - the team folder is not connected or not in sync.", !r.ok);
        } catch (err) { setText("team-member-sync", err.message, true); }
        renderTeamSettings();
      },
    });
  }
  return items;
}

// Hand-over (design 3.3): the record is written and sent at once; this PC follows the new rule straight away.
async function onMakeLead(c, leads) {
  const deputyNote = leads.deputy && leads.deputy !== c.id ? " The deputy role ends with the hand-over." : "";
  if (!(await askConfirm(`Make ${c.name} Team Lead?\n\n${c.name} becomes Team Lead. You become a Member and see only the accounts of your groups. ` +
    `${c.name} can make you Team Lead again.${deputyNote}`, { okLabel: `Make ${c.name} Team Lead`, cancelLabel: "Cancel" }))) return;
  try {
    const r = await send({ type: "TEAM_MAKE_LEAD", member: c.id });
    setText("team-member-status", r.ok ? `${c.name} is Team Lead now. You are a Member.` : `Not changed: ${REFUSALS[r.reason] || r.error || "try again in a moment"}.`, !r.ok);
  } catch (err) { setText("team-member-status", err.message, true); }
  renderTeamSettings();
}

// Deputy (design 3.4, D15): c = the new deputy, or null with `ending` = the one whose deputy role ends.
async function onSetDeputy(c, ending, leads = null) {
  if (c) {
    const replaces = leads?.deputy ? ` This replaces the current deputy.` : "";
    if (!(await askConfirm(`Make ${c.name} deputy Team Lead?\n\nWhile deputy, ${c.name} has your rights: sees every account, edits groups, members and Setup, ` +
      `answers Decisions, reassigns and releases accounts. ${c.name} cannot remove you or name another deputy.${replaces}\n\n` +
      "When you are back, end it with ⋮ > End deputy - it needs nothing from them.", { okLabel: `Make ${c.name} deputy`, cancelLabel: "Cancel" }))) return;
  }
  try {
    const r = await send({ type: "TEAM_SET_DEPUTY", member: c ? c.id : null });
    const ok = c ? `${c.name} is deputy Team Lead now.` : `${ending.name} is a Member again.`;
    setText("team-member-status", r.ok ? ok : `Not changed: ${REFUSALS[r.reason] || r.error || "try again in a moment"}.`, !r.ok);
  } catch (err) { setText("team-member-status", err.message, true); }
  renderTeamSettings();
}

// ---- Invitations on the Team Lead's side (D17, 10a.1) ----

let addMemberFolder = "";

async function onAddMember() {
  const dlg = document.createElement("dialog");
  dlg.className = "team-group-dialog";
  const h = document.createElement("h3");
  h.textContent = "Add members";
  const intro = document.createElement("p");
  intro.className = "field-hint";
  intro.textContent = "Each colleague gets an invitation in the team folder. They accept it in Settings > Team > Join a team. " +
    "Groups are set after they have joined (⋮ next to the name > Groups…) - until then they are in Other.";
  const rows = inviteeEditor(1);
  const share = document.createElement("p");
  share.className = "field-hint";
  share.textContent = `Also share the folder${addMemberFolder ? ` "${addMemberFolder}"` : ""} with them in OneDrive (File Explorer > right-click the folder > Share, "Can edit") - SalesTeam cannot do that. They click Open in OneDrive's e-mail, then Add shortcut to My files.`;
  const msg = document.createElement("p");
  msg.className = "field-hint team-status";
  const actions = document.createElement("div");
  actions.className = "settings-buttons-row team-dialog-actions";
  const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: "Cancel" });
  const save = Object.assign(document.createElement("button"), { type: "button", textContent: "Save", className: "team-primary-btn" });
  actions.append(cancel, save);
  dlg.append(h, intro, rows.el, share, msg, actions);
  const done = () => { dlg.close(); dlg.remove(); };
  cancel.addEventListener("click", done);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(); });
  save.addEventListener("click", async () => {
    const list = rows.read();
    if (!list.length || list.some((x) => !x.name)) {
      msg.textContent = list.length ? "Every row needs a name - or remove the row." : "Enter a name first.";
      msg.classList.add("team-error");
      return;
    }
    save.disabled = true;
    const ok = [];
    const failed = [];
    for (const x of list) {
      try {
        const r = await send({ type: "TEAM_INVITE", name: x.name, email: x.email });
        (r.ok ? ok : failed).push(r.ok ? x.name : `${x.name} (${REFUSALS[r.reason] || r.error || "try again in a moment"})`);
      } catch (err) { failed.push(`${x.name} (${err.message})`); }
    }
    done();
    setText("team-member-status", [ok.length ? `Invited: ${ok.join(", ")}.` : "", failed.length ? `Not invited: ${failed.join(", ")}.` : ""].filter(Boolean).join(" "), Boolean(failed.length));
    renderTeamSettings();
  });
  document.body.append(dlg);
  dlg.showModal();
  dlg.querySelector("input")?.focus();
}

async function onCancelInvite(inv) {
  if (!(await askConfirm(`Cancel the invitation of ${inv.name}${inv.email ? ` (${inv.email})` : ""}?\n\n${inv.name} can then no longer join with it. You can invite again at any time (Add member…).`,
    { okLabel: "Cancel invitation", cancelLabel: "Keep it", danger: true }))) return;
  try {
    const r = await send({ type: "TEAM_CANCEL_INVITE", id: inv.id });
    setText("team-member-status", r.ok ? `The invitation of ${inv.name} is cancelled.`
      : r.reason === "accepted" ? `${inv.name} has already joined with this invitation.` : `Not cancelled: ${REFUSALS[r.reason] || r.error || "try again in a moment"}.`, !r.ok);
  } catch (err) { setText("team-member-status", err.message, true); }
  renderTeamSettings();
}

// D19: not in a team - an invitation waiting in OneDrive for this person replaces Create with "… has invited you". Looked
// for without asking Chrome (only when the OneDrive folder is already allowed), at most once a minute.
let soloScan = null;
async function paintSoloInvitation() {
  if (Date.now() - invitedCache.at > 60000 && !soloScan) {
    soloScan = (async () => {
      const oneDrive = await oneDriveFolderIfAllowed();
      invitedCache = { at: Date.now(), teams: oneDrive ? await withInvitations(await findTeams(oneDrive)) : [] };
    })().catch(() => { invitedCache = { at: Date.now(), teams: [] }; }).finally(() => { soloScan = null; });
    await soloScan;
  }
  const mine = invitedCache.teams.find((t) => t.mine.length);
  $("team-solo-invited").hidden = !mine;
  $("team-solo-create").hidden = Boolean(mine);
  // Boaz (1.2.2.8 test): one Join button - the invitation's.
  $("team-solo-join").hidden = Boolean(mine);
  if (mine) setText("team-solo-invited-text", `${mine.mine[0].byName || "Your Team Lead"} has invited you to ${mine.team.name}.`);
}

function onSoloInvitedJoin() {
  const i = invitedCache.teams.findIndex((t) => t.mine.length);
  showFlow("join");
  // Boaz (1.2.2.8 test): the top bar's Join… greys out - it was pressed already.
  inviteLookedAt = 0;
  paintTeamInvitation().catch(() => {});
  $("team-section").scrollIntoView({ block: "start" });
  showTeams(invitedCache.teams, "onedrive");
  if (i > 0) { $("team-join-team").value = String(i); showInvitesOf(i); }
}

let rendering = false;
let formerOpen = false; // Former members folded open - kept across the 5 s redraws

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
      $("team-add-member-btn").hidden = true;
      if ($("team-create").hidden && $("team-join").hidden) {
        $("team-solo").hidden = false;
        if (!section.hidden) await paintSoloInvitation().catch(() => {});
      }
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
    // Boaz 2026-10-08: the Team Lead does not leave the team they lead - they close it (D16), or hand over first.
    $("team-leave-btn").hidden = m.memberId === leads.lead;
    $("team-close-btn").hidden = m.memberId !== leads.lead;
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
        `Last written: ${st.lastFlushAt ? timeText(st.lastFlushAt) : "no changes yet"} · colleagues' changes last read: ${timeText(st.lastReadAt)}.`,
      ];
      if (st.lastError) lines.push(`Last problem: ${st.lastError}${st.errorSince ? ` (since ${timeText(st.errorSince)})` : ""}. SalesTeam tries again by itself.`);
      setText("team-member-sync", lines.join("\n"), Boolean(st.lastError));
      // Step 5 (R6.4): how many accounts each member has. 1.2.3 step 1 (design 10.1, D10): the actions are in a ⋮ per
      // row (Make Team Lead…, Make deputy… / End deputy, Groups…, Release all, Remove from team…), plus a Groups column.
      let counts = {};
      try { counts = (await send({ type: "TEAM_ASSIGN_COUNTS" })).counts || {}; } catch { /* the column stays empty */ }
      const isLead = m.memberId === leads.lead;
      const hasRights = isLead || m.memberId === leads.deputy;
      const current = (st.members || []).filter((c) => !c.left && !c.removed);
      const team = [m.memberId, ...current.map((c) => c.id)].sort();
      const names = { [m.memberId]: m.name };
      for (const c of st.members || []) names[c.id] = c.name;
      const groups = (await chrome.storage.local.get("teamGroups")).teamGroups || {};
      const index = groupIndex(groups, team);
      const groupNames = Object.fromEntries([...index.live.map((g) => [g.id, g.name]), [OTHER_GROUP, "Other"]]);
      const groupsText = (id) => (index.on ? (index.ofMember[id] || [OTHER_GROUP]).map((g) => groupNames[g] || g).join(", ") : "");
      const gctx = { team, names, leads: { lead: leads.lead, deputy: leads.deputy }, me: m.memberId, canEdit: hasRights };
      const table = $("team-members-table");
      table.replaceChildren(memberRow(["Name", "Role", "Groups", "Last seen", "", "Accounts assigned", ""]));
      table.firstChild.classList.add("team-members-head");
      const actionsCell = (c, isSelf) => {
        const td = document.createElement("td");
        const items = memberMenuItems(c, { isSelf, isLead, hasRights, leads, counts, gctx, current: !c.left && !c.removed });
        if (items.length) td.append(kebabButton(`member-${c.id}`, `Actions for ${c.name}`, () => items));
        return td;
      };
      const assignedCell = (id, left) => {
        const td = document.createElement("td");
        td.textContent = String(counts[id] || 0);
        // R8.2: a member with groups and nothing assigned - work may be waiting.
        if (index.on && !left && !counts[id] && id !== leads.lead) td.append(Object.assign(document.createElement("span"), { className: "team-warn", textContent: "nothing assigned" }));
        return td;
      };
      const self = memberRow([`${m.name} (you)`, role, groupsText(m.memberId), "now", connected ? "online" : "not connected"]);
      self.append(assignedCell(m.memberId, false), actionsCell({ id: m.memberId, name: m.name }, true));
      table.append(self);
      // 1.2.3 step 1b (D17): open invitations as "Invited", after the current members and before the former ones.
      const invited = openInvites(Object.fromEntries((st.invites || []).map((i) => [i.id, i])));
      let invitedShown = false;
      const showInvited = () => {
        if (invitedShown) return;
        invitedShown = true;
        for (const inv of invited) {
          const row = memberRow([inv.name, "Invited", "", `invited ${dayText(inv.at)}${inv.byName ? ` by ${inv.byName}` : ""}`, inv.email || "", ""]);
          row.classList.add("team-invited-row");
          const td = document.createElement("td");
          if (hasRights) td.append(kebabButton(`invite-${inv.id}`, `Actions for ${inv.name}`, () => [{ label: "Cancel invitation…", danger: true, onClick: () => onCancelInvite(inv) }]));
          row.append(td);
          table.append(row);
        }
      };
      $("team-add-member-btn").hidden = !hasRights;
      addMemberFolder = handle?.name || "";
      const listed = (st.members || []).filter((c) => !c.left);
      for (const c of listed) {
        const row = memberRow([c.name, roleOf(c.id), groupsText(c.id), timeText(c.lastSeen), c.online ? "online" : ""]);
        row.append(assignedCell(c.id, false), actionsCell(c, false));
        table.append(row);
      }
      showInvited();
      // Boaz (1.2.2.8 test): each former member once - their latest leaving (one still holding accounts first) - and
      // not at all when they are back in the team; the list folded behind "Former members (n)".
      const who = (name) => personKey(name).replace(/[^a-z0-9]/g, ""); // "Member 2" = "member2"
      const here = new Set([m.name, ...listed.map((c) => c.name)].map(who));
      const formerBy = new Map();
      for (const c of (st.members || []).filter((x) => x.left)) {
        const k = who(c.name);
        if (here.has(k)) continue;
        const was = formerBy.get(k);
        const holds = (x) => Boolean(counts[x.id]);
        if (!was || (holds(c) !== holds(was) ? holds(c) : (c.left || 0) > (was.left || 0))) formerBy.set(k, c);
      }
      const former = [...formerBy.values()].sort((x, y) => (y.left || 0) - (x.left || 0));
      if (former.length) {
        const head = memberRow([`${formerOpen ? "▾" : "▸"} Former members (${former.length})`, "", "", "", "", "", ""]);
        head.classList.add("team-members-head", "team-former-toggle");
        head.style.cursor = "pointer";
        head.addEventListener("click", () => { formerOpen = !formerOpen; renderTeamSettings(); });
        table.append(head);
        if (formerOpen) {
          for (const c of former) {
            const row = memberRow([c.name, "", "", `${c.removed ? "removed" : "left"} ${timeText(c.left)}`, ""]);
            row.style.color = "#8a8f98";
            row.append(assignedCell(c.id, true), actionsCell(c, false));
            table.append(row);
          }
        }
      }
      if (!(st.members || []).length && !invited.length) table.append(memberRow(["No colleague has joined yet - invite them with Add member….", "", "", "", "", "", ""]));
      // The group counts read every account: only while the card is on screen (the 5 s redraw then keeps them fresh).
      if (!section.hidden) renderTeamGroups(gctx).catch((err) => setText("team-member-status", `Groups: ${err.message}`, true));
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
  $("team-show-create-btn").addEventListener("click", onShowCreate);
  $("team-show-join-btn").addEventListener("click", () => {
    $("team-join-choose").hidden = true;
    $("team-find-row").hidden = false;
    $("team-find-btn").hidden = false;
    $("team-join-intro").hidden = false;
    $("team-join-row").hidden = true;
    $("team-join-title").textContent = "Join a team";
    showFlow("join");
  });
  $("team-solo-invited-btn").addEventListener("click", onSoloInvitedJoin);
  document.querySelectorAll("#team-section .team-cancel-btn").forEach((b) => b.addEventListener("click", () => {
    picked.create = null;
    picked.join = null;
    setText("team-create-status", "");
    setText("team-join-status", "");
    showFlow(null);
    inviteLookedAt = 0;
    paintTeamInvitation().catch(() => {});
    renderTeamSettings();
  }));
  $("team-create-btn").addEventListener("click", () => onCreate());
  $("team-create-onedrive-btn").addEventListener("click", onChooseCreateFolder);
  $("team-find-btn").addEventListener("click", () => onFindTeams());
  $("team-join-team").addEventListener("change", (e) => showInvitesOf(Number(e.target.value)));
  $("team-join-btn").addEventListener("click", onJoin);
  $("team-add-member-btn").addEventListener("click", onAddMember);
  $("team-leave-btn").addEventListener("click", onLeave);
  $("team-close-btn").addEventListener("click", onClose);
  $("team-repick-btn").addEventListener("click", onRepick);
  $("team-reconnect-btn").addEventListener("click", async () => {
    const p = await reconnect();
    setText("team-member-status", p === "granted" ? "Reconnected." : "Not reconnected - Chrome did not allow it.", p !== "granted");
    renderTeamSettings();
    paintTeamBar().catch(() => {});
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[MEMBERSHIP_KEY]) return;
    // 1.2.2.7: membership ended (left, removed, team closed) - nothing started on this page for the old team still counts;
    // the Create and Join buttons are usable again.
    if (!changes[MEMBERSHIP_KEY].newValue) {
      flowBusy = false;
      picked.create = null;
      picked.join = null;
      $("team-create-btn").disabled = false;
      $("team-join-btn").disabled = false;
      setText("team-create-status", "");
      setText("team-join-status", "");
      showFlow(null);
    }
    renderTeamSettings();
  });
  // The colleagues' "last seen" and the waiting count move on their own: every 5 s while the card is on screen, every
  // 30 s otherwise (the menu badge).
  let ticks = 0;
  setInterval(() => { ticks += 1; if (!$("team-section").hidden || ticks % 6 === 0) renderTeamSettings(); }, 5000);
  renderTeamSettings();
  // From the top bar's "… has invited you - Join…": straight to the team list with the invitation ticked.
  if (new URLSearchParams(location.search).get("team") === "join") {
    history.replaceState(null, "", location.pathname + location.hash);
    invitedCache.at = 0;
    paintSoloInvitation().then(() => { if (invitedCache.teams.some((t) => t.mine.length)) onSoloInvitedJoin(); }).catch(() => {});
  }
}
