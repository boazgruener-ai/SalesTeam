// Team use 1.2.2, build step 2 (TEAM_USE_DESIGN.md 2.6, 3, 8.2): the team folder adapter.
// Everything that touches the shared OneDrive folder goes through here, so a later move to Microsoft Graph
// (Option B, design 3.4) replaces this file and nothing else.
//
// Step 0 rules this file enforces:
//   - a write is retried (1 s, 3 s, 10 s) and only counts once a read-back returns exactly what was written
//     (OneDrive can fail a write with InvalidStateError and leave an empty file behind);
//   - a reader treats an empty or unparsable file as "not finished yet" - never as data, never as an error.
// The folder handle and the sync layer's own state live in IndexedDB ("salesteam-team"), not in
// chrome.storage.local: the merged state is several MB and must not wake every page's onChanged listener.

const DB_NAME = "salesteam-team";
const HANDLES = "handles";
const KV = "kv";
const FOLDER_KEY = "folder";
const RETRY_DELAYS_MS = [1000, 3000, 10000];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const result = fn(t.objectStore(store));
      t.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

// ---- the sync layer's own state (team-sync.js) ----

export async function teamDbGetAll(keys) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(KV, "readonly");
      const out = {};
      for (const k of keys) {
        const req = t.objectStore(KV).get(k);
        req.onsuccess = () => { out[k] = req.result; };
      }
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

// One transaction: either every entry is saved or none (outbox and state never disagree after a crash).
export async function teamDbPutAll(entries) {
  await tx(KV, "readwrite", (s) => {
    for (const [k, v] of Object.entries(entries)) s.put(v, k);
  });
}

export async function teamDbClear() {
  await tx(KV, "readwrite", (s) => { s.clear(); });
}

// ---- the folder handle ----

export async function getTeamFolder() {
  try {
    return (await tx(HANDLES, "readonly", (s) => s.get(FOLDER_KEY))) || null;
  } catch {
    return null;
  }
}

export async function saveTeamFolder(handle) {
  await tx(HANDLES, "readwrite", (s) => { s.put(handle, FOLDER_KEY); });
}

export async function clearTeamFolder() {
  await tx(HANDLES, "readwrite", (s) => { s.delete(FOLDER_KEY); s.delete(VIA_KEY); });
}

// ---- the OneDrive folder (1.2.3 step 1b, D18) ----
// Chrome lets SalesTeam use a folder only after the person picked it once. So Join and Create ask once for the OneDrive
// folder itself; teams are then found in it (Join) or made in it (Create), and the team folder is reached through it.
// VIA_KEY: the team folder was reached through the OneDrive folder - reconnecting then asks for the OneDrive folder.
const ONEDRIVE_KEY = "onedrive";
const VIA_KEY = "folderVia";

export async function getOneDriveFolder() {
  try {
    return (await tx(HANDLES, "readonly", (s) => s.get(ONEDRIVE_KEY))) || null;
  } catch {
    return null;
  }
}

export async function teamFolderVia() {
  try {
    return (await tx(HANDLES, "readonly", (s) => s.get(VIA_KEY))) || null;
  } catch {
    return null;
  }
}

// The team folder, reached through the OneDrive folder (or picked directly: via null).
export async function saveTeamFolderVia(handle, via) {
  await tx(HANDLES, "readwrite", (s) => {
    s.put(handle, FOLDER_KEY);
    if (via) s.put(via, VIA_KEY);
    else s.delete(VIA_KEY);
  });
}

// Page only, from a click: the stored OneDrive folder with permission asked for, or the picker the first time.
// Resolves to the handle, or null (cancelled / not allowed).
export async function oneDriveFolderFromClick({ repick = false } = {}) {
  let handle = repick ? null : await getOneDriveFolder();
  if (handle) {
    const p = await teamFolderPermission(handle);
    if (p === "granted" || (await requestTeamFolderPermission(handle)) === "granted") return handle;
    return null;
  }
  try {
    handle = await window.showDirectoryPicker({ id: "salesteam-onedrive", mode: "readwrite", startIn: "documents" });
  } catch (err) {
    if (err && err.name === "AbortError") return null;
    throw err;
  }
  await tx(HANDLES, "readwrite", (s) => { s.put(handle, ONEDRIVE_KEY); });
  return handle;
}

// The OneDrive folder without asking (null when there is none or it needs a click first).
export async function oneDriveFolderIfAllowed() {
  const handle = await getOneDriveFolder();
  if (!handle) return null;
  return (await teamFolderPermission(handle)) === "granted" ? handle : null;
}

