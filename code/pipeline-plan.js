// The data pipeline's planning rules (DATA_PIPELINE_DESIGN.md sections 5.1-5.5 and the step 2
// touch-ups T1-T4): which LinkedIn job an account needs next, which account goes first, when a job
// stops being retried, and the two matching rules that decide whether a LinkedIn answer is accepted
// (a person's name, a company's size band).
//
// PURE, like readiness.js: no chrome.*, no DOM, no import from storage.js. test_pure_modules.py runs
// it. pipeline-runner.js (the background loop) and pipeline-jobs.js (the LinkedIn visits) do the rest.
//
// Per-account pipeline state lives in extras[key].pipeline:
//   { attempts: { resolve: ["2026-09-25", ...] },   // local days on which the job ran without closing its gap
//     profileTried: ["Anna Muster", ...],           // contacts already searched by name (T1)
//     lastRunDay: "2026-09-25" }                    // the pipeline handles an account at most once a day

import { companyLinkSlug, FRESHNESS_DAYS, toEpochMs, fieldGap, requiredFields } from "./readiness.js";
import { normalizeCompanyName } from "./company-identity.js";

// The pipeline stops well below the hard stop of the shared LinkedIn budget (99), leaving the rest to
// the user's own scans (design 5.2). Designed as 75; lowered to 60 on 2026-09-25 (Boaz), after a single
// scan used 70 of the 99 on the first day of automatic runs.
export const PIPELINE_TOUCH_CEILING = 60;
// A job for a field that has failed on this many different days stops being offered (design 5.5).
export const MAX_FAILED_DAYS = 2;

const ONE_DAY_MS = 86400000;
export const PIPELINE_JOBS = ["resolve", "size", "profile", "contacts", "web_gap", "web_full"];
export const JOB_LABELS = {
  resolve: "LinkedIn company re-check",
  size: "Employee count",
  profile: "Contact's LinkedIn profile",
  contacts: "Contact discovery",
  web_gap: "Web research of a missing fact",
  web_full: "Web research",
  score: "Priority",
};
// The web jobs (build step 5) visit no LinkedIn page: they cost US$ on the user's API key instead.
export const WEB_JOBS = new Set(["web_gap", "web_full"]);
export function isLinkedinJob(job) {
  return !WEB_JOBS.has(job);
}

