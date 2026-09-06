// Runs on an individual LinkedIn profile page (linkedin.com/in/*), scraping
// just the person's current employer - the one piece of company data a
// search-results-feed headline often doesn't carry (see PRD 6.3/Dashboard
// "Extract Companies from Profiles"). Only ever active during an explicit,
// user-triggered extraction run (dashboard.js sets profileExtractionActive
// before navigating here) - this deliberately does nothing during normal
// browsing, so visiting a LinkedIn profile is never silently scraped.
//
// NOTE ON SELECTORS (unverified against a live profile at write time - see
// PRD 6.3): same durable-marker philosophy as content-script.js (hashed
// class names aren't stable hooks), but this file's exact selectors
// couldn't be checked against a real, logged-in LinkedIn session while
// building this. If it comes back empty/wrong on a real profile, that's the
// expected first thing to debug - inspect a live profile page and update
// the extractors below, the same maintenance path content-script.js already
// documents for itself.
//
// Approach: LinkedIn's profile sections carry a stable `id` attribute (used
// for its own in-page deep-linking, e.g. a URL ending in "#experience") -
// this looks for id="experience" as the anchor, then the first link to a
// Company Page (an <a href> containing "/company/") within it, since
// experience entries are listed most-recent-first and a link to a real
// Company Page is a durable, semantic marker regardless of surrounding
// class names. Falls back to the same kind of link anywhere in the page's
// top card (near the name/headline) if the Experience section isn't found
// or has no such link. Never guesses - returns null rather than a wrong name
// if neither is found.

function companyNameFromLink(anchor) {
  if (!anchor) return null;
  const text = anchor.textContent.replace(/\s+/g, " ").trim();
  return text || null;
}

function findExperienceSection() {
  return document.getElementById("experience") || document.querySelector('[id*="experience" i]');
}

function extractCurrentCompany() {
  const experience = findExperienceSection();
  if (experience) {
    // Search within the broader section container, not just the anchored
    // element itself - the id is often on a small marker just before the
    // actual list of entries.
    const container = experience.closest("section") || experience.parentElement || experience;
    const companyLink = container.querySelector('a[href*="/company/"]');
    const company = companyNameFromLink(companyLink);
    if (company) return company;
  }

  // Fallback: a company-page link near the top of the page (top card) -
  // some profiles show the current employer there directly.
  const topCard = document.querySelector("main") || document.body;
  const topCandidates = Array.from(topCard.querySelectorAll('a[href*="/company/"]')).slice(0, 3);
  for (const anchor of topCandidates) {
    const company = companyNameFromLink(anchor);
    if (company) return company;
  }

  return null;
}

async function run() {
  const { profileExtractionActive } = await chrome.storage.local.get("profileExtractionActive");
  if (!profileExtractionActive) return; // Not part of an active, user-triggered run; do nothing.

  const company = extractCurrentCompany();
  console.log(`[SalesTeam] profile scrape at ${location.href}: company=`, company);

  chrome.runtime.sendMessage({
    type: "PROFILE_SCRAPE_RESULT",
    profileUrl: location.href.split("?")[0],
    company,
  });
}

run();
