// The 1.2 data pipeline's loop, build step 2 (DATA_PIPELINE_DESIGN.md sections 5.2-5.5 and the step 2
// touch-ups T1-T4). Runs in the background worker, depth-first: it takes the account that most deserves
// work (pipeline-plan.js rankCandidates), runs every LinkedIn job that account needs, re-scores it, and
// moves to the next.
//
// Two ways in. By hand, from Advanced tools > Run pipeline now, for a set number of accounts (step 2).
// Automatically (step 3), once the user has turned it on: kickPipeline() is called when Chrome starts,
// when a SalesTeam page opens and every 10 minutes while one is open, and when a user's batch job ends
// (design 5.4). An automatic run has no account limit - it stops at the 75-visit ceiling or when nothing
// is left for today - and it does not keep the computer awake (D4). Both use one small unfocused window
// of their own holding a single LinkedIn tab (decision D1, proven by step 0), never brought to the front.
//
// U2: the pipeline makes way for any job the user starts. guardBatchStart (batch-jobs.js) sends
// PIPELINE_PAUSE; the run stops after the account in progress and stays out of the way for a few
// minutes, and the end of the user's job kicks it again.
//
// The batch lock is taken per account, not for the whole run (5.2): between two accounts it is free.
// Progress lives in storage under "pipelineState"; pipeline-status.js shows it on every SalesTeam page.
//
// Build step 5 (W1-W6): web research joins as two more jobs, web_gap and web_full, paid from the user's
// monthly web budget instead of LinkedIn visits. So the 60-visit ceiling no longer ends a run by itself:
// once it is reached, the run carries on with accounts that only need web research, and the LinkedIn
// window is opened only for an account that needs a LinkedIn job.
import {
  getAccountViews, getReadinessConfig, savePipelineAccountState, applyResolvedCompanyIds, markLinkedinResolveAttempted,
  applyEmployeeCheck, setContactLinkedinProfile, appendActivityLog, settleSafeDuplicates,
  applyPipelineWebResearch, autoResolveWebFindings, getTargetAccountsWorkbook, normalizeCompanyName,
  getCompanyContext, getIdealCustomerProfile, getOutputLanguage, getTargetUniverseConfig, getCompletionTargets, getTargetsStatus,
  getOnboardingCompletedAt,
} from "./storage.js";
import { researchAccountOnWeb, apiBlockedReason } from "./agent-shared.js";
import { pageNamesAgree, cleanPageName, isEmptyPageBand } from "./decision-rules.js";
import { assessAccount, companyLinkSlug, countReadiness, MIN_READY_TO_SCAN } from "./readiness.js";
import { WEB_LANE_STATE_KEY, startWebLane, isWebLaneRunning } from "./web-lane.js";
import { startWebDiscovery, isWebDiscoveryRunning } from "./web-discovery.js";
import {
  rankCandidates, jobsNeeded, localDay, withFailedAttempt, pickProfileMatch, profileContactToTry, profileUrlFromSlug,
  parseSizeBand, sizeVerdict, nameTokens, PIPELINE_TOUCH_CEILING, autoRunBlocker, USER_JOB_HOLD_MS,
  isLinkedinJob, webPlan, WEB_JOBS, WEB_GAP_TOPICS, READY_GOAL_KEY, discoveryMayRun,
  isLinkedinLoginWall, linkedinLoggedOutRecently, LINKEDIN_LOGGED_OUT_KEY, heldForWebLane,
} from "./pipeline-plan.js";
import { resolveAccountOnTab } from "./company-resolve-extraction.js";
import { armSizeRead, disarmSizeRead, readSizeOnTab } from "./company-size-extraction.js";
import { searchCompanyPeopleByName, discoverContactsForAccount } from "./contact-discovery-extraction.js";
import { getLinkedinTouchStats, countTouchesSince, recordLinkedinTouch } from "./linkedin-touch-log.js";
import { withBatch, BatchBusyError, getRunningBatch, busyMessage } from "./batch-jobs.js";
import { rescoreDerivedPriorities } from "./auto-score.js";
import { teamWorkGate, claimAccount, releaseAccount } from "./team-sync.js";
import {
  getPipelineAutomation, PIPELINE_IDLE_KEY, PIPELINE_HOLD_KEY, webBudgetState, recordWebSpend, setWebBlocked, apiKeyTail,
} from "./pipeline-automation.js";

export const PIPELINE_STATE_KEY = "pipelineState";
// 1.2.0.10: accounts per automatic web lane run, started while the LinkedIn visits are used up. Each kick
// (every 10 minutes while a page is open) can start the next one; the monthly web budget is the limit.
const AUTO_WEB_LANE_ACCOUNTS = 20;
// A web lane run whose record has not been saved for this long belongs to a worker that died (a reload).
const WEB_LANE_STALE_MS = 2 * 60 * 1000;
const RUN_LABEL = "Run pipeline now";
// Keyword chunks a title-based contact discovery usually needs - a planning estimate only (5.1).
const TYPICAL_CONTACT_CHUNKS = 2;
// Per account and day: how many known contacts the profile job may search for by name.
// Since 1.2.1 step 4 (D2) the first search is followed by the People page; more than one name search a day
// happens only once the People page has given up.
const MAX_PROFILE_SEARCHES_PER_ACCOUNT = 3;
const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 9000;
const NAV_TIMEOUT_MS = 20000;
const MAX_ACCOUNT_LINES = 50;
// Web searches a full (depth) research may make. 3, not the manual research's 4 (Boaz, 2026-09-28): the
// first live run cost US$0.20 a research at 4 searches, as every search result is read back as input.
const DEPTH_MAX_SEARCHES = 3;
// Why a run ended, as the Activity Log line says it (the codes alone were misread, 2026-09-28).
const LOG_REASONS = {
  budget: "LinkedIn limit reached",
  linkedin_limit_web_done: "LinkedIn limit reached; no account needs web research now",
  nothing_left: "nothing left to do today",
  made_way: "made way for your job",
  user: "stopped by you",
  linkedin_logged_out: "LinkedIn is not logged in in this browser - log in at linkedin.com",
  team_offline: "the team folder is not connected",
};
// Team use 1.2.2 step 4: how often a running account's claim is renewed (a claim runs out after 5 idle minutes).
const TEAM_CLAIM_RENEW_MS = 60000;
const LAST_AUTO_BACKUP_KEY = "lastAutoBackupAt"; // backup-restore.js
// 1.2.1 step 6 (design 8): the last automatic Web Discovery, { accountsTarget, at } - see discoveryMayRun.
const AUTO_DISCOVERY_KEY = "autoDiscoveryLast";