// Local calendar day, "YYYY-MM-DD": "tried on 2 different days" means the user's days, not UTC's.
export function localDay(ms) {
  const d = new Date(typeof ms === "number" ? ms : Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function failedDays(pipeline, job) {
  const days = (pipeline && pipeline.attempts && pipeline.attempts[job]) || [];
  return new Set(days).size;
}

export function jobGaveUp(pipeline, job) {
  return failedDays(pipeline, job) >= MAX_FAILED_DAYS;
}

// Returns the new attempts list for a job that ran without closing its gap today.
// 1.2.0.32 (Boaz, 2026-10-01): with LinkedIn logged out in this browser, every lookup lands on LinkedIn's login wall
// and was counted as "not found" (15 of 15 in his clean-profile test). A page on one of these paths means: stop, ask
// the user to log in, and count nothing against the account.
export const LINKEDIN_LOGGED_OUT_KEY = "linkedinLoggedOutAt";
// After a run stopped on the login wall, LinkedIn work waits this long before it tries again (one page visit).
export const LINKEDIN_LOGGED_OUT_WAIT_MS = 30 * 60 * 1000;
export function isLinkedinLoginWall(url) {
  return /^https?:\/\/([a-z]{2,3}\.|www\.)?linkedin\.com\/(authwall|login|uas\/login|checkpoint|signup|m\/login)(?![a-z])/i.test(String(url || ""));
}
export function linkedinLoggedOutRecently(at, now) {
  return Boolean(at) && (typeof now === "number" ? now : Date.now()) - at < LINKEDIN_LOGGED_OUT_WAIT_MS;
}

export function withFailedAttempt(pipeline, job, day) {
  const attempts = { ...((pipeline && pipeline.attempts) || {}) };
  const days = attempts[job] || [];
  attempts[job] = days.includes(day) ? days : [...days, day];
  return attempts;
}

// ---------------------------------------------------------------------------------------------------
// Names (T1): does a LinkedIn search result name the contact the account already knows?
// ---------------------------------------------------------------------------------------------------

const NAME_TITLES = new Set(["dr", "prof", "professor", "mr", "mrs", "ms", "mme", "m", "herr", "frau", "phd", "mba", "msc", "bsc", "ing", "dipl", "lic", "jr", "sr", "cfa", "cpa", "emba"]);

// Lower-case word tokens with accents, German umlaut spellings and titles removed, so "Dr. Hans-Peter
// Müller, PhD" and "Hans Peter Mueller" give the same tokens.
export function nameTokens(name) {
  if (!name) return [];
  // The explicit map first: String.normalize is a no-op in a V8 built without full ICU.
  return String(name)
    .toLowerCase()
    .replace(/[äàáâãå]/g, "a").replace(/[öòóôõø]/g, "o").replace(/[üùúû]/g, "u").replace(/[éèêë]/g, "e")
    .replace(/[ïìíî]/g, "i").replace(/ç/g, "c").replace(/ñ/g, "n").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z\s'-]/g, " ")
    .split(/[\s'-]+/)
    .map((t) => t.replace(/ue/g, "u").replace(/oe/g, "o").replace(/ae/g, "a"))
    .filter((t) => t && !NAME_TITLES.has(t));
}

// First and last name of the known contact must both appear in the result's name. Middle names on
// either side are ignored. A one-word name is never enough to accept anyone.
export function namesMatch(candidateName, contactName) {
  const known = nameTokens(contactName);
  if (known.length < 2) return false;
  const found = new Set(nameTokens(candidateName));
  return found.has(known[0]) && found.has(known[known.length - 1]);
}

// candidates: [{ slug, name, headlineText, conflict }] from the company's People tab, where
// `conflict` is true when the headline names only other companies. Accepted only when exactly one
// distinct person matches (the agreed rule: never guess between two).
export function pickProfileMatch(candidates, contactName) {
  const bySlug = new Map();
  for (const c of candidates || []) {
    if (!c || !c.slug || c.conflict) continue;
    if (namesMatch(c.name, contactName)) bySlug.set(c.slug, c);
  }
  if (bySlug.size === 1) return { status: "found", candidate: [...bySlug.values()][0] };
  if (bySlug.size === 0) return { status: "none" };
  return { status: "ambiguous", count: bySlug.size };
}

export function profileUrlFromSlug(slug) {
  return `https://www.linkedin.com/in/${slug}/`;
}

function hasProfile(c) {
  return /linkedin\.com\/in\//i.test(c.linkedinUrl || "");
}

// Most senior first (storage.js SENIORITY_LEVELS order); a contact without a known level goes last.
const SENIORITY_ORDER = ["board", "cLevel", "vp", "head", "director", "manager"];
function seniorityRank(c) {
  const i = SENIORITY_ORDER.indexOf(c.level);
  return i < 0 ? SENIORITY_ORDER.length : i;
}

// The next known contact to look up by name: a relevant one with no LinkedIn profile first, then one
// whose profile check is out of date. Contacts already searched are skipped, so each attempt tries a
// different person, and the job ends once every candidate has been searched.
// 1.2.1 step 4 (design 7.2): the most senior one first - one verified contact is enough for Ready, and the
// most senior is the one worth having.
export function profileContactToTry(view, pipeline, now) {
  const t = typeof now === "number" ? now : Date.now();
  const tried = new Set(((pipeline && pipeline.profileTried) || []).map((n) => nameTokens(n).join(" ")));
  const relevant = (view.contacts || [])
    .filter((c) => c.relevant && nameTokens(c.fullName).length >= 2 && !tried.has(nameTokens(c.fullName).join(" ")))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => seniorityRank(a.c) - seniorityRank(b.c) || a.i - b.i)
    .map((x) => x.c);
  const missing = relevant.filter((c) => !hasProfile(c));
  if (missing.length > 0) return missing[0];
  const stale = relevant.filter((c) => hasProfile(c) && !(toEpochMs(c.verifiedAt) && t - toEpochMs(c.verifiedAt) <= FRESHNESS_DAYS.contact * ONE_DAY_MS));
  return stale[0] || null;
}

// ---------------------------------------------------------------------------------------------------
// Size (touch-up to T3): LinkedIn shows a band, stored as its lower bound
// ---------------------------------------------------------------------------------------------------

function looseNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /\d[\d',.\s]*/.exec(String(v));
  if (!m) return null;
  const n = Number(m[0].replace(/[',\s]/g, "").replace(/\.(?=\d{3}\b)/g, ""));
  return Number.isFinite(n) ? n : null;
}

// "1,001-5,000" -> { lo: 1001, hi: 5000 }; "10,001+" -> { lo: 10001, hi: Infinity }; "51" -> 51..51.
export function parseSizeBand(text) {
  if (!text) return null;
  const s = String(text).replace(/employees?/i, "").replace(/[,'\s]/g, "").replace(/[–—]/g, "-");
  let m = /^(\d+)-(\d+)$/.exec(s);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]) };
  m = /^(\d+)\+$/.exec(s);
  if (m) return { lo: Number(m[1]), hi: Infinity };
  m = /^(\d+)$/.exec(s);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]) };
  return null;
}

// What to do with LinkedIn's band given the count already stored:
//   "fill"    - nothing stored: write LinkedIn's number
//   "confirm" - the stored count lies inside the band: keep it (it is usually more precise) and mark it
//               verified by LinkedIn
//   "replace" - the stored count contradicts the band: write LinkedIn's number, keep the old in the trace
export function sizeVerdict(currentValue, band) {
  if (!band) return null;
  const cur = looseNumber(currentValue);
  if (cur === null) return "fill";
  return cur >= band.lo && cur <= band.hi ? "confirm" : "replace";
}

// ---------------------------------------------------------------------------------------------------
// Which jobs an account needs (5.1), and which account goes first (5.3)
// ---------------------------------------------------------------------------------------------------

function gap(assessment, field) {
  return (assessment.missing || []).find((m) => m.field === field) || null;
}

// ---------------------------------------------------------------------------------------------------
// Web research (build step 5, DATA_PIPELINE_DESIGN.md section 6 and the step 5 touch-ups W1-W8)
// ---------------------------------------------------------------------------------------------------

// A full research younger than this covers every topic (design 6: "never researched, or older than 12
// months"). A short research of one missing fact is not repeated within it either.
export const WEB_RESEARCH_MAX_AGE_DAYS = 365;
// The topics a short research asks about, in the words the research prompt uses (target-accounts.js
// BULK_TOPICS). Industry is not among them: the research does not report one.
export const WEB_GAP_TOPICS = { employees: "employees", headquarters: "headquarters (city and country)" };
// A short research costs about this share of a full one (measured for the bulk dialog's "only missing").
export const WEB_GAP_COST_FACTOR = 0.6;

function priorityLevel(priority) {
  const m = /^P([1-5])$/.exec(priority || "");
  return m ? Number(m[1]) : null;
}

// What web research an account needs, or null: { job, topics, early }. W2: first the gaps a research can
// close - a missing headcount (D3: before Fetch Company Size, which would cost a LinkedIn visit) and an
// HQ country that is missing or not verified (the web is its only source besides the workbook); then,
// for scannable P1-P3 accounts, a full research when there is none from the last 12 months. An account
// that qualifies for both gets the full one, early (it covers the gaps too), never both. P4 and P5 are
// never researched automatically. `linkedinJobs`: when the resolver is about to visit the company page
// anyway, LinkedIn's size band comes with it for free, so the headcount is not a gap to research.
export function webPlan(view, assessment, pipeline, now, linkedinJobs) {
  if (!view || view.deleted || view.excluded) return null;
  const t = typeof now === "number" ? now : Date.now();
  const lvl = priorityLevel(view.salesTeamPriority);
  if (lvl !== null && lvl >= 4) return null;
  const p = pipeline || {};
  const fresh = (at) => { const ms = toEpochMs(at); return Boolean(ms) && t - ms <= WEB_RESEARCH_MAX_AGE_DAYS * ONE_DAY_MS; };
  if (fresh(view.webFullResearchAt)) return null;
  const tried = p.webGapAt || {};
  const topics = [];
  const emp = gap(assessment, "employees");
  if (emp && emp.reason === "absent" && !(linkedinJobs || []).includes("resolve") && !fresh(tried.employees)) topics.push("employees");
  if (gap(assessment, "globalHqCountry") && !fresh(tried.headquarters)) topics.push("headquarters");
  if (lvl !== null && view.linkedinCompanyId && !jobGaveUp(p, "web_full")) return { job: "web_full", topics: null, early: topics.length > 0 };
  if (topics.length > 0 && !jobGaveUp(p, "web_gap")) return { job: "web_gap", topics, early: true };
  return null;
}

// W3: why the pipeline may not spend on web research now, or null when it may. `nextCostUsd` is what
// the next research is expected to cost at most (a full one): it starts only if it still fits, so the
// monthly budget is never exceeded. `blocked` is the API's own refusal ({ reason: "credit" | "limit",
// day }); it holds for the rest of that day, or until the key or the budget changes (which clears it).
export function webBudgetBlocker({ enabled, hasKey, monthlyUsd, spentUsd, nextCostUsd, blocked, today }) {
  if (!enabled) return "off";
  if (!hasKey) return "no_key";
  if (!(Number(monthlyUsd) > 0)) return "zero";
  if (blocked && blocked.day === today && (blocked.reason === "credit" || blocked.reason === "limit")) return blocked.reason;
  if ((Number(spentUsd) || 0) + (Number(nextCostUsd) || 0) > Number(monthlyUsd)) return "used_up";
  return null;
}

// "YYYY-MM" in local time: the budget is per calendar month.
export function monthKey(ms) {
  const d = new Date(typeof ms === "number" ? ms : Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Ordered job ids for one account, from its readiness assessment. `pipeline` is its per-account state.
// `opts.linkedin` (default true): LinkedIn jobs may run - false once the day's visits are used up (W1).
// `opts.web` (default false): the web budget allows a research now.
// `opts.profileSearches` (default 0): names already searched on LinkedIn for this account in this pass.
export function jobsNeeded(view, assessment, pipeline, now, opts) {
  const o = opts || {};
  const jobs = [];
  const p = pipeline || {};
  // Step 4: an empty LinkedIn page, a Keep on a Lacking account, and a changed page waiting for the
  // user's decision all stop the work until something new arrives or the user has answered. So does a
  // LinkedIn company that another account already holds (W7), until the user says which it is.
  if (p.emptyPage || p.keep || (p.pageChange && !p.pageChange.kept) || (p.idTaken && !p.idTaken.kept)) return jobs;
  const slug = companyLinkSlug(view.linkedinLink);
  const idGap = gap(assessment, "linkedinCompanyId");
  // "Keep current" on a changed page: the user has settled the id, so it is not re-checked again.
  if (idGap && !jobGaveUp(pipeline, "resolve") && !(p.pageChange && p.pageChange.kept) && !(p.idTaken && p.idTaken.kept)) jobs.push("resolve");
  // Size needs the company's own page. When resolve is about to visit it, size rides along for free
  // (T3); the runner decides that, this list still names both.
  if (gap(assessment, "employees") && (slug || jobs.includes("resolve")) && !jobGaveUp(pipeline, "size")) jobs.push("size");
  const contactGap = gap(assessment, "contact");
  if (contactGap && (slug || jobs.includes("resolve"))) {
    const known = contactGap.reason !== "absent" ? profileContactToTry(view, pipeline, now) : null;
    // D2 (design 7.2): one name search for the most senior known contact; if that does not make the account
    // Ready, one People-page visit rather than a name search per contact - it usually gives in one touch
    // what three name searches would. Once the People page has given up, the names are searched again.
    const contactsLeft = !jobGaveUp(pipeline, "contacts");
    if (known && (!(o.profileSearches > 0) || !contactsLeft)) jobs.push("profile");
    else if (contactsLeft) jobs.push("contacts");
  }
  const linkedinJobs = o.linkedin === false ? [] : jobs;
  const plan = o.web ? webPlan(view, assessment, p, now, jobs) : null;
  if (!plan) return linkedinJobs;
  // Research that closes a gap goes first, so a headcount it finds saves the size visit (D3); research
  // for depth only goes last.
  return plan.early ? [plan.job, ...linkedinJobs] : [...linkedinJobs, plan.job];
}

// Planning estimate only (5.1): the real count is measured as the run goes.
export function estimateTouches(jobs, view, contactChunks) {
  let n = 0;
  const combinedSize = jobs.includes("resolve") && jobs.includes("size") && Boolean(companyLinkSlug(view.linkedinLink));
  for (const j of jobs) {
    if (j === "resolve") n += view.linkedinLink ? 1 : 1.3;
    else if (j === "size") n += combinedSize ? 0 : 1;
    else if (j === "profile") n += 1;
    else if (j === "contacts") n += Math.max(1, contactChunks || 1);
    // web_gap / web_full: no LinkedIn visit
  }
  return n;
}

// entries: [{ view, assessment, pipeline }]. Returns the candidates in the order the pipeline takes
// them: provisional priority (P1 first, unscored counts as P3), then fewest touches to Ready, then the
// account the pipeline has waited longest to handle. An account already handled today is skipped, so
// a job that failed is retried tomorrow, not again in the same run.
// W2: accounts with a gap to close come before accounts that only get a full web research ("depth").
// 2026-09-29: before all of that, an account whose LinkedIn lookup has something new to try because the user
// gave it an Alt. name or a LinkedIn link (view.userIdentityEdit), and that the pipeline has not yet tried
// with it. The user acted on that account and expects to see the result, not to wait behind every P1 and
// P2 account ("Swiss Air-Rescue Rega" -> "Rega", P3, waited two days). One try: after it the attempt is
// recorded, and the account goes back to its normal place.
export function userRetryFirst(entry) {
  const tried = entry.pipeline && entry.pipeline.attempts && entry.pipeline.attempts.resolve;
  return Boolean(entry.view.userIdentityEdit && entry.jobs.includes("resolve") && !(tried && tried.length));
}

// 1.2.1 step 4 (design 7.1): an account the web lane has queued or is researching is not offered to the
// pipeline until the lane is done with it - LinkedIn would otherwise search the People page for contacts
// the website is about to name. `hold` = { keys: [...], since } from a web lane run in progress; the caller
// passes none when the lane is not running (stopped on the budget, the key or a 429). A run older than a
// day holds nothing: the accounts have waited long enough.
export function heldForWebLane(view, hold, now) {
  if (!hold || !view || !Array.isArray(hold.keys)) return false;
  const t = typeof now === "number" ? now : Date.now();
  if (!(hold.since > 0) || t - hold.since > ONE_DAY_MS) return false;
  return hold.keys.includes(view.key);
}

// Design 7.3 (D7): the gaps the LinkedIn jobs (and the local re-score that follows them) can close. An
// account with any other gap - an HQ country or industry that only the web can verify - does not become
// Ready from LinkedIn visits alone.
const LINKEDIN_CLOSABLE = new Set(["linkedinCompanyId", "employees", "contact", "salesTeamPriority"]);
export function readyByLinkedin(assessment) {
  return (assessment.missing || []).every((m) => LINKEDIN_CLOSABLE.has(m.field));
}

// `opts.webLaneHold`: see heldForWebLane. `opts.readyGoal` (D7): fewer than MIN_READY_TO_SCAN accounts are
// Ready, so the pipeline works only towards Ready - accounts LinkedIn alone can bring there first, fewest
// touches first, ahead of priority; the jobs themselves already stop at Ready (a contact gap ends with one
// verified contact). Once the goal is met the normal order returns.
export function rankCandidates(entries, now, contactChunks, opts) {
  const today = localDay(now);
  const level = (p) => priorityLevel(p) || 3;
  const o = opts || {};
  return (entries || [])
    .filter((e) => e && e.view && !e.view.deleted && !e.view.excluded)
    .filter((e) => !(e.pipeline && e.pipeline.lastRunDay === today))
    .filter((e) => !heldForWebLane(e.view, o.webLaneHold, now))
    .map((e) => {
      const jobs = jobsNeeded(e.view, e.assessment, e.pipeline, now, opts);
      // Depth only: nothing to do but a full research that closes no gap.
      const depthOnly = jobs.length === 1 && jobs[0] === "web_full" &&
        !(webPlan(e.view, e.assessment, e.pipeline, now, jobsNeeded(e.view, e.assessment, e.pipeline, now)) || {}).early;
      const towardsReady = Boolean(o.readyGoal) && e.assessment.state !== "ready" && jobs.some(isLinkedinJob) && readyByLinkedin(e.assessment);
      return { ...e, jobs, depthOnly, towardsReady, touches: estimateTouches(jobs, e.view, contactChunks) };
    })
    .filter((e) => e.jobs.length > 0)
    .sort((a, b) =>
      Number(userRetryFirst(b)) - Number(userRetryFirst(a)) ||
      Number(b.towardsReady) - Number(a.towardsReady) ||
      (a.towardsReady && b.towardsReady ? a.touches - b.touches : 0) ||
      Number(a.depthOnly) - Number(b.depthOnly) ||
      level(a.view.salesTeamPriority) - level(b.view.salesTeamPriority) ||
      a.touches - b.touches ||
      String((a.pipeline && a.pipeline.lastRunDay) || "").localeCompare(String((b.pipeline && b.pipeline.lastRunDay) || ""))
    );
}

// What the Scanner's gate says while fewer than MIN_READY_TO_SCAN accounts are Ready (design 7.3): about how
// long the rest takes. Planning figure until step 4's measurement replaces it: 13-15 accounts and 30-35
// touches for the first 10, "about an hour" - so about 6 minutes per Ready account still to come, at least 5.
export const MINUTES_PER_READY_ESTIMATE = 6;
// Storage key of the measurement of the way to the first MIN_READY_TO_SCAN Ready accounts (pipeline-runner.js
// trackReadyGoal): { startedAt, readyAtStart, ready, accounts, touches, workMs, readyMade, reachedAt }.
export const READY_GOAL_KEY = "pipelineReadyGoal";
// Minutes per Ready account as measured so far, or null until 3 have been made.
export function measuredMinutesPerReady(goal) {
  if (!goal || !(goal.readyMade >= 3) || !(goal.workMs > 0)) return null;
  return goal.workMs / goal.readyMade / 60000;
}
export function readyEtaMinutes(ready, goal, minutesPerReady) {
  const left = Math.max(0, (Number(goal) || 0) - (Number(ready) || 0));
  if (left === 0) return 0;
  const per = Number(minutesPerReady) > 0 ? Number(minutesPerReady) : MINUTES_PER_READY_ESTIMATE;
  return Math.max(5, Math.round((left * per) / 5) * 5);
}

// ---------------------------------------------------------------------------------------------------
// Build step 3: may an automatic run start now? (design 5.4 and the step 3 touch-ups U1-U5)
// ---------------------------------------------------------------------------------------------------

// U1: an automatic run starts only with a full backup from the last 24 hours. Only a page can save one,
// so without it the run waits for the next SalesTeam page to open, which makes the backup and kicks.
export const AUTO_BACKUP_MAX_AGE_MS = 24 * 3600 * 1000;
// U2: after the pipeline made way for a user's job, it stays out of the way this long, so the job can
// take the batch lock before the next kick starts the pipeline again.
export const USER_JOB_HOLD_MS = 3 * 60 * 1000;

// The reason an automatic run may not start, or null when it may. In the order the user would care:
// switched off, paused by the user for today, making way for a user's job, the LinkedIn budget, the backup.
// `webPossible` (step 5, W1): web research may run, so a used-up LinkedIn budget alone no longer stops a run.
export function autoRunBlocker({ enabled, pausedDay, today, holdUntil, runningBatch, touches24h, lastBackupAt, now, webPossible }) {
  if (!enabled) return "off";
  if (pausedDay && pausedDay === today) return "paused_today";
  if (holdUntil && now < holdUntil) return "hold";
  if (runningBatch) return "busy";
  if (touches24h >= PIPELINE_TOUCH_CEILING && !webPossible) return "budget";
  if (!lastBackupAt || now - lastBackupAt > AUTO_BACKUP_MAX_AGE_MS) return "no_backup";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The web lane (1.2.1, ONBOARDING_RESEARCH_DESIGN.md 5.1-5.2)
// ---------------------------------------------------------------------------------------------------

// Completion targets above Ready (design 3.10). The wizard's Targets step (build step 6) will let the user
// set them; until then these defaults apply.
// People per web lane research (Boaz, 2026-10-01): the first automatic run named 6-16 per account (US$0.22 an
// account, twice the plan) when 3 relevant contacts are the target. The prompt asks for it, applyWebLaneResearch
// enforces it.
export const LANE_MAX_PEOPLE = 5;
export const DEFAULT_COMPLETION_TARGETS = { accounts: 100, contactsPerAccount: 3, initiativesPerAccount: 1 };

// ---- Targets and the stop rule (1.2.1 step 6, design 3.7, 3.10 and 8) ----

// The Targets step's limits: [lowest, highest].
export const TARGET_LIMITS = { accounts: [10, 2000], contactsPerAccount: [1, 10], initiativesPerAccount: [0, 5] };

// The stored targets made whole and in range; contacts per account is capped by the Target contacts step's
// "Maximum contacts per target account" (design 3.10).
export function normalizeCompletionTargets(raw, maxContactsPerAccount) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(TARGET_LIMITS)) {
    const n = Math.round(Number(raw && raw[k]));
    out[k] = Number.isFinite(n) && raw && raw[k] !== "" && raw[k] != null ? Math.min(hi, Math.max(lo, n)) : DEFAULT_COMPLETION_TARGETS[k];
  }
  const cap = Math.round(Number(maxContactsPerAccount));
  if (Number.isFinite(cap) && cap >= 1) out.contactsPerAccount = Math.min(out.contactsPerAccount, cap);
  return out;
}

// Design 3.7: the seven stages of the Master Prompt as a ranked list [{ id, checked }], in the user's order. Unknown
// ids are dropped; a stage missing from what was saved is added at the end, ticked.
export const INITIATIVE_STAGE_IDS = ["poc", "exploration", "pilot", "early_production", "scaling", "mature", "tech_native"];
export const INITIATIVE_STAGE_LABELS = {
  poc: "Proof of concept", exploration: "Exploration", pilot: "Pilot", early_production: "Early production",
  scaling: "Scaling", mature: "Mature", tech_native: "Tech native",
};
export function normalizeInitiativeStages(raw) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const id = typeof s === "string" ? s : s && s.id;
    if (!INITIATIVE_STAGE_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, checked: typeof s === "string" ? true : s.checked !== false });
  }
  for (const id of INITIATIVE_STAGE_IDS) if (!seen.has(id)) out.push({ id, checked: true });
  return out;
}

