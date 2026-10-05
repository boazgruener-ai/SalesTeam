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
  await tx(HANDLES, "readwrite", (s) => { s.delete(FOLDER_KEY); });
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