let runner = null; // { stopRequested, pauseRequested, state }
let kicking = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

export async function startPipelineRun({ limit, auto = false, source = null } = {}) {
  if (runner) return { ok: false, error: "The pipeline is already running." };
  await closeInterruptedRecord();
  const running = await getRunningBatch();
  if (running) return { ok: false, busy: true, error: busyMessage(running, RUN_LABEL) };
  const stats = await getLinkedinTouchStats();
  if (stats.last24h >= PIPELINE_TOUCH_CEILING && (await webBudgetState()).reason) {
    return { ok: false, error: `The pipeline stops at ${PIPELINE_TOUCH_CEILING} LinkedIn page visits in any 24 hours, and ${stats.last24h} have been used. Try again later.` };
  }
  // An automatic run has no account limit (null): the ceiling or an empty list ends it.
  const n = auto ? null : Math.max(1, Math.min(500, Math.floor(Number(limit) || 5)));
  const state = {
    status: "running", auto, source, limit: n, done: 0, touches: 0, current: null, remaining: null, ready: null, accounts: [],
    stoppedReason: null, error: null, busyLabel: null, madeWayFor: null, readyBefore: null, readyAfter: null,
    webResearches: 0, webUsd: 0,
    // An automatic run shows no pop-up at the end (U3): it is born acknowledged.
    startedAt: Date.now(), heartbeatAt: Date.now(), finishedAt: null, acknowledged: auto,
  };
  runner = { stopRequested: false, pauseRequested: false, state };
  await chrome.storage.local.remove(PIPELINE_IDLE_KEY).catch(() => {});
  await chrome.storage.local.set({ [PIPELINE_STATE_KEY]: state });
  run(runner).catch(() => {}).finally(() => { runner = null; });
  return { ok: true };
}

export function stopPipelineRun() {
  if (runner) {
    runner.stopRequested = true;
    // A web research in progress stops at once and keeps what it found (as the bulk research's Stop does).
    if (runner.webAbort) runner.webAbort.abort();
  }
  return { ok: Boolean(runner) };
}

// U2: a user is starting a job of their own. Stop after the account in progress and stay out of the way
// for USER_JOB_HOLD_MS, so their job can take the batch lock first.
export async function pausePipelineForUser(forLabel) {
  await chrome.storage.local.set({ [PIPELINE_HOLD_KEY]: Date.now() + USER_JOB_HOLD_MS });
  if (runner) {
    runner.pauseRequested = true;
    runner.state.madeWayFor = forLabel || null;
  }
  return { ok: true, wasRunning: Boolean(runner) };
}

// The user's job has ended (its batch lock was released): the hold is no longer needed.
export async function clearUserJobHold() {
  await chrome.storage.local.remove(PIPELINE_HOLD_KEY).catch(() => {});
}

// A record still saying "running" while this worker has no runner belongs to a worker that died (an
// extension reload, Chrome closed mid-run). Close it, and its window, before anything new starts.
async function closeInterruptedRecord() {
  if (runner) return;
  const s = (await chrome.storage.local.get(PIPELINE_STATE_KEY))[PIPELINE_STATE_KEY];
  if (!s || s.status !== "running") return;
  if (s.windowId) await chrome.windows.remove(s.windowId).catch(() => {});
  await chrome.storage.local.set({ [PIPELINE_STATE_KEY]: { ...s, status: "finished", stoppedReason: "interrupted", current: null, finishedAt: Date.now() } });
}

