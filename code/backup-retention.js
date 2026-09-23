// Retention for the DAILY backups in the user's backup folder. Deleting is irreversible, so this is deliberately
// narrow: it only ever looks inside the "Daily" subfolder, only at files whose names match SalesTeam's own daily
// naming exactly (salesteam-backup-YYYY-MM-DD_vX.Y.Z.zip), never at "Manual" or "Before-restore", and it never
// deletes the newest backup. The default policy keeps everything.
//
//   all    keep every backup (default)
//   smart  every daily backup for 30 days, then the newest of each week up to 6 months, then the newest of each month
//   year   every daily backup for 1 year, then delete
export const RETENTION_POLICIES = {
  all: { label: "Keep every backup", detail: "Nothing is ever deleted." },
  smart: { label: "Thin out older backups", detail: "Keeps every daily backup for 30 days, then one per week up to 6 months, then one per month." },
  year: { label: "Keep one year of daily backups", detail: "Keeps every daily backup for 1 year and deletes older ones." },
};

const DAILY_NAME = /^salesteam-backup-(\d{4})-(\d{2})-(\d{2})_v[\d.]+\.zip$/;
const MONTH_FOLDER = /^\d{4}-\d{2}$/;
const DAY_MS = 86400000;

export function parseDailyBackupDate(name) {
  const m = DAILY_NAME.exec(name);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Monday of the week the date falls in, as a sortable key
function weekKey(d) {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${monday.getFullYear()}-${monday.getMonth() + 1}-${monday.getDate()}`;
}

function monthKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

// files: { id, date }[]  ->  ids to delete. Pure (no file access) so it can be tested without a folder.
export function pickBackupsToDelete(files, policy, now = new Date()) {
  if (policy !== "smart" && policy !== "year") return [];
  if (files.length === 0) return [];
  const today = startOfDay(now).getTime();
  const age = (f) => Math.floor((today - startOfDay(f.date).getTime()) / DAY_MS);
  const newest = files.reduce((a, b) => (b.date > a.date || (+b.date === +a.date && b.id > a.id) ? b : a));
  const doomed = new Set();

  if (policy === "year") {
    for (const f of files) if (age(f) > 365) doomed.add(f.id);
  } else {
    const groups = new Map(); // band+group key -> files in it
    for (const f of files) {
      const a = age(f);
      if (a <= 30) continue; // recent: every daily backup stays
      const key = a <= 183 ? `w:${weekKey(f.date)}` : `m:${monthKey(f.date)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    for (const group of groups.values()) {
      const keep = group.reduce((a, b) => (b.date > a.date || (+b.date === +a.date && b.id > a.id) ? b : a));
      for (const f of group) if (f.id !== keep.id) doomed.add(f.id);
    }
  }
  doomed.delete(newest.id);
  return [...doomed];
}

// ---------------------------------------------------------------- folder access
async function dailyDirectory(handle) {
  try {
    return await handle.getDirectoryHandle("Daily");
  } catch {
    return null;
  }
}

// Daily backups directly in Daily/ (older layout) and inside Daily/YYYY-MM/ month folders.
export async function listDailyBackups(handle) {
  const daily = await dailyDirectory(handle);
  if (!daily) return [];
  const found = [];
  const scan = async (dir, parent) => {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === "file") {
        const date = parseDailyBackupDate(name);
        if (date) found.push({ id: `${parent ? parent.name + "/" : ""}${name}`, name, date, dir, parent, entry });
      } else if (entry.kind === "directory" && !parent && MONTH_FOLDER.test(name)) {
        await scan(entry, { name, dir: entry });
      }
    }
  };
  await scan(daily, null);
  return found;
}

async function sizeOf(item) {
  try {
    return (await item.entry.getFile()).size;
  } catch {
    return 0;
  }
}

// -> { total, bytes, wouldDelete, freedBytes } for showing what a policy would do, without deleting anything.
export async function describeRetention(handle, policy, now = new Date()) {
  const files = await listDailyBackups(handle);
  const doomedIds = new Set(pickBackupsToDelete(files, policy, now));
  let bytes = 0;
  let freedBytes = 0;
  for (const f of files) {
    const size = await sizeOf(f);
    bytes += size;
    if (doomedIds.has(f.id)) freedBytes += size;
  }
  return { total: files.length, bytes, wouldDelete: doomedIds.size, freedBytes };
}

// Deletes what the policy says to delete. -> { deleted, freedBytes }
export async function applyRetention(handle, policy, now = new Date()) {
  const files = await listDailyBackups(handle);
  const doomedIds = new Set(pickBackupsToDelete(files, policy, now));
  let deleted = 0;
  let freedBytes = 0;
  const touchedMonths = new Set();
  for (const f of files) {
    if (!doomedIds.has(f.id)) continue;
    const size = await sizeOf(f);
    try {
      await f.dir.removeEntry(f.name);
      deleted++;
      freedBytes += size;
      if (f.parent) touchedMonths.add(f.parent.name);
    } catch { /* leave a file that cannot be removed; never fail a backup over cleanup */ }
  }
  // tidy up month folders that are now empty (removeEntry refuses a non-empty folder, which is what we want)
  const daily = await dailyDirectory(handle);
  if (daily) {
    for (const month of touchedMonths) {
      try { await daily.removeEntry(month); } catch { /* not empty */ }
    }
  }
  return { deleted, freedBytes };
}
