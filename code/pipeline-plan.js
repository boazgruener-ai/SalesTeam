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

// The pipeline stops at the warning line of the shared LinkedIn budget, leaving the remaining room
// (up to the hard stop at 99) to the user's own scans (design 5.2).
export const PIPELINE_TOUCH_CEILING = 75;
// A job for a field that has failed on this many different days stops being offered (design 5.5).
export const MAX_FAILED_DAYS = 2;

const ONE_DAY_MS = 86400000;
export const PIPELINE_JOBS = ["resolve", "size", "profile", "contacts"];
export const JOB_LABELS = {
  resolve: "LinkedIn company re-check",
  size: "Employee count",
  profile: "Contact's LinkedIn profile",
  contacts: "Contact discovery",
  score: "Priority",
};

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

// Ordered job ids for one account, from its readiness assessment. `pipeline` is its per-account state.
// Only the LinkedIn jobs of build step 2; web research joins in step 5.
export function jobsNeeded(view, assessment, pipeline, now) {
  const jobs = [];
  const slug = companyLinkSlug(view.linkedinLink);
  const idGap = gap(assessment, "linkedinCompanyId");
  if (idGap && !jobGaveUp(pipeline, "resolve")) jobs.push("resolve");
  // Size needs the company's own page. When resolve is about to visit it, size rides along for free
  // (T3); the runner decides that, this list still names both.
  if (gap(assessment, "employees") && (slug || jobs.includes("resolve")) && !jobGaveUp(pipeline, "size")) jobs.push("size");
  const contactGap = gap(assessment, "contact");
  if (contactGap && (slug || jobs.includes("resolve"))) {
    const known = contactGap.reason !== "absent" ? profileContactToTry(view, pipeline, now) : null;
    if (known) jobs.push("profile");
    else if (!jobGaveUp(pipeline, "contacts")) jobs.push("contacts");
  }
  return jobs;
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
  }
  return n;
}

// entries: [{ view, assessment, pipeline }]. Returns the candidates in the order the pipeline takes
// them: provisional priority (P1 first, unscored counts as P3), then fewest touches to Ready, then the
// account the pipeline has waited longest to handle. An account already handled today is skipped, so
// a job that failed is retried tomorrow, not again in the same run.
export function rankCandidates(entries, now, contactChunks) {
  const today = localDay(now);
  const level = (p) => { const m = /^P([1-5])$/.exec(p || ""); return m ? Number(m[1]) : 3; };
  return (entries || [])
    .filter((e) => e && e.view && !e.view.deleted && !e.view.excluded)
    .filter((e) => !(e.pipeline && e.pipeline.lastRunDay === today))
    .map((e) => {
      const jobs = jobsNeeded(e.view, e.assessment, e.pipeline, now);
      return { ...e, jobs, touches: estimateTouches(jobs, e.view, contactChunks) };
    })
    .filter((e) => e.jobs.length > 0)
    .sort((a, b) =>
      level(a.view.salesTeamPriority) - level(b.view.salesTeamPriority) ||
      a.touches - b.touches ||
      String((a.pipeline && a.pipeline.lastRunDay) || "").localeCompare(String((b.pipeline && b.pipeline.lastRunDay) || ""))
    );
}
