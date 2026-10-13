// Notes on accounts, contacts and leads (1.2.4, NOTES_DESIGN.md section 3.2). PURE - no storage, no screen code:
// every rule about a note lives here, so it runs in test_pure_modules.py.
//
// The stored list (storage.js getNotes) is one object keyed by the note's id:
//   { on: "account" | "contact" | "lead", key, text, at, by, byName, editedAt, deletedAt, deletedBy }
// key = the account key (normalised company name), the contact key ("<account key>::<name>") or the lead key (the
// post's or job ad's web address). by / byName are null without a team.
// The functions that return notes return them as { id, ...note }, newest first.

export const NOTE_MAX_CHARS = 2000;
export const NOTE_PROMPT_MAX = 10;        // D7: the AI is given the latest ten ...
export const NOTE_PROMPT_CHARS = 500;     // ... each cut at 500 characters
export const NOTE_SUBJECTS = ["account", "contact", "lead"];

const NOTE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const noteTwo = (n) => String(n).padStart(2, "0");
const noteOneLine = (text) => String(text || "").replace(/\s+/g, " ").trim();
const noteCut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const newestNoteFirst = (a, b) => (b.at || 0) - (a.at || 0) || String(a.id).localeCompare(String(b.id));

// What the user typed, as it is stored: line ends made the same, no blank space around it, at most 2,000 characters.
export function noteText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim().slice(0, NOTE_MAX_CHARS).trim();
}

// A new note, or null when there is nothing to keep (no text, no subject). author: { memberId, name } in a team.
export function noteEntry(on, key, text, author, now) {
  const clean = noteText(text);
  if (!NOTE_SUBJECTS.includes(on) || !key || !clean) return null;
  return {
    on, key: String(key), text: clean, at: now,
    by: author?.memberId || null, byName: author?.memberId ? author.name || null : null,
    editedAt: null, deletedAt: null, deletedBy: null,
  };
}

// R3.3: an edited note keeps its date and is marked as edited. Unchanged or empty text: the note as it was.
export function editedNote(note, text, now) {
  const clean = noteText(text);
  if (!note || !clean || clean === note.text) return note;
  return { ...note, text: clean, editedAt: now };
}

// Design 3.3 (D2): the entry stays, marked deleted and without its text - a removed entry could come back in a team
// when a colleague's later change arrives; a mark cannot.
export function deletedNote(note, by, now) {
  return { ...note, text: "", deletedAt: now, deletedBy: by || null };
}

export const isLiveNote = (note) => Boolean(note) && typeof note === "object" && !note.deletedAt && Boolean(note.text) && NOTE_SUBJECTS.includes(note.on) && Boolean(note.key);

export function liveNotes(notes) {
  const out = [];
  for (const [id, note] of Object.entries(notes || {})) if (isLiveNote(note)) out.push({ id, ...note });
  return out.sort(newestNoteFirst);
}

export function notesOn(notes, on, key) {
  return liveNotes(notes).filter((n) => n.on === on && n.key === key);
}

// The account part of a contact key ("acme ag::muster anna" -> "acme ag").
export function contactAccountKey(contactKey) {
  const i = String(contactKey || "").indexOf("::");
  return i > 0 ? contactKey.slice(0, i) : null;
}

// R2.3: the notes on the account, on its contacts (their key starts with the account key) and on the leads given
// (the page already knows which leads belong to the account - they are matched by company name when shown).
export function accountTimeline(notes, accountKey, leadKeys = []) {
  if (!accountKey) return [];
  const leads = new Set(leadKeys || []);
  return liveNotes(notes).filter((n) =>
    (n.on === "account" && n.key === accountKey)
    || (n.on === "contact" && contactAccountKey(n.key) === accountKey)
    || (n.on === "lead" && leads.has(n.key)));
}

// The indexes behind the Last note column: { key: latest note }.
// accountOfLead: { lead key: account key } for the leads whose company is an account (R5.3).
export function lastNoteByAccount(notes, accountOfLead = {}) {
  const out = {};
  for (const n of liveNotes(notes)) {
    const key = n.on === "account" ? n.key : n.on === "contact" ? contactAccountKey(n.key) : accountOfLead?.[n.key];
    if (key && !out[key]) out[key] = n; // newest first, so the first one seen is the latest
  }
  return out;
}

// For the search boxes (R5.5): the text of every note that belongs to a row, lower-cased - an account's row has its
// whole timeline. -> { account: Map key -> text, contact: Map, lead: Map }.
export function noteSearchText(notes, accountOfLead = {}) {
  const out = { account: new Map(), contact: new Map(), lead: new Map() };
  const add = (map, key, text) => { if (key) map.set(key, `${map.get(key) || ""}\n${String(text).toLowerCase()}`); };
  for (const n of liveNotes(notes)) {
    if (n.on === "account") add(out.account, n.key, n.text);
    else if (n.on === "contact") { add(out.contact, n.key, n.text); add(out.account, contactAccountKey(n.key), n.text); }
    else { add(out.lead, n.key, n.text); add(out.account, accountOfLead?.[n.key], n.text); }
  }
  return out;
}

function lastNoteOn(notes, on) {
  const out = {};
  for (const n of liveNotes(notes)) if (n.on === on && !out[n.key]) out[n.key] = n;
  return out;
}
export const lastNoteByContact = (notes) => lastNoteOn(notes, "contact");
export const lastNoteByLead = (notes) => lastNoteOn(notes, "lead");

// R3. `me` is this PC's member id, null without a team (then every note here is the user's own).
// A note without an author was written before its PC joined a team: in a team nobody edits it, and only the Team
// Lead or deputy deletes it (Boaz, 2026-10-13).
export function mayEditNote(note, me) {
  if (!isLiveNote(note)) return false;
  return !me || note.by === me;
}

