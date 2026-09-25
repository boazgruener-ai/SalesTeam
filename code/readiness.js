// Account readiness - the one definition of "is this account ready to work" (DATA_PIPELINE_DESIGN.md
// section 3). The Pipeline status pie, the Readiness column, the Scanner's account selection and, from
// build step 2 on, the pipeline scheduler all call this module, so they can never disagree (R3.4).
//
// PURE: no chrome.*, no DOM, no import from storage.js. It is executed and asserted on by
// test_pure_modules.py. Everything it needs arrives in the arguments: storage.js's getAccountViews()
// does the joining of the three account stores and hands this module one flat `view` per account.
//
// view = {
//   key, company, source,                         // source: "Imported" | "Discovered" | "HubSpot"
//   linkedinCompanyId, linkedinLink,
//   salesTeamPriority,                            // effective: manual override, else the row's
//   globalHqCountry, globalEmployees, swissEmployees, industry,   // effective values
//   evidenceStatus, lastVerified,                 // the imported row's own columns
//   deleted, excluded,
//   provenance: { field: { src, at, cited?, evidence?, link?, v? } },
//   contacts: [{ fullName, relevant, linkedinUrl, verifiedAt }],   // relevant: at a wizard seniority level
//   importedAt,                                   // when the workbook was imported (fallback date, D6)
// }

export const MIN_READY_TO_SCAN = 5;

const DAY_MS = 86400000;
// Freshness windows (R5.2, D5): identity, HQ country and industry rarely change; headcount and people do.
export const FRESHNESS_DAYS = {
  linkedinCompanyId: 365,
  globalHqCountry: 365,
  industry: 365,
  employees: 182,
  contact: 182,
};

// Workbook Evidence Status values that count as a good source (R5.2: "Sufficient or better").
const GOOD_EVIDENCE = new Set(["full evidence", "rich evidence", "sufficient evidence"]);

export const READINESS_STATES = ["ready", "usable", "in_progress", "needs_decision", "lacking_evidence"];
export const READINESS_LABELS = {
  ready: "Ready",
  usable: "Usable",
  in_progress: "In progress",
  needs_decision: "Needs your decision",
  lacking_evidence: "Lacking evidence",
};

export const FIELD_LABELS = {
  linkedinCompanyId: "LinkedIn company",
  salesTeamPriority: "Priority",
  globalHqCountry: "HQ country",
  employees: "Employees",
  industry: "Industry",
  contact: "Relevant contact",
};

// ---------------------------------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------------------------------

