// Team advanced mode 1.2.3, build step 1 (TEAM_ADVANCED_MODE_DESIGN.md 10): Settings > Team - the Groups section.
//   renderTeamGroups(ctx)          - the table (Team Lead and deputy edit; members see it read-only, their groups marked)
//   editMemberGroups(member, ctx)  - the members table's ⋮ > Groups…: tick one member's groups
//   openTeamMenu(anchor, items)    - the ⋮ popup both tables use (one look, one behaviour)
// Groups live in chrome.storage.local.teamGroups (one row per group); the sync layer sends them and the merge counts a
// group record only from the Team Lead or the deputy (design 4.2). Every count and the editor's preview come from the
// same pure functions the background uses (team-groups.js), so what this page says is what every PC computes.
import { askConfirm } from "./confirm-dialog.js";
import { getAccountReadiness, SIZE_PRIORITY_BUCKETS } from "./storage.js";
import { CONTINENT_LABELS } from "./geo-regions.js";
import {
  groupIndex, groupsOf, groupFacts, groupCounts, voidAssignments, groupProblem, OTHER_GROUP, GROUP_FILTER_FIELDS,
} from "./team-groups.js";

const GROUPS_KEY = "teamGroups";
const PINS_KEY = "teamGroupPins";
const SUMMARY_KEY = "teamAccountStates"; // team-sync.js TEAM_ACCOUNTS_KEY
const ACCOUNT_KEYS = ["targetAccountsWorkbook", "targetAccounts", "targetAccountExtras", "companyRelationships", "companyExclusions"];
const ACCOUNTS_MAX_AGE_MS = 30000;
const PREVIEW_LISTED = 50;

const FIELD_LABELS = {
  region: "Region", country: "Country", size: "Size", scope: "Local / Global", industry: "Industry",
  companyType: "Company type", priority: "Priority", relationship: "Relationship",
};
const SCOPE_LABELS = { local: "Local", global: "Global" };
const RELATIONSHIP_LABELS = { customer: "Customer", partner: "Partner", none: "Neither" };
const PRIORITIES = ["P1", "P2", "P3", "P4", "P5"];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------
// The ⋮ popup
// ---------------------------------------------------------------------------------------------------

let openPopup = null;
function closeTeamMenu() {
  if (openPopup) { openPopup.remove(); openPopup = null; }
}

