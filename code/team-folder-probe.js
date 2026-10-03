// Team use, build step 0 (TEAM_USE_DESIGN.md 2.5 and 8.2): can the BACKGROUND worker use a folder handle that a
// SalesTeam page picked and was granted? The answer decides whether team sync can run with no page open.
// The test page (zz_team_spike.html, a developer file left out of the store package) stores the handle in this
// IndexedDB and asks the background to try it; the result lands in chrome.storage.local.teamSpikeSwProbe.
const DB_NAME = "salesteam-team-spike";
const STORE = "handles";
const KEY = "folder";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storedHandle() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function probeTeamFolderFromBackground(tag) {
  const result = { at: new Date().toISOString(), tag, context: "background" };
  try {
    const handle = await storedHandle();
    if (!handle) {
      result.error = "No folder picked yet";
    } else {
      result.permission = typeof handle.queryPermission === "function"
        ? await handle.queryPermission({ mode: "readwrite" })
        : "queryPermission not available here";
      const dir = await handle.getDirectoryHandle("probe", { create: true });
      const file = await dir.getFileHandle(`background-${tag}-${Date.now()}.json`, { create: true });
      if (typeof file.createWritable !== "function") {
        result.error = "createWritable not available in the background worker";
      } else {
        const writable = await file.createWritable();
        await writable.write(JSON.stringify(result));
        await writable.close();
        result.wrote = true;
      }
    }
  } catch (err) {
    result.error = `${err?.name || "Error"}: ${err?.message || err}`;
  }
  await chrome.storage.local.set({ teamSpikeSwProbe: result });
  return result;
}