// Does an initiative at this stage count towards the initiative target? One with no stage (imported before 1.2.1,
// or the research could not tell) counts.
export function initiativeCounts(stage, stages) {
  if (!stage || !INITIATIVE_STAGE_IDS.includes(stage)) return true;
  const s = normalizeInitiativeStages(stages).find((x) => x.id === stage);
  return !s || s.checked;
}

// The accounts that count towards the accounts target: everything the pipeline is building, not the ones waiting
// for a decision or lacking evidence.
const TARGET_STATES = ["ready", "usable", "in_progress"];

// Design 8 (R6.3): what is still owed. `entries`: [{ state, relevantContacts, initiatives }] for the live accounts
// (initiatives already filtered by initiativeCounts). `discoveryAllowed`: discoveryMayRun's answer. `action`:
// "discover" while accounts are owed and discovery may run, "enrich" while an account is below its own targets
// (the web lane and the pipeline work those, each asking only for what is missing), else "idle".
export function targetsStatus(entries, targets, { discoveryAllowed = true } = {}) {
  const tg = { ...DEFAULT_COMPLETION_TARGETS, ...(targets || {}) };
  const live = (entries || []).filter((e) => e && TARGET_STATES.includes(e.state));
  const contactsMet = live.filter((e) => (e.relevantContacts || 0) >= tg.contactsPerAccount).length;
  const initiativesMet = live.filter((e) => (e.initiatives || 0) >= tg.initiativesPerAccount).length;
  const enrichOwed = live.filter((e) => (e.relevantContacts || 0) < tg.contactsPerAccount || (e.initiatives || 0) < tg.initiativesPerAccount).length;
  const accountsOwed = Math.max(0, tg.accounts - live.length);
  const action = accountsOwed > 0 && discoveryAllowed ? "discover" : enrichOwed > 0 ? "enrich" : "idle";
  return {
    targets: tg, accounts: live.length, ready: live.filter((e) => e.state === "ready").length,
    usable: live.filter((e) => e.state === "usable").length, accountsOwed, contactsMet, initiativesMet, enrichOwed, action,
  };
}

