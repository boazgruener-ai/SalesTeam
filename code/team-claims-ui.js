// Team use 1.2.2, build step 4 (TEAM_USE_DESIGN.md 6.1-6.4, R3.3, R3.8): the account and contact pages' side of a
// claim. Not in a team: does nothing at all.
//
//   const guard = createClaimGuard({ viewEl, afterEl, regions })
//   guard.show(companyKey)  - the page shows this account (or a contact of it)
//   guard.hide()            - the page shows something else
//
// The first touch of an editable control claims the account (TEAM_CLAIM; renewed while the member keeps working).
// The notice under the title says what the team sees: a colleague updating it (changes blocked, reading open),
// "Checking with the team…", a lost claim with the changes kept aside (Apply / Discard), or not in sync (blocked).
// Blocking: the editable regions stop taking clicks and focus; links keep working, so reading is never blocked.

const MEMBERSHIP_KEY = "teamMembership"; // team-sync.js TEAM_MEMBERSHIP_KEY
const POLL_MS = 5000;
const CLAIM_AGAIN_MS = 30000; // the background renews at most once a minute anyway
const EDITABLE = "button, select, input, textarea, [contenteditable], [tabindex]";
const REFUSALS = {
  offline: "The team folder is not connected on this PC - see the top bar.",
  not_in_sync: "Not in sync with the team - see the top bar.",
  held: "A colleague is updating this account right now - try again when they are done.",
  assigned: "A colleague already has this account.",
  not_admin: "Only the Team Admin can release or reassign a colleague's account.",
};

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (r === undefined) throw new Error("no answer");
  return r;
}

function timeText(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

let membershipCache;
async function inTeam() {
  if (membershipCache === undefined) membershipCache = (await chrome.storage.local.get(MEMBERSHIP_KEY))[MEMBERSHIP_KEY] || null;
  return Boolean(membershipCache);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[MEMBERSHIP_KEY]) membershipCache = changes[MEMBERSHIP_KEY].newValue || null;
});

