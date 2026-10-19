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

// 1.2.4.25 (Boaz: F5 on an account page opened Settings → Data protection): a page shown inside another one has no
// address of its own in the browser, so a reload showed the host page again. When the host page is left while a page
// is shown in it, that page's address is kept for this tab (sessionStorage); if the same host address is loaded next -
// a reload - the kept page is opened instead, as a page of its own. Leaving to anywhere else forgets it.
const RELOAD_KEY = "salesteamEmbeddedOnReload";

// Only the page in the browser tab itself does this: an embedded page shares the tab's sessionStorage, and its own
// pagehide (which comes after the host's) would otherwise wipe what the host kept.
const isTopPage = () => { try { return window.top === window; } catch { return false; } };

export function rememberEmbeddedOnReload(frameEl, isShown) {
  if (!isTopPage()) return;
  window.addEventListener("pagehide", () => {
    try {
      const href = isShown() ? frameEl.contentWindow?.location?.href : null;
      if (href && !href.startsWith("about:")) sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ href, host: location.href }));
      else sessionStorage.removeItem(RELOAD_KEY);
    } catch { /* storage or frame not readable: a reload shows the host page, as before */ }
  });
}

// At the top of a host page. -> true when it is moving on to the kept page.
export function reopenEmbeddedAfterReload() {
  if (!isTopPage()) return false;
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return false;
    sessionStorage.removeItem(RELOAD_KEY);
    const { href, host } = JSON.parse(raw);
    if (host !== location.href) return false;
    const url = new URL(href);
    if (url.origin !== location.origin) return false;
    url.searchParams.delete("embedded");
    location.replace(url.href);
    return true;
  } catch {
    return false;
  }
}