// The automatic trigger (design 5.4). Cheap when there is nothing to do: it never opens the LinkedIn
// window unless an account can actually be worked on.
export async function kickPipeline(source) {
  if (runner || kicking) return { started: false, reason: "running" };
  kicking = true;
  try {
    await closeInterruptedRecord();
    const auto = await getPipelineAutomation();
    if (!auto.enabled) return { started: false, reason: "off" };
    const store = await chrome.storage.local.get([PIPELINE_HOLD_KEY, LAST_AUTO_BACKUP_KEY, LINKEDIN_LOGGED_OUT_KEY]);
    const [stats, runningBatch, web] = await Promise.all([getLinkedinTouchStats(), getRunningBatch(), webBudgetState()]);
    const now = Date.now();
    // 1.2.1 step 6 (design 8): the stop rule's discovery. Web only, so it needs the web budget, not LinkedIn.
    if (auto.pausedDay !== localDay(now) && !web.reason) await discoverForTargets(web, { now }).catch(() => {});
    let held = 0;
    let reason = autoRunBlocker({
      enabled: auto.enabled, pausedDay: auto.pausedDay, today: localDay(now), holdUntil: store[PIPELINE_HOLD_KEY] || 0,
      runningBatch, lastBackupAt: store[LAST_AUTO_BACKUP_KEY] || 0, now, webPossible: !web.reason,
      // Logged out a short while ago: LinkedIn counts as used up, so only web work may start a run.
      touches24h: linkedinLoggedOutRecently(store[LINKEDIN_LOGGED_OUT_KEY], now) ? PIPELINE_TOUCH_CEILING : stats.last24h,
    });
    if (!reason) {
      // W5: settling the web findings the rules can settle is local and free, so it happens on every
      // kick that could start a run, whether or not there is LinkedIn or web work to do.
      await autoResolveWebFindings().catch(() => {});
      const { entries, counts } = await readinessNow();
      const loggedOut = linkedinLoggedOutRecently(store[LINKEDIN_LOGGED_OUT_KEY], now);
      const opts = { linkedin: !loggedOut && stats.last24h < PIPELINE_TOUCH_CEILING, web: !web.reason, ...(await planContext(counts)) };
      if (rankCandidates(entries, now, TYPICAL_CONTACT_CHUNKS, opts).length === 0) {
        // 1.2.0.57 (Boaz, after Finish Setup): accounts the web lane is still researching are held back, and that
        // read as "All accounts processed for today" while 17 accounts still needed their LinkedIn page.
        held = entries.filter((e) => e.view && !e.view.deleted && !e.view.excluded && heldForWebLane(e.view, opts.webLaneHold, now)).length;
        reason = held ? "web_lane" : opts.linkedin ? "nothing_left" : "budget";
      }
    }
    if (reason) {
      // Kept only for the reasons the status line explains; hold and busy pass by themselves.
      if (["nothing_left", "no_backup", "budget", "web_lane"].includes(reason)) {
        await chrome.storage.local.set({ [PIPELINE_IDLE_KEY]: { reason, at: now, held } });
      }
      // 1.2.0.10 (Boaz, 2026-10-01): the LinkedIn visits are used up and the pipeline has no web research of its
      // own to do, but the web budget allows more - the web lane carries on (contacts, profiles, initiatives).
      if (reason === "budget" && !web.reason && stats.last24h >= PIPELINE_TOUCH_CEILING && !isWebLaneRunning()) {
        const left = Math.max(0, (Number(web.monthlyUsd) || 0) - (Number(web.spentUsd) || 0));
        const lane = await startWebLane({ limit: AUTO_WEB_LANE_ACCOUNTS, budget: left, auto: true }).catch(() => null);
        if (lane && lane.ok) return { started: false, reason, webLane: true };
      }
      return { started: false, reason };
    }
    const res = await startPipelineRun({ auto: true, source });
    return { started: Boolean(res.ok), reason: res.ok ? null : (res.error || "not started") };
  } finally {
    kicking = false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Targets (1.2.1 step 6, design 3.11 and 8)
// ---------------------------------------------------------------------------------------------------

const webBudgetLeft = (web) => Math.max(0, (Number(web.monthlyUsd) || 0) - (Number(web.spentUsd) || 0));

// While the list is short of the accounts target, Web Discovery adds what is owed (once per target: again when it
// is raised, or a week later). When it is done, the web lane researches what the new accounts lack. `fromSetup`:
// the wizard's Finish - always runs when accounts are owed, and ends with the usual pop-up.
async function discoverForTargets(web, { now = Date.now(), fromSetup = false } = {}) {
  if (isWebDiscoveryRunning()) return { started: false, reason: "running" };
  const targets = await getCompletionTargets();
  const last = (await chrome.storage.local.get(AUTO_DISCOVERY_KEY))[AUTO_DISCOVERY_KEY] || null;
  if (!fromSetup && !discoveryMayRun(last, targets.accounts, now)) return { started: false, reason: "done_for_target" };
  // Never before the setup is finished: the targets and the countries are not settled until then.
  if (!fromSetup && !(await getOnboardingCompletedAt())) return { started: false, reason: "setup_not_done" };
  const status = await getTargetsStatus();
  if (status.accountsOwed <= 0) {
    // Checked for this target: the next check comes when the target is raised, or in a week.
    await chrome.storage.local.set({ [AUTO_DISCOVERY_KEY]: { accountsTarget: targets.accounts, at: now, enough: true } });
    return { started: false, reason: "enough_accounts", status };
  }
  // The run is marked done for this target only when it ends (stopped by the user included): a run cut off by an
  // extension reload leaves no mark, so the next kick starts it again for what is still owed.
  const res = await startWebDiscovery({
    target: status.accountsOwed, budget: webBudgetLeft(web), auto: true, quiet: !fromSetup,
    onDone: async (state) => {
      await chrome.storage.local.set({ [AUTO_DISCOVERY_KEY]: { accountsTarget: targets.accounts, at: Date.now() } }).catch(() => {});
      if (state.stoppedReason !== "user") await startLaneForTargets().catch(() => {});
    },
  });
  return { started: Boolean(res && res.ok), owed: status.accountsOwed };
}

// The web lane for the accounts below their targets, up to the accounts target in one run, under the web budget.
async function startLaneForTargets() {
  if (isWebLaneRunning()) return { started: false, reason: "running" };
  const auto = await getPipelineAutomation();
  const web = await webBudgetState();
  if (!auto.enabled || auto.pausedDay === localDay() || web.reason) return { started: false, reason: web.reason || "off" };
  const targets = await getCompletionTargets();
  const lane = await startWebLane({ limit: targets.accounts, budget: webBudgetLeft(web), auto: true }).catch((err) => ({ ok: false, error: err.message }));
  return { started: Boolean(lane && lane.ok), error: lane && lane.error };
}

// The wizard's Finish (design 3.11, R3.4.1): Web Discovery for what is owed, then the web lane; the LinkedIn lane
// is kicked as usual. With nothing to discover the web lane starts at once. The wizard itself never visits LinkedIn.
export async function startOnboardingBuild() {
  const auto = await getPipelineAutomation();
  const web = await webBudgetState();
  let discovery = { started: false, reason: auto.enabled ? web.reason || null : "off" };
  if (auto.enabled && !web.reason) discovery = await discoverForTargets(web, { fromSetup: true }).catch((err) => ({ started: false, error: err.message }));
  const lane = discovery.started ? { started: false, reason: "after_discovery" } : await startLaneForTargets().catch((err) => ({ started: false, error: err.message }));
  const pipeline = await kickPipeline("setup_finished").catch(() => null);
  return { ok: true, discovery, lane, pipeline };
}

// ---------------------------------------------------------------------------------------------------
// The worker window (D1)
// ---------------------------------------------------------------------------------------------------

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(ok); } };
    const timer = setTimeout(() => done(false), NAV_TIMEOUT_MS);
    function listener(id, info) { if (id === tabId && info.status === "complete") done(true); }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// A small normal window that never takes focus, holding the one LinkedIn tab. Its first page is the
