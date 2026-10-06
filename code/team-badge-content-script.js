// Team use 1.2.2, build step 6 (R6.5): a small badge on a LinkedIn company or profile page that belongs to one of
// the team's accounts - "UBS: assigned to Anna since 3 Oct". Reads only: it asks the background (team-badge.js) about
// the page's URL and shows the answer; it clicks nothing and reads nothing off the page. Does nothing outside a team.
// LinkedIn changes pages without a reload, so the URL is checked every 1.5 s (registered on all of linkedin.com).
(() => {
  if (window.__salesTeamBadge) return;
  window.__salesTeamBadge = true;
  const BADGE_ID = "salesteam-team-badge";
  const COLORS = { mine: "#188038", other: "#d93025", free: "#0b57d0" };
  // LinkedIn's own style sheets reached into the injected badge (live test 1.2.1.11: a colleague's red badge showed
  // grey, the close button did not show at all), so the badge lives in a shadow root - page CSS cannot reach inside.
  const STYLE = `
    :host { all: initial; }
    .box { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; max-width: 420px; display: flex;
      align-items: center; gap: 10px; padding: 8px 8px 8px 12px; border-radius: 8px; color: #fff;
      font: 600 13px/1.35 -apple-system, "Segoe UI", Arial, sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
    .hide { flex: none; border: 1px solid rgba(255,255,255,.8); background: rgba(255,255,255,.15); color: #fff;
      font: 600 12px/1 -apple-system, "Segoe UI", Arial, sans-serif; padding: 5px 8px; border-radius: 5px; cursor: pointer; }
    .hide:hover { background: rgba(255,255,255,.3); }`;
  let lastUrl = "";
  let dismissedFor = "";

  const relevant = (url) => /linkedin\.com\/(company|in)\/[^/?#]+/i.test(url);
  const pageOf = (url) => (/linkedin\.com\/((company|in)\/[^/?#]+)/i.exec(url) || [])[1] || "";

  function remove() {
    document.getElementById(BADGE_ID)?.remove();
  }

  function show(answer, page) {
    remove();
    if (!answer?.show || dismissedFor === page) return;
    const host = document.createElement("div");
    host.id = BADGE_ID;
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const box = document.createElement("div");
    box.className = "box";
    box.style.background = COLORS[answer.tone] || COLORS.free;
    const label = document.createElement("span");
    label.textContent = `SalesTeam - ${answer.text}`;
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "hide";
    hide.textContent = "Hide";
    hide.title = "Hide this badge on this page";
    hide.addEventListener("click", () => { dismissedFor = page; remove(); });
    box.append(label, hide);
    root.append(style, box);
    document.body.appendChild(host);
  }

  async function check() {
    const url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    if (!relevant(url)) { remove(); return; }
    const page = pageOf(url);
    try {
      const { teamMembership } = await chrome.storage.local.get("teamMembership");
      if (!teamMembership) { remove(); return; }
      const answer = await chrome.runtime.sendMessage({ type: "TEAM_LINKEDIN_BADGE", url });
      if (location.href === url) show(answer, page);
    } catch { /* the extension was reloaded - this page's script is orphaned */ }
  }

  // A change to an assignment shows at once on an open page.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.teamAccountStates || changes.teamMembership)) { lastUrl = ""; check(); }
    });
  } catch { /* orphaned */ }
  check();
  setInterval(check, 1500);
})();
