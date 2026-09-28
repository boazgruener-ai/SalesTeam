// The 1.2 data pipeline's loop, build step 2 (DATA_PIPELINE_DESIGN.md sections 5.2-5.5 and the step 2
// touch-ups T1-T4). Runs in the background worker, depth-first: it takes the account that most deserves
// work (pipeline-plan.js rankCandidates), runs every LinkedIn job that account needs, re-scores it, and
// moves to the next.
//
// Step 2 is started only by hand, from Advanced tools > Run pipeline now, for a set number of accounts.
// It already works the way the automatic runs of step 3 will: one small unfocused window of its own
// holding a single LinkedIn tab (decision D1, proven by step 0), never brought to the front. Because the
// user started it, it keeps the computer awake while it runs, like every user-started job (D4).
//
// The batch lock is taken per account, not for the whole run (5.2): between two accounts it is free.
// Progress lives in storage under "pipelineState"; pipeline-status.js shows it on every SalesTeam page.
import {
  getAccountViews, getReadinessConfig, savePipelineAccountState, applyResolvedCompanyIds, markLinkedinResolveAttempted,
  applyEmployeeCheck, setContactLinkedinProfile, appendActivityLog,
} from "./storage.js";
import { assessAccount, companyLinkSlug, countReadiness } from "./readiness.js";
import {
  rankCandidates, jobsNeeded, localDay, withFailedAttempt, pickProfileMatch, profileContactToTry, profileUrlFromSlug,
  parseSizeBand, sizeVerdict, nameTokens, PIPELINE_TOUCH_CEILING,
} from "./pipeline-plan.js";
import { resolveAccountOnTab } from "./company-resolve-extraction.js";
import { armSizeRead, disarmSizeRead, readSizeOnTab } from "./company-size-extraction.js";
import { searchCompanyPeopleByName, discoverContactsForAccount } from "./contact-discovery-extraction.js";
import { getLinkedinTouchStats, countTouchesSince, recordLinkedinTouch } from "./linkedin-touch-log.js";
import { withBatch, BatchBusyError, getRunningBatch, busyMessage } from "./batch-jobs.js";
import { rescoreDerivedPriorities } from "./auto-score.js";

export const PIPELINE_STATE_KEY = "pipelineState";
const RUN_LABEL = "Run pipeline now";
// Keyword chunks a title-based contact discovery usually needs - a planning estimate only (5.1).
const TYPICAL_CONTACT_CHUNKS = 2;
// Per account and day: how many known contacts the profile job may search for by name.
const MAX_PROFILE_SEARCHES_PER_ACCOUNT = 3;
const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 9000;
const NAV_TIMEOUT_MS = 20000;
const MAX_ACCOUNT_LINES = 50;

let runner = null; // { stopRequested, state }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

export async function startPipelineRun({ limit } = {}) {
  if (runner) return { ok: false, error: "The pipeline is already running." };
  const running = await getRunningBatch();
  if (running) return { ok: false, busy: true, error: busyMessage(running, RUN_LABEL) };
  const stats = await getLinkedinTouchStats();
  if (stats.last24h >= PIPELINE_TOUCH_CEILING) {
    return { ok: false, error: `The pipeline stops at ${PIPELINE_TOUCH_CEILING} LinkedIn page visits in any 24 hours, and ${stats.last24h} have been used. Try again later.` };
  }
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 5)));
  const state = {
    status: "running", limit: n, done: 0, touches: 0, current: null, remaining: null, accounts: [],
    stoppedReason: null, error: null, busyLabel: null, readyBefore: null, readyAfter: null,
    startedAt: Date.now(), heartbeatAt: Date.now(), finishedAt: null, acknowledged: false,
  };
  runner = { stopRequested: false, state };
  await chrome.storage.local.set({ [PIPELINE_STATE_KEY]: state });
  run(runner).catch(() => {}).finally(() => { runner = null; });
  return { ok: true };
}

