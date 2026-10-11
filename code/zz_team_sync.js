// Team use step 2 test page (TEAM_USE_DESIGN.md 11). Developer file: zz_ files are left out of the store package.
import { pickTeamFolder, getTeamFolder, teamFolderPermission, requestTeamFolderPermission } from "./team-folder.js";
import { classifyStorageKey } from "./team-keys.js";
import { backupNow } from "./backup-restore.js";

const $ = (id) => document.getElementById(id);
const show = (id, text) => { $(id).textContent = typeof text === "string" ? text : JSON.stringify(text, null, 2); };
const send = async (msg) => {
  const r = await chrome.runtime.sendMessage(msg);
  if (r === undefined) throw new Error(`No answer from the background for ${msg.type} - is the new version loaded (Reload on chrome://extensions)?`);
  return r;
};
const time = (ms) => (ms ? new Date(ms).toLocaleTimeString() : "never");

async function folderLine() {
  const handle = await getTeamFolder();
  if (!handle) return "No folder picked yet.";
  return `Folder "${handle.name}" - permission: ${await teamFolderPermission(handle)}`;
}

// What this profile's own storage holds right now - independent of the sync layer's view.
async function localLine() {
  const d = await chrome.storage.local.get(["targetAccountsWorkbook", "targetAccounts", "results", "onboardingCompletedAt", "teamMembership"]);
  const wb = d.targetAccountsWorkbook;
  return `This profile's data: ${wb ? (wb.companies || []).length : "no"} workbook companies, ${wb ? (wb.contacts || []).length : 0} contacts, `
    + `${Object.keys(d.targetAccounts || {}).length} targetAccounts entries, ${Object.keys(d.results || {}).length} leads; `
    + `setup completed: ${d.onboardingCompletedAt ? "yes" : "NO"}; membership stored: ${d.teamMembership ? d.teamMembership.name : "none"}`;
}

