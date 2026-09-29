// The web lane (1.2.1, ONBOARDING_RESEARCH_DESIGN.md section 5): researches accounts on the web, asking each
// only for what it still lacks (missingWebTopics), reading the company's own pages first, and storing every
// fact with its own source. Runs in the background worker with four workers, independently of the LinkedIn
// pipeline: it takes no batch lock, so the LinkedIn lane keeps working beside it.
//
// Build step 2: started by hand from Target Accounts > Advanced tools > "Research accounts on the web (new)",
// to MEASURE what it costs and how long it takes per account (traded and private companies are counted
// apart). From step 6 the wizard's Finish starts it, under the monthly web budget.
//
// Progress and the result are kept under WEB_LANE_STATE_KEY; batch-status.js shows them on every page.
import {
  getAccountViews, getTargetAccountsWorkbook, getTargetAccountExtras, getReadinessConfig, getAnthropicApiKey,
  getCompanyContext, getIdealCustomerProfile, getOutputLanguage, getTargetUniverseConfig, applyWebLaneResearch,
  appendActivityLog, normalizeCompanyName,
} from "./storage.js";
import { researchAccountForLane, sanitizeApiKey, apiBlockedReason } from "./agent-shared.js";
import { missingWebTopics, webLaneOrder, isPubliclyTraded, WEB_LANE_TOPICS, DEFAULT_COMPLETION_TARGETS } from "./pipeline-plan.js";
import { researchIsPublic, findingValue } from "./web-research-apply.js";
import { applicableProvenance, employeesField } from "./readiness.js";
import { BULK_STATE_KEY } from "./batch-jobs.js";
import { isRateLimited, backoffDelayMs, MAX_RATE_LIMITS_IN_A_ROW } from "./rate-limit.js";

export const WEB_LANE_STATE_KEY = "webLaneState";
const WORKERS = 4;
// An account the lane researched this recently is not researched again for the same gaps: what the web did
// not give then, it will rarely give a few days later.
const LANE_RETRY_DAYS = 30;
const DAY_MS = 86400000;

let runner = null;

// The accounts the lane would research now, best first: [{ key, company, isPublic, topics, known, companyRow, website }].
export async function webLaneCandidates({ now = Date.now(), targets = DEFAULT_COMPLETION_TARGETS } = {}) {
  const [views, workbook, extras, cfg] = await Promise.all([
    getAccountViews({ persistDerived: false }), getTargetAccountsWorkbook(), getTargetAccountExtras(), getReadinessConfig(),
  ]);
  const rows = new Map();
  for (const c of workbook.companies || []) if (c.company && !rows.has(normalizeCompanyName(c.company))) rows.set(normalizeCompanyName(c.company), c);
  const initiativesById = new Map();
  for (const i of workbook.aiInitiatives || []) if (i.companyId) {
    if (!initiativesById.has(i.companyId)) initiativesById.set(i.companyId, []);
    initiativesById.get(i.companyId).push(i);
  }
  const out = [];
  for (const view of views) {
    if (view.deleted || view.excluded) continue;
    const extra = extras[view.key] || {};
    const research = extra.webResearch || null;
    if (research && research.by === "lane" && now - (research.at || 0) < LANE_RETRY_DAYS * DAY_MS) continue;
    const summaryFrom = (r) => Boolean(r && ((!r.topics && r.text) || findingValue(r.data && r.data.summary)));
    const initiatives = initiativesById.get(view.companyId) || [];
    const relevant = (view.contacts || []).filter((c) => c.relevant);
    const topics = missingWebTopics(view, cfg, { initiatives: initiatives.length, relevantContacts: relevant.length, hasSummary: summaryFrom(research) || summaryFrom(extra.webResearchPrevious) }, targets, now);
    if (topics.length === 0) continue;
    const row = rows.get(view.key) || {};
    out.push({
      key: view.key, company: view.company, priority: view.salesTeamPriority, order: view.universeOrder,
      isPublic: isPubliclyTraded(extra.overrides?.companyType ?? row.companyType, researchIsPublic(research && research.data)),
      topics, known: knownFacts(view, initiatives, relevant), companyRow: row, website: view.website || null,
    });
  }
  const byKey = new Map(out.map((c) => [c.key, c]));
  return webLaneOrder(out).map((e) => byKey.get(e.key));
}