// items: [{ label, onClick, danger?, title? }]. A second click on the same ⋮ closes it.
export function openTeamMenu(anchor, items) {
  const again = openPopup && openPopup.dataset.anchor === anchor.dataset.menuId;
  closeTeamMenu();
  if (again || !items.length) return;
  const popup = el("div", "team-menu-popup");
  popup.dataset.anchor = anchor.dataset.menuId || "";
  for (const item of items) {
    const b = el("button", `team-menu-item${item.danger ? " danger" : ""}`, item.label);
    b.type = "button";
    if (item.title) b.title = item.title;
    b.addEventListener("click", () => { closeTeamMenu(); item.onClick(); });
    popup.append(b);
  }
  document.body.append(popup);
  const r = anchor.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(r.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8)) + window.scrollX}px`;
  popup.style.top = `${r.bottom + 2 + window.scrollY}px`;
  openPopup = popup;
  setTimeout(() => document.addEventListener("click", (e) => { if (!popup.contains(e.target)) closeTeamMenu(); }, { once: true }), 0);
}

export function kebabButton(id, title, items) {
  const b = el("button", "team-kebab", "⋮");
  b.type = "button";
  b.title = title;
  b.dataset.menuId = id;
  b.addEventListener("click", (e) => { e.stopPropagation(); openTeamMenu(b, items()); });
  return b;
}

// ---------------------------------------------------------------------------------------------------
// Data: the accounts (cached - Settings > Team redraws every 5 s), the groups, the assignments
// ---------------------------------------------------------------------------------------------------

let accountsCache = null; // { at, rows: [{ key, name, facts, ready }] }
let accountsStale = true;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ACCOUNT_KEYS.some((k) => k in changes)) accountsStale = true;
});

async function loadAccounts() {
  if (accountsCache && (!accountsStale || Date.now() - accountsCache.at < ACCOUNTS_MAX_AGE_MS)) return accountsCache.rows;
  accountsStale = false;
  const seen = new Set();
  const rows = [];
  for (const { view, assessment } of await getAccountReadiness()) {
    if (!view?.key || seen.has(view.key)) continue;
    seen.add(view.key);
    rows.push({ key: view.key, name: view.company || view.key, facts: groupFacts(view, { buckets: SIZE_PRIORITY_BUCKETS }), ready: assessment?.state === "ready" });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  accountsCache = { at: Date.now(), rows };
  return rows;
}

async function loadGroupInputs() {
  const got = await chrome.storage.local.get([GROUPS_KEY, PINS_KEY, SUMMARY_KEY]);
  return { groups: got[GROUPS_KEY] || {}, pins: got[PINS_KEY] || {}, summary: got[SUMMARY_KEY] || null };
}

// ctx: { team: [member ids], names: { id: name }, leads: { lead, deputy }, me, canEdit }.
function buildModel(groups, pins, summary, accounts, ctx) {
  const index = groupIndex(groups, ctx.team);
  const byKey = {};
  for (const a of accounts) byKey[a.key] = groupsOf(a.key, a.facts, index, pins);
  const all = {};
  for (const [k, e] of Object.entries(summary?.accounts || {})) if (e?.a) all[k] = e.a;
  // D6: an assignment whose assignee has no access any more counts as unassigned.
  const voided = new Set(voidAssignments(all, byKey, index, ctx.leads).map((v) => v.key));
  const assignments = {};
  for (const [k, m] of Object.entries(all)) if (!voided.has(k)) assignments[k] = m;
  const ready = {};
  for (const a of accounts) if (a.ready) ready[a.key] = true;
  return { index, byKey, assignments, ready, counts: groupCounts(byKey, index, { assignments, ready }) };
}

// "Region Europe · Country Switzerland · Size M, L, XL"
function valueLabel(field, v) {
  if (field === "region") return (CONTINENT_LABELS[v] || v).replace(/ \(.*\)$/, "");
  if (field === "scope") return SCOPE_LABELS[v] || v;
  if (field === "relationship") return RELATIONSHIP_LABELS[v] || v;
  return String(v);
}
export function describeGroup(g) {
  if (g.kind === "named") return `Named accounts (${(g.accounts || []).length})`;
  const parts = [];
  for (const f of GROUP_FILTER_FIELDS) {
    const vals = g.filter?.[f];
    if (Array.isArray(vals) && vals.length) parts.push(`${FIELD_LABELS[f]} ${vals.map((v) => valueLabel(f, v)).join(", ")}`);
  }
  return parts.join(" · ") || "Filter (no condition)";
}

const namesOf = (ids, ctx) => ids.map((m) => (m === ctx.me ? `${ctx.names[m] || "you"} (you)` : ctx.names[m] || "a colleague"));

// ---------------------------------------------------------------------------------------------------
// The table (10.2)
// ---------------------------------------------------------------------------------------------------

let lastSignature = null;
let lastCtx = null;

export async function renderTeamGroups(ctx, { force = false } = {}) {
  const host = document.getElementById("team-groups");
  if (!host) return;
  lastCtx = ctx;
  const { groups, pins, summary } = await loadGroupInputs();
  const accounts = await loadAccounts();
  const assigned = Object.fromEntries(Object.entries(summary?.accounts || {}).filter(([, e]) => e?.a).map(([k, e]) => [k, e.a]));
  const signature = JSON.stringify([groups, pins, assigned, ctx, accountsCache?.at]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  const model = buildModel(groups, pins, summary, accounts, ctx);
  const { index, counts } = model;
  const mine = new Set(index.ofMember[ctx.me] || []);

  const nodes = [];
  if (!index.on) {
    nodes.push(el("p", "field-hint", "No groups yet: everyone in the team sees and works every account (as in 1.2.2). " +
      "With groups, each member sees only the accounts of their groups; the Team Lead sees all of them."));
  } else {
    const table = el("table", "team-groups-table");
    const head = el("tr", "team-members-head");
    for (const h of ["Group", "Kind", "Members", "Accounts", "Assigned", "Unassigned", "Ready", ""]) head.append(el("td", "", h));
    table.append(head);
    const rows = [...index.live].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const g of [...rows, { id: OTHER_GROUP, name: "Other" }]) {
      const c = counts[g.id] || { accounts: 0, assigned: 0, unassigned: 0, ready: 0 };
      const members = index.members[g.id] || [];
      const tr = el("tr");
      const nameTd = el("td");
      nameTd.append(el("strong", "", g.name || "(no name)"));
      if (mine.has(g.id)) nameTd.append(el("span", "team-group-mine", "your group"));
      if (g.description) nameTd.title = g.description;
      tr.append(nameTd);
      tr.append(el("td", "team-group-kind", g.id === OTHER_GROUP ? "everything in no group" : describeGroup(g)));
      const memTd = el("td", "", members.length ? namesOf(members, ctx).join(", ") : "");
      if (!members.length && g.id !== OTHER_GROUP) memTd.append(el("span", "team-warn", "no members"));
      tr.append(memTd);
      for (const n of [c.accounts, c.assigned, c.unassigned, c.ready]) tr.append(el("td", "team-num", String(n)));
      const act = el("td");
      if (ctx.canEdit && g.id !== OTHER_GROUP) {
        act.append(kebabButton(`group-${g.id}`, `Actions for the group ${g.name}`, () => [
          { label: "Edit…", onClick: () => openEditor(g.id) },
          { label: "Delete…", danger: true, onClick: () => deleteGroup(g.id) },
        ]));
      }
      tr.append(act);
      table.append(tr);
    }
    nodes.push(table);
  }
  if (ctx.canEdit) {
    const row = el("div", "settings-buttons-row");
    const add = el("button", "", "+ New group");
    add.type = "button";
    add.addEventListener("click", () => openEditor(null));
    row.append(add);
    nodes.push(row);
  } else if (index.on) {
    nodes.push(el("p", "field-hint", "Only the Team Lead changes the groups."));
  }
  host.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------------------------------------
// Writing (only through these; the merge ignores a non-lead's records anyway)
// ---------------------------------------------------------------------------------------------------

async function writeGroups(mutate) {
  const cur = (await chrome.storage.local.get(GROUPS_KEY))[GROUPS_KEY] || {};
  const next = structuredClone(cur);
  mutate(next);
  await chrome.storage.local.set({ [GROUPS_KEY]: next });
}

const newGroupId = () => `g-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