function isPresent(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

// A date as stored anywhere in this extension: epoch ms, an Excel serial day number (what xlsx-lite
// hands back for a date cell), or a date string ("2026-09-24", "24.09.2026", "24/09/2026").
export function toEpochMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e11) return value;                                   // epoch ms
    if (value > 20000 && value < 80000) return Date.UTC(1899, 11, 30) + value * DAY_MS;  // Excel serial
    return null;
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  if (/^\d+(\.\d+)?$/.test(s)) return toEpochMs(Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// The part of a LinkedIn company url that identifies the page: "https://www.linkedin.com/company/
// Nestle-S-A/about/" -> "nestle-s-a". Two links name the same page exactly when their slugs match.
export function companyLinkSlug(url) {
  if (!url) return null;
  const m = /linkedin\.com\/company\/([^/?#]+)/i.exec(String(url));
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
}

// The value a provenance entry attests, reduced to a string so a stored number and the same number
// read back as text compare equal.
export function provenanceValueKey(v) {
  return isPresent(v) ? String(v).trim().toLowerCase() : "";
}

// The research workbook's own Seniority column ("C-level / Group", "Head-level", "Specialist"...) as one
// of the Setup wizard's level ids, or null when it names none of them. Used before the job-title guess
// (classifyJobTitleSeniority in storage.js), which misses titles such as "Chief Digital & Information
// Officer" - the research already judged the person's seniority, so its verdict wins (2026-09-25).
const SENIORITY_LABEL_PATTERNS = [
  ["board", /\bboard\b|chair/],
  ["cLevel", /\bc-?\s?level\b|c-suite|\bchief\b|\bceo\b|executive (committee|board|management)/],
  ["vp", /\bs?vp\b|\bevp\b|vice[- ]president/],
  ["head", /\bhead\b/],
  ["director", /\bdirector\b/],
  ["manager", /\bmanager\b|team lead/],
];

export function seniorityLevelFromLabel(label) {
  const text = String(label || "").toLowerCase();
  if (!text.trim()) return null;
  for (const [id, re] of SENIORITY_LABEL_PATTERNS) if (re.test(text)) return id;
  return null;
}

// ---------------------------------------------------------------------------------------------------
// R3.5: which fields this user's targeting actually depends on
// ---------------------------------------------------------------------------------------------------

// "Other than medium" is the exact test computeCompanyDeterministicPreScore uses: a priority of 2 adds
// nothing to the score, so a field only ever weighed at medium can never change a decision and must
// not hold an account back.
function hasNonMedium(priorities) {
  return priorities.some((p) => p !== null && p !== undefined && p !== 2);
}

export function requiredFields(cfg) {
  const c = cfg || {};
  const fields = ["linkedinCompanyId", "salesTeamPriority"];
  if (hasNonMedium(Object.values(c.locationPriorities || {}))) fields.push("globalHqCountry");
  if (hasNonMedium(Object.values(c.sizeBuckets || {}).map((b) => (b ? b.priority : null)))) fields.push("employees");
  if (hasNonMedium((c.industries || []).map((i) => (i ? i.priority : null)))) fields.push("industry");
  fields.push("contact");
  return fields;
}

// ---------------------------------------------------------------------------------------------------
// Provenance: derived from what is already stored (section 4.3)
// ---------------------------------------------------------------------------------------------------

// Which stored value stands for the "employees" requirement: the same one the scorer reads
// (globalEmployees, else swissEmployees).
export function employeesField(view) {
  return isPresent(view.globalEmployees) ? "globalEmployees" : isPresent(view.swissEmployees) ? "swissEmployees" : null;
}

// A stored provenance entry counts only while the value it was recorded for is still the value in
// place. A re-import, a merge or an edit that changes the value makes the old entry silently stale,
// and the field is then derived again from what is there now - so no writer can leave provenance
// pointing at a value that is gone.
export function applicableProvenance(view, field) {
  const p = view.provenance && view.provenance[field];
  if (!p) return null;
  if (p.v !== undefined && provenanceValueKey(p.v) !== provenanceValueKey(view[field])) return null;
  return p;
}

// Derives provenance for one field that has a value but no applicable stored entry. `facts` carries
// what the view alone does not: whether the value is an override, the account's web research, the
// attempt timestamps. Returns null for a field with no value. The result is written back once by
// storage.js, so from then on the account has real provenance and this guess is not made again.
export function deriveProvenance(view, field, facts, now) {
  const value = view[field];
  if (!isPresent(value)) return null;
  const f = facts || {};
  const base = { v: value };
  const importedAt = view.importedAt || now;

  if (field === "linkedinCompanyId") {
    // An id carried over from before provenance existed. It was read from LinkedIn, but which page it
    // was checked against is unknown: link stays null, so it is not verified until the pipeline
    // re-checks it against the account's own page (the 6-in-30 mismatch finding from step 0).
    // A Discovered row is the exception: its id and its link come off the same search-result card.
    const at = f.linkedinResolveAttemptedAt || importedAt;
    const discovered = view.source === "Discovered";
    return { ...base, src: discovered ? "discovery" : "linkedin", at, link: discovered ? view.linkedinLink || null : null };
  }

  if (f.overridden && f.overridden[field]) {
    const research = f.webResearch;
    if (research && Array.isArray(research.sources) && research.sources.length > 0 && research.at) {
      return { ...base, src: "web", at: research.at, cited: true };
    }
    return { ...base, src: "user", at: importedAt };
  }

  if ((field === "globalEmployees" || field === "swissEmployees") && f.employeeCountText && f.sizeFetchAttemptedAt) {
    return { ...base, src: "linkedin", at: f.sizeFetchAttemptedAt };
  }
  if (view.source === "Discovered") return { ...base, src: "discovery", at: f.discoveredAt || importedAt };
  if (view.source === "HubSpot") return { ...base, src: "workbook", at: importedAt, evidence: null };
  return {
    ...base,
    src: "workbook",
    at: toEpochMs(view.lastVerified) || importedAt,   // D6: empty Last_Verified -> the import date
    evidence: view.evidenceStatus || null,
  };
}

// ---------------------------------------------------------------------------------------------------
// Verification (R5.2)
// ---------------------------------------------------------------------------------------------------

function isGoodSource(p) {
  if (!p) return false;
  if (p.src === "linkedin" || p.src === "discovery" || p.src === "user") return true;   // D2: user = verified
  if (p.src === "web") return Boolean(p.cited);
  if (p.src === "workbook") return GOOD_EVIDENCE.has(String(p.evidence || "").trim().toLowerCase());
  return false;
}

function isFresh(at, days, now) {
  return typeof at === "number" && now - at <= days * DAY_MS;
}

// Returns null when the field is fine, otherwise { field, reason, detail }.
function checkField(view, field, now) {
  if (field === "salesTeamPriority") {
    return /^P[1-5]$/.test(view.salesTeamPriority || "") ? null : { field, reason: "absent" };
  }
  if (field === "contact") return checkContacts(view, now);

  const valueField = field === "employees" ? employeesField(view) : field;
  if (!valueField || !isPresent(view[valueField])) return { field, reason: "absent" };
  const p = applicableProvenance(view, valueField);

  if (field === "linkedinCompanyId") {
    if (!p || (p.src !== "linkedin" && p.src !== "discovery")) return { field, reason: "unverified", detail: "not read from LinkedIn" };
    // The re-check rule: the id counts only once it was read off the very page the account's link
    // points to. A link changed by a re-import, or an id carried over with no record of the page it
    // came from, both fail here.
    const current = companyLinkSlug(view.linkedinLink);
    if (!current) return { field, reason: "unverified", detail: "no LinkedIn page link" };
    if (companyLinkSlug(p.link) !== current) return { field, reason: "unverified", detail: "not yet re-checked against its LinkedIn page" };
    return isFresh(p.at, FRESHNESS_DAYS.linkedinCompanyId, now) ? null : { field, reason: "expired" };
  }

  if (!isGoodSource(p)) return { field, reason: "unverified", detail: p ? `source: ${p.src}${p.src === "workbook" && p.evidence ? ` (${p.evidence})` : ""}` : "unknown source" };
  return isFresh(p.at, FRESHNESS_DAYS[field], now) ? null : { field, reason: "expired" };
}

// R3.6: at least one contact at a wizard seniority level, with a LinkedIn profile, checked within the
// freshness window. The best contact decides: a stale relevant one is "expired", none at all "absent".
function checkContacts(view, now) {
  const all = view.contacts || [];
  const relevant = all.filter((c) => c.relevant);
  if (relevant.length === 0) {
    // Say which case it is: no contacts at all, or contacts whose titles match none of the seniority
    // levels chosen in Setup - the second is a keyword question, not a research gap.
    return all.length === 0
      ? { field: "contact", reason: "absent", detail: "no contacts" }
      : { field: "contact", reason: "absent", detail: `${all.length} contact${all.length === 1 ? "" : "s"}, none at the seniority levels chosen in Setup` };
  }
  const withProfile = relevant.filter((c) => /linkedin\.com\/in\//i.test(c.linkedinUrl || ""));
  if (withProfile.length === 0) return { field: "contact", reason: "unverified", detail: "no LinkedIn profile" };
  if (withProfile.some((c) => isFresh(c.verifiedAt, FRESHNESS_DAYS.contact, now))) return null;
  return { field: "contact", reason: "expired" };
}

// ---------------------------------------------------------------------------------------------------
// The assessment
// ---------------------------------------------------------------------------------------------------

// Can the Scanner search this account at all: a LinkedIn id, a P1-P5 priority, not deleted or
// excluded. `scope` narrows by priority the way Scanner > Run does ("P1", "P2", "P3" or "all").
export function isScannable(view, scope) {
  if (!view || view.deleted || view.excluded || !isPresent(view.linkedinCompanyId)) return false;
  const level = /^P([1-5])$/.exec(view.salesTeamPriority || "");
  if (!level) return false;
  if (!scope || scope === "all") return true;
  const maxLevel = { P1: 1, P2: 2, P3: 3 }[scope] || 2;
  return Number(level[1]) <= maxLevel;
}

// Which jobs would close the gaps, in dependency order (section 5.1). Informational in step 1: it
// feeds the Readiness column's tooltip and, from step 2, the scheduler.
function jobsFor(missing) {
  const fields = new Set(missing.map((m) => m.field));
  const jobs = [];
  if (fields.has("linkedinCompanyId")) jobs.push("resolve");
  if (fields.has("employees")) jobs.push("size");
  if (fields.has("contact")) jobs.push("contacts");
  if (fields.has("globalHqCountry") || fields.has("industry")) jobs.push("web");
  if (fields.has("salesTeamPriority") || jobs.length > 0) jobs.push("score");
  return jobs;
}

// state, in the order section 3.2 checks it. `pending` (optional) carries what build steps 4-5 add:
// { decision: true } when the decision queue holds an item for this account, { lacking: true } when
// R12.5 is met. Step 1 never sets either, so it only ever returns ready / usable / in_progress.
export function assessAccount(view, cfg, now, pending) {
  const t = typeof now === "number" ? now : Date.now();
  const missing = [];
  for (const field of requiredFields(cfg)) {
    const gap = checkField(view, field, t);
    if (gap) missing.push(gap);
  }
  const scannable = isScannable(view, "all");
  let state;
  if (pending && pending.decision) state = "needs_decision";
  else if (pending && pending.lacking && !(pending.keep)) state = "lacking_evidence";
  else if (scannable && missing.length === 0) state = "ready";
  else if (scannable) state = "usable";
  else state = "in_progress";
  return { state, scannable, missing, nextJobs: jobsFor(missing) };
}

// Plain-language summary of what an account still lacks, for a tooltip or a table cell.
export function describeMissing(missing) {
  if (!missing || missing.length === 0) return "Nothing missing";
  return missing
    .map((m) => {
      const label = FIELD_LABELS[m.field] || m.field;
      if (m.reason === "absent") return `${label}: missing${m.detail ? ` (${m.detail})` : ""}`;
      if (m.reason === "expired") return `${label}: out of date`;
      return `${label}: not verified${m.detail ? ` (${m.detail})` : ""}`;
    })
    .join("; ");
}

// Counts per state, in display order, for the Pipeline status pie.
export function countReadiness(assessments) {
  const counts = Object.fromEntries(READINESS_STATES.map((s) => [s, 0]));
  for (const a of assessments) if (counts[a.state] !== undefined) counts[a.state]++;
  return counts;
}