async function refresh() {
  $("local").textContent = await localLine().catch((err) => `Could not read local data: ${err.message}`);
  try {
    const st = await send({ type: "TEAM_SYNC_STATUS" });
    if (!st || !st.member) {
      $("state").textContent = "Not in a team.";
      $("state").className = "";
      $("members").innerHTML = "";
      show("status-out", await folderLine());
      return;
    }
    const ok = st.folder === "granted" && !st.lastError;
    $("state").className = ok ? "ok" : "bad";
    $("state").textContent = `${st.me.name} in "${st.me.teamName}" (${st.me.role}) - folder: ${st.folder}`
      + ` - waiting to send: ${st.outbox}${st.inflight ? ` (+ file ${st.inflight.n} being written)` : ""}`
      + ` - files written: ${st.lastWrittenN}`;
    const rows = st.members.map((m) => `<tr><td>${m.name}</td><td>${m.id}</td><td>${time(m.lastSeen)}</td><td>${m.cursor}</td><td>${time(m.readUpTo)}</td></tr>`);
    $("members").innerHTML = rows.length
      ? `<table><tr><th>Colleague</th><th>Id</th><th>Last seen</th><th>Files read</th><th>Read up to</th></tr>${rows.join("")}</table>`
      : "<p class='hint'>No colleague has joined yet.</p>";
    const measures = (st.measures || []).slice(-12).reverse()
      .map((m) => `${time(m.at)}  ${m.kind.padEnd(7)} ${Object.entries(m).filter(([k]) => !["at", "kind"].includes(k)).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    show("status-out", [
      `Last sent: ${time(st.lastFlushAt)}   last read: ${time(st.lastReadAt)}   last heartbeat: ${time(st.lastHeartbeatAt)}`,
      `Team picture: ${Object.entries(st.entities).map(([e, n]) => `${n} ${e}`).join(", ")}`,
      st.lastError ? `LAST ERROR: ${st.lastError}` : "No error.",
      "",
      "Recent work (newest first; ms = time taken):",
      ...measures,
    ].join("\n"));
  } catch (err) {
    show("status-out", `Could not read the status: ${err.message}`);
  }
}

$("sync-now").addEventListener("click", async () => {
  $("sync-now").disabled = true;
  try { show("status-out", await send({ type: "TEAM_SYNC_NOW" })); } finally { $("sync-now").disabled = false; refresh(); }
});

$("pick").addEventListener("click", async () => {
  try {
    const handle = await pickTeamFolder();
    show("folder-out", handle ? await folderLine() : "Cancelled.");
  } catch (err) {
    show("folder-out", `Error: ${err.message}`);
  }
});

$("reconnect").addEventListener("click", async () => {
  const handle = await getTeamFolder();
  if (!handle) { show("folder-out", "No folder picked yet."); return; }
  await requestTeamFolderPermission(handle);
  show("folder-out", await folderLine());
  refresh();
});

async function backupFirst(out) {
  show(out, "Taking a full backup first…");
  try {
    const r = await backupNow();
    return `Backup saved: ${r.fileName} (${r.where}).`;
  } catch (err) {
    if (!confirm(`The backup failed (${err.message}). Continue without a backup?`)) throw new Error("Stopped - no backup.");
    return "No backup (you chose to continue).";
  }
}

$("create").addEventListener("click", async () => {
  const name = $("create-name").value.trim();
  if (!name) { show("create-out", "Enter your name first."); return; }
  $("create").disabled = true;
  try {
    const b = await backupFirst("create-out");
    show("create-out", `${b}\nCreating the team…`);
    const r = await send({ type: "TEAM_CREATE", name, teamName: $("create-team").value.trim() || "SalesTeam Team" });
    show("create-out", `${b}\n${JSON.stringify(r, null, 2)}`);
  } catch (err) {
    show("create-out", `Error: ${err.message}`);
  } finally {
    $("create").disabled = false;
    refresh();
  }
});

$("join").addEventListener("click", async () => {
  const name = $("join-name").value.trim();
  if (!name) { show("join-out", "Enter your name first."); return; }
  if (!confirm("Joining replaces this profile's accounts, contacts, leads and shared settings with the team's. Continue?")) return;
  $("join").disabled = true;
  try {
    const b = await backupFirst("join-out");
    show("join-out", `${b}\nJoining…`);
    const r = await send({ type: "TEAM_JOIN", name });
    show("join-out", `${b}\n${JSON.stringify(r, null, 2)}`);
  } catch (err) {
    show("join-out", `Error: ${err.message}`);
  } finally {
    $("join").disabled = false;
    refresh();
  }
});

$("leave").addEventListener("click", async () => {
  if (!confirm("Leave the team? Your data stays as it is now; syncing stops.")) return;
  show("leave-out", await send({ type: "TEAM_LEAVE" }));
  refresh();
});

$("measure-groups").addEventListener("click", async () => {
  show("groups-out", "Measuring…");
  try {
    const r = await send({ type: "TEAM_MEASURE_GROUPS" });
    if (!r.ok) { show("groups-out", r); return; }
    show("groups-out", [
      `${r.accounts} accounts, ${r.groups} sample groups.`,
      ...r.runs.map((x, i) => `Run ${i + 1}: reading the accounts ${x.views_ms} ms, working out the groups ${x.groups_ms} ms`),
      "",
      `Accounts per group: ${Object.entries(r.counts).map(([g, n]) => `${g} ${n}`).join(", ")}`,
      r.lead ? `Team Lead: ${r.lead.lead || "-"}${r.lead.deputy ? `, deputy: ${r.lead.deputy}` : ""} (${r.lead.fromFolder ? "from the team folder" : "folder not read yet"})` : "Not in a team.",
    ].join("\n"));
  } catch (err) { show("groups-out", `Could not measure: ${err.message}`); }
});

$("keys").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const unclassified = Object.keys(all).filter((k) => classifyStorageKey(k) === "unclassified").sort();
  show("keys-out", unclassified.length ? unclassified.join("\n") : "None - every key is classified.");
});

refresh();
setInterval(refresh, 3000);
