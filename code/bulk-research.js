// Web research of many accounts, run by the extension's background worker so it keeps going whichever SalesTeam page is open
// (or none). Progress and the final result are kept in storage under "bulkResearchState"; every SalesTeam page shows them
// (batch-status.js). Two accounts are researched at a time.
import {
  getTargetAccountsWorkbook, getTargetAccountExtras, saveTargetAccountExtra, addWebResearchInitiatives, normalizeCompanyName,
  getAnthropicApiKey, getCompanyContext, getIdealCustomerProfile, getOutputLanguage, getTargetUniverseConfig, appendActivityLog,
} from "./storage.js";
import { researchAccountOnWeb, sanitizeApiKey, apiBlockedReason } from "./agent-shared.js";
import { computeFindingProposals } from "./web-research-apply.js";
import { acquireBatch, BULK_STATE_KEY } from "./batch-jobs.js";
// Accounts researched at a time. Measured throughput is ~18s per account per worker, so this is
// the main lever on how long a big run takes. Raising it also raises the chance of an HTTP 429
// from the Anthropic API - and a 429 currently aborts the whole run (see the catch below).
const WORKERS = 4;

let runner = null; // { stop(reason) }

export async function startBulkResearch({ items, budget, autofill }) {
  if (runner) throw new Error("A bulk web research is already running.");
  const label = `Web research of ${items.length} account${items.length === 1 ? "" : "s"}`;
  const release = await acquireBatch(label); // throws BatchBusyError (with the explanation) when something else is running
  const state = {
    status: "running", label, total: items.length, done: 0, failed: 0, spent: 0, runningKeys: [], stoppedReason: null,
    filled: 0, initiatives: 0, toReview: 0, lastError: null, budget: budget || 0, startedAt: Date.now(), heartbeatAt: Date.now(),
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
  run(items, { autofill: !!autofill, state, save, controllers, isStopping: () => stopping, stop: (r) => runner?.stop(r), release }).catch(() => {});
  return { ok: true };
}

export function stopBulkResearch() {
  if (runner) runner.stop("user");
  return { ok: !!runner };
}

async function run(items, { autofill, state, save, controllers, isStopping, stop, release }) {
  // Keeps the background worker awake, and the "still alive" stamp fresh for the pages.
  let beat = 0;
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
    let saveChain = Promise.resolve(); // one save at a time, so the two workers never overwrite each other
    let consecutiveFailures = 0;
    const worker = async () => {
      while (!isStopping()) {
        if (state.budget > 0 && state.spent >= state.budget) { stop("budget"); break; }
        const item = items[next++];
        if (!item) break;
        const wb = await getTargetAccountsWorkbook();
        const company = (wb.companies || []).find((c) => normalizeCompanyName(c.company) === item.key);
        if (!company) { state.done++; continue; }
        const own = new AbortController();
        controllers.set(item.key, own);
        state.runningKeys = [...state.runningKeys, item.key];
        await save();
        try {
          const result = await researchAccountOnWeb(company, settings, { signal: own.signal, onlyTopics: item.onlyTopics });
          consecutiveFailures = 0;
          state.spent += result.costUsd || 0;
          await (saveChain = saveChain.then(async () => {
            await saveTargetAccountExtra(item.key, { webResearch: { text: result.text, sources: result.sources, searches: result.searches, at: Date.now(), data: result.data || null, stopped: result.stopped, costUsd: result.costUsd } });
            state.initiatives += await addWebResearchInitiatives(company.companyId, company.company, result.data?.initiatives);
            const extras = await getTargetAccountExtras();
            const proposals = computeFindingProposals(company, extras[item.key]?.overrides, result.data);
            const fresh = proposals.filter((p) => p.state === "new");
            if (autofill && fresh.length > 0) {
              const overrides = { ...(extras[item.key]?.overrides || {}) };
              for (const p of fresh) overrides[p.key] = p.found;
              await saveTargetAccountExtra(item.key, { overrides }, { src: "web" });
              state.filled += fresh.length;
            }
            if (proposals.some((p) => p.state === "different")) state.toReview++;
          }));
        } catch (err) {
          state.failed++;
          state.lastError = err.message;
          consecutiveFailures++;
          // A key, credit or rate-limit problem will hit every account: stop instead of failing them one by one.
          // Out of API credit is reported as HTTP 400, not 402, so it needs its own test - without it the run
          // burns three accounts on identical failures and then reports a generic "errors".
          const blocked = apiBlockedReason(err);
          if (blocked) stop(blocked);
          else if (consecutiveFailures >= 3 || [401, 402, 403, 429].includes(err.status)) stop("errors");
        } finally {
          controllers.delete(item.key);
          state.runningKeys = state.runningKeys.filter((k) => k !== item.key);
          state.done++;
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
    state.runningKeys = [];
    state.finishedAt = Date.now();
    await save();
    await release();
    runner = null;
    const completed = state.done - state.failed;
    try {
      const spentText = `$${state.spent.toFixed(2)}`;
      const got = `${completed} of ${state.total} accounts were researched (about ${spentText} spent on your own Anthropic API key)`;
      const label = state.stoppedReason === "credit"
        ? `Web research stopped - your Anthropic API credit balance is empty. ${got}. Add credits in the Anthropic Console under Plans & Billing, then start the research again - everything found so far is saved.`
        : state.stoppedReason === "limit"
          ? `Web research stopped - you reached the spending limit set on your Anthropic API account (this is a cap you configure, not your credit balance). ${got}. Raise it in the Anthropic Console under Settings > Limits, or wait for it to reset, then start the research again - everything found so far is saved. Anthropic said: ${state.lastError || ""}`
          : `Web research finished: ${completed} of ${state.total} accounts researched, ${state.failed} failed, about ${spentText}${state.stoppedReason ? ` (stopped: ${state.stoppedReason})` : ""}`;
      await appendActivityLog({ actor: "user", action: "bulk_web_research_finished", label });
    } catch { /* the log entry is a convenience */ }
  }
}
