// Shared enforcement for linkedin-touch-log.js's daily budget (75 warn / 99
// hard stop) - one place every automated-LinkedIn-navigation module calls at
// its own per-item checkpoint, so the same threshold actually governs every
// feature (Post/Job/Target-Account scanning, Company Resolve, People Search,
// and the Target Account/Contact Discovery modules) instead of each one
// re-implementing its own check. Before this existed, hitting the danger
// threshold only recolored a status label - nothing actually stopped.
//
// Setting scanAbortRequested here (not just returning a boolean) is the
// point: every other module already watches that same storage key to stop
// cooperatively (background.js's checkAbort, company-resolve-extraction.js's
// shouldAbort), so one module hitting the budget makes all of them stop, not
// just itself - a shared budget has to mean a shared stop signal too.
import { getLinkedinTouchStats, TOUCH_DANGER_THRESHOLD_24H } from "./linkedin-touch-log.js";

export const TOUCH_BUDGET_STOP_MESSAGE =
  "Stopped automatically - today's automated LinkedIn activity limit was reached. Resume tomorrow.";

// Returns true (and sets scanAbortRequested) the first time the daily budget
// is hit. Callers should check this at the same per-item checkpoint they
// already check scanAbortRequested at, and stop the same way.
export async function checkTouchBudget() {
  const { last24h } = await getLinkedinTouchStats();
  if (last24h < TOUCH_DANGER_THRESHOLD_24H) return false;
  await chrome.storage.local.set({ scanAbortRequested: true }).catch(() => {});
  return true;
}
