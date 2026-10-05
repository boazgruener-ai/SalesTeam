// Web research of many accounts, run by the extension's background worker so it keeps going whichever SalesTeam page is open
// (or none). Progress and the final result are kept in storage under "bulkResearchState"; every SalesTeam page shows them
// (batch-status.js). Four accounts are researched at a time.
import {
  getTargetAccountsWorkbook, getTargetAccountExtras, saveTargetAccountExtra, addWebResearchInitiatives, normalizeCompanyName,
  getAnthropicApiKey, getCompanyContext, getIdealCustomerProfile, getOutputLanguage, getTargetUniverseConfig, appendActivityLog,
} from "./storage.js";
import { researchAccountOnWeb, sanitizeApiKey, apiBlockedReason } from "./agent-shared.js";
import { computeFindingProposals } from "./web-research-apply.js";
import { acquireBatch, BULK_STATE_KEY } from "./batch-jobs.js";
import { isRateLimited, backoffDelayMs, MAX_RATE_LIMITS_IN_A_ROW } from "./rate-limit.js";
import { teamWorkGate, claimAccount, releaseAccount } from "./team-sync.js";
// Accounts researched at a time. Measured throughput is ~18s per account per worker, so this is
// the main lever on how long a big run takes. Raising it also raises the chance of an HTTP 429
// from the Anthropic API - which pauses every worker and retries the account (see the catch below).
const WORKERS = 4;

let runner = null; // { stop(reason) }

export async function startBulkResearch({ items: chosen, budget, autofill }) {
  if (runner) throw new Error("A bulk web research is already running.");
  // Team use 1.2.2 step 5 (R6.2): a colleague's accounts (assigned, or being updated) are left out; each account is
  // claimed while it is researched, so colleagues see it.
  const gate = await teamWorkGate().catch(() => null);
  if (gate && !gate.connected) throw new Error("The team folder is not connected on this PC (or not in sync) - in a team, web research runs only while colleagues can see what it works on.");
  const items = gate ? chosen.filter((item) => !gate.offLimits(item.key)) : chosen;
  const skippedTeam = chosen.length - items.length;
  if (items.length === 0) throw new Error(`Nothing to research - ${chosen.length === 1 ? "the chosen account belongs" : `all ${chosen.length} chosen accounts belong`} to a colleague (assigned, or being updated right now).`);
  // Backstop for the dialog's own check: no key means every account would fail at once, so do not start at all.
  if (!sanitizeApiKey((await getAnthropicApiKey()) || "")) throw new Error("Add your Anthropic API key first (Settings > Anthropic API Key) - web research runs on your own key.");
  const label = `Web research of ${items.length} account${items.length === 1 ? "" : "s"}`;
  const release = await acquireBatch(label); // throws BatchBusyError (with the explanation) when something else is running
  const state = {
    status: "running", label, total: items.length, done: 0, failed: 0, spent: 0, runningKeys: [], stoppedReason: null,
    filled: 0, initiatives: 0, toReview: 0, lastError: null, budget: budget || 0, startedAt: Date.now(), heartbeatAt: Date.now(),
    skippedTeam, // left out before the start: a colleague's accounts

    pausedUntil: null, // set while the run waits out an Anthropic rate limit (batch-status.js shows it)
    finishedAt: null, acknowledged: false,
  };
  const save = () => chrome.storage.local.set({ [BULK_STATE_KEY]: { ...state, heartbeatAt: Date.now() } }).catch(() => {});
  await save();
  const controllers = new Map();
  let stopping = false;
  runner = {
    stop(reason) {
      stopping = true;
      state.stoppedReason = state.stoppedReason || reason;
      for (const c of controllers.values()) c.abort();
    },
  };
  run(items, { autofill: !!autofill, state, save, controllers, isStopping: () => stopping, stop: (r) => runner?.stop(r), release, team: Boolean(gate) }).catch(() => {});
  return { ok: true };
}

export function stopBulkResearch() {
  if (runner) runner.stop("user");
  return { ok: !!runner };
}

