// The Notes section (1.2.4, NOTES_DESIGN.md section 6): one component for the account page, the contact page and
// the lead detail - the same list, the same box, the same ⋮ menu. It brings its own styles (notes.css) and its own
// menu, so it does not depend on the page it sits in. The rules are in notes.js, the writers in storage.js.
//
//   const notes = notesSection(document.getElementById("account-notes"));
//   notes.show({ on: "account", key: companyKey, name: "Belimed" });   // again on every render: the draft is kept
//   name: what the Activity Log calls the subject ("Note added on Belimed"); accountKey: a lead's account, if any
//   notes.show({ on: "account", key, select: (all) => accountTimeline(all, key, leadKeys) });   // step 2: the timeline
//   notes.hide();
//
// Design 5.1: the section stays OUTSIDE the parts of the page a colleague's edit blocks, and an unsaved note is marked
// data-unsaved-note - a mark of its own. The page's "leave this page?" warning looks for it (notesUnsaved); the edit
// hold looks only for data-unsaved, so typing a note never takes the account.

import { getNotes, addNote, editNote, deleteNote, appendActivityLog } from "./storage.js";
import { notesOn, noteDate, noteLine, mayEditNote, mayDeleteNote, contactAccountKey, NOTE_MAX_CHARS } from "./notes.js";
import { leadRightsOf } from "./team-groups.js";
import { askConfirm } from "./confirm-dialog.js";

const sections = new WeakMap(); // container element -> its controller
const live = new Set();         // controllers currently shown, refreshed when notes or the team change
// A note typed for one account and not saved is kept while another account is looked at, and is back in the box when
// the first one is opened again (until the page is closed, which asks first): "<on>|<key>" -> { text, id, was }.
const drafts = new Map();
let openMenu = null;

