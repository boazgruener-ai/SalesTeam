// Team use step 0 test page (TEAM_USE_DESIGN.md 11). Developer file: zz_ files are left out of the store package.
const DB_NAME = "salesteam-team-spike";
const STORE = "handles";
const KEY = "folder";
const $ = (id) => document.getElementById(id);
const show = (id, text) => { $(id).textContent = text; };

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

async function member() {
  const { teamSpikeMember } = await chrome.storage.local.get("teamSpikeMember");
  if (teamSpikeMember) return teamSpikeMember;
  const created = { id: `m-${Math.random().toString(36).slice(2, 8)}`, name: "" };
  await chrome.storage.local.set({ teamSpikeMember: created });
  return created;
}

async function folder({ ask = false } = {}) {
  const handle = await idb("readonly", (s) => s.get(KEY));
  if (!handle) throw new Error("No folder picked yet - use section 2.");
  let state = await handle.queryPermission({ mode: "readwrite" });
  if (state !== "granted" && ask) state = await handle.requestPermission({ mode: "readwrite" });
  if (state !== "granted") throw new Error(`Folder permission is "${state}" - click Reconnect in section 2.`);
  return handle;
}

async function subdir(root, parts) {
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir;
}

async function writeJson(root, parts, name, obj) {
  const dir = await subdir(root, parts);
  const file = await dir.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  await w.write(JSON.stringify(obj));
  await w.close();
}

// Every file under members/, with its path; also collects any name that looks like a temporary/conflict file.
async function readAll(root, { readContents = true } = {}) {
  const out = { files: [], odd: [] };
  const members = await subdir(root, ["members"]);
  async function walk(dir, path) {
    for await (const [name, h] of dir.entries()) {
      const p = `${path}/${name}`;
      if (h.kind === "directory") { await walk(h, p); continue; }
      // Anything not named the way this page names files is a temporary file or an OneDrive conflict copy.
      if (!/^(c-\d+|bulk-\d+|claim-account-race-\d+)\.json$/.test(name)) out.odd.push(p);
      if (!readContents) { out.files.push({ path: p }); continue; }
      try {
        const text = await (await h.getFile()).text();
        out.files.push({ path: p, data: JSON.parse(text) });
      } catch (err) {
        out.files.push({ path: p, error: err.message });
      }
    }
  }
  await walk(members, "members");
  return out;
}

function fail(id, err) { show(id, `FAILED: ${err?.name ? `${err.name}: ` : ""}${err?.message || err}`); }

// --- 1. member
async function paintMember() {
  const m = await member();
  $("member-name").value = m.name || "";
  show("member-out", `Member id: ${m.id}\nName: ${m.name || "(not set)"}`);
}
$("save-name").addEventListener("click", async () => {
  const m = await member();
  m.name = $("member-name").value.trim();
  await chrome.storage.local.set({ teamSpikeMember: m });
  paintMember();
});

// --- 2. folder
async function paintFolder() {
  const handle = await idb("readonly", (s) => s.get(KEY)).catch(() => null);
  if (!handle) { show("folder-out", "No folder picked yet."); return; }
  const state = await handle.queryPermission({ mode: "readwrite" }).catch((e) => `error ${e.message}`);
  show("folder-out", `Folder: ${handle.name}\nPermission right now, without asking: ${state}` +
    (state === "granted" ? "" : "\n-> Click Reconnect."));
}
$("pick").addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: "salesteam-team", mode: "readwrite" });
    await idb("readwrite", (s) => s.put(handle, KEY));
    paintFolder();
  } catch (err) { if (err.name !== "AbortError") fail("folder-out", err); }
});
$("reconnect").addEventListener("click", async () => {
  try { await folder({ ask: true }); } catch (err) { fail("folder-out", err); return; }
  paintFolder();
});

