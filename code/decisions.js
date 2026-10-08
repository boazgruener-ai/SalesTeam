// The Decisions page (1.2 build step 4, DATA_PIPELINE_DESIGN.md section 7, touch-ups V1-V8). One card at a
// time, the two answers its kind allows, and Skip. The queue is built from the data every time (V1), so
// this page only remembers which items were skipped while it is open (V7: Skip saves nothing).
//
// "Do the same for the others like this" (Boaz, 2026-09-27): offered only where the situation really is
// the same - a web finding on the same field, a Lacking-evidence account with the same cause. Identity
// questions (a changed page, a name match, a duplicate) are each about two particular companies.
//
// Wording follows the house rule: the two sides are "current" and "web finding", never "your".
import { getDecisionQueue, applyDecision } from "./storage.js";
import { DECISION_KIND_LABELS } from "./decision-rules.js";
import { askConfirm } from "./confirm-dialog.js";
import { DECISION_TAKEN_KEY } from "./decisions-dot.js";

const WATCHED_KEYS = new Set([
  "targetAccountExtras", "targetAccounts", "targetAccountsWorkbook", "discoveredCompanies", "discoveredContacts",
  "companyExclusions", "companyExclusionsLifted", "companyRelationships", "keptSeparateAccountPairs", "discoveryNameDecisions", "targetContactExtras",
  "teamJoinProposals", "teamAccountStates", // team use step 6: the Team Lead's join proposals
]);

const CHOICES = {
  page_changed: [["accept", "Accept new page"], ["keep", "Keep current"]],
  id_taken: [["same", "Same company"], ["different", "Different company"]],
  name_match: [["same", "Same company"], ["different", "Different company"]],
  duplicate: [["merge", "Merge"], ["separate", "Keep both"]],
  lacking_evidence: [["keep", "Keep"], ["remove", "Remove"]],
  finding: [["web", "Use web finding"], ["current", "Keep current"]],
};

const KIND_PLURAL = {
  page_changed: ["LinkedIn page changed", "LinkedIn pages changed"],
  id_taken: ["LinkedIn company already used", "LinkedIn companies already used"],
  name_match: ["possible same company", "possible same companies"],
  duplicate: ["possible duplicate", "possible duplicates"],
  lacking_evidence: ["account lacking evidence", "accounts lacking evidence"],
  finding: ["web finding", "web findings"],
  join_proposal: ["join proposal", "join proposals"],
};

// A join proposal's two answers depend on the account (who has it now) - the item carries them (team-proposals.js).
const choicesOf = (item) => item.choices || CHOICES[item.kind];

let items = [];
let skipped = [];      // ids skipped while this page is open, in the order they were skipped
let currentId = null;
let busy = false;
let refreshTimer = null;

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function show(v) {
  if (v === null || v === undefined || v === "") return "empty";
  if (typeof v === "number") return v.toLocaleString("en-US");
  return String(v);
}