// The author, and the Team Lead or deputy (leadRights).
export function mayDeleteNote(note, me, leadRights = false) {
  if (!isLiveNote(note)) return false;
  return !me || note.by === me || Boolean(leadRights);
}

// Merges (design 10). moves: [{ on: "account" | "contact" | "lead", from, to }]. An account move also moves the
// notes on that account's contacts, whose keys begin with the account key; a contact move listed as well wins.
// -> { notes, moved }: a new object (the one given is not changed) and how many notes got a new key.
export function rekeyNotes(notes, moves) {
  const exact = new Map();
  const accounts = new Map();
  for (const m of moves || []) {
    if (!m || !m.from || !m.to || m.from === m.to || !NOTE_SUBJECTS.includes(m.on)) continue;
    exact.set(`${m.on}|${m.from}`, m.to);
    if (m.on === "account") accounts.set(m.from, m.to);
  }
  const out = {};
  let moved = 0;
  for (const [id, note] of Object.entries(notes || {})) {
    let key = note && exact.get(`${note.on}|${note.key}`);
    if (!key && note && note.on === "contact") {
      const account = contactAccountKey(note.key);
      if (account && accounts.has(account)) key = `${accounts.get(account)}${note.key.slice(account.length)}`;
    }
    if (key) { out[id] = { ...note, key }; moved += 1; } else out[id] = note;
  }
  return { notes: out, moved };
}

// "Oct 13, 2026" / "2026-10-13", in the PC's own time zone.
export function noteDate(at) {
  const d = new Date(at);
  return `${NOTE_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
export function noteShortDate(at) {
  const d = new Date(at);
  return `${NOTE_MONTHS[d.getMonth()]} ${d.getDate()}`;
}
// What a note on a lead is about, for the account timeline (R2.3): "the post of Oct 3", "the job ad of Oct 3".
export function leadNoteAbout(lead) {
  const what = lead && (lead.type === "job" || lead.isJobAd) ? "job ad" : "post";
  const at = lead && (lead.postedAt || lead.firstSeenAt);
  return at ? `the ${what} of ${noteShortDate(at)}` : `a ${what}`;
}
// The account timeline with every contact and lead note marked with what it is about. contactNames: { contact key:
// name }; leads: the account's leads the viewer may see ({ key, type, postedAt, ... }).
export function accountTimelineMarked(notes, accountKey, contactNames = {}, leads = []) {
  const leadByKey = new Map((leads || []).filter((l) => l && l.key).map((l) => [l.key, l]));
  return accountTimeline(notes, accountKey, [...leadByKey.keys()]).map((n) => (
    n.on === "contact" ? { ...n, about: contactNames?.[n.key] || "a contact" }
      : n.on === "lead" ? { ...n, about: leadNoteAbout(leadByKey.get(n.key)) }
        : n));
}
export function noteIsoDate(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${noteTwo(d.getMonth() + 1)}-${noteTwo(d.getDate())}`;
}

// R1.5: "Oct 10, 2026 — Boaz: I messaged Anna Muster …"; without a team (or without an author) the name is left out.
// note.about (optional, set by the page for the account timeline): "Anna Muster", "the post of Oct 3".
export function noteLine(note, inTeam) {
  const who = inTeam && note.byName ? `${note.byName}${note.about ? ` · on ${note.about}` : ""}: ` : note.about ? `on ${note.about}: ` : "";
  return `${noteDate(note.at)}${note.editedAt ? " (edited)" : ""} — ${who}${note.text}`;
}

// One line per note for the AI prompt and the export files: "2026-10-13 Boaz (on Anna Muster): text".
function notePlainLine(note, maxChars) {
  const who = [note.byName || "", note.about ? `(on ${note.about})` : ""].filter(Boolean).join(" ");
  const text = noteOneLine(note.text);
  return `${noteIsoDate(note.at)}${who ? ` ${who}` : ""}: ${maxChars ? noteCut(text, maxChars) : text}`;
}

// Section 8. `list`: notes as the functions above return them (newest first). "" when there are none.
export function notesPromptBlock(list, max = NOTE_PROMPT_MAX) {
  const shown = (list || []).filter(isLiveNote).slice(0, max);
  if (!shown.length) return "";
  return ["Notes written by the sales team (newest first):", ...shown.map((n) => `- ${notePlainLine(n, NOTE_PROMPT_CHARS)}`)].join("\n");
}

// The notes on several subjects together, newest first, each marked with what it is about where the caller says so.
// subjects: [{ on, key, about? }] - an entry without a key is skipped. For the AI prompts (design 8): "on the lead,
// on its contact, on its account".
export function notesAbout(notes, subjects) {
  const about = new Map();
  for (const s of subjects || []) if (s && s.key && NOTE_SUBJECTS.includes(s.on)) about.set(`${s.on}|${s.key}`, s.about || null);
  const out = [];
  for (const n of liveNotes(notes)) {
    const k = `${n.on}|${n.key}`;
    if (about.has(k)) out.push(about.get(k) ? { ...n, about: about.get(k) } : n);
  }
  return out;
}

// What goes into an AI prompt: the block and one line on how to use it; "" when there are no notes, so a prompt for
// an account without notes is exactly what it was before.
export function notesPromptSection(list, max = NOTE_PROMPT_MAX) {
  const block = notesPromptBlock(list, max);
  if (!block) return "";
  return `\n${block}\nThese notes say what the salesperson or a colleague already did and learned. Take them into account: ` +
    "do not suggest or offer again what a note says was already done or sent, and do not contradict what a note says was agreed.\n";
}

// Section 9: every note of a row, whole, one per line.
export function notesExportLines(list) {
  return (list || []).filter(isLiveNote).map((n) => notePlainLine(n, 0));
}
