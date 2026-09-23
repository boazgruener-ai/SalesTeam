// SalesTeam runs ONE batch process at a time (a scan, a discovery, web research of many accounts, an AI prioritization...):
// several at once would compete for the browser, the LinkedIn activity budget and the API key. Whoever starts a batch
// registers it here; anyone starting another one is told, by name, what is already running.
//
// A running batch also holds a Web Lock named after it. The browser releases that lock the moment the holder's page is
// closed or crashes, or its background worker is stopped, so a dead batch stops counting as running at once. Where Web
// Locks are not available, the record's heartbeat is used instead (a batch counts as dead after STALE_MS without one).
const ACTIVE_BATCH_KEY = "activeBatchJob";
export const BULK_STATE_KEY = "bulkResearchState";
const HEARTBEAT_MS = 15000;
const STALE_MS = 180000; // background tabs may throttle timers to about once a minute

export class BatchBusyError extends Error {
  constructor(message, running) {
    super(message);
    this.name = "BatchBusyError";
    this.running = running;
  }
}

const lockName = (id) => `salesteam-batch-${id}`;

export async function getRunningBatch() {
  const record = (await chrome.storage.local.get(ACTIVE_BATCH_KEY))[ACTIVE_BATCH_KEY];
  if (!record) return null;
  if (record.hasLock && navigator.locks) {
    const { held } = await navigator.locks.query();
    return held.some((l) => l.name === lockName(record.id)) ? record : null;
  }
  return Date.now() - (record.heartbeatAt || 0) > STALE_MS ? null : record;
}

export function busyMessage(running, newLabel) {
  return `SalesTeam only allows one batch process at a time.\n\nYou are currently running: ${running.label}.\n\n` +
    `Please stop it, or wait for it to finish, before you start: ${newLabel}.`;
}

// Shows the explanation and returns false when another batch is running; returns true when the way is free.
export async function guardBatchStart(newLabel, askConfirm) {
  const running = await getRunningBatch();
  if (!running) return true;
  await askConfirm(busyMessage(running, newLabel), { okLabel: "OK", cancelLabel: "Close" });
  return false;
}

// Registers a running batch; returns an async release function. Throws BatchBusyError when another one is running.
export async function acquireBatch(label) {
  const running = await getRunningBatch();
  if (running) throw new BatchBusyError(busyMessage(running, label), running);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, label, startedAt: Date.now(), heartbeatAt: Date.now(), hasLock: !!navigator.locks };
  let releaseLock = null;
  if (navigator.locks) {
    await new Promise((resolve) => {
      navigator.locks.request(lockName(id), () => new Promise((release) => { releaseLock = release; resolve(); }));
    });
  }
  await chrome.storage.local.set({ [ACTIVE_BATCH_KEY]: record });
  const timer = setInterval(() => {
    record.heartbeatAt = Date.now();
    chrome.storage.local.set({ [ACTIVE_BATCH_KEY]: record }).catch(() => {});
  }, HEARTBEAT_MS);
  return async () => {
    clearInterval(timer);
    if (releaseLock) releaseLock();
    try {
      const current = (await chrome.storage.local.get(ACTIVE_BATCH_KEY))[ACTIVE_BATCH_KEY];
      if (current && current.id === id) await chrome.storage.local.remove(ACTIVE_BATCH_KEY);
    } catch { /* the heartbeat runs out by itself */ }
  };
}

export async function withBatch(label, fn) {
  const release = await acquireBatch(label);
  try {
    return await fn();
  } finally {
    await release();
  }
}