// ---------------------------------------------------------------------------------------------------
// The editor (10.2): name, description, kind, filter or list, members, live preview; Save / Cancel
// ---------------------------------------------------------------------------------------------------

// A multi-select: a <details> with one tick per value; the summary line shows what is ticked.
function multiSelect(field, options, chosen, onChange) {
  const box = el("details", "team-ms");
  const summary = el("summary");
  const list = el("div", "team-ms-list");
  const ticks = [];
  const paint = () => {
    const vals = ticks.filter((t) => t.checked).map((t) => t.value);
    summary.textContent = vals.length ? vals.map((v) => valueLabel(field, v)).join(", ") : "Any";
    summary.classList.toggle("team-ms-any", !vals.length);
  };
  for (const o of options) {
    const lab = el("label", "team-ms-item");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = o.value;
    cb.checked = chosen.includes(o.value);
    cb.addEventListener("change", () => { paint(); onChange(); });
    ticks.push(cb);
    lab.append(cb, document.createTextNode(` ${o.label}`));
    list.append(lab);
  }
  if (!options.length) list.append(el("p", "field-hint", "No account has a value here yet."));
  box.append(summary, list);
  paint();
  return { node: box, values: () => ticks.filter((t) => t.checked).map((t) => t.value) };
}

function filterOptions(field, accounts, current) {
  const distinct = (pick) => [...new Set(accounts.map(pick).filter((v) => v != null && v !== ""))].sort((a, b) => String(a).localeCompare(String(b)));
  let opts;
  switch (field) {
    case "region": opts = Object.keys(CONTINENT_LABELS).map((k) => ({ value: k, label: valueLabel("region", k) })); break;
    case "size": opts = SIZE_PRIORITY_BUCKETS.map((b) => ({ value: b.key, label: `${b.key} - ${b.label} (${b.max === Infinity ? `${b.min}+` : `${b.min}-${b.max}`} employees)` })); break;
    case "scope": opts = Object.entries(SCOPE_LABELS).map(([value, label]) => ({ value, label })); break;
    case "relationship": opts = Object.entries(RELATIONSHIP_LABELS).map(([value, label]) => ({ value, label })); break;
    case "priority": opts = [...new Set([...PRIORITIES, ...distinct((a) => a.facts.priority)])].map((v) => ({ value: v, label: v })); break;
    default: opts = distinct((a) => a.facts[field]).map((v) => ({ value: v, label: v }));
  }
  // A value the group already holds stays choosable even if no account has it any more.
  for (const v of current || []) if (!opts.some((o) => o.value === v)) opts.push({ value: v, label: `${valueLabel(field, v)} (no account now)` });
  return opts;
}

