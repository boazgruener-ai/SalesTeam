// The switch for the automatic data pipeline (1.2 build step 3, DATA_PIPELINE_DESIGN.md 10.1 and the
// step 3 touch-ups U1-U5). Off until the user turns it on (R12.8.3): the setup wizard's last step asks,
// existing users are asked once on the first SalesTeam page they open, and Settings > Automation holds
// the switch. Shared by the pages and the background worker.
import { appendActivityLog } from "./storage.js";

export const PIPELINE_AUTOMATION_KEY = "pipelineAutomation";
// What the last automatic kick found, when it did not start a run ("nothing_left", "no_backup", ...),
// so the status line can say why nothing is happening.
export const PIPELINE_IDLE_KEY = "pipelineIdle";
// U2: until when the pipeline stays out of the way of a user's job (ms timestamp).
export const PIPELINE_HOLD_KEY = "pipelineHoldUntil";
// While a SalesTeam page is open it kicks the pipeline this often (design 5.4).
export const PIPELINE_KICK_EVERY_MS = 10 * 60 * 1000;

export const CONSENT_TITLE = "Keep my accounts ready automatically";
export const CONSENT_TEXT =
  "SalesTeam links accounts to LinkedIn, finds their size and their key contacts, within your daily LinkedIn " +
  "limit. You start it once; it carries on each time Chrome is open, in its own small window. It makes way " +
  "whenever you start something yourself, and you can turn it off at any time in Settings > Automation.";

// { enabled, decidedAt, askedAt, pausedDay }
export async function getPipelineAutomation() {
  const v = (await chrome.storage.local.get(PIPELINE_AUTOMATION_KEY))[PIPELINE_AUTOMATION_KEY] || {};
  return { enabled: v.enabled === true, decidedAt: v.decidedAt || null, askedAt: v.askedAt || null, pausedDay: v.pausedDay || null };
}

async function patchAutomation(patch) {
  const current = (await chrome.storage.local.get(PIPELINE_AUTOMATION_KEY))[PIPELINE_AUTOMATION_KEY] || {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [PIPELINE_AUTOMATION_KEY]: next });
  return next;
}

// The user's choice, from the wizard, the one-time card or Settings. Logged when it changes.
export async function setPipelineAutomationEnabled(enabled, where) {
  const before = await getPipelineAutomation();
  await patchAutomation({ enabled: Boolean(enabled), decidedAt: Date.now(), ...(enabled ? { pausedDay: null } : {}) });
  if (before.enabled !== Boolean(enabled) || !before.decidedAt) {
    appendActivityLog({
      actor: "user",
      action: "pipeline_automation",
      label: `Automatic account preparation turned ${enabled ? "on" : "off"}${where ? ` (${where})` : ""}`,
      newValue: { enabled: Boolean(enabled) },
    }).catch(() => {});
  }
}

// Claims the one-time question, so two pages opening together do not both ask. True when this caller won.
export async function claimConsentQuestion() {
  const a = await getPipelineAutomation();
  if (a.decidedAt || a.askedAt) return false;
  await patchAutomation({ askedAt: Date.now() });
  return true;
}

// Pause from the status pill: for the rest of the local day. Resume clears it.
export async function setPipelinePausedDay(day) {
  await patchAutomation({ pausedDay: day || null });
  appendActivityLog({
    actor: "user",
    action: "pipeline_automation",
    label: day ? "Automatic account preparation paused for today" : "Automatic account preparation resumed",
  }).catch(() => {});
}
