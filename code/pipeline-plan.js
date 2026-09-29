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

import { companyLinkSlug, FRESHNESS_DAYS, toEpochMs } from "./readiness.js";

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

// The next known contact to look up by name: a relevant one with no LinkedIn profile first, then one
// whose profile check is out of date. Contacts already searched are skipped, so each attempt tries a
// different person, and the job ends once every candidate has been searched.
export function profileContactToTry(view, pipeline, now) {
  const t = typeof now === "number" ? now : Date.now();
  const tried = new Set(((pipeline && pipeline.profileTried) || []).map((n) => nameTokens(n).join(" ")));
  const relevant = (view.contacts || []).filter((c) => c.relevant && nameTokens(c.fullName).length >= 2 && !tried.has(nameTokens(c.fullName).join(" ")));
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
    if (known) jobs.push("profile");
    else if (!jobGaveUp(pipeline, "contacts")) jobs.push("contacts");
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

export function rankCandidates(entries, now, contactChunks, opts) {
  const today = localDay(now);
  const level = (p) => priorityLevel(p) || 3;
  return (entries || [])
    .filter((e) => e && e.view && !e.view.deleted && !e.view.excluded)
    .filter((e) => !(e.pipeline && e.pipeline.lastRunDay === today))
    .map((e) => {
      const jobs = jobsNeeded(e.view, e.assessment, e.pipeline, now, opts);
      // Depth only: nothing to do but a full research that closes no gap.
      const depthOnly = jobs.length === 1 && jobs[0] === "web_full" &&
        !(webPlan(e.view, e.assessment, e.pipeline, now, jobsNeeded(e.view, e.assessment, e.pipeline, now)) || {}).early;
      return { ...e, jobs, depthOnly, touches: estimateTouches(jobs, e.view, contactChunks) };
    })
    .filter((e) => e.jobs.length > 0)
    .sort((a, b) =>
      Number(userRetryFirst(b)) - Number(userRetryFirst(a)) ||
      Number(a.depthOnly) - Number(b.depthOnly) ||
      level(a.view.salesTeamPriority) - level(b.view.salesTeamPriority) ||
      a.touches - b.touches ||
      String((a.pipeline && a.pipeline.lastRunDay) || "").localeCompare(String((b.pipeline && b.pipeline.lastRunDay) || ""))
    );
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
