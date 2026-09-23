// The user-chosen backup folder. Chrome lets an extension page ask the user to pick a folder
// (showDirectoryPicker) and then write into it; the folder handle is remembered in IndexedDB. Chrome may
// ask again for permission after the browser restarts - that can only be granted from a click, which is
// why backup-restore.js shows a "click to resume" banner instead of failing silently.
const DB_NAME = "salesteam-backup";
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

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const folderPickerSupported = () => typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

export async function getStoredFolder() {
  try {
    return (await idb("readonly", (s) => s.get(KEY))) || null;
  } catch {
    return null;
  }
}

export async function clearStoredFolder() {
  await idb("readwrite", (s) => s.delete(KEY));
}

// Must be called from a click. Resolves to the handle, or null if the user cancelled the picker.
export async function pickBackupFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: "salesteam-backups", mode: "readwrite", startIn: "documents" });
    await idb("readwrite", (s) => s.put(handle, KEY));
    return handle;
  } catch (err) {
    if (err && err.name === "AbortError") return null;
    throw err;
  }
}

// "granted" | "prompt" | "denied"
export async function folderPermission(handle) {
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

// Must be called from a click.
export async function requestFolderPermission(handle) {
  try {
    return await handle.requestPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

// pathParts: one subfolder name or a list (e.g. ["Daily", "2026-09"]); created as needed.
export async function writeToFolder(handle, pathParts, fileName, blob) {
  let dir = handle;
  for (const part of [].concat(pathParts)) dir = await dir.getDirectoryHandle(part, { create: true });
  const file = await dir.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
}