// What the research is told is already known, each with its source when there is one (design 5.2).
function knownFacts(view, initiatives, relevantContacts) {
  const out = [];
  const add = (label, field) => {
    const v = view[field];
    if (v === null || v === undefined || String(v).trim() === "") return;
    const p = applicableProvenance(view, field);
    out.push({ label, value: v, url: (p && p.link) || null });
  };
  add("HQ country", "globalHqCountry");
  const emp = employeesField(view);
  if (emp) add(emp === "globalEmployees" ? "Employees (worldwide)" : "Employees (local)", emp);
  add("Industry", "industry");
  if (relevantContacts.length) out.push({ label: "Contacts already known", value: relevantContacts.map((c) => c.fullName).join(", ") });
  if (initiatives.length) out.push({ label: "Initiatives already known", value: initiatives.map((i) => i.initiativeName).filter(Boolean).slice(0, 8).join("; ") });
  return out;
}

export async function startWebLane({ limit, budget }) {
  if (runner) throw new Error("The web research lane is already running.");
  const bulk = (await chrome.storage.local.get(BULK_STATE_KEY))[BULK_STATE_KEY];
  if (bulk && bulk.status === "running") throw new Error("A bulk web research is running - wait for it to finish, or stop it, first.");
  const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
  if (!apiKey) throw new Error("Add your Anthropic API key first (Settings > Anthropic API Key) - web research runs on your own key.");
  const all = await webLaneCandidates();
  const items = all.slice(0, Math.max(1, Number(limit) || 20));
  if (items.length === 0) throw new Error("No account needs web research right now - every account already has what the lane looks for.");
  const state = {
    status: "running", total: items.length, candidates: all.length, done: 0, failed: 0, spent: 0, runningKeys: [], stoppedReason: null,
    budget: Number(budget) || 0, startedAt: Date.now(), heartbeatAt: Date.now(), pausedUntil: null, finishedAt: null,
    acknowledged: false, lastError: null, results: [],
  };
  const save = () => chrome.storage.local.set({ [WEB_LANE_STATE_KEY]: { ...state, heartbeatAt: Date.now() } }).catch(() => {});
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
  run(items, { apiKey, state, save, controllers, isStopping: () => stopping, stop: (r) => runner?.stop(r) }).catch(() => {});
  return { ok: true, total: items.length, candidates: all.length };
}

export function stopWebLane() {
  if (runner) runner.stop("user");
  return { ok: !!runner };
}