// An automatic Web Discovery runs once per accounts target: again only when the target is raised (R6.5), or a week
// later when the list has fallen short again (accounts removed, merged or waiting for a decision). This bounds
// the cost when the listings have nothing more to give. `last`: { accountsTarget, at } of the last automatic run.
export const AUTO_DISCOVERY_REPEAT_MS = 7 * 24 * 3600 * 1000;
export function discoveryMayRun(last, accountsTarget, now) {
  if (!last || typeof last.at !== "number") return true;
  if ((Number(accountsTarget) || 0) > (Number(last.accountsTarget) || 0)) return true;
  return (typeof now === "number" ? now : Date.now()) - last.at >= AUTO_DISCOVERY_REPEAT_MS;
}

// R6.4: the targets as coverage lines under the Target Accounts pie.
export function coverageLines(status) {
  if (!status) return [];
  const { targets: tg, accounts } = status;
  const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // "108 of 100" read as a mistake (Boaz, 2026-10-01): discovery adds whole listings, so the list can pass the target.
  const lines = [accounts >= tg.accounts ? `Accounts: ${accounts} in the list, target ${tg.accounts} ✓.` : `Accounts: ${accounts} of ${tg.accounts} in the list.`];
  lines.push(`Contacts: ${status.contactsMet} of ${s(accounts, "account has", "accounts have")} ${tg.contactsPerAccount}.`);
  if (tg.initiativesPerAccount > 0) {
    lines.push(`Initiatives: ${status.initiativesMet} of ${s(accounts, "account has", "accounts have")} ${s(tg.initiativesPerAccount, "relevant initiative", "relevant initiatives")}.`);
  }
  return lines;
}

