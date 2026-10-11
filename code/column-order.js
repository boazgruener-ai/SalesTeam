// Column order by drag and drop (Boaz 2026-10-08): press on a column title, drag it left or right, let go - the whole
// column moves. Shared by Target Accounts (companies and contacts tables) and the Leads Dashboard, so the three tables
// behave the same. The order is remembered per table in localStorage (a per-PC display preference, like the hidden
// columns); each page's Columns menu offers "Reset column order".
//
//   orderedColumns(defs, key)                          - the columns in the saved order (new ones where defs has them)
//   makeColumnDraggable(th, column, defs, key, redraw) - wires one header cell
//   resetColumnOrder(key)                              - back to the order in defs

function savedColumnOrder(storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

// The saved order, with any column it does not know yet (a new release) placed after the column it follows in `defs`.
export function orderedColumns(defs, storageKey) {
  const known = new Set(defs.map((c) => c.id));
  const ids = savedColumnOrder(storageKey).filter((id) => known.has(id));
  defs.forEach((c, i) => {
    if (ids.includes(c.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = ids.indexOf(defs[j].id);
      if (k >= 0) { at = k + 1; break; }
    }
    ids.splice(at, 0, c.id);
  });
  const byId = new Map(defs.map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id));
}

function moveColumn(defs, storageKey, id, targetId, after) {
  const ids = orderedColumns(defs, storageKey).map((c) => c.id).filter((x) => x !== id);
  const at = ids.indexOf(targetId);
  if (at < 0) return;
  ids.splice(after ? at + 1 : at, 0, id);
  try { localStorage.setItem(storageKey, JSON.stringify(ids)); } catch { /* kept for this visit only */ }
}

export function resetColumnOrder(storageKey) {
  try { localStorage.removeItem(storageKey); } catch { /* nothing saved */ }
}

// A "Reset column order" item for a Columns panel (the popup's own close is passed in).
export function resetOrderItem(storageKey, close, redraw) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "col-menu-item";
  b.textContent = "Reset column order";
  b.title = "Put the columns back in their original order (hidden columns stay hidden)";
  b.addEventListener("click", () => { resetColumnOrder(storageKey); close(); redraw(); });
  return b;
}

let dragged = null; // { id, key } while a column title is being dragged

// noDragFrom: a selector inside the header cell that must not start a move (the Leads Dashboard's width handle).
export function makeColumnDraggable(th, column, defs, storageKey, redraw, { noDragFrom = null } = {}) {
  th.draggable = true;
  th.classList.add("th-draggable");
  let fromHandle = false;
  if (noDragFrom) th.addEventListener("mousedown", (e) => { fromHandle = Boolean(e.target.closest(noDragFrom)); });
  const clearMarks = () => th.classList.remove("th-drop-before", "th-drop-after");
  const dropAfter = (e) => {
    const r = th.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  };
  const accepts = () => dragged && dragged.key === storageKey && dragged.id !== column.id;
  th.addEventListener("dragstart", (e) => {
    if (fromHandle) { e.preventDefault(); return; }
    dragged = { id: column.id, key: storageKey };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", column.id);
    th.classList.add("th-dragging");
  });
  th.addEventListener("dragend", () => {
    dragged = null;
    th.classList.remove("th-dragging");
    document.querySelectorAll(".th-drop-before, .th-drop-after").forEach((x) => x.classList.remove("th-drop-before", "th-drop-after"));
  });
  th.addEventListener("dragover", (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const after = dropAfter(e);
    th.classList.toggle("th-drop-after", after);
    th.classList.toggle("th-drop-before", !after);
  });
  th.addEventListener("dragleave", clearMarks);
  th.addEventListener("drop", (e) => {
    if (!accepts()) return;
    e.preventDefault();
    clearMarks();
    moveColumn(defs, storageKey, dragged.id, column.id, dropAfter(e));
    dragged = null;
    redraw();
  });
}