async function openEditor(groupId, { copyFrom = null } = {}) {
  const ctx = lastCtx;
  if (!ctx?.canEdit) return;
  const { groups, pins, summary } = await loadGroupInputs();
  const accounts = await loadAccounts();
  const before = buildModel(groups, pins, summary, accounts, ctx);
  const existing = groupId ? groups[groupId] : null;
  const id = groupId || newGroupId();
  const start = existing || copyFrom || { name: "", description: "", kind: "filter", filter: {}, accounts: [], members: [] };
  const known = new Set(accounts.map((a) => a.key));
  const nameOf = new Map(accounts.map((a) => [a.key, a.name]));

  const dlg = el("dialog", "team-group-dialog");
  dlg.append(el("h3", "", existing ? `Edit the group "${existing.name}"` : "New group"));
  const nameIn = Object.assign(document.createElement("input"), { type: "text", value: start.name || "", placeholder: "e.g. Swiss accounts" });
  const descIn = Object.assign(document.createElement("input"), { type: "text", value: start.description || "", placeholder: "What the group is for (optional)" });
  dlg.append(el("label", "", "Name"), nameIn, el("label", "", "Description"), descIn);

  // Kind - fixed once saved (D11).
  let kind = start.kind === "named" ? "named" : "filter";
  const kindRow = el("div", "team-kind-row");
  const kindRadios = {};
  for (const [k, label] of [["filter", "Filter - accounts that match conditions, including new ones"], ["named", "Named accounts - a list you tick"]]) {
    const lab = el("label");
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "team-group-kind";
    r.value = k;
    r.checked = kind === k;
    r.disabled = Boolean(existing);
    r.addEventListener("change", () => { kind = k; showKind(); update(); });
    kindRadios[k] = r;
    lab.append(r, document.createTextNode(` ${label}`));
    kindRow.append(lab);
  }
  dlg.append(el("label", "", existing ? "Kind (fixed once saved)" : "Kind"), kindRow);

  // Filter
  const filterBox = el("div", "team-filter-box");
  const selects = {};
  for (const f of GROUP_FILTER_FIELDS) {
    const cur = start.filter?.[f] || [];
    const ms = multiSelect(f, filterOptions(f, accounts, cur), cur, () => update());
    selects[f] = ms;
    const row = el("div", "team-filter-row");
    row.append(el("span", "team-filter-label", FIELD_LABELS[f]), ms.node);
    filterBox.append(row);
  }
  filterBox.append(el("p", "field-hint", "An account must match every field that has values (any one value per field). An account without a value for a field you set (e.g. no country yet) does not match - it waits in Other until research fills it in."));

  // Named accounts
  const namedBox = el("div", "team-named-box");
  const ticked = new Set(start.accounts || []);
  const search = Object.assign(document.createElement("input"), { type: "search", placeholder: "Search accounts" });
  const namedCount = el("p", "field-hint");
  const namedList = el("div", "team-named-list");
  const missingRow = el("p", "team-warn-line");
  const paintNamed = () => {
    const q = search.value.trim().toLowerCase();
    const shown = accounts.filter((a) => !q || a.name.toLowerCase().includes(q))
      .sort((a, b) => (ticked.has(b.key) - ticked.has(a.key)) || a.name.localeCompare(b.name)).slice(0, 400);
    namedList.replaceChildren(...shown.map((a) => {
      const lab = el("label", "team-ms-item");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = ticked.has(a.key);
      cb.addEventListener("change", () => { if (cb.checked) ticked.add(a.key); else ticked.delete(a.key); paintCount(); update(); });
      lab.append(cb, document.createTextNode(` ${a.name}`));
      return lab;
    }));
  };
  const paintCount = () => {
    const missing = [...ticked].filter((k) => !known.has(k));
    namedCount.textContent = `${plural(ticked.size - missing.length, "account")} ticked.`;
    missingRow.replaceChildren();
    if (missing.length) {
      missingRow.append(document.createTextNode(`${plural(missing.length, "account")} on this list no longer exist${missing.length === 1 ? "s" : ""} (renamed or removed). `));
      const rm = el("button", "secondary", "Remove");
      rm.type = "button";
      rm.addEventListener("click", () => { for (const k of missing) ticked.delete(k); paintCount(); update(); });
      missingRow.append(rm);
    }
  };
  search.addEventListener("input", paintNamed);
  namedBox.append(search, namedCount, missingRow, namedList);

  // Members
  const memberTicks = new Set((start.members || []).filter((m) => ctx.team.includes(m)));
  const membersBox = el("div", "team-members-ticks");
  for (const m of ctx.team) {
    const lab = el("label", "team-ms-item");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = memberTicks.has(m);
    cb.addEventListener("change", () => { if (cb.checked) memberTicks.add(m); else memberTicks.delete(m); update(); });
    lab.append(cb, document.createTextNode(` ${namesOf([m], ctx)[0]}${m === ctx.leads.lead ? " - Team Lead, sees every account anyway" : ""}`));
    membersBox.append(lab);
  }

  const preview = el("div", "team-preview");
  const problem = el("p", "team-status team-error");
  dlg.append(filterBox, namedBox, el("label", "", "Members"), membersBox, el("label", "", "Preview"), preview, problem);

  const draft = () => {
    const g = {
      ...(existing || {}), name: nameIn.value.trim(), description: descIn.value.trim(), kind,
      members: ctx.team.filter((m) => memberTicks.has(m)), deleted: false,
    };
    if (kind === "filter") {
      g.filter = Object.fromEntries(GROUP_FILTER_FIELDS.map((f) => [f, selects[f].values()]).filter(([, v]) => v.length));
      delete g.accounts;
    } else {
      g.accounts = [...ticked].sort();
      delete g.filter;
    }
    return g;
  };

  const showKind = () => { filterBox.hidden = kind !== "filter"; namedBox.hidden = kind !== "named"; if (kind === "named") { paintNamed(); paintCount(); } };

  let timer = null;
  const update = () => { clearTimeout(timer); timer = setTimeout(paintPreview, 120); };
  const paintPreview = () => {
    const g = draft();
    problem.textContent = "";
    const after = buildModel({ ...groups, [id]: g }, pins, summary, accounts, ctx);
    const matched = accounts.filter((a) => (after.byKey[a.key] || []).includes(id));
    const nAssigned = matched.filter((a) => before.assignments[a.key]).length;
    const lines = [];
    if (kind === "filter" && !Object.keys(g.filter || {}).length) {
      lines.push("Add at least one condition - an empty filter would match every account.");
    } else {
      lines.push(`Matches ${plural(matched.length, "account")} - ${matched.length - nAssigned} unassigned, ${nAssigned} assigned.`);
      if (existing && !existing.deleted) {
        const was = new Set(accounts.filter((a) => (before.byKey[a.key] || []).includes(id)).map((a) => a.key));
        const now = new Set(matched.map((a) => a.key));
        const join = [...now].filter((k) => !was.has(k)).length;
        const leave = [...was].filter((k) => !now.has(k)).length;
        const lose = voidAssignments(before.assignments, after.byKey, after.index, ctx.leads).length;
        lines.push(`+${join} join, −${leave} leave${lose ? `; ${plural(lose, "account")} lose${lose === 1 ? "s" : ""} its assignee (no access any more)` : ""}.`);
      } else {
        const lose = voidAssignments(before.assignments, after.byKey, after.index, ctx.leads).length;
        if (lose) lines.push(`${plural(lose, "account")} would lose ${lose === 1 ? "its" : "their"} assignee (no access any more).`);
      }
      const pinned = matched.filter((a) => pins[a.key]).length;
      if (pinned) lines.push(`${pinned} assigned account${pinned === 1 ? " is" : "s are"} held in ${pinned === 1 ? "its" : "their"} old groups until you decide in Decisions.`);
    }
    preview.replaceChildren(...lines.map((t) => el("p", "team-preview-line", t)));
    if (matched.length) {
      const ul = el("ul", "team-preview-list");
      for (const a of matched.slice(0, PREVIEW_LISTED)) ul.append(el("li", "", `${a.name}${before.assignments[a.key] ? ` - ${ctx.names[before.assignments[a.key]] || "assigned"}` : ""}`));
      if (matched.length > PREVIEW_LISTED) ul.append(el("li", "field-hint", `… and ${matched.length - PREVIEW_LISTED} more`));
      preview.append(ul);
    }
  };

  const actions = el("div", "settings-buttons-row team-dialog-actions");
  if (existing && kind === "filter") {
    const copy = el("button", "secondary", "Copy its current accounts into a new named group…");
    copy.type = "button";
    copy.title = "The kind of a group is fixed once saved. This starts a new named list with the accounts this filter matches now.";
    copy.addEventListener("click", () => {
      const keys = accounts.filter((a) => (before.byKey[a.key] || []).includes(id)).map((a) => a.key);
      done();
      openEditor(null, { copyFrom: { name: `${existing.name} (list)`, description: existing.description || "", kind: "named", accounts: keys, members: existing.members || [] } });
    });
    actions.append(copy);
  }
  const cancel = el("button", "", "Cancel");
  const save = el("button", "team-primary-btn", "Save");
  cancel.type = save.type = "button";
  actions.append(cancel, save);
  dlg.append(actions);

  const done = () => { clearTimeout(timer); dlg.close(); dlg.remove(); };
  cancel.addEventListener("click", done);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(); });
  save.addEventListener("click", async () => {
    const g = draft();
    const why = groupProblem(g);
    if (why) { problem.textContent = why; return; }
    const firstGroup = !before.index.on;
    const now = new Date().toISOString();
    save.disabled = true;
    try {
      await writeGroups((all) => { all[id] = { ...g, createdAt: existing?.createdAt || now, updatedAt: now }; });
    } catch (err) {
      problem.textContent = `Not saved: ${err.message}`;
      save.disabled = false;
      return;
    }
    done();
    await renderTeamGroups(ctx, { force: true });
    if (firstGroup) {
      // R9.2 / D9: nothing is written for the members in no group - they simply count in Other.
      const index = groupIndex({ ...groups, [id]: g }, ctx.team);
      const inOther = (index.members[OTHER_GROUP] || []).filter((m) => m !== ctx.leads.lead && m !== ctx.leads.deputy);
      await askConfirm(
        "Advanced mode is on. Members see only their groups' accounts; you see all of them." +
        (inOther.length ? `\n\n${namesOf(inOther, ctx).join(", ")} ${inOther.length === 1 ? "is" : "are"} in Other until you add them to a group.` : ""),
        { okLabel: "OK", cancelLabel: "Close" });
    }
  });

  document.body.append(dlg);
  showKind();
  dlg.showModal();
  nameIn.focus();
  paintPreview();
}