// Each topic in the words the research prompt uses.
export const WEB_LANE_TOPICS = {
  headquarters: "headquarters (city and country of the group's global HQ)",
  employees: "number of employees (worldwide, and in the seller's home market)",
  industry: "industry",
  initiatives: "recent initiatives and projects that could matter to the seller",
  contacts: "named senior people (management, leadership, heads of the relevant functions)",
  summary: "a short summary of what the company does",
};

// R7a.7: the topics an account still lacks, so a research asks only for those - and none at all when the
// list is empty. A field counts as covered when it has a value with a good, fresh source (the same test
// readiness applies). Industry is asked only when the user's setup weighs it. `facts`:
// { initiatives: n, relevantContacts: n, hasSummary: bool, contactsWithoutProfile: n } - what the view
// does not carry. "profiles" is not a research topic: it is answered by the separate profile search.
export function missingWebTopics(view, cfg, facts, targets, now) {
  if (!view || view.deleted || view.excluded) return [];
  const t = typeof now === "number" ? now : Date.now();
  const f = facts || {};
  const tg = { ...DEFAULT_COMPLETION_TARGETS, ...(targets || {}) };
  const out = [];
  if (fieldGap(view, "globalHqCountry", t)) out.push("headquarters");
  if (fieldGap(view, "employees", t)) out.push("employees");
  if (requiredFields(cfg).includes("industry") && fieldGap(view, "industry", t)) out.push("industry");
  if ((f.initiatives || 0) < tg.initiativesPerAccount) out.push("initiatives");
  if ((f.relevantContacts || 0) < tg.contactsPerAccount) out.push("contacts");
  if (!f.hasSummary) out.push("summary");
  // D10, 1.2.0.7: known people whose LinkedIn profile is still missing - a web search usually lists it.
  if ((f.contactsWithoutProfile || 0) > 0) out.push("profiles");
  return out;
}

