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
  appendActivityLog, normalizeCompanyName, setContactLinkedinProfile, contactKeyFor, saveTargetAccountExtra,
  SENIORITY_LEVELS, getCompletionTargets, getInitiativeStagePreference, addOnboardingMeasure,
} from "./storage.js";
import { researchAccountForLane, searchLinkedinProfiles, sanitizeApiKey, apiBlockedReason, LANE_CONTACTS_MODEL } from "./agent-shared.js";
import { missingWebTopics, webLaneOrder, onlyContactMissing, isPubliclyTraded, profilesFromSearchResults, WEB_LANE_TOPICS, initiativeCounts } from "./pipeline-plan.js";
import { researchIsPublic, findingValue } from "./web-research-apply.js";
import { applicableProvenance, employeesField, assessAccount } from "./readiness.js";
import { BULK_STATE_KEY } from "./batch-jobs.js";
import { isRateLimited, backoffDelayMs, MAX_RATE_LIMITS_IN_A_ROW } from "./rate-limit.js";
import { getPipelineAutomation, webBudgetState, recordWebSpend, setWebBlocked, apiKeyTail } from "./pipeline-automation.js";
import { localDay } from "./pipeline-plan.js";
import { teamWorkGate, claimAccount, releaseAccount } from "./team-sync.js";

export const WEB_LANE_STATE_KEY = "webLaneState";
const WORKERS = 4;
// An account the lane researched this recently is not researched again for the same gaps: what the web did
// not give then, it will rarely give a few days later.
const LANE_RETRY_DAYS = 30;
const DAY_MS = 86400000;

let runner = null;

