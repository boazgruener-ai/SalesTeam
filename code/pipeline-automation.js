// The switch for the automatic data pipeline (1.2 build step 3, DATA_PIPELINE_DESIGN.md 10.1 and the
// step 3 touch-ups U1-U5). Off until the user turns it on (R12.8.3): the setup wizard's last step asks,
// existing users are asked once on the first SalesTeam page they open, and Settings > Automation holds
// the switch. Shared by the pages and the background worker.
import { appendActivityLog, getAnthropicApiKey } from "./storage.js";
import { averageWebResearchUsd } from "./api-usage.js";
import { webBudgetBlocker, localDay } from "./pipeline-plan.js";

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

// Build step 5 (W3, W4): web research has its own consent and a monthly budget, separate from the
// LinkedIn one above, because it spends the user's money on their Anthropic API key (R12.7.1).
export const WEB_CONSENT_TITLE = "Research accounts on the web";
export const WEB_CONSENT_TEXT =
  "SalesTeam researches accounts on the web with your own Anthropic API key, within the monthly budget you set " +
  "here and never above it. It fills missing facts first, such as a headcount or the headquarters country, then " +
  "researches your P1-P3 accounts in depth. What it cannot settle by itself waits for you in Decisions.";
export const DEFAULT_WEB_BUDGET_USD = 10;
// { month: "YYYY-MM", usd, researches, blocked: { reason: "credit" | "limit", day, keyTail } | null }
export const PIPELINE_WEB_SPEND_KEY = "pipelineWebSpend";

// { enabled, decidedAt, askedAt, pausedDay, webEnabled, webMonthlyUsd, webDecidedAt }
export async function getPipelineAutomation() {
  const v = (await chrome.storage.local.get(PIPELINE_AUTOMATION_KEY))[PIPELINE_AUTOMATION_KEY] || {};
  return {
    enabled: v.enabled === true, decidedAt: v.decidedAt || null, askedAt: v.askedAt || null, pausedDay: v.pausedDay || null,
    webEnabled: v.webEnabled === true,
    webMonthlyUsd: typeof v.webMonthlyUsd === "number" && v.webMonthlyUsd >= 0 ? v.webMonthlyUsd : 0,
    webDecidedAt: v.webDecidedAt || null,
  };
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

// ---- Web research: consent, budget and this month's spend (build step 5, W3-W6) ----

// The user's web research choice, from the wizard or Settings. Turning it on with no budget fills in the
// default (W3). Changing either clears an API refusal recorded today, so the next kick tries again.
export async function setWebResearchAutomation({ enabled, monthlyUsd }, where) {
  const before = await getPipelineAutomation();
  const on = enabled === undefined ? before.webEnabled : Boolean(enabled);
  let budget = monthlyUsd === undefined ? before.webMonthlyUsd : Math.max(0, Math.round((Number(monthlyUsd) || 0) * 100) / 100);
  if (on && !(budget > 0) && monthlyUsd === undefined) budget = DEFAULT_WEB_BUDGET_USD;
  await patchAutomation({ webEnabled: on, webMonthlyUsd: budget, webDecidedAt: Date.now() });
  await clearWebBlocked();
  if (before.webEnabled !== on || before.webMonthlyUsd !== budget) {
    appendActivityLog({
      actor: "user",
      action: "pipeline_web_automation",
      label: `Automatic web research ${on ? `on, budget US$${budget.toFixed(2)} a month` : "off"}${where ? ` (${where})` : ""}`,
      newValue: { enabled: on, monthlyUsd: budget },
    }).catch(() => {});
  }
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// This month's spend; a new month starts from zero (design 6: "the month rolls over").
export async function getWebSpend() {
  const v = (await chrome.storage.local.get(PIPELINE_WEB_SPEND_KEY))[PIPELINE_WEB_SPEND_KEY] || {};
  const month = currentMonth();
  if (v.month !== month) return { month, usd: 0, researches: 0, blocked: null };
  return { month, usd: Number(v.usd) || 0, researches: Number(v.researches) || 0, blocked: v.blocked || null };
}

export async function recordWebSpend(usd) {
  const s = await getWebSpend();
  await chrome.storage.local.set({ [PIPELINE_WEB_SPEND_KEY]: { ...s, usd: s.usd + (Number(usd) || 0), researches: s.researches + 1 } });
}

// The API refused for money reasons (empty credit, the Console's own spending limit): no more tries today
// with this key (W6).
export async function setWebBlocked(reason, keyTail) {
  const s = await getWebSpend();
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await chrome.storage.local.set({ [PIPELINE_WEB_SPEND_KEY]: { ...s, blocked: { reason, day, keyTail: keyTail || null } } });
}

export async function clearWebBlocked() {
  const s = await getWebSpend();
  if (s.blocked) await chrome.storage.local.set({ [PIPELINE_WEB_SPEND_KEY]: { ...s, blocked: null } });
}

// A short fingerprint of the API key, so a refusal recorded for one key does not block a new one.
export function apiKeyTail(key) {
  const k = String(key || "");
  return k ? `${k.length}:${k.slice(-4)}` : "";
}

// Where the web budget stands and whether the pipeline may start a research now (W3, W6). Shared by the
// background loop and by the pages' status lines. `reason` is null when it may, else "off", "no_key",
// "zero", "credit", "limit" or "used_up" (pipeline-plan.js webBudgetBlocker).
export async function webBudgetState() {
  const [auto, spend, rawKey, overallAvg] = await Promise.all([getPipelineAutomation(), getWebSpend(), getAnthropicApiKey(), averageWebResearchUsd()]);
  // The pipeline's own researches this month can cost more than the all-time average (first live run,
  // 2026-09-28: US$0.20 each against ~0.085 by hand), so the dearer of the two decides whether the next
  // one still fits - otherwise the last research of the month could overshoot the budget.
  const nextCostUsd = Math.max(overallAvg, spend.researches > 0 ? spend.usd / spend.researches : 0);
  const apiKey = String(rawKey || "").replace(/[^\x20-\x7E]/g, "").trim();
  const blocked = spend.blocked && spend.blocked.keyTail === apiKeyTail(apiKey) ? spend.blocked : null;
  const reason = webBudgetBlocker({
    enabled: auto.webEnabled, hasKey: Boolean(apiKey), monthlyUsd: auto.webMonthlyUsd, spentUsd: spend.usd,
    nextCostUsd, blocked, today: localDay(),
  });
  return { reason, enabled: auto.webEnabled, monthlyUsd: auto.webMonthlyUsd, spentUsd: spend.usd, researches: spend.researches, nextCostUsd, apiKey };
}
