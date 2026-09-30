// The "Find new accounts" run's state key and its report text (web-discovery.js writes the state; the pages read
// it). Kept apart from web-discovery.js so a page can show the report without loading the background job.
import { DISCOVERY_DROP_REASONS } from "./discovery-filter.js";

export const WEB_DISCOVERY_STATE_KEY = "webDiscoveryState";

const LINKEDIN_EXCLUDED_LABELS = {
  excludedByAlreadyInWorkbook: "already an account", excludedByLocation: "headquarters outside your countries",
  excludedByBlocklist: "on your exclusion list", excludedByOrganizationType: "an organisation type you exclude",
  excludedByAliasDuplicate: "listed twice", skippedNoId: "no LinkedIn id",
};

// Build step 3's measurement, as text.
export function discoveryText(s) {
  const usd = (n) => `US$${(Number(n) || 0).toFixed(2)}`;
  const lines = [
    `${s.added || 0} new account${s.added === 1 ? "" : "s"} added (target ${s.target}, looked for ${s.wanted} with the margin)` +
      `${s.stoppedReason ? ` - stopped: ${s.stoppedReason}` : ""}.`,
  ];
  if (s.webSkipped) lines.push(`Web: not used - ${s.webSkipped}.`);
  else if (s.webWanted > 0) {
    const ok = (s.listings || []).filter((l) => !l.failed);
    const listingUsd = ok.reduce((a, l) => a + (l.costUsd || 0), 0);
    const finds = (s.calls || []).filter((c) => c.kind === "find" && !c.error);
    const fits = (s.calls || []).filter((c) => c.kind === "fit" && !c.error);
    const why = Object.entries(s.dropped || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${DISCOVERY_DROP_REASONS[k] || k}`).join(", ");
    lines.push(`Web: ${s.webAdded || 0} added of ${s.webWanted} looked for, about ${usd(s.spent)} in all. ` +
      `Listings: ${ok.length} read${ok.length ? `, about ${usd(listingUsd / ok.length)} each` : ""}; ${finds.length} search${finds.length === 1 ? "" : "es"} for listings, about ${usd(finds.reduce((a, c) => a + c.costUsd, 0))}` +
      `${fits.length ? `; fit search ${fits.length}x, about ${usd(fits.reduce((a, c) => a + c.costUsd, 0))}, ${s.fitRows} rows` : ""}. ` +
      `Rows read: ${s.rowsRead || 0}; kept after filtering: ${s.kept || 0}${why ? `; dropped: ${why}` : ""}.`);
  }
  const li = s.linkedin;
  if (li) {
    if (li.busy) lines.push("LinkedIn: not used - another LinkedIn job kept it busy.");
    else if (li.ran) {
      const why = Object.entries(li.excluded || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${LINKEDIN_EXCLUDED_LABELS[k] || k}`).join(", ");
      lines.push(`LinkedIn (local branches of international groups): ${li.added} added from ${li.pages} result page${li.pages === 1 ? "" : "s"}` +
        ` (${(li.bands || []).map((b) => `${b.label} ${b.found} of ${b.wanted}`).join(", ")})` +
        `${li.nameMatchesWaiting ? `; ${li.nameMatchesWaiting} match an account by name only and wait for your decision` : ""}` +
        `${why ? `; left out: ${why}` : ""}${li.touchLimit ? "; stopped at the daily LinkedIn limit" : ""}.`);
      if ((li.unscopedIndustries || []).length) lines.push(`LinkedIn could not filter these industries (no confirmed LinkedIn id): ${li.unscopedIndustries.join(", ")}.`);
    }
  }
  const names = [...(s.addedNames || []), ...((li && li.addedNames) || [])];
  if (names.length) lines.push(`Added: ${names.slice(0, 15).join(", ")}${names.length > 15 ? " …" : ""}`);
  if (s.lastError && !s.added) lines.push(`Last error: ${s.lastError}`);
  return lines.join("\n");
}
