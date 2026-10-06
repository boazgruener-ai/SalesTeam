// The decision queue's rules (1.2 build step 4, DATA_PIPELINE_DESIGN.md section 7 and the step 4
// touch-ups V1-V8): which accounts are Lacking evidence, when a changed LinkedIn page may be accepted
// without asking, which duplicates are safe to merge, and how the queue is ordered and grouped.
//
// PURE, like readiness.js and pipeline-plan.js: no chrome.*, no DOM, no import from storage.js.
// test_pure_modules.py runs it. storage.js builds the queue from these rules (V1: it is built from the
// data every time, never stored), and decisions.html / decisions.js show it.

import { companyLinkSlug } from "./readiness.js";
import { parseSizeBand, jobGaveUp } from "./pipeline-plan.js";

export const DECISION_KINDS = ["page_changed", "id_taken", "name_match", "duplicate", "lacking_evidence", "finding"];

export const DECISION_KIND_LABELS = {
  page_changed: "LinkedIn page changed",
  id_taken: "LinkedIn company already used",
  name_match: "Same company?",
  duplicate: "Possible duplicate",
  lacking_evidence: "Lacking evidence",
  finding: "Web finding",
  join_proposal: "Join proposal",
};

// Bumped when a pipeline rule changes in a way that makes earlier failed attempts worth retrying once
// (step 4: the resolver read LinkedIn's new "Name: Overview" page titles as the whole name, and ten
// accounts gave up on that). Part of every account's inputs key, so a bump retries every account once.
export const PIPELINE_RULES_VERSION = 2;

// ---------------------------------------------------------------------------------------------------
// Retrying when something new arrives (R12.5.2)
// ---------------------------------------------------------------------------------------------------

// A short stable hash of what the pipeline was given for an account: the import it came from, its names,
// a link the user typed, and the rules version. The pipeline never writes any of these itself, so its
// own work cannot reset its own attempts.
export function accountInputsKey(parts) {
  const s = [PIPELINE_RULES_VERSION, ...(parts || [])].map((p) => (p === null || p === undefined ? "" : String(p))).join("\u0001");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// The pipeline state that still applies. When the inputs changed since the last attempt (a re-import, an
// edit, a Discovery merge, a rules change), every attempt, an empty-page mark, a Keep and a pending page
// change are forgotten, so the account is tried again from scratch. A state that never recorded any of
// these is left as it is.
export function effectivePipeline(pipeline, inputsKey) {
  const p = pipeline || {};
  const hasHistory = Boolean(
    (p.attempts && Object.keys(p.attempts).length > 0) || p.emptyPage || p.keep || p.pageChange || (p.profileTried && p.profileTried.length > 0) ||
    p.idTaken || (p.webGapAt && Object.keys(p.webGapAt).length > 0)
  );
  if (!hasHistory || p.inputsKey === inputsKey) return { ...p, inputsKey };
  return { ...p, attempts: {}, profileTried: [], emptyPage: null, keep: false, pageChange: null, idTaken: null, webGapAt: {}, inputsKey };
}

// ---------------------------------------------------------------------------------------------------
// Empty LinkedIn pages (R12.5.3)
// ---------------------------------------------------------------------------------------------------

// LinkedIn's lowest size band ("0-1 employees"): a company page with nobody on it.
export function isEmptyPageBand(sizeBandText) {
  const band = parseSizeBand(sizeBandText);
  return Boolean(band) && band.hi <= 1;
}

// ---------------------------------------------------------------------------------------------------
// A changed LinkedIn page (V4)
// ---------------------------------------------------------------------------------------------------

// LinkedIn titles a company page "Stadler: Overview | LinkedIn" (older pages: "Stadler | LinkedIn" or
// "About | LinkedIn"). The company's name is the part before the tab name.
export function cleanPageName(title) {
  return String(title || "")
    .replace(/^\(\d+\)\s*/, "")
    .replace(/\s*\|\s*LinkedIn\s*$/i, "")
    .replace(/\s*[:|]\s*(Overview|About|Posts|Jobs|People|Life|Home|Events|Products|Insights|Videos)\s*$/i, "")
    .trim();
}

// Words that say what kind of entity a name is, not which company.
const LEGAL_WORDS = new Set([
  "ag", "sa", "ltd", "limited", "gmbh", "inc", "group", "groupe", "gruppe", "holding", "holdings", "plc", "llc", "co",
  "company", "corp", "corporation", "se", "nv", "bv", "spa", "sarl", "sagl", "kg", "international", "switzerland",
  "schweiz", "suisse", "svizzera", "the",
]);
// First words too common to identify a company by themselves: "Zurich Insurance" and "Zurich Airport",
// "Swiss Life" and "Swiss Re" must not be taken for one another.
const GENERIC_FIRST_WORDS = new Set([
  "swiss", "schweizer", "schweizerische", "suisse", "zurich", "zuercher", "zurcher", "geneva", "geneve", "basel", "bern",
  "berner", "lausanne", "lugano", "st", "saint", "bank", "banque", "banca", "credit", "first", "global", "united", "general",
  "national", "european", "euro", "new", "royal", "ubs",
]);

export function companyWords(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[äàáâãå]/g, "a").replace(/[öòóôõø]/g, "o").replace(/[üùúû]/g, "u").replace(/[éèêë]/g, "e")
    .replace(/[ïìíî]/g, "i").replace(/ç/g, "c").replace(/ñ/g, "n").replace(/ß/g, "ss")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !LEGAL_WORDS.has(w));
}