function link(url, text) {
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text || "Open on LinkedIn")} ↗</a>` : "";
}

// Skipped items go to the back, in the order they were skipped.
function ordered() {
  const skip = new Set(skipped);
  return [...items.filter((i) => !skip.has(i.id)), ...skipped.map((id) => items.find((i) => i.id === id)).filter(Boolean)];
}

function similarTo(item) {
  if (!item.similar) return [];
  return items.filter((i) => i.similar === item.similar && i.id !== item.id);
}

function summaryText() {
  if (items.length === 0) return "";
  const counts = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  const parts = Object.entries(counts).map(([k, n]) => `${n} ${KIND_PLURAL[k][n === 1 ? 0 : 1]}`);
  return `${items.length} decision${items.length === 1 ? "" : "s"} waiting: ${parts.join(", ")}.`;
}

function bodyFor(item) {
  const p = item.payload || {};
  if (item.kind === "page_changed") {
    return `
      <p>This account's LinkedIn link now opens a different company page, <strong>"${esc(p.pageName)}"</strong>
      (id ${esc(p.pageId)}). The current company id is ${esc(p.currentId || "none")}. The names are too different
      for SalesTeam to accept the page by itself.</p>
      <p>${link(p.link, "Open the page")}</p>
      <p class="note"><strong>Accept new page</strong> if it is the same company under a new LinkedIn page (renamed
      or merged). <strong>Keep current</strong> if it is not: the current id stays and is not re-checked again.</p>`;
  }
  if (item.kind === "id_taken") {
    return `
      <p>This account has no LinkedIn link of its own, so SalesTeam searched LinkedIn by its name. The company it
      found (id ${esc(p.pageId)}) already belongs to another account, <strong>"${esc(p.otherCompany)}"</strong>.
      A name search can pick the wrong company, so nothing was written.</p>
      <table class="compare">
        <tr><th></th><th>This account</th><th>Other account</th></tr>
        <tr><th>Name</th><td>${esc(item.company)}</td><td>${esc(p.otherCompany)}${p.otherGone ? " <span class=\"note\">(since removed)</span>" : ""}</td></tr>
        <tr><th>Country</th><td>${esc(show(p.currentCountry))}</td><td>${esc(show(p.otherCountry))}</td></tr>
        <tr><th>LinkedIn</th><td>${link(p.pageUrl, "Page found by name")}</td><td>${link(p.otherLink, "Open")}</td></tr>
      </table>
      <p class="note"><strong>Same company</strong>: the LinkedIn company is written to this account too, and the two
      accounts are then merged by themselves or offered to you as a duplicate. <strong>Different company</strong>:
      nothing is written, and this account is not searched by name again until its name or link changes.</p>`;
  }
  if (item.kind === "name_match") {
    return `
      <p>Discovery found a company with the same name as this account, but on a different LinkedIn page.</p>
      <table class="compare">
        <tr><th></th><th>Current account</th><th>Found by Discovery</th></tr>
        <tr><th>Name</th><td>${esc(item.company)}</td><td>${esc(p.discoveredName)}</td></tr>
        <tr><th>Country</th><td>${esc(show(p.existingCountry))}</td><td>${esc(show(p.discoveredCountry))}</td></tr>
        <tr><th>Industry</th><td>${esc(show(p.existingIndustry))}</td><td>${esc(show(p.discoveredIndustry))}</td></tr>
        <tr><th>LinkedIn</th><td>${link(p.existingLink, "Open")}</td><td>${link(p.discoveredLink, "Open")}</td></tr>
      </table>
      <p class="note"><strong>Same company</strong>: the ${esc(p.discoveredContacts)} contact${p.discoveredContacts === 1 ? "" : "s"} Discovery found
      are added to this account. <strong>Different company</strong>: it is added as a new account, named
      "${esc(p.discoveredName)} (LinkedIn: …)" so the two can be told apart.</p>`;
  }
  if (item.kind === "duplicate") {
    const members = p.members || [];
    const place = (m) => [m.city, m.country].filter(Boolean).join(", ") || "unknown";
    const cell = (fn) => members.map((m) => `<td>${fn(m)}</td>`).join("");
    const rows = `
      <tr><th></th>${cell((m) => `<strong>${esc(m.company)}</strong>${m === members[0] ? " <span class=\"note\">(kept on Merge)</span>" : ""}`)}</tr>
      <tr><th>Source</th>${cell((m) => esc(m.source === "Discovered" ? "discovered" : "researched"))}</tr>
      <tr><th>LinkedIn page</th>${cell((m) => (m.link ? link(m.link, m.slug) : "none"))}</tr>
      <tr><th>LinkedIn company id</th>${cell((m) => esc(m.linkedinCompanyId || "none"))}</tr>
      <tr><th>HQ</th>${cell((m) => esc(place(m)))}</tr>
      <tr><th>Registry id</th>${cell((m) => esc(m.registryId || "none"))}</tr>
      <tr><th>Contacts</th>${cell((m) => esc(m.contacts))}</tr>`;
    return `
      <p><strong>Why these were paired:</strong> ${esc((p.reasons || []).join("; ") || "similar details")}.
      SalesTeam cannot settle it by itself: they do not share a LinkedIn company that has been checked against
      its own page. Compare the details below.</p>
      <table class="compare">${rows}</table>
      <p class="note"><strong>Merge</strong> keeps the first and moves the others' contacts, initiatives, sources and
      Post leads over; this cannot be undone. <strong>Keep both</strong>: they are never proposed again.</p>`;
  }
  if (item.kind === "lacking_evidence") {
    return `
      <p>${esc(p.text)}</p>
      ${p.link ? `<p>${link(p.link, "Open the LinkedIn page")}</p>` : ""}
      <p class="note">Without it, the Scanner cannot use this account. <strong>Keep</strong> leaves it in the list and
      stops retrying until something new arrives for it (a re-import, a Discovery result, an edit).
      <strong>Remove</strong> hides it everywhere; nothing is permanently erased.</p>`;
  }
  if (item.kind === "join_proposal") {
    const when = p.at ? new Date(p.at).toLocaleDateString([], { day: "numeric", month: "short" }) : "";
    return `
      <p><strong>${esc(p.byName)}</strong> joined the team${when ? ` on ${esc(when)}` : ""} with this account already in
      their own list, and had worked on it: ${esc((p.worked || []).join(", ") || "yes")}.</p>
      <table class="compare">
        <tr><th>Now</th><td>${p.current ? `Assigned to ${esc(p.current)}` : "Unassigned"}</td></tr>
        <tr><th>Proposed</th><td>Assigned to ${esc(p.byName)}</td></tr>
      </table>
      ${(p.details || []).length ? `<details class="join-details"><summary>Show details (${p.details.length})</summary>
        <table class="compare">${p.details.map((d) => `<tr><th>${esc(d.name)}</th><td>${esc(d.status)}${d.at ? ` <span class="note">${esc(new Date(d.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</span>` : ""}</td><td class="note">${esc({ lead: "lead (post)", contact: "contact", account: "account", "follow-up": "follow-up date", conversation: "Sales Mentor" }[d.what] || "")}</td></tr>`).join("")}</table>
      </details>` : ""}
      <p class="note"><strong>Give it to ${esc(p.byName)}</strong>: the account is assigned to them${p.current ? ` (${esc(p.current)} no longer has it)` : ""}.
      <strong>${p.current ? `Keep with ${esc(p.current)}` : "Leave unassigned"}</strong>: nothing changes. Either way the
      contacts and leads ${esc(p.byName)} contacted keep that status, so nobody approaches the same person twice.</p>`;
  }
  if (item.kind === "finding") {
    return `
      <p>Web research found a different <strong>${esc(p.label)}</strong>, and the automatic resolve could not settle
      it because it could change a decision.</p>
      <table class="compare">
        <tr><th>Current</th><td>${esc(show(p.current))}</td></tr>
        <tr><th>Web finding</th><td>${esc(show(p.found))}${p.sources ? ` <span class="note">(research read ${esc(p.sources)} source${p.sources === 1 ? "" : "s"})</span>` : ""}</td></tr>
      </table>
      <p class="note">The account's Review findings dialog shows the research and its sources in full.</p>`;
  }
  return "";
}

