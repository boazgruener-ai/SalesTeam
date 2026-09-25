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

const PIPELINE_STATE_KEY = "pipelineState"; // pipeline-runner.js
const PIPELINE_YIELD_WAIT_MS = 150000;
const NOTE_MIN_MS = 3000;

async function pipelineRunning() {
  const s = (await chrome.storage.local.get(PIPELINE_STATE_KEY))[PIPELINE_STATE_KEY];
  return Boolean(s) && s.status === "running";
}

// A small note in the corner while the user's job waits for the pipeline to make way.
function showWaitNote(text) {
  if (typeof document === "undefined" || !document.body) return { remove() {} };
  const note = document.createElement("div");
  note.setAttribute("role", "status");
  note.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483001;background:#fff;" +
    "border:1px solid #c9d7e8;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);padding:8px 14px;font:13px system-ui,sans-serif;color:#1a1a1a;";
  note.textContent = text;
  document.body.append(note);
  return note;
}

// Step 3 touch-up U2: the automatic pipeline makes way for any job the user starts. It stops after the
// account in progress (usually well under a minute) and stays out of the way until this job has begun.
// Resolves with whatever still blocks the way afterwards (null when free).
async function waitForPipelineToMakeWay(newLabel) {
  chrome.runtime.sendMessage({ type: "PIPELINE_PAUSE", forLabel: newLabel }).catch(() => {});
  const note = showWaitNote("Waiting for SalesTeam to finish the account in progress…");
  const shownAt = Date.now();
  // Between two accounts the pipeline stops almost at once, and a note that flashes for a moment is not
  // seen (first live test). It stays at least NOTE_MIN_MS, saying what happened.
  const settle = async (result) => {
    note.textContent = "SalesTeam paused its automatic account preparation for your job. It carries on by itself when your job is done.";
    const left = NOTE_MIN_MS - (Date.now() - shownAt);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    return result;
  };
  try {
    const until = Date.now() + PIPELINE_YIELD_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const running = await getRunningBatch();
      if (running && !running.pipeline) return running;
      if (!running && !(await pipelineRunning())) return settle(null);
    }
    return await getRunningBatch();
  } finally {
    note.remove();
  }
}

// Shows the explanation and returns false when another batch is running; returns true when the way is free.
// The data pipeline never blocks the user: it is asked to make way instead (U2).
export async function guardBatchStart(newLabel, askConfirm) {
  let running = await getRunningBatch();
  if ((running && running.pipeline) || (!running && (await pipelineRunning()))) running = await waitForPipelineToMakeWay(newLabel);
  // Even with no pipeline run in progress, keep the next automatic one from starting in the moment
  // between this check and the job taking the batch lock (the Scanner makes a backup first).
  else if (!running) chrome.runtime.sendMessage({ type: "PIPELINE_PAUSE", forLabel: newLabel }).catch(() => {});
  if (!running) return true;
  await askConfirm(busyMessage(running, newLabel), { okLabel: "OK", cancelLabel: "Close" });
  return false;
}

// Registers a running batch; returns an async release function. Throws BatchBusyError when another one is running.
// `pipeline` marks the data pipeline's own per-account batches: a user's job asks those to make way.
export async function acquireBatch(label, { pipeline = false } = {}) {
  const running = await getRunningBatch();
  if (running) throw new BatchBusyError(busyMessage(running, label), running);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, label, startedAt: Date.now(), heartbeatAt: Date.now(), hasLock: !!navigator.locks, ...(pipeline ? { pipeline: true } : {}) };
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

export async function withBatch(label, fn, options) {
  const release = await acquireBatch(label, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
