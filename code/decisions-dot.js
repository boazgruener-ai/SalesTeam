// The red dot on the Decisions menu item (1.2 build step 4, R12.4.1). The user does not have to remember
// to look: while the decision queue holds anything, the dot says so, on every page that draws the menu.
//
// The queue is built from the data (V1), so the dot is recounted whenever data it is built from changes -
// only those keys, debounced, since a pipeline run writes several of them per account.
import { getDecisionQueue } from "./storage.js";

const WATCHED_KEYS = new Set([
  "targetAccountExtras", "targetAccounts", "targetAccountsWorkbook", "discoveredCompanies", "discoveredContacts",
  "companyExclusions", "keptSeparateAccountPairs", "discoveryNameDecisions", "targetContactExtras",
]);
const DEBOUNCE_MS = 5000; // a pipeline or research run writes every few seconds; the dot need not follow each one
const FIRST_COUNT_DELAY_MS = 2500; // after the page has drawn its own content (1.2.0.2 load-time work)

let styleAdded = false;

function ensureStyle() {
  if (styleAdded) return;
  styleAdded = true;
  const style = document.createElement("style");
  style.textContent = `
    .decisions-dot { display: inline-block; min-width: 8px; height: 8px; margin-left: 8px; border-radius: 50%;
      background: #d93025; vertical-align: middle; }
    .decisions-dot[hidden] { display: none; }
  `;
  document.head.appendChild(style);
}

// Adds the dot to the button and keeps it current. onCount (optional) receives each new count.
export function initDecisionsDot(buttonId = "open-decisions-btn", onCount = null) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  ensureStyle();
  const dot = document.createElement("span");
  dot.className = "decisions-dot";
  dot.hidden = true;
  btn.appendChild(dot);

  let timer = null;
  const refresh = async () => {
    try {
      const { count } = await getDecisionQueue();
      dot.hidden = count === 0;
      dot.title = `${count} decision${count === 1 ? "" : "s"} waiting`;
      btn.title = count > 0
        ? `${count} decision${count === 1 ? "" : "s"} only you can make`
        : "Nothing waiting for a decision";
      if (onCount) onCount(count);
    } catch { /* a page with no workbook yet simply shows no dot */ }
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(changes).some((k) => WATCHED_KEYS.has(k))) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, DEBOUNCE_MS);
  });
  setTimeout(refresh, FIRST_COUNT_DELAY_MS);
}