// Does the name on the account's own LinkedIn page name the same company as the account? The names
// agree when one is the start of the other, word by word, after dropping legal words: "Stadler" and
// "Stadler Rail", "SIG Group" and "SIG Combibloc", "Valiant Bank AG" and "Valiant Holding". When the
// first word is a common one, two words must agree.
export function pageNamesAgree(accountNames, pageTitle) {
  const page = companyWords(cleanPageName(pageTitle));
  if (page.length === 0) return false;
  for (const name of accountNames || []) {
    const mine = companyWords(name);
    if (mine.length === 0) continue;
    const n = Math.min(mine.length, page.length);
    const need = GENERIC_FIRST_WORDS.has(mine[0]) ? 2 : 1;
    if (n < need) continue;
    let same = true;
    for (let i = 0; i < n; i++) if (mine[i] !== page[i]) { same = false; break; }
    if (same) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Lacking evidence (R12.5)
// ---------------------------------------------------------------------------------------------------

function niceDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (!m) return String(day || "");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]}`;
}

function listDays(days) {
  const d = [...new Set(days || [])].map(niceDay);
  return d.length <= 1 ? d.join("") : `${d.slice(0, -1).join(", ")} and ${d[d.length - 1]}`;
}

// { reason, text } when the account is Lacking evidence, else null. Two causes: its LinkedIn page looks
// empty (counts at once), or it has no LinkedIn company and the lookup has failed on two different days,
// so the Scanner can never see it. An account the Scanner can already search is never Lacking for a
// missing contact or size: it is Usable, and the pipeline keeps working on it.
export function lackingReason(view, pipeline) {
  if (!view || view.deleted || view.excluded) return null;
  const p = pipeline || {};
  if (p.emptyPage) {
    return { reason: "empty_page", text: `LinkedIn page looks empty (0-1 employees), seen on ${niceDay(p.emptyPage)}.` };
  }
  const hasId = view.linkedinCompanyId !== null && view.linkedinCompanyId !== undefined && view.linkedinCompanyId !== "";
  if (!hasId && jobGaveUp(p, "resolve")) {
    const days = (p.attempts && p.attempts.resolve) || [];
    return { reason: "no_linkedin", text: `No LinkedIn company found. Tried on ${listDays(days)}.` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Duplicates (V3)
// ---------------------------------------------------------------------------------------------------

export function accountPairKey(a, b) {
  return [a.companyId || a.key, b.companyId || b.key].sort().join("|");
}

function differs(a, b) {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  return Boolean(x && y && x !== y);
}

// Evidence that two rows are NOT the same company, from what is already stored (no LinkedIn visit).
// Different registry ids (Zefix UID) are two legal entities. Links that open two different LinkedIn pages
// are two LinkedIn companies - found live 2026-09-27: Basilea Pharmaceutica and ADC Therapeutics carried
// the same LinkedIn id, because one of them held the other's (the step 0 "stored id does not match its own
// page" problem, which the pipeline's re-check corrects). A shared id is then a wrong id, not a duplicate.
export function duplicateContradiction(a, b, via) {
  if (differs(a.registryId, b.registryId)) return "different registry ids";
  if (via === "id" && differs(a.slug, b.slug)) return "different LinkedIn pages";
  return null;
}

// rows: [{ companyId, key, company, source, universeOrder, linkedinCompanyId, idVerified, slug, registryId }],
// live rows only. Rows are grouped when they share a name, a LinkedIn page or a LinkedIn id, unless the
// user said to keep them separate or the stored data contradicts it (duplicateContradiction). A group is
// `auto` (safe to merge without asking) only when every member carries the same LinkedIn id and at least
// one has had it re-checked against its own page: a merge removes a row and cannot be undone, so nothing
// weaker is merged silently.
export function duplicateGroups(rows, keptSeparate) {
  const list = (rows || []).filter((r) => r && r.key);
  const kept = keptSeparate instanceof Set ? keptSeparate : new Set(keptSeparate || []);
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const seen = { name: new Map(), slug: new Map(), id: new Map() };
  const link = (kind, value, i) => {
    if (!value) return;
    const v = String(value);
    if (!seen[kind].has(v)) { seen[kind].set(v, i); return; }
    const other = seen[kind].get(v);
    if (kept.has(accountPairKey(list[other], list[i]))) return;
    if (duplicateContradiction(list[other], list[i], kind)) return;
    const a = find(other);
    const b = find(i);
    if (a !== b) parent[b] = a;
  };
  list.forEach((r, i) => { link("name", r.key, i); link("slug", r.slug, i); link("id", r.linkedinCompanyId, i); });
  const groups = new Map();
  list.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const reasons = [];
    if (new Set(members.map((m) => m.key)).size < members.length) reasons.push("same name");
    const slugs = members.map((m) => m.slug).filter(Boolean);
    if (slugs.length > new Set(slugs).size) reasons.push("same LinkedIn page");
    const ids = members.map((m) => (m.linkedinCompanyId ? String(m.linkedinCompanyId) : ""));
    const sameId = ids.every((id) => id && id === ids[0]);
    if (sameId) reasons.push(`both hold LinkedIn company id ${ids[0]}`);
    // The keeper: a researched row over a discovered one, then the earlier one in the research order.
    members.sort((a, b) => (a.source === "Discovered") - (b.source === "Discovered") || (a.universeOrder ?? 1e9) - (b.universeOrder ?? 1e9));
    out.push({ members, reasons, auto: sameId && members.some((m) => m.idVerified) });
  }
  return out.sort((a, b) => String(a.members[0].company).localeCompare(String(b.members[0].company)));
}

// ---------------------------------------------------------------------------------------------------
// The queue: order, and "the same situation" (Boaz's suggestion, 2026-09-27)
// ---------------------------------------------------------------------------------------------------

// Items that are the same situation, so one decision may be applied to all of them: web findings on the
// same field with the same choice, and Lacking-evidence accounts with the same cause. Identity decisions
// (a changed page, a name match, a duplicate) are each about two particular companies and never grouped.
export function similarKey(item) {
  if (!item) return null;
  if (item.kind === "finding") return `finding:${item.payload && item.payload.field}`;
  if (item.kind === "lacking_evidence") return `lacking:${item.payload && item.payload.reason}`;
  return null;
}

// Identity first (they decide which company an account IS), then Lacking evidence, then findings; inside
// each kind, P1 before P2 and so on, then by name.
export function sortDecisions(items) {
  const kindRank = (k) => { const i = DECISION_KINDS.indexOf(k); return i < 0 ? 99 : i; };
  const level = (p) => { const m = /^P([1-5])$/.exec(p || ""); return m ? Number(m[1]) : 6; };
  return [...(items || [])].sort((a, b) =>
    kindRank(a.kind) - kindRank(b.kind) ||
    level(a.priority) - level(b.priority) ||
    String(a.company || "").localeCompare(String(b.company || "")) ||
    String(a.id).localeCompare(String(b.id))
  );
}

// True when a company page link is usable to check a duplicate's id against.
export function idVerifiedFor(provenanceEntry, linkedinLink, source) {
  if (source === "Discovered") return Boolean(companyLinkSlug(linkedinLink));
  if (!provenanceEntry || (provenanceEntry.src !== "linkedin" && provenanceEntry.src !== "discovery")) return false;
  const slug = companyLinkSlug(linkedinLink);
  return Boolean(slug) && companyLinkSlug(provenanceEntry.link) === slug;
}