// feed: the same cold-start warm-up every runner does, so the first real lookup is never the tab's
// first navigation. That visit is a touch like any other.
async function openWorkerWindow() {
  const win = await chrome.windows.create({ url: "https://www.linkedin.com/feed/", focused: false, width: 560, height: 640, type: "normal" });
  recordLinkedinTouch().catch(() => {});
  const tab = win.tabs && win.tabs[0];
  if (tab) await waitForTabComplete(tab.id);
  return { windowId: win.id, tab };
}

async function workerAlive(worker) {
  try { return Boolean(worker && worker.tab && (await chrome.tabs.get(worker.tab.id))); } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------
// The loop (5.2)
// ---------------------------------------------------------------------------------------------------

async function readinessNow() {
  const [views, cfg] = await Promise.all([getAccountViews(), getReadinessConfig()]);
  const now = Date.now();
  const entries = views.map((view) => ({ view, assessment: assessAccount(view, cfg, now), pipeline: view.pipeline || {} }));
  return { views, cfg, entries, counts: countReadiness(entries.filter((e) => !e.view.deleted && !e.view.excluded).map((e) => e.assessment)) };
}

// 1.2.1 step 4: what the ranking needs beyond the budgets - the D7 goal (fewer than MIN_READY_TO_SCAN Ready)
// and the accounts a web lane run in progress still holds (design 7.1).
async function planContext(counts) {
  const lane = (await chrome.storage.local.get(WEB_LANE_STATE_KEY))[WEB_LANE_STATE_KEY];
  const alive = lane && lane.status === "running" && Date.now() - (lane.heartbeatAt || 0) < WEB_LANE_STALE_MS;
  return {
    readyGoal: counts.ready < MIN_READY_TO_SCAN,
    webLaneHold: alive ? { keys: [...(lane.pendingKeys || []), ...(lane.runningKeys || [])], since: lane.startedAt } : null,
  };
}

// Measures the way to the first MIN_READY_TO_SCAN Ready accounts (step 4's check: time to 10 Ready, touches
// per account). `ready`: the current count, or null; `account`: one account just handled, or null. Measured
// once per install: after the goal is met the record stays as it is, for the Scanner's estimate and for us.
async function trackReadyGoal(ready, account) {
  const g = (await chrome.storage.local.get(READY_GOAL_KEY))[READY_GOAL_KEY] || null;
  if (g && g.reachedAt) return;
  const now = Date.now();
  if (!g) {
    if (ready == null || ready >= MIN_READY_TO_SCAN) return;
    await chrome.storage.local.set({ [READY_GOAL_KEY]: { startedAt: now, readyAtStart: ready, ready, accounts: 0, touches: 0, workMs: 0, readyMade: 0, reachedAt: null } });
    return;
  }
  const next = { ...g };
  if (account) {
    next.accounts++;
    next.touches += account.touches || 0;
    next.workMs += account.ms || 0;
    if (account.becameReady) next.readyMade++;
  }
  if (ready != null) next.ready = ready;
  if (ready != null && ready >= MIN_READY_TO_SCAN) {
    next.reachedAt = now;
    const min = (ms) => Math.max(1, Math.round(ms / 60000));
    appendActivityLog({
      actor: "extension",
      action: "pipeline_ready_goal",
      label: `First ${MIN_READY_TO_SCAN} accounts Ready (from ${next.readyAtStart}): ${min(now - next.startedAt)} min after the pipeline started, ` +
        `${min(next.workMs)} min of pipeline work, ${next.touches} LinkedIn page visit${next.touches === 1 ? "" : "s"} on ${next.accounts} account${next.accounts === 1 ? "" : "s"}`,
      newValue: next,
    }).catch(() => {});
  }
  await chrome.storage.local.set({ [READY_GOAL_KEY]: next });
}

async function run(r) {
  const s = r.state;
  const save = () => chrome.storage.local.set({ [PIPELINE_STATE_KEY]: { ...s, heartbeatAt: Date.now() } }).catch(() => {});
  // Extension API calls keep the background worker alive; this also keeps the "still alive" stamp fresh.
  const keepAlive = setInterval(save, 10000);
  // Only a run the user started keeps the computer awake (D4): an automatic one freezes with sleep and
  // is picked up again by the next kick.
  if (!s.auto) chrome.power.requestKeepAwake("system");
  let worker = null;
  try {
    await autoResolveWebFindings().catch(() => {});   // W5: local and free, before anything is ranked
    const first = await readinessNow();
    s.readyBefore = first.counts.ready;
    const underLimit = () => s.limit == null || s.done < s.limit;
    const teamRefused = new Set(); // accounts a colleague claimed between the gate and our claim
    while (!r.stopRequested && !r.pauseRequested && underLimit()) {
      // W1: the LinkedIn ceiling stops the LinkedIn jobs only; web research goes on within its budget.
      const loggedOutAt = (await chrome.storage.local.get(LINKEDIN_LOGGED_OUT_KEY))[LINKEDIN_LOGGED_OUT_KEY];
      const linkedinOk = !linkedinLoggedOutRecently(loggedOutAt) && (await getLinkedinTouchStats()).last24h < PIPELINE_TOUCH_CEILING;
      const webOk = !(await webBudgetState()).reason;
      if (!linkedinOk && !webOk) { s.stoppedReason = "budget"; break; }
      const { cfg, entries, counts } = s.done === 0 ? first : await readinessNow();
      s.ready = counts.ready;
      const now = Date.now();
      const opts = { linkedin: linkedinOk, web: webOk, ...(await planContext(counts)) };
      await trackReadyGoal(counts.ready, null);
      // Team use (design 6.5, R3.5): skip what a colleague holds, work only this member's share of the rest.
      const gate = await teamWorkGate().catch(() => null);
      if (gate && !gate.connected) { s.stoppedReason = "team_offline"; break; }
      const workable = gate ? entries.filter((e) => !teamRefused.has(e.view.key) && gate.mayWork(e.view.key)) : entries;
      const ranked = rankCandidates(workable, now, TYPICAL_CONTACT_CHUNKS, opts);
      s.remaining = ranked.length;
      const next = ranked[0];
      // At the LinkedIn limit with web research allowed, an empty list means no account needs web research
      // now - not that the money ran out (first live run, 2026-09-28, read as "stopped at US$0.99").
      if (!next) { s.stoppedReason = linkedinOk ? "nothing_left" : webOk ? "linkedin_limit_web_done" : "budget"; break; }

      const needsLinkedin = next.jobs.some(isLinkedinJob);
      if (needsLinkedin && !worker) {
        const before = Date.now();
        worker = await openWorkerWindow();
        s.windowId = worker.windowId; // lets a page close it if this worker dies mid-run (pipeline-status.js)
        s.touches += await countTouchesSince(before);
      }
      if (needsLinkedin && !(await workerAlive(worker))) { s.stoppedReason = "window_closed"; break; }

      // Claimed before any work; its writes are held until the claim is confirmed (team-sync.js), so no wait here.
      const teamKey = next.view.key;
      if (gate) {
        const claimed = await claimAccount(teamKey, { kind: "pipeline" }).catch(() => ({ ok: false }));
        if (!claimed.ok) { teamRefused.add(teamKey); continue; }
      }
      const renew = gate ? setInterval(() => claimAccount(teamKey, { kind: "pipeline" }).catch(() => {}), TEAM_CLAIM_RENEW_MS) : null;
      s.current = next.view.company;
      await save();
      const started = Date.now();
      let outcome;
      try {
        outcome = await withBatch(`SalesTeam is preparing accounts (${next.view.company})`,
          () => runAccount(worker ? worker.tab : null, next, cfg, r, opts), { pipeline: true });
      } catch (err) {
        if (err instanceof BatchBusyError) { s.stoppedReason = "busy"; s.busyLabel = err.running?.label || null; break; }
        throw err;
      } finally {
        if (renew) clearInterval(renew);
        if (gate) await releaseAccount(teamKey).catch(() => {});
      }
      const touches = await countTouchesSince(started);
      s.touches += touches;
      s.done++;
      s.accounts = [...s.accounts, { company: next.view.company, lines: outcome.lines, touches, state: outcome.state }].slice(-MAX_ACCOUNT_LINES);
      await trackReadyGoal(null, { ms: Date.now() - started, touches, becameReady: outcome.becameReady });
      s.current = null;
      await save();
      s.webResearches += outcome.webResearches || 0;
      s.webUsd += outcome.webUsd || 0;
      if (outcome.windowClosed) { s.stoppedReason = "window_closed"; break; }
      if (outcome.loggedOut) {
        s.stoppedReason = "linkedin_logged_out";
        await chrome.storage.local.set({ [LINKEDIN_LOGGED_OUT_KEY]: Date.now() });
        break;
      }
      // The pause between accounts paces LinkedIn; an account that visited no LinkedIn page needs none.
      if (!r.stopRequested && !r.pauseRequested && underLimit()) await sleep(touches > 0 ? randomDelay() : 500);
    }
    if (!s.stoppedReason) s.stoppedReason = r.stopRequested ? "user" : r.pauseRequested ? "made_way" : "limit";
  } catch (err) {
    s.stoppedReason = "error";
    s.error = String((err && err.message) || err);
  } finally {
    clearInterval(keepAlive);
    if (!s.auto) chrome.power.releaseKeepAwake();
    if (worker) await chrome.windows.remove(worker.windowId).catch(() => {});
    // Step 4 (V3): a re-check can reveal that two accounts are the same LinkedIn company. Settled here,
    // after the run, when merging cannot pull a row out from under the account being worked on.
    if (s.done > 0) await settleSafeDuplicates().catch(() => {});
    try { s.readyAfter = (await readinessNow()).counts.ready; s.ready = s.readyAfter; await trackReadyGoal(s.readyAfter, null); } catch { /* the summary just lacks the count */ }
    s.status = "finished";
    s.current = null;
    s.finishedAt = Date.now();
    await save();
    if (s.stoppedReason === "nothing_left") await chrome.storage.local.set({ [PIPELINE_IDLE_KEY]: { reason: "nothing_left", at: Date.now() } }).catch(() => {});
    // An automatic run that handled nothing (it made way at once, say) is not worth a log line.
    if (!(s.auto && s.done === 0)) appendActivityLog({
      actor: "extension",
      action: "pipeline_run",
      label: `${s.auto ? "Automatic pipeline run" : "Pipeline run"}: ${s.done} account${s.done === 1 ? "" : "s"}, ${s.touches} LinkedIn page visit${s.touches === 1 ? "" : "s"}` +
        (s.webResearches > 0 ? `, ${s.webResearches} web research${s.webResearches === 1 ? "" : "es"} (about US$${s.webUsd.toFixed(2)})` : "") +
        (s.readyBefore != null && s.readyAfter != null ? `, Ready ${s.readyBefore} -> ${s.readyAfter}` : "") + ` (${LOG_REASONS[s.stoppedReason] || s.stoppedReason})`,
      newValue: { done: s.done, touches: s.touches, webResearches: s.webResearches, webUsd: s.webUsd, stoppedReason: s.stoppedReason, readyBefore: s.readyBefore, readyAfter: s.readyAfter },
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------
// One account: every job it needs, in order, re-assessed after each (5.2 runAccount)
// ---------------------------------------------------------------------------------------------------

async function freshView(key) {
  return (await getAccountViews()).find((v) => v.key === key) || null;
}

async function runAccount(tab, entry, cfg, r, opts) {
  const key = entry.view.key;
  const day = localDay();
  const startedAt = Date.now();
  const wasReady = entry.assessment.state === "ready";
  const lines = [];
  let view = entry.view;
  let pipeline = { ...(view.pipeline || {}) };
  let jobs = entry.jobs;
  const ran = new Set();        // considered in this run
  const attempted = new Set();  // actually visited LinkedIn for
  const failed = new Set();
  const replacedLinks = [];
  let profileSearches = 0;
  let windowClosed = false;
  let webResearches = 0;
  let webUsd = 0;

  // Making way for the user (U2) happens after the JOB in progress, not the whole account: an account with a
  // resolve, a size, a People page and three profile searches takes minutes of paced LinkedIn visits, and the
  // user's job gave up waiting after 2.5 (1.2.0.1 live test, 2026-09-28). An account cut short is not marked as
  // handled today, so the next run picks it up again.
  let cutShort = false;
  let loggedOut = false; // 1.2.0.32: a LinkedIn page ended on the login wall
  while (!r.stopRequested) {
    const job = jobs.find((j) => (j === "profile" ? profileSearches < MAX_PROFILE_SEARCHES_PER_ACCOUNT : !ran.has(j)));
    if (!job) break;
    if (r.pauseRequested) { cutShort = true; break; }
    if (WEB_JOBS.has(job)) {
      // One research per account and pass, whichever kind (a full one covers the gaps).
      for (const j of WEB_JOBS) ran.add(j);
      const plan = webPlan(view, assessAccount(view, cfg, Date.now()), pipeline, Date.now(), jobs.filter(isLinkedinJob));
      if (!plan) continue;
      attempted.add(plan.job);
      const res = await doWeb(view, plan, r);
      if (res.line) lines.push(res.line);
      if (res.ok) {
        webResearches++;
        webUsd += res.costUsd || 0;
        if (plan.topics) {
          const at = Date.now();
          pipeline = { ...pipeline, webGapAt: { ...(pipeline.webGapAt || {}), ...Object.fromEntries(plan.topics.map((t) => [t, at])) } };
        }
      } else if (res.failed) failed.add(plan.job);
      view = (await freshView(key)) || view;
      jobs = jobsNeeded(view, assessAccount(view, cfg, Date.now()), pipeline, Date.now(), { ...opts, profileSearches });
      continue;
    }
    // LinkedIn jobs: none without the worker window, none once the day's visits are used up (W1).
    if (!tab || (await getLinkedinTouchStats()).last24h >= PIPELINE_TOUCH_CEILING) { ran.add(job); continue; }
    try { await chrome.tabs.get(tab.id); } catch { windowClosed = true; break; }
    ran.add(job);
    // Everything but resolve needs the company's own page. A failed lookup can leave an account with
    // no link: then the job is skipped, not counted as a failed day.
    if (job !== "resolve" && !companyLinkSlug(view.linkedinLink)) continue;
    attempted.add(job);

    if (job === "resolve") {
      // T3: when the size is needed too and the account has its own page link, the size reader rides
      // along on the resolver's visit.
      const withSize = jobs.includes("size") && Boolean(companyLinkSlug(view.linkedinLink));
      if (withSize) { ran.add("size"); attempted.add("size"); }
      const res = await doResolve(tab, view, withSize, day);
      if (res.loggedOut) { loggedOut = true; break; }
      lines.push(...res.lines);
      if (res.pageChange) pipeline = { ...pipeline, pageChange: res.pageChange };
      if (res.idTaken) pipeline = { ...pipeline, idTaken: res.idTaken };
      if (res.emptyPage) pipeline = { ...pipeline, emptyPage: day };
    } else if (job === "size") {
      const res = await doSize(tab, view);
      lines.push(...res.lines);
      if (res.emptyPage) pipeline = { ...pipeline, emptyPage: day };
    } else if (job === "profile") {
      profileSearches++;
      const res = await doProfile(tab, view, pipeline);
      lines.push(res.line);
      if (res.tried) pipeline = { ...pipeline, profileTried: [...(pipeline.profileTried || []), res.tried] };
      if (res.replacedLink) replacedLinks.push({ contact: res.tried, link: res.replacedLink });
    } else if (job === "contacts") {
      lines.push(await doContacts(tab, view));
    }

    // Any LinkedIn job: a page that ended on the login wall found nothing - stop, and count no failed day.
    const pageNow = await chrome.tabs.get(tab.id).catch(() => null);
    if (pageNow && isLinkedinLoginWall(pageNow.url)) { loggedOut = true; break; }
    view = (await freshView(key)) || view;
    const assessment = assessAccount(view, cfg, Date.now());
    jobs = jobsNeeded(view, assessment, pipeline, Date.now(), { ...opts, profileSearches });
    // A job that ran and is still needed did not close its gap: one failed day for it (5.5). The
    // profile job keeps its own record instead - the names already searched. A web job counts as failed
    // only when the research itself failed (above): its result can wait in Decisions for days.
    for (const j of attempted) if (j !== "profile" && !WEB_JOBS.has(j) && jobs.includes(j)) failed.add(j);
  }

  if (cutShort) lines.push("Paused here to make way for your job - the rest of this account follows in a later run");
  if (loggedOut) {
    lines.push("Stopped: LinkedIn is not logged in in this browser - this account's LinkedIn work follows once you log in");
    attempted.clear();
    failed.clear();
    cutShort = true; // keeps the account's last run day as it was, so it is taken again soon
  }
  let attempts = pipeline.attempts || {};
  for (const j of failed) attempts = withFailedAttempt({ attempts }, j, day);
  // The whole state is written, not only what changed: when the account's inputs changed (step 4,
  // R12.5.2), view.pipeline arrived already cleared, and this is where the clearing is stored.
  await savePipelineAccountState(key, {
    attempts, profileTried: pipeline.profileTried || [], lastRunDay: cutShort ? (pipeline.lastRunDay || null) : day, inputsKey: view.inputsKey || pipeline.inputsKey || null,
    emptyPage: pipeline.emptyPage || null, keep: Boolean(pipeline.keep), pageChange: pipeline.pageChange || null,
    idTaken: pipeline.idTaken || null, webGapAt: pipeline.webGapAt || {},
  });
  if (pipeline.emptyPage) lines.push("LinkedIn page looks empty (0-1 employees): waiting for your decision (Keep or Remove)");

  // The score job (5.1): locally, for this account, never a manual or AI-judged priority.
  const before = view.salesTeamPriority;
  const scored = await rescoreDerivedPriorities({ onlyCompanyIds: [view.companyId] });
  if (scored.applied > 0) {
    const after = scored.results[0]?.priority;
    if (after && after !== before) lines.push(`Priority ${before || "none"} -> ${after}`);
  }

  view = (await freshView(key)) || view;
  const finalState = assessAccount(view, cfg, Date.now()).state;
  const becameReady = !wasReady && finalState === "ready";
  // Step 4's measurement (touches per account vs. design section 9): the visits this account took.
  const touches = await countTouchesSince(startedAt).catch(() => null);
  appendActivityLog({
    actor: "extension",
    action: "pipeline_account",
    label: `Pipeline: ${view.company} - ${lines.length ? lines.join("; ") : "nothing changed"}` +
      (touches ? ` (${touches} LinkedIn page visit${touches === 1 ? "" : "s"}${becameReady ? ", now Ready" : ""})` : becameReady ? " (now Ready)" : ""),
    // A Contact Link that pointed at another page (often the news article the research cited) and was
    // replaced by the LinkedIn profile is kept here, so the evidence can still be found.
    newValue: { lines, state: finalState, touches, becameReady, ...(replacedLinks.length ? { replacedContactLinks: replacedLinks } : {}) },
    relatedCompanyKey: key,
  }).catch(() => {});
  return { lines, state: finalState, becameReady, windowClosed, loggedOut, webResearches, webUsd };
}

// ---------------------------------------------------------------------------------------------------
// The jobs (5.1). Each writes its values, with provenance, the moment it has them (persist as you go).
// ---------------------------------------------------------------------------------------------------

async function doResolve(tab, view, withSize, day) {
  const lines = [];
  let pageChange = null;
  const company = {
    key: view.key, company: view.company, officialName: view.officialName, alternativeName: view.alternativeName,
    alternativeNames: view.alternativeNames || [],
    linkedinLink: view.linkedinLink,
  };
  let armed = null;
  let attempt;
  let sizeResult = null;
  try {
    if (withSize) armed = await armSizeRead(view.key);
    attempt = await resolveAccountOnTab(tab, company);
    if (armed) sizeResult = await armed.result;
  } finally {
    if (armed) await disarmSizeRead();
  }
  // LinkedIn's login wall, not a search result: nothing is known about this account yet.
  if (isLinkedinLoginWall(attempt.finalUrl) || isLinkedinLoginWall(attempt.fallbackFinalUrl)) return { lines: [], loggedOut: true };
  await markLinkedinResolveAttempted([view.key]);
  const oldId = view.linkedinCompanyId || null;
  // The page shows the very id already stored: the account's link and its id agree, which is the
  // re-check itself - the page-name check (there to stop a wrong link planting a wrong id) adds nothing
  // then. Found on the first pipeline run, where name spellings ("Kühne + Nagel") blocked 2 of 5.
  const pageId = attempt.debug?.currentCompanyIdFound || null;
  if (!attempt.linkedinCompanyId && oldId && pageId && String(pageId) === String(oldId) && company.linkedinLink) {
    attempt.linkedinCompanyId = pageId;
  }
  let idTaken = null;
  if (attempt.linkedinCompanyId) {
    const resolution = {
      key: view.key, linkedinCompanyId: attempt.linkedinCompanyId, companyPageUrl: attempt.companyPageUrl || null,
      checkedLink: attempt.checkedLink, allowWorkbookRow: true, previousId: oldId,
    };
    await applyResolvedCompanyIds([resolution]);
    // W7: found by name, and another account already has this LinkedIn company - the user decides.
    if (resolution.refused) {
      idTaken = resolution.refused;
      lines.push(`LinkedIn search found company id ${idTaken.pageId}, which "${idTaken.otherCompany}" already has: waiting for your decision`);
    } else if (!oldId) lines.push("LinkedIn company found");
    else if (String(oldId) === String(attempt.linkedinCompanyId)) lines.push("LinkedIn company re-checked");
    else lines.push(`LinkedIn company id changed from ${oldId} to ${attempt.linkedinCompanyId} (read from its own page)`);
  } else {
    // Say what the page showed, so a failure can be diagnosed from the summary alone.
    const d = attempt.debug || {};
    const why = attempt.timedOut
      ? ` (the page did not answer${attempt.finalUrl ? `; landed on ${String(attempt.finalUrl).split("?")[0]}` : ""})`
      : d.pageName ? ` (page shows "${d.pageName}"${pageId ? `, id ${pageId}` : ", no id"}${oldId ? `; stored id ${oldId}` : ""})`
      : pageId ? ` (id ${pageId} on the page; stored id ${oldId || "none"})` : " (no id found on the page)";
    // Step 4 (V4): the account's own link opens a page with a DIFFERENT company id - LinkedIn moved or
    // merged the page (SIG Combibloc -> SIG Group), or the stored id was wrong. When the page's name
    // agrees with the account's, the page is accepted, as T4 does for any re-check; when it does not,
    // the user decides.
    const pageName = cleanPageName(d.pageName);
    const differs = pageId && (!oldId || String(pageId) !== String(oldId));
    if (!attempt.timedOut && differs && pageName && view.linkedinLink) {
      if (pageNamesAgree([view.company, view.officialName, view.alternativeName, ...(view.alternativeNames || [])], pageName)) {
        await applyResolvedCompanyIds([{
          key: view.key, linkedinCompanyId: pageId, checkedLink: view.linkedinLink, allowWorkbookRow: true, previousId: oldId,
        }]);
        lines.push(`LinkedIn page now shows "${pageName}": id ${oldId || "none"} -> ${pageId}, accepted (the names agree)`);
      } else {
        pageChange = { pageName, pageId: String(pageId), fromId: oldId ? String(oldId) : null, pageUrl: attempt.finalUrl || null, day };
        lines.push(`LinkedIn company not confirmed${why}: waiting for your decision`);
      }
    } else {
      lines.push(`LinkedIn company not confirmed${why}`);
    }
  }
  let emptyPage = false;
  if (withSize) {
    lines.push(await applySize(view, sizeResult));
    emptyPage = Boolean(sizeResult && sizeResult.resolved && isEmptyPageBand(sizeResult.sizeBandText));
  }
  return { lines, pageChange, emptyPage, idTaken };
}

// ---------------------------------------------------------------------------------------------------
// Web research (build step 5, design section 6, W1-W6). Paid from the monthly web budget, no LinkedIn visit.
// ---------------------------------------------------------------------------------------------------

async function doWeb(view, plan, r) {
  const budget = await webBudgetState();
  if (budget.reason) return { line: null };
  const workbook = await getTargetAccountsWorkbook();
  const company = (workbook.companies || []).find((c) => c.company && normalizeCompanyName(c.company) === view.key);
  if (!company) return { line: "Web research skipped (account not found)" };
  const config = await getTargetUniverseConfig();
  const settings = {
    apiKey: budget.apiKey,
    companyContext: await getCompanyContext(),
    idealCustomerProfile: await getIdealCustomerProfile(),
    outputLanguage: await getOutputLanguage(),
    targetCountries: config?.countries || [],
  };
  const topics = plan.topics ? plan.topics.map((t) => WEB_GAP_TOPICS[t]) : null;
  const what = plan.topics ? `Web research (${plan.topics.join(", ")})` : "Web research";
  const controller = new AbortController();
  r.webAbort = controller;
  try {
    const result = await researchAccountOnWeb(company, settings, { signal: controller.signal, onlyTopics: topics, maxSearches: DEPTH_MAX_SEARCHES });
    const costUsd = result.costUsd || 0;
    await recordWebSpend(costUsd);
    const applied = await applyPipelineWebResearch(view.key, result, { topics });
    const bits = [];
    if (applied) {
      if (applied.filled) bits.push(`${applied.filled} empty field${applied.filled === 1 ? "" : "s"} filled`);
      if (applied.applied) bits.push(`${applied.applied} value${applied.applied === 1 ? "" : "s"} updated`);
      if (applied.dismissed) bits.push(`${applied.dismissed} kept as they were`);
      if (applied.review) bits.push(`${applied.review} for your decision`);
      if (applied.initiatives) bits.push(`${applied.initiatives} initiative${applied.initiatives === 1 ? "" : "s"}`);
    }
    return { ok: true, costUsd, line: `${what}: ${bits.length ? bits.join(", ") : "nothing new"} (about US$${costUsd.toFixed(2)})` };
  } catch (err) {
    const blocked = apiBlockedReason(err);
    if (blocked) {
      await setWebBlocked(blocked, apiKeyTail(budget.apiKey));
      return { line: `${what} paused: ${blocked === "credit" ? "the Anthropic API credit balance is empty" : "the spending limit set in the Anthropic Console is reached"}` };
    }
    return { failed: true, line: `${what} failed: ${String((err && err.message) || err)}` };
  } finally {
    r.webAbort = null;
  }
}

async function doSize(tab, view) {
  const res = await readSizeOnTab(tab, { key: view.key, linkedinLink: view.linkedinLink });
  return { lines: [await applySize(view, res)], emptyPage: Boolean(res && res.resolved && isEmptyPageBand(res.sizeBandText)) };
}

async function applySize(view, res) {
  if (!res || !res.resolved || res.employeeCount == null) return "Employee count not readable on LinkedIn";
  const band = parseSizeBand(res.sizeBandText) || { lo: res.employeeCount, hi: res.employeeCount };
  const verdict = sizeVerdict(view.globalEmployees, band);
  const written = await applyEmployeeCheck(view.key, { verdict, employeeCount: res.employeeCount, sizeBandText: res.sizeBandText });
  if (!written) return "Employee count not saved (account not found)";
  const bandLabel = res.sizeBandText ? `LinkedIn: ${res.sizeBandText}` : `LinkedIn: ${res.employeeCount}`;
  if (verdict === "confirm") return `Employees ${written.kept} confirmed (${bandLabel})`;
  if (verdict === "fill") return `Employees ${res.employeeCount} (${bandLabel})`;
  return `Employees changed from ${written.previous} to ${res.employeeCount} (${bandLabel})`;
}

// Searches with the known name's first and last word as written (titles dropped), so LinkedIn sees the
// spelling the research used; pickProfileMatch then compares names loosely.
function searchKeywords(fullName) {
  const words = String(fullName || "").replace(/\(.*?\)/g, " ").split(/[\s,]+/).filter((w) => nameTokens(w).length > 0);
  return words.length >= 2 ? `${words[0]} ${words[words.length - 1]}` : String(fullName || "").trim();
}

async function doProfile(tab, view, pipeline) {
  const contact = profileContactToTry(view, pipeline);
  const slug = companyLinkSlug(view.linkedinLink);
  if (!contact || !slug) return { line: "No known contact to look up", tried: null };
  const res = await searchCompanyPeopleByName(tab, slug, view.company, searchKeywords(contact.fullName));
  // A page that never answered is not a "not found": the name stays untried.
  if (!res.received) return { line: `Profile search for ${contact.fullName}: the page did not answer`, tried: null };
  const match = pickProfileMatch(res.candidates, contact.fullName);
  if (match.status === "found") {
    const url = profileUrlFromSlug(match.candidate.slug);
    const previous = await setContactLinkedinProfile(contact.contactKey, url);
    const same = previous && previous.replace(/\/+$/, "").toLowerCase() === url.replace(/\/+$/, "").toLowerCase();
    const replacedLink = previous && !same ? previous : null;
    return {
      line: same ? `${contact.fullName} confirmed at the company on LinkedIn` : `LinkedIn profile found for ${contact.fullName}`,
      tried: contact.fullName, replacedLink,
    };
  }
  if (match.status === "ambiguous") return { line: `${contact.fullName}: ${match.count} people with that name - not guessed`, tried: contact.fullName };
  return { line: `${contact.fullName}: not found among the company's people on LinkedIn`, tried: contact.fullName };
}

async function doContacts(tab, view) {
  const slug = companyLinkSlug(view.linkedinLink);
  if (!slug) return "Contact discovery needs the company's LinkedIn page";
  const res = await discoverContactsForAccount(tab, {
    key: view.key, company: view.company, companyId: view.companyId, slug, contactCount: (view.contacts || []).length,
  }, { untilTarget: true });
  if (!res.ranAnything) return "Contact discovery skipped: no contact titles are set in Setup";
  if (!res.received) return "Contact discovery: the page did not answer";
  return res.added > 0 ? `${res.added} contact${res.added === 1 ? "" : "s"} found` : "No matching contacts found";
}
