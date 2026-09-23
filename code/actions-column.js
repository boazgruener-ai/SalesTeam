// Shared "sticky last column" builder for the row-level kebab (⋮) menu used
// by target-accounts.js (Companies + Contacts tables) and dashboard.js
// (Posts table). Extracted 2026-09-19 after the same structural shape
// (colgroup width, a bare/unlabeled header, the kebab button's own look)
// was hand-copied 3 times across those 2 files and kept drifting apart in
// small ways round after round (a stray "Actions" label, an extra resize
// handle, a mismatched width, a background color that didn't match the
// rest of the header row) - reported directly, repeatedly: "why can't you
// simply re-use the code that displays the Kebabs in the Target and
// Contacts Dashboard, instead of keep trying to find workarounds for only
// the Posts screen that never work." This is now the ONLY place that
// decides the actions column's structure - a table's own kebab MENU ITEMS
// stay page-specific (passed in via openMenu, since the real actions
// differ per table), but the column itself can't drift again.
//
// Each table's own CSS still separately defines the ACTIONS_COLUMN_CLASS
// selector's look (sticky position/background/box-shadow, per this
// codebase's existing per-file CSS convention) - only the JS that builds
// the DOM moved here.

export const ACTIONS_COLUMN_WIDTH = 40;
export const ACTIONS_COLUMN_CLASS = "actions-col";

export function appendActionsCol(colgroupEl) {
  const col = document.createElement("col");
  col.style.width = `${ACTIONS_COLUMN_WIDTH}px`;
  colgroupEl.appendChild(col);
}

export function appendActionsTh(rowEl) {
  const th = document.createElement("th");
  th.className = ACTIONS_COLUMN_CLASS;
  rowEl.appendChild(th);
}

// openMenu(kebabBtn, event) - page-specific: builds its own menu items and
// calls its own popup-opening function with them.
export function appendActionsTd(rowEl, openMenu) {
  const td = document.createElement("td");
  td.className = ACTIONS_COLUMN_CLASS;
  td.style.textAlign = "center";
  const kebabBtn = document.createElement("button");
  kebabBtn.type = "button";
  kebabBtn.className = "kebab-btn";
  kebabBtn.title = "Actions";
  kebabBtn.textContent = "⋮";
  kebabBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(kebabBtn, event);
  });
  td.appendChild(kebabBtn);
  rowEl.appendChild(td);
}
