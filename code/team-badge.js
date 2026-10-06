// Team use 1.2.2, build step 6 (TEAM_USE_DESIGN.md 7, R6.5): the assignment badge on LinkedIn company and profile
// pages. team-badge-content-script.js sends the page's URL; this looks it up in the team's list and answers with
// the one line to show ("Assigned to Anna since 3 Oct"), or nothing when the page is not one of the team's accounts.
// Runs in the background worker; reads only - never writes, never visits anything.
import { normalizeCompanyName, parseLinkedinCompanySlug } from "./storage.js";
import { TEAM_MEMBERSHIP_KEY, TEAM_ACCOUNTS_KEY } from "./team-sync.js";

const lower = (v) => String(v || "").trim().toLowerCase();

function profileSlug(url) {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(String(url || ""));
  if (!m) return null;
  try { return lower(decodeURIComponent(m[1])); } catch { return lower(m[1]); }
}

function timeText(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

// Every account key a LinkedIn company page could belong to: by the company's slug or numeric id, in targetAccounts
// and in the workbook's companies (the list's own rows). Live test 1.2.1.11: Nestle showed "unassigned" while the list
// showed it assigned - the first targetAccounts match was another key for the same page; the caller now picks.
function accountsForCompanyPage(url, accounts, workbook, normalize) {
  const slug = lower(parseLinkedinCompanySlug(url));
  if (!slug) return [];
  const hit = (link, id) => (link && lower(parseLinkedinCompanySlug(link)) === slug) || (id && String(id) === slug);
  const keys = [];
  for (const c of workbook?.companies || []) {
    if (c && hit(c.linkedinLink, c.linkedinCompanyId)) keys.push(normalize(c.company));
  }
  for (const [key, v] of Object.entries(accounts || {})) {
    if (v && hit(v.linkedinLink, v.linkedinCompanyId)) keys.push(key);
  }
  return [...new Set(keys.filter(Boolean))];
}

// The account key and the person a LinkedIn profile belongs to: a contact (Contact Link) first, else a lead.
function accountForProfilePage(url, workbook, results) {
  const slug = profileSlug(url);
  if (!slug) return null;
  for (const ct of workbook?.contacts || []) {
    if (ct?.company && profileSlug(ct.lastVerified2 || ct.profileUrl) === slug) return { key: normalizeCompanyName(ct.company), person: ct.fullName || "" };
  }
  for (const lead of Object.values(results || {})) {
    if (lead?.company && profileSlug(lead.profileUrl) === slug) return { key: normalizeCompanyName(lead.company), person: lead.author || "" };
  }
  return null;
}

// { show: false } | { show: true, text, tone: "mine" | "other" | "free", company }
export async function teamBadgeFor(url) {
  const v = await chrome.storage.local.get([TEAM_MEMBERSHIP_KEY, TEAM_ACCOUNTS_KEY, "targetAccounts", "targetAccountExtras", "targetAccountsWorkbook"]);
  if (!v[TEAM_MEMBERSHIP_KEY]) return { show: false };
  const workbook = v.targetAccountsWorkbook;
  let candidates = [];
  if (/linkedin\.com\/company\//i.test(url)) candidates = accountsForCompanyPage(url, v.targetAccounts, workbook, normalizeCompanyName);
  else if (/linkedin\.com\/in\//i.test(url)) {
    const more = await chrome.storage.local.get("results");
    const k = accountForProfilePage(url, workbook, more.results)?.key;
    if (k) candidates = [k];
  }
  const summary = v[TEAM_ACCOUNTS_KEY] || {};
  const nameIn = (key) => (workbook?.companies || []).find((c) => c && normalizeCompanyName(c.company) === key)?.company || v.targetAccounts?.[key]?.company || null;
  const known = candidates.filter((k) => !v.targetAccountExtras?.[k]?.deletedAt && nameIn(k));
  // The one the team has a state for (assigned / being updated) wins; otherwise the first.
  const key = known.find((k) => summary.accounts?.[k]) || known[0] || null;
  if (!key) return { show: false };
  const company = nameIn(key);
  const entry = summary.accounts?.[key] || null;
  const name = (m) => (m === summary.me ? "you" : summary.names?.[m] || "a colleague");
  if (entry?.h && entry.h !== summary.me) {
    return { show: true, tone: "other", company, text: `${company}: ${name(entry.h)} is updating it (since ${timeText(entry.hs)})` };
  }
  if (entry?.a) {
    const mine = entry.a === summary.me;
    return { show: true, tone: mine ? "mine" : "other", company, text: `${company}: assigned to ${name(entry.a)} since ${timeText(entry.as)}` };
  }
  return { show: true, tone: "free", company, text: `${company}: in the team's list, unassigned` };
}