export function stopPipelineRun() {
  if (runner) runner.stopRequested = true;
  return { ok: Boolean(runner) };
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

async function run(r) {
  const s = r.state;
  const save = () => chrome.storage.local.set({ [PIPELINE_STATE_KEY]: { ...s, heartbeatAt: Date.now() } }).catch(() => {});
  // Extension API calls keep the background worker alive; this also keeps the "still alive" stamp fresh.
  const keepAlive = setInterval(save, 10000);
  chrome.power.requestKeepAwake("system");
  let worker = null;
  try {
    const first = await readinessNow();
    s.readyBefore = first.counts.ready;
    while (!r.stopRequested && s.done < s.limit) {
      if ((await getLinkedinTouchStats()).last24h >= PIPELINE_TOUCH_CEILING) { s.stoppedReason = "budget"; break; }
      const { cfg, entries } = s.done === 0 ? first : await readinessNow();
      const now = Date.now();
      const ranked = rankCandidates(entries, now, TYPICAL_CONTACT_CHUNKS);
      s.remaining = ranked.length;
      const next = ranked[0];
      if (!next) { s.stoppedReason = "nothing_left"; break; }

      if (!worker) {
        const before = Date.now();
        worker = await openWorkerWindow();
        s.windowId = worker.windowId; // lets a page close it if this worker dies mid-run (pipeline-status.js)
        s.touches += await countTouchesSince(before);
      }
      if (!(await workerAlive(worker))) { s.stoppedReason = "window_closed"; break; }

      s.current = next.view.company;
      await save();
      const started = Date.now();
      let outcome;
      try {
        outcome = await withBatch(`SalesTeam is preparing accounts (${next.view.company})`, () => runAccount(worker.tab, next, cfg, r));
      } catch (err) {
        if (err instanceof BatchBusyError) { s.stoppedReason = "busy"; s.busyLabel = err.running?.label || null; break; }
        throw err;
      }
      const touches = await countTouchesSince(started);
      s.touches += touches;
      s.done++;
      s.accounts = [...s.accounts, { company: next.view.company, lines: outcome.lines, touches, state: outcome.state }].slice(-MAX_ACCOUNT_LINES);
      s.current = null;
      await save();
      if (outcome.windowClosed) { s.stoppedReason = "window_closed"; break; }
      if (!r.stopRequested && s.done < s.limit) await sleep(randomDelay());
    }
    if (!s.stoppedReason) s.stoppedReason = r.stopRequested ? "user" : "limit";
  } catch (err) {
    s.stoppedReason = "error";
    s.error = String((err && err.message) || err);
  } finally {
    clearInterval(keepAlive);
    chrome.power.releaseKeepAwake();
    if (worker) await chrome.windows.remove(worker.windowId).catch(() => {});
    try { s.readyAfter = (await readinessNow()).counts.ready; } catch { /* the summary just lacks the count */ }
    s.status = "finished";
    s.current = null;
    s.finishedAt = Date.now();
    await save();
    appendActivityLog({
      actor: "extension",
      action: "pipeline_run",
      label: `Pipeline run: ${s.done} account${s.done === 1 ? "" : "s"}, ${s.touches} LinkedIn page visit${s.touches === 1 ? "" : "s"}` +
        (s.readyBefore != null && s.readyAfter != null ? `, Ready ${s.readyBefore} -> ${s.readyAfter}` : "") + ` (${s.stoppedReason})`,
      newValue: { done: s.done, touches: s.touches, stoppedReason: s.stoppedReason, readyBefore: s.readyBefore, readyAfter: s.readyAfter },
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------
// One account: every job it needs, in order, re-assessed after each (5.2 runAccount)
// ---------------------------------------------------------------------------------------------------

async function freshView(key) {
  return (await getAccountViews()).find((v) => v.key === key) || null;
}

async function runAccount(tab, entry, cfg, r) {
  const key = entry.view.key;
  const day = localDay();
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

  while (!r.stopRequested) {
    const job = jobs.find((j) => (j === "profile" ? profileSearches < MAX_PROFILE_SEARCHES_PER_ACCOUNT : !ran.has(j)));
    if (!job) break;
    if ((await getLinkedinTouchStats()).last24h >= PIPELINE_TOUCH_CEILING) break;
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
      lines.push(...(await doResolve(tab, view, withSize)));
    } else if (job === "size") {
      lines.push(...(await doSize(tab, view)));
    } else if (job === "profile") {
      profileSearches++;
      const res = await doProfile(tab, view, pipeline);
      lines.push(res.line);
      if (res.tried) pipeline = { ...pipeline, profileTried: [...(pipeline.profileTried || []), res.tried] };
      if (res.replacedLink) replacedLinks.push({ contact: res.tried, link: res.replacedLink });
    } else if (job === "contacts") {
      lines.push(await doContacts(tab, view));
    }

    view = (await freshView(key)) || view;
    const assessment = assessAccount(view, cfg, Date.now());
    jobs = jobsNeeded(view, assessment, pipeline, Date.now());
    // A job that ran and is still needed did not close its gap: one failed day for it (5.5). The
    // profile job keeps its own record instead - the names already searched.
    for (const j of attempted) if (j !== "profile" && jobs.includes(j)) failed.add(j);
  }

  let attempts = pipeline.attempts || {};
  for (const j of failed) attempts = withFailedAttempt({ attempts }, j, day);
  await savePipelineAccountState(key, { attempts, profileTried: pipeline.profileTried || [], lastRunDay: day });

  // The score job (5.1): locally, for this account, never a manual or AI-judged priority.
  const before = view.salesTeamPriority;
  const scored = await rescoreDerivedPriorities({ onlyCompanyIds: [view.companyId] });
  if (scored.applied > 0) {
    const after = scored.results[0]?.priority;
    if (after && after !== before) lines.push(`Priority ${before || "none"} -> ${after}`);
  }

  view = (await freshView(key)) || view;
  const finalState = assessAccount(view, cfg, Date.now()).state;
  appendActivityLog({
    actor: "extension",
    action: "pipeline_account",
    label: `Pipeline: ${view.company} - ${lines.length ? lines.join("; ") : "nothing changed"}`,
    // A Contact Link that pointed at another page (often the news article the research cited) and was
    // replaced by the LinkedIn profile is kept here, so the evidence can still be found.
    newValue: { lines, state: finalState, ...(replacedLinks.length ? { replacedContactLinks: replacedLinks } : {}) },
    relatedCompanyKey: key,
  }).catch(() => {});
  return { lines, state: finalState, windowClosed };
}

// ---------------------------------------------------------------------------------------------------
// The jobs (5.1). Each writes its values, with provenance, the moment it has them (persist as you go).
// ---------------------------------------------------------------------------------------------------

async function doResolve(tab, view, withSize) {
  const lines = [];
  const company = {
    key: view.key, company: view.company, officialName: view.officialName, alternativeName: view.alternativeName,
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
  await markLinkedinResolveAttempted([view.key]);
  const oldId = view.linkedinCompanyId || null;
  // The page shows the very id already stored: the account's link and its id agree, which is the
  // re-check itself - the page-name check (there to stop a wrong link planting a wrong id) adds nothing
  // then. Found on the first pipeline run, where name spellings ("Kühne + Nagel") blocked 2 of 5.
  const pageId = attempt.debug?.currentCompanyIdFound || null;
  if (!attempt.linkedinCompanyId && oldId && pageId && String(pageId) === String(oldId) && company.linkedinLink) {
    attempt.linkedinCompanyId = pageId;
  }
  if (attempt.linkedinCompanyId) {
    await applyResolvedCompanyIds([{
      key: view.key, linkedinCompanyId: attempt.linkedinCompanyId, companyPageUrl: attempt.companyPageUrl || null,
      checkedLink: attempt.checkedLink, allowWorkbookRow: true, previousId: oldId,
    }]);
    if (!oldId) lines.push("LinkedIn company found");
    else if (String(oldId) === String(attempt.linkedinCompanyId)) lines.push("LinkedIn company re-checked");
    else lines.push(`LinkedIn company id changed from ${oldId} to ${attempt.linkedinCompanyId} (read from its own page)`);
  } else {
    // Say what the page showed, so a failure can be diagnosed from the summary alone.
    const d = attempt.debug || {};
    const why = attempt.timedOut
      ? ` (the page did not answer${attempt.finalUrl ? `; landed on ${String(attempt.finalUrl).split("?")[0]}` : ""})`
      : d.pageName ? ` (page shows "${d.pageName}"${pageId ? `, id ${pageId}` : ", no id"}${oldId ? `; stored id ${oldId}` : ""})`
      : pageId ? ` (id ${pageId} on the page; stored id ${oldId || "none"})` : " (no id found on the page)";
    lines.push(`LinkedIn company not confirmed${why}`);
  }
  if (withSize) lines.push(await applySize(view, sizeResult));
  return lines;
}

async function doSize(tab, view) {
  const res = await readSizeOnTab(tab, { key: view.key, linkedinLink: view.linkedinLink });
  return [await applySize(view, res)];
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
  });
  if (!res.ranAnything) return "Contact discovery skipped: no contact titles are set in Setup";
  if (!res.received) return "Contact discovery: the page did not answer";
  return res.added > 0 ? `${res.added} contact${res.added === 1 ? "" : "s"} found` : "No matching contacts found";
}