// Design 5.1: publicly traded companies first (their reports answer the most at once, R7a.1), then by
// priority (P1 first, none last), then by the order the account was listed in. `entries`:
// [{ key, isPublic: true | false | null, priority: "P1".."P5" | null, order: number | null }].
// 1.2.0.13 (Boaz, 2026-10-01): before all of that, accounts the web can make Ready on its own (`readyByWeb`: the
// LinkedIn company is verified and a verified relevant contact is the only thing missing) - a profile found in
// search results makes them Ready at once. The first automatic run researched 20 accounts and Ready rose by 1,
// because most of them still needed the LinkedIn re-check of their company id.
export function webLaneOrder(entries) {
  const lvl = (p) => { const m = /^P([1-5])$/.exec(p || ""); return m ? Number(m[1]) : 9; };
  return [...(entries || [])].sort((a, b) =>
    (a.readyByWeb ? 0 : 1) - (b.readyByWeb ? 0 : 1) ||
    (a.isPublic === true ? 0 : 1) - (b.isPublic === true ? 0 : 1) ||
    lvl(a.priority) - lvl(b.priority) ||
    (a.order ?? Infinity) - (b.order ?? Infinity) ||
    String(a.key).localeCompare(String(b.key)));
}

// Is a verified contact the only thing between this account and Ready (webLaneOrder's readyByWeb)? `assessment`
// from readiness.js assessAccount.
export function onlyContactMissing(assessment) {
  const missing = (assessment && assessment.missing) || [];
  return Boolean(assessment && assessment.scannable) && missing.length > 0 && missing.every((m) => m.field === "contact");
}