// Every team in the OneDrive folder: the folder itself if it holds a team, and each folder up to two levels down that does
// (a shared folder added with "Add shortcut to My files" appears there). Closed teams are left out.
// -> [{ handle, folderName, team, invites: [invitation, …] }]
export async function findTeams(oneDrive) {
  const out = [];
  const look = async (handle) => {
    const team = await readTeamJson(handle, [], "team.json");
    if (team.status !== "ok" || !team.data?.teamId) return false;
    if ((await readTeamJson(handle, [], "closed.json")).status === "ok") return true;
    const invites = [];
    for (const n of await listTeamNames(handle, ["invites"], "file").catch(() => [])) {
      const r = await readTeamJson(handle, ["invites"], n);
      if (r.status === "ok" && r.data?.id) invites.push(r.data);
    }
    let creatorName = team.data.createdByName || null;
    if (!creatorName && team.data.createdBy) {
      const p = await readTeamJson(handle, ["members", team.data.createdBy], "profile.json");
      if (p.status === "ok") creatorName = p.data.name || null;
    }
    out.push({ handle, folderName: handle.name, team: team.data, creatorName, invites });
    return true;
  };
  await look(oneDrive);
  if (out.length) return out; // the OneDrive folder picked was a team folder itself
  // Two levels down (Boaz, 1.2.2.8 test: no "Choose a folder instead…" - a team folder kept inside another folder is
  // found too). A team's own folder is not searched further.
  const subfolders = async (dir) => {
    const list = [];
    for await (const [, h] of dir.entries()) if (h.kind === "directory" && !h.name.startsWith(".")) list.push(h);
    return list;
  };
  for (const handle of await subfolders(oneDrive)) {
    try {
      if (await look(handle)) continue;
      for (const inner of await subfolders(handle)) {
        try { await look(inner); } catch { /* skipped */ }
      }
    } catch { /* a folder OneDrive cannot open right now - skipped */ }
  }
  return out.sort((a, b) => String(a.team.name).localeCompare(String(b.team.name)));
}

// Create (D18): the team folder `name` inside the OneDrive folder. An existing empty folder of that name is used; one
// with something in it is refused. -> { handle, created }
export async function makeTeamFolder(oneDrive, name) {
  if ((await readTeamJson(oneDrive, [], "team.json")).status === "ok") {
    throw new Error(`"${oneDrive.name}" is a team folder, not your OneDrive folder. Choose the OneDrive folder itself (Choose your OneDrive folder again…).`);
  }
  let existing = null;
  try { existing = await oneDrive.getDirectoryHandle(name); } catch (err) { if (!isNotFound(err)) throw err; }
  if (existing) {
    const top = (await listTeamFolderTop(existing)).filter((n) => !n.startsWith(".") && n.toLowerCase() !== "desktop.ini");
    if (top.length) throw new Error(`There is already a folder "${name}" in "${oneDrive.name}", and it is not empty. Choose another team name.`);
    return { handle: existing, created: false };
  }
  return { handle: await oneDrive.getDirectoryHandle(name, { create: true }), created: true };
}

// Undo makeTeamFolder when creating the team did not go through (only while the folder is still empty).
export async function removeEmptyTeamFolder(oneDrive, name) {
  try {
    const dir = await oneDrive.getDirectoryHandle(name);
    if ((await listTeamFolderTop(dir)).length) return false;
    await oneDrive.removeEntry(name);
    return true;
  } catch {
    return false;
  }
}

// Page only, from a click. Resolves to the handle, or null if the user cancelled the picker. `save: false` leaves the
// stored folder as it is (Settings > Team checks the folder first and saves it with saveTeamFolder).
export async function pickTeamFolder({ save = true } = {}) {
  try {
    const handle = await window.showDirectoryPicker({ id: "salesteam-team", mode: "readwrite", startIn: "documents" });
    if (save) await saveTeamFolder(handle);
    return handle;
  } catch (err) {
    if (err && err.name === "AbortError") return null;
    throw err;
  }
}

// "granted" | "prompt" | "denied". In the background worker it is "granted" only while a SalesTeam page (or the
// side panel) is open - Chrome withdraws it when the last one closes (step 0).
export async function teamFolderPermission(handle) {
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

// Page only, from a click.
export async function requestTeamFolderPermission(handle) {
  try {
    return await handle.requestPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

// ---- files ----

const isNotFound = (err) => err && (err.name === "NotFoundError" || err.name === "TypeMismatchError");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dirAt(root, parts, create) {
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

// -> { status: "ok", data, text } | { status: "missing" } | { status: "incomplete" }
export async function readTeamJson(root, parts, name) {
  let text;
  try {
    const dir = await dirAt(root, parts, false);
    const file = await (await dir.getFileHandle(name)).getFile();
    text = await file.text();
  } catch (err) {
    if (isNotFound(err)) return { status: "missing" };
    return { status: "incomplete", error: `${err?.name || "Error"}: ${err?.message || err}` };
  }
  if (!text) return { status: "incomplete" };
  try {
    return { status: "ok", data: JSON.parse(text), text, bytes: text.length };
  } catch {
    return { status: "incomplete" };
  }
}

// Writes, reads back, retries. Throws only when every attempt failed (the caller keeps the data in its outbox).
export async function writeTeamJson(root, parts, name, obj) {
  const text = JSON.stringify(obj);
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const dir = await dirAt(root, parts, true);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      const back = await (await fh.getFile()).text();
      if (back === text) return { attempts: attempt + 1, bytes: text.length };
      lastErr = new Error(`read-back differs (${back.length} of ${text.length} bytes)`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not write ${[...parts, name].join("/")}: ${lastErr?.name || "Error"}: ${lastErr?.message || lastErr}`);
}

// Names in a folder ("file" or "directory"); a folder that does not exist yet has none.
export async function listTeamNames(root, parts, kind = "file") {
  const out = [];
  try {
    const dir = await dirAt(root, parts, false);
    for await (const [name, handle] of dir.entries()) if (handle.kind === kind) out.push(name);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return out.sort();
}

export async function removeTeamFile(root, parts, name) {
  try {
    const dir = await dirAt(root, parts, false);
    await dir.removeEntry(name);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

// Every entry at the top of the folder - "create a team" needs an empty folder.
export async function listTeamFolderTop(root) {
  const out = [];
  for await (const [name] of root.entries()) out.push(name);
  return out.sort();
}
