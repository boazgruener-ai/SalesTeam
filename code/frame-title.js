// 1.2.4.10 (Boaz: "make sure the title is not where the page was last in, but a relevant title for the page"): a page
// shown inside another one through the app menu (showEmbeddedPage in dashboard.js, scanner.js, settings.js,
// target-accounts.js) gives the browser tab its own title - "SalesTeam Scanner", not the Target Accounts Dashboard it
// was opened from - also when it changes its title later (a lead opened, a Settings page chosen). Closing it gives the
// tab back the host page's own title.

let savedTitle = null;
let observer = null;

export function mirrorFrameTitle(frameEl) {
  frameEl.addEventListener("load", () => {
    observer?.disconnect();
    observer = null;
    try {
      const doc = frameEl.contentDocument;
      if (!doc || doc.URL === "about:blank") return;
      if (savedTitle === null) savedTitle = document.title;
      const copy = () => { if (doc.title) document.title = doc.title; };
      copy();
      observer = new MutationObserver(copy);
      observer.observe(doc.head, { childList: true, characterData: true, subtree: true });
    } catch { /* not readable: keep the host's title */ }
  });
}

export function restoreOwnTitle() {
  observer?.disconnect();
  observer = null;
  if (savedTitle !== null) document.title = savedTitle;
  savedTitle = null;
}