function similarLabel(item, n) {
  const p = item.payload || {};
  if (item.kind === "join_proposal") return `Also for ${esc(p.byName)}'s other ${n} join proposal${n === 1 ? "" : "s"}`;
  if (item.kind === "finding") return `Also for the other ${n} ${esc(p.label)} finding${n === 1 ? "" : "s"}`;
  if (item.kind === "lacking_evidence") {
    const cause = p.reason === "empty_page" ? "with an empty LinkedIn page" : "with no LinkedIn company found";
    return `Also for the other ${n} account${n === 1 ? "" : "s"} ${cause}`;
  }
  return "";
}

function render() {
  const list = ordered();
  $("decisions-summary").textContent = summaryText();
  $("decisions-summary").hidden = list.length === 0;
  $("decisions-empty").hidden = list.length > 0;
  $("decision-card").hidden = list.length === 0;
  if (list.length === 0) { currentId = null; return; }

  const item = list.find((i) => i.id === currentId) || list[0];
  currentId = item.id;
  const index = list.indexOf(item);
  $("decision-kind").textContent = DECISION_KIND_LABELS[item.kind] || item.kind;
  $("decision-position").textContent = `${index + 1} of ${list.length}`;
  $("decision-company").innerHTML = `${esc(item.company)}${item.priority ? `<span class="priority">${esc(item.priority)}</span>` : ""}`;
  $("decision-body").innerHTML = bodyFor(item);

  const others = similarTo(item);
  $("decision-similar").hidden = others.length === 0;
  $("decision-similar-checkbox").checked = false;
  $("decision-similar-text").innerHTML = others.length ? similarLabel(item, others.length) : "";

  const [[aVal, aLabel], [bVal, bLabel]] = choicesOf(item);
  $("decision-choice-a").textContent = aLabel;
  $("decision-choice-a").dataset.choice = aVal;
  $("decision-choice-b").textContent = bLabel;
  $("decision-choice-b").dataset.choice = bVal;
  $("decision-choice-b").classList.toggle("danger", item.kind === "lacking_evidence");
  $("decision-skip").hidden = list.length < 2;
  $("decision-status").textContent = "";
}

