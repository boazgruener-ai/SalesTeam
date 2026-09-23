// The "Onboarding Setup" menu item only matters until the setup has been completed; after that, changing a setting
// goes through "Change Settings" instead (reported directly, 2026-09-21: one item doing both jobs was confusing).
// Shared by every page that carries the Settings menu group.
import { getOnboardingCompletedAt, getOnboardingProgressStepIndex } from "./storage.js";

// STEP_ORDER (onboarding.js) has 11 real steps - kept as a constant here rather than importing that page script.
export const ONBOARDING_TOTAL_STEPS = 11;

export async function getOnboardingState() {
  const [completedAt, stepIndex] = await Promise.all([getOnboardingCompletedAt(), getOnboardingProgressStepIndex()]);
  const done = Boolean(completedAt);
  const stepsDone = done ? ONBOARDING_TOTAL_STEPS : Math.min(stepIndex || 0, ONBOARDING_TOTAL_STEPS);
  return { done, stepsDone };
}

// setupEl = the "Onboarding Setup" menu element: hidden once complete, otherwise it carries the status in its name.
export async function applyOnboardingNavState(setupEl) {
  if (!setupEl) return;
  const { done, stepsDone } = await getOnboardingState();
  setupEl.hidden = done;
  if (!done) {
    const badge = setupEl.querySelector(".nav-item-badge");
    const status = stepsDone === 0 ? "not started" : `${stepsDone} of ${ONBOARDING_TOTAL_STEPS} done`;
    if (badge) badge.textContent = `(${status})`;
    else setupEl.textContent = `Onboarding Setup (${status})`;
  }
}