// "Public", "Listed", "SIX: NESN" ... -> true; "Private", "Cooperative", "State-owned" ... -> false; else null.
// Reads the workbook's Company Type column, or the research's own isPublic answer.
export function isPubliclyTraded(companyType, researchIsPublic) {
  if (researchIsPublic === true || researchIsPublic === false) return researchIsPublic;
  const s = String(companyType || "").toLowerCase();
  if (!s.trim()) return null;
  // The "not traded" words first: "unlisted", "privately held" and "public body" all contain a "traded" word.
  if (/\b(unlisted|not listed|private|privately|cooperative|co-operative|state[- ]owned|government|public[- ](body|sector|institution|authority|law)|non-?profit|foundation|association|family|organi[sz]ation)\b/.test(s)) return false;
  if (/\b(public|publicly|listed|stock|exchange|six|nyse|nasdaq)\b/.test(s)) return true;
  return null;
}


// ---- D10 profile search (1.2.0.7): LinkedIn profiles read off web search results, no LinkedIn visit ----

// Words too common in company names to tell one company from another.
const GENERIC_COMPANY_WORDS = new Set(["group", "holding", "holdings", "switzerland", "schweiz", "suisse", "svizzera", "swiss",
  "international", "company", "bank", "insurance", "services", "solutions", "the", "and", "und", "et", "of", "de"]);