async function load() {
  try {
    const q = await getDecisionQueue();
    items = q.items;
    skipped = skipped.filter((id) => items.some((i) => i.id === id));
  } catch (err) {
    items = [];
    $("decisions-summary").textContent = `Could not build the list: ${err.message || err}`;
  }
  render();
}

function setBusy(on) {
  busy = on;
  for (const id of ["decision-choice-a", "decision-choice-b", "decision-skip"]) $(id).disabled = on;
}

async function decide(choice) {
  if (busy) return;
  const item = items.find((i) => i.id === currentId);
  if (!item) return;
  const label = choicesOf(item).find(([v]) => v === choice)?.[1] || choice;
  const targets = [item, ...($("decision-similar-checkbox").checked ? similarTo(item) : [])];

  if (targets.length > 1) {
    const names = targets.slice(0, 8).map((t) => `- ${t.company}`).join("\n");
    const more = targets.length > 8 ? `\n…and ${targets.length - 8} more` : "";
    const ok = await askConfirm(`"${label}" for all ${targets.length}:\n\n${names}${more}`, {
      okLabel: `${label} (${targets.length})`, cancelLabel: "Cancel", danger: choice === "remove",
    });
    if (!ok) return;
  } else if (item.kind === "duplicate" && choice === "merge") {
    const ok = await askConfirm(`Merge ${(item.payload.members || []).map((m) => `"${m.company}"`).join(" and ")} into "${item.payload.members[0].company}"?\n\nThis cannot be undone from the app.`, {
      okLabel: "Merge", cancelLabel: "Cancel", danger: true,
    });
    if (!ok) return;
  }

  setBusy(true);
  $("decision-status").textContent = targets.length > 1 ? `Working on ${targets.length}…` : "Saving…";
  let done = 0;
  let lastLabel = "";
  try {
    for (const t of targets) {
      lastLabel = await applyDecision(t, choice);
      done++;
    }
    $("decisions-last").textContent = targets.length > 1 ? `Done for ${done}: ${label}.` : `Done: ${lastLabel}.`;
    currentId = null;
  } catch (err) {
    $("decision-status").textContent = `Stopped after ${done} of ${targets.length}: ${err.message || err}`;
  } finally {
    setBusy(false);
  }
  // The menu's red dot and the Pipeline status pie recount now, not after their usual delay.
  if (done > 0) await chrome.storage.local.set({ [DECISION_TAKEN_KEY]: Date.now() }).catch(() => {});
  await load();
}

$("decision-choice-a").addEventListener("click", (e) => decide(e.currentTarget.dataset.choice));
$("decision-choice-b").addEventListener("click", (e) => decide(e.currentTarget.dataset.choice));
$("decision-skip").addEventListener("click", () => {
  if (busy || !currentId) return;
  skipped = [...skipped.filter((id) => id !== currentId), currentId];
  currentId = null;
  render();
});

// The data changes underneath (a pipeline run, a Discovery merge, a decision taken in another tab).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || busy || !Object.keys(changes).some((k) => WATCHED_KEYS.has(k))) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, 1500);
});

$("version-text").textContent = `v${chrome.runtime.getManifest().version}`;
load();
