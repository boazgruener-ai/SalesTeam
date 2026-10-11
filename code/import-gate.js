// 1.2.3 Export & Import, build step 1 (EXPORT_IMPORT_DESIGN.md 6, R5): in a team only the Team Lead (and deputy)
// imports and restores. For a member those menu items are not shown at all - no greyed-out buttons. Re-checked
// whenever the team membership or the Team Lead changes; storage.js refuses again on write.

import { mayImport } from "./storage.js";

// The left-menu item every page has (Leads Dashboard, Scanner, Settings). Since build step 2 there is one Import…
// for every format, and Restore lives only in Settings > Restore (D9). The Target Contacts group has the same Import…
// (Boaz, 1.2.2.13: Export was in both groups, Import only in one), starting on Contacts.
export const IMPORT_MENU_IDS = ["nav-import-btn", "nav-import-contacts-btn"];

export function hideImportForMembers(ids = IMPORT_MENU_IDS) {
  const apply = async () => {
    const allowed = await mayImport();
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = allowed ? "" : "none";
    }
  };
  apply();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.teamMembership || changes.teamAccountStates)) apply();
  });
}