// A search result's title is "Anna Muster - CFO - Glencore | LinkedIn": the person's name comes first.
export function profileTitleName(title) {
  return String(title || "").split(/\s+[-–—|]\s+/)[0].trim();
}

// Does the result title name the company? Any distinctive word of its name counts ("Kühne + Nagel" -> "kuhne"
// or "nagel"). A company whose name is only generic words cannot be checked, and then nothing is accepted.
export function titleNamesCompany(title, companyName) {
  const words = nameTokens(normalizeCompanyName(companyName)).filter((w) => w.length >= 3 && !GENERIC_COMPANY_WORDS.has(w));
  if (words.length === 0) return false;
  const found = new Set(nameTokens(title));
  return words.some((w) => found.has(w));
}

// results: [{ url, title }] from web searches; people: [{ fullName }]. Returns [{ fullName, url }] - a profile only
// when the title names the person (first and last name) AND the company, and exactly one profile does
// (pickProfileMatch: never guess between two).
export function profilesFromSearchResults(results, people, companyName) {
  const candidates = [];
  for (const r of results || []) {
    const m = /^https?:\/\/([a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([^/?#\s]+)/i.exec(String((r && r.url) || ""));
    if (!m) continue;
    candidates.push({ slug: decodeURIComponent(m[2]).toLowerCase(), name: profileTitleName(r.title), conflict: !titleNamesCompany(r.title, companyName) });
  }
  const out = [];
  for (const p of people || []) {
    const pick = pickProfileMatch(candidates, p.fullName);
    if (pick.status === "found") out.push({ fullName: p.fullName, url: profileUrlFromSlug(pick.candidate.slug) });
  }
  return out;
}
