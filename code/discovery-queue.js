// Resumable multi-day Discovery scan queue (PRD 6.20 Phase 4). No precedent
// for this exists elsewhere in this codebase: scanAllTopics (background.js)
// has no cross-session resume at all - a stopped/interrupted scan always
// restarts from topic 1 - and Company Resolve/People Search instead use
// "skip already-done on a future full re-run" markers, not a real queue.
// This module owns just the state machine and its own chrome.storage.local
// calls directly (same pattern as linkedin-touch-log.js, not folded into
// storage.js's already-large surface) - it does NOT itself scan anything;
// Phase 5 (company discovery) and Phase 6 (contact discovery), not yet
// built, will call into this to checkpoint their own progress.
//
// Deliberately no chrome.alarms anywhere in this codebase, ever - resuming
// a multi-day run across sessions is always a deliberate "Continue
// Discovery Scan" click (resumeDiscoveryQueue below), never scheduled.
// Cooperative stop reuses the exact same scanAbortRequested storage flag
// every other scan loop already watches (background.js's checkAbort(),
// company-resolve-extraction.js, people-search-extraction.js) - this
// module doesn't duplicate that check itself, Phase 5/6's own loops will
// watch it the same way those already do.
const DISCOVERY_QUEUE_STATE_KEY = "discoveryQueueState";

function idleState() {
  return {
    status: "idle",
    configSnapshot: null,
    companyPhase: { nextSearchCursor: null, discoveredCompanyKeys: [] },
    contactPhase: { nextCompanyIndex: 0 },
    startedAt: null,
    lastResumedAt: null,
    completedAt: null,
  };
}

export async function getDiscoveryQueueState() {
  const data = await chrome.storage.local.get(DISCOVERY_QUEUE_STATE_KEY);
  return data[DISCOVERY_QUEUE_STATE_KEY] || idleState();
}

async function saveDiscoveryQueueState(state) {
  await chrome.storage.local.set({ [DISCOVERY_QUEUE_STATE_KEY]: state });
  return state;
}

// Starts a brand new run - always resets from idle (or overwrites a
// previous "done" run), never resumes an in-progress one; use
// resumeDiscoveryQueue for that. configSnapshot is deep-cloned and frozen
// here on purpose - a wizard edit made mid-run (e.g. via "Edit Setup")
// must never silently reconfigure a scan already under way; the new
// config only takes effect on the next fresh Start.
export async function startDiscoveryQueue(configSnapshot) {
  const now = Date.now();
  return saveDiscoveryQueueState({
    ...idleState(),
    status: "discovering_companies",
    configSnapshot: JSON.parse(JSON.stringify(configSnapshot)),
    startedAt: now,
    lastResumedAt: now,
  });
}

// Called every time the user reopens/continues an in-progress run via a
// deliberate click - never automatic. Only updates the resume timestamp;
// the actual resume point already lives in companyPhase/contactPhase, set
// by whichever phase's own checkpoint calls last ran. A no-op (returns the
// state unchanged) if there's nothing in progress to resume.
export async function resumeDiscoveryQueue() {
  const state = await getDiscoveryQueueState();
  if (state.status === "idle" || state.status === "done") return state;
  return saveDiscoveryQueueState({ ...state, lastResumedAt: Date.now() });
}

// Checkpointed after every company/page (Phase 5's own loop will call this
// once per iteration, not batched at the end) - so a mid-run stop, whether
// user-initiated or the shared touch budget kicking in, never loses more
// than one company's worth of progress. `update` is shallow-merged into
// companyPhase, so a caller can pass just the field(s) that changed
// (e.g. { nextSearchCursor } or { discoveredCompanyKeys }).
export async function checkpointCompanyPhase(update) {
  const state = await getDiscoveryQueueState();
  return saveDiscoveryQueueState({ ...state, companyPhase: { ...state.companyPhase, ...update } });
}

// Same idea for Phase 6's per-company contact-discovery loop.
export async function checkpointContactPhase(update) {
  const state = await getDiscoveryQueueState();
  return saveDiscoveryQueueState({ ...state, contactPhase: { ...state.contactPhase, ...update } });
}

// Company discovery (Phase 5) hands off to contact discovery (Phase 6) -
// companyPhase.discoveredCompanyKeys at this point is exactly the list
// Phase 6 will iterate from contactPhase.nextCompanyIndex.
export async function advanceToContactPhase() {
  const state = await getDiscoveryQueueState();
  return saveDiscoveryQueueState({ ...state, status: "discovering_contacts" });
}

export async function completeDiscoveryQueue() {
  const state = await getDiscoveryQueueState();
  return saveDiscoveryQueueState({ ...state, status: "done", completedAt: Date.now() });
}

// Fully resets back to idle - e.g. before a deliberate fresh restart, or
// once a completed run's results have been reviewed/merged (Phase 7,
// target-accounts.js's "Review & Merge Discovery Results…"). Does NOT
// itself clear discoveredCompanies/discoveredContacts - only
// warnIfDiscoveryNowStale's "Clear Current Discovery" (onboarding.js) does
// both together, since a queue reset alone (e.g. this function's own
// Settings-debug-panel "Reset" button) shouldn't silently discard staged
// results a user hasn't decided about yet.
export async function resetDiscoveryQueue() {
  return saveDiscoveryQueueState(idleState());
}