function closeMenuOnOutside(event) {
  if (openMenu && !openMenu.contains(event.target)) closeMenu();
}
function closeMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener("click", closeMenuOnOutside, true);
  document.removeEventListener("keydown", closeMenuOnEscape, true);
  window.removeEventListener("scroll", closeMenu, true);
}
function closeMenuOnEscape(event) {
  if (event.key === "Escape") closeMenu();
}
function showMenu(anchorEl, items) {
  closeMenu();
  const popup = document.createElement("div");
  popup.className = "note-menu";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `note-menu-item${item.danger ? " danger" : ""}`;
    btn.textContent = item.label;
    btn.addEventListener("click", () => { closeMenu(); item.onClick(); });
    popup.appendChild(btn);
  }
  document.body.appendChild(popup);
  const rect = anchorEl.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8))}px`;
  popup.style.top = `${Math.min(rect.bottom + 2, window.innerHeight - popup.offsetHeight - 8)}px`;
  openMenu = popup;
  setTimeout(() => {
    if (openMenu !== popup) return;
    document.addEventListener("click", closeMenuOnOutside, true);
    document.addEventListener("keydown", closeMenuOnEscape, true);
    window.addEventListener("scroll", closeMenu, true);
  }, 0);
}

const count = (n) => n.toLocaleString("en-US");
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function build(container) {
  container.classList.add("notes-section");
  container.textContent = "";
  const title = el("h3", "notes-title", "Notes");
  const box = el("textarea", "notes-box");
  box.rows = 2;
  box.maxLength = NOTE_MAX_CHARS;
  box.placeholder = "Write a note…";
  const actions = el("div", "notes-actions");
  const saveBtn = el("button", "notes-save-btn", "Add note");
  saveBtn.type = "button";
  const cancelBtn = el("button", "notes-cancel-btn", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.hidden = true;
  const problem = el("span", "notes-problem");
  const counter = el("span", "notes-counter");
  actions.append(saveBtn, cancelBtn, problem, counter);
  const list = el("div", "notes-list");
  container.append(title, box, actions, list);

  let subject = null;   // { on, key, select, name, accountKey }
  let editingId = null; // the note being edited (its text is in the box), else null
  let editingText = "";
  let saving = false;
  let turn = 0;
  let shownNotes = [];  // the list as last drawn: the Activity Log line of an edit needs the note it was
  const expanded = new Set(); // ids of notes opened in full

  function paintBox() {
    const text = box.value;
    const empty = !text.trim();
    const unchanged = editingId !== null && text.trim() === editingText;
    saveBtn.textContent = saving ? "Saving…" : editingId ? "Save note" : "Add note";
    saveBtn.disabled = saving || empty || unchanged;
    cancelBtn.hidden = editingId === null;
    cancelBtn.disabled = saving;
    box.disabled = saving;
    counter.textContent = `${count(text.length)} / ${count(NOTE_MAX_CHARS)}`;
    if (!empty && !unchanged) container.dataset.unsavedNote = "1";
    else delete container.dataset.unsavedNote;
  }

  function resetBox() {
    editingId = null;
    editingText = "";
    box.value = "";
    problem.textContent = "";
    paintBox();
  }

  // R8: "Note added on Belimed" in the Activity Log, without the note's text. A contact's or a lead's note changed
  // from the account's timeline names both: "Note edited on Anna Muster (Belimed)".
  function logNote(done, note) {
    if (!subject) return;
    const own = note.on === subject.on && note.key === subject.key;
    const name = subject.name || "this " + subject.on;
    const companyKey = note.on === "account" ? note.key : note.on === "contact" ? contactAccountKey(note.key) : subject.accountKey || (subject.on === "account" ? subject.key : null);
    appendActivityLog({
      actor: "user", action: `note_${done}`,
      label: `Note ${done} on ${own ? name : `${note.about || `a ${note.on}`} (${name})`}`,
      ...(companyKey ? { relatedCompanyKey: companyKey } : {}),
      ...(note.on === "contact" ? { relatedContactKey: note.key } : {}),
    }).catch(() => {});
  }

  function noteRow(note, team) {
    const row = el("div", "note-row");
    const text = el("div", `note-text${expanded.has(note.id) ? " expanded" : ""}`);
    const date = el("span", "note-date", noteDate(note.at));
    date.title = new Date(note.at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      + (note.editedAt ? ` - edited ${new Date(note.editedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "");
    // The rest of the line exactly as notes.js writes it (R1.5), after the date.
    text.append(date, noteLine(note, team.inTeam).slice(noteDate(note.at).length));
    text.title = "Click to show the whole note";
    text.addEventListener("click", () => {
      if (window.getSelection()?.toString()) return; // selecting text to copy is not a click
      if (expanded.has(note.id)) expanded.delete(note.id);
      else expanded.add(note.id);
      text.classList.toggle("expanded", expanded.has(note.id));
    });
    row.appendChild(text);
    const items = [];
    if (mayEditNote(note, team.me)) {
      items.push({ label: "Edit…", onClick: () => {
        editingId = note.id;
        editingText = note.text;
        box.value = note.text;
        problem.textContent = "";
        paintBox();
        box.focus();
      } });
    }
    if (mayDeleteNote(note, team.me, team.leadRights)) {
      items.push({ label: "Delete…", danger: true, onClick: async () => {
        const ok = await askConfirm(team.inTeam ? "Delete this note? It is deleted for the whole team." : "Delete this note?",
          { okLabel: "Delete note", cancelLabel: "Keep it", danger: true });
        if (!ok) return;
        const r = await deleteNote(note.id);
        if (!r.ok) problem.textContent = "Only the note's author or the Team Lead can delete it.";
        else logNote("deleted", note);
        if (editingId === note.id) resetBox();
        await refresh();
      } });
    }
    if (items.length) {
      const menuBtn = el("button", "note-menu-btn", "⋮");
      menuBtn.type = "button";
      menuBtn.title = "Actions";
      menuBtn.addEventListener("click", (event) => { event.stopPropagation(); showMenu(menuBtn, items); });
      row.appendChild(menuBtn);
    }
    return row;
  }

  async function refresh() {
    if (!subject) return;
    const mine = ++turn; // two refreshes can overlap (my own save and the storage change it causes): the latest draws
    const [all, got] = await Promise.all([getNotes(), chrome.storage.local.get(["teamMembership", "teamAccountStates"])]);
    if (mine !== turn || !subject) return;
    const m = got.teamMembership || null;
    const team = { inTeam: Boolean(m), me: m?.memberId || null, leadRights: leadRightsOf(m, got.teamAccountStates) };
    const shown = subject.select ? subject.select(all) : notesOn(all, subject.on, subject.key);
    shownNotes = shown;
    title.textContent = `Notes (${shown.length})`;
    // A note being edited that a colleague deleted meanwhile: its text stays in the box, as a new note.
    if (editingId !== null && !shown.some((n) => n.id === editingId)) { editingId = null; editingText = ""; paintBox(); }
    const top = list.scrollTop;
    list.textContent = "";
    if (!shown.length) list.appendChild(el("div", "notes-empty", "No notes yet."));
    for (const note of shown) list.appendChild(noteRow(note, team));
    list.scrollTop = top;
  }

  async function save() {
    if (saving || !subject || !box.value.trim()) return;
    saving = true;
    problem.textContent = "";
    paintBox();
    try {
      const edited = editingId ? shownNotes.find((n) => n.id === editingId) : null;
      const r = editingId ? await editNote(editingId, box.value) : await addNote(subject.on, subject.key, box.value);
      saving = false;
      if (r.ok) {
        logNote(edited ? "edited" : "added", edited || { on: subject.on, key: subject.key });
        resetBox();
      }
      else {
        problem.textContent = r.reason === "not-yours" ? "Only the note's author can change it." : r.reason === "missing" ? "This note was deleted meanwhile. Press Add note to keep your text as a new note." : "Not saved.";
        if (r.reason === "missing") { editingId = null; editingText = ""; }
        paintBox();
      }
    } catch (err) {
      saving = false;
      problem.textContent = `Not saved: ${err?.message || err}`;
      paintBox();
    }
    await refresh();
    if (!editingId) list.scrollTop = 0; // the new note is the first one
  }

  const draftKey = () => (subject ? `${subject.on}|${subject.key}` : null);
  function stashDraft() {
    const k = draftKey();
    if (!k) return;
    if (container.dataset.unsavedNote) drafts.set(k, { text: box.value, id: editingId, was: editingText });
    else drafts.delete(k);
  }
  function takeDraft() {
    const d = drafts.get(draftKey());
    resetBox();
    if (!d) return;
    drafts.delete(draftKey());
    box.value = d.text;
    editingId = d.id;
    editingText = d.was;
    paintBox();
  }

  box.addEventListener("input", () => { problem.textContent = ""; paintBox(); });
  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", resetBox);
  paintBox();

  const controller = {
    refresh,
    async show({ on, key, select = null, name = "", accountKey = null }) {
      const same = subject && subject.on === on && subject.key === key;
      if (!same) stashDraft();
      subject = { on, key, select, name, accountKey };
      if (!same) { expanded.clear(); takeDraft(); list.scrollTop = 0; }
      container.hidden = false;
      live.add(controller);
      await refresh();
    },
    hide() {
      stashDraft();
      subject = null;
      turn += 1;
      live.delete(controller);
      container.hidden = true;
      expanded.clear();
      resetBox();
      list.textContent = "";
    },
  };
  return controller;
}

export function notesSection(container) {
  let controller = sections.get(container);
  if (!controller) {
    controller = build(container);
    sections.set(container, controller);
  }
  return controller;
}

// For the page's "leave this page?" warning: a note typed and not saved, in a section that is on screen.
export function notesUnsaved(root = document) {
  return drafts.size > 0 || [...root.querySelectorAll("[data-unsaved-note]")].some((node) => node.isConnected && !node.closest("[hidden]"));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.notes || changes.teamMembership || changes.teamAccountStates)) return;
  for (const controller of live) controller.refresh();
});