// The accounts the lane would research now, best first: [{ key, company, isPublic, topics, known, companyRow, website }].
// The user's targets (wizard step "How big should your list be?") decide how many contacts and initiatives an
// account still lacks; an initiative counts only at a stage the user ticked (design 3.7).
export async function webLaneCandidates({ now = Date.now(), targets = null } = {}) {
  const [views, workbook, extras, cfg, savedTargets, stages] = await Promise.all([
    getAccountViews({ persistDerived: false }), getTargetAccountsWorkbook(), getTargetAccountExtras(), getReadinessConfig(),
    targets ? null : getCompletionTargets(), getInitiativeStagePreference(),
  ]);
  targets = targets || savedTargets;
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
    const summaryFrom = (r) => Boolean(r && ((!r.topics && r.text) || findingValue(r.data && r.data.summary)));
    const initiatives = (initiativesById.get(view.companyId) || []).filter((i) => initiativeCounts(i.stage, stages));
    const relevant = (view.contacts || []).filter((c) => c.relevant);
    const withoutProfile = relevant.filter((c) => !/linkedin\.com\/in\//i.test(c.linkedinUrl || "")).length;
    let topics = missingWebTopics(view, cfg, {
      initiatives: initiatives.length, relevantContacts: relevant.length, contactsWithoutProfile: withoutProfile,
      hasSummary: summaryFrom(research) || summaryFrom(extra.webResearchPrevious),
    }, targets, now);
    // What the lane asked in the last 30 days is not asked again: the main research and the profile search apart.
    const recent = (at) => Boolean(at) && now - at < LANE_RETRY_DAYS * DAY_MS;
    if (research && research.by === "lane" && recent(research.at)) topics = topics.filter((t) => t === "profiles");
    if (recent(extra.webProfileSearchAt)) topics = topics.filter((t) => t !== "profiles");
    if (topics.length === 0) continue;
    const row = rows.get(view.key) || {};
    out.push({
      key: view.key, companyId: view.companyId, company: view.company, priority: view.salesTeamPriority, order: view.universeOrder,
      isPublic: isPubliclyTraded(extra.overrides?.companyType ?? row.companyType, researchIsPublic(research && research.data)),
      topics, known: knownFacts(view, initiatives, relevant), companyRow: row, website: view.website || null,
      readyByWeb: onlyContactMissing(assessAccount(view, cfg, now)),
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

export function isWebLaneRunning() {
  return Boolean(runner);
}

// `auto` (1.2.0.10): started by the automatic pipeline while its LinkedIn visits are used up (pipeline-runner.js
// kickPipeline). Such a run is paid from the monthly web budget like the pipeline's own research (each account's
// cost is recorded there), stops when that budget, automatic preparation or today's pause says so, and ends
// without a pop-up - its summary goes to the Activity Log only.
export async function startWebLane({ limit, budget, auto = false }) {
  if (runner) throw new Error("The web research lane is already running.");
  const bulk = (await chrome.storage.local.get(BULK_STATE_KEY))[BULK_STATE_KEY];
  if (bulk && bulk.status === "running") throw new Error("A bulk web research is running - wait for it to finish, or stop it, first.");
  const apiKey = sanitizeApiKey((await getAnthropicApiKey()) || "");
  if (!apiKey) throw new Error("Add your Anthropic API key first (Settings > Anthropic API Key) - web research runs on your own key.");
  // Team use 1.2.2 step 4 (design 6.5): in a team, only accounts no colleague holds, from this member's share.
  const gate = await teamWorkGate().catch(() => null);
  if (gate && !gate.connected) throw new Error("The team folder is not connected on this PC (or not in sync) - in a team, web research runs only while colleagues can see what it works on.");
  const all = (await webLaneCandidates()).filter((c) => !gate || gate.mayWork(c.key));
  const items = all.slice(0, Math.max(1, Number(limit) || 20));
  if (items.length === 0) throw new Error("No account needs web research right now - every account already has what the lane looks for.");
  const state = {
    status: "running", total: items.length, candidates: all.length, done: 0, failed: 0, spent: 0, runningKeys: [], stoppedReason: null,
    // 1.2.1 step 4 (design 7.1): the accounts this run still has to research, queued or running. The pipeline
    // leaves them to the lane until it is done with them (pipeline-plan.js heldForWebLane).
    pendingKeys: items.map((item) => item.key),
    budget: Number(budget) || 0, startedAt: Date.now(), heartbeatAt: Date.now(), pausedUntil: null, finishedAt: null,
    auto: Boolean(auto), acknowledged: Boolean(auto), lastError: null, results: [],
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
  run(items, { apiKey, state, save, controllers, isStopping: () => stopping, stop: (r) => runner?.stop(r), auto: Boolean(auto), team: Boolean(gate) }).catch(() => {});
  return { ok: true, total: items.length, candidates: all.length };
}

export function stopWebLane() {
  if (runner) runner.stop("user");
  return { ok: !!runner };
}

// An automatic run asks before every account whether it may still go on.
async function autoStopReason() {
  const a = await getPipelineAutomation();
  if (!a.enabled) return "automation_off";
  if (a.pausedDay === localDay()) return "paused_today";
  const w = await webBudgetState();
  return w.reason ? `web_${w.reason}` : null;
}

async function run(items, { apiKey, state, save, controllers, isStopping, stop, auto, team = false }) {
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
      // The levels chosen in Setup, most senior first, so the research names people who count towards Ready.
      seniorityLabels: (() => {
        const chosen = new Set(((cfg.seniorityLevels || [])).map((l) => (typeof l === "string" ? l : l && l.id)));
        return SENIORITY_LEVELS.filter((l) => chosen.has(l.id)).map((l) => l.label);
      })(),
    };
    const industryNames = (cfg.industries || []).map((i) => (i && i.name) || "").filter(Boolean);
    settings.initiativeStages = (await getInitiativeStagePreference()).filter((x) => x.checked).map((x) => x.id);
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
        if (auto) { const why = await autoStopReason().catch(() => null); if (why) { stop(why); break; } }
        const item = retry.shift() || items[next++];
        if (!item) break;
        const own = new AbortController();
        controllers.set(item.key, own);
        state.runningKeys = [...state.runningKeys, item.key];
        await save();
        const sentAt = Date.now();
        let requeued = false;
        // In a team the account is claimed first; one a colleague took meanwhile is skipped (counted as done).
        const claimed = team ? await claimAccount(item.key, { kind: "pipeline" }).catch(() => ({ ok: false })) : { ok: true };
        try {
          if (!claimed.ok) {
            state.results.push({ key: item.key, company: item.company, isPublic: item.isPublic, topics: item.topics, error: "Skipped - a colleague is working on this account" });
            continue;
          }
          const company = { ...item.companyRow, company: item.company, website: item.website };
          const mainTopics = item.topics.filter((t) => t !== "profiles");
          // 1. The research of what is missing - skipped when only profiles are missing.
          let result = null;
          if (mainTopics.length > 0) {
            result = await researchAccountForLane(company, {
              known: item.known,
              topicWords: mainTopics.map((t) => WEB_LANE_TOPICS[t]),
              industryNames: mainTopics.includes("industry") ? industryNames : null,
              model: mainTopics.every((t) => t === "contacts") ? LANE_CONTACTS_MODEL : undefined,
            }, settings, { signal: own.signal });
            state.spent += result.costUsd || 0;
          }
          let applied = null;
          if (result) await (saveChain = saveChain.then(async () => { applied = await applyWebLaneResearch(item.key, result, { topics: mainTopics }); }));
          // 2. D10 (1.2.0.7): LinkedIn profiles of the people still without one, from web search results.
          let profile = null;
          const people = await peopleWithoutProfile(item.companyId);
          if (people.length > 0 && !isStopping()) {
            const found = await searchLinkedinProfiles(item.company, people, settings, { signal: own.signal });
            state.spent += found.costUsd || 0;
            const matches = profilesFromSearchResults(found.results, people, item.company);
            let saved = 0;
            await (saveChain = saveChain.then(async () => {
              for (const m of matches) if ((await setContactLinkedinProfile(contactKeyFor(item.company, m.fullName), m.url)) !== undefined) saved++;
              await saveTargetAccountExtra(item.key, { webProfileSearchAt: Date.now() });
            }));
            profile = { asked: people.length, found: saved, costUsd: found.costUsd || 0, seconds: Math.round(found.ms / 1000), searches: found.searches };
          }
          consecutiveFailures = 0;
          rateLimitStreak = 0;
          const rec = {
            key: item.key, company: item.company, isPublic: item.isPublic ?? researchIsPublic(result && result.data), topics: item.topics,
            costUsd: (result ? result.costUsd || 0 : 0) + (profile ? profile.costUsd : 0),
            seconds: Math.round(((result && result.ms) || 0) / 1000) + (profile ? profile.seconds : 0),
            researchSeconds: Math.round(((result && result.ms) || 0) / 1000),
            searches: result ? result.searches : 0, fetches: result ? result.fetches : 0, turns: result ? result.turns : 0,
            inputTokens: result?.usage?.input_tokens || 0, outputTokens: result?.usage?.output_tokens || 0,
            stopped: (result && result.stopped) || null, dataLine: Boolean(result && result.data),
            model: (result && result.model) || null,
            ...(applied || {}),
            profileAsked: profile ? profile.asked : 0, profileFound: profile ? profile.found : 0,
          };
          state.results.push(rec);
          await addOnboardingMeasure("lane", { accounts: 1, usd: rec.costUsd, seconds: rec.seconds }).catch(() => {});
          if (auto && rec.costUsd > 0) await recordWebSpend(rec.costUsd).catch(() => {});
          appendActivityLog({ actor: "extension", action: "web_lane_account", relatedCompanyKey: item.key, label: accountLine(rec) }).catch(() => {});
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
          appendActivityLog({ actor: "extension", action: "web_lane_account", relatedCompanyKey: item.key, label: `Web research (new) - ${item.company}: failed - ${String(err.message || err).slice(0, 200)}` }).catch(() => {});
          consecutiveFailures++;
          const blocked = apiBlockedReason(err);
          // An automatic run tells the pipeline too, so neither tries again today with this key (W6).
          if (blocked && auto && (blocked === "credit" || blocked === "limit")) await setWebBlocked(blocked, apiKeyTail(apiKey)).catch(() => {});
          if (blocked) stop(blocked);
          else if (consecutiveFailures >= 3 || [401, 402, 403].includes(err.status)) stop("errors");
        } finally {
          if (team && claimed.ok) await releaseAccount(item.key).catch(() => {});
          controllers.delete(item.key);
          state.runningKeys = state.runningKeys.filter((k) => k !== item.key);
          if (!requeued) {
            state.done++;
            state.pendingKeys = state.pendingKeys.filter((k) => k !== item.key);
          }
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
    state.pendingKeys = [];
    state.finishedAt = Date.now();
    state.measure = measureLane(state.results);
    await save();
    runner = null;
    try {
      await appendActivityLog({
        actor: auto ? "extension" : "user", action: "web_lane_finished",
        label: `${auto ? "Automatic web research" : "Web research lane"}: ${measureText(state)}${auto && state.stoppedReason ? ` (stopped: ${state.stoppedReason})` : ""}`,
      });
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
      profileAsked: sum("profileAsked"), profileFound: sum("profileFound"),
      cutOff: list.filter((r) => r.stopped === "timeout").length, noData: list.filter((r) => r.searches + r.fetches > 0 && !r.dataLine && r.dataLine !== undefined).length,
    };
  };
  return { all: group(ok), traded: group(ok.filter((r) => r.isPublic === true)), other: group(ok.filter((r) => r.isPublic !== true)) };
}

export function measureText(s) {
  const m = measureLane(s.results); // recomputed: a run stored by an older build lacks newer fields
  const completed = s.done - s.failed;
  const line = (label, g) => g
    ? `${label}: ${g.accounts} account${g.accounts === 1 ? "" : "s"}, about US$${g.usdEach.toFixed(3)} and ${Math.round(g.secondsEach)} s each ` +
      `(${g.searchesEach.toFixed(1)} searches, ${g.fetchesEach.toFixed(1)} pages read); ${g.contacts} people added from company websites and reports, ` +
      `${g.initiatives} initiatives, ${g.filled} empty fields filled, ${g.pages} LinkedIn company pages found; ` +
      `LinkedIn profiles found from web search results for ${g.profileFound + g.profiles} of ${g.profileAsked + g.profiles} people without one (the rest: a LinkedIn name search later)` +
      (g.cutOff ? `; ${g.cutOff} cut off at the 4-minute limit` : "") + (g.noData ? `; ${g.noData} without a data line` : "")
    : null;
  return [
    `${completed} of ${s.total} accounts researched${s.failed ? `, ${s.failed} failed` : ""}, about US$${(s.spent || 0).toFixed(2)} in all` +
      `${s.stoppedReason ? ` (stopped: ${s.stoppedReason})` : ""}.`,
    line("Publicly traded", m.traded),
    line("Private and other", m.other),
  ].filter(Boolean).join("\n");
}

// 1.2.0.50 (Boaz): the pop-up's version - what was done and what it cost; measureText above stays in the Activity Log.
export function measureShortText(s) {
  const m = measureLane(s.results);
  const groups = [m.traded, m.other].filter(Boolean);
  const sum = (k) => groups.reduce((a, g) => a + (g[k] || 0), 0);
  const completed = s.done - s.failed;
  return [
    `${completed} of ${s.total} accounts researched${s.failed ? ` (${s.failed} could not be)` : ""}` +
      `${s.stoppedReason ? ` - stopped: ${s.stoppedReason}` : ""}.`,
    `Found: ${sum("contacts")} people, ${sum("initiatives")} initiatives, ${sum("filled")} missing facts filled in.`,
    `Total cost: about US$${(s.spent || 0).toFixed(2)}.`,
  ].join("\n");
}

// The people at this company without a LinkedIn profile, best first (a known seniority, then a job title),
// at most 6 - two searches cover about that many names.
async function peopleWithoutProfile(companyId) {
  if (!companyId) return [];
  const wb = await getTargetAccountsWorkbook();
  return (wb.contacts || [])
    .filter((c) => c.companyId === companyId && c.fullName && !/linkedin\.com\/in\//i.test(c.lastVerified2 || ""))
    .sort((a, b) => (b.seniorityLevel || b.seniority ? 1 : 0) - (a.seniorityLevel || a.seniority ? 1 : 0) || (b.jobTitle ? 1 : 0) - (a.jobTitle ? 1 : 0))
    .slice(0, 6)
    .map((c) => ({ fullName: c.fullName, title: c.jobTitle || null }));
}

// One Activity Log line per account, so a run can be read account by account.
export function accountLine(r) {
  const bits = [`${r.seconds} s`, `about US$${(r.costUsd || 0).toFixed(3)}`];
  if (/haiku/i.test(r.model || "")) bits.push("Haiku");   // 1.2.0.14: contacts-only researches, to compare with Sonnet
  if (r.searches || r.fetches) bits.push(`${r.searches} searches, ${r.fetches} pages read${r.turns > 1 ? `, ${r.turns} rounds` : ""}`);
  if (r.stopped === "timeout") bits.push("CUT OFF at 4 minutes");
  if (r.dataLine === false && r.searches + r.fetches > 0) bits.push("no data line in the answer"); // older records have no dataLine
  if (r.contacts) bits.push(`${r.contacts} contacts added`);
  if (r.initiatives) bits.push(`${r.initiatives} initiatives`);
  if (r.filled) bits.push(`${r.filled} fields filled`);
  if (r.profileAsked) bits.push(`profiles: ${r.profileFound} of ${r.profileAsked} found`);
  return `Web research (new) - ${r.company} [${(r.topics || []).join(", ")}]: ${bits.join("; ")}`;
}