// regions: () => elements whose controls change the account (the overview, the actions menu, …).
export function createClaimGuard({ viewEl, afterEl, regions }) {
  let key = null;
  let status = null;
  let claimedAt = 0;
  let pollTimer = null;
  let busy = false;
  let refusal = ""; // why the last Assign / Release did not go through
  const notice = document.createElement("div");
  notice.className = "team-claim-notice";
  notice.hidden = true;
  afterEl.insertAdjacentElement("afterend", notice);

  // Step 5 (R6.2): a colleague's assigned account is blocked like one they are updating.
  const blocked = () => Boolean(status && status.member &&
    (status.state === "other" || status.state === "lost" || !status.inSync || (status.assignee && !status.assignee.me)));
  const inRegion = (el) => regions().some((r) => r && r.contains(el));

  function paintBlock() {
    const on = blocked();
    for (const r of regions()) if (r) r.classList.toggle("team-blocked", on);
  }

  function button(label, onClick, { disabled = false, secondary = false } = {}) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.disabled = disabled || busy;
    if (secondary) b.className = "secondary";
    b.addEventListener("click", onClick);
    return b;
  }

  function paint() {
    paintBlock();
    notice.innerHTML = "";
    notice.className = "team-claim-notice";
    const s = status;
    if (!s || !s.member) { notice.hidden = true; return; }
    const lines = [];
    let tone = null;
    if (!s.inSync) {
      tone = "blocked";
      lines.push(s.folder === "granted"
        ? "Not in sync with the team - changes to this account are blocked until the team folder works again (see the top bar). Reading stays open."
        : "The team folder is not connected on this PC - changes to this account are blocked until it is (see the top bar). Reading stays open.");
    } else if (s.assignee && !s.assignee.me) {
      tone = "blocked";
      lines.push(`Only ${s.assignee.name} can edit this account - you can still read it.`);
    } else if (s.state === "other" || s.state === "lost") {
      tone = "blocked";
      lines.push(`${s.holder?.name || "A colleague"} is updating this account (since ${timeText(s.holder?.since)}). You can read it; changes are possible again when ${s.holder?.name || "they"} ${s.holder?.name ? "is" : "are"} done.`);
    } else if (s.state === "checking") {
      tone = "checking";
      lines.push("Checking with the team… " + (s.held
        ? `Your ${s.held === 1 ? "change is" : "changes are"} saved on this PC and go to the team as soon as it is confirmed that nobody started on this account before you.`
        : "You can go ahead - your changes go to the team once it is confirmed that nobody started on this account before you."));
    }
    if (s.aside) {
      tone = tone === "blocked" ? "blocked" : "aside";
      const n = s.aside.changes;
      lines.push(`${s.aside.lostTo || "A colleague"} started on this account a few seconds before you - your ${n} change${n === 1 ? " was" : "s were"} kept aside (${timeText(s.aside.at)}), not sent to the team.`);
    }
    if (s.assignLost) {
      tone = tone || "aside";
      lines.push(s.assignLost.forMe
        ? `${s.assignLost.winner} assigned this account to themselves a few seconds before you - it is theirs.`
        : `${s.assignLost.winner} was assigned this account a few seconds before ${s.assignLost.to} - it stays with ${s.assignLost.winner}.`);
    }
    if (tone) notice.classList.add(`team-claim-${tone}`);
    notice.appendChild(assignmentRow(s));
    for (const text of lines) {
      const p = document.createElement("p");
      p.textContent = text;
      notice.appendChild(p);
    }
    if (s.aside) {
      const row = document.createElement("div");
      row.className = "team-claim-actions";
      const free = s.inSync && (s.state === "free" || s.state === "mine" || s.state === "checking");
      row.appendChild(button("Apply my changes now", () => act("TEAM_ASIDE_APPLY"), { disabled: !free }));
      row.appendChild(button("Discard them", () => act("TEAM_ASIDE_DISCARD"), { secondary: true }));
      if (!free) {
        const hint = document.createElement("span");
        hint.className = "field-hint";
        hint.textContent = "Possible once the account is free again.";
        row.appendChild(hint);
      }
      notice.appendChild(row);
    }
    notice.hidden = false;
  }

  async function act(type, extra = {}) {
    if (!key || busy) return;
    busy = true;
    refusal = "";
    paint();
    try {
      const r = await send({ type, key, ...extra });
      status = r;
      if (r && r.ok === false) refusal = REFUSALS[r.reason] || "That did not go through - try again in a moment.";
    } catch { refusal = "That did not go through - try again in a moment."; } finally { busy = false; }
    paint();
  }

  // Step 5 (design 7, R6.1, R6.4): "Assigned to Anna since 3 Oct" / "Unassigned", and what this member may do.
  function assignmentRow(s) {
    const row = document.createElement("div");
    row.className = "team-assign-row";
    const label = document.createElement("span");
    label.className = "team-assign-label";
    const a = s.assignee;
    if (!a) label.textContent = "Unassigned";
    else if (a.me) label.textContent = `Assigned to you since ${timeText(a.since)}`; // at once - a lost race is told below
    else label.textContent = `Assigned to ${a.name} since ${timeText(a.since)}`;
    row.appendChild(label);
    const usable = s.inSync;
    const colleagueBusy = s.state === "other" || s.state === "lost";
    if (!a) {
      row.appendChild(button("Assign to me", () => act("TEAM_ASSIGN"), { disabled: !usable || colleagueBusy }));
    } else if (a.me || s.admin) {
      row.appendChild(button(a.me ? "Release" : `Release (unassign ${a.name})`, () => act("TEAM_UNASSIGN"), { secondary: true, disabled: !usable }));
    }
    if (s.admin && Array.isArray(s.team) && s.team.length > 1) {
      const sel = document.createElement("select");
      sel.className = "team-reassign";
      sel.disabled = !usable || colleagueBusy || busy;
      const first = document.createElement("option");
      first.value = "";
      first.textContent = a ? "Reassign to…" : "Assign to…";
      sel.appendChild(first);
      for (const m of s.team) {
        if (a && m.id === a.id) continue;
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.id === s.team[0].id ? `${m.name} (you)` : m.name;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => { if (sel.value) act("TEAM_ASSIGN", { to: sel.value }); });
      row.appendChild(sel);
    }
    if (s.assignLost) row.appendChild(button("OK", () => act("TEAM_ASSIGN_DISMISS"), { secondary: true }));
    if (refusal) {
      const hint = document.createElement("span");
      hint.className = "field-hint";
      hint.textContent = refusal;
      row.appendChild(hint);
    }
    return row;
  }

  async function refresh() {
    if (!key) return;
    const forKey = key;
    try {
      const s = await send({ type: "TEAM_CLAIM_STATUS", key: forKey });
      if (forKey === key) { status = s; paint(); }
    } catch { /* the next poll tries again */ }
  }

  async function claim() {
    if (!key || Date.now() - claimedAt < CLAIM_AGAIN_MS) return;
    claimedAt = Date.now();
    const forKey = key;
    try {
      const s = await send({ type: "TEAM_CLAIM", key: forKey, kind: "edit" });
      if (forKey === key && s.member !== false) { status = s; paint(); }
    } catch { claimedAt = 0; }
  }

  function onTouch(event) {
    if (!key || !status || !status.member || !(event.target instanceof Element) || !inRegion(event.target)) return;
    if (event.target.closest("a[href]") && !event.target.closest(EDITABLE)) return; // following a link only reads
    if (blocked()) {
      // pointer-events are off in a blocked region (CSS); this catches the keyboard.
      if (event.type !== "pointerdown") {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "focusin" && event.target.blur) event.target.blur();
      }
      return;
    }
    claim();
  }
  for (const type of ["pointerdown", "keydown", "focusin"]) viewEl.addEventListener(type, onTouch, true);

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function release(oldKey) {
    if (oldKey && claimedAt) send({ type: "TEAM_RELEASE", key: oldKey }).catch(() => {});
    claimedAt = 0;
  }

  window.addEventListener("pagehide", () => release(key));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });

  return {
    async show(companyKey) {
      if (companyKey !== key) {
        release(key);
        status = null;
        paint();
      }
      key = companyKey || null;
      if (!key || !(await inTeam())) { stopPolling(); key = null; status = null; paint(); return; }
      await refresh();
      if (!pollTimer) pollTimer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
    },
    hide() {
      release(key);
      key = null;
      status = null;
      stopPolling();
      paint();
    },
  };
}