async function run(items, { autofill, state, save, controllers, isStopping, stop, release, team }) {
  // Keeps the background worker awake, and the "still alive" stamp fresh for the pages.
  let beat = 0;
  let skippedInRun = 0; // team: a colleague took the account after the start
  const keepAlive = setInterval(() => {
    chrome.storage.local.get("keepAlive").catch(() => {});
    if (++beat % 4 === 0) save();
  }, 4000);
  try {
    const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
    const config = await getTargetUniverseConfig();
    const settings = {
      apiKey,
      companyContext: await getCompanyContext(),
      idealCustomerProfile: await getIdealCustomerProfile(),
      outputLanguage: await getOutputLanguage(),
      targetCountries: config?.countries || [],
    };
    let next = 0;
    let saveChain = Promise.resolve(); // one save at a time, so the workers never overwrite each other
    let consecutiveFailures = 0;
    // 429 back-off (ONBOARDING_RESEARCH_DESIGN.md 5.6): a rate-limited account goes back in `retry`, every worker
    // waits until `pauseUntil`, and the run carries on. The streak counts pauses, not errors - the four workers
    // usually hit the same limit together, and a request sent before the current pause began is part of that
    // same wave, so it is retried without counting again.
    const retry = [];
    let pauseUntil = 0;
    let pauseStartedAt = 0;
    let rateLimitStreak = 0;
    const waitOutPause = async () => {
      while (!isStopping() && Date.now() < pauseUntil) {
        await new Promise((r) => setTimeout(r, Math.min(1000, pauseUntil - Date.now())));
      }
      if (state.pausedUntil && Date.now() >= pauseUntil) { state.pausedUntil = null; await save(); }
    };
    const worker = async () => {
      while (!isStopping()) {
        await waitOutPause();
        if (isStopping()) break;
        if (state.budget > 0 && state.spent >= state.budget) { stop("budget"); break; }
        const item = retry.shift() || items[next++];
        if (!item) break;
        const wb = await getTargetAccountsWorkbook();
        const company = (wb.companies || []).find((c) => normalizeCompanyName(c.company) === item.key);
        if (!company) { state.done++; continue; }
        // In a team: claimed first; one a colleague took since the start is skipped (counted as done).
        const claimed = team ? await claimAccount(item.key, { kind: "research" }).catch(() => ({ ok: false })) : { ok: true };
        if (!claimed.ok) { state.done++; state.skippedTeam = (state.skippedTeam || 0) + 1; skippedInRun++; await save(); continue; }
        const own = new AbortController();
        controllers.set(item.key, own);
        state.runningKeys = [...state.runningKeys, item.key];
        await save();
        const sentAt = Date.now();
        let requeued = false;
        try {
          const result = await researchAccountOnWeb(company, settings, { signal: own.signal, onlyTopics: item.onlyTopics });
          consecutiveFailures = 0;
          rateLimitStreak = 0;
          state.spent += result.costUsd || 0;
          await (saveChain = saveChain.then(async () => {
            await saveTargetAccountExtra(item.key, { webResearch: { text: result.text, sources: result.sources, searches: result.searches, at: Date.now(), data: result.data || null, stopped: result.stopped, costUsd: result.costUsd, topics: item.onlyTopics || null } });
            state.initiatives += await addWebResearchInitiatives(company.companyId, company.company, result.data?.initiatives);
            const extras = await getTargetAccountExtras();
            const proposals = computeFindingProposals(company, extras[item.key]?.overrides, result.data);
            const fresh = proposals.filter((p) => p.state === "new");
            if (autofill && fresh.length > 0) {
              const overrides = { ...(extras[item.key]?.overrides || {}) };
              for (const p of fresh) overrides[p.key] = p.found;
              await saveTargetAccountExtra(item.key, { overrides }, { src: "web", base: { overrides: extras[item.key]?.overrides } });
              state.filled += fresh.length;
            }
            if (proposals.some((p) => p.state === "different")) state.toReview++;
          }));
        } catch (err) {
          if (isRateLimited(err) && !isStopping()) {
            state.lastError = err.message;
            if (sentAt >= pauseStartedAt) rateLimitStreak++;
            if (rateLimitStreak >= MAX_RATE_LIMITS_IN_A_ROW) {
              stop("rate_limit"); // this account is simply not done; it counts as "not started", not as failed
            } else {
              if (sentAt >= pauseStartedAt) {
                pauseStartedAt = Date.now();
                pauseUntil = Math.max(pauseUntil, pauseStartedAt + backoffDelayMs(err.retryAfter, rateLimitStreak));
                state.pausedUntil = pauseUntil;
              }
              retry.push(item);
            }
            requeued = true;
            continue; // the finally below still runs: it clears the running key and saves
          }
          state.failed++;
          state.lastError = err.message;
          consecutiveFailures++;
          // A key or credit problem will hit every account: stop instead of failing them one by one.
          // Out of API credit is reported as HTTP 400, not 402, so it needs its own test - without it the run
          // burns three accounts on identical failures and then reports a generic "errors".
          const blocked = apiBlockedReason(err);
          if (blocked) stop(blocked);
          else if (consecutiveFailures >= 3 || [401, 402, 403].includes(err.status)) stop("errors");
        } finally {
          if (team && !requeued) await releaseAccount(item.key).catch(() => {});
          controllers.delete(item.key);
          state.runningKeys = state.runningKeys.filter((k) => k !== item.key);
          if (!requeued) state.done++;
          await save();
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    await saveChain;
  } catch (err) {
    state.lastError = err.message;
    state.stoppedReason = state.stoppedReason || apiBlockedReason(err) || "errors";
  } finally {
    clearInterval(keepAlive);
    state.status = "done";
    state.pausedUntil = null;
    state.runningKeys = [];
    state.finishedAt = Date.now();
    await save();
    await release();
    runner = null;
    const completed = state.done - state.failed - skippedInRun;
    try {
      const spentText = `$${state.spent.toFixed(2)}`;
      const teamNote = state.skippedTeam ? `; ${state.skippedTeam} left out - a colleague's account` : "";
      const got = `${completed} of ${state.total} accounts were researched (about ${spentText} spent on your own Anthropic API key${teamNote})`;
      const label = state.stoppedReason === "credit"
        ? `Web research stopped - your Anthropic API credit balance is empty. ${got}. Add credits in the Anthropic Console under Plans & Billing, then start the research again - everything found so far is saved.`
        : state.stoppedReason === "limit"
          ? `Web research stopped - you reached the spending limit set on your Anthropic API account (this is a cap you configure, not your credit balance). ${got}. Raise it in the Anthropic Console under Settings > Limits, or wait for it to reset, then start the research again - everything found so far is saved. Anthropic said: ${state.lastError || ""}`
          : state.stoppedReason === "rate_limit"
            ? `Web research paused - Anthropic kept answering "too many requests" (${MAX_RATE_LIMITS_IN_A_ROW} times in a row, with waits in between). ${got}. Start it again later for the rest - everything found so far is saved.`
          : `Web research finished: ${completed} of ${state.total} accounts researched, ${state.failed} failed, about ${spentText}${state.stoppedReason ? ` (stopped: ${state.stoppedReason})` : ""}`;
      await appendActivityLog({ actor: "user", action: "bulk_web_research_finished", label });
    } catch { /* the log entry is a convenience */ }
  }
}