// --- 3. write and read
$("write-one").addEventListener("click", async () => {
  try {
    const root = await folder();
    const m = await member();
    const { teamSpikeN = 0 } = await chrome.storage.local.get("teamSpikeN");
    const n = teamSpikeN + 1;
    await writeJson(root, ["members", m.id, "changes"], `c-${n}.json`,
      { member: m.id, name: m.name, n, written: new Date().toISOString() });
    await chrome.storage.local.set({ teamSpikeN: n });
    show("rw-out", `Wrote members/${m.id}/changes/c-${n}.json`);
  } catch (err) { fail("rw-out", err); }
});
$("read-all").addEventListener("click", async () => {
  try {
    const root = await folder();
    const t0 = performance.now();
    const all = await readAll(root);
    const changes = all.files.filter((f) => /\/changes\//.test(f.path));
    const lines = changes.map((f) => `${f.path}  ${f.data ? `${f.data.name || "?"} wrote at ${f.data.written}` : f.error}`);
    show("rw-out", `${changes.length} change file(s), read in ${Math.round(performance.now() - t0)} ms\n${lines.join("\n")}` +
      (all.odd.length ? `\n\nODD FILES (temporary or conflict copies):\n${all.odd.join("\n")}` : "\n\nNo odd files."));
  } catch (err) { fail("rw-out", err); }
});

// --- 4. race
$("race").addEventListener("click", async () => {
  try {
    const root = await folder();
    const m = await member();
    const at = Math.ceil((Date.now() + 1000) / 60000) * 60000;
    const entity = `account-race-${new Date(at).toISOString().slice(11, 16).replace(":", "")}`;
    show("race-out", `Will claim ${entity} at ${new Date(at).toLocaleTimeString()} …`);
    setTimeout(async () => {
      const stamp = Date.now();
      await writeJson(root, ["members", m.id, "claims"], `claim-${entity}.json`, { member: m.id, name: m.name, entity, stamp });
      show("race-out", `Claimed ${entity} at ${new Date(stamp).toISOString()} (+${stamp - at} ms). Deciding in 10 s …`);
      setTimeout(async () => {
        const all = await readAll(root);
        const claims = all.files.map((f) => f.data).filter((d) => d && d.entity === entity)
          .sort((a, b) => a.stamp - b.stamp || (a.member < b.member ? -1 : 1));
        const lines = claims.map((c, i) => `${i === 0 ? "WINNER " : "       "}${c.name || c.member}  ${new Date(c.stamp).toISOString()}`);
        const mine = claims[0]?.member === m.id;
        show("race-out", `${entity}: ${claims.length} claim(s) seen\n${lines.join("\n")}\n\nThis member ${mine ? "WON" : "LOST"}.` +
          (claims.length < 2 ? "\n(Only one claim seen - was the other profile clicked in the same minute?)" : ""));
      }, 10000);
    }, at - Date.now());
  } catch (err) { fail("race-out", err); }
});

// --- 5. many files
$("bulk").addEventListener("click", async () => {
  try {
    const root = await folder();
    const m = await member();
    show("bulk-out", "Writing 300 files …");
    const t0 = performance.now();
    for (let i = 1; i <= 300; i++) {
      await writeJson(root, ["members", m.id, "bulk"], `bulk-${i}.json`, { member: m.id, i, payload: "x".repeat(400) });
    }
    const tWrite = performance.now() - t0;
    const t1 = performance.now();
    const all = await readAll(root);
    const tRead = performance.now() - t1;
    show("bulk-out", `Wrote 300 files in ${Math.round(tWrite)} ms (${Math.round(tWrite / 300)} ms each).\n` +
      `Listed and read ${all.files.length} files (all members) in ${Math.round(tRead)} ms.\n` +
      (all.odd.length ? `ODD FILES:\n${all.odd.join("\n")}` : "No temporary or conflict files found.") +
      "\n\nNow look at the OneDrive cloud icon: it should say 'Up to date' within a minute, with no errors.");
  } catch (err) { fail("bulk-out", err); }
});

// --- 6. background
async function paintBackground() {
  const { teamSpikeSwProbe } = await chrome.storage.local.get("teamSpikeSwProbe");
  if (!teamSpikeSwProbe) { show("bg-out", "No background test run yet."); return; }
  const r = teamSpikeSwProbe;
  show("bg-out", `Last background test (${r.tag}) at ${r.at}\nPermission seen by the background: ${r.permission ?? "-"}\n` +
    (r.wrote ? "RESULT: the background WROTE into the folder." : `RESULT: the background could NOT write: ${r.error}`));
}
$("bg-close").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "TEAM_SPIKE_SW_PROBE", tag: "page-closed", delayMs: 10000 });
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id); else window.close();
});
$("bg-open").addEventListener("click", async () => {
  show("bg-out", "Asked the background; result in a moment …");
  await chrome.runtime.sendMessage({ type: "TEAM_SPIKE_SW_PROBE", tag: "page-open", delayMs: 0 });
  setTimeout(paintBackground, 1500);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.teamSpikeSwProbe) paintBackground();
});

paintMember();
paintFolder();
paintBackground();