async function run(items, { apiKey, state, save, controllers, isStopping, stop }) {
  let beat = 0;
  const keepAlive = setInterval(() => {
    chrome.storage.local.get("keepAlive").catch(() => {});
    if (++beat % 4 === 0) save();
  }, 4000);
  try {
    const [universe, cfg] = await Promise.all([getTargetUniverseConfig(), getReadinessConfig()]);
    const settings = {
      apiKey,
      companyContext: await getCompanyContext(),
      idealCustomerProfile: await getIdealCustomerProfile(),
      outputLanguage: await getOutputLanguage(),
      targetCountries: universe?.countries || [],
    };
    const industryNames = (cfg.industries || []).map((i) => (i && i.name) || "").filter(Boolean);
    let next = 0;
    let saveChain = Promise.resolve(); // one account's writes at a time
    let consecutiveFailures = 0;
    const retry = [];
    let pauseUntil = 0;
    let pauseStartedAt = 0;
    let rateLimitStreak = 0;
    const waitOutPause = async () => {
      while (!isStopping() && Date.now() < pauseUntil) await new Promise((r) => setTimeout(r, Math.min(1000, pauseUntil - Date.now())));
      if (state.pausedUntil && Date.now() >= pauseUntil) { state.pausedUntil = null; await save(); }
    };
    const worker = async () => {
      while (!isStopping()) {
        await waitOutPause();
        if (isStopping()) break;
        if (state.budget > 0 && state.spent >= state.budget) { stop("budget"); break; }
        const item = retry.shift() || items[next++];
        if (!item) break;
        const own = new AbortController();
        controllers.set(item.key, own);
        state.runningKeys = [...state.runningKeys, item.key];
        await save();
        const sentAt = Date.now();
        let requeued = false;
        try {
          const company = { ...item.companyRow, company: item.company, website: item.website };
          const result = await researchAccountForLane(company, {
            known: item.known,
            topicWords: item.topics.map((t) => WEB_LANE_TOPICS[t]),
            industryNames: item.topics.includes("industry") ? industryNames : null,
          }, settings, { signal: own.signal });
          consecutiveFailures = 0;
          rateLimitStreak = 0;
          state.spent += result.costUsd || 0;
          await (saveChain = saveChain.then(async () => {
            const applied = await applyWebLaneResearch(item.key, result, { topics: item.topics });
            state.results.push({
              key: item.key, company: item.company, isPublic: item.isPublic ?? researchIsPublic(result.data), topics: item.topics,
              costUsd: result.costUsd || 0, seconds: Math.round((result.ms || 0) / 1000), searches: result.searches, fetches: result.fetches,
              inputTokens: result.usage?.input_tokens || 0, outputTokens: result.usage?.output_tokens || 0, stopped: result.stopped || null,
              ...(applied || {}),
            });
          }));
        } catch (err) {
          if (isRateLimited(err) && !isStopping()) {
            state.lastError = err.message;
            if (sentAt >= pauseStartedAt) rateLimitStreak++;
            if (rateLimitStreak >= MAX_RATE_LIMITS_IN_A_ROW) stop("rate_limit");
            else {
              if (sentAt >= pauseStartedAt) {
                pauseStartedAt = Date.now();
                pauseUntil = Math.max(pauseUntil, pauseStartedAt + backoffDelayMs(err.retryAfter, rateLimitStreak));
                state.pausedUntil = pauseUntil;
              }
              retry.push(item);
            }
            requeued = true;
            continue;
          }
          state.failed++;
          state.lastError = err.message;
          state.results.push({ key: item.key, company: item.company, isPublic: item.isPublic, topics: item.topics, error: String(err.message || err).slice(0, 200) });
          consecutiveFailures++;
          const blocked = apiBlockedReason(err);
          if (blocked) stop(blocked);
          else if (consecutiveFailures >= 3 || [401, 402, 403].includes(err.status)) stop("errors");
        } finally {
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
    state.measure = measureLane(state.results);
    await save();
    runner = null;
    try {
      await appendActivityLog({ actor: "user", action: "web_lane_finished", label: `Web research lane: ${measureText(state)}` });
    } catch { /* the log entry is a convenience */ }
  }
}

// Build step 2's measurement: average cost and time per researched account, traded and private apart.
export function measureLane(results) {
  const ok = (results || []).filter((r) => !r.error);
  const group = (list) => {
    if (list.length === 0) return null;
    const sum = (f) => list.reduce((a, r) => a + (Number(r[f]) || 0), 0);
    return {
      accounts: list.length, usdEach: sum("costUsd") / list.length, secondsEach: sum("seconds") / list.length,
      searchesEach: sum("searches") / list.length, fetchesEach: sum("fetches") / list.length,
      contacts: sum("contacts"), profiles: sum("profiles"), initiatives: sum("initiatives"), filled: sum("filled"),
      pages: list.filter((r) => r.linkedinPage).length,
    };
  };
  return { all: group(ok), traded: group(ok.filter((r) => r.isPublic === true)), other: group(ok.filter((r) => r.isPublic !== true)) };
}

export function measureText(s) {
  const m = s.measure || measureLane(s.results);
  const completed = s.done - s.failed;
  const line = (label, g) => g
    ? `${label}: ${g.accounts} account${g.accounts === 1 ? "" : "s"}, about US$${g.usdEach.toFixed(3)} and ${Math.round(g.secondsEach)} s each ` +
      `(${g.searchesEach.toFixed(1)} searches, ${g.fetchesEach.toFixed(1)} pages read); ${g.contacts} contacts added (${g.profiles} with a LinkedIn profile), ` +
      `${g.initiatives} initiatives, ${g.filled} empty fields filled, ${g.pages} LinkedIn company pages found`
    : null;
  return [
    `${completed} of ${s.total} accounts researched${s.failed ? `, ${s.failed} failed` : ""}, about US$${(s.spent || 0).toFixed(2)} in all` +
      `${s.stoppedReason ? ` (stopped: ${s.stoppedReason})` : ""}.`,
    line("Publicly traded", m.traded),
    line("Private and other", m.other),
  ].filter(Boolean).join("\n");
}