// Delete… (R2.8): the row is marked deleted, never removed (a late change from an older PC then cannot revive it).
async function deleteGroup(groupId) {
  const ctx = lastCtx;
  if (!ctx?.canEdit) return;
  const { groups, pins, summary } = await loadGroupInputs();
  const g = groups[groupId];
  if (!g) return;
  const accounts = await loadAccounts();
  const before = buildModel(groups, pins, summary, accounts, ctx);
  const after = buildModel({ ...groups, [groupId]: { ...g, deleted: true } }, pins, summary, accounts, ctx);
  const inIt = accounts.filter((a) => (before.byKey[a.key] || []).includes(groupId));
  const toOther = inIt.filter((a) => (after.byKey[a.key] || []).join() === OTHER_GROUP).length;
  const movers = (before.index.members[groupId] || []).filter((m) => (before.index.ofMember[m] || []).filter((x) => x !== groupId && x !== OTHER_GROUP).length === 0);
  const lose = voidAssignments(before.assignments, after.byKey, after.index, ctx.leads).length;
  const lastOne = before.index.live.length === 1;
  const text = `Delete the group "${g.name}"?\n\n` +
    `${g.name} has ${plural(inIt.length, "account")}: ${inIt.length - toOther} stay in their other groups, ${toOther} go to Other.` +
    (movers.length ? ` Members of ${g.name} who are in no other group move to Other: ${namesOf(movers, ctx).join(", ")}.` : "") +
    (lose ? `\n\n${plural(lose, "account")} lose${lose === 1 ? "s" : ""} ${lose === 1 ? "its" : "their"} assignee (no access any more).` : "") +
    (lastOne ? "\n\nIt is the last group: the team is back to everyone seeing every account." : "");
  if (!(await askConfirm(text, { okLabel: "Delete the group", cancelLabel: "Cancel", danger: true }))) return;
  await writeGroups((all) => { if (all[groupId]) all[groupId] = { ...all[groupId], deleted: true, updatedAt: new Date().toISOString() }; });
  await renderTeamGroups(ctx, { force: true });
}

// ---------------------------------------------------------------------------------------------------
// The members table's ⋮ > Groups… (10.1): the other way to edit membership
// ---------------------------------------------------------------------------------------------------

export async function editMemberGroups(member, ctx) {
  if (!ctx?.canEdit) return;
  const { groups } = await loadGroupInputs();
  const index = groupIndex(groups, ctx.team);
  const name = namesOf([member], ctx)[0];
  const own = new Set((index.live || []).filter((g) => (g.members || []).includes(member)).map((g) => g.id));
  const explicitOther = (groups[OTHER_GROUP]?.members || []).includes(member);
  if (explicitOther) own.add(OTHER_GROUP);

  const dlg = el("dialog", "team-group-dialog team-group-dialog-small");
  dlg.append(el("h3", "", `Groups of ${name}`));
  if (!index.live.length) dlg.append(el("p", "field-hint", "There are no groups yet - create one with + New group first."));
  const ticks = [];
  const list = el("div", "team-members-ticks");
  const sorted = [...index.live].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  for (const g of [...sorted, { id: OTHER_GROUP, name: "Other", kind: "other" }]) {
    if (g.id === OTHER_GROUP && !index.live.length) continue;
    const lab = el("label", "team-ms-item");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = g.id;
    cb.checked = own.has(g.id);
    ticks.push(cb);
    lab.append(cb, document.createTextNode(` ${g.name}`), el("span", "field-hint", ` - ${g.id === OTHER_GROUP ? "everything in no group" : describeGroup(g)}`));
    list.append(lab);
  }
  dlg.append(list, el("p", "field-hint", `${name} ticked in no group is in Other.${member === ctx.leads.lead ? " As Team Lead they see every account anyway." : ""}`));
  const actions = el("div", "settings-buttons-row team-dialog-actions");
  const cancel = el("button", "", "Cancel");
  const save = el("button", "team-primary-btn", "Save");
  cancel.type = save.type = "button";
  actions.append(cancel, save);
  dlg.append(actions);
  const done = () => { dlg.close(); dlg.remove(); };
  cancel.addEventListener("click", done);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(); });
  save.addEventListener("click", async () => {
    const want = new Set(ticks.filter((t) => t.checked).map((t) => t.value));
    const now = new Date().toISOString();
    save.disabled = true;
    await writeGroups((all) => {
      for (const g of index.live) {
        const row = all[g.id];
        if (!row) continue;
        const has = (row.members || []).includes(member);
        if (has === want.has(g.id)) continue;
        all[g.id] = { ...row, members: has ? row.members.filter((m) => m !== member) : [...(row.members || []), member], updatedAt: now };
      }
      const other = all[OTHER_GROUP] || { members: [] };
      const inOther = (other.members || []).includes(member);
      if (inOther !== want.has(OTHER_GROUP)) {
        all[OTHER_GROUP] = { ...other, members: inOther ? other.members.filter((m) => m !== member) : [...(other.members || []), member] };
      }
    });
    done();
    await renderTeamGroups(ctx, { force: true });
  });
  document.body.append(dlg);
  dlg.showModal();
}
